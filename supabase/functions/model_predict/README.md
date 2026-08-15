# `model_predict` — EdgeDesk multi-sport prediction engine

A prediction engine, not a betting-pick generator. It answers one question per
market — *what does the model believe the probability is?* — and stops there.
BET / WAIT / PASS belongs to EdgeDesk's research and decision layer, which is
downstream and stays downstream.

No LLM is involved in producing a probability. Every number here comes out of a
deterministic statistical process on data EdgeDesk already owns.

## Sports

| sport_key (prefix) | UI label | model version | markets | status today |
|---|---|---|---|---|
| `baseball_mlb` | MLB | `mlb_runs_v1.2_nbinom_dh` | h2h, totals | **live** — the frozen baseline |
| `tennis_atp*` | ATP | `atp_match_v1` | h2h | live if the `tennis` schema is exposed and populated |
| `tennis_wta*` | WTA | `wta_match_v1` | h2h | live if the `tennis` schema is exposed and populated |
| `mma_mixed_martial_arts` | MMA | `ufc_fight_v1` | h2h | live if the `ufc` schema is exposed and populated |
| `americanfootball_nfl*` | NFL | `nfl_game_v1` | h2h, spreads, totals | **insufficient_data** — needs `public.nfl_team_features` |
| `basketball_wnba` | WNBA | `wnba_game_v1` | h2h, spreads, totals | **insufficient_data** — needs `public.wnba_team_features` |

A sport that cannot produce a defensible probability writes **nothing** and
reports `model_status: insufficient_data` with the exact missing inputs. A gap
in the record is recoverable; a fabricated 57.3% in it is not.

## Modes

```
GET /functions/v1/model_predict?dry=1            run everything, write nothing
GET /functions/v1/model_predict                  live run, all sports
GET /functions/v1/model_predict?sport=tennis_atp one sport (key, captured key, or UI label)
GET /functions/v1/model_predict?seed=12345       deterministic simulation
GET /functions/v1/model_predict?registry=1       publish the registry + data contracts
GET /functions/v1/model_predict?calibrate=1&sport=tennis_wta
                                                 fit that model's weights on its own history
```

`?dry=1` is the deployment validation mode: it performs every read, every model
calculation and every telemetry computation, and writes nothing.

Writes are gated by `CRON_SECRET` (header `x-cron-secret`) when that variable is
set. Dry runs are not gated, so validation never needs the secret.

## The CLV baseline is immutable

The **first** prediction for `(model_version, event_id, market, selection)` is
the entry snapshot. It is protected by two things that must both stay:

1. the unique index `model_predictions_identity_uidx`, and
2. `Prefer: resolution=ignore-duplicates` on the upsert.

Re-running the function on the same slate therefore never overwrites
`market_prob_at_pred`, `market_am_at_pred` or `best_am_at_pred`. Remove either
one and EdgeDesk loses the ability to measure pre-game CLV, calibration, Brier
score or ROI after the fact.

## Event identity

`signals.event_id` is canonical. Everywhere. For every sport.

A team pair — or a player pair, or a fighter pair — is a **candidate bucket**
and nothing more. MLB is the only sport that has to reconstruct the join at all,
because the StatsAPI schedule is authoritative for what is being played: it
narrows by pair, takes the nearest unclaimed first pitch and **consumes** it.
Every other sport reads its event universe straight out of the captured market,
where the identity is already canonical.

## `model_edge` is not EV

```
model_edge = model_prob - market_prob_at_pred      a probability gap
model_ev   = model_prob * best_decimal_price - 1   an expected value
```

They live in separate columns and are labelled separately in the UI. Do not
relabel either into the other.

## Calibration

`?calibrate=1&sport=…` fits a model's feature weights on its own history,
walk-forward, with a **chronological** holdout, and stores them in
`public.model_parameters` alongside the sample size and the holdout metrics that
justified them. It also scores the plain-Elo baseline on the same holdout and
says plainly whether the fit beat it.

Deliberately excluded from every fit:

- **UFC career averages** (SLpM, takedown defence, style indices). They are
  career-to-date *as of today*, so fitting them on a 2019 bout leaks that bout's
  result into its own prediction. They are computed and stored in `model_detail`
  for audit, and never applied.
- **Tennis rankings.** `tennis.rankings_current` holds today's ranking only.
  Ranking still does real work as the cold start for players with too few
  matches to rate, where it applies to an *upcoming* match.
- **MLB.** `mlb_runs_v1.2_nbinom_dh` is a frozen baseline; its constants change
  only by cutting a new model version.

Read the results out of `public.model_calibration_by_sport` and
`public.model_reliability_buckets`. Both group by sport **and** model version —
a Brier score blended across MLB, UFC and tennis is not a number about anything.

## Deploy

Two options. The module tree is the source of truth either way.

**A — Supabase CLI (preferred).** Deploys `index.ts` and its 21 modules as-is.

**B — the in-browser function editor.** It deploys one file, so paste
`bundled.index.ts` instead. That file is GENERATED — regenerate it with
`npm run bundle` after any change, never edit it by hand. `tests/bundle.test.ts`
fails if it goes stale, and asserts that the same slate under the same seed
produces byte-identical rows from both builds.

```bash
# 1. schema first — the function writes columns this creates
supabase db push                     # or: psql -f supabase/migrations/021_model_predict_multisport.sql

# 2. the function — option A
supabase functions deploy model_predict --no-verify-jwt
#    option B: paste supabase/functions/model_predict/bundled.index.ts into the
#    dashboard editor as `model_predict`, Verify-JWT OFF

# 3. validate without writing
curl -s "$SUPABASE_URL/functions/v1/model_predict?dry=1" | jq '.sports | to_entries[] | {sport:.key, status:.value.status, built:.value.rows_built}'

# 4. one sport at a time, still dry
curl -s "$SUPABASE_URL/functions/v1/model_predict?dry=1&sport=baseball_mlb&seed=12345" | jq '.sports.baseball_mlb'

# 5. go live
curl -s -H "x-cron-secret: $CRON_SECRET" "$SUPABASE_URL/functions/v1/model_predict" | jq '.rows_written'
```

The isolated research schemas must be listed under
**Supabase → API settings → Exposed schemas** or the tennis and UFC models
report `insufficient_data`: `tennis`, `ufc`.

## Environment

| variable | default | effect |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | required |
| `CRON_SECRET` | unset | when set, gates every write |
| `RUN_DISPERSION` | `1.0` | MLB variance/mean for team runs. **Measure it from your own graded finals.** MLB typically lands 1.5–2.0 |
| `MODEL_MATCH_WINDOW_MIN` | `240` | MLB schedule↔market join window |
| `ATP_*` / `WTA_*` | published defaults | per-tour Elo parameters, independently overridable |
| `UFC_MIN_FIGHTS`, `UFC_MIN_FIGHTER_BOUTS` | `400`, `3` | sample floors below which UFC refuses to predict |
| `NFL_HFA_POINTS`, `NFL_TD_SHARE`, `NFL_SCORE_DISPERSION` | `2.0`, `0.62`, `1.15` | unfitted NFL parameters, reported on every row |
| `WNBA_HCA_POINTS` | `2.0` | unfitted WNBA parameter, reported on every row |
| `*_WINDOW_AHEAD_H` | per sport | how far ahead each sport's captured market is read |

## Tests

```bash
npm install
npm run check      # bundle && tsc --noEmit && node --test tests/*.test.ts
```

The MLB suite pins `mlb_runs_v1.2_nbinom_dh` against a **reference
implementation** transcribed from the shipped v1.2 function and swept across
3,000+ input combinations. If a refactor moves an MLB number, that test fails.

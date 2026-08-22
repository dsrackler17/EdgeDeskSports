# Integrating the Football Engine into the existing EdgeDesk stack

This repository is the EdgeDesk **frontend** plus the football research/
training pipeline. The Supabase Edge Functions run server-side; the sources
for `capture`, `model_predict`, `model_conf_odds`, `close` and `settle` have
been reviewed directly (supplied by the owner), so this document reflects the
REAL deployed architecture, not inference.

## The pipeline, as verified from function sources

```
capture (cron)     -> signals            full-board pricing, flag discipline,
                                         entry freeze. NFL is ALREADY in scope:
                                         AUTO_PREFIXES force-includes
                                         americanfootball_nfl; NCAAF is in the
                                         stable list. No changes needed.
model_predict      -> model_predictions  THE multi-sport prediction engine.
  (cron)                                 Registry: MLB, ATP, WTA, MMA, NFL,
                                         WNBA. Its nfl_game_v1 model is
                                         complete (compound TD/FG simulation,
                                         real key-number mass, push-aware
                                         probabilities, h2h/spreads/totals,
                                         frozen CLV baselines) and is DORMANT
                                         only because public.nfl_team_features
                                         has no rows.
close / settle     -> signals            closing snapshot + CLV, then results.
                                         NFL/NCAAF grade through the existing
                                         scores path. No changes needed.
model_conf_odds    -> model_odds         CFB conference-title Monte Carlo
                                         (SP+/model_ratings fuel). Unrelated to
                                         model_predictions — NOT the football
                                         integration point. (An earlier draft
                                         of this document guessed it was, from
                                         client-side evidence; the sources
                                         corrected that.)
frontend           <- model_predictions  MODEL engine renders any sport's rows,
                                         joins signals, quarantines from CLV.
```

## Existing function selected: `model_predict` (`nfl_game_v1`) — with zero edits

The engine your architecture already anticipates is the engine that runs.
The ONLY missing piece is its declared data contract:
`public.nfl_team_features` with `off_epa_play`, `def_epa_play`,
`plays_per_game` (plus optional split columns it reports on).

That is what this repo now supplies:

1. **`football/sql/010_nfl_team_features.sql`** — creates the exact table
   `nfl_game_v1` reads, keyed by `team_norm` (normalized full team name, the
   same `nrm()` the model applies to captured market names). Idempotent.
2. **`supabase/functions/ingest_nfl_features/index.ts`** — a small,
   self-contained cron feeder in the house style (BUILD string, CRON_SECRET
   auth with an honest 401, `?dry=1` compute-only mode, sanity gate that
   refuses to write an implausible batch, full diag in every response). It
   fetches nflverse public data (games.csv + stats_team_week — keyless, no
   odds quota) and writes 32 rows of **opponent-adjusted EPA levels**
   computed by the trained EdgeDesk Football Engine recursion
   (football/engine.js constants, walk-forward 1999–2025; recursion copied
   verbatim with attribution, parity-tested against the engine at 1e-5).

Why a new (small) function is genuinely necessary rather than an extension:
no deployed function touches nflverse or any NFL efficiency source —
`capture` prices odds, `ingest_mlb` is MLB StatsAPI, `cfb_ingest` is CFBD.
Feeding features from inside `model_predict` itself would couple ingestion to
prediction against that function's own module design (and its bundle is
generated — hand edits are lost on rebuild). If you would rather host this
inside `ingest_multisport`, send that function's source and the compute core
(`computeFeatures`, exported) drops in unchanged.

## Deployment order (shadow mode)

1. Run `football/sql/010_nfl_team_features.sql` in the SQL editor.
2. Create Edge Function `ingest_nfl_features`, paste
   `supabase/functions/ingest_nfl_features/index.ts`, Verify JWT OFF.
   No new secrets — it uses the existing CRON_SECRET convention.
3. Test read-only: `POST .../ingest_nfl_features?dry=1&secret=CRON_SECRET`
   → expect `rows_built: 32` and a diag block.
4. Run it live once, then `model_predict?dry=1&sport=NFL`
   → `data_quality.status` should flip from `insufficient_data` to `ok`,
   with rows built once NFL markets are captured (season start).
5. Schedule: weekly in the offseason, every 6–12h in season (before
   `model_predict`'s own schedule).
6. Shadow mode is the existing doctrine: NFL rows render in the app's MODEL
   engine as UNPROVEN, counted nowhere, graduating only via their own graded
   CLV. Nothing to configure.

Rollback: stop the cron / delete rows from `nfl_team_features` —
`nfl_game_v1` returns to `insufficient_data` and writes nothing. Historical
`model_predictions` rows keep their frozen `model_version` snapshots.

## Database changes

One new table (`nfl_team_features`, RLS enabled, service-role only).
Nothing else: `signals`, `model_predictions`, grading, CLV and the model
registry are used exactly as deployed.

## Frontend integration (live now)

* New **Football** research module (research shell, `#research/football`):
  NFL + CFB + **CFB Power 4** boards computed client-side by
  `football/engine.js` and `football/cfb_p4/engine.js` from the
  same public sources the training pipeline uses (nflverse / cfbfastR-data,
  both CORS-open), matched to live `signals` quotes where capture covers the
  sport (NCAAF today; NFL when added to capture scope) — all labeled
  research, UNPROVEN, with the backtest's honesty summary shown in-module.
* `model_predictions` overlay: the Edges board's MODEL-fair read now also
  loads `americanfootball_nfl` / `americanfootball_ncaaf` rows (it loaded
  only `baseball_mlb`). No visible change until server rows exist.
* Narration layer: the NFL "not ingested" declarations are updated to state
  the new truth precisely (client-side football engine exists; narration
  evidence path still not wired), keeping credibility scoring conservative.
* Nothing else changes: MLB, UFC, WTA, tennis, golf, Collective, odds,
  grading, settlement and AI behavior are untouched.

The app's Football research module (Research → Football) is independent of
all of the above — it computes client-side from the same public sources and
gates honestly. Once `model_predict` writes NFL rows, the Edges board's
MODEL-fair overlay picks them up automatically (the overlay already loads
`americanfootball_nfl`/`ncaaf` from `model_predictions`).

## The CFB Power 4 model (`football/cfb_p4/`)

The Power 4 engine is a SEPARATE bundle — its own `engine.js`, `params.js`,
`goldens.json` and `tests.js` — and it plugs in the same way, with two
differences worth knowing before deploying it server-side:

* **It has its own global** (`window.EDCfbP4` / `EDCfbP4Params`) and its own
  `model_version` (`edgedesk_cfb_p4_v1.0.0`). Rows written to
  `model_predictions` under that version are independently gradeable and can be
  rolled back without touching the v1 football rows.
* **Its input contract is much wider** — roster bundles, a starting QB record,
  injuries, weather, schedule context, off-field signals — and every one of
  those is OPTIONAL. Anything not supplied is declared missing and widens the
  distribution instead of moving the mean, so a server-side caller that has
  only schedules and results still gets a valid, correctly-hedged projection.

Two things the ingest could add that would switch dark layers on, in order of
value: per-player recruiting star ratings (turns on the blue-chip layer), and
coaching / coordinator continuity (turns on the staff half of the roster-
stability score). Both have declared injection points in the engine; neither is
faked in their absence.

`cfb.lines` is used for book context in the app. The historical backtest does
NOT use it — it uses the public cfbfastR-data line archive, which carries
opening numbers as well as closing ones.

## Posting Power 4 slates to the Model Collective

The Power 4 board's **Post to Collective** button downloads the slate and opens
`collective/#dashboard`. It deliberately does NOT post on the reader's behalf:
posting is an account action against their own creator profile, and the model,
week and data-origin choices belong to them.

No column mapping is needed. The Collective's uploader (`SLATE_FIELDS` in
`collective/index.html`) maps by header name, and this export's headers are
already in its synonym table:

| export column | maps to |
|---|---|
| `home_team` / `away_team` | home / away team |
| `kickoff_local` | game date |
| `week`, `game_id` | week, game ref |
| `model_home_line` | your spread (home side) |
| `model_fair_total` | your total |
| `ref_home_line` | market line you saw |
| `home_win_prob_pct` | home win % |
| `p_spread_pick_pct` | cover % |
| `spread_pick` | pick side |
| `confidence` | confidence |

Columns the uploader does not recognise are ignored, so the Power 4 extras ride
along harmlessly.

### The one thing that is NOT in this repo

**The Collective's sport vocabulary is server-side.** `meta().sports` comes from
the `collective_public` function, and `collective_ingest` validates a
submission's sport against the same list. Until a college-football sport code
exists there, a CFB slate has no model to attach to and the ingest will reject
it — nothing in this repository can change that.

What the server needs, once:

1. A college-football sport row in the Collective's sports table (code, current
   season) so it appears in `meta().sports`.
2. That code added to `collective_ingest`'s accepted sports.
3. Schedule/closing-line capture for the sport, so submissions have games to
   grade against — the Collective grades against its OWN captured closing
   lines, never self-reported numbers.

The frontend is already ready for it: the sport selector, the per-sport week
calendar (college football's regular season ends at 15 and its postseason is
conference championships, bowls and the playoff — not Wild Card through Super
Bowl), and the creator profile's per-model sport pills all key off whatever
`meta().sports` returns. The moment the server lists the code, CFB appears
beside NFL with no further frontend change.

## Environment variables / secrets

None new. The feeder reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET` — all already set for the other crons.

## CFB (phase 2, optional)

`model_predict` has no CFB game model; its registry is designed for adding
one (`SportPredictionModel` interface). A `cfb_game_v1` module can be built
on the trained CFB constants in `football/params.js` plus the `cfb` schema —
but `model_predict`'s bundle is GENERATED from a module tree
(`scripts/bundle.mjs`), so that change belongs in the tree, not the pasted
bundle. Send `supabase/functions/model_predict/{core,models}` if you want
that built; until then CFB remains research-only in the app's Football
module, which is fully live client-side.

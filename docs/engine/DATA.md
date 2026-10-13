# Data contract — schemas, sources, licensing, cadence, cost

## Sources

| Source | Used for | Access | Licence / terms | Cadence | Cost |
|---|---|---|---|---|---|
| `sportsdataverse/fastRhockey-nhl-data` (GitHub raw) | NHL play-by-play, goalie box, game info, 2010-11 → today | keyless | repository MIT; the game data is the NHL's (NHL.com terms restrict commercial use — **owner review required before paid use**) | daily in season | free |
| `sportsdataverse/fastRhockey-nhl-raw` (GitHub raw) | NHL season schedule incl. future games | keyless | as above | daily | free |
| NHL web API `api-web.nhle.com` | today's schedule and game states | keyless, undocumented | no published terms for automated use; called politely (≤ 4/s, cached 10 min) | each build | free |
| The Odds API, only via `supabase/functions/odds_gateway` | NHL book prices (`featured`: h2h, spreads, totals) | gateway service credentials | commercial API | only when authorised | ≈3 credits per call; **0 by default** |
| Licensed closing archive (not present) | the market test | — | must be licensed | weekly | depends on source |

Market-definition assumption (documented, not verified against the provider's
docs from this environment): the provider's NHL `h2h` is the two-way
moneyline including OT/SO, `spreads` the puck line including OT/SO, and
`totals` include OT with the shootout winner credited one goal.

## Spend and quota controls

- `engine/http.js` (free sources): disk cache with TTL and ETag/Last-Modified
  revalidation, stale-if-error, in-flight dedupe, per-provider per-run and
  per-day quotas, a circuit breaker (4 consecutive failures → 15 min open),
  bounded retries with backoff and jitter honouring Retry-After, per-provider
  concurrency and spacing. A paid provider has a zero quota unless
  configured; an unregistered host is refused; the odds host is not
  registered at all.
- Paid odds: one gateway (`odds_api_acquire`), the NHL sport row created
  **disabled** (`supabase/nhl_odds_sport.sql`), and a second switch in the job
  (`NHL_PRICES=on`). `tools/odds/no_bypass.test.js` §10 fails the build if any
  engine file calls a spending function.

## Schemas (all versioned)

### `edgedesk_nhl_team_games_v1` — `hockey/data/team_games/<season>/<YYYY-MM>.csv`
Two rows per completed game. Keys: `game_id, season, type (R|P), date,
start_utc, known_at, team, opp, home, decided (REG|OT|SO)`. Results:
`gf, ga, gf_reg, ga_reg, win, so`. Time on ice (s) by state from the team's
side: `toi_ev5, toi_evo, toi_pp, toi_sh, toi_enf, toi_ena` and 5v5 by score
`toi_ev5_lead/tie/trail`. For-metrics by state: goals `*_gf`, unblocked
attempts `*_ff`, all attempts `ev5_cf`, xG `*_xgf`, and 5v5 xG/attempts by
score. Penalties: `pen_minors, pen_majors, pim`. Goalies: `g_start` and up to
two goalies with `fa, ga, xga`. Provenance: `xg_model` (the model that scored
the row), `src` (hash of the source file). Against-metrics are the opponent's
row. `known_at` = scheduled start + 4 h; a model may use a row only for a game
whose prediction time is later AND whose date is later.

### `edgedesk_nhl_slate_v1` — `hockey/slate.json`
Upcoming games: λ, prices for every market with settlement text, goalie
projections and scenarios, evidence, uncertainty (variant spread + the
held-out calibration bin), data quality, invalidators; a readiness block
(data / model / market / value claims); the record; attribution.

### `edgedesk_nhl_ledger_v1` — `hockey/ledger/<season>.jsonl`
Append-only, hash-identified pregame records written only when a price moves
(1 pp moneyline, 0.1 goals total), the model changes, or the goalie certainty
changes; never at or after the start (`build_slate.js --check`). When prices
are captured each record also freezes the best book price and the no-vig
consensus, so `grade_ledger.js` can report CLV.

### `edgedesk_market_quotes_v1` — `hockey/market/quotes.json`
`status` LIVE | CACHED | UNAVAILABLE | DISABLED with `reason`; gateway
provenance (`decision, source, fetched_at, request_id, cost, quota`);
`events[]` matched to games by both clubs and a start within 6 h; `unmatched[]`
with reasons.

### Closing archive — `hockey/market/closing/<season>.csv` (licensed; not shipped)
```
game_id,source,book,captured_at,close_home_ml,close_away_ml[,open_home_ml,open_away_ml,opened_at]
[,close_total_line,close_over,close_under][,close_pl_home_line,close_pl_home,close_pl_away]
```
Rows without `source`/`captured_at`, or captured at or after the start, are
rejected and counted.

### Confirmed starters — `hockey/data/confirmed_starters.json`
```
{ "starters": { "<game_id>": { "home": <goalie id>, "away": <goalie id>, "source": "...", "url": "...", "recorded_at": "ISO" } } }
```

### My own quotes — `engine/market/manual_quotes.json`
```
{ "schema": "edgedesk_manual_quotes_v1", "quotes": [ { "event_key": "NHL|2026020123", "market": { "kind": "moneyline", "side": "DET", "line": null },
  "book": "...", "american": -125, "captured_at": "ISO", "note": "..." } ] }
```
Labelled USER_SUPPLIED on the board; judged by the same rules as captured prices.

### `edgedesk_engine_registry_v1` / `edgedesk_engine_board_v1` — `engine/`
The registry is rebuilt from validation files; the board keeps every
actionable row and, per sport, 24 research rows, with counts for all.

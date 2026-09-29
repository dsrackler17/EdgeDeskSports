# Player props — runbook

## The stages (`football/props/run.js`)

| stage | what it does | needs |
|---|---|---|
| `history [--league nfl\|cfb] [--offline] [--deep-cfb]` | box scores, identity bridge, QA → `.cache/props/work`, `identity/*`, `published/coverage.json` | network once per completed season (cached after) |
| `backtest [--last-n 3 \| --all-folds]` then `summarize` | walk-forward validation → `validation/outcome_<lg>.json`, `validation/market.json` | the history cache |
| `train [--force]` | the production model versions (trained through the last completed season) → `models/<lg>/*.json`, `models/registry.json` | a walk-forward on file (else CANDIDATE) |
| `score [--window-h 192] [--now ISO]` | every upcoming game → `published/*`, the prediction ledger | champion models |
| `capture --network [--alt] [--max-events 16]` | observed quotes + listings from The Odds API → the quote ledger | `ODDS_API_KEY` |
| `backfill --network --from YYYY-MM-DD [--max-games 25]` | The Odds API historical props (2023-05-03+), budgeted | `ODDS_API_KEY` on a plan with historical access |
| `record` | score, freeze qualifying entries, settle final games → `record/props/*` | — |
| `sync` | mirror everything into Supabase (`props` schema) | `SUPABASE_DB_URL` (or `DATABASE_URL` / `EDGD_PG`) |

`npm run props:*` wraps each; `npm run props:test` runs the offline suites,
`npm run props:sql` the SQL contract against a throwaway PostgreSQL,
`npm run props:e2e` the page in Chromium.

## The workflow (`.github/workflows/player-props.yml`)

* **live** — every 3 hours, August–January: history (the season in progress),
  capture (only with `vars.PROPS_CAPTURE == 'on'` and the `ODDS_API_KEY`
  secret; `vars.PROPS_CAPTURE_ALT == 'on'` adds alternate lines), record,
  publish, and the Supabase mirror when `SB_DB_URL` is set.
* **weekly** — Tuesday: last three walk-forward folds, summarize, train new
  versions only.
* **backfill / apply_sql / test** — manual.

## Turning on quote capture

1. Apply the contract: run the workflow with `mode: apply_sql` (or paste
   `supabase/parts/player_props.part*-of-6.sql` in order), then
   `supabase/expose_schemas.sql`. Every report row must read `ok`.
2. Confirm the `ODDS_API_KEY` secret exists (the same key the game capture uses).
3. Set the repository variable `PROPS_CAPTURE` to `on`. Main lines only cost
   one credit per market per region per event; `PROPS_CAPTURE_ALT=on` roughly
   doubles the markets requested. Capture stops on 401/429, keeps a credit
   floor, and polls each event at most once per interval.
4. After the first run: the board's banner changes to the capture line, rows
   gain MARKET / EDGE / EV, and `validation/market.json` starts filling as
   entries are frozen and graded. The decision stays capped at LEAN until the
   market folds validate a model.

## Identity review

`football/props/identity/review_queue.json` lists links below the production
threshold and quarantined matches. To link one, add it to
`identity/overrides.json` with the evidence (ESPN ids, college, draft); never
link on a name alone.

## What is blocked only by credentials or paid data

* Observed prop quotes (live and historical): `ODDS_API_KEY` and the variable
  above; historical player props need a paid The Odds API plan.
* The Supabase mirror: `SB_DB_URL`.
* Snap counts before 2012 and CFB snaps/routes: not published by the free
  sources; those features are imputed and flagged in data quality.

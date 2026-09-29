# football/props — the player props pipeline

This folder feeds the **Props** tab. Operating steps and the credit arithmetic
are in `docs/runbooks/player-props.md`; the design and every formula are in
`docs/player-props/DESIGN.md`.

```
sources/nfl.js | sources/cfb.js   public feeds → one dataset (players, logs, team rows, depth, injuries, schedule)
capture.js                        The Odds API per-event player markets → <league>/quotes.json, lines.json, capture_state.json
                                  (opt-in, budgeted; per-game cadence, retry/back-off, health — docs/player-props/FRESHNESS.md)
health_sync.js                    the run log and health record → Supabase (supabase/player_props_pipeline.sql)
model.js                          volume × share × efficiency → a distribution per player and market
backtest.js                       walk-forward distribution check → nfl/calibration.json
build_board.js                    dataset + quotes + calibration → <league>/board.json, players.json, the write-once ledger
grade.js                          finished games → results.jsonl, performance.json (CLV only where a close exists)
sync_supabase.js                  insert-only copy of the ledger (supabase/player_props.sql)
```

Every probability, EV and decision is made by `lib/edgedesk_props.js`. The
build and the page call the same function.

## What is committed

The following are written by the Player props job (woken by `supabase/functions/props_cron`, with GitHub's schedule as the backup); never edit them by hand:

- `<league>/board.json` and `players.json`
- `<league>/pregame_state.json`
- `nfl/shapes.json`
- `nfl/calibration.json`, written by the backtest
- once prices are captured: `quotes.json`, `lines.json`, `capture_state.json`
  and `<league>/<season>/*.jsonl`

`.cache/` (gitignored) holds downloaded feeds and the quotes the last build
resolved for the Supabase copy.

## Tests

- `pipeline.test.js` runs the whole chain offline on `fixtures/`. The fixtures
  are a small slice of real nflverse data and one hand-written Odds API
  response. They are test data, not market data.
- `tools/props/` holds the kernel, SQL and browser suites.

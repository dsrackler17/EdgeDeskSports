# football/props — the CFB + NFL player-prop factory

Architecture and rules: [`docs/player-props/ARCHITECTURE.md`](../../docs/player-props/ARCHITECTURE.md).
Operating it: [`docs/player-props/RUNBOOK.md`](../../docs/player-props/RUNBOOK.md).

| file | role |
|---|---|
| `config/` | markets + provider map, feature registry, quality rules, backtest folds, pipeline jobs, sources |
| `sources/nfl.js`, `sources/cfb.js` | nflverse and cfbfastR / SportsDataverse adapters |
| `identity.js` | the CFB→NFL bridge (`identity/` holds pins, merges, overrides, the review queue) |
| `warehouse.js`, `qa.js` | the season cache and the Q001–Q015 gates |
| `features.js` | the point-in-time feature engine |
| `model.js`, `backtest.js` | distribution models and walk-forward validation (`models/`, `validation/`) |
| `score.js`, `publish.js` | scoring and the packed artifacts in `published/` |
| `odds.js` | The Odds API capture and historical backfill (observed quotes only) |
| `record.js` | freeze and settle (`record/props/`) |
| `db.js` | the Supabase sync (`supabase/player_props.sql`) |
| `desk.js` | the AI desk's deterministic prop answers |
| `fixture_quotes.js` | TEST FIXTURE quotes for the UI tests — never published |
| `run.js` | the stages |

Tests: `props.test.js` (kernel + wire), `leakage.test.js`, `identity.test.js`,
`odds.test.js`, `desk.test.js`, `ui.test.js`, `record_section.test.js`,
`sql.test.js` (real PostgreSQL), `ui.e2e.js` (Chromium).

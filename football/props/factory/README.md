# football/props/factory — the player-prop data factory

History, identity, point-in-time features and walk-forward-validated models
under the Player Props terminal (`football/props/*.js`). Architecture and
rules: [`docs/player-props/FACTORY.md`](../../../docs/player-props/FACTORY.md).

| file | role |
|---|---|
| `config/` | canonical markets, feature registry, quality rules, backtest folds, pipeline jobs, sources |
| `sources/nfl.js`, `sources/cfb.js` | nflverse and cfbfastR / SportsDataverse adapters (2011+ / 2014+) |
| `identity.js` | the CFB→NFL bridge (`identity/`: pins, merges, overrides, review queue) |
| `warehouse.js`, `qa.js` | the season cache and the Q001–Q015 gates |
| `features.js` | the point-in-time feature engine |
| `model.js`, `backtest.js` | distribution models and walk-forward validation (`models/`, `validation/`) |
| `score.js`, `export.js` | upcoming-game projections → `<league>/projections.json` for the terminal |
| `odds.js` | The Odds API historical backfill (observed, lineage-checked) |
| `db.js` | the Supabase sync (`supabase/props_factory.sql`) |
| `dist.js` | the distribution arithmetic and metrics (Node; the terminal prices with `lib/edgedesk_props.js`) |
| `run.js` | the stages |

Tests: `dist.test.js`, `leakage.test.js`, `identity.test.js`, `odds.test.js`,
`export.test.js`, `sql.test.js` (real PostgreSQL).

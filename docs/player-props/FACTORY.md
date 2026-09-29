# Player props — the data factory

The history, identity, point-in-time features and walk-forward-validated
models **under** the Player Props terminal ([`DESIGN.md`](DESIGN.md)). The
terminal owns live prices (capture v11), the board, the decision, units,
grading, the page, the record and the AI desk. The factory owns what the
terminal's own audit ([`AUDIT.md`](AUDIT.md)) lists as missing: committed
per-game player history for both leagues, a CFB→NFL identity bridge, a
leakage-tested feature store, and learned models validated out of sample —
including the college markets the terminal has no backtest for.

Code: `football/props/factory/`. Database: `supabase/props_factory.sql`
(`props` schema). Workflow: `.github/workflows/props-factory.yml`.

## What reaches the terminal

```
 nflverse (2011+) · cfbfastR / SportsDataverse (2014+)
        │  factory/sources/{nfl,cfb}.js
        ▼
 warehouse.js ── identity.js (CFB→NFL bridge) ── qa.js (Q001–Q015, quarantine)
        ▼
 features.js — point-in-time engine (121 features): games replayed in
               kickoff order, shift before roll, a box score is final at
               kickoff + 4 h, source_max_timestamp ≤ asof_at ≤ kickoff
        ▼
 model.js / backtest.js — one immutable model per league × position ×
               market: ridge Poisson GLM mean → full distribution (NB /
               Poisson / binomial counts, empirical-ratio yardage, anytime
               TD from P(0)), PIT recalibration only where it wins;
               walk-forward folds with governance tiers
        ▼
 score.js → export.js — every upcoming game, the champion models'
               distributions → factory/<league>/projections.json, keyed by
               the TERMINAL's game id, player id (GSIS / ESPN athlete id)
               and market key
        ▼
 football/props/build_board.js (terminal) — joins them onto each prop as
               `fx`; lib/edgedesk_props.js prices them (family `stored`);
               the drawer and the AI desk show them beside the engine
```

The factory's distribution is **evidence beside the terminal's engine**. It
never sets a price and it does not change the terminal's decision, units or
validation stage: evidence that the factory's model is calibrated is not
evidence that the engine is. Whether it should one day drive the decision is
the terminal's call, made on its own graded ledger.

## Rules the factory enforces

* **Identity.** A CFB player is linked to an NFL player on an exact ESPN id
  (confirmed by name and college or chronology), name + college + draft, or
  name + college + position + chronology; confidence below 0.9 is not
  production-eligible and goes to `factory/identity/review_queue.json`. Never
  on a name alone. Manual links: `factory/identity/overrides.json`, with the
  evidence.
* **Quarantine, don't mutate.** Q001–Q015 (`factory/config/quality_rules.json`)
  quarantine failing rows with the rule id; a changed stored fact is logged in
  `props.fact_corrections`.
* **No leakage.** `leakage.test.js` proves shift-before-roll by hand, that a
  row's own game and future games change nothing, that a same-day earlier
  game is not final in time, and that every row of the real archive obeys
  `source_max_timestamp ≤ asof_at` (Q008 refuses one that does not).
* **Immutable versions.** A retrain is a new model version; the old champion
  is RETIRED, never rewritten. Predictions are change-only: an identical
  prediction keeps its id and as-of time.
* **Governance.** A model that loses to the naive composite out of sample is a
  CANDIDATE and never projected (WR rush yards, both leagues, today).
  OUTCOME_VALIDATED needs positive skill in every fold and a PIT deviation
  ≤ 0.03.
* **Lineage.** The historical quote store (`props.fact_prop_quote`, filled by
  the Odds API historical backfill) requires `observed` or `reconstructed`; a
  reconstructed quote must name `edgedesk_reconstruction` as its provider and
  can never enter a backtest. Live quotes are the terminal's ledger.

## Validation today

Walk-forward, latest three folds per league (`factory/validation/outcome_*.json`):

| League | Models | OUTCOME_VALIDATED | OUTCOME_LEAN | RESEARCH | Median MAE skill vs naive |
|---|---|---|---|---|---|
| NFL | 48 | 26 | 21 | 1 | +11% |
| CFB | 44 | 40 | 3 | 1 | +9% |

History: 283k NFL and 431k CFB player-games; 3,307 CFB→NFL links (221 in the
review queue, 4 quarantined).

## Operating it

| stage | does | needs |
|---|---|---|
| `history [--league] [--offline] [--deep-cfb]` | box scores, identity, QA → `.cache/props/work`, `factory/identity/*`, `factory/coverage.json` | network once per completed season |
| `backtest [--last-n 3 \| --all-folds]`, `summarize` | walk-forward → `factory/validation/outcome_<lg>.json` | the history cache |
| `train [--force]` | new immutable versions → `factory/models/` | a walk-forward on file |
| `project [--window-h 192] [--now ISO]` | upcoming games → `factory/<lg>/projections.json`, the prediction ledger | champion models |
| `backfill --network --from YYYY-MM-DD` | Odds API historical props → the lineage-checked store | `ODDS_API_KEY` with historical access |
| `sync` | mirror into Supabase (`props`) | `SUPABASE_DB_URL` |

`npm run props:factory:test` runs the offline suites; `npm run
props:factory:sql` the SQL contract on a throwaway PostgreSQL. Apply the
database with the workflow's `apply_sql` mode (or paste
`supabase/parts/props_factory.part*-of-6.sql`), then `supabase/expose_schemas.sql`.

Blocked only by credentials or paid data: the Supabase mirror (`SB_DB_URL`);
the historical quote backfill (a paid The Odds API plan). Snap counts before
2012 and CFB snaps / routes are not in the free sources; those features are
imputed and counted against data completeness.

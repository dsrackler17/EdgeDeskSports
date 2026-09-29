# Player props — architecture

The CFB + NFL player-prop research system: historical box scores, the
CFB→NFL identity bridge, a point-in-time feature store, per-position
distribution models, observed sportsbook quotes, pricing (no-vig, fair odds,
EV, alternate lines, line shopping, movement), walk-forward validation, a
frozen graded record, the Research › Props page and the AI desk.

Research, not picks. MODEL, MARKET and EDGE are always three different
numbers, and nothing is ever shown as a price unless a sportsbook posted it.

## What was reused, extended, created

| | |
|---|---|
| **Reused** | `lib/research_core.js` and `lib/edgedesk_quote_ev.js` (every odds conversion, no-vig, EV, fair price, CLV); `tools/tennis/lib/pg.js` (psql + COPY sync); `tools/football/write_if_changed.js`; `tools/ci/push_generated.sh`; the nflverse and SportsDataverse / cfbfastR feeds and the ESPN team crosswalk (`football/fbs_epa/teams.json`); the game market (`football/pricing/lines_*.json`, CFB lab ledger, terminal games), injuries, starters, availability and forecasts the terminal already publishes; The Odds API key (`ODDS_API_KEY`) and budget discipline of the capture jobs; the Supabase shim and throwaway-Postgres test harness; the edge function's `Dal.getArtifact` and inliner |
| **Extended** | `app.html` (a Props tab for NFL and CFB beside the other sports' projections); `record.html` (a player-prop section); `supabase/functions/edgedesk_ai/index.ts` (`propsTurn`, routed before the game desk); `tools/presentation/inline.js` (three inlined blocks); `supabase/expose_schemas.sql` (`props`); lint and navigation tests |
| **Created** | `football/props/` (the factory), `lib/player_props.js` (the kernel), `lib/player_props_ui.js` + `.css` (the page), `supabase/player_props.sql` (the `props` schema), `.github/workflows/player-props.yml` |

## Layers

```
 nflverse (2011+) · cfbfastR / SportsDataverse (2014+)        The Odds API (2023+)
        │  football/props/sources/{nfl,cfb}.js                        │ football/props/odds.js
        ▼                                                             ▼
 warehouse.js ── identity.js (CFB→NFL bridge) ── qa.js (Q001–Q015, quarantine)
        │                                                   observed quotes + per-poll listings
        ▼                                                   (change-only ledger, append-only table)
 features.js — point-in-time engine: games replayed in kickoff order,
               shift-before-roll, a box score is final at kickoff + 4 h,
               source_max_timestamp ≤ asof_at ≤ kickoff on every row
        ▼
 model.js — one model per league × position × market:
            ridge Poisson GLM mean → a full distribution
            (counts: NB / Poisson / binomial from a·μ + b·μ²; yardage: empirical
            y/μ ratios by μ-bin; anytime TD = 1 − P(0)), a PIT recalibration
            map applied only when the walk-forward shows it helps
        ▼
 backtest.js — walk-forward folds (config/backtest_splits.json, 2026 = live
               holdout), outcome metrics, governance tiers; the MARKET folds
               take observed pregame quotes only
        ▼
 score.js — every upcoming game: candidates by role, the stored distribution,
            then the kernel's reprice() over the observed quotes
        ▼
 publish.js (packed artifacts) · record.js (freeze / settle) · db.js (Supabase)
        ▼
 Research › Props (lib/player_props_ui.js) · record.html · the AI desk (desk.js)
```

## One kernel

`lib/player_props.js` is the only place prop arithmetic lives. It evaluates the
stored distribution (`{t:'pmf'}`, `{t:'cdf'}`, `{t:'bern'}`) at any line
(whole lines push; integer stats use a continuity correction), and prices a
quote at its own book's price. `reprice()` builds everything market-dependent
for a prop: market view, movement, ladders, confidence, data quality,
decision, explanation. The scorer runs it; the page and the AI desk run the
**same function** on the published card and quotes (`wire.expandCard`). A test
proves the round trip reproduces the scorer exactly (`props.test.js`). SQL
carries the same distribution arithmetic in `props.dist_probs()`.

## Rules the system enforces

* **Lineage.** Every quote is `observed` or `reconstructed`; the kernel refuses
  to price anything but `observed`; the table forbids a reconstructed quote
  naming a sportsbook provider; a backtest decision can only stand on an
  observed pregame quote. No reconstructed quote is produced today.
* **Never overwrite.** Quotes, listings, feature snapshots, predictions and
  model versions are append-only / immutable (triggers refuse update, delete
  and truncate). A retrain is a new model version; the old champion is
  RETIRED. Predictions are change-only: an identical prediction keeps its id
  and as-of time.
* **Identity.** A CFB player is linked to an NFL player on an exact ESPN id
  (confirmed by name and college or chronology), or name + college + draft,
  or name + college + position + chronology; confidence below 0.9 is not
  production-eligible and goes to `identity/review_queue.json`. Name-only
  matches are never linked. Manual links go in `identity/overrides.json` with
  their evidence.
* **Quarantine, don't mutate.** QA rules Q001–Q015 (`config/quality_rules.json`)
  quarantine failing rows with the rule id; corrections to a stored fact are
  logged in `props.fact_corrections`.
* **No leakage.** `leakage.test.js` proves shift-before-roll by hand
  computation, that a row's own game and future games change nothing, that a
  same-day earlier game is not final in time, and that every row of the real
  archive obeys `source_max_timestamp ≤ asof_at` (Q008 refuses one that does not).
* **Governance.** A model that loses to the naive composite out of sample is a
  CANDIDATE and is never scored (WR rush yards, both leagues, today).
  OUTCOME_VALIDATED needs positive skill in every fold and a PIT deviation
  ≤ 0.03. The MARKET tier stays RESEARCH until observed quotes validate it, so
  every decision is capped at LEAN — the label says so.
* **Confidence ≠ edge.** Confidence (nine weighted components, unknowns cost
  points), data quality (input completeness and freshness) and edge are
  separate numbers; the decision needs all three.
* **Best value, not the extreme.** On an alternate ladder the best value is the
  highest quarter-Kelly log-growth on the conservative (market-anchored,
  tail-penalised) probability; the highest probability and the largest raw EV
  are shown beside it.

## Serving

`football/props/published/` (committed, read by the static site and the AI
desk), in the kernel's packed wire format:

| file | content | size today |
|---|---|---|
| `board_<lg>.json` | one short array per player-market + lookup tables | NFL ≈ 0.3 MB, CFB ≈ 1.0 MB |
| `<lg>/<game_id>.json` | the research card: the model half of every prop, player context once | ≈ 0.2 MB per game |
| `<lg>/<game_id>.market.json` | observed quotes each book currently lists + movement; only when a quote exists | — |
| `status.json`, `coverage.json` | what ran, identity and QA coverage | small |

Cards change only when a model input changes (forecasts are quantised so an
hourly wobble does not rewrite them); a quote refresh touches only the board
and the market file. `ui.test.js` holds the payload budgets.

Supabase (`props` schema) holds the durable, immutable copy: facts, identity,
quotes, listings, features, predictions, models, the record. Readers get
owner-run views and the `ai_*` functions.

## Validation today

Walk-forward, latest three folds per league (`validation/outcome_*.json`):
NFL 48 models — 26 OUTCOME_VALIDATED, 21 OUTCOME_LEAN, 1 RESEARCH (median MAE
skill vs the naive composite +11%); CFB 44 models — 40 / 3 / 1 (median +9%).
The market folds read `NO_OBSERVED_QUOTES`: no prop quote has been captured,
so no market claim is made.

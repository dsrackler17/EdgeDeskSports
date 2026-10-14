# Men's college basketball research engine

An independent team, player, lineup and matchup research model for NCAA men's
basketball. It runs without sportsbook odds; a market comparison is an
optional, separate layer that is allowed to say PASS.

- **Pages:** `/research/ncaam/` (`research/ncaam/`): teams, team research, player
  impact, lineups, a scenario tool, any-two-teams matchups, as-of pregame
  reports, 2026-27 openers, validation, data diagnostics and method.
- **Engine:** `basketball/ncaam_research/` (Node; Parquet read through
  `hockey/tools/parquet_select.py` with pyarrow).
- **Data:** `datapack/ncaam_v1/` (three uploaded archives, hash-verified on
  every read). See `datapack/ncaam_v1/IMPORT.json`.
- **Shared math:** `lib/ncaam_research.js` (scenarios, matchup projection,
  score distributions, exact-market pricing with pushes, PASS gates). The
  build and the browser run the same code.
- **Results:** [VALIDATION.md](VALIDATION.md). **Method:** [METHODOLOGY.md](METHODOLOGY.md).
  **Public sources reviewed:** [METHODOLOGY_SOURCES.md](METHODOLOGY_SOURCES.md).

## Commands

| Step | Command | Time |
|---|---|---|
| Offline tests (synthetic data) | `npm run ncaam:test` | seconds |
| Real-pack tests (pyarrow) | `npm run ncaam:test:pack` | ~30 s |
| Browser tests (Playwright) | `npm run ncaam:e2e` | ~30 s |
| Choose team-model hyperparameters on 2025 and freeze | `npm run ncaam:tune` | ~5 min |
| Score the frozen choice on the 2026 holdout | `npm run ncaam:holdout` | ~3 min |
| Player-layer validation (inside 2026) | `npm run ncaam:players` | ~5 min |
| Matchup-interaction test | `npm run ncaam:interactions` | ~1 min |
| Build every published research file | `npm run ncaam:build` | ~3 min |
| Refresh = re-verify the pack, re-run validation and rebuild | `npm run ncaam:refresh` | ~12 min |
| Committed record rebuilds | `npm run ncaam:check` | ~5 min |

`ncaam:tune` is deliberately not part of `ncaam:refresh`: re-tuning after
seeing the holdout would contaminate it. A new selection needs a new holdout
season.

## Layers

1. **Ingestion and identity** (`ingest.js`, `identity.js`, `lib/pack.js`).
   ESPN, NCAA and publisher namespaces are never mixed. D1 membership is per
   season (explicit-ID bridge + reviewed overrides in
   `identity/team_overrides.json`); anything else is UNKNOWN membership and a
   separate regime. NCAA player ids are linked to ESPN athletes by box-score
   fingerprints, not names; conflicts are quarantined
   (`published/identity_quarantine.json`).
2. **Audit** (`audit.js` → `published/audit.json`). Possession points vs
   official finals, both lineup reconstructions vs ESPN starters (the
   publisher lineup table is quarantined), shot `score_value` on misses,
   the possession estimator, publisher RAPM, identity coverage.
3. **Team strength** (`team_model.js`, `lib/additive.js`). Opponent-adjusted
   offense, defense and tempo; venue; prior from last season; transfers;
   posterior uncertainty; current form beside season-long.
4. **Style** (`style.js`). Four factors, shot mix, ball security,
   rebounding, free throws, transition and possession length, each
   opponent-adjusted and shrunk by its measured reliability (observed vs
   sustainable).
5. **Players** (`player_model.js`, `minutes.js`). RAPM with a box-score and
   prior-season prior, posterior SDs, separability, minutes and
   participation, total contribution, replacement cost.
6. **Lineups** (`lineups.js`). Raw, opponent-adjusted and pooled lineup
   ratings; persistence and role-composition tests.
7. **Matchups and scenarios** (`lib/ncaam_research.js`). Projection,
   distributions, offense-vs-defense comparisons, conditions that would change
   the number; conditional minutes scenarios.
8. **Market** (`market.js` + `compareMarket`). Reads timestamped quotes in the
   pack's `market_quotes` contract if a file exists at
   `basketball/ncaam_research/market/quotes.json|csv`; otherwise every pricing
   section says "market comparison unavailable". No file is committed: the
   odds gateway does not capture basketball and no quote is fabricated.

## Four kinds of number

The pages label every number as one of:

- **Descriptive**: what happened. Records, raw rates, raw on/off and raw
  lineup results.
- **Estimated**: opponent-adjusted, shrunk skill. Ratings, sustainable rates
  and player impact.
- **Projected**: forecasts with calibrated uncertainty. Matchups and openers.
- **Conditional**: "if this player is out". Not availability, and not causal
  proof.

## What is missing (exact data that would improve it)

| Missing input | What it would unlock |
|---|---|
| Effective-dated confirmed availability and starting fives, with publish times | pregame scenarios that can be validated as forecasts, not oracle checks |
| 2026-27 rosters, transfer/commitment/enrollment dates, eligibility, class year | a real preseason projection (today: last season carried forward) |
| Recruiting composite rankings | the freshman prior public systems rely on |
| Possession data for 2024 and 2025 (same publisher format) | multi-season player priors; a cross-season player-layer test |
| Timestamped executable odds with book rules; a closing-price archive | the market comparison and any test against the market |
| Raw play-by-play with substitutions and parser QA flags | direct verification of lineups and possessions |
| Tracking (shot quality, defender distance, coverages) | shot-quality and defensive-scheme claims (none are made now) |
| Officials, travel, venue coordinates | foul and travel effects (rest showed nothing measurable) |

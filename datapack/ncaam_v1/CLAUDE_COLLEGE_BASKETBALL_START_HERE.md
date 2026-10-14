# Implement my EdgeDesk men's college basketball model

Work in my existing EdgeDesk repository. Inspect the architecture, extract all three ZIPs into the same parent directory, read README.md, COVERAGE.json, PARTS.json and sources/FEATURE_METHODS.json, then implement and test the men's college basketball pipeline. Keep my existing working sports and product behavior intact. Do the work and report concise results.

## 1. Establish what the data actually supports

Use Python/SQL to inspect Parquet files, not token dumps. Load every part before judging missing tables. Native source types and every source field are preserved. Read sources/inventory.json for checksums and sources/field_inventory.json for measured null coverage. There are three seasons of ESPN game/team/player history, 2026 detailed shots, publisher-derived NCAA possession/lineup/player-split data, and separate pregame features. Source archives are public SportsDataverse releases, derived from ESPN and stats.ncaa.org. They are not a private quant model or a ready betting brain.

Treat missing as unknown. Read the QA report before combining sources. The source lineup error flag is all-null: null does not mean clean. A missed shot may have positive score_value; never interpret score_value alone as scored points. Source coordinate transforms, actor roles, inferred substitutions and possession definitions need verification. Reconstructed transition/rim/assisted statistics are publisher classifications, not optical tracking. Do not silently replace an official box score with a reconstructed total that disagrees.

## 2. Build reproducible identity and ingestion layers

Create typed, idempotent ingestion with source, release timestamp, observed_at, source URL/hash and original values. Separate NCAA contest IDs, NCAA team-season IDs/player IDs, ESPN game/team/athlete IDs and publisher person IDs. Join using explicit IDs/crosswalks only. Name-only roster rows and lineup strings need independent identity resolution; no automatic short-name or fuzzy-name merges. Persist ambiguous mappings and quarantine conflicting keys.

Use the end-year season field: 2026 means 2025–26. Do not equate a lineup's team_year with this field. Filter D1-v-D1 training only after season-specific membership checks; keep non-D1 opponents in a separately specified regime. A failed reference match is unknown membership, not definitive proof of lower division. Distinguish neutral sites, campus games, conference games/tournaments, postseason tournaments, exhibition and cancelled games. Men play two 20-minute halves plus 5-minute overtimes; never reuse NBA quarters or women's college quarter rules.

## 3. Implement honest measurements and opponent adjustment

Start with transparent models for possessions and points per possession, with regularized team offense/defense, opponent strength, home/neutral context, rest and rotation exposure. The supplied .44-FTA possession estimate is a generic proxy; compare it with audited possession parsing before choosing a college-specific estimator. Fit coefficients on training folds, not the final holdout. Use pooled counts and exposure for rates; report small-sample uncertainty. Validate early-season schedule-graph connectivity so disconnected conferences are not given falsely precise comparisons.

Include eFG, turnovers, offensive/defensive rebounds, free-throw generation and conversion, three-point volume, rim/midrange/three mix, assisted/unassisted scoring, transition/half-court splits, offensive/defensive possession length and lineup matchup exposures when QA allows. Shrink shooting and lineup estimates. Source final-game stats are labels or future-game inputs, never predictors for the same game.

## 4. Treat college player change as a first-class problem

Model minutes separately from per-minute rates, with participation, starting status, fouls, bench role, absences and uncertainty. Account for transfers, freshmen, graduation, eligibility, redshirts, coaching changes and returning production using effective-dated sources. Name-based participation summaries are not eligibility/registration or current availability feeds. Do not backfill current rosters into historical games. Separate player development and team-role changes from stable skill; use roster overlap and minute-weighted continuity where verified.

Validate provider-derived on-court and adjusted plus-minus fields against box-score totals, clock/exposure integrity, five-player identities and missingness. Full-season RAPM includes later games: prohibit it as a predictor for earlier games in that same season. Refit inside each training fold or use it only as an explicitly available prior for a subsequent season after identity/roster checks.

## 5. Build and falsify baselines before selecting complexity

Compare regularized score/efficiency models, schedule-aware team ratings, hierarchical player/team models and boosted-tree candidates. Perform chronological walk-forward validation with separate season/regime diagnostics. Fit preprocessing, tuning, feature selection and calibration inside folds. Keep the final season or final time block untouched. The included player-lag artifact is for 2026; regenerate earlier-season/fold features from the supplied native box scores with scripts/build_features.py as needed. Use stronger time guards than simple tipoff ordering where publication chronology is available; do not claim a certified point-in-time backtest from missing historical known_at.

Evaluate probability forecasts with log loss, Brier score, reliability by probability band and sample counts. Evaluate score/count distributions with suitable proper scores, interval coverage and residual checks. Compare simple home/away and market baselines, perform ablations and account for model selection/multiple testing. Do not choose a model because its backtested ROI happens to be highest. Report uncertainty clustered by game/team/time and fragile conference/sample segments. Include sensitivity to lineup reconstructions and disputed records.

## 6. Price the exact market, then allow PASS

Implement an adapter for timestamped executable bookmaker quotes and book-specific rules: game, market, participant, side, line, decimal odds, quote/receipt times, suspension, limits, overtime, pushes, voids and listed-player rules. Keep independent projections separate from market-anchored forecasts. Apply explicit vig removal and calculate expected return with win/push/void probabilities, not a generic edge formula. Player props require a separately validated opportunity/count model; a game moneyline model does not validate props.

Rank only eligible markets with fresh prices, adequate data, valid identity, required confirmed availability, calibrated forecasts, robust uncertainty-adjusted expected return and exact settlement support. Return PASS when those conditions fail; never force a best bet or invent probabilities from missing odds. No wager placement. Optional staking must be capped and account for correlated game/player exposure.

## 7. Implement, test and finish

Add meaningful tests for provider namespaces, duplicates, season/date handling, non-D1/neutral context, target/future leakage, missed-shot score_value, two-half/OT clocks, unknown QA flags, zero-minute rates, transfers, stale odds, pushes/voids and PASS gates. Provide a runnable local example using these actual tables and a refresh command. If licensed/current feeds or credentials are missing, implement the adapter contract and list the exact blocker; do not fabricate records.

Finish with code changed, actual tables/coverage loaded, test results, baseline validation results, refresh/run commands and which markets remain blocked with specific reasons. Make my implementation work before presenting conclusions. Do not claim private proprietary methods, guaranteed profit, or successful validation that was not performed.

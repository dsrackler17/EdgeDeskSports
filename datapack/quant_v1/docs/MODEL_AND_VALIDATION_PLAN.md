# Models these datasets can support after completion

These are candidate architectures, not trained models or certified betting edges.

- NHL: regularized shot-level goal model with heldout calibration; strength-state team scoring rates; goalie adjustment learned with shrinkage; regulation goals plus explicit OT/shootout state model. Do not use a tied regulation goal model directly for overtime-inclusive moneylines.
- NFL/CFB: separate opponent-adjusted EPA and opportunity models, QB/availability effects, and joint margin/total or drive scoring distributions. Preserve key-number mass and non-Gaussian tails. NCAA talent/context is not an NFL clone.
- Basketball: separate league possession models and regularized team/player strength; uncertain minutes and availability scenarios; possession-based score simulation with correlated pace. Props need opportunity-plus-efficiency models and role validation.
- MLB: pitcher/batter matchup distributions, lineup slots and platoons, starting pitcher length, bullpen availability and park/weather; simulate inning/base-out transitions. NCAA baseball needs its own priors and accessible data, not invented Statcast fields.
- Soccer: dynamic attack/defense scoring model; evaluate low-score dependence correction, xG form and lineup effects; separately represent regulation and extra time.
- Tennis: surface-adjusted serve/return probabilities, game/set/match state transitions and separately tested fitness/retirement treatment. Preserve scoring format and tour differences.
- MMA: regularized opponent-adjusted striking/grappling and conditional finish hazards; weight/age/layoff effects; scheduled-round and decision components. Later-round absence from early finishes is censoring.

Train using expanding or rolling chronological folds, tune only within past folds, and reserve the latest untouched period. Feature selection, opponent ratings, normalization, imputation, shrinkage, and calibration must be fit on past data only. Provider model inputs may require re-training or frozen archival versions to certify point-in-time evaluation.

Evaluate Brier score, log loss and reliability curves for probability markets; predictive interval coverage and full-distribution scoring for margins/totals; simple rating/league baselines; a separate no-vig market benchmark when contemporaneous prices exist. Distinguish market-anchored and independent forecasts.

Betting tests require actual available timestamped prices, limits, settlement and costs. No odds means no ROI/CLV claim. Report sample sizes and cluster uncertainty by event/team/date as appropriate. Multiple markets on one game are not independent trials. Correct for selection bias when searching thousands of edges. Holdouts used to choose a sport/model are no longer untouched.

Cross-sport ranking may consider lower-confidence-bound EV, model calibration and uncertainty, freshness, market availability and portfolio correlation; do not compare arbitrary confidence badges or raw EV from unvalidated models. PASS is an allowed result. No model in this ZIP has been trained or validated for live betting.

Methodology references (primary sources):

- nflfastR expected points/probability modeling: https://opensourcefootball.com/posts/2020-09-28-nflfastr-ep-wp-and-cp-models/ and https://nflfastr.com/reference/calculate_expected_points.html
- MoneyPuck model overview and access conditions: https://www.moneypuck.com/about.htm and https://moneypuck.com/data.htm
- Statcast field definitions: https://baseballsavant.mlb.com/csv-docs
- NBA glossary: https://www.nba.com/stats/help/glossary
- Dixon & Coles (1997), score modeling: https://doi.org/10.1111/1467-9876.00065
- O'Malley (2008), tennis probability/state formulas: https://doi.org/10.2202/1559-0410.1100
- StatsBomb expected-goal modeling: https://statsbomb.com/articles/soccer/upgrading-expected-goals/

These support the study of published methods, not copying proprietary systems or claiming any source's performance as EdgeDesk's.

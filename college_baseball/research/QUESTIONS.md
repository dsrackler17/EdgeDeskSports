# Research questions

The questions this build set out to answer, in the order the specification
asks them. Each points at the artifact that answers it; none is answered here
in prose that could drift from the evidence.

| # | Question | Answered by | State |
|---|---|---|---|
| Q-01 | Which Division I programs and games exist, per season, and how completely does an authorised source cover them? | `validation/coverage.json`, `research/COVERAGE.md` | ANSWERED (2023 results end 2023-03-28 in the source) |
| Q-02 | Where do sources disagree, and which value is right? | `validation/data_quality.json`, `research/DATA_QUALITY.md` | ANSWERED; 201 contests quarantined |
| Q-03 | Which rules actually govern a college game (length, run rule, extra innings, who bats last)? | `validation/rules_evidence.json`, `lib/rules.js` | ANSWERED by measurement; per-conference run rules OPEN (U-04) |
| Q-04 | How strong is each team, opponent-adjusted, with honest uncertainty? | `lib/team_quality.js`, `validation/walkforward.json` | ANSWERED |
| Q-05 | Does any rating beat simple baselines (home rate, Elo, Pythagenpat, Massey, Bradley-Terry) out of sample? | `validation/walkforward.json`, registry CBX-TEAM-WALKFORWARD | ANSWERED |
| Q-06 | What distribution do college runs follow, and how dependent are the two sides? | `validation/run_distribution.json`, CBX-DIST-FAMILY | ANSWERED: negative binomial, weak dependence |
| Q-07 | Does an inning-level simulator price the markets the closed form cannot? | `validation/simulator.json`, CBX-SIMULATOR | ANSWERED |
| Q-08 | Do starters, bullpen availability and workload improve the price? | `validation/pitcher_walkforward.json`, CBX-PITCHER-HYBRID | ANSWERED: not significantly on 2025 |
| Q-09 | Can the starter be projected when none is announced, and how well? | `validation/pitcher_walkforward.json` (starter_projection) | ANSWERED: ~53% top-1, calibrated |
| Q-10 | Do offense components, defence and rest add to the team model? | `validation/feature_research.json`, CBX-H-* | ANSWERED: offense and rest yes, defence no |
| Q-11 | Do machine-learning models or an ensemble beat the chosen model? | `validation/ml_ensemble.json`, CBX-ML-*, CBX-ENSEMBLE | ANSWERED |
| Q-12 | Which components actually matter? | `validation/ablations.json`, CBX-ABLATE-* | ANSWERED |
| Q-13 | Does the chosen model hold up on seasons it never saw? | the HOLDOUT section of `validation/walkforward.json`, CBX-TEAM-HOLDOUT | ANSWERED once per model version |
| Q-14 | Does the model beat the betting market? | — | BLOCKED: no authorised college-baseball odds feed (U-02) |
| Q-15 | May the output be shown commercially? | `research/LICENSING.md`, gate G1 | OWNER DECISION (U-01) |

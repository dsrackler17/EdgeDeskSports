# Modelling hypotheses

Each hypothesis was written before its test and maps to a registry experiment
(`EXPERIMENTS.md`, generated). Outcomes are in the registry, not here, so this
page can never disagree with the evidence.

| Id | Hypothesis | Test | Registry |
|---|---|---|---|
| H-TEAM-1 | Opponent-adjusted runs (Poisson attack/defence) beat results-only ratings (Elo, Bradley-Terry) | walk-forward, SELECTION choice, VALIDATION bootstrap | CBX-TUNE-*, walkforward.json |
| H-TEAM-2 | Partial pooling of teams toward their conference (and conferences toward their division) beats flat shrinkage, because schedules are unequal and weakly connected | hier vs poisson_flat, and the hierarchy ablation | CBX-ABLATE-HIERARCHY |
| H-TEAM-3 | Shrunk park effects improve predictions | park ablation | CBX-ABLATE-PARKS |
| H-TEAM-4 | Last season's strength carries over (regressed) | carryover ablation; tuned carry | CBX-ABLATE-CARRYOVER |
| H-TEAM-5 | Integrating over rating uncertainty improves calibration early in a season and for weakly connected teams | uncertainty ablation; early-season slice | CBX-ABLATE-UNCERTAINTY-INTEGRATION |
| H-TEAM-6 | A run-space calibration fitted on prior seasons fixes home under-prediction without breaking market coherence | hier vs hier_cal; calibration ablation | walkforward.json, CBX-ABLATE-PRIOR-SEASON-CALIBRATION-MAP |
| H-DIST-1 | Team runs are overdispersed; negative binomial beats Poisson; shared frailty adds little | run_distribution.json | CBX-DIST-FAMILY |
| H-SIM-1 | An inning-level simulator with measured shapes prices run lines and first-five markets at least as well as the closed form | sim_eval.json | CBX-SIMULATOR |
| H-RULE-1 | Seven-inning doubleheader games score fewer runs and must be priced as seven | rules evidence; the doubleheader mixture ablation | CBX-ABLATE-SEVEN-INNING-MIXTURE |
| H-PIT-1 | The projected starter and today's available bullpen improve the moneyline over the team model | pitcher walk-forward, 2025 | CBX-PITCHER-HYBRID |
| H-PIT-2 | Starter confirmation is worth measurable log loss (oracle vs projected) | pitcher walk-forward | CBX-PITCHER-HYBRID (uncertainty) |
| H-OFF-1 | Component offense with college linear weights adds to the runs-based team model | feature_research.json | CBX-H-OFF-1 |
| H-DEF-1 | Defensive box-score metrics predict runs allowed beyond the team model | feature_research.json | CBX-H-DEF-1 |
| H-ENV-1 | Playing yesterday and doubleheader game 2 change scoring beyond the team model | feature_research.json | CBX-H-ENV-1 |
| H-ML-1 | Regularised GLM / gradient boosting on pregame features beat the chosen model | ml_ensemble.json | CBX-ML-GLM, CBX-ML-GBM |
| H-ENS-1 | A stacked ensemble of calibrated base models beats the best single model | ml_ensemble.json | CBX-ENSEMBLE |

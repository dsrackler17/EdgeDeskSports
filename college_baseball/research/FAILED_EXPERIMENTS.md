# Failed and inconclusive experiments (generated)

Every hypothesis that did not earn its place, with the evidence. Nothing is deleted: a later revision that changes a decision appears in `EXPERIMENTS.md` and both revisions stay in the registry.

## CBX-ABLATE-SEVEN-INNING-MIXTURE — Ablation: team model without seven inning mixture

- **Hypothesis:** The seven inning mixture improves VALIDATION log loss of the team model
- **Decision:** INCONCLUSIVE (revision 1, 2026-10-14, commit a903b91c28)
- **Why:** NO MEASURABLE VALUE
- **Metrics:** `{"full":0.59705,"ablated":0.59704}`
- **Uncertainty:** `{"diff":-0.000008,"ci95":[-0.00002,0.000005]}`

## CBX-ABLATE-UNCERTAINTY-INTEGRATION — Ablation: team model without uncertainty integration

- **Hypothesis:** The uncertainty integration improves VALIDATION log loss of the team model
- **Decision:** REJECT (revision 1, 2026-10-14, commit a903b91c28)
- **Why:** REMOVAL IMPROVES
- **Metrics:** `{"full":0.59705,"ablated":0.59676}`
- **Uncertainty:** `{"diff":-0.000285,"ci95":[-0.000424,-0.000147]}`

## CBX-ENSEMBLE — ensemble on base-model OOS predictions + context

- **Hypothesis:** ensemble improves VALIDATION moneyline log loss over the chosen single model
- **Decision:** REJECT (revision 2, 2026-10-14, commit a903b91c28)
- **Why:** the 95% interval of the VALIDATION log-loss difference vs the chosen model is not wholly below zero
- **Metrics:** `{"validation":{"n":11950,"log_loss":0.59346,"brier":0.20466,"citl":0.0018,"slope":0.984},"chosen":{"n":11950,"log_loss":0.59375,"brier":0.20471,"citl":-0.0021,"slope":1.008}}`
- **Uncertainty:** `{"n":11950,"blocks":158,"mean_diff":-0.000292,"ci95":[-0.000871,0.000297],"a_better":false,"b_better":false}`

## CBX-H-DEF-1 — Defensive metrics beyond the team model

- **Hypothesis:** Season-to-date errors, unearned-run share, double plays, catcher SB control and DER predict runs allowed beyond the team model
- **Decision:** REJECT (revision 2, 2026-10-14, commit a903b91c28)
- **Why:** no out-of-sample improvement with a 95% interval below zero; the feature group is not used in prices
- **Metrics:** `{"team":2.78177,"team_plus_defence":2.78163}`
- **Uncertainty:** `{"n":15022,"blocks":114,"mean_diff":-0.000147,"ci95":[-0.001234,0.000812],"a_better":false,"b_better":false}`

## CBX-ML-GBM — gbm on base-model OOS predictions + context

- **Hypothesis:** gbm improves VALIDATION moneyline log loss over the chosen single model
- **Decision:** REJECT (revision 3, 2026-10-19, commit dc472d5257)
- **Why:** the 95% interval of the VALIDATION log-loss difference vs the chosen model is not wholly below zero
- **Metrics:** `{"validation":{"n":11950,"log_loss":0.59424,"brier":0.2049,"citl":0.0007,"slope":1.023},"chosen":{"n":11950,"log_loss":0.59375,"brier":0.20471,"citl":-0.0021,"slope":1.008}}`
- **Uncertainty:** `{"n":11950,"blocks":158,"mean_diff":0.000482,"ci95":[-0.000536,0.001567],"a_better":false,"b_better":false}`

## CBX-ML-GLM — glm on base-model OOS predictions + context

- **Hypothesis:** glm improves VALIDATION moneyline log loss over the chosen single model
- **Decision:** REJECT (revision 2, 2026-10-14, commit a903b91c28)
- **Why:** the 95% interval of the VALIDATION log-loss difference vs the chosen model is not wholly below zero
- **Metrics:** `{"validation":{"n":11950,"log_loss":0.59367,"brier":0.20475,"citl":0.0015,"slope":0.984},"chosen":{"n":11950,"log_loss":0.59375,"brier":0.20471,"citl":-0.0021,"slope":1.008}}`
- **Uncertainty:** `{"n":11950,"blocks":158,"mean_diff":-0.000082,"ci95":[-0.000821,0.000676],"a_better":false,"b_better":false}`

## CBX-PITCHER-HYBRID — Pitcher-aware hybrid (starter projection + bullpen availability) vs team model

- **Hypothesis:** Adjusting the team model for the projected starter and today's available bullpen lowers moneyline log loss on SELECTION 2025
- **Decision:** REJECT (revision 4, 2026-10-19, commit dc472d5257)
- **Why:** the interval of the improvement vs the team model is not wholly below zero on SELECTION; the team model stays the price
- **Metrics:** `{"team":0.596,"bullpen":0.59596,"starter_proj":0.59572,"hybrid_proj":0.59568,"hybrid_oracle":0.59499}`
- **Uncertainty:** `{"hybrid_proj_vs_team":{"n":8363,"blocks":117,"mean_diff":-0.000326,"ci95":[-0.000731,0.000064],"a_better":false,"b_better":false},"oracle_vs_proj":{"n":8363,"blocks":117,"mean_diff":-0.000691,"ci95":[-0.001215,-0.000…`

## CBX-PITCHER-HYBRID-HOLDOUT — Pitcher-aware hybrid on HOLDOUT 2026

- **Hypothesis:** The SELECTION result holds on the untouched 2026 season
- **Decision:** INCONCLUSIVE (revision 1, 2026-10-14, commit e24dd96032)
- **Why:** reported once for this model version
- **Metrics:** `{"team":0.60914,"bullpen":0.60904,"starter_proj":0.60888,"hybrid_proj":0.60878,"hybrid_oracle":0.60847}`
- **Uncertainty:** `{"hybrid_proj_vs_team":{"n":8333,"blocks":117,"mean_diff":-0.00036,"ci95":[-0.000712,0.000038],"a_better":false,"b_better":false}}`

## CBX-SIMULATOR — Inning-level simulator vs closed-form run distribution

- **Hypothesis:** An inning-level simulator with measured half-inning shapes, walk-offs and rules prices run lines and first-five markets at least as well as the closed form, without losing moneyline or total accuracy
- **Decision:** REJECT (revision 4, 2026-10-19, commit dc472d5257)
- **Why:** the simulator loses accuracy on full-game markets against the closed form (comparisons in uncertainty), so it does not price them; it remains the only first-five engine (CBX-SIMULATOR-F5)
- **Metrics:** `{"moneyline_log_loss":{"closed_form":0.6082,"simulator":0.60923,"simulator_on_calibrated_inputs":0.61413},"total_log_score":{"closed_form":3.21974,"simulator":3.2794,"simulator_on_calibrated_inputs":3.2844},"run_line_…`
- **Uncertainty:** `{"moneyline_cf_vs_sim":{"n":4240,"blocks":119,"mean_diff":-0.001031,"ci95":[-0.00253,0.000323],"a_better":false,"b_better":false},"total_cf_vs_sim":{"n":4240,"blocks":119,"mean_diff":-0.059666,"ci95":[-0.090433,-0.031…`

## CBX-SIMULATOR-F5 — First-five-inning prices from the simulator

- **Hypothesis:** The simulator's first-five home-win and tie probabilities are calibrated (|calibration-in-the-large| <= 0.03, slope 0.75-1.33)
- **Decision:** REJECT (revision 2, 2026-10-19, commit dc472d5257)
- **Why:** outside the calibration tolerance
- **Metrics:** `{"home_win":{"n":4240,"log_loss":0.6584,"brier":0.23253,"citl":0.0028,"slope":0.748},"tie":{"n":4240,"log_loss":0.33508,"brier":0.09359,"citl":-0.0075,"slope":0.486},"max_mc_se":0.0112}`
- **Uncertainty:** `{"convergence":[{"n":1000,"mean_f5_home":0.5323,"seed_spread":0.065,"theoretical_se":0.0158},{"n":5000,"mean_f5_home":0.5195,"seed_spread":0.0154,"theoretical_se":0.0071},{"n":20000,"mean_f5_home":0.5224,"seed_spread"…`

## Revisions (a result that changed)

- CBX-TUNE-ELO revision 2 (2026-10-14T01:20): decision ACCEPT
- CBX-TUNE-PYTHAG revision 2 (2026-10-14T01:20): decision ACCEPT
- CBX-TUNE-ELO revision 3 (2026-10-14T01:46): decision ACCEPT
- CBX-TUNE-PYTHAG revision 3 (2026-10-14T01:46): decision ACCEPT
- CBX-DIST-FAMILY revision 2 (2026-10-14T01:57): decision ACCEPT
- CBX-TUNE-HIER revision 2 (2026-10-14T01:58): decision ACCEPT
- CBX-DIST-FAMILY revision 3 (2026-10-14T01:59): decision ACCEPT
- CBX-TUNE-POISSON_FLAT revision 2 (2026-10-14T02:01): decision ACCEPT
- CBX-TUNE-MASSEY revision 2 (2026-10-14T02:05): decision ACCEPT
- CBX-TUNE-BT revision 2 (2026-10-14T02:11): decision ACCEPT
- CBX-TUNE-HIER revision 3 (2026-10-14T02:16): decision ACCEPT
- CBX-TUNE-ELO revision 4 (2026-10-14T02:21): decision ACCEPT
- CBX-TUNE-MASSEY revision 3 (2026-10-14T02:26): decision ACCEPT
- CBX-TUNE-POISSON_FLAT revision 3 (2026-10-14T02:29): decision ACCEPT
- CBX-DIST-FAMILY revision 4 (2026-10-14T02:34): decision ACCEPT
- CBX-TEAM-WALKFORWARD revision 2 (2026-10-14T02:38): decision ACCEPT
- CBX-PITCHER-HYBRID revision 2 (2026-10-14T02:39): decision REJECT
- CBX-ML-GLM revision 2 (2026-10-14T02:40): decision REJECT
- CBX-ML-GBM revision 2 (2026-10-14T02:40): decision REJECT
- CBX-ENSEMBLE revision 2 (2026-10-14T02:40): decision REJECT
- CBX-H-OFF-1 revision 2 (2026-10-14T02:40): decision ACCEPT
- CBX-H-DEF-1 revision 2 (2026-10-14T02:40): decision REJECT
- CBX-H-ENV-1 revision 2 (2026-10-14T02:40): decision ACCEPT
- CBX-SIMULATOR revision 2 (2026-10-14T02:51): decision REJECT
- CBX-PITCHER-HYBRID revision 3 (2026-10-14T02:57): decision REJECT
- CBX-SIMULATOR revision 3 (2026-10-14T03:02): decision REJECT
- CBX-PRICING-ENGINE revision 2 (2026-10-14T03:02): decision ACCEPT
- CBX-PITCHER-HYBRID revision 4 (2026-10-19T19:00): decision REJECT
- CBX-SIMULATOR revision 4 (2026-10-19T19:02): decision REJECT
- CBX-PRICING-ENGINE revision 3 (2026-10-19T19:02): decision ACCEPT
- CBX-SIMULATOR-F5 revision 2 (2026-10-19T19:02): decision REJECT
- CBX-ML-GBM revision 3 (2026-10-19T19:02): decision REJECT


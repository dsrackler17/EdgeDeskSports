# NCAAW forecast validation (generated)

Generated 2026-10-24T04:48:25.041Z by `basketball/ncaaw_forecast/validate.js` from the committed data; selection 48e6afca2753bd73. Retrospective: results are retrieved after the fact and assumed known 4 h after tip.

## development (D1 vs D1, n = 24648)

| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |
|---|---|---|---|---|---|---|---|---|
| **champion candidate** | 24648 | 0.47611 | 0.15806 | 6.8804 | 9.711 | 0.8180 | 9.3237 | 0.8063 |
| incumbent_as_served | 24648 | 0.48309 | 0.16038 | 7.0215 | 9.889 | 0.8240 | 9.3952 | 0.8173 |
| incumbent_ratings | 24648 | 0.48315 | 0.16032 | 6.9873 | 9.845 | 0.8085 | 9.3925 | 0.8014 |
| elo | 24648 | 0.51655 | 0.17230 | — | — | — | — | — |
| home_only | 24648 | 0.67619 | 0.24157 | — | — | — | — | — |
| ablation_no_preseason_prior | 24648 | 0.50282 | 0.16798 | 7.3557 | 10.352 | 0.8212 | 9.3666 | 0.8061 |
| ablation_constant_width | 24648 | 0.47664 | 0.15821 | 6.8847 | 9.711 | 0.8184 | 9.3245 | 0.8034 |
| ablation_no_endgame_tie_factor | 24648 | 0.47594 | 0.15802 | 6.8834 | 9.715 | 0.8204 | 9.3209 | 0.8034 |
| ablation_engine_parameter_variance | 24648 | 0.47639 | 0.15817 | 6.8835 | 9.711 | 0.8159 | 9.3235 | 0.8027 |

Paired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):

| Versus | Log loss | Margin CRPS |
|---|---|---|
| incumbent_as_served | -0.00699 [-0.00923, -0.00500] | -0.14104 [-0.16926, -0.11804] |
| incumbent_ratings | -0.00704 [-0.00910, -0.00523] | -0.10686 [-0.13487, -0.08444] |
| elo | -0.04044 [-0.04420, -0.03662] | — |
| home_only | -0.20009 [-0.20622, -0.19372] | — |
| ablation_no_preseason_prior | -0.02671 [-0.03108, -0.02225] | -0.47533 [-0.56558, -0.39415] |
| ablation_constant_width | -0.00053 [-0.00080, -0.00022] | -0.00433 [-0.00613, -0.00267] |
| ablation_no_endgame_tie_factor | 0.00017 [0.00007, 0.00027] | -0.00303 [-0.00434, -0.00172] |
| ablation_engine_parameter_variance | -0.00028 [-0.00068, 0.00020] | -0.00308 [-0.00520, -0.00102] |

## confirmation (D1 vs D1, n = 21695)

| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |
|---|---|---|---|---|---|---|---|---|
| **champion candidate** | 21695 | 0.46582 | 0.15473 | 6.8727 | 9.679 | 0.8020 | 9.0777 | 0.8015 |
| incumbent_as_served | 21695 | 0.47037 | 0.15606 | 7.0628 | 9.909 | 0.8346 | 9.1402 | 0.8110 |
| incumbent_ratings | 21695 | 0.47027 | 0.15598 | 7.0181 | 9.846 | 0.8068 | 9.1453 | 0.8032 |
| elo | 21695 | 0.51086 | 0.17031 | — | — | — | — | — |
| home_only | 21695 | 0.67285 | 0.23992 | — | — | — | — | — |
| ablation_no_preseason_prior | 21695 | 0.48961 | 0.16330 | 7.3964 | 10.402 | 0.7935 | 9.1065 | 0.8009 |
| ablation_constant_width | 21695 | 0.46645 | 0.15486 | 6.8801 | 9.679 | 0.8079 | 9.0787 | 0.8025 |
| ablation_no_endgame_tie_factor | 21695 | 0.46567 | 0.15470 | 6.8725 | 9.680 | 0.8045 | 9.0763 | 0.7975 |
| ablation_engine_parameter_variance | 21695 | 0.46636 | 0.15483 | 6.8786 | 9.679 | 0.8073 | 9.0790 | 0.8023 |

Paired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):

| Versus | Log loss | Margin CRPS |
|---|---|---|
| incumbent_as_served | -0.00455 [-0.00661, -0.00276] | -0.19007 [-0.21772, -0.16228] |
| incumbent_ratings | -0.00445 [-0.00639, -0.00274] | -0.14534 [-0.17752, -0.11604] |
| elo | -0.04505 [-0.04950, -0.04100] | — |
| home_only | -0.20703 [-0.21367, -0.19988] | — |
| ablation_no_preseason_prior | -0.02379 [-0.02965, -0.01858] | -0.52372 [-0.64724, -0.40966] |
| ablation_constant_width | -0.00063 [-0.00113, -0.00011] | -0.00736 [-0.01017, -0.00482] |
| ablation_no_endgame_tie_factor | 0.00015 [0.00003, 0.00027] | 0.00018 [-0.00118, 0.00152] |
| ablation_engine_parameter_variance | -0.00054 [-0.00100, -0.00010] | -0.00586 [-0.00849, -0.00352] |

## tournament_holdout (D1 vs D1, n = 201)

| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |
|---|---|---|---|---|---|---|---|---|
| **champion candidate** | 201 | 0.34865 | 0.11359 | 6.8266 | 9.526 | 0.7811 | 8.5876 | 0.8209 |
| incumbent_as_served | 201 | 0.35791 | 0.11633 | 6.9234 | 9.684 | 0.8557 | 8.5476 | 0.8607 |
| incumbent_ratings | 201 | 0.36169 | 0.11743 | 7.0113 | 9.764 | 0.8209 | 8.5674 | 0.8308 |
| elo | 201 | 0.45783 | 0.14896 | — | — | — | — | — |
| home_only | 201 | 0.62167 | 0.21475 | — | — | — | — | — |
| ablation_no_preseason_prior | 201 | 0.35468 | 0.11614 | 6.9889 | 9.717 | 0.7214 | 8.6002 | 0.8109 |
| ablation_constant_width | 201 | 0.35336 | 0.11451 | 6.8294 | 9.527 | 0.8060 | 8.5923 | 0.8209 |
| ablation_no_endgame_tie_factor | 201 | 0.34736 | 0.11332 | 6.8121 | 9.509 | 0.7811 | 8.5674 | 0.8109 |
| ablation_engine_parameter_variance | 201 | 0.35290 | 0.11442 | 6.8286 | 9.527 | 0.8060 | 8.5915 | 0.8209 |

Paired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):

| Versus | Log loss | Margin CRPS |
|---|---|---|
| incumbent_as_served | -0.00925 [-0.01883, -0.00081] | -0.09684 [-0.26959, 0.10385] |
| incumbent_ratings | -0.01304 [-0.02245, -0.00445] | -0.18477 [-0.31115, -0.04274] |
| elo | -0.10918 [-0.14307, -0.06779] | — |
| home_only | -0.27301 [-0.31124, -0.22355] | — |
| ablation_no_preseason_prior | -0.00603 [-0.01521, 0.00547] | -0.16231 [-0.31020, 0.01160] |
| ablation_constant_width | -0.00471 [-0.00649, -0.00291] | -0.00280 [-0.02107, 0.01558] |
| ablation_no_endgame_tie_factor | 0.00129 [0.00056, 0.00205] | 0.01443 [-0.00079, 0.03135] |
| ablation_engine_parameter_variance | -0.00425 [-0.00589, -0.00261] | -0.00206 [-0.01835, 0.01464] |

## Upset Watch (policy 3d47dfc5aafb, theta 0.36)

| Window | Games | Flagged | Coverage | Mean forecast | Realized | 95% CI |
|---|---|---|---|---|---|---|
| development | 24648 | 4386 | 0.1779 | 0.4050 | 0.4001 | 0.3857–0.4147 |
| confirmation | 21695 | 3753 | 0.1730 | 0.4048 | 0.4143 | 0.3987–0.4302 |
| tournament_holdout_model_basis | 201 | 31 | 0.1542 | 0.4090 | 0.4516 | 0.2916–0.6223 |

Tournament holdout, seed basis: lower seed won 28 of 184 (0.1522, 95% CI 0.1074–0.2111); mean forecast 0.2154.

## Tournament games vs neutral regular-season games (development tournaments)

NCAA tournament: n 323, log loss 0.44529, margin CRPS 7.0929. Neutral regular season: n 1298, log loss 0.49926, margin CRPS 7.1963.


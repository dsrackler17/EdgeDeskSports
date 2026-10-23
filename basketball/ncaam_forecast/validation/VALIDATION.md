# NCAAM forecast validation (generated)

Generated 2026-10-23T12:51:15.106Z by `basketball/ncaam_forecast/validate.js` from the committed data; selection 7807a94ff33649c6. Retrospective: results are retrieved after the fact and assumed known 4 h after tip.

## development (D1 vs D1, n = 43886)

| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |
|---|---|---|---|---|---|---|---|---|
| **champion candidate** | 43886 | 0.51782 | 0.17409 | 6.1701 | 8.672 | 0.8034 | 9.5902 | 0.7999 |
| incumbent_as_served | 43886 | 0.52452 | 0.17635 | 6.3059 | 8.847 | 0.8290 | 9.6502 | 0.8145 |
| incumbent_ratings | 43886 | 0.52441 | 0.17631 | 6.2617 | 8.797 | 0.8001 | 9.6429 | 0.8011 |
| elo | 43886 | 0.54168 | 0.18208 | — | — | — | — | — |
| home_only | 43886 | 0.65100 | 0.22926 | — | — | — | — | — |
| ablation_no_preseason_prior | 43886 | 0.54098 | 0.18263 | 6.5054 | 9.134 | 0.8040 | 9.6159 | 0.8007 |
| ablation_constant_width | 43886 | 0.51791 | 0.17412 | 6.1723 | 8.672 | 0.8035 | 9.5907 | 0.8014 |
| ablation_no_endgame_tie_factor | 43886 | 0.51763 | 0.17404 | 6.1716 | 8.674 | 0.8073 | 9.5978 | 0.7941 |
| ablation_engine_parameter_variance | 43886 | 0.51800 | 0.17413 | 6.1723 | 8.672 | 0.8033 | 9.5908 | 0.8010 |

Paired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):

| Versus | Log loss | Margin CRPS |
|---|---|---|
| incumbent_as_served | -0.00670 [-0.00817, -0.00530] | -0.13574 [-0.15072, -0.12076] |
| incumbent_ratings | -0.00659 [-0.00793, -0.00530] | -0.09151 [-0.10658, -0.07770] |
| elo | -0.02386 [-0.02603, -0.02167] | — |
| home_only | -0.13317 [-0.13769, -0.12898] | — |
| ablation_no_preseason_prior | -0.02316 [-0.02678, -0.01968] | -0.33522 [-0.39336, -0.28403] |
| ablation_constant_width | -0.00009 [-0.00026, 0.00012] | -0.00216 [-0.00315, -0.00116] |
| ablation_no_endgame_tie_factor | 0.00020 [0.00007, 0.00032] | -0.00147 [-0.00285, -0.00015] |
| ablation_engine_parameter_variance | -0.00018 [-0.00036, 0.00002] | -0.00213 [-0.00310, -0.00112] |

## confirmation (D1 vs D1, n = 37450)

| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |
|---|---|---|---|---|---|---|---|---|
| **champion candidate** | 37450 | 0.53565 | 0.18133 | 6.4277 | 9.048 | 0.8009 | 9.4014 | 0.7981 |
| incumbent_as_served | 37449 | 0.54408 | 0.18429 | 6.6405 | 9.338 | 0.8295 | 9.4609 | 0.8124 |
| incumbent_ratings | 37449 | 0.54371 | 0.18415 | 6.5559 | 9.215 | 0.8049 | 9.4600 | 0.8003 |
| elo | 37449 | 0.55841 | 0.18934 | — | — | — | — | — |
| home_only | 37450 | 0.65643 | 0.23189 | — | — | — | — | — |
| ablation_no_preseason_prior | 37450 | 0.55771 | 0.18954 | 6.7822 | 9.534 | 0.7982 | 9.4110 | 0.7997 |
| ablation_constant_width | 37450 | 0.53571 | 0.18138 | 6.4308 | 9.048 | 0.8041 | 9.4022 | 0.7983 |
| ablation_no_endgame_tie_factor | 37450 | 0.53550 | 0.18130 | 6.4297 | 9.051 | 0.8060 | 9.4052 | 0.7922 |
| ablation_engine_parameter_variance | 37450 | 0.53571 | 0.18138 | 6.4306 | 9.048 | 0.8043 | 9.4020 | 0.7982 |

Paired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):

| Versus | Log loss | Margin CRPS |
|---|---|---|
| incumbent_as_served | -0.00844 [-0.00999, -0.00695] | -0.21280 [-0.23341, -0.19408] |
| incumbent_ratings | -0.00807 [-0.00948, -0.00669] | -0.12817 [-0.14534, -0.11089] |
| elo | -0.02277 [-0.02528, -0.02038] | — |
| home_only | -0.12079 [-0.12529, -0.11596] | — |
| ablation_no_preseason_prior | -0.02207 [-0.02626, -0.01831] | -0.35453 [-0.42013, -0.29606] |
| ablation_constant_width | -0.00007 [-0.00032, 0.00020] | -0.00307 [-0.00441, -0.00171] |
| ablation_no_endgame_tie_factor | 0.00015 [0.00003, 0.00026] | -0.00200 [-0.00345, -0.00059] |
| ablation_engine_parameter_variance | -0.00006 [-0.00029, 0.00020] | -0.00292 [-0.00421, -0.00163] |

## tournament_holdout (D1 vs D1, n = 199)

| Candidate | n | Log loss | Brier | Margin CRPS | Margin MAE | 80% margin cov. | Total CRPS | 80% total cov. |
|---|---|---|---|---|---|---|---|---|
| **champion candidate** | 199 | 0.48938 | 0.16518 | 6.6739 | 9.534 | 0.7538 | 8.9103 | 0.8191 |
| incumbent_as_served | 199 | 0.49255 | 0.16512 | 6.5656 | 9.354 | 0.8543 | 8.9386 | 0.8291 |
| incumbent_ratings | 199 | 0.49564 | 0.16613 | 6.8024 | 9.754 | 0.7789 | 8.9369 | 0.8291 |
| elo | 199 | 0.56486 | 0.19154 | — | — | — | — | — |
| home_only | 199 | 0.69315 | 0.25000 | — | — | — | — | — |
| ablation_no_preseason_prior | 199 | 0.49488 | 0.16660 | 6.9635 | 9.970 | 0.6935 | 8.9305 | 0.8141 |
| ablation_constant_width | 199 | 0.49129 | 0.16555 | 6.6623 | 9.535 | 0.7889 | 8.9110 | 0.8291 |
| ablation_no_endgame_tie_factor | 199 | 0.48867 | 0.16504 | 6.6514 | 9.505 | 0.7638 | 8.8749 | 0.8141 |
| ablation_engine_parameter_variance | 199 | 0.49118 | 0.16553 | 6.6626 | 9.535 | 0.7889 | 8.9108 | 0.8291 |

Paired differences (champion candidate minus other; negative = candidate better; 95% CI, day-clustered bootstrap):

| Versus | Log loss | Margin CRPS |
|---|---|---|
| incumbent_as_served | -0.00317 [-0.01257, 0.00768] | 0.10839 [-0.02214, 0.23182] |
| incumbent_ratings | -0.00626 [-0.01712, 0.00639] | -0.12845 [-0.24494, 0.01144] |
| elo | -0.07548 [-0.11429, -0.03187] | — |
| home_only | -0.20377 [-0.25749, -0.13965] | — |
| ablation_no_preseason_prior | -0.00550 [-0.01618, 0.00790] | -0.28953 [-0.48699, -0.06836] |
| ablation_constant_width | -0.00191 [-0.00406, 0.00029] | 0.01169 [-0.00232, 0.02535] |
| ablation_no_endgame_tie_factor | 0.00071 [-0.00069, 0.00213] | 0.02258 [0.00473, 0.03933] |
| ablation_engine_parameter_variance | -0.00180 [-0.00384, 0.00030] | 0.01138 [-0.00197, 0.02448] |

## Upset Watch (policy 9bfb69623f4e, theta 0.37)

| Window | Games | Flagged | Coverage | Mean forecast | Realized | 95% CI |
|---|---|---|---|---|---|---|
| development | 43886 | 8109 | 0.1848 | 0.4100 | 0.4055 | 0.3948–0.4162 |
| confirmation | 37450 | 7436 | 0.1986 | 0.4099 | 0.4092 | 0.3981–0.4204 |
| tournament_holdout_model_basis | 199 | 42 | 0.2111 | 0.4187 | 0.3810 | 0.2500–0.5319 |

Tournament holdout, seed basis: lower seed won 46 of 182 (0.2527, 95% CI 0.1952–0.3205); mean forecast 0.2679.

## Tournament games vs neutral regular-season games (development tournaments)

NCAA tournament: n 800, log loss 0.56512, margin CRPS 6.4282. Neutral regular season: n 3954, log loss 0.59135, margin CRPS 6.5206.


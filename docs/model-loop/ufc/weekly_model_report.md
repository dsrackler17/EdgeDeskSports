# UFC weekly model report

Generated 2026-11-01T19:16:09Z. EXPERIMENTAL. No timestamped UFC closing prices are archived; the 2026-10 study (docs/model-loop/ufc/study/README.md) measures the model against an untimestamped public archive of pre-fight lines, where it trails the closing line by a wide margin.

Served: **1.3.0**.

## Preregistered backtest

| Window | n | Log loss | Coin flip | 95% interval of the difference | Brier | Accuracy |
|---|---|---|---|---|---|---|
| tune 2016–2020 | 2537 | 0.67922 | 0.69315 | [-0.02008, -0.00808] | 0.24314 | 0.5719 |
| validation 2021–2024 | 2225 | 0.67561 | 0.69315 | [-0.02407, -0.01103] | 0.24142 | 0.5685 |
| holdout 2025–2025 | 563 | 0.66571 | 0.69315 | [-0.04041, -0.01463] | 0.23657 | 0.5879 |
| live 2026–2026 | 498 | 0.67398 | 0.69315 | [-0.03318, -0.00401] | 0.24047 | 0.6064 |

Decision: served — clears every condition.

## The published record

26 bouts graded pregame: log loss 0.6138 (coin flip 0.69315), Brier 0.21283, accuracy 0.5769. The feed kept its fighter order after the result in 100% of them.

## The disagreement guard

Threshold 8 points; 18 of 28 published bouts have a market price, 9 disagree; certified as a signal: no (the closing line on file is untimestamped (a public archive's pre-fight line), so it can refuse a signal but never certify one; on those bouts the model's log loss 0.6540 is worse than the closing line's 0.5797: 903 resolved in the market's favour, 505 in the model's).

| Bout | Model | Market (no vig) | Gap | Likely why |
|---|---|---|---|---|
| Keiichiro Nakamura v Ollie Schmid | 0.549 | 0.751 | -20.2 | Keiichiro Nakamura has 1 UFC bout in the data (pro record before the UFC 7-1): a short sample; Ollie Schmid has 1 UFC bout in the data (pro record before the UFC 4-2): a short sample; Keiichiro Nakamura is 37.9, past 35: how much age has taken is where the model and the market most often differ |
| Jose Delano v Murtazali Magomedov | 0.373 | 0.511 | -13.7 | Jose Delano has 2 UFC bouts in the data (pro record before the UFC 15-3): a short sample; Murtazali Magomedov has 2 UFC bouts in the data (pro record before the UFC 9-0): a short sample |
| Mitch Raposo v Marcos Degli | 0.444 | 0.319 | +12.5 | Marcos Degli has 1 UFC bout in the data (pro record before the UFC 14-3): a short sample |
| Thomas Petersen v Gabriel Lorenço | 0.465 | 0.604 | -13.8 | Gabriel Lorenço has 1 UFC bout in the data (pro record before the UFC 7-1): a short sample |
| Tatiana Suarez v Virna Jandiroba | 0.445 | 0.609 | -16.4 | Tatiana Suarez is 35.9, past 35: how much age has taken is where the model and the market most often differ; Virna Jandiroba is 38.4, past 35: how much age has taken is where the model and the market most often differ |
| Billy Elekana v Lucas Fernando | 0.615 | 0.309 | +30.5 | Lucas Fernando has 2 UFC bouts in the data (pro record before the UFC 13-2): a short sample |
| Josh Hokit v Ciryl Gane | 0.578 | 0.304 | +27.4 | Ciryl Gane is 36.6, past 35: how much age has taken is where the model and the market most often differ |
| Amanda Nunes v Kayla Harrison | 0.515 | 0.369 | +14.6 | Kayla Harrison has 3 UFC bouts in the data (pro record before the UFC 16-1): a short sample; Amanda Nunes returns after 1253 days out; Kayla Harrison returns after 525 days out; Amanda Nunes is 38.5, past 35: how much age has taken is where the model and the market most often differ; Kayla Harrison is 36.4, past 35: how much age has taken is where the model and the market most often differ |
| Luis Gurule v Bilal Hasan | 0.251 | 0.132 | +11.8 | Bilal Hasan has 2 UFC bouts in the data (pro record before the UFC 8-0): a short sample; Luis Gurule is 7.7 years older; Luis Gurule moves down 1 division: the rating was earned at another weight |

## This week's research

| Candidate | Change | Δ log loss | 95% interval | Δ Brier | Decision |
|---|---|---|---|---|---|
| k_lower | `k` ['mul', 0.75] | 0.00041 | [-0.00072, 0.00152] | 0.00019 | FAIL: log loss change +0.00041 does not clear -0.0005; 95% interval [-0.00072, 0.00152] is not below zero; Brier worse (+0.00019); worse on 2025 |
| k_higher | `k` ['mul', 1.33] | 0.00173 | [0.0004, 0.00312] | 0.00076 | FAIL: log loss change +0.00173 does not clear -0.0005; 95% interval [0.0004, 0.00312] is not below zero; Brier worse (+0.00076) |
| new_faster | `k_new_mult` ['add', 0.5] | 0.00239 | [0.00112, 0.0037] | 0.00106 | FAIL: log loss change +0.00239 does not clear -0.0005; 95% interval [0.00112, 0.0037] is not below zero; Brier worse (+0.00106); worse on 2025 |
| new_slower | `k_new_mult` ['add', -0.5] | 0.00014 | [-0.00122, 0.00147] | 6e-05 | FAIL: log loss change +0.00014 does not clear -0.0005; 95% interval [-0.00122, 0.00147] is not below zero; Brier worse (+0.00006); worse on 2025 |
| new_window_longer | `new_bouts` ['set', 6] | -0.00057 | [-0.00172, 0.0006] | -0.00032 | FAIL: 95% interval [-0.00172, 0.0006] is not below zero |
| layoff_more | `layoff_regress` ['add', 0.15] | 0.00069 | [-5e-05, 0.00143] | 0.00036 | FAIL: log loss change +0.00069 does not clear -0.0005; 95% interval [-5e-05, 0.00143] is not below zero; Brier worse (+0.00036); worse on 2025 |
| layoff_less | `layoff_regress` ['add', -0.15] | 0.00029 | [-0.00055, 0.00111] | 9e-05 | FAIL: log loss change +0.00029 does not clear -0.0005; 95% interval [-0.00055, 0.00111] is not below zero; Brier worse (+0.00009); worse on 2025 |
| calibration_toggle | `calibration` ['toggle', None] | 0.00104 | [-0.00093, 0.00288] | 0.00048 | FAIL: log loss change +0.00104 does not clear -0.0005; 95% interval [-0.00093, 0.00288] is not below zero; Brier worse (+0.00048); worse on 2025 |
| champion_term | `champ_bonus` ['set', 100.0] | -2e-05 | [-0.00115, 0.00107] | -3e-05 | FAIL: log loss change -0.00002 does not clear -0.0005; 95% interval [-0.00115, 0.00107] is not below zero; worse on 2025 |
| record_prior_stronger | `prior_rec` ['mul', 1.33] | 0.00195 | [0.00074, 0.00316] | 0.00078 | FAIL: log loss change +0.00195 does not clear -0.0005; 95% interval [0.00074, 0.00316] is not below zero; Brier worse (+0.00078); worse on 2025 |
| age_steeper | `age_slope` ['mul', 1.33] | -1e-05 | [-0.00029, 0.00027] | -1e-05 | FAIL: log loss change -0.00001 does not clear -0.0005; 95% interval [-0.00029, 0.00027] is not below zero; worse on 2025 |
| age_gentler | `age_slope` ['mul', 0.75] | 9e-05 | [-0.00012, 0.0003] | 4e-05 | FAIL: log loss change +0.00009 does not clear -0.0005; 95% interval [-0.00012, 0.0003] is not below zero; Brier worse (+0.00004) |
| head_to_head | `h2h` ['set', 150.0] | 0.00022 | [-0.00055, 0.00099] | 0.0001 | FAIL: log loss change +0.00022 does not clear -0.0005; 95% interval [-0.00055, 0.00099] is not below zero; Brier worse (+0.00010); worse on 2025 |
| debut_lower | `debut_offset` ['set', -25.0] | 0.00038 | [-0.00022, 0.00097] | 0.00016 | FAIL: log loss change +0.00038 does not clear -0.0005; 95% interval [-0.00022, 0.00097] is not below zero; Brier worse (+0.00016); worse on 2025 |
| age_by_division | `age_div` ['set', {'Bantamweight': [28, -15], 'Featherweight': [28, -15], 'Lightweight': [30, -15], 'Welterweight': [33, -25], 'Middleweight': [28, -20], 'Light Heavyweight': [40, -25], 'Heavyweight': [31, -15], 'W Strawweight': [28, -30]}] | — | — | — | SKIPPED: no change from the served configuration |
| age_shared | `age_div` ['set', {}] | 0.00243 | [0.00034, 0.00454] | 0.00114 | FAIL: log loss change +0.00243 does not clear -0.0005; 95% interval [0.00034, 0.00454] is not below zero; Brier worse (+0.00114); worse on 2025 |

# UFC weekly model report

Generated 2026-10-25T17:58:48Z. EXPERIMENTAL. No timestamped UFC closing prices are archived; the 2026-10 study (docs/model-loop/ufc/study/README.md) measures the model against an untimestamped public archive of pre-fight lines, where it trails the closing line by a wide margin.

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

14 bouts graded pregame: log loss 0.68734 (coin flip 0.69315), Brier 0.24769, accuracy 0.4286. The feed kept its fighter order after the result in 100% of them.

## The disagreement guard

Threshold 8 points; 10 of 13 published bouts have a market price, 5 disagree; certified as a signal: no (the closing line on file is untimestamped (a public archive's pre-fight line), so it can refuse a signal but never certify one; on those bouts the model's log loss 0.6540 is worse than the closing line's 0.5797: 903 resolved in the market's favour, 505 in the model's).

| Bout | Model | Market (no vig) | Gap | Likely why |
|---|---|---|---|---|
| Joe Kropschot v Nick Klein | 0.579 | 0.726 | -14.7 | Joe Kropschot has 1 UFC bout in the data (pro record before the UFC 8-3): a short sample; Nick Klein has 3 UFC bouts in the data (pro record before the UFC 5-1): a short sample; Nick Klein returns after 454 days out |
| Piera Rodriguez v Talita Alencar | 0.591 | 0.691 | -10.0 | Talita Alencar is 36.0, past 35: how much age has taken is where the model and the market most often differ |
| Julian Erosa v JeongYeong Lee | 0.458 | 0.378 | +8.1 | JeongYeong Lee returns after 538 days out; Julian Erosa is 37.3, past 35: how much age has taken is where the model and the market most often differ |
| Renato Moicano v Tom Nolan | 0.374 | 0.457 | -8.4 | Renato Moicano is 37.4, past 35: how much age has taken is where the model and the market most often differ |
| Jean-Paul Lebosnoyani v Farman Hasanov | 0.574 | 0.691 | -11.6 | Jean-Paul Lebosnoyani has 3 UFC bouts in the data (pro record before the UFC 8-2): a short sample; Farman Hasanov has 1 UFC bout in the data (pro record before the UFC 5-0): a short sample |

## This week's research

| Candidate | Change | Δ log loss | 95% interval | Δ Brier | Decision |
|---|---|---|---|---|---|
| k_lower | `k` ['mul', 0.75] | 0.00038 | [-0.0007, 0.00147] | 0.00017 | FAIL: log loss change +0.00038 does not clear -0.0005; 95% interval [-0.0007, 0.00147] is not below zero; Brier worse (+0.00017); worse on 2025 |
| k_higher | `k` ['mul', 1.33] | 0.00176 | [0.00041, 0.00306] | 0.00077 | FAIL: log loss change +0.00176 does not clear -0.0005; 95% interval [0.00041, 0.00306] is not below zero; Brier worse (+0.00077) |
| new_faster | `k_new_mult` ['add', 0.5] | 0.00241 | [0.00114, 0.00368] | 0.00107 | FAIL: log loss change +0.00241 does not clear -0.0005; 95% interval [0.00114, 0.00368] is not below zero; Brier worse (+0.00107); worse on 2025 |
| new_slower | `k_new_mult` ['add', -0.5] | 0.0001 | [-0.00123, 0.0014] | 4e-05 | FAIL: log loss change +0.00010 does not clear -0.0005; 95% interval [-0.00123, 0.0014] is not below zero; Brier worse (+0.00004); worse on 2025 |
| new_window_longer | `new_bouts` ['set', 6] | -0.00056 | [-0.00168, 0.00065] | -0.00032 | FAIL: 95% interval [-0.00168, 0.00065] is not below zero |
| layoff_more | `layoff_regress` ['add', 0.15] | 0.00069 | [-8e-05, 0.00142] | 0.00036 | FAIL: log loss change +0.00069 does not clear -0.0005; 95% interval [-8e-05, 0.00142] is not below zero; Brier worse (+0.00036); worse on 2025 |
| layoff_less | `layoff_regress` ['add', -0.15] | 0.00027 | [-0.00057, 0.00113] | 8e-05 | FAIL: log loss change +0.00027 does not clear -0.0005; 95% interval [-0.00057, 0.00113] is not below zero; Brier worse (+0.00008); worse on 2025 |
| calibration_toggle | `calibration` ['toggle', None] | 0.00101 | [-0.00092, 0.00294] | 0.00047 | FAIL: log loss change +0.00101 does not clear -0.0005; 95% interval [-0.00092, 0.00294] is not below zero; Brier worse (+0.00047); worse on 2025 |
| champion_term | `champ_bonus` ['set', 100.0] | -2e-05 | [-0.00117, 0.00111] | -4e-05 | FAIL: log loss change -0.00002 does not clear -0.0005; 95% interval [-0.00117, 0.00111] is not below zero; worse on 2025 |
| record_prior_stronger | `prior_rec` ['mul', 1.33] | 0.00196 | [0.00077, 0.00323] | 0.00078 | FAIL: log loss change +0.00196 does not clear -0.0005; 95% interval [0.00077, 0.00323] is not below zero; Brier worse (+0.00078); worse on 2025 |
| age_steeper | `age_slope` ['mul', 1.33] | 0.0 | [-0.00028, 0.00028] | -1e-05 | FAIL: log loss change +0.00000 does not clear -0.0005; 95% interval [-0.00028, 0.00028] is not below zero; worse on 2025 |
| age_gentler | `age_slope` ['mul', 0.75] | 8e-05 | [-0.00013, 0.00029] | 4e-05 | FAIL: log loss change +0.00008 does not clear -0.0005; 95% interval [-0.00013, 0.00029] is not below zero; Brier worse (+0.00004) |
| head_to_head | `h2h` ['set', 150.0] | 0.00022 | [-0.00055, 0.00097] | 9e-05 | FAIL: log loss change +0.00022 does not clear -0.0005; 95% interval [-0.00055, 0.00097] is not below zero; Brier worse (+0.00009); worse on 2025 |
| debut_lower | `debut_offset` ['set', -25.0] | 0.00035 | [-0.00025, 0.00096] | 0.00015 | FAIL: log loss change +0.00035 does not clear -0.0005; 95% interval [-0.00025, 0.00096] is not below zero; Brier worse (+0.00015); worse on 2025 |
| age_by_division | `age_div` ['set', {'Bantamweight': [28, -15], 'Featherweight': [28, -15], 'Lightweight': [30, -15], 'Welterweight': [33, -25], 'Middleweight': [28, -20], 'Light Heavyweight': [40, -25], 'Heavyweight': [31, -15], 'W Strawweight': [28, -30]}] | — | — | — | SKIPPED: no change from the served configuration |
| age_shared | `age_div` ['set', {}] | 0.00242 | [0.00046, 0.00448] | 0.00113 | FAIL: log loss change +0.00242 does not clear -0.0005; 95% interval [0.00046, 0.00448] is not below zero; Brier worse (+0.00113); worse on 2025 |

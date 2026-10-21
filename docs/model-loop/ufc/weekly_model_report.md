# UFC weekly model report

Generated 2026-10-21T04:09:13Z. EXPERIMENTAL and outcome-graded only: no UFC closing prices are archived.

Served: **1.1.0**.

## Preregistered backtest

| Window | n | Log loss | Coin flip | 95% interval of the difference | Brier | Accuracy |
|---|---|---|---|---|---|---|
| tune 2016–2020 | 2537 | 0.67922 | 0.69315 | [-0.02008, -0.00808] | 0.24314 | 0.5719 |
| validation 2021–2024 | 2225 | 0.67561 | 0.69315 | [-0.02407, -0.01103] | 0.24142 | 0.5685 |
| holdout 2025–2025 | 563 | 0.66571 | 0.69315 | [-0.04041, -0.01463] | 0.23657 | 0.5879 |
| live 2026–2026 | 498 | 0.67398 | 0.69315 | [-0.03318, -0.00401] | 0.24047 | 0.6064 |

Decision: served — clears every condition.

## This week's research

| Candidate | Change | Δ log loss | 95% interval | Δ Brier | Decision |
|---|---|---|---|---|---|
| k_lower | `k` ['mul', 0.75] | 0.002 | [0.00121, 0.00289] | 0.00095 | FAIL: log loss change +0.00200 does not clear -0.0005; 95% interval [0.00121, 0.00289] is not below zero; Brier worse (+0.00095); worse on 2025 |
| k_higher | `k` ['mul', 1.33] | -0.00108 | [-0.00219, -0.00012] | -0.00052 | PASS: clears every condition |
| new_faster | `k_new_mult` ['add', 0.5] | -0.00158 | [-0.00295, -0.00033] | -0.00076 | PASS: clears every condition |
| new_slower | `k_new_mult` ['add', -0.5] | — | — | — | SKIPPED: no change from the served configuration |
| new_window_longer | `new_bouts` ['set', 6] | 0.0 | [0.0, 0.0] | 0.0 | FAIL: log loss change +0.00000 does not clear -0.0005; 95% interval [0.0, 0.0] is not below zero |
| layoff_more | `layoff_regress` ['add', 0.15] | -0.00024 | [-0.00077, 0.00029] | -0.00013 | FAIL: log loss change -0.00024 does not clear -0.0005; 95% interval [-0.00077, 0.00029] is not below zero |
| layoff_less | `layoff_regress` ['add', -0.15] | 0.00085 | [0.00024, 0.00143] | 0.00042 | FAIL: log loss change +0.00085 does not clear -0.0005; 95% interval [0.00024, 0.00143] is not below zero; Brier worse (+0.00042); worse on 2025 |
| calibration_toggle | `calibration` ['toggle', None] | -0.0002 | [-0.00057, 0.00012] | -9e-05 | FAIL: log loss change -0.00020 does not clear -0.0005; 95% interval [-0.00057, 0.00012] is not below zero |

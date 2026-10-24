# UFC weekly model report

Generated 2026-10-24T15:02:10Z. EXPERIMENTAL. No timestamped UFC closing prices are archived; the 2026-10 study (docs/model-loop/ufc/study/README.md) measures the model against an untimestamped public archive of pre-fight lines, where it trails the closing line by a wide margin.

Served: **1.2.0**.

## Preregistered backtest

| Window | n | Log loss | Coin flip | 95% interval of the difference | Brier | Accuracy |
|---|---|---|---|---|---|---|
| tune 2016–2020 | 2537 | 0.67922 | 0.69315 | [-0.02008, -0.00808] | 0.24314 | 0.5719 |
| validation 2021–2024 | 2225 | 0.67561 | 0.69315 | [-0.02407, -0.01103] | 0.24142 | 0.5685 |
| holdout 2025–2025 | 563 | 0.66571 | 0.69315 | [-0.04041, -0.01463] | 0.23657 | 0.5879 |
| live 2026–2026 | 498 | 0.67398 | 0.69315 | [-0.03318, -0.00401] | 0.24047 | 0.6064 |

Decision: served — clears every condition.

## The disagreement guard

Threshold 8 points; 9 of 20 published bouts have a market price, 5 disagree; certified as a signal: no (the closing line on file is untimestamped (a public archive's pre-fight line), so it can refuse a signal but never certify one; on those bouts the model's log loss 0.6524 is worse than the closing line's 0.5728: 942 resolved in the market's favour, 478 in the model's).

| Bout | Model | Market (no vig) | Gap | Likely why |
|---|---|---|---|---|
| Azamat Murzakanov v Dominick Reyes | 0.550 | 0.645 | -9.4 | Azamat Murzakanov is 37.5, past 35: how much age has taken is where the model and the market most often differ; Dominick Reyes is 36.8, past 35: how much age has taken is where the model and the market most often differ |
| Abus Magomedov v Cam Rowston | 0.425 | 0.532 | -10.7 | Abus Magomedov is 36.1, past 35: how much age has taken is where the model and the market most often differ |
| Alexander Volkanovski v Movsar Evloev | 0.348 | 0.496 | -14.7 | Alexander Volkanovski is 38.1, past 35: how much age has taken is where the model and the market most often differ |
| Alexander Volkov v Rizvan Kuniev | 0.653 | 0.522 | +13.1 | Alexander Volkov is 38.0, past 35: how much age has taken is where the model and the market most often differ |
| Aaron Pico v Losene Keita | 0.344 | 0.572 | -22.8 | Aaron Pico has 2 UFC bouts in the data (pro record before the UFC 13-4): a short sample; Losene Keita has 2 UFC bouts in the data (pro record before the UFC 16-1): a short sample |

## This week's research

| Candidate | Change | Δ log loss | 95% interval | Δ Brier | Decision |
|---|---|---|---|---|---|
| champion_term | `champ_bonus` ['set', 100.0] | 9e-05 | [-0.00106, 0.00124] | 0.0 | FAIL: log loss change +0.00009 does not clear -0.0005; 95% interval [-0.00106, 0.00124] is not below zero; worse on 2025 |

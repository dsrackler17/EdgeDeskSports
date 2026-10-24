# UFC weekly model report

Generated 2026-10-24T15:57:13Z. EXPERIMENTAL. No timestamped UFC closing prices are archived; the 2026-10 study (docs/model-loop/ufc/study/README.md) measures the model against an untimestamped public archive of pre-fight lines, where it trails the closing line by a wide margin.

Served: **1.3.0**.

## Preregistered backtest

| Window | n | Log loss | Coin flip | 95% interval of the difference | Brier | Accuracy |
|---|---|---|---|---|---|---|
| tune 2016–2020 | 2537 | 0.67922 | 0.69315 | [-0.02008, -0.00808] | 0.24314 | 0.5719 |
| validation 2021–2024 | 2225 | 0.67561 | 0.69315 | [-0.02407, -0.01103] | 0.24142 | 0.5685 |
| holdout 2025–2025 | 563 | 0.66571 | 0.69315 | [-0.04041, -0.01463] | 0.23657 | 0.5879 |
| live 2026–2026 | 498 | 0.67398 | 0.69315 | [-0.03318, -0.00401] | 0.24047 | 0.6064 |

Decision: served — clears every condition.

## The disagreement guard

Threshold 8 points; 9 of 20 published bouts have a market price, 7 disagree; certified as a signal: no (the closing line on file is untimestamped (a public archive's pre-fight line), so it can refuse a signal but never certify one; on those bouts the model's log loss 0.6540 is worse than the closing line's 0.5797: 903 resolved in the market's favour, 505 in the model's).

| Bout | Model | Market (no vig) | Gap | Likely why |
|---|---|---|---|---|
| Azamat Murzakanov v Dominick Reyes | 0.543 | 0.645 | -10.1 | Azamat Murzakanov is 37.5, past 35: how much age has taken is where the model and the market most often differ; Dominick Reyes is 36.8, past 35: how much age has taken is where the model and the market most often differ |
| Abus Magomedov v Cam Rowston | 0.398 | 0.532 | -13.5 | Abus Magomedov is 36.1, past 35: how much age has taken is where the model and the market most often differ |
| Nikita Krylov v Abdul-Rakhman Yakhyaev | 0.317 | 0.188 | +12.8 | Nikita Krylov is 8.8 years older |
| Alexander Volkanovski v Movsar Evloev | 0.365 | 0.496 | -13.1 | Alexander Volkanovski is 38.1, past 35: how much age has taken is where the model and the market most often differ |
| Merab Dvalishvili v Petr Yan | 0.528 | 0.436 | +9.2 | Merab Dvalishvili is 35.8, past 35: how much age has taken is where the model and the market most often differ; a rematch (2 earlier meetings; Petr Yan won the last) |
| Alexander Volkov v Rizvan Kuniev | 0.653 | 0.522 | +13.1 | Alexander Volkov is 38.0, past 35: how much age has taken is where the model and the market most often differ |
| Aaron Pico v Losene Keita | 0.326 | 0.572 | -24.6 | Aaron Pico has 2 UFC bouts in the data (pro record before the UFC 13-4): a short sample; Losene Keita has 2 UFC bouts in the data (pro record before the UFC 16-1): a short sample |

## This week's research

| Candidate | Change | Δ log loss | 95% interval | Δ Brier | Decision |
|---|---|---|---|---|---|
| age_by_division | `age_div` ['set', {'Bantamweight': [28, -15], 'Featherweight': [28, -15], 'Lightweight': [30, -15], 'Welterweight': [33, -25], 'Middleweight': [28, -20], 'Light Heavyweight': [40, -25], 'Heavyweight': [31, -15], 'W Strawweight': [28, -30]}] | -0.00249 | [-0.00462, -0.00041] | -0.00117 | PASS: clears every condition |
| age_shared | `age_div` ['set', {}] | — | — | — | SKIPPED: no change from the served configuration |

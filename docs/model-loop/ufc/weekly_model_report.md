# UFC weekly model report

Generated 2026-10-25T05:16:46Z. EXPERIMENTAL. No timestamped UFC closing prices are archived; the 2026-10 study (docs/model-loop/ufc/study/README.md) measures the model against an untimestamped public archive of pre-fight lines, where it trails the closing line by a wide margin.

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
| age_by_division | `age_div` ['set', {'Bantamweight': [28, -15], 'Featherweight': [28, -15], 'Lightweight': [30, -15], 'Welterweight': [33, -25], 'Middleweight': [28, -20], 'Light Heavyweight': [40, -25], 'Heavyweight': [31, -15], 'W Strawweight': [28, -30]}] | -0.00249 | [-0.00462, -0.00041] | -0.00117 | PASS: clears every condition |
| age_shared | `age_div` ['set', {}] | — | — | — | SKIPPED: no change from the served configuration |

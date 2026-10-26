# NBA engine weekly report

Generated 2026-10-26T17:39:55Z. Read only: it grades what the engine published before each game and changes no number. The engine's models are chosen by its own protocol (nba/model/walkforward.js).

Served: **E_ridge_P** (validation 2026-10-21T18:14:51.980Z).

## Season to date and this week

| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |
|---|---|---|---|---|---|---|---|---|
| Season to date | 43 | 0.6265 | 0.2191 | 0.6512 | 0.5392 | 0.4651 | 14.27 | 12.27 |
| Week 2026-10-19 to 2026-10-26 | 43 | 0.6265 | 0.2191 | 0.6512 | 0.5392 | 0.4651 | 14.27 | 12.27 |

## Against its own record

Season log loss 0.62646 on 43 games against 0.61681 on the test 2018-2026 window (t = 0.2): **within what its out-of-sample record promised**.
Against a constant home-win rate of 0.5612: log loss difference -0.08281 (95% interval [-0.17642, 0.00411]), not yet distinguishable from it.

## Patterns

Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. Flagged: n >= 30 and |z| or |t| >= 2.0. A flag is a research question for the engine's next protocol amendment, not a change.

| Pattern | Market | n | Residual | z / t | |
|---|---|---|---|---|---|
| all games | moneyline | 43 | -0.0741 | -1.03 z |  |
| all games | total | 43 | 2.0660 | 0.76 t |  |
| home favourite (p >= 0.60) | moneyline | 14 | -0.0822 | -0.69 z |  |
| home underdog (p <= 0.40) | moneyline | 8 | -0.1701 | -1.07 z |  |
| near a coin flip (0.40 < p < 0.60) | moneyline | 21 | -0.0321 | -0.30 z |  |
| home side on a back-to-back | moneyline | 6 | -0.2896 | -1.52 z |  |
| home side on a back-to-back | total | 6 | 1.0420 | 0.16 t |  |
| away side on a back-to-back | moneyline | 7 | -0.0235 | -0.14 z |  |
| away side on a back-to-back | total | 7 | 14.9910 | 2.25 t |  |
| rotation stale: False | moneyline | 27 | -0.1648 | -1.82 z |  |
| rotation stale: True | moneyline | 16 | 0.0789 | 0.67 z |  |

## Data

350 ledger records over 68 games; 43 graded.
The graded games were priced by more than one model: edgedesk_nba_v1:E_ridge_P, edgedesk_nba_v1:G_stack_P.

Changes: none: this report changes no number. NBA engine's models and hyperparameters are chosen by its own protocol (nba/model/walkforward.js); a flagged pattern is a question for its next amendment.

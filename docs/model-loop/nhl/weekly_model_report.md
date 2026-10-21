# NHL engine weekly report

Generated 2026-10-21T09:22:03Z. Read only: it grades what the engine published before each game and changes no number. The engine's models are chosen by its own protocol (hockey/model/walkforward.js).

Served: **edgedesk_nhl_v1:xg_core** (validation 2026-10-20T15:19:46.910Z).

## Season to date and this week

| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |
|---|---|---|---|---|---|---|---|---|
| Season to date | 51 | 0.6547 | 0.2312 | 0.6078 | 0.5324 | 0.6275 | 1.67 | — |
| Week 2026-10-14 to 2026-10-21 | 35 | 0.6394 | 0.2238 | 0.6286 | 0.5344 | 0.7143 | 1.71 | — |

## Against its own record

Season log loss 0.65472 on 51 games against 0.66286 on the confirmation 2021-2026 window (t = -0.39): **within what its out-of-sample record promised**.
Against a constant home-win rate of 0.5363: log loss difference -0.02253 (95% interval [-0.05997, 0.01551]), not yet distinguishable from it.

## Patterns

Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. Flagged: n >= 30 and |z| or |t| >= 2.0. A flag is a research question for the engine's next protocol amendment, not a change.

| Pattern | Market | n | Residual | z / t | |
|---|---|---|---|---|---|
| all games | moneyline | 51 | 0.0951 | 1.38 z |  |
| all games | total | 51 | 0.1420 | 0.50 t |  |
| home favourite (p >= 0.60) | moneyline | 10 | 0.3692 | 2.42 z |  |
| home underdog (p <= 0.40) | moneyline | 4 | 0.3621 | 1.49 z |  |
| near a coin flip (0.40 < p < 0.60) | moneyline | 37 | -0.0079 | -0.10 z |  |
| home side on a back-to-back | moneyline | 3 | -0.2184 | -0.76 z |  |
| home side on a back-to-back | total | 3 | 1.4700 | 1.10 t |  |
| away side on a back-to-back | moneyline | 11 | -0.0053 | -0.04 z |  |
| away side on a back-to-back | total | 11 | 0.5950 | 0.93 t |  |
| goalie the price assumed: PROJECTED_LIKELY | moneyline | 1 | -0.4992 | -1.00 z |  |
| goalie the price assumed: PROJECTED_UNCERTAIN | moneyline | 50 | 0.1070 | 1.53 z |  |

## Data

120 ledger records over 95 games; 51 graded.
The graded games were priced by more than one model: edgedesk_nhl_v1:xg_core, edgedesk_nhl_v1:xg_no_goalie.

Changes: none: this report changes no number. NHL engine's models and hyperparameters are chosen by its own protocol (hockey/model/walkforward.js); a flagged pattern is a question for its next amendment.

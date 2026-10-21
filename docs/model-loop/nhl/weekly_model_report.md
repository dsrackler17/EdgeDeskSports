# NHL engine weekly report

Generated 2026-10-21T23:31:51Z. Read only: it grades what the engine published before each game and changes no number. The engine's models are chosen by its own protocol (hockey/model/walkforward.js).

Served: **edgedesk_nhl_v1:xg_core** (validation 2026-10-20T15:19:46.910Z).

## Season to date and this week

| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |
|---|---|---|---|---|---|---|---|---|
| Season to date | 62 | 0.6626 | 0.2351 | 0.5968 | 0.5331 | 0.6129 | 1.62 | — |
| Week 2026-10-14 to 2026-10-21 | 45 | 0.6547 | 0.2313 | 0.6000 | 0.5347 | 0.6667 | 1.60 | — |

## Against its own record

Season log loss 0.6626 on 62 games against 0.66286 on the confirmation 2021-2026 window (t = -0.01): **within what its out-of-sample record promised**.
Against a constant home-win rate of 0.5363: log loss difference -0.01676 (95% interval [-0.0526, 0.02051]), not yet distinguishable from it.

## Patterns

Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. Flagged: n >= 30 and |z| or |t| >= 2.0. A flag is a research question for the engine's next protocol amendment, not a change.

| Pattern | Market | n | Residual | z / t | |
|---|---|---|---|---|---|
| all games | moneyline | 62 | 0.0798 | 1.27 z |  |
| all games | total | 62 | 0.1820 | 0.73 t |  |
| home favourite (p >= 0.60) | moneyline | 13 | 0.2162 | 1.62 z |  |
| home underdog (p <= 0.40) | moneyline | 5 | 0.2275 | 1.05 z |  |
| near a coin flip (0.40 < p < 0.60) | moneyline | 44 | 0.0227 | 0.30 z |  |
| home side on a back-to-back | moneyline | 3 | -0.2184 | -0.76 z |  |
| home side on a back-to-back | total | 3 | 1.4700 | 1.10 t |  |
| away side on a back-to-back | moneyline | 15 | -0.0276 | -0.22 z |  |
| away side on a back-to-back | total | 15 | 0.5390 | 1.11 t |  |
| goalie the price assumed: PROJECTED_LIKELY | moneyline | 1 | -0.4992 | -1.00 z |  |
| goalie the price assumed: PROJECTED_UNCERTAIN | moneyline | 61 | 0.0893 | 1.41 z |  |

## Data

123 ledger records over 95 games; 62 graded.
The graded games were priced by more than one model: edgedesk_nhl_v1:xg_core, edgedesk_nhl_v1:xg_no_goalie.

Changes: none: this report changes no number. NHL engine's models and hyperparameters are chosen by its own protocol (hockey/model/walkforward.js); a flagged pattern is a question for its next amendment.

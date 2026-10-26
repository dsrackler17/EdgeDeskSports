# NHL engine weekly report

Generated 2026-10-26T17:39:55Z. Read only: it grades what the engine published before each game and changes no number. The engine's models are chosen by its own protocol (hockey/model/walkforward.js).

Served: **edgedesk_nhl_v1:xg_core** (validation 2026-10-20T15:19:46.910Z).

## Season to date and this week

| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |
|---|---|---|---|---|---|---|---|---|
| Season to date | 95 | 0.6667 | 0.2369 | 0.5895 | 0.5245 | 0.6211 | 1.75 | — |
| Week 2026-10-19 to 2026-10-26 | 48 | 0.6804 | 0.2435 | 0.5833 | 0.5151 | 0.6458 | 1.83 | — |

## Against its own record

Season log loss 0.66666 on 95 games against 0.66286 on the confirmation 2021-2026 window (t = 0.24): **within what its out-of-sample record promised**.
Against a constant home-win rate of 0.5363: log loss difference -0.01152 (95% interval [-0.04044, 0.02012]), not yet distinguishable from it.

## Patterns

Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. Flagged: n >= 30 and |z| or |t| >= 2.0. A flag is a research question for the engine's next protocol amendment, not a change.

| Pattern | Market | n | Residual | z / t | |
|---|---|---|---|---|---|
| all games | moneyline | 95 | 0.0966 | 1.91 z |  |
| all games | total | 95 | 0.2260 | 1.05 t |  |
| home favourite (p >= 0.60) | moneyline | 15 | 0.1722 | 1.38 z |  |
| home underdog (p <= 0.40) | moneyline | 6 | 0.3010 | 1.53 z |  |
| near a coin flip (0.40 < p < 0.60) | moneyline | 74 | 0.0646 | 1.12 z |  |
| home side on a back-to-back | moneyline | 5 | -0.1133 | -0.52 z |  |
| home side on a back-to-back | total | 5 | 1.5700 | 2.14 t |  |
| away side on a back-to-back | moneyline | 18 | 0.0020 | 0.02 z |  |
| away side on a back-to-back | total | 18 | 0.4510 | 0.99 t |  |
| goalie the price assumed: PROJECTED_LIKELY | moneyline | 2 | -0.0355 | -0.10 z |  |
| goalie the price assumed: PROJECTED_UNCERTAIN | moneyline | 93 | 0.0994 | 1.94 z |  |

## Data

169 ledger records over 127 games; 95 graded.
The graded games were priced by more than one model: edgedesk_nhl_v1:xg_core, edgedesk_nhl_v1:xg_no_goalie.

Changes: none: this report changes no number. NHL engine's models and hyperparameters are chosen by its own protocol (hockey/model/walkforward.js); a flagged pattern is a question for its next amendment.

# NBA engine weekly report

Generated 2026-10-21T23:31:51Z. Read only: it grades what the engine published before each game and changes no number. The engine's models are chosen by its own protocol (nba/model/walkforward.js).

Served: **E_ridge_P** (validation 2026-10-21T18:14:51.980Z).

## Season to date and this week

| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |
|---|---|---|---|---|---|---|---|---|
| Season to date | 3 | 0.9594 | 0.3674 | 0.3333 | 0.6192 | 0.3333 | 12.38 | 12.01 |
| Week 2026-10-14 to 2026-10-21 | 3 | 0.9594 | 0.3674 | 0.3333 | 0.6192 | 0.3333 | 12.38 | 12.01 |

## Against its own record

Too early: 3 graded games (the comparison starts at 30). The record promises a log loss of 0.61681 (test 2018-2026, n = 11543).
Against a constant home-win rate of 0.5612: log loss difference 0.21771 (95% interval [-0.04027, 0.65789]), not yet distinguishable from it.

## Patterns

Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. Flagged: n >= 30 and |z| or |t| >= 2.0. A flag is a research question for the engine's next protocol amendment, not a change.

| Pattern | Market | n | Residual | z / t | |
|---|---|---|---|---|---|
| all games | moneyline | 3 | -0.2858 | -1.05 z |  |
| all games | total | 3 | -2.2130 | -0.24 t |  |
| home favourite (p >= 0.60) | moneyline | 1 | -0.7727 | -1.84 z |  |
| near a coin flip (0.40 < p < 0.60) | moneyline | 2 | -0.0424 | -0.12 z |  |
| rotation stale: True | moneyline | 3 | -0.2858 | -1.05 z |  |

## Data

141 ledger records over 28 games; 3 graded.

Changes: none: this report changes no number. NBA engine's models and hyperparameters are chosen by its own protocol (nba/model/walkforward.js); a flagged pattern is a question for its next amendment.

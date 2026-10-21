# NBA engine weekly report

Generated 2026-10-21T09:22:03Z. Read only: it grades what the engine published before each game and changes no number. The engine's models are chosen by its own protocol (nba/model/walkforward.js).

Served: **G_stack_P** (validation 2026-10-14T17:52:25.049Z).

## Season to date and this week

| | n | Log loss | Brier | Accuracy | Priced home win | Home won | Total MAE | Margin MAE |
|---|---|---|---|---|---|---|---|---|
| Season to date | 0 | — | — | — | — | — | — | — |
| Week 2026-10-14 to 2026-10-21 | 0 | — | — | — | — | — | — | — |

## Against its own record

Too early: 0 graded games (the comparison starts at 30). The record promises a log loss of 0.61779 (test 2018-2026, n = 11543).

## Patterns

Moneyline: won minus priced, with z = (wins - sum of prices) / sqrt(sum p(1 - p)), the distance in the standard deviations the engine's own prices imply. Totals: actual minus expected, with a t. Flagged: n >= 30 and |z| or |t| >= 2.0. A flag is a research question for the engine's next protocol amendment, not a change.

| Pattern | Market | n | Residual | z / t | |
|---|---|---|---|---|---|

## Data

91 ledger records over 28 games; 0 graded.

Changes: none: this report changes no number. NBA engine's models and hyperparameters are chosen by its own protocol (nba/model/walkforward.js); a flagged pattern is a question for its next amendment.

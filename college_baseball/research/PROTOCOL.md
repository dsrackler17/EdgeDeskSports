# Evaluation protocol — written before any model was scored

Committed 2026-10-13, before the first walk-forward run. Nothing in this file
is edited to suit a result. A change to the protocol is a new dated section
below, with the reason, and every result produced under the old protocol keeps
its label.

## 1. What "a prediction" is

- A game is predicted at **14:00 UTC on its date** (10:00 Eastern, 07:00
  Pacific). First-pitch times are not carried by the source; the earliest
  plausible start is taken as 15:00 UTC (11:00 Eastern), and the prediction
  must precede it. Games on the same date never inform each other.
  *(Amended 2026-10-14 from 16:00 UTC, before the first walk-forward run: an
  11:00 Eastern start would have preceded a 16:00 UTC prediction.)*
- A completed game's facts become available at **06:00 UTC the next day**.
  `assumed_available_at` is written on every row; `known_at` is blank because
  no row in this source carries a true publication timestamp. Nothing is
  backdated.
- Every scored row passes `engine/validation.leakageAudit`: inputs strictly
  before the prediction time, the prediction strictly before the event.
- Every evaluation in this directory is therefore a **RETROSPECTIVE
  RECONSTRUCTION** from final data, not a verified live-simulation backtest.
  The source can revise historical box scores (corrections to earned runs,
  scoring changes); I cannot see what the record looked like on the day.
  That is stated on every output (`point_in_time: "RETROSPECTIVE"`).

## 2. Windows

Results-only models (team strength, run distributions), 2012–2026:

| Window | Seasons | Use |
|---|---|---|
| burn-in | 2012–2013 | ratings accumulate; nothing scored |
| SELECTION | 2014–2022 | choose model families, tune hyperparameters |
| VALIDATION | 2023–2024 | ensemble weights, calibration maps, promotion evidence |
| HOLDOUT | 2025–2026 | reported once per model version; never tuned on |

Box-score (pitcher-aware) models, 2024–2026 only:

| Window | Seasons | Use |
|---|---|---|
| burn-in / fit | 2024 | pitcher histories accumulate; models fitted |
| SELECTION | 2025 | choose and tune |
| HOLDOUT | 2026 | reported once per model version |

2020 (stopped 2020-03-15) is kept in the data and scored, but reported
separately; it is not used to choose anything on its own. 2023's season file
is incomplete in the source and is rebuilt from per-team files (ingest).

## 3. Choosing and promoting

- Candidates are listed in order of complexity before scoring. The simplest
  is the incumbent. A challenger replaces it only if its SELECTION log loss is
  lower by **≥ 0.001** (`engine/lab/protocol.js` RULES.challenger_margin).
- An ensemble is kept only if, on VALIDATION, a paired date-block bootstrap
  of its log loss against the best single model has a 95% interval wholly
  below zero.
- A feature group is kept only if its ablation (the model without it) is
  worse on VALIDATION by a margin whose 95% interval excludes zero. A feature
  that explains a memorable miss but does not pass this test is rejected and
  recorded.

## 4. Status rules (per market, on HOLDOUT)

Reused unchanged from `engine/lab/protocol.js`:

- moneyline: n ≥ 1000, ≥ 2 seasons, |mean p − mean y| ≤ 0.02, calibration
  slope in [0.85, 1.15], and a block-bootstrap 95% interval of the log-loss
  difference vs the best baseline wholly below zero → `OUTCOME_VALIDATED`;
  otherwise `PROVISIONAL` with the failed rules listed.
- run line / total / team total: 80% interval coverage in [0.77, 0.83], mean
  bias within 1% of the mean outcome (or 0.25 runs), and a CRPS (or ranked
  probability score) interval vs the baseline wholly below zero.
- market: `NOT_TESTED` until a licensed archive of timestamped prices is on
  file. There is none for college baseball.

## 5. Holdout discipline

The HOLDOUT seasons are evaluated by `node college_baseball/walkforward.js
--holdout`, which registers the result with `holdout_evaluated: true`. The
registry counts holdout looks per model family; more than three distinct looks
for one family fails audit check 11 ("overfitting to the holdout"). Re-running
an unchanged model is not a new look.

## 6. Baselines (always reported)

1. Home rate: P(home win) = the burn-in/selection-era home win rate; neutral
   games get 0.5.
2. Season run differential (Pythagenpat) with no opponent adjustment.
3. Elo on results only (K and home advantage tuned on SELECTION).

A model that does not beat baseline 3 on log loss with a 95% interval below
zero is not promoted, however complex it is.

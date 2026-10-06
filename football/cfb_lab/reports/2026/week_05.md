# CFB Model Lab — week 5, 2026

Generated 2026-10-06T04:07:31.000Z from the immutable ledger. Champion: `edgedesk_cfb_p4_v1.0.0`. Definitions: docs/cfb-lab/METRICS.md.

## Week summary

| games predicted | snapshots | official predictions | official settled | champion decisions |
|---|---|---|---|---|
| 59 | 1719 | 171 | 171 | LEAN 40, PASS 19 |

## Model performance (official snapshots)

| model | n | MAE | RMSE | bias | Brier | win ECE | 50/80/95% coverage |
|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 59 | 13.42 | 17.46 | 1.13 | 0.1685 | 0.1140 | — / — / — |
| edgedesk_cfb_v2.0.0 | 56 | 13.65 | 17.75 | 1.37 | 0.1631 | 0.1365 | 0.48 / 0.75 / 0.89 |
| edgedesk_cfb_v2.1.0 | 56 | 13.69 | 17.73 | 1.38 | 0.1623 | 0.1729 | 0.46 / 0.75 / 0.89 |

## Market performance (champion)

- EdgeDesk vs opener: mean (|EdgeDesk error| − |opener error|) 0.05 pts (negative = EdgeDesk closer to the result; n=59); EdgeDesk closer in 44.1% of games.
- EdgeDesk vs close: mean (|EdgeDesk error| − |close error|) 0.60 pts (negative = EdgeDesk closer; n=57); EdgeDesk closer in 45.6% of games.
- Market moved toward EdgeDesk: 49.1% of 57 games, mean 0.49 pts.
- Positive CLV: 35.1%, mean CLV -0.14 pts.

## Betting performance (research positions, graded at the snapshot number)

- Record 22-17-1, ATS 56.4%, ROI 6.6% (one unit each, hypothetical), mean CLV -0.26, max drawdown 4.09 u.
- BET decisions: 0 (BET is disabled).

## Submodel performance

| component | n | MAE | bias |
|---|---|---|---|
| ensemble · V1 | 59 | 13.42 | 1.13 |
| E_drive · V2 · candidate 001 | 56 | 13.63 | -1.41 |
| C_ridge · V2 · candidate 001 | 56 | 13.64 | 1.44 |
| C_ridge · V2.1 · hardened | 56 | 13.65 | 1.36 |
| ensemble · V2 · candidate 001 | 56 | 13.65 | 1.37 |
| ensemble · V2.1 · hardened | 56 | 13.69 | 1.38 |
| D_gbm · V2.1 · hardened | 56 | 13.84 | 1.40 |
| D_gbm · V2 · candidate 001 | 56 | 13.92 | 1.46 |
| A_adj_eff · V2 · candidate 001 | 56 | 14.02 | -0.94 |
| B_elo · V2 · candidate 001 | 56 | 14.47 | 2.20 |

## Biggest wins (games the model called better than the closing line)

- Samford @ UAB: predicted 21.0, actual 19 (error 2.0 vs close 12.5)
- Marshall @ James Madison: predicted 24.6, actual 28 (error 3.5 vs close 12.5)
- Louisville @ NC State: predicted 2.2, actual 3 (error 0.8 vs close 8.5)
- Michigan @ Minnesota: predicted -0.1, actual 6 (error 6.1 vs close 12.5)
- Florida @ Missouri: predicted 0.4, actual 28 (error 27.6 vs close 33.5)

## Biggest misses

- Baylor @ Arizona State: predicted 5.9, actual -36 (error 41.9, close —)
- Stanford @ Wake Forest: predicted 17.2, actual 54 (error 36.8, close 39.5)
- Middle Tennessee @ Kansas: predicted 19.6, actual 55 (error 35.5, close 34.0)
- Virginia @ Florida State: predicted -4.2, actual 31 (error 35.2, close 32.5)
- Memphis @ Charlotte: predicted -16.8, actual -51 (error 34.2, close 30.5)

## Model lessons (one week — recorded, not acted on)

- No segment departed from the prediction by 2 SE with n >= 10.

### What worked

- Nothing recorded.

### What failed

- champion MAE 13.423 vs holdout reference 12.6017 (n=59, z=0.56)
- closer than the closing line in 46% of 57 games (mean |model error| − |close error| 0.596 pts)
- the market moved toward the model in 49% of 57 games (mean 0.491 pts)

### What changed

- MODEL_REGISTERED edgedesk_cfb_p4_v1.0.0 — first seen by the Model Lab
- MODEL_REGISTERED edgedesk_cfb_v2.1.0 — first seen by the Model Lab
- MODEL_REGISTERED edgedesk_cfb_v2.0.0 — first seen by the Model Lab
- THRESHOLD_CHANGED edgedesk_cfb_v2.1.0 — detected by the hourly lab run (ensemble_version)
- THRESHOLD_CHANGED edgedesk_cfb_v2.0.0 — detected by the hourly lab run (ensemble_version)

### What may be random

- the MAE difference from the reference is within 2 SE: indistinguishable from noise at n=59

### What deserves investigation

- 4 miss(es) classified MODEL_FAILURE (the close was 7+ pts closer)
- 83 miss(es) could not be explained from the available evidence

> Nothing in this report changes a model. Weights, features, thresholds and calibration change only through a pre-registered experiment and a governed release (docs/cfb-lab/RUNBOOK.md).

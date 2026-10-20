# CFB Model Lab — week 7, 2026

Generated 2026-10-20T03:07:41.000Z from the immutable ledger. Champion: `edgedesk_cfb_p4_v1.0.0`. Definitions: docs/cfb-lab/METRICS.md.

## Week summary

| games predicted | snapshots | official predictions | official settled | champion decisions |
|---|---|---|---|---|
| 62 | 1551 | 180 | 180 | PASS 23, LEAN 39 |

## Model performance (official snapshots)

| model | n | MAE | RMSE | bias | Brier | win ECE | 50/80/95% coverage |
|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 62 | 11.16 | 13.80 | -0.29 | 0.2173 | 0.1165 | — / — / — |
| edgedesk_cfb_v2.0.0 | 59 | 11.92 | 14.45 | 0.40 | 0.2293 | 0.1067 | 0.49 / 0.80 / 1.00 |
| edgedesk_cfb_v2.1.0 | 59 | 11.93 | 14.51 | 0.55 | 0.2310 | 0.1145 | 0.49 / 0.80 / 1.00 |

## Market performance (champion)

- EdgeDesk vs opener: mean (|EdgeDesk error| − |opener error|) 0.31 pts (negative = EdgeDesk closer to the result; n=62); EdgeDesk closer in 37.1% of games.
- EdgeDesk vs close: mean (|EdgeDesk error| − |close error|) 0.79 pts (negative = EdgeDesk closer; n=62); EdgeDesk closer in 33.9% of games.
- Market moved toward EdgeDesk: 53.2% of 62 games, mean 0.71 pts.
- Positive CLV: 48.4%, mean CLV -0.14 pts.

## Betting performance (research positions, graded at the snapshot number)

- Record 19-20-0, ATS 48.7%, ROI -7.4% (one unit each, hypothetical), mean CLV -0.28, max drawdown 5.30 u.
- BET decisions: 0 (BET is disabled).

## Submodel performance

| component | n | MAE | bias |
|---|---|---|---|
| ensemble · V1 | 62 | 11.16 | -0.29 |
| B_elo · V2 · candidate 001 | 59 | 11.86 | -1.24 |
| D_gbm · V2.1 · hardened | 59 | 11.89 | 0.82 |
| D_gbm · V2 · candidate 001 | 59 | 11.92 | 0.85 |
| ensemble · V2 · candidate 001 | 59 | 11.92 | 0.40 |
| ensemble · V2.1 · hardened | 59 | 11.93 | 0.55 |
| C_ridge · V2 · candidate 001 | 59 | 11.99 | 0.34 |
| C_ridge · V2.1 · hardened | 59 | 12.01 | 0.28 |
| E_drive · V2 · candidate 001 | 59 | 12.02 | -1.53 |
| A_adj_eff · V2 · candidate 001 | 59 | 12.28 | -0.26 |

## Biggest wins (games the model called better than the closing line)

- Notre Dame @ BYU: predicted -3.2, actual 4 (error 7.2 vs close 14.5)
- Rutgers @ Maryland: predicted -1.6, actual -7 (error 5.5 vs close 12.5)
- Akron @ Miami (OH): predicted 16.0, actual 20 (error 4.0 vs close 10.5)
- Louisville @ Syracuse: predicted -7.7, actual -8 (error 0.3 vs close 6.5)
- UNLV @ Air Force: predicted 4.4, actual 10 (error 5.6 vs close 11.5)

## Biggest misses

- Charlotte @ Temple: predicted 26.9, actual -7 (error 33.9, close 24.5)
- Florida Atlantic @ Army: predicted 6.9, actual 32 (error 25.1, close 29.5)
- Alabama @ Tennessee: predicted -8.7, actual 16 (error 24.7, close 23.5)
- Ohio @ Sacramento State: predicted -16.6, actual -41 (error 24.4, close 23.5)
- Troy @ Louisiana: predicted 3.1, actual 27 (error 23.9, close 24.0)

## Model lessons (one week — recorded, not acted on)

- No segment departed from the prediction by 2 SE with n >= 10.

### What worked

- champion MAE 11.165 vs holdout reference 12.6017 (n=62, z=-1.38)
- the market moved toward the model in 53% of 62 games (mean 0.71 pts)

### What failed

- closer than the closing line in 34% of 62 games (mean |model error| − |close error| 0.794 pts)

### What changed

- CALIBRATION_CHANGED edgedesk_cfb_p4_v1.0.0 — detected by the hourly lab run (calibration_version)

### What may be random

- the MAE difference from the reference is within 2 SE: indistinguishable from noise at n=62

### What deserves investigation

- 4 miss(es) classified MODEL_FAILURE (the close was 7+ pts closer)
- 82 miss(es) could not be explained from the available evidence
- research queue: edgedesk_cfb_v2.0.0: reliability 90-100 has MAE 11.632 vs 80-89 9.347 (> 1 SE): higher reliability is not smaller error

> Nothing in this report changes a model. Weights, features, thresholds and calibration change only through a pre-registered experiment and a governed release (docs/cfb-lab/RUNBOOK.md).

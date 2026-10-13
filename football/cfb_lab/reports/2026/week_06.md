# CFB Model Lab — week 6, 2026

Generated 2026-10-13T03:07:28.000Z from the immutable ledger. Champion: `edgedesk_cfb_p4_v1.0.0`. Definitions: docs/cfb-lab/METRICS.md.

## Week summary

| games predicted | snapshots | official predictions | official settled | champion decisions |
|---|---|---|---|---|
| 58 | 1487 | 174 | 174 | PASS 20, LEAN 38 |

## Model performance (official snapshots)

| model | n | MAE | RMSE | bias | Brier | win ECE | 50/80/95% coverage |
|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 58 | 11.90 | 14.82 | -0.27 | 0.2103 | 0.1460 | — / — / — |
| edgedesk_cfb_v2.0.0 | 58 | 11.37 | 14.70 | 0.67 | 0.2080 | 0.1532 | 0.53 / 0.88 / 0.93 |
| edgedesk_cfb_v2.1.0 | 58 | 11.23 | 14.60 | 0.77 | 0.2064 | 0.0903 | 0.55 / 0.86 / 0.95 |

## Market performance (champion)

- EdgeDesk vs opener: mean (|EdgeDesk error| − |opener error|) 0.35 pts (negative = EdgeDesk closer to the result; n=58); EdgeDesk closer in 48.3% of games.
- EdgeDesk vs close: mean (|EdgeDesk error| − |close error|) 0.45 pts (negative = EdgeDesk closer; n=58); EdgeDesk closer in 39.7% of games.
- Market moved toward EdgeDesk: 58.6% of 58 games, mean 0.94 pts.
- Positive CLV: 37.9%, mean CLV 0.12 pts.

## Betting performance (research positions, graded at the snapshot number)

- Record 17-18-3, ATS 48.6%, ROI -6.4% (one unit each, hypothetical), mean CLV 0.14, max drawdown 7.46 u.
- BET decisions: 0 (BET is disabled).

## Submodel performance

| component | n | MAE | bias |
|---|---|---|---|
| D_gbm · V2.1 · hardened | 58 | 11.19 | 0.77 |
| ensemble · V2.1 · hardened | 58 | 11.23 | 0.77 |
| C_ridge · V2.1 · hardened | 58 | 11.29 | 0.77 |
| D_gbm · V2 · candidate 001 | 58 | 11.32 | 0.75 |
| ensemble · V2 · candidate 001 | 58 | 11.37 | 0.67 |
| C_ridge · V2 · candidate 001 | 58 | 11.38 | 0.69 |
| E_drive · V2 · candidate 001 | 58 | 11.63 | -1.20 |
| ensemble · V1 | 58 | 11.90 | -0.27 |
| B_elo · V2 · candidate 001 | 58 | 12.21 | 1.06 |
| A_adj_eff · V2 · candidate 001 | 58 | 12.51 | -0.75 |

## Biggest wins (games the model called better than the closing line)

- UCLA @ Oregon: predicted 3.5, actual -2 (error 5.5 vs close 12.0)
- Central Michigan @ Ohio: predicted 8.1, actual 17 (error 8.9 vs close 14.5)
- Sam Houston @ Liberty: predicted 18.9, actual 32 (error 13.2 vs close 18.5)
- Texas A&M @ Missouri: predicted 8.7, actual 21 (error 12.3 vs close 17.0)
- Charlotte @ North Texas: predicted 32.1, actual 40 (error 7.8 vs close 12.5)

## Biggest misses

- San Diego State @ Oregon State: predicted 13.1, actual 52 (error 38.9, close 36.5)
- Buffalo @ Toledo: predicted 22.2, actual -15 (error 37.2, close 33.5)
- Ole Miss @ Vanderbilt: predicted -0.2, actual -35 (error 34.8, close 25.5)
- Minnesota @ Purdue: predicted -4.7, actual 28 (error 32.7, close 30.5)
- South Carolina @ Florida: predicted 7.4, actual -19 (error 26.4, close 29.5)

## Model lessons (one week — recorded, not acted on)

- No segment departed from the prediction by 2 SE with n >= 10.

### What worked

- champion MAE 11.898 vs holdout reference 12.6017 (n=58, z=-0.6)
- the market moved toward the model in 59% of 58 games (mean 0.94 pts)

### What failed

- closer than the closing line in 40% of 58 games (mean |model error| − |close error| 0.449 pts)

### What changed

- MODEL_REGISTERED edgedesk_cfb_p4_v1.0.0 — first seen by the Model Lab
- MODEL_REGISTERED edgedesk_cfb_v2.1.0 — first seen by the Model Lab
- MODEL_REGISTERED edgedesk_cfb_v2.0.0 — first seen by the Model Lab
- THRESHOLD_CHANGED edgedesk_cfb_v2.1.0 — detected by the hourly lab run (ensemble_version)
- THRESHOLD_CHANGED edgedesk_cfb_v2.0.0 — detected by the hourly lab run (ensemble_version)

### What may be random

- the MAE difference from the reference is within 2 SE: indistinguishable from noise at n=58

### What deserves investigation

- 5 miss(es) classified MODEL_FAILURE (the close was 7+ pts closer)
- 77 miss(es) could not be explained from the available evidence

> Nothing in this report changes a model. Weights, features, thresholds and calibration change only through a pre-registered experiment and a governed release (docs/cfb-lab/RUNBOOK.md).

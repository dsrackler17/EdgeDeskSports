# CFB Model Lab — week 8, 2026

Generated 2026-10-27T03:07:49.000Z from the immutable ledger. Champion: `edgedesk_cfb_p4_v1.0.0`. Definitions: docs/cfb-lab/METRICS.md.

## Week summary

| games predicted | snapshots | official predictions | official settled | champion decisions |
|---|---|---|---|---|
| 56 | 1841 | 220 | 220 | PASS 29, LEAN 27 |

## Model performance (official snapshots)

| model | n | MAE | RMSE | bias | Brier | win ECE | 50/80/95% coverage |
|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 52 | 11.10 | 13.88 | 2.60 | 0.2316 | 0.0952 | 0.54 / 0.85 / 0.98 |
| edgedesk_cfb_p4_v1.0.0 | 56 | 11.52 | 14.10 | 2.64 | 0.2501 | 0.1643 | — / — / — |
| edgedesk_cfb_v2.0.0 | 56 | 11.65 | 14.21 | 2.69 | 0.2500 | 0.2066 | 0.55 / 0.80 / 0.96 |
| edgedesk_cfb_v2.1.0 | 56 | 11.61 | 14.12 | 2.68 | 0.2493 | 0.2279 | 0.55 / 0.84 / 0.96 |

## Market performance (champion)

- EdgeDesk vs opener: mean (|EdgeDesk error| − |opener error|) 0.45 pts (negative = EdgeDesk closer to the result; n=56); EdgeDesk closer in 50.0% of games.
- EdgeDesk vs close: mean (|EdgeDesk error| − |close error|) 0.79 pts (negative = EdgeDesk closer; n=56); EdgeDesk closer in 44.6% of games.
- Market moved toward EdgeDesk: 53.6% of 56 games, mean 0.97 pts.
- Positive CLV: 42.9%, mean CLV 0.09 pts.

## Betting performance (research positions, graded at the snapshot number)

- Record 10-16-1, ATS 38.5%, ROI -25.9% (one unit each, hypothetical), mean CLV 0.46, max drawdown 10.29 u.
- BET decisions: 0 (BET is disabled).

## Submodel performance

| component | n | MAE | bias |
|---|---|---|---|
| A_adj_eff · V2 · candidate 001 | 56 | 11.07 | 1.25 |
| ensemble · Loop v2.0.0 | 52 | 11.10 | 2.60 |
| E_drive · V2 · candidate 001 | 56 | 11.43 | 1.35 |
| C_ridge · V2.1 · hardened | 56 | 11.45 | 2.74 |
| C_ridge · V2 · candidate 001 | 56 | 11.46 | 2.75 |
| ensemble · V1 | 56 | 11.52 | 2.64 |
| ensemble · V2.1 · hardened | 56 | 11.61 | 2.68 |
| ensemble · V2 · candidate 001 | 56 | 11.65 | 2.69 |
| home_field · Loop v2.0.0 | 52 | 11.66 | 2.32 |
| D_gbm · V2.1 · hardened | 56 | 11.76 | 2.62 |
| D_gbm · V2 · candidate 001 | 56 | 11.82 | 2.63 |
| qb · Loop v2.0.0 | 52 | 11.97 | 4.80 |
| rush_off · Loop v2.0.0 | 52 | 12.09 | 4.66 |
| pass_off · Loop v2.0.0 | 52 | 12.14 | 5.20 |
| B_elo · V2 · candidate 001 | 56 | 12.25 | 2.90 |
| market · Loop v2.0.0 | 52 | 12.29 | 5.22 |
| bye · Loop v2.0.0 | 52 | 12.51 | 5.02 |
| rest · Loop v2.0.0 | 52 | 12.59 | 4.98 |
| covid_2020 · Loop v2.0.0 | 52 | 12.60 | 4.98 |
| division · Loop v2.0.0 | 52 | 12.60 | 4.98 |
| short · Loop v2.0.0 | 52 | 12.60 | 4.98 |
| rush_def · Loop v2.0.0 | 52 | 12.92 | 5.13 |
| pass_def · Loop v2.0.0 | 52 | 13.02 | 5.10 |

## Biggest wins (games the model called better than the closing line)

- Liberty @ Kennesaw State: predicted -13.6, actual -28 (error 14.4 vs close 19.5)
- Vanderbilt @ Kentucky: predicted 15.5, actual 17 (error 1.5 vs close 6.5)
- Pittsburgh @ Miami: predicted 24.8, actual 29 (error 4.2 vs close 8.5)
- Bowling Green @ Buffalo: predicted 6.9, actual 7 (error 0.1 vs close 4.0)
- Massachusetts @ UConn: predicted 15.9, actual 19 (error 3.1 vs close 6.5)

## Biggest misses

- Hawai'i @ Northern Illinois: predicted -5.8, actual -35 (error 29.2, close 32.0)
- Boston College @ Georgia Tech: predicted 6.0, actual -22 (error 27.9, close 28.5)
- Texas Tech @ Cincinnati: predicted -13.7, actual 13 (error 26.7, close 24.5)
- UL Monroe @ Troy: predicted 17.8, actual -7 (error 24.8, close 20.5)
- UTSA @ Tulane: predicted 0.3, actual -23 (error 23.3, close 20.0)

## Model lessons (one week — recorded, not acted on)

- home underdog (home side): 5.741 pts (n=25, z=2.06) — one week; recorded, not acted on

### What worked

- champion MAE 11.517 vs holdout reference 12.6017 (n=56, z=-0.99)
- the market moved toward the model in 54% of 56 games (mean 0.973 pts)

### What failed

- closer than the closing line in 45% of 56 games (mean |model error| − |close error| 0.785 pts)

### What changed

- CALIBRATION_CHANGED edgedesk_cfb_p4_v1.0.0 — detected by the hourly lab run (calibration_version)
- ROLE_CHANGED edgedesk_cfb_loop_v2.0.0 — the model loop's served CFB model, version 2.0.0 (model_loop/adapters/cfb; config af284333): cleared its preregistered walk-forward gate against cfb_p4 (2025 holdout MAE 12.121 vs 12.479, log loss 0.4731 vs 0.4765; 2014-2025 12.785 vs 13.270) and leads V1 as published on 2026 (12.60 to 11.86 MAE, walk-forward, not live). Tracked live from today; the board changes only through promote, on cfb_lab_promotion_v1 over at least 150 common official games.
- RULE_CHANGED config.models.edgedesk_cfb_loop_v2.0.0 — tracked through football/cfb_lab/models.js adapter "loop"
- EXPERIMENT_CREATED EXP-005 — The model loop CFB model 2.0.0 (opponent-adjusted EPA unit ratings, a QB carried through transfers, market rating, fitted FCS levels, key-number distribution) predicts margins more accurately than V1 on live 2026 games, as on its 2025 holdout (-0.36 MAE) and its 2026 walk-forward (-0.74 vs V1 as published).
- MODEL_REGISTERED edgedesk_cfb_loop_v2.0.0 — first seen by the Model Lab
- RULE_CHANGED config.auto_promotion — football/cfb_lab/config.json auto_promotion first read (detected by the hourly lab run, cfb_auto_promotion_v1)
- EXPERIMENT_CREATED EXP-006 — Opening spreads move toward the Loop's W-2 number by the close. Development 2015-19/2021-24: +0.250 pts CLV (3,230 bets); holdout 2025+2026: +0.259 pts, one-sided 99% bound +0.068, permutation p 0.0045 (research/clv_early_week/EXPERIMENTS.md H-4). Expected ROI at the offered price is negative (-3.3%): it beats the close, not the vig.
- EXPERIMENT_CREATED EXP-007 — Opening totals move toward the Loop's W-2 total by the close. Development: +0.713 pts (3,204 bets, shrinking each season since 2015); holdout 2025+2026: +0.418 pts, one-sided 99% bound +0.135, permutation p 0.0005 (EXPERIMENTS.md H-5). Expected ROI at the offered price is negative (-2.6%).
- EXPERIMENT_STATUS EXP-006
- EXPERIMENT_STATUS EXP-007
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)
- THRESHOLD_CHANGED edgedesk_cfb_loop_v2.0.0 — detected by the hourly lab run (params_hash)

### What may be random

- the MAE difference from the reference is within 2 SE: indistinguishable from noise at n=56

### What deserves investigation

- 5 miss(es) classified MODEL_FAILURE (the close was 7+ pts closer)
- 102 miss(es) could not be explained from the available evidence
- research queue: edgedesk_cfb_v2.0.0: reliability 90-100 has MAE 11.413 vs 80-89 9.953 (> 1 SE): higher reliability is not smaller error
- research queue: edgedesk_cfb_p4_v1.0.0: reliability 90-100 has MAE 12.855 vs 70-79 10.536 (> 1 SE): higher reliability is not smaller error

> Nothing in this report changes a model. Weights, features, thresholds and calibration change only through a pre-registered experiment and a governed release (docs/cfb-lab/RUNBOOK.md).

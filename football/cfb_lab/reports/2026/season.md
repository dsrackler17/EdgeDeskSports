# CFB Model Lab — 2026 season to date

Generated 2026-10-17T23:07:35.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 145)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 145 | 12.30 | 15.71 | 0.39 | 34.11 | 0.2090 | — |
| V2 · candidate 001 | 145 | 12.35 | 15.95 | 1.52 | 32.43 | 0.2034 | 0.80 |
| V2.1 · hardened | 145 | 12.32 | 15.93 | 1.58 | 32.41 | 0.2028 | 0.79 |
| opener | 145 | 12.23 | 15.78 | 2.09 | 33.40 | — | — |
| close | 143 | 11.74 | 15.08 | 2.21 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 150 | 12.27 | 15.70 | 0.2021 | 0.1035 | — | 51-46-4 | 52.6% | -0.16 | 40.4% |
| edgedesk_cfb_v2.0.0 | 145 | 12.35 | 15.95 | 0.2034 | 0.0671 | 0.80 | 9-8-1 | 52.9% | 0.00 | 38.9% |
| edgedesk_cfb_v2.1.0 | 145 | 12.32 | 15.93 | 0.2028 | 0.0753 | 0.79 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=145 of 150 needed; MAE difference 0.018 [-0.648, 0.711])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=145 of 150 needed; MAE difference 0.045 [-0.608, 0.720])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1355 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1171 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0894 > 0.06

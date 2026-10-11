# CFB Model Lab — 2026 season to date

Generated 2026-10-11T02:09:38.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 99, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 99 | 13.09 | 16.68 | 0.23 | 35.23 | 0.1925 | — |
| V2 · candidate 001 | 99 | 13.24 | 16.93 | 1.08 | 34.49 | 0.1856 | 0.80 |
| V2.1 · hardened | 99 | 13.21 | 16.87 | 1.11 | 34.86 | 0.1845 | 0.79 |
| opener | 99 | 13.29 | 16.88 | 1.72 | 34.00 | — | — |
| close | 97 | 12.60 | 16.03 | 2.14 | 32.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 102 | 13.11 | 16.74 | 0.1869 | 0.1230 | — | 34-28-3 | 54.8% | -0.05 | 42.9% |
| edgedesk_cfb_v2.0.0 | 99 | 13.24 | 16.93 | 0.1856 | 0.1165 | 0.80 | 5-6-0 | 45.5% | 0.09 | 45.5% |
| edgedesk_cfb_v2.1.0 | 99 | 13.21 | 16.87 | 0.1845 | 0.0850 | 0.79 | 11-9-0 | 55.0% | 0.00 | 45.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=99 of 150 needed; MAE difference 0.116 [-0.692, 0.891])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=99 of 150 needed; MAE difference 0.145 [-0.649, 0.926])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1179 > 0.06

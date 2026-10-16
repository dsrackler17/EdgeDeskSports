# CFB Model Lab — 2026 season to date

Generated 2026-10-16T13:28:39.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 121)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 121 | 12.46 | 15.92 | 0.33 | 34.82 | 0.1960 | — |
| V2 · candidate 001 | 121 | 12.38 | 16.13 | 1.19 | 33.56 | 0.1884 | 0.81 |
| V2.1 · hardened | 121 | 12.33 | 16.07 | 1.25 | 33.44 | 0.1873 | 0.80 |
| opener | 121 | 12.42 | 16.07 | 1.97 | 33.50 | — | — |
| close | 119 | 11.90 | 15.29 | 2.10 | 30.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 124 | 12.48 | 15.99 | 0.1913 | 0.0909 | — | 41-37-4 | 52.6% | -0.06 | 41.3% |
| edgedesk_cfb_v2.0.0 | 121 | 12.38 | 16.13 | 0.1884 | 0.0814 | 0.81 | 8-7-0 | 53.3% | -0.03 | 40.0% |
| edgedesk_cfb_v2.1.0 | 121 | 12.33 | 16.07 | 0.1873 | 0.0669 | 0.80 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=121 of 150 needed; MAE difference -0.129 [-0.853, 0.578])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=121 of 150 needed; MAE difference -0.077 [-0.789, 0.615])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1252 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0728 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0955 > 0.06

# CFB Model Lab — 2026 season to date

Generated 2026-10-14T03:07:30.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 115)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 115 | 12.56 | 16.07 | 0.16 | 34.93 | 0.1948 | — |
| V2 · candidate 001 | 115 | 12.40 | 16.20 | 1.02 | 33.80 | 0.1863 | 0.82 |
| V2.1 · hardened | 115 | 12.35 | 16.14 | 1.08 | 33.84 | 0.1852 | 0.81 |
| opener | 115 | 12.47 | 16.15 | 1.76 | 33.65 | — | — |
| close | 113 | 11.96 | 15.38 | 1.94 | 31.30 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 118 | 12.59 | 16.14 | 0.1899 | 0.0934 | — | 39-35-4 | 52.7% | -0.06 | 39.5% |
| edgedesk_cfb_v2.0.0 | 115 | 12.40 | 16.20 | 0.1863 | 0.0925 | 0.82 | 8-6-0 | 57.1% | 0.04 | 42.9% |
| edgedesk_cfb_v2.1.0 | 115 | 12.35 | 16.14 | 0.1852 | 0.0625 | 0.81 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=115 of 150 needed; MAE difference -0.213 [-0.941, 0.540])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=115 of 150 needed; MAE difference -0.164 [-0.885, 0.575])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.114 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0626 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1098 > 0.06

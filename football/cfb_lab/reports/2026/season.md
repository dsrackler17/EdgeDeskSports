# CFB Model Lab — 2026 season to date

Generated 2026-10-31T23:07:59.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 87, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 87 | 12.26 | 15.37 | 2.84 | 30.11 | 0.2140 | 0.82 |
| V1 | 87 | 12.28 | 15.18 | 2.63 | 28.05 | 0.2200 | — |
| V2 · candidate 001 | 87 | 11.96 | 14.96 | 2.62 | 27.15 | 0.2120 | 0.79 |
| V2.1 · hardened | 87 | 11.92 | 14.91 | 2.67 | 27.21 | 0.2118 | 0.83 |
| opener | 87 | 11.88 | 14.71 | 3.03 | 28.20 | — | — |
| close | 87 | 11.52 | 14.40 | 2.76 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 87 | 12.26 | 15.37 | 0.2140 | 0.0604 | 0.82 | 17-27-1 | 38.6% | 0.14 | 51.1% |
| edgedesk_cfb_p4_v1.0.0 | 270 | 12.18 | 15.30 | 0.2074 | 0.0729 | — | 79-82-5 | 49.1% | -0.02 | 41.5% |
| edgedesk_cfb_v2.0.0 | 264 | 12.19 | 15.40 | 0.2065 | 0.0624 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 264 | 12.16 | 15.38 | 0.2063 | 0.0537 | 0.81 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=264 of 150 needed; MAE difference -0.039 [-0.488, 0.425])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=264 of 150 needed; MAE difference -0.008 [-0.453, 0.452])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=87 of 150 needed; MAE difference -0.025 [-1.030, 0.974])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.078 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.114 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1013 > 0.06

# CFB Model Lab — 2026 season to date

Generated 2026-10-31T20:08:00.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 71, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 71 | 12.23 | 15.33 | 2.34 | 29.97 | 0.2264 | 0.82 |
| V1 | 71 | 12.62 | 15.67 | 2.43 | 28.16 | 0.2385 | — |
| V2 · candidate 001 | 71 | 12.43 | 15.46 | 2.55 | 29.20 | 0.2338 | 0.77 |
| V2.1 · hardened | 71 | 12.39 | 15.41 | 2.58 | 29.32 | 0.2333 | 0.82 |
| opener | 71 | 12.00 | 14.86 | 2.61 | 27.50 | — | — |
| close | 71 | 11.78 | 14.68 | 2.29 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 71 | 12.23 | 15.33 | 0.2264 | 0.1100 | 0.82 | 15-19-1 | 44.1% | 0.29 | 48.6% |
| edgedesk_cfb_p4_v1.0.0 | 254 | 12.27 | 15.45 | 0.2117 | 0.0756 | — | 74-77-5 | 49.0% | -0.02 | 42.9% |
| edgedesk_cfb_v2.0.0 | 248 | 12.34 | 15.57 | 0.2123 | 0.0735 | 0.80 | 16-20-1 | 44.4% | 0.01 | 40.5% |
| edgedesk_cfb_v2.1.0 | 248 | 12.31 | 15.55 | 0.2121 | 0.0610 | 0.81 | 19-17-0 | 52.8% | -0.04 | 47.2% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=248 of 150 needed; MAE difference 0.023 [-0.470, 0.509])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=248 of 150 needed; MAE difference 0.052 [-0.432, 0.526])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=71 of 150 needed; MAE difference -0.387 [-1.425, 0.646])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0905 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1055 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1068 > 0.06

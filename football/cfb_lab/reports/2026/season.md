# CFB Model Lab — 2026 season to date

Generated 2026-10-29T03:08:00.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 55, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 55 | 11.41 | 14.06 | 2.09 | 24.51 | 0.2329 | 0.85 |
| V1 | 55 | 11.85 | 14.38 | 2.07 | 25.33 | 0.2473 | — |
| V2 · candidate 001 | 55 | 11.93 | 14.53 | 2.21 | 27.09 | 0.2458 | 0.78 |
| V2.1 · hardened | 55 | 11.87 | 14.41 | 2.23 | 26.92 | 0.2444 | 0.84 |
| opener | 55 | 11.24 | 13.51 | 2.13 | 24.95 | — | — |
| close | 55 | 10.94 | 13.35 | 1.65 | 23.80 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 55 | 11.41 | 14.06 | 0.2329 | 0.0777 | 0.85 | 11-13-1 | 45.8% | 0.32 | 48.0% |
| edgedesk_cfb_p4_v1.0.0 | 238 | 12.06 | 15.14 | 0.2120 | 0.0723 | — | 68-72-5 | 48.6% | -0.05 | 43.4% |
| edgedesk_cfb_v2.0.0 | 232 | 12.21 | 15.37 | 0.2137 | 0.0796 | 0.81 | 13-20-1 | 39.4% | 0.09 | 44.1% |
| edgedesk_cfb_v2.1.0 | 232 | 12.18 | 15.33 | 0.2133 | 0.0682 | 0.81 | 17-17-0 | 50.0% | 0.01 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=232 of 150 needed; MAE difference 0.096 [-0.407, 0.596])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=232 of 150 needed; MAE difference 0.132 [-0.363, 0.625])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=55 of 150 needed; MAE difference -0.445 [-1.554, 0.646])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.096 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1316 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.66x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1318 > 0.06

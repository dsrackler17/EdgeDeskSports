# CFB Model Lab — 2026 season to date

Generated 2026-10-28T03:07:49.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 53, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 53 | 11.23 | 13.96 | 2.21 | 24.60 | 0.2339 | 0.85 |
| V1 | 53 | 11.64 | 14.24 | 2.26 | 25.52 | 0.2473 | — |
| V2 · candidate 001 | 53 | 11.69 | 14.35 | 2.36 | 27.10 | 0.2452 | 0.79 |
| V2.1 · hardened | 53 | 11.62 | 14.24 | 2.38 | 26.97 | 0.2439 | 0.83 |
| opener | 53 | 11.03 | 13.37 | 2.27 | 25.10 | — | — |
| close | 53 | 10.79 | 13.29 | 1.70 | 23.90 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 53 | 11.23 | 13.96 | 0.2339 | 0.0827 | 0.85 | 11-13-1 | 45.8% | 0.32 | 48.0% |
| edgedesk_cfb_p4_v1.0.0 | 236 | 12.02 | 15.12 | 0.2117 | 0.0765 | — | 68-71-5 | 48.9% | -0.02 | 43.7% |
| edgedesk_cfb_v2.0.0 | 230 | 12.16 | 15.34 | 0.2133 | 0.0813 | 0.81 | 13-20-1 | 39.4% | 0.09 | 44.1% |
| edgedesk_cfb_v2.1.0 | 230 | 12.12 | 15.30 | 0.2129 | 0.0697 | 0.81 | 17-17-0 | 50.0% | 0.01 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=230 of 150 needed; MAE difference 0.089 [-0.438, 0.591])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=230 of 150 needed; MAE difference 0.124 [-0.402, 0.619])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=53 of 150 needed; MAE difference -0.417 [-1.593, 0.711])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1115 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1326 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1329 > 0.06

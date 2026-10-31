# CFB Model Lab — 2026 season to date

Generated 2026-10-31T13:07:54.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 61, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 61 | 12.19 | 15.15 | 1.00 | 29.79 | 0.2411 | 0.82 |
| V1 | 61 | 12.75 | 15.49 | 0.94 | 27.97 | 0.2541 | — |
| V2 · candidate 001 | 61 | 12.54 | 15.35 | 1.09 | 27.20 | 0.2501 | 0.77 |
| V2.1 · hardened | 61 | 12.49 | 15.26 | 1.12 | 27.25 | 0.2490 | 0.82 |
| opener | 61 | 12.06 | 14.61 | 1.21 | 26.50 | — | — |
| close | 61 | 11.67 | 14.31 | 0.66 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 61 | 12.19 | 15.15 | 0.2411 | 0.1048 | 0.82 | 12-16-1 | 42.9% | 0.26 | 48.3% |
| edgedesk_cfb_p4_v1.0.0 | 244 | 12.28 | 15.40 | 0.2145 | 0.0795 | — | 68-76-5 | 47.2% | -0.05 | 42.9% |
| edgedesk_cfb_v2.0.0 | 238 | 12.36 | 15.55 | 0.2156 | 0.0805 | 0.80 | 15-20-1 | 42.9% | 0.04 | 41.7% |
| edgedesk_cfb_v2.1.0 | 238 | 12.33 | 15.52 | 0.2152 | 0.0644 | 0.81 | 18-17-0 | 51.4% | -0.01 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=238 of 150 needed; MAE difference 0.024 [-0.478, 0.525])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=238 of 150 needed; MAE difference 0.056 [-0.434, 0.555])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=61 of 150 needed; MAE difference -0.557 [-1.656, 0.514])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1146 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1263 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1385 > 0.06

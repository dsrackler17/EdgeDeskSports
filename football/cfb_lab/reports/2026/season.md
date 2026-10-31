# CFB Model Lab — 2026 season to date

Generated 2026-10-31T00:07:56.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 58, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 58 | 11.67 | 14.28 | 1.13 | 24.63 | 0.2373 | 0.84 |
| V1 | 58 | 12.22 | 14.76 | 0.98 | 26.85 | 0.2531 | — |
| V2 · candidate 001 | 58 | 12.09 | 14.63 | 1.31 | 27.06 | 0.2492 | 0.79 |
| V2.1 · hardened | 58 | 12.02 | 14.51 | 1.34 | 26.85 | 0.2477 | 0.84 |
| opener | 58 | 11.47 | 13.73 | 1.21 | 24.73 | — | — |
| close | 58 | 11.25 | 13.65 | 0.68 | 23.65 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 58 | 11.67 | 14.28 | 0.2373 | 0.0932 | 0.84 | 12-14-1 | 46.2% | 0.30 | 48.1% |
| edgedesk_cfb_p4_v1.0.0 | 241 | 12.15 | 15.22 | 0.2138 | 0.0760 | — | 68-74-5 | 47.9% | -0.04 | 43.5% |
| edgedesk_cfb_v2.0.0 | 235 | 12.25 | 15.38 | 0.2149 | 0.0829 | 0.81 | 14-20-1 | 41.2% | 0.06 | 42.9% |
| edgedesk_cfb_v2.1.0 | 235 | 12.21 | 15.34 | 0.2145 | 0.0716 | 0.82 | 18-17-0 | 51.4% | -0.01 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=235 of 150 needed; MAE difference 0.043 [-0.467, 0.554])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=235 of 150 needed; MAE difference 0.080 [-0.429, 0.585])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=58 of 150 needed; MAE difference -0.551 [-1.738, 0.552])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1185 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1477 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1479 > 0.06

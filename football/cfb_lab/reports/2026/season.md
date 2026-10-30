# CFB Model Lab — 2026 season to date

Generated 2026-10-30T00:07:53.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 56, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 56 | 11.64 | 14.31 | 1.61 | 24.70 | 0.2335 | 0.84 |
| V1 | 56 | 11.99 | 14.49 | 1.68 | 25.23 | 0.2455 | — |
| V2 · candidate 001 | 56 | 12.06 | 14.62 | 1.82 | 27.08 | 0.2440 | 0.79 |
| V2.1 · hardened | 56 | 12.00 | 14.52 | 1.84 | 26.90 | 0.2427 | 0.84 |
| opener | 56 | 11.41 | 13.68 | 1.71 | 24.88 | — | — |
| close | 56 | 11.12 | 13.52 | 1.24 | 23.75 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 56 | 11.64 | 14.31 | 0.2335 | 0.0855 | 0.84 | 11-14-1 | 44.0% | 0.31 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 239 | 12.10 | 15.16 | 0.2117 | 0.0732 | — | 68-72-5 | 48.6% | -0.05 | 43.4% |
| edgedesk_cfb_v2.0.0 | 233 | 12.24 | 15.38 | 0.2134 | 0.0809 | 0.81 | 13-20-1 | 39.4% | 0.09 | 44.1% |
| edgedesk_cfb_v2.1.0 | 233 | 12.21 | 15.35 | 0.2130 | 0.0695 | 0.82 | 17-17-0 | 50.0% | 0.01 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=233 of 150 needed; MAE difference 0.094 [-0.418, 0.592])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=233 of 150 needed; MAE difference 0.129 [-0.374, 0.620])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=56 of 150 needed; MAE difference -0.350 [-1.499, 0.763])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1056 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1421 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.67x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1424 > 0.06

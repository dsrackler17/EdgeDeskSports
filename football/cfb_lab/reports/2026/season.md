# CFB Model Lab — 2026 season to date

Generated 2026-10-24T23:07:48.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 30, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 30 | 10.62 | 13.53 | 1.44 | 23.95 | 0.2227 | 0.83 |
| V1 | 30 | 10.76 | 14.05 | 1.98 | 27.37 | 0.2312 | — |
| V2 · candidate 001 | 30 | 11.62 | 14.62 | 2.02 | 29.40 | 0.2430 | 0.80 |
| V2.1 · hardened | 30 | 11.52 | 14.53 | 1.99 | 29.52 | 0.2419 | 0.87 |
| opener | 30 | 10.88 | 13.42 | 1.32 | 25.60 | — | — |
| close | 30 | 10.68 | 13.67 | 1.15 | 26.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 30 | 10.62 | 13.53 | 0.2227 | 0.1695 | 0.83 | 9-6-1 | 60.0% | 0.41 | 43.8% |
| edgedesk_cfb_p4_v1.0.0 | 213 | 11.94 | 15.19 | 0.2056 | 0.0790 | — | 63-62-5 | 50.4% | -0.04 | 46.1% |
| edgedesk_cfb_v2.0.0 | 207 | 12.20 | 15.48 | 0.2094 | 0.0720 | 0.81 | 10-17-1 | 37.0% | 0.13 | 46.4% |
| edgedesk_cfb_v2.1.0 | 207 | 12.16 | 15.45 | 0.2092 | 0.0725 | 0.82 | 15-14-0 | 51.7% | 0.03 | 51.7% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=207 of 150 needed; MAE difference 0.214 [-0.309, 0.753])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=207 of 150 needed; MAE difference 0.250 [-0.266, 0.787])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=30 of 150 needed; MAE difference -0.143 [-1.616, 1.340])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1035 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0971 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.65x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1061 > 0.06
- **variance_shift** (edgedesk_cfb_v2.0.0) variance of predicted margins is 0.66x the reference

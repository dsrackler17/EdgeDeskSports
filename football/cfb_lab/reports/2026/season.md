# CFB Model Lab — 2026 season to date

Generated 2026-10-29T01:07:55.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 54, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 54 | 11.30 | 13.99 | 2.45 | 24.55 | 0.2320 | 0.85 |
| V1 | 54 | 11.69 | 14.24 | 2.49 | 25.43 | 0.2447 | — |
| V2 · candidate 001 | 54 | 11.78 | 14.40 | 2.62 | 27.10 | 0.2435 | 0.80 |
| V2.1 · hardened | 54 | 11.71 | 14.29 | 2.64 | 26.94 | 0.2422 | 0.83 |
| opener | 54 | 11.10 | 13.40 | 2.51 | 25.02 | — | — |
| close | 54 | 10.87 | 13.32 | 1.94 | 23.85 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 54 | 11.30 | 13.99 | 0.2320 | 0.0805 | 0.85 | 11-13-1 | 45.8% | 0.32 | 48.0% |
| edgedesk_cfb_p4_v1.0.0 | 237 | 12.03 | 15.12 | 0.2112 | 0.0749 | — | 68-71-5 | 48.9% | -0.02 | 43.7% |
| edgedesk_cfb_v2.0.0 | 231 | 12.18 | 15.34 | 0.2130 | 0.0826 | 0.81 | 13-20-1 | 39.4% | 0.09 | 44.1% |
| edgedesk_cfb_v2.1.0 | 231 | 12.14 | 15.30 | 0.2126 | 0.0711 | 0.81 | 17-17-0 | 50.0% | 0.01 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=231 of 150 needed; MAE difference 0.099 [-0.405, 0.598])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=231 of 150 needed; MAE difference 0.133 [-0.367, 0.627])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=54 of 150 needed; MAE difference -0.395 [-1.534, 0.738])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1003 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1334 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.66x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1337 > 0.06

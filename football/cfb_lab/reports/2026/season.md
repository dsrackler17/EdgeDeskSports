# CFB Model Lab — 2026 season to date

Generated 2026-10-26T11:07:42.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 52, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 52 | 11.10 | 13.88 | 2.60 | 24.65 | 0.2316 | 0.85 |
| V1 | 52 | 11.54 | 14.18 | 2.64 | 25.61 | 0.2454 | — |
| V2 · candidate 001 | 52 | 11.58 | 14.30 | 2.73 | 27.11 | 0.2435 | 0.79 |
| V2.1 · hardened | 52 | 11.53 | 14.19 | 2.74 | 26.99 | 0.2425 | 0.83 |
| opener | 52 | 11.02 | 13.40 | 2.54 | 25.18 | — | — |
| close | 52 | 10.70 | 13.24 | 2.03 | 23.95 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 52 | 11.10 | 13.88 | 0.2316 | 0.0952 | 0.85 | 11-12-1 | 47.8% | 0.33 | 45.8% |
| edgedesk_cfb_p4_v1.0.0 | 235 | 12.00 | 15.11 | 0.2111 | 0.0765 | — | 68-71-5 | 48.9% | -0.02 | 43.7% |
| edgedesk_cfb_v2.0.0 | 229 | 12.14 | 15.33 | 0.2128 | 0.0791 | 0.81 | 13-20-1 | 39.4% | 0.09 | 44.1% |
| edgedesk_cfb_v2.1.0 | 229 | 12.11 | 15.29 | 0.2124 | 0.0680 | 0.81 | 17-17-0 | 50.0% | 0.01 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=229 of 150 needed; MAE difference 0.093 [-0.413, 0.598])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=229 of 150 needed; MAE difference 0.126 [-0.378, 0.623])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=52 of 150 needed; MAE difference -0.439 [-1.630, 0.776])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1142 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1244 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1246 > 0.06

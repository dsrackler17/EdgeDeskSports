# CFB Model Lab — 2026 season to date

Generated 2026-10-31T21:07:59.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 73, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 73 | 12.43 | 15.46 | 2.31 | 29.93 | 0.2267 | 0.81 |
| V1 | 73 | 12.66 | 15.64 | 2.42 | 28.14 | 0.2354 | — |
| V2 · candidate 001 | 73 | 12.47 | 15.43 | 2.58 | 28.80 | 0.2305 | 0.78 |
| V2.1 · hardened | 73 | 12.44 | 15.38 | 2.60 | 28.90 | 0.2302 | 0.82 |
| opener | 73 | 12.07 | 14.87 | 2.66 | 27.30 | — | — |
| close | 73 | 11.86 | 14.70 | 2.36 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 73 | 12.43 | 15.46 | 0.2267 | 0.0973 | 0.81 | 15-21-1 | 41.7% | 0.30 | 51.3% |
| edgedesk_cfb_p4_v1.0.0 | 256 | 12.28 | 15.44 | 0.2111 | 0.0761 | — | 74-77-5 | 49.0% | -0.02 | 42.9% |
| edgedesk_cfb_v2.0.0 | 250 | 12.35 | 15.56 | 0.2115 | 0.0703 | 0.80 | 16-20-1 | 44.4% | 0.01 | 40.5% |
| edgedesk_cfb_v2.1.0 | 250 | 12.32 | 15.54 | 0.2114 | 0.0608 | 0.81 | 19-17-0 | 52.8% | -0.04 | 47.2% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=250 of 150 needed; MAE difference 0.020 [-0.474, 0.490])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=250 of 150 needed; MAE difference 0.049 [-0.436, 0.517])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=73 of 150 needed; MAE difference -0.232 [-1.257, 0.791])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0894 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0981 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0993 > 0.06

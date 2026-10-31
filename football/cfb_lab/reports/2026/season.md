# CFB Model Lab — 2026 season to date

Generated 2026-10-31T20:17:01.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 72, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 72 | 12.35 | 15.42 | 2.60 | 29.95 | 0.2244 | 0.81 |
| V1 | 72 | 12.67 | 15.68 | 2.62 | 28.15 | 0.2356 | — |
| V2 · candidate 001 | 72 | 12.50 | 15.49 | 2.76 | 29.00 | 0.2311 | 0.78 |
| V2.1 · hardened | 72 | 12.46 | 15.44 | 2.78 | 29.11 | 0.2307 | 0.82 |
| opener | 72 | 12.10 | 14.93 | 2.84 | 27.40 | — | — |
| close | 72 | 11.89 | 14.75 | 2.53 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 72 | 12.35 | 15.42 | 0.2244 | 0.1045 | 0.81 | 15-20-1 | 42.9% | 0.31 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 255 | 12.28 | 15.46 | 0.2110 | 0.0745 | — | 74-77-5 | 49.0% | -0.02 | 42.9% |
| edgedesk_cfb_v2.0.0 | 249 | 12.36 | 15.58 | 0.2117 | 0.0724 | 0.80 | 16-20-1 | 44.4% | 0.01 | 40.5% |
| edgedesk_cfb_v2.1.0 | 249 | 12.33 | 15.55 | 0.2114 | 0.0599 | 0.81 | 19-17-0 | 52.8% | -0.04 | 47.2% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=249 of 150 needed; MAE difference 0.025 [-0.464, 0.515])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=249 of 150 needed; MAE difference 0.056 [-0.431, 0.540])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=72 of 150 needed; MAE difference -0.323 [-1.428, 0.724])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0932 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1064 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1074 > 0.06

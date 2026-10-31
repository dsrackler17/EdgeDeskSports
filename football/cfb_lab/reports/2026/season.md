# CFB Model Lab — 2026 season to date

Generated 2026-10-31T22:07:49.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 75, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 75 | 12.40 | 15.42 | 2.05 | 29.90 | 0.2306 | 0.81 |
| V1 | 75 | 12.70 | 15.65 | 2.15 | 28.13 | 0.2416 | — |
| V2 · candidate 001 | 75 | 12.46 | 15.40 | 2.32 | 28.40 | 0.2348 | 0.79 |
| V2.1 · hardened | 75 | 12.42 | 15.35 | 2.33 | 28.49 | 0.2343 | 0.83 |
| opener | 75 | 12.07 | 14.83 | 2.45 | 27.10 | — | — |
| close | 75 | 11.74 | 14.60 | 2.10 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 75 | 12.40 | 15.42 | 0.2306 | 0.1046 | 0.81 | 15-23-1 | 39.5% | 0.22 | 48.7% |
| edgedesk_cfb_p4_v1.0.0 | 258 | 12.29 | 15.45 | 0.2131 | 0.0808 | — | 74-79-5 | 48.4% | -0.04 | 42.3% |
| edgedesk_cfb_v2.0.0 | 252 | 12.35 | 15.55 | 0.2130 | 0.0649 | 0.81 | 16-21-1 | 43.2% | -0.03 | 39.5% |
| edgedesk_cfb_v2.1.0 | 252 | 12.32 | 15.53 | 0.2127 | 0.0609 | 0.81 | 19-17-0 | 52.8% | -0.04 | 47.2% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=252 of 150 needed; MAE difference 0.003 [-0.470, 0.485])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=252 of 150 needed; MAE difference 0.034 [-0.428, 0.512])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=75 of 150 needed; MAE difference -0.292 [-1.353, 0.744])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0982 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0954 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0965 > 0.06

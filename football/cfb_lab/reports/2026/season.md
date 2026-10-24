# CFB Model Lab — 2026 season to date

Generated 2026-10-24T23:40:57.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 34, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 34 | 10.79 | 13.63 | 0.99 | 23.95 | 0.2387 | 0.82 |
| V1 | 34 | 11.34 | 14.40 | 1.36 | 27.11 | 0.2521 | — |
| V2 · candidate 001 | 34 | 11.68 | 14.48 | 1.34 | 28.60 | 0.2520 | 0.79 |
| V2.1 · hardened | 34 | 11.59 | 14.39 | 1.34 | 28.70 | 0.2507 | 0.85 |
| opener | 34 | 11.06 | 13.57 | 0.85 | 25.20 | — | — |
| close | 34 | 10.60 | 13.54 | 0.60 | 25.90 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 34 | 10.79 | 13.63 | 0.2387 | 0.1666 | 0.82 | 9-8-1 | 52.9% | 0.36 | 38.9% |
| edgedesk_cfb_p4_v1.0.0 | 217 | 12.01 | 15.22 | 0.2093 | 0.0812 | — | 63-66-5 | 48.8% | -0.04 | 45.5% |
| edgedesk_cfb_v2.0.0 | 211 | 12.20 | 15.44 | 0.2115 | 0.0692 | 0.81 | 10-17-1 | 37.0% | 0.13 | 46.4% |
| edgedesk_cfb_v2.1.0 | 211 | 12.16 | 15.41 | 0.2112 | 0.0690 | 0.82 | 15-14-0 | 51.7% | 0.03 | 51.7% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=211 of 150 needed; MAE difference 0.142 [-0.367, 0.688])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=211 of 150 needed; MAE difference 0.178 [-0.326, 0.719])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=34 of 150 needed; MAE difference -0.554 [-1.908, 0.843])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1257 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1018 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.66x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1013 > 0.06

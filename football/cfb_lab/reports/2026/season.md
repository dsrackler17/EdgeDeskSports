# CFB Model Lab — 2026 season to date

Generated 2026-11-01T01:07:50.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 94, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 94 | 12.06 | 15.20 | 1.97 | 30.07 | 0.2065 | 0.82 |
| V1 | 94 | 12.08 | 14.90 | 1.95 | 28.01 | 0.2090 | — |
| V2 · candidate 001 | 94 | 11.81 | 14.75 | 1.94 | 27.10 | 0.2036 | 0.80 |
| V2.1 · hardened | 94 | 11.77 | 14.70 | 2.00 | 27.16 | 0.2032 | 0.83 |
| opener | 94 | 11.78 | 14.57 | 2.25 | 27.85 | — | — |
| close | 94 | 11.39 | 14.24 | 2.00 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 94 | 12.06 | 15.20 | 0.2065 | 0.0669 | 0.82 | 21-29-1 | 42.0% | 0.13 | 49.0% |
| edgedesk_cfb_p4_v1.0.0 | 277 | 12.11 | 15.21 | 0.2040 | 0.0654 | — | 81-82-5 | 49.7% | -0.02 | 41.6% |
| edgedesk_cfb_v2.0.0 | 271 | 12.13 | 15.32 | 0.2037 | 0.0568 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 271 | 12.10 | 15.29 | 0.2035 | 0.0500 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=271 of 150 needed; MAE difference -0.028 [-0.488, 0.430])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=271 of 150 needed; MAE difference 0.003 [-0.455, 0.460])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=94 of 150 needed; MAE difference -0.026 [-0.940, 0.938])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0686 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1144 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0842 > 0.06

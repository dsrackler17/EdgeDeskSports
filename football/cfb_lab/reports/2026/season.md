# CFB Model Lab — 2026 season to date

Generated 2026-11-01T02:07:51.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 96, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 96 | 11.92 | 15.07 | 2.04 | 30.05 | 0.2051 | 0.82 |
| V1 | 96 | 12.02 | 14.81 | 2.10 | 28.00 | 0.2091 | — |
| V2 · candidate 001 | 96 | 11.72 | 14.64 | 2.05 | 27.08 | 0.2029 | 0.80 |
| V2.1 · hardened | 96 | 11.68 | 14.59 | 2.11 | 27.14 | 0.2026 | 0.83 |
| opener | 96 | 11.70 | 14.47 | 2.37 | 27.75 | — | — |
| close | 96 | 11.30 | 14.14 | 2.10 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 96 | 11.92 | 15.07 | 0.2051 | 0.0661 | 0.82 | 21-29-1 | 42.0% | 0.13 | 49.0% |
| edgedesk_cfb_p4_v1.0.0 | 279 | 12.09 | 15.18 | 0.2041 | 0.0657 | — | 81-83-5 | 49.4% | -0.02 | 41.3% |
| edgedesk_cfb_v2.0.0 | 273 | 12.10 | 15.28 | 0.2034 | 0.0594 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 273 | 12.07 | 15.25 | 0.2033 | 0.0501 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=273 of 150 needed; MAE difference -0.041 [-0.489, 0.415])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=273 of 150 needed; MAE difference -0.010 [-0.457, 0.443])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=96 of 150 needed; MAE difference -0.103 [-1.042, 0.868])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0766 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1207 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0967 > 0.06

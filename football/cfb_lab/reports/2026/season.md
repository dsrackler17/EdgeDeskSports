# CFB Model Lab — 2026 season to date

Generated 2026-10-31T23:41:56.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 93, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 93 | 11.92 | 15.06 | 2.26 | 30.07 | 0.2037 | 0.83 |
| V1 | 93 | 12.03 | 14.88 | 2.15 | 28.02 | 0.2085 | — |
| V2 · candidate 001 | 93 | 11.72 | 14.67 | 2.18 | 27.10 | 0.2019 | 0.81 |
| V2.1 · hardened | 93 | 11.68 | 14.63 | 2.24 | 27.17 | 0.2017 | 0.84 |
| opener | 93 | 11.67 | 14.46 | 2.52 | 27.90 | — | — |
| close | 93 | 11.30 | 14.16 | 2.24 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 93 | 11.92 | 15.06 | 0.2037 | 0.0651 | 0.83 | 21-28-1 | 42.9% | 0.13 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 276 | 12.09 | 15.20 | 0.2038 | 0.0674 | — | 80-82-5 | 49.4% | -0.02 | 41.8% |
| edgedesk_cfb_v2.0.0 | 270 | 12.10 | 15.30 | 0.2031 | 0.0592 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 270 | 12.07 | 15.27 | 0.2029 | 0.0507 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=270 of 150 needed; MAE difference -0.040 [-0.519, 0.403])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=270 of 150 needed; MAE difference -0.010 [-0.487, 0.428])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=93 of 150 needed; MAE difference -0.110 [-1.086, 0.861])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0766 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1161 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0978 > 0.06

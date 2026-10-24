# CFB Model Lab — 2026 season to date

Generated 2026-10-24T04:07:43.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 6, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 6 | 8.96 | 11.02 | -3.04 | 19.41 | 0.2158 | 0.83 |
| V1 | 6 | 8.08 | 11.12 | 1.50 | 20.36 | 0.2206 | — |
| V2 · candidate 001 | 6 | 7.63 | 9.87 | 0.94 | 15.56 | 0.1965 | 1.00 |
| V2.1 · hardened | 6 | 7.57 | 9.66 | 0.90 | 15.22 | 0.1929 | 1.00 |
| opener | 6 | 8.83 | 10.73 | -3.17 | 18.00 | — | — |
| close | 6 | 8.67 | 10.86 | -1.33 | 18.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 6 | 8.96 | 11.02 | 0.2158 | 0.4337 | 0.83 | 2-2-0 | 50.0% | 0.25 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 189 | 12.00 | 15.25 | 0.2020 | 0.0626 | — | 60-56-4 | 51.7% | -0.10 | 43.2% |
| edgedesk_cfb_v2.0.0 | 183 | 12.15 | 15.46 | 0.2035 | 0.0548 | 0.82 | 10-14-1 | 41.7% | 0.06 | 40.0% |
| edgedesk_cfb_v2.1.0 | 183 | 12.12 | 15.44 | 0.2032 | 0.0694 | 0.81 | 15-11-0 | 57.7% | -0.04 | 46.2% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=183 of 150 needed; MAE difference 0.101 [-0.475, 0.674])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=183 of 150 needed; MAE difference 0.129 [-0.433, 0.690])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=6 of 150 needed; MAE difference 0.878 [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0963 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0658 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1021 > 0.06

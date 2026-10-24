# CFB Model Lab — 2026 season to date

Generated 2026-10-24T14:07:47.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 8, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 8 | 11.62 | 13.68 | 2.62 | 21.57 | 0.3009 | 0.88 |
| V1 | 8 | 10.00 | 12.94 | 5.07 | 22.68 | 0.2845 | — |
| V2 · candidate 001 | 8 | 9.63 | 12.17 | 4.61 | 20.50 | 0.2605 | 0.88 |
| V2.1 · hardened | 8 | 9.67 | 12.14 | 4.66 | 20.51 | 0.2602 | 0.88 |
| opener | 8 | 10.50 | 12.36 | 1.50 | 20.15 | — | — |
| close | 8 | 10.31 | 12.34 | 2.81 | 19.82 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 8 | 11.62 | 13.68 | 0.3009 | 0.4193 | 0.88 | 2-3-0 | 40.0% | 0.40 | 60.0% |
| edgedesk_cfb_p4_v1.0.0 | 191 | 12.04 | 15.27 | 0.2049 | 0.0691 | — | 60-57-4 | 51.3% | -0.09 | 43.7% |
| edgedesk_cfb_v2.0.0 | 185 | 12.19 | 15.48 | 0.2062 | 0.0548 | 0.82 | 10-15-1 | 40.0% | 0.08 | 42.3% |
| edgedesk_cfb_v2.1.0 | 185 | 12.16 | 15.47 | 0.2061 | 0.0691 | 0.81 | 15-12-0 | 55.6% | -0.02 | 48.1% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=185 of 150 needed; MAE difference 0.102 [-0.470, 0.669])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=185 of 150 needed; MAE difference 0.126 [-0.437, 0.685])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=8 of 150 needed; MAE difference 1.616 [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1145 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.079 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1229 > 0.06

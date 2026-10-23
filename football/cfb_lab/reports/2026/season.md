# CFB Model Lab — 2026 season to date

Generated 2026-10-23T03:07:49.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 2, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 2 | 16.52 | 17.50 | -5.79 | 21.73 | 0.2982 | 0.50 |
| V1 | 2 | 18.36 | 18.79 | 3.99 | 21.95 | 0.4268 | — |
| V2 · candidate 001 | 2 | 15.49 | 15.49 | -0.15 | 15.63 | 0.3231 | 1.00 |
| V2.1 · hardened | 2 | 15.21 | 15.21 | -0.01 | 15.22 | 0.3200 | 1.00 |
| opener | 2 | 16.50 | 16.77 | -3.00 | 19.20 | — | — |
| close | 2 | 17.50 | 17.61 | -2.00 | 19.30 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 2 | 16.52 | 17.50 | 0.2982 | 0.5226 | 0.50 | 1-1-0 | 50.0% | -0.50 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 185 | 12.20 | 15.41 | 0.2038 | 0.0707 | — | 59-56-4 | 51.3% | -0.12 | 42.7% |
| edgedesk_cfb_v2.0.0 | 179 | 12.34 | 15.62 | 0.2051 | 0.0543 | 0.82 | 10-13-1 | 43.5% | -0.02 | 37.5% |
| edgedesk_cfb_v2.1.0 | 179 | 12.31 | 15.60 | 0.2049 | 0.0743 | 0.81 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=179 of 150 needed; MAE difference 0.086 [-0.501, 0.659])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=179 of 150 needed; MAE difference 0.114 [-0.463, 0.677])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=2 of 150 needed; MAE difference -1.845 [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1125 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0725 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0999 > 0.06

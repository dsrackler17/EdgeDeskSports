# CFB Model Lab — 2026 season to date

Generated 2026-11-01T04:07:55.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 105)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 105 | 12.19 | 15.18 | 2.32 | 29.97 | 0.2074 | 0.83 |
| V1 | 105 | 12.37 | 14.99 | 2.33 | 27.97 | 0.2149 | — |
| V2 · candidate 001 | 105 | 12.06 | 14.82 | 2.31 | 26.96 | 0.2069 | 0.80 |
| V2.1 · hardened | 105 | 12.04 | 14.78 | 2.37 | 27.04 | 0.2067 | 0.83 |
| opener | 105 | 11.91 | 14.50 | 2.60 | 27.30 | — | — |
| close | 105 | 11.57 | 14.21 | 2.29 | 28.30 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 105 | 12.19 | 15.18 | 0.2074 | 0.0674 | 0.83 | 25-32-1 | 43.9% | 0.12 | 44.8% |
| edgedesk_cfb_p4_v1.0.0 | 288 | 12.21 | 15.23 | 0.2063 | 0.0729 | — | 82-86-5 | 48.8% | -0.02 | 40.4% |
| edgedesk_cfb_v2.0.0 | 282 | 12.21 | 15.33 | 0.2049 | 0.0579 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 282 | 12.19 | 15.30 | 0.2048 | 0.0527 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=282 of 150 needed; MAE difference -0.046 [-0.475, 0.387])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=282 of 150 needed; MAE difference -0.019 [-0.457, 0.404])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=105 of 150 needed; MAE difference -0.172 [-1.055, 0.750])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0921 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0916 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0747 > 0.06
- **calibration_worse** (edgedesk_cfb_loop_v2.0.0) last-100 win ECE 0.0607 > 0.06
- **results_backlog** 1 predicted game(s) are more than 24 h past kickoff with no settled result

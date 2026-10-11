# CFB Model Lab — 2026 season to date

Generated 2026-10-11T05:07:25.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 112)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 112 | 12.75 | 16.25 | 0.14 | 34.99 | 0.1950 | — |
| V2 · candidate 001 | 112 | 12.70 | 16.41 | 1.05 | 33.92 | 0.1882 | 0.81 |
| V2.1 · hardened | 112 | 12.65 | 16.36 | 1.10 | 34.03 | 0.1870 | 0.80 |
| opener | 112 | 12.73 | 16.35 | 1.79 | 33.73 | — | — |
| close | 110 | 12.21 | 15.57 | 1.96 | 31.60 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 115 | 12.77 | 16.32 | 0.1899 | 0.1029 | — | 38-35-3 | 52.0% | -0.04 | 40.5% |
| edgedesk_cfb_v2.0.0 | 112 | 12.70 | 16.41 | 0.1882 | 0.0927 | 0.81 | 8-6-0 | 57.1% | 0.04 | 42.9% |
| edgedesk_cfb_v2.1.0 | 112 | 12.65 | 16.36 | 0.1870 | 0.0704 | 0.80 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=112 of 150 needed; MAE difference -0.099 [-0.844, 0.668])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=112 of 150 needed; MAE difference -0.052 [-0.789, 0.701])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1263 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0725 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1115 > 0.06
- **results_backlog** 1 predicted game(s) are more than 24 h past kickoff with no settled result

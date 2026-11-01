# CFB Model Lab — 2026 season to date

Generated 2026-11-01T06:07:51.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 106)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 106 | 12.18 | 15.14 | 2.20 | 29.96 | 0.2057 | 0.83 |
| V1 | 106 | 12.45 | 15.06 | 2.11 | 27.96 | 0.2129 | — |
| V2 · candidate 001 | 106 | 12.08 | 14.81 | 2.16 | 26.93 | 0.2051 | 0.80 |
| V2.1 · hardened | 106 | 12.05 | 14.77 | 2.22 | 27.03 | 0.2049 | 0.83 |
| opener | 106 | 11.96 | 14.53 | 2.42 | 27.25 | — | — |
| close | 106 | 11.59 | 14.21 | 2.13 | 28.25 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 106 | 12.18 | 15.14 | 0.2057 | 0.0654 | 0.83 | 26-32-1 | 44.8% | 0.12 | 45.8% |
| edgedesk_cfb_p4_v1.0.0 | 289 | 12.25 | 15.26 | 0.2056 | 0.0726 | — | 82-87-5 | 48.5% | -0.02 | 40.1% |
| edgedesk_cfb_v2.0.0 | 283 | 12.22 | 15.32 | 0.2042 | 0.0574 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 283 | 12.19 | 15.29 | 0.2041 | 0.0522 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=283 of 150 needed; MAE difference -0.073 [-0.520, 0.370])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=283 of 150 needed; MAE difference -0.046 [-0.487, 0.400])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=106 of 150 needed; MAE difference -0.266 [-1.170, 0.637])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0951 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0866 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0778 > 0.06
- **calibration_worse** (edgedesk_cfb_loop_v2.0.0) last-100 win ECE 0.0651 > 0.06
- **results_backlog** 1 predicted game(s) are more than 24 h past kickoff with no settled result
- **market_source_stale** 60% of snapshots within 72 h fail odds_freshness

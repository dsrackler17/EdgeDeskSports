# CFB Model Lab — 2026 season to date

Generated 2026-10-25T05:07:45.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 50, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 50 | 11.48 | 14.15 | 2.65 | 24.74 | 0.2349 | 0.84 |
| V1 | 50 | 11.94 | 14.45 | 2.80 | 25.80 | 0.2518 | — |
| V2 · candidate 001 | 50 | 11.98 | 14.57 | 2.85 | 27.13 | 0.2488 | 0.78 |
| V2.1 · hardened | 50 | 11.90 | 14.47 | 2.84 | 27.04 | 0.2475 | 0.82 |
| opener | 50 | 11.41 | 13.66 | 2.59 | 25.32 | — | — |
| close | 50 | 11.09 | 13.51 | 2.07 | 24.05 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 50 | 11.48 | 14.15 | 0.2349 | 0.0971 | 0.84 | 11-12-1 | 47.8% | 0.33 | 45.8% |
| edgedesk_cfb_p4_v1.0.0 | 233 | 12.09 | 15.17 | 0.2122 | 0.0797 | — | 67-71-5 | 48.5% | -0.02 | 44.0% |
| edgedesk_cfb_v2.0.0 | 227 | 12.23 | 15.39 | 0.2136 | 0.0768 | 0.81 | 13-20-1 | 39.4% | 0.09 | 44.1% |
| edgedesk_cfb_v2.1.0 | 227 | 12.19 | 15.36 | 0.2133 | 0.0685 | 0.81 | 17-17-0 | 50.0% | 0.01 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=227 of 150 needed; MAE difference 0.086 [-0.426, 0.612])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=227 of 150 needed; MAE difference 0.124 [-0.381, 0.639])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=50 of 150 needed; MAE difference -0.462 [-1.672, 0.699])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1153 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1298 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1302 > 0.06
- **results_backlog** 1 predicted game(s) are more than 24 h past kickoff with no settled result
- **market_source_stale** 100% of snapshots within 72 h fail odds_freshness

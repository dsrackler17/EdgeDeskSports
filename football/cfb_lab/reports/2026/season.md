# CFB Model Lab — 2026 season to date

Generated 2026-10-18T06:07:33.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 170)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 170 | 12.21 | 15.48 | -0.36 | 33.49 | 0.2079 | — |
| V2 · candidate 001 | 170 | 12.37 | 15.77 | 0.74 | 31.69 | 0.2035 | 0.81 |
| V2.1 · hardened | 170 | 12.35 | 15.75 | 0.82 | 31.25 | 0.2031 | 0.80 |
| opener | 170 | 12.04 | 15.45 | 1.35 | 32.77 | — | — |
| close | 168 | 11.62 | 14.81 | 1.50 | 30.15 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 176 | 12.18 | 15.46 | 0.2009 | 0.0793 | — | 57-53-4 | 51.8% | -0.14 | 41.1% |
| edgedesk_cfb_v2.0.0 | 170 | 12.37 | 15.77 | 0.2035 | 0.0575 | 0.81 | 10-12-1 | 45.5% | 0.00 | 39.1% |
| edgedesk_cfb_v2.1.0 | 170 | 12.35 | 15.75 | 0.2031 | 0.0786 | 0.80 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=170 of 150 needed; MAE difference 0.141 [-0.455, 0.742])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=170 of 150 needed; MAE difference 0.165 [-0.429, 0.757])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1094 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0962 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1151 > 0.06
- **results_backlog** 3 predicted game(s) are more than 24 h past kickoff with no settled result
- **market_source_stale** 33% of snapshots within 72 h fail odds_freshness

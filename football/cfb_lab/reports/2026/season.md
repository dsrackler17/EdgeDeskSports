# CFB Model Lab — 2026 season to date

Generated 2026-10-18T05:07:38.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 167)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 167 | 12.08 | 15.40 | -0.19 | 33.61 | 0.2078 | — |
| V2 · candidate 001 | 167 | 12.24 | 15.67 | 0.95 | 31.73 | 0.2033 | 0.81 |
| V2.1 · hardened | 167 | 12.22 | 15.66 | 1.02 | 31.27 | 0.2030 | 0.80 |
| opener | 167 | 11.87 | 15.29 | 1.62 | 32.85 | — | — |
| close | 165 | 11.48 | 14.69 | 1.76 | 30.30 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 173 | 12.06 | 15.38 | 0.2008 | 0.0867 | — | 56-52-4 | 51.8% | -0.14 | 40.9% |
| edgedesk_cfb_v2.0.0 | 167 | 12.24 | 15.67 | 0.2033 | 0.0600 | 0.81 | 10-11-1 | 47.6% | 0.02 | 40.9% |
| edgedesk_cfb_v2.1.0 | 167 | 12.22 | 15.66 | 0.2030 | 0.0775 | 0.80 | 14-10-0 | 58.3% | -0.15 | 45.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=167 of 150 needed; MAE difference 0.137 [-0.489, 0.744])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=167 of 150 needed; MAE difference 0.155 [-0.446, 0.745])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1099 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1015 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1208 > 0.06
- **results_backlog** 5 predicted game(s) are more than 24 h past kickoff with no settled result
- **market_source_stale** 33% of snapshots within 72 h fail odds_freshness

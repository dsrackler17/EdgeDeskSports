# CFB Model Lab — 2026 season to date

Generated 2026-10-18T04:07:41.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 166)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 166 | 12.11 | 15.43 | -0.15 | 33.65 | 0.2083 | — |
| V2 · candidate 001 | 166 | 12.27 | 15.71 | 0.99 | 31.75 | 0.2039 | 0.81 |
| V2.1 · hardened | 166 | 12.26 | 15.70 | 1.06 | 31.28 | 0.2036 | 0.80 |
| opener | 166 | 11.93 | 15.34 | 1.65 | 32.88 | — | — |
| close | 164 | 11.52 | 14.72 | 1.81 | 30.35 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 172 | 12.09 | 15.41 | 0.2012 | 0.0881 | — | 56-52-4 | 51.8% | -0.14 | 40.9% |
| edgedesk_cfb_v2.0.0 | 166 | 12.27 | 15.71 | 0.2039 | 0.0624 | 0.81 | 10-11-1 | 47.6% | 0.02 | 40.9% |
| edgedesk_cfb_v2.1.0 | 166 | 12.26 | 15.70 | 0.2036 | 0.0800 | 0.80 | 14-10-0 | 58.3% | -0.15 | 45.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=166 of 150 needed; MAE difference 0.145 [-0.469, 0.756])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=166 of 150 needed; MAE difference 0.163 [-0.435, 0.764])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1205 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0984 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1111 > 0.06
- **results_backlog** 5 predicted game(s) are more than 24 h past kickoff with no settled result
- **market_source_stale** 33% of snapshots within 72 h fail odds_freshness

# CFB Model Lab — 2026 season to date

Generated 2026-10-18T06:33:47.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 172)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 172 | 12.23 | 15.48 | -0.20 | 33.41 | 0.2055 | — |
| V2 · candidate 001 | 172 | 12.34 | 15.71 | 0.84 | 31.67 | 0.2014 | 0.81 |
| V2.1 · hardened | 172 | 12.31 | 15.70 | 0.92 | 31.24 | 0.2011 | 0.80 |
| opener | 172 | 12.01 | 15.40 | 1.44 | 32.73 | — | — |
| close | 170 | 11.58 | 14.75 | 1.58 | 30.05 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 178 | 12.20 | 15.46 | 0.1988 | 0.0775 | — | 57-55-4 | 50.9% | -0.14 | 42.1% |
| edgedesk_cfb_v2.0.0 | 172 | 12.34 | 15.71 | 0.2014 | 0.0550 | 0.81 | 10-12-1 | 45.5% | 0.00 | 39.1% |
| edgedesk_cfb_v2.1.0 | 172 | 12.31 | 15.70 | 0.2011 | 0.0760 | 0.80 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=172 of 150 needed; MAE difference 0.086 [-0.509, 0.701])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=172 of 150 needed; MAE difference 0.107 [-0.479, 0.711])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1147 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0855 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1054 > 0.06
- **results_backlog** 1 predicted game(s) are more than 24 h past kickoff with no settled result
- **market_source_stale** 33% of snapshots within 72 h fail odds_freshness

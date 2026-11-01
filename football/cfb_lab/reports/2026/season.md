# CFB Model Lab — 2026 season to date

Generated 2026-11-01T22:07:59.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 108)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 108 | 12.23 | 15.17 | 2.28 | 29.94 | 0.2064 | 0.82 |
| V1 | 108 | 12.50 | 15.09 | 2.18 | 27.96 | 0.2131 | — |
| V2 · candidate 001 | 108 | 12.15 | 14.84 | 2.18 | 26.89 | 0.2048 | 0.81 |
| V2.1 · hardened | 108 | 12.13 | 14.80 | 2.24 | 27.00 | 0.2047 | 0.83 |
| opener | 108 | 12.06 | 14.61 | 2.48 | 27.15 | — | — |
| close | 108 | 11.67 | 14.26 | 2.21 | 28.15 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 108 | 12.23 | 15.17 | 0.2064 | 0.0674 | 0.82 | 26-32-1 | 44.8% | 0.12 | 45.8% |
| edgedesk_cfb_p4_v1.0.0 | 291 | 12.27 | 15.26 | 0.2057 | 0.0704 | — | 82-87-5 | 48.5% | -0.02 | 40.1% |
| edgedesk_cfb_v2.0.0 | 285 | 12.24 | 15.33 | 0.2041 | 0.0583 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 285 | 12.22 | 15.30 | 0.2040 | 0.0532 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=285 of 150 needed; MAE difference -0.065 [-0.495, 0.359])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=285 of 150 needed; MAE difference -0.040 [-0.475, 0.379])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=108 of 150 needed; MAE difference -0.270 [-1.201, 0.657])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0785 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0955 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.095 > 0.06
- **market_source_stale** 60% of snapshots within 72 h fail odds_freshness

# CFB Model Lab — 2026 season to date

Generated 2026-10-18T03:07:44.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 163)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 163 | 12.28 | 15.56 | -0.18 | 33.77 | 0.2088 | — |
| V2 · candidate 001 | 163 | 12.39 | 15.81 | 0.95 | 31.78 | 0.2030 | 0.80 |
| V2.1 · hardened | 163 | 12.37 | 15.80 | 1.01 | 31.30 | 0.2026 | 0.80 |
| opener | 163 | 12.03 | 15.44 | 1.59 | 32.95 | — | — |
| close | 161 | 11.59 | 14.81 | 1.72 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 169 | 12.25 | 15.54 | 0.2015 | 0.0900 | — | 54-52-4 | 50.9% | -0.14 | 40.7% |
| edgedesk_cfb_v2.0.0 | 163 | 12.39 | 15.81 | 0.2030 | 0.0628 | 0.80 | 9-11-1 | 45.0% | 0.02 | 38.1% |
| edgedesk_cfb_v2.1.0 | 163 | 12.37 | 15.80 | 0.2026 | 0.0807 | 0.80 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=163 of 150 needed; MAE difference 0.093 [-0.516, 0.725])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=163 of 150 needed; MAE difference 0.110 [-0.483, 0.724])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1231 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1121 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1011 > 0.06
- **market_source_stale** 33% of snapshots within 72 h fail odds_freshness

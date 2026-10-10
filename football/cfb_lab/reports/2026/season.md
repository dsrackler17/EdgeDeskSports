# CFB Model Lab — 2026 season to date

Generated 2026-10-10T19:07:27.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 69, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 69 | 12.88 | 16.61 | 0.92 | 34.79 | 0.1803 | — |
| V2 · candidate 001 | 69 | 12.96 | 16.87 | 1.79 | 34.05 | 0.1641 | 0.78 |
| V2.1 · hardened | 69 | 12.99 | 16.84 | 1.79 | 34.23 | 0.1635 | 0.78 |
| opener | 69 | 12.88 | 16.75 | 2.63 | 33.80 | — | — |
| close | 67 | 12.16 | 15.87 | 3.22 | 31.90 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 72 | 12.92 | 16.70 | 0.1729 | 0.1329 | — | 24-18-3 | 57.1% | -0.12 | 39.5% |
| edgedesk_cfb_v2.0.0 | 69 | 12.96 | 16.87 | 0.1641 | 0.1365 | 0.78 | 4-5-0 | 44.4% | 0.00 | 33.3% |
| edgedesk_cfb_v2.1.0 | 69 | 12.99 | 16.84 | 0.1635 | 0.1662 | 0.78 | 8-6-0 | 57.1% | -0.07 | 35.7% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=69 of 150 needed; MAE difference 0.100 [-0.825, 1.014])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=69 of 150 needed; MAE difference 0.076 [-0.845, 0.980])

## Alerts

- None.

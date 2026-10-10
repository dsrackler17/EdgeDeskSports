# CFB Model Lab — 2026 season to date

Generated 2026-10-10T09:12:44.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 68, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 68 | 12.99 | 16.72 | 1.01 | 34.84 | 0.1817 | — |
| V2 · candidate 001 | 68 | 13.13 | 16.99 | 1.83 | 34.09 | 0.1643 | 0.78 |
| V2.1 · hardened | 68 | 13.15 | 16.96 | 1.84 | 34.30 | 0.1637 | 0.78 |
| opener | 68 | 13.03 | 16.87 | 2.71 | 33.83 | — | — |
| close | 66 | 12.33 | 15.98 | 3.29 | 32.00 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 71 | 13.02 | 16.80 | 0.1742 | 0.1308 | — | 24-18-2 | 57.1% | -0.14 | 38.1% |
| edgedesk_cfb_v2.0.0 | 68 | 13.13 | 16.99 | 0.1643 | 0.1328 | 0.78 | 4-5-0 | 44.4% | 0.00 | 33.3% |
| edgedesk_cfb_v2.1.0 | 68 | 13.15 | 16.96 | 0.1637 | 0.1630 | 0.78 | 8-6-0 | 57.1% | -0.07 | 35.7% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=68 of 150 needed; MAE difference 0.162 [-0.750, 1.067])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=68 of 150 needed; MAE difference 0.140 [-0.750, 1.046])

## Alerts

- None.

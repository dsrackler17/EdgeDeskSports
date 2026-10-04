# CFB Model Lab — 2026 season to date

Generated 2026-10-03T23:24:52.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 32, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 32 | 15.39 | 19.33 | 4.83 | 35.31 | 0.1598 | — |
| V2 · candidate 001 | 32 | 15.61 | 19.90 | 5.95 | 36.36 | 0.1565 | 0.63 |
| V2.1 · hardened | 32 | 15.70 | 19.92 | 5.94 | 36.61 | 0.1559 | 0.63 |
| opener | 32 | 15.61 | 19.93 | 6.83 | 34.00 | — | — |
| close | 32 | 15.09 | 19.32 | 6.75 | 33.73 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 33 | 14.98 | 19.04 | 0.1551 | 0.0974 | — | 13-10-1 | 56.5% | 0.02 | 41.7% |
| edgedesk_cfb_v2.0.0 | 32 | 15.61 | 19.90 | 0.1565 | 0.1439 | 0.63 | 2-4-0 | 33.3% | -0.17 | 16.7% |
| edgedesk_cfb_v2.1.0 | 32 | 15.70 | 19.92 | 0.1559 | 0.1711 | 0.63 | 4-5-0 | 44.4% | -0.22 | 22.2% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=32 of 150 needed; MAE difference 0.313 [-1.034, 1.615])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=32 of 150 needed; MAE difference 0.226 [-1.118, 1.535])

## Alerts

- None.

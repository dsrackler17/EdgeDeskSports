# CFB Model Lab — 2026 season to date

Generated 2026-10-10T21:07:24.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 80, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 80 | 12.92 | 16.37 | 0.25 | 34.22 | 0.1818 | — |
| V2 · candidate 001 | 80 | 13.01 | 16.71 | 1.23 | 33.60 | 0.1724 | 0.79 |
| V2.1 · hardened | 80 | 12.99 | 16.66 | 1.26 | 33.51 | 0.1711 | 0.79 |
| opener | 80 | 13.06 | 16.76 | 1.75 | 33.52 | — | — |
| close | 78 | 12.33 | 15.84 | 2.21 | 30.80 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 83 | 12.94 | 16.46 | 0.1753 | 0.1369 | — | 29-22-3 | 56.9% | -0.07 | 40.4% |
| edgedesk_cfb_v2.0.0 | 80 | 13.01 | 16.71 | 0.1724 | 0.1350 | 0.79 | 5-5-0 | 50.0% | 0.10 | 40.0% |
| edgedesk_cfb_v2.1.0 | 80 | 12.99 | 16.66 | 0.1711 | 0.1321 | 0.79 | 11-7-0 | 61.1% | 0.03 | 44.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=80 of 150 needed; MAE difference 0.072 [-0.799, 0.955])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=80 of 150 needed; MAE difference 0.092 [-0.778, 0.954])

## Alerts

- None.

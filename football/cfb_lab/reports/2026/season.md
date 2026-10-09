# CFB Model Lab — 2026 season to date

Generated 2026-10-09T23:07:29.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 63, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 63 | 13.14 | 16.90 | 1.26 | 35.10 | 0.1778 | — |
| V2 · candidate 001 | 63 | 13.29 | 17.21 | 2.12 | 34.29 | 0.1601 | 0.78 |
| V2.1 · hardened | 63 | 13.31 | 17.19 | 2.12 | 34.63 | 0.1595 | 0.78 |
| opener | 63 | 13.32 | 17.21 | 3.13 | 33.95 | — | — |
| close | 61 | 12.47 | 16.19 | 3.69 | 32.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 66 | 13.16 | 16.99 | 0.1698 | 0.1298 | — | 23-18-2 | 56.1% | -0.17 | 36.6% |
| edgedesk_cfb_v2.0.0 | 63 | 13.29 | 17.21 | 0.1601 | 0.1446 | 0.78 | 3-5-0 | 37.5% | -0.13 | 25.0% |
| edgedesk_cfb_v2.1.0 | 63 | 13.31 | 17.19 | 0.1595 | 0.1772 | 0.78 | 7-6-0 | 53.8% | -0.15 | 30.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=63 of 150 needed; MAE difference 0.173 [-0.795, 1.189])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=63 of 150 needed; MAE difference 0.145 [-0.813, 1.156])

## Alerts

- None.

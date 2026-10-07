# CFB Model Lab — 2026 season to date

Generated 2026-10-07T23:07:31.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 57, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 57 | 13.38 | 17.30 | 0.72 | 35.25 | 0.1754 | — |
| V2 · candidate 001 | 57 | 13.62 | 17.66 | 1.55 | 35.26 | 0.1616 | 0.75 |
| V2.1 · hardened | 57 | 13.65 | 17.64 | 1.56 | 35.58 | 0.1607 | 0.75 |
| opener | 57 | 13.56 | 17.52 | 2.60 | 34.00 | — | — |
| close | 55 | 12.63 | 16.45 | 3.25 | 32.80 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 60 | 13.39 | 17.37 | 0.1668 | 0.1164 | — | 22-17-1 | 56.4% | -0.26 | 34.2% |
| edgedesk_cfb_v2.0.0 | 57 | 13.62 | 17.66 | 0.1616 | 0.1390 | 0.75 | 3-4-0 | 42.9% | -0.14 | 28.6% |
| edgedesk_cfb_v2.1.0 | 57 | 13.65 | 17.64 | 0.1607 | 0.1747 | 0.75 | 7-5-0 | 58.3% | -0.17 | 33.3% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=57 of 150 needed; MAE difference 0.280 [-0.716, 1.303])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=57 of 150 needed; MAE difference 0.244 [-0.753, 1.248])

## Alerts

- None.

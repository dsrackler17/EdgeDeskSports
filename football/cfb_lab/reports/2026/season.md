# CFB Model Lab — 2026 season to date

Generated 2026-10-04T04:08:47.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 51, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 51 | 12.79 | 16.73 | 1.51 | 34.69 | 0.1628 | — |
| V2 · candidate 001 | 51 | 13.23 | 17.24 | 2.37 | 33.97 | 0.1506 | 0.75 |
| V2.1 · hardened | 51 | 13.29 | 17.25 | 2.37 | 34.10 | 0.1502 | 0.75 |
| opener | 51 | 13.06 | 17.07 | 3.53 | 33.75 | — | — |
| close | 51 | 12.43 | 16.46 | 3.47 | 33.00 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 54 | 12.84 | 16.84 | 0.1539 | 0.0970 | — | 21-15-1 | 58.3% | -0.27 | 32.4% |
| edgedesk_cfb_v2.0.0 | 51 | 13.23 | 17.24 | 0.1506 | 0.1182 | 0.75 | 3-4-0 | 42.9% | -0.14 | 28.6% |
| edgedesk_cfb_v2.1.0 | 51 | 13.29 | 17.25 | 0.1502 | 0.1583 | 0.75 | 6-5-0 | 54.5% | -0.18 | 36.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=51 of 150 needed; MAE difference 0.497 [-0.576, 1.623])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=51 of 150 needed; MAE difference 0.436 [-0.625, 1.565])

## Alerts

- **favorite_heavy** (edgedesk_cfb_p4_v1.0.0) favourite bias 4.472 (> 2 SE): favourites under-rated

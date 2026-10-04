# CFB Model Lab — 2026 season to date

Generated 2026-10-04T05:07:30.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 52, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 52 | 12.92 | 16.79 | 1.10 | 34.63 | 0.1643 | — |
| V2 · candidate 001 | 52 | 13.33 | 17.27 | 1.96 | 33.92 | 0.1519 | 0.75 |
| V2.1 · hardened | 52 | 13.38 | 17.27 | 1.97 | 34.03 | 0.1513 | 0.75 |
| opener | 52 | 13.22 | 17.16 | 3.05 | 33.73 | — | — |
| close | 52 | 12.63 | 16.60 | 2.97 | 32.95 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 55 | 12.96 | 16.89 | 0.1555 | 0.1042 | — | 21-15-1 | 58.3% | -0.27 | 32.4% |
| edgedesk_cfb_v2.0.0 | 52 | 13.33 | 17.27 | 0.1519 | 0.1070 | 0.75 | 3-4-0 | 42.9% | -0.14 | 28.6% |
| edgedesk_cfb_v2.1.0 | 52 | 13.38 | 17.27 | 0.1513 | 0.1464 | 0.75 | 6-5-0 | 54.5% | -0.18 | 36.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=52 of 150 needed; MAE difference 0.462 [-0.640, 1.526])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=52 of 150 needed; MAE difference 0.410 [-0.672, 1.483])

## Alerts

- **favorite_heavy** (edgedesk_cfb_p4_v1.0.0) favourite bias 4.748 (> 2 SE): favourites under-rated

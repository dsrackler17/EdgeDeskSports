# CFB Model Lab — 2026 season to date

Generated 2026-10-09T02:32:46.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 61, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 61 | 13.26 | 17.07 | 1.44 | 35.20 | 0.1728 | — |
| V2 · candidate 001 | 61 | 13.57 | 17.47 | 2.29 | 34.37 | 0.1588 | 0.77 |
| V2.1 · hardened | 61 | 13.59 | 17.44 | 2.29 | 34.76 | 0.1580 | 0.77 |
| opener | 61 | 13.62 | 17.45 | 3.38 | 34.00 | — | — |
| close | 59 | 12.70 | 16.41 | 3.96 | 32.60 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 64 | 13.28 | 17.15 | 0.1648 | 0.1162 | — | 23-17-1 | 57.5% | -0.26 | 33.3% |
| edgedesk_cfb_v2.0.0 | 61 | 13.57 | 17.47 | 0.1588 | 0.1349 | 0.77 | 3-5-0 | 37.5% | -0.13 | 25.0% |
| edgedesk_cfb_v2.1.0 | 61 | 13.59 | 17.44 | 0.1580 | 0.1684 | 0.77 | 7-6-0 | 53.8% | -0.15 | 30.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=61 of 150 needed; MAE difference 0.332 [-0.631, 1.321])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=61 of 150 needed; MAE difference 0.311 [-0.637, 1.295])

## Alerts

- **favorite_heavy** (edgedesk_cfb_p4_v1.0.0) favourite bias 4.301 (> 2 SE): favourites under-rated

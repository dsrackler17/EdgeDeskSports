# CFB Model Lab — 2026 season to date

Generated 2026-10-10T20:07:28.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 77, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 77 | 12.88 | 16.34 | 0.75 | 34.38 | 0.1764 | — |
| V2 · candidate 001 | 77 | 12.89 | 16.62 | 1.82 | 33.72 | 0.1648 | 0.79 |
| V2.1 · hardened | 77 | 12.87 | 16.57 | 1.84 | 33.70 | 0.1637 | 0.79 |
| opener | 77 | 12.88 | 16.57 | 2.34 | 33.60 | — | — |
| close | 75 | 12.13 | 15.65 | 2.83 | 31.10 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 80 | 12.90 | 16.43 | 0.1699 | 0.1272 | — | 26-22-3 | 54.2% | -0.08 | 40.8% |
| edgedesk_cfb_v2.0.0 | 77 | 12.89 | 16.62 | 0.1648 | 0.1304 | 0.79 | 5-5-0 | 50.0% | 0.10 | 40.0% |
| edgedesk_cfb_v2.1.0 | 77 | 12.87 | 16.57 | 0.1637 | 0.1588 | 0.79 | 11-7-0 | 61.1% | 0.03 | 44.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=77 of 150 needed; MAE difference -0.007 [-0.896, 0.898])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=77 of 150 needed; MAE difference 0.010 [-0.859, 0.897])

## Alerts

- **favorite_heavy** (edgedesk_cfb_p4_v1.0.0) favourite bias 3.773 (> 2 SE): favourites under-rated

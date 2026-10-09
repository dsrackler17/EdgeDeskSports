# CFB Model Lab — 2026 season to date

Generated 2026-10-09T03:07:27.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 62, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 62 | 13.13 | 16.95 | 1.50 | 35.15 | 0.1733 | — |
| V2 · candidate 001 | 62 | 13.38 | 17.33 | 2.28 | 34.33 | 0.1583 | 0.77 |
| V2.1 · hardened | 62 | 13.40 | 17.30 | 2.29 | 34.69 | 0.1577 | 0.77 |
| opener | 62 | 13.40 | 17.31 | 3.32 | 33.98 | — | — |
| close | 60 | 12.52 | 16.27 | 3.92 | 32.55 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 65 | 13.16 | 17.03 | 0.1654 | 0.1214 | — | 23-17-2 | 57.5% | -0.21 | 35.0% |
| edgedesk_cfb_v2.0.0 | 62 | 13.38 | 17.33 | 0.1583 | 0.1386 | 0.77 | 3-5-0 | 37.5% | -0.13 | 25.0% |
| edgedesk_cfb_v2.1.0 | 62 | 13.40 | 17.30 | 0.1577 | 0.1717 | 0.77 | 7-6-0 | 53.8% | -0.15 | 30.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=62 of 150 needed; MAE difference 0.269 [-0.711, 1.289])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=62 of 150 needed; MAE difference 0.242 [-0.742, 1.248])

## Alerts

- **favorite_heavy** (edgedesk_cfb_p4_v1.0.0) favourite bias 4.316 (> 2 SE): favourites under-rated

# CFB Model Lab — 2026 season to date

Generated 2026-10-03T20:37:47.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 19, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 19 | 14.40 | 18.34 | 3.55 | 35.58 | 0.1281 | — |
| V2 · candidate 001 | 19 | 14.50 | 19.11 | 4.78 | 38.97 | 0.1265 | 0.68 |
| V2.1 · hardened | 19 | 14.57 | 19.12 | 4.82 | 39.03 | 0.1249 | 0.68 |
| opener | 19 | 14.50 | 18.76 | 4.92 | 34.75 | — | — |
| close | 19 | 13.92 | 18.30 | 4.76 | 34.55 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 19 | 14.40 | 18.34 | 0.1281 | 0.2083 | — | 8-5-1 | 61.5% | 0.36 | 64.3% |
| edgedesk_cfb_v2.0.0 | 19 | 14.50 | 19.11 | 0.1265 | 0.2441 | 0.68 | 1-1-0 | 50.0% | 0.50 | 50.0% |
| edgedesk_cfb_v2.1.0 | 19 | 14.57 | 19.12 | 0.1249 | 0.1930 | 0.68 | 2-2-0 | 50.0% | 0.00 | 25.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=19 of 150 needed; MAE difference 0.172 [-1.504, 1.851])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=19 of 150 needed; MAE difference 0.108 [-1.615, 1.822])

## Alerts

- None.

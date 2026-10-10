# CFB Model Lab — 2026 season to date

Generated 2026-10-10T22:54:41.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 88, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 88 | 12.79 | 16.31 | 0.38 | 34.84 | 0.1800 | — |
| V2 · candidate 001 | 88 | 12.92 | 16.64 | 1.40 | 34.09 | 0.1726 | 0.80 |
| V2.1 · hardened | 88 | 12.90 | 16.60 | 1.42 | 34.30 | 0.1716 | 0.80 |
| opener | 88 | 13.05 | 16.73 | 1.98 | 33.83 | — | — |
| close | 86 | 12.38 | 15.82 | 2.41 | 32.00 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 91 | 12.81 | 16.39 | 0.1742 | 0.1402 | — | 32-23-3 | 58.2% | -0.06 | 39.3% |
| edgedesk_cfb_v2.0.0 | 88 | 12.92 | 16.64 | 0.1726 | 0.1249 | 0.80 | 5-5-0 | 50.0% | 0.10 | 40.0% |
| edgedesk_cfb_v2.1.0 | 88 | 12.90 | 16.60 | 0.1716 | 0.1208 | 0.80 | 11-7-0 | 61.1% | 0.03 | 44.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=88 of 150 needed; MAE difference 0.112 [-0.657, 0.918])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=88 of 150 needed; MAE difference 0.131 [-0.637, 0.916])

## Alerts

- None.

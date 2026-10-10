# CFB Model Lab — 2026 season to date

Generated 2026-10-10T23:07:30.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 91, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 91 | 12.85 | 16.28 | 0.39 | 34.69 | 0.1881 | — |
| V2 · candidate 001 | 91 | 12.91 | 16.55 | 1.39 | 33.97 | 0.1788 | 0.80 |
| V2.1 · hardened | 91 | 12.90 | 16.51 | 1.42 | 34.10 | 0.1780 | 0.80 |
| opener | 91 | 13.13 | 16.71 | 1.96 | 33.75 | — | — |
| close | 89 | 12.47 | 15.84 | 2.36 | 31.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 94 | 12.88 | 16.36 | 0.1822 | 0.1291 | — | 32-23-3 | 58.2% | -0.06 | 39.3% |
| edgedesk_cfb_v2.0.0 | 91 | 12.91 | 16.55 | 0.1788 | 0.1218 | 0.80 | 5-5-0 | 50.0% | 0.10 | 40.0% |
| edgedesk_cfb_v2.1.0 | 91 | 12.90 | 16.51 | 0.1780 | 0.0981 | 0.80 | 11-7-0 | 61.1% | 0.03 | 44.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=91 of 150 needed; MAE difference 0.051 [-0.727, 0.861])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=91 of 150 needed; MAE difference 0.066 [-0.698, 0.866])

## Alerts

- None.

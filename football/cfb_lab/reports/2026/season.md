# CFB Model Lab — 2026 season to date

Generated 2026-10-08T03:07:25.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 58, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 58 | 13.16 | 17.15 | 0.72 | 35.24 | 0.1759 | — |
| V2 · candidate 001 | 58 | 13.46 | 17.52 | 1.60 | 35.03 | 0.1610 | 0.76 |
| V2.1 · hardened | 58 | 13.49 | 17.49 | 1.61 | 35.38 | 0.1603 | 0.76 |
| opener | 58 | 13.35 | 17.37 | 2.58 | 34.00 | — | — |
| close | 56 | 12.44 | 16.31 | 3.22 | 32.75 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 61 | 13.18 | 17.23 | 0.1673 | 0.1218 | — | 22-17-1 | 56.4% | -0.26 | 34.2% |
| edgedesk_cfb_v2.0.0 | 58 | 13.46 | 17.52 | 0.1610 | 0.1428 | 0.76 | 3-5-0 | 37.5% | -0.13 | 25.0% |
| edgedesk_cfb_v2.1.0 | 58 | 13.49 | 17.49 | 0.1603 | 0.1780 | 0.76 | 7-6-0 | 53.8% | -0.15 | 30.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=58 of 150 needed; MAE difference 0.331 [-0.686, 1.350])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=58 of 150 needed; MAE difference 0.302 [-0.702, 1.310])

## Alerts

- None.

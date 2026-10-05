# CFB Model Lab — 2026 season to date

Generated 2026-10-05T02:07:27.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 56, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 56 | 13.41 | 17.39 | 0.53 | 35.26 | 0.1774 | — |
| V2 · candidate 001 | 56 | 13.65 | 17.75 | 1.37 | 35.48 | 0.1631 | 0.75 |
| V2.1 · hardened | 56 | 13.69 | 17.73 | 1.38 | 35.79 | 0.1623 | 0.75 |
| opener | 56 | 13.58 | 17.59 | 2.42 | 34.00 | — | — |
| close | 54 | 12.66 | 16.54 | 3.10 | 32.85 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 59 | 13.42 | 17.46 | 0.1685 | 0.1140 | — | 22-17-1 | 56.4% | -0.26 | 34.2% |
| edgedesk_cfb_v2.0.0 | 56 | 13.65 | 17.75 | 0.1631 | 0.1365 | 0.75 | 3-4-0 | 42.9% | -0.14 | 28.6% |
| edgedesk_cfb_v2.1.0 | 56 | 13.69 | 17.73 | 0.1623 | 0.1729 | 0.75 | 7-5-0 | 58.3% | -0.17 | 33.3% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=56 of 150 needed; MAE difference 0.278 [-0.807, 1.346])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=56 of 150 needed; MAE difference 0.240 [-0.827, 1.293])

## Alerts

- None.

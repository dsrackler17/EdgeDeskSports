# CFB Model Lab — 2026 season to date

Generated 2026-10-08T08:07:28.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 59, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 59 | 13.16 | 17.09 | 0.94 | 35.23 | 0.1749 | — |
| V2 · candidate 001 | 59 | 13.39 | 17.41 | 1.73 | 34.81 | 0.1595 | 0.76 |
| V2.1 · hardened | 59 | 13.41 | 17.38 | 1.73 | 35.17 | 0.1587 | 0.76 |
| opener | 59 | 13.39 | 17.34 | 2.80 | 34.00 | — | — |
| close | 57 | 12.43 | 16.24 | 3.38 | 32.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 62 | 13.18 | 17.17 | 0.1666 | 0.1142 | — | 22-17-1 | 56.4% | -0.26 | 34.2% |
| edgedesk_cfb_v2.0.0 | 59 | 13.39 | 17.41 | 0.1595 | 0.1449 | 0.76 | 3-5-0 | 37.5% | -0.13 | 25.0% |
| edgedesk_cfb_v2.1.0 | 59 | 13.41 | 17.38 | 0.1587 | 0.1794 | 0.76 | 7-6-0 | 53.8% | -0.15 | 30.8% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=59 of 150 needed; MAE difference 0.254 [-0.767, 1.326])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=59 of 150 needed; MAE difference 0.228 [-0.778, 1.281])

## Alerts

- None.

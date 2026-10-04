# CFB Model Lab — 2026 season to date

Generated 2026-10-04T02:59:35.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 46, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 46 | 13.35 | 17.37 | 2.50 | 34.94 | 0.1747 | — |
| V2 · candidate 001 | 46 | 13.51 | 17.79 | 3.77 | 34.17 | 0.1623 | 0.72 |
| V2.1 · hardened | 46 | 13.57 | 17.78 | 3.78 | 34.43 | 0.1618 | 0.72 |
| opener | 46 | 13.74 | 17.80 | 4.65 | 33.88 | — | — |
| close | 46 | 13.00 | 17.11 | 4.63 | 33.25 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 48 | 13.49 | 17.60 | 0.1676 | 0.1310 | — | 19-14-1 | 57.6% | -0.27 | 32.4% |
| edgedesk_cfb_v2.0.0 | 46 | 13.51 | 17.79 | 0.1623 | 0.1096 | 0.72 | 3-4-0 | 42.9% | -0.14 | 28.6% |
| edgedesk_cfb_v2.1.0 | 46 | 13.57 | 17.78 | 0.1618 | 0.1648 | 0.72 | 6-5-0 | 54.5% | -0.18 | 36.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=46 of 150 needed; MAE difference 0.217 [-0.954, 1.359])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=46 of 150 needed; MAE difference 0.158 [-0.995, 1.296])

## Alerts

- None.

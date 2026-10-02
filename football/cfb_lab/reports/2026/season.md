# CFB Model Lab — 2026 season to date

Generated 2026-10-02T13:07:22.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 2, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 2 | 14.41 | 15.68 | 14.41 | 19.96 | 0.1550 | — |
| V2 · candidate 001 | 2 | 13.47 | 16.23 | 13.47 | 21.62 | 0.2137 | 0.50 |
| V2.1 · hardened | 2 | 13.74 | 16.32 | 13.74 | 21.67 | 0.2096 | 0.50 |
| opener | 2 | 11.00 | 13.90 | 8.50 | 18.65 | — | — |
| close | 2 | 10.75 | 13.86 | 10.75 | 18.63 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 2 | 14.41 | 15.68 | 0.1550 | 0.3777 | — | 0-2-0 | 0.0% | 1.25 | 100.0% |
| edgedesk_cfb_v2.0.0 | 2 | 13.47 | 16.23 | 0.2137 | 0.4548 | 0.50 | 0-1-0 | 0.0% | 1.50 | 100.0% |
| edgedesk_cfb_v2.1.0 | 2 | 13.74 | 16.32 | 0.2096 | 0.4490 | 0.50 | 0-1-0 | 0.0% | 1.50 | 100.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=2 of 150 needed; MAE difference -0.665 [—, —])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=2 of 150 needed; MAE difference -0.935 [—, —])

## Alerts

- None.

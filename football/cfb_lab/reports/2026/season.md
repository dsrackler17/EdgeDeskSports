# CFB Model Lab — 2026 season to date

Generated 2026-10-02T05:07:33.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 1, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 1 | 20.58 | 20.58 | 20.58 | 20.58 | 0.2387 | — |
| V2 · candidate 001 | 1 | 22.53 | 22.53 | 22.53 | 22.53 | 0.2893 | 0.00 |
| V2.1 · hardened | 1 | 22.55 | 22.55 | 22.55 | 22.55 | 0.2901 | 0.00 |
| opener | 1 | 19.50 | 19.50 | 19.50 | 19.50 | — | — |
| close | 1 | 19.50 | 19.50 | 19.50 | 19.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 1 | 20.58 | 20.58 | 0.2387 | 0.4886 | — | 0-1-0 | 0.0% | 1.00 | 100.0% |
| edgedesk_cfb_v2.0.0 | 1 | 22.53 | 22.53 | 0.2893 | 0.5379 | 0.00 | 0-0-0 | — | — | — |
| edgedesk_cfb_v2.1.0 | 1 | 22.55 | 22.55 | 0.2901 | 0.5386 | 0.00 | 0-0-0 | — | — | — |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=1 of 150 needed; MAE difference 1.970 [—, —])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=1 of 150 needed; MAE difference 1.950 [—, —])

## Alerts

- None.

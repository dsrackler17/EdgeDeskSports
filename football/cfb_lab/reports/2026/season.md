# CFB Model Lab — 2026 season to date

Generated 2026-10-03T19:07:32.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 6, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 6 | 16.13 | 19.02 | -0.23 | 30.77 | 0.1587 | — |
| V2 · candidate 001 | 6 | 16.65 | 20.03 | 0.66 | 31.41 | 0.2063 | 0.50 |
| V2.1 · hardened | 6 | 16.69 | 20.01 | 0.79 | 31.32 | 0.2041 | 0.50 |
| opener | 6 | 15.58 | 18.46 | -0.58 | 28.50 | — | — |
| close | 6 | 14.83 | 18.11 | 0.17 | 28.75 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 6 | 16.13 | 19.02 | 0.1587 | 0.2114 | — | 1-4-0 | 20.0% | 0.50 | 60.0% |
| edgedesk_cfb_v2.0.0 | 6 | 16.65 | 20.03 | 0.2063 | 0.2266 | 0.50 | 0-1-0 | 0.0% | 1.50 | 100.0% |
| edgedesk_cfb_v2.1.0 | 6 | 16.69 | 20.01 | 0.2041 | 0.4237 | 0.50 | 0-2-0 | 0.0% | 0.50 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=6 of 150 needed; MAE difference 0.567 [—, —])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=6 of 150 needed; MAE difference 0.520 [—, —])

## Alerts

- None.

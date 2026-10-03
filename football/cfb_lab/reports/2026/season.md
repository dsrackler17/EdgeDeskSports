# CFB Model Lab — 2026 season to date

Generated 2026-10-03T12:42:42.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 5, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 5 | 12.52 | 14.15 | 6.55 | 20.24 | 0.1872 | — |
| V2 · candidate 001 | 5 | 13.26 | 16.00 | 7.51 | 24.49 | 0.2438 | 0.60 |
| V2.1 · hardened | 5 | 13.34 | 16.02 | 7.64 | 24.49 | 0.2412 | 0.60 |
| opener | 5 | 12.80 | 15.32 | 5.20 | 24.30 | — | — |
| close | 5 | 11.70 | 14.41 | 6.30 | 22.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 5 | 12.52 | 14.15 | 0.1872 | 0.2280 | — | 1-3-0 | 25.0% | 0.63 | 75.0% |
| edgedesk_cfb_v2.0.0 | 5 | 13.26 | 16.00 | 0.2438 | 0.2443 | 0.60 | 0-1-0 | 0.0% | 1.50 | 100.0% |
| edgedesk_cfb_v2.1.0 | 5 | 13.34 | 16.02 | 0.2412 | 0.4812 | 0.60 | 0-2-0 | 0.0% | 0.50 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=5 of 150 needed; MAE difference 0.826 [—, —])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=5 of 150 needed; MAE difference 0.746 [—, —])

## Alerts

- None.

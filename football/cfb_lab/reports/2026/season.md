# CFB Model Lab — 2026 season to date

Generated 2026-10-10T22:07:26.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 81, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 81 | 12.79 | 16.27 | 0.28 | 34.17 | 0.1815 | — |
| V2 · candidate 001 | 81 | 12.88 | 16.61 | 1.24 | 33.56 | 0.1725 | 0.79 |
| V2.1 · hardened | 81 | 12.85 | 16.56 | 1.26 | 33.44 | 0.1713 | 0.79 |
| opener | 81 | 12.92 | 16.66 | 1.75 | 33.50 | — | — |
| close | 79 | 12.25 | 15.75 | 2.25 | 30.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 84 | 12.82 | 16.36 | 0.1751 | 0.1400 | — | 29-22-3 | 56.9% | -0.07 | 40.4% |
| edgedesk_cfb_v2.0.0 | 81 | 12.88 | 16.61 | 0.1725 | 0.1386 | 0.79 | 5-5-0 | 50.0% | 0.10 | 40.0% |
| edgedesk_cfb_v2.1.0 | 81 | 12.85 | 16.56 | 0.1713 | 0.1340 | 0.79 | 11-7-0 | 61.1% | 0.03 | 44.4% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=81 of 150 needed; MAE difference 0.057 [-0.801, 0.889])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=81 of 150 needed; MAE difference 0.084 [-0.756, 0.910])

## Alerts

- None.

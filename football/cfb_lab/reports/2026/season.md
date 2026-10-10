# CFB Model Lab — 2026 season to date

Generated 2026-10-10T19:29:41.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 72, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 72 | 13.09 | 16.68 | 0.69 | 34.63 | 0.1835 | — |
| V2 · candidate 001 | 72 | 13.20 | 16.97 | 1.61 | 33.92 | 0.1686 | 0.78 |
| V2.1 · hardened | 72 | 13.21 | 16.93 | 1.64 | 34.03 | 0.1676 | 0.78 |
| opener | 72 | 13.05 | 16.81 | 2.40 | 33.73 | — | — |
| close | 70 | 12.32 | 15.91 | 2.96 | 31.60 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 75 | 13.11 | 16.77 | 0.1762 | 0.1278 | — | 24-19-3 | 55.8% | -0.11 | 38.6% |
| edgedesk_cfb_v2.0.0 | 72 | 13.20 | 16.97 | 0.1686 | 0.1317 | 0.78 | 4-5-0 | 44.4% | 0.00 | 33.3% |
| edgedesk_cfb_v2.1.0 | 72 | 13.21 | 16.93 | 0.1676 | 0.1682 | 0.78 | 9-6-0 | 60.0% | -0.07 | 40.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=72 of 150 needed; MAE difference 0.114 [-0.768, 0.998])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=72 of 150 needed; MAE difference 0.107 [-0.769, 0.974])

## Alerts

- None.

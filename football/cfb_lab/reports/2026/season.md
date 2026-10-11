# CFB Model Lab — 2026 season to date

Generated 2026-10-11T03:07:27.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 107)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 107 | 12.77 | 16.25 | -0.06 | 35.09 | 0.1957 | — |
| V2 · candidate 001 | 107 | 12.86 | 16.48 | 0.85 | 34.13 | 0.1881 | 0.81 |
| V2.1 · hardened | 107 | 12.82 | 16.42 | 0.90 | 34.36 | 0.1868 | 0.80 |
| opener | 107 | 12.91 | 16.41 | 1.56 | 33.85 | — | — |
| close | 105 | 12.29 | 15.61 | 1.87 | 32.10 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 110 | 12.79 | 16.32 | 0.1904 | 0.1131 | — | 37-31-3 | 54.4% | -0.10 | 40.6% |
| edgedesk_cfb_v2.0.0 | 107 | 12.86 | 16.48 | 0.1881 | 0.1005 | 0.81 | 6-6-0 | 50.0% | 0.33 | 50.0% |
| edgedesk_cfb_v2.1.0 | 107 | 12.82 | 16.42 | 0.1868 | 0.0731 | 0.80 | 12-9-0 | 57.1% | 0.14 | 47.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=107 of 150 needed; MAE difference 0.054 [-0.719, 0.819])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=107 of 150 needed; MAE difference 0.090 [-0.683, 0.849])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1155 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0805 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1181 > 0.06

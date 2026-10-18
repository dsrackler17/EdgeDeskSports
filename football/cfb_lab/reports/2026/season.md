# CFB Model Lab — 2026 season to date

Generated 2026-10-18T02:07:42.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 153)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 153 | 12.40 | 15.77 | 0.35 | 33.98 | 0.2100 | — |
| V2 · candidate 001 | 153 | 12.45 | 16.00 | 1.55 | 32.12 | 0.2036 | 0.79 |
| V2.1 · hardened | 153 | 12.43 | 15.99 | 1.62 | 31.86 | 0.2030 | 0.78 |
| opener | 153 | 12.25 | 15.71 | 2.06 | 33.20 | — | — |
| close | 151 | 11.78 | 15.06 | 2.22 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 158 | 12.37 | 15.75 | 0.2034 | 0.0908 | — | 52-49-4 | 51.5% | -0.15 | 39.8% |
| edgedesk_cfb_v2.0.0 | 153 | 12.45 | 16.00 | 0.2036 | 0.0574 | 0.79 | 9-9-1 | 50.0% | 0.00 | 36.8% |
| edgedesk_cfb_v2.1.0 | 153 | 12.43 | 15.99 | 0.2030 | 0.0886 | 0.78 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=153 of 150 needed; MAE difference 0.027 [-0.637, 0.656])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=153 of 150 needed; MAE difference 0.051 [-0.593, 0.666])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1325 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1036 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0928 > 0.06

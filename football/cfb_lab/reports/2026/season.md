# CFB Model Lab — 2026 season to date

Generated 2026-10-18T01:07:35.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 152)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 152 | 12.48 | 15.82 | 0.36 | 33.99 | 0.2113 | — |
| V2 · candidate 001 | 152 | 12.52 | 16.05 | 1.55 | 32.16 | 0.2047 | 0.79 |
| V2.1 · hardened | 152 | 12.50 | 16.04 | 1.62 | 31.93 | 0.2041 | 0.78 |
| opener | 152 | 12.33 | 15.76 | 2.07 | 33.23 | — | — |
| close | 150 | 11.85 | 15.11 | 2.24 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 157 | 12.45 | 15.80 | 0.2046 | 0.0920 | — | 52-49-4 | 51.5% | -0.15 | 39.8% |
| edgedesk_cfb_v2.0.0 | 152 | 12.52 | 16.05 | 0.2047 | 0.0589 | 0.79 | 9-9-1 | 50.0% | 0.00 | 36.8% |
| edgedesk_cfb_v2.1.0 | 152 | 12.50 | 16.04 | 0.2041 | 0.0902 | 0.78 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=152 of 150 needed; MAE difference 0.019 [-0.625, 0.683])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=152 of 150 needed; MAE difference 0.039 [-0.594, 0.679])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1307 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1119 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0879 > 0.06

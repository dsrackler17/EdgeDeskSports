# CFB Model Lab — 2026 season to date

Generated 2026-10-19T07:07:42.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 173)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 173 | 12.17 | 15.44 | -0.18 | 33.37 | 0.2057 | — |
| V2 · candidate 001 | 173 | 12.30 | 15.67 | 0.80 | 31.65 | 0.2007 | 0.81 |
| V2.1 · hardened | 173 | 12.27 | 15.65 | 0.89 | 31.23 | 0.2005 | 0.80 |
| opener | 173 | 12.04 | 15.42 | 1.32 | 32.70 | — | — |
| close | 171 | 11.53 | 14.71 | 1.55 | 30.00 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 179 | 12.15 | 15.41 | 0.1989 | 0.0798 | — | 58-55-4 | 51.3% | -0.14 | 42.6% |
| edgedesk_cfb_v2.0.0 | 173 | 12.30 | 15.67 | 0.2007 | 0.0530 | 0.81 | 10-13-1 | 43.5% | -0.02 | 37.5% |
| edgedesk_cfb_v2.1.0 | 173 | 12.27 | 15.65 | 0.2005 | 0.0737 | 0.80 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=173 of 150 needed; MAE difference 0.095 [-0.494, 0.692])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=173 of 150 needed; MAE difference 0.124 [-0.448, 0.709])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1185 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0789 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1064 > 0.06

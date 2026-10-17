# CFB Model Lab — 2026 season to date

Generated 2026-10-17T22:07:36.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 139)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 139 | 12.37 | 15.79 | 0.27 | 34.23 | 0.2089 | — |
| V2 · candidate 001 | 139 | 12.30 | 15.93 | 1.41 | 32.68 | 0.2015 | 0.81 |
| V2.1 · hardened | 139 | 12.26 | 15.89 | 1.47 | 32.76 | 0.2006 | 0.80 |
| opener | 139 | 12.22 | 15.83 | 1.92 | 33.50 | — | — |
| close | 137 | 11.67 | 15.06 | 2.04 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 144 | 12.34 | 15.78 | 0.2017 | 0.1083 | — | 48-45-4 | 51.6% | -0.13 | 42.1% |
| edgedesk_cfb_v2.0.0 | 139 | 12.30 | 15.93 | 0.2015 | 0.0610 | 0.81 | 9-8-1 | 52.9% | 0.00 | 38.9% |
| edgedesk_cfb_v2.1.0 | 139 | 12.26 | 15.89 | 0.2006 | 0.0675 | 0.80 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=139 of 150 needed; MAE difference -0.105 [-0.801, 0.616])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=139 of 150 needed; MAE difference -0.063 [-0.750, 0.634])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1457 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0896 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0744 > 0.06

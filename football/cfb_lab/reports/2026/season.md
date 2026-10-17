# CFB Model Lab — 2026 season to date

Generated 2026-10-17T06:10:02.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 124)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 124 | 12.50 | 15.91 | 0.28 | 34.72 | 0.2007 | — |
| V2 · candidate 001 | 124 | 12.36 | 16.07 | 1.21 | 33.41 | 0.1911 | 0.81 |
| V2.1 · hardened | 124 | 12.31 | 16.02 | 1.26 | 33.33 | 0.1902 | 0.81 |
| opener | 124 | 12.41 | 16.04 | 1.96 | 33.50 | — | — |
| close | 122 | 11.91 | 15.27 | 2.08 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 127 | 12.53 | 15.98 | 0.1960 | 0.1035 | — | 42-39-4 | 51.8% | -0.05 | 42.2% |
| edgedesk_cfb_v2.0.0 | 124 | 12.36 | 16.07 | 0.1911 | 0.0740 | 0.81 | 8-7-0 | 53.3% | -0.03 | 40.0% |
| edgedesk_cfb_v2.1.0 | 124 | 12.31 | 16.02 | 0.1902 | 0.0709 | 0.81 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=124 of 150 needed; MAE difference -0.186 [-0.893, 0.524])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=124 of 150 needed; MAE difference -0.142 [-0.843, 0.552])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1492 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0824 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0777 > 0.06

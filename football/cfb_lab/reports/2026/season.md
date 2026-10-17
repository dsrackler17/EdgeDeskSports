# CFB Model Lab — 2026 season to date

Generated 2026-10-17T19:42:06.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 134)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 134 | 12.47 | 15.80 | 0.63 | 34.40 | 0.2042 | — |
| V2 · candidate 001 | 134 | 12.42 | 16.05 | 1.67 | 32.92 | 0.1974 | 0.81 |
| V2.1 · hardened | 134 | 12.37 | 16.00 | 1.73 | 32.95 | 0.1964 | 0.80 |
| opener | 134 | 12.30 | 15.87 | 2.32 | 33.50 | — | — |
| close | 132 | 11.82 | 15.15 | 2.41 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 138 | 12.46 | 15.82 | 0.1984 | 0.0990 | — | 46-43-4 | 51.7% | -0.09 | 42.9% |
| edgedesk_cfb_v2.0.0 | 134 | 12.42 | 16.05 | 0.1974 | 0.0559 | 0.81 | 8-8-0 | 50.0% | -0.22 | 37.5% |
| edgedesk_cfb_v2.1.0 | 134 | 12.37 | 16.00 | 0.1964 | 0.0651 | 0.80 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=134 of 150 needed; MAE difference -0.102 [-0.775, 0.599])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=134 of 150 needed; MAE difference -0.055 [-0.722, 0.646])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1281 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0762 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0646 > 0.06

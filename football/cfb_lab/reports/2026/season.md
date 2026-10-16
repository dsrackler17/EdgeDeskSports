# CFB Model Lab — 2026 season to date

Generated 2026-10-16T01:38:12.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 118)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 118 | 12.38 | 15.90 | 0.06 | 34.88 | 0.1949 | — |
| V2 · candidate 001 | 118 | 12.28 | 16.06 | 0.87 | 33.68 | 0.1873 | 0.82 |
| V2.1 · hardened | 118 | 12.23 | 16.01 | 0.93 | 33.64 | 0.1864 | 0.81 |
| opener | 118 | 12.30 | 15.98 | 1.67 | 33.58 | — | — |
| close | 116 | 11.80 | 15.22 | 1.84 | 31.00 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 121 | 12.41 | 15.97 | 0.1902 | 0.0958 | — | 40-35-4 | 53.3% | -0.05 | 40.3% |
| edgedesk_cfb_v2.0.0 | 118 | 12.28 | 16.06 | 0.1873 | 0.0783 | 0.82 | 8-6-0 | 57.1% | 0.04 | 42.9% |
| edgedesk_cfb_v2.1.0 | 118 | 12.23 | 16.01 | 0.1864 | 0.0578 | 0.81 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=118 of 150 needed; MAE difference -0.149 [-0.867, 0.578])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=118 of 150 needed; MAE difference -0.105 [-0.812, 0.606])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1186 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0959 > 0.06

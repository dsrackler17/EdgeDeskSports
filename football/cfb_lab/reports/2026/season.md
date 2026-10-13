# CFB Model Lab — 2026 season to date

Generated 2026-10-13T19:31:10.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 114)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 114 | 12.64 | 16.13 | 0.12 | 34.95 | 0.1941 | — |
| V2 · candidate 001 | 114 | 12.49 | 16.27 | 1.01 | 33.84 | 0.1859 | 0.82 |
| V2.1 · hardened | 114 | 12.44 | 16.21 | 1.07 | 33.90 | 0.1847 | 0.81 |
| opener | 114 | 12.54 | 16.21 | 1.74 | 33.67 | — | — |
| close | 112 | 12.03 | 15.44 | 1.92 | 31.40 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 117 | 12.67 | 16.20 | 0.1892 | 0.0986 | — | 39-35-4 | 52.7% | -0.06 | 39.5% |
| edgedesk_cfb_v2.0.0 | 114 | 12.49 | 16.27 | 0.1859 | 0.0891 | 0.82 | 8-6-0 | 57.1% | 0.04 | 42.9% |
| edgedesk_cfb_v2.1.0 | 114 | 12.44 | 16.21 | 0.1847 | 0.0673 | 0.81 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=114 of 150 needed; MAE difference -0.202 [-0.957, 0.565])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=114 of 150 needed; MAE difference -0.152 [-0.897, 0.605])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1182 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0645 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1118 > 0.06

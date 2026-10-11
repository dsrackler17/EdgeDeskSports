# CFB Model Lab — 2026 season to date

Generated 2026-10-11T00:07:26.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 98, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 98 | 12.83 | 16.30 | -0.17 | 34.88 | 0.1941 | — |
| V2 · candidate 001 | 98 | 12.98 | 16.58 | 0.71 | 33.68 | 0.1872 | 0.81 |
| V2.1 · hardened | 98 | 12.96 | 16.52 | 0.74 | 33.64 | 0.1860 | 0.80 |
| opener | 98 | 13.04 | 16.52 | 1.34 | 33.58 | — | — |
| close | 96 | 12.35 | 15.68 | 1.78 | 31.00 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 101 | 12.85 | 16.37 | 0.1884 | 0.1260 | — | 34-27-3 | 55.7% | -0.07 | 41.9% |
| edgedesk_cfb_v2.0.0 | 98 | 12.98 | 16.58 | 0.1872 | 0.1157 | 0.81 | 5-6-0 | 45.5% | 0.09 | 45.5% |
| edgedesk_cfb_v2.1.0 | 98 | 12.96 | 16.52 | 0.1860 | 0.0840 | 0.80 | 11-9-0 | 55.0% | 0.00 | 45.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=98 of 150 needed; MAE difference 0.128 [-0.659, 0.914])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=98 of 150 needed; MAE difference 0.157 [-0.617, 0.940])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1224 > 0.06

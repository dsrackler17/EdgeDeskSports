# CFB Model Lab — 2026 season to date

Generated 2026-11-01T03:07:57.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 100)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 100 | 12.01 | 15.07 | 2.14 | 30.03 | 0.2054 | 0.83 |
| V1 | 100 | 12.08 | 14.77 | 2.16 | 27.98 | 0.2113 | — |
| V2 · candidate 001 | 100 | 11.77 | 14.61 | 2.12 | 27.05 | 0.2031 | 0.81 |
| V2.1 · hardened | 100 | 11.75 | 14.57 | 2.18 | 27.12 | 0.2029 | 0.84 |
| opener | 100 | 11.64 | 14.33 | 2.47 | 27.55 | — | — |
| close | 100 | 11.32 | 14.07 | 2.15 | 28.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 100 | 12.01 | 15.07 | 0.2054 | 0.0615 | 0.83 | 22-31-1 | 41.5% | 0.13 | 48.1% |
| edgedesk_cfb_p4_v1.0.0 | 283 | 12.11 | 15.16 | 0.2049 | 0.0691 | — | 81-84-5 | 49.1% | -0.02 | 41.1% |
| edgedesk_cfb_v2.0.0 | 277 | 12.11 | 15.26 | 0.2035 | 0.0575 | 0.81 | 18-21-1 | 46.2% | -0.04 | 40.0% |
| edgedesk_cfb_v2.1.0 | 277 | 12.08 | 15.24 | 0.2034 | 0.0488 | 0.82 | 20-17-0 | 54.0% | -0.04 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=277 of 150 needed; MAE difference -0.042 [-0.479, 0.420])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=277 of 150 needed; MAE difference -0.016 [-0.455, 0.438])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=100 of 150 needed; MAE difference -0.074 [-0.979, 0.901])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.0793 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0887 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0775 > 0.06
- **calibration_worse** (edgedesk_cfb_loop_v2.0.0) last-100 win ECE 0.0615 > 0.06

# CFB Model Lab — 2026 season to date

Generated 2026-10-31T05:07:54.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 60, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 60 | 11.89 | 14.77 | 0.52 | 25.39 | 0.2367 | 0.83 |
| V1 | 60 | 12.49 | 15.19 | 0.48 | 27.95 | 0.2505 | — |
| V2 · candidate 001 | 60 | 12.34 | 15.15 | 0.70 | 27.40 | 0.2485 | 0.78 |
| V2.1 · hardened | 60 | 12.28 | 15.04 | 0.72 | 27.46 | 0.2471 | 0.83 |
| opener | 60 | 11.75 | 14.20 | 0.72 | 26.02 | — | — |
| close | 60 | 11.39 | 13.95 | 0.19 | 24.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 60 | 11.89 | 14.77 | 0.2367 | 0.0946 | 0.83 | 12-15-1 | 44.4% | 0.25 | 46.4% |
| edgedesk_cfb_p4_v1.0.0 | 243 | 12.22 | 15.32 | 0.2135 | 0.0770 | — | 68-76-5 | 47.2% | -0.05 | 42.9% |
| edgedesk_cfb_v2.0.0 | 237 | 12.31 | 15.50 | 0.2151 | 0.0784 | 0.81 | 14-20-1 | 41.2% | 0.06 | 42.9% |
| edgedesk_cfb_v2.1.0 | 237 | 12.28 | 15.46 | 0.2146 | 0.0672 | 0.81 | 18-17-0 | 51.4% | -0.01 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=237 of 150 needed; MAE difference 0.037 [-0.485, 0.542])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=237 of 150 needed; MAE difference 0.072 [-0.438, 0.569])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=60 of 150 needed; MAE difference -0.601 [-1.757, 0.501])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1043 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1369 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1371 > 0.06

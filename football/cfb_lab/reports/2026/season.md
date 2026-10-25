# CFB Model Lab — 2026 season to date

Generated 2026-10-25T00:07:49.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 35, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 35 | 11.02 | 13.81 | 1.51 | 23.93 | 0.2478 | 0.83 |
| V1 | 35 | 11.58 | 14.58 | 1.89 | 27.05 | 0.2627 | — |
| V2 · candidate 001 | 35 | 11.97 | 14.74 | 1.93 | 28.40 | 0.2639 | 0.77 |
| V2.1 · hardened | 35 | 11.88 | 14.66 | 1.93 | 28.49 | 0.2627 | 0.83 |
| opener | 35 | 11.24 | 13.70 | 1.33 | 25.10 | — | — |
| close | 35 | 10.74 | 13.60 | 1.03 | 25.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 35 | 11.02 | 13.81 | 0.2478 | 0.1832 | 0.83 | 9-9-1 | 50.0% | 0.34 | 36.8% |
| edgedesk_cfb_p4_v1.0.0 | 218 | 12.04 | 15.24 | 0.2112 | 0.0845 | — | 63-67-5 | 48.5% | -0.04 | 45.1% |
| edgedesk_cfb_v2.0.0 | 212 | 12.25 | 15.48 | 0.2137 | 0.0727 | 0.81 | 10-18-1 | 35.7% | 0.12 | 44.8% |
| edgedesk_cfb_v2.1.0 | 212 | 12.21 | 15.45 | 0.2134 | 0.0725 | 0.81 | 15-15-0 | 50.0% | 0.03 | 50.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=212 of 150 needed; MAE difference 0.152 [-0.365, 0.683])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=212 of 150 needed; MAE difference 0.188 [-0.321, 0.707])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=35 of 150 needed; MAE difference -0.561 [-1.859, 0.833])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1388 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1112 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.66x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1106 > 0.06
- **market_source_stale** 50% of snapshots within 72 h fail odds_freshness

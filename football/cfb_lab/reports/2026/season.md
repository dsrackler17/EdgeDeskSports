# CFB Model Lab — 2026 season to date

Generated 2026-10-25T02:07:52.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 39, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 39 | 11.06 | 13.62 | 2.19 | 23.84 | 0.2431 | 0.85 |
| V1 | 39 | 11.69 | 14.46 | 2.56 | 26.79 | 0.2582 | — |
| V2 · candidate 001 | 39 | 11.82 | 14.45 | 2.63 | 27.60 | 0.2573 | 0.79 |
| V2.1 · hardened | 39 | 11.74 | 14.37 | 2.63 | 27.66 | 0.2560 | 0.85 |
| opener | 39 | 11.33 | 13.61 | 2.08 | 24.70 | — | — |
| close | 39 | 10.73 | 13.35 | 1.68 | 24.90 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 39 | 11.06 | 13.62 | 0.2431 | 0.1729 | 0.85 | 9-10-1 | 47.4% | 0.38 | 40.0% |
| edgedesk_cfb_p4_v1.0.0 | 222 | 12.05 | 15.21 | 0.2114 | 0.0831 | — | 63-69-5 | 47.7% | -0.04 | 44.4% |
| edgedesk_cfb_v2.0.0 | 216 | 12.21 | 15.41 | 0.2134 | 0.0751 | 0.81 | 10-19-1 | 34.5% | 0.15 | 46.7% |
| edgedesk_cfb_v2.1.0 | 216 | 12.18 | 15.39 | 0.2131 | 0.0749 | 0.81 | 15-16-0 | 48.4% | 0.07 | 51.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=216 of 150 needed; MAE difference 0.108 [-0.400, 0.617])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=216 of 150 needed; MAE difference 0.145 [-0.353, 0.641])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=39 of 150 needed; MAE difference -0.630 [-1.858, 0.587])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1188 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1222 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1082 > 0.06
- **market_source_stale** 67% of snapshots within 72 h fail odds_freshness

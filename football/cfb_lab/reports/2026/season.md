# CFB Model Lab — 2026 season to date

Generated 2026-10-25T01:07:50.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 38, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 38 | 11.19 | 13.76 | 2.42 | 23.86 | 0.2486 | 0.84 |
| V1 | 38 | 11.78 | 14.58 | 2.85 | 26.85 | 0.2641 | — |
| V2 · candidate 001 | 38 | 12.04 | 14.62 | 2.80 | 27.80 | 0.2636 | 0.79 |
| V2.1 · hardened | 38 | 11.96 | 14.54 | 2.79 | 27.87 | 0.2623 | 0.84 |
| opener | 38 | 11.45 | 13.74 | 2.32 | 24.80 | — | — |
| close | 38 | 10.84 | 13.49 | 1.90 | 25.10 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 38 | 11.19 | 13.76 | 0.2486 | 0.1824 | 0.84 | 9-10-1 | 47.4% | 0.38 | 40.0% |
| edgedesk_cfb_p4_v1.0.0 | 221 | 12.07 | 15.23 | 0.2122 | 0.0843 | — | 63-69-5 | 47.7% | -0.04 | 44.4% |
| edgedesk_cfb_v2.0.0 | 215 | 12.26 | 15.45 | 0.2143 | 0.0761 | 0.81 | 10-19-1 | 34.5% | 0.15 | 46.7% |
| edgedesk_cfb_v2.1.0 | 215 | 12.22 | 15.42 | 0.2140 | 0.0759 | 0.81 | 15-16-0 | 48.4% | 0.07 | 51.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=215 of 150 needed; MAE difference 0.132 [-0.365, 0.630])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=215 of 150 needed; MAE difference 0.168 [-0.322, 0.654])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=38 of 150 needed; MAE difference -0.595 [-1.808, 0.680])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1277 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1202 > 0.06
- **variance_shift** (edgedesk_cfb_v2.1.0) variance of predicted margins is 0.66x the reference
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1128 > 0.06
- **market_source_stale** 50% of snapshots within 72 h fail odds_freshness

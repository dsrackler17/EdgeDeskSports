# CFB Model Lab — 2026 season to date

Generated 2026-10-31T19:08:00.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 62, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 62 | 12.20 | 15.11 | 1.19 | 29.56 | 0.2372 | 0.82 |
| V1 | 62 | 12.54 | 15.37 | 0.92 | 27.97 | 0.2500 | — |
| V2 · candidate 001 | 62 | 12.45 | 15.25 | 1.18 | 27.19 | 0.2461 | 0.77 |
| V2.1 · hardened | 62 | 12.39 | 15.16 | 1.21 | 27.23 | 0.2450 | 0.82 |
| opener | 62 | 11.97 | 14.52 | 1.29 | 26.48 | — | — |
| close | 62 | 11.62 | 14.23 | 0.78 | 28.30 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 62 | 12.20 | 15.11 | 0.2372 | 0.1027 | 0.82 | 12-17-1 | 41.4% | 0.25 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 245 | 12.23 | 15.37 | 0.2137 | 0.0789 | — | 69-76-5 | 47.6% | -0.05 | 42.6% |
| edgedesk_cfb_v2.0.0 | 239 | 12.34 | 15.52 | 0.2147 | 0.0801 | 0.80 | 15-20-1 | 42.9% | 0.04 | 41.7% |
| edgedesk_cfb_v2.1.0 | 239 | 12.30 | 15.49 | 0.2143 | 0.0640 | 0.81 | 18-17-0 | 51.4% | -0.01 | 48.6% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=239 of 150 needed; MAE difference 0.051 [-0.445, 0.550])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=239 of 150 needed; MAE difference 0.084 [-0.400, 0.582])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=62 of 150 needed; MAE difference -0.347 [-1.486, 0.833])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1048 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1288 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1409 > 0.06

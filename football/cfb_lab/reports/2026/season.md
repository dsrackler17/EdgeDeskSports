# CFB Model Lab — 2026 season to date

Generated 2026-10-17T20:07:44.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 136)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 136 | 12.38 | 15.70 | 0.53 | 34.33 | 0.2051 | — |
| V2 · candidate 001 | 136 | 12.35 | 15.97 | 1.56 | 32.83 | 0.1986 | 0.81 |
| V2.1 · hardened | 136 | 12.30 | 15.93 | 1.61 | 32.87 | 0.1976 | 0.80 |
| opener | 136 | 12.24 | 15.79 | 2.16 | 33.50 | — | — |
| close | 134 | 11.75 | 15.08 | 2.27 | 30.50 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 141 | 12.34 | 15.69 | 0.1979 | 0.1041 | — | 48-44-4 | 52.2% | -0.10 | 42.5% |
| edgedesk_cfb_v2.0.0 | 136 | 12.35 | 15.97 | 0.1986 | 0.0574 | 0.81 | 8-8-0 | 50.0% | -0.22 | 37.5% |
| edgedesk_cfb_v2.1.0 | 136 | 12.30 | 15.93 | 0.1976 | 0.0665 | 0.80 | 13-10-0 | 56.5% | -0.15 | 43.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=136 of 150 needed; MAE difference -0.072 [-0.739, 0.618])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=136 of 150 needed; MAE difference -0.025 [-0.680, 0.658])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1404 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0867 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.075 > 0.06

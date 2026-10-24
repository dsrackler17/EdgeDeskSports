# CFB Model Lab — 2026 season to date

Generated 2026-10-24T05:07:48.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 7, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 7 | 10.57 | 12.74 | 0.28 | 21.68 | 0.2449 | 0.86 |
| V1 | 7 | 10.19 | 13.44 | 4.56 | 22.71 | 0.2647 | — |
| V2 · candidate 001 | 7 | 9.84 | 12.65 | 4.11 | 20.88 | 0.2420 | 0.86 |
| V2.1 · hardened | 7 | 9.83 | 12.57 | 4.11 | 20.92 | 0.2397 | 0.86 |
| opener | 7 | 10.50 | 12.60 | 0.21 | 20.20 | — | — |
| close | 7 | 10.29 | 12.58 | 1.71 | 19.85 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 7 | 10.57 | 12.74 | 0.2449 | 0.3602 | 0.86 | 2-2-0 | 50.0% | 0.25 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 190 | 12.06 | 15.30 | 0.2037 | 0.0660 | — | 60-57-4 | 51.3% | -0.09 | 43.7% |
| edgedesk_cfb_v2.0.0 | 184 | 12.21 | 15.52 | 0.2052 | 0.0585 | 0.82 | 10-15-1 | 40.0% | 0.08 | 42.3% |
| edgedesk_cfb_v2.1.0 | 184 | 12.18 | 15.50 | 0.2050 | 0.0730 | 0.81 | 15-12-0 | 55.6% | -0.02 | 48.1% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=184 of 150 needed; MAE difference 0.104 [-0.468, 0.704])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=184 of 150 needed; MAE difference 0.129 [-0.436, 0.722])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=7 of 150 needed; MAE difference 0.373 [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1065 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0694 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1129 > 0.06

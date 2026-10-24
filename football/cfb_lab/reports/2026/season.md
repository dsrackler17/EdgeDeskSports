# CFB Model Lab — 2026 season to date

Generated 2026-10-24T20:07:45.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 17, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 17 | 11.10 | 13.30 | 3.61 | 22.57 | 0.2274 | 0.88 |
| V1 | 17 | 11.33 | 13.96 | 4.16 | 23.62 | 0.2359 | — |
| V2 · candidate 001 | 17 | 10.97 | 13.39 | 4.36 | 23.94 | 0.2269 | 0.82 |
| V2.1 · hardened | 17 | 10.92 | 13.33 | 4.39 | 24.14 | 0.2266 | 0.88 |
| opener | 17 | 10.94 | 12.99 | 2.59 | 22.10 | — | — |
| close | 17 | 11.15 | 13.17 | 3.38 | 21.30 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 17 | 11.10 | 13.30 | 0.2274 | 0.1989 | 0.88 | 6-4-1 | 60.0% | 0.27 | 54.5% |
| edgedesk_cfb_p4_v1.0.0 | 200 | 12.06 | 15.25 | 0.2043 | 0.0785 | — | 61-60-5 | 50.4% | -0.07 | 45.2% |
| edgedesk_cfb_v2.0.0 | 194 | 12.18 | 15.44 | 0.2057 | 0.0617 | 0.81 | 10-15-1 | 40.0% | 0.08 | 42.3% |
| edgedesk_cfb_v2.1.0 | 194 | 12.16 | 15.42 | 0.2056 | 0.0652 | 0.81 | 15-12-0 | 55.6% | -0.02 | 48.1% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=194 of 150 needed; MAE difference 0.076 [-0.464, 0.639])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=194 of 150 needed; MAE difference 0.103 [-0.428, 0.656])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=17 of 150 needed; MAE difference -0.229 [-2.671, 2.212])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.092 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0688 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1071 > 0.06

# CFB Model Lab — 2026 season to date

Generated 2026-10-24T21:10:21.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 20, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 20 | 10.04 | 12.54 | 3.67 | 22.38 | 0.2248 | 0.90 |
| V1 | 20 | 10.36 | 13.15 | 4.26 | 23.05 | 0.2311 | — |
| V2 · candidate 001 | 20 | 10.40 | 12.84 | 4.78 | 23.32 | 0.2270 | 0.85 |
| V2.1 · hardened | 20 | 10.32 | 12.75 | 4.78 | 23.55 | 0.2264 | 0.90 |
| opener | 20 | 10.13 | 12.27 | 2.77 | 21.65 | — | — |
| close | 20 | 10.22 | 12.45 | 3.58 | 20.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 20 | 10.04 | 12.54 | 0.2248 | 0.1451 | 0.90 | 8-4-1 | 66.7% | 0.54 | 53.8% |
| edgedesk_cfb_p4_v1.0.0 | 203 | 11.95 | 15.16 | 0.2043 | 0.0790 | — | 62-60-5 | 50.8% | -0.04 | 45.6% |
| edgedesk_cfb_v2.0.0 | 197 | 12.11 | 15.36 | 0.2061 | 0.0575 | 0.82 | 10-15-1 | 40.0% | 0.08 | 42.3% |
| edgedesk_cfb_v2.1.0 | 197 | 12.08 | 15.34 | 0.2059 | 0.0664 | 0.82 | 15-12-0 | 55.6% | -0.02 | 48.1% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=197 of 150 needed; MAE difference 0.107 [-0.424, 0.667])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=197 of 150 needed; MAE difference 0.137 [-0.389, 0.687])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=20 of 150 needed; MAE difference -0.317 [-2.393, 1.847])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.091 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0645 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0872 > 0.06

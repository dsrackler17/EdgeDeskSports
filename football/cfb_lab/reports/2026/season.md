# CFB Model Lab — 2026 season to date

Generated 2026-10-23T14:07:54.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 3, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 3 | 12.49 | 14.52 | -5.34 | 21.15 | 0.2186 | 0.67 |
| V1 | 3 | 12.84 | 15.38 | 2.06 | 21.55 | 0.3095 | — |
| V2 · candidate 001 | 3 | 11.29 | 12.76 | -1.07 | 15.61 | 0.2393 | 1.00 |
| V2.1 · hardened | 3 | 11.21 | 12.56 | -1.07 | 15.22 | 0.2361 | 1.00 |
| opener | 3 | 11.83 | 13.77 | -2.83 | 18.90 | — | — |
| close | 3 | 12.83 | 14.52 | -2.50 | 19.10 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 3 | 12.49 | 14.52 | 0.2186 | 0.4297 | 0.67 | 1-1-0 | 50.0% | -0.50 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 186 | 12.14 | 15.37 | 0.2031 | 0.0689 | — | 59-56-4 | 51.3% | -0.12 | 42.7% |
| edgedesk_cfb_v2.0.0 | 180 | 12.28 | 15.57 | 0.2043 | 0.0525 | 0.82 | 10-13-1 | 43.5% | -0.02 | 37.5% |
| edgedesk_cfb_v2.1.0 | 180 | 12.26 | 15.56 | 0.2041 | 0.0724 | 0.81 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=180 of 150 needed; MAE difference 0.093 [-0.479, 0.668])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=180 of 150 needed; MAE difference 0.120 [-0.439, 0.686])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=3 of 150 needed; MAE difference -0.353 [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1099 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0721 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.0994 > 0.06

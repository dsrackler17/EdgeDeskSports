# CFB Model Lab — 2026 season to date

Generated 2026-10-21T20:07:47.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 176)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 176 | 12.21 | 15.43 | -0.10 | 33.25 | 0.2083 | — |
| V2 · candidate 001 | 176 | 12.32 | 15.65 | 0.88 | 31.61 | 0.2031 | 0.81 |
| V2.1 · hardened | 176 | 12.30 | 15.63 | 0.97 | 31.21 | 0.2030 | 0.81 |
| opener | 176 | 12.08 | 15.41 | 1.40 | 32.63 | — | — |
| close | 174 | 11.57 | 14.71 | 1.61 | 29.85 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 0 | — | — | — | — | — | 0-0-0 | — | — | — |
| edgedesk_cfb_p4_v1.0.0 | 182 | 12.18 | 15.41 | 0.2016 | 0.0689 | — | 58-55-4 | 51.3% | -0.14 | 42.6% |
| edgedesk_cfb_v2.0.0 | 176 | 12.32 | 15.65 | 0.2031 | 0.0552 | 0.81 | 10-13-1 | 43.5% | -0.02 | 37.5% |
| edgedesk_cfb_v2.1.0 | 176 | 12.30 | 15.63 | 0.2030 | 0.0755 | 0.81 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=176 of 150 needed; MAE difference 0.089 [-0.515, 0.676])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=176 of 150 needed; MAE difference 0.117 [-0.474, 0.687])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=0 of 150 needed; MAE difference — [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1035 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0865 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1053 > 0.06

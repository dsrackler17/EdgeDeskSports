# CFB Model Lab — 2026 season to date

Generated 2026-10-22T04:07:27.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 177)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 177 | 12.15 | 15.39 | -0.12 | 33.21 | 0.2081 | — |
| V2 · candidate 001 | 177 | 12.30 | 15.62 | 0.83 | 31.60 | 0.2037 | 0.81 |
| V2.1 · hardened | 177 | 12.27 | 15.60 | 0.91 | 31.20 | 0.2036 | 0.81 |
| opener | 177 | 12.03 | 15.37 | 1.37 | 32.60 | — | — |
| close | 175 | 11.52 | 14.67 | 1.59 | 29.80 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 0 | — | — | — | — | — | 0-0-0 | — | — | — |
| edgedesk_cfb_p4_v1.0.0 | 183 | 12.13 | 15.37 | 0.2014 | 0.0675 | — | 58-55-4 | 51.3% | -0.14 | 42.6% |
| edgedesk_cfb_v2.0.0 | 177 | 12.30 | 15.62 | 0.2037 | 0.0517 | 0.81 | 10-13-1 | 43.5% | -0.02 | 37.5% |
| edgedesk_cfb_v2.1.0 | 177 | 12.27 | 15.60 | 0.2036 | 0.0720 | 0.81 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=177 of 150 needed; MAE difference 0.122 [-0.458, 0.714])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=177 of 150 needed; MAE difference 0.148 [-0.426, 0.720])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=0 of 150 needed; MAE difference — [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1012 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0813 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1089 > 0.06

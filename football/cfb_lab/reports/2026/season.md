# CFB Model Lab — 2026 season to date

Generated 2026-10-24T03:07:49.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 5, small sample)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 5 | 9.55 | 11.77 | -2.45 | 19.99 | 0.1934 | 0.80 |
| V1 | 5 | 9.03 | 12.10 | 1.14 | 20.75 | 0.2425 | — |
| V2 · candidate 001 | 5 | 9.02 | 10.81 | 0.99 | 15.58 | 0.2024 | 1.00 |
| V2.1 · hardened | 5 | 8.87 | 10.57 | 0.86 | 15.22 | 0.1996 | 1.00 |
| opener | 5 | 9.70 | 11.59 | -2.90 | 18.30 | — | — |
| close | 5 | 10.10 | 11.88 | -1.30 | 18.70 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 5 | 9.55 | 11.77 | 0.1934 | 0.4059 | 0.80 | 2-2-0 | 50.0% | 0.25 | 50.0% |
| edgedesk_cfb_p4_v1.0.0 | 188 | 12.05 | 15.29 | 0.2025 | 0.0646 | — | 59-56-4 | 51.3% | -0.12 | 42.7% |
| edgedesk_cfb_v2.0.0 | 182 | 12.21 | 15.51 | 0.2037 | 0.0529 | 0.82 | 10-14-1 | 41.7% | 0.06 | 40.0% |
| edgedesk_cfb_v2.1.0 | 182 | 12.18 | 15.49 | 0.2035 | 0.0676 | 0.81 | 14-11-0 | 56.0% | -0.16 | 44.0% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=182 of 150 needed; MAE difference 0.114 [-0.465, 0.689])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=182 of 150 needed; MAE difference 0.144 [-0.421, 0.713])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=5 of 150 needed; MAE difference 0.520 [—, —])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1091 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0611 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1055 > 0.06

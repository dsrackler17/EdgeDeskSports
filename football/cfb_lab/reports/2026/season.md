# CFB Model Lab — 2026 season to date

Generated 2026-10-14T14:07:48.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 116)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| V1 | 116 | 12.47 | 16.00 | 0.14 | 34.91 | 0.1943 | — |
| V2 · candidate 001 | 116 | 12.33 | 16.13 | 0.98 | 33.76 | 0.1857 | 0.82 |
| V2.1 · hardened | 116 | 12.28 | 16.08 | 1.04 | 33.77 | 0.1845 | 0.81 |
| opener | 116 | 12.37 | 16.08 | 1.75 | 33.63 | — | — |
| close | 114 | 11.86 | 15.31 | 1.92 | 31.20 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_p4_v1.0.0 | 119 | 12.50 | 16.07 | 0.1895 | 0.0894 | — | 39-35-4 | 52.7% | -0.06 | 39.5% |
| edgedesk_cfb_v2.0.0 | 116 | 12.33 | 16.13 | 0.1857 | 0.0888 | 0.82 | 8-6-0 | 57.1% | 0.04 | 42.9% |
| edgedesk_cfb_v2.1.0 | 116 | 12.28 | 16.08 | 0.1845 | 0.0591 | 0.81 | 13-9-0 | 59.1% | -0.02 | 45.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=116 of 150 needed; MAE difference -0.194 [-0.934, 0.551])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=116 of 150 needed; MAE difference -0.144 [-0.869, 0.588])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1129 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.0627 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1095 > 0.06
- **market_source_stale** 64% of snapshots within 72 h fail odds_freshness

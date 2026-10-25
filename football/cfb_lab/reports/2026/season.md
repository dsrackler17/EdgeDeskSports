# CFB Model Lab — 2026 season to date

Generated 2026-10-25T03:07:46.000Z from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.

## Comparison on the common official set (n = 48, provisional)

| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |
|---|---|---|---|---|---|---|---|
| Loop v2.0.0 | 48 | 11.53 | 14.14 | 3.18 | 24.84 | 0.2385 | 0.83 |
| V1 | 48 | 11.66 | 14.22 | 3.11 | 26.00 | 0.2470 | — |
| V2 · candidate 001 | 48 | 12.06 | 14.62 | 3.34 | 27.14 | 0.2533 | 0.77 |
| V2.1 · hardened | 48 | 11.98 | 14.52 | 3.31 | 27.09 | 0.2520 | 0.81 |
| opener | 48 | 11.46 | 13.67 | 3.13 | 25.48 | — | — |
| close | 48 | 11.05 | 13.46 | 2.49 | 24.15 | — | — |

## Each model on its own official snapshots

| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |
|---|---|---|---|---|---|---|---|---|---|---|
| edgedesk_cfb_loop_v2.0.0 | 48 | 11.53 | 14.14 | 0.2385 | 0.1107 | 0.83 | 10-12-1 | 45.5% | 0.35 | 43.5% |
| edgedesk_cfb_p4_v1.0.0 | 231 | 12.03 | 15.13 | 0.2109 | 0.0797 | — | 67-69-5 | 49.3% | -0.02 | 44.6% |
| edgedesk_cfb_v2.0.0 | 225 | 12.25 | 15.41 | 0.2143 | 0.0753 | 0.80 | 12-20-1 | 37.5% | 0.09 | 42.4% |
| edgedesk_cfb_v2.1.0 | 225 | 12.21 | 15.38 | 0.2139 | 0.0657 | 0.81 | 16-17-0 | 48.5% | 0.01 | 48.5% |

## Promotion evaluations

- edgedesk_cfb_v2.1.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=225 of 150 needed; MAE difference 0.165 [-0.324, 0.669])
- edgedesk_cfb_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **NOT_ELIGIBLE** (n=225 of 150 needed; MAE difference 0.203 [-0.283, 0.702])
- edgedesk_cfb_loop_v2.0.0 vs champion edgedesk_cfb_p4_v1.0.0: **INSUFFICIENT_SAMPLE** (n=48 of 150 needed; MAE difference -0.126 [-1.240, 1.034])

## Alerts

- **calibration_worse** (edgedesk_cfb_p4_v1.0.0) last-100 win ECE 0.1033 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.1.0) last-100 win ECE 0.1259 > 0.06
- **calibration_worse** (edgedesk_cfb_v2.0.0) last-100 win ECE 0.1264 > 0.06
- **market_source_stale** 100% of snapshots within 72 h fail odds_freshness

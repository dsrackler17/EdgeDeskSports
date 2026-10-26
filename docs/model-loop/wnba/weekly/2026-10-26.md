# WNBA weekly model report: 2026-10-26

Served version **1.0.0** (SERVED; promoted by selection-window tuning on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Nothing promoted.** 8 candidates were tested; none cleared the rule (over 2010–2026: log loss ≤ −0.0002 with its 95% interval below zero and margin MAE ≤ −0.005, or for a scoring-level change total MAE ≤ −0.005 with its interval below zero; no worse on 2026). v1.0.0 keeps serving.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2010–2026 | 3998 | 0.612074 | 0.211961 | 9.8439 | 13.3244 |
| 2026 | 351 | 0.603204 | 0.207182 | 10.2348 | 15.2486 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 350 | -0.192 | -0.27 | home games: result minus model, home side |
| late_season | 197 | -0.946 | -1.04 | both sides have played 20+ |
| total | 351 | +3.919 | 3.85 | total points: result minus model |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0037 | total MAE change [-0.008671,0.001239] | 0 | 0 | FAIL: full total MAE change -0.0037 does not clear -0.005; total MAE 95% interval [-0.008671,0.001239] is not below zero |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.004 | total MAE change [0.000464,0.007652] | 0 | 0 | FAIL: full total MAE change 0.0040 does not clear -0.005; total MAE 95% interval [0.000464,0.007652] is not below zero; worse on 2026 total MAE (0.0300) |
| carry_lower | `carry` ["add",-0.1] | -0.00011 | -0.0026 | 0.0028 | log loss change [-0.000475,0.000294] | -0.000514 | 0.0004 | FAIL: full log loss change -0.000110 does not clear -0.0002; log loss 95% interval [-0.000475,0.000294] is not below zero; full margin MAE change -0.0026 does not clear -0.005; worse on 2026 margin MAE (0.0004) |
| carry_higher | `carry` ["add",0.1] | 0.00025 | 0.005 | -0.0001 | log loss change [-0.000147,0.000603] | 0.000631 | 0.0035 | FAIL: full log loss change 0.000250 does not clear -0.0002; log loss 95% interval [-0.000147,0.000603] is not below zero; full margin MAE change 0.0050 does not clear -0.005; worse on 2026 log loss (0.000631); worse on 2026 margin MAE (0.0035) |
| home_edge_looser | `k_h` ["mul",0.5] | 0.000361 | 0.0048 | 0 | log loss change [-0.000028,0.000755] | 0.000412 | 0.0096 | FAIL: full log loss change 0.000361 does not clear -0.0002; log loss 95% interval [-0.000028,0.000755] is not below zero; full margin MAE change 0.0048 does not clear -0.005; worse on 2026 log loss (0.000412); worse on 2026 margin MAE (0.0096) |
| home_edge_tighter | `k_h` ["mul",2] | -0.000253 | -0.0037 | 0 | log loss change [-0.000596,0.000118] | -0.000547 | -0.0094 | FAIL: log loss 95% interval [-0.000596,0.000118] is not below zero; full margin MAE change -0.0037 does not clear -0.005 |
| recency_faster | `half_life_days` ["mul",0.5] | -0.00007 | -0.0024 | -0.0081 | log loss change [-0.000311,0.000156] | -0.000218 | -0.005 | FAIL: full log loss change -0.000070 does not clear -0.0002; log loss 95% interval [-0.000311,0.000156] is not below zero; full margin MAE change -0.0024 does not clear -0.005 |
| recency_slower | `half_life_days` ["mul",2] | 0.000057 | 0.0015 | 0.0044 | log loss change [-0.000054,0.000177] | 0.000139 | 0.0023 | FAIL: full log loss change 0.000057 does not clear -0.0002; log loss 95% interval [-0.000054,0.000177] is not below zero; full margin MAE change 0.0015 does not clear -0.005; worse on 2026 log loss (0.000139); worse on 2026 margin MAE (0.0023) |

Every candidate ever tried: `docs/model-loop/wnba/candidates.jsonl`. Versions: `docs/model-loop/wnba/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

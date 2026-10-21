# WNBA weekly model report: 2026-10-21

Served version **1.0.0** (SERVED; promoted by selection-window tuning on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Nothing promoted.** 16 candidates were tested over 2 runs; none cleared the rule (over 2010–2026: log loss ≤ −0.0002 with its 95% interval below zero and margin MAE ≤ −0.005, or for a scoring-level change total MAE ≤ −0.005 with its interval below zero; no worse on 2026). v1.0.0 keeps serving.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2010–2026 | 3996 | 0.612008 | 0.211929 | 9.8408 | 13.3213 |
| 2026 | 349 | 0.602394 | 0.206794 | 10.2023 | 15.2234 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 348 | -0.234 | -0.33 | home games: result minus model, home side |
| late_season | 195 | -1.029 | -1.13 | both sides have played 20+ |
| total | 349 | +4.005 | 3.93 | total points: result minus model |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0038 | total MAE change [-0.008727,0.001193] | 0 | 0 | FAIL: full total MAE change -0.0038 does not clear -0.005; total MAE 95% interval [-0.008727,0.001193] is not below zero |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0039 | total MAE change [0.000375,0.007588] | 0 | 0 | FAIL: full total MAE change 0.0039 does not clear -0.005; total MAE 95% interval [0.000375,0.007588] is not below zero; worse on 2026 total MAE (0.0302) |
| prior_stronger | `prior_games` ["mul",2] | 0.001047 | -0.0039 | -0.0385 | log loss change [-0.000494,0.002612] | -0.001902 | -0.0459 | FAIL: full log loss change 0.001047 does not clear -0.0002; log loss 95% interval [-0.000494,0.002612] is not below zero; full margin MAE change -0.0039 does not clear -0.005 |
| carry_lower | `carry` ["add",-0.1] | -0.00011 | -0.0026 | 0.0028 | log loss change [-0.000512,0.000271] | -0.00052 | 0.0004 | FAIL: full log loss change -0.000110 does not clear -0.0002; log loss 95% interval [-0.000512,0.000271] is not below zero; full margin MAE change -0.0026 does not clear -0.005; worse on 2026 margin MAE (0.0004) |
| carry_higher | `carry` ["add",0.1] | 0.00025 | 0.0051 | -0.0002 | log loss change [-0.000118,0.000643] | 0.000637 | 0.0035 | FAIL: full log loss change 0.000250 does not clear -0.0002; log loss 95% interval [-0.000118,0.000643] is not below zero; full margin MAE change 0.0051 does not clear -0.005; worse on 2026 log loss (0.000637); worse on 2026 margin MAE (0.0035) |
| home_edge_looser | `k_h` ["mul",0.5] | 0.000361 | 0.0049 | 0 | log loss change [-0.000051,0.000792] | 0.000416 | 0.0096 | FAIL: full log loss change 0.000361 does not clear -0.0002; log loss 95% interval [-0.000051,0.000792] is not below zero; full margin MAE change 0.0049 does not clear -0.005; worse on 2026 log loss (0.000416); worse on 2026 margin MAE (0.0096) |
| home_edge_tighter | `k_h` ["mul",2] | -0.000253 | -0.0036 | 0 | log loss change [-0.000649,0.000138] | -0.00054 | -0.0094 | FAIL: log loss 95% interval [-0.000649,0.000138] is not below zero; full margin MAE change -0.0036 does not clear -0.005 |
| recency_faster | `half_life_days` ["mul",0.5] | -0.000075 | -0.0023 | -0.0082 | log loss change [-0.000305,0.000173] | -0.000273 | -0.0053 | FAIL: full log loss change -0.000075 does not clear -0.0002; log loss 95% interval [-0.000305,0.000173] is not below zero; full margin MAE change -0.0023 does not clear -0.005 |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0038 | total MAE change [-0.008727,0.001193] | 0 | 0 | FAIL: full total MAE change -0.0038 does not clear -0.005; total MAE 95% interval [-0.008727,0.001193] is not below zero |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0039 | total MAE change [0.000375,0.007588] | 0 | 0 | FAIL: full total MAE change 0.0039 does not clear -0.005; total MAE 95% interval [0.000375,0.007588] is not below zero; worse on 2026 total MAE (0.0302) |
| prior_stronger | `prior_games` ["mul",2] | 0.001047 | -0.0039 | -0.0385 | log loss change [-0.000494,0.002612] | -0.001902 | -0.0459 | FAIL: full log loss change 0.001047 does not clear -0.0002; log loss 95% interval [-0.000494,0.002612] is not below zero; full margin MAE change -0.0039 does not clear -0.005 |
| carry_lower | `carry` ["add",-0.1] | -0.00011 | -0.0026 | 0.0028 | log loss change [-0.000512,0.000271] | -0.00052 | 0.0004 | FAIL: full log loss change -0.000110 does not clear -0.0002; log loss 95% interval [-0.000512,0.000271] is not below zero; full margin MAE change -0.0026 does not clear -0.005; worse on 2026 margin MAE (0.0004) |
| carry_higher | `carry` ["add",0.1] | 0.00025 | 0.0051 | -0.0002 | log loss change [-0.000118,0.000643] | 0.000637 | 0.0035 | FAIL: full log loss change 0.000250 does not clear -0.0002; log loss 95% interval [-0.000118,0.000643] is not below zero; full margin MAE change 0.0051 does not clear -0.005; worse on 2026 log loss (0.000637); worse on 2026 margin MAE (0.0035) |
| home_edge_looser | `k_h` ["mul",0.5] | 0.000361 | 0.0049 | 0 | log loss change [-0.000051,0.000792] | 0.000416 | 0.0096 | FAIL: full log loss change 0.000361 does not clear -0.0002; log loss 95% interval [-0.000051,0.000792] is not below zero; full margin MAE change 0.0049 does not clear -0.005; worse on 2026 log loss (0.000416); worse on 2026 margin MAE (0.0096) |
| home_edge_tighter | `k_h` ["mul",2] | -0.000253 | -0.0036 | 0 | log loss change [-0.000649,0.000138] | -0.00054 | -0.0094 | FAIL: log loss 95% interval [-0.000649,0.000138] is not below zero; full margin MAE change -0.0036 does not clear -0.005 |
| recency_faster | `half_life_days` ["mul",0.5] | -0.000075 | -0.0023 | -0.0082 | log loss change [-0.000305,0.000173] | -0.000273 | -0.0053 | FAIL: full log loss change -0.000075 does not clear -0.0002; log loss 95% interval [-0.000305,0.000173] is not below zero; full margin MAE change -0.0023 does not clear -0.005 |

Every candidate ever tried: `docs/model-loop/wnba/candidates.jsonl`. Versions: `docs/model-loop/wnba/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

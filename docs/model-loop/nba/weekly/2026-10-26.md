# NBA weekly model report: 2026-10-26

Served version **1.0.0** (SERVED; promoted by selection-window tuning on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Nothing promoted.** 8 candidates were tested; none cleared the rule (over 2010–2027: log loss ≤ −0.0002 with its 95% interval below zero and margin MAE ≤ −0.005, or for a scoring-level change total MAE ≤ −0.005 with its interval below zero; no worse on 2026). v1.0.0 keeps serving.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2010–2027 | 21855 | 0.611878 | 0.212012 | 10.1702 | 14.427 |
| 2026 | 1322 | 0.59945 | 0.205796 | 11.4703 | 15.0533 |
| Season in progress | 43 | 0.619282 | 0.215477 | 12.0293 | 13.9467 |

## Where the misses concentrate (the 2026 season and the season in progress)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 1359 | -0.241 | -0.6 | home games: result minus model, home side |
| home_early | 137 | -0.716 | -0.56 | home games before either side has 6 games |
| early_season | 138 | -0.666 | -0.52 | either side has played fewer than 6 games |
| late_season | 1013 | -0.15 | -0.32 | both sides have played 20+ |
| big_favourites | 233 | +0.082 | 0.09 | projected margin 10+ either way (sign: toward the favourite) |
| back_to_back | 303 | -1.054 | -1.16 | one side on a back-to-back |
| total | 1365 | -0.459 | -0.89 | total points: result minus model |
| total_early | 138 | +3.194 | 1.92 | total points, either side under 6 games |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| carry_lower | `carry` ["add",-0.1] | 0.00001 | -0.0008 | -0.0014 | log loss change [-0.000177,0.00019] | -0.000919 | -0.0147 | FAIL: full log loss change 0.000010 does not clear -0.0002; log loss 95% interval [-0.000177,0.00019] is not below zero; full margin MAE change -0.0008 does not clear -0.005 |
| carry_higher | `carry` ["add",0.1] | 0.000186 | 0.0042 | 0.0053 | log loss change [0.000001,0.000375] | 0.001161 | 0.0201 | FAIL: full log loss change 0.000186 does not clear -0.0002; log loss 95% interval [0.000001,0.000375] is not below zero; full margin MAE change 0.0042 does not clear -0.005; worse on 2026 log loss (0.001161); worse on 2026 margin MAE (0.0201) |
| home_edge_looser | `k_h` ["mul",0.5] | 0.000186 | 0.0028 | 0 | log loss change [0.000077,0.000295] | 0.000312 | 0.0059 | FAIL: full log loss change 0.000186 does not clear -0.0002; log loss 95% interval [0.000077,0.000295] is not below zero; full margin MAE change 0.0028 does not clear -0.005; worse on 2026 log loss (0.000312); worse on 2026 margin MAE (0.0059) |
| home_edge_tighter | `k_h` ["mul",2] | -0.000147 | -0.0018 | 0 | log loss change [-0.000264,-0.000031] | -0.000292 | -0.006 | FAIL: full log loss change -0.000147 does not clear -0.0002; full margin MAE change -0.0018 does not clear -0.005 |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0017 | total MAE change [-0.004543,0.001134] | 0 | 0 | FAIL: full total MAE change -0.0017 does not clear -0.005; total MAE 95% interval [-0.004543,0.001134] is not below zero |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0028 | total MAE change [-0.000128,0.005729] | 0 | 0 | FAIL: full total MAE change 0.0028 does not clear -0.005; total MAE 95% interval [-0.000128,0.005729] is not below zero; worse on 2026 total MAE (0.0093) |
| recency_faster | `half_life_days` ["mul",0.5] | 0.001465 | 0.022 | -0.0423 | log loss change [0.000832,0.002089] | -0.00009 | 0.0019 | FAIL: full log loss change 0.001465 does not clear -0.0002; log loss 95% interval [0.000832,0.002089] is not below zero; full margin MAE change 0.0220 does not clear -0.005; worse on 2026 margin MAE (0.0019) |
| recency_slower | `half_life_days` ["mul",2] | 0.00025 | 0.0041 | 0.0468 | log loss change [-0.000121,0.000622] | 0.000448 | 0.015 | FAIL: full log loss change 0.000250 does not clear -0.0002; log loss 95% interval [-0.000121,0.000622] is not below zero; full margin MAE change 0.0041 does not clear -0.005; worse on 2026 log loss (0.000448); worse on 2026 margin MAE (0.0150) |

Every candidate ever tried: `docs/model-loop/nba/candidates.jsonl`. Versions: `docs/model-loop/nba/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

# NBA weekly model report: 2026-10-21

Served version **1.0.0** (SERVED; promoted by selection-window tuning on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Nothing promoted.** 8 candidates were tested; none cleared the rule (over 2010–2026: log loss ≤ −0.0002 with its 95% interval below zero and margin MAE ≤ −0.005, or for a scoring-level change total MAE ≤ −0.005 with its interval below zero; no worse on 2026). v1.0.0 keeps serving.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2010–2026 | 21812 | 0.611864 | 0.212005 | 10.1665 | 14.428 |
| 2026 | 1322 | 0.59945 | 0.205796 | 11.4703 | 15.0533 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 1316 | -0.186 | -0.46 | home games: result minus model, home side |
| home_early | 94 | -0.165 | -0.11 | home games before either side has 6 games |
| early_season | 95 | -0.098 | -0.07 | either side has played fewer than 6 games |
| late_season | 1013 | -0.15 | -0.32 | both sides have played 20+ |
| big_favourites | 228 | +0.205 | 0.21 | projected margin 10+ either way (sign: toward the favourite) |
| back_to_back | 298 | -0.974 | -1.06 | one side on a back-to-back |
| total | 1322 | -0.534 | -1.02 | total points: result minus model |
| total_early | 95 | +3.798 | 1.82 | total points, either side under 6 games |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| prior_stronger | `prior_games` ["mul",2] | 0.001173 | 0.0195 | 0.0448 | log loss change [0.000593,0.001771] | 0.004799 | 0.054 | FAIL: full log loss change 0.001173 does not clear -0.0002; log loss 95% interval [0.000593,0.001771] is not below zero; full margin MAE change 0.0195 does not clear -0.005; worse on 2026 log loss (0.004799); worse on 2026 margin MAE (0.0540) |
| carry_lower | `carry` ["add",-0.1] | 0.000007 | -0.0006 | -0.0017 | log loss change [-0.000169,0.000176] | -0.000919 | -0.0147 | FAIL: full log loss change 0.000007 does not clear -0.0002; log loss 95% interval [-0.000169,0.000176] is not below zero; full margin MAE change -0.0006 does not clear -0.005 |
| carry_higher | `carry` ["add",0.1] | 0.000185 | 0.0041 | 0.0055 | log loss change [0.000011,0.000374] | 0.001161 | 0.0201 | FAIL: full log loss change 0.000185 does not clear -0.0002; log loss 95% interval [0.000011,0.000374] is not below zero; full margin MAE change 0.0041 does not clear -0.005; worse on 2026 log loss (0.001161); worse on 2026 margin MAE (0.0201) |
| home_edge_looser | `k_h` ["mul",0.5] | 0.000182 | 0.0028 | 0 | log loss change [0.000075,0.000287] | 0.000312 | 0.0059 | FAIL: full log loss change 0.000182 does not clear -0.0002; log loss 95% interval [0.000075,0.000287] is not below zero; full margin MAE change 0.0028 does not clear -0.005; worse on 2026 log loss (0.000312); worse on 2026 margin MAE (0.0059) |
| home_edge_tighter | `k_h` ["mul",2] | -0.000146 | -0.0017 | 0 | log loss change [-0.000265,-0.000016] | -0.000292 | -0.006 | FAIL: full log loss change -0.000146 does not clear -0.0002; full margin MAE change -0.0017 does not clear -0.005 |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0018 | total MAE change [-0.004643,0.00105] | 0 | 0 | FAIL: full total MAE change -0.0018 does not clear -0.005; total MAE 95% interval [-0.004643,0.00105] is not below zero |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0028 | total MAE change [-0.000196,0.005813] | 0 | 0 | FAIL: full total MAE change 0.0028 does not clear -0.005; total MAE 95% interval [-0.000196,0.005813] is not below zero; worse on 2026 total MAE (0.0093) |
| recency_faster | `half_life_days` ["mul",0.5] | 0.001394 | 0.0213 | -0.0424 | log loss change [0.000732,0.002094] | -0.00009 | 0.0019 | FAIL: full log loss change 0.001394 does not clear -0.0002; log loss 95% interval [0.000732,0.002094] is not below zero; full margin MAE change 0.0213 does not clear -0.005; worse on 2026 margin MAE (0.0019) |

Every candidate ever tried: `docs/model-loop/nba/candidates.jsonl`. Versions: `docs/model-loop/nba/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

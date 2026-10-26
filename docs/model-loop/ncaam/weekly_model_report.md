# Men's college basketball weekly model report: 2026-10-26

Served version **1.1.0** (SERVED; promoted by weekly-loop on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Nothing promoted.** 8 candidates were tested; none cleared the rule (over 2012–2026: log loss ≤ −0.0002 with its 95% interval below zero and margin MAE ≤ −0.005, or for a scoring-level change total MAE ≤ −0.005 with its interval below zero; no worse on 2026). v1.1.0 keeps serving.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2012–2026 | 88452 | 0.500974 | 0.168057 | 9.49 | 13.5577 |
| 2026 | 6300 | 0.496946 | 0.167975 | 9.9957 | 13.8433 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 5592 | -0.156 | -0.9 | home games: result minus model, home side |
| home_early | 1381 | +2.761 | 6.51 | home games before either side has 6 games |
| neutral | 708 | -0.499 | -1.13 | neutral sites, listed home side |
| early_season | 1564 | +2.388 | 6.13 | either side has played fewer than 6 games |
| late_season | 2321 | -0.543 | -2.31 | both sides have played 20+ |
| big_favourites | 2760 | -0.576 | -2.16 | projected margin 10+ either way (sign: toward the favourite) |
| back_to_back | 182 | -0.384 | -0.39 | one side on a back-to-back |
| total | 6300 | +0.452 | 2.06 | total points: result minus model |
| total_early | 1564 | +2.065 | 4.5 | total points, either side under 6 games |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| home_edge_looser | `k_h` ["mul",0.5] | 0.000366 | -0.0026 | 0 | log loss change [0.000257,0.000487] | 0.000645 | -0.0034 | FAIL: full log loss change 0.000366 does not clear -0.0002; log loss 95% interval [0.000257,0.000487] is not below zero; full margin MAE change -0.0026 does not clear -0.005; worse on 2026 log loss (0.000645) |
| recency_faster | `half_life_days` ["mul",0.5] | 0.000302 | 0.0158 | -0.0043 | log loss change [0.000253,0.000353] | 0.000422 | 0.0224 | FAIL: full log loss change 0.000302 does not clear -0.0002; log loss 95% interval [0.000253,0.000353] is not below zero; full margin MAE change 0.0158 does not clear -0.005; worse on 2026 log loss (0.000422); worse on 2026 margin MAE (0.0224) |
| prior_weaker | `prior_games` ["mul",0.5] | 0.000447 | -0.0217 | 0.0636 | log loss change [0.000094,0.000834] | -0.000678 | -0.0347 | FAIL: full log loss change 0.000447 does not clear -0.0002; log loss 95% interval [0.000094,0.000834] is not below zero |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0026 | total MAE change [-0.003661,-0.001758] | 0 | 0 | FAIL: full total MAE change -0.0026 does not clear -0.005 |
| recency_slower | `half_life_days` ["mul",2] | -0.000129 | -0.0073 | 0.0023 | log loss change [-0.000154,-0.000106] | -0.000186 | -0.0101 | FAIL: full log loss change -0.000129 does not clear -0.0002 |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.004 | total MAE change [0.002887,0.005258] | 0 | 0 | FAIL: full total MAE change 0.0040 does not clear -0.005; total MAE 95% interval [0.002887,0.005258] is not below zero; worse on 2026 total MAE (0.0037) |
| prior_stronger | `prior_games` ["mul",2] | 0.002292 | 0.1059 | -0.0352 | log loss change [0.001843,0.002716] | 0.00431 | 0.1475 | FAIL: full log loss change 0.002292 does not clear -0.0002; log loss 95% interval [0.001843,0.002716] is not below zero; full margin MAE change 0.1059 does not clear -0.005; worse on 2026 log loss (0.004310); worse on 2026 margin MAE (0.1475) |
| carry_lower | `carry` ["add",-0.1] | 0.004021 | 0.153 | 0.0103 | log loss change [0.003691,0.00436] | 0.004997 | 0.2178 | FAIL: full log loss change 0.004021 does not clear -0.0002; log loss 95% interval [0.003691,0.00436] is not below zero; full margin MAE change 0.1530 does not clear -0.005; worse on 2026 log loss (0.004997); worse on 2026 margin MAE (0.2178) |

Every candidate ever tried: `docs/model-loop/ncaam/candidates.jsonl`. Versions: `docs/model-loop/ncaam/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

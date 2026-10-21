# Women's college basketball weekly model report: 2026-10-21

Served version **1.1.0** (SERVED; promoted by weekly-loop on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Promoted 1.0.0 → 1.1.0.** weekly loop 2026-10-21: candidate prior_weaker (prior_games ["mul",0.5]) cleared the full-window rule.

- Full window 2012–2026: log loss 0.464321 → 0.463767, margin MAE 10.1841 → 10.1361, total MAE 13.1317 → 13.2041 (95% interval of the log loss change [-0.000988,-0.000138])
- 2026: log loss 0.444986 → 0.44136, margin MAE 10.7899 → 10.6503
- **Cost on totals:** total-points MAE +0.0724 over the full window (+0.0652 in 2026). The side rule measures moneyline and margin only; a totals guard would be a rule change, made openly, not after the fact.
- Roll back: point `current` in docs/model-loop/ncaaw/versions.json at 1.0.0.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2012–2026 | 83023 | 0.463767 | 0.15335 | 10.1361 | 13.2041 |
| 2026 | 6029 | 0.44136 | 0.145888 | 10.6503 | 12.9339 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 5456 | +0.206 | 1.08 | home games: result minus model, home side |
| home_early | 1351 | +3.381 | 6.81 | home games before either side has 6 games |
| neutral | 573 | -0.125 | -0.25 | neutral sites, listed home side |
| early_season | 1463 | +2.987 | 6.35 | either side has played fewer than 6 games |
| late_season | 2106 | -0.108 | -0.42 | both sides have played 20+ |
| big_favourites | 3230 | +0.574 | 2.2 | projected margin 10+ either way (sign: toward the favourite) |
| back_to_back | 149 | -0.59 | -0.61 | one side on a back-to-back |
| total | 6029 | +0.247 | 1.17 | total points: result minus model |
| total_early | 1463 | +1.263 | 2.78 | total points, either side under 6 games |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| home_edge_looser | `k_h` ["mul",0.5] | 0.000407 | -0.0004 | 0 | log loss change [0.000284,0.000556] | 0.001404 | 0.0058 | FAIL: full log loss change 0.000407 does not clear -0.0002; log loss 95% interval [0.000284,0.000556] is not below zero; full margin MAE change -0.0004 does not clear -0.005; worse on 2026 log loss (0.001404); worse on 2026 margin MAE (0.0058) |
| recency_faster | `half_life_days` ["mul",0.5] | 0.000785 | 0.0375 | -0.0091 | log loss change [0.00067,0.000906] | 0.001145 | 0.0755 | FAIL: full log loss change 0.000785 does not clear -0.0002; log loss 95% interval [0.00067,0.000906] is not below zero; full margin MAE change 0.0375 does not clear -0.005; worse on 2026 log loss (0.001145); worse on 2026 margin MAE (0.0755) |
| prior_weaker | `prior_games` ["mul",0.5] | -0.000554 | -0.048 | 0.0724 | log loss change [-0.000988,-0.000138] | -0.003626 | -0.1396 | PASS: clears every condition |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0028 | total MAE change [-0.004493,-0.001454] | 0 | 0 | FAIL: full total MAE change -0.0028 does not clear -0.005 |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0038 | total MAE change [0.002478,0.005569] | 0 | 0 | FAIL: full total MAE change 0.0038 does not clear -0.005; total MAE 95% interval [0.002478,0.005569] is not below zero; worse on 2026 total MAE (0.0020) |
| recency_slower | `half_life_days` ["mul",2] | -0.0003 | -0.0161 | 0.0051 | log loss change [-0.000355,-0.000246] | -0.000457 | -0.033 | PASS: clears every condition |
| prior_stronger | `prior_games` ["mul",2] | 0.003849 | 0.1453 | -0.0461 | log loss change [0.003385,0.004381] | 0.008373 | 0.3127 | FAIL: full log loss change 0.003849 does not clear -0.0002; log loss 95% interval [0.003385,0.004381] is not below zero; full margin MAE change 0.1453 does not clear -0.005; worse on 2026 log loss (0.008373); worse on 2026 margin MAE (0.3127) |
| carry_lower | `carry` ["add",-0.1] | 0.004114 | 0.1542 | 0.0083 | log loss change [0.003779,0.004462] | 0.005207 | 0.2686 | FAIL: full log loss change 0.004114 does not clear -0.0002; log loss 95% interval [0.003779,0.004462] is not below zero; full margin MAE change 0.1542 does not clear -0.005; worse on 2026 log loss (0.005207); worse on 2026 margin MAE (0.2686) |
| home_edge_looser | `k_h` ["mul",0.5] | 0.000223 | -0.0019 | 0 | log loss change [0.000126,0.000345] | 0.000942 | 0 | FAIL: full log loss change 0.000223 does not clear -0.0002; log loss 95% interval [0.000126,0.000345] is not below zero; full margin MAE change -0.0019 does not clear -0.005; worse on 2026 log loss (0.000942) |
| recency_faster | `half_life_days` ["mul",0.5] | 0.000243 | 0.0187 | -0.0092 | log loss change [0.000156,0.000328] | 0.000335 | 0.0383 | FAIL: full log loss change 0.000243 does not clear -0.0002; log loss 95% interval [0.000156,0.000328] is not below zero; full margin MAE change 0.0187 does not clear -0.005; worse on 2026 log loss (0.000335); worse on 2026 margin MAE (0.0383) |
| prior_weaker | `prior_games` ["mul",0.5] | 0.001478 | 0.0178 | 0.0824 | log loss change [0.001082,0.001874] | -0.000493 | -0.016 | FAIL: full log loss change 0.001478 does not clear -0.0002; log loss 95% interval [0.001082,0.001874] is not below zero; full margin MAE change 0.0178 does not clear -0.005 |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0029 | total MAE change [-0.004417,-0.001728] | 0 | 0 | FAIL: full total MAE change -0.0029 does not clear -0.005 |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0036 | total MAE change [0.002511,0.004899] | 0 | 0 | FAIL: full total MAE change 0.0036 does not clear -0.005; total MAE 95% interval [0.002511,0.004899] is not below zero; worse on 2026 total MAE (0.0022) |
| recency_slower | `half_life_days` ["mul",2] | -0.000053 | -0.007 | 0.0052 | log loss change [-0.000091,-0.000011] | -0.000091 | -0.0144 | FAIL: full log loss change -0.000053 does not clear -0.0002 |
| prior_stronger | `prior_games` ["mul",2] | 0.000554 | 0.048 | -0.0724 | log loss change [0.000138,0.000988] | 0.003626 | 0.1396 | FAIL: full log loss change 0.000554 does not clear -0.0002; log loss 95% interval [0.000138,0.000988] is not below zero; full margin MAE change 0.0480 does not clear -0.005; worse on 2026 log loss (0.003626); worse on 2026 margin MAE (0.1396) |
| carry_lower | `carry` ["add",-0.1] | 0.003181 | 0.1289 | 0.0064 | log loss change [0.002896,0.003483] | 0.003607 | 0.2166 | FAIL: full log loss change 0.003181 does not clear -0.0002; log loss 95% interval [0.002896,0.003483] is not below zero; full margin MAE change 0.1289 does not clear -0.005; worse on 2026 log loss (0.003607); worse on 2026 margin MAE (0.2166) |

Every candidate ever tried: `docs/model-loop/ncaaw/candidates.jsonl`. Versions: `docs/model-loop/ncaaw/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

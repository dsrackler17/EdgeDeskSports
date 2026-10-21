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
| Full 2012–2026 | 83023 | 0.464321 | 0.153616 | 10.1841 | 13.1317 |
| 2026 | 6029 | 0.444986 | 0.147478 | 10.7899 | 12.8687 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 5456 | -0.017 | -0.09 | home games: result minus model, home side |
| home_early | 1351 | +3.256 | 6.36 | home games before either side has 6 games |
| neutral | 573 | -0.198 | -0.4 | neutral sites, listed home side |
| early_season | 1463 | +2.882 | 5.96 | either side has played fewer than 6 games |
| late_season | 2106 | -0.091 | -0.36 | both sides have played 20+ |
| big_favourites | 3298 | +0.23 | 0.89 | projected margin 10+ either way (sign: toward the favourite) |
| back_to_back | 149 | -0.739 | -0.74 | one side on a back-to-back |
| total | 6029 | +0.184 | 0.87 | total points: result minus model |
| total_early | 1463 | +1.207 | 2.69 | total points, either side under 6 games |

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

Every candidate ever tried: `docs/model-loop/ncaaw/candidates.jsonl`. Versions: `docs/model-loop/ncaaw/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

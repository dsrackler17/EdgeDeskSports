# Men's college basketball weekly model report: 2026-10-21

Served version **1.1.0** (SERVED; promoted by weekly-loop on 2026-10-21). Outcome-graded only: no closing prices are archived for basketball, so nothing here is compared with the market.

## What changed

**Promoted 1.0.0 → 1.1.0.** weekly loop 2026-10-21: candidate recency_slower (half_life_days ["mul",2]) cleared the full-window rule.

- Full window 2012–2026: log loss 0.501276 → 0.500974, margin MAE 9.5058 → 9.49, total MAE 13.5534 → 13.5577 (95% interval of the log loss change [-0.000353,-0.000253])
- 2026: log loss 0.497368 → 0.496946, margin MAE 10.0181 → 9.9957
- **Cost on totals:** total-points MAE +0.0043 over the full window (+0.0037 in 2026). The side rule measures moneyline and margin only; a totals guard would be a rule change, made openly, not after the fact.
- Roll back: point `current` in docs/model-loop/ncaam/versions.json at 1.0.0.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Brier | Margin MAE | Total MAE |
|---|---|---|---|---|---|
| Full 2012–2026 | 88452 | 0.501276 | 0.168136 | 9.5058 | 13.5534 |
| 2026 | 6300 | 0.497368 | 0.168086 | 10.0181 | 13.8396 |

## Where the misses concentrate (the 2026 season)

Outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Outcome bias (pts) | t | What it covers |
|---|---|---|---|---|
| home | 5592 | -0.168 | -0.97 | home games: result minus model, home side |
| home_early | 1381 | +2.825 | 6.63 | home games before either side has 6 games |
| neutral | 708 | -0.495 | -1.12 | neutral sites, listed home side |
| early_season | 1564 | +2.445 | 6.24 | either side has played fewer than 6 games |
| late_season | 2321 | -0.542 | -2.3 | both sides have played 20+ |
| big_favourites | 2774 | -0.578 | -2.16 | projected margin 10+ either way (sign: toward the favourite) |
| back_to_back | 182 | -0.398 | -0.4 | one side on a back-to-back |
| total | 6300 | +0.444 | 2.03 | total points: result minus model |
| total_early | 1564 | +2.053 | 4.47 | total points, either side under 6 games |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | Full Δmargin MAE | Full Δtotal MAE | 95% interval | 2026 Δlog loss | 2026 Δmargin MAE | Decision |
|---|---|---|---|---|---|---|---|---|
| home_edge_looser | `k_h` ["mul",0.5] | 0.000388 | -0.0026 | 0 | log loss change [0.000275,0.000514] | 0.000684 | -0.0029 | FAIL: full log loss change 0.000388 does not clear -0.0002; log loss 95% interval [0.000275,0.000514] is not below zero; full margin MAE change -0.0026 does not clear -0.005; worse on 2026 log loss (0.000684) |
| recency_faster | `half_life_days` ["mul",0.5] | 0.00078 | 0.0372 | -0.007 | log loss change [0.000679,0.000886] | 0.001053 | 0.0527 | FAIL: full log loss change 0.000780 does not clear -0.0002; log loss 95% interval [0.000679,0.000886] is not below zero; full margin MAE change 0.0372 does not clear -0.005; worse on 2026 log loss (0.001053); worse on 2026 margin MAE (0.0527) |
| prior_weaker | `prior_games` ["mul",0.5] | 0.00022 | -0.0304 | 0.0631 | log loss change [-0.00014,0.000611] | -0.000973 | -0.047 | FAIL: full log loss change 0.000220 does not clear -0.0002; log loss 95% interval [-0.00014,0.000611] is not below zero |
| scoring_level_looser | `k_mu` ["mul",0.5] | 0 | 0 | -0.0027 | total MAE change [-0.003717,-0.001799] | 0 | 0 | FAIL: full total MAE change -0.0027 does not clear -0.005 |
| recency_slower | `half_life_days` ["mul",2] | -0.000302 | -0.0158 | 0.0043 | log loss change [-0.000353,-0.000253] | -0.000422 | -0.0224 | PASS: clears every condition |
| scoring_level_tighter | `k_mu` ["mul",2] | 0 | 0 | 0.0041 | total MAE change [0.002918,0.005327] | 0 | 0 | FAIL: full total MAE change 0.0041 does not clear -0.005; total MAE 95% interval [0.002918,0.005327] is not below zero; worse on 2026 total MAE (0.0037) |
| home_edge_tighter | `k_h` ["mul",2] | -0.000361 | 0.0036 | 0 | log loss change [-0.000497,-0.000233] | -0.000678 | 0.0048 | FAIL: full margin MAE change 0.0036 does not clear -0.005; worse on 2026 margin MAE (0.0048) |
| prior_stronger | `prior_games` ["mul",2] | 0.002645 | 0.1178 | -0.0341 | log loss change [0.002187,0.003083] | 0.00479 | 0.1645 | FAIL: full log loss change 0.002645 does not clear -0.0002; log loss 95% interval [0.002187,0.003083] is not below zero; full margin MAE change 0.1178 does not clear -0.005; worse on 2026 log loss (0.004790); worse on 2026 margin MAE (0.1645) |

Every candidate ever tried: `docs/model-loop/ncaam/candidates.jsonl`. Versions: `docs/model-loop/ncaam/versions.json`. The ratings are refreshed daily with the served version (`basketball/walkforward.js`).

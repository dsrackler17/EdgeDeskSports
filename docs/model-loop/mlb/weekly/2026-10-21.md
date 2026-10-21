# MLB weekly model report (lab brain): 2026-10-21

Served version **1.0.0** (SERVED (RESEARCH: prices no live game); selection-window tuning, 2026-10-21). The lab brain (mlb/history) prices no live game: the browser card uses mlb/engine.js. This loop improves the brain on the whole 2012-to-date record so the 2027 engine can be chosen on evidence. Outcome-graded only: no MLB closing prices are archived.

## What changed

**Nothing promoted.** 8 candidates were tested; none cleared the rule (over 2012–2025: log loss ≤ −0.0002 with its 95% interval below zero, Brier and run line no worse, no worse on 2025). v1.0.0 keeps serving.

## Accuracy (walk-forward, out of sample)

| Window | n | Moneyline log loss | Elo | Brier | Run line log loss | Total MAE |
|---|---|---|---|---|---|---|
| Full 2012–2025 | 32487 | 0.679372 | 0.679263 | 0.243184 | 0.64555 | 3.4743 |
| 2025 | 2430 | 0.678302 | 0.678438 | 0.242703 | 0.642228 | 3.5974 |

Elo is the baseline the brain has to beat; while its moneyline log loss is above Elo's, the brain's moneyline cannot be validated (engine/lab/protocol.js).

## Where the misses concentrate (the last two full seasons)

Moneyline: wins minus priced, z = (wins − Σp) / √Σp(1−p). Totals: runs minus expected, t. |z| or |t| ≥ 2 pulls the matching candidates forward.

| Pattern | Market | n | Bias | z / t | What it covers |
|---|---|---|---|---|---|
| home | moneyline | 4862 | +0.0089 | 1.26 z | every game: home wins minus the priced home win |
| early_season | moneyline | 910 | +0.0241 | 1.47 z | March and April (ratings carried over the winter) |
| late_season | moneyline | 759 | +0.0018 | 0.1 z | September and later |
| favourites | moneyline | 915 | +0.0199 | 1.25 z | priced 60%+ either way, read from the favourite |
| starter_known | moneyline | 2430 | +0.0198 | 1.98 z | both starters on file |
| total | total | 4862 | -0.051 | -0.8 t | total runs: result minus expected |

## Every candidate tried this week

| Candidate | Change | Full Δlog loss | 95% interval | ΔBrier | Δrun line | Δtotal MAE | 2025 Δlog loss | Decision |
|---|---|---|---|---|---|---|---|---|
| teams_prior_weaker | `prior_games` ["mul",0.5] | 0.000011 | [-0.000018,0.000042] | 0.000005 | 0.000069 | 0.001 | -0.000054 | FAIL: full log loss change 0.000011 does not clear -0.0002; log loss 95% interval [-0.000018,0.000042] is not below zero; Brier worse (0.000005); run line log loss worse (0.000069) |
| teams_prior_stronger | `prior_games` ["mul",2] | 0.000012 | [-0.000036,0.000061] | 0.000007 | -0.000084 | -0.0014 | 0.000112 | FAIL: full log loss change 0.000012 does not clear -0.0002; log loss 95% interval [-0.000036,0.000061] is not below zero; Brier worse (0.000007); worse on 2025 (0.000112) |
| carry_lower | `carry` ["add",-0.15] | 0 | [-0.000002,0.000002] | 0 | 0.000001 | 0 | 0.000002 | FAIL: full log loss change 0 does not clear -0.0002; log loss 95% interval [-0.000002,0.000002] is not below zero; run line log loss worse (0.000001); worse on 2025 (0.000002) |
| carry_higher | `carry` ["add",0.15] | 0 | [-0.000003,0.000002] | 0 | -0.000001 | 0 | -0.000006 | FAIL: full log loss change 0 does not clear -0.0002; log loss 95% interval [-0.000003,0.000002] is not below zero |
| park_prior_weaker | `prior_park_games` ["mul",0.5] | 0.000003 | [-0.000003,0.000009] | 0.000002 | 0.000032 | 0.0009 | 0.000003 | FAIL: full log loss change 0.000003 does not clear -0.0002; log loss 95% interval [-0.000003,0.000009] is not below zero; Brier worse (0.000002); run line log loss worse (0.000032); worse on 2025 (0.000003) |
| park_prior_stronger | `prior_park_games` ["mul",2] | -0.000005 | [-0.000013,0.000005] | -0.000002 | -0.000043 | 0 | -0.000003 | FAIL: full log loss change -0.000005 does not clear -0.0002; log loss 95% interval [-0.000013,0.000005] is not below zero |
| window_longer | `window_days` ["mul",1.5] | 0.000273 | [0.000086,0.000463] | 0.000133 | 0.000195 | -0.0026 | 0.000088 | FAIL: full log loss change 0.000273 does not clear -0.0002; log loss 95% interval [0.000086,0.000463] is not below zero; Brier worse (0.000133); run line log loss worse (0.000195); worse on 2025 (0.000088) |
| starters_looser | `prior_starts` ["mul",0.5] | 0.000748 | [0.000531,0.000961] | 0.000366 | 0.001348 | 0.0053 | 0.001213 | FAIL: full log loss change 0.000748 does not clear -0.0002; log loss 95% interval [0.000531,0.000961] is not below zero; Brier worse (0.000366); run line log loss worse (0.001348); worse on 2025 (0.001213) |

Every candidate ever tried: `docs/model-loop/mlb/candidates.jsonl`. Versions: `docs/model-loop/mlb/versions.json`. The weekly record (`mlb/history/walkforward.js`, lab-validate.yml) is built with the served version.

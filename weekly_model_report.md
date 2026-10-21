# NFL weekly model report — 2026 week 6

Generated 2026-10-21T01:23:43.730Z. Served model: **edgedesk_nfl_v2.0.0**. Published numbers this week came from: edgedesk_football_v1.0.0.

Three numbers per game, never mixed: **published** is what the site showed before kickoff (the model record, never recomputed); **replayed** is what the model served today gives the same game from its pregame state through the corrected pipeline; **close** is nflverse's closing consensus. CLV: points the market moved toward the number's side (published: from the recorded quote; replayed: from the opener).

## Week 6

| number | games | margin MAE | Brier | log loss | CLV pts (mean) | ATS vs close |
|---|---|---|---|---|---|---|
| Published (what the site showed) | 14 | 8.102 | 0.2792 | 0.7563 | 0.00 (5+/2−, n 14) | 4-10 |
| Replayed (served model, corrected pipeline) | 14 | 8.473 | 0.2935 | 0.7932 | -0.25 (3+/1−, n 14) | 4-10 |
| Closing line | 14 | 6.643 | 0.2585 | 0.7210 | — | — |

Same 14 games for all three: MAE published 8.102 / replayed 8.473 / close 6.643; log loss 0.7563 / 0.7932 / 0.7210.

## Season to date (weeks 1, 2, 3, 4, 5, 6)

| number | games | margin MAE | Brier | log loss | CLV pts (mean) | ATS vs close |
|---|---|---|---|---|---|---|
| Published (what the site showed) | 77 | 9.136 | 0.2384 | 0.6658 | +0.15 (29+/13−, n 77) | 38-34 |
| Replayed (served model, corrected pipeline) | 93 | 9.789 | 0.2291 | 0.6472 | +0.49 (34+/17−, n 77) | 40-47 |
| Closing line | 93 | 9.306 | 0.2334 | 0.6614 | — | — |

Same 77 games for all three: MAE published 9.136 / replayed 9.252 / close 8.896; log loss 0.6658 / 0.6523 / 0.6700.

### Calibration (season to date)

| home win prob | replayed n | predicted | observed | close n | predicted | observed |
|---|---|---|---|---|---|---|
| 0.1–0.2 | 1 | 18.5% | 0.0% | 1 | 17.8% | 0.0% |
| 0.2–0.3 | 4 | 24.7% | 25.0% | 4 | 25.5% | 25.0% |
| 0.3–0.4 | 8 | 33.5% | 12.5% | 13 | 35.6% | 30.8% |
| 0.4–0.5 | 20 | 47.0% | 60.0% | 18 | 44.2% | 44.4% |
| 0.5–0.6 | 14 | 53.8% | 42.9% | 18 | 56.0% | 55.6% |
| 0.6–0.7 | 22 | 66.0% | 36.4% | 15 | 64.8% | 60.0% |
| 0.7–0.8 | 12 | 77.3% | 75.0% | 18 | 75.1% | 66.7% |
| 0.8–0.9 | 11 | 84.2% | 90.9% | 5 | 83.4% | 60.0% |

ECE: replayed 0.147, published 0.138, close 0.047.

## Disagreements of 3+ points with the close (week 6)

| game | published − close | replayed − close | close | final | closer to the final (published / replayed) | biggest card drivers (replayed) |
|---|---|---|---|---|---|---|
| ARI @ LA | -4.10 | -0.94 | +12.50 | -2.00 | model / model | Base strength +8.96, Home field +3.02, Context -1.08, QB +0.42 |
| CAR @ PHI | +3.72 | +6.61 | -3.00 | -11.00 | market / market | Base strength +3.26, Home field +3.02, Rest/travel -1.74, QB -1.02 |
| CHI @ ATL | +3.64 | +1.28 | -1.50 | -8.00 | market / market | Base strength -3.03, Home field +3.02, Context -0.31, Rushing +0.09 |
| DAL @ GB | +3.70 | +5.99 | -1.50 | +10.00 | model / model | Home field +3.02, Base strength +1.82, Rest/travel -0.55, Passing +0.21 |
| NO @ NYG | +1.68 | +6.24 | -1.50 | -7.00 | market / market | Home field +3.02, Base strength +1.57, QB +0.19, Rushing -0.11 |
| NYJ @ NE | +7.32 | +5.70 | +7.50 | +7.00 | market / market | Base strength +9.84, Home field +3.02, Context -0.77, QB +0.63 |
| PIT @ TB | +3.88 | +4.93 | -2.50 | -7.00 | market / market | Home field +3.02, Base strength -1.13, Rest/travel +0.55, Rushing +0.07 |
| WAS @ SF | +0.25 | +3.49 | +7.50 | +6.00 | market / market | Base strength +6.71, Home field +3.02, QB +0.94, Passing +0.29 |

## Biggest misses (week 6, replayed)

| game | model | final | close | residual | market saw it | components pointing the wrong way | base strength prior / current |
|---|---|---|---|---|---|---|---|
| TEN @ IND | +8.84 | -6.00 | +6.50 | -14.84 | yes | Base strength +6.54, Home field +3.02, Passing +0.21, Rushing +0.08 | +4.39 / +2.15 |
| CAR @ PHI | +3.61 | -11.00 | -3.00 | -14.61 | yes | Base strength +3.26, Home field +3.02, Rushing +0.08 | +4.67 / -1.41 |
| ARI @ LA | +11.56 | -2.00 | +12.50 | -13.56 | no | Base strength +8.96, Home field +3.02, QB +0.42, Passing +0.39, Rushing +0.04 | +6.36 / +2.60 |
| NO @ NYG | +4.74 | -7.00 | -1.50 | -11.74 | yes | Home field +3.02, Base strength +1.57, QB +0.19, Passing +0.08 | +0.51 / +1.05 |
| PIT @ TB | +2.43 | -7.00 | -2.50 | -9.43 | yes | Home field +3.02, Rest/travel +0.55, Rushing +0.07 | -0.36 / -0.76 |

_Attribution reads the card; it is not a causal claim._

## Repeat patterns (season to date, replayed residuals)

A pattern repeats when |t| ≥ 2 on at least 30 games and it points the same way in at least 60% of the weeks it can be read in.

| pattern | n | estimate | t | weeks same sign | repeats | reading |
|---|---|---|---|---|---|---|
| home_lean | 88 | -1.991 | -1.58 | 5/6 | no | home sides fell short of the model: home field over-rated |
| component:base_strength | 93 | -0.381 | -1.52 | 5/6 | no | base_strength over-weighted: the bigger its points, the more the result fell short of them |
| component:passing | 93 | -10.120 | -1.55 | 5/6 | no | passing over-weighted: the bigger its points, the more the result fell short of them |
| component:rushing | 93 | -14.575 | -1.60 | 4/6 | no | rushing over-weighted: the bigger its points, the more the result fell short of them |
| component:quarterback | 93 | 0.797 | 0.47 | 4/6 | no | quarterback under-weighted: results went further than its points |
| component:rest_travel | 29 | 8.470 | 2.85 | 5/5 | no | rest_travel under-weighted: results went further than its points |
| component:context | 73 | -1.573 | -0.40 | 4/6 | no | context over-weighted: the bigger its points, the more the result fell short of them |
| prior:current | 93 | -1.308 | -1.72 | 5/5 | no | this season's evidence over-weighted: the prior lets go too fast |
| prior:prior | 93 | -0.328 | -1.11 | 5/6 | no | the prior over-weighted: last season carried too far |
| market_gap | 93 | 0.540 | 1.32 | 4/6 | no | the closing line saw what the model missed: information in prices the model lacks |
| scale | 93 | -0.251 | -1.10 | 5/6 | no | margins too extreme: the model over-states its edges |

## Candidates and the promotion gate

A candidate is promoted only if it beats the served model on margin MAE **and** log loss on the full walk-forward backtest (2010 through this season), on the 2025 holdout, and on 2010–2025 without this season.

No repeat pattern, so no candidate was generated this week. Nothing promoted.

## Next week's cards (26 games, rebuilt on edgedesk_nfl_v2.0.0)

| game | model home margin | win prob | reference close | model − market | card: base / pass / rush / QB / home / context / rest | flag |
|---|---|---|---|---|---|---|
| NE @ CHI | -0.32 | 49.9% | +3.00 | -3.32 | -2.2 / -0.1 / -0.1 / 0.3 / 3.1 / -0.7 / -0.6 | Model disagrees with market by 3.3 pts |
| PIT @ NO | -3.41 | 37.3% | -3.50 | +0.09 | -3.4 / -0.1 / -0.2 / 0.0 / 0.5 / -0.3 / 0.0 |  |
| SF @ ATL | -2.54 | 45.2% | -3.00 | +0.46 | -5.5 / -0.3 / -0.0 / 0.0 / 3.1 / 0.0 / 0.2 |  |
| CIN @ BAL | +0.78 | 50.7% | +3.00 | -2.22 | 1.7 / 0.0 / 0.2 / -1.0 / 3.1 / -1.4 / -1.7 |  |
| TB @ CAR | +2.56 | 55.3% | +3.50 | -0.94 | 0.3 / 0.2 / -0.3 / 0.7 / 3.1 / -1.4 / 0.0 |  |
| NYG @ HOU | +9.50 | 79.9% | +10.00 | -0.50 | 5.0 / 0.2 / 0.2 / 1.1 / 3.1 / 0.0 / 0.0 |  |
| IND @ MIN | +8.70 | 79.0% | +6.50 | +2.20 | 4.1 / 0.2 / -0.0 / 0.7 / 3.1 / -0.3 / 0.9 |  |
| MIA @ NYJ | +0.23 | 50.0% | +4.50 | -4.27 | -0.8 / 0.1 / -0.1 / 0.5 / 3.1 / -0.8 / -1.7 | Model disagrees with market by 4.3 pts |
| CLE @ TEN | -1.05 | 48.7% | -1.50 | +0.45 | -3.2 / -0.2 / 0.1 / -0.1 / 3.1 / -0.7 / 0.0 |  |
| DEN @ ARI | -5.32 | 30.7% | -4.50 | -0.82 | -7.3 / -0.3 / 0.1 / 0.3 / 3.1 / -0.7 / -0.5 |  |
| GB @ DET | +5.33 | 67.8% | +3.00 | +2.33 | 1.9 / 0.0 / 0.1 / 0.4 / 3.1 / -1.1 / 0.9 |  |
| LA @ LV | -4.32 | 33.2% | -4.50 | +0.18 | -7.2 / -0.2 / -0.3 / 1.2 / 3.1 / -1.0 / 0.0 |  |
| KC @ SEA | +5.94 | 69.6% | +3.00 | +2.94 | 3.3 / 0.2 / -0.2 / -0.9 / 3.1 / 0.0 / 0.5 |  |
| DAL @ PHI | +3.79 | 64.3% | -4.50 | +8.29 | 2.3 / 0.1 / -0.0 / -0.2 / 3.1 / -1.4 / 0.0 | Model disagrees with market by 8.3 pts |
| CAR @ GB | +3.90 | 64.6% | +3.00 | +0.90 | 2.0 / 0.1 / -0.0 / 0.0 / 3.1 / -0.7 / -0.6 |  |
| BAL @ BUF | +6.15 | 70.3% | +2.50 | +3.65 | 2.1 / 0.1 / -0.1 / 0.0 / 3.1 / 0.0 / 0.9 | Model disagrees with market by 3.7 pts |
| TEN @ CIN | +10.31 | 82.9% | +10.00 | +0.31 | 6.9 / 0.3 / -0.0 / 0.0 / 3.1 / 0.0 / 0.0 |  |
| ARI @ DAL | +5.70 | 68.8% | +6.50 | -0.80 | 2.8 / 0.0 / -0.0 / 0.0 / 3.1 / 0.0 / -0.2 |  |
| MIN @ DET | +1.91 | 53.3% | +2.50 | -0.59 | -0.0 / -0.0 / -0.1 / 0.0 / 3.1 / -1.1 / 0.0 |  |
| IND @ JAX | +8.84 | 79.2% | +7.50 | +1.34 | 5.9 / 0.3 / 0.0 / 0.0 / 3.1 / -1.4 / 0.9 |  |
| LV @ NYJ | +1.83 | 53.2% | +1.50 | +0.33 | -1.3 / -0.1 / 0.2 / 0.0 / 3.1 / 0.0 / 0.0 |  |
| CLE @ PIT | +5.26 | 67.7% | +4.50 | +0.76 | 3.4 / 0.0 / 0.1 / 0.0 / 3.1 / -1.4 / 0.0 |  |
| ATL @ TB | +1.97 | 53.5% | +1.50 | +0.47 | 0.3 / -0.1 / 0.1 / 0.0 / 3.1 / -1.4 / 0.0 |  |
| LAC @ LA | +6.28 | 70.7% | +7.50 | -1.22 | 5.1 / 0.2 / -0.0 / 0.0 / 3.1 / -0.3 / -1.7 |  |
| KC @ DEN | +1.39 | 52.1% | -1.50 | +2.89 | -0.1 / 0.1 / -0.2 / 0.0 / 3.1 / -1.4 / 0.0 |  |
| NE @ MIA | -7.88 | 22.5% | -7.50 | -0.38 | -8.5 / -0.5 / 0.0 / 0.0 / 3.1 / -1.4 / -0.5 |  |

## Version history

| version | status | role |
|---|---|---|
| edgedesk_football_v1.0.0 | superseded | served before the Step 1 correctness fixes (frozen defence, frozen QB layer, dropped context term, two distributions) |
| edgedesk_football_v1.0.0+fixes | superseded | the incumbent for Steps 2-4: v1 with the Step 1 correctness fixes, refitted walk-forward |
| edgedesk_nfl_v2.0.0 | served | Step 4 promotion: the net_pts sign fix (T5) |

Rollback: `node football/research/nfl_v2/weekly_loop.js --rollback <version>` restores an archived version's params (football/research/nfl_v2/versions/).

# Calibration audit across the other sports (2026-10-19)

The college football audit (`docs/cfb-calibration/README.md`) asked one question of one model: are its probabilities systematically wrong, and does any fix beat it on games it has not seen? This page asks the same question of every other EdgeDesk model that publishes a probability. The rules are the same:

- **Chronological fits only.** Each candidate fix is fitted chronologically: a season is priced with parameters from the seasons before it, never a random split.
- **No market forcing.** No fix forces a number toward a sportsbook line.
- **The number stays coherent.** The probability stays a function of the same margin or score distribution the model publishes.
- **The bar to ship.** A fix ships only if its improvement is significant, stable across seasons and segments, and has an identifiable cause. Otherwise production is left alone.

## Verdicts

| Sport | Calibration problem? | Decision |
| --- | --- | --- |
| **NCAAM, NCAAW** | **Yes: a structural home-court error at neutral sites** | **Fixed in this change** (calibration v2, versioned) |
| NHL | Win probabilities: no. Totals: their slope flags too-extreme probabilities, but no monotone correction improves them out of sample | No change |
| NFL | The model leans ~0.9 pt more to the home side than the close, but outcomes do not support correcting it | No change; monitor |
| NBA | No | No change |
| WNBA | Win probabilities: no. 2026 totals ran 4.1 pts low (season over) | No change; noted |
| MLB, college baseball | Neither publishes a live probability. College baseball's moneyline is calibrated; its run line and tails already block its release | Nothing to deploy |

## NCAAM and NCAAW: fixed

**The fault.** The lab calibration (`basketball/walkforward.js` `calibrate`) fitted one moneyline intercept and one margin intercept on home and neutral games pooled, and applied them everywhere.

- At a neutral site the ratings' home edge is already 0. A pooled intercept corrects home games only by mis-pricing neutral ones.
- In college basketball that intercept corrects a home edge the ratings carry too large. The ratings' h is about 3.9 points, while real home court has fallen, and the intercept drifts more negative every season (NCAAM −0.62 in 2019 to −1.25 in 2026).
- So every neutral-site game was priced short for the side listed at home: NCAAM 2019–26 (5,289 neutral games) mean p 0.547 against 0.585 won; NCAAW −3.2 points.

**The fix (calibration v2, `bb_cal_v2_home_intercept`).** Both intercepts are fitted on home games and applied there only. Two equal teams at a neutral site are 50/50 with a 0 margin. Nothing else changes: same ratings, same slope, same three-season fitting window.

**The evidence.** Every game was rebuilt exactly as production with `basketball/walkforward.js` `pass`, and each season was fitted on the three before it.

| | window | n | Δ log loss (95% CI) | seasons better | neutral-site bias, before → after |
| --- | --- | --- | --- | --- | --- |
| NCAAM | 2012–18 | 41,329 | −0.00032 (−0.00049, −0.00016) | 7 of 7 | −3.95 → −2.19 pts |
| NCAAM | 2019–26 | 47,123 | −0.00053 (−0.00073, −0.00033) | 7 of 8 | −3.78 → −1.46 pts |
| NCAAW | 2012–18 | 39,009 | −0.00020 (−0.00035, −0.00005) | 6 of 7 | −2.44 → −0.67 pts |
| NCAAW | 2019–26 | 44,014 | −0.00045 (−0.00065, −0.00024) | 8 of 8 | −3.24 → −0.47 pts |

- **Stability.** It is better in 14 of 15 seasons from 2012 in each league; the two worse seasons, NCAAM 2020 (+0.00019) and NCAAW 2012 (+0.00004), are inside their own intervals. Every favourite-probability bucket improves, on home games and on neutral games.
- **Margins.** Margin MAE and spread CRPS improve with it (NCAAM CRPS 7.0002 → 6.9949).
- **An independent replication.** The fault was diagnosed on 2019–26, and 2012–18 replicates it independently.
- **Other leagues.** WNBA and the NBA lab fallback have almost no neutral games and are unchanged (NBA 0.62234 both ways; WNBA +0.00004, inside noise). No market status changes in any league.
- **Size.** The gain is small per game, because only about 10% of college games are neutral (NCAAM 11%, NCAAW 9%). On those games it is 0.003 log loss and 2–3 points of probability.

**Versioning.**
- **Live params.** The calibration carries `version` and `intercept: "home_games_only"` into `basketball/params/<league>_live.json`.
- **Model id.** The slate's league model id becomes `points+bb_cal_v2_home_intercept`, so the board, the projections and the performance ledger split on the change.
- **Older files.** A v1 live file still prices exactly as before.
- **Published numbers.** No published forecast is touched. College seasons start in November, and the weekly lab job (`lab-validate.yml`) refits on this code.

## NHL: no change

**The model.**
- A Poisson GLM gives regulation goal rates. An exact score model then handles overtime and the shootout.
- Production already refits a pair recalibration every season on the three before it (`hockey/model/glm.js`): one total compression `a`, and one shrink `b` of the home/away split.

**Win probabilities: calibrated.**
- 2021–26 (n 7,945): slope 1.064 (se 0.053), mean p − result +0.009.
- Walked forward, extra moneyline fixes do not help: slope + intercept on 3 seasons +0.00016 log loss (se 0.00073); intercept only, expanding −0.00009 (0.00019).
- This season's 45 graded games are inside 1 se everywhere.

**Totals: their slope flags too-extreme probabilities, but they are not fixable by recalibration.**

The over/under probabilities have calibration slopes of 0.72–0.78 at every line from 4.5 to 7.5 (n 7,945), which reads as too extreme. I rebuilt all 17,284 out-of-sample games from committed code (`hockey/lab/base.js`) and priced each with the exact score model under further compression of the game total:

- **Fixing the slope worsens log loss.** Compression fixes the slope (≈1.0 at k 0.5–0.6) but makes log loss worse (o5.5: 0.68252 vs 0.68144 now). The log-loss-optimal k, fitted in-sample on the same window, is 0.9 and gains only 0.00007.
- **Walked forward, it loses.** With k fitted on the three seasons before each one, it is slightly worse on 2021–26 at every line (+0.00008 to +0.00019, every CI includes 0).
- **Even an optimistic per-line Platt gains little.** Fitted on the evaluation window itself, it gains only 0.0003–0.0004, and it would make the lines inconsistent with each other and with the moneyline.
- **What the slope really shows.** The model's totals barely beat a constant base rate (o5.5 log loss 0.6814 vs 0.6847). The slope below 1 reflects how little signal the total carries, not a miscalibration a monotone correction can remove.

**Market comparison.** There is no NHL price archive. Eleven graded games had a price observed by publication, too few to say anything.

## NFL: no change, monitor

**What looks like CFB's error.**
- The win probability is Φ(margin / 10.7).
- On the live record (74 graded games), the published margin leans about +0.9 pts (se 0.4) to the home side against the close, and home favourites about +1.3.
- The spread intercept (home field) is 2.48, fitted on 2003–2025. The 2022–25 closes imply only 1.61 (se 0.18; `datapack/nfl_v1/data/game_labels_2022_2026.csv`, regular season, international games excluded).

**Why it is not corrected.**
- **Outcomes back the model.** In those same 2022–25 seasons, home teams won by **2.20 points (se 0.43)**. That is within one se of the model's 2.48, and 0.6 points above what the market priced.
- **Correcting would mean copying the market.** Over 2022–25 the market under-priced home field, so the correction would move the model toward the sportsbook and away from the outcomes.
- **This season is too small to say.** Home teams in 2026 are about −2.5 against the model (se 1.4, n 70–74).
- **CFB was different.** CFB had an internal inconsistency (ratings learned on 3.2, projections adding 4.08) and a decade of outcomes below both. It is now fixed at its source: one walk-forward home field, 2.8, in `edgedesk_cfb_p4_v1.0.1` (`docs/cfb-calibration/README.md`). The NFL intercept is fitted jointly with the ratings, and no double count was found.

**What would change this.**
- A per-game historical out-of-sample file. None is committed (`football/research/train_nfl.py` writes `out/nfl_oos.csv`).
- Or enough live graded games to see home-field error against outcomes. At this sample size a 0.005 Brier difference is undetectable.

## NBA: no change

- The published engine (`nba/`) is a stacked margin model with the probability from its own margin distribution. Each input carries its own home term, and the stack refits the net effect, so nothing is double counted.
- Sealed test 2018–26, opened once (`nba/validation/summary.json`): n 11,543, log loss 0.6178, Brier 0.2146, slope 0.999, mean p − result +0.0071, margin 80% coverage 0.794. Every calibration bucket but one (0.1–0.2, n 206) is inside its interval.
- No live game has been graded yet (the season opens Oct 20).

## WNBA: no change

- 2018–25, n 1,873: slope 0.951, mean p − result −0.002. Every favourite bucket is within ±0.05. The sample is small, about ±4–5 points per bucket.
- The 2026 season (n 348): totals were under-projected by 4.1 pts, with 80% coverage 0.72. That is a level drift in totals, not a win-probability error. The total calibration refits on the three prior seasons at the next run, and the season is over.

## MLB and college baseball: nothing to deploy

**MLB.** Neither model publishes a live probability.
- The history model's walked-forward recalibration leaves its moneyline calibrated (2018–25, n 17,909: slope 0.984, mean p − result −0.0006).
- Its totals are overconfident (2018–25 over 8.5: slope 0.647, n 17,909), but nothing of it is published.

**College baseball.** The moneyline is calibrated on 28,646 out-of-sample games: holdout 2025–26 log loss 0.6026, slope 1.015, mean p − result +0.0018. An extra Platt layer walked forward gains nothing.
- Its known errors are the run line (home −1.5 over-predicted by about 3 points) and the upper tail. Both already fail its release gates, and the board is a research replay, not a live record.

## Reproducing

- **NCAAM / NCAAW.** `node basketball/walkforward.js --league ncaam` (or `ncaaw`, or `all`) rewrites the record and live params from the committed data. The v1-vs-v2 comparison above re-fits both variants on the same rebuilt rows.
- **NHL.** Rows come from `hockey/lab/base.js` `prepare()` + `glmPredictions()`, priced with `hockey/model/distribution.js`.
- **NFL.** The live record is `record/football/nfl_2026.json`, and the 2022–25 closes are in `datapack/nfl_v1/data/game_labels_2022_2026.csv`.

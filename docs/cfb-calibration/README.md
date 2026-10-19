# CFB model calibration — research and diagnostic report (2026 season, weeks 2–7)

**Bottom line.** The college football model is not broadly overconfident. The sample does not show that any calibration fix beats it on unseen games, so the production number is unchanged. The audit did find one structural fault: the home field is applied inconsistently. A correction for it now runs in **shadow** beside every new projection, so it builds its own pregame record. It moves the published number only when it passes a rule declared before the test, and a person turns it on.

**Update, 2026-10-19: the root cause is fixed at its source.** The engine now learns and projects with one home field, 2.8 points, chosen walk-forward (`edgedesk_cfb_p4_v1.0.1`). Over 2014–2025 that cuts spread error by 0.052 points a game (95% CI 0.021–0.082), better in 11 of 12 seasons. 2026 is too small to confirm it yet. See [The root cause, fixed](#the-root-cause-fixed-one-home-field-edgedesk_cfb_p4_v101).

- Every table behind this page: `football/cfb_p4/research/report/LIVE_CALIBRATION.md` (generated) and `football/validation/cfb_live_calibration.json` (complete).
- To rerun: `npm run cfb:livecal` (report only) or `npm run cfb:livecal:write`.
- Tests: `npm run cfb:livecal:test`.

## What was measured, and from where

- **Source.** The season's public graded record, `record/football/cfb_2026.json`. Each row is the pick exactly as published (margin, total, win probability, timestamp), with the close and the verified final. The performance page grades this same record.
- **Supabase.** It was not reachable from the session that produced this report. The committed record is what the Supabase sync carries.
- **Sample.**
  - 410 graded games (weeks 2–7). 325 carry a published win probability; week 2 published none.
  - 186 have a line EdgeDesk had observed by the moment the pick was published. Sources are the record's quote ledger, the CFB Lab's hourly quotes, the record's entry market and each pick's price lock. Each line was taken only if observed at or before `pick.at`, never after, and never the close.
  - None exist before week 4, and FBS-vs-FCS games have none.
- **Sign convention.** Every margin is a home margin (+ = home favoured), and each book line was negated once on the way in. Model vs close correlates at +0.92, and model vs publish-time line at +0.94. No row is an orientation fault.

## Phase 1 — how the number is made

- **Margin.** The fair spread is the sum of the engine's terms (`football/cfb_p4/engine.js`):
  - the rating gap: a capped-margin rating recursion (k 0.14, cap 35), blended with a carried preseason prior. At week 7 the prior still carries about 60% of the weight.
  - home field: 4.082 points at every non-neutral venue (2.8 from `edgedesk_cfb_p4_v1.0.1`, below).
  - a matchup term.
  - schedule, about 0.
- **Unpriced inputs.** The QB value term, injuries, travel, altitude and weather all contribute 0.0 points. Each is unpriced by design and says why. They widen uncertainty instead.
- **The win probability is derived, not modelled separately.**
  - `P(home) = Phi(fair_spread / sigma)`. Sigma comes from the volatility layer, where only one driver survived its fit (`early_season`), clamped to 14.63–15.68.
  - Recovered from the published pairs, sigma is 14.6–15.5 (median 14.85) on every game.
- **Double counting: home field is applied inconsistently.**
  - The rating recursion learns team strength against a 3.2-point home field (`params.rating.hyperparams.hfa`).
  - Every projection then adds 4.082 (`params.venue.league_hfa`, measured on 2001–2013; the per-venue table was rejected and is empty).
  - So every home game carries about 0.9 points the ratings never earned. Home field has also declined: fitted on 2015–2025 final margins it is about 2.6 (`football/cfb_p4/margin_calibration.js`).
  - **Fixed in `edgedesk_cfb_p4_v1.0.1`:** one value for both, see [The root cause, fixed](#the-root-cause-fixed-one-home-field-edgedesk_cfb_p4_v101).
  - No other input is counted twice. QB, injury, travel, altitude and weather are each 0.0 points and only widen sigma.
- **Immutable pregame numbers.**
  - The record refuses any number published at or after kickoff. The pick is the last pregame number.
  - The performance ledger hash-chains every forecast.
  - The analysis here reads both and writes neither. A test hashes the record before and after a run.

## Phase 2 — what the record says

**Calibration of the published probability** (325 games, favourite perspective, all buckets n ≥ 30):

| bucket | n | predicted | won | 95% CI | Brier |
| --- | --- | --- | --- | --- | --- |
| 50–60 | 64 | 0.549 | 0.578 | 0.456–0.691 | 0.244 |
| 60–70 | 67 | 0.653 | **0.537** | 0.419–0.651 | 0.267 |
| 70–80 | 65 | 0.744 | 0.785 | 0.670–0.867 | 0.167 |
| 80–90 | 53 | 0.854 | 0.925 | 0.821–0.970 | 0.076 |
| 90–100 | 76 | 0.957 | 0.921 | 0.838–0.963 | 0.070 |

- **Big favourites are not the season's problem.** The 90%+ picks won 92.1% (70 of 76) against 95.7% predicted, inside the interval. Of week 7's three 90%+ losses:
  - Georgia was priced at the market (model 19.8, line 18.5).
  - Temple's line fell 6 points after the number was published (23.5 at publication, 17.5 at the close).
  - Only Texas was a real model-vs-market disagreement (19.95 vs 10.5).
- The one bucket outside its interval is 60–70%. The 80–90% bucket is underconfident.
- Overall: Brier 0.1655, log loss 0.495. Week by week: 0.101, 0.149, 0.169, 0.211, 0.217. The rise tracks slate composition (early-season mismatches give way to conference play), not decay: the no-vig close rose the same way (0.108 to 0.219). Margin MAE ran 10.9–14.4 by week with no trend.

**Margin compression.**

| regression | slope (se) |
| --- | --- |
| actual ~ model, FBS vs FBS | 0.963 (0.062) |
| actual ~ model, all | 1.114 (0.052) |
| actual ~ model, FBS vs FCS | 1.229 (0.247) |
| model ~ close, FBS vs FBS home games | **1.91** constant (0.28), slope 0.910 (0.019) |
| (actual − line at publication) ~ (model − line at publication) | **0.087 (0.277)** |
| (close − line at publication) ~ (model − line at publication) | 0.094 (0.026) |

- **The margins are not too spread out.** The FBS-vs-FBS slope is 0.96, within one standard error of 1. The model is slightly less spread than the market (0.91).
- **What it does carry is a constant 1.9-point lean to the home side against the close.** It shows every week (+0.7 to +2.1). Home favourites run 1.94 above the close and land 1.24 short of the model. Road favourites run −0.41 and land on it. Home teams won 57.9% against a mean model probability of 61.1% (no-vig close 56.4%). The Oct 17 examples Temple, Texas, Georgia and Houston were home favourites; Utah was on the road.
- **Disagreement with the market has no measurable value for results.** The slope is 0.09 with a 95% interval of −0.46 to +0.63. It does anticipate a little line movement, about 9% of the gap.

**Error by size of predicted margin** (FBS vs FBS; bias = actual − predicted, favourite perspective):

| margin | n | model MAE | bias (se) | close MAE | model − line at publication |
| --- | --- | --- | --- | --- | --- |
| 0–7 | 135 | 11.91 | −1.12 (1.34) | 10.80 | −0.08 |
| 7–14 | 101 | 11.17 | −0.32 (1.38) | 10.66 | +1.87 |
| 14–21 | 58 | 12.21 | +1.62 (2.01) | 11.16 | +1.65 |
| 21+ | 43 | 13.64 | **−4.73 (2.46)** | 12.34 | +2.40 |

- **21+ favourites.** They fell short of the model by 4.7 points and of the close by 3.0.
- **FBS-vs-FCS games are the largest single error in the season.**
  - The engine prices every FCS opponent at one floor rating (−28).
  - Predicted 21+ favourites beat the model by **8.6** points (n 58, se 2.3).
  - Model MAE there is 15.5 against 11.7 for the close.
  - That error makes those probabilities **under**confident, not over. The team-specific FCS bridge that would fix it is already tested and not demonstrated (`football/validation/fcs_bridge_cfb.json`).

**Against the market** (benchmarks only; never inputs):

| | n | model | market |
| --- | --- | --- | --- |
| Brier vs no-vig closing moneyline | 294 | 0.1803 | 0.1652 |
| log loss vs no-vig closing moneyline | 294 | 0.537 | 0.496 |
| Brier vs no-vig moneyline at publication | 157 | 0.2072 | 0.2006 |
| margin MAE vs the close | 410 | 12.60 | 11.14 |
| margin MAE vs the line at publication | 186 | 12.61 | 12.02 |

- **Where the Brier gap comes from.** Murphy decomposition: reliability 0.0077 vs 0.0026, resolution 0.070 vs 0.082. Most of the gap is resolution, meaning the ordering of games, not calibration.
- **Sigma is not the lever.** The sigma that best fits the outcomes is 15.4 (16.25 FBS vs FBS) against about 14.85 used. Brier is flat from 14.85 to 16 (0.1653 at both).

**Segments, sample sizes flagged.**
- When the model was 7+ points more bullish on its favourite than the line at publication, the favourite won 43% (6 of 14, CI 21–67%) against 75% predicted and 55% from the market. That is the clearest overconfidence signature, and n = 14 is too small to fit anything to.
- Conference-level splits are 10–30 games each and are reported only as stability checks.

**Totals.** No measurable bias: model MAE 12.68 vs close 12.23; bias −1.11 (se 0.86); slope 0.92 (se 0.23).

**Stale prior?** A results-only 2026 rating built from games finished before each pick adds nothing beyond the model (slope 0.08, se 0.08). The 60% prior weight is not a measurable error yet.

## Phase 3 — every candidate fix, on the same unseen games

**Design.**
- Chronological walk-forward. Weeks 2–3 are the initial training period and are never scored.
- Each of the 250 scored games (weeks 4–7) is priced only with parameters fitted on FBS-vs-FBS games whose final was known before *its own* pick was published, and only with a line observed by then.
- FBS-vs-FCS games keep the published number: in an exploratory pooled fit, the fit says to *expand* margins (k 1.11) and add *more* home field (h 4.9–6.3).
- Every option is priced through the engine's own `E.liveCalibration.apply`.
- Intervals are paired bootstrap, 4,000 draws.

| option | Brier | Δ Brier (95% CI) | Δ log loss | Δ MAE (95% CI) | weeks better | status |
| --- | --- | --- | --- | --- | --- | --- |
| current model | 0.1848 | — | — | — (MAE 12.52) | — | control |
| (a) shrink k × margin | 0.1847 | −0.0001 (−0.0012 to +0.0010) | −0.0007 | +0.03 (−0.06 to +0.13) | 2/4 | candidate |
| (b) blend with line at publication | 0.1837 | −0.0011 (−0.0079 to +0.0063) | −0.0007 | **−0.20** (−0.49 to +0.10) | 2/4 | candidate |
| (b) blend, w by disagreement | 0.1836 | −0.0012 (−0.0081 to +0.0062) | −0.0011 | −0.21 (−0.50 to +0.09) | 2/4 | candidate |
| (b) blend, w by margin size | 0.1842 | −0.0006 | +0.0052 | −0.17 | 2/4 | research only |
| (c) refit sigma | 0.1862 | +0.0014 | +0.0053 | 0 | 0/4 | rejected |
| (c) probit-Platt | 0.1860 | +0.0012 | +0.0036 | +0.07 | 1/4 | rejected |
| (c) isotonic | 0.1967 | **+0.0119** (+0.0012 to +0.0230) | +0.078 | 0 | 0/4 | rejected |
| (d) cap at 95% | 0.1848 | +0.0000 | +0.0012 | 0 | 1/4 | rejected |
| **home-field fix, pre-registered** | **0.1834** | **−0.0015** (−0.0051 to +0.0023) | **−0.0059** | +0.04 (−0.14 to +0.23) | **3/4** | **candidate** |
| home-field constant refit on 2026 | 0.1837 | −0.0011 (−0.0038 to +0.0017) | −0.0043 | +0.04 | 3/4 | candidate |

**What the fits said, week by week** (`LIVE_CALIBRATION.md` §8):
- The blend's model weight was 0.002 (week 6) and 0.106 (week 7), and 0.13 on the full season. Weeks 4–5 had too few publish-time lines to fit one. The blend publishes the sportsbook line with the model as a rounding error.
- There is no evidence w should shrink with disagreement or margin size. Its slopes are +0.42 (se 0.91) and +0.24 (se 0.34) per 10 points.
- Sigma and Platt fitted on September said *sharpen*: sigma ×0.77 and probit a 1.42 for week 4, easing to ×0.97 and 1.12 by week 7. That is why they lose: early-season results were easier than conference play.

**Stability.**
- The home-field fix improves Brier in weeks 4–6, loses in week 7, and improves P4 and Group of 5 alike.
- It improves the 7–14, 14–21 and 21+ buckets and leaves 0–7 flat.
- It is mixed by conference (n 10–30 each).
- The blend helps home favourites and hurts road favourites, and swings week to week.

**Choice.**
- No option clears the bar. No Brier interval excludes zero except isotonic's, which is significantly worse.
- The simplest option that points the right way on calibration without hurting MAE materially is the **pre-registered home-field fix**. It is consistent with an identified structural cause, it never saw a 2026 game or a market number, and it is better on Brier, on log loss and in 3 of 4 weeks.
- The blend has the best MAE, but at a model weight of 0.1 it *is* the market. The disagreement test says the model adds nothing to the line yet, and that is a finding to report, not a calibration to ship.

## Phase 4 — deployment: shadow, not production

| | |
| --- | --- |
| Production number | raw margin, Phi(margin/sigma): `edgedesk_cfb_p4_v1.0.0` until 2026-10-19, then `edgedesk_cfb_p4_v1.0.1` (one home field, [below](#the-root-cause-fixed-one-home-field-edgedesk_cfb_p4_v101)) |
| Shadow | `HFA_PRE` from `cfb_live_cal_v1`: margin = 0.9637 × (raw − applied home field) + 2.582 at a home venue (× 0.9637 at a neutral one); P = Phi(margin / engine sigma); total unchanged; projected score re-derived from both. The applied home field is 4.082 on v1.0.0 picks and 2.8 on v1.0.1 picks |
| Where it shows | the engine's `model.live_calibration`, and every slate row's `calibration_shadow` (`football/fbs/slate.json`), committed hourly before kickoff |
| Parameters | `football/cfb_p4/live_calibration.js`, GENERATED; every option's season fit (k, h, w and both w slopes, sigma scale, probit a/b) is in `cfb_live_calibration.json` → `season_fit` |
| Switch and rule | `football/cfb_p4/live_calibration_config.json`: `promote` (false) and `promotion_rule` |
| Versioning | promoted, new projections carry `edgedesk_cfb_p4_v1.1.0` on the slate row (`model_version`, and the base of `shadow_model_version`, which the performance ledger keys its CFB model id on). The record keys each new pick by it, and the performance page's model filter splits on it. No published pick or grade is rewritten. The pricing-path change is declared in `football/cfb_validation/versions.jsonl` (`edgedesk_cfb_r1+p8`) |
| Tests | `football/cfb_p4/live_calibration.test.js`: shadow changes nothing; P = Phi(m/s) including the cap; promotion swaps the number and the version; sign convention and orientation faults; no close, no future line, no future result reaches a fit; the record is byte-identical after a run |

**When the shadow can be promoted.** The rule (all must hold, on walk-forward games only):
- at least 300 scored games and 6 weeks;
- a Brier interval entirely below zero;
- better log loss;
- MAE no more than 0.05 worse;
- better in two thirds of weeks;
- no group, margin bucket or favourite side of 30+ games worse by more than 0.005;
- a probability that comes from the margin.

**What the sample can and cannot show.**
- An effect the size of the home-field fix's (−0.0015 Brier) needs about **3,150** unseen FBS games to be told from noise at 95% confidence and 80% power. That is roughly four seasons.
- The 2026 record alone will not settle it this year. The run reports that number every time (`promotion.games_needed`).
- The more direct fix is to remove the inconsistency at its source: one home-field constant for the rating recursion and the projection, fitted on recent seasons. That fix is now made and tested on twelve seasons of history; see [The root cause, fixed](#the-root-cause-fixed-one-home-field-edgedesk_cfb_p4_v101).

## The root cause, fixed: one home field (`edgedesk_cfb_p4_v1.0.1`)

**Where the split came from.**
- The python trainer (`research/train_p4.py`, `run`) learns and predicts with one home field: its final pass uses `league_hfa` (4.082) for both. The shipped seeds come from that pass: a cold replay of the JS engine under 4.082 reproduces all 136 seed ratings to 0.0001.
- The JS rating update instead defaults to `rating.hyperparams.hfa` (3.2, the value tuned before `league_hfa` was measured), while every projection adds `venue.league_hfa`. Every live update since the seeds learned against a different number than the projection adds.
- **Matching the trainer is not the fix.** 4.082 for both is worse than today: MAE +0.022 (0.017 to 0.027). 4.082 was measured on 2001–2013, and home field has declined since.

**The fix.**
- One value for the rating update and the projection, chosen walk-forward. Each season takes the grid value (2.0 to 4.082) whose cold replay had the lowest spread MAE over the four seasons before it. Each replay used that value for its whole history, so its pregame state is the state production would have held.
- **For 2026 the rule gives 2.8** (fitted on 2022–2025). Since 2014 its choices drifted from 3.0 to 2.2–2.6.
- The seed ratings are rebuilt under 2.8 by the same recursion. The seeded game counts and scoring do not depend on the home field and are unchanged.
- Nothing reads a market number: the close is used to score, never to fit.
- **The bar was declared before the test** (`football/cfb_p4/v12_correction.js`): pooled walk-forward MAE better by at least 0.05 points, and better in a majority of seasons.

**The evidence: replays of the shipped engine, 2014–2025** (n 8,724 FBS-vs-FBS games, 95% intervals from a bootstrap over season-weeks):

| | current (learn 3.2, add 4.082) | one home field, walk-forward | change (95% CI) |
| --- | --- | --- | --- |
| spread MAE | 13.017 | 12.965 | **−0.052** (−0.082, −0.021) |
| Brier | 0.1812 | 0.1802 | −0.0010 (−0.0015, −0.0004) |
| log loss | 0.5362 | 0.5338 | −0.0024 (−0.0038, −0.0009) |
| home games, actual − model | −1.52 | +0.05 | |
| home games, model − close | +1.27 | −0.31 | |

**Stable, not just better on average.**
- **Seasons.** Better in 11 of 12; the twelfth, 2024, is +0.001. Any fixed value from 2.6 to 3.2 beats the current engine in all 12 test seasons, and 2.8 does in 18 of 20 since 2006.
- **Window length.** Trailing windows of 3, 5, 6 and 8 seasons give −0.053, −0.054, −0.054 and −0.052, every interval excluding 0. Two seasons gives −0.046.
- **Segments.** No segment is significantly worse, on MAE or on log loss. Spread MAE change (\* = interval excludes 0):

| segment | n | MAE change | segment | n | MAE change |
| --- | --- | --- | --- | --- | --- |
| weeks 1–4 | 2,217 | −0.020 | home team Power conference | 4,719 | −0.016 |
| weeks 5–9 | 3,136 | −0.043 | home team Group of 5 | 4,005 | −0.095\* |
| weeks 10+ | 3,237 | −0.084\* | conference games | 6,303 | −0.078\* |
| postseason | 134 | −0.028 | non-conference | 2,421 | +0.015 |
| predicted margin 0–3 | 1,584 | −0.021 | 7–14 | 2,619 | −0.083\* |
| 3–7 | 1,963 | −0.084\* | 14–21 | 1,458 | −0.051 |
| 21+ | 1,100 | +0.032 | neutral sites | 382 | −0.015 |

- **The market window, 2022–2025** (n 3,127): MAE −0.034 (−0.094, +0.028), log loss −0.0022 (−0.0051, +0.0010). The same direction, but not significant on its own.

**The unseen season.**
- **The frame.** 2026 through October 17, n 386. This is production's exact frame: the shipped seeds and the rebuilt seeds, every game absorbed in kickoff order.
- **The numbers.** MAE +0.027 (−0.059, +0.091). Brier −0.0005 (−0.0018, +0.0007). Log loss −0.0020 (−0.0053, +0.0011). The home lean against the close falls from +1.49 to +0.20.
- **Too small to confirm or refute a 0.05-point effect.** The interval covers both. Home teams have outperformed the fixed model by 0.65 points so far (production: −0.62), within one standard error either way.

**Is it fixed?**
- **The inconsistency: yes, by construction.** The rating update and the projection read the same number, and `football/cfb_p4/home_field.test.js` fails if they ever differ.
- **The symptom: mostly.** The home lean against the close went from +1.27 to −0.31 over 2014–2025, and from +1.49 to +0.20 in 2026.
- **Accuracy: better out of sample.** Over twelve seasons it improves by the repo's pre-declared bar, narrowly (0.052 against 0.05), and stably. 2026 alone cannot confirm it yet.

**What changes, and what does not.**
- **New projections.** On the October 19 slate, every home-game margin moves toward the visitor by 1.15–1.56 points (mean 1.34). Neutral sites move only by the small seed change.
- **Versioning.** New projections carry `edgedesk_cfb_p4_v1.0.1`:
  - on the slate row's `model_version`;
  - as the base of `shadow_model_version`, which the performance ledger keys its CFB model id on;
  - on every new record pick.
- **Published numbers are untouched.** Every pick and grade published before keeps its v1.0.0 number.
- **The freeze.** `football/cfb_validation/versions.jsonl` row `edgedesk_cfb_r1+p9`. `home_field.js` is now on the pricing path.
- **The Model Lab.** V1 keeps its identity (`edgedesk_cfb_p4_v1.0.0`), because its champion role and EXP-001 are keyed to it. The build version rides as V1's `calibration_version`, so the hourly run logs a `CALIBRATION_CHANGED` audit event. Registering v1.0.1 as a separate lab model is a governance decision for a person.
- **The shadows stay coherent.** The margin calibrator and `HFA_PRE` subtract the home field each pick actually applied. `HFA_PRE`'s original reason is now fixed at the source; it stays a shadow.
- **The board and its harness.** The board loads `home_field.js` right after the engine, and waits for it, as it does for the regime curve. The test harness (`tools/football/_module.js`) loads it too.

**Where it lives, and how to rerun.**
- `football/cfb_p4/home_field.js` is GENERATED. It holds the value, the rebuilt seeds and the record, and it applies only to the `params.js` it was built for (`for_params_built_at`). A regenerated `params.js` turns it off rather than mixing two trainings, so regenerate the file with it.
- The trainer still measures `league_hfa` once, on 2001–2013. Adopting the walk-forward rule inside `train_p4.py` is the follow-up for the next full retrain.
- The complete report is `football/validation/cfb_home_field.json`.

```
npm run cfb:hfa -- --data DIR                      # replays + walk-forward, writes nothing
npm run cfb:hfa -- --data DIR --live-sched cfb_schedules_2026.csv --live-record record/football/cfb_2026.json \
    --write football/validation/cfb_home_field.json --write-home-field football/cfb_p4/home_field.js --promote
npm run cfb:hfa:test
```

- `DIR` is the layout of `research/fetch_data.sh`, plus `out/market.csv` from `research/build_market.py`. `--promote` is a person's switch: the file is promoted only when it is passed AND the record passes the bar.

**Limits.**
- **No efficiency feed in the replay.** The replay has no team-game efficiency feed, so the matchup layer stays on its shipped seed. Both arms share that frame. On 2022–2025 it gives MAE 12.751, against 12.769 in the shipped headline.
- **Residual layers.** Travel, rivalry and the conference term were fitted on residuals under 4.082. They are validated here end to end as shipped, not refitted.
- **One unrelated observation, not acted on.** At neutral sites the team listed at home beats every variant's margin by about 1.5 points (n 382, about 1.9 se). The home-field value does not change this.

## Refitting as the season grows

```
npm run cfb:livecal          # diagnostics + walk-forward, writes nothing
npm run cfb:livecal:write    # rewrites the three artifacts from the current record
npm run cfb:livecal:test
```

- Nothing refits on a schedule. That is deliberate, and it matches `football-weekly-build.yml`: refitting on a timer is how a layer starts fitting the recent past without anyone deciding to.
- Promotion takes three steps:
  1. Run the write command.
  2. Read the decision.
  3. If it says VALIDATED, set `promote: true` in the config, rerun the write command, and commit both files.

  The engine then prices from it and the version changes on the next slate.

# CFB model calibration — research and diagnostic report (2026 season, weeks 2–7)

**Bottom line.** The college football model is not broadly overconfident. The sample does not show that any calibration fix beats it on unseen games, so the production number is unchanged. The audit did find one structural fault: the home field is applied inconsistently. A correction for it now runs in **shadow** beside every new projection, so it builds its own pregame record. It moves the published number only when it passes a rule declared before the test, and a person turns it on.

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
  - home field: 4.082 points at every non-neutral venue.
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
| Production number | **unchanged**: `edgedesk_cfb_p4_v1.0.0`, raw margin, Phi(margin/sigma) |
| Shadow | `HFA_PRE` from `cfb_live_cal_v1`: margin = 0.9637 × (raw − 4.082) + 2.582 at a home venue (× 0.9637 at a neutral one); P = Phi(margin / engine sigma); total unchanged; projected score re-derived from both |
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
- The more direct fix is to remove the inconsistency at its source in the next retrain. The rating recursion and the projection should use one home-field constant, fitted on recent seasons. That is a change to `football/cfb_p4/research/train_p4.py` and its walk-forward, not a calibration layer.

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

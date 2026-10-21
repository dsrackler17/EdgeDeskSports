# NFL v2: walk-forward backtest against v1 and the closing line

Generated 2026-10-20T19:43:18Z by `model_loop/adapters/nfl/backtest.py report`; preregistration sha256 `bfc174dec9fd449bc923db783ad769432da41d37ce6ce0b6ec0d0fb21782a8c3` (`docs/model-loop/nfl/prereg.json`, written before tuning).

## Decision (as preregistered)

**DO NOT SHIP YET: v2 does not clear every condition.**

- Against **v1_trained**: does not clear. holdout log loss 0.63899 worse than 0.6362
- Against **v1_shipped**: clears. clears every condition

Rule: v2 may replace v1 on the card only if, on the 2025 holdout, it has lower margin MAE AND lower log loss than v1 as trained (walk-forward) AND v1 as shipped, AND it is not worse on the full 2011-2025 backtest. Otherwise v1 stays and v2 remains EXPERIMENTAL. Beating the close is reported, not required.

## Phase 1, item by item

| # | Asked for | What was built, and what the backtest says |
|---|---|---|
| 1 | Opponent-adjusted EPA, pass O / pass D / rush O / rush D, from nflverse play-by-play; pass weighted over rush | Built (`ratings.py`: per-week penalized fit, offense and defense as separate ratings with separate priors). Line influence over 2011–2025 (SD of points): passing 2.53 vs rushing 1.00; pass offense incl. QB 2.40 vs pass defense 0.73. Separate offense/defense *coefficients*: removing it changes validation MAE by -0.0063 and log loss by -0.00030: INACTIVE (no incremental value on validation); the weighting comes from the ratings instead (defense carried 0.4 season to season vs offense 0.8). |
| 2 | Recency weighting within the season | Built; half-life tuned to 12 weeks. removing it changes validation MAE by -0.0004 and log loss by +0.00026: active (adds value) (effectively neutral). |
| 3 | Bayesian prior blending with a fitted shrink rate | Built; prior strength in plays of evidence tuned on 2011–2019 (pass O 600, pass D 300, rush O 600, rush D 300, QB 100). Last-season carryover: removing it changes validation MAE by +0.0368 and log loss by +0.00435: active (adds value). The prior's share falls from 100% in week 1 to about half by week 2 and ~27% by week 8 (table below). |
| 4 | Market-informed priors (preseason win totals, prior-week closing spreads) | Prior-week closing spreads: built as a market rating refitted every week (half-life 2 weeks). removing it changes validation MAE by +0.1599 and log loss by +0.00735: active (adds value): the largest single gain. Preseason win totals: **inactive, not owned**. |
| 5 | QB value separate from the team | Built: each quarterback is a parameter of his own that travels with the player; the team's pass rating is what remains. removing it changes validation MAE by +0.0462 and log loss by +0.00563: active (adds value). QB line influence SD 2.20 pts; contested starters are priced both ways on the card. |
| 6 | Personnel-aware priors (QB, lead RB, top WR, OL continuity; offseason moves) | QB: carries with the player (tuned carry 1.0). RB/WR production that moved teams: built and tested, tuned to weight 0.0 on 2011–2019 (no value), so **inactive**. OL snap continuity: removing it changes validation MAE by +0.0003 and log loss by -0.00001: active (adds value) (negligible). |
| 7 | Home field from recent seasons with shrinkage; rest, short weeks, travel distance and time zones as separate components | Home field fitted walk-forward from recent seasons: 2.15 pts for 2026 (home field with a typical trip). Rest / bye / short week: removing it changes validation MAE by -0.0023 and log loss by +0.00034: active (adds value). Travel distance, time zones, body clock: removing it changes validation MAE by +0.0091 and log loss by +0.00027: active (adds value); jointly valid, but miles and time zones are nearly collinear and the time-zone coefficient alone has the wrong sign, so the split between them should not be read individually (Phase 2 candidate: one combined travel term). |
| 8 | Margin distribution that respects key numbers | Built (`core/distribution.py`), mean solved to equal the projection. Push rate at closing lines of exactly 3: predicted 8.2% vs observed 9.0% (a plain normal says 2.8%); at 7: 5.5% vs 7.0% (normal 2.8%). Three-way cover log loss at the close 0.85503 vs 0.87004. For straight-up win probability the shape adds nothing (log loss within 0.0002 of a normal). |
| 9 | Probability calibration (isotonic or Platt) fitted on history | The distribution's width is fitted by likelihood on earlier seasons only, which calibrates it (ECE 0.0168 over 2011–2025). A Platt layer on top: log loss 0.62222 → 0.62207, ECE → 0.0193; isotonic: log loss → 0.62442. Neither helps, so **no extra layer** (which also keeps win, cover and moneyline on one table). |
| 10 | Garbage-time filtering | Built: plays outside 10–90% win probability count 0.25 of a play (fixed in advance, not tuned). removing it changes validation MAE by +0.0033 and log loss by +0.00134: active (adds value). |

## Every window, every model, the same games

Margin MAE is against the final score. *Close* is the nflverse consensus closing line on the same games. Log loss and Brier are on games with a closing moneyline, compared with the no-vig close. v1 as trained is the original research pipeline's own walk-forward (every coefficient out of sample). v1 as shipped is the browser engine's absorb path, with defenses frozen; its coefficients were fitted on 2003–2025, so it has an in-sample advantage before 2026.

| Window | n | Model | Margin MAE | Close MAE | Log loss | Close log loss | Brier | \|model − close\| | ≥3 pts from close | Total MAE | Close total MAE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tune 2011–2019 | 2403 | v2 (this rebuild) | 10.324 | 10.179 | 0.6191 | 0.6088 | 0.2153 | 2.09 | 24.3% | 10.685 | 10.529 |
| Tune 2011–2019 | 2403 | v1 as trained | 10.463 | 10.179 | 0.6271 | 0.6088 | 0.2190 | 2.41 | 32.1% | 10.727 | 10.529 |
| Tune 2011–2019 | 2403 | v1 as shipped | 10.694 | 10.179 | 0.6454 | 0.6088 | 0.2273 | 3.46 | 50.3% | 10.636 | 10.529 |
| Tune 2011–2019 | 2403 | v1 shipped, defense fixed | 10.447 | 10.179 | 0.6264 | 0.6088 | 0.2187 | 2.38 | 30.6% | 10.685 | 10.529 |
| Validation 2020–2024 | 1408 | v2 (this rebuild) | 10.051 | 9.786 | 0.6242 | 0.6070 | 0.2175 | 2.16 | 24.5% | 10.411 | 10.289 |
| Validation 2020–2024 | 1408 | v1 as trained | 10.185 | 9.786 | 0.6383 | 0.6070 | 0.2237 | 2.46 | 30.8% | 10.615 | 10.289 |
| Validation 2020–2024 | 1408 | v1 as shipped | 10.300 | 9.786 | 0.6440 | 0.6070 | 0.2269 | 3.42 | 47.9% | 10.576 | 10.289 |
| Validation 2020–2024 | 1408 | v1 shipped, defense fixed | 10.188 | 9.786 | 0.6384 | 0.6070 | 0.2238 | 2.51 | 32.1% | 10.411 | 10.289 |
| **Holdout 2025** | 285 | v2 (this rebuild) | 10.058 | 9.670 | 0.6390 | 0.6070 | 0.2238 | 2.18 | 24.9% | 10.495 | 10.423 |
| **Holdout 2025** | 285 | v1 as trained | 10.166 | 9.670 | 0.6362 | 0.6070 | 0.2234 | 2.32 | 29.5% | 10.395 | 10.423 |
| **Holdout 2025** | 285 | v1 as shipped | 10.517 | 9.670 | 0.6746 | 0.6070 | 0.2406 | 3.54 | 48.8% | 10.446 | 10.423 |
| **Holdout 2025** | 285 | v1 shipped, defense fixed | 10.229 | 9.670 | 0.6434 | 0.6070 | 0.2264 | 2.45 | 31.6% | 10.495 | 10.423 |
| Live 2026 (wk 1–6) | 93 | v2 (this rebuild) | 9.550 | 9.306 | 0.6563 | 0.6614 | 0.2318 | 2.16 | 23.7% | 11.364 | 10.597 |
| Live 2026 (wk 1–6) | 93 | v1 as trained | 9.727 | 9.306 | 0.6610 | 0.6614 | 0.2359 | 2.56 | 37.6% | 11.234 | 10.597 |
| Live 2026 (wk 1–6) | 93 | v1 as shipped | 9.704 | 9.306 | 0.6921 | 0.6614 | 0.2492 | 3.27 | 41.9% | 11.286 | 10.597 |
| Live 2026 (wk 1–6) | 93 | v1 shipped, defense fixed | 9.636 | 9.306 | 0.6585 | 0.6614 | 0.2346 | 2.65 | 38.7% | 11.364 | 10.597 |
| Full backtest 2011–2025 | 4096 | v2 (this rebuild) | 10.212 | 10.008 | 0.6222 | 0.6081 | 0.2166 | 2.12 | 24.4% | 10.578 | 10.439 |
| Full backtest 2011–2025 | 4096 | v1 as trained | 10.347 | 10.008 | 0.6316 | 0.6081 | 0.2209 | 2.42 | 31.5% | 10.665 | 10.439 |
| Full backtest 2011–2025 | 4096 | v1 as shipped | 10.546 | 10.008 | 0.6470 | 0.6081 | 0.2281 | 3.45 | 49.3% | 10.602 | 10.439 |
| Full backtest 2011–2025 | 4096 | v1 shipped, defense fixed | 10.343 | 10.008 | 0.6317 | 0.6081 | 0.2210 | 2.43 | 31.2% | 10.578 | 10.439 |
| Live 2026 (wk 1–6) | 77 | v1 as published (record) | 9.136 | 8.896 | 0.6658 | 0.6700 | 0.2384 | 2.87 | 44.2% | — | — |

## Paired differences (same games; bootstrap 95% intervals)

| Window | Comparison | n | Δ MAE (neg = v2 better) | 95% CI | Δ log loss | 95% CI |
|---|---|---|---|---|---|---|
| Tune 2011–2019 | v2 − v1 trained | 2403 | -0.139 | [-0.250, -0.021] | -0.0080 | [-0.0148, -0.0016] |
| Tune 2011–2019 | v2 − v1 shipped | 2403 | -0.370 | [-0.519, -0.212] | -0.0263 | [-0.0348, -0.0180] |
| Tune 2011–2019 | v2 − close | 2403 | +0.145 | [+0.044, +0.247] | — | — |
| Validation 2020–2024 | v2 − v1 trained | 1408 | -0.133 | [-0.274, +0.009] | -0.0141 | [-0.0231, -0.0053] |
| Validation 2020–2024 | v2 − v1 shipped | 1408 | -0.248 | [-0.442, -0.061] | -0.0198 | [-0.0312, -0.0088] |
| Validation 2020–2024 | v2 − close | 1408 | +0.265 | [+0.124, +0.401] | — | — |
| **Holdout 2025** | v2 − v1 trained | 285 | -0.107 | [-0.401, +0.189] | +0.0028 | [-0.0141, +0.0192] |
| **Holdout 2025** | v2 − v1 shipped | 285 | -0.459 | [-0.896, -0.037] | -0.0356 | [-0.0625, -0.0083] |
| **Holdout 2025** | v2 − close | 285 | +0.388 | [+0.076, +0.690] | — | — |
| Live 2026 (wk 1–6) | v2 − v1 trained | 93 | -0.176 | [-0.716, +0.381] | -0.0046 | [-0.0428, +0.0321] |
| Live 2026 (wk 1–6) | v2 − v1 shipped | 93 | -0.153 | [-0.722, +0.437] | -0.0357 | [-0.0806, +0.0065] |
| Live 2026 (wk 1–6) | v2 − close | 93 | +0.244 | [-0.308, +0.786] | — | — |
| Full backtest 2011–2025 | v2 − v1 trained | 4096 | -0.135 | [-0.217, -0.050] | -0.0094 | [-0.0145, -0.0044] |
| Full backtest 2011–2025 | v2 − v1 shipped | 4096 | -0.335 | [-0.450, -0.220] | -0.0247 | [-0.0316, -0.0185] |
| Full backtest 2011–2025 | v2 − close | 4096 | +0.203 | [+0.122, +0.279] | — | — |
| Live 2026 (wk 1–6) | v2 − v1 as published | 77 | -0.083 | [-0.742, +0.600] | -0.0050 | [-0.0518, +0.0394] |

## Incremental-value bar: each component removed, scored on VALIDATION (2020–2024) only

A component stays active only if removing it makes validation margin MAE or log loss worse. The holdout was not consulted.

| Component | Validation MAE without it (with: base) | Δ MAE if removed | Δ log loss if removed | Paired Δ\|err\| 95% CI | Status |
|---|---|---|---|---|---|
| garbage_time_filter | 10.0668 (10.0635) | +0.0033 | +0.00134 | [-0.043, +0.035] | active (adds value) |
| in_season_recency | 10.0631 (10.0635) | -0.0004 | +0.00026 | [-0.017, +0.018] | active (adds value) |
| qb_layer | 10.1097 (10.0635) | +0.0462 | +0.00563 | [-0.114, +0.020] | active (adds value) |
| market_rating | 10.2234 (10.0635) | +0.1599 | +0.00735 | [-0.263, -0.059] | active (adds value) |
| last_season_carryover | 10.1003 (10.0635) | +0.0368 | +0.00435 | [-0.096, +0.022] | active (adds value) |
| personnel_skill_moves | — | — | — | — | inactive (tuned off) |
| ol_continuity | 10.0638 (10.0635) | +0.0003 | -0.00001 | [-0.002, +0.001] | active (adds value) |
| offense_defense_split | 10.0572 (10.0635) | -0.0063 | -0.00030 | [-0.008, +0.019] | INACTIVE (no incremental value on validation) |
| rest_bye_short | 10.0612 (10.0635) | -0.0023 | +0.00034 | [-0.017, +0.021] | active (adds value) |
| travel_timezone | 10.0726 (10.0635) | +0.0091 | +0.00027 | [-0.035, +0.015] | active (adds value) |
| division | 10.0576 (10.0635) | -0.0059 | -0.00021 | [-0.015, +0.027] | INACTIVE (no incremental value on validation) |
| hfa_shrinkage | — | — | — | — | inactive (tuned off) |
| era_weighting | 10.0850 (10.0635) | +0.0215 | +0.00044 | [-0.045, +0.001] | active (adds value) |

## Calibration of the win probability

### Holdout 2025

| Predicted bin | n | Mean predicted | Observed |
|---|---|---|---|
| 0.2-0.3 | 22 | 0.253 | 0.318 |
| 0.3-0.4 | 39 | 0.358 | 0.308 |
| 0.4-0.5 | 46 | 0.454 | 0.370 |
| 0.5-0.6 | 65 | 0.545 | 0.585 |
| 0.6-0.7 | 58 | 0.657 | 0.638 |
| 0.7-0.8 | 34 | 0.752 | 0.735 |
| 0.8-0.9 | 19 | 0.843 | 0.789 |
| 0.9-1.0 | 1 | 0.906 | 1.000 |

Expected calibration error: **0.0445**

### Full backtest 2011–2025

| Predicted bin | n | Mean predicted | Observed |
|---|---|---|---|
| 0.0-0.1 | 1 | 0.089 | 0.000 |
| 0.1-0.2 | 43 | 0.169 | 0.186 |
| 0.2-0.3 | 183 | 0.258 | 0.279 |
| 0.3-0.4 | 421 | 0.353 | 0.294 |
| 0.4-0.5 | 754 | 0.453 | 0.428 |
| 0.5-0.6 | 934 | 0.551 | 0.549 |
| 0.6-0.7 | 907 | 0.646 | 0.647 |
| 0.7-0.8 | 580 | 0.746 | 0.765 |
| 0.8-0.9 | 246 | 0.839 | 0.866 |
| 0.9-1.0 | 14 | 0.917 | 0.929 |

Expected calibration error: **0.0168**

The same projections priced from a plain normal instead of the key-number distribution: full-backtest log loss 0.62202 vs 0.62222 (key-number).

## Against the closing line, side by side (full backtest 2011–2025)

Taking v2's side whenever it disagrees with the close by at least the threshold:

| Gap vs close ≥ | n | Model side wins | Win % | One-sided p |
|---|---|---|---|---|
| 1 pt | 2815 | 1450 | 51.5% | 0.0567 |
| 2 pt | 1778 | 916 | 51.5% | 0.1044 |
| 3 pt | 980 | 525 | 53.6% | 0.0137 |

The same for v1 as trained:

| Gap vs close ≥ | n | Model side wins | Win % | One-sided p |
|---|---|---|---|---|
| 1 pt | 2896 | 1449 | 50.0% | 0.4926 |
| 2 pt | 1935 | 963 | 49.8% | 0.5899 |
| 3 pt | 1264 | 641 | 50.7% | 0.3163 |

## CLV, 2026 only (EdgeDesk's own opener capture began 2026-09-16; no historical openers exist)

- **v2**: n 102, mean +0.42 pts toward the model's side, 41 positive / 21 negative / 40 flat
- **v1_published**: n 98, mean +0.51 pts toward the model's side, 43 positive / 19 negative / 36 flat
- **v1_trained**: n 77, mean +0.68 pts toward the model's side, 37 positive / 14 negative / 26 flat

## How fast last season fades (v2, 2011–2025)

| Week | Share of base strength from the prior |
|---|---|
| 1 | 100% |
| 2 | 52% |
| 3 | 43% |
| 4 | 36% |
| 6 | 31% |
| 8 | 27% |
| 10 | 28% |
| 12 | 28% |
| 14 | 24% |
| 17 | 26% |

## Fitted coefficients by season priced (walk-forward: each fitted only on earlier seasons)

| Season priced | Home field | Pass O | QB | Pass D | Rush O | Rush D | Market rating | Rest (per 7 days) |
|---|---|---|---|---|---|---|---|---|
| 2009 | 2.74 | 22.6 | 13.6 | 22.6 | 41.9 | 41.9 | 0.620 | 6.17 |
| 2010 | 2.63 | 21.6 | 13.3 | 21.6 | 32.6 | 32.6 | 0.701 | 4.45 |
| 2011 | 2.34 | 18.3 | 14.7 | 18.3 | 25.9 | 25.9 | 0.703 | 4.70 |
| 2012 | 2.64 | 16.5 | 16.0 | 16.5 | 28.9 | 28.9 | 0.668 | 3.27 |
| 2013 | 2.56 | 11.5 | 14.3 | 11.5 | 21.7 | 21.7 | 0.853 | 2.02 |
| 2014 | 2.65 | 10.2 | 15.2 | 10.2 | 16.7 | 16.7 | 0.899 | 1.35 |
| 2015 | 2.64 | 6.6 | 14.3 | 6.6 | 13.9 | 13.9 | 0.982 | 0.00 |
| 2016 | 2.49 | 12.7 | 15.0 | 12.7 | 17.5 | 17.5 | 0.878 | 1.02 |
| 2017 | 2.58 | 10.6 | 16.5 | 10.6 | 13.9 | 13.9 | 0.901 | 1.61 |
| 2018 | 2.57 | 15.6 | 16.6 | 15.6 | 10.4 | 10.4 | 0.827 | 1.29 |
| 2019 | 2.50 | 11.4 | 15.6 | 11.4 | 11.8 | 11.8 | 0.894 | 0.60 |
| 2020 | 2.13 | 10.5 | 15.3 | 10.5 | 16.0 | 16.0 | 0.888 | 1.06 |
| 2021 | 2.13 | 8.5 | 15.0 | 8.5 | 18.4 | 18.4 | 0.899 | 1.55 |
| 2022 | 2.06 | 5.9 | 13.5 | 5.9 | 21.1 | 21.1 | 0.951 | 1.50 |
| 2023 | 2.07 | 6.4 | 13.3 | 6.4 | 18.0 | 18.0 | 0.901 | 1.67 |
| 2024 | 2.17 | 6.5 | 13.3 | 6.5 | 17.5 | 17.5 | 0.875 | 1.78 |
| 2025 | 2.13 | 5.9 | 14.9 | 5.9 | 24.7 | 24.7 | 0.813 | 1.71 |
| 2026 | 2.15 | 8.4 | 14.9 | 8.4 | 22.2 | 22.2 | 0.800 | 1.80 |

Points per unit: rating terms are points per 1.0 EPA/play of rating difference (offense and defense share one coefficient: the validation bar rejected separate ones); the market rating is points per point of prior-close rating. Home field for 2026 is fitted from recent seasons (half-life 6.0 seasons); the extra pull toward the long-run value was tuned off (it did not help on 2011-2019).

## Configuration

Tuned on 2011–2019 only, by two-pass coordinate descent over the preregistered grid. **80 variants evaluated, 16 accepted**; every one is in `docs/model-loop/nfl/tuning_log.jsonl` with its tune-window MAE.

```json
{
 "rating": {
  "garbage_floor": 0.25,
  "hl_week": 12,
  "lam": {
   "pass_off": 600,
   "pass_def": 300,
   "rush_off": 600,
   "rush_def": 300,
   "qb": 100,
   "mu": 100.0,
   "home": 3000.0
  },
  "carry": {
   "off": 0.8,
   "def": 0.4,
   "qb": 1.0,
   "qb_gap": 0.8
  },
  "qb_layer": true,
  "personnel": {
   "skill": 0.0,
   "skill_shrink": 50.0,
   "ol": 0.05
  },
  "market": {
   "on": true,
   "hl_week": 2,
   "lam": 1,
   "carry": 0.4,
   "lam_hfa": 20.0
  },
  "totals_market": {
   "on": true,
   "hl_week": 4.0,
   "lam": 3.0,
   "carry": 0.6
  }
 },
 "model": {
  "components": {
   "qb": true,
   "market": true,
   "rest": true,
   "travel": true,
   "division": false,
   "covid": true,
   "pass_split": false,
   "rush": true
  },
  "hl_season": 6.0,
  "ridge_lam": 8,
  "hfa_prior_games": 0,
  "first_train": 2007,
  "min_train_seasons": 2,
  "calibration": "none",
  "total_market": true
 }
}
```

## Current cards (research candidate; not on the published board)

**KC @ SEA** (week 7): fair line **SEA +0.3**, win probability 49.0%, fair moneyline +104 / -104, 80% range -17.1 to +16.5 (centred on -0.32). Starters: Sam Darnold (reconciled starter (DEPTH_CHART_RECONCILED)) vs Patrick Mahomes (reconciled starter (SCHEDULE_FEED)).

| Group | Component | Points (home +) | From the prior | From 2026 |
|---|---|---|---|---|
| environment | Home field | +2.15 | — | — |
| base strength | Pass offense (team, excluding QB) | +0.20 | +0.30 | -0.10 |
| base strength | Quarterback | -3.55 | -0.73 | -2.82 |
| base strength | Pass defense | +0.80 | +0.31 | +0.50 |
| base strength | Rush offense | -1.68 | -0.10 | -1.59 |
| base strength | Rush defense | +0.87 | +0.31 | +0.56 |
| base strength | Market rating (prior weeks' closing lines) | +0.68 | +0.57 | +0.11 |
| rest travel | Rest days | +0.77 | — | — |
| rest travel | Travel distance | +0.31 | — | — |
| rest travel | Time zones crossed | -0.81 | — | — |
| rest travel | Early body-clock kickoff | -0.05 | — | — |
| | **Sum = fair margin** | **-0.32** | | |

Unattributed: -0.0e+00. Market reference: -2.5.

**WATCH: Model disagrees with market by 2.8** (toward the away side). Driving components: Quarterback -3.55; Rush offense -1.68; Time zones crossed -0.81.

| Game | v2 fair line | Market reference | Gap | Flag |
|---|---|---|---|---|
| CIN @ BAL | BAL +0.1 | BAL -3.0 | -3.1 | QB UNRESOLVED |
| CLE @ TEN | TEN +2.8 | TEN +1.5 | -1.3 |  |
| DAL @ PHI | PHI +2.1 | PHI +4.5 | +2.4 | WATCH |
| DEN @ ARI | ARI +3.6 | ARI +4.5 | +0.9 |  |
| GB @ DET | DET -5.8 | DET -3.0 | +2.8 | WATCH |
| IND @ MIN | MIN -5.7 | MIN -6.5 | -0.8 |  |
| KC @ SEA | SEA +0.3 | SEA -2.5 | -2.8 | WATCH |
| LA @ LV | LV +5.9 | LV +4.5 | -1.4 |  |
| MIA @ NYJ | NYJ -3.8 | NYJ -4.5 | -0.7 |  |
| NE @ CHI | CHI -1.9 | CHI -3.0 | -1.1 |  |
| NYG @ HOU | HOU -10.2 | HOU -10.0 | +0.2 |  |
| PIT @ NO | NO +1.6 | NO +3.5 | +1.9 |  |
| SF @ ATL | ATL +4.2 | ATL +3.0 | -1.2 |  |
| TB @ CAR | CAR -7.6 | CAR -3.5 | +4.1 | QB UNRESOLVED |
| ARI @ DAL | DAL -7.3 | DAL -6.5 | +0.8 |  |
| ATL @ TB | TB -0.7 | TB -1.5 | -0.8 |  |
| BAL @ BUF | BUF -4.3 | BUF -2.5 | +1.8 |  |
| CAR @ GB | GB -2.6 | — | — |  |
| CLE @ PIT | PIT -5.3 | PIT -4.5 | +0.8 |  |
| IND @ JAX | JAX -11.0 | JAX -7.5 | +3.5 | FLAG |
| KC @ DEN | DEN +2.4 | DEN +1.5 | -0.9 |  |
| LAC @ LA | LA -11.1 | LA -7.5 | +3.6 | FLAG |
| LV @ NYJ | NYJ -0.6 | NYJ -1.5 | -0.9 |  |
| MIN @ DET | DET -4.0 | — | — |  |
| NE @ MIA | MIA +6.3 | MIA +8.5 | +2.2 | WATCH |
| PHI @ WAS | WAS -4.5 | WAS -3.5 | +1.0 |  |
| TEN @ CIN | CIN -13.2 | CIN -10.5 | +2.7 | WATCH |

## Data the model could not use

- preseason win totals (not owned)
- historical openers (EdgeDesk capture starts 2026-09-16)
- book-level closes before 2026
- OL grades / tracking data (not owned)

## Disclosures

- During development a single smoke test of the UNTUNED default configuration was scored on every window including the 2025 holdout (v2 MAE 10.18 vs v1-trained 10.17, log loss 0.644 vs 0.636). No setting was changed in response to the holdout; the grid above was fixed before it.
- no intercept (neutral = 0); offense and defense separate coefficients; QB as its own rating parameter; travel rows centred on a typical trip so home field means home field with a typical trip; per-week snapshots (a Thursday game is not absorbed before that week's Sunday games).
- Two components (separate offense/defense coefficients, the division term) were removed by the validation bar, so the final model's VALIDATION numbers are mildly optimistic; the holdout and 2026 numbers are not affected.
- Tuned values at the edge of the preregistered grid (QB carry 1.0, QB prior strength 100, market half-life 2 weeks and prior strength 1, defensive prior strength 300, ridge 8) are listed in the tuning log; a wider grid is a Phase 2 candidate, not a change made here.
- The ATS-vs-close tables are descriptive: they were not a preregistered test, several thresholds are shown, and no betting claim follows from them.
- Starters in the backtest are the quarterbacks who actually started (known pregame in nearly every case); live cards use the reconciled starter.

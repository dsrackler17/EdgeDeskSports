# CFB decision policy — pre-registration (`cfb_decision_policy_v1`)

Written before `v2/decision/tournament.py` read a single outcome for a threshold, gate or policy. Its sha256 is
recorded by the tournament's outputs, the policy manifest and the holdout access log; any later change to this file is
an amendment and is listed at the end with its own hash. The calibration artifact (`cfb_decision_calibration_v1`) is
frozen and is not refit.

**What was already seen (disclosure).** The author had read CALIBRATION.md before writing this: it reports DEV
walk-forward outcomes by pure-probability bucket, decision-probability bucket, gap bucket, EV bucket, bet-confidence
decile and for the single split "probability edge > 0" (n 592, cover 53.0% [48.9, 57.0], ROI +0.012 [−0.062, 0.088],
CLV 0.76). Those tables were not selected over; no threshold grid below was tuned against them. The grids were set
after looking at how many DEV rows each threshold keeps (inputs only, no outcomes): probability edge ≥ 0 keeps 592
scored rows, ≥ 0.01 keeps 248, ≥ 0.02 keeps 99, ≥ 0.03 keeps 31. **The holdout (2024, 2025) has never been read.**

## 1. Data and windows

- **Universe.** The calibration study's walk-forward frame (`out_h/decision/decision_dev_walkforward.parquet`): FBS vs
  FBS consensus openers, final, with a pure cover probability, not routed to REVIEW; the walk-forward decision
  probability `p_dec` exists for the scored seasons 2018, 2019, 2021, 2022 and 2023 (3,633 rows). Extra columns are
  joined from the decision dataset through a `window == dev` row filter. Every historical price is the labelled
  ASSUMED −110. 2020 has no openers and no decision rows (reported separately by the calibration study).
- **Walk-forward policy folds.** Evaluation seasons E = {2019, 2021, 2022, 2023}. The fold for season S chooses every
  threshold on scored seasons < S and is evaluated on S. 2018 only trains. Pooled out-of-sample (OOS) = the union of
  the four evaluated seasons.
- **Final DEV choice.** The same rule applied to all scored DEV seasons (2018–2023) gives the frozen value.
- **Holdout.** 2024 and 2025 are read exactly once by `v2/decision/holdout.py`, after `policy.json` and its MANIFEST
  are written and hashed; the script logs the access and refuses to run twice for one policy hash.
- **Live 2026.** Inputs only (the price-target table and the shadow preview); nothing is fit on live rows.

## 2. Metrics (every betting metric is flat 1 unit per bet at the assumed −110)

- n; W-L-P; cover rate with a Wilson 95% interval; ROI (units per bet) and total units; CLV (side-oriented points,
  opener → close); positive-CLV rate (Wilson); share of moved lines that moved toward the model; mean probability
  edge; mean decision EV; mean decision probability; calibration error (mean p_dec − cover rate) and Brier; maximum
  drawdown (chronological).
- **Close-implied EV ("pricing quality").** The EV of the bet if the closing line is the market's fair number:
  with e = final margin − closing line over DEV FBS consensus rows 2016–2023 (seasons with a close), symmetrized
  (e and −e) and kept on the half-point grid, a bet with side-oriented CLV c has p_win = P(e > −c), p_loss = P(e < −c),
  p_push = P(e = −c) and close-implied EV = p_win · (100/110) − p_loss. It uses the outcome only through the close,
  so it has a small fraction of the variance of realized ROI. It is optimistic about fills (openers carry no
  timestamp).
- **Uncertainty.** Game-clustered percentile bootstrap, 2,000 resamples (1,000 for drawdowns and in-fold scores), seed
  20260927. Minimum samples: n < 100 sets nothing (INSUFFICIENT); 100–299 PROVISIONAL; ≥ 300 to act. Bucket tables
  carry empirical-Bayes shrunk values (the calibration study's `add_eb`).

## 3. The tournament (candidates are fixed here)

| id | rule | grid |
|---|---|---|
| `baseline_001` | the frozen V2.1 `engine.decide()` BET-qualifying rule: baseline EV > 0.06 and \|gap\| ≥ 3 and not early season (walk-forward stage-7 EV) | none (fixed; its thresholds were selected in-sample on DEV by V2.1) |
| `baseline_lean` | the baseline's LEAN set: baseline EV > 0 | none |
| `edge` | probability edge ≥ t | t ∈ {0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05} |
| `decision_ev` | decision EV ≥ t | t ∈ {0, 0.01, 0.02, 0.03, 0.04, 0.05} |
| `empirical_ev` | the walk-forward decision-EV curve's value ≥ 0 (what decision.js reads) | none (2019+: 2018 has no walk-forward decision curve) |
| `multivariate` | `edge` at its fold choice AND forward-selected gates from: not early season; ens_sd < 1.649 (the calibration study's DEV tercile edge); reliability ≥ 40; no QB flag (qb_missing = qb_unsettled = 0); gap < 10 | a gate is added only if it raises the in-fold score by more than one bootstrap SE of the paired score difference; at most 2 gates |
| `clv_model` | probability edge > 0 AND the frozen walk-forward P(positive CLV) ≥ t (the §18 interpretable decision model) | t ∈ {0.50, 0.55, 0.58, 0.60, 0.65} |
| `gap` | \|gap\| ≥ t (the naive rule, for contrast) | t ∈ {2, 3, 4, 5, 6, 7} |
| `none` | no bets | — |

**§18 decision-model challenger.** A ridge logistic model of positive CLV on gap, pure probability, reliability,
ens_sd, early season, qb_missing, qb_unsettled, |line|, home side and week, fit walk-forward (seasons < S, the ridge
strength fixed at 100 on standardized inputs), is compared with the frozen `p_positive_clv` on the scored seasons by
AUC and log loss (paired game bootstrap). It replaces the frozen model in `clv_model` only if its AUC gain has a 95%
interval above 0 AND its log loss is not worse; otherwise it is reported and dropped.

**In-fold selection rule (every tunable candidate).** For each grid value with at least 100 selected training rows,
score = the lower bound of the 90% bootstrap interval of the mean close-implied EV of the selected training rows.
Best = the highest score; SE = the bootstrap SD of the best value's mean. Plateau = the longest contiguous run of
eligible grid values containing the best whose scores are ≥ best − SE. The choice is the plateau's middle value (the
more selective of the two middles when the run is even) — a conservative point inside a stable region, never the
single maximum. No eligible value: the fold places no bets.

## 4. What earns BET status (BET-VALID, pooled OOS; all required)

1. **Sample:** n ≥ 300 OOS bets, placed in at least 3 of the 4 evaluated seasons.
2. **Pricing:** close-implied EV 95% lower bound > 0.
3. **CLV:** mean CLV 95% lower bound > 0 and positive-CLV rate Wilson lower bound > 50%.
4. **Outcome:** realized flat ROI 95% lower bound > 0 (a statistically credible advantage at −110).
5. **Calibration:** the Wilson 95% interval of the cover rate contains the mean decision probability.
6. **Stability:** mean CLV > 0 in every evaluated season with ≥ 20 bets; the fold choice is within one grid step of
   the final DEV choice in ≥ 3 of 4 folds; each neighbouring grid value (± one step, evaluated through the same folds
   at that fixed value) keeps the sign of the close-implied EV and an ROI within 0.05 of the choice (no collapse).
7. **Paired vs baseline_001** on the same quotes (units per universe quote, paired game bootstrap): the 95% interval of
   the difference is not entirely below 0, and the candidate's mean CLV per bet is at least the baseline's.
8. **Risk:** 95th percentile simulated season drawdown ≤ 25 u and risk of ruin (a 50 u loss from 100 u within 3
   seasons) ≤ 1% at the 2.5th percentile of the posterior cover rate (§7).

Criteria 1, 2, 3 and 5 without 4 is **PRICING-ONLY**: evidence of beating the opener, not of winning at −110; it
supports LEAN, never BET.

## 5. The production policy (`policy.json`) is derived by these rules

- `bet_enabled: false`, always, in the committed artifact. Turning betting on is a person's decision through the §86
  gate (§8); a policy that fails the gate stays disabled.
- `min_ev = 0.0` on the **empirical (curve-mapped) EV** decision.js reads: a BET needs a non-negative expected
  realized value after calibration. It is a declared floor, not searched. (A decision-EV threshold cannot be carried
  through the frozen curve: the curve is flat at −0.0317, so any decision-EV threshold maps to the same value.) Under
  the frozen artifact this makes the BET region empty at every price — the calibration evidence, stated plainly.
- `min_probability_edge` = the `edge` candidate's final DEV choice; if no grid value is eligible, 0.03.
- `ideal_probability_edge` = 2 × `min_probability_edge`.
- **LEAN:** `lean.min_probability_edge = 0` (a positive calibrated edge over break-even at the price) and
  `lean.min_gap_pts` = the smallest g ∈ {0.5, 1.0, 1.5, 2.0} whose scored-DEV rows with |gap| in [g, g + 1) have a mean
  CLV 95% lower bound > 0 (the gap at which the line demonstrably moves toward the model); 2.0 if none. LEAN is
  validated if the LEAN rows of the production replay have CLV 95% lower bound > 0 AND CLV above the PASS rows' with
  a 95% interval of the difference above 0.
- **RESEARCH** keeps decision.js's definition (QB unresolved, immature market, incomplete inputs, extreme edge); the
  study reports whether QB-flagged edges differ from unflagged ones in CLV and calibration.
- `hysteresis.edge_buffer = hysteresis.ev_buffer` = half the median absolute open → close change of the probability
  edge among `edge`-region rows, rounded to 0.0005 and capped at 0.005 (a noise-scale buffer: a real line move of a
  point or more always re-decides).
- `wait.enabled` is true only if, among `edge`-region rows whose frozen expected CLV is negative (the only rows
  decision.js would ever consider WAIT), n ≥ 100 and the realized CLV 95% upper bound is below −0.25 points (the line
  demonstrably moved toward our side). Otherwise false.
- **Stake:** `method: flat`, 1 u, `max_stake_u` 1. `kelly_validated` is true only if the decision probability's
  walk-forward log loss beats a coin flip with a 95% interval entirely below 0 AND the `edge` region is BET-VALID.
  `kelly_fraction` 0.10 (the challenger's size), `bankroll_u` 100, `saturation_probability` = the upper edge of the
  highest decision-probability bucket (0.525, 0.55, 0.575, 0.60) with at least 300 scored DEV rows.
- **Exposure:** `max_game_u` 1 and `same_game_correlation` 1.0 — every same-game position decision.js can create is
  a spread, and the same side at two books is the same bet; the estimated correlations of other bet types are
  recorded for when they are decided. `max_slate_u` = the largest value in {3, 5, 8, 10, 15} whose simulated 95th
  percentile season drawdown is ≤ 25 u and risk of ruin ≤ 1% (§7) for the `edge` candidate's OOS weekly bet counts
  (the LEAN set when `edge` places < 100 OOS bets); `max_cluster_u` = half of it (rounded down), or a third if the
  within-conference-week correlation's 95% upper bound exceeds 0.05.
- Declared, not fitted (no historical point-in-time data): `stale_minutes` 180, `min_books` 3, `max_dispersion_iqr`
  1.5, `max_price` −125, `reference_price` −110, extreme-edge checks (gap 10, EV 0.12, quote under 60 min, cover
  probability 0.60), orientation guard (21 / 7). `min_football_confidence` 40 and `max_ensemble_sd` 6 are kept as
  declared safety bounds unless `multivariate` adopts the reliability or disagreement gate on the final DEV fit;
  `min_bet_confidence` is null unless `clv_model` is BET-VALID.
- **Display flags.** `display.edge_quality_tiers` is true only if the bet-confidence labels decision.js shows (HIGH ≥
  0.58, MEDIUM ≥ 0.52, LOW) have strictly increasing mean CLV and positive-CLV rate on the scored DEV rows and
  HIGH − LOW CLV has a 95% interval above 0. `display.bet_rankings` is true only if, within weeks, the ranking key
  decision.js uses (the calibrated EV) orders realized CLV with a mean within-week Kendall τ whose 95% interval is
  above 0 (a constant key — a flat EV curve — cannot).

## 6. Analyses reported (not selected over)

PASS quality by status and reason (production replay, plus a counterfactual replay with betting enabled and the
decision EV unmapped, to see every gate); LEAN and RESEARCH evidence; the selectivity curve (top 1–100% by probability
edge, P(positive CLV) and expected CLV); rank order and monotonicity (deciles, Spearman, slope CIs); threshold
robustness (each candidate at every grid value, OOS); decision stability open → close and the hysteresis evidence;
bet now vs wait, decision regret and edge disappearance (opener → close only: the archive has no intermediate lines and
openers have no timestamp); edge-saturation (outcomes by decision-probability bucket); expected vs realized units;
flat vs 0.10 / 0.25 Kelly with caps 0.5 / 1 / 1.5 u; weekly counts (no quota); the decision-quality scorecard (§73)
for every candidate.

## 7. Correlation, portfolio and risk of ruin

- Same-game correlations on DEV FBS finals (phi coefficients of the outcome indicators, game bootstrap CIs):
  spread vs total (side cover vs over, by favourite/underdog and line size), spread vs moneyline (same team), same-team
  alternate spreads (±3, ±7 points), and team totals with synthetic lines (total/2 ± spread/2; the archive has no
  team-total lines). Cross-game: the intraclass correlation of model-side ATS results within a week and within a
  conference-week. Anything without data is listed as not estimable.
- Portfolio simulation: seasons of 15 weeks resampled (week blocks) from a candidate's OOS weeks; season units, SD,
  5th percentile, maximum drawdown distribution, worst week; historical longest losing streak and time to recovery.
- Risk of ruin: Monte Carlo seasons with the cover rate drawn from the Beta posterior of the set's OOS record (and at
  its 2.5th/50th/97.5th percentiles), weekly bet counts resampled from OOS weeks, within-week correlation through a
  Gaussian copula at the ICC's 95% upper bound, flat 1 u; ruin = a 50% loss of the bankroll (25, 50, 100 u) within 3
  seasons; 20,000 paths, Monte Carlo SE reported.

## 8. The promotion gate (§86): PASS/FAIL per criterion; betting stays disabled unless every one passes

G1 probabilities calibrated (DEV decision buckets with ≥ 100 rows contain their mean probability; holdout
calibration-in-the-large inside the Wilson interval) · G2 tiers rank sensibly (the §5 tier rule on DEV, and HIGH ≥
LOW CLV on the holdout) · G3 CLV strong for the production BET region (DEV OOS and holdout CLV 95% lower bound > 0) ·
G4 thresholds stable (§4.6) · G5 drawdown acceptable (§4.8) · G6 holdout does not collapse (holdout close-implied EV
and ROI of the BET region not below the DEV OOS 95% lower bounds) · G7 shadow sensible (≥ 200 settled live priced
shadow decisions; no fail-closed computation errors on valid inputs; live BET/LEAN share inside the DEV range) · G8
the frozen artifact admits a BET (the decision EV curve reaches `min_ev`) · G9 credible outcome (§4.4 on DEV OOS and
holdout ROI ≥ 0). An empty production BET region fails G3, G6 and G9 by definition.

## 9. The holdout (run once, after the freeze)

Applies the frozen calibration artifact (w = 0.227829; no refit) and the frozen policy to the 2024 and 2025 consensus
openers (and, as a sensitivity, every book's opener, game-clustered): production replay statuses, every candidate at
its frozen final DEV threshold, baseline_001 (stage-7 walk-forward), scorecards, calibration, CLV, close-implied EV,
the paired comparison, tiers and the §86 gate. Reported as it comes out; no re-tuning afterwards.

## Amendments

1. **2026-09-27, after the first DEV run and before the freeze; no rule, grid, criterion or holdout read changed.**
   Original text sha256 `ca45a7ee78912b06767df289226a4895fa5f0c81427c6b0c9924fba3016ba16d`.
   - *Engine bug (decision.js), found by the production replay:* a quote that did not clear the thresholds was labelled
     RESEARCH when its **pure** probability edge cleared `min_probability_edge`. The pure probability is the
     overconfident one, so 31% of DEV quotes became RESEARCH with CLV (0.40) barely above PASS (0.28). decision.js now
     asks for the same decision-probability edge LEAN needs (edge > `lean.min_probability_edge` and |gap| ≥
     `lean.min_gap_pts`); "RESEARCH keeps decision.js's definition" (§5) refers to the fixed definition.
   - *Study-code bug (tournament.py):* the two baseline candidates were graded on the pure model's side; they are now
     graded on the side the baseline actually took (it differs on some rows).

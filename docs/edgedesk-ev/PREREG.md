# EdgeDesk EV — pre-registration (calibration tournament and EV decision policy v1)

Written before `football/cfb_ev/tournament.js` was run for the first time. The
thresholds below were not chosen from the tournament's results. If a rule is
changed after the first run, the change goes in the "Post-registration
changes" section at the end, with its reason.

## 1. What is calibrated

- **The input is the champion's raw probability.** For spreads, it is
  `P(home covers | no push)` at the market line, produced by the production
  path (`build.js v1Dist → EDRead.buildCurve → sideProb`). For moneylines, it
  is the champion's `home_win_prob`.
- **The target is the outcome.** For spreads, 1 means the home side covered
  and 0 means it did not; pushes are excluded from the fit and calibrated
  separately (§6). For moneylines, the target is a home win.
- **Orientation is home.** The away side's calibrated probability is the
  complement. An intercept can therefore learn a home-field bias.
- **Markets never enter.** Every candidate maps the raw football probability
  alone. A market-aware blend is not a candidate; the de-vigged market is
  reported beside the tournament as a benchmark only.

## 2. Data windows

| Window | Seasons | Use |
|---|---|---|
| IN_SAMPLE | 2015–2021 | The champion's PMF (2006–2021) and tuning layers saw these seasons. Diagnostics only. |
| OOS | 2022–2025 | Walk-forward folds: train on the OOS seasons before the evaluated one. |
| HOLDOUT_2026 | 2026 weeks graded | The published record. Read once, after the promotion decision is frozen. |

- **The folds are:**
  - fit on 2022, evaluate 2023;
  - fit on 2022–2023, evaluate 2024;
  - fit on 2022–2024, evaluate 2025.
- **Pooled OOF** is the concatenation of the three evaluation folds.
- **No calibrator is ever evaluated on data it was fitted on.**

## 3. Candidates

These run in simplicity order, and simple wins ties:

1. `identity`: no calibration.
2. `temperature`: σ(logit p / T).
3. `platt`: σ(a + b·logit p).
4. `beta`: σ(c + a·ln p − b·ln(1−p)), with a, b ≥ 0 (Kull et al.).
5. `rolling_platt`: Platt fitted on the most recent training season only. This is a drift challenger.
6. `isotonic`: PAV, interpolated linearly between block centres.
7. `venn_abers`: inductive Venn-Abers, using the merged probability p1/(1−p0+p1).

Hierarchical and conditional calibrators (by conference, favourite or
underdog, edge size) are not candidates in v1. At about 800 games a season,
they cannot be fitted without the small-group failure the pack warns about.
Their subgroup reliability is reported as diagnostics only.

## 4. Metrics (every candidate, every fold, pooled)

- **Scores:** Brier and log loss.
- **Calibration:** the slope (logistic y ~ a + b·logit p) and the calibration-in-the-large intercept (y ~ a + offset(logit p)), each with a 95% Wald CI.
- **ECE:** 10 equal-mass bins. The caveat is printed: it is binning-dependent and biased upward at small N.
- **Reliability curve:** 10 bins, each with n, the mean predicted value, the observed rate and a Wilson 95% CI.
- **Brier decomposition:** reliability, resolution and uncertainty (Murphy, 10 bins).
- **AUC.**
- **Sample size.**
- **Stability:**
  - by season;
  - by week bucket (1–3, 4–8, 9+);
  - by |model − market| gap bucket (< 2, 2–5, 5–10, 10+);
  - favourite flip;
  - home favourite vs home underdog.

## 5. Promotion rule (spread close, spread open and moneyline each separately)

A non-identity candidate is **eligible** only if all three hold:

1. Its pooled OOF log loss **and** Brier are both below identity's.
2. The 95% week-clustered bootstrap CI of Δ log loss (candidate − identity; 2,000 resamples, seed 20260928) lies entirely below 0.
3. Its log loss is no worse than identity's in at least 2 of the 3 OOF seasons.

Choosing among eligible candidates:

- Take the eligible candidate with the lowest pooled log loss.
- **Promote the simplest eligible candidate** whose Δ log loss against that best candidate is within one bootstrap SD.
- If none is eligible, **identity is retained**. It is then `IDENTITY_VALIDATED` only if:
  - its pooled OOF calibration slope 95% CI contains 1; and
  - its CITL 95% CI contains 0.
- Otherwise the market is `NOT_VALIDATED` and EV stays CALIBRATION PENDING.

**The final map** is refitted with the promoted method on all OOS seasons (2022–2025).

**Holdout (read once).** The 2026 holdout confirms or revokes the choice:

- A promoted calibrator is **revoked** if its holdout Δ log loss vs identity has a 95% bootstrap CI entirely above 0.
- Otherwise it is confirmed.
- The holdout never selects between candidates.

## 6. Push calibration and the distribution audit

- **Push calibration.** On integer lines, compare the mean predicted push probability with the observed push rate, overall and at 3, 7 and 10.
- **Distribution audit.** Compare the production PMF with a continuous-normal shortcut, N(fair, σ) discretised with a continuity correction:
  - the three-state (win/push/loss) log loss at integer lines;
  - the push log loss.
- **Key-number audit.** For |margin| = 1..21, compare the empirical FBS frequency (2022–2025) with the mean mass the production PMF assigned.

## 7. EV decision policy v1 (`football/cfb_ev/policy/cfb_ev_policy_v1.json`)

| Rule | Value | Provenance |
|---|---|---|
| probability edge | ≥ 0.01 | `cfb_decision_policy_v1.min_probability_edge` (DEV plateau) |
| calibrated EV | ≥ 0 | `cfb_decision_policy_v1.min_ev` |
| conservative EV | the 10th percentile of the EV samples, ≥ 0 | declared here, never tuned; equivalent to Pr(EV > 0) ≥ 0.90 |
| EV interval | 5th–95th percentile | declared here |
| samples | 500, seeded from the quote | declared here |
| quote TTL | main spread 180 min; alternate 90 min; moneyline 180 min; user quote 30 min; ≤ 6 h to kickoff: 60 min; an extreme EV needs ≤ 60 min | the policy's `stale_minutes` 180 and `extreme_max_age_minutes` 60; the rest declared here |
| extreme-EV review | raw probability edge or gap at or beyond the OOS 95th percentile; severe at the 99th | from the OOS data, stored in the artifact |
| juice verdict | BETTER or WORSE when paired Pr(ΔEV > 0) is ≥ 0.80 or ≤ 0.20 and \|ΔEV\| > 0.0005; otherwise TOO CLOSE | declared here |
| timing | move 0.5 pt; key numbers 3, 7, 10, 14; typical move from `movement_cfb.json` | existing EdgeDesk constants |
| maturity | SHADOW | a user-facing BET or BET EARLY is capped to RESEARCH ONLY until promotion |

Any threshold chosen from the tournament's own outcomes would be a violation of
this document. None is.

## Post-registration changes

Each change below was made after the first DEV run (walk-forward only; the
holdout was not yet read). None of them moved a threshold or changed a
candidate, a metric or the promotion rule.

1. **Where a map is evaluated: the market-line anchor.** The first DEV run
   showed the champion's raw cover probability at the market line carries no
   out-of-sample information: the identity slope is −0.13, 95% CI −0.29 to
   0.04. The promoted map therefore collapses it to 50%.
   - A map fitted at market lines is valid only there. Applied raw at an
     alternate line, it would call every line a coin flip.
   - The runtime therefore evaluates the map at the market line (the fresh
     consensus) only. It carries the result to every other line through the
     same frozen distribution, moved in location (a mixture of integer moves).
   - The tournament gained a check of exactly that transport at close ± 3 and
     ± 7 (`alternate_line_domain`).
   - The map's inputs are unchanged and football-only. The market line
     decides only where the map is evaluated.
2. **Anchored push and key-number audit.** The same audits (§6) were added for
   the anchored distribution. So was a key-number verdict in the artifact:
   when the observed push rate at integer market lines lies outside what the
   distribution predicts, key-number mass is NOT VALIDATED, and alternates
   that cross 3 or 7 are never actionable.

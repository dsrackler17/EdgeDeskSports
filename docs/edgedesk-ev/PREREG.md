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
     Change 4 replaced that move with a reweighting in place.
   - The tournament gained a check of exactly that transport at close ± 3 and
     ± 7 (`alternate_line_domain`).
   - The map's inputs are unchanged and football-only. The market line
     decides only where the map is evaluated.
2. **Anchored push and key-number audit.** The same audits (§6) were added for
   the anchored distribution. So was a key-number verdict in the artifact:
   when the observed push rate at integer market lines lies outside what the
   distribution predicts, key-number mass is NOT VALIDATED, and alternates
   that cross 3 or 7 are never actionable.
3. **The champion's distribution was corrected; the rows were re-derived (2026-10-04).**
   This change came after the holdout was read. It moved no threshold,
   candidate, metric, fold or promotion rule.
   - The champion re-centred its market-conditioned margin PMF by shifting it
     a whole number of points. That carried the table's "no ties" hole and its
     key-number spikes off their margins: on 2026-10-04 UConn @ Temple had no
     push at Temple −3 while a tie carried 6% of the mass.
     `football/cfb_p4/engine.js` now reweights the row in place (`cfbRecentre`).
   - The raw probabilities in the dataset therefore changed.
     `football/cfb_ev/dataset.js --rederive` recomputed `p_win`, `p_push`,
     `p_loss` and `p_cover` for every committed row from that row's own
     recorded inputs, through the production path. No row, fair margin, sigma,
     market or outcome moved, and no CFBD cache was needed.
   - Through the pre-change code the same inputs reproduce the committed
     probabilities to 1e-5 for the 27,795 rows inside the table. The 75 rows
     with a market past ±45 also take the edge-row read the production path
     has used since 2026-10-02.
   - The walk-forward tournament was re-run unchanged. It promotes the same
     methods: close temperature with T = 10⁶ (unchanged), open temperature
     with T 40.89 → 36.81, moneyline identity (unchanged).
   - The 2026 holdout was **not** re-read by the tournament. Its recorded
     verdict (close: CONFIRMED) is carried, as the tournament carries it on
     every rebuild. With T = 10⁶ the calibrated close probability is 0.5
     whatever the raw input. The verdict would turn only if the raw curve beat
     that coin flip on the holdout by a clear margin.
   - Disclosure: when the re-centring methods were compared, a diagnostic
     printed the raw cover log loss on every window, the holdout rows
     included. On the re-derived rows the holdout's is 0.7568 under the shift
     and 0.7522 under the reweighting, both well above the 0.6931 coin flip.
     The method was chosen on the 2015–2025 rows, where the reweighting
     scores better on every window:
     - OOS close: 0.7340 → 0.7313
     - OOS open: 0.7231 → 0.7203
     - OOS alternates (close ± 3, ± 7): 0.6830 → 0.6802
     - in-sample close: 0.7295 → 0.7267
     - in-sample open: 0.7209 → 0.7183
   - The artifact keeps its version (`cfb_ev_calibration_v1`). Its new hash is
     recorded as a PATCH in `football/cfb_ev/versions.jsonl`, so the
     prospective next-100 count continues. Bumping the version would have
     stopped that count, because it keys on the calibrator version.
4. **The anchor reweights the curve in place (2026-10-05).** This change
   came after the holdout was read. It moved no threshold, candidate,
   metric, fold, offset, band or promotion rule.
   - Change 1 carried the calibrated probability from the market line to
     every other line by moving the frozen curve's **location** (a mixture
     of the two neighbouring whole-point moves). After change 3 that move
     displaced the spikes the raw curve now keeps, and gave a tie mass. On the
     2023–2025 walk-forward folds:
     - the anchored push rate at integer market lines was 2.9% (raw 3.3%,
       observed 5.3%);
     - |margin| = 3 carried 4.1% of the anchored mass (raw 9.6%, games 10.5%);
     - a tie carried 2.0% (raw 0, games 0).
   - `lib/edgedesk_ev.js` now **reweights** the stored curve in place. It
     reads P(M = k) from the curve's push mass at every whole k and tilts it
     by exp(θ·k). θ is solved so that P(home covers the market line | no
     push) equals the calibrated probability. The champion uses the same tilt
     to re-centre its own row (`cfbRecentre`).
     - A margin with no mass keeps none, so a college curve never gives a tie
       mass, and the spikes stay on 3 and 7.
     - The robust EV's model-location noise moves the curve the same way.
     - Where the engine itself reweights (not past its reach), the anchored
       curve matches the engine re-run at the moved fair margin. The gap is
       0.03 pp at the median and 0.1 pp at the 95th percentile, at close ± 3
       and ± 7. The residual is the curve's tail mass, weighted at its ends.
   - The tournament was re-run, DEV only. The holdout was **not** re-read and
     its recorded verdict is carried. Every task, map, verdict and the
     calibrators are unchanged, because the tournament fits maps at the market
     line, where the anchor is exact by construction. Only the anchored audits
     moved (2023–2025 folds, n = 2,388 games, 933 at integer lines):

     | Anchored audit | Location move | Reweighting | Raw | Observed |
     |---|---|---|---|---|
     | push, all integer lines | 2.9% | 3.4% | 3.3% | 5.3% (95% 4.0–6.9%) |
     | push at a line of 3 | 3.2% | 6.4% | 6.1% | 9.6% (95% 5.9–15.2%) |
     | push at a line of 7 | 3.0% | 5.6% | 5.3% | 11.1% (95% 6.3–18.8%) |
     | mass on \|margin\| = 3 | 4.1% | 9.7% | 9.6% | 10.5% |
     | mass on \|margin\| = 7 | 3.8% | 8.1% | 8.0% | 8.7% |
     | mass on a tie | 2.0% | 0 | 0 | 0 |
     | three-state log loss, integer lines | 0.8715 | 0.8569 | 0.8976 | — |

   - The push rate still sits below its 95% interval, so key-number mass
     stays **NOT VALIDATED**. What remains is the PMF's own shortfall at the
     market's number, not the anchor's.
   - The alternate-line audit (`alternate_line_domain`), calibrated slope:

     | Offset | Location move | Reweighting (95% CI) |
     |---|---|---|
     | −7 | 0.4201 | 1.3689 (0.51 – 2.23) |
     | −3 | 0.7008 | 1.5095 (0.45 – 2.57) |
     | +3 | 0.0997 | 1.0279 (0.00 – 2.05) |
     | +7 | 0.3804 | 0.8116 (−0.02 – 1.65) |

     Log loss and Brier improve at every offset. All four slopes now sit
     inside the 0.6–1.6 band, so the validated tail domain goes from 0 to
     **±7**. That domain is read by the unchanged rule in
     `lib/edgedesk_quote_ev.js` `tailDomain`. Two cautions:
     - each interval is about ±1 wide, and the +3 and +7 intervals reach 0;
     - the +7 calibration-in-the-large interval (0.013 to 0.188) excludes 0:
       there the calibrated probability runs about 2 pp below the observed
       rate.
   - `lib/edgedesk_ev.js` keeps its version (`edgedesk_ev_engine_v1`). Its
     new hash, and the calibration artifact's (its key-number finding text
     changed), are recorded as a PATCH in `football/cfb_ev/versions.jsonl`.
     The next-100 population was already full (100 of 100 reads, 94 graded)
     and keys on the versions it was frozen with, so no frozen read moves.

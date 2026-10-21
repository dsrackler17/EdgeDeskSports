# Experiments — finding closing-line value at the early line

Every experiment is written here **before** it is run: hypothesis, the exact change,
and the pass threshold. The result is added afterwards, pass or fail, without editing
anything above the `Result` line. Data and its gaps: [DATA_AUDIT.md](DATA_AUDIT.md).
Code: `model_loop/clv_early/`. Raw scorecards: `docs/model-loop/clv_early/results/`.

## Protocol (fixed 2026-10-21, applies to every experiment)

**The metric.** Edge = the model identifies early prices that move toward its number by the
close. For each eligible game, `edge = model − early line` (line space: home expected margin;
total points). A bet is placed when `|edge| ≥ threshold`, on the side the edge points to.

* **Primary:** mean CLV in points of those bets, `side × (close − early line)`.
* Also: mean CLV in no-vig probability (key-number distribution; book prices where the data
  has them, −110/−110 where it does not), line-direction hit rate (share of moved lines that
  moved our way), CLV by edge bucket (0–1, 1–2, 2–3, 3+ over every game with a non-zero
  edge), per-season rows, the movement slope (OLS of `close − early` on `edge`), and
  diagnostics vs the result (ATS at the early line, MAE) that are **never** the headline.
* **Intervals:** 95% percentile bootstrap, 2,000 resamples of **season-weeks** (a week's lines
  move together). **Null:** within-week permutation of edges (same edge sizes and bet count per
  week), one-sided p.

**Lines.** NFL: early line at τ (last kickoff of week W−1 + 5 h; feed live within 6 h), close
= last value before kickoff, nflverse feed (`DATA_AUDIT.md` L2). CFB: the bet book's opener
(5Dimes 2012–2019, Bovada 2021–2025), CLV against the **same book's close** (primary) and the
across-book median close (secondary). Data-quality rule as in DATA_AUDIT §1c.

**Eligible games.** Both teams have completed at least one game this season (so a
previous-game starter and in-season ratings exist); an early line and a close exist after the
QA rule; CFB: at least one FBS side (every game in the archive).

**Inputs knowable at the early line only.** Ratings through week W−1, priced from the
week-start state. Quarterback = each team's **previous game's starter** (never the game-day
starter). Weather neutral (temp 68°F / wind 0 on non-dome games; roof is known). No injury
report at τ (Friday-checkpoint experiments only). Production models keep their production
training (coefficients fitted on earlier seasons with the inputs production trains on); only
the prediction-time inputs are restricted to what was knowable.

**Distributions for probability CLV** (a measuring instrument, fitted once, development data
only): NFL spreads — key-number table fitted on nflverse closes vs results 2006–2024; CFB
spreads — the same on the archive's consensus closes 2012–2024 (support ±100); totals — a
discretised normal with σ from close-vs-result 2006/2012–2024.

**Windows.** Development: NFL **2020–2024** (no early lines exist for 2015–2019), CFB
**2015–2019 and 2021–2024** (no openers in 2020; 2012–2014 usable as training history only).
**Holdout: 2025 and 2026-to-date, locked** — `model_loop/clv_early/run.py` refuses to score a season
≥ 2025 without `--unlock-holdout`, which is used exactly once, in Phase 6.

**Calling an edge (any single experiment, development data).** At its pre-registered primary
threshold: (1) the 95% interval of mean CLV (points) lies above 0, (2) the permutation p ≤ 0.05,
and (3) mean probability CLV > 0. Comparisons against the baseline are stated per experiment.

**Counting.** Every scored configuration (model × market × threshold × checkpoint) is a
variant and is tallied in the ledger at the bottom, failures included. The final verdict is
Bonferroni-penalised by the number of candidates taken to the holdout and states the total
number of variants tried on development data.

---

## Phase 3 — Baselines

### E-001 · NFL v2.1.0 (the board's model) at the early-week line — spreads

* **Hypothesis.** The production NFL model does not systematically find early lines that move
  toward it (it loses to the close on MAE: 10.30 vs 10.08 on 2010–2024).
* **Exact procedure.** `football/nfl_model.js` with `football/nfl_params_v2.js` `cfg`
  (v2.1.0, sha 6c79095675f8a223). Training exactly as `football/research/nfl_v2/backtest.js`:
  replay 1999→, features in kickoff order with the actual starters, ridge weights refitted on
  2002..S−1 for each season S. Prediction rows for season S: every week-W game priced from the
  state at the **start** of week W, with each team's previous-game starter, weather neutral.
  `model_loop/clv_early/js/replay_nfl_v21.js`.
* **Primary:** spreads, threshold **2.0** points, NFL 2020–2024. Sweep 1, 3, 4 (descriptive).
* **Pass (edge called):** protocol rule above.

### E-002 · NFL Loop v2.0.0 at the early-week line — spreads

* **Hypothesis.** As E-001.
* **Exact procedure.** `model_loop/adapters/nfl` with `docs/model-loop/nfl/versions.json`
  `current` (2.0.0) config. Two rating passes: as production (actual starters) for the training
  rows, and with `qb_overrides` = previous-game starters for the prediction rows; per season S
  the walk-forward fit uses production rows of seasons < S and predicts the override rows of S.
* **Primary:** spreads, threshold **2.0**, NFL 2020–2024. Sweep 1, 3, 4.
* **Pass:** protocol rule.

### E-003 · CFB V1 (cfb_p4 v1.0.1, the board's CFB engine) at the opener — spreads

* **Hypothesis.** No systematic CLV. Caveat stated in advance: its constants were trained on
  2001–2025, so any CLV is optimistic.
* **Exact procedure.** `football/cfb_p4/engine.js` replayed cold from 2006 as
  `model_loop/adapters/cfb/baselines/replay_cfb_p4.js` does, except every game of a
  (season, season type, week) is projected from the state at the start of that week
  (`model_loop/clv_early/js/replay_cfb_p4_weekstart.js`). The engine has no QB or weather input.
* **Primary:** spreads, threshold **3.0** points, CFB 2015–2019 + 2021–2024. Sweep 2, 4, 5, 6.
* **Pass:** protocol rule.

### E-004 · CFB Loop v2.0.0 at the opener — spreads

* **Hypothesis.** No systematic CLV.
* **Exact procedure.** `model_loop/adapters/cfb` with `docs/model-loop/cfb/versions.json`
  `current` (2.0.0) config; production rows for training, previous-game-starter rows for
  prediction, as E-002.
* **Primary:** spreads, threshold **3.0**, CFB 2015–2019 + 2021–2024. Sweep 2, 4, 5, 6.
* **Pass:** protocol rule.

### E-005 · Totals for the same four models (secondary)

* Each model's own total against the early total, same procedure (weather neutral).
  Thresholds: NFL **2.0**, CFB **3.0**. Pass: protocol rule.

### E-006 · CFB opener-timing sensitivity

* **Why.** CFB openers have no timestamp (DATA_AUDIT §1b). If a CFB model shows CLV, it must
  survive with ratings frozen one week earlier (through week W−2), which no plausible opener
  timing can leak.
* **Procedure.** E-003 and E-004 re-run with week-W games priced from the state at the start of
  week W−1. Reported beside every CFB result; a CFB edge that fails here is not called.

---

## Results

_(added after each run; nothing above is edited after a result exists)_

### Phase 3 results (run 2026-10-21; scorecards `docs/model-loop/clv_early/results/E_00*.json`)

**Reproduction checks first.** The training side of each replay reproduces the published
walk-forward exactly: NFL v2.1.0 margin MAE 2010–2024 = 10.3032 on 4,078 games (published
10.3032); NFL Loop and CFB Loop `prod` predictions equal `docs/model-loop/*/predictions.csv.gz`
to 0.0000 for every season 2009/2012–2025 (2026 differs only by games added since). The CFB V1
week-start replay equals the existing sequential cold replay on 98.6% of games (the rest are
games whose week contained an earlier Thu/Fri game).

Columns: bets, mean CLV in points [95% week-cluster CI], mean CLV in no-vig probability [CI],
line-direction hit rate, permutation p, and expected ROI at the price offered at bet time with
the close as the truth (reporting-only, see addendum A-1 below; −110 where no price exists).

| exp | model · market | thr | bets | CLV pts | CLV prob | dir-hit | perm p | ROI at bet price | edge called? |
|---|---|---|---|---|---|---|---|---|---|
| E-001 | NFL v2.1.0 · spread | 2 | 582 | **+0.372** [+0.22, +0.52] | +0.87% [+0.41, +1.33] | 0.618 | 0.001 | −1.91% | **yes** |
| E-002 | NFL Loop v2.0.0 · spread | 2 | 563 | **+0.400** [+0.24, +0.57] | +0.96% [+0.46, +1.44] | 0.624 | 0.001 | −1.75% | **yes** |
| E-003 | CFB V1 (cfb_p4) · spread | 3 | 2,982 | +0.238 [+0.15, +0.32] | +0.57% [+0.35, +0.80] | 0.536 | 0.001 | −3.47% | **no — fails E-006** |
| E-004 | CFB Loop v2.0.0 · spread | 3 | 2,771 | **+0.548** [+0.45, +0.65] | +1.38% [+1.11, +1.64] | 0.616 | 0.001 | −1.94% | **yes** (survives E-006) |
| E-005 | NFL v2.1.0 · total | 2 | 631 | **+0.446** [+0.31, +0.58] | +1.33% [+0.92, +1.75] | 0.646 | 0.001 | −0.90% | **yes** |
| E-005 | NFL Loop v2.0.0 · total | 2 | 506 | **+0.423** [+0.25, +0.58] | +1.36% [+0.84, +1.88] | 0.667 | 0.001 | −0.97% | **yes** |
| E-005 | CFB V1 · total | 3 | 2,734 | −0.117 [−0.26, +0.04] | −0.29% [−0.65, +0.07] | 0.476 | 0.724 | −5.11% | no |
| E-005 | CFB Loop v2.0.0 · total | 3 | 2,900 | **+0.900** [+0.75, +1.05] | +2.19% [+1.83, +2.54] | 0.664 | 0.001 | −0.42% | **yes** (survives E-006) |
| E-006 | CFB V1 · spread, ratings W−2 | 3 | 3,336 | +0.007 [−0.06, +0.07] | −0.01% | 0.498 | 0.476 | −4.59% | — (sensitivity) |
| E-006 | CFB V1 · total, ratings W−2 | 3 | 3,029 | −0.047 [−0.19, +0.09] | −0.13% | 0.489 | 0.498 | −4.79% | — |
| E-006 | CFB Loop · spread, ratings + QB W−2 | 3 | 3,230 | +0.250 [+0.16, +0.34] | +0.60% [+0.37, +0.83] | 0.551 | 0.001 | −3.42% | passes |
| E-006 | CFB Loop · total, ratings + QB W−2 | 3 | 3,204 | +0.713 [+0.57, +0.86] | +1.72% [+1.38, +2.07] | 0.630 | 0.001 | −1.30% | passes |

Secondary (pre-registered): CLV against the across-book median close instead of the bet book's
close — CFB V1 +0.244, CFB Loop +0.519: the same conclusion.

Threshold sweeps (descriptive; CLV pts at thresholds): NFL v2.1.0 spread 1/3/4: +0.27/+0.41/+0.48;
NFL Loop spread 1/3/4: +0.37/+0.45/+0.46; CFB Loop spread 2/4/5/6: +0.45/+0.61/+0.67/+0.77;
CFB Loop total 2/5: +0.78/+1.17 (ROI +0.77% at 5); NFL totals 4: +0.68 (v2.1.0), +0.61 (Loop).
CLV rises with the size of the edge in every called model (bucket tables in the JSON): e.g.
NFL v2.1.0 spread buckets 0–1/1–2/2–3/3+: −0.18/+0.09/+0.30/+0.41 pts.

Per season (CLV pts at the primary threshold): NFL v2.1.0 spread 2020–24: +0.43, +0.19, +0.36,
+0.52, +0.35 — positive every season. NFL Loop spread: +0.47, +0.55, +0.19, +0.57, +0.25. CFB
Loop spread 2015–19, 2021–24: +0.53, +0.89, +0.95, +0.52, +0.35, +0.40, +0.22, +0.74, +0.33. CFB
Loop total: +1.94, +1.39, +1.11, +1.01, +0.31, +1.00, +0.62, +0.28, +0.24 — **shrinking over time**
(W−2 version: 2023 +0.07, 2024 +0.14).

**What the baselines say.**

1. **Both NFL models find early-week CLV**, every season, rising with edge size; the NFL timing is
   proven by timestamps. The model's disagreement explains ~10% of the τ→close move (movement
   slope +0.08 to +0.10).
2. **CFB V1's spread CLV is entirely last week's information.** Priced from ratings one week
   older it is exactly zero (+0.007). Because CFB openers carry no timestamp, that CLV cannot be
   told apart from a lookahead-line artefact, so — as pre-registered — it is not called.
3. **CFB Loop v2.0.0 keeps CLV with nothing from week W−1** (spreads +0.25, totals +0.71), so
   part of its edge is information the opener under-weights rather than timing.
4. **None of it beats the vig at the price offered.** Expected ROI at the bet-time price is
   negative for every called baseline at its primary threshold (−0.4% to −1.9%); only CFB Loop
   totals at threshold 5 reach +0.77%. CLV of ~1–2% probability is real but smaller than a −110
   price's ~2.4% per side.

**Robustness diagnostic (not pre-registered; disclosed).** 12% of NFL τ lines were last changed
*before* week W−1 kicked off (a lookahead value the feed kept). Those games show outsized CLV
(+1.06 pts, 55 bets) and may not have been bettable at τ. On the 88% re-posted after the weekend:
NFL v2.1.0 spread +0.301 [+0.16, +0.43], NFL Loop spread +0.307 [+0.15, +0.47], NFL v2.1.0 total
+0.443, NFL Loop total +0.401 — still called. From Phase 4 on this is an instrument rule (R-1).

**The bar every later experiment must beat** (development, primary thresholds):

| sport · market | best baseline | CLV pts | under R-1 / W−2 |
|---|---|---|---|
| NFL spread | NFL Loop v2.0.0 (thr 2) | +0.400 | +0.307 (R-1, fresh lines) |
| NFL total | NFL v2.1.0 (thr 2) | +0.446 | +0.443 (R-1) |
| CFB spread | CFB Loop v2.0.0 (thr 3) | +0.548 | +0.250 (W−2) |
| CFB total | CFB Loop v2.0.0 (thr 3) | +0.900 | +0.713 (W−2) |

### Protocol addenda (written after Phase 3, before Phase 4; apply to every later experiment)

* **A-1 (reporting only).** Every scorecard also reports the expected ROI of the bets at the price
  actually offered at bet time, taking the close as the truth (pushes excluded; −110 where the data
  has no price). It is never a pass criterion; it answers "does the CLV beat the vig?".
* **R-1 (NFL instrument rule).** NFL early lines count only if the value at τ was (re)posted after
  the first kickoff of week W−1. Applies to every NFL experiment from Phase 4; NFL comparators are
  re-scored under it on the same games.
* **R-2 (CFB timing rule).** Every CFB experiment from Phase 4 uses inputs from week W−2 or earlier
  only (the E-006 state). Its comparator is the CFB Loop W−2 baseline (+0.250 spreads, +0.713 totals).

---

---

## Phase 4 — Market-residual model (pre-registered 2026-10-21, before any residual model was fitted)

**What it is.** A model of line **movement**: `y = close − early line`, fitted on inputs knowable
at the early line, with the early line as the prior (predicted close = early + m̂). Code:
`model_loop/clv_early/residual.py`. Ridge regression on standardised features with an intercept,
**penalty λ = 25 fixed**, refitted walk-forward (every earlier development season predicts the
next). A bet is placed when **|m̂| ≥ θ = 0.25 points**, on the side the predicted move points to,
and is scored by the same harness.

**Pass rule for every Phase 4 experiment.** Both must hold on its evaluation window:
1. the protocol's edge rule at θ = 0.25 (CI of mean CLV above 0, permutation p ≤ 0.05, prob CLV > 0);
2. it **beats its comparator at matched volume**: in each season the candidate's top-k games by
   |m̂| (k = the comparator's bet count that season) against the comparator's own bets; the paired
   week-cluster bootstrap 95% CI of (candidate mean CLV − comparator mean CLV) lies above 0.

**NFL** (R-1 fresh lines; rows = eligible 2020–2024 games; evaluation **2021–2024**, since a season
needs an earlier season with early lines to train on; base model = NFL Loop v2.0.0, the best NFL
spread baseline):

| exp | features (groups from `residual.py`) | comparator |
|---|---|---|
| E-101 | base (d = Loop − early) | E-002 rule (Loop, threshold 2) on the same games |
| E-102 | base + qb (previous starter left early; previous starter not the regular) | E-101 |
| E-103 | base + rest + travel | E-101 |
| E-104 | base + drift (early − lookahead line; lookahead existed) | E-101 |
| E-105 | base + market (favourite side, \|early\|, on 3, on 7) | E-101 |
| E-106 | base + every group that passed E-102..E-105 (not run if none passed) | E-101 |

**CFB** (R-2: base model = CFB Loop with ratings and QB from week W−2; rows = eligible games with
an opener 2012–2019, 2021–2024; evaluation **2015–2019, 2021–2024**). The qb and drift groups do
not exist for CFB under R-2 (no week W−1 information; no intermediate snapshots):

| exp | features | comparator |
|---|---|---|
| E-111 | base (d = Loop W−2 − opener) | E-006 Loop W−2 rule (threshold 3) on the same games |
| E-112 | base + rest | E-111 |
| E-113 | base + market | E-111 |
| E-114 | base + every group that passed E-112..E-113 (not run if none passed) | E-111 |

**Going more complex (E-120).** Only if the best simple model (E-101..E-106 / E-111..E-114) passes
both rules: the same ridge plus pairwise interactions of `d` with each other feature of that model,
λ = 25, compared against that best simple model by the same matched-volume rule.

### Phase 4 results (run 2026-10-21; scorecards `docs/model-loop/clv_early/results/E_1*.json`)

θ = 0.25 pts of predicted movement; "matched" = candidate top-k by |m̂| vs the comparator's own
bets, same games, paired week-cluster bootstrap.

| exp | model | bets at θ | CLV pts at θ [CI] | perm p | edge rule | matched: cand vs comp (diff [CI]) | result |
|---|---|---|---|---|---|---|---|
| E-101 | NFL base | 256 | −0.145 [−0.39, +0.13] | 0.800 | fail | +0.107 vs +0.375 (−0.268 [−0.49, −0.08]) | **FAIL** |
| E-102 | NFL base+qb | 308 | −0.175 [−0.43, +0.09] | 0.935 | fail | −0.273 vs −0.145 (−0.129 [−0.27, +0.01]) | **FAIL** |
| E-103 | NFL base+rest+travel | 341 | +0.015 [−0.19, +0.23] | 0.248 | fail | −0.047 vs −0.145 (+0.098 [−0.09, +0.31]) | **FAIL** |
| E-104 | NFL base+drift | 281 | −0.021 [−0.24, +0.22] | 0.267 | fail | −0.021 vs −0.145 (+0.123 [+0.01, +0.25]) | **FAIL** (edge rule) |
| E-105 | NFL base+market | 294 | +0.036 [−0.18, +0.27] | 0.217 | fail | −0.012 vs −0.145 (+0.133 [−0.04, +0.30]) | **FAIL** |
| E-106 | NFL combination | — | — | — | — | no group passed | **not run** (as registered) |
| E-111 | CFB base (W−2) | 1,897 | +0.238 [+0.12, +0.35] | 0.001 | pass | +0.202 vs +0.250 (−0.048 [−0.11, +0.00]) | **FAIL** |
| E-112 | CFB base+rest | 2,355 | +0.289 [+0.19, +0.39] | 0.001 | pass | +0.335 vs +0.238 (+0.098 [+0.02, +0.18]) | **PASS** (vs E-111) |
| E-113 | CFB base+market | 2,240 | +0.282 [+0.17, +0.40] | 0.001 | pass | +0.286 vs +0.238 (+0.048 [−0.04, +0.13]) | **FAIL** |
| E-114 | CFB combination | — | — | — | — | only "rest" passed, so E-114 ≡ E-112 | not a new model |
| E-120 | CFB base+rest + d×rest interactions | 2,367 | +0.280 [+0.19, +0.38] | 0.001 | pass | +0.272 vs +0.289 (−0.017 [−0.05, +0.01]) | **FAIL** (complexity adds nothing) |

**Against the Phase 3 bar** (computed after E-112 passed, using the bar table written before Phase 4):
E-112's top 3,230 by |m̂| vs the CFB Loop W−2 baseline's 3,230 bets: +0.263 vs +0.250, difference
**+0.013 [−0.057, +0.080]** — it does **not** beat the baseline.

**What Phase 4 says.**
* **NFL: the market-residual model is worse than simply betting the base model's disagreement.**
  Fitting the move (`close − early`) on the disagreement adds an intercept and shrinks the slope to
  ≈0.08, and with 1–4 training seasons of ~230 games that intercept is noise that moves the bets
  onto the wrong side of small edges (E-101 top-420 +0.107 vs the plain rule's +0.375). No added
  group (QB flags, rest/travel, drift, market structure) rescued it at θ = 0.25.
* **CFB: rest is the one input the opener under-prices** (rest-difference coefficient ≈ +0.27 pts
  of move per week of rest advantage, short-week +0.50, stable across seasons): E-112 beats E-111.
  But the gain only repairs what the residual framing lost; at matched volume it ties the plain
  CFB Loop W−2 rule. Interactions add nothing (E-120).
* **Phase 4 verdict: no market-residual model beats its sport's baseline.** The baseline
  disagreement rules remain the candidates.

---

## Phase 5 — Targeted weak spots and softer markets (pre-registered 2026-10-21, before any run)

### E-201 · NFL backup-QB games at the Friday line

* **Hypothesis.** When a team's starter is ruled out, the NFL model (≈5 pts off the market in
  backup games) priced with the *expected* backup finds Friday prices that move toward it.
* **Games.** NFL 2020–2024, a live Friday line (Friday 17:00 ET of the game week; Thursday games
  have none) and a close, eligible, and at least one team whose previous-game starter is listed
  **Out or Doubtful** on that week's final injury report (`nflverse-data injuries_<season>.csv`,
  `report_status`) with `date_modified` ≤ the Friday checkpoint.
* **Model.** NFL Loop v2.0.0 (production training). Prediction rows priced with the Friday-expected
  starter: for a team whose previous-game starter is Out/Doubtful, the team's QB with the most
  dropbacks this season before week W other than him (no prior dropbacks → new-QB prior); otherwise
  the previous-game starter. Weather neutral; week-start ratings.
* **Bet / close.** Friday line → close, threshold **2.0**.
* **Pass.** The protocol edge rule on these games. Reported beside it: the same games priced with the
  previous-game starter (Tuesday inputs) at the Friday line, and the model-vs-Friday-line gap.

### E-202 · CFB games with no power-conference team (softer market), at the opener

* **Hypothesis.** The CFB opener is softer outside the power conferences, so the CFB Loop (R-2, W−2)
  rule earns more CLV there.
* **Games.** CFB development games where neither team is in a power conference: SEC, Big Ten,
  Big 12, ACC, and Pac-12 through 2023, plus Notre Dame. (Pac-12 in 2024 is not power.)
* **Rule.** CFB Loop W−2 baseline rule, threshold **3.0** (CFB openers are the early-week line).
* **Pass.** The edge rule on the non-power subset **and** the week-cluster bootstrap 95% CI of
  (non-power mean CLV − power-involved mean CLV) lies above 0.

### E-203 · NFL totals with venue weather climatology instead of neutral weather

* **Hypothesis.** The τ total is set before a forecast exists; climatology (knowable in advance)
  is information the early total may under-use.
* **Change (one).** NFL v2.1.0 total at τ (R-1), with temperature and wind on non-dome games set to
  that stadium's mean in the same calendar month over seasons < S (league monthly mean if the
  stadium has fewer than 3 such games), instead of neutral (68°F, 0 mph).
* **Comparator.** E-005 NFL v2.1.0 total (neutral weather), R-1, same games, threshold 2.
* **Pass.** The edge rule at threshold 2 **and** beats the comparator at matched volume (paired CI > 0).

### E-204 · Team totals — skipped (no line data exists; DATA_AUDIT.md §1)
### E-205 · First-half markets — skipped (no line data exists; DATA_AUDIT.md §1)

### Phase 5 results (run 2026-10-21; scorecards `docs/model-loop/clv_early/results/E_20*.json`)

| exp | games / bets | CLV pts [CI] | CLV prob [CI] | perm p | ROI at bet price | comparison | result |
|---|---|---|---|---|---|---|---|
| E-201 NFL backup-QB, Friday line, thr 2 | 66 / 35 | +0.214 [−0.10, +0.55] | +0.92% [−0.04, +1.86] | 0.043 | −1.85% | same games with previous-game starters: 42 bets, +0.012; mean \|model − Friday line\| 3.56 (Friday starters) vs 4.11 | **FAIL** (CI spans 0) |
| E-202 CFB non-power, opener, thr 3 | — / 1,384 | +0.090 [−0.04, +0.23] | +0.16% [−0.17, +0.53] | 0.038 | −4.25% | power-involved: 1,846 bets, +0.370 [+0.26, +0.48]; non-power − power = **−0.280 [−0.44, −0.12]** | **FAIL** (and the opposite of the hypothesis) |
| E-203 NFL totals, venue climatology, thr 2 (R-1) | — / 584 | +0.479 [+0.35, +0.62] | +1.43% [+1.02, +1.84] | 0.001 | −0.69% | matched vs neutral weather: +0.483 vs +0.443, diff +0.040 [−0.006, +0.089] | **FAIL** (edge rule passes; not better than neutral) |
| E-204 team totals | — | — | — | — | — | no data | skipped |
| E-205 1H | — | — | — | — | — | no data | skipped |

**What Phase 5 says.**
* **Backup-QB games are too rare to test.** With the Friday injury report there are only 66
  eligible NFL games in five seasons (35 bets). Pricing the expected backup brings the model
  closer to the Friday line (3.56 vs 4.11 points) and the point estimate is positive, but the
  interval spans zero. Nothing can be concluded either way.
* **Non-power CFB openers are not softer for this model.** The CFB Loop W−2 rule earns 0.28 pts
  *less* outside the power conferences (interval excludes zero). Its CLV lives in the
  power-involved games (+0.37). The likely reason is that the model's own inputs (EPA,
  talent, QB) are thinner for those teams, not that those markets are sharp.
* **Climatology does not improve NFL totals.** The +0.04 gain is inside the noise. The neutral
  baseline stays.

---

### Note: relocation (2026-10-21, after Phase 5, before Phase 6)

While this study ran, a separate session merged an independent CLV study into `main` with the same
root file names (`DATA_AUDIT.md`, `EXPERIMENTS.md`, `model_loop/clv/harness.py`, `residual.py`,
`model_loop/tests/test_clv_harness.py`). To keep both records intact, this study moved without
changing any content other than paths:
`DATA_AUDIT.md`, `EXPERIMENTS.md` → `research/clv_early_week/`; `model_loop/clv/` →
`model_loop/clv_early/`; `docs/model-loop/clv/results/` → `docs/model-loop/clv_early/results/`;
the tests → `model_loop/tests/test_clv_early_harness.py`. The two studies share no code, data
files or experiment IDs; their attempts are not pooled.

---

## Phase 6 — Holdout gate (pre-registered 2026-10-21, before any holdout season was scored)

**Selection, from 2015–2024 development results only.** One candidate per sport-market. Each is
the best called rule on development data under the instrument rules R-1/R-2. NFL spreads carry two,
because the production board model (v2.1.0) and the best NFL spread baseline (Loop v2.0.0) are
statistically tied on development data (+0.301 vs +0.307 under R-1). The owner asked for the
production model's answer specifically. No Phase 4 or Phase 5 variant beat its baseline, so none
is a candidate.

| id | sport · market | rule (all inputs knowable at the bet line) | development CLV pts |
|---|---|---|---|
| H-1 | NFL spread | NFL v2.1.0 (board model), \|model − τ line\| ≥ 2.0, R-1 | +0.301 [+0.16, +0.43] |
| H-2 | NFL spread | NFL Loop v2.0.0, \|model − τ line\| ≥ 2.0, R-1 | +0.307 [+0.15, +0.47] |
| H-3 | NFL total | NFL v2.1.0, \|model − τ total\| ≥ 2.0, neutral weather, R-1 | +0.443 [+0.30, +0.59] |
| H-4 | CFB spread | CFB Loop v2.0.0, ratings + QB through week W−2 (R-2), \|model − opener\| ≥ 3.0 | +0.250 [+0.16, +0.34] |
| H-5 | CFB total | CFB Loop v2.0.0, R-2, \|model − opening total\| ≥ 3.0 | +0.713 [+0.57, +0.86] |

Development effort behind this choice: **96 configurations scored** (143 scoring runs; 32 at a
primary threshold), all in the ledger below.

**Holdout data** (read once, all five candidates in one run):
* NFL: 2025 weeks 2+ and 2026 weeks 2–7, the nflverse feed at τ under R-1; close = the last
  pre-kick value (as in development).
* CFB 2025: the archive's Bovada opener and close (as in development).
* CFB 2026: the archive has no 2026 lines. EdgeDesk's own hourly DraftKings captures
  (`football/cfb_lab/ledger/2026/quotes`, weeks 5–8, 235 games): early line = the earliest pregame
  quote (median 148 h before kickoff), close = the last pregame quote, no prices (−110). This is a
  different book from development, and that is stated with the results.
* Model predictions are the walk-forward files already built in Phase 3 (fitted on seasons before
  each holdout season). Distributions, eligibility and QA rules are unchanged.

**Pass rule (per candidate, pooled 2025 + 2026-to-date), Bonferroni over k = 5:**
1. at least **50 bets**;
2. the **one-sided 99% lower bound** (α = 0.05/5) of mean CLV in points is above 0. This is the 1st
   percentile of a week-cluster bootstrap with 4,000 resamples;
3. within-week permutation p ≤ **0.01** (2,000 permutations);
4. mean CLV in probability > 0.

Reported but never gating: each season separately, ROI at the bet price, edge buckets.

**If a candidate passes**, it is wired in as a live-tracking candidate and is never served:
* CFB: an experiment in the CFB Model Lab registry (`football/cfb_lab/governance.js experiment`,
  scope SINGLE_CHANGE, status RUNNING, metric CLV). No role is registered, because auto-promotion
  considers challenger and candidate roles.
* NFL: an event in `football/research/nfl_v2/registry.json` with status `CANDIDATE (CLV live
  tracking)`, and `current` unchanged. This is done only if that registry's consumers still pass
  their tests; otherwise it goes in a standalone tracking file, and the report says so.

**If none passes:** stated plainly, with the most promising next direction from the evidence.

### Phase 6 results — the holdout, read once (2026-10-21; `docs/model-loop/clv_early/results/H_*.json`)

Pooled 2025 + 2026-to-date. The bound is the one-sided 99% lower bound of mean CLV in points
(α = 0.05/5).

| id | candidate | bets | CLV pts | 99% lower bound | CLV prob [98% CI] | perm p (≤ 0.01) | dir-hit | ROI at bet price | **gate** |
|---|---|---|---|---|---|---|---|---|---|
| H-1 | NFL v2.1.0 spread | 138 | +0.319 | +0.086 ✓ | +0.56% [−0.26, +1.46] | 0.016 ✗ | 0.679 | −3.38% | **FAIL** |
| H-2 | NFL Loop v2.0.0 spread | 142 | +0.229 | −0.155 ✗ | +0.30% [−0.80, +1.32] | 0.028 ✗ | 0.583 | −3.93% | **FAIL** |
| H-3 | NFL v2.1.0 total | 114 | **+0.504** | **+0.234** ✓ | +1.24% [+0.48, +2.08] | 0.0015 ✓ | 0.697 | −2.14% | **PASS** |
| H-4 | CFB Loop v2.0.0 (W−2) spread | 460 | **+0.259** | **+0.068** ✓ | +0.64% [+0.19, +1.11] | 0.0045 ✓ | 0.537 | −3.33% | **PASS** |
| H-5 | CFB Loop v2.0.0 (W−2) total | 426 | **+0.418** | **+0.135** ✓ | +1.02% [+0.33, +1.61] | 0.0005 ✓ | 0.573 | −2.60% | **PASS** |

Per season (bets, CLV pts):
* H-1: 2025 112, +0.366; 2026 26, +0.115
* H-2: 2025 115, +0.335; 2026 27, −0.222
* H-3: 2025 96, +0.589; 2026 18, +0.056
* H-4: 2025 359, +0.258 (Bovada); 2026 101, +0.262 (DraftKings captures)
* H-5: 2025 328, +0.348; 2026 98, +0.653

Edge buckets (CLV pts for |edge| 0–1 / 1–2 / 2–3 / 3+):
* H-3: +0.07 / −0.20 / +0.34 / +0.63
* H-4: +0.09 / +0.06 / +0.12 / +0.26
* H-5: −0.14 / −0.08 / +0.08 / +0.42

**Reading it.**
* **Three of five pass.** NFL totals (v2.1.0), CFB spreads and CFB totals (Loop v2.0.0 priced from
  week W−2) move toward the model by the close on seasons they never saw. They do so by about as
  much as in development: +0.50 vs +0.44, +0.26 vs +0.25, +0.42 vs +0.71.
* **CFB totals shrank** from +0.71 in development to +0.42, continuing the decline seen season by
  season since 2015.
* **NFL spreads fail.** Both point estimates are positive and v2.1.0 clears the bound, but neither
  clears the Bonferroni permutation bar on ~140 bets. Its probability interval spans zero.
* **No candidate beats the vig at the price offered.** Expected ROI with the close as truth is
  −2.1% to −3.9%. The CLV is about +0.6–1.2% of probability per bet, while a −110 bet needs about
  +2.4%. The holdout prices carry more juice than development's (2025 NFL feed).

**Wiring** of H-3, H-4 and H-5 as live-tracking candidates, as pre-registered: see FINAL_REPORT.md
§Wiring.

---

## Phase 7 — Reconciling with the independent study on `main` (pre-registered 2026-10-21, before any cross-score)

**Why.** A second CLV study (root `FINAL_REPORT.md`, `model_loop/clv/`, `research/clv/`) reached two
different conclusions: (a) NFL totals beat the vig (its NFL-H4, +2.1% `clv_ev` on SBR 2020–21);
(b) the market-residual model is the best design everywhere. Its NFL lines are the SBR archive's
"open" (no timestamp), and its CFB residual reads week W−1 information against untimestamped
openers.

**Line-timing audit (data only, run before this entry; no model was scored).** On 2020–21, where
both sources exist, the SBR NFL opener equals this study's τ line in **0.2%** of games. It equals
the nflverse lookahead value (the line standing before week W−1 kicked off) in 33% (spreads) and
40% (totals), while lookahead and τ agree only 17% / 11% of the time. Mean |τ − SBR open| =
1.58 spread points. A large share of SBR "opens" were therefore posted **before week W−1 was
played**, and both studies' models price with week W−1 results.

Every test below uses the other study's own code and fitted rules where it applies them, and
this study's harness. 2025–26 is re-read here (this study's holdout). These are cross-checks of
rules already chosen, not new selections.

| id | test | decision rule (fixed now) |
|---|---|---|
| X-1 | Harness parity: both harnesses on one identical frame (the other study's NFL-H2 proxy frame) | mean CLV pts must agree to 1e-9. Probability CLV may differ by the distribution used (reported) |
| X-2 | Line source: the same v2.1.0 early-week predictions, plain rules (spread ≥ 2, total ≥ 2), scored against SBR opens and against τ lines on the same 2020–21 games; and against SBR 2011–2019 | descriptive |
| X-3 | **SBR timing**: v2.1.0 with week W−1 inputs vs week W−2 inputs (state at the start of W−1, starter from the last game ≤ W−2), plain rules, against SBR opens 2011–2021 and against τ lines 2020–2024 | SBR CLV is **timing-confounded** if the W−2 version keeps < ½ of its W−1 CLV (pts) against SBR **and** ≥ ½ against τ |
| X-4 | **Do NFL totals beat the vig on timestamped lines?** The other study's NFL-H4 (totals residual frozen on SBR 2011–19, its own base predictions) and NFL-H2 (v2.1.0 total, ≥ 1.5) on τ lines 2025–26 (R-1), at the prices offered | "beats the vig" only if ROI at the offered price has a one-sided lower bound (α = 0.05/2, week-cluster bootstrap) above 0 for either rule |
| X-5 | **Does the residual design help?** NFL-H4 vs NFL-H2 and vs this study's H-3, matched volume, same games, τ 2021–2026 (R-1) | "helps" only if the paired matched-volume CI of the CLV difference lies above 0 |
| X-6 | **CFB residual timing**: the other study's CFB-R2 rebuilt with its own residual code (inner-walk-forward λ, ≥ 3 training seasons, same features) on this study's CFB lines, with base inputs from week W−1 (its p4 replay + its v2 previous-QB loop) vs week W−2 (this study's p4 and Loop W−2), walk-forward 2015–19, 2021–24 | its CFB edge is **timing-robust** only if the W−2 version passes this study's edge rule at θ = 0.25 **and** keeps ≥ ½ of the W−1 CLV (pts) |

### Phase 7 results (2026-10-21; `docs/model-loop/clv_early/results/cross/`)

**X-1, harness parity — PASS.** On the other study's NFL-H2 proxy frame both harnesses place the
same 422 bets with identical mean CLV (+0.99526 pts). Probability CLV differs by 0.01 pp
(2.975% vs 2.964%; different outcome distributions). The studies disagree because of their
lines, not their scoring.

**X-2, line source.** The same v2.1.0 early-week predictions, plain rules, same 2020–21 games:

| market | vs SBR open | vs τ line (same games) | vs SBR 2011–19 (new to this study) |
|---|---|---|---|
| spread ≥ 2 | +0.811 pts, 273 bets, ROI@−110 +0.68% | +0.143 pts, 189 bets | +0.565 pts, 1,002 bets, ROI −0.86% |
| total ≥ 2 | **+1.117 pts**, 351 bets, ROI@−110 **+1.80%** | +0.593 pts, 269 bets, ROI +0.67% | **+0.794 pts**, 1,063 bets, ROI **+0.02%** |

Against SBR's (earlier) opener the same model earns about 2× the CLV it earns against the Tuesday
line. Over SBR 2011–21, NFL totals at ≥ 2 return +0.46% at −110.

**X-3, SBR timing.** With week W−2 inputs, CLV kept relative to W−1:

| market | vs SBR 2011–21 | vs τ 2020–24 | verdict |
|---|---|---|---|
| spread | 0.53 (+0.618 → +0.327) | 0.72 (+0.301 → +0.215) | not confounded (borderline) |
| total | 0.83 (+0.874 → +0.723) | 0.78 (+0.443 → +0.348) | not confounded |

The SBR opener is earlier, and its extra CLV is mostly not week W−1 information. It is a softer
number.

**X-4, NFL totals vs the vig on timestamped lines — NOT SHOWN.** Results on τ 2025–26 at the prices
offered:

| rule | bets | CLV | ROI [95% CI] |
|---|---|---|---|
| NFL-H4 (the other study's totals residual, frozen on SBR 2011–19) | 222 | +0.243 pts | **−3.29%** [−4.31, −2.25] |
| NFL-H2 (v2.1.0 total ≥ 1.5) | 162 | +0.417 pts | **−2.21%** [−3.27, −1.04] |
| This study's H-3 | 114 | +0.504 pts | −1.92% |

At −110 the same picture holds. Over 2021–26 every rule sits between −1.6% and −2.6%.

**X-5, does the residual design help (NFL totals, τ 2021–26, matched volume)? — MIXED.**
* NFL-H4 vs NFL-H2: +0.421 vs +0.423 (diff −0.002 [−0.07, +0.07]). No help.
* NFL-H4 vs this study's H-3: +0.503 vs +0.419 (diff **+0.084 [+0.001, +0.170]**). This clears the
  rule by a hair.
* Against the other study's own plain rule it adds nothing. The pre-registered rule is met on one
  of its two comparisons, so the honest reading is no reliable gain.

**X-6, CFB residual timing — TIMING-ROBUST.** CFB-R2, rebuilt with the other study's residual
code on this study's CFB lines:
* W−1 inputs: +0.533 pts (4,051 bets, dev), +0.534 frozen on 2025.
* W−2 inputs: +0.309 pts (2,450 bets, dev; edge rule passes), +0.449 on 2025.
* Kept 0.58 of its CLV, so the CFB residual is not a timing artefact.

Descriptive (not pre-registered): CFB-R2 at W−2 against this study's H-4 at matched volume is
+0.280 vs +0.212 (diff +0.068 [−0.013, +0.144]). It is better but not significantly. Its expected
ROI at −110 is −2.5% to −3.1%.

**Reconciled conclusions.**
1. **Both studies measure the same thing, and the line decides the size.**
   * Against the earliest opener (SBR, often posted before the previous week is played) NFL CLV is
     about twice what it is against the Tuesday line.
   * That is not a timing leak (X-3).
2. **NFL totals clear −110 only against the true opener.**
   * Against SBR 2011–21: +0.46% (+1.8% in 2020–21).
   * Against a timestamped Tuesday line: no rule from either study beats the vig (−1.9% to −3.3%
     in 2025–26).
   * The other study's "+2.1% on NFL totals" is real against SBR's open. It is a statement about
     betting the number when it first appears, at whatever limits that book allows.
3. **The market-residual design is not reliably better than the plain rule** on timestamped NFL
   lines. In CFB, built properly (inner-walk-forward λ, two base models, at least 3 training
   seasons), it is timing-robust and nominally better than this study's rule, but not
   significantly.
   * This study's Phase 4 failure partly reflects its own choices: a fixed λ and 1–4 NFL training
     seasons.
4. **Nothing changes the bottom line at standard prices.** CLV is real in both sports. Beating the
   vig needs either the opener itself or better-than-−110 prices (step 3).

---

## Live tracking (2026-10-21)

The three rules that passed Phase 6 are tracked by the shared live tracker that already runs for
the other study (`research/clv/live.py`, every two hours via `.github/workflows/clv-live.yml`;
results in `research/clv/live/summary.json`). Nothing is served. This avoids a second tracker,
and X-1 showed the two harnesses score identically.

| live id | rule | model number | bet line → close |
|---|---|---|---|
| EDGE-H3 | H-3: NFL v2.1.0 total, edge ≥ 2 | the board's v2.1.0 total, first sighting (`football/nfl/slate.json`) | DraftKings line showing at that sighting → last pregame quote (`record/football/quotes/nfl_2026.jsonl`) |
| EDGE-H4 | H-4: CFB Loop v2.0.0 spread, edge ≥ 3 | the Loop's number **as first published before either team's week W−1 game kicked off** | the CFB Lab's observed OPEN → CLOSE |
| EDGE-H5 | H-5: same, totals | as EDGE-H4 | as EDGE-H4 |

**What was added to the tracker** (additive; no existing candidate's grading changes):
* a first-sighting capture of `football/cfb/model_loop/current.json`, with the time each number
  was computed (`generated_at`);
* the `v2_w2` columns in its CFB frame (`loop_w2`);
* the three registry entries, which `register.py` re-creates;
* two unit tests (`model_loop/tests/test_clv_live.py`).

**The live W−2 rule is team-specific.** In the backtest it meant the state at the start of week
W−1. Live, the Loop publishes only ten days ahead, and from November midweek games make "before
week W−1's first kickoff" exclude almost every Saturday game. So the live rule requires the number
to predate both teams' own week W−1 games (a bye adds no constraint). The residual exposure is
other teams' midweek results moving the opponent adjustment: stated here, and judged second-order.

---

## Step 3 — What price does each rule need? (2026-10-21; descriptive, `docs/model-loop/clv_early/results/step3_prices.json`)

Descriptive only: seasons already scored, nothing selected. Each bet's no-vig chance of winning at
its own number comes from the closing market. It is priced at a grid of odds (pushes excluded).

| rule | sample | n | −110 | −108 | −105 | −103 | −102 | +100 | break-even |
|---|---|---|---|---|---|---|---|---|---|
| H-3 NFL v2.1.0 total ≥ 2 (Tuesday line) | holdout 2025–26 | 114 | −1.91% | −1.04% | +0.32% | +1.27% | +1.75% | +2.76% | **−106** |
| | development | 581 | −1.89% | −1.02% | +0.34% | +1.29% | +1.78% | +2.78% | −106 |
| H-4 CFB Loop W−2 spread ≥ 3 (bet book) | holdout | 460 | −3.33% | −2.47% | −1.14% | −0.20% | +0.28% | +1.28% | **−103** |
| | development | 3,230 | −3.39% | −2.54% | −1.20% | −0.26% | +0.22% | +1.21% | −102 |
| H-5 CFB Loop W−2 total ≥ 3 (bet book) | holdout | 426 | −2.60% | −1.74% | −0.39% | +0.55% | +1.04% | +2.04% | **−104** |
| | development | 3,204 | −1.26% | −0.39% | +0.98% | +1.94% | +2.43% | +3.44% | −107 |
| H-1 NFL v2.1.0 spread ≥ 2 (failed the gate) | holdout | 138 | −3.27% | −2.42% | −1.08% | −0.14% | +0.34% | +1.33% | −103 |

**Earlier entry (NFL totals ≥ 2, same model):**

| line bet | n | −110 | −105 | break-even |
|---|---|---|---|---|
| SBR opener, 2011–21 | 1,414 | **+0.46%** | +2.74% | **−111** |
| SBR opener, 2020–21 | 351 | +1.80% | +4.11% | −114 |
| Tuesday line, the same 2020–21 games | 269 | −1.16% | +1.08% | −107 |

**Line shopping (CFB 2023–25, the seasons with three books' openers: Bovada, DraftKings, ESPN
Bet).** The best opening number for the rule's side, graded against the consensus close:
* **spreads:** 1,037 games, +0.49 pts better number on average. CLV +0.24 → +0.73 pts; ROI at
  −110 −3.3% → **−0.9%**; break-even −103 → **−108**.
* **totals:** 819 games, +0.31 pts. CLV +0.22 → +0.53; ROI −3.5% → −2.1%; break-even −102 → −105.

This is an upper bound: the books' openers carry no timestamps, so "the best of three openers"
assumes all three could be bet.

**The decision this leaves (yours: it is about book access, not models):**

| if you can get… | then… |
|---|---|
| the **first NFL total** a book posts (often the lookahead, before the previous week is played) | NFL totals ≥ 2 are profitable at standard −110 (+0.5%, +1.8% in 2020–21). Openers carry low limits. |
| **−106 or better** on NFL totals at the Tuesday line | H-3 breaks even at −106 and earns +1.3% at −103 |
| **3+ CFB books to shop** plus reduced juice around −108 | CFB spreads break even (−108 with shopping) |
| a **−103/−104** venue (reduced-juice book, exchange at about 2% commission) | CFB spreads (−103) and CFB totals (−104) break even, and anything better is profit |
| only standard −110 at one book, Tuesday or later | none of the rules makes money; they remain useful as information (the board's lean) only |

---

## Step 4 — Timestamped CFB re-test and big-edge variants (pre-registered 2026-10-21, before any of it was scored)

**Why.**
* With last week's information the CFB Loop showed about twice the CLV (+0.55 vs +0.25 pts on
  spreads), but untimestamped openers could not rule out a lookahead artefact (R-2). EdgeDesk's own
  2026 DraftKings captures carry timestamps, so the W−1 rule can now be tested where its timing is
  provable.
* Separately, CLV rose with edge size in every passing rule (step 3 / Phase 6 buckets), so the
  largest-edge thresholds are worth tracking.

**Forward gate (the only pass/fail here).** It covers games that kick off after this entry's
commit and is graded by the shared live tracker (`research/clv/live/summary.json`, same frozen
rules, same harness). Each variant is judged when it reaches **100 graded bets**, or else at the
end of the 2026 season. With **k = 5** variants:
* PASS = mean CLV pts > 0 **and** the probability-CLV one-sided p ≤ 0.05/5 **and** n ≥ 100;
* fewer than 100 bets by season's end = INCONCLUSIVE.

| live id | variant | model number | line |
|---|---|---|---|
| EDGE-L1 | CFB Loop v2.0.0 spread, edge ≥ 3, **week W−1 inputs at open time** | the Loop number the CFB Lab recorded at its OPEN checkpoint (computed when the line opened) | the Lab's observed OPEN → CLOSE (timestamped) |
| EDGE-L2 | the same, totals | as EDGE-L1 | as EDGE-L1 |
| EDGE-B1 | H-5 at **edge ≥ 5** (CFB totals, W−2 number) | as EDGE-H5 | as EDGE-H5 |
| EDGE-B2 | H-4 at **edge ≥ 5** (CFB spreads, W−2 number) | as EDGE-H4 | as EDGE-H4 |
| EDGE-B3 | H-3 at **edge ≥ 3** (NFL totals) | as EDGE-H3 | as EDGE-H3 |

**First look (reported, never gating).** This uses already-captured 2026 weeks 5–8, which Phase 6
read for the W−2 rules.
* The W−1 rule (this study's `pred_cfb_loop`, previous-game starter) is scored against the
  earliest DraftKings capture **only for games whose early quote was observed after both teams'
  week W−1 games had kicked off + 4 h**, so W−1 information was public when that line stood.
* It sits beside the W−2 rule on the same games.
* The big-edge thresholds are also reported on the 2025–26 holdout bets already scored.

### Step 4 first look (2026-10-21; never gating; `docs/model-loop/clv_early/results/step4_first_look.json`)

**Timing.** Of 234 2026 CFB games with a DraftKings early capture, **200** have provable timing:
the early quote was observed after both teams' previous games had kicked off + 4 h.

**Results on those 200 games (edge ≥ 3, −110 assumed: the captures carry no prices):**

| market | W−1 inputs | W−2 inputs |
|---|---|---|
| spread | **+0.811 pts** [+0.39, +1.59], 61 bets, +1.94%, perm p 0.004 | +0.311 [+0.14, +0.69], 90 bets, +0.66%, p 0.10 |
| total | **+0.929 pts** [+0.55, +1.27], 70 bets, +2.28%, p 0.002 | +0.747 [+0.18, +1.25], 83 bets, +1.82%, p 0.002 |

Where the line was demonstrably posted after last week's games, the Loop with last week's
information still shows the larger CLV (spreads about 2.6×). This is the first direct evidence that
the W−1 edge is real rather than a lookahead artefact. It rests on 61–70 bets from four weeks
already read, so it decides nothing. The forward gate (EDGE-L1/L2) does.

**Big edges on the 2025–26 holdout (descriptive):**

| rule | threshold | bets | CLV pts [CI] | ROI |
|---|---|---|---|---|
| CFB totals | ≥ 3 | 426 | +0.418 [+0.20, +0.63] | −2.60% |
| CFB totals | **≥ 5** | 169 | **+0.692** [+0.44, +0.93] | **−1.32%** |
| CFB spreads | ≥ 3 | 460 | +0.259 [+0.11, +0.42] | −3.33% |
| CFB spreads | ≥ 5 | 220 | +0.427 [+0.14, +0.70] | −2.56% |
| NFL totals | ≥ 2 | 114 | +0.504 [+0.28, +0.75] | −2.14% |
| NFL totals | ≥ 3 | 65 | +0.631 [+0.35, +0.95] | −1.70% |
| NFL totals | ≥ 4 | 33 | +0.697 [+0.19, +1.30] | −1.10% |

Larger edges carry more CLV and lose less at −110, but none is positive at −110 on the holdout.

**Live status at registration.**
* All eight EDGE entries run in the tracker with 0 graded bets so far: the forward variants count
  only games kicking off after 2026-10-21T17:18:50Z.
* The CFB Lab's derived OPEN/CLOSE lines (`football/cfb_lab/ledger/2026/lines.jsonl`) currently
  run through week 7. CFB grading therefore lags by the Lab's settlement cadence.
* The Lab began recording the Loop at its OPEN checkpoint on 2026-10-21 (EXP-005), so EDGE-L1/L2
  accrue from week 9.

## Variant ledger

Generated from `docs/model-loop/clv_early/results/ledger.jsonl`, which `model_loop/clv_early/run.py` appends on
every scoring run (failures included). One row per unique (experiment, label, threshold); "runs"
counts re-scorings of the identical configuration. Rows H-1..H-5 are the holdout (2025 + 2026),
whose "rule" column applies the development 95% rule; the holdout gate itself is the Phase 6 table (e.g. re-run after the ROI column was added or a
diagnostics bug was fixed — CLV unchanged). "CLV>0" = the protocol's edge rule on that row.

| # | exp | label | market | thr | role | bets | CLV pts | rule | runs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | E-001 | NFL v2.1.0 spread | spread | 2 | primary | 582 | +0.372 | CLV>0 | 3 |
| 2 | E-001 | NFL v2.1.0 spread | spread | 1 | sweep | 888 | +0.274 | CLV>0 | 3 |
| 3 | E-001 | NFL v2.1.0 spread | spread | 3 | sweep | 374 | +0.413 | CLV>0 | 3 |
| 4 | E-001 | NFL v2.1.0 spread | spread | 4 | sweep | 226 | +0.478 | CLV>0 | 3 |
| 5 | E-003 | CFB V1 spread | spread | 3 | primary | 2982 | +0.238 | CLV>0 | 2 |
| 6 | E-003 | CFB V1 spread | spread | 2 | sweep | 3941 | +0.222 | CLV>0 | 2 |
| 7 | E-003 | CFB V1 spread | spread | 4 | sweep | 2178 | +0.257 | CLV>0 | 2 |
| 8 | E-003 | CFB V1 spread | spread | 5 | sweep | 1545 | +0.252 | CLV>0 | 2 |
| 9 | E-003 | CFB V1 spread | spread | 6 | sweep | 1092 | +0.284 | CLV>0 | 2 |
| 10 | E-006 | CFB V1 spread ratings W-2 | spread | 3 | primary | 3336 | +0.007 | no | 2 |
| 11 | E-006 | CFB V1 spread ratings W-2 | spread | 2 | sweep | 4219 | -0.003 | no | 2 |
| 12 | E-006 | CFB V1 spread ratings W-2 | spread | 4 | sweep | 2503 | +0.024 | no | 2 |
| 13 | E-006 | CFB V1 spread ratings W-2 | spread | 5 | sweep | 1881 | +0.005 | no | 2 |
| 14 | E-006 | CFB V1 spread ratings W-2 | spread | 6 | sweep | 1390 | +0.003 | no | 2 |
| 15 | E-005 | NFL v2.1.0 total | total | 2 | primary | 631 | +0.446 | CLV>0 | 3 |
| 16 | E-005 | NFL v2.1.0 total | total | 1 | sweep | 906 | +0.367 | CLV>0 | 3 |
| 17 | E-005 | NFL v2.1.0 total | total | 3 | sweep | 439 | +0.538 | CLV>0 | 3 |
| 18 | E-005 | NFL v2.1.0 total | total | 4 | sweep | 270 | +0.683 | CLV>0 | 3 |
| 19 | E-005 | CFB V1 total | total | 3 | primary | 2734 | -0.117 | no | 2 |
| 20 | E-005 | CFB V1 total | total | 2 | sweep | 3743 | -0.128 | no | 2 |
| 21 | E-005 | CFB V1 total | total | 4 | sweep | 1895 | -0.099 | no | 2 |
| 22 | E-005 | CFB V1 total | total | 5 | sweep | 1261 | -0.051 | no | 2 |
| 23 | E-005 | CFB V1 total | total | 6 | sweep | 786 | +0.108 | no | 2 |
| 24 | E-002 | NFL Loop v2.0.0 spread | spread | 2 | primary | 563 | +0.400 | CLV>0 | 3 |
| 25 | E-002 | NFL Loop v2.0.0 spread | spread | 1 | sweep | 870 | +0.370 | CLV>0 | 3 |
| 26 | E-002 | NFL Loop v2.0.0 spread | spread | 3 | sweep | 296 | +0.453 | CLV>0 | 3 |
| 27 | E-002 | NFL Loop v2.0.0 spread | spread | 4 | sweep | 167 | +0.461 | CLV>0 | 3 |
| 28 | E-005 | NFL Loop v2.0.0 total | total | 2 | primary | 506 | +0.423 | CLV>0 | 3 |
| 29 | E-005 | NFL Loop v2.0.0 total | total | 1 | sweep | 868 | +0.355 | CLV>0 | 3 |
| 30 | E-005 | NFL Loop v2.0.0 total | total | 3 | sweep | 283 | +0.509 | CLV>0 | 3 |
| 31 | E-005 | NFL Loop v2.0.0 total | total | 4 | sweep | 127 | +0.610 | CLV>0 | 3 |
| 32 | E-001-fresh | NFL v2.1.0 spread fresh-only | spread | 2 | primary | 527 | +0.301 | CLV>0 | 1 |
| 33 | E-002-fresh | NFL Loop v2.0.0 spread fresh-only | spread | 2 | primary | 512 | +0.307 | CLV>0 | 1 |
| 34 | E-005-fresh | NFL v2.1.0 total fresh-only | total | 2 | primary | 581 | +0.443 | CLV>0 | 1 |
| 35 | E-005-fresh | NFL Loop v2.0.0 total fresh-only | total | 2 | primary | 476 | +0.401 | CLV>0 | 1 |
| 36 | E-003 | CFB V1 spread vs consensus close | spread | 3 | primary | 2982 | +0.244 | CLV>0 | 1 |
| 37 | E-006 | CFB V1 total ratings W-2 | total | 3 | primary | 3029 | -0.047 | no | 1 |
| 38 | E-004 | CFB Loop v2.0.0 spread | spread | 3 | primary | 2771 | +0.548 | CLV>0 | 1 |
| 39 | E-004 | CFB Loop v2.0.0 spread | spread | 2 | sweep | 3837 | +0.447 | CLV>0 | 1 |
| 40 | E-004 | CFB Loop v2.0.0 spread | spread | 4 | sweep | 1892 | +0.606 | CLV>0 | 1 |
| 41 | E-004 | CFB Loop v2.0.0 spread | spread | 5 | sweep | 1223 | +0.666 | CLV>0 | 1 |
| 42 | E-004 | CFB Loop v2.0.0 spread | spread | 6 | sweep | 765 | +0.772 | CLV>0 | 1 |
| 43 | E-004 | CFB Loop v2.0.0 spread vs consensus close | spread | 3 | primary | 2647 | +0.519 | CLV>0 | 1 |
| 44 | E-005 | CFB Loop v2.0.0 total | total | 3 | primary | 2900 | +0.900 | CLV>0 | 1 |
| 45 | E-005 | CFB Loop v2.0.0 total | total | 2 | sweep | 3962 | +0.780 | CLV>0 | 1 |
| 46 | E-005 | CFB Loop v2.0.0 total | total | 4 | sweep | 2053 | +1.064 | CLV>0 | 1 |
| 47 | E-005 | CFB Loop v2.0.0 total | total | 5 | sweep | 1390 | +1.169 | CLV>0 | 1 |
| 48 | E-005 | CFB Loop v2.0.0 total | total | 6 | sweep | 871 | +1.204 | CLV>0 | 1 |
| 49 | E-006 | CFB Loop v2.0.0 spread ratings W-2 | spread | 3 | primary | 3230 | +0.250 | CLV>0 | 1 |
| 50 | E-006 | CFB Loop v2.0.0 spread ratings W-2 | spread | 2 | sweep | 4195 | +0.208 | CLV>0 | 1 |
| 51 | E-006 | CFB Loop v2.0.0 spread ratings W-2 | spread | 4 | sweep | 2420 | +0.276 | CLV>0 | 1 |
| 52 | E-006 | CFB Loop v2.0.0 spread ratings W-2 | spread | 5 | sweep | 1720 | +0.307 | CLV>0 | 1 |
| 53 | E-006 | CFB Loop v2.0.0 spread ratings W-2 | spread | 6 | sweep | 1184 | +0.291 | CLV>0 | 1 |
| 54 | E-006 | CFB Loop v2.0.0 total ratings W-2 | total | 3 | primary | 3204 | +0.713 | CLV>0 | 1 |
| 55 | E-006 | CFB Loop v2.0.0 total ratings W-2 | total | 2 | sweep | 4198 | +0.645 | CLV>0 | 1 |
| 56 | E-006 | CFB Loop v2.0.0 total ratings W-2 | total | 4 | sweep | 2334 | +0.790 | CLV>0 | 1 |
| 57 | E-006 | CFB Loop v2.0.0 total ratings W-2 | total | 5 | sweep | 1642 | +0.848 | CLV>0 | 1 |
| 58 | E-006 | CFB Loop v2.0.0 total ratings W-2 | total | 6 | sweep | 1130 | +0.936 | CLV>0 | 1 |
| 59 | E-101 | NFL residual base spread | spread | 0.25 | primary | 256 | -0.145 | no | 1 |
| 60 | E-101 | NFL residual base spread | spread | 0.5 | sweep | 17 | +0.235 | no | 1 |
| 61 | E-101 | NFL residual base spread | spread | 0.75 | sweep | 5 | +1.300 | no | 1 |
| 62 | E-111 | CFB residual base spread | spread | 0.25 | primary | 1897 | +0.238 | CLV>0 | 1 |
| 63 | E-111 | CFB residual base spread | spread | 0.5 | sweep | 246 | +0.268 | no | 1 |
| 64 | E-111 | CFB residual base spread | spread | 0.75 | sweep | 27 | +0.556 | no | 1 |
| 65 | E-102 | NFL residual base+qb spread | spread | 0.25 | primary | 308 | -0.175 | no | 1 |
| 66 | E-102 | NFL residual base+qb spread | spread | 0.5 | sweep | 29 | +0.138 | no | 1 |
| 67 | E-102 | NFL residual base+qb spread | spread | 0.75 | sweep | 13 | +0.038 | no | 1 |
| 68 | E-103 | NFL residual base+rest+travel spread | spread | 0.25 | primary | 341 | +0.015 | no | 1 |
| 69 | E-103 | NFL residual base+rest+travel spread | spread | 0.5 | sweep | 94 | -0.223 | no | 1 |
| 70 | E-103 | NFL residual base+rest+travel spread | spread | 0.75 | sweep | 16 | +0.281 | no | 1 |
| 71 | E-104 | NFL residual base+drift spread | spread | 0.25 | primary | 281 | -0.021 | no | 1 |
| 72 | E-104 | NFL residual base+drift spread | spread | 0.5 | sweep | 23 | +0.196 | no | 1 |
| 73 | E-104 | NFL residual base+drift spread | spread | 0.75 | sweep | 5 | +0.200 | no | 1 |
| 74 | E-105 | NFL residual base+market spread | spread | 0.25 | primary | 294 | +0.036 | no | 1 |
| 75 | E-105 | NFL residual base+market spread | spread | 0.5 | sweep | 29 | -0.017 | no | 1 |
| 76 | E-105 | NFL residual base+market spread | spread | 0.75 | sweep | 7 | +0.000 | no | 1 |
| 77 | E-112 | CFB residual base+rest spread | spread | 0.25 | primary | 2355 | +0.289 | CLV>0 | 1 |
| 78 | E-112 | CFB residual base+rest spread | spread | 0.5 | sweep | 637 | +0.454 | CLV>0 | 1 |
| 79 | E-112 | CFB residual base+rest spread | spread | 0.75 | sweep | 125 | +0.480 | CLV>0 | 1 |
| 80 | E-113 | CFB residual base+market spread | spread | 0.25 | primary | 2240 | +0.282 | CLV>0 | 1 |
| 81 | E-113 | CFB residual base+market spread | spread | 0.5 | sweep | 458 | +0.305 | CLV>0 | 1 |
| 82 | E-113 | CFB residual base+market spread | spread | 0.75 | sweep | 71 | +0.169 | no | 1 |
| 83 | E-120 | CFB residual base+rest x d spread | spread | 0.25 | primary | 2367 | +0.280 | CLV>0 | 1 |
| 84 | E-120 | CFB residual base+rest x d spread | spread | 0.5 | sweep | 677 | +0.453 | CLV>0 | 1 |
| 85 | E-120 | CFB residual base+rest x d spread | spread | 0.75 | sweep | 161 | +0.615 | CLV>0 | 1 |
| 86 | E-202 | CFB Loop W-2 non-power games | spread | 3 | primary | 1384 | +0.090 | no | 1 |
| 87 | E-202 | CFB Loop W-2 non-power games | spread | 2 | sweep | 1798 | +0.043 | no | 1 |
| 88 | E-202 | CFB Loop W-2 non-power games | spread | 5 | sweep | 778 | +0.129 | no | 1 |
| 89 | E-202-ref | CFB Loop W-2 power-involved games | spread | 3 | primary | 1846 | +0.370 | CLV>0 | 1 |
| 90 | E-203 | NFL v2.1.0 total, venue climatology | total | 2 | primary | 584 | +0.479 | CLV>0 | 1 |
| 91 | E-203 | NFL v2.1.0 total, venue climatology | total | 1 | sweep | 855 | +0.358 | CLV>0 | 1 |
| 92 | E-203 | NFL v2.1.0 total, venue climatology | total | 3 | sweep | 399 | +0.596 | CLV>0 | 1 |
| 93 | E-201-ref | NFL Loop backup-QB games, Tuesday starters, Friday line | spread | 2 | primary | 42 | +0.012 | no | 1 |
| 94 | E-201 | NFL Loop backup-QB games, Friday starters, Friday line | spread | 2 | primary | 35 | +0.214 | no | 1 |
| 95 | E-201 | NFL Loop backup-QB games, Friday starters, Friday line | spread | 1 | sweep | 52 | +0.019 | no | 1 |
| 96 | E-201 | NFL Loop backup-QB games, Friday starters, Friday line | spread | 3 | sweep | 25 | +0.100 | no | 1 |
| 97 | H-1 | NFL v2.1.0 spread (holdout) | spread | 2 | primary | 138 | +0.319 | CLV>0 | 1 |
| 98 | H-2 | NFL Loop v2.0.0 spread (holdout) | spread | 2 | primary | 142 | +0.229 | no | 1 |
| 99 | H-3 | NFL v2.1.0 total (holdout) | total | 2 | primary | 114 | +0.504 | CLV>0 | 1 |
| 100 | H-4 | CFB Loop v2.0.0 W-2 spread (holdout) | spread | 3 | primary | 460 | +0.259 | CLV>0 | 1 |
| 101 | H-5 | CFB Loop v2.0.0 W-2 total (holdout) | total | 3 | primary | 426 | +0.418 | CLV>0 | 1 |

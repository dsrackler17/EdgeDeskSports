# Experiments — finding closing-line value at the early line

Every experiment is written here **before** it is run: hypothesis, the exact change,
and the pass threshold. The result is added afterwards, pass or fail, without editing
anything above the `Result` line. Data and its gaps: [DATA_AUDIT.md](DATA_AUDIT.md).
Code: `model_loop/clv/`. Raw scorecards: `docs/model-loop/clv/results/`.

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
**Holdout: 2025 and 2026-to-date, locked** — `model_loop/clv/run.py` refuses to score a season
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
  `model_loop/clv/js/replay_nfl_v21.js`.
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
  (`model_loop/clv/js/replay_cfb_p4_weekstart.js`). The engine has no QB or weather input.
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

---

## Variant ledger

| # | experiment | model | market | threshold | checkpoint | window | result |
|---|---|---|---|---|---|---|---|

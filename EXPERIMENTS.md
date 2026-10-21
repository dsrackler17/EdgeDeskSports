# CLV experiments: pre-registrations and results

**The rule of this file.** Each experiment's hypothesis, exact change and pass threshold are committed here BEFORE it is run. Results are appended under the same ID afterwards, and pass or fail is never edited after a result is seen. Every run is also appended mechanically to `research/clv/results/attempts.jsonl` by the runner, which refuses to run an ID that is not pre-registered in this file. Counts per sport come from that log.

## Global protocol (written 2026-10-21, before any CLV number was computed)

### G1. The metric
- **Bet rule.** Bet the side the model prefers against the OPENING line when |model − opener| ≥ the threshold.
- **Headline metric:** mean `clv_prob`, the no-vig probability the bet gained from open to close, computed by `model_loop/clv/harness.py`.
  - Spread and total sports also report mean `clv_pts`.
  - Moneyline sports report probability only.
- **Secondary metrics:**
  - `clv_ev`, the expected return of the opening bet at closing fair prices;
  - line-direction hit rate;
  - edge buckets, per-season tables, and the results diagnostic (win % and ROI at the opening price).
- MAE and log loss against the final score are diagnostics only.

### G2. Lines
- **CFB:** the opener books' own open and close (same-book move; see `DATA_AUDIT.md`). Consensus and Pinnacle closes are secondary.
- **NFL, NBA, NHL, MLB:** the SBR archive (open and close from SBR's reference book).
- **NBA 2026, WNBA, NCAAM:** ESPN DraftKings open and close.
- **2026 football:** EdgeDesk's own first-seen open and last close.
- Hygiene drops per `DATA_AUDIT.md`. No number is imputed.
- With no prices in the source, both sides are taken at -110.

### G3. Points to probability
A distribution fitted on PRE-holdout seasons only, never refitted on holdout data:
- NFL spread: `KeyNumberMargin.fit` (key numbers) on nflverse closes vs margins 2006–2019.
- Every other points market: a discretised normal with σ = SD(final − close) over that sport's pre-holdout seasons.

### G4. Holdout locks (rule 2)

These seasons are not read for any model fit, tuning, threshold or selection until that sport's Phase 6 entry is written here.

| Sport | Mandated holdout (most recent completed season + current to date) | Proxy holdout, also locked: the mandated one has no or too few openers | Walk-forward seasons with openers |
|---|---|---|---|
| CFB | 2025, 2026 | none | 2012–2019, 2021–2024 |
| NFL | 2025, 2026 | SBR 2020–2021 | SBR 2011–2019 |
| NBA (repo end-year labels) | 2026, 2027 | none | SBR 2012–2022 (repo labels) |
| NHL (repo end-year labels) | 2026, 2027 | repo 2021–2022 (SBR 2020–2021) | repo 2014–2020 (model predictions start 2014) |
| MLB | 2025, 2026 | SBR 2020–2021 | SBR 2011–2019 |
| WNBA | 2025, 2026 | none | none |
| NCAAM (repo end-year labels) | 2026, 2027 | none | none |

- A proxy holdout is the last two seasons of the opener archive. It is used for the Phase 6 gate only where the mandated holdout has no openers.
- Any mandated-holdout data that does exist is reported beside it and never gates.

### G5. Walk-forward
- **Base models.** The committed walk-forward predictions are each fitted only on games before the week being priced. Where a base model's backtest used information not known at the opener, it is re-run with the opener-time substitute (per `DATA_AUDIT.md`), or reported as INADMISSIBLE and not used.
- **Residual models.** Fitted per season on strictly earlier walk-forward seasons, with at least 3 of them; ridge λ chosen from {0.1, 1, 10, 100} by an inner walk-forward on those same earlier seasons (`model_loop/clv/residual.py`). The first evaluable season is therefore the 4th walk-forward season.
- **Paired comparisons.** A residual model is always compared with its base models on the same games and seasons.

### G6. Thresholds (primary, fixed now)

| Market | Base model: \|model − open\| ≥ | Residual model: \|predicted move\| ≥ |
|---|---|---|
| CFB spread / total | 2.0 / 2.0 pts | 0.25 / 0.25 pts |
| NFL spread / total | 1.0 / 1.5 pts | 0.25 / 0.25 pts |
| NBA spread / total | 1.0 / 2.0 pts | 0.25 / 0.25 pts |
| NCAAM, WNBA spread / total | 1.5 / 2.0 pts | (no residual: infeasible) |
| Moneyline (NHL, MLB, NBA, CBB, WNBA) | 0.02 no-vig prob | 0.005 no-vig prob |

- Other thresholds and buckets are descriptive. They are never used to select a candidate.
- **Clusters for the bootstrap:** football (season, week); every other sport the game date (US Eastern).

### G7. Counting and the multiple-testing penalty
- Every pre-registered experiment ID run at its primary threshold is ONE attempt for its sport, pass or fail. That includes base-model baselines, residual models, weak-spot tests and every holdout run.
- **k_sport** is that count when the final verdict is written.
- **Final verdict:**
  - one-sided lower bound of mean `clv_prob` at α = 0.05 / k_sport (cluster bootstrap) above zero;
  - and, for points markets, mean `clv_pts` > 0;
  - and at least 50 bets.

### G8. Phase 6 selection and gate
- **What goes to the holdout, per sport:**
  - the production model on every market where the holdout has data (the reference);
  - plus at most ONE challenger per market. The challenger is the pre-holdout variant with the highest walk-forward mean `clv_prob` among those with n ≥ 100 bets and one-sided p < 0.05 (unadjusted) on pre-holdout data.
- The choice and the pass rule are written here before the holdout is read; the holdout is read once.
- **PASS = the G7 verdict on the holdout.** Fewer than 50 holdout bets is INCONCLUSIVE, not a pass.

### G9. Production is untouched
- Nothing in this programme writes to a live slate, params file or `current` pointer.
- A passing candidate is registered as a live-tracking (shadow) entry in the sport's existing version history, with status `CANDIDATE (CLV live tracking)`. It is never `SERVED`.

---

## CFB

Base-model predictions:

| Model | Source | Status at the opener |
|---|---|---|
| production `edgedesk_cfb_p4_v1.0.1` | `model_loop/adapters/cfb/baselines/cfb_p4_replay_predictions.csv.gz`, cold walk-forward replay | **Caveat:** its few trained coefficients were fitted on 2001–2025 outcomes (the file's own header says so). Only 2026 is fully out of sample for it |
| model_loop CFB `2.0.0` | re-run by `research/clv/cfb.py` | QB input replaced by each team's previous-game starter (`DATA_AUDIT.md`) |
| shadow `cfb_v2_candidate_001`, `ens_equal` | `football/cfb_v2/candidates/cfb_v2_candidate_001/predictions.csv.gz` | Frozen Tuesday 12:00 UTC from games already played; no QB or injury input (`football/cfb_v2/research/v2/leakage_audit.py`). The stacked `ens_pred` is not used: its weights were fitted on 2016–2023 |

**Lines:** same-book open and close.
**Seasons:** walk-forward 2012–2019 and 2021–2024 where a model has predictions. The holdout is 2025 + 2026.

### CFB-B1: production cfb_p4 v1.0.1, spread (Phase 3 baseline)
- **Hypothesis:** the production fair spread bet against the opener (|fair − open| ≥ 2.0) earns positive mean CLV.
- **Change:** none (baseline).
- **Pass (pre-holdout, for G8 eligibility):** mean `clv_prob` > 0 with one-sided p < 0.05 and n ≥ 100.

### CFB-B2: production cfb_p4 v1.0.1, total (Phase 3 baseline)
- **Hypothesis:** same rule as B1 for `fair_total` against the opening total, at threshold 2.0.
- **Pass:** as B1.

### CFB-B3: model_loop CFB 2.0.0 with previous-game QB, spread (Phase 3 baseline)
- **Hypothesis:** the loop's v2 margin, with the QB input replaced by each team's previous-game starter, earns positive CLV at threshold 2.0.
- **Change:** v2 as served, with QB = previous starter.
- **Pass:** as B1.

### CFB-B4: model_loop CFB 2.0.0 with previous-game QB, total (Phase 3 baseline)
- **Hypothesis:** as B3, for `pred_total`, at threshold 2.0.
- **Pass:** as B1.

### CFB-B5: shadow cfb_v2_candidate_001 `ens_equal`, spread (Phase 3 baseline, existing candidate)
- **Hypothesis:** at threshold 2.0, positive CLV.
- **Pass:** as B1.

### CFB-R1: market-residual model, spread (Phase 4)
- **Hypothesis:** a ridge model of the same-book move (close − open) on the base models' disagreements with the opener predicts the move. Betting |predicted move| ≥ 0.25 earns positive CLV.
- **Inputs:** `d_p4 = p4 − open` and `d_v2 = v2(prev QB) − open`. Missing `d_v2` makes the row unusable. No other input.
- **Fit:** G5. The first evaluable season is the 4th walk-forward season with both inputs.
- **Pass:** as B1. Also reported: the movement-calibration slope.

### CFB-R2: residual model plus an information block, spread (Phase 4, one change from R1)
- **Change:** add four inputs, as one block, to R1:
  - `open_line` (favourite drift);
  - `d_p4 × early`, where early = week ≤ 4;
  - `d_p4 × nonpower`, where nonpower = neither team in a Power conference (ACC, Big Ten, Big 12, SEC, Pac-12 through 2023, plus Notre Dame);
  - `d_p4 × fcs`, where an FCS team is involved.
- **Pass:** as B1, AND better than R1 on mean `clv_prob` on the same games (paired), else R1 stays the simpler model.

### CFB-W1: non-Power games (Phase 5)
- **Hypothesis:** openers are softer where fewer bettors look. The residual model R1 earns more CLV on games where neither team is a Power team.
- **Change:** R1's bets restricted to nonpower games.
- **Pass:** mean `clv_prob` > 0 with one-sided p < 0.05 and n ≥ 100.

### CFB-W2: early-week lines (Phase 5): not run
- Every opener in the archive IS the early-week line, so every experiment above is already an early-week test.
- No intra-week timestamps exist before 2026, and 2026 is holdout.
- Not counted as an attempt.

### CFB-W3: totals residual (Phase 5)
- **Hypothesis:** a ridge model of the same-book total move on `dt_p4 = p4_total − open_total` and `dt_v2 = v2_total − open_total` earns positive CLV at |predicted move| ≥ 0.25.
- **Pass:** as B1.

---

## NFL

Pre-registered 2026-10-21, before any NFL CLV number was computed.

**Base models, re-run with opener-time inputs (`DATA_AUDIT.md`).** Every committed NFL backtest prices the QB who actually started and the game-day temperature and wind. These replays change only those inputs, in training and prediction alike:
- each side's QB = that franchise's previous-game starter;
- temperature and wind = the model's own missing-value defaults.

| Model | Replay |
|---|---|
| production `edgedesk_nfl_v2.1.0` | `research/clv/nfl_v2_opener.js`. It reads the unmodified `football/research/nfl_v2/backtest.js` and `football/nfl_model.js`. A reproduction run with actual inputs is checked against the committed `results/oos_v2.csv.gz` first |
| model_loop NFL `2.0.0` | `research/clv/nfl.py loop_opener` |

**Not tested: legacy v1 (`edgedesk_football_v1.0.0`).** It was superseded on the board on 2026-10-21, and its committed replay uses actual starters. Testing it would add a variant to the family without informing any decision.

**Lines:** SBR open and close, joined to nflverse games by franchise and date (±3 days) with the final score required to match. Graded at -110.

**Seasons:**
- Walk-forward: 2011–2019.
- Proxy holdout: 2020–2021.
- Mandated holdout: 2025–2026. Only 2026 has openers (`football/pricing/openers_nfl.json`), reported only.

**Points-to-probability:**
- Spread: `KeyNumberMargin.fit` on nflverse closing spreads vs margins, 2006–2019.
- Totals: IntegerNormal(σ = SD(total − close total), 2011–2019).

### NFL-B1: production v2.1.0 (opener inputs), spread (Phase 3)
- **Hypothesis:** at |model − open| ≥ 1.0, positive mean CLV.
- **Pass (G8 eligibility):** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 100.

### NFL-B2: production v2.1.0 (opener inputs), total (Phase 3)
- At |model − open total| ≥ 1.5. Pass as B1.

### NFL-B3: model_loop NFL 2.0.0 (opener inputs), spread (Phase 3)
- At 1.0. Pass as B1.

### NFL-B4: model_loop NFL 2.0.0 (opener inputs), total (Phase 3)
- At 1.5. Pass as B1.

### NFL-R1: market-residual model, spread (Phase 4)
- **Model:** ridge of the SBR move (close − open) on `d_v21 = v21 − open` and `d_loop = loop − open`, walk-forward (G5).
- **Window:** the first evaluable season is 2014.
- **Bet rule:** |predicted move| ≥ 0.25.
- **Pass:** as B1. The movement-calibration slope is reported.

### NFL-R2: R1 plus an information block, spread (Phase 4, one change)
- **Change:** add, as one block:
  - `open_line`;
  - `d_v21 × early` (week ≤ 4);
  - `rest_diff` (home rest − away rest, days, from the schedule);
  - `backup_diff`. A side's backup flag is 1 when its previous-game starter is not its regular starter (the QB with the most starts in the franchise's previous 8 games). `backup_diff` = home flag − away flag.
- **Pass:** as B1, AND a higher mean `clv_prob` than R1 on the same games.

### NFL-W1: backup-QB games (Phase 5)
- **Hypothesis:** the opener mis-prices games where a backup is the expected starter (backup flag, as in R2, on either side). The production model, which carries a starter-out feature, earns positive CLV there.
- **Change:** B1's bets restricted to backup games.
- **Pass:** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 50 (backup games are rare).

### NFL-W2: totals residual (Phase 5)
- **Model:** ridge of the total move on `dt_v21` and `dt_loop`.
- **Bet rule:** |predicted move| ≥ 0.25.
- **Pass:** as B1.

### NFL-W3: first half: not run
- No first-half line exists in any archive here.
- Not counted as an attempt.

### CFB pre-holdout results

Run 2026-10-21 on 2012–2019 and 2021–2024 by `python3 -m research.clv.cfb pre`. Full reports are in `research/clv/results/cfb/`.

**Reading the columns:**
- CLV figures are means with cluster-bootstrap 95% intervals (clusters = season-week).
- pp = percentage points of no-vig probability.
- "toward" = the share of moved lines that moved toward the bet.
- `clv_ev` = the expected return of the opening bet at -110, priced at the closing no-vig probability.

**Model notes:**
- The loop model (B3, B4, and the d_v2 input) is v2.0.0 re-run with each team's previous-game QB.
  - 5,945 of 16,181 games had a starter different from the previous game's.
  - The same pipeline, run without the substitution, reproduces the committed `docs/model-loop/cfb/predictions.csv.gz` to a mean of 0.001 points.
- The production replay (B1, B2) and the loop's hyperparameters were fitted on final scores of seasons inside this window (`DATA_AUDIT.md`). They are not fitted on line moves.

| ID | Model | Bets | CLV pts | CLV prob (pp) | p | Toward | `clv_ev` at -110 | Verdict (pre-holdout rule) |
|---|---|---|---|---|---|---|---|---|
| CFB-B1 | production cfb_p4, spread, ≥2.0 | 6,363 | +0.286 [+0.222, +0.348] | +0.72 [+0.56, +0.88] | <1e-4 | 0.541 | -3.1% | PASS |
| CFB-B2 | production cfb_p4, total, ≥2.0 | 5,250 | +0.038 [-0.069, +0.148] | +0.07 [-0.19, +0.33] | 0.30 | 0.492 | -4.4% | **FAIL** |
| CFB-B3 | loop v2 (prev QB), spread, ≥2.0 | 5,852 | +0.477 [+0.397, +0.560] | +1.20 [+1.00, +1.41] | <1e-4 | 0.585 | -2.2% | PASS |
| CFB-B4 | loop v2 (prev QB), total, ≥2.0 | 5,983 | +0.704 [+0.598, +0.819] | +1.69 [+1.44, +1.97] | <1e-4 | 0.624 | -1.3% | PASS |
| CFB-B5 | shadow cfb_v2 cand. 001, spread, ≥2.0 | 4,701 | +0.469 [+0.377, +0.563] | +1.19 [+0.96, +1.42] | <1e-4 | 0.585 | -2.3% | PASS |
| CFB-R1 | residual (d_p4, d_v2), spread, ≥0.25 | 4,024 | +0.503 [+0.408, +0.599] | +1.27 [+1.03, +1.51] | <1e-4 | 0.589 | -2.1% | PASS (move slope 0.88) |
| CFB-R2 | R1 + information block, spread, ≥0.25 | 4,810 | +0.569 [+0.484, +0.653] | +1.44 [+1.23, +1.65] | <1e-4 | 0.612 | -1.8% | PASS. Beats R1 on the same 7,237 games: per-bet +1.44 vs +1.27 pp; per-game +0.25 pp (move slope 0.93) |
| CFB-W1 | R1 on non-Power games only | 1,742 | +0.450 [+0.322, +0.578] | +1.13 [+0.81, +1.46] | <1e-4 | 0.577 | – | PASS on its rule. The hypothesis (MORE CLV on non-Power games) is **not supported**: +1.13 pp vs R1's +1.27 overall |
| CFB-W3 | totals residual (dt_p4, dt_v2), ≥0.25 | 5,203 | +0.856 [+0.742, +0.975] | +2.07 [+1.80, +2.36] | <1e-4 | 0.656 | -0.6% | PASS (move slope 0.90) |

**Every season, for the spread models B3, B5, R1 and R2:**
- The mean CLV is positive in every season.
- It is smaller in the US-retail opener era (2021–24, Bovada / DraftKings / ESPN Bet) than in the 5Dimes era (2012–19). For example, R2 averages +1.85 pp in 2015–19 and +0.94 pp in 2021–24.

**The production total (B2) has no CLV:**
- 2012–17 is positive.
- 2018–23 is negative.

**Honest reading on the vig.** Every pre-registered rule beats the close, but none at its primary threshold beats the close by more than the -110 vig (2.4 pp), so `clv_ev` < 0.
- Only the largest-edge buckets reach `clv_ev` > 0: R1/R2 |move| ≥ 1.0 (+1.0% / +0.8%), W3 ≥ 1.0 (+1.6%), B4 ≥ 8 (+2.6%).
- Those buckets are descriptive. They were not pre-registered and are not selected on.

**CFB pre-holdout attempt count: 9** (B1–B5, R1, R2, W1, W3). W2 was not run.

### CFB-H: Phase 6 selection (written before the holdout was read)

**Candidates (G8):**

| ID | Candidate | Bet rule |
|---|---|---|
| CFB-H1 | production cfb_p4, spread (reference) | ≥2.0 |
| CFB-H2 | production cfb_p4, total (reference) | ≥2.0 |
| CFB-H3 | spread challenger = **CFB-R2**, the highest eligible pre-holdout mean `clv_prob` (+1.44 pp vs R1 +1.27, B3 +1.20, B5 +1.19) | ≥0.25 |
| CFB-H4 | total challenger = **CFB-W3** (+2.07 pp vs B4 +1.69) | ≥0.25 |

**Residual-model fit:** frozen on every pre-holdout season (2012–2019, 2021–2024), with λ by the inner walk-forward on those seasons. One fit, applied unchanged to every holdout game. Nothing is refitted on 2025.

**Holdout lines:**
- **2025:** cfbfastR, the opener books' (Bovada, DraftKings, ESPN Bet) median open and same-book close.
- **2026:** `football/cfb_lab/ledger/2026/lines.jsonl`.
  - OPEN = first DraftKings quote observed (quality OBSERVED).
  - CLOSE = quality OBSERVED or PROVIDER_DECLARED.
  - Graded at -110, like every CFB line.
- Pooled for the gate; reported per season.

**k_sport for the verdict = 13** (9 pre-holdout + 4 holdout runs). PASS (G7) requires all three:
- the one-sided lower bound of mean `clv_prob` at α = 0.05/13 above 0;
- mean `clv_pts` > 0;
- n ≥ 50.

`clv_ev` is reported but does not gate.

**Run once:** `python3 -m research.clv.cfb holdout`.

### CFB-H1: production cfb_p4 spread on the holdout
### CFB-H2: production cfb_p4 total on the holdout
### CFB-H3: CFB-R2 (frozen fit) spread on the holdout
### CFB-H4: CFB-W3 (frozen fit) total on the holdout

### CFB-D1: diagnostic. How much of the totals residual's CLV is constant drift? (registered after the holdout)

**Why added.** The frozen totals residual (H4) has an intercept of -0.61 points. On average, CFB totals fall from open to close, so a rule with no model would bet every under. D1 measures that rule alone.

**Rule.** Predicted move = the mean move of all earlier walk-forward seasons (an intercept-only walk-forward ridge). Bet when |predicted move| ≥ 0.25.

**Where it is evaluated.**
- Pre-holdout: walk-forward.
- Holdout: frozen, exactly as H4. The holdout is already unlocked.

**Reading.** Counted as an attempt. It cannot become a candidate: it is market structure, not a model.

### CFB-D2: diagnostic. The same intercept-only rule for spreads (registered after the holdout)

**Rule.** As D1, for the spread move (H3's intercept is -0.13).

### CFB holdout results (run once, 2026-10-21)

**k = 13 at the gate.** With D1 and D2, the CFB family is now **15 attempts**. FINAL_REPORT.md re-applies the verdict at k = 15.

| ID | Bets | CLV pts | CLV prob (pp) | α/13 one-sided LB | 2025 | 2026 | `clv_ev` at -110 | Verdict |
|---|---|---|---|---|---|---|---|---|
| CFB-H1 production cfb_p4 spread ≥2.0 | 795 | +0.475 [+0.271, +0.688] | +1.19 [+0.66, +1.73] | +0.53 | n=633, +1.21 | n=162, +1.07 | -2.3% [-3.3, -1.2] | **PASS** |
| CFB-H2 production cfb_p4 total ≥2.0 | 590 | +0.415 [+0.202, +0.632] | +0.99 [+0.50, +1.50] | +0.23 | n=477, +1.02 | n=113, +0.87 | -2.6% | **PASS** (failed pre-holdout: +0.07 pp, p = 0.30) |
| CFB-H3 R2 frozen, spread ≥0.25 | 751 | +0.761 [+0.558, +0.953] | +1.91 [+1.39, +2.40] | +1.19 | n=604, +2.10 | n=147, +1.13 | -0.9% [-1.9, +0.04] | **PASS** |
| CFB-H4 W3 frozen, total ≥0.25 | 757 | +0.616 [+0.432, +0.783] | +1.48 [+1.03, +1.89] | +0.88 | n=597, +1.50 | n=160, +1.41 | -1.7% | **PASS** |

**Frozen fits:**
- **R2** (λ = 10, trained on 9,520 games):
  - move = -0.133 + 0.099·d_p4 + 0.101·d_v2 + 0.021·open − 0.069·d_p4·early + 0.003·d_p4·nonpower − 0.029·d_p4·fcs.
  - The market moved about 10% of each model's disagreement toward it, and less early in the season.
  - Holdout movement-calibration slope: 1.35.
- **W3** (λ = 0.1): move = -0.606 − 0.065·dt_p4 + 0.248·dt_v2. Holdout slope: 0.66.

**Caveats:**
- The production replay's coefficients were fitted on 2001–2025 outcomes, so its 2025 holdout is not fully out of sample. Its 2026 numbers are: spread +1.07 pp (n = 162) and total +0.87 pp (n = 113).
- 2026 openers are DraftKings first-seen quotes, not book openers.
- Diagnostics (results at the opening price, not CLV):
  - H3: 52.3% ATS, ROI -0.2%.
  - H4: 53.7%, ROI +2.4%.

### CFB-D1 / D2 results (diagnostic)
- The constant drift is -0.14 pts for totals and +0.08 for spreads pre-holdout, and -0.21 / +0.01 on the frozen holdout.
- Both are below the 0.25 bet threshold, so 0 bets.
- **The residual models' CLV is not a constant "bet the under / the away side early" effect.**

### NFL pre-holdout results

Run 2026-10-21 on SBR 2011–2019 (2,393 games) by `python3 -m research.clv.nfl pre`. Reports are in `research/clv/results/nfl/`.

**Line quality check.** SBR closes agree with the nflverse consensus close within 1 point on 96.6% of 2,946 joined games (mean |diff| 0.30).

**Opener-time replays:**
- **v2.1.0:** the replay with actual inputs reproduces the committed `oos_v2.csv.gz` exactly (5,524 games, max |diff| 0.0). With opener-time inputs it moves a mean of 0.76 pts; 1,381 rows have a different QB input.
- **Loop:** opener inputs move it a mean of 0.64 pts.

| ID | Rule | Bets | CLV pts | CLV prob (pp) | p | Toward | `clv_ev` at -110 | Verdict |
|---|---|---|---|---|---|---|---|---|
| NFL-B1 | production v2.1.0, spread, ≥1.0 | 1,640 | +0.414 [+0.324, +0.506] | +1.39 [+1.07, +1.70] | <1e-4 | 0.645 | -1.8% | PASS |
| NFL-B2 | production v2.1.0, total, ≥1.5 | 1,533 | +0.687 [+0.587, +0.788] | +2.08 [+1.77, +2.38] | <1e-4 | 0.669 | -0.6% | PASS |
| NFL-B3 | loop 2.0.0, spread, ≥1.0 | 1,649 | +0.247 [+0.163, +0.331] | +0.78 [+0.50, +1.06] | <1e-4 | 0.586 | -3.0% | PASS |
| NFL-B4 | loop 2.0.0, total, ≥1.5 | 1,282 | +0.746 [+0.637, +0.851] | +2.26 [+1.93, +2.57] | <1e-4 | 0.678 | -0.2% | PASS |
| NFL-R1 | residual (d_v21, d_loop), spread, ≥0.25 | 746 | +0.556 [+0.413, +0.692] | +1.96 [+1.46, +2.43] | <1e-4 | 0.677 | -0.8% | PASS (move slope 1.22) |
| NFL-R2 | R1 + information block | 761 | +0.498 [+0.353, +0.640] | +1.74 [+1.25, +2.22] | <1e-4 | 0.663 | -1.2% | **FAIL**: on the same 1,595 games R2 bets +1.74 pp vs R1 +1.96 pp. The block does not help |
| NFL-W1 | B1 on backup-QB games only | 509 | +0.419 [+0.281, +0.563] | +1.54 [+1.06, +2.04] | <1e-4 | 0.645 | -1.6% | PASS. Slightly above B1 overall (+1.39), so weak support for the hypothesis |
| NFL-W2 | totals residual (dt_v21, dt_loop), ≥0.25 | 1,100 | +0.840 [+0.724, +0.948] | +2.54 [+2.19, +2.87] | <1e-4 | 0.698 | **+0.3%** | PASS (move slope 1.01) |

**Every season of 2011–2019 is positive for every rule.**

**Caveat.** v2.1.0's round-2 choices were selected on the 2010–2024 validation window (`football/research/nfl_v2/RESULTS.md`), and the loop's tuning used 2011–2019. Both selected on final scores, not line moves. So the base models carry in-sample hyperparameter choices over these seasons and over the proxy holdout. 2026 is the only fully out-of-sample season.

**NFL pre-holdout attempt count: 8.** W3 (first half) was not run.

### NFL-H: Phase 6 selection (written before the holdout was read)

**Candidates (G8):**

| ID | Candidate | Bet rule |
|---|---|---|
| NFL-H1 | production v2.1.0, spread (reference) | ≥1.0 |
| NFL-H2 | production v2.1.0, total (reference) | ≥1.5 |
| NFL-H3 | spread challenger = **NFL-R1** (+1.96 pp; R2 failed its pre-registered comparison) | ≥0.25 |
| NFL-H4 | total challenger = **NFL-W2** (+2.54 pp) | ≥0.25 |

**Residual fits:** frozen on SBR 2011–2019, λ by the inner walk-forward, applied unchanged.

**Gate.**
- The gate data is the **proxy holdout, SBR 2020–2021**.
- 2026 (`football/pricing/openers_nfl.json`: first-seen consensus open, consensus close) is reported beside it and does not gate. It is the only fully out-of-sample NFL data, so it is printed with every verdict.
- **k = 12** (8 + 4). PASS per G7.

### NFL-H1: production v2.1.0 spread on the proxy holdout (as selected above)
### NFL-H2: production v2.1.0 total on the proxy holdout (as selected above)
### NFL-H3: NFL-R1 frozen, spread, on the proxy holdout (as selected above)
### NFL-H4: NFL-W2 frozen, total, on the proxy holdout (as selected above)

### NFL holdout results (run once, 2026-10-21)

**k = 12.**
- **Gate data:** proxy holdout SBR 2020–2021.
- **2026 (reported only):** first-seen consensus open (a median 11 days before kickoff) to consensus close, 77 games.

| ID | Proxy bets | Proxy CLV pts | Proxy CLV prob (pp) | α/12 LB | 2020 / 2021 | Proxy `clv_ev` | 2026 (out of sample) | Verdict |
|---|---|---|---|---|---|---|---|---|
| NFL-H1 production v2.1.0, spread ≥1.0 | 384 | +0.578 [+0.272, +0.900] | +1.79 [+0.81, +2.80] | +0.48 | +1.24 / +2.35 | -1.1% [-3.0, +0.7] | n=52: +0.71 pts, +2.16 pp [+0.77, +4.96] | **PASS** |
| NFL-H2 production v2.1.0, total ≥1.5 | 422 | +0.995 [+0.746, +1.266] | +2.97 [+2.23, +3.77] | +1.98 | +2.67 / +3.31 | **+1.1%** [-0.3, +2.6] | n=48: +0.96 pts, +2.83 pp [+1.09, +4.80] | **PASS** |
| NFL-H3 R1 frozen, spread ≥0.25 | 290 | +0.898 [+0.571, +1.251] | +2.94 [+1.92, +4.02] | +1.53 | +2.67 / +3.20 | **+1.0%** [-0.9, +3.0] | n=37: +1.00 pts, +3.44 pp [+1.04, +6.34] | **PASS** |
| NFL-H4 W2 frozen, total ≥0.25 | 448 | +1.162 [+0.911, +1.439] | +3.48 [+2.74, +4.30] | +2.48 | +3.43 / +3.52 | **+2.1%** [+0.7, +3.6] | n=54: +0.98 pts, +2.91 pp [+1.10, +4.93] | **PASS** |

**Frozen fits:**
- R1: move = -0.125 + 0.135·d_v21 + 0.024·d_loop (λ = 0.1).
- W2: move = -0.053 + 0.142·dt_v21 + 0.201·dt_loop.

**What it shows.** The NFL market moved about 13–14% of production v2.1.0's disagreement toward it. The loop adds a little on spreads and a lot on totals.

**Results diagnostic** (win rate at the opening price; noisy at these n):
- Proxy: H1 48.0%, H2 53.4%, H3 52.1%, H4 54.0%.
- 2026: 49.0%, 47.9%, 50.0%, 46.3%.

**Caveats:**
- Proxy-holdout seasons sit inside the hyperparameter-selection windows of both base models (final scores, not line moves).
- 2026 openers are early lookahead consensus numbers, not a book's opener.

---

## NBA

Pre-registered 2026-10-21, before any NBA CLV number was computed.

**Base models (predictions regenerated read-only into `.cache/clv/`):**

| Model | Role | How it is replayed |
|---|---|---|
| `edgedesk_nba_v1:G_stack_P` | production `nba/` engine; prices the NBA panel and slate | Projected availability = the previous game's rotation, knowable at the open. Replayed by importing `nba/model/walkforward.js` `run()` in `research/clv/nba_prod.js`, after `npm run nba:backfill` into `.cache`. The backfill's rewrites of committed `nba/data` files are restored afterwards. **Reproduction check:** the replay's selection-window moneyline log loss must equal the committed `nba/validation/nba_walkforward.json` value within 1e-4. **Fallback:** if it cannot be produced or reproduced, NBA-B1, B2 and W1 are recorded INFEASIBLE (not counted), and R1 and W3 use the lab model's disagreement only |
| `edgedesk_bb_points_v1` (`points_rest`) | basketball lab model; served by the model loop and named in `engine/registry.json` | `research/clv/bb_predict.js`. Each game is predicted at 09:00 UTC on its date (before any same-day result). Reproduction at tip − 30 min equals the committed confirmation log loss: 0.62234, n = 11,546 |

**Reading the production model's sealed test window.** The `nba/` engine's test window (2018+) was already unsealed twice (`nba/validation/holdout_log.json`). Reading its predictions for the CLV test is recorded in that log (scope `clv`). Nothing in the engine's choice depends on it.

**Lines:**
- **SBR spread and total open/close, repo seasons 2012–2022.** The NBA archive keeps the moneyline close only, so no moneyline experiment can run before the holdout. Teams are joined by date (±1 day), id and final score.
- **Holdout:** repo 2026 (ESPN DraftKings open/close, with prices) plus 2027 to date.

**Settings:**
- Clusters: game date.
- σ (spread, total): from SBR 2012–2022.
- First evaluable residual season: 2015.

### NBA-B1: production G_stack_P, spread (Phase 3)
- At ≥1.0. Pass: mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 100.

### NBA-B2: production G_stack_P, total (Phase 3)
- At ≥2.0. Pass as B1.

### NBA-B3: lab points_rest, spread (Phase 3)
- At ≥1.0. Pass as B1.

### NBA-B4: lab points_rest, total (Phase 3)
- At ≥2.0. Pass as B1.

### NBA-R1: residual ridge on d_prod and d_lab, spread (Phase 4)
- At ≥0.25. Pass as B1.

### NBA-R2: R1 plus an information block, spread (Phase 4, one change)
- **Change:** add, as one block:
  - `open_line`;
  - `b2b_diff` (home on a back-to-back − away, from the schedule);
  - `d_lab × early` (early = either team has played fewer than 15 games that season).
- **Pass:** as B1, AND a higher mean `clv_prob` than R1 on the same games.

### NBA-W1: projected star absences (Phase 5)
- **Hypothesis:** where the production model's projected-availability adjustment differs from the healthy-roster rating by ≥ 2 pts net between the teams, the opener under-prices the absence. Production's bets there earn positive CLV.
- **Change:** B1's bets restricted to those games.
- **Pass:** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 50.
- Late scratches are untestable: no injury timestamps exist.

### NBA-W2: rest and back-to-backs (Phase 5)
- **Hypothesis:** R1 earns positive CLV on games where exactly one team is on a back-to-back.
- **Change:** R1's bets restricted to those games.
- **Pass:** as W1.

### NBA-W3: totals residual (Phase 5)
- **Model:** ridge of the total move on `dt_prod` and `dt_lab`.
- **Bet rule:** ≥0.25.
- **Pass:** as B1.

### NBA-W4: early season (Phase 5)
- **Hypothesis:** before ratings stabilise (either team under 15 games), the lab model's disagreement still earns positive CLV.
- **Change:** B3's bets restricted to early games.
- **Pass:** as W1.

---

## NHL

Pre-registered 2026-10-21, before any NHL CLV number was computed.

**Base models.** Per-game walk-forward predictions come from `hockey/model/walkforward.js`, run unmodified in a scratch git worktree so that none of its writes touch this tree. That includes `hockey/model/params/live.json`, which it rewrites.
- **Reproduction:** `xg_core` confirmation log loss 0.66286, equal to the committed record.
- **Timing:** every game on date D is predicted from games before D only.

| Model | Role | Admissible at the opener? |
|---|---|---|
| `xg_core` | production (`hockey/model/params/live.json`); no goalie term | yes |
| `xg_goalie_projected` | candidate: projected starter from recent usage and the back-to-back rule | yes |
| `xg_goalie_confirmed` | candidate: the goalie who actually started | **no**: post-game. Never used for an opener bet |

**Lines:**
- SBR moneyline open and close (two-way, overtime included), repo seasons 2014–2020. Joined on teams, date (±1 day) and final score.
- SBR totals keep one price per row and their line rarely moves (2–30% of games), so totals are graded on the line alone, with a discretised normal σ from 2014–2020. That is a weak test, and it is reported as such.

**Holdout:**
- Proxy, locked: repo 2021–2022.
- Mandated: 2026–2027. It has no opener with a close, so nothing is reported for it.

**Settings:**
- Clusters: game date.
- De-vig: multiplicative.
- First evaluable residual season: 2017.

### NHL-B1: production xg_core, moneyline (Phase 3)
- **Bet rule:** |p_model − p_open (no-vig)| ≥ 0.02.
- **Pass:** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 100.

### NHL-B2: production xg_core, total (line only) (Phase 3)
- **Bet rule:** |exp_total − open total| ≥ 0.30 goals.
- **Pass:** as B1.

### NHL-B3: xg_goalie_projected, moneyline (Phase 3, existing candidate)
- At ≥0.02. Pass as B1.

### NHL-R1: moneyline market-residual model (Phase 4)
- **Model:** ridge of (close − open) home no-vig probability on `d_core = p_core − p_open` and `d_gproj = p_gproj − p_open`.
- **Bet rule:** |predicted move| ≥ 0.005.
- **Pass:** as B1.

### NHL-R2: R1 plus an information block (Phase 4, one change)
- **Change:** add, as one block:
  - `p_open − 0.5` (favourite drift);
  - `b2b_diff` (home on a back-to-back − away);
  - `d_core × early` (either team under 10 games).
- **Pass:** as B1, AND a higher mean `clv_prob` than R1 on the same games.

### NHL-W1: projected-goalie games (Phase 5)
- **Hypothesis.** When the projected starter moves the price (|p_gproj − p_core| ≥ 0.02), the opener has not fully priced the likely goalie. Confirmation news later moves the line toward the projected-goalie model.
- **Change:** B3's bets restricted to those games.
- **Pass:** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 50.
- **Not testable:** confirmation timing itself. No confirmation timestamps exist.

### NHL-W2: back-to-backs (Phase 5)
- **Hypothesis:** R1 earns positive CLV on games with exactly one team on a back-to-back, where a backup goalie is likely.
- **Change:** R1's bets restricted to those games.
- **Pass:** as W1.

### NHL-W3: totals residual (Phase 5)
- **Model:** ridge of the total line move on `dt_core` and `dt_gproj`.
- **Bet rule:** |predicted move| ≥ 0.05 goals.
- **Pass:** as B1.

### NHL pre-holdout results

Run 2026-10-21 on repo 2014–2020 (9,195 games with moneyline open and close) by `python3 -m research.clv.nhl pre`.

**Join.**
- SBR to the walk-forward schedule: 11,529 games from 2014–2022, after the documented wrong-year SBR dates were handled one-to-one.
- p_core vs the no-vig close: correlation 0.906.

| ID | Rule | Bets | CLV prob (pp) | p | Toward | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|---|
| NHL-B1 | production xg_core, ML, ≥0.02 | 5,108 | +0.83 [+0.74, +0.92] | <1e-4 | 0.613 | -1.7% | PASS (every season positive: +0.50 to +1.17) |
| NHL-B2 | production xg_core, total (line only), ≥0.30 | 2,333 | +2.23 [+2.05, +2.42]; +0.111 goals | <1e-4 | 0.975 | -0.3% | PASS, **low confidence**. The bets fall on totals opened at 5.0, 6.0 or 6.5 that revert toward 5.5. SBR keeps no juice, so a half-goal move that a juice shift partly offsets is counted in full. Overstated by construction |
| NHL-B3 | xg_goalie_projected, ML, ≥0.02 | 5,106 | +0.84 [+0.75, +0.93] | <1e-4 | 0.612 | -1.7% | PASS |
| NHL-R1 | ML residual (d_core, d_gproj), ≥0.005 | 3,013 | +0.81 [+0.70, +0.93] | <1e-4 | 0.599 | -1.6% | PASS (move slope 0.98) |
| NHL-R2 | R1 + information block | 3,059 | +0.94 [+0.83, +1.05] | <1e-4 | 0.628 | -1.4% | PASS. Beats R1 on the same 5,235 games (+0.94 vs +0.81) |
| NHL-W1 | B3 where the projected goalie moves the price ≥0.02 | 143 | +0.91 [+0.53, +1.29] | <1e-4 | 0.672 | -1.9% | PASS. Barely above B3 overall (+0.84). The projected-goalie hypothesis is **not clearly supported** |
| NHL-W2 | R1 on one-team back-to-backs | 701 | +1.12 [+0.89, +1.34] | <1e-4 | 0.647 | -1.1% | PASS (above R1 overall, +0.81) |
| NHL-W3 | totals residual (line only), ≥0.05 | 3,008 | +1.55 [+1.41, +1.71]; +0.079 goals | <1e-4 | 0.914 | -1.5% | PASS, low confidence (as B2) |

**NHL pre-holdout attempt count: 8.**

### NHL-H: Phase 6 selection (written before the holdout was read)

**Gate data:** proxy holdout, repo 2021–2022 (SBR 2020–2021). The mandated 2026–2027 holdout has no openers with closes, so it reports nothing.

**Candidates (G8):**

| ID | Candidate |
|---|---|
| NHL-H1 | production xg_core, ML ≥0.02 (reference) |
| NHL-H2 | production xg_core, total line ≥0.30 (reference) |
| NHL-H3 | ML challenger = **NHL-W2**: R1 frozen on 2014–2020, betting one-team back-to-backs at ≥0.005. Highest eligible pre-holdout mean (+1.12 pp vs R2 +0.94, W1 +0.91, B3 +0.84) |
| NHL-H4 | total challenger = **NHL-W3** frozen (+1.55 pp, the best non-production totals rule) |

**k = 12** (8 + 4). PASS per G7.

### NHL-H1: production xg_core moneyline on the proxy holdout
### NHL-H2: production xg_core total on the proxy holdout
### NHL-H3: NHL-W2 (R1 frozen, back-to-backs) on the proxy holdout
### NHL-H4: NHL-W3 frozen on the proxy holdout

### NHL holdout results (run once, 2026-10-21)

**k = 12.** Gate data: the proxy holdout, repo 2021–2022.

| ID | Bets | CLV prob (pp) | α/12 LB | 2021 / 2022 | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|
| NHL-H1 production xg_core ML ≥0.02 | 1,475 | +0.77 [+0.57, +0.97] | +0.51 | +0.27 / +1.12 | -2.0% [-2.7, -1.1] | **PASS** |
| NHL-H2 production total line ≥0.30 | 951 | +3.25 [+2.88, +3.63]; +0.170 goals | +2.76 | +1.85 / +4.21 | +1.4% | **PASS, low confidence** (line only, no juice; toward 0.994) |
| NHL-H3 W2: R1 frozen, back-to-backs ≥0.005 | 272 | +2.24 [+1.70, +2.77] | +1.56 | +1.74 / +2.36 | **+1.6%** [-0.3, +4.2] | **PASS** |
| NHL-H4 W3 frozen totals ≥0.05 | 1,452 | +2.63 [+2.35, +2.92]; +0.136 goals | +2.23 | +1.46 / +3.52 | +0.3% | **PASS, low confidence** (as H2) |

**Frozen fits:**
- ML residual: move = -0.0005 + 0.044·d_core + 0.208·d_gproj. The line moves about a fifth of the projected-goalie model's disagreement and little of the goalie-blind production model's. The goalie projection is where the NHL information is, even though the W1 filter alone did not show it.
- Totals: move = -0.018 − 0.006·dt_core + 0.296·dt_gproj.

**Results diagnostic** (win rate at the opening price): H1 45.7%, H3 55.2% (ROI +10.6%, n = 272; noisy).

---

## MLB

Pre-registered 2026-10-21, before any MLB CLV number was computed.

**Base models.** The `mlb/history` lab model (the loop's served 1.0.0, `team_park_sp`) is replayed by `research/clv/mlb_predict.js`, which imports the unmodified walk-forward.
- Each game is predicted at 09:00 UTC on its date from earlier dates.
- Results are absorbed with the actual starters, exactly as the record does.
- **Reproduction:** with the actual starter, confirmation log loss 0.67727, equal to the committed record.

The starter input is replaced with what is knowable at the opener:

| Variant | Starter input | Used for opener bets? |
|---|---|---|
| `sp_proj` | the team's 5th-previous starter, if he has not started in the last 4 days (the projected rotation spot); otherwise none. Matches the actual starter for 66.2% of team-games | yes |
| `team_park` | no starter term | yes |
| `sp_actual` | the actual starter | no: reproduction only |

**Not tested: the live browser engine (`mlb/engine.js`).** It reads season-level pitcher and batter tables (`mlb/pitchers/dataset`, `mlb/batters/dataset`, 2016–2025). Those are whole-season numbers and cannot be made point-in-time for the SBR seasons. INFEASIBLE, not counted.

**Lines:**
- SBR moneyline open and close, 2012–2021. **Only pairs passing the [0.98, 1.20] overround check count**, about 55% of games (`DATA_AUDIT.md`: about 30% of pairs imply both sides better than fair). Low-confidence source.
- Totals: line only (one price per row), σ from 2012–2019.

**Seasons:**
- Walk-forward: 2012–2019. First evaluable residual season: 2015.
- Proxy holdout: 2020–2021.
- Mandated holdout: 2025–2026. No openers, so nothing is reported.

**Clusters:** game date.

### MLB-B1: lab model with the projected starter, moneyline (Phase 3)
- **Bet rule:** |p − p_open| ≥ 0.02.
- **Pass:** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 100.

### MLB-B2: lab team_park (no starter), moneyline (Phase 3)
- At ≥0.02. Pass as B1.

### MLB-B3: lab model (projected starter), total, line only (Phase 3)
- **Bet rule:** |expected total − open total| ≥ 0.5 runs.
- **Pass:** as B1.

### MLB-R1: moneyline market-residual model (Phase 4)
- **Model:** ridge of the no-vig home move on `d_proj` and `d_tp`.
- **Bet rule:** ≥0.005.
- **Pass:** as B1.

### MLB-R2: R1 plus an information block (Phase 4, one change)
- **Change:** add, as one block:
  - `p_open − 0.5`;
  - `d_proj × early` (either team under 20 games);
  - `rotation_unknown` (number of sides with no projected starter).
- **Pass:** as B1, AND a higher mean than R1 on the same games.

### MLB-W1: starting-pitcher uncertainty (Phase 5)
- **Hypothesis:** where the rotation is disrupted (either side has no projected starter), the opener moves more after the probable is confirmed. R1 earns positive CLV there.
- **Change:** R1's bets restricted to those games.
- **Pass:** mean `clv_prob` > 0, one-sided p < 0.05, n ≥ 50.
- **Not testable:** true probable-to-actual changes. No probables were archived.

### MLB-W2: bullpen fatigue: not run
- Retrosheet game logs name only starters and decision pitchers.
- INFEASIBLE, not counted.

### MLB-W3: totals residual (Phase 5)
- **Model:** ridge of the total line move on `dt_proj` and `dt_tp`.
- **Bet rule:** ≥0.05 runs.
- **Pass:** as B1.
- **Not testable:** weather. No archive exists.

### MLB amendment (2026-10-21, before any MLB CLV number was computed)
- **MLB-B3 and MLB-W3 (totals) are withdrawn as INFEASIBLE** and not counted. SBR MLB totals cannot be attributed to games (`DATA_AUDIT.md` addendum).
- **Moneylines** use the repaired pairing.
- Nothing else changes.

### MLB pre-holdout results

Run 2026-10-21 on 2012–2019 with the repaired SBR moneylines (17,824 games).

| ID | Rule | Bets | CLV prob (pp) | p | Toward | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|---|
| MLB-B1 | lab model, projected starter, ≥0.02 | 12,099 | +0.19 [+0.13, +0.25] | <1e-4 | 0.514 | -3.3% | PASS (2017 and 2019 slightly negative) |
| MLB-B2 | lab team_park (no starter), ≥0.02 | 12,368 | +0.23 [+0.18, +0.29] | <1e-4 | 0.517 | -3.2% | PASS |
| MLB-R1 | residual (d_proj, d_tp), ≥0.005 | 767 | +0.39 [+0.13, +0.68] | 0.003 | 0.507 | -2.3% | PASS (move slope 0.68; the market moves about 2% of the disagreement) |
| MLB-R2 | R1 + block (favourite drift, early × d, rotation_unknown) | 2,117 | +0.70 [+0.56, +0.84] | <1e-4 | 0.598 | -2.3% | PASS. Beats R1 on the same 11,133 games (+0.70 vs +0.39) |
| MLB-W1 | R1 where the rotation is disrupted | 187 | +0.17 [-0.28, +0.62] | 0.23 | 0.533 | -3.2% | **FAIL** |

**MLB pre-holdout attempt count: 5.** B3 and W3 were withdrawn as infeasible; W2 and the browser engine are infeasible.

### MLB-D1: diagnostic. Favourite drift alone (registered after R2's result; counted, never a candidate)

**Why added.** R2's last fit puts 0.045 on `p_open − 0.5`: MLB favourites are bet up after the open. D1 measures that market-structure effect alone.

**Rule.** A ridge on `fav` only, walk-forward like R2, betting ≥0.005.

### MLB-H: Phase 6 selection (written before the holdout was read)

**Gate data:** proxy holdout SBR 2020–2021 (repaired).

**Candidates (G8):**

| ID | Candidate |
|---|---|
| MLB-H1 | the lab model with the projected starter, ML ≥0.02 (reference). This is the loop-served model's admissible form. The live browser engine cannot be tested |
| MLB-H2 | ML challenger = **MLB-R2** frozen on 2012–2019 (+0.70 pp, the highest eligible) |

**k = 8** (5 + D1 + 2 holdout runs). PASS per G7.

### MLB-H1: lab model (projected starter) moneyline on the proxy holdout
### MLB-H2: MLB-R2 frozen on the proxy holdout

### MLB-D1 result
- Favourite drift alone has a coefficient of -0.0002, so 0 bets.
- **R2's gain is not plain favourite drift.** Its `fav` term matters only together with the model disagreements.

### MLB holdout results (run once, 2026-10-21)

**k = 8.** Gate data: proxy holdout SBR 2020–2021 (repaired).

| ID | Bets | CLV prob (pp) | α/8 LB | 2020 / 2021 | `clv_ev` | Verdict |
|---|---|---|---|---|---|---|
| MLB-H1 lab, projected starter, ≥0.02 | 2,117 | +0.69 [+0.52, +0.89] | +0.48 | +0.89 / +0.62 | -2.2% [-2.7, -1.6] | **PASS** |
| MLB-H2 R2 frozen, ≥0.005 | 1,451 | +0.90 [+0.68, +1.17] | +0.63 | +0.98 / +0.86 | -1.8% [-2.4, -1.1] | **PASS** |

**R2 frozen fit:** move = -0.0006 + 0.029·d_proj + 0.070·d_tp + 0.053·fav + 0.036·d_proj·early − 0.0005·rotation_unknown.

**Reading:**
- MLB CLV is real but small, far below the moneyline vig.
- The no-starter team model carries more of it than the projected starter does.
- The SBR source is repaired; a different book's openers would be needed to confirm it.

---

## WNBA and NCAAM: single holdout runs (no pre-holdout openers exist)

Pre-registered 2026-10-21, before any WNBA or NCAAM CLV number was computed.

**Why only Phase 6.** Openers exist only in each sport's mandated holdout:
- WNBA: ESPN DraftKings, 2026 (2025 has none).
- NCAAM: ESPN DraftKings, 2025-26 = repo 2026. 2027 has no finals yet.

So Phases 3–5 are infeasible. The only candidate is the production model, the basketball lab's served version for the league, replayed by `research/clv/bb_predict.js` at 09:00 UTC on each game date.

**Settings:**
- Lines: DraftKings open and close, with their own prices.
- Points distributions are fixed now, because no pre-holdout closes exist to fit them: IntegerNormal with σ = 11.5 / 15.0 (WNBA spread / total) and 10.5 / 15.5 (NCAAM). These are the harness defaults.
- Clusters: game date.

**k = 3 per sport** (spread, total, moneyline). PASS per G7.

### WNBA-H1: production bb_points (WNBA 1.0.0), spread ≥1.5, 2025–2026 holdout
### WNBA-H2: production, total ≥2.0
### WNBA-H3: production, moneyline ≥0.02
### NCAAM-H1: production bb_points (NCAAM 1.1.0), spread ≥1.5, repo 2026–2027 holdout
### NCAAM-H2: production, total ≥2.0
### NCAAM-H3: production, moneyline ≥0.02

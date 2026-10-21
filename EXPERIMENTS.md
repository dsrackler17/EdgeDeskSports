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

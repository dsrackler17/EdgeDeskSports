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

# NHL model laboratory: every challenger, scored the production model's way

> Record: `hockey/validation/nhl_lab.json` (`node hockey/lab/run.js`; `--check`).
> Live challenger parameters: `hockey/model/params/lab_live.json`.
> Production record: `hockey/validation/nhl_walkforward.json`.

The lab reuses the production walk-forward's own steps (`hockey/lab/base.js`):
the same 20,676 games, ratings pass, five-season GLM window, pair
recalibration and score effects. Its incumbent reproduces the production
record to the last digit (`reproduces_production.ok`, checked by `--check`).
Any difference between a challenger and production comes from what the
challenger declares it changes, and nothing else.

Windows: **selection** 2013-14 to 2019-20 (9,205 games) chooses and tunes.
**Confirmation** 2020-21 to 2025-26 (7,945 games) guards. **Live** 2026-27 is
the clean test. Prediction time is 30 minutes before the scheduled start, and
inputs come from games on earlier dates only.

## 1. The promotion rule (written before any challenger was scored)

A challenger replaces the production model only if **all** of these hold:

1. **Selection.** Its moneyline log loss beats the incumbent's by at least 0.001.
2. **Confirmation.** Its paired block-bootstrap 95% interval (over dates) is
   wholly below zero.
3. **Calibration.** On confirmation, the calibration slope is between 0.85 and 1.15,
   and |mean p − mean y| is at most 0.02.
4. **Consistency.** It yields one score distribution for every market. A
   moneyline-only model enters through `distribution.solveSplit`, which keeps
   the incumbent's expected total.

**Disclosure.** The confirmation window had already been read for the
production candidates before this lab existed. Rule 1 chooses; rule 2 is an
extra guard, not a selection device. The ledger freezes every 2026-27 price
before puck drop, so this season is the clean out-of-sample test.

## 2. Results (moneyline log loss, lower is better)

| Model | Phase | Selection | Confirmation | Live (86, lab run) | vs production on confirmation (95%) | Verdict |
|---|---|---|---|---|---|---|
| **B — expected-goals GLM, `xg_core` (production)** | 3B | **0.67459** | **0.66286** | 0.65436 | — | production |
| B — previous production, `xg_no_goalie` (+ special teams) | 3B | 0.67466 | 0.66270 | 0.65335 | −0.00015 (−0.00087 to +0.00048) | fails rule 1 |
| A — goals-only power ratings | 3A | 0.67582 | 0.66492 | 0.65674 | +0.00207 (+0.00120 to +0.00299) | worse |
| A — Elo with margin of victory (tuned on selection) | 3A | 0.67669 | 0.66654 | 0.65924 | +0.00369 (+0.00213 to +0.00542) | worse |
| C — B + projected goalie GSAx | 3C | 0.67445 | 0.66248 | 0.65363 | −0.00037 (−0.00114 to +0.00027) | fails rule 1 |
| C — B + confirmed goalie (known 30 min before) | 3C | 0.67434 | 0.66254 | 0.65280 | −0.00031 | not available pregame |
| D — B + projected lineup value | 3D | 0.67453 | 0.66253 | 0.65739 | −0.00033 (−0.00133 to +0.00066) | fails rule 1 |
| D — B + confirmed lineup value | 3D | 0.67463 | 0.66181 | 0.65641 | −0.00105 (−0.00209 to −0.00000) | not available pregame |
| E — L2 logistic regression (44 features, L2 tuned on selection) | 3E | 0.67597 | 0.66381 | 0.65215 | +0.00096 | worse |
| E — gradient-boosted trees (depth 2, 300 rounds, tuned on selection) | 3E | 0.67919 | 0.66754 | 0.65193 | +0.00469 (+0.00240 to +0.00697) | worse |
| F — pair recalibration on every earlier season | 3F | 0.67458 | 0.66323 | 0.65174 | +0.00038 (+0.00001 to +0.00074) | worse |
| G — stacked ensemble of A–E (nested, three seasons) | 3G | 0.67485 | 0.66352 | 0.65634 | +0.00066 | worse |
| G — equal-weight logit average of A–E | 3G | 0.67445 | 0.66269 | 0.65406 | −0.00016 (−0.00087 to +0.00051) | fails rule 1 |

**Decision: RETAIN_INCUMBENT.** Complexity did not buy accuracy: the trees are
the worst model in the lab, and the stacked ensemble is worse than its best
component. On the live season the machine-learning models happen to lead,
over 86 games. A difference of that size is within the noise of 86 games, so
it is reported and not acted on.

The goalie (C) and lineup (D) terms carry a real but small signal. Confirmed
lineups beat the production model with an interval just below zero, but they
arrive only at warmups. They drive the goalie scenarios and the lineup
sensitivity, not the price.

## 3. Feature ablation (Phase 4)

Each row removes a feature (or a block) from the production model, or adds
one. Δ is the change in held-out log loss: positive when removing hurts,
negative when adding helps.

| Feature or block | Δ selection (95%) | Δ confirmation | Verdict |
|---|---|---|---|
| remove home ice | +0.00225 (+0.00050 to +0.00398) | +0.00109 | earns its place |
| remove 5v5 xG block (creation + suppression) | +0.00100 (+0.00045 to +0.00158) | +0.00121 | earns its place |
| remove goals-and-finishing block | +0.00473 (+0.00306 to +0.00656) | +0.00588 | earns its place |
| remove rest block (back-to-backs) | +0.00070 (−0.00008 to +0.00150) | +0.00218 | small; kept (clear on confirmation) |
| **add** special-teams block (PP xG, PK xG, PP/PK minutes) | +0.00007 (−0.00022 to +0.00033) | −0.00015 | no measurable benefit (removed 2026-10-13) |
| add travel distance | −0.00004 | +0.00003 | no measurable benefit |
| add time-zone change | +0.00005 | +0.00003 | no measurable benefit |
| add schedule congestion (3 in 4) | +0.00005 | +0.00008 | no measurable benefit |
| add road-trip length | +0.00007 | +0.00003 | no measurable benefit |
| add recent form (last 10 vs last 40, 5v5 xG) | −0.00056 (−0.00113 to −0.00004) | −0.00033 | small, below the 0.001 bar |
| add finishing and save luck (PDO-style regression, last 20) | +0.00004 | −0.00008 | no measurable benefit |
| add special-teams interaction | +0.00002 | +0.00001 | no measurable benefit |
| add early-season shrinkage | −0.00001 | +0.00009 | no measurable benefit |
| add all context together | −0.00035 (−0.00110 to +0.00038) | −0.00007 | no measurable benefit |

Travel, time zones, congestion and luck are still **measured and shown** on
every game (Evidence tab). They are not in the price.

Not tested, for lack of timestamped data: coach and system changes (no
dated coaching record), line-matching (shifts are in the mirror, unused yet),
and injuries (no injury feed).

## 4. Model F: the shape of the score distribution

| Candidate | How it was fitted | Result |
|---|---|---|
| Gamma pace overdispersion (shared by both clubs) | ML on the 60-minute score, three seasons before | **never chosen** by any season's history: the 60-minute score is not overdispersed relative to the model |
| 60-minute draw inflation | same | selection log-likelihood **−0.0002/game** (needs ≥ +0.001): rejected |
| Bivariate-Poisson common shock (earlier build) | same | share 0 every season: rejected |
| Pair recalibration on every earlier season | as production, longer window | worse on confirmation (+0.0004): rejected |
| **Score effects by period** (first period apart from the second) | effects from the four seasons before | **adopted** (below) |

### Amendment 1: the period profile (adopted)

The score-effect time buckets treated minutes 0–40 as one rate. The first
period scores less than the second, so first-period prices were 3–5 points
too high (selection over-1.5: predicted 51.6%, observed 48.2%). Splitting
the bucket changed the following:

| | Selection | Confirmation |
|---|---|---|
| first-period score log-likelihood | +0.0036/game | +0.0087/game |
| 60-minute score log-likelihood | +0.0005/game | +0.0007/game |
| moneyline log loss | −0.000006 (no change) | −0.000005 |
| first-period over 1.5, mean p − mean y | +3.4 → −0.6 points | +5.3 → +1.0 points |

Rule: adopt if the first-period score likelihood gains at least 0.001 per
game on selection, the 60-minute likelihood does not fall, and the moneyline
worsens by no more than 0.0002. **The rule was written after an exploratory
run that had read both windows** (disclosed in `walkforward.js` and in this
file).

### Amendment 2: parsimony (adopted)

The block ablation found the four special-teams features, taken together,
indistinguishable from noise: selection −0.00007, confirmation +0.00015,
totals unchanged. The production protocol already prefers the simpler model
unless a richer one wins by 0.001 on selection. `xg_core` (the GLM without
that block) was therefore listed first in its selection chain, and that rule
chose it. On confirmation it is not significantly worse than the previous
model: +0.00015 (−0.00048 to +0.00087). The moneyline and both puck lines
remain OUTCOME_VALIDATED, and the model still beats Elo by 0.0037 (95%
−0.0054 to −0.0021). This was declared after both windows had been read; the
live season is the clean test. Special-teams ratings stay on every game page
as evidence; they no longer move the price.

## 5. Every market, held out (confirmation, n 7,945)

| Market | Status | Calibration slope | Mean p − mean y |
|---|---|---|---|
| Moneyline (incl. OT/SO) | **OUTCOME_VALIDATED** | 1.064 | +0.009 |
| Puck line home −1.5 / away −1.5 | **OUTCOME_VALIDATED** | 0.936 / 0.981 | +0.010 / −0.010 |
| Alternate puck lines −2.5, +2.5, +3.5 | **OUTCOME_VALIDATED** | 0.874, 0.914, 0.912 | −0.001, +0.012, +0.005 |
| Puck line −3.5 | PROVISIONAL | 0.765 | +0.003 |
| Team totals 1.5 / 2.5 / 3.5, both sides | **OUTCOME_VALIDATED** (all six) | 0.87–1.10 | −0.009 to +0.012 |
| Totals 4.5–8.5, and 5 / 6 / 7 (no push) | PROVISIONAL | 0.72–0.78 | ≤ 0.012 |
| Regulation totals 4.5 / 5.5 | PROVISIONAL | 0.69 / 0.78 | |
| Regulation total 6.5 | PROVISIONAL | 0.82 | +0.017 |
| 60-minute 3-way | PROVISIONAL | draw slope 0.68; home mean off by 0.020 | |
| First-period 3-way | PROVISIONAL | draw slope 0.30 | |
| First-period total 1.5 | **OUTCOME_VALIDATED** | 1.12 | +0.013 |
| First-period totals 0.5 / 2.5 | PROVISIONAL | 0.73 / 0.88 | +0.011 / +0.020 |

A 3-way passes only when each outcome, scored one-vs-rest, passes the binary
rules. That rule was defined in this build, after the draw shortfall was
known; it fails here, so it flatters nothing.

**Totals.** No shape term fixes the totals, and neither does a longer
calibration window. Per-season slopes range from 0.55 to 1.8, because
total-goal discrimination is weak: Brier skill is about 0.006. Totals stay
PROVISIONAL in every view.

## 6. Diagnostics of the production model (`hockey/validation/nhl_diagnostics.json`)

| | Selection | Confirmation | Live |
|---|---|---|---|
| AUC | 0.600 | 0.634 | 0.659 |
| Log loss, first 20 games of each club's season | 0.67875 | 0.66974 | |
| Log loss, the rest of the season | 0.67329 | 0.66058 | |
| Projected starter actually started (2025-26) | | 66% of team-games | |
| Log loss when both projected starters started (calibration slope) | 0.67630 (1.21) | 0.65918 (1.21) | |
| Log loss when at least one did not | 0.67280 | 0.66573 | |
| Total goals: share of games inside the central 80% set | 0.88 | 0.90 | |
| Clubs whose own win rate falls outside its 95% interval | | SJS | |

**Drift monitor.** A one-sided CUSUM tracks per-game log loss against the
confirmation mean, and a z-test checks the season mean. Status today: OK
(z −0.36 over 89 games). It is a monitor; it never retrains anything.

**What the diagnostics say to fix next.** The starter projection is wrong a
third of the time. In games where both projections were right, the model is
under-confident in both windows (slope 1.21), although the log-loss gap
between the subsets flips sign between windows. A licensed confirmed-starter
feed is the most valuable missing input, and its value would be measurable.
The first 20 games of a season are measurably harder, which is expected.

## 7. Reproducibility

Every fit is deterministic. IRLS has no randomness; the tree learner and the
bootstraps use seeded PRNGs (`engine/stats.js rng`, seed 20261013). The lab
re-run reproduces itself byte for byte except for timestamps, and the
production record reproduces exactly from the committed data (see
`NHL_AUDIT.md` §1). Running time is about 9 minutes, with a peak of about
1.6 GB.

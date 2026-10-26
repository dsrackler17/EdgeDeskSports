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

### 6.1 Team strength: does the model over- or under-rate clubs? (2026-10-26)

**The question.** For TOR at CGY on 2026-10-26, a reader read the market as
implying 3.57 Toronto goals against the model's 3.10 in regulation (about 3.2
with overtime). Toronto had scored 3.85 a game, with 13 power-play goals and
18 goals in its last three. Does the model regress hot clubs too far, or rate
clubs too close together in general? Or too far apart?

**The monitor** (`team_strength` in the diagnostics file, also on the
Record tab). It uses each club's regulation goals against the regulation λ
it was priced at, regular season, out of sample:

- **Slope:** the Poisson recalibration slope of goals on log λ. 1 is right.
  `TOO_WIDE` when the 95% interval sits below 1: clubs are rated too far
  apart, so the strong are overrated and the weak underrated. `TOO_NARROW`
  when the interval sits above 1: clubs are rated too close together.
- **Game total and split:** the same slope on the game total, and on the
  home share of goals.
- **Scored ÷ forecast**, by tenth of λ.
- **Standouts:** clubs 8 to 24 games into a season whose season-to-date
  numbers stand out, computed from earlier dates only.

It is a monitor: it never retrains or reprices.

| Slope (95%) | Selection 2014-20 | Confirmation 2021-26 | Live 2026-27 (179 games) |
|---|---|---|---|
| Club goals | 1.010 (0.931–1.090) OK | **0.889 (0.823–0.956) TOO_WIDE** | 1.61 (0.95–2.27) OK |
| Game total | 1.013 OK | **0.761 (0.589–0.934) TOO_WIDE** | **3.56 (1.03–6.08) TOO_NARROW** |
| Home share of goals | 1.042 OK | 0.938 (0.860–1.016) OK | 1.50 (0.78–2.23) OK |
| Highest-λ group, scored ÷ forecast | 1.008 ± 0.014 | **0.955 ± 0.013** | 1.077 ± 0.066 (fifth) |
| Lowest-λ group | 1.011 ± 0.017 | 1.018 ± 0.017 | 0.934 ± 0.070 (fifth) |

| Standout, 8-24 games in: scored ÷ forecast | Selection | Confirmation |
|---|---|---|
| Scoring ≥ 1.20× the league | 0.994 ± 0.028 (455) | 0.997 ± 0.028 (392) |
| … with finishing ≥ 1.10 (Toronto's profile) | 0.995 ± 0.030 (388) | 0.994 ± 0.035 (260) |
| Last three games ≥ 1.33× the league's rate | 1.015 ± 0.026 (564) | 0.995 ± 0.026 (479) |
| Power-play goals ≥ 1.35× the league | 1.038 ± 0.027 (524) | 0.966 ± 0.024 (543) |
| Finishing (goals ÷ xG) ≥ 1.15 | 1.001 ± 0.021 (829) | 0.958 ± 0.026 (452) |
| Opponent allows ≥ 1.20× the league | 0.977 ± 0.027 (454) | 1.019 ± 0.030 (359) |

In both tables, ± is one standard error and (n) the number of team-games. The slope intervals are 95%.

**What it says.**

- **Hot clubs score what the model forecasts.** That holds for a hot scoring
  start, a run of goals, and hot scoring with hot finishing, in both windows
  and within about 1%. Moving their forecasts toward their season-to-date
  scoring would overrate them.
- **Power-play goals carry no stable correction.** Clubs with high early
  power-play goal rates scored 4% over their forecast on selection and 3%
  under on confirmation.
  - Two one-off runs on `hockey/lab/base.js` check this further. Adding
    power-play quality and volume (`pp_off`, `pp_draw`) to `xg_core`
    changed club-goal likelihood by +0.00005 on selection and −0.00005 on
    confirmation, and team-total-2.5 log loss by −0.00001 and −0.00015. Every
    interval straddles zero.
  - `goals_only`, which trusts scoring alone, is worse on team totals 2.5 by
    0.0013 (selection) and 0.0026 (confirmation), both intervals above zero.
- **Where the model does overrate.** On 2021-26 the highest-λ tenth scored
  4.5% under its forecast. The cause is the game total (slope 0.76), not who
  scores more (0.94, interval covers 1). It is the same over-spread total
  that keeps every totals market `PROVISIONAL` (§5). 2014-20 shows none of it.
- **The calibration window was tested again.** Three alternatives:
  - every earlier season;
  - five seasons;
  - totals from every earlier season, split from three.

  None beats the three-season rule. On selection each is worse on over 5.5
  by 0.00013 to 0.00014 (intervals above zero). On confirmation every
  interval straddles zero. The production rule stays.
- **The live season leans the other way.** In 2026-27 so far, the totals
  are bunched too tightly (3.56, interval above 1). The 2026-27 total
  calibration `a = 0.5` is the strongest compression since 2014; 2021-26 ran
  0.6 to 1.05. This is a watch item: 179 games, and the live window never
  chooses (protocol rule 4).
- **Toronto at Calgary, specifically.** The calibration moves Toronto only
  from 3.13 to 3.10. The 3.10 comes from the ratings:
  - Toronto: goals 1.039, 5v5 chance creation 0.96, finishing 1.06. Its 50
    goals came on 38.9 xG, and the ratings carry 50.7 games of decayed
    history plus a 32-game prior.
  - Calgary: goals against 1.053, 5v5 chances against 1.031.

  Clubs with that profile have scored their forecast (0.995 and 0.994
  above).

### 6.2 Projected game totals: bunched too tightly? (2026-10-26)

**The question.** The 2026-27 board's projected totals sit close together
(5th–95th percentile 6.03 to 6.46). Are they too compressed? If so, would
spreading them out score better? The rule was to widen only on evidence and
to keep production if it is statistically appropriate.

**The audit** (`totals` in the diagnostics file and the Record tab). It
covers the regular season, out of sample. The projected total is the served
full-game mean: overtime goals and the shootout winner's credited goal are
included, as a market total settles.

| | Selection 2014-20 | Confirmation 2021-26 | Live 2026-27 (184) |
|---|---|---|---|
| Projected total, median (5th–95th) | 5.52 (5.09–6.17) | 6.23 (5.73–6.76) | 6.24 (6.03–6.46) |
| Spread of projections within a season (sd) | 0.23 | 0.26 | 0.14 |
| Totals played, mean (sd) | 5.70 (2.25) | 6.20 (2.31) | 6.30 (2.25) |
| Slope of played on projected (95%) | 1.035 (0.89–1.18) OK | **0.76 (0.60–0.92) TOO_WIDE** | **3.6 (1.3–5.9) TOO_NARROW** |
| MAE / RMSE | 1.777 / 2.225 | 1.850 / 2.297 | 1.785 / 2.223 |
| … last season's mean for every game | 1.810 / 2.253 | 1.863 / 2.314 | 1.813 / 2.250 |
| Dispersion: var played ÷ (var projected + mean game var) | 0.99 | 0.94 | 0.91 |
| Home / away goals ÷ forecast | 1.020 / 1.027 | **0.979** / 1.003 | 1.007 / 1.006 |
| Goals ÷ forecast, projected goalie / another started | 1.021 / 1.029 | 0.985 / 0.999 | 1.014 / 0.994 |

**What it says.**

- **Most of a total is noise.** A game's total has an sd of about 2.3. The
  predictable part is about 0.2 to 0.3. A well-calibrated board should
  therefore look bunched.
- **Production is not too compressed overall.** The slope is right on
  2014-20. On 2021-26 it reads too wide (0.76), the opposite of bunched; that
  is the §6.1 finding. Against last season's mean, the model is 0.01 to 0.03
  goals better on MAE in every window.
- **This season is about as bunched as the previous two at the same point.**
  The 2026-27 within-season sd is 0.139. Over their first 184 games, 2025-26
  ran 0.149 and 2024-25 0.171. The sd pooled over a window's seasons (0.33
  and 0.32) is no yardstick for one season: it adds the shifts in scoring
  level between seasons.
- **The live slope is 3.6, on 184 games.** The top fifth of projections
  (6.45) produced 7.47 goals (+1.02 ± 0.82, n 36), and the other four fifths
  came in under their projections. One bucket of 36 games drives it. The
  live window never chooses (§1, rule 4).
- **Per season** (Record tab, "Spread of projected totals by season"):
  - 12 of 13 completed seasons read OK.
  - 2018-19 read TOO_NARROW (1.63).
  - The calibration's total exponent `a` has run 0.6 to 1.05. It is 0.5 for
    2026-27, the strongest compression yet.
- **Each game's own distribution is slightly wide.** Since 2021 the variance
  of totals played is about 5% below what the served distributions imply
  (0.94, 0.95 on 2025-26 alone, 0.91 live). The lab's one shape term,
  `pace_shape`, widens rather than narrows and was not chosen (§4). This is
  monitored, not changed.
- **Bias.**
  - Fifths, offence, defence, power play, finishing, opponent goalie quality
    and matchup interaction: no gradient holds across windows.
  - 2014-20 is low in every fifth, by 0.10 to 0.17 goals. The calibration
    centres on the three prior seasons while scoring rose.
  - The home over-forecast on 2021-26 (0.979, SE 0.006) is gone live.
  - A goalie other than the projected starter is worth about +1% to the
    opponents' goals. That is not significant, and the production price
    carries no goalie term.

**The decision rule** was written before any candidate's totals were
scored. The windows are:

- SELECT 2014-20;
- CONFIRM 2021-25;
- HOLDOUT 2025-26 (the most recent complete season, read once);
- LIVE (reported, never chooses).

The score is the RPS of the full-game total-goals distribution, with a paired
bootstrap over dates. A candidate replaces production only if all four hold:

- SELECT: RPS lower, with the 95% interval below zero;
- CONFIRM: RPS lower;
- HOLDOUT: not significantly worse;
- moneyline log loss not worse by more than 0.0002.

Before the rule was written, the bucket and bias tables and two exploratory
calibration runs had been read.

| Candidate (ΔRPS × 10⁶, 95% interval) | SELECT | CONFIRM | HOLDOUT | LIVE |
|---|---|---|---|---|
| `xg_core` + confirmed starter quality | −4 (−27, 19) | −15 (−36, 8) | **−44 (−84, −1)** | −73 (−207, 48) |
| `goalie_conf` | −12 (−38, 15) | +13 | −21 | −12 |
| `goalie_proj` | −10 (−30, 11) | +26 | +6 | +20 |
| `special_teams` | −3 (−16, 11) | +18 | +14 | +38 |
| `goals_only` | +9 | −11 | +74 | +151 |
| `pace` | +1 | +14 | +10 | −4 |
| matchup interaction | +1 | 0 | 0 | +3 |
| total calibration centred on last season | **−48 (−77, −16)** | **+40 (+2, +75)** | +29 | **−81** |
| … with a quadratic term | −49 (−104, 8) | **+63** | +95 | −81 |
| … with `a` pooled over every earlier season | **−47 (−76, −15)** | +32 (−6, 70) | +39 | **−299** |
| rating prior 16 / 64 games | +2 / 0 | +3 / **−18** | −1 / +5 | **−21 / +29** |
| rating half-life 120 / 270 days | −13 / **+52** | −32 / +40 | 0 / +5 | +73 / −27 |

**Every candidate fails**, so production is kept.

- The near miss is `xg_core` plus the confirmed starter's quality. It is
  better on every window and on the moneyline, but on SELECT its interval
  covers zero. It also needs the confirmed starter at pricing time, which the
  data does not have.
- Re-centring the total calibration on last season fixes the 2014-20 level
  lag. It is significantly worse on 2021-25.
- The pooled `a` would spread this season's board (a 0.8 instead of 0.5) and
  scores best live. It fails CONFIRM and HOLDOUT, and the live window never
  chooses.

**Clubs** (`clubs` in the diagnostics file and the Record tab). Each club's
regulation goals scored and conceded are checked against λ over four windows:
this season, last season, the season before, and its last 82 games.

- A club needs 41 games before it can be flagged.
- WATCH when |z| ≥ 2.
- FLAG when |z| passes the two-sided Bonferroni bound over every club and
  both sides: 3.36 for 64 tests at 5%.
- PERSISTENT when two windows that share no game both sit past the watch
  bound on the same side.

Today there are no flags, 9 watches and nothing persistent. Toronto
conceded 1.128× its forecast last season (WATCH, z 2.03). Its scoring is
inside every bound. It is a monitor: it never adjusts a rating.

**Market check, 2026-10-26** (DraftKings via the ESPN scoreboard, full game
incl. overtime and shootout, de-vigged; there is no NHL closing archive):

| Game | Line | Model P(over) | Market P(over) | Model total |
|---|---|---|---|---|
| LAK at NYR | 5.5 | 0.527 | 0.543 | 5.99 |
| TOR at CGY | 6.5 | 0.471 | 0.522 | 6.31 |
| DET at EDM | 6.5 | 0.485 | 0.517 | 6.39 |

The market sits above the model on all three. Without a closing-line record,
that cannot be scored, and the model's totals stay `PROVISIONAL` (§5).

## 7. Reproducibility

Every fit is deterministic. IRLS has no randomness; the tree learner and the
bootstraps use seeded PRNGs (`engine/stats.js rng`, seed 20261013). The lab
re-run reproduces itself byte for byte except for timestamps, and the
production record reproduces exactly from the committed data (see
`NHL_AUDIT.md` §1). Running time is about 9 minutes, with a peak of about
1.6 GB.

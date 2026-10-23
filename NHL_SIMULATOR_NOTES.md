# NHL_SIMULATOR_NOTES — EdgeDesk NHL season and Stanley Cup simulator

The engineering record of the NHL module of the EdgeDesk Simulator: what it
does, what it stands on, what was measured, and how it was verified. It
follows the shared simulator conventions in [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md)
(engine, PRNG, snapshot hashing, gates, provenance labels). Dates are UTC;
"retrieved" means read for this work on 2026-10-23. Seasons are keyed by
their **end year**, as in `hockey/config.js` (2027 = 2026-27).

Nothing here claims a validated edge. The NHL is **ACTIVE**: its three
2026-27 rules facts were verified against NHL.com's own pages (§13), the
reader has an NHL view, and the nightly *Simulator* workflow publishes it
(100,000 runs, 10:17 UTC) once this lands on `main`.

---

## 1. Status

| Area | State | Evidence |
|---|---|---|
| Regulation / OT / shootout distinction | **Verified** in the served model and in the data | §2 |
| Completed results, fixed with REG/OT/SO | Implemented; 165 games (153 from the team-game table, 12 from per-game files) | §4 |
| Remaining schedule | 1,179 of 1,344 games (84 per club) | §4 |
| Persistent strength uncertainty | Calibrated from frozen-forecast residuals, σ = 0.1154 at 10.3 games played | §8 |
| Goal distribution validated | Served model vs draw-inflated vs independent Poisson; decision by a rule written first | §5 |
| Goalie / player availability | Confirmed starters with provenance only; baseline stated | §7 |
| Standings points, tiebreakers, qualification, bracket, home ice, series | Implemented; reproduces all 165 playoff series of 11 seasons | §9 |
| Playoff overtime without shootouts | Implemented and tested | §6 |
| Existing postseason state | Kept as played; tested on the real 2025-26 playoffs | §9.6 |
| Tests | 4 NHL suites (203 assertions), plus NHL cases in the reader, browser, command-line and markets suites; all passing | §11 |
| 100,000-run benchmark | 17.7 s on 4 workers | §12 |
| Publication | **ACTIVE**: facts verified from NHL.com (2026-10-23); reader NHL view; nightly workflow leg | §13 |

---

## 2. Can the model tell regulation, overtime and shootout apart?

The first check asked for. A binary winner model cannot produce NHL standings:
the loser of an overtime or shootout game earns a point, regulation wins (RW)
and regulation + overtime wins (ROW) are the first tiebreakers, and the
shootout winner is credited a goal.

**The served model does.** `hockey/model/distribution.js` (`EDNHLDist.game`)
builds the full 60-minute score matrix (30-second steps with score effects
fitted on earlier seasons). From it come the three regulation outcomes (home
win, away win, **tie**). A tie then splits into four outcomes:
- **Regular season**: 5-minute 3-on-3 sudden death at `k` × the regulation
  rate (`k` fitted so the share of ties decided in overtime matches earlier
  seasons), then a shootout won by the home club at `so_home`.
- **Playoffs** (`format: 'PO'`): sudden death until a goal, won in proportion
  to the two rates. No shootout.

So a simulated game is one of six results: home or away, in regulation,
overtime or the shootout (`HOME_REG … AWAY_SO` in `simulator/src/sports/nhl/rules.ts`).

**The data does too.** Every row of `hockey/data/team_games` carries
`decided` (REG / OT / SO), the official final (overtime goals and the
shootout credit included) and the 60-minute score. The snapshot gate
`results.classified` checks every completed game: REG ⇒ the 60-minute score
is not tied and agrees with the final; OT/SO ⇒ tied at 60 minutes and won by
one. In the replayed history, 0 of 16,125 regular-season games failed this
check (`simulator/data/nhl_goal_distribution.json` `data_issues`).

---

## 3. What one simulated season does

`simulator/src/sports/nhl/module.ts`, for run *r* with master seed fixed:

1. Each club draws **one** offset `d ~ Normal(0, σ²)` on the log goal rate. It
   persists through every remaining game and the playoffs. Rates move as
   `λH·exp((dH − dA)/2)` and `λA·exp((dA − dH)/2)`.
2. Completed games are fixed exactly as played. Each remaining game is drawn
   from the served distribution at the offset rates. That is one of the six
   results above, decided by two uniforms from the `games` stream.
3. Standings: points, RW, ROW, wins and the tiebreakers (§9). A tie that
   reaches goal differential draws the remaining games' scores from the same
   score matrix, **conditional on how each game ended** (separate `points`
   stream, so it never moves a result). OT/SO winners get +1 on a tied
   60-minute score.
4. The bracket, then every series game by game, 2-2-1-1-1 from the club with
   home ice, with the same offsets. A 60-minute playoff tie goes to sudden-death
   overtime (`overtime` stream). Observed playoff games are kept; a series
   continues from its real state.
5. Outcomes are marked, and per-run sum rules are checked. A violation stops
   the run with its index.

Streams: strength 1, games 2, postseason 3, coin 4, overtime 5, points 6
(`simulator/src/core/prng.ts`). The result of run *r* depends only on
(seed, *r*), so 1 or 3 workers give byte-identical results (tested).

---

## 4. Inputs and provenance (`simulator/src/sports/nhl/inputs.ts`)

| Input | Source | Label |
|---|---|---|
| Schedule (1,344 games, designated home club, start) | `sportsdataverse/fastRhockey-nhl-raw` `nhl_schedule_2027.parquet`, the file `hockey/build_slate.js` reads; read through `hockey/tools/parquet_select.py` (python3 + pyarrow) | Observed |
| Completed results | `hockey/data/team_games/2027` (committed; from the NHL game feeds): final, 60-minute score, REG/OT/SO | Observed |
| Finals not yet ingested | `fastRhockey-nhl-raw/json/final/<id>.json`: `gameOutcome.lastPeriodType`, the final and the period scores, cross-checked against the schedule. **An unreadable one blocks the simulation**: a played game is never simulated. | Observed |
| Reconciliation | each team-game final vs the schedule's final (153 compared, 0 mismatches); a game in progress at build time blocks publication | — |
| Playoff state | completed playoff games (team_games type P) and listed playoff games (schedule) | Observed |
| Game model | the served chosen model (`live.json` `model` = `xg_core`) on ratings frozen at the as-of day; λ for every remaining game (back-to-back flags from the schedule) and every possible playoff pairing (992, no back-to-back) | Research |
| Distribution | `live.json` score effects and OT/SO parameters; the draw decision (§5) | Research |
| Strength σ | `simulator/data/nhl_strength_uncertainty.json`, interpolated at the as-of mean games played | Research |
| Goalies | `hockey/data/confirmed_starters.json` entries with `source` and `recorded_at` only (none exist today) | Observed |

**The served model, reproduced.** The snapshot path (ratings pass → `GLM.predict`
→ `applyPairCalibration`) re-prices every game of the published `hockey/slate.json`
(33 games) to its 4-decimal rounding: every |Δλ| ≤ 5e-5 (`nhl_config.test.ts`).
The research replay (`nhl_replay.ts`) reproduces the committed walk-forward
record of `xg_core` for every season from 2013-14 to 2025-26, to the last
printed digit of the per-season log loss and mean P(tie).

**Frozen pricing.** Every remaining game is priced from ratings read at the
as-of day (`ratings_day`, the first remaining game day). This was not assumed:
the strength study compared it with decaying each game's ratings to its own
date. On 2013-14 to 2024-25, pricing at the as-of day had the lower
remaining-points MSE (60.0 vs 61.1).

Ratings run through the last **ingested** game (2026-10-21). The 12 finals of
2026-10-22 count in the standings but not yet in the ratings.

---

## 5. Goal distribution: validated, not assumed

`simulator/src/research/nhl_goal_distribution.ts` scores every out-of-sample
regular-season game of 2013-14 to 2026-27 so far. All three variants share the
same λ:

- **served**: the slate's distribution.
- **inflated**: the 60-minute diagonal inflated by δ_S, fitted by maximum
  likelihood on the three seasons before S (out of sample).
- **poisson**: independent Poisson regulation goals.

| Window | Variant | P(tie) pred / obs | Tie bias | Tie log loss | 3-way LL | Score NLL | ML LL | Total disp. | Margin disp. |
|---|---|---|---|---|---|---|---|---|---|
| Selection 2013-14..2019-20 (8,544) | served | 0.2227 / 0.2334 | −0.0107 | 0.54335 | 1.05229 | 3.68191 | 0.67351 | 0.999 | 1.005 |
| | inflated | 0.2347 / 0.2334 | +0.0013 | 0.54348 | 1.05242 | 3.68204 | 0.67356 | 0.998 | 1.020 |
| | poisson | 0.1737 / 0.2334 | −0.0597 | 0.55436 | 1.06351 | 3.72347 | 0.67351 | 0.954 | 1.000 |
| Confirmation 2020-21..2025-26 (7,428) | served | 0.2024 / 0.2227 | −0.0203 | 0.53129 | 1.03702 | 3.77645 | 0.66180 | 0.957 | 0.957 |
| | inflated | 0.2178 / 0.2227 | −0.0049 | 0.53026 | 1.03600 | 3.77543 | 0.66179 | 0.955 | 0.974 |
| | poisson | 0.1592 / 0.2227 | −0.0635 | 0.54365 | 1.04945 | 3.83614 | 0.66188 | 0.898 | 1.025 |
| Live 2026-27 to date (153) | served | 0.2108 / 0.2288 | −0.0179 | 0.53820 | 1.03581 | 3.76224 | 0.65935 | 0.908 | 0.981 |

Dispersion = observed squared residual ÷ predicted variance (1 = right).

**Independent Poisson is not adequate.** It under-prices the 60-minute tie by
6 points, and over the confirmation window it predicts 1,182 loser points
against 1,654 observed. Its score likelihood is worse by 0.04 to 0.06 per game.
It has no score effects and no extra-attacker play, so it cannot produce the
mass of tied games real hockey has.

**The served model is much better but still short.** It under-prices the tie
by 1.1 points (selection) and 2.0 points (confirmation). That is about
0.85 loser points per club per 84-game season. It has the largest miss in
2025-26: 24.9% observed against 20.3% predicted (326 games past regulation
against 267). Its scoring variance is close (total and margin dispersion 0.96
to 1.0).

**Decision.** The rule was written into the study file before its first run;
the served model's confirmation-window shortfall was already known. Adopt
`inflated` only if, on **both** windows, it (1) shrinks the absolute tie bias,
(2) does not worsen the tie log loss, and (3) does not worsen the moneyline log
loss by more than 0.0002. It passed (1) and (3) on both windows, and (2) on
confirmation. It **failed (2) on selection** (0.54348 vs 0.54335). So the
simulator uses the **served distribution**, and the tie shortfall is a stated
limitation.

**Consequence for standings.** Simulated loser points run 1 to 2 percentage
points of games low. The effect is nearly uniform across clubs, so relative standings
move little. The variance-matching σ (§8) absorbs part of the lost spread. The
live season (35 games past regulation so far, 32.3 predicted) is the clean
test of this choice.

---

## 6. Overtime — model and limitations

**Regular season.** Five minutes of 3-on-3 sudden death at `k = 2.2925` ×
the regulation rate, then a shootout won by the home club at `so_home = 0.5159`.
Both are fitted on 3-on-3 seasons before the one priced (`live.json` `ot`; 869
tied games). Out of sample, from 2020-21 to 2025-26: P(decided in OT | tie)
0.678 predicted vs 0.674 observed, and home shootout win rate 0.495 vs 0.496.
The simulation reproduces its model: over 100,000 runs, 68.5% of simulated
ties ended in overtime.

**Playoffs.** Sudden death until a goal, won in proportion to the two rates.
No shootout can happen: the playoff resolver reads only the overtime split, and
a test that puts all the shootout mass on one club proves it is ignored.
Observed playoff games carry REG or OT; a playoff game marked SO is refused at
validation. None of the 1,048 playoff games from 2013-14 to 2025-26 in the
data was a shootout. In the benchmark, 21.1% of simulated playoff games went to
overtime, against 23.2% in those 1,048 games (243). That gap is consistent with
the under-priced 60-minute tie (§5). Simulated series averaged 5.73 games.

**Limitations (stated in the registry and shown to readers):**
- **OT/SO split by format only.** The overtime rate is `k` × each club's
  regulation rate. It ignores 3-on-3 skill: some clubs are better 3-on-3 than
  their 5-on-5 rates imply. The shootout is a league-wide home rate, with no
  shooter or goalie skill. That moves ROW and RW tiebreaks, not points.
- **2025-26 miss.** The OT share of ties was 0.635 observed vs 0.702 predicted.
  The split is fitted on earlier seasons and carries such swings forward slowly.
- **Playoff overtime is sudden death with no fatigue.** A double- or
  triple-overtime game is one draw in proportion to the regulation rates, with
  no tiring, no matchup or line changes, and no goalie effects. Playoff overtime
  scoring rates were not separately validated: there are about 20 playoff
  overtime games a season, too few to fit a playoff-specific rate.
- **The 60-minute tie is under-priced** (§5), so there are slightly too few
  overtime games and loser points, in the regular season and the playoffs.
- **No overtime rule changes** are modelled. A 2026-27 change to overtime
  length or format would need the `ot` parameters refitted.

---

## 7. Goalies and player availability — model and limitations

**Baseline assumption (no starter is invented).** No future game is priced
with a named starting goalie. The served model, `xg_core`, has no goalie
feature. Each club's goaltending enters through its goals-against and
finishing-against ratings (180-day half-life, 32-game prior). In effect, the
club's **recent mix of starters continues** for every remaining game and every
playoff game.

**Supported:** confirmed starters with provenance. A game listed in
`hockey/data/confirmed_starters.json` with a `source` and a `recorded_at` before
puck drop is priced with the served model's confirmed-goalie variant,
`xg_goalie_confirmed`, using the confirmed goalie's rating. A side without a
confirmation falls back to that variant's projection, as the slate does. An
entry without a source and time is ignored, and the snapshot records which
games used one (`model.goalies` gate). **Today no such file exists, so every
game is on the baseline.**

**Not used:** projected starters. `hockey/model/ratings.js` `projectStarters`
(recent usage plus the back-to-back rule) does have provenance, but the
projected-goalie model **did not beat `xg_core`** under the walk-forward
selection rule (`hockey/validation/nhl_walkforward.json`). Using it would move
prices with no validated gain. For games weeks away, a projection from the last
10 starts is not information about who will start.

**Skaters:** the lineup-aware variant did not clear the selection bar, and no
pregame lineup feed exists. No skater availability is simulated.

**Limitations:**
- **No injuries, returns or new absences.** A starting goalie lost for months is
  not modelled: the club's rating carries his past games and decays only with
  the 180-day half-life. A star skater's long injury is likewise invisible
  until it shows in results. EdgeDesk owns no return-date distribution, so the
  engine's availability hook stays off. None is invented.
- **Back-to-backs** enter only through the model's `b2b` terms, flagged from
  the schedule. The model does not know which goalie starts the second night.
  The usual backup start is in its average effect only.
- **Playoff goaltending.** Playoff pairs are priced from the same frozen
  ratings with no back-to-back. A club's playoff starter is assumed to be its
  regular-season mix.
- **Goalie uncertainty sits inside σ.** The strength offset (§8) absorbs
  goaltending variance only to the extent that history's goaltending swings
  moved remaining points.

---

## 8. Persistent strength uncertainty (`simulator/src/research/nhl_strength_uncertainty.ts`)

**Method.** Frozen forecasts of every remaining game at 10, 20, 30, 41, 55 and
70 games played. Estimation seasons: 2013-14 to 2018-19 and 2020-21 to 2024-25.
2025-26 is held out. 2019-20 is excluded because the season stopped. Games are
priced by the distribution the simulator uses.

σ is the value at which the simulated variance of a club's remaining points
(persistent offsets plus game randomness) equals history's mean squared
deviation from the σ = 0 forecast. Residuals are centred per season-checkpoint
(n/(n−1)), because the league-wide loser-point shortfall of §5 is common to
every club and is not strength uncertainty. Grid 0 to 0.30 by 0.01; 300
common-random-number draws per cell; 2,000 season-bootstrap resamples.

| Games played | σ (log rate) | 95% CI | Empirical MSD | Simulated var. at σ=0 | Slope actual/forecast | Holdout 2025-26: empirical / simulated |
|---|---|---|---|---|---|---|
| 10 | 0.1153 | [0.0994, 0.1308] | 109.9 | 58.4 | 1.096 | 175.6 / 117.2 |
| 20 | 0.1210 | [0.0979, 0.1397] | 91.3 | 49.9 | 1.120 | 132.8 / 97.6 |
| 30 | 0.1244 | [0.1023, 0.1433] | 71.9 | 41.5 | 1.145 | 90.7 / 76.9 |
| 41 | 0.1134 | [0.0896, 0.1380] | 47.4 | 32.0 | 1.106 | 67.1 / 52.7 |
| 55 | 0.1269 | [0.0943, 0.1556] | 31.0 | 22.2 | 1.164 | 30.2 / 32.2 |
| 70 | 0.1405 | [0.0630, 0.1913] | 11.9 | 9.8 | 1.067 | 12.3 / 11.4 |

**Reading.**
- Without the offset, the simulation **under-disperses** remaining points by
  nearly half early in the season (58 vs 110 at 10 games). The slope of actual
  on forecast remaining points is above 1 at every checkpoint: frozen forecasts
  are too compressed. One persistent offset of about 0.12 on the log rate
  (12% on a club's goal-rate ratio) fixes the spread.
- Production uses the 10-to-20-game interpolation at the as-of 10.3 games:
  **σ = 0.1154, CI [0.0993, 0.1311]**.
- **The 2025-26 holdout was much more volatile** than the calibration (176 vs
  117 at 10 games, 133 vs 98 at 20). It is stated, not tuned away. A σ fitted
  to 2025-26 alone would be larger.
- The uncentred σ (0.1116 at 10 games) shows the centring choice moves σ by
  about 3%.

---

## 9. Rules (`simulator/src/sports/nhl/rules.ts`)

### 9.1 Points
2 for any win (regulation, overtime or shootout), 1 for an overtime or shootout
loss, 0 for a regulation loss. GF and GA are the official final: overtime goals
count, and the shootout winner is credited one goal and the loser one against.
Identity, checked per traced run and summed over every run's points histogram:
league points = 2 × games + games decided past 60 minutes.

### 9.2 Tiebreakers (clubs tied in points)

| Step | NHL-TB-2019 (2019-20 on; applied to 2026-27) | NHL-TB-2014 (2013-14..2018-19, history only) |
|---|---|---|
| 1 | points percentage (fewer games played) | points percentage |
| 2 | regulation wins (RW) | regulation + overtime wins (ROW) |
| 3 | regulation + overtime wins (ROW) | head-to-head points |
| 4 | total wins (shootout wins included) | goal differential |
| 5 | head-to-head points, as % of points available, odd games excluded | — |
| 6 | goal differential (OT goals and shootout credit included) | — |
| 7 | goals for | — |
| beyond | seeded coin toss, flagged `tiebreak_coin`, counted, gated ≤ 1e-4 of runs | same |

**Odd games.** When two clubs did not play an even number of home games
against each other, the first game(s) played in the city with the extra game(s)
do not count. With 84 games, every other-division same-conference pair meets
three times (2–1), so this matters in every wild-card race. The designated
home club decides the city. Neutral-site games are not flagged by the feed and
count for the designated home club.

**Three or more clubs.** Each step partitions the tied clubs. A sub-group still
tied goes on to the **next** step, with no restart; head-to-head is computed
among the clubs still tied when they reach it. The NHL text states no restart.
The only case where it matters is a three-or-more-club tie that head-to-head
splits into one club plus a still-tied pair; it is counted (`tb:head_to_head_partial`).
That happened in 1 of 100,000 benchmark runs. A synthetic test pins the
convention: P first at 6/8, then R ahead of Q on goal differential even though
Q beat R twice.

**Only reported places are broken.** A ranking asks for its top *k* places
(division top three, two wild cards, best record), so a coin toss or goals draw
is counted only when it decides something reported.

### 9.3 Qualification and bracket
- The top three of each division (D1 to D3), plus two wild cards per
  conference: the best two of the remaining conference clubs, regardless of
  division.
- The division winner with the better record meets WC2; the other meets WC1;
  D2 meets D3.
- Fixed bracket: round 2 within each half, then the conference final, then the
  Stanley Cup Final.

### 9.4 Home ice
- **Rounds 1–2: bracket placement** (D1 > D2 > D3 > wild card). A wild card
  with more points than a D3 is still the road club. This was derived from the
  owned data, not assumed. In 2016 round 2, Tampa Bay (Atlantic 2nd, 97
  points) hosted the NY Islanders (wild card, 100). A points-only rule
  contradicts that series; the test proves it.
- **Conference final and Final: the better regular-season record**, by points
  and then the tiebreakers.
- **Series 2-2-1-1-1**: games 1, 2, 5 and 7 at the club with home ice. A listed
  playoff game's venue overrides the pattern.

### 9.5 History evidence (`simulator/tests/nhl_rules_history.test.ts`)

Every season from 2013-14 to 2018-19 and from 2021-22 to 2025-26 was replayed
from `hockey/data/team_games` with its own alignment and rules version. Each
reproduces **all 15 playoff series** (16 clubs and every pairing in every
round), **home ice in all 165 series**, the 2-2-1-1-1 venue of every game, and
the Cup winner (LAK, CHI, PIT, PIT, WSH, STL, COL, VGK, FLA, FLA, CAR). Reported
ties were decided by ROW 6 times, RW 5 times and head-to-head twice; none needed
a coin.

This history **rejects**:
- ROW-first rules for 2021-22 onward
- RW-first rules for 2014-15 to 2017-18
- head-to-head before RW (contradicted in 2025-26)
- points-only home ice (contradicted in 2016)

It **cannot** tell goal differential from head-to-head order, nor test the
odd-game exclusion: no reported tie reached either. Synthetic cases cover them
(§11).

2019-20 (season stopped, qualifying round) and 2020-21 (temporary divisions,
56 games) used emergency formats and are not replayed.

### 9.6 Postseason state preserved
- Completed playoff games are fixed (winner, venue, OT). A series continues
  from its actual state at the next game number. A finished series is never
  re-simulated.
- An observed series that the standings' bracket does not contain, or games
  past a decided series, are errors, never silently dropped.

Tested on the real 2025-26 playoffs:
- Cut when round 1 ended: every round-1 winner reaches round 2 in every run,
  and every loser in none.
- Cut inside the Final: both finalists win their conference in every run.
- Everything observed: CAR wins the Cup in every run.

---

## 10. Outputs (per club; Research; count, probability, MCSE, Wilson 95%)

| Key | Meaning | Sum per run |
|---|---|---|
| `win_division` | regular-season division winner (D1) | 1 per division |
| `conference_best_record` | best regular-season record in the conference (the top seed: the better division winner) | 1 per conference |
| `presidents_trophy` | best regular-season record in the league | 1 |
| `make_playoffs` | one of the 16 | 8 per conference |
| `bracket_d2`, `bracket_d3` | division 2nd / 3rd | 1 per division each |
| `bracket_wc1`, `bracket_wc2` | first / second wild card | 1 per conference each |
| `reach_round_2`, `reach_conference_final` | round advancement | 4 / 2 per conference |
| `win_conference` | **playoff** conference title (reach the Final) | 1 per conference |
| `win_stanley_cup` | Stanley Cup | 1 |

The **regular-season honours** (`win_division`, `conference_best_record`,
`presidents_trophy`, category `regular_season`/`division`) are separate
outcomes from the **playoff titles** (`win_conference`, `win_stanley_cup`). A
test proves they differ.

Each club also carries `mean_points` and `points_hist`, the regular-season
points distribution from 0 to 168.

---

## 11. Tests (2026-10-23, this environment; all passing)

| Suite | Assertions | Covers |
|---|---|---|
| `simulator/tests/nhl_rules_synthetic.test.ts` (SYNTHETIC) | 59 | points accounting; OT- and shootout-loss treatment (1 point, a loss, no ROW for shootout wins); RW-first vs ROW-first; ROW then wins; head-to-head with the odd game excluded (a case the exclusion flips); three clubs with no restart; goal differential, goals for and the coin; only reported places broken; crossover wild cards; better division winner vs WC2; home ice by placement then record; 2-2-1-1-1; series continuing from 3-0; finished series kept; invalid observed games refused |
| `simulator/tests/nhl_rules_history.test.ts` | 72 | §9.5 |
| `simulator/tests/nhl_config.test.ts` | 19 | alignment re-derived from the schedule (112/128/256 pairs meeting 4/3/2 times); club identities; slate re-priced exactly; back-to-back flags from the schedule; each fact VERIFIED with its NHL.com URL, page sha256, run, verifier and date |
| `simulator/tests/nhl_sim.test.ts` | 53 | zero offset = the served distribution exactly; table within 1e-4 (measured 3.9e-5); OT split exact; simulated tie/OT frequencies = the model's; reproducibility, range additivity, 1 vs 3 workers identical; persistent offsets in regular season and playoffs; completed games fixed; exact points/RW/ROW accounting; all-shootout override; playoff OT never a shootout; **championship sums** (Cup 1, Final 2, CF 4, R2 8, playoffs 16, Presidents' Trophy 1, best record 2, division winners 4) and nesting; postseason state on the real 2025-26 playoffs; fail-closed validation (incl. a game in progress at build time); the command line |

**Mutation checks.** Each of these was injected into `rules.ts` and failed the
synthetic suite; the file was then restored:
- no odd-game exclusion
- no RW step
- home ice by record in every round
- shootout wins counted as ROW
- no loser point
- a restart after a partial head-to-head split
- WC1/WC2 swapped

**Also re-run and passing:** every existing simulator suite (core, hooks, NFL
history/synthetic/simulation/config, markets, reader, command line, publisher;
the CLI and publisher were refactored to share the run gates), the reader in
Chromium (31 at first; 43 with the NHL scenario), `tools/app/navigation.test.js` (256),
`tools/portfolio/portfolio_ui.test.js` (101), typecheck (strict) clean, and the
generated-file checks current. The SQL suite was not re-run: no SQL changed.

---

## 12. Benchmark (actual, 2026-10-23)

`node simulator/src/cli/run.ts --sport nhl --runs 100000 --workers 4 --dry-run`

| Measure | Value |
|---|---|
| Inputs | `7c2a6196a78f…`; 165 completed, 1,179 remaining; σ 0.1154 |
| Simulation | **100,000 runs in 17.7 s** on 4 workers; about 1.7 ms per run on one thread |
| Peak RSS | 521 MB |
| Gates | all PASS except `sport.active` (BLOCKED at the time; ACTIVE since, §13) |
| Tiebreak steps deciding reported places | RW 139,473; ROW 12,697; wins 1,981; head-to-head 511; goal differential 159; goals for 3; coin 0 |
| Simulated rates | 60-minute tie 20.76%; OT share of ties 68.5%; playoff OT 21.1%; 5.73 games per series; league mean 92.8 points |

Top Cup probabilities in that dry run (Research, **not published**): CAR
16.8%, COL 12.7%, VGK 9.2%, TBL 8.2%. These are benchmark output, not a forecast
EdgeDesk publishes.

---

## 13. Verification and activation (2026-10-23)

The three 2026-27 facts in `simulator/src/sports/nhl/config.ts` were checked
against the NHL's own pages. nhl.com cannot be reached from the build
environment, so the pages were fetched by GitHub's runners: the *Simulator
source check* workflow (`.github/workflows/simulator-sources.yml`), run
39957383090, job `fetch (nhl)`, 2026-10-23 12:59 UTC, HTTP 200.

| Fact | Page | Page sha256 | Comparison |
|---|---|---|---|
| Tie-breaking procedure | https://www.nhl.com/info/standings-info/tie-breaking-procedure | `84f4dced…ff7e61e` (text `0f154a83…b773721e`) | Seven steps, identical to NHL-TB-2019 (§9.2): points percentage, RW, ROW, W, head-to-head points (odd game excluded; a percentage for three or more), goal differential and goals for, both counting OT goals and the shootout credit. The page states no step beyond goals for and no restart. |
| Playoff format | https://www.nhl.com/info/standings-info/playoff-format | `7ed14691…a346ddf7` (text `af4bc9df…9cf6a218`) | 16 teams; top three per division plus two wild cards per conference regardless of division; the division winner with the best record meets the wild card with the lesser record; second meets third within the division winner's bracket; second round within each bracket; best of seven. Identical to §9.3. |
| Home ice | the same page | the same | "Through the first two rounds [it] goes to the team that placed higher in the regular-season standings"; in the conference finals and the Final, "the team that had the better regular-season record — regardless of the teams' final standing in their respective divisions." The contrast places rounds 1–2 by divisional standing, which is what all 165 historical series show (§9.4). The 2-2-1-1-1 order is not on the page; it is the order of every one of those series' games. |

Each fact is `VERIFIED`, with `verified_by` naming this verification (Claude
Code, at the repository owner's request, from that run) and `verified_at`
2026-10-23. The registry reports the NHL **ACTIVE** with no blocker; each
season the source check is re-run and the facts re-verified.

**Reader.** `lib/edgedesk_simulator.js` renders the NHL's own outcome set; its
NFL output is byte-identical to before (checked on every view).
- **Division:** W-L-OTL, points, projected points, win division, make
  playoffs.
- **Conference:** playoffs, D1–D3, WC1/WC2, round 2, conference final, and
  the playoff conference title.
- **Title:** the Stanley Cup, with the Presidents' Trophy and best conference
  record on their own "Regular season" line.

Projected points travel inside the published entity `record` (`mean_points`),
because `sim_entity_summary` has a wins column and no points column. No SQL
change was needed: publication checks the run's own sum rules and gates.

**Nightly** (`.github/workflows/simulator.yml`):
- The NHL is a second leg of the plan (`plan.ts` `RUNNABLE`, season key
  2027), with a pyarrow step and the NHL suites in the pre-publication test
  gate. One leg's failure never stops the other.
- The markets job now compares each published sport's run against that
  sport's own Kalshi mappings (`forSport`). The NHL has none yet, so its
  comparison reads "unavailable": not mapped, not zero.
- The weekly NHL walk-forward re-run (`nhl-validate.yml`) rewrites
  `live.json`'s `generated_at` only. The snapshot's guard therefore compares
  the parameters without that stamp (`liveParamsHash`, recorded by the
  strength study). A real refit still stops the NHL leg until the study is
  re-run.

**Not done:** no Kalshi NHL futures are mapped (the source check lists 417
open NHL futures markets; mapping them follows the NFL's
`build_kalshi_mappings.ts` route), and the NHL has no research-registry
entry. Neither gates publication.

### Other limitations
(Goalies §7, overtime §6.)
- **The game model** is the served `xg_core`. Its walk-forward record beats
  Elo, but it was never tested against closing prices (`value_claims` DISABLED
  on the slate).
- **Ratings are frozen** at the as-of day. Simulated results do not update
  ratings, and within-season drift is off.
- **The 2025-26 holdout was more volatile than the σ calibration.**
- **Monte Carlo ± is simulation noise only**, never model accuracy.

---

## 14. Running it

```
pip install pyarrow                                            # the schedule parquet (build only)
node simulator/src/cli/run.ts --sport nhl --workers 4 --dry-run   # build a snapshot and simulate 100,000 seasons
# production: the nightly Simulator workflow (10:17 UTC), or Actions -> Simulator -> Run workflow (sport nhl, season 2027, publish)
node simulator/src/cli/run.ts --sport nhl --snapshot <dir>/snapshot.json --dry-run   # replay a frozen snapshot
node simulator/src/research/nhl_goal_distribution.ts           # §5 (≈16 s)
node simulator/src/research/nhl_strength_uncertainty.ts        # §8 (≈2.3 min)
node simulator/src/cli/build_fixture.ts --sport nhl [--from <snapshot>]   # rebuild the test fixture
npm run sim:test                                               # every simulator suite
```

## 15. Files

```
NHL_SIMULATOR_NOTES.md                          this file
simulator/src/sports/nhl/config.ts              2026-27 alignment, season facts (verification), availability, historical alignments
simulator/src/sports/nhl/rules.ts               points, tiebreakers, qualification, bracket, home ice, series, postseason state
simulator/src/sports/nhl/model_adapter.ts       the served distribution: outcome table, OT/SO split, offsets, score draws
simulator/src/sports/nhl/inputs.ts              the frozen, hashed input snapshot
simulator/src/sports/nhl/validate.ts            input gates
simulator/src/sports/nhl/module.ts              one simulated season
simulator/src/sports/nhl/history.ts             completed seasons from hockey/data/team_games
simulator/src/research/nhl_replay.ts            the walk-forward replay and frozen forecasts
simulator/src/research/nhl_goal_distribution.ts -> simulator/data/nhl_goal_distribution.json
simulator/src/research/nhl_strength_uncertainty.ts -> simulator/data/nhl_strength_uncertainty.json
simulator/fixtures/nhl_2027_snapshot.json.gz    test fixture (inputs only)
simulator/tests/nhl_*.test.ts                   four suites
modified: simulator/src/core/engine.ts (regular_season category, value descriptor), core/results.ts (points instead of wins),
          cli/run.ts (NHL path, shared gates), cli/build_fixture.ts, publish/publish.ts (null wins for NHL),
          sports/factory.ts, sports/registry.ts (NHL status, blockers, limitations), lib/edgedesk_simulator_sports.js (generated),
          simulator/tests/_fixture.ts, package.json (scripts), .github/workflows/simulator-tests.yml, SIMULATOR_NOTES.md
```

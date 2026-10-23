# MLB_SIMULATOR_NOTES — EdgeDesk MLB season and postseason simulator

The engineering record of the MLB simulator: what the repository holds for
each input, what was built on it, what was measured, and what blocks
publication. The shared engine, database layer, reader and NFL module are
described in [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md); the runbook is
[`docs/simulator/README.md`](docs/simulator/README.md).

Dates are UTC. Work done 2026-10-23. Nothing here claims a validated edge,
production readiness or a deployment: §15 states exactly what exists.

**The two questions asked, answered first.**

- **Rotation uncertainty** (§8). A starter is *Observed* (completed game),
  *Confirmed* (the announced probable of a scheduled game) or *Projected*.
  A projected start is never one name: every run draws it from a rotation
  model whose two uncertainty terms, a member leaving the rotation and a
  spot start, are measured on 2018–2023 rotations. Measured accuracy of the
  deterministic rule: the next regular-season start is named correctly 63%
  of the time (2018–2023), 30% twenty games out; a postseason start 52%.
  The output reports a distribution of starters per game, with the
  replacement (an unnamed starter) as one of its outcomes.
- **Bullpen fatigue is NOT modelled** (§9). No owned data records relief
  usage; relief innings live inside each club's run-prevention rating, and
  no reliever's workload, rest or availability enters a game.

---

## 1. Status in one table

| Area | State | Evidence |
|---|---|---|
| Rules: standings, 2022 tiebreak procedure, qualification, seeds, byes, bracket, series lengths and hosts, World Series home field | Implemented; reproduces every pairing and the host of every one of the 494 postseason games of 2012–2025 (2020 excluded) from the regular-season logs alone | `simulator/tests/mlb_rules_history.test.ts` (56), `mlb_rules_synthetic.test.ts` (62) |
| MLB's own 2024 data (Stats API) through the rules | 2024 seeds (incl. the ATL/NYN/ARI three-club tie) and every 2024 postseason host reproduced | `mlb_statsapi.test.ts` (26) |
| Schedule grammar: completed games fixed, dates, doubleheaders, postponements, suspensions, cancellations | Implemented; parser tested on MLB's real 2024 schedule response | `src/sports/mlb/statsapi.ts`, `mlb_statsapi.test.ts` |
| Game model | The served MLB lab brain (`mlb/history/model.js`, v1.1.0) replayed point-in-time; replay equals `walkforward.pass()` | `mlb_model.test.ts` (17), §6 |
| Run distribution / extra innings validation | Study written and committed | `simulator/data/mlb_game_model_study.json`, §6.3 |
| Persistent club and starter strength uncertainty | Calibrated from frozen forecasts (2012–2023), 2025 holdout reported | `simulator/data/mlb_strength_uncertainty.json`, §7 |
| Starting-pitcher rotation model | Implemented; uncertainty terms fitted on 2018–2023 | `simulator/data/mlb_rotation_study.json`, `mlb_rotation.test.ts` (35), §8 |
| Bullpen usage / fatigue | **Not modelled** (no owned data) | §9 |
| Season simulation, postseason game by game | Implemented, tested on committed 2025 snapshots | `mlb_sim.test.ts` (46), §10 |
| Season backtest (2022, 2023, 2025) | Run, descriptive only | `simulator/data/mlb_backtest.json`, §11 |
| Live 2026 inputs (MLB Stats API) | Run on a GitHub runner (Simulator run 39994766921, 2026-10-23): every gate but `sport.active` passed; all 30 records equal MLB's standings | `statsapi.ts`, §5.2, §15 |
| Registry status | **ACTIVE** (facts read from MLB on GitHub's runners) | `src/sports/registry.ts`, §15 |
| Publication | Nightly through the World Series, or by dispatch; the first runs from `main` after the merge | §15 |

---

## 2. What the repository holds for each input (inspected before building)

| Input | What exists | What the simulator does with it |
|---|---|---|
| **Run scoring** | `mlb/history/model.js`: a point-in-time Poisson-likelihood fit of team offence `o`, run prevention `d`, starter effect `s` and park `k` on Retrosheet game logs 2010–2025, negative-binomial runs of size `r` (fitted by likelihood on the three earlier seasons: r = 4 every season 2012–2026), extra-inning home rate `xi`, logistic recalibration. Walk-forward record `mlb/history/validation/mlb_walkforward.json`: moneyline PROVISIONAL (does not beat Elo: Δ log loss vs Elo +0.0009, 95% CI [−0.0001, +0.0019]); run line OUTCOME_VALIDATED; totals PROVISIONAL (slope 0.69). The browser card's engine `mlb/engine.js` needs live database inputs (`mlb_game_cards`, `team_season`, `pitcher_season`) that are not in the repository and has no record. | Uses the lab brain, the only owned model with a record and starter terms, in the weekly loop's served configuration (`docs/model-loop/mlb/versions.json` current 1.1.0). |
| **Starting pitchers** | Retrosheet actual starters for every game 2010–2023 and 2025, and every postseason game 2012–2025; **none for 2024** (the data pack's StatsAPI table). The lab brain's `s` is shrunk hard (`prior_starts` 128): sd 0.028 log runs, aces ≈ +0.10 to +0.16. Probable starters were never archived (`DATA_AUDIT.md`). | Starter effect `s` per named pitcher; rotations built from actual starts (§8). |
| **Bullpen** | Nothing game-level. Retrosheet game logs carry starters and decision pitchers only. `mlb_bullpen_taxed` / `mlb_bullpen_team` exist only in the database, with no history to validate against; `mlb/engine.js` approximates relief with the club's whole-staff runs allowed plus flags. `DATA_AUDIT.md`: "Bullpen fatigue … no data … infeasible". | **Not modelled** (§9). |
| **Lineups** | None. The lab brain has no lineup input; `mlb/batters/dataset` is season-level batting. | Not modelled; offence is a club rating. |
| **Park** | The lab brain's `k` per home franchise (prior 120 games, decayed so a new park re-learns). `mlb/engine.js`'s park index lives in `mlb_game_cards` (database only). | The served `k` of the home club. A neutral-site game (Tokyo, London, Mexico City, …) is priced at the home club's park: stated limitation. |
| **Weather** | None historically (`mlb_game_cards` is live only). | Not modelled. |

### 2.1 Network reachability (it decides two blockers)

| Host | Reachable from the build environment | Consequence |
|---|---|---|
| `raw.githubusercontent.com` (Retrosheet mirror, Chadwick register) | yes | postseason logs 2012–2025 committed as a fixture; the id crosswalk is fetched live |
| `statsapi.mlb.com` | **no** (egress policy 403) | the 2026 schedule, results and probables cannot be read here; the parser is tested on MLB's real 2024 response in the data pack |
| `mlb.com`, `retrosheet.org`, Wikipedia, Baseball-Reference | **no** | no 2026 rule could be read from MLB's own pages: every 2026 fact is UNVERIFIED |
| Supabase | no credentials | nothing applied |

---

## 3. Files

```
MLB_SIMULATOR_NOTES.md                          this file
simulator/src/sports/mlb/config.ts              clubs (Retrosheet keys + MLB ids), alignment by season, formats by season, the 2026 facts
simulator/src/sports/mlb/history.ts             the owned game record (regular season CSVs, postseason fixture)
simulator/src/sports/mlb/rules.ts               standings, tiebreaks, qualification, seeds, bracket, series state machine
simulator/src/sports/mlb/rotation.ts            Observed / Confirmed / Projected starters, rest, doubleheaders, postseason rule, uncertainty
simulator/src/sports/mlb/model_adapter.ts       the served lab brain: point-in-time replay, calibration, fast win table
simulator/src/sports/mlb/inputs.ts              the snapshot (history builder) and its hash
simulator/src/sports/mlb/statsapi.ts            the live 2026 builder (schedule, box scores, crosswalk)
simulator/src/sports/mlb/module.ts              one simulated season and postseason
simulator/src/sports/mlb/validate.ts            input gates, math status
simulator/src/research/build_mlb_history_fixture.ts, mlb_replay.ts, mlb_game_model_study.ts,
                       mlb_rotation_study.ts, mlb_strength_uncertainty.ts, mlb_backtest.ts
simulator/src/cli/build_mlb_fixture.ts, probe_mlb_live.ts
simulator/data/mlb_game_model_study.json, mlb_rotation_study.json, mlb_strength_uncertainty.json, mlb_backtest.json
simulator/fixtures/mlb_postseason_2012_2025.json        Retrosheet postseason logs, 547 games
simulator/fixtures/mlb_2025_ws_g3_snapshot.json.gz      2025, the morning of World Series game 3
simulator/fixtures/mlb_2025_aug15_snapshot.json.gz      2025, 2025-08-15
simulator/research/registration_mlb.json                preregistration (EXPERIMENTAL, T3), not yet in the SQL registry
simulator/tests/mlb_*.test.ts, _mlb_fixture.ts
modified: simulator/src/core/{prng.ts (streams 9, 10), csv.ts (headerless rows)}, sports/{factory,registry}.ts,
          cli/{run,plan}.ts, lib/edgedesk_simulator_sports.js (generated), package.json (sim:*mlb* scripts),
          .github/workflows/simulator-tests.yml, simulator.yml, SIMULATOR_NOTES.md, docs/simulator/README.md
```

---

## 4. Rules (`simulator/src/sports/mlb/rules.ts`, `config.ts`)

### 4.1 Formats by season

| Seasons | Format | Field | First round | DS | LCS | World Series home field |
|---|---|---|---|---|---|---|
| 2022–2026 | `MLB-2022` | 6 per league: 3 division winners (seeds 1–3 by record), 3 wild cards (4–6); seeds 1–2 bye | Wild Card Series best of 3, every game at the higher seed (3 v 6, 4 v 5) | best of 5, 2-2-1 (1 v W4/5, 2 v W3/6, no reseeding) | best of 7, 2-3-2, higher seed | better record (equal: the tiebreak procedure) |
| 2013–2019, 2021 | `MLB-2012` | 5 per league | one Wild Card Game at the higher seed | 2-2-1 | 2-3-2 | All-Star Game league 2013–2016; better record 2017– |
| 2012 | `MLB-2012` | 5 per league | one game | **2-3** (the lower seed hosts games 1–2) | 2-3-2 | All-Star Game league (NL) |
| 2020 | — | refused (16 clubs, neutral-site rounds, its own tiebreak list) | | | | |

Under MLB-2012 a tie for a division title or a berth was settled by a
tiebreaker game, which the logs record as a regular-season game, so a
replay of history never meets one; a simulated MLB-2012 season would have
to play it, and the engine refuses (`UnsupportedTie`) instead of inventing
one. The simulation module runs MLB-2022 only.

### 4.2 Tiebreaks (MLB-2022; **UNVERIFIED** against MLB's text, MEASURED in every run: §15)

1. head-to-head winning percentage, combined among the tied clubs;
2. winning percentage in intradivision games;
3. winning percentage in interdivision games within the league;
4. winning percentage in the last half of intraleague games;
5. the last half plus one intraleague game, skipping games between the tied
   clubs, one game at a time;
6. exhausted: a seeded draw, flagged `tiebreak_exhausted`, counted and gated.

One club is placed per pass; when a step separates the best clubs from the
rest without naming one, the procedure restarts at step 1 among the best.
A step with no games behind it for some tied club is passed over. Ties in a
completed game (a called game never resumed) count in neither column.

Recalled, not read: mlb.com was unreachable. **Evidence:** the 2022–2025
replays needed head-to-head only (2022 NL East, 2023 AL West, 2023 NL wild
cards, 2024 AL wild cards, the 2024 three-club NL tie, 2025 AL East, 2025 NL
wild cards) and reproduce every seed; steps 2–5 are covered only by
SYNTHETIC fixtures (each asserts its clubs are level first).

### 4.3 Reproduction against history

`mlb_rules_history.test.ts` replays every season 2012–2025 except 2020 from
the committed regular-season logs (game 163s included, as MLB counts them)
and plays the engine's bracket against the Retrosheet postseason: every
pairing exists, every one of the 494 games is hosted by the club the format
says, every logged game is used exactly once. That pins qualification,
every seed position (a swapped seed changes a pairing or a host), the
series lengths, 2012's 2-3 Division Series and the World Series home-field
rule of each year (the 2012–2016 All-Star Game results, recalled, are
checked this way). `mlb_statsapi.test.ts` repeats the 2024 check on MLB's
own Stats API data, an independent source.

---

## 5. The schedule

### 5.1 Completed games fixed, remaining games simulated in date order

Every game dated before the as-of morning is final and fixed at its real
result; every other game is simulated, in date order, doubleheader game 1
before game 2. Completed postseason games are fixed too; a scheduled one
keeps its date (and any announced starters); a postseason game the
schedule does not date yet takes the **Estimated** calendar (the 2025
calendar as offsets from the last regular-season date; a calendar never
runs backwards inside a series). The `postseason.consistent` gate refuses a
snapshot whose completed postseason games are not the bracket the final
standings produce, at the format's hosts.

### 5.2 The live feed's grammar (`statsapi.ts`)

| Case | Handling | Real 2024 example (tested) |
|---|---|---|
| a postponed game | listed twice under one `gamePk`; kept once, at its new date | 746816: postponed 04-03, played 06-27 |
| a suspended game resumed later | listed on both days, both final; kept once at its `officialDate` (the day its starters started) | 745180 (05-21 → 05-22), 746942 (06-26 → 08-26) |
| a cancelled game | dropped and counted (never played) | 746577 CLE-HOU 09-29: CLE and HOU 161 games |
| doubleheaders | `doubleHeader` Y/S and `gameNumber` 1/2 | 59 games; ATL-CIN 07-24 keeps "game 1" after its game 2 moved |
| a postponed game with no new date | kept, simulated after the last scheduled date, gate WARN | SYNTHETIC |
| postseason | game types F/D/L/W → WC/DS/LCS/WS, `seriesGameNumber`; placeholders without clubs skipped | 9 / 18 / 11 / 5 games |
| starters | box score: the first pitcher listed (all 30 real feeds: credited with the start); scheduled games: the announced probable → Confirmed | |
| ids | Chadwick register MLBAM → Retrosheet, so a 2026 starter keeps his 2010–2025 rating | |

**Never run against the live 2026 feed.** The `mlb-live-probe` job in
`.github/workflows/simulator-tests.yml` reads the live schedule, one box
score and the register on a GitHub runner (writing nothing); the
`live_inputs` fact stays UNVERIFIED until a person checks one live build.

### 5.3 A defect found in the committed 2024 table

`mlb/history/data/2024.csv` (from the data pack's StatsAPI table) counts the
three suspended-and-resumed games twice (BAL, BOS, CHA, SLN, TEX, TOR show
163 games). The simulator's loader drops the later copy (`history.ts`). The
lab brain's own record (`mlb/history`) still contains the duplicates; it
was not regenerated here (it would move the served record), and is flagged
as follow-up work.

---

## 6. The game model (`model_adapter.ts`)

### 6.1 What is priced

```
log E[home runs] = mu + home + o_home - d_away - s_awaySP + k_park
log E[away runs] = mu + o_away - d_home - s_homeSP + k_park
P(home) = recal( P(H > A) + P(H = A) * xi ),   H, A ~ NegBin(mean, size r)
```

exactly as `walkforward.js` prices a game. The replay walks 2010 → as-of
date by date (fit on earlier dates, predict, absorb) and captures the full
state at the as-of morning; `mlb_model.test.ts` holds it equal to
`walkforward.pass()` on every 2010–2011 game (relative difference < 1e-12)
and the recalibration equal to `walkforward.priced()`. The served model
absorbs regular-season games only. In a run the two lambdas move by the
persistent offsets; P(H > A) and P(H = A) come from a table over log
lambdas (0.01 apart), within 1.3e-5 of `model.js game()`.

### 6.2 Extra innings and the regular-season vs postseason rule

Innings are never played out (no situational scoring mechanic is
introduced). The rule in force only selects which **measured** home win
rate resolves a level regulation draw:

| Rule | Used for | Home win rate in extra-inning games | n |
|---|---|---|---|
| automatic runner on second | regular season 2020– | the season's served `xi` (three earlier seasons); 0.500 [0.468, 0.532] pooled 2020–2025 | 910 |
| standard | **every postseason game** (MLB never uses the runner there) | **0.517** [0.496, 0.538]: regular season 2010–2019 + postseason 2012–2025 | 2,170 |

The difference (+0.017, 95% CI [−0.022, +0.056]) is not statistically
distinguishable; the postseason uses the standard-rule rate because that is
the rule its games are played under, not because the data prove a gap.
Postseason games cannot end tied; neither can simulated regular-season
games.

### 6.3 Validation (`simulator/data/mlb_game_model_study.json`, out of sample)

- **Run distribution** (2018–2025, 35,812 team-games): mean bias +0.009 runs
  a side; variance about the mean 9.97 observed vs 9.69 model (−3%); the
  model PMF within 1.2 points of the observed frequency at every count
  0..15+, the largest gap at zero runs (6.4% observed vs 5.2%). By decile of
  the predicted mean the spread is too wide at the ends (lowest decile 3.45
  predicted vs 3.61 observed; highest 5.82 vs 5.52), which the served
  recalibration (slope ≈ 0.91) is there to absorb.
- **Extra innings:** the model's level-after-nine mass is 9.7–11.0% each
  season against an observed extra-inning share of 7.5–10.0% (postseason
  10.8% vs 8.7%): the negative binomial is fitted on final scores, and its
  level mass is a construction the recalibration absorbs, not a measured
  rate of extra innings. Simulated extra-inning counts are therefore not
  reported as a forecast.
- **The postseason** (494 games 2012–2025 ex 2020, frozen at each season's
  end, actual starters): log loss 0.6942 against a coin's 0.6931, Brier
  0.2505 vs 0.2500, calibration in the large +0.002. **The served model
  shows no skill in postseason games**; postseason advancement
  probabilities inherit that.

---

## 7. Strength uncertainty (`simulator/data/mlb_strength_uncertainty.json`)

Once per run, kept through the regular season and the postseason:
`theta_t ~ N(0, sigma_team²)` per club (runs scored × e^(θ/2), allowed ×
e^(−θ/2)) and `phi_p ~ N(0, sigma_sp²)` per named starter (his opponents'
runs × e^(−φ)). Frozen forecasts of 2012–2023 (2020, 2024 out) with
projected starters, against what happened:

| Term | Value | 95% interval | Method |
|---|---|---|---|
| sigma_sp | 0.067 log runs | [0.045, 0.082] (season bootstrap) | within-pitcher minus within-club covariance of relative run residuals; 2025 alone: 0 |
| replacement starter | s = −0.036 (3.7% more runs than average) | 66,044 starts | runs / lambda(s = 0) over starts outside the as-of rotation; rotation members: 1.004 |
| sigma_team, stage 20 / 40 / 60 / 81 / 100 / 120 / 140 games | 0.137 / 0.136 / 0.135 / 0.150 / 0.147 / 0.135 / 0.110 | e.g. stage 81 [0.114, 0.184]; stage 140 [0, 0.164] | win-total calibration (simulated variance of remaining wins = mean squared deviation), 200 draws, grid 0–0.30 |

Without the offsets the frozen forecasts under-disperse remaining wins by a
factor of 2.3 at 20 games, 1.9 at 81, 1.14 at 140. The 2025 holdout's
matching sigma swings from 0.01 to 0.26 by stage (one season). After the
regular season no remaining games exist to calibrate against: the
postseason carries the stage-140 sigma, stated, not tested.

---

## 8. Starting pitchers and rotation uncertainty (`rotation.ts`, `simulator/data/mlb_rotation_study.json`)

### 8.1 Labels, and what is never claimed

| Label | Meaning | Where |
|---|---|---|
| Observed | the actual starter of a completed game | snapshot |
| Confirmed | the announced probable of a scheduled game, used as announced, no draw | snapshot (`starters.labels` gate) |
| Projected | everything else; exists only inside a run | results: a distribution per game |

A snapshot can never store a Projected starter (gate). The results'
`starting_pitchers.by_game` gives, per game and club, the share of runs
each pitcher started it, the unnamed replacement included. On the
2025-10-27 fixture: game 3 Glasnow / Scherzer (Confirmed, 100%); game 4
Kershaw 80% / replacement 20% for the Dodgers (Ohtani actually started:
his 2025 pitching `s`, −0.038 on a short sample, keeps him out of the
four best by `s`), Varland 80% / replacement 20% for Toronto.

### 8.2 The rule (one rule, every date, every doubleheader, every round)

- **Rotation at the as-of date:** the last five distinct starters. (In an
  exploratory comparison before the study, larger or frequency-based sets
  projected no better, and the cycle rule over the last six distinct
  starters named the next start 18% of the time.)
- **Rest:** a member is rested after 5 calendar days (four days of rest);
  99.5% of 54,279 regular-season repeat starts 2012–2025 came on at least
  that. The clock runs on calendar dates through the regular season, the
  off days between rounds and every round.
- **Regular season:** the rested member with the oldest last start; nobody
  rested → a replacement.
- **Doubleheaders:** game 1 then game 2 on the same clock, so game 2 falls to
  a replacement unless an off day rested a second member. Observed starts
  outside the rotation (first turn, 2018–2023): single games 15.1%,
  doubleheader game 1 22.8%, game 2 43.0%; the rule alone forces a
  replacement in 27.7% of second games, the measured spot rates cover the
  rest.
- **Postseason:** the four present members with the best `s`; the best
  rested one starts; if a member has departed, a replacement fills his
  vacant slot; only with four present and none rested does one go on short
  rest (four calendar days). One-step-ahead accuracy on 808 postseason
  starts 2012–2023: 51.7% [48.3, 55.2] (2025: 51.1%), against 50.1% for the
  four most recent starters, 23.5% for a cycle among the best four and
  12.1% for the plain cycle.

### 8.3 The uncertainty (drawn on the rotation stream, persistent within a run)

| Term | Value (fitted on 2018–2023) | Meaning |
|---|---|---|
| departure | survival 0.91 after 10 club games, 0.87 / 0.78 / 0.72 / 0.66 / 0.55 after 20 / 40 / 60 / 80 / 140 | a member leaves the rotation (injury, demotion) for the rest of the run; his slot becomes a replacement, postseason included |
| spot start, single game / dh 1 / dh 2 | 14.1% / 22.8% / 21.2% | an opener, bullpen game or call-up at the replacement level; it takes the turn of the member the rule would have started (the convention whose simulated hit curve is closer to the observed one: mean gap 0.10 vs 0.22) |
| spot start, postseason | 20.3% (starts outside the four-man rotation, 2012–2023) | same; neither convention reproduces the observed 4.0% of member starts on short rest (simulated ≈ 0.1%) |

What the simulated rotations reproduce (2025 holdout, k = club games ahead):

| k | observed: named | simulated: named | observed: from the rotation | simulated: from the rotation |
|---|---|---|---|---|
| 1 | 70% | 60% | 76% | 85% |
| 5 | 68% | 59% | 88% | 86% |
| 20 | 37% | 21% | 78% | 76% |
| 60 | 15% | 8% | 61% | 62% |

The share of starts made from the as-of rotation is matched within ~3
points (mean absolute gap 0.027 over k = 1..60). Which member starts which
game is spread wider than reality (named correctly 7–16 points less often),
because a simulated spot start can hit any member while real ones cluster on
the fifth starter. That is the conservative side: the simulator is less
certain about a game's starter than history warrants, never more.
Rotations were less stable in 2018–2023 (next start named 63%) than in
2012–2017 (74%): the fit uses the recent era.

---

## 9. Bullpen fatigue: not modelled

- **Why.** No owned dataset records relief appearances by game: the
  Retrosheet game logs carry starters and the winning/losing/saving pitchers
  only; the live bullpen flags (`mlb_bullpen_taxed`, `mlb_bullpen_team`)
  exist only in the database, with no history to validate a fatigue effect
  against (`DATA_AUDIT.md` lists bullpen fatigue as infeasible).
- **What the simulator does instead.** The served model's club run
  prevention `d` covers every inning the starter's effect `s` does not,
  relief included, as an average over the fit window. A taxed bullpen after
  a doubleheader or a long postseason series is priced like any other day.
- **What is not claimed.** No reliever availability, no closer, no
  high-leverage usage, no fatigue across consecutive postseason games.
- `config.bullpen.mode` is `off` and the module refuses any other value.

---

## 10. The simulation (`module.ts`)

Per run: persistent offsets (θ per club, φ per named starter), rotation
departures, then every remaining regular-season game in date and
doubleheader order (starters Confirmed or Projected, the served price with
the season's `xi`), standings and the tiebreak procedure, seeds, then the
postseason game by game through the season's bracket (completed games
fixed, the format's hosts, the calendar's dates, the postseason rotation on
the same rest clock, `xi` of the standard rule). Streams: strength,
pitcher (10), rotation (9), games, postseason, coin.

**Outcomes per club:** win division · make postseason · seeds 1–6 (1–2
"bye") · first-round bye · reach Division Series (byes included) · reach
LCS · win pennant · win World Series. **Sum rules checked every run:** one
division winner per division; per league 6 postseason clubs, one club per
seed, 2 byes, 4 Division Series and 2 LCS clubs, one pennant; one champion.
Mean wins and the wins histogram per club; diagnostics count tiebreak steps
used, replacement and short-rest starts, fixed and simulated postseason
games. Provenance: Observed (records, completed results), Confirmed
(announced starters), Research (simulated probabilities), Estimated (the
postseason calendar, the replacement level). Math status: sufficient
conditions mid-season; after the regular season, the final standings
through the tiebreak procedure (exact).

---

## 11. Backtest (`simulator/data/mlb_backtest.json`, descriptive only)

2022, 2023, 2025 × as-of stages 40 / 81 / 120 / 140 games × 2,000 runs, the
production sigmas against sigma = 0, scored on what happened (360 club ×
stage rows per family):

| Family | Brier, production | Brier, sigma 0 | Δ 95% CI (3-season bootstrap) | Log loss prod / sigma 0 | 2025 Brier prod / sigma 0 |
|---|---|---|---|---|---|
| Win division | 0.0853 | 0.0894 | [−0.0132, +0.0051] | 0.277 / 0.299 | 0.1366 / 0.1497 |
| Make postseason | 0.1059 | 0.1087 | [−0.0053, +0.0007] | 0.320 / 0.332 | 0.1314 / 0.1354 |
| Win pennant | 0.0626 | 0.0647 | [−0.0035, −0.0012] | 0.229 / 0.241 | 0.0557 / 0.0569 |
| Win World Series | 0.0307 | 0.0312 | [−0.0016, +0.0002] | 0.116 / 0.116 | 0.0282 / 0.0280 |

The offsets score better on every family pooled, but 2022–2023 are
in-sample for the sigmas, three seasons cannot decide anything (the
intervals are a three-cluster bootstrap), and 2025's World Series family is
slightly worse. No market baseline exists (no owned MLB futures prices).

---

## 12. Tests and actual results (2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `mlb_rules_history.test.ts` (2012–2025 ex 2020, 494 postseason games) | 56 | pass |
| `mlb_rules_synthetic.test.ts` (SYNTHETIC: every tiebreak step, restart, multi-club, last half + 1 skip, exhaustion, qualification, byes, every series' host order and length, 2012's 2-3, WS home field, refusals) | 62 | pass |
| `mlb_rotation.test.ts` (rest, doubleheader sequencing, progression across dates and rounds, vacancy before short rest, departures, spot conventions, labels; module-level invariants over simulated seasons) | 35 | pass |
| `mlb_model.test.ts` (replay parity, price parity, table error, extra-inning rule by phase, run-distribution study bounds) | 17 | pass |
| `mlb_sim.test.ts` (fixed completed postseason results, in-run series order and lengths, qualification identities, determinism, 1 vs 3 workers, gates, CLI, plan) | 46 | pass |
| `mlb_statsapi.test.ts` (MLB's real 2024 schedule and box scores; MLB's 2024 data through the rules; SYNTHETIC grammar cases) | 26 | pass |
| `mlb_config.test.ts` (alignment from the logs 2012–2025, formats, facts, registry, calendar, study files) | 37 | pass |
| existing simulator suites (core 37, hooks 23, NFL history 242, NFL synthetic 62, NFL sim 32, NFL config 13, markets 48, reader 34, CLI 33, publisher 18), reader in Chromium 31 | 573 | pass |
| typecheck (`tsc --noEmit`, strict), `sim:check` (generated files current) | — | clean |

**The requested tests, where they are:** doubleheader sequencing
(`mlb_rotation` unit + module: no starter twice on a date, game 1 before
game 2, game-2 replacements; `mlb_statsapi`: numbering on real data);
starter rest (`mlb_rotation`: 4 days' rest regular season, 3 full days in
the postseason, clock carried from the as-of last start and across rounds;
World Series game-3 starter not again before 2025-10-31); rotation
progression (cycle order, off days, postseason best-rested order across
off days between rounds); extra innings (`mlb_model`: postseason priced at
the standard-rule rate, regular season at the season's; no game tied);
qualification (`mlb_rules_*`, `mlb_sim` identities, `mlb_statsapi` 2024);
series order (`mlb_rules_synthetic` every round; `mlb_rules_history` 494
real games; `mlb_sim` World Series hosts 2-3-2 in every run); fixed
completed postseason results (`mlb_sim`: every 2025 seed, title, bye and
round through the pennants exactly 0 or 1, only World Series games 3–7
simulated, 42 fixed games counted every run, a tampered host refused).

**Benchmark** (the committed code, 4 workers, linux/x64, Node 22.22.0):
100,000 runs in 6.6 s from the morning of 2025 World Series game 3 and in
25.2 s from 2025-08-15 (610 games left); peak RSS 273 MB.

---

## 13. Repair log

| Problem found | Fix |
|---|---|
| The committed 2024 table counts three resumed suspended games twice | the loader drops the later copy; the lab brain's own record left as is, flagged (§5.3) |
| Postseason simulations put members on short rest in 25% of game 4s | a departed member's vacant slot now goes to a replacement before anyone pitches on short rest (simulated short rest ≈ 0%) |
| Random spot starts scrambled the rotation order (simulated next-start hit 22 points below observed) | spot starts take the scheduled member's turn (chosen on the fit window; gap 0.10) |
| Rotation uncertainty fitted on 2012–2017 understated the recent era | fit on 2018–2023, 2025 held out |
| Doubleheader starts outside the rotation were under-represented | separate spot rates for single games and doubleheader games 1 and 2 |
| Math status left tie-decided clubs undetermined after the season | after the regular season, status is the final standings through the tiebreak procedure |
| Announced World Series game-3 starters listed under "projected" | the label travels with each starter tally (Confirmed / Projected) |
| Synthetic tiebreak fixtures not actually level (first draft) | rewritten; every fixture asserts its clubs are level before the step is tested |
| A club with no games compared equal to any record in a synthetic fixture | fixtures give every club in a contested division a game (real seasons always do) |
| The reader's registry may carry no probability-like text | MLB limitations reworded (no "probability", no three-decimal rates) |

---

## 14. Limitations (also shown in the reader)

One persistent offset per club and per named starter (2025 holdout reported
beside each); the served model's moneyline does not beat Elo and showed no
postseason skill; starters Projected from a rotation model that names the
next start 63% of the time (52% in the postseason) and is deliberately less
certain than history; bullpen fatigue, lineups, platoons, weather and
injuries (beyond rotation departures) not modelled; ratings frozen at the
as-of date, no drift; neutral-site games at the home club's park; extra
innings resolved at measured home rates, never played out; the postseason
calendar Estimated where the schedule has no date; short-rest postseason
starts rarer than in history; Monte Carlo ± is simulation noise only.

---

## 15. Deployment status (2026-10-23)

**ACTIVE for the 2026 World Series.** mlb.com and MLB's Stats API answer
GitHub's runners (this environment cannot reach them), so the *Simulator
source check* gained an MLB job and every fact was read there:

| Fact | Status | Evidence |
|---|---|---|
| 2026 divisional alignment | **VERIFIED** | MLB's 2026 standings (Stats API), club by club = `MLB_TEAMS`; source check run 39995723592 |
| 2026 postseason format | **VERIFIED** | MLB's 2026 postseason schedule (43 games): seeds, byes, series lengths and every host as `MLB-2022`; same run |
| Live 2026 inputs | **VERIFIED** | the live dry run on a runner (Simulator run 39994766921): every gate but `sport.active` passed; all 30 records equal MLB's standings; `postseason.consistent` passed |
| 2026 World Series home field | **VERIFIED** (its 2026 application) | MLB's 2026 World Series schedule: Milwaukee (103-59) hosts games 1, 2, 6, 7; Tampa Bay (98-64) games 3–5. The rule's wording was not found on mlb.com; the equal-record step does not apply in 2026 and is counted by `run.tiebreak_measured` |
| 2026 extra-inning rules | **VERIFIED** | 2026 Official Baseball Rules (PDF sha256 `f85860f3…`): Rule 7.01(b)(2), every half-inning after the ninth begins with a runner on second; Rule 7.02(g), it "does not apply to any Wild Card Series, Division Series, League Championship Series or World Series games"; source check run 40000336884 |
| 2026 tiebreaker procedure | **MEASURED** (unverified) | MLB's text was not found (the glossary page is generic; the Internet Archive's index timed out). MLB's 2026 final standings hold no equal record at any place a tiebreaker decides, so no 2026 place depends on it; every run counts the ties it breaks at a reported place (`tiebreak:groups`, `tiebreak:world_series_home`) and `run.tiebreak_measured` refuses publication if there is one. Must be verified before a season whose standings are not final |

**Nightly.** MLB is a leg of the nightly *Simulator* workflow through
`nightly_through` (2026-11-07: World Series game 7 is scheduled 2026-10-31,
plus a week for postponements), then leaves the schedule until a 2027
configuration exists. A dispatch can name it at any time.

**Exactly what exists:** the engine, studies, fixtures and tests (§12); the
reader's MLB view (League tab: seeds 1–6 with the byes, Division Series,
LCS, pennant; Title tab: the World Series); the Kalshi MLB futures mapping
(§15.1); `simulator/research/registration_mlb.json` is not generated into
`supabase/simulator_registry.sql` (that generator is single-model). The
database layer needs no MLB change: the run carries its own sum rules.

**Next season:** re-run the source check and an MLB dry run, re-verify each
fact in a reviewed commit, set the new season's `nightly_through`, and
regenerate the Kalshi MLB mappings once Kalshi lists the season's markets
(§15.1).

### 15.1 Kalshi futures

`simulator/src/cli/build_kalshi_mappings.ts --sport mlb` maps a market only
when its rules match one of Kalshi's own MLB templates word for word, read
from Kalshi's 2026 markets (Simulator source check run 40019030435: the World
Series open, every other series settled):

| Series | Kalshi's wording | Simulated outcome | Outcome set (normalised only when complete) |
|---|---|---|---|
| `KXMLB` | If *club* wins the *year* Pro Baseball Championship | `win_world_series` | all 30 clubs |
| `KXMLBAL`, `KXMLBNL` | If *club* win the *year* Pro Baseball American / National League Championship | `win_pennant` | the league's 15 |
| `KXMLBALEAST` … `KXMLBNLWEST` | If *club* is the *year* Pro Baseball AL East (…) Division Winner | `win_division` | the division's 5 |
| `KXMLBPLAYOFFS` | If *club* is one of the *year* Pro Baseball Playoff Qualifiers | `make_playoffs` | never (six per league qualify) |

The season comes from the rules and must be the event ticker's (`KXMLB-27`:
2027), so a market maps to its own season's run. The ticker's club (Kalshi's
suffixes `NYY`, `CWS`, `ATH`, `AZ`, … cross to the Retrosheet keys) must
carry Kalshi's label for that club (`New York Y`, `Chicago WS`, `A's`,
`Arizona`, …: one label per club across all 92 club markets read), and the
club must be in the league or division the series names. Not mapped: the
league or division of the champion, exact World Series matchups, the
champion's seed (`KXMLBSEEDWIN`: either league's club with that seed), win
totals, awards and props, and the older series under other tickers
(`KXMLBWS`, `KXWSAL`, `KXWSNL`, `KXMLBDIVWINNER`, `KXMBLNLEAST`), which listed
no market in 2026. `simulator/fixtures/kalshi_mlb_2026_markets.json` keeps
the 92 real markets; `markets.test.ts` maps every one of them (and the same
wording one year on to 2027), and leaves out each alteration.

**Mapped now (2026-10-23):** the two 2026 World Series markets still open,
Milwaukee and Tampa Bay (`win_world_series`, not normalised: the other 28
clubs' markets have closed). They are compared after each MLB publication
through `nightly_through`. **Kalshi listed no 2027 MLB futures yet.** A
mapping for a later season than the run's is not that run's
(`configForSport`), so 2027 mappings can sit beside the 2026 run.

**When Kalshi lists the 2027 markets:** run *Simulator source check*, then

```
node simulator/src/cli/build_kalshi_mappings.ts --sport mlb --candidates <kalshi_candidates_mlb.json from the run's artifact> --run <run id>
#   or, from the fetch (mlb) job's log (timestamps kept), when the artifact cannot be downloaded:
node simulator/src/cli/build_kalshi_mappings.ts --sport mlb --log <job log> --run <run id>
npm run sim:test
```

and commit the config: every 2027 market in the 2026 wording maps (World
Series, pennants and divisions as complete sets), the 2026 ones drop out, and
it prints every market of a mapped series it left out, with the reason. A
2026 mapping left in the config once a 2027 run exists is an error the
*markets* job reports (an earlier season is stale), never a silent miss.
Kalshi rewording a series leaves its markets out until the template is
updated from the source check's text.

**Commands** (PowerShell or bash, from the repository root):

```
npm run sim:test:mlb                                   # the seven MLB suites
node simulator/src/cli/run.ts --sport mlb --season 2025 --as-of 2025-10-27 --confirm-through 2025-10-28 --dry-run   # a history morning (rebuilds the model: ~90 s)
node simulator/src/cli/run.ts --sport mlb --season 2025 --snapshot simulator/fixtures/mlb_2025_ws_g3_snapshot.json.gz --dry-run
npm run sim:mlb:dry-run                                # live 2026 (needs statsapi.mlb.com)
npm run sim:mlb:probe                                  # read the live sources, write nothing
npm run sim:mlb:studies; npm run sim:mlb:backtest; npm run sim:mlb:fixture   # regenerate the evidence (in this order)
```

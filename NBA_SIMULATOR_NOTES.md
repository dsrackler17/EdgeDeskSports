# NBA_SIMULATOR_NOTES — EdgeDesk NBA season, play-in and playoff simulator

The engineering record of the NBA simulator: what it models, what it does
not, the evidence behind each input, what blocks publication and why. It
follows the shared simulator conventions (`SIMULATOR_NOTES.md`): the served
model only, no invented inputs, every fact sourced and its verification
status stated, every estimate labelled Estimated, gates before publication.
Runbook (Windows PowerShell): `docs/simulator/README.md` §NBA.

Dates are UTC. Retrieved = 2026-10-23. Season keys are END years (2027 =
2026-27), the NBA engine's convention. Nothing here claims an edge,
production readiness or a deployment: §16 states exactly what exists.

---

## 1. Status in one table

| Area | State | Evidence |
|---|---|---|
| NBA rules (standings, tiebreakers, division titles, seeding, play-in, bracket, best-of-seven) | Implemented; replays **every play-in and playoff game 2006-07..2025-26** (except 2019-20) exactly | `simulator/tests/nba_rules_history.test.ts` (105 assertions, 4 mutants) |
| Synthetic rule cases (every tiebreak step, restart, play-in paths, home order, four-win end) | Implemented, tested | `simulator/tests/nba_rules_synthetic.test.ts` (116) |
| Game model | The served NBA model (`edgedesk_nba_v1:E_ridge_P`), no new model; the simulator's mean for every game on the published slate equals the slate's baseline (max difference 0 over 27 games) | §4, `nba_sim.test.ts` §7 |
| Strength uncertainty (persistent per-club draws) | Calibrated on frozen out-of-sample forecasts, 15 seasons x 5 as-of points | `simulator/data/nba_strength_uncertainty.json`, §7 |
| Player availability (projected rotation + return trajectories) | Implemented; return hazards validated on a 2023-24..2025-26 holdout | `simulator/data/nba_return_hazards.json`, §8 |
| Rest, travel, home court | From the schedule for every regular-season game; Estimated for unscheduled postseason games | §5 |
| Postseason rotations | **Not modelled** beyond the model's own learned postseason term; audited, no boost invented | `simulator/data/nba_postseason_audit.json`, §9 |
| Completed games, current series | Fixed exactly; series resume from their real score at the right venue | §6, `nba_sim.test.ts` §5 |
| Futures mapping | Every outcome has its own settlement semantic; a market can map to one outcome only | §10 |
| Publication | **BLOCKED**: six 2026-27 facts unverified; 30 NBA Cup-dependent games not on the schedule | §12 |

---

## 2. Starting point

- Branch `claude/edgedesk-nba-simulator-q1ktpg` from `main` at `7267e5d0`
  ("injury sync: NFL injury report from nflverse"); the working tree was clean.
- The simulator engine, NFL module, database layer, reader and workflows were
  already on `main` (`SIMULATOR_NOTES.md`); the NBA was BLOCKED there with
  "no conference/division table, no standings/tiebreaker/play-in/series code,
  no uncertainty study, the model needs the network-built work tables".
- Environment: linux/x64, Node v22.22.0, 4 cores; pyarrow installed for the
  NBA ingest.

**Network reachability** (it decides the blockers):

| Host | Reachable | Consequence |
|---|---|---|
| `raw.githubusercontent.com` (sportsdataverse/hoopR-nba-data) | yes | the NBA work tables were rebuilt (`node nba/ingest/season.js --season all`: 2003-2027, 102 MB); the committed `nba/data` files were restored afterwards so every number here rests on the committed data |
| `www.nba.com`, `official.nba.com`, `ak-static.cms.nba.com`, `cdn.nba.com` | **no** (proxy policy, 403 on CONNECT) | no 2026-27 rules fact could be verified from an official page |
| `en.wikipedia.org`, ESPN, basketball-reference | **no** | no secondary confirmation either |
| Kalshi | **no** | no NBA futures market could be read or mapped |

---

## 3. What is modelled — the direct answers

| Input | Modelled? | How | Label |
|---|---|---|---|
| Team strength | yes | the served pass's states (Elo, Glicko, adjusted efficiency and four factors, Kalman, player RAPM) **frozen at the as-of time**, every remaining game priced by the chosen ridge model and its season calibration — including the calibration's early-season shrinkage term (`stage`), so a game in April priced in October carries October's confidence | Research |
| Persistent strength uncertainty | yes | one `Normal(0, sigma^2)` offset per club per run, in points of margin, kept through the regular season, the play-in and the playoffs | Research (calibrated) |
| Home court | yes | the model's learned home terms; neutral sites from the schedule (NBA Cup semifinals, international games); in the postseason the home-court club by regular-season record and the exact 2-2-1-1-1 order | Observed / Research |
| Rest, back-to-backs, games in 7 days, travel, time zones, altitude | **yes, regular season** | from the schedule row of every game (`nba/data/team_games`, computed by the ingest from dates and arenas) | Observed |
| ... postseason | **yes where scheduled; Estimated otherwise** | a play-in or playoff game on the schedule is priced from its real row; otherwise the median rest, games-in-7, road/home streak of its round and game number over the 2021-22..2025-26 postseasons, exact travel between the two arenas in the 2-2-1-1-1 order, no back-to-back (none occurred in those five postseasons) | Estimated |
| Player availability — who plays | yes: the served projected rotation (everyone who played in the club's latest game), valued by the player model (RAPM x expected minutes, scaled to 240) | Research |
| Player availability — returns | **yes**: each tracked absence returns at a club game drawn once per run from empirical return hazards; from that game on he is in the rotation, priced by the served player model (§8) | Estimated |
| Player availability — new absences | **no**: no future injury, rest night or trade is simulated | — |
| Injury report statuses / return dates | **no**: none is committed (the official report lives in Supabase via `nba_injury_sync`, statuses only, no dates); none is invented | — |
| Postseason rotations | **no**: the player layer uses the same minutes rule in April and June; the model's own learned `playoff` term applies (the ridge coefficient: +1.69 points of home margin before the calibration, which scales it by 1.00-1.20 with the season stage). The audit (§9) finds a calibration slope of 1.16 (95% CI 0.99-1.34) in playoff games — suggestive of tighter rotations favouring the better club, not significant — so no boost is added | Research / audit |
| Recovery across playoff dates | rest from real dates where scheduled, Estimated medians otherwise; return trajectories keep counting club games through the play-in and playoffs | Estimated |
| In-season rating updates (drift) | **no**: ratings stay frozen; drift OFF | — |

---

## 4. The served model, as the simulator reads it

- **Loaded, not copied.** `simulator/src/sports/nba/model_adapter.ts` requires
  `nba/model/pass.js`, `ml.js`, `walkforward.js`, `distribution.js`,
  `dist_fit.js`; the parameters are `nba/params/live.json` and
  `ml_live.json` unchanged (`chosen.P = E_ridge_P`; the adapter refuses
  another choice until it is extended). The pricing path is the slate's
  (`nba/build_slate.js` `attachMl` + `paramsOf`).
- **Frozen pass.** `frozenPass()` runs the served pass with every game from
  the as-of time treated as unplayed (`nba/lib/data.js` `games()` wrapped, no
  file changed): point-in-time by construction, for the live season and for
  historical replays. Schedule-shaped postseason rows are passed through the
  same pass (13,230 per snapshot: play-in and three rounds for every ordered
  same-conference pair, the Finals for every cross-conference pair, 7 game
  numbers per round), so they are priced from the same frozen states.
- **Equivalence with the slate.** For every game on the committed slate
  (`nba/roster_inputs.json`, same data commit), the snapshot's mean equals
  the slate's published baseline `mu_m` exactly (27 games, max |difference|
  0), recorded in the fixture and asserted by `nba_sim.test.ts` §7.
- **Out-of-sample season parameters.** `seasonParams(rows, S)` rebuilds
  season S's ridge (trained on seasons < S), calibration, shape and overtime
  (on S-3..S-1) exactly as `nba/model/live.js` does; for S = 2027 it
  reproduces `live.json` and `ml_live.json` bit for bit (verified).
- **The distribution at any mean.** `game_dist.ts`: P(home win) is the served
  `marginals()` on a 0.01-point grid of the mean, linearly interpolated (max
  error < 1e-6, tested at 685 means); the margin given the winner comes from
  the served final-margin pmf at the mean rounded to 0.1 point (only the
  point-differential tiebreak reads a margin). The final margin includes
  overtime and has no mass at 0.
- **Availability slopes.** For every priced game the snapshot records the
  model's mean and the two slopes d(mean)/d(plr_m_proj), d(mean)/d(adj_proj),
  measured on the served path (the ridge and the calibration are linear in
  them). A return shifts the mean by
  `s_plr * pace * (dnet_h - dnet_a)/100 + s_adj * pace * ((dnet_h - dfull_h) - (dnet_a - dfull_a))/100`
  — exactly the features the pass computes once the player has played
  (projected set and full-rotation reference both include him), with the
  club's subset table from `pm.strength()` (tested to 1e-12).

---

## 5. Rules (`simulator/src/sports/nba/rules.ts`, config `simulator/src/sports/nba/config.ts`)

### 5.1 Alignment
30 clubs, East and West of 15, six divisions of five. **Derived from owned
data, not recalled:** a division rival is the only opponent played four
times in every season 2013-14..2018-19 and 2021-22..2022-23 (before the NBA
Cup changed the counts); a conference rival three or four times, the other
conference twice. `nba_config.test.ts` derives it and holds the config equal
(division names are labels). The committed 2026-27 schedule agrees.

### 5.2 Tiebreakers (two clubs / three or more)

| Two clubs tied | Three or more clubs tied |
|---|---|
| 1 head-to-head | 1 division winner (whatever the divisions) |
| 2 division winner | 2 record in games among the tied clubs |
| 3 division record (same division only) | 3 division record (all in one division only) |
| 4 conference record | 4 conference record |
| 5 record vs playoff clubs, own conference | 5 record vs playoff clubs, own conference |
| 6 record vs playoff clubs, other conference | 6 point differential |
| 7 point differential | 7 random drawing (seeded) |
| 8 random drawing (seeded) | |

- **Elimination and restart.** The first step that separates the tied clubs
  splits them into the best (one club, or a group level on that step) and the
  rest, who are eliminated: every club still in the tie ranks above every
  eliminated club; the best group restarts from step 1 and so, below it, do
  the eliminated — each with the two-club or multi-club procedure as its size
  dictates. **History fixes this rule:** in 2008-09 DEN, POR and SA finished
  54-28; the division-winner step eliminates POR, DEN beats SA head-to-head,
  and POR is fourth although it beat SA head-to-head — the league's order. A
  place-by-place restart (the NFL's) gets 2008-09 wrong and every other season
  right (`nba_rules_history.test.ts` mutant).
- Division titles are decided first (the division-winner step cannot separate
  the tied leaders). Percentages are compared as integer cross products.
- **Playoff clubs** for steps 5-6: the clubs at or above the record of the
  10th place (8th before the play-in), ties included. **Not identified by
  history**: one tie in 2020-21..2025-26 reached that step and 6, 8, 10 and 12
  all order it the same way; UNVERIFIED.
- Steps a club cannot be measured on (no games against the set) are skipped
  for the whole group.
- History exercised (2006-07..2025-26): head-to-head 48 times, conference
  record 15, division record 10, division winner 9 (two-club 3, multi-club 6),
  games among the tied clubs 5, vs own-conference playoff clubs 1. **Never
  reached in history:** the other-conference step, point differential and the
  random drawing — covered only by the synthetic suite.

### 5.3 Seeding, play-in, bracket, series

| Rules version | Seasons | Seeding | Postseason |
|---|---|---|---|
| NBA-2021 | 2020-21 → 2026-27 | places 1-15 by record and tiebreakers; 1-6 qualify | play-in: 7th hosts 8th (winner = 7 seed); 9th hosts 10th (loser out); loser of 7-8 hosts winner of 9-10 (winner = 8 seed) |
| NBA-2016 | 2015-16 → 2018-19 | seeds 1-8 by record | — |
| NBA-2007 | 2006-07 → 2014-15 | the three division winners and the best other club take seeds 1-4 (by record), 5-8 by record | — |

- **Bracket fixed, no reseeding:** 1-8 meets 4-5, 2-7 meets 3-6, winners meet
  in the conference finals, the two conference champions in the Finals.
- **Best of seven**, 2-2-1-1-1 every round (games 1, 2, 5, 7 at the club with
  home court); the Finals were 2-3-2 through 2012-13 (history only). A series
  ends the game a club reaches four wins.
- **Home court:** the better regular-season record — within a conference the
  better place in the standings, which for a play-in qualifier is **not its
  seed** (tested: the 7th place that loses 7v8 and wins the last game is the 8
  seed and hosts the 7 seed if they meet); across conferences the better
  record, then the two-club procedure (untested by history: no tied Finals
  pair in the replayed seasons).

### 5.4 Reproduction against history
`nba_rules_history.test.ts`: for each season 2006-07..2025-26 except 2019-20,
the regular season (22,979 games) gives the standings, the tiebreakers and
the seeds; then **every** real play-in and playoff game (1,624 games, 285
series: 52 sweeps, 78 in five, 95 in six, 60 in seven, 36 play-in games) is
fed as observed to the state machine, whose resolver throws if ever asked. So
each play-in pairing and host, each series pairing, the host of every game,
every four-win end and every champion must be what happened — and are. No
random drawing was needed. Mutants that fail: place-by-place restart
(2008-09), a 2-3-2 first round (every season), a 2-3-2 Finals from 2013-14
(every Finals that reached game 5), no division seed block before 2015-16, no
play-in from 2020-21.

### 5.5 Verification status
Six facts in `simulator/src/sports/nba/config.ts`, each `affects_results: true`,
`verification: 'UNVERIFIED'`: the 2026-27 tiebreaker procedure, the definition
of playoff teams for it, the play-in format, the playoff format, the
home-court rules, and the NBA Cup standings rules. The history reproduction is
strong evidence for the first, third, fourth and fifth, not verification: a
fact counts only as `VERIFIED` with a named verifier and a date, after a
person compares it with nba.com.

---

## 6. Completed games, current series, the postseason so far

- Completed regular-season games keep their real scores (never drawn).
- Completed play-in and playoff games are passed as observed games to
  `playPostseason`: a play-in game must be the one the standings pair, hosted
  by the better place; a series' observed games must be its first k games at
  the venues the 2-2-1-1-1 order names; the series then resumes at game k+1
  with its real score. Any disagreement throws, and the
  `postseason.observed_fit` gate blocks the simulation.
- A postseason game already on the schedule (with its date and venue) is
  priced from its own row; others from the pair table.
- Tested on the committed 2025-26 replay snapshot frozen at 2026-04-25
  (regular season and play-in complete, 20 first-round games played): no
  regular-season or play-in game is simulated; the eight play-in clubs have
  play-in exactly 100%, the 16 playoff clubs make the playoffs in every run
  and the others never; every seed is fixed; the DET-ORL series starts with
  the games as played; no observed game is re-simulated; every traced series
  follows 2-2-1-1-1 and ends at four wins.
- The return clock counts only club games after the as-of time (an early
  draft also counted completed postseason games; repair log).

---

## 7. Strength uncertainty (`simulator/src/research/nba_frozen_forecasts.ts`, `nba_strength_uncertainty.ts`)

**What it represents.** A season simulation prices every remaining game
from the states frozen at the as-of time; whatever is wrong with a club's
frozen strength is wrong in all of its remaining games at once. That shared
error is the persistent offset `d_t ~ Normal(0, sigma^2)` (points of margin),
distinct from game randomness (the served model's own margin distribution).

**Evidence: frozen forecasts.** `nba_frozen_forecasts.ts` reruns the served
pass for 15 seasons (2009-10..2018-19, 2021-22..2025-26) frozen at five
as-of points g (the moment the league has completed 15·g regular-season
games: g = 1, 10, 20, 41, 61) — 75 passes, each pricing every remaining
regular-season game out of sample (season S's parameters rebuilt on seasons
before S) with the availability slopes and each club's tracked absences.
Cached under `simulator/.cache/nba_frozen` (rebuildable, not committed; the
study records every file's sha256).

**Win-total calibration** (the production sigma, as the NFL's): per club and
cell, D = actual remaining wins minus the simulated expectation; sigma is the
value at which the mean simulated variance of remaining wins equals mean D^2
over the estimation seasons 2009-10..2023-24 (13 seasons, 390 club cells per
point; grid 0-8 by 0.1, 300 draws per cell, common random numbers), with the
**production regime**: return trajectories ON (hazards fitted on the seasons
before S), ratings frozen. 95% interval: 2,000 season-bootstrap resamples.

| As-of (games per club) | sigma (points) | 95% CI | Empirical MSD of remaining wins | Simulated variance at sigma 0 | sigma, returns OFF | MSD at sigma 0, returns ON / OFF | Holdout 2024-25..2025-26: MSD / simulated at sigma | sigma the holdout would need |
|---|---|---|---|---|---|---|---|---|
| 1 | **3.111** | 2.704-3.498 | 75.14 | 18.08 | 3.192 | 75.14 / 77.22 | 115.5 / 63.3 | 4.86 |
| 10 | **2.694** | 2.330-3.041 | 49.63 | 15.60 | 2.777 | 49.63 / 50.80 | 71.0 / 42.2 | 4.06 |
| 20 | **2.561** | 2.196-2.922 | 35.64 | 13.24 | 2.622 | 35.64 / 36.20 | 49.4 / 31.2 | 3.78 |
| 41 | **2.578** | 2.258-2.905 | 18.10 | 8.55 | 2.633 | 18.10 / 18.29 | 26.6 / 16.6 | 4.08 |
| 61 | **1.896** | 1.360-2.297 | 5.44 | 4.14 | 1.885 | 5.44 / 5.34 | 8.3 / 5.4 | 3.91 |

Reading:
- **Without the offsets the simulation badly under-disperses** (simulated
  variance at sigma 0 is a quarter of the empirical deviation at the season's
  start).
- The snapshot takes sigma at its as-of point (linear between calibrated
  points, flat outside): the live 2026-27 snapshot (0.93 games per club) uses
  **3.111**.
- **Return trajectories move the frozen forecasts closer to what happened**
  at every point up to 41 games (MSD at sigma 0: 75.1 vs 77.2, 49.6 vs 50.8,
  35.6 vs 36.2, 18.10 vs 18.29); at 61 games they are neutral (5.44 vs 5.34).
- **The holdout is markedly more volatile than the calibration at every
  point** (its deviations exceed the simulated variance by 50-80%; a sigma
  of 3.8-4.9 would fit it). Two seasons are not evidence of a regime change,
  but the direction is consistent: the simulator's season-level
  probabilities are likely **too confident** for recent seasons. Stated as
  the first limitation, not tuned away (the holdout is never in the
  estimate, the NFL's protocol).

---

## 8. Availability: tracked absences and return trajectories (`simulator/src/sports/nba/availability.ts`)

**What the data can say.** The committed box scores list the players who
dressed; an injured player on the inactive list is usually absent from the
box altogether (2025-26 has 1,033 "DNP - injury" rows), so the reason for an
absence is mostly unobserved. No injury report or return date is committed.

**Tracked absence** (club t, as-of time): a player whose latest appearance
anywhere was for t, in this or the previous season, who did not play in t's
latest game, with expected minutes (the player model's EWM, half-life 8
games) of at least 10; `k` = t's games since his last appearance; `carried`
= that appearance was last season. The served projected rotation is exactly
the complement. At most six per club (by expected minutes) enter the exact
subset table; the rest are counted (`untracked`) and stay out.

**Return hazards, two competing risks** (`simulator/data/nba_return_hazards.json`,
`simulator/src/research/nba_return_hazards.ts`). After each of t's games every
tracked absence enters a cell (carried, minutes tier 10-24 / 24+, k bin); by
t's next game he either appears for another club first (leave: never returns
to t), plays (return), or neither. `h_leave = leaves / entries`,
`h_return = returns / (entries - leaves)`, pooled toward neighbouring cells
below 200 entries. Fitted on 2004-05..2022-23 for the holdout, on
2004-05..2025-26 for production (2019-20 and 2020-21 excluded throughout).

**Holdout 2023-24..2025-26** (2,761 absences at as-of points 1, 10, 20, 41, 61):

| Return within | Predicted | Observed | Brier | Brier, "never returns" (the frozen projection) | Brier, oracle constant |
|---|---|---|---|---|---|
| 1 game | 0.133 | 0.137 | 0.089 | 0.137 | 0.118 |
| 3 games | 0.244 | 0.244 | 0.120 | 0.244 | 0.184 |
| 5 games | 0.299 | 0.300 | 0.128 | 0.300 | 0.210 |
| 10 games | 0.369 | 0.380 | 0.132 | 0.380 | 0.236 |
| 20 games | 0.431 | 0.447 | 0.130 | 0.447 | 0.247 |
| 41 games | 0.458 | 0.498 | 0.128 | 0.498 | 0.250 |

Residual misfit, by class (return before the regular season ends): carried
absences in the first week are under-predicted (rotation players 0.45 vs
0.56 observed, n = 103; others 0.24 vs 0.32, n = 376); long in-season
absences late in the season are over-predicted (as of 61 games: 0.80 vs 0.66
for rotation players, n = 146 — shut-downs, tanking). Recorded in
`holdout.by_class`; not tuned away.

**Repair log of this layer.** A first version had no leave risk (91%
predicted vs 56% observed return for rotation players carried into a new
season's first week); a second counted a player at risk only if he was still
unclaimed at the club's next game, so leaves between two games were never
seen, in-sample seasons included (77% vs 56%). The competing-risk version
above is the one switched on.

**In the simulation:** one return game per tracked absence per run
(`core/hooks.ts` AvailabilityPlan, the availability stream); from that club
game on (regular season, play-in or playoffs) he is in the rotation and the
game's mean shifts by the served player model's value of the returned subset
(§4). The live snapshot of 2026-10-23 tracks 125 absences, all carried from 2025-26 (one game into the season, every player missing so far last played last season), and counts 57 more beyond six per club.

---

## 9. The postseason audit (`simulator/data/nba_postseason_audit.json`)

Every game 2009-10..2025-26 (2019-20 excluded) priced out of sample (season S
with parameters rebuilt on seasons before S) from the walk-forward pass rows:

| Games | n | Mean residual (actual - model, points) | Calibration slope | Log loss | Home win rate / model |
|---|---|---|---|---|---|
| Regular season | 19,289 | +0.003 [-0.21, +0.21] | 1.009 [0.976, 1.044] | 0.6028 | 0.575 / 0.573 |
| Playoffs | 1,338 | -0.37 [-1.12, +0.45] | 1.16 [0.99, 1.34] | 0.6315 | 0.611 / 0.642 |
| Play-in | 36 | (too few) | — | 0.6359 | 0.667 / 0.645 |

Season-bootstrap 95% intervals. Reading: the model's playoff home edge (its
own learned `playoff` term, +1.69 points in the ridge) is not significantly off; in the
playoffs the better club tends to beat the model's margin (slope 1.16), what
tightened rotations would produce, but the interval includes 1. **No playoff
rotation change or boost is applied**; the slope is a stated limitation and
the first thing a playoff-specific model would have to beat.

---

## 10. Outcomes and the futures mapping

| Outcome key | What it is | Settlement semantic | Per run |
|---|---|---|---|
| `win_division` | regular-season division title | `regular_season_division_title` | 1 per division |
| `finish_1` | **regular-season conference first place** | `regular_season_conference_first_place` | 1 per conference |
| `finish_2..15` | regular-season place k | `regular_season_conference_place_k` | 1 per conference each |
| `play_in` | **plays in the play-in** (places 7-10) | `play_in_tournament_participation` | 4 per conference |
| `make_playoffs` | **qualifies for the playoffs after the play-in** (seeds 1-8) | `playoff_qualification_after_play_in` | 8 per conference |
| `seed_1..8` | playoff seed after the play-in | `playoff_seed_k_after_play_in` | 1 per conference each |
| `reach_conference_semifinals` | wins the first round | `win_first_round_series` | 4 per conference |
| `reach_conference_finals` | wins the conference semifinals | `win_conference_semifinal_series` | 2 per conference |
| `win_conference` | **conference playoff champion** (reaches the Finals) | `conference_playoff_championship` | 1 per conference |
| `win_title` | NBA champion | `nba_championship` | 1 |

The four outcomes that are easy to conflate — conference first place, the
conference title, play-in participation, playoff qualification — are four
keys with four semantics. The results carry `outcome_semantics`; for such a
run `validateFuturesConfig` requires a mapping's `settlement.semantic` to be
the mapped outcome's (and refuses two outcomes sharing one), so a "conference
champion" market mapped to `finish_1`, or a play-in market mapped to
`make_playoffs`, is refused (`nba_sim.test.ts` §9). **No NBA market is mapped**
(Kalshi unreachable).

---

## 11. Gates (`simulator/src/sports/nba/validate.ts`)

Block the simulation: `schedule.complete` (1,230 games, 82 per club; with
`--allow-incomplete-schedule`, a dry-run-only WARN that blocks publication),
`schedule.alignment`, `schedule.teams`, `results.completed`,
`model.every_remaining_game`, `model.postseason_pairs` (13,230),
`strength.calibrated`, `availability.trajectories` (unit masses, subset
tables), `postseason.observed_fit`, `replay.code_identity`. Block
publication: `results.integrity` (schedule finals vs team box points),
`results.current` (a game more than 6 h past its start and not final), the
run gates (`run.sum_rules`, `run.finite`, `run.count` >= 100,000) and
`sport.active`. `run.random_drawings` reports how many runs needed the
league's random drawing (a rule, seeded; never blocking).

---

## 12. What blocks publication

1. **Six 2026-27 facts unverified** against nba.com (unreachable): the
   tiebreaker procedure, playoff teams for it, the play-in, the playoff
   format, home court, the NBA Cup standings rules.
2. **The schedule**: 1,200 of 1,230 regular-season games are on it; the 30
   that depend on the NBA Cup group stage (two per club) are scheduled after
   it (early December 2026). Until then `schedule.complete` refuses the
   season; the registry carries the blocker.
3. Data freshness: the committed results lag (two 2026-10-22 games not yet
   final in the data on 2026-10-23): `results.current` WARN.

To activate: §5.5 verification; the Cup games on the schedule; remove the
schedule blocker; the nightly workflow's NBA step (runbook); a first
100,000-run publication by hand.

---

## 13. Tests and actual results (2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `simulator/tests/nba_rules_history.test.ts` (every postseason 2006-07..2025-26 replayed; 4 mutants) | 105 | pass |
| `simulator/tests/nba_rules_synthetic.test.ts` (SYNTHETIC: every tiebreak step, elimination and restart, division titles, the 2006-07 seed block, the four play-in paths, 2-2-1-1-1, four-win end over 4,000 random series, resumed series, fixed bracket, home court by place) | 116 | pass |
| `simulator/tests/nba_config.test.ts` (alignment derived from the schedules, team identity across the NBA tables, 2026-27 schedule, facts, registry) | 78 | pass |
| `simulator/tests/nba_model.test.ts` (live parameters unchanged, distribution vs the served `marginals()`, margin draws, appearance scan, hazards and their holdout, return draws, sigma by as-of point) | 52 | pass |
| `simulator/tests/nba_sim.test.ts` (committed snapshots: zero offset, reproducibility, 1 vs 3 workers, persistent offsets incl. the playoffs, sum rules and qualified-club totals, the 2025-26 first-round replay, return trajectories, the slate equivalence, fail-closed gates, the CLI, futures semantics) | 57 | pass |
| typecheck (`tsc --noEmit`, strict) | — | clean |
| generated files (`npm run sim:check`), migration byte-identical | — | current |
| existing, re-run: core 37, hooks 23, NFL history 242, NFL synthetic 62, NFL simulation 32, NFL config 13, markets 48, reader 34, CLI 33, publisher 18, SQL on PostgreSQL 16 82, reader in Chromium 31 | 655 | pass |
| `.github/workflows/simulator-tests.yml` | — | actionlint 1.7.7 clean |

The NBA suites need no network and no work tables (`simulator/fixtures/nba_2027_snapshot.json.gz`,
`nba_2026_r1_snapshot.json.gz`, the committed `nba/data` and `nba/params`); they run in CI on every simulator change.

---

## 14. Benchmark

`node simulator/src/cli/run.ts --snapshot simulator/out/nba-live/snapshot.json --runs 100000 --workers 4 --dry-run --allow-incomplete-schedule`

| Measure | Value |
|---|---|
| Inputs | 2026-27 as of 2026-10-23T15:37:52Z (0.93 games per club), 1,186 remaining games, input hash `cffd6988d71f…` (the committed live fixture), sigma 3.111 |
| Snapshot build (served pass to the as-of time + 13,230 postseason pairings) | 559 s, single thread |
| Simulation | **100,000 runs in 44.3 s** on 4 workers (2 workers: 89.6 s); peak RSS 498 MB |
| Worker independence | every outcome count identical at 2 and 4 workers (same snapshot and seed) |
| Tiebreaks | 3.53 tied groups per run in the conference standings; the point-differential step reached 89 times, the other-conference step 300; **1 run** of 100,000 needed the random drawing |
| Postseason games priced from the Estimated context | 8,915,834 (no 2026-27 postseason game is scheduled yet) |
| Gates | NOT PUBLISHABLE: `schedule.complete` WARN (1,200 of 1,230 games), `results.current` WARN (two 2026-10-22 games not final in the data), `sport.active` FAIL (BLOCKED) |
| 2025-26 replay (frozen 2026-04-25) | 100,000 runs in 29.9 s on 2 workers; all gates pass but `sport.active` |

Top title probabilities in that dry run (Research, not published; 80-game
schedules, no publication allowed): OKC 28.5%, SA 21.0%, NY 11.3%, BOS
11.1%. Benchmark output, not a forecast EdgeDesk publishes.

---

## 15. Repair log

| Problem found | Fix |
|---|---|
| The multi-club restart was place-by-place (the NFL's rule): 2008-09's DEN/POR/SA tie came out DEN, POR, SA; the league seeded DEN, SA, POR | elimination semantics: clubs separated by a step rank below every club still tied; a mutant test keeps the old rule failing |
| Return hazards had no leave risk: rotation players carried into a new season's first week were predicted to return 91% of the time vs 56% observed | competing risks: appearing for another club first ends the trajectory |
| ... and counted a player at risk only if still unclaimed at the club's next game, so leaves between two games were never seen (77% vs 56%, in-sample seasons too) | entries are taken right after the game he missed; leave and return are both counted from there (holdout now 13.3/24.4/29.9/36.9/43.1/45.8% predicted vs 13.7/24.4/30.0/38.0/44.7/49.8% observed) |
| Completed postseason games advanced the return clock (they happened before the as-of time) | the clock counts only club games after the snapshot |
| A replay of a 2025-26 NBA snapshot with `--season 2026` collided with the NFL's default season and was rewritten to 2027 | a replay takes its sport and season from the snapshot |
| `--allow-incomplete-schedule` was refused on an NBA snapshot replay (the sport was checked before the file was read) | the NBA-only check runs after the sport is known |
| The snapshot builder would abort on a scheduled postseason game whose clubs are placeholders (TBD) | such rows are skipped and counted (`integrity.placeholder_postseason`); a completed game with an unknown club still aborts |
| The sigma label read "as-of points 1-61 (linear)" for an as-of before the first calibrated point (the value was right); the first fix then sent an exact interior point (10 games) to the last point | flat outside 1-61, linear between bracketing points, exact points taken as they are; unit-tested at 0.93, 1, 5.5, 10, 61 and 82 games |
| Synthetic test expectations miscounted fixtures (the 7th place, the best non-division winner, a player's games missed) | the fixtures' expectations corrected; the engine was right in each case |

---

## 16. Limitations and deployment status

**Limitations** (also in the reader's registry): **the 2024-25 and 2025-26
holdout seasons were markedly more volatile than the strength calibration**
(§7: season-level numbers are likely too confident); ratings frozen at the as-of
time (no drift; the early-season shrinkage carries to every remaining game);
one persistent normal offset per club; the served model has never been
tested against a closing market; availability is the latest game's rotation
plus Estimated returns (reason unknown; no new absences, no roster moves);
Estimated postseason rest for unscheduled games; no playoff rotation change
(the audit's slope 1.16 is not used); the playoff-teams tiebreak definition
and the cross-conference Finals tiebreak are not identified by history;
Monte Carlo ± is simulation noise only.

**Deployment status, exactly:**
- Code, tests, studies and fixtures: committed on
  `claude/edgedesk-nba-simulator-q1ktpg` (draft PR); **not merged**.
- Database: nothing new; the existing `supabase/simulator.sql` is
  sport-agnostic (sum rules come with each run). Nothing published.
- GitHub Actions: `simulator-tests.yml` runs the NBA suites (no network, no
  work tables: the committed snapshots); the nightly `simulator.yml` still
  plans the NFL only — the NBA needs its work-table step first (runbook).
- Reader: the Simulator seat shows the NBA's status, blockers and
  limitations (generated registry) and, once the NBA is ACTIVE, its own
  views (`lib/edgedesk_simulator.js`):
  - Division: W-L, projected wins, division title, play-in and playoffs.
  - Conference: regular-season first place, play-in, playoffs, both rounds,
    the playoff conference title, then seeds 1-8. Each is its own column, with
    a note that these are four different outcomes.
  - Title: the NBA title, with the regular-season places on their own line.

  Tested on real simulations of the committed fixture: `ui.test.ts`, and
  `ui.e2e.ts` in Chromium at 390 and 1440 px, with the NBA served ACTIVE for
  that scenario only.
- Kalshi: no NBA mapping.
- Nothing is "production-ready", "deployed" or a "validated edge".

---

## 17. File manifest

```
NBA_SIMULATOR_NOTES.md                          this file
simulator/src/sports/nba/config.ts              2026-27 alignment, facts, verification status
simulator/src/sports/nba/rules.ts               standings, tiebreakers, seeding by era, play-in, bracket, series
simulator/src/sports/nba/model_adapter.ts       the served model: live / out-of-sample parameters, frozen pass, pricing
simulator/src/sports/nba/game_dist.ts           the served final-margin distribution at any mean
simulator/src/sports/nba/postseason_context.ts  Estimated postseason rest/streaks from 2021-22..2025-26
simulator/src/sports/nba/availability.ts        tracked absences, competing-risk return hazards, distributions
simulator/src/sports/nba/inputs.ts              the snapshot (prices, pairs, availability, strength, integrity, code hashes)
simulator/src/sports/nba/module.ts              one simulated season; outcomes, semantics, sum rules
simulator/src/sports/nba/validate.ts            gates; clinch/elimination (sufficient conditions)
simulator/src/research/nba_frozen_forecasts.ts  frozen out-of-sample forecasts (cache, not committed)
simulator/src/research/nba_strength_uncertainty.ts, nba_return_hazards.ts, nba_postseason_audit.ts
simulator/src/cli/build_nba_fixture.ts
simulator/data/nba_strength_uncertainty.json, nba_return_hazards.json, nba_postseason_audit.json
simulator/fixtures/nba_2027_snapshot.json.gz, nba_2026_r1_snapshot.json.gz
simulator/tests/nba_rules_history, nba_rules_synthetic, nba_config, nba_model, nba_sim (.test.ts), _nba_fixture.ts
modified: simulator/src/cli/run.ts (--sport nba, --as-of, --allow-incomplete-schedule), simulator/src/sports/factory.ts,
          simulator/src/sports/registry.ts, simulator/src/markets/compare.ts + cli/markets.ts (settlement semantics),
          simulator/src/publish/publish.ts (snapshot meta), lib/edgedesk_simulator_sports.js (generated), package.json (sim:nba:*),
          .github/workflows/simulator-tests.yml, docs/simulator/README.md, SIMULATOR_NOTES.md (NBA row)
```

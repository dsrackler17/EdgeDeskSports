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
| Synthetic rule cases (every tiebreak step, complete and partial breaks, play-in paths, home order, four-win end) | Implemented, tested | `simulator/tests/nba_rules_synthetic.test.ts` (118) |
| The seven 2026-27 rules facts (the six, and the NBA Cup format) | **VERIFIED** 2026-10-23 from the league's own text (archived nba.com and NBA Communications pages read by the Simulator source check, run 39996632843) | §5.5, §5.6 |
| The NBA Cup (Group Play, the knockout rounds, the 30 games it decides) | Implemented: played inside every run; reproduces every quarterfinal pairing and host (12) and semifinal pairing (6) of 2023-24..2025-26 from Group Play; the 30 Cup-dependent games are simulated until the league schedules them (the unpublished parts Estimated, each held to the same three Cups) | `simulator/tests/nba_cup.test.ts`, `nba_cup_sim.test.ts`, §5.6 |
| Game model | The served NBA model (`edgedesk_nba_v1:E_ridge_P`), no new model; the simulator's mean for every game on the published slate equals the slate's baseline (max difference 0 over 27 games) | §4, `nba_sim.test.ts` §7 |
| Strength uncertainty (persistent per-club draws) | Calibrated on frozen out-of-sample forecasts, 15 seasons x 5 as-of points | `simulator/data/nba_strength_uncertainty.json`, §7 |
| Player availability (projected rotation + return trajectories) | Implemented; return hazards validated on a 2023-24..2025-26 holdout | `simulator/data/nba_return_hazards.json`, §8 |
| Rest, travel, home court | From the schedule for every regular-season game; Estimated for unscheduled postseason games | §5 |
| Postseason rotations | **Not modelled** beyond the model's own learned postseason term; audited, no boost invented | `simulator/data/nba_postseason_audit.json`, §9 |
| Completed games, current series | Fixed exactly; series resume from their real score at the right venue | §6, `nba_sim.test.ts` §5 |
| Futures mapping | Every outcome has its own settlement semantic; a market can map to one outcome only | §10 |
| Publication | **ACTIVE** (2026-10-23): every fact verified; the Cup-dependent games simulated; the NBA's own daily schedule in `simulator.yml` (15:47 UTC) | §12, §16 |

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
| `www.nba.com`, `official.nba.com`, `ak-static.cms.nba.com`, `cdn.nba.com` | **no** (proxy policy, 403 on CONNECT); from GitHub's runners nba.com, `api-hub.nba.com`, `pr.nba.com` and `cdn.nba.com` answer 403 (Akamai "Access Denied") | the league's pages were read as the Internet Archive keeps them, from the runners (§5.5) |
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
| NBA Cup Group Play, knockout field and hosts | **yes**: the league's rules on the run's Group Play results (§5.6) | Research |
| The 30 Cup-dependent games, until scheduled | **yes, simulated**: pairings from the run's Cup (the non-advancing clubs' pairings by an Estimated stand-in for the league's formula), Estimated dates, rest and travel from each club's own schedule | Estimated |
| Overtime and regulation points of a simulated Group Play game (the Cup's differential and points tiebreakers) | yes: drawn from the served model given the margin (its total mean, sd and end-game slope) | Research |

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

- **Complete and partial breaks** (the league's Paragraph L.2.c, read from
  nba.com's standings page on 2026-10-23, §5.5). The criteria apply in order
  until the first that tells the tied clubs apart.
  - A *complete* break (every club a different value) orders them by that
    criterion, with "no further application of the tie-break criteria".
  - A *partial* break orders the levels it separates: any club that did better
    ranks above any that did worse. Each group still level starts again from
    the first criterion, with the two-club or multi-club procedure as its size
    dictates.

  Until 2026-10-23 the code ranked only the best level and restarted everyone
  below it from step 1. That differs when a criterion separates three or more
  levels: games among three tied clubs 4-2, 3-3, 2-4 with the third beating
  the second head-to-head. It is now the league's rule, with a synthetic case
  that fails on the old code. Every season 2006-07..2025-26 reproduces under
  both: the case never arose.

  **History fixes the restart:** in 2008-09 DEN, POR and SA finished 54-28. The
  division-winner step puts POR below both, DEN beats SA head-to-head, and POR
  is fourth although it beat SA head-to-head — the league's order. A
  place-by-place restart (the NFL's) gets 2008-09 wrong and every other season
  right (`nba_rules_history.test.ts` mutant).
- Division titles are decided first (the division-winner step cannot separate
  the tied leaders). Percentages are compared as integer cross products.
- **Playoff clubs** for steps 5-6: the clubs at or above the record of the
  10th place (8th before the play-in), ties included. **Not identified by
  history** (one tie in 2020-21..2025-26 reached that step, and 6, 8, 10 and 12
  all order it the same way), but stated by the league: "teams eligible for
  the postseason … including teams that finished the Regular Season tied for
  one of the best 10 records in their conference" (§5.5).
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

### 5.5 Verification (2026-10-23)
The six facts in `simulator/src/sports/nba/config.ts` (each
`affects_results: true`) are **VERIFIED**. They were compared with the league's
own text by Claude Code at the repository owner's request, and `verified_by`
names the run.

**How the text was read.** The Simulator source check
(`.github/workflows/simulator-sources.yml`, NBA job;
`simulator/src/cli/fetch_sources.ts`) reads each page from GitHub's runners.
nba.com, `api-hub.nba.com`, `pr.nba.com` and `cdn.nba.com` all answer the
runners 403 (Akamai), so each page is the Internet Archive's copy as
published: `web.archive.org/web/<capture>id_/<url>`, the archived bytes. The
run prints each page whole, its text sha256, and an excerpt of the paragraphs
that name the rules. Run 39996632843 (2026-10-23) is the one cited; its
artifact keeps the files for 30 days.

| Fact | The league's text | Agrees with the code |
|---|---|---|
| Tiebreakers | nba.com standings page, "Play-In and Playoff Tie-Break Procedures", Paragraph L.2 (captured 2026-10-13): L.2.a two teams (head-to-head; division winner; division record if same division; conference record; vs own-conference postseason-eligible teams; vs the other conference's; point differential), L.2.b more than two (division winner; games among the tied; division record if all in one division; conference record; vs own-conference postseason-eligible teams; point differential), L.2.c (division ties first and used only for the division winner; complete and partial breaks; a group still tied restarts from the beginning; then a random drawing) | Both lists, step for step. **L.2.c did not:** the code ranked only the best level and restarted everyone below; corrected (§5.2) |
| Playoff teams for the tiebreaker | the same page: "teams eligible for the postseason … including teams that finished the Regular Season tied for one of the best 10 records in their conference" | yes (`place: 10`, ties included) |
| Play-in | nba.com play-in explainer (2026 edition, captured 2026-10-05): No. 7 hosts No. 8, the winner is the 7 seed; No. 9 hosts No. 10, the loser is out; the loser of 7-8 hosts the winner of 9-10 for the 8 seed. For 2026-27: the schedule release ("all six games of the SoFi NBA Play-In Tournament 2027 … Teams seeded seventh through 10th … will compete for the final two playoff berths") and the key dates (April 13-16, 2027) | yes |
| Playoff format | NBA Communications 2015 ("the eight playoff teams in each conference will be seeded in order of their regular-season record") and 2014 ("2-2-1-1-1 … aligns The Finals format with every other round of the NBA Playoffs"). **No page read states the fixed bracket (1-8 v 4-5, 2-7 v 3-6, no reseeding):** as for the NFL's seeding, that part rests on every pairing and host 2006-07..2025-26 (§5.4) | yes |
| Home court | NBA Communications 2015: a division winner "did not receive home-court advantage if its playoff opponent had a better record"; head-to-head is "the first criterion to break ties for playoff seeding and home-court advantage" | yes (by record and those criteria, not by seed) |
| NBA Cup | nba.com Cup 101 and FAQ (2026 editions, captured 2026-10-10): every Cup game counts toward the standings except the Championship; 82 games each; the two games after Group Play (22 + 2 + 4 + 2 = 30); the schedule release: "defined dates and opponents for 80 of each team's 82 games" | yes |

A seventh fact, **the NBA Cup format** (`nba_cup_format`), is VERIFIED from
the same Cup 101 and FAQ pages and the schedule release (§5.6 quotes it).

Each fact's `source` carries its URL, capture time and text sha256. Each
season the check is run again and compared (`verify_by`). From 2026-27 the
Cup semifinals are hosted by the higher seed in NBA team markets, not in Las
Vegas: `cup.ts` plays them there.

### 5.6 The NBA Cup and its 30 dependent games (`simulator/src/sports/nba/cup.ts`)

Each club plays 82 games, but only 80 are on the 2026-27 schedule: the other
two depend on the Cup's Group Play (Oct. 30 - Nov. 27) and are scheduled by
the league after it (Dec. 4-10). The simulator plays the Cup inside every run
instead of waiting for them.

**The league's rules (VERIFIED, `nba_cup_format`).** The Cup 101 page:
- Group Play: six groups of five within each conference, one game against
  each group rival (two home, two away) on the seven Cup Nights, "the only
  NBA games played on Cup Nights".
- Group standings by Group Play record. Ties: head-to-head in Group Play,
  point differential, total points (overtime never counts: an overtime game's
  differential is 0 and its overtime points are dropped), the 2025-26 record,
  a random drawing.
- The knockout field: six group winners plus one wild card per conference
  (the best record among the runners-up; the same protocol without
  head-to-head).
- Hosts: in each conference the two best group winners host the
  quarterfinals (Dec. 4-5), the best one hosting the wild card. The
  semifinals (Dec. 8/9) are at the higher seed's arena. The Championship
  (Dec. 11, Indianapolis) is not a regular-season game.
- The 22 clubs that do not advance play two games each "by a formulaic
  approach" on the Group Play standings: two cross-conference games between
  bottom finishers "subject to travel constraints", the rest within
  conference between clubs "otherwise scheduled to play each other three
  times ... wherever possible". The two quarterfinal losers of each
  conference play each other.

**The groups are read off the schedule, never recalled.** The 60 games on the
seven Cup Nights form six complete groups of five (`cupStructure` throws
otherwise): East {ATL, BOS, CHA, CHI, WSH}, {BKN, DET, MIL, ORL, TOR},
{CLE, IND, MIA, NY, PHI}; West {DAL, DEN, HOU, PHX, UTAH}, {GS, LAL, POR, SA,
SAC}, {LAC, MEM, MIN, NO, OKC}. They are numbered 1-3 because the league's
letters are not in the data. The committed schedule has no game from Dec. 4
to 10, and every club has 40 home games of its 80.

**Held against the league's own Cups** (`nba_cup.test.ts`, 2023-24..2025-26).
The groups the Cup Nights form, then the real Group Play results through the
rules above:

| What | Reproduced |
|---|---|
| Quarterfinal pairings and hosts | 12 of 12 |
| Semifinal pairings | 6 of 6 |
| Non-advancing clubs: 22 games, two each, one at home | every season |
| Their within-conference games: clubs otherwise scheduled three times | 60 of 60 |

**What the league does not publish is Estimated** (`cup_dependent_schedule`,
labelled in the reader). Each stand-in is held to the same three Cups:
- **Cross-conference pairs:** the same Group Play place in both conferences,
  from the bottom up, the first two whose arenas are within 2,500 km. This
  matches 6 of 6 pairs (2023-24: 14th and 15th; 2024-25: 14th and 12th;
  2025-26: 14th and 11th; the skipped places were all 3,000 km or more
  apart). The conference places 5-15 rank the non-advancing clubs by record,
  then the wild-card protocol across groups. They are not each group's own
  order: that order matched only 5 of 6.
- **Within-conference pairings:** drawn at random in each run among the
  clubs otherwise scheduled three times. Each club plays its remaining
  games, no pairing twice. Any conference pairing is used only if none
  completes it (counted).
- **Home and away:** each non-advancing club hosts one of its two. The
  quarterfinal losers' game goes to the loser that was away in its
  quarterfinal; if both or neither were, to the higher seed (6 of 6).
- **Dates and rest:** quarterfinals Dec. 4; the first non-advancing games
  Dec. 6; semifinals Dec. 8; the second non-advancing games and the losers'
  games Dec. 9; the Championship Dec. 11 (never before tomorrow). Rest and
  travel come from the club's own schedule, or from its own arena after an
  Estimated Cup game.
- **Overtime and points of a simulated Group Play game** (Research, the
  served model's own): overtime is drawn given the margin, and its mean
  equals the served P(overtime) within 0.004. The regulation total is drawn
  as the model's joint distribution draws it: a normal of mean
  mu_t + gamma (|r| - E|r|) and the season's sd_t, on the integers of the
  regulation margin's parity (r = 0 after overtime). That gives the two
  clubs' regulation points, so the differential and total-points steps read
  a simulated game as they would a real one. A tie that still reaches the
  total-points step without a game's points (no served total) goes to the
  2025-26 record, counted by `run.cup_tiebreaks`; on the live snapshot that
  happens 0 times.

**In each run** (`module.ts`), in date order:
1. After the last Cup Night: the Group Play standings, the field and the
   quarterfinals.
2. On the Estimated dates: the non-advancing clubs' games, the semifinals,
   the losers' games and the Championship.
3. Every simulated game is priced from the snapshot's schedule-shaped rows
   for that slot (2,805 pairings on the same served pass), with the run's
   strength offsets and availability.
4. The quarterfinals, semifinals and the other 26 games enter the standings
   (head-to-head, division and conference records). The Championship enters
   none.

A game the league has put on the schedule is played as it is, and only the
rest are simulated. The `cup.structure` gate checks a scheduled game against
the real Group Play results: no Cup-dependent game before Group Play is
over, no knockout club against a non-advancing one, no knockout game before
the quarterfinals. Every run ends with 82 games per club and 30 Cup games
used, or it throws.

Outcomes (§10): win the group, reach the knockout rounds, win a
quarterfinal, reach the Championship, win the Cup.

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
| `cup_win_group` | wins its NBA Cup group | `nba_cup_group_winner` | 1 per Cup group |
| `cup_knockout` | reaches the Cup's knockout rounds (a group winner or the wild card) | `nba_cup_knockout_qualification` | 4 per conference |
| `cup_semifinal` | wins a Cup quarterfinal | `nba_cup_quarterfinal_win` | 2 per conference |
| `cup_final` | wins a Cup semifinal (plays in the Championship) | `nba_cup_championship_appearance` | 1 per conference |
| `cup_champion` | wins the NBA Cup | `nba_cup_champion` | 1 |

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

Block the simulation: `schedule.complete` (1,230 games, 82 per club, counting
the Cup-dependent games the run simulates: 1,200 on the schedule + 30 today;
with `--allow-incomplete-schedule`, a dry-run-only WARN that blocks
publication), `cup.structure` (six groups of five off the Cup Nights; a
scheduled Cup-dependent game only after Group Play and fitting its real
result), `model.cup_pairs` (2,805 Cup pairings priced),
`schedule.alignment`, `schedule.teams`, `results.completed`,
`model.every_remaining_game`, `model.postseason_pairs` (13,230),
`strength.calibrated`, `availability.trajectories` (unit masses, subset
tables), `postseason.observed_fit`, `replay.code_identity`. Block
publication: `results.integrity` (schedule finals vs team box points),
`results.current` (a game more than 6 h past its start and not final), the
run gates (`run.sum_rules`, `run.finite`, `run.count` >= 100,000) and
`sport.active`. `run.random_drawings` reports how many runs needed the
league's random drawing (a rule, seeded; never blocking); `run.cup_tiebreaks`
how many reached the Cup's total-points step with a simulated game (decided
by the 2025-26 record) or the Cup's random drawing.

---

## 12. What blocks publication

Nothing standing: the NBA is **ACTIVE**.
1. ~~Six 2026-27 facts unverified~~: verified 2026-10-23 from the league's
   text (§5.5); the seventh, the Cup format, likewise (§5.6).
2. ~~The schedule~~: 1,200 of 1,230 regular-season games are on it. The 30
   that depend on the Cup are simulated from its format (§5.6) until the
   league schedules them; each one it schedules replaces its stand-in.
3. Each run still has to pass its own gates. `results.current` blocks a
   publication while a game more than 6 h past its start is not final in
   the data. The NBA's daily run (15:47 UTC) re-reads the season from hoopR
   first.

Each season: re-run the Simulator source check, re-verify the facts, and
write the new Cup format (`config.ts` `cup`: Cup Nights, window, dates) in a
reviewed commit.

---

## 13. Tests and actual results (2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `simulator/tests/nba_rules_history.test.ts` (every postseason 2006-07..2025-26 replayed; 4 mutants) | 105 | pass |
| `simulator/tests/nba_rules_synthetic.test.ts` (SYNTHETIC: every tiebreak step, complete and partial breaks (L.2.c), division titles, the 2006-07 seed block, the four play-in paths, 2-2-1-1-1, four-win end over 4,000 random series, resumed series, fixed bracket, home court by place) | 118 | pass |
| `simulator/tests/nba_cup.test.ts` (the Cups 2023-24..2025-26: groups off the Cup Nights, 12 quarterfinal pairings and hosts, 6 semifinal pairings, the losers' hosts, the cross-conference and within-conference stand-ins; the 2026-27 structure; SYNTHETIC: every Group Play tiebreak step, overtime counting 0, the wild card, 200 random filler schedules) | 60 | pass |
| `simulator/tests/nba_config.test.ts` (alignment derived from the schedules, team identity across the NBA tables, 2026-27 schedule, the seven facts VERIFIED with their sources, the Estimated inputs, registry ACTIVE) | 81 | pass |
| `simulator/tests/nba_model.test.ts` (live parameters unchanged, distribution vs the served `marginals()`, margin draws, appearance scan, hazards and their holdout, return draws, sigma by as-of point) | 52 | pass |
| `simulator/tests/nba_sim.test.ts` (committed snapshots: zero offset, reproducibility, 1 vs 3 workers, persistent offsets through the Cup and the playoffs, sum rules and qualified-club totals, the 2025-26 first-round replay, return trajectories, the slate equivalence, fail-closed gates, the CLI and `run.configured_season`, futures semantics) | 60 | pass |
| `simulator/tests/nba_cup_sim.test.ts` (the Cup in the simulation: the gates, every run's 31 Cup games and 82 per club, home and away, the Cup outcomes' totals and nesting, workers, overtime and regulation points against the served model, SYNTHETIC later stages with the quarterfinals and non-advancing games scheduled, refusals) | 33 | pass |
| `simulator/tests/ui.test.ts` and `ui.e2e.ts` (the reader's NBA views, the NBA Cup tab included, on real simulations of the committed fixture; Chromium at 390 and 1440 px) | 71 / 61 (whole suites) | pass |
| typecheck (`tsc --noEmit`, strict) | — | clean |
| generated files (`npm run sim:check`), migration byte-identical | — | current |
| every simulator suite (`npm run sim:test`), SQL on PostgreSQL 16, reader in Chromium | see the PR | pass |
| `.github/workflows/simulator.yml`, `simulator-tests.yml` | — | actionlint 1.7.7 clean |

The Cup rows do not move any other price: a control snapshot built on the
same data without them agrees on all 1,184 remaining games (875 after the
Cup window) and all 13,230 postseason pairings to 4e-15 (the served pass
prices a scheduled game from the frozen states; the Kalman clock's split
advances are linear).

The NBA suites need no network and no work tables (`simulator/fixtures/nba_2027_snapshot.json.gz`,
`nba_2026_r1_snapshot.json.gz`, the committed `nba/data` and `nba/params`); they run in CI on every simulator change.

---

## 14. Benchmark

`node --max-old-space-size=8000 simulator/src/cli/run.ts --snapshot <the live 2026-27 snapshot> --runs 100000 --workers 4 --dry-run`

| Measure | Value |
|---|---|
| Inputs | 2026-27 as of 2026-10-23T20:02:52Z, 1,184 remaining games + the 30 Cup-dependent games, input hash `4f0feec0825d…` (the committed live fixture), sigma 3.107 |
| Snapshot build (served pass to the as-of time + 13,230 postseason pairings + 2,805 Cup pairings) | 514 s, single thread |
| Simulation | **100,000 runs in 54.4 s** on 4 workers; peak RSS 514 MB |
| The Cup | each run plays 4 quarterfinals, 22 non-advancing games, 2 semifinals, 2 losers' games and the Championship, all simulated (nothing posted yet). The total-points step decided 4,663 wild-card and 3,849 seeding ties (two of each per run), the 2025-26 record 88 and 65; 25 runs reached the Cup's random drawing. A non-advancing pairing outside the clubs otherwise scheduled three times: 918 runs |
| Tiebreaks (standings) | **0 runs** of 100,000 needed the league's random drawing |
| Gates | **PUBLISHABLE**: all 21 pass (dry run: nothing published) |

Top probabilities in that dry run (Research, a dry run, not a published
forecast): the NBA title OKC 29.6%, SA 20.6%, NY 11.0%, BOS 10.9%, DET 7.5%;
the NBA Cup OKC 20.2%, SA 13.6%, BOS 11.0%, NY 9.2%, DET 8.2%.

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
| The Cup's conference places 5-15 first kept each group's own order across groups; the league's 2025-26 cross-conference pairs (BKN-DAL, the 11th places by record and differential) did not follow it | record, then the wild-card protocol across groups: 6 of 6 cross-conference pairs reproduced |
| The first Cup run skipped the total-points step for any tie that needed a simulated game's points: the 2025-26 record then decided 4,691 wild-card picks and 4,000 group-winner orders in 100,000 runs (two of each per run), favouring last season's better clubs | each simulated Group Play game's regulation points drawn from the served total given its margin; the step reads them (0 runs skip it) |
| The browser test's database mock ignored `limit`/`offset`: the reader's paging read the same 1,050 NBA rows a hundred times | the mock pages as PostgREST does |
| A replayed 2025-26 snapshot could pass every gate once the NBA was ACTIVE | `run.configured_season`: only 2026-27 is published |

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
until the league schedules them, the 30 Cup-dependent games are simulated
with Estimated pairings for the non-advancing clubs (the league's formula is
not published; within-conference pairs drawn at random among the clubs
otherwise scheduled three times), Estimated dates and rest; Monte Carlo ± is
simulation noise only.

**Deployment status, exactly:**
- Code, tests, studies and fixtures: on `main` (#703, #704, #709, #712, #714).
  The NBA Cup and the activation are on `claude/edgedesk-nba-simulator-q1ktpg`
  (draft PR).
- Database: nothing new. The existing `supabase/simulator.sql` is
  sport-agnostic (sum rules come with each run; the season label `2026-27`
  fits its check). Nothing is published until the first scheduled or
  dispatched NBA run passes every gate.
- GitHub Actions:
  - `simulator-tests.yml` runs every NBA suite, the Cup's included (no
    network, no work tables: the committed snapshots).
  - The nightly `simulator.yml` gets an NBA leg on its own cron (15:47 UTC,
    `plan.ts` `NBA_CRON`). The leg:
    1. runs the NBA suites;
    2. installs pyarrow;
    3. restores the NBA build's `nba-work-` cache, read only;
    4. re-reads the season in progress from hoopR;
    5. builds the snapshot with an 8 GB heap;
    6. publishes 100,000 runs when every gate passes.
  - A failed gate fails the leg, records an alert and never moves the
    published pointer.
  - A dispatch (sport `nba`, season `2027`) can run it by hand.
- Reader: the Simulator seat shows the NBA's views (`lib/edgedesk_simulator.js`):
  - Division: W-L, projected wins, division title, play-in and playoffs.
  - Conference: regular-season first place, play-in, playoffs, both rounds,
    the playoff conference title, then seeds 1-8. Each is its own column,
    with a note that these are four different outcomes.
  - Title: the NBA title (the Finals winner), with the regular-season places
    on their own line.
  - **NBA Cup**: one card per group with win group, knockout, semifinal,
    Championship and win the Cup, fair odds, and the note on the Estimated
    Cup-dependent games.

  Tested on real simulations of the committed fixture: `ui.test.ts`, and
  `ui.e2e.ts` in Chromium at 390 and 1440 px. The e2e mock now pages results
  as PostgREST does: an NBA run publishes 1,050 result rows, more than one
  page.
- Kalshi: no NBA mapping (the markets step reports "unavailable"; nothing is
  fetched).
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

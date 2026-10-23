# CFB_SIMULATOR_NOTES — EdgeDesk college football season, conference championship and CFP simulator

This is the engineering record of the college football simulator: what was audited, what was built, what was measured, and what is blocked and why. It sits on the shared Simulator engine described in [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md): the PRNG, runner, statistics, gates and publisher. The runbook is [`docs/simulator/README.md`](docs/simulator/README.md).

Conventions:
- Dates are UTC. Every source was read on 2026-10-23.
- **Game-model limitations (§13), conference-qualification limitations (§14) and committee limitations (§15) are kept in separate sections**, because they are separate kinds of uncertainty and none of them is Monte Carlo error.
- Nothing here claims a validated edge, production readiness or a publication. §16 states exactly what exists.

---

## 1. Status in one table

| Area | State | Evidence |
|---|---|---|
| Game-probability calibration audit (big favourites) | Done; the inputs the simulator uses are calibrated, the live board's 2026 top bucket is not | `simulator/data/cfb_calibration.json`, §3 |
| Persistent team-strength uncertainty | Calibrated (τ = 5.14 pts at week 7, 95% CI 4.55–5.67), carved out of the engine σ | `simulator/data/cfb_strength_uncertainty.json`, §3.4 |
| Season-specific membership, completed results, full remaining schedule, FCS opponents | From the 2026 schedule feed; frozen and hashed per run | `simulator/src/sports/cfb/inputs.ts`, §6 |
| QB / player availability | Supported only through the engine's trained primary-QB absence, from a sourced config (empty today) | `simulator/config/cfb_availability.json`, §6.5 |
| Conference standings and tiebreakers | 10 conferences, all VERIFIED from the conference's own text (2026 documents for the ACC, American, Mountain West and Pac-12; standing procedures for the others) | `simulator/src/sports/cfb/rules.ts`, `config.ts`, §4–5 |
| Conference championship games | Simulated; an announced or played title game replaces simulation | `module.ts`, §5.4 |
| 2026 CFP format, seeding, byes, bracket | VERIFIED from the CFP's own protocol and 2026 release; 2024 and 2025 rules kept for tests | `simulator/src/sports/cfb/cfp.ts`, §7 |
| Committee selection proxy | Explicit research model; passed its pre-registered chronological validation; outputs labelled **Estimated** | `simulator/data/cfb_committee_proxy.json`, §8 |
| Observed bracket and labelled scenarios | Implemented; the observed bracket replaces the proxy and keeps completed playoff games | `simulator/config/cfb_cfp_bracket.json`, §9 |
| Tests | 7 CFB suites, 285 assertions; every other simulator suite (NFL, NHL, MLB, markets, reader, CLI, publisher) re-run green; the NBA simulation suite fails on `main` too (its fixture was never committed) | §11 |
| 100,000-run benchmark | Executed | §12 |
| Publication | **ACTIVE** in the registry: every standing fact VERIFIED; a 100,000-run dry run passes every gate (§12). It publishes from the nightly workflow on `main` once this PR merges. | §16 |

---

## 2. What it answers, and the three kinds of uncertainty

**Outputs per FBS team.** Each comes with its count, a Monte Carlo SE, a 95% Wilson interval and its provenance label:
- conference title-game appearance (Research)
- title-game No. 1 seed or host (Research)
- conference championship (Research)
- CFP qualification (Estimated)
- seed 1–12 (Estimated)
- bye, i.e. seeds 1–4 (Estimated)
- first-round host, i.e. seeds 5–8 (Estimated)
- quarterfinal, semifinal and final appearance (Estimated)
- national championship (Estimated)

The results document also gives each team its record, its distribution of regular-season wins and its title-game status (clinched / eliminated / ineligible / alive, §5.5).

**Three kinds of uncertainty, drawn from separate PRNG streams and reported separately** (`results.cfb.uncertainty_layers`):

| Layer | What varies | Where | Label |
|---|---|---|---|
| 1. Game results | every unplayed game; one persistent strength offset per team per run | strength stream 1, games 2, postseason 3 | Research |
| 2. Conference qualification | nothing random except the rules' own draws; a step that names an external ranking uses an Estimated surrogate, and is counted | coin stream 4, points 6 | Research, with the share of runs decided by the surrogate published per conference |
| 3. Committee selection and seeding | the committee's final ranking (Plackett–Luce noise) and the proxy's own parameters (season bootstrap) | committee stream 11 (MLB holds 9 and 10) | **Estimated** |

A simulated win–loss record never decides the committee ranking by itself. Two teams with the same record are ranked by their résumés plus the committee noise, and the noise reorders them across runs (tested, §11).

---

## 3. The game model and the calibration audit

### 3.1 The model

The served engine is `football/cfb_p4/engine.js` with `params.js`, `edgedesk_cfb_p4_v1.0.1` (the one-home-field version, 2.8 points, which the engine loads itself in Node). Its win probability is derived from its margin: P(home) = Φ(fair / σ), with σ from its volatility layer (14.6–15.7). A college game cannot end tied.

### 3.2 Audit design (`simulator/src/research/cfb_replay.ts`, `cfb_calibration.ts`)

A 100,000-run simulation shrinks Monte Carlo error toward zero and does nothing about an overconfident game probability: it repeats that probability 100,000 times. So the probabilities were audited **before** being simulated, on the forecasts a season simulator actually consumes:
- **Replay.** The served engine is replayed cold over 2006–2025, exactly as `football/cfb_p4/research/backtest_engine.js` does it: state zeroed eight seasons before the first scored season, every game projected from the state before it, kickoff order, season breaks.
- **Next-game forecasts.** Every FBS game of 2014–2025.
- **Frozen forecasts.** The state is frozen after weeks 4, 7 and 10, and every remaining regular-season game is priced from that frozen state, up to 11 weeks ahead. This is the season-simulator number.
- **Splits.** By era (2014–2021 is the window σ was fitted on; 2022–2025 is held out from every layer), by opponent (FBS, FCS) and by horizon.
- **Buckets.** Favourite probability in buckets down to 98–100%, scored with Wilson intervals.
- **Live record.** The live 2026 record (`record/football/cfb_2026.json`) is scored alongside, with the no-vig closing moneyline as a benchmark (never an input).

### 3.3 Findings

| Forecasts | 90–95% (n, predicted → won) | 95–98% | 98–100% |
|---|---|---|---|
| next-game FBS, 2014–2021 | 468, .924 → .934 | 281, .964 → .964 | 126, .990 → .984 |
| next-game FBS, 2022–2025 | 221, .923 → .919 | 129, .965 → .961 | 55, .990 → .982 |
| frozen FBS, 2014–2021 | 519, .923 → .923 | 250, .964 → .964 | 90, .988 → .978 |
| frozen FBS, 2022–2025 | 258, .924 → .911 | 95, .963 → .958 | 35, .988 → 1.000 |
| next-game FBS v FCS, 2014–2025 | 247, .929 → .919 | 403, .968 → .963 | 395, .990 → .987 |
| **live board, 2026 FBS** | **23, .916 → .739 (OVERCONFIDENT)** | 13, .966 → .923 | 10, .993 → 1.000 |

- **The replayed engine is calibrated at the extremes**, in-sample and out, next-game and frozen, and against FCS opponents. Every 90%+ bucket lies inside its Wilson interval.
- **Horizon.** Frozen forecasts 6–11 weeks out are as well calibrated in the top buckets as 1–2 weeks out.
- **The live board's 2026 top bucket is not calibrated.** Its 90%+ FBS picks won 39 of 46 (84.8%, 95% CI 71.8–92.4%) against 94.7% predicted. The no-vig close priced the 90–95% games at 87.3%.
- **Why the board differs.** Its numbers are more extreme than the validated replay on the same 288 games: logit slope 1.15, and 45 games at 90%+ against the replay's 29.
- **Decision.** The simulator prices every remaining game from the replay path the tables validate, not from the board. The engine and parameters are the same; only the state differs, rebuilt from the feed.

### 3.4 Strength uncertainty (`simulator/src/research/cfb_strength_uncertainty.ts`)

**Frozen forecasts under-disperse win totals.**
- At as-of week 7 (2014–2023, excluding 2020), the simulated variance of remaining wins with independent games is 1.05, against an observed mean squared deviation of 1.38.
- A team's remaining games share its rating error, so a persistent offset d_t ~ Normal(0, τ²) is drawn once per team per run.

**Decomposition, not stacking.** The engine's margin distribution is calibrated per game, so the simulator keeps it exactly and splits it: margin = fair + d_home − d_away + e, with e ~ Normal(0, σ² − kτ²), where k is the number of FBS sides (an FCS opponent carries no offset).
- Every game's marginal probability stays Φ(fair/σ) (an exact identity, tested by quadrature).
- A team's games become correlated.
- Stacking τ on top of σ was measured and **rejected**: it makes calibrated games underconfident in the 70–90% and 95–98% buckets.

| as-of week | τ (points) | 95% CI (season bootstrap) | holdout 2024–25: observed / simulated | at τ = 0 |
|---|---|---|---|---|
| 4 | 6.28 | 5.50–6.93 | 2.81 / 2.78 | 1.63 |
| 7 | **5.14** | 4.55–5.67 | 1.53 / 1.50 | 1.13 |
| 10 | 5.21 | 2.81–6.76 | 0.81 / 0.75 | 0.64 |

In the simulation suite (§11), the 90%+ favourites win at the engine's own rate over 20,000 simulated seasons, the offset spreads win totals beyond independent games, and τ = 0 gives independent games. The 2026 snapshot is as of week 7, τ = 5.144.

---

## 4. Sources and verification (rules the feed cannot state)

The build environment cannot reach collegefootballplayoff.com or any conference site.
- **How they were read.** The read-only job `.github/workflows/simulator-cfb-sources.yml` (`simulator/src/cli/fetch_cfb_sources.ts`) reads them from GitHub's runners and prints each source with its sha256 (PR #698 runs 39949842833, 39951782798 and 39952191342; PR #703 runs 39982279610, 39982974654 and 39983837569). Script-built pages are read from headless Chrome's rendered DOM; a league's `/documents/*.pdf` viewer page is followed to the file it embeds; an image-only PDF is OCR'd. Two S3-hosted PDFs were reachable from the build environment directly.
- **Statuses** (`config.ts`):
  - **VERIFIED**: the governing body's own current text, quoted below.
  - **PRIOR_SEASON**: the body's text for an earlier season.
  - **SECONDARY**: only press or explainers were readable.
  - **UNKNOWN**: no procedure found; a PROVISIONAL one is used.
- **Who verified.** A VERIFIED fact needs a verifier and a date. Here the verifier is this Claude Code session, which read the text, at the repository owner's request (2026-10-23), as the NFL's facts were verified; each VERIFIED fact names the run whose text it read and is **marked for confirmation in review**.
- **Measured instead of verified.** One fact, Sacramento State's MAC title-game eligibility, has no governing-body statement. It is assumed (eligible) and measured in every run (§5.6).

| Fact | Status | Source read | sha256 (text unless noted) |
|---|---|---|---|
| 2026 CFP format, selection, seeding, bracket, dates | VERIFIED | collegefootballplayoff.com selection-committee protocol; 2026-27 format release (2026-08-06); 12-team format page | 7e6567ed…; 6027a934…; 7a515444… |
| ACC 2026 tiebreaker | VERIFIED | ACC Football Tiebreaker Policy, as amended July 1, 2026 (S3 PDF) + release | file c5b49646…; 66c26691… |
| Big 12 tiebreaker | VERIFIED | Big 12 Football 2024 Tiebreaker Policy, "beginning with the 2024 football season" (S3 PDF, posted 2025-11-04; no later version found) | file b1eb5c73… |
| MAC tiebreaker | VERIFIED | MAC Football Championship Tiebreaker (official page, 2025-11-12, no season limit) | 3be1bdb7… |
| Sun Belt divisions and tiebreakers | VERIFIED | Football Tie-Breaking Procedures (current official page) | 92233e96… |
| SEC tiebreaker | VERIFIED | the SEC's own release "SEC announces football tie-breaking process" (Aug. 21, 2024), read from the rendered page: its standing procedure for the divisionless conference; no replacement published, and the 2025 game was decided under it | 79c14ed1… |
| Big Ten tiebreaker | VERIFIED | the Big Ten's own release "OFFICIAL TIEBREAKING PROCEDURES" (Aug. 26, 2024) and its 2025 tiebreaker scenarios article, both read from the Internet Archive's copies of bigten.org (which now answers 404); the 2024 PDF answers automated readers with HTTP 402 and is not archived, so the three-team order is taken from the 2025 article's worked cases; the 2026 game page announces no change | archived pages 1cc9c342…; b6e764b6… |
| American tiebreaker | VERIFIED | the American's 2026 Tiebreaker Policies PDF (posted 2026-09-30; compared line by line with 2025) | 803b8343… (file a9c5c71c…) |
| Mountain West tiebreaker | VERIFIED | Mountain West Football Championship Tiebreaking Procedures PDF (posted 2026-10-12, written for 2026) | ac6f140e… (file c43d7f85…) |
| Conference USA tiebreaker | VERIFIED | Conference USA Football Regulations PDF (posted 2024-09-19, no season limit) + the 2026 schedule release | 9c0a3601…; 29ea92ee… |
| Pac-12 tiebreaker | VERIFIED | the Pac-12's 2026 operations release (Sept. 3, 2026: "football championship game tiebreaker language for 2026 finalized"), read from the rendered page | 4c126ecc… |
| North Dakota State eligibility | VERIFIED | NCAA DI Cabinet release (June 24, 2026) + the Mountain West 2026 procedure's eligibility clause + NDSU athletics FAQ ("immediately eligible for the MW Football Championship Game") | 367a859c…; ac6f140e…; fa8efc88… |
| Sacramento State MAC title eligibility | MEASURED (SECONDARY) | Sacramento State athletics FAQ (Feb. 2026: ineligible for two years *because of* the NCAA transition rule) + the NCAA's June 2026 removal of that rule; no MAC statement | 36e5b99a…; 367a859c… |

**Two corrections the primary sources forced:**
- **CFP.** The 2026 format is not the 2024–25 "five highest-ranked conference champions". The four power champions plus the highest-ranked team from the six other conferences (champion or not) qualify, and Notre Dame is in if ranked in the top 12.
- **ACC.** The tiebreaker was rewritten in July 2026 for its eight-or-nine-game schedule.

Both were checked from the governing bodies' own text. Neither was remembered.

---

## 5. Conference standings and tiebreakers (`rules.ts`)

### 5.1 One engine, a procedure per conference

A procedure is an ordered step list for a two-team tie and another for three or more. The vocabulary:
- **head-to-head**
- **record among the tied teams**, only when all played each other
- **beat each of the other tied teams** (advances); for the ACC and the Mountain West, **lost to each** (removed); the Mountain West applies it even when every tied team met
- **common conference opponents**
- **next highest placed common opponent**, with a tied group taken collectively
- **combined conference win % of conference opponents**
- **the Sun Belt's divisional steps**
- **wins in a 12-game season**, one FCS win counted and the visitor's exempt game at Hawai'i excluded
- **win % against FBS teams**; **overall win %** with exempt games excluded (the American) or with at most one FCS win (the Mountain West)
- **the SEC's capped relative scoring margin**: offense capped at 42, defense at 48, from Estimated scores drawn only when a tie reaches that step
- **an external ranking** (Estimated, §5.3), including the Mountain West's **CFP-ranked team immunity**: once, for the original standings tie only, the highest-ranked tied team in the Nov. 24 CFP ranking advances if it wins its final regular-season game after that date
- **the draw**

Resolution:
- A step that separates one team advances it.
- A step that separates a subset removes the rest, and the procedure restarts on the subset, with the two-team list when two remain.
- After a team advances, the rest restart at step 1.
- Percentages are compared as exact fractions (2/3 equals 4/6, tested).
- Slots are filled from the top of the standings. A group no larger than the remaining slots qualifies whole; a larger group goes to the procedure one team at a time.

### 5.2 The procedures

| Conference | Procedure | Title game site | Notes |
|---|---|---|---|
| ACC | ACC-2026 | neutral (Charlotte) | Tied teams include a team with an **alternate number** of conference games that has the same wins or losses (five teams play 8, twelve play 9). Then head-to-head → SportSource Team Success Ranking → draw. 3+ teams: record among them if all are common opponents, else beat-each / lost-to-each, then TSR. |
| Big 12 | B12-2024 | neutral (Arlington) | a–g of the 2024 policy, verbatim order. |
| MAC | MAC-2025 | neutral (Ford Field) | SportSource TRS comes **before** order of finish. |
| Sun Belt | SBC-DIV | home of the champion with the better conference win % | East/West champions; host tiebreak; an ineligible champion yields to the next team. |
| SEC | SEC-2024 | neutral (Atlanta) | The SEC's own 2024 text, its standing divisionless procedure. Capped scoring margin from Estimated scores. |
| Big Ten | B1G-2024 | neutral (Indianapolis) | The Big Ten's own 2024 release (via the Internet Archive; bigten.org no longer serves it); 3+ teams as its 2025 scenarios article applies them. |
| American | AAC-2026 | home of seed 1 | The 2026 policy: CFP-ranking / computer-composite conditions, then common opponents, overall win % without exempt games, coin toss. **Army–Navy (Dec. 12) is played after the title game and does not count for qualification.** |
| Mountain West | MW-2026 | home of the eligible team best outright | CFP-ranked team immunity first, then head-to-head, CFP ranking / composite, overall win % (one FCS win), next placed team, common opponents, coin toss; 3+ teams: mini round robin (advance / eliminate). |
| Conference USA | CUSA-2024 | home of seed 1 | Head-to-head → common opponents → best common opponent downward → average of SP+, SportSource, ESPN SOR and KPI (Estimated) → opponents' conference win % → coin toss. |
| Pac-12 | PAC12-2026 | home of seed 1 | Two teams: head-to-head → next placed common opponent → all common opponents → CFP ranking → SportSource (both Estimated) → coin toss. Standings fixed after Week 12; Week 13 flex games are non-conference and are not in the feed yet. |

### 5.3 External rankings: the Estimated surrogate, counted

SportSource Analytics ratings, computer composites and CFP rankings are named by several procedures, and nothing here produces them. A step that reaches one is resolved by the run's **latent team strength**: the frozen rating plus that run's persistent offset. That is the quantity such ratings estimate.
- **Counted, not hidden.** The run counts, per conference, the share of runs in which such a step decided a **berth** (or the host of a hosted title game), and publishes it. A neutral-site seed order changes nothing and is not counted.
- **Warning threshold.** Above 5% the conference's forecast carries a warning that it leans on the surrogate (§12).
- **What it is.** This is a qualification-rule approximation, not the committee proxy. Conference forecasts never depend on the committee model.

### 5.4 Title games

- **Played.** Each conference's pair plays its title game from the postseason pair table, neutral or at seed 1's home.
- **Announced or completed.** A title game already in the feed fixes its participants (Observed), and its result once played.

### 5.5 Clinched / eliminated

`status.ts` asserts only sound sufficient conditions: strict comparisons of best and worst cases, with ties counted against the team. For the ACC it asserts only *ineligible*, because the alternate-games definition can tie teams with unequal percentages. The simulation must agree with the status exactly: an eliminated team never qualifies and a clinched team always does (tested).

### 5.6 Postseason ineligibility

- An ineligible team's conference games count in every standing, but it cannot take a slot. For the ACC it cannot be among the Top Two; for the Sun Belt the next team in the division goes instead.
- **North Dakota State is MW-eligible (VERIFIED).** The NCAA Division I Cabinet (June 24, 2026) made reclassifying teams postseason-eligible, the Mountain West's 2026 procedure removes only teams ineligible under NCAA or MW rules, and NDSU's own athletics site says it is eligible for the MW title game.
- **Sacramento State is assumed MAC-eligible, and that assumption is MEASURED.** The school's own February 2026 FAQ said it was ineligible for the MAC title game "for two years" because of the NCAA transition rule, which the NCAA removed in June. No MAC statement exists.
- **How a measured assumption works.** Each run replays the affected conference under the **opposite** assumption and counts how often the title-game pair would change. A measured fact is not a standing blocker; instead the run gate `run.eligibility_sensitive:<team>` holds publication if even one run depended on it. In the benchmark (§12), Sacramento State's assumption changed 0 of 100,000 MAC pairs (it is 0–4 in the conference).

---

## 6. Season inputs (`inputs.ts`)

### 6.1 Membership
Who is FBS and each team's conference come from the 2026 cfbfastR-data schedule feed (138 FBS teams; Notre Dame and UConn independent), never from a stored list. The Sun Belt's divisions are the schedule's **unique** round-robin partition of its 14 members; the official page's East list matches it.

### 6.2 Completed results
Every completed game is fixed at its real score in every run (tested: only unplayed games are ever drawn). The as-of week is the latest completed regular-season week.

### 6.3 Remaining schedule
All 378 remaining 2026 games, FCS opponents included, with neutral flags. Army–Navy is excluded from AAC qualification and from the committee, both of which come before it. The Pac-12 Week 13 flex games are not in the feed yet (opponents are set at most six days ahead). They are not simulated; they never count in the Pac-12 standings, but they are missing from those teams' overall records (gate WARN).

### 6.4 FCS opponents
The engine's single FCS floor rating (−28), with no strength offset. Its win rates are calibrated in aggregate on 1,284 FBS-vs-FCS games, 2014–2025. Its margins are not: FBS teams beat the floor by more than projected, which changes no win–loss outcome.

### 6.5 QB and player availability
**Supported only where the engine supports it.** A primary quarterback ruled OUT moves a price by the engine's trained absence coefficient (`params.injury.position_weight.QB`, 3.90 points, fitted over 2,846 games). A backup or an untrained position moves nothing, per the engine's missing-input rule (tested).
- **Sourcing.** Entries go in `simulator/config/cfb_availability.json` with a source URL, a report time and who recorded them.
- **Scope.** `rest_of_season` applies to every remaining game and postseason pairing; otherwise the entry applies only to the named games.
- **Not simulated.** No return dates and no new injuries.
- **Today.** The config is empty, and `football/availability/current.json` carried no report for any of the 138 teams.

### 6.6 Postseason pairs
Every ordered FBS pairing, neutral and at the first team's home (37,812 engine projections), from the same frozen state.

### 6.7 Freezing and identity
The snapshot is content-hashed. Its code identity (sha256 of the engine, parameters, FBS module and input assembly) is checked on replay.

---

## 7. The CFP (`cfp.ts`)

- **CFP-2026 (VERIFIED):**
  - field: the ACC, Big Ten, Big 12 and SEC champions; the highest-ranked team of the American, CUSA, MAC, MW, Pac-12 and Sun Belt, champion or not; Notre Dame if top-12; then the next highest-ranked to 12
  - seeds 1–4: the four highest-ranked teams (byes)
  - seeds 5–12: by rank, with automatic qualifiers ranked outside the top 12 at the bottom in rank order
  - bracket: 5v12, 6v11, 7v10 and 8v9 on campus at the higher seed; quarterfinals 1 v 8/9, 2 v 7/10, 3 v 6/11, 4 v 5/12; semifinals (1) v (4) paths and (2) v (3) paths; no reseeding
  - neutral from the quarterfinals on: the top seeds' choice of bowl path picks sites, not opponents
  - Selection Day 2026-12-06; games after it are not considered
- **CFP-2025:** five highest-ranked champions; seeds 1–4 the four highest-ranked teams.
- **CFP-2024:** five highest-ranked champions; seeds 1–4 the four highest-ranked **champions**.
- **Checked against reality.** The real 2024 and 2025 final rankings and champions reproduce the real 12 seeds under their own rules. The feed's first-round and quarterfinal games match the bracket structure, and replaying the feed's results through the bracket reaches the real champions (Ohio State, Indiana).

---

## 8. The committee proxy — an explicit research model (`committee.ts`, `simulator/src/research/cfb_committee.ts`)

### 8.1 Historical inputs
- The committee's **final** top 25 for every season 2014–2025, from Wikipedia's CFP tables (CC BY-SA), since the CFP's own history page renders with a script. Committed as `simulator/data/cfb_cfp_rankings_history.json` with page sha256s. Cross-checked against the feed: the 2023 top four are the semifinalists, and all of 2024–2025's playoff teams are ranked. The 2014–2022 feeds carry no postseason rows, a fact the test asserts rather than skipping.
- Every game from the same schedule feed the simulator reads.
- The engine's **frozen as-of-week rating** from the same replay: the rating the simulator holds at that as-of week.

### 8.2 Résumé
Computed by the same function for history and for a simulated season, over games before the final ranking (title games in, bowls and later games out):
- wins and losses
- undefeated
- power-conference member or Notre Dame (2014–23: ACC, Big Ten, Big 12, Pac-12, SEC; 2024+: without the Pac-12)
- power champion and other champion
- frozen rating
- mean opponent rating
- wins over teams rated 5.0+

Title games are labelled in the feed from 2022 on. For 2014–2021 a title game is the only conference game on the conference's last conference date on or after Nov 28. This rule finds exactly the 20 labelled 2022–2023 title games (tested).

### 8.3 Model
Plackett–Luce over all FBS teams on the standardized résumé. Simulating it means adding standard Gumbel noise per team and sorting; this is exactly a Plackett–Luce draw (tested: P(first) = softmax). Parameter uncertainty comes from a 200-draw season bootstrap, with one draw per run. Week-7 coefficients (standardized):

| feature | losses | wins | undefeated | power | power champ | other champ | rating | sos | quality wins |
|---|---|---|---|---|---|---|---|---|---|
| β | −2.96 | 3.62 | 0.02 | 1.32 | 0.09 | −0.27 | 1.07 | 1.37 | 0.29 |

### 8.4 Chronological validation, decided before scoring 2024–2025
- **Candidates.** Four specifications were written in advance: record-only, rating-only, the full résumé, and a compact résumé.
- **Folds.** Each validation season, 2017–2025, is scored only with a fit on earlier seasons.
- **Selection.** On 2017–2023; 2024–2025 are reported after the choice.
- **Criteria:**
  - D1: beat both baselines on log-likelihood per ranked place
  - D2: P(top 12) calibrated (no bucket with n ≥ 30 outside its Wilson interval)
  - D3: an expected overlap with the actual top 12 of at least 10 teams on average

| as-of week | chosen | log-lik/place (record, rating) | overlap with the actual top 12 (2024–25) | D1 D2 D3 |
|---|---|---|---|---|
| 4 | résumé | −1.80 (−2.11, −3.61) | 10.12 (10.40) | ✓ ✓ ✓ |
| 7 | résumé | −1.78 (−2.11, −3.35) | 10.26 (10.36) | ✓ ✓ ✓ |
| 10 | résumé | −1.81 (−2.11, −3.23) | 10.05 (10.29) | ✓ ✓ ✓ |

- **Per season (week 7):** overlap ranges from 9.31 (2020) to 10.99 (2022).
- **P(top 12) calibration (pooled 2017–2025).** Every bucket is inside its interval: 0–2%: 982 teams, 0 in; 50–75%: 13 teams, predicted .62, observed .77; 98–100%: 62 teams, all in.
- **Decision.** The proxy is **defensible as an Estimated research input**, and CFP outputs are produced from it with that label. Had any criterion failed, `module.ts` would produce no CFP or national-title probability at all (`cfpMode` → `off`, tested).

---

## 9. After Selection Day: the observed bracket, and labelled scenarios

`simulator/config/cfb_cfp_bracket.json` takes one of three statuses:

| status | what happens | labels |
|---|---|---|
| `none` | before Selection Day; the proxy is used | CFP outputs **Estimated** |
| `observed` | the 12 seeds exactly as announced, with `source_url` and `announced_at`; the proxy is **never** used; completed playoff games from the feed are fixed; only the remaining games are simulated | field and seeds **Observed**; rounds and title Research |
| `scenario` | a hypothetical bracket that must list its assumptions | every CFP output carries `conditional_on` with them |

Both `observed` and `scenario` brackets are validated: 12 distinct feed teams, plus a source for an observed one and assumptions for a scenario.

---

## 10. Outputs and labels

- **Probabilities.** Count / N, MCSE, Wilson 95%, fair decimal odds.
- **Provenance per outcome** (now part of the shared engine): conference outcomes are Research; CFP outcomes are Estimated (proxy), Observed (announced bracket) or Research conditional on a scenario.
- **`results.cfb`:**
  - the three uncertainty layers
  - each conference's rules status, the share of runs decided by the Estimated ranking surrogate, by the draw, and by an unverified procedure, and whether it is publishable
  - the calibration summary
  - the snapshot's notes
- **Never a stake, never an edge.** No market comparison is wired for CFB, and no Kalshi CFB futures mapping exists.

---

## 11. Tests (actual results, 2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `simulator/tests/cfb_rules_synthetic.test.ts`: SYNTHETIC tie cases per procedure (restart semantics, sweep, ACC alternate games, MAC SportSource-before-order, Sun Belt divisions and host, ineligibility, capped margin, fair draw, exact fractions; the Pac-12 v CUSA step order on one league; Mountain West immunity granted and refused; the MW round robin when all met) | 55 | pass |
| `simulator/tests/cfb_rules_history.test.ts`: the real 2024–2025 title games | 18 | pass |
| `simulator/tests/cfb_cfp.test.ts`: real 2024–2025 brackets from real rankings, every 2026 clause, every bracket path | 33 | pass |
| `simulator/tests/cfb_committee.test.ts`: rankings data v feed, title-game identification, résumé, PL fit recovery, Gumbel = PL, record ≠ ranking, proxy file | 60 | pass |
| `simulator/tests/cfb_calibration.test.ts`: favourite calibration, decomposition identity, the gate | 25 | pass |
| `simulator/tests/cfb_config.test.ts`: sources and verification, registry status, the measured Sacramento State assumption (input WARN, run gate), divisions, eligibility, QB-absence pricing | 52 | pass |
| `simulator/tests/cfb_sim.test.ts`: sum rules, determinism, 1 v 3 workers, completed results fixed, the SEC's Estimated scores, ineligibility, clinched/eliminated, undefeated, big favourites over 20,000 runs, the offset's correlation, every CFP mode, observed bracket and title game, a scenario never published, the CLI | 42 | pass |
| typecheck (`tsc --noEmit`, strict) | — | clean |
| generated files (`sim:check`) | — | current |
| the other simulator suites after the merge with `main` (core, hooks, NFL ×4, NHL ×4, MLB ×7, markets 64, reader 45 incl. the CFB views, CLI 36, publisher) | — | pass |
| the NBA suites | — | rules and config pass; `nba_sim.test.ts` fails on a missing `simulator/fixtures/nba_2027_snapshot.json.gz`, never committed by #702 (fails on `main` too) |
| the Simulator seat in Chromium (`simulator/tests/ui.e2e.ts`) and `tools/app/navigation.test.js` | 31 + 256 | pass |

Real-data checks the suites hold:
- **Title games.** 13 of the 16 real 2024–2025 pairs are reproduced from results alone. The other 3 (Mountain West 2024 and 2025, American 2025) needed an external ranking in reality too, and the engine reports exactly that.
- **Brackets.** The real 2024 and 2025 brackets are reproduced from the real final rankings.
- **Big favourites.** Over 20,000 simulated seasons, 90%+ favourites win at the engine's rate (max |z| over 378 games below 4.5).

---

## 12. Benchmark (actual, 2026-10-23, the committed code)

`node simulator/src/cli/run.ts --sport cfb --season 2026 --snapshot simulator/fixtures/cfb_2026_wk7_snapshot.json.gz --runs 100000 --workers 4 --dry-run`

| Measure | Value |
|---|---|
| Inputs | as-of week 7 (results through 2026-10-18), 378 remaining games, input hash `2d9c5638da6f` (the committed fixture, rebuilt with the verified config), τ 5.144, CFP mode: committee proxy (résumé, as-of week 7) |
| Simulation | **100,000 runs in 20.7 s** on 4 workers |
| Peak RSS | 359 MB |
| Platform | linux/x64, Node v22.22.0 |
| Format sums | every per-run and aggregate sum holds; every probability finite and in [0, 1] |
| Gates | **PUBLISHABLE**: no gate blocks. Eight WARNs, none blocking: the Pac-12 Week 13 flex games are not yet in the feed, Sacramento State's assumption is measured (0 of 100,000 MAC pairs depended on it), and six conferences lean on the Estimated ranking surrogate above 5% of runs. |

Per conference: the share of runs in which a berth (or a hosted game's host) was decided by a step naming an external ranking, resolved by the Estimated surrogate. No berth was decided by a draw.

| Conference | Rules | decided by Estimated ranking |
|---|---|---|
| ACC | VERIFIED (2026) | **29.2%** (Team Success Ranking right after head-to-head) |
| Big 12 | VERIFIED | 0.6% |
| MAC | VERIFIED | 19.1% |
| Sun Belt | VERIFIED | 22.2% |
| SEC | VERIFIED | 0.0% (capped scoring margin from Estimated scores in about 1%) |
| Big Ten | VERIFIED | 0.9% |
| American | VERIFIED (2026) | **55.8%** |
| Mountain West | VERIFIED (2026) | 9.0% (immunity and the ranking/composite step) |
| Conference USA | VERIFIED | 10.9% |
| Pac-12 | VERIFIED (2026) | 3.5% |

Highest national-title probabilities in that dry run (**Estimated**): Ohio State 17.0%, Miami 12.2%, Indiana 10.0%, Ole Miss 8.2%, Notre Dame 8.2% (±0.2 Monte Carlo). Conference examples: Miami reaches the ACC title game in 93.5% of runs and wins the ACC in 57.1%; North Dakota State reaches the Mountain West title game in 63.9% and wins it in 29.6%.

These are benchmark outputs from the committed test snapshot; the nightly run builds its own snapshot from the live feed.

---

## 13. Game-model limitations

- **Not market-beating.** The game model is `edgedesk_cfb_p4_v1.0.1`, which does not beat the closing line in its walk-forward record (spread MAE 12.77 v 12.02 on 2022–2025). The simulator inherits its errors; it does not correct them.
- **Not the board's number.** Prices come from the replayed state (the validated path), not the live board's richer inputs: no play-level efficiency, roster, regime or canonical-rating backbone. The board's 2026 numbers are more extreme than this, and less well calibrated at the top.
- **Small out-of-sample samples at the extremes.** Calibration is checked to the 98–100% bucket, but the out-of-sample samples there are small: 55 next-game and 35 frozen games, 2022–2025.
- **One τ for everyone.** Strength uncertainty is one normal offset per team per run, the same τ for every team, including the two FCS newcomers with no FBS history. The 2024–2025 holdout was slightly more dispersed than the fit at week 10.
- **Ratings are frozen** at the as-of date: simulated results do not update them, and within-season drift is off.
- **FCS opponents** are one floor rating. Their win rates are calibrated in aggregate; their margins are not.
- **QB availability** is priced only for a sourced primary-QB absence. There are no return dates, no new injuries, and no non-QB effects (none is trained).
- **Pac-12 flex games** (Week 13) are not simulated.

## 14. Conference-qualification limitations

- **Standing procedures.** Six of ten conferences publish a 2026 text (ACC, American, Mountain West, Pac-12) or an undated current one (Big 12, MAC, Sun Belt, Conference USA). The SEC's and the Big Ten's texts name the 2024 game and are their standing procedures: no replacement has been published, and the 2025 games were decided under them. A mid-season change by either would not be seen until the sources are re-read.
- **The Big Ten's three-team order** comes from its own 2025 worked scenarios, not from the full PDF (unreadable to automated readers and not archived).
- **The Mountain West's CFP-ranked immunity** needs the Nov. 24 CFP ranking; the Estimated stand-in is "top 25 among FBS teams by the run's latent strength", not the committee's ranking.
- **External rankings are an Estimated surrogate.** SportSource, computer composites and CFP rankings inside tiebreakers are approximated by the run's latent strength. The ACC (29.2% of runs: the Team Success Ranking comes directly after head-to-head), the MAC (19.1%), the Sun Belt (22.2%), the American (55.8%), CUSA (10.9%) and the Mountain West (9.0%) lean on it materially (§12), and are flagged so.
- **Stated simplifications:**
  - "common opponents" is applied to conference opponents (MAC)
  - "order of finish" treats a tied group collectively (MAC, as the Big 12 text does)
  - the ACC's "working downward" from the highest percentage among alternate-games ties is read as one tied set
  - the Big 12's exempt-game rule is applied to games at Hawai'i only
- **SEC scoring margin.** The capped scoring margin uses Estimated scores, a normal total around the engine's fair total conditioned on the simulated margin.
- **One eligibility fact is measured, not verified.** Sacramento State's MAC eligibility has no MAC statement; it is assumed and every run measures it (0 of 100,000 at week 7). North Dakota State's (material: the Mountain West pair differs in about 64% of runs under the opposite assumption) is VERIFIED.
- **Stated readings:** CUSA's multi-team "head-to-head" is read as the record among the tied teams; the American's and the Mountain West's CFP-ranking conditions are one Estimated step.

## 15. Committee limitations (the proxy, separately)

- **Not the committee.** It is a statistical summary of how the committee's final rankings related to résumés in 2014–2025. It does not model deliberation, injuries the committee weighs, the eye test, or anything outside the résumé.
- **Two 12-team seasons.** Only 2024 and 2025 were 12-team selections; 2014–2023 rankings were made for a 4-team field.
- **Thin calibration evidence.** P(top 12) calibration is checked on pooled buckets that mostly hold 11–26 teams. D2 has little power, and its intervals are wide.
- **A summary rating.** The rating feature is the engine's frozen as-of rating, not the committee's perception, and the committee saw every later game.
- **Noise and parameters.** The noise is the committee's historical unpredictability around this résumé. Parameter uncertainty comes from a season bootstrap of only 12 seasons.
- **Never decided by record alone.** Two teams with equal records are ordered by résumé plus noise, and the noise reorders them across runs (tested).
- **Ranking-dependent 2026 rules** (the best Group of 6 team's bid, Notre Dame's top-12 guarantee, unranked automatic qualifiers) are only as good as the proxy's ordering beyond the top 12, where the historical data is thinnest.
- **Estimated, and replaced once facts exist.** Every CFP, seed, round and title output that passes through the proxy is labelled Estimated. Once the bracket is announced (§9), the proxy is replaced by facts.
- **What the noise covers.** Monte Carlo ± measures simulation noise only, never committee uncertainty, which is inside the probabilities themselves.

---

## 16. Deployment status, exactly

- **Code.** Committed on `claude/edgedesk-cfb-simulator-0kdly0`, PR #703 (#698 merged only the source job and the calibration research).
- **Status: ACTIVE** in `simulator/src/sports/registry.ts`: every standing fact VERIFIED (§4), Sacramento State's eligibility measured per run. A 100,000-run dry run of the committed snapshot passes every gate (§12).
- **Publication.** Nothing is published from this environment. After merge, the nightly *Simulator* workflow (10:17 UTC; `plan.ts` NIGHTLY = NFL and college football) builds the live snapshot, runs the CFB suites, simulates 100,000 runs and publishes through `supabase/simulator.sql` if every gate passes. A night with unchanged inputs reuses the published run (idempotency key). It can also be dispatched by hand (sport `cfb`).
- **Database.** No change needed: `supabase/simulator.sql` already accepts the Estimated provenance; the CFP mode and per-conference rule exposure travel in `validation_summary.cfb`. A scenario-mode run is never published (`cfp.scenario_not_published`), because the tables cannot carry its condition.
- **Reader.** The Simulator seat shows a Conference tab (title game, No. 1 seed, conference title, Make CFP, and the per-conference Estimated-ranking share) and a CFP & Title tab (field, bye, first-round host, rounds, champion, labelled with the rows' own provenance and stating that the proxy is not the committee). Results are read in pages of 1,000 rows.
- **Kalshi.** No CFB futures market is mapped; a CFB run's comparison reports "unavailable" (the shared config is now scoped by sport, so the NFL's 352 mappings no longer fail it).
- **After Selection Day (Dec. 6):** set `simulator/config/cfb_cfp_bracket.json` to `observed`.
- **Next season:** re-read every source with the *Simulator CFB source check* and re-verify in a reviewed commit.

## 17. Repair log

| Problem found | Fix |
|---|---|
| The live board's 2026 90–95% FBS bucket won 17 of 23 (overconfident); the board is more extreme than the validated replay (logit slope 1.15) | the simulator prices from the replay path the calibration validates |
| τ stacked on the engine σ made calibrated games underconfident | σ² decomposed into 2τ² plus game noise; every game keeps Φ(fair/σ) |
| 2014–2021 feeds do not label title games, so champion flags fell back to best records *including* the title game | title games identified as each conference's only game on its last conference date (validated on the labelled 2022–2023 games); proxy refit |
| History test resolved external-ranking ties by a constant surrogate, so they fell silently to later steps | distinct placeholder ranks, so such a step is reported as external |
| The SEC's Estimated scores were abandoned in 1,057 of 100,000 benchmark runs because five non-conference FCS games have no engine total | scores are drawn only for the conference games the step reads (regression test) |
| The blocked CFB reader page no longer named the CFP (browser suite) | each blocker now states the title-game, CFP and national-title outputs it holds back |
| Seed-order-only decisions at neutral sites counted as "rule exposure" | only berth decisions, or a hosted game's host, are counted |
| Assumed 2026 CFP format (five highest-ranked champions) | the 2026 protocol text: four power champions plus the best other team, Notre Dame top-12 |
| The ACC's 2025 tiebreaker would have been reused | the July 2026 policy PDF, alternate-games tied-team definition |
| North Dakota State assumed ineligible from 2025-era reports | the NCAA DI Cabinet release (June 24, 2026); the run measures how much the assumption matters |
| Vacuous and loosely stated synthetic assertions | each replaced by an exact expected answer |
| `pdftotext` missing on the runner | `apt-get update` before installing poppler-utils |
| PR #698 merged before the simulator itself was pushed | rebased onto `main` as PR #703 |
| `main`'s `simulator/src/cli/run.ts` did not parse after the MLB and NBA merges (#701, #702), which dropped the NHL wiring, `parseArgs`'s argument object and `execute()`'s header | both merges replayed cleanly and every sport kept (NFL, NHL, MLB, NBA, CFB); the committee stream moved from 9 to 11 (MLB holds 9 and 10) |
| The job log API returns only the last 5,000 lines, so 26 source texts were lost | one JSON line per text; long documents print only the passages around a pattern |
| League `/documents/*.pdf` URLs answer with a viewer page; the SEC's and conferences' articles are built by scripts | the source job follows the embedded file, renders pages in headless Chrome, and OCRs image-only PDFs |
| Six conference procedures were secondary, prior-season or provisional | the official 2026 texts (ACC, American, Mountain West, Pac-12), CUSA's regulations, the SEC's own release and the Big Ten's own archived release; CUSA-2024, PAC12-2026, AAC-2026 and MW-2026 coded from them |
| Sacramento State's eligibility has no governing-body statement | assumed and measured each run; it blocks only a run that depended on it |
| A CFB run would have failed the Kalshi step on the NFL's mappings, and the markets job could pair one sport's results with another's run | the config is scoped by sport; each published run is compared with its own results |
| A conditional scenario could have been published as unconditional | `cfp.scenario_not_published` holds it |

## 18. File manifest

```
CFB_SIMULATOR_NOTES.md                          this file
simulator/src/sports/cfb/                       config, rules, cfp, committee, inputs, module, status, validate, engine_adapter
simulator/src/cli/run_cfb.ts                    the CFB run path (run.ts --sport cfb)
simulator/src/cli/build_cfb_fixture.ts          the test snapshot
simulator/src/cli/fetch_cfb_sources.ts          the primary-source reader (GitHub runner job)
simulator/src/research/                         cfb_replay, cfb_calibration, cfb_strength_uncertainty, cfb_committee, build_cfb_history_fixture
simulator/data/                                 cfb_calibration.json, cfb_strength_uncertainty.json, cfb_committee_proxy.json, cfb_cfp_rankings_history.json
simulator/config/                               cfb_availability.json, cfb_cfp_bracket.json
simulator/fixtures/                             cfb_2026_wk7_snapshot.json.gz, cfb_history.json.gz
simulator/tests/                                cfb_rules_synthetic, cfb_rules_history, cfb_cfp, cfb_committee, cfb_calibration, cfb_config, cfb_sim (+ _cfb.ts)
.github/workflows/simulator-cfb-sources.yml     the read-only source job
modified: simulator/src/core/engine.ts (Estimated/Observed provenance, sum-rule skip), core/results.ts (per-outcome provenance),
          core/prng.ts (committee stream 11), sports/registry.ts, sports/factory.ts, cli/run.ts, cli/plan.ts (CFB nightly), lib/edgedesk_simulator_sports.js (generated),
          lib/edgedesk_simulator.js (the CFB views, paged reads), publish/publish.ts (validation_summary.cfb), markets/compare.ts + cli/markets.ts (config scoped by sport),
          package.json (sim:cfb:* scripts), .github/workflows/simulator-tests.yml, .github/workflows/simulator.yml (CFB suites, per-run markets), docs/simulator/README.md, SIMULATOR_NOTES.md (§4 CFB row)
```

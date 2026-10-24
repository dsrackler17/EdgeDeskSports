# COLLEGE_BASEBALL_SIMULATOR_NOTES — the Road to Omaha

The engineering record of the college baseball seat of the Simulator: what it
simulates, what it stands on, what was measured, how well it called
tournaments and seasons it had not seen, and what it does not know. Shared
engine, database and reader: [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md). Dates
are UTC; written 2026-10-24.

The served college baseball model (`college_baseball/`, its walk-forward and
learning loop) is not changed. The Simulator replays it. The betting board's
release gates (G11, G12, G15 in `college_baseball/validation/release_gates.json`)
are separate and still fail; nothing here prices a market.

---

## 1. Status

| Area | State | Evidence |
|---|---|---|
| The model | The served "hier" run model (version 1.0.0 of `docs/model-loop/college_baseball/versions.json`), replayed game by game; reproduces all 95,356 committed out-of-sample predictions | `simulator/src/sports/college_baseball/model.ts`, §3 |
| The tournament | 64 teams, double-elimination regionals, best-of-three supers, the College World Series, every game priced by the served model; results so far kept | `bracket.ts`, `sim.ts`, §4 |
| The season (no schedule yet) | The measured move of each rating to Selection Monday, a committee proxy, then the tournament: the **Road to Omaha 2027**, **ACTIVE** | `road.ts`, `module.ts`, §5 |
| Evidence | Every NCAA tournament 2014-2026 the warehouse holds whole (11), from its first pitch; the season walk-forward 2016-2026 (9 seasons) from the preseason and four in-season checkpoints | `simulator/data/college_baseball_backtest.json`, `college_baseball_road.json`, §6 |
| Reader | Road to Omaha, Conferences, Model Health | `lib/edgedesk_simulator_college_baseball.js`, §8 |
| Publication | One competition, `road-to-omaha`, season `2027`; no SQL change | §7 |
| Nightly | From the committed warehouse, through 2027-05-30 (the night before Selection Monday) | `config.ts`, `cli/plan.ts` |

On 2026-10-24 (the 2027 preseason, ratings as of 2026-06-23; 100,000 runs in
20 seconds on four workers) the title favourites are Georgia Tech 8.8%, Texas
8.3%, UCLA 7.4%, North Carolina 7.0%, Georgia 6.6%, Mississippi State 6.5% and
Auburn 6.4%; each of them makes the field about 96% of the time and reaches
Omaha 37-44%.

---

## 2. Data

Everything is read from the repository; nothing is fetched at run time.

- **The warehouse** (`college_baseball/data/games/*.csv`, read through
  `college_baseball/lib/warehouse.js`): every Division I game 2012-2026. A
  game informs the ratings only if it is final, scored, not quarantined and
  both programs are identified (the warehouse's own rule). The 2023 season
  holds results only through 2023-03-29, and 2020 had no tournament.
- **The served configuration and constants**: `docs/model-loop/college_baseball/versions.json`
  (sigma_team 0.12, sigma_conf 0.05, carry_team 1, phi 1.25, half-life 180
  days; negative binomial r 3.256) and `college_baseball/params/constants.json`.
- **The committed out-of-sample predictions**
  (`college_baseball/validation/oos_team_predictions.csv.gz`): the check that the
  replay is the served model (§3).

---

## 3. The model bridge (`model.ts`)

The replay runs the served `TeamQuality` exactly as the walk-forward scores it:
for each date, predict every game, then add the date's games, then refit. It
keeps:
- **snapshots** at chosen dates (before that date's games): each team's
  offence, defence and the two parts of its posterior sd (its own, and its
  conference's, which cancels in a conference game), the run level, the home
  terms and the parks. A game is rebuilt from a snapshot with the model's own
  formula (`lh = exp(mu + off(home) - def(away) + hb [home] + park)`);
- **each game's out-of-sample prediction**, for the run-space calibration of
  season S, fitted on S-3..S-1 (`college_baseball/lib/calibration.js`): the
  betting board's `hier_cal` pricing model.

Checks: the replay matches every one of the 95,356 committed out-of-sample
predictions to their rounding (largest gap 5e-5, the CSV's precision); a
snapshot rebuilds the served expectations and sd to 1e-9; the price equals
`calibration.js pOf`. The full replay takes about 45 seconds.

A season after the warehouse's last starts from the model's own priors (last
season's strength, regressed toward the current conference), with 2026
memberships where 2027 has none.

---

## 4. The tournament (`bracket.ts`, `sim.ts`)

**Format** (unchanged since 1999): 16 four-team double-elimination regionals
(game 1 the 1 seed against the 4, game 2 the 2 against the 3, then the two
losers, the two winners, the loser of game 4 against the winner of game 3, the
final, and a game 7 only if the losers'-bracket team wins it); 8 best-of-three
super regionals; two four-team double-elimination brackets in Omaha and a
best-of-three final.

**Rebuilt from the games**, so nothing about a past bracket is typed in and
2023's missing tournament flag does not matter: the regional weekend is the
five-day window whose games split into sixteen groups of four that played only
each other (of such windows, the one holding the most games: 2017's Stanford
regional began on a Thursday); the host is the team at home in a non-neutral
game; who advanced is read from who played in the next round, so a disputed
(quarantined) score never decides it. All 11 tournaments 2014-2026 the
warehouse holds rebuild, champions correct. Four regionals and two supers show
no host in the data (neutral sites, or the host's games marked neutral); they
are played neutral, as the served model saw them.

**Venues**: the regional host at home in its games, the other regional games
neutral at its park; the super-regional host at home; Omaha neutral. Before a
super's host is known: the national seed if it advanced, else the other
regional host, else the stronger team (named the actual host in 74 of 86 past
super regionals).

**Uncertainty, drawn once per simulated tournament**: each team's strength is
shifted by a draw from its posterior (its own part, plus its conference's,
shared by the conference), so an underrated team stays underrated through all
its games. Averaged over the draws, each game's price is the served one
(checked by test).

**Results so far** are never simulated: the n-th meeting of two teams is the
n-th game between them (two teams meet in one round only).

---

## 5. The season, before its schedule exists (`road.ts`)

1. **The move to Selection Monday.** `net(selection) = mean + slope x (net(now) - mean)
   + conference draw + team draw`, measured on 2014-2026 (the replayed model's
   ratings at each checkpoint against the morning of the first regional game).
   From the preseason: slope 0.939, team sd 0.177, conference sd 0.053 (the
   served model's own preseason sd, 0.17, is about right). In season: 70 days
   out 0.120, 42 days 0.076, 21 days 0.047, 7 days 0.016, conference part
   zero; interpolated by the days left. Offence and defence move by half each.
2. **The committee proxy** (Estimated). One automatic bid per conference that
   holds one (the 29 in the 2026 field), its winner drawn with chances in
   proportion to `exp(k x net)`, k = 6 (exact likelihood on the one-bid
   conferences, whose only team in the field is certainly the winner); the
   at-large bids to the best of the rest by net plus noise sd 0.15; the 16
   hosts the best of the field by net plus noise sd 0.15, the first eight the
   national seeds (both sds by the simulated likelihood of every past field
   and host). Regionals follow the S-curve (host k with 2 seed 33-k, 3 seed
   32+k, 4 seed 65-k), supers pair national seed k with host 17-k, Omaha's
   brackets hold 1, 8, 4, 5 and 2, 7, 3, 6.
3. **The tournament** of §4, priced from the drawn ratings with the posterior
   sds a Selection Monday has (team 0.087, conference 0.040).

Outcomes per Division I team (305): the automatic bid, make the field, host a
regional, a national seed, win a regional, reach Omaha, the final, the title.
Sum rules every run: one automatic bid per conference that holds one; 64, 16,
8, 16, 8, 2, 1.

---

## 6. Evidence

### 6.1 The tournament (`simulator/data/college_baseball_backtest.json`)

Each of 2014-2019, 2021, 2022, 2024-2026 simulated 20,000 times from the
morning of its first regional game. The served configuration was chosen on
2014-2022 games (SELECTION); 2023-2024 VALIDATION, 2025-2026 HOLDOUT. Ratings
are point-in-time throughout.

| What | Model | Every team equal | Seed lines | Model − seed lines (95%) |
|---|---|---|---|---|
| Regional winner, log loss (176 regionals) | 1.003 | 1.386 | 1.112 | −0.109 (−0.175 to −0.041) |
| Reaching Omaha, Brier (every team) | 0.0868 | 0.1094 | 0.0954 | log loss −0.034 (−0.056 to −0.013) |
| Champion, log loss (11) | 3.41 | 4.16 | 3.92 | −0.50 (−1.21 to 0.21) |
| Champion once Omaha opens (among 8) | 2.086 | 2.079 | — | vs equal +0.007 (−0.42 to 0.45) |

Single tournament games, priced the morning of each date: 1,419 games, log
loss 0.611 against a coin's 0.693 (−0.082, −0.100 to −0.062); regionals
0.593, supers 0.651, Omaha 0.680 (no better than a coin). Calibrated: a
favourite at 50-60% won 53%, 60-70% 65%, 70-80% 78%, 80%+ 86%.

Champions and their chance before the first pitch: 2018 Oregon St. 15.6%
(favourite), 2024 Tennessee 20.6% (favourite), 2019 Vanderbilt 15.0% (2nd),
2025 LSU 9.8% (3rd), 2017 Florida 6.0% (5th); the long shots 2016 Coastal
Carolina 0.5%, 2022 Ole Miss 1.0%, 2026 Oklahoma 0.2%.

### 6.2 The season (`simulator/data/college_baseball_road.json`)

Walk-forward over 2016-2019, 2021, 2022, 2024-2026: every parameter measured
on earlier seasons only, each season simulated 5,000 times from each
checkpoint. Log loss per Division I team.

| From | Make the field | Base rate | Last season | Model − last season (95%) | Reach Omaha | Last season |
|---|---|---|---|---|---|---|
| Preseason | 0.392 | 0.515 | 0.452 | −0.060 (−0.076 to −0.045) | 0.0755 | 0.1023 |
| 10 weeks out | 0.347 | 0.515 | 0.452 | −0.105 | 0.0731 | 0.1023 |
| 6 weeks out | 0.314 | 0.515 | 0.452 | −0.138 | 0.0704 | 0.1023 |
| 3 weeks out | 0.300 | 0.515 | 0.452 | −0.152 | 0.0688 | 0.1023 |
| 1 week out | 0.284 | 0.515 | 0.452 | −0.168 | 0.0677 | 0.1023 |

Every checkpoint beats both baselines for the field, hosting and Omaha with
the interval below zero. The title beats the base rate from every checkpoint
but not clearly last season. From the preseason the field chance runs hot near
the bubble: teams given 40-60% made it 40% of the time, 60-80% 63%, 80-95% 82%.

### 6.3 Activation (`activation.ts`)

Written after the first backtests, so a floor, not a preregistration. ACTIVE
only while: regional winners beat every team equal and the seed lines, Omaha
beats 8 in 64, the single games beat a coin (tournament backtest), and from
the preseason the field and Omaha beat both the base rate and last season
(season backtest), each with its interval entirely below zero. The title is
not a condition (eleven tournaments cannot show it).

---

## 7. Runs and gates (`run.ts`)

`node simulator/src/cli/run.ts --sport college_baseball --workers 4 --dry-run`.
Gates: `model.replay` (every warehouse game replayed, the season's calibration
present), `season.window` (before Selection Monday: from the field's
announcement the proxy no longer applies), `teams.field`, `research.params`;
publication only: `results.current` (in season, 2027-02-19 to the regionals,
the warehouse's last game at most four days old), then the shared run gates.
Out of season the as-of is the morning after the warehouse's last game, so the
input hash, the seed and the numbers hold until a game is added; the nightly
run then reuses the published run (the idempotency key).

---

## 8. Reader (`lib/edgedesk_simulator_college_baseball.js`)

- **Road to Omaha**: every team's chance at each level, with the Monte Carlo ±
  and fair decimal and American odds for the title; the first 40 by the title
  chance, then all.
- **Conferences**: expected bids, hosts and Omaha teams per conference; one
  conference's teams with their automatic-bid chance (a picker).
- **Model Health**: §6, in plain words, and what the model does not know.

---

## 9. Known limitations

- No 2027 schedule exists: the season is the measured move of each rating, not
  a game-by-game simulation. Once 2027 games are in the warehouse the view
  starts from the served model's current ratings.
- The committee is a proxy; geography (which moves real 2-4 seeds between
  regionals) is not modelled; national seeds are the proxy's top eight hosts
  (no past seed list is in the warehouse).
- The tournament itself, from the bracket the committee names, is not a
  published view yet: the engine and its backtest exist (§4, §6.1); the 2027
  bracket is the missing input (June 2027).
- Roster turnover, the transfer portal, the draft and 2027 conference moves;
  starting pitchers (the board's pitcher layer is not part of the served team
  model).
- Every number passes through the committee proxy (Estimated); there is no
  market to compare it with.

---

## 10. Reproduce

```
npm run sim:cbase:study      # both backtests (about 6 and 6 minutes)
npm run sim:cbase:test       # the engine and the reader
npm run sim:cbase:dry-run    # the 2027 Road to Omaha, 100,000 runs
```
Each season: re-run both backtests and set the new season, the regionals'
date (the Friday after Memorial Day) and nightly_through in
`simulator/src/sports/college_baseball/config.ts`.

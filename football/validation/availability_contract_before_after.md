# Fixture-scoped, dated availability: the published slate before and after

**Method.** `football/fbs/build_coverage.js` was run twice, back to back, on the same committed inputs:

- once at the parent commit, in a git worktree;
- once with this change.

Every one of the 129 games in the published slate was compared field by field. The per-game record, with each reason, is in `availability_contract_before_after.json`.

## What moved

| | Games moved (of 129) |
|---|---|
| Fair spread (`model_home_line`, `model_home_margin`) | **0** |
| Fair total | **0** |
| Win probability | **0** |
| Engine information confidence | **24**, all up, by +4.2 to +5.0 |
| Engine priced confidence | **2**, both down, by −5.2 |
| Reliability score (from the evidence package) | **0** |
| `reliability_without_evidence` (from contract rows only) | **25** |

Slate averages:

| | Before | After |
|---|---|---|
| Information confidence | 79.42 | 80.32 |
| Priced confidence | 44.97 | 44.89 |
| Input coverage | 0.744 | 0.757 |

## Why no fair spread moved

The injury term moves the mean only for an explicitly **primary quarterback** absence (`context.injuryImpact`, the one trained absence coefficient). Every row this change removed from a priced list was a wide receiver or running back, which only enter the uncertainty term:

- Kahleil Jackson, Florida WR, OUT, published 2020-11-21;
- Aidan Laughery, Illinois RB, OUT, published 2022-11-03.

The quarterback availability term is part of the information layer (`uncertainty.information.quarterback`), which weights confidence and never the mean.

So the three defects were live on this slate, but on this week's data they touched confidence and not price. A historical or other-fixture OUT on a starting quarterback would have moved the price, by the trained primary-QB effect (−3.9 points in the parity test). Test 1a pins its refusal with a QB1 row.

## Why confidence moved, by defect

### 1. Historical ESPN rows reached the priced injury list

All five rows in the automated read (`football/availability/current.json`) are ESPN designations from 2020–2022. The collector re-reads them each run and stamps them `observed_at` = this morning. The contract dated them by that stamp, so they passed as current.

They are now judged against each game's kickoff by the availability layer's own ladder (`getAvailabilityFreshness`) and refused as HISTORICAL. An injury row's `as_of` is now its publication time.

| Game | Side | Priced injury list, before → after | Priced confidence |
|---|---|---|---|
| Illinois @ Ohio State | Illinois | 20 → 19 (the 2022 RB row removed) | 52.9 → 52.9 |
| Ole Miss @ Florida | Florida | 2 → 1 (the 2020 WR row removed) | 53.0 → 53.0 |
| Florida @ Missouri (Oct 3) | Florida | 1 → **null**; the SEC report is NOT_DUE_YET | **52.6 → 47.4** |
| Purdue @ Illinois (Oct 3) | Illinois | 1 → **null**; the Big Ten report is NOT_DUE_YET | **52.9 → 47.7** |
| Rice @ Fresno State, UTSA @ Rice | Rice | unchanged (null); the contract row now names the refused 2022 row | unchanged |

For the two October 3 games, the stale row was the only thing standing in for a report that does not exist yet. The engine now hears "unknown" for that side, as it should, and prices it as unknown.

### 2. QB availability read the wrong field, had no clock, and ignored the state

Three separate faults:

- `build_starters.js` read `status`, but the collector writes `availability_status`.
- `starters.js availabilityFor` had no staleness check.
- The engine scored any EXPLICIT record as 1, so an explicit OUT counted as "known to play".

On this slate the defect was live for SMU:

- Kevin Jennings's 2022 ESPN row (`INJURY_STATUS_ACTIVE`) was carried as EXPLICIT evidence with state UNKNOWN.
- Now it is refused. SMU's QB availability is NOT_REQUIRED (Missouri State, non-conference) or NOT_DUE_YET (Boston College).
- Engine confidence is unchanged on both games, because the other side's quarterback was already the weaker of the two. `reliability_without_evidence` falls 1 point on each.

The contract also now grants COMPREHENSIVE_SILENCE whenever this game's fresh (48 hours or less), fully read comprehensive filing does not name the quarterback, **whoever else it lists**. The old rule required the filing to name nobody at all, so every team with one listed linebacker had an "unknown" quarterback.

That lifted information confidence by +4.2 to +5.0 on 24 conference games this week (ACC, Big 12, Big Ten, SEC). Two of those quarterbacks are named on their filing as PROBABLE:

- Gio Lopez, Wake Forest;
- Keyone Jenkins, UCF.

The engine now reads that state through the trained status weights: 1 − 0.15 = 0.85, not 1.

### 3. One official-report slot per team graded the wrong fixture

The merged availability view kept one `official_report` per team: the last file in name order. For example, Clemson has filings for 401858229 (last week) and 401858234 (this week), and 401858234 won the slot. Two things followed:

- this week's filing could be hidden behind last week's;
- any filing made the whole team OFFICIAL.

The view now keeps `official_reports[game_id]`, and grades each fixture from its own evidence (`overlay.gradeFor`).

On this slate no published number or confidence depended on it. All 16 teams with two filings on disk have this week's filing sorting last.

The tests pin the order that breaks it: last week's filing sorting after this week's. That happens whenever a team's next game has the lower ESPN id, because ids are assigned when the schedule is loaded, not in date order.

## Tests pinning each case

`football/matchup/availability_fixture.test.js` (38 checks). It now also runs on every pull request in `collective-tests.yml`.

- **1a–1g, historical rows and dates:**
  - a 2020 row re-read today is refused;
  - a graded read of only historical rows is null, never `[]`;
  - HISTORICAL is judged against the kickoff;
  - `as_of` is the publication time;
  - the overlay's ladder matches `availability.js` case for case;
  - a row filed for this game is always about this game.
- **2a–2m, the quarterback:**
  - the collector's field is read;
  - the starter layer refuses the SMU 2022 row;
  - a record with no designation is not EXPLICIT;
  - the contract reads this fixture's row with its state;
  - the committed SMU record is refused;
  - silence on a fresh comprehensive filing that lists others is COMPREHENSIVE_SILENCE;
  - silence is refused on another game's filing, a selective filing, a filing older than 48 hours, a filing with unparsed lines, and a filing that names him with a designation the contract cannot read;
  - `qb_context` carries the state;
  - the engine scores OUT as 0, reads QUESTIONABLE, DOUBTFUL and PROBABLE through the trained weights, and scores AVAILABLE or silence as 1.
- **3a–3e, per-fixture slots:**
  - two filings keep two slots;
  - this game's comprehensive filing still reaches the engine when another sorts after it;
  - a filing for another game does not grade this one OFFICIAL;
  - an operator entry grades only its own fixture;
  - the same holds through the full assembly.

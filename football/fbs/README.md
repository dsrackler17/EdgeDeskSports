# The FBS universe

One canonical answer to three questions, read by the board, the exports, the
rating build, the daily health check and the coverage gate:

* **Who is an FBS team this season?**
* **What conference are they in *this* season?**
* **What belongs on the weekly slate, and what kind of game is each one?**

```
football/fbs/
  fbs.js              the module (UMD, exports EDFbs) — pure, no I/O
  build_coverage.js   the CI gate + the machine-readable diagnostic
  fbs.test.js         the rules, enforced (157 checks)
  coverage.json       the diagnostic the gate writes
  slate.json          the canonical slate, every stable field on every row
```

---

## Nothing about membership is stored

Every answer is **derived from the season's own schedule feed** —
`cfbfastR-data schedules <season>` — which is the same artifact the rating
state, the rankings pipeline and the Collective settler already read.

That is not a stylistic preference. Realignment happens every winter and
programs move up from the FCS: between 2025 and 2026 alone, nine FBS programs
changed conference and two joined the subdivision. A list frozen in a source
file is a list that is wrong by September. `coverage.json` records the 2025→
2026 moves it verified, and the count of active FBS programs is a number the
build computes, never one it carries.

**What *is* hardcoded is one conference NAMING table.** Feeds spell the same
conference four ways — "American Athletic", "American", "AAC", "The
American" — and two feeds disagree about the same league on the same day. The
table maps every spelling onto one id and one display name. It does not decide
who is in the conference. A label the table has never seen still resolves, to
a slug of itself carrying its own source spelling, and is reported as an
unexpected label rather than silently dropped.

---

## Power 4 is a view, not a gate

The board covers every game with at least one active FBS team. `Power 4`,
`Other FBS` and `Independents` are groupings a reader filters **by**.

The Power 4 set itself is resolved per season from the trained universe's own
membership record (`params.universe.p4_by_season`, derived from the schedules).
Past the end of that record the nearest earlier season is used and the basis
says so, out loud, in the product.

There is deliberately no "Group of 5": the 2026 FBS has six non-power
conferences, so the name is simply false. **Other FBS** is the durable
user-facing category and the individual conferences sit underneath it.

---

## What the module exposes

| | |
|---|---|
| `normKey(name)` | the canonical team key — byte-for-byte the Power 4 engine's, so one team is one team across every artifact |
| `conference(label)` | one spelling → one id, one display name, one group; an unknown label still resolves and is flagged |
| `isFbsDivision(div, name, {knownFbs})` | the subdivision, read case-insensitively, falling back to the seeded rating table when a feed carries no division |
| `p4Scope(season, opts)` | the season's Power 4 conference set, with the basis it was resolved on |
| `buildUniverse({rows, season})` | every team the season's schedule contains, with conference, group, aliases and a diagnostics block |
| `classifyGame(row, universe)` | matchup type, conference-game flag and its basis, both conferences, both groups, eligibility, projectability |
| `buildSlate({rows, universe, now, lookaheadDays})` | the canonical weekly slate, deduplicated by game, in kickoff order |
| `filterSlate(items, filters)` | group / conference / matchup filters, composed — one row per game however many selections it matches |
| `teamIndex` / `resolveTeam` / `matchesEvent` | the odds join (see below) |
| `audit(universe, opts)` | everything a build-time gate needs, as data |

---

## Joining a sportsbook feed to a schedule feed

Two feeds never spell a school the same way. A book writes the nickname
("Ohio Bobcats"), an abbreviation ("Southern Miss"), a state short form
("UL Monroe"), or punctuation the other feed does not use ("Miami (OH)",
"Hawai'i", "Texas A&M").

The board's old join was a bare prefix test —
`norm(bookName).indexOf(norm(scheduleName)) === 0`. On a Power 4 slate that
mostly worked, because the ambiguous pairs were rarely both on the board.
Across the whole FBS they routinely are: `"Miami (OH) RedHawks"` begins with
`miami`, so Miami **Florida** would have taken Miami **Ohio**'s quote, and
`"Ohio State Buckeyes"` begins with `ohio`.

The rule now is **exact key → curated alias → longest unambiguous prefix**,
over canonical names and aliases together. A tie resolves to **nothing**: an
unmatched quote is a reported miss, a quote on the wrong team is a fabricated
market. Both sides of an event must resolve to the game's own teams, and the
kickoffs must agree — half a match is not a match.

`fbs.test.js` holds 25 named alias cases plus the Miami and Ohio collisions
specifically.

---

## The coverage gate

```
npm run cfb:fbs          # write coverage.json + slate.json
npm run cfb:fbs:check    # run every check, write nothing
node football/fbs/build_coverage.js --season 2026 --offline
```

It rebuilds the universe, replays the rating state the browser replays,
builds the slate, projects every eligible game, and then asks the fourteen
questions a coverage regression would answer wrong:

1. every active FBS team resolves to a canonical identity
2. every active FBS team has a conference or Independent classification
3. every FBS-vs-FBS game has both teams in the rating state
4. no canonical game is duplicated
5. no eligible game is dropped because neither participant is Power 4
6. cross-conference games classify correctly
7. conference games classify correctly
8. FBS-vs-FCS games stay visible and are never graded as a normal projection
9. a game with no quote produces no line, no gap and no spread edge
10. the market layer can still separate a live quote from a stale one
11. the slate the board renders and the slate the export writes are one list
12. selecting two conferences never duplicates a game
13. conference attribution is season-correct against the prior season's feed
14. the active FBS count comes from the feed, not from a stored number

Exit 0 = every check passed. Exit 1 = a real coverage regression. **Exit 2 =
the job could not run at all**, which is reported as an inability to check
rather than as a pass. `.github/workflows/football-weekly-build.yml` runs it
before the commit step and refuses to publish on a failure.

`coverage.json` also carries the diagnostics a human needs: unmapped teams,
ambiguous aliases, missing conference assignments, FBS teams missing ratings,
duplicate games, eligible games with no projection, and unexpected conference
labels.

---

## What this layer does NOT do

It does not rate anybody, price anything, or decide what a good bet is. It
answers identity and eligibility, and hands the answer to the engine that
already knew how to price every FBS team.

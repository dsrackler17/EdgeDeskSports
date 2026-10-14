# The EdgeDesk Quant Data Pack — how it was integrated

The pack arrived as four archives. It is imported, byte for byte, into
`datapack/quant_v1/` (`IMPORT.json` records each archive's size and SHA-256).
I read `CLAUDE_START_HERE.md` and `COVERAGE.md` first. The pack calls itself
historical research data with contracts, not a trained model or a betting
feed, and nothing here treats it as more than that.

## What arrived, and what did not

| Archive | Contents | State |
|---|---|---|
| `EdgeDesk_01_Core_and_Other_Sports.zip` | docs, 43 contracts, 136 features, 14 sources, scripts, 42 tables | imported |
| `EdgeDesk_02_NFL_2022.zip` | **0 bytes** | **NFL 2022 play-by-play is MISSING** (expected SHA-256 `0c69a71e…`, 49,434 rows); not reconstructed |
| `EdgeDesk_03_NFL_2023.zip` | NFL 2023 play-by-play, 19 MB | verified; kept outside git in `.cache/datapack` |
| `EdgeDesk_04_NFL_2024.zip` | NFL 2024 play-by-play, 19 MB | verified; kept outside git in `.cache/datapack` |

`tools/datapack/fetch_external.js` re-fetches the out-of-git files from
nflverse and accepts them **only on a matching SHA-256**. nflverse revises
play-by-play in place, so a changed file is `REVISED_AT_SOURCE` and is never
used as the pack's file.

## Verification (`tools/datapack/verify.js` → `EDGEDESK_VERIFICATION.json`)

This re-implements the pack's own `verify_pack.py` in Node. That script is
never executed: the pack is data, not trusted code. The verifier also adds
the checks the import needs. Result: **PASSED**. 44 of 45 tables are verified
by SHA-256, row and column counts; 1 is missing (above).

- `known_at` is blank on every historical row, so nothing is backdated.
- The 43 contract tables are unique, their columns match their JSON Schemas,
  and the SQLite DDL creates all 43.
- Every EMPTY_TEMPLATE is empty.
- All 40,992 NFL prior-5/10/20 lag values were recomputed, with target-game
  and same-day exclusion: 0 errors.
- NHL and goalie xG and GSAx were never invented.
- Tennis draws are separated and matches are unique.
- 584 source-manifest hashes are verified.
- No table is unlisted.

`engine/quant.js` ports the pack's `quant_math.py`: prices, no-vig, EV with
pushes and voids, quarter-line split settlement, baseball outs and the
fail-closed as-of rule. It is held to the pack's own test cases.

## The pack's instructions, step by step

1. **Contracts and ID mapping, without replacing working systems.** Ingestion
   (`*/ingest.js`), deterministic models (`*/model.js`, `*/walkforward.js`)
   and the desk's explanations stay separate. The desk reads probabilities
   from slates and never generates one. The ID mappings are:
   - ESPN↔NHL: `hockey/data/crosswalk/espn_nhl_2025.csv`, 1,398 games;
   - ESPN↔sportsdataverse: the same game IDs;
   - ESPN↔openfootball: by date and club;
   - nflverse game IDs.
2. **Native fields to canonical contracts, with units, availability and
   quality flags.** `hockey/contracts/canonical.js` validates three NHL tables
   row by row (zero errors) and gives a reason for every always-empty field.
   Time follows the pack's rule:
   - `known_at` is blank;
   - `assumed_available_at` is explicit;
   - `pit = RETRO`;
   - every record says RETROSPECTIVE.
3. **NHL first** (`docs/engine/NHL.md`):
   - **Shots:** approved shot data and the walk-forward xG model.
   - **Goalies:** starts are verified against a second source (156 of 160 are
     the most-TOI goalie; the 4 exceptions are pulled starters). Goals against
     agree 167 of 167.
   - **Strength-state rates:** time and xG by 5v5, 4v4/3v3, PP, SH and empty
     net.
   - **Lineup availability:** built and measured. Confirmed lineups help
     (−0.0009 log loss), but no pregame feed exists, so they are not in the
     price.
   - **Scoring distribution:** out of sample, with the moneyline and puck line
     validated against outcomes.
   - **Still missing:** shift charts (available at the source, not ingested),
     goalie TOI, and shots on goal faced.
4. **Every other sport, from its own data:**

   | Sport | Brain | Data |
   |---|---|---|
   | Basketball ×4 | `basketball/` | 2008/2010–2026 |
   | Soccer ×5 | `soccer/` | — |
   | MLB | `mlb/history/` | — |
   | UFC | measured only | — |
   | NFL, CFB | existing brains | — |

   The pack's ESPN seasons are reconciled against each brain's source
   (`EDGEDESK_CROSSCHECK.json`). Where the pack has games the source lacked,
   it fills them, labelled: 209 women's college games from 2024-25, mostly
   the March tournaments. 2024 MLB comes entirely from the pack (without
   starters). College baseball (313 games) and tennis (two four-date samples)
   are too sparse for a model and say so.
5. **Adapters.** All of them go through `engine/http.js`, which provides:
   - a disk cache and ETag revalidation (incremental: completed seasons are
     cached for 30 days, the current season for hours);
   - bounded retries honouring Retry-After;
   - in-flight dedupe;
   - per-provider run/day quotas and a circuit breaker;
   - registered free hosts only.

   Job dedupe is handled by workflow concurrency groups. Missingness
   diagnostics are in `engine/missingness.json`. No paid call was added. The
   odds key is reachable only through `odds_gateway`, and NHL prices stay
   disabled until authorised.
6. **Chronological train/tune/calibrate with held-out evaluation.** This is
   `engine/lab/protocol.js`, applied unchanged to every league. Revision
   leakage is audited on every prediction: 0 violations everywhere, after the
   NCAA audit caught and forced a fix of a day-grouping leak. No props were
   added: none has a validated model.
7. **One cross-sport board at verified, fresh prices.** `lib/edgedesk_xboard.js`
   v2 handles pushes, voids and split settlement, and adds a sensitivity gate
   (worst scenario, a worse tick, another reference). Without a fresh price
   every row is research, and the board says **PASS**.
8. **The UI keeps the stages apart.** The Engine panel's readiness ladder
   shows, per sport: historical data loaded · model trained · validation
   passed · tested against closing prices · market price verified now ·
   actionable signal.

## What is still missing

- Licensed, timestamped closing prices for any sport. Without them no market
  can be MARKET_VALIDATED, and no value claim is ever on.
- Injury, lineup and availability archives for every sport.
- NFL 2022 play-by-play (the upload was empty).
- Soccer xG; UFC round statistics (UFCStats refuses automated access); serve
  and return data for tennis; a complete college-baseball archive.
- Retrosheet's 2024 and 2026 game logs.
- Owner review of terms before any paid use. NHL.com, ESPN, MLB and Retrosheet
  each have their own terms; openfootball is public domain; nflverse is
  CC-BY-4.0.

---

# The EdgeDesk NHL Data Pack — how it was integrated

A second, NHL-only pack arrived as `EdgeDesk_NHL_Data_Pack.zip` (26.5 MB,
SHA-256 `c725dbbe…`). It is ESPN's retrieval of the **whole 2024-25 NHL
season**. It is imported as shipped into `datapack/nhl_v1/` (`IMPORT.json`).
The two largest tables are stored gzipped: `events.csv` is 116 MB, over
GitHub's file limit. Both are verified on their uncompressed bytes.

I read `CLAUDE_NHL_START_HERE.md`, `README.md`, `COVERAGE.json`,
`docs/MISSING_DATA_PRIORITY.csv` and `sources/ACCESS_AND_RIGHTS.md` first.
The pack calls itself historical facts and features, not a trained or
validated oddsmaker, and it is used as exactly that. Its schemas are
byte-identical to the Quant Data Pack's contracts, so
`hockey/contracts/canonical.js` already covers them. Its `quant_math.py` is
the same file already ported to `engine/quant.js`.

| Table | Rows | Columns |
|---|---:|---:|
| games | 1,398 (1,312 regular season, 86 playoffs) | 24 |
| events | 448,177 | 21 |
| shot_attempts | 167,569 | 41 |
| player_game_boxscores | 53,259 | 41 |
| goalie_game_boxscores / measured features | 2,953 | 20 / 15 |
| team_game_boxscores / measured features | 2,796 | 19 / 41 |
| pregame_lagged_research_features | 2,796 | 59 |
| officials | 5,722 | 4 |
| schedule_all_statuses | 1,514 | 11 |

## Verification (`tools/datapack/verify_nhl.js` → `EDGEDESK_VERIFICATION.json`)

**PASSED, 34 of 34 checks**, in Node. The pack's Python is never run. The
checks cover:

- **Inventory:** hashes, row and column counts.
- **Time:** `known_at` is blank in every table.
- **Scope:** 32 clubs, the 7 Four Nations events excluded and counted, and
  every final club game delivered.
- **Keys:** unique keys; every shot is an event of a delivered game.
- **Shooting team:** `shooting_team_id` is a club, or explicitly unmapped
  (33).
- **Never filled:** xG, GSAx and pregame goalie confirmation stay blank.
- **Goals:** final minus non-shootout goals is the shootout winner (77
  shootouts).
- **Units:** TOI parsed from mm:ss; ES + PP + SH = TOI.
- **Features:** every measured team-game feature and every prior-5/10/20
  lagged feature recomputed, with the target game excluded.
- **Schemas:** identical to the contracts; each JSON Schema matches its empty
  template.

The verifier also records facts about the data, not pass/fail:

- **Blocked rows:** the native team is the defending team 91% of the time,
  and the shooting team the rest, so only `shooting_team_id` can say who shot.
- **Assists:** the by-role object collapses two assisters into one in all
  6,348 two-assist goals.
- **Goals and goalies:** every goal row lacks a goalie id.
- **Shootout goals:** `SOG` means shootout goals in these boxes and is never
  populated, even in the 77 shootouts.
- **Goals-against:** in 20 goalie rows GA counts a goal that SA does not.
- **Missing rows:** one team-game has no goalie row, and one game has no
  officials.
- **Officials:** playoff listings name three referees.
- **Neutral sites:** four games (Prague, Tampere).
- **Not recorded:** `end_period` is never populated.
- **Unverifiable:** the source manifest's 1,408 response digests cannot be
  re-hashed here, because the raw responses were not shipped.

## What the pack's instructions asked, and what was done

1. **Stable IDs, provenance, scope.**
   - Games map 1,398/1,398 to NHL ids (`hockey/data/crosswalk/espn_nhl_2025.csv`).
   - Players map 1,027/1,027 (`espn_nhl_players_2025.csv`): 1,020 from id
     pairs carried by matched events, 7 by name within the team-game.
   - The 32-club scope holds; Four Nations events are excluded; shootout
     conversions are never counted as ordinary goals.
2. **`shooting_team_id`, not the native team; Even Strength is not 5v5;
   shot type is engineered.** Every count here uses the shooter. This exposed
   **an error in my own ingest**: my NHL feed names the blocking team on a
   blocked attempt, and my ingest had credited it to the blocker.
   - Across every season it is the shooter's club in 1 of 610,859 blocked
     attempts.
   - Against ESPN it is the shooter's club in 0 of 47,087 matched.
   - Fixed in `hockey/ingest/game.js`: every season was re-ingested and
     refitted (`docs/engine/NHL.md` §1).
   - "Even Strength" is 5v5 in 94.6% of attempts, so my states come from
     skater counts.
   - The description-extracted shot type agrees with the NHL's code 99.5% of
     the time.
3. **Units and nulls.**
   - TOI is parsed to seconds and verified.
   - ESPN's coordinates, unverified in the pack, are the NHL's raw rink feet
     (99.4% within 1 ft).
   - Nulls stay null: no xG, GSAx, starter confirmation, shifts or prices
     were invented.
4. **P0 gaps.**
   - **Shot model:** my own xG is regularised and walk-forward (each season
     scored by a model fitted on earlier seasons, `hockey/xg/report.json`).
   - **Strength-state exposure:** built from the NHL feed's on-ice counts.
   - **Still missing:** timestamped goalie and lineup reports, shift charts,
     and odds. No authorised source exists; nothing is filled in their place.
5. **Separate regulation and OT/shootout components.** These already exist:
   - a regulation goal model;
   - an overtime and shootout model;
   - separate fair prices for the regulation 3-way and the moneyline
     including OT, then puck lines and totals (`hockey/model/distribution.js`).

   Player props are not offered: no validated opportunity or TOI model exists.
6. **Chronological held-out evaluation.** The walk-forward was rescored after
   the fix:
   - 17,236 games, 0 leakage violations;
   - against Elo, −0.0038 log loss (95% −0.0056 to −0.0021);
   - moneyline and puck line OUTCOME_VALIDATED; totals and the 3-way
     PROVISIONAL.

   The pack's lagged features were tested against my out-of-sample
   probabilities on a later hold-out. None adds information
   (`hockey/validation/nhl_pack_features.json`). Officials show no repeatable
   referee effect (`hockey/validation/nhl_officials_research.json`). Neither
   enters a price.
7. **Odds only from verified fresh quotes.** Unchanged: NHL price capture
   stays disabled until authorised. Without a fresh price there is no EV
   claim, and the board says PASS.
8. **The interface.**
   - The NHL page's record names its second source with these figures, as a
     check of past data, not a forecast.
   - The Engine panel's readiness ladder and sources list it.
   - Nothing from 2024-25 is shown as a current projection.

## Still missing (the pack's P0 list, unchanged by this import)

- Timestamped executable odds and settlement rules.
- Pregame goalie confirmations and lineup or injury reports with timestamps.
- Shift charts, and so exact on-ice exposure from a second source and empty
  net per shot.
- First-publication times.
- More than one season from this second source.

---

# The EdgeDesk NFL Data Pack — how it was integrated

`EdgeDesk_NFL_Data_Pack.zip` (29 MB, SHA-256 `b8f05d62…`) is imported as
shipped into `datapack/nfl_v1/`. It contains:

- nflverse 2025 and 2026 play-by-play (62,613 plays, all 372 native columns);
- snap counts, season and weekly rosters, depth charts, injuries, PFR
  advanced passing/rushing/receiving/defense and NGS aggregates for 2024–2026;
- derived team-game, opportunity, label and lagged tables for 2022–2026.

Its 2022–24 seed tables are byte-identical to the Quant Data Pack's NFL
tables. Its contracts are identical too. The pack's Python is never run;
Parquet is read by my own helpers (`tools/datapack/parquet_meta.py`,
`tools/datapack/parquet.js`) under `python3 -I`.

## Verification (`tools/datapack/verify_nfl.js` → `EDGEDESK_VERIFICATION.json`)

**PASSED, 18 of 18 checks.**

- **Inventory:** every file's SHA-256, rows and columns match the inventory,
  and every Parquet file matches its digest in the lossless-encoding
  manifest.
- **Time:** `known_at` is blank throughout.
- **Seeds:** identical to the earlier pack.
- **Play-by-play:** unique `(game, play)` keys; 285 games in 2025 (272
  regular season, 13 playoff); 79 in 2026, through week 5 on 2026-10-12.
  **2026 is PARTIAL.**
- **Recomputed from play-by-play:** every 2025/2026 team-game measure, every
  player opportunity cell and every game label.
- **Recomputed over 2022–2026:** every prior-5/10/20 lagged feature, with the
  target game excluded.
- **Contracts:** each JSON Schema matches its empty template.
- **Manifests:** only github.com URLs, with no signed queries.

Facts it records:

- **Windows cross seasons:** the prior-game windows run across the offseason.
  The prior-5 window reaches into last season in 638 of 2,436 rows, the
  prior-20 in 1,865.
- **NGS week 0** is a separate season aggregate, not the sum of the published
  weeks (equal in only 295 of 447 passing rows), so the two are never pooled.
- **Identity:** the GSIS ↔ PFR ↔ ESPN roster crosswalk has 7 source conflicts.
  - Two pairs of players share an ESPN id (DJ Turner and DJ Turner II;
    Jaylon Jones and Jaylon Jones).
  - Some players carry two PFR or two ESPN ids.

  These ids are left out, never guessed. Coverage through the crosswalk:

  | Table | Ids covered |
  |---|---|
  | Play-by-play players, injuries, NGS (2024+) | 100% |
  | Depth charts (GSIS) | 99.6% |
  | PFR advanced | 97% |
  | Snap counts (PFR ids) | 79% |
  | Depth charts (ESPN) | 64% |
- **No timestamps:** injuries carry no publication time. Depth charts are a
  weekly table in 2024 and timestamped provider snapshots from 2025, and
  neither is a proven pregame announcement.
- **NGS percentages** are 0–100, except `rush_pct_over_expected` (0–1).

## Against my NFL brain's own sources (`football/nfl/pack_crosscheck.js`)

- **Labels:** 1,218 of 1,218 pack games (2022–2026) are in nflverse
  `games.csv`, with every final, every archived closing spread and every
  total agreeing.
- **Starting QB:** the pack's primary passer is `games.csv`'s listed starting
  QB in 95.2% of team-games. The rest are injured or benched starters.
- **The live input:** the pack's play-by-play against my committed 2026
  team-week table (`football/nfl/stats_team_week_2026.csv`), which my live
  NFL model absorbs:
  - pass EPA r = 0.985 and rush EPA r = 0.905, with definitions stated per
    field (scrambles, spikes);
  - the table lacks one game the pack has (2026-10-12, BUF at LA). The
    scheduled build fills it.
- **Crosswalk:** `football/nfl/crosswalk/players_2024_2026.csv` covers 4,614
  players, with conflicts blank and named.

## Research (`football/nfl/research/pack_research.js` → `football/validation/nfl_pack_research.json`)

The design was declared before any result: fit on 2023–24, score on 2025–26
(2026 partial), squared error on the home margin, and a paired bootstrap by
season-week.

- **Offseason carryover**, as the pack's instructions ask. No rule beats the
  pack's full carry by a distinguishable margin; δ = 0.25 was chosen on the
  fitting window. Resetting at the season start is the worst choice early:
  weeks 1–4 squared error is 204.9 against 169.2 when last season carries in
  full. My NFL brain carries 0.8 of last season, which this supports.
- **Starting-QB change:** −3.1 points per change (95% −4.4 to +0.3). It does
  not improve held-out error by a distinguishable margin.

  My brain's QB layer now receives the listed starters in its scored replays
  (`football/pricing/qb_starts_nfl.json`, a confirmed-starter scenario: nflverse
  records the starter after the game). On 2016–2025 it measures no different:
  spread MAE 10.382 → 10.378, held-out blend 9.811 → 9.814
  (`football/validation/pricing_nfl.json` `qb_layer`). On games where one club
  changed starters, the replay misses by 3.3 points against that club and the
  layer moves only 0.24 of them. The board keeps the layer at its trained seeds.
- **Against the close:** every variant (squared error ≈ 172) is far from the
  archived closing spread (≈ 151). These features do not approach the
  market, and nothing here changes a price.

## Still missing (the pack's P0 list)

- Fresh and historical executable odds, with settlement rules.
- Injury, inactive and QB-confirmation reports with publication times.
- Routes and participation by snap.
- A fully reconciled identity bridge (the 7 conflicts above).
- First-publication times and frozen EPA/CPOE model versions.
- The rest of the 2026 season.

# The EdgeDesk NBA Data Pack — how it was integrated

A third pack arrived during the NBA build: `EdgeDesk_NBA_Data_Pack.zip`
(21.1 MB, SHA-256 `524893e9…`). It is ESPN's site API read directly for the
**whole 2025-26 NBA season**. It is imported as shipped into `datapack/nba_v1/`
(`IMPORT.json`).

I read `CLAUDE_NBA_START_HERE.md`, `README.md`, `COVERAGE.json`,
`sources/inventory.json` and `MISSING_DATA.md` first. The pack calls itself a
dataset foundation, not a trained or validated model, and it is used as
exactly that. Two facts about it matter:

- **Its contracts add nothing new.** The `schemas/` are byte-identical to the
  Quant Data Pack's contracts.
- **It is not independent of my NBA engine's history.** That history,
  sportsdataverse `hoopR-nba-data`, is compiled from the same ESPN feeds. The
  pack's value is that it is a *second retrieval and a second parser*: where the
  two agree, neither parser erred; where they differ, one of them did.

| Table | Rows |
|---|---:|
| games | 1,322: 1,230 regular season, 1 NBA Cup final, 6 Play-In, 85 playoffs |
| team_boxscores / team_measured_features / team_pregame_lags | 2,636 each |
| player_boxscores / player_measured_features / player_pregame_lags | 34,697 each, 33 of them without a source id |
| play_by_play | 640,462 |
| shots_and_free_throws / substitutions | 297,474 / 82,403 (subsets of play_by_play) |
| period_scores / officials | 10,714 / 4,028 |
| core_supplement_* | the four games whose summaries returned 404 |

## Verification (`tools/datapack/verify_nba.js` → `EDGEDESK_VERIFICATION.json`)

**PASSED, 30 of 30 checks**, in Node. The pack's Python is never run. Its
Parquet is read by the engine's own reader, `nba/tools/parquet_select.py`
(pyarrow), and every value is parsed explicitly: null stays null, never zero.
The checks:

- **Integrity.**
  - SHA-256, rows and column names for all 18 tables, matching both
    `inventory.json` and `COVERAGE.json`.
  - Every column a string, except an all-null `known_at`.
  - `known_at` null everywhere.
- **Scope.**
  - The NBA Cup final is identified by its native competition type (CC / 39)
    and kept out of the regular season.
  - 1,230 regular-season games, 82 per club.
- **Coverage.**
  - Exactly the four listed games lack a summary, and the core supplement
    covers exactly those four.
  - Keys are unique.
  - The 33 player rows without an id are listed apart and never joined.
- **Scores.**
  - Period scores sum to every final.
  - Team box points equal every final.
  - Shots and substitutions are exact, row-for-row subsets of the
    play-by-play.
- **Recomputed features.** Every team and player measured feature, and every
  prior-5/10/20 lag, is recomputed from the boxes, with the target game
  excluded and only earlier games used.

**Facts it measured that the pack does not state** (`findings`):

- **Incomplete play-by-play.** The play-by-play misses scoring in 10 of
  1,318 games: its highest running score ends 1–12 points short of the
  final, and one game has no End Game event.
- **Late-sequenced events.** In 249 games, events were recorded *after*
  End Game, with earlier clocks.
- **Repeated sequence numbers.** Sequence numbers repeat in 2 games.

So possessions or points rebuilt from these events must be reconciled to the
box, and ordered by period and clock, never by sequence alone.

The players' points fall short of the final on 7 Chicago team-games. Each
carries the athlete the source gave no id ("Olbrich"), whose line it loses.

## Against my 2025-26 feed (`nba/crosscheck/pack.js` → `nba/validation/nba_crosscheck_pack.json`)

**Games**

- All 1,322 games match.
- Finals, teams, starts and overtimes agree in every game.
- All 13,220 team-period scores agree.

**Team boxes**

- Every shooting and rebounding count agrees in all 2,636 team-games.
- Assists and fouls differ on 8 Chicago team-games. All 8 are the
  unidentified-athlete games: my feed's team totals leave his line out, while
  ESPN's team statistics keep it.

**Player boxes**

- 34,664 rows matched on (game, player).
- Every counted stat, minutes, starters and the DNP reason category agree on
  every played row (28,617).
- My 113 extra rows are the four games the pack could not fetch.

**Possessions.** My Basketball-Reference estimator runs 2.7 below the pack's
0.44-FTA proxy (correlation 0.99). Both are estimators, and the engine keeps
one canonical estimator.

**Lineups.** My stint reconstruction reproduces the box's minutes with a mean
absolute error of 0.25 minutes. 99.99% are within one minute (the box rounds
to whole minutes).

**Shots.** Both play-by-plays log the same attempts (2,632 of 2,634
team-games). Both log about one more attempt than the box in roughly a third of
team-games while made shots agree. That is an upstream definitional gap, not a
parser error.

**Three errors in my own ingest, all fixed and re-ingested for every season:**

1. **The NBA Cup final.** My ingest counted it as a regular-season game. Games
   now carry `scope` (`regular_season · nba_cup_final · play_in · playoffs`;
   schema `edgedesk_nba_games_v2`). The `nbahist` views aggregate per scope,
   so official regular-season figures exclude the Cup final, the Play-In and
   the playoffs. Every scope is still a real game for the ratings.
2. **Zero-minute appearances.** Players the box lists with 0 minutes who
   entered for seconds were marked as not having played. All 104 were on court
   in my own stints, for 0.8 to 21 seconds. An appearance is now any minutes, a
   counted stat, or time on court in the play-by-play
   (`edgedesk_nba_player_games_v2`). After the fix, "played" agrees in
   34,640 of 34,664 rows. The rest are rows with minutes "--" that never
   entered (no stint has them on court), where the pack leaves the DNP flag
   unset.
3. **Club games only.** Applying the pack's scope rule to my whole history
   turned up two problems:
   - the 2003 All-Star game (East vs West) had been ingested as a
     regular-season final, because its schedule row carried no note;
   - six Cup knockout placeholders for December 2026 carry "TBD" teams.

   Both teams must now be franchises 1–30. The placeholders return under the
   same game id once ESPN fills in the clubs. The team files hold exactly the
   30 franchises.

## What the pack's instructions asked, and what was done

1. **Read the docs and inspect the Parquet with code; parse strings
   explicitly; null is missing; join only on native ids.** Done (above).
   Joins use game, team and player ids only. The 33 id-less rows are never
   joined, by name or otherwise.
2. **Ingest with provenance, idempotent writes, dedupe, quality checks and an
   update command; `observed_at` apart from `known_at`.**
   - **Already the engine's own ingest:**
     - per-source SHA-256 and fetch time in the manifest;
     - the time rule (`known_at` blank, `assumed_available_at` = start +
       4 h, `pit = RETRO`);
     - `npm run nba:ingest` as the update command.
   - **The pack itself:** verified and reconciled, not re-ingested. My feed
     covers 2002-03 → today; the pack covers one season.
3. **Separate the regular season, Cup final, Play-In and playoffs from
   native metadata; an endpoint failure is not a zero-stat game.** Done
   (scope, above). My feed covers the four games whose summaries the pack
   could not fetch.
4. **Possession and team-scoring projections with opponent strength, home
   court, rest, availability and projected minutes; regularised baselines
   first; the 0.44 proxy is a proxy.** This is the engine (`NBA.md` §3–4):
   - adjusted efficiency and pace;
   - a Kalman model;
   - RAPM × projected minutes;
   - regularised learners before the ensemble.

   Possessions come from one canonical estimator. My stints already reconcile
   to the box (0.25-minute error). True event-level possession counting is
   **not** built, because the play-by-play is incomplete in ~0.8% of games
   (above).
5. **A separately validated opportunity model for minutes, attempts,
   rebounds, assists and threes; DNPs out of rate denominators but their
   probability modelled; no win model labelled as props.** Done in the props
   engine (`nba/props/`):
   - ridge minutes, then per-minute rates, then the count;
   - field-goal and three-point attempts added as their own families;
   - rates absorb appearances only;
   - a new, separately validated **P(plays)** model (`NBA.md` §9).
6. **Walk-forward comparison of regularised baselines, hierarchical
   player/team effects, Elo and boosted trees; transforms and calibrators
   inside training folds; an untouched final period; log loss, Brier,
   calibration, n, stability; count scores for props; multiple testing.**
   Done:
   - the sealed walk-forward of seventeen candidates;
   - the ≥ 0.001 challenger margin;
   - date-blocked bootstrap intervals;
   - per-season stability;
   - CRPS and randomised-PIT coverage for counts.

   The pack's lags are recomputed and verified, but are not model inputs. The
   engine builds its own point-in-time features from 23 seasons.
7. **A separate executable-price adapter.** Done (`nba/market/`, the slate's
   market block):
   - timestamped quotes with book, line, side and freshness;
   - provider-default settlement stated;
   - de-vig by four methods (multiplicative, additive, power, Shin) with
     their spread as the sensitivity;
   - EV at the exact price with push probabilities;
   - the model labelled MARKET_INDEPENDENT and the no-vig market
     MARKET_DERIVED, never blended;
   - duplicate books and events dropped and reported.

   Same-market closing comparison waits for a licensed closing archive.
8. **PASS until calibration, fresh odds, availability, market rules,
   identity and sample thresholds pass; no forced pick; no wagers.** Done:
   - every slate game carries its gates and a decision;
   - today every decision is PASS, because the market-test gate fails;
   - nothing is staked or placed.
9. **Meaningful tests and a CLI.** `tools/nba/nba.test.js` covers:
   - parsing, joins and scope;
   - no future leakage;
   - probability normalisation and price conversion;
   - pushes and duplicate quotes;
   - stale and started quotes;
   - PASS gates;
   - the streamed caches;
   - the pack's verification, reconciliation and a tamper test.

   `npm run nba:pack` reruns the verification and the reconciliation.

## Still missing (the pack's P0 list)

- **Executable odds history and live quotes.** Capture is wired but not
  authorised. There is no licensed closing archive.
- **Historical publication chronology** (`known_at`).
- **Confirmed availability, starting fives and minute projections.** The
  P(plays) model is the stand-in; no injury report is in it.
- **Settlement rules per book.**
- **More seasons in the pack's own format.** My feed has 23 seasons; the pack
  has one.

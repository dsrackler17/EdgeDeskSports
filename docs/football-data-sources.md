# EdgeDesk football data sources

Every feed the football system reads, what it actually carries, what it does
not, and what happens when it fails. Written so that months from now the
question "where does this number come from?" has one place to be answered.

**Standing rules.** No source is scraped in violation of its terms. No source
that requires a per-user key is committed as a dataset. No number is used that
is another organisation's model output. Where a feed is absent, the field stays
null and the confidence falls — nothing is substituted.

---

## 1. cfbfastR-data play attribution — `player_stats`

| | |
|---|---|
| **Source** | `sportsdataverse/cfbfastR-data`, ultimately ESPN |
| **URL** | `raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv/player_stats_<season>.csv` |
| **Access** | public, keyless, no rate limit observed |
| **Data** | one row per play, naming the players credited with the events on it, with **down, distance and yards-to-goal on every row** |
| **Seasons** | 2014 → current, updated through the season |
| **Size** | ~55 MB a season, uncompressed CSV |
| **Cadence** | daily during the season |
| **Read by** | `football/players/build_players.js`, `football/rankings/performance.js` |

**Carries:** rushes, receptions, completions, incompletions, sacks taken, sacks
made, field goals, fumbles, targets, interceptions, pass break-ups, forced
fumbles — each tied to a game state.

**Does not carry:** next-score information (so **no EPA is computable** and none
is invented), snap counts, tackles, blocking, alignment, personnel, coverage.

**Known coverage collapses, measured every build.** Several attribution columns
are filled in for some seasons and not others. Counted per team-game:

| column | 2023 | 2024 | 2025 | 2026 | usable? |
|---|---|---|---|---|---|
| sacks | 0.92 | 0.90 | 0.83 | 1.13 | **fails 2023-2025** (reality ≈ 2.0) |
| interceptions | 0.24 | ok | ok | 0.51 | mixed |
| pass break-ups | 0.17 | 0.14 | 0.84 | 0.00 | **fails throughout** |
| forced fumbles | 0.07 | 0.06 | 0.05 | 0.08 | **fails throughout** |
| targets | 3.66 | 1.98 | ok | 7.62 | mixed |

A column that fails its floor is **declared missing league-wide** for that
season, never scored as if the events did not happen. This is why v1 of the
player layer had *zero* rateable defensive linemen in 2025: it depended on a
sack column that was dropping more than half its events, and the gate correctly
refused to score it.

**Failure behaviour:** a season that will not download is skipped; the build
continues on the seasons that answered and names the ones that did not.

---

## 2. sportsdataverse ESPN player box — `espn_cfb_player_box`

| | |
|---|---|
| **Source** | `sportsdataverse/sportsdataverse-data` release assets, ultimately ESPN |
| **URL** | `github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_player_box/player_box_<season>.csv.gz` (`.parquet` for the season in progress) |
| **Access** | public, keyless |
| **Data** | one row per player per game per stat category |
| **Seasons** | 2019 → current |
| **Size** | ~1.5 MB gzipped a season |
| **Read by** | `football/data/build_box.js` |

**This feed forced a correction.** `football/players/config.js` previously
asserted that tackles, tackles for loss, pressures short of a sack and punting
were "not observed at all in any public feed". They are all in here, keyed on
the same ESPN `athlete_id` the repository already joins on. That contract has
been corrected rather than left standing.

**Carries:** `totalTackles`, `soloTackles`, `tacklesForLoss`, `sacks`,
`passesDefended`, `hurries`, `interceptions`, punting (`punts`, `puntYards`,
`puntsInside20`, `touchbacks`, `longPunt`), field goals, returns, `adjQBR`, and
— importantly — an **appearance** per player per game.

**Coverage, measured per team-game against real FBS rates:**

| season | tackles | TFL | sacks | PBU | hurries | punts | verdict |
|---|---|---|---|---|---|---|---|
| 2019 | 1.71 | 0.16 | 0.05 | 0.08 | 0.05 | 4.76 | defence unusable |
| 2022 | 5.17 | 0.50 | 0.20 | 0.29 | 0.18 | 4.51 | defence unusable |
| 2023 | 33.76 | 2.89 | 1.10 | 1.69 | 1.35 | 4.35 | **partial — fails** |
| 2024 | 62.39 | 5.30 | 1.94 | 2.98 | 2.43 | 4.16 | **usable** |
| 2025 | 64.69 | 5.32 | 1.95 | 3.13 | 2.71 | 4.14 | **usable** |
| 2026 | 63.13 | 4.92 | 1.71 | 2.79 | 2.47 | 4.79 | **usable** |

So the defensive columns are usable **from 2024**, and punting has been usable
throughout. Gated on every run; the counts ship inside the artifact.

**Deliberately not used:** `adjQBR`. It is ESPN's model output, and this
repository does not build its ratings on another organisation's rating. It is
ingested and shown as context only.

**Still not carried by it:** missed tackles, snap counts, any offensive-line
attribution, and a *run stop* (which needs a tackle joined to down and distance;
tackles for loss are ingested as the nearest observable relative and are not
renamed).

**Failure behaviour:** the CSV is tried first; the parquet is tried second via
`football/data/tools/parquet_to_csv.py` (pyarrow); if both fail the season is
absent, every box measure is declared missing, and **EPIR v1 is bit-identical to
what it was before this feed existed**.

---

## 3. cfbfastR-data schedules

| | |
|---|---|
| **URL** | `.../schedules/csv/cfb_schedules_<season>.csv` |
| **Access** | public, keyless |
| **Data** | results, `season_type` (regular/postseason), week, division, conference, neutral site |
| **Seasons** | 2001 → current |
| **Read by** | every football builder |

The spine: FBS membership, which games count, and **week resolution**. The
postseason restarts its own week numbering, so everything downstream orders on
an ordinal (`regular w → w`, `postseason w → 20 + w`) rather than a calendar
week.

---

## 4. cfbfastR-data rosters

| | |
|---|---|
| **URL** | `.../rosters/csv/cfb_rosters_<season>.csv` |
| **Access** | public, keyless |
| **Data** | `athlete_id`, name, team, position, height, weight, jersey |
| **Read by** | `football/players/build_players.js` |

The identity backbone. **Positions are inconsistently granular**: 123 of 138
programmes spell their edge rushers `DL` rather than `EDGE`, and 51 spell their
secondary `DB` rather than `CB`/`S`. Where EdgeDesk's own ESPN roster sync
carries a more specific spelling for the same athlete id, it wins. A unit a
roster does not spell is reported as *covered by* the coarser one, never as
missing.

**Fallback:** `football/rosters/fbs_<season>_espn.json`, EdgeDesk's own weekly
sync, when cfbfastR has not published a season.

---

## 5. cfbfastR-data closing-line archive

| | |
|---|---|
| **URL** | `.../betting/csv/cfb_line_odds.csv.gz` |
| **Access** | public, keyless |
| **Data** | 1.18M rows, 2006-2025, spread/total/moneyline, opening and closing, multiple books |
| **Read by** | `football/players/validate.js`, `football/validation/validate_features.js`, `football/rankings/build_rankings.js` |

**A benchmark and a display column. Never an input to any model number.**

Two documented traps, both handled: about 15.6% of rows are exact duplicates and
are dropped before any consensus median; and a spread is stated from one team's
side and identified only by an abbreviation, so the home side is resolved
through the teams file and an unresolvable row is **dropped, never guessed**.

Coverage of recent seasons is partial (227 of 808 FBS-vs-FBS games in the 2025
holdout), so the market column is present for some teams and absent for others,
and says which.

---

## 6. EdgeDesk's own datasets

| dataset | built by | read by |
|---|---|---|
| `football/rosters/` | `.github/workflows/roster-sync.yml` (ESPN) | player layer, Power 4 talent layer |
| `football/availability/current.json` | `.github/workflows/availability-sync.yml` | player units, talent, confidence |
| `football/rating/current.json` | `.github/workflows/rating-sync.yml` | research context |
| `football/data/box/` | `npm run cfb:box` | player layer v2 |
| `football/players/` | `npm run cfb:players` | rankings, research page |
| `football/rankings/` | `npm run cfb:rankings` | research page |

**Availability** deserves a note: college football has no universal injury
report. EdgeDesk builds its own from ranked public evidence, and the honest
state today is that **no live record reaches the player layer** — every stale
report is discarded rather than counted, so the availability dimension reads
near zero and says why. UNKNOWN is never read as healthy.

---

## Sources checked and NOT used

| source | why not |
|---|---|
| **CollegeFootballData API** | requires a per-user API key, and its terms do not permit redistributing the data as a committed dataset. A licence holder can supply recruiting through `football/players/recruiting_adapter.js`; nothing is wired in. |
| **Recruiting services (industry composites)** | subscription, and scraping them would violate their terms. |
| **cfbfastR-data recruiting paths** | every candidate path returns 404. There is no public recruiting file in this mirror. |
| **cfbfastR play-by-play with real EPA** | only published through 2022, in a directory that no longer resolves for recent seasons. The EP surface this repository once fitted is therefore not reproducible, and **no EPA is invented in its place**. |
| **Coordinator / coaching history** | no public, keyless feed carries it. The input is contracted for in `config.js` and stays absent. |
| **Snap counts** | do not exist publicly for college football at any price this project can reach. |

---

## Recruiting: the standing gap

This is the largest genuine hole in the system and it is reported as one. The
`recruiting` data-quality dimension sits at **zero** and drags the overall score
down on purpose.

`football/players/recruiting_adapter.js` is built and tested. It normalises any
source to a 0-100 score and a prior z, and every rating downstream picks it up
with the source named on the player. Wiring in a licensed feed changes exactly
one thing: the shrinkage prior for players the production feed cannot see —
true freshmen, and anyone with no attributed snaps. Nothing else in the layer
changes, because the shrinkage guarantees the prior's weight falls toward zero
as college evidence accumulates.

---

## Failure behaviour, in one place

| failure | what happens |
|---|---|
| a season's play table will not download | that season is skipped and named; other seasons build |
| a box-score season will not download | box measures declared missing; **v1 unaffected** |
| a feed column collapses | the gate fails, the measure is declared missing league-wide, nothing is scored as zero |
| the line archive will not load | the market column is absent and says why; no model number changes |
| the roster feed is unpublished | EdgeDesk's own ESPN sync is used; if that is also missing, continuity is unknown, never zero |
| a team has no prior season | the prior term rests on talent alone and a gate fires |
| severe anomalies are found | **the rankings build refuses to publish** and exits non-zero |

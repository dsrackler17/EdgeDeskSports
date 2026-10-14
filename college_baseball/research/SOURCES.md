# Source inventory

Measured from this environment on 2026-10-13. "Reachable" means an HTTPS request
from the build container succeeded; a source that is reachable is not thereby
authorised (see LICENSING.md).

## In use

| Source | What it carries | Seasons | Reachable | Used for |
|---|---|---|---|---|
| sportsdataverse/baseballr-data `ncaa/schedule/parquet` | every NCAA contest (all divisions): date, teams, org ids, conferences, divisions, scores, neutral site, extra innings | 2012–2026 (2023 incomplete: stops 05/27, ~3.6k D-I contests) | yes (raw.githubusercontent.com) | the results spine |
| `ncaa/team_schedules/csv/{season}_{org}.csv` | the same contest rows, one file per team | 2012–2023 | yes | 2023 gap fill; a second observation of each contest |
| `ncaa/teams_info/ncaa_team_lookup.csv` | org id, season-team id, name, conference, division per season | 2010–2026 | yes | canonical identity, realignment, division moves |
| `ncaa/games/parquet` | contest, home/away names, finals | 2017–2026 | yes | cross-check of finals and orientation |
| `ncaa/linescore/parquet` | runs by inning, R/H/E, venue, attendance | 2024–2026 | yes | innings truth, venue, independent final |
| `ncaa/player_stats/parquet` | batting, pitching, fielding lines per player per game, with team total rows | 2024–2026 | yes | starters, bullpen workload, component offense, defense |
| `ncaa/rosters/parquet` | player id, class, position, hometown, high school | 2024–2026 | yes | pitcher identity across seasons (transfers) |
| `ncaa/pbp/parquet` | play-by-play: inning, half, play type, runs, outs, score after the play | 2017–2026 (2023 partial) | yes | half-inning run distributions, run expectancy by outs, independent finals, event counts 2017–2023 |
| `ncaa/qa/qa_pbp_finals` | the source's own pbp-vs-final check | 2017–2026 | yes | not used directly; my own reconciliation supersedes it |

Source repository code is MIT licensed. The data is compiled by the
repository's maintainers from stats.ncaa.org. Its publication time is not
recorded per row, so no row carries a true `known_at`.

## Existing EdgeDesk integrations (kept, not replaced)

| Integration | What it is | Relation to this engine |
|---|---|---|
| `cbb` Supabase schema + `tools/cbb/ingest.js` | ESPN scoreboard ∪ team schedules, daily in season | a second, independent live results source; the coverage ledger reports its overlap when the live database is reachable (not from this container) |
| `cbb.ncaa_player_seasons` (CodeMateo15/ncaa_bbStats) | season player totals 2021–2026 | not used: season totals cannot be made point-in-time |
| `datapack/quant_v1/data/college_baseball` | 313 ESPN games from 2024 (sample) | cross-check only |
| `mlb/engine.js` `projectCollegeGame` | an unvalidated, browser-only club-level projection | superseded for research by this engine; left in place, labelled EXPERIMENTAL by its own code |

## Investigated, not usable here

| Source | Status | Why |
|---|---|---|
| stats.ncaa.org (direct) | blocked (proxy 403) | reached only through baseballr-data |
| ncaa.com/stats/baseball/d1 | blocked | same data family as stats.ncaa.org |
| ESPN site API (college-baseball) | blocked from this container | the existing `cbb` workflow reaches it from GitHub Actions |
| warrennolan.com | blocked | RPI/ELO tables; methodology reviewed from its published description only (RESEARCH_MATRIX.md) |
| collegebaseballratings.com | blocked | methodology not inspectable |
| Odds feed `baseball_ncaa` | not enabled | the EdgeDesk odds gateway allowlist (`supabase/odds_api_gateway.sql`) does not include it; enabling it spends paid quota and needs the owner's authorisation |
| Historical weather (forecasts as of prediction time) | not collected | needs an authorised archive of forecasts (not observations) and venue coordinates; see RESEARCH_MATRIX.md (class B) |
| Pitch counts | not in source | workload is estimated from batters faced with stated uncertainty |
| Pitcher handedness | not in source | rosters carry position only |
| Batted-ball / tracking data (TrackMan, Synergy) | proprietary | defensive range and stuff metrics are not claimed |
| Pregame lineups, injuries, starter announcements | no authorised feed | starters are projected from rotation patterns and labelled PROJECTED |

## Historical coverage actually ingested

The per-season counts (contests, finals, verified, quarantined, box coverage,
play-by-play coverage) are generated into `validation/coverage.json` and
`research/COVERAGE.md` by `node college_baseball/coverage.js`. They are not
typed by hand.

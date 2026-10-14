# Data dictionary

Every committed table, every column. Units are explicit; a blank cell is
**unknown**, never zero. Schemas are versioned by the header line; a change
of meaning is a new column, never a reused one.

## data/teams/team_seasons.csv — one row per program per season (2010–2026)

| Column | Type | Meaning |
|---|---|---|
| season | int | calendar year of the season (spring) |
| team_id | string | **canonical program id** = stats.ncaa.org organisation id; stable across seasons |
| season_team_id | string | the NCAA's per-season team id (the /teams/<id> URL); a lookup key only |
| name | string | the program's name that season |
| conference_id, conference | string | affiliation that season (realignment is a new row, never an edit) |
| division | int | 1, 2 or 3 that season |

## data/teams/teams.csv — one row per program

team_id, name (latest), aliases (every name used, `|`-separated), first_season,
last_season, d1_seasons (space-separated), conference_history and
division_history (`season:value|…`, one entry per change).

## data/games/<season>.csv — one row per contest involving a D-I program

| Column | Type | Meaning |
|---|---|---|
| game_id | string | `ncaa_<contest_id>`; `ncaa_x…` when the source has no contest id (an unplayed listing) |
| contest_id | string | stats.ncaa.org contest id |
| season, date | int, YYYY-MM-DD | local calendar date of the game |
| start_time_local | text | local first-pitch time **as text** when the source carries one; no time zone is invented |
| dh | int | doubleheader game number (1, 2), blank otherwise (2024+ only) |
| weekday | int | 0 Sunday … 6 Saturday |
| home_id, away_id | string | canonical program ids; blank for a non-NCAA opponent |
| home_name, away_name | string | names as of that season (seed prefixes stripped) |
| home_div, away_div | int | division that season |
| home_conf, away_conf | string | conference that season |
| conf_game | 0/1 | both D-I and in the same conference |
| neutral | 0/1 | neutral site (or a disputed home designation, see quality) |
| site | text | neutral-site location, or `home_disputed` |
| park_key | string | `h:<home program>` for a home game, `s:<site>` for a neutral one |
| home_basis | enum | how the home (batting-last) side was decided: SCHEDULE, LINESCORE_BATS_LAST, PBP_BATS_LAST, FIRST_PERSPECTIVE, FIRST_LISTED |
| bats_last | H/A | which side batted last (A when an NCAA-tournament host was the designated visitor; two sources required) |
| status | enum | FINAL, CANCELED, POSTPONED, SUSPENDED, NO_RESULT, CONFLICT |
| home_runs, away_runs | int | official final |
| innings_marker | int | the innings figure printed in the result, when printed (it is relative to the scheduled length; see rules) |
| innings_played | int | innings from the reconciled inning line |
| scheduled_innings | int | inferred scheduled length (7 or 9), blank when ambiguous |
| scheduled_basis | enum | lib/rules.js `inferScheduled` basis (PLAYED_9, EXTRA_AFTER_9, ENDED_AFTER_7, RUN_RULE_AFTER_7, …) |
| ended_early | 0/1 | ended before its scheduled length (run rule or called) |
| ncaa_tourney_inferred | 0/1 | dated on/after the Friday after Memorial Day (inferred, not a source field) |
| conf_tourney_window | 0/1 | a conference game in the week before Memorial Day (inferred) |
| pbp_key | string | play-by-play contest key |
| lines_src | enum | linescore, pbp, or `REJECTED:<src>` when a line did not add up to the official final |
| away_line, home_line | text | runs by inning, space-separated; `x` = half not played |
| sources | text | every source that observed the contest |
| n_observations | int | how many observations were reconciled |
| quality | enum | VERIFIED, VERIFIED_DUPLICATE, VERIFIED_MIRROR, RESOLVED_MAJORITY, SINGLE_SOURCE, SINGLE_SOURCE_PBP_DISAGREES, CONFLICT |
| quality_notes | text | the disagreements behind a resolution |
| known_at | — | **always blank**: no source row carries a publication time; never backdated |
| assumed_available_at | ISO | 06:00 UTC the day after the game |
| pit | RETRO | point-in-time class: retrospective reconstruction |

## data/box/<season>_team_games.csv.gz — one row per team per contest (2024+)

game_id, season, date, team_id, team_name, side (H/A), opp_id, opp_name;
`bat_*` batting totals (ab r h 2b 3b hr rbi bb hbp sf sh k sb cs ibb opp_dp);
`pit_outs` (outs, from innings-pitched text; 5.1 = 16 outs) and `pit_*`
pitching totals (h r er bb so bf hr_a hb 2b_a 3b_a wp bk inh_run inh_run_score
sha sfa); `fld_*` fielding (po a e pb sba csb idp ci); n_pitchers, n_batters;
starter_person, starter_outs, starter_bf; total_checks (which player sums
disagreed with the team total row); box_quality (OK, CHECK_FAILED,
UNRESOLVED_TEAM).

## data/box/<season>_pitchers.csv.gz — one row per pitching appearance (2024+)

game_id, season, date, team_id, opp_id, side, seq (appearance order; 1 =
starter), starter (0/1), name, person_id (cross-season identity, see
FINDINGS F-05), roster_id, class, outs, ip_raw (the source's text, kept), and
the pitching columns above.

## data/box/<season>_batters.csv.gz — one row per batter appearance (2024+)

game_id, season, team_id, side, seq (order listed), name, person_id, position
and the batting columns above.

## data/innings/<season>.csv.gz — play-by-play folded per game (2017+)

pbp_key, season, date, location, away_name, home_name, innings_played,
home_batted_last, away_line, home_line (runs per half from score changes),
away/home_runs_sum, away/home_final (last play's score), sum_matches_final,
plays; and per side (`a_`, `h_`) counts of 1b 2b 3b hr bb hbp k roe fc sb wp pb
dp outs pa.

## data/provenance/<season>.csv.gz — field-level provenance

One row per critical field per source observation: game_id, field
(final_score, home_team, neutral, innings_played, scheduled_innings),
original_value, canonical_value, source, source_record_id, event_time,
collected_at (when this build fetched the file), available_at,
validation_status, conflict_status (AGREES/DISAGREES), quality_status.

## data/quarantine/<season>.csv — contests excluded from rating and scoring

game_id, season, date, home_name, away_name, field, observations, reason.

## data/reports/<season>.json — per-season build report

Source URLs with sha256, bytes and fetch time; row counts; problems by kind
with examples; play-by-play run environment.

## Derived (validation/, params/, board/)

Documented in the header of the script that writes each file; every JSON
carries a `schema` name with a version suffix.

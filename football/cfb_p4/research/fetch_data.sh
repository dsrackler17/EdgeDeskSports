#!/usr/bin/env bash
# EdgeDesk CFB Power 4 Intelligence Model — raw data fetch.
# Every artifact the pipeline trains on comes from these URLs and nowhere else;
# provenance is recorded into ../params.js by make_params.py.
#
# All sources are public, keyless and CORS-open (sportsdataverse/cfbfastR-data,
# itself sourced from CollegeFootballData). No scraped private data, no NIL
# figures, no injury feeds — those do not exist publicly and the engine says so
# rather than inventing them.
#
# Usage: ./fetch_data.sh <data_dir>          (default: data)
set -uo pipefail
D="${1:-data}"
B="https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main"
mkdir -p "$D/sched" "$D/roster" "$D/pstats" "$D/betting" "$D/pbp" "$D/teaminfo" "$D/teams"

get(){                                  # get <url> <dest>  — idempotent, loud on miss
  [ -s "$2" ] && return 0
  curl -fsSL --retry 4 --retry-delay 2 --max-time 900 "$1" -o "$2" \
    || { echo "MISS $1" >&2; rm -f "$2"; return 0; }
}

echo "betting line archive (spread/total/moneyline, opening + closing, 2006-2025)…"
get "$B/betting/csv/cfb_line_odds.csv.gz" "$D/betting/cfb_line_odds.csv.gz"
get "$B/teams/teams_colors_logos.csv"     "$D/teams/teams_colors_logos.csv"

echo "schedules 2001-2025…"
for y in $(seq 2001 2025); do get "$B/schedules/csv/cfb_schedules_${y}.csv"      "$D/sched/sched_${y}.csv"; done

echo "team info (venue geo, altitude, capacity, surface, dome, timezone, conference) 2001-2025…"
for y in $(seq 2001 2025); do get "$B/team_info/parquet/cfb_team_info_${y}.parquet" "$D/teaminfo/ti_${y}.parquet"; done

echo "rosters 2004-2025 (athlete_id, class, position, measurables)…"
for y in $(seq 2004 2025); do get "$B/rosters/csv/cfb_rosters_${y}.csv"          "$D/roster/roster_${y}.csv"; done

echo "play-level player attribution 2014-2025…"
for y in $(seq 2014 2025); do get "$B/player_stats/csv/player_stats_${y}.csv"    "$D/pstats/pstats_${y}.csv"; done

echo "full play-by-play with real EPA 2004-2022 (EP surface fit + lite-feature validation)…"
for y in $(seq 2004 2022); do get "$B/cfb/pbp/parquet/play_by_play_${y}.parquet" "$D/pbp/pbp_${y}.parquet"; done
for y in 2002 2003 2011 2020;  do get "$B/pbp/parquet/play_by_play_${y}.parquet" "$D/pbp/pbp_${y}.parquet"; done

echo "done."
du -sh "$D"

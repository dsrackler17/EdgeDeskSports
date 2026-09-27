#!/usr/bin/env bash
# EdgeDesk CFB V2 — raw data fetch. Every artifact the pipeline trains on
# comes from these URLs and nowhere else.
#
#   ./fetch_v2.sh <data_dir> [first_season] [last_season]
#
# Sources (public, keyless):
#   sportsdataverse/sportsdataverse-data releases
#     espn_cfb_pbp               full enriched play-by-play, one EP model, 2009+
#     cfb_schedules              schedules incl. neutral site, kickoff, divisions
#     cfb_returning_production   returning production shares (preseason prior)
#     cfb_team_talent            247 composite talent (preseason prior)
#     cfb_matchup_line           CFBD lines (2026 opener/current), coaching
#                                continuity, CFBD pregame Elo (benchmark only)
#   sportsdataverse/cfbfastR-data
#     betting/cfb_line_odds      multi-book opening + closing lines 2006-2025
#     team_info                  venue geography (travel, time zone, altitude)
#
# Idempotent: an existing non-empty file is never re-downloaded, except the
# CURRENT season's files, which change daily and are always refreshed.
set -uo pipefail
D="${1:-data}"; FIRST="${2:-2009}"; LAST="${3:-$(date -u +%Y)}"
REL=https://github.com/sportsdataverse/sportsdataverse-data/releases/download
RAW=https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main
CUR=$(date -u +%Y)
mkdir -p "$D"/{pbp,sched,retprod,talent,mline,betting,teaminfo}

get(){  # get <url> <dest> <season>
  if [ -s "$2" ] && [ "${3:-0}" != "$CUR" ]; then return 0; fi
  curl -fsSL --retry 4 --retry-delay 3 --max-time 900 "$1" -o "$2.tmp" \
    && mv "$2.tmp" "$2" || { echo "MISS $1" >&2; rm -f "$2.tmp"; }
}

for y in $(seq "$FIRST" "$LAST"); do
  get "$REL/espn_cfb_pbp/play_by_play_$y.parquet"                        "$D/pbp/play_by_play_$y.parquet" "$y"
  get "$REL/cfb_schedules/cfb_schedules_$y.parquet"                      "$D/sched/cfb_schedules_$y.parquet" "$y"
  get "$REL/cfb_returning_production/cfb_returning_production_$y.parquet" "$D/retprod/rp_$y.parquet" "$y"
  get "$REL/cfb_team_talent/cfb_team_talent_$y.parquet"                  "$D/talent/tt_$y.parquet" "$y"
  [ "$y" -ge 2015 ] && get "$REL/cfb_matchup_line/cfb_matchup_line_$y.parquet" "$D/mline/ml_$y.parquet" "$y"
  [ "$y" -le 2025 ] && get "$RAW/team_info/parquet/cfb_team_info_$y.parquet" "$D/teaminfo/ti_$y.parquet" 0
done
get "$RAW/betting/csv/cfb_line_odds.csv.gz" "$D/betting/cfb_line_odds.csv.gz" 0
echo "fetch done: $(du -sh "$D" | cut -f1)"

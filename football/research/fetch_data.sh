#!/usr/bin/env bash
# EdgeDesk Football Engine — raw data fetch (public, keyless sources).
# Usage: ./fetch_data.sh <data_dir>
# Every artifact the pipeline trains on comes from these URLs and nowhere
# else; provenance is recorded into params.js by make_params.py.
set -euo pipefail
D="${1:-data}"
mkdir -p "$D/nfl" "$D/cfb"

echo "NFL schedule + closing lines (nflverse/nfldata)…"
curl -fsSL --retry 3 \
  "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv" \
  -o "$D/nfl/games.csv"

for y in $(seq 1999 2025); do
  echo "NFL stats_team_week $y…"
  curl -fsSL --retry 3 \
    "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${y}.csv" \
    -o "$D/nfl/stw_${y}.csv"
  echo "NFL stats_player_week $y…"
  curl -fsSL --retry 3 \
    "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${y}.csv" \
    -o "$D/nfl/spw_${y}.csv"
done

for y in $(seq 2002 2025); do
  echo "CFB schedules $y…"
  curl -fsSL --retry 3 \
    "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv" \
    -o "$D/cfb/sched_${y}.csv"
done
echo "done."

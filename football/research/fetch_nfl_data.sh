#!/usr/bin/env bash
# NFL-only public research feeds for Coaching / Staff validation.
# Same sources as football/research/fetch_data.sh, without downloading CFB.
set -euo pipefail
D="${1:-data}"
mkdir -p "$D/nfl"

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

echo "NFL-only research feeds ready."

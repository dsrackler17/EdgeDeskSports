#!/usr/bin/env bash
# NFL v2 research feeds — public nflverse data only, cached under .cache/raw.
# games.csv (schedule, scores, closing consensus), stats_team_week and
# stats_player_week 1999..LAST (the same feeds train_nfl.py trains on), and
# snap counts, weekly rosters (2012..LAST) and depth charts for the
# personnel prior.
# Usage: football/research/nfl_v2/fetch_history.sh [LAST_SEASON]
set -euo pipefail
LAST="${1:-2026}"
D="$(cd "$(dirname "$0")" && pwd)/.cache/raw"
mkdir -p "$D"
REL=https://github.com/nflverse/nflverse-data/releases/download
get() { [ -s "$2" ] && [ "${REFRESH:-0}" != 1 ] && return 0; curl -fsSL --retry 4 --retry-delay 2 "$1" -o "$2.part" && mv "$2.part" "$2"; }
get https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv "$D/games.csv"
get https://raw.githubusercontent.com/nflverse/nfldata/master/data/win_totals.csv "$D/win_totals.csv"
for y in $(seq 1999 "$LAST"); do
  get "$REL/stats_team/stats_team_week_${y}.csv" "$D/stw_${y}.csv"
  get "$REL/stats_player/stats_player_week_${y}.csv" "$D/spw_${y}.csv"
done
for y in $(seq 2012 "$LAST"); do
  get "$REL/snap_counts/snap_counts_${y}.csv" "$D/snaps_${y}.csv"
done
for y in $(seq 2012 "$LAST"); do
  get "$REL/weekly_rosters/roster_weekly_${y}.csv" "$D/rosterw_${y}.csv"
done
for y in $(seq 2001 "$LAST"); do
  get "$REL/depth_charts/depth_charts_${y}.csv" "$D/depth_${y}.csv" || echo "no depth chart for $y"
done
echo "nflverse history ready in $D"

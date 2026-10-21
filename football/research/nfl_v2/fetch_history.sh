#!/usr/bin/env bash
# NFL v2 research feeds — public nflverse data only, cached under .cache/raw.
# games.csv (schedule, scores, closing consensus), stats_team_week and
# stats_player_week 1999..LAST (the same feeds train_nfl.py trains on), and
# snap counts, weekly rosters (2012..LAST) and depth charts for the
# personnel prior.
#
# Usage: football/research/nfl_v2/fetch_history.sh [LAST_SEASON]
#   CORE=1           games, stats_team_week and stats_player_week only: all the
#                    served model and the weekly loop's candidates read (the
#                    personnel feeds are for the personnel prior, which is not
#                    promoted)
#   REFRESH=1        re-download every file
#   REFRESH_SEASON=Y re-download games.csv and season Y's files only — the
#                    weekly loop's setting: finished seasons never change, the
#                    one being played does every week
set -euo pipefail
LAST="${1:-2026}"
D="$(cd "$(dirname "$0")" && pwd)/.cache/raw"
mkdir -p "$D"
REL=https://github.com/nflverse/nflverse-data/releases/download
# get URL FILE [SEASON]: skip a file already cached unless a refresh asks for it
get() {
  local fresh=0
  [ "${REFRESH:-0}" = 1 ] && fresh=1
  if [ -n "${REFRESH_SEASON:-}" ] && { [ "$3" = "$REFRESH_SEASON" ] || [ "$3" = games ]; }; then fresh=1; fi
  [ -s "$2" ] && [ "$fresh" = 0 ] && return 0
  curl -fsSL --retry 4 --retry-delay 2 "$1" -o "$2.part" && mv "$2.part" "$2"
}
get https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv "$D/games.csv" games
get https://raw.githubusercontent.com/nflverse/nfldata/master/data/win_totals.csv "$D/win_totals.csv" static
for y in $(seq 1999 "$LAST"); do
  get "$REL/stats_team/stats_team_week_${y}.csv" "$D/stw_${y}.csv" "$y"
  get "$REL/stats_player/stats_player_week_${y}.csv" "$D/spw_${y}.csv" "$y"
done
if [ "${CORE:-0}" != 1 ]; then
  for y in $(seq 2012 "$LAST"); do
    get "$REL/snap_counts/snap_counts_${y}.csv" "$D/snaps_${y}.csv" "$y"
  done
  for y in $(seq 2012 "$LAST"); do
    get "$REL/weekly_rosters/roster_weekly_${y}.csv" "$D/rosterw_${y}.csv" "$y"
  done
  for y in $(seq 2001 "$LAST"); do
    get "$REL/depth_charts/depth_charts_${y}.csv" "$D/depth_${y}.csv" "$y" || echo "no depth chart for $y"
  done
fi
echo "nflverse history ready in $D"

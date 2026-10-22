# NFL Referee Flags: handoff for Claude Code

Data built Oct 21, 2026. 2024, 2025 full seasons + 2026 Weeks 1-6 (663 games). Week 7 assignments included.

## Files

| File | What it is |
|---|---|
| `schema.sql` | Supabase migration: 2 tables, 3 views, RLS read policies |
| `ref_assignments.csv` | game_id -> referee, 2024 through 2026 W7. Seeds `nfl_ref_assignments` |
| `ref_game_penalties.csv` | One row per game: flags, yards, holding (off/def), DPI, OPI, false start, RTP, UR, home/away flags, snaps, over/under result. Seeds `nfl_ref_game_penalties` |
| `ref_summary.csv` | Precomputed per-ref averages for 2026, 2025, and 2024-2026 with league avg rows (reference only; the views compute the same thing live) |
| `ref_assignments_2026_w7.csv` | This week's slate with each ref's 2026 and 3-yr numbers joined |
| `build_ref_data.py` | Rebuilds everything from nflverse |

## Build order

1. Run `schema.sql` as a migration. Match the RLS policies to whatever gating the other NFL card tables use.
2. Load `ref_assignments.csv` first, then `ref_game_penalties.csv` (FK).
3. Game card reads `nfl_game_ref_context` by game_id.
4. Weekly GitHub Action (Tuesday): download nflverse files, run `build_ref_data.py`, upsert both tables via the Supabase REST API with the service key.

```
curl -sSL -o games.csv https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv
curl -sSL -o pbp_2026.parquet https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.parquet
pip install pandas pyarrow
python build_ref_data.py
```

## Known gaps (put these in the card's Known Limitations)

- nflverse stops filling the `referee` column a few weeks behind. 2026 W5-W7 came from Football Zebras and are hardcoded in `MANUAL_REFS` / `WEEK7` in the script. Each week the upcoming assignments (announced Wed/Thu) need to be added to `nfl_ref_assignments` with `source='footballzebras'`. Either add a small admin insert or keep updating the dict.
- Counts come from play-by-play, one penalty per play. Multi-flag plays undercount slightly.
- 2026 sample is 5-6 games per ref. The 3-yr column is the stable number; show both.
- League-wide flags are way up in 2026 (15.0/g vs 13.1/g over 3 yrs), so always show the ref vs that season's league average, not the raw number alone.

## Card display

Section under **Observed**: "Officiating: {referee}"
- Flags/game this season (vs league), holding/game (vs league), rank of 17
- 3-yr flags/game and holding/game with game count
- O/U record as a plain count, not a signal

Any flag-adjusted total or spread goes in Research Models (Experimental) and stays out of the model until it clears the incremental-CLV test alongside first_edge.

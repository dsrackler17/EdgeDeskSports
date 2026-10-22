# NFL Referee Flags

Data built Oct 21, 2026. 2024, 2025 full seasons + 2026 Weeks 1-6 (663 games). Week 7 assignments included.

**Display only.** Every number here is an observed count (T0) shown in the Officiating block of the NFL card (Market Structure → Observed). None of it feeds a spread, total, probability, EV, grade, ranking or the CLV record.

## Files

| File | What it is |
|---|---|
| `schema.sql` | The handoff's draft migration, kept for reference. What ships is `supabase/nfl_ref_flags.sql` (mirrored in `supabase/migrations/20261022100000_nfl_ref_flags.sql`) |
| `manual_assignments.json` | Referee assignments nflverse has not filled in yet (2026 W5-W7 from Football Zebras). Edit this each week, not the Python |
| `build_ref_data.py` | Rebuilds the CSVs from nflverse + `manual_assignments.json` |
| `upsert_refs.py` | Upserts both CSVs into Supabase over the REST API, assignments first. With no arguments it is the one-time seed |
| `ref_assignments.csv` | game_id -> referee, 2024 through 2026 W7 (677 rows). Seeds `nfl_ref_assignments` |
| `ref_game_penalties.csv` | One row per game (663): flags, yards, holding (off/def), DPI, OPI, false start, RTP, UR, home/away flags, snaps, over/under result. Seeds `nfl_ref_game_penalties` |
| `ref_summary.csv` | Precomputed per-ref averages for 2026, 2025, and 2024-2026 with league avg rows (reference only; the views compute the same thing live, to the hundredth) |
| `ref_assignments_2026_w7.csv` | This week's slate with each ref's 2026 and 3-yr numbers joined |
| `tests/test_refs.py` | The build's assignment rules and the seed's file checks on a synthetic season: `python3 -m unittest discover -s data/refs/tests -v` |

## Build order (once)

1. Apply `supabase/nfl_ref_flags.sql` (paste it into the SQL editor, or let the migration run). RLS matches the card's other Observed tables: anon and authenticated read, only `service_role` writes.
2. Seed: `SB_URL=https://<project>.supabase.co SB_SERVICE_ROLE=<service-role key> python3 data/refs/upsert_refs.py`. It loads `ref_assignments.csv` (677), then `ref_game_penalties.csv` (663), upserting on `game_id`, so running it again is safe. `--dry-run` checks the files without credentials.
3. The game card reads `nfl_game_ref_context` by `game_id`.

## Every week

**Tuesday 10:00 UTC, September to February** (`.github/workflows/ref-sync.yml`, also *Run workflow* by hand): download nflverse `games.csv` and the season in progress's play-by-play, run `build_ref_data.py --seasons <season>`, upsert that season's rows with `upsert_refs.py`. Earlier seasons are final and stay as seeded. Secrets: `SB_URL`, `SB_SERVICE_ROLE`. A failed upsert fails the job.

**Adding next week's referees** (announced Wednesday or Thursday): add a block to `manual_assignments.json`, commit, then *Run workflow* (or wait for Tuesday):

```json
{ "season": 2026, "week": 8, "source": "footballzebras",
  "games": { "2026_08_NYJ_CIN": "Shawn Hochuli", "2026_08_...": "..." } }
```

Keys are nflverse `game_id`s (`games.csv`). A game_id that is not in `games.csv`, or not in its block's week, stops the build. When nflverse fills a game's `referee`, nflverse wins: its name is used, the row's `source` becomes `nflverse`, and a disagreement is printed.

By hand, the same as the workflow:

```
curl -sSL -o games.csv https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv
curl -sSL -o pbp_2026.parquet https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.parquet
pip install pandas pyarrow
python3 data/refs/build_ref_data.py --seasons 2026 --games games.csv --pbp-dir . --out-dir out
python3 data/refs/upsert_refs.py --dir out
```

`python3 data/refs/build_ref_data.py` with no `--seasons` rebuilds 2024-2026 (it needs `pbp_2024.parquet` and `pbp_2025.parquet` as well) and reproduces the committed CSVs.

## Known gaps (on the card's Known Limitations)

- nflverse stops filling the `referee` column a few weeks behind. 2026 W5-W7 came from Football Zebras and live in `manual_assignments.json` (2026_05_TB_DAL has since been filled by nflverse, with the same referee). Upcoming assignments have to be added there each week.
- Counts come from play-by-play, one penalty per play. Multi-flag plays undercount slightly.
- 2026 sample is 5-6 games per ref. The 3-yr column is the stable number; the card shows both, each with its game count.
- League-wide flags are way up in 2026 (15.0/g vs 13.1/g over 3 yrs), so the card always shows the ref vs that season's league average, not the raw number alone.

## Card display

Officiating block in **Observed**: the referee (and the source of the assignment), or "Assignment not announced".
- Flags/game this season (vs league), holding/game (vs league), each with its rank of N referees
- 3-yr flags/game and holding/game with game count
- O/U record as a plain count (over-under, pushes apart), not a signal

Any flag-adjusted total or spread goes in Research Models (Experimental) and stays out of the model until it clears the incremental-CLV test alongside first_edge.

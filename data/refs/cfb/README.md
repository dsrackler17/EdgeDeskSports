# CFB Referee Flags: filled dataset for EdgeDesk

Built Oct 21, 2026 from the EdgeDesk_CFB_Officiating_2024-2026 package plus gap fills below. 2,366 FBS games (2024: 919, 2025: 934, 2026: 513 through Oct 20).

## What was filled

1. **Referee role.** The package left every official's role blank. Evidence the single NCAA-listed official is the crew chief: in the role-labeled NCAA records, only names labeled `ref` ever show up as a single listed official (0 of 87 umpires/judges/linesmen ever do); listed officials work about one game a week inside one conference (median 100% same-conference); and the 2024 Tennessee at Ohio State CFP game lists Jerry Magallanes, who was publicly reported as that game's crew chief. Marked `referee_identity = inferred_crew_chief`.
2. **Name aliases.** 55 typo/nickname variants merged (e.g. Jeffrey/Jeff Servinski, Rod/Ron Snodgrass, Hank/Henry Johns, Michael/Mike McCabe). 204 name keys became 137 referees. Different people with similar names were left separate (e.g. Jon Noli ACC vs Jonathan Noli MWC). Map is in `cfb_enrich.py`.
3. **48 games recovered.** NCAA officials rows with no ESPN id were matched to ESPN games by date and team names (only 2+ token matches, one-to-one). `referee_source = ncaa_matched_by_date_teams`.
4. **7 same-day double listings resolved.** Kept the game in the ref's home conference; nulled both when ambiguous (13 games, `assignment_conflict = true`).
5. **Offensive vs defensive holding.** The package only had total holding. Split all 5,779 holding plays using ESPN possession: 4,563 offensive, 1,216 defensive, 0 unresolved. Same for DPI vs OPI.

Every change is listed in `fill_log.csv`.

## Still missing

- 124 games have no referee (`cfb_games_missing_referee.csv`). 62 are 2026 Week 7, a source gap. Backfill these from ESPN game summaries (`gameInfo.officials`, position Referee) with `build_cfb_ref_data.py`.
- Upcoming assignments. Nothing public publishes CFB crews in a feed ahead of time. ESPN sometimes lists officials pregame; pull them Thursday/Friday and record `first_observed_at`.
- No O/U lines in the source, so no over/under record for CFB refs.
- Refs with 1-2 games are FCS crews working FBS-vs-FCS games. Hide refs under 3 games from rankings.

## Files

| File | Use |
|---|---|
| `cfb_schema.sql` | Supabase migration (tables + views) |
| `cfb_ref_game_penalties.csv` | Seed: one row per game |
| `cfb_ref_summary.csv` | Per-ref 2026 / 2025 / 2024 / 3-yr averages, vs conference and vs FBS |
| `cfb_conference_baselines.csv` | Conference flags and holding per game by season |
| `cfb_games_missing_referee.csv` | Games to backfill from ESPN |
| `fill_log.csv` | Every fill and merge |
| `cfb_enrich.py`, `match_unmatched.py` | Reproduce the fills |
| `build_cfb_ref_data.py` | ESPN puller for missing games and upcoming assignments |

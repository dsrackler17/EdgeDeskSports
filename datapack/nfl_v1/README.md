# EdgeDesk NFL Data Pack — new 2025/2026 source data + five-season research features

Start with `CLAUDE_NFL_START_HERE.md`, `COVERAGE.json`, `sources/DATA_INVENTORY.json` and `docs/MISSING_DATA_PRIORITY.csv`.

## Actual coverage

- 62,613 new raw play records, all 372 native columns retained in each PBP file.
- 2025: 285 games (272 regular-season + 13 playoff games).
- 2026: 79 games in the available archive, latest game date 2026-10-12; current-season coverage is partial.
- 2,436 team/game records and target-excluded prior-5/10/20 research rows spanning 2022 through available 2026.
- 79,946 player/game/stat opportunity cells; this is not a count of distinct players or games.

- Snap counts, season/weekly rosters, injury tables and depth data for 2024–2026 where delivered.
- PFR advanced passing/rushing/receiving/defense measures for 2024–2026: pressure, blitz/hit/hurry counts, drops, broken tackles and related source measures.
- NFL Next Gen Stats aggregate passing/receiving/rushing history with time-to-throw, completion expectation, separation/cushion, YAC expectation and rushing over expectation where source values exist. These are public aggregate statistics, not raw tracking.
- Native schemas/types/null inventories, formulas, collection/source manifests, lossless encoding verification and an explicit prioritized remaining-data list.

Raw 2022–24 PBP is in the earlier NFL ZIP parts. This ZIP deliberately includes its derived seed data, not another copy of those large raw files. New 2025/2026 PBP and all delivered supplementary tables are independently included here. Nothing was rounded or dropped to make compression smaller: re-encoding preserves source Arrow values and types.

## File inventory

| File | Rows | Columns |
|---|---:|---:|
| `data/advstats_week_def_2024.parquet` | 7,992 | 29 |
| `data/advstats_week_def_2025.parquet` | 7,926 | 29 |
| `data/advstats_week_def_2026.parquet` | 1,841 | 29 |
| `data/advstats_week_pass_2024.parquet` | 697 | 24 |
| `data/advstats_week_pass_2025.parquet` | 684 | 24 |
| `data/advstats_week_pass_2026.parquet` | 152 | 24 |
| `data/advstats_week_rec_2024.parquet` | 4,453 | 17 |
| `data/advstats_week_rec_2025.parquet` | 4,533 | 17 |
| `data/advstats_week_rec_2026.parquet` | 1,048 | 17 |
| `data/advstats_week_rush_2024.parquet` | 2,359 | 16 |
| `data/advstats_week_rush_2025.parquet` | 2,355 | 16 |
| `data/advstats_week_rush_2026.parquet` | 512 | 16 |
| `data/depth_charts_2024.parquet` | 37,312 | 15 |
| `data/depth_charts_2025.parquet` | 554,215 | 12 |
| `data/depth_charts_2026.parquet` | 643,146 | 12 |
| `data/game_labels_2022_2026.csv` | 1,218 | 18 |
| `data/game_labels_historical_seed_2022_2024.csv` | 854 | 18 |
| `data/injuries_2024.parquet` | 6,215 | 16 |
| `data/injuries_2025.parquet` | 6,068 | 16 |
| `data/injuries_2026.parquet` | 1,413 | 16 |
| `data/ngs_passing.parquet` | 6,134 | 29 |
| `data/ngs_receiving.parquet` | 15,223 | 23 |
| `data/ngs_rushing.parquet` | 6,270 | 22 |
| `data/play_by_play_2025.parquet` | 48,771 | 372 |
| `data/play_by_play_2026.parquet` | 13,842 | 372 |
| `data/player_game_opportunities_2022_2026.csv` | 79,946 | 9 |
| `data/player_game_opportunities_historical_seed_2022_2024.csv` | 56,159 | 9 |
| `data/player_stats_def_2024.parquet` | 9,994 | 32 |
| `data/player_stats_kicking_2024.parquet` | 567 | 44 |
| `data/pregame_rolling_features_2022_2026.csv` | 2,436 | 58 |
| `data/roster_2024.parquet` | 3,216 | 36 |
| `data/roster_2025.parquet` | 3,137 | 36 |
| `data/roster_2026.parquet` | 3,033 | 36 |
| `data/roster_weekly_2024.parquet` | 46,579 | 36 |
| `data/roster_weekly_2025.parquet` | 46,849 | 36 |
| `data/roster_weekly_2026.parquet` | 13,048 | 36 |
| `data/snap_counts_2024.parquet` | 26,615 | 16 |
| `data/snap_counts_2025.parquet` | 26,613 | 16 |
| `data/snap_counts_2026.parquet` | 7,370 | 16 |
| `data/stats_player_week_2024.parquet` | 18,981 | 114 |
| `data/team_game_advanced_2022_2026.csv` | 2,436 | 27 |
| `data/team_game_advanced_historical_seed_2022_2024.csv` | 1,708 | 27 |

## Important limitations

Files are Parquet for efficient typed storage, plus CSV derived tables. Open with pandas/pyarrow and the scripts; do not expect the file browser to render a Parquet table as text. A CSV export utility is included. No credentials or paid calls are embedded.

Coverage differs by dataset; consult per-file season/week/date span and null counts. Depth rows are timestamped snapshots/positions, not independent player examples. Weekly injury rows lack verified report publication times. NGS/PFR source percentages and denominators are provider-native. Week-zero/season summary rows must not be pooled with weekly records. Native team aliases and GSIS/PFR/ESPN IDs require verified mapping before joins; do not join on names alone.

Measured game stats and final labels are outcomes, not target-game pregame inputs. Lagged tables exclude the target game and weight exposures but are retrospective because historical first-publication/model revisions are unknown. Source EPA/CPOE/NGS expectations are modeled source measures with version/availability limitations. The prior-game window crosses season boundaries; model and validate an offseason decay/reset explicitly.

Remaining high-value gaps include fresh and historical executable odds, timestamped inactive/QB confirmations, complete routes/participation, OL/DL assignment charting, forecast issue-time history, fully reconciled identity bridges and raw licensed tracking. Existing snap or target data cannot invent route counts. NFL source spread/total labels are not live quotes. No model has been trained/validated for betting in this package.

## Use

```bash
pip install -r requirements.txt
python scripts/build_features.py
python scripts/verify_and_package.py
# Optional single-table export:
python scripts/export_table.py data/play_by_play_2026.parquet current_plays.csv
```

The collector downloads from the discovered release URLs and saves provenance. Downloading again replaces the encoding; rerun lossless recompression and verification afterward. Collection uses no paid provider. Source rights/license and timing caveats are in docs/SOURCE_AND_TEMPORAL_RULES.md. Attribution: nflverse; repository CC-BY-4.0 license included. Review any dataset-specific/upstream restrictions before production redistribution.

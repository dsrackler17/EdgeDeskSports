# Actual shipped coverage

Every row below counts the stated file grain, not independent training examples. Results are historical, not live. No bookmaker quote dataset is included. No trained or validated betting model is included.

## Real records

| Dataset | Rows | Columns | Coverage meaning |
|---|---:|---:|---|
| `data/cbb_men/events_sample.csv` | 4,386 | 18 | Sample native game event records; not complete season PBP |
| `data/cbb_men/games_historical.csv` | 3,677 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/cbb_men/player_game_stats_sample.csv` | 2,821 | 11 | Sample player/team stat cells; not distinct games |
| `data/cbb_men/team_game_stats_sample.csv` | 552 | 6 | Sample player/team stat cells; not distinct games |
| `data/cbb_women/events_sample.csv` | 4,328 | 18 | Sample native game event records; not complete season PBP |
| `data/cbb_women/games_historical.csv` | 3,597 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/cbb_women/player_game_stats_sample.csv` | 2,977 | 11 | Sample player/team stat cells; not distinct games |
| `data/cbb_women/team_game_stats_sample.csv` | 528 | 6 | Sample player/team stat cells; not distinct games |
| `data/cfb/events_sample.csv` | 2,135 | 18 | Sample native game event records; not complete season PBP |
| `data/cfb/games_historical.csv` | 111 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/cfb/player_game_stats_sample.csv` | 5,566 | 11 | Sample player/team stat cells; not distinct games |
| `data/cfb/team_game_stats_sample.csv` | 360 | 6 | Sample player/team stat cells; not distinct games |
| `data/college_baseball/events_sample.csv` | 2,954 | 18 | Sample native game event records; not complete season PBP |
| `data/college_baseball/games_historical.csv` | 313 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/college_baseball/player_game_stats_sample.csv` | 2,138 | 11 | Sample player/team stat cells; not distinct games |
| `data/college_baseball/team_game_stats_sample.csv` | 60 | 6 | Sample player/team stat cells; not distinct games |
| `data/mlb/games_2024.csv` | 2,998 | 15 | MLB schedule/results, includes game types/statuses; not only regular season |
| `data/mlb/pitches_sample_2024.csv` | 8,800 | 41 | Measured pitches from 30 sampled regular-season games |
| `data/mlb/player_game_stats_sample_2024.csv` | 43,535 | 9 | Sample player/team stat cells; not distinct games |
| `data/nba/events_sample.csv` | 5,303 | 18 | Sample native game event records; not complete season PBP |
| `data/nba/games_historical.csv` | 1,403 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/nba/player_game_stats_sample.csv` | 3,962 | 11 | Sample player/team stat cells; not distinct games |
| `data/nba/team_game_stats_sample.csv` | 552 | 6 | Sample player/team stat cells; not distinct games |
| `data/nfl/game_labels_2022_2024.csv` | 854 | 18 | NFL game results; source spread/total are not timestamped tradable quotes |
| `data/nfl/play_by_play_2022.csv.gz` | 49,434 | 372 | NFL historical season source PBP, preserving all 372 native columns |
| `data/nfl/play_by_play_2023.csv.gz` | 49,665 | 372 | NFL historical season source PBP, preserving all 372 native columns |
| `data/nfl/play_by_play_2024.csv.gz` | 49,492 | 372 | NFL historical season source PBP, preserving all 372 native columns |
| `data/nfl/player_game_opportunities_2022_2024.csv` | 56,159 | 9 | Player/game/stat cells, not distinct players |
| `data/nfl/pregame_rolling_features_2022_2024.csv` | 1,708 | 58 | Prior-event lagged research features; source publication time unverified |
| `data/nfl/team_game_advanced_2022_2024.csv` | 1,708 | 27 | Measured per-team/per-game EPA and opportunity aggregates |
| `data/nhl/events_sample.csv` | 23,203 | 18 | Sample native game event records; not complete season PBP |
| `data/nhl/games_historical.csv` | 1,443 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/nhl/goalie_game_observed_sample.csv` | 171 | 14 | Observed goalie box measures; xG/GSAx intentionally missing |
| `data/nhl/player_game_deduplicated_sample.csv` | 3,121 | 9 | Native NHL player/game box stats, repeated groups deduplicated |
| `data/nhl/player_game_stats_sample.csv` | 56,232 | 11 | Sample player/team stat cells; not distinct games |
| `data/nhl/shot_attempts_sample.csv` | 9,895 | 25 | Observed NHL attempts from 72 sampled games; xG/strength states not supplied |
| `data/nhl/team_game_stats_sample.csv` | 2,016 | 6 | Sample player/team stat cells; not distinct games |
| `data/soccer/games_historical.csv` | 380 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/tennis_atp/matches_sample.csv` | 1,233 | 22 | Filtered singles from four historical query dates; not complete tour history |
| `data/tennis_wta/matches_sample.csv` | 1,609 | 22 | Filtered singles from four historical query dates; not complete tour history |
| `data/ufc/bouts_2024.csv` | 566 | 17 | Historical bout results; no UFCStats round metrics |
| `data/wnba/events_sample.csv` | 4,604 | 18 | Sample native game event records; not complete season PBP |
| `data/wnba/games_historical.csv` | 275 | 15 | Retrieved schedule/result records; total league completeness not established |
| `data/wnba/player_game_stats_sample.csv` | 3,206 | 11 | Sample player/team stat cells; not distinct games |
| `data/wnba/team_game_stats_sample.csv` | 552 | 6 | Sample player/team stat cells; not distinct games |

## Schema-only fields and sports

The canonical contract has 43 tables, 1,406 field definitions (including repeated key/provenance fields), 136 base feature definitions and 508 rolling-window configurations. These are contracts and formulas, not a claim that every field is populated or every feature has been computed. Raw NFL files independently retain all 372 native source columns.

Golf, cricket, rugby, boxing, motorsport and esports are extension contracts only. Even for the primary sports, proprietary tracking, full injury/lineup archives, complete event feeds and current market data remain collection gaps. See docs/COLLECTION_GAPS_AND_COSTS.md.

No data was fabricated. Zero-data files and templates reside outside the real-data inventory or are labeled empty. Unavailable advanced fields stay blank. Source-native coordinates are not silently converted to physical units.

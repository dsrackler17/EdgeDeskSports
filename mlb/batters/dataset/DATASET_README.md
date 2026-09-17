# MLB offensive history, 2016–2025

Ten completed MLB regular seasons. This package complements the MLB pitcher dataset using the same MLB player IDs, team IDs, and season keys. It includes every record returned by MLB's ALL-player hitting endpoint, including pitchers who batted and records with zero plate appearances. It is not a full roster history. Postseason, minors, spring training, and the unfinished 2026 season are excluded.

## Files and table grains

| File/table | Each row represents |
|---|---|
| batter_overview.csv | One player's combined results across the window |
| batter_seasons.csv | One player-season, combining teams |
| batter_team_seasons.csv | One player-season-team |
| batter_team_history.csv | One player-team across the window |
| observed_team_runs.csv | Consecutive years with a hitting record for one player-team |
| team_offense_seasons.csv | One club-season, with actual club games and runs per game |
| team_offense_overview.csv | One club across the window |
| league_seasons.csv | Combined MLB offense for one season |
| teams.csv | Team identity and name for a season |
| validation.csv | Coverage and reconciliation status for one season |

`mlb_offense.sqlite` holds all ten tables. `data_dictionary.json` explains every column. `example_queries.sql` includes comparisons and queries that join to the pitcher package. Start with `batter_overview.csv` for player history and `team_offense_seasons.csv` for team comparisons.

`raw/` preserves the fetched source responses. `source_manifest.json` contains exact URLs, original retrieval timestamps, and SHA-256 hashes. `source_repairs.json` lists substitutions from individual player histories when team queries omit earlier clubs. `games_reconciliation_notes.json` records differences between official player-season games and summed team-split games. `build_report.json` records row counts and validation status.

CSVs use UTF-8 with BOM for Excel. Numbers are numeric, percentage fields are fractions (0.25 means 25%), and blank values mean unavailable or mathematically undefined. Stable IDs are join keys. Never add combined season totals and team splits together. Never average player batting averages to calculate a team average: sum hits and at-bats first.

## Performance fields

Counting fields include plate appearances, at-bats, runs, hits, singles, doubles, triples, home runs, RBI, walks, intentional walks, strikeouts, hit-by-pitches, stolen bases, caught stealing, total bases, sacrifices, grounded-into-double-plays, catcher interference, and pitches seen when supplied.

Derived rates:

- AVG = H / AB.
- OBP = (H + BB + HBP) / (AB + BB + HBP + SF).
- SLG = TB / AB.
- OPS = OBP + SLG, calculated before rounding.
- ISO = (TB − H) / AB.
- BABIP = (H − HR) / (AB − K − HR + SF).
- K%, BB%, HR% use plate appearances as the denominator.
- Stolen-base success = SB / (SB + CS).

Zero denominators produce blanks. A batter with walks but no at-bats can have a defined OBP but undefined SLG, OPS, and rating. Intentional walks are already included in total walks. Position is source-reported and is not a reconstructed historical position log. Runs and RBI include opportunities created by teammates; neither alone measures an individual hitter's skill.

`games` in player-season rows is MLB's official reported season games, which can include games without batting. `team_split_games_sum` retains the sum of team split games for comparison. `player_games_sum` in team and league tables is the sum of player games and MUST NOT be used as club games. Actual team games are `team_games`. Pitches seen and games are preserved but excluded from the 19-field offensive-stat reconciliation.

## Custom offensive rating

`offensive_index` uses version `ED_BAT_PERF_V1`. Higher is better; 100 is MLB average. This descriptive batting index is NOT official OPS+, wRC+, WAR, a percentile, a 0–100 grade, or a probability. It is not park-adjusted or opponent-adjusted and does not measure defense or assign value to baserunning. Stolen-base results are available separately.

For each season:

```
league_OBP = (league_H + league_BB + league_HBP) / (league_AB + league_BB + league_HBP + league_SF)
league_SLG = league_TB / league_AB
sample_weight = PA / (PA + 200)
offensive_index = 100 + 100 * sample_weight * (OBP / league_OBP + SLG / league_SLG - 2)
```

The baseline includes all MLB hitters, including pitchers. The 200-PA shrinkage constant is an explicit initial design choice, not empirically fitted or claimed optimal. A 600-PA hitter whose OBP is 10% above the league baseline and SLG is 20% above it scores 122.5. A rating near 100 over a handful of plate appearances does not establish average true talent. Always show PA and `sample_flag` alongside the rating. The score has no imposed upper or lower bound.

The algorithm uses unrounded rate calculations. Exported rates are rounded to six decimals and ratings to three. `rating_sample_weight` is a shrinkage coefficient, not confidence or reliability expressed as a probability.

`weighted_offensive_index` is the PA-weighted mean of valid annual indexes, or team-season indexes for team-history summaries. `rated_plate_appearances` shows the actual denominator. Because team splits have their own shrinkage, a team-history summary need not equal the combined player-season score. Team offense uses the same formula on aggregate team results; its large PA total means little shrinkage. Latest observed means latest within this window, not present-day performance. Best season by index has no extra qualifying-PA screen; add one when comparing regulars.

This is a historical research dataset, not a fitted betting model. Full-season results cannot be used to predict earlier games in that same season without look-ahead leakage. For predictive work, use completed prior seasons or separately sourced dated game logs, and evaluate chronologically out of sample.

## Team duration and scope

`seasons_with_records` counts years with a returned MLB hitting record. `seasons_with_PA` counts years with at least one plate appearance. `observed_seasons` lists the actual record years. First and last observed years are limited to this archive. Boundary flags indicate that a record touches a dataset boundary, not an employment date.

Consecutive record years are grouped into observed runs. Missing seasons split runs and might reflect injury, minors, inactivity, or a different club. Two separate visits to a club within one season remain one team-season row. These are NOT verified contract, trade, or roster-date intervals. Franchise IDs preserve name changes, and `teams.csv` provides season-specific names.

This archive does not contain daily lineups, lineup slots, opposing-pitcher matchups, handedness splits, Statcast exit velocity or expected statistics, injuries, or verified transaction dates. Those require additional sources. It can establish historical lineup context when joined to a separately sourced current lineup; it does not establish who is playing today.

## Source and validation

Primary source: MLB StatsAPI, https://statsapi.mlb.com/api/v1/ . Queries use MLB sport ID 1, regular-season game type R, and ALL player pool. The builder checks endpoint pagination, all 30 clubs per year, unique keys, complete player universe agreement, and total-base arithmetic.

Nineteen offensive counting fields reconcile player by player between team splits and separately fetched all-team player totals. Every club-season also reconciles those fields to MLB's independent team-statistics endpoint. If team queries omit pre-trade records, the builder fetches explicit team splits from individual year-by-year histories and logs the replacement. No team assignment or missing statistic is inferred by subtraction. A failed reconciliation stops the build before exporting tables.

These checks verify consistency of retrieved MLB data, not immunity to later official corrections. Workloads in the shortened 2020 season are not comparable to a full season without adjustment. Team-games values reflect the official source, not a hardcoded assumption of 162.

Original source copyright notices remain in raw responses. Public API access does not itself establish commercial redistribution rights.

## Refresh and extend

Python 3 standard library only; no API key or third-party Python packages required.

```bash
python build_dataset.py --start 2016 --end 2025 --refresh
```

Without `--refresh`, downloaded source snapshots are reused. To add 2026 to date in a separate directory:

```bash
python build_dataset.py --start 2016 --end 2026 --output ./mlb_offense_through_2026 --refresh
```

Treat an unfinished season as provisional. The full-season baseline and ratings change as games are played. Archive successful dated builds so past snapshots remain available. Inspect `build_report.json` and process exit status; a failed run does not mean older outputs were refreshed. The SQLite file is built and integrity-checked before replacement; CSV exports are individual writes, so production integration should stage the entire package before switching versions. No website integration or scheduled job has been installed by creating this package.

For database integration, upsert on `(player_id, season)` and `(player_id, season, team_id)`. Join the pitching archive on those same keys when combining two-way performance. Add handedness, game logs, Statcast, transactions, and current lineups as separate tables with explicit dates and provenance.

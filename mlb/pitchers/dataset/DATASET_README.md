# MLB pitcher history, 2016–2025

Ten completed MLB regular seasons. Includes every player returned by MLB's pitching feed, with no minimum innings filter. This includes position players who pitched and pitchers who recorded zero outs. Postseason, minor leagues, spring training, injured/rostered players with no MLB pitching appearance, and 2026 are excluded.

## Open and use

- `pitcher_overview.csv`: one row per pitcher across the window. Start here for the overall picture.
- `pitcher_seasons.csv`: one row per pitcher per season, combining teams correctly. Use for performance trends and annual ratings.
- `pitcher_team_seasons.csv`: one row per pitcher, season, and team. Use to evaluate performance for each club and traded players.
- `pitcher_team_history.csv`: totals by pitcher and franchise/team ID, seasons observed, and weighted rating.
- `observed_team_runs.csv`: consecutive calendar seasons with pitching appearances for the same team. Gaps split runs. These are NOT verified contract stints.
- `league_seasons.csv`: league totals and the annual ERA/FIP baseline.
- `teams.csv`: season-specific team names, IDs, leagues, and divisions.
- `mlb_pitchers.sqlite`: all eight tables, with unique pitcher-season and pitcher-team-season indexes. Open with any SQLite client or import CSVs into your application.
- `validation.csv`, `build_report.json`: coverage counts and verification results.
- `source_repairs.json`: player-season records replaced with individual MLB histories because team queries omitted earlier clubs.
- `source_manifest.json`, `raw/`: original source snapshots, URLs, retrieval timestamps, and SHA-256 hashes.
- `build_dataset.py`: reproducible downloader, validator, and exporter. Uses Python 3's standard library only.

The CSVs use UTF-8 with BOM for Excel compatibility. A blank means undefined or unavailable, never an invented zero. Percentage fields are fractions, e.g. 0.25 means 25%. MLB player IDs are the joining keys, not names. Never sum the season totals and team splits together: they represent the same performances at different grains.

## Performance rating

`performance_index` is a custom descriptive index, version `ED_PITCH_PERF_V1`. Higher is better; 100 equals league-average performance. It is NOT an official MLB rating, a percentile, a 0–100 grade, WAR, ERA+, or a validated prediction. It has no hard lower or upper bound. The weights are explicit initial design choices, not fitted or proven optimal.

For each season, derive the MLB baseline from all player totals, including position players who pitched:

```
IP = outs / 3
league_ERA = 9 * league_earned_runs / league_IP
FIP_constant = league_ERA - (13*league_HR + 3*(league_BB + league_HBP) - 2*league_K) / league_IP
pitcher_FIP = (13*HR + 3*(BB + HBP) - 2*K) / IP + FIP_constant
sample_weight = IP / (IP + 40)
performance_index = 100 + 100 * sample_weight * (1 - (0.70*FIP + 0.30*ERA) / league_ERA)
```

FIP construction follows MLB's glossary: https://www.mlb.com/glossary/advanced-stats/fielding-independent-pitching . All walks, including intentional walks, enter this version. The annual constant is calculated here; do not assume exact agreement with another publisher's FIP variant.

For example, performance 20% better than the blended league baseline over 160 IP receives 116, after the 160/(160+40) adjustment. This is not a claim that a pitcher is 16% more likely to win. Shrinkage toward 100 suppresses small-sample extremes; a one-inning score near 100 is not evidence of average true talent. Keep innings and `sample_flag` beside every rating.

Zero-out records retain counting statistics but have blank ERA, FIP, WHIP and performance index. `role` is a descriptive label: starter if at least half of appearances were starts; reliever if zero starts; mixed otherwise. It does not separate a pitcher's starting and relief statistics within a season. Ratings use the common MLB baseline, not separate role or league baselines, and are not park-adjusted or opponent-adjusted. Filter out non-pitcher `position_reported` values when evaluating the pitcher population, noting that this source-reported position is not a reconstructed historical roster classification.

`weighted_performance_index` in multi-year summaries is the innings-weighted mean of the underlying annual ratings. In team summaries it weights the team-season ratings, which have their own sample shrinkage. It is not a newly rated career total and need not equal the overall pitcher rating across teams. `latest_observed_performance_index` describes the player's latest appearance season within this window, not present-day ability. `best_season_by_index` uses the same shrunken rating without a separate innings qualification. Historical results contain outcome information; do not use full-season ratings to predict earlier games in that same season.

## What team tenure means

`seasons_with_appearances` counts distinct seasons with an MLB pitching appearance for that club. `first_observed_season` and `last_observed_season` describe this ten-year window only. `observed_seasons` lists the actual years, so missed seasons are visible. Boundary flags mean the observed span touches the dataset's first/last year; they do not assert when employment began or ended.

The data does not establish exact signing, trade, release, injury-list, or roster dates. Returning twice to the same team within one season is one combined team-season row. A missed season may reflect injury, minors, a different club, or inactivity. Do not call a consecutive observed run a contract tenure. Team IDs preserve franchise continuity through name changes; season-specific names are in `teams.csv` and the team-season table.

## Updating and extending

From the extracted folder:

```bash
python build_dataset.py --start 2016 --end 2025 --refresh
```

To include 2026 to date in a separate output directory:

```bash
python build_dataset.py --start 2016 --end 2026 --output ./mlb_pitchers_through_2026 --refresh
```

Treat the current season as provisional until regular-season completion. Updating rebuilds all tables and recalculates the annual baseline; active-season ratings will change. Without `--refresh`, previously downloaded raw responses are reused. The script retries temporary failures and refuses to publish tables when team splits disagree with MLB's independent player-season totals. Inspect `build_report.json` after a run; never assume a failed run refreshed prior output. Archive each successful dated output to preserve past snapshots. No scheduled update or website/database integration has been installed.

For application integration, upsert using `(player_id, season)` and `(player_id, season, team_id)` and store the rating version and source snapshot timestamp. Historical corrections should replace matching keys, not append duplicates. Add future features in separate keyed tables: game logs, dated transactions, handedness, pitch mix/velocity, injuries, park factors, and Statcast expected results. Validate any predictive replacement rating with chronological out-of-sample tests before presenting it as a forecast.

## Source and quality controls

Source: MLB StatsAPI, https://statsapi.mlb.com/api/v1/ . Exact requests and timestamps appear in the manifest. Queries explicitly use MLB sport ID 1, regular-season game type R, and player pool ALL. Per-team results are fetched independently of all-team player totals. When a team query omits pre-trade appearances, the builder replaces that player-season with the explicit team splits from MLB’s individual year-by-year endpoint, then reruns the same reconciliation. The repair log records every replacement. No missing team statistics are inferred by subtraction.

Validation checks: all 30 clubs each year; endpoint pagination counts; unique row keys; innings notation converted to exact outs; pitcher universe coverage; and 14 counting fields reconciled player by player between team sums and the all-team endpoint. SQLite integrity is also checked. This verifies agreement with the retrieved feed, not that MLB will never correct a historical record. The 2020 season was shortened: compare workloads in context.

The original MLB copyright notice is retained in the raw responses. Access to this public endpoint does not establish commercial redistribution rights.

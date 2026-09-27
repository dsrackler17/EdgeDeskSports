-- Overall offensive history. Workload screen is adjustable.
SELECT player_id, player_name, teams, seasons_with_PA, plate_appearances,
       avg, obp, slg, ops, home_runs, stolen_bases, weighted_offensive_index
FROM batter_overview
WHERE plate_appearances >= 2000
ORDER BY weighted_offensive_index DESC;

-- Compare season regulars, with a 2020 workload screen adjusted for the shortened season.
-- This is a user-defined workload screen, not an exact MLB qualification rules engine.
SELECT season, player_name, teams, plate_appearances, ops, iso, k_pct, bb_pct, offensive_index
FROM batter_seasons
WHERE plate_appearances >= CASE WHEN season=2020 THEN 186 ELSE 502 END
ORDER BY season DESC, offensive_index DESC;

-- Shohei Ohtani's hitting history by team, using his stable MLB ID.
SELECT season, team_name, plate_appearances, avg, obp, slg, home_runs,
       stolen_bases, offensive_index
FROM batter_team_seasons
WHERE player_id=660271
ORDER BY season, team_id;

-- Club offense, respecting actual game counts.
SELECT season, team_name, team_games, runs_per_game, ops, home_runs, offensive_index
FROM team_offense_seasons
ORDER BY season DESC, runs_per_game DESC;

-- Year-over-year changes. Both years must clear the workload screen.
SELECT current.player_name, current.season,
       current.plate_appearances, current.ops - previous.ops AS ops_change,
       current.k_pct - previous.k_pct AS strikeout_rate_change,
       current.bb_pct - previous.bb_pct AS walk_rate_change
FROM batter_seasons current
JOIN batter_seasons previous ON current.player_id=previous.player_id
 AND current.season=previous.season+1
WHERE current.plate_appearances>=300 AND previous.plate_appearances>=300
ORDER BY current.season DESC, ops_change DESC;

-- Joining to the separately supplied pitcher archive:
-- Change the following path to your extracted pitcher database location.
-- ATTACH DATABASE '../mlb_pitchers_2016_2025/mlb_pitchers.sqlite' AS pitching;
-- SELECT b.player_name,b.season,b.plate_appearances,b.ops,b.offensive_index,
--        p.innings_display,p.era,p.performance_index
-- FROM batter_seasons b JOIN pitching.pitcher_seasons p
--   ON b.player_id=p.player_id AND b.season=p.season
-- WHERE b.player_id=660271 ORDER BY b.season;

-- Overall picture: substantial workload across the ten-year window.
SELECT player_id, player_name, teams, seasons_with_appearances,
       innings_display, era, whip, strikeouts, weighted_performance_index
FROM pitcher_overview
WHERE outs >= 1500
ORDER BY weighted_performance_index DESC;

-- Annual qualified-workload starting-pitcher view. The 2020 cutoff reflects its shortened schedule.
-- This is a workload screen, not MLB's official league-leader qualification implementation.
SELECT season, player_name, teams, innings_display, era, fip, k_minus_bb_pct, performance_index
FROM pitcher_seasons
WHERE role = 'starter' AND outs >= CASE WHEN season = 2020 THEN 180 ELSE 486 END
ORDER BY season DESC, performance_index DESC;

-- Track a pitcher using a stable MLB ID. Example: Gerrit Cole.
SELECT season, team_name, games, starts, innings_display, era, fip, performance_index
FROM pitcher_team_seasons
WHERE player_id = 543037
ORDER BY season, team_id;

-- Team tenure measured as observed appearance seasons, not employment dates.
SELECT player_name, team_names_observed, first_observed_season, last_observed_season,
       observed_seasons, seasons_with_appearances, innings_display, era, weighted_performance_index
FROM pitcher_team_history
WHERE team_id = 147
ORDER BY seasons_with_appearances DESC, outs DESC;

-- Role-aware annual bullpen comparison with a minimum workload screen.
SELECT season, player_name, teams, innings_display, saves, holds, era, fip, performance_index
FROM pitcher_seasons
WHERE role = 'reliever' AND outs >= CASE WHEN season = 2020 THEN 45 ELSE 120 END
ORDER BY season DESC, performance_index DESC;

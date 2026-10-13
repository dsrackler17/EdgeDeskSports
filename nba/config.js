'use strict';
/* ===========================================================================
   EdgeDesk NBA — one place for every path, source, window and version the
   NBA engine uses. docs/engine/NBA.md is the narrative; this is the contract.

   The NBA engine is a dedicated brain beside the four-league basketball lab
   (basketball/), which it does not change: the lab's scoreboard-only points
   ratings remain one of the baselines this engine is compared with.
   =========================================================================== */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NBA = __dirname;

/* Season keys are the END year, the source's convention (2027 = 2026-27). */
const FIRST_SEASON = 2003;           /* 2002-03: the first season the source carries play-by-play */
function currentSeason(now) {
  if (process.env.NBA_SEASON && /^\d{4}$/.test(process.env.NBA_SEASON)) return Number(process.env.NBA_SEASON);
  const d = new Date(now == null ? Date.now() : now);
  return d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}
const CURRENT_SEASON = currentSeason();

/* THE WINDOWS — written here before any candidate was scored, and never moved.
     burn_in       rated and trained on, never scored (ratings and player
                   impact need seasons of history before a number means much)
     selection     every design choice and hyperparameter is chosen here
     test          SEALED. Scored once, by the frozen specification, after
                   every choice was made on selection; each unsealing is
                   logged with the specification's hash (nba/validation/
                   holdout_log.json) so a second look cannot pass unnoticed
     live          the season in progress: the clean forward test (the ledger) */
const WINDOWS = { burn_in: [2003, 2007], selection: [2008, 2017], test: [2018, null], live: [null, null] };
function windows(now) {
  const cur = currentSeason(now);
  return { burn_in: WINDOWS.burn_in.slice(), selection: WINDOWS.selection.slice(), test: [WINDOWS.test[0], cur - 1], live: [cur, cur] };
}

const RAW = 'https://raw.githubusercontent.com/sportsdataverse/hoopR-nba-data/main/nba';
const SOURCES = {
  /* sportsdataverse/hoopR-nba-data: season datasets compiled from ESPN's public
     NBA game feeds (scoreboard, summary, play-by-play). Public, keyless; MIT. */
  schedule: (s) => `${RAW}/schedules/parquet/nba_schedule_${s}.parquet`,
  team_box: (s) => `${RAW}/team_box/parquet/team_box_${s}.parquet`,
  player_box: (s) => `${RAW}/player_box/parquet/player_box_${s}.parquet`,
  pbp: (s) => `${RAW}/pbp/parquet/play_by_play_${s}.parquet`,
  officials: (s) => `${RAW}/officials/parquet/officials_${s}.parquet`,
  rosters: (s) => `${RAW}/rosters/parquet/rosters_${s}.parquet`,
};

const LICENSE = {
  sportsdataverse: 'sportsdataverse/hoopR-nba-data is an MIT-licensed repository; the game data inside it is compiled from ESPN\'s public NBA feeds and remains ESPN\'s and the NBA\'s. The repository licence does not grant rights to the underlying data. ESPN\'s and NBA.com\'s terms restrict commercial use: the owner must review before NBA output is sold in a paid tier. Attribution is printed on every NBA artifact.',
  nba_stats: 'stats.nba.com / cdn.nba.com are NOT used: unreachable from this build, and NBA.com\'s terms of use restrict automated and commercial use. swar/nba_api is an MIT wrapper; its licence grants no rights to NBA.com data.',
  odds: 'No historical odds archive is licensed here. ESPN\'s displayed spread (play-by-play game_spread) is untimestamped and names no book: it is kept only as a labelled diagnostic, never a market test and never an ROI basis.',
};

const PATHS = {
  ROOT, NBA,
  cacheSrc: path.join(ROOT, '.cache', 'nba_src'),
  cacheWork: path.join(ROOT, '.cache', 'nba_work'),
  http: path.join(ROOT, '.cache', 'engine_http'),
  pyHelper: path.join(NBA, 'tools', 'parquet_select.py'),
  games: path.join(NBA, 'data', 'games'),
  teamGames: path.join(NBA, 'data', 'team_games'),
  manifest: path.join(NBA, 'data', 'manifest.json'),
  teams: path.join(NBA, 'data', 'teams.json'),
  venues: path.join(NBA, 'data', 'venues.json'),
  params: path.join(NBA, 'params'),
  validation: path.join(NBA, 'validation'),
  slate: path.join(NBA, 'slate.json'),
  ledger: path.join(NBA, 'ledger'),
  market: path.join(NBA, 'market'),
  availability: path.join(NBA, 'data', 'availability.json'),
};

const SCHEMA = {
  games: 'edgedesk_nba_games_v1',
  team_games: 'edgedesk_nba_team_games_v1',
  player_games: 'edgedesk_nba_player_games_v1',
  stints: 'edgedesk_nba_stints_v1',
  shots: 'edgedesk_nba_shots_v1',
  validation: 'edgedesk_nba_walkforward_v1',
  props: 'edgedesk_nba_props_validation_v1',
  slate: 'edgedesk_nba_slate_v1',
  ledger: 'edgedesk_nba_ledger_v1',
  market: 'edgedesk_market_quotes_v1',
};

/* the columns each source file is read for (a missing one is recorded, never filled) */
const COLUMNS = {
  schedule: ['game_id', 'season', 'season_type', 'date', 'neutral_site', 'status_type_name', 'status_type_completed', 'status_period', 'format_regulation_periods',
    'home_id', 'home_display_name', 'home_abbreviation', 'home_score', 'home_linescores', 'away_id', 'away_display_name', 'away_abbreviation', 'away_score', 'away_linescores',
    'venue_id', 'venue_full_name', 'venue_address_city', 'venue_address_state', 'attendance', 'notes_headline', 'time_valid'],
  team_box: ['game_id', 'team_id', 'team_home_away', 'team_score', 'field_goals_made', 'field_goals_attempted', 'three_point_field_goals_made', 'three_point_field_goals_attempted',
    'free_throws_made', 'free_throws_attempted', 'offensive_rebounds', 'defensive_rebounds', 'total_rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'total_turnovers', 'team_turnovers',
    'fouls', 'points_in_paint', 'fast_break_points', 'turnover_points', 'largest_lead', 'opponent_team_id'],
  player_box: ['game_id', 'team_id', 'athlete_id', 'athlete_display_name', 'athlete_position_abbreviation', 'minutes', 'field_goals_made', 'field_goals_attempted',
    'three_point_field_goals_made', 'three_point_field_goals_attempted', 'free_throws_made', 'free_throws_attempted', 'offensive_rebounds', 'defensive_rebounds', 'rebounds',
    'assists', 'steals', 'blocks', 'turnovers', 'fouls', 'plus_minus', 'points', 'starter', 'ejected', 'did_not_play', 'reason', 'active'],
  pbp: ['game_id', 'sequence_number', 'type_id', 'type_text', 'text', 'period_number', 'clock_minutes', 'clock_seconds', 'home_score', 'away_score', 'scoring_play', 'score_value',
    'shooting_play', 'team_id', 'athlete_id_1', 'athlete_id_2', 'athlete_id_3', 'coordinate_x', 'coordinate_y', 'home_team_id', 'away_team_id',
    'game_spread', 'home_team_spread', 'home_favorite', 'game_spread_available'],
};

/* Basketball constants */
const REG_SECONDS = 2880, PERIOD_SECONDS = 720, OT_SECONDS = 300;

module.exports = { ROOT, NBA, FIRST_SEASON, CURRENT_SEASON, currentSeason, WINDOWS, windows, SOURCES, LICENSE, PATHS, SCHEMA, COLUMNS, REG_SECONDS, PERIOD_SECONDS, OT_SECONDS };

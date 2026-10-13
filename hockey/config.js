'use strict';
/* ===========================================================================
   EdgeDesk NHL — one place for every path, source and version the hockey
   pipeline uses. docs/engine/NHL.md is the narrative; this is the contract.
   =========================================================================== */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOCKEY = __dirname;

/* Season keys are the END year, the convention of the source (2027 = 2026-27). */
const FIRST_SEASON = 2011;           /* 2009-10 (2010) lacks strength state in the source; not used */
/* The season in progress, by its end year: from August on, the season that
   starts that autumn (Aug 2026 → 2027 = 2026-27). NHL_SEASON overrides it
   (a backfill, a test). */
function currentSeason(now) {
  if (process.env.NHL_SEASON && /^\d{4}$/.test(process.env.NHL_SEASON)) return Number(process.env.NHL_SEASON);
  const d = new Date(now == null ? Date.now() : now);
  return d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}
const CURRENT_SEASON = currentSeason();

const SOURCES = {
  /* sportsdataverse/fastRhockey-nhl-data: season datasets compiled from the NHL's
     own api-web.nhle.com game feeds. Public, keyless; refreshed daily in season. */
  pbp: (season) => `https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-data/main/nhl/pbp_lite/parquet/play_by_play_lite_${season}.parquet`,
  goalie_box: (season) => `https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-data/main/nhl/goalie_box/parquet/goalie_box_${season}.parquet`,
  game_info: (season) => `https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-data/main/nhl/game_info/parquet/game_info_${season}.parquet`,
  /* sportsdataverse/fastRhockey-nhl-raw: the season schedule (api-web club-schedule-season union), incl. future games */
  schedule: (season) => `https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-raw/main/nhl/schedules/parquet/nhl_schedule_${season}.parquet`,
  /* the NHL's own public web API — primary for today's schedule and game state in CI */
  nhl_schedule_day: (date) => `https://api-web.nhle.com/v1/schedule/${date}`,
  nhl_score_day: (date) => `https://api-web.nhle.com/v1/score/${date}`,
};

const LICENSE = {
  sportsdataverse: 'sportsdataverse/fastRhockey-nhl-data and -raw are MIT-licensed repositories; the game data inside them is compiled from the NHL\'s public game feeds and remains the NHL\'s. NHL.com terms restrict commercial use of its content: the owner must review this before NHL output is sold in a paid tier. Attribution is printed on every NHL artifact.',
  nhl_api: 'NHL public web API (api-web.nhle.com): undocumented, keyless, no published terms for automated use; called at a polite rate (≤ 4 req/s) and cached.',
};

const PATHS = {
  ROOT, HOCKEY,
  cacheSrc: path.join(ROOT, '.cache', 'nhl_src'),
  cacheWork: path.join(ROOT, '.cache', 'nhl_work'),
  http: path.join(ROOT, '.cache', 'engine_http'),
  teamGames: path.join(HOCKEY, 'data', 'team_games'),
  manifest: path.join(HOCKEY, 'data', 'manifest.json'),
  goalies: path.join(HOCKEY, 'data', 'goalies.json'),
  arenas: path.join(HOCKEY, 'data', 'arenas.json'),
  xgModels: path.join(HOCKEY, 'xg', 'models'),
  validation: path.join(HOCKEY, 'validation'),
  slate: path.join(HOCKEY, 'slate.json'),
  ledger: path.join(HOCKEY, 'ledger'),
  pyHelper: path.join(HOCKEY, 'tools', 'parquet_select.py'),
  market: path.join(HOCKEY, 'market'),
};

const SCHEMA = {
  team_games: 'edgedesk_nhl_team_games_v1',
  xg: 'edgedesk_nhl_xg_v1',
  validation: 'edgedesk_nhl_walkforward_v1',
  slate: 'edgedesk_nhl_slate_v1',
  ledger: 'edgedesk_nhl_ledger_v1',
  market: 'edgedesk_market_quotes_v1',
};

/* the play-by-play columns the ingest reads (missing ones are recorded, never filled) */
const PBP_COLUMNS = [
  'game_id', 'season_type', 'game_date', 'home_abbr', 'away_abbr', 'event_idx',
  'event_type', 'secondary_type', 'event_team_type', 'event_team_abbr',
  'period', 'period_type', 'period_seconds', 'game_seconds', 'home_score', 'away_score',
  'strength_state', 'home_skaters', 'away_skaters', 'empty_net', 'extra_attacker',
  'home_goalie_in', 'away_goalie_in', 'x_fixed', 'y_fixed',
  'event_player_1_id', 'event_goalie_id', 'home_goalie_id', 'away_goalie_id',
  'penalty_minutes', 'penalty_severity', 'xg',
];
const GOALIE_COLUMNS = ['game_id', 'home_away', 'team_abbrev', 'player_id', 'player_name', 'starter', 'toi', 'shots_against', 'goals_against', 'decision'];
const SCHEDULE_COLUMNS = ['game_id', 'season_full', 'game_type', 'game_date', 'game_time', 'home_team_abbr', 'away_team_abbr', 'home_score', 'away_score', 'game_state', 'venue'];

module.exports = { ROOT, HOCKEY, FIRST_SEASON, CURRENT_SEASON, currentSeason, SOURCES, LICENSE, PATHS, SCHEMA, PBP_COLUMNS, GOALIE_COLUMNS, SCHEDULE_COLUMNS };

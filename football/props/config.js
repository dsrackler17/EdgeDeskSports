/* ============================================================================
   PLAYER PROPS — pipeline configuration (docs/player-props/DESIGN.md).

   Paths, leagues, the books and markets the capture asks for, and the budget
   rules. Nothing here is a model number: those live in model.js (projection)
   and lib/edgedesk_props.js (probability, EV, decision).
   ========================================================================== */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = __dirname;
const CACHE = process.env.PROPS_CACHE || path.join(DIR, '.cache');

const LEAGUES = {
  nfl: { key: 'nfl', label: 'NFL', sport: 'americanfootball_nfl', id_scheme: 'nflverse gsis_id', game_scheme: 'nflverse game_id (season_week_AWAY_HOME)' },
  cfb: { key: 'cfb', label: 'CFB', sport: 'americanfootball_ncaaf', id_scheme: 'ESPN athlete_id', game_scheme: 'ESPN event id' }
};

/* The capture asks for these groups. The Odds API bills markets × regions per
   event call; a bookmakers list of up to ten books is one region. */
const MARKET_GROUPS = {
  core: ['player_pass_yds', 'player_pass_attempts', 'player_pass_completions', 'player_pass_tds', 'player_pass_interceptions',
    'player_rush_yds', 'player_rush_attempts', 'player_reception_yds', 'player_receptions', 'player_rush_reception_yds', 'player_anytime_td'],
  long: ['player_pass_longest_completion', 'player_rush_longest', 'player_reception_longest'],
  td: ['player_1st_td', 'player_tds_over', 'player_rush_tds', 'player_reception_tds'],
  alt: ['player_pass_yds_alternate', 'player_rush_yds_alternate', 'player_reception_yds_alternate', 'player_receptions_alternate', 'player_rush_reception_yds_alternate', 'player_pass_tds_alternate'],
  kick: ['player_field_goals', 'player_kicking_points'],
  defense: ['player_tackles_assists', 'player_solo_tackles', 'player_sacks']
};
const DEFAULT_GROUPS = { nfl: ['core', 'long', 'alt'], cfb: ['core', 'alt'] };

const DEFAULTS = {
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,hardrockbet,fanatics,pinnacle,betonlineag',
  window_h: 96,            /* only events kicking off inside this window */
  max_events: 16,          /* nearest kickoff first */
  far_h: 36,               /* an event more than this many hours out… */
  far_interval_h: 8,       /* …is re-polled at most every this many hours */
  min_interval_h: 3,       /* inside far_h, at most every this many hours */
  near_interval_h: 0.5,    /* inside six hours of its kickoff, every run (the schedule is hourly) */
  min_remaining: 200,      /* stop before spending below this many provider credits */
  max_credits_run: 800     /* one run never spends more than this */
};

function leaguePaths(league, season) {
  const base = path.join(DIR, league);
  return {
    dir: base,
    board: path.join(base, 'board.json'),
    players: path.join(base, 'players.json'),
    quotes: path.join(base, 'quotes.json'),
    lines: path.join(base, 'lines.json'),
    capture_state: path.join(base, 'capture_state.json'),
    calibration: path.join(base, 'calibration.json'),
    performance: path.join(base, 'performance.json'),
    season_dir: path.join(base, String(season)),
    evaluations: path.join(base, String(season), 'evaluations.jsonl'),
    closes: path.join(base, String(season), 'closes.jsonl'),
    results: path.join(base, String(season), 'results.jsonl')
  };
}

/* January and February belong to the season that started the previous August */
function seasonOf(now) {
  const d = new Date(now == null ? Date.now() : now);
  return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

module.exports = { ROOT, DIR, CACHE, LEAGUES, MARKET_GROUPS, DEFAULT_GROUPS, DEFAULTS, leaguePaths, seasonOf };

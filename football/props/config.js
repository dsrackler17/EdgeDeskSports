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

/* The capture's CADENCE (how often each event is re-polled, by hours to
   kickoff), its retry/backoff and every freshness threshold live in ONE
   place: lib/edgedesk_props.js FRESHNESS. The environment may override them
   (freshnessFromEnv below); the build writes the effective values onto the
   board so the page judges prices by the same numbers. */
const DEFAULTS = {
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,hardrockbet,fanatics,pinnacle,betonlineag',
  window_h: 96,            /* only events kicking off inside this window */
  max_events: 64,          /* per run; due events are taken nearest kickoff first (a full college Saturday fits one run) */
  slack_min: 3,            /* an event this close to its next poll is taken now (the scheduler ticks every 5 min) */
  min_remaining: 200,      /* stop before spending below this many provider credits */
  low_credits: 5000,       /* below this, events more than six hours out are polled half as often */
  critical_credits: 1500,  /* below this, only events inside six hours of kickoff are polled */
  max_credits_run: 800,    /* one run never spends more than this */
  request_attempts: 2,     /* a timeout, network error or 5xx is retried once inside the run… */
  retry_delay_ms: 1500,    /* …after this long, ± jitter */
  timeout_ms: 30000        /* one provider request never waits longer than this */
};

/* PROPS_CADENCE="1.5:15,6:30,24:60,48:120,*:360" (hours to kickoff : minutes
   between polls); PROPS_FRESH_MIN / PROPS_AGING_MIN / PROPS_STALE_MIN /
   PROPS_EXEC_MAX_MIN / PROPS_LATEST_MAX_MIN (quote ages, minutes). Anything unset keeps the kernel's
   default. Returns an override object for EDProps.configureFreshness, or null. */
function parseCadence(raw) {
  if (!raw) return null;
  const tiers = String(raw).split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const [h, m] = t.split(':').map((x) => x.trim());
    const every = Number(m), within = h === '*' || h === '' ? null : Number(h);
    return Number.isFinite(every) && every > 0 && (within === null || (Number.isFinite(within) && within > 0)) ? { within_h: within, every_min: every } : null;
  });
  if (!tiers.length || tiers.some((t) => !t)) return null;
  tiers.sort((a, b) => (a.within_h == null ? Infinity : a.within_h) - (b.within_h == null ? Infinity : b.within_h));
  if (tiers[tiers.length - 1].within_h != null) tiers.push({ within_h: null, every_min: tiers[tiers.length - 1].every_min });
  return tiers;
}
function freshnessFromEnv(env) {
  env = env || process.env;
  const n = (k) => { const v = env[k]; if (v == null || String(v).trim() === '') return null; const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  const o = {}, q = {};
  if (n('PROPS_FRESH_MIN') != null) q.fresh_minutes = n('PROPS_FRESH_MIN');
  if (n('PROPS_AGING_MIN') != null) q.aging_minutes = n('PROPS_AGING_MIN');
  if (n('PROPS_STALE_MIN') != null) q.stale_minutes = n('PROPS_STALE_MIN');
  if (Object.keys(q).length) o.quote = q;
  if (n('PROPS_EXEC_MAX_MIN') != null) o.executable_max_minutes = n('PROPS_EXEC_MAX_MIN');
  if (n('PROPS_LATEST_MAX_MIN') != null) o.latest_max_minutes = n('PROPS_LATEST_MAX_MIN');
  const cad = parseCadence(env.PROPS_CADENCE);
  if (cad) o.cadence = cad;
  return Object.keys(o).length ? o : null;
}

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
    correlation: path.join(base, 'correlation.json'),
    performance: path.join(base, 'performance.json'),
    /* why each started BET / LEAN is still unsettled (football/props/grade.js) */
    settlement: path.join(base, 'settlement.json'),
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

module.exports = { ROOT, DIR, CACHE, LEAGUES, MARKET_GROUPS, DEFAULT_GROUPS, DEFAULTS, leaguePaths, seasonOf, parseCadence, freshnessFromEnv };

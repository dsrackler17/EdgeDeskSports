/* ===========================================================================
   Representative CFB fixtures for the intelligence regression suite.

   The published FBS slate is the REAL committed artifact — these tests run
   against the same bytes the board renders — with one extra matchup pushed
   onto the front so a named game (North Texas @ Texas State) is always on the
   card whatever week the artifact happens to hold.

   Everything else is a fixture shaped like the rows the live tables return,
   because this project has no live Supabase in CI. Which live checks that
   leaves unverified is stated in docs/intelligence.md.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/fbs/slate.json'), 'utf8'));
/* The REAL committed availability artifact. Its current contents are the
   finding these tests pin: 138 programs, zero verified records, no official
   report anywhere. A fixture with invented injuries would prove the opposite
   of what needs proving. */
const AVAIL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/availability/current.json'), 'utf8'));
/* The Slice 2 artifacts, real and committed: the compact matchup metrics
   (rankings detail, profiles, starters, coaching, the NFL injury report), the
   NFL slate the browser's own projection wrote through Node, and the venue
   forecasts. Each is served as-is; a test that needs one absent passes null. */
const METRICS = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/matchup/metrics.json'), 'utf8'));
const NFL_SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/nfl/slate.json'), 'utf8'));
const FORECASTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/venues/forecasts.json'), 'utf8'));
/* The Slice 3 identity profiles: the REAL committed team files for the four
   clubs the suites name, so the interaction engine is exercised on the
   shape the identity build writes. */
const IDENTITY = {};
['northtexas', 'texasstate', 'buf', 'det'].forEach(function (k) {
  try { IDENTITY[k] = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/identity/teams/' + k + '.json'), 'utf8')); } catch (_) { IDENTITY[k] = null; }
});
/* A live NFL injury report, as nflverse publishes it (CSV), for the two
   fixture clubs. Fresher than the committed artifact on purpose, and with
   one change (an OL out) so the investigation can be seen to update the
   packet rather than repeat it. */
function injuriesCsv(now) {
  const dt = new Date(now - 30 * 60000).toISOString();
  const rows = [
    ['2026', 'BUF', '3', '00-0040192', 'Jordan Hancock', 'CB', 'Questionable', 'Full Participation in Practice', 'Quadricep', dt],
    ['2026', 'BUF', '3', '00-0036355', 'Spencer Brown', 'T', 'Out', 'Did Not Participate In Practice', 'Ankle', dt],
    ['2026', 'DET', '3', '00-0033106', 'Jared Goff', 'QB', 'Questionable', 'Limited Participation in Practice', 'Ribs', dt],
    ['2026', 'DET', '3', '00-0031000', 'Taylor Decker', 'OT', 'Out', 'Did Not Participate In Practice', 'Shoulder', dt],
  ];
  return 'season,team,week,gsis_id,full_name,position,report_status,practice_status,report_primary_injury,date_modified\n' + rows.map(function (r) { return r.join(','); }).join('\n') + '\n';
}
/* An open-meteo answer for a college kickoff: the hourly block the function
   reads, wind and temperature at the kickoff hour. */
function openMeteo(now) {
  const hours = [], t = [], w = [], g = [], pp = [], pr = [], code = [];
  for (let i = 0; i < 24 * 8; i++) { const at = new Date(Math.floor(now / 3600000) * 3600000 + i * 3600000); hours.push(at.toISOString().slice(0, 16)); t.push(78.4); w.push(16.2); g.push(24.1); pp.push(35); pr.push(0.01); code.push(2); }
  return { latitude: 33.2, longitude: -97.16, hourly_units: { temperature_2m: '\u00b0F', wind_speed_10m: 'mp/h' }, hourly: { time: hours, temperature_2m: t, wind_speed_10m: w, wind_gusts_10m: g, precipitation_probability: pp, precipitation: pr, weather_code: code } };
}

/* Relative to the clock, so freshness is genuinely exercised. */
function build(now) {
  now = now || Date.now();
  const kickoff = new Date(now + 6 * 86400000).toISOString();

  const NT = {
    game_id: '401858900', season: 2026, week: 3, kickoff, neutral_site: false,
    venue: 'UFCU Stadium', home_team: 'Texas State', away_team: 'North Texas',
    home_team_id: 'texasstate', away_team_id: 'northtexas',
    home_conference: 'Sun Belt', away_conference: 'American Athletic',
    home_conference_id: 'sunbelt', away_conference_id: 'american',
    home_fbs_group: 'other', away_fbs_group: 'other',
    home_division: 'fbs', away_division: 'fbs',
    matchup_type: 'non_conference', is_conference_game: false,
    model_status: 'PREDICTED', model_home_margin: -2.4, model_home_line: 2.4,
    model_fair_total: 58.1, data_completeness: 0.55,
    spread_recommendation: 'NO_MARKET', market_status: 'NOT JOINED IN THIS BUILD', quote_timestamp: null,
  };
  const slate = Object.assign({}, SLATE, { games: [NT].concat(SLATE.games.slice(0, 6)) });
  /* One NFL game inside the window whatever the calendar says, on the front of
     the REAL committed NFL artifact, so the NFL card always carries a game the
     suites can name. The model fields are the shape the builder writes. */
  const NFLG = {
    game_id: 'nfl-fx-det-buf', season: 2026, week: 3, game_type: 'REG', kickoff: new Date(now + 6 * 86400000).toISOString(),
    home_code: 'BUF', away_code: 'DET', home_team: 'Buffalo Bills', away_team: 'Detroit Lions', home_team_id: 'buf', away_team_id: 'det',
    venue: 'Highmark Stadium', roof: 'outdoors', surface: 'a_turf', div_game: false, home_rest: 7, away_rest: 7,
    home_starter: { player_name: 'Josh Allen', player_id: '00-0034857', source: 'nflverse games.csv', status: 'SCHEDULE_FEED' },
    away_starter: { player_name: 'Jared Goff', player_id: '00-0033106', source: 'nflverse games.csv', status: 'SCHEDULE_FEED' },
    model_status: 'PREDICTED', model_home_margin: 5.2, model_home_line: -5.2, model_fair_total: 52.4, model_home_win_prob: 0.6867,
    outcome_range: { p10: -12, p50: 4, p90: 23, sigma: 10.7, basis: 'margin_pmf_by_spread', unit: 'home margin, points' },
    contributions: { spread: [{ key: 'baseline', value: 0, points: 2.48 }, { key: 'net_epa', value: 0.0811, points: 0.82 }, { key: 'net_pass', value: 0.1272, points: 1.59 }, { key: 'qb_adj_diff', value: -0.0094, points: -0.05 }], total: [] },
    data_quality: { status: 'OK', missing: [], warnings: [] }, model_version: NFL_SLATE.engine && NFL_SLATE.engine.model_version,
    reference_market: { source: 'nflverse games.csv consensus (reference, not a price, no book, no capture time)', home_line: -2.5, home_margin: 2.5, total: 49.5, home_ml: -140, away_ml: 120, convention: 'home_line: negative = home favoured (betting)' },
    market_status: 'NOT JOINED IN THIS BUILD',
  };
  /* The real card's Detroit and Buffalo games are left off so "the Lions at
     Buffalo" resolves to exactly one game whatever week the artifact is from. */
  const nflRest = NFL_SLATE.games.filter((g) => !/^(det|buf)$/i.test(String(g.home_team_id)) && !/^(det|buf)$/i.test(String(g.away_team_id))).slice(0, 6);
  const nfl = Object.assign({}, NFL_SLATE, { games: [NFLG].concat(nflRest) });

  const teams = [
    { team_id: 1, school: 'North Texas', mascot: 'Mean Green', abbreviation: 'UNT', conference: 'American Athletic', classification: 'fbs' },
    { team_id: 2, school: 'Texas State', mascot: 'Bobcats', abbreviation: 'TXST', conference: 'Sun Belt', classification: 'fbs' },
    { team_id: 3, school: 'Western Michigan', mascot: 'Broncos', abbreviation: 'WMU', conference: 'Mid-American', classification: 'fbs' },
    { team_id: 4, school: 'Nicholls', mascot: 'Colonels', abbreviation: 'NICH', conference: 'Southland', classification: 'fcs' },
    { team_id: 5, school: 'Washington State', mascot: 'Cougars', abbreviation: 'WSU', conference: 'Pac-12', classification: 'fbs' },
    { team_id: 6, school: 'Eastern Michigan', mascot: 'Eagles', abbreviation: 'EMU', conference: 'Mid-American', classification: 'fbs' },
  ];

  const D = (d) => new Date(now - d * 86400000).toISOString();
  const completed = [
    { game_id: 9001, season: 2026, week: 1, start_date: D(15), completed: true, neutral_site: false, conference_game: false, venue: 'Apogee', home_team: 'North Texas', home_points: 45, home_conference: 'American Athletic', away_team: 'Nicholls', away_points: 14, away_conference: 'Southland' },
    { game_id: 9002, season: 2026, week: 2, start_date: D(8), completed: true, neutral_site: false, conference_game: false, venue: 'Waldo', home_team: 'Western Michigan', home_points: 20, home_conference: 'Mid-American', away_team: 'North Texas', away_points: 31, away_conference: 'American Athletic' },
    { game_id: 9003, season: 2026, week: 1, start_date: D(16), completed: true, neutral_site: false, conference_game: false, venue: 'UFCU', home_team: 'Texas State', home_points: 38, home_conference: 'Sun Belt', away_team: 'Eastern Michigan', away_points: 17, away_conference: 'Mid-American' },
    { game_id: 9004, season: 2026, week: 2, start_date: D(8), completed: true, neutral_site: false, conference_game: false, venue: 'Martin', home_team: 'Washington State', home_points: 24, home_conference: 'Pac-12', away_team: 'Texas State', away_points: 21, away_conference: 'Sun Belt' },
  ];
  /* THE CROSS-CHECK AND THE LINE JOIN BOTH NEED THIS.
     cfb.games is what carries the CollegeFootballData game_id, and
     getSlateIndex joins it onto the artifact rows by team pair. Without a row
     per artifact game there is no cfb_game_id, so cfb.lines cannot be joined
     and the card comes back looking unpriced for a reason that is an artefact
     of the fixture rather than of the code. So every game on the card gets
     one, ids ascending from the North Texas game's own 9100. */
  const upcoming = slate.games.map((g, i) => ({
    game_id: 9100 + i, season: 2026, week: 3, start_date: g.kickoff || kickoff,
    completed: false, neutral_site: g.neutral_site === true, conference_game: g.is_conference_game === true,
    venue: g.venue || null,
    home_id: i === 0 ? 2 : 100 + i, home_team: g.home_team, home_conference: g.home_conference,
    away_id: i === 0 ? 1 : 200 + i, away_team: g.away_team, away_conference: g.away_conference,
  }));

  /* cfb.lines — CONSENSUS BOOK NUMBERS, THE OTHER HALF OF THE BOARD'S MARKET.
     A row here carries a spread, a total and two moneylines. It carries NO
     book, NO per-side spread odds and NO observation time, which is exactly
     why it is a number to research and never a price to bet into.

     The shape is the board's own: more games scheduled than carry a market
     number, and more carrying a market number than carry an executable price.
     Four of the seven are lined; only the game with a captured signal is
     priced; three carry nothing at all. Spreads are BETTING numbers (negative
     = home favourite) and are oriented against each game's real published
     model line, so the orientation guard is genuinely exercised rather than
     stepped around. */
  const lines = [
    { game_id: 9100, provider: 'consensus', spread: -2.5, over_under: 57.5, home_moneyline: -142, away_moneyline: 120 },
    { game_id: 9101, provider: 'consensus', spread: -19.5, over_under: 55.5, home_moneyline: -1100, away_moneyline: 750 },
    { game_id: 9102, provider: 'consensus', spread: 13.5, over_under: 56.5, home_moneyline: 420, away_moneyline: -560 },
    { game_id: 9103, provider: 'consensus', spread: -14, over_under: 54.5, home_moneyline: -620, away_moneyline: 450 },
  ];

  const ratings = [
    { season: 2026, team: 'North Texas', conference: 'American Athletic', rating: 6.4, ranking: 52, offense_rating: 31.2, offense_ranking: 28, defense_rating: 24.8, defense_ranking: 71, special_teams_rating: 0.3, sos: -2.1 },
    { season: 2026, team: 'Texas State', conference: 'Sun Belt', rating: 4.1, ranking: 64, offense_rating: 29.8, offense_ranking: 41, defense_rating: 25.7, defense_ranking: 80, special_teams_rating: -0.4, sos: 1.4 },
    { season: 2026, team: 'Western Michigan', conference: 'Mid-American', rating: -4.2, ranking: 98, offense_rating: 24.1, offense_ranking: 95, defense_rating: 28.3, defense_ranking: 102, special_teams_rating: 0.1, sos: -1.0 },
    { season: 2026, team: 'Nicholls', conference: 'Southland', rating: -18.9, ranking: null, offense_rating: 18.0, offense_ranking: null, defense_rating: 36.0, defense_ranking: null, special_teams_rating: 0, sos: -9.0 },
    { season: 2026, team: 'Washington State', conference: 'Pac-12', rating: 8.8, ranking: 44, offense_rating: 30.9, offense_ranking: 33, defense_rating: 22.1, defense_ranking: 49, special_teams_rating: 0.6, sos: 2.2 },
    { season: 2026, team: 'Eastern Michigan', conference: 'Mid-American', rating: -7.7, ranking: 112, offense_rating: 22.4, offense_ranking: 108, defense_rating: 30.1, defense_ranking: 110, special_teams_rating: -0.2, sos: -2.8 },
  ];
  const records = [
    { season: 2026, team: 'North Texas', total_wins: 2, total_losses: 0, total_ties: 0, conf_wins: 0, conf_losses: 0 },
    { season: 2026, team: 'Texas State', total_wins: 1, total_losses: 1, total_ties: 0, conf_wins: 0, conf_losses: 0 },
  ];
  const seasonStats = [
    { season: 2026, team: 'North Texas', stat_name: 'totalYards', stat_value: 1018 },
    { season: 2026, team: 'North Texas', stat_name: 'turnovers', stat_value: 2 },
    { season: 2026, team: 'Texas State', stat_name: 'totalYards', stat_value: 874 },
    { season: 2026, team: 'Texas State', stat_name: 'turnovers', stat_value: 4 },
  ];
  const rosterNT = [
    { first_name: 'Chandler', last_name: 'Morris', position: 'QB', jersey: 6, year: 4 },
    { first_name: 'Drew', last_name: 'Mestemaker', position: 'QB', jersey: 12, year: 2 },
  ];
  const rosterTX = [{ first_name: 'Jordan', last_name: 'McCloud', position: 'QB', jersey: 3, year: 5 }];

  /** One signal. `over` lets a test move the anchor, the clock or the price. */
  function signal(over) {
    return Object.assign({
      event_id: 'ev-nt-txst', sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF',
      market: 'spreads', selection: 'North Texas', point: -2.5,
      best_dec: 1.95, first_best_dec: 1.91, best_book: 'DraftKings',
      sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528,
      reference_type: 'sharp', reference_book: 'pinnacle',
      pin_dec: 1.88, pin_opp_dec: 2.02,
      edge: 0.037, first_edge: 0.016, n_books: 9, n_books_eff: 6, has_sharp: true,
      corrob_n: 2, corrob_ref: 'pinnacle', qual_tier: 'A', qual_reason: 'ok',
      quality_score: 78, fresh_books: 6,
      flagged_at: new Date(now - 14 * 60000).toISOString(), flagged_edge: 0.016,
      flagged_best_dec: 1.91, flagged_best_book: 'DraftKings',
      /* THE BOOK'S NAME, NOT THE SCHOOL'S — which is the whole point.
         The odds capture writes what the sportsbook calls the program; the
         college schedule writes the school alone. A fixture that used the
         school name here would pass against a join that compares normalised
         strings, which is the join that read 410 college rows and matched
         none of them. These names are the ones a book actually writes. */
      home_team: 'Texas State Bobcats', away_team: 'North Texas Mean Green', commence_time: kickoff,
      first_seen_at: new Date(now - 240 * 60000).toISOString(),
      last_seen_at: new Date(now - 14 * 60000).toISOString(),
      clv: null, beat_close: null, result: null, graded_at: null, closing_sharp_fair: null,
    }, over || {});
  }

  return { now, kickoff, slate, avail: AVAIL, metrics: METRICS, identity: IDENTITY, injuries_csv: injuriesCsv(now), open_meteo: openMeteo(now), nfl, forecasts: FORECASTS, teams, completed, upcoming, lines, ratings, records, seasonStats, rosterNT, rosterTX, signal };
}

/**
 * A fetch router over one fixture set.
 *   opts.signals  replaces the captured-signal list ([] = nothing priced)
 *   opts.lines    replaces the cfb.lines rows   ([] = no consensus numbers)
 *   opts.slate    replaces (or, with null, fails) the published artifact
 */
function router(fx, opts) {
  opts = opts || {};
  const signals = opts.signals === undefined ? [fx.signal()] : opts.signals;
  const lines = opts.lines === undefined ? fx.lines : opts.lines;
  return function (u) {
    /* AN ENTITLED READER. The function refuses to spend a model call for an
       account with no subscription, so every scenario needs one — and a
       scenario that wants to test the refusal passes opts.subscription. */
    if (u.indexOf('/subscriptions') >= 0) {
      if (opts.subscription === null) return [];
      return [opts.subscription || {
        status: 'active', price_id: 'price_test',
        current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
      }];
    }
    if (u.indexOf('/football/fbs/slate.json') >= 0) return opts.slate === null ? null : (opts.slate || fx.slate);
    /* The Slice 2 artifacts: the REAL committed files, because a fixture that
       agreed with itself would prove nothing about the shape the builds write. */
    if (u.indexOf('/football/matchup/metrics.json') >= 0) return opts.metrics === null ? null : (opts.metrics || fx.metrics);
    if (u.indexOf('/football/nfl/slate.json') >= 0) return opts.nfl === null ? null : (opts.nfl || fx.nfl);
    if (u.indexOf('/football/venues/forecasts.json') >= 0) return opts.forecasts === null ? null : (opts.forecasts || fx.forecasts);
    /* Slice 3: identity files, one per team, and the live providers the
       investigation may call. Each can be switched off per scenario. */
    var im = /\/football\/identity\/teams\/([a-z0-9]+)\.json/.exec(u);
    if (im) return opts.identity === null ? null : ((opts.identity && opts.identity[im[1]]) || fx.identity[im[1]] || null);
    if (u.indexOf('/football/identity/index.json') >= 0) return opts.identity === null ? null : { schema: 'edgedesk_team_identity_v1_index', season: 2026, teams: Object.keys(fx.identity) };
    if (/nflverse-data\/releases\/download\/injuries\/injuries_\d+\.csv/.test(u)) return opts.injuries_csv === null ? null : { __text: opts.injuries_csv || fx.injuries_csv };
    if (u.indexOf('api.open-meteo.com') >= 0) return opts.open_meteo === null ? null : (opts.open_meteo || fx.open_meteo);
    if (u.indexOf('api.search.brave.com') >= 0) return opts.search === undefined ? null : opts.search;
    if (u.indexOf('api.collegefootballdata.com') >= 0) return opts.cfbd === undefined ? null : opts.cfbd;
    if (u.indexOf('/football/availability/current.json') >= 0) {
      return opts.avail === null ? null : (opts.avail || fx.avail);
    }
    if (u.indexOf('/signals?') >= 0) return signals;
    /* cfb.lines is read with a chunked game_id=in.(...) filter, so the fixture
       honours the filter rather than returning the whole table: a router that
       ignores it would hide a broken filter. */
    if (u.indexOf('lines?') >= 0) {
      const m = /game_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(u));
      if (!m) return lines;
      const want = new Set(m[1].split(',').map((x) => x.trim()));
      return lines.filter((l) => want.has(String(l.game_id)));
    }
    if (u.indexOf('teams?') >= 0) return fx.teams;
    if (u.indexOf('ratings?') >= 0) return fx.ratings;
    if (u.indexOf('records?') >= 0) return fx.records;
    if (u.indexOf('team_season_stats?') >= 0) return fx.seasonStats;
    if (u.indexOf('roster?') >= 0) return /North%20Texas/.test(u) ? fx.rosterNT : (/Texas%20State/.test(u) ? fx.rosterTX : []);
    if (u.indexOf('games?') >= 0 && u.indexOf('completed=is.true') >= 0) return fx.completed;
    if (u.indexOf('games?') >= 0 && u.indexOf('completed=is.false') >= 0) return fx.upcoming;
    return [];
  };
}

/* The entitling row every scenario needs, so a suite that builds its own
   router does not accidentally test the paywall instead of the thing it meant
   to test. */
const SUBSCRIBED = [{ status: 'active', price_id: 'price_test',
  current_period_end: new Date(Date.now() + 30 * 864e5).toISOString() }];

module.exports = { build, router, SLATE, AVAIL, SUBSCRIBED, IDENTITY, injuriesCsv, openMeteo };

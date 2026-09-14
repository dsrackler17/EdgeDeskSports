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
  const upcoming = [{ game_id: 9100, season: 2026, week: 3, start_date: kickoff, completed: false, neutral_site: false, conference_game: false, venue: 'UFCU Stadium', home_id: 2, home_team: 'Texas State', home_conference: 'Sun Belt', away_id: 1, away_team: 'North Texas', away_conference: 'American Athletic' }];

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
      home_team: 'Texas State', away_team: 'North Texas', commence_time: kickoff,
      first_seen_at: new Date(now - 240 * 60000).toISOString(),
      last_seen_at: new Date(now - 14 * 60000).toISOString(),
      clv: null, beat_close: null, result: null, graded_at: null, closing_sharp_fair: null,
    }, over || {});
  }

  return { now, kickoff, slate, teams, completed, upcoming, ratings, records, seasonStats, rosterNT, rosterTX, signal };
}

/** A fetch router over one fixture set. `opts.signals` replaces the signal list. */
function router(fx, opts) {
  opts = opts || {};
  const signals = opts.signals === undefined ? [fx.signal()] : opts.signals;
  return function (u) {
    if (u.indexOf('/football/fbs/slate.json') >= 0) return opts.slate === null ? null : (opts.slate || fx.slate);
    if (u.indexOf('/signals?') >= 0) return signals;
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

module.exports = { build, router, SLATE };

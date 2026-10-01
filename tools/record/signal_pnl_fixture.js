'use strict';
/* ===========================================================================
   TEST DATA for the flagged-edge P&L suites (signal_pnl_sql.test.js,
   signal_pnl_ui.test.js). A seeded, invented history — never published,
   never a real recommendation — shaped like production's public.signals:

     four sports (one of them retired: tennis), three tiers (A, B, and an
     older flag with no tier), moneylines / spreads / totals with alternate
     lines on one side, prices sent as provider decimals rounded to 2 places,
     wins, losses, pushes, voids and cancellations, a flag whose price was
     never saved, one whose price is junk, a result nobody can read, games
     not played yet (some already stamped by close ~35 minutes before
     kickoff), and signals that were never flagged at all.

   buildSchema(db) creates the table the way production got it: the pre-v9
   shape, then the repository's own capture_v9_qualification.sql (which
   installs the flag-price freeze) and close_v7_parity.sql.
   =========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'edgedesk_edge_pnl.js'));

const SPORTS = [['americanfootball_nfl', 'NFL'], ['americanfootball_ncaaf', 'NCAAF'], ['baseball_mlb', 'MLB'], ['tennis_atp_us_open', 'ATP US Open']];
const TEAMS = ['Chiefs', 'Broncos', 'Jets', 'Dolphins', 'Georgia', 'Alabama', 'Yankees', 'Red Sox', 'Utah', 'BYU'];
const AMERICAN = [-250, -200, -150, -130, -120, -115, -110, -105, 100, 105, 110, 120, 130, 150, 175, 200, 250, 300];
const COLS = ['sig_key', 'event_id', 'sport_key', 'sport_title', 'commence_time', 'home_team', 'away_team', 'market', 'selection', 'point', 'flagged_at', 'flagged_edge',
  'flagged_best_dec', 'flagged_best_book', 'flagged_tier', 'flagged_policy', 'closed_at', 'closing_dec', 'closing_book', 'result', 'graded_at', 'first_best_dec', 'best_dec', 'last_seen_at'];

function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* the provider sends decimals rounded to 2 places: -110 arrives as 1.91 */
const dec2 = (a) => { const d = P.decimalOf(a); return d === null ? null : Math.round(d * 100) / 100; };

function signals(opts) {
  opts = opts || {};
  const NOW = opts.now || Date.now(), N = opts.n || 400, H = 3600e3, iso = (ms) => new Date(ms).toISOString();
  const R = rng(opts.seed || 20261001), pick = (a) => a[Math.floor(R() * a.length)];
  const out = [];
  for (let i = 0; i < N; i++) {
    const ev = Math.floor(i / 3), sp = SPORTS[ev % SPORTS.length];
    const home = TEAMS[ev % TEAMS.length], away = TEAMS[(ev + 3) % TEAMS.length];
    const market = ['h2h', 'spreads', 'totals'][ev % 3];
    const future = i >= N - 20;                                   // 20 flags on games not played yet
    const kick = future ? NOW + (i < N - 10 ? 0.33 * H : 72 * H) : NOW - (2 + (ev % 45)) * 24 * H;
    let selection, point = null;
    if (market === 'h2h') selection = i % 2 ? home : away;
    else if (market === 'spreads') { selection = home; point = -(2.5 + (i % 3) * 0.5); }   // alternate lines on one side
    else { selection = i % 2 ? 'Over' : 'Under'; point = 44.5 + (i % 3); }
    const am = pick(AMERICAN), u = R();
    const flagDec = u < 0.03 ? null : u < 0.04 ? 1 : dec2(am);    // 3% never captured, 1% junk
    const tierU = R(), tier = tierU < 0.5 ? 'A' : tierU < 0.85 ? 'B' : null;
    const edge = Math.round((0.001 + R() * 0.14) * 10000) / 10000;
    const closeDec = R() < 0.1 ? null : dec2(am + (R() < 0.5 ? -10 : 10));   // null when the move lands inside ±100
    const r = R();
    const result = future ? null : r < 0.46 ? 'win' : r < 0.92 ? 'loss' : r < 0.95 ? 'push' : r < 0.965 ? 'void' : r < 0.975 ? 'cancelled' : r < 0.99 ? null : 'tie';
    const closed = future ? (i < N - 10 ? NOW - 5 * 60e3 : null) : kick - 0.5 * H;
    out.push({
      sig_key: 'ev' + ev + '|' + market + '|' + selection + '|' + (point === null ? '' : point) + '|' + i,
      event_id: 'ev' + ev, sport_key: sp[0], sport_title: sp[1], commence_time: iso(kick), home_team: home, away_team: away,
      market, selection, point, flagged_at: iso(kick - 20 * H), flagged_edge: edge, flagged_best_dec: flagDec, flagged_best_book: pick(['DraftKings', 'FanDuel', 'BetMGM', 'Caesars']),
      flagged_tier: tier, flagged_policy: tier ? 'v9' : 'pre-v9-legacy', closed_at: closed === null ? null : iso(closed), closing_dec: closed === null ? null : closeDec,
      closing_book: 'Pinnacle', result, graded_at: result ? iso(kick + 4 * H) : null, first_best_dec: flagDec, best_dec: flagDec, last_seen_at: iso(kick - H)
    });
  }
  /* never flagged, settled anyway: must never get a P&L row */
  for (let i = 0; i < 20; i++) {
    out.push({ sig_key: 'unflagged|' + i, event_id: 'u' + i, sport_key: 'americanfootball_nfl', sport_title: 'NFL', commence_time: iso(NOW - 5 * 24 * H),
      home_team: 'A', away_team: 'B', market: 'h2h', selection: 'A', point: null, flagged_at: null, flagged_edge: null, flagged_best_dec: null,
      flagged_best_book: null, flagged_tier: null, flagged_policy: null, closed_at: iso(NOW - 5 * 24 * H), closing_dec: 1.9, closing_book: 'Pinnacle',
      result: 'win', graded_at: iso(NOW - 4 * 24 * H), first_best_dec: 1.95, best_dec: 1.95, last_seen_at: iso(NOW - 5 * 24 * H) });
  }
  return out;
}

function insertSql(rows, lit) {
  return 'insert into public.signals (' + COLS.join(', ') + ') values\n' +
    rows.map((s) => '(' + COLS.map((c) => (s[c] === null || s[c] === undefined ? 'NULL' : typeof s[c] === 'number' ? String(s[c]) : lit(s[c]))).join(', ') + ')').join(',\n') + ';';
}

const F = (n) => path.join(ROOT, 'supabase', n);
function buildSchema(db) {
  db.sql(`create table public.signals (
    id bigserial primary key, sig_key text unique not null,
    event_id text, sport_key text, sport_title text, commence_time timestamptz,
    home_team text, away_team text, market text, selection text, point numeric,
    last_seen_at timestamptz, best_dec numeric, best_book text,
    sharp_fair numeric, consensus_fair numeric, edge numeric,
    is_plus_ev boolean, n_books integer, has_sharp boolean,
    first_seen_at timestamptz, first_best_dec numeric, first_best_book text,
    first_sharp_fair numeric, first_edge numeric, first_has_sharp boolean,
    flagged_at timestamptz, flagged_edge numeric, flagged_best_dec numeric,
    flagged_best_book text, flagged_sharp_fair numeric, flagged_has_sharp boolean,
    graded_at timestamptz, result text, clv numeric, beat_close boolean,
    clv_excluded_reason text, closing_sharp_fair numeric, closed_at timestamptz);
  create table public.signal_ticks (id bigserial primary key, sig_key text not null, created_at timestamptz not null default now(),
    best_dec numeric, sharp_fair numeric, edge numeric, n_books integer);`);
  const a = db.applyFile(F('capture_v9_qualification.sql')), b = db.applyFile(F('close_v7_parity.sql'));
  return !/CHECK THIS/.test(a) && !/CHECK THIS/.test(b);
}

module.exports = { SPORTS, COLS, rng, dec2, signals, insertSql, buildSchema, F,
  FILES: { core: F('signal_pnl.sql'), summary: F('signal_pnl_summary.sql'), sync: F('signal_pnl_sync.sql'), backfill: F('signal_pnl_backfill.sql') } };

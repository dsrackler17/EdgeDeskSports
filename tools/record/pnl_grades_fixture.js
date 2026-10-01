'use strict';
/* ===========================================================================
   TEST DATA for the edge P&L (supabase/pnl_grades*.sql). Never published,
   never committed anywhere but here.

   A signals table in the shape production built it (the pre-v9 columns of
   tools/capture/migration.test.js, then the real capture_v9_qualification.sql
   and close_v7_parity.sql), and 80 flagged + 10 unflagged rows that cover
   every sport (tennis as the retired one), market, tier, book, result and
   price case — including a flag with no price and one with an impossible
   price, so "missing prices are not estimated" is exercised, not assumed.

   Used by tools/record/pnl_grades_sql.test.js (the database) and
   tools/record/edge_pnl_ui.test.js (the pages), so both read the same rows.
   =========================================================================== */
const path = require('path');

const SIGNALS_DDL = `create table public.signals (
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
  best_dec numeric, sharp_fair numeric, edge numeric, n_books integer);
grant select, insert, update on public.signals to service_role;`;

const PNL_FILES = ['pnl_grades.sql', 'pnl_grades_sync.sql', 'pnl_grades_analytics.sql'];

const SPORTS = [['americanfootball_nfl', 'NFL'], ['americanfootball_ncaaf', 'NCAAF'], ['baseball_mlb', 'MLB']];
const BOOKS = ['DraftKings', 'FanDuel', 'Bovada', 'BetMGM', 'Pinnacle', 'LowVig.ag'];
const DECS = [1.91, 2.5, 1.87, 2.05, 1.67, 3.4, 1.53, 2.2];
const RESULTS = ['win', 'loss', 'win', 'push', 'loss', 'void', null, 'W', 'pending'];
const EDGES = [0.004, 0.012, 0.025, 0.031, 0.045, 0.08];
const BASE = Date.parse('2026-09-01T17:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function seed(i) {
  const tennis = i % 10 === 9;
  const [sk, st] = tennis ? ['tennis_atp_us_open', 'ATP US Open'] : SPORTS[i % 3];
  const markets = sk === 'americanfootball_nfl' ? ['h2h', 'spreads', 'totals', 'player_pass_yds'] : ['h2h', 'spreads', 'totals'];
  const market = markets[i % markets.length];
  const tier = i % 7 === 0 ? null : (i % 3 === 0 ? 'B' : 'A');
  const dec = i % 11 === 0 ? null : (i === 13 ? 1 : DECS[i % 8]);
  const res = RESULTS[i % 9];
  const future = res === null && i % 2 === 0;
  const commence = future ? Date.parse('2026-12-01T18:00:00Z') + i * 3600e3 : BASE + i * 7 * 3600e3;
  const settled = res !== null && res !== 'pending';
  const sel = market === 'totals' ? (i % 2 ? 'Over' : 'Under') : (market === 'player_pass_yds' ? 'Over' : 'Team ' + String.fromCharCode(65 + (i % 20)));
  const point = market === 'h2h' ? null : (market === 'totals' ? 44.5 + (i % 5) : (market === 'player_pass_yds' ? 249.5 : (i % 2 ? -3.5 : 6.5)));
  return {
    sig_key: 'ev' + i + '|' + market + '|' + sel + '|' + (point == null ? '' : point),
    event_id: 'ev' + i, sport_key: sk, sport_title: st, commence_time: iso(commence),
    home_team: 'Home ' + i, away_team: 'Away ' + i, market, selection: sel, point,
    participant: market === 'player_pass_yds' ? 'Player ' + i : null,
    best_dec: dec, first_best_dec: dec == null ? 1.95 : dec, flagged_at: iso(commence - 26 * 3600e3),
    flagged_edge: EDGES[i % 6], flagged_best_dec: dec, flagged_best_book: BOOKS[(i * 5) % 6],
    flagged_tier: tier, flagged_reference_type: tier == null ? null : (tier === 'B' ? 'robust_consensus' : (i % 4 === 0 ? 'robust_consensus' : 'sharp')),
    flagged_fresh_books: 3 + (i % 5), flagged_policy: tier == null ? 'pre-v9-legacy' : 'capture-v9',
    result: res, graded_at: settled ? iso(commence + 3 * 3600e3) : null,
    closing_dec: i % 5 === 0 || dec == null ? null : Math.round(dec * 0.97 * 100) / 100
  };
}
const FLAGGED = Array.from({ length: 80 }, (_, i) => seed(i));
const UNFLAGGED = Array.from({ length: 10 }, (_, i) => Object.assign(seed(100 + i), {
  sig_key: 'unf' + i, flagged_at: null, flagged_edge: null, flagged_best_dec: null, flagged_tier: null, result: 'win', graded_at: iso(BASE)
}));
const COLS = Object.keys(FLAGGED[0]);

function insertSql(rows, lit) {
  return 'insert into public.signals (' + COLS.join(', ') + ') values ' + rows.map((r) => '(' + COLS.map((c) => {
    const v = r[c];
    if (v == null) return 'null';
    if (typeof v === 'number') return String(v);
    return lit(v);
  }).join(', ') + ')').join(',\n') + ';';
}

/* the whole database, ready to read: production's migrations, history, the
   three P&L files, the committed backfill */
function install(db, PG) {
  const SUP = (f) => path.join(PG.ROOT, 'supabase', f);
  db.sql(SIGNALS_DDL);
  db.applyFileAtomic(SUP('capture_v9_qualification.sql'));
  db.applyFileAtomic(SUP('close_v7_parity.sql'));
  db.sql('alter table public.signals add column if not exists participant text;');
  db.sql(insertSql(FLAGGED.concat(UNFLAGGED), PG.lit));
  PNL_FILES.forEach((f) => db.applyFileAtomic(SUP(f)));
  db.sql('select count(*) from public.pnl_grades_backfill(true);');
}

module.exports = { SIGNALS_DDL, PNL_FILES, FLAGGED, UNFLAGGED, COLS, seed, insertSql, install };

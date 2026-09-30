#!/usr/bin/env node
/* ===========================================================================
   supabase/model_pnl.sql + model_pnl_analytics.sql, AGAINST A REAL
   POSTGRESQL, AS REAL READERS.

   Proves, by acting as the service role, reader A, reader B and anon:
     - both files apply twice, every report row ok; the analytics file refuses
       to run before the table exists;
     - model_pnl_upsert is idempotent: a second call inserts nothing and
       updates nothing; P&L is DERIVED from the row's own price, stake and
       result and equals lib/edgedesk_pnl.js to the cent;
     - no captured price (or a malformed one, or an assumed one) → no P&L,
       and no client can store one;
     - a corrected settlement updates the same row and is logged, once; the
       recommendation half cannot be rewritten; nothing can be deleted;
     - the rollups and the drawdown equal the kernel's (parity);
     - anon reads the public view only; a reader's dollars come from their
       own bankroll row and never from anyone else's.

   Run: node tools/record/pnl_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const PNL = require(path.join(PG.ROOT, 'lib', 'edgedesk_pnl.js'));

const T = PG.kit('model_pnl SQL');
const chk = T.chk;
const CORE = path.join(PG.ROOT, 'supabase', 'model_pnl.sql'), ANA = path.join(PG.ROOT, 'supabase', 'model_pnl_analytics.sql');
[['model_pnl.sql', fs.readFileSync(CORE, 'utf8')], ['model_pnl_analytics.sql', fs.readFileSync(ANA, 'utf8')]].forEach(([n, s]) => {
  chk(n + ': no psql meta-commands', !/^\\/m.test(s));
  chk(n + ': idempotent create statements', /create or replace (function|view)/.test(s) && (/create table if not exists/.test(s) || /create materialized view if not exists/.test(s)));
  chk(n + ': additive — nothing is dropped', !/\bdrop table\b/i.test(s) && !/\bdrop column\b/i.test(s) && !/\bdrop view\b/i.test(s));
  chk(n + ': it ends in a report', /CHECK THIS/.test(s) && /order by 1;\s*$/.test(s));
  chk(n + ': PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(s));
  chk(n + ': under the SQL editor paste limit (18 KB)', Buffer.byteLength(s) <= 18000, Buffer.byteLength(s));
});

const db = PG.start('pnl');
if (db.skip) {
  if (process.env.PNL_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
const lit = PG.lit;
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';

/* ledger rows, as tools/record/pnl_ledger.js writes them */
function row(i, o) {
  return PNL.settle(Object.assign({
    recommendation_id: 'pp:t' + i, source: 'player_props', source_ref: { file: 'x', id: 't' + i }, sport: 'football', league: 'NFL', season: 2026, week: 3,
    event_id: '2026_03_KC_DEN', event_label: 'KC @ DEN', game_date: '2026-09-' + String(10 + i).padStart(2, '0') + 'T17:00:00.000Z', model_version: 'edgedesk_props_model_v1',
    market_group: 'prop', market_type: 'player_prop', prop_market: 'pass_yds', prop_label: 'Passing Yards', prop_category: 'passing', player_id: '00-0033873', player_name: 'Patrick Mahomes',
    side: 'over', selection: 'Over 276.5', model_line: 284.1, entry_line: 276.5, entry_odds: -110, entry_book: 'draftkings', price_assumed: false, model_prob: 0.56, model_edge_pct: 3.1,
    rec_class: 'BET', stake_units: 0.5, recommended_at: '2026-09-0' + ((i % 9) + 1) + 'T12:00:00.000Z', odds_captured_at: '2026-09-01T12:00:00.000Z', evaluation_mode: 'LIVE',
    result: 'win', result_value: 300, closing_line: 278.5, clv_points: 2, beat_close: true, settled_at: '2026-09-25T09:00:00.000Z', corrections: [], corrected: false
  }, o));
}
const ROWS = [
  row(1),
  row(2, { result: 'loss', entry_odds: 150, stake_units: 0.25, clv_points: -1, beat_close: false, model_edge_pct: 5.5 }),
  row(3, { result: 'win', entry_odds: -150, stake_units: 1, league: 'CFB', event_id: '401900001', market_group: 'game', market_type: 'spread', source: 'bettor_decision', recommendation_id: 'bd:t3', side: 'home', selection: 'Utah -6.5', prop_market: null, player_id: null, clv_points: 1, beat_close: true, model_edge_pct: 1.5 }),
  row(4, { result: 'push', entry_odds: -110, stake_units: 0.75, clv_points: 0, beat_close: null }),
  row(5, { result: 'loss', entry_odds: -105, stake_units: 1, league: 'CFB', event_id: '401900002', market_group: 'game', market_type: 'total', source: 'bettor_decision', recommendation_id: 'bd:t5', side: 'under', selection: 'Under 44.5', prop_market: null, player_id: null, clv_points: -0.5, beat_close: false, model_edge_pct: 8 }),
  row(6, { result: 'win', entry_odds: 135, stake_units: 1, market_group: 'game', market_type: 'moneyline', source: 'bettor_decision', recommendation_id: 'bd:t6', side: 'home', selection: 'Denver Broncos ML', prop_market: null, player_id: null, model_version: 'edgedesk_football_v1.1.0', clv_points: null, beat_close: null, model_edge_pct: 2.5 }),
  row(7, { rec_class: 'LEAN', stake_units: 0, result: 'win', entry_odds: -120 }),
  row(8, { result: 'pending', settled_at: null, result_value: null }),
  row(9, { result: 'void', settled_at: '2026-09-25T09:00:00.000Z' }),
  row(10, { recommendation_id: 'mr:nfl:g10:spread', source: 'model_record', rec_class: 'MODEL', stake_units: 0, entry_odds: null, market_group: 'game', market_type: 'spread', selection: 'DEN +3.5', side: 'home', prop_market: null, player_id: null, result: 'loss', evaluation_mode: 'LIVE_RECONSTRUCTED' })
];

try {
  const noDep = db.mustFail(() => db.applyFileAtomic(ANA));
  chk('the analytics file without model_pnl.sql stops and names the file', /model_pnl\.sql/.test(noDep || ''), noDep && noDep.slice(0, 200));
  let out = db.applyFileAtomic(CORE);
  chk('model_pnl.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(db.applyFileAtomic(CORE)));
  out = db.applyFileAtomic(ANA);
  chk('model_pnl_analytics.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(ANA)));
  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com'), ('${B}','b@example.com');`);

  /* ── the one writer, idempotent ─────────────────────────────────────── */
  const up = (rows) => JSON.parse(db.service(`select public.model_pnl_upsert(${J(rows)});`));
  let r1 = up(ROWS);
  chk('the upsert inserts every row', r1.inserted === ROWS.length && r1.refused.length === 0, r1);
  let r2 = up(ROWS);
  chk('settling twice writes nothing twice', r2.inserted === 0 && r2.updated === 0 && r2.unchanged === ROWS.length, r2);
  chk('one row per recommendation', db.sql('select count(*), count(distinct recommendation_id) from public.model_pnl;') === ROWS.length + '|' + ROWS.length);

  /* ── the P&L is derived, and equals the kernel ─────────────────────── */
  const got = {};
  db.sql("select recommendation_id || '|' || pnl_status || '|' || coalesce(flat_profit_units::text, 'null') || '|' || coalesce(profit_units::text, 'null') || '|' || coalesce(implied_prob::text, 'null') from public.model_pnl;")
    .split('\n').forEach((l) => { const p = l.split('|'); got[p[0]] = { st: p[1], flat: p[2] === 'null' ? null : +p[2], staked: p[3] === 'null' ? null : +p[3], ip: p[4] === 'null' ? null : +p[4] }; });
  chk('every row\'s status, flat and staked P&L equal lib/edgedesk_pnl.js', ROWS.every((x) => got[x.recommendation_id].st === x.pnl_status && got[x.recommendation_id].flat === x.flat_profit_units && got[x.recommendation_id].staked === x.profit_units),
    ROWS.map((x) => [x.recommendation_id, x.pnl_status, x.flat_profit_units, x.profit_units, got[x.recommendation_id]]).filter((a) => a[1] !== a[4].st || a[2] !== a[4].flat || a[3] !== a[4].staked));
  chk('-110 winner at 0.50u: +0.9091 flat, +0.4545 staked', got['pp:t1'].flat === 0.9091 && got['pp:t1'].staked === 0.4545);
  chk('+150 loser at 0.25u: -1 / -0.25', got['pp:t2'].flat === -1 && got['pp:t2'].staked === -0.25);
  chk('-150 winner at 1u: +0.6667', got['bd:t3'].flat === 0.6667 && got['bd:t3'].staked === 0.6667);
  chk('push 0, void 0 (VOID), pending null', got['pp:t4'].flat === 0 && got['pp:t9'].st === 'VOID' && got['pp:t9'].flat === 0 && got['pp:t8'].flat === null);
  chk('the model record row: NO_ENTRY_PRICE, no P&L', got['mr:nfl:g10:spread'].st === 'NO_ENTRY_PRICE' && got['mr:nfl:g10:spread'].flat === null);
  chk('implied probability of -110 is stamped', got['pp:t1'].ip === 0.5238);

  /* ── no client can store an invented figure ─────────────────────────── */
  db.service("update public.model_pnl set flat_profit_units = 50, profit_units = 50 where recommendation_id = 'pp:t1';");
  chk('a written profit is re-derived from the price (the trigger ignores it)', db.sql("select flat_profit_units from public.model_pnl where recommendation_id = 'pp:t1';") === '0.9091');
  db.service("update public.model_pnl set flat_profit_units = 1 where recommendation_id = 'mr:nfl:g10:spread';");
  chk('a row with no price keeps no P&L, whatever is written', db.sql("select coalesce(flat_profit_units::text, 'null') from public.model_pnl where recommendation_id = 'mr:nfl:g10:spread';") === 'null');
  let r3 = up([row(11, { entry_odds: 0 }), row(12, { entry_odds: 50 }), row(13, { entry_odds: 'abc' }), row(14, { entry_odds: -110, price_assumed: true })]);
  chk('malformed odds are refused as odds and kept as text', r3.inserted === 4 && db.sql("select string_agg(recommendation_id || ':' || pnl_status || ':' || coalesce(entry_odds::text, 'null') || ':' || coalesce(entry_odds_raw, 'null'), ',' order by recommendation_id) from public.model_pnl where recommendation_id in ('pp:t11','pp:t12','pp:t13');") === 'pp:t11:INVALID_PRICE:null:0,pp:t12:INVALID_PRICE:null:50,pp:t13:INVALID_PRICE:null:abc', r3);
  chk('an assumed price is SIMULATED, never P&L', db.sql("select pnl_status || ':' || coalesce(flat_profit_units::text, 'null') from public.model_pnl where recommendation_id = 'pp:t14';") === 'SIMULATED_PRICE:null');
  chk('a negative stake is refused', db.mustFail(() => db.service(`insert into public.model_pnl (recommendation_id, source, league, event_id, market_group, market_type, selection, rec_class, stake_units, entry_odds) values ('neg','player_props','NFL','g','prop','player_prop','Over 1.5','BET',-1,-110);`)) !== null);
  chk('odds of 0 cannot be written directly', db.mustFail(() => db.service(`insert into public.model_pnl (recommendation_id, source, league, event_id, market_group, market_type, selection, rec_class, entry_odds) values ('zero','player_props','NFL','g','prop','player_prop','Over 1.5','LEAN',0);`)) !== null);

  /* ── corrections ────────────────────────────────────────────────────── */
  const fixed = ROWS.map((x) => (x.recommendation_id === 'pp:t1' ? Object.assign({}, x, { result: 'loss', result_value: 270, corrections: [{ at: '2026-09-26T00:00:00Z', reason: 'official statistic changed: 300 → 270', fields: {} }] }) : x));
  let r4 = up(fixed);
  chk('a corrected player stat updates the same row', r4.updated === 1 && r4.inserted === 0, r4);
  chk('the row carries the corrected P&L', db.sql("select result || ':' || flat_profit_units || ':' || profit_units || ':' || corrected || ':' || correction_count from public.model_pnl where recommendation_id = 'pp:t1';") === 'loss:-1:-0.5:true:1');
  const log = db.sql("select changed::text || '|' || reason from public.model_pnl_corrections where recommendation_id = 'pp:t1';");
  chk('the correction is logged: from, to and why', /"result": \{"to": "loss", "from": "win"\}/.test(log) && /300 → 270/.test(log), log);
  chk('re-sending the corrected ledger logs nothing more', up(fixed).updated === 0 && db.sql("select count(*) from public.model_pnl_corrections where recommendation_id = 'pp:t1';") === '1');
  const scoreFix = fixed.map((x) => (x.recommendation_id === 'mr:nfl:g10:spread' ? Object.assign({}, x, { result: 'win', final_score: '20–24' }) : x));
  chk('a corrected final score on a record-only row is logged too', up(scoreFix).updated === 1 && db.sql("select corrected || ':' || coalesce(flat_profit_units::text, 'null') from public.model_pnl where recommendation_id = 'mr:nfl:g10:spread';") === 'true:null');
  const settleNew = scoreFix.map((x) => (x.recommendation_id === 'pp:t8' ? Object.assign({}, x, { result: 'win', settled_at: '2026-09-26T09:00:00Z', result_value: 290 }) : x));
  chk('a pending row settling is not a correction', up(settleNew).updated === 1 && db.sql("select corrected || ':' || flat_profit_units from public.model_pnl where recommendation_id = 'pp:t8';") === 'false:0.9091');
  const bad = settleNew.map((x) => (x.recommendation_id === 'pp:t2' ? Object.assign({}, x, { entry_odds: 200, result: 'win' }) : x));
  const r5 = up(bad);
  chk('a batch that would rewrite a recorded price is refused for that row, named', r5.refused.length === 1 && r5.refused[0].recommendation_id === 'pp:t2' && /frozen/.test(r5.refused[0].error), r5);
  chk('and the recorded price and result stand', db.sql("select entry_odds || ':' || result from public.model_pnl where recommendation_id = 'pp:t2';") === '150:loss');
  chk('a delete is refused', db.mustFail(() => db.service("delete from public.model_pnl where recommendation_id = 'pp:t2';")) !== null);
  chk('a truncate is refused', db.mustFail(() => db.service('truncate public.model_pnl cascade;')) !== null);
  chk('the correction log cannot be edited', db.mustFail(() => db.service("update public.model_pnl_corrections set reason = 'x';")) !== null);

  /* ── parity: the rollups and the drawdown equal the kernel ──────────── */
  const now = settleNew.map((x) => PNL.settle(x));
  const bets = now.filter((x) => x.rec_class === 'BET');
  ['flat', 'staked'].forEach((mode) => {
    const k = PNL.summarize(bets, mode);
    const s = db.sql(`select bets || '|' || wins || '|' || losses || '|' || pushes || '|' || net_units || '|' || risked_units || '|' || coalesce(roi_pct::text,'') || '|' || coalesce(win_rate_pct::text,'') || '|' || coalesce(break_even_pct::text,'') || '|' || coalesce(avg_clv_points::text,'') || '|' || coalesce(clv_hit_rate_pct::text,'') || '|' || coalesce(profit_factor::text,'') from public.model_pnl_rollup('${mode}', 'all');`).split('|');
    chk(mode + ': SQL bets / W / L / P equal the kernel', +s[0] === k.n && +s[1] === k.wins && +s[2] === k.losses && +s[3] === k.pushes, [s, k.n, k.record]);
    chk(mode + ': SQL net units equal the kernel', +s[4] === k.net_units, [s[4], k.net_units]);
    chk(mode + ': SQL risked equals the kernel', +s[5] === k.risked_units, [s[5], k.risked_units]);
    chk(mode + ': SQL ROI (net ÷ risked × 100) equals the kernel', +s[6] === k.roi_pct, [s[6], k.roi_pct]);
    chk(mode + ': SQL win rate equals the kernel', +s[7] === k.win_rate_pct, [s[7], k.win_rate_pct]);
    chk(mode + ': SQL break-even equals the kernel', +s[8] === k.break_even_pct, [s[8], k.break_even_pct]);
    chk(mode + ': SQL average CLV equals the kernel', +s[9] === k.avg_clv_points, [s[9], k.avg_clv_points]);
    chk(mode + ': SQL CLV hit rate equals the kernel', +s[10] === k.clv_hit_rate_pct, [s[10], k.clv_hit_rate_pct]);
    chk(mode + ': SQL profit factor equals the kernel', (s[11] === '' ? null : +s[11]) === k.profit_factor, [s[11], k.profit_factor]);
    const d = db.sql(`select bets || '|' || net_units || '|' || peak_units || '|' || max_drawdown_units || '|' || current_drawdown_units from public.model_pnl_drawdown('${mode}', 'all');`).split('|');
    chk(mode + ': SQL drawdown equals the kernel (max, peak, current)', +d[0] === k.n && +d[1] === k.net_units && +d[2] === k.peak_profit_units && +d[3] === Math.round(k.max_drawdown_units * 100) / 100 && +d[4] === Math.round(k.current_drawdown_units * 100) / 100, [d, k.max_drawdown_units, k.peak_profit_units, k.current_drawdown_units]);
  });
  const byLeague = db.sql("select string_agg(group_key || ':' || bets || ':' || net_units, ',' order by group_key) from public.model_pnl_rollup('flat', 'league');");
  const kb = PNL.breakdown(bets, (x) => x.league, 'flat').map((x) => x.key + ':' + x.n + ':' + x.net_units).join(',');
  chk('by league: SQL equals the kernel breakdown', byLeague === kb, [byLeague, kb]);
  chk('scopes: props only', +db.sql("select bets from public.model_pnl_rollup('flat', 'all', 'props');") === bets.filter((x) => x.market_group === 'prop' && x.pnl_status === 'VERIFIED').length);
  chk('the LEAN is not a bet, but can be read as its own class', +db.sql("select bets from public.model_pnl_rollup('flat', 'all', 'all', 'LEAN');") === 1);

  /* ── the cached daily series ────────────────────────────────────────── */
  db.service('select public.model_pnl_refresh();');
  const last = db.sql("select cum_units from public.model_pnl_daily where scope = 'all' and mode = 'flat' order by day desc limit 1;");
  chk('the daily series ends at the net', Math.abs(+last - PNL.summarize(bets, 'flat').net_units) < 0.01, [last]);
  chk('anon reads the daily series', +db.anon("select count(*) from public.model_pnl_daily;") > 0);
  chk('anon cannot refresh it', db.mustFail(() => db.anon('select public.model_pnl_refresh();')) !== null);

  /* ── who reads what ─────────────────────────────────────────────────── */
  chk('anon cannot read the table', db.mustFail(() => db.anon('select count(*) from public.model_pnl;')) !== null);
  chk('a signed-in reader cannot read the table either', db.mustFail(() => db.as(A, 'select count(*) from public.model_pnl;')) !== null);
  chk('anon reads the public view', +db.anon('select count(*) from public.model_pnl_public;') === 14);
  chk('the public view carries no internal fields', db.mustFail(() => db.anon('select entry_odds_raw from public.model_pnl_public;')) !== null);
  chk('anon reads the corrections', +db.anon('select count(*) from public.model_pnl_corrections_public;') >= 2);
  chk('anon cannot write', db.mustFail(() => db.anon(`select public.model_pnl_upsert(${J([row(20)])});`)) !== null);
  chk('a signed-in reader cannot write', db.mustFail(() => db.as(A, `select public.model_pnl_upsert(${J([row(21)])});`)) !== null);
  chk('nor insert directly', db.mustFail(() => db.as(A, "insert into public.model_pnl (recommendation_id, source, league, event_id, market_group, market_type, selection, rec_class) values ('x','player_props','NFL','g','prop','player_prop','Over 1','LEAN');")) !== null);
  chk('anon calls the rollups', +db.anon("select bets from public.model_pnl_rollup('flat', 'all');") > 0);

  /* ── the real committed ledger passes every constraint ─────────────── */
  {
    const SY = require('./pnl_sync.js');
    const lf = fs.readdirSync(path.join(PG.ROOT, 'record', 'pnl')).filter((f) => /^ledger_\d{4}\.json$/.test(f)).sort().pop();
    if (lf) {
      const real = SY.tableRows(JSON.parse(fs.readFileSync(path.join(PG.ROOT, 'record', 'pnl', lf), 'utf8')));
      const rr = up(real);
      chk('the committed ledger (' + lf + ', ' + real.length + ' rows) is accepted row for row', rr.inserted === real.length && rr.refused.length === 0, rr.refused.slice(0, 3));
      chk('and synced again, it is unchanged', up(real).unchanged === real.length);
      chk('the database derives the same P&L status for every real row', db.sql("select count(*) from public.model_pnl m where m.recommendation_id = any(" + lit('{' + real.map((x) => '"' + x.recommendation_id + '"').join(',') + '}') + "::text[]) and m.pnl_status is distinct from (" + J(Object.fromEntries(real.map((x) => [x.recommendation_id, x.pnl_status]))) + " ->> m.recommendation_id);") === '0');
    }
  }

  /* ── dollars: the reader's own unit, nobody else's ──────────────────── */
  db.sql(`create table public.bankroll_settings (user_id uuid primary key default auth.uid(), bankroll_amount numeric, base_unit_amount numeric, unit_mode text not null default 'percent', unit_percent numeric not null default 0.01);
    alter table public.bankroll_settings enable row level security;
    create policy bankroll_own on public.bankroll_settings for select to authenticated using (user_id = auth.uid());
    grant select on public.bankroll_settings to authenticated;
    insert into public.bankroll_settings (user_id, base_unit_amount, unit_mode) values ('${A}', 25, 'fixed');
    insert into public.bankroll_settings (user_id, bankroll_amount, unit_mode, unit_percent) values ('${B}', 1000, 'percent', 0.02);`);
  const net = PNL.summarize(bets, 'flat').net_units;
  const da = db.as(A, "select unit_value || '|' || basis || '|' || net_dollars from public.model_pnl_my_dollars('flat', 'all');").split('|');
  chk('reader A: a $25 custom unit, net in dollars', +da[0] === 25 && da[1] === 'CUSTOM' && Math.abs(+da[2] - Math.round(net * 25 * 100) / 100) < 0.011, [da, net]);
  const dbb = db.as(B, "select unit_value || '|' || basis || '|' || net_dollars from public.model_pnl_my_dollars('flat', 'all');").split('|');
  chk('reader B: 2% of a $1,000 bankroll = $20', +dbb[0] === 20 && dbb[1] === 'PERCENT', dbb);
  const C = '00000000-0000-0000-0000-00000000000c';
  chk('a reader with no bankroll gets units only, never a default dollar amount', db.as(C, "select coalesce(unit_value::text, 'null') || '|' || basis || '|' || coalesce(net_dollars::text, 'null') from public.model_pnl_my_dollars('flat', 'all');") === 'null|NOT_SET|null');
  chk('anon cannot ask for dollars', db.mustFail(() => db.anon("select * from public.model_pnl_my_dollars('flat', 'all');")) !== null);
  chk('reader A cannot see reader B\'s bankroll', db.as(A, 'select count(*) from public.bankroll_settings;') === '1');
} finally {
  db.stop();
}
process.exit(T.done());

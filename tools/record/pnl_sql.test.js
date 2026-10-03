#!/usr/bin/env node
/* ===========================================================================
   supabase/model_pnl.sql + model_pnl_states.sql + model_pnl_analytics.sql,
   AGAINST A REAL POSTGRESQL, AS REAL READERS.

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
       own bankroll row and never from anyone else's;
     - every row resolves to ONE state (record_state) exactly as the kernel
       derives it; the build's pending reasons land through
       model_pnl_reasons() only; the canonical record view is the table,
       normalized, and the committed ledger lands with the same states.

   Run: node tools/record/pnl_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const PNL = require(path.join(PG.ROOT, 'lib', 'edgedesk_pnl.js'));

const T = PG.kit('model_pnl SQL');
const chk = T.chk;
const CORE = path.join(PG.ROOT, 'supabase', 'model_pnl.sql'), ANA = path.join(PG.ROOT, 'supabase', 'model_pnl_analytics.sql'), STA = path.join(PG.ROOT, 'supabase', 'model_pnl_states.sql');
const VER = path.join(PG.ROOT, 'supabase', 'model_pnl_verified.sql'), VIEWS = path.join(PG.ROOT, 'supabase', 'model_pnl_verified_views.sql');
const QUO = path.join(PG.ROOT, 'supabase', 'model_pnl_quotes.sql');
[['model_pnl.sql', fs.readFileSync(CORE, 'utf8')], ['model_pnl_states.sql', fs.readFileSync(STA, 'utf8')], ['model_pnl_analytics.sql', fs.readFileSync(ANA, 'utf8')],
  ['model_pnl_verified.sql', fs.readFileSync(VER, 'utf8')], ['model_pnl_quotes.sql', fs.readFileSync(QUO, 'utf8')], ['model_pnl_verified_views.sql', fs.readFileSync(VIEWS, 'utf8')]].forEach(([n, s]) => {
  chk(n + ': no psql meta-commands', !/^\\/m.test(s));
  chk(n + ': idempotent create statements', /create or replace (function|view)/.test(s) && (/create table if not exists/.test(s) || /create materialized view if not exists/.test(s) || /add column if not exists/.test(s) || /create index if not exists/.test(s)));
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

let tail = null;
try {
  const noDep = db.mustFail(() => db.applyFileAtomic(ANA));
  chk('the analytics file without model_pnl.sql stops and names the file', /model_pnl\.sql/.test(noDep || ''), noDep && noDep.slice(0, 200));
  const noDepS = db.mustFail(() => db.applyFileAtomic(STA));
  chk('the states file without model_pnl.sql stops and names the file', /model_pnl\.sql/.test(noDepS || ''), noDepS && noDepS.slice(0, 200));
  let out = db.applyFileAtomic(CORE);
  chk('model_pnl.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(db.applyFileAtomic(CORE)));
  out = db.applyFileAtomic(STA);
  chk('model_pnl_states.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(STA)));
  out = db.applyFileAtomic(ANA);
  chk('model_pnl_analytics.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(ANA)));
  const noDepV = db.mustFail(() => db.applyFileAtomic(VIEWS));
  chk('the verified views without model_pnl_verified.sql stop and name the file', /model_pnl_verified\.sql/.test(noDepV || ''), noDepV && noDepV.slice(0, 200));
  const noDepQ = db.mustFail(() => db.applyFileAtomic(QUO));
  chk('the evidence table without model_pnl_verified.sql stops and names the file', /model_pnl_verified\.sql/.test(noDepQ || ''), noDepQ && noDepQ.slice(0, 200));
  out = db.applyFileAtomic(VER);
  chk('model_pnl_verified.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-900));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(VER)));
  const noDepVQ = db.mustFail(() => db.applyFileAtomic(VIEWS));
  chk('the verified views without model_pnl_quotes.sql stop and name the file', /model_pnl_quotes\.sql/.test(noDepVQ || ''), noDepVQ && noDepVQ.slice(0, 200));
  out = db.applyFileAtomic(QUO);
  chk('model_pnl_quotes.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-700));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(QUO)));
  out = db.applyFileAtomic(VIEWS);
  chk('model_pnl_verified_views.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(VIEWS)));
  /* re-applying model_pnl.sql brings back its own derive and upsert: the verified file's report says so, and re-applying it restores them */
  db.applyFileAtomic(CORE);
  chk('after model_pnl.sql is re-applied, the verified report would flag the superseded trigger', db.sql("select case when (select prosrc from pg_proc where oid = 'public.model_pnl_derive()'::regprocedure) like '%price lock%' then 'ok' else 'CHECK THIS' end;") === 'CHECK THIS');
  chk('and re-applying model_pnl_verified.sql restores it, all ok', !/CHECK THIS/.test(db.applyFileAtomic(VER)) && !/CHECK THIS/.test(db.applyFileAtomic(VIEWS)));
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
  chk('-110 winner at 0.50u: +0.909091 flat, +0.454545 staked (6 places)', got['pp:t1'].flat === 0.909091 && got['pp:t1'].staked === 0.454545, got['pp:t1']);
  chk('+150 loser at 0.25u: -1 / -0.25', got['pp:t2'].flat === -1 && got['pp:t2'].staked === -0.25);
  chk('-150 winner at 1u: +0.666667', got['bd:t3'].flat === 0.666667 && got['bd:t3'].staked === 0.666667);
  chk('push 0, void 0 (VOID), pending null', got['pp:t4'].flat === 0 && got['pp:t9'].st === 'VOID' && got['pp:t9'].flat === 0 && got['pp:t8'].flat === null);
  chk('the model record row: NO_ENTRY_PRICE, no P&L', got['mr:nfl:g10:spread'].st === 'NO_ENTRY_PRICE' && got['mr:nfl:g10:spread'].flat === null);
  chk('implied probability of -110 is stamped', got['pp:t1'].ip === 0.5238);

  /* ── no client can store an invented figure ─────────────────────────── */
  db.service("update public.model_pnl set flat_profit_units = 50, profit_units = 50 where recommendation_id = 'pp:t1';");
  chk('a written profit is re-derived from the price (the trigger ignores it)', db.sql("select flat_profit_units from public.model_pnl where recommendation_id = 'pp:t1';") === '0.909091');
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
  chk('a pending row settling is not a correction', up(settleNew).updated === 1 && db.sql("select corrected || ':' || flat_profit_units from public.model_pnl where recommendation_id = 'pp:t8';") === 'false:0.909091');
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

  /* ── every row's one state, as the kernel derives it ────────────────── */
  {
    const stored = {};
    db.sql("select recommendation_id || '|' || record_state || '|' || coalesce(state_reason, '') from public.model_pnl;").split('\n').forEach((l) => { const p = l.split('|'); stored[p[0]] = { st: p[1], why: p[2] }; });
    const kernel = settleNew.concat([row(11, { entry_odds: 0 }), row(12, { entry_odds: 50 }), row(13, { entry_odds: 'abc' }), row(14, { entry_odds: -110, price_assumed: true })])
      .filter((x) => x.recommendation_id !== 'pp:t2').map((x) => PNL.settle(x));
    chk('every stored row\'s state is the kernel\'s (pending, verified, record only, void)', kernel.every((x) => stored[x.recommendation_id] && stored[x.recommendation_id].st === x.record_state),
      kernel.filter((x) => !stored[x.recommendation_id] || stored[x.recommendation_id].st !== x.record_state).map((x) => [x.recommendation_id, x.record_state, stored[x.recommendation_id]]));
    chk('states: the model record row is RECORD_ONLY, an assumed price RECORD_ONLY, a void VOID', stored['mr:nfl:g10:spread'].st === 'RECORD_ONLY' && stored['pp:t14'].st === 'RECORD_ONLY' && stored['pp:t9'].st === 'VOID');
    const late = up([row(16, { recommended_at: '2026-09-26T18:00:00.000Z', result: 'pending', settled_at: null })]);
    chk('a recommendation stamped after kickoff is INVALID, with the reason', late.inserted === 1 && db.sql("select record_state || '|' || state_reason from public.model_pnl where recommendation_id = 'pp:t16';") === 'INVALID|recommended after the game started');
    up([row(15, { game_date: '2026-12-20T18:00:00.000Z', result: 'pending', settled_at: null, result_value: null })]);
    const rs = (rows) => JSON.parse(db.service(`select public.model_pnl_reasons(${J(rows)});`));
    chk('the build\'s pending reason lands', rs([{ recommendation_id: 'pp:t15', pending_reason: 'UPCOMING', record_state: 'PENDING' }]).updated === 1 && db.sql("select record_state || '|' || pending_reason from public.model_pnl where recommendation_id = 'pp:t15';") === 'PENDING|UPCOMING');
    chk('sent again, it touches nothing', rs([{ recommendation_id: 'pp:t15', pending_reason: 'UPCOMING', record_state: 'PENDING' }]).updated === 0);
    rs([{ recommendation_id: 'pp:t1', pending_reason: 'UPCOMING', record_state: 'VERIFIED' }]);
    chk('a settled row never carries a pending reason', db.sql("select coalesce(pending_reason, 'null') from public.model_pnl where recommendation_id = 'pp:t1';") === 'null');
    chk('an unknown reason is refused', db.mustFail(() => db.service(`select public.model_pnl_reasons(${J([{ recommendation_id: 'pp:t15', pending_reason: 'BECAUSE', record_state: 'PENDING' }])});`)) !== null);
    rs([{ recommendation_id: 'pp:t15', pending_reason: null, record_state: 'INVALID', state_reason: 'the settlement reads "graded?", which is not a result' }]);
    chk('the build\'s INVALID verdict lands with its reason', db.sql("select record_state || '|' || state_reason from public.model_pnl where recommendation_id = 'pp:t15';") === 'INVALID|the settlement reads "graded?", which is not a result');
    rs([{ recommendation_id: 'pp:t15', pending_reason: 'MISSING_FINAL', record_state: 'PENDING' }]);
    chk('and lifts when the build no longer says so', db.sql("select record_state || '|' || pending_reason from public.model_pnl where recommendation_id = 'pp:t15';") === 'PENDING|MISSING_FINAL');
    chk('no client writes a reason', db.mustFail(() => db.anon(`select public.model_pnl_reasons(${J([{ recommendation_id: 'pp:t15', pending_reason: 'UPCOMING' }])});`)) !== null
      && db.mustFail(() => db.as(A, `select public.model_pnl_reasons(${J([{ recommendation_id: 'pp:t15', pending_reason: 'UPCOMING' }])});`)) !== null);
    chk('a VERIFIED state needs a captured price (constraint)', db.mustFail(() => db.sql("alter table public.model_pnl disable trigger model_pnl_state_trg; update public.model_pnl set record_state = 'VERIFIED' where recommendation_id = 'mr:nfl:g10:spread';")) !== null);
    db.sql('alter table public.model_pnl enable trigger model_pnl_state_trg;');
    /* the canonical record */
    chk('anon reads the canonical record: one row per recommendation, the public rows', +db.anon('select count(*) from public.model_record_canonical;') === +db.anon('select count(*) from public.model_pnl_public;'));
    chk('the canonical record carries the normalized names', db.anon("select id || '|' || recommendation_grade || '|' || settlement_result || '|' || pnl_units || '|' || record_state from public.model_record_canonical where id = 'bd:t3';") === 'bd:t3|BET|win|0.666667|VERIFIED');
    chk('the canonical record carries no internal fields', db.mustFail(() => db.anon('select entry_odds_raw from public.model_record_canonical;')) !== null);
    chk('the state counts add up to every public row', +db.anon('select sum(n) from public.model_record_states;') === +db.anon('select count(*) from public.model_record_canonical;'));
  }


  /* ── VERIFIED P&L: the price lock, the verification rule, the reasons ── */
  {
    const mr = (o) => PNL.settle(Object.assign({
      recommendation_id: 'mr:cfb:g30:spread', source: 'model_record', source_ref: { file: 'record/football/cfb_2026.json', id: 'g30' }, sport: 'football', league: 'CFB', season: 2026, week: 2,
      event_id: 'g30', event_label: 'ARK @ UTAH', game_date: '2026-09-13T02:15:00.000Z', model_version: 'edgedesk_cfb_p4_v1.0.0', market_group: 'game', market_type: 'spread',
      side: 'home', selection: 'UTAH -13.5', model_line: -15.7, entry_line: -12.5, entry_odds: null, entry_book: 'DraftKings', price_assumed: false, rec_class: 'MODEL', stake_units: 0,
      recommended_at: '2026-09-12T22:24:40.000Z', odds_captured_at: null, evaluation_mode: 'LIVE_RECONSTRUCTED', result: 'win', result_value: 33, final_score: '10–43',
      closing_line: -13.5, settled_at: '2026-09-14T00:00:00.000Z', corrections: [], corrected: false,
      price_lookup: { status: 'historical_price_unavailable', why: 'no_snapshot', detail: 'EdgeDesk stored no priced spread quote for this game' }
    }, o));
    const lockFields = { entry_odds: -108, entry_book: 'draftkings', odds_captured_at: '2026-09-12T21:07:00.000Z', stake_units: 1, stake_source: 'default', price_source: 'snapshot',
      price_ref: { source: 'cfb_lab_quotes', quote_id: 'cfbq_000000000000000000000030', event_id: 'g30', market: 'spread', side: 'home', line: -13.5, book: 'draftkings', observed_at: '2026-09-12T21:07:00.000Z', decided_at: '2026-09-12T22:24:40.000Z' },
      price_lookup: null, price_locked_at: '2026-10-03T12:00:00.000Z' };
    const st = (id) => db.sql("select record_state || '|' || pnl_verified || '|' || coalesce(pnl_exclusion_reason, 'null') || '|' || coalesce(flat_profit_units::text, 'null') || '|' || coalesce(profit_units::text, 'null') || '|' || coalesce(stake_source, 'null') || '|' || coalesce(price_source, 'null') from public.model_pnl where recommendation_id = '" + id + "';");
    /* THE EVIDENCE: the stored quote the lock will cite, copied once, append-only */
    const quote = { quote_id: 'cfbq_000000000000000000000030', source: 'cfb_lab_quotes', league: 'CFB', game_id: 'g30', book: 'draftkings', market_type: 'spread',
      observed_at: '2026-09-12T21:07:00.000Z', kickoff_ts: '2026-09-13T02:15:00.000Z', home_line: -13.5, total_points: null, price_home: -108, price_away: -112, price_over: null, price_under: null,
      source_file: 'football/cfb_lab/ledger/2026/quotes' };
    const qput = (rows) => JSON.parse(db.service(`select public.model_pnl_quotes_put(${J(rows)});`));
    let qp = qput([quote]);
    chk('model_pnl_quotes: a cited quote is copied once', qp.inserted === 1 && qp.refused.length === 0, qp);
    qp = qput([quote]);
    chk('… sent again, unchanged', qp.inserted === 0 && qp.unchanged === 1, qp);
    qp = qput([Object.assign({}, quote, { price_home: -110 })]);
    chk('… a different quote under the same id is refused, named — the stored one stands', qp.refused.length === 1 && db.sql("select price_home::text from public.model_pnl_quotes where quote_id = 'cfbq_000000000000000000000030';") === '-108', qp);
    qp = qput([Object.assign({}, quote, { quote_id: 'late1', observed_at: '2026-09-13T02:15:00.000Z' })]);
    chk('… a quote read at or after kickoff is refused (constraint)', qp.refused.length === 1 && /model_pnl_quotes_pregame/.test(qp.refused[0].error), qp);
    chk('… never edited', db.mustFail(() => db.service("update public.model_pnl_quotes set price_home = -105 where quote_id = 'cfbq_000000000000000000000030';")) !== null);
    chk('… never deleted', db.mustFail(() => db.service("delete from public.model_pnl_quotes where quote_id = 'cfbq_000000000000000000000030';")) !== null);
    chk('… readers read it', db.anon("select price_home::text from public.model_pnl_quotes where quote_id = 'cfbq_000000000000000000000030';") === '-108');
    chk('… readers cannot write it', db.mustFail(() => db.anon(`select public.model_pnl_quotes_put(${J([Object.assign({}, quote, { quote_id: 'x1' })])});`)) !== null
      && db.mustFail(() => db.anon("insert into public.model_pnl_quotes (quote_id, source, league, game_id, book, market_type, observed_at) values ('x2','s','CFB','g','b','spread', now());")) !== null);
    let u = up([mr()]);
    chk('a model number with no stored price lands record-only, with its reason', u.inserted === 1 && st('mr:cfb:g30:spread') === 'RECORD_ONLY|false|historical_price_unavailable|null|null|null|null', [u, st('mr:cfb:g30:spread')]);
    u = up([mr(lockFields)]);
    chk('THE PRICE LOCK: the stored pre-decision quote attaches ONCE — verified, at the default 1u', u.updated === 1 && u.price_locked === 1 && st('mr:cfb:g30:spread') === 'VERIFIED|true|null|0.925926|0.925926|default|snapshot', [u, st('mr:cfb:g30:spread')]);
    chk('the lock is stamped', db.sql("select (price_locked_at is not null)::text from public.model_pnl where recommendation_id = 'mr:cfb:g30:spread';") === 'true');
    const integ = (k) => db.sql("select failures::text from public.verified_pnl_integrity() where check_key = '" + k + "';");
    chk('the locked price is checked against the stored quote it cites: same game, number, time and price', integ('snapshot_quote_mismatch') === '0' && integ('snapshot_quote_missing') === '0');
    chk('no CFB Model Lab mirror deployed: that cross-check is simply not listed', integ('lab_mirror_mismatch') === '');
    /* where the lab's own mirror is deployed (production: public.cfb_lab_market_quotes), the lock is checked against it too */
    db.sql("create table public.cfb_lab_market_quotes (quote_id text primary key, game_id text, observed_at timestamptz, price_home integer, price_away integer, price_over integer, price_under integer);");
    db.sql("insert into public.cfb_lab_market_quotes values ('cfbq_000000000000000000000030', 'g30', '2026-09-12T21:07:00Z', -108, -112, null, null);");
    chk('… the lab mirror agrees with the lock: 0', integ('lab_mirror_mismatch') === '0');
    chk('… and a lab mirror row that disagrees is an integrity error', /lab=1/.test(db.mustFail(() => db.sql(`do $t$ declare a bigint; begin
      update public.cfb_lab_market_quotes set price_home = -120 where quote_id = 'cfbq_000000000000000000000030';
      select failures into a from public.verified_pnl_integrity() where check_key = 'lab_mirror_mismatch'; raise exception 'lab=%', a; end $t$;`)) || ''));
    chk('sent again, nothing changes', up([mr(lockFields)]).unchanged === 1);
    const moved = up([mr(Object.assign({}, lockFields, { entry_odds: -110, odds_captured_at: '2026-09-12T22:07:00.000Z' }))]);
    chk('a later price (the market moved) never overwrites the locked one', moved.updated === 0 && moved.price_locked === 0
      && db.sql("select entry_odds::text from public.model_pnl where recommendation_id = 'mr:cfb:g30:spread';") === '-108', moved);
    const movedAndSettled = up([mr(Object.assign({}, lockFields, { entry_odds: -110, result: 'loss' }))]);
    chk('and arriving with a settlement change, the row is refused, named — the price stands', movedAndSettled.refused.length === 1 && /locked price and is frozen/.test(movedAndSettled.refused[0].error)
      && db.sql("select entry_odds || ':' || result from public.model_pnl where recommendation_id = 'mr:cfb:g30:spread';") === '-108:win', movedAndSettled);
    chk('a direct update of the locked price is refused', db.mustFail(() => db.service("update public.model_pnl set entry_odds = -110 where recommendation_id = 'mr:cfb:g30:spread';")) !== null);
    chk('nor can the stake be changed after the lock', db.mustFail(() => db.service("update public.model_pnl set stake_units = 0.5 where recommendation_id = 'mr:cfb:g30:spread';")) !== null);
    const late = up([row(40, { recommendation_id: 'bd:t40', source: 'bettor_decision', market_group: 'game', market_type: 'spread', side: 'home', selection: 'Utah -6.5', prop_market: null, player_id: null,
      game_date: '2026-09-20T17:00:00.000Z', recommended_at: '2026-09-10T12:00:00.000Z', odds_captured_at: '2026-09-10T13:00:00.000Z' })]);
    chk('a price captured after the decision is PRICE_AFTER_DECISION: record only, no units', late.inserted === 1 && st('bd:t40') === 'RECORD_ONLY|false|price_after_decision|null|null|explicit|decision', st('bd:t40'));
    /* the cross-check catches a lock that does not match its quote, and one whose quote is missing (each tried in a transaction that rolls back) */
    const tryLock = (q, entryOdds) => db.mustFail(() => db.service(`do $t$ declare a bigint; b bigint; begin
      ${q ? `perform public.model_pnl_quotes_put(${J([q])});` : ''}
      perform public.model_pnl_upsert(${J([mr(Object.assign({}, lockFields, { recommendation_id: 'mr:cfb:g33:spread', event_id: 'g33', entry_odds: entryOdds,
        price_ref: Object.assign({}, lockFields.price_ref, { quote_id: 'q33', event_id: 'g33' }) }))])});
      select failures into a from public.verified_pnl_integrity() where check_key = 'snapshot_quote_mismatch';
      select failures into b from public.verified_pnl_integrity() where check_key = 'snapshot_quote_missing';
      raise exception 'mismatch=% missing=%', a, b; end $t$;`)) || '';
    const q33 = Object.assign({}, quote, { quote_id: 'q33', game_id: 'g33' });
    chk('a locked price that differs from the stored quote it cites is an integrity error', /mismatch=1 missing=0/.test(tryLock(Object.assign({}, q33, { price_home: -115 }), -108)), tryLock(Object.assign({}, q33, { price_home: -115 }), -108));
    chk('a locked price whose quote is not in model_pnl_quotes is an integrity error', /mismatch=0 missing=1/.test(tryLock(null, -108)), tryLock(null, -108));
    chk('the same lock with its matching quote reads 0 / 0', /mismatch=0 missing=0/.test(tryLock(q33, -108)));
    const elsewhere = up([mr(Object.assign({}, lockFields, { recommendation_id: 'mr:cfb:g31:spread', event_id: 'g31' }))]);
    chk('a stored-quote price recorded for another game is refused (constraint)', elsewhere.refused.length === 1 && /model_pnl_verified_rules/.test(elsewhere.refused[0].error), elsewhere);
    chk('a default stake on a WATCH is refused (constraint)', db.mustFail(() => db.service("insert into public.model_pnl (recommendation_id, source, league, event_id, market_group, market_type, selection, rec_class, stake_units, stake_source, entry_odds) values ('w1','bettor_decision','CFB','g','game','spread','X -3','WATCH',1,'default',-110);")) !== null);
    chk('every pending row is excluded as not settled', db.sql("select count(*) from public.model_pnl where record_state = 'PENDING' and pnl_exclusion_reason is distinct from 'missing_settlement';") === '0');
    chk('a void is excluded as void, an assumed price as simulated, a malformed one as invalid odds',
      db.sql("select string_agg(recommendation_id || ':' || pnl_exclusion_reason, ',' order by recommendation_id) from public.model_pnl where recommendation_id in ('pp:t9','pp:t14','pp:t12');") === 'pp:t12:invalid_odds,pp:t14:simulated_price,pp:t9:void');
  }

  /* ── verified_pnl_*: the summary, breakdowns and series equal the kernel ── */
  const kernelRows = () => JSON.parse(db.sql("select coalesce(json_agg(t), '[]') from (select recommendation_id, rec_class, record_state, pnl_status, result, entry_odds, stake_units, flat_profit_units, profit_units, game_date, recommended_at, market_type, market_group, league, week, price_source, stake_source from public.model_pnl where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED')) t;"));
  const parity = (tag) => {
    const K = kernelRows();
    ['staked', 'flat'].forEach((mode) => {
      const c = PNL.verifiedCard(K, mode);
      const s = db.anon(`select graded_decisions || '|' || total_verified_bets || '|' || record_only_decisions || '|' || wins || '|' || losses || '|' || pushes || '|' || coalesce(net_units::text, 'null') || '|' || coalesce(units_risked::text, 'null') || '|' || coalesce(roi_percent::text, 'null') from public.verified_pnl_summary('${mode}');`).split('|');
      const num = (v) => (v === 'null' ? null : +v);
      chk(tag + mode + ': verified_pnl_summary = the kernel card (graded, priced, record only, W-L-P, net, risked, ROI)',
        +s[0] === c.graded && +s[1] === c.n && +s[2] === c.record_only && +s[3] === c.wins && +s[4] === c.losses && +s[5] === c.pushes && num(s[6]) === c.net_units && num(s[7]) === c.risked_units && num(s[8]) === c.roi_pct,
        [s, c.graded, c.n, c.record_only, c.record, c.net_units, c.risked_units, c.roi_pct]);
      chk(tag + mode + ': graded = verified priced + record only', +s[0] === c.priced + +s[2]);
      const bm = db.anon(`select coalesce(string_agg(group_key || ':' || total_verified_bets || ':' || coalesce((net_units::float8)::text, 'null'), ',' order by group_key), '') from public.verified_pnl_breakdown('market_type', '${mode}') where total_verified_bets > 0;`);
      const km = c.markets.filter((m) => m.n).map((m) => m.type + ':' + m.n + ':' + m.net_units).sort().join(',');
      chk(tag + mode + ': by market_type = the kernel card\'s markets', bm === km, [bm, km]);
      const ser = db.anon(`select count(*) || '|' || coalesce(round((array_agg(cumulative_units order by n desc))[1], 2)::text, 'null') from public.verified_pnl_series('${mode}');`).split('|');
      chk(tag + mode + ': the series has one point per priced decision and ends at the net', +ser[0] === c.n && num(ser[1]) === c.net_units, [ser, c.n, c.net_units]);
    });
    const lg = db.anon("select string_agg(group_key || ':' || graded_decisions, ',' order by group_key) from public.verified_pnl_breakdown('league');");
    chk(tag + 'by league: every graded decision once', lg.split(',').reduce((a, x) => a + +x.split(':')[1], 0) === PNL.verifiedCard(kernelRows(), 'staked').graded, lg);
    chk(tag + 'filters: CFB spread only', +db.anon("select graded_decisions from public.verified_pnl_summary('staked', 'CFB', 'spread');") === PNL.verifiedCard(kernelRows().filter((x) => x.league === 'CFB' && x.market_type === 'spread'), 'staked').graded);
    const I = db.anon("select string_agg(check_key || ':' || failures, ',' order by check_key) from public.verified_pnl_integrity() where severity = 'error';");
    chk(tag + 'every integrity check reads 0', I.split(',').every((x) => x.split(':')[1] === '0'), I);
  };
  parity('fixture · ');
  /* a corrupted row is caught: units that do not match the price */
  db.sql("alter table public.model_pnl disable trigger user; update public.model_pnl set flat_profit_units = 5 where recommendation_id = 'mr:cfb:g30:spread'; alter table public.model_pnl enable trigger user;");
  chk('integrity: units that do not match stake × odds × result are caught', db.sql("select failures from public.verified_pnl_integrity() where check_key = 'profit_mismatch';") === '1');
  db.sql("alter table public.model_pnl disable trigger user; update public.model_pnl set flat_profit_units = 0.925926 where recommendation_id = 'mr:cfb:g30:spread'; update public.model_pnl set price_ref = jsonb_set(price_ref, '{line}', '-14.5') where recommendation_id = 'mr:cfb:g30:spread'; alter table public.model_pnl enable trigger user;");
  chk('integrity: a stored-quote price for another number is caught', db.sql("select failures from public.verified_pnl_integrity() where check_key = 'line_mismatch';") === '1');
  db.sql("alter table public.model_pnl disable trigger user; update public.model_pnl set price_ref = jsonb_set(price_ref, '{line}', '-13.5') where recommendation_id = 'mr:cfb:g30:spread'; alter table public.model_pnl enable trigger user;");
  chk('anon reads the decisions view: price, stake, verification and reason', db.anon("select american_odds || '|' || stake_units || '|' || stake_source || '|' || pnl_verified || '|' || line from public.verified_pnl_decisions where decision_id = 'mr:cfb:g30:spread';") === '-108|1|default|true|-13.5');
  chk('anon cannot read the verified rows function\'s source table', db.mustFail(() => db.anon('select price_ref from public.model_pnl;')) !== null);

  /* ── the cached daily series ────────────────────────────────────────── */
  db.service('select public.model_pnl_refresh();');
  const last = db.sql("select cum_units from public.model_pnl_daily where scope = 'all' and mode = 'flat' order by day desc limit 1;");
  chk('the daily series ends at the net', Math.abs(+last - PNL.summarize(bets, 'flat').net_units) < 0.01, [last]);
  chk('anon reads the daily series', +db.anon("select count(*) from public.model_pnl_daily;") > 0);
  chk('anon cannot refresh it', db.mustFail(() => db.anon('select public.model_pnl_refresh();')) !== null);

  /* ── who reads what ─────────────────────────────────────────────────── */
  chk('anon cannot read the table', db.mustFail(() => db.anon('select count(*) from public.model_pnl;')) !== null);
  chk('a signed-in reader cannot read the table either', db.mustFail(() => db.as(A, 'select count(*) from public.model_pnl;')) !== null);
  chk('anon reads the public view: every LIVE row', +db.anon('select count(*) from public.model_pnl_public;') === +db.sql("select count(*) from public.model_pnl where evaluation_mode in ('LIVE', 'LIVE_RECONSTRUCTED');") && +db.sql('select count(*) from public.model_pnl;') >= 14);
  chk('the public view carries no internal fields', db.mustFail(() => db.anon('select entry_odds_raw from public.model_pnl_public;')) !== null);
  chk('anon reads the corrections', +db.anon('select count(*) from public.model_pnl_corrections_public;') >= 2);
  chk('anon cannot write', db.mustFail(() => db.anon(`select public.model_pnl_upsert(${J([row(20)])});`)) !== null);
  chk('a signed-in reader cannot write', db.mustFail(() => db.as(A, `select public.model_pnl_upsert(${J([row(21)])});`)) !== null);
  chk('nor insert directly', db.mustFail(() => db.as(A, "insert into public.model_pnl (recommendation_id, source, league, event_id, market_group, market_type, selection, rec_class) values ('x','player_props','NFL','g','prop','player_prop','Over 1','LEAN');")) !== null);
  chk('anon calls the rollups', +db.anon("select bets from public.model_pnl_rollup('flat', 'all');") > 0);

  /* ── the real committed ledger passes every constraint ─────────────── */
  let ledgerBets = [];                    /* its BETs now sit in model_pnl beside the fixture's */
  {
    const SY = require('./pnl_sync.js');
    const lf = fs.readdirSync(path.join(PG.ROOT, 'record', 'pnl')).filter((f) => /^ledger_\d{4}\.json$/.test(f)).sort().pop();
    if (lf) {
      const real = SY.tableRows(JSON.parse(fs.readFileSync(path.join(PG.ROOT, 'record', 'pnl', lf), 'utf8')));
      ledgerBets = real.map((x) => PNL.settle(x)).filter((x) => x.rec_class === 'BET');
      const rr = up(real);
      chk('the committed ledger (' + lf + ', ' + real.length + ' rows) is accepted row for row', rr.inserted === real.length && rr.refused.length === 0, rr.refused.slice(0, 3));
      chk('and synced again, it is unchanged', up(real).unchanged === real.length);
      chk('the database derives the same P&L status for every real row', db.sql("select count(*) from public.model_pnl m where m.recommendation_id = any(" + lit('{' + real.map((x) => '"' + x.recommendation_id + '"').join(',') + '}') + "::text[]) and m.pnl_status is distinct from (" + J(Object.fromEntries(real.map((x) => [x.recommendation_id, x.pnl_status]))) + " ->> m.recommendation_id);") === '0');
      const L0 = JSON.parse(fs.readFileSync(path.join(PG.ROOT, 'record', 'pnl', lf), 'utf8'));
      if (L0.rows.length && L0.rows[0].record_state) {
        const why = SY.reasonRows(L0);
        for (let i = 0; i < why.length; i += 500) db.service(`select public.model_pnl_reasons(${J(why.slice(i, i + 500))});`);
        const ids = lit('{' + L0.rows.map((x) => '"' + x.recommendation_id + '"').join(',') + '}') + '::text[]';
        chk('the database derives the same one state for every real row', db.sql("select count(*) from public.model_pnl m where m.recommendation_id = any(" + ids + ") and m.record_state is distinct from (" + J(Object.fromEntries(L0.rows.map((x) => [x.recommendation_id, x.record_state]))) + " ->> m.recommendation_id);") === '0');
        parity('real ledger + fixture · ');
        chk('the real ledger\'s stored-quote prices all reference their own game and number', db.sql("select count(*) from public.model_pnl where price_source = 'snapshot' and (price_ref ->> 'event_id' <> event_id or (market_type <> 'moneyline' and (price_ref ->> 'line')::numeric <> closing_line));") === '0');
        chk('and holds the same pending reason for every real row', db.sql("select count(*) from public.model_pnl m where m.recommendation_id = any(" + ids + ") and m.pending_reason is distinct from (" + J(Object.fromEntries(L0.rows.map((x) => [x.recommendation_id, x.pending_reason || null]))) + " ->> m.recommendation_id);") === '0');
      }
    }
  }

  /* ── dollars: the reader's own unit, nobody else's ──────────────────── */
  db.sql(`create table public.bankroll_settings (user_id uuid primary key default auth.uid(), bankroll_amount numeric, base_unit_amount numeric, unit_mode text not null default 'percent', unit_percent numeric not null default 0.01);
    alter table public.bankroll_settings enable row level security;
    create policy bankroll_own on public.bankroll_settings for select to authenticated using (user_id = auth.uid());
    grant select on public.bankroll_settings to authenticated;
    insert into public.bankroll_settings (user_id, base_unit_amount, unit_mode) values ('${A}', 25, 'fixed');
    insert into public.bankroll_settings (user_id, bankroll_amount, unit_mode, unit_percent) values ('${B}', 1000, 'percent', 0.02);`);
  /* model_pnl holds the fixture AND the committed ledger (whose first BETs
     settled 2026-10-02): the kernel reads the same BETs the SQL does */
  const net = PNL.summarize(bets.concat(ledgerBets), 'flat').net_units;
  const da = db.as(A, "select unit_value || '|' || basis || '|' || net_dollars from public.model_pnl_my_dollars('flat', 'all');").split('|');
  chk('reader A: a $25 custom unit, net in dollars', +da[0] === 25 && da[1] === 'CUSTOM' && Math.abs(+da[2] - Math.round(net * 25 * 100) / 100) < 0.011, [da, net]);
  const dbb = db.as(B, "select unit_value || '|' || basis || '|' || net_dollars from public.model_pnl_my_dollars('flat', 'all');").split('|');
  chk('reader B: 2% of a $1,000 bankroll = $20', +dbb[0] === 20 && dbb[1] === 'PERCENT', dbb);
  const C = '00000000-0000-0000-0000-00000000000c';
  chk('a reader with no bankroll gets units only, never a default dollar amount', db.as(C, "select coalesce(unit_value::text, 'null') || '|' || basis || '|' || coalesce(net_dollars::text, 'null') from public.model_pnl_my_dollars('flat', 'all');") === 'null|NOT_SET|null');
  chk('anon cannot ask for dollars', db.mustFail(() => db.anon("select * from public.model_pnl_my_dollars('flat', 'all');")) !== null);
  chk('reader A cannot see reader B\'s bankroll', db.as(A, 'select count(*) from public.bankroll_settings;') === '1');

  /* ── the sync job: the database must say what the page says ─────────── */
  tail = (async () => {
    const SY = require('./pnl_sync.js');
    /* PostgREST's rpc over this server: a set-returning function answers rows, a scalar (jsonb) one its value */
    const SCALAR = ['model_pnl_upsert', 'model_pnl_quotes_put', 'model_pnl_reasons', 'model_pnl_refresh'];
    const rpcDb = { rpc: async (schema, fn, args) => {
      const a = Object.keys(args || {}).map((k) => k + ' => ' + (typeof args[k] === 'string' ? lit(args[k]) : J(args[k]))).join(', ');
      const out = JSON.parse(db.service(`select coalesce(json_agg(t), '[]') from ${schema}.${fn}(${a}) t;`));
      return SCALAR.indexOf(fn) >= 0 ? out[0] : out;
    } };
    const all = JSON.parse(db.sql("select coalesce(json_agg(t), '[]') from (select recommendation_id, rec_class, record_state, pnl_status, result, entry_odds, stake_units, flat_profit_units, profit_units, to_char(game_date at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as game_date, recommended_at, market_type, market_group, league, week, price_source, stake_source, evaluation_mode from public.model_pnl) t;"));
    const P = await SY.parity(rpcDb, { rows: all });
    const P26 = await SY.parity(rpcDb, { season: 2026, rows: all.filter((x) => String(x.game_date || '').slice(0, 10) >= '2026-03-01') });
    chk('sync parity is per season: the 2026 ledger against the 2026 window of a table that may hold other seasons', P26.ok && P26.window.from === '2026-03-01' && P26.window.to === '2027-02-28', P26);
    chk('… a leap-year February is whole', SY.seasonWindow(2027).to === '2028-02-29');
    chk('sync parity: the database and the kernel over the same rows agree, every integrity check 0', P.ok && !P.diffs.length && !P.integrity.length, P);
    const short = all.filter((x) => x.recommendation_id !== 'mr:cfb:g30:spread');
    const P2 = await SY.parity(rpcDb, { rows: short });
    chk('sync parity: a page one verified decision short of the database is caught, by field', !P2.ok && P2.diffs.some((d) => d.field === 'total_verified_bets' && d.mode === 'staked'), P2.diffs);
    chk('a missing function is read as a missing schema (exit 3), not a pass', SY.schemaMissing({ code: 'PGRST202', message: 'Could not find the function public.model_pnl_upsert' })
      && SY.schemaMissing(new Error('RPC public.verified_pnl_summary -> 404: {"code":"PGRST202"}')) && !SY.schemaMissing(new Error('timeout')) && SY.EXIT.SCHEMA === 3 && SY.EXIT.PARITY === 4);
  })();
} finally {
  if (!tail) db.stop();
}
if (tail) tail.catch((e) => chk('the sync parity checks ran', false, String(e.stack || e))).then(() => { db.stop(); process.exit(T.done()); });
else process.exit(T.done());

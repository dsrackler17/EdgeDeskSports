#!/usr/bin/env node
/* ===========================================================================
   supabase/pnl_grades.sql + pnl_grades_sync.sql + pnl_grades_analytics.sql,
   AGAINST A REAL POSTGRESQL, ON A signals TABLE BUILT BY THE REAL MIGRATIONS.

   The fixture is the pre-v9 signals shape (tools/capture/migration.test.js),
   then supabase/capture_v9_qualification.sql and close_v7_parity.sql exactly
   as production ran them, then ~90 flagged and unflagged rows covering every
   sport, market, tier, book, result and price case. Proves:
     - the odds math: +150 win 1.50, −110 win 0.909, loss −1, push 0, void
       none; the American and decimal paths agree, and agree with
       lib/edgedesk_pnl.js (the existing P&L kernel) to 1e-9;
     - the verdict at flag is the board's own rule (app.html is read and the
       rule's constants are pinned, so a change there fails here);
     - the dry run writes nothing; the commit writes one row per flag; a
       second commit inserts and updates nothing;
     - every row equals an independent recomputation from the raw signal;
     - pnl_summary equals a raw SQL sum, and a JS sum, for every sport ×
       verdict; months add back up to all time; push risked, void not;
     - a newly flagged and newly settled signal gets its P&L row from the
       trigger, in the same statement; a corrected result is logged;
     - a P&L fault never fails the signals write, and reconciliation sees it;
     - a capture pass that touches only prices does not churn a P&L row;
     - RLS: anyone reads a started game, nobody reads the live board, no
       client writes; only the service role backfills; nothing is deleted;
     - a new calc_version recalculates and leaves a trail.

   Run: node tools/record/pnl_grades_sql.test.js          (add --show to print
   the dry-run report, the 10-row hand check and the summary-vs-raw sums)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const PNL = require(path.join(PG.ROOT, 'lib', 'edgedesk_pnl.js'));

const SHOW = process.argv.includes('--show');
const T = PG.kit('pnl_grades SQL');
const chk = T.chk;
const near = (a, b, eps) => a != null && b != null && Math.abs(Number(a) - Number(b)) < (eps || 1e-9);
const SUP = (f) => path.join(PG.ROOT, 'supabase', f);
const FILES = ['pnl_grades.sql', 'pnl_grades_sync.sql', 'pnl_grades_analytics.sql'];

/* ── static: the folder's conventions ─────────────────────────────────── */
FILES.forEach((n) => {
  const s = fs.readFileSync(SUP(n), 'utf8');
  chk(n + ': no psql meta-commands', !/^\s*\\/m.test(s));
  chk(n + ': idempotent create statements', /create or replace (function|view)/.test(s) && !/create table (?!if not exists)/i.test(s) && !/create index (?!if not exists)/i.test(s));
  chk(n + ': additive — no table, column or view is dropped', !/\bdrop (table|column|view)\b/i.test(s));
  chk(n + ': it ends in a report', /CHECK THIS/.test(s) && /order by 1;\s*$/.test(s));
  chk(n + ': PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(s));
  chk(n + ': under the SQL editor paste limit (18 KB)', Buffer.byteLength(s) <= 18000, Buffer.byteLength(s));
});

/* ── static: the verdict rule is the board's own (app.html) ───────────── */
const APP = fs.readFileSync(path.join(PG.ROOT, 'app.html'), 'utf8');
const SQL1 = fs.readFileSync(SUP('pnl_grades.sql'), 'utf8');
const SQL2 = fs.readFileSync(SUP('pnl_grades_sync.sql'), 'utf8');
const appTrusted = JSON.parse((APP.match(/var TRUSTED=(\[[^\]]*\])/) || [])[1].replace(/'/g, '"'));
const sqlTrusted = JSON.parse('[' + (SQL1.match(/unnest\(array\[('draftkings'[^\]]*)\]\)/) || [])[1].replace(/'/g, '"').replace(/\s+/g, ' ') + ']');
chk('the US-regulated book list is app.html TRUSTED, entry for entry', JSON.stringify(appTrusted) === JSON.stringify(sqlTrusted), { appTrusted, sqlTrusted });
chk('app.html: a tier-B row is a LEAN however good the inputs look', /e\.qual_tier==='B'\)\{ verdict='LEAN'/.test(APP));
chk('app.html: BET needs edge ≥ 3%, a trusted book, 5+ books and a sharp anchor', /curEdge>=0\.03 && tr && nb>=5 && sharp\)\{ verdict='BET'/.test(APP));
chk('app.html: offshore with fewer than 4 books is a PASS', /if\(!tr && nb<4\)\{ verdict='PASS'/.test(APP));
chk('app.html: the floor is 0.5%', /REAL_FLOOR=0\.005/.test(APP));
chk('the SQL rule carries the same constants', /p_edge < 0\.005/.test(SQL2) && /p_edge >= 0\.03 and us and nb >= 5 and p_reference = 'sharp'/.test(SQL2) && /not us and nb < 4/.test(SQL2));

const db = PG.start('pnlgrades');
if (db.skip) {
  if (process.env.PNL_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}
const lit = PG.lit;
const q = (sql) => db.sql(sql);
const qj = (sql) => { const o = q('select coalesce(json_agg(t), \'[]\') from (' + sql + ') t'); return JSON.parse(o || '[]'); };
const one = (sql) => qj(sql)[0] || null;

/* ── the fixture (shared with tools/record/edge_pnl_ui.test.js) ─────── */
const FX = require('./pnl_grades_fixture.js');
const FLAGGED = FX.FLAGGED, UNFLAGGED = FX.UNFLAGGED;
const insertRows = (rows) => FX.insertSql(rows, lit);

/* ── the independent recomputation (no SQL function is used) ──────────── */
function expected(s) {
  const book = (s.flagged_best_book || '').toLowerCase();
  const us = !!s.flagged_best_book && appTrusted.some((t) => book.indexOf(t) >= 0);
  const nb = s.flagged_fresh_books || 0, e = s.flagged_edge;
  let verdict;
  if (s.flagged_tier == null) verdict = 'UNLABELLED';
  else if (s.flagged_tier !== 'A' && s.flagged_tier !== 'B') verdict = 'PASS';
  else if (e == null || e < 0.005) verdict = 'PASS';
  else if (!us && nb < 4) verdict = 'PASS';
  else if (s.flagged_tier === 'B') verdict = 'LEAN';
  else if (e >= 0.03 && us && nb >= 5 && s.flagged_reference_type === 'sharp') verdict = 'BET';
  else verdict = 'LEAN';
  const res = PNL.normResult(s.result);
  const final = ['win', 'loss', 'push', 'void'].includes(res) ? res : null;
  const price = s.flagged_best_dec > 1 ? s.flagged_best_dec : null;
  const am = (d) => (d == null ? null : (d >= 2 ? (d - 1) * 100 : -100 / (d - 1)));
  let status;
  if (verdict === 'PASS') status = 'not_a_bet';
  else if (final === 'void') status = 'void';
  else if (final == null) status = 'ungraded_unsettled';
  else if (/^tennis/.test(s.sport_key) && /spreads|totals/.test(s.market)) status = 'ungraded_unsupported';
  else if (price == null) status = 'ungraded_missing_price';
  else status = 'graded';
  const close = s.closing_dec > 1 ? s.closing_dec : null;
  return {
    verdict, status, result: final,
    pnl: status === 'graded' ? PNL.profit(am(price), 1, final) : null,
    pnl_close: status === 'graded' && close ? PNL.profit(am(close), 1, final) : null,
    stake: verdict === 'PASS' ? 0 : 1
  };
}

try {
  /* the signals table, as production built it */
  q(FX.SIGNALS_DDL);
  const pre = db.mustFail(() => db.applyFileAtomic(SUP('pnl_grades.sql')));
  chk('pnl_grades.sql on a pre-v9 signals table stops and names the migration', /capture_v9_qualification\.sql/.test(pre || ''), pre && pre.slice(0, 200));
  db.applyFileAtomic(SUP('capture_v9_qualification.sql'));
  const noClose = db.mustFail(() => db.applyFileAtomic(SUP('pnl_grades.sql')));
  chk('…and without closing_dec it names close_v7_parity.sql', /close_v7_parity\.sql/.test(noClose || ''), noClose && noClose.slice(0, 200));
  db.applyFileAtomic(SUP('close_v7_parity.sql'));
  q('alter table public.signals add column if not exists participant text;');
  const noCore = db.mustFail(() => db.applyFileAtomic(SUP('pnl_grades_sync.sql')));
  chk('the sync file before the core file stops and names it', /pnl_grades\.sql first/.test(noCore || ''), noCore && noCore.slice(0, 200));

  /* history first, then the install: this is the backfill's situation */
  q(insertRows(FLAGGED.concat(UNFLAGGED)));
  for (const pass of [1, 2]) {
    FILES.forEach((f) => {
      const out = db.applyFileAtomic(SUP(f));
      chk(f + ' applies (pass ' + pass + '); every report row says ok', !/CHECK THIS/.test(out) && /\|ok/.test(out), out.slice(-500));
    });
  }

  /* ── the odds math ──────────────────────────────────────────────────── */
  const m = one(`select public.pnl_profit_american(150, 'win') a, public.pnl_profit_american(-110, 'win') b,
    public.pnl_profit_american(-110, 'loss') c, public.pnl_profit_american(-110, 'push') d, public.pnl_profit_american(-110, 'void') e,
    public.pnl_profit_american(-110, 'pending') f, public.pnl_profit_american(50, 'win') g, public.pnl_profit_american(null, 'win') h,
    public.pnl_profit_american(150, 'loss') i, public.pnl_profit_american(-150, 'win') j, public.pnl_profit_decimal(2.5, 'win') k,
    public.pnl_profit_decimal(1, 'win') l, public.pnl_profit_american(-110, ' Won ') n2, public.pnl_profit_american(100, 'win') o`);
  chk('+150 win = 1.50', Number(m.a) === 1.5, m.a);
  chk('-110 win = 0.909 (full precision kept: 0.9090…)', near(m.b, 100 / 110) && String(m.b).startsWith('0.90909090'), m.b);
  chk('loss = -1.00', Number(m.c) === -1 && Number(m.i) === -1);
  chk('push = 0.00', Number(m.d) === 0);
  chk('void and pending carry no P&L', m.e === null && m.f === null);
  chk('not American odds (|odds| < 100) and no price carry no P&L', m.g === null && m.h === null && m.l === null);
  chk('-150 win = 0.6667; +100 win = 1.00; decimal 2.50 win = 1.50', near(m.j, 2 / 3) && Number(m.o) === 1 && Number(m.k) === 1.5);
  chk('result spelling is normalised (" Won " is a win)', near(m.n2, 100 / 110));
  /* parity with the existing kernel, and American ↔ decimal, over a grid */
  const grid = [];
  for (let a = -1000; a <= 1000; a += 7) if (Math.abs(a) >= 100) grid.push(a);
  const par = qj(`select a, r, public.pnl_profit_american(a, r) p,
      public.pnl_profit_decimal(case when a > 0 then 1 + a / 100.0 else 1 + 100.0 / abs(a) end, r) d
    from unnest(array[${grid.join(',')}]::numeric[]) a, unnest(array['win','loss','push','void']) r`);
  chk('the SQL arithmetic equals lib/edgedesk_pnl.js profit() on ' + par.length + ' cases', par.every((x) => {
    /* one deliberate difference: the kernel books a void as 0; here a void is
       excluded from P&L (null) and counted separately */
    if (x.r === 'void') return x.p === null;
    return near(x.p, PNL.profit(Number(x.a), 1, x.r));
  }), par.find((x) => x.r !== 'void' && !near(x.p, PNL.profit(Number(x.a), 1, x.r))));
  chk('the decimal path equals the American path on the same price', par.every((x) => (x.p == null ? x.d == null : near(x.p, x.d, 1e-12))));
  chk('decimal → American is exact both sides of evens', one(`select public.pnl_american(2.5) a, public.pnl_american(1.5) b, public.pnl_american(2) c`).a == 150
    && one(`select public.pnl_american(1.5) b`).b == -200 && one(`select public.pnl_american(2) c`).c == 100);

  /* ── the verdict at flag ─────────────────────────────────────────────── */
  const V = (t, e, b, n, r) => one(`select * from public.pnl_verdict_at_flag(${lit(t)}, ${e == null ? 'null' : e}, ${lit(b)}, ${n == null ? 'null' : n}, ${lit(r)})`);
  chk('A · sharp · 3.5% · DraftKings · 6 books → BET', V('A', 0.035, 'DraftKings', 6, 'sharp').verdict === 'BET');
  chk('A · exactly 3% → BET (the board uses ≥)', V('A', 0.03, 'FanDuel', 5, 'sharp').verdict === 'BET');
  chk('A · 2.9% → LEAN, and says the edge was under 3%', /under 3%/.test(V('A', 0.029, 'FanDuel', 6, 'sharp').reason));
  chk('A · offshore with 5 books → LEAN (offshore)', V('A', 0.05, 'Bovada', 5, 'sharp').verdict === 'LEAN' && /offshore/.test(V('A', 0.05, 'Bovada', 5, 'sharp').reason));
  chk('A · 4 books → LEAN (fewer than 5)', /fewer than 5/i.test(V('A', 0.05, 'DraftKings', 4, 'sharp').reason));
  chk('A · consensus reference → LEAN (no sharp)', /No sharp reference/.test(V('A', 0.05, 'DraftKings', 9, 'robust_consensus').reason));
  chk('B → LEAN however good the inputs', V('B', 0.09, 'DraftKings', 12, 'sharp').verdict === 'LEAN');
  chk('offshore with 3 books → PASS', V('A', 0.05, 'Bovada', 3, 'sharp').verdict === 'PASS');
  chk('edge under the 0.5% floor → PASS', V('A', 0.004, 'DraftKings', 9, 'sharp').verdict === 'PASS');
  chk('no frozen tier (pre-v9) → UNLABELLED', V(null, 0.05, 'DraftKings', 9, null).verdict === 'UNLABELLED');
  chk('book names match as the board matches them (substring, any case)', V('A', 0.04, 'ESPN BET', 6, 'sharp').verdict === 'BET' && V('A', 0.04, 'Hard Rock Bet', 6, 'sharp').verdict === 'BET');

  /* ── the dry run ─────────────────────────────────────────────────────── */
  chk('installing writes nothing: history waits for the backfill', one('select count(*) n from public.pnl_grades').n === 0);
  const dry = qj('select * from public.pnl_grades_backfill(false)');
  chk('dry run: says it is a dry run', dry[0].section === 'mode' && /DRY RUN/.test(dry[0].item), dry[0]);
  chk('dry run: would insert one row per flag, and only flags', dry.find((r) => r.item === 'would insert').n === FLAGGED.length, dry.find((r) => r.item === 'would insert'));
  chk('dry run: writes nothing', one('select count(*) n from public.pnl_grades').n === 0);
  const sample = dry.filter((r) => r.section === 'sample');
  chk('dry run: a 20-row sample of graded rows (game, verdict, side, price, result, pnl)', sample.length === 20 && sample.every((r) => / @ [+-]\d+ \(\d/.test(r.detail) && / → (win|loss|push)$/.test(r.detail)), sample.slice(0, 2));
  const EXP = FLAGGED.map((s) => Object.assign({ s }, expected(s)));
  const sum = (rows) => rows.reduce((a, x) => a + (x.pnl || 0), 0);
  const bySport = {};
  EXP.filter((x) => x.status === 'graded').forEach((x) => { (bySport[x.s.sport_title] = bySport[x.s.sport_title] || []).push(x); });
  chk('dry run: totals per sport equal the independent recomputation', Object.keys(bySport).every((k) => {
    const r = dry.find((d) => d.section === 'sport' && d.item === k);
    return r && r.n === bySport[k].length && near(r.units, Math.round(sum(bySport[k]) * 100) / 100, 0.0051);
  }), dry.filter((d) => d.section === 'sport'));

  /* ── the commit, then again ─────────────────────────────────────────── */
  const c1 = qj('select * from public.pnl_grades_backfill(true)');
  chk('commit: inserts one row per flag', c1.find((r) => r.item === 'inserted').n === FLAGGED.length && c1.find((r) => r.item === 'errors (see pnl_grades_errors)').n === 0, c1.slice(0, 5));
  const c2 = qj('select * from public.pnl_grades_backfill(true)');
  chk('commit again: inserts nothing, updates nothing (idempotent)', c2.find((r) => r.item === 'inserted').n === 0 && c2.find((r) => r.item === 'updated').n === 0
    && c2.find((r) => r.item === 'unchanged').n === FLAGGED.length, c2.slice(0, 5));
  chk('…and leaves no history behind', one('select count(*) n from public.pnl_grades_history').n === 0);
  chk('unflagged rows never get a P&L row', one(`select count(*) n from public.pnl_grades where sig_key like 'unf%'`).n === 0);
  chk('the primary key refuses a second row for the same flag', !!db.mustFail(() => q(`insert into public.pnl_grades select * from public.pnl_grades limit 1`)));

  /* ── every row against the raw signal ───────────────────────────────── */
  const ROWS = qj('select p.*, s.flagged_best_dec raw_price, s.result raw_result, s.closing_dec raw_close from public.pnl_grades p join public.signals s using (sig_key) order by p.sig_key');
  const bad = ROWS.filter((r) => {
    const x = expected(EXP.find((e) => e.s.sig_key === r.sig_key).s);
    return r.verdict !== x.verdict || r.pnl_status !== x.status || (r.result || null) !== x.result || Number(r.stake_units) !== x.stake
      || (x.pnl == null ? r.pnl_units != null : !near(r.pnl_units, x.pnl)) || (x.pnl_close == null ? r.pnl_units_at_close != null : !near(r.pnl_units_at_close, x.pnl_close))
      || r.calc_version !== 'pnl-v1';
  });
  chk('every one of ' + ROWS.length + ' rows equals the independent recomputation from its raw signal', bad.length === 0, bad.slice(0, 2));
  chk('every status is represented', ['graded', 'void', 'ungraded_missing_price', 'ungraded_unsettled', 'ungraded_unsupported', 'not_a_bet'].every((st) => ROWS.some((r) => r.pnl_status === st)), [...new Set(ROWS.map((r) => r.pnl_status))]);
  chk('BET, LEAN, PASS and UNLABELLED are all represented', ['BET', 'LEAN', 'PASS', 'UNLABELLED'].every((v) => ROWS.some((r) => r.verdict === v)));
  chk('a missing flag price is never filled from first_best_dec or the close', ROWS.filter((r) => r.raw_price == null || Number(r.raw_price) <= 1).every((r) => r.pnl_units == null && r.price_at_flag == null));
  chk('a missing price is named: no_flag_price / invalid_flag_price', ROWS.some((r) => r.pnl_reason === 'no_flag_price') && ROWS.some((r) => r.pnl_reason === 'invalid_flag_price'));
  const HAND = ROWS.filter((r) => r.pnl_status === 'graded').sort((a, b) => (require('crypto').createHash('md5').update(a.sig_key).digest('hex') < require('crypto').createHash('md5').update(b.sig_key).digest('hex') ? -1 : 1)).slice(0, 10)
    .map((r) => {
      const d = Number(r.raw_price), am = d >= 2 ? (d - 1) * 100 : -100 / (d - 1), res = PNL.normResult(r.raw_result);
      const hand = res === 'win' ? (am > 0 ? am / 100 : 100 / Math.abs(am)) : res === 'loss' ? -1 : 0;
      return { game: r.event_label, side: r.selection + (r.point == null ? '' : ' ' + r.point), raw_dec: d, american: Math.round(am), raw_result: r.raw_result, db_pnl: Number(r.pnl_units), hand_pnl: hand, match: near(r.pnl_units, hand) };
    });
  chk('hand check: 10 graded rows, raw signal → American math by hand = the stored P&L', HAND.length === 10 && HAND.every((h) => h.match), HAND.filter((h) => !h.match));

  /* ── pnl_summary against raw sums ───────────────────────────────────── */
  const S = qj(`select * from public.pnl_summary where period_type = 'all' and market_type = 'ALL'`);
  const raw = qj(`select case when grouping(sport_key) = 1 then null else coalesce(sport_key, 'unknown') end sport_key, verdict,
      count(*) filter (where pnl_status = 'graded') g, coalesce(sum(pnl_units), 0) u,
      count(*) filter (where result = 'push' and pnl_status = 'graded') p, count(*) filter (where pnl_status = 'void') v
    from public.pnl_grades where settled_at is not null or event_at <= now() group by grouping sets ((sport_key, verdict), ())`);
  chk('pnl_summary equals a raw SQL sum for every sport × verdict and in total', raw.every((r) => {
    const s = S.find((x) => x.sport_key === (r.sport_key || 'ALL') && x.verdict === (r.verdict || 'ALL'));
    return s && s.graded === r.g && near(s.units_won, r.u) && s.pushes === r.p && s.void === r.v;
  }), raw.find((r) => { const s = S.find((x) => x.sport_key === (r.sport_key || 'ALL') && x.verdict === (r.verdict || 'ALL')); return !s || !near(s.units_won, r.u); }));
  const ALL = S.find((x) => x.sport_key === 'ALL' && x.verdict === 'ALL');
  const G = EXP.filter((x) => x.status === 'graded');
  chk('…and equals the JS sum of the independent recomputation', near(ALL.units_won, sum(G)) && ALL.graded === G.length, { db: ALL.units_won, js: sum(G) });
  chk('a push is 1u risked and returned; a void is not risked', Number(ALL.units_risked) === G.length && ALL.pushes === G.filter((x) => x.result === 'push').length
    && ALL.void === EXP.filter((x) => x.status === 'void' && !(x.s.result === null && Date.parse(x.s.commence_time) > Date.now())).length);
  chk('ROI = units won ÷ units risked × 100', near(ALL.roi_pct, 100 * sum(G) / G.length, 1e-9));
  chk('BET and LEAN are rolled up separately', S.some((x) => x.sport_key === 'ALL' && x.verdict === 'BET') && S.some((x) => x.sport_key === 'ALL' && x.verdict === 'LEAN'));
  chk('the at-close comparison counts only rows with a closing price', ALL.graded_with_close === G.filter((x) => x.pnl_close != null).length && near(ALL.units_won_at_close, G.reduce((a, x) => a + (x.pnl_close || 0), 0)));
  const per = one(`select (select sum(units_won) from public.pnl_summary where period_type = 'month' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL') m,
    (select sum(units_won) from public.pnl_summary where period_type = 'week' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL') w,
    (select sum(units_won) from public.pnl_summary where period_type = 'day' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL') d`);
  chk('months, weeks and days each add back up to all time', near(per.m, ALL.units_won) && near(per.w, ALL.units_won) && near(per.d, ALL.units_won), per);
  chk('market types are rolled up (moneyline, spread, total, player_prop)', ['moneyline', 'spread', 'total', 'player_prop'].every((mt) => qj(`select 1 from public.pnl_summary where period_type = 'all' and sport_key = 'ALL' and verdict = 'ALL' and market_type = ${lit(mt)}`).length === 1));
  const future = FLAGGED.filter((s) => s.result === null && Date.parse(s.commence_time) > Date.now()).length;
  const flagsSeen = one(`select sum(flags) n from public.pnl_summary where period_type = 'all' and sport_key = 'ALL' and verdict = 'ALL' and market_type = 'ALL'`).n;
  chk('the live board is not counted: a flag whose game has not started is nowhere in the summary', future > 0 && flagsSeen === FLAGGED.length - future, { flagsSeen, future, n: FLAGGED.length });

  /* ── reconciliation ─────────────────────────────────────────────────── */
  const rec0 = qj('select * from public.pnl_reconciliation()');
  chk('reconciliation after the backfill: every check is 0 / ok', rec0.length === 5 && rec0.every((r) => r.state === 'ok'), rec0);

  /* ── the settlement hook, as the jobs write ─────────────────────────── */
  const pend = FLAGGED.find((s) => s.result === null && Date.parse(s.commence_time) < Date.now() && s.flagged_best_dec > 1 && s.flagged_tier && expected(s).verdict !== 'PASS');
  const before = one(`select computed_at from public.pnl_grades where sig_key = ${lit(pend.sig_key)}`);
  db.service(`update public.signals set result = 'win', graded_at = now() where sig_key = ${lit(pend.sig_key)};`);
  const after = one(`select * from public.pnl_grades where sig_key = ${lit(pend.sig_key)}`);
  chk('settle writes a result → the P&L row is graded in the same statement', after.pnl_status === 'graded' && near(after.pnl_units, pend.flagged_best_dec - 1) && after.computed_at !== before.computed_at, after);
  chk('…and the change is in the history as result_changed', one(`select count(*) n from public.pnl_grades_history where sig_key = ${lit(pend.sig_key)} and change = 'result_changed'`).n === 1);
  db.service(`update public.signals set result = 'loss' where sig_key = ${lit(pend.sig_key)};`);
  chk('a corrected result updates the same row (−1) and is logged again', Number(one(`select pnl_units from public.pnl_grades where sig_key = ${lit(pend.sig_key)}`).pnl_units) === -1
    && one(`select count(*) n from public.pnl_grades_history where sig_key = ${lit(pend.sig_key)}`).n === 2);
  chk('the history refuses edits and deletes', !!db.mustFail(() => q('delete from public.pnl_grades_history')) && !!db.mustFail(() => q(`update public.pnl_grades_history set change = 'x'`)));
  /* a brand-new signal: capture inserts it unflagged, flags it, close closes it, settle settles it */
  db.service(`insert into public.signals (sig_key, event_id, sport_key, sport_title, commence_time, home_team, away_team, market, selection, point, best_dec)
    values ('new|spreads|Bears|3.5', 'new', 'americanfootball_nfl', 'NFL', now() - interval '4 hours', 'Packers', 'Bears', 'spreads', 'Bears', 3.5, 1.95);`);
  chk('an unflagged insert writes no P&L row', !one(`select 1 x from public.pnl_grades where sig_key = 'new|spreads|Bears|3.5'`));
  db.service(`update public.signals set flagged_at = now() - interval '30 hours', flagged_edge = 0.034, flagged_best_dec = 1.95, flagged_best_book = 'DraftKings',
    flagged_tier = 'A', flagged_reference_type = 'sharp', flagged_fresh_books = 7, flagged_policy = 'capture-v9' where sig_key = 'new|spreads|Bears|3.5';`);
  const nf = one(`select * from public.pnl_grades where sig_key = 'new|spreads|Bears|3.5'`);
  chk('capture freezes a flag → a P&L row appears, BET, awaiting its result', nf && nf.verdict === 'BET' && nf.pnl_status === 'ungraded_unsettled' && nf.pnl_reason === 'awaiting_result', nf);
  db.service(`update public.signals set closing_dec = 1.87, closing_sharp_fair = 0.53, clv = 0.03, closed_at = now() where sig_key = 'new|spreads|Bears|3.5';`);
  db.service(`update public.signals set result = 'win', graded_at = now() where sig_key = 'new|spreads|Bears|3.5';`);
  const ns = one(`select * from public.pnl_grades where sig_key = 'new|spreads|Bears|3.5'`);
  chk('settle settles it → graded at the FLAG price (+0.95), the close kept beside it (+0.87)', ns.pnl_status === 'graded' && near(ns.pnl_units, 0.95) && near(ns.pnl_units_at_close, 0.87)
    && near(ns.price_at_flag_american, -100 / 0.95), ns);
  /* a capture pass that only re-prices must not touch the P&L row */
  const c0 = one(`select computed_at, (select count(*) from public.pnl_grades_history) h from public.pnl_grades where sig_key = 'new|spreads|Bears|3.5'`);
  db.service(`insert into public.signals (sig_key, best_dec, last_seen_at, edge) values ('new|spreads|Bears|3.5', 1.80, now(), -0.02)
    on conflict (sig_key) do update set best_dec = excluded.best_dec, last_seen_at = excluded.last_seen_at, edge = excluded.edge;`);
  db.service(`update public.signals set flagged_best_dec = 2.4, flagged_tier = 'B' where sig_key = 'new|spreads|Bears|3.5';`);
  const c1b = one(`select computed_at, price_at_flag, verdict, (select count(*) from public.pnl_grades_history) h from public.pnl_grades where sig_key = 'new|spreads|Bears|3.5'`);
  chk('a capture re-price, and an attempt to move the frozen flag price, change nothing', c1b.computed_at === c0.computed_at && c1b.h === c0.h && Number(c1b.price_at_flag) === 1.95 && c1b.verdict === 'BET', c1b);
  chk('reconciliation stays at 0 through all of it', qj('select * from public.pnl_reconciliation()').every((r) => r.state === 'ok'));

  /* ── a P&L fault never fails the signals write ──────────────────────── */
  const victim = FLAGGED.find((s) => s.result === 'pending' && s.flagged_best_dec > 1 && expected(s).verdict !== 'PASS');
  q(`alter table public.pnl_grades add constraint pnl_test_fault check (sig_key <> ${lit(victim.sig_key)} or pnl_status <> 'graded') not valid;`);
  db.service(`update public.signals set result = 'win', graded_at = now() where sig_key = ${lit(victim.sig_key)};`);
  chk('the settle write succeeded although its P&L write failed', one(`select result from public.signals where sig_key = ${lit(victim.sig_key)}`).result === 'win');
  const rec1 = qj('select * from public.pnl_reconciliation()');
  chk('reconciliation sees it: one row out of step, one unrepaired error', rec1.find((r) => /out of step/.test(r.check_name)).n === 1 && rec1.find((r) => /not yet repaired/.test(r.check_name)).n === 1, rec1);
  q('alter table public.pnl_grades drop constraint pnl_test_fault;');
  const fix = qj('select * from public.pnl_grades_backfill(true)');
  chk('the backfill repairs it (one update) and reconciliation returns to 0', fix.find((r) => r.item === 'updated').n === 1 && qj('select * from public.pnl_reconciliation()').every((r) => r.state === 'ok'), fix.slice(0, 5));
  /* a settled flag the trigger never saw (the hook disabled) */
  q('alter table public.signals disable trigger pnl_grades_on_signal_upd_trg;');
  q(`update public.signals set flagged_at = now() - interval '2 days', flagged_best_dec = 2.1, flagged_edge = 0.02, flagged_tier = 'A', flagged_reference_type = 'sharp',
      flagged_fresh_books = 6, flagged_best_book = 'FanDuel', commence_time = now() - interval '1 day', result = 'loss', graded_at = now() where sig_key = 'unf0';`);
  q('alter table public.signals enable trigger pnl_grades_on_signal_upd_trg;');
  chk('a settled flag with no P&L row is counted (≠ 0)', qj('select * from public.pnl_reconciliation()')[0].n === 1);
  qj('select * from public.pnl_grades_backfill(true)');
  chk('…and the backfill brings it back to 0', qj('select * from public.pnl_reconciliation()')[0].n === 0);

  /* ── who may read and write ─────────────────────────────────────────── */
  const anonRows = JSON.parse(db.anon(`select coalesce(json_agg(sig_key), '[]') from public.pnl_grades;`) || '[]');
  const live = FLAGGED.filter((s) => s.result === null && Date.parse(s.commence_time) > Date.now()).map((s) => s.sig_key);
  chk('anon reads graded and started rows', anonRows.length > 50);
  chk('anon never reads the live board (a flag whose game has not started)', live.length > 0 && live.every((k) => !anonRows.includes(k)));
  chk('anon cannot insert, update or delete', !!db.mustFail(() => db.anon(`update public.pnl_grades set pnl_units = 99;`)) && !!db.mustFail(() => db.anon(`delete from public.pnl_grades;`))
    && !!db.mustFail(() => db.anon(`insert into public.pnl_grades select * from public.pnl_grades limit 1;`)));
  const A = '00000000-0000-0000-0000-00000000000a';
  chk('a signed-in reader cannot write either', !!db.mustFail(() => db.as(A, `update public.pnl_grades set pnl_units = 99;`)));
  chk('anon reads pnl_summary and asks pnl_reconciliation()', JSON.parse(db.anon(`select count(*) from public.pnl_summary;`)) > 0 && /ok/.test(db.anon(`select state from public.pnl_reconciliation() limit 1;`)));
  chk('anon cannot run the backfill or the writer', !!db.mustFail(() => db.anon(`select * from public.pnl_grades_backfill(true);`)) && !!db.mustFail(() => db.anon(`select public.pnl_grades_write(null);`)));
  chk('the service role runs the backfill', /mode/.test(db.service(`select section from public.pnl_grades_backfill(false) limit 1;`)));
  chk('no one deletes or truncates the record, the service role included', !!db.mustFail(() => db.service(`delete from public.pnl_grades;`)) && !!db.mustFail(() => q(`truncate public.pnl_grades;`)));
  chk('a graded signal cannot be deleted out from under its P&L row', !!db.mustFail(() => q(`delete from public.signals where sig_key = ${lit(pend.sig_key)};`)));
  chk('a stored P&L that disagrees with its own price is re-derived (no invented figure survives)', (() => {
    q(`update public.pnl_grades set pnl_units = 42 where sig_key = ${lit(pend.sig_key)};`);
    return Number(one(`select pnl_units from public.pnl_grades where sig_key = ${lit(pend.sig_key)}`).pnl_units) === -1;
  })());

  /* ── the production audit: read-only, and it agrees ─────────────────── */
  const AUD = fs.readFileSync(SUP('audits/pnl_grades_check.sql'), 'utf8');
  const audOut = q('begin transaction read only;\n' + AUD + '\nrollback;');
  const audRows = audOut.split('\n').filter((l) => /\|(ok|CHECK THIS)$/.test(l));
  chk('audits/pnl_grades_check.sql runs inside a READ ONLY transaction and every row says ok',
    audRows.length >= 10 + 5 && audRows.every((l) => /\|ok$/.test(l)), audRows.filter((l) => !/\|ok$/.test(l)).slice(0, 3));
  chk('…its hand check covers 10 rows and its summary check covers every sport × verdict', audRows.filter((l) => /^hand\|/.test(l)).length === 10
    && audRows.filter((l) => /^summary\|/.test(l)).length === one('select count(*) n from (select 1 from public.pnl_grades group by grouping sets ((sport_key, verdict), ())) t').n);
  if (SHOW) { console.log('\n── audits/pnl_grades_check.sql ──'); audRows.forEach((l) => console.log(l)); }

  /* ── a new calc_version leaves a trail ──────────────────────────────── */
  const hBefore = one('select count(*) n from public.pnl_grades_history').n;
  q(`create or replace function public.pnl_calc_version() returns text language sql immutable as $f$ select 'pnl-v2'::text $f$;`);
  chk('reconciliation flags rows on an older calc_version', qj('select * from public.pnl_reconciliation()').find((r) => /calc_version/.test(r.check_name)).n === FLAGGED.length + 2);
  const rc = qj('select * from public.pnl_grades_backfill(true)');
  chk('a new calc_version recalculates every row and logs each one as recalculated', rc.find((r) => r.item === 'updated').n === FLAGGED.length + 2
    && one(`select count(*) n from public.pnl_grades_history where change = 'recalculated'`).n === FLAGGED.length + 2
    && one('select count(*) n from public.pnl_grades_history').n === hBefore + FLAGGED.length + 2);
  db.applyFileAtomic(SUP('pnl_grades.sql'));
  qj('select * from public.pnl_grades_backfill(true)');

  if (SHOW) {
    console.log('\n── DRY RUN (as the SQL editor prints it) ──');
    dry.forEach((r) => console.log([r.section, r.item, r.detail || '', r.n == null ? '' : r.n, r.units == null ? '' : r.units].join(' | ')));
    console.log('\n── HAND CHECK: 10 graded rows, raw signal vs stored P&L ──');
    console.table(HAND);
    console.log('\n── pnl_summary vs raw SQL sum (all time) ──');
    console.table(raw.map((r) => { const s = S.find((x) => x.sport_key === (r.sport_key || 'ALL') && x.verdict === (r.verdict || 'ALL')); return { sport: r.sport_key || 'ALL', verdict: r.verdict || 'ALL', summary_units: Number(s.units_won), raw_sum: Number(r.u), graded: s.graded, match: near(s.units_won, r.u) }; }));
  }
} catch (e) {
  chk('the suite ran to the end', false, String(e.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());

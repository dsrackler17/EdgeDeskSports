#!/usr/bin/env node
/* ===========================================================================
   supabase/signal_pnl.sql, signal_pnl_summary.sql, signal_pnl_sync.sql and
   signal_pnl_backfill.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   The signals table is built the way production got it: the pre-v9 shape,
   then the repository's own capture_v9_qualification.sql (which installs the
   flag-price freeze) and close_v7_parity.sql. A seeded, realistic history is
   written into it — four sports, three tiers, alternate lines, provider
   decimals, voids, missing flag prices, unreadable results, games not yet
   played, signals never flagged — and then the P&L files are applied the way
   the SQL editor runs them (one transaction per paste).

   Proves:
     - each file refuses to run out of order, applies twice, reports ok;
     - the backfill DRY RUN writes nothing; the commit writes one row per
       closed or settled flag; a second commit writes nothing (idempotent);
     - every stored row equals lib/edgedesk_edge_pnl.js on the raw signal
       (status, reason, P&L at the flag price and at the close) — two
       implementations in two languages, one answer;
     - pnl_summary equals a raw SQL sum and an independent JS sum, at every
       grain; pnl_verify() is all ok; 10 random rows hand-check against the raw
       signal through the American formula;
     - THE HOOK: settling a flag writes its P&L row in the same transaction
       (a rolled-back settlement leaves no row); a corrected result rewrites
       the row and is logged; capture's routine refresh fires nothing;
     - THE HOOK NEVER FAILS A SETTLEMENT: with the P&L code sabotaged, the
       settlement still commits, the error is logged, the reconciliation goes
       red, and the backfill repairs it;
     - nothing can be deleted, an invented figure is refused by the table
       itself, a calc_version change is logged;
     - anon reads settled rows and the summary, never a game that has not
       started, never writes, never runs the backfill.

   PNL_SHOW=1 prints the dry run and the hand-check table.
   Run: node tools/record/signal_pnl_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const P = require(path.join(PG.ROOT, 'lib', 'edgedesk_edge_pnl.js'));

const T = PG.kit('flagged-edge P&L SQL');
const chk = T.chk;
const lit = PG.lit;
const SHOW = process.env.PNL_SHOW === '1';
const F = (n) => path.join(PG.ROOT, 'supabase', n);
const CORE = F('signal_pnl.sql'), SUM = F('signal_pnl_summary.sql'), SYNC = F('signal_pnl_sync.sql'), BACK = F('signal_pnl_backfill.sql');

/* ── the files themselves ─────────────────────────────────────────────── */
[CORE, SUM, SYNC].forEach((p) => {
  const n = path.basename(p), s = fs.readFileSync(p, 'utf8');
  chk(n + ': no psql meta-commands', !/^\\/m.test(s));
  chk(n + ': idempotent create statements', /create or replace (function|view)/.test(s));
  chk(n + ': additive — nothing is dropped', !/\bdrop table\b/i.test(s) && !/\bdrop column\b/i.test(s) && !/\bdrop view\b/i.test(s) && !/\bdrop function\b/i.test(s));
  chk(n + ': it ends in a report', /CHECK THIS/.test(s) && /order by 1;\s*$/.test(s));
  chk(n + ': PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(s));
  chk(n + ': under the SQL editor paste limit (18 KB)', Buffer.byteLength(s) <= 18000, Buffer.byteLength(s));
});
const back = fs.readFileSync(BACK, 'utf8');
chk('the backfill file is a dry run: it calls pnl_backfill() with no argument and nothing else', /^select \* from public\.pnl_backfill\(\);\s*$/m.test(back)
  && (back.match(/^[^-\n].*$/gm) || []).filter((l) => l.trim()).length === 1, back.match(/^[^-\n].*$/gm));
chk('the hook never touches capture\'s qualification: no write to signals anywhere in the P&L files',
  [CORE, SUM, SYNC].every((p) => !/(update|insert into|delete from)\s+public\.signals\b/i.test(fs.readFileSync(p, 'utf8'))));

const db = PG.start('edgepnl');
if (db.skip) {
  if (process.env.PNL_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}

/* ── a realistic history (TEST data: tools/record/signal_pnl_fixture.js) ── */
const FX = require('./signal_pnl_fixture.js');
const SPORTS = FX.SPORTS;
const NOW = Date.now(), H = 3600e3, iso = (ms) => new Date(ms).toISOString();
const SIGNALS = FX.signals({ now: NOW });
const insertSql = (rows) => FX.insertSql(rows, lit);

const expected = {};
SIGNALS.forEach((s) => { const g = P.grade(s); if (g) expected[s.sig_key] = g; });
const EXPECTED_KEYS = Object.keys(expected);

const ok = (out) => !/CHECK THIS/.test(out);
const parse = (out, keys) => out ? out.split('\n').map((l) => { const p = l.split('|'); const o = {}; keys.forEach((k, i) => { o[k] = p[i] === '' ? null : p[i]; }); return o; }) : [];
/* rows as JSON: a sig_key carries '|', psql's own column separator */
const q = (sql) => JSON.parse(db.sql("select coalesce(json_agg(t), '[]'::json) from (" + sql + ") t;"));
const num = (v) => (v === null || v === undefined || v === 'null' ? null : Number(v));
const near = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-12);

try {
  chk('the production signals schema builds (capture v9 + close v7, the repository\'s own files)', FX.buildSchema(db));
  db.sql(insertSql(SIGNALS));
  chk('the seeded history is in', db.sql('select count(*) from public.signals;') === String(SIGNALS.length));

  /* ── order, idempotency, reports ─────────────────────────────────────── */
  const early = db.mustFail(() => db.applyFileAtomic(SUM));
  chk('the summary file before the core file stops and names it', /signal_pnl\.sql/.test(early || ''), early && early.slice(0, 200));
  const early2 = db.mustFail(() => db.applyFileAtomic(SYNC));
  chk('the sync file before the others stops and names them', /signal_pnl\.sql/.test(early2 || '') && /signal_pnl_summary\.sql/.test(early2 || ''), early2 && early2.slice(0, 200));
  let out = db.applyFileAtomic(CORE);
  chk('signal_pnl.sql applies; every report row says ok', ok(out) && (out.match(/\|ok$/gm) || []).length === 6, out);
  chk('and a second time', ok(db.applyFileAtomic(CORE)));
  out = db.applyFileAtomic(SUM);
  chk('signal_pnl_summary.sql applies; every report row says ok', ok(out) && (out.match(/\|ok$/gm) || []).length === 4, out);
  chk('and a second time', ok(db.applyFileAtomic(SUM)));
  out = db.applyFileAtomic(SYNC);
  chk('signal_pnl_sync.sql applies; rows 1-4 ok', ok(out) && (out.match(/\|ok$/gm) || []).length === 4, out);
  chk('its last row says the history still needs the backfill, and how many', new RegExp('NEXT: ' + EXPECTED_KEYS.length + ' flags need the backfill').test(out), out.split('\n').pop());
  chk('and a second time', ok(db.applyFileAtomic(SYNC)));
  chk('installing wrote no P&L row by itself', db.sql('select count(*) from public.pnl_grades;') === '0');

  /* ── the dry run ──────────────────────────────────────────────────────── */
  const KEYS = ['section', 'line', 'sport', 'item', 'pick', 'price', 'result', 'pnl_units', 'note'];
  const dry = parse(db.applyFileAtomic(BACK), KEYS);
  chk('the dry run writes nothing', db.sql('select count(*) from public.pnl_grades;') === '0');
  chk('it says it is a dry run, and how to write it', /DRY RUN/.test(dry[0].item) && /pnl_backfill\(true\)/.test(dry[0].item));
  const cnt = (label) => { const r = dry.find((x) => x.section === 'counts' && x.item.indexOf(label) === 0); return r ? Number(r.note) : null; };
  const exp = { all: EXPECTED_KEYS.length, graded: 0, void: 0, missing: 0, unsettled: 0, outside: 0 };
  EXPECTED_KEYS.forEach((k) => { const g = expected[k]; exp[{ graded: 'graded', void: 'void', ungraded_missing_price: 'missing', ungraded_unsettled: 'unsettled' }[g.pnl_status]]++; if (g.record_scope !== 'record') exp.outside++; });
  chk('dry-run counts equal an independent count of the raw signals', cnt('flags that reached') === exp.all && cnt('would insert') === exp.all && cnt('graded') === exp.graded
    && cnt('void') === exp.void && cnt('ungraded: no valid') === exp.missing && cnt('ungraded: waiting') === exp.unsettled && cnt('outside') === exp.outside, [exp, dry.filter((x) => x.section === 'counts')]);
  const sample = dry.filter((x) => x.section === 'sample');
  chk('a 20-row sample: game, pick, price, result, P&L', sample.length === 20 && sample.every((x) => x.item && x.pick && x.price && x.result && x.pnl_units));
  chk('the sample shows the ungraded kinds as well as graded bets', ['void', 'ungraded_missing_price', 'ungraded_unsettled', 'graded'].every((s) => sample.some((x) => x.note.indexOf(s) === 0)));
  chk('a sample win at 1.91 reads −110 and +0.91', sample.some((x) => /^-110 \(1\.91\)$/.test(x.price) && x.result === 'win' && x.pnl_units === '+0.91') || !sample.some((x) => /\(1\.91\)/.test(x.price) && x.result === 'win'));
  const totals = dry.filter((x) => x.section === 'totals');
  chk('totals per sport plus all sports', totals.length === SPORTS.length + 1 && totals[totals.length - 1].sport === 'ALL SPORTS');
  chk('the dry run shows the math checks, all ok', dry.filter((x) => x.section === 'check').length === 5 && dry.filter((x) => x.section === 'check').every((x) => x.note === 'ok'));
  chk('the same sample every run (it is chosen, not random)', JSON.stringify(parse(db.sql('select * from public.pnl_backfill();'), KEYS).filter((x) => x.section === 'sample')) === JSON.stringify(sample));
  if (SHOW) {
    console.log('\n── DRY RUN (select * from public.pnl_backfill();) ──');
    dry.forEach((x) => console.log([x.section, x.line, x.sport || '', x.item || '', x.pick || '', x.price || '', x.result || '', x.pnl_units || '', x.note || ''].join(' | ')));
  }

  /* ── the commit, twice ────────────────────────────────────────────────── */
  const c1 = parse(db.sql('select * from public.pnl_backfill(true);'), KEYS);
  chk('the commit writes one row per closed or settled flag', new RegExp('WRITTEN: ' + exp.all + ' inserted, 0 updated').test(c1[0].item) && db.sql('select count(*) from public.pnl_grades;') === String(exp.all), c1[0]);
  chk('every check after the commit is ok', c1.filter((x) => x.section === 'check').length === 12 && c1.filter((x) => x.section === 'check').every((x) => x.note === 'ok'), c1.filter((x) => x.section === 'check' && x.note !== 'ok'));
  const c2 = parse(db.sql('select * from public.pnl_backfill(true);'), KEYS);
  chk('a second commit writes nothing (idempotent)', /WRITTEN: 0 inserted, 0 updated, \d+ already correct/.test(c2[0].item) && db.sql('select count(*) from public.pnl_grades;') === String(exp.all), c2[0]);
  chk('never-flagged signals get no row', db.sql("select count(*) from public.pnl_grades where sig_key like 'unflagged|%';") === '0');
  chk('flags not yet closed or settled get no row', db.sql("select count(*) from public.pnl_grades g join public.signals s using (sig_key) where s.closed_at is null and s.result is null;") === '0');
  chk('no history was written for first-time rows', db.sql('select count(*) from public.pnl_grade_history;') === '0');

  /* ── SQL = JS on every row ─────────────────────────────────────────────── */
  const stored = q('select sig_key, pnl_status, ungraded_reason, pnl_units, pnl_units_at_close, tier, market_type, record_scope, stake_units, price_at_flag, calc_version from public.pnl_grades order by sig_key');
  const off = stored.filter((r) => {
    const e = expected[r.sig_key];
    return !e || e.pnl_status !== r.pnl_status || (e.ungraded_reason || null) !== r.ungraded_reason || !near(e.pnl_units, num(r.pnl_units)) || !near(e.pnl_units_at_close, num(r.pnl_units_at_close))
      || e.tier !== r.tier || e.market_type !== r.market_type || e.record_scope !== r.record_scope || e.stake_units !== num(r.stake_units) || r.calc_version !== 'pnl-v1'
      || (e.price_at_flag === null ? r.price_at_flag !== null : Math.abs(e.price_at_flag - num(r.price_at_flag)) > 1e-9);
  });
  chk('every stored row equals lib/edgedesk_edge_pnl.js on the raw signal (' + stored.length + ' rows)', stored.length === exp.all && off.length === 0, off.slice(0, 3).map((r) => [r, expected[r.sig_key]]));
  chk('the brief\'s numbers, in the table: 1.91 win = 0.91, 2.5 win = 1.5, loss = -1, push = 0',
    db.sql("select bool_and(case when result = 'loss' then pnl_units = -1 when result = 'push' then pnl_units = 0 else pnl_units = price_at_flag_dec - 1 end) from public.pnl_grades where pnl_status = 'graded';") === 't');
  chk('no void, missing-price or unsettled row carries a P&L, a stake or a close P&L',
    db.sql("select count(*) from public.pnl_grades where pnl_status <> 'graded' and (pnl_units is not null or pnl_units_at_close is not null or stake_units <> 0);") === '0');
  chk('a missing flag price is never filled from the close, even when the close exists',
    db.sql("select count(*) from public.pnl_grades g join public.signals s using (sig_key) where s.flagged_best_dec is null and s.closing_dec is not null and s.result in ('win','loss','push');") !== '0'
    && db.sql("select count(*) from public.pnl_grades g join public.signals s using (sig_key) where s.flagged_best_dec is null and (g.pnl_units is not null or g.pnl_status <> 'ungraded_missing_price') and s.result in ('win','loss','push');") === '0');

  /* ── summary = raw SQL = independent JS ───────────────────────────────── */
  const rawTot = db.sql("select count(*) || '|' || coalesce(sum(pnl_units), 0) from public.pnl_grades where record_scope = 'record' and pnl_status = 'graded';").split('|');
  const sumTot = db.sql("select graded || '|' || units_won from public.pnl_summary where grain = 'all' and breakdown = 'total';").split('|');
  let jsU = 0, jsN = 0;
  EXPECTED_KEYS.forEach((k) => { const g = expected[k]; if (g.pnl_status === 'graded' && g.record_scope === 'record') { jsU += g.pnl_units; jsN++; } });
  chk('pnl_summary all-time = raw SQL sum = independent JS sum', sumTot[0] === rawTot[0] && Number(sumTot[1]) === Number(rawTot[1]) && Number(rawTot[0]) === jsN && Math.abs(Number(rawTot[1]) - jsU) < 1e-9,
    { summary: sumTot, raw: rawTot, js: [jsN, jsU] });
  chk('every grain adds up to all-time (day, week and month, per sport and tier)',
    db.sql(`select count(*) from (select g.grain, g.sport_key, g.tier, sum(g.units_won) u, sum(g.graded) n from public.pnl_summary g where g.grain in ('day','week','month') and g.breakdown = 'sport+tier' group by 1, 2, 3) d
      join public.pnl_summary a on a.grain = 'all' and a.breakdown = 'sport+tier' and a.sport_key = d.sport_key and a.tier = d.tier where d.u <> a.units_won or d.n <> a.graded;`) === '0');
  chk('sport rows add up to the total, tier rows too',
    db.sql("select (select sum(units_won) from public.pnl_summary where grain='all' and breakdown='sport') = (select units_won from public.pnl_summary where grain='all' and breakdown='total') and (select sum(graded) from public.pnl_summary where grain='all' and breakdown='tier') = (select graded from public.pnl_summary where grain='all' and breakdown='total');") === 't');
  chk('ROI = units won / units risked × 100, a push not risked',
    db.sql("select bool_and(roi_pct is not distinct from case when units_risked > 0 then units_won / units_risked * 100 end and units_risked = wins + losses) from public.pnl_summary;") === 't');
  const verify = q('select * from public.pnl_verify()');
  chk('pnl_verify(): all 12 checks ok', verify.length === 12 && verify.every((v) => v.status === 'ok'), verify.filter((v) => v.status !== 'ok'));

  /* ── the hand-check ───────────────────────────────────────────────────── */
  const hc = q('select * from public.pnl_handcheck(10)');
  chk('pnl_handcheck(10): 10 random rows, every one matches the raw signal', hc.length === 10 && hc.every((r) => r.matches === true), hc.filter((r) => r.matches !== true));
  /* and a third, separate check: JS reads the RAW signal row and recomputes */
  const rawBy = {};
  q('select sig_key, flagged_best_dec, result, closing_dec from public.signals where sig_key in (' + hc.map((r) => lit(r.sig_key)).join(',') + ')').forEach((r) => { rawBy[r.sig_key] = r; });
  const jsHand = hc.map((r) => {
    const s = rawBy[r.sig_key], am = P.american(s.flagged_best_dec);
    const js = am === null ? null : P.unitsAmerican(am, s.result);
    return { r, js, ok: (js === null && r.stored_pnl === null) || (js !== null && r.stored_pnl !== null && Math.abs(js - num(r.stored_pnl)) < 1e-9) };
  });
  chk('the same 10 rows recomputed in JS from the raw signal, through the American formula', jsHand.every((x) => x.ok), jsHand.filter((x) => !x.ok));
  if (SHOW) {
    console.log('\n── HAND-CHECK (select * from public.pnl_handcheck(10);) + JS recompute from the raw signal ──');
    console.log('game | pick | raw flag dec | raw result | raw close dec | stored status | stored price | stored P&L | SQL recompute | JS recompute | stored @close | match');
    const d = (v) => (v === null || v === undefined ? '—' : String(v));
    jsHand.forEach((x) => console.log([x.r.game, x.r.pick, d(x.r.raw_flagged_best_dec), d(x.r.raw_result), d(x.r.raw_closing_dec), x.r.stored_status, x.r.stored_price_at_flag,
      d(x.r.stored_pnl), d(x.r.recomputed_pnl), x.js === null ? '—' : x.js.toFixed(6), d(x.r.stored_pnl_at_close), x.r.matches === true && x.ok ? 'yes' : 'NO'].join(' | ')));
  }

  /* ── THE HOOK ─────────────────────────────────────────────────────────── */
  db.sql(insertSql([
    { sig_key: 'hook|1', event_id: 'h1', sport_key: 'americanfootball_nfl', sport_title: 'NFL', commence_time: iso(NOW - 4 * H), home_team: 'Chiefs', away_team: 'Broncos', market: 'h2h', selection: 'Chiefs', point: null,
      flagged_at: iso(NOW - 30 * H), flagged_edge: 0.03, flagged_best_dec: 2.5, flagged_best_book: 'FanDuel', flagged_tier: 'A', flagged_policy: 'v9', closed_at: null, closing_dec: null, closing_book: null,
      result: null, graded_at: null, first_best_dec: 2.5, best_dec: 2.4, last_seen_at: iso(NOW - 5 * H) },
    { sig_key: 'hook|2', event_id: 'h2', sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF', commence_time: iso(NOW - 4 * H), home_team: 'Utah', away_team: 'BYU', market: 'spreads', selection: 'Utah', point: -6.5,
      flagged_at: iso(NOW - 30 * H), flagged_edge: 0.02, flagged_best_dec: 1.91, flagged_best_book: 'DraftKings', flagged_tier: 'B', flagged_policy: 'v9', closed_at: null, closing_dec: null, closing_book: null,
      result: null, graded_at: null, first_best_dec: 1.91, best_dec: 1.9, last_seen_at: iso(NOW - 5 * H) }
  ]));
  chk('a fresh flag gets no row before it closes or settles', db.sql("select count(*) from public.pnl_grades where sig_key like 'hook|%';") === '0');
  /* what close writes ~35 minutes before kickoff */
  db.sql("update public.signals set closing_dec = 2.3, closing_book = 'Pinnacle', clv = 0.04, closed_at = now() where sig_key = 'hook|1';");
  chk('close stamps it → a row appears, waiting on the result, at the flag price', db.sql("select pnl_status || ':' || price_at_flag_dec || ':' || price_at_close_dec || ':' || coalesce(pnl_units::text, 'null') from public.pnl_grades where sig_key = 'hook|1';") === 'ungraded_unsettled:2.5:2.3:null');
  /* what settle writes, inside one transaction that is then rolled back */
  const inTx = db.sql("begin; update public.signals set result = 'win', graded_at = now() where sig_key = 'hook|1'; select pnl_status || ':' || pnl_units || ':' || pnl_units_at_close from public.pnl_grades where sig_key = 'hook|1'; rollback;");
  chk('the settlement writes its P&L row in the SAME transaction (+150 win = 1.5, 1.3 at the close)', inTx === 'graded:1.5:1.3', inTx);
  chk('a settlement that rolls back takes its P&L with it', db.sql("select pnl_status from public.pnl_grades where sig_key = 'hook|1';") === 'ungraded_unsettled');
  db.sql("update public.signals set result = 'win', graded_at = now() where sig_key = 'hook|1';");
  chk('settled for real: graded, +1.50u, revision 2, no history (unsettled → graded is not a correction)',
    db.sql("select pnl_status || ':' || pnl_units || ':' || revision from public.pnl_grades where sig_key = 'hook|1';") === 'graded:1.5:2' && db.sql("select count(*) from public.pnl_grade_history where sig_key = 'hook|1';") === '0');
  db.sql("update public.signals set result = 'loss', graded_at = now() where sig_key = 'hook|2';");
  chk('a flag settled with no close first gets its row from the settlement alone (-110 at 1.91 lost = -1)', db.sql("select pnl_status || ':' || pnl_units || ':' || coalesce(pnl_units_at_close::text, 'null') from public.pnl_grades where sig_key = 'hook|2';") === 'graded:-1:null');
  /* a corrected result */
  db.sql("update public.signals set result = 'push' where sig_key = 'hook|1';");
  chk('a corrected result rewrites the row (push = 0) and is logged with what changed',
    db.sql("select pnl_units || ':' || revision from public.pnl_grades where sig_key = 'hook|1';") === '0:3'
    && /result: win -> push/.test(db.sql("select reason from public.pnl_grade_history where sig_key = 'hook|1';"))
    && db.sql("select source || ':' || (previous ->> 'pnl_units') || ':' || (current ->> 'pnl_units') from public.pnl_grade_history where sig_key = 'hook|1';") === 'settlement:1.5:0');
  /* capture's routine refresh */
  const before = db.sql("select revision || ':' || computed_at from public.pnl_grades where sig_key = 'hook|1';");
  db.sql("update public.signals set best_dec = 2.2, last_seen_at = now(), edge = 0.01, commence_time = commence_time where sig_key = 'hook|1';");
  chk('capture\'s routine refresh (price, last seen, edge, kickoff) does not touch the P&L row', db.sql("select revision || ':' || computed_at from public.pnl_grades where sig_key = 'hook|1';") === before);
  chk('the hook is scoped to the P&L columns only', db.sql(`select string_agg(a.attname, ',' order by a.attname) from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr) where t.tgname = 'pnl_signals_settle_trg';`)
    === 'closed_at,closing_book,closing_dec,flagged_at,flagged_best_book,flagged_best_dec,flagged_edge,flagged_tier,graded_at,result');
  db.sql("update public.signals set flagged_best_dec = 9.99 where sig_key = 'hook|2';");
  chk('the flag price stays frozen (capture v9) and so does the P&L', db.sql("select s.flagged_best_dec || ':' || g.pnl_units from public.signals s join public.pnl_grades g using (sig_key) where sig_key = 'hook|2';") === '1.91:-1');
  db.sql("update public.signals set result = 'void' where sig_key = 'hook|2';");
  chk('voided after the fact: void, no P&L, logged', db.sql("select pnl_status || ':' || coalesce(pnl_units::text, 'null') || ':' || stake_units from public.pnl_grades where sig_key = 'hook|2';") === 'void:null:0'
    && db.sql("select count(*) from public.pnl_grade_history where sig_key = 'hook|2';") === '1');
  chk('the reconciliation is green after all of that', JSON.parse(db.sql('select public.pnl_reconciliation();')).ok === true);

  /* ── THE HOOK NEVER FAILS A SETTLEMENT ─────────────────────────────────── */
  db.sql(insertSql([{ sig_key: 'hook|3', event_id: 'h3', sport_key: 'baseball_mlb', sport_title: 'MLB', commence_time: iso(NOW - 6 * H), home_team: 'Yankees', away_team: 'Red Sox', market: 'h2h', selection: 'Yankees', point: null,
    flagged_at: iso(NOW - 30 * H), flagged_edge: 0.02, flagged_best_dec: 1.8, flagged_best_book: 'BetMGM', flagged_tier: 'A', flagged_policy: 'v9', closed_at: null, closing_dec: null, closing_book: null,
    result: null, graded_at: null, first_best_dec: 1.8, best_dec: 1.8, last_seen_at: iso(NOW - 7 * H) }]));
  db.sql("create or replace function public.pnl_grade_compute(p jsonb) returns public.pnl_grades language plpgsql stable as $x$ begin raise exception 'simulated P&L failure'; end $x$;");
  let settleErr = null;
  try { db.sql("update public.signals set result = 'win', graded_at = now() where sig_key = 'hook|3';"); } catch (e) { settleErr = e.message; }
  chk('with the P&L code broken, the settlement still commits', settleErr === null && db.sql("select result from public.signals where sig_key = 'hook|3';") === 'win', settleErr);
  chk('the failure is logged, not thrown', /simulated P&L failure/.test(db.sql("select message from public.pnl_sync_errors where sig_key = 'hook|3';")));
  db.applyFileAtomic(CORE);   // the fix ships: the core file is re-applied
  const red = JSON.parse(db.sql('select public.pnl_reconciliation();'));
  chk('the reconciliation goes red and says why: 1 settled flag with no row, 1 hook error', red.ok === false && red.settled_without_pnl === 1 && red.sync_errors_24h === 1 && /simulated/.test(red.last_error), red);
  const fix = parse(db.sql('select * from public.pnl_backfill(true);'), KEYS);
  chk('the backfill repairs exactly that row', /WRITTEN: 1 inserted, 0 updated/.test(fix[0].item) && JSON.parse(db.sql('select public.pnl_reconciliation();')).settled_without_pnl === 0, fix[0]);

  /* ── nothing deleted, nothing invented, every version traceable ───────── */
  chk('a P&L row cannot be deleted, even by the owner', /kept forever/.test(db.mustFail(() => db.sql("delete from public.pnl_grades where sig_key = 'hook|2';")) || ''));
  chk('the table cannot be truncated', /kept forever/.test(db.mustFail(() => db.sql('truncate public.pnl_grades cascade;')) || ''));
  chk('history cannot be edited', /kept forever/.test(db.mustFail(() => db.sql("update public.pnl_grade_history set reason = 'x';")) || ''));
  chk('a graded signal cannot be deleted out from under its P&L', /pnl_grades_signal_fk|foreign key/.test(db.mustFail(() => db.sql("delete from public.signals where sig_key = 'hook|1';")) || ''));
  chk('an invented figure is refused by the table itself (service role)', /pnl_grades_math/.test(db.mustFail(() => db.service("update public.pnl_grades set pnl_units = 5 where sig_key = 'hook|1';")) || ''));
  chk('P&L on a row with no flag price is refused', /pnl_grades_math/.test(db.mustFail(() => db.sql("update public.pnl_grades set pnl_units = 1, stake_units = 1, pnl_status = 'graded' where pnl_status = 'ungraded_missing_price' and result in ('win','loss','push');")) || ''));
  db.sql("update public.pnl_grades set calc_version = 'pnl-v0' where sig_key = 'hook|1';");
  const cv = parse(db.sql('select * from public.pnl_backfill(true);'), KEYS);
  chk('a calc_version change is rewritten AND logged, never silent', /1 updated/.test(cv[0].item) && /calc_version: pnl-v0 -> pnl-v1/.test(db.sql("select reason from public.pnl_grade_history where sig_key = 'hook|1' order by id desc limit 1;")), cv[0]);

  /* ── who may read and write ───────────────────────────────────────────── */
  const anonKeys = db.anon('select sig_key from public.pnl_grades;').split('\n');
  const preKick = SIGNALS.filter((s) => s.closed_at && !s.result && new Date(s.commence_time).getTime() > NOW).map((s) => s.sig_key);
  chk('there are closed flags on games not started yet (close runs ~35 min before kickoff)', preKick.length > 0);
  chk('anon never sees a flag whose game has not started', preKick.every((k) => anonKeys.indexOf(k) < 0) && db.sql('select count(*) from public.pnl_grades where sig_key in (' + preKick.map(lit).join(',') + ');') === String(preKick.length));
  chk('anon sees every settled row', anonKeys.length === Number(db.sql("select count(*) from public.pnl_grades where result_raw is not null or commence_time <= now();")));
  chk('the summary hides them too (counts as anon exclude unstarted games)', Number(db.anon("select coalesce(sum(ungraded_unsettled), 0) from public.pnl_summary where grain = 'all' and breakdown = 'total';"))
    === Number(db.sql("select count(*) from public.pnl_grades where record_scope = 'record' and pnl_status = 'ungraded_unsettled' and (result_raw is not null or commence_time <= now());")));
  chk('anon reads the summary and the history', Number(db.anon("select count(*) from public.pnl_summary where grain = 'all';")) > 0 && Number(db.anon('select count(*) from public.pnl_grade_history;')) > 0);
  chk('anon cannot write a P&L row', db.mustFail(() => db.anon("insert into public.pnl_grades (sig_key, market_type, tier, record_scope, stake_units, pnl_status, calc_version) values ('x','other','A','record',0,'void','pnl-v1');")) !== null);
  chk('anon cannot change one', db.mustFail(() => db.anon("update public.pnl_grades set ungraded_reason = 'x';")) !== null);
  chk('anon cannot run the writer, the backfill, the verify or the hand-check',
    ['select public.pnl_grade_write(\'{}\'::jsonb, \'x\');', 'select * from public.pnl_backfill(true);', 'select * from public.pnl_verify();', 'select * from public.pnl_handcheck(1);']
      .every((q) => /permission denied/.test(db.mustFail(() => db.anon(q)) || '')));
  chk('a signed-in reader cannot either', /permission denied/.test(db.mustFail(() => db.as('00000000-0000-0000-0000-00000000000a', 'select * from public.pnl_backfill(true);')) || ''));
  chk('the Records tab (signed in) and anon can read the reconciliation', JSON.parse(db.as('00000000-0000-0000-0000-00000000000a', 'select public.pnl_reconciliation();')).ok === true
    && JSON.parse(db.anon('select public.pnl_reconciliation();')).ok === true);
  chk('the hook\'s error log is private', /permission denied/.test(db.mustFail(() => db.anon('select count(*) from public.pnl_sync_errors;')) || '')
    && /permission denied/.test(db.mustFail(() => db.as('00000000-0000-0000-0000-00000000000a', 'select count(*) from public.pnl_sync_errors;')) || ''));
  chk('the service role can run the backfill', /WRITTEN: 0 inserted, 0 updated/.test(parse(db.service('select * from public.pnl_backfill(true);'), KEYS)[0].item));
  chk('all three reports still read ok on a live table', ok(db.applyFileAtomic(CORE)) && ok(db.applyFileAtomic(SUM)) && /ok: nothing to backfill/.test(db.applyFileAtomic(SYNC)));
} catch (e) {
  chk('the suite ran to the end', false, String(e.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());

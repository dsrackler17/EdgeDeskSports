#!/usr/bin/env node
/* ===========================================================================
   supabase/portfolio_decision.sql — THE DECISION RECORD, AGAINST A REAL
   POSTGRESQL, AS REAL READERS.

   Proves:
     - freshness, context quality, the outcome class and edge capture equal,
       value for value, what lib/edgedesk_decision_record.js computes;
     - a decision snapshot is written once, before the event, and never again
       — not by its reader, not by the service role; the reader's own state in
       it is computed by the server, whatever the client sends; a snapshot
       after the fact is refused;
     - the market path, reflections, outcome classes, the frozen baseline and
       process-memory observations are append-only and written only by their
       own functions; a changed grade writes a NEW class beside the old;
     - the feed adds only exact-key prices, and a close only within 6 hours
       of the start, as an EDGEDESK_CAPTURE close;
     - experiments freeze their baseline at the start and refuse a conclusion
       the evidence does not allow;
     - lineage: every observation lists exactly the positions it used and why
       others were excluded; the breakdown key equals portfolio_cells();
     - export holds everything the reader owns and nothing anyone else does;
       delete removes all of it and nothing else; the operator's metrics are
       counts, withheld below 5 readers;
     - reader B can reach none of reader A's records.

   Run: node tools/portfolio/decision_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const E = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio.js'));
const X = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_process.js'));
const R = require(path.join(PG.ROOT, 'lib', 'edgedesk_decision_record.js'));

const T = PG.kit('portfolio decision record SQL');
const chk = T.chk;
const L = PG.lit;
const BASE = path.join(PG.ROOT, 'supabase', 'portfolio.sql');
const JOURNAL = path.join(PG.ROOT, 'supabase', 'portfolio_journal.sql');
const CONNECT = path.join(PG.ROOT, 'supabase', 'portfolio_connect.sql');
const PERSONAL = path.join(PG.ROOT, 'supabase', 'personal_research.sql');
const FILE = path.join(PG.ROOT, 'supabase', 'portfolio_decision.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC ─────────────────────────────────────────────────────────────── */
chk('no psql meta-commands', !/^\s*\\/m.test(SQL));
chk('idempotent', /create table if not exists/.test(SQL) && !/create table (?!if not exists)/i.test(SQL) && !/create (unique )?index (?!if not exists)/i.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('row level security is never switched off', !/disable row level security/i.test(SQL));
const CODE = SQL.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
chk('no floating-point money, prices or scores', !/\b(real|double precision|float[48]?)\b/i.test(CODE));
chk('the outcome class never takes profit or loss', (function () {
  const m = /create or replace function public\.portfolio_outcome_class\(([^)]*)\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL);
  return m && !/pnl|profit|payout/i.test(m[1] + m[2]);
}()));
chk('the only functions that run as their owner are the triggers that write append-only rows, the notices, delete and the operator metrics',
  (SQL.match(/create or replace function public\.(\w+)\([^)]*\)[^$]*?security definer/g) || []).map((s) => /public\.(\w+)/.exec(s)[1]).sort().join(',')
  === ['portfolio_admin_moat_metrics', 'portfolio_card_recorded', 'portfolio_delete_everything', 'portfolio_due_notices', 'portfolio_path_from_journal',
    'portfolio_path_from_snapshot', 'portfolio_reflection_log', 'portfolio_settled_notice'].sort().join(','));
chk('the words a reader sees never tell them to bet', ((SQL.replace(/--[^\n]*/g, '').match(/'(?:[^']|'')*'/g)) || [])
  .filter((w) => w !== "'lock table '").every((w) => !/bet this|don'?t bet|\block\b|guarantee|place (another|more)/i.test(w)));

(function () {
  const os = require('os'), cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-parts-'));
  cp.execFileSync(process.execPath, [path.join(PG.ROOT, 'tools', 'sql', 'split_sql.js'), FILE, dir, '18000']);
  const fresh = fs.readdirSync(dir).filter((f) => /^portfolio_decision\.part/.test(f)).sort();
  const committed = fs.readdirSync(path.join(PG.ROOT, 'supabase', 'parts')).filter((f) => /^portfolio_decision\.part/.test(f)).sort();
  chk('supabase/parts/portfolio_decision.part*.sql are current (npm run portfolio:parts)', JSON.stringify(fresh) === JSON.stringify(committed)
    && fresh.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(PG.ROOT, 'supabase', 'parts', f), 'utf8')), { fresh, committed });
  chk('and every part fits one paste', fresh.every((f) => fs.statSync(path.join(dir, f)).size <= 20000));
  fs.rmSync(dir, { recursive: true, force: true });
}());

/* ── JS, no database ────────────────────────────────────────────────────── */
chk('the outcome class needs a grade: a result alone is never classified',
  R.outcomeClass('WON', 'WIN', null, 'PARTIAL') === 'NOT_CLASSIFIED' && R.outcomeClass('LOST', 'LOSS', '80', 'RESULT_ONLY') === 'NOT_CLASSIFIED'
  && R.outcomeClass('WON', 'WIN', '40', 'STRONG') === 'BAD_WIN' && R.outcomeClass('LOST', 'LOSS', '66', 'FULL') === 'GOOD_LOSS'
  && R.outcomeClass('PUSH', 'PUSH', '70', 'FULL') === 'NOT_APPLICABLE' && R.outcomeClass('WON', 'WIN', '50', 'FULL') === 'AVERAGE_PROCESS');
chk('analysis depth names what becomes possible at 10, 30 and 100, and never asks for more wagers',
  R.depth(0).level === 'BUILDING' && R.depth(10).level === 'OBSERVATION' && R.depth(30).level === 'DEVELOPING' && R.depth(100).level === 'STRONG'
  && R.depth(5).next === 10 && R.depth(100).next === null && /not from placing more/.test(R.depth(3).note)
  && [0, 10, 30, 100].every((n) => X.clean(R.depth(n).text + ' ' + R.depth(n).note)));
const card = { entry_id: 'ce_abc', type: 'GAME', sport: 'NFL', league: 'nfl', home: 'Chiefs', away: 'Bills', market: 'spread', market_label: 'Spread',
  selection: 'Chiefs -3', line: -3, american: -110, book: 'draftkings', captured_at: '2026-10-05T00:00:00Z', decision: 'BET', units: 0.5,
  probability: 0.56, ev: 0.069, edge_pp: 3.6, confidence: 71, stage: null, kickoff: '2030-10-11T20:25:00Z', saved_at: '2026-10-05T00:01:00Z',
  evaluated_at: '2026-10-05T00:00:30Z', probability_source: 'calibrated',
  snapshot: { engine: 'opp_v3', decision_id: 'bd_1', model: { fair_american: -127, fair_line: -4.5, model_version: 'cfb_r1' }, market_view: { consensus_line: -3 } } };
const pf = R.prefillFromCard(card, { unit: '40' });
chk('Card → Record Position: the form is prefilled from what the Card holds (book → platform, units × unit → stake, kickoff → event start)',
  pf.platform === 'draftkings' && pf.position_type === 'SPREAD' && pf.event_name === 'Bills @ Chiefs' && pf.selection === 'Chiefs -3' && pf.line === '-3'
  && pf.odds === '-110' && pf.stake === '20.00' && pf.edge_source === 'EDGEDESK' && pf.event_start_at !== '' && pf._card.entry_id === 'ce_abc', pf);
chk('…and a field the Card did not hold stays empty: no unit, no stake; a LEAN carries no stake',
  R.prefillFromCard(card, {}).stake === '' && R.prefillFromCard(Object.assign({}, card, { decision: 'LEAN', units: 0 }), { unit: '40' }).stake === '');
const snapJs = R.snapshotFromCard(card, null);
chk('the snapshot carries the Card\'s frozen EdgeDesk state and the saved price with its own capture time',
  snapJs.origin === 'CARD' && snapJs.origin_ref === 'ce_abc' && snapJs.edgedesk.model_version === 'cfb_r1' && snapJs.edgedesk.decision === 'BET'
  && snapJs.market.captured_at === card.captured_at && snapJs.market.source === 'card_saved' && snapJs.market.odds_american === -110, snapJs);
chk('…or the current read, with ITS capture time, when the page has one',
  R.snapshotFromCard(card, { american: -105, book: 'fanduel', line: -3, captured_at: '2026-10-05T02:00:00Z' }).market.source === 'card_current');
const st = R.changeStatus(X.moments(12, 12 * 2, 12 * 4 + 11 * 1), X.moments(12, 12 * 5, 12 * 25 + 11 * 1));
chk('change is tested, not compared: a clear rise is IMPROVING, too few new positions is INSUFFICIENT NEW EVIDENCE, an interval across zero UNCHANGED',
  st.status === 'IMPROVING' && R.changeStatus(X.moments(30, 60, 200), X.moments(9, 30, 120)).status === 'INSUFFICIENT_NEW_EVIDENCE'
  && R.changeStatus(X.moments(30, 60, 400), X.moments(20, 42, 300)).status === 'UNCHANGED', st);

const db = PG.start('decision');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';
const one = (s) => String(s).split('\n')[0];
const json = (s) => JSON.parse(s || 'null');
const H = (h) => new Date(Date.now() + h * 3600000).toISOString();

let seed = 20261005;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function dec(lo, hi, k) { return (lo + rnd() * (hi - lo)).toFixed(k); }

let minute = 0;
function wager(uid, o) {
  const m = minute++;
  const c = { platform: o.platform || 'draftkings', platform_label: o.platform_label || 'DraftKings', platform_type: 'SPORTSBOOK',
    position_type: o.position_type || 'SPREAD', event_name: o.event_name || 'Game ' + m, market_name: o.market_name || 'Spread',
    selection: o.selection || ('Pick ' + m), line: o.line, stake: o.stake || '100', odds_american: o.odds_american || '-110',
    status: o.status || 'OPEN', placed_at: o.placed_at || new Date(Date.now() - 60000).toISOString(), settled_at: o.settled_at,
    event_start_at: o.event_start_at, sport: o.sport || 'NFL', source: o.source || 'MANUAL', edge_source: o.edge_source, notes: o.notes };
  const keys = Object.keys(c).filter((k) => c[k] != null);
  return one(db.as(uid, `insert into public.portfolio_positions (${keys.join(', ')}) values (${keys.map((k) => L(String(c[k]))).join(', ')}) returning id;`));
}
function journal(uid, id, set) {
  const parts = Object.keys(set).map((k) => k + ' = ' + (set[k] === null ? 'null' : L(String(set[k]))));
  return db.as(uid, `update public.portfolio_journal_entries set ${parts.join(', ')} where position_id = ${L(id)};`);
}
function snapshot(uid, id, p) {
  return db.as(uid, `insert into public.portfolio_decision_snapshots (position_id, origin, origin_ref, saved_at, edgedesk, market, user_state)
    values (${L(id)}, ${L(p.origin || 'CARD')}, ${p.origin_ref ? L(p.origin_ref) : 'null'}, ${p.saved_at ? L(p.saved_at) : 'null'},
            ${L(JSON.stringify(p.edgedesk || {}))}::jsonb, ${L(JSON.stringify(p.market || {}))}::jsonb, ${L(JSON.stringify(p.user_state || {}))}::jsonb);`);
}
function settle(uid, id, status, at) {
  return db.as(uid, `update public.portfolio_positions set status = ${L(status)}, settled_at = ${L(at || new Date().toISOString())} where id = ${L(id)};`);
}
const record = (uid, id) => json(one(db.as(uid, `select public.portfolio_decision_record(${L(id)}, 'UTC');`)));

try {
  db.applyFileAtomic(BASE); db.applyFileAtomic(JOURNAL); db.applyFileAtomic(CONNECT);
  db.applyFileAtomic(PERSONAL);
  let out = db.applyFileAtomic(FILE);
  chk('the Decision Record migration applies over portfolio, journal and connect', true);
  chk('every report row reads ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 10, out.slice(-1500));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out));
  db.applyFileAtomic(BASE); db.applyFileAtomic(JOURNAL); db.applyFileAtomic(CONNECT); db.applyFileAtomic(PERSONAL);
  chk('re-running the earlier files after it keeps the record closed to anon and its triggers in place',
    db.sql(`select has_function_privilege('anon', 'public.portfolio_decision_record(uuid,text)', 'execute');`) === 'f'
    && db.sql(`select count(*) from pg_trigger where not tgisinternal and tgname in ('portfolio_journal_path_trg', 'portfolio_journal_reflection_trg', 'portfolio_positions_settled_notice_trg', 'portfolio_experiments_record_trg');`) === '4');
  chk('re-running personal_research.sql keeps the notice kinds (the shape check is replaced once, then left alone)',
    /decision_review/.test(db.sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'user_alerts_shape';`)));
  db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(B)}, 'b@example.com'), (${L(ADMIN)}, 'op@example.com');`);

  /* ═══ PARITY: freshness, context quality, outcome class, edge capture ══ */
  const at = '2026-10-05T12:00:00Z', mins = [-10, -5, -4, 0, 29, 30, 31, 89, 90, 91, 600, null];
  const fr = json(db.sql('select json_agg(public.portfolio_freshness(c, ' + L(at) + '::timestamptz) order by i) from (values ' + mins.map((m, i) => '(' + i + ', '
    + (m == null ? 'null::timestamptz' : L(new Date(Date.parse(at) - m * 60000).toISOString()) + '::timestamptz') + ')').join(',') + ') v(i, c);'));
  chk('freshness at every boundary — SQL and JS agree (fresh ≤ 30 min, aging ≤ 90, a capture 5+ minutes ahead is a clock fault)',
    JSON.stringify(fr) === JSON.stringify(mins.map((m) => R.freshness(m == null ? null : new Date(Date.parse(at) - m * 60000).toISOString(), at))), fr);
  const combos = [];
  for (let i = 0; i < 64; i++) combos.push([0, 1, 2, 3, 4, 5].map((b) => !!(i & (1 << b))));
  const cq = json(db.sql('select json_agg(public.portfolio_context_quality(a, b, c, d, e, f) order by i) from (values '
    + combos.map((c, i) => '(' + i + ', ' + c.join(', ') + ')').join(',') + ') v(i, a, b, c, d, e, f);'));
  chk('context quality: all 64 combinations — SQL = JS', cq.every((q, i) => q === R.contextQuality({ snapshot_pre: combos[i][0], snapshot_model: combos[i][1],
    snapshot_market: combos[i][2], decision_pre: combos[i][3], price_ref_pre: combos[i][4], market_ctx: combos[i][5] })), cq);
  const oc = [];
  ['OPEN', 'WON', 'LOST', 'PUSH', 'VOID'].forEach((s) => ['WIN', 'LOSS', 'PUSH', null].forEach((r) => [null, '30', '44.9', '45', '65.9', '66', '90'].forEach((sc) =>
    ['FULL', 'STRONG', 'PARTIAL', 'RESULT_ONLY'].forEach((q) => oc.push([s, r, sc, q])))));
  const ocs = json(db.sql('select json_agg(public.portfolio_outcome_class(s, r, sc, q) order by i) from (values '
    + oc.map((c, i) => `(${i}, ${L(c[0])}, ${c[1] == null ? 'null' : L(c[1])}, ${c[2] == null ? 'null' : L(c[2]) + '::numeric'}, ${L(c[3])})`).join(',') + ') v(i, s, r, sc, q);'));
  chk(oc.length + ' status × result × score × quality combinations: the outcome class — SQL = JS', ocs.every((x, i) => x === R.outcomeClass(oc[i][0], oc[i][1], oc[i][2], oc[i][3])));
  const ecs = [];
  for (let i = 0; i < 400; i++) {
    const pm = rnd() < 0.25, type = pm ? 'PREDICTION_MARKET' : 'SPORTSBOOK';
    const px = () => (rnd() < 0.15 ? null : pm ? dec(0.03, 0.97, 4) : dec(1.08, 6, 6));
    const ln = () => (pm || rnd() < 0.3 ? null : pick(['-3', '-3.5', '-2.5', '47.5', '48', '7']));
    const entryLine = ln();
    ecs.push({ platform_type: type, position_type: pm ? 'EVENT_CONTRACT' : pick(['SPREAD', 'TOTAL', 'MONEYLINE', 'PLAYER_PROP', 'PARLAY']),
      dir: pick([null, 'OVER', 'UNDER']), lead: pick([null, 3600, 86400, 0, -600]), entry: px(), entry_line: entryLine,
      ref: px(), ref_line: rnd() < 0.6 ? entryLine : ln(), close: px(), close_line: rnd() < 0.6 ? entryLine : ln(), prob: rnd() < 0.2 ? null : dec(0.05, 0.95, 4) });
  }
  const nl = (v) => (v == null ? 'null::numeric' : L(v) + '::numeric');
  const ecSql = json(db.sql('select json_agg(public.portfolio_edge_capture(t, pt, d, ld, e, el, r, rl, c, cl, p) order by i) from (values '
    + ecs.map((c, i) => `(${i}, ${L(c.platform_type)}, ${L(c.position_type)}, ${c.dir == null ? 'null' : L(c.dir)}, ${c.lead == null ? 'null::bigint' : c.lead + '::bigint'},
      ${nl(c.entry)}, ${nl(c.entry_line)}, ${nl(c.ref)}, ${nl(c.ref_line)}, ${nl(c.close)}, ${nl(c.close_line)}, ${nl(c.prob)})`).join(',')
    + ') v(i, t, pt, d, ld, e, el, r, rl, c, cl, p);'));
  const normEc = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, Array.isArray(o[k]) ? o[k].join(',') : typeof o[k] === 'number' || /^-?[0-9.]+$/.test(String(o[k])) ? E.dec.str(String(o[k])) : o[k]]));
  const ecDiff = [];
  ecSql.forEach((s, i) => { const j = R.edgeCapture(ecs[i]); if (normEc(s) !== normEc(j)) ecDiff.push({ i, sql: s, js: j, c: ecs[i] }); });
  chk('400 random positions: edge capture — basis, edge at decision and entry, capture, slip, CLV and every limitation — SQL = JS', ecDiff.length === 0, ecDiff.slice(0, 2));
  chk('…and every limitation code has words', ecSql.every((s) => (s.limitations || []).every((k) => R.LIMITATION_TEXT[k])));

  /* ═══ THE SNAPSHOT: once, before the event, never again ═══════════════ */
  db.as(A, `insert into public.portfolio_rules (kind, params, label) values ('MAX_STAKE_UNITS', '{"units": 2}', 'Two units at most');`);
  const p1 = wager(A, { event_name: 'Bills @ Chiefs', selection: 'Chiefs -3', line: '-3', odds_american: '-105', event_start_at: H(48), edge_source: 'EDGEDESK',
    notes: 'played the key number', placed_at: new Date(Date.now() + 1000).toISOString() });
  snapshot(A, p1, { origin: 'CARD', origin_ref: 'ce_abc', saved_at: H(-2),
    edgedesk: Object.assign({}, snapJs.edgedesk, { injected: 'x', probability: 0.56, decision: 'BET' }),
    market: { captured_at: H(-0.1), book: 'draftkings', odds_american: -110, line: -3, consensus_line: -3, n_books: 7, junk: { a: 1 },
      books: [{ book: 'draftkings', odds_american: -110, line: -3 }, { book: 'fanduel', odds_american: -112, line: -3 }, { nope: 1 }] },
    user_state: { unit: 999999, bankroll: 1 } });
  let s1 = json(one(db.as(A, `select row_to_json(s) from public.portfolio_decision_snapshots s where position_id = ${L(p1)};`)));
  chk('a snapshot is stored with EdgeDesk\'s state and the market as observed — listed keys only, junk dropped',
    s1 && s1.edgedesk.model_version === 'cfb_r1' && s1.edgedesk.probability === 0.56 && !('injected' in s1.edgedesk) && !('junk' in s1.market)
    && s1.market.odds_decimal === +E.americanToDecimal(-110) && s1.market.books.length === 2 && s1.market_freshness === 'FRESH' && s1.content_hash.length === 64, s1);
  chk('the reader\'s own state is the SERVER\'s: the unit and caps on file and the rules in force, never what the client sent',
    s1.user_state.unit !== 999999 && s1.user_state.bankroll !== 1 && s1.user_state.rules.length === 1 && s1.user_state.rules[0].label === 'Two units at most', s1.user_state);
  let err = db.mustFail(() => db.as(A, `update public.portfolio_decision_snapshots set origin = 'MANUAL' where position_id = ${L(p1)};`));
  chk('a snapshot is never rewritten by its reader', err !== null);
  err = db.mustFail(() => db.service(`update public.portfolio_decision_snapshots set edgedesk = '{}' where position_id = ${L(p1)};`));
  chk('…nor by the service role', err !== null && /never rewritten/.test(err), err && err.slice(0, 200));
  chk('…and a reader cannot delete it', db.mustFail(() => db.as(A, `delete from public.portfolio_decision_snapshots where position_id = ${L(p1)};`)) !== null
    && db.sql(`select count(*) from public.portfolio_decision_snapshots where position_id = ${L(p1)};`) === '1');
  chk('one snapshot per position', db.mustFail(() => snapshot(A, p1, { origin: 'MANUAL' })) !== null);
  const late = wager(A, { placed_at: H(-7), event_start_at: H(24) });
  chk('a snapshot 6+ hours after the position was placed is refused — it would be a reconstruction', /not after the fact/.test(db.mustFail(() => snapshot(A, late, { origin: 'MANUAL' })) || ''));
  const started = wager(A, { placed_at: H(-1), event_start_at: H(-0.5) });
  chk('…and after the event has started', /not after the fact/.test(db.mustFail(() => snapshot(A, started, { origin: 'MANUAL' })) || ''));
  chk('reader B cannot read A\'s snapshot, or attach one to A\'s position',
    db.as(B, `select count(*) from public.portfolio_decision_snapshots;`) === '0' && db.mustFail(() => snapshot(B, wager(A, { event_start_at: H(30) }), { origin: 'MANUAL' })) !== null);

  let j1 = json(one(db.as(A, `select row_to_json(j) from public.portfolio_journal_entries j where position_id = ${L(p1)};`)));
  chk('the snapshot fills the journal\'s empty DECISION fields: the model, and the researched price with its capture time',
    j1.model_version === 'cfb_r1' && j1.model_probability === 0.56 && j1.research_odds_american === -110 && +j1.research_line === -3 && j1.research_at && j1.decision_source === 'EDGEDESK', j1);
  let path1 = json(one(db.as(A, `select json_agg(json_build_object('kind', kind, 'source', source, 'basis', time_basis) order by observed_at) from public.portfolio_market_path where position_id = ${L(p1)};`)));
  chk('the market path starts with the decision price (observed, from the snapshot) and the entry (yours) — the researched price the snapshot filled is not listed twice',
    path1.some((x) => x.kind === 'DECISION' && x.source === 'EDGEDESK_SNAPSHOT' && x.basis === 'OBSERVED') && path1.some((x) => x.kind === 'ENTRY' && x.source === 'USER')
    && !path1.some((x) => x.kind === 'RESEARCH'), path1);
  chk('a reader cannot add to or change the path', db.mustFail(() => db.as(A, `insert into public.portfolio_market_path (position_id, user_id, kind, observed_at, time_basis, source, odds_decimal)
    values (${L(p1)}, ${L(A)}, 'CLOSE', now(), 'OBSERVED', 'EDGEDESK_CAPTURE', 2.0);`)) !== null
    && db.mustFail(() => db.service(`update public.portfolio_market_path set odds_decimal = 3 where position_id = ${L(p1)};`)) !== null);
  chk('the Card entry is marked RECORDED by the snapshot, and a reader cannot claim one by hand',
    db.as(A, `select count(*) from public.portfolio_card_events where entry_id = 'ce_abc' and event = 'RECORDED' and position_id = ${L(p1)};`) === '1'
    && /recorded by recording/.test(db.mustFail(() => db.as(A, `insert into public.portfolio_card_events (entry_id, event) values ('ce_zzz', 'RECORDED');`)) || ''));
  db.as(A, `insert into public.portfolio_card_events (entry_id, event, detail) values ('ce_abc', 'ADDED', '{"decision": "BET", "stake": 500, "sport": "NFL"}');`);
  chk('a Card event keeps labels, never money', !('stake' in json(one(db.as(A, `select detail from public.portfolio_card_events where event = 'ADDED' and entry_id = 'ce_abc';`)))));
  db.as(A, `insert into public.portfolio_card_events (entry_id, event) values ('ce_skip', 'ADDED'), ('ce_skip', 'REMOVED');`);
  chk('a removed (skipped) Card entry is an event, never a position', db.as(A, `select count(*) from public.portfolio_positions where notes = 'ce_skip';`) === '0'
    && db.as(A, `select count(*) from public.portfolio_card_events where entry_id = 'ce_skip';`) === '2');

  /* ═══ CLOSE, REFLECTION, CLASS ════════════════════════════════════════ */
  journal(A, p1, { closing_odds_american: '-125', would_repeat: 'YES', review_note: 'Price was right.' });
  path1 = json(one(db.as(A, `select json_agg(json_build_object('kind', kind, 'source', source, 'basis', time_basis)) from public.portfolio_market_path where position_id = ${L(p1)} and kind = 'CLOSE';`)));
  chk('a typed close joins the path as RECORDED (when EdgeDesk learned it), never as an observed time', path1.length === 1 && path1[0].basis === 'RECORDED' && path1[0].source === 'USER', path1);
  let refl = json(one(db.as(A, `select json_agg(json_build_object('r', would_repeat, 'k', result_known) order by id) from public.portfolio_reflections where position_id = ${L(p1)};`)));
  chk('a review written while the position is open is logged as written before the result', refl.length === 1 && refl[0].k === false, refl);
  settle(A, p1, 'LOST');
  journal(A, p1, { would_repeat: 'UNSURE', review_note: 'Lost, but the price beat the close.' });
  refl = json(one(db.as(A, `select json_agg(json_build_object('r', would_repeat, 'k', result_known, 'res', result) order by id) from public.portfolio_reflections where position_id = ${L(p1)};`)));
  chk('…and every later version is kept, stamped with the result it knew', refl.length === 2 && refl[0].r === 'YES' && refl[1].r === 'UNSURE' && refl[1].k === true && refl[1].res === 'LOSS', refl);
  chk('a reflection is never rewritten, and a reader cannot write one directly',
    db.mustFail(() => db.service(`update public.portfolio_reflections set review_note = 'x' where position_id = ${L(p1)};`)) !== null
    && db.mustFail(() => db.as(A, `insert into public.portfolio_reflections (position_id, user_id, result_known) values (${L(p1)}, ${L(A)}, false);`)) !== null);
  chk('the decision journal itself still refuses a rewrite', /never rewritten/.test(db.mustFail(() => journal(A, p1, { model_probability: '0.6' })) || ''));

  const n1 = +one(db.as(A, `select public.portfolio_classify_outcomes('UTC');`));
  let cls = json(one(db.as(A, `select json_agg(json_build_object('c', class, 'q', context_quality, 's', process_score, 'm', methodology_version)) from public.portfolio_outcome_classes where position_id = ${L(p1)};`)));
  chk('a settled loss with a strong process is persisted as a GOOD_LOSS, with its context quality and methodology',
    n1 >= 1 && cls.length === 1 && cls[0].c === 'GOOD_LOSS' && cls[0].q === 'FULL' && cls[0].m === 'outcome_class_v1', cls);
  chk('classifying again writes nothing new', one(db.as(A, `select public.portfolio_classify_outcomes('UTC');`)) === '0');
  chk('an outcome class is computed, never written by hand, and never rewritten',
    /computed by portfolio_classify_outcomes/.test(db.mustFail(() => db.as(A, `insert into public.portfolio_outcome_classes (position_id, methodology_version, process_methodology, tz, class, context_quality, inputs_hash)
      values (${L(p1)}, 'outcome_class_v1', 'process_v1', 'UTC', 'GOOD_WIN', 'FULL', 'x');`)) || '')
    && db.mustFail(() => db.service(`update public.portfolio_outcome_classes set class = 'BAD_LOSS' where position_id = ${L(p1)};`)) !== null);
  /* a result-only position: imported history, nothing recorded about the decision */
  const imp = wager(A, { placed_at: '2025-03-01T18:00:00Z', settled_at: '2025-03-02T03:00:00Z', event_start_at: '2025-03-01T23:00:00Z', status: 'WON', source: 'CSV' });
  db.as(A, `select public.portfolio_classify_outcomes('UTC');`);
  const impRec = record(A, imp);
  chk('imported history is valued but not invented: RESULT_ONLY, ungraded, NOT_CLASSIFIED — and no snapshot can be added after the fact',
    impRec.context_quality === 'RESULT_ONLY' && impRec.grade.process_score === null && impRec.grade.outcome.class === 'NOT_CLASSIFIED'
    && impRec.before.snapshot === null && db.mustFail(() => snapshot(A, imp, { origin: 'MANUAL' })) !== null, impRec.grade);

  /* a changed grade writes a new class beside the old */
  const p2 = wager(A, { event_start_at: H(30), odds_american: '+120', sport: 'NFL' });
  journal(A, p2, { research_odds_american: '+140' });
  const rp2 = json(one(db.as(A, `select json_agg(json_build_object('k', kind, 's', source, 'b', time_basis)) from public.portfolio_market_path where position_id = ${L(p2)} and kind = 'RESEARCH';`)));
  chk('a researched price the reader typed joins the path as theirs, stamped RECORDED (no observation time was given)', rp2 && rp2.length === 1 && rp2[0].s === 'USER' && rp2[0].b === 'RECORDED', rp2);
  settle(A, p2, 'WON');
  db.as(A, `select public.portfolio_classify_outcomes('UTC');`);
  const c2a = json(one(db.as(A, `select json_agg(class order by id) from public.portfolio_outcome_classes where position_id = ${L(p2)};`)));
  journal(A, p2, { closing_odds_american: '+165' });
  db.as(A, `select public.portfolio_classify_outcomes('UTC');`);
  const c2b = json(one(db.as(A, `select json_agg(json_build_object('c', class, 's', process_score) order by id) from public.portfolio_outcome_classes where position_id = ${L(p2)};`)));
  chk('a close recorded later changes the grade: a NEW class row is written and the earlier one stays (' + JSON.stringify(c2b) + ')',
    c2a.length === 1 && c2b.length === 2 && c2b[0].c === c2a[0] && c2b[1].c === 'BAD_WIN', { c2a, c2b });

  /* ═══ THE DECISION RECORD ═════════════════════════════════════════════ */
  const rec = record(A, p1);
  chk('the Decision Record has every section: BEFORE · ENTRY · MARKET PATH · RESULT · GRADE · REFLECTION · FOLLOW-UP',
    ['before', 'entry', 'market_path', 'result', 'grade', 'reflection', 'follow_up', 'methodology', 'context_quality'].every((k) => k in rec), Object.keys(rec));
  chk('BEFORE: the snapshot as frozen, how long from saving to deciding, the journal and the Card\'s events',
    rec.before.snapshot.origin === 'CARD' && rec.before.snapshot.content_hash === s1.content_hash && rec.before.snapshot.research_to_decision_seconds > 3600
    && rec.before.journal.research_odds_american === -110 && rec.before.card.some((e) => e.event === 'RECORDED'), rec.before);
  chk('GRADE: the components, CLV, edge capture with its limitations, and the persisted class — with the methodology that produced each',
    rec.grade.components.clv !== null && rec.grade.edge_capture.basis === 'PRICE' && rec.grade.edge_capture.capture_ratio != null && rec.grade.edge_capture.limitations.length >= 1
    && rec.grade.outcome.class === 'GOOD_LOSS' && rec.methodology.process === 'process_v1' && rec.methodology.snapshot === 'snapshot_v1', { ec: rec.grade.edge_capture, m: rec.methodology });
  chk('REFLECTION and FOLLOW-UP: the current review, its history, and the rules in force',
    rec.reflection.history.length === 2 && rec.reflection.current.would_repeat === 'UNSURE' && rec.follow_up.needs_review === false, rec.reflection);
  chk('reader B cannot open A\'s record', /no such position/.test(db.mustFail(() => record(B, p1)) || ''));

  /* ═══ SEARCH ══════════════════════════════════════════════════════════ */
  const sr = json(one(db.as(A, `select json_agg(json_build_object('id', id, 'm', matched)) from public.portfolio_search('chiefs', 20);`)));
  chk('search finds the reader\'s positions by event, selection and their own notes', sr && sr.some((x) => x.id === p1),  sr);
  chk('…by journal words too', (json(one(db.as(A, `select json_agg(matched) from public.portfolio_search('beat the close', 20);`))) || []).indexOf('review') >= 0);
  chk('reader B finds nothing of A\'s; a wildcard is a literal', one(db.as(B, `select count(*) from public.portfolio_search('chiefs', 20);`)) === '0'
    && one(db.as(A, `select count(*) from public.portfolio_search('%', 20);`)) === '0' && one(db.as(A, `select count(*) from public.portfolio_search('_a', 20);`)) === '0');

  /* ═══ THE FEED: exact keys only; a close within 6 hours of the start ══ */
  db.sql(`create table if not exists public.book_quote_ticks (id bigserial primary key, sig_key text not null, book_key text, book_title text, dec numeric,
            fair numeric, is_sharp boolean, event_id text, seen_at timestamptz not null default now(), payload jsonb);`);
  const pf1 = wager(A, { event_name: 'Jets @ Bears', selection: 'Bears -2.5', line: '-2.5', odds_american: '-110', event_start_at: H(0.2), placed_at: H(-1) });
  snapshot(A, pf1, { origin: 'RESEARCH', market: { captured_at: H(-1.1), book: 'draftkings', odds_american: -108, line: -2.5, sig_key: 'evt|spreads|bears|-2.5' },
    edgedesk: { probability: 0.55 } });
  const pf2 = wager(A, { event_name: 'Rams @ Seahawks', selection: 'Seahawks -1', line: '-1', event_start_at: H(0.2), placed_at: H(-1) });
  snapshot(A, pf2, { origin: 'RESEARCH', market: { captured_at: H(-1.1), book: 'draftkings', odds_american: -110, line: -1, sig_key: 'evt2|spreads|sea|-1' } });
  db.sql(`insert into public.book_quote_ticks (sig_key, book_key, dec, seen_at) values
    ('evt|spreads|bears|-2.5', 'draftkings', 1.92, now() - interval '50 minutes'),
    ('evt|spreads|bears|-2.5', 'draftkings', 1.87, now() - interval '20 minutes'),
    ('evt|spreads|bears|-2.5', 'fanduel', 1.95, now() - interval '20 minutes'),
    ('evt|spreads|bears|-2.5', 'draftkings', 1.80, now() + interval '30 minutes'),
    ('evt|spreads|bears|-3', 'draftkings', 1.70, now() - interval '20 minutes'),
    ('evt2|spreads|sea|-1', 'draftkings', 1.91, now() - interval '9 hours');`);
  chk('the feed is the service\'s, not a reader\'s', db.mustFail(() => db.as(A, `select public.portfolio_svc_attach_feed_path(50);`)) !== null);
  /* move both starts into the past so the close is due */
  db.as(A, `update public.portfolio_positions set event_start_at = now() - interval '1 minute' where id in (${L(pf1)}, ${L(pf2)});`);
  const feed = json(one(db.service(`select public.portfolio_svc_attach_feed_path(50);`)));
  const fp1 = json(one(db.as(A, `select json_agg(json_build_object('k', kind, 's', source, 'd', odds_decimal) order by observed_at) from public.portfolio_market_path where position_id = ${L(pf1)} and source = 'book_quote_ticks';`)));
  chk('the reader\'s book\'s own ticks for the exact key join the path — not another book, not another line, not after the start',
    fp1.filter((x) => x.k === 'QUOTE').map((x) => +x.d).join(',') === '1.92,1.87', { feed, fp1 });
  const jf1 = json(one(db.as(A, `select row_to_json(j) from public.portfolio_journal_entries j where position_id = ${L(pf1)};`)));
  chk('…and the last pre-start tick becomes an EDGEDESK_CAPTURE close, at the book used', jf1.closing_source === 'EDGEDESK_CAPTURE' && +jf1.closing_odds_decimal === 1.87
    && jf1.closing_book === 'draftkings' && fp1.some((x) => x.k === 'CLOSE'), jf1);
  chk('a last tick more than 6 hours before the start is not called a close', json(one(db.as(A, `select row_to_json(j) from public.portfolio_journal_entries j where position_id = ${L(pf2)};`))).closing_source === null);
  chk('run again, the feed adds nothing twice', json(one(db.service(`select public.portfolio_svc_attach_feed_path(50);`))).points === 0);

  /* ═══ THE BASELINE: the first 30 graded positions, frozen ═════════════ */
  let bl = json(one(db.as(B, `select public.portfolio_baseline('UTC');`)));
  chk('with fewer than 30 graded positions the baseline is BUILDING, says how many more, and stores nothing',
    bl.status === 'BUILDING' && bl.needed === 30 && db.sql(`select count(*) from public.portfolio_baselines where user_id = ${L(B)};`) === '0', bl);
  const bIds = [];
  for (let i = 0; i < 42; i++) {
    const id = wager(B, { placed_at: new Date(Date.UTC(2026, 0, 1 + i, 15)).toISOString(), event_start_at: new Date(Date.UTC(2026, 0, 2 + i, 18)).toISOString(),
      odds_american: i % 2 ? '-110' : '+105', sport: i % 3 ? 'NFL' : 'CFB', position_type: i % 4 ? 'SPREAD' : 'TOTAL',
      status: i % 3 ? 'WON' : 'LOST', settled_at: new Date(Date.UTC(2026, 0, 3 + i, 2)).toISOString() });
    bIds.push(id);
    journal(B, id, { closing_odds_american: i < 30 ? (i % 2 ? '-105' : '+110') : (i % 2 ? '-125' : '-110') });
  }
  bl = json(one(db.as(B, `select public.portfolio_baseline('UTC');`)));
  chk('at 30 graded positions the baseline freezes: those exact 30, by time placed', bl.status === 'FROZEN' && bl.n === 30
    && JSON.stringify(json(one(db.as(B, `select to_json(position_ids) from public.portfolio_baselines;`)))) === JSON.stringify(bIds.slice(0, 30)), bl);
  const bc = R.baselineChange(bl);
  chk('change is measured on the 12 graded positions after it, by test: ' + bc.clv.status + ' on CLV', bl.recent.n === 12 && bc.clv.status === 'IMPROVING' && bc.clv.test, bc.clv);
  chk('a frozen baseline is never rewritten, and is written only by its function',
    db.mustFail(() => db.service(`update public.portfolio_baselines set n = 1;`)) !== null
    && /computed by portfolio_baseline/.test(db.mustFail(() => db.as(A, `insert into public.portfolio_baselines (methodology_version, tz, n, first_placed, last_placed, position_ids, moments)
      values ('baseline_v1', 'UTC', 1, now(), now(), '{}', '{}');`)) || ''));
  const keep = db.sql(`select moments::text from public.portfolio_baselines where user_id = ${L(B)};`);
  const extra = wager(B, { placed_at: '2025-12-01T15:00:00Z', event_start_at: '2025-12-02T18:00:00Z', status: 'WON', settled_at: '2025-12-03T02:00:00Z' });
  journal(B, extra, { closing_odds_american: '-150' });
  db.as(B, `select public.portfolio_baseline('UTC');`);
  chk('a graded position imported later, from before the baseline, does not move it', db.sql(`select moments::text from public.portfolio_baselines where user_id = ${L(B)};`) === keep);

  /* ═══ PROCESS MEMORY AND LINEAGE ══════════════════════════════════════ */
  const cells = json(db.as(B, `select json_agg(json_build_object('dim', dim, 'key', key, 'n', n)) from public.portfolio_cells(null, null, 'UTC') where dim <> 'tag';`));
  const keyed = json(db.as(B, `select json_agg(json_build_object('dim', d.dim, 'key', public.portfolio_fact_key(d.dim, c)))
      from public.portfolio_facts_cache c cross join (select distinct dim from public.portfolio_cells(null, null, 'UTC') where dim <> 'tag') d
     where c.user_id = ${L(B)} and c.tz = 'UTC';`));
  const kc = {};
  keyed.forEach((r) => { const k = r.dim + '|' + r.key; kc[k] = (kc[k] || 0) + 1; });
  const keyDiff = cells.filter((c) => kc[c.dim + '|' + c.key] !== +c.n);
  chk('the breakdown key behind every observation equals portfolio_cells(), dimension by dimension (' + cells.length + ' cells)', keyDiff.length === 0, keyDiff.slice(0, 5));
  const ob = json(one(db.as(B, `select public.portfolio_observe_insight('sport', 'CFB', 'clv', 'LEAK', 'CFB positions', null, null, 'UTC');`)));
  const cfbIds = json(one(db.as(B, `select json_agg(id order by placed_at, id) from public.portfolio_facts_cache where user_id = ${L(B)} and tz = 'UTC' and sport = 'CFB' and clv_pct is not null;`)));
  chk('an observation stores the group, the comparison and EXACTLY the positions used (lineage), computed by the server',
    ob.stored === true && JSON.stringify(ob.observation.position_ids) === JSON.stringify(cfbIds) && ob.observation.grp[0] === cfbIds.length
    && ob.observation.methodology_version === 'insight_v1' && ob.observation.confidence === X.confidence(cfbIds.length), ob.observation);
  chk('…every id in it is the reader\'s own', db.sql(`select count(*) from public.portfolio_insight_observations o, unnest(o.position_ids) x(id) join public.portfolio_positions p on p.id = x.id where p.user_id <> o.user_id;`) === '0');
  const ob2 = json(one(db.as(B, `select public.portfolio_observe_insight('sport', 'CFB', 'clv', 'LEAK', 'CFB positions', null, null, 'UTC');`)));
  chk('the same look within 12 hours with the same numbers is not stored twice', ob2.stored === false);
  const obr = json(one(db.as(B, `select public.portfolio_observe_insight('timing', 'D1_3', 'ret', 'LEAK', 'A day or more before', null, null, 'UTC');`)));
  chk('positions without the metric are excluded and counted with the reason', obr.observation.position_count >= 0 && typeof obr.observation.excluded === 'object', obr.observation.excluded);
  db.service(`update public.portfolio_insights set first_detected_at = '2026-01-20T00:00:00Z', key = 'NFL' where dim = 'sport';`);
  chk('a pattern\'s identity and first detection are fixed — a reader cannot edit it, and the service role\'s edit does not take',
    db.mustFail(() => db.as(B, `update public.portfolio_insights set label = 'x';`)) !== null
    && db.sql(`select (first_detected_at < now() - interval '1 minute')::text || key from public.portfolio_insights where dim = 'sport' and user_id = ${L(B)};`) === 'falseCFB');
  chk('an observation is never rewritten, and is written only by its function',
    db.mustFail(() => db.service(`update public.portfolio_insight_observations set position_count = 0;`)) !== null
    && /computed by portfolio_observe_insight/.test(db.mustFail(() => db.as(B, `insert into public.portfolio_insight_observations (insight_id, methodology_version, tz, grp, comparison, since_first, before_first, confidence, position_ids, position_count)
      select id, 'insight_v1', 'UTC', '[]', '[]', '[]', '[]', 'LOW', '{}', 0 from public.portfolio_insights limit 1;`)) || ''));
  const mem = json(one(db.as(B, `select public.portfolio_insight_memory();`))).map(R.memoryItem);
  chk('process memory: FIRST DETECTED, THEN and NOW for each pattern, with an evidence-tested status (no new positions yet: insufficient)',
    mem.length === 2 && mem.every((m) => m.first_detected_at && m.then && m.now && m.status === 'INSUFFICIENT_NEW_EVIDENCE'), mem.map((m) => [m.label, m.status, m.then.n, m.now.n]));
  chk('reader A sees none of B\'s patterns, and cannot observe into B\'s history',
    json(one(db.as(A, `select public.portfolio_insight_memory();`))).length === 0
    && json(one(db.as(A, `select public.portfolio_observe_insight('sport', 'CFB', 'clv', 'LEAK', 'x', null, null, 'UTC');`))).observation.position_ids.every((id) => bIds.indexOf(id) < 0));

  /* ═══ EXPERIMENTS: criteria and baseline frozen, a conclusion once ═════ */
  db.as(B, `insert into public.portfolio_experiments (title, hypothesis, metric, condition, starts_at, ends_at, min_sample, success_criteria, tz)
    values ('Spreads only', 'Totals cost CLV', 'CLV', '{"dim": "position_type", "key": "SPREAD"}', now(), now() + interval '20 days', 5, 'CLV above baseline', 'UTC');`);
  let ex = json(one(db.as(B, `select row_to_json(e) from public.portfolio_experiments e where title = 'Spreads only';`)));
  chk('an experiment freezes its success criteria and its baseline (the same length of time before it) when it starts',
    ex.success_criteria === 'CLV above baseline' && ex.baseline && ex.baseline.moments && ex.baseline.frozen_at && ex.result === null, ex.baseline);
  db.as(B, `update public.portfolio_experiments set success_criteria = 'changed', baseline = '{}', result = '{"x": 1}', conclusion = 'SUPPORTED' where id = ${L(ex.id)};`);
  ex = json(one(db.as(B, `select row_to_json(e) from public.portfolio_experiments e where id = ${L(ex.id)};`)));
  chk('…and neither can be edited, nor a result typed in', ex.success_criteria === 'CLV above baseline' && ex.baseline.moments && ex.result === null && ex.conclusion === null);
  chk('it cannot be concluded while its window is open', /once its window has ended/.test(db.mustFail(() => db.as(B, `select public.portfolio_conclude_experiment(${L(ex.id)}, '{}');`)) || ''));
  db.as(B, `update public.portfolio_experiments set reflection = 'too early' where id = ${L(ex.id)};`);
  chk('nor reflected on', json(one(db.as(B, `select reflection from public.portfolio_experiments where id = ${L(ex.id)};`))) === null);
  db.as(B, `update public.portfolio_experiments set status = 'ENDED' where id = ${L(ex.id)};`);
  const evd = json(one(db.as(B, `select public.portfolio_experiment_evidence(${L(ex.id)});`)));
  chk('the evidence is the window and the frozen baseline, computed here', evd.window && evd.baseline && evd.methodology === 'experiment_v1', evd);
  const cc = json(one(db.as(B, `select public.portfolio_conclude_experiment(${L(ex.id)}, '{"status": "SUPPORTED", "ci_lo": 0.5, "ci_hi": 0.9}');`)));
  chk('a conclusion the evidence does not allow is refused: too few positions is INCONCLUSIVE whatever the page claims',
    cc.conclusion === 'INCONCLUSIVE' && cc.result.claimed === 'SUPPORTED', cc);
  chk('…and a conclusion is written once', json(one(db.as(B, `select public.portfolio_conclude_experiment(${L(ex.id)}, '{"status": "NOT_SUPPORTED"}');`))).already === true
    && db.as(B, `select conclusion from public.portfolio_experiments where id = ${L(ex.id)};`) === 'INCONCLUSIVE');
  db.as(B, `update public.portfolio_experiments set reflection = 'Too few positions to say.' where id = ${L(ex.id)};`);
  db.as(B, `update public.portfolio_experiments set reflection = 'rewritten' where id = ${L(ex.id)};`);
  chk('the reflection is written once, after the experiment', db.as(B, `select reflection from public.portfolio_experiments where id = ${L(ex.id)};`) === 'Too few positions to say.');

  /* ═══ NOTIFICATIONS ═══════════════════════════════════════════════════ */
  const pn = wager(A, { event_start_at: H(5), event_name: 'Packers @ Lions' });
  settle(A, pn, 'WON');
  chk('a settled position puts one "ready to review" notice in the reader\'s own centre — never a prompt to place anything',
    db.sql(`select count(*) from public.user_alerts where user_id = ${L(A)} and kind = 'decision_review' and payload->>'position_id' = ${L(pn)};`) === '1'
    && !/\bbet\b|again|next/i.test(db.sql(`select title || ' ' || body from public.user_alerts where payload->>'position_id' = ${L(pn)};`)));
  db.as(A, `insert into public.alert_preferences (user_id, on_decision_review) values (${L(A)}, false);`);
  const pn2 = wager(A, { event_start_at: H(5) });
  settle(A, pn2, 'LOST');
  chk('…and none when the reader turned that notice off', db.sql(`select count(*) from public.user_alerts where payload->>'position_id' = ${L(pn2)};`) === '0');
  chk('an ended experiment awaiting its result is one notice, once', +one(db.as(B, `select public.portfolio_due_notices();`)) === 0
    && (db.as(B, `insert into public.portfolio_experiments (title, metric, starts_at, ends_at, tz) values ('Two', 'PROCESS', now(), now() + interval '2 days', 'UTC');
                  update public.portfolio_experiments set status = 'ENDED' where title = 'Two';`), +one(db.as(B, `select public.portfolio_due_notices();`)) === 1)
    && +one(db.as(B, `select public.portfolio_due_notices();`)) === 0);
  db.sql(`alter table public.user_alerts drop constraint user_alerts_shape; alter table public.user_alerts add constraint user_alerts_shape check (kind in ('fair_move')) not valid;`);
  db.as(A, `update public.alert_preferences set on_decision_review = true where user_id = ${L(A)};`);
  const pn3 = wager(A, { event_start_at: H(5) });
  chk('a notification centre that predates the kind never blocks a settlement', db.mustFail(() => settle(A, pn3, 'WON')) === null
    && db.as(A, `select status from public.portfolio_positions where id = ${L(pn3)};`) === 'WON');
  db.applyFileAtomic(PERSONAL);

  /* ═══ PRIVACY: export everything, delete everything ═══════════════════ */
  const exA = json(one(db.as(A, `select public.portfolio_export();`)));
  const aPos = +db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`);
  chk('the export holds every Portfolio and Decision Record table the reader owns',
    ['positions', 'transactions', 'journal', 'decision_snapshots', 'market_path', 'reflections', 'outcome_classes', 'baselines', 'insights',
      'insight_observations', 'rules', 'experiments', 'card_events', 'imports', 'import_rows', 'accounts', 'methodology'].every((k) => Array.isArray(exA[k]))
    && exA.positions.length === aPos && exA.decision_snapshots.length >= 3 && exA.format === 'edgedesk_portfolio_export_v1', Object.keys(exA));
  const exB = json(one(db.as(B, `select public.portfolio_export();`)));
  chk('…and nothing anyone else owns', JSON.stringify(exA).indexOf(B) < 0 && JSON.stringify(exB).indexOf(A) < 0 && exB.positions.every((p) => p.user_id === B));
  chk('…and never a stored credential or a sync cursor', !/ciphertext|sync_cursor/.test(JSON.stringify(exA)));
  chk('delete asks for the typed phrase', /DELETE MY PORTFOLIO/.test(db.mustFail(() => db.as(A, `select public.portfolio_delete_everything('yes');`)) || ''));

  /* ═══ THE OPERATOR'S METRICS: counts, withheld under 5 readers ════════ */
  chk('the moat metrics are the operator\'s only', db.mustFail(() => db.as(A, `select public.portfolio_admin_moat_metrics(30);`)) !== null);
  let mm = json(one(db.as(ADMIN, `select public.portfolio_admin_moat_metrics(400);`)));
  chk('with fewer than 5 readers every figure is withheld', mm.readers_with_positions === null && mm.share_with_decision_snapshot === null, mm);
  const more = ['c', 'd', 'e', 'f'].map((c) => '00000000-0000-0000-0000-00000000000' + c);
  db.sql(`insert into auth.users (id, email) select x::uuid, x || '@example.com' from unnest(array[${more.map(L).join(', ')}]) x;`);
  more.forEach((u) => wager(u, { event_start_at: H(10) }));
  mm = json(one(db.as(ADMIN, `select public.portfolio_admin_moat_metrics(400);`)));
  chk('with 5 or more, aggregate shares and counts — and not one reader id', mm.readers_with_positions >= 5 && mm.share_with_decision_snapshot > 0
    && mm.snapshots_by_origin.CARD >= 1 && ![A, B].concat(more).some((u) => JSON.stringify(mm).indexOf(u) >= 0), mm);

  const del = json(one(db.as(A, `select public.portfolio_delete_everything('DELETE MY PORTFOLIO');`)));
  const left = ['portfolio_positions', 'portfolio_journal_entries', 'portfolio_decision_snapshots', 'portfolio_market_path', 'portfolio_reflections',
    'portfolio_outcome_classes', 'portfolio_card_events', 'portfolio_rules', 'portfolio_experiments', 'portfolio_insights', 'platform_accounts', 'portfolio_facts_cache']
    .map((t) => [t, +db.sql(`select count(*) from public.${t} where user_id = ${L(A)};`)]).filter((x) => x[1] > 0);
  chk('delete removes every row the reader owns, in every table', left.length === 0 && del.positions === aPos
    && db.sql(`select count(*) from public.user_alerts where user_id = ${L(A)} and kind in ('decision_review', 'experiment_ready');`) === '0', { del, left });
  chk('…and nothing of anyone else\'s', +db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(B)};`) === bIds.length + 1
    && db.sql(`select count(*) from public.portfolio_baselines where user_id = ${L(B)};`) === '1');
  chk('deleting the account itself cascades through every Decision Record table',
    (db.sql(`delete from auth.users where id = ${L(B)};`), ['portfolio_decision_snapshots', 'portfolio_market_path', 'portfolio_reflections', 'portfolio_outcome_classes',
      'portfolio_baselines', 'portfolio_insights', 'portfolio_insight_observations', 'portfolio_card_events']
      .every((t) => db.sql(`select count(*) from public.${t} where user_id = ${L(B)};`) === '0')));
} catch (e) {
  chk('unexpected failure', false, String(e.sqlMessage || e.message || e).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());

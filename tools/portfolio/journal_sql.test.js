#!/usr/bin/env node
/* ===========================================================================
   supabase/portfolio_journal.sql — THE JOURNAL, THE GRADE AND THE CALENDAR,
   AGAINST A REAL POSTGRESQL, AS REAL READERS.

   Proves:
     - every process component and the grade equal, value for value, what
       lib/edgedesk_portfolio_process.js computes from the same inputs
       (hand-checked cases, then hundreds of seeded random ones);
     - a recorded decision is never rewritten — by the reader or the service
       role — and a model probability recorded after the event is not
       credited;
     - placed_at and event_start_at stay apart; timing buckets; weeks and
       days in the reader's own time zone; P&L lands on the SETTLEMENT day,
       activity on the PLACED day, exposure on the EVENT day;
     - a win at a bad price grades its bad price; a loss at a strong price
       grades its strong price;
     - sportsbook and prediction-market positions aggregate side by side,
       bonus bets carry no capital;
     - reader B can reach none of reader A's journal, grades, rules,
       experiments, calendar or breakdowns.

   Run: node tools/portfolio/journal_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const E = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio.js'));
const X = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_process.js'));

const T = PG.kit('portfolio journal SQL');
const chk = T.chk;
const L = PG.lit;
const BASE = path.join(PG.ROOT, 'supabase', 'portfolio.sql');
const FILE = path.join(PG.ROOT, 'supabase', 'portfolio_journal.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC ─────────────────────────────────────────────────────────────── */
chk('no psql meta-commands', !/^\s*\\/m.test(SQL));
chk('idempotent', /create table if not exists/.test(SQL) && !/create table (?!if not exists)/i.test(SQL) && !/create (unique )?index (?!if not exists)/i.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('row level security is never switched off', !/disable row level security/i.test(SQL));
const CODE = SQL.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
chk('no floating-point money or scores', !/\b(real|double precision|float[48]?)\b/i.test(CODE));
chk('the grade never takes profit or loss: no component function names pnl, profit or result',
  ['portfolio_score_clv', 'portfolio_score_model', 'portfolio_score_price', 'portfolio_score_timing', 'portfolio_score_sizing',
    'portfolio_score_market', 'portfolio_process_score', 'portfolio_clv_pct', 'portfolio_model_ev', 'portfolio_price_slip'].every((fn) => {
    const m = new RegExp('create or replace function public\\.' + fn + '\\(([^)]*)\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$').exec(SQL);
    return m && !/pnl|profit|result|payout/i.test(m[1] + m[2]);
  }));
chk('no analytics function runs as its owner', !/security definer/i.test(SQL.slice(SQL.indexOf('5. THE FACTS'))));

/* the paste-sized parts are this file, regenerated */
(function () {
  const os = require('os'), cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-parts-'));
  cp.execFileSync(process.execPath, [path.join(PG.ROOT, 'tools', 'sql', 'split_sql.js'), FILE, dir, '18000']);
  const fresh = fs.readdirSync(dir).filter((f) => /^portfolio_journal\.part/.test(f)).sort();
  const committed = fs.readdirSync(path.join(PG.ROOT, 'supabase', 'parts')).filter((f) => /^portfolio_journal\.part/.test(f)).sort();
  chk('supabase/parts/portfolio_journal.part*.sql are current (npm run portfolio:parts)', JSON.stringify(fresh) === JSON.stringify(committed)
    && fresh.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(PG.ROOT, 'supabase', 'parts', f), 'utf8')), { fresh, committed });
  chk('and every part fits one paste', fresh.every((f) => fs.statSync(path.join(dir, f)).size <= 20000));
  fs.rmSync(dir, { recursive: true, force: true });
}());

const db = PG.start('journal');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const one = (s) => String(s).split('\n')[0];
const json = (s) => JSON.parse(s || 'null');

/* a seeded generator, so a failure reproduces */
let seed = 20261004;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function dec(lo, hi, k) { return (lo + rnd() * (hi - lo)).toFixed(k); }

let minute = 0;
function wager(uid, o) {
  const m = minute++;
  const at = o.placed_at || new Date(Date.UTC(2026, 6, 1, 12, 0) + m * 60000).toISOString();
  const c = { platform: o.platform || 'draftkings', platform_label: o.platform_label || 'DraftKings', platform_type: 'SPORTSBOOK',
    position_type: o.position_type || 'SPREAD', event_name: o.event_name || 'Game ' + m, market_name: o.market_name || 'Spread',
    selection: o.selection || ('Pick ' + m), line: o.line, stake: o.stake || '100', odds_american: o.odds_american, odds_decimal: o.odds_decimal,
    status: o.status || 'OPEN', reported_payout: o.reported_payout, placed_at: at, settled_at: o.settled_at, event_start_at: o.event_start_at,
    sport: o.sport || 'NFL', source: o.source || 'MANUAL', stake_type: o.stake_type, model_probability: o.model_probability, edge_source: o.edge_source };
  const keys = Object.keys(c).filter((k) => c[k] != null);
  return one(db.as(uid, `insert into public.portfolio_positions (${keys.join(', ')}) values (${keys.map((k) => L(String(c[k]))).join(', ')}) returning id;`));
}
function journal(uid, id, set) {
  const parts = Object.keys(set).map((k) => k + ' = ' + (set[k] === null ? 'null' : Array.isArray(set[k]) ? L('{' + set[k].join(',') + '}') : L(String(set[k]))));
  return db.as(uid, `update public.portfolio_journal_entries set ${parts.join(', ')} where position_id = ${L(id)};`);
}
function factsOf(uid, id, tz) {
  return json(db.as(uid, `select row_to_json(f) from public.portfolio_facts(null, null, ${L(tz || 'UTC')}) f where f.id = ${L(id)};`));
}

try {
  db.applyFileAtomic(BASE);
  let out = db.applyFileAtomic(FILE);
  chk('the journal migration applies over portfolio.sql', true);
  chk('every report row reads ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 9, out.slice(-1200));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out));
  out = db.applyFileAtomic(BASE);
  chk('re-running portfolio.sql after it keeps the analytics closed to anon',
    db.sql(`select has_function_privilege('anon', 'public.portfolio_summary(timestamptz,timestamptz,text,text)', 'execute');`) === 'f');
  db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(B)}, 'b@example.com');`);

  /* ═══ PARITY: every component, SQL = JS ═══════════════════════════════ */
  const cases = [];
  for (let i = 0; i < 400; i++) {
    const pm = rnd() < 0.3, type = pm ? 'PREDICTION_MARKET' : 'SPORTSBOOK';
    const price = () => (rnd() < 0.15 ? null : pm ? dec(0.02, 0.98, 6) : dec(1.05, 9, 6));
    cases.push({ type, entry: price(), open: price(), research: price(), close: price(), prob: rnd() < 0.2 ? null : dec(0.02, 0.97, 4),
      points: rnd() < 0.7 ? null : dec(-3, 3, 1), units: rnd() < 0.2 ? null : dec(0.1, 4, 4), maxs: rnd() < 0.2 ? null : pick(['1', '1.5', '2', '0.75']),
      day: rnd() < 0.2 ? null : dec(0.1, 9, 4), maxd: rnd() < 0.2 ? null : pick(['4', '5', '3']), ptype: pick(['MONEYLINE', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'PARLAY', 'SAME_GAME_PARLAY', 'FUTURE', 'OTHER']),
      rules: rnd() < 0.5 ? null : String(Math.floor(rnd() * 101)) });
  }
  const lit = (v) => (v == null ? 'null' : L(v) + '::numeric');
  const rows = json(db.sql('select json_agg(r) from (values ' + cases.map((c, i) => `(${i},
      public.portfolio_clv_pct(${L(c.type)}, ${lit(c.entry)}, ${lit(c.close)})::text,
      public.portfolio_score_clv(public.portfolio_clv_pct(${L(c.type)}, ${lit(c.entry)}, ${lit(c.close)}), ${lit(c.points)})::text,
      public.portfolio_model_ev(${L(c.type)}, ${lit(c.prob)}, ${lit(c.entry)})::text,
      public.portfolio_score_model(public.portfolio_model_ev(${L(c.type)}, ${lit(c.prob)}, ${lit(c.entry)}))::text,
      public.portfolio_price_slip(${L(c.type)}, ${lit(c.entry)}, ${lit(c.research)})::text,
      public.portfolio_score_price(public.portfolio_price_slip(${L(c.type)}, ${lit(c.entry)}, ${lit(c.research)}), ${lit(c.points)})::text,
      public.portfolio_score_timing(${L(c.type)}, ${lit(c.entry)}, ${lit(c.open)}, ${lit(c.research)}, ${lit(c.close)})::text,
      public.portfolio_score_sizing(${lit(c.units)}, ${lit(c.maxs)}, ${lit(c.day)}, ${lit(c.maxd)})::text,
      public.portfolio_score_market(${L(c.type)}, ${L(c.ptype)})::text)`).join(',\n')
      + ') r(i, clv, sclv, ev, smodel, slip, sprice, stiming, ssizing, smarket);'));
  const norm = (v) => (v == null ? null : E.dec.str(v));
  const diffs = [];
  rows.forEach((r) => {
    const c = cases[r.i];
    const js = { clv: X.clvPct(c.type, c.entry, c.close) };
    js.sclv = X.scoreClv(js.clv, c.points);
    js.ev = X.modelEv(c.type, c.prob, c.entry); js.smodel = X.scoreModel(js.ev);
    js.slip = X.priceSlip(c.type, c.entry, c.research); js.sprice = X.scorePrice(js.slip, c.points);
    js.stiming = X.scoreTiming(c.type, c.entry, c.open, c.research, c.close);
    js.ssizing = X.scoreSizing(c.units, c.maxs, c.day, c.maxd);
    js.smarket = X.scoreMarket(c.type, c.ptype);
    Object.keys(js).forEach((k) => { if (norm(js[k]) !== norm(r[k])) diffs.push({ i: r.i, k, sql: r[k], js: js[k], c }); });
  });
  chk('400 random positions: CLV, model EV, price slip, timing, sizing, market and their scores — SQL = JS, value for value', diffs.length === 0, diffs.slice(0, 3));
  const combos = [];
  for (let i = 0; i < 300; i++) {
    const s = () => (rnd() < 0.45 ? null : dec(0, 100, 1));
    combos.push({ clv: s(), model: s(), price: s(), sizing: s(), timing: s(), rules: s(), market: rnd() < 0.2 ? null : pick(['80', '60', '40', '30', '20', '70']) });
  }
  const ps = json(db.sql('select json_agg(json_build_array(i, public.portfolio_process_score(c, m, p, s, t, r, k)::text, public.portfolio_process_weight(c, m, p, s, t, r, k), public.portfolio_grade_letter(public.portfolio_process_score(c, m, p, s, t, r, k)))) from (values '
    + combos.map((c, i) => `(${i}, ${lit(c.clv)}, ${lit(c.model)}, ${lit(c.price)}, ${lit(c.sizing)}, ${lit(c.timing)}, ${lit(c.rules)}, ${lit(c.market)})`).join(',')
    + ') v(i, c, m, p, s, t, r, k);'));
  const pdiff = ps.filter((r) => { const c = combos[r[0]]; return norm(X.processScore(c)) !== norm(r[1]) || X.processWeight(c) !== r[2] || X.gradeLetter(X.processScore(c)) !== r[3]; });
  chk('300 random component sets: the weighted, renormalized process score, its weight and its letter — SQL = JS', pdiff.length === 0, pdiff.slice(0, 3));
  const buckets = [[null, 'UNKNOWN'], [0, 'LIVE'], [-60, 'LIVE'], [1, 'UNDER_1H'], [3599, 'UNDER_1H'], [3600, 'H1_6'], [21599, 'H1_6'], [21600, 'H6_24'],
    [86399, 'H6_24'], [86400, 'D1_3'], [259200, 'D3_7'], [604799, 'D3_7'], [604800, 'D7_PLUS']];
  const sqlB = json(db.sql('select json_agg(public.portfolio_timing_bucket(v)) from (values ' + buckets.map((b) => '(' + (b[0] == null ? 'null::bigint' : b[0]) + ')').join(',') + ') x(v);'));
  chk('timing buckets at every boundary — SQL and JS agree, and the boundaries are where the docs say',
    JSON.stringify(sqlB) === JSON.stringify(buckets.map((b) => b[1])) && buckets.every((b) => X.timingBucket(b[0]) === b[1]), sqlB);
  const dirs = [['Over 47.5', null, 'OVER'], ['o47.5', null, 'OVER'], ['Under 9', null, 'UNDER'], ['u 9', null, 'UNDER'], ['Oklahoma -3', null, null], ['Utah +7', null, null], ['X', 'Over', 'OVER']];
  const sqlD = json(db.sql('select json_agg(public.portfolio_ou_direction(s, d)) from (values ' + dirs.map((x) => `(${L(x[0])}, ${x[1] == null ? 'null' : L(x[1])})`).join(',') + ') v(s, d);'));
  chk('over / under is read from the selection, never from a team name that starts with O or U', JSON.stringify(sqlD) === JSON.stringify(dirs.map((x) => x[2]))
    && dirs.every((x) => X.ouDirection(x[0], x[1]) === x[2]), sqlD);

  /* ═══ placed_at AND event_start_at STAY APART ═════════════════════════ */
  const sep = wager(A, { odds_american: '-110', placed_at: '2026-09-12T15:00:00Z', event_start_at: '2026-09-13T17:00:00Z' });
  let f = factsOf(A, sep);
  chk('placed_at and event_start_at are stored apart and read back unchanged; the lead is computed from the two',
    Date.parse(f.placed_at) === Date.parse('2026-09-12T15:00:00Z') && Date.parse(f.event_start_at) === Date.parse('2026-09-13T17:00:00Z')
    && +f.lead_seconds === 26 * 3600 && f.timing_bucket === 'D1_3', f);
  db.as(A, `update public.portfolio_positions set event_start_at = '2026-09-12T15:45:00Z' where id = ${L(sep)};`);
  f = factsOf(A, sep);
  chk('moving the event start moves the timing, never the placed time', Date.parse(f.placed_at) === Date.parse('2026-09-12T15:00:00Z') && f.timing_bucket === 'UNDER_1H');
  const live = wager(A, { odds_american: '+150', placed_at: '2026-09-13T18:00:00Z', event_start_at: '2026-09-13T17:00:00Z' });
  chk('a position placed after the start is LIVE', factsOf(A, live).timing_bucket === 'LIVE');

  /* ═══ THE JOURNAL: write-once, pre-event only ═════════════════════════ */
  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  const jd = wager(A, { odds_american: '-105', placed_at: new Date(Date.now() - 3600000).toISOString(), event_start_at: future, model_probability: '0.55', edge_source: 'SELF' });
  let j = json(db.as(A, `select row_to_json(j) from public.portfolio_journal_entries j where position_id = ${L(jd)};`));
  chk('a new position gets its journal entry, with the decision it arrived with', j && j.model_probability === 0.55 && j.decision_source === 'USER' && j.model_recorded_at && j.decision_recorded_at, j);
  let err = db.mustFail(() => journal(A, jd, { model_probability: '0.60' }));
  chk('a recorded model probability can never be rewritten by its reader', err !== null && /never rewritten/.test(err), err && err.slice(0, 200));
  err = db.mustFail(() => db.service(`update public.portfolio_journal_entries set model_probability = 0.6 where position_id = ${L(jd)};`));
  chk('…nor by the service role', err !== null && /never rewritten/.test(err));
  db.as(A, `update public.portfolio_positions set model_probability = 0.70 where id = ${L(jd)};`);
  chk('editing the position\'s own attribution later does not reach the recorded decision',
    db.as(A, `select model_probability::text from public.portfolio_journal_entries where position_id = ${L(jd)};`) === '0.55');
  chk('a field not yet recorded can be recorded once', db.mustFail(() => journal(A, jd, { research_odds_american: '-120', thesis: 'Rest edge; line opened soft.', decision_tags: ['MODEL', 'LINE_VALUE'], planned: 'true' })) === null
    && db.mustFail(() => journal(A, jd, { research_odds_american: '-115' })) !== null);
  chk('the review is the reader\'s and stays editable', db.mustFail(() => journal(A, jd, { would_repeat: 'YES', review_note: 'Same again.' })) === null
    && db.mustFail(() => journal(A, jd, { would_repeat: 'UNSURE' })) === null);
  chk('a reader\'s closing price is recorded as the reader\'s, whatever source they claim',
    db.mustFail(() => journal(A, jd, { closing_odds_american: '-125', closing_source: 'EDGEDESK_CAPTURE' })) === null
    && db.as(A, `select closing_source from public.portfolio_journal_entries where position_id = ${L(jd)};`) === 'USER');
  chk('a journal entry cannot be deleted by its reader (it goes only with its position)',
    db.mustFail(() => db.as(A, `delete from public.portfolio_journal_entries where position_id = ${L(jd)};`)) !== null
    && db.sql(`select count(*) from public.portfolio_journal_entries where position_id = ${L(jd)};`) === '1');
  f = factsOf(A, jd);
  chk('with a pre-event decision, model edge, price quality, CLV and timing are all graded', f.model_pre_event && f.research_pre_event
    && f.s_model != null && f.s_price != null && f.s_clv != null && f.s_timing != null && f.process_score != null && f.evidence === 'FULL_CONTEXT', f);
  /* the same probability recorded after the game is not credited */
  const retro = wager(A, { odds_american: '-105', placed_at: '2026-08-01T12:00:00Z', event_start_at: '2026-08-01T17:00:00Z', status: 'WON', settled_at: '2026-08-01T20:00:00Z' });
  journal(A, retro, { model_probability: '0.62' });
  f = factsOf(A, retro);
  chk('a model probability recorded after the event is kept but never credited as pre-event edge', f.model_pre_event === false && f.s_model === null, f);
  chk('a historical position with nothing recorded is RESULT ONLY — no decision is invented for it', f.evidence === 'RESULT_ONLY' && f.process_score === null);
  journal(A, retro, { closing_odds_american: '-110' });
  chk('with a closing price it becomes PARTIAL CONTEXT', factsOf(A, retro).evidence === 'PARTIAL_CONTEXT');

  /* ═══ PROCESS, NOT OUTCOME ═══════════════════════════════════════════ */
  /* a win at a bad price: took +100, closed +130 (the market moved away) */
  const badWin = wager(A, { odds_american: '+100', status: 'WON', placed_at: '2026-09-01T12:00:00Z', settled_at: '2026-09-01T23:00:00Z', position_type: 'MONEYLINE' });
  journal(A, badWin, { closing_odds_american: '+130' });
  /* a loss at a strong price: took +130, closed +100 */
  const goodLoss = wager(A, { odds_american: '+130', status: 'LOST', placed_at: '2026-09-01T12:01:00Z', settled_at: '2026-09-01T23:00:00Z', position_type: 'MONEYLINE' });
  journal(A, goodLoss, { closing_odds_american: '+100' });
  const fw = factsOf(A, badWin), fl = factsOf(A, goodLoss);
  chk('a WIN at a bad price gets a poor CLV score (2.00 taken, 2.30 at the close: −13.04% → 0)', fw.result === 'WIN' && +fw.clv_pct === -0.130435 && +fw.s_clv === 0, fw);
  chk('a LOSS at a strong price gets a strong CLV score (2.30 taken, 2.00 at the close: +15% → 100)', fl.result === 'LOSS' && +fl.clv_pct === 0.15 && +fl.s_clv === 100, fl);
  chk('and the grade follows the process, not the result', +fl.process_score > +fw.process_score && X.processBand(fw.process_score) === 'POOR' && X.processBand(fl.process_score) === 'GOOD',
    [fw.process_score, fl.process_score]);
  const sm = json(db.as(A, `select public.portfolio_summary('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'UTC');`));
  chk('the matrix finds the bad win and the good loss', sm.matrix['POOR:WIN'].n === 1 && sm.matrix['GOOD:LOSS'].n === 1, sm.matrix);
  /* a spread whose line moved is graded in points */
  const sp = wager(A, { odds_american: '-110', line: '-2.5', selection: 'Chiefs -2.5', position_type: 'SPREAD', placed_at: '2026-09-02T12:00:00Z' });
  journal(A, sp, { closing_line: '-3.5', closing_odds_american: '-110' });
  const tot = wager(A, { odds_american: '-110', line: '47.5', selection: 'Over 47.5', position_type: 'TOTAL', placed_at: '2026-09-02T12:05:00Z' });
  journal(A, tot, { closing_line: '46.5', closing_odds_american: '-110' });
  chk('a spread taken at −2.5 that closed −3.5 beat the close by 1 point (75); an over at 47.5 that closed 46.5 lost a point (25)',
    +factsOf(A, sp).clv_points === 1 && +factsOf(A, sp).s_clv === 75 && +factsOf(A, tot).clv_points === -1 && +factsOf(A, tot).s_clv === 25);

  /* ═══ PREDICTION MARKETS SIDE BY SIDE; BONUS BETS ═════════════════════ */
  const pm = one(db.as(A, `select public.portfolio_record_prediction('{"platform":"kalshi","platform_label":"Kalshi","event_name":"Will it rain?","market_name":"Rain","side":"YES","resolution":"YES","settled_at":"2026-09-03T20:00:00Z","fills":[{"action":"BUY","quantity":"100","price":"0.40","executed_at":"2026-09-03T12:00:00Z"}]}'::jsonb);`));
  journal(A, pm, { closing_price: '0.50', model_probability: '0.48' });
  f = factsOf(A, pm);
  chk('a contract bought at 40¢ that closed at 50¢ has +25% CLV — the same quantity as a sportsbook price', +f.clv_pct === 0.25 && +f.s_clv === 100, f);
  const bonus = wager(A, { odds_american: '+200', stake: '25', stake_type: 'BONUS', status: 'WON', placed_at: '2026-09-03T12:00:00Z', settled_at: '2026-09-03T22:00:00Z', position_type: 'MONEYLINE' });
  const bonusLoss = wager(A, { odds_american: '+200', stake: '25', stake_type: 'BONUS', status: 'LOST', placed_at: '2026-09-03T12:01:00Z', settled_at: '2026-09-03T22:00:00Z', position_type: 'MONEYLINE' });
  const bw = json(db.as(A, `select json_agg(json_build_array(profit_loss::text, cost_basis::text, gross_payout::text, potential_payout::text) order by placed_at) from public.portfolio_positions where id in (${L(bonus)}, ${L(bonusLoss)});`));
  const jsB = E.derive({ platform_type: 'SPORTSBOOK', stake: '25', odds_american: 200, status: 'WON', stake_type: 'BONUS' });
  const jsL = E.derive({ platform_type: 'SPORTSBOOK', stake: '25', odds_american: 200, status: 'LOST', stake_type: 'BONUS' });
  chk('a $25 bonus bet at +200 that wins pays the $50 profit only; one that loses costs nothing — SQL = JS',
    JSON.stringify(bw) === JSON.stringify([['50', '0', '50', '50'], ['0', '0', '0', '50']])
    && jsB.profit_loss === '50' && jsB.cost_basis === '0' && jsL.profit_loss === '0', { bw, jsB, jsL });
  const s3 = json(db.as(A, `select public.portfolio_summary('2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z', 'UTC');`));
  chk('sportsbook and prediction-market P&L aggregate side by side; a bonus bet adds P&L but no capital',
    +s3.settled.sportsbook.pnl === 50 && +s3.settled.sportsbook.staked === 0 && +s3.settled.prediction.pnl === 60 && +s3.settled.prediction.staked === 40
    && +s3.settled.pnl === 110 && +s3.settled.roi === 2.75, s3.settled);
  const onlyK = json(db.as(A, `select public.portfolio_summary('2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z', 'UTC', 'kalshi');`));
  const onlyPM = json(db.as(A, `select public.portfolio_summary('2026-09-03T00:00:00Z', '2026-09-04T00:00:00Z', 'UTC', 'type:PREDICTION_MARKET');`));
  chk('the combined book filters to one platform or one kind', +onlyK.settled.pnl === 60 && onlyK.settled.n === 1 && +onlyPM.settled.pnl === 60);

  /* ═══ THE CALENDAR: placed, event and settled days, in the reader's zone ═══ */
  /* placed late Monday night in Los Angeles = Tuesday in UTC; settled the
     following Monday 02:00 UTC = Sunday evening in Los Angeles */
  const cal = wager(A, { odds_american: '-110', status: 'WON', placed_at: '2026-09-15T05:30:00Z', event_start_at: '2026-09-20T17:00:00Z',
    settled_at: '2026-09-21T02:00:00Z', platform: 'fanduel', platform_label: 'FanDuel' });
  const calUTC = json(db.as(A, `select json_agg(c) from public.portfolio_calendar('2026-09-14', '2026-09-22', 'UTC', 'fanduel') c;`));
  const calLA = json(db.as(A, `select json_agg(c) from public.portfolio_calendar('2026-09-14', '2026-09-22', 'America/Los_Angeles', 'fanduel') c;`));
  const day = (c, d) => (c || []).find((x) => x.day === d) || {};
  chk('UTC: entered Tuesday 15th, event Sunday 20th, P&L lands Monday 21st',
    day(calUTC, '2026-09-15').placed === 1 && day(calUTC, '2026-09-20').events === 1 && day(calUTC, '2026-09-21').settled === 1 && +day(calUTC, '2026-09-21').pnl === 90.91, calUTC);
  chk('Los Angeles: the same position was entered Monday 14th and its P&L lands Sunday 20th',
    day(calLA, '2026-09-14').placed === 1 && day(calLA, '2026-09-20').settled === 1 && day(calLA, '2026-09-20').events === 1 && !day(calLA, '2026-09-21').settled, calLA);
  const per = (tz) => json(db.as(A, `select json_agg(p) from public.portfolio_periods(${L(tz)}, 2026, 'fanduel') p;`));
  const wk = (rows, lvl, key, val) => (rows || []).filter((r) => r.level === lvl && r[key] === val)[0] || {};
  const pUTC = per('UTC'), pLA = per('America/Los_Angeles');
  chk('weeks follow the reader\'s zone: in UTC the entry is in the week of Mon 14th and the P&L in the week of Mon 21st; in Los Angeles both fall in the week of the 14th',
    wk(pUTC, 'week', 'week', '2026-09-14').placed === 1 && +wk(pUTC, 'week', 'week', '2026-09-21').pnl === 90.91
    && wk(pLA, 'week', 'week', '2026-09-14').placed === 1 && +wk(pLA, 'week', 'week', '2026-09-14').pnl === 90.91 && !wk(pLA, 'week', 'week', '2026-09-21').settled,
    { pUTC: pUTC && pUTC.filter((r) => r.level === 'week'), pLA: pLA && pLA.filter((r) => r.level === 'week') });
  chk('the folders run year → month → week → day, each with its own summary',
    ['year', 'month', 'week', 'day'].every((l) => (pUTC || []).some((r) => r.level === l)) && wk(pUTC, 'year', 'year', 2026).placed === 1);
  chk('an unknown time zone is an error, never a silent UTC', db.mustFail(() => db.as(A, `select * from public.portfolio_calendar('2026-09-01', '2026-09-02', 'Mars/Olympus');`)) !== null);
  const dayList = json(db.as(A, `select json_agg(x) from public.portfolio_list(null, null, 'America/Los_Angeles', '{"basis":"placed","day":"2026-09-14"}', 50, 'fanduel') x;`));
  chk('a day\'s journal lists what was entered that day, with its journal', dayList && dayList.length === 1 && dayList[0].id === cal && dayList[0].journal, dayList);

  /* ═══ RULES: never retroactive, frozen once adopted ═════════════════════ */
  const before = wager(A, { odds_american: '-110', stake: '500', placed_at: new Date(Date.now() - 86400000).toISOString() });
  chk('a malformed rule is refused', db.mustFail(() => db.as(A, `insert into public.portfolio_rules (kind, params, label) values ('MAX_STAKE_UNITS', '{"units":"lots"}', 'x');`)) !== null);
  /* the unit and caps in force at entry, read from the staking engine's own
     table (here a minimal stand-in with the same columns) */
  db.sql(`create table public.bankroll_settings (user_id uuid primary key, bankroll_amount numeric, base_unit_amount numeric, unit_mode text,
            unit_percent numeric, maximum_single_wager_units numeric, maximum_daily_exposure_units numeric);
          alter table public.bankroll_settings enable row level security;
          create policy own on public.bankroll_settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
          grant select, insert, update on public.bankroll_settings to authenticated;
          insert into public.bankroll_settings values (${L(A)}, 1000, null, 'percent', 0.02, 1, 4);`);
  const sized = wager(A, { odds_american: '-110', stake: '50', placed_at: new Date(Date.now() - 60000).toISOString() });
  const js = json(db.as(A, `select row_to_json(j) from public.portfolio_journal_entries j where position_id = ${L(sized)};`));
  f = factsOf(A, sized);
  chk('the unit in force is snapshotted at entry (2% of a $1,000 bankroll = $20) with the caps; $50 is 2.5 units against a 1-unit cap → sizing 0',
    +js.unit_size_at_entry === 20 && +js.max_single_units_at_entry === 1 && +js.max_daily_units_at_entry === 4 && +f.units === 2.5 && +f.s_sizing === 0, { js, f });
  db.sql(`update public.bankroll_settings set bankroll_amount = 5000 where user_id = ${L(A)};`);
  chk('a later change to the bankroll never rewrites the unit a past position was sized against',
    +json(db.as(A, `select row_to_json(j) from public.portfolio_journal_entries j where position_id = ${L(sized)};`)).unit_size_at_entry === 20);
  const ruleId = one(db.as(A, `insert into public.portfolio_rules (kind, params, label) values ('NO_PARLAYS', '{}', 'No parlays') returning id;`));
  const par = wager(A, { odds_american: '+600', position_type: 'PARLAY', placed_at: new Date(Date.now() + 1000).toISOString() });
  chk('a rule judges positions placed after it was adopted, and not before', factsOf(A, par).rules_applicable === 1 && factsOf(A, par).rules_followed === 0
    && JSON.stringify(factsOf(A, par).rules_broken) === '["No parlays"]' && factsOf(A, before).rules_applicable === 0);
  db.as(A, `update public.portfolio_rules set kind = 'NO_LIVE', params = '{"x":1}', active_from = '2020-01-01' where id = ${L(ruleId)};`);
  chk('a rule\'s meaning is frozen once adopted (kind, parameters and start)', db.as(A, `select kind || ' ' || params::text || ' ' || (active_from > '2021-01-01')::text from public.portfolio_rules where id = ${L(ruleId)};`) === 'NO_PARLAYS {} true');
  const exp = one(db.as(A, `insert into public.portfolio_experiments (title, metric, condition, ends_at) values ('Enter earlier', 'CLV', '{"dim":"timing","key":"D1_3"}', now() + interval '28 days') returning id;`));
  db.as(A, `update public.portfolio_experiments set metric = 'ROI', ends_at = now() + interval '200 days' where id = ${L(exp)};`);
  chk('an experiment is pre-registered: its metric and window cannot be changed after it starts',
    db.as(A, `select metric || ' ' || (ends_at < now() + interval '30 days')::text from public.portfolio_experiments where id = ${L(exp)};`) === 'CLV true');

  /* ═══ BEFORE YOU ENTER: context, never a verdict ══════════════════════ */
  const pre = json(db.as(A, `select public.portfolio_pre_bet('{"platform":"draftkings","sport":"NFL","position_type":"PARLAY","odds_american":"+500","stake":"20","event_start_at":"${future}"}'::jsonb, 'UTC');`));
  chk('the pre-entry context names the rule a draft would break and its timing, with the reader\'s own history',
    pre && pre.timing_bucket === 'D1_3' && pre.rules.some((r) => r.label === 'No parlays' && r.verdict === 'BROKEN') && Array.isArray(pre.history) && pre.history.some((h) => h.dim === 'all'), pre);
  chk('…and says nothing like BET or DON\'T BET', !/\b(BET|DON'?T BET|LOCK|GUARANTEED)\b/.test(JSON.stringify(Object.keys(pre))) && X.clean(JSON.stringify(pre)));

  /* ═══ READER B REACHES NONE OF IT ════════════════════════════════════ */
  wager(B, { odds_american: '-110', status: 'LOST', placed_at: '2026-09-01T12:00:00Z', settled_at: '2026-09-01T20:00:00Z' });
  const bs = json(db.as(B, `select public.portfolio_summary(null, null, 'UTC');`));
  chk('reader B\'s summary counts only B\'s position', bs.settled.n === 1 && +bs.settled.pnl === -100, bs.settled);
  chk('reader B sees none of A\'s journal entries, rules or experiments',
    db.as(B, `select (select count(*) from public.portfolio_journal_entries where user_id = ${L(A)}) + (select count(*) from public.portfolio_rules) + (select count(*) from public.portfolio_experiments);`) === '0');
  chk('reader B\'s calendar, breakdowns and lists hold nothing of A\'s', db.as(B, `select count(*) from public.portfolio_calendar('2026-09-14', '2026-09-22', 'UTC');`) === '0'
    && db.as(B, `select coalesce(max(n), 0) from public.portfolio_cells(null, null, 'UTC') where dim = 'all';`) === '1'
    && db.as(B, `select count(*) from public.portfolio_list(null, null, 'UTC', '{}', 200);`) === '1');
  chk('reader B cannot write into A\'s journal', (db.as(B, `update public.portfolio_journal_entries set review_note = 'x' where position_id = ${L(jd)};`),
    db.sql(`select coalesce(review_note, '') from public.portfolio_journal_entries where position_id = ${L(jd)};`)) === 'Same again.');
  chk('reader B cannot attach a journal entry to A\'s position', db.mustFail(() => db.as(B, `insert into public.portfolio_journal_entries (position_id) values (${L(sep)});`)) !== null);
  chk('reader B cannot retire A\'s rule', (db.as(B, `update public.portfolio_rules set active_until = now() where id = ${L(ruleId)};`),
    db.sql(`select active_until is null from public.portfolio_rules where id = ${L(ruleId)};`)) === 't');
  chk('anon can call none of the analytics', db.mustFail(() => db.anon(`select public.portfolio_summary(null, null, 'UTC');`)) !== null
    && db.mustFail(() => db.anon(`select * from public.portfolio_calendar('2026-09-01', '2026-09-30', 'UTC');`)) !== null);

  /* ═══ THE COACH ON REAL AGGREGATES ═══════════════════════════════════ */
  const cellsA = json(db.as(A, `select json_agg(c) from public.portfolio_cells(null, null, 'UTC') c;`));
  const res = X.analyze(cellsA, { period: 'all time' });
  const hl = X.headlines(res);
  chk('on a handful of positions the coach finds nothing reliable and says so, with how much more it needs',
    res.findings.every((x) => x.level === 'OBSERVATION' || x.cell.n >= 30) && hl.working.length === 0 && hl.not_working.length === 0
    && /NO RELIABLE LEAK DETECTED/.test(hl.none_text) && /\d+ positions analysed/.test(hl.none_detail), { findings: res.findings.length, hl });
  chk('the cells carry the halves and the holdout the stability tests read', cellsA.every((c) => c.segs && Array.isArray(c.segs.h1) && c.segs.h1.length === 9));

  /* ═══ THE CACHE: incremental refreshes equal a full recomputation ══════ */
  const COLS = 'id, platform, status, result, placed_day, settled_day, event_day, placed_dow, event_dow, hour_band, lead_seconds, timing_bucket, '
    + 'stake_amt, pnl, ret, entry_dec, units, day_units, day_count, session_order, after_result, decision_tags, planned, would_repeat, '
    + 'clv_pct, clv_points, model_ev, price_slip, s_clv, s_model, s_price, s_sizing, s_timing, s_rules, s_market, process_score, grade, '
    + 'rules_applicable, rules_followed, rules_broken, evidence';
  const fresh = (tz) => db.as(A, `select public.portfolio_facts_fresh(${L(tz)});`);
  const same = (tz) => {
    fresh(tz);
    const a = db.as(A, `select md5(coalesce(string_agg(row(${COLS})::text, '|' order by id), '')) from public.portfolio_facts(null, null, ${L(tz)});`);
    const b = db.as(A, `select md5(coalesce(string_agg(row(${COLS})::text, '|' order by id), '')) from public.portfolio_facts_cached(null, null, ${L(tz)});`);
    return a === b;
  };
  chk('the first request builds the reader\'s cache, identical to the live computation', same('America/Chicago'));
  const ids = db.as(A, `select string_agg(id::text, ',' order by placed_at) from public.portfolio_positions;`).split(',');
  let steps = 0, ok = true;
  for (let i = 0; i < 12 && ok; i++) {
    const id = pick(ids);
    const op = i % 6;
    if (op === 0) db.as(A, `update public.portfolio_positions set odds_american = ${pick(['-120', '+140', '-105'])} where id = ${L(id)} and platform_type = 'SPORTSBOOK' and source <> 'SYNC';`);
    if (op === 1) db.as(A, `update public.portfolio_journal_entries set review_note = 'edit ${i}' where position_id = ${L(id)};`);
    if (op === 2) wager(A, { odds_american: '+120', status: 'LOST', placed_at: '2026-09-01T12:30:00Z', settled_at: '2026-09-01T13:00:00Z' });
    if (op === 3) db.as(A, `update public.portfolio_positions set settled_at = settled_at + interval '20 hours' where id = ${L(id)} and status <> 'OPEN' and source <> 'SYNC';`);
    if (op === 4) db.as(A, `delete from public.portfolio_positions where id = ${L(id)} and source <> 'SYNC';`);
    if (op === 5) wager(A, { odds_american: '-150', stake: '30', placed_at: '2026-09-15T05:40:00Z', event_start_at: '2026-09-15T08:00:00Z' });
    steps++; ok = same('America/Chicago');
  }
  chk('after each of ' + steps + ' edits, inserts, settlements and deletes, the incrementally refreshed cache equals a full recomputation', ok);
  db.as(A, `insert into public.portfolio_rules (kind, params, label) values ('MAX_POSITIONS_PER_DAY', '{"count": 3}', 'Three a day');`);
  chk('a new rule rebuilds the whole cache, and it still equals the live computation', same('America/Chicago'));
  chk('each zone has its own cache', same('Asia/Tokyo')
    && db.as(A, `select count(*) from public.portfolio_facts_cache_state where tz in ('America/Chicago', 'Asia/Tokyo');`) === '2');
  chk('reader B cannot see or write A\'s cache', db.as(B, `select count(*) from public.portfolio_facts_cache where user_id = ${L(A)};`) === '0'
    && db.mustFail(() => db.as(B, `insert into public.portfolio_facts_cache (user_id, tz, id) values (${L(A)}, 'UTC', gen_random_uuid());`)) !== null);

  /* ═══ VOLUME: 2,000 positions, answered without downloading them ══════ */
  db.sql(`insert into public.portfolio_positions (user_id, platform, platform_label, platform_type, position_type, event_name, market_name, selection,
            stake, odds_american, status, placed_at, settled_at, event_start_at, sport, source)
          select ${L(A)}, 'betmgm', 'BetMGM', 'SPORTSBOOK', (array['SPREAD','TOTAL','MONEYLINE','PLAYER_PROP'])[1 + i % 4], 'Bulk game ' || i, 'Market', 'Pick ' || i,
                 10 + i % 90, case when i % 2 = 0 then -110 else 120 end, case when i % 3 = 0 then 'LOST' else 'WON' end,
                 timestamptz '2025-01-01' + make_interval(hours => i * 3), timestamptz '2025-01-01' + make_interval(hours => i * 3 + 5),
                 timestamptz '2025-01-01' + make_interval(hours => i * 3 + 2), (array['NFL','NBA','CFB'])[1 + i % 3], 'CSV'
            from generate_series(1, 2000) i;`);
  const t0 = Date.now();
  const sumBig = json(db.as(A, `select public.portfolio_summary(null, null, 'America/New_York');`));
  const t1 = Date.now();
  const cellsBig = json(db.as(A, `select json_agg(c) from public.portfolio_cells(null, null, 'America/New_York') c;`));
  const t2 = Date.now();
  chk('2,000+ positions: the lifetime summary and every breakdown cell come back as aggregates (' + (t1 - t0) + ' ms, ' + (t2 - t1) + ' ms)',
    sumBig.settled.n > 2000 && cellsBig.length < 400 && (t1 - t0) < 15000 && (t2 - t1) < 15000, { n: sumBig.settled.n, cells: cellsBig.length });
  chk('…and every one of them got its journal entry', db.sql(`select count(*) from public.portfolio_positions p where not exists (select 1 from public.portfolio_journal_entries j where j.position_id = p.id);`) === '0');
  chk('bulk history with no recorded decisions is RESULT ONLY and ungraded — the coach invents nothing for it',
    json(db.as(A, `select json_build_object('n', count(*), 'graded', count(process_score)) from public.portfolio_facts(null, null, 'UTC', 'betmgm') where evidence = 'RESULT_ONLY';`)).graded === 0);
} catch (e) {
  chk('unexpected failure', false, String(e.sqlMessage || e.message || e).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());

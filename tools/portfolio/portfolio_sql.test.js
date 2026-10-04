#!/usr/bin/env node
/* ===========================================================================
   supabase/portfolio.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   A reader's betting history is financial data. "RLS is on" is a claim; this
   proves it by acting as reader A, as reader B reaching for A's rows, as anon,
   and as the service role a connector will use. It also proves:

     - the money: every derived column the database stores equals what
       lib/edgedesk_portfolio.js derive() computes from the same inputs —
       the hand-checked cases, then hundreds of seeded random ones;
     - the fingerprint: the material the database hashes is byte for byte
       the material the browser builds;
     - the import pipeline: staged → classified (new / duplicate / duplicate
       in file / needs review / invalid) → committed exactly once, with a
       failing row recorded rather than sinking the rest;
     - deletion: removing an account removes every row it owned.

   Run: node tools/portfolio/portfolio_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const E = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio.js'));
const I = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_import.js'));

const T = PG.kit('portfolio SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'portfolio.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const L = PG.lit;

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\s*\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL)
  && !/create table (?!if not exists)/i.test(SQL) && !/create (unique )?index (?!if not exists)/i.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL) && !/\bdrop schema\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('row level security is never switched off', !/disable row level security/i.test(SQL));
chk('no hardcoded user id', !/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i.test(SQL));
/* code only: comments and quoted text removed; the one double in the file is
   the operator view's latency percentile, which is milliseconds, not money */
const CODE = SQL.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''").replace(/p50_ms double precision, p95_ms double precision/, '');
chk('no floating-point money', !/\b(real|double precision|float[48]?)\b/i.test(CODE));
/* the paste-sized parts are this file, regenerated */
(function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-parts-'));
  cp.execFileSync(process.execPath, [path.join(PG.ROOT, 'tools', 'sql', 'split_sql.js'), FILE, dir, '18000']);
  const fresh = fs.readdirSync(dir).filter((f) => /^portfolio\.part/.test(f)).sort();
  const committed = fs.readdirSync(path.join(PG.ROOT, 'supabase', 'parts')).filter((f) => /^portfolio\.part/.test(f)).sort();
  chk('supabase/parts/portfolio.part*.sql are current (npm run portfolio:parts)', JSON.stringify(fresh) === JSON.stringify(committed)
    && fresh.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(PG.ROOT, 'supabase', 'parts', f), 'utf8')),
    { fresh, committed });
  chk('and every part fits one paste', fresh.every((f) => fs.statSync(path.join(dir, f)).size <= 20000));
  fs.rmSync(dir, { recursive: true, force: true });
}());

const db = PG.start('portfolio');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = '00000000-0000-0000-0000-0000000000ad';
const C1 = '00000000-0000-0000-0000-0000000000c1';   /* two fresh readers for the batch-size comparison */
const C2 = '00000000-0000-0000-0000-0000000000c2';
const COLS = E.DERIVED;
const one = (s) => s.split('\n')[0];
const json = (s) => JSON.parse(s || 'null');
const txt = (c) => `trim_scale(${c})::text`;
const DERIVED_SQL = 'json_build_object(' + COLS.map((c) => `'${c}', ` + (c === 'status' || c === 'result' ? c : txt(c))).join(', ') + ')';

/* one wager row, as a PostgREST insert would send it */
let minute = 0;
function wagerSql(o) {
  const at = o.placed_at || new Date(Date.UTC(2026, 7, 1, 12, 0) + (minute++) * 60000).toISOString();
  const cols = { platform: o.platform || 'draftkings', platform_label: o.platform_label || 'DraftKings', platform_type: 'SPORTSBOOK',
    position_type: o.position_type || 'SPREAD', event_name: o.event_name || 'Chiefs @ Bills', market_name: o.market_name || 'Spread',
    selection: o.selection || ('Chiefs -2.5 #' + minute), stake: o.stake, odds_american: o.odds_american, odds_decimal: o.odds_decimal,
    status: o.status || 'OPEN', reported_payout: o.reported_payout, fees: o.fees, placed_at: at, settled_at: o.settled_at,
    sport: o.sport || 'NFL', source: o.source || 'MANUAL', dedupe_occurrence: o.dedupe_occurrence, notes: o.notes,
    edge_source: o.edge_source, edge_ref_type: o.edge_ref_type, edge_ref_id: o.edge_ref_id, platform_account_id: o.platform_account_id,
    external_position_id: o.external_position_id, line: o.line, user_id: o.user_id, stake_type: o.stake_type };
  const keys = Object.keys(cols).filter((k) => cols[k] !== undefined && cols[k] !== null);
  return `insert into public.portfolio_positions (${keys.join(', ')}) values (${keys.map((k) => L(String(cols[k]))).join(', ')}) returning id;`;
}
function wager(uid, o) { return one(db.as(uid, wagerSql(o))); }
function derivedOf(uid, id) { return json(db.as(uid, `select ${DERIVED_SQL} from public.portfolio_positions where id = ${L(id)};`)); }
function prediction(uid, p) { return one(db.as(uid, `select public.portfolio_record_prediction(${L(JSON.stringify(p))}::jsonb);`)); }
function canon(o) {
  const out = {};
  COLS.forEach((k) => { const v = o[k]; out[k] = v == null ? null : (k === 'status' || k === 'result') ? v : E.dec.str(v); });
  return out;
}
function sameDerived(label, sqlRow, jsRow) {
  const a = canon(sqlRow), b = canon(jsRow);
  const diff = COLS.filter((k) => a[k] !== b[k]).map((k) => k + ': sql=' + a[k] + ' js=' + b[k]);
  chk(label, diff.length === 0, diff);
}

try {
  let out = db.applyFileAtomic(FILE);
  chk('the migration applies to a clean database', true);
  chk('every report row says ok', !/CHECK THIS/.test(out), out.slice(-800));
  chk('and the report has its fifteen rows', (out.match(/\|ok$/gm) || []).length === 15, out.slice(-800));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time without error, still all ok', !/CHECK THIS/.test(out));
  db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(B)}, 'b@example.com'), (${L(ADMIN)}, 'op@example.com'), (${L(C1)}, 'c1@example.com'), (${L(C2)}, 'c2@example.com');`);

  /* re-running it on a live site: a reader saving a position holds positions
     and then reads accounts. Run as the SQL editor runs it, it must deadlock
     neither side. */
  const saver = db.background(`begin;
    do $c$ begin perform set_config('request.jwt.claim.sub', ${L(A)}, true); end $c$;
    set local role authenticated;
    ${wagerSql({ stake: '10', odds_american: '-110', selection: 'concurrency probe' })}
    select pg_sleep(1.5);
    select public.portfolio_record_prediction('{"platform":"kalshi","platform_label":"Kalshi","event_name":"Probe","market_name":"Probe","side":"YES","fills":[{"action":"BUY","quantity":"1","price":"0.5","executed_at":"2026-08-01T00:00:00Z"}]}'::jsonb);
    commit;`);
  db.sleep(0.4);
  const rerun = db.mustFail(() => db.applyFileAtomic(FILE));
  const sv = saver.wait(60000);
  chk('re-running it while a reader saves deadlocks neither side', rerun === null && sv.code === 0, { rerun: rerun && rerun.slice(0, 300), saver: sv });
  db.sql(`delete from public.portfolio_positions; delete from public.platform_accounts;`);

  /* ═══ SPORTSBOOK ARITHMETIC ═══════════════════════════════════════════ */
  const SB = [
    ['+100 winner', { stake: '100', odds_american: '100', status: 'WON' }, { profit_loss: '100', gross_payout: '200', result: 'WIN' }],
    ['+150 winner pays $250 and profits $150', { stake: '100', odds_american: '150', status: 'WON' }, { profit_loss: '150', gross_payout: '250' }],
    ['+200 winner', { stake: '100', odds_american: '200', status: 'WON' }, { profit_loss: '200', gross_payout: '300' }],
    ['-110 winner pays $190.91 and profits $90.91', { stake: '100', odds_american: '-110', status: 'WON' }, { profit_loss: '90.91', gross_payout: '190.91', odds_decimal: '1.909091' }],
    ['-200 winner', { stake: '100', odds_american: '-200', status: 'WON' }, { profit_loss: '50', gross_payout: '150' }],
    ['a loss is the stake', { stake: '100', odds_american: '-110', status: 'LOST' }, { profit_loss: '-100', gross_payout: '0', result: 'LOSS' }],
    ['a push returns the stake', { stake: '100', odds_american: '-110', status: 'PUSH' }, { profit_loss: '0', gross_payout: '100', result: 'PUSH' }],
    ['a void returns the stake', { stake: '100', odds_american: '+150', status: 'VOID' }, { profit_loss: '0', gross_payout: '100', result: 'VOID' }],
    ['a cash-out pays what the book paid', { stake: '100', odds_american: '+300', status: 'CASHED_OUT', reported_payout: '60' }, { profit_loss: '-40', result: 'CASHOUT' }],
    ['decimal odds 1.91 profit $91', { stake: '100', odds_decimal: '1.91', status: 'WON' }, { profit_loss: '91', gross_payout: '191' }],
    ['fees come out of the profit', { stake: '100', odds_american: '-110', status: 'WON', fees: '2.5' }, { profit_loss: '88.41' }],
    ['a two-leg parlay at +264 wins $264', { stake: '100', odds_american: '264', status: 'WON', position_type: 'PARLAY' }, { profit_loss: '264', gross_payout: '364' }],
    ['a parlay settled at a re-priced payout (one leg pushed)', { stake: '100', odds_american: '264', status: 'SETTLED', reported_payout: '190.91', position_type: 'PARLAY' }, { profit_loss: '90.91', result: 'WIN' }],
    ['an open bet has risk and potential, and no P&L', { stake: '100', odds_american: '-110', status: 'OPEN' }, { profit_loss: null, open_cost_basis: '100', potential_profit: '90.91', potential_payout: '190.91', result: null }],
    ['a penny at -110 rounds half away from zero', { stake: '0.01', odds_american: '-110', status: 'WON' }, { profit_loss: '0.01' }],
    ['$33.33 at +333 → $110.99', { stake: '33.33', odds_american: '333', status: 'WON' }, { profit_loss: '110.99' }],
    ['$10 at -115 → $8.70', { stake: '10', odds_american: '-115', status: 'WON' }, { profit_loss: '8.7' }]
  ];
  SB.forEach(([label, input, want]) => {
    const id = wager(A, input);
    const got = derivedOf(A, id);
    const bad = Object.keys(want).filter((k) => (want[k] == null ? got[k] !== null : (k === 'result' || k === 'status' ? got[k] !== want[k] : got[k] == null || E.dec.cmp(got[k], want[k]) !== 0)));
    chk('sportsbook: ' + label, bad.length === 0, { want, got });
    sameDerived('parity: ' + label, got, E.derive(Object.assign({ platform_type: 'SPORTSBOOK' }, input)));
  });
  chk('a cash-out with no payout is refused', db.mustFail(() => wager(A, { stake: '100', odds_american: '-110', status: 'CASHED_OUT' })) !== null);
  chk('odds between -100 and +100 are refused', db.mustFail(() => wager(A, { stake: '100', odds_american: '50', status: 'OPEN' })) !== null);
  chk('fractions of a cent are refused as a stake', db.mustFail(() => wager(A, { stake: '10.005', odds_american: '-110' })) !== null);
  chk('a bet placed in the future is refused', db.mustFail(() => wager(A, { stake: '10', odds_american: '-110', placed_at: '2099-01-01T00:00:00Z' })) !== null);
  chk('a settled bet cannot be prediction-market shaped', db.mustFail(() => wager(A, { stake: '10', odds_american: '-110', status: 'SETTLED' })) !== null);

  /* settling and un-settling by edit */
  const editId = wager(A, { stake: '50', odds_american: '120', status: 'OPEN' });
  db.as(A, `update public.portfolio_positions set status = 'WON' where id = ${L(editId)};`);
  let r = json(db.as(A, `select json_build_object('pl', profit_loss::text, 'at', settled_at is not null) from public.portfolio_positions where id = ${L(editId)};`));
  chk('marking a bet won settles it and computes the P&L', r.pl === '60' && r.at === true, r);
  db.as(A, `update public.portfolio_positions set status = 'OPEN' where id = ${L(editId)};`);
  r = json(db.as(A, `select json_build_object('pl', profit_loss, 'at', settled_at) from public.portfolio_positions where id = ${L(editId)};`));
  chk('and re-opening it clears the P&L and the settlement time', r.pl === null && r.at === null, r);
  db.as(A, `update public.portfolio_positions set profit_loss = 999999, gross_payout = 1, status = 'LOST' where id = ${L(editId)};`);
  r = json(db.as(A, `select json_build_object('pl', profit_loss::text, 'g', gross_payout::text) from public.portfolio_positions where id = ${L(editId)};`));
  chk('a client cannot store a P&L its inputs do not produce', r.pl === '-50' && r.g === '0', r);

  /* ═══ PREDICTION-MARKET ARITHMETIC ════════════════════════════════════ */
  const t0 = Date.UTC(2026, 8, 1, 15, 0);
  const at = (h) => new Date(t0 + h * 3600000).toISOString();
  const PM = [
    ['YES resolves YES: 100 @ $0.61 → $100, profit $39', { side: 'YES', resolution: 'YES' }, [['BUY', '100', '0.61', '0']], { cost_basis: '61', gross_payout: '100', profit_loss: '39', result: 'WIN', status: 'SETTLED' }],
    ['YES resolves NO: −$61', { side: 'YES', resolution: 'NO' }, [['BUY', '100', '0.61', '0']], { profit_loss: '-61', gross_payout: '0', result: 'LOSS' }],
    ['NO resolves NO: 100 @ $0.39 → profit $61', { side: 'NO', resolution: 'NO' }, [['BUY', '100', '0.39', '0']], { profit_loss: '61', result: 'WIN' }],
    ['NO resolves YES: −$39', { side: 'NO', resolution: 'YES' }, [['BUY', '100', '0.39', '0']], { profit_loss: '-39', result: 'LOSS' }],
    ['fees reduce the profit', { side: 'YES', resolution: 'YES' }, [['BUY', '100', '0.61', '1.25']], { profit_loss: '37.75', fees: '1.25' }],
    ['multiple buys average the entry', { side: 'YES' }, [['BUY', '100', '0.40', '0'], ['BUY', '50', '0.70', '0']], { average_entry_price: '0.5', cost_basis: '75', contracts: '150', status: 'OPEN', open_cost_basis: '75' }],
    ['a partial sell realizes P&L, the rest stays open', { side: 'YES', current_price: '0.66' }, [['BUY', '100', '0.40', '0'], ['BUY', '50', '0.70', '0'], ['SELL', '60', '0.65', '0.1']],
      { contracts: '90', open_cost_basis: '45', realized_profit_loss: '8.9', current_value: '59.4', unrealized_profit_loss: '14.4', status: 'OPEN', profit_loss: null }],
    ['a full sell closes the position', { side: 'YES' }, [['BUY', '100', '0.61', '0'], ['SELL', '100', '0.70', '0']], { status: 'SETTLED', profit_loss: '9', gross_payout: '70', contracts: '0' }],
    ['multiple fills, a partial sell and the resolution', { side: 'YES', resolution: 'YES' }, [['BUY', '30', '0.52', '0.02'], ['BUY', '70', '0.58', '0.04'], ['SELL', '25', '0.75', '0.01']],
      { profit_loss: '37.48', gross_payout: '93.75', contracts: '75', cost_basis: '56.2', fees: '0.07' }],
    ['a void refunds the held contracts at cost', { side: 'YES', resolution: 'VOID' }, [['BUY', '100', '0.61', '0']], { status: 'VOID', profit_loss: '0', result: 'VOID' }],
    ['a scalar settlement price', { side: 'YES', resolution: 'YES', settlement_price: '0.37' }, [['BUY', '100', '0.25', '0']], { profit_loss: '12', gross_payout: '37' }],
    ['an outcome-named market (Polymarket style)', { side: 'Chiefs', resolution: 'Chiefs' }, [['BUY', '12.5', '0.444', '0']], { profit_loss: '6.95', cost_basis: '5.55' }],
    ['sub-cent precision: 3 @ $0.333333', { side: 'YES' }, [['BUY', '3', '0.333333', '0']], { cost_basis: '0.999999', average_entry_price: '0.333333' }]
  ];
  PM.forEach(([label, pos, fills, want], i) => {
    const p = Object.assign({ platform: 'kalshi', platform_label: 'Kalshi', event_name: 'PM case ' + i, market_name: 'Will it happen?' }, pos,
      { fills: fills.map((f, j) => ({ action: f[0], quantity: f[1], price: f[2], fee: f[3], executed_at: at(i * 10 + j) })) });
    const id = prediction(A, p);
    const got = derivedOf(A, id);
    const bad = Object.keys(want).filter((k) => (want[k] == null ? got[k] !== null : (k === 'result' || k === 'status' ? got[k] !== want[k] : got[k] == null || E.dec.cmp(got[k], want[k]) !== 0)));
    chk('prediction market: ' + label, bad.length === 0, { want, got });
    sameDerived('parity: ' + label, got, E.derive(Object.assign({ platform_type: 'PREDICTION_MARKET' }, pos),
      fills.map((f) => ({ transaction_type: f[0], quantity: f[1], price: f[2], fee: f[3] }))));
  });
  /* the fills are the position: a later sell rebuilds it */
  const live = prediction(A, { platform: 'kalshi', platform_label: 'Kalshi', event_name: 'Live trade', market_name: 'Live', side: 'YES',
    fills: [{ action: 'BUY', quantity: '100', price: '0.61', executed_at: at(500) }] });
  db.as(A, `insert into public.portfolio_transactions (position_id, transaction_type, quantity, price, fee, executed_at)
            values (${L(live)}, 'SELL', 100, 0.70, 0, ${L(at(501))});`);
  r = json(db.as(A, `select json_build_object('s', status, 'pl', profit_loss::text, 'at', settled_at) from public.portfolio_positions where id = ${L(live)};`));
  chk('adding a sell that empties the position settles it at the sell time', r.s === 'SETTLED' && r.pl === '9' && Date.parse(r.at) === Date.parse(at(501)), r);
  db.as(A, `delete from public.portfolio_transactions where position_id = ${L(live)} and transaction_type = 'SELL';`);
  r = json(db.as(A, `select json_build_object('s', status, 'pl', profit_loss) from public.portfolio_positions where id = ${L(live)};`));
  chk('deleting that sell re-opens it', r.s === 'OPEN' && r.pl === null, r);
  db.as(A, `update public.portfolio_positions set contracts = 5000, cost_basis = 1 where id = ${L(live)};`);
  r = json(db.as(A, `select json_build_object('c', contracts::text, 'cb', cost_basis::text) from public.portfolio_positions where id = ${L(live)};`));
  chk('a contract position\'s totals cannot be typed in: they come from its fills', r.c === '100' && r.cb === '61', r);
  chk('a prediction-market position with no buy is refused at commit',
    db.mustFail(() => db.as(A, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, side)
      values ('kalshi', 'Kalshi', 'PREDICTION_MARKET', 'EVENT_CONTRACT', 'Empty', 'Empty', 'YES', 'YES');`)) !== null);
  chk('selling more than was bought is refused',
    db.mustFail(() => db.as(A, `insert into public.portfolio_transactions (position_id, transaction_type, quantity, price, executed_at)
      values (${L(live)}, 'SELL', 101, 0.5, ${L(at(502))});`)) !== null);
  chk('deleting the only buy is refused (delete the position instead)',
    db.mustFail(() => db.as(A, `delete from public.portfolio_transactions where position_id = ${L(live)};`)) !== null);
  chk('a buy cannot be attached to a sportsbook bet',
    db.mustFail(() => db.as(A, `insert into public.portfolio_transactions (position_id, transaction_type, quantity, price) values (${L(editId)}, 'BUY', 1, 0.5);`)) !== null);
  chk('a price above $1 is refused',
    db.mustFail(() => db.as(A, `insert into public.portfolio_transactions (position_id, transaction_type, quantity, price) values (${L(live)}, 'BUY', 1, 1.5);`)) !== null);

  /* ═══ PARITY, SEEDED RANDOM ═══════════════════════════════════════════ */
  let seed = 20261004;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cents = (lo, hi) => (Math.floor(lo * 100 + rnd() * (hi - lo) * 100) / 100).toFixed(2);
  const sbCases = [];
  for (let i = 0; i < 160; i++) {
    const status = pick(E.WAGER_STATUSES);
    const c = { stake: cents(0.01, 5000), status, fees: rnd() < 0.2 ? cents(0, 5) : undefined };
    if (rnd() < 0.75) { const a = 100 + Math.floor(rnd() * 2000); c.odds_american = String(rnd() < 0.5 ? -a : a); }
    else c.odds_decimal = (1.01 + rnd() * 15).toFixed(pick([2, 3, 4]));
    if (status === 'CASHED_OUT' || status === 'SETTLED' || rnd() < 0.1) c.reported_payout = cents(0, 8000);
    if (status === 'OPEN') delete c.reported_payout;
    if (rnd() < 0.25) c.stake_type = 'BONUS';                /* a bonus bet: no capital, winnings only */
    sbCases.push(c);
  }
  const sbIds = sbCases.map((c) => wager(A, c));
  const sbRows = json(db.as(A, `select json_object_agg(id, ${DERIVED_SQL}) from public.portfolio_positions where id in (${sbIds.map(L).join(', ')});`));
  let sbBad = [];
  sbCases.forEach((c, i) => {
    const a = canon(sbRows[sbIds[i]]), b = canon(E.derive(Object.assign({ platform_type: 'SPORTSBOOK' }, c)));
    COLS.forEach((k) => { if (a[k] !== b[k]) sbBad.push({ i, k, sql: a[k], js: b[k], c }); });
  });
  chk('parity: 160 random wagers, a quarter of them bonus bets — the database and the browser agree on every derived figure', sbBad.length === 0, sbBad.slice(0, 3));
  chk('…and the random set really holds bonus bets, won and lost', sbCases.filter((c) => c.stake_type === 'BONUS' && c.status === 'WON').length > 0
    && sbCases.filter((c) => c.stake_type === 'BONUS' && c.status === 'LOST').length > 0);
  const pmCases = [];
  for (let i = 0; i < 120; i++) {
    const fills = [], n = 1 + Math.floor(rnd() * 5);
    let held = 0;
    for (let j = 0; j < n; j++) {
      const sell = held > 0 && rnd() < 0.35;
      const q = sell ? Math.max(1, Math.floor(rnd() * held)) : 1 + Math.floor(rnd() * 400);
      held += sell ? -q : q;
      fills.push({ action: sell ? 'SELL' : 'BUY', quantity: String(rnd() < 0.2 ? q + 0.5 : q), price: (0.01 + rnd() * 0.98).toFixed(pick([2, 3, 4])),
        fee: rnd() < 0.5 ? (rnd() * 2).toFixed(pick([2, 4])) : '0', executed_at: at(-3000 + i * 10 + j) });
      if (sell && fills[j].quantity.indexOf('.') >= 0) fills[j].quantity = String(q);
      if (!sell && fills[j].quantity.indexOf('.') >= 0) held += 0.5;
    }
    const pos = { platform: 'polymarket', platform_label: 'Polymarket', event_name: 'Random ' + i, market_name: 'Random market', side: pick(['YES', 'NO', 'Chiefs']),
      resolution: pick([null, null, 'YES', 'NO', 'Chiefs', 'VOID']), current_price: rnd() < 0.5 ? (rnd()).toFixed(2) : null,
      settlement_price: rnd() < 0.1 ? (rnd()).toFixed(3) : null };
    pmCases.push({ pos, fills });
  }
  const pmIds = pmCases.map((c) => prediction(A, Object.assign({}, c.pos, { fills: c.fills })));
  const pmRows = json(db.as(A, `select json_object_agg(id, ${DERIVED_SQL}) from public.portfolio_positions where id in (${pmIds.map(L).join(', ')});`));
  let pmBad = [];
  pmCases.forEach((c, i) => {
    const a = canon(pmRows[pmIds[i]]), b = canon(E.derive(Object.assign({ platform_type: 'PREDICTION_MARKET' }, c.pos),
      c.fills.map((f) => ({ transaction_type: f.action, quantity: f.quantity, price: f.price, fee: f.fee }))));
    COLS.forEach((k) => { if (a[k] !== b[k]) pmBad.push({ i, k, sql: a[k], js: b[k] }); });
  });
  chk('parity: 120 random prediction-market positions (fills, partial sells, fees, resolutions) agree', pmBad.length === 0, pmBad.slice(0, 3));
  /* the division itself, at the edges */
  const divCases = [['-5', '2', 0], ['5', '-2', 0], ['1', '3', 6], ['2', '3', 6], ['-2', '3', 6], ['0.005', '1', 2], ['-0.005', '1', 2], ['123456789.123456', '7', 6], ['10', '100', 0]];
  const divSql = json(db.sql(`select json_agg(public.portfolio_div_round(x.n::numeric, x.d::numeric, x.s)::text order by x.i) from (values ${divCases.map((c, i) => `(${i}, ${L(c[0])}, ${L(c[1])}, ${c[2]})`).join(', ')}) as x(i, n, d, s);`));
  chk('divRound: SQL and JS round identically at every edge', JSON.stringify(divSql) === JSON.stringify(divCases.map((c) => E.dec.divRound(c[0], c[1], c[2]))), { divSql });

  /* ═══ FINGERPRINTS ════════════════════════════════════════════════════ */
  const corpus = ['Chiefs vs. Bills', 'Chiefs @ Bills', 'chiefs at bills', 'CHIEFS  v  BILLS', 'Chiefs@Bills', "Ja'Marr Chase o/u 85.5", 'Mbappé — to score',
    'Over\t47.5', '  São Paulo FC ', 'Under 5.5 Receptions (Stefon Diggs)', 'Team “A” vs Team ‘B’', '🏈 Kickoff', 'Kelvin K', 'v. Navy', 'A at B at C', '+150 / -110'];
  const normSql = json(db.sql(`select json_agg(public.portfolio_norm_text(x.t) order by x.i) from (values ${corpus.map((t, i) => `(${i}, ${L(t)})`).join(', ')}) as x(i, t);`));
  chk('the text rule is identical in SQL and JS over the whole corpus', JSON.stringify(normSql) === JSON.stringify(corpus.map(E.normText)),
    corpus.map((t, i) => [t, normSql[i], E.normText(t)]).filter((x) => x[1] !== x[2]));
  chk('"Chiefs vs. Bills", "Chiefs @ Bills" and "chiefs at bills" are one event', new Set(corpus.slice(0, 5).map(E.normText)).size === 1);
  const fw = { platform: 'draftkings', event_name: 'Chiefs vs. Bills', market_name: 'Spread', selection: 'Chiefs -2.5', line: '-2.50', odds_american: '-110', stake: '100.00', placed_at: '2026-09-07T13:00:59-04:00' };
  const fwSql = one(db.sql(`select public.portfolio_fp_wager_material('draftkings', 'Chiefs vs. Bills', 'Spread', 'Chiefs -2.5', -2.50, -110, null, 100.00, '2026-09-07T13:00:59-04:00');`));
  chk('the wager fingerprint material matches byte for byte', fwSql === E.wagerMaterial(fw), { sql: fwSql, js: E.wagerMaterial(fw) });
  const ffSql = one(db.sql(`select public.portfolio_fp_fill_material('kalshi', 'Will X?', 'Will X?', 'YES', 'BUY', 100.0, 0.610, '2026-09-01T12:00:30Z');`));
  chk('the fill fingerprint material matches byte for byte', ffSql === E.fillMaterial({ platform: 'kalshi', event_name: 'Will X?', market_name: 'Will X?', side: 'YES', action: 'BUY', quantity: '100.0', price: '0.610', executed_at: '2026-09-01T12:00:30Z' }), ffSql);
  const tokCases = [['Chiefs', '-2.5'], ['Chiefs -2.5', null], ['Chiefs -2.5', '-2.5'], ['Chiefs +2.5', '2.5'], ['Chiefs', '2.5'], ['Over', '47.5'],
    ['Over 47.5', null], ['Over +47.5', '47.50'], ['', '-3'], ['Yankees', null], ['Chiefs -12.5', '-2.5']];
  const tokSql = json(db.sql(`select json_agg(public.portfolio_selection_token(x.s, x.l::numeric) order by x.i) from (values ${tokCases.map((t, i) => `(${i}, ${L(t[0])}, ${t[1] == null ? 'null' : L(t[1])})`).join(', ')}) as x(i, s, l);`));
  chk('the selection+line token is identical in SQL and JS', JSON.stringify(tokSql) === JSON.stringify(tokCases.map((t) => E.selectionToken(t[0], t[1]))), tokSql);
  chk('"Chiefs" at -2.5 and "Chiefs -2.5" are one pick; "Over" 47.5 and "Over +47.5" are one pick', tokSql[0] === tokSql[1] && tokSql[1] === tokSql[2]
    && tokSql[3] === tokSql[4] && tokSql[5] === tokSql[6] && tokSql[6] === tokSql[7]);
  const hashSql = one(db.sql(`select public.portfolio_sha256(${L(fwSql)});`));
  chk('and its hash is plain SHA-256 of that material', hashSql === crypto.createHash('sha256').update(fwSql, 'utf8').digest('hex'));

  /* ═══ DUPLICATES ══════════════════════════════════════════════════════ */
  const dupInput = { stake: '25', odds_american: '-110', status: 'OPEN', selection: 'Dup -3', placed_at: '2026-09-07T13:00:00-04:00' };
  const dupId = wager(A, dupInput);
  let err = db.mustFail(() => wager(A, Object.assign({}, dupInput, { placed_at: '2026-09-07T17:00:00Z' })));
  chk('the same bet entered twice (same instant, another time zone) is refused', err !== null && /duplicate key|portfolio_positions_fingerprint_once/.test(err), err && err.slice(0, 200));
  chk('…and so is the same bet with the event written differently', db.mustFail(() => wager(A, Object.assign({}, dupInput, { event_name: 'chiefs at bills' }))) !== null);
  chk('a second, genuinely separate identical bet is accepted when the reader says so', db.mustFail(() => wager(A, Object.assign({}, dupInput, { dedupe_occurrence: '2' }))) === null);
  chk('another reader recording the same bet is not a duplicate of A\'s', db.mustFail(() => wager(B, dupInput)) === null);
  db.service(`insert into public.platform_accounts (id, user_id, platform, platform_label, platform_type, connection_type, status, external_account_id)
              values ('11111111-1111-1111-1111-111111111111', ${L(A)}, 'draftkings', 'DraftKings', 'SPORTSBOOK', 'API', 'CONNECTED', 'acct-1');`);
  db.service(wagerSql({ user_id: A, stake: '40', odds_american: '120', source: 'SYNC', external_position_id: 'DK-777', platform_account_id: '11111111-1111-1111-1111-111111111111', selection: 'Synced pick' }));
  chk('the same platform bet id is stored once', db.mustFail(() => db.service(wagerSql({ user_id: A, stake: '41', odds_american: '120', source: 'SYNC', external_position_id: 'DK-777',
    platform_account_id: '11111111-1111-1111-1111-111111111111', selection: 'Synced pick again' }))) !== null);

  /* ═══ ROW LEVEL SECURITY ══════════════════════════════════════════════ */
  const countAs = (uid, t) => db.as(uid, `select count(*) from ${t};`);
  ['public.portfolio_positions', 'public.portfolio_transactions', 'public.platform_accounts', 'public.portfolio_account_summary'].forEach((t) => {
    chk('reader B sees none of A\'s rows in ' + t, +countAs(B, t + ` where user_id = ${L(A)}`) === 0 && +db.sql(`select count(*) from ${t} where user_id = ${L(A)}`) > 0);
  });
  chk('reader B cannot update A\'s position', (db.as(B, `update public.portfolio_positions set stake = 1 where id = ${L(dupId)};`), db.sql(`select stake::text from public.portfolio_positions where id = ${L(dupId)};`)) === '25');
  chk('reader B cannot delete A\'s position', (db.as(B, `delete from public.portfolio_positions where id = ${L(dupId)};`), db.sql(`select count(*) from public.portfolio_positions where id = ${L(dupId)};`)) === '1');
  err = db.mustFail(() => db.as(B, `insert into public.portfolio_transactions (position_id, transaction_type, quantity, price) values (${L(live)}, 'BUY', 1, 0.5);`));
  chk('reader B cannot attach a fill to A\'s position', err !== null, err);
  chk('…even as the service role writes nothing for them', db.sql(`select count(*) from public.portfolio_transactions where user_id = ${L(B)};`) === '0');
  const acctA = db.sql(`select id from public.platform_accounts where user_id = ${L(A)} and connection_type = 'MANUAL' limit 1;`);
  chk('reader B cannot file a position under A\'s account', db.mustFail(() => wager(B, { stake: '5', odds_american: '-110', platform_account_id: acctA })) !== null);
  const stolen = wager(B, { stake: '7', odds_american: '-110', user_id: A, selection: 'owner probe' });
  chk('a position is the caller\'s, whatever user id the payload names', db.sql(`select user_id from public.portfolio_positions where id = ${L(stolen)};`) === B);
  db.as(B, `update public.portfolio_positions set user_id = ${L(A)} where id = ${L(stolen)};`);
  chk('and ownership cannot be edited afterwards', db.sql(`select user_id from public.portfolio_positions where id = ${L(stolen)};`) === B);
  chk('anon can read no position', db.mustFail(() => db.anon('select count(*) from public.portfolio_positions;')) !== null);
  chk('anon can read no account', db.mustFail(() => db.anon('select count(*) from public.platform_accounts;')) !== null);
  chk('anon cannot call the import entry points', db.mustFail(() => db.anon(`select public.portfolio_import_commit('00000000-0000-0000-0000-000000000000');`)) !== null);
  chk('a reader cannot reach the credentials table', db.mustFail(() => db.as(A, 'select count(*) from portfolio_private.platform_credentials;')) !== null);
  chk('the service role can', db.mustFail(() => db.service('select count(*) from portfolio_private.platform_credentials;')) === null);
  chk('a reader cannot create a "connected" API account', db.mustFail(() => db.as(A, `insert into public.platform_accounts (platform, platform_label, platform_type, connection_type, status)
    values ('kalshi', 'Kalshi', 'PREDICTION_MARKET', 'API', 'CONNECTED');`)) !== null);
  chk('a manual account can never read "connected", even for the service role', db.mustFail(() => db.service(`update public.platform_accounts set status = 'CONNECTED' where id = ${L(acctA)};`)) !== null);
  chk('a reader cannot change an account\'s status or cursor', db.mustFail(() => db.as(A, `update public.platform_accounts set status = 'DISCONNECTED' where id = ${L(acctA)};`)) !== null
    && db.mustFail(() => db.as(A, `update public.platform_accounts set sync_cursor = 'x' where id = ${L(acctA)};`)) !== null);
  chk('but may rename it', db.mustFail(() => db.as(A, `update public.platform_accounts set display_name = 'Main' where id = ${L(acctA)};`)) === null);
  chk('a reader cannot record a synced position', db.mustFail(() => wager(A, { stake: '5', odds_american: '-110', source: 'SYNC' })) !== null);
  const syncedId = db.sql(`select id from public.portfolio_positions where external_position_id = 'DK-777';`);
  chk('a synced position is read-only to its reader', db.mustFail(() => db.as(A, `update public.portfolio_positions set stake = 1 where id = ${L(syncedId)};`)) !== null);
  chk('except its notes', db.mustFail(() => db.as(A, `update public.portfolio_positions set notes = 'note' where id = ${L(syncedId)};`)) === null);
  chk('…never the record\'s identity: its legs, event id or duplicate number',
    ['event_id = \'x\'', 'dedupe_occurrence = 9', 'legs = \'[]\''].every((set) => db.mustFail(() => db.as(A, `update public.portfolio_positions set ${set} where id = ${L(syncedId)};`)) !== null));
  chk('…nor a label the platform supplied', db.mustFail(() => db.as(A, `update public.portfolio_positions set sport = 'NBA' where id = ${L(syncedId)};`)) !== null);
  chk('…but it may fill in one the platform left blank, once',
    db.mustFail(() => db.as(A, `update public.portfolio_positions set league = 'NFL', event_start_at = '2026-08-02T17:00:00Z' where id = ${L(syncedId)};`)) === null
    && db.mustFail(() => db.as(A, `update public.portfolio_positions set event_start_at = '2026-08-03T17:00:00Z' where id = ${L(syncedId)};`)) !== null);
  db.as(A, `delete from public.portfolio_positions where id = ${L(syncedId)};`);
  chk('and a reader cannot delete it', db.sql(`select count(*) from public.portfolio_positions where id = ${L(syncedId)};`) === '1');
  chk('a reader cannot write a connector\'s sync log', db.mustFail(() => db.as(A, `insert into public.portfolio_sync_logs (platform, sync_kind, status) values ('kalshi', 'API_SYNC', 'SUCCESS');`)) !== null);
  chk('or edit their own log', db.mustFail(() => db.as(A, `update public.portfolio_sync_logs set status = 'SUCCESS';`)) !== null);
  chk('a position naming an account on another platform is refused', db.mustFail(() => wager(A, { stake: '5', odds_american: '-110', platform: 'fanduel', platform_label: 'FanDuel', platform_account_id: acctA })) !== null);
  chk('the operator view refuses a reader', db.mustFail(() => db.as(A, 'select * from public.portfolio_admin_sync_health(7);')) !== null);

  /* ═══ ATTRIBUTION ═════════════════════════════════════════════════════ */
  db.sql(`create table if not exists public.stake_recommendations (id bigint generated always as identity, recommendation_id text unique, user_id uuid);
          alter table public.stake_recommendations enable row level security;
          create policy sr_own on public.stake_recommendations for select to authenticated using (user_id = auth.uid());
          grant select on public.stake_recommendations to authenticated;
          insert into public.stake_recommendations (recommendation_id, user_id) values ('rec-a', ${L(A)}), ('rec-b', ${L(B)});`);
  chk('a position links to the reader\'s own EdgeDesk recommendation', db.mustFail(() => wager(A, { stake: '5', odds_american: '-110', edge_source: 'EDGEDESK', edge_ref_type: 'stake_recommendation', edge_ref_id: 'rec-a' })) === null);
  chk('never to another reader\'s', db.mustFail(() => wager(A, { stake: '5', odds_american: '-110', edge_source: 'EDGEDESK', edge_ref_type: 'stake_recommendation', edge_ref_id: 'rec-b' })) !== null);
  chk('never to one that does not exist', db.mustFail(() => wager(A, { stake: '5', odds_american: '-110', edge_source: 'EDGEDESK', edge_ref_type: 'stake_recommendation', edge_ref_id: 'rec-zzz' })) !== null);
  chk('and a link is only an EdgeDesk link', db.mustFail(() => wager(A, { stake: '5', odds_american: '-110', edge_source: 'SELF', edge_ref_type: 'stake_recommendation', edge_ref_id: 'rec-a' })) !== null);
  chk('"EdgeDesk research" without a record is allowed and stays unlinked', db.mustFail(() => wager(A, { stake: '6', odds_american: '-110', edge_source: 'EDGEDESK' })) === null);

  /* ═══ THE IMPORT PIPELINE ═════════════════════════════════════════════ */
  function stageImport(uid, staged, extra) {
    const imp = one(db.as(uid, `insert into public.portfolio_imports (platform_type, importer, file_name, timezone)
      values (${L(staged.platformType)}, ${L(staged.adapter)}, 'test.csv', ${L(staged.timezone)}) returning id;`));
    const values = staged.rows.map((r) => `(${L(imp)}, ${r.row_number}, ${L(JSON.stringify(r.raw))}::jsonb, ${L(JSON.stringify(r.normalized))}::jsonb, ${L(JSON.stringify(r.issues))}::jsonb)`);
    db.as(uid, `insert into public.portfolio_import_rows (import_id, row_number, raw, normalized, issues) values ${values.join(',\n')};`);
    if (extra) db.as(uid, extra.replace(/\$IMP/g, L(imp)));
    return imp;
  }
  const csv = [
    'Date Placed,Sportsbook,Sport,Event,Market,Selection,Odds,Stake,Result,Payout,Bet ID',
    '2026-09-07 13:00,DraftKings,NFL,Chiefs vs Bills,Spread,Dup -3,-110,25,,,',            /* the manual entry above */
    '2026-09-08 20:15,FanDuel,NFL,Jets @ Giants,Moneyline,Jets,+150,100,Lost,,FD-2',
    '2026-09-08 20:15,FanDuel,NFL,Jets @ Giants,Moneyline,Jets,+150,100,Lost,,FD-2',       /* the same row twice */
    '2026-09-09 19:00,Caesars,NBA,Lakers vs Celtics,Total,Over 220.5,1.91,50,Won,99.00,',   /* payout disagrees with odds */
    '2026-09-10 12:00,BetMGM,MLB,Yankees @ Red Sox,Moneyline,Yankees,-130,"12,50",Won,,',   /* decimal comma */
    '2026-09-11 12:00,BetMGM,MLB,Mets @ Braves,Run line,Mets +1.5,-150,30,Cashed out,,',   /* cash-out, no amount: the server refuses */
    '2026-09-12 12:00,BetRivers,NHL,Rangers @ Devils,Moneyline,Rangers,+105,20,Won,,BR-9'
  ].join('\n');
  const st1 = I.stage(csv, { timezone: 'America/New_York' });
  /* the cash-out row would be INVALID in the browser too; drop the browser's
     own error so the SERVER's refusal is what gets tested */
  st1.rows[5].issues = st1.rows[5].issues.filter((x) => x.code !== 'PAYOUT_NEEDED');
  const imp1 = stageImport(A, st1);
  let c = json(db.as(A, `select public.portfolio_import_classify(${L(imp1)});`));
  chk('classify counts: 7 detected, 3 new, 2 duplicates, 1 needs review, 1 invalid',
    c.total === 7 && c.new === 3 && c.duplicate === 2 && c.review === 1 && c.invalid === 1, c);
  const cls = json(db.as(A, `select json_agg(classification order by row_number) from public.portfolio_import_rows where import_id = ${L(imp1)};`));
  chk('each row is classified for the right reason', JSON.stringify(cls) === JSON.stringify(['DUPLICATE', 'NEW', 'DUPLICATE_IN_FILE', 'NEEDS_REVIEW', 'INVALID', 'NEW', 'NEW']), cls);
  chk('the duplicate names the position it duplicates', db.as(A, `select duplicate_of from public.portfolio_import_rows where import_id = ${L(imp1)} and row_number = 1;`) === dupId);
  const before = +db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`);
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp1)});`));
  const after = +db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`);
  chk('commit imports only the new rows; the review row waits for a decision', c.imported === 2 && c.failed === 1 && after - before === 2, c);
  chk('the row the database refused is recorded as FAILED with the reason', /payout|constraint|check/i.test(db.as(A, `select outcome || ': ' || outcome_message from public.portfolio_import_rows where import_id = ${L(imp1)} and row_number = 6;`)));
  chk('imported positions carry their source and the import', db.sql(`select count(*) from public.portfolio_positions where import_id = ${L(imp1)} and source = 'CSV';`) === '2');
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp1)});`));
  chk('committing again imports nothing twice', c.imported === 2 && +db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`) === after, c);
  chk('a committed import\'s rows can no longer be changed', db.mustFail(() => db.as(A, `update public.portfolio_import_rows set decision = 'IMPORT' where import_id = ${L(imp1)};`)) !== null);
  const log = json(db.as(A, `select row_to_json(l) from public.portfolio_sync_logs l where import_id = ${L(imp1)};`));
  chk('the import wrote one sync log with its counts', log && log.sync_kind === 'CSV_IMPORT' && log.status === 'PARTIAL' && log.records_fetched === 7
    && log.records_inserted === 2 && log.duplicates_ignored === 2 && log.errors_count === 1 && log.duration_ms >= 0, log);
  const ny = json(db.sql(`select json_build_object('at', placed_at) from public.portfolio_positions where external_position_id = 'FD-2';`));
  chk('a naive time is read in the reader\'s zone (20:15 New York = 00:15 UTC)', Date.parse(ny.at) === Date.parse('2026-09-09T00:15:00Z'), ny);

  /* the same file again, with the review row approved and a duplicate forced */
  const st2 = I.stage(csv, { timezone: 'America/New_York' });
  const imp2 = stageImport(A, st2);
  db.as(A, `select public.portfolio_import_classify(${L(imp2)});`);
  db.as(A, `update public.portfolio_import_rows set decision = 'IMPORT' where import_id = ${L(imp2)} and row_number in (1, 4);`);
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp2)});`));
  chk('re-importing the file: everything already recorded is a duplicate; only approved rows go in', c.duplicate === 4 && c.review === 1 && c.invalid === 2 && c.imported === 2, c);
  chk('a forced duplicate becomes a second occurrence, never a silent merge',
    /* occurrence 2 was the hand-entered "separate identical bet" above */
    db.sql(`select max(dedupe_occurrence) from public.portfolio_positions where fingerprint = (select fingerprint from public.portfolio_positions where id = ${L(dupId)});`) === '3');
  chk('the approved review row kept the book\'s payout', db.sql(`select profit_loss::text from public.portfolio_positions where import_id = ${L(imp2)} and odds_decimal = 1.91;`) === '49');

  /* prediction-market fills: one position per market and side */
  const pmCsv = [
    'Date,Platform,Question,Side,Action,Contracts,Price,Fee,Resolution,Trade ID',
    '2026-09-01T12:00:00Z,Kalshi,Will the Chiefs win?,Yes,Buy,100,61,0.07,,T1',
    '2026-09-02T12:00:00Z,Kalshi,Will the Chiefs win?,Yes,Sell,40,70,0.03,,T2',
    '2026-09-03T12:00:00Z,Kalshi,Will the Chiefs win?,Yes,Buy,10,55,0,YES,T3',
    '2026-09-03T13:00:00Z,Kalshi,Will it rain?,No,Buy,20,30,0,,T4'
  ].join('\n');
  const pst = I.stage(pmCsv, {});
  const imp3 = stageImport(A, pst);
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp3)});`));
  chk('four fills import as two positions', c.imported === 4 && db.sql(`select count(*) from public.portfolio_positions where import_id = ${L(imp3)};`) === '2', c);
  const chiefs = json(db.sql(`select json_build_object('pl', profit_loss::text, 'c', contracts::text, 'avg', average_entry_price::text, 's', status, 'f', fees::text, 'n', (select count(*) from public.portfolio_transactions t where t.position_id = p.id))
    from public.portfolio_positions p where import_id = ${L(imp3)} and event_name = 'Will the Chiefs win?';`));
  chk('the Chiefs market: 3 fills, resolved YES, P&L 70 contracts × $1 + $28 − $66.50 − $0.10 = $31.40',
    chiefs.n === 3 && chiefs.s === 'SETTLED' && chiefs.c === '70' && chiefs.pl === '31.4' && chiefs.avg === '0.604545' && chiefs.f === '0.1', chiefs);
  const imp4 = stageImport(A, I.stage(pmCsv, {}));
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp4)});`));
  chk('the same trades again are all duplicates', c.duplicate === 4 && c.imported === 0, c);
  const pmMore = pmCsv + '\n2026-09-04T13:00:00Z,Kalshi,Will it rain?,No,Buy,5,35,0,,T5';
  const imp5 = stageImport(A, I.stage(pmMore, {}));
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp5)});`));
  chk('a newer export adds only the new trade, to the position it belongs to', c.imported === 1
    && db.sql(`select contracts::text from public.portfolio_positions where event_name = 'Will it rain?' and user_id = ${L(A)};`) === '25', c);
  const bad = 'Date,Platform,Question,Side,Action,Contracts,Price\n2026-09-05T12:00:00Z,Kalshi,Oversold,Yes,Buy,10,0.5\n2026-09-05T13:00:00Z,Kalshi,Oversold,Yes,Sell,20,0.6\n2026-09-05T12:00:00Z,Kalshi,Fine,Yes,Buy,10,0.5';
  const imp6 = stageImport(A, I.stage(bad, {}));
  c = json(db.as(A, `select public.portfolio_import_commit(${L(imp6)});`));
  chk('a market that sells more than it bought fails alone; the rest imports', c.failed === 2 && c.imported === 1
    && db.sql(`select count(*) from public.portfolio_positions where event_name = 'Oversold';`) === '0', c);

  /* ═══ INCREMENTAL SPORTSBOOK IMPORT: updates, bonus bets, parlays, remembered layout ═══ */
  const hist1 = ['Bet ID,Placed,Event,Selection,Odds,Stake,Status,Payout,Free Bet',
    'MG-1,2026-09-14 13:00,Chiefs @ Bills,Chiefs ML,+150,40,Open,,',
    'MG-2,2026-09-14 14:00,Bucs @ Saints,Saints ML,+200,25,Won,50,Yes',
    'MG-3,2026-09-15 13:00,Colts @ Titans,Colts ML,+130,10,Won,23,',
    'MG-3,2026-09-15 13:00,Lakers @ Celtics,Lakers +4.5,,,,,'].join('\n');
  const s1 = I.stage(hist1, { platform: 'betmgm', timezone: 'UTC' });
  const impU1 = stageImport(A, s1, `update public.portfolio_imports set header_signature = ${L(s1.signature)}, platform = 'betmgm' where id = $IMP;`);
  c = json(db.as(A, `select public.portfolio_import_commit(${L(impU1)});`));
  chk('the first export: an open bet, a bonus bet and a two-leg parlay go in', c.imported === 3 && c.updated === 0, c);
  chk('the bonus bet is stored as BONUS and its P&L is its winnings (+$50 on a $25 free bet)',
    db.sql(`select stake_type || ':' || profit_loss::text || ':' || cost_basis::text from public.portfolio_positions where external_position_id = 'MG-2';`) === 'BONUS:50:0');
  chk('the parlay is one position with its legs', db.sql(`select position_type || ':' || jsonb_array_length(legs) || ':' || selection from public.portfolio_positions where external_position_id = 'MG-3';`)
    === 'PARLAY:2:Colts ML + Lakers +4.5');
  const hist2 = hist1.replace('MG-1,2026-09-14 13:00,Chiefs @ Bills,Chiefs ML,+150,40,Open,,', 'MG-1,2026-09-14 13:00,Chiefs @ Bills,Chiefs ML,+150,40,Won,100,')
    + '\nMG-4,2026-09-16 13:00,Rams @ 49ers,Over 44.5,-110,22,Lost,0,';
  const s2 = I.stage(hist2, { platform: 'betmgm', timezone: 'UTC' });
  const impU2 = stageImport(A, s2, `update public.portfolio_imports set header_signature = ${L(s2.signature)}, platform = 'betmgm' where id = $IMP;`);
  c = json(db.as(A, `select public.portfolio_import_classify(${L(impU2)});`));
  chk('the newer export: the open bet that settled is an UPDATE, not a duplicate; the rest are duplicates; the new bet is new',
    c.update === 1 && c.new === 1 && c.duplicate === 2, c);
  c = json(db.as(A, `select public.portfolio_import_commit(${L(impU2)});`));
  chk('commit updates the stored bet in place and adds the new one', c.updated === 1 && c.imported === 1
    && db.sql(`select status || ':' || profit_loss::text || ':' || count(*) over () from public.portfolio_positions where external_position_id = 'MG-1' and user_id = ${L(A)};`) === 'WON:60:1', c);
  chk('the import records how many it updated, and the log says so', db.sql(`select rows_updated from public.portfolio_imports where id = ${L(impU2)};`) === '1'
    && db.sql(`select records_updated from public.portfolio_sync_logs where import_id = ${L(impU2)};`) === '1');
  const impU3 = stageImport(A, I.stage(hist2, { platform: 'betmgm', timezone: 'UTC' }));
  c = json(db.as(A, `select public.portfolio_import_commit(${L(impU3)});`));
  chk('the same newer export again: nothing changes (no update without a change)', c.updated === 0 && c.imported === 0 && c.duplicate === 4, c);
  const remembered = json(one(db.as(A, `select row_to_json(x) from (select importer, platform, column_map from public.portfolio_imports
      where header_signature = ${L(s1.signature)} and status = 'COMMITTED' order by committed_at desc limit 1) x;`)));
  chk('the layout is remembered: the next file with the same columns is read the same way', remembered && remembered.platform === 'betmgm' && remembered.importer === 'generic_sportsbook_v1');
  chk('…and another reader never sees it', one(db.as(B, `select count(*) from public.portfolio_imports where header_signature = ${L(s1.signature)};`)) === '0');
  /* a file larger than one call: the page loops; nothing is lost or doubled between calls */
  const many = ['Date,Book,Event,Selection,Odds,Stake,Result'].concat(Array.from({ length: 9 }, (_, i) => `2026-08-0${i + 1} 12:00,Hard Rock Bet,Batch game ${i},Pick ${i},-110,10,Won`));
  many.push(many[1]);                                                  /* an in-file duplicate of the first */
  const impB = stageImport(A, I.stage(many.join('\n'), {}));
  const calls = [];
  let rb;
  do { rb = json(db.as(A, `select public.portfolio_import_commit(${L(impB)}, 4);`)); calls.push(rb.status + ':' + (rb.remaining || 0)); } while (rb.status !== 'COMMITTED' && calls.length < 10);
  chk('a commit limited to 4 rows a call finishes in 3 calls and imports the 9 new rows once', JSON.stringify(calls) === JSON.stringify(['IMPORTING:5', 'IMPORTING:1', 'COMMITTED:0'])
    && rb.imported === 9 && rb.skipped === 1 && db.sql(`select count(*) from public.portfolio_positions where import_id = ${L(impB)};`) === '9', { calls, rb });
  chk('…and its rows keep the classification they were shown (imported rows are not re-flagged as duplicates of themselves)',
    db.sql(`select string_agg(distinct classification, ',' order by classification) from public.portfolio_import_rows where import_id = ${L(impB)} and outcome = 'IMPORTED';`) === 'NEW');
  /* the same file classifies and lands the same whatever the batch size: a
     failed first copy never promotes its unticked twin, and a twin of a row an
     earlier batch imported stays an in-file duplicate */
  const twins = ['Date,Book,Event,Selection,Odds,Stake,Result',
    '2026-07-01 12:00,BetMGM,Twin game,Twin pick,-150,30,Cashed out',      /* NEW, refused by the database (no payout) */
    '2026-07-01 12:00,BetMGM,Twin game,Twin pick,-150,30,Cashed out',      /* its twin, not ticked */
    '2026-07-02 12:00,BetMGM,Other game,Other pick,-110,10,Won',
    '2026-07-03 12:00,BetMGM,Third game,Third pick,-110,10,Won',
    '2026-07-03 12:00,BetMGM,Third game,Third pick,-110,10,Won'].join('\n');  /* twin of a row that imports */
  const landed = (uid, max) => {
    const st = I.stage(twins, {});
    st.rows.forEach((r) => { r.issues = r.issues.filter((x) => x.code !== 'PAYOUT_NEEDED'); });
    const imp = stageImport(uid, st);
    let res, n = 0;
    do { res = json(db.as(uid, `select public.portfolio_import_commit(${L(imp)}, ${max});`)); n++; } while (res.status !== 'COMMITTED' && n < 10);
    return { calls: n, res, rows: json(db.as(uid, `select json_agg(classification || ':' || outcome order by row_number) from public.portfolio_import_rows where import_id = ${L(imp)};`)) };
  };
  const whole = landed(C1, 1000), oneByOne = landed(C2, 1);
  chk('one row a call lands exactly what one call lands, row for row',
    oneByOne.calls > 2 && JSON.stringify(oneByOne.rows) === JSON.stringify(whole.rows)
    && JSON.stringify(whole.rows) === JSON.stringify(['NEW:FAILED', 'DUPLICATE_IN_FILE:SKIPPED', 'NEW:IMPORTED', 'NEW:IMPORTED', 'DUPLICATE_IN_FILE:SKIPPED'])
    && ['imported', 'skipped', 'failed', 'duplicate', 'new'].every((k) => oneByOne.res[k] === whole.res[k]), { whole, oneByOne });

  /* a trade id the file reuses for a different market is called out, and
     never pulls that file's fills into the other market's position */
  const reuse = 'Date,Platform,Question,Side,Action,Contracts,Price,Trade ID\n2026-09-06T12:00:00Z,Kalshi,Will the Jets win?,Yes,Buy,10,40,T1\n2026-09-06T13:00:00Z,Kalshi,Will the Jets win?,Yes,Buy,5,42,J2';
  const impR = stageImport(A, I.stage(reuse, {}));
  c = json(db.as(A, `select public.portfolio_import_commit(${L(impR)});`));
  const jets = json(db.as(A, `select json_build_object('issues', (select issues from public.portfolio_import_rows where import_id = ${L(impR)} and row_number = 1),
    'market', (select p.event_name from public.portfolio_transactions t join public.portfolio_positions p on p.id = t.position_id where t.external_transaction_id = 'J2'),
    'chiefs', (select count(*) from public.portfolio_transactions t join public.portfolio_positions p on p.id = t.position_id where p.event_name = 'Will the Chiefs win?' and p.user_id = ${L(A)}));`));
  chk('a trade id already used by another market is flagged, and the new fills join their own market', c.imported === 1 && jets.market === 'Will the Jets win?'
    && jets.chiefs === 3 && JSON.stringify(jets.issues).includes('EXTERNAL_ID_IN_USE'), { c, jets });

  /* deleting an import unlinks what it created: no row may name an import that is gone */
  db.as(A, `delete from public.portfolio_imports where id = ${L(imp3)};`);
  chk('deleting an import keeps its positions and fills, unlinked — none names the deleted import',
    db.sql(`select (select count(*) from public.portfolio_positions p where p.import_id is not null and not exists (select 1 from public.portfolio_imports i where i.id = p.import_id))
      + (select count(*) from public.portfolio_transactions t where t.import_id is not null and not exists (select 1 from public.portfolio_imports i where i.id = t.import_id));`) === '0'
    && db.sql(`select count(*) from public.portfolio_positions where event_name = 'Will the Chiefs win?' and user_id = ${L(A)} and import_id is null;`) === '1');

  chk('reader B cannot classify or commit A\'s import', db.mustFail(() => db.as(B, `select public.portfolio_import_commit(${L(imp6)});`)) !== null);
  chk('reader B cannot stage rows into A\'s import', db.mustFail(() => db.as(B, `insert into public.portfolio_import_rows (import_id, row_number, raw) values (${L(imp6)}, 99, '{}');`)) !== null);
  chk('reader B sees none of A\'s imports, rows or logs', +countAs(B, 'public.portfolio_imports') === 0 && +countAs(B, 'public.portfolio_import_rows') === 0 && +countAs(B, 'public.portfolio_sync_logs') === 0);

  /* ═══ THE ACCOUNT SUMMARY ═════════════════════════════════════════════ */
  const sum = json(db.as(A, `select json_agg(json_build_object('p', platform, 'c', connection_type, 's', status, 'n', positions)) from public.portfolio_account_summary;`));
  chk('accounts were opened as positions arrived, labelled honestly (manual / CSV / connected)',
    sum.some((x) => x.p === 'draftkings' && x.c === 'MANUAL' && x.s === 'MANUAL') && sum.some((x) => x.p === 'fanduel' && x.c === 'CSV' && x.s === 'IMPORT_ONLY')
    /* one account per platform: Kalshi trades imported later join the Kalshi account the reader already had */
    && sum.filter((x) => x.p === 'kalshi').length === 1
    && db.sql(`select count(*) from public.portfolio_positions where platform = 'kalshi' and user_id = ${L(A)} and platform_account_id is null;`) === '0'
    && sum.some((x) => x.c === 'API' && x.s === 'CONNECTED') && !sum.some((x) => x.c !== 'API' && x.s === 'CONNECTED'), sum);
  const moveAcct = db.as(A, `select id from public.platform_accounts where platform = 'betrivers' and user_id = ${L(A)};`);
  db.as(A, `delete from public.platform_accounts where id = ${L(moveAcct)};`);
  chk('removing an account keeps its positions in the history', db.sql(`select count(*) from public.portfolio_positions where platform = 'betrivers' and user_id = ${L(A)} and platform_account_id is null;`) === '1');
  chk('and does not silently re-open the account', db.sql(`select count(*) from public.platform_accounts where platform = 'betrivers' and user_id = ${L(A)};`) === '0');
  const kalshiAcct = db.as(A, `select id from public.platform_accounts where platform = 'kalshi' and user_id = ${L(A)};`);
  db.as(A, `delete from public.platform_accounts where id = ${L(kalshiAcct)};`);
  db.service(`insert into public.platform_accounts (id, user_id, platform, platform_label, platform_type, connection_type, status, external_account_id)
              values ('22222222-2222-2222-2222-222222222222', ${L(A)}, 'fanduel', 'FanDuel', 'SPORTSBOOK', 'API', 'CONNECTED', 'acct-2');`);
  db.service(wagerSql({ user_id: A, platform: 'fanduel', platform_label: 'FanDuel', stake: '15', odds_american: '110', source: 'SYNC', external_position_id: 'FD-SYNC-1',
    platform_account_id: '22222222-2222-2222-2222-222222222222', selection: 'Synced FanDuel pick' }));
  chk('a reader may remove a connected account; its synced positions stay in the history, unlinked',
    db.mustFail(() => db.as(A, `delete from public.platform_accounts where id = '22222222-2222-2222-2222-222222222222';`)) === null
    && db.sql(`select count(*) from public.portfolio_positions where external_position_id = 'FD-SYNC-1' and platform_account_id is null;`) === '1');
  chk('no position or fill names an account that was removed',
    db.sql(`select (select count(*) from public.portfolio_positions p where p.platform_account_id is not null and not exists (select 1 from public.platform_accounts a where a.id = p.platform_account_id))
      + (select count(*) from public.portfolio_transactions t where t.platform_account_id is not null and not exists (select 1 from public.platform_accounts a where a.id = t.platform_account_id));`) === '0'
    && +db.sql(`select count(*) from public.portfolio_transactions where platform = 'kalshi' and user_id = ${L(A)} and platform_account_id is null;`) > 0);

  /* ═══ A DELETED ACCOUNT TAKES EVERYTHING WITH IT ══════════════════════ */
  db.service(`insert into portfolio_private.platform_credentials (platform_account_id, user_id, credential_kind, ciphertext, nonce, key_version)
              values ('11111111-1111-1111-1111-111111111111', ${L(A)}, 'API_KEY', decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 12), 'hex'), 1);`);
  db.sql(`delete from auth.users where id = ${L(A)};`);
  const left = db.sql(`select (select count(*) from public.portfolio_positions where user_id = ${L(A)}) + (select count(*) from public.portfolio_transactions where user_id = ${L(A)})
    + (select count(*) from public.platform_accounts where user_id = ${L(A)}) + (select count(*) from public.portfolio_imports where user_id = ${L(A)})
    + (select count(*) from public.portfolio_import_rows where user_id = ${L(A)}) + (select count(*) from public.portfolio_sync_logs where user_id = ${L(A)})
    + (select count(*) from portfolio_private.platform_credentials where user_id = ${L(A)});`);
  chk('deleting a reader\'s account deletes every position, fill, account, import, log and credential', left === '0', left);
  chk('and leaves reader B\'s untouched', +db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(B)};`) === 2);
} catch (e) {
  chk('unexpected failure', false, String(e.message || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());

#!/usr/bin/env node
/* ===========================================================================
   THE CONNECTORS END TO END, BEFORE ANY LIVE ACCOUNT: the shipped
   orchestration (lib/edgedesk_portfolio_connect_core.js connect / sync /
   sweep) against FAKE Kalshi and Polymarket APIs that check every request's
   signature, through the PostgREST stand-in, into the REAL migrations
   (portfolio.sql + portfolio_journal.sql + portfolio_connect.sql).

   It walks the ten stages the live smoke test will walk
   (tools/portfolio/connector_smoke.js), so the live test only has to prove
   the platform behaves as its published client says:
     CONNECT       a key that can trade, or that Kalshi refuses, is never
                   stored; a read-only key is sealed and stored
     IMPORT        history before the cutoff and after it, paged
     VERIFY        the stored P&L equals the core's arithmetic
     INCREMENTAL   a second sync adds nothing
     NEW ACTIVITY  a new fill lands, replayed from the stored holding
     SETTLEMENT    a settlement lands on the stored positions
     RECONCILE     a missed fill is detected against Kalshi's own positions
                   and the market is rebuilt from its full history
     DISCONNECT    the credential is deleted
     RECONNECT     the same account, the same history
     NO DUPLICATES a full re-sync adds nothing
   plus: 429 / 5xx / 401 handling, key rotation, the scheduler's sweep, and
   that no log line carries a key or a signature. Polymarket: a seed phrase
   is refused, a proxy wallet is resolved, trades / redemptions / an open
   mark land and reconcile.

   Run: node tools/portfolio/connect_sync.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const path = require('path');
const nodeCrypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');
const K = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_connect_core.js'));

const T = PG.kit('portfolio connect sync (end to end)');
const chk = T.chk;
const L = PG.lit;
const db = PG.start('csync');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const one = (s) => String(s).split('\n')[0];

/* ═══ a fake Kalshi that checks signatures like the real one ═══════════════ */
const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' });
const KEY_ID = 'a952bcbe-ec3b-4b5b-b8f9-11dae589608c';
const kalshi = {
  scopes: ['read'], down: 0, limited: 0, revoked: false,
  hist: [], fills: [], settlements: [], positions: {}, cutoff: '2026-09-01T00:00:00Z',
  markets: { 'NFL-KC': { ticker: 'NFL-KC', event_ticker: 'NFL-W3', title: 'Will the Chiefs win?', yes_sub_title: 'Chiefs' },
    'NBA-LAL': { ticker: 'NBA-LAL', event_ticker: 'NBA-OPEN', title: 'Will the Lakers win?', yes_sub_title: 'Lakers' } },
  events: { 'NFL-W3': { title: 'Chiefs at Bills' }, 'NBA-OPEN': { title: 'Lakers at Celtics' } },
  seen: []
};
function res(status, body, headers) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || null }, json: async () => body };
}
function page(list, q, key) {
  const lim = Math.min(+q.get('limit') || 100, 500), start = +(q.get('cursor') || 0);
  const out = {}; out[key] = list.slice(start, start + lim); out.cursor = start + lim < list.length ? String(start + lim) : '';
  return out;
}
function kalshiFetch(u, opts) {
  const h = opts.headers || {}, path = u.pathname, q = u.searchParams;
  const sig = h['KALSHI-ACCESS-SIGNATURE'], ts = h['KALSHI-ACCESS-TIMESTAMP'];
  const signedOk = h['KALSHI-ACCESS-KEY'] === KEY_ID && sig && ts && nodeCrypto.verify('sha256', Buffer.from(ts + 'GET' + path),
    { key: rsa.publicKey, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, 'base64'));
  kalshi.seen.push(path + (u.search || ''));
  if (!signedOk || kalshi.revoked) return res(401, { error: 'unauthorized' });
  if (kalshi.limited > 0) { kalshi.limited--; return res(429, { error: 'slow down' }, { 'retry-after': '30' }); }
  if (kalshi.down > 0) { kalshi.down--; return res(503, { error: 'down' }); }
  const p = path.replace('/trade-api/v2', '');
  const since = q.get('min_ts') ? +q.get('min_ts') * 1000 : null, ticker = q.get('ticker');
  const sel = (list, tf) => list.filter((x) => (!since || Date.parse(tf(x)) >= since) && (!ticker || x.ticker === ticker));
  if (p === '/api_keys') return res(200, { api_keys: [{ api_key_id: KEY_ID, name: 'edgedesk', scopes: kalshi.scopes }, { api_key_id: 'other', scopes: ['read', 'write'] }] });
  if (p === '/historical/cutoff') return res(200, { trades_created_ts: kalshi.cutoff });
  if (p === '/historical/fills') return res(200, page(sel(kalshi.hist, (x) => x.created_time), q, 'fills'));
  if (p === '/portfolio/fills') return res(200, page(sel(kalshi.fills, (x) => x.created_time), q, 'fills'));
  if (p === '/portfolio/settlements') return res(200, page(sel(kalshi.settlements, (x) => x.settled_time), q, 'settlements'));
  if (p === '/portfolio/positions') return res(200, page(Object.keys(kalshi.positions).map((t) => ({ ticker: t, position_fp: kalshi.positions[t] })), q, 'market_positions'));
  let m = /^\/markets\/(.+)$/.exec(p);
  if (m) return kalshi.markets[decodeURIComponent(m[1])] ? res(200, { market: kalshi.markets[decodeURIComponent(m[1])] }) : res(404, {});
  m = /^\/events\/(.+)$/.exec(p);
  if (m) return res(200, { event: kalshi.events[decodeURIComponent(m[1])] || {} });
  return res(404, {});
}
/* ═══ a fake Polymarket ═══════════════════════════════════════════════════ */
const PROXY = '0xbbb0000000000000000000000000000000000002', EOA = '0xaaa0000000000000000000000000000000000001';
const pm = { activity: [], positions: [] };
function pmFetch(u) {
  const q = u.searchParams;
  if (u.hostname === 'gamma-api.polymarket.com' && u.pathname === '/public-profile') return res(200, q.get('address') === EOA ? { proxyWallet: PROXY.toUpperCase().replace('0X', '0x') } : {});
  if (q.get('user') !== PROXY) return res(200, { data: [], pagination: { has_more: false } });
  const lim = +q.get('limit') || 100, start = +(q.get('cursor') || 0);
  const wrap = (list) => ({ data: list.slice(start, start + lim), pagination: { limit: lim, has_more: start + lim < list.length, next_cursor: String(start + lim) } });
  if (u.pathname === '/v2/activity') return res(200, wrap(pm.activity.filter((a) => a.timestamp >= (+q.get('start') || 0))));
  if (u.pathname === '/v2/positions') return res(200, wrap(pm.positions.filter((p) => p.status === q.get('status'))));
  return res(404, {});
}
async function fakeFetch(url, opts) {
  const u = new URL(url);
  if (u.hostname === 'external-api.kalshi.com') return kalshiFetch(u, opts || {});
  if (/polymarket\.com$/.test(u.hostname)) return pmFetch(u);
  throw new Error('no network in this test: ' + url);
}

(async function main() {
  try {
    for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql']) db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f));
    db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com');`);
    const rest = REST.make(db, { tokens: { svc: 'service_role', a: A } });
    const logs = [];
    const keyring = { current: '1', keys: { 1: nodeCrypto.randomBytes(32).toString('base64') } };
    let clock = Date.parse('2026-10-04T12:00:00Z');
    const ctx = {
      fetch: fakeFetch, now: () => clock, budgetMs: 60000, keyring,
      log: (event, fields) => logs.push(JSON.stringify({ event, fields })),
      rpc: async (fn, args) => {
        const out = rest.handle('POST', 'rpc/' + fn, '', args, '', 'svc');
        if (out.status >= 400) { const e = new Error(fn + ': ' + (out.body && out.body.message)); e.pg = out.body; throw e; }
        return out.body;
      }
    };
    const sql = (q) => db.sql(q);
    const smoke = (platform) => one(db.service(`insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment) values (${L(platform)}, ${L(platform + '_v1')}, 'PRODUCTION') returning id;`));
    const kTest = smoke('kalshi');
    const T0 = (d, h) => '2026-08-' + d + 'T' + (h || '15') + ':00:00Z', T9 = (d, h) => '2026-09-' + d + 'T' + (h || '15') + ':00:00Z';
    kalshi.hist = [{ fill_id: 'h1', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '10.00', yes_price_dollars: '0.40', no_price_dollars: '0.60', fee_cost: '0.07', created_time: T0(20) },
      { fill_id: 'h2', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '5.50', yes_price_dollars: '0.42', no_price_dollars: '0.58', fee_cost: '0.04', created_time: T0(21) }];
    kalshi.fills = [{ fill_id: 'f3', ticker: 'NFL-KC', outcome_side: 'no', count_fp: '20.00', yes_price_dollars: '0.30', no_price_dollars: '0.70', fee_cost: '0.12', created_time: T9(10) },
      { fill_id: 'f4', ticker: 'NBA-LAL', outcome_side: 'yes', count_fp: '8', yes_price_dollars: '0.55', fee_cost: '0.05', created_time: T9(11) }];
    kalshi.positions = { 'NFL-KC': '-4.50', 'NBA-LAL': '8.00' };

    /* ═══ CONNECT ════════════════════════════════════════════════════════ */
    kalshi.scopes = ['read', 'write::trade'];
    let err = null;
    try { await K.connectKalshi(ctx, { userId: A, keyId: KEY_ID, privateKey: PEM, smokeTestId: kTest }); } catch (e) { err = e.code; }
    chk('CONNECT: a key that can trade is refused, and nothing is stored', err === 'WRITE_SCOPE' && sql(`select count(*) from public.platform_accounts;`) === '0'
      && sql(`select count(*) from portfolio_private.platform_credentials;`) === '0');
    kalshi.scopes = ['read'];
    const other = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    err = null;
    try { await K.connectKalshi(ctx, { userId: A, keyId: KEY_ID, privateKey: other, smokeTestId: kTest }); } catch (e) { err = e.code; }
    chk('CONNECT: a private key Kalshi does not recognise is BAD_CREDENTIAL, nothing stored', err === 'BAD_CREDENTIAL' && sql(`select count(*) from portfolio_private.platform_credentials;`) === '0');
    err = null;
    try { await K.connectKalshi(ctx, { userId: A, keyId: KEY_ID, privateKey: PEM }); } catch (e) { err = String(e.message); }
    chk('CONNECT: while the platform is off and no smoke test is running, refused by the database', /not enabled/.test(err || ''), err);
    const conn = await K.connectKalshi(ctx, { userId: A, keyId: KEY_ID, privateKey: PEM, smokeTestId: kTest });
    const acct = conn.account_id;
    chk('CONNECT: a read-only key is validated against Kalshi, sealed and stored', /^[0-9a-f-]{36}$/.test(acct) && JSON.stringify(conn.scopes) === '["read"]'
      && sql(`select count(*) from portfolio_private.platform_credentials where platform_account_id = ${L(acct)} and key_version = 1;`) === '1');

    /* ═══ IMPORT + VERIFY ════════════════════════════════════════════════ */
    const account = () => JSON.parse(sql(`select json_build_object('account_id', id, 'user_id', user_id, 'platform', platform, 'external_account_id', external_account_id, 'sync_cursor', sync_cursor) from public.platform_accounts where id = ${L(acct)};`));
    let r = await K.syncAccount(ctx, account(), 'INITIAL');
    chk('IMPORT: history before the cutoff and after it: 3 positions, 5 transactions', r.status === 'SUCCEEDED' && r.totals.positions_inserted === 3 && r.totals.transactions_inserted === 5
      && kalshi.seen.some((x) => /^\/trade-api\/v2\/historical\/fills/.test(x)), r);
    const pl = () => JSON.parse(sql(`select json_object_agg(external_position_id, coalesce(profit_loss::text, 'open') || '|' || contracts::text || '|' || status) from public.portfolio_positions where platform_account_id = ${L(acct)};`));
    let p = pl();
    chk('VERIFY: YES sold out at −1.833 (fees counted), NO 4.5 held, Lakers 8 held', p['kalshi:NFL-KC:YES'] === '-1.863|0|SETTLED' && p['kalshi:NFL-KC:NO'] === 'open|4.5|OPEN' && p['kalshi:NBA-LAL:YES'] === 'open|8|OPEN', p);
    chk('VERIFY: names from Kalshi\'s market and event', sql(`select event_name || ' / ' || market_name from public.portfolio_positions where external_position_id = 'kalshi:NBA-LAL:YES';`) === 'Lakers at Celtics / Lakers');
    chk('VERIFY: reconciled against Kalshi\'s own positions', r.reconcile.ok === true, r.reconcile);

    /* ═══ INCREMENTAL ════════════════════════════════════════════════════ */
    clock += 30 * 60000;
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('INCREMENTAL: a second sync adds nothing', r.status === 'SUCCEEDED' && r.totals.transactions_inserted === 0 && r.totals.positions_inserted === 0, r);
    chk('…and asks Kalshi only for what is newer than the cursor', kalshi.seen.filter((x) => /^\/trade-api\/v2\/portfolio\/fills/.test(x)).slice(-1)[0].indexOf('min_ts=') > 0);

    /* ═══ NEW ACTIVITY ═══════════════════════════════════════════════════ */
    kalshi.fills.push({ fill_id: 'f5', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '10', yes_price_dollars: '0.50', fee_cost: '0', created_time: T9(25) });
    kalshi.positions['NFL-KC'] = '5.50';
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    p = pl();
    chk('NEW ACTIVITY: +10 YES against the stored 4.5 NO closes NO at 0.50 and buys 5.5 YES', r.totals.transactions_inserted === 2 && p['kalshi:NFL-KC:NO'] === '-0.927|0|SETTLED'
      && p['kalshi:NFL-KC:YES'].split('|')[1] === '5.5' && r.reconcile.ok, [r, p]);

    /* ═══ SETTLEMENT ═════════════════════════════════════════════════════ */
    kalshi.settlements.push({ ticker: 'NFL-KC', market_result: 'yes', revenue: 550, fee_cost: '0.01', settled_time: T9(28) });
    delete kalshi.positions['NFL-KC'];
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    p = pl();
    chk('SETTLEMENT: YES resolves; 5.5 held pays $5.50, the settlement fee on the side held', r.status === 'SUCCEEDED' && /^-?\d/.test(p['kalshi:NFL-KC:YES'])
      && sql(`select resolution || ':' || settlement_price::text from public.portfolio_positions where external_position_id = 'kalshi:NFL-KC:YES';`) === 'YES:1'
      && sql(`select count(*) from public.portfolio_transactions where external_transaction_id = 'kalshi:settle-fee:NFL-KC';`) === '1', [r, p]);
    const yesPl = sql(`select profit_loss::text from public.portfolio_positions where external_position_id = 'kalshi:NFL-KC:YES';`);
    /* YES: buys 6.31 + 2.75 = 9.06; sold 15.5 @ .30 = 4.65; paid 5.50; fees .07+.04+.093+.01 → 1.09 − .213 = 0.877 */
    chk('SETTLEMENT: the YES side\'s whole life: 4.65 + 5.50 − 9.06 − 0.213 fees = +0.877', yesPl === '0.877', yesPl);

    /* ═══ RECONCILE: a missed fill, found and repaired ═══════════════════ */
    kalshi.fills.push({ fill_id: 'f6', ticker: 'NBA-LAL', outcome_side: 'yes', count_fp: '2', yes_price_dollars: '0.60', fee_cost: '0', created_time: T9(29) });
    kalshi.positions['NBA-LAL'] = '10.00';
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    db.service(`select set_config('portfolio.bulk_fills', 'off', true); delete from public.portfolio_transactions where external_transaction_id = 'kalshi:f6:o';
                update public.portfolio_positions set updated_at = now() where external_position_id = 'kalshi:NBA-LAL:YES';`);
    clock += 30 * 60000;
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('RECONCILE: a fill lost on EdgeDesk\'s side is caught against Kalshi\'s positions (8 vs 10)', r.status === 'PARTIAL' && r.reconcile.ok === false
      && r.reconcile.mismatches[0].key === 'NBA-LAL' && r.reconcile.mismatches[0].difference === '-2', r.reconcile);
    clock += 30 * 60000;
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('…and the next sync rebuilds that market from Kalshi\'s full history: 10 held, reconciled', r.reconcile.ok === true && JSON.stringify(r.reconcile.healed) === '["NBA-LAL"]'
      && sql(`select contracts::text from public.portfolio_positions where external_position_id = 'kalshi:NBA-LAL:YES';`) === '10', [r, pl()]);
    const runRow = JSON.parse(one(db.as(A, `select row_to_json(x) from (select status, error_code, reconcile from public.portfolio_sync_runs order by started_at desc limit 1) x;`)));
    chk('the reader sees the repair in their run log', runRow.status === 'SUCCEEDED' && runRow.reconcile.healed[0] === 'NBA-LAL', runRow);

    /* ═══ the platform misbehaving ═══════════════════════════════════════ */
    kalshi.limited = 1; clock += 30 * 60000;
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('429: FAILED as RATE_LIMITED, backed off — the cursor is not moved', r.status === 'FAILED' && r.error.code === 'RATE_LIMITED'
      && sql(`select (next_sync_at > now() + interval '14 minutes')::text from public.platform_accounts where id = ${L(acct)};`) === 'true');
    kalshi.down = 1;
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('5xx: PLATFORM_DOWN, retried later; the reader keeps their history', r.error.code === 'PLATFORM_DOWN' && sql(`select count(*) from public.portfolio_positions where platform_account_id = ${L(acct)};`) === '3');

    /* ═══ KEY ROTATION ═══════════════════════════════════════════════════ */
    keyring.keys[2] = nodeCrypto.randomBytes(32).toString('base64'); keyring.current = '2';
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('a credential sealed under key 1 opens, syncs, and is re-sealed under key 2', r.status === 'SUCCEEDED'
      && sql(`select key_version from portfolio_private.platform_credentials where platform_account_id = ${L(acct)};`) === '2', r);
    delete keyring.keys[1];
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('…after which key 1 can be retired', r.status === 'SUCCEEDED');

    /* ═══ DISCONNECT, RECONNECT, NO DUPLICATES ═══════════════════════════ */
    const txBefore = sql(`select count(*) from public.portfolio_transactions where platform_account_id = ${L(acct)};`);
    const d = JSON.parse(one(db.as(A, `select public.portfolio_disconnect(${L(acct)}, false);`)));
    chk('DISCONNECT: the credential is deleted; the history stays', d.credential_deleted && sql(`select count(*) from portfolio_private.platform_credentials;`) === '0'
      && sql(`select status from public.platform_accounts where id = ${L(acct)};`) === 'DISCONNECTED');
    r = await K.syncAccount(ctx, account(), 'INCREMENTAL');
    chk('…and a sync attempted anyway finds no key: ACTION REQUIRED', r.status === 'FAILED' && r.error.code === 'BAD_CREDENTIAL');
    const again = await K.connectKalshi(ctx, { userId: A, keyId: KEY_ID, privateKey: PEM, smokeTestId: kTest });
    chk('RECONNECT: the same account', again.account_id === acct);
    db.service(`update public.platform_accounts set sync_cursor = null where id = ${L(acct)};`);
    r = await K.syncAccount(ctx, account(), 'INITIAL');
    chk('NO DUPLICATES: a full re-sync of the whole history adds nothing', r.status === 'SUCCEEDED' && r.totals.transactions_inserted === 0
      && sql(`select count(*) from public.portfolio_transactions where platform_account_id = ${L(acct)};`) === txBefore, [r, txBefore]);

    /* ═══ THE SCHEDULER ══════════════════════════════════════════════════ */
    let sw = await K.sweep(ctx, 10);
    chk('the sweep skips a platform that is switched off', sw.due === 0);
    const passed = one(db.service(`insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment, stages, status, finished_at)
      values ('kalshi', 'kalshi_v1', 'PRODUCTION', ${L(JSON.stringify(Object.fromEntries(K.SMOKE_STAGES.map((s) => [s, { ok: true }]))))}::jsonb, 'PASSED', now()) returning id;`));
    db.service(`update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = ${L(passed)}, tos_review = 'CLEARED', enabled_at = now() where platform_key = 'kalshi';
                update public.platform_accounts set next_sync_at = now() - interval '1 minute' where id = ${L(acct)};`);
    sw = await K.sweep(ctx, 10);
    chk('once switched on, the sweep syncs the due account', sw.due === 1 && sw.done[0].status === 'SUCCEEDED', sw);
    kalshi.revoked = true;
    db.service(`update public.platform_accounts set next_sync_at = now() - interval '1 minute' where id = ${L(acct)};`);
    sw = await K.sweep(ctx, 10);
    chk('a key revoked at Kalshi: ACTION REQUIRED, and the sweep stops trying', sw.done[0].status === 'FAILED'
      && sql(`select status from public.platform_accounts where id = ${L(acct)};`) === 'ACTION_REQUIRED' && (await K.sweep(ctx, 10)).due === 0);

    /* ═══ POLYMARKET ═════════════════════════════════════════════════════ */
    const pTest = smoke('polymarket');
    err = null;
    try { await K.connectPolymarket(ctx, { userId: A, wallet: 'apple banana cherry delta eagle falcon garden harbor island jungle kettle lemon', smokeTestId: pTest }); } catch (e) { err = e.code; }
    chk('Polymarket: a seed phrase is refused before anything is asked of anyone', err === 'SECRET_PASTED' && !kalshi.seen.some((x) => /apple/.test(x)));
    const pc = await K.connectPolymarket(ctx, { userId: A, wallet: EOA, smokeTestId: pTest });
    chk('Polymarket: the public address resolves to its proxy wallet; no credential is stored', pc.wallet === PROXY
      && sql(`select external_account_id || ':' || ingestion_method from public.platform_accounts where id = ${L(pc.account_id)};`) === PROXY + ':PUBLIC_WALLET'
      && sql(`select count(*) from portfolio_private.platform_credentials where platform_account_id = ${L(pc.account_id)};`) === '0');
    pm.activity = [
      { type: 'TRADE', timestamp: 1757692800, condition_id: 'c1', token_id: '7132', side: 'BUY', size: 100, usdc_size: 40, price: 0.4, outcome: 'Yes', title: 'Will the Chiefs win the AFC?', transaction_hash: '0xh1' },
      { type: 'TRADE', timestamp: 1757779200, condition_id: 'c1', token_id: '7132', side: 'SELL', size: 60, usdc_size: 36, price: 0.6, outcome: 'Yes', title: 'Will the Chiefs win the AFC?', transaction_hash: '0xh2' },
      { type: 'TRADE', timestamp: 1757865600, condition_id: 'c2', token_id: '9911', side: 'BUY', size: 10, usdc_size: 3, price: 0.3, outcome: 'Bills', title: 'AFC East winner', transaction_hash: '0xh3' }];
    pm.positions = [{ token_id: '7132', condition_id: 'c1', outcome: 'Yes', title: 'Will the Chiefs win the AFC?', status: 'OPEN', current_price: 0.55, current_size: 40, entry_fees_usdc: '0.2' },
      { token_id: '9911', condition_id: 'c2', outcome: 'Bills', title: 'AFC East winner', status: 'OPEN', current_price: 0.25, current_size: 10 }];
    const pAccount = () => JSON.parse(sql(`select json_build_object('account_id', id, 'user_id', user_id, 'platform', platform, 'external_account_id', external_account_id, 'sync_cursor', sync_cursor) from public.platform_accounts where id = ${L(pc.account_id)};`));
    r = await K.syncAccount(ctx, pAccount(), 'INITIAL');
    chk('Polymarket IMPORT: two positions, a partial sell, the entry fee, open marks; reconciled', r.status === 'SUCCEEDED' && r.totals.positions_inserted === 2 && r.reconcile.ok
      && sql(`select contracts::text || ':' || fees::text || ':' || unrealized_profit_loss::text from public.portfolio_positions where external_position_id = 'polymarket:7132';`) === '40:0.2:6', r);
    r = await K.syncAccount(ctx, pAccount(), 'INCREMENTAL');
    chk('Polymarket INCREMENTAL: nothing new', r.totals.transactions_inserted === 0 && r.status === 'SUCCEEDED', r);
    pm.activity.push({ type: 'REDEEM', timestamp: 1758038400, condition_id: 'c1', usdc_size: 40 });
    pm.positions[0] = Object.assign({}, pm.positions[0], { status: 'CLOSED', current_size: 0 });
    pm.positions[1] = Object.assign({}, pm.positions[1], { status: 'REDEEMABLE_LOST' });
    r = await K.syncAccount(ctx, pAccount(), 'INCREMENTAL');
    const pmPl = JSON.parse(sql(`select json_object_agg(external_position_id, resolution || '|' || profit_loss::text) from public.portfolio_positions where platform_account_id = ${L(pc.account_id)};`));
    chk('Polymarket SETTLEMENT: the redeemed winner (36 + 40 − 40 − 0.2 = +35.80) and the loser (−3)', pmPl['polymarket:7132'] === 'YES|35.8' && pmPl['polymarket:9911'] === 'OTHER OUTCOME|-3', [r, pmPl]);

    /* ═══ NOTHING SECRET IN A LOG ════════════════════════════════════════ */
    const all = logs.join('\n');
    chk('no log line carries the private key, a signature, a nonce or ciphertext', logs.length > 5 && !/PRIVATE KEY|MII[A-Za-z0-9+/]{20}/.test(all) && !/KALSHI-ACCESS-SIGNATURE/.test(all) && !all.includes(PEM.slice(40, 80)), logs.slice(0, 3));
  } catch (e) {
    chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 1500));
  } finally {
    db.stop();
  }
  process.exit(T.done());
}());

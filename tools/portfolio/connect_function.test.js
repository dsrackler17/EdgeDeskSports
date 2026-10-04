#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/portfolio_connect/index.ts — THE SHIPPED FILE, run in
   Node with a stub Deno runtime, against a fake Supabase (Auth + PostgREST,
   the latter the stand-in over the REAL migrations) and fake platforms.

   Proves the HTTP layer keeps the promises the core makes:
     - health names what is configured, never a value;
     - no token, no action (except the scheduler's sweep, which only syncs
       what the database says is due);
     - a platform that is switched off cannot be connected — except by an
       operator running the live smoke test;
     - a sportsbook is never offered a connection;
     - the private key is never echoed in a response or written to a log;
     - a reader's sync is rate-limited; disconnect deletes the credential and
       says what to revoke at the platform;
     - a seed phrase pasted as a wallet is refused.

   Run: node tools/portfolio/connect_function.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const nodeCrypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');

const T = PG.kit('portfolio connect function');
const chk = T.chk;
const L = PG.lit;
const db = PG.start('cfn');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const ADMIN = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';
const SB = 'https://project.supabase.co', SERVICE = 'service-role-key-for-tests', ANON = 'anon-key-for-tests';
const TOKENS = { 'tok-a': A, 'tok-admin': ADMIN };
const one = (s) => String(s).split('\n')[0];

const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' });
const KEY_ID = 'a952bcbe-ec3b-4b5b-b8f9-11dae589608c';
function res(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}

(async function main() {
  try {
    for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql']) db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f));
    db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(ADMIN)}, 'op@example.com');`);
    const rest = REST.make(db, { tokens: Object.assign({ [SERVICE]: 'service_role' }, TOKENS) });

    async function fakeFetch(url, init) {
      init = init || {};
      const u = new URL(url), h = init.headers || {}, auth = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
      if (u.origin === SB && u.pathname === '/auth/v1/user') return TOKENS[auth] ? res(200, { id: TOKENS[auth], email: 'x@example.com' }) : res(401, { msg: 'bad jwt' });
      if (u.origin === SB && u.pathname.indexOf('/rest/v1/') === 0) {
        const p = decodeURIComponent(u.pathname.slice('/rest/v1/'.length));
        const out = rest.handle(init.method || 'GET', p, u.search.slice(1), init.body ? JSON.parse(init.body) : null, h.prefer || '', auth);
        return new Response(out.body == null ? '' : JSON.stringify(out.body), { status: out.status });
      }
      if (u.hostname === 'external-api.kalshi.com') {
        const ts = h['KALSHI-ACCESS-TIMESTAMP'], sig = h['KALSHI-ACCESS-SIGNATURE'];
        const ok = sig && nodeCrypto.verify('sha256', Buffer.from(ts + 'GET' + u.pathname), { key: rsa.publicKey, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, 'base64'));
        if (!ok) return res(401, {});
        const p = u.pathname.replace('/trade-api/v2', '');
        if (p === '/api_keys') return res(200, { api_keys: [{ api_key_id: KEY_ID, scopes: ['read'] }] });
        if (p === '/historical/cutoff') return res(200, {});
        if (p === '/portfolio/fills') return res(200, { fills: [{ fill_id: 'f1', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '3', yes_price_dollars: '0.5', fee_cost: '0.01', created_time: '2026-09-10T15:00:00Z' }], cursor: '' });
        if (p === '/portfolio/settlements') return res(200, { settlements: [], cursor: '' });
        if (p === '/portfolio/positions') return res(200, { market_positions: [{ ticker: 'NFL-KC', position_fp: '3.00' }], cursor: '' });
        if (/^\/markets\//.test(p)) return res(200, { market: { ticker: 'NFL-KC', event_ticker: 'E', title: 'Chiefs?', yes_sub_title: 'Chiefs' } });
        if (/^\/events\//.test(p)) return res(200, { event: { title: 'Chiefs at Bills' } });
        return res(404, {});
      }
      throw new Error('no network: ' + url);
    }

    /* the shipped file, in a stub Deno */
    const logs = [];
    let handler = null;
    const env = { SB_URL: SB, SB_SERVICE_ROLE: SERVICE, SUPABASE_ANON_KEY: ANON,
      PORTFOLIO_CREDENTIAL_KEYS: JSON.stringify({ 1: nodeCrypto.randomBytes(32).toString('base64') }), PORTFOLIO_CREDENTIAL_KEY_VERSION: '1' };
    const sandbox = { Deno: { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } }, fetch: fakeFetch, Response, Request, Headers, URL, URLSearchParams,
      TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob, AbortController, setTimeout, clearTimeout,
      console: { log: (x) => logs.push(String(x)), error: (x) => logs.push(String(x)) } };
    sandbox.globalThis = sandbox; sandbox.self = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(PG.ROOT, 'supabase', 'functions', 'portfolio_connect', 'index.ts'), 'utf8'), sandbox, { filename: 'portfolio_connect/index.ts' });
    chk('the shipped file loads and registers its handler', typeof handler === 'function');
    const call = async (body, token, method) => {
      const r = await handler(new Request('https://fn.local/portfolio_connect', { method: method || 'POST', headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {}), body: method === 'GET' ? undefined : JSON.stringify(body || {}) }));
      return { status: r.status, body: await r.json(), text: '' };
    };

    let r = await call(null, null, 'GET');
    chk('health: what is configured, never a value', r.status === 200 && r.body.configured.credential_keys === 1 && r.body.configured.current_key_version === '1'
      && !JSON.stringify(r.body).includes(env.PORTFOLIO_CREDENTIAL_KEYS.slice(8, 30)) && !JSON.stringify(r.body).includes(SERVICE));
    r = await call({ action: 'registry' });
    chk('no token, no action', r.status === 401);
    r = await call({ action: 'registry' }, 'tok-a');
    const off = r.body.platforms.find((p) => p.key === 'kalshi'), dk = r.body.platforms.find((p) => p.key === 'draftkings');
    chk('registry: Kalshi reads IMPORT (pending its live test); a sportsbook IMPORT, with why', off.offer.kind === 'IMPORT' && off.offer.automatic_pending === true
      && dk.offer.kind === 'IMPORT' && /never asks for your sportsbook password/.test(dk.offer.note) && dk.automatic === null);
    r = await call({ action: 'connect', platform: 'draftkings', username: 'x', password: 'y' }, 'tok-a');
    chk('a sportsbook cannot be "connected", whatever is sent', r.status === 400 && r.body.reason === 'not_automatic');
    r = await call({ action: 'connect', platform: 'kalshi', key_id: KEY_ID, private_key: PEM }, 'tok-a');
    chk('Kalshi while switched off: refused for a reader', r.status === 403 && r.body.reason === 'DISABLED' && db.sql('select count(*) from public.platform_accounts;') === '0');
    r = await call({ action: 'connect', platform: 'kalshi', key_id: KEY_ID, private_key: PEM }, 'tok-admin');
    chk('…and for an operator without a smoke test', r.status === 403);
    const smoke = one(db.service(`insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment) values ('kalshi', 'kalshi_v1', 'PRODUCTION') returning id;`));
    r = await call({ action: 'connect', platform: 'kalshi', key_id: KEY_ID, private_key: PEM, smoke_test: smoke }, 'tok-admin');
    chk('an operator running the live smoke test connects, and the first sync runs', r.status === 200 && r.body.ok && r.body.sync.status === 'SUCCEEDED' && r.body.sync.totals.transactions_inserted === 1, r.body);
    const acct = r.body.account_id;
    const everything = JSON.stringify(r.body) + logs.join('\n');
    chk('the private key never appears in the response or any log line', !everything.includes('PRIVATE KEY') && !everything.includes(PEM.slice(60, 100)) && !/KALSHI-ACCESS-SIGNATURE/.test(everything), logs.slice(-3));
    chk('every log line is structured and names the function', logs.length > 0 && logs.every((l) => { try { return JSON.parse(l).fn === 'portfolio_connect'; } catch (_) { return false; } }));
    r = await call({ action: 'sync', account_id: acct }, 'tok-a');
    chk('another reader cannot sync that account', r.status === 404);
    r = await call({ action: 'sync', account_id: acct }, 'tok-admin');
    chk('a reader\'s own sync is limited to one every two minutes', r.status === 429 && r.body.reason === 'too_soon');
    r = await call({ action: 'disconnect', account_id: acct }, 'tok-a');
    chk('another reader cannot disconnect it', r.status === 404);
    r = await call({ action: 'disconnect', account_id: acct }, 'tok-admin');
    chk('disconnect: the credential is deleted, and the reader is told how to revoke the key at Kalshi', r.status === 200 && r.body.credential_deleted === true
      && /delete it in your Kalshi account's API key settings/.test(r.body.revoke) && db.sql('select count(*) from portfolio_private.platform_credentials;') === '0');
    db.service(`update portfolio_private.connector_smoke_tests set platform_key = 'polymarket', connector_version = 'polymarket_v1' where id = ${L(smoke)};`);
    r = await call({ action: 'connect', platform: 'polymarket', wallet: 'apple banana cherry delta eagle falcon garden harbor island jungle kettle lemon', smoke_test: smoke }, 'tok-admin');
    chk('a seed phrase pasted as a wallet is refused, in plain words', r.status === 400 && r.body.reason === 'SECRET_PASTED' && /Never share those/.test(r.body.message));
    r = await call({ action: 'sweep' });
    chk('the scheduler\'s sweep needs no identity and syncs only what is due (nothing, here)', r.status === 200 && r.body.due === 0);
    r = await call({ action: 'nope' }, 'tok-a');
    chk('an unknown action is refused', r.status === 400);
  } catch (e) {
    chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 1500));
  } finally {
    db.stop();
  }
  process.exit(T.done());
}());

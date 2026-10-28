#!/usr/bin/env node
/* ===========================================================================
   THE COLLECTIVE'S OWN-KEY EXCEPTION, END TO END — the deployed handler of
   supabase/functions/collective_odds_ingest/index.ts, run as it ships.

   Methodology change 2026-10-28
   (docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-28-collective-own-key.md):
   until 2026-11-01T00:00:00Z, and only while COLLECTIVE_ODDS_API_KEY is set
   and the odds_api breaker reads ON, the Collective's daily poll asks The Odds
   API itself with its own key; otherwise, and from the reset on, it asks
   odds_gateway exactly as before.

   The file is type-stripped and run in a sandbox: Deno.env and Deno.serve are
   stubbed, and every fetch is answered here (PostgREST RPCs, the breaker,
   odds_gateway, the provider), so no network and no credential is touched.
   A clock is injected so "before the reset" and "at the reset" are tested,
   not assumed.

   Run: node tools/odds/collective_own_key.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'supabase', 'functions', 'collective_odds_ingest', 'index.ts');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };

if (typeof Module.stripTypeScriptTypes !== 'function') {
  console.error('FAILED this suite needs Node 22.13+ (module.stripTypeScriptTypes)');
  process.exit(1);
}
const JS = (() => {
  const emit = process.emitWarning;
  process.emitWarning = () => {};   /* stripTypeScriptTypes is "experimental" and says so on every call */
  try { return Module.stripTypeScriptTypes(fs.readFileSync(SRC, 'utf8')); } finally { process.emitWarning = emit; }
})();

const SB = 'https://ref.supabase.co';
const SERVICE = 'service-role-key-for-the-test';
const OWN_KEY = '0123456789abcdef0123456789abcdef';   /* the shape The Odds API issues; not a real key */
const PROVIDER = 'https://api.the-odds-api.com/v4/';
const GATEWAY = SB + '/functions/v1/odds_gateway';

const EVENT = {
  id: 'e1', sport_key: 'americanfootball_nfl', commence_time: '2026-10-30T00:15:00Z',
  home_team: 'Chicago Bears', away_team: 'New England Patriots',
  bookmakers: [{ key: 'draftkings', title: 'DraftKings', last_update: '2026-10-29T12:30:00Z', markets: [
    { key: 'h2h', last_update: '2026-10-29T12:30:00Z', outcomes: [{ name: 'Chicago Bears', price: -150 }, { name: 'New England Patriots', price: 130 }] },
    { key: 'spreads', last_update: '2026-10-29T12:30:00Z', outcomes: [{ name: 'Chicago Bears', price: -110, point: -3 }, { name: 'New England Patriots', price: -110, point: 3 }] },
    { key: 'totals', last_update: '2026-10-29T12:30:00Z', outcomes: [{ name: 'Over', price: -110, point: 44.5 }, { name: 'Under', price: -110, point: 44.5 }] },
  ] }],
};

/* One run of the deployed handler: POST /v1/ingest?league=nfl as the cron. */
async function run({ now, env, breaker = 'on', provider = 'ok', quota = { remaining: 443, used: 57, last_cost: 3 } }) {
  const calls = [];
  const settings = {
    'nfl.enabled': true, 'nfl.league_id': 'nfl', 'provider.default': 'theoddsapi',
    'nfl.markets': ['moneyline', 'spread', 'total'], 'nfl.books': ['draftkings', 'fanduel'],
    'provider.credit_reserve': 40, 'provider.quota': { ...quota, observed_at: '2026-10-21T12:35:03Z' },
  };
  const longAgo = new Date(now - 86400000).toISOString();
  /* always JSON, as PostgREST answers: a string setting arrives as "theoddsapi", quoted */
  const reply = (status, body, headers) => new Response(body === undefined ? '' : JSON.stringify(body),
    { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
  const rpcs = {
    odds_get_setting: (a) => (a.p_key in settings ? settings[a.p_key] : null),
    odds_status: () => ({ last_poll_at: longAgo, last_run: { started_at: longAgo, status: 'error' }, events_live: 0 }),
    odds_board: () => ({ games: [] }),
    odds_begin_run: () => 7,
    odds_ingest: (a) => ({ ok: true, events_seen: a.p_payload.events.length, events_created: 0, snapshots_written: a.p_payload.events.length * 6, snapshots_unchanged: 0, rows_rejected: 0, unmatched: [] }),
    odds_finish_run: () => undefined,
    odds_finalize_closing: () => 0,
    odds_link_games: () => 0,
    odds_set_setting: () => undefined,
  };
  const fetchStub = async (url, init) => {
    init = init || {};
    const u = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, method: init.method || 'GET', body, headers: init.headers || {} });
    if (u === SB + '/rest/v1/rpc/odds_api_enabled') {
      if (breaker === 'unreadable') return reply(500, { message: 'boom' });
      return reply(200, breaker === 'on');
    }
    const m = u.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m && rpcs[m[1]]) { const out = rpcs[m[1]](body || {}); return reply(200, out === undefined ? undefined : out); }
    if (u === GATEWAY) return reply(200, { ok: false, decision: 'denied_unconfirmed_quota', reason: "this cycle's quota is not confirmed" });
    if (u.startsWith(PROVIDER)) {
      const h = { 'x-requests-remaining': '440', 'x-requests-used': '60', 'x-requests-last': '3' };
      if (provider === '401') return reply(401, { message: 'invalid api key ' + new URL(u).searchParams.get('apiKey') }, h);
      return reply(200, [EVENT], h);
    }
    return reply(404, { message: 'unrouted ' + u });
  };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  let handler = null;
  const ctx = {
    Deno: { env: { get: (k) => (k in env ? env[k] : undefined) }, serve: (h) => { handler = h; } },
    fetch: fetchStub, Date: FixedDate, URL, URLSearchParams, Headers, Request, Response, AbortController,
    setTimeout, clearTimeout, TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone,
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(JS, ctx, { filename: SRC });
  const res = await handler(new Request(SB + '/functions/v1/collective_odds_ingest/v1/ingest?league=nfl',
    { method: 'POST', headers: { authorization: 'Bearer ' + SERVICE } }));
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch (_) { return null; } })(), calls };
}

const BASE_ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: 'anon' };
const ENV_KEY = Object.assign({}, BASE_ENV, { COLLECTIVE_ODDS_API_KEY: '  ' + OWN_KEY + '\n' });   /* pasted with whitespace */
const BEFORE = Date.parse('2026-10-29T12:35:00Z');   /* Thursday's poll */
const LAST_SECOND = Date.parse('2026-10-31T23:59:59Z');
const RESET = Date.parse('2026-11-01T00:00:00Z');
const to = (calls, prefix) => calls.filter((c) => c.url.startsWith(prefix));
const finish = (calls) => calls.filter((c) => /rpc\/odds_finish_run$/.test(c.url)).map((c) => c.body);
const quotaWrites = (calls) => calls.filter((c) => /rpc\/odds_set_setting$/.test(c.url) && c.body && c.body.p_key === 'provider.quota').map((c) => c.body.p_value);
const noKeyAnywhere = (r) => !r.text.includes(OWN_KEY) && !JSON.stringify(r.calls.filter((c) => !c.url.startsWith(PROVIDER))).includes(OWN_KEY);

(async () => {
  /* ── 1 · before the reset, key set, breaker on: the provider, with the Collective's own key ── */
  let r = await run({ now: BEFORE, env: ENV_KEY });
  const prov = to(r.calls, PROVIDER);
  chk('1 · one request to The Odds API', prov.length === 1, r.calls.map((c) => c.url));
  const pu = prov[0] ? new URL(prov[0].url) : null;
  chk('1 · …for the NFL board', pu && pu.pathname === '/v4/sports/americanfootball_nfl/odds', pu && pu.pathname);
  chk('1 · …with the Collective\'s own key, trimmed', pu && pu.searchParams.get('apiKey') === OWN_KEY);
  chk('1 · …the main markets, one region, american prices (3 credits)', pu && pu.searchParams.get('markets') === 'h2h,spreads,totals'
    && pu.searchParams.get('regions') === 'us' && pu.searchParams.get('oddsFormat') === 'american', pu && pu.search.replace(OWN_KEY, 'KEY'));
  chk('1 · odds_gateway is not asked', to(r.calls, GATEWAY).length === 0);
  const brk = r.calls.findIndex((c) => /rpc\/odds_api_enabled$/.test(c.url));
  chk('1 · the breaker is read first, with the service role', brk >= 0 && brk < r.calls.findIndex((c) => c.url.startsWith(PROVIDER))
    && r.calls[brk].headers.Authorization === 'Bearer ' + SERVICE);
  const ingest = r.calls.filter((c) => /rpc\/odds_ingest$/.test(c.url));
  chk('1 · the board is stored (odds_ingest gets the event)', ingest.length === 1 && ingest[0].body.p_payload.events.length === 1, ingest.map((c) => c.body.p_payload.events.length));
  chk('1 · and the close is finalized after it, as before', r.calls.some((c) => /rpc\/odds_finalize_closing$/.test(c.url)));
  chk('1 · the Collective\'s own balance is recorded from the provider\'s headers', quotaWrites(r.calls).some((q) => q.remaining === 440 && q.used === 60 && q.last_cost === 3), quotaWrites(r.calls));
  chk('1 · the run finishes ok and answers 200', r.status === 200 && r.json && r.json.ok === true && finish(r.calls).some((s) => s.p_stats.status === 'ok' || s.p_stats.status === 'partial'), [r.status, r.text.slice(0, 300)]);
  chk('1 · the key appears nowhere but the provider request', noKeyAnywhere(r));

  r = await run({ now: LAST_SECOND, env: ENV_KEY });
  chk('1 · still open at 2026-10-31T23:59:59Z', to(r.calls, PROVIDER).length === 1 && to(r.calls, GATEWAY).length === 0);

  /* ── 2 · at the reset: the gateway again, the key ignored ─────────────── */
  r = await run({ now: RESET, env: ENV_KEY });
  chk('2 · at 2026-11-01T00:00:00Z the provider is not asked', to(r.calls, PROVIDER).length === 0, r.calls.map((c) => c.url));
  const gw = to(r.calls, GATEWAY);
  chk('2 · odds_gateway is, as category collective', gw.length === 1 && gw[0].body.category === 'collective', gw.map((c) => c.body));
  chk('2 · and the breaker is not consulted by this function (the gateway owns it)', !r.calls.some((c) => /rpc\/odds_api_enabled$/.test(c.url)));
  chk('2 · the key appears nowhere', !r.text.includes(OWN_KEY) && !JSON.stringify(r.calls).includes(OWN_KEY));

  /* ── 3 · no key: today's behaviour, unchanged ────────────────────────── */
  r = await run({ now: BEFORE, env: BASE_ENV });
  chk('3 · without COLLECTIVE_ODDS_API_KEY the provider is never asked', to(r.calls, PROVIDER).length === 0);
  chk('3 · odds_gateway is, and its refusal is recorded as before', to(r.calls, GATEWAY).length === 1
    && finish(r.calls).some((s) => /denied_unconfirmed_quota/.test(JSON.stringify(s))), finish(r.calls));
  r = await run({ now: BEFORE, env: Object.assign({}, BASE_ENV, { COLLECTIVE_ODDS_API_KEY: '   ' }) });
  chk('3 · a blank key is no key', to(r.calls, PROVIDER).length === 0 && to(r.calls, GATEWAY).length === 1);
  r = await run({ now: BEFORE, env: Object.assign({}, BASE_ENV, { THE_ODDS_API_KEY: OWN_KEY, NFL_ODDS_API_KEY: OWN_KEY, ODDS_API_KEY: OWN_KEY }) });
  chk('3 · no other key name opens it (THE_ODDS_API_KEY, NFL_ODDS_API_KEY, ODDS_API_KEY)', to(r.calls, PROVIDER).length === 0 && to(r.calls, GATEWAY).length === 1);

  /* ── 4 · the incident's breaker governs the exception ─────────────────── */
  for (const b of ['off', 'unreadable']) {
    r = await run({ now: BEFORE, env: ENV_KEY, breaker: b });
    chk('4 · breaker ' + b + ': the provider is not asked', to(r.calls, PROVIDER).length === 0, r.calls.map((c) => c.url));
    chk('4 · breaker ' + b + ': nor is the gateway (no second route)', to(r.calls, GATEWAY).length === 0);
    chk('4 · breaker ' + b + ': the run is recorded as an error naming the breaker', finish(r.calls).some((s) => s.p_stats.status === 'error' && /breaker/.test(JSON.stringify(s))), finish(r.calls));
  }

  /* ── 5 · a provider error: recorded, the key redacted ─────────────────── */
  r = await run({ now: BEFORE, env: ENV_KEY, provider: '401' });
  chk('5 · a 401 is recorded as an error with the provider\'s reason', finish(r.calls).some((s) => s.p_stats.status === 'error' && /401/.test(JSON.stringify(s))), finish(r.calls));
  chk('5 · the key the provider echoed is redacted everywhere', noKeyAnywhere(r), r.text.slice(0, 300));

  /* ── 6 · the existing reserve guard still stands in front of it ───────── */
  r = await run({ now: BEFORE, env: ENV_KEY, quota: { remaining: 42, used: 458, last_cost: 3 } });
  chk('6 · 42 left, a 3-credit poll, a reserve of 40: skipped, nothing bought', to(r.calls, PROVIDER).length === 0
    && r.json && r.json.skipped === 'credit_budget', r.text.slice(0, 300));

  if (fail) {
    console.error('FAILED the Collective\'s own-key exception — ' + pass + ' passed, ' + fail + ' failed');
    for (const f of failures) console.error('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : ''));
    process.exit(1);
  }
  console.log('ALL GREEN the Collective\'s own-key exception — ' + pass + ' passed, 0 failed');
})().catch((e) => { console.error('FAILED ' + (e && e.stack || e)); process.exit(1); });

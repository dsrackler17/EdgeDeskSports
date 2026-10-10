#!/usr/bin/env node
/* ===========================================================================
   THE QUOTA GUARD, end to end, on the DEPLOYED capture function (imported
   under Node with a Deno shim, as tools/capture/capture.test.js does) and the
   close function's stop rule. Nothing reaches a network.

   Scenarios (docs/market-resilience):
     Q1  the ledger says cache_fresh / coalesced / research_only → ok:true,
         skipped, and NOT ONE odds request is made
     Q2  the ledger is not applied (404) → capture runs on its in-run guard
         and says "ledger_missing"
     Q3  HTTP 429 on the first sport → no further sport, ladder or prop request;
         the run is settled RATE_LIMITED with the provider's numbers
     Q4  a balance under the floor → the run stops before spending into it
     Q5  three timeouts in a row → circuit_open, nothing more is requested
     Q6  401 "usage quota reached" → QUOTA_EXHAUSTED, the run stops
     Q7  a reader-triggered refresh asks under the near tier's key at low
         priority (cache-first against the scheduled run, never the reserve)
     Q8  a recovered provider (API access resumes) → the next run is allowed
         and settles OK, which closes the breaker in the ledger
     Q9  close and capture classify every failure the same way
     Q10 ?diag=1 never buys alternate ladders

   Run: node tools/resilience/quota_guard.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'quota guard — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ENV = {
  CRON_SECRET: 'test-secret', ODDS_API_KEY: 'test-odds-key', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  CAPTURE_NO_SERVE: '1', CAPTURE_SPORTS: 'americanfootball_nfl,americanfootball_ncaaf,basketball_nba', CAPTURE_AUTO_PREFIXES: '',
  CAPTURE_PLAYER_PROPS: 'true'
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const NOW = Date.now();
const KICK = new Date(NOW + 6 * 3600e3).toISOString();
function res(status, body, headers) {
  const h = headers || {};
  return { ok: status < 300, status, headers: { get: (n) => h[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
}
const event = (sport) => ({ id: 'evt-' + sport, sport_key: sport, sport_title: sport, commence_time: KICK, home_team: 'Home', away_team: 'Away',
  bookmakers: ['dk', 'fd', 'mgm'].map((k) => ({ key: k, title: k, last_update: new Date(NOW - 60e3).toISOString(),
    markets: [{ key: 'spreads', last_update: new Date(NOW - 60e3).toISOString(), outcomes: [{ name: 'Home', price: 1.91, point: -3.5 }, { name: 'Away', price: 1.91, point: 3.5 }] }] })) });

let net;
function reset(over) {
  net = Object.assign({ calls: [], ledger: null, settles: [], oddsStatus: {}, oddsRemaining: '5000', timeouts: false, eventCalls: 0 }, over || {});
}
globalThis.fetch = async function (url, init) {
  const u = String(url), method = (init && init.method) || 'GET', body = init && init.body ? JSON.parse(init.body) : null;
  net.calls.push({ u, method, body });
  if (u.indexOf('/rest/v1/rpc/odds_quota_acquire') >= 0) return net.ledger ? net.ledger(body) : res(404, { code: 'PGRST202', message: 'Could not find the function' });
  if (u.indexOf('/rest/v1/rpc/odds_quota_settle') >= 0) { net.settles.push(body); return res(200, { settled: true, status: body.p_status }); }
  if (u.indexOf('sb.test') >= 0) return res(200, [], { 'content-range': '*/0' });
  if (u.indexOf('api.the-odds-api.com/v4/sports/?') >= 0) return res(200, []);
  if (/\/events\/?\?/.test(u)) return res(200, [{ id: 'x', commence_time: KICK }]);
  if (/\/events\/[^/]+\/odds/.test(u)) { net.eventCalls++; return res(200, { id: 'evt', bookmakers: [] }, { 'x-requests-remaining': net.oddsRemaining, 'x-requests-last': '0' }); }
  const m = /\/v4\/sports\/([^/]+)\/odds/.exec(u);
  if (m) {
    const sport = decodeURIComponent(m[1]);
    if (net.timeouts) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
    const st = net.oddsStatus[sport];
    if (st) return res(st.status, st.body || 'no', Object.assign({ 'x-requests-remaining': net.oddsRemaining, 'x-requests-last': '0' }, st.headers || {}));
    return res(200, [event(sport)], { 'x-requests-remaining': net.oddsRemaining, 'x-requests-used': '100', 'x-requests-last': '6' });
  }
  return res(404, 'nope');
};
const oddsCalls = () => net.calls.filter((c) => /api\.the-odds-api\.com\/v4\/sports\/[^?]+\/odds/.test(c.u) && !/\/events\//.test(c.u)).length;
const allProviderCalls = () => net.calls.filter((c) => /api\.the-odds-api\.com/.test(c.u)).length;
const rq = (qs) => new Request('https://fn.test/capture' + (qs || ''), { headers: { 'x-cron-secret': 'test-secret' } });
const allow = (extra) => () => res(200, Object.assign({ allowed: true, reason: 'allowed', request_id: '11111111-1111-1111-1111-111111111111', budget: { provider_remaining: null } }, extra || {}));
const deny = (reason) => () => res(200, { allowed: false, reason, request_id: null, retry_after: new Date(NOW + 600e3).toISOString() });

(async function main() {
  const M = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'capture', 'index.ts'));

  /* Q1 — a denial spends nothing */
  for (const reason of ['cache_fresh', 'coalesced', 'research_only', 'circuit_open', 'quota_exhausted', 'daily_budget', 'reserve_held']) {
    reset({ ledger: deny(reason) });
    const j = await (await M.handle(rq('?tier=day'))).json();
    chk('Q1 ' + reason + ': ok:true, skipped, with the reason', j.ok === true && j.skipped === true && j.reason === reason, j);
    chk('Q1 ' + reason + ': not one provider request', allProviderCalls() === 0, net.calls.map((c) => c.u));
  }
  reset({ ledger: deny('cache_fresh') });
  await M.handle(rq('?tier=near'));
  const ask = net.calls.find((c) => /odds_quota_acquire/.test(c.u));
  chk('Q1 the scheduled near tier asks under capture:near at critical priority', ask && ask.body.p_key === 'capture:near' && ask.body.p_priority === 'critical' && ask.body.p_est_cost > 0, ask && ask.body);

  /* Q2 — the ledger is not applied: fail open, in-run guard on */
  reset({ ledger: null });
  let j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q2 a missing ledger fails open and says so', j.quota_guard && j.quota_guard.ledger === 'missing' && j.quota_guard.decision === 'ledger_missing', j.quota_guard);
  chk('Q2 every configured sport is requested once', oddsCalls() === 3, oddsCalls());
  chk('Q2 the run guard reports what it spent', j.quota_guard.run.spent === 18 && j.quota_guard.run.stopped === null, j.quota_guard.run);
  chk('Q2 nothing is settled without a ledger ticket', net.settles.length === 0);

  /* Q3 — 429 on the first sport stops the run */
  reset({ ledger: allow(), oddsStatus: { americanfootball_nfl: { status: 429, body: 'Too many requests' } } });
  j = await (await M.handle(rq('?tier=day'))).json();
  chk('Q3 a 429 stops the run: one board request, no second sport', oddsCalls() === 1, net.calls.map((c) => c.u.replace(/apiKey=[^&]+/, '')));
  chk('Q3 no alternate ladder or prop request after a 429', net.eventCalls === 0, net.eventCalls);
  chk('Q3 the run says why it stopped and which sports it did not request', j.quota_guard.run.stopped === 'provider_rate_limited'
    && j.quota_guard.run.sports_not_requested.length === 2, j.quota_guard.run);
  chk('Q3 the ledger is settled RATE_LIMITED with the provider’s status', net.settles.length === 1 && net.settles[0].p_status === 'RATE_LIMITED' && net.settles[0].p_http === 429, net.settles);

  /* Q4 — the provider floor */
  reset({ ledger: allow(), oddsRemaining: '1003' });
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q4 under the floor the run stops after the balance is reported', oddsCalls() === 1 && j.quota_guard.run.stopped === 'quota_floor', [oddsCalls(), j.quota_guard.run]);
  reset({ ledger: allow({ budget: { provider_remaining: 900 } }) });
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q4 a balance the ledger already knows is under the floor buys nothing', oddsCalls() === 0 && j.quota_guard.run.stopped === 'quota_floor', [oddsCalls(), j.quota_guard.run]);

  /* Q5 — three timeouts open the circuit */
  reset({ ledger: allow(), timeouts: true });
  ENV.CAPTURE_SPORTS = 'americanfootball_nfl,americanfootball_ncaaf,basketball_nba,baseball_mlb,icehockey_nhl';
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q5 three consecutive timeouts open the circuit; the rest are not requested', oddsCalls() === 3 && j.quota_guard.run.stopped === 'circuit_open'
    && j.quota_guard.run.sports_not_requested.length === 2, [oddsCalls(), j.quota_guard.run]);
  chk('Q5 settled TIMEOUT', net.settles[0] && net.settles[0].p_status === 'TIMEOUT', net.settles);
  ENV.CAPTURE_SPORTS = 'americanfootball_nfl,americanfootball_ncaaf,basketball_nba';

  /* Q6 — exhausted quota */
  reset({ ledger: allow(), oddsStatus: { americanfootball_nfl: { status: 401, body: 'Usage quota has been reached' } }, oddsRemaining: '0' });
  j = await (await M.handle(rq('?tier=day'))).json();
  chk('Q6 an exhausted quota stops the run at the first answer', oddsCalls() === 1 && j.quota_guard.run.stopped === 'provider_quota_exhausted', j.quota_guard.run);
  chk('Q6 settled QUOTA_EXHAUSTED', net.settles[0] && net.settles[0].p_status === 'QUOTA_EXHAUSTED', net.settles);

  /* Q7 — a reader-triggered refresh */
  reset({ ledger: deny('cache_fresh') });
  j = await (await M.handle(rq('?tier=near&reason=board_refresh&sport=americanfootball_ncaaf'))).json();
  const ask7 = net.calls.find((c) => /odds_quota_acquire/.test(c.u));
  chk('Q7 a refresh asks under the near tier’s key at low priority (never the reserve)', ask7.body.p_key === 'capture:near' && ask7.body.p_priority === 'low' && ask7.body.p_caller === 'edgedesk_ai', ask7.body);
  chk('Q7 right after a scheduled run it is answered from the stored board', j.skipped === true && j.reason === 'cache_fresh' && allProviderCalls() === 0, j);

  /* Q8 — API access resumes: allowed again, settled OK */
  reset({ ledger: allow() });
  j = await (await M.handle(rq('?tier=day'))).json();
  chk('Q8 after recovery the run is allowed and settles OK (which closes the ledger’s breaker)', net.settles.length === 1 && ['OK', 'PARTIAL'].indexOf(net.settles[0].p_status) >= 0 && j.quota_guard.run.stopped === null, [net.settles, j.quota_guard.run]);
  chk('Q8 the settle carries the provider’s balance', net.settles[0].p_remaining === 5000, net.settles[0]);

  /* Q9 — the two functions classify failures alike */
  const S = os.tmpdir(), stub = path.join(fs.mkdtempSync(path.join(S, 'closechk-')), 'close.ts');
  fs.writeFileSync(stub, fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'close', 'index.ts'), 'utf8')
    .replace(/^import \{ createClient \} from "https:\/\/esm\.sh\/@supabase\/supabase-js@2";/m, 'const createClient = (..._a: any[]): any => ({});'));
  const prevServe = globalThis.Deno.serve; globalThis.Deno.serve = () => {};
  const C = await import(stub);
  globalThis.Deno.serve = prevServe;
  const cases = [[200, '', '500'], [200, '', '0'], [429, 'slow down', '10'], [401, 'Usage quota has been reached', ''], [401, 'Invalid API key', '100'], [402, 'credits', ''], [403, 'forbidden', '5'], [404, 'unknown sport', '10'], [422, 'bad', '']];
  cases.forEach((c) => {
    const a = M.classifyOddsFailure(c[0], c[1], c[2]), b = C.closeQuotaStop(c[0], c[1], c[2]);
    const stops = (x) => x === 'RATE_LIMITED' || x === 'QUOTA_EXHAUSTED' || x === 'AUTH_FAILED' ? x : null;
    chk('Q9 capture and close agree on HTTP ' + c[0] + ' "' + c[1] + '"', stops(a) === b, [a, b]);
  });
  chk('Q9 a timeout is a TIMEOUT, a 5xx a FAILED (counted toward the circuit, not an instant stop)', M.classifyOddsFailure(0, 'TIMEOUT after 20000 ms', '') === 'TIMEOUT' && M.classifyOddsFailure(503, '', '') === 'FAILED');

  /* Q10 — diagnostics never buy ladders */
  reset({ ledger: allow() });
  ENV.CAPTURE_SPORTS = 'americanfootball_nfl';
  j = await (await M.handle(rq('?diag=1'))).json();
  chk('Q10 ?diag=1 buys no alternate ladder', net.eventCalls === 0, net.eventCalls);
  const ask10 = net.calls.find((c) => /odds_quota_acquire/.test(c.u));
  chk('Q10 a diagnostic is still metered, at low priority', ask10 && ask10.body.p_key === 'capture:diag' && ask10.body.p_priority === 'low', ask10 && ask10.body);

  /* the pure guard */
  const g = M.makeRunGuard(20, 100, 3);
  chk('guard: the per-run credit cap', M.guardCanSpend(g, 12) && (g.spent = 12, !M.guardCanSpend(g, 12)) && g.stopped === 'credit_budget', g);
  const g2 = M.makeRunGuard(1000, 100, 3, '150');
  chk('guard: the floor from the ledger’s known balance', !M.guardCanSpend(g2, 60) && g2.stopped === 'quota_floor', g2);
  done();
})().catch((e) => { chk('the suite ran', false, String(e && e.stack || e).slice(0, 800)); done(); });

#!/usr/bin/env node
/* ===========================================================================
   THE QUOTA GUARD, end to end, on the DEPLOYED capture function (imported
   under Node with a Deno shim, as tools/capture/capture.test.js does) and the
   close function's stop rule. Nothing reaches a network.

   Since 2026-10-10 every odds request goes through ONE gateway
   (supabase/functions/odds_gateway, supabase/odds_api_gateway.sql): capture
   and close hold no provider key, and the shared budget, breaker, single
   flight and cache-first intervals live there (docs/odds-api-incident-2026-10).
   These are docs/market-resilience's quota-guard scenarios, held against that
   design. The gateway is scripted here; its own behaviour (budget under
   concurrency, the breaker tripping on a quota 429, bounded retries) is proven
   on PostgreSQL in tools/odds/gateway_sql.test.js and gateway_fn.test.js.

     Q1  a gateway refusal (cache hit, in flight, breaker, no budget, an
         unconfirmed quota, daily budget, the reserve, a cooldown) → ok:true,
         nothing bought, and NOT ONE request to the provider
     Q2  the control plane missing or the gateway unreachable → FAIL CLOSED:
         nothing is bought, the run says why (never a silent direct call)
     Q3  HTTP 429 on the first sport → no further sport, ladder or prop is
         asked for this run
     Q4  the provider's reserve (denied_reserve) → that request buys nothing,
         and the run is not reported as a failure
     Q5  provider timeouts → reported per sport; once the gateway opens its
         cooldown the run stops asking
     Q6  401 "usage quota reached", the monthly ceiling or the 95% emergency →
         the run stops at that answer
     Q7  a reader-triggered refresh (the desk's quote refresh) asks for the
         near tier of ONE sport, and inside its interval buys nothing
     Q8  a recovered provider → the next run is granted and buys exactly once
     Q9  close and capture stop on the same gateway answers
     Q10 ?diag=1 never asks for alternate ladders
     and every scenario: capture never names the provider host

   Run: node tools/resilience/quota_guard.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'quota guard — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const SPORTS = 'americanfootball_nfl,americanfootball_ncaaf,baseball_mlb';
const ENV = {
  CRON_SECRET: 'test-secret', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  CAPTURE_NO_SERVE: '1', CAPTURE_SPORTS: SPORTS, CAPTURE_AUTO_PREFIXES: '', CAPTURE_PLAYER_PROPS: 'true'
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

/* the gateway's envelope: what odds_gateway answers (supabase/functions/odds_gateway) */
const granted = (data, cost) => ({ ok: true, decision: 'granted', source: 'provider', fresh: true, new_for_consumer: true, fetched_at: new Date(NOW).toISOString(),
  age_seconds: 0, data, status: 200, quota: { remaining: 5000, used: 100, last: cost }, cost });
const refused = (decision, over) => Object.assign({ ok: false, decision, source: 'none', fresh: false, new_for_consumer: false, fetched_at: null, age_seconds: null,
  data: null, status: 0, quota: {}, cost: 0, reason: decision }, over || {});
const failed = (status, detail) => ({ ok: false, decision: status ? 'provider_http_' + status : 'provider_timeout', source: 'none', fresh: false, new_for_consumer: false,
  fetched_at: null, age_seconds: null, data: null, status, quota: { remaining: status === 401 ? 0 : 4000 }, cost: 0, reason: detail || '' });
const cacheHit = (data, isNew) => ({ ok: true, decision: 'cache_hit', source: 'cache', fresh: true, new_for_consumer: !!isNew, fetched_at: new Date(NOW - 300e3).toISOString(),
  age_seconds: 300, data, status: 200, quota: { remaining: 5000 }, cost: 0 });

let net;
function reset(script) {
  /* script(q, n) → an envelope, or a Response-like to answer at the HTTP level */
  net = { calls: [], gw: [], script: script || ((q) => q.category === 'featured' ? granted([event(q.sport_key)], 3) : granted(event(q.sport_key), 1)) };
}
globalThis.fetch = async function (url, init) {
  const u = String(url), method = (init && init.method) || 'GET', body = init && init.body ? JSON.parse(init.body) : null;
  net.calls.push({ u, method, body });
  if (/the-odds-api\.com/.test(u)) return res(500, 'a direct provider call from capture');
  if (u.indexOf('/functions/v1/odds_gateway') >= 0) {
    net.gw.push(body);
    const out = net.script(body, net.gw.length);
    return out && typeof out.status === 'number' && typeof out.text === 'function' ? out : res(200, out);
  }
  if (u.indexOf('/rest/v1/rpc/odds_api_job_lock') >= 0) return res(200, true);
  if (u.indexOf('sb.test') >= 0) return res(200, [], { 'content-range': '*/0' });
  return res(404, 'nope');
};
const providerCalls = () => net.calls.filter((c) => /the-odds-api\.com/.test(c.u)).length;
const boardAsks = () => net.gw.filter((b) => b.category === 'featured').length;
const ladderOrPropAsks = () => net.gw.filter((b) => b.category === 'alternates' || /^props/.test(String(b.category))).length;
const rq = (qs) => new Request('https://fn.test/capture' + (qs || ''), { headers: { 'x-cron-secret': 'test-secret' } });

(async function main() {
  const M = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'capture', 'index.ts'));

  /* Q1 — a refusal spends nothing */
  const perRequest = ['in_flight', 'denied_daily_budget', 'denied_reserve', 'skipped_window'];
  const runWide = ['denied_breaker', 'denied_no_budget', 'denied_unconfirmed_quota', 'denied_cooldown'];
  for (const d of perRequest.concat(runWide)) {
    reset(() => refused(d));
    const j = await (await M.handle(rq('?tier=day'))).json();
    chk('Q1 ' + d + ': ok:true and nothing bought', j.ok === true && Number(j.quota_spent_this_run) === 0, [j.ok, j.status, j.quota_spent_this_run]);
    chk('Q1 ' + d + ': not one provider request', providerCalls() === 0, net.calls.map((c) => c.u));
    if (runWide.indexOf(d) >= 0) chk('Q1 ' + d + ' is account-wide: the next sports are not asked', boardAsks() === 1, boardAsks());
    else chk('Q1 ' + d + ' is one request\'s answer: every sport is still asked', boardAsks() === 3, boardAsks());
  }
  reset((q) => q.category === 'featured' ? cacheHit([event(q.sport_key)], false) : refused('skipped_window'));
  let j = await (await M.handle(rq('?tier=near'))).json();
  chk('Q1 a snapshot capture already wrote (cache hit): served from cache, nothing bought', j.ok === true && Number(j.quota_spent_this_run) === 0
    && j.gateway && j.gateway.served_from_cache.length === 3 && providerCalls() === 0, j.gateway);

  /* Q2 — the control plane missing / the gateway unreachable: fail CLOSED */
  reset(() => refused('denied_gateway_error', { reason: 'gateway error (fail closed): function public.odds_api_acquire(jsonb) does not exist' }));
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q2 the gateway SQL not applied: nothing bought, no provider request, the run is not "ok"', Number(j.quota_spent_this_run) === 0 && providerCalls() === 0 && j.status !== 'ok', [j.status, providerCalls()]);
  reset(() => res(404, '<html>Function not found</html>'));
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q2 the gateway not deployed (404): nothing bought, no provider request, and the run says so', Number(j.quota_spent_this_run) === 0 && providerCalls() === 0
    && j.status !== 'ok' && JSON.stringify(j).indexOf('gateway_unreachable') >= 0, [j.status, providerCalls()]);

  /* Q3 — a 429 on the first sport stops the run */
  reset((q, n) => n === 1 ? failed(429, 'Too many requests') : granted(q.category === 'featured' ? [event(q.sport_key)] : event(q.sport_key), 3));
  j = await (await M.handle(rq('?tier=day'))).json();
  chk('Q3 a 429 stops the run: one board asked, no second sport', boardAsks() === 1, net.gw.map((b) => b.category + ':' + b.sport_key));
  chk('Q3 no alternate ladder or prop is asked after a 429', ladderOrPropAsks() === 0, ladderOrPropAsks());
  chk('Q3 the run says which sports it did not ask, and why', j.gateway && j.gateway.skipped.filter((x) => /not asked/.test(x.reason) && x.decision === 'provider_http_429').length === 2, j.gateway && j.gateway.skipped);
  chk('Q3 no provider request from capture', providerCalls() === 0);

  /* Q4 — the reserve */
  reset((q) => q.category === 'featured' && q.sport_key === 'baseball_mlb' ? refused('denied_reserve') : (q.category === 'featured' ? granted([event(q.sport_key)], 3) : granted(event(q.sport_key), 1)));
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q4 a request the reserve refuses buys nothing and the run is not a failure', boardAsks() === 3 && ['ok', 'partial'].indexOf(j.status) >= 0
    && j.gateway.skipped.some((x) => x.sport === 'baseball_mlb' && x.decision === 'denied_reserve'), [j.status, j.gateway && j.gateway.skipped]);

  /* Q5 — timeouts, then the gateway's cooldown */
  ENV.CAPTURE_SPORTS = SPORTS + ',icehockey_nhl,basketball_nba';
  reset((q, n) => q.category !== 'featured' ? refused('skipped_window') : (n <= 2 ? failed(0, 'TIMEOUT after 20000 ms') : refused('denied_cooldown', { reason: 'provider cooling down: 5 consecutive failures' })));
  j = await (await M.handle(rq('?tier=board'))).json();
  chk('Q5 each timeout is reported on its sport; the cooldown stops the run (no fourth ask)', boardAsks() === 3 && j.status !== 'ok'
    && j.gateway.skipped.filter((x) => /not asked/.test(x.reason)).length === 2, [boardAsks(), j.status, j.gateway && j.gateway.skipped]);
  ENV.CAPTURE_SPORTS = SPORTS;

  /* Q6 — an exhausted quota, the ceiling, the emergency */
  for (const env of [failed(401, 'Usage quota has been reached'), refused('denied_ceiling'), refused('denied_emergency')]) {
    reset((q, n) => n === 1 ? env : granted([event(q.sport_key)], 3));
    j = await (await M.handle(rq('?tier=day'))).json();
    chk('Q6 ' + env.decision + ' stops the run at the first answer', boardAsks() === 1 && ladderOrPropAsks() === 0 && Number(j.quota_spent_this_run) === 0, [boardAsks(), j.quota_spent_this_run]);
  }

  /* Q7 — the desk's quote refresh */
  reset((q) => q.category === 'featured' ? cacheHit([event(q.sport_key)], false) : refused('skipped_window'));
  j = await (await M.handle(rq('?tier=near&reason=board_refresh&sport=americanfootball_ncaaf'))).json();
  chk('Q7 a refresh asks for exactly the one sport, under the near tier', boardAsks() === 1 && net.gw[0].sport_key === 'americanfootball_ncaaf'
    && /^capture:near$/.test(net.gw[0].caller) && net.gw[0].trigger === 'board_refresh', net.gw.map((b) => [b.caller, b.trigger, b.sport_key]));
  chk('Q7 inside the interval it is answered from the stored board: nothing bought', Number(j.quota_spent_this_run) === 0 && providerCalls() === 0, j.quota_spent_this_run);

  /* Q8 — recovery */
  reset((q) => q.category === 'featured' ? granted([event(q.sport_key)], 3) : refused('skipped_window'));
  j = await (await M.handle(rq('?tier=day'))).json();
  chk('Q8 after recovery the run is granted, buys each board once and reports the provider\'s balance', j.status === 'ok' && boardAsks() === 3
    && Number(j.quota_spent_this_run) === 9 && String(j.quota_remaining) === '5000', [j.status, boardAsks(), j.quota_spent_this_run, j.quota_remaining]);

  /* Q9 — close and capture stop on the same answers */
  const stub = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'closechk-')), 'close.ts');
  fs.writeFileSync(stub, fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'close', 'index.ts'), 'utf8')
    .replace(/^import \{ createClient \} from "https:\/\/esm\.sh\/@supabase\/supabase-js@2";/m, 'const createClient = (..._a: any[]): any => ({});'));
  const prevServe = globalThis.Deno.serve; globalThis.Deno.serve = () => {};
  const C = await import(stub);
  globalThis.Deno.serve = prevServe;
  const decisions = ['granted', 'cache_hit', 'in_flight', 'skipped_live', 'skipped_window', 'denied_daily_budget', 'denied_reserve', 'denied_category',
    'denied_breaker', 'denied_gateway_disabled', 'denied_no_budget', 'denied_unconfirmed_quota', 'denied_ceiling', 'denied_emergency', 'denied_cooldown',
    'provider_http_429', 'provider_http_401', 'provider_http_402', 'provider_http_403', 'provider_http_404', 'provider_http_503', 'provider_timeout',
    'gateway_unreachable', 'gateway_unreachable: HTTP 404', 'denied_gateway_error'];
  decisions.forEach((d) => chk('Q9 capture and close agree on "' + d + '"', M.gatewayRunStop(d) === C.closeGatewayStop(d), [M.gatewayRunStop(d), C.closeGatewayStop(d)]));
  chk('Q9 the account-wide answers stop; per-request answers and transient failures never do',
    ['denied_breaker', 'denied_no_budget', 'denied_cooldown', 'provider_http_429', 'provider_http_401'].every((d) => M.gatewayRunStop(d))
    && ['cache_hit', 'denied_daily_budget', 'denied_reserve', 'provider_http_503', 'provider_timeout', 'gateway_unreachable'].every((d) => M.gatewayRunStop(d) === null));

  /* Q10 — diagnostics never buy ladders */
  ENV.CAPTURE_SPORTS = 'americanfootball_nfl';
  reset();
  j = await (await M.handle(rq('?diag=1'))).json();
  chk('Q10 ?diag=1 asks for no alternate ladder and no prop', ladderOrPropAsks() === 0, net.gw.map((b) => b.category));
  ENV.CAPTURE_SPORTS = SPORTS;

  /* the design: capture holds no provider key and never names the host */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'capture', 'index.ts'), 'utf8');
  chk('capture never names the provider host or reads its key', !/api\.the-odds-api\.com/.test(src) && !/Deno\.env\.get\(\s*["'](ODDS_API_KEY|THE_ODDS_API_KEY)["']/.test(src));
  done();
})().catch((e) => { chk('the suite ran', false, String(e && e.stack || e).slice(0, 800)); done(); });

#!/usr/bin/env node
/* ===========================================================================
   THE ODDS GATEWAY, END TO END — with a real PostgreSQL and NO paid call.

   supabase/functions/odds_gateway/index.ts is imported as deployed. Its two
   outbound doors are both intercepted:

     the provider       a mock The Odds API that counts every request, can be
                        slow, can answer 503 / 429 / 401 or hang, and reports
                        x-requests-used / -remaining / -last like the real one
     the database       every PostgREST RPC is executed against a throwaway
                        PostgreSQL that has supabase/odds_api_emergency_stop.sql
                        and supabase/odds_api_gateway.sql applied — the same
                        functions production runs, concurrently, in separate
                        sessions (one psql per RPC), so the row lock, the
                        reservations and the single-flight lease are real

   What it proves (docs/odds-api-incident-2026-10/INCIDENT.md, Phase 9):
     1  many concurrent readers / workers asking for one board → ONE fetch
     2  overlapping cron runs collapse into one fetch per sport
     3  player-prop refreshes: one fetch per event per cadence window
     4  a 503 is retried with bounded backoff; a timeout is never retried
     5  a quota 429 trips the breaker and is never retried; a rate 429 cools down
     6  cache hits consume zero credits
     7  the breaker blocks every category; the last snapshot is served as STALE
     8  the monthly emergency threshold trips the breaker and blocks everything
     9  reservations never overrun the daily allowance under concurrency, and
        reconciliation against x-requests-last gives the difference back
    10  live and completed events are never polled
    11  the key never reaches an envelope or the ledger
   Without a PostgreSQL binary the suite says so and exits 0 (static checks in
   tools/odds/no_bypass.test.js still run everywhere).

   Run: node tools/odds/gateway_fn.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('odds gateway (end to end)');
const ROOT = PG.ROOT;
const KEY = 'feedfacecafebeef0123456789abcdef';

const db = PG.start('oddsgw');
if (db.skip) {
  /* ODDS_SQL_REQUIRED=1 (CI) makes a missing PostgreSQL a failure, never a silent pass */
  if (process.env.ODDS_SQL_REQUIRED === '1') { T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip); process.exit(T.done()); }
  console.log('NOTE | ' + db.skip + ' — the end-to-end gateway suite did not run'); process.exit(0);
}

/* ── the control plane ─────────────────────────────────────────────────── */
db.sql("create schema if not exists cron; create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);"
  + " create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null) returns void language sql as $$ update cron.job set active = coalesce(alter_job.active, cron.job.active) where jobid = job_id $$;"
  + " create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;");
db.applyFile(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'));
db.applyFile(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'));

/* an async psql per RPC: real concurrency, real sessions */
function q(sql) {
  return new Promise((resolve, reject) => {
    cp.execFile(path.join(db.bin, 'psql'), ['-h', db.home, '-p', String(db.port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message))) : resolve(String(out).trim())));
  });
}
const lit = (v) => (v == null ? 'null' : typeof v === 'object' ? "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb"
  : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
async function rpc(fn, args) {
  const named = Object.keys(args || {}).map((k) => k + ' => ' + lit(args[k])).join(', ');
  const out = await q('select public.' + fn + '(' + named + ')');
  if (out === 't') return true; if (out === 'f') return false; if (out === '') return null;
  try { return JSON.parse(out); } catch (_) { return out; }
}

/* ── the mock provider ─────────────────────────────────────────────────── */
const P = { calls: [], used: 1000, remaining: 99000, delayMs: 0, plan: [], boards: {}, events: {} };
function providerAnswer(u) {
  P.calls.push(u);
  const step = P.plan.length ? P.plan.shift() : null;
  if (step && step.hang) return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })), step.hang));
  if (step && step.throwNetwork) return Promise.reject(new TypeError('fetch failed'));
  if (step && step.status) {
    const h = { 'x-requests-used': String(P.used), 'x-requests-remaining': String(step.remaining != null ? step.remaining : P.remaining), 'x-requests-last': '0' };
    return Promise.resolve(resp(step.status, step.body || 'upstream said no', h));
  }
  const m = /\/sports\/([^/]+)\/events\/([^/?]+)\/odds/.exec(u) || [];
  const s = /\/sports\/([^/]+)\/odds/.exec(u) || [];
  const mk = decodeURIComponent((/[?&]markets=([^&]*)/.exec(u) || [])[1] || '').split(',').filter(Boolean);
  let body, cost;
  /* billed like the provider: unique markets RETURNED (of those asked) x 1 region-equivalent */
  const returned = (evs) => new Set([].concat(...evs.map((ev) => [].concat(...(ev.bookmakers || []).map((b) => (b.markets || []).map((x) => x.key)))))
    .filter((k) => mk.indexOf(k) >= 0)).size;
  if (m[2]) { body = P.events[decodeURIComponent(m[2])] || { id: decodeURIComponent(m[2]), bookmakers: [] }; cost = returned([body]); }
  else if (s[1]) { body = P.boards[decodeURIComponent(s[1])] || []; cost = returned(body); }
  else if (/\/sports\/\?/.test(u)) { body = [{ key: 'americanfootball_nfl', active: true }]; cost = 0; }
  else { body = []; cost = 0; }
  P.used += cost; P.remaining -= cost;
  const h = { 'x-requests-used': String(P.used), 'x-requests-remaining': String(P.remaining), 'x-requests-last': String(cost) };
  return new Promise((r) => setTimeout(() => r(resp(200, body, h)), P.delayMs));
}
function resp(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => headers[String(n).toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) };
}

const SB = 'https://sb.test';
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.indexOf('api.the-odds-api.com') >= 0) return providerAnswer(u);
  const m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u);
  if (m && u.indexOf(SB) === 0) {
    try { const out = await rpc(m[1], init && init.body ? JSON.parse(init.body) : {}); return resp(200, out === null ? '' : out, {}); }
    catch (e) { return resp(500, String(e.message).slice(0, 300), {}); }
  }
  return resp(404, 'unexpected ' + u, {});
};

const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'svc', ODDS_GATEWAY_PROVIDER_KEY: KEY, ODDS_GATEWAY_NO_SERVE: '1' };
const envGet = (k) => ENV[k];
globalThis.Deno = { env: { get: envGet } };

const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const book = (key, markets) => ({ key, last_update: iso(Date.now() - 60000), markets: markets.map((k) => ({ key: k, outcomes: [{ name: 'A', price: 1.9 }, { name: 'B', price: 1.9 }] })) });
const board = (n, hours) => Array.from({ length: n }, (_, i) => ({ id: 'ev' + i + '_' + hours, sport_key: 'x', commence_time: iso(Date.now() + (hours + i) * H), home_team: 'H' + i, away_team: 'A' + i,
  bookmakers: [book('pinnacle', ['h2h', 'spreads', 'totals']), book('draftkings', ['h2h', 'spreads', 'totals'])] }));

async function enable(budget) {
  await q("select public.odds_api_set_budget(" + (budget ? budget.join(',') : '60000, 40000, 1500') + ")");
  await q("select public.odds_api_set_enabled(true, 'test enable')");
  await q("select public.odds_api_confirm_quota(" + P.used + ", " + P.remaining + ", 'test')");
}
async function reset() {
  P.calls.length = 0; P.plan.length = 0; P.delayMs = 0; P.used = 1000; P.remaining = 99000;
  await q("truncate public.odds_api_requests, public.odds_api_snapshots, public.odds_api_events, public.odds_api_alerts, public.odds_api_consumer_marks, public.odds_api_job_locks restart identity;"
    + " update public.odds_api_config set provider_cooldown_until = null, cooldown_reason = null, consecutive_failures = 0, untracked_baseline = null, untracked_baseline_cycle = null, provider_observed_at = null where id = 1;");
}
const ledger = async (where) => JSON.parse(await q("select coalesce(json_agg(r order by id), '[]') from (select id, caller, category, decision, status, dispatched, reserved_credits, actual_credits, cost_is_exact, http_status, error from public.odds_api_requests" + (where ? ' where ' + where : '') + ") r"));
const spent = async () => Number(await q("select coalesce(sum(coalesce(actual_credits, reserved_credits)), 0) from public.odds_api_requests where dispatched"));

(async () => {
  let G;
  try { G = await import(path.join(ROOT, 'supabase', 'functions', 'odds_gateway', 'index.ts')); }
  catch (e) { T.chk('the deployed gateway loads under Node', false, e.message); db.stop(); process.exit(T.done()); }
  T.chk('the deployed gateway loads under Node', typeof G.serve === 'function' && typeof G.handle === 'function');
  const zero = () => 0;   /* backoff jitter pinned low: the suite stays fast */
  const ask = (req) => G.serve(Object.assign({ caller: 'test' }, req), envGet, zero);

  try {
    /* ── 0 · fail closed out of the box ──────────────────────────────────── */
    await reset();
    P.boards.americanfootball_nfl = board(3, 2);
    let e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('0 · out of the box the breaker is OFF: no provider call', e.decision === 'denied_breaker' && P.calls.length === 0 && e.source === 'none', e);
    await q("select public.odds_api_set_enabled(true, 'x')");
    T.chk('0 · the breaker cannot be turned on without a budget', (await q("select odds_api_enabled from public.odds_api_config")) === 'f');
    await q("select public.odds_api_set_budget(60000, 40000, 1500); select public.odds_api_set_enabled(true, 'x');");
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('0 · a new cycle waits for a provider-confirmed quota', e.decision === 'denied_unconfirmed_quota' && P.calls.length === 0, e.decision);

    /* ── 1 · many concurrent askers, ONE fetch ───────────────────────────── */
    await reset(); await enable();
    P.delayMs = 1200;
    const many = await Promise.all(Array.from({ length: 25 }, (_, i) => ask({ caller: 'reader' + i, category: i % 2 ? 'close' : 'featured', sport_key: 'americanfootball_nfl', consumer: 'c' + i })));
    const providerHits = P.calls.filter((u) => /\/sports\/americanfootball_nfl\/odds/.test(u)).length;
    T.chk('1 · 25 concurrent requests for one board (capture and close mixed) make ONE provider call', providerHits === 1, P.calls.length);
    T.chk('1 · and every one of them gets the data', many.every((x) => x.ok && Array.isArray(x.data) && x.data.length === 3), many.map((x) => x.decision));
    T.chk('1 · one is the purchase, the rest are cache or collapsed', many.filter((x) => x.source === 'provider').length === 1 && many.filter((x) => x.source === 'cache').length === 24, many.map((x) => x.source));
    const l1 = await ledger();
    T.chk('1 · the ledger records every decision, and exactly one dispatch', l1.length === 25 && l1.filter((r) => r.dispatched).length === 1, l1.map((r) => r.decision));
    T.chk('1 · the purchase cost what the provider said (x-requests-last)', l1.find((r) => r.dispatched).actual_credits === 3 && l1.find((r) => r.dispatched).cost_is_exact === true);

    /* ── 2 · overlapping cron runs ───────────────────────────────────────── */
    await reset(); await enable();
    P.delayMs = 400; P.boards.americanfootball_ncaaf = board(5, 30);
    const run = (caller) => Promise.all(['americanfootball_nfl', 'americanfootball_ncaaf'].map((s) => ask({ caller, category: 'featured', sport_key: s, consumer: 'capture' })));
    await Promise.all([run('capture:near'), run('capture:day'), run('github:capture:day')]);
    T.chk('2 · three overlapping capture runs buy each sport once', P.calls.length === 2, P.calls);
    const again = await run('capture:near');
    T.chk('2 · a run inside the cadence window is all cache, and capture is told it already has it',
      P.calls.length === 2 && again.every((x) => x.source === 'cache' && x.new_for_consumer === false), again.map((x) => [x.source, x.new_for_consumer]));
    T.chk('2 · cache hits cost nothing', (await spent()) === 6, await spent());

    /* ── 3 · player props: one fetch per event per window ─────────────────── */
    await reset(); await enable();
    P.delayMs = 0;
    const evs = ['p1', 'p2', 'p3'];
    evs.forEach((id, i) => { P.events[id] = { id, commence_time: iso(Date.now() + (2 + i * 10) * H), bookmakers: [book('draftkings', ['player_pass_yds', 'player_rush_yds'])] }; });
    const askProps = (id, i, who) => ask({ caller: who, consumer: who, category: 'props', sport_key: 'americanfootball_nfl', event_id: id, commence_time: P.events[id].commence_time, odds_format: 'american' });
    await Promise.all(evs.map((id, i) => askProps(id, i, 'props_capture')));
    await Promise.all(evs.map((id, i) => askProps(id, i, 'capture_props')));
    await Promise.all(evs.map((id, i) => askProps(id, i, 'props_capture')));
    T.chk('3 · three events, asked three times by two pipelines: three provider calls', P.calls.length === 3, P.calls.length);
    T.chk('3 · props request the core market set, not 59 markets', P.calls.every((u) => decodeURIComponent((/markets=([^&]*)/.exec(u) || [])[1]).split(',').length === 11), P.calls[0]);
    T.chk('3 · props are billed at markets RETURNED (2 x 1 region-equivalent per event)', (await spent()) === 6, await spent());
    e = await ask({ category: 'props_alt', sport_key: 'americanfootball_nfl', event_id: 'p1', commence_time: P.events.p1.commence_time });
    T.chk('3 · alternate player ladders are refused by default', e.decision === 'denied_category' && P.calls.length === 3, e.decision);
    P.events.far = { id: 'far', commence_time: iso(Date.now() + 70 * H), bookmakers: [book('draftkings', ['player_pass_yds'])] };
    e = await ask({ category: 'props', sport_key: 'americanfootball_nfl', event_id: 'far', commence_time: P.events.far.commence_time });
    T.chk('3 · NFL props beyond 48 h are not polled at all', e.decision === 'skipped_window' && P.calls.length === 3, e.decision);
    P.events.cfb1 = { id: 'cfb1', commence_time: iso(Date.now() + 30 * H), bookmakers: [book('draftkings', ['player_pass_yds'])] };
    e = await ask({ category: 'props', sport_key: 'americanfootball_ncaaf', event_id: 'cfb1', commence_time: P.events.cfb1.commence_time });
    T.chk('3 · college props beyond 24 h are not polled', e.decision === 'skipped_window', e.decision);

    /* ── 4 · temporary failures: bounded backoff; timeouts never retried ──── */
    await reset(); await enable();
    P.boards.americanfootball_nfl = board(2, 5);
    P.plan.push({ status: 503 });
    let t0 = Date.now();
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('4 · a 503 is retried, and the retry succeeds', e.ok && e.source === 'provider' && e.attempts === 2 && P.calls.length === 2, [e.decision, e.attempts, P.calls.length]);
    T.chk('4 · after a backoff (not a hot loop)', Date.now() - t0 >= 700, Date.now() - t0);
    let l = await ledger();
    T.chk('4 · each attempt was its own reservation; the failed one is charged its header (0)', l.length === 2 && l[0].status === 'failed' && l[0].http_status === 503 && l[0].actual_credits === 0 && l[1].status === 'settled', l);
    await reset(); await enable();
    P.plan.push({ status: 503 }, { status: 502 }, { status: 504 }, { status: 503 });
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('4 · retries are bounded: at most 3 attempts in all', P.calls.length === 3 && !e.ok, [P.calls.length, e.decision]);
    await reset(); await enable();
    ENV.ODDS_GATEWAY_TIMEOUT_MS = '2000';
    P.plan.push({ hang: 2500 });
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('4 · a timeout is NOT retried (the provider may already have billed it)', P.calls.length === 1 && e.decision === 'provider_timeout', [P.calls.length, e.decision]);
    l = await ledger('dispatched');
    T.chk('4 · and it is charged at the reservation, marked inexact', l.length === 1 && l[0].actual_credits === 3 && l[0].cost_is_exact === false, l);
    delete ENV.ODDS_GATEWAY_TIMEOUT_MS;

    /* ── 5 · 429: quota exhaustion trips; a rate limit cools down ─────────── */
    await reset(); await enable();
    P.plan.push({ status: 429, body: '{"message":"Usage quota has been reached","error_code":"OUT_OF_USAGE_CREDITS"}', remaining: 0 });
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('5 · a quota 429 is never retried', P.calls.length === 1 && e.decision === 'provider_429', [P.calls.length, e.decision]);
    T.chk('5 · and it trips the breaker', (await q("select odds_api_enabled from public.odds_api_config")) === 'f');
    e = await ask({ category: 'featured', sport_key: 'americanfootball_ncaaf' });
    T.chk('5 · after which nothing reaches the provider', e.decision === 'denied_breaker' && P.calls.length === 1, e.decision);
    await reset(); await enable();
    P.plan.push({ status: 429, body: '{"message":"Too many requests"}', remaining: 50000 });
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('5 · a rate-limit 429 is not retried either', P.calls.length === 1 && e.decision === 'provider_429');
    e = await ask({ category: 'featured', sport_key: 'americanfootball_ncaaf' });
    T.chk('5 · it cools paid calls down instead of tripping the breaker', e.decision === 'denied_cooldown' && P.calls.length === 1
      && (await q("select odds_api_enabled from public.odds_api_config")) === 't', e.decision);

    /* ── 6/7 · cache is free; the breaker serves the last snapshot as stale ── */
    await reset(); await enable();
    P.boards.americanfootball_nfl = board(3, 2);
    await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    const before = await spent();
    for (let i = 0; i < 10; i++) await ask({ category: 'featured', sport_key: 'americanfootball_nfl', caller: 'page-load-' + i });
    T.chk('6 · ten page loads after a purchase spend nothing and call nothing', (await spent()) === before && P.calls.length === 1);
    await q("update public.odds_api_snapshots set last_success_at = now() - interval '2 hours'");
    await q("select public.odds_api_set_enabled(false, 'test: breaker off')");
    const off = await Promise.all(['featured', 'close', 'collective', 'props', 'alternates'].map((c) =>
      ask({ category: c, sport_key: 'americanfootball_nfl', event_id: c === 'props' || c === 'alternates' ? 'p1' : undefined, commence_time: iso(Date.now() + 2 * H) })));
    T.chk('7 · breaker off: every category refused, no provider call', off.every((x) => x.decision === 'denied_breaker') && P.calls.length === 1, off.map((x) => x.decision));
    T.chk('7 · the last valid snapshot is served, labelled stale with its fetch time', off[0].ok && off[0].source === 'stale_cache' && off[0].fresh === false && off[0].age_seconds >= 7000 && off[0].data.length === 3, [off[0].source, off[0].age_seconds]);

    /* ── 8 · the monthly emergency threshold ─────────────────────────────── */
    await reset(); P.used = 0; P.remaining = 100000; await enable([100, 0, 100]);
    await q("insert into public.odds_api_requests (cycle_start, usage_day, caller, decision, dispatched, status, reserved_credits, actual_credits) values (public.odds_api_cycle_start(now()), (now() at time zone 'utc')::date, 'history', 'granted', true, 'settled', 94, 94)");
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('8 · a request that would pass 95% of the monthly budget trips the breaker', e.decision === 'denied_emergency' && P.calls.length === 0
      && (await q("select odds_api_enabled from public.odds_api_config")) === 'f', e.decision);
    const blocked = await Promise.all([ask({ category: 'featured', sport_key: 'americanfootball_ncaaf' }), ask({ category: 'props', sport_key: 'americanfootball_nfl', event_id: 'p1', commence_time: iso(Date.now() + H) })]);
    T.chk('8 · and then blocks every provider path', blocked.every((x) => x.decision === 'denied_breaker') && P.calls.length === 0, blocked.map((x) => x.decision));
    T.chk('8 · an emergency alert is on record', Number(await q("select count(*) from public.odds_api_alerts where level = 'emergency'")) >= 1);

    /* ── 9 · reservation and reconciliation under concurrency ─────────────── */
    await reset(); await enable([60000, 0, 60]);
    await q("update public.odds_api_config set day_weights = '{\"0\":1,\"1\":1,\"2\":1,\"3\":1,\"4\":1,\"5\":1,\"6\":1}'::jsonb");
    P.delayMs = 300;
    const ids = Array.from({ length: 20 }, (_, i) => 'r' + i);
    ids.forEach((id) => { P.events[id] = { id, commence_time: iso(Date.now() + 2 * H), bookmakers: [book('draftkings', ['player_pass_yds'])] }; });
    const burst = await Promise.all(ids.map((id) => ask({ category: 'props', sport_key: 'americanfootball_nfl', event_id: id, commence_time: P.events[id].commence_time })));
    const granted = burst.filter((x) => x.source === 'provider').length;
    const maxOpen = Number(await q("select coalesce(max(s), 0) from (select sum(reserved_credits) over (order by id) as s from public.odds_api_requests where dispatched) x"));
    /* allowance 60, props reserve 11 each; shedding admits priority-3 props only to 60%, i.e. 36 credits of reservations */
    T.chk('9 · 20 concurrent prop requests against a 60-credit day: reservations never pass the allowance', granted >= 1 && granted * 11 <= 60, [granted, maxOpen]);
    T.chk('9 · the rest are refused by the daily budget, not by a race', burst.filter((x) => x.decision === 'denied_daily_budget').length === 20 - granted, burst.map((x) => x.decision));
    T.chk('9 · reconciliation charges x-requests-last (1), not the reservation (11)', Number(await q("select sum(actual_credits) from public.odds_api_requests where dispatched")) === granted, await spent());
    const more = await ask({ category: 'props', sport_key: 'americanfootball_nfl', event_id: 'extra', commence_time: iso(Date.now() + 2 * H) });
    T.chk('9 · and the credits given back by reconciliation are spendable again', more.decision === 'granted' || more.source === 'provider', more.decision);

    /* ── 10 · live and completed events are never polled ─────────────────── */
    await reset(); await enable();
    await q("insert into public.odds_api_events (event_id, sport_key, commence_time) values ('live1', 'americanfootball_nfl', now() - interval '1 hour'), ('done1', 'americanfootball_nfl', now() - interval '9 hours')");
    const lv = await Promise.all(['live1', 'done1'].map((id) => ask({ category: 'props', sport_key: 'americanfootball_nfl', event_id: id })));
    T.chk('10 · an event in progress is skipped (live polling off)', lv[0].decision === 'skipped_live', lv[0].decision);
    T.chk('10 · a finished event is skipped', lv[1].decision === 'skipped_completed', lv[1].decision);
    const hinted = await ask({ category: 'alternates', sport_key: 'americanfootball_nfl', event_id: 'never-seen', commence_time: iso(Date.now() - 30 * 60000) });
    T.chk('10 · a caller\'s kickoff hint is enough to refuse a started game', hinted.decision === 'skipped_live' && P.calls.length === 0, hinted.decision);

    /* ── 11 · the key stays secret ───────────────────────────────────────── */
    await reset(); await enable();
    P.plan.push({ status: 401, body: '{"message":"API key ' + KEY + ' is not valid"}' });
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    const dump = JSON.stringify(e) + JSON.stringify(await ledger()) + (await q("select coalesce(string_agg(coalesce(error,''), ' '), '') from public.odds_api_requests"));
    T.chk('11 · a provider error echoing the key never reaches the envelope or the ledger', dump.indexOf(KEY) < 0 && /REDACTED/.test(dump), e.detail);
    T.chk('11 · and a 401 trips the breaker (a bad key is not retried in a loop)', (await q("select odds_api_enabled from public.odds_api_config")) === 'f');
    const r401 = await G.handle(new Request('https://fn.test/odds_gateway', { method: 'POST', body: '{}' }), envGet);
    T.chk('11 · the gateway refuses a caller without the service role', r401.status === 401);
    const ok200 = await G.handle(new Request('https://fn.test/odds_gateway', { method: 'POST', headers: { authorization: 'Bearer svc' }, body: JSON.stringify({ action: 'status' }) }), envGet);
    T.chk('11 · and answers the service role (status costs nothing)', ok200.status === 200 && P.calls.length === 1);

    /* ── 12 · the kill switch and a missing key ──────────────────────────── */
    await reset(); await enable();
    ENV.ODDS_GATEWAY_DISABLED = '1';
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('12 · ODDS_GATEWAY_DISABLED stops everything without the database', e.decision === 'denied_gateway_disabled' && P.calls.length === 0);
    delete ENV.ODDS_GATEWAY_DISABLED;
    const savedKey = ENV.ODDS_GATEWAY_PROVIDER_KEY; delete ENV.ODDS_GATEWAY_PROVIDER_KEY;
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('12 · no key: nothing requested, the lease settled at zero', e.decision === 'denied_no_key' && P.calls.length === 0 && (await spent()) === 0, e.decision);
    ENV.ODDS_GATEWAY_PROVIDER_KEY = savedKey;

    /* ── 13 · the database unreachable: fail closed ──────────────────────── */
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (/\/rest\/v1\/rpc\//.test(String(url)) ? resp(503, 'db down', {}) : realFetch(url, init));
    e = await ask({ category: 'featured', sport_key: 'americanfootball_nfl' });
    T.chk('13 · without its control plane the gateway buys nothing', e.decision === 'denied_gateway_error' && P.calls.length === 0, e.decision);
    globalThis.fetch = realFetch;
  } catch (err) {
    T.chk('the suite ran without an unexpected error', false, String(err && err.stack || err).slice(0, 900));
  } finally {
    db.stop();
  }
  process.exit(T.done());
})();

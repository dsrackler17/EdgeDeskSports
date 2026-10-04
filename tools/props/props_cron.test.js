#!/usr/bin/env node
/* ============================================================================
   THE PLAYER PROPS SCHEDULER AND MANUAL REFRESH, tested as deployed.

   supabase/functions/props_cron/index.ts is imported — not a copy — under
   Node's native type stripping with a Deno shim and a mocked network (the
   pattern of tools/editorial/editorial_cron.test.js). What is pinned:

     · a tick pokes the ONE pipeline only when a game is due (the health
       record's next_due_at), a reader's refresh is waiting, or the health
       record has gone quiet (fallback) — never on every tick
     · it never stampedes (debounce), and a missing token is never a success
     · a refresh needs a verified reader, is admitted atomically by the
       database (cool-downs, a double click joins the refresh in flight),
       carries its request id to the run, and every failure is recorded on
       the request and told to the reader in words
     · a workflow that predates the new inputs still runs (422 fallback)

   Run: node tools/props/props_cron.test.js
   ========================================================================== */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) { pass++; return true; } fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); return false; }

const ENV = {
  SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key',
  PROPS_GH_TOKEN: 'gh-token', PROPS_GH_REPO: 'owner/repo', PROPS_WORKFLOW: 'player-props.yml', PROPS_REF: 'main', PROPS_DEBOUNCE_S: '240', PROPS_FALLBACK_MIN: '60',
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const NOW = Date.parse('2026-10-01T18:00:00Z');
const iso = (m) => new Date(NOW + m * 60e3).toISOString();
let HEALTH = [], QUEUED = [], ADMIT = null, DISPATCH = 204, REJECT_INPUTS = false, USER = { id: '00000000-0000-0000-0000-00000000000a' }, REQ_ROWS = [];
const SEEN = [];
function res(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; }
globalThis.fetch = async function (url, init) {
  const u = String(url), m = (init && init.method) || 'GET';
  SEEN.push({ url: u, method: m, body: init && init.body ? JSON.parse(init.body) : null, headers: (init && init.headers) || {} });
  if (u.endsWith('/auth/v1/user')) return USER && /Bearer user-jwt/.test((init.headers || {}).authorization || '') ? res(200, USER) : res(401, { msg: 'invalid' });
  if (u.includes('/rest/v1/player_props_pipeline_health?select')) return HEALTH === null ? res(500, 'boom') : res(200, HEALTH);
  if (u.includes('/rest/v1/player_props_pipeline_health?on_conflict')) return res(201, '');
  if (u.includes('/rest/v1/player_props_refresh_requests?select=id,league,event_ids')) return res(200, QUEUED);
  if (u.includes('/rest/v1/player_props_refresh_requests?select=id,league,status')) return res(200, REQ_ROWS);
  if (u.includes('/rest/v1/player_props_refresh_requests?id=eq.')) return res(204, '');
  if (u.includes('/rest/v1/rpc/player_props_refresh_admit')) return ADMIT ? res(200, [ADMIT]) : res(404, 'no function');
  if (u.includes('/actions/workflows/') && u.endsWith('/dispatches')) {
    const b = JSON.parse(init.body);
    if (REJECT_INPUTS && Object.keys(b.inputs || {}).some((k) => k !== 'force_capture')) return res(422, JSON.stringify({ message: 'Unexpected inputs provided: ["source"]' }));
    return res(DISPATCH, DISPATCH === 204 ? '' : 'refused');
  }
  return res(404, 'unexpected ' + u);
};
const FN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'props_cron', 'index.ts');
const dispatches = () => SEEN.filter((s) => s.url.endsWith('/dispatches'));
const stamps = () => SEEN.filter((s) => s.url.includes('player_props_pipeline_health?on_conflict'));
const patches = () => SEEN.filter((s) => s.url.includes('player_props_refresh_requests?id=eq.') && s.method === 'PATCH');
function reset() { HEALTH = []; QUEUED = []; ADMIT = null; DISPATCH = 204; REJECT_INPUTS = false; USER = { id: '00000000-0000-0000-0000-00000000000a' }; REQ_ROWS = []; SEEN.length = 0; ENV.PROPS_GH_TOKEN = 'gh-token'; }
const fresh = (lg, over) => Object.assign({ league: lg, next_due_at: iso(40), last_dispatch_at: iso(-30), updated_at: iso(-10), rate_limited_until: null, health: 'HEALTHY' }, over || {});
const reqOf = (body, auth) => new Request('https://fn.test/props_cron', { method: 'POST', headers: { authorization: auth || 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async function () {
  let mod;
  try { mod = await import(FN); } catch (e) { console.log('SKIP | props cron | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  chk('the deployed function exports tick, refresh, status and handle', ['tick', 'refresh', 'status', 'handle'].every((k) => typeof mod[k] === 'function'));

  console.log('— a tick');
  reset(); HEALTH = [fresh('nfl'), fresh('cfb')];
  let t = await mod.tick(NOW);
  chk('nothing due: no dispatch, and it says when the next game is due', t.action === 'not_due' && dispatches().length === 0 && t.next_due_at === iso(40), t);
  chk('…and the tick is recorded on the health rows (the scheduler is visibly alive)', stamps().length === 1 && stamps()[0].body.every((r) => r.scheduler_action === 'not_due' && !r.last_dispatch_at));
  reset(); HEALTH = [fresh('nfl', { next_due_at: iso(-2) }), fresh('cfb')];
  t = await mod.tick(NOW);
  chk('a game due: the one pipeline is dispatched, as the primary scheduler', t.action === 'dispatched' && dispatches().length === 1 && dispatches()[0].body.inputs.source === 'supabase_cron' && dispatches()[0].body.ref === 'main'
    && dispatches()[0].url === 'https://api.github.com/repos/owner/repo/actions/workflows/player-props.yml/dispatches', t);
  chk('…and the dispatch time is recorded (the next tick debounces against it)', stamps()[0].body.every((r) => r.last_dispatch_at === new Date(NOW).toISOString()));
  chk('it never captures or writes a price itself', !SEEN.some((s) => /the-odds-api|player_prop_quotes|board\.json/.test(s.url)));
  reset(); HEALTH = [fresh('nfl', { next_due_at: iso(-2), last_dispatch_at: iso(-2) }), fresh('cfb')];
  t = await mod.tick(NOW);
  chk('a dispatch two minutes ago: debounced, not stampeded', t.action === 'debounced' && dispatches().length === 0, t);
  reset(); HEALTH = [fresh('nfl', { next_due_at: iso(-2) })]; ENV.PROPS_GH_TOKEN = ''; ENV.EDITORIAL_GH_TOKEN = '';
  t = await mod.tick(NOW);
  chk('no token is NOT a success, and says what is missing', t.ok === false && t.action === 'no_token' && /PROPS_GH_TOKEN/.test(t.reason) && dispatches().length === 0, t);
  reset(); ENV.PROPS_GH_TOKEN = ''; ENV.EDITORIAL_GH_TOKEN = 'editorial-token'; HEALTH = [fresh('nfl', { next_due_at: iso(-2) })];
  t = await mod.tick(NOW);
  chk('EDITORIAL_GH_TOKEN serves when PROPS_GH_TOKEN is unset', t.action === 'dispatched' && /editorial-token/.test(dispatches()[0].headers.authorization), t);
  delete ENV.EDITORIAL_GH_TOKEN;
  reset(); HEALTH = null;
  t = await mod.tick(NOW);
  chk('the health record unreadable: it dispatches anyway (fallback) — a broken record never silences prices', t.action === 'dispatched' && /fallback/.test(t.reason), t);
  reset(); HEALTH = [fresh('nfl', { updated_at: iso(-90), last_dispatch_at: iso(-90) }), fresh('cfb', { updated_at: iso(-90), last_dispatch_at: iso(-90) })];
  t = await mod.tick(NOW);
  chk('the health record quiet for 90 min: fallback dispatch', t.action === 'dispatched' && /quiet/.test(t.reason), t);
  reset(); HEALTH = [fresh('nfl'), fresh('cfb')]; QUEUED = [{ id: '11111111-1111-1111-1111-111111111111', league: 'cfb', event_ids: ['evA'], status: 'queued', dispatched_at: null }];
  t = await mod.tick(NOW);
  const qd = dispatches()[0];
  chk('a reader\'s refresh whose dispatch failed earlier is retried by the tick, as that refresh', t.action === 'dispatched' && qd.body.inputs.source === 'manual_refresh' && qd.body.inputs.refresh_request === QUEUED[0].id && qd.body.inputs.leagues === 'cfb' && qd.body.inputs.events === 'evA' && qd.body.inputs.force_capture === 'true', qd && qd.body);
  chk('…and the request is marked dispatched', patches().some((p) => p.body.status === 'dispatched'));
  reset(); HEALTH = [fresh('nfl'), fresh('cfb')]; QUEUED = [{ id: '44444444-4444-4444-4444-444444444444', league: 'nfl', event_ids: null, status: 'dispatched', dispatched_at: iso(-9) }];
  t = await mod.tick(NOW);
  chk('a refresh dispatched nine minutes ago that never started (a cancelled pending run) is dispatched again', t.action === 'dispatched' && dispatches()[0].body.inputs.refresh_request === QUEUED[0].id, t);
  reset(); HEALTH = [fresh('nfl'), fresh('cfb')]; QUEUED = [{ id: '55555555-5555-5555-5555-555555555555', league: 'nfl', event_ids: null, status: 'dispatched', dispatched_at: iso(-2) }];
  t = await mod.tick(NOW);
  chk('…but one dispatched two minutes ago is left to start', t.action === 'not_due' && dispatches().length === 0, t);
  const rq = SEEN.find((x) => x.url.includes('player_props_refresh_requests?select'));
  chk('…and the tick only ever looks at refreshes that have not started', rq && /status=in\.\(queued,dispatched\)/.test(rq.url) && /started_at=is\.null/.test(rq.url), rq && rq.url);
  reset(); HEALTH = [fresh('nfl', { next_due_at: iso(-2) })]; DISPATCH = 500;
  t = await mod.tick(NOW);
  chk('GitHub refusing the dispatch is an error, with its answer', t.ok === false && t.action === 'error' && /500/.test(t.reason), t);

  console.log('— a reader\'s refresh');
  const ID = '22222222-2222-2222-2222-222222222222';
  reset(); USER = null;
  let r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl' }, 'Bearer anon-key'), { action: 'refresh', league: 'nfl' }, NOW);
  let j = await r.json();
  chk('a reader who is not signed in is refused, in words, and nothing is dispatched', r.status === 401 && j.reason === 'sign_in_required' && /Sign in/.test(j.message) && dispatches().length === 0, j);
  reset(); ADMIT = { admitted: true, request_id: ID, status: 'queued', reason: null, retry_after_s: null };
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl', event_ids: ['ev1', 'bad id!'] }), { action: 'refresh', league: 'nfl', event_ids: ['ev1', 'bad id!'] }, NOW);
  j = await r.json();
  const rd = dispatches()[0];
  chk('an admitted refresh dispatches a FORCED capture carrying its request id', r.status === 202 && j.ok && j.request_id === ID && j.status === 'dispatched' && rd.body.inputs.force_capture === 'true' && rd.body.inputs.refresh_request === ID && rd.body.inputs.leagues === 'nfl' && rd.body.inputs.source === 'manual_refresh', [r.status, j, rd && rd.body]);
  chk('only well-formed event ids reach the run', rd.body.inputs.events === 'ev1');
  const admitCall = SEEN.find((s) => s.url.includes('rpc/player_props_refresh_admit'));
  chk('admission is the database\'s (atomic, cool-downs), for the verified reader', admitCall && admitCall.body.p_user === '00000000-0000-0000-0000-00000000000a' && admitCall.body.p_user_cooldown_s === 300 && admitCall.body.p_global_cooldown_s === 120, admitCall && admitCall.body);
  chk('the request is marked dispatched, and the scheduler records the dispatch', patches().some((p) => p.body.status === 'dispatched') && stamps().some((s) => s.body[0].last_dispatch_at));
  reset(); ADMIT = { admitted: false, request_id: null, status: 'rejected', reason: 'you refreshed recently', retry_after_s: 240 };
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl' }), { action: 'refresh', league: 'nfl' }, NOW);
  j = await r.json();
  chk('refresh spam: 429, how long to wait, nothing dispatched', r.status === 429 && j.reason === 'rate_limited' && j.retry_after_s === 240 && /Try again in 4 min/.test(j.message) && dispatches().length === 0, j);
  reset(); ADMIT = { admitted: true, request_id: ID, status: 'running', reason: 'a refresh is already in progress', retry_after_s: null };
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl' }), { action: 'refresh', league: 'nfl' }, NOW);
  j = await r.json();
  chk('a second click joins the refresh in flight (nothing bought twice)', r.status === 202 && j.joined === true && j.request_id === ID && dispatches().length === 0, j);
  reset(); ADMIT = { admitted: true, request_id: ID, status: 'queued' }; ENV.PROPS_GH_TOKEN = '';
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'all' }), { action: 'refresh', league: 'all' }, NOW);
  j = await r.json();
  chk('no token: the reader is told a capture cannot start, and the request is marked failed', r.status === 503 && j.reason === 'no_token' && /cannot be started/.test(j.message) && patches().some((p) => p.body.status === 'failed'), j);
  reset(); ADMIT = { admitted: true, request_id: ID, status: 'queued' }; DISPATCH = 403;
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl' }), { action: 'refresh', league: 'nfl' }, NOW);
  j = await r.json();
  chk('GitHub refusing: 502, the answer named, the request marked failed', r.status === 502 && /403/.test(j.message) && patches().some((p) => p.body.status === 'failed' && /403/.test(p.body.reason)), j);
  reset(); ADMIT = { admitted: true, request_id: ID, status: 'queued' }; REJECT_INPUTS = true;
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl' }), { action: 'refresh', league: 'nfl' }, NOW);
  j = await r.json();
  chk('a workflow that predates the new inputs still runs a forced capture, and says so', r.status === 202 && dispatches().length === 2 && JSON.stringify(dispatches()[1].body.inputs) === '{"force_capture":"true"}' && /does not accept/.test(j.message), [r.status, j]);
  reset(); ADMIT = null;
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nfl' }), { action: 'refresh', league: 'nfl' }, NOW);
  chk('the SQL not installed: 503 and says which file', r.status === 503 && /player_props_pipeline\.sql/.test((await r.json()).message));
  reset();
  r = await mod.refresh(reqOf({ action: 'refresh', league: 'nba' }), { action: 'refresh', league: 'nba' }, NOW);
  chk('an unknown league is refused', r.status === 400);

  console.log('— status and the server');
  reset(); REQ_ROWS = [{ id: ID, league: 'nfl', status: 'completed', reason: 'fresh prices captured', result: { leagues: { nfl: { quotes: 2400 } } } }];
  r = await mod.status(reqOf({ action: 'status', id: ID }), { action: 'status', id: ID });
  j = await r.json();
  const sq = SEEN.find((s) => s.url.includes('select=id,league,status'));
  chk('status returns the reader\'s own request, and asks only for their own', r.status === 200 && j.request.status === 'completed' && /user_id=eq\.00000000-0000-0000-0000-00000000000a/.test(sq.url), j);
  r = await mod.status(reqOf({ action: 'status', id: 'x' }), { action: 'status', id: 'x' });
  chk('a malformed id is refused', r.status === 400);
  r = await mod.handle(new Request('https://fn.test/props_cron', { method: 'OPTIONS' }));
  chk('CORS preflight answers', r.status === 200 && r.headers.get('access-control-allow-origin') === '*');
  reset(); HEALTH = [fresh('nfl')];
  r = await mod.handle(new Request('https://fn.test/props_cron', { method: 'GET' }));
  j = await r.json();
  chk('GET is a health probe that never shows the token', j.ok && j.configured.has_token === true && JSON.stringify(j).indexOf('gh-token') < 0 && j.health[0].league === 'nfl', j);
  chk('and it says which build is answering, the value the deployment doctor compares', /^props_cron-/.test(j.build) && j.build === mod.BUILD, j.build);

  console.log('\n' + (fail ? 'FAILED' : 'ALL GREEN') + ' player props scheduler — ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(fail ? 1 : 0);
})();

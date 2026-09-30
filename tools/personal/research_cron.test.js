#!/usr/bin/env node
/* ============================================================================
   THE RESEARCH-STATE SCHEDULER, tested as deployed.

   supabase/functions/research_cron/index.ts is imported — not a copy — under
   Node's native type stripping with a Deno shim and a mocked network (the
   pattern of tools/props/props_cron.test.js). What is pinned:

     · a tick pokes research-state.yml only when the newest research state is
       older than the cadence: 25 min while a kickoff is inside 24 h, 55 min
       otherwise — never on every tick
     · it never dispatches twice inside one cadence, so a double poke, a
       failing run or an empty slate costs one run per cadence, not one per
       tick; without its own record it dispatches nothing at all
     · a missing token is never a success; the props / editorial token serves
     · a workflow that predates the `source` input still runs (422 fallback)
     · over a whole simulated game day, every game's line stays inside the
       landing page's own window (lib/edgedesk_home.js gameWindow) — and with
       GitHub's schedule alone, as run on 2026-09-29, it does not

   Run: node tools/personal/research_cron.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EDHome = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) { pass++; return true; } fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); return false; }

const BASE_ENV = {
  SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  RESEARCH_GH_TOKEN: 'gh-token', RESEARCH_GH_REPO: 'owner/repo', RESEARCH_WORKFLOW: 'research-state.yml', RESEARCH_REF: 'main',
};
let ENV = Object.assign({}, BASE_ENV);
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const NOW = Date.parse('2026-10-03T15:00:00Z');
const MIN = 60e3, HOUR = 36e5;
const iso = (v) => new Date(v).toISOString();

/* the database and GitHub, as the function sees them */
let COMPUTED = null, KICKOFFS = [], SCHED = null, SCHED_MISSING = false, STATE_DOWN = false, DISPATCH = 204, REJECT_INPUTS = false;
const SEEN = [];
function res(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; }
globalThis.fetch = async function (url, init) {
  const u = String(url), m = (init && init.method) || 'GET';
  SEEN.push({ url: u, method: m, body: init && init.body ? JSON.parse(init.body) : null, headers: (init && init.headers) || {} });
  if (u.includes('/rest/v1/research_state_scheduler?select')) return SCHED_MISSING ? res(404, '{"code":"42P01"}') : res(200, SCHED ? [SCHED] : []);
  if (u.includes('/rest/v1/research_state_scheduler?on_conflict=id') && m === 'POST') {
    if (SCHED_MISSING) return res(404, 'missing');
    SCHED = Object.assign({}, SCHED || {}, JSON.parse(init.body));
    return res(201, '');
  }
  if (u.includes('/rest/v1/game_research_state?select=computed_at')) return STATE_DOWN ? res(500, 'boom') : res(200, COMPUTED == null ? [] : [{ computed_at: iso(COMPUTED) }]);
  if (u.includes('/rest/v1/game_research_state?select=kickoff_at')) {
    if (STATE_DOWN) return res(500, 'boom');
    const after = Date.parse(decodeURIComponent(/kickoff_at=gt\.([^&]+)/.exec(u)[1]));
    const next = KICKOFFS.filter((k) => k > after).sort((a, b) => a - b)[0];
    return res(200, next == null ? [] : [{ kickoff_at: iso(next) }]);
  }
  if (u.includes('/actions/workflows/') && u.endsWith('/dispatches')) {
    const b = JSON.parse(init.body);
    if (REJECT_INPUTS && b.inputs) return res(422, JSON.stringify({ message: 'Unexpected inputs provided: ["source"]' }));
    return res(DISPATCH, DISPATCH === 204 ? '' : 'refused');
  }
  return res(404, 'unexpected ' + u);
};
const FN = path.join(ROOT, 'supabase', 'functions', 'research_cron', 'index.ts');
const dispatches = () => SEEN.filter((s) => s.url.endsWith('/dispatches'));
const stamps = () => SEEN.filter((s) => s.url.includes('research_state_scheduler?on_conflict'));
function reset(over) {
  COMPUTED = null; KICKOFFS = []; SCHED = null; SCHED_MISSING = false; STATE_DOWN = false; DISPATCH = 204; REJECT_INPUTS = false; SEEN.length = 0;
  ENV = Object.assign({}, BASE_ENV, over || {});
}

/* A DAY, TICK BY TICK. pg_cron every five minutes; a dispatched run lands its
   state a minute later (the real job takes ~30 s). The market a state carries
   is as old as the capture tier made it when the run read it: capture.yml's
   near tier is ~10 min inside 8 h of a game, its day tier ~30 min inside 30 h,
   its board tier 4 h (supabase/capture_cron.sql). At every tick, every
   upcoming game's line must be inside the landing page's window for it. */
function captureLag(hoursToKick) { return hoursToKick <= 8 ? 10 * MIN : (hoursToKick <= 30 ? 30 * MIN : 240 * MIN); }
async function simulate(mod, opts) {
  const start = opts.start, end = start + (opts.hours || 24) * HOUR;
  KICKOFFS = opts.kickoffs; SCHED = opts.sched || null; COMPUTED = opts.computed == null ? null : opts.computed;
  const fails = opts.fails || (() => false);
  const out = { dispatched: [], worst: 0, worstAt: null, offBoard: [] };
  let landed = COMPUTED;
  for (let t = start; t < end; t += 5 * MIN) {
    (opts.backup || []).forEach((b) => { if (b >= t - 5 * MIN && b < t) { COMPUTED = b + MIN; landed = COMPUTED; } });
    if (!opts.githubOnly) {
      const r = await mod.tick(t);
      if (r.action === 'dispatched') {
        out.dispatched.push(t);
        if (!fails(t)) { COMPUTED = t + MIN; landed = COMPUTED; }
      }
    }
    if (landed == null) continue;
    KICKOFFS.filter((k) => k > t).forEach((k) => {
      const age = (t - landed) / MIN + captureLag((k - landed) / HOUR) / MIN;
      const window = EDHome.gameWindow(iso(k), iso(t));
      if (age - window > out.worst) { out.worst = age - window; out.worstAt = iso(t); }
      if (age > window && (k - t) <= 6 * HOUR) out.offBoard.push({ at: iso(t), kickoff: iso(k), age: Math.round(age), window });
    });
  }
  return out;
}
const gaps = (list) => list.slice(1).map((t, i) => (t - list[i]) / MIN);

(async function () {
  let mod;
  try { mod = await import(FN); } catch (e) { console.log('SKIP | research cron | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  chk('the deployed function exports tick, probe, handle, cadenceFor and its BUILD',
    ['tick', 'probe', 'handle', 'cadenceFor'].every((k) => typeof mod[k] === 'function') && /^research_cron-\d{4}-\d{2}-\d{2}-r\d+$/.test(mod.BUILD), mod.BUILD);

  console.log('— the cadence');
  const C = { cadenceMinutes: 55, nearCadenceMinutes: 25, nearHours: 24 };
  chk('a kickoff inside 24 h: 25 min', mod.cadenceFor(NOW + 23 * HOUR, NOW, C) === 25);
  chk('a kickoff 25 h away: 55 min (hourly)', mod.cadenceFor(NOW + 25 * HOUR, NOW, C) === 55);
  chk('no kickoff on file: 55 min', mod.cadenceFor(null, NOW, C) === 55);

  console.log('— a tick');
  reset(); COMPUTED = NOW - 10 * MIN; KICKOFFS = [NOW + 72 * HOUR];
  let t = await mod.tick(NOW);
  chk('a state 10 min old: not due, nothing dispatched, and it says when it will be', t.ok && t.action === 'not_due' && dispatches().length === 0 && /due in 45 min/.test(t.reason), t);
  chk('…and the tick is recorded (the scheduler is visibly alive), with no dispatch time',
    stamps().length === 1 && stamps()[0].body.scheduler_action === 'not_due' && !('last_dispatch_at' in stamps()[0].body) && stamps()[0].body.scheduler_tick_at === iso(NOW), stamps()[0] && stamps()[0].body);
  chk('…and what it saw: the newest state, the next kickoff, the cadence',
    SCHED.state_computed_at === iso(NOW - 10 * MIN) && SCHED.next_kickoff_at === iso(NOW + 72 * HOUR) && SCHED.cadence_minutes === 55, SCHED);

  reset(); COMPUTED = NOW - 60 * MIN; KICKOFFS = [NOW + 72 * HOUR]; SCHED = { id: 1, last_dispatch_at: iso(NOW - 61 * MIN) };
  t = await mod.tick(NOW);
  const d0 = dispatches()[0];
  chk('a state an hour old: research-state.yml is dispatched on main, as the primary scheduler',
    t.ok && t.action === 'dispatched' && dispatches().length === 1 && d0.url === 'https://api.github.com/repos/owner/repo/actions/workflows/research-state.yml/dispatches'
    && d0.body.ref === 'main' && d0.body.inputs.source === 'supabase_cron' && /gh-token/.test(d0.headers.authorization), [t, d0 && d0.body]);
  chk('…the reason says how old the state was', /60 min old/.test(t.reason), t.reason);
  chk('…and the dispatch time is recorded (the next tick debounces against it)', SCHED.last_dispatch_at === iso(NOW) && /dispatched/.test(SCHED.last_dispatch_reason), SCHED);
  chk('it never writes a research state itself', !SEEN.some((s) => s.method !== 'GET' && /game_research_state/.test(s.url)));

  reset(); COMPUTED = NOW - 5 * HOUR; KICKOFFS = [NOW + 3 * HOUR]; SCHED = { id: 1, last_dispatch_at: null };
  t = await mod.tick(NOW);
  chk('production 2026-09-29: a state five hours old three hours before kickoff is dispatched at once', t.action === 'dispatched' && /300 min old/.test(t.reason) && /cadence 25 min/.test(t.reason), t);

  console.log('— tighter inside 24 h of a kickoff');
  reset(); COMPUTED = NOW - 27 * MIN; KICKOFFS = [NOW + 5 * HOUR]; SCHED = { id: 1, last_dispatch_at: iso(NOW - 28 * MIN) };
  t = await mod.tick(NOW);
  chk('27 min old with a kickoff in 5 h: due (25-min cadence)', t.action === 'dispatched' && t.cadence_minutes === 25, t);
  reset(); COMPUTED = NOW - 27 * MIN; KICKOFFS = [NOW + 50 * HOUR]; SCHED = { id: 1, last_dispatch_at: iso(NOW - 28 * MIN) };
  t = await mod.tick(NOW);
  chk('the same state with the next kickoff in 50 h: not due (hourly)', t.action === 'not_due' && t.cadence_minutes === 55 && dispatches().length === 0, t);
  reset(); COMPUTED = NOW - 27 * MIN; KICKOFFS = [NOW - 1 * HOUR, NOW + 50 * HOUR];
  t = await mod.tick(NOW);
  chk('a game already under way is not "the next kickoff"', t.cadence_minutes === 55 && t.next_kickoff_at === iso(NOW + 50 * HOUR), t);
  const kq = SEEN.find((s) => s.url.includes('select=kickoff_at'));
  chk('…the next-kickoff read asks only for games after now, earliest first',
    kq && decodeURIComponent(kq.url).includes('kickoff_at=gt.' + iso(NOW)) && /order=kickoff_at\.asc&limit=1/.test(kq.url), kq && kq.url);

  console.log('— it never stampedes');
  reset(); COMPUTED = NOW - 70 * MIN; KICKOFFS = [NOW + 72 * HOUR]; SCHED = { id: 1, last_dispatch_at: iso(NOW - 20 * MIN) };
  t = await mod.tick(NOW);
  chk('due, but its own dispatch was 20 min ago and wrote nothing: debounced, not re-dispatched',
    t.ok && t.action === 'debounced' && dispatches().length === 0 && /20 min ago/.test(t.reason), t);
  t = await mod.tick(NOW + 35 * MIN);
  chk('…and retried once the full cadence has passed', t.action === 'dispatched' && dispatches().length === 1, t);
  reset(); COMPUTED = NOW - 90 * MIN; KICKOFFS = [NOW + 72 * HOUR]; SCHED = { id: 1, last_dispatch_at: iso(NOW - 90 * MIN) };
  const pair = [await mod.tick(NOW), await mod.tick(NOW + 1000)];
  chk('two pokes in the same minute: one dispatch, one debounce', pair[0].action === 'dispatched' && pair[1].action === 'debounced' && dispatches().length === 1, pair);
  reset(); COMPUTED = NOW - 90 * MIN; SCHED = { id: 1, last_dispatch_at: iso(NOW + 10 * MIN) };
  t = await mod.tick(NOW);
  chk('a dispatch time in the future (a clock that jumped) debounces rather than dispatches', t.action === 'debounced' && dispatches().length === 0, t);

  reset(); SCHED_MISSING = true; COMPUTED = NOW - 5 * HOUR;
  t = await mod.tick(NOW);
  chk('without its own record (the SQL not applied) it dispatches NOTHING, and names the file',
    t.ok === false && t.action === 'not_installed' && dispatches().length === 0 && /research_state_cron\.sql/.test(t.reason), t);
  const r503 = await mod.handle(new Request('https://fn.test/research_cron', { method: 'POST', body: '{}' }));
  chk('…and answers 503', r503.status === 503);

  console.log('— a broken read never silences the job');
  reset(); SCHED = { id: 1, last_dispatch_at: null };
  t = await mod.tick(NOW);
  chk('an empty research-state table is due', t.action === 'dispatched' && /holds no research state/.test(t.reason), t);
  reset(); COMPUTED = NOW + 5000 * MIN; SCHED = { id: 1, last_dispatch_at: iso(NOW - 2 * HOUR) };
  t = await mod.tick(NOW);
  chk('a state stamped in the future (a clock that jumped) is not trusted: due', t.action === 'dispatched' && /in the future/.test(t.reason), t);
  reset(); COMPUTED = NOW + 2 * MIN; KICKOFFS = [NOW + 72 * HOUR];
  t = await mod.tick(NOW);
  chk('…but a couple of minutes of clock skew is just a fresh state', t.action === 'not_due' && /is 0 min old/.test(t.reason), t);
  reset(); STATE_DOWN = true; SCHED = { id: 1, last_dispatch_at: iso(NOW - 2 * HOUR) };
  t = await mod.tick(NOW);
  chk('a research-state table it cannot read is due, and says why', t.action === 'dispatched' && /could not be read \(HTTP 500\)/.test(t.reason), t);
  t = await mod.tick(NOW + 5 * MIN);
  chk('…once per cadence, not every tick', t.action === 'debounced' && dispatches().length === 1, t);

  console.log('— the token');
  reset({ RESEARCH_GH_TOKEN: '' }); COMPUTED = NOW - 2 * HOUR;
  t = await mod.tick(NOW);
  chk('no token is NOT a success, and names every token it would take', t.ok === false && t.action === 'no_token'
    && /RESEARCH_GH_TOKEN/.test(t.reason) && /PROPS_GH_TOKEN/.test(t.reason) && /EDITORIAL_GH_TOKEN/.test(t.reason) && dispatches().length === 0, t);
  chk('…and the refusal is on the record, with no dispatch time', SCHED.scheduler_action === 'no_token' && !SCHED.last_dispatch_at, SCHED);
  reset({ RESEARCH_GH_TOKEN: '', PROPS_GH_TOKEN: 'props-token' }); COMPUTED = NOW - 2 * HOUR;
  t = await mod.tick(NOW);
  chk('props_cron\'s PROPS_GH_TOKEN serves when RESEARCH_GH_TOKEN is unset (Supabase secrets are project-wide)',
    t.action === 'dispatched' && /props-token/.test(dispatches()[0].headers.authorization), t);
  reset({ RESEARCH_GH_TOKEN: '', EDITORIAL_GH_TOKEN: 'editorial-token' }); COMPUTED = NOW - 2 * HOUR;
  t = await mod.tick(NOW);
  chk('…and EDITORIAL_GH_TOKEN after it', t.action === 'dispatched' && /editorial-token/.test(dispatches()[0].headers.authorization), t);
  reset({ PROPS_GH_TOKEN: 'props-token' }); COMPUTED = NOW - 2 * HOUR;
  await mod.tick(NOW);
  chk('RESEARCH_GH_TOKEN wins when both are set', /gh-token/.test(dispatches()[0].headers.authorization));

  console.log('— GitHub\'s answer');
  reset(); COMPUTED = NOW - 2 * HOUR; DISPATCH = 403;
  t = await mod.tick(NOW);
  chk('GitHub refusing the dispatch is an error, with its answer, and no dispatch time is recorded',
    t.ok === false && t.action === 'error' && /403/.test(t.reason) && SCHED.scheduler_action === 'error' && !SCHED.last_dispatch_at, [t, SCHED]);
  reset(); COMPUTED = NOW - 2 * HOUR; REJECT_INPUTS = true;
  t = await mod.tick(NOW);
  chk('a workflow on main that predates the `source` input still runs, and the reason says so',
    t.action === 'dispatched' && dispatches().length === 2 && !('inputs' in dispatches()[1].body) && /does not accept it yet/.test(t.reason), t);

  console.log('— configuration');
  reset({ RESEARCH_NEAR_CADENCE_MIN: '1', RESEARCH_CADENCE_MIN: 'x' }); COMPUTED = NOW - 8 * MIN; KICKOFFS = [NOW + HOUR];
  t = await mod.tick(NOW);
  chk('a cadence set below ten minutes is read as ten', t.cadence_minutes === 10 && t.action === 'not_due', t);
  KICKOFFS = [NOW + 72 * HOUR];
  t = await mod.tick(NOW);
  chk('a cadence that is not a number falls back to its default', t.cadence_minutes === 55, t);

  console.log('— the server');
  reset(); SCHED = { id: 1, scheduler_tick_at: iso(NOW), scheduler_action: 'not_due', last_dispatch_at: iso(NOW - HOUR) };
  let r = await mod.handle(new Request('https://fn.test/research_cron', { method: 'GET' }));
  let j = await r.json();
  chk('GET is a health probe that names its build (the value the deployment doctor compares)',
    r.status === 200 && j.ok && j.service === 'research_cron' && j.build === mod.BUILD && j.configured.workflow === 'research-state.yml', j);
  chk('…says whether a token is set and never shows it', j.configured.has_token === true && JSON.stringify(j).indexOf('gh-token') < 0, j);
  chk('…shows the scheduler\'s last word', j.scheduler && j.scheduler.scheduler_action === 'not_due', j.scheduler);
  chk('…and never ticks: no dispatch, no stamp', dispatches().length === 0 && stamps().length === 0);
  reset(); SCHED_MISSING = true;
  j = await (await mod.handle(new Request('https://fn.test/research_cron', { method: 'GET' }))).json();
  chk('GET still answers without the SQL, and says the record is unreadable', j.ok && j.build === mod.BUILD && j.scheduler && /404/.test(j.scheduler.unreadable), j);
  /* handle() ticks on the real clock */
  reset(); COMPUTED = Date.now() - 3 * HOUR;
  r = await mod.handle(new Request('https://fn.test/research_cron', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"supabase_cron"}' }));
  j = await r.json();
  chk('POST is a tick', r.status === 200 && j.action === 'dispatched', j);
  reset({ RESEARCH_GH_TOKEN: '' }); COMPUTED = Date.now() - 3 * HOUR;
  r = await mod.handle(new Request('https://fn.test/research_cron', { method: 'POST', body: '{}' }));
  chk('a tick that cannot keep the schedule answers 503', r.status === 503 && (await r.json()).action === 'no_token');
  r = await mod.handle(new Request('https://fn.test/research_cron', { method: 'DELETE' }));
  chk('any other method is refused', r.status === 405);

  console.log('— a whole day');
  /* a Saturday: college kickoffs from 16:00 to 03:30 UTC, the NFL on Sunday */
  const SAT = Date.parse('2026-10-03T00:00:00Z');
  const slate = [16, 16, 19.5, 19.5, 23.5, 27.5].map((h) => SAT + h * HOUR).concat([SAT + 41 * HOUR, SAT + 44.5 * HOUR]);
  reset();
  let sim = await simulate(mod, { start: SAT, hours: 24, kickoffs: slate, computed: SAT - 20 * MIN });
  chk('game day: every game\'s line stays inside the landing page\'s window, at every tick', sim.worst === 0 && sim.offBoard.length === 0, sim);
  chk('…with a run about every half hour (25-min cadence on five-minute ticks)', sim.dispatched.length >= 44 && sim.dispatched.length <= 49
    && Math.max(...gaps(sim.dispatched)) <= 30, [sim.dispatched.length, Math.max(...gaps(sim.dispatched))]);
  chk('…and never two runs inside one cadence', Math.min(...gaps(sim.dispatched)) >= 25, Math.min(...gaps(sim.dispatched)));

  reset();
  sim = await simulate(mod, { start: Date.parse('2026-10-06T00:00:00Z'), hours: 24, kickoffs: [Date.parse('2026-10-08T23:30:00Z')], computed: Date.parse('2026-10-05T23:30:00Z') });
  chk('a quiet Tuesday (next kickoff two days out): hourly', sim.dispatched.length >= 23 && sim.dispatched.length <= 25
    && gaps(sim.dispatched).every((g) => g === 60), [sim.dispatched.length, gaps(sim.dispatched)]);

  reset();
  const failing = await simulate(mod, { start: Date.parse('2026-10-06T00:00:00Z'), hours: 24, kickoffs: [Date.parse('2026-10-08T23:30:00Z')], computed: Date.parse('2026-10-05T23:30:00Z'), fails: () => true });
  chk('a job that fails every run is retried once per cadence (55 min), not every tick',
    failing.dispatched.length <= 27 && gaps(failing.dispatched).every((g) => g >= 55), [failing.dispatched.length, gaps(failing.dispatched)]);

  reset();
  const oneFail = await simulate(mod, { start: SAT, hours: 24, kickoffs: slate, computed: SAT - 20 * MIN, fails: (tt) => tt >= SAT + 14 * HOUR && tt < SAT + 15 * HOUR });
  chk('game day with every run in the hour before the 16:00 kickoffs failing: still on the board', oneFail.offBoard.length === 0, oneFail.offBoard.slice(0, 3));

  reset();
  const backup = [SAT + 14 * HOUR + 50 * MIN];
  sim = await simulate(mod, { start: SAT + 14 * HOUR, hours: 2, kickoffs: slate, computed: SAT + 14 * HOUR - 20 * MIN, backup });
  chk('a GitHub-scheduled run in between pushes the next dispatch a full cadence past it (no double runs)',
    sim.dispatched.every((d) => d < backup[0] || d - backup[0] >= 25 * MIN) && sim.dispatched.some((d) => d > backup[0]), sim.dispatched.map(iso));

  /* THE PROBLEM, REPRODUCED. GitHub's schedule alone, at the times it ran on
     2026-09-29, with Saturday's slate: games fall off the board. */
  reset();
  const gh = ['02:16', '08:59', '16:06', '21:00'].map((h) => Date.parse('2026-10-03T' + h + ':00Z'));
  sim = await simulate(mod, { start: SAT, hours: 24, kickoffs: slate, computed: SAT - 3 * HOUR, backup: gh, githubOnly: true });
  chk('with GitHub\'s schedule alone (2026-09-29\'s run times), game lines inside 6 h of kickoff fall off the board',
    sim.offBoard.length > 0, sim.offBoard.length);

  console.log('— the wiring');
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'research-state.yml'), 'utf8');
  chk('research-state.yml accepts the `source` input the dispatch sends (no 422 fallback on main)', /workflow_dispatch:\s*\n\s*inputs:[\s\S]*?\n\s+source:/.test(WF));
  chk('…keeps GitHub\'s own schedule as the backup', /schedule:\s*\n(\s*#.*\n)*\s*- cron: '38 \* \* \* \*'/.test(WF));
  chk('…and serializes runs in one concurrency group', /concurrency:\s*\n\s*group: research-state\s*\n\s*cancel-in-progress: false/.test(WF));
  const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'research_state_cron.sql'), 'utf8');
  chk('the pg_cron job calls this function by its directory name', /\/functions\/v1\/research_cron'/.test(SQL) && fs.existsSync(path.join(ROOT, 'supabase', 'functions', 'research_cron', 'index.ts')));
  const DEP = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-research-cron.yml'), 'utf8');
  chk('the deploy workflow runs this suite, then deploys research_cron with JWT verification off',
    /node tools\/personal\/research_cron\.test\.js/.test(DEP) && /supabase functions deploy research_cron[\s\\]*\n?[\s\S]*?--no-verify-jwt/.test(DEP));

  console.log('\n' + (fail ? 'FAILED' : 'ALL GREEN') + ' research-state scheduler — ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(fail ? 1 : 0);
})();

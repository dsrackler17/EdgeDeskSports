#!/usr/bin/env node
/* ============================================================================
   THE EDITORIAL RUNTIME — schedulers, settings and the freshness layer.

   THREE OPERATIONAL WEAKNESSES, and the proof each one is closed:

     1  NOTHING RELIABLY WOKE THE DISPATCHER. GitHub's scheduler is degraded on
        this repository — the editorial workflow logged zero scheduled runs
        across two cron expressions while every other scheduled workflow showed
        a ~4.5 hour gap. Health is now measured from HEARTBEATS written by
        whatever actually invoked the dispatcher, a primary/backup split means
        a dead primary is DEGRADED rather than ERROR, and a lease stops two
        schedulers paying for the same work.

     2  SETTINGS WERE DISPLAY-ONLY. There is now one production source of
        truth with a stated precedence, and the resolver records WHERE each
        value came from so the panel cannot show a file the runtime is not
        reading.

     3  THE LATE-WINDOW REFRESH RE-RAN THE WHOLE MODEL. It now asks narrow
        questions of named sources, records provenance per field, tells a
        blind spot from a non-change, and decides materiality by stated rules.

   Offline. No network, no database, no engine boot.
   Run: node tools/editorial/runtime.test.js
   ========================================================================== */
'use strict';

const RUNTIME = require('./runtime.js');
const FRESH = require('./freshness.js');
const HEALTH = require('./health.js');
const WINDOWS = require('./windows.js');
const STORE = require('./store.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); }
  }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function eq(name, got, want) {
  return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function section(t) { console.log('\n' + t); }

const NOW = '2026-09-13T18:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ago = m => new Date(NOW_MS - m * 60000).toISOString();

/* A stub Supabase client: the resolver and the health panel are pure given
   one, so every assertion here is about the logic rather than a live project. */
function stubClient(row, opts) {
  opts = opts || {};
  const calls = { claims: [], releases: [], beats: [] };
  return {
    enabled: true, hasService: opts.service !== false, url: 'stub', calls,
    async readSettings() { if (opts.throws) throw new Error(opts.throws); return row || null; },
    async heartbeatStart(src, d) { calls.beats.push({ src, d }); return calls.beats.length; },
    async heartbeatFinish(id, o) { calls.beats.push({ finish: id, o }); return true; },
    async recentHeartbeats() { return opts.beats || []; },
    async claim(k, o) { calls.claims.push({ k, o }); return opts.claim !== false; },
    async release(k, o) { calls.releases.push({ k, o }); return true; },
  };
}

/* ======================================================================== */
section('1. SETTINGS PRECEDENCE — database > repository > environment override');
/* ======================================================================== */
(async function () {
  /* OFFLINE: the committed defaults, and it says so. */
  const off = await RUNTIME.resolve({ offline: true });
  chk('offline is not an error', off.reachable === false);
  eq('the committed default is used', off.sources.pregame_normal_lead_minutes, 'repository');
  chk('and the panel is told why', /committed defaults/.test(off.notes[0]), off.notes[0]);

  /* THE DATABASE WINS over the committed file. */
  const db = await RUNTIME.resolve({ client: stubClient({
    editorial_enabled: false, auto_publish_pregame: false,
    pregame_normal_lead_minutes: 120, pregame_minimum_publish_lead_minutes: 30,
  }) });
  chk('the database is reachable', db.reachable === true);
  eq('a database boolean wins', db.settings.editorial_enabled, false);
  eq('and is attributed to the database', db.sources.editorial_enabled, 'database');
  eq('a database integer wins', db.settings.pregame_normal_lead_minutes, 120);
  eq('a field the database does not carry keeps the committed value',
    db.sources.quality_floor, 'repository');

  /* AN EXPLICIT DEPLOYMENT OVERRIDE beats both — an operator who set it has
     said something more specific than any stored default. */
  process.env.EDGD_PREGAME_NORMAL_LEAD = '75';
  process.env.EDGD_AUTO_PUBLISH_PREGAME = 'false';
  const env = await RUNTIME.resolve({ client: stubClient({ pregame_normal_lead_minutes: 120 }) });
  eq('an environment override wins over the database', env.settings.pregame_normal_lead_minutes, 75);
  chk('and names the variable', /EDGD_PREGAME_NORMAL_LEAD/.test(env.sources.pregame_normal_lead_minutes));
  eq('booleans too', env.settings.auto_publish_pregame, false);

  /* NONSENSE IS IGNORED AND REPORTED, never silently coerced. */
  process.env.EDGD_PREGAME_NORMAL_LEAD = 'soon';
  const bad = await RUNTIME.resolve({ client: stubClient({ pregame_normal_lead_minutes: 120 }) });
  eq('an unparseable override is ignored', bad.settings.pregame_normal_lead_minutes, 120);
  chk('and reported', bad.notes.some(n => /not a valid integer/.test(n)), JSON.stringify(bad.notes));
  delete process.env.EDGD_PREGAME_NORMAL_LEAD;
  delete process.env.EDGD_AUTO_PUBLISH_PREGAME;

  /* AN UNREACHABLE DATABASE FALLS BACK rather than failing the run. */
  const down = await RUNTIME.resolve({ client: stubClient(null, { throws: 'connection refused' }) });
  chk('an unreachable database is not fatal', down.reachable === false);
  chk('the committed defaults carry on', down.settings.pregame_normal_lead_minutes > 0);
  chk('and the reason is recorded', /connection refused/.test(down.notes.join(' ')));

  /* THE RESOLVED SETTINGS DRIVE THE WINDOWS — changing the lead changes the
     classification, which is the whole point of making them editable. */
  const kick = NOW_MS + 100 * 60000;             /* 100 minutes out */
  eq('100 minutes out is NORMAL at a 90-minute lead',
    WINDOWS.classify({ kickoff_ms: kick, now_ms: NOW_MS,
      settings: { pregame_normal_lead_minutes: 90, pregame_minimum_publish_lead_minutes: 20 } }).window,
    'normal');
  eq('and LATE once an operator raises the lead to 120',
    WINDOWS.classify({ kickoff_ms: kick, now_ms: NOW_MS,
      settings: { pregame_normal_lead_minutes: 120, pregame_minimum_publish_lead_minutes: 20 } }).window,
    'late_window');
})();

/* ======================================================================== */
section('2. SCHEDULER HEALTH — from heartbeats, not from assumptions');
/* ======================================================================== */
(function () {
  const base = {
    now: NOW,
    settings: { dispatcher_interval_minutes: 15, primary_interval_minutes: 10,
      editorial_enabled: true, dispatcher_enabled: true },
    featured: { generated_at: NOW, settings: {}, games: [] },
    runs: [], retries: {}, records: [], committed: [],
  };
  const hb = (src, mins, ok) => ({ scheduler_source: src, started_at: ago(mins), ok: ok !== false });
  const snap = beats => HEALTH.snapshot(Object.assign({}, base, { heartbeats: beats }));

  eq('primary fresh and backup fresh is HEALTHY',
    snap([hb('supabase_cron', 5), hb('github_schedule', 30)]).status, 'HEALTHY');
  eq('primary alone is enough',
    snap([hb('supabase_cron', 5)]).status, 'HEALTHY');

  /* THE CASE THE BRIEF NAMES: primary stale, backup working. The system is
     still publishing, just on the slower path — that is DEGRADED, not ERROR. */
  const deg = snap([hb('supabase_cron', 600), hb('github_schedule', 20)]);
  eq('a stale primary with a healthy backup is DEGRADED', deg.status, 'DEGRADED');
  chk('and says which scheduler stopped',
    deg.reasons.some(r => /primary scheduler is not running/.test(r)), JSON.stringify(deg.reasons));
  chk('while reporting the backup is still working',
    deg.reasons.some(r => /backup is still invoking/.test(r)));

  /* NOTHING IS RUNNING AT ALL is the real failure. */
  const err = snap([hb('supabase_cron', 900), hb('github_schedule', 1200)]);
  eq('every scheduler stale is ERROR', err.status, 'ERROR');
  chk('and says nothing is invoking the dispatcher',
    err.reasons.some(r => /no scheduler is successfully invoking/.test(r)));

  /* A FAILED HEARTBEAT IS NOT A SUCCESSFUL ONE. */
  const failing = snap([hb('supabase_cron', 5, false), hb('github_schedule', 1200)]);
  eq('a primary that ran and failed does not count as healthy', failing.status, 'ERROR');

  /* WHAT THE PANEL REPORTS, field by field. */
  const h = snap([hb('supabase_cron', 4), hb('github_schedule', 28)]);
  eq('the primary is named', h.schedulers.primary.name, 'supabase_cron');
  eq('with its last success', h.schedulers.primary.minutes_since, 4);
  chk('and a next expected time', !!h.schedulers.primary.next_expected_at);
  eq('the backup is reported separately', h.schedulers.backup.minutes_since, 28);
  chk('both are healthy', h.schedulers.primary.healthy && h.schedulers.backup.healthy);

  /* WITH NO HEARTBEATS AT ALL the panel falls back to the run log rather than
     claiming the system is dead — an offline deployment still gets the truth. */
  const noBeats = HEALTH.snapshot(Object.assign({}, base, {
    runs: [{ run: 'r', at: ago(3), step: 'dispatch', ok: true, reason: 'ok' }],
  }));
  eq('no heartbeats falls back to the run log', noBeats.status, 'HEALTHY');
})();

/* ======================================================================== */
section('3. THE KILL SWITCH');
/* ======================================================================== */
(function () {
  const base = {
    now: NOW,
    settings: { dispatcher_interval_minutes: 15, editorial_enabled: false, dispatcher_enabled: true },
    featured: { generated_at: NOW, settings: {}, games: [] },
    runs: [], retries: {}, records: [], committed: [],
    heartbeats: [{ scheduler_source: 'supabase_cron', started_at: ago(3), ok: true }],
  };
  const h = HEALTH.snapshot(base);
  eq('a paused system reports PAUSED', h.status, 'PAUSED');
  chk('and not ERROR', h.status !== 'ERROR');
  chk('the flag is explicit', h.paused === true);
  chk('the reason is unambiguous',
    /EDITORIAL PAUSED BY OPERATOR/.test(h.reasons[0]), h.reasons[0]);
  chk('and says public pages are unaffected',
    /already-public pages are unaffected/.test(h.reasons[0]));
  /* THE HEARTBEAT STILL COUNTS — a paused system must still look alive. */
  chk('a paused system still reports its scheduler', h.schedulers.primary.healthy === true);

  /* THE DISPATCHER MAY BE STOPPED SEPARATELY from the editorial work. */
  const dOff = HEALTH.snapshot(Object.assign({}, base,
    { settings: { dispatcher_interval_minutes: 15, editorial_enabled: true, dispatcher_enabled: false } }));
  chk('a disabled dispatcher degrades rather than pausing',
    dOff.status === 'DEGRADED', dOff.status);
  chk('and says so', dOff.reasons.some(r => /dispatcher is switched off/.test(r)));
})();

/* ======================================================================== */
section('4. THE FRESHNESS LAYER — narrow questions, named sources');
/* ======================================================================== */
(function () {
  const mk = (line, total) => ({
    'market.line': FRESH.field(line, 'a book', '2026-09-13T17:00:00.000Z'),
    'market.total': FRESH.field(total, 'a book', '2026-09-13T17:00:00.000Z'),
  });

  /* EVERY FIELD CARRIES ITS PROVENANCE. */
  const obs = FRESH.marketFields({ market: { available: true, market: 'Home -3',
    total_market: '45.5', book: 'A Book' } }, { retrieved_at: NOW });
  eq('the line is read', obs['market.line'].value, 'Home -3');
  eq('with its provider', obs['market.line'].provider, 'A Book');
  eq('and when it was retrieved', obs['market.line'].retrieved_at, NOW);
  eq('the total is a number', obs['market.total'].value, 45.5);

  /* AN UNAVAILABLE FIELD IS NOT A NULL VALUE. */
  const none = FRESH.marketFields({ market: { available: false } });
  eq('no quote is reported as unavailable', none['market.line'].status, 'unavailable');
  chk('with a reason', !!none['market.line'].note);

  /* A BLIND SPOT IS NOT A NON-CHANGE. This is the distinction the whole layer
     turns on: not knowing whether the line moved, and knowing it did not, must
     never look the same to the thing deciding whether to publish. */
  const blind = FRESH.compare(mk('Home -3', 45),
    { 'market.line': FRESH.unavailable('a book', 'the feed was down') });
  eq('an unavailable field produces no change', blind.changes.length, 0);
  eq('it is reported as a blind spot', blind.blind.length, 1);
  eq('naming the field', blind.blind[0].field, 'market.line');

  /* MATERIALITY, rule by rule. */
  function mat(before, after, rules) {
    return FRESH.materiality(FRESH.compare(before, after).changes, { rules });
  }
  chk('a full point of line movement is material', mat(mk('Home -3', 45), mk('Home -4', 45)).material);
  chk('half a point is not', !mat(mk('Home -3', 45), mk('Home -3.5', 45)).material);
  chk('three points on a total is material', mat(mk('Home -3', 45), mk('Home -3', 48)).material);
  chk('half a point on a total is not', !mat(mk('Home -3', 45), mk('Home -3', 45.5)).material);
  chk('and the threshold is configuration, not a constant',
    mat(mk('Home -3', 45), mk('Home -3.5', 45), { material_spread_points: 0.5 }).material);

  const qb = v => ({ 'availability.qb': FRESH.field(v, 'nflverse', NOW) });
  chk('a quarterback ruled out is material', mat(qb([]), qb(['Star Passer'])).material);
  const outs = v => ({ 'availability.out': FRESH.field(v, 'nflverse', NOW) });
  chk('a newly ruled-out player is material', mat(outs(['A']), outs(['A', 'B'])).material);
  chk('a shortened injury list is not', !mat(outs(['A', 'B']), outs(['A'])).material);

  const ko = v => ({ 'fixture.kickoff': FRESH.field(v, 'espn', NOW) });
  chk('a two-hour kickoff move is material',
    mat(ko('2026-09-13T20:00:00.000Z'), ko('2026-09-13T22:00:00.000Z')).material);
  chk('a five-minute nudge is not',
    !mat(ko('2026-09-13T20:00:00.000Z'), ko('2026-09-13T20:05:00.000Z')).material);

  const st = v => ({ 'fixture.status': FRESH.field(v, 'espn', NOW) });
  const post = mat(st('scheduled'), st('Postponed'));
  chk('a postponement is material', post.material);
  chk('and BLOCKING — no pregame article is published for it', post.blocking);
  chk('while an ordinary status change is not blocking',
    !mat(st('scheduled'), st('In Progress')).blocking);

  const venue = v => ({ 'fixture.venue': FRESH.field(v, 'espn', NOW) });
  chk('a venue change is material', mat(venue('Stadium A'), venue('Stadium B')).material);

  /* EVERY DECISION NAMES ITS RULE, so a log says why rather than that. */
  const hit = mat(mk('Home -3', 45), mk('Home -5', 45));
  eq('the rule is named', hit.hits[0].rule, 'spread_moved');
  chk('with the arithmetic', /2\.0 points/.test(hit.hits[0].why), hit.hits[0].why);

  /* COLLEGE FOOTBALL HAS NO UNIVERSAL INJURY REPORT, and absence of a report
     is not a report of no absences. */
  const limited = FRESH.cfbAvailability('Nowhere State', {
    availability: { generated_at: NOW, teams: [
      { team_name: 'Nowhere State', dataQuality: 'LIMITED', records: [] }] } });
  eq('limited coverage is unavailable, not "nobody is out"',
    limited['availability.out'].status, 'unavailable');
  chk('and says why', /LIMITED/.test(limited['availability.out'].note));

  /* A SPORT WITH NO SOURCE WIRED says unsupported rather than inventing one. */
  const other = FRESH.observe({ sport: 'MLB' }, { research: null });
  eq('an unwired sport is unsupported', other['availability.out'].status, 'unsupported');
})();

/* ======================================================================== */
section('5. THE ORIGINAL COMMITMENT IS NEVER TOUCHED');
/* ======================================================================== */
(function () {
  /* The freshness layer only ever READS. It has no write path to a snapshot,
     and the publication snapshot it informs is a separate artefact. */
  const research = { kind: 'NFL_GAME', market: { available: true, market: 'Home -3',
    total_market: '45', book: 'A Book' }, projection: {} };
  const frozen = JSON.stringify(research);
  const before = FRESH.observe({ sport: 'NFL' }, { research });
  const live = JSON.parse(frozen);
  live.market.market = 'Home -6';
  const after = FRESH.observe({ sport: 'NFL' }, { research: live });
  FRESH.materiality(FRESH.compare(before, after).changes);
  eq('observing does not mutate the research it read', JSON.stringify(research), frozen);

  /* And the store still resolves the RESEARCH snapshot for the audit, which is
     the guarantee every one of these changes had to preserve. */
  chk('the store exposes the research snapshot explicitly',
    typeof STORE.researchSnapshot === 'function');
  chk('and the publication snapshot separately',
    typeof STORE.publicationSnapshot === 'function');
  eq('a snapshot with no role is research', STORE.roleOf({ snapshot_id: 'x' }), 'research');
  eq('and a roled one is honoured', STORE.roleOf({ role: 'publication' }), 'publication');
})();

/* ======================================================================== */
section('6. THE LEASE CLIENT');
/* ======================================================================== */
(async function () {
  const c = stubClient(null, { claim: true });
  chk('a claim is made with a key and an owner', await c.claim('dispatcher', 'w1', 600));
  eq('the key is passed through', c.calls.claims[0].k, 'dispatcher');
  eq('and the owner', c.calls.claims[0].o, 'w1');
  await c.release('dispatcher', 'w1');
  eq('release names the same pair', c.calls.releases[0].k, 'dispatcher');

  /* A CLIENT WITH NO SERVICE CREDENTIAL CANNOT CLAIM, and says so rather than
     silently proceeding as though it held the lease. */
  const noService = RUNTIME.client({ service: null, fetch: async () => { throw new Error('unused'); } });
  let threw = null;
  try { await noService.claim('dispatcher', 'w1', 600); } catch (e) { threw = e; }
  chk('claiming without a service credential throws', !!threw);
  chk('and explains why', /server-side/.test(String(threw && threw.message)), String(threw && threw.message));
})();

/* ------------------------------------------------------------------ report */
setTimeout(() => {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | editorial runtime | '
    + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ' assertions'));
  if (fail) { failures.forEach(f => console.log('  ×  ' + f)); process.exit(1); }
}, 50);

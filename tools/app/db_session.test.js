#!/usr/bin/env node
/* ===========================================================================
   THE DATABASE READ THAT COULD NEVER RECOVER.

   System health reported "Database — read failed" and "no capture heartbeat
   read yet" while football/health.json, the pipeline rollup and the fault scan
   all loaded perfectly. Static files were fine; every Supabase read was dead.
   That shape is not an outage, and it was not one:

     1  Supabase refresh tokens ROTATE and are single-use. The moment one
        refresh failed — a blip, a second tab spending the token first, a
        revoked session — edRefreshSession() returned null and left the spent
        token sitting in localStorage.
     2  edToken() then handed out the EXPIRED access token anyway.
     3  PostgREST answered 401. sbFetch's 401 path retried the refresh — with
        the same spent token — which failed again, and the read threw "db 401".
     4  Nothing ever cleared the dead session, so steps 2-3 repeated on every
        read, every loader, every reload, in every tab, forever. The app sat in
        a permanent "Database read failed" that only clearing site data lifted.

   And because the anon key was never tried, the PUBLIC boards — which need no
   login at all — went dark alongside the user-scoped ones.

   What must now hold:
     · a definitively refused refresh (400/401) drops the session, once
     · a TRANSIENT failure (5xx, offline) must NOT sign anybody out
     · a known-expired token is never presented; reads fall back to anon
     · the fallback is bounded — no read may loop
     · a failure names its cause, so "read failed" is never the whole story
     · a failed COUNT names its cause too: sbCount threw a bare Error, so a 500
       statement timeout on the record read as "could not be reached at all"
     · a bug in the page is not a database outage: a TypeError thrown while
       drawing the record must not be recorded as a failed read
     · automatic recovery must never call edSignOut(): that wipes the CLV
       ledger, saved research and prefs and navigates away. A stale login
       costs the reader the login, and nothing else.

   Run: node tools/app/db_session.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
const has = (h, n, name) => chk(name, String(h).indexOf(n) >= 0, 'missing: ' + n);
const eq = (name, got, want) => chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
const PENDING = [];
const later = (p) => { PENDING.push(p.catch((e) => { fail++; failures.push('threw: ' + (e && e.message)); })); };

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/* ---- the live auth + read module, lifted out of the page ---------------- */
const START = APP.indexOf('var SB_URL="https://');
const END = APP.indexOf('async function sbGetAll(');
chk('the Supabase auth/read module is found in app.html', START >= 0 && END > START);
/* sbCount sits after sbGetAll; it is lifted with the module so a count's failure
   is held to the same standard as a read's */
const C0 = APP.indexOf('async function sbCount(');
const C1 = APP.indexOf('/* ===== ANCHOR PROVENANCE', C0);
chk('sbCount is found in app.html', C0 > END && C1 > C0);
const SRC = APP.slice(START, END) + '\n' + APP.slice(C0, C1);
const ANON = (/var SB_KEY="([^"]+)"/.exec(SRC) || [])[1];
chk('and it carries the anon key', !!ANON);

/* A page-free window: real module code, scripted network, observable storage. */
function harness(opts) {
  const store = {};
  if (opts.session) store['edgedesk_session'] = JSON.stringify(opts.session);
  const calls = [];
  const ctx = {
    console: opts.console || console, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, Promise, isFinite,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    fetch: (url, init) => {
      const bearer = String(((init || {}).headers || {}).authorization || '').replace(/^Bearer /, '');
      calls.push({ url: String(url), bearer: bearer });
      return Promise.resolve(opts.net(String(url), bearer));
    },
    edSession() { try { return JSON.parse(ctx.localStorage.getItem('edgedesk_session') || 'null'); } catch (e) { return null; } }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'app.html:supabase' });
  ctx.__calls = calls;
  ctx.__store = store;
  return ctx;
}
const res = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
});
/* a count answer: PostgREST puts the total in content-range */
const counted = (status, total, body) => Object.assign(res(status, body || []), {
  headers: { get: (k) => (/content-range/i.test(k) && total != null ? '0-0/' + total : null) }
});
const ROWS = [{ sig_key: 'k1' }];
const AUTH = (u) => /\/auth\/v1\/token/.test(u);
const now = () => Math.floor(Date.now() / 1000);

/* ======================================================================== */
/* 1. THE PROACTIVE PATH — an expired login whose refresh is refused        */
/* ======================================================================== */
later((async () => {
  const H = harness({
    session: { access_token: 'EXPIRED', refresh_token: 'SPENT', expires_at: now() - 60 },
    net: (u, b) => AUTH(u)
      ? res(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' })
      : (b === ANON ? res(200, ROWS) : res(401, { message: 'JWT expired' }))
  });
  const rows = await H.sbGet('signals?select=sig_key&limit=1');
  eq('a refused refresh still returns the rows, as the anon reader', JSON.stringify(rows), JSON.stringify(ROWS));
  chk('and the spent session is dropped, not kept to fail again', H.__store['edgedesk_session'] === undefined);
  chk('the reason is recorded for the panel', /revoked|already spent|expired/i.test(String(H.__EDGE_SESSION_DEAD)));
  chk('the expired token is never presented to PostgREST',
    H.__calls.filter((c) => !AUTH(c.url) && c.bearer === 'EXPIRED').length === 0,
    'calls: ' + JSON.stringify(H.__calls.map((c) => c.bearer)));
  chk('and the read is bounded — one refresh, one read', H.__calls.length <= 3, 'made ' + H.__calls.length);
})());

/* ======================================================================== */
/* 2. THE REACTIVE PATH — a token the server rejects outright               */
/* ======================================================================== */
later((async () => {
  const H = harness({
    session: { access_token: 'STALE', refresh_token: 'SPENT', expires_at: now() + 86400 },
    net: (u, b) => AUTH(u)
      ? res(401, { error: 'invalid_grant' })
      : (b === ANON ? res(200, ROWS) : res(401, { message: 'JWT rejected' }))
  });
  const rows = await H.sbGet('signals?select=sig_key&limit=1');
  eq('a 401 falls back to anon rather than taking the public board down', JSON.stringify(rows), JSON.stringify(ROWS));
  chk('the dead session is cleared here too', H.__store['edgedesk_session'] === undefined);
  chk('and the fallback is tried exactly once', H.__calls.filter((c) => c.bearer === ANON && !AUTH(c.url)).length === 1);
})());

/* ======================================================================== */
/* 3. A BLIP IS NOT A SIGN-OUT                                             */
/* ======================================================================== */
later((async () => {
  const H = harness({
    session: { access_token: 'EXPIRED', refresh_token: 'GOOD', expires_at: now() - 60 },
    net: (u, b) => AUTH(u) ? res(503, { message: 'upstream busy' }) : (b === ANON ? res(200, ROWS) : res(401, {}))
  });
  const rows = await H.sbGet('signals?select=sig_key&limit=1');
  eq('a 5xx on refresh still serves the public read', JSON.stringify(rows), JSON.stringify(ROWS));
  chk('but the session SURVIVES, so the next refresh can recover it',
    !!H.__store['edgedesk_session'], 'session was wrongly cleared on a transient failure');
  chk('and nobody is told they were signed out', !H.__EDGE_SESSION_DEAD);
})());

/* ======================================================================== */
/* 4. A FAILURE NAMES ITS CAUSE                                            */
/* ======================================================================== */
later((async () => {
  const H = harness({
    session: null,
    net: () => res(400, { code: '42703', message: 'column signals.actionable does not exist' })
  });
  let threw = null;
  try { await H.sbGet('signals?select=actionable&limit=1'); } catch (e) { threw = e; }
  chk('an unapplied migration is still a hard failure', !!threw && threw.status === 400);
  const why = H.edDbReason();
  has(why, 'migration', 'and the panel says a migration has not been applied');
  has(why, 'signals.actionable', 'naming the column PostgREST named');
})());

later((async () => {
  const H = harness({ session: null, net: () => res(503, { message: 'paused' }) });
  try { await H.sbGet('signals?select=sig_key'); } catch (e) {}
  has(H.edDbReason(), 'paused', 'a 5xx reads as a paused or overloaded project');
})());

later((async () => {
  const H = harness({ session: null, net: () => res(401, { message: 'no' }) });
  try { await H.sbGet('signals?select=sig_key'); } catch (e) {}
  has(H.edDbReason(), 'refused the key', 'a refused key says so rather than "read failed"');
})());

/* a transport failure has no status at all, and must still be explicable */
later((async () => {
  const store = {};
  const ctx = {
    console, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, Promise, isFinite,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    edSession: () => null
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(SRC, ctx, { filename: 'app.html:supabase' });
  let threw = null;
  try { await ctx.sbGet('signals?select=sig_key'); } catch (e) { threw = e; }
  chk('an unreachable host still rejects', !!threw);
  has(ctx.edDbReason(), 'could not be reached', 'and is reported as unreachable, not as a bad query');
})());

/* a stale login must not mask a fault no login can fix */
later((async () => {
  const H = harness({
    session: { access_token: 'EXPIRED', refresh_token: 'SPENT', expires_at: now() - 60 },
    net: (u) => AUTH(u) ? res(400, { error: 'invalid_grant' })
                        : res(400, { code: '42703', message: 'column signals.actionable does not exist' })
  });
  try { await H.sbGet('signals?select=actionable'); } catch (e) {}
  chk('the session is still reported dead', !!H.__EDGE_SESSION_DEAD);
  has(H.edDbReason(), 'migration', 'but a missing column outranks it — signing in installs no migrations');
})());

/* ======================================================================== */
/* 5. A GOOD READ CLEARS THE ALARM                                         */
/* ======================================================================== */
later((async () => {
  const H = harness({ session: null, net: () => res(200, ROWS) });
  await H.sbGet('signals?select=sig_key');
  chk('a healthy read reports healthy', H.ED_DB.ok === true);
  eq('and there is nothing to explain', H.edDbReason(), null);
  chk('a signed-out reader uses the anon key', H.__calls[0].bearer === ANON);
})());

/* and a read that recovers must stop explaining a failure that is over */
later((async () => {
  let down = true;
  const H = harness({ session: null, net: () => down ? res(503, { message: 'paused' }) : res(200, ROWS) });
  try { await H.sbGet('signals?select=sig_key'); } catch (e) {}
  chk('while it is down there is a cause to show', !!H.edDbReason());
  down = false;
  await H.sbGet('signals?select=sig_key');
  eq('once it recovers the stale cause is gone', H.edDbReason(), null);
})());

/* ======================================================================== */
/* 5b. A COUNT IS A READ, AND A PAGE BUG IS NOT                            */
/* ======================================================================== */
/* 2026-10-05: System health said "the database could not be reached at all —
   network, DNS, or a paused project · the record" while capture was writing to the
   same database every few minutes. The record's counts threw without a status, so
   any count failure read as an unreachable host. */
later((async () => {
  const H = harness({ session: null, net: () => counted(500, null, { code: '57014', message: 'canceling statement due to statement timeout' }) });
  let threw = null;
  try { await H.sbCount('graded_at=not.is.null'); } catch (e) { threw = e; }
  chk('a failed count still rejects', !!threw);
  eq('and carries its HTTP status', threw && threw.status, 500);
  const why = String(H.edDbReason());
  has(why, 'time limit', 'a statement timeout is named as one');
  chk('and is never called unreachable', why.indexOf('could not be reached') < 0, why);
})());

later((async () => {
  const H = harness({ session: null, net: () => counted(200, 10667) });
  eq('a good count returns the total', await H.sbCount('graded_at=not.is.null'), 10667);
  chk('and counts as a healthy read', H.ED_DB.ok === true);
})());

/* a refused token on a count gets the shared refresh — and never the anon key,
   whose count is a silent zero */
later((async () => {
  const H = harness({
    session: { access_token: 'STALE', refresh_token: 'GOOD', expires_at: now() + 86400 },
    net: (u, b) => AUTH(u) ? res(200, { access_token: 'FRESH', refresh_token: 'NEXT', expires_at: now() + 3600 })
                           : (b === 'FRESH' ? counted(200, 42) : counted(401, null, { message: 'JWT expired' }))
  });
  eq('a refused count is retried on the refreshed token', await H.sbCount(''), 42);
  chk('and never as anon', H.__calls.filter((c) => !AUTH(c.url) && c.bearer === ANON).length === 0,
    JSON.stringify(H.__calls.map((c) => c.bearer)));
})());

later((async () => {
  const quiet = { log() {}, info() {}, warn() {}, error() {} };
  const H = harness({ session: null, console: quiet, net: () => res(200, ROWS) });
  const bug = new TypeError("Cannot read properties of undefined (reading 'flagged_edge')");
  eq('a TypeError from drawing the page is not recorded as a database failure', H.edNoteDbError(bug, 'the record'), false);
  eq('so nothing is left for the panel to blame on the database', H.ED_DB.failAt, 0);
  eq('nor is a ReferenceError', H.edNoteDbError(Object.assign(new Error('recFoo is not defined'), { name: 'ReferenceError' }), 'the record'), false);
  eq('but fetch\'s own network failure is', H.edNoteDbError(new TypeError('Failed to fetch'), 'the record'), true);
  has(String(H.edDbReason()), 'could not be reached', 'and reads as unreachable');
  eq('and so is Safari\'s', H.edNoteDbError(new TypeError('Load failed'), 'the record'), true);
})());

/* the loaders paint the header through the two helpers, never by hand */
['the live board', 'the record analytics', 'the record'].forEach((w) =>
  has(APP, "edDbViewFail(e,'" + w + "')", w + ' reports its failure through edDbViewFail'));
chk('no loader paints the database pill red by hand',
  !/\$\('dbPill'\)\.className='pill err'/.test(APP));

/* ======================================================================== */
/* 6. RECOVERY MUST NOT COST THE READER THEIR DATA                         */
/* ======================================================================== */
const DROP = (() => {
  const i = APP.indexOf('function edDropDeadSession');
  /* the function body, with comments stripped — prose ABOUT edSignOut() must not
     read as a call TO it */
  return APP.slice(i, APP.indexOf('\nasync function edRefreshSession', i))
            .replace(/\/\*[\s\S]*?\*\//g, '');
})();
has(DROP, "removeItem('edgedesk_session')", 'the automatic recovery clears the session key');
chk('and nothing else — the CLV ledger, saved research and prefs all survive',
  DROP.indexOf('edSignOut(') < 0 && !/for\s*\(.*localStorage\.length/.test(DROP), DROP.trim());
has(APP, "if(r.status===400||r.status===401){", 'only a definitive refusal drops a session');
chk('System health asks for the reason behind a failed read',
  /shRow\('Database',dbWhy/.test(APP));
chk('and reports an expired login as a sign-in, never as an outage',
  /shRow\('Sign-in',window\.__EDGE_SESSION_DEAD/.test(APP));

Promise.all(PENDING).then(() => {
  console.log('');
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('\ndatabase session recovery: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});

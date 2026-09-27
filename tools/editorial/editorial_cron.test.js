#!/usr/bin/env node
/* ============================================================================
   THE PRIMARY SCHEDULER'S EDGE FUNCTION, tested as deployed.

   The DEPLOYED file is imported — not a copy — under Node's native type
   stripping with a Deno shim and a mocked network, the same way
   tools/capture/capture.test.js holds supabase/functions/capture. If the
   deployed file drifts, these fail.

   WHAT MATTERS ABOUT THIS FUNCTION. It is the thing that makes the editorial
   system independent of GitHub's scheduler, so its failure modes are the ones
   worth pinning:

     · a missing token must NOT report success — a permanently unscheduled
       system that looks healthy is the exact failure this exists to remove
     · the operator's pause must be honoured here, not only in the pipeline
     · it must not stampede: a run already in flight needs no second one
     · it must never run the pipeline itself, only poke the canonical one

   Run: node tools/editorial/editorial_cron.test.js
   ========================================================================== */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + String(detail).slice(0, 220) : ''));
  return false;
}
function eq(name, got, want) {
  return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function section(t) { console.log('\n' + t); }

/* ---- the Deno shim, installed BEFORE the import ------------------------- */
const ENV = {
  SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  EDITORIAL_GH_TOKEN: 'gh-token',
  EDITORIAL_GH_REPO: 'owner/repo',
  EDITORIAL_WORKFLOW: 'editorial.yml',
  EDITORIAL_DEBOUNCE_S: '300',
  EDITORIAL_REF: 'main',
};
globalThis.Deno = { env: { get: k => ENV[k] } };   /* no serve: the server stays uninstalled */

/* The mocked network. Every call is recorded so the assertions can be about
   what the function ASKED FOR, not merely what it returned. */
let SETTINGS_ROWS = [{ dispatcher_enabled: true, editorial_enabled: true }];
let HEARTBEAT_ROWS = [];
let DISPATCH_STATUS = 204;
let DISPATCH_BODY = '';
/* A workflow that predates the `source` input: GitHub answers 422 to a POST
   carrying it and 204 to the same POST without it. Set by section 6. */
let REJECT_UNKNOWN_INPUTS = false;
const SEEN = [];
function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
globalThis.fetch = async function (url, init) {
  const u = String(url);
  SEEN.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body });
  if (u.includes('/rest/v1/editorial_settings')) return jsonRes(200, SETTINGS_ROWS);
  if (u.includes('/rest/v1/editorial_heartbeats')) return jsonRes(200, HEARTBEAT_ROWS);
  if (u.includes('/actions/workflows/') && u.endsWith('/dispatches')) {
    if (REJECT_UNKNOWN_INPUTS) {
      const sent = JSON.parse((init && init.body) || '{}');
      const keys = Object.keys(sent.inputs || {});
      if (keys.length) {
        return jsonRes(422, JSON.stringify({
          message: 'Unexpected inputs provided: ["' + keys.join('","') + '"]',
          documentation_url: 'https://docs.github.com/rest',
        }));
      }
      return jsonRes(204, '');
    }
    return jsonRes(DISPATCH_STATUS, DISPATCH_STATUS === 204 ? '' : (DISPATCH_BODY || 'refused'));
  }
  return jsonRes(404, 'unexpected ' + u);
};

const FN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'editorial_cron', 'index.ts');

(async function () {
  let mod;
  try {
    mod = await import(FN);
  } catch (e) {
    console.log('SKIP | editorial cron | the deployed function could not be imported: '
      + (e && e.message));
    console.log('       (needs Node 22+ native TypeScript type stripping)');
    process.exit(0);
  }
  const run = mod.run;
  chk('the deployed function exports its decision', typeof run === 'function');
  if (typeof run !== 'function') { process.exit(1); }

  function reset() {
    SETTINGS_ROWS = [{ dispatcher_enabled: true, editorial_enabled: true }];
    HEARTBEAT_ROWS = [];
    DISPATCH_STATUS = 204;
    DISPATCH_BODY = '';
    REJECT_UNKNOWN_INPUTS = false;
    SEEN.length = 0;
    ENV.EDITORIAL_GH_TOKEN = 'gh-token';
  }

  /* ==================================================================== */
  section('1. IT POKES THE ONE CANONICAL DISPATCHER');
  /* ==================================================================== */
  reset();
  let out = await run();
  chk('a clear run dispatches', out.ok === true, JSON.stringify(out));
  eq('and says so', out.action, 'dispatched');
  const poke = SEEN.filter(s => s.url.endsWith('/dispatches'))[0];
  chk('it called workflow_dispatch', !!poke);
  chk('on the configured repository and workflow',
    poke && poke.url === 'https://api.github.com/repos/owner/repo/actions/workflows/editorial.yml/dispatches',
    poke && poke.url);
  eq('with POST', poke && poke.method, 'POST');
  const body = JSON.parse((poke && poke.body) || '{}');
  eq('on the right ref', body.ref, 'main');
  eq('and it identifies itself as the primary scheduler', body.inputs.source, 'supabase_cron');

  /* IT NEVER RUNS THE PIPELINE ITSELF. The whole design rests on there being
     exactly one editorial pipeline; a second one here would be worse than a
     late article. */
  chk('it makes no attempt to generate or publish anything',
    !SEEN.some(s => /site_articles|snapshots|articles\/data/.test(s.url)),
    SEEN.map(s => s.url).join(' '));

  /* ==================================================================== */
  section('2. A MISSING TOKEN IS NOT A SUCCESS');
  /* ==================================================================== */
  reset();
  ENV.EDITORIAL_GH_TOKEN = '';
  out = await run();
  chk('no token fails', out.ok === false);
  eq('and names the reason', out.action, 'no_token');
  chk('explaining what is missing', /EDITORIAL_GH_TOKEN/.test(out.reason), out.reason);
  chk('and it did not pretend to dispatch',
    !SEEN.some(s => s.url.endsWith('/dispatches')));

  /* ==================================================================== */
  section('3. THE OPERATOR PAUSE IS HONOURED HERE TOO');
  /* ==================================================================== */
  reset();
  SETTINGS_ROWS = [{ dispatcher_enabled: false, editorial_enabled: true }];
  out = await run();
  eq('a disabled dispatcher is not poked', out.action, 'paused');
  chk('which is not an error', out.ok === true);
  chk('and nothing was dispatched', !SEEN.some(s => s.url.endsWith('/dispatches')));

  /* A SETTINGS READ THAT FAILS MUST NOT STOP SCHEDULING. The pipeline reads
     settings itself and will pause if it must; refusing to schedule on a
     transient read failure would turn a blip into an outage. */
  reset();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    if (String(u).includes('editorial_settings')) throw new Error('settings unreachable');
    return realFetch(u, i);
  };
  out = await run();
  eq('a settings read failure still schedules', out.action, 'dispatched');
  globalThis.fetch = realFetch;

  /* ==================================================================== */
  section('4. IT DOES NOT STAMPEDE');
  /* ==================================================================== */
  reset();
  HEARTBEAT_ROWS = [{ id: 1, started_at: new Date().toISOString(), scheduler_source: 'github_schedule' }];
  out = await run();
  eq('a run already in flight is not duplicated', out.action, 'debounced');
  chk('which is not an error', out.ok === true);
  chk('and it says what it saw',
    /github_schedule/.test(out.reason) && /debounce/.test(out.reason), out.reason);
  chk('nothing was dispatched', !SEEN.some(s => s.url.endsWith('/dispatches')));

  /* THE DEBOUNCE IS A WINDOW, not a permanent stop. */
  reset();
  HEARTBEAT_ROWS = [];          /* the query filters by time; an empty result means none recent */
  out = await run();
  eq('with no recent heartbeat it dispatches again', out.action, 'dispatched');
  const hb = SEEN.filter(s => s.url.includes('editorial_heartbeats'))[0];
  chk('and the debounce query is bounded by time',
    hb && /started_at=gte\./.test(hb.url), hb && hb.url);

  /* ==================================================================== */
  section('5. A REFUSED DISPATCH IS REPORTED, NOT SWALLOWED');
  /* ==================================================================== */
  reset();
  DISPATCH_STATUS = 403;
  out = await run();
  chk('a 403 is a failure', out.ok === false);
  eq('reported as an error', out.action, 'error');
  chk('with the status', /403/.test(out.reason), out.reason);
  chk('and the body for diagnosis', !!out.detail);

  reset();
  DISPATCH_STATUS = 404;
  out = await run();
  chk('so is a 404 — a wrong repo or workflow name must not look like success',
    out.ok === false && out.action === 'error');

  /* ==================================================================== */
  section('6. A WORKFLOW THAT PREDATES THE `source` INPUT STILL GETS POKED');
  /* ==================================================================== */
  /* THE DEPLOYMENT GAP, and it is not hypothetical: the `source` input and
     this function were added in the same change, so between deploying the
     function and merging that change the workflow on `main` does not accept
     the input. GitHub answers 422 to every tick, and a scheduler that is
     permanently dead over a metadata field is the exact failure this function
     exists to remove. */
  reset();
  REJECT_UNKNOWN_INPUTS = true;
  out = await run();
  eq('it still dispatches', out.action, 'dispatched');
  chk('and reports success', out.ok === true, JSON.stringify(out));

  const tries = SEEN.filter(s => s.url.endsWith('/dispatches'));
  eq('it tried twice', tries.length, 2);
  const first = JSON.parse(tries[0].body || '{}');
  const second = JSON.parse(tries[1].body || '{}');
  eq('the first attempt carried the source', first.inputs && first.inputs.source, 'supabase_cron');
  chk('the retry dropped the inputs entirely',
    second.inputs === undefined, JSON.stringify(second));
  eq('and kept the ref', second.ref, 'main');

  /* THE FALLBACK IS NOT SILENT. A worse heartbeat is the cost; an operator
     who cannot see that the workflow is behind would never fix it. */
  chk('the reason says the input was dropped', /source/.test(out.reason), out.reason);
  chk('and names the ref whose workflow is behind', /main/.test(out.reason), out.reason);

  /* A 422 THAT IS NOT AN INPUT MISMATCH IS STILL AN ERROR. Retrying a
     disabled or non-existent workflow without inputs would fail identically
     and cost a second call to say so. */
  reset();
  DISPATCH_STATUS = 422;
  DISPATCH_BODY = JSON.stringify({ message: 'Workflow does not have workflow_dispatch trigger' });
  out = await run();
  chk('an unrelated 422 is reported', out.ok === false && out.action === 'error',
    JSON.stringify(out));
  chk('with the body', /workflow_dispatch trigger/.test(String(out.detail)), out.detail);
  eq('and it did not retry', SEEN.filter(s => s.url.endsWith('/dispatches')).length, 1);

  /* ------------------------------------------------------------------ */
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | editorial cron | '
    + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ' assertions'));
  if (fail) { failures.forEach(f => console.log('  ×  ' + f)); process.exit(1); }
})();

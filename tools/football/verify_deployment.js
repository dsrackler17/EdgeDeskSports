#!/usr/bin/env node
/* ============================================================================
   IS THE FIX DEPLOYED, OR DID A PULL REQUEST MERGE?

   Those are different questions and this repository has answered the second
   one for the first several times. `football/fbs/slate.json` on the live site
   carried `weather: FETCH_FAILED — HTTP 403 x8` on seventy-four games for
   days: the merge was fine, the code was fine, and the ARTIFACT was written
   by a build that ran somewhere open-meteo was blocked and then published its
   own blindness. Nothing in the pipeline was looking at what was actually
   served.

   So this reads the DEPLOYED artifacts — over the network by default, from
   disk with --local — and asserts the things that are only true when the fix
   is live:

     1  the slate carries a confidence ledger, and it adds up
     2  no field's OBSERVATION time was reset by a re-read: an artifact
        rebuilt without new data keeps the observation times it had
     3  the weather rows are not a build's own network failure published as a
        fact about the sport — a FETCH_FAILED on nearly every game, with an
        identical HTTP status, is a build environment and is called one
     4  the market block never claims a price is live using the MODEL's clock
     5  no win probability is published as 100% or 0%
     6  the availability layer publishes the policy state for each fixture,
        so "no report" is one of five specific statements rather than a shrug

   AND IT MUST NOT MAKE THE MISTAKE IT EXISTS TO CATCH. A reader that cannot
   reach the site has learned nothing about the site. An earlier version of
   this file printed "the deployed artifact does not carry what the
   repository says it does" when the fetch was refused at THIS end — the same
   category of error as publishing a blocked host as a forecast. A transport
   failure is now a third outcome with its own exit code, and the one
   discriminator that actually exists is used before deciding: ask the host
   for something else. If the host answers and the artifact does not, the
   artifact really is missing. If the host does not answer either, it is the
   reader that is broken and nothing has been established.

     exit 0   read, and it carries the fixes
     exit 1   read, and it does NOT — a real deployment failure
     exit 2   NOT READ — nothing established either way

     node tools/football/verify_deployment.js [--base https://edgedesksports.com]
          [--local] [--root DIR] [--json]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_BASE = 'https://edgedesksports.com';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}

const checks = [];
let unreadable = null;
function chk(name, ok, detail) { checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail }); }

async function load(rel, base, local, root) {
  if (local) {
    try { return { ok: true, json: JSON.parse(fs.readFileSync(path.join(root || ROOT, rel), 'utf8')), from: rel }; }
    catch (e) { return { ok: false, why: String((e && e.message) || e), from: rel }; }
  }
  const url = base.replace(/\/$/, '') + '/' + rel;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status, from: url };
    return { ok: true, json: await r.json(), from: url };
  } catch (e) { return { ok: false, why: String((e && e.message) || e), from: url }; }
}

/* ask the host for something other than the artifact. this is the only
   evidence available locally about WHICH end failed, so it is gathered
   before anything is claimed. */
async function reachable(base) {
  const url = base.replace(/\/$/, '') + '/';
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { ok: r.ok, status: r.status, from: url };
  } catch (e) { return { ok: false, status: null, why: String((e && e.message) || e), from: url }; }
}

/* the whole decision, as a function, so it can be tested without a network:
   MISSING only when the host demonstrably answered. */
function diagnose(probe) { return (probe && probe.ok) ? 'MISSING' : 'UNREADABLE'; }

async function main() {
  const base = String(arg('base', DEFAULT_BASE));
  const local = !!arg('local', false);
  const rootArg = arg('root', null);
  const root = (typeof rootArg === 'string') ? path.resolve(rootArg) : null;
  const asJson = !!arg('json', false);

  const slate = await load('football/fbs/slate.json', base, local, root);
  if (!slate.ok) {
    if (local) {
      /* a path on disk that does not parse is a fact about the file, not
         about a network, so it is reported as the failure it is */
      chk('the deployed slate is readable', false, slate.from + ' — ' + slate.why);
      return report(asJson);
    }
    const probe = await reachable(base);
    if (diagnose(probe) === 'UNREADABLE') {
      unreadable = { base, artifact: slate.why, artifact_url: slate.from,
        control: probe.status ? ('HTTP ' + probe.status) : String(probe.why || 'no answer') };
      return report(asJson);
    }
    chk('the deployed slate is readable', false, slate.from + ' — ' + slate.why
      + ' (the host itself answered HTTP ' + probe.status + ', so the artifact really is absent)');
    return report(asJson);
  }
  chk('the deployed slate is readable', true, slate.from);
  const games = slate.json.games || [];
  chk('it carries games', games.length > 0, games.length);

  /* ---- 1. the ledger is deployed and it adds up --------------------- */
  const withLedger = games.filter(g => g.confidence_ledger);
  chk('every projected game carries a confidence ledger',
    withLedger.length === games.filter(g => g.model_status === 'PREDICTED').length,
    withLedger.length + ' of ' + games.filter(g => g.model_status === 'PREDICTED').length);
  const badLedger = withLedger.filter(g => g.confidence_ledger.reconciles
    && g.confidence_ledger.reconciles.agrees === false);
  chk('every deployed ledger reconciles to 100', badLedger.length === 0,
    badLedger.slice(0, 3).map(g => g.home_team + ': ' + JSON.stringify(g.confidence_ledger.reconciles)));
  const noName = withLedger.filter(g => (g.confidence_ledger.scoreboard || {}).information_confidence == null);
  chk('and each publishes the five numbers under their own names', noName.length === 0, noName.length);

  /* ---- 2. observation times were not reset by a re-read -------------- */
  let reset = 0, sampled = 0;
  withLedger.forEach(g => {
    (g.input_contract || []).forEach(r => {
      if (!r.as_of || !r.observed_at) return;
      sampled++;
      /* a retrieval must never be EARLIER than the observation it carries,
         and an observation stamped at the build minute on a field nothing
         refreshed is the reset this check exists for */
      if (Date.parse(r.observed_at) > Date.parse(r.as_of) + 60000) reset++;
    });
  });
  chk('no contract row claims an observation newer than its own retrieval', reset === 0,
    reset + ' of ' + sampled + ' rows');

  /* ---- 3. a build's own network failure is not published as weather -- */
  const wx = [];
  games.forEach(g => (g.input_contract || []).forEach(r => { if (r.field === 'weather') wx.push(r); }));
  const failed = wx.filter(r => r.state === 'FETCH_FAILED');
  const sameStatus = {};
  failed.forEach(r => { const m = String(r.detail || '').match(/HTTP \d+/); if (m) sameStatus[m[0]] = (sameStatus[m[0]] || 0) + 1; });
  const worstStatus = Object.keys(sameStatus).sort((a, b) => sameStatus[b] - sameStatus[a])[0] || null;
  const epidemic = worstStatus && sameStatus[worstStatus] >= Math.max(5, wx.length * 0.5);
  chk('the weather rows are not one build’s blocked host published as a fact about the sport',
    !epidemic,
    epidemic ? (sameStatus[worstStatus] + ' of ' + wx.length + ' weather rows carry the same ' + worstStatus
      + ' — that is a build environment, not a forecast provider') : (failed.length + ' failed of ' + wx.length));
  const carried = wx.filter(r => /CARRIED FORWARD/.test(String(r.detail || '')));
  chk('and a carried forecast states its real observation age', carried.every(r => r.age_hours != null),
    carried.length + ' carried');

  /* ---- 4. the market never borrows the model's clock ----------------- */
  const fresh = games.map(g => g.freshness).filter(Boolean);
  chk('the slate publishes a freshness block with two clocks', fresh.length > 0, fresh.length);
  const borrowed = fresh.filter(f => f.market && f.market.captured_at
    && f.market.captured_at === f.model_built_at);
  chk('no market block reports the model build time as a capture time', borrowed.length === 0, borrowed.length);
  const claimsLive = games.filter(g => /LIVE/i.test(String(g.market_status || ''))
    && !(g.quote_timestamp));
  chk('nothing claims a live market without a quote timestamp', claimsLive.length === 0,
    claimsLive.slice(0, 3).map(g => g.home_team));

  /* ---- 5. no published certainty ------------------------------------ */
  const priced = games.filter(g => typeof g.model_home_win_prob === 'number');
  chk('the slate publishes a win probability at all', priced.length > 0, priced.length);
  const certain = priced.filter(g => g.model_home_win_prob === 1 || g.model_home_win_prob === 0);
  chk('no game publishes a win probability of exactly 1 or 0', certain.length === 0,
    certain.map(g => g.home_team));
  /* THE REPRODUCTION CASE: a probability of 0.9977 printed as "100%". */
  const rounded = priced.filter(g => (g.model_home_win_text === '100%' || g.model_away_win_text === '100%'
    || g.model_home_win_text === '0%' || g.model_away_win_text === '0%')
    && g.model_home_win_prob > 0 && g.model_home_win_prob < 1);
  chk('and no interior probability is RENDERED as 100% or 0%', rounded.length === 0,
    rounded.map(g => g.away_team + ' @ ' + g.home_team + ' ' + g.model_home_win_prob));
  chk('every priced game carries the bounded text beside the raw number',
    priced.every(g => !!g.model_home_win_text && !!g.model_away_win_text),
    priced.filter(g => !g.model_home_win_text).length);

  /* ---- 6. the availability policy state is deployed ------------------ */
  const avRows = [];
  games.forEach(g => (g.input_contract || []).forEach(r => { if (r.field === 'availability') avRows.push(r); }));
  const states = {};
  avRows.forEach(r => { states[r.state] = (states[r.state] || 0) + 1; });
  chk('the availability rows use the policy states, not one undifferentiated gap',
    Object.keys(states).length > 1, states);
  const shrug = avRows.filter(r => r.state === 'UNAVAILABLE' && !r.detail);
  chk('no availability row is a bare shrug', shrug.length === 0, shrug.length);

  return report(asJson);
}

function report(asJson) {
  if (unreadable) {
    if (asJson) console.log(JSON.stringify({ ok: false, verified: false, unreachable: unreadable, checks: [] }, null, 1));
    else {
      console.log('\nEdgeDesk deployment verification');
      console.log('  NOT VERIFIED — the deployment could not be READ from here.');
      console.log('    ' + unreadable.artifact_url + '  ' + unreadable.artifact);
      console.log('    ' + unreadable.base.replace(/\/$/, '') + '/  answered ' + unreadable.control
        + ' as well, so it is this READER that is blocked, not the deployment that is wrong.');
      console.log('  Nothing about the deployed artifact has been established, in either direction. Saying');
      console.log('  otherwise would be the exact mistake this tool exists to catch: a host you could not');
      console.log('  reach is not a fact about the thing behind it.');
      console.log('  To verify anyway, fetch the artifact where it IS reachable and re-read it from disk:');
      console.log('    curl -o /tmp/v/football/fbs/slate.json \\');
      console.log('      https://raw.githubusercontent.com/<owner>/<repo>/<deployed-sha>/football/fbs/slate.json');
      console.log('    node tools/football/verify_deployment.js --local --root /tmp/v');
    }
    return 2;
  }
  const failed = checks.filter(c => !c.ok);
  if (asJson) console.log(JSON.stringify({ ok: failed.length === 0, verified: true, checks }, null, 1));
  else {
    console.log('\nEdgeDesk deployment verification');
    checks.forEach(c => console.log('  ' + (c.ok ? 'ok   ' : 'FAIL ') + c.name
      + (c.detail == null ? '' : '  — ' + JSON.stringify(c.detail))));
    console.log(failed.length ? '\n' + failed.length + ' check(s) failed: the deployed artifact does not carry '
      + 'what the repository says it does.' : '\nthe deployed artifact carries the fixes.');
  }
  return failed.length ? 1 : 0;
}

if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error(String((e && e.stack) || e)); process.exit(2); });
module.exports = { main, diagnose };

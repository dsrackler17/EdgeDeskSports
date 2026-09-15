#!/usr/bin/env node
/* ============================================================================
   THE DEPLOYMENT VERIFIER MUST NOT MAKE THE MISTAKE IT EXISTS TO CATCH.

   verify_deployment.js was written because a build published its own blocked
   host as a fact about the sport: seventy-four games carried
   `weather: FETCH_FAILED — HTTP 403` and the site reported that as what the
   weather was. The tool asserts, against the SERVED artifact, that this and
   five other classes of dishonesty are gone.

   Then the tool did it too. Run from a session whose egress refuses
   edgedesksports.com, it printed

     FAIL the deployed slate is readable — HTTP 403
     1 check(s) failed: the deployed artifact does not carry what the
     repository says it does.

   which is false, and false in the same direction: a refusal at the READER's
   end was reported as a fact about the deployment. The artifact was fine.

   So this test holds two things.

   FIRST, that every check actually catches its violation. A verifier that
   passes a corrupted artifact is worse than none, so each fixture below
   breaks exactly one rule and must be named by the check that owns it.
   These are the rules stale, missing and unverified data must not be able to
   slip past.

   SECOND, and the reason this file exists at all: that "I could not read it"
   is a THIRD outcome, never the second. The discriminator is tested against
   real sockets — a host that answers and withholds the artifact means the
   artifact is absent; a host that answers nothing at all means nothing has
   been learned.
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const CLI = path.join(__dirname, 'verify_deployment.js');
const { diagnose } = require('./verify_deployment.js');

let checks = 0, failures = 0;
function ok(cond, what) { checks++; if (cond) return; failures++; console.error('  FAIL: ' + what); }
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n' + t); }

/* ---- a slate that is telling the truth ---------------------------------
   Deliberately minimal and deliberately VALID: every mutation below starts
   here, so a fixture that fails does so for the one reason it was given. */
const BUILT = '2026-09-15T18:00:00Z';
function cleanGame(i) {
  return {
    home_team: 'Home' + i, away_team: 'Away' + i, model_status: 'PREDICTED',
    market_status: 'LIVE', quote_timestamp: '2026-09-15T17:30:00Z',
    model_home_win_prob: 0.62 - i * 0.05, model_home_win_text: '62%', model_away_win_text: '38%',
    freshness: { model_built_at: BUILT, market: { captured_at: '2026-09-15T17:30:00Z', age_hours: 0.5 } },
    confidence_ledger: {
      reconciles: { displayed: 73.1, lost: 26.9, agrees: true },
      scoreboard: { information_confidence: 73.1, priced_coverage: 48.2, contract_fields: '11 of 17',
        evidence_quality: 61.0, sample_sufficiency: 80.4 }
    },
    input_contract: [
      { field: 'weather', state: 'USABLE', detail: 'forecast 61F wind 5mph',
        as_of: '2026-09-15T17:55:00Z', observed_at: '2026-09-15T17:00:00Z', age_hours: 1 },
      { field: 'availability', state: (i % 2 ? 'NOT_REQUIRED' : 'NOT_DUE_YET'),
        detail: (i % 2 ? 'non-conference game; the policy covers conference games only'
                       : 'the filing window opens Wednesday'),
        as_of: '2026-09-15T17:55:00Z', observed_at: '2026-09-15T17:55:00Z' }
    ]
  };
}
function cleanSlate() { return { games: [0, 1, 2, 3, 4, 5].map(cleanGame) }; }

let tmpRoot = null;
function fixture(name, mutate) {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edverify-'));
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, 'football', 'fbs'), { recursive: true });
  const slate = cleanSlate();
  if (mutate) mutate(slate);
  fs.writeFileSync(path.join(dir, 'football', 'fbs', 'slate.json'), JSON.stringify(slate));
  return dir;
}
function runLocal(dir) {
  const r = spawnSync(process.execPath, [CLI, '--local', '--root', dir, '--json'], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* leave null; the assertion reports it */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
/* NOT spawnSync. Section 4 stands up an HTTP server IN THIS PROCESS, and a
   synchronous spawn blocks the event loop that server runs on — the child's
   connection is never accepted, every request times out, and the test would
   "prove" the tool cannot tell an answering host from a silent one by making
   sure no host ever answers. */
function runNet(base, extra) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, '--base', base].concat(extra || []), { encoding: 'utf8' });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) { /* leave null */ }
      resolve({ code, json, stdout, stderr });
    });
  });
}
function named(res, fragment) {
  return !!(res.json && (res.json.checks || []).some(c => !c.ok && c.name.indexOf(fragment) >= 0));
}

/* ═══ 1. an honest artifact passes ═══════════════════════════════════════ */
section('1. an artifact that is telling the truth is verified, and says so');
{
  const res = runLocal(fixture('clean'));
  eq(res.code, 0, 'a clean slate exits 0');
  ok(res.json && res.json.ok === true, 'and reports ok');
  ok(res.json && res.json.verified === true, 'and records that it actually READ something');
  ok(res.json && res.json.checks.length >= 15, 'and ran the whole battery, not a subset');
}

/* ═══ 2. every check catches its own violation ═══════════════════════════
   One rule broken per fixture, and the check that owns it must be the one
   that fires. A verifier nobody has watched go red is a decoration. */
section('2. each violation is caught, by the check that owns it');
const VIOLATIONS = [
  ['a ledger that does not reconcile', 'reconciles to 100',
    s => { s.games[2].confidence_ledger.reconciles = { displayed: 73, lost: 20, agrees: false }; }],
  ['a predicted game with no ledger at all', 'carries a confidence ledger',
    s => { delete s.games[1].confidence_ledger; }],
  ['a ledger that hides the five numbers', 'under their own names',
    s => { s.games[0].confidence_ledger.scoreboard = {}; }],
  ['an observation stamped later than the retrieval that carried it', 'newer than its own retrieval',
    s => { s.games[0].input_contract[0].observed_at = '2026-09-15T23:00:00Z'; }],
  ['a build’s blocked host published as the weather', 'blocked host published as a fact',
    s => { s.games.slice(0, 5).forEach(g => { g.input_contract[0].state = 'FETCH_FAILED';
      g.input_contract[0].detail = 'HTTP 403'; }); }],
  ['a carried forecast that will not state its age', 'states its real observation age',
    s => { s.games[0].input_contract[0].detail = 'CARRIED FORWARD from the 12:00 run';
      delete s.games[0].input_contract[0].age_hours; }],
  ['a market that borrows the model’s clock', 'model build time as a capture time',
    s => { s.games[3].freshness.market.captured_at = BUILT; }],
  ['a LIVE market with nothing behind it', 'live market without a quote timestamp',
    s => { delete s.games[4].quote_timestamp; }],
  ['a published certainty', 'exactly 1 or 0',
    s => { s.games[0].model_home_win_prob = 1; }],
  ['THE REPRODUCTION CASE — 0.9977 rendered as 100%', 'RENDERED as 100% or 0%',
    s => { s.games[0].model_home_win_prob = 0.9977; s.games[0].model_home_win_text = '100%';
      s.games[0].model_away_win_text = '0%'; }],
  ['a probability with no bounded text beside it', 'bounded text beside the raw number',
    s => { delete s.games[2].model_home_win_text; }],
  ['availability flattened to one undifferentiated gap', 'not one undifferentiated gap',
    s => { s.games.forEach(g => { g.input_contract[1].state = 'UNAVAILABLE'; }); }],
  ['an availability row that is a bare shrug', 'bare shrug',
    s => { s.games[1].input_contract[1].state = 'UNAVAILABLE';
      delete s.games[1].input_contract[1].detail; }],
  ['a slate with no games in it', 'it carries games', s => { s.games = []; }]
];
VIOLATIONS.forEach(([what, fragment, mutate], i) => {
  const res = runLocal(fixture('v' + i, mutate));
  eq(res.code, 1, what + ' — exits 1');
  ok(named(res, fragment), what + ' — is named by the check that owns it (' + fragment + ')');
  ok(res.json && res.json.verified === true,
    what + ' — and is reported as READ AND WRONG, not as unreadable');
});

/* ═══ 3. the discriminator, as a function ════════════════════════════════ */
section('3. which end failed is decided on evidence, not on assumption');
eq(diagnose({ ok: true, status: 200 }), 'MISSING',
  'a host that answers, withholding only the artifact, means the artifact is absent');
eq(diagnose({ ok: false, status: 403 }), 'UNREADABLE', 'a refusal establishes nothing');
eq(diagnose({ ok: false, status: null, why: 'fetch failed' }), 'UNREADABLE', 'and neither does silence');
eq(diagnose(null), 'UNREADABLE', 'and no probe at all is the least evidence of the three');

/* ═══ 4. the same decision, end to end, over real sockets ════════════════ */
section('4. and end to end, against a host that answers and one that does not');
(async function () {
  /* 4a. nothing listening: BOTH the artifact and the control fail. The tool
     must refuse to conclude anything — this is the case that was reported as
     a missing fix, and the reason this file exists. */
  {
    const res = await runNet('http://127.0.0.1:1', ['--json']);
    eq(res.code, 2, 'an unreachable host exits 2 — a third outcome, not a failure of the deployment');
    ok(res.json && res.json.verified === false, 'and records that nothing was verified');
    ok(res.json && !!res.json.unreachable, 'and says which reader failed and how');
    ok(res.json && (res.json.checks || []).length === 0,
      'and asserts NOTHING about an artifact it never read');
    const plain = await runNet('http://127.0.0.1:1');
    ok(/NOT VERIFIED/.test(plain.stdout), 'the human-readable form leads with NOT VERIFIED');
    ok(!/does not carry what the repository says/.test(plain.stdout),
      'and never says the deployment lacks the fix');
    ok(/--local --root/.test(plain.stdout), 'and names the way to verify it anyway');
  }

  /* 4b. a host that answers / and 404s the artifact. THAT is a deployment
     that really is missing its artifact, and must be called one. */
  const srv = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); return; }
    res.writeHead(404); res.end('no');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  {
    const res = await runNet('http://127.0.0.1:' + port, ['--json']);
    eq(res.code, 1, 'a host that answers but withholds the slate is a real deployment failure');
    ok(named(res, 'the deployed slate is readable'), 'and the readable check is the one that fails');
    ok(res.json && /really is absent/.test(JSON.stringify(res.json)),
      'and the detail states the evidence: the host itself answered');
  }
  srv.close();

  /* 4c. a local path that does not exist is a fact about DISK, and stays a
     plain failure — the third outcome is about networks, not about typos. */
  {
    const res = runLocal(path.join(tmpRoot, 'no-such-dir'));
    eq(res.code, 1, 'a missing local artifact is a plain failure, not an unreachable host');
    ok(res.json && res.json.verified === true, 'and is not dressed up as "nothing was established"');
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks
    : 'deployment verification: ' + checks + ' passed, 0 failed'));
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  process.exit(failures ? 1 : 0);
})();

#!/usr/bin/env node
/* ===========================================================================
   The doctor's verdicts, on responses it cannot reach in CI.

   Its whole job is to tell apart things that look the same from outside —
   deployed-but-stale from not-deployed, a missing table from a table RLS
   refused, an absent artifact from a proxy answering 403 on its behalf. Each
   of those confusions would send an operator to do the wrong thing, so each
   one is pinned here against a stubbed network.

   Run: node tools/intelligence/deploy_doctor.test.js
   =========================================================================== */
'use strict';
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const D = require('./deploy_doctor.js');
const WANT = D.expectedBuild();

/* The healthy answer from capture's auth gate: a 401 saying it HOLDS a secret
   and refused a caller that did not match. Appended to every table below as a
   default so the fifteen cases that are about something else keep their old
   verdicts; a test that is about capture's own secret lists its own entry,
   which is matched first. */
const CAPTURE_ARMED = ['/functions/v1/capture',
  { status: 401, body: '{"ok":false,"error":"unauthorized","reason":"the x-cron-secret header did not match CRON_SECRET."}' }];

/** Answer every URL from a table of {match: response}. */
function net(table) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [frag, res] of [...table, CAPTURE_ARMED]) {
      if (u.indexOf(frag) >= 0) {
        if (res.throw) throw new Error(res.throw);
        return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => res.body || '' };
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}
const stateOf = (r, name) => (r.checks.find((c) => c.name === name) || {}).state;
const detailOf = (r, name) => (r.checks.find((c) => c.name === name) || {}).detail || '';
const OPTS = { url: 'https://p.test', key: 'k', site: 'https://s.test' };
const probeBody = (over) => JSON.stringify(Object.assign({
  ok: true, build: WANT, decisions_enabled: true, intelligence_loaded: true, intelligence_version: 1,
  env: { anthropic_key: true },
}, over || {}));
const OK_ARTIFACTS = [
  ['/football/fbs/slate.json', { status: 200, body: '{"games":[{},{}]}' }],
  ['/football/availability/current.json', { status: 200, body: '{"teams":{"a":{}},"generated_at":"2026-09-14T12:00:00Z"}' }],
];
/** One signal row: captured `ageMin` ago, for a game `kickHrs` from now. */
const signals = (ageMin, kickHrs) => ['/rest/v1/signals', { status: 200, body: JSON.stringify([{
  last_seen_at: new Date(Date.now() - ageMin * 60000).toISOString(),
  commence_time: new Date(Date.now() + kickHrs * 3600000).toISOString(),
  sport_key: 'americanfootball_ncaaf', market: 'spreads',
}]) }];
/* A board captured 40 minutes ago for a game six days out: healthy on any
   rung, so it never decides the verdict in tests about something else. */
const OK_BOARD = signals(40, 144);

(async function main() {
  /* --- IS ANYTHING FILLING THE BOARD? ---------------------------------
     Every other check here answers "is the right code deployed". Capture was
     never scheduled at all, which none of them could see, so a customer found
     it instead: a price captured 2,345 minutes before they were shown it. */
  {
    const base = [['?probe=1', { status: 200, body: probeBody() }],
      ['recommendation_ledger?select=correction_reason', { status: 200, body: '[]' }],
      ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS];
    const board = async (row) => stateOf(await (net([...base, row]), D.doctor(OPTS)), 'the board is being captured');

    eq('a board captured 40 minutes ago for a game six days out is current',
      await board(signals(40, 144)), 'CURRENT');
    eq('the same 40-minute age is STALE twenty minutes before kickoff',
      await board(signals(40, 0.33)), 'STALE');
    eq('the 39-hour board production served is STALE',
      await board(signals(2345, 60)), 'STALE');
    eq('a board with no upcoming game on it at all is EMPTY',
      await board(['/rest/v1/signals', { status: 200, body: '[]' }]), 'EMPTY');

    net([...base, signals(2345, 60)]);
    let s = await D.doctor(OPTS);
    eq('a stale board makes the whole verdict actionable', s.verdict, 'ACTION NEEDED');
    chk('and the fix names the scheduler rather than the function',
      /capture_cron\.sql/.test((s.checks.find((c) => c.name === 'the board is being captured') || {}).fix || ''),
      (s.checks.find((c) => c.name === 'the board is being captured') || {}).fix);

    net([...base, ['/rest/v1/signals', { status: 401, body: 'permission denied' }]]);
    s = await D.doctor(OPTS);
    eq('a key that may not read signals reports UNKNOWN rather than guessing',
      stateOf(s, 'the board is being captured'), 'UNKNOWN');
  }

  /* --- IS CAPTURE REFUSING ITS CALLERS, OR IS NOBODY CALLING? ----------
     Identical from the signals table, opposite fixes. A function deployed
     without CRON_SECRET 401s pg_cron and the workflow alike, and every other
     check in this file reads healthy while the board empties. */
  {
    const base = [['?probe=1', { status: 200, body: probeBody() }],
      ['recommendation_ledger?select=correction_reason', { status: 200, body: '[]' }],
      ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS];
    const NO_SECRET = ['/functions/v1/capture', { status: 401, body: JSON.stringify({
      ok: false, error: 'unauthorized',
      reason: 'CRON_SECRET is not set on this function, so every caller is rejected including the scheduler. '
        + 'Capture has not run since the variable went missing.' }) }];

    net([...base, OK_BOARD, NO_SECRET]);
    let s = await D.doctor(OPTS);
    eq('a capture holding no CRON_SECRET is reported even while the board still looks fresh',
      stateOf(s, 'capture can accept its scheduler'), 'MISSING');
    eq('and that alone makes the verdict actionable', s.verdict, 'ACTION NEEDED');
    chk('and the fix names the function secret, not the scheduler',
      /supabase secrets set CRON_SECRET/.test((s.checks.find((c) => c.name === 'capture can accept its scheduler') || {}).fix || ''),
      (s.checks.find((c) => c.name === 'capture can accept its scheduler') || {}).fix);

    net([...base, OK_BOARD]);
    s = await D.doctor(OPTS);
    eq('a capture that refuses a mismatched secret is ARMED, not broken',
      stateOf(s, 'capture can accept its scheduler'), 'ARMED');
    eq('and an armed capture over a fresh board stays clean', s.verdict, 'DEPLOYED AND CURRENT');

    /* The pairing that matters: board stale AND capture armed means the fault
       is the caller, and the stale fix must send the operator to the caller. */
    net([...base, signals(2345, 60)]);
    s = await D.doctor(OPTS);
    eq('a stale board beside an armed capture still reports ARMED',
      stateOf(s, 'capture can accept its scheduler'), 'ARMED');
    chk('and the stale fix points at the capture check before the cron table',
      /next check first/.test((s.checks.find((c) => c.name === 'the board is being captured') || {}).fix || ''),
      (s.checks.find((c) => c.name === 'the board is being captured') || {}).fix);

    net([...base, OK_BOARD, ['/functions/v1/capture', { status: 404, body: 'not found' }]]);
    eq('a capture that is not deployed at all is NOT_DEPLOYED, not a secret problem',
      stateOf(await D.doctor(OPTS), 'capture can accept its scheduler'), 'NOT_DEPLOYED');

    net([...base, OK_BOARD, ['/functions/v1/capture', { throw: 'network unreachable' }]]);
    eq('an unreachable capture is UNKNOWN rather than an accusation',
      stateOf(await D.doctor(OPTS), 'capture can accept its scheduler'), 'UNKNOWN');
  }

  chk('the expected build is read from the function source', /^edgedesk_ai-\d{4}-/.test(String(WANT)), WANT);

  /* ---- everything deployed and current -------------------------------- */
  net([['?probe=1', { status: 200, body: probeBody() }],
    ['recommendation_ledger?select=correction_reason', { status: 200, body: '[]' }],
    ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  let r = await D.doctor(OPTS);
  eq('a deployed, current, migrated project is reported as such', r.verdict, 'DEPLOYED AND CURRENT');
  eq('the function is DEPLOYED', stateOf(r, 'edgedesk_ai deployed'), 'DEPLOYED');
  eq('the build is CURRENT', stateOf(r, 'deployed build matches this checkout'), 'CURRENT');
  eq('the ledger is APPLIED', stateOf(r, 'recommendation_ledger applied'), 'APPLIED');
  eq('the corrections are APPLIED', stateOf(r, 'official-correction columns applied'), 'APPLIED');

  /* ---- THE CENTRAL CONFUSION: merged but not deployed ------------------ */
  net([['?probe=1', { status: 200, body: probeBody({ build: 'edgedesk_ai-2026-09-03-r5-presentation' }) }],
    ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('an older build serving is STALE, not missing', stateOf(r, 'deployed build matches this checkout'), 'STALE');
  chk('and both builds are named so the gap is obvious',
    /r5-presentation/.test(detailOf(r, 'deployed build matches this checkout'))
    && detailOf(r, 'deployed build matches this checkout').indexOf(WANT) >= 0,
    detailOf(r, 'deployed build matches this checkout'));
  eq('which is action, not an unknown', r.verdict, 'ACTION NEEDED');

  net([['?probe=1', { status: 404, body: 'not found' }], ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('a 404 on the function is NOT_DEPLOYED', stateOf(r, 'edgedesk_ai deployed'), 'NOT_DEPLOYED');
  chk('and names the command that fixes it',
    /supabase functions deploy edgedesk_ai/.test((r.checks.find((c) => c.name === 'edgedesk_ai deployed') || {}).fix || ''));

  /* ---- a missing table vs a table RLS refused -------------------------- */
  net([['?probe=1', { status: 200, body: probeBody() }],
    ['recommendation_ledger', { status: 404, body: '{"message":"relation \\"public.recommendation_ledger\\" does not exist"}' }],
    ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('an absent table is NOT_APPLIED', stateOf(r, 'recommendation_ledger applied'), 'NOT_APPLIED');
  chk('and says what it costs, not just that it is absent',
    /going unrecorded/.test(detailOf(r, 'recommendation_ledger applied')), detailOf(r, 'recommendation_ledger applied'));

  net([['?probe=1', { status: 200, body: probeBody() }],
    ['recommendation_ledger', { status: 401, body: 'permission denied' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('a table row-level security refused is APPLIED, not missing',
    stateOf(r, 'recommendation_ledger applied'), 'APPLIED');

  /* ---- the migration half-applied -------------------------------------- */
  net([['?probe=1', { status: 200, body: probeBody() }],
    ['recommendation_ledger?select=correction_reason', { status: 400, body: '{"code":"42703","message":"column recommendation_ledger.correction_reason does not exist"}' }],
    ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('a ledger without the correction columns is caught', stateOf(r, 'official-correction columns applied'), 'NOT_APPLIED');
  chk('and the fix says the migration is safe to re-run',
    /idempotent/.test((r.checks.find((c) => c.name === 'official-correction columns applied') || {}).fix || ''));

  /* ---- THE MISTAKE THE DOCTOR ITSELF MADE ------------------------------ */
  net([['?probe=1', { status: 200, body: probeBody() }], ['recommendation_ledger', { status: 200, body: '[]' }],
    ['/football/', { status: 403, body: 'forbidden' }]]);
  r = await D.doctor(OPTS);
  eq('a 403 on an artifact is UNKNOWN, because a proxy said no — not the file',
    stateOf(r, 'FBS slate artifact published'), 'UNKNOWN');
  chk('and it says so rather than sending anyone to republish',
    /refused rather than absent/.test(detailOf(r, 'FBS slate artifact published')));
  net([['?probe=1', { status: 200, body: probeBody() }], ['recommendation_ledger', { status: 200, body: '[]' }],
    ['/football/', { status: 404, body: 'nope' }]]);
  r = await D.doctor(OPTS);
  eq('a 404 on an artifact IS missing', stateOf(r, 'FBS slate artifact published'), 'MISSING');

  /* ---- the things a deployed build can still be wrong about ------------ */
  net([['?probe=1', { status: 200, body: probeBody({ decisions_enabled: false }) }],
    ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('a switched-off decision layer is reported', stateOf(r, 'decision layer'), 'DISABLED');
  chk('with what it means for the reader',
    /recommends nothing/.test(detailOf(r, 'decision layer')), detailOf(r, 'decision layer'));

  net([['?probe=1', { status: 200, body: probeBody({ env: { anthropic_key: false } }) }],
    ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('a deployment with no model key is caught before a user finds it',
    stateOf(r, 'model credential configured on the deployment'), 'ABSENT');
  chk('and no secret VALUE is ever in the report',
    JSON.stringify(r).indexOf('anthropic_key') < 0 || !/sk-|eyJ/.test(JSON.stringify(r)));

  net([['?probe=1', { status: 200, body: probeBody({ intelligence_loaded: false, intelligence_version: null }) }],
    ['recommendation_ledger', { status: 200, body: '[]' }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor(OPTS);
  eq('a current build that lost the kernel is caught',
    stateOf(r, 'intelligence kernel loaded in the deployed build'), 'ABSENT');

  /* ---- no credential is UNKNOWN, never a guess ------------------------- */
  net([['?probe=1', { status: 200, body: probeBody() }], ...OK_ARTIFACTS, OK_BOARD]);
  r = await D.doctor({ url: 'https://p.test', key: '', site: 'https://s.test' });
  eq('without a key the ledger question is UNKNOWN, not assumed',
    stateOf(r, 'recommendation_ledger applied'), 'UNKNOWN');
  eq('and the overall verdict says so', r.verdict, 'INCOMPLETE');

  /* ---- an unreachable project is not a broken one ---------------------- */
  net([['?probe=1', { throw: 'network unreachable' }], ['recommendation_ledger', { throw: 'network unreachable' }],
    ['/football/', { throw: 'network unreachable' }]]);
  r = await D.doctor(OPTS);
  eq('an unreachable project reports UNKNOWN throughout', r.verdict, 'INCOMPLETE');
  chk('and never claims anything is not deployed',
    r.checks.every((c) => c.state !== 'NOT_DEPLOYED' && c.state !== 'NOT_APPLIED'), r.checks.map((c) => c.state));

  done();
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });

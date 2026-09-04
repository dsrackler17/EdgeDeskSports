#!/usr/bin/env node
/* ===========================================================================
   Tests for the research page's "Sync to Collective (API)" button -- the NFL
   and Power 4 boards in app.html posting straight to collective_ingest under
   a creator's own submission key.

   THE RULE THESE ARE BUILT AROUND: the Collective shows and grades each
   model's LATEST submission received before the lock, thirty minutes before
   kickoff. A post therefore replaces this model's stored rows on every game
   that has not locked, by itself. So a sync is a dry run, ONE confirmation
   that says exactly that, and a post -- and it never asks the store to
   delete anything.

   That matters because of what a sync used to be. collective.projections is
   append-only in the DATABASE and the ingest API's retract route removes
   rows with an ordinary PostgREST DELETE, so every retract was refused:

     retract_failed: Removed 0 row(s), then a chunk failed: DELETE projections
     failed: 400 {"code":"P0001",...,"message":"collective.projections is
     append-only (rule 8.3); use the service maintenance path"}

   Under the first-submission rule that refusal meant a corrected board could
   never reach the wall. Under the lock rule the retract is simply not part
   of a sync. The standalone retract button keeps its guard against that
   refusal, byte for byte, and is tested here too.

   The functions under test are read out of app.html itself rather than
   copied, so this cannot pass against a copy that has drifted. If the markers
   move, the slice fails loudly instead of testing nothing.

   Run: node tools/collective/app_sync.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) {
    console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 400) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- the code under test, cut out of the page that ships it ------------ */
const APP = path.join(__dirname, '..', '..', 'app.html');
const START = "var FBP4_INGEST_BASE=SB_URL+'/functions/v1/collective_ingest';";
const END = '/* Dry run, then post — never post without the dry run passing first.';
function sliceApp() {
  const src = fs.readFileSync(APP, 'utf8');
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error('app.html no longer contains the collective-sync block between its markers '
      + '(' + (a < 0 ? 'start' : 'end') + ' missing). Re-point START/END at the real code rather '
      + 'than letting this suite pass against nothing.');
  }
  const code = src.slice(a, b);
  ['window.fbNflApiSync=async function(){', 'window.fbP4ApiSync=async function(){',
   'window.fbP4ApiRetract=async function(){', 'function fbRetractBlockedBy']
    .forEach(function (needle) {
      if (code.indexOf(needle) < 0) throw new Error('the slice is missing ' + needle);
    });
  return code;
}

/* ---- the browser the page thinks it is running in ---------------------- */
const OUT = { fbnflPostOut: '', fbp4PostOut: '' };
global.document = { getElementById: id => (id in OUT
  ? { set innerHTML(v) { OUT[id] = v; }, get innerHTML() { return OUT[id]; } }
  : null) };
const KEY = 'mck_live_' + 'A'.repeat(40);
let keyStore = {};
global.localStorage = {
  getItem: k => (k in keyStore ? keyStore[k] : null),
  setItem: (k, v) => { keyStore[k] = String(v); },
  removeItem: k => { delete keyStore[k]; }
};
global.prompt = () => KEY;
global.alert = m => { LOG.alerts.push(m); };
let ANSWERS = [];
const LOG = { confirms: [], alerts: [], reqs: [] };
global.confirm = m => { LOG.confirms.push(m); return ANSWERS.length ? ANSWERS.shift() : true; };
global.window = global;

/* Everything the sync block reaches for that lives elsewhere in app.html.
   None of it is what is being tested: the board's numbers are stubbed so the
   flow, not the football, is what these assertions are about. */
global.SB_URL = 'https://collective.invalid';
global.fbEsc = x => String(x == null ? '' : x);
global.fbWireRowSelfConsistent = () => true;
global.fbP4LineSanity = () => null;
global.fbP4Request = () => ({});
global.fbP4Market = () => ({});
global.FB_LOOKAHEAD_D = 12;
global.FB = { scope: 'auto', nfl: { curSeason: 2026, games: [] }, p4: { season: 2026, up: [{ g: { week: 1 } }] } };

/* ---- a fake collective_ingest ----------------------------------------- */
/* Byte for byte what the live database sent back, hint and all. A guard
   written against a paraphrase is a guard against nothing. */
const APPEND_ONLY = 'Removed 0 row(s), then a chunk failed: DELETE projections failed: 400 '
  + '{"code":"P0001","details":null,"hint":null,"message":"collective.projections is append-only '
  + '(rule 8.3); use the service maintenance path"} — if projections is a view, the delete needs '
  + "its base table's name. Re-running is safe: it only removes what is still there.";

let SERVER = {};
const reply = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body))
});
const refuseAppendOnly = () => reply(400, { error: { code: 'retract_failed', message: APPEND_ONLY } });
global.fetch = function (url, init) {
  const route = String(url).replace(/^.*collective_ingest/, '');
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
  LOG.reqs.push({ route, confirm: !!(body && body.confirm) });
  if (route === '/v1/me') return reply(200, {
    creator: { slug: 'edgedesk' }, key: { kind: 'live' },
    models: [{ model: 'edgedesk-nfl', sport: 'NFL' }, { model: 'edgedesk-cfb', sport: 'CFB' }]
  });
  if (route === '/v1/projections/dry-run') return reply(200, { rejected: 0, rows: [] });
  if (route === '/v1/projections/retract') {
    return (body && body.confirm) ? SERVER.retract() : reply(200, SERVER.preview);
  }
  if (route === '/v1/projections') return reply(200, SERVER.post);
  return reply(404, { error: { code: 'not_found', message: 'no route' } });
};

/* Posting to the Collective is an operator-only surface (see edIsOwner in
   app.html): the buttons are drawn only for an operator and the handlers
   refuse anyone else. This suite exercises the operator path, so it says so. */
global.edIsOwner = () => true;

vm.runInThisContext(sliceApp(), { filename: 'app.html [collective sync]' });

/* The wire builders read a live board. What they return is not the subject
   here -- that the slate reaches the endpoint at all is. */
const ROWS = [{ game_ref: 'g1', home_team: 'B', away_team: 'A', week: 1, projected_spread: -3 }];
global.fbNflWireRows = () => ({ rows: ROWS, skipped: [], inconsistent: [] });
global.fbP4WireRows = () => ({ rows: ROWS, skipped: [], inconsistent: [] });

function setup(o) {
  o = o || {};
  OUT.fbnflPostOut = ''; OUT.fbp4PostOut = '';
  LOG.confirms = []; LOG.alerts = []; LOG.reqs = [];
  ANSWERS = o.answers || [];
  SERVER = {
    preview: o.preview || { would_remove: 12, games: [{ game_id: 'g1', label: 'A @ B' }] },
    retract: o.retract || refuseAppendOnly,
    post: o.post || { resolved: 12, first: 0, movement: 12 }
  };
  keyStore = { edgedesk_collective_key: KEY };
  global.FB_RETRACT_BLOCKED = null;
  global.FBP4_MODEL_CACHE = null;
  global.FBNFL_MODEL_CACHE = null;
}
const posts = () => LOG.reqs.filter(r => r.route === '/v1/projections').length;
const removals = () => LOG.reqs.filter(r => r.route === '/v1/projections/retract' && r.confirm).length;

(async function () {

/* ---- a sync is a dry run, one confirmation, and a post ----------------- */
setup({ answers: [true] });
await window.fbNflApiSync();
chk('an NFL slate reaches the Collective', posts() === 1, { posts: posts(), said: OUT.fbnflPostOut.slice(0, 300) });
chk('a sync never asks the store to delete anything',
  LOG.reqs.filter(r => r.route === '/v1/projections/retract').length === 0,
  { reqs: LOG.reqs.map(r => r.route) });
chk('and asks the operator exactly once', LOG.confirms.length === 1, { confirms: LOG.confirms.length });
chk('the confirmation says the post replaces what was posted before, until the lock',
  /replacing anything you posted before/.test(LOG.confirms[0] || '')
  && /lock 30 minutes before kickoff/.test(LOG.confirms[0] || ''),
  { asked: (LOG.confirms[0] || '').slice(0, 300) });
chk('and never promises a first submission or warns of a revision',
  !/first submission/i.test(LOG.confirms[0] || '') && !/REVISION/.test(LOG.confirms[0] || ''));
chk('the receipt says the wall shows this slate now',
  /The wall shows THIS slate now/.test(OUT.fbnflPostOut), { said: OUT.fbnflPostOut.slice(0, 300) });
chk('and says how many numbers it replaced',
  /12 numbers you had posted before were replaced/.test(OUT.fbnflPostOut), { said: OUT.fbnflPostOut.slice(0, 400) });
chk('the counts are stated as new and replaced, not first submissions and revisions',
  /0 new, 12 replaced/.test(OUT.fbnflPostOut) && !/revisions/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 300) });
chk('nothing on the receipt says the wall did not change',
  !/Posted as a revision/.test(OUT.fbnflPostOut) && !/first-submission slot/.test(OUT.fbnflPostOut));

setup({ answers: [true] });
await window.fbP4ApiSync();
chk('a Power 4 board reaches the Collective the same way',
  posts() === 1 && LOG.confirms.length === 1
  && LOG.reqs.filter(r => r.route === '/v1/projections/retract').length === 0,
  { posts: posts(), said: OUT.fbp4PostOut.slice(0, 300) });
chk('with the same receipt', /The wall shows THIS slate now/.test(OUT.fbp4PostOut),
  { said: OUT.fbp4PostOut.slice(0, 300) });

/* ---- the operator can still say no ------------------------------------- */
setup({ answers: [false] });
await window.fbNflApiSync();
chk('declining posts nothing', posts() === 0);
setup({ answers: [false] });
await window.fbP4ApiSync();
chk('the Power 4 board can decline as well', posts() === 0);

/* ---- a first post, and a post of games that had already locked --------- */
setup({ answers: [true], post: { resolved: 12, first: 12, movement: 0 } });
await window.fbNflApiSync();
chk('a first post is still "the wall shows this slate", with nothing replaced',
  /The wall shows THIS slate now/.test(OUT.fbnflPostOut) && !/replaced and stored/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 300) });

setup({ answers: [true], post: { resolved: 9, first: 0, movement: 9, late: 3 } });
await window.fbNflApiSync();
chk('rows that arrived after the lock are named as not counting',
  /3 rows arrived after their games locked/.test(OUT.fbnflPostOut)
  && /stored late, never graded/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 500) });

setup({ answers: [true], post: { resolved: 0, first: 0, movement: 0, late: 4 } });
await window.fbP4ApiSync();
chk('an all-late post does not claim the wall shows it',
  !/The wall shows THIS slate now/.test(OUT.fbp4PostOut) && /4 rows arrived after their games locked/.test(OUT.fbp4PostOut),
  { said: OUT.fbp4PostOut.slice(0, 500) });

/* ---- a dry run that would reject stops before the confirmation --------- */
const rejecting = global.fetch;
global.fetch = function (url, init) {
  const route = String(url).replace(/^.*collective_ingest/, '');
  if (route === '/v1/projections/dry-run') {
    LOG.reqs.push({ route, confirm: false });
    return reply(200, { rejected: 1, rows: [{ status: 'rejected', game_ref: 'g1', reason: 'bad row' }] });
  }
  return rejecting(url, init);
};
setup({ answers: [true] });
await window.fbNflApiSync();
chk('a slate that would be rejected is not confirmed and not posted',
  posts() === 0 && LOG.confirms.length === 0 && /would be rejected/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 300) });
chk('and the refusal no longer talks about a retract',
  !/retract/i.test(OUT.fbnflPostOut), { said: OUT.fbnflPostOut.slice(0, 300) });
global.fetch = rejecting;

/* ---- the standalone retract button still survives the append-only rule - */
setup({ answers: [true] });
await window.fbP4ApiRetract();
chk('the retract button asks once and is refused once',
  LOG.confirms.length === 1 && removals() === 1, { confirms: LOG.confirms.length, removals: removals() });
chk('the refusal is the database rule in words, not a 400 body pasted at the operator',
  /append-only/i.test(OUT.fbp4PostOut) && !/P0001/.test(OUT.fbp4PostOut),
  { said: OUT.fbp4PostOut.slice(0, 300) });
chk('and it says nothing is lost, because posting again replaces the rows',
  /posting again replaces these rows/.test(OUT.fbp4PostOut), { said: OUT.fbp4PostOut.slice(0, 400) });
chk('the retract confirmation no longer promises a first submission',
  !/first submission/i.test(LOG.confirms[0] || ''), { asked: (LOG.confirms[0] || '').slice(0, 300) });
chk('the append-only refusal is remembered', global.FB_RETRACT_BLOCKED === 'append_only');

setup({ answers: [true] });
await window.fbNflApiSync();
chk('and a sync after it still posts, still without a retract',
  posts() === 1 && removals() === 0);

/* ---- a customer cannot post, even reaching the handler directly -------- */
/* The buttons are not drawn for them; this proves the handler itself refuses,
   so a stale render, a deep link or a console call cannot post as EdgeDesk. */
global.edIsOwner = () => false;
setup({ answers: [true] });
await window.fbNflApiSync();
chk('a non-operator calling the NFL sync posts nothing', posts() === 0, { posts: posts() });
chk('and is never even asked to confirm', LOG.confirms.length === 0, { confirms: LOG.confirms.length });
setup({ answers: [true] });
await window.fbP4ApiSync();
chk('a non-operator calling the Power 4 sync posts nothing', posts() === 0, { posts: posts() });
global.edIsOwner = () => true;   /* back to the operator for anything after */

/* ---- the words the whole product now uses ------------------------------ */
chk('the sync block never mentions the first-submission slot',
  !/first-submission slot/.test(sliceApp()) && !/first submission/i.test(sliceApp()));
chk('the counts helper is what the standalone post button prints too',
  function () {
    const src = fs.readFileSync(APP, 'utf8');
    const i = src.indexOf('window.fbP4ApiPost=async function');
    return i > 0 && /var counts=fbCollectiveCounts\(b\);/.test(src.slice(i, i + 6000));
  });

done();
})().catch(function (e) { console.log('CRASHED: ' + (e && e.stack || e)); process.exit(1); });

#!/usr/bin/env node
/* ===========================================================================
   Tests for the research page's "Sync to Collective (API)" button -- the NFL
   and Power 4 boards in app.html posting straight to collective_ingest under
   a creator's own submission key.

   THE CASE THESE ARE BUILT AROUND, and it is the real one:

     Retract failed - stopped before posting. retract_failed: Removed 0
     row(s), then a chunk failed: DELETE projections failed: 400
     {"code":"P0001",...,"message":"collective.projections is append-only
     (rule 8.3); use the service maintenance path"}

   collective.projections is append-only in the DATABASE. The ingest API's
   retract route removes rows with an ordinary PostgREST DELETE, so a trigger
   refuses it every time -- its dry run counts rows it will never be allowed
   to remove, and the confirmed call comes back having removed nothing.

   Sync used to treat that as fatal and return. The removal had changed
   NOTHING, and the post was still perfectly valid, but it never happened: a
   board whose games already had stored rows could not reach the Collective at
   all. One server-side rule this repo cannot change took both boards offline.

   So what is asserted here is the property, not the wording: a refusal that
   removed nothing must not take the post down with it. The operator is told
   what happened in the database's own terms, asked once, and the slate still
   goes up -- as a revision, said plainly, because the stored rows keep the
   first-submission slot.

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

/* ---- the regression itself: the post survives the refusal -------------- */
setup({ answers: [true, true] });
await window.fbNflApiSync();
chk('an NFL slate still reaches the Collective when the store refuses the delete',
  posts() === 1, { posts: posts(), said: OUT.fbnflPostOut.slice(0, 300) });
chk('the removal is attempted once, not retried against a rule that cannot bend',
  removals() === 1);
chk('the operator is asked before the slate goes up on different terms',
  /were NOT removed/.test(LOG.confirms[1] || '') && /append-only/i.test(LOG.confirms[1] || ''),
  { asked: (LOG.confirms[1] || '').slice(0, 300) });
chk('the receipt says which submission the wall will actually grade',
  /Posted as a revision/.test(OUT.fbnflPostOut) && /first-submission slot/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 300) });
chk('and never claims rows were removed when none were',
  !/already removed/.test(OUT.fbnflPostOut));

setup({ answers: [true, true] });
await window.fbP4ApiSync();
chk('a Power 4 board still reaches the Collective too',
  posts() === 1, { posts: posts(), said: OUT.fbp4PostOut.slice(0, 300) });
chk('with the same revision receipt', /Posted as a revision/.test(OUT.fbp4PostOut),
  { said: OUT.fbp4PostOut.slice(0, 300) });

/* ---- the operator can still say no ------------------------------------- */
setup({ answers: [true, false] });
await window.fbNflApiSync();
chk('declining posts nothing', posts() === 0);
chk('declining says nothing was removed and nothing was posted',
  /nothing removed, nothing posted/i.test(OUT.fbnflPostOut), { said: OUT.fbnflPostOut.slice(0, 300) });
chk('the reason is the database rule in words, not a 400 body pasted at the operator',
  /append-only/i.test(OUT.fbnflPostOut) && !/P0001/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 300) });

setup({ answers: [true, false] });
await window.fbP4ApiSync();
chk('the Power 4 board can decline as well', posts() === 0
  && /nothing removed, nothing posted/i.test(OUT.fbp4PostOut), { said: OUT.fbp4PostOut.slice(0, 300) });

/* ---- one page load, one discovery -------------------------------------- */
setup({ answers: [true, true] });
await window.fbNflApiSync();
LOG.reqs = []; LOG.confirms = []; ANSWERS = [true]; OUT.fbnflPostOut = '';
await window.fbNflApiSync();
chk('a second sync does not ask the store for a delete it has already refused',
  removals() === 0);
chk('and asks the operator once rather than twice',
  LOG.confirms.length === 1, { confirms: LOG.confirms.length });
chk('the one confirmation states the revision up front',
  /REVISION/.test(LOG.confirms[0] || '') && /append-only/i.test(LOG.confirms[0] || ''),
  { asked: (LOG.confirms[0] || '').slice(0, 300) });
chk('and never promises a first submission it cannot deliver',
  !/FIRST submission/.test(LOG.confirms[0] || ''));
chk('the slate still posts', posts() === 1);

/* ---- nothing about the working path changed ---------------------------- */
const worked = () => reply(200, { retracted: 12, note: 'removed' });
setup({ answers: [true], retract: worked, post: { resolved: 12, first: 12, movement: 0 } });
await window.fbNflApiSync();
chk('a retract that works still runs, and still posts after it',
  removals() === 1 && posts() === 1);
chk('still one confirmation on the working path', LOG.confirms.length === 1,
  { confirms: LOG.confirms.length });
chk('which still promises the first submission', /FIRST submission/.test(LOG.confirms[0] || ''));
chk('and the receipt still says the wall grades this slate',
  /grades THIS slate/.test(OUT.fbnflPostOut) && !/Posted as a revision/.test(OUT.fbnflPostOut),
  { said: OUT.fbnflPostOut.slice(0, 300) });

setup({ answers: [true], retract: worked, post: { resolved: 12, first: 12, movement: 0 } });
await window.fbP4ApiSync();
chk('the Power 4 working path is untouched too',
  removals() === 1 && posts() === 1 && /grades THIS slate/.test(OUT.fbp4PostOut),
  { said: OUT.fbp4PostOut.slice(0, 300) });

/* ---- nothing stored, nothing to replace -------------------------------- */
setup({ answers: [true], preview: { would_remove: 0, games: [] },
        post: { resolved: 12, first: 12, movement: 0 } });
await window.fbNflApiSync();
chk('a board with no stored rows never asks for a removal',
  removals() === 0 && posts() === 1);
chk('and is told this is its first submission',
  /first submission/i.test(LOG.confirms[0] || ''), { asked: (LOG.confirms[0] || '').slice(0, 200) });

/* ---- a refusal that is NOT the append-only rule ------------------------ */
setup({ answers: [true, true], retract: () => reply(500, { error: { code: 'boom', message: 'gateway exploded' } }) });
await window.fbNflApiSync();
chk('any other retract failure also stops short of killing the post',
  posts() === 1, { posts: posts() });
chk('and quotes the reason it was actually given',
  /gateway exploded/.test(LOG.confirms[1] || ''), { asked: (LOG.confirms[1] || '').slice(0, 200) });
chk('an unrelated failure is not remembered as the append-only rule',
  global.FB_RETRACT_BLOCKED === null, { remembered: global.FB_RETRACT_BLOCKED });

/* ---- the standalone Retract button ------------------------------------- */
setup({ answers: [true] });
await window.fbP4ApiRetract();
chk('the Retract button explains the refusal instead of pasting the 400 body',
  !/P0001/.test(OUT.fbp4PostOut) && OUT.fbp4PostOut.indexOf('{"code"') < 0,
  { said: OUT.fbp4PostOut.slice(0, 300) });
chk('it names the rule and where removal actually has to happen',
  /append-only/i.test(OUT.fbp4PostOut) && /maintenance path/i.test(OUT.fbp4PostOut),
  { said: OUT.fbp4PostOut.slice(0, 300) });
chk('and says plainly that nothing was retracted',
  /Nothing was retracted/.test(OUT.fbp4PostOut));

/* ---- recognising the refusal by the database's own words --------------- */
chk('the live message is recognised',
  window.fbRetractBlockedBy({ code: 'retract_failed', message: APPEND_ONLY }, '') === 'append_only');
chk('recognised from the raw body when the envelope carries no error object',
  window.fbRetractBlockedBy({}, APPEND_ONLY) === 'append_only');
chk('"append only" unhyphenated is the same rule',
  window.fbRetractBlockedBy({ message: 'this table is append only' }, '') === 'append_only');
chk('the rule number alone is enough',
  window.fbRetractBlockedBy({ message: 'refused: rule 8.3' }, '') === 'append_only');
chk('a timeout is not mistaken for a permanent rule',
  window.fbRetractBlockedBy({ code: 'timeout', message: 'upstream timed out' }, '') === null);
chk('nor is a missing route',
  window.fbRetractBlockedBy({}, 'no route') === null);

done();
})().catch(function (e) {
  console.log('FAIL | the suite could not run  ' + String((e && e.stack) || e));
  process.exit(1);
});

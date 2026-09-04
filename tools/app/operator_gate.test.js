#!/usr/bin/env node
/* ===========================================================================
   Tests for the OPERATOR-ONLY SURFACE GATE.

   Posting EdgeDesk's own slate to the Collective is how the product is RUN,
   not how it is used. A customer has no key for it and no use for it, so it
   is drawn only for an operator.

   What these hold:
     1  a customer sees no Collective posting control, no submission key and
        no paragraph about a pipeline they cannot use;
     2  an operator sees all of it, unchanged;
     3  the two plain exports stay for everyone — the ask was about posting,
        not about taking the board away;
     4  the gate reads the signed-in email and NOTHING a customer can set;
     5  the posting handlers refuse on their own, so a stale render or a
        console call cannot post;
     6  the gate does not pretend to be access control, and the file says so.

   Run: node tools/app/operator_gate.test.js
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
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/* ======================================================================== */
/* 1. THE GATE ITSELF                                                       */
/* ======================================================================== */
const G_START = APP.indexOf('/* ═══ OPERATOR-ONLY SURFACES');
const G_END = APP.indexOf('function edSession(){', G_START);
chk('the gate is found in app.html', G_START >= 0 && G_END > G_START);
const GATE = APP.slice(G_START, G_END);

function gateCtx(email) {
  const c = { console, JSON, String, Array, Error,
    localStorage: { getItem: () => null },
    edUser: () => (email === undefined ? null : { email: email }) };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(GATE + '\nfunction edSession(){return null;}', c, { filename: 'app.html:owner-gate' });
  return c;
}
const OWNERS = (function () {
  const m = /var ED_OWNER_EMAILS=\[([^\]]*)\]/.exec(APP);
  return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
})();
chk('at least one operator email is configured', OWNERS.length >= 1, JSON.stringify(OWNERS));

eq('the configured operator is an owner', gateCtx(OWNERS[0]).edIsOwner(), true);
eq('and matching ignores case', gateCtx(OWNERS[0].toUpperCase()).edIsOwner(), true);
eq('and surrounding whitespace', gateCtx('  ' + OWNERS[0] + ' ').edIsOwner(), true);
eq('any other signed-in customer is not', gateCtx('customer@example.com').edIsOwner(), false);
eq('a signed-out visitor is not', gateCtx(undefined).edIsOwner(), false);
eq('a session with no email is not', gateCtx(null).edIsOwner(), false);
eq('an empty email is not', gateCtx('').edIsOwner(), false);
/* a near-miss must not pass: no prefix, suffix or substring matching */
[OWNERS[0] + '.evil.com', 'x' + OWNERS[0], OWNERS[0].replace('@', '+x@'), OWNERS[0].slice(0, -1)]
  .forEach(e => eq('a near-miss address is not an owner (' + e + ')', gateCtx(e).edIsOwner(), false));
chk('the gate never throws on a broken session',
  gateCtx.call(null, undefined) && (function () {
    const c = { console, JSON, String, Array, Error, localStorage: { getItem: () => null },
      edUser: () => { throw new Error('boom'); } };
    c.window = c; vm.createContext(c);
    vm.runInContext(GATE + '\nfunction edSession(){return null;}', c);
    return c.edIsOwner() === false;
  })());

/* the gate reads identity, not anything a customer controls */
chk('the gate reads the signed-in user', /edUser\(\)/.test(GATE));
['localStorage', 'prefs(', 'location.', 'URLSearchParams', 'document.cookie'].forEach(src =>
  lacks(GATE, src, 'the gate does not read ' + src + ', which a customer could set'));

/* ======================================================================== */
/* 2. IT DOES NOT PRETEND TO BE ACCESS CONTROL                              */
/* ======================================================================== */
has(GATE, 'WHAT THIS IS NOT: access control', 'the gate states plainly what it is not');
has(GATE, 'public static file', 'and why');
has(GATE, 'submission key', 'and names what actually protects posting');

/* ======================================================================== */
/* 3. THE RENDERED ROWS                                                     */
/* ======================================================================== */
function ctlCtx(isOwner) {
  const src = APP.slice(APP.indexOf('function fbP4CtlHTML(){'), APP.indexOf('/* ---- rendering ----'));
  const c = { console, JSON, String, Number, Array, Math, Error,
    FB: { p4: { up: [{}, {}, {}] } },
    FBP4_CSV_HEAD: new Array(80),
    edIsOwner: () => isOwner,
    fbP4KeyMasked: () => 'mck_live_K3e2…1ZSq',
    fbEsc: s => String(s == null ? '' : s),
    fbP4LinesConv: () => 'betting',
    fbP4LineWarnHTML: () => '' };
  c.window = c; vm.createContext(c); vm.runInContext(src, c, { filename: 'app.html:p4-ctl' });
  return c;
}
const CUST = ctlCtx(false).fbP4CtlHTML();
const OWN = ctlCtx(true).fbP4CtlHTML();

/* -- what a customer must NOT see -------------------------------------- */
['Sync to Collective', 'Check via API', 'Download &amp; open dashboard', 'fbP4ApiSync',
 'fbP4ApiPost', 'fbP4PostToCollective', 'Posting to the Collective', 'ingest endpoint',
 'submission key', 'mck_live', 'fbP4KeyForget', 'fbp4PostOut']
  .forEach(t => lacks(CUST, t, 'a customer never sees "' + t + '"'));

/* -- what an operator must still see ----------------------------------- */
['Sync to Collective (API)', 'Check via API', 'Download &amp; open dashboard',
 'Posting to the Collective', 'mck_live', 'forget', 'fbp4PostOut']
  .forEach(t => has(OWN, t, 'an operator still sees "' + t + '"'));

/* -- what BOTH keep: the ask was about posting, not about exports ------- */
['Download Excel', 'CSV (raw)', 'Power 4 game', 'research, unproven'].forEach(t => {
  has(CUST, t, 'a customer keeps "' + t + '"');
  has(OWN, t, 'and so does an operator');
});
has(CUST, 'Taking the board with you', 'a customer gets an explainer for the buttons they DO have');
has(CUST, 'has not validated against a closing line', 'which keeps the honesty of the export');
lacks(CUST, 'Two doors, same pipeline', 'and not the one for the pipeline they do not');
chk('the customer row is materially shorter', CUST.length < OWN.length,
  'customer ' + CUST.length + ' vs operator ' + OWN.length);
chk('and still renders something useful', CUST.length > 400);

/* the NFL row is gated the same way */
const NFLROW = APP.slice(APP.indexOf("var op=edIsOwner();                       /* operator-only"),
                         APP.indexOf('picks + grading, one row per game'));
chk('the NFL row checks the same gate', /var op=edIsOwner\(\)/.test(NFLROW));
chk('its sync button is behind it', /\(op\?'<button class="btn primary sm" onclick="fbNflApiSync\(\)/.test(NFLROW));
chk('its key chip is behind it', /var keyed=op\?fbP4KeyMasked\(\):''/.test(NFLROW));
chk('and its post output too', /\(op\?'<div id="fbnflPostOut"/.test(NFLROW));
has(NFLROW, 'Download Excel', 'while the NFL exports stay for everyone');
has(NFLROW, 'CSV (raw)', 'both of them');

/* ======================================================================== */
/* 4. THE HANDLERS REFUSE ON THEIR OWN                                      */
/* ======================================================================== */
['window.fbNflApiSync=async function(){', 'window.fbP4ApiSync=async function(){',
 'window.fbP4ApiPost=async function(live){', 'window.fbP4PostToCollective=function(){']
  .forEach(sig => {
    const i = APP.indexOf(sig);
    chk('the handler ' + sig.slice(7, 24) + ' exists', i >= 0);
    const body = APP.slice(i, i + 420);
    has(body, 'if(!edIsOwner())return;', 'and refuses when the caller is not an operator');
  });
chk('every Collective posting handler is guarded',
  (APP.match(/if\(!edIsOwner\(\)\)return;/g) || []).length >= 4,
  'found ' + (APP.match(/if\(!edIsOwner\(\)\)return;/g) || []).length);

/* ======================================================================== */
/* 5. NOTHING ELSE WAS HIDDEN                                               */
/* ======================================================================== */
/* the Collective destination itself is a customer feature and stays */
has(APP, 'id="v-collective"', 'the Collective view is untouched');
has(APP, "data-v=\"collective\"", 'and keeps its seat in the nav');
has(APP, 'function loadCollective(', 'and its loader');
/* research surfaces are untouched */
['id="v-research"', 'id="v-football"', 'fbGxSummary', 'fbRkPreviewHTML', 'fbStartHereHTML']
  .forEach(t => has(APP, t, 'untouched: ' + t));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\noperator gate: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* ===========================================================================
   ONE ATTRIBUTION LEDGER, NOT TWO.

   The landing page owns attribution: `attrCapture` in index.html writes
   `edgedesk_attribution`, mirrors a referral code to an `ed_ref` cookie at
   path=/, and `attrPayload()` is what gets written to the database when a
   subscription is created. A partner invoice is reconciled against that record.

   Games writes the SAME record, under the SAME credit rule, so that a visitor
   who lands on /games?utm_source=x and subscribes three weeks later is credited
   by the machinery that already exists.

   This test lifts `attrCapture` straight out of index.html, replays the same
   sequences of visits through both implementations, and fails if the ledger
   they leave behind ever differs.

   Run: node tools/games/attribution_parity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  chk(name, JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const ROOT = path.join(__dirname, '..', '..');
const LANDING = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---- a browser just real enough for both implementations ---------------- */
function makeEnv() {
  const store = {};
  const jar = {};
  const win = {
    localStorage: {
      getItem: k => (store[k] == null ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: {
      get cookie() {
        return Object.keys(jar).map(k => k + '=' + jar[k]).join('; ');
      },
      set cookie(v) {
        const m = String(v).match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1]] = m[2];
      }
    },
    location: { search: '', pathname: '/' }
  };
  return { win, store, jar };
}

/* ---- lift attrCapture out of the landing page --------------------------- */
const START = LANDING.indexOf("var ATTR_KEY='edgedesk_attribution'");
chk('index.html still declares the attribution ledger', START >= 0);
const END = LANDING.indexOf('var ED_ATTR=attrCapture();', START);
chk('index.html still runs attrCapture on load', END > START);
if (START < 0 || END < 0) { report(); process.exit(1); }
const SRC = LANDING.slice(START, END);

function landingCapture(env, search, referrer, pathname) {
  env.win.location = { search: search || '', pathname: pathname || '/' };
  const sandbox = {
    localStorage: env.win.localStorage,
    document: Object.assign(env.win.document, { referrer: referrer || '' }),
    location: env.win.location,
    URLSearchParams: URLSearchParams,
    URL: URL, Date: Date, String: String, JSON: JSON, Math: Math, encodeURIComponent, decodeURIComponent
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\nthis.__cap = attrCapture;', sandbox);
  /* attrPayload reads ED_ATTR, which only exists after capture runs */
  const r = sandbox.__cap();
  return r;
}

/* ---- the games implementation ------------------------------------------- */
function gamesCapture(env, search, referrer, pathname) {
  delete require.cache[require.resolve(path.join(ROOT, 'games', 'lib', 'attribution.js'))];
  const g = { localStorage: env.win.localStorage, document: env.win.document,
    location: { search: search || '', pathname: pathname || '/' } };
  const mod = { exports: {} };
  const src = fs.readFileSync(path.join(ROOT, 'games', 'lib', 'attribution.js'), 'utf8');
  const sandbox = { window: g, module: mod, globalThis: g, Date, String, JSON, Math,
    encodeURIComponent, decodeURIComponent };
  Object.assign(sandbox, g);
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.EDGamesAttribution.capture(search, referrer, pathname);
}

/* ---- the sequences that matter ------------------------------------------ */
const SEQUENCES = [
  { name: 'a plain organic visit',
    visits: [['', '', '/games/']] },
  { name: 'a campaign visit straight to games',
    visits: [['?utm_source=twitter&utm_medium=social&utm_campaign=priceit', '', '/games/']] },
  { name: 'a partner referral',
    visits: [['?ref=golfplatform', '', '/games/']] },
  { name: 'organic first, campaign later — the campaign must claim the visitor',
    visits: [['', 'https://news.example.com/x', '/games/'],
             ['?utm_source=reddit&utm_campaign=week2', '', '/games/price-it/']] },
  { name: 'a credited code is FROZEN against a later different code',
    visits: [['?ref=partnera', '', '/games/'],
             ['?ref=partnerb', '', '/games/']] },
  { name: 'campaign on games, then a bare visit to the landing page',
    visits: [['?utm_source=tiktok&utm_campaign=c1', '', '/games/'],
             ['', '', '/']] },
  { name: 'via and partner are accepted as referral aliases',
    visits: [['?via=someone', '', '/games/']] },
  { name: 'a hostile code is cleaned the same way',
    visits: [['?ref=%3Cscript%3Ealert(1)%3C%2Fscript%3E', '', '/games/']] },
  { name: 'utm_content and aud ride along',
    visits: [['?utm_source=s&utm_content=variantb&aud=golf', '', '/games/']] },
  { name: 'three visits, mixed',
    visits: [['', '', '/'],
             ['?utm_campaign=only_campaign', '', '/games/'],
             ['?utm_source=later', '', '/games/pick-5/']] }
];

SEQUENCES.forEach(seq => {
  const envL = makeEnv(), envG = makeEnv();
  seq.visits.forEach(([q, ref, p]) => {
    landingCapture(envL, q, ref, p);
    gamesCapture(envG, q, ref, p);
  });
  const L = JSON.parse(envL.store['edgedesk_attribution'] || 'null');
  const Gm = JSON.parse(envG.store['edgedesk_attribution'] || 'null');
  /* `seen_at` is a wall clock and will differ by milliseconds; the ledger's
     SHAPE and CREDIT are what must match. */
  const strip = o => {
    if (!o) return o;
    const c = Object.assign({}, o);
    delete c.seen_at; delete c.organic_first_seen_at;
    return c;
  };
  eq(seq.name + ' — the credited first touch matches', strip(Gm), strip(L));
  eq(seq.name + ' — the last-touch record matches',
    strip(JSON.parse(envG.store['edgedesk_attribution_last'] || 'null')),
    strip(JSON.parse(envL.store['edgedesk_attribution_last'] || 'null')));
  eq(seq.name + ' — the ed_ref cookie matches', envG.jar['ed_ref'], envL.jar['ed_ref']);
});

/* ---- the keys themselves must not drift --------------------------------- */
const GA = require(path.join(ROOT, 'games', 'lib', 'attribution.js'));
chk('games writes the landing page’s localStorage key',
  LANDING.indexOf("ATTR_KEY='" + GA.ATTR_KEY + "'") >= 0, GA.ATTR_KEY);
chk('games writes the landing page’s last-touch key',
  LANDING.indexOf("ATTR_LAST='" + GA.ATTR_LAST + "'") >= 0, GA.ATTR_LAST);
chk('games uses the landing page’s cookie TTL',
  LANDING.indexOf('ATTR_TTL_DAYS=' + GA.ATTR_TTL_DAYS) >= 0, String(GA.ATTR_TTL_DAYS));
chk('games mirrors to the same cookie name',
  LANDING.indexOf("'ed_ref='") >= 0
  && fs.readFileSync(path.join(ROOT, 'games', 'lib', 'attribution.js'), 'utf8').indexOf("'ed_ref='") >= 0);

/* ---- Games must never overwrite a partner's code with its own surface ---- */
(() => {
  const JS = fs.readFileSync(path.join(ROOT, 'games', 'games.js'), 'utf8');
  chk('an internal link only adds ref=games when no referral code was credited',
    /if \(!f \|\| !f\.ref\)/.test(JS));
  chk('and the campaign fields are taken from the shared ledger',
    JS.indexOf('AT.linkParams()') >= 0 && JS.indexOf('AT.eventProps()') >= 0);
  const STORE = fs.readFileSync(path.join(ROOT, 'games', 'lib', 'store.js'), 'utf8');
  chk('the store keeps no attribution ledger of its own',
    STORE.indexOf('s.attribution =') < 0);
})();

function report() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | attribution parity | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(f => console.log('  × ' + f));
}
report();
process.exit(fail ? 1 : 0);

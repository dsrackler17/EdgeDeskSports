#!/usr/bin/env node
/* ============================================================================
   THE BRIEF LAYER CAN ACTUALLY REACH THE FOOTBALL MODULE.

   WHAT WENT WRONG, TWICE OVER. brief_research.test.js extracted the research
   builders out of app.html by name and ran them in a flat sandbox. They
   passed 168 checks. They were also completely unreachable in a browser.

   app.html's football engine is an IIFE. A function declared inside it is
   invisible outside it, which is why the module ends with fifty-nine
   `window.fbX = fbX` lines. The three new builders had no such line, so
   EDBRIEF's `researchFor()` hit `if(!window.fbBriefResearch) return null;`
   on its first statement, every game brief silently fell back to the
   market-only page this work exists to replace, and the rankings button
   reported the artifact was not loaded. Nothing threw. Nothing logged. Every
   source-level assertion still passed.

   SO THIS TEST DOES NOT READ THE SOURCE. It EXECUTES the module — the real
   IIFE, out of the real file, in a VM with a stub DOM — and then calls the
   builders through `window`, exactly as the brief layer does. A function
   that is not exported fails here no matter how correct its body is.

   It also holds the general contract, so the next function added to that
   module is checked without anyone remembering to check it: every `window.fb*`
   the rest of the page reaches for must be defined by somebody.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let checks = 0, failures = 0;
function ok(cond, what) { checks++; if (cond) return; failures++; console.error('  FAIL: ' + what); }
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n' + t); }

/* ---- the football module, sliced out of the page ------------------------ */
const marker = 'ADDED: FOOTBALL ENGINE module';
const mi = APP.indexOf(marker);
if (mi < 0) { console.error('app.html no longer carries the football engine module marker'); process.exit(1); }
const mStart = APP.lastIndexOf('<script', mi);
const mEnd = APP.indexOf('</script>', mi);
const MODULE = APP.slice(APP.indexOf('>', mStart) + 1, mEnd);
const REST = APP.slice(0, mStart) + APP.slice(mEnd);

/* ═══ 1. it really is a closed scope ═════════════════════════════════════ */
section('1. the football engine is a closed scope, so reaching in needs an export');
ok(/^\s*(\/\*[\s\S]*?\*\/\s*)?\(function\s*\(\s*\)\s*\{/.test(MODULE),
  'the module body opens as an IIFE — nothing declared inside it is global by default');
ok(/\}\)\(\);\s*(\/\*[\s\S]*?\*\/\s*)*$/.test(MODULE.trim()), 'and closes as one');
const exported = new Set((MODULE.match(/window\.(fb[A-Za-z0-9_]+)\s*=/g) || []).map(s => s.slice(7).replace(/\s*=$/, '')));
ok(exported.size > 40, 'it exports its public surface explicitly (' + exported.size + ' names) — that is the convention this test enforces');

/* ═══ 2. every cross-scope reference resolves ════════════════════════════ */
section('2. every window.fb* the rest of the page reaches for is defined by somebody');
const definedOutside = new Set((REST.match(/window\.(fb[A-Za-z0-9_]+)\s*=/g) || []).map(s => s.slice(7).replace(/\s*=$/, '')));
const referencedOutside = new Set((REST.match(/window\.(fb[A-Za-z0-9_]+)/g) || []).map(s => s.slice(7)));
referencedOutside.forEach(function (name) {
  ok(exported.has(name) || definedOutside.has(name),
    'window.' + name + ' is referenced outside the football module and something defines it');
});
ok(referencedOutside.size > 0, 'the page does reach across the boundary, so this contract is load-bearing');

/* ═══ 3. RUN IT. This is the check the source-level suite could not make ══ */
section('3. the module runs and puts the brief layer\'s entry points on window');
function el() {
  const e = {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    insertAdjacentHTML() {}, focus() {}, click() {}, scrollIntoView() {}
  };
  Object.defineProperty(e, 'innerHTML', { get() { return ''; }, set() {} });
  Object.defineProperty(e, 'textContent', { get() { return ''; }, set() {} });
  return e;
}
const doc = {
  readyState: 'complete', body: el(), head: el(), documentElement: el(), cookie: '', title: '',
  createElement: el, createTextNode: el, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  location: { hash: '#research/football', href: 'https://edgedesksports.com/app.html' }
};
const win = {
  document: doc, location: doc.location, navigator: { userAgent: 'node', language: 'en-US' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  fetch: () => Promise.reject(new Error('this harness does no network')),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, requestAnimationFrame: () => 0,
  console, Math, JSON, Date, RegExp, Intl, URL, URLSearchParams, Promise,
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'),
  Blob: class {}, File: class {}, FileReader: class {}, Worker: class {},
  performance: { now: () => Date.now() }, structuredClone: v => JSON.parse(JSON.stringify(v)),
  Uint8Array, Int8Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
  Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, Error, TypeError, RangeError,
  isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  /* page-level globals from earlier <script> blocks */
  SB_URL: 'https://example.invalid', SB_KEY: 'stub', SB_ANON: 'stub', RESEARCH_MODULES: {},
  supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } } } }, from: () => ({ select: () => ({}) }) }) }
};
win.window = win; win.self = win; win.globalThis = win;
const ctx = vm.createContext(win);
/* Anything else the page defines elsewhere gets an empty stub and the module
   is re-run: what is under test is whether the export statements execute, not
   whether a stub can be a browser. */
let threw = null, stubbed = [];
for (let i = 0; i < 40; i++) {
  threw = null;
  try { vm.runInContext(MODULE, ctx, { filename: 'app.html#football-module' }); break; }
  catch (e) {
    threw = e;
    const m = /^(\w[\w$]*) is not defined$/.exec(e.message || '');
    if (!m) break;
    win[m[1]] = {}; stubbed.push(m[1]);
  }
}
if (stubbed.length) console.log('  (stubbed page globals: ' + stubbed.join(', ') + ')');
ok(!threw, 'the module runs to completion' + (threw ? ' — threw: ' + (threw.message || threw) : ''));

/* the three the brief layer names, and two that already worked, as controls */
[['fbBriefResearch', 'the game research builder'],
 ['fbBriefRankings', 'the week\'s rankings builder'],
 ['fbRkEnsure', 'the rankings artifact loader'],
 ['fbRkTab', 'the rankings tab switch (control — this one always worked)'],
 ['fbGxScore', 'the projected-score split (control)']].forEach(function (pair) {
  eq(typeof win[pair[0]], 'function', 'window.' + pair[0] + ' — ' + pair[1] + ' — is reachable from outside the module');
});

/* ═══ 4. and they work when called the way EDBRIEF calls them ════════════ */
section('4. called through window, on the committed artifact, they return real work');
if (typeof win.fbBriefResearch === 'function' && win.FB && win.FB.rk) {
  win.FB.rk.data = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));

  const res = win.fbBriefResearch({ home: 'Miami', away: 'Florida A&M' });
  ok(!!res, 'a half-rated matchup returns a research block rather than null');
  if (res) {
    ok(res.table.rows.length >= 20, 'it carries every ranked component as a row (' + res.table.rows.length + ')');
    ok(!!res.state && !!res.state.label, 'and says where the game stands');
    ok(res.missing.length > 0, 'and names what it could not measure');
    ok(!/\b(null|undefined|NaN)\b/.test(JSON.stringify(res.headline) + JSON.stringify(res.notes)),
      'with no stringified nothing in its prose');
  }

  const both = win.fbBriefResearch({ home: 'Texas Tech', away: 'Utah' });
  ok(!!both && both.table.rows.every(function (r) { return r.a != null || r.h != null || /Δ/.test(r.k); }),
    'a fully rated matchup fills both columns');

  const rk = win.fbBriefRankings({ top: 25 });
  ok(!!rk, 'the rankings builder returns a payload rather than null');
  if (rk) {
    eq(rk.rows.length, 25, 'a Top 25 has 25 rows');
    ok(rk.spotlights.length >= 1, 'and at least one team is explained');
    ok(rk.columns.indexOf('SPECIAL TEAMS') >= 0, 'special teams is a column');
  }
  eq(typeof win.fbRkEnsure, 'function', 'and openGame can await the loader before it draws');
} else {
  ok(false, 'the module did not expose fbBriefResearch, so nothing downstream could be exercised');
}

/* ═══ 5. the callers name exactly these symbols ══════════════════════════ */
section('5. the brief layer asks for the names the module exports');
[['researchFor', /if\(!window\.fbBriefResearch\) return null;/],
 ['openGame', /window\.fbRkEnsure && !\(window\.FB&&FB\.rk&&FB\.rk\.data\)/],
 ['openRankings', /window\.fbBriefRankings\?window\.fbBriefRankings\(/]].forEach(function (pair) {
  ok(pair[1].test(REST), pair[0] + ' reaches across the boundary by the exported name');
});

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks : 'PASS — ' + checks + ' checks'));
process.exit(failures ? 1 : 0);

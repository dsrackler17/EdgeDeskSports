'use strict';
/* ============================================================================
   RUN THE REAL FOOTBALL MODULE.

   WHY THIS FILE EXISTS. app.html's football engine is an IIFE. The first
   generation of these tests pulled functions out of it BY NAME with a regex
   and ran the text in a flat sandbox. That sandbox passed 168 checks on code
   that was completely unreachable in a browser, because nothing had added the
   `window.fbX = fbX` line the brief layer needed. The test was measuring a
   copy of the code, not the code.

   So every football test now boots the ACTUAL module: the real script block,
   sliced out of the real file, executed in a VM with a stub DOM, and reached
   through `window` exactly as the page reaches it. A function that is not
   exported is not reachable here either.

   THE PROBE. A few assertions have to see inside the closure — that the game
   brief's ratings are read through the same FBRK_FIELD map the board reads,
   for instance. `probe` appends ONE line INSIDE the IIFE, just before it
   closes, binding those names onto `window.__FBTEST`. The module under test
   is otherwise byte-for-byte the shipped one, and nothing is added to the
   production export surface to make a test possible.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

/* the football engine's script block, out of the page */
function moduleSource(root) {
  const APP = fs.readFileSync(path.join(root || ROOT, 'app.html'), 'utf8');
  const marker = 'ADDED: FOOTBALL ENGINE module';
  const mi = APP.indexOf(marker);
  if (mi < 0) throw new Error('app.html no longer carries the football engine module marker');
  const ms = APP.lastIndexOf('<script', mi), me = APP.indexOf('</script>', mi);
  return { app: APP, module: APP.slice(APP.indexOf('>', ms) + 1, me),
    rest: APP.slice(0, ms) + APP.slice(me) };
}

function stubElement() {
  const e = { style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    insertAdjacentHTML() {}, focus() {}, click() {}, scrollIntoView() {} };
  Object.defineProperty(e, 'innerHTML', { get() { return ''; }, set() {} });
  Object.defineProperty(e, 'textContent', { get() { return ''; }, set() {} });
  return e;
}

function stubWindow() {
  const doc = { readyState: 'complete', body: stubElement(), head: stubElement(),
    documentElement: stubElement(), cookie: '', title: '',
    createElement: stubElement, createTextNode: stubElement, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    location: { hash: '#research/football', href: 'https://edgedesksports.com/app.html' } };
  const win = { document: doc, location: doc.location, navigator: { userAgent: 'node', language: 'en-US' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    fetch: () => Promise.reject(new Error('this harness does no network')),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, requestAnimationFrame: () => 0,
    console, Math, JSON, Date, RegExp, Intl, URL, URLSearchParams, Promise,
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Blob: class {}, File: class {}, FileReader: class {}, Worker: class {},
    performance: { now: () => Date.now() }, structuredClone: v => JSON.parse(JSON.stringify(v)),
    Uint8Array, Int8Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
    Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, Error, TypeError, RangeError,
    isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    /* page-level globals defined by earlier <script> blocks */
    SB_URL: 'https://example.invalid', SB_KEY: 'stub', SB_ANON: 'stub', RESEARCH_MODULES: {},
    supabase: { createClient: () => ({
      auth: { getSession: async () => ({ data: { session: null } }),
        onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
      from: () => ({ select: () => ({}) }) }) } };
  win.window = win; win.self = win; win.globalThis = win;
  return win;
}

/* Boot the module. Returns { win, module, rest, app, stubbed, error }. */
function boot(opts) {
  opts = opts || {};
  const root = opts.root || ROOT;
  const src = moduleSource(root);
  let code = src.module;
  if (opts.probe && opts.probe.length) {
    const close = code.lastIndexOf('})();');
    if (close < 0) throw new Error('the football module no longer closes as an IIFE');
    const line = '\nwindow.__FBTEST={' + opts.probe.map(n => n + ':' + n).join(',') + '};\n';
    code = code.slice(0, close) + line + code.slice(close);
  }
  const win = stubWindow();
  vm.createContext(win);
  const stubbed = [];
  let error = null;
  for (let i = 0; i < 60; i++) {
    error = null;
    try { vm.runInContext(code, win, { filename: 'app.html#football-module' }); break; }
    catch (e) {
      error = e;
      const m = /^(\w[\w$]*) is not defined$/.exec(e.message || '');
      if (!m) break;
      win[m[1]] = {}; stubbed.push(m[1]);
    }
  }
  if (!error && !opts.noRankings) {
    win.FB.rk.data = JSON.parse(fs.readFileSync(path.join(root, 'football', 'rankings', 'current.json'), 'utf8'));
  }
  return { win: win, module: src.module, rest: src.rest, app: src.app, stubbed: stubbed, error: error, root: root };
}

/* The committed Power 4 engine and its trained parameters, into the same
   context — the two files fbP4Ensure() fetches in a browser. */
function loadEngine(win, root) {
  root = root || ROOT;
  vm.runInContext(fs.readFileSync(path.join(root, 'football', 'cfb_p4', 'params.js'), 'utf8'), win, { filename: 'params.js' });
  win.module = { exports: {} };
  vm.runInContext(fs.readFileSync(path.join(root, 'football', 'cfb_p4', 'engine.js'), 'utf8'), win, { filename: 'engine.js' });
  delete win.module;
  if (!win.EDCfbP4 || !win.EDCfbP4Params) throw new Error('the Power 4 engine loaded but its globals are missing');
  return win.EDCfbP4;
}

/* Put ONE upcoming game on the board. NOTHING IS PROJECTED HERE: the board's
   projection cache is left empty on purpose so that the module's own
   fbBrProjection() assembles the request through its own fbP4Request() and
   calls the engine itself. A harness that built the request would be testing
   its own copy of the wiring, which is the mistake this file exists to stop.
   `market_spread` joins a line the way cfb.lines does; omit it for a game no
   book has posted. */
function stageGame(win, opts) {
  const S = win.FB.p4;
  const g = {
    game_id: opts.game_id || 'TEST1', season: opts.season || 2026, week: opts.week == null ? 3 : opts.week,
    start_date: opts.start_date || '2026-09-19T23:30:00.000Z', completed: false,
    neutral_site: !!opts.neutral_site, conference_game: !!opts.conference_game,
    venue_id: opts.venue_id == null ? null : opts.venue_id, venue: opts.venue || 'Test Stadium',
    home_team: opts.home, home_conference: opts.home_conference || 'ACC', home_division: opts.home_division || 'fbs',
    away_team: opts.away, away_conference: opts.away_conference || 'ACC', away_division: opts.away_division || 'fbs',
    home_points: null, away_points: null
  };
  const u = { g: g, t: Date.parse(g.start_date) };
  if (!S.state) S.state = win.EDCfbP4.newState();
  S.season = g.season;
  S.up = [u];
  S.schedIdx = S.schedIdx || {};
  S.lines = S.lines || {};
  S.sig = S.sig || {};
  S.weather = S.weather || {};
  S.roster = S.roster || {};
  S._proj = {};
  if (opts.market_spread != null) {
    S.lines[g.game_id] = { game_id: g.game_id, provider: 'consensus', spread: opts.market_spread,
      over_under: opts.market_total == null ? null : opts.market_total };
  } else {
    delete S.lines[g.game_id];
  }
  S.loadedAt = Date.now();
  return u;
}

module.exports = { ROOT, boot, loadEngine, stageGame, moduleSource, stubWindow, stubElement };

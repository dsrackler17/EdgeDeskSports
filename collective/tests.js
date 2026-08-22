#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Model Collective — tests for the slate upload path.

   This file exists because a College Football CSV upload died on
   "WEEK_NAMES is not defined" — a reference left behind when the flat NFL week
   list became a per-sport calendar. Nothing caught it, because the dashboard
   is a single self-contained HTML page with no suite at all. A page that
   accepts a creator's file and posts it under their name needs one.

   Two passes, both offline and both fast:

     1. A STATIC scan for identifiers the script references but never declares.
        That is the exact class of bug that produced the crash, and it is
        catchable without a browser.
     2. BEHAVIOURAL checks of the pure upload functions, driven by a real
        80-column EdgeDesk CFB export, run inside a small DOM shim.

   Run:  node collective/tests.js

   There is also an end-to-end harness that drives the REAL dashboard in
   Chromium — real file input, real buttons, backend stubbed so the exact POST
   body can be inspected. It needs playwright and a static server, so it is not
   part of this suite; see the PR for the recipe. This file is what runs
   anywhere node does.
   =========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var HERE = __dirname;
var PAGE = path.join(HERE, 'index.html');
var pass = 0, fail = 0, failures = [];

function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name: name, detail: detail });
}
function near(a, b, eps) {
  return typeof a === 'number' && typeof b === 'number'
    && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
}

/* ---- the page's one inline script ------------------------------------- */
var html = fs.readFileSync(PAGE, 'utf8');
var blocks = [];
var re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, m;
while ((m = re.exec(html)) !== null) if (m[1].trim()) blocks.push(m[1]);
chk('the dashboard page has exactly one inline script', blocks.length === 1,
  { found: blocks.length });
var CODE = blocks.join('\n;\n');

/* =======================================================================
   1. STATIC: every referenced identifier must be declared somewhere.
   ======================================================================= */
(function staticScan() {
  /* A general undeclared-identifier scan needs a real parser, and this page
     ships with no build step and no dependencies. So aim narrowly at the class
     of bug that actually happened: this codebase keeps its lookup tables in
     ALL_CAPS constants (WEEK_CALENDARS, SPORT_ALIAS, SLATE_FIELDS, ...), and
     WEEK_NAMES was one of them, left behind by a rename. All-caps identifiers
     almost never appear in CSS class names or HTML fragments, so this stays
     quiet until something is genuinely missing.

     Verified to catch the original bug: restoring the WEEK_NAMES reference
     makes this check fail. */
  var stripped = CODE
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    /* regex literals hold conference names like /\b(SEC|ACC|MAC)\b/ */
    .replace(/\/(?![*\/])(?:\[(?:[^\]\\]|\\.)*\]|[^\/\\\n\[])+\/[gimsuy]*/g, ' RX ')
    .replace(/\/\/[^\n]*/g, ' ');

  var declared = Object.create(null), m;
  var dre = /\b(?:var|let|const|function)\s+([A-Z][A-Z0-9_]{2,})\b/g;
  while ((m = dre.exec(CODE))) declared[m[1]] = 1;

  /* legitimate all-caps globals and DOM/browser names */
  ('JSON NaN URL API CFG DOM CSS HTML XML UTC GET POST PUT HEAD ID IDS OK URI'
    + ' MCOdds EDCfbP4 EDCfbP4Params SVG UI TZ NFL CFB CSV').split(' ')
    .forEach(function (n) { declared[n] = 1; });

  var missing = Object.create(null);
  var ure = /(\.\s*)?\b([A-Z][A-Z0-9_]{2,})\b(\s*:)?/g;
  while ((m = ure.exec(stripped)) !== null) {
    if (m[1] || m[3]) continue;                    /* .PROP or KEY: */
    if (!declared[m[2]]) missing[m[2]] = 1;
  }
  var names = Object.keys(missing);
  chk('no constant table is referenced without being declared', names.length === 0,
    { undeclared: names });
})();

/* =======================================================================
   2. BEHAVIOURAL: run the real functions against a real CFB export.
   ======================================================================= */
function fakeEl() {
  var el = {
    value: '', innerHTML: '', textContent: '', disabled: false, style: {},
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; },
                 toggle: function () {} },
    getAttribute: function () { return null; }, setAttribute: function () {},
    appendChild: function () {}, removeChild: function () {}, remove: function () {},
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return fakeEl(); },
    querySelectorAll: function () { return []; },
    focus: function () {}, click: function () {}, scrollIntoView: function () {}
  };
  return el;
}
var sandbox = {
  console: console,
  setTimeout: function () { return 0; }, clearTimeout: function () {},
  setInterval: function () { return 0; }, clearInterval: function () {},
  fetch: function () { return Promise.reject(new Error('offline test')); },
  localStorage: { getItem: function () { return null; }, setItem: function () {},
                  removeItem: function () {} },
  sessionStorage: { getItem: function () { return null; }, setItem: function () {} },
  location: { hash: '', href: 'http://localhost/collective/', search: '',
              replace: function () {}, assign: function () {} },
  history: { replaceState: function () {}, pushState: function () {} },
  navigator: { userAgent: 'node', clipboard: { writeText: function () {} } },
  document: {
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return fakeEl(); },
    addEventListener: function () {}, removeEventListener: function () {},
    body: fakeEl(), head: fakeEl(), title: '', cookie: ''
  },
  atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
  btoa: function (s) { return Buffer.from(s, 'binary').toString('base64'); },
  URL: URL, URLSearchParams: URLSearchParams, TextEncoder: TextEncoder,
  TextDecoder: TextDecoder, AbortController: AbortController,
  Headers: typeof Headers !== 'undefined' ? Headers : function () {},
  Promise: Promise, JSON: JSON, Math: Math, Date: Date, RegExp: RegExp,
  Intl: Intl, performance: { now: function () { return 0; } },
  crypto: { getRandomValues: function (a) { return a; },
            randomUUID: function () { return '00000000-0000-4000-8000-000000000000'; } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {};
sandbox.removeEventListener = function () {};
sandbox.dispatchEvent = function () { return true; };
sandbox.matchMedia = function () {
  return { matches: false, addListener: function () {}, addEventListener: function () {} };
};
sandbox.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
sandbox.scrollTo = function () {};
sandbox.requestAnimationFrame = function (fn) { return 0; };
sandbox.alert = function () {}; sandbox.confirm = function () { return false; };

var bootErr = null;
try {
  vm.createContext(sandbox);
  /* route() at the tail touches the DOM; the declarations above it are what
     this suite needs, so a bootstrap throw is caught rather than fatal. */
  vm.runInContext(CODE, sandbox, { timeout: 15000 });
} catch (e) { bootErr = e; }
if (bootErr) console.log('[boot] script stopped at: ' + bootErr.message);

chk('the script defines its upload functions without a syntax error',
  typeof sandbox.slateGuessMap === 'function'
  && typeof sandbox.slateBuildRows === 'function'
  && typeof sandbox.teamKey === 'function',
  { bootErr: bootErr && bootErr.message });

if (typeof sandbox.teamKey === 'function') {
  var S = sandbox;

  /* ---- team keys: college names are not NFL names -------------------- */
  chk('an accent is FOLDED, not deleted',
    S.teamKey('San José State') === S.teamKey('San Jose State'),
    { got: S.teamKey('San José State') });
  chk('an apostrophe is dropped', S.teamKey("Hawai'i") === S.teamKey('Hawaii'));
  chk('an ampersand is dropped', S.teamKey('Texas A&M') === S.teamKey('texas am'));
  chk('punctuation and case do not matter',
    S.teamKey('Ohio St.') === S.teamKey('ohio st') && S.teamKey('  UCF ') === 'ucf');
  chk('two genuinely different schools stay different',
    S.teamKey('Miami (FL)') !== S.teamKey('Miami (OH)'));

  chk('slateSide resolves an accented away team',
    S.slateSide('San José State', 'USC', 'San Jose State') === 'away');
  chk('slateSide resolves home/away words', S.slateSide('home', 'A', 'B') === 'home'
    && S.slateSide('road', 'A', 'B') === 'away');
  chk('slateSide refuses a name that matches neither side',
    S.slateSide('Rutgers', 'USC', 'Stanford') === null);

  /* ---- per-sport week calendars -------------------------------------- */
  chk('the CFB calendar names bowl season, not the Super Bowl',
    S.weekCalendar('CFB').names[17] === 'Bowl Season'
    && !/Super Bowl/.test(JSON.stringify(S.weekCalendar('CFB').names)));
  chk('the NFL calendar still names the Super Bowl',
    S.weekCalendar('NFL').names[22] === 'Super Bowl');
  chk('NCAAF and CFB-P4 alias onto the CFB calendar',
    S.weekCalendar('NCAAF').regular === 15 && S.weekCalendar('CFB-P4').regular === 15);
  chk('an unknown sport falls back rather than throwing',
    S.weekCalendar('QUIDDITCH').regular === 18);
  chk('WEEK_NAMES is gone and nothing still reaches for it',
    typeof S.WEEK_NAMES === 'undefined' && !/\bWEEK_NAMES\b/.test(CODE));

  /* ---- the server owns the sport vocabulary --------------------------- */
  chk('a detected sport is translated into the code THIS server uses',
    S.serverSportCode({ sports: [{ code: 'NFL' }, { code: 'NCAAF' }] }, 'CFB') === 'NCAAF',
    { got: S.serverSportCode({ sports: [{ code: 'NFL' }, { code: 'NCAAF' }] }, 'CFB') });
  chk('an exact match is returned unchanged',
    S.serverSportCode({ sports: [{ code: 'CFB' }] }, 'CFB') === 'CFB');
  chk('a server that lists nothing matching keeps the detected code',
    S.serverSportCode({ sports: [{ code: 'NFL' }] }, 'CFB') === 'CFB');
  chk('sportFamily collapses every college alias onto one family',
    ['CFB', 'NCAAF', 'CFB-P4', 'College'].every(function (c) {
      return S.sportFamily(c) === 'CFB';
    }));

  /* ---- percent vs probability ---------------------------------------- */
  chk('a _pct header is a percent even when its value is below 1',
    near(S.slateProb('0.9', 'spread_push_pct'), 0.009));
  chk('a plain probability column is left alone',
    near(S.slateProb('0.64', 'home_win_probability'), 0.64));
  chk('a percent value in a plain column is still rescaled',
    near(S.slateProb('81.4', 'home_win_prob'), 0.814));

  /* ---- the real 80-column CFB export --------------------------------- */
  var CSV = [
    'season,week,game_id,kickoff_local,away_team,home_team,model_version,feature_version,'
      + 'model_home_line,model_fair_total,home_win_prob_pct,ref_home_line,spread_pick,'
      + 'p_spread_pick_pct,spread_push_pct,recommendation_basis,home_conference,away_conference,confidence',
    '2026,1,401856766,2026-08-29 16:00,North Carolina,TCU,edgedesk_cfb_p4_v1.0.0,cfb_p4_fv1,'
      + '-14.64,50.1,81.4,-10.5,TCU,48.4,0,"a basis, with commas, in it",Big 12,ACC,40',
    '2026,1,401856767,2026-08-29 15:00,San José State,USC,edgedesk_cfb_p4_v1.0.0,cfb_p4_fv1,'
      + '-34.82,53.7,98.3,-35.5,San José State,68.2,0,"another, basis",Big Ten,Mountain West,38',
    '2026,1,401856768,2026-08-29 19:00,New Mexico State,Florida State,edgedesk_cfb_p4_v1.0.0,cfb_p4_fv1,'
      + '-25.65,50.2,94.1,-30,New Mexico State,70.9,0.9,"third, basis",ACC,Conference USA,36'
  ].join('\n');

  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (q) {
        if (c === '"' && text.charAt(i + 1) === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  var rows2d = parseCsv(CSV);
  chk('a quoted field containing commas does not split the row',
    rows2d.every(function (r) { return r.length === rows2d[0].length; }),
    { widths: rows2d.map(function (r) { return r.length; }) });

  S.SLATE.cols = rows2d[0]; S.SLATE.rows = rows2d; S.SLATE.map = {};
  S.slateGuessMap();
  var col = function (f) { return S.SLATE.cols[S.SLATE.map[f]]; };

  chk('the EdgeDesk CFB export is recognised', S.edSlateDetect() === true);
  chk('your spread binds to the BETTING-SIGN column, not the margin',
    col('projected_spread') === 'model_home_line', { got: col('projected_spread') });
  chk('the market line binds to the reference book line',
    col('line_at_submission') === 'ref_home_line', { got: col('line_at_submission') });
  chk('the kickoff binds to kickoff_local', col('kickoff') === 'kickoff_local');
  chk('the pick binds to spread_pick', col('pick_side') === 'spread_pick');
  chk('the cover column is flagged as stated from the PICKED side',
    S.SLATE.coverIsPickSide === true);
  chk('every required field is mapped with no help from the creator',
    S.SLATE_FIELDS.filter(function (fd) { return fd.req && S.SLATE.map[fd.f] === undefined; })
      .length === 0);
  chk('the week is read from the file',
    S.slateDetectWeek(rows2d, S.SLATE.map['week']) === 1);

  var built = S.slateBuildRows('2026', '1');
  chk('every row builds, with no problems reported',
    built.rows.length === 3 && built.problems.length === 0,
    { n: built.rows.length, problems: built.problems });

  var r0 = built.rows[0], r1 = built.rows[1], r2 = built.rows[2];
  chk('the home spread keeps the betting sign', near(r0.projected_spread, -14.64));
  chk('a 0-100 win percentage is rescaled to a probability',
    near(r0.home_win_probability, 0.814, 1e-9));
  chk('the real game id is carried rather than a synthesised ref',
    r0.game_ref === '401856766');
  chk('a "YYYY-MM-DD HH:MM" kickoff parses', /^2026-08-29T/.test(r0.kickoff));

  chk('a home pick resolves to home', r0.pick_side === 'home');
  chk('an ACCENTED away pick resolves to away', r1.pick_side === 'away',
    { got: r1.pick_side });

  /* the payload is home-relative throughout, so cover must be too */
  chk('a home pick keeps its cover probability as given',
    near(r0.cover_probability, 0.484, 1e-9), { got: r0.cover_probability });
  chk('an away pick has its cover probability turned around to the home side',
    near(r1.cover_probability, 0.318, 1e-9), { got: r1.cover_probability });
  chk('the push mass is subtracted at the right scale',
    near(r2.cover_probability, 0.282, 1e-9), { got: r2.cover_probability });
  chk('no cover probability escapes the unit interval',
    built.rows.every(function (o) {
      return o.cover_probability === undefined
        || (o.cover_probability >= 0 && o.cover_probability <= 1);
    }));
}

/* ---- report ------------------------------------------------------------ */
failures.forEach(function (f) {
  console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : ''));
});
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

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
    + ' MCOdds EDCfbP4 EDCfbP4Params SVG UI TZ NFL CFB CSV GMT UT').split(' ')
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
    (function () {
      var c = S.weekCalendar('QUIDDITCH');
      return c && c.regular === 0 && c.max === 0 && c.names
        && Object.keys(c.names).length === 0;
    })(),
    'falling back must not mean inheriting the NFL calendar');
  chk('WEEK_NAMES is gone and nothing still reaches for it',
    typeof S.WEEK_NAMES === 'undefined' && !/\bWEEK_NAMES\b/.test(CODE));

  /* ---- a kickoff means the same instant for everyone -------------------
     "2026-08-29 19:00" carries no timezone, and new Date() on that form is
     specified to mean the READER'S local time. In US Pacific that rolled four
     of five games in a college slate into the next UTC day, so they stopped
     matching the schedule. The file declares kickoff_tz; honour it, and read
     an undeclared wall-clock as UTC rather than as wherever the laptop is. */
  chk('a declared UTC kickoff is read as UTC',
    S.slateKick('2026-08-29 19:00', 'UTC') === '2026-08-29T19:00:00.000Z',
    { got: S.slateKick('2026-08-29 19:00', 'UTC') });
  chk('an UNDECLARED kickoff is read as UTC, not as local time',
    S.slateKick('2026-08-29 19:00') === '2026-08-29T19:00:00.000Z',
    { got: S.slateKick('2026-08-29 19:00'),
      note: 'this is the assertion that fails if the browser timezone leaks in' });
  chk('a named zone is resolved at that instant, daylight saving included',
    S.slateKick('2026-08-29 19:00', 'America/New_York') === '2026-08-29T23:00:00.000Z',
    { got: S.slateKick('2026-08-29 19:00', 'America/New_York') });
  chk('a numeric offset is honoured',
    S.slateKick('2026-08-29 19:00', '-07:00') === '2026-08-30T02:00:00.000Z',
    { got: S.slateKick('2026-08-29 19:00', '-07:00') });
  chk('a value that already carries Z is left alone',
    S.slateKick('2026-08-29T19:00:00Z', 'America/Los_Angeles') === '2026-08-29T19:00:00.000Z');
  chk('an unparseable zone falls back to UTC rather than to local',
    S.slateKick('2026-08-29 19:00', 'Mars/Olympus') === '2026-08-29T19:00:00.000Z');
  chk('the whole slate lands on one day regardless of where it is opened',
    (function () {
      var ks = ['16:00', '19:00', '19:30', '23:00'].map(function (t) {
        return S.slateKick('2026-08-29 ' + t, 'UTC').slice(0, 10);
      });
      return ks.every(function (d) { return d === '2026-08-29'; });
    })());

  chk('the season is a mapped field, so it can come from the file',
    S.SLATE_FIELDS.some(function (fd) {
      return fd.f === 'season' && fd.syn.indexOf('season') >= 0;
    }));
  chk('the kickoff timezone is a mapped field',
    S.SLATE_FIELDS.some(function (fd) {
      return fd.f === 'kickoff_tz' && fd.syn.indexOf('kickoff_tz') >= 0;
    }));

  /* ---- will the server be able to match this? -------------------------
     The failure that survived every client-side fix: a slate reads perfectly,
     posts successfully, and lands as "0 matched, 90 quarantined" because
     matching happens on the server against a schedule the browser never
     checked. These cover the shapes that produces. */
  var SRV = [{ label: 'North Carolina @ TCU' }, { label: 'San Jose State @ USC' },
             { label: "Hawai'i @ Stanford" }];
  var MINE = [{ home_team: 'TCU', away_team: 'North Carolina' },
              { home_team: 'USC', away_team: 'San José State' },
              { home_team: 'Stanford', away_team: "Hawai'i" }];

  chk('a slate whose teams are all on the server matches completely',
    (function () {
      var u = S.slateUnmatchedTeams(SRV, MINE);
      return u.count === 0 && u.matched === 6 && u.none === false;
    })(), { got: S.slateUnmatchedTeams(SRV, MINE) });
  chk('the accented name matches the server\'s unaccented spelling',
    S.slateUnmatchedTeams([{ label: 'San Jose State @ USC' }],
      [{ home_team: 'USC', away_team: 'San José State' }]).count === 0);
  chk('one differing spelling is named, and only that one',
    (function () {
      var u = S.slateUnmatchedTeams([{ label: 'New Mexico State @ Florida St' }],
        [{ home_team: 'Florida State', away_team: 'New Mexico State' }]);
      return u.count === 1 && u.missing[0] === 'Florida State' && u.none === false;
    })());
  chk('a schedule for the wrong sport matches nothing, and says so',
    (function () {
      var u = S.slateUnmatchedTeams(
        [{ label: 'New England @ Seattle' }, { label: 'Dallas @ Philadelphia' }], MINE);
      return u.none === true && u.count === 6 && u.serverTeams === 4;
    })(),
    'this is the "0 matched, 90 quarantined" case, caught before posting');
  chk('an empty server schedule matches nothing',
    S.slateUnmatchedTeams([], MINE).none === true);
  chk('explicit home_team/away_team fields are honoured, not just the label',
    S.slateUnmatchedTeams([{ home_team: 'TCU', away_team: 'North Carolina' }],
      [{ home_team: 'TCU', away_team: 'North Carolina' }]).count === 0);
  chk('"at" is understood as a separator as well as "@"',
    S.slateUnmatchedTeams([{ label: 'North Carolina at TCU' }],
      [{ home_team: 'TCU', away_team: 'North Carolina' }]).count === 0);

  /* ---- one separator per file, chosen from the file --------------------
     Comma and tab were both live delimiters on every input at once. Excel and
     Google Sheets put TAB separated text on the clipboard and quote a cell only
     when it contains a tab, a newline or a quote -- never one that merely
     contains a comma -- so a notes column reading "early lean, low conf" split
     into two cells and shifted every column to its right. Measured on a real
     paste, the model's own line was filed as the MARKET line: the number
     closing-line value is graded against. */
  var TSV = 'home_team\taway_team\tdate\tnotes\tmy_line\tmarket_line\n'
    + 'TCU\tNorth Carolina\t2026-08-29 16:00\tearly lean, low conf\t-14.6\t-10.5';

  chk('a spreadsheet paste is read as tab separated',
    S.sniffDelim(TSV) === '\t', { got: JSON.stringify(S.sniffDelim(TSV)) });
  chk('a bare comma inside a tab-separated cell no longer splits it',
    (function () {
      var r = S.parseCSV(TSV);
      return r[0].length === 6 && r[1].length === 6
        && r[1][3] === 'early lean, low conf' && r[1][4] === '-14.6';
    })(),
    'the model number used to land in the market-line column');
  chk('an ordinary CSV is still read as comma separated',
    S.sniffDelim('a,b,c\n1,2,3') === ',');
  chk('a quoted comma in a CSV is still one cell',
    (function () {
      var r = S.parseCSV('a,b,c\n1,"x, y",3');
      return r[1].length === 3 && r[1][1] === 'x, y';
    })());
  chk('a semicolon file is read as semicolon separated',
    (function () {
      var r = S.parseCSV('a;b;c\n1;2;3');
      return S.sniffDelim('a;b;c\n1;2;3') === ';' && r[1].length === 3;
    })());
  chk('quoted regions of the header do not vote on the separator',
    S.sniffDelim('"a,b,c,d"\tx\ty') === '\t');
  chk('a single-column file falls back to comma rather than throwing',
    S.sniffDelim('team\nTCU') === ',');
  chk('the real 80-column CFB export is still comma separated',
    S.sniffDelim(CSV) === ',');

  /* ---- send the schedule its own names ---------------------------------
     The backend stores team identifiers uppercased, punctuation stripped and
     TRUNCATED TO TEN CHARACTERS, and matches a submitted slate literally
     against them. Every team whose canonical name fits in ten characters
     resolved and every longer one quarantined -- TCU, USC, Virginia, Stanford,
     NC State and Hawai'i through; North Carolina, San José State, Florida
     State and New Mexico State rejected. The schedule is the dictionary. */
  var TRUNC = [{ label: 'NORTHCAROL @ TCU' }, { label: 'SANJOSESTA @ USC' },
               { label: 'NCSTATE @ VIRGINIA' }, { label: 'NEWMEXICOS @ FLORIDASTA' },
               { label: 'HAWAII @ STANFORD' }];
  var SLATE_IN = [{ home_team: 'TCU', away_team: 'North Carolina' },
                  { home_team: 'USC', away_team: 'San José State' },
                  { home_team: 'Virginia', away_team: 'NC State' },
                  { home_team: 'Florida State', away_team: 'New Mexico State' },
                  { home_team: 'Stanford', away_team: "Hawai'i" }];

  chk('a ten-character truncation resolves to the backend\'s own spelling',
    (function () {
      var ix = S.slateNameIndex(TRUNC);
      var r = S.slateResolveName(ix, 'Florida State');
      return r && r.name === 'FLORIDASTA' && r.how === 'truncated';
    })());
  chk('a name that already fits resolves exactly, case and all',
    (function () {
      var ix = S.slateNameIndex(TRUNC);
      var r = S.slateResolveName(ix, 'Virginia');
      return r && r.name === 'VIRGINIA' && r.how === 'exact';
    })());
  chk('a mascot suffix resolves the other way',
    (function () {
      var ix = S.slateNameIndex([{ label: 'North Carolina Tar Heels @ TCU Horned Frogs' }]);
      var r = S.slateResolveName(ix, 'North Carolina');
      return r && r.name === 'North Carolina Tar Heels' && r.how === 'expanded';
    })());
  chk('the LONGEST truncation wins, because it is the most specific',
    (function () {
      /* "Florida State" starts with both FLORIDASTA and FLORIDA, and only the
         first is Florida State — the second is a different school that also
         plays that week. Refusing both stranded two real games. */
      var ix = S.slateNameIndex([{ label: 'FLORIDASTA @ FLORIDA' },
                                 { label: 'NEWMEXICOS @ NEWMEXICO' }]);
      return S.slateResolveName(ix, 'Florida State').name === 'FLORIDASTA'
        && S.slateResolveName(ix, 'New Mexico State').name === 'NEWMEXICOS';
    })());
  chk('the shorter school still resolves to itself',
    (function () {
      var ix = S.slateNameIndex([{ label: 'FLORIDASTA @ FLORIDA' },
                                 { label: 'NEWMEXICOS @ NEWMEXICO' }]);
      return S.slateResolveName(ix, 'Florida').name === 'FLORIDA'
        && S.slateResolveName(ix, 'New Mexico').name === 'NEWMEXICO';
    })(),
    'the fix for Florida State must not break Florida');
  chk('a genuine two-way expansion is still refused, never guessed',
    (function () {
      /* two different schools both start with this name, and nothing in the
         name says which — unlike a truncation, length does not decide it */
      var ix = S.slateNameIndex([{ label: 'CHARLESTONSO @ A' }, { label: 'CHARLESTONCOLL @ B' }]);
      var r = S.slateResolveName(ix, 'Charleston');
      return r && r.ambiguous && r.ambiguous.length === 2;
    })(),
    'silently picking one would be worse than quarantining both');
  chk('the whole slate aligns onto the schedule, every row',
    (function () {
      var a = S.slateAlignToSchedule(TRUNC, SLATE_IN);
      var sent = a.rows.map(function (r) { return r.away_team + ' @ ' + r.home_team; });
      return sent.join('|') === 'NORTHCAROL @ TCU|SANJOSESTA @ USC|NCSTATE @ VIRGINIA|'
        + 'NEWMEXICOS @ FLORIDASTA|HAWAII @ STANFORD';
    })(), { got: S.slateAlignToSchedule(TRUNC, SLATE_IN).rows });
  chk('nothing is left unmatched once the slate is aligned',
    S.slateUnmatchedTeams(TRUNC, S.slateAlignToSchedule(TRUNC, SLATE_IN).rows).count === 0,
    'this is the "0 matched, 5 quarantined" case, resolved');
  chk('alignment reports what it changed',
    (function () {
      var a = S.slateAlignToSchedule(TRUNC, SLATE_IN);
      var by = {}; a.changed.forEach(function (c) { by[c.from] = c.to; });
      return by['Florida State'] === 'FLORIDASTA' && by['North Carolina'] === 'NORTHCAROL';
    })());
  chk('alignment does not touch rows when the server list is empty',
    (function () {
      var a = S.slateAlignToSchedule([], SLATE_IN);
      return a.rows === SLATE_IN && a.changed.length === 0;
    })());
  chk('a team genuinely absent from the schedule stays unresolved',
    (function () {
      var a = S.slateAlignToSchedule(TRUNC,
        [{ home_team: 'Rutgers', away_team: 'TCU' }]);
      return a.unresolved.indexOf('Rutgers') >= 0
        && a.rows[0].home_team === 'Rutgers';
    })());

  /* ---- naming the missing team is only half an answer ------------------ */
  chk('a mascot suffix is recognised as the same school',
    S.teamSimilarity('TCU', 'TCU Horned Frogs') >= 0.8
    && S.teamSimilarity('North Carolina', 'North Carolina Tar Heels') >= 0.8);
  chk('"St" and "State" are recognised as the same school',
    S.teamSimilarity('Florida State', 'Florida St') >= 0.7
    && S.teamSimilarity('New Mexico State', 'New Mexico St') >= 0.7);
  chk('an accented name scores against its unaccented spelling',
    S.teamSimilarity('San José State', 'San Jose St') >= 0.7);
  chk('two unrelated schools do not look alike',
    S.teamSimilarity('Stanford', 'Virginia') < 0.45
    && S.teamSimilarity('TCU', 'Hawaii') < 0.45);
  chk('an exact match scores 1',
    S.teamSimilarity('Ohio State', 'ohio state') === 1);
  chk('the closest backend spelling is offered for each missing team',
    (function () {
      var u = S.slateUnmatchedTeams(
        [{ label: 'New Mexico St @ Florida St' }],
        [{ home_team: 'Florida State', away_team: 'New Mexico State' }]);
      var by = {};
      u.suggest.forEach(function (x) { by[x.mine] = x.theirs; });
      return by['Florida State'] === 'Florida St'
        && by['New Mexico State'] === 'New Mexico St';
    })(),
    'a creator cannot fix a spelling they are not shown');
  chk('nothing is suggested when nothing is close',
    (function () {
      var u = S.slateUnmatchedTeams([{ label: 'Dallas @ Philadelphia' }],
        [{ home_team: 'TCU', away_team: 'North Carolina' }]);
      return u.suggest.every(function (x) { return x.theirs === null; });
    })());
  chk('the backend\'s own spellings are captured, de-duplicated',
    (function () {
      var n = S.slateServerNames([{ label: 'A @ B' }, { label: 'B @ C' },
        { home_team: 'C', away_team: 'A' }]);
      return n.length === 3;
    })());

  /* ---- one registry drives every sport --------------------------------
     Sport knowledge used to be scattered across WEEK_CALENDARS, SPORT_ALIAS,
     CFB_CONFERENCES and a hand-written detector, so adding a sport meant
     editing five places and forgetting the sixth. SPORTS is now the only
     place, and these assert that everything really does read from it. */
  chk('the registry carries both sports the server offers',
    (function () {
      var fams = S.SPORTS.map(function (x) { return x.family; });
      return fams.indexOf('NFL') >= 0 && fams.indexOf('CFB') >= 0;
    })());
  chk('every registry entry is complete enough to drive a surface',
    S.SPORTS.every(function (x) {
      return x.family && x.name && x.long && x.aliases.length
        && x.regular > 0 && x.max >= x.regular && x.rounds && x.detect;
    }),
    'a half-filled entry is how a new sport breaks the week picker');
  chk('the week calendar comes from the registry',
    (function () {
      var cal = S.weekCalendar('CFB'), def = S.sportDef('CFB');
      return cal.regular === def.regular && cal.max === def.max
        && cal.names[17] === 'Bowl Season';
    })());
  chk('a server alias resolves to its family',
    S.sportDef('NCAAF').family === 'CFB' && S.sportDef('CFB-P4').family === 'CFB'
    && S.sportDef('nfl').family === 'NFL');
  chk('a sport the registry has never heard of does NOT borrow the NFL\'s shape',
    (function () {
      var d = S.sportDef('KABADDI');
      return d.family === null && d.name === 'KABADDI'
        && d.regular === 0 && d.max === 0 && d.unit === 'date';
    })(),
    'the fallback used to carry 18 weeks and a Super Bowl round, so an '
    + 'unrecognised sport was offered a 22-week NFL season');
  chk('an unknown sport gets only "read it from my file" for a week',
    (function () {
      var o = S.weekOptions(null, 'KABADDI');
      return (o.match(/<option/g) || []).length === 1 && /Read it from my file/.test(o);
    })());
  chk('a known sport still gets its full week list',
    (function () {
      var o = S.weekOptions(null, 'CFB');
      return (o.match(/<option/g) || []).length === 21 && /Bowl Season/.test(o);
    })());
  chk('two unknown sports do not merge into one family',
    S.sportFamily('KABADDI') !== S.sportFamily('SEPAKTAKRAW'));
  chk('display names come from the registry, not from the server',
    S.sportName('NCAAF') === 'CFB' && S.sportLongName('NCAAF') === 'College Football'
    && S.sportLongName('NFL') === 'NFL',
    'the server calls the NFL "Football"; nobody else does');

  /* ---- one sport at a time, on every surface --------------------------- */
  var MIXED = [
    { creator_slug:'a', model_slug:'a1', sport:'NFL' },
    { creator_slug:'a', model_slug:'a2', sport:'CFB' },
    { creator_slug:'b', model_slug:'b1', sport:'NCAAF' },
    { creator_slug:'c', model_slug:'c1' }               /* server did not label it */
  ];
  chk('a board shows only its own sport',
    S.rowsForSport(MIXED, 'NFL').map(function (r) { return r.model_slug; }).join(',') === 'a1,c1');
  chk('a server alias lands on the same board as its family',
    S.rowsForSport(MIXED, 'CFB').map(function (r) { return r.model_slug; }).join(',') === 'a2,b1,c1',
    'a model registered as NCAAF must appear on the CFB board');
  chk('an UNLABELLED model is shown everywhere rather than hidden',
    S.rowsForSport(MIXED, 'NFL').some(function (r) { return r.model_slug === 'c1'; })
    && S.rowsForSport(MIXED, 'CFB').some(function (r) { return r.model_slug === 'c1'; }),
    'silently disappearing a model because the server omitted a field is worse '
    + 'than showing it twice');
  chk('the sports present in a set of rows are listed in registry order',
    S.sportsInRows(MIXED).join(',') === 'NFL,CFB');
  chk('rows with no sport at all yield no sports',
    S.sportsInRows([{ creator_slug: 'x' }]).length === 0);

  /* ---- a filter that filters nothing is worse than no filter -----------
     The rankings boards were "filtered by sport" using a key built from
     r.model_slug — a field a rankings row does not carry. Every lookup was
     "creator/undefined", every sport read back undefined, and the null escape
     hatch then passed every row. Three boards claimed to show one sport and
     showed all of them. This asserts the join actually joins. */
  chk('a ranked model is matched to its sport by name when it has no slug',
    (function () {
      var wall = [{ creator_slug:'a', model_slug:'a1', model_name:'Alpha One', sport:'CFB' },
                  { creator_slug:'a', model_slug:'a2', model_name:'Alpha Two', sport:'NFL' }];
      /* exactly the shape /v1/rankings returns: NO model_slug */
      var ranked = [{ rank:1, creator_slug:'a', creator_name:'A', model_name:'Alpha One',
                      value:0.6, graded:12 },
                    { rank:2, creator_slug:'a', creator_name:'A', model_name:'Alpha Two',
                      value:0.5, graded:12 }];
      var smap = {};
      wall.forEach(function (r) {
        if (r.model_slug) smap[r.creator_slug + '/s/' + r.model_slug] = r.sport;
        if (r.model_name) smap[r.creator_slug + '/n/' + r.model_name] = r.sport;
      });
      function look(r) {
        var sp = r.model_slug ? smap[r.creator_slug + '/s/' + r.model_slug] : null;
        if (sp == null && r.model_name) sp = smap[r.creator_slug + '/n/' + r.model_name];
        return sp == null ? null : sp;
      }
      return look(ranked[0]) === 'CFB' && look(ranked[1]) === 'NFL';
    })(),
    'keyed on model_slug alone this returned null for both, and the filter '
    + 'passed every row');

  /* ---- what a creator covers is DERIVED from their models --------------- */
  chk('sports covered come from the models, in registry order',
    (function () {
      var c = S.creatorSports([{ sport: 'CFB' }, { sport: 'NFL' }]);
      return c.length === 2 && c[0].family === 'NFL' && c[1].family === 'CFB'
        && c.every(function (x) { return x.posted === true; });
    })());
  chk('two models in one sport count once',
    S.creatorSports([{ sport: 'NFL' }, { sport: 'NFL' }]).length === 1);
  chk('a declared sport is marked as not yet posted',
    (function () {
      var c = S.creatorSports([{ sport: 'NFL' }], ['CFB']);
      var cfb = c.filter(function (x) { return x.family === 'CFB'; })[0];
      return c.length === 2 && cfb && cfb.posted === false;
    })());
  chk('declaring a sport you already post for does not duplicate it',
    S.creatorSports([{ sport: 'NFL' }], ['NFL']).length === 1);
  chk('a creator with no models covers nothing',
    S.creatorSports([]).length === 0 && S.creatorSports(null).length === 0);

  /* ---- detecting the sport of an uploaded file ------------------------- */
  chk('a model stamp identifies the sport',
    S.slateDetectSport(['game_id', 'model_version'],
      [['game_id', 'model_version'], ['1', 'edgedesk_cfb_p4_v1.0.0']]) === 'CFB');
  chk('an NFL stamp is not mistaken for college',
    S.slateDetectSport(['model_version'],
      [['model_version'], ['edgedesk_nfl_v2']]) === 'NFL');
  chk('conference columns identify the sport when there is no stamp',
    S.slateDetectSport(['home_conference', 'away_conference'],
      [['home_conference', 'away_conference'], ['Big 12', 'ACC']]) === 'CFB');
  chk('AFC/NFC conferences identify the NFL',
    S.slateDetectSport(['home_conference'],
      [['home_conference'], ['AFC']]) === 'NFL');
  chk('a file that says nothing about its sport returns null, not a guess',
    S.slateDetectSport(['home_team', 'away_team'],
      [['home_team', 'away_team'], ['TCU', 'North Carolina']]) === null,
    'null means "the file does not say", which is not the same as "NFL"');
  chk('a model stamp beats a conference column',
    S.slateDetectSport(['model_version', 'home_conference'],
      [['model_version', 'home_conference'], ['edgedesk_nfl_v2', 'SEC']]) === 'NFL',
    'the creator\'s own export says what it is; a conference name is an inference');

  /* ---- a slate belongs to a model, and the model carries the sport ----
     The failure no spelling could reach: a submission is attached to a model
     and the Collective resolves its games in that MODEL'S sport, so a college
     slate attached to an NFL model is looked up in the NFL schedule and every
     row returns unknown_team_home. The proof was "TCU" — three characters, no
     accent, no truncation, present in the backend's own CFB schedule — failing
     against itself. sportFamily is what decides whether an account has a model
     that can carry a given file. */
  chk('an account with only an NFL model cannot carry a CFB slate',
    (function () {
      var models = [{ model_slug: 'edgedesk-model', sport: 'NFL' }];
      return !models.some(function (m) { return S.sportFamily(m.sport) === S.sportFamily('CFB'); });
    })());
  chk('an account with a CFB model can',
    (function () {
      var models = [{ model_slug: 'nfl', sport: 'NFL' }, { model_slug: 'p4', sport: 'CFB' }];
      return models.some(function (m) { return S.sportFamily(m.sport) === S.sportFamily('CFB'); });
    })());
  chk('a model registered under NCAAF still carries a CFB file',
    S.sportFamily('NCAAF') === S.sportFamily('CFB'),
    'the server may name the sport either way; the family is what matches');

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

  /* ---- the picked team's number, one helper for every surface ----------
     The wire is HOME convention throughout: projected_spread is the model's
     number for the home side, line_at_submission is the market line for the
     home side, and pick_side says — authoritatively — which team the model
     actually took. pickedSide()/pickDisp() are the ONLY place the display
     layer turns that home number into the picked team's number; the wall,
     the board and the model pages all read through them. The regression
     being pinned: an away pick shows the EXACT INVERSE of the home number,
     a home pick shows it unchanged, and the sign of the spread never gets
     a vote on which side was picked. */
  chk('the pick helpers exist and are shared',
    typeof S.pickedSide === 'function' && typeof S.pickDisp === 'function'
    && typeof S.pickNum === 'function' && typeof S.pickSideNorm === 'function');

  var PICKS = [
    /* away dog: invert the home number, show plus */
    { g:{home:'SEA',away:'NE'},  mr:{pick_side:'away',projected_spread:-3.5},  want:'NE +3.5' },
    /* home favourite: home number unchanged, stays negative */
    { g:{home:'LA', away:'SF'},  mr:{pick_side:'home',projected_spread:-3.5},  want:'LA -3.5' },
    { g:{home:'LAC',away:'ARI'}, mr:{pick_side:'home',projected_spread:-10.5}, want:'LAC -10.5' },
    { g:{home:'PIT',away:'ATL'}, mr:{pick_side:'away',projected_spread:-3.0},  want:'ATL +3.0' },
    { g:{home:'MIN',away:'GB'},  mr:{pick_side:'away',projected_spread:-1.5},  want:'GB +1.5' },
    { g:{home:'TEN',away:'NYJ'}, mr:{pick_side:'home',projected_spread:-2.5},  want:'TEN -2.5' },
    { g:{home:'KC', away:'DEN'}, mr:{pick_side:'away',projected_spread:-2.5},  want:'DEN +2.5' },
    /* home dog keeps its plus */
    { g:{home:'IND',away:'BAL'}, mr:{pick_side:'home',projected_spread:3.5},   want:'IND +3.5' },
    /* away favourite: a POSITIVE home number inverts to minus */
    { g:{home:'CAR',away:'CHI'}, mr:{pick_side:'away',projected_spread:2.5},   want:'CHI -2.5' },
    /* pick'em, away side: no -0 */
    { g:{home:'HOU',away:'BUF'}, mr:{pick_side:'away',projected_spread:0},     want:'BUF 0.0' },
    /* college names ride the same rail, accents and all */
    { g:{home:'USC',away:'San José State'},
      mr:{pick_side:'away',projected_spread:-34.82}, want:'San José State +34.8' }
  ];
  PICKS.forEach(function (t) {
    chk('wall shows ' + t.want + ' for ' + t.g.away + ' @ ' + t.g.home
        + ' (' + t.mr.pick_side + ' pick on home ' + t.mr.projected_spread + ')',
      S.pickDisp(t.g, t.mr) === t.want, { got: S.pickDisp(t.g, t.mr) });
  });

  chk('the SIGN of the spread does not pick the side',
    (function () {
      /* same stored number, opposite explicit sides: both must be honoured */
      var g = { home: 'SEA', away: 'NE' };
      return S.pickDisp(g, { pick_side: 'home', projected_spread: -3.5 }) === 'SEA -3.5'
        && S.pickDisp(g, { pick_side: 'away', projected_spread: -3.5 }) === 'NE +3.5';
    })());
  chk('pick_side is read case- and whitespace-insensitively',
    (function () {
      var g = { home: 'SEA', away: 'NE' };
      return S.pickDisp(g, { pick_side: 'AWAY', projected_spread: -3.5 }) === 'NE +3.5'
        && S.pickDisp(g, { pick_side: ' Home ', projected_spread: -3.5 }) === 'SEA -3.5'
        && S.pickSideNorm({ pick_side: 'AWAY' }) === 'away'
        && S.pickSideNorm({ pick_side: 'neither' }) === null;
    })(),
    'a capitalised side used to fall through and show the home team instead');
  chk('a number that arrives as a string is still a number',
    S.pickDisp({ home: 'SEA', away: 'NE' },
      { pick_side: 'away', projected_spread: '-3.5' }) === 'NE +3.5');
  chk('with no spread of its own the market line fills in, same convention',
    (function () {
      var g = { home: 'SEA', away: 'NE' };
      var p = S.pickedSide(g, { pick_side: 'away', line_at_submission: -3.5 });
      return S.pickDisp(g, { pick_side: 'away', line_at_submission: -3.5 }) === 'NE +3.5'
        && p.own === false && near(p.spread, 3.5);
    })(),
    'the fallback must not be inverted a second time anywhere upstream');
  chk('the model\'s own number beats the market line',
    (function () {
      var p = S.pickedSide({ home: 'SEA', away: 'NE' },
        { pick_side: 'away', projected_spread: -1.5, line_at_submission: -3.5 });
      return near(p.spread, 1.5) && p.own === true;
    })());
  chk('an away pick\'em is 0, never -0',
    (function () {
      var p = S.pickedSide({ home: 'HOU', away: 'BUF' },
        { pick_side: 'away', projected_spread: 0 });
      return p.spread === 0 && (1 / p.spread) === Infinity;
    })());
  chk('no usable side falls back to the HOME team with the home number',
    S.pickDisp({ home: 'SEA', away: 'NE' }, { projected_spread: -3.5 }) === 'SEA -3.5'
    && S.pickDisp({ home: 'SEA', away: 'NE' },
         { pick_side: 'NE', projected_spread: -3.5 }) === 'SEA -3.5',
    'a side the helper cannot read must never be guessed from the sign');
  chk('a pick with no number at all still names the picked team',
    S.pickDisp({ home: 'SEA', away: 'NE' }, { pick_side: 'away' }) === 'NE -'
    && S.pickDisp({ home: 'SEA', away: 'NE' }, {}) === '-');
  chk('pickedSide names the picked team, both sides',
    (function () {
      var g = { home: 'SEA', away: 'NE' };
      return S.pickedSide(g, { pick_side: 'away', projected_spread: -3.5 }).team === 'NE'
        && S.pickedSide(g, { pick_side: 'home', projected_spread: -3.5 }).team === 'SEA';
    })());
  chk('the win probability flips with the picked side, case-insensitively',
    near(S.pickProb({ pick_side: 'away', home_win_probability: 0.7 }), 0.3)
    && near(S.pickProb({ pick_side: 'AWAY', home_win_probability: 0.7 }), 0.3)
    && near(S.pickProb({ pick_side: 'home', home_win_probability: 0.7 }), 0.7));

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

  /* the CFB export's own-number column is HOME convention already; the
     pick-stated conversion below must never touch it, away pick or not */
  chk('an away pick does NOT flip a home-named spread column',
    near(r1.projected_spread, -34.82), { got: r1.projected_spread });

  /* ---- a pick-centric sheet: the column is stated from the PICK ---------
     The file that put "NE -3.5" on the wall for a model that was on NE
     +3.5: a creator's own sheet with pick_line (the picked team's number),
     pick_prob (P(the pick covers)) and pick_team. Stored raw, every away
     pick posts with its sign turned around and the wall — correctly
     inverting away picks — shows the exact opposite of the model's number.
     The header says whose number it is, so ingestion turns it onto the
     home side using each row's own pick, exactly as it already did for
     p_spread_pick_pct cover probabilities. */
  var MOOSE = [
    'date,game_id,season,week,away,home,pick_team,pick_side,pick_line,pick_claim,pick_prob,home_win_prob,model_total',
    '2026-09-09,2026_01_NE_SEA,2026,1,NE,SEA,NE,away,3.5,covers,0.5258,0.6247,41.65',
    '2026-09-10,2026_01_SF_LA,2026,1,SF,LA,LA,home,-3.5,covers,0.5239,0.6599,53.21',
    '2026-09-13,2026_01_CHI_CAR,2026,1,CHI,CAR,CHI,away,-2.5,covers,0.6004,0.3344,45.49',
    '2026-09-13,2026_01_BUF_HOU,2026,1,BUF,HOU,BUF,away,0,covers,0.608,0.392,42.35',
    '2026-09-13,2026_01_NO_DET,2026,1,NO,DET,,,7,covers,0.597,0.6739,48.76'
  ].join('\n');
  var moose2d = parseCsv(MOOSE);
  S.SLATE.cols = moose2d[0]; S.SLATE.rows = moose2d; S.SLATE.map = {};
  S.slateGuessMap();
  var mcol = function (f) { return S.SLATE.cols[S.SLATE.map[f]]; };

  chk('pick_line maps to the spread field', mcol('projected_spread') === 'pick_line',
    { got: mcol('projected_spread') });
  chk('pick_prob maps to the cover field and is flagged pick-stated',
    mcol('cover_probability') === 'pick_prob' && S.SLATE.coverIsPickSide === true);
  chk('pick_team resolves the picked side', mcol('pick_side') === 'pick_team');
  chk('model_total maps to the total', mcol('projected_total') === 'model_total');
  chk('pick_line is in the "which is it?" list, like spread and line',
    S.AMBIGUOUS_SPREAD.indexOf('pick_line') >= 0);

  var mb = S.slateBuildRows('2026', '1');
  var m0 = mb.rows[0], m1 = mb.rows[1], m2 = mb.rows[2], m3 = mb.rows[3], m4 = mb.rows[4];
  chk('every Moose row builds', mb.rows.length === 5, { n: mb.rows.length });
  chk('an away pick_line is stored as the home side\'s number',
    m0.pick_side === 'away' && near(m0.projected_spread, -3.5),
    { got: m0.projected_spread });
  chk('a home pick_line is stored unchanged',
    m1.pick_side === 'home' && near(m1.projected_spread, -3.5));
  chk('an away FAVOURITE\'s pick_line turns positive on the home side',
    m2.pick_side === 'away' && near(m2.projected_spread, 2.5),
    { got: m2.projected_spread });
  chk('an away pick\'em stores 0, never -0',
    m3.projected_spread === 0 && (1 / m3.projected_spread) === Infinity);
  chk('the implied line rides the converted home number',
    near(m0.line_at_submission, -3.5), { got: m0.line_at_submission });
  chk('a pick-stated cover probability is turned onto the home side',
    near(m0.cover_probability, 1 - 0.5258) && near(m1.cover_probability, 0.5239),
    { away: m0.cover_probability, home: m1.cover_probability });
  chk('a row with no readable pick withholds the pick-stated number and says why',
    m4.projected_spread === undefined
    && mb.problems.some(function (p) { return /pick_line/.test(p) && /Row 6/.test(p); }),
    { got: m4.projected_spread, problems: mb.problems });

  /* the round trip that was broken: file → wire → wall */
  chk('the wall reads Moose\'s picks back exactly as written',
    S.pickDisp({ home: 'SEA', away: 'NE' }, m0) === 'NE +3.5'
    && S.pickDisp({ home: 'LA', away: 'SF' }, m1) === 'LA -3.5'
    && S.pickDisp({ home: 'CAR', away: 'CHI' }, m2) === 'CHI -2.5'
    && S.pickDisp({ home: 'HOU', away: 'BUF' }, m3) === 'BUF 0.0',
    { got: [S.pickDisp({ home: 'SEA', away: 'NE' }, m0),
            S.pickDisp({ home: 'LA', away: 'SF' }, m1),
            S.pickDisp({ home: 'CAR', away: 'CHI' }, m2),
            S.pickDisp({ home: 'HOU', away: 'BUF' }, m3)] });

  /* the conversion follows the mapping the creator actually set, not the
     one the guesser produced: hand-move pick_line onto the market-line
     field (the ambiguous-spread button does exactly this) and it is still
     read as pick-stated */
  S.SLATE.map['line_at_submission'] = S.SLATE.map['projected_spread'];
  delete S.SLATE.map['projected_spread'];
  var mb2 = S.slateBuildRows('2026', '1');
  chk('a hand-remapped pick_line converts on the market-line field too',
    near(mb2.rows[0].line_at_submission, -3.5)
    && mb2.rows[0].projected_spread === undefined,
    { got: mb2.rows[0].line_at_submission });
}

/* ---- report ------------------------------------------------------------ */
failures.forEach(function (f) {
  console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : ''));
});
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

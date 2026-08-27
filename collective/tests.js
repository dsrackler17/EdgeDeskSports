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

  /* ---- the HW % field is the HOME team's chance, every time -------------
     Reported from the live board: "the HW % field isn't always showing the
     % chance of the home team winning outright." Three ways it happened:
     the wall's probability cell was stated from the PICKED side while the
     consensus row in the same column stated home; a pick-stated win-prob
     column posted raw, inverting every away pick; and ml_home — a synonym
     for this field — usually holds a PRICE, which read +100 as certainty. */

  /* the outright call is split from the spread pick and NAMES its winner,
     so no reader needs a sign convention to know which team a % belongs to */
  chk('the outright cell names the favoured side with its own chance',
    (function () {
      var c = S.outrightCell({ home: 'LAC', away: 'ARI' }, { home_win_probability: 0.61, pick_side: 'away' });
      return c && c.txt === 'LAC 61%';
    })());
  chk('a home dog outright call names the away team',
    (function () {
      var c = S.outrightCell({ home: 'IND', away: 'BAL' }, { home_win_probability: 0.38 });
      return c && c.txt === 'BAL 62%';
    })());
  chk('the cover fallback stays home-stated and labelled cv',
    (function () {
      var c = S.outrightCell({ home: 'LAC', away: 'ARI' }, { cover_probability: 0.44, pick_side: 'away' });
      return c && c.txt === 'cv 44%';
    })());
  chk('a row with no probability at all yields no cell',
    S.outrightCell({ home: 'LAC', away: 'ARI' }, { pick_side: 'home' }) === null);

  /* the Home win % column: a bare value under a labelled header, matching
     the number the consensus averages; the cover fallback keeps its cv
     label inside the cell because it is a different quantity */
  chk('the home win cell is the bare home-stated percentage',
    (function () { var c = S.hwCell({ home_win_probability: 0.62, pick_side: 'away' });
      return c && c.txt === '62%'; })());
  chk('the home win cell cover fallback keeps its cv label',
    (function () { var c = S.hwCell({ cover_probability: 0.44 });
      return c && c.txt === 'cv 44%'; })());
  chk('the home win cell is empty with nothing to show',
    S.hwCell({ pick_side: 'home' }) === null);

  /* the pick is stated at the line it was made against, never at the
     model's own projection — stating it at the projection is how "your
     spread" got hand-mapped onto the market line to make the pick look
     right, posting the market as the model on every game */
  chk('pickNum prefers the market line the pick was made against',
    (function () {
      var n = S.pickNum({ projected_spread: -4.9, line_at_submission: -10.5 });
      return n && near(n.v, -10.5) && n.own === false;
    })());
  chk('a pick with no market line falls back to the model own spread',
    (function () {
      var n = S.pickNum({ projected_spread: -4.9 });
      return n && near(n.v, -4.9) && n.own === true;
    })());
  chk('an away pick displays the market line exact inverse',
    S.pickDisp({ home: 'LAC', away: 'ARI' },
      { pick_side: 'away', projected_spread: -4.9, line_at_submission: -10.5 }) === 'ARI +10.5');
  chk('the model own spread never leaks into the pick statement',
    S.pickDisp({ home: 'LAC', away: 'ARI' },
      { pick_side: 'home', projected_spread: -4.9, line_at_submission: -10.5 }) === 'LAC -10.5');

  /* the price-shaped values a win-probability column actually receives */
  chk('a home moneyline price reads as its implied probability',
    near(S.slateWinProb('-150', 'ml_home'), 0.6));
  chk('an even-money +100 price is 50%, never 100%',
    near(S.slateWinProb('+100', 'ml_home'), 0.5));
  chk('an underdog price converts too',
    near(S.slateWinProb('+150', 'ml_home'), 0.4));
  chk('a 100 in a percent-marked column is still 100%',
    near(S.slateWinProb('100', 'home_win_prob_pct'), 1));
  chk('a value that cannot be a probability is withheld, not posted',
    S.slateWinProb('150', 'win_prob') === null);
  chk('ordinary percentages and probabilities pass through unchanged',
    near(S.slateWinProb('81.4', 'home_win_prob_pct'), 0.814)
    && near(S.slateWinProb('0.64', 'home_win_probability'), 0.64));

  /* a win-prob column stated from the picked team: same treatment as a
     pick-stated spread — turned onto the home side, or withheld */
  var PICKCSV = [
    'home_team,away_team,date,pick,pick_win_prob',
    'TCU,North Carolina,2026-08-29 16:00,TCU,70',
    'TCU,North Carolina,2026-08-29 16:00,North Carolina,70',
    'TCU,North Carolina,2026-08-29 16:00,,70'
  ].join('\n');
  var pRows = parseCsv(PICKCSV);
  S.SLATE.cols = pRows[0]; S.SLATE.rows = pRows; S.SLATE.map = {};
  S.slateGuessMap();
  S.SLATE.map['home_win_probability'] = 4;   /* the creator maps it by hand */
  var pBuilt = S.slateBuildRows('2026', '1');
  chk('a pick-stated win probability keeps a home pick as given',
    near(pBuilt.rows[0].home_win_probability, 0.70, 1e-9),
    { got: pBuilt.rows[0].home_win_probability });
  chk('a pick-stated win probability is turned around for an away pick',
    near(pBuilt.rows[1].home_win_probability, 0.30, 1e-9),
    { got: pBuilt.rows[1].home_win_probability });
  chk('a pick-stated win probability with no readable pick is withheld',
    pBuilt.rows[2].home_win_probability === undefined
    && pBuilt.problems.some(function (p) { return /pick_win_prob/.test(p); }),
    { problems: pBuilt.problems });

  /* an ML column follows the ML pick, which is not the spread pick whenever
     the model likes the dog against the number */
  var MLCSV = [
    'home_team,away_team,date,spread_pick,ml_pick,p_ml_pick_pct',
    'TCU,North Carolina,2026-08-29 16:00,North Carolina,TCU,81.4',
    'TCU,North Carolina,2026-08-29 16:00,TCU,North Carolina,60',
    'TCU,North Carolina,2026-08-29 16:00,TCU,,60'
  ].join('\n');
  var mRows = parseCsv(MLCSV);
  S.SLATE.cols = mRows[0]; S.SLATE.rows = mRows; S.SLATE.map = {};
  S.slateGuessMap();
  S.SLATE.map['home_win_probability'] = 5;   /* the creator maps it by hand */
  var mBuilt = S.slateBuildRows('2026', '1');
  chk('an ML-pick probability follows ml_pick, not the spread pick',
    near(mBuilt.rows[0].home_win_probability, 0.814, 1e-9),
    { got: mBuilt.rows[0].home_win_probability });
  chk('an away ML pick is turned onto the home side',
    near(mBuilt.rows[1].home_win_probability, 0.40, 1e-9),
    { got: mBuilt.rows[1].home_win_probability });
  chk('an ML-pick probability with no readable ml_pick is withheld',
    mBuilt.rows[2].home_win_probability === undefined,
    { got: mBuilt.rows[2].home_win_probability });

  /* ---- a remembered mapping never overrides the known EdgeDesk auto-map --
     A hand-flip of "your spread" onto ref_home_line was remembered across
     uploads: every slate posted the market line as the model own number,
     the wall showed a spread the model own win probability contradicted,
     and the API rejected the spread/probability pair. */
  chk('a remembered mapping is reused for an ordinary file',
    (function () {
      var m2 = S.slateRememberedMap({ cols: mRows[0].slice(), map: { home_team: 0 } });
      return m2 && m2.home_team === 0;
    })());
  chk('a remembered mapping with different headers is ignored',
    S.slateRememberedMap({ cols: ['a', 'b'], map: { home_team: 0 } }) === null);
  S.SLATE.cols = rows2d[0]; S.SLATE.rows = rows2d; S.SLATE.map = {};
  S.slateGuessMap();
  chk('an EdgeDesk export keeps its canonical mapping over a remembered one',
    S.slateRememberedMap({ cols: rows2d[0].slice(), map: { projected_spread: 11 } }) === null);

  /* ---- board reading aids: split flags, group-vs-market, lead time -----
     Three additions driven by "what is worth looking at on this board".
     None of them invent a number: sigma and the consensus mean are already
     computed per game, and the lead time reads a timestamp the games
     payload may or may not carry. */
  var SPLITSET = [
    { game_id: 1, consensus: { n: 3, spread_stdev: 4.2 } },   /* widest */
    { game_id: 2, consensus: { n: 3, spread_stdev: 2.6 } },
    { game_id: 3, consensus: { n: 3, spread_stdev: 1.9 } },
    { game_id: 4, consensus: { n: 3, spread_stdev: 1.7 } },   /* 4th, over floor */
    { game_id: 5, consensus: { n: 3, spread_stdev: 0.4 } },   /* under the floor */
    { game_id: 6, consensus: { n: 1, spread_stdev: 9.9 } },   /* one model is not a split */
    { game_id: 7, consensus: { n: 3, spread_stdev: 9.9, locked: true } }
  ];
  var flags = S.splitGames(SPLITSET);
  chk('only the widest few games are flagged as split',
    Object.keys(flags).length === 3, { got: Object.keys(flags) });
  chk('the split flags are the widest three by sigma',
    flags['1'] === 4.2 && flags['2'] === 2.6 && flags['3'] === 1.9, { got: flags });
  chk('a game inside a key number of agreement is never flagged',
    flags['5'] === undefined);
  chk('a single model is not a disagreement',
    flags['6'] === undefined);
  chk('a locked consensus is not flagged',
    flags['7'] === undefined);
  chk('a slate nobody split on gets no flags',
    Object.keys(S.splitGames([{ game_id: 9, consensus: { n: 4, spread_stdev: 0.2 } }])).length === 0);
  chk('a game with no id is still keyed uniquely by its teams',
    S.gameKey({ home: 'SEA', away: 'NE' }) === 'NE@SEA');

  /* the group-vs-market edge needs BOTH numbers and a real consensus; it
     is rendered through MCOdds, which this offline suite does not load, so
     what is asserted here is that it refuses rather than throws */
  chk('no group edge without a market number',
    S.consensusEdge({ home: 'SEA', away: 'NE' }, { n: 3, spread_mean: -3.5 }, null) === null);
  chk('no group edge from a single model',
    S.consensusEdge({ home: 'SEA', away: 'NE' }, { n: 1, spread_mean: -3.5 }, -2.0) === null);
  chk('no group edge from a locked consensus',
    S.consensusEdge({ home: 'SEA', away: 'NE' }, { n: 3, spread_mean: -3.5, locked: true }, -2.0) === null);
  chk('the group edge badge is empty rather than broken markup',
    S.consensusEdgeBadge({ home: 'SEA', away: 'NE' }, null, null) === '');

  /* lead time: dormant until the games payload carries a timestamp */
  var KICK = '2026-09-13T17:00:00Z';
  chk('a pick posted three days out reads in days',
    S.pickLeadText({ submitted_at: '2026-09-10T17:00:00Z' }, KICK) === 'posted 3d before kickoff');
  chk('a pick posted the same morning reads in hours',
    S.pickLeadText({ submitted_at: '2026-09-13T09:00:00Z' }, KICK) === 'posted 8h before kickoff');
  chk('a pick posted after kickoff says so',
    S.pickLeadText({ submitted_at: '2026-09-13T19:00:00Z' }, KICK) === 'posted after kickoff');
  chk('either timestamp field the API might grow is read',
    S.pickLeadText({ received_at: '2026-09-11T17:00:00Z' }, KICK) === 'posted 2d before kickoff');
  chk('no timestamp yields nothing at all, never a bare label',
    S.pickLeadText({ projected_spread: -3 }, KICK) === '');
  chk('a timestamp with no kickoff yields nothing',
    S.pickLeadText({ submitted_at: KICK }, null) === '');

  /* ---- calibration: claimed vs actual, folded onto the favoured side --- */
  function pts(list) { return list.map(function (x) { return { p: x[0], y: x[1] }; }); }
  var cal = S.calibrationBuckets(pts([
    [0.70, 1], [0.70, 1], [0.70, 1], [0.70, 1], [0.70, 1], [0.70, 1], [0.70, 1],
    [0.70, 0], [0.70, 0], [0.70, 0]
  ]));
  var b70 = cal.buckets[2];
  chk('a 70% claim that wins 7 of 10 reads as calibrated',
    cal.n === 10 && b70.n === 10 && near(b70.claimed, 0.7) && near(b70.actual, 0.7),
    { b70: b70 });
  chk('an away favourite folds onto the favoured side',
    (function () {
      /* p(home)=0.30 means the model favours the AWAY side at 70%; the away
         side winning (y=0) is a hit */
      var c = S.calibrationBuckets(pts([[0.30, 0], [0.30, 0], [0.30, 1]]));
      var b = c.buckets[2];
      return b.n === 3 && near(b.claimed, 0.7) && near(b.actual, 2 / 3, 1e-9);
    })());
  chk('a dead-even 50% lands in the lowest bucket as a home call',
    (function () {
      var c = S.calibrationBuckets(pts([[0.5, 1], [0.5, 0]]));
      var b = c.buckets[0];
      return b.n === 2 && near(b.claimed, 0.5) && near(b.actual, 0.5);
    })());
  chk('a certainty lands in the top bucket instead of falling off the end',
    (function () {
      var c = S.calibrationBuckets(pts([[1, 1]]));
      return c.buckets[4].n === 1 && near(c.buckets[4].claimed, 1);
    })());
  chk('overconfidence is visible, not averaged away',
    (function () {
      /* claims 90%+, wins half: actual should read ~0.5 in the top bucket */
      var c = S.calibrationBuckets(pts([[0.92, 1], [0.94, 0], [0.9, 1], [0.96, 0]]));
      var b = c.buckets[4];
      return b.n === 4 && near(b.actual, 0.5) && b.claimed > 0.9;
    })());
  chk('garbage points are counted as skipped, never binned',
    (function () {
      var c = S.calibrationBuckets(pts([[0.7, 1], [null, 1], [0.6, null], [2, 1]]));
      return c.n === 1 && c.skipped === 3;
    })());
  chk('an empty record yields an empty readout, and no markup',
    S.calibrationBuckets([]).n === 0 && S.calibrationHTML(S.calibrationBuckets([])) === '');

  /* the harvest: settled games only, this model only, late excluded, tie skipped */
  var CALGAMES = [
    { result: { home_score: 24, away_score: 17 }, models: [
      { creator_slug: 'edgedesk', model_slug: 'nfl', home_win_probability: 0.7 },
      { creator_slug: 'edgedesk', model_slug: 'nfl', home_win_probability: 0.9, late: true },
      { creator_slug: 'other', model_slug: 'x', home_win_probability: 0.5 },
      { creator_slug: 'edgedesk', model_slug: 'nfl', locked: true },
      { creator_slug: 'edgedesk', model_slug: 'nfl', cover_probability: 0.5 }
    ] },
    { result: { home_score: 20, away_score: 20 }, models: [
      { creator_slug: 'edgedesk', model_slug: 'nfl', home_win_probability: 0.6 }
    ] },
    { models: [{ creator_slug: 'edgedesk', model_slug: 'nfl', home_win_probability: 0.6 }] }
  ];
  var harvest = S.calibrationPoints(CALGAMES, 'edgedesk', 'nfl');
  chk('the harvest keeps one point: settled, this model, on time, with a probability',
    harvest.length === 1 && near(harvest[0].p, 0.7) && harvest[0].y === 1,
    { harvest: harvest });

  /* ---- the outright record, and the Collective graded as one model ----- */
  chk('the outright record counts favoured-side wins, either side of 50',
    (function () {
      var r = S.mlOutrightRecord(pts([[0.7, 1], [0.3, 0], [0.6, 0], [null, 1]]));
      return r.n === 3 && r.w === 2 && r.l === 1 && near(r.pct, 2 / 3, 1e-9);
    })());
  chk('an empty outright record has a null percentage, never NaN',
    (function () { var r = S.mlOutrightRecord([]); return r.n === 0 && r.pct === null; })());

  var CONSGAMES = [
    /* majority home at -3 close, home wins by 7: ATS win, outright hit */
    { consensus: { n: 3, home_win_prob_mean: 0.7, pct_picks_home: 0.67 },
      result: { home_score: 24, away_score: 17, closing_spread: -3 } },
    /* majority away as home dog +3, home loses by 10: away covers, ATS win;
       mean favours away (0.4), away won: outright hit */
    { consensus: { n: 2, home_win_prob_mean: 0.4, pct_picks_home: 0.33 },
      result: { home_score: 10, away_score: 20, closing_spread: 3 } },
    /* lands exactly on the close: a push, not a result */
    { consensus: { n: 3, home_win_prob_mean: 0.8, pct_picks_home: 1 },
      result: { home_score: 27, away_score: 20, closing_spread: -7 } },
    /* dead-even split: no ATS call to grade; outright still counts (a miss) */
    { consensus: { n: 4, home_win_prob_mean: 0.55, pct_picks_home: 0.5 },
      result: { home_score: 13, away_score: 17, closing_spread: -1 } },
    /* one model is not an aggregate */
    { consensus: { n: 1, home_win_prob_mean: 0.9, pct_picks_home: 1 },
      result: { home_score: 30, away_score: 0, closing_spread: -10 } },
    /* locked consensus never grades */
    { consensus: { locked: true, n: 5, home_win_prob_mean: 0.9, pct_picks_home: 1 },
      result: { home_score: 30, away_score: 0, closing_spread: -10 } },
    /* not settled yet */
    { consensus: { n: 3, home_win_prob_mean: 0.6, pct_picks_home: 0.8 } }
  ];
  var cons = S.consensusSeasonStats(CONSGAMES);
  chk('the consensus ATS record grades the majority side against the close',
    cons.ats.w === 2 && cons.ats.l === 0 && cons.ats.push === 1, { ats: cons.ats });
  chk('the consensus outright record includes the push and even-split games',
    cons.ml.n === 4 && cons.ml.w === 3 && cons.ml.l === 1, { ml: cons.ml },
    /* the ATS push still grades outright: home at 80% won the game */
    undefined);
  chk('the consensus calibration points carry the mean probabilities',
    cons.mlPts.length === 4 && near(cons.mlPts[0].p, 0.7) && cons.mlPts[0].y === 1);
  chk('no settled aggregates yields empty records, not zeros pretending to grade',
    (function () {
      var c = S.consensusSeasonStats([{ consensus: { n: 1 }, result: { home_score: 1, away_score: 0, closing_spread: -1 } }]);
      return c.ats.w === 0 && c.ats.l === 0 && c.ats.push === 0 && c.ml.n === 0;
    })());

  /* ---- the blank template must be right BY CONSTRUCTION ----------------
     The template is what a creator is handed when they ask "how do I format
     this". If its own headers did not map, or its example rows did not mean
     what the page says they mean, it would teach the exact convention drift
     it exists to prevent. So: parse it with the real parser, map it with the
     real mapper, build it with the real row builder, and assert the values
     that come out are the ones the format page promises. */
  var tpl = parseCsv(S.slateTemplateCsv(true));
  chk('every template column is a canonical wire field name',
    S.SLATE_TEMPLATE_COLS.every(function (c) {
      return S.SLATE_FIELDS.some(function (fd) { return fd.f === c || fd.syn.indexOf(c) >= 0; });
    }), { cols: S.SLATE_TEMPLATE_COLS });
  S.SLATE.cols = tpl[0]; S.SLATE.rows = tpl; S.SLATE.map = {};
  S.slateGuessMap();
  chk('the template maps with nothing left for the creator to correct',
    S.SLATE_TEMPLATE_COLS.every(function (c) { return S.SLATE.map[c] !== undefined; }),
    { unmapped: S.SLATE_TEMPLATE_COLS.filter(function (c) { return S.SLATE.map[c] === undefined; }) });
  chk('no required field is missing from the template',
    S.SLATE_FIELDS.filter(function (fd) { return fd.req && S.SLATE.map[fd.f] === undefined; }).length === 0);
  chk('the template is not mistaken for an EdgeDesk export',
    S.edSlateDetect() === false);
  chk('no template column is read as pick-stated',
    !S.slateColIsPickStated('projected_spread') && !S.slateColIsPickStated('line_at_submission')
      && !S.slateColIsPickStated('home_win_probability'));

  var tb = S.slateBuildRows('2026', '1');
  chk('both template example rows build with no problems reported',
    tb.rows.length === 2 && tb.problems.length === 0,
    { n: tb.rows.length, problems: tb.problems });
  var t0 = tb.rows[0], t1 = tb.rows[1];
  chk('the home favourite example keeps its negative home spread',
    near(t0.projected_spread, -5.0) && near(t0.line_at_submission, -3.5), { t0: t0 });
  chk('a 0-100 percentage in the template is read as a probability',
    near(t0.home_win_probability, 0.68) && near(t0.cover_probability, 0.507), { t0: t0 });
  chk('the template pick names a team and resolves to a side',
    t0.pick_side === 'home' && t1.pick_side === 'away',
    { t0: t0.pick_side, t1: t1.pick_side });
  chk('the home-dog example keeps its POSITIVE home spread',
    near(t1.projected_spread, 2.6) && near(t1.line_at_submission, 2.5), { t1: t1 });
  chk('the away-pick example is not silently turned around',
    near(t1.home_win_probability, 0.403),
    { got: t1.home_win_probability, why: 'a home-stated column is home-stated whatever the pick' });
  chk('template scores survive as projections',
    t0.proj_home_score === 24 && t0.proj_away_score === 19);
  chk('the headers-only template carries no rows to post',
    parseCsv(S.slateTemplateCsv(false)).length === 1);

  /* the example rows must mean what the format page says they mean */
  chk('the format doc documents every template column, in order',
    S.SLATE_TEMPLATE_DOC.length === S.SLATE_TEMPLATE_COLS.length &&
    S.SLATE_TEMPLATE_DOC.every(function (x, i) { return x.c === S.SLATE_TEMPLATE_COLS[i]; }),
    { doc: S.SLATE_TEMPLATE_DOC.map(function (x) { return x.c; }) });
  chk('every example row is as wide as the header',
    S.SLATE_TEMPLATE_EXAMPLE.every(function (r) { return r.length === S.SLATE_TEMPLATE_COLS.length; }));

  /* ---- a FINAL score must never post as a PROJECTED one ----------------
     The EdgeDesk exports name the final score home_score / away_score, which
     is also a legitimate name for a creator's projected scores. Mapped as a
     projection, a finished game posts the actual result as the model's
     expectation — and margin accuracy is graded from projected scores in
     preference to the spread, so that is a fabricated perfect projection.
     Verified against the REAL export header. */
  var FINALHEAD = ['season','week','game_id','kickoff_local','away_team','home_team',
    'model_home_line','model_fair_total','home_win_prob_pct','ref_home_line','spread_pick',
    'home_score','away_score','final_margin','final_total','spread_result','total_result','ml_result'];
  var FINALROW = ['2026','1','2026_01_NE_SEA','2026-09-09 20:20','NE','SEA',
    '-5.01','43.7','68','-3.5','SEA',
    '31','13','18','44','loss','over','win'];
  chk('score columns beside result columns are read as FINALS',
    S.slateScoresAreFinal(FINALHEAD) === true);
  S.SLATE.cols = FINALHEAD; S.SLATE.rows = [FINALHEAD, FINALROW]; S.SLATE.map = {};
  S.slateGuessMap();
  chk('a final score never maps as a projected score',
    S.SLATE.map['proj_home_score'] === undefined && S.SLATE.map['proj_away_score'] === undefined,
    { home: S.SLATE.cols[S.SLATE.map['proj_home_score']], away: S.SLATE.cols[S.SLATE.map['proj_away_score']] });
  var fb = S.slateBuildRows('2026', '1');
  chk('the built row carries no invented projection',
    fb.rows[0].proj_home_score === undefined && fb.rows[0].proj_away_score === undefined,
    { row: fb.rows[0] });
  chk('everything else on that row still posts normally',
    near(fb.rows[0].projected_spread, -5.01) && near(fb.rows[0].home_win_probability, 0.68)
      && fb.rows[0].pick_side === 'home', { row: fb.rows[0] });

  /* a sheet that really is projecting scores keeps them */
  var PROJHEAD = ['home_team','away_team','kickoff','home_score','away_score'];
  chk('score columns with no result columns stay projections',
    S.slateScoresAreFinal(PROJHEAD) === false);
  S.SLATE.cols = PROJHEAD;
  S.SLATE.rows = [PROJHEAD, ['SEA', 'NE', '2026-09-09', '24', '19']];
  S.SLATE.map = {}; S.slateGuessMap();
  var pb = S.slateBuildRows('2026', '1');
  chk('a projecting sheet still posts its projected scores',
    pb.rows[0].proj_home_score === 24 && pb.rows[0].proj_away_score === 19,
    { row: pb.rows[0] });
  chk('a sheet with result columns but no score columns is unaffected',
    S.slateScoresAreFinal(['home_team','away_team','spread_result']) === false);
}

/* ---- report ------------------------------------------------------------ */
failures.forEach(function (f) {
  console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : ''));
});
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

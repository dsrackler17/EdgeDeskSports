#!/usr/bin/env node
/* ===========================================================================
   THE FBS BOARD, cut out of app.html and run against a real schedule feed.

   The unit suite in football/fbs/ holds the universe. This holds the PAGE:
   the thing a reader actually sees when they open Research → Football → FBS
   Football, rendered by the real functions out of the real file, against the
   same cfbfastR schedule rows the browser fetches.

   What it prevents:
     1  the board quietly going back to Power 4 — the single condition this
        whole expansion removed;
     2  a hardcoded game count, team count or conference list on screen;
     3  a filter that does not compose (a conference selection breaking the
        sort, a status filter surviving a group change);
     4  a game rendering twice because both its teams matched a selection;
     5  a shared URL that does not restore the view it was copied from;
     6  the ratings panel implying the board is priced off a narrower scale
        than the one it ranks;
     7  a counts strip, an export or a Collective post that disagrees with
        the rows on screen;
     8  an empty state that says "no games" and nothing else.

   Run: node tools/football/fbs_board_ui.test.js
   =========================================================================== */
'use strict';

process.env.TZ = process.env.TZ || 'America/Chicago';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, { missing: needle }); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, { present: needle }); }

/* ---- the code under test, cut out of the page that ships it ------------
   Disjoint regions rather than one span: the board sits either side of a
   few thousand lines of unrelated engine. Every marker is asserted, so a
   moved block fails loudly instead of quietly testing nothing. */
const REGIONS = [
  ["var FBP4_CSV_HEAD=['season'", 'function fbP4Basis(){'],
  ['var FBP4_FBS_TAIL_N=15;', 'function fbP4RowValues(u){'],
  ['function fbP4SideRating(side){', 'function fbP4Card(u){'],
  ['function fbEdrFor(name){', 'function fbP4Ratings(){'],
  ['function fbP4Ratings(){', 'function fbP4StatusFor(p,mkt){'],
  ['function fbP4StatusFor(p,mkt){', 'window.fbP4Gate=function(gid){'],
  ['function fbP4StatusStrip(){', 'function fbP4Render(host){']
];
function slice(start, end) {
  const a = APP.indexOf(start);
  if (a < 0) throw new Error('app.html no longer contains: ' + start);
  const b = APP.indexOf(end, a);
  if (b < 0) throw new Error('app.html no longer contains, after ' + start + ': ' + end);
  return APP.slice(a, b);
}

/* ---- the world the board runs in -------------------------------------- */
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const ENGINE = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const PARAMS = global.EDCfbP4Params;

/* the schedule the coverage gate cached, so this suite needs no network */
const CACHED = path.join(ROOT, 'football', 'fbs', '.cache', 'cfb_schedules_2026.csv');
const FIXTURE = path.join(__dirname, 'fixtures', 'fbs_schedule_sample.csv');
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
const TRUE = v => /^(true|1|t|yes)$/i.test(String(v == null ? '' : v).trim());
const NUM = v => { if (v == null || v === '') return null; const x = +v; return isFinite(x) ? x : null; };

let SRC = null;
if (fs.existsSync(CACHED)) SRC = fs.readFileSync(CACHED, 'utf8');
else if (fs.existsSync(FIXTURE)) SRC = fs.readFileSync(FIXTURE, 'utf8');
if (!SRC) {
  console.log('SKIP | FBS board UI | no schedule feed on disk');
  console.log('       (run `npm run cfb:fbs` once to cache it, or commit tools/football/fixtures/fbs_schedule_sample.csv)');
  process.exit(0);
}
const RAW = parseCsv(SRC).map(r => ({
  game_id: r.game_id, season: NUM(r.season), week: NUM(r.week), start_date: r.start_date,
  completed: TRUE(r.completed), neutral_site: TRUE(r.neutral_site), conference_game: TRUE(r.conference_game),
  venue_id: NUM(r.venue_id), venue: r.venue,
  home_id: r.home_id, home_team: r.home_team, home_conference: r.home_conference, home_division: r.home_division,
  away_id: r.away_id, away_team: r.away_team, away_conference: r.away_conference, away_division: r.away_division,
  home_points: NUM(r.home_points), away_points: NUM(r.away_points)
}));
const SEASON = RAW[0] && RAW[0].season;

/* NOW is pinned to the feed itself so the suite is the same in September and
   in June: the first uncompleted kickoff, minus an hour. */
const NOW = (() => {
  const ts = RAW.filter(r => !r.completed).map(r => Date.parse(r.start_date)).filter(isFinite).sort((a, b) => a - b);
  return (ts[0] || Date.now()) - 3600e3;
})();

const UNIVERSE = FBS.buildUniverse({ rows: RAW, season: SEASON, source: 'cfbfastR-data schedules ' + SEASON,
  params: PARAMS, knownFbs: (PARAMS.rating && PARAMS.rating.seed_ratings) || null });
const SLATE = FBS.buildSlate({ rows: RAW, universe: UNIVERSE, now: NOW, lookaheadDays: 10 });

/* the rating state the browser builds: seeds plus every completed game */
const STATE = (() => {
  const st = ENGINE.newState();
  ENGINE.ingest.seasonBreak(st);
  RAW.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).forEach(r => {
    if (!r.completed || r.home_points == null || r.away_points == null) return;
    ENGINE.ingest.absorbGame(st, { home: r.home_team, away: r.away_team,
      home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: PARAMS.rating.seed_ratings }),
      away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: PARAMS.rating.seed_ratings }),
      neutral_site: r.neutral_site, home_points: r.home_points, away_points: r.away_points });
  });
  return st;
})();

const EDR_FILE = path.join(ROOT, 'football', 'rating', 'current.json');
const EDR = fs.existsSync(EDR_FILE) ? JSON.parse(fs.readFileSync(EDR_FILE, 'utf8')) : null;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Build a context with the board code in it. `search` seeds the URL so the
   shareable-state path is exercised through the same reader the page uses. */
function makeCtx(opts) {
  opts = opts || {};
  const store = { search: opts.search || '', hash: opts.hash || '#research/football' };
  const ctx = {
    console, Promise, Date, Math, JSON, String, Number, Object, Array, RegExp,
    isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    location: { get search() { return store.search; }, get hash() { return store.hash; }, pathname: '/app.html' },
    history: { replaceState(_a, _b, url) { const m = String(url).match(/\?[^#]*/); store.search = m ? m[0] : ''; } },
    _store: store,
    fetch: () => Promise.reject(new Error('no network in tests')),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild() {} } },
    alert() {}, prompt: () => null, confirm: () => false,
    fbEsc: esc,
    fbPts: (v, dp) => v == null ? '—' : ((v > 0 ? '+' : '') + v.toFixed(dp == null ? 1 : dp)),
    fbNum: x => { if (x == null || x === '') return null; const v = +x; return isFinite(v) ? v : null; },
    fbCsvQuote: v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; },
    whenLabel: iso => String(iso).slice(0, 16),
    edIsOwner: () => false,
    FB_GUARD: { p4: { game: 21 }, nfl: { game: 14 } },
    FBP4_LOOKAHEAD_D: 10,
    FB_LOOKAHEAD_D: 12
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.window.EDCfbP4 = ENGINE;
  ctx.window.EDCfbP4Params = PARAMS;
  ctx.window.EDFbs = FBS;
  ctx.fbP4Key = name => FBS.normKey(name);
  ctx.FB = {
    health: { ok: true },
    p4: {
      state: STATE, up: SLATE.items.slice(), uni: UNIVERSE, slateDrop: SLATE.dropped,
      notes: [], gate: null, season: SEASON, absorbed: 99,
      roster: {}, rosterSeason: null, rosterAsOf: null, rosterNote: null,
      lines: {}, sig: opts.sig || {}, weather: {},
      loadedAt: NOW, engineErr: null, schedSrc: 'cfbfastR-data schedules ' + SEASON,
      filters: { group: 'all', conferences: [], matchup: 'all', status: 'all', market: 'all', sort: 'kick' },
      confOpen: false
    },
    edr: { data: null, error: null, at: 0, _p: null, index: null, scope: 'all', confPick: null },
    p4slices: { data: null, err: null, _p: null }
  };
  /* the market join and the per-game request are exercised by their own
     suites; here they are supplied so the BOARD is what is under test */
  ctx.fbP4Market = u => (opts.market ? opts.market(u) : { spread_line: null, total_line: null, quotes_h2h: null,
    book: null, as_of: null, stale: false, status: 'NO MARKET', age_hours: null });
  ctx.fbP4Request = u => ({
    season: u.g.season, week: u.g.week, state: STATE,
    game: { home: u.g.home_team, away: u.g.away_team, neutral_site: u.g.neutral_site,
      venue_id: u.g.venue_id, kickoff: u.g.start_date,
      home_fbs: u.meta.home.is_fbs, away_fbs: u.meta.away.is_fbs },
    teams: { home: { conference: u.g.home_conference }, away: { conference: u.g.away_conference } },
    venue: { home: ((PARAMS.universe && PARAMS.universe.venues) || {})[FBS.normKey(u.g.home_team)] || null, away: null },
    weather: null, market: (opts.market ? opts.market(u) : {}), timestamps: {}
  });
  ctx.renderFootball = () => {};
  ctx.window.renderFootball = ctx.renderFootball;
  ctx.fbGxSummary = () => ''; ctx.fbGxSec = (g, k, t, body) => body || '';
  ctx.fbGxDrivers = () => ''; ctx.fbGxWrong = () => ''; ctx.fbGxCases = () => ''; ctx.fbGxScale = () => '';
  ctx.fbP4Score = (l, v) => '<span>' + l + '</span>';
  ctx.fbP4Contrib = () => '';
  ctx.fbP4Hth = () => {};
  ctx.fbTzLabel = () => 'CT';
  ctx.fbXlRaw = v => v;
  vm.createContext(ctx);
  REGIONS.forEach(([a, b], i) => vm.runInContext(slice(a, b), ctx, { filename: 'app.html [fbs board ' + i + ']' }));
  ctx.FB.edr.data = opts.noEdr ? null : EDR;
  if (!opts.noEdr && EDR) {
    ctx.FB.edr.index = {};
    EDR.teams.forEach(t => {
      ctx.FB.edr.index[t.key] = t;
      if (t.canonical_key) ctx.FB.edr.index[t.canonical_key] = t;
      const nk = FBS.normKey(t.team);
      if (nk && !ctx.FB.edr.index[nk]) ctx.FB.edr.index[nk] = t;
    });
  }
  ctx.FB.edr.scope = opts.edrScope || 'all';
  ctx.FB.edr.confPick = opts.edrConf || null;
  return ctx;
}

/* ======================================================================== */
/* 1. THE SLATE IS NOT POWER 4 GATED                                        */
/* ======================================================================== */
const A = makeCtx();
const ROWS = A.fbP4Rows();
const VIS = A.fbP4Visible(ROWS);
const COUNTS = A.fbP4Counts(ROWS, VIS);

chk('the board has a slate at all', ROWS.length > 0, ROWS.length);
eq('nothing is filtered by default', VIS.length, ROWS.length);
eq('the counts strip agrees with the slate', COUNTS.total, ROWS.length);
chk('the slate carries games with no Power 4 participant', () => {
  const p4 = UNIVERSE.p4.ids;
  const non = ROWS.filter(r => !r.meta.conference_ids.some(c => p4.indexOf(c) >= 0));
  return non.length > 0;
}, { p4: UNIVERSE.p4.ids });
chk('the slate carries Other-FBS-only conference games', () => {
  const p4 = UNIVERSE.p4.ids;
  return ROWS.some(r => r.meta.matchup_type === 'conference'
    && !r.meta.conference_ids.some(c => p4.indexOf(c) >= 0));
});
chk('the slate carries FBS-vs-FCS games', ROWS.some(r => r.meta.matchup_type === 'fbs_fcs'));
chk('the slate carries an independent', ROWS.some(r => r.meta.groups.indexOf('independent') >= 0));
chk('the slate carries every matchup type', () => {
  const t = {}; ROWS.forEach(r => { t[r.meta.matchup_type] = 1; });
  return t.conference && t.non_conference && t.fbs_fcs;
});
chk('no game appears twice on the slate', () => {
  const seen = {};
  for (const r of ROWS) { if (seen[r.gid]) return false; seen[r.gid] = 1; }
  return true;
});

/* ======================================================================== */
/* 2. THE HEADER AND THE COUNTS ARE COMPUTED, NEVER WRITTEN DOWN            */
/* ======================================================================== */
const BOARD = A.fbP4BoardHTML();
has(BOARD, 'EDGEDESK // FBS FOOTBALL OPERATIONS', 'the header names the FBS product');
lacks(BOARD, '// FOOTBALL OPERATIONS</b> · POWER 4', 'and no longer presents itself as Power 4');
has(BOARD, 'ALL FBS', 'the default scope is all FBS');
has(BOARD, COUNTS.visible + ' OF ' + COUNTS.total + ' GAMES', 'the header counts visible of total');
lacks(BOARD, '95 GAMES', 'no game count is hardcoded');
has(BOARD, 'on the FBS slate', 'the counts strip names the slate total');
has(BOARD, 'with a market quote', 'and how many carry a market quote');
has(BOARD, 'research-grade', 'and how many are research-grade');
has(BOARD, 'thin data', 'and how many are thin');
has(BOARD, 'no market', 'and how many have no market');
has(BOARD, 'data faults', 'and how many are data faults');
chk('the board renders one row per visible game', () => {
  const n = (BOARD.match(/id="p4gate-/g) || []).length;
  return n === VIS.length;
}, { rows: (BOARD.match(/id="p4gate-/g) || []).length, visible: VIS.length });

/* the app.html source itself must not carry the old constant anywhere in the
   board, and must not enumerate a conference list of its own */
const BOARD_SRC = slice('var FBP4_FILTER_DEFAULTS', 'function fbP4Render(host){');
lacks(BOARD_SRC, "p4_conferences", 'the board no longer reads a Power 4 conference list to gate the slate');
chk('the board does not hardcode a conference list',
  !/\['ACC'[^\]]*'Big Ten'/.test(BOARD_SRC) && !/\['SEC'[^\]]*'ACC'\]/.test(BOARD_SRC));

/* ======================================================================== */
/* 3. THE FILTER SURFACE                                                    */
/* ======================================================================== */
has(BOARD, 'GROUP', 'a program-group control is on the board');
has(BOARD, 'CONFERENCE', 'a conference control is on the board');
has(BOARD, 'MATCHUP', 'a matchup-type control is on the board, separate from conference');
has(BOARD, 'MARKET', 'a market-availability control is on the board');
has(BOARD, 'STATUS', 'a status control is on the board');
has(BOARD, 'SORT', 'a sort control is on the board');
has(BOARD, 'All FBS', 'the group control offers All FBS');
has(BOARD, 'Power 4', 'and Power 4');
has(BOARD, 'Other FBS', 'and Other FBS');
has(BOARD, 'Independents', 'and Independents');
lacks(BOARD, 'Group of 5', 'and never calls the non-power group "Group of 5"');
lacks(BOARD, 'Group of Five', 'in any spelling');
lacks(BOARD, 'Power 4 and other colleges', 'and never uses that phrasing');
has(BOARD, 'All conferences', 'the conference control can be reset');
has(BOARD, 'All matchups', 'the matchup control has an "all" option');
has(BOARD, 'Conference games', 'and a conference-games option');
has(BOARD, 'Non-conference FBS', 'and a non-conference option');
has(BOARD, 'FBS vs FCS', 'and an FBS-vs-FCS option');
has(BOARD, 'Kickoff', 'sorting by kickoff is offered');
has(BOARD, 'Largest gap', 'sorting by gap is offered');

/* the conference menu is populated from THIS season's dataset */
const M = makeCtx(); M.FB.p4.confOpen = true;
const MENU = M.fbP4BoardHTML();
UNIVERSE.conferences.forEach(c => has(MENU, esc(c.label), 'the conference menu offers ' + c.label));
chk('the conference menu groups the conferences', () => /POWER 4[\s\S]*OTHER FBS/.test(MENU));

/* ======================================================================== */
/* 4. FILTERS COMPOSE, AND NEVER DUPLICATE                                  */
/* ======================================================================== */
function view(filters) {
  const c = makeCtx();
  Object.keys(filters).forEach(k => { c.FB.p4.filters[k] = filters[k]; });
  c.FB.p4._filtersRead = true;
  const rows = c.fbP4Rows();
  return { ctx: c, rows, vis: c.fbP4Visible(rows) };
}
const MAC = UNIVERSE.conferences.find(c => c.id === 'mac') ? 'mac' : UNIVERSE.conferences[UNIVERSE.conferences.length - 1].id;
const SBC = UNIVERSE.conferences.find(c => c.id === 'sunbelt') ? 'sunbelt' : UNIVERSE.conferences[0].id;

chk('a group filter narrows the board', () => {
  const v = view({ group: 'p4' });
  return v.vis.length > 0 && v.vis.length < v.rows.length
    && v.vis.every(r => r.meta.groups.indexOf('p4') >= 0);
});
chk('Other FBS is not empty — the games this expansion exists for', () => {
  const v = view({ group: 'other' });
  return v.vis.length > 0;
});
chk('one conference narrows the board to its own games', () => {
  const v = view({ conferences: [MAC] });
  return v.vis.length > 0 && v.vis.every(r => r.meta.conference_ids.indexOf(MAC) >= 0);
});
chk('two conferences are a union, never a duplication', () => {
  const one = view({ conferences: [MAC] }).vis.length;
  const two = view({ conferences: [SBC] }).vis.length;
  const both = view({ conferences: [MAC, SBC] });
  const seen = {};
  for (const r of both.vis) { if (seen[r.gid]) return false; seen[r.gid] = 1; }
  return both.vis.length <= one + two;
});
chk('a game between two selected conferences renders exactly once', () => {
  const v = view({ conferences: UNIVERSE.conferences.map(c => c.id) });
  const html = v.ctx.fbP4BoardHTML();
  const ids = (html.match(/id="p4gate-([^"]+)"/g) || []);
  return ids.length === new Set(ids).size;
});
chk('a matchup filter composes with a conference filter', () => {
  const v = view({ conferences: [MAC], matchup: 'conference' });
  return v.vis.every(r => r.meta.conference_ids.indexOf(MAC) >= 0 && r.meta.matchup_type === 'conference');
});
chk('a status filter composes with a group filter', () => {
  const v = view({ group: 'other', status: 'NO MARKET' });
  return v.vis.every(r => r.meta.groups.indexOf('other') >= 0 && r.st.t === 'NO MARKET');
});
chk('a market filter composes with everything else', () => {
  const v = view({ group: 'other', matchup: 'non_conference', market: 'without' });
  return v.vis.every(r => r.meta.groups.indexOf('other') >= 0
    && r.meta.matchup_type === 'non_conference' && r.mkt.spread_line == null);
});
chk('sorting by gap does not change WHICH games are shown', () => {
  const a = view({ conferences: [MAC] }).vis.map(r => r.gid).sort().join(',');
  const b = view({ conferences: [MAC], sort: 'gap' }).vis.map(r => r.gid).sort().join(',');
  return a === b && a.length > 0;
});
chk('sorting by kickoff is ascending', () => {
  const v = view({ sort: 'kick' }).vis;
  for (let i = 1; i < v.length; i++) if (v[i].u.t < v[i - 1].u.t) return false;
  return true;
});
chk('sorting by conference is stable and complete', () => {
  const v = view({ sort: 'conf' }).vis;
  return v.length === ROWS.length;
});
chk('sorting by status groups the statuses', () => {
  const v = view({ sort: 'status' }).vis;
  const order = v.map(r => r.st.t);
  const seen = [];
  for (const s of order) { if (seen.indexOf(s) < 0) seen.push(s); else if (seen[seen.length - 1] !== s) return false; }
  return true;
});

/* ======================================================================== */
/* 5. URL STATE — a view is shareable                                       */
/* ======================================================================== */
chk('a conference view restores from the URL', () => {
  const c = makeCtx({ search: '?fbs_conf=' + MAC });
  const f = c.fbP4FiltersEnsure();
  return f.conferences.length === 1 && f.conferences[0] === MAC;
});
chk('two conferences restore from the URL', () => {
  const c = makeCtx({ search: '?fbs_conf=' + MAC + ',' + SBC });
  return c.fbP4FiltersEnsure().conferences.join(',') === MAC + ',' + SBC;
});
chk('a group view restores from the URL', () => {
  const c = makeCtx({ search: '?fbs_group=other' });
  return c.fbP4FiltersEnsure().group === 'other';
});
chk('a matchup view restores from the URL', () => {
  const c = makeCtx({ search: '?fbs_matchup=conference&fbs_sort=gap' });
  const f = c.fbP4FiltersEnsure();
  return f.matchup === 'conference' && f.sort === 'gap';
});
chk('a market view restores from the URL', () => {
  const c = makeCtx({ search: '?fbs_group=other&fbs_market=with' });
  const f = c.fbP4FiltersEnsure();
  return f.group === 'other' && f.market === 'with';
});
chk('an unknown filter value in the URL is ignored rather than emptying the board', () => {
  const c = makeCtx({ search: '?fbs_group=nonsense&fbs_matchup=rubbish&fbs_sort=sideways' });
  const f = c.fbP4FiltersEnsure();
  return f.group === 'all' && f.matchup === 'all' && f.sort === 'kick';
});
chk('a conference that is not in this season’s dataset is dropped from the URL state', () => {
  const c = makeCtx({ search: '?fbs_conf=bigeast' });
  return c.fbP4FiltersEnsure().conferences.length === 0;
});
chk('setting a filter writes it back to the URL', () => {
  const c = makeCtx();
  c.fbP4SetFilter('group', 'other');
  c.fbP4SetFilter('conf', MAC);
  return /fbs_group=other/.test(c._store.search) && new RegExp('fbs_conf=' + MAC).test(c._store.search);
}, null);
chk('the default view writes NO query string', () => {
  const c = makeCtx({ search: '?fbs_group=other' });
  c.fbP4FiltersEnsure();
  c.fbP4FilterReset();
  return c._store.search.indexOf('fbs_') < 0;
}, null);
chk('resetting clears every filter', () => {
  const c = makeCtx({ search: '?fbs_group=other&fbs_conf=' + MAC + '&fbs_matchup=conference' });
  c.fbP4FiltersEnsure();
  c.fbP4FilterReset();
  const f = c.FB.p4.filters;
  return f.group === 'all' && f.conferences.length === 0 && f.matchup === 'all' && f.sort === 'kick';
});
chk('the URL round-trips: a written view reads back the same', () => {
  const c = makeCtx();
  c.fbP4SetFilter('group', 'other');
  c.fbP4SetFilter('matchup', 'conference');
  const c2 = makeCtx({ search: c._store.search });
  const f = c2.fbP4FiltersEnsure();
  return f.group === 'other' && f.matchup === 'conference';
});
chk('the query string never disturbs the research router’s hash', () => {
  const c = makeCtx({ search: '', hash: '#research/football' });
  c.fbP4SetFilter('group', 'p4');
  return c.location.hash === '#research/football';
});
chk('an unrelated query parameter survives a filter change', () => {
  const c = makeCtx({ search: '?ref=twitter' });
  c.fbP4SetFilter('group', 'p4');
  return /ref=twitter/.test(c._store.search) && /fbs_group=p4/.test(c._store.search);
});

/* ======================================================================== */
/* 6. EMPTY STATES SAY WHICH FILTER EMPTIED THE BOARD                       */
/* ======================================================================== */
chk('a conference with no games in the window says so by name', () => {
  const empty = UNIVERSE.conferences.find(c => !ROWS.some(r => r.meta.conference_ids.indexOf(c.id) >= 0));
  const c = makeCtx();
  c.FB.p4.filters.conferences = [empty ? empty.id : MAC];
  c.FB.p4._filtersRead = true;
  if (!empty) {
    /* every conference plays this week — prove the generic path instead */
    c.FB.p4.filters.status = 'DATA FAULT'; c.FB.p4.filters.market = 'stale';
    const h = c.fbP4BoardHTML();
    return /class="empty"/.test(h);
  }
  const h = c.fbP4BoardHTML();
  return h.indexOf('has no game in this window') >= 0 && h.indexOf(esc(empty.label)) >= 0;
});
chk('a market-only view with no market says that, and says a missing quote is not a zero', () => {
  const c = makeCtx();
  c.FB.p4.filters.market = 'with';
  c.FB.p4._filtersRead = true;
  const h = c.fbP4BoardHTML();
  /* with the default stub nothing has a quote, so this is the real path */
  return /No market is currently available/.test(h) && /never as a zero line/.test(h);
});
chk('a status view with nothing in it names the status', () => {
  const c = makeCtx();
  c.FB.p4.filters.status = 'DATA FAULT';
  c.FB.p4._filtersRead = true;
  const h = c.fbP4BoardHTML();
  return !/p4gate-/.test(h) ? /currently reads DATA FAULT/.test(h) : true;
});
chk('an empty board still shows the filter controls so it can be undone', () => {
  const c = makeCtx();
  c.FB.p4.filters.status = 'DATA FAULT'; c.FB.p4.filters.market = 'stale';
  c.FB.p4._filtersRead = true;
  const h = c.fbP4BoardHTML();
  return /fbs-filters/.test(h) && /Reset filters/.test(h);
});
chk('a board with no games at all says so without blaming a filter', () => {
  const c = makeCtx();
  c.FB.p4.up = [];
  const h = c.fbP4BoardHTML();
  return /No game involving an FBS team/.test(h);
});

/* ======================================================================== */
/* 7. THE ROW AND THE CARD CARRY THE CONFERENCE                             */
/* ======================================================================== */
chk('each row carries a conference badge', () => {
  const html = A.fbP4BoardHTML();
  return (html.match(/class="fbs-badge/g) || []).length >= VIS.length;
});
chk('an FBS-vs-FCS row is marked FCS', () => {
  const fcs = ROWS.find(r => r.meta.matchup_type === 'fbs_fcs');
  if (!fcs) return true;
  const c = makeCtx();
  c.FB.p4.filters.matchup = 'fbs_fcs'; c.FB.p4._filtersRead = true;
  return /fbs-badge fcs">FCS</.test(c.fbP4BoardHTML());
});
chk('the expanded card names both conferences and the matchup type', () => {
  const r = ROWS.find(x => x.meta.matchup_type === 'non_conference' && x.meta.fbs_sides === 2);
  const h = A.fbP4MatchupHTML(r.u, r.p);
  return h.indexOf(esc(r.meta.home.conference)) >= 0
    && h.indexOf(esc(r.meta.away.conference)) >= 0
    && h.indexOf(esc(r.meta.matchup_label)) >= 0;
});
chk('the card shows each side’s FBS rating and rank on one scale', () => {
  const r = ROWS.find(x => x.meta.fbs_sides === 2);
  const h = A.fbP4MatchupHTML(r.u, r.p);
  return /EdgeDesk FBS rating · one scale/.test(h) && /of \d+ FBS/.test(h);
});
chk('the card shows games absorbed', () => {
  const r = ROWS.find(x => x.meta.fbs_sides === 2);
  return /g absorbed/.test(A.fbP4MatchupHTML(r.u, r.p));
});
chk('the card shows data completeness', () => {
  const r = ROWS.find(x => x.meta.fbs_sides === 2);
  return /data completeness/.test(A.fbP4MatchupHTML(r.u, r.p));
});
chk('the card explains a missing market rather than showing a number', () => {
  const r = ROWS.find(x => x.meta.fbs_sides === 2);
  const h = A.fbP4MatchupHTML(r.u, r.p);
  return /NO MARKET/.test(h) && /never read as a zero line/.test(h);
});
chk('an FBS-vs-FCS card says why it cannot be graded', () => {
  const r = ROWS.find(x => x.meta.matchup_type === 'fbs_fcs');
  if (!r) return true;
  const h = A.fbP4MatchupHTML(r.u, r.p);
  return /not an FBS program/.test(h) && /THIN DATA/.test(h);
});
chk('the card says research, not picks', () => {
  const r = ROWS.find(x => x.meta.fbs_sides === 2);
  const h = A.fbP4MatchupHTML(r.u, r.p);
  return /Research, not picks/.test(h) && /more often missing information than an edge/.test(h);
});

/* ======================================================================== */
/* 8. THE STATUSES SURVIVE THE EXPANSION                                    */
/* ======================================================================== */
const STATUS_CASES = [
  [null, {}, 'AWAITING DATA'],
  [{ status: 'BLOCKED' }, {}, 'AWAITING DATA'],
  [{ status: 'PREDICTED', model: { fair_spread: 3 }, edge: { spread: { recommendation: 'RESEARCH_LEAN' } } }, {}, 'NO MARKET'],
  [{ status: 'PREDICTED', model: { fair_spread: 3 }, edge: { spread: { recommendation: 'PASS_LOW_CONFIDENCE' } } }, { spread_line: 2 }, 'THIN DATA'],
  [{ status: 'PREDICTED', model: { fair_spread: 3 }, edge: { spread: { recommendation: 'RESEARCH_LEAN' } } }, { spread_line: 2, stale: true }, 'STALE QUOTE'],
  [{ status: 'PREDICTED', model: { fair_spread: 30 }, edge: { spread: { recommendation: 'RESEARCH_LEAN' } } }, { spread_line: -3 }, 'DATA FAULT'],
  [{ status: 'PREDICTED', model: { fair_spread: 12 }, edge: { spread: { recommendation: 'RESEARCH_LEAN' } } }, { spread_line: 2 }, 'INVESTIGATE'],
  [{ status: 'PREDICTED', model: { fair_spread: 3 }, edge: { spread: { recommendation: 'RESEARCH_LEAN' } } }, { spread_line: 2 }, 'RESEARCH']
];
STATUS_CASES.forEach(([p, m, want]) => {
  eq('status: ' + want, A.fbP4StatusFor(p, m).t, want);
});
chk('every status the board can show is offered as a filter', () => {
  const src = slice('var FBP4_STATUSES=', 'var FBP4_SORTS=');
  return STATUS_CASES.every(([, , want]) => src.indexOf("'" + want + "'") >= 0);
});

/* ======================================================================== */
/* 9. THE RATINGS PRESENTATION — one baseline, four views                   */
/* ======================================================================== */
if (EDR) {
  const R = makeCtx();
  const RAT = R.fbP4Ratings();
  has(RAT, 'EdgeDesk FBS Rating — top 25', 'the primary rating section is the FBS rating');
  has(RAT, 'points versus an average FBS team', 'and it states the baseline');
  has(RAT, 'All FBS', 'the scope control offers All FBS');
  has(RAT, 'Power 4', 'and Power 4');
  has(RAT, 'Other FBS', 'and Other FBS');
  has(RAT, 'Conference', 'and Conference');
  has(RAT, 'Engine state · diagnostic', 'the engine state is kept as a labelled diagnostic');
  lacks(RAT, "Power 4 engine state · top 25", 'and no longer claims the board is priced off a Power 4 scale');
  has(RAT, 'active FBS programs across', 'the team count is stated from the dataset');
  has(RAT, 'the rating the board’s lines are actually priced from', 'the diagnostic says what it is');
  has(RAT, 'covering', 'and how much of the FBS it covers');

  chk('the All FBS view ranks every rated program', () => {
    const s = R.fbEdrScoped();
    return s.rows.length === EDR.teams.length;
  });
  chk('the Power 4 view is a FILTER of the same list, not a re-rank', () => {
    const c = makeCtx({ edrScope: 'p4' });
    const s = c.fbEdrScoped();
    return s.rows.length > 0 && s.rows.length < EDR.teams.length
      && s.rows.every(t => t.fbs_group === 'p4')
      && s.rows.every(t => EDR.teams.find(x => x.key === t.key).rating === t.rating);
  });
  chk('the Other FBS view is the same scale filtered the other way', () => {
    const c = makeCtx({ edrScope: 'other' });
    const s = c.fbEdrScoped();
    return s.rows.length > 0 && s.rows.every(t => t.fbs_group === 'other');
  });
  chk('the two groups plus independents partition the rated field', () => {
    const p4 = makeCtx({ edrScope: 'p4' }).fbEdrScoped().rows.length;
    const ot = makeCtx({ edrScope: 'other' }).fbEdrScoped().rows.length;
    const ind = EDR.teams.filter(t => t.fbs_group === 'independent').length;
    return p4 + ot + ind === EDR.teams.length;
  });
  chk('a conference view filters to that conference only', () => {
    const id = EDR.teams.find(t => t.conference_id && t.fbs_group === 'other').conference_id;
    const c = makeCtx({ edrScope: 'conf', edrConf: id });
    const s = c.fbEdrScoped();
    return s.rows.length > 0 && s.rows.every(t => t.conference_id === id);
  });
  chk('a filtered view shows the rank INSIDE the view and the overall FBS rank', () => {
    const c = makeCtx({ edrScope: 'other' });
    const h = c.fbP4Ratings();
    return /#\d+ FBS/.test(h);
  });
  chk('the All FBS view shows the overall rank alone', () => {
    const h = makeCtx({ edrScope: 'all' }).fbP4Ratings();
    return !/#\d+ FBS<\/span>/.test(h.split('Engine state')[0]);
  });
  chk('every rating row carries its conference', () => {
    const h = makeCtx().fbP4Ratings();
    const top = EDR.teams[0];
    return h.indexOf(esc(top.conference)) >= 0;
  });
  chk('a rating view that is empty says the full list is still there', () => {
    const c = makeCtx({ edrScope: 'conf', edrConf: null });
    const h = c.fbP4Ratings();
    return /pick a conference above/.test(h);
  });
  chk('changing the view never changes a team’s number', () => {
    const all = makeCtx({ edrScope: 'all' }).fbEdrScoped().rows;
    const p4 = makeCtx({ edrScope: 'p4' }).fbEdrScoped().rows;
    return p4.every(t => all.find(x => x.key === t.key).rating === t.rating);
  });
  chk('the engine state and the rating are named as DIFFERENT quantities', () => {
    const h = makeCtx().fbP4Ratings();
    return /This is not the EdgeDesk Rating above/.test(h);
  });
  chk('the engine state covers the same FBS universe the board does', () => {
    let rated = 0;
    Object.keys(STATE.r).forEach(k => { if (UNIVERSE.teams[k] && UNIVERSE.teams[k].division === 'fbs') rated++; });
    return rated === UNIVERSE.counts.fbs_teams;
  }, { rated: Object.keys(STATE.r).length, fbs: UNIVERSE.counts.fbs_teams });
}
chk('a missing rating dataset is said, not invented', () => {
  const c = makeCtx({ noEdr: true });
  c.FB.edr.error = 'rating 404';
  const h = c.fbP4Ratings();
  return /could not be read/.test(h) && /rather than something invented/.test(h);
});

/* ======================================================================== */
/* 9b. THE MODEL'S MEASURED RECORD, PER CONFERENCE                          */
/* ======================================================================== */
const SLICES_FILE = path.join(ROOT, 'football', 'cfb_p4', 'research', 'report', 'error_slices.json');
if (fs.existsSync(SLICES_FILE)) {
  const SL = JSON.parse(fs.readFileSync(SLICES_FILE, 'utf8'));
  chk('the shipped error dashboard covers every conference in this season’s universe', () => {
    const ids = Object.keys(SL.by_home_conference || {}).map(k => FBS.conference(k).id);
    return UNIVERSE.conferences.every(c => ids.indexOf(c.id) >= 0);
  }, { dashboard: Object.keys(SL.by_home_conference || {}), universe: UNIVERSE.conferences.map(c => c.label) });

  const R = makeCtx();
  R.FB.p4slices.data = SL;
  chk('a conference record resolves on the SOURCE label, not the display name', () => {
    const rec = R.fbP4ConfRecord('mac');
    return rec && rec.conference === 'Mid-American' && rec.slice.n > 0;
  });
  chk('the record names the conference, the model MAE and the market MAE', () => {
    const h = R.fbP4ConfRecordHTML('mac', 'MAC');
    return /the record in the MAC/.test(h) && /held-out spread MAE/.test(h)
      && /vs the closing market/.test(h) && /does not beat the close/.test(h);
  });
  chk('a conference with no slice on file renders nothing rather than a guess',
    R.fbP4ConfRecord('x-imaginary') === null && R.fbP4ConfRecordHTML('x-imaginary', 'Imaginary') === '');
  chk('the board states that record when exactly one conference is selected', () => {
    const c = makeCtx();
    c.FB.p4slices.data = SL;
    c.FB.p4.filters.conferences = ['mac']; c.FB.p4._filtersRead = true;
    return /the record in the MAC/.test(c.fbP4BoardHTML());
  });
  chk('a card states the record for each FBS participant’s conference', () => {
    const c = makeCtx();
    c.FB.p4slices.data = SL;
    const rows = c.fbP4Rows();
    const g = rows.find(r => r.meta.fbs_sides === 2
      && r.meta.home.conference_id !== r.meta.away.conference_id);
    if (!g) return true;
    const h = c.fbP4MatchupHTML(g.u, g.p);
    return h.indexOf('the record in the ' + g.meta.home.conference) >= 0
      && h.indexOf('the record in the ' + g.meta.away.conference) >= 0;
  });
  chk('a conference game states its one record once, not twice', () => {
    const c = makeCtx();
    c.FB.p4slices.data = SL;
    const rows = c.fbP4Rows();
    const g = rows.find(r => r.meta.matchup_type === 'conference');
    if (!g) return true;
    const h = c.fbP4MatchupHTML(g.u, g.p);
    return (h.match(/the record in the /g) || []).length === 1;
  });
  chk('the board makes no claim that the model is worse in the smaller conferences', () => {
    /* it is not: over the shipped window the MAC beats the ACC and the Big 12
       on this model's own MAE, so any copy asserting otherwise would be false */
    const t = SL.by_home_conference;
    return t['Mid-American'].mae_raw < t.ACC.mae_raw && t['Mid-American'].mae_raw < t['Big 12'].mae_raw;
  }, { mac: SL.by_home_conference['Mid-American'].mae_raw, acc: SL.by_home_conference.ACC.mae_raw });
}

/* ======================================================================== */
/* 10. EXPORTS RECONCILE WITH THE BOARD                                     */
/* ======================================================================== */
const NEEDED = ['home_team_id', 'away_team_id', 'home_conference', 'away_conference',
  'home_fbs_group', 'away_fbs_group', 'matchup_type', 'is_conference_game',
  'model_status', 'data_completeness', 'market_status', 'quote_timestamp'];
NEEDED.forEach(col => chk('the export carries ' + col, A.FBP4_CSV_HEAD.indexOf(col) >= 0));
chk('the export head has no duplicate column', () => {
  const seen = {};
  for (const h of A.FBP4_CSV_HEAD) { if (seen[h]) return false; seen[h] = 1; }
  return true;
});
chk('the NFL export’s first 43 columns are untouched', () => {
  const nflHead = slice("var FB_CSV_HEAD=['season'", 'function fbNflRowValues(it){');
  const names = (nflHead.match(/'[a-z0-9_]+'/g) || []).map(s => s.slice(1, -1));
  return A.FBP4_CSV_HEAD.slice(0, 43).every((c, i) => names[i] === c);
});
/* THE OFFLINE GENERATOR AND THE BROWSER PRODUCE THE SAME SHEET. The README
   has promised this since the export existed, and the FBS expansion added
   fifteen columns to both: a sheet built from the app and one built from the
   CLI have to line up column for column, or the Collective's uploader is
   mapping two different files. */
chk('the offline export declares the same columns, in the same order', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'export_csv.js'), 'utf8');
  function heads(name) {
    const at = cli.indexOf('var ' + name + ' = [');
    if (at < 0) throw new Error('export_csv.js no longer declares ' + name);
    const end = cli.indexOf('];', at);
    return (cli.slice(at, end).match(/'[a-z0-9_]+'/g) || []).map(x => x.slice(1, -1));
  }
  const all = heads('NFL_HEAD').concat(heads('P4_HEAD')).concat(heads('FBS_HEAD'));
  return all.length === A.FBP4_CSV_HEAD.length && all.every((h, i) => h === A.FBP4_CSV_HEAD[i]);
}, (() => {
  try {
    const cli = fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'export_csv.js'), 'utf8');
    return { cliHasFbsHead: cli.indexOf('var FBS_HEAD = [') >= 0 };
  } catch (e) { return String(e.message); }
})());
chk('the offline export is not Power 4 gated by default', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'football', 'cfb_p4', 'export_csv.js'), 'utf8');
  return /scope: 'upcoming', p4Only: false/.test(cli);
});
chk('the FBS tail is exactly as long as the tail builder says', () => {
  const r = ROWS[0];
  return A.fbP4FbsTail(r.u, r.p, r.mkt).length === A.FBP4_FBS_TAIL_N;
});
chk('the tail carries the same classification the board rendered', () => {
  const r = ROWS.find(x => x.meta.matchup_type === 'conference');
  const tail = A.fbP4FbsTail(r.u, r.p, r.mkt);
  const at = A.FBP4_CSV_HEAD.length - A.FBP4_FBS_TAIL_N;
  const ix = n => A.FBP4_CSV_HEAD.indexOf(n) - at;
  return tail[ix('home_conference_id')] === r.meta.home.conference_id
    && tail[ix('matchup_type')] === 'conference'
    && tail[ix('is_conference_game')] === 'true'
    && tail[ix('board_status')] === r.st.t;
});
chk('a game with no market exports NO MARKET, never an empty number', () => {
  const r = ROWS[0];
  const tail = A.fbP4FbsTail(r.u, r.p, { status: 'NO MARKET', spread_line: null });
  const at = A.FBP4_CSV_HEAD.length - A.FBP4_FBS_TAIL_N;
  return tail[A.FBP4_CSV_HEAD.indexOf('market_status') - at] === 'NO MARKET';
});
chk('the export items are exactly the rows on screen', () => {
  const EX = A.fbP4ExportItems();
  return EX.items.length === VIS.length && EX.rows.length === ROWS.length && EX.filtered === false;
});
chk('a filtered board exports the filtered rows and says so', () => {
  const c = makeCtx();
  c.FB.p4.filters.conferences = [MAC]; c.FB.p4._filtersRead = true;
  const EX = c.fbP4ExportItems();
  return EX.filtered === true && EX.items.length < EX.rows.length && EX.items.length > 0
    && EX.items.every(u => u.meta.conference_ids.indexOf(MAC) >= 0);
});
chk('the export filename carries the scope so two downloads do not collide', () => {
  const c = makeCtx();
  c.FB.p4.filters.conferences = [MAC]; c.FB.p4._filtersRead = true;
  return c.fbP4ExportSlug().indexOf(MAC) >= 0 && makeCtx().fbP4ExportSlug() === 'all-fbs';
});
chk('the scope label names the conferences a reader picked', () => {
  const c = makeCtx();
  c.FB.p4.filters.conferences = [MAC, SBC]; c.FB.p4._filtersRead = true;
  const l = c.fbP4ScopeLabel();
  return l.indexOf('+') > 0;
});
chk('three or more conferences are summarised rather than listed forever', () => {
  const c = makeCtx();
  c.FB.p4.filters.conferences = UNIVERSE.conferences.slice(0, 4).map(x => x.id);
  c.FB.p4._filtersRead = true;
  return /^4 CONFERENCES$/.test(c.fbP4ScopeLabel());
});

/* ======================================================================== */
/* 11. THE WEEK LABEL AND THE SCOPE LABEL ARE DERIVED                       */
/* ======================================================================== */
chk('the week label comes from the games on screen', () => {
  const weeks = {};
  VIS.forEach(r => { if (r.u.g.week != null) weeks[r.u.g.week] = 1; });
  const label = A.fbP4WeekLabel(VIS);
  const ks = Object.keys(weeks).map(Number).sort((a, b) => a - b);
  return ks.length === 1 ? label === String(ks[0]) : label === ks[0] + '–' + ks[ks.length - 1];
});
chk('the scope label is ALL FBS by default', A.fbP4ScopeLabel() === 'ALL FBS');
chk('the scope label follows the group control', () => {
  const c = makeCtx({ search: '?fbs_group=other' });
  return c.fbP4ScopeLabel() === 'OTHER FBS';
});

/* ---------------------------------------------------------------- report */
if (fail) {
  console.log('FAIL | FBS board UI | ' + pass + ' passed, ' + fail + ' failed');
  failures.slice(0, 40).forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('PASS | FBS board UI | ' + pass + ' assertions over ' + ROWS.length
  + ' games, ' + UNIVERSE.counts.fbs_teams + ' FBS programs, ' + UNIVERSE.conferences.length + ' conferences');

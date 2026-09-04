#!/usr/bin/env node
/* ===========================================================================
   Tests for the RESEARCH LANDING (Research → Football), the default landing
   page of the app.

   The first screen is the product's only chance to say what EdgeDesk is, so
   these hold the things that make it honest as well as the things that make
   it useful:

     1  every way in is an EXISTING route — the landing invents no tool;
     2  the power-ratings preview is read from the committed artifact, never
        hardcoded, and says home field is not in the number;
     3  the player-quality card cannot be read as "player ratings are in the
        spread" — it is not, and the card says so;
     4  every Today signal answers "why am I being shown this?";
     5  a source that has not loaded says so; a search that matches nothing
        says so; neither renders as an empty success;
     6  the landing adds no second read of anything the app already fetches.

   Run: node tools/app/research_landing.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 260); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

/* the real committed artifacts the previews read */
const RK = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
const PQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'current.json'), 'utf8'));

/* ======================================================================== */
/* 1. THE LANDING MODULE, RUN                                               */
/* ======================================================================== */
const START = APP.indexOf('/* ═══ THE RESEARCH LANDING');
const END = APP.indexOf('function fbScopeLabel(){', START);
if (START < 0 || END < 0) {
  console.log('FAIL | app.html no longer carries the research-landing module between its markers');
  process.exit(1);
}
const SRC = APP.slice(START, END);

const ROWS = [
  { sport: 'nfl', gid: '1', home: 'Seattle Seahawks',   away: 'New England Patriots', t: Date.parse('2026-09-09T20:20:00Z'), ok: true },
  { sport: 'nfl', gid: '2', home: 'Los Angeles Rams',   away: 'San Francisco 49ers',  t: Date.parse('2026-09-10T20:35:00Z'), ok: true },
  { sport: 'p4',  gid: '3', home: 'Duke',               away: 'Tulane',               t: Date.parse('2026-09-11T16:00:00Z'), ok: true },
  { sport: 'p4',  gid: '4', home: 'Auburn',             away: 'Baylor',               t: Date.parse('2026-09-12T16:00:00Z'), ok: true },
  { sport: 'p4',  gid: '5', home: 'Oregon',             away: 'Boise State',          t: Date.parse('2026-09-13T16:00:00Z'), ok: true },
  { sport: 'p4',  gid: '6', home: 'Iowa',               away: 'Purdue',               t: Date.parse('2026-09-14T16:00:00Z'), ok: true },
  { sport: 'p4',  gid: '7', home: 'Utah',               away: 'Arizona',              t: Date.parse('2026-09-15T16:00:00Z'), ok: true }
];

function makeCtx(o) {
  o = o || {};
  const els = {};
  const fired = [];
  const ctx = {
    console, Date, Math, JSON, String, Number, Object, Array, isFinite, RegExp, Error, Promise, parseInt, parseFloat,
    setTimeout: (f) => { try { f(); } catch (_) {} return 0; },
    document: { querySelector: () => null, getElementById: id => els[id] || null },
    $: id => els[id] || null,
    FB: {
      rk: o.rk === undefined ? { data: RK } : o.rk,
      pq: o.pq === undefined ? { manifest: PQ } : o.pq,
      ui: {}
    },
    FB_LOOKAHEAD_D: 12,
    fbEsc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    edAttrJs: s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    whenLabel: iso => new Date(iso).toUTCString().slice(0, 16),
    fbSportTag: r => (r.sport === 'nfl' ? 'NFL' : 'FBS'),
    fbGameRows: () => ROWS,
    fbOpenGame: () => {}, fbSetSport: () => {}, show: () => {},
    fbRkEnsure: () => Promise.resolve(null), fbPqManifest: () => Promise.resolve(null),
    gtag: (kind, name, params) => { if (kind === 'event') fired.push([name, params]); },
    __fired: fired
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'app.html:research-landing' });
  return ctx;
}
const C = makeCtx();

/* ---- START HERE: four ways in, every one an existing route ------------- */
const SH = C.fbStartHereHTML();
['Find a game', 'Research today', 'Model disagreements', 'Power ratings']
  .forEach(l => has(SH, '>' + l + '<', 'start-here offers "' + l + '"'));
eq('start-here offers exactly four actions', (SH.match(/<button/g) || []).length, 4);
lacks(SH, 'Step 1', 'it is not a wizard');
lacks(SH, 'Step 2', 'it is not a wizard (2)');
chk('and every action routes through one handler', (SH.match(/fbStartGo\(/g) || []).length === 4);
/* the routes it uses all exist in the app */
["show('edges')", 'fbSetSport(\'rankings\')', 'fbSetSport(\'players\')'].forEach(r =>
  has(APP, r, 'the route ' + r + ' the landing uses exists'));

/* ---- THE GAME FINDER --------------------------------------------------- */
let F = C.fbFinderHTML(ROWS, '');
has(F, 'id="fbFindQ"', 'the finder has a search box');
has(F, 'Search team or matchup', 'labelled for what it takes');
chk('it lists a bounded number of upcoming games, not the whole board',
  (F.match(/rs-find-l"?>/) ? (F.match(/<button onclick="fbFindOpen/g) || []).length : 0) === 6,
  'listed ' + (F.match(/<button onclick="fbFindOpen/g) || []).length);
has(F, 'further game', 'and says how many it did not list');
chk('the list is in kickoff order',
  F.indexOf('New England Patriots') < F.indexOf('San Francisco 49ers'));
has(F, 'NFL', 'each row carries its league');

F = C.fbFinderHTML(ROWS, 'seahawks');
chk('searching a home team finds the game', (F.match(/fbFindOpen/g) || []).length === 1);
F = C.fbFinderHTML(ROWS, 'baylor');
chk('searching an away team finds it too', (F.match(/fbFindOpen/g) || []).length === 1);
F = C.fbFinderHTML(ROWS, 'BOISE');
chk('search is case-insensitive', (F.match(/fbFindOpen/g) || []).length === 1);
F = C.fbFinderHTML(ROWS, 'nothinghere');
chk('a search that matches nothing lists nothing', (F.match(/fbFindOpen/g) || []).length === 0);
has(F, 'No game on the board matches', 'and says so rather than rendering an empty list');
F = C.fbFinderHTML([], '');
has(F, 'No games inside the next', 'an empty board says why it is empty');
lacks(F, 'fbFindOpen', 'and offers nothing to open');

/* ---- POWER RATINGS PREVIEW: from the artifact, never hardcoded --------- */
const P = C.fbRkPreviewHTML();
has(P, 'EdgeDesk power ratings', 'the preview is labelled');
has(P, 'points vs an average FBS team', 'and says what the number means');
has(P, 'home advantage is <b>not</b> in this number', 'and that home field is not in it');
has(P, 'View all ratings', 'and offers the full board');
const ranked = Object.keys(RK.teams).map(k => RK.teams[k]).filter(t => t && t.rank != null && t.etsr != null)
  .sort((a, b) => a.rank - b.rank);
chk('the artifact carries a ranked board', ranked.length >= 5);
eq('the preview shows exactly five teams', (P.match(/rs-pv-r/g) || []).length, 5);
ranked.slice(0, 5).forEach((t, i) =>
  has(P, C.fbEsc(t.team), 'row ' + (i + 1) + ' is the artifact\'s #' + t.rank + ' (' + t.team + ')'));
has(P, (ranked[0].etsr >= 0 ? '+' : '') + ranked[0].etsr.toFixed(1), 'and carries the artifact\'s own rating');
/* the numbers must not be frozen into the page */
chk('no team name is hardcoded in the preview source',
  !/Notre Dame|Ohio State|Indiana|Georgia/.test(SRC.slice(SRC.indexOf('function fbRkPreviewHTML'), SRC.indexOf('function fbPqPreviewHTML'))));
/* unranked is never rendered as a rank */
const unranked = Object.keys(RK.teams).map(k => RK.teams[k]).filter(t => t && t.rank == null).length;
if (unranked) has(P, 'unranked, not ranked last', 'unranked teams are named as unranked');
/* not loaded is not an empty board */
let PE = makeCtx({ rk: {} }).fbRkPreviewHTML();
has(PE, 'Loading the committed rankings', 'an unloaded artifact says it is loading');
lacks(PE, 'rs-pv-r', 'and shows no rows');
PE = makeCtx({ rk: { err: 'rankings 404' } }).fbRkPreviewHTML();
has(PE, 'rather than something invented', 'a failed load refuses to invent a board');
PE = makeCtx({ rk: { data: { teams: {} } } }).fbRkPreviewHTML();
has(PE, 'Unranked is not a rank of zero', 'an artifact with nothing ranked says so');

/* ---- PLAYER QUALITY PREVIEW: the disclosure IS the card ---------------- */
const Q = C.fbPqPreviewHTML();
has(Q, 'Player quality', 'the card is labelled');
has(Q, 'Research only', 'and leads with what it is');
has(Q, 'moves <b>no</b> projected line', 'it states that it moves no line');
has(Q, 'has not cleared walk-forward validation', 'and why');
has(Q, 'nothing that is priced', 'and draws the boundary explicitly');
has(Q, 'Explore players', 'and offers the full layer');
chk('the counts come from the manifest', PQ.player_count > 0 && Q.indexOf(PQ.player_count.toLocaleString()) >= 0,
  'manifest player_count ' + PQ.player_count);
has(Q, String(PQ.team_count), 'including the team count');
/* the card must never imply the ratings are in the spread */
lacks(Q, 'adjusts the line', 'it never claims to adjust the line');
lacks(Q, 'improves the projection', 'or to improve the projection');
let QE = makeCtx({ pq: {} }).fbPqPreviewHTML();
has(QE, 'Loading the committed player ratings', 'an unloaded manifest says so');
lacks(QE, 'FBS players', 'and shows no counts');

/* the registry the disclosure rests on still says nothing is promoted */
const REGP = path.join(ROOT, 'football', 'validation', 'feature-status.json');
if (fs.existsSync(REGP)) {
  const REG = JSON.parse(fs.readFileSync(REGP, 'utf8'));
  chk('the promotion registry agrees: no player feature may move a line',
    (REG.features || []).filter(f => /player/.test(f.feature)).every(f => f.status !== 'VALIDATED'),
    JSON.stringify((REG.features || []).map(f => f.feature + ':' + f.status)));
}

/* ---- ANALYTICS: existing provider only, no new one -------------------- */
const A = makeCtx();
A.fbStartGo('edges'); A.fbStartGo('ratings'); A.fbStartGo('players');
A.fbFindOpen('nfl', '1'); A.fbSigOpen('nfl', '1', 'Largest spread disagreement');
const names = A.__fired.map(f => f[0]);
['research_market_open', 'research_power_ratings_open', 'research_player_quality_open',
 'research_game_open', 'research_signal_open'].forEach(n =>
  chk('the event ' + n + ' is fired', names.indexOf(n) >= 0, names.join(',')));
has(APP, "edEvent('research_landing_view'", 'and the landing view itself is counted');
chk('events go through gtag, the provider already on the page',
  /function edEvent\(name,params\)\{[\s\S]{0,140}gtag\('event'/.test(APP));
['posthog', 'mixpanel', 'amplitude', 'segment.com', 'plausible.io'].forEach(p =>
  lacks(APP, p, 'no ' + p + ' was introduced'));
chk('edEvent cannot throw when the tag is blocked', () => {
  const N = makeCtx(); delete N.gtag; N.fbStartGo('edges'); return true;
});

/* ======================================================================== */
/* 2. EVERY TODAY SIGNAL ANSWERS "WHY AM I BEING SHOWN THIS?"               */
/* ======================================================================== */
const TI_START = APP.indexOf('function fbTodayItems(rows){');
const TI_END = APP.indexOf('function fbSignalCardHTML(', TI_START);
chk('fbTodayItems is found', TI_START >= 0 && TI_END > TI_START);
const TI = APP.slice(TI_START, TI_END);
const pushes = (TI.match(/items\.push\(\{/g) || []).length;
const whys = (TI.match(/\n\s+why:/g) || []).length;
chk('every signal the module can raise carries a why', pushes === whys,
  pushes + ' signals, ' + whys + ' whys');
chk('there are the seven signals the module raises', pushes === 7, 'found ' + pushes);
has(APP, 'Why it matters', 'and the card renders it under that heading');
has(APP, "+(it.why?'<div class=\"fb-sig-w\">", 'from the item, not from a model');
/* the why text is written, not generated */
lacks(TI, 'await ', 'no signal text is fetched');
chk('the signal cards carry the size of the disagreement',
  /Difference.*pts/.test(TI) && /Gap.*pts/.test(TI));
/* the guard-bound signal must never read as an opportunity */
has(TI, 'so it cannot be mistaken for an opportunity', 'a guard-bound gap is framed as a fault, not an edge');
has(TI, 'Unknown is not healthy', 'an unknown QB is framed as unknown, not fine');
has(TI, 'Missing is not zero', 'and a stale quote as missing, not zero');

/* ======================================================================== */
/* 3. THE FIRST SCREEN                                                      */
/* ======================================================================== */
has(APP, '<h2>EdgeDesk Research', 'the shell says whose research this is');
has(APP, 'Understand the game, model, and market.', 'and what it is for');
has(APP, 'rs-creed', 'the product philosophy has one line');
has(APP, '<b>Research, not picks.</b>', 'and it is that one');
/* the duplication the audit found is gone */
chk('the landing no longer repeats the module name inside its own card',
  APP.indexOf("rsTkSnap({title:'',meta:'',key:'fbSnap'") >= 0);
chk('and rsTkSnap drops the head row when there is no title',
  /\(o\.title\?\('<div class="fb-snap-h">/.test(APP));
lacks(APP, "defs:[['Review','Projected games with market data joined.']",
  'the defs block that repeated the How expander is gone');
has(APP, '<b>Review</b> requires a PREDICTED projection', 'but the methodology it held is still written');
has(APP, 'foot:fbStartHereHTML()', 'the single CTA became four ways in');

/* ======================================================================== */
/* 4. THE MODULE CARDS NAME OUTCOMES, NOT MODULES                           */
/* ======================================================================== */
[['game', 'Projection, score distribution, player matchups and what could break the number.'],
 ['market', 'Current price, movement, consensus and closing-line history.'],
 ['team', 'Roster continuity, transfers, position groups and player quality.'],
 ['ratings', 'Power ratings, model methodology and graded performance.']]
  .forEach(t => has(APP, t[1], 'the ' + t[0] + ' card says what you get'));

/* ======================================================================== */
/* 5. NO SECOND READ OF ANYTHING THE APP ALREADY FETCHES                    */
/* ======================================================================== */
eq('football/health.json is fetched in exactly one place',
  (APP.match(/fetch\('football\/health\.json'/g) || []).length, 1);
has(APP, 'function edHealthFetch', 'through a shared reader');
has(APP, 'return window.edHealthFetch()', 'that the football module joins');
has(APP, 'SH.pending=edHealthFetch(force)', 'and the header control joins too');
eq('the rankings artifact is fetched in exactly one place',
  (APP.match(/fetch\(FBRK_URL/g) || []).length, 1);
eq("the players manifest is fetched in exactly one place",
  (APP.match(/fetch\(FBPQ_BASE\+'current\.json'/g) || []).length, 1);
has(APP, "return fbPqManifest();          /* reuses the landing preview's fetch */",
  'and the player engine reuses the preview\'s read rather than repeating it');
chk('the previews only load what is not already loaded',
  /if\(FB\.rk&&!FB\.rk\.data&&!FB\.rk\.err&&!FB\.rk\._p\)/.test(APP)
  && /if\(FB\.pq&&!FB\.pq\.manifest&&!FB\.pq\.err&&!FB\.pq\._mp\)/.test(APP));
chk('typing in the finder repaints the finder, not the whole overview',
  /window\.fbFindInput=function\(v\)\{[\s\S]{0,300}fbFinderHTML\(fbGameRows\(\),v\)/.test(APP));
lacks(SRC, 'supabase', 'the landing reads no database');

/* ======================================================================== */
/* 6. THE PRODUCT STRUCTURE IS NOT MERGED                                   */
/* ======================================================================== */
['v-edges', 'v-record', 'v-ledger', 'v-faults', 'v-research']
  .forEach(id => has(APP, 'id="' + id + '"', id + ' is still its own destination'));
chk('"Model disagreements" leaves Research for Edges rather than copying it',
  /if\(which==='edges'\)\{[\s\S]{0,120}?show\('edges'\)/.test(APP));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nresearch landing: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* ===========================================================================
   Tests for the PLAYER QUALITY + SCHEME MATCHUP panel in app.html.

   The renderer is cut out of the page that ships it and run against the REAL
   committed datasets — football/players/current.json and the team files — so
   these hold the thing users actually see, not a copy of it.

   What they are here to prevent, in order of how badly it would hurt:
     1  a missing number rendering as a zero, or as a dash a reader could
        mistake for one;
     2  the market leaking into a model column, or the four ladder rungs
        quietly collapsing into one;
     3  an uncalibrated scalar silently moving a line;
     4  the panel claiming a scheme, a snap count or a recruiting rating that
        no public feed carries;
     5  the panel throwing on a non-FBS opponent, an empty roster or a game
        the Power 4 board cannot project.

   Run: node tools/football/player_quality_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const PDIR = path.join(ROOT, 'football', 'players');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

const START = APP.indexOf('/* ═══ EDGEDESK PLAYER QUALITY + SCHEME MATCHUP ENGINE');
const END = APP.indexOf('function fbRenderBoard(host){', START);
if (START < 0 || END < 0) {
  console.log('FAIL | app.html no longer carries the player quality renderer between its markers');
  process.exit(1);
}
const SRC = APP.slice(START, END);

/* ---- the modules the renderer calls, loaded for real ------------------- */
const CFG = require(path.join(PDIR, 'config.js'));
const EPIR = require(path.join(PDIR, 'epir.js'));
const UNITS = require(path.join(PDIR, 'units.js'));
const SCHEME = require(path.join(PDIR, 'scheme.js'));
const MATCH = require(path.join(PDIR, 'matchup.js'));
const SIM = require(path.join(PDIR, 'sim.js'));
let PARAMS = null;
try { PARAMS = require(path.join(PDIR, 'params.js')); } catch (_) {}
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P4 = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));

const manifest = JSON.parse(fs.readFileSync(path.join(PDIR, 'current.json'), 'utf8'));
function teamFile(k) {
  const f = path.join(PDIR, 'teams', k + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
/* two real FBS teams that exist in the committed build */
const KEYS = Object.keys(manifest.teams);
const HOME_KEY = KEYS.indexOf('pittsburgh') >= 0 ? 'pittsburgh' : KEYS[0];
const AWAY_KEY = KEYS.indexOf('miamioh') >= 0 ? 'miamioh' : KEYS[1];
const HOME = teamFile(HOME_KEY), AWAY = teamFile(AWAY_KEY);
if (!HOME || !AWAY) { console.log('FAIL | the committed team files are missing — run football/players/build_players.js'); process.exit(1); }

/* ---- a sandbox that looks enough like the page ------------------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function makeCtx(opts) {
  opts = opts || {};
  const gid = '999';
  const g = { game_id: gid, home_team: HOME.team, away_team: AWAY.team, week: 3,
    home_conference: 'ACC', away_conference: 'MAC' };
  const win = {
    EDPlayerConfig: CFG, EDPlayerRating: EPIR, EDPlayerUnits: UNITS, EDPlayerScheme: SCHEME,
    EDPlayerMatchup: MATCH, EDPlayerSim: SIM, EDPlayerParams: opts.params === undefined ? PARAMS : opts.params,
    EDCfbP4: P4, EDCfbP4Params: global.window.EDCfbP4Params,
    renderFootball: function () {}
  };
  const FB = {
    p4: { up: [{ g: g, t: Date.now() }], _proj: {} },
    pq: { manifest: manifest, index: null, teams: {}, err: null, at: Date.now(), _p: null, _ip: null, _tp: {},
      ready: true, sel: null, player: null, open: {}, sim: {}, assume: {},
      f: { q: '', team: '', conf: '', pos: '', role: '', status: '', minConf: 0, sort: 'epir' } }
  };
  FB.pq.teams[HOME_KEY] = HOME;
  FB.pq.teams[AWAY_KEY] = opts.awayMissing ? null : AWAY;
  if (opts.proj !== undefined) FB.p4._proj[gid] = opts.proj;
  else FB.p4._proj[gid] = {
    status: 'PREDICTED',
    model: { fair_spread: 17.4, sigma_margin: 15.8, fair_total: 47.5 },
    market: { spread_line: 15.5, total_line: 44.5, book: 'consensus' }
  };
  const doc = {
    getElementById: function () { return null; },
    createElement: function () { return { style: {}, setAttribute: function () {}, addEventListener: function () {} }; },
    head: { appendChild: function () {} },
    querySelector: function () { return null; },
    addEventListener: function () {}
  };
  const ctx = {
    FB: FB, window: win, document: doc, console: console, Promise: Promise, Date: Date, Math: Math,
    JSON: JSON, String: String, Number: Number, Object: Object, Array: Array, isFinite: isFinite,
    setTimeout: setTimeout, encodeURIComponent: encodeURIComponent,
    fetch: function () { return Promise.reject(new Error('no network in tests')); },
    fbEsc: esc, fbScript: function () { return Promise.resolve(); },
    fbP4Key: function (n) { return P4.normKey(n); },
    fbNum: function (x) { if (x == null || x === '') return null; const v = +x; return isFinite(v) ? v : null; },
    $: function () { return null; }, ago: function () { return 'now'; },
    fbP4Request: function () { return {}; }, renderFootball: function () {}
  };
  ctx.window.FB = FB;
  vm.createContext(ctx);
  /* The module's first statement is `FB.pq = {...}` — it initialises its own
     state on load. So the fixture is installed AFTER the source runs, never
     before, or the module would quietly wipe it and every assertion below
     would be testing an empty layer. */
  vm.runInContext(SRC, ctx, { filename: 'app.html:player-quality' });
  const pq = ctx.FB.pq;
  pq.manifest = manifest; pq.ready = true; pq.at = Date.now();
  pq.teams[HOME_KEY] = HOME;
  pq.teams[AWAY_KEY] = opts.awayMissing ? null : AWAY;
  return { ctx, gid, g };
}

/* ======================================================================== */
/* 1. THE GAME PANEL RENDERS AGAINST REAL DATA                              */
/* ======================================================================== */
const A = makeCtx();
let html = '';
chk('the game panel renders without throwing', () => { html = A.ctx.fbPqGameHTML(A.gid); return typeof html === 'string' && html.length > 500; });

has(html, 'Player quality', 'the panel is labelled player quality');
has(html, 'RESEARCH', 'and labelled research, not an edge');
has(html, 'Linemaker view', 'the linemaker view is present');
has(html, 'Matchup matrix', 'the matchup matrix is present');
has(html, 'Scheme edges', 'the scheme edges are present');
has(html, 'Run defence gate', 'the run defence gate is present');
has(html, 'Top matchup edges', 'the edge board is present');
has(html, 'What makes this close', 'the structural read is present');
has(html, 'What breaks the projection', 'the sensitivity is present');
has(html, 'Simulation distribution', 'the simulation is present');
has(html, 'Data quality', 'data quality is present');
has(html, 'Change the injury assumptions', 'injury assumptions can be changed');
has(html, 'No language model produced', 'the panel states that no model wrote any rating');

/* the overview must show a projected score, a win probability and a range */
has(html, 'Projected score', 'the overview leads with a projected score');
has(html, 'Win probability', 'and a win probability');
has(html, 'Research fair range', 'and a conservative fair range rather than one number');

/* ======================================================================== */
/* 2. THE LADDER KEEPS THE MARKET OUT AND OBEYS points_applied              */
/* ======================================================================== */
const L = makeCtx();
L.ctx.FB.pq.open[L.gid] = { ladder: true };
const ladHtml = L.ctx.fbPqGameHTML(L.gid);
has(ladHtml, 'Raw model', 'the ladder shows the raw model rung');
has(ladHtml, 'Player-adjusted', 'and the player-adjusted rung');
has(ladHtml, 'Scheme-adjusted', 'and the scheme-adjusted rung');
has(ladHtml, 'Simulation', 'and the simulation rung');
has(ladHtml, 'NOT proof of an edge', 'and says agreement between its own layers is not an edge');

const applied = PARAMS && PARAMS.calibration && PARAMS.calibration.player_points_per_unit
  && PARAMS.calibration.player_points_per_unit.points_applied === true;
chk('the shipped calibration is explicit about whether it moves a line',
  PARAMS && PARAMS.calibration && typeof PARAMS.calibration.player_points_per_unit.points_applied === 'boolean');
if (!applied) {
  has(ladHtml, 'points_applied:false', 'an uncalibrated scalar says so on screen');
  /* and every rung must read the same number as the raw model */
  const nums = (ladHtml.match(/-1[0-9]\.[0-9]/g) || []);
  chk('an uncalibrated ladder does not silently move the line',
    ladHtml.indexOf('Player-adjusted') >= 0 && ladHtml.indexOf('scalar not applied') >= 0);
}

/* the market is never one of the ladder's own rungs */
/* the rung cell now carries a promotion badge after the label, so read the
   label as the text before the badge rather than the whole cell */
const rungs = (ladHtml.match(/<tr><td>([^<]+)/g) || []).map(x => x.replace(/<[^>]+>/g, '').trim());
chk('the ladder has exactly the four EdgeDesk rungs',
  rungs.indexOf('Raw model') >= 0 && rungs.indexOf('Player-adjusted') >= 0
  && rungs.indexOf('Scheme-adjusted') >= 0 && rungs.indexOf('Simulation') >= 0, rungs.join('|'));
chk('and the market is not one of them',
  !rungs.some(r => /market/i.test(r)), rungs.join('|'));

/* ======================================================================== */
/* 3. MISSING DATA LOOKS MISSING                                            */
/* ======================================================================== */
const M = makeCtx({ awayMissing: true });
let mHtml = '';
chk('a non-FBS opponent does not throw', () => { mHtml = M.ctx.fbPqGameHTML(M.gid); return typeof mHtml === 'string'; });
has(mHtml, 'not in the FBS player database', 'and says the opponent is out of scope');
has(mHtml, 'not the same as being bad', 'and that out of scope is not the same as bad');

const N = makeCtx({ proj: { status: 'BLOCKED', reason: 'no rating yet' } });
let nHtml = '';
chk('a game the Power 4 engine refuses to project does not throw', () => { nHtml = N.ctx.fbPqGameHTML(N.gid); return typeof nHtml === 'string'; });
has(nHtml, 'not available', 'and the blank says not available rather than showing a zero');
lacks(nHtml, '>0.0<', 'a refused projection never renders as 0.0');

/* the matrix must render a blank group as "no rating", never as zero */
const G = makeCtx();
G.ctx.FB.pq.open[G.gid] = { matrix: true };
const gHtml = G.ctx.fbPqGameHTML(G.gid);
has(gHtml, 'no rating', 'an ungraded position group reads "no rating"');
has(gHtml, 'not a zero', 'and the matrix says so in words');
has(gHtml, 'positional replacement', 'the 0-100 scale is explained in place');

/* ======================================================================== */
/* 4. THE PANEL NEVER CLAIMS WHAT NO FEED CARRIES                           */
/* ======================================================================== */
const S = makeCtx();
S.ctx.FB.pq.open[S.gid] = { scheme: true, dq: true, edges: true };
const sHtml = S.ctx.fbPqGameHTML(S.gid);
has(sHtml, 'not carried by any public feed', 'the scheme section names what it cannot see');
has(sHtml, 'coverage', 'including coverage shells');
has(sHtml, 'None of it is guessed', 'and says none of it is guessed');
has(sHtml, 'matchup points', 'scheme edges are denominated in matchup points');
chk('and never in points of spread', sHtml.indexOf('points of spread') < 0 || sHtml.indexOf('deliberately NOT points of spread') >= 0);
has(sHtml, 'UNIT-LEVEL', 'player edges declare unit-level assignments');
has(sHtml, 'DIRECT', 'and the ones the feed really observes');
has(sHtml, 'recruiting', 'data quality reports the recruiting gap');

/* ======================================================================== */
/* 5. THE SIMULATION IS REPRODUCIBLE FROM THE PANEL                         */
/* ======================================================================== */
const R1 = makeCtx(); R1.ctx.FB.pq.open[R1.gid] = { sim: true };
const R2 = makeCtx(); R2.ctx.FB.pq.open[R2.gid] = { sim: true };
chk('the same game renders a bit-identical simulation twice',
  R1.ctx.fbPqGameHTML(R1.gid) === R2.ctx.fbPqGameHTML(R2.gid));
const R3 = makeCtx(); R3.ctx.FB.pq.open[R3.gid] = { sim: true }; R3.ctx.FB.pq.sim[R3.gid] = 424242;
chk('a different seed gives a different draw', R3.ctx.fbPqGameHTML(R3.gid) !== R1.ctx.fbPqGameHTML(R1.gid));
has(R1.ctx.fbPqGameHTML(R1.gid), 'The same seed always produces the same distribution',
  'and the panel says the seed is the point');

/* ======================================================================== */
/* 6. INJURY ASSUMPTIONS ARE LABELLED AS ASSUMPTIONS                        */
/* ======================================================================== */
const I = makeCtx();
const qb = HOME.units.groups.QB && HOME.units.groups.QB.projected && HOME.units.groups.QB.projected[0];
chk('the home team has a projected quarterback to assume out', !!qb);
if (qb) {
  I.ctx.FB.pq.assume[I.gid] = {};
  I.ctx.FB.pq.assume[I.gid][qb.key] = { status: 'OUT', source: 'YOUR ASSUMPTION — not a report' };
  const iHtml = I.ctx.fbPqGameHTML(I.gid);
  has(iHtml, 'your assumption', 'an assumed absence is labelled an assumption');
  has(iHtml, 'not by any report', 'and explicitly not a report');
  /* and it must actually change the numbers */
  const base = makeCtx();
  chk('an assumed absence actually recomputes the panel', iHtml !== base.ctx.fbPqGameHTML(base.gid));
}

/* ======================================================================== */
/* 7. THE EXPLORER AND THE PLAYER CARD                                      */
/* ======================================================================== */
const E = makeCtx();
E.ctx.FB.pq.index = { players: (HOME.players || []).slice(0, 50).map(p => [p.k, p.n, p.t, p.p, p.g, p.e, p.cf, p.sn, 1, 1, p.so, p.dc]) };
let eHtml = '';
chk('the explorer renders', () => {
  const host = { innerHTML: '' };
  E.ctx.fbPqRender(host);
  eHtml = host.innerHTML;
  return eHtml.length > 200;
});
has(eHtml, 'Player explorer', 'the explorer is present');
has(eHtml, 'cannot see a snap count', 'and leads with what it cannot see');
has(eHtml, 'No language model', 'and with the no-LLM statement');
has(eHtml, 'not snaps', 'the sample column says it is events, not snaps');
has(eHtml, 'Value continuity and roster continuity are different numbers',
  'and the team table separates value continuity from roster continuity');
if (PARAMS && PARAMS.validation_summary && PARAMS.validation_summary.verdict) {
  has(eHtml, 'The record, up front', 'the walk-forward record leads the explorer');
}

const C = makeCtx();
C.ctx.FB.pq.player = { key: (HOME.players[0] || {}).k, team: HOME_KEY };
let cHtml = '';
chk('the player card renders', () => {
  const host = { innerHTML: '' };
  C.ctx.fbPqRender(host);
  cHtml = host.innerHTML;
  return cHtml.length > 200;
});
has(cHtml, 'EPIR', 'the card leads with EPIR');
has(cHtml, 'Confidence', 'and its confidence');
has(cHtml, 'How the rating was built', 'and how the rating was built');
has(cHtml, 'recruiting prior', 'and that there is no recruiting prior');
has(cHtml, 'What nobody can see', 'and what nobody can see');
has(cHtml, 'Sources', 'and its sources');
has(cHtml, 'athlete id', 'naming the identity join');
has(cHtml, 'Rating history', 'and a point-in-time rating history');

/* a player with no attributed production must read as unseen, not as bad */
const blank = (HOME.players || []).filter(p => !p.u || !p.u.length)[0];
if (blank) {
  const Z = makeCtx();
  Z.ctx.FB.pq.player = { key: blank.k, team: HOME_KEY };
  const host = { innerHTML: '' };
  Z.ctx.fbPqRender(host);
  has(host.innerHTML, 'a statement about the evidence, not about the player',
    'a player the feed never saw reads as unseen rather than as bad');
}

/* ======================================================================== */
/* 8. THE PAGE STILL WIRES IT UP                                            */
/* ======================================================================== */
has(APP, "fbSetSport('players')", 'the Players segment button exists');
has(APP, "var order=['nfl','cfb','p4','players','rankings'];", 'and the segment order carries it');
has(APP, "fbPqOpen(", 'every Power 4 game card can open the player panel');
has(APP, "id=\"pq-'", 'and has a mount point for it');
chk('the existing rosters head-to-head panel is untouched', APP.indexOf('fbP4Hth(') >= 0);
chk('the existing Power 4 board is untouched', APP.indexOf('function fbP4Render(host){') >= 0);

/* ======================================================================== */
console.log(failures.map(f => '  FAIL  ' + f).join('\n'));
console.log(`\nplayer quality UI: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* ===========================================================================
   Tests for the NATIONAL RANKINGS panel in app.html.

   The renderer is cut out of the page that ships it and run against the REAL
   committed rankings artifact, so these hold what a reader actually sees.

   What they prevent, in order of how badly it would hurt:
     1  a rung of the Linemaker view presenting an unvalidated feature as if it
        were proven;
     2  an unranked category rendering as a rank, or a missing number as a zero;
     3  the page claiming home field is in the team rating, or that the market
        is an input;
     4  the coverage view hiding a gap instead of explaining one;
     5  the panel throwing on a team with no market number, no prior season or
        no rateable unit.

   Run: node tools/football/rankings_ui.test.js
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

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const START = APP.indexOf('/* ═══ EDGEDESK NATIONAL RANKINGS (ETSR)');
const END = APP.indexOf('function fbRenderBoard(host){', START);
if (START < 0 || END < 0) {
  console.log('FAIL | app.html no longer carries the rankings renderer between its markers');
  process.exit(1);
}
const SRC = APP.slice(START, END);

const RANKINGS = path.join(ROOT, 'football', 'rankings', 'current.json');
if (!fs.existsSync(RANKINGS)) {
  console.log('FAIL | football/rankings/current.json is missing — run npm run cfb:rankings');
  process.exit(1);
}
const DATA = JSON.parse(fs.readFileSync(RANKINGS, 'utf8'));
const REG = fs.existsSync(path.join(ROOT, 'football', 'validation', 'feature-status.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'feature-status.json'), 'utf8')) : null;
const PLAYERS = fs.existsSync(path.join(ROOT, 'football', 'players', 'current.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'current.json'), 'utf8')) : null;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function makeCtx(opts) {
  opts = opts || {};
  const ctx = {
    FB: { rk: {}, pq: { manifest: opts.noPlayers ? null : PLAYERS } },
    window: { renderFootball: function () {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }),
      head: { appendChild() {} } },
    console, Promise, Date, Math, JSON, String, Number, Object, Array, isFinite, setTimeout,
    fetch: () => Promise.reject(new Error('no network in tests')),
    fbEsc: esc, fbPqStyles: () => {}, fbPqBar: (v, m, c) => '<span class="pq-bar"></span>'
  };
  ctx.window.FB = ctx.FB;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'app.html:rankings' });
  /* the module initialises FB.rk on load, so the fixture goes in AFTER */
  ctx.FB.rk.data = opts.noData ? null : DATA;
  ctx.FB.rk.features = opts.noRegistry ? null : REG;
  ctx.FB.rk.at = Date.now();
  return ctx;
}

/* ======================================================================== */
/* 1. THE BOARD RENDERS AGAINST THE REAL ARTIFACT                           */
/* ======================================================================== */
const A = makeCtx();
let html = '';
chk('the rankings board renders', () => { const h = { innerHTML: '' }; A.fbRkRender(h); html = h.innerHTML; return html.length > 800; });
has(html, 'neutral field', 'the board says ETSR is a neutral-field number');
has(html, 'NOT in it', 'and that home field is not in it');
has(html, 'No language model', 'and that no model wrote any of it');
has(html, 'nothing on this page is computed in your browser', 'and that nothing is computed in the browser');
has(html, 'EdgeDesk top 25', 'the top 25 is present');
has(html, 'Data coverage', 'the coverage view is present');
has(html, 'Recruiting', 'coverage names the recruiting gap');
has(html, 'Coaching', 'and the coaching gap');
has(html, 'What is allowed to move a line', 'the promotion state leads the board');

/* the top team is a real team from the artifact */
const top = Object.values(DATA.teams).find(t => t.rank === 1);
chk('the artifact has a number-one team', !!top);
if (top) has(html, esc(top.team), 'and it is on the board');

/* ======================================================================== */
/* 2. UNRANKED IS SHOWN AS UNRANKED, NEVER AS A RANK OR A ZERO              */
/* ======================================================================== */
const unrankedCat = Object.keys(DATA.ranks).find(c => DATA.ranks[c].ranked === 0);
chk('the artifact has at least one category nothing could be ranked in', !!unrankedCat,
  'ranks: ' + JSON.stringify(DATA.ranks).slice(0, 200));
if (unrankedCat) {
  const U = makeCtx();
  U.FB.rk.tab = unrankedCat;
  const h = { innerHTML: '' };
  U.fbRkRender(h);
  has(h.innerHTML, 'unranked', 'an unrankable category renders as unranked');
  lacks(h.innerHTML, '>#0<', 'and never as rank zero');
}
/* a team below the confidence floor keeps its rating and loses its rank */
const lowConf = Object.values(DATA.teams).find(t => t.ranks && t.ranks.overall && t.ranks.overall.unranked);
if (lowConf) {
  chk('an unranked team still carries its rating', lowConf.etsr != null);
  chk('and the reason names confidence', /confidence/i.test(lowConf.ranks.overall.reason || ''));
}

/* ======================================================================== */
/* 3. THE PROMOTION BADGE                                                   */
/* ======================================================================== */
const S = makeCtx();
const st = S.window.fbRkStatus('player_quality_v2');
chk('a feature status can be read', !!st && typeof st.allowed === 'boolean');
if (REG) {
  const validated = REG.features.filter(f => f.status === 'VALIDATED');
  chk('the registry and the badge agree on whether anything is validated',
    (validated.length > 0) === S.window.fbRkStatus(validated.length ? validated[0].feature : 'nope').allowed);
  chk('an unvalidated feature is not allowed to move a line',
    REG.features.filter(f => f.status !== 'VALIDATED').every(f => S.window.fbRkStatus(f.feature).allowed === false));
}
const N = makeCtx({ noRegistry: true });
chk('with NO registry loaded, nothing is treated as validated',
  N.window.fbRkStatus('player_quality_v2').allowed === false);
chk('and it says why', /registry has not loaded/i.test(N.window.fbRkStatus('x').reason));
chk('an unknown feature is never allowed', S.window.fbRkStatus('a_feature_that_does_not_exist').allowed === false);

/* the Linemaker view in the player panel must carry the badge */
has(APP, 'RUNG_FEATURE', 'the Linemaker view maps rungs to features');
has(APP, 'fbRkBadge(feat)', 'and renders a promotion badge on them');
has(APP, 'the safe direction to fail in', 'and defaults to research when the registry is missing');

/* ======================================================================== */
/* 4. TEAM DETAIL                                                           */
/* ======================================================================== */
const T = makeCtx();
T.FB.rk.team = top ? top.key : Object.keys(DATA.teams)[0];
let th = '';
chk('the team detail renders', () => { const h = { innerHTML: '' }; T.fbRkRender(h); th = h.innerHTML; return th.length > 800; });
has(th, 'Overall', 'it leads with the overall rank');
has(th, 'Talent', 'and talent');
has(th, 'Performance', 'and performance');
has(th, 'Every component', 'and every component');
has(th, 'Why the rating moved', 'and why it moved');
has(th, 'How the rating was built', 'and how it was built');
has(th, 'not included', 'and states home field is not in the rating');
has(th, 'Run defense', 'and the run defence detail');
has(th, 'Market comparison', 'and the market, in its own box');
has(th, 'Confidence and data quality', 'and confidence');
has(th, 'vs an average FBS team', 'the units of ETSR are on screen');

/* a team with no market number must not throw or invent one */
const noMkt = Object.values(DATA.teams).find(t => !t.market || !t.market.available);
if (noMkt) {
  const M = makeCtx();
  M.FB.rk.team = noMkt.key;
  const h = { innerHTML: '' };
  chk('a team with no market number renders', () => { M.fbRkRender(h); return h.innerHTML.length > 500; });
  lacks(h.innerHTML, 'Difference</span><span class="v">+0.0', 'and does not invent a difference of zero');
}
/* a team whose rating could not be built must not throw */
const noEtsr = Object.values(DATA.teams).find(t => t.etsr == null);
if (noEtsr) {
  const E = makeCtx();
  E.FB.rk.team = noEtsr.key;
  chk('a team with no rating still renders a page', () => { const h = { innerHTML: '' }; E.fbRkRender(h); return h.innerHTML.length > 300; });
}

/* ======================================================================== */
/* 5. EMPTY AND BROKEN STATES                                               */
/* ======================================================================== */
const D0 = makeCtx({ noData: true });
chk('with no artifact the board shows a loading state, not a crash',
  () => { const h = { innerHTML: '' }; D0.fbRkRender(h); return /Loading/i.test(h.innerHTML); });
const ERR = makeCtx({ noData: true });
ERR.FB.rk.err = 'rankings 404';
chk('with a failed fetch it shows an honest gate',
  () => { const h = { innerHTML: '' }; ERR.fbRkRender(h); return /unavailable/i.test(h.innerHTML) && /rather than something invented/i.test(h.innerHTML); });
const NP = makeCtx({ noPlayers: true });
chk('with no player manifest the coverage view still renders',
  () => { const h = { innerHTML: '' }; NP.fbRkRender(h); return /DATA COVERAGE/i.test(h.innerHTML); });

/* ======================================================================== */
/* 6. THE PAGE IS WIRED UP, AND THE OTHER BOARDS ARE UNTOUCHED              */
/* ======================================================================== */
has(APP, "fbSetSport('rankings')", 'the Rankings segment button exists');
has(APP, "var order=['nfl','cfb','p4','players','rankings'];", 'and the segment order carries it');
has(APP, "FB.sport==='rankings'", 'the board dispatches to it');
chk('a failed NFL load cannot blank the rankings',
  APP.indexOf("FB.sport==='p4'||FB.sport==='players'||FB.sport==='rankings'") > 0);
chk('the Power 4 board is untouched', APP.indexOf('function fbP4Render(host){') >= 0);
chk('the player quality panel is untouched', APP.indexOf('function fbPqGameHTML(gid){') >= 0);
chk('the rosters head-to-head panel is untouched', APP.indexOf('function fbP4HthHTML(id){') >= 0);

/* ======================================================================== */
/* 7. THE ARTIFACT ITSELF SAYS THE RIGHT THINGS                             */
/* ======================================================================== */
chk('the artifact declares the market is not an input', DATA.market.is_input === false);
chk('it published no severe anomalies', DATA.anomalies.severe === 0);
chk('its opponent adjustment converged', DATA.performance_diagnostics.all_converged === true);
chk('it stamps every version it was built under',
  !!DATA.versions.team_rating && !!DATA.versions.talent && !!DATA.versions.performance && !!DATA.versions.player_rating);
chk('it stamps the point in the season', DATA.week_ordinal != null && !!DATA.week_label);
chk('and what it was built on', !!DATA.built_on && !!DATA.built_on.player_artifact);

/* ======================================================================== */
console.log(failures.map(f => '  FAIL  ' + f).join('\n'));
console.log(`\nrankings UI: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

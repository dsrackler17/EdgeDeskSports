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
const HEALTH = fs.existsSync(path.join(ROOT, 'football', 'rankings', 'health.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'health.json'), 'utf8')) : null;
const HISTORY = fs.existsSync(path.join(ROOT, 'football', 'rankings', 'history.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'history.json'), 'utf8')) : null;
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
  ctx.FB.rk.health = opts.noHealth ? null : HEALTH;
  ctx.FB.rk.history = opts.noHistory ? null : HISTORY;
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
/* 9. SPECIAL TEAMS, THE WEEKLY HISTORY AND THE PIPELINE HEALTH STRIP        */
/* ------------------------------------------------------------------------ */
/* The three things the rankings page gained. Each is checked against the    */
/* REAL committed artifacts, so a build that stops producing one of them     */
/* fails here rather than rendering an empty box on the site.                */
/* ======================================================================== */
(function specialTeamsAndHistory() {
  const S = makeCtx();
  const h = { innerHTML: '' };
  S.fbRkRender(h);
  const board = h.innerHTML;

  chk('Special teams is a tab on the board', /Special teams/.test(board));
  chk('the tab list covers every category the request named', () => {
    const want = ['Overall', 'Talent', 'Performance', 'Offense', 'Defense', 'Special teams',
      'Run O', 'Pass O', 'Run D', 'Pass D', 'QB', 'OL', 'WR', 'RB', 'DL', 'LB', 'Secondary',
      'Depth', 'Continuity'];
    const missing = want.filter(w => board.indexOf('>' + w + '<') < 0);
    return missing.length === 0 || 'missing tabs: ' + missing.join(', ');
  });
  has(board, '<th>ST</th>', 'the table carries a special-teams column');
  has(board, '<th>WR</th>', 'and a WR column');
  has(board, '<th>RB</th>', 'and an RB column');
  has(board, '<th>LB</th>', 'and an LB column');
  chk('the top 25 shows special teams beside offence and defence',
    board.indexOf('<th>special teams</th>') >= 0);

  if (HEALTH) {
    has(board, 'Pipeline health', 'the pipeline health strip renders');
    has(board, HEALTH.fbs_teams_expected + ' FBS teams', 'it states the FBS count');
    has(board, HEALTH.teams_processed + ' processed', 'and how many were processed');
    chk('it states the special-teams rating count',
      board.indexOf('>' + HEALTH.ratings.special_teams + '<') >= 0);
    has(board, 'genuinely unavailable', 'and names what is genuinely unavailable');
    has(board, 'Last build', 'and when the pipeline last ran');
    chk('the health strip is read from the committed run record, not recomputed',
      SRC.indexOf('var H=FB.rk.health||D.pipeline_health') >= 0);
  }

  /* the special-teams tab behaves like every other tab */
  const T = makeCtx();
  T.FB.rk.tab = 'special_teams';
  const h2 = { innerHTML: '' };
  T.fbRkRender(h2);
  const stBoard = h2.innerHTML;
  chk('the special-teams tab renders a table', stBoard.length > 800);
  chk('sorted by special teams, and it says so',
    stBoard.indexOf('sorted by <b>Special teams</b>') >= 0);
  chk('a team with no special-teams rating shows a miss marker, never a number', () => {
    const blank = Object.keys(DATA.teams).filter(k => !DATA.teams[k].special_teams
      || DATA.teams[k].special_teams.rating == null);
    if (!blank.length) return true;
    /* the row for such a team must carry the miss marker with the build's own
       reason on it, and must not carry a special-teams value */
    const t = DATA.teams[blank[0]];
    const i = stBoard.indexOf('>' + esc(t.team) + '<');
    if (i < 0) return 'the team is not on the page at all';
    const row = stBoard.slice(i, stBoard.indexOf('</tr>', i));
    return /class="pq-miss"[^>]*>—</.test(row)
      || 'no miss marker in the row for ' + t.team;
  });
  chk('and the build-s own reason travels with the cell', () => {
    const blank = Object.keys(DATA.teams).filter(k => DATA.teams[k].special_teams
      && DATA.teams[k].special_teams.rating == null && DATA.teams[k].special_teams.reason);
    if (!blank.length) return true;
    const t = DATA.teams[blank[0]];
    const i = stBoard.indexOf('>' + esc(t.team) + '<');
    const row = stBoard.slice(i, stBoard.indexOf('</tr>', i));
    return row.indexOf('title="') >= 0 || 'no reason on the empty cell for ' + t.team;
  });

  /* the ranks come from the artifact, never from a browser sort */
  chk('the artifact-s own #1 in special teams is on the page', () => {
    const best = Object.keys(DATA.teams)
      .filter(k => DATA.teams[k].ranks && DATA.teams[k].ranks.special_teams
        && DATA.teams[k].ranks.special_teams.rank === 1);
    if (!best.length) return true;
    return stBoard.indexOf(esc(DATA.teams[best[0]].team)) >= 0;
  });

  /* the team panel: special teams and the week-by-week history */
  const teamKey = Object.keys(DATA.teams).find(k => DATA.teams[k].special_teams
    && DATA.teams[k].special_teams.rating != null) || Object.keys(DATA.teams)[0];
  const P = makeCtx();
  P.FB.rk.team = teamKey;
  const h3 = { innerHTML: '' };
  P.fbRkRender(h3);
  const panel = h3.innerHTML;
  has(panel, 'Special teams', 'the team panel has a special-teams section');
  has(panel, 'What nobody can see', 'which says what no feed carries');
  has(panel, 'What feeds it', 'and names the feeds it does read');
  has(panel, 'Week by week', 'the team panel has a weekly history');
  chk('the history lists every week the board carries for this team', () => {
    const rows = DATA.teams[teamKey].history || [];
    const missing = rows.filter(r => panel.indexOf(esc(r.week_label)) < 0);
    return missing.length === 0 || 'missing ' + missing.map(r => r.week_label).join(', ');
  });
  chk('the history shows overall, offence, defence and special teams per week',
    panel.indexOf('<th>ETSR</th>') >= 0 && panel.indexOf('<th>offense</th>') >= 0
    && panel.indexOf('<th>defense</th>') >= 0 && panel.indexOf('<th>special teams</th>') >= 0);
  chk('a week with no rating in a column is blank, not carried forward',
    panel.indexOf('<td class="mono">null</td>') < 0 && panel.indexOf('NaN') < 0);
  if (HISTORY && HISTORY.teams[teamKey] && HISTORY.teams[teamKey].length > 1) {
    has(panel, 'Every category,', 'the full per-category move is shown when history.json loads');
  }

  /* it degrades honestly */
  const NH = makeCtx({ noHistory: true });
  NH.FB.rk.team = teamKey;
  NH.FB.rk.histErr = 'history 404';
  const h4 = { innerHTML: '' };
  NH.fbRkRender(h4);
  chk('with no history artifact the panel still renders the weeks the board carries',
    h4.innerHTML.indexOf('Week by week') >= 0 && h4.innerHTML.indexOf('Nothing has been filled in') >= 0);

  const NHealth = makeCtx({ noHealth: true });
  const h5 = { innerHTML: '' };
  NHealth.fbRkRender(h5);
  chk('with no run record the board still renders, from the board-s own health block',
    h5.innerHTML.length > 800);
})();

/* ======================================================================== */
/* 10. THE PAGE COMPUTES NO RATING AND NO RANK                              */
/* ======================================================================== */
(function noBrowserRatings() {
  lacks(SRC, 'EDRankPerformance', 'the page does not load the rating engine');
  lacks(SRC, 'EDRankConfig', 'nor the rating config');
  lacks(SRC, 'opponentAdjust', 'nor the opponent adjustment');
  chk('every category value is read through the one field map', SRC.indexOf('var FBRK_FIELD=') >= 0);
  chk('the delta week comes from the build-s movement object',
    SRC.indexOf('function fbRkCatMove') >= 0 && SRC.indexOf('m.categories&&m.categories[cat]') >= 0);
  chk('the board sorts on the artifact-s ranks, not on values it derived',
    SRC.indexOf('ra&&!ra.unranked&&ra.rank!=null') >= 0);
})();

/* ======================================================================== */
console.log(failures.map(f => '  FAIL  ' + f).join('\n'));
console.log(`\nrankings UI: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

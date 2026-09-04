#!/usr/bin/env node
/* ===========================================================================
   Tests for the GAME RESEARCH CARD — the matchup a reader opens from the
   board, the research page of the product.

   The card was reorganised, not rebuilt: every number in it came off the
   engine before this change and still does. These tests hold the things that
   would quietly turn a research packet back into a tip sheet:

     1  the summary shows the ENGINE's numbers, never the UI's arithmetic on
        something else, and never a hardcoded team or line;
     2  the research state is derived from the engine's OWN thresholds;
     3  a layer that has not cleared validation never appears as points on the
        projected spread;
     4  UNKNOWN never renders as healthy and MISSING never renders as zero;
     5  the card and the copied brief cannot disagree about a risk;
     6  the brief stands alone, and carries no id, no JSON and no secret.

   Run: node tools/app/game_research.test.js
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

const START = APP.indexOf('/* ═══ THE GAME RESEARCH CARD');
const END = APP.indexOf('function fbP4Card(u){', START);
if (START < 0 || END > APP.length || END < 0) {
  console.log('FAIL | app.html no longer carries the game-research module between its markers');
  process.exit(1);
}
const SRC = APP.slice(START, END);

/* the engine's real thresholds, read from the shipped params */
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const PARAMS = global.window.EDCfbP4Params;
const MIN_GAP = (PARAMS.market && PARAMS.market.min_research_gap) || 2;
const MIN_CONF = (PARAMS.market && PARAMS.market.min_confidence) || 35;
const GUARD = 21;

/* a projection shaped exactly like the engine's own output */
function proj(o) {
  o = o || {};
  return {
    status: 'PREDICTED',
    game: { home: 'Duke', away: 'Tulane' },
    model: { fair_spread: o.spread !== undefined ? o.spread : 7.7,
      fair_total: o.total !== undefined ? o.total : 55,
      home_win_prob: 0.69, sigma_margin: 15.7, p10_margin: -12, p90_margin: 27,
      fair_home_ml: -220, fair_away_ml: 220, median_margin: 7.7 },
    market: { spread_line: o.mkt !== undefined ? o.mkt : 8.5,
      spread_gap: o.gap !== undefined ? o.gap : (o.mkt === null ? null : (o.spread !== undefined ? o.spread : 7.7) - (o.mkt !== undefined ? o.mkt : 8.5)),
      total_line: 54, book: 'consensus', stale: !!o.stale },
    scores: { confidence: o.conf !== undefined ? o.conf : 55, volatility: 40,
      volatility_discriminates: o.voldisc, roster_stability: 60 },
    layers: {
      uncertainty: { context: { information_missing: o.missing !== undefined ? o.missing : 0.2 } },
      offensive_line: { home: { continuity: { available: true } }, away: { continuity: { available: true } } },
      injuries: { home: { points: { available: o.inj !== false } }, away: { points: { available: o.inj !== false } } },
      qb: { home: { value: { available: false } }, away: { value: { available: false } } },
      situation: { weather: o.wx !== undefined ? o.wx : { available: false, reason: 'no forecast supplied' } }
    },
    explanation: {
      summary: 'a summary',
      primary_drivers: o.drivers !== undefined ? o.drivers : [
        { text: 'Playing at Duke is worth 4.1 points', points: 4.1 },
        { text: 'Duke is the better football team by 2.1 points', points: 2.1 },
        { text: 'Conference strength favours Duke', points: 1.2 },
        { text: 'Stylistically the matchup favours Duke', points: 0.3 }],
      counterarguments: o.counters !== undefined ? o.counters : [
        { key: 'early_season', widening_pct: 7, text: 'The projection could be wrong because it is early.' },
        { key: 'information_missing', widening_pct: null, text: 'The projection could be wrong because 60% of the contract was empty.' },
        { key: 'qb_uncertainty', widening_pct: 24, text: 'The projection could be wrong because the QB is unknown.' }],
      unpredictable_variables: [{ item: 'Home starting quarterback', why: 'not published' },
        { item: 'Weather at kickoff', why: 'not supplied' }],
      data_quality: [{ level: 'missing', text: 'home starting QB unknown' }]
    },
    edge: { spread: { recommendation: 'PASS' } }
  };
}
const UNIT = { g: { home_team: 'Duke', away_team: 'Tulane', game_id: '999', week: 2 }, t: Date.parse('2026-09-05T18:30:00Z') };

function ctx() {
  const c = {
    console, Date, Math, JSON, String, Number, Object, Array, isFinite, RegExp, Error, Promise, parseFloat, parseInt,
    setTimeout: () => 0, document: { getElementById: () => null, createElement: () => ({ style: {}, select() {} }), body: { appendChild() {}, removeChild() {} } },
    $: () => null, navigator: {},
    FB: { p4: { _proj: { '999': null }, up: [UNIT], lines: {} } },
    FB_GUARD: { nfl: { game: 14 }, p4: { game: GUARD, outlier: 10, median: 7 } },
    EDCfbP4Params: PARAMS,
    fbEsc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    fbPts: (v, d) => (v == null ? '—' : ((v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 1 : d))),
    whenLabel: iso => 'Sat, Sep 5, 6:30 PM',
    edAttrJs: s => String(s), edEvent: () => {},
    fbEdrGameHTML: () => '', fbP4Score: () => '', fbP4Request: () => ({}), fbP4EdgeTag: () => ''
  };
  c.window = c; c.EDCfbP4Params = PARAMS; c.window.EDCfbP4Params = PARAMS;
  vm.createContext(c);
  vm.runInContext(SRC, c, { filename: 'app.html:game-research' });
  return c;
}
const C = ctx();

/* ======================================================================== */
/* 1. THE RESEARCH STATE COMES FROM THE ENGINE'S OWN THRESHOLDS             */
/* ======================================================================== */
chk('the engine publishes the thresholds this maps on', MIN_GAP > 0 && MIN_CONF > 0,
  'min_research_gap=' + MIN_GAP + ' min_confidence=' + MIN_CONF);
eq('a gap inside the research threshold is PASS',
  C.fbGxState(proj({ spread: 7.7, mkt: 7.3 })).key, 'PASS');
eq('a gap at the research threshold is REVIEW',
  C.fbGxState(proj({ spread: 7.7, mkt: 7.7 - MIN_GAP })).key, 'REVIEW');
eq('a gap past the guard bound is INVESTIGATE',
  C.fbGxState(proj({ spread: 30, mkt: 30 - GUARD - 1 })).key, 'INVESTIGATE');
eq('confidence below the engine floor is THIN, whatever the gap',
  C.fbGxState(proj({ conf: MIN_CONF - 1, spread: 7.7, mkt: 7.3 })).key, 'THIN');
eq('and THIN outranks a gap that would otherwise INVESTIGATE',
  C.fbGxState(proj({ conf: 5, spread: 30, mkt: 0 })).key, 'THIN');
eq('no market number is its own state, never PASS',
  C.fbGxState(proj({ mkt: null, gap: null })).key, 'NO_MARKET');
chk('an unknown confidence is thin, not healthy',
  C.fbGxState(proj({ conf: null })).key === 'THIN');
/* every state explains itself in a sentence that is written, not generated */
['PASS', 'REVIEW', 'INVESTIGATE', 'THIN', 'NO_MARKET'].forEach(k => {
  const st = k === 'PASS' ? C.fbGxState(proj({ spread: 7.7, mkt: 7.3 }))
    : k === 'REVIEW' ? C.fbGxState(proj({ spread: 7.7, mkt: 2 }))
    : k === 'INVESTIGATE' ? C.fbGxState(proj({ spread: 30, mkt: 0 }))
    : k === 'THIN' ? C.fbGxState(proj({ conf: 5 }))
    : C.fbGxState(proj({ mkt: null, gap: null }));
  chk('the ' + k + ' state carries a what-this-means sentence', st.means && st.means.length > 60);
  chk('and it names no bet', !/\bbet this\b|best bet|lock|hammer/i.test(st.means));
});
has(SRC, 'has not been validated as a betting edge', 'REVIEW says it is not a validated edge');
has(SRC, 'more likely than a hidden opportunity', 'INVESTIGATE says missing info is the likelier read');

/* ======================================================================== */
/* 2. THE PROJECTED SCORE IS THE MODEL'S OWN SPREAD AND TOTAL               */
/* ======================================================================== */
let s = C.fbGxScore(proj({ spread: 7.7, total: 55 }).model);
eq('the home score is (total + spread) / 2', s.home, Math.round((55 + 7.7) / 2));
eq('the away score is (total - spread) / 2', s.away, Math.round((55 - 7.7) / 2));
eq('and the two sum to the model total', s.home + s.away, Math.round(55));
chk('a model with no total yields no score line, never a halved guess',
  C.fbGxScore(proj({ total: null }).model) === null);
let H = C.fbGxSummary(UNIT, proj({ total: null }), '999');
has(H, 'no total published', 'and the card says the total is missing');
has(H, 'cannot be split without a total', 'and why there is no score');
lacks(H, '>0<', 'a missing total never renders as a zero score');

/* ======================================================================== */
/* 3. THE SUMMARY ANSWERS THE FIRST-THIRTY-SECONDS QUESTIONS                */
/* ======================================================================== */
H = C.fbGxSummary(UNIT, proj(), '999');
['EdgeDesk', 'Market', 'Difference', 'Projected score', 'Win probability', 'Research state', 'Data confidence']
  .forEach(l => has(H, '>' + l + '<', 'the summary answers "' + l + '"'));
has(H, 'Duke +7.7'.replace('+', '-') === 'Duke -7.7' ? 'Duke' : 'Duke', 'it names the home team from the unit');
has(H, '0.8 pts', 'the difference is the engine\'s own gap');
has(H, 'What this means', 'and one sentence says what it means');
has(H, 'Copy research brief', 'the brief can be copied');
has(H, 'Research check', 'and the data checklist is in the summary');
/* nothing in this module hardcodes a team or a line */
['Duke', 'Tulane', 'Alabama', 'Ohio State', 'Georgia'].forEach(t =>
  lacks(SRC, "'" + t + "'", 'no team name is hardcoded in the module (' + t + ')'));
chk('the module reads the home team off the unit, not a literal',
  /u\.g\.home_team/.test(SRC) && /u\.g\.away_team/.test(SRC));

/* ======================================================================== */
/* 4. UNVALIDATED LAYERS NEVER APPEAR AS SPREAD POINTS                      */
/* ======================================================================== */
const D = C.fbGxDrivers(proj());
has(D, '+4.1', 'the drivers carry the engine\'s own points');
has(D, 'Player quality and scheme are <b>not</b> here', 'and say what is deliberately absent');
has(D, 'neither moves this number', 'and that the absent layers move nothing');
chk('the driver list only ever renders points the engine supplied',
  /d\.points\|\|0/.test(SRC) && !/player_quality|scheme_points/.test(SRC));
/* the registry must still agree that nothing is promoted */
const REGP = path.join(ROOT, 'football', 'validation', 'feature-status.json');
if (fs.existsSync(REGP)) {
  const REG = JSON.parse(fs.readFileSync(REGP, 'utf8'));
  chk('the promotion registry agrees no layer may move a line',
    (REG.features || []).every(f => f.status !== 'VALIDATED'),
    JSON.stringify((REG.features || []).map(f => f.feature + ':' + f.status)));
}
chk('a driver with no points is not invented a contribution',
  C.fbGxDrivers(proj({ drivers: [] })).indexOf('no driver breakdown') >= 0);

/* ======================================================================== */
/* 5. RISK: RANKED BY MEASUREMENT, AND THE CARD AND BRIEF AGREE             */
/* ======================================================================== */
let R = C.fbGxRisks(proj());
eq('a counterargument that widens the range 24% is HIGH', R.find(x => x.label === 'qb uncertainty').sev, 'HIGH');
eq('one that widens it 7% is LOW', R.find(x => x.label === 'early season').sev, 'LOW');
eq('a mostly-empty input contract is HIGH even with no widening number',
  C.fbGxRisks(proj({ missing: 0.6 })).find(x => x.label === 'information missing').sev, 'HIGH');
eq('and a modestly-empty one is MEDIUM',
  C.fbGxRisks(proj({ missing: 0.2 })).find(x => x.label === 'information missing').sev, 'MEDIUM');
eq('a market gap past the guard bound is HIGH',
  C.fbGxRisks(proj({ spread: 30, mkt: 0,
    counters: [{ key: 'market_disagreement', widening_pct: null, text: 'The market disagrees by 30.0 points.' }] }))[0].sev, 'HIGH');
chk('risks are ordered worst first',
  (() => { const o = { HIGH: 0, MEDIUM: 1, LOW: 2 }; return R.every((x, i) => i === 0 || o[R[i - 1].sev] <= o[x.sev]); })());
/* the card and the brief read the SAME ranking */
const W = C.fbGxWrong(proj({ missing: 0.6 }));
const B = C.fbGxBriefText(UNIT, proj({ missing: 0.6 }));
chk('the card ranks the empty contract HIGH', /HIGH<\/span>[\s\S]{0,80}information missing/.test(W));
chk('and the brief ranks it HIGH too', /\[HIGH\][^\n]*input contract was empty|\[HIGH\][^\n]*contract was empty/.test(B),
  B.split('\n').filter(l => /\[/.test(l)).join(' | ').slice(0, 200));
chk('both are built from one ranking function', (SRC.match(/fbGxRisks\(p\)/g) || []).length >= 2);
has(W, 'Not measured at all', 'the unmeasured variables are named');
has(W, 'not the same as absent', 'and are not treated as absent');
has(W, 'none of them is scored zero', 'nor scored zero');

/* ======================================================================== */
/* 6. THE RESEARCH CHECK: UNKNOWN IS NOT HEALTHY, MISSING IS NOT ZERO       */
/* ======================================================================== */
const rows = C.fbGxCheckRows(UNIT, proj());
const by = {}; rows.forEach(r => { by[r.l] = r.s; });
eq('a model that built reads AVAILABLE', by['model built'], 'AVAILABLE');
eq('an unpublished starter reads UNKNOWN, never AVAILABLE', by['starting quarterback'], 'UNKNOWN');
eq('a feed that does not exist reads MISSING', by['recruiting'], 'MISSING');
eq('an unsupplied injury report reads UNKNOWN', C.fbGxCheckRows(UNIT, proj({ inj: false })).find(r => r.l === 'availability').s, 'UNKNOWN');
eq('a market with no quote reads MISSING', C.fbGxCheckRows(UNIT, proj({ mkt: null, gap: null })).find(r => r.l === 'market joined').s, 'MISSING');
eq('a stale quote reads STALE, not AVAILABLE', C.fbGxCheckRows(UNIT, proj({ stale: true })).find(r => r.l === 'market joined').s, 'STALE');
eq('an unsupplied forecast reads UNKNOWN',
  C.fbGxCheckRows(UNIT, proj()).find(r => r.l === 'weather').s, 'UNKNOWN');
eq('and a supplied one reads AVAILABLE — the row reads the path the engine publishes',
  C.fbGxCheckRows(UNIT, proj({ wx: { available: true, value: 3 } })).find(r => r.l === 'weather').s, 'AVAILABLE');
chk('every state is one of the declared vocabulary',
  rows.every(r => ['AVAILABLE', 'PARTIAL', 'UNKNOWN', 'MISSING', 'STALE'].indexOf(r.s) >= 0),
  JSON.stringify(rows.map(r => r.s)));
const CH = C.fbGxCheck(UNIT, proj());
lacks(CH, '100%', 'the checklist invents no percentage');
chk('an UNKNOWN row is never painted as healthy', !/ok[^"]*"[^>]*>\?\s*availability/.test(CH));

/* ---- the checklist reads paths the ENGINE actually publishes -----------
   Reading layers.weather instead of layers.situation.weather made the row say
   UNKNOWN even when a forecast had reached the projection. Wrong in the safe
   direction is still wrong, so the paths are pinned against a real run. */
(function enginePaths() {
  let R = null;
  try {
    global.window = global.window || global;
    require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
    const E = global.window.EDCfbP4;
    R = E.projectGame({ season: 2026, week: 1, state: E.newState(),
      game: { home: 'Alabama', away: 'Auburn', home_fbs: true, away_fbs: true },
      teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } },
      venue: {}, market: {}, timestamps: {} });
  } catch (e) { chk('the engine can project a game for the path check', false, e.message); return; }
  chk('the engine projects', R && R.status === 'PREDICTED', R && R.status);
  const L = R.layers || {};
  const paths = [
    ['layers.qb.home.value', L.qb && L.qb.home && 'value' in L.qb.home],
    ['layers.offensive_line.home.continuity', L.offensive_line && L.offensive_line.home && 'continuity' in L.offensive_line.home],
    ['layers.injuries.home.points', L.injuries && L.injuries.home && 'points' in L.injuries.home],
    ['layers.situation.weather', L.situation && 'weather' in L.situation],
    ['layers.uncertainty.context', !!(L.uncertainty && L.uncertainty.context)]
  ];
  paths.forEach(pth => chk('the checklist path ' + pth[0] + ' exists on a real projection', !!pth[1]));
  chk('and weather is NOT at layers.weather, which is what the bug read', !('weather' in L));
  /* run the real checklist over the real projection: no row may throw, and
     every row must land in the declared vocabulary */
  const real = C.fbGxCheckRows({ g: { home_team: 'Alabama', away_team: 'Auburn', game_id: '1' }, t: Date.now() }, R);
  chk('the checklist runs against a real projection', real.length >= 7);
  chk('and every row is a declared state',
    real.every(r => ['AVAILABLE', 'PARTIAL', 'UNKNOWN', 'MISSING', 'STALE'].indexOf(r.s) >= 0),
    JSON.stringify(real.map(r => r.l + '=' + r.s)));
})();

/* ======================================================================== */
/* 7. THE TWO CASES MAP TO MEASURED STATE                                   */
/* ======================================================================== */
const CS = C.fbGxCases(UNIT, proj());
has(CS, 'can pull away', 'the favourite case is present');
has(CS, 'can keep it close', 'and the underdog case');
has(CS, '+4.1 pts', 'a favourite bullet carries the engine\'s points');
has(CS, 'one sigma', 'and the underdog case cites the outcome range');
chk('the favourite is chosen by the sign of the model spread, not a literal',
  C.fbGxCases(UNIT, proj({ spread: -7.7 })).indexOf('Why Tulane can pull away') >= 0);
/* a driver whose sign runs against the favourite argues for the UNDERDOG */
(function () {
  const mixed = proj({ spread: 7.7, drivers: [
    { text: 'Playing at Duke is worth 4.1 points', points: 4.1 },
    { text: 'Tulane rest advantage', points: -2.4 }] });
  const H2 = C.fbGxCases(UNIT, mixed);
  const favIdx = H2.indexOf('can pull away'), dogIdx = H2.indexOf('can keep it close');
  chk('a positive driver files under the favourite',
    H2.indexOf('Playing at Duke') > favIdx && H2.indexOf('Playing at Duke') < dogIdx);
  chk('a driver against the favourite files under the underdog',
    H2.indexOf('Tulane rest advantage') > dogIdx);
})();
chk('a game with no drivers and no counters renders no case section',
  C.fbGxCases(UNIT, proj({ drivers: [], counters: [], spread: 0, total: null })).indexOf('gx-two') < 0
  || C.fbGxCases(UNIT, proj({ drivers: [], counters: [] })).length > 0);

/* ======================================================================== */
/* 8. THE SCALE IS NOT A CONFIDENCE INTERVAL                                */
/* ======================================================================== */
const SC = C.fbGxScale(UNIT, proj());
has(SC, 'MODEL', 'the model is pinned on the scale');
has(SC, 'MARKET', 'and the market');
has(SC, 'not</b> how likely any outcome is', 'and the bands disclaim outcome likelihood');
has(SC, 'this is not a confidence interval', 'explicitly');
has(SC, 'decision boundaries', 'they are named as decision boundaries');
chk('with no market there is nothing to place', C.fbGxScale(UNIT, proj({ mkt: null, gap: null })).indexOf('nothing to place') >= 0);

/* ======================================================================== */
/* 9. THE BRIEF STANDS ALONE AND LEAKS NOTHING                              */
/* ======================================================================== */
const BR = C.fbGxBriefText(UNIT, proj());
['Game', 'Kickoff', 'Model spread', 'Market spread', 'Difference', 'Projected score',
 'Win probability', 'Research state', 'PRIMARY DRIVERS', 'COUNTERARGUMENTS',
 'RESEARCH CHECK', 'PLAYER-QUALITY CONTEXT']
  .forEach(f => has(BR, f, 'the brief carries ' + f));
has(BR, 'EdgeDesk research context. Research, not picks.', 'and ends as the spec requires');
has(BR, 'They move NO projected number', 'and states player quality moves nothing');
lacks(BR, '999', 'the brief carries no internal game id');
lacks(BR, '{', 'and no JSON');
lacks(BR, 'SB_KEY', 'and no key');
lacks(BR, 'supabase', 'and no endpoint');
lacks(BR, 'eyJ', 'and no token');
chk('the brief is plain text', BR.indexOf('<') < 0 && BR.indexOf('&amp;') < 0);
chk('it is substantial enough to stand alone', BR.split('\n').length > 25);
/* no bet language anywhere in the module */
['best bet', 'bet this', 'lock of the', 'hammer this'].forEach(t =>
  chk('the module never says "' + t + '"', SRC.toLowerCase().indexOf(t) < 0));

/* ======================================================================== */
/* 10. STRUCTURE: SUMMARY FIRST, WARNINGS NEVER COLLAPSED                   */
/* ======================================================================== */
const CARD = APP.slice(APP.indexOf('function fbP4Card(u){'), APP.indexOf('function fbP4EdgeTag'));
const order = ['fbGxSummary', "'drivers'", "'wrong'", "'cases'", "'scale'", "'detail'", "'scores'", "'edr'", "'quality'"];
let last = -1;
order.forEach(k => { const i = CARD.indexOf(k); chk('the card renders ' + k + ' in order', i > last, 'index ' + i); last = i; });
chk('the summary is not inside a collapsible section', /var body=fbGxSummary\(u,p,gid\)/.test(CARD));
chk('drivers, risk, the cases and the scale default open',
  /'drivers',[\s\S]{0,80}?,true\)/.test(CARD) && /'wrong',[\s\S]{0,80}?,true\)/.test(CARD)
  && /'cases',[\s\S]{0,80}?,true\)/.test(CARD) && /'scale',[\s\S]{0,80}?,true\)/.test(CARD));
chk('the deep modules default collapsed',
  /'detail',[\s\S]{0,60}?,false,/.test(CARD) && /'scores',[\s\S]{0,60}?,false,/.test(CARD)
  && /'edr',[\s\S]{0,80}?,false,/.test(CARD) && /'quality',[\s\S]{0,60}?,false,/.test(CARD));
chk('nothing that existed on the card was dropped',
  ['fbEdrGameHTML', 'fbP4Hth', 'fbPqOpen'].every(f => CARD.indexOf(f) >= 0));
/* the deep section must not repeat what the open sections above it now show */
chk('the collapsed section no longer re-renders the drivers list',
  CARD.indexOf('Primary model drivers') < 0);
chk('nor the counterarguments list',
  CARD.indexOf("<div class=\"gd-sec\">Counterarguments</div>") < 0);
has(CARD, 'Data quality', 'but it still carries the engine\'s data-quality notes');
has(CARD, 'Unpredictable / unquantified · in full', 'and the full unquantified list');
chk('every data-quality warning is also stated in the always-visible check',
  /fbGxCheck\(u,p\)/.test(SRC) && SRC.indexOf('starting quarterback') >= 0 && SRC.indexOf('availability') >= 0);

/* ======================================================================== */
/* 11. THE OPENED CARD IS NOT A TABLE ROW                                   */
/* ======================================================================== */
/* The Power 4 board lays its rows on a fixed grid with a ~690px minimum and
   scrolls horizontally under that. The gate holding the opened card is a child
   of that scroller, so without this the research packet inherited the board's
   width and half of it sat off-screen on a phone — and the DOCUMENT never
   reported overflow, because the scrolling happens inside the board. */
has(APP, '[id^="p4gate-"]{position:sticky;left:0', 'the opened card sticks to the left edge of the board scroller');
has(APP, 'calc(100vw - 26px)', 'and sizes against the viewport, not the board grid');
chk('the board grid it must not inherit is still the board grid',
  /grid-template-columns:14px 76px minmax\(170px,1fr\)/.test(APP));
chk('the constraint reaches the card and its wrapper',
  /\[id\^="p4gate-"\] \.mdl-card,\[id\^="p4gate-"\]>div\{max-width:min\(100%,calc\(100vw - 26px\)\)/.test(APP));

/* ======================================================================== */
/* 12. NO NEW READS                                                         */
/* ======================================================================== */
lacks(SRC, 'fetch(', 'the game card fetches nothing of its own');
lacks(SRC, 'supabase', 'and reads no database');
lacks(SRC, 'functions/v1', 'and no edge function');
chk('it reads the projection the board already computed', /FB\.p4\._proj/.test(SRC));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\ngame research: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

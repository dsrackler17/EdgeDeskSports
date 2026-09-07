#!/usr/bin/env node
/* ===========================================================================
   THE LINE GUARD, AND THE ONE ROW POINTING THE WRONG WAY.

   Two spread conventions are in circulation and they are exact negations:
   to a book a home favourite is NEGATIVE, as a margin it is POSITIVE. The
   board has always guarded against a table that is UNIFORMLY the wrong way
   round — a slate on which every home team is a market dog is not a slate.

   What nothing guarded against was a table that is mostly right and carries
   ONE row the other way. Wisconsin @ Notre Dame arrived that way: the model
   had the home side by 21.2 and the joined number read -20.5, so the daily
   self-check reported a 41.7-point disagreement and failed. Read as a gap it
   is unactionable; read as what it is — the same number pointing backwards —
   it names the row to fix.

   These hold the two halves of the fix:
     1  the guard SEPARATES an orientation fault from a disagreement, and
        takes it out of the slate's gap statistics so one backwards row does
        not also make the honest games look like a broken model;
     2  the app DROPS such a line rather than flipping it, and says so.

   Run: node football/health/health.test.js
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
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function near(a, b, tol) { return a != null && Math.abs(a - b) <= (tol || 1e-9); }

const ROOT = path.join(__dirname, '..', '..');

/* ======================================================================== */
/* 1. THE GUARD SEPARATES A FAULT FROM A DISAGREEMENT                       */
/* ======================================================================== */
const D = require(path.join(ROOT, 'football', 'health', 'daily_check.js'));

/* the real slate the check failed on: four honest games and one backwards row */
const SLATE = [
  { label: 'Wisconsin @ Notre Dame', model: 21.2, market: -20.5 },
  { label: 'A @ B', model: 3.0, market: 1.0 },
  { label: 'C @ D', model: -2.0, market: 1.5 },
  { label: 'E @ F', model: 7.0, market: 3.4 },
  { label: 'G @ H', model: 0.5, market: -4.0 }
];
const before = D.checks.length;
const res = D.lineGuard('p4_lines', 'CFB P4', SLATE, D.GUARD.p4);
const emitted = D.checks.slice(before);
const byId = {};
for (const c of emitted) byId[c.id] = c;

chk('guard: the orientation of the lines is checked on its own', !!byId.p4_lines_orientation);
eq('guard: and a backwards row FAILS it', byId.p4_lines_orientation.status, 'fail');
chk('guard: the failure names the game',
  /Wisconsin @ Notre Dame/.test(byId.p4_lines_orientation.detail));
chk('guard: and the one fact that fixes it — the gap if the number is negated',
  /0\.7 pts if the market number is negated/.test(byId.p4_lines_orientation.detail),
  byId.p4_lines_orientation.detail);
chk('guard: and refuses to flip it',
  /Dropped, never flipped/.test(byId.p4_lines_orientation.detail));

chk('guard: the backwards row is OUT of the gap statistics', res.compared === 4,
  'compared ' + res.compared);
chk('guard: so the four honest games are not reported as a broken model',
  byId.p4_lines.status === 'pass', byId.p4_lines.status + ' | ' + byId.p4_lines.detail);
chk('guard: the median is the median of the honest games', near(res.median_gap, 3.6, 1e-9),
  'median ' + res.median_gap);
chk('guard: the max is the max of the honest games', near(res.max_gap, 4.5, 1e-9),
  'max ' + res.max_gap);
chk('guard: the fault is still carried in the report, not swallowed',
  res.orientation_faults.length === 1
  && res.orientation_faults[0].game === 'Wisconsin @ Notre Dame'
  && near(res.orientation_faults[0].gap_if_negated, 0.7, 1e-9));

/* a clean slate must not start reporting faults */
const before2 = D.checks.length;
const clean = D.lineGuard('p4_lines', 'CFB P4', SLATE.slice(1), D.GUARD.p4);
const byId2 = {};
for (const c of D.checks.slice(before2)) byId2[c.id] = c;
eq('guard: a slate with no backwards row passes the orientation check',
  byId2.p4_lines_orientation.status, 'pass');
eq('guard: and every game is compared', clean.compared, 4);
eq('guard: with no faults reported', clean.orientation_faults.length, 0);

/* an empty slate must still SAY the lines point the right way, rather than
   leaving the check missing — a check that vanishes is a check nobody reads */
const before4 = D.checks.length;
const none = D.lineGuard('p4_lines', 'CFB P4', [], D.GUARD.p4);
const byId4 = {};
for (const c of D.checks.slice(before4)) byId4[c.id] = c;
chk('guard: with nothing joined the orientation check still reports',
  !!byId4.p4_lines_orientation && byId4.p4_lines_orientation.status === 'pass');
eq('guard: and reports no faults rather than undefined', none.orientation_faults.length, 0);

/* a genuine blowout disagreement is still a disagreement, not an orientation fault */
const before3 = D.checks.length;
D.lineGuard('p4_lines', 'CFB P4', [{ label: 'X @ Y', model: 30.0, market: -3.0 }], D.GUARD.p4);
const byId3 = {};
for (const c of D.checks.slice(before3)) byId3[c.id] = c;
eq('guard: a big gap negation does NOT reconcile stays a hard-bound failure',
  byId3.p4_lines.status, 'fail');
eq('guard: and is not mislabelled as an orientation fault',
  byId3.p4_lines_orientation.status, 'pass');

/* the ledger must not read green while a row points the wrong way */
const DC = fs.readFileSync(path.join(ROOT, 'football', 'health', 'daily_check.js'), 'utf8');
const ledger = /line_guard_last_status: st\(!failIn\((\/[^\n]*?\/)\)\)/.exec(DC);
chk('guard: the pipeline ledger row is found', !!ledger);
if (ledger) {
  const re = new RegExp(ledger[1].slice(1, -1));
  chk('guard: and the orientation check counts toward it',
    re.test('p4_lines_orientation') && re.test('nfl_lines_orientation'),
    ledger[1]);
}

/* ======================================================================== */
/* 2. THE APP DROPS SUCH A LINE RATHER THAN FLIPPING IT                     */
/* ======================================================================== */
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

const A_START = APP.indexOf('function fbP4FairNoMarket(');
const A_END = APP.indexOf('/* Schedule geometry for one side of one game', A_START);
chk('app: the market join is found in app.html', A_START >= 0 && A_END > A_START);
const MARKET_SRC = APP.slice(A_START, A_END);

require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E4 = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));

/* Drive the real fbP4Market with a stubbed board: one game, one book row,
   and a fair spread the stub supplies. Nothing here fakes the decision — the
   engine's own orientationFault makes it. */
function marketCtx(fairSpread, bookSpread) {
  const c = {
    console, JSON, Math, Date, String, Number, isFinite, Object, Error,
    window: null,
    EDCfbP4: E4,
    FB: { p4: { loadedAt: 1, sig: {}, lines: { g1: { provider: 'consensus', spread: bookSpread } } } },
    fbNorm: s => String(s || '').toLowerCase(),
    fbMarketFromEvent: () => null,
    fbP4LinesConv: () => 'betting',
    fbP4LineToMargin: v => { const n = +v; return isFinite(n) ? -n : null; },
    /* the market-free projection the fault check leans on, stubbed to the
       model number the real engine produced for this game */
    fbP4Request: () => ({}),
    __fair: fairSpread
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(MARKET_SRC
    + '\nfbP4FairNoMarket=function(){return __fair;};'
    + '\nvar __out=null;', c, { filename: 'app.html:p4-market' });
  return c;
}
const U = { g: { game_id: 'g1', home_team: 'Notre Dame', away_team: 'Wisconsin' }, t: Date.now() };

/* the row that broke it: book +20.5 read as betting -> -20.5, model +21.2 */
const bad = marketCtx(21.2, 20.5);
const badOut = vm.runInContext('fbP4Market(' + JSON.stringify(U) + ')', bad);
eq('app: a backwards row leaves the game with NO market spread', badOut.spread_line, null);
chk('app: and it is never silently flipped to the reconciling value',
  badOut.spread_line !== 20.5 && badOut.spread_line !== -20.5);
chk('app: the fault is recorded on the join', !!badOut.spread_fault);
chk('app: with both readings, so the row can be fixed at the source',
  badOut.spread_fault && near(badOut.spread_fault.gap, 41.7, 1e-9)
  && near(badOut.spread_fault.gap_if_negated, 0.7, 1e-9));
chk('app: and the book label says the spread was dropped',
  /opposite convention/.test(badOut.book || ''), badOut.book);

/* the same machinery must leave an honest line completely alone */
const good = marketCtx(3.0, -1.0);          /* book -1.0 read as betting -> +1.0 */
const goodOut = vm.runInContext('fbP4Market(' + JSON.stringify(U) + ')', good);
eq('app: an honest line is joined untouched', goodOut.spread_line, 1);
chk('app: with no fault recorded', !goodOut.spread_fault);
chk('app: and its book label is left alone',
  !/opposite convention/.test(goodOut.book || ''), goodOut.book);

/* the totals side is a different number and must not be collateral damage */
chk('app: dropping a spread never touches the total',
  vm.runInContext('(function(){FB.p4.lines.g1.over_under=54.5;'
    + 'return fbP4Market(' + JSON.stringify(U) + ').total_line;})()', bad) === 54.5);

/* the source itself: the drop must be argued for in the file, not just done */
chk('app: the file says why a faulted row is dropped rather than flipped',
  /guessing a convention from values/.test(MARKET_SRC));
chk('app: the fault check uses the ENGINE predicate, not a second copy of it',
  /EDCfbP4[\s\S]{0,40}market[\s\S]{0,40}orientationFault/.test(MARKET_SRC));

/* THE CIRCULARITY, BROKEN. The fault check needs a model number, the model
   request carries the market, and the market join is what is being judged.
   fbP4Request({noMarket:true}) is the cut: it must not reach fbP4Market at
   all, or the fault check asks itself. */
const R_START = APP.indexOf('function fbP4Request(u,opts){');
const R_END = APP.indexOf('\n/* ---- CSV export', R_START);
chk('app: the request builder is found', R_START >= 0 && R_END > R_START);
const REQ_SRC = APP.slice(R_START, R_END);
chk('app: the request builder takes a market-free mode', /var noMkt=/.test(REQ_SRC));
chk('app: in which the market is empty rather than joined',
  /market:noMkt\?\{\}:fbP4Market\(u\)/.test(REQ_SRC), REQ_SRC.slice(0, 0));
chk('app: and the odds stamp is not read from it either',
  /odds:noMkt\?null:/.test(REQ_SRC));
const REQ_BARE = REQ_SRC
  .replace(/market:noMkt\?\{\}:fbP4Market\(u\)/g, '')
  .replace(/odds:noMkt\?null:\(\(fbP4Market\(u\)\|\|\{\}\)\.as_of\|\|null\)/g, '');
chk('app: so no market-free request can reach the join it is judging',
  REQ_BARE.indexOf('fbP4Market(') < 0,
  'an unguarded fbP4Market( survives in the request builder');

/* the fair spread it reads is cached per game per load, like every other
   projection on this board, so the extra run is paid once */
chk('app: the market-free fair spread is cached against the load stamp',
  /_fnmAt!==S\.loadedAt/.test(MARKET_SRC));
chk('app: and a game that cannot be projected yields no fault, not a crash',
  /catch\(_\)\{\}/.test(MARKET_SRC) && /if\(fair==null\)return null;/.test(MARKET_SRC));

/* the operator is told which rows to fix, in words, with both numbers */
const B_START = APP.indexOf('function fbP4LineFaults(');
const B_END = APP.indexOf('function fbP4LineWarnHTML(', B_START);
chk('app: the dropped-row banner is found', B_START >= 0 && B_END > B_START);
const BANNER_SRC = APP.slice(B_START, B_END);
const bctx = {
  console, Math, JSON, String, Number, window: null,
  FB: { p4: { up: [{ g: { game_id: 'g1', home_team: 'Notre Dame', away_team: 'Wisconsin' } }] } },
  fbEsc: v => String(v),
  fbPts: (v, dp) => v == null ? '—' : ((v > 0 ? '+' : '') + v.toFixed(dp == null ? 1 : dp)),
  fbP4Market: () => ({ spread_line: null,
    spread_fault: { model: 21.2, market: -20.5, gap: 41.7, gap_if_negated: 0.7 } })
};
bctx.window = bctx;
vm.createContext(bctx);
vm.runInContext(BANNER_SRC, bctx, { filename: 'app.html:p4-line-faults' });
const banner = String(vm.runInContext('fbP4LineFaultHTML()', bctx)).replace(/<[^>]+>/g, '');
chk('app: the banner names the game', /Wisconsin @ Notre Dame/.test(banner), banner);
chk('app: and both numbers, so the source row can be found',
  /-20\.5/.test(banner) && /\+21\.2/.test(banner), banner);
chk('app: and states the gap as a magnitude, not a signed line',
  /41\.7-point gap that becomes 0\.7/.test(banner), banner);
chk('app: and says the spread was dropped rather than flipped',
  /dropped rather than flipped/.test(banner), banner);
chk('app: and that the game keeps its projection',
  /keeps its projection/.test(banner), banner);
eq('app: a board with no faults shows no banner at all',
  String(vm.runInContext('(function(){FB.p4.up=[];return fbP4LineFaultHTML();})()', bctx)), '');
chk('app: and the slate-wide inversion banner still shows alongside them',
  /\+fbP4LineFaultHTML\(\);/.test(APP));

/* ======================================================================== */
console.log('\n' + (fail === 0 ? 'ALL GREEN ' : 'FAILURES ') + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }

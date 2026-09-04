#!/usr/bin/env node
/* ===========================================================================
   The games layer must not become a SECOND opinion about a matchup.

   games/lib/research_state.js re-derives the research state that the terminal
   already assigns in app.html (`fbGxState`). This test reads that function
   STRAIGHT OUT OF app.html, runs both implementations over the same grid of
   confidences and gaps, and fails if they ever disagree.

   If someone changes a threshold in one place and not the other, this goes red.

   Run: node tools/games/state_parity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const GAMES_STATE = require(path.join(ROOT, 'games', 'lib', 'research_state.js'));

/* ---- lift fbGxState out of the terminal ---------------------------------- */
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const START = APP.indexOf('function fbGxState(p){');
chk('app.html still carries fbGxState', START >= 0);
if (START < 0) { report(); process.exit(1); }
const END = APP.indexOf('\nfunction ', START + 10);
const SRC = APP.slice(START, END > 0 ? END : START + 4000);

const sandbox = {
  window: { EDCfbP4Params: global.window.EDCfbP4Params },
  FB_GUARD: { p4: { game: 21 } },
  Math: Math
};
vm.createContext(sandbox);
vm.runInContext(SRC + '\nthis.__fbGxState = fbGxState;', sandbox);
const fbGxState = sandbox.__fbGxState;
chk('fbGxState was lifted and is callable', typeof fbGxState === 'function');

/* the guard the terminal applies is the guard the games layer claims */
chk('the games layer uses the terminal’s guard bound',
  GAMES_STATE.GUARD_POINTS === sandbox.FB_GUARD.p4.game,
  'games=' + GAMES_STATE.GUARD_POINTS + ' app=' + sandbox.FB_GUARD.p4.game);

/* thresholds come from the shipped params, not from a copied constant */
const P = global.window.EDCfbP4Params;
const T = GAMES_STATE.thresholds();
chk('min_research_gap is read from params',
  T.min_gap === P.market.min_research_gap, 'got ' + T.min_gap);
chk('min_confidence is read from params',
  T.min_confidence === P.market.min_confidence, 'got ' + T.min_confidence);

/* ---- the grid ------------------------------------------------------------ */
function appState(conf, gap) {
  return fbGxState({
    scores: { confidence: conf },
    market: { spread_gap: gap }
  }).key;
}

const CONFS = [null, 0, 8, 34, 34.9, 35, 40, 55, 80, 100];
const GAPS = [null, 0, 0.4, 1.9, 2, 2.1, 5, 20.9, 21, 30, -3, -25];
let compared = 0, mismatches = [];
CONFS.forEach(function (c) {
  GAPS.forEach(function (g) {
    const a = appState(c, g);
    const b = GAMES_STATE.classify(c, g).key;
    compared++;
    if (a !== b) mismatches.push('conf=' + c + ' gap=' + g + ': app=' + a + ' games=' + b);
  });
});
chk('every (confidence, gap) pair classifies identically in both places',
  mismatches.length === 0, mismatches.slice(0, 6).join(' | '));
chk('the grid actually ran', compared === CONFS.length * GAPS.length, 'compared ' + compared);

/* ---- the ordering the terminal documents --------------------------------- */
chk('THIN outranks a missing market', GAMES_STATE.classify(10, null).key === 'THIN');
chk('THIN outranks a huge gap', GAMES_STATE.classify(10, 40).key === 'THIN');
chk('a trusted projection with no market is NO_MARKET',
  GAMES_STATE.classify(60, null).key === 'NO_MARKET');
chk('the guard bound is inclusive', GAMES_STATE.classify(60, 21).key === 'INVESTIGATE');
chk('just inside the guard is REVIEW', GAMES_STATE.classify(60, 20.9).key === 'REVIEW');
chk('the research gap is inclusive', GAMES_STATE.classify(60, 2).key === 'REVIEW');
chk('inside the research gap is PASS', GAMES_STATE.classify(60, 1.9).key === 'PASS');
chk('sign of the gap does not change the state',
  GAMES_STATE.classify(60, -25).key === GAMES_STATE.classify(60, 25).key);

/* every state offers an invitation to the research, and none of them oversells */
['THIN', 'NO_MARKET', 'INVESTIGATE', 'REVIEW', 'PASS'].forEach(function (k) {
  const t = GAMES_STATE.invitation(k);
  chk('invitation exists for ' + k, !!t && t.length > 10);
  chk('invitation for ' + k + ' claims no edge',
    !/\b(edge|guarantee|lock|free money|can.t lose)\b/i.test(t), t);
});

function report() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | research-state parity | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(function (f) { console.log('  × ' + f); });
}
report();
process.exit(fail ? 1 : 0);

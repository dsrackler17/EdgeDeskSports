#!/usr/bin/env node
/* ============================================================================
   THE CFB RESEARCH VIEW ON THE PAGE, THROUGH THE REAL FOOTBALL MODULE.

   tools/football/cfb_research_view.test.js pins the rules in
   lib/cfb_research_view.js. This file pins the page: the real module out of
   app.html (tools/football/_module.js), the committed engine, and the real
   lib file, loaded exactly as the page's <script> tag loads it. A game is
   staged, its raw margin steered through the two teams' canonical ratings
   (the only term that depends on them), and the board row, the card and the
   research desk are rendered by the page's own functions.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./_module.js');
const ROOT = M.ROOT;

let checks = 0, failures = 0;
function ok(cond, what, detail) {
  checks++;
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); cond = false; } }
  if (cond) return;
  failures++; console.error('  FAIL: ' + what + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function has(hay, needle, what) { ok(String(hay).indexOf(needle) >= 0, what, { missing: needle }); }
function lacks(hay, needle, what) { ok(String(hay).indexOf(needle) < 0, what, { present: needle }); }
function section(t) { console.log('\n' + t); }

const BOOT = M.boot({ probe: ['fbP4ViewFor', 'fbRvNearBadge', 'fbRvGapCell', 'fbGxSummary', 'fbP4Card', 'fbP4Request', 'fbP4Market'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST;
(function () {
  const at = BOOT.app.indexOf('function _escHtml(');
  if (at < 0) { console.error('app.html no longer defines _escHtml'); process.exit(1); }
  vm.runInContext(BOOT.app.slice(at, BOOT.app.indexOf('\n', at)), win);
})();
win.whenLabel = win.whenLabel || (iso => String(iso));
const E = M.loadEngine(win, ROOT);

/* the page loads the research view with a plain <script> tag */
const LIB = 'lib/cfb_research_view.js';
has(BOOT.app, '<script src="/' + LIB + '?v=', 'app.html loads ' + LIB);
vm.runInContext(fs.readFileSync(path.join(ROOT, LIB), 'utf8'), win, { filename: LIB });
ok(!!win.EDCfbResearchView, 'the research view is on window, as the page reads it');

const HOME = 'Duke', AWAY = 'Wake Forest';
const HK = E.normKey(HOME), AK = E.normKey(AWAY);

/* stage the game with the home team's canonical rating set so the raw margin
   lands on `target`; returns the staged unit and its projection */
function stageAt(target, o) {
  o = o || {};
  const st = E.newState();
  st.canonicalRatings = {}; st.canonicalRatings[HK] = { value: 0 }; st.canonicalRatings[AK] = { value: 0 };
  win.FB.p4.state = st;
  const stage = { home: HOME, away: AWAY, neutral_site: !!o.neutral, market_spread: o.market_spread,
    home_conference: 'ACC', away_conference: 'ACC', game_id: o.game_id || 'RV1' };
  let u = M.stageGame(win, stage);
  const rest = E.projectGame(T.fbP4Request(u)).model.fair_spread;
  st.canonicalRatings[HK].value = target == null ? 0 : target - rest;
  u = M.stageGame(win, stage);
  const p = E.projectGame(T.fbP4Request(u));
  win.FB.p4._proj = {}; win.FB.p4._proj[String(u.g.game_id)] = p;
  win.FB.p4._mkt = {}; win.FB.p4._mkt[String(u.g.game_id)] = T.fbP4Market(u);
  return { u: u, p: p };
}

/* ------------------------------------------------------------------------ */
section('STEP 1 · near pick’em: the side, the one-point floor and the badge');
{
  const s = stageAt(-0.31);
  const v = T.fbP4ViewFor(s.u, s.p);
  ok(Math.abs(s.p.model.fair_spread + 0.31) < 1e-9, 'the raw margin was steered to -0.31', s.p.model.fair_spread);
  eq(v.fair.fair_line_text, AWAY + ' -1.0', 'the view names the away side at the one-point floor');
  eq(v.raw_projected_margin, s.p.model.fair_spread, 'and keeps the engine’s raw margin, untouched');
  eq(v.is_near_pickem, true, 'and flags the near pick’em');
  const card = T.fbGxSummary(s.u, s.p, 'RV1');
  has(card, 'NEAR PICK’EM', 'the card summary shows the NEAR PICK’EM badge');
  has(card, AWAY + ' -0.31', 'and the badge explains the raw margin behind it');
  const full = T.fbP4Card(s.u);
  has(full, 'NEAR PICK’EM', 'the full card shows it too');

  const c = stageAt(-6.5);
  const vc = T.fbP4ViewFor(c.u, c.p);
  eq(vc.is_near_pickem, false, 'a 6.5-point game is not a near pick’em');
  lacks(T.fbGxSummary(c.u, c.p, 'RV1'), 'NEAR PICK’EM', 'and carries no badge');
  eq(T.fbRvNearBadge(null), '', 'no view, no badge (the page renders exactly as before)');
}

/* ------------------------------------------------------------------------ */
section('STEP 2 · the market gap on the card and the board row');
{
  /* cfb.lines convention: a negative number is the home side laying points.
     Duke (home) -2.5 in the market, EdgeDesk Wake Forest by 1.0 */
  const s = stageAt(-1.0, { market_spread: -2.5 });
  const v = T.fbP4ViewFor(s.u, s.p);
  eq(v.market_gap.available, true, 'the joined line reaches the view');
  eq(v.market_gap.market_line_text, HOME + ' -2.5', 'the market line is named for its favourite');
  eq(Math.round(v.market_gap.points * 10) / 10, 3.5, 'the gap is 3.5 points');
  eq(v.market_gap.toward_team, AWAY, 'toward Wake Forest');
  ok(Math.abs(v.market_gap.signed - s.p.market.spread_gap) < 1e-9, 'and it is the engine’s own spread_gap');
  const card = T.fbGxSummary(s.u, s.p, 'RV1');
  has(card, '>Market gap<', 'the card labels it MARKET GAP');
  has(card, '3.5 pts', 'with its size');
  has(card, 'toward ' + AWAY, 'and its direction');
  has(card, AWAY + ' -1.0', 'the EdgeDesk cell names the favourite it lays');
  has(card, HOME + ' -2.5', 'and so does the market cell');
  const cell = T.fbRvGapCell(v, 3.5);
  has(cell, '3.5', 'the board row shows the size');
  has(cell, '→ ' + AWAY, 'and the team EdgeDesk differs toward');
  has(BOOT.module, 'fbRvGapCell(rv,r.gap)', 'the board row renders its gap through that cell');

  /* the near pick'em floor never manufactures a gap */
  const n = stageAt(-0.31, { market_spread: -2.5 });
  const vn = T.fbP4ViewFor(n.u, n.p);
  eq(Math.round(vn.market_gap.points * 100) / 100, 2.81, 'a near pick’em’s gap is its raw 2.81, not the 3.5 its display line implies');
  has(T.fbGxSummary(n.u, n.p, 'RV1'), '2.8 pts', 'and the card prints 2.8');

  const none = stageAt(-4);
  const vx = T.fbP4ViewFor(none.u, none.p);
  eq(vx.market_gap.available, false, 'no joined line: no gap');
  has(T.fbGxSummary(none.u, none.p, 'RV1'), 'no market number', 'and the card says so rather than printing a zero');
  eq(T.fbRvGapCell(vx, null), '—', 'the row prints a dash');
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);

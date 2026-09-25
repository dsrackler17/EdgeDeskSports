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

const BOOT = M.boot({ probe: ['fbP4ViewFor', 'fbRvNearBadge', 'fbRvGapCell', 'fbRvLabelChip', 'fbRvState', 'fbRvRowCells', 'fbRvWeak', 'fbGxSummary', 'fbGxBriefText', 'fbP4Card', 'fbP4Request', 'fbP4Market', 'fbP4ContractFor', 'fbP4StatusFor'] });
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

/* the bare harness has no rosters, so its input contract is thin (2 of 15).
   The contract is cached per unit under the stamps it reads; setting the
   cached summary is how a test puts a well-covered game on the board without
   editing the builder. */
function withCoverage(u, summary) {
  T.fbP4ContractFor(u);
  u._contract.v = { rows: [], summary: summary };
  u._rv = null;
  return u;
}
const WELL = { input_coverage: 0.82, known: 14, applicable: 17 };

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

/* ------------------------------------------------------------------------ */
section('STEP 3 · one research label on the row, the card, the brief and the share');
{
  /* Duke (home) -2.5, EdgeDesk Duke by 7.6: a 5.1-point gap toward Duke */
  const s = stageAt(7.61, { market_spread: -2.5 });
  withCoverage(s.u, WELL);
  const v = T.fbP4ViewFor(s.u, s.p);
  eq(v.research_label.key, 'WORTH_RESEARCHING', 'a 5.1-pt gap with usable confidence and 82% reliability is WORTH RESEARCHING');
  eq(v.reliability.pct, 82, 'reliability is the contract’s input coverage');
  eq(v.confidence.score, s.p.scores.confidence, 'confidence is the engine’s own score, unchanged');

  const st = T.fbRvState(s.u, s.p);
  eq(st.label, 'WORTH RESEARCHING', 'the card’s state IS the research label');
  const card = T.fbGxSummary(s.u, s.p, 'RV1');
  has(card, '>Research label<', 'the card names the cell Research label');
  has(card, 'WORTH RESEARCHING', 'and prints the label');
  has(card, v.research_label.means, 'and the "What this means" sentence is the label’s own');
  lacks(card, '>Research state<', 'the old research state is not printed beside it');
  const brief = T.fbGxBriefText(s.u, s.p);
  has(brief, 'Research label: WORTH RESEARCHING', 'the copied brief carries the same label');
  has(brief, 'Market gap: 5.1 pts toward ' + HOME, 'and the gap with its direction');

  const chip = T.fbRvLabelChip(v, T.fbP4StatusFor(s.p, T.fbP4Market(s.u)));
  has(chip, 'WORTH RESEARCHING', 'the board row prints the label');
  has(chip, 'Board status: RESEARCH', 'and keeps the operational status the filters read, in its tooltip');
  has(BOOT.module, 'fbRvLabelChip(rv,st)', 'the board row renders its label through that chip');
  eq(T.fbRvLabelChip(null, { t: 'NO MARKET', c: 'x' }), '<span style="color:x">NO MARKET</span>', 'without the view the row prints the status exactly as before');

  /* the thin harness contract, unstubbed: LOW RELIABILITY, and it says why */
  const t = stageAt(7.61, { market_spread: -2.5 });
  const vt = T.fbP4ViewFor(t.u, t.p);
  eq(vt.research_label.key, 'LOW_RELIABILITY', 'a thin input contract is LOW RELIABILITY, whatever the gap');
  has(vt.research_label.means, vt.reliability.known + ' of ' + vt.reliability.applicable, 'and the reason counts the inputs');

  const n = stageAt(0.3, { market_spread: -0.5 });
  withCoverage(n.u, WELL);
  eq(T.fbP4ViewFor(n.u, n.p).research_label.key, 'NEAR_PICKEM', 'a well-covered near pick’em is NEAR PICK’EM');
  const nm = stageAt(4);
  withCoverage(nm.u, WELL);
  eq(T.fbP4ViewFor(nm.u, nm.p).research_label.key, 'LIMITED_DATA', 'no market line is LIMITED DATA');
  const mj = stageAt(12, { market_spread: -2.5 });
  withCoverage(mj.u, WELL);
  eq(T.fbP4ViewFor(mj.u, mj.p).research_label.key, 'MAJOR_DISAGREEMENT', 'a 9.5-pt gap is MAJOR DISAGREEMENT');
  const al = stageAt(3.1, { market_spread: -2.5 });
  withCoverage(al.u, WELL);
  eq(T.fbP4ViewFor(al.u, al.p).research_label.key, 'MARKET_ALIGNED', 'a 0.6-pt gap is MARKET ALIGNED');
}

/* ------------------------------------------------------------------------ */
section('STEP 4 · the card and the row keep the gap, confidence and reliability apart');
{
  const s = stageAt(12, { market_spread: -2.5 });
  withCoverage(s.u, WELL);
  const v = T.fbP4ViewFor(s.u, s.p);
  const card = T.fbGxSummary(s.u, s.p, 'RV1');
  has(card, '>Market gap<', 'the card has a Market gap cell');
  has(card, '>Confidence<', 'a separate Confidence cell');
  has(card, '>Reliability<', 'and a separate Reliability cell');
  lacks(card, '>Data confidence<', 'instead of one number standing in for both');
  has(card, v.confidence.label, 'confidence reads as its tier');
  has(card, v.confidence.pct_text + ' information confidence', 'with the engine’s score beside it');
  has(card, '82%', 'reliability reads as the input coverage');
  has(card, '14 of 17 inputs on file', 'with the count behind it');
  const rc = T.fbRvRowCells(v);
  has(rc.conf, 'class="rv-t', 'the row prints confidence in its own cell');
  has(rc.rel, '82%', 'and reliability in another');
  has(rc.fair, HOME + ' -12.0', 'the row’s fair line is named for its favourite');
  has(rc.market, HOME + ' -2.5', 'and so is its market line');
  lacks(T.fbRvGapCell(v, v.market_gap.points), 'rv-dim', 'a gap on good data is not dimmed');

  /* the same size of gap on weak data looks different */
  const w = stageAt(12, { market_spread: -2.5 });
  const vw = T.fbP4ViewFor(w.u, w.p);
  eq(T.fbRvWeak(vw), true, 'the thin harness contract makes this gap weak');
  has(T.fbRvGapCell(vw, vw.market_gap.points), 'rv-dim', 'and the row dims it');
  has(T.fbRvGapCell(vw, vw.market_gap.points), 'read with caution', 'and says why on hover');
  const wc = T.fbGxSummary(w.u, w.p, 'RV1');
  const gapCell = wc.slice(wc.indexOf('>Market gap<'), wc.indexOf('>Market gap<') + 200);
  lacks(gapCell, 'v warn', 'the card does not colour a weak gap as a finding');
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);

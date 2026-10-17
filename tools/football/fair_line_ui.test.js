#!/usr/bin/env node
/* ============================================================================
   THE NEAR-PICK'EM DISPLAY LINE, THROUGH THE REAL FOOTBALL MODULE.

   football/cfb_p4/fair_line.test.js pins the engine: a near pick'em is shown
   at a one-point floor on the side the model measurably favours, and nothing
   that measures the game moves. This file pins the page: the card, the copy
   brief and the canonical research payload (which the published brief, the
   AI desk, articles, the newsletter and the editorial snapshot all read)
   show the model's OWN number at the canonical precision, tagged near
   pick'em, while the raw margin is still what is stored and what is graded.

   2026-10-17 (docs/system-integrity/FOOTBALL_LINES.md): the line a reader
   sees is now a football line, the raw margin at the NEAREST HALF POINT
   (lib/edgedesk_football_lines.js), PK at zero. The raw 0.1 line rides beside
   it (fair_spread_raw_text, model_raw) and is still what grading reads; the
   gap is still measured from the raw margin, with a rounding note where the
   printed lines do not reproduce it. The floor is still never printed.

   2026-10-08 (docs/system-integrity/AUDIT.md §1a): the page used to print the
   engine's one-point DISPLAY FLOOR here ("Ole Miss -1.0" on a -0.18 margin)
   beside a gap measured from the raw margin, so the printed difference could
   not be reproduced from the printed lines. The floor stays in the engine's
   output (football/cfb_p4/fair_line.test.js pins it); the page no longer
   prints it, and every printed difference is the difference of the printed
   lines (lib/edgedesk_calc.js).

   It boots the real module out of app.html (tools/football/_module.js) and
   the committed engine, stages a game, and steers its raw margin through the
   two teams' canonical ratings — the only term that depends on them.
   ========================================================================== */
'use strict';
const path = require('path');
const M = require('./_module.js');
const ROOT = M.ROOT;
const SNAP = require(path.join(ROOT, 'tools', 'editorial', 'snapshot.js'));
const G = require(path.join(ROOT, 'tools', 'editorial', 'grading.js'));

let checks = 0, failures = 0;
function ok(cond, what, detail) {
  checks++; if (cond) return;
  failures++; console.error('  FAIL: ' + what + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
}
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n' + t); }

const FLN = require(require('path').join(M.ROOT, 'lib', 'edgedesk_football_lines.js'));
const MINUS = FLN.MINUS;
const BOOT = M.boot({ probe: ['fbFairDisp', 'fbRawMarginText', 'fbGxSummary', 'fbP4Card', 'fbGxBriefText', 'fbGxCases', 'fbP4Request', 'fbBrLine'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST;
/* the page's own escaper lives in an earlier script block; load the real line */
(function () {
  const at = BOOT.app.indexOf('function _escHtml(');
  if (at < 0) { console.error('app.html no longer defines _escHtml'); process.exit(1); }
  require('vm').runInContext(BOOT.app.slice(at, BOOT.app.indexOf('\n', at)), win);
})();
/* a kickoff label from another script block; the card only prints it */
win.whenLabel = win.whenLabel || (iso => String(iso));
const E = M.loadEngine(win, ROOT);

const HOME = 'Duke', AWAY = 'Wake Forest';
const HK = E.normKey(HOME), AK = E.normKey(AWAY);
const BANNED = /(^|\s)(PK|[+-]?0\.[05]|[+-]?0\.0)$/;

/* stage the game with the home team's canonical rating set so the raw
   margin lands on `target`; returns the staged unit and the projection */
function stageAt(target, o) {
  o = o || {};
  const st = E.newState();
  if (o.noEff) { delete st.eff[HK]; delete st.eff[AK]; }
  st.canonicalRatings = {}; st.canonicalRatings[HK] = { value: 0 }; st.canonicalRatings[AK] = { value: 0 };
  win.FB.p4.state = st;
  const stage = { home: HOME, away: AWAY, neutral_site: !!o.neutral, market_spread: o.market_spread,
    home_conference: 'ACC', away_conference: 'ACC', game_id: 'NP1' };
  let u = M.stageGame(win, stage);
  const rest = E.projectGame(T.fbP4Request(u)).model.fair_spread;
  st.canonicalRatings[HK].value = target == null ? 0 : target - rest;
  u = M.stageGame(win, stage);
  const p = E.projectGame(T.fbP4Request(u));
  return { u: u, p: p };
}
function brief() { return win.fbBriefGame({ home: HOME, away: AWAY, t: Date.parse('2026-09-19T23:30:00.000Z') }); }

/* ------------------------------------------------------------------------ */
section('1. a near pick’em favouring the home side by 0.37');
{
  const s = stageAt(0.37, { market_spread: 2.5 });
  const m = s.p.model, raw = m.fair_spread;
  ok(Math.abs(raw - 0.37) < 1e-9, 'the raw margin was steered to 0.37', raw);
  const b = brief(), pr = b.projection;
  eq(pr.fair_spread, raw, 'the payload stores the RAW margin, full precision');
  eq(pr.fair_spread_text, HOME + ' ' + MINUS + '0.5', 'the published fair spread is the model’s own number at the half point, not the one-point floor');
  eq(pr.fair_spread_raw_text, HOME + ' -0.4', 'and the raw 0.1 line rides beside it, for grading');
  eq(pr.near_pickem, true, 'the payload flags the near pick’em');
  eq(pr.raw_margin_text, HOME + ' +0.37', 'the raw margin is stated for the displayed favourite');
  eq(pr.favourite, HOME, 'the favourite is the raw favourite');
  eq(pr.margin + ' | ' + pr.margin_raw, '0.5 | 0.4', 'the stated margin is the display, with the raw margin beside it');
  eq(pr.display_policy, 'football_half_point_v1', 'and the payload names its display policy');
  ok(pr.win_prob && pr.win_prob.home_pct === Math.round(m.home_win_prob * 100) && pr.win_prob.home_pct <= 51,
    'the win probability is the raw 0.37 margin’s, still a coin flip', pr.win_prob);
  eq(b.market.model, HOME + ' ' + MINUS + '0.5', 'the market block shows the model’s own number at the half point');
  eq(b.market.market, HOME + ' +2.5', 'beside the market line');
  eq(b.market.model_raw, HOME + ' -0.4', 'and carries the raw line for grading');
  eq(b.market.difference_n, 2.9, 'the printed difference is the difference of the printed lines: Duke -0.4 vs Duke +2.5 is 2.9 (not the floor’s 3.5)');
  eq(b.market.difference, '2.9 points', 'and is printed as such');
  ok(Math.abs(b.market.difference_exact - Math.abs(s.p.market.spread_gap)) < 1e-9 && Math.abs(b.market.difference_exact - 2.87) < 1e-9, 'the engine’s raw 2.87 is kept beside it for grading', b.market.difference_exact);
  eq(b.market.rounding_note, FLN.ROUNDING_NOTE, 'the printed −0.5 and +2.5 say 3.0, so the 2.9 carries the rounding note');
  ok(b.notes.some(n => /near pick’em/.test(n) && n.indexOf(HOME + ' +0.37') >= 0), 'the brief says it is a near pick’em', b.notes);

  const html = T.fbGxSummary(s.u, s.p, 'NP1');
  ok(html.indexOf(HOME + ' ' + MINUS + '0.5') >= 0, 'the card’s EdgeDesk cell shows ' + HOME + ' −0.5');
  ok(/near pick’em/.test(html), 'and labels it near pick’em');
  ok(html.indexOf(HOME + ' -1.0') < 0 && html.indexOf('PK') < 0, 'and never the -1.0 floor or PK as the line');
  const card = T.fbP4Card(s.u);
  ok(card.indexOf('Model spread</span><span class="v mdl">' + HOME + ' ' + MINUS + '0.5') >= 0, 'the detail section’s model spread is the model’s own number at the half point');
  ok(card.indexOf('Raw margin</span><span class="v mut">' + HOME + ' +0.37') >= 0, 'and the raw margin is in the detail section');
  const txt = T.fbGxBriefText(s.u, s.p);
  ok(txt.indexOf('Model spread: ' + HOME + ' ' + MINUS + '0.5 (near pick’em · raw margin ' + HOME + ' +0.37)') >= 0, 'the copied brief says both', txt.split('\n').filter(l => /Model spread/.test(l)));

  /* the editorial snapshot stores both, and grades the raw one */
  const snap = SNAP.capture(b, { sport: 'CFB', game_id: 'NP1', home: HOME, away: AWAY, kickoff: '2026-09-19T23:30:00.000Z' },
    { now: '2026-09-18T12:00:00.000Z' });
  if (snap && snap.model) {
    eq(snap.model.fair_spread, raw, 'the snapshot stores the raw margin');
    eq(snap.model.fair_spread_text, HOME + ' ' + MINUS + '0.5', 'and the model’s line as shown');
    eq(snap.model.fair_spread_raw_text, HOME + ' -0.4', 'and the raw line');
    ok(snap.model.total_n != null && snap.model.total_n === +pr.total_raw, 'the snapshot grades the RAW total, not the half-point display', [snap.model.total, snap.model.total_n, pr.total_raw]);
    eq(snap.model.near_pickem, true, 'and the near pick’em flag');
    const acc = G.modelAccuracy(snap, { home_score: 20, away_score: 17 });
    eq(acc.projected_home_margin, 0.4, 'grading reads the raw 0.4, never the one-point floor');
    const lean = G.impliedSide(snap);
    eq(lean.model_home_margin, -0.4, 'the implied side is measured from the raw line');
  } else ok(false, 'the editorial snapshot could not be built from the payload', snap);
}

/* ------------------------------------------------------------------------ */
section('2. a near pick’em favouring the away side by 0.49');
{
  const s = stageAt(-0.49);
  const b = brief(), pr = b.projection;
  ok(Math.abs(pr.fair_spread + 0.49) < 1e-9, 'raw -0.49 is stored as -0.49', pr.fair_spread);
  eq(pr.fair_spread_text, HOME + ' +0.5', 'the home-stated line is +0.5 — the away side is favoured by its own 0.49, rounded');
  eq(pr.favourite, AWAY, 'the favourite never flips to the home side');
  eq(pr.raw_margin_text, AWAY + ' +0.49', 'the raw margin is stated for the away favourite');
  const cases = T.fbGxCases(s.u, s.p);
  ok(cases.indexOf(AWAY) >= 0, 'the case section names the away side', cases.slice(0, 120));
}

/* ------------------------------------------------------------------------ */
section('3. an exact tie is shown as a pick’em, and the engine’s tiebreak still names the side');
{
  const s = stageAt(0, { neutral: true, noEff: true });
  eq(s.p.model.fair_spread, 0, 'the raw margin is exactly zero');
  const b = brief(), pr = b.projection;
  eq(pr.fair_spread_text, 'PK', 'an exact tie is printed as PK, never as a manufactured one-point line');
  eq(pr.favourite, s.p.model.display_side === 'home' ? HOME : AWAY, 'the favourite is the engine’s tiebreak side');
  eq(pr.fair_spread, 0, 'and the stored margin is still zero');
  eq(pr.near_pickem, true, 'flagged near pick’em');
}

/* ------------------------------------------------------------------------ */
section('4. one point and beyond: the half-point line, with the raw 0.1 line beside it');
/* neutral site, no matchup term: the raw margin IS the rating gap, so ±1.00
   is hit exactly rather than a floating-point hair either side of it */
[[-3.24, '+3.0'], [7.61, MINUS + '7.5'], [1, MINUS + '1.0'], [-1, '+1.0'], [12.49, MINUS + '12.5'], [-6.75, '+7.0'], [6.6, MINUS + '6.5']].forEach(([target, line]) => {
  const s = stageAt(target, { neutral: true, noEff: true });
  eq(s.p.model.fair_spread, target, 'raw ' + target + ': steered exactly');
  const b = brief(), pr = b.projection;
  eq(pr.fair_spread_text, HOME + ' ' + line, 'raw ' + target + ': the published line is ' + HOME + ' ' + line + ' (never pulled to a key number)');
  eq(pr.fair_spread_raw_text, T.fbBrLine(HOME, s.p.model.fair_spread), 'raw ' + target + ': the raw line grading reads is the 0.1 line, exactly as before');
  eq(pr.near_pickem, false, 'raw ' + target + ': not a near pick’em');
  ok(T.fbGxSummary(s.u, s.p, 'NP1').indexOf(HOME + ' ' + line) >= 0, 'raw ' + target + ': the card cell shows the same line');
});

/* ------------------------------------------------------------------------ */
section('5. every near-pick’em margin prints at its own half point, on its own side');
{
  const bad = [];
  for (let i = -99; i <= 99; i += 7) {
    stageAt(i / 100);
    const pr = brief().projection, t = pr.fair_spread_text, raw = i / 100;
    const want = Math.floor(Math.abs(raw) * 2 + 0.5 + 1e-9) / 2;
    const exp = want === 0 ? 'PK' : HOME + ' ' + (raw > 0 ? MINUS : '+') + want.toFixed(1);
    if (t !== exp || pr.fair_spread_raw_text !== T.fbBrLine(HOME, pr.fair_spread)) bad.push([raw, t, exp]);
  }
  ok(!bad.length, 'every margin from -0.99 to +0.99 prints at the half point, halves away from zero, home-stated, PK at zero', bad);
}

/* ------------------------------------------------------------------------ */
section('6. a model with no display line (the NFL engine) prints its raw number');
eq(T.fbFairDisp({ fair_spread: -0.4 }), -0.5, 'no display field: the raw number at the half point');
eq(T.fbFairDisp({ fair_spread: 0.3, display_fair_spread: 1 }), 0.5, 'the engine’s display floor is never what the page prints: 0.3 shows 0.5, not 1');
eq(T.fbFairDisp({ fair_spread: 0.2 }), 0, 'a margin under a quarter point shows PK');
eq(T.fbFairDisp({ fair_spread: 9.45 }), 9.5, '9.45 prints 9.5');
eq(T.fbFairDisp({ fair_spread: 20.25 }) + ' ' + T.fbFairDisp({ fair_spread: -20.25 }), '20.5 -20.5', 'quarter-point ties go away from zero in both signs');
eq(T.fbFairDisp(null), null, 'nothing in, nothing out');

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks : 'PASS — ' + checks + ' checks'));
process.exit(failures ? 1 : 0);

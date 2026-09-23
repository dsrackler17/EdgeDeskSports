#!/usr/bin/env node
/* THE RESEARCH CORE is the one place the terminal's arithmetic lives: line
   conventions, CLV, odds math, buckets, intervals, walk-forward error scales,
   model agreement and key numbers. These tests pin every convention with a
   mirror case, prove missing inputs stay null, and prove the walk-forward
   scale cannot see a residual from a game that was not final yet.
   Run: node tools/research/research_core.test.js */
'use strict';
const path = require('path');
const R = require(path.join(__dirname, '..', '..', 'lib', 'research_core.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String(e && e.message) }; } }
  if (ok) { pass++; return; } fail++; failures.push({ name, detail });
}
const near = (a, b, e) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (e == null ? 1e-9 : e);
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- 1. sign convention and home/away mirrors ------------------------- */
chk('home line -3 is away +3, and back', R.sideLine(-3, 'away') === 3 && R.sideLine(-3, 'home') === -3 && R.homeLineFromSide(3, 'away') === -3);
chk('a pick-em stays 0 for both sides (no -0)', Object.is(R.sideLine(0, 'away'), 0));
chk('spread HOME -9.4 is projected home margin +9.4, and back', near(R.marginFromSpread(-9.4), 9.4) && near(R.spreadFromMargin(9.4), -9.4));
chk('engine fair_spread (+ = home margin) converts to a home betting line with the sign turned', near(R.homeLineFromEngineFairSpread(7.2), -7.2) && near(R.homeLineFromEngineFairSpread(-3), 3));
chk('a lower home number is further onto home', R.sideVsLine(-9.4, -5.5) === 'home' && R.sideVsLine(-2, -5.5) === 'away');
chk('a model exactly on the line leans neither way', R.sideVsLine(-5.5, -5.5) === null);
chk('the sign of a spread alone never names a side', R.sideVsLine(-7, null) === null && R.sideVsLine(null, -7) === null);
chk('spread gap: fair -9.4 vs market -5.5 is 3.9 toward home', (() => { const g = R.spreadGap(-9.4, -5.5); return near(g.points, 3.9) && near(g.toward_home, 3.9) && g.side === 'home'; })());
chk('spread gap mirrors: fair +2 vs market -1.5 is 3.5 toward away', (() => { const g = R.spreadGap(2, -1.5); return near(g.points, 3.5) && g.side === 'away'; })());
chk('bad side strings are refused', R.sideLine(-3, 'HOME ') === null && R.normSide('Home') === 'home');

/* ---- 2. CLV ------------------------------------------------------------ */
chk('HOME pick posted -3, close -5: CLV +2', R.clvPoints('home', -3, -5) === 2);
chk('AWAY pick home posted -3, home close -1: away +3 -> +1 is CLV +2', R.clvPoints('away', -3, -1) === 2);
chk('mirror: HOME pick posted -5 close -3 is -2; AWAY pick posted -1 close -3 is -2', R.clvPoints('home', -5, -3) === -2 && R.clvPoints('away', -1, -3) === -2);
chk('home and away CLV on the same move are exact negatives', (() => {
  for (const [p, c] of [[-3, -5], [2.5, -1], [-7, -7], [10, 13.5]]) {
    const h = R.clvPoints('home', p, c), a = R.clvPoints('away', p, c);
    if (!near(h, -a)) return false;
  }
  return true;
})());
chk('CLV through a pick-em: HOME posted +1.5, close -1.5 is +3', R.clvPoints('home', 1.5, -1.5) === 3);
chk('CLV with a missing side, line or close is null, never 0', R.clvPoints(null, -3, -5) === null && R.clvPoints('home', null, -5) === null && R.clvPoints('home', -3, undefined) === null);
chk('CLV no-move is exactly 0 (not -0)', Object.is(R.clvPoints('away', -3, -3), 0));
chk('price CLV is only defined at the same line', R.clvPrice(-105, -120, 100, false) === null && R.clvPrice(-105, -120, 100, true) > 0);

/* ---- 3. market movement relative to a model --------------------------- */
chk('market -3.5 -> -5.5 moved 2 toward a model at -9.4', (() => {
  const m = R.movementVsModel(-9.4, -3.5, -5.5);
  return m.side_at_submission === 'home' && m.toward_model_points === 2 && m.status === 'toward_model' && near(m.gap_now, 3.9) && m.passed_model === false;
})());
chk('movement mirror: away model at +1, posted -3.5, now -2 moved 1.5 toward', (() => {
  const m = R.movementVsModel(1, -3.5, -2);
  return m.side_at_submission === 'away' && m.toward_model_points === 1.5 && m.status === 'toward_model';
})());
chk('movement away from the model is negative', R.movementVsModel(-9.4, -5.5, -4.5).status === 'away_from_model');
chk('a market that moved past the model is flagged', R.movementVsModel(-6, -3, -7.5).passed_model === true);
chk('no movement is flat', R.movementVsModel(-6, -3, -3).status === 'flat');
chk('movement side is fixed at submission, not by the later line', R.movementVsModel(-4, -3, -6).side_at_submission === 'home');

/* ---- 4. key numbers ---------------------------------------------------- */
chk('NFL -2.5 -> -3.5 crosses 3 (primary)', (() => { const k = R.keyNumberCrossings(-2.5, -3.5, 'NFL'); return k.length === 1 && k[0].key === 3 && k[0].kind === 'crossed' && k[0].tier === 'primary'; })());
chk('NFL -2.5 -> -3 lands onto 3; -3 -> -3.5 comes off it', R.keyNumberCrossings(-2.5, -3, 'NFL')[0].kind === 'onto' && R.keyNumberCrossings(-3, -3.5, 'NFL')[0].kind === 'off');
chk('NFL -5.5 -> -4.5 crosses nothing but 6? no: 4.5-5.5 touches no key', R.keyNumberCrossings(-5.5, -4.5, 'NFL').length === 0);
chk('NFL +2.5 -> -3.5 crosses 3 on the home side only', (() => { const k = R.keyNumberCrossings(2.5, -3.5, 'NFL'); return k.length === 1 && k[0].at === -3; })());
chk('a 6.5 -> 7.5 move crosses 7 in both sports', R.keyNumberCrossings(6.5, 7.5, 'NFL')[0].key === 7 && R.keyNumberCrossings(6.5, 7.5, 'NCAAF')[0].key === 7);
chk('an unknown sport has no key-number list (null, not empty)', R.keyNumberCrossings(-2.5, -3.5, 'MLB') === null);

/* ---- 5. odds math ------------------------------------------------------ */
chk('-110 break-even is 52.38%', near(R.breakEven(-110), 110 / 210, 1e-12));
chk('-105 break-even is 51.22%', near(R.breakEven(-105), 105 / 205, 1e-12) && near(R.breakEven(-105), 0.5122, 1e-4));
chk('+150 break-even is 40%', near(R.breakEven(150), 0.4));
chk('+100 and -100 are both 50%', near(R.breakEven(100), 0.5) && near(R.breakEven(-100), 0.5));
chk('a price inside (-100, 100) is not a real American price', R.breakEven(50) === null && R.breakEven(-99) === null && R.breakEven(null) === null);
chk('no-vig -110/-110 is 50/50 with 4.76% overround', (() => { const n = R.noVigTwoWay(-110, -110); return near(n.a, 0.5) && near(n.overround, 220 / 210 - 1, 1e-12); })());
chk('no-vig -200/+170 sums to 1 and favours the favourite', (() => { const n = R.noVigTwoWay(-200, 170); return near(n.a + n.b, 1) && n.a > 0.64 && n.a < 0.66; })());
chk('no-vig needs both prices', R.noVigTwoWay(-110, null) === null);
chk('probToAmerican round-trips', near(R.probToAmerican(R.breakEven(-150)), -150, 1e-9) && near(R.probToAmerican(R.breakEven(135)), 135, 1e-9));

/* ---- 6. EV ------------------------------------------------------------- */
chk('EV at 56.8% on -105: ROI = .568*(100/105) - .432', near(R.expectedRoi(0.568, -105), 0.568 * (100 / 105) - 0.432, 1e-12));
chk('EV at break-even is zero', near(R.expectedRoi(R.breakEven(-110), -110), 0, 1e-12));
chk('EV with a push probability does not count the push as a loss', near(R.expectedRoi(0.5, -110, 0.05), 0.5 * (100 / 110) - 0.45, 1e-12));
chk('EV refuses impossible probabilities', R.expectedRoi(1.2, -110) === null && R.expectedRoi(0.6, -110, 0.5) === null);
chk('price assessment with no model probability says N/A and computes nothing model-dependent', (() => {
  const a = R.priceAssessment(-105, null);
  return near(a.break_even, 105 / 205) && a.model_prob === null && a.prob_edge === null && a.expected_roi === null && /no explicit model probability/.test(a.reason);
})());
chk('price assessment with a probability: +5.58 pp at -105', (() => {
  const a = R.priceAssessment(-105, 0.568);
  return near(a.prob_edge, 0.568 - 105 / 205, 1e-12) && a.expected_roi > 0.1;
})());

/* ---- 7. buckets -------------------------------------------------------- */
chk('edge bucket boundaries: lower inclusive, upper exclusive', R.edgeBucketKey(0) === '0-2' && R.edgeBucketKey(1.99) === '0-2' && R.edgeBucketKey(2) === '2-4' && R.edgeBucketKey(3.999) === '2-4' && R.edgeBucketKey(4) === '4-6' && R.edgeBucketKey(6) === '6+' && R.edgeBucketKey(40) === '6+');
chk('edge bucket refuses negative or missing', R.edgeBucketKey(-1) === null && R.edgeBucketKey(null) === null && R.edgeBucketKey('x') === null);
chk('normalized bucket boundaries', R.normalizedBucketKey(0.2499) === '<0.25' && R.normalizedBucketKey(0.25) === '0.25-0.5' && R.normalizedBucketKey(0.75) === '0.75+');
chk('lead buckets: 72h+, 24-72h, 6-24h, 1-6h, <1h and after kickoff', (() => {
  const k = '2026-09-26T20:00:00Z', at = (h) => new Date(Date.parse(k) - h * 3600000).toISOString();
  return R.leadBucketKey(at(80), k) === '72h+' && R.leadBucketKey(at(72), k) === '72h+' && R.leadBucketKey(at(30), k) === '24-72h'
    && R.leadBucketKey(at(24), k) === '24-72h' && R.leadBucketKey(at(10), k) === '6-24h' && R.leadBucketKey(at(2), k) === '1-6h'
    && R.leadBucketKey(at(0.5), k) === '<1h' && R.leadBucketKey(at(0), k) === 'after_kickoff' && R.leadBucketKey(at(-1), k) === 'after_kickoff';
})());
chk('lead bucket with no timestamps is null', R.leadBucketKey(null, '2026-09-26T20:00:00Z') === null);

/* ---- 8. intervals ------------------------------------------------------ */
chk('10-8 is 55.6% with a wide Wilson interval (~33.7%-75.4%)', (() => { const w = R.wilson(10, 18); return near(w.p, 10 / 18) && near(w.lo, 0.337, 0.005) && near(w.hi, 0.754, 0.005); })());
chk('Wilson narrows with sample', R.wilson(100, 180).hi - R.wilson(100, 180).lo < R.wilson(10, 18).hi - R.wilson(10, 18).lo);
chk('Wilson with n=0 is null, not 0%', R.wilson(0, 0) === null);
chk('Wilson at 0/5 has lo 0 and a real hi', (() => { const w = R.wilson(0, 5); return w.lo === 0 && w.hi > 0.4; })());
chk('mean interval needs two values', R.meanInterval([1]) === null && R.meanInterval([1, 3]).n === 2);
chk('mean interval uses t: [1,2,3] is 2 +/- 4.303*1/sqrt3', (() => { const m = R.meanInterval([1, 2, 3]); return near(m.hi - m.mean, 4.303 / Math.sqrt(3), 1e-9); })());
chk('median, sd, rmse, mad', near(R.median([3, 1, 2]), 2) && near(R.sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.001) && near(R.rmse([3, 4]), Math.sqrt(12.5)) && near(R.madScale([1, 2, 3, 4, 100]), 1.4826));
chk('stats ignore non-finite values rather than treating them as zero', near(R.mean([1, null, 'x', 3]), 2));

/* ---- 9. scoring -------------------------------------------------------- */
chk('brier', near(R.brier(0.7, 1), 0.09) && near(R.brier(0.7, 0), 0.49) && R.brier(0.7, null) === null);
chk('log loss clips so a 0/1 forecast is finite', isFinite(R.logLoss(1, 0)) && near(R.logLoss(0.5, 1), Math.log(2)));
chk('brier skill uses only games where both have a probability', (() => {
  const s = R.brierSkill([{ model: 0.7, market: 0.6, outcome: 1 }, { model: 0.4, market: null, outcome: 0 }, { model: 0.3, market: 0.4, outcome: 0 }]);
  return s.n === 2 && near(s.model_brier, (0.09 + 0.09) / 2) && near(s.market_brier, (0.16 + 0.16) / 2) && near(s.skill, 1 - 0.09 / 0.16);
})());
chk('brier skill with no paired games is null, not 0', R.brierSkill([{ model: 0.7, market: null, outcome: 1 }]).skill === null);

/* ---- 10. walk-forward error scale ------------------------------------- */
(function () {
  const hist = [];
  for (let i = 0; i < 20; i++) hist.push({ residual: (i % 2 ? 1 : -1) * 10, final_at: '2026-09-' + String(1 + i).padStart(2, '0') + 'T04:00:00Z' });
  const s = R.errorScale(hist, '2026-09-30T00:00:00Z');
  chk('rmse of +/-10 residuals is 10', s.scale === 10 && s.n === 20);
  const early = R.errorScale(hist, '2026-09-10T00:00:00Z');
  chk('only games final BEFORE the prediction count (9 by Sep 10) and below the minimum the scale is null', early.n === 9 && early.scale === null && /fewer than 12/.test(early.reason));
  const leak = hist.concat([{ residual: 500, final_at: '2026-10-05T00:00:00Z' }]);
  chk('a residual from a game finished after the prediction cannot move the scale', R.errorScale(leak, '2026-09-30T00:00:00Z').scale === 10);
  chk('a residual with no finish time is excluded, not assumed known', R.errorScale(hist.concat([{ residual: 500 }]), '2026-09-30T00:00:00Z').scale === 10);
  chk('same-instant finish is not before the prediction', R.errorScale(hist, '2026-09-13T04:00:00Z').n === 12);
  chk('mad scale is robust to one blowout', (() => {
    const h = [];
    for (let i = 0; i < 20; i++) h.push({ residual: i - 10, final_at: '2026-09-01T00:00:00Z' });
    h.push({ residual: 60, final_at: '2026-09-25T00:00:00Z' });
    return R.errorScale(h, '2026-09-30T00:00:00Z', { method: 'mad' }).scale < R.errorScale(h, '2026-09-30T00:00:00Z').scale;
  })());
  chk('normalized edge = gap / scale: 4.2 / 6.1 = 0.69', near(R.normalizedEdge(-9.7, -5.5, 6.1), 4.2 / 6.1, 1e-9) && R.normalizedEdge(-9.7, -5.5, null) === null);
})();

/* ---- 11. agreement, independence, outliers ---------------------------- */
(function () {
  const a = R.agreement([{ id: 'a', spread: -9.4 }, { id: 'b', spread: -8.1 }, { id: 'c', spread: -6.4 }, { id: 'd', spread: -3 }], -5.5);
  chk('agreement: 4 models, 3 lean home, 1 away, median -7.25', a.n === 4 && a.lean.home === 3 && a.lean.away === 1 && near(a.median, -7.25) && near(a.range, 6.4) && near(a.median_gap.points, 1.75));
  chk('agreement ignores models with no spread', R.agreement([{ spread: null }, { spread: -3 }], -2).n === 1);
  chk('agreement with no market line leaves lean empty and gap null', R.agreement([{ spread: -3 }], null).median_gap === null);
  chk('n_eff: identical models count as one', near(R.effectiveIndependentCount([[1, 1, 1], [1, 1, 1], [1, 1, 1]]), 1));
  chk('n_eff: uncorrelated models count fully', near(R.effectiveIndependentCount([[1, 0, 0], [0, 1, 0], [0, 0, 1]]), 3));
  chk('n_eff: rho .5 among 3 is 9/6 = 1.5', near(R.effectiveIndependentCount([[1, 0.5, 0.5], [0.5, 1, 0.5], [0.5, 0.5, 1]]), 1.5));
  chk('n_eff: a missing pair makes the count unknown', R.effectiveIndependentCount([[1, null], [null, 1]]) === null);
  chk('n_eff: negative correlation cannot push the count above n', R.effectiveIndependentCount([[1, -0.9], [-0.9, 1]]) <= 2);
  chk('correlation of a perfect line is 1 and needs 3 points', near(R.correlation([1, 2, 3], [2, 4, 6]), 1) && R.correlation([1, 2], [1, 2]) === null);
  const o = R.outlierStatus(-12.6, [-6.2, -5.9, -6.5], -5.5);
  chk('EdgeDesk 7.1 off the market and 6.4 off the room median is a strong outlier', o.status === 'strong' && near(o.deviation, -6.4));
  chk('it is not LONE while the others also lean home of -5.5', o.lone === false);
  const lone = R.outlierStatus(-9, [-4, -4.5, -3], -5.5);
  chk('the only model on its side of the market is LONE OUTLIER', lone.lone === true && lone.label === 'LONE OUTLIER');
  chk('outlier needs at least two other models', R.outlierStatus(-9, [-4], -5.5) === null);
  chk('aligned and mild thresholds', R.outlierStatus(-5, [-4, -4.5, -6], -5.5).status === 'aligned' && R.outlierStatus(-7, [-4.5, -5, -5.5], -5.5).status === 'mild');
})();

done();

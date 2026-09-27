/* Audit items 28-29 — odds conversion, break-even, vig removal, EV and push handling, checked against
   known textbook values in every production module that implements them:
     football/cfb_v2/engine.js (V2 market layer), football/cfb_decision/decision.js (decision engine),
     football/cfb_lab/lab_core.js (Model Lab grading).
   node football/cfb_v2/research/v2/audit/oddsmath.js <out.json> */
'use strict';
var fs = require('fs'), path = require('path');
var REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
require(path.join(REPO, 'football', 'cfb_v2', 'params.js'));
var E = require(path.join(REPO, 'football', 'cfb_v2', 'engine.js'));
var D = null, LC = null;
try { D = require(path.join(REPO, 'football', 'cfb_decision', 'decision.js')); } catch (e) { D = null; }
try { LC = require(path.join(REPO, 'football', 'cfb_lab', 'lab_core.js')); } catch (e) { LC = null; }
var res = [], fail = 0;
function eq(name, got, want, tol) {
  tol = tol == null ? 1e-4 : tol;
  var ok = (got === want) || (typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= tol);
  if (!ok) fail++;
  res.push({ check: name, got: got, want: want, ok: ok });
}
/* textbook values */
eq('engine breakEven(-110)', E.breakEven(-110), 110 / 210);
eq('engine breakEven(+150)', E.breakEven(150), 0.4);
eq('engine breakEven(-200)', E.breakEven(-200), 2 / 3);
eq('engine breakEven(+100)', E.breakEven(100), 0.5);
if (D) {
  var X = D._internal || D;
  var a2p = X.americanToPayout || (D.prices && D.prices.americanToPayout);
  if (a2p) {
    eq('decision payout(-110)', a2p(-110), 100 / 110);
    eq('decision payout(+250)', a2p(250), 2.5);
    eq('decision payout(-99) rejected', a2p(-99), null);
  }
  if (X.devig) {
    var dv = X.devig(-110, -110);
    eq('devig -110/-110 p', dv.p_a, 0.5); eq('devig -110/-110 hold', dv.hold, 1 - 1 / (2 * 110 / 210));
    var d2 = X.devig(-150, 130);
    eq('devig -150/+130 p_fav', d2.p_a, 0.6 / (0.6 + 100 / 230));
  }
  if (X.expectedValue) {
    eq('EV p=.5 at -110', X.expectedValue(0.5, 0, -110), 0.5 * 100 / 110 - 0.5);
    eq('EV p=.55 push .05 at -110', X.expectedValue(0.55, 0.05, -110), 0.95 * (0.55 * 100 / 110 - 0.45));
    eq('EV p=.524 at -110 ~ 0', X.expectedValue(110 / 210, 0, -110), 0, 1e-9);
  }
  if (X.minimumPrice) {
    var mp = X.minimumPrice(0.55, 0, 0.0);
    var b = mp > 0 ? mp / 100 : 100 / -mp;
    res.push({ check: 'decision minimumPrice(.55, 0, 0) rounding', got: mp, ev_at_that_price: 0.55 * b - 0.45,
               note: 'the exact break-even price is -122.2; a rounded price must not make EV negative',
               ok: 0.55 * b - 0.45 >= -1e-9 });
    if (!(0.55 * b - 0.45 >= -1e-9)) fail++;
  }
}
if (LC) {
  var L = LC._internal || LC;
  var ats = L.atsResult, units = L.unitsFor, clv = L.clvPoints;
  if (ats) {
    eq('lab ATS home -3, margin +3 = PUSH', ats('HOME', -3, 3), 'PUSH');
    eq('lab ATS away +7, margin +7 (home by 7) = PUSH', ats('AWAY', -7, 7), 'PUSH');
    eq('lab ATS home -14, margin 14 = PUSH', ats('HOME', -14, 14), 'PUSH');
    eq('lab ATS home -3.5, margin 3 = LOSS', ats('HOME', -3.5, 3), 'LOSS');
    eq('lab ATS away +3.5 (home -3.5), margin 3 = WIN', ats('AWAY', -3.5, 3), 'WIN');
  }
  if (units) {
    eq('lab units PUSH = 0 (stake returned, not a win or loss)', units('PUSH', 1, -110), 0);
    eq('lab units WIN at -110', units('WIN', 1, -110), 100 / 110);
    eq('lab units LOSS', units('LOSS', 1, -110), -1);
  }
  if (clv) {
    eq('lab CLV bet home +4 (home line +4), close +2 => +2', clv('HOME', 4, 2), 2);
    eq('lab CLV bet away +4 (home line -4), close home -2 (away +2) => +2 (got the better number)', clv('AWAY', -4, -2), 2);
    eq('lab CLV bet away +2 (home line -2), close home -4 (away +4) => -2', clv('AWAY', -2, -4), -2);
    eq('lab CLV bet home -3, close -5 => +2', clv('HOME', -3, -5), 2);
  }
}
/* V2 engine decide(): EV with a push probability at an integer line, price-null path */
var row = { game_id: 1, ens_pred: 3.0, sigma: 16, home: 'H', away: 'A', kickoff: '2030-01-01T00:00:00Z' };
var p = E.pure(row);
var d = E.decide(p, { current: { home_line: -3, ts: '2029-12-31T23:00:00Z' }, price_home: -110, price_away: -110 },
  { row: row, now: '2029-12-31T23:30:00Z' });
var P = global.EDCfbV2Params || (typeof window !== 'undefined' && window.EDCfbV2Params);
var pp = P.cover.push_table['2.5-3.5'];
var ps = d.cover_probability;
eq('engine EV at -3 with push mass', d.expected_value_per_unit, Math.round(1e4 * (ps * (1 - pp) * 100 / 110 - (1 - ps) * (1 - pp))) / 1e4, 1e-4);
var d2 = E.decide(p, { current: { home_line: -3, ts: '2029-12-31T23:00:00Z' } }, { row: row, now: '2029-12-31T23:30:00Z' });
eq('engine: no price => EV null (never assumes -110)', d2.expected_value_per_unit, null);
var out = { checks: res.length, failures: fail, results: res,
  modules: { engine: true, decision: !!D, lab_core: !!LC } };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ checks: out.checks, failures: fail, modules: out.modules }));
res.filter(function (r) { return !r.ok; }).forEach(function (r) { console.log('FAIL', JSON.stringify(r)); });

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const V = require('./validate_coaching_program.js');

assert.deepStrictEqual(V.CAPS, [0, 0.5, 1, 1.5, 2]);

/* Exact point translation. */
assert.strictEqual(V.candidatePoints({
  coaching_program_rating: 75,
  coaching_program_reliability: 0.5
}, 1.5), 0.375);
assert.strictEqual(V.candidatePoints({
  coaching_program_rating: 0,
  coaching_program_reliability: 1
}, 2), -2);
assert.strictEqual(V.candidatePoints(null, 2), 0);

/* Tune chooses by predeclared MAE/guard logic, not the holdout. */
const tuneBaseline = { spread_mae: 10, rmse: 14 };
const tuneArms = [
  { cap: 0.5, metrics: { spread_mae: 9.95, rmse: 13.99 }, predictive_residual: { slope: 0.3 } },
  { cap: 1.0, metrics: { spread_mae: 9.80, rmse: 13.95 }, predictive_residual: { slope: 0.4 } },
  { cap: 1.5, metrics: { spread_mae: 9.80, rmse: 13.95 }, predictive_residual: { slope: 0.5 } },
  { cap: 2.0, metrics: { spread_mae: 9.70, rmse: 14.20 }, predictive_residual: { slope: 0.6 } }
];
const tuned = V.selectTuneCap(tuneArms, tuneBaseline);
assert.strictEqual(tuned.selected_cap, 1,
  'caps within 0.01 MAE must prefer the smaller cap; the lower-MAE 2.0 arm fails RMSE guard');

/* The holdout cannot replace the frozen tune choice with a shinier hindsight cap. */
const holdBaseline = { spread_mae: 10, rmse: 14 };
const holdArms = [
  {
    cap: 0.5,
    metrics: { spread_mae: 9.60, rmse: 13.7 },
    predictive_residual: { slope: 0.8 },
    verdict: { status: 'VALIDATED', effect_size: 0.4 }
  },
  {
    cap: 1.0,
    metrics: { spread_mae: 9.85, rmse: 13.9 },
    predictive_residual: { slope: 0.3 },
    verdict: { status: 'VALIDATED', effect_size: 0.15 }
  }
];
const promoted = V.promotionDecision(tuned, holdArms, holdBaseline);
assert.strictEqual(promoted.tuned_cap, 1);
assert.strictEqual(promoted.selected_cap, 1,
  'holdout must certify the tune-selected cap, not substitute the holdout winner');
assert.strictEqual(promoted.affects_etsr, true);

/* If the frozen cap fails any holdout guard, production stays at zero. */
const rejected = V.promotionDecision(tuned, [{
  cap: 1,
  metrics: { spread_mae: 9.7, rmse: 14.2 },
  predictive_residual: { slope: 0.5 },
  verdict: { status: 'VALIDATED', effect_size: 0.3 }
}], holdBaseline);
assert.strictEqual(rejected.selected_cap, 0);
assert.strictEqual(rejected.affects_etsr, false);

/* Market ATS uses a fixed threshold grid and ignores pushes. */
const marketRows = [
  { margin: 7, market: 3, predictions: { '1': 6 } },
  { margin: 1, market: 3, predictions: { '1': 6 } },
  { margin: 3, market: 3, predictions: { '1': 6 } }
];
const ats = V.atsVsClose(marketRows, r => r.predictions['1']);
assert.strictEqual(ats['2'].n, 2);
assert.strictEqual(ats['2'].wins, 1);
assert.strictEqual(ats['2'].pushes, 1);
assert.strictEqual(ats['2'].win_pct, 0.5);

/* Predictive residual asks whether the proposed movement points into the
   baseline's future miss. */
const residRows = [];
for (let i = 1; i <= 40; i++) {
  const base = 0;
  const adj = i / 10;
  residRows.push({ margin: adj * 2, base, arm: adj });
}
const pr = V.predictiveResidual(residRows, r => r.base, r => r.arm);
assert.ok(pr.slope > 0);
assert.ok(pr.correlation > 0);

console.log('validate_coaching_program: passed');

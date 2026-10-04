#!/usr/bin/env node
'use strict';

const assert = require('assert');
const V = require('./validate_coaching_staff.js');

function exp(tuneCap, tuneK, armOverrides) {
  return {
    tune: {
      selection: tuneCap > 0
        ? { cap: tuneCap, k: tuneK, reason: 'synthetic tune winner' }
        : { cap: 0, k: null, reason: 'no tune arm cleared guards' }
    },
    holdout: {
      baseline: { spread_mae: 10, rmse: 13, brier: 0.22 },
      arms: [{
        feature: 'nfl_coaching_staff_cap_' + tuneCap,
        cap: tuneCap,
        k: tuneK,
        spread_mae: 9.95,
        rmse: 12.99,
        brier: 0.2195,
        paired: { p: 0.01 },
        per_season: [
          { season: 2024, n: 250, mae_before: 10, mae_after: 9.96 },
          { season: 2025, n: 250, mae_before: 10, mae_after: 9.94 }
        ],
        leakage_clean: true,
        predictive_residual: { slope: 0.4 },
        coefficient: tuneCap,
        version: 'nfl_coaching_staff_v1',
        ...(armOverrides || {})
      }]
    }
  };
}

/* No tune winner means holdout never gets to shop around for one. */
let d = V.decide(exp(0, null));
assert.strictEqual(d.selected_cap, 0);
assert.strictEqual(d.affects_projection, false);
assert.strictEqual(d.status, 'RESEARCH_ONLY');

/* A frozen tune winner that clears the shared gate may promote. */
d = V.decide(exp(0.5, 8), { now: '2026-09-22T00:00:00Z' });
assert.strictEqual(d.selected_cap, 0.5);
assert.strictEqual(d.selected_reliability_k, 8);
assert.strictEqual(d.affects_projection, true);
assert.strictEqual(d.status, 'VALIDATED');
assert.ok(d.verdict.conditions_passed.includes('significance'));

/* A better-looking different holdout cap is irrelevant because only the
   tune-selected cap is eligible. */
const e = exp(0.5, 8);
e.holdout.arms.push({
  feature: 'nfl_coaching_staff_cap_1',
  cap: 1,
  k: 8,
  spread_mae: 9.5,
  rmse: 12.5,
  brier: 0.20,
  paired: { p: 0.0001 },
  per_season: [
    { season: 2024, n: 250, mae_before: 10, mae_after: 9.5 },
    { season: 2025, n: 250, mae_before: 10, mae_after: 9.5 }
  ],
  leakage_clean: true,
  predictive_residual: { slope: 1 },
  coefficient: 1
});
d = V.decide(e, { now: '2026-09-22T00:00:00Z' });
assert.strictEqual(d.selected_cap, 0.5, 'holdout must not replace the tune-selected cap');

/* Any failed shared-gate condition leaves production at zero. */
d = V.decide(exp(0.5, 8, { paired: { p: 0.4 } }));
assert.strictEqual(d.selected_cap, 0);
assert.strictEqual(d.affects_projection, false);
assert.notStrictEqual(d.status, 'VALIDATED');

/* The extra NFL RMSE guard is independent of the shared gate. */
d = V.decide(exp(0.5, 8, { rmse: 13.02 }));
assert.strictEqual(d.selected_cap, 0);
assert.strictEqual(d.affects_projection, false);
assert.strictEqual(d.extra_guards.rmse_not_worse_by_more_than_0_01, false);

/* A backwards residual direction is rejected even if MAE happens to improve. */
d = V.decide(exp(0.5, 8, { predictive_residual: { slope: -0.1 } }));
assert.strictEqual(d.selected_cap, 0);
assert.strictEqual(d.affects_projection, false);
assert.strictEqual(d.extra_guards.positive_predictive_residual_direction, false);

console.log('nfl validate_coaching_staff: passed');

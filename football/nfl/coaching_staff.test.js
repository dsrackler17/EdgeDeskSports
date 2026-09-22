#!/usr/bin/env node
'use strict';

const assert = require('assert');
const C = require('./coaching_staff.js');

const ids = [
  'current_residual_conversion',
  'multi_season_head_coach',
  'program_persistence',
  'efficiency_development',
  'game_management'
];

const out = C.build(['ARI', 'BUF']);
assert.strictEqual(out.schema, 'edgedesk_nfl_coaching_staff_v1');
assert.strictEqual(out.status, 'CONTRACT_ONLY');
assert.strictEqual(out.affects_nfl_projection, false);
assert.deepStrictEqual(Object.keys(out.teams).sort(), ['ARI', 'BUF']);

const t = out.teams.ARI;
assert.strictEqual(t.coaching_staff_rating, null);
assert.strictEqual(t.coaching_staff_rank, null);
assert.strictEqual(t.coaching_staff_reliability, 0);
assert.strictEqual(t.coaching_staff_candidate_adjustment_points, null);
assert.strictEqual(t.coaching_staff_adjustment_points, 0);
assert.strictEqual(t.coaching_staff_affects_nfl_projection, false);
assert.strictEqual(t.coaching_staff_available, false);
assert.deepStrictEqual(Object.keys(t.coaching_staff_inputs), ids);

let weight = 0;
for (const id of ids) {
  const x = t.coaching_staff_inputs[id];
  assert.strictEqual(x.value, null, id + ' must not invent a neutral score');
  assert.strictEqual(x.observations, 0);
  assert.strictEqual(x.weighted_evidence, null);
  assert.strictEqual(x.reliability, 0);
  assert.strictEqual(x.source, null);
  assert.strictEqual(x.available, false);
  weight += x.configured_weight;
}
assert.ok(Math.abs(weight - 1) < 1e-12, 'NFL coaching/staff weights must sum to 1');
assert.ok(!JSON.stringify(t).includes('"coaching_staff_rating":50'));

console.log('nfl coaching_staff contract: passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const CP = require('./coaching_program.js');

const out = CP.build(['alpha', 'beta']);
assert.strictEqual(out.schema, 'edgedesk_coaching_program_v1');
assert.strictEqual(out.status, 'CONTRACT_ONLY');
assert.strictEqual(out.affects_etsr, false);
assert.deepStrictEqual(Object.keys(out.teams).sort(), ['alpha', 'beta']);

const t = out.teams.alpha;
assert.strictEqual(t.coaching_program_rating, null);
assert.strictEqual(t.coaching_program_rank, null);
assert.strictEqual(t.coaching_program_reliability, 0);
assert.strictEqual(t.coaching_program_adjustment_points, 0);
assert.strictEqual(t.coaching_program_available, false);
assert.strictEqual(t.coaching_program_affects_etsr, false);

const ids = [
  'talent_conversion',
  'multi_season_program_overperformance',
  'roster_management_retention',
  'staff_continuity_stability',
  'development',
  'game_management'
];
assert.deepStrictEqual(Object.keys(t.coaching_program_inputs), ids);

let weight = 0;
for (const id of ids) {
  const x = t.coaching_program_inputs[id];
  assert.strictEqual(x.value, null, id + ' must not fabricate a neutral score');
  assert.strictEqual(x.observations, 0);
  assert.strictEqual(x.weighted_evidence, 0);
  assert.strictEqual(x.reliability, 0);
  assert.strictEqual(x.source, null);
  assert.strictEqual(x.last_updated, null);
  assert.strictEqual(x.available, false);
  weight += x.configured_weight;
}
assert.ok(Math.abs(weight - 1) < 1e-12, 'configured subcomponent weights must sum to 1');
assert.ok(t.coaching_program_warnings.length > 0);

const serialized = JSON.stringify(t);
assert.ok(!serialized.includes('"coaching_program_rating":50'), 'missing coaching evidence must never become a fake 50');

console.log('coaching_program contract: passed');

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

/* Raw measured evidence may populate the configured input without silently
   turning itself into a rating, reliability score or projection adjustment. */
const evidenceOut = C.build(['ARI', 'BUF', 'KC'], {
  schema: 'edgedesk_nfl_coaching_staff_current_residual_v1',
  season: 2026,
  input: 'current_residual_conversion',
  teams: {
    BUF: {
      team: 'BUF',
      available: true,
      value: 1.75,
      observations: 3,
      source: 'frozen pregame residual ledger'
    },
    KC: {
      team: 'KC',
      available: false,
      value: null,
      observations: 0,
      source: 'frozen pregame residual ledger'
    }
  }
});
assert.strictEqual(evidenceOut.status, 'EVIDENCE_ONLY');
const buf = evidenceOut.teams.BUF;
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.available, true);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.value, 1.75);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.observations, 3);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.weighted_evidence, null);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.reliability, 0);
assert.strictEqual(buf.coaching_staff_rating, null);
assert.strictEqual(buf.coaching_staff_rank, null);
assert.strictEqual(buf.coaching_staff_reliability, 0);
assert.strictEqual(buf.coaching_staff_candidate_adjustment_points, null);
assert.strictEqual(buf.coaching_staff_adjustment_points, 0);
assert.strictEqual(buf.coaching_staff_affects_nfl_projection, false);
assert.strictEqual(buf.coaching_staff_available, false);

const kc = evidenceOut.teams.KC;
assert.strictEqual(kc.coaching_staff_inputs.current_residual_conversion.available, false);
assert.strictEqual(kc.coaching_staff_inputs.current_residual_conversion.value, null);
assert.strictEqual(kc.coaching_staff_inputs.current_residual_conversion.observations, 0);

const ari = evidenceOut.teams.ARI;
assert.strictEqual(ari.coaching_staff_inputs.current_residual_conversion.available, false);
assert.strictEqual(ari.coaching_staff_inputs.current_residual_conversion.value, null);

console.log('nfl coaching_staff contract: passed');

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const CP = require('./coaching_program.js');

const ids = [
  'talent_conversion',
  'multi_season_program_overperformance',
  'roster_management_retention',
  'staff_continuity_stability',
  'development',
  'game_management'
];

/* Empty plumbing still refuses to invent evidence. */
const empty = CP.build(['alpha', 'beta']);
assert.strictEqual(empty.schema, 'edgedesk_coaching_program_v1');
assert.strictEqual(empty.status, 'CONTRACT_ONLY');
assert.strictEqual(empty.affects_etsr, false);
const e = empty.teams.alpha;
assert.strictEqual(e.coaching_program_rating, null);
assert.strictEqual(e.coaching_program_rank, null);
assert.strictEqual(e.coaching_program_reliability, 0);
assert.strictEqual(e.coaching_program_adjustment_points, 0);
assert.strictEqual(e.coaching_program_available, false);
assert.strictEqual(e.coaching_program_affects_etsr, false);
assert.deepStrictEqual(Object.keys(e.coaching_program_inputs), ids);

let configuredWeight = 0;
for (const id of ids) {
  const x = e.coaching_program_inputs[id];
  assert.strictEqual(x.value, null, id + ' must not fabricate a neutral score');
  assert.strictEqual(x.observations, 0);
  assert.strictEqual(x.weighted_evidence, 0);
  assert.strictEqual(x.reliability, 0);
  assert.strictEqual(x.source, null);
  assert.strictEqual(x.available, false);
  configuredWeight += x.configured_weight;
}
assert.ok(Math.abs(configuredWeight - 1) < 1e-12);
assert.ok(!JSON.stringify(e).includes('"coaching_program_rating":50'));

/* Synthetic league: same talent level, very different conversion must separate.
   Nobody is being hand-rated here; these rows are measured inputs to the same
   regression used by production. */
function layer(season) {
  const talent = {}, performance = {};
  for (let i = 0; i < 40; i++) {
    const key = 'team_' + i;
    const tr = 34 + i * 0.8;
    talent[key] = {
      rating: tr,
      returning: { value_continuity: 0.35 + (i % 10) * 0.03 }
    };
    const noise = ((i % 7) - 3) * 0.08;
    performance[key] = {
      net_z_before_reliability: 0.07 * (tr - 50) + noise,
      reliability: 1,
      sample: { games: 10, games_played: 10 }
    };
  }

  talent.elite = { rating: 80, returning: { value_continuity: 0.55 } };
  performance.elite = {
    net_z_before_reliability: 5.0,
    reliability: 1,
    sample: { games: 10, games_played: 10 }
  };

  talent.under = { rating: 80, returning: { value_continuity: 0.55 } };
  performance.under = {
    net_z_before_reliability: -2.0,
    reliability: 1,
    sample: { games: 10, games_played: 10 }
  };

  talent.middle = { rating: 50, returning: { value_continuity: 0.55 } };
  performance.middle = {
    net_z_before_reliability: 0.0,
    reliability: 1,
    sample: { games: 10, games_played: 10 }
  };

  return { talent, performance, season };
}

const seasons = {
  2023: layer(2023),
  2024: layer(2024),
  2025: layer(2025),
  2026: layer(2026)
};
const measured = CP.build(['elite', 'middle', 'under'], { season: 2026, seasons });
assert.strictEqual(measured.status, 'PARTIAL_RESEARCH');
assert.strictEqual(measured.affects_etsr, false);
assert.strictEqual(measured.final_score_enabled, false);

const elite = measured.teams.elite;
const middle = measured.teams.middle;
const under = measured.teams.under;
for (const t of [elite, middle, under]) {
  assert.strictEqual(t.coaching_program_rating, null, 'Step 3 must not jump ahead to final shrinkage');
  assert.strictEqual(t.coaching_program_adjustment_points, 0);
  assert.strictEqual(t.coaching_program_affects_etsr, false);
  assert.strictEqual(t.coaching_program_inputs.talent_conversion.available, true);
  assert.strictEqual(t.coaching_program_inputs.multi_season_program_overperformance.available, true);
}

const eliteNow = elite.coaching_program_inputs.talent_conversion;
const middleNow = middle.coaching_program_inputs.talent_conversion;
const underNow = under.coaching_program_inputs.talent_conversion;
assert.ok(eliteNow.value > 55, 'elite conversion should grade above average: ' + eliteNow.value);
assert.ok(underNow.value < 45, 'high-talent underperformance should grade below average: ' + underNow.value);
assert.ok(eliteNow.value > middleNow.value && middleNow.value > underNow.value,
  'elite/middle/underperforming ordering should come from residual arithmetic');

const eliteMulti = elite.coaching_program_inputs.multi_season_program_overperformance;
const underMulti = under.coaching_program_inputs.multi_season_program_overperformance;
assert.ok(eliteMulti.value > 55);
assert.ok(underMulti.value < 45);
assert.strictEqual(eliteMulti.details.observed_decay_weight, 1);
assert.deepStrictEqual(
  eliteMulti.details.seasons.map(s => s.configured_weight),
  [0.45, 0.30, 0.17, 0.08]
);

/* Reconstructed weekly history must not use today's current-season talent. */
const reconstructed = CP.build(['elite'], {
  season: 2026,
  seasons,
  allow_current: false
});
assert.strictEqual(reconstructed.teams.elite.coaching_program_inputs.talent_conversion.available, false);
const backfillMulti = reconstructed.teams.elite.coaching_program_inputs.multi_season_program_overperformance;
assert.strictEqual(backfillMulti.available, true);
assert.strictEqual(backfillMulti.details.observed_decay_weight, 0.55);
assert.ok(!backfillMulti.details.seasons.some(s => s.season === 2026));

console.log('coaching_program Step 3: passed');

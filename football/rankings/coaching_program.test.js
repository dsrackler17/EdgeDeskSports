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

/* =====================================================================
   STEP 4 — roster management, staff evidence, same-program development.
   ===================================================================== */
const rosterKeys = [];
const roster = {};
for (let i = 0; i < 40; i++) {
  const k = 'roster_' + i;
  rosterKeys.push(k);
  const retention = 0.18 + i * 0.016;
  roster[k] = {
    returning: {
      value_continuity: retention,
      roster_continuity: 0.4 + (i % 6) * 0.03,
      players_prior: 100,
      players_returning: Math.round(100 * retention),
      by_group: { ALL: { starters: 22, starters_returning: retention } }
    },
    transfers: {
      in: 10, out: 10, value_in: 40 + i * 2, value_out: 80 - i,
      net_value: -40 + i * 3, starters_in: i % 4, starters_out: (39 - i) % 3,
      unknown_in: 2
    }
  };
}
/* Same scored evidence, wildly different portal volume. The number of portal
   transactions must not become a quality signal. */
roster.volume_low = {
  returning: { value_continuity: 0.5, roster_continuity: 0.5, players_prior: 100, players_returning: 50,
    by_group: { ALL: { starters: 22, starters_returning: 0.5 } } },
  transfers: { in: 4, out: 4, net_value: 20, unknown_in: 0 }
};
roster.volume_high = {
  returning: { value_continuity: 0.5, roster_continuity: 0.5, players_prior: 100, players_returning: 50,
    by_group: { ALL: { starters: 22, starters_returning: 0.5 } } },
  transfers: { in: 40, out: 40, net_value: 20, unknown_in: 0 }
};
rosterKeys.push('volume_low', 'volume_high');

const rosterOut = CP.rosterManagement(rosterKeys, roster, '2026-09-22T00:00:00Z', true);
assert.ok(rosterOut.roster_39.value > rosterOut.roster_0.value,
  'retained value/starters/net portal value should separate strong and weak roster management');
assert.strictEqual(rosterOut.volume_low.value, rosterOut.volume_high.value,
  'portal volume itself must not improve the score');
assert.strictEqual(rosterOut.volume_low.details.portal_volume_scored, false);
assert.notStrictEqual(
  rosterOut.volume_low.details.churn_count_context_only,
  rosterOut.volume_high.details.churn_count_context_only
);

const rosterBackfill = CP.rosterManagement(['volume_low'], roster, null, false);
assert.strictEqual(rosterBackfill.volume_low.available, false);
assert.strictEqual(rosterBackfill.volume_low.value, null);

/* Staff continuity is published as evidence, never as a directional bonus. */
const staffArtifact = {
  generated_at: '2026-09-22T00:00:00Z',
  source: 'synthetic',
  by_team: {
    stable: { hc: 'Coach A', since_season: 2024, tenure_seasons: 3, new_hc: false,
      new_oc: null, new_dc: null, known: ['hc'], unknown: ['oc', 'dc'], source: 'synthetic' },
    changed: { hc: 'Coach B', since_season: 2026, tenure_seasons: 1, new_hc: true,
      new_oc: null, new_dc: null, known: ['hc'], unknown: ['oc', 'dc'], source: 'synthetic' }
  }
};
const staffOut = CP.staffEvidence(['stable', 'changed'], staffArtifact);
for (const k of ['stable', 'changed']) {
  assert.strictEqual(staffOut[k].value, null);
  assert.strictEqual(staffOut[k].available, false);
  assert.strictEqual(staffOut[k].weighted_evidence, 0);
  assert.strictEqual(staffOut[k].details.directional_score_applied, false);
}
assert.strictEqual(staffOut.stable.details.new_hc, false);
assert.strictEqual(staffOut.changed.details.new_hc, true);

/* Development: same athlete + same programme only, with current quality
   residualised against prior quality across the league. */
function player(key, team, group, z, sample) {
  return {
    key, team_key: team, group,
    confidence: 0.9, sample_size: sample || 100, mid_season_move: false,
    components: { quality: { z_raw: z } }
  };
}
const devLayers = { 2025: { players: {} }, 2026: { players: {} } };
for (let i = 0; i < 40; i++) {
  const team = 'dev_' + i, key = 'p:' + i;
  const prior = -1.5 + i * 0.075;
  devLayers[2025].players[team] = [player(key, team, i % 4 === 0 ? 'QB' : 'LB', prior)];
  devLayers[2026].players[team] = [player(key, team, i % 4 === 0 ? 'QB' : 'LB', 0.8 * prior + ((i % 5) - 2) * 0.03)];
}
devLayers[2025].players.devgood = [];
devLayers[2026].players.devgood = [];
devLayers[2025].players.devbad = [];
devLayers[2026].players.devbad = [];
for (let i = 0; i < 8; i++) {
  const group = i === 0 ? 'QB' : (i < 4 ? 'OL' : 'LB');
  devLayers[2025].players.devgood.push(player('good:' + i, 'devgood', group, -0.4 + i * 0.1));
  devLayers[2026].players.devgood.push(player('good:' + i, 'devgood', group, 1.4 + i * 0.1));
  devLayers[2025].players.devbad.push(player('bad:' + i, 'devbad', group, -0.4 + i * 0.1));
  devLayers[2026].players.devbad.push(player('bad:' + i, 'devbad', group, -1.4 + i * 0.1));
}
/* Same athlete id, different team: must be excluded as a transfer rather than
   awarded to the destination programme. */
devLayers[2025].players.oldschool = [player('transfer:1', 'oldschool', 'QB', -2)];
devLayers[2026].players.devgood.push(player('transfer:1', 'devgood', 'QB', 2));

const dev = CP.developmentModel(2026, devLayers, '2026-09-22T00:00:00Z');
assert.strictEqual(dev.available, true);
assert.ok(dev.teams.devgood.value > 55, 'same-program improvement should grade above average');
assert.ok(dev.teams.devbad.value < 45, 'same-program regression should grade below average');
assert.strictEqual(dev.teams.devgood.observations, 8,
  'the transfer must not be counted as development by the new programme');
assert.ok(dev.teams.devgood.details.qb.value != null);
assert.ok(dev.teams.devgood.details.ol.value != null);
assert.ok(dev.teams.devgood.details.defense.value != null);
assert.strictEqual(dev.teams.devgood.details.transfer_credit, false);

/* Integration still does NOT publish a final coaching rating or ETSR input. */
const integratedSeasons = {
  2025: Object.assign({}, seasons[2025], { players: devLayers[2025].players }),
  2026: Object.assign({}, seasons[2026], { roster, players: devLayers[2026].players })
};
const integratedKeys = rosterKeys.concat(['devgood', 'devbad']);
const integrated = CP.build(integratedKeys, {
  season: 2026,
  seasons: integratedSeasons,
  staff: staffArtifact,
  roster_last_updated: '2026-09-22T00:00:00Z',
  development_last_updated: '2026-09-22T00:00:00Z'
});
assert.strictEqual(integrated.affects_etsr, false);
assert.strictEqual(integrated.final_score_enabled, false);
assert.strictEqual(integrated.teams.roster_39.coaching_program_rating, null);
assert.strictEqual(integrated.teams.roster_39.coaching_program_adjustment_points, 0);
assert.strictEqual(integrated.teams.roster_39.coaching_program_inputs.roster_management_retention.available, true);
assert.strictEqual(integrated.teams.devgood.coaching_program_inputs.development.available, true);
assert.strictEqual(integrated.teams.devgood.coaching_program_inputs.game_management.available, false);

console.log('coaching_program Step 4: passed');

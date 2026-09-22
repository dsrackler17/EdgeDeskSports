#!/usr/bin/env node
'use strict';

const assert = require('assert');
const CP = require('./coaching_program.js');
const CFG = require('./config.js');
const ETSR = require('./etsr.js');
const HISTORY = require('./history.js');

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
  if (id === 'game_management') {
    assert.ok(/play-by-play/i.test(x.source || ''), 'game management should name the audited source even while unscored');
  } else {
    assert.strictEqual(x.source, null);
  }
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
assert.strictEqual(measured.status, 'SCORED_RESEARCH');
assert.strictEqual(measured.affects_etsr, false);
assert.strictEqual(measured.final_score_enabled, true);

const elite = measured.teams.elite;
const middle = measured.teams.middle;
const under = measured.teams.under;
for (const t of [elite, middle, under]) {
  assert.ok(Number.isFinite(t.coaching_program_rating), 'Step 5 should publish a reliability-shrunk research score');
  assert.ok(Number.isFinite(t.coaching_program_raw_score));
  assert.strictEqual(t.coaching_program_observed_weight, 0.6);
  assert.ok(t.coaching_program_reliability > 0 && t.coaching_program_reliability <= 0.6);
  assert.strictEqual(t.coaching_program_rank, null);
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
assert.strictEqual(integrated.final_score_enabled, true);
assert.ok(Number.isFinite(integrated.teams.roster_39.coaching_program_rating));
assert.strictEqual(integrated.teams.roster_39.coaching_program_adjustment_points, 0);
assert.strictEqual(integrated.teams.roster_39.coaching_program_inputs.roster_management_retention.available, true);
assert.strictEqual(integrated.teams.devgood.coaching_program_inputs.development.available, true);
assert.strictEqual(integrated.teams.devgood.coaching_program_inputs.game_management.available, false);

console.log('coaching_program Step 4: passed');


/* =====================================================================
   STEP 5 — configured-weight renormalization + reliability shrinkage.
   ===================================================================== */
function scoredInput(value, reliability, configuredWeight) {
  return {
    value,
    observations: 10,
    weighted_evidence: ((value - 50) / 12) * reliability,
    reliability,
    source: 'synthetic',
    last_updated: null,
    configured_weight: configuredWeight,
    available: true,
    reason: null
  };
}

/* With staff and game management unavailable, the four measurable pieces
   cover .85 of the configured model. Raw score = 60.0 exactly:
     (.35*80 + .25*60 + .15*40 + .10*20) / .85 = 60
   reliability = .85 when every observed input is perfectly reliable.
   final = 50 + (60 - 50) * .85 = 58.5 */
const formulaTeam = CP.emptyTeam('formula');
formulaTeam.coaching_program_inputs.talent_conversion = scoredInput(80, 1, 0.35);
formulaTeam.coaching_program_inputs.multi_season_program_overperformance = scoredInput(60, 1, 0.25);
formulaTeam.coaching_program_inputs.roster_management_retention = scoredInput(40, 1, 0.15);
formulaTeam.coaching_program_inputs.development = scoredInput(20, 1, 0.10);
CP.finalizeTeam(formulaTeam);
assert.strictEqual(formulaTeam.coaching_program_raw_score, 60);
assert.strictEqual(formulaTeam.coaching_program_observed_weight, 0.85);
assert.strictEqual(formulaTeam.coaching_program_reliability, 0.85);
assert.strictEqual(formulaTeam.coaching_program_rating, 58.5);
assert.strictEqual(formulaTeam.coaching_program_rank, null);
assert.strictEqual(formulaTeam.coaching_program_adjustment_points, 0);
assert.strictEqual(formulaTeam.coaching_program_affects_etsr, false);
assert.ok(Math.abs(
  formulaTeam.coaching_program_reliability_details.contributions
    .reduce((s, x) => s + x.normalized_weight, 0) - 1
) < 0.002, 'observed configured weights must renormalize to one');

/* Remove development rather than silently substituting a neutral 50.
   Remaining configured weight is .75; missing weight lowers reliability. */
const missingTeam = CP.emptyTeam('missing');
missingTeam.coaching_program_inputs.talent_conversion = scoredInput(80, 1, 0.35);
missingTeam.coaching_program_inputs.multi_season_program_overperformance = scoredInput(60, 1, 0.25);
missingTeam.coaching_program_inputs.roster_management_retention = scoredInput(40, 1, 0.15);
CP.finalizeTeam(missingTeam);
assert.strictEqual(missingTeam.coaching_program_observed_weight, 0.75);
assert.strictEqual(missingTeam.coaching_program_reliability, 0.75);
assert.strictEqual(missingTeam.coaching_program_raw_score, 65.3);
assert.strictEqual(missingTeam.coaching_program_rating, 61.5);
assert.strictEqual(
  missingTeam.coaching_program_reliability_details.missing_configured_weight,
  0.25
);

/* Weak evidence must pull an extreme raw score back toward 50. */
const weakTeam = CP.emptyTeam('weak');
weakTeam.coaching_program_inputs.talent_conversion = scoredInput(100, 0.1, 0.35);
weakTeam.coaching_program_inputs.multi_season_program_overperformance = scoredInput(100, 0.1, 0.25);
weakTeam.coaching_program_inputs.roster_management_retention = scoredInput(100, 0.1, 0.15);
weakTeam.coaching_program_inputs.development = scoredInput(100, 0.1, 0.10);
CP.finalizeTeam(weakTeam);
assert.strictEqual(weakTeam.coaching_program_raw_score, 100);
assert.strictEqual(weakTeam.coaching_program_reliability, 0.085);
assert.strictEqual(weakTeam.coaching_program_rating, 54.3);

/* A real measured 50 is allowed to be 50. Missing evidence is still null. */
const averageTeam = CP.emptyTeam('average');
averageTeam.coaching_program_inputs.talent_conversion = scoredInput(50, 1, 0.35);
CP.finalizeTeam(averageTeam);
assert.strictEqual(averageTeam.coaching_program_available, true);
assert.strictEqual(averageTeam.coaching_program_rating, 50);
const noEvidence = CP.emptyTeam('none');
CP.finalizeTeam(noEvidence);
assert.strictEqual(noEvidence.coaching_program_available, false);
assert.strictEqual(noEvidence.coaching_program_rating, null);

console.log('coaching_program Step 5: passed');

/* =====================================================================
   STEP 6 — category rank, immutable snapshot shape and arithmetic movement.
   ===================================================================== */
const coachingCat = CFG.RANKINGS.find(x => x.id === 'coaching_program');
assert.ok(coachingCat, 'Coaching / Program must be a registered rankings category');
assert.strictEqual(coachingCat.field, 'coaching_program_rating');
assert.strictEqual(coachingCat.confidence_field, 'coaching_program_reliability');
assert.strictEqual(coachingCat.research_only, true);

/* Overall confidence must NOT decide this category. */
const rankTeams = {
  reliable: {
    confidence: { value: 0.05 },
    coaching_program_rating: 61,
    coaching_program_reliability: 0.80
  },
  unreliable: {
    confidence: { value: 0.95 },
    coaching_program_rating: 99,
    coaching_program_reliability: 0.10
  },
  second: {
    confidence: { value: 0.95 },
    coaching_program_rating: 55,
    coaching_program_reliability: 0.70
  }
};
const cpRank = ETSR.rank(rankTeams, coachingCat);
assert.strictEqual(cpRank.ranks.reliable.rank, 1);
assert.strictEqual(cpRank.ranks.second.rank, 2);
assert.strictEqual(cpRank.ranks.unreliable.rank, null);
assert.strictEqual(cpRank.ranks.unreliable.unranked, true);
assert.ok(/coaching\/program reliability/i.test(cpRank.ranks.unreliable.reason));

/* Snapshot only records what existed at that week. It carries enough of the
   coaching calculation to difference subfactors later without recomputation. */
function movementTeam(rating, raw, reliability, talentValue, devValue, rank) {
  return {
    etsr: 3, rank: 20, confidence: { value: 0.8 },
    talent: { rating: 60 }, weights: { performance: 0.4 },
    performance: {
      rating: 55, offense: 56, defense: 54, special_teams: 50,
      run_offense: 55, pass_offense: 57, run_defense: 53, pass_defense: 55,
      opponent_delta: 0.2
    },
    run_defence_power: { score: 53 },
    availability: { rating: 50 },
    coaching_program_rating: rating,
    coaching_program_raw_score: raw,
    coaching_program_rank: rank,
    coaching_program_reliability: reliability,
    coaching_program_observed_weight: 0.85,
    coaching_program_adjustment_points: 0,
    coaching_program_affects_etsr: false,
    coaching_program_inputs: {
      talent_conversion: scoredInput(talentValue, 0.8, 0.35),
      development: scoredInput(devValue, 0.5, 0.10)
    },
    ranks: {
      overall: { value: 3, rank: 20, unranked: false },
      talent: { value: 60, rank: 20, unranked: false },
      performance: { value: 55, rank: 25, unranked: false },
      coaching_program: { value: rating, rank, unranked: rank == null }
    },
    gates: []
  };
}
const prevTeamForMovement = movementTeam(55, 58, 0.50, 60, 50, 30);
const nowTeamForMovement = movementTeam(60, 64, 0.60, 68, 44, 18);
const prevSnapshotTeam = HISTORY.snapshotTeam(prevTeamForMovement);
assert.strictEqual(prevSnapshotTeam.coaching_program.rating, 55);
assert.strictEqual(prevSnapshotTeam.coaching_program.reliability, 0.5);
assert.strictEqual(prevSnapshotTeam.coaching_program.affects_etsr, false);
assert.strictEqual(prevSnapshotTeam.coaching_program.inputs.talent_conversion.value, 60);
assert.ok(prevSnapshotTeam.cat.coaching_program);

const moved = ETSR.movement(nowTeamForMovement, prevSnapshotTeam, {
  season: 2026, week_ordinal: 3, week_label: 'Week 3',
  current_ordinal: 4, current_season: 2026
});
assert.strictEqual(moved.coaching_program.available, true);
assert.strictEqual(moved.coaching_program.rating.delta, 5);
assert.strictEqual(moved.coaching_program.raw_score.delta, 6);
assert.strictEqual(moved.coaching_program.reliability.delta, 0.1);
assert.strictEqual(moved.coaching_program.inputs.talent_conversion.value.delta, 8);
assert.strictEqual(moved.coaching_program.inputs.development.value.delta, -6);
assert.ok(moved.drivers.some(d => d.id === 'coaching_program' && d.delta === 5));
assert.strictEqual(moved.categories.coaching_program.rank.delta, 12);

/* The history read model carries the category and detailed coaching delta. */
const hSeries = HISTORY.seriesFor('x', [
  { season: 2026, week_ordinal: 3, week_label: 'Week 3', teams: { x: prevSnapshotTeam } },
  { season: 2026, week_ordinal: 4, week_label: 'Week 4', teams: { x: HISTORY.snapshotTeam(nowTeamForMovement) } }
]);
assert.strictEqual(hSeries.length, 2);
assert.strictEqual(hSeries[1].categories.coaching_program.value, 60);
assert.strictEqual(hSeries[1].delta.categories.coaching_program.value, 5);
assert.strictEqual(hSeries[1].delta.coaching_program.inputs.talent_conversion.value, 8);

/* Ranking/history exposure still cannot leak into ETSR. */
assert.strictEqual(nowTeamForMovement.coaching_program_adjustment_points, 0);
assert.strictEqual(nowTeamForMovement.coaching_program_affects_etsr, false);

console.log('coaching_program Step 6 backend: passed');


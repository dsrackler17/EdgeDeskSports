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

assert.strictEqual(C.MIN_COHORT, 20);
assert.strictEqual(C.RATING_SD, 12);
assert.strictEqual(C.NFL_REGULAR_SEASON_GAMES, 17);
assert.strictEqual(C.reliabilityFor('current_residual_conversion', { observations: 17 }), 1);
assert.strictEqual(C.reliabilityFor('current_residual_conversion', { observations: 8 }), 8 / 17);
assert.strictEqual(C.reliabilityFor('multi_season_head_coach', { observations: 34, season_count: 2 }), 1);
assert.strictEqual(C.reliabilityFor('multi_season_head_coach', { observations: 17, season_count: 2 }), 0.5);
assert.strictEqual(C.reliabilityFor('program_persistence', { observations: 51, season_count: 3 }), 1);
assert.strictEqual(C.reliabilityFor('efficiency_development', { observations: 6, games_available: 6 }), 6 / 17);
assert.strictEqual(C.reliabilityFor('game_management', { observations: 99 }), 0);
assert.ok(!JSON.stringify(t).includes('"coaching_staff_rating":50'));
assert.strictEqual(t.coaching_staff_inputs.game_management.value, null);
assert.match(t.coaching_staff_inputs.game_management.reason, /fourth-down/i);
assert.match(t.coaching_staff_inputs.game_management.reason, /close-game record/i);
assert.match(t.coaching_staff_inputs.game_management.reason, /not accepted/i);

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
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.available, false);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.raw_value, 1.75);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.value, null);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.observations, 3);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.weighted_evidence, null);
assert.strictEqual(buf.coaching_staff_inputs.current_residual_conversion.reliability, 0);
assert.match(buf.coaching_staff_inputs.current_residual_conversion.reason, /at least 20 teams/i);
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

/* Multi-season head-coach evidence may populate only its own raw input. */
const composite = C.build(['KC', 'BUF'], {
  current_residual: {
    teams: {
      KC: {
        available: true,
        value: 0.5,
        observations: 2,
        source: 'frozen pregame residual ledger'
      }
    }
  },
  head_coach: {
    teams: {
      KC: {
        available: true,
        value: 1.25,
        observations: 9,
        season_count: 2,
        seasons: [2025, 2026],
        source: 'frozen pregame residual ledger + frozen nflverse head-coach identity'
      },
      BUF: {
        available: false,
        value: null,
        observations: 4,
        season_count: 1,
        seasons: [2026],
        source: 'frozen pregame residual ledger + frozen nflverse head-coach identity'
      }
    }
  },
  program: {
    teams: {
      KC: {
        available: true,
        value: 0.8,
        observations: 17,
        season_count: 2,
        seasons: [2026, 2025],
        source: 'time-decayed same-franchise evidence from the frozen pregame residual ledger'
      },
      BUF: {
        available: false,
        value: null,
        observations: 8,
        season_count: 1,
        seasons: [2026],
        source: 'time-decayed same-franchise evidence from the frozen pregame residual ledger'
      }
    }
  },
  efficiency: {
    teams: {
      KC: {
        available: true,
        value: 0.04,
        observations: 6,
        games_available: 6,
        source: 'nflverse stats_team_week weekly team stats',
        opponent_strength_adjusted: false
      },
      BUF: {
        available: false,
        value: null,
        observations: 0,
        games_available: 5,
        source: 'nflverse stats_team_week weekly team stats',
        opponent_strength_adjusted: false
      }
    }
  }
});
assert.strictEqual(composite.status, 'EVIDENCE_ONLY');
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.current_residual_conversion.raw_value, 0.5);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.current_residual_conversion.value, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.multi_season_head_coach.available, false);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.multi_season_head_coach.raw_value, 1.25);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.multi_season_head_coach.value, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.multi_season_head_coach.observations, 9);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.multi_season_head_coach.weighted_evidence, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.multi_season_head_coach.reliability, 0);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.program_persistence.available, false);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.program_persistence.raw_value, 0.8);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.program_persistence.value, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.program_persistence.observations, 17);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.program_persistence.weighted_evidence, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.program_persistence.reliability, 0);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.efficiency_development.available, false);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.efficiency_development.raw_value, 0.04);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.efficiency_development.value, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.efficiency_development.observations, 6);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.efficiency_development.weighted_evidence, null);
assert.strictEqual(composite.teams.KC.coaching_staff_inputs.efficiency_development.reliability, 0);
assert.strictEqual(composite.teams.BUF.coaching_staff_inputs.efficiency_development.available, false);
assert.strictEqual(composite.teams.BUF.coaching_staff_inputs.efficiency_development.value, null);
assert.strictEqual(composite.teams.BUF.coaching_staff_inputs.program_persistence.available, false);
assert.strictEqual(composite.teams.BUF.coaching_staff_inputs.program_persistence.value, null);
assert.strictEqual(composite.teams.BUF.coaching_staff_inputs.multi_season_head_coach.available, false);
assert.strictEqual(composite.teams.BUF.coaching_staff_inputs.multi_season_head_coach.value, null);
assert.strictEqual(composite.teams.KC.coaching_staff_rating, null);
assert.strictEqual(composite.teams.KC.coaching_staff_adjustment_points, 0);
assert.strictEqual(composite.affects_nfl_projection, false);

/* A real league calibration requires the same minimum 20-team cohort used by
   the college coaching/program layer. With 21 teams, raw zero is legitimately
   league-average and may calibrate to 50; that is measured 50, not missing 50. */
const leagueKeys = [];
const leagueEvidence = { teams: {} };
for (let i = 0; i < 21; i++) {
  const team = 'T' + String(i).padStart(2, '0');
  leagueKeys.push(team);
  leagueEvidence.teams[team] = {
    team,
    available: true,
    value: i - 10,
    observations: 17,
    source: 'frozen pregame residual ledger'
  };
}
const calibrated = C.build(leagueKeys, leagueEvidence);
assert.strictEqual(calibrated.status, 'RESEARCH_ONLY');
assert.strictEqual(calibrated.calibration.current_residual_conversion.usable, true);
assert.strictEqual(calibrated.calibration.current_residual_conversion.cohort_teams, 21);
assert.strictEqual(calibrated.calibration.current_residual_conversion.mean_raw, 0);

const mid = calibrated.teams.T10;
assert.strictEqual(mid.coaching_staff_inputs.current_residual_conversion.raw_value, 0);
assert.strictEqual(mid.coaching_staff_inputs.current_residual_conversion.value, 50);
assert.strictEqual(mid.coaching_staff_inputs.current_residual_conversion.calibrated_z, 0);
assert.strictEqual(mid.coaching_staff_inputs.current_residual_conversion.reliability, 1);
assert.strictEqual(mid.coaching_staff_inputs.current_residual_conversion.weighted_evidence, 0);
assert.strictEqual(mid.coaching_staff_raw_score, 50);
assert.strictEqual(mid.coaching_staff_rating, 50);
assert.strictEqual(mid.coaching_staff_reliability, 0.45);
assert.strictEqual(mid.coaching_staff_observed_weight, 0.45);
assert.strictEqual(mid.coaching_staff_available, true);
assert.strictEqual(mid.coaching_staff_adjustment_points, 0);
assert.strictEqual(mid.coaching_staff_affects_nfl_projection, false);

const high = calibrated.teams.T20;
assert.ok(high.coaching_staff_inputs.current_residual_conversion.value > 50);
assert.ok(high.coaching_staff_rating > 50);
assert.ok(high.coaching_staff_rating < high.coaching_staff_raw_score,
  'partial configured coverage must shrink the research rating toward 50');
assert.strictEqual(calibrated.affects_nfl_projection, false);

console.log('nfl coaching_staff contract: passed');

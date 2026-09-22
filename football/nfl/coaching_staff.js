/* ============================================================================
   EdgeDesk NFL — COACHING / STAFF research contract.

   STEP 1 ONLY.

   NFL-specific inputs:
     current_residual_conversion 45%
     multi_season_head_coach     30%
     program_persistence         15%
     efficiency_development       5%
     game_management              5%

   This file deliberately scores NOTHING yet.

   Missing evidence is unavailable, never a fake neutral 50. No championships,
   salary, career win percentage, media reputation or famous-coach bonus may
   enter the score. The NFL projection impact is exactly zero in this step.
   ========================================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;

  var SCHEMA = 'edgedesk_nfl_coaching_staff_v1';

  var INPUTS = Object.freeze({
    current_residual_conversion: {
      label: 'Current residual conversion',
      weight: 0.45
    },
    multi_season_head_coach: {
      label: 'Multi-season head-coach residual',
      weight: 0.30
    },
    program_persistence: {
      label: 'Program persistence',
      weight: 0.15
    },
    efficiency_development: {
      label: 'Efficiency development',
      weight: 0.05
    },
    game_management: {
      label: 'Game management',
      weight: 0.05
    }
  });

  function blankInput(id) {
    var meta = INPUTS[id];
    return {
      id: id,
      label: meta.label,
      configured_weight: meta.weight,
      value: null,
      observations: 0,
      weighted_evidence: null,
      reliability: 0,
      source: null,
      last_updated: null,
      available: false,
      reason: 'not implemented in the Step 1 contract-only plumbing'
    };
  }

  function emptyTeam(team) {
    var inputs = {};
    Object.keys(INPUTS).forEach(function (id) {
      inputs[id] = blankInput(id);
    });

    return {
      schema: SCHEMA,
      team: team || null,
      coaching_staff_rating: null,
      coaching_staff_rank: null,
      coaching_staff_reliability: 0,
      coaching_staff_candidate_adjustment_points: null,
      coaching_staff_adjustment_points: 0,
      coaching_staff_affects_nfl_projection: false,
      coaching_staff_inputs: inputs,
      coaching_staff_warnings: [{
        id: 'NFL_COACHING_STAFF_NOT_SCORED',
        severity: 'info',
        detail: 'NFL Coaching / Staff contract exists, but no measured input has been scored yet.'
      }],
      coaching_staff_available: false
    };
  }

  function build(teamKeys) {
    var teams = {};
    (teamKeys || []).forEach(function (team) {
      teams[team] = emptyTeam(team);
    });

    return {
      schema: SCHEMA,
      status: 'CONTRACT_ONLY',
      affects_nfl_projection: false,
      inputs: Object.keys(INPUTS).map(function (id) {
        return {
          id: id,
          label: INPUTS[id].label,
          weight: INPUTS[id].weight
        };
      }),
      teams: teams
    };
  }

  var api = {
    SCHEMA: SCHEMA,
    INPUTS: INPUTS,
    blankInput: blankInput,
    emptyTeam: emptyTeam,
    build: build
  };

  root.EDNFLCoachingStaff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

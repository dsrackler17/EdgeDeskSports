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

  function applyCurrentResidualEvidence(teamRow, evidenceRow) {
    if (!teamRow || !teamRow.coaching_staff_inputs) return teamRow;
    var input = teamRow.coaching_staff_inputs.current_residual_conversion;
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.observations = Number(evidenceRow.observations);
    input.source = evidenceRow.source || 'frozen pregame residual ledger';
    input.last_updated = evidenceRow.last_updated || null;
    input.available = true;
    input.reason = null;

    /* Deliberately not populated yet: weighted_evidence and reliability.
       Raw evidence existing is not permission to invent a scoring curve. */
    return teamRow;
  }

  function applyHeadCoachEvidence(teamRow, evidenceRow) {
    if (!teamRow || !teamRow.coaching_staff_inputs) return teamRow;
    var input = teamRow.coaching_staff_inputs.multi_season_head_coach;
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0) ||
        !(Number(evidenceRow.season_count) >= 2)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.observations = Number(evidenceRow.observations);
    input.source = evidenceRow.source || 'frozen pregame residual ledger + frozen head-coach identity';
    input.last_updated = evidenceRow.last_updated || null;
    input.available = true;
    input.reason = null;
    return teamRow;
  }

  function applyProgramPersistenceEvidence(teamRow, evidenceRow) {
    if (!teamRow || !teamRow.coaching_staff_inputs) return teamRow;
    var input = teamRow.coaching_staff_inputs.program_persistence;
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0) ||
        !(Number(evidenceRow.season_count) >= 2)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.observations = Number(evidenceRow.observations);
    input.source = evidenceRow.source || 'time-decayed same-franchise evidence from frozen pregame residuals';
    input.last_updated = evidenceRow.last_updated || null;
    input.available = true;
    input.reason = null;
    return teamRow;
  }

  function applyEfficiencyDevelopmentEvidence(teamRow, evidenceRow) {
    if (!teamRow || !teamRow.coaching_staff_inputs) return teamRow;
    var input = teamRow.coaching_staff_inputs.efficiency_development;
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.observations = Number(evidenceRow.observations);
    input.source = evidenceRow.source || 'nflverse stats_team_week weekly team stats';
    input.last_updated = evidenceRow.last_updated || null;
    input.available = true;
    input.reason = null;
    return teamRow;
  }

  function build(teamKeys, evidence) {
    var teams = {};
    var hasEvidence = false;
    var currentResidualEvidence = evidence && evidence.current_residual ? evidence.current_residual : evidence;
    var headCoachEvidence = evidence && evidence.head_coach ? evidence.head_coach : null;
    var programEvidence = evidence && evidence.program ? evidence.program : null;
    var efficiencyEvidence = evidence && evidence.efficiency ? evidence.efficiency : null;
    var currentResidualTeams = currentResidualEvidence && currentResidualEvidence.teams ? currentResidualEvidence.teams : {};
    var headCoachTeams = headCoachEvidence && headCoachEvidence.teams ? headCoachEvidence.teams : {};
    var programTeams = programEvidence && programEvidence.teams ? programEvidence.teams : {};
    var efficiencyTeams = efficiencyEvidence && efficiencyEvidence.teams ? efficiencyEvidence.teams : {};
    (teamKeys || []).forEach(function (team) {
      teams[team] = emptyTeam(team);
      applyCurrentResidualEvidence(teams[team], currentResidualTeams[team]);
      applyHeadCoachEvidence(teams[team], headCoachTeams[team]);
      applyProgramPersistenceEvidence(teams[team], programTeams[team]);
      applyEfficiencyDevelopmentEvidence(teams[team], efficiencyTeams[team]);
      if (teams[team].coaching_staff_inputs.current_residual_conversion.available ||
          teams[team].coaching_staff_inputs.multi_season_head_coach.available ||
          teams[team].coaching_staff_inputs.program_persistence.available ||
          teams[team].coaching_staff_inputs.efficiency_development.available) {
        hasEvidence = true;
      }
    });

    return {
      schema: SCHEMA,
      status: hasEvidence ? 'EVIDENCE_ONLY' : 'CONTRACT_ONLY',
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
    applyCurrentResidualEvidence: applyCurrentResidualEvidence,
    applyHeadCoachEvidence: applyHeadCoachEvidence,
    applyProgramPersistenceEvidence: applyProgramPersistenceEvidence,
    applyEfficiencyDevelopmentEvidence: applyEfficiencyDevelopmentEvidence,
    build: build
  };

  root.EDNFLCoachingStaff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

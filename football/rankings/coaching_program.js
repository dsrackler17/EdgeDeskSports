/* ============================================================================
   COACHING / PROGRAM EDGE — DATA CONTRACT AND EMPTY PLUMBING

   STEP 2 ONLY.

   This module deliberately scores NOTHING yet. Its job is to make the future
   coaching/program layer explicit, typed by convention, and impossible to
   confuse with an already-validated ETSR input.

   Missing evidence is NULL, never a fake 50. Reliability is 0 until measurable
   inputs are implemented. The ETSR adjustment is therefore exactly 0.

   The six declared subcomponents and their configured weights mirror the
   research contract. Observed weights will be renormalized only after real
   inputs exist in later steps.
   ========================================================================== */
'use strict';

const SCHEMA = 'edgedesk_coaching_program_v1';

const COMPONENTS = Object.freeze([
  { id: 'talent_conversion', weight: 0.35 },
  { id: 'multi_season_program_overperformance', weight: 0.25 },
  { id: 'roster_management_retention', weight: 0.15 },
  { id: 'staff_continuity_stability', weight: 0.10 },
  { id: 'development', weight: 0.10 },
  { id: 'game_management', weight: 0.05 }
]);

function emptyInput(def) {
  return {
    value: null,
    observations: 0,
    weighted_evidence: 0,
    reliability: 0,
    source: null,
    last_updated: null,
    configured_weight: def.weight,
    available: false,
    reason: 'not implemented in the Step 2 contract-only plumbing'
  };
}

function emptyTeam(teamKey) {
  const inputs = {};
  for (const def of COMPONENTS) inputs[def.id] = emptyInput(def);

  return {
    coaching_program_schema: SCHEMA,
    coaching_program_team_key: teamKey || null,
    coaching_program_rating: null,
    coaching_program_rank: null,
    coaching_program_reliability: 0,
    coaching_program_adjustment_points: 0,
    coaching_program_inputs: inputs,
    coaching_program_warnings: [{
      id: 'COACHING_PROGRAM_NOT_SCORED',
      severity: 'info',
      detail: 'Coaching / Program Edge contract exists, but no subcomponent has been scored yet.'
    }],
    coaching_program_available: false,
    coaching_program_affects_etsr: false
  };
}

function build(teamKeys) {
  const teams = {};
  for (const key of (teamKeys || [])) teams[key] = emptyTeam(key);
  return {
    schema: SCHEMA,
    status: 'CONTRACT_ONLY',
    affects_etsr: false,
    components: COMPONENTS.map(x => ({ id: x.id, weight: x.weight })),
    teams
  };
}

module.exports = {
  SCHEMA,
  COMPONENTS,
  emptyInput,
  emptyTeam,
  build
};

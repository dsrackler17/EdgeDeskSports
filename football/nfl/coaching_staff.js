/* ============================================================================
   EdgeDesk NFL — COACHING / STAFF research contract.

   RESEARCH-ONLY CALIBRATION LAYER.

   NFL-specific inputs:
     current_residual_conversion 45%
     multi_season_head_coach     30%
     program_persistence         15%
     efficiency_development       5%
     game_management              5%

   Measured inputs may be calibrated against a sufficiently large NFL cohort
   and combined into a reliability-shrunk RESEARCH rating. That rating has zero
   projection influence.

   Missing evidence is unavailable, never a fake neutral 50. No championships,
   salary, career win percentage, media reputation or famous-coach bonus may
   enter the score. A legitimate calibrated league-average observation may be
   50; missing evidence remains null.
   ========================================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;

  var SCHEMA = 'edgedesk_nfl_coaching_staff_v1';
  var MIN_COHORT = 20;
  var RATING_SD = 12;
  var NFL_REGULAR_SEASON_GAMES = 17;

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
    var reason = id === 'game_management'
      ? 'structured fourth-down, timeout or other decision-quality evidence is not ingested; close-game record, penalties and raw timeout counts are not accepted as coaching-quality proxies'
      : 'not implemented in the Step 1 contract-only plumbing';
    return {
      id: id,
      label: meta.label,
      configured_weight: meta.weight,
      value: null,
      raw_value: null,
      calibrated_z: null,
      observations: 0,
      weighted_evidence: null,
      reliability: 0,
      source: null,
      last_updated: null,
      available: false,
      reason: reason
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
      coaching_staff_raw_score: null,
      coaching_staff_rank: null,
      coaching_staff_rank_of: null,
      coaching_staff_reliability: 0,
      coaching_staff_observed_weight: 0,
      coaching_staff_candidate_adjustment_points: null,
      coaching_staff_adjustment_points: 0,
      coaching_staff_affects_nfl_projection: false,
      coaching_staff_inputs: inputs,
      coaching_staff_warnings: [{
        id: 'NFL_COACHING_STAFF_NOT_CALIBRATED',
        severity: 'info',
        detail: 'NFL Coaching / Staff has no league-calibrated input with positive reliability for this team yet.'
      }],
      coaching_staff_available: false
    };
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function mean(xs) {
    if (!xs.length) return null;
    return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
  }

  function sd(xs) {
    if (!xs.length) return null;
    var m = mean(xs);
    var v = xs.reduce(function (s, x) {
      var d = x - m;
      return s + d * d;
    }, 0) / xs.length;
    return Math.sqrt(v);
  }

  function r1(x) {
    return typeof x === 'number' && isFinite(x) ? Math.round(x * 10) / 10 : null;
  }

  function r3(x) {
    return typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 1000 : null;
  }

  function reliabilityFor(id, evidenceRow) {
    if (!evidenceRow) return 0;
    var observations = Number(evidenceRow.observations) || 0;
    if (!(observations > 0)) return 0;

    if (id === 'current_residual_conversion') {
      return clamp(observations / NFL_REGULAR_SEASON_GAMES, 0, 1);
    }
    if (id === 'multi_season_head_coach' || id === 'program_persistence') {
      var seasons = Number(evidenceRow.season_count) || 0;
      if (!(seasons >= 2)) return 0;
      return clamp(observations / (NFL_REGULAR_SEASON_GAMES * seasons), 0, 1);
    }
    if (id === 'efficiency_development') {
      var games = Number(evidenceRow.games_available) || observations;
      return clamp(games / NFL_REGULAR_SEASON_GAMES, 0, 1);
    }
    return 0;
  }

  function calibrateInputAcrossLeague(teamKeys, teams, inputId, evidenceTeams) {
    var values = [];
    (teamKeys || []).forEach(function (team) {
      var row = teams[team] && teams[team].coaching_staff_inputs[inputId];
      if (row && row.available === true && typeof row.value === 'number' && isFinite(row.value)) {
        values.push(row.value);
      }
    });

    var cohort = values.length;
    var mu = mean(values);
    var sigma = sd(values);
    var usable = cohort >= MIN_COHORT && typeof sigma === 'number' && isFinite(sigma) && sigma > 0;

    (teamKeys || []).forEach(function (team) {
      var input = teams[team] && teams[team].coaching_staff_inputs[inputId];
      if (!input || input.available !== true || typeof input.value !== 'number' || !isFinite(input.value)) return;

      var raw = input.value;
      input.raw_value = raw;
      if (!usable) {
        input.value = null;
        input.calibrated_z = null;
        input.weighted_evidence = null;
        input.reliability = 0;
        input.available = false;
        input.reason = cohort < MIN_COHORT
          ? 'league calibration requires at least ' + MIN_COHORT + ' teams with measured evidence'
          : 'league calibration requires non-zero cross-team variance';
        return;
      }

      var z = (raw - mu) / sigma;
      var ev = evidenceTeams && evidenceTeams[team] ? evidenceTeams[team] : null;
      var rel = reliabilityFor(inputId, ev);
      input.calibrated_z = r3(z);
      input.value = r1(clamp(50 + RATING_SD * z, 0, 100));
      input.reliability = r3(rel);
      input.weighted_evidence = r3(z * rel);
      input.calibration = {
        cohort_teams: cohort,
        mean_raw: r3(mu),
        sd_raw: r3(sigma),
        rating_sd: RATING_SD,
        minimum_cohort: MIN_COHORT
      };
      if (!(rel > 0)) {
        input.available = false;
        input.reason = 'measured evidence exists, but sample coverage is insufficient for positive reliability';
      }
    });

    return {
      input: inputId,
      cohort_teams: cohort,
      mean_raw: r3(mu),
      sd_raw: r3(sigma),
      usable: usable
    };
  }

  function finalizeTeam(teamRow) {
    var used = [];
    var observedWeight = 0;
    var rawWeighted = 0;
    var reliabilityWeighted = 0;

    Object.keys(INPUTS).forEach(function (id) {
      var meta = INPUTS[id];
      var x = teamRow.coaching_staff_inputs[id];
      if (!x || x.available !== true || typeof x.value !== 'number' || !isFinite(x.value) ||
          !(typeof x.reliability === 'number' && x.reliability > 0)) return;
      observedWeight += meta.weight;
      rawWeighted += meta.weight * clamp(x.value, 0, 100);
      reliabilityWeighted += meta.weight * clamp(x.reliability, 0, 1);
      used.push({
        id: id,
        value: r1(x.value),
        configured_weight: meta.weight,
        normalized_weight: null,
        reliability: r3(x.reliability),
        reliability_contribution: r3(meta.weight * x.reliability)
      });
    });

    if (!(observedWeight > 0) || !used.length) {
      teamRow.coaching_staff_rating = null;
      teamRow.coaching_staff_raw_score = null;
      teamRow.coaching_staff_reliability = 0;
      teamRow.coaching_staff_observed_weight = 0;
      teamRow.coaching_staff_available = false;
      return teamRow;
    }

    var raw = rawWeighted / observedWeight;
    var reliability = clamp(reliabilityWeighted, 0, 1);
    var finalScore = clamp(50 + (raw - 50) * reliability, 0, 100);
    used.forEach(function (u) { u.normalized_weight = r3(u.configured_weight / observedWeight); });

    teamRow.coaching_staff_raw_score = r1(raw);
    teamRow.coaching_staff_rating = r1(finalScore);
    teamRow.coaching_staff_reliability = r3(reliability);
    teamRow.coaching_staff_observed_weight = r3(observedWeight);
    teamRow.coaching_staff_available = true;
    teamRow.coaching_staff_rank = null;
    teamRow.coaching_staff_candidate_adjustment_points = null;
    teamRow.coaching_staff_adjustment_points = 0;
    teamRow.coaching_staff_affects_nfl_projection = false;
    teamRow.coaching_staff_reliability_details = {
      observed_configured_weight: r3(observedWeight),
      missing_configured_weight: r3(1 - observedWeight),
      contributions: used,
      raw_score: r1(raw),
      final_score: r1(finalScore),
      reliability: r3(reliability),
      formula: '50 + (raw_score - 50) * coaching_staff_reliability',
      weighting_basis: 'configured weights are renormalized across calibrated measured inputs; missing inputs reduce total reliability and never become neutral 50s'
    };
    teamRow.coaching_staff_warnings = [{
      id: 'NFL_COACHING_STAFF_RESEARCH_ONLY',
      severity: 'info',
      detail: 'The NFL Coaching / Staff rating is league-calibrated and reliability-shrunk for research only. Projection adjustment remains exactly zero until separate walk-forward validation promotes it.'
    }];
    if (observedWeight < 1) {
      teamRow.coaching_staff_warnings.push({
        id: 'NFL_COACHING_STAFF_PARTIAL_COVERAGE',
        severity: 'info',
        detail: 'Unmeasured or uncalibrated inputs were excluded from the raw score and reduced total reliability by their missing configured weight.'
      });
    }
    return teamRow;
  }

  function copyEvidenceContext(input, evidenceRow) {
    if (!input || !evidenceRow) return input;
    var observations = Number(evidenceRow.observations);
    if (isFinite(observations) && observations >= 0) input.observations = observations;
    if (evidenceRow.source) input.source = evidenceRow.source;
    if (evidenceRow.last_updated) input.last_updated = evidenceRow.last_updated;
    if (typeof evidenceRow.value === 'number' && isFinite(evidenceRow.value)) {
      input.raw_value = evidenceRow.value;
    }
    if (evidenceRow.reason) input.reason = evidenceRow.reason;
    return input;
  }

  function applyCurrentResidualEvidence(teamRow, evidenceRow) {
    if (!teamRow || !teamRow.coaching_staff_inputs) return teamRow;
    var input = teamRow.coaching_staff_inputs.current_residual_conversion;
    copyEvidenceContext(input, evidenceRow);
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.raw_value = evidenceRow.value;
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
    copyEvidenceContext(input, evidenceRow);
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0) ||
        !(Number(evidenceRow.season_count) >= 2)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.raw_value = evidenceRow.value;
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
    copyEvidenceContext(input, evidenceRow);
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0) ||
        !(Number(evidenceRow.season_count) >= 2)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.raw_value = evidenceRow.value;
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
    copyEvidenceContext(input, evidenceRow);
    if (!input || !evidenceRow || evidenceRow.available !== true ||
        typeof evidenceRow.value !== 'number' || !isFinite(evidenceRow.value) ||
        !(Number(evidenceRow.observations) > 0)) {
      return teamRow;
    }

    input.value = evidenceRow.value;
    input.raw_value = evidenceRow.value;
    input.observations = Number(evidenceRow.observations);
    input.source = evidenceRow.source || 'nflverse stats_team_week weekly team stats';
    input.last_updated = evidenceRow.last_updated || null;
    input.available = true;
    input.reason = null;
    return teamRow;
  }

  function assignResearchRanks(teamKeys, teams) {
    var ranked = (teamKeys || []).map(function (team) {
      return teams[team];
    }).filter(function (row) {
      return row && row.coaching_staff_available === true &&
        typeof row.coaching_staff_rating === 'number' && isFinite(row.coaching_staff_rating);
    }).sort(function (a, b) {
      if (b.coaching_staff_rating !== a.coaching_staff_rating) {
        return b.coaching_staff_rating - a.coaching_staff_rating;
      }
      return String(a.team || '').localeCompare(String(b.team || ''));
    });

    var prev = null;
    var rank = 0;
    ranked.forEach(function (row, i) {
      if (prev == null || row.coaching_staff_rating !== prev) rank = i + 1;
      row.coaching_staff_rank = rank;
      row.coaching_staff_rank_of = ranked.length;
      prev = row.coaching_staff_rating;
    });
    return ranked.length;
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

    var calibration = {
      current_residual_conversion: calibrateInputAcrossLeague(teamKeys, teams, 'current_residual_conversion', currentResidualTeams),
      multi_season_head_coach: calibrateInputAcrossLeague(teamKeys, teams, 'multi_season_head_coach', headCoachTeams),
      program_persistence: calibrateInputAcrossLeague(teamKeys, teams, 'program_persistence', programTeams),
      efficiency_development: calibrateInputAcrossLeague(teamKeys, teams, 'efficiency_development', efficiencyTeams)
    };

    var hasRating = false;
    (teamKeys || []).forEach(function (team) {
      finalizeTeam(teams[team]);
      if (teams[team].coaching_staff_available) hasRating = true;
    });
    var rankedTeams = assignResearchRanks(teamKeys, teams);

    return {
      schema: SCHEMA,
      status: hasRating ? 'RESEARCH_ONLY' : (hasEvidence ? 'EVIDENCE_ONLY' : 'CONTRACT_ONLY'),
      affects_nfl_projection: false,
      calibration: calibration,
      ranked_teams: rankedTeams,
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
    MIN_COHORT: MIN_COHORT,
    RATING_SD: RATING_SD,
    NFL_REGULAR_SEASON_GAMES: NFL_REGULAR_SEASON_GAMES,
    blankInput: blankInput,
    emptyTeam: emptyTeam,
    copyEvidenceContext: copyEvidenceContext,
    applyCurrentResidualEvidence: applyCurrentResidualEvidence,
    applyHeadCoachEvidence: applyHeadCoachEvidence,
    applyProgramPersistenceEvidence: applyProgramPersistenceEvidence,
    applyEfficiencyDevelopmentEvidence: applyEfficiencyDevelopmentEvidence,
    reliabilityFor: reliabilityFor,
    calibrateInputAcrossLeague: calibrateInputAcrossLeague,
    finalizeTeam: finalizeTeam,
    assignResearchRanks: assignResearchRanks,
    build: build
  };

  root.EDNFLCoachingStaff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

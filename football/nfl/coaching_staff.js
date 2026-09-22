/* ============================================================================
   EdgeDesk NFL — COACHING / STAFF research component.

   PURPOSE
   -------
   Measure repeatable team/staff performance that the existing NFL projection
   did not explain. This is NOT a coach reputation table. No championships,
   salary, media reputation, career win percentage or famous-name bonus enters
   the score.

   LIVE EVIDENCE
   -------------
   A completed game contributes only AFTER its pregame EdgeDesk projection was
   frozen. Residual = actual home margin - pregame projected home margin.
   Half of that residual is credited to the home team and half (opposite sign)
   to the away team. That keeps the two-team accounting symmetric.

   NFL-SPECIFIC CONTRACT
   ---------------------
   current_residual_conversion 45%  current season unexplained performance
   multi_season_head_coach     30%  historical same-HC residual, if supplied
   program_persistence         15%  franchise residual prior, if supplied
   efficiency_development       5%  structured development signal, if supplied
   game_management              5%  only when clean PBP evidence exists

   Missing inputs are unavailable, never neutral 50. Observed weights are
   renormalized, then total reliability is reduced by the fraction of the
   configured model actually observed. The published score shrinks toward 50.

   This module deliberately DOES NOT move the NFL projection. Promotion is a
   separate validation decision.
   ========================================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;

  var SCHEMA = 'edgedesk_nfl_coaching_staff_v1';
  var INPUTS = Object.freeze({
    current_residual_conversion: { label: 'Current residual conversion', weight: 0.45 },
    multi_season_head_coach: { label: 'Multi-season head-coach residual', weight: 0.30 },
    program_persistence: { label: 'Program persistence', weight: 0.15 },
    efficiency_development: { label: 'Efficiency development', weight: 0.05 },
    game_management: { label: 'Game management', weight: 0.05 }
  });
  var CONFIG = Object.freeze({
    residual_reliability_k: 8,
    rating_points_per_z: 12,
    affects_nfl_projection: false,
    candidate_max_point_adjustment: 0,
    basis: 'Measured and ranked as research. It does not affect the NFL projection until NFL-specific walk-forward validation promotes a non-zero cap.'
  });

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
  function r1(x) { return isNum(x) ? Math.round(x * 10) / 10 : null; }

  function blankInput(id, reason) {
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
      reason: reason || 'no measured evidence is available'
    };
  }

  function newState(seed) {
    return {
      schema: SCHEMA,
      teams: {},
      seed: seed || null,
      observed_games: 0
    };
  }

  function teamState(st, team) {
    if (!st.teams[team]) {
      st.teams[team] = {
        team: team,
        coach: null,
        observations: 0,
        residual_sum: 0,
        residual_sq_sum: 0,
        last_updated: null
      };
    }
    return st.teams[team];
  }

  function observeTeam(st, team, coach, residual, at) {
    if (!team || !isNum(residual)) return;
    var t = teamState(st, team);
    t.coach = coach || t.coach || null;
    t.observations += 1;
    t.residual_sum += residual;
    t.residual_sq_sum += residual * residual;
    t.last_updated = at || t.last_updated || null;
  }

  function observeGame(st, row) {
    if (!st || !row || !row.home || !row.away
      || !isNum(row.pregame_home_margin) || !isNum(row.actual_home_margin)) {
      return { observed: false, reason: 'home, away, pregame_home_margin and actual_home_margin are required' };
    }
    var residual = row.actual_home_margin - row.pregame_home_margin;
    var half = residual / 2;
    observeTeam(st, row.home, row.home_coach, half, row.at);
    observeTeam(st, row.away, row.away_coach, -half, row.at);
    st.observed_games += 1;
    return { observed: true, residual: r3(residual), home_evidence: r3(half), away_evidence: r3(-half) };
  }

  function seedInput(id, seed, key, coach) {
    var out = blankInput(id);
    if (!seed) return out;
    var src = seed[key];
    if (!src || !isNum(src.rating)) return out;
    if (id === 'multi_season_head_coach' && src.coach && coach && src.coach !== coach) {
      out.reason = 'historical head-coach evidence belongs to a different coach';
      return out;
    }
    out.value = clamp(src.rating, 0, 100);
    out.observations = isNum(src.observations) ? src.observations : 0;
    out.weighted_evidence = isNum(src.weighted_evidence) ? src.weighted_evidence : null;
    out.reliability = clamp(isNum(src.reliability) ? src.reliability : 0, 0, 1);
    out.source = src.source || null;
    out.last_updated = src.last_updated || null;
    out.available = out.reliability > 0;
    out.reason = out.available ? null : 'seed evidence has zero reliability';
    return out;
  }

  function finalize(st, opts) {
    opts = opts || {};
    var seeds = opts.seeds || (st && st.seed) || {};
    var ids = Object.keys((st && st.teams) || {});
    var means = [];
    ids.forEach(function (team) {
      var t = st.teams[team];
      if (t.observations > 0) means.push(t.residual_sum / t.observations);
    });
    var mu = means.length ? means.reduce(function (a, b) { return a + b; }, 0) / means.length : null;
    var sd = null;
    if (means.length >= 2) {
      var ss = means.reduce(function (a, x) { var d = x - mu; return a + d * d; }, 0);
      sd = Math.sqrt(ss / (means.length - 1));
      if (!(sd > 1e-9)) sd = null;
    }

    var out = {};
    ids.forEach(function (team) {
      var t = st.teams[team], input = {}, current = blankInput('current_residual_conversion');
      if (t.observations > 0 && isNum(mu) && isNum(sd)) {
        var avg = t.residual_sum / t.observations;
        var z = (avg - mu) / sd;
        current.value = clamp(50 + CONFIG.rating_points_per_z * z, 0, 100);
        current.observations = t.observations;
        current.weighted_evidence = r3(avg);
        current.reliability = clamp(t.observations / (t.observations + CONFIG.residual_reliability_k), 0, 1);
        current.source = 'EdgeDesk leak-free pregame NFL projection residuals';
        current.last_updated = t.last_updated;
        current.available = current.reliability > 0;
        current.reason = null;
      } else if (t.observations > 0) {
        current.observations = t.observations;
        current.weighted_evidence = r3(t.residual_sum / t.observations);
        current.source = 'EdgeDesk leak-free pregame NFL projection residuals';
        current.last_updated = t.last_updated;
        current.reason = 'cross-team residual dispersion is not yet measurable';
      }
      input.current_residual_conversion = current;

      var s = seeds[team] || {};
      input.multi_season_head_coach = seedInput('multi_season_head_coach', s, 'head_coach', t.coach);
      input.program_persistence = seedInput('program_persistence', s, 'program', t.coach);
      input.efficiency_development = seedInput('efficiency_development', s, 'development', t.coach);
      input.game_management = seedInput('game_management', s, 'game_management', t.coach);

      var observedWeight = 0, weighted = 0, weightedRel = 0;
      Object.keys(INPUTS).forEach(function (id) {
        var x = input[id], w = INPUTS[id].weight;
        if (x.available && isNum(x.value) && x.reliability > 0) {
          observedWeight += w;
          weighted += w * x.value;
          weightedRel += w * x.reliability;
        }
      });

      var raw = observedWeight > 0 ? weighted / observedWeight : null;
      var rel = observedWeight > 0 ? (weightedRel / observedWeight) * observedWeight : 0;
      rel = clamp(rel, 0, 1);
      var rating = isNum(raw) ? 50 + (raw - 50) * rel : null;
      var warnings = [];
      Object.keys(INPUTS).forEach(function (id) {
        if (!input[id].available) warnings.push({
          id: id + '_unavailable',
          detail: input[id].label + ': ' + (input[id].reason || 'unavailable')
        });
      });
      if (rating == null) warnings.unshift({
        id: 'no_publishable_score',
        detail: 'No measured input with positive reliability is available; no neutral 50 is substituted.'
      });

      out[team] = {
        schema: SCHEMA,
        team: team,
        coach: t.coach || null,
        coaching_staff_rating: r1(rating),
        coaching_staff_raw_score: r1(raw),
        coaching_staff_reliability: r3(rel),
        coaching_staff_observed_weight: r3(observedWeight),
        coaching_staff_available: rating != null,
        coaching_staff_rank: null,
        coaching_staff_affects_projection: false,
        coaching_staff_adjustment_points: 0,
        coaching_staff_inputs: input,
        coaching_staff_warnings: warnings,
        provenance: {
          source: 'EdgeDesk NFL pregame residual ledger + explicitly supplied historical staff seeds',
          last_updated: t.last_updated,
          observations: t.observations,
          reliability: r3(rel),
          affects_projection: false,
          limitations: 'HC identity is observable from nflverse games.csv. OC/DC history, private locker-room dynamics, scheme-install quality, trust and ownership/front-office context are not inferred.'
        }
      };
    });

    var ranked = Object.keys(out).filter(function (k) { return isNum(out[k].coaching_staff_rating); })
      .sort(function (a, b) {
        return out[b].coaching_staff_rating - out[a].coaching_staff_rating || a.localeCompare(b);
      });
    ranked.forEach(function (k, i) { out[k].coaching_staff_rank = i + 1; });

    return {
      schema: SCHEMA,
      status: 'RESEARCH_ONLY',
      affects_projection: false,
      observed_games: st ? st.observed_games : 0,
      cross_section: { teams: means.length, residual_mean: r3(mu), residual_sd: r3(sd) },
      teams: out,
      config: CONFIG
    };
  }

  var API = {
    SCHEMA: SCHEMA,
    INPUTS: INPUTS,
    CONFIG: CONFIG,
    newState: newState,
    observeGame: observeGame,
    finalize: finalize,
    blankInput: blankInput
  };

  root.EDNflCoachingStaff = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();

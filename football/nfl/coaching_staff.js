/* ============================================================================
   EdgeDesk NFL — Coaching / Staff residual layer.

   PURPOSE
     Measure persistent head-coach signal left AFTER the NFL football model has
     priced opponent-adjusted EPA, quarterback, rest and game context.

   WHAT THIS IS NOT
     No reputation, championships, salary, career win percentage, media grade
     or famous-coach bonus enters this module. The only live identity input is
     nflverse's home_coach / away_coach field. Coordinator identity is not in
     the current source and is therefore unavailable rather than invented.

   HONESTY
     - Unknown coach => unavailable. Never a fake neutral rating.
     - A game updates the coach state only AFTER its pregame number exists.
     - The residual target is actual margin minus the BASE football model,
       never actual margin minus the market.
     - The market never enters this state. It is a validation benchmark only.
     - affects_model defaults false unless a generated validation artifact
       explicitly promotes a fitted configuration.

   Runs in browser and node.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDNFLCoachingStaff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_nfl_coaching_staff_v1';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
  function clone(x) { return JSON.parse(JSON.stringify(x == null ? null : x)); }
  function coachKey(x) {
    if (x == null) return null;
    var s = String(x).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
    return s || null;
  }

  function config(doc) {
    doc = doc || {};
    var c = doc.config || doc;
    return {
      enabled: c.enabled === true,
      affects_model: c.affects_model === true,
      alpha: isNum(c.alpha) ? c.alpha : null,
      shrink_k: isNum(c.shrink_k) ? c.shrink_k : null,
      season_carry: isNum(c.season_carry) ? c.season_carry : null,
      evidence_carry: isNum(c.evidence_carry) ? c.evidence_carry : null,
      max_point_adjustment: isNum(c.max_point_adjustment) ? c.max_point_adjustment : null,
      effect_sd: isNum(c.effect_sd) ? c.effect_sd : null,
      trained_through_season: isNum(c.trained_through_season) ? c.trained_through_season : null,
      validation_status: c.validation_status || 'RESEARCH_ONLY',
      source: c.source || null,
      version: c.version || 'nfl_coaching_staff_v1'
    };
  }

  function validConfig(c) {
    return !!(c && c.enabled
      && isNum(c.alpha) && c.alpha > 0 && c.alpha <= 1
      && isNum(c.shrink_k) && c.shrink_k >= 0
      && isNum(c.season_carry) && c.season_carry >= 0 && c.season_carry <= 1
      && isNum(c.evidence_carry) && c.evidence_carry >= 0 && c.evidence_carry <= 1
      && isNum(c.max_point_adjustment) && c.max_point_adjustment >= 0);
  }

  function newState(doc) {
    doc = doc || {};
    var c = config(doc);
    var seeds = doc.seeds || {};
    var coaches = {};
    for (var k in seeds) if (Object.prototype.hasOwnProperty.call(seeds, k)) {
      var key = coachKey(k), s = seeds[k] || {};
      if (!key) continue;
      coaches[key] = {
        value: isNum(s.value) ? s.value : 0,
        evidence: isNum(s.evidence) ? Math.max(0, s.evidence) : 0,
        observations: isNum(s.observations) ? Math.max(0, s.observations) : 0,
        last_season: isNum(s.last_season) ? s.last_season : null
      };
    }
    return {
      schema: SCHEMA,
      config: c,
      coaches: coaches,
      season: isNum(doc.season) ? doc.season : c.trained_through_season,
      warnings: validConfig(c) ? [] : [
        'NFL Coaching / Staff has no validated fitted configuration loaded; it is research-only and moves zero points.'
      ]
    };
  }

  function reliability(st, row) {
    var c = st && st.config;
    if (!c || !isNum(c.shrink_k) || !row || !isNum(row.evidence) || row.evidence <= 0) return 0;
    if (c.shrink_k === 0) return 1;
    return clamp(row.evidence / (row.evidence + c.shrink_k), 0, 1);
  }

  function view(st, name) {
    var key = coachKey(name);
    var row = key && st && st.coaches ? st.coaches[key] : null;
    if (!key) return {
      available: false, coach: null, rating: null, reliability: 0,
      effect_points: null, observations: 0, reason: 'coach identity unavailable'
    };
    if (!row || !(row.observations > 0) || !(row.evidence > 0)) return {
      available: false, coach: key, rating: null, reliability: 0,
      effect_points: null, observations: row ? row.observations : 0,
      reason: 'no pregame-safe residual observations for this coach'
    };
    var rel = reliability(st, row);
    var effect = row.value * rel;
    var sd = st && st.config ? st.config.effect_sd : null;
    return {
      available: true,
      coach: key,
      rating: isNum(sd) && sd > 0 ? r3(clamp(50 + 12 * (effect / sd), 1, 99)) : null,
      reliability: r3(rel),
      effect_points: r3(effect),
      raw_effect_points: r3(row.value),
      evidence: r3(row.evidence),
      observations: row.observations,
      last_season: row.last_season,
      source: st.config.source || null,
      reason: null
    };
  }

  function matchup(st, homeCoach, awayCoach) {
    var h = view(st, homeCoach), a = view(st, awayCoach);
    var c = st ? st.config : null;
    var out = {
      available: false,
      home: h,
      away: a,
      raw_difference_points: null,
      candidate_adjustment_points: null,
      applied_adjustment_points: 0,
      affects_model: false,
      max_point_adjustment: c && isNum(c.max_point_adjustment) ? c.max_point_adjustment : null,
      validation_status: c ? c.validation_status : 'RESEARCH_ONLY',
      warnings: []
    };
    if (!c || !validConfig(c)) {
      out.warnings.push('no fitted NFL Coaching / Staff configuration is loaded');
      return out;
    }
    if (!h.available || !a.available) {
      out.warnings.push('both head coaches need pregame-safe evidence; missing coach evidence is not filled with a neutral value');
      return out;
    }
    var raw = h.effect_points - a.effect_points;
    out.available = true;
    out.raw_difference_points = r3(raw);
    out.candidate_adjustment_points = r3(clamp(raw, -c.max_point_adjustment, c.max_point_adjustment));
    out.affects_model = c.affects_model === true && c.validation_status === 'VALIDATED';
    out.applied_adjustment_points = out.affects_model ? out.candidate_adjustment_points : 0;
    if (!out.affects_model) out.warnings.push('Measured and ranked as research, but not currently an NFL model input.');
    return out;
  }

  function seasonBreak(st, nextSeason) {
    if (!st || !st.config || !validConfig(st.config)) {
      if (st) st.season = isNum(nextSeason) ? nextSeason : st.season;
      return st;
    }
    var c = st.config;
    for (var k in st.coaches) if (Object.prototype.hasOwnProperty.call(st.coaches, k)) {
      var row = st.coaches[k];
      row.value *= c.season_carry;
      row.evidence *= c.evidence_carry;
    }
    st.season = isNum(nextSeason) ? nextSeason : (isNum(st.season) ? st.season + 1 : null);
    return st;
  }

  function absorb(st, game, baseSpread, actualMargin, season) {
    if (!st || !st.config || !validConfig(st.config)) return {
      updated: false, reason: 'no fitted configuration'
    };
    var hc = coachKey(game && game.home_coach), ac = coachKey(game && game.away_coach);
    if (!hc || !ac) return {
      updated: false, reason: 'both head-coach identities are required to assign a symmetric residual'
    };
    if (!isNum(baseSpread) || !isNum(actualMargin)) return {
      updated: false, reason: 'base spread or realised margin unavailable'
    };
    var residual = actualMargin - baseSpread;
    var alpha = st.config.alpha;
    function one(key, target) {
      var row = st.coaches[key] || (st.coaches[key] = {
        value: 0, evidence: 0, observations: 0, last_season: null
      });
      row.value = (1 - alpha) * row.value + alpha * target;
      row.evidence += 1;
      row.observations += 1;
      row.last_season = isNum(season) ? season : (isNum(st.season) ? st.season : null);
    }
    /* If the true latent matchup residual is H - A, moving each coach halfway
       in opposite directions changes that difference by alpha * residual. */
    one(hc, residual / 2);
    one(ac, -residual / 2);
    return {
      updated: true,
      residual_points: r3(residual),
      home_coach: hc,
      away_coach: ac,
      source: 'realised margin minus pregame base NFL model; market excluded'
    };
  }

  function exportSeeds(st) {
    var out = {};
    if (!st || !st.coaches) return out;
    for (var k in st.coaches) if (Object.prototype.hasOwnProperty.call(st.coaches, k)) {
      var r = st.coaches[k];
      out[k] = {
        value: r3(r.value),
        evidence: r3(r.evidence),
        observations: r.observations,
        last_season: r.last_season
      };
    }
    return out;
  }

  return {
    SCHEMA: SCHEMA,
    coachKey: coachKey,
    config: config,
    validConfig: validConfig,
    newState: newState,
    reliability: reliability,
    view: view,
    matchup: matchup,
    seasonBreak: seasonBreak,
    absorb: absorb,
    exportSeeds: exportSeeds
  };
});

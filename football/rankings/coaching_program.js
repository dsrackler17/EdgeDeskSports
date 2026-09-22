/* ============================================================================
   COACHING / PROGRAM EDGE

   STEP 3: measurable talent conversion + multi-season overperformance.

   This layer is intentionally RESEARCH-ONLY. It does not move ETSR yet and it
   does not publish a final coaching/program rating yet. Step 5 owns the final
   reliability/shrinkage calculation.

   Missing evidence is NULL, never a fake 50. A real residual can legitimately
   land at 50 because 50 means league-average measured conversion, not missing.
   ========================================================================== */
'use strict';

const SCHEMA = 'edgedesk_coaching_program_v1';
const MIN_COHORT = 20;
const RATING_SD = 12;
const HOME_AWAY_RELIABILITY_FACTOR = 0.90;

const COMPONENTS = Object.freeze([
  { id: 'talent_conversion', weight: 0.35 },
  { id: 'multi_season_program_overperformance', weight: 0.25 },
  { id: 'roster_management_retention', weight: 0.15 },
  { id: 'staff_continuity_stability', weight: 0.10 },
  { id: 'development', weight: 0.10 },
  { id: 'game_management', weight: 0.05 }
]);

const DECAY = Object.freeze([0.45, 0.30, 0.17, 0.08]);

function isNum(x) { return typeof x === 'number' && isFinite(x); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function r1(x) { return isNum(x) ? Math.round(x * 10) / 10 : null; }
function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function sd(a) {
  if (!a.length) return null;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length;
  return Math.sqrt(v);
}
function cov(a, b) {
  if (!a.length || a.length !== b.length) return null;
  const ma = mean(a), mb = mean(b);
  return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / a.length;
}
function configured(id) {
  return COMPONENTS.find(x => x.id === id);
}

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
    reason: 'not implemented or no qualifying structured evidence is available'
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
      id: 'COACHING_PROGRAM_FINAL_SCORE_NOT_ENABLED',
      severity: 'info',
      detail: 'Measured subcomponents may exist, but final reliability/shrinkage and ETSR impact are not enabled yet.'
    }],
    coaching_program_available: false,
    coaching_program_affects_etsr: false
  };
}

/* --------------------------------------------------------------------------
   ONE SEASON: PERFORMANCE RELATIVE TO TALENT EXPECTATION

   performance.net_z_before_reliability is already opponent-adjusted by the
   rankings performance engine. That means the response variable is not raw
   wins or margin and is already corrected for the strength of the teams faced.

   Expectation is fitted cross-sectionally, every season:
     performance_z = intercept + beta_talent * talent_z
   Then, where returning-production VALUE exists, the remaining residual is
   partially adjusted by a second league-fitted coefficient. No coefficient is
   chosen because a coach is famous, highly paid or won something.

   Home/away is not yet a structured covariate in this ratings layer. Rather
   than pretending otherwise, the component says so and carries a reliability
   haircut until that context is measurable.
   -------------------------------------------------------------------------- */
function seasonTalentConversion(season, layer, allow) {
  const out = { season, available: false, teams: {}, model: null, warnings: [] };
  if (allow === false) {
    out.warnings.push('current-season conversion disabled for reconstructed backfill because today\'s player artifact would leak future roster information');
    return out;
  }
  const talent = layer && layer.talent ? layer.talent : {};
  const perf = layer && layer.performance ? layer.performance : {};
  const keys = Object.keys(talent).filter(k => {
    const t = talent[k], p = perf[k];
    return t && p && isNum(t.rating) && isNum(p.net_z_before_reliability);
  });
  if (keys.length < MIN_COHORT) {
    out.warnings.push('fewer than ' + MIN_COHORT + ' FBS teams have both talent and opponent-adjusted performance evidence');
    return out;
  }

  const tVals = keys.map(k => talent[k].rating);
  const tMean = mean(tVals), tSd = sd(tVals);
  if (!(tSd > 0)) {
    out.warnings.push('talent has no usable league-wide variance');
    return out;
  }
  const x = keys.map(k => (talent[k].rating - tMean) / tSd);
  const y = keys.map(k => perf[k].net_z_before_reliability);
  const vx = cov(x, x);
  const betaTalent = vx > 0 ? cov(x, y) / vx : null;
  if (!isNum(betaTalent)) {
    out.warnings.push('talent expectation regression could not be fitted');
    return out;
  }
  const intercept = mean(y);
  const baseResidual = {};
  keys.forEach((k, i) => { baseResidual[k] = y[i] - (intercept + betaTalent * x[i]); });

  const retKeys = keys.filter(k => talent[k].returning && isNum(talent[k].returning.value_continuity));
  let betaReturning = null, retMean = null, retSd = null;
  if (retKeys.length >= MIN_COHORT) {
    const rv = retKeys.map(k => talent[k].returning.value_continuity);
    retMean = mean(rv); retSd = sd(rv);
    if (retSd > 0) {
      const rx = retKeys.map(k => (talent[k].returning.value_continuity - retMean) / retSd);
      const rr = retKeys.map(k => baseResidual[k]);
      const vr = cov(rx, rx);
      if (vr > 0) betaReturning = cov(rx, rr) / vr;
    }
  }

  const adjusted = {};
  for (const k of keys) {
    let resid = baseResidual[k];
    const ret = talent[k].returning && talent[k].returning.value_continuity;
    if (isNum(betaReturning) && isNum(ret) && retSd > 0) resid -= betaReturning * ((ret - retMean) / retSd);
    adjusted[k] = resid;
  }
  const residualVals = keys.map(k => adjusted[k]);
  const residualMean = mean(residualVals), residualSd = sd(residualVals);
  if (!(residualSd > 0)) {
    out.warnings.push('conversion residual has no usable league-wide variance');
    return out;
  }

  for (const k of keys) {
    const p = perf[k], t = talent[k];
    const residualZ = (adjusted[k] - residualMean) / residualSd;
    const retAvailable = !!(t.returning && isNum(t.returning.value_continuity));
    const baseRel = isNum(p.reliability) ? clamp(p.reliability, 0, 1) : 0;
    const contextFactor = HOME_AWAY_RELIABILITY_FACTOR * (retAvailable ? 1 : 0.92);
    const reliability = clamp(baseRel * contextFactor, 0, 1);
    const games = p.sample && isNum(p.sample.games) ? p.sample.games
      : (p.sample && isNum(p.sample.games_played) ? p.sample.games_played : 0);
    out.teams[k] = {
      value: r1(clamp(50 + RATING_SD * residualZ, 0, 100)),
      observations: games,
      weighted_evidence: r3(residualZ * reliability),
      reliability: r3(reliability),
      source: 'football/rankings/performance.js opponent-adjusted performance + football/rankings/talent.js roster talent',
      last_updated: null,
      configured_weight: configured('talent_conversion').weight,
      available: true,
      reason: null,
      details: {
        season,
        performance_z: r3(p.net_z_before_reliability),
        expected_performance_z: r3(p.net_z_before_reliability - adjusted[k]),
        residual_z: r3(residualZ),
        talent_rating: r1(t.rating),
        returning_value_continuity: retAvailable ? r3(t.returning.value_continuity) : null,
        cohort_teams: keys.length,
        model: {
          intercept: r3(intercept),
          beta_talent: r3(betaTalent),
          beta_returning: r3(betaReturning)
        },
        context: {
          opponent_strength_and_schedule: 'opponent-adjusted performance fixed point',
          returning_production: retAvailable ? 'measured' : 'unavailable',
          home_away: 'not yet a structured covariate; reliability reduced rather than guessed'
        }
      }
    };
  }

  out.available = true;
  out.model = {
    cohort_teams: keys.length,
    intercept: r3(intercept),
    beta_talent: r3(betaTalent),
    beta_returning: r3(betaReturning),
    returning_cohort_teams: retKeys.length,
    residual_sd: r3(residualSd)
  };
  if (!isNum(betaReturning)) out.warnings.push('returning-production coefficient unavailable; residual uses talent expectation only where the league fit cannot support it');
  out.warnings.push('home/away is not yet an explicit covariate; reliability is reduced rather than inventing a correction');
  return out;
}

function multiSeason(teamKey, currentSeason, seasonModels) {
  const evidence = [];
  let observedWeight = 0;
  for (let offset = 0; offset < DECAY.length; offset++) {
    const season = currentSeason - offset;
    const m = seasonModels[season];
    const row = m && m.teams ? m.teams[teamKey] : null;
    if (!row || !row.available || !row.details || !isNum(row.details.residual_z)) continue;
    evidence.push({ season, configured_weight: DECAY[offset], row });
    observedWeight += DECAY[offset];
  }
  const base = emptyInput(configured('multi_season_program_overperformance'));
  if (!evidence.length || !(observedWeight > 0)) return base;

  let z = 0, rel = 0, observations = 0;
  const seasons = [];
  for (const e of evidence) {
    const w = e.configured_weight / observedWeight;
    z += e.row.details.residual_z * w;
    rel += e.row.reliability * w;
    observations += e.row.observations || 0;
    seasons.push({
      season: e.season,
      configured_weight: e.configured_weight,
      normalized_weight: r3(w),
      residual_z: e.row.details.residual_z,
      conversion_rating: e.row.value,
      reliability: e.row.reliability,
      observations: e.row.observations
    });
  }
  rel = clamp(rel * observedWeight, 0, 1);
  return {
    value: r1(clamp(50 + RATING_SD * z, 0, 100)),
    observations,
    weighted_evidence: r3(z * rel),
    reliability: r3(rel),
    source: 'time-decayed talent-conversion residuals from the rankings performance and talent layers',
    last_updated: null,
    configured_weight: configured('multi_season_program_overperformance').weight,
    available: true,
    reason: null,
    details: {
      residual_z: r3(z),
      observed_decay_weight: r3(observedWeight),
      missing_decay_weight: r3(1 - observedWeight),
      seasons
    }
  };
}

function build(teamKeys, opts) {
  opts = opts || {};
  const keys = teamKeys || [];
  const currentSeason = +opts.season;
  const layers = opts.seasons || {};
  const seasonModels = {};

  if (isFinite(currentSeason)) {
    for (let offset = 0; offset < DECAY.length; offset++) {
      const season = currentSeason - offset;
      if (!layers[season]) continue;
      const allow = !(offset === 0 && opts.allow_current === false);
      seasonModels[season] = seasonTalentConversion(season, layers[season], allow);
    }
  }

  const teams = {};
  let measured = 0;
  for (const key of keys) {
    const t = emptyTeam(key);
    const cur = seasonModels[currentSeason] && seasonModels[currentSeason].teams
      ? seasonModels[currentSeason].teams[key] : null;
    if (cur) {
      t.coaching_program_inputs.talent_conversion = cur;
      measured++;
    }
    const ms = multiSeason(key, currentSeason, seasonModels);
    if (ms.available) {
      t.coaching_program_inputs.multi_season_program_overperformance = ms;
      measured++;
    }
    if (cur || ms.available) {
      t.coaching_program_warnings.push({
        id: 'COACHING_PROGRAM_PARTIAL_MEASUREMENT',
        severity: 'info',
        detail: 'Talent conversion and multi-season overperformance are measured; roster management, staff continuity, development, game management and final shrinkage are not implemented yet.'
      });
    }
    teams[key] = t;
  }

  return {
    schema: SCHEMA,
    status: measured ? 'PARTIAL_RESEARCH' : 'CONTRACT_ONLY',
    affects_etsr: false,
    final_score_enabled: false,
    components: COMPONENTS.map(x => ({ id: x.id, weight: x.weight })),
    decay_weights: DECAY.slice(),
    season_models: seasonModels,
    teams
  };
}

module.exports = {
  SCHEMA,
  COMPONENTS,
  DECAY,
  emptyInput,
  emptyTeam,
  seasonTalentConversion,
  multiSeason,
  build
};

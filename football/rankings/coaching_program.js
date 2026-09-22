/* ============================================================================
   COACHING / PROGRAM EDGE

   MEASURED COMPONENT LAYER: subcomponents + final reliability shrinkage.

   This module owns the measured coaching/program score. The outer rankings
   pipeline owns national ranks, immutable history and the optional ETSR point
   translation. That translation remains research-only until walk-forward
   validation explicitly promotes it.

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
    coaching_program_raw_score: null,
    coaching_program_rank: null,
    coaching_program_reliability: 0,
    coaching_program_observed_weight: 0,
    coaching_program_adjustment_points: 0,
    coaching_program_inputs: inputs,
    coaching_program_reliability_details: {
      observed_configured_weight: 0,
      missing_configured_weight: 1,
      contributions: [],
      formula: '50 + (raw_score - 50) * coaching_program_reliability'
    },
    coaching_program_warnings: [{
      id: 'COACHING_PROGRAM_NO_USABLE_SCORE',
      severity: 'info',
      detail: 'No measured subcomponent with positive reliability is available, so no coaching/program score is published.'
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


/* --------------------------------------------------------------------------
   ROSTER MANAGEMENT / RETENTION

   The score uses retained VALUE, returning STARTERS and net transfer VALUE.
   Raw portal volume is never a positive input. Headcount churn is published as
   context only; a team cannot improve this score by simply processing more
   transactions.
   -------------------------------------------------------------------------- */
function transferFacts(t) {
  if (!t) return null;
  if (isNum(t.in) || isNum(t.out)) {
    return {
      in_count: isNum(t.in) ? t.in : 0,
      out_count: isNum(t.out) ? t.out : 0,
      value_in: isNum(t.value_in) ? t.value_in : null,
      value_out: isNum(t.value_out) ? t.value_out : null,
      net_value: isNum(t.net_value) ? t.net_value : null,
      starters_in: isNum(t.starters_in) ? t.starters_in : 0,
      starters_out: isNum(t.starters_out) ? t.starters_out : 0,
      unknown_in: isNum(t.unknown_in) ? t.unknown_in : 0
    };
  }
  const tin = t.in || {}, tout = t.out || {};
  return {
    in_count: isNum(tin.count) ? tin.count : 0,
    out_count: isNum(tout.count) ? tout.count : 0,
    value_in: isNum(tin.value) ? tin.value : null,
    value_out: isNum(tout.value) ? tout.value : null,
    net_value: isNum(t.net_value) ? t.net_value : null,
    starters_in: Array.isArray(tin.starter_level) ? tin.starter_level.length : 0,
    starters_out: Array.isArray(tout.starter_level) ? tout.starter_level.length : 0,
    unknown_in: Array.isArray(tin.high_uncertainty) ? tin.high_uncertainty.length : 0
  };
}

function starterRetention(ret) {
  const by = ret && ret.by_group;
  if (!by) return { value: null, starters: 0, groups: 0 };
  let s = 0, n = 0, groups = 0;
  for (const g of Object.keys(by)) {
    const b = by[g];
    if (!b || !isNum(b.starters) || !(b.starters > 0) || !isNum(b.starters_returning)) continue;
    s += clamp(b.starters_returning, 0, 1) * b.starters;
    n += b.starters;
    groups++;
  }
  return { value: n > 0 ? s / n : null, starters: n, groups };
}

function leagueZ(rows, field) {
  const vals = Object.keys(rows).map(k => rows[k][field]).filter(isNum);
  const m = mean(vals), s = sd(vals);
  return { mean: m, sd: s, n: vals.length, usable: vals.length >= MIN_COHORT && s > 0 };
}

function rosterManagement(keys, rosterByTeam, lastUpdated, allow) {
  const out = {};
  const raw = {};
  if (allow === false) {
    for (const k of keys) {
      const e = emptyInput(configured('roster_management_retention'));
      e.reason = 'disabled for reconstructed history because the committed current roster artifact would leak later-season personnel information';
      out[k] = e;
    }
    return out;
  }

  for (const k of keys) {
    const r = rosterByTeam && rosterByTeam[k];
    const ret = r && r.returning;
    const tx = transferFacts(r && r.transfers);
    const sr = starterRetention(ret);
    raw[k] = {
      value_continuity: ret && isNum(ret.value_continuity) ? ret.value_continuity : null,
      roster_continuity: ret && isNum(ret.roster_continuity) ? ret.roster_continuity : null,
      players_prior: ret && isNum(ret.players_prior) ? ret.players_prior : 0,
      players_returning: ret && isNum(ret.players_returning) ? ret.players_returning : 0,
      starter_retention: sr.value,
      starters_observed: sr.starters,
      starter_groups: sr.groups,
      transfer_net_value: tx && isNum(tx.net_value) ? tx.net_value : null,
      transfer: tx
    };
  }

  const stats = {
    value_continuity: leagueZ(raw, 'value_continuity'),
    starter_retention: leagueZ(raw, 'starter_retention'),
    transfer_net_value: leagueZ(raw, 'transfer_net_value')
  };

  for (const k of keys) {
    const r = raw[k];
    const parts = [];
    const rels = [];
    function add(id, field, reliability) {
      const st = stats[field], v = r[field];
      if (!isNum(v) || !st.usable) return;
      const z = (v - st.mean) / st.sd;
      parts.push({ id, value: r3(v), z: r3(z), cohort_teams: st.n });
      rels.push(clamp(reliability, 0, 1));
    }

    add('meaningful_production_retained', 'value_continuity', r.players_prior > 0 ? 1 : 0);
    add('returning_starters', 'starter_retention', r.starters_observed > 0 ? clamp(r.starters_observed / 22, 0, 1) : 0);
    const tx = r.transfer;
    const transferKnown = tx && tx.in_count > 0
      ? clamp(1 - tx.unknown_in / tx.in_count, 0, 1)
      : (tx ? 1 : 0);
    add('net_transfer_value', 'transfer_net_value', transferKnown);

    const e = emptyInput(configured('roster_management_retention'));
    if (!parts.length) {
      e.reason = 'retention/portal evidence exists for too few FBS teams to standardise this component';
      out[k] = e;
      continue;
    }
    const z = mean(parts.map(p => p.z));
    const coverage = parts.length / 3;
    const reliability = clamp(coverage * mean(rels), 0, 1);
    e.value = r1(clamp(50 + RATING_SD * z, 0, 100));
    e.observations = r.players_prior + r.starters_observed
      + (tx ? tx.in_count + tx.out_count : 0);
    e.weighted_evidence = r3(z * reliability);
    e.reliability = r3(reliability);
    e.source = 'football/players/current.json returning-production and transfer-value records';
    e.last_updated = lastUpdated || null;
    e.available = true;
    e.reason = null;
    e.details = {
      residual_z: r3(z),
      scored_parts: parts,
      meaningful_production_retained: r3(r.value_continuity),
      roster_continuity_context_only: r3(r.roster_continuity),
      starter_retention: r3(r.starter_retention),
      starters_observed: r.starters_observed,
      transfer: tx,
      portal_volume_scored: false,
      churn_count_context_only: tx ? tx.in_count + tx.out_count : null,
      positional_replacement: 'not scored: the committed team artifact does not retain transfer value by position group',
      basis: 'league-standardised retained production value, returning starters and net transfer value; raw portal volume is context only'
    };
    out[k] = e;
  }
  return out;
}

/* --------------------------------------------------------------------------
   DEVELOPMENT

   Same athlete, same programme, consecutive seasons. Current raw quality is
   regressed on prior raw quality across the FBS returning-player population.
   A team's score is the evidence-weighted residual, so signing a better
   transfer cannot masquerade as player development.
   -------------------------------------------------------------------------- */
function rawQuality(p) {
  return p && p.components && p.components.quality && isNum(p.components.quality.z_raw)
    ? p.components.quality.z_raw : null;
}

function developmentModel(currentSeason, layers, lastUpdated) {
  const out = { available: false, teams: {}, model: null, warnings: [] };
  const cur = layers && layers[currentSeason] && layers[currentSeason].players;
  const prev = layers && layers[currentSeason - 1] && layers[currentSeason - 1].players;
  if (!cur || !prev) {
    out.warnings.push('consecutive-season player records are unavailable');
    return out;
  }

  const prevByKey = {};
  for (const team of Object.keys(prev)) {
    for (const p of (prev[team] || [])) {
      if (!p || !p.key) continue;
      prevByKey[p.key] = { team, player: p };
    }
  }

  const pairs = [];
  for (const team of Object.keys(cur)) {
    for (const p of (cur[team] || [])) {
      if (!p || !p.key) continue;
      const old = prevByKey[p.key];
      if (!old || old.team !== team) continue;
      if (p.mid_season_move || old.player.mid_season_move) continue;
      const x = rawQuality(old.player), y = rawQuality(p);
      if (!isNum(x) || !isNum(y)) continue;
      const conf = Math.min(isNum(p.confidence) ? p.confidence : 0, isNum(old.player.confidence) ? old.player.confidence : 0);
      const sample = Math.min(isNum(p.sample_size) ? p.sample_size : 0, isNum(old.player.sample_size) ? old.player.sample_size : 0);
      if (!(conf > 0) || !(sample > 0)) continue;
      pairs.push({
        team, key: p.key, group: p.group || old.player.group || null,
        prior_z: x, current_z: y, confidence: conf, sample,
        weight: Math.sqrt(sample) * conf
      });
    }
  }

  if (pairs.length < 40) {
    out.warnings.push('fewer than 40 same-program returning players have measurable quality in consecutive seasons');
    return out;
  }

  const xs = pairs.map(p => p.prior_z), ys = pairs.map(p => p.current_z);
  const vx = cov(xs, xs);
  const beta = vx > 0 ? cov(xs, ys) / vx : null;
  if (!isNum(beta)) {
    out.warnings.push('returning-player development regression could not be fitted');
    return out;
  }
  const intercept = mean(ys) - beta * mean(xs);
  for (const p of pairs) p.residual = p.current_z - (intercept + beta * p.prior_z);
  const rs = pairs.map(p => p.residual), rm = mean(rs), rsd = sd(rs);
  if (!(rsd > 0)) {
    out.warnings.push('returning-player development residual has no usable variance');
    return out;
  }
  for (const p of pairs) p.residual_z = (p.residual - rm) / rsd;

  function aggregate(list) {
    let sw = 0, sz = 0, sc = 0;
    for (const p of list) {
      sw += p.weight;
      sz += p.residual_z * p.weight;
      sc += p.confidence * p.weight;
    }
    if (!(sw > 0)) return null;
    return { z: sz / sw, confidence: sc / sw, observations: list.length, evidence_weight: sw };
  }
  function groupDetail(list, name, predicate) {
    const a = aggregate(list.filter(predicate));
    return a ? {
      value: r1(clamp(50 + RATING_SD * a.z, 0, 100)),
      residual_z: r3(a.z), observations: a.observations,
      evidence_confidence: r3(a.confidence)
    } : { value: null, residual_z: null, observations: 0, evidence_confidence: 0,
      reason: name + ' has no same-program returning player with measurable consecutive-season quality' };
  }

  const byTeam = {};
  for (const p of pairs) (byTeam[p.team] = byTeam[p.team] || []).push(p);
  for (const team of Object.keys(byTeam)) {
    const list = byTeam[team];
    const a = aggregate(list);
    if (!a) continue;
    const sampleRel = list.length / (list.length + 8);
    const reliability = clamp(sampleRel * a.confidence, 0, 1);
    out.teams[team] = {
      value: r1(clamp(50 + RATING_SD * a.z, 0, 100)),
      observations: list.length,
      weighted_evidence: r3(a.z * reliability),
      reliability: r3(reliability),
      source: 'football/players/epir.js same-athlete raw quality across consecutive seasons',
      last_updated: lastUpdated || null,
      configured_weight: configured('development').weight,
      available: true,
      reason: null,
      details: {
        residual_z: r3(a.z),
        regression: { intercept: r3(intercept), beta_prior_quality: r3(beta), league_pairs: pairs.length },
        qb: groupDetail(list, 'QB development', p => p.group === 'QB'),
        ol: groupDetail(list, 'OL development', p => p.group === 'OL'),
        defense: groupDetail(list, 'defensive development', p => ['DL', 'EDGE', 'LB', 'CB', 'S', 'DB'].includes(p.group)),
        transfer_credit: false,
        basis: 'same-player, same-program improvement relative to a league regression on the player\'s prior raw quality; evidence is weighted by prior/current sample and confidence'
      }
    };
  }

  out.available = true;
  out.model = { pairs: pairs.length, intercept: r3(intercept), beta_prior_quality: r3(beta), residual_sd: r3(rsd) };
  return out;
}

/* --------------------------------------------------------------------------
   STAFF CONTINUITY / STABILITY

   The current public source knows the HC only. Continuity is evidence, not a
   directional coaching-quality claim, so this remains unscored until a
   walk-forward validates an effect. OC/DC are explicitly unknown.
   -------------------------------------------------------------------------- */
function staffEvidence(keys, artifact) {
  const out = {};
  const valid = artifact && artifact.by_team ? artifact : null;
  for (const k of keys) {
    const e = emptyInput(configured('staff_continuity_stability'));
    const r = valid && valid.by_team[k];
    if (!r) {
      e.reason = valid
        ? 'no corroborated head-coach row for this team; OC/DC are unavailable in the source'
        : 'coaching continuity artifact unavailable or stale';
      out[k] = e;
      continue;
    }
    const known = Array.isArray(r.known) ? r.known.length : 0;
    e.observations = known;
    e.weighted_evidence = 0;
    e.reliability = r3(clamp(known / 3, 0, 1));
    e.source = r.source || artifact.source || null;
    e.last_updated = artifact.generated_at || null;
    e.available = false;
    e.reason = 'head-coach continuity is observed, but continuity is not automatically positive or negative; coordinator continuity is unavailable, so no directional staff score is published';
    e.details = {
      hc: r.hc || null,
      since_season: r.since_season == null ? null : r.since_season,
      tenure_seasons: r.tenure_seasons == null ? null : r.tenure_seasons,
      tenure_is_floor: r.tenure_is_floor == null ? null : r.tenure_is_floor,
      previous_hc: r.previous_hc || null,
      new_hc: r.new_hc == null ? null : r.new_hc,
      new_oc: null,
      new_dc: null,
      known: r.known || [],
      unknown: r.unknown || ['oc', 'dc'],
      in_season_change: r.in_season_change || null,
      directional_score_applied: false
    };
    out[k] = e;
  }
  return out;
}


/* --------------------------------------------------------------------------
   STEP 5 — FINAL RELIABILITY + SHRINKAGE

   Raw score:
     configured component weights, renormalized across measured inputs only.

   Reliability:
     sum(configured_weight * component_reliability) across measured inputs.
     Because the complete configured weight sums to 1.00, missing components
     automatically reduce total reliability instead of becoming fake neutral
     observations.

   Final:
     50 + (raw_score - 50) * reliability

   This publishes a research score only. Rank and ETSR impact remain disabled
   until their own steps.
   -------------------------------------------------------------------------- */
function finalizeTeam(team) {
  const inputs = team && team.coaching_program_inputs ? team.coaching_program_inputs : {};
  const used = [];
  let observedWeight = 0;
  let rawWeighted = 0;
  let totalReliability = 0;

  for (const def of COMPONENTS) {
    const x = inputs[def.id];
    if (!x || x.available !== true || !isNum(x.value) || !isNum(x.reliability) || !(x.reliability > 0)) continue;
    const reliability = clamp(x.reliability, 0, 1);
    observedWeight += def.weight;
    rawWeighted += def.weight * clamp(x.value, 0, 100);
    totalReliability += def.weight * reliability;
    used.push({
      id: def.id,
      value: r1(clamp(x.value, 0, 100)),
      configured_weight: def.weight,
      normalized_weight: null,
      reliability: r3(reliability),
      reliability_contribution: r3(def.weight * reliability)
    });
  }

  if (!(observedWeight > 0) || !used.length) {
    team.coaching_program_rating = null;
    team.coaching_program_raw_score = null;
    team.coaching_program_reliability = 0;
    team.coaching_program_observed_weight = 0;
    team.coaching_program_available = false;
    team.coaching_program_reliability_details = {
      observed_configured_weight: 0,
      missing_configured_weight: 1,
      contributions: [],
      formula: '50 + (raw_score - 50) * coaching_program_reliability'
    };
    return team;
  }

  const raw = rawWeighted / observedWeight;
  const reliability = clamp(totalReliability, 0, 1);
  const finalScore = clamp(50 + (raw - 50) * reliability, 0, 100);
  for (const u of used) u.normalized_weight = r3(u.configured_weight / observedWeight);

  team.coaching_program_raw_score = r1(raw);
  team.coaching_program_rating = r1(finalScore);
  team.coaching_program_reliability = r3(reliability);
  team.coaching_program_observed_weight = r3(observedWeight);
  team.coaching_program_available = true;
  team.coaching_program_rank = null;
  team.coaching_program_adjustment_points = 0;
  team.coaching_program_affects_etsr = false;
  team.coaching_program_reliability_details = {
    observed_configured_weight: r3(observedWeight),
    missing_configured_weight: r3(1 - observedWeight),
    contributions: used,
    raw_score: r1(raw),
    final_score: r1(finalScore),
    reliability: r3(reliability),
    formula: '50 + (raw_score - 50) * coaching_program_reliability',
    weighting_basis: 'configured weights are renormalized across measured components; missing components contribute zero reliability rather than a neutral score'
  };
  team.coaching_program_warnings = [{
    id: 'COACHING_PROGRAM_RESEARCH_ONLY',
    severity: 'info',
    detail: 'The coaching/program score is measured and reliability-shrunk. National ranking is assigned by the rankings pipeline; ETSR influence is controlled separately by the validation-gated coachingProgram config.'
  }];
  if (observedWeight < 1) {
    team.coaching_program_warnings.push({
      id: 'COACHING_PROGRAM_PARTIAL_COVERAGE',
      severity: 'info',
      detail: 'Unmeasured components were excluded from the raw score and reduced total reliability by their missing configured weight.'
    });
  }
  return team;
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

  const roster = rosterManagement(
    keys,
    layers[currentSeason] && layers[currentSeason].roster,
    opts.roster_last_updated,
    opts.allow_current !== false
  );
  const development = developmentModel(currentSeason, layers, opts.development_last_updated);
  const staff = staffEvidence(keys, opts.allow_current === false ? null : opts.staff);

  const teams = {};
  let measured = 0, scored = 0;
  for (const key of keys) {
    const t = emptyTeam(key);
    let teamMeasured = false;
    const cur = seasonModels[currentSeason] && seasonModels[currentSeason].teams
      ? seasonModels[currentSeason].teams[key] : null;
    if (cur) {
      t.coaching_program_inputs.talent_conversion = cur;
      measured++;
      teamMeasured = true;
    }

    const ms = multiSeason(key, currentSeason, seasonModels);
    if (ms.available) {
      t.coaching_program_inputs.multi_season_program_overperformance = ms;
      measured++;
      teamMeasured = true;
    }

    if (roster[key]) {
      t.coaching_program_inputs.roster_management_retention = roster[key];
      if (roster[key].available) { measured++; teamMeasured = true; }
    }

    if (staff[key]) t.coaching_program_inputs.staff_continuity_stability = staff[key];

    if (development.teams[key]) {
      t.coaching_program_inputs.development = development.teams[key];
      measured++;
      teamMeasured = true;
    }

    const gm = emptyInput(configured('game_management'));
    gm.source = 'cfbfastR play-by-play; no validated decision-state model is implemented';
    gm.reason = 'unavailable: the current play-by-play layer does not yet cleanly identify coach decisions, alternatives and counterfactual win value, so no game-management grade is invented';
    t.coaching_program_inputs.game_management = gm;

    if (teamMeasured) {
      t.coaching_program_warnings.push({
        id: 'COACHING_PROGRAM_PARTIAL_MEASUREMENT',
        severity: 'info',
        detail: 'Measured inputs are available; staff continuity remains evidence-only and game management remains unavailable.'
      });
    }
    teams[key] = finalizeTeam(t);
    if (teams[key].coaching_program_available) scored++;
  }

  return {
    schema: SCHEMA,
    status: scored ? 'SCORED_RESEARCH' : (measured ? 'PARTIAL_RESEARCH' : 'CONTRACT_ONLY'),
    affects_etsr: false,
    final_score_enabled: true,
    components: COMPONENTS.map(x => ({ id: x.id, weight: x.weight })),
    decay_weights: DECAY.slice(),
    season_models: seasonModels,
    development_model: development.model,
    development_warnings: development.warnings,
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
  rosterManagement,
  developmentModel,
  staffEvidence,
  finalizeTeam,
  build
};

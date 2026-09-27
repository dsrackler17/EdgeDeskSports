#!/usr/bin/env node
/* ============================================================================
   CANONICAL FBS POWER RATING -> LEGACY APP CONTRACT

   The national rankings pipeline (football/rankings/current.json) is the one
   canonical answer to "how good is this FBS team?" It reads every completed
   game, opponent-adjusted play-level performance, roster/player quality,
   continuity, portal movement, depth and verified availability.

   app.html predates that pipeline and reads football/rating/current.json.
   Recomputing a second rating for that endpoint created two truths. This file
   ends that: it is an ADAPTER, not a model. Every team rating in the output is
   the source team's ETSR byte-for-byte. The old shape survives only so the
   existing UI does not need a four-megabyte rewrite to consume the new source.

   IMPORTANT:
     * home field is zero here because ETSR is a NEUTRAL-FIELD rating.
     * market data is never an input.
     * unavailable/unknown injury evidence is never converted to healthy.
     * the production spread engine remains separate until ETSR's point scale
       has a measured walk-forward calibration. The compatibility file says so.

   Run:
     node football/rating/sync_rankings.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FBS = require('../fbs/fbs.js');

const HERE = __dirname;
const SOURCE = path.join(HERE, '..', 'rankings', 'current.json');
const OUT = path.join(HERE, 'current.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function r2(v) {
  return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : null;
}
function r3(v) {
  return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
}
function digestOf(o) {
  return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);
}
function z50(v) {
  return (typeof v === 'number' && isFinite(v)) ? r2((v - 50) / 12) : null;
}
function component(t, id) {
  const a = t && t.talent && Array.isArray(t.talent.components) ? t.talent.components : [];
  return a.find(x => x && x.id === id) || null;
}
function conferenceMeta(label) {
  const c = FBS.conference(label || '');
  return c ? { id: c.id, label: c.label, group: c.tier || 'other' }
    : { id: null, label: label || null, group: 'other' };
}

/* Availability is already inside the source talent rating. This function
   exposes its approximate FINAL ETSR contribution relative to neutral (50)
   for explanation only. Because every transform in this path is linear, it is
   exact whenever the dedicated availability component exists. Partial
   evidence can still move a named player's unit while this dedicated component
   remains null; in that case we return null rather than pretending the rest of
   the roster is known healthy. */
function availabilityPoints(t) {
  const a = component(t, 'availability');
  if (!a || typeof a.value !== 'number') return null;
  const parts = (t.talent && t.talent.components) || [];
  const ws = parts.reduce((s, x) => s + ((x && typeof x.w === 'number') ? x.w : 0), 0);
  if (!(ws > 0)) return null;

  const deltaTalentRating = (a.value - 50) * a.w / ws;
  const ppz = t.scalars && t.scalars.talent_points_per_z;
  if (!(typeof ppz === 'number' && isFinite(ppz))) return null;
  const deltaTalentPoints = deltaTalentRating / 12 * ppz;

  const carried = t.prior && t.prior.parts && t.prior.parts.coefficient;
  const talentShareOfPrior = (typeof carried === 'number' && isFinite(carried))
    ? Math.max(0, 1 - carried) : 1;
  const priorWeight = t.weights && typeof t.weights.prior === 'number'
    ? t.weights.prior : 1;
  return r2(deltaTalentPoints * talentShareOfPrior * priorWeight);
}

/* THE TERM strip_availability REMOVES: the whole availability effect on the
   final ETSR, not its distance from a neutral 50. The talent rating is a
   weighted mean renormalised over the components present, so scoring the
   availability component also re-weights the other five; "with minus
   without" removes both, which makes a stripped rating equal to the same
   roster's rating with no availability evidence at all — whether the roster
   was fully covered, healthy, or missing a named starter. Computed from the
   published components so the two halves share their rounding. */
function availabilityContribution(t) {
  const a = component(t, 'availability');
  if (!a || typeof a.value !== 'number' || typeof a.w !== 'number') return null;
  const parts = (t.talent && t.talent.components) || [];
  let ss = 0, ws = 0;
  for (const x of parts) {
    if (x && typeof x.value === 'number' && typeof x.w === 'number') { ss += x.value * x.w; ws += x.w; }
  }
  const wsOthers = ws - a.w;
  if (!(ws > 0) || !(wsOthers > 0)) return null;
  const deltaTalentRating = ss / ws - (ss - a.value * a.w) / wsOthers;
  const ppz = t.scalars && t.scalars.talent_points_per_z;
  if (!(typeof ppz === 'number' && isFinite(ppz))) return null;
  const carried = t.prior && t.prior.parts && t.prior.parts.coefficient;
  const talentShareOfPrior = (typeof carried === 'number' && isFinite(carried)) ? Math.max(0, 1 - carried) : 1;
  const priorWeight = t.weights && typeof t.weights.prior === 'number' ? t.weights.prior : 1;
  return r2(deltaTalentRating / 12 * ppz * talentShareOfPrior * priorWeight);
}

function rosterParts(t) {
  const out = [];
  const push = (name, value, rating) => {
    if (value == null && rating == null) return;
    out.push({ name, value: value == null ? '—' : value, z: z50(rating) });
  };

  push('starter quality',
    t.talent && t.talent.starter_quality != null ? r2(t.talent.starter_quality) + '/100' : null,
    t.talent && t.talent.starter_quality);
  push('depth quality',
    t.talent && t.talent.depth_quality != null ? r2(t.talent.depth_quality) + '/100' : null,
    t.talent && t.talent.depth_quality);

  const ret = t.talent && t.talent.returning;
  const retComp = component(t, 'returning_value');
  push('returning production value',
    ret && ret.value_continuity != null ? Math.round(ret.value_continuity * 100) + '%' : null,
    retComp && retComp.value);

  const tx = t.talent && t.talent.transfers;
  const txComp = component(t, 'transfer_value');
  push('portal value',
    tx && tx.index != null ? r2(tx.index) + '/100' : null,
    txComp && txComp.value);

  const av = t.availability || (t.talent && t.talent.availability);
  const avComp = component(t, 'availability');
  if (avComp && avComp.value != null) {
    const pct = av && av.out_share != null ? Math.round(av.out_share * 100) + '% expected starter value unavailable' : 'verified availability';
    push('availability', pct, avComp.value);
  }
  return out;
}

function teamRow(t, src) {
  const cm = conferenceMeta(t.conference);
  const perf = t.performance || {};
  const sample = perf.sample || {};
  const prior = t.prior || {};
  const priorParts = prior.parts || {};
  const av = t.availability || (t.talent && t.talent.availability) || {};
  const avPts = availabilityPoints(t);
  const avContrib = availabilityContribution(t);
  const scalarsMeasured = !!(t.scalars && t.scalars.measured === true);

  const gates = (t.gates || []).map(g => {
    const d = g && (g.detail || g.basis || g.id);
    return d ? String(d) : null;
  }).filter(Boolean);

  const unmeasured = [
    'NIL spending — no public feed carries a complete, auditable team-by-team series; roster and portal movement are measured instead',
    'home field, travel, rest, weather and game-specific matchup effects — ETSR is a neutral-field team-strength rating and those belong in the matchup layer'
  ];
  if (!scalarsMeasured) {
    unmeasured.push('ETSR point-scale calibration — the current talent/performance points-per-z scalars are declared fallbacks, so this power rating is research strength context and is not promoted into spread pricing');
  }
  if (av.rating == null) {
    unmeasured.push('full projected-starter availability — missing or partial evidence stays UNKNOWN and is never converted to healthy');
  }
  for (const g of gates.slice(0, 4)) unmeasured.push('data gate — ' + g);

  const prev = priorParts.prev_etsr;
  const coeff = priorParts.coefficient;
  const carry = (typeof prev === 'number') ? {
    blended_prior: r2(prev),
    seasons: [{ season: src.season - 1, rating: r2(prev), games: null, weight: 1 }],
    measured_weight: (typeof coeff === 'number') ? r3(coeff) : null,
    applied: r2(priorParts.carried_from_last_season)
  } : null;

  return {
    rating: r2(t.etsr),
    core: r2(t.etsr),
    components: {
      results: perf.rating != null || t.performance_points != null ? {
        rating: r2(t.performance_points),
        performance_index: r2(perf.rating),
        offense: r2(perf.offense),
        defense: r2(perf.defense),
        games: sample.games_played != null ? sample.games_played : r2(t.weights && t.weights.games_used),
        fbs_equivalent_games: r2(t.weights && t.weights.games_used),
        weight: r3(t.weights && t.weights.performance)
      } : null,
      carryover: carry,
      roster: {
        points: r2(t.talent_points),
        available: t.talent_points != null,
        parts: rosterParts(t),
        reason: t.talent_points == null ? 'the national rankings build produced no roster-talent points for this team' : null
      },
      availability: {
        points: avPts == null ? 0 : Math.min(0, avPts),
        /* THE SIGNED CONTRIBUTION, which is what strip_availability removes
           (availabilityContribution). `points` above is the display: this
           week's absences as a penalty against a neutral roster, never a
           bonus. A strip that removed only penalties, and only their distance
           from neutral, left a fully covered roster rated differently with and
           without a named OUT starter. */
        contribution: avContrib == null ? 0 : avContrib,
        players: [],
        available: avPts != null && avPts < 0,
        out_share: av.out_share == null ? null : r3(av.out_share),
        unknown_share: av.unknown_share == null ? null : r3(av.unknown_share),
        records: av.records == null ? 0 : av.records,
        basis: av.basis || null
      }
    },
    basis: 'ETSR: opponent-adjusted play-level performance blended with player/roster talent, measured carryover, depth, continuity, portal movement and verified availability',
    confidence: r3(t.confidence && t.confidence.value),
    games_played: sample.games_played == null ? 0 : sample.games_played,
    unmeasured,
    key: t.key,
    canonical_key: t.key,
    team: t.team,
    rank: t.rank == null ? 'unranked' : t.rank,
    division: 'fbs',
    conference: cm.label,
    conference_id: cm.id,
    conference_source: t.conference || null,
    fbs_group: cm.group,
    group_rank: null,
    conference_rank: null,
    source_rating: {
      schema: src.schema,
      etsr: r2(t.etsr),
      performance: r2(perf.rating),
      talent: r2(t.talent && t.talent.rating),
      offense: r2(perf.offense),
      defense: r2(perf.defense),
      special_teams: r2(t.special_teams && t.special_teams.rating),
      confidence: r3(t.confidence && t.confidence.value),
      scalars_measured: scalarsMeasured
    }
  };
}

function addSubRanks(rows) {
  /* rows is already in the canonical national ordering. Sub-ranks are views
     over THAT ordering, not a second rating and not a second sort. A team held
     out of the national rank by a confidence gate still has a power rating and
     still belongs somewhere in its conference/group ordering. */
  const groupN = {}, confN = {};
  rows.forEach(t => {
    const g = t.fbs_group || 'other';
    const c = t.conference_id || 'unknown';
    groupN[g] = (groupN[g] || 0) + 1;
    confN[c] = (confN[c] || 0) + 1;
    t.group_rank = groupN[g];
    t.conference_rank = confN[c];
  });
}

function buildCompatibility(src) {
  if (!src || src.schema !== 'edgedesk_national_rankings_v1' || !src.teams)
    throw new Error('football/rankings/current.json is missing or has an unexpected schema');
  const rows = Object.keys(src.teams).map(k => teamRow(src.teams[k], src));
  rows.sort((a, b) => {
    const ar = typeof a.rank === 'number' ? a.rank : 1e9;
    const br = typeof b.rank === 'number' ? b.rank : 1e9;
    return ar - br || (b.rating || -999) - (a.rating || -999) || a.team.localeCompare(b.team);
  });
  addSubRanks(rows);

  const pairs = (src.carryover && src.carryover.pairs) || [];
  const latest = pairs.length ? pairs[pairs.length - 1] : null;
  const c = src.carryover || {};
  const trend = c.trend;
  const carryNote = c.measured
    ? ('league carryover is measured from consecutive seasons; current multi-season mean '
      + Math.round((c.value || 0) * 100) + '%'
      + (typeof trend === 'number' ? (' · trend ' + (trend >= 0 ? '+' : '') + r3(trend)) : ''))
    : 'carryover could not be measured from the available seasons';

  const out = {
    schema: 'edgedesk_rating_v1',
    version: 2,
    source_schema: src.schema,
    source_version: src.schema_version || null,
    source_digest: src.digest || null,
    source_generated_at: src.generated_at || null,
    season: src.season,
    week: src.week,
    generated_at: src.generated_at || new Date().toISOString(),
    method: {
      results: 'opponent-adjusted play-level performance: success rate, explosiveness, efficiency, sacks, finishing drives and related offense/defense measures, reliability-shrunk for sample size',
      carryover: 'prior-season ETSR scaled by a league carryover slope measured from consecutive seasons and adjusted by team continuity',
      roster: 'player quality, projected starters, rotation, depth, returning production value and transfer value from EdgeDesk player artifacts',
      availability: 'verified current availability changes projected participation; partial evidence changes only the named unit and UNKNOWN is never treated as healthy',
      not_included: [
        'market prices — comparison only, never an input to ETSR',
        'home field, travel, rest, weather and game-specific matchup effects — applied outside the neutral-field power rating',
        'NIL spending — no complete auditable public series is wired'
      ]
    },
    carryover: {
      pairs,
      latest,
      weight: c.value == null ? null : r3(c.value),
      trend: c.trend == null ? null : r3(c.trend),
      note: carryNote
    },
    season_meta: {
      [src.season]: {
        teams: src.team_count,
        games: src.data_freshness && src.data_freshness.completed_games,
        hfa: {
          hfa: 0,
          n: 0,
          basis: 'ETSR is neutral-field by contract. Home advantage belongs in the matchup/pricing layer and is intentionally zero in this compatibility view.'
        }
      }
    },
    seasons_used: src.built_on && src.built_on.seasons_read ? src.built_on.seasons_read : [src.season],
    prior_seasons_applied: pairs.map(p => p.from),
    team_count: rows.length,
    conference_coverage: {
      with_conference: rows.filter(t => !!t.conference_id).length,
      without_conference: rows.filter(t => !t.conference_id).length,
      conferences: rows.reduce((o, t) => {
        const k = t.conference_id || 'unknown';
        o[k] = (o[k] || 0) + 1;
        return o;
      }, {})
    },
    teams: rows,
    calibration: {
      measured: rows.every(t => t.source_rating.scalars_measured === true),
      basis: 'read directly from each ETSR row. Until measured, fallback points-per-z constants remain research-only and do not replace the production spread engine.'
    },
    data_freshness: src.data_freshness || null,
    notes: [
      'This file is a compatibility view. It computes no independent team rating; team.rating equals football/rankings/current.json team.etsr.',
      'Every completed FBS result is read by the rankings pipeline before this adapter runs.',
      'Verified availability can move projected units and team talent. Failed or partial reads never become a healthy roster.',
      'Production spreads still come from the separately walk-forward-tested CFB pricing engine until ETSR point-scale calibration is measured and promoted.'
    ]
  };
  out.digest = digestOf({
    source_digest: out.source_digest,
    season: out.season,
    week: out.week,
    teams: rows.map(t => [t.key, t.rating, t.confidence, t.components.availability.points])
  });
  return out;
}

function writeIfChanged(file, obj) {
  const text = JSON.stringify(obj, null, 1) + '\n';
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (old === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

function main() {
  const src = readJson(SOURCE);
  const out = buildCompatibility(src);
  const changed = writeIfChanged(OUT, out);
  console.log('[power-rating] ' + out.team_count + ' FBS teams · '
    + (out.data_freshness && out.data_freshness.completed_games != null
      ? out.data_freshness.completed_games + ' completed games read · ' : '')
    + 'source ' + out.source_schema + ' · calibration '
    + (out.calibration.measured ? 'MEASURED' : 'FALLBACK / RESEARCH')
    + (changed ? ' · wrote football/rating/current.json' : ' · unchanged'));
  return 0;
}

module.exports = { buildCompatibility, availabilityPoints, availabilityContribution, rosterParts, addSubRanks };

if (require.main === module) {
  try { process.exit(main()); }
  catch (e) {
    console.error('[power-rating] FAILED:', e && e.stack || e);
    process.exit(1);
  }
}

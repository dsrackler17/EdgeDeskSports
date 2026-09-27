/* ============================================================================
   CFB production — the prediction trace (brief §111; docs/cfb-production/CANONICAL.md §10).

   For one game, where every number came from, stage by stage, in the order
   the production pathway made them:

     raw_inputs    the stored V2 row: source file, row state, timestamps, ids,
                   flags, quarterbacks
     features      the feature version, the input contract's verdict, the
                   feature drivers the weekly engine stored, the week's
                   feature-distribution monitor
     submodels     each stacked submodel's margin, its artifact weight, its share
     ensemble      the stacked margin, the weighted sum it must equal, the
                   spread of the submodels, the fair line and total
     calibration   sigma, t degrees of freedom, raw and calibrated win
                   probability (and the weekly engine's own), the intervals,
                   the confidence, the numeric verdict and rounding notes
     market        the market the newest Model Lab snapshot captured: line,
                   books, freshness, integrity verdict, the model-market gap
     decision      the OFFICIAL decision (governed policy) and, apart and
                   labelled, the stage-8 research class
     outcome       degraded modes with their reasons, the fallback level, what a
                   public page may show

   Built by projections.js from what it already holds; no number is made here
   except the per-submodel share (weight x margin), which the contract already
   checks sums to the stacked margin. Readers (admin/cfb-debug) display it.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA = 'cfb_prediction_trace_v1';
const STAGES = ['raw_inputs', 'features', 'submodels', 'ensemble', 'calibration', 'market', 'decision', 'outcome'];
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function r6(x) { return isNum(x) ? Math.round(x * 1e6) / 1e6 : null; }

/* the week's feature-distribution monitor the weekly engine published, if any */
function featureMonitor(season, repo) {
  const p = path.join(repo, 'football', 'cfb_weekly', String(season), 'feature_monitor.json');
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { status: m.status || null, week: m.week != null ? m.week : null, flags: Array.isArray(m.flags) ? m.flags.length : null,
      flagged_features: Array.isArray(m.flags) ? m.flags.slice(0, 8).map((f) => f.feature || f.field || null).filter(Boolean) : [], run_id: m.run_id || null,
      rule: 'flags a feature whose slate distribution leaves its week-of-season training envelope; it never refits or blocks (v2/weekly/contract.py monitor)' };
  } catch (e) { return { status: 'NOT_PUBLISHED', rule: 'the weekly engine writes football/cfb_weekly/<season>/feature_monitor.json on its next run' }; }
}

/* build({ row, snap, params, weights, lab, official, research, resolved, display, source, monitor }) */
function build(o) {
  const row = o.row || null, snap = o.snap || null, P = o.params || {}, W = o.weights || null, L = o.lab || null;
  const proj = (snap && snap.projection) || null;
  const stages = [];
  const add = (stage, data) => stages.push(Object.assign({ stage }, data));
  add('raw_inputs', row ? {
    source: o.source || null, row_state: row.state || null, prediction_ts: row.prediction_ts || null, feature_ts: row.feature_ts || null,
    game_id: String(row.game_id), season: row.season, week: row.week, home: row.home, away: row.away, home_id: row.home_id, away_id: row.away_id,
    kickoff: row.kickoff, neutral_site: !!row.neutral_site, fcs_game: !!row.fcs_game, priced: row.priced !== false, not_priced_reason: row.not_priced_reason || null,
    min_games: row.min_games, weeks_in: row.weeks_in, early_season: !!row.early_season,
    qb: row.qb ? { home: row.qb.home ? { qb_id: row.qb.home.qb_id, exp_rating: row.qb.home.exp_rating, team_rating: row.qb.home.team_rating, backup_rating: row.qb.home.backup_rating } : null,
      away: row.qb.away ? { qb_id: row.qb.away.qb_id, exp_rating: row.qb.away.exp_rating, team_rating: row.qb.away.team_rating, backup_rating: row.qb.away.backup_rating } : null } : null,
    qb_missing_any: row.qb_missing_any, qb_unsettled_any: row.qb_unsettled_any, model_modes: row.model_modes || [],
  } : { missing: 'no V2.1 row for this game' });
  add('features', {
    feature_version: P.feature_version || null,
    contract: snap ? snap.contract : null,
    drivers: row && Array.isArray(row.drivers) ? row.drivers.map((d) => ({ feature: d.feature, points: d.points })) : [],
    drivers_note: 'the largest feature contributions to the stacked margin, in points, as the weekly engine stored them',
    monitor: o.monitor || null,
    enforced_before_inference: 'the weekly engine checks all model inputs against football/cfb_production/contract/input_contract.json before inference; a game with a critical violation is withheld and never reaches this file',
  });
  const comps = row && row.components ? row.components : {};
  const parts = W ? Object.keys(W).map((k) => ({ submodel: k, margin: isNum(comps[k]) ? comps[k] : null, weight: W[k], share: isNum(comps[k]) ? r6(W[k] * comps[k]) : null }))
    : Object.keys(comps).map((k) => ({ submodel: k, margin: comps[k], weight: null, share: null }));
  add('submodels', { submodels: parts, weights_source: W ? 'football/cfb_v2/artifacts/' + (P.model_version || '?') + '/models.json stack_weights' : 'weights unknown for this model version' });
  const wsum = parts.every((p) => isNum(p.share)) && parts.length ? r6(parts.reduce((a, p) => a + p.share, 0)) : null;
  add('ensemble', {
    stacked_margin: row ? row.ens_pred : null, weighted_sum: wsum, difference: wsum !== null && row && isNum(row.ens_pred) ? r6(row.ens_pred - wsum) : null,
    submodel_sd: row ? row.ens_sd : null, rating_sd_sum: row ? row.rating_sd_sum : null,
    projected_margin: proj ? proj.projected_margin : null, fair_spread_home_line: proj ? proj.fair_spread_home_line : null,
    fair_spread_display: proj ? proj.fair_spread_display : null, fair_total: proj ? proj.fair_total : null,
  });
  add('calibration', {
    sigma: proj ? proj.sigma : (row ? row.sigma : null), t_df: proj ? proj.t_df : null,
    home_win_prob_raw: proj ? proj.home_win_prob_raw : null, home_win_prob: proj ? proj.home_win_prob : null,
    weekly_engine_p_home: row ? row.p_home : null,
    engine_vs_weekly: proj && row && isNum(row.p_home) && isNum(proj.home_win_prob) ? r6(proj.home_win_prob - row.p_home) : null,
    intervals: proj ? proj.intervals : null,
    football_prediction_confidence: proj ? proj.football_prediction_confidence : null, confidence_basis: proj ? proj.confidence_basis : null,
    uncertainty_drivers: proj ? proj.uncertainty_drivers : (row ? row.uncertainty_drivers : null),
    numeric: snap ? snap.numeric : null,
  });
  const ir = (L && L.inputs_ref) || {};
  add('market', L ? {
    snapshot_prediction_id: L.prediction_id, snapshot_ts: L.prediction_ts, checkpoint_type: L.checkpoint_type,
    home_line: L.current_spread, market_as_of: L.market_as_of, books: L.sportsbook_count, stale: !!L.market_stale,
    integrity: ir.market_integrity ? { status: ir.market_integrity.status, actionable_status: ir.market_integrity.actionable_status, reasons: ir.market_integrity.reasons || null } : null,
    model_market_gap: L.model_market_gap, gap_note: 'the snapshot\'s margin minus the market margin; + = the model likes HOME',
  } : { missing: 'no Model Lab snapshot of this game at or before as_of' });
  add('decision', { official: o.official || null, research: o.research || null,
    rule: 'the official status comes only from the governed policy cfb_decision_policy_v1; the stage-8 class is research (F-22); the P(positive CLV) tier is a closing-line tendency, not edge quality (F-23); betting is disabled' });
  add('outcome', {
    status: snap ? snap.status : null, reason: snap ? snap.reason : null,
    degraded_modes: snap ? snap.degraded.modes : [], mode_reasons: snap ? snap.degraded.reasons : {},
    fallback_level: snap ? snap.fallback_level : null, resolved: o.resolved || null, display: o.display || null,
    hashes: snap ? { input_hash: snap.input_hash, projection_hash: snap.projection_hash, snapshot_id: snap.snapshot_id, params_sha256: snap.params_sha256 } : null,
  });
  return { schema: SCHEMA, stages };
}

module.exports = { build, featureMonitor, SCHEMA, STAGES };

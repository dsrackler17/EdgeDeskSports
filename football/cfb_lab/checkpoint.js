/* ============================================================================
   CFB Model Lab — take the checkpoint snapshots that are due (METRICS §2-3).

   Every hour: for every game still ahead and every tracked model that has a
   projection for it, record at most one snapshot — the checkpoint whose
   window contains hours-to-kickoff right now, if this model does not have it
   yet. Nothing is back-filled; a missed window stays missed.

   A snapshot is the model's pure projection and state, the market exactly as
   the lab had captured it at that instant, and the decision the model's own
   rule makes against that market. The row is hashed and appended; it is
   never edited.

   PRODUCTION SAFETY (docs/cfb-production/MARKET_INTEGRITY.md, SETTLEMENT.md):
   - every snapshot carries the market's integrity verdict
     (inputs_ref.market_integrity: OK / DEGRADED / INVALID / MISSING and the
     actionable status) and, when the gap or the cover probability is extreme,
     the integrity review; a BET is downgraded to PASS (fail closed) unless the
     market is ACTIONABLE and any required review passed. Football numbers are
     never touched.
   - ESPN's own schedule this hour is the kickoff authority: a game it reports
     postponed, canceled, suspended, in progress or finished is not
     snapshotted (a game that started early never gets a "pregame" row), and a
     moved kickoff is used for the window of a NEW snapshot (old snapshots keep
     the kickoff they were taken against).
   - a game moved by more than 36 h is a rescheduled game: its old windows are
     not reused; the windows of the new schedule are recorded as ADHOC
     snapshots (never official), because one game id holds one row per
     checkpoint.

     node football/cfb_lab/checkpoint.js [--season 2026] [--now ISO] [--models v1,v2.1,c001]
     node football/cfb_lab/checkpoint.js --adhoc --game <id> --model <version>
     node football/cfb_lab/checkpoint.js --import-freeze     (V2 Tuesday freezes -> WEEKLY_FREEZE)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const M = require('./models.js');
const GOV = require('./governance.js');
const I = require('./integrity.js');
const ID = require('./identity.js');
const DIS = require('../../lib/cfb_disagreement.js');
const CANON = require('../cfb_production/canonical.js');

const U = L.util;
const HORIZON_H = 24 * 10;      // the board and current.json publish ~10 days ahead
/* EVENT-TRIGGERED SNAPSHOTS (brief §3): inside the checkpoint zone, a V2 row
   whose canonical inputs changed since the game's last LIVE snapshot (a
   correction, a re-freeze) is recorded at once as an ADHOC row that names the
   row it supersedes: a new version, never an edit. Earlier than 72 h the
   provisional rows change daily by design and the next window records them. */
const EVENT_H = 72;

function roleOf(roles, mv) { const r = roles[mv]; return r ? r.role : 'candidate'; }

/* THE MAJOR-DISAGREEMENT GATE, judged at the snapshot (lib/cfb_disagreement.js).
   V1 only: its football inputs travel in the slate artifact
   (slateGame.disagreement_inputs, football/fbs/build_coverage.js) and the
   market is the one this snapshot captured. The independent submodels are the
   V2 projections the lab loaded for the same game. Nothing here moves a
   projection; a gate that cannot run leaves the fields null. */
function submodelsFor(models, gameId) {
  const out = { source: 'the Model Lab’s V2 projections', projections: {}, ensemble: null, ensemble_sd: null };
  for (const m of models || []) {
    const q = m.projections && m.projections.get(String(gameId));
    if (!q || q.engine_id !== 'edgedesk_cfb_v2' || !q.pure || !U.isNum(q.pure.margin)) continue;
    if (/v2\.1/.test(q.model_version || '')) {
      Object.keys(q.components || {}).forEach((k) => { if (U.isNum(q.components[k])) out.projections['v2.1 ' + k] = q.components[k]; });
      out.ensemble = q.pure.margin; out.ensemble_sd = U.isNum(q.pure.ens_sd) ? q.pure.ens_sd : null;
    } else out.projections[(q.model_label || q.model_version) + ' ensemble'] = q.pure.margin;
  }
  return Object.keys(out.projections).length ? out : null;
}
function disagreementFor(p, market, now, models) {
  const di = p && p.engine_id === 'edgedesk_cfb_p4' && p.slateGame && p.slateGame.disagreement_inputs;
  if (!di || !di.projection || !market || !U.isNum(market.current_spread)) return null;
  const rd = di.projection.rating_detail || {};
  try {
    return DIS.evaluate({ now_ms: U.ms(now),
      game: { game_id: p.game.game_id, home: p.game.home, away: p.game.away, kickoff: p.game.kickoff, neutral_site: !!p.game.neutral_site,
        venue: di.game ? di.game.venue : null, home_fbs: di.game ? di.game.home_fbs : true, away_fbs: di.game ? di.game.away_fbs : true },
      mapping: { teams_resolved: true },
      projection: di.projection,
      /* the lab's dispersion is the IQR of the books' lines: a spread measure,
         read as such */
      market: { spread: L.conv.bookToMargin(market.current_spread), books: market.sportsbook_count || 0,
        dispersion: U.num(market.market_dispersion), as_of: market.market_as_of || null, stale: !!market.market_stale,
        source: (market.market_sources || []).join('+') || null },
      submodels: submodelsFor(models, p.game.game_id), qb: di.qb || null, roster: di.roster || null, reliability: U.num(di.reliability),
      long_term_vs_current_delta: (U.isNum(rd.home_gp) && U.isNum(rd.away_gp) && Math.min(rd.home_gp, rd.away_gp) >= 3)
        ? (rd.home_carried - rd.away_carried) - (rd.home_fresh - rd.away_fresh) : null });
  } catch (_) { return null; }
}

/* Build one immutable prediction row (SCHEMA §1). */
/* Probabilities are stored at 5 decimals (numeric(6,5)) and kept strictly
   inside (0, 1): a near-certain game (p >= 0.999995) would otherwise round to
   exactly 1, which no probability column accepts (SCHEMA.md §1). */
function prob5(p) { return Math.min(0.99999, Math.max(0.00001, U.r(U.num(p), 5))); }

function buildRow(model, checkpointType, isFirst, market, decision, dq, ctx) {
  const P = model.pure, gm = model.game;
  const origin = ctx.origin || 'LIVE';
  const predTs = U.iso(ctx.now);
  const hours = L.hoursToKickoff(gm.kickoff, predTs);
  const confRaw = U.isNum(P.confidence_raw) ? Math.round(P.confidence_raw) : null;
  const cap = L.confidenceCap(dq.status);
  const conf = U.isNum(confRaw) ? Math.min(confRaw, cap) : null;
  const comps = model.components || null;
  const sub = { efficiency_margin: null, bayesian_margin: null, drive_margin: null, dynamic_rating_margin: null, matchup_ml_margin: null, residual_adjusted_margin: null };
  if (comps) Object.keys(comps).forEach((k) => { if (M.SUBMODEL_MAP[k] && U.isNum(comps[k])) sub[M.SUBMODEL_MAP[k]] = comps[k]; });
  const status = decision.status;
  let decClass = L.decisionClass(status);
  let passReason = null;
  if (dq.status === 'RED') { decClass = 'PASS'; passReason = 'data quality RED: ' + dq.checks.filter((c) => c.status === 'RED').map((c) => c.check + (c.detail ? ' (' + c.detail + ')' : '')).join('; '); }
  else if (decClass === 'PASS') passReason = decision.reason || null;
  const side = decision.side || null;
  const snapHomeLine = market && U.isNum(market.current_spread) ? market.current_spread : null;
  /* fail closed for betting (§46, §112): the class stays BET only with an
     ACTIONABLE market and a passed extreme-edge review */
  const mi = ctx.integrity || null;
  const review = I.extremeReview({ pure_home_margin: P.margin, fair_spread_home_line: L.conv.marginToBook(P.margin), market_home_line: snapHomeLine, side,
    cover_probability: decision.cover_probability, home_id: gm.home_id, away_id: gm.away_id, game_id: gm.game_id,
    qb_certainty: M.qbCertainty(model.slateGame), injury_certainty: M.injuryCertainty(model.slateGame, ctx.now), feature_ts: model.feature_ts,
    market_age_min: mi && U.isNum(mi.newest_true_age_h) ? mi.newest_true_age_h * 60 : null, now: ctx.now, market_integrity: mi,
    params_hash: model.params_hash, expected_params_hash: ctx.expectedParamsHash || null, model_version: model.model_version });
  const gate = I.betGate(decClass, mi, review);
  if (gate.gated) { decClass = gate.decision_class; passReason = gate.reason; }
  /* the canonical verdict (docs/cfb-production/CANONICAL.md): the input contract,
     the degraded modes (the row's own and this snapshot's evidence) and the
     fallback level travel with the snapshot; a decision computed on an
     incomplete decision input (engine.decide() would read a silent default)
     never stands as a BET */
  let canon = null;
  if (model.canonical) {
    const ev = CANON.modes(null, { market_integrity: mi || null, qb_certainty: M.qbCertainty(model.slateGame),
      injury_certainty: M.injuryCertainty(model.slateGame, ctx.now), pbp_completeness: U.num(model.state && model.state.pbp_completeness) });
    const dm = CANON.mergeModes(model.canonical.row_modes, ev.modes);
    canon = { rule: model.canonical.rule, contract_version: model.canonical.contract_version, contract_ok: model.canonical.contract_ok,
      contract_degrade: (model.canonical.contract_degrade || []).slice(0, 5), decision_inputs_complete: model.canonical.decision_inputs_complete,
      input_hash: model.canonical.input_hash, row_state: model.canonical.row_state, degraded_modes: dm.modes, primary_mode: dm.primary,
      fallback_level: dm.football.length ? 2 : 1 };
    if (decClass === 'BET' && !model.canonical.decision_inputs_complete) { decClass = 'PASS'; passReason = 'decision inputs incomplete (input contract: ' + (model.canonical.contract_degrade || []).slice(0, 2).join('; ') + ')'; }
  }
  const recLine = side && U.isNum(snapHomeLine) ? L.conv.sideLine(side, snapHomeLine) : null;
  const recPrice = side ? (side === 'HOME' ? U.num(market && market.consensus_price_home) : U.num(market && market.consensus_price_away)) : null;
  const gap = U.isNum(snapHomeLine) ? U.r(P.margin - L.conv.bookToMargin(snapHomeLine), 3) : null;
  const betEnabled = !!decision.bet_enabled;
  const stake = decClass === 'BET' && betEnabled ? 1 : 0;
  const iv = P.intervals || {};
  const pick = (k, i) => (iv[k] && U.isNum(iv[k][i]) ? iv[k][i] : null);
  const td = decision.threshold_distance || null;
  const row = {
    prediction_id: null, ledger_version: L.RULES.ledger, origin,
    game_id: gm.game_id, season: gm.season, week: gm.week, season_type: gm.season_type || 'regular',
    home_team: gm.home, away_team: gm.away, home_id: gm.home_id, away_id: gm.away_id, neutral_site: !!gm.neutral_site,
    kickoff_ts: U.iso(gm.kickoff), prediction_ts: predTs, hours_to_kickoff: U.r(hours, 3),
    checkpoint_type: checkpointType, is_first_snapshot: !!isFirst, official_families: L.familiesFor(checkpointType, isFirst, origin),
    projection_computed_at: model.projection_computed_at, feature_ts: model.feature_ts,
    model_version: model.model_version, model_label: model.model_label, model_role: ctx.role,
    feature_version: model.feature_version, calibration_version: model.calibration_version, ensemble_version: model.ensemble_version,
    engine_id: model.engine_id, params_hash: model.params_hash,
    pure_home_margin: U.r(P.margin, 3), fair_spread_home_line: U.r(L.conv.marginToBook(P.margin), 3),
    fair_spread_display: L.conv.display(P.margin, gm.home, gm.away),
    projected_home_points: U.r(P.home_pts, 2), projected_away_points: U.r(P.away_pts, 2), projected_total: U.r(P.total, 2),
    home_win_probability: U.isNum(P.p_home) ? prob5(P.p_home) : null, away_win_probability: U.isNum(P.p_home) ? U.r(1 - prob5(P.p_home), 5) : null,
    prediction_sigma: U.isNum(P.sigma) ? U.r(P.sigma, 3) : null, t_df: U.isNum(P.t_df) ? P.t_df : null,
    interval_50_low: pick(50, 0), interval_50_high: pick(50, 1), interval_80_low: pick(80, 0), interval_80_high: pick(80, 1),
    interval_95_low: pick(95, 0), interval_95_high: pick(95, 1),
    football_confidence: conf, football_confidence_raw: confRaw,
    internal_consensus_score: L.consensusScore(P.ens_sd), ensemble_disagreement: U.isNum(P.ens_sd) ? U.r(P.ens_sd, 3) : null,
    expected_model_error: L.expectedAbsError(P.sigma, P.t_df),
    qb_certainty: M.qbCertainty(model.slateGame), injury_certainty: M.injuryCertainty(model.slateGame, ctx.now),
    data_completeness: U.isNum(U.num(model.state.data_completeness)) ? U.r(U.num(model.state.data_completeness), 4) : null,
    pbp_completeness: U.isNum(U.num(model.state.pbp_completeness)) ? U.r(U.num(model.state.pbp_completeness), 4) : null,
    data_quality_status: dq.status, data_quality_issues: dq.checks.filter((c) => c.status !== 'GREEN'),
    efficiency_margin: sub.efficiency_margin, bayesian_margin: sub.bayesian_margin, drive_margin: sub.drive_margin,
    dynamic_rating_margin: sub.dynamic_rating_margin, matchup_ml_margin: sub.matchup_ml_margin, residual_adjusted_margin: sub.residual_adjusted_margin,
    components: comps,
    market_as_of: market ? market.market_as_of || null : null, market_sources: market ? market.market_sources || [] : [],
    opening_spread: market ? U.num(market.opening_spread) : null, opening_market_ts: market ? market.opening_market_ts || null : null,
    opening_quality: market ? market.opening_quality || 'MISSING' : 'MISSING',
    current_spread: snapHomeLine, consensus_spread: snapHomeLine,
    best_available_spread_home: market ? U.num(market.best_available_spread_home) : null, best_available_spread_away: market ? U.num(market.best_available_spread_away) : null,
    best_price_home: market ? U.num(market.best_price_home) : null, best_price_away: market ? U.num(market.best_price_away) : null,
    consensus_price_home: market ? U.num(market.consensus_price_home) : null, consensus_price_away: market ? U.num(market.consensus_price_away) : null,
    market_dispersion: market ? U.num(market.market_dispersion) : null, sportsbook_count: market ? market.sportsbook_count || 0 : 0,
    line_move_from_open: market ? U.num(market.line_move_from_open) : null, market_total: market ? U.num(market.market_total) : null,
    market_stale: market ? !!market.market_stale : true,
    model_market_gap: gap,
    cover_probability: U.isNum(U.num(decision.cover_probability)) ? prob5(decision.cover_probability) : null,
    break_even_probability: U.isNum(U.num(decision.break_even_probability)) ? prob5(decision.break_even_probability) : null,
    estimated_ev: U.num(decision.estimated_ev), edge_quality: U.isNum(U.num(decision.edge_quality)) ? Math.round(decision.edge_quality) : null,
    betting_reliability: U.isNum(U.num(decision.betting_reliability)) ? Math.round(Math.min(decision.betting_reliability, cap)) : null,
    status, decision_class: decClass, decision_source: decision.decision_source, side,
    recommended_line: recLine, recommended_price: recPrice, stake_units: stake, bet_enabled: betEnabled,
    decision_reason: decision.reason || null, pass_reason: passReason,
    threshold_distance: td, near_miss: L.nearMiss(decClass, td),
    primary_edge: model.explain.primary_edge, secondary_edge: model.explain.secondary_edge,
    primary_uncertainty: model.explain.primary_uncertainty, disagreement_summary: model.explain.disagreement_summary,
    inputs_ref: Object.assign({}, model.inputs, { quote_ids: market && market.quote_ids ? market.quote_ids : [], checkpoint_rule: L.RULES.checkpoint, dq_rule: L.RULES.dq,
      qb_expected: expectedStarters(model.slateGame), segment: segmentOf(model.slateGame) },
      mi ? { market_integrity: { rule: mi.rule, status: mi.status, actionable_status: mi.actionable_status, reasons: mi.reasons, n_books: mi.n_books,
        stale_share: mi.stale_share, newest_true_age_h: mi.newest_true_age_h, range_pts: mi.range_pts } } : {},
      review.required ? { extreme_review: { rule: review.rule, triggers: review.triggers, ok: review.ok, failures: review.failures } } : {},
      gate.gated ? { bet_gate: { rule: I.RULES.consensus, engine_class: L.decisionClass(status), reason: gate.reason } } : {},
      ctx.kickoffBasis ? { kickoff_basis: ctx.kickoffBasis } : {},
      ctx.reschedule ? { reschedule: ctx.reschedule } : {},
      canon ? { canonical: canon } : {},
      ctx.event ? { event: ctx.event } : {}),
  };
  /* the gate's verdict (V1 rows with a market only); the verified gap IS the
     row's raw gap, so the two can never disagree (cfb_lab_pred_verified_gap) */
  const dg = ctx.disagreement || null;
  if (dg && dg.available && dg.status) {
    row.disagreement_version = DIS.version;
    row.disagreement_status = dg.status;
    row.disagreement_tier = dg.tier || null;
    row.verified_market_gap = dg.verified && U.isNum(gap) && Math.abs(gap) >= 7 ? gap : null;
    row.calibrated_market_gap = dg.calibrated && U.isNum(dg.calibrated.gap) ? U.r(dg.calibrated.gap, 3) : null;
    row.disagreement_root_cause = dg.root_cause ? dg.root_cause.primary : null;
    row.disagreement_checks = dg.tier && /^MAJOR/.test(dg.tier)
      ? { failed: dg.failed || [], incomplete: dg.incomplete || [], flags: dg.flags || [], groups: dg.groups || null } : null;
  }
  row.prediction_id = G.ids.prediction(row);
  row.row_hash = G.rowHash(row);
  return row;
}

/* The quarterbacks the board expected when the snapshot was taken (compared
   with who actually started, for the miss review's INFORMATION_CHANGE test). */
function expectedStarters(g) {
  if (!g) return null;
  const one = (s) => { const x = g[s + '_starter']; return x ? { player_id: x.player_id || null, player_name: x.player_name || null, status: x.status || null, confirmed: !!x.confirmed } : null; };
  return { home: one('home'), away: one('away') };
}

/* The game's segment facts (conferences, FBS group, matchup type) for the
   research queue's segment scans. */
function segmentOf(g) {
  if (!g) return null;
  return { home_conference: g.home_conference || null, away_conference: g.away_conference || null,
    home_fbs_group: g.home_fbs_group || null, away_fbs_group: g.away_fbs_group || null,
    home_division: g.home_division || null, away_division: g.away_division || null, matchup_type: g.matchup_type || null };
}

/* Games per week with the same pair twice (data-quality duplicate check),
   keyed by the canonical team ids where they resolve (identity.js). */
function pairCounts(projections) {
  const m = new Map();
  for (const p of projections) {
    const k = ID.pairKey(p.game.home, p.game.away, p.game.home_id, p.game.away_id);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function run(opts) {
  opts = opts || {};
  const now = U.iso(opts.now || new Date());
  const season = opts.season || new Date(U.ms(now)).getUTCFullYear();
  const store = new G.Store(season, opts.storeOpts);
  const roles = GOV.currentRoles(store.gov('model_roles'));
  const models = opts.models || M.loadModels(opts.which || ['v1', 'v2.1', 'c001'], opts.modelOpts);
  const existing = store.predictions();
  const have = new Map();
  /* only LIVE rows occupy LIVE checkpoint windows: reconstructed or replayed
     history never blocks (or stands in for) a live snapshot */
  for (const r of existing) { if (r.origin !== 'LIVE') continue; const k = r.game_id + '|' + r.model_version; if (!have.has(k)) have.set(k, []); have.get(k).push(r.checkpoint_type); }
  const quotes = store.quotes();
  const qByGame = new Map();
  for (const q of quotes) if (q.game_id) { if (!qByGame.has(q.game_id)) qByGame.set(q.game_id, []); qByGame.get(q.game_id).push(q); }
  const rows = [], log = { now, season, due: 0, taken: 0, skipped_no_projection: 0, by_model: {}, by_checkpoint: {},
    skipped_schedule: {}, kickoff_moved: [], rescheduled_adhoc: 0, bet_gated: 0 };
  /* ESPN's schedule this hour (market.capture -> espnSchedule), and the
     settled state of each game: a postponed / canceled game is not snapshotted
     until it has a new kickoff */
  const sched = opts.schedule || {};
  const results = new Map();
  store.results().slice().sort((a, b) => U.ms(a.recorded_at) - U.ms(b.recorded_at)).forEach((r) => results.set(r.game_id, r));
  const liveRows = new Map();
  for (const r of existing) { if (r.origin !== 'LIVE') continue; const k = r.game_id + '|' + r.model_version; if (!liveRows.has(k)) liveRows.set(k, []); liveRows.get(k).push(r); }
  const quarantinedIds = {};
  store.quarantine().forEach((x) => { quarantinedIds[x.quote_id] = true; });
  const skip = (why) => { log.skipped_schedule[why] = (log.skipped_schedule[why] || 0) + 1; };
  for (const m of models) {
    const projs = [...m.projections.values()].filter((p) => p.game.season === season);
    const dup = pairCounts(projs);
    for (const p0 of projs) {
      if (opts.onlyGame && p0.game.game_id !== String(opts.onlyGame)) continue;
      const es = sched[p0.game.game_id] || null;
      if (es && ['POSTPONED', 'CANCELED', 'SUSPENDED'].includes(es.status)) { skip(es.status); continue; }
      if (es && ['IN_PROGRESS', 'FINISHED'].includes(es.status)) { if (L.hoursToKickoff(p0.game.kickoff, now) > 0) skip('STARTED_BEFORE_MODEL_KICKOFF'); continue; }
      /* the kickoff of a NEW snapshot: ESPN's current one when it moved */
      let p = p0, kickoffBasis = null;
      if (es && es.kickoff && U.ms(es.kickoff) !== U.ms(p0.game.kickoff)) {
        kickoffBasis = { model: U.iso(p0.game.kickoff), schedule: es.kickoff, used: es.kickoff, source: 'espn' };
        p = Object.assign({}, p0, { game: Object.assign({}, p0.game, { kickoff: es.kickoff }) });
        log.kickoff_moved.push({ game_id: p0.game.game_id, model_version: m.model_version, from: kickoffBasis.model, to: es.kickoff });
      }
      const h = L.hoursToKickoff(p.game.kickoff, now);
      if (!U.isNum(h) || h <= 0 || h > HORIZON_H) continue;
      const prior = liveRows.get(p.game.game_id + '|' + m.model_version) || [];
      /* rescheduled: the existing snapshots were taken against a kickoff more
         than 36 h away from this one */
      const sameSched = prior.filter((r) => !I.rescheduled(r.kickoff_ts, p.game.kickoff));
      const moved = prior.length > 0 && sameSched.length < prior.length;
      const res = results.get(p.game.game_id);
      if (res && res.status !== 'FINAL' && !moved) { skip('RESULT_' + res.status); continue; }
      let ct, reschedule = null;
      if (opts.adhoc) ct = 'ADHOC';
      else if (moved) {
        const types = sameSched.map((r) => (r.checkpoint_type === 'ADHOC' && r.inputs_ref && r.inputs_ref.reschedule ? r.inputs_ref.reschedule.window : r.checkpoint_type));
        const w = L.dueCheckpoint(h, types);
        if (!w) continue;
        ct = 'ADHOC';
        reschedule = { window: w, original_kickoff: U.iso(prior.filter((r) => I.rescheduled(r.kickoff_ts, p.game.kickoff))[0].kickoff_ts), note: 'rescheduled game: ADHOC stands in for the ' + w + ' window and is never official' };
      } else ct = L.dueCheckpoint(h, prior.map((r) => r.checkpoint_type));
      let event = null;
      if (!ct && !opts.adhoc && p.canonical && h <= EVENT_H && prior.length) {
        const last = prior.slice().sort((a, b) => U.ms(a.prediction_ts) - U.ms(b.prediction_ts))[prior.length - 1];
        const lh = last.inputs_ref && last.inputs_ref.canonical && last.inputs_ref.canonical.input_hash;
        if (lh && lh !== p.canonical.input_hash) {
          ct = 'ADHOC';
          event = { kind: 'INPUT_CHANGED', from_input_hash: lh, to_input_hash: p.canonical.input_hash, supersedes: last.prediction_id,
            note: 'the model inputs changed after the last snapshot: a new version, never official, the earlier row kept' };
        }
      }
      if (!ct) continue;
      log.due++;
      const gq = qByGame.get(p.game.game_id) || [];
      const market = L.marketAt(gq, now, p.game.kickoff);
      const integrity = I.assessMarket(gq, now, { kickoff: p.game.kickoff, hoursToKickoff: h, quarantinedIds });
      const dq = M.dataQuality({ slateGame: p.slateGame, model: p, market, hours: h, now, dupPairs: dup });
      const decision = p.decide(market, now);
      const row = buildRow(p, ct, prior.length === 0, market, decision, dq, { now, role: roleOf(roles, m.model_version), origin: 'LIVE', integrity, kickoffBasis, reschedule,
        disagreement: disagreementFor(p, market, now, models), event });
      if (event) log.event_adhoc = (log.event_adhoc || 0) + 1;
      if (row.inputs_ref.bet_gate) log.bet_gated++;
      if (reschedule) log.rescheduled_adhoc++;
      rows.push(row);
      log.by_model[m.model_version] = (log.by_model[m.model_version] || 0) + 1;
      log.by_checkpoint[ct] = (log.by_checkpoint[ct] || 0) + 1;
    }
  }
  const res = store.appendPredictions(rows);
  log.taken = res.written; log.refused_duplicate_checkpoint = res.refused_duplicate_checkpoint;
  return log;
}

/* The V2 pipeline's Tuesday 12:00 UTC write-once freezes (football/cfb_v2/
   snapshots/<season>/<ts>.json) enter the ledger as WEEKLY_FREEZE rows, exactly
   as frozen: prediction_ts = when the freeze was captured, market = the market
   the freezing run saw. v2.1 and candidate 001 come from the frozen row; V1 from
   the V1 number frozen beside it. A freeze of a model version the lab cannot
   load is reported, not imported. */
function importFreezes(opts) {
  opts = opts || {};
  const season = opts.season || new Date().getUTCFullYear();
  const store = new G.Store(season, opts.storeOpts);
  const dir = opts.snapshotDir || path.join(G.REPO, 'football', 'cfb_v2', 'snapshots', String(season));
  const roles = GOV.currentRoles(store.gov('model_roles'));
  const have = new Set(store.predictions().filter((r) => r.checkpoint_type === 'WEEKLY_FREEZE' && r.origin === 'LIVE').map((r) => r.game_id + '|' + r.model_version));
  const firsts = new Set(store.predictions().filter((r) => r.origin === 'LIVE').map((r) => r.game_id + '|' + r.model_version));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'replay_to_date.json').sort() : [];
  const rows = [], log = { files: files.length, imported: 0, skipped: [] };
  const liveVersion = M.v2Adapter('current', { current: { rows: [], generated_at: null } }).model_version;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const frozen = (j.rows || []).map((x) => x.row);
    const hashes = new Map((j.rows || []).map((x) => [String(x.row.game_id), x.hash]));
    if (j.model_version !== liveVersion) { log.skipped.push(f + ': frozen with ' + j.model_version + ', not ' + liveVersion + ' (v2.1 rows not imported)'); }
    /* one engine per model per file, each fed that file's frozen rows */
    const adapters = [];
    if (j.model_version === liveVersion) adapters.push(M.v2Adapter('current', { current: { rows: frozen, generated_at: null }, slate: { games: [] } }));
    if (frozen.some((r) => r.shadow && r.shadow.candidate_001)) adapters.push(M.v2Adapter('candidate_001', { current: { rows: frozen, generated_at: null }, slate: { games: [] } }));
    for (const r of frozen) {
      const sh = r.shadow || {};
      const at = sh.captured_at || null;
      if (!at || !(U.ms(at) < U.ms(r.kickoff))) { log.skipped.push(r.game_id + ': no pregame capture time'); continue; }
      const mk = sh.market_at_freeze || null;
      const market = mk ? { current_spread: U.num(mk.current_home_line), consensus_spread: U.num(mk.current_home_line), opening_spread: U.num(mk.open_home_line),
        opening_quality: U.isNum(U.num(mk.open_home_line)) ? 'PROVIDER_DECLARED' : 'MISSING', opening_market_ts: null, market_total: U.num(mk.total_current),
        market_as_of: mk.retrieved_at || null, market_sources: ['cfbd'], sportsbook_count: U.isNum(U.num(mk.current_home_line)) ? 1 : 0,
        market_stale: false, line_move_from_open: U.isNum(U.num(mk.open_home_line)) && U.isNum(U.num(mk.current_home_line)) ? U.r(-mk.current_home_line + mk.open_home_line, 2) : null, quote_ids: [], books: [] } : null;
      for (const a of adapters) {
        const p = a.projections.get(String(r.game_id));
        if (!p) continue;
        const key = p.game.game_id + '|' + a.model_version;
        if (have.has(key)) continue;
        p.projection_computed_at = U.iso(at);
        const dq = { status: 'GREEN', checks: [{ check: 'weekly_freeze_import', status: 'GREEN', detail: 'imported from ' + f }] };
        const row = buildRow(p, 'WEEKLY_FREEZE', !firsts.has(key), market, p.decide(market, at), dq, { now: at, role: roleOf(roles, a.model_version), origin: 'LIVE' });
        row.inputs_ref.freeze_file = f; row.inputs_ref.freeze_row_hash = hashes.get(String(r.game_id)) || null;
        row.prediction_id = G.ids.prediction(row); row.row_hash = G.rowHash(row);
        rows.push(row); have.add(key); firsts.add(key);
      }
    }
  }
  log.imported = store.appendPredictions(rows).written;
  return log;
}

module.exports = { run, buildRow, pairCounts, expectedStarters, segmentOf, importFreezes };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const which = arg('--models', 'v1,v2.1,c001').split(',');
  const season = arg('--season', null) ? Number(arg('--season')) : null;
  if (a.includes('--import-freeze')) console.log(JSON.stringify(importFreezes({ season })));
  else console.log(JSON.stringify(run({ now: arg('--now', null), season, which, adhoc: a.includes('--adhoc'), onlyGame: arg('--game', null) })));
}

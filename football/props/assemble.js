/* ===========================================================================
   PLAYER PROPS — projections + market → the canonical evaluated board.
   docs/player-props/ARCHITECTURE.md

   League-agnostic. Takes the games football/props/project.js projected, the
   captured market (football/props/<league>/market.json, written by
   capture.js), the stage table (backtest + live record) and the record's
   calibration by prop type, and produces:

     board rows    one compact row per (player, prop type): the projection,
                   the market, the priced best quote, reliability, the
                   decision and the top WHY / RISKS lines
     game files    everything a research page needs for one game: the full
                   distributions, opportunity and efficiency, the evaluated
                   market (every book, every alternate), correlations
   Every number on every surface comes from EDProps.evaluate() here, and
   the browser / desk re-run the same function on the same inputs, so a
   fair line, a probability and an EV are the same everywhere.
   =========================================================================== */
'use strict';
const P = require('../../lib/edgedesk_props.js');

function r(x, k) { return typeof x === 'number' && isFinite(x) ? Math.round(x * Math.pow(10, k == null ? 4 : k)) / Math.pow(10, k == null ? 4 : k) : null; }
function median(a) { const s = a.filter((x) => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = (s.length - 1) / 2; return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; }

/* the stage of each prop type, from the walk-forward validation and the
   live record (EDProps.stageOf); tier-3 markets stay EXPERIMENTAL */
function stageTable(validation, record) {
  const out = {};
  P.PROP_ORDER.forEach((k) => {
    const pt = P.propType(k);
    const bt = validation && validation.by_prop && validation.by_prop[k] ? validation.by_prop[k] : null;
    const live = record && record.by_prop && record.by_prop[k] ? record.by_prop[k] : null;
    const st = P.stageOf({ backtest: bt ? { walk_forward: true, folds: bt.folds, n: bt.n, leakage_violations: validation.leakage_violations || 0, crps: bt.crps, crps_baseline: bt.crps_baseline, pit_max_dev: bt.pit_max_dev, coverage80: bt.coverage80, synthetic_slope: bt.synthetic_slope } : null,
      live: live ? { n: live.decided, slope: live.calibration_fit && live.calibration_fit.slope, brier: live.brier, market_brier: live.market_brier, clv_mean: live.clv_mean, clv_ci: live.clv_ci, edge_monotone: live.edge_monotone, calibration_holdout_ok: live.calibration_holdout_ok } : null }, pt.modeled === false ? 3 : pt.tier);
    out[k] = { stage: st.stage, label: st.label, tier: pt.tier, gates: st.gates, why: st.why };
  });
  return out;
}
const stageFor = P.stageFor;
/* the record's calibration of a prop type as a 0-1 reliability component:
   null until the sample is meaningful (never a default) */
function calibrationScore(record, prop) {
  const x = record && record.by_prop && record.by_prop[prop];
  if (!x || !(x.decided >= 100) || !x.calibration_fit || x.calibration_fit.slope == null) return null;
  const s = x.calibration_fit.slope;
  return Math.max(0, Math.min(1, 1 - Math.abs(1 - s) / 0.5));
}

function roundAll(o) { const out = {}; Object.keys(o || {}).forEach((k) => { out[k] = r(o[k], 3); }); return out; }
function propKey(p) { return p.game_id + '|' + p.player_id + '|' + p.prop_type; }

/* evaluate every projection of every game against its market */
function assemble(opts) {
  const now = opts.now;
  const league = opts.league;
  const market = opts.market || { props: {}, history: {}, open: {}, unmapped: [] };
  const stages = opts.stages;
  const record = opts.record || null;
  const cvNorm = {};
  opts.games.forEach((g) => g.records.forEach((p) => { if (p.status === 'PROJECTED' && p.summary && p.summary.mean > 0) (cvNorm[p.prop_type] = cvNorm[p.prop_type] || []).push(p.summary.sd / p.summary.mean); }));
  Object.keys(cvNorm).forEach((k) => { cvNorm[k] = r(median(cvNorm[k]), 4); });
  const calib = {};
  P.PROP_ORDER.forEach((k) => { const c = calibrationScore(record, k); if (c != null) calib[k] = c; });
  const rows = [], gameFiles = [];
  const marketKeysSeen = new Set();
  opts.games.forEach((g) => {
    const evals = {};
    const started = Date.parse(g.kickoff || g.records[0] && g.records[0].kickoff) <= now;
    g.records.forEach((p0) => {
      const k = propKey(p0);
      marketKeysSeen.add(k);
      const out = P.prepare(p0, market.props[k] || [], { now, stages, cv_norm: cvNorm, calibration: calib, history: market.history[k], open: market.open[k], close: market.close ? market.close[k] : null, game_started: started });
      Object.assign(p0, { stage: out.projection.stage, reliability: out.projection.reliability });
      evals[p0.projection_id] = out.evaluation;
      rows.push(boardRow(out.projection, out.evaluation, g));
    });
    /* market-only props: quotes for a player / prop EdgeDesk did not project */
    Object.keys(market.props).forEach((k) => {
      if (marketKeysSeen.has(k) || k.indexOf(g.game_id + '|') !== 0) return;
      const quotes = market.props[k], q0 = quotes[0];
      const pseudo = { league, game_id: g.game_id, kickoff: g.kickoff, player_id: q0.player_id, player_name: q0.player_name, position: q0.position || null, team: q0.team, opponent: q0.opponent, home_away: q0.home_away,
        prop_type: q0.prop_type, tier: P.tierOf(q0.prop_type, q0.position),
        status: !q0.player_id ? 'UNMAPPED' : (P.propType(q0.prop_type) && P.propType(q0.prop_type).modeled === false ? 'UNMODELED' : 'INSUFFICIENT_DATA'),
        missing: [!q0.player_id ? 'PLAYER_UNMAPPED' : (P.propType(q0.prop_type) && P.propType(q0.prop_type).modeled === false ? 'PROP_TYPE_NOT_MODELED' : 'NOT_IN_PROJECTION_SET')], projection_id: 'mkt_' + P.hash(k, 12), model_version: g.model_version, stage: 'EXPERIMENTAL' };
      const out = P.prepare(pseudo, quotes, { now, stages, history: market.history[k], open: market.open[k], game_started: started });
      evals[pseudo.projection_id] = out.evaluation;
      g.records.push(pseudo);
      rows.push(boardRow(out.projection, out.evaluation, g));
    });
    gameFiles.push(gameFile(g, evals, market));
  });
  /* exposure across the card: BETs in order of risk-adjusted EV */
  const bets = rows.filter((x) => x.dec && x.dec.cls === 'BET').sort((a, b) => (b.px && b.px.dec_ev || 0) - (a.px && a.px.dec_ev || 0));
  const capped = P.applyExposure(bets.map((x) => ({ id: x.id, game_id: x.gid, team: x.team, player_id: x.pid, units: x.dec.units, corr_group: x.gid + '|' + x.team + '|' + (/^rush/.test(x.prop) ? 'run' : 'pass') })));
  const byId = new Map(capped.map((c) => [c.id, c]));
  rows.forEach((x) => { const c = byId.get(x.id); if (c && c.units !== x.dec.units) { x.dec.units_before_exposure = x.dec.units; x.dec.units = c.units; x.dec.exposure_capped = true; if (!(c.units > 0)) { x.dec.cls = 'LEAN'; x.dec.code = 'SIZING_ZERO'; } } });
  return { rows, gameFiles, cvNorm, calibration: calib };
}

/* ONE COMPACT ROW per prop. Anything derivable is left out: the game
   (kickoff, opponent, home/away) is in board.games, the tier in the
   catalog, the labels in the scores. A row with no market carries no
   market fields and no decision block (the reader shows PROJECTION ONLY). */
function boardRow(p, ev, g) {
  const s = p.summary || {};
  const c = ev.consensus || {};
  const b = ev.recommended || ev.best;
  const fa = ev.fair && ev.fair.at_market;
  const row = { id: p.projection_id, pid: p.player_id, name: p.player_name, pos: p.position, team: p.team, gid: p.game_id, prop: p.prop_type, stage: p.stage };
  if (p.status !== 'PROJECTED') { row.status = p.status; row.miss = p.missing || []; }
  if (p.summary) row.proj = [s.mean, s.median, s.sd, s.p10, s.p25, s.p75, s.p90];
  if (p.reliability && p.reliability.score != null) row.rel = p.reliability.score;
  if (p.availability && p.availability.status !== 'ACTIVE') row.avail = [p.availability.status, p.availability.p_active];
  if (c.books) {
    row.mkt = { line: c.consensus_line, books: c.books, nv: r(c.novig_over, 4), hold: r(c.hold_median, 4), bo: c.best_over ? [c.best_over.book, c.best_over.price, c.best_over.line] : null, bu: c.best_under ? [c.best_under.book, c.best_under.price, c.best_under.line] : null,
      bl: c.book_list && c.book_list.length ? c.book_list : undefined, fresh: c.freshness ? c.freshness.state : null, at: c.freshest_at, open: ev.movement && ev.movement.opening ? ev.movement.opening.line : null, move: ev.movement ? ev.movement.line_move : null };
    if (fa) row.at_line = [fa.p_over, fa.p_under, fa.fair_over, fa.fair_under, fa.diff];
    if (b) row.px = { side: b.side, line: b.line, am: b.american, book: b.book, p: b.model_prob, cover: b.model_cover, fair: b.fair_american, be: b.break_even, mkt_p: b.market_prob, edge: b.edge_pp, ev: b.ev, dec_p: b.decision_prob, dec_ev: b.decision_ev, alt: b.is_alternate || undefined };
    row.why = (ev.why || []).slice(0, 2); row.risks = (ev.risks || []).slice(0, 2);
  }
  if (ev.reason_code !== 'NO_MARKET' || p.status !== 'PROJECTED') row.dec = { cls: ev.decision, code: ev.reason_code, units: ev.units || 0, caps: ev.caps && ev.caps.length ? ev.caps : undefined, state: ev.data_state, side: ev.side || undefined };
  return row;
}
/* THE GAME FILE IS THE MODEL ONLY: projections with their distributions,
   environment, teams and correlations. It changes only when an input
   changes. The market lives in markets/<game>.json (capture.js), and every
   surface prices the two together with EDProps.evaluate — the function this
   build ran for the board — so nothing here goes stale when a price moves. */
function gameFile(g, evals, market) {
  const recs = g.records.map((p) => { const o = Object.assign({}, p); delete o.reliability; delete o.stage; return o; });
  const teams = JSON.parse(JSON.stringify(g.teams));
  ['home', 'away'].forEach((s0) => { (teams[s0].redistribution || []).forEach((d) => { d.recipients = (d.recipients || []).slice().sort((a, b) => b.fraction - a.fraction).slice(0, 5); }); });
  const file = { schema: 'edgedesk_props_game_v1', league: g.league, game_id: g.game_id, kickoff: g.kickoff, home: g.teams.home.team, away: g.teams.away.team, model_version: g.model_version, as_of: g.as_of,
    sims: g.sims, seed: g.seed, inputs_hash: g.inputs_hash, environment: g.environment, teams, correlations: g.correlations };
  return P.compactGame(file, recs);
}

module.exports = { assemble, stageTable, stageFor, calibrationScore, propKey, boardRow };

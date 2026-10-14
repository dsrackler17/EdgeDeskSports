'use strict';
/* ===========================================================================
   EdgeDesk NHL — the research layers the slate adds to every game.

   build_slate.js prices the game with the production model; this file adds,
   for the same game and from the same point-in-time state:

     explanation      the exact Shapley decomposition of the price into the
                      model's factors, and a deterministic narrative over it
                      (hockey/model/explain.js) — no language model
     markets          the full sheet (alternate puck lines and totals,
                      regulation totals, team totals, first period), each line
                      with its held-out validation status (production record
                      + the lab's extended markets)
     repricing        the λ pairs a browser needs to re-price every market under
                      another goalie pairing or lineup (distribution.js runs in
                      the page: the same code, the same numbers)
     challengers      every lab model's probability for the game and its
                      held-out record — model disagreement, never the price
     context          travel, time zones, schedule congestion: measured and
                      shown, not in the price (no out-of-sample benefit)
     market_check     each captured price through lib/edgedesk_nhl_market.js:
                      VERIFIED VALUE / PROVISIONAL / RESEARCH ONLY / PASS
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const GLM = require('./model/glm');
const DIST = require('./model/distribution');
const EX = require('./model/explain');
const CTX = require('./lab/context');
const F = require('./lab/features');
const GB = require('./lab/gbdt');
const ST = require('../engine/stats');
const MK = require('../lib/edgedesk_nhl_market');

const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }

/* ---------- market statuses: the production record, then the lab's extended markets ---------- */
function marketStatuses(val, lab) {
  const st = {};
  const put = (k, m, file) => { if (m) st[k] = { status: m.status, failed: m.failed || [], n: m.n || null, calibration_slope: m.calibration_slope == null ? null : m.calibration_slope, calibration_in_the_large: m.calibration_in_the_large == null ? null : m.calibration_in_the_large, market_status: m.market_status || 'NOT_TESTED', market_n: m.market_n || null, file }; };
  const W = 'hockey/validation/nhl_walkforward.json', L = 'hockey/validation/nhl_lab.json';
  if (val && val.markets) {
    put('moneyline', val.markets.moneyline, W);
    put('puck_line:-1.5', val.markets.puck_line_home_minus_1_5, W); put('puck_line:+1.5', val.markets.puck_line_away_minus_1_5, W);
    put('total:5.5', val.markets.total_over_5_5, W); put('total:6.5', val.markets.total_over_6_5, W);
  }
  const ext = lab && lab.markets_extended ? lab.markets_extended : {};
  for (const [k, m] of Object.entries(ext)) {
    let key = null; let x;
    if ((x = /^puck_line_home_([+-][\d.]+)$/.exec(k))) key = 'puck_line:' + x[1];
    else if ((x = /^total_over_([\d.]+)$/.exec(k))) key = 'total:' + x[1];
    else if ((x = /^total_over_(\d+)_no_push$/.exec(k))) key = 'total:' + x[1];
    else if ((x = /^regulation_total_over_([\d.]+)$/.exec(k))) key = 'regulation_total:' + x[1];
    else if ((x = /^team_total_(home|away)_over_([\d.]+)$/.exec(k))) key = 'team_total:' + x[1] + ':' + x[2];
    else if (k === 'regulation_3way' || k === 'first_period_3way') key = k;
    else if ((x = /^first_period_total_over_([\d.]+)$/.exec(k))) key = 'first_period_total:' + x[1];
    if (key && !st[key]) put(key, m, L);
  }
  return st;
}
/** the status that governs a line: its own when scored; otherwise the nearest scored line of the same market, marked as such */
function statusFor(st, kind, line, side) {
  const key = kind + (line == null ? '' : ':' + (side ? side + ':' : '') + (kind === 'puck_line' && line > 0 ? '+' : '') + line);
  if (st[key]) return Object.assign({ key }, st[key]);
  if (kind === 'puck_line' && st['puck_line:' + (-line > 0 ? '+' : '') + (-line)]) return Object.assign({ key, mirrored: true }, st['puck_line:' + (-line > 0 ? '+' : '') + (-line)]);
  return { key, status: 'NOT_SCORED', failed: ['this line is not separately scored in the held-out record'], market_status: 'NOT_TESTED' };
}

/** the full sheet, rounded, with each line's status */
function fullMarkets(D, st) {
  const s = DIST.fullSheet(D);
  const two = (x) => ({ p: r4(x.p), push: r4(x.push), p_other: r4(x.p_other), fair: x.fair, fair_other: x.fair_other });
  const out = { settles: s.settles };
  out.puck_line = Object.keys(s.puck_line).map(Number).sort((a, b) => a - b).map((L) => Object.assign({ home_line: L }, two(s.puck_line[L]), { validation: statusFor(st, 'puck_line', L).status }));
  out.total = Object.keys(s.total).map(Number).sort((a, b) => a - b).map((L) => Object.assign({ line: L }, two(s.total[L]), { validation: statusFor(st, 'total', L).status }));
  out.regulation_total = Object.keys(s.regulation_total).map(Number).sort((a, b) => a - b).map((L) => Object.assign({ line: L }, two(s.regulation_total[L]), { validation: statusFor(st, 'regulation_total', L).status }));
  out.team_total = {};
  for (const side of ['home', 'away']) out.team_total[side] = Object.keys(s.team_total[side]).map(Number).sort((a, b) => a - b).map((L) => Object.assign({ line: L }, two(s.team_total[side][L]), { validation: statusFor(st, 'team_total', L, side).status }));
  if (s.first_period) {
    const fp = s.first_period;
    out.first_period = { home: r4(fp.home), draw: r4(fp.draw), away: r4(fp.away), fair_home: fp.fair_home, fair_draw: fp.fair_draw, fair_away: fp.fair_away, expected: r2(fp.expected), validation_3way: (st.first_period_3way || {}).status || 'NOT_SCORED',
      total: Object.keys(fp.total).map(Number).sort((a, b) => a - b).map((L) => Object.assign({ line: L }, two(fp.total[L]), { validation: statusFor(st, 'first_period_total', L).status })) };
  }
  out.regulation_3way_validation = (st.regulation_3way || {}).status || 'NOT_SCORED';
  return out;
}

/* ---------- Elo for games not yet played ---------- */
function eloForUpcoming(games, params) {
  if (!params) return null;
  const W = require('./model/walkforward');
  const pr = W.eloPass(games, params.k, params.hfa, params.revert);
  const R = pr.ratings; const last = pr.last_season;
  return (home, away, season) => {
    const get = (t) => { const v = R.has(t) ? R.get(t) : 1500; return season !== last ? params.revert * v + (1 - params.revert) * 1500 : v; };
    const diff = get(home) - get(away) + params.hfa;
    return 1 / (1 + Math.pow(10, -diff / 400));
  };
}

/* ---------- the lab's challengers, live ---------- */
function challengerSet(labLive, lab, games) {
  if (!labLive || !lab) return null;
  const elo = eloForUpcoming(games, labLive.elo);
  const lr = labLive.logistic, gb = labLive.gbdt, stack = labLive.stack || {};
  const lrP = (x) => { if (!lr) return null; const z = [1].concat(x.map((v, j) => (v - lr.mean[j]) / (lr.sd[j] || 1))); let p = ST.predictLogistic(lr.beta, z); if (lr.platt) p = ST.predictLogistic(lr.platt, [1, ST.logit(p)]); return p; };
  const gbP = (x) => { if (!gb) return null; let p = GB.predict({ f0: gb.f0, trees: gb.trees, medians: gb.medians }, x); if (gb.platt) p = ST.predictLogistic(gb.platt, [1, ST.logit(p)]); return p; };
  return function (o) {
    /* o: { fh, fa, price(model, cal, fh, fa) → D, season, home, away, production_p } */
    const out = [];
    const glmP = (k) => (labLive.glm && labLive.glm[k] ? o.price(labLive.glm[k], labLive.pair_calibration[k], o.fh, o.fa).p_home : null);
    const row = F.row(o.fh, o.fa);
    const ps = {
      B_incumbent: o.production_p,
      A_goals_only: glmP('A_goals_only'), A_elo: elo ? elo(o.home, o.away, o.season) : null,
      C_goalie_projected: glmP('C_goalie_projected'), D_lineup_projected: glmP('D_lineup_projected'),
      E_logistic: lrP(row), E_gbdt: gbP(row),
    };
    if (stack.weights && stack.components && stack.components.every((c) => ps[c] != null)) ps.G_stack = ST.predictLogistic([stack.weights.intercept].concat(stack.components.map((c) => stack.weights[c])), [1].concat(stack.components.map((c) => ST.logit(ps[c]))));
    for (const [k, p] of Object.entries(ps)) if (p != null) out.push({ model: k, p_home: r4(p) });
    const vals = out.map((x) => x.p_home); const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    return { models: out, spread_pp: r2((Math.max(...vals) - Math.min(...vals)) * 100), sd_pp: r2(Math.sqrt(vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length) * 100) };
  };
}
const CHALLENGER_LABEL = { B_incumbent: 'Production: expected-goals GLM (B)', A_goals_only: 'Goals-only power ratings (A)', A_elo: 'Elo with margin of victory (A)', C_goalie_projected: 'B + projected goalie (C)', D_lineup_projected: 'B + projected lineup (D)', E_logistic: 'Regularised logistic regression (E)', E_gbdt: 'Gradient-boosted trees (E)', G_stack: 'Stacked ensemble (G)' };
/** once per slate: each challenger's held-out record and the promotion decision */
function challengerRecords(lab) {
  if (!lab || !lab.models) return null;
  const models = {};
  for (const k of Object.keys(CHALLENGER_LABEL)) {
    const m = lab.models[k]; if (!m) continue;
    models[k] = { label: CHALLENGER_LABEL[k], role: k === 'B_incumbent' ? 'PRODUCTION' : 'RESEARCH', selection: m.scores.selection.log_loss, confirmation: m.scores.confirmation.log_loss, live: m.scores.live.log_loss, live_n: m.scores.live.n,
      vs_production: m.vs_incumbent ? { selection: m.vs_incumbent.selection.mean_diff, confirmation: m.vs_incumbent.confirmation.mean_diff, confirmation_ci95: m.vs_incumbent.confirmation.ci95 } : null, promotion: m.promotion || null };
  }
  return { models, decision: lab.promotion ? { decision: lab.promotion.decision, model: lab.promotion.model, why: lab.promotion.why } : null, generated_at: lab.generated_at, file: 'hockey/validation/nhl_lab.json' };
}

/* ---------- schedule context for upcoming games ---------- */
function contextBuilder(completedGames, schedule) {
  const st = new CTX.ContextState();
  for (const g of completedGames) { st.appear(g.home, g.home, g.date, g.season); st.appear(g.away, g.home, g.date, g.season); st.absorb([g.h, g.a]); }
  const app = new Map();
  for (const g of schedule) for (const t of [g.home, g.away]) { if (!app.has(t)) app.set(t, []); app.get(t).push({ date: g.date, at: g.home, season: g.season || null }); }
  for (const v of app.values()) v.sort((a, b) => (a.date < b.date ? -1 : 1));
  return function (team, home, date) {
    const earlier = (app.get(team) || []).filter((x) => x.date < date);
    const sch = CTX.scheduleFeatures(team, home, date, earlier);
    const res = st.results(team);
    return Object.assign(sch, res, { season_games: earlier.length });
  };
}

/* ---------- prices against the model ---------- */
function marketChecks(g, ev, st, ctx) {
  if (!ev || !ev.books || !ev.books.length) return { state: 'NO_PRICES', checks: [] };
  const checks = [];
  const uncert = g.uncertainty ? g.uncertainty.moneyline_sd_pp : 0;
  const scen = (g.goalies && g.goalies.scenarios || []).map((s) => s.p_home);
  for (const b of ev.books) {
    const q = (american, other) => ({ american, other_american: other, book: b.book, captured_at: b.last_update || ctx.captured_at, source: 'captured' });
    if (b.h2h) {
      const s = statusFor(st, 'moneyline');
      checks.push(Object.assign({ book: b.book, market: g.home + ' moneyline' }, MK.evaluate({ market: { kind: 'moneyline', label: 'moneyline', settles: 'two-way incl. OT/SO' }, model: { p_win: g.prices.moneyline.home, sd_pp: uncert, status: s.status, market_status: s.market_status, market_n: s.market_n, scenario_p_win: scen }, quote: q(b.h2h.home, b.h2h.away), context: { now: ctx.now, data_state: ctx.data_state, goalie_certainty: g.goalies.certainty } })));
      checks.push(Object.assign({ book: b.book, market: g.away + ' moneyline' }, MK.evaluate({ market: { kind: 'moneyline', label: 'moneyline', settles: 'two-way incl. OT/SO' }, model: { p_win: g.prices.moneyline.away, sd_pp: uncert, status: s.status, market_status: s.market_status, market_n: s.market_n, scenario_p_win: scen.map((p) => 1 - p) }, quote: q(b.h2h.away, b.h2h.home), context: { now: ctx.now, data_state: ctx.data_state, goalie_certainty: g.goalies.certainty } })));
    }
    for (const sp of b.spreads || []) {
      const row = (g.markets.puck_line || []).find((x) => x.home_line === sp.home_line); if (!row) continue;
      const s = statusFor(st, 'puck_line', sp.home_line);
      checks.push(Object.assign({ book: b.book, market: g.home + ' ' + (sp.home_line > 0 ? '+' : '') + sp.home_line }, MK.evaluate({ market: { kind: 'puck_line', label: 'puck line ' + sp.home_line }, model: { p_win: row.p, p_push: row.push, sd_pp: uncert, status: s.status, market_status: s.market_status, market_n: s.market_n }, quote: q(sp.home, sp.away), context: { now: ctx.now, data_state: ctx.data_state, goalie_certainty: g.goalies.certainty } })));
      checks.push(Object.assign({ book: b.book, market: g.away + ' ' + (-sp.home_line > 0 ? '+' : '') + (-sp.home_line) }, MK.evaluate({ market: { kind: 'puck_line', label: 'puck line ' + (-sp.home_line) }, model: { p_win: row.p_other, p_push: row.push, sd_pp: uncert, status: s.status, market_status: s.market_status, market_n: s.market_n }, quote: q(sp.away, sp.home), context: { now: ctx.now, data_state: ctx.data_state, goalie_certainty: g.goalies.certainty } })));
    }
    for (const t of b.totals || []) {
      const row = (g.markets.total || []).find((x) => x.line === t.line); if (!row) continue;
      const s = statusFor(st, 'total', t.line);
      checks.push(Object.assign({ book: b.book, market: 'Over ' + t.line }, MK.evaluate({ market: { kind: 'total', label: 'total ' + t.line }, model: { p_win: row.p, p_push: row.push, sd_pp: 0, status: s.status, market_status: s.market_status }, quote: q(t.over, t.under), context: { now: ctx.now, data_state: ctx.data_state } })));
      checks.push(Object.assign({ book: b.book, market: 'Under ' + t.line }, MK.evaluate({ market: { kind: 'total', label: 'total ' + t.line }, model: { p_win: row.p_other, p_push: row.push, sd_pp: 0, status: s.status, market_status: s.market_status }, quote: q(t.under, t.over), context: { now: ctx.now, data_state: ctx.data_state } })));
    }
  }
  const order = { VERIFIED_VALUE: 0, PROVISIONAL: 1, RESEARCH_ONLY: 2, PASS: 3 };
  checks.sort((a, b) => order[a.label] - order[b.label] || (b.numbers.ev || -9) - (a.numbers.ev || -9));
  const counts = {}; for (const c of checks) counts[c.label] = (counts[c.label] || 0) + 1;
  return { state: 'PRICED', counts, checks: checks.slice(0, 24), trimmed: checks.length > 24 ? checks.length - 24 : 0 };
}

module.exports = { marketStatuses, statusFor, fullMarkets, challengerSet, challengerRecords, contextBuilder, marketChecks, eloForUpcoming, readJson, CHALLENGER_LABEL };

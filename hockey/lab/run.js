#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — every challenger against the production model, out of
   sample, on the production model's own games, windows and rules.

     node hockey/lab/run.js            write hockey/validation/nhl_lab.json and
                                       hockey/model/params/lab_live.json
     node hockey/lab/run.js --no-shape skip Model F's likelihood cache (~5 min)
     node hockey/lab/run.js --check    the committed report passes its rules

   THE CANDIDATES (docs/engine/NHL_LAB.md)
     A  dynamic power ratings: the goals-only GLM and a tuned Elo
     B  the expected-goals GLM — the PRODUCTION model (whatever the production
        record chose: xg_core since the 2026-10-13 parsimony amendment)
     C  goalie-adjusted: B + the projected (or confirmed) starter's GSAx
     D  lineup: B + the projected (or confirmed) lineup's value
     E  machine learning on the same point-in-time snapshots plus the context
        features: L2 logistic regression, gradient-boosted trees
     F  the score distribution's shape: pace overdispersion, draw inflation,
        a longer calibration window (hockey/lab/shape.js)
     G  a stacked ensemble of A–E, weights fitted on the three seasons before
        each season it scores (nested: no season ever weighs itself)
   plus a feature ablation of B: every feature dropped in turn, every context
   group added in turn.

   THE PROMOTION RULE (written here before any challenger was scored, on
   2026-10-13). A challenger replaces the production model only if ALL hold:
     1. SELECTION (2013-14 to 2019-20): moneyline log loss lower than the
        incumbent's by at least 0.001 (the protocol's challenger margin);
     2. CONFIRMATION (2020-21 to 2025-26): the paired block-bootstrap 95%
        interval of its log-loss difference from the incumbent is wholly
        below zero;
     3. CONFIRMATION calibration: slope in [0.85, 1.15], |mean p − mean y| ≤ 0.02;
     4. it yields one consistent score distribution for every market (a
        moneyline-only model enters through the split solver,
        distribution.solveSplit, keeping the incumbent's expected total).
   Anything else stays a RESEARCH challenger: shown beside the production
   price as model disagreement, never used to price. A simpler model is never
   displaced by a more complex one on a tiny, noisy difference.

   DISCLOSURE. The confirmation window had been read for the original five
   candidates (and the three lineup ones) before this lab existed; every
   candidate here was declared after that. Rule 1 chooses on SELECTION only;
   rule 2 is an extra guard, not a selection device. The 2026-27 season (and
   every later one) is the clean out-of-sample test, frozen by the ledger.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const B = require('./base');
const SH = require('./shape');
const F = require('./features');
const GB = require('./gbdt');
const W = require('../model/walkforward');
const GLM = require('../model/glm');
const DIST = require('../model/distribution');
const V = require('../../engine/validation');
const ST = require('../../engine/stats');

const OUT = path.join(C.PATHS.validation, 'nhl_lab.json');
const LIVE_OUT = path.join(C.HOCKEY, 'model', 'params', 'lab_live.json');
const SCHEMA = 'edgedesk_nhl_lab_v1';
const RULE = {
  selection_margin: 0.001, confirmation_ci: 'paired block bootstrap over dates, 95% upper bound < 0', slope: [0.85, 1.15], max_citl: 0.02,
  declared: '2026-10-13, before any lab challenger was scored', consistency: 'one score distribution per game (moneyline-only models through distribution.solveSplit)',
};
function arg(name) { return process.argv.includes('--' + name); }
const r6 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6);

/* ---------- the GLM family: production, A–D, and the ablation ---------- */
/* the production model is whatever the production record chose (hockey/model/walkforward.js) */
function productionChosen() { try { return JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'nhl_walkforward.json'), 'utf8')).selection.chosen; } catch (_) { return 'xg_no_goalie'; } }
function glmVariants(lineupOk) {
  const chosen = productionChosen();
  const INC = GLM.CANDIDATES[chosen];
  const v = {
    B_incumbent: INC,
    A_goals_only: GLM.CANDIDATES.goals_only,
    C_goalie_projected: GLM.CANDIDATES.xg_goalie_projected,
    C_goalie_confirmed: GLM.CANDIDATES.xg_goalie_confirmed,
  };
  if (chosen !== 'xg_no_goalie') v.B_previous_xg_no_goalie = GLM.CANDIDATES.xg_no_goalie;
  if (lineupOk) { v.D_lineup_projected = GLM.CANDIDATES.xg_lineup_projected; v.D_lineup_confirmed = GLM.CANDIDATES.xg_lineup_confirmed; }
  for (const f of INC) v['drop:' + f] = INC.filter((x) => x !== f);
  /* correlated features can each look redundant alone: drop each explanation factor's whole block too */
  const BLOCKS = { xg_5v5: ['ev_off', 'ev_def_opp'], goals_and_finishing: ['g_off', 'g_def_opp', 'fin'], special_teams: ['pp_off', 'pk_def_opp', 'pp_draw', 'pk_take_opp'], rest: ['b2b', 'b2b_opp'] };
  for (const [k, f] of Object.entries(BLOCKS)) if (f.some((x) => INC.indexOf(x) >= 0)) v['dropblock:' + k] = INC.filter((x) => f.indexOf(x) < 0);
  const ADD = {
    travel: ['travel', 'travel_opp'], time_zones: ['tz_east', 'tz_east_opp', 'tz_west', 'tz_west_opp'], congestion: ['congest', 'congest_opp'],
    road_trip: ['road_trip', 'road_trip_opp'], recent_form: ['form_off', 'form_def_opp'], finishing_and_save_luck: ['luck_fin', 'luck_sv_opp'],
    special_teams_interaction: ['st_x_quality', 'st_x_volume'], early_season_shrinkage: ['early_ev_off', 'early_ev_def_opp'],
  };
  /* a block the production model left out is tested by adding it back */
  if (INC.indexOf('pp_off') < 0) ADD.special_teams = BLOCKS.special_teams;
  for (const [k, f] of Object.entries(ADD)) v['add:' + k] = INC.concat(f);
  v['add:all_context'] = INC.concat(...Object.values(ADD).filter((f) => f !== BLOCKS.special_teams));
  return { variants: v, ADD, BLOCKS, chosen };
}

function eloTuned(games) {
  let best = null;
  for (const k of [4, 6, 8, 10, 12]) for (const hfa of [20, 35, 50, 65]) for (const rev of [0.5, 0.7]) {
    const pr = W.eloPass(games, k, hfa, rev); let ll = 0, n = 0;
    for (const g of games) if (B.inWin(g.season, B.SELECTION)) { ll += V.logLoss(pr.get(g.game_id), g.hw); n++; }
    if (!best || ll / n < best.ll) best = { k, hfa, revert: rev, ll: ll / n };
  }
  return { params: best, pred: W.eloPass(games, best.k, best.hfa, best.revert) };
}

/* ---------- Model E ---------- */
function standardizer(X) {
  const d = X[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mean[j]) ** 2 / X.length;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return { mean, sd, apply: (x) => [1].concat(x.map((v, j) => (v - mean[j]) / sd[j])) };
}
function fitLR(X, y, l2) { const z = standardizer(X); const m = ST.logistic(X.map(z.apply), y, { l2 }); return { mean: z.mean, sd: z.sd, beta: m.beta, l2, predict: (x) => ST.predictLogistic(m.beta, z.apply(x)) }; }

function seasonRows(base, rowsOf, from, to) { const X = [], y = []; for (const g of base.games) if (g.season >= from && g.season <= to) { X.push(rowsOf.get(g.game_id)); y.push(g.hw); } return { X, y }; }

/** walk-forward predictions of a learner: season S trained on max(2012, S-5)..S-1 */
function walkLearner(base, rowsOf, seasons, fitFn) {
  const pred = new Map(); const models = {};
  for (const S of seasons) {
    const { X, y } = seasonRows(base, rowsOf, Math.max(C.FIRST_SEASON + 1, S - B.GLM_WINDOW), S - 1);
    const m = fitFn(X, y); models[S] = m;
    for (const g of base.games) if (g.season === S) pred.set(g.game_id, m.predict(rowsOf.get(g.game_id)));
  }
  return { pred, models };
}
function selLL(base, pred) { let ll = 0, n = 0; for (const g of base.scored) if (B.inWin(g.season, B.SELECTION) && pred.has(g.game_id)) { ll += V.logLoss(pred.get(g.game_id), g.hw); n++; } return ll / n; }

/* nested Platt recalibration: season S from the three seasons before it (identity under 500 rows) */
function platt(base, pred) {
  const out = new Map(); const fits = {};
  for (const S of [...new Set(base.scored.map((g) => g.season))]) {
    const rows = base.scored.filter((g) => g.season >= S - 3 && g.season < S && pred.has(g.game_id));
    let f = null;
    if (rows.length >= 500) { const m = ST.logistic(rows.map((g) => [1, ST.logit(pred.get(g.game_id))]), rows.map((g) => g.hw), { l2: 0 }); f = m.beta; }
    fits[S] = f ? f.map((b) => r6(b)) : null;
    for (const g of base.scored) if (g.season === S && pred.has(g.game_id)) { const p = pred.get(g.game_id); out.set(g.game_id, f ? ST.predictLogistic(f, [1, ST.logit(p)]) : p); }
  }
  return { pred: out, fits };
}

/* ---------- Model G: nested stacking on logits ---------- */
function stack(base, comps) {
  const names = Object.keys(comps); const out = new Map(); const weights = {};
  for (const S of [...new Set(base.scored.map((g) => g.season))]) {
    const rows = base.scored.filter((g) => g.season >= S - 3 && g.season < S && names.every((c) => comps[c].has(g.game_id)));
    let beta = null;
    if (rows.length >= 500) beta = ST.logistic(rows.map((g) => [1].concat(names.map((c) => ST.logit(comps[c].get(g.game_id))))), rows.map((g) => g.hw), { l2: 1 }).beta;
    weights[S] = beta ? Object.fromEntries([['intercept', r6(beta[0])]].concat(names.map((c, i) => [c, r6(beta[i + 1])]))) : null;
    for (const g of base.scored) {
      if (g.season !== S || !names.every((c) => comps[c].has(g.game_id))) continue;
      out.set(g.game_id, beta ? ST.predictLogistic(beta, [1].concat(names.map((c) => ST.logit(comps[c].get(g.game_id))))) : comps[names[0]].get(g.game_id));
    }
  }
  return { pred: out, weights, components: names };
}

/* ---------- scoring ---------- */
function windowRows(base, pred, w) { return base.scored.filter((g) => B.windowOf(g.season) === w && pred.has(g.game_id)).map((g) => ({ p: pred.get(g.game_id), y: g.hw, date: g.date, id: g.game_id })); }
function slimBinary(rows) { const b = V.binary(rows); delete b.bins; delete b.climatology; return b; }
function scoreModel(base, pred) { const o = {}; for (const w of ['selection', 'confirmation', 'live']) o[w] = slimBinary(windowRows(base, pred, w)); return o; }
function versus(base, predA, predB, w) {
  const rows = base.scored.filter((g) => B.windowOf(g.season) === w && predA.has(g.game_id) && predB.has(g.game_id));
  return V.pairedBootstrap(rows.map((g) => ({ date: g.date, a: V.logLoss(predA.get(g.game_id), g.hw), b: V.logLoss(predB.get(g.game_id), g.hw) })), { B: 1000 });
}
function promotionCheck(name, scored, vsSel, vsConf, consistent) {
  const fails = [];
  if (!(vsSel.mean_diff <= -RULE.selection_margin)) fails.push('selection: ' + (vsSel.mean_diff <= 0 ? 'better by only ' + Math.abs(vsSel.mean_diff) : 'worse by ' + vsSel.mean_diff) + ' (needs ≥ 0.001)');
  if (!(vsConf.ci95[1] < 0)) fails.push('confirmation: 95% interval ' + vsConf.ci95.join(' to ') + ' is not wholly below zero');
  const c = scored.confirmation;
  if (c.calibration_slope == null || c.calibration_slope < RULE.slope[0] || c.calibration_slope > RULE.slope[1]) fails.push('confirmation calibration slope ' + c.calibration_slope);
  if (Math.abs(c.calibration_in_the_large) > RULE.max_citl) fails.push('confirmation mean p − mean y ' + c.calibration_in_the_large);
  if (!consistent) fails.push('no consistent score distribution');
  return { model: name, passes: !fails.length, failed: fails };
}

/* ---------- market extensions on the production model ---------- */
const MK_RULES = { min_n: 1000, max_citl: 0.02, slope: [0.85, 1.15] };
function marketStatus(rows) {
  const b = V.binary(rows); const fails = [];
  if (b.n < MK_RULES.min_n) fails.push('n ' + b.n + ' < ' + MK_RULES.min_n);
  if (b.n && Math.abs(b.calibration_in_the_large) > MK_RULES.max_citl) fails.push('mean p off by ' + b.calibration_in_the_large);
  if (b.n && (b.calibration_slope == null || b.calibration_slope < MK_RULES.slope[0] || b.calibration_slope > MK_RULES.slope[1])) fails.push('calibration slope ' + b.calibration_slope);
  return { status: fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED', failed: fails, n: b.n, log_loss: b.log_loss, brier: b.brier, brier_skill: b.brier_skill, mean_p: b.mean_p, mean_y: b.mean_y, calibration_in_the_large: b.calibration_in_the_large, calibration_slope: b.calibration_slope, market_status: 'NOT_TESTED' };
}
function marketExtensions(base, lamOf) {
  const eff = (g) => base.P[g.season].effects || DIST.neutralEffects();
  const ot = (g) => (g.type === 'P' ? { format: 'PO' } : base.P[g.season].ot);
  const acc = {}; const add = (k, p, y) => { if (p == null || y == null) return; (acc[k] || (acc[k] = [])).push({ p, y }); };
  for (const g of base.scored) {
    if (B.windowOf(g.season) !== 'confirmation') continue;
    const L = lamOf(g); const pr = base.periods.get(g.game_id); if (!L || !pr) continue;
    const D = DIST.game({ lamH: L.lh, lamA: L.la, effects: eff(g), ot: ot(g), periods: true });
    const margin = g.final_home - g.final_away, tot = g.final_home + g.final_away, reg = g.reg_home + g.reg_away;
    /* binary on the games that did not push; P conditional on no push */
    const cond = (x, win, push) => (push > 0.999 ? null : win / (1 - push));
    for (const L2 of [-3.5, -2.5, -1.5, 1.5, 2.5, 3.5]) { const x = DIST.spread(D, L2); add('puck_line_home_' + (L2 > 0 ? '+' : '') + L2, x.win, margin + L2 > 0 ? 1 : 0); }
    for (const Lt of [4.5, 5.5, 6.5, 7.5, 8.5]) { const x = DIST.total(D, Lt); add('total_over_' + Lt, x.over, tot > Lt ? 1 : 0); }
    for (const Lt of [5, 6, 7]) { const x = DIST.total(D, Lt); if (tot !== Lt) add('total_over_' + Lt + '_no_push', cond(null, x.over, x.push), tot > Lt ? 1 : 0); }
    for (const Lt of [4.5, 5.5, 6.5]) { const x = DIST.regulationTotal(D, Lt); add('regulation_total_over_' + Lt, x.over, reg > Lt ? 1 : 0); }
    for (const side of ['home', 'away']) for (const Lt of [1.5, 2.5, 3.5]) { const x = DIST.teamTotal(D, side, Lt); add('team_total_' + side + '_over_' + Lt, x.over, (side === 'home' ? g.final_home : g.final_away) > Lt ? 1 : 0); }
    const reg3 = g.reg_home > g.reg_away ? 'home' : g.reg_home < g.reg_away ? 'away' : 'draw';
    for (const k of ['home', 'draw', 'away']) add('regulation_3way_' + k, D.reg[k], reg3 === k ? 1 : 0);
    const fp = DIST.firstPeriod(D);
    const p1 = pr.h1 > pr.a1 ? 'home' : pr.h1 < pr.a1 ? 'away' : 'draw', t1 = pr.h1 + pr.a1;
    for (const k of ['home', 'draw', 'away']) add('first_period_3way_' + k, fp[k], p1 === k ? 1 : 0);
    for (const Lt of [0.5, 1.5, 2.5]) add('first_period_total_over_' + Lt, fp.totals[Lt].over, t1 > Lt ? 1 : 0);
  }
  const out = {};
  for (const [k, rows] of Object.entries(acc)) out[k] = marketStatus(rows);
  /* a 3-way market passes when each outcome, scored one-vs-rest, passes the binary rules */
  for (const m of ['regulation_3way', 'first_period_3way']) {
    const parts = ['home', 'draw', 'away'].map((k) => out[m + '_' + k]);
    out[m] = { status: parts.every((p) => p.status === 'OUTCOME_VALIDATED') ? 'OUTCOME_VALIDATED' : 'PROVISIONAL', failed: [].concat(...parts.map((p, i) => p.failed.map((f) => ['home', 'draw', 'away'][i] + ': ' + f))), rule: 'each outcome one-vs-rest passes the binary rules (defined in this build, 2026-10-13, after the draw shortfall was known)', market_status: 'NOT_TESTED' };
  }
  return out;
}

/* ---------- Model F'': the period profile, coarse (0-40 min as one rate) vs fine (period 1 apart) ---------- */
function periodProfile(base, lamOf, ot) {
  let readSeason; try { readSeason = require('../ingest/season').readSeason; } catch (_) { return { skipped: 'no ingest module' }; }
  const goals = {};
  for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) { try { goals[s] = [...readSeason(s)].map((r) => ({ goals: r.shots.filter((x) => x.goal && x.gs < 3600).map((x) => ({ t: x.gs, side: x.side })) })); } catch (_) { goals[s] = null; } }
  const eff = { coarse: {}, fine: {} };
  for (const S of [...new Set(base.scored.map((g) => g.season))]) {
    const gs = []; for (let s = Math.max(C.FIRST_SEASON, S - 4); s <= S - 1; s++) if (goals[s]) gs.push(...goals[s]);
    if (gs.length < 1000) return { skipped: 'the ingest cache is incomplete (hockey/ingest/season.js)' };
    eff.coarse[S] = DIST.estimateScoreEffects(gs); eff.fine[S] = DIST.estimateScoreEffects(gs, { t_buckets: DIST.T_BUCKETS_FINE });
  }
  const acc = {};
  for (const g of base.scored) {
    const L = lamOf(g), pr = base.periods.get(g.game_id); if (!L || !pr) continue;
    const w = B.windowOf(g.season); if (w === 'burn_in') continue;
    for (const name of ['coarse', 'fine']) {
      const D = DIST.game({ lamH: L.lh, lamA: L.la, effects: eff[name][g.season], ot: ot(g), periods: true });
      const a = acc[w + '|' + name] || (acc[w + '|' + name] = { ml: [], reg: 0, p1: 0, n: 0, o15: [] });
      const N = D.maxg + 1;
      a.ml.push({ p: D.p_home, y: g.hw, date: g.date });
      a.reg += Math.log(Math.max(1e-12, DIST.regProb(D, g.reg_home, g.reg_away)));
      a.p1 += Math.log(Math.max(1e-12, D.p1_matrix[Math.min(D.maxg, pr.h1) * N + Math.min(D.maxg, pr.a1)])); a.n++;
      a.o15.push({ p: DIST.firstPeriod(D).totals[1.5].over, y: pr.h1 + pr.a1 > 1.5 ? 1 : 0 });
    }
  }
  const win = {};
  for (const w of ['selection', 'confirmation', 'live']) {
    const c = acc[w + '|coarse'], f = acc[w + '|fine']; if (!c || !f) continue;
    const o15c = V.binary(c.o15), o15f = V.binary(f.o15);
    win[w] = {
      n: c.n, regulation_score_loglik_gain: r6((f.reg - c.reg) / c.n), first_period_score_loglik_gain: r6((f.p1 - c.p1) / c.n),
      moneyline: V.pairedBootstrap(f.ml.map((x, i) => ({ date: x.date, a: V.logLoss(x.p, x.y), b: V.logLoss(c.ml[i].p, c.ml[i].y) })), { B: 1000 }),
      first_period_over_1_5: { coarse: { mean_p: o15c.mean_p, observed: o15c.mean_y, citl: o15c.calibration_in_the_large }, fine: { mean_p: o15f.mean_p, observed: o15f.mean_y, citl: o15f.calibration_in_the_large } },
    };
  }
  const s = win.selection || {};
  const adopt = s.first_period_score_loglik_gain >= 0.001 && s.regulation_score_loglik_gain >= 0 && s.moneyline && s.moneyline.mean_diff <= 0.0002;
  return {
    profiles: { coarse: DIST.T_BUCKETS, fine: DIST.T_BUCKETS_FINE }, windows: win,
    rule: 'adopt the fine profile if, on SELECTION, the first-period score log-likelihood gains ≥ 0.001 per game, the 60-minute score log-likelihood does not fall, and the moneyline log loss does not rise by more than 0.0002',
    disclosure: 'the rule was written after an exploratory run that had read both windows (2026-10-13)',
    adopted: !!adopt, in_production: true,
    verdict: adopt ? 'ADOPTED: in production since 2026-10-13 (hockey/model/walkforward.js effectsFor)' : 'REJECTED',
  };
}

/* ------------------------------------------------------------------ main */
function main() {
  const t0 = Date.now();
  const log = (m) => console.log('[nhl lab] ' + m + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  const base = B.prepare();
  for (const g of base.games) { const sn = base.snaps.get(g.game_id); sn.fh.playoff = sn.fa.playoff = g.type === 'P' ? 1 : 0; }
  log('prepared ' + base.games.length + ' games; lineups ' + base.lineupOk);
  const eff = (g) => base.P[g.season].effects || DIST.neutralEffects();
  const ot = (g) => (g.type === 'P' ? { format: 'PO' } : base.P[g.season].ot);
  const seasonsScored = [...new Set(base.scored.map((g) => g.season))];

  /* 1. GLM family */
  const { variants, ADD, BLOCKS, chosen: prodChosen } = glmVariants(base.lineupOk);
  const G = B.glmPredictions(base, variants);
  const ml = {}; const lam = {}; const tot = {};
  for (const name of Object.keys(variants)) { ml[name] = new Map(); lam[name] = new Map(); tot[name] = new Map(); }
  for (const g of base.scored) {
    const L = G.lam.get(g.game_id);
    for (const name of Object.keys(variants)) {
      const D = DIST.game({ lamH: L[name].lh, lamA: L[name].la, effects: eff(g), ot: ot(g) });
      ml[name].set(g.game_id, D.p_home); lam[name].set(g.game_id, L[name]);
      const pmf = DIST.totalPmf(D); const t = g.final_home + g.final_away;
      tot[name].set(g.game_id, { rps: V.rps(pmf, Math.min(t, pmf.length - 1)), o55: DIST.total(D, 5.5).over });
    }
  }
  log('GLM family: ' + Object.keys(variants).length + ' variants priced');
  const inc = ml.B_incumbent;

  /* reproduction check against the committed production record */
  const prod = (() => { try { return JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'nhl_walkforward.json'), 'utf8')); } catch (_) { return null; } })();
  const incScore = scoreModel(base, inc);
  const reproduces = !!prod && Math.abs(prod.windows.selection.by_candidate[prodChosen].moneyline.log_loss - incScore.selection.log_loss) < 1e-5 && Math.abs(prod.windows.confirmation.by_candidate[prodChosen].moneyline.log_loss - incScore.confirmation.log_loss) < 1e-5;

  /* 2. Elo (A) */
  const elo = eloTuned(base.games);
  const eloPred = new Map(); for (const g of base.scored) eloPred.set(g.game_id, elo.pred.get(g.game_id));

  /* 3. Model E */
  const rowsOf = new Map();
  for (const g of base.games) { const sn = base.snaps.get(g.game_id); rowsOf.set(g.game_id, F.row(sn.fh, sn.fa)); }
  const selSeasons = seasonsScored.filter((s) => B.inWin(s, B.SELECTION));
  const lrGrid = [];
  for (const l2 of [1, 10, 100, 1000]) { const w = walkLearner(base, rowsOf, selSeasons, (X, y) => fitLR(X, y, l2)); lrGrid.push({ l2, selection_log_loss: r6(selLL(base, w.pred)) }); }
  const lrBest = lrGrid.slice().sort((a, b) => a.selection_log_loss - b.selection_log_loss)[0];
  const lr = walkLearner(base, rowsOf, seasonsScored, (X, y) => fitLR(X, y, lrBest.l2));
  log('logistic regression: L2 ' + lrBest.l2 + ' chosen on selection');
  const gbGrid = [];
  const GB_CONFIGS = [{ max_depth: 2, rounds: 300, eta: 0.03 }, { max_depth: 3, rounds: 200, eta: 0.03 }, { max_depth: 2, rounds: 150, eta: 0.05 }, { max_depth: 3, rounds: 400, eta: 0.015 }];
  for (const cfg of GB_CONFIGS) { const w = walkLearner(base, rowsOf, selSeasons, (X, y) => { const m = GB.fit(X, y, cfg); return { predict: (x) => GB.predict(m, x) }; }); gbGrid.push(Object.assign({ selection_log_loss: r6(selLL(base, w.pred)) }, cfg)); log('gbdt ' + JSON.stringify(cfg) + ' → ' + gbGrid[gbGrid.length - 1].selection_log_loss); }
  const gbBest = gbGrid.slice().sort((a, b) => a.selection_log_loss - b.selection_log_loss)[0];
  const gbCfg = { max_depth: gbBest.max_depth, rounds: gbBest.rounds, eta: gbBest.eta };
  const gbModels = {};
  const gb = walkLearner(base, rowsOf, seasonsScored, (X, y) => { const m = GB.fit(X, y, gbCfg); return { raw: m, predict: (x) => GB.predict(m, x) }; });
  for (const [S, m] of Object.entries(gb.models)) gbModels[S] = m.raw;
  const gbPlatt = platt(base, gb.pred); const lrPlatt = platt(base, lr.pred);
  /* the calibrated version is used only if it wins on SELECTION */
  const useGbPlatt = selLL(base, gbPlatt.pred) < selLL(base, gb.pred);
  const useLrPlatt = selLL(base, lrPlatt.pred) < selLL(base, lr.pred);
  const E_lr = useLrPlatt ? lrPlatt.pred : lr.pred, E_gb = useGbPlatt ? gbPlatt.pred : gb.pred;
  log('gbdt chosen ' + JSON.stringify(gbCfg) + (useGbPlatt ? ' + Platt' : ''));

  /* 4. Model G */
  const comps = { B_incumbent: inc, A_goals_only: ml.A_goals_only, A_elo: eloPred, C_goalie_projected: ml.C_goalie_projected, E_logistic: E_lr, E_gbdt: E_gb };
  if (base.lineupOk) comps.D_lineup_projected = ml.D_lineup_projected;
  const G_stack = stack(base, comps);
  const G_mean = new Map(); for (const g of base.scored) { const ps = Object.keys(comps).map((c) => comps[c].get(g.game_id)).filter((p) => p != null); if (ps.length === Object.keys(comps).length) G_mean.set(g.game_id, ST.sigmoid(ps.reduce((a, p) => a + ST.logit(p), 0) / ps.length)); }
  log('ensembles built');

  /* 5. Model F */
  let shape = null;
  if (!arg('no-shape')) {
    const cache = SH.likelihoodCache(base.scored, (g) => lam.B_incumbent.get(g.game_id), eff, ot);
    const fits = {}; let sel = [0, 0, 0], conf = [0, 0, 0];
    for (const S of seasonsScored) { const f = SH.fit(base.scored.filter((g) => g.season >= S - 3 && g.season < S), cache); const surface = f.surface; delete f.surface; fits[S] = f; void surface; }
    for (const g of base.scored) {
      const f = fits[g.season], c = cache.get(g.game_id); if (!c) continue;
      const ki = SH.K_GRID.indexOf(f.pace_shape || 0), dr = g.reg_home === g.reg_away;
      const a = SH.loglik(c[ki], dr, f.draw_inflation), b = SH.loglik(c[0], dr, 0);
      const w = B.windowOf(g.season); const acc = w === 'selection' ? sel : w === 'confirmation' ? conf : null;
      if (acc) { acc[0] += a; acc[1] += b; acc[2]++; }
    }
    const gainSel = (sel[0] - sel[1]) / sel[2], gainConf = (conf[0] - conf[1]) / conf[2];
    const anyShape = Object.values(fits).some((f) => f.pace_shape);
    shape = {
      grid: { pace_shape: SH.K_GRID, draw_inflation: SH.D_GRID }, fits_by_season: fits,
      regulation_score_loglik_gain_per_game: { selection: r6(gainSel), confirmation: r6(gainConf) },
      pace_overdispersion_ever_chosen: anyShape,
      rule: 'adopt if the selection-window gain is ≥ 0.001 per game and the moneyline is not worse by more than 0.0002',
      adopted: gainSel >= 0.001,
      verdict: gainSel >= 0.001 ? 'ADOPTED' : 'REJECTED: the selection-window gain is ' + r6(gainSel) + ' per game (needs ≥ 0.001)' + (anyShape ? '' : '; the pace overdispersion term was never preferred by any season\'s history (the 60-minute score is not overdispersed relative to the model)'),
    };
    log('Model F: ' + shape.verdict);
  }
  /* F'': the score-effect time profile — the first period separated from the second (adopted 2026-10-13) */
  const period = periodProfile(base, (g) => lam.B_incumbent.get(g.game_id), ot);
  log('period profile: ' + period.verdict);
  /* F': a longer calibration window (every earlier season instead of three) */
  const GE = B.glmPredictions(base, { c: variants.B_incumbent }, { calWindow: 'expanding' });
  const calExp = new Map(); const calExpTot = new Map();
  for (const g of base.scored) { const L = GE.lam.get(g.game_id).c; const D = DIST.game({ lamH: L.lh, lamA: L.la, effects: eff(g), ot: ot(g) }); calExp.set(g.game_id, D.p_home); calExpTot.set(g.game_id, DIST.total(D, 5.5).over); }

  /* 6. scores, comparisons, promotion */
  const models = {
    A_goals_only: ml.A_goals_only, A_elo: eloPred, B_incumbent: inc, C_goalie_projected: ml.C_goalie_projected, C_goalie_confirmed: ml.C_goalie_confirmed,
    E_logistic: E_lr, E_gbdt: E_gb, F_calibration_expanding: calExp, G_stack: G_stack.pred, G_mean: G_mean,
  };
  if (base.lineupOk) { models.D_lineup_projected = ml.D_lineup_projected; models.D_lineup_confirmed = ml.D_lineup_confirmed; }
  if (ml.B_previous_xg_no_goalie) models.B_previous_xg_no_goalie = ml.B_previous_xg_no_goalie;
  const PROMOTABLE = ['B_previous_xg_no_goalie', 'A_goals_only', 'A_elo', 'C_goalie_projected', 'D_lineup_projected', 'E_logistic', 'E_gbdt', 'F_calibration_expanding', 'G_stack', 'G_mean'];
  const CONSISTENT = { B_previous_xg_no_goalie: true, A_goals_only: true, C_goalie_projected: true, D_lineup_projected: true, F_calibration_expanding: true, A_elo: true, E_logistic: true, E_gbdt: true, G_stack: true, G_mean: true };
  const report = {};
  for (const [name, pred] of Object.entries(models)) {
    const sc = scoreModel(base, pred);
    const vs = { selection: versus(base, pred, inc, 'selection'), confirmation: versus(base, pred, inc, 'confirmation'), live: versus(base, pred, inc, 'live') };
    report[name] = { scores: sc, vs_incumbent: name === 'B_incumbent' ? null : vs };
    if (PROMOTABLE.indexOf(name) >= 0 && pred !== inc) report[name].promotion = promotionCheck(name, sc, vs.selection, vs.confirmation, CONSISTENT[name]);
  }
  const passing = Object.values(report).filter((m) => m.promotion && m.promotion.passes).map((m) => m.promotion.model);
  passing.sort((a, b) => report[a].scores.selection.log_loss - report[b].scores.selection.log_loss);
  const decision = passing.length
    ? { decision: 'PROMOTE', model: passing[0], why: passing[0] + ' passes every rule; it would price the moneyline and, through the split solver, every market.' }
    : { decision: 'RETAIN_INCUMBENT', model: 'B_incumbent', production_model: 'edgedesk_nhl_v1:' + prodChosen, why: 'No challenger passes the promotion rule. The expected-goals GLM (edgedesk_nhl_v1:' + prodChosen + ') stays the production model; the challengers are published as research and as model disagreement.' };
  log('decision ' + decision.decision + (passing.length ? ' ' + passing[0] : ''));

  /* 7. ablation */
  const ablation = { drop: [], dropblock: [], add: [] };
  for (const name of Object.keys(variants)) {
    const m = /^(drop|dropblock|add):(.*)$/.exec(name); if (!m) continue;
    const vsSel = versus(base, ml[name], inc, 'selection'), vsConf = versus(base, ml[name], inc, 'confirmation');
    const rps = (w) => { let a = 0, b = 0, n = 0; for (const g of base.scored) if (B.windowOf(g.season) === w) { a += tot[name].get(g.game_id).rps; b += tot.B_incumbent.get(g.game_id).rps; n++; } return r6((a - b) / n); };
    const row = { feature: m[2], features: m[1] === 'add' ? (ADD[m[2]] || 'every context group') : m[1] === 'dropblock' ? BLOCKS[m[2]] : [m[2]], selection_ml_delta: vsSel.mean_diff, selection_ci95: vsSel.ci95, confirmation_ml_delta: vsConf.mean_diff, confirmation_ci95: vsConf.ci95, total_rps_delta: { selection: rps('selection'), confirmation: rps('confirmation') } };
    if (m[1] === 'drop' || m[1] === 'dropblock') row.verdict = vsSel.mean_diff >= RULE.selection_margin ? 'EARNS ITS PLACE: removing it costs ≥ 0.001 on selection' : vsSel.ci95[0] > 0 ? 'SMALL BUT REAL: removing it hurts (95% interval above zero) by less than 0.001' : 'NOT DISTINGUISHABLE: its removal is within noise on selection';
    else row.verdict = vsSel.mean_diff <= -RULE.selection_margin && vsConf.ci95[1] < 0 ? 'ADDS INFORMATION (passes the promotion margin)' : vsSel.ci95[1] < 0 ? 'SMALL: better on selection with a 95% interval below zero, but by less than 0.001' : 'NO MEASURABLE BENEFIT';
    ablation[m[1]].push(row);
    const rec = report[name] || (report[name] = {}); void rec;
  }

  /* 8. market extensions on the production model */
  const markets = marketExtensions(base, (g) => lam.B_incumbent.get(g.game_id));
  log('market extensions scored: ' + Object.keys(markets).length);

  /* 9. live parameters for the slate's model-comparison panel */
  const liveS = C.CURRENT_SEASON;
  const lrLive = (() => { const { X, y } = seasonRows(base, rowsOf, Math.max(C.FIRST_SEASON + 1, liveS - B.GLM_WINDOW), liveS - 1); const m = fitLR(X, y, lrBest.l2); return { names: F.NAMES, mean: m.mean.map(r6), sd: m.sd.map(r6), beta: m.beta.map(r6), l2: lrBest.l2, platt: useLrPlatt ? lrPlatt.fits[liveS] : null }; })();
  const gbLive = gbModels[liveS];
  const live = {
    schema: 'edgedesk_nhl_lab_live_v1', generated_at: new Date().toISOString(), for_season: liveS, train_seasons: [Math.max(C.FIRST_SEASON + 1, liveS - B.GLM_WINDOW), liveS - 1],
    features: F.NAMES, logistic: lrLive, gbdt: gbLive ? { params: gbLive.params, f0: gbLive.f0, medians: gbLive.medians, trees: gbLive.trees, platt: useGbPlatt ? gbPlatt.fits[liveS] : null } : null,
    elo: elo.params, stack: { components: G_stack.components, weights: G_stack.weights[liveS] },
    glm: { A_goals_only: G.fits[liveS].A_goals_only, C_goalie_projected: G.fits[liveS].C_goalie_projected, D_lineup_projected: G.fits[liveS].D_lineup_projected || null },
    pair_calibration: { A_goals_only: G.cal[liveS].A_goals_only, C_goalie_projected: G.cal[liveS].C_goalie_projected, D_lineup_projected: G.cal[liveS].D_lineup_projected || null },
    decision,
  };

  const out = {
    schema: SCHEMA, generated_at: live.generated_at,
    protocol: { windows: { selection: B.SELECTION, confirmation: B.CONFIRMATION, live: B.LIVE }, promotion_rule: RULE, glm_window_seasons: B.GLM_WINDOW, prediction_time: 'scheduled start − 30 min; inputs from games on earlier dates only', disclosure: 'The confirmation window had been read for the production candidates before this lab; every lab candidate was declared on 2026-10-13, after. Selection chooses; confirmation guards; the 2026-27 season onward is the clean test.' },
    data: { games_scored: base.scored.length, seasons: [C.FIRST_SEASON, C.CURRENT_SEASON], lineups: base.lineupOk, context_sources: { arenas: 'hockey/data/arenas.json (hand-entered home-arena coordinates, IANA zones)', schedule: 'the team-game table (completed games)', results: 'the team-game table, games on earlier dates only' }, feature_vector: F.NAMES },
    reproduces_production: { ok: reproduces, selection: incScore.selection.log_loss, confirmation: incScore.confirmation.log_loss, committed_selection: prod ? prod.windows.selection.by_candidate[prodChosen].moneyline.log_loss : null, committed_confirmation: prod ? prod.windows.confirmation.by_candidate[prodChosen].moneyline.log_loss : null, production_model: prodChosen },
    models: Object.fromEntries(Object.entries(report).filter(([k]) => models[k])),
    tuning: { elo: elo.params, logistic: { grid: lrGrid, chosen_l2: lrBest.l2, platt: useLrPlatt }, gbdt: { grid: gbGrid, chosen: gbCfg, platt: useGbPlatt, importance_live: gbLive ? GB.importance(gbLive, F.NAMES).slice(0, 15) : null } },
    stack_weights_by_season: G_stack.weights,
    shape,
    period_profile: period,
    calibration_window: { expanding_vs_three_seasons: { o55_confirmation: versus(base, calExpTot, new Map([...tot.B_incumbent].map(([k, v]) => [k, v.o55])), 'confirmation') }, note: 'over 5.5 compared as log loss of the expanding-window calibration against the three-season production rule; positive = worse' },
    ablation,
    markets_extended: markets,
    promotion: Object.assign({ passing }, decision),
  };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  fs.writeFileSync(LIVE_OUT, JSON.stringify(live) + '\n');
  log('wrote ' + path.relative(C.ROOT, OUT));
  for (const [k, m] of Object.entries(out.models)) console.log('  ' + k.padEnd(26) + ' sel ' + m.scores.selection.log_loss + ' conf ' + m.scores.confirmation.log_loss + ' live ' + m.scores.live.log_loss + (m.vs_incumbent ? ' | Δsel ' + m.vs_incumbent.selection.mean_diff + ' Δconf ' + m.vs_incumbent.confirmation.mean_diff + ' [' + m.vs_incumbent.confirmation.ci95.join(', ') + ']' : '') + (m.promotion ? (m.promotion.passes ? ' PASSES' : ' — ' + m.promotion.failed[0]) : ''));
  for (const a of ablation.drop.concat(ablation.dropblock, ablation.add)) console.log('  ' + a.feature.padEnd(30) + ' Δsel ' + a.selection_ml_delta + ' [' + a.selection_ci95.join(', ') + '] Δconf ' + a.confirmation_ml_delta + ' — ' + a.verdict);
}

function check() {
  const fails = [];
  let r = null; try { r = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { fails.push('no report: ' + e.message); }
  if (r) {
    if (r.schema !== SCHEMA) fails.push('schema');
    if (!r.reproduces_production || !r.reproduces_production.ok) fails.push('the lab does not reproduce the production record');
    if (!r.promotion || !/^(PROMOTE|RETAIN_INCUMBENT)$/.test(r.promotion.decision)) fails.push('no promotion decision');
    if (r.promotion && r.promotion.decision === 'PROMOTE') { const m = r.models[r.promotion.model]; if (!m || !m.promotion || !m.promotion.passes) fails.push('a promoted model that does not pass its own rule'); }
    for (const [k, m] of Object.entries(r.markets_extended || {})) if (m.market_status !== 'NOT_TESTED') fails.push(k + ' claims a market test');
  }
  if (!fs.existsSync(LIVE_OUT)) fails.push('no live lab parameters');
  if (fails.length) { console.error('[nhl lab --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl lab --check] ok: ' + Object.keys(r.models).length + ' models, decision ' + r.promotion.decision + ' (' + r.promotion.model + ')');
}

if (require.main === module) { if (arg('check')) check(); else main(); }
module.exports = { RULE, glmVariants, promotionCheck, marketStatus, fitLR, platt, stack };

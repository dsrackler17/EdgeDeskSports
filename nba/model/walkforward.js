#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — the walk-forward record of every candidate.

     node nba/model/walkforward.js                  selection window only (the test stays sealed)
     node nba/model/walkforward.js --unseal "why"   score the sealed test window once; logged
     node nba/model/walkforward.js --check          the committed record passes its rules

   THE PROTOCOL (nba/config.js WINDOWS; written before any candidate was scored)
     burn-in 2003-2007 · SELECTION 2008-2017 · TEST 2018-(last completed) · LIVE
     1. Features come from the point-in-time pass (nba/model/pass.js): a game
        is predicted 30 min before tip from games available by then.
     2. Every candidate yields a regulation-margin mean and a regulation-total
        mean. For season S its CALIBRATION (a + b·inputs, σ, the total, the
        halves) is fitted on the out-of-sample rows of S−3..S−1 only; the
        end-game shape θ and the overtime parameters likewise. ML models for S
        are trained on seasons before S (nba/model/ml.js).
     3. Each game's distribution (nba/model/distribution.js) gives every
        market; scoring is by proper rules: moneyline log loss and Brier;
        margin and total CRPS, PIT and 80% coverage; threshold calibration
        P(margin > k) for the alternate lines; first half and first quarter.
     4. CHOICE: per track, the lowest SELECTION moneyline log loss; a
        challenger must beat the incumbent by ≥ 0.001 (engine/lab/protocol).
     5. The TEST window is SEALED: it is scored only with --unseal, and every
        unsealing is appended to nba/validation/holdout_log.json with the hash
        of the frozen specification (this file, the model code and the
        tuning). A second unsealing is visible to anyone reading the record.
     6. Markets: NOT_TESTED. ESPN's displayed spread (untimestamped, no book,
        no price) is reported as a labelled DIAGNOSTIC — the model's error
        beside the line's, and calibration at the line — never as a market
        test, never as ROI.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('../config');
const PASS = require('./pass');
const ML = require('./ml');
const L = require('./learn');
const DF = require('./dist_fit');
const DIST = require('./distribution');
const SIM = require('./simulate');
const V = require('../../engine/validation');
const P = require('../../engine/lab/protocol');
const io = require('../lib/io');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const CAL = 3;
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const r5 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e5) / 1e5);

const TUNING = path.join(C.PATHS.params, 'tuning.json');
const RECORD = path.join(C.PATHS.validation, 'nba_walkforward.json');
const HOLDOUT_LOG = path.join(C.PATHS.validation, 'holdout_log.json');
const LIVE = path.join(C.PATHS.params, 'live.json');
const ML_LIVE = path.join(C.PATHS.params, 'ml_live.json');
const SUMMARY = path.join(C.PATHS.validation, 'summary.json');

/* ------------------------------------------------------------ candidates */
const CANDIDATES = [
  { id: 'home_only', family: 'baseline', label: 'Home court only', m: ['hca1'], t: [] },
  { id: 'lab_points', family: 'baseline', label: 'Basketball lab points ratings (the existing NBA model)', m: ['lab_m'], t: ['lab_t'] },
  { id: 'A_elo', family: 'A', label: 'Elo (FiveThirtyEight NBA form, tuned)', m: ['elo_z'], t: ['eff_t'] },
  { id: 'A_glicko', family: 'A', label: 'Glicko (rating deviation, tuned)', m: ['gl_z'], t: ['eff_t'] },
  { id: 'B_eff', family: 'B', label: 'Adjusted possession efficiency and pace', m: ['eff_m'], t: ['eff_t'] },
  { id: 'F_kalman', family: 'F', label: 'Bayesian dynamic model (Kalman)', m: ['kal_m'], t: ['kal_t'] },
  { id: 'D_sim', family: 'D', label: 'Possession simulation (four factors, pace, end-game fouling, overtime; level anchored to B)', m: [], t: [], special: 'sim' },
  { id: 'C_players_P', family: 'C', tracks: ['P'], label: 'Player impact (RAPM) × projected minutes', m: ['plr_m_proj'], t: ['kal_t'] },
  { id: 'C_players_C', family: 'C', tracks: ['C'], label: 'Player impact (RAPM) × confirmed availability', m: ['plr_m_conf'], t: ['kal_t'] },
  { id: 'C_team_avail_P', family: 'C', tracks: ['P'], label: 'Kalman team rating + projected availability adjustment', m: ['kal_m', 'adj_proj'], t: ['kal_t'] },
  { id: 'C_team_avail_C', family: 'C', tracks: ['C'], label: 'Kalman team rating + confirmed availability adjustment', m: ['kal_m', 'adj_conf'], t: ['kal_t'] },
  { id: 'E_ridge_P', family: 'E', tracks: ['P'], label: 'Ridge regression on all projected features', m: ['mlP_ridge_m'], t: ['mlP_ridge_t'], needs: 'P' },
  { id: 'E_logit_P', family: 'E', tracks: ['P'], label: 'Ridge logistic on all projected features', m: ['mlP_logit_z'], t: ['mlP_ridge_t'], needs: 'P' },
  { id: 'E_gbdt_P', family: 'E', tracks: ['P'], label: 'Gradient-boosted trees on all projected features', m: ['mlP_gbdt_m'], t: ['mlP_gbdt_t'], needs: 'P' },
  { id: 'E_ridge_C', family: 'E', tracks: ['C'], label: 'Ridge regression with confirmed availability', m: ['mlC_ridge_m'], t: ['mlC_ridge_t'], needs: 'C' },
  { id: 'E_logit_C', family: 'E', tracks: ['C'], label: 'Ridge logistic with confirmed availability', m: ['mlC_logit_z'], t: ['mlC_ridge_t'], needs: 'C' },
  { id: 'E_gbdt_C', family: 'E', tracks: ['C'], label: 'Gradient-boosted trees with confirmed availability', m: ['mlC_gbdt_m'], t: ['mlC_gbdt_t'], needs: 'C' },
  { id: 'G_stack_P', family: 'G', tracks: ['P'], label: 'Stacked ensemble (projected)', m: ['elo_z', 'eff_m', 'kal_m', 'adj_proj', 'mlP_ridge_m', 'mlP_gbdt_m'], t: ['eff_t', 'kal_t', 'mlP_ridge_t', 'mlP_gbdt_t'], l2: 10, needs: 'P' },
  { id: 'G_stack_C', family: 'G', tracks: ['C'], label: 'Stacked ensemble (confirmed)', m: ['elo_z', 'eff_m', 'kal_m', 'adj_conf', 'mlC_ridge_m', 'mlC_gbdt_m'], t: ['eff_t', 'kal_t', 'mlC_ridge_t', 'mlC_gbdt_t'], l2: 10, needs: 'C' },
];
/* the order in which challengers meet the incumbent (simplest first) */
const ORDER = ['A_elo', 'A_glicko', 'B_eff', 'F_kalman', 'D_sim', 'C_players_P', 'C_players_C', 'C_team_avail_P', 'C_team_avail_C', 'E_ridge_P', 'E_logit_P', 'E_gbdt_P', 'E_ridge_C', 'E_logit_C', 'E_gbdt_C', 'G_stack_P', 'G_stack_C'];
function candsFor(track) { return CANDIDATES.filter((c) => !c.tracks || c.tracks.includes(track)); }

function fx(row, k) {
  const f = row.f;
  if (k === 'hca1') return row.neutral ? 0 : 1;
  if (/_z$/.test(k)) { const p = f[k.replace(/_z$/, '_p')]; return p == null ? null : L.qnorm(p); }
  const v = f[k]; return v == null || !isFinite(v) ? null : v;
}

/* ------------------------------------------------------------ rows */
async function buildRows(tuning, o) {
  o = o || {};
  const key = crypto.createHash('sha256').update(JSON.stringify({ pass: tuning.pass, v: 3, files: ['pass.js', 'ratings.js', 'players.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')), manifest: fs.readFileSync(C.PATHS.manifest, 'utf8').length })).digest('hex').slice(0, 16);
  const name = 'pass_' + key + '.json.gz';
  if (!o.fresh && io.hasWork(name)) return io.readWork(name);
  const r = await PASS.run(tuning.pass, { log: true });
  io.writeWork(name, r.rows);
  return r.rows;
}

/** the existing basketball lab's NBA predictions (raw margin and total), by game id */
function attachLab(rows) {
  try {
    const BW = require('../../basketball/walkforward');
    const tuning = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'basketball', 'params', 'nba_tuning.json'), 'utf8'));
    const { games } = BW.load('nba');
    const { rows: lr } = BW.pass(games, tuning.chosen, tuning.elo);
    const m = new Map(lr.map((r) => [String(r.id), r]));
    let n = 0;
    for (const r of rows) { const x = m.get(String(r.id)); if (x) { r.f.lab_m = x.m; r.f.lab_t = x.t; n++; } }
    return { attached: n, source: 'basketball/walkforward.js pass() with basketball/params/nba_tuning.json' };
  } catch (e) { return { attached: 0, error: String(e.message) }; }
}

/* ------------------------------------------------------------ calibration
   Season S is calibrated on S−3..S−1 out-of-sample rows only:
     location   a + Σ b_k·x_k + Σ c_k·x_k·stage   (stage = min(games played)/60,
                capped at 1: ratings earn more weight as the season matures and
                late-season games are more lopsided — tanking and resting)
     spread     σ_i = s0 + s1·min(|μ_i|, 10), by maximum likelihood with the
                season's end-game shape (toss-ups are noisier than mismatches)
     shape      favourite-oriented end-game weights (dist_fit.fitShapeOriented),
                shared by the candidates of a season, fitted on the efficiency
                candidate's calibrated means
     overtime   the favourite's overtime edge κ, σ, the second-overtime rate and
                the points an overtime adds (dist_fit.fitOvertimeK) */
const stageOf = (r) => Math.min(1, Math.min(r.f.gp_h || 0, r.f.gp_a || 0) / 60);
function locX(row, inputs) {
  const xs = inputs.map((k) => fx(row, k)); if (xs.some((v) => v == null)) return null;
  const st = stageOf(row); return [1].concat(xs, xs.map((v) => v * st));
}
function shapeFor(prior) {
  const rows = prior.filter((r) => r.y && r.y.reg_margin != null && fx(r, 'eff_m') != null);
  if (rows.length < 500) return { shape: { sd: { s0: 12.5, s1: 0 }, theta: null }, ot: DF.fitOvertime([]) };
  const X = rows.map((r) => locX(r, ['eff_m']));
  const fit = L.ridge(X, rows.map((r) => r.y.reg_margin), { l2: 1e-6 });
  const mus = X.map((x) => L.predictLinear(fit.beta, x));
  const shape = DF.fitShapeOriented(rows.map((r, i) => ({ mu: mus[i], y: r.y.reg_margin })));
  const ot = DF.fitOvertimeK(rows.map((r, i) => ({ ot: r.y.ot, margin: r.y.margin, total: r.y.total, reg_total: r.y.reg_total, mu: mus[i] })));
  return { shape, ot };
}
function calibrate(cand, prior, shape) {
  const ok = (r) => r.y && r.y.reg_margin != null && cand.m.every((k) => fx(r, k) != null);
  const rows = prior.filter(ok); if (rows.length < 300) return null;
  const Xm = rows.map((r) => locX(r, cand.m));
  const fm = L.ridge(Xm, rows.map((r) => r.y.reg_margin), { l2: cand.l2 || 1e-6 });
  const mu = Xm.map((x) => L.predictLinear(fm.beta, x));
  const sd = DF.fitSigmaHetero(rows.map((r, i) => ({ mu: mu[i], y: r.y.reg_margin })), shape.theta, [-0.2, -0.15, -0.1, -0.05, 0]);
  const tr = rows.filter((r) => r.y.reg_total != null && cand.t.every((k) => fx(r, k) != null));
  const Xt = tr.map((r) => [1].concat(cand.t.map((k) => fx(r, k))));
  const ft = L.ridge(Xt, tr.map((r) => r.y.reg_total), { l2: cand.l2 || 1e-6 });
  const mt = Xt.map((x) => L.predictLinear(ft.beta, x));
  let ss = 0; for (let i = 0; i < tr.length; i++) ss += Math.pow(tr[i].y.reg_total - mt[i], 2);
  const sdT = Math.sqrt(ss / Math.max(1, tr.length - 1));
  /* γ: the total's dependence on how close the game was, from realised margins */
  const am = tr.map((r) => Math.abs(r.y.reg_margin)); const mam = am.reduce((a, v) => a + v, 0) / Math.max(1, am.length);
  let sxy = 0, sxx = 0; for (let i = 0; i < tr.length; i++) { const x = am[i] - mam; sxy += x * (tr[i].y.reg_total - mt[i]); sxx += x * x; }
  const gamma = sxx > 0 ? sxy / sxx : 0;
  const muByRow = new Map(rows.map((r, i) => [r.id, mu[i]])); const mtByRow = new Map(tr.map((r, i) => [r.id, mt[i]]));
  const per = (key, src) => { const xs = [], ys = []; for (const r of rows) { const v = r.y[key]; const x = src.get(r.id); if (v != null && x != null) { xs.push(x); ys.push(v); } } return DF.fitThroughOrigin(xs, ys); };
  const h1m = per('h1_margin', muByRow), h1t = per('h1_total', mtByRow), q1m = per('q1_margin', muByRow), q1t = per('q1_total', mtByRow);
  return { beta_m: fm.beta, beta_t: ft.beta, sd_m: sd, sd_t: sdT, gamma, n: rows.length,
    half: { f_m: h1m.f, sd_m: h1m.sd, f_t: h1t.f, sd_t: h1t.sd }, quarter: { f_m: q1m.f, sd_m: q1m.sd, f_t: q1t.f, sd_t: q1t.sd } };
}
function paramsFor(cand, cal, shape, ot, row) {
  const xm = locX(row, cand.m); const xt = [1].concat(cand.t.map((k) => fx(row, k)));
  if (!xm || xt.some((v) => v == null)) return null;
  const mu = L.predictLinear(cal.beta_m, xm);
  return { mu_m: mu, sd_m: DF.sdOf(cal.sd_m, mu), mu_t: L.predictLinear(cal.beta_t, xt), sd_t: cal.sd_t, theta: shape.theta, gamma: cal.gamma, ot, half: cal.half, quarter: cal.quarter };
}

/* ------------------------------------------------------------ scoring one game */
const THRESH = [-10, -5, 0, 5, 10];
function scoreRow(row, p) {
  const mg = DIST.marginals(p); const y = row.y;
  const s = { p: mg.p_home, mu_m: p.mu_m, mu_t: p.mu_t, p_ot: mg.p_ot,
    ll: V.logLoss(mg.p_home, y.hw), br: V.brier(mg.p_home, y.hw),
    crps_m: DIST.crps(mg.margin, y.margin), pit_m: DIST.pit(mg.margin, y.margin),
    crps_t: DIST.crps(mg.total, y.total), pit_t: DIST.pit(mg.total, y.total),
    em: DIST.mean(mg.margin), et: DIST.mean(mg.total), thr: THRESH.map((k) => DIST.pGreater(mg.margin, k)) };
  if (row.ref_line_home != null && isFinite(row.ref_line_home)) {
    const sp = DIST.spread(mg.margin, row.ref_line_home); const res = y.margin + row.ref_line_home;
    if (res !== 0) s.ref = { p: sp.fair, y: res > 0 ? 1 : 0, line: row.ref_line_home };
  }
  if (p.half && y.h1_margin != null) { const d = DIST.periodDist(p.half.f_m * p.mu_m, p.half.sd_m, p.half.f_t * p.mu_t, p.half.sd_t); s.h1 = { crps_m: DIST.crps(d.margin, y.h1_margin), crps_t: DIST.crps(d.total, y.h1_total), p: DIST.pGreater(d.margin, 0) + 0.5 * DIST.pEqual(d.margin, 0), y: y.h1_margin > 0 ? 1 : y.h1_margin < 0 ? 0 : 0.5, pit_t: DIST.pit(d.total, y.h1_total) }; }
  if (p.quarter && y.q1_margin != null) { const d = DIST.periodDist(p.quarter.f_m * p.mu_m, p.quarter.sd_m, p.quarter.f_t * p.mu_t, p.quarter.sd_t); s.q1 = { crps_m: DIST.crps(d.margin, y.q1_margin), crps_t: DIST.crps(d.total, y.q1_total), pit_t: DIST.pit(d.total, y.q1_total) }; }
  return s;
}

/** the simulation scored as a structural model: its own empirical distribution, no calibration */
function scoreSim(row, n) {
  const sim = SIM.simulate(row.f, { n: n || 600, seed: Number(row.id) % 2147483647 });
  const d = SIM.toDists(sim); const y = row.y;
  const s = { p: d.p_home, mu_m: DIST.mean(d.margin), mu_t: DIST.mean(d.total), p_ot: d.p_ot, ll: V.logLoss(d.p_home, y.hw), br: V.brier(d.p_home, y.hw),
    crps_m: DIST.crps(d.margin, y.margin), pit_m: DIST.pit(d.margin, y.margin), crps_t: DIST.crps(d.total, y.total), pit_t: DIST.pit(d.total, y.total),
    em: DIST.mean(d.margin), et: DIST.mean(d.total), thr: THRESH.map((k) => DIST.pGreater(d.margin, k)) };
  if (row.ref_line_home != null && isFinite(row.ref_line_home)) { const sp = DIST.spread(d.margin, row.ref_line_home); const res = y.margin + row.ref_line_home; if (res !== 0) s.ref = { p: sp.fair, y: res > 0 ? 1 : 0, line: row.ref_line_home }; }
  return s;
}

/* ------------------------------------------------------------ summaries */
function pitHist(v) { const h = new Array(10).fill(0); for (const x of v) h[Math.min(9, Math.floor(x * 10))]++; return h.map((c) => r4(c / Math.max(1, v.length))); }
function summarize(list) {
  const n = list.length; if (!n) return { n: 0 };
  const ml = V.binary(list.map((x) => ({ p: x.s.p, y: x.r.y.hw })));
  const mean = (f) => list.reduce((a, x) => a + f(x), 0) / n;
  const cover = (k) => list.filter((x) => x.s[k] > 0.1 && x.s[k] < 0.9).length / n;
  const out = { n, seasons: new Set(list.map((x) => x.r.season)).size,
    moneyline: { log_loss: ml.log_loss, brier: ml.brier, brier_skill: ml.brier_skill, calibration_in_the_large: ml.calibration_in_the_large, calibration_slope: ml.calibration_slope, bins: ml.bins },
    margin: { crps: r4(mean((x) => x.s.crps_m)), mean_bias: r4(mean((x) => x.s.em - x.r.y.margin)), mae: r4(mean((x) => Math.abs(x.s.em - x.r.y.margin))), coverage_80: r4(cover('pit_m')), pit: pitHist(list.map((x) => x.s.pit_m)) },
    total: { crps: r4(mean((x) => x.s.crps_t)), mean_bias: r4(mean((x) => x.s.et - x.r.y.total)), mae: r4(mean((x) => Math.abs(x.s.et - x.r.y.total))), coverage_80: r4(cover('pit_t')), pit: pitHist(list.map((x) => x.s.pit_t)) },
    overtime: { mean_p: r4(mean((x) => x.s.p_ot)), observed: r4(mean((x) => (x.r.y.ot > 0 ? 1 : 0))) },
    thresholds: THRESH.map((k, i) => { const b = V.binary(list.map((x) => ({ p: x.s.thr[i], y: x.r.y.margin > k ? 1 : 0 }))); return { k, log_loss: b.log_loss, citl: b.calibration_in_the_large, slope: b.calibration_slope }; }),
  };
  const h1 = list.filter((x) => x.s.h1); if (h1.length) out.first_half = { n: h1.length, crps_margin: r4(h1.reduce((a, x) => a + x.s.h1.crps_m, 0) / h1.length), crps_total: r4(h1.reduce((a, x) => a + x.s.h1.crps_t, 0) / h1.length), total_coverage_80: r4(h1.filter((x) => x.s.h1.pit_t > 0.1 && x.s.h1.pit_t < 0.9).length / h1.length) };
  const q1 = list.filter((x) => x.s.q1); if (q1.length) out.first_quarter = { n: q1.length, crps_margin: r4(q1.reduce((a, x) => a + x.s.q1.crps_m, 0) / q1.length), crps_total: r4(q1.reduce((a, x) => a + x.s.q1.crps_t, 0) / q1.length), total_coverage_80: r4(q1.filter((x) => x.s.q1.pit_t > 0.1 && x.s.q1.pit_t < 0.9).length / q1.length) };
  const ref = list.filter((x) => x.s.ref);
  if (ref.length) {
    const b = V.binary(ref.map((x) => ({ p: x.s.ref.p, y: x.s.ref.y })));
    const strong = ref.filter((x) => Math.abs(x.s.ref.p - 0.5) >= 0.05);
    const agree = strong.filter((x) => (x.s.ref.p > 0.5) === (x.s.ref.y === 1)).length;
    out.reference_line_diagnostic = { n: ref.length, label: 'DIAGNOSTIC ONLY — ESPN displayed spread: no timestamp, no book, no price. Not a market test; no ROI.',
      cover_log_loss: b.log_loss, cover_calibration_slope: b.calibration_slope, cover_citl: b.calibration_in_the_large,
      model_margin_mae: r4(ref.reduce((a, x) => a + Math.abs(x.s.em - x.r.y.margin), 0) / ref.length),
      line_margin_mae: r4(ref.reduce((a, x) => a + Math.abs(-x.s.ref.line - x.r.y.margin), 0) / ref.length),
      disagreements_ge_5pts_prob: { n: strong.length, side_correct_rate: strong.length ? r4(agree / strong.length) : null } };
  }
  return out;
}

/* ------------------------------------------------------------ the run */
function specHash(tuning) {
  const files = ['walkforward.js', 'pass.js', 'ratings.js', 'players.js', 'ml.js', 'learn.js', 'dist_fit.js', 'distribution.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'));
  return crypto.createHash('sha256').update(JSON.stringify({ tuning, files })).digest('hex');
}

async function run(o) {
  o = o || {};
  const W = C.windows();
  const tuning = fs.existsSync(TUNING) ? JSON.parse(fs.readFileSync(TUNING, 'utf8')) : { pass: {}, ml: {} };
  const unseal = !!o.unseal;
  const rows = await buildRows(tuning, { fresh: o.fresh });
  const lab = attachLab(rows);
  const lastScored = unseal ? W.test[1] : W.selection[1];
  /* ML: out-of-sample predictions season by season, through the last season scored */
  const mlInfo = {};
  for (const track of ['P', 'C']) mlInfo[track] = ML.fitPredict(rows.filter((r) => r.season <= lastScored), track, Object.assign({}, tuning.ml), { log: true });

  const out = { cands: {}, cal: {}, shapes: {}, ot: {} };
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b).filter((s) => s >= W.selection[0] && s <= lastScored);
  const scored = {}; for (const c of CANDIDATES) scored[c.id] = [];
  for (const s of seasons) {
    const prior = rows.filter((r) => r.season >= s - CAL && r.season < s && r.y);
    const so = shapeFor(prior); const shape = so.shape; const ot = so.ot;
    out.shapes[s] = shape; out.ot[s] = ot;
    const target = rows.filter((r) => r.season === s && r.y);
    for (const c of CANDIDATES) {
      if (c.special === 'sim') { for (const r of target) scored[c.id].push({ r, s: scoreSim(r) }); continue; }
      const cal = calibrate(c, prior, shape); if (!cal) continue;
      (out.cal[c.id] = out.cal[c.id] || {})[s] = { beta_m: cal.beta_m.map(r5), beta_t: cal.beta_t.map(r5), sd_m: { s0: r4(cal.sd_m.s0), s1: r4(cal.sd_m.s1) }, sd_t: r4(cal.sd_t), gamma: r4(cal.gamma), n: cal.n };
      for (const r of target) { const p = paramsFor(c, cal, shape, ot, r); if (p) scored[c.id].push({ r, s: scoreRow(r, p) }); }
    }
    console.error('[nba wf] scored ' + s + ' (' + target.length + ' games)');
  }
  return { rows, scored, out, tuning, lab, mlInfo, W, unseal, seasons };
}

function compareOn(scored, a, b, win, metric) {
  const A = new Map(scored[a].filter((x) => P.inWin(x.r.season, win)).map((x) => [x.r.id, x]));
  const pairs = scored[b].filter((x) => P.inWin(x.r.season, win) && A.has(x.r.id)).map((x) => ({ date: x.r.date, a: metric(A.get(x.r.id)), b: metric(x) }));
  if (pairs.length < 50) return null;
  return V.pairedBootstrap(pairs, { B: 1000 });
}

async function main() {
  const unsealWhy = arg('unseal', null);
  const R = await run({ unseal: !!unsealWhy, fresh: flag('fresh') });
  const { scored, out, W } = R;
  const windows = { selection: W.selection, test: W.test };
  const report = {
    schema: C.SCHEMA.validation, generated_at: new Date().toISOString(), spec_hash: specHash(R.tuning),
    protocol: { windows: C.windows(), calibration_seasons: CAL, prediction_time: 'scheduled tip − 30 min; inputs: games whose assumed availability (start + 4 h) is before it', rules: P.RULES, choice: 'per track, lowest SELECTION moneyline log loss; a challenger must beat the incumbent by ≥ ' + P.RULES.challenger_margin,
      tracks: { P: 'projected availability: never reads this game\'s box or who played in it', C: 'confirmed availability: who played in this game, assumed known at tip − 30 min (inactive list and starters)' },
      test_window: R.unseal ? 'UNSEALED (see holdout_log.json)' : 'SEALED: not scored in this run' },
    data: { source: 'nba/data (sportsdataverse hoopR-nba-data, from ESPN)', license: C.LICENSE, games_scored: Object.fromEntries(Object.entries(scored).map(([k, v]) => [k, v.length])),
      temporal: { point_in_time: 'RETROSPECTIVE', known_at: 'blank (first publication unknown; never backdated)', assumed_available_at: 'start + 4 h' } },
    leakage: V.leakageAudit(R.rows.filter((r) => r.season >= W.selection[0]).map((r) => ({ id: r.id, predicted_at: r.predicted_at, event_start: r.start, inputs_known_at: r.inputs_known_at }))),
    lab_baseline: R.lab,
    candidates: CANDIDATES.map((c) => ({ id: c.id, family: c.family, label: c.label, tracks: c.tracks || ['P', 'C'], margin_inputs: c.m, total_inputs: c.t })),
    windows: {}, by_season: {}, choice: {}, comparisons: {}, markets: {}, ml: { features: { P: ML.featureNames('P'), C: ML.featureNames('C') }, importance: { P: R.mlInfo.P.importance, C: R.mlInfo.C.importance }, cfg: Object.assign({}, ML.DEFAULT_CFG, R.tuning.ml) },
    distribution: { shapes: out.shapes, overtime: out.ot },
    calibration: out.cal,
  };
  for (const [wn, win] of Object.entries(windows)) {
    if (wn === 'test' && !R.unseal) { report.windows.test = { status: 'SEALED' }; continue; }
    report.windows[wn] = {};
    for (const c of CANDIDATES) { const list = scored[c.id].filter((x) => P.inWin(x.r.season, win)); if (list.length) report.windows[wn][c.id] = summarize(list); }
  }
  for (const c of CANDIDATES) {
    const bs = {}; for (const x of scored[c.id]) { if (!R.unseal && x.r.season > W.selection[1]) continue; (bs[x.r.season] = bs[x.r.season] || []).push(x); }
    report.by_season[c.id] = Object.fromEntries(Object.entries(bs).map(([s, l]) => [s, { n: l.length, ml_log_loss: r5(l.reduce((a, x) => a + x.s.ll, 0) / l.length), margin_crps: r4(l.reduce((a, x) => a + x.s.crps_m, 0) / l.length), total_crps: r4(l.reduce((a, x) => a + x.s.crps_t, 0) / l.length) }]));
  }
  /* the choice, per track, on SELECTION only */
  const sel = report.windows.selection;
  for (const track of ['P', 'C']) {
    const ids = ORDER.filter((id) => candsFor(track).some((c) => c.id === id) && sel[id]);
    const ll = Object.fromEntries(ids.map((id) => [id, sel[id].moneyline.log_loss]));
    const chosen = P.choose(ll, ids);
    report.choice[track] = { chosen, selection_ml_log_loss: ll };
    const cmp = {};
    for (const wn of R.unseal ? ['selection', 'test'] : ['selection']) {
      const win = windows[wn]; const cw = {};
      for (const base of ['A_elo', 'lab_points', 'home_only', 'B_eff', 'F_kalman'].concat(ids)) {
        if (base === chosen || !scored[base] || !scored[base].length) continue;
        cw[chosen + '_vs_' + base] = { moneyline_log_loss: compareOn(scored, chosen, base, win, (x) => x.s.ll), margin_crps: compareOn(scored, chosen, base, win, (x) => x.s.crps_m), total_crps: compareOn(scored, chosen, base, win, (x) => x.s.crps_t) };
      }
      cmp[wn] = cw;
    }
    report.comparisons[track] = cmp;
    /* market statuses on the window that decides them: the test if unsealed, else selection (labelled) */
    const wn = R.unseal ? 'test' : 'selection'; const w = report.windows[wn][chosen];
    if (w) {
      const vsElo = cmp[wn][chosen + '_vs_A_elo'];
      const beats = vsElo && vsElo.moneyline_log_loss ? vsElo.moneyline_log_loss.a_better : false;
      const st = P.binaryStatus({ n: w.n, calibration_in_the_large: w.moneyline.calibration_in_the_large, calibration_slope: w.moneyline.calibration_slope }, w.seasons, beats);
      const mDist = { n: w.n, coverage_80: w.margin.coverage_80, mean_bias: w.margin.mean_bias, mean_outcome: 10 };
      const tDist = { n: w.n, coverage_80: w.total.coverage_80, mean_bias: w.total.mean_bias, mean_outcome: 210 };
      const vsM = cmp[wn][chosen + '_vs_home_only']; const vsT = cmp[wn][chosen + '_vs_A_elo'];
      report.markets[track] = { window: wn + (R.unseal ? '' : ' (test sealed: provisional by construction)'),
        moneyline: Object.assign({ market: 'moneyline (incl. overtime)' }, R.unseal ? st : { status: 'PROVISIONAL', failed: ['test window sealed'].concat(st.failed) }, P.MARKET_NOT_TESTED),
        spread: Object.assign({ market: 'point spread (margin distribution, incl. overtime)' }, P.distributionStatus(mDist, w.seasons, vsM && vsM.margin_crps ? vsM.margin_crps.a_better : false), R.unseal ? {} : { status: 'PROVISIONAL' }, P.MARKET_NOT_TESTED),
        total: Object.assign({ market: 'total points (incl. overtime)' }, P.distributionStatus(tDist, w.seasons, vsT && vsT.total_crps ? vsT.total_crps.a_better : false), R.unseal ? {} : { status: 'PROVISIONAL' }, P.MARKET_NOT_TESTED) };
    }
  }
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  /* A sealed rerun (the weekly job) never erases a test record scored at an
     unsealing — but only the SAME specification may keep it: if the code or the
     tuning changed, that specification was never tested and the window is
     sealed again. */
  if (!R.unseal) {
    let prev = null; try { prev = JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch (_) {}
    if (prev && prev.windows && prev.windows.test && prev.windows.test.status !== 'SEALED') {
      if (prev.spec_hash === report.spec_hash) {
        report.windows.test = prev.windows.test; report.markets = prev.markets; report.protocol.test_window = prev.protocol.test_window + ' (carried from the unsealing with this specification)';
        for (const t of ['P', 'C']) if (prev.comparisons[t] && prev.comparisons[t].test) report.comparisons[t].test = prev.comparisons[t].test;
        for (const id of Object.keys(prev.by_season || {})) for (const [ss, v] of Object.entries(prev.by_season[id])) if (Number(ss) >= W.test[0] && report.by_season[id]) report.by_season[id][ss] = v;
      } else report.protocol.test_window = 'SEALED: the specification changed since the last unsealing (' + String(prev.spec_hash).slice(0, 12) + ' → ' + report.spec_hash.slice(0, 12) + '); this one has not been tested on the holdout';
    }
  }
  if (R.unseal) {
    let log = []; try { log = JSON.parse(fs.readFileSync(HOLDOUT_LOG, 'utf8')).unsealings || []; } catch (_) {}
    log.push({ at: report.generated_at, spec_hash: report.spec_hash, reason: unsealWhy, test_window: W.test, chosen: { P: report.choice.P.chosen, C: report.choice.C.chosen } });
    fs.writeFileSync(HOLDOUT_LOG, JSON.stringify({ schema: 'edgedesk_nba_holdout_log_v1', rule: 'every scoring of the sealed test window is appended here with the hash of the frozen specification; more than one entry means the test was looked at more than once', unsealings: log }, null, 1) + '\n');
  }
  fs.writeFileSync(RECORD, JSON.stringify(report, null, 1) + '\n');
  fs.writeFileSync(SUMMARY, JSON.stringify(summaryOf(report)) + '\n');
  printSummary(report);
  return report;
}

/** the compact record the research panel reads (nba/validation/summary.json) */
function summaryOf(rep) {
  const sealed = rep.windows.test && rep.windows.test.status === 'SEALED';
  const decisive = sealed ? 'selection' : 'test';
  const compact = (w) => { if (!w || w.status === 'SEALED') return w; const o = {}; for (const [id, x] of Object.entries(w)) { const ref = x.reference_line_diagnostic; o[id] = { n: x.n, ml_log_loss: x.moneyline.log_loss, brier: x.moneyline.brier, slope: x.moneyline.calibration_slope, citl: x.moneyline.calibration_in_the_large, margin_crps: x.margin.crps, margin_cov80: x.margin.coverage_80, total_crps: x.total.crps, total_cov80: x.total.coverage_80, total_bias: x.total.mean_bias, h1_margin_crps: x.first_half ? x.first_half.crps_margin : null, q1_margin_crps: x.first_quarter ? x.first_quarter.crps_margin : null, p_ot: x.overtime.mean_p, ot_observed: x.overtime.observed, ref_model_mae: ref ? ref.model_margin_mae : null, ref_line_mae: ref ? ref.line_margin_mae : null }; } return o; };
  const chosen = rep.choice.P && rep.choice.P.chosen;
  const cmp = {}; const cw = (rep.comparisons.P || {})[decisive] || {};
  for (const [k, v] of Object.entries(cw)) if (v && v.moneyline_log_loss) cmp[k + '_ml_log_loss'] = v.moneyline_log_loss;
  for (const k of [chosen + '_vs_A_elo', chosen + '_vs_lab_points']) if (cw[k]) { if (cw[k].margin_crps) cmp[k + '_margin_crps'] = cw[k].margin_crps; if (cw[k].total_crps) cmp[k + '_total_crps'] = cw[k].total_crps; }
  const w = rep.windows[decisive] && rep.windows[decisive][chosen];
  return { schema: 'edgedesk_nba_record_summary_v1', generated_at: rep.generated_at, spec_hash: rep.spec_hash,
    protocol: 'Walk-forward: every game predicted 30 minutes before tip from games available by then; each season calibrated on the three before it; the model chosen on the selection window; the test window sealed until every choice was frozen.',
    test_status: sealed ? 'SEALED' : 'UNSEALED', test_note: sealed ? 'The test window has not been scored: the record shown is the selection window, where the model was chosen (optimistic by construction).' : 'The test window was scored once with the frozen specification (nba/validation/holdout_log.json).',
    window_ranges: { selection: rep.protocol.windows.selection, test: rep.protocol.windows.test }, windows: { selection: compact(rep.windows.selection), test: compact(rep.windows.test) },
    labels: Object.fromEntries(rep.candidates.map((c) => [c.id, c.label])), choice: { P: rep.choice.P && rep.choice.P.chosen, C: rep.choice.C && rep.choice.C.chosen }, comparisons: cmp, markets: rep.markets, leakage: { checked: rep.leakage.checked, violations: rep.leakage.violations },
    reference_line_note: 'Ref-line MAE: the model\'s margin error beside the error of ESPN\'s displayed spread on the same games. That spread has no timestamp, names no book and carries no price, so it is a DIAGNOSTIC of accuracy, never a market test and never a basis for ROI.',
    calibration_window: decisive, calibration_bins: w ? (rep.windows[decisive][chosen].moneyline.bins || null) : null };
}

function printSummary(rep) {
  for (const wn of ['selection', 'test']) {
    const w = rep.windows[wn]; if (!w || w.status === 'SEALED') { console.log('== ' + wn + ': SEALED'); continue; }
    console.log('== ' + wn);
    console.log('   ' + 'candidate'.padEnd(16) + 'n'.padStart(6) + '  ML LL    Brier   slope  citl   | marg CRPS cov80 | tot CRPS cov80 bias | 1H CRPS m/t | ref MAE model/line');
    for (const [id, s] of Object.entries(w)) {
      const ref = s.reference_line_diagnostic;
      console.log('   ' + id.padEnd(16) + String(s.n).padStart(6) + '  ' + String(s.moneyline.log_loss).padEnd(8) + ' ' + String(s.moneyline.brier).padEnd(7) + ' ' + String(s.moneyline.calibration_slope).padEnd(6) + ' ' + String(s.moneyline.calibration_in_the_large).padEnd(7)
        + '| ' + String(s.margin.crps).padEnd(8) + ' ' + String(s.margin.coverage_80).padEnd(6) + '| ' + String(s.total.crps).padEnd(8) + ' ' + String(s.total.coverage_80).padEnd(6) + String(s.total.mean_bias).padEnd(7)
        + '| ' + (s.first_half ? s.first_half.crps_margin + '/' + s.first_half.crps_total : '—') + ' | ' + (ref ? ref.model_margin_mae + '/' + ref.line_margin_mae : '—'));
    }
  }
  for (const t of ['P', 'C']) console.log('choice ' + t + ': ' + (rep.choice[t] && rep.choice[t].chosen));
}

function check() {
  const r = JSON.parse(fs.readFileSync(RECORD, 'utf8')); const fails = [];
  if (r.schema !== C.SCHEMA.validation) fails.push('schema');
  if (!r.leakage || r.leakage.violations !== 0) fails.push('leakage violations ' + (r.leakage && r.leakage.violations));
  if (!r.data || !r.data.temporal || r.data.temporal.point_in_time !== 'RETROSPECTIVE') fails.push('must say retrospective');
  for (const t of Object.keys(r.markets || {})) for (const [k, m] of Object.entries(r.markets[t])) if (m && typeof m === 'object' && m.market_status && m.market_status !== 'NOT_TESTED') fails.push(t + ' ' + k + ' claims a market test');
  if (r.windows && r.windows.test && r.windows.test.status !== 'SEALED') {
    let log = null; try { log = JSON.parse(fs.readFileSync(HOLDOUT_LOG, 'utf8')); } catch (_) {}
    if (!log || !log.unsealings || !log.unsealings.some((u) => u.spec_hash === r.spec_hash)) fails.push('the test window is scored but no unsealing with this spec hash is logged');
  }
  if (fails.length) { console.error('[nba walkforward --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nba walkforward --check] ok: choice P ' + r.choice.P.chosen + ', C ' + r.choice.C.chosen + '; test ' + (r.windows.test && r.windows.test.status === 'SEALED' ? 'sealed' : 'unsealed and logged'));
}

module.exports = { summaryOf, SUMMARY, CANDIDATES, ORDER, candsFor, fx, buildRows, attachLab, calibrate, paramsFor, shapeFor, locX, stageOf, scoreRow, scoreSim, summarize, specHash, run, TUNING, RECORD, LIVE, ML_LIVE, HOLDOUT_LOG, CAL };

if (require.main === module) {
  if (flag('check')) check();
  else main().catch((e) => { console.error(e); process.exit(1); });
}

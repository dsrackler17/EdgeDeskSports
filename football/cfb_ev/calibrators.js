/* ============================================================================
   EdgeDesk EV — the calibrator FITS (docs/edgedesk-ev/PREREG.md §3).

   Fitting lives here and runs in node only; APPLYING a fitted map has one home,
   lib/edgedesk_ev.js applyCalibrator, and every fit below is returned in the
   shape that function applies (tests pin fit → apply round trips).

     identity       no parameters
     temperature    σ(logit p / T)                       1 parameter
     platt          σ(a + b·logit p)                     2
     beta           σ(c + a·ln p − b·ln(1−p)), a,b ≥ 0   3 (Kull, Silva Filho & Flach 2017)
     rolling_platt  Platt on the most recent season only (a drift challenger)
     isotonic       pool-adjacent-violators, linear between block centres
     venn_abers     inductive Venn-Abers on the calibration set (merged p)

   Metrics (proper scores first): Brier, log loss, calibration slope and
   calibration-in-the-large with Wald CIs, ECE (10 equal-mass bins — a
   binning-dependent diagnostic, biased upward at small n), a reliability
   curve with Wilson intervals, the Murphy decomposition and AUC.
   ========================================================================== */
'use strict';
const path = require('path');
global.window = global.window || global;
const EV = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_ev.js'));

const EPS = 1e-4;
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function logit(p) { p = clamp(p, EPS, 1 - EPS); return Math.log(p / (1 - p)); }
function sigm(x) { return 1 / (1 + Math.exp(-x)); }

/* Newton–Raphson logistic regression on feature rows X (with any intercept
   column included by the caller); a tiny ridge keeps a separable fit finite */
function logistic(X, y, opts) {
  opts = opts || {};
  const k = X[0].length, lam = opts.ridge == null ? 1e-6 : opts.ridge, off = opts.offset || null;
  let beta = opts.start ? opts.start.slice() : new Array(k).fill(0);
  for (let it = 0; it < 100; it++) {
    const g = new Array(k).fill(0), H = [];
    for (let i = 0; i < k; i++) H.push(new Array(k).fill(0));
    for (let n = 0; n < X.length; n++) {
      let z = off ? off[n] : 0;
      for (let j = 0; j < k; j++) z += beta[j] * X[n][j];
      const p = sigm(z), w = p * (1 - p), e = y[n] - p;
      for (let j = 0; j < k; j++) { g[j] += e * X[n][j]; for (let l = 0; l < k; l++) H[j][l] += w * X[n][j] * X[n][l]; }
    }
    for (let j = 0; j < k; j++) { g[j] -= lam * beta[j]; H[j][j] += lam; }
    const step = solve(H, g);
    if (!step) break;
    let mx = 0;
    for (let j = 0; j < k; j++) { beta[j] += step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-10) break;
  }
  /* the covariance (inverse Fisher information) for Wald intervals */
  const H = [];
  for (let i = 0; i < k; i++) H.push(new Array(k).fill(0));
  for (let n = 0; n < X.length; n++) {
    let z = off ? off[n] : 0;
    for (let j = 0; j < k; j++) z += beta[j] * X[n][j];
    const p = sigm(z), w = p * (1 - p);
    for (let j = 0; j < k; j++) for (let l = 0; l < k; l++) H[j][l] += w * X[n][j] * X[n][l];
  }
  const cov = invert(H);
  return { beta: beta, se: cov ? cov.map((row, i) => Math.sqrt(Math.max(0, row[i]))) : null };
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function invert(A) {
  const n = A.length, out = [];
  for (let i = 0; i < n; i++) { const e = new Array(n).fill(0); e[i] = 1; const x = solve(A, e); if (!x) return null; out.push(x); }
  return out[0].map((_, i) => out.map((row) => row[i]));
}

/* --------------------------------------------------------------- the fits */
function fitIdentity() { return { method: 'identity' }; }
function fitPlatt(p, y) {
  const f = logistic(p.map((x) => [1, logit(x)]), y);
  return { method: 'platt', a: f.beta[0], b: f.beta[1], se: f.se };
}
function fitTemperature(p, y) {
  const f = logistic(p.map((x) => [logit(x)]), y);
  const b = f.beta[0];
  return { method: 'temperature', T: b > 1e-6 ? 1 / b : 1e6, inv_T: b };
}
function fitBeta(p, y) {
  /* σ(c + a·ln p − b·ln(1−p)); a negative a or b is refitted without that term (Kull et al. §3) */
  const lp = p.map((x) => Math.log(clamp(x, EPS, 1 - EPS))), lq = p.map((x) => -Math.log(1 - clamp(x, EPS, 1 - EPS)));
  let f = logistic(p.map((x, i) => [1, lp[i], lq[i]]), y);
  let c = f.beta[0], a = f.beta[1], b = f.beta[2];
  if (a < 0) { f = logistic(p.map((x, i) => [1, lq[i]]), y); c = f.beta[0]; a = 0; b = f.beta[1]; }
  else if (b < 0) { f = logistic(p.map((x, i) => [1, lp[i]]), y); c = f.beta[0]; a = f.beta[1]; b = 0; }
  if (a < 0) a = 0; if (b < 0) b = 0;
  return { method: 'beta', a: a, b: b, c: c };
}
function fitIsotonic(p, y) {
  const idx = p.map((x, i) => i).sort((i, j) => p[i] - p[j]);
  const blocks = [];
  idx.forEach((i) => {
    blocks.push({ xs: p[i], s: y[i], w: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.s / a.w <= b.s / b.w) break;
      a.xs += b.xs; a.s += b.s; a.w += b.w; blocks.pop();
    }
  });
  /* block centres; the ends clamped away from 0 and 1 so a log loss stays finite */
  const x = blocks.map((b) => b.xs / b.w), yy = blocks.map((b) => clamp(b.s / b.w, EPS, 1 - EPS));
  return { method: 'isotonic', x: x.map((v) => +v.toFixed(6)), y: yy.map((v) => +v.toFixed(6)), blocks: blocks.length };
}
function fitVennAbers(p, y) {
  const idx = p.map((x, i) => i).sort((i, j) => p[i] - p[j]);
  return { method: 'venn_abers', scores: idx.map((i) => +p[i].toFixed(6)), labels: idx.map((i) => y[i]) };
}
const FITS = { identity: fitIdentity, temperature: fitTemperature, platt: fitPlatt, beta: fitBeta, isotonic: fitIsotonic, venn_abers: fitVennAbers };
const ORDER = ['identity', 'temperature', 'platt', 'beta', 'rolling_platt', 'isotonic', 'venn_abers'];
const PARAMS = { identity: 0, temperature: 1, platt: 2, beta: 3, rolling_platt: 2, isotonic: 'nonparametric', venn_abers: 'nonparametric' };
function apply(map, p) { return clamp(EV.applyCalibrator(map, p), 1e-6, 1 - 1e-6); }

/* ------------------------------------------------------------------ metrics */
function brier(p, y) { let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) * (p[i] - y[i]); return s / p.length; }
function logloss(p, y) { let s = 0; for (let i = 0; i < p.length; i++) { const q = clamp(p[i], 1e-6, 1 - 1e-6); s -= y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q); } return s / p.length; }
function slopeIntercept(p, y) {
  const z = p.map(logit);
  const f2 = logistic(z.map((v) => [1, v]), y);
  const f1 = logistic(z.map(() => [1]), y, { offset: z });
  const ci = (b, se) => se == null ? null : [+(b - 1.96 * se).toFixed(4), +(b + 1.96 * se).toFixed(4)];
  return { slope: +f2.beta[1].toFixed(4), slope_ci95: ci(f2.beta[1], f2.se && f2.se[1]), citl: +f1.beta[0].toFixed(4), citl_ci95: ci(f1.beta[0], f1.se && f1.se[0]) };
}
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), h = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
  return [+((c - h) / d).toFixed(4), +((c + h) / d).toFixed(4)];
}
function bins(p, y, nb) {
  const idx = p.map((x, i) => i).sort((i, j) => p[i] - p[j]), out = [];
  for (let b = 0; b < nb; b++) {
    const lo = Math.floor(b * idx.length / nb), hi = Math.floor((b + 1) * idx.length / nb);
    const ii = idx.slice(lo, hi);
    if (!ii.length) continue;
    const mp = ii.reduce((s, i) => s + p[i], 0) / ii.length, k = ii.reduce((s, i) => s + y[i], 0);
    out.push({ n: ii.length, mean_p: +mp.toFixed(4), observed: +(k / ii.length).toFixed(4), wilson95: wilson(k, ii.length), p_lo: +p[ii[0]].toFixed(4), p_hi: +p[ii[ii.length - 1]].toFixed(4) });
  }
  return out;
}
function ece(b, n) { return b.reduce((s, x) => s + x.n / n * Math.abs(x.observed - x.mean_p), 0); }
function murphy(b, y) {
  const n = b.reduce((s, x) => s + x.n, 0), ybar = y.reduce((s, v) => s + v, 0) / y.length;
  const rel = b.reduce((s, x) => s + x.n * Math.pow(x.mean_p - x.observed, 2), 0) / n;
  const res = b.reduce((s, x) => s + x.n * Math.pow(x.observed - ybar, 2), 0) / n;
  return { reliability: +rel.toFixed(5), resolution: +res.toFixed(5), uncertainty: +(ybar * (1 - ybar)).toFixed(5),
    note: 'Murphy decomposition on 10 equal-mass bins (Brier ≈ REL − RES + UNC; within-bin variance makes it inexact, and REL is biased upward at small n — Ferro & Fricker 2012)' };
}
function auc(p, y) {
  const idx = p.map((x, i) => i).sort((i, j) => p[i] - p[j]);
  let rank = 0, sumPos = 0, nPos = 0, i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) { if (y[idx[k]] === 1) { sumPos += avg; nPos++; } }
    i = j + 1;
  }
  const nNeg = idx.length - nPos;
  return nPos && nNeg ? +((sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg)).toFixed(4) : null;
}
function metrics(p, y) {
  const b = bins(p, y, 10), si = slopeIntercept(p, y);
  return { n: p.length, brier: +brier(p, y).toFixed(6), log_loss: +logloss(p, y).toFixed(6), slope: si.slope, slope_ci95: si.slope_ci95, citl: si.citl, citl_ci95: si.citl_ci95,
    ece: +ece(b, p.length).toFixed(5), ece_caveat: 'binning-dependent; biased upward at small n', auc: auc(p, y), mean_p: +(p.reduce((s, v) => s + v, 0) / p.length).toFixed(4),
    base_rate: +(y.reduce((s, v) => s + v, 0) / y.length).toFixed(4), reliability_curve: b, decomposition: murphy(b, y) };
}

module.exports = { logistic, fitPlatt, fitTemperature, fitBeta, fitIsotonic, fitVennAbers, fitIdentity, FITS, ORDER, PARAMS, apply, metrics, brier, logloss, bins, wilson, auc, slopeIntercept, logit, sigm };

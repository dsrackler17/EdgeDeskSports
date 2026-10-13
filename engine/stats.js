'use strict';
/* ===========================================================================
   EdgeDesk ENGINE — the statistics every sport model fits with.

   Dependency-free and deterministic: the same rows in the same order give the
   same coefficients to the last bit, so a committed model can be rebuilt and
   compared byte for byte.

     logistic(X, y, {l2, weights})      IRLS with an L2 ridge (intercept unpenalised)
     poisson(X, y, {l2, offset})        IRLS, log link, optional exposure offset
     predictLogistic / predictPoisson
     solve(A, b)                        Cholesky with a jitter fallback
     standardize(rows, names)           column means / sds for a design matrix

   Metrics live in engine/validation.js.
   =========================================================================== */

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function sigmoid(z) { if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); } const e = Math.exp(z); return e / (1 + e); }
function logit(p) { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); return Math.log(q / (1 - q)); }

/* Solve A x = b for symmetric positive definite A (Cholesky). */
function solve(A, b) {
  const n = A.length;
  for (let jitter = 0; jitter < 6; jitter++) {
    const add = jitter === 0 ? 0 : 1e-10 * Math.pow(100, jitter);
    const L = Array.from({ length: n }, () => new Float64Array(n));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j] + (i === j ? add : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) { ok = false; break; } L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
    }
    if (!ok) continue;
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * z[k]; z[i] = s / L[i][i]; }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
    return Array.from(x);
  }
  throw new Error('solve: matrix is not positive definite');
}

/* Invert SPD A (for coefficient standard errors). */
function inverse(A) {
  const n = A.length; const out = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; out.push(solve(A, e)); }
  return out.map((col, j) => col.map((_, i) => out[i][j]));
}

/**
 * IRLS for GLMs with an L2 penalty on every coefficient but the first
 * (the intercept, which must be X[i][0] === 1).
 * family: 'logistic' | 'poisson'
 */
function irls(X, y, o) {
  o = o || {};
  const family = o.family;
  const n = X.length; const p = X[0].length;
  const w0 = o.weights || null; const off = o.offset || null;
  const l2 = o.l2 == null ? 0 : o.l2;
  let beta = new Array(p).fill(0);
  if (family === 'poisson') { let s = 0, e = 0; for (let i = 0; i < n; i++) { s += y[i] * (w0 ? w0[i] : 1); e += (off ? Math.exp(off[i]) : 1) * (w0 ? w0[i] : 1); } beta[0] = Math.log(Math.max(1e-9, s / e)); }
  else { let s = 0, ww = 0; for (let i = 0; i < n; i++) { const wi = w0 ? w0[i] : 1; s += y[i] * wi; ww += wi; } beta[0] = logit(s / ww); }
  let lastDev = Infinity; let iters = 0; let H = null;
  for (let it = 0; it < (o.maxIter || 50); it++) {
    iters = it + 1;
    H = Array.from({ length: p }, () => new Float64Array(p));
    const g = new Float64Array(p);
    let dev = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      const eta = dot(xi, beta) + (off ? off[i] : 0);
      const wi = w0 ? w0[i] : 1;
      let mu, w, r;
      if (family === 'poisson') {
        mu = Math.exp(Math.min(30, eta)); w = mu * wi; r = (y[i] - mu) * wi;
        dev += 2 * wi * ((y[i] > 0 ? y[i] * Math.log(y[i] / mu) : 0) - (y[i] - mu));
      } else {
        mu = sigmoid(eta); const v = Math.max(1e-10, mu * (1 - mu)); w = v * wi; r = (y[i] - mu) * wi;
        dev += -2 * wi * (y[i] * Math.log(Math.max(1e-15, mu)) + (1 - y[i]) * Math.log(Math.max(1e-15, 1 - mu)));
      }
      for (let a = 0; a < p; a++) {
        const xa = xi[a]; if (xa === 0) continue;
        g[a] += xa * r;
        const wxa = w * xa; const Ha = H[a];
        for (let b = 0; b <= a; b++) Ha[b] += wxa * xi[b];
      }
    }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) H[b][a] = H[a][b];
    for (let a = 1; a < p; a++) { H[a][a] += l2; g[a] -= l2 * beta[a]; dev += l2 * beta[a] * beta[a]; }
    const step = solve(H.map((r) => Array.from(r)), Array.from(g));
    let maxStep = 0;
    for (let a = 0; a < p; a++) { beta[a] += step[a]; maxStep = Math.max(maxStep, Math.abs(step[a])); }
    if (Math.abs(lastDev - dev) < 1e-9 * (1 + Math.abs(dev)) && maxStep < 1e-8) break;
    lastDev = dev;
  }
  let se = null;
  try { const inv = inverse(H.map((r) => Array.from(r))); se = inv.map((row, i) => Math.sqrt(Math.max(0, row[i]))); } catch (_) { se = null; }
  return { beta, se, iterations: iters, deviance: lastDev, n, family, l2 };
}

function logistic(X, y, o) { return irls(X, y, Object.assign({}, o, { family: 'logistic' })); }
function poisson(X, y, o) { return irls(X, y, Object.assign({}, o, { family: 'poisson' })); }
function predictLogistic(beta, x) { return sigmoid(dot(beta, x)); }
function predictPoisson(beta, x, offset) { return Math.exp(dot(beta, x) + (offset || 0)); }

function standardize(rows, names) {
  const mean = {}, sd = {};
  for (const k of names) {
    let s = 0, s2 = 0, n = 0;
    for (const r of rows) { const v = r[k]; if (v == null || !isFinite(v)) continue; s += v; s2 += v * v; n++; }
    const m = n ? s / n : 0; mean[k] = m; sd[k] = n > 1 ? Math.sqrt(Math.max(1e-12, s2 / n - m * m)) : 1;
  }
  return { mean, sd };
}

/* Poisson pmf vector 0..max (the tail mass folded into the last cell when fold=true) */
function poissonPmf(lambda, max, fold) {
  const out = new Array(max + 1).fill(0);
  let p = Math.exp(-lambda); let s = 0;
  for (let k = 0; k <= max; k++) { if (k > 0) p *= lambda / k; out[k] = p; s += p; }
  if (fold) out[max] += Math.max(0, 1 - s);
  return out;
}

/* deterministic PRNG (mulberry32) for bootstraps that must reproduce */
function rng(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

module.exports = { dot, sigmoid, logit, solve, inverse, irls, logistic, poisson, predictLogistic, predictPoisson, standardize, poissonPmf, rng };

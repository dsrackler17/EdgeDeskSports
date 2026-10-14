'use strict';
/* ===========================================================================
   Small, dependency-free numerics shared by the research engine.
   =========================================================================== */

const r = (v, k) => (v == null || !Number.isFinite(v) ? null : Math.round(v * Math.pow(10, k == null ? 4 : k)) / Math.pow(10, k == null ? 4 : k));
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
const mean = (a) => (a.length ? sum(a) / a.length : null);
function sd(a) { if (a.length < 2) return null; const m = mean(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / (a.length - 1)); }
function corr(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = mean(x); const my = mean(y); let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx; const b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy);
}
function wmean(v, w) { let s = 0; let t = 0; for (let i = 0; i < v.length; i++) { s += v[i] * w[i]; t += w[i]; } return t > 0 ? s / t : null; }
function countBy(a, f) { const o = {}; for (const x of a) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; }
function groupBy(a, f) { const m = new Map(); for (const x of a) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
function quantile(sorted, q) { if (!sorted.length) return null; const p = (sorted.length - 1) * q; const lo = Math.floor(p); const hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }

/* standard normal */
function erf(x) { // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
function PhiInv(p) { // Acklam's rational approximation
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const rr = q * q;
  return (((((a[0] * rr + a[1]) * rr + a[2]) * rr + a[3]) * rr + a[4]) * rr + a[5]) * q / (((((b[0] * rr + b[1]) * rr + b[2]) * rr + b[3]) * rr + b[4]) * rr + 1);
}
/* CRPS of a normal forecast N(m, s^2) for outcome y (Gneiting & Raftery 2007) */
function crpsNormal(m, s, y) { const z = (y - m) / s; return s * (z * (2 * Phi(z) - 1) + 2 * phi(z) - 1 / Math.sqrt(Math.PI)); }

/* deterministic PRNG (mulberry32) */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* dense symmetric positive-definite solve and inverse (Cholesky), row-major Float64Array n*n */
function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      const li = i * n; const lj = j * n;
      for (let k = 0; k < j; k++) s -= L[li + k] * L[lj + k];
      if (i === j) { if (!(s > 0)) throw new Error('matrix not positive definite at ' + i); L[li + i] = Math.sqrt(s); }
      else L[li + j] = s / L[lj + j];
    }
  }
  return L;
}
function cholSolve(L, n, b) {
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; const li = i * n; for (let k = 0; k < i; k++) s -= L[li + k] * z[k]; z[i] = s / L[li + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
/* inverse from the Cholesky factor: column by column */
function cholInverse(L, n) {
  const inv = new Float64Array(n * n); const e = new Float64Array(n);
  for (let j = 0; j < n; j++) { e.fill(0); e[j] = 1; const x = cholSolve(L, n, e); for (let i = 0; i < n; i++) inv[i * n + j] = x[i]; }
  return inv;
}

/* moving block bootstrap of a paired difference, clustered by a key (date or team) */
function clusteredDiffCI(rows, key, diff, o) {
  const B = (o && o.B) || 1000; const rand = rng((o && o.seed) || 7);
  const groups = groupBy(rows, key); const keys = [...groups.keys()];
  const gsum = keys.map((k) => { const g = groups.get(k); return { s: sum(g.map(diff)), n: g.length }; });
  const total = sum(gsum.map((g) => g.s)) / sum(gsum.map((g) => g.n));
  const stats = [];
  for (let b = 0; b < B; b++) {
    let s = 0; let n = 0;
    for (let i = 0; i < keys.length; i++) { const g = gsum[Math.floor(rand() * keys.length)]; s += g.s; n += g.n; }
    stats.push(s / n);
  }
  stats.sort((a, b) => a - b);
  return { n: rows.length, clusters: keys.length, mean_diff: r(total, 5), ci95: [r(quantile(stats, 0.025), 5), r(quantile(stats, 0.975), 5)] };
}

module.exports = { r, sum, mean, sd, corr, wmean, countBy, groupBy, quantile, erf, Phi, phi, PhiInv, crpsNormal, rng, cholesky, cholSolve, cholInverse, clusteredDiffCI };

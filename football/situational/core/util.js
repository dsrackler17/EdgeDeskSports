/* ============================================================================
   FSIE — small shared helpers: hashing, deterministic JSON, a seeded PRNG,
   descriptive statistics and the normal distribution. No dependencies; every
   function is pure except writeJson/readJson.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(x) { return crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : stable(x)).digest('hex'); }

/* JSON with sorted object keys, so the same content always hashes the same */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

/* Pretty JSON with sorted keys: committed artifacts are byte-stable for the
   same input, so an unchanged rebuild produces an empty diff. */
function sortKeys(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = {}; Object.keys(v).sort().forEach((k) => { if (v[k] !== undefined) o[k] = sortKeys(v[k]); });
  return o;
}
function writeJson(file, obj, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = (opts && opts.compact ? JSON.stringify(sortKeys(obj)) : JSON.stringify(sortKeys(obj), null, 1)) + '\n';
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return text;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback === undefined ? null : fallback; }
}

/* mulberry32: small, fast, deterministic */
function rng(seed) {
  let a = (typeof seed === 'number' ? seed : parseInt(sha256(String(seed)).slice(0, 8), 16)) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalSampler(u) {
  let spare = null;
  return function () {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let a, b, s;
    do { a = u() * 2 - 1; b = u() * 2 - 1; s = a * a + b * b; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = b * m; return a * m;
  };
}

function isNum(x) { return typeof x === 'number' && isFinite(x); }
function round(x, d) { if (!isNum(x)) return null; const m = Math.pow(10, d == null ? 3 : d); return Math.round(x * m) / m; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function sum(a) { let s = 0; for (const x of a) s += x; return s; }
function mean(a) { return a.length ? sum(a) / a.length : null; }
function variance(a) { if (a.length < 2) return null; const m = mean(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return s / (a.length - 1); }
function sd(a) { const v = variance(a); return v == null ? null : Math.sqrt(v); }
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q; const lo = Math.floor(p); const hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}
function quantiles(a, qs) { const s = a.slice().sort((x, y) => x - y); return qs.map((q) => quantile(s, q)); }

/* Abramowitz–Stegun erf; accurate to ~1e-7, plenty for script shares */
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/* Acklam's inverse normal */
function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* Solve (X'X + lambda*I) b = X'y by Gaussian elimination with partial
   pivoting. The intercept (column 0) is not penalised. */
function ridge(X, y, lambda, w) {
  const p = X[0].length; const A = []; const v = new Array(p).fill(0);
  for (let i = 0; i < p; i++) A.push(new Array(p).fill(0));
  for (let r = 0; r < X.length; r++) {
    const row = X[r]; const wt = w ? w[r] : 1;
    for (let i = 0; i < p; i++) { v[i] += wt * row[i] * y[r]; for (let j = 0; j < p; j++) A[i][j] += wt * row[i] * row[j]; }
  }
  for (let i = 1; i < p; i++) A[i][i] += lambda;
  for (let i = 0; i < p; i++) {
    let piv = i; for (let k = i + 1; k < p; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    [A[i], A[piv]] = [A[piv], A[i]]; [v[i], v[piv]] = [v[piv], v[i]];
    const d = A[i][i]; if (Math.abs(d) < 1e-12) continue;
    for (let k = i + 1; k < p; k++) { const f = A[k][i] / d; if (!f) continue; for (let j = i; j < p; j++) A[k][j] -= f * A[i][j]; v[k] -= f * v[i]; }
  }
  const b = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) { let s = v[i]; for (let j = i + 1; j < p; j++) s -= A[i][j] * b[j]; b[i] = Math.abs(A[i][i]) < 1e-12 ? 0 : s / A[i][i]; }
  return b;
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

module.exports = { sha256, stable, sortKeys, writeJson, readJson, rng, normalSampler, isNum, round, clamp, sum, mean, variance, sd, quantile, quantiles, normCdf, normInv, ridge, dot };

'use strict';
/* ===========================================================================
   EdgeDesk NBA — the learners the candidates are fitted with.

   Dependency-free and deterministic (the same rows in the same order give the
   same model to the last bit; every random draw comes from engine/stats.rng
   with a fixed seed), so a committed model can be rebuilt and compared.

     ridge(X, y, {l2, weights})              weighted least squares, intercept unpenalised,
                                             on standardised columns (returns raw-scale beta)
     logisticRidge(X, y, {l2, weights})      engine/stats IRLS on standardised columns
     gbdt(X, y, {loss, trees, depth, lr, minLeaf, l2, subsample, bins, valid})
                                             gradient-boosted regression trees (histogram
                                             splits), logistic or squared loss, early stopping
                                             on a chronological validation block
     platt(p, y)                             logistic recalibration of probabilities
     qnorm(p)                                the inverse standard normal (Acklam)
   =========================================================================== */
const S = require('../../engine/stats');

function colStats(X, w) {
  const p = X[0].length, n = X.length; const mean = new Array(p).fill(0), sd = new Array(p).fill(1);
  let sw = 0; for (let i = 0; i < n; i++) sw += w ? w[i] : 1;
  for (let j = 1; j < p; j++) {
    let s = 0; for (let i = 0; i < n; i++) s += (w ? w[i] : 1) * X[i][j]; const m = s / sw;
    let v = 0; for (let i = 0; i < n; i++) v += (w ? w[i] : 1) * (X[i][j] - m) * (X[i][j] - m);
    mean[j] = m; sd[j] = Math.sqrt(v / sw) || 1;
  }
  return { mean, sd };
}
function standardise(X, st) { return X.map((r) => r.map((v, j) => (j === 0 ? 1 : (v - st.mean[j]) / st.sd[j]))); }
function unstandardise(beta, st) {
  const b = beta.slice(); let a = b[0];
  for (let j = 1; j < b.length; j++) { b[j] = beta[j] / st.sd[j]; a -= b[j] * st.mean[j]; }
  b[0] = a; return b;
}

/** weighted ridge regression; X rows begin with 1 (the unpenalised intercept) */
function ridge(X, y, o) {
  o = o || {}; const w = o.weights || null; const l2 = o.l2 == null ? 1 : o.l2;
  const st = colStats(X, w); const Z = standardise(X, st);
  const p = Z[0].length; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < Z.length; i++) {
    const wi = w ? w[i] : 1; const zi = Z[i];
    for (let a = 0; a < p; a++) { b[a] += wi * zi[a] * y[i]; for (let c = 0; c <= a; c++) A[a][c] += wi * zi[a] * zi[c]; }
  }
  for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[c][a] = A[a][c];
  for (let a = 1; a < p; a++) A[a][a] += l2;
  const beta = S.solve(A, b);
  let rss = 0, sw = 0; for (let i = 0; i < Z.length; i++) { const e = y[i] - S.dot(beta, Z[i]); rss += (w ? w[i] : 1) * e * e; sw += w ? w[i] : 1; }
  return { beta: unstandardise(beta, st), sigma: Math.sqrt(rss / Math.max(1, sw)), n: X.length, l2 };
}
function predictLinear(beta, x) { return S.dot(beta, x); }

function logisticRidge(X, y, o) {
  o = o || {}; const st = colStats(X, o.weights); const Z = standardise(X, st);
  const f = S.logistic(Z, y, { l2: o.l2 == null ? 1 : o.l2, weights: o.weights });
  return { beta: unstandardise(f.beta, st), n: X.length, l2: f.l2 };
}
function predictLogistic(beta, x) { return S.sigmoid(S.dot(beta, x)); }

/* ---------------------------------------------------------------- GBDT
   Histogram gradient boosting with depth-limited trees. Features are binned
   once into at most `bins` quantile bins (training rows only); a split sends
   bin <= k left. Leaf values are Newton steps with an L2 penalty. Logistic
   loss works on the log-odds scale with an initial value of the base rate;
   squared loss on the target scale with the mean. */
function quantileEdges(col, bins) {
  const v = col.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  const edges = []; if (!v.length) return edges;
  for (let k = 1; k < bins; k++) { const q = v[Math.min(v.length - 1, Math.floor(k * v.length / bins))]; if (!edges.length || q > edges[edges.length - 1]) edges.push(q); }
  return edges;
}
function binOf(edges, x) { if (x == null || !isFinite(x)) return 0; let lo = 0, hi = edges.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x > edges[m]) lo = m + 1; else hi = m; } return lo; }

function gbdt(X, y, o) {
  o = Object.assign({ loss: 'logistic', trees: 300, depth: 3, lr: 0.05, minLeaf: 40, l2: 1, subsample: 0.8, colsample: 1, bins: 32, seed: 7, valid: null, patience: 30 }, o || {});
  const n = X.length, p = X[0].length;
  const edges = []; for (let j = 0; j < p; j++) edges.push(quantileEdges(X.map((r) => r[j]), o.bins));
  const B = X.map((r) => r.map((v, j) => binOf(edges[j], v)));
  const VB = o.valid ? o.valid.X.map((r) => r.map((v, j) => binOf(edges[j], v))) : null;
  const rand = S.rng(o.seed);
  let f0;
  if (o.loss === 'logistic') { const m = y.reduce((a, b) => a + b, 0) / n; f0 = Math.log(Math.max(1e-6, m) / Math.max(1e-6, 1 - m)); }
  else f0 = y.reduce((a, b) => a + b, 0) / n;
  const F = new Float64Array(n).fill(f0); const FV = VB ? new Float64Array(VB.length).fill(f0) : null;
  const trees = []; let best = { loss: Infinity, k: 0 }; let since = 0;
  const g = new Float64Array(n), h = new Float64Array(n);
  const lossV = () => { let s = 0; for (let i = 0; i < VB.length; i++) { const yy = o.valid.y[i]; if (o.loss === 'logistic') { const q = S.sigmoid(FV[i]); s -= yy * Math.log(Math.max(1e-12, q)) + (1 - yy) * Math.log(Math.max(1e-12, 1 - q)); } else s += (yy - FV[i]) * (yy - FV[i]); } return s / VB.length; };
  for (let t = 0; t < o.trees; t++) {
    for (let i = 0; i < n; i++) { if (o.loss === 'logistic') { const q = S.sigmoid(F[i]); g[i] = q - y[i]; h[i] = Math.max(1e-6, q * (1 - q)); } else { g[i] = F[i] - y[i]; h[i] = 1; } }
    const rows = []; for (let i = 0; i < n; i++) if (rand() < o.subsample) rows.push(i);
    const cols = []; for (let j = 0; j < p; j++) if (o.colsample >= 1 || rand() < o.colsample) cols.push(j);
    const tree = grow(rows, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += o.lr * evalTree(tree, B[i]);
    if (VB) {
      for (let i = 0; i < VB.length; i++) FV[i] += o.lr * evalTree(tree, VB[i]);
      const L = lossV();
      if (L < best.loss - 1e-7) { best = { loss: L, k: t + 1 }; since = 0; } else if (++since >= o.patience) break;
    }
    function grow(idx, d) {
      let G = 0, H = 0; for (const i of idx) { G += g[i]; H += h[i]; }
      const leaf = { v: -G / (H + o.l2) };
      if (d >= o.depth || idx.length < 2 * o.minLeaf) return leaf;
      let bestS = null;
      const parent = (G * G) / (H + o.l2);
      for (const j of cols) {
        const nb = edges[j].length + 1; if (nb < 2) continue;
        const gs = new Float64Array(nb), hs = new Float64Array(nb), cs = new Int32Array(nb);
        for (const i of idx) { const b = B[i][j]; gs[b] += g[i]; hs[b] += h[i]; cs[b]++; }
        let gl = 0, hl = 0, cl = 0;
        for (let k = 0; k < nb - 1; k++) {
          gl += gs[k]; hl += hs[k]; cl += cs[k];
          const cr = idx.length - cl; if (cl < o.minLeaf || cr < o.minLeaf) continue;
          const gr = G - gl, hr = H - hl;
          const gain = (gl * gl) / (hl + o.l2) + (gr * gr) / (hr + o.l2) - parent;
          if (!bestS || gain > bestS.gain) bestS = { gain, j, k };
        }
      }
      if (!bestS || bestS.gain <= 1e-9) return leaf;
      const L = [], R = []; for (const i of idx) (B[i][bestS.j] <= bestS.k ? L : R).push(i);
      return { j: bestS.j, k: bestS.k, l: grow(L, d + 1), r: grow(R, d + 1) };
    }
  }
  const keep = VB ? Math.max(1, best.k) : trees.length;
  return { kind: 'gbdt', loss: o.loss, f0, lr: o.lr, edges, trees: trees.slice(0, keep), used: keep, grown: trees.length, valid_loss: VB ? best.loss : null, params: { depth: o.depth, lr: o.lr, minLeaf: o.minLeaf, l2: o.l2, subsample: o.subsample, bins: o.bins } };
}
function evalTree(t, b) { while (t.j != null) t = b[t.j] <= t.k ? t.l : t.r; return t.v; }
function predictGbdt(m, x) {
  const b = x.map((v, j) => binOf(m.edges[j], v)); let f = m.f0;
  for (const t of m.trees) f += m.lr * evalTree(t, b);
  return m.loss === 'logistic' ? S.sigmoid(f) : f;
}
/** split-gain importance: how often each feature is used, weighted by depth */
function gbdtUsage(m, names) {
  const c = new Array(m.edges.length).fill(0);
  const walk = (t, d) => { if (t.j == null) return; c[t.j] += Math.pow(0.5, d); walk(t.l, d + 1); walk(t.r, d + 1); };
  for (const t of m.trees) walk(t, 0);
  const tot = c.reduce((a, b) => a + b, 0) || 1;
  return names.map((nm, j) => ({ feature: nm, share: Math.round(c[j] / tot * 1000) / 1000 })).sort((a, b) => b.share - a.share);
}

/** Platt recalibration: logit(p') = a + b·logit(p) */
function platt(ps, ys) {
  const X = ps.map((p) => [1, S.logit(p)]);
  const f = S.logistic(X, ys, { l2: 1e-6 });
  return { a: f.beta[0], b: f.beta[1] };
}
function applyPlatt(c, p) { return c ? S.sigmoid(c.a + c.b * S.logit(p)) : p; }

/* inverse standard normal, Acklam's algorithm (|rel. error| < 1.2e-9) */
function qnorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const q0 = Math.min(1 - 1e-12, Math.max(1e-12, p)); const pl = 0.02425;
  if (q0 < pl) { const q = Math.sqrt(-2 * Math.log(q0)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (q0 > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - q0)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = q0 - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

module.exports = { ridge, predictLinear, logisticRidge, predictLogistic, gbdt, predictGbdt, gbdtUsage, platt, applyPlatt, qnorm, colStats };

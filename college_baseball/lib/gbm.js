'use strict';
/* ===========================================================================
   EdgeDesk college baseball — a small, deterministic gradient-boosted tree
   classifier (logistic loss, second-order splits, histogram thresholds).

   Kept deliberately small (shallow trees, shrinkage, minimum leaf size, L2 on
   leaves): Model 6 must earn its complexity against the regularised GLM on
   SELECTION -> VALIDATION, and a large ensemble of deep trees on ~70k games
   would mostly learn noise.
   =========================================================================== */
const S = require('../../engine/stats');

function quantileThresholds(X, j, nb) {
  const v = X.map((x) => x[j]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const out = []; for (let i = 1; i < nb; i++) { const q = v[Math.floor(i * v.length / nb)]; if (!out.length || q > out[out.length - 1]) out.push(q); }
  return out;
}

function fit(X, y, o) {
  o = Object.assign({ trees: 200, depth: 2, lr: 0.05, minLeaf: 200, lambda: 10, bins: 32 }, o || {});
  const n = X.length; const d = X[0].length;
  const thr = []; for (let j = 0; j < d; j++) thr.push(quantileThresholds(X, j, o.bins));
  const base = Math.log((y.reduce((a, b) => a + b, 0) + 1) / (n - y.reduce((a, b) => a + b, 0) + 1));
  const F = new Float64Array(n).fill(base); const trees = [];
  const g = new Float64Array(n); const h = new Float64Array(n);
  for (let t = 0; t < o.trees; t++) {
    for (let i = 0; i < n; i++) { const p = S.sigmoid(F[i]); g[i] = y[i] - p; h[i] = p * (1 - p); }
    const build = (idx, depth) => {
      let G = 0; let H = 0; for (const i of idx) { G += g[i]; H += h[i]; }
      const leaf = { v: G / (H + o.lambda) };
      if (depth >= o.depth || idx.length < 2 * o.minLeaf) return leaf;
      let best = null;
      for (let j = 0; j < d; j++) {
        const th = thr[j]; if (!th.length) continue;
        const gs = new Float64Array(th.length + 1); const hs = new Float64Array(th.length + 1); const cs = new Int32Array(th.length + 1);
        for (const i of idx) { const x = X[i][j]; let b = 0; let lo = 0; let hi = th.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x > th[m]) lo = m + 1; else hi = m; } b = lo; gs[b] += g[i]; hs[b] += h[i]; cs[b]++; }
        let gl = 0; let hl = 0; let cl = 0;
        for (let b = 0; b < th.length; b++) {
          gl += gs[b]; hl += hs[b]; cl += cs[b];
          const cr = idx.length - cl; if (cl < o.minLeaf || cr < o.minLeaf) continue;
          const gr = G - gl; const hr = H - hl;
          const gain = gl * gl / (hl + o.lambda) + gr * gr / (hr + o.lambda) - G * G / (H + o.lambda);
          if (!best || gain > best.gain) best = { gain, j, t: th[b] };
        }
      }
      if (!best || best.gain <= 0) return leaf;
      const L = []; const R = []; for (const i of idx) (X[i][best.j] <= best.t ? L : R).push(i);
      return { j: best.j, t: best.t, l: build(L, depth + 1), r: build(R, depth + 1) };
    };
    const tree = build([...Array(n).keys()], 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += o.lr * predictTree(tree, X[i]);
  }
  return { base, lr: o.lr, trees, opts: o };
}
function predictTree(t, x) { while (t.j !== undefined) t = x[t.j] <= t.t ? t.l : t.r; return t.v; }
function predict(m, x) { let f = m.base; for (const t of m.trees) f += m.lr * predictTree(t, x); return S.sigmoid(f); }
/** split-count importance by feature */
function importance(m, d) { const c = new Array(d).fill(0); const walk = (t) => { if (t.j === undefined) return; c[t.j]++; walk(t.l); walk(t.r); }; for (const t of m.trees) walk(t); return c; }

module.exports = { fit, predict, importance };

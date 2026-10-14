'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — gradient-boosted trees for a binary outcome.

   Dependency-free and deterministic (a seeded PRNG for every subsample), so a
   run reproduces bit for bit like the rest of engine/stats.js. The method is
   the standard one (Friedman 2001, "Greedy function approximation"; the
   second-order split gain and leaf weights of Chen & Guestrin 2016, XGBoost):

     F0 = logit(mean y)
     each round: g = p − y, h = p(1 − p) on a row subsample; grow a tree of
       depth ≤ max_depth on per-feature quantile histograms (≤ bins buckets);
       a split's gain is G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ), leaves need
       Σh ≥ min_child_weight and ≥ min_leaf rows; leaf value −G/(H+λ) × η.

   Missing values are not expected (the lab's features are always defined);
   a non-finite input is treated as the feature's median.
   =========================================================================== */
const S = require('../../engine/stats');

const DEFAULTS = { rounds: 200, eta: 0.05, max_depth: 3, bins: 32, lambda: 1, min_child_weight: 5, min_leaf: 40, subsample: 0.8, colsample: 0.8, seed: 20261013 };

function quantileEdges(col, bins) {
  const v = Array.from(col).filter(isFinite).sort((a, b) => a - b);
  const edges = [];
  for (let i = 1; i < bins; i++) { const x = v[Math.floor((i * v.length) / bins)]; if (x !== undefined && (!edges.length || x > edges[edges.length - 1])) edges.push(x); }
  return { edges, median: v.length ? v[Math.floor(v.length / 2)] : 0 };
}
function binOf(edges, x) { let lo = 0, hi = edges.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x < edges[m]) hi = m; else lo = m + 1; } return lo; } /* bin b holds x in [edges[b-1], edges[b]) */

/** fit on X (array of rows), y (0/1) */
function fit(X, y, o) {
  const p = Object.assign({}, DEFAULTS, o || {});
  const n = X.length, d = X[0].length, rand = S.rng(p.seed);
  const cols = []; const B = [];
  for (let j = 0; j < d; j++) {
    const col = new Float64Array(n); for (let i = 0; i < n; i++) col[i] = X[i][j];
    const q = quantileEdges(col, p.bins); cols.push(q);
    const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = binOf(q.edges, isFinite(col[i]) ? col[i] : q.median); B.push(b);
  }
  let ybar = 0; for (let i = 0; i < n; i++) ybar += y[i]; ybar /= n;
  const f0 = S.logit(ybar);
  const F = new Float64Array(n).fill(f0);
  const trees = [];
  const g = new Float64Array(n), h = new Float64Array(n);
  for (let r = 0; r < p.rounds; r++) {
    for (let i = 0; i < n; i++) { const pi = S.sigmoid(F[i]); g[i] = pi - y[i]; h[i] = Math.max(1e-6, pi * (1 - pi)); }
    const rows = []; for (let i = 0; i < n; i++) if (rand() < p.subsample) rows.push(i);
    const feats = []; for (let j = 0; j < d; j++) if (rand() < p.colsample) feats.push(j);
    if (!feats.length) feats.push(Math.floor(rand() * d));
    const tree = grow(rows, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += leafRaw(tree, B, i);
    function grow(idx, depth) {
      let G = 0, H = 0; for (const i of idx) { G += g[i]; H += h[i]; }
      const leaf = { v: -G / (H + p.lambda) * p.eta };
      if (depth >= p.max_depth || idx.length < 2 * p.min_leaf) return leaf;
      let best = null;
      for (const j of feats) {
        const nb = cols[j].edges.length + 1; const hg = new Float64Array(nb), hh = new Float64Array(nb), hc = new Int32Array(nb);
        const bj = B[j];
        for (const i of idx) { const b = bj[i]; hg[b] += g[i]; hh[b] += h[i]; hc[b]++; }
        let gl = 0, hl = 0, cl = 0;
        for (let b = 0; b < nb - 1; b++) {
          gl += hg[b]; hl += hh[b]; cl += hc[b];
          const gr = G - gl, hr = H - hl, cr = idx.length - cl;
          if (cl < p.min_leaf || cr < p.min_leaf || hl < p.min_child_weight || hr < p.min_child_weight) continue;
          const gain = gl * gl / (hl + p.lambda) + gr * gr / (hr + p.lambda) - G * G / (H + p.lambda);
          if (!best || gain > best.gain) best = { gain, j, b };
        }
      }
      if (!best || best.gain <= 1e-9) return leaf;
      const L = [], R = []; const bj = B[best.j];
      for (const i of idx) (bj[i] <= best.b ? L : R).push(i);
      return { j: best.j, b: best.b, t: cols[best.j].edges[best.b], l: grow(L, depth + 1), r: grow(R, depth + 1) };
    }
  }
  return { schema: 'edgedesk_gbdt_v1', params: p, f0, trees, medians: cols.map((c) => c.median), n, d };
}
function leafRaw(t, B, i) { while (t.j !== undefined) t = B[t.j][i] <= t.b ? t.l : t.r; return t.v; }

/** P(y = 1) for one raw feature row */
function predict(m, x) {
  let f = m.f0;
  for (const t0 of m.trees) {
    let t = t0;
    while (t.j !== undefined) { let v = x[t.j]; if (!isFinite(v)) v = m.medians[t.j]; t = v < t.t ? t.l : t.r; }
    f += t.v;
  }
  return S.sigmoid(f);
}

/** split-gain importance per feature (sum over trees) — descriptive, not causal */
function importance(m, names) {
  const imp = new Array(m.d).fill(0);
  const walk = (t) => { if (t.j === undefined) return; imp[t.j] += 1; walk(t.l); walk(t.r); };
  for (const t of m.trees) walk(t);
  const tot = imp.reduce((a, v) => a + v, 0) || 1;
  return imp.map((v, j) => ({ feature: names ? names[j] : j, split_share: +(v / tot).toFixed(4) })).sort((a, b) => b.split_share - a.split_share);
}

module.exports = { fit, predict, importance, DEFAULTS };

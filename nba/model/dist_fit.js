'use strict';
/* ===========================================================================
   EdgeDesk NBA — fitting the predictive distribution's shape on EARLIER
   seasons only (nba/model/distribution.js is the reader).

     fitShape(rows)        rows [{mu, y}] (calibrated regulation-margin mean,
                           observed regulation margin) → { sd, theta[0..K] } by
                           maximum likelihood: σ by golden-section search, the
                           end-game log-weights θ_|m| by Newton steps with a
                           small ridge (θ = 0 is a plain discretised normal)
     fitSigma(rows, theta) σ alone for a fixed shape (each candidate has its own σ)
     fitOvertime(games)    the overtime period: margin sd and tie weight, and
                           the points one overtime adds (mean, sd)
     fitPeriod(rows, key)  first half / first quarter: y ≈ f·μ, residual sd
   =========================================================================== */
const DIST = require('./distribution');
const Phi = DIST.Phi;
const K = 10, LO = -60, HI = 60;

function baseProbs(mu, sd) {
  const out = new Float64Array(HI - LO + 1);
  for (let m = LO; m <= HI; m++) out[m - LO] = Phi((m + 0.5 - mu) / sd) - Phi((m - 0.5 - mu) / sd);
  return out;
}
function loglik(rows, sd, theta) {
  let ll = 0;
  for (const r of rows) {
    if (r.y < LO || r.y > HI) continue;
    const b = baseProbs(r.mu, typeof sd === 'number' ? sd : Math.max(6, sd.s0 + sd.s1 * Math.min(Math.abs(r.mu), 10))); let Z = 0;
    for (let m = LO; m <= HI; m++) Z += b[m - LO] * (Math.abs(m) <= K ? Math.exp(theta[Math.abs(m)]) : 1);
    const k = Math.abs(r.y);
    ll += Math.log(Math.max(1e-300, b[r.y - LO])) + (k <= K ? theta[k] : 0) - Math.log(Z);
  }
  return ll;
}
function golden(f, lo, hi, it) {
  const g = (Math.sqrt(5) - 1) / 2; let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a); let fc = f(c), fd = f(d);
  for (let i = 0; i < (it || 30); i++) { if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); } }
  return (a + b) / 2;
}
function fitSigma(rows, theta, lo, hi) { return golden((sd) => loglik(rows, sd, theta), lo || 7, hi || 18, 26); }

function fitShape(rows, o) {
  o = o || {}; const l2 = o.l2 == null ? 2 : o.l2;
  let theta = new Array(K + 1).fill(0);
  let sd = fitSigma(rows, theta);
  for (let outer = 0; outer < 4; outer++) {
    for (let it = 0; it < 6; it++) {
      const g = new Array(K + 1).fill(0), h = new Array(K + 1).fill(0);
      for (const r of rows) {
        if (r.y < LO || r.y > HI) continue;
        const b = baseProbs(r.mu, sd); let Z = 0; const pk = new Array(K + 1).fill(0);
        for (let m = LO; m <= HI; m++) { const k = Math.abs(m); const v = b[m - LO] * (k <= K ? Math.exp(theta[k]) : 1); Z += v; if (k <= K) pk[k] += v; }
        const ky = Math.abs(r.y);
        for (let k = 0; k <= K; k++) { const p = pk[k] / Z; g[k] += (ky === k ? 1 : 0) - p; h[k] += p * (1 - p); }
      }
      let mx = 0;
      for (let k = 0; k <= K; k++) { const step = (g[k] - l2 * theta[k]) / (h[k] + l2); theta[k] += step; mx = Math.max(mx, Math.abs(step)); }
      if (mx < 1e-4) break;
    }
    const sd2 = fitSigma(rows, theta, sd - 2, sd + 2);
    if (Math.abs(sd2 - sd) < 1e-3) { sd = sd2; break; }
    sd = sd2;
  }
  return { sd, theta: theta.map((v) => Math.round(v * 10000) / 10000), n: rows.length };
}

/** overtime from finished games: [{ ot (periods), margin (final), reg_total, total }] */
function fitOvertime(games) {
  const otg = games.filter((g) => g.ot >= 1);
  const one = otg.filter((g) => g.ot === 1 && g.margin !== 0);
  const p2 = otg.length ? otg.filter((g) => g.ot >= 2).length / otg.length : 0.1;
  /* σ of a single overtime's margin, conditioned on not tied, by MLE on single-OT games */
  const llS = (sd) => { let ll = 0; const pz = Phi(0.5 / sd) - Phi(-0.5 / sd); for (const g of one) { const m = g.margin; ll += Math.log(Math.max(1e-300, (Phi((m + 0.5) / sd) - Phi((m - 0.5) / sd)) / (1 - pz))); } return ll; };
  const sd = one.length >= 30 ? golden(llS, 2, 12, 26) : 5;
  const pz = Phi(0.5 / sd) - Phi(-0.5 / sd);
  /* tie weight so that P(tie after an overtime) = p2 */
  const target = Math.min(0.4, Math.max(0.02, p2));
  const tie_w = Math.log((target / (1 - target)) * ((1 - pz) / pz));
  const add = otg.filter((g) => g.reg_total != null).map((g) => (g.total - g.reg_total) / g.ot);
  const mean = add.length ? add.reduce((a, v) => a + v, 0) / add.length : 20;
  const sdT = add.length > 2 ? Math.sqrt(add.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (add.length - 1)) : 5;
  return { kappa: 5 / 48, sd: Math.round(sd * 1000) / 1000, tie_w: Math.round(tie_w * 1000) / 1000, total_mean: Math.round(mean * 100) / 100, total_sd: Math.round(sdT * 100) / 100, n_ot: otg.length, p_second_ot: Math.round(p2 * 1000) / 1000 };
}

/** y ≈ f·x through the origin, with the residual sd */
function fitThroughOrigin(xs, ys) {
  let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
  const f = sxx > 0 ? sxy / sxx : 0.5; let ss = 0; for (let i = 0; i < xs.length; i++) ss += Math.pow(ys[i] - f * xs[i], 2);
  return { f, sd: Math.sqrt(ss / Math.max(1, xs.length - 1)), n: xs.length };
}


/* ---------------------------------------------------------------- oriented shape
   log w(m) = θ0 at a tie; for m ≠ 0 a blend of the favourite-side and
   underdog-side weights with s = Φ(μ/blend) (distribution.shapeLog). The
   log-likelihood is concave in θ for fixed (μ, σ): Newton steps with a ridge.
   σ may depend on the expected margin: σ_i = s0 + s1·min(|μ_i|, 10). */
const BLEND = 2;
function sdOf(sd, mu) { return typeof sd === 'number' ? sd : Math.max(6, sd.s0 + sd.s1 * Math.min(Math.abs(mu), 10)); }
function coefs(m, s) {
  /* indices: 0 = zero, 1..K = fav, K+1..2K = dog */
  if (m === 0) return [[0, 1]];
  const k = Math.abs(m); if (k > K) return [];
  return m > 0 ? [[k, s], [K + k, 1 - s]] : [[K + k, s], [k, 1 - s]];
}
function thetaObj(v) { return { zero: v[0], fav: v.slice(1, K + 1), dog: v.slice(K + 1), blend: BLEND }; }
function loglikO(rows, sd, th) {
  let ll = 0;
  for (const r of rows) {
    if (r.y < LO || r.y > HI) continue;
    const b = baseProbs(r.mu, sdOf(sd, r.mu)); let Z = 0;
    for (let m = LO; m <= HI; m++) Z += b[m - LO] * Math.exp(DIST.shapeLog(th, m, r.mu));
    ll += Math.log(Math.max(1e-300, b[r.y - LO])) + DIST.shapeLog(th, r.y, r.mu) - Math.log(Z);
  }
  return ll;
}
function newtonO(rows, sd, v, l2) {
  for (let it = 0; it < 8; it++) {
    const n = 2 * K + 1; const g = new Array(n).fill(0), h = new Array(n).fill(0);
    const th = thetaObj(v);
    for (const r of rows) {
      if (r.y < LO || r.y > HI) continue;
      const s = DIST.Phi(r.mu / BLEND);
      const b = baseProbs(r.mu, sdOf(sd, r.mu)); let Z = 0;
      const e1 = new Array(n).fill(0), e2 = new Array(n).fill(0);
      for (let m = LO; m <= HI; m++) {
        const w = b[m - LO] * Math.exp(DIST.shapeLog(th, m, r.mu)); Z += w;
        for (const [j, c] of coefs(m, s)) { e1[j] += w * c; e2[j] += w * c * c; }
      }
      for (const [j, c] of coefs(r.y, s)) g[j] += c;
      for (let j = 0; j < n; j++) { const m1 = e1[j] / Z; g[j] -= m1; h[j] += e2[j] / Z - m1 * m1; }
    }
    let mx = 0;
    for (let j = 0; j < n; j++) { const step = (g[j] - l2 * v[j]) / (h[j] + l2); v[j] += step; mx = Math.max(mx, Math.abs(step)); }
    if (mx < 1e-4) break;
  }
  return v;
}
function fitSigmaHetero(rows, theta, s1grid) {
  let best = null;
  for (const s1 of s1grid || [-0.25, -0.2, -0.15, -0.1, -0.05, 0]) {
    const s0 = golden((x) => (Array.isArray(theta) ? loglik(rows, { s0: x, s1 }, theta) : loglikO(rows, { s0: x, s1 }, theta)), 8, 18, 24);
    const ll = Array.isArray(theta) ? loglik(rows, { s0, s1 }, theta) : loglikO(rows, { s0, s1 }, theta);
    if (!best || ll > best.ll) best = { s0, s1, ll };
  }
  return { s0: best.s0, s1: best.s1 };
}
function fitShapeOriented(rows, o) {
  o = o || {}; const l2 = o.l2 == null ? 2 : o.l2;
  let v = new Array(2 * K + 1).fill(0);
  let sd = { s0: 12, s1: 0 };
  for (let outer = 0; outer < 3; outer++) {
    v = newtonO(rows, sd, v, l2);
    const sd2 = fitSigmaHetero(rows, thetaObj(v));
    const done = Math.abs(sd2.s0 - sd.s0) < 0.01 && sd2.s1 === sd.s1; sd = sd2; if (done) break;
  }
  v = v.map((x) => Math.round(x * 10000) / 10000);
  return { sd, theta: thetaObj(v), n: rows.length };
}

/** overtime with the favourite's edge: single-OT margins ~ N(κ·μ, σ) given not tied */
function fitOvertimeK(games) {
  const base = fitOvertime(games);
  const one = games.filter((g) => g.ot === 1 && g.margin !== 0 && g.mu != null);
  if (one.length < 50) return base;
  const ll = (kappa, sd) => { let s = 0; for (const g of one) { const mu = kappa * g.mu; const pz = Phi((0.5 - mu) / sd) - Phi((-0.5 - mu) / sd); s += Math.log(Math.max(1e-300, (Phi((g.margin + 0.5 - mu) / sd) - Phi((g.margin - 0.5 - mu) / sd)) / (1 - pz))); } return s; };
  let best = null;
  for (const kappa of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) { const sd = golden((x) => ll(kappa, x), 2, 12, 22); const v = ll(kappa, sd); if (!best || v > best.v) best = { kappa, sd, v }; }
  const pz = Phi(0.5 / best.sd) - Phi(-0.5 / best.sd);
  const target = Math.min(0.4, Math.max(0.02, base.p_second_ot));
  return Object.assign({}, base, { kappa: best.kappa, sd: Math.round(best.sd * 1000) / 1000, tie_w: Math.round(Math.log((target / (1 - target)) * ((1 - pz) / pz)) * 1000) / 1000, n_single_ot: one.length });
}

module.exports = { fitShape, fitShapeOriented, fitSigma, fitSigmaHetero, fitOvertime, fitOvertimeK, fitThroughOrigin, loglik, loglikO, sdOf, K };

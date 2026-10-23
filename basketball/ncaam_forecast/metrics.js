'use strict';
/* ===========================================================================
   Proper scores for the NCAAM forecast distributions.

   Win probability: log loss (probabilities clipped to [1e-6, 1 - 1e-6], the
   research engine's documented clip), Brier, reliability by band WITH counts,
   calibration-in-the-large and logistic slope. Raw winner accuracy is reported
   nowhere as a headline: always predicting the favourite inflates it without
   saying anything about the probabilities.

   Margin (integer valued, never 0 at the final whistle): CRPS on the integer
   grid, sum_k (F(k) - 1{y <= k})^2, so a discrete forecast and a continuous
   one are scored on the same footing (a continuous forecast is read at
   half-integers); mid-PIT F(y - 1) + p(y)/2, whose central-band frequencies
   are the interval coverages (50/80/95%); MAE and RMSE of the mean.

   Total: closed-form CRPS of the normal mixture (Grimit et al. 2006), PIT,
   coverage, MAE. Overtime: mean forecast tie mass vs the observed rate.

   Paired comparisons of two candidates on the SAME games use the research
   engine's day-clustered bootstrap (lib/util.js clusteredDiffCI): games on
   one day share conditions, so they are not independent draws.
   =========================================================================== */
const D = require('./dist');
const U = require('../ncaam_research/lib/util');

const EPS = 1e-6;
const ll = (p, y) => -Math.log(Math.min(1 - EPS, Math.max(EPS, y ? p : 1 - p)));
const SQRTPI = Math.sqrt(Math.PI);

function crpsGrid(keys, vals, y) {
  /* F on the integer grid from the PMF; the indicator steps at y */
  const lo = Math.min(keys[0], y) - 1; const hi = Math.max(keys[keys.length - 1], y) + 1;
  let s = 0; let F = 0; let i = 0;
  for (let k = lo; k <= hi; k++) {
    while (i < keys.length && keys[i] <= k) F += vals[i++];
    const d = F - (y <= k ? 1 : 0); s += d * d;
  }
  return s;
}
function midPit(keys, vals, y) { let below = 0; let at = 0; for (let i = 0; i < keys.length; i++) { if (keys[i] < y) below += vals[i]; else if (keys[i] === y) at = vals[i]; } return below + at / 2; }
/* E|N(mu, s^2)| */
const absN = (mu, s) => (s > 0 ? 2 * s * D.phi(mu / s) + mu * (2 * D.Phi(mu / s) - 1) : Math.abs(mu));
function crpsMixture(comps, y) {
  let a = 0; let b = 0;
  for (const c of comps) a += c.w * absN(c.m - y, c.s);
  for (const c of comps) for (const d of comps) b += c.w * d.w * absN(c.m - d.m, Math.sqrt(c.s * c.s + d.s * d.s));
  return a - b / 2;
}
function crpsNormalGrid(mu, sd, y) {
  /* a continuous normal read at half-integers on the same integer grid */
  const lo = Math.floor(Math.min(mu - 9 * sd, y)) - 1; const hi = Math.ceil(Math.max(mu + 9 * sd, y)) + 1;
  let s = 0; for (let k = lo; k <= hi; k++) { const d = D.Phi((k + 0.5 - mu) / sd) - (y <= k ? 1 : 0); s += d * d; }
  return s;
}

/** the per-game score record of one forecast row against its outcome */
function scoreRow(r, cal) {
  const P = D.parts(r, cal); const y = r.y;
  let mean = 0, m2 = 0; for (let i = 0; i < P.keys.length; i++) { mean += P.keys[i] * P.vals[i]; m2 += P.keys[i] * P.keys[i] * P.vals[i]; }
  const tm = D.mixMoments(P.comps);
  return {
    p_home: P.p_home, p_ot: P.t.p0k, reg_mu: P.mu, reg_sd: P.sd,
    m_mean: mean, m_sd: Math.sqrt(Math.max(0, m2 - mean * mean)), m_crps: crpsGrid(P.keys, P.vals, y.margin), m_pit: midPit(P.keys, P.vals, y.margin),
    t_mean: tm.mean, t_sd: tm.sd, t_crps: crpsMixture(P.comps, y.total), t_pit: D.mixCdf(P.comps, y.total),
  };
}
/** the same record for a plain normal margin/total forecast (the incumbent as served) */
function scoreNormal(p, m, t, y) {
  return { p_home: p, p_ot: null, m_mean: m.mu, m_sd: m.sd, m_crps: crpsNormalGrid(m.mu, m.sd, y.margin), m_pit: D.Phi((y.margin - m.mu) / m.sd),
    t_mean: t.mu, t_sd: t.sd, t_crps: crpsMixture([{ w: 1, m: t.mu, s: t.sd }], y.total), t_pit: D.Phi((y.total - t.mu) / t.sd) };
}

function slope(rows) {
  let a = 0, b = 1;
  const xs = rows.map((x) => { const p = Math.min(1 - EPS, Math.max(EPS, x.s.p_home)); return Math.log(p / (1 - p)); });
  for (let it = 0; it < 30; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < rows.length; i++) { const p = 1 / (1 + Math.exp(-(a + b * xs[i]))); const e = rows[i].y.hw - p; const w = p * (1 - p); g0 += e; g1 += e * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i]; }
    const det = h00 * h11 - h01 * h01; if (!det) break;
    const da = (h11 * g0 - h01 * g1) / det; const db = (h00 * g1 - h01 * g0) / det; a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { intercept: U.r(a, 4), slope: U.r(b, 4) };
}

function reliability(rows, bins) {
  const B = bins || 10; const out = [];
  for (let i = 0; i < B; i++) out.push({ lo: i / B, hi: (i + 1) / B, n: 0, p: 0, y: 0 });
  for (const x of rows) { const k = Math.min(B - 1, Math.floor(x.s.p_home * B)); out[k].n++; out[k].p += x.s.p_home; out[k].y += x.y.hw; }
  return out.map((b) => {
    const o = { band: U.r(b.lo, 2) + '-' + U.r(b.hi, 2), n: b.n, mean_forecast: b.n ? U.r(b.p / b.n, 4) : null, observed: b.n ? U.r(b.y / b.n, 4) : null };
    if (b.n) { const w = wilson(b.y, b.n); o.observed_ci95 = [U.r(w[0], 4), U.r(w[1], 4)]; }
    return o;
  });
}
function wilson(k, n) { const z = 1.959963984540054; const p = k / n; const den = 1 + z * z / n; const c = (p + z * z / (2 * n)) / den; const h = (z / den) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, c - h), Math.min(1, c + h)]; }

/** summary of scored rows: rows are { s: scoreRow(...), y } */
function summarize(rows, o) {
  const r = rows.filter((x) => x.s); const n = r.length;
  if (!n) return { n: 0 };
  let sll = 0, sb = 0, sm = 0, sm2 = 0, scm = 0, bias = 0, st = 0, sct = 0, tb = 0, pot = 0, yot = 0, nOt = 0;
  const cov = { m50: 0, m80: 0, m95: 0, t50: 0, t80: 0, t95: 0 }; const pitM = new Array(10).fill(0); const pitT = new Array(10).fill(0);
  const inBand = (u, c) => u >= (1 - c) / 2 && u <= 1 - (1 - c) / 2;
  for (const x of r) {
    const s = x.s; const y = x.y;
    sll += ll(s.p_home, y.hw); sb += (s.p_home - y.hw) ** 2;
    const em = y.margin - s.m_mean; sm += Math.abs(em); sm2 += em * em; bias += em; scm += s.m_crps;
    const et = y.total - s.t_mean; st += Math.abs(et); tb += et; sct += s.t_crps;
    for (const c of [50, 80, 95]) { if (inBand(s.m_pit, c / 100)) cov['m' + c]++; if (inBand(s.t_pit, c / 100)) cov['t' + c]++; }
    pitM[Math.min(9, Math.floor(s.m_pit * 10))]++; pitT[Math.min(9, Math.floor(s.t_pit * 10))]++;
    if (s.p_ot != null) { pot += s.p_ot; yot += y.n_ot > 0 ? 1 : 0; nOt++; }
  }
  const out = {
    n,
    win: { log_loss: U.r(sll / n, 5), brier: U.r(sb / n, 5), calibration_in_the_large: U.r(U.mean(r.map((x) => x.y.hw)) - U.mean(r.map((x) => x.s.p_home)), 4), logistic_recalibration: slope(r) },
    margin: { mae: U.r(sm / n, 3), rmse: U.r(Math.sqrt(sm2 / n), 3), crps: U.r(scm / n, 4), bias: U.r(bias / n, 3), coverage: { c50: U.r(cov.m50 / n, 4), c80: U.r(cov.m80 / n, 4), c95: U.r(cov.m95 / n, 4) }, pit_deciles: pitM.map((c) => U.r(c / n, 4)) },
    total: { mae: U.r(st / n, 3), crps: U.r(sct / n, 4), bias: U.r(tb / n, 3), coverage: { c50: U.r(cov.t50 / n, 4), c80: U.r(cov.t80 / n, 4), c95: U.r(cov.t95 / n, 4) }, pit_deciles: pitT.map((c) => U.r(c / n, 4)) },
  };
  if (nOt) out.overtime = { mean_forecast: U.r(pot / nOt, 4), observed: U.r(yot / nOt, 4), n: nOt };
  if (!o || o.reliability !== false) out.reliability = reliability(r);
  return out;
}

const PER = {
  log_loss: (x) => ll(x.s.p_home, x.y.hw),
  brier: (x) => (x.s.p_home - x.y.hw) ** 2,
  margin_crps: (x) => x.s.m_crps,
  total_crps: (x) => x.s.t_crps,
  margin_abs: (x) => Math.abs(x.y.margin - x.s.m_mean),
};
/** paired difference a - b on shared games, day-clustered bootstrap 95% CI (negative = a better) */
function compare(aRows, bRows, metric, o) {
  const bBy = new Map(bRows.filter((x) => x.s).map((x) => [x.game_id, x])); const f = PER[metric]; const pairs = [];
  for (const a of aRows) { if (!a.s) continue; const b = bBy.get(a.game_id); if (b) pairs.push({ a, b, day: Math.floor(a.start_ms / 864e5) }); }
  if (!pairs.length) return { n: 0, metric };
  const res = U.clusteredDiffCI(pairs, (p) => p.day, (p) => f(p.a) - f(p.b), Object.assign({ B: 1000, seed: 7 }, o || {}));
  return Object.assign(res, { metric, a_better: res.ci95[1] < 0, b_better: res.ci95[0] > 0 });
}

module.exports = { ll, EPS, crpsGrid, midPit, crpsMixture, crpsNormalGrid, scoreRow, scoreNormal, summarize, reliability, slope, compare, wilson, PER };

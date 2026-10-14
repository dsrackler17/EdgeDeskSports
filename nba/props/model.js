'use strict';
/* ===========================================================================
   EdgeDesk NBA props — expected minutes × per-minute production, with
   count distributions and the dependence between stats.

   1. MINUTES. Ridge regression of minutes on the player's recent and season
      minutes, start rate (and, confirmed track, tonight's starting role),
      blowout risk (|expected margin| interacted with his minutes: starters sit
      in blowouts), teammates missing (their usual usage share), whether he
      played the team's last game (a returning player is often limited), rest,
      back-to-back and foul rate. Residual sd by minutes band.
   2. PRODUCTION. For each stat a Poisson GLM, log link, offset log(expected
      minutes): log rates (recent, season, long-run; each shrunk to the
      position average), the opponent's allowed factor, pace, teammates'
      missing usage and its interaction with the player's own usage share,
      home, back-to-back and blowout risk. Expected count = minutes × rate ×
      adjustments — never a fixed bump for an absent star.
   3. DISTRIBUTION. A mixture over his minutes: the minutes model's empirical
      residual quantiles in his minutes band (eleven equal-weight nodes — the
      left tail of early exits and blowouts kept), and at each node a count
      with mean rate × minutes and the variance fitted GIVEN the minutes
      actually played, Var = a·μ + b·μ²: a negative binomial on a lattice of
      step a (a ≈ 1 for counts; above 2 for points, which arrive in 2s and
      3s — a plain negative binomial makes a 6-point scorer far too
      predictable). Most of a count's spread is playing time; a single
      unconditional dispersion understates it. Points, rebounds, assists, threes,
      steals, blocks, turnovers, field-goal and three-point attempts.
   4. DEPENDENCE. Two layers: the shared minutes node (all of a player's
      counts rise and fall with his minutes), and Pearson residual
      correlations GIVEN minutes between the nine stats. Combined props (P+R+A,
      P+R, P+A, R+A) use, at each node, the exact mean and the correlated
      variance (a moment-matched negative binomial), mixed over the nodes —
      never a sum of independent marginals; double- and triple-doubles draw a
      node, then the five counts through a Gaussian copula.
   Trained on the four seasons before the season predicted.
   =========================================================================== */
const L = require('../model/learn');
const S = require('../../engine/stats');
const { STATS } = require('./state');

const EPS = 1e-3;
const lg = (v) => Math.log(Math.max(EPS, v == null || !isFinite(v) ? EPS : v));

function minutesX(f, track) {
  const blow = Math.abs(f.margin || 0);
  const miss = track === 'C' ? f.miss_conf : f.miss_proj;
  const x = [1, f.min_ew, f.min_ss, f.start_rate, f.start_rate * blow, f.min_ew * blow / 10, miss, f.min_ew * miss, f.in_last, f.rest >= 3 ? 1 : 0, f.b2b || 0, f.g_ss < 5 ? 1 : 0, f.pf_rate];
  if (track === 'C') x.push(f.starter, f.starter * blow);
  return x;
}
function statX(f, k, track, mu_min) {
  const miss = track === 'C' ? f.miss_conf : f.miss_proj;
  return [1, lg(f['r_ew_' + k]), lg(f['r_ss_' + k]), lg(f['r_lg_' + k]), lg(f['opp_' + k]), lg((f.pace || 96) / 96), miss, miss * f.usage_share * 5, f.home, f.b2b || 0, Math.abs(f.margin || 0) / 10, lg(mu_min / Math.max(1, f.min_ew))];
}

/* negative binomial pmf over 0..max (mean mu, size r) */
function nbPmf(mu, r, max) {
  const out = new Float64Array(max + 1); const q = mu / (r + mu);
  let p = Math.exp(r * Math.log(r / (r + mu))); out[0] = p; let s = p;
  for (let y = 0; y < max; y++) { p = p * (y + r) / (y + 1) * q; out[y + 1] = p; s += p; }
  if (s < 1) out[max] += 1 - s;
  return out;
}
function nbFromMoments(mean, variance) { const v = Math.max(mean * 1.0001, variance); return { mu: mean, r: (mean * mean) / (v - mean) }; }

/* Var(y | μ) = a·μ + b·μ², weighted least squares (weights 1/(1+μ)²), a in [0.3, 5], b in [0, 2] */
function fitVarFn(mu, y) {
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < mu.length; i++) { const m = mu[i], e = (y[i] - m) * (y[i] - m), w = 1 / ((1 + m) * (1 + m)); s11 += w * m * m; s12 += w * m * m * m; s22 += w * m * m * m * m; t1 += w * m * e; t2 += w * m * m * e; }
  const det = s11 * s22 - s12 * s12;
  let a = det > 0 ? (t1 * s22 - t2 * s12) / det : 1, b = det > 0 ? (s11 * t2 - s12 * t1) / det : 0;
  if (b < 0) { b = 0; a = s11 > 0 ? t1 / s11 : 1; }
  return { a: Math.min(5, Math.max(0.3, a)), b: Math.min(2, Math.max(0, b)) };
}
/* a negative binomial on a lattice of step a: Y = a·X, X ~ NB(μ/a, 1/b) (Poisson when b → 0), so E[Y] = μ and
   Var(Y) = a·μ + b·μ². Zero stays an exact atom; every other lattice point's mass is spread uniformly over the
   integers its step covers ([v − a/2, v + a/2], by overlap), so no integer is left empty between lattice points
   (a two-neighbour split would give a 2.3 step no mass at 8 points and a jagged P(over)). When a ≤ 1 the lattice
   is at least as fine as the integers and the spread is the two-neighbour split. */
function scaledPmf(mu, a, b, max) {
  const r = b > 1e-6 ? 1 / b : 1e6; const nx = Math.ceil((max + 1) / a) + 2;
  const px = nbPmf(Math.max(1e-9, mu / a), r, nx);
  const out = new Float64Array(max + 1);
  const put = (j, m) => { out[Math.min(max, Math.max(0, j))] += m; };
  out[0] += px[0];
  for (let k = 1; k <= nx; k++) {
    const v = a * k, m = px[k]; if (!(m > 0)) continue;
    if (a <= 1) { const lo = Math.floor(v), f = v - lo; put(lo, m * (1 - f)); put(lo + 1, m * f); continue; }
    const L = Math.max(0.5, v - a / 2), U = v + a / 2, w = U - L;
    for (let j = Math.max(1, Math.round(L)); j <= Math.round(U); j++) { const ov = Math.min(U, j + 0.5) - Math.max(L, j - 0.5); if (ov > 0) put(j, m * ov / w); }
  }
  return out;
}
const K_MIN = 11; /* minutes nodes: the empirical residual quantiles of the minutes model, per band */
function fit(train, track) {
  const mX = train.map((r) => minutesX(r.f, track)); const mY = train.map((r) => r.y.min);
  const mm = L.ridge(mX, mY, { l2: 5 });
  const muMin = mX.map((x) => Math.min(44, Math.max(1, L.predictLinear(mm.beta, x))));
  const bands = [0, 12, 20, 28, 34, 99]; const sdBand = [], qBand = [];
  for (let b = 0; b < bands.length - 1; b++) {
    const e = []; for (let i = 0; i < train.length; i++) if (muMin[i] >= bands[b] && muMin[i] < bands[b + 1]) e.push(mY[i] - muMin[i]);
    sdBand.push(e.length > 30 ? Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length) : 7);
    e.sort((a, v) => a - v);
    qBand.push(e.length > 30 ? Array.from({ length: K_MIN }, (_, k) => e[Math.min(e.length - 1, Math.floor(((k + 0.5) / K_MIN) * e.length))]) : Array.from({ length: K_MIN }, (_, k) => 7 * L.qnorm((k + 0.5) / K_MIN)));
  }
  const stats = {}; const resid = {};
  for (const k of STATS) {
    const X = train.map((r, i) => statX(r.f, k, track, muMin[i]));
    const off = muMin.map((m) => Math.log(m));
    const y = train.map((r) => r.y[k]);
    const g = S.poisson(X, y, { l2: 1, offset: off });
    const mu = X.map((x, i) => Math.exp(S.dot(g.beta, x) + off[i]));
    /* the variance GIVEN the minutes he actually played: Var = a·μ + b·μ² (weighted least squares on squared
       residuals). a is the size of a scoring unit — about 1 for counts, above 2 for points, which arrive in 2s and 3s —
       and b the extra-Poisson spread. The minutes uncertainty is mixed in at prediction. */
    const muC = mu.map((m, i) => m * Math.max(0.5, mY[i]) / muMin[i]);
    const vf = fitVarFn(muC, y);
    /* the unconditional NB size (kept for reference) */
    let num2 = 0, den2 = 0; for (let i = 0; i < y.length; i++) { num2 += mu[i] * mu[i]; den2 += (y[i] - mu[i]) * (y[i] - mu[i]) - mu[i]; }
    stats[k] = { beta: g.beta, var_a: vf.a, var_b: vf.b, size: den2 > 0 ? Math.min(500, Math.max(0.5, num2 / den2)) : 500 };
    resid[k] = y.map((v, i) => (v - muC[i]) / Math.sqrt(Math.max(1e-6, vf.a * muC[i] + vf.b * muC[i] * muC[i])));
  }
  /* residual correlations GIVEN minutes: the dependence minutes create is carried by the shared minutes node */
  const corr = {};
  for (const a of STATS) { corr[a] = {}; for (const b of STATS) { let s = 0; const ra = resid[a], rb = resid[b]; for (let i = 0; i < ra.length; i++) s += ra[i] * rb[i]; corr[a][b] = a === b ? 1 : s / ra.length; } }
  return { track, minutes: { beta: mm.beta, sd_bands: bands, sd: sdBand, q: qBand }, stats, corr, n: train.length };
}

function predict(model, f) {
  const muMin = Math.min(44, Math.max(1, L.predictLinear(model.minutes.beta, minutesX(f, model.track))));
  let b = 0; for (let i = 0; i < model.minutes.sd_bands.length - 1; i++) if (muMin >= model.minutes.sd_bands[i] && muMin < model.minutes.sd_bands[i + 1]) b = i;
  const sdMin = model.minutes.sd[b];
  /* the minutes nodes (equal weight): his expected minutes plus each residual quantile, floored at half a minute (he plays) */
  const nodes = (model.minutes.q ? model.minutes.q[b] : Array.from({ length: K_MIN }, (_, k) => sdMin * L.qnorm((k + 0.5) / K_MIN))).map((e) => Math.min(53, Math.max(0.5, muMin + e)));
  const meanNode = nodes.reduce((a, v) => a + v, 0) / nodes.length;
  const out = { min: { mu: muMin, sd: sdMin, nodes }, stat: {} };
  for (const k of STATS) {
    const m = model.stats[k]; const mu0 = Math.exp(S.dot(m.beta, statX(f, k, model.track, muMin)) + Math.log(muMin));
    const lam = mu0 / muMin; const va = m.var_a == null ? 1 : m.var_a, vb = m.var_b == null ? 1 / m.size : m.var_b;
    /* mixture moments: E = λ·E[M]; Var = E[a·λM + b·(λM)²] + λ²·Var(M) */
    const means = nodes.map((x) => lam * x);
    const mu = means.reduce((a, v) => a + v, 0) / nodes.length;
    const v = means.reduce((a, x) => a + va * x + vb * x * x, 0) / nodes.length + means.reduce((a, x) => a + (x - mu) * (x - mu), 0) / nodes.length;
    out.stat[k] = { mu, var: v, r: nbFromMoments(mu, v).r, lam, a: va, b: vb, mean_minutes: meanNode };
  }
  return out;
}

/* the distribution of one stat: the negative binomial given minutes, mixed over the minutes nodes */
function mixPmf(comps, max) {
  const out = new Float64Array(max + 1);
  for (const c of comps) { const p = scaledPmf(Math.max(1e-6, c.mu), c.a, c.b, max); for (let y = 0; y <= max; y++) out[y] += p[y] / comps.length; }
  return out;
}
function maxFor(mu, v) { return Math.max(20, Math.ceil(mu + 12 * Math.sqrt(Math.max(v, mu)))); }
function statDist(pred, k) {
  const s = pred.stat[k];
  const comps = pred.min.nodes.map((m) => ({ mu: s.lam * m, a: s.a, b: s.b }));
  return { lo: 0, pmf: mixPmf(comps, maxFor(s.mu, s.var)) };
}
const COMBOS = { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'] };
function combo(model, pred, keys) {
  /* given a minutes node: the exact mean and the correlated variance (conditional correlations), a moment-matched negative binomial; mixed over the nodes */
  const vv = (s, m) => s.a * m + s.b * m * m;
  const comps = pred.min.nodes.map((m) => {
    let mean = 0, v = 0, am = 0;
    for (const a of keys) { const sa = pred.stat[a]; const ma = sa.lam * m; mean += ma; am += sa.a * ma; for (const b of keys) { const sb = pred.stat[b]; const mb = sb.lam * m; v += model.corr[a][b] * Math.sqrt(vv(sa, ma) * vv(sb, mb)); } }
    mean = Math.max(1e-6, mean); v = Math.max(1e-6, v);
    /* the lattice step is the mean-weighted scoring unit; whatever variance the step does not carry is the b term */
    let a = am / mean; let b = (v - a * mean) / (mean * mean); if (b < 0) { a = Math.max(0.3, v / mean); b = 0; }
    return { mu: mean, a, b, v };
  });
  const mu = comps.reduce((a, c) => a + c.mu, 0) / comps.length;
  const v = comps.reduce((a, c) => a + c.v, 0) / comps.length + comps.reduce((a, c) => a + (c.mu - mu) * (c.mu - mu), 0) / comps.length;
  return Object.assign(nbFromMoments(mu, v), { var: v, comps });
}
function comboDist(model, pred, keys) { const c = combo(model, pred, keys); return { lo: 0, pmf: mixPmf(c.comps, maxFor(c.mu, c.var)) }; }

/* Gaussian copula over the seven marginals → P(double-double), P(triple-double) */
function cholesky(Rm) {
  const n = Rm.length; const Lm = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = Rm[i][j]; for (let k = 0; k < j; k++) s -= Lm[i][k] * Lm[j][k]; Lm[i][j] = i === j ? Math.sqrt(Math.max(1e-9, s)) : s / Lm[j][j]; }
  return Lm;
}
function normInv(u) { return L.qnorm(u); }
function multiDouble(model, pred, n, seed) {
  /* a minutes node, then the five counts given minutes through a Gaussian copula on the conditional correlations */
  const keys = ['pts', 'reb', 'ast', 'stl', 'blk'];
  const Rm = keys.map((a) => keys.map((b) => model.corr[a][b]));
  const Lm = cholesky(Rm); const rand = S.rng(seed || 11);
  const cdfs = pred.min.nodes.map((m) => keys.map((k) => { const s = pred.stat[k]; const mu = Math.max(1e-6, s.lam * m); const max = Math.max(30, Math.ceil(mu + 10 * Math.sqrt(s.a * mu + s.b * mu * mu))); const pmf = scaledPmf(mu, s.a, s.b, max); const c = new Float64Array(pmf.length); let a = 0; for (let i = 0; i < pmf.length; i++) { a += pmf[i]; c[i] = a; } return c; }));
  let dd = 0, td = 0;
  for (let t = 0; t < n; t++) {
    const node = cdfs[Math.min(cdfs.length - 1, Math.floor(rand() * cdfs.length))];
    const z = keys.map(() => { const u1 = rand(), u2 = rand(); return Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); });
    let tens = 0;
    for (let i = 0; i < keys.length; i++) {
      let zi = 0; for (let j = 0; j <= i; j++) zi += Lm[i][j] * z[j];
      const u = S.sigmoid(1.702 * zi); /* logistic approximation to Φ, |error| < 0.01 */
      const c = node[i]; let y = 0; while (y < c.length - 1 && c[y] < u) y++;
      if (y >= 10) tens++;
    }
    if (tens >= 2) dd++; if (tens >= 3) td++;
  }
  return { dd: dd / n, td: td / n };
}

/* AVAILABILITY: P(he plays tonight), a ridge logistic on what was knowable
   the night before (nba/props/state.js availRow). The props themselves are
   priced conditional on playing (a prop on a player who does not play is
   void); this is the probability that condition holds. */
const { RC } = require('./state');
function availX(f) {
  const x = [1, f.in_last, Math.min(f.out, 10), f.out >= 3 ? 1 : 0, f.ew, f.min_ew / 48, f.start_rate, Math.min(f.g_ss, 20) / 20, f.b2b || 0, f.in_last * f.min_ew / 48];
  for (const c of RC) x.push(f['rc_' + c] || 0);
  return x;
}
function fitAvail(rows) {
  const r = rows.filter((x) => x.y != null);
  if (r.length < 2000) return null;
  const fit = L.logisticRidge(r.map((x) => availX(x.f)), r.map((x) => x.y), { l2: 1 });
  return { beta: fit.beta, n: r.length, base: r.reduce((a, x) => a + x.y, 0) / r.length };
}
function predictAvail(m, f) { return m ? L.predictLogistic(m.beta, availX(f)) : null; }

module.exports = { fit, predict, combo, comboDist, statDist, multiDouble, nbPmf, scaledPmf, fitVarFn, nbFromMoments, COMBOS, minutesX, statX, normInv, availX, fitAvail, predictAvail };

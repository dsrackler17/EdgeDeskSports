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
   3. DISTRIBUTION. Negative binomial with the stat's dispersion (method of
      moments on the training seasons): the minutes uncertainty and nightly
      variation are inside it. Points, rebounds, assists, threes, steals,
      blocks, turnovers.
   4. DEPENDENCE. Pearson residual correlations between the seven stats on the
      training seasons. Combined props (P+R+A, P+R, P+A, R+A) use the exact
      mean and the correlated variance (a moment-matched negative binomial),
      never a sum of independent marginals; double- and triple-doubles come
      from a Gaussian copula over the seven marginals.
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

function fit(train, track) {
  const mX = train.map((r) => minutesX(r.f, track)); const mY = train.map((r) => r.y.min);
  const mm = L.ridge(mX, mY, { l2: 5 });
  const muMin = mX.map((x) => Math.min(44, Math.max(1, L.predictLinear(mm.beta, x))));
  const bands = [0, 12, 20, 28, 34, 99]; const sdBand = [];
  for (let b = 0; b < bands.length - 1; b++) { const e = []; for (let i = 0; i < train.length; i++) if (muMin[i] >= bands[b] && muMin[i] < bands[b + 1]) e.push(mY[i] - muMin[i]); sdBand.push(e.length > 30 ? Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length) : 7); }
  const stats = {}; const resid = {};
  for (const k of STATS) {
    const X = train.map((r, i) => statX(r.f, k, track, muMin[i]));
    const off = muMin.map((m) => Math.log(m));
    const y = train.map((r) => r.y[k]);
    const g = S.poisson(X, y, { l2: 1, offset: off });
    const mu = X.map((x, i) => Math.exp(S.dot(g.beta, x) + off[i]));
    let num = 0, den = 0; for (let i = 0; i < y.length; i++) { num += mu[i] * mu[i]; den += (y[i] - mu[i]) * (y[i] - mu[i]) - mu[i]; }
    const r = den > 0 ? Math.min(500, Math.max(0.5, num / den)) : 500;
    stats[k] = { beta: g.beta, size: r };
    resid[k] = y.map((v, i) => (v - mu[i]) / Math.sqrt(mu[i] + mu[i] * mu[i] / r));
  }
  const corr = {};
  for (const a of STATS) { corr[a] = {}; for (const b of STATS) { let s = 0; const ra = resid[a], rb = resid[b]; for (let i = 0; i < ra.length; i++) s += ra[i] * rb[i]; corr[a][b] = a === b ? 1 : s / ra.length; } }
  return { track, minutes: { beta: mm.beta, sd_bands: bands, sd: sdBand }, stats, corr, n: train.length };
}

function predict(model, f) {
  const muMin = Math.min(44, Math.max(1, L.predictLinear(model.minutes.beta, minutesX(f, model.track))));
  let sdMin = 7; for (let b = 0; b < model.minutes.sd_bands.length - 1; b++) if (muMin >= model.minutes.sd_bands[b] && muMin < model.minutes.sd_bands[b + 1]) sdMin = model.minutes.sd[b];
  const out = { min: { mu: muMin, sd: sdMin }, stat: {} };
  for (const k of STATS) {
    const m = model.stats[k]; const mu = Math.exp(S.dot(m.beta, statX(f, k, model.track, muMin)) + Math.log(muMin));
    out.stat[k] = { mu, r: m.size, var: mu + mu * mu / m.size };
  }
  return out;
}
const COMBOS = { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'] };
function combo(model, pred, keys) {
  let mean = 0, v = 0;
  for (const a of keys) { mean += pred.stat[a].mu; for (const b of keys) v += model.corr[a][b] * Math.sqrt(pred.stat[a].var * pred.stat[b].var); }
  return Object.assign(nbFromMoments(mean, v), { var: v });
}

/* Gaussian copula over the seven marginals → P(double-double), P(triple-double) */
function cholesky(Rm) {
  const n = Rm.length; const Lm = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) { let s = Rm[i][j]; for (let k = 0; k < j; k++) s -= Lm[i][k] * Lm[j][k]; Lm[i][j] = i === j ? Math.sqrt(Math.max(1e-9, s)) : s / Lm[j][j]; }
  return Lm;
}
function normInv(u) { return L.qnorm(u); }
function multiDouble(model, pred, n, seed) {
  const keys = ['pts', 'reb', 'ast', 'stl', 'blk'];
  const Rm = keys.map((a) => keys.map((b) => model.corr[a][b]));
  const Lm = cholesky(Rm); const rand = S.rng(seed || 11);
  const cdfs = keys.map((k) => { const s = pred.stat[k]; const max = Math.max(30, Math.ceil(s.mu + 10 * Math.sqrt(s.var))); const pmf = nbPmf(s.mu, s.r, max); const c = new Float64Array(pmf.length); let a = 0; for (let i = 0; i < pmf.length; i++) { a += pmf[i]; c[i] = a; } return c; });
  let dd = 0, td = 0;
  for (let t = 0; t < n; t++) {
    const z = keys.map(() => { let u1 = rand(), u2 = rand(); return Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); });
    let tens = 0;
    for (let i = 0; i < keys.length; i++) {
      let zi = 0; for (let j = 0; j <= i; j++) zi += Lm[i][j] * z[j];
      const u = S.sigmoid(1.702 * zi); /* logistic approximation to Φ, |error| < 0.01 */
      const c = cdfs[i]; let y = 0; while (y < c.length - 1 && c[y] < u) y++;
      if (y >= 10) tens++;
    }
    if (tens >= 2) dd++; if (tens >= 3) td++;
  }
  return { dd: dd / n, td: td / n };
}

module.exports = { fit, predict, combo, multiDouble, nbPmf, nbFromMoments, COMBOS, minutesX, statX, normInv };

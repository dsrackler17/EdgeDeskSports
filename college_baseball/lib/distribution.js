'use strict';
/* ===========================================================================
   EdgeDesk college baseball — run distributions (Model 4) and the outcome
   probabilities derived from them.

   FAMILIES (compared in validation/run_distribution.json):
     poisson     X ~ Poisson(lambda)
     nb          X ~ NegBin(mean lambda, size r)        Var = l + l^2/r
     nb_frailty  X | G ~ NegBin(lambda*G, r0), Y | G ~ NegBin(mu*G, r0),
                 G ~ Gamma(k, 1/k) shared: the two teams' runs are positively
                 correlated (park, weather, umpire, scoring conditions not in
                 the model) and each marginal is more dispersed than r0 alone.

   TIES DO NOT EXIST IN BASEBALL. A count model puts ~9% of its mass on equal
   scores. That mass is resolved with the measured extra-inning behaviour:
     - P(home wins | tied) from an inning-by-inning computation with each
       side's per-half-inning run distribution scaled to its strength, the home
       side batting last (a walk-off ends the game);
     - the resolved margin and the runs added are the measured distributions
       of real extra-inning games (lib/constants.js).
   The same is true of a home win in the last scheduled inning (a walk-off
   stops the scoring); the closed form leaves that to the simulator (Model 5),
   which is why run lines are checked against both.

   Everything is a pmf on 0..K with the tail folded into K, so every derived
   probability sums to one exactly (checked in tools/college_baseball tests).
   =========================================================================== */
const K_MAX = 40;

function nbPmf(mean, r, K) {
  K = K || K_MAX;
  const out = new Float64Array(K + 1);
  if (!(mean > 0)) { out[0] = 1; return out; }
  if (!isFinite(r) || r > 1e6) return poissonPmf(mean, K);
  const p = r / (r + mean); const q = mean / (r + mean);
  let pk = Math.exp(r * Math.log(p));
  let tot = 0;
  for (let k = 0; k < K; k++) { out[k] = pk; tot += pk; pk = pk * (k + r) / (k + 1) * q; }
  out[K] = Math.max(0, 1 - tot);
  return out;
}
function poissonPmf(mean, K) {
  K = K || K_MAX;
  const out = new Float64Array(K + 1);
  let pk = Math.exp(-mean); let tot = 0;
  for (let k = 0; k < K; k++) { out[k] = pk; tot += pk; pk = pk * mean / (k + 1); }
  out[K] = Math.max(0, 1 - tot);
  return out;
}

/* Gauss-Laguerre-free quadrature for G ~ Gamma(k, 1/k): equal-probability nodes (quantiles) */
const QN = 16;
function gammaQuantiles(k) {
  /* Wilson-Hilferty approximation of gamma quantiles, renormalised to mean 1 */
  const nodes = [];
  for (let i = 0; i < QN; i++) {
    const u = (i + 0.5) / QN;
    const z = normInv(u);
    const x = Math.max(1e-6, Math.pow(1 - 1 / (9 * k) + z * Math.sqrt(1 / (9 * k)), 3));
    nodes.push(x);
  }
  const m = nodes.reduce((a, b) => a + b, 0) / QN;
  return nodes.map((x) => x / m);
}
function normInv(p) {
  /* Acklam's rational approximation */
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const gqCache = new Map();

/** joint pmf matrix P[h][a] (flat Float64Array, index h*(K+1)+a) */
function joint(lh, la, spec) {
  spec = spec || { family: 'nb', r: 4 };
  const K = spec.K || K_MAX; const n = K + 1;
  const P = new Float64Array(n * n);
  const fill = (ph, pa, w) => { for (let h = 0; h < n; h++) { const x = ph[h] * w; if (x < 1e-14) continue; for (let a = 0; a < n; a++) P[h * n + a] += x * pa[a]; } };
  if (spec.family === 'poisson') fill(poissonPmf(lh, K), poissonPmf(la, K), 1);
  else if (spec.family === 'nb') fill(nbPmf(lh, spec.r, K), nbPmf(la, spec.r, K), 1);
  else if (spec.family === 'nb_frailty') {
    if (!gqCache.has(spec.k)) gqCache.set(spec.k, gammaQuantiles(spec.k));
    for (const g of gqCache.get(spec.k)) fill(nbPmf(lh * g, spec.r, K), nbPmf(la * g, spec.r, K), 1 / QN);
  } else throw new Error('unknown family ' + spec.family);
  return { P, K };
}

/** marginal pmf of one team's runs under a family (for distributional scores) */
function marginal(l, spec) {
  if (spec.family === 'poisson') return poissonPmf(l);
  if (spec.family === 'nb') return nbPmf(l, spec.r);
  if (!gqCache.has(spec.k)) gqCache.set(spec.k, gammaQuantiles(spec.k));
  const out = new Float64Array(K_MAX + 1);
  for (const g of gqCache.get(spec.k)) { const p = nbPmf(l * g, spec.r); for (let i = 0; i <= K_MAX; i++) out[i] += p[i] / QN; }
  return out;
}

/* ---------------------------------------------------------------- extra innings */
/** per-half-inning pmf for a side scoring `rate` x the league half-inning mean, from the measured shape */
function halfInningPmf(shape, scale) {
  /* scale the measured shape by moving mass out of / into zero: keeps the shape of the positive part */
  const p0 = shape[0]; const pos = shape.slice(1); const m = shape.reduce((a, v, i) => a + v * i, 0);
  const target = m * scale;
  const posMean = pos.reduce((a, v, i) => a + v * (i + 1), 0) / Math.max(1e-12, 1 - p0);
  let q = Math.min(0.999, Math.max(0.001, target / posMean));   // P(score at least once)
  const out = [1 - q]; for (let i = 0; i < pos.length; i++) out.push(q * pos[i] / Math.max(1e-12, 1 - p0));
  return out;
}

/** P(home wins | tied entering extra innings), home batting last, by inning recursion */
function extraInningsHomeWin(strengthH, strengthA, constants) {
  const shape = constants.half_inning.extra;
  const pa = halfInningPmf(shape, strengthA); const ph = halfInningPmf(shape, strengthH);
  let win = 0; let lose = 0; let tie = 0;
  for (let a = 0; a < pa.length; a++) {
    let below = 0; for (let h = 0; h < ph.length; h++) { if (h > a) win += pa[a] * ph[h]; else if (h === a) tie += pa[a] * ph[h]; else below += ph[h]; }
    lose += pa[a] * below;
  }
  /* repeated innings: P(home) = win / (win + lose) */
  return win / Math.max(1e-12, win + lose);
}

/* ---------------------------------------------------------------- outcomes */
const resCache = new WeakMap();
function resolution(constants) {
  if (resCache.has(constants)) return resCache.get(constants);
  const ex = constants.extra_resolution;
  const norm = (a, from) => { const t = a.slice(from).reduce((x, y) => x + y, 0); return a.map((v, i) => (i < from || !t ? 0 : v / t)); };
  const out = { added: norm(ex.added_runs, 0), home: norm(ex.home_margin, 1), away: norm(ex.away_margin, 1) };
  resCache.set(constants, out);
  return out;
}
/**
 * outcomes(lh, la, spec, constants, opts) -> {
 *   p_home, p_away, p_tie_regulation, total_pmf, margin_pmf (index m+K), exp_home, exp_away, exp_total
 * }
 * opts.leagueRate: league runs per team-game (for strength in extra innings)
 */
function outcomes(lh, la, spec, constants, opts) {
  opts = opts || {};
  const { P, K } = joint(lh, la, spec); const n = K + 1;
  let pH = 0; let pA = 0; let pT = 0;
  const total = new Float64Array(2 * K + 1 + 20); const margin = new Float64Array(4 * K + 1);
  const tieAt = new Float64Array(n);
  for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) {
    const p = P[h * n + a]; if (p === 0) continue;
    if (h > a) pH += p; else if (h < a) pA += p; else { pT += p; tieAt[h] += p; continue; }
    total[h + a] += p; margin[h - a + 2 * K] += p;
  }
  const league = opts.leagueRate || constants.runs_per_team_game;
  const pHx = extraInningsHomeWin(lh / league, la / league, constants);
  const ex = resolution(constants);
  /* resolve each tied score s:s (the stored shapes are rounded; they are renormalised so every pmf sums to one) */
  for (let s = 0; s < n; s++) {
    const p = tieAt[s]; if (!p) continue;
    for (let add = 0; add < ex.added.length; add++) if (ex.added[add]) total[2 * s + add] += p * ex.added[add];
    for (let m = 1; m < ex.home.length; m++) margin[m + 2 * K] += p * pHx * ex.home[m];
    for (let m = 1; m < ex.away.length; m++) margin[-m + 2 * K] += p * (1 - pHx) * ex.away[m];
  }
  const pHome = pH + pT * pHx;
  let et = 0; for (let t = 0; t < total.length; t++) et += t * total[t];
  return { p_home: pHome, p_away: 1 - pHome, p_tie_regulation: pT, p_home_extra: pHx, total_pmf: total, margin_pmf: margin, margin_offset: 2 * K, exp_home: lh, exp_away: la, exp_total: et };
}

/* ---------------------------------------------------------------- scores */
function logScore(pmf, k) { const i = Math.min(k, pmf.length - 1); return -Math.log(Math.max(1e-12, pmf[i])); }
function rpsPmf(pmf, k) { let cp = 0; let s = 0; for (let i = 0; i < pmf.length - 1; i++) { cp += pmf[i]; const co = k <= i ? 1 : 0; s += (cp - co) * (cp - co); } return s; }
function quantile(pmf, q, offset) { let c = 0; for (let i = 0; i < pmf.length; i++) { c += pmf[i]; if (c >= q) return i - (offset || 0); } return pmf.length - 1 - (offset || 0); }
function cdfAt(pmf, x, offset) { let c = 0; for (let i = 0; i < pmf.length && i - (offset || 0) <= x; i++) c += pmf[i]; return c; }

/** fit the NB size r by maximum likelihood on rows {mean, y} (golden-section on log r) */
function fitNbSize(rows, lo, hi) {
  const ll = (r) => { let s = 0; for (const x of rows) s += logScore(nbPmf(x.mean, r), x.y); return s; };
  let a = Math.log(lo || 0.5); let b = Math.log(hi || 200); const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a); let d = a + g * (b - a); let fc = ll(Math.exp(c)); let fd = ll(Math.exp(d));
  for (let i = 0; i < 40; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = ll(Math.exp(c)); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = ll(Math.exp(d)); }
  }
  return Math.exp((a + b) / 2);
}

/* ---------------------------------------------------------------- fast P(home) */
/**
 * P(home wins) is smooth in (log lh, log la). A table on a log grid with
 * bilinear interpolation is accurate to ~1e-4 (checked in the tests against
 * outcomes()) and makes scenario mixtures and walk-forwards cheap.
 */
const tables = new Map();
function pHomeTable(spec, constants) {
  const key = JSON.stringify(spec) + '|' + constants.runs_per_team_game + '|' + constants.extra_resolution.home_win_share;
  if (tables.has(key)) return tables.get(key);
  const lo = Math.log(0.4); const hi = Math.log(30); const n = 240; const step = (hi - lo) / (n - 1);
  const T = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) T[i * n + j] = outcomes(Math.exp(lo + i * step), Math.exp(lo + j * step), spec, constants).p_home;
  const f = (lh, la) => {
    const x = Math.min(n - 1.000001, Math.max(0, (Math.log(lh) - lo) / step)); const y = Math.min(n - 1.000001, Math.max(0, (Math.log(la) - lo) / step));
    const i = Math.floor(x); const j = Math.floor(y); const dx = x - i; const dy = y - j;
    return T[i * n + j] * (1 - dx) * (1 - dy) + T[(i + 1) * n + j] * dx * (1 - dy) + T[i * n + j + 1] * (1 - dx) * dy + T[(i + 1) * n + j + 1] * dx * dy;
  };
  tables.set(key, f);
  return f;
}

/* ---------------------------------------------------------------- the pricing distribution */
/**
 * closedForm(lh, la, sd, p7, spec, constants) -> the distribution every full-game market is priced from.
 *
 * A mixture of outcomes(): over the rating uncertainty (the same three-point Gauss-Hermite rule on the
 * log run ratio as team_quality.integrate, weights 2/3, 1/6, 1/6 at 0 and +/- sqrt(3) sd) and over the
 * scheduled length (seven innings with probability p7, the expectations scaled by the measured
 * seven-inning factor). Its P(home) is therefore the validated probability (calibration.pOf computes the
 * same mixture through the P(home) table).
 *
 * Each side's final-runs pmf is built too, so team totals agree with the game total: a tied regulation
 * score s:s gets the measured extra-inning runs, split by expected shares (the winner (added + margin)/2,
 * the loser (added - margin)/2) and placed on the two nearest integers, so each side's mean is exact and
 * E[home] + E[away] = E[total].
 */
function closedForm(lh, la, sd, p7, spec, constants) {
  const ex = resolution(constants);
  const mean = (a) => a.reduce((x, v, i) => x + v * i, 0);
  const eAdded = mean(ex.added); const eMh = mean(ex.home); const eMa = mean(ex.away);
  const s3 = Math.sqrt(3) * (sd > 0 ? sd : 0);
  const nodes = s3 > 0 ? [[2 / 3, 0], [1 / 6, s3], [1 / 6, -s3]] : [[1, 0]];
  const f7 = constants.seven_inning_factor || 0.77;
  const lens = p7 > 0 ? [[1 - p7, 1], [p7, f7]] : [[1, 1]];
  const KM = K_MAX + 30;
  const out = { p_home: 0, total_pmf: new Float64Array(2 * KM + 1), margin_pmf: new Float64Array(2 * KM + 1), margin_offset: KM, home_pmf: new Float64Array(KM + 1), away_pmf: new Float64Array(KM + 1), components: [] };
  const spread = (arr, x, p) => { const lo = Math.floor(x); const f = x - lo; arr[Math.min(KM, lo)] += p * (1 - f); arr[Math.min(KM, lo + 1)] += p * f; };
  for (const [wn, d] of nodes) for (const [wl, len] of lens) {
    const w = wn * wl; if (!(w > 0)) continue;
    const ch = lh * len * Math.exp(d / 2); const ca = la * len * Math.exp(-d / 2);
    const o = outcomes(ch, ca, spec, constants);
    out.p_home += w * o.p_home; out.components.push({ w, lh: ch, la: ca, p_home: o.p_home });
    for (let t = 0; t < o.total_pmf.length; t++) if (o.total_pmf[t]) out.total_pmf[Math.min(2 * KM, t)] += w * o.total_pmf[t];
    for (let i = 0; i < o.margin_pmf.length; i++) if (o.margin_pmf[i]) { const m = i - o.margin_offset; out.margin_pmf[Math.max(0, Math.min(2 * KM, m + KM))] += w * o.margin_pmf[i]; }
    /* each side's final runs: decided regulation scores as they are, ties resolved by expected extra-inning shares */
    const { P, K } = joint(ch, ca, spec); const n = K + 1;
    const pHx = o.p_home_extra;
    const addH = eAdded / 2 + (pHx * eMh - (1 - pHx) * eMa) / 2; const addA = eAdded - addH;
    for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) {
      const p = P[h * n + a]; if (p === 0) continue;
      if (h !== a) { out.home_pmf[h] += w * p; out.away_pmf[a] += w * p; } else { spread(out.home_pmf, h + addH, w * p); spread(out.away_pmf, a + addA, w * p); }
    }
  }
  /* outcomes() renormalises the stored extra-inning shapes, so every pmf sums to one up to the K cut-off */
  const norm = (a) => { const t = a.reduce((x, y) => x + y, 0); if (t > 0) for (let i = 0; i < a.length; i++) a[i] /= t; };
  norm(out.total_pmf); norm(out.margin_pmf); norm(out.home_pmf); norm(out.away_pmf);
  out.p_away = 1 - out.p_home;
  out.exp_home = mean(out.home_pmf); out.exp_away = mean(out.away_pmf); out.exp_total = mean(out.total_pmf);
  return out;
}

module.exports = { K_MAX, closedForm, pHomeTable, nbPmf, poissonPmf, joint, marginal, outcomes, extraInningsHomeWin, halfInningPmf, logScore, rpsPmf, quantile, cdfAt, fitNbSize, normInv, gammaQuantiles };

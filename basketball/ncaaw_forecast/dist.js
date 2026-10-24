'use strict';
/* ===========================================================================
   ONE predictive distribution per game. Win probability, margin, total,
   overtime and the score are all read from it, so they cannot disagree.

   REGULATION. The regulation margin M (home minus away at 40:00) is integer
   valued:  P(M = k) = Phi((k + .5 - mu)/sd) - Phi((k - .5 - mu)/sd),
   with mu = a + b * raw_margin and sd^2 = s0 + k_var * var_param fitted on
   earlier games (fit() below). Regulation margins are OBSERVED for every
   game: 0 when the game went to overtime, the final margin otherwise.

   ENDGAME (tie mass). A tie at the end of regulation is more common in
   basketball than a smooth margin curve implies (the trailing side plays for
   the tying shot). kappa scales the tie mass: P'(M = 0) = min(.5, kappa *
   P(M = 0)), every other value rescaled so the masses sum to 1. kappa is
   fitted as (overtime games observed) / (tie mass predicted) on earlier
   games; kappa = 1 is the smooth curve. Its value and its out-of-sample OT
   calibration are reported (validation/), never assumed.

   OVERTIME. A 5-minute period with margin per period
   ~ discretised Normal(mu * 5/40, sd_ot); a tied period repeats. So
   P(home wins | OT) = q+ / (q+ + q-), and the final margin of an OT game is
   the deciding period's margin. sd_ot is fitted by maximum likelihood on the
   final margins of earlier overtime games.

   TOTAL. Regulation total ~ Normal(c + d * raw_total, s0t + kt * var_param),
   correlated with the regulation margin (rho, fitted on non-overtime games),
   plus, per overtime period, Normal(ot_mean_ratio * mu_T * 5/40, sd_ot_total).
   The shared pace of the two teams is what the total's spread and its
   correlation with the margin carry; it is not modelled twice.

   P(home wins) = sum_{k >= 1} P'(M = k) + P'(M = 0) * P(home wins | OT).
   Nothing else in the system computes a win probability.

   The SIMULATOR draws from exactly this distribution (drawWinner, drawGame),
   and simulator/tests checks the simulated frequencies against winProb().

   Normal CDF: W. J. Cody's rational Chebyshev approximation of erfc as
   presented by Hart (1968, algorithm 5666; West 2005), double precision, so
   one-point masses far in a tail stay accurate.
   =========================================================================== */

const OT_FRACTION = 5 / 40;
const SQRT2PI = Math.sqrt(2 * Math.PI);

/** standard normal CDF, double precision (Hart 5666 / West 2005) */
function Phi(z) {
  if (Number.isNaN(z)) return NaN;
  const x = Math.abs(z);
  let c;
  if (x > 37) c = 0;
  else {
    const e = Math.exp(-x * x / 2);
    if (x < 7.07106781186547) {
      let n = 3.52624965998911e-2 * x + 0.700383064443688; n = n * x + 6.37396220353165; n = n * x + 33.912866078383; n = n * x + 112.079291497871; n = n * x + 221.213596169931; n = n * x + 220.206867912376;
      let d = 8.83883476483184e-2 * x + 1.75566716318264; d = d * x + 16.064177579207; d = d * x + 86.7807322029461; d = d * x + 296.564248779674; d = d * x + 637.333633378831; d = d * x + 793.826512519948; d = d * x + 440.413735824752;
      c = e * n / d;
    } else {
      let d = x + 0.65; d = x + 4 / d; d = x + 3 / d; d = x + 2 / d; d = x + 1 / d;
      c = e / d / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}
const phi = (z) => Math.exp(-0.5 * z * z) / SQRT2PI;

/** mass of the integer k under Normal(mu, sd) discretised at half-integers */
function cellMass(k, mu, sd) { return Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); }

/** win/tie/loss masses of one overtime period and P(home wins | OT) */
function overtime(mu, cal) {
  const m = mu * OT_FRACTION; const s = cal.ot.sd;
  const loss = Phi((-0.5 - m) / s); const win = 1 - Phi((0.5 - m) / s);
  const tie = Math.max(0, 1 - loss - win);
  return { mu: m, sd: s, win, loss, tie, p_home: win / (win + loss) };
}

/** the regulation scale: mean, sd, tie mass after the endgame factor */
/* VARIANCE FUNCTION. Margin variance grows with the number of possessions
   (a faster game has more scoring events), with the size of the mismatch
   (blowouts end in garbage time) and with the uncertainty of the ratings:
     var = s0 + k * var_param + t * (tempo - 68) + m * |mu|     (floored at 25)
   fitted by least squares of squared residuals on those terms. A config with
   variance 'v1' fits s0 + k * var_param only (the research calibrator). */
const TEMPO_REF = 68;
const VAR_FLOOR = 25;
function varAt(v, row, mu) {
  const x = v.s0 + v.k * (row.var_param || 0) + (v.t || 0) * ((row.tempo == null ? TEMPO_REF : row.tempo) - TEMPO_REF) + (v.m || 0) * Math.abs(mu || 0);
  return Math.max(VAR_FLOOR, x);
}
function regulation(row, cal) {
  const mu = cal.margin.a * (row.neutral ? 0 : 1) + cal.margin.b * row.margin;
  const sd = Math.sqrt(varAt(cal.var_margin, row, mu));
  return { mu, sd };
}

function tieMass(mu, sd, kappa) {
  const p0 = cellMass(0, mu, sd);
  const p0k = Math.min(0.5, kappa * p0);
  return { p0, p0k, scale: p0 >= 1 ? 0 : (1 - p0k) / (1 - p0) };
}

/** P(home wins) for a regulation (mu, sd): the only win-probability formula */
function winProbAt(mu, sd, cal) {
  const t = tieMass(mu, sd, cal.kappa);
  const above = 1 - Phi((0.5 - mu) / sd);
  return t.scale * above + t.p0k * overtime(mu, cal).p_home;
}

/** the pieces every summary and score is read from: the final-margin PMF
    (integer keys, normalised) and the total's normal mixture over overtime
    periods */
function parts(row, cal) {
  const { mu, sd } = regulation(row, cal);
  const t = tieMass(mu, sd, cal.kappa);
  const ot = overtime(mu, cal);
  /* final-margin PMF: regulation decisions plus OT decisions (deciding period) */
  const lo = Math.floor(Math.min(mu - 9 * sd, ot.mu - 9 * ot.sd)) - 1; const hi = Math.ceil(Math.max(mu + 9 * sd, ot.mu + 9 * ot.sd)) + 1;
  const decide = ot.win + ot.loss;
  const keys = []; const vals = []; let mass = 0;
  for (let k = lo; k <= hi; k++) {
    if (k === 0) continue;
    const p = t.scale * cellMass(k, mu, sd) + t.p0k * cellMass(k, ot.mu, ot.sd) / decide;
    keys.push(k); vals.push(p); mass += p;
  }
  /* normalise the 9-sd truncation (the mass is 1 to ~1e-18) */
  for (let i = 0; i < vals.length; i++) vals[i] /= mass;
  /* totals: mixture over the number of overtime periods */
  const muT = cal.total.c + cal.total.d * row.total;
  const sdT = Math.sqrt(varAt(cal.var_total, row, 0));
  const otT = cal.ot_total.ratio * muT * OT_FRACTION; const sdOtT = cal.ot_total.sd;
  const muTgivenTie = muT + cal.rho * (sdT / sd) * (0 - mu);
  const sdTgivenTie = sdT * Math.sqrt(Math.max(0, 1 - cal.rho * cal.rho));
  /* E[T_reg] = muT splits exactly into its no-tie and tie parts */
  const comps = [{ w: 1 - t.p0k, m: t.p0k < 1 ? (muT - t.p0k * muTgivenTie) / (1 - t.p0k) : muT, s: sdT }];
  let pn = t.p0k * (1 - ot.tie);
  for (let n = 1; n <= 6 && pn > 1e-12; n++) { comps.push({ w: pn, m: muTgivenTie + n * otT, s: Math.sqrt(sdTgivenTie * sdTgivenTie + n * sdOtT * sdOtT) }); pn *= ot.tie; }
  const wsum = comps.reduce((a, c) => a + c.w, 0);
  for (const c of comps) c.w /= wsum;
  return { mu, sd, t, ot, keys, vals, comps, p_home: winProbAt(mu, sd, cal) };
}

function mixCdf(comps, x) { let a = 0; for (const c of comps) a += c.w * Phi((x - c.m) / c.s); return a; }
function mixMoments(comps) {
  const m = comps.reduce((a, c) => a + c.w * c.m, 0);
  return { mean: m, sd: Math.sqrt(Math.max(0, comps.reduce((a, c) => a + c.w * (c.s * c.s + c.m * c.m), 0) - m * m)) };
}
function mixQuantile(comps, p) {
  const { mean, sd } = mixMoments(comps); let a = mean - 12 * sd; let b = mean + 12 * sd;
  for (let i = 0; i < 70; i++) { const m = (a + b) / 2; if (mixCdf(comps, m) < p) a = m; else b = m; }
  return (a + b) / 2;
}
function pmfQuantile(keys, vals, p) { let c = 0; for (let i = 0; i < keys.length; i++) { c += vals[i]; if (c >= p - 1e-12) return keys[i]; } return keys[keys.length - 1]; }

/** the full distribution of one game */
function forecast(row, cal, o) {
  o = o || {};
  const P = parts(row, cal);
  let mean = 0, m2 = 0;
  for (let i = 0; i < P.keys.length; i++) { mean += P.keys[i] * P.vals[i]; m2 += P.keys[i] * P.keys[i] * P.vals[i]; }
  const q = (p) => pmfQuantile(P.keys, P.vals, p);
  const tm = mixMoments(P.comps); const tq = (p) => mixQuantile(P.comps, p);
  const out = {
    p_home: P.p_home, p_away: 1 - P.p_home, p_ot: P.t.p0k,
    regulation: { mu: P.mu, sd: P.sd, tie_mass: P.t.p0k, tie_mass_smooth: P.t.p0 },
    overtime: { p_home: P.ot.p_home, per_period_tie: P.ot.tie, sd: P.ot.sd },
    margin: { mean, sd: Math.sqrt(Math.max(0, m2 - mean * mean)), q05: q(0.05), q10: q(0.1), q25: q(0.25), q50: q(0.5), q75: q(0.75), q90: q(0.9), q95: q(0.95) },
    total: { mean: tm.mean, sd: tm.sd, q05: tq(0.05), q10: tq(0.1), q50: tq(0.5), q90: tq(0.9), q95: tq(0.95) },
    pts_home: (tm.mean + mean) / 2, pts_away: (tm.mean - mean) / 2,
  };
  if (o.pmf) out.pmf = P.keys.map((k, i) => [k, P.vals[i]]);
  return out;
}

/* ------------------------------------------------------------------ simulation draws
   rng: an object with nextOpen() in (0, 1) (simulator/src/core/prng.ts Xoshiro128).
   The regulation margin is drawn by inversion of the discretised normal with
   the endgame tie mass; a tie draws overtime periods until one is decided.
   drawWinner consumes ONE uniform per game when no overtime is needed, so the
   number of draws is documented and fixed per decision path. */
function drawWinner(mu, sd, cal, rng) {
  return rng.nextOpen() < winProbAt(mu, sd, cal) ? 1 : 0;
}
function drawRegulation(mu, sd, cal, u) {
  const t = tieMass(mu, sd, cal.kappa);
  const below = Phi((-0.5 - mu) / sd) * t.scale; // P(M <= -1)
  if (u < below) { const p = u / t.scale; return Math.min(-1, Math.round(mu + sd * invPhi(p))); }
  if (u < below + t.p0k) return 0;
  const p = (u - below - t.p0k) / t.scale + Phi((0.5 - mu) / sd);
  return Math.max(1, Math.round(mu + sd * invPhi(Math.min(1 - 1e-16, p))));
}
/** a whole game (margin incl. overtime and its periods), for traces and tests */
function drawGame(mu, sd, cal, rng) {
  let m = drawRegulation(mu, sd, cal, rng.nextOpen()); let n = 0;
  if (m !== 0) return { margin: m, n_ot: 0 };
  const ot = overtime(mu, cal);
  while (m === 0 && n < 20) { n++; m = Math.round(ot.mu + ot.sd * invPhi(rng.nextOpen())); }
  if (m === 0) m = rng.nextOpen() < ot.p_home ? 1 : -1;
  return { margin: m, n_ot: n };
}
/* inverse normal (Acklam with one Halley step: ~1e-15) */
function invPhi(p) {
  if (!(p > 0 && p < 1)) throw new Error('invPhi: p in (0,1) required: ' + p);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let x; const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else { const q = p - 0.5; const r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  const e = Phi(x) - p; const u = e * SQRT2PI * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/* ------------------------------------------------------------------ fitting
   rows: { margin, total, var_param, neutral, y: { margin, total, n_ot } }
   (raw model outputs and outcomes of games that finished BEFORE the fit). */
function ols(x, y) {
  const n = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const den = n * sxx - sx * sx; const b = den ? (n * sxy - sx * sy) / den : 0;
  return { a: (sy - b * sx) / n, b };
}
/* y ~ a * home + b * x, no constant (basketball/walkforward.js olsHome) */
function olsHome(h, x, y) {
  let shh = 0, shx = 0, sxx = 0, shy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) { shh += h[i] * h[i]; shx += h[i] * x[i]; sxx += x[i] * x[i]; shy += h[i] * y[i]; sxy += x[i] * y[i]; }
  const det = shh * sxx - shx * shx;
  if (!det) return { a: 0, b: sxx ? sxy / sxx : 1 };
  return { a: (sxx * shy - shx * sxy) / det, b: (shh * sxy - shx * shy) / det };
}
/* least squares of y on the columns of X (with intercept first), normal equations */
function lsq(X, y) {
  const p = X[0].length; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) { const x = X[i]; for (let j = 0; j < p; j++) { b[j] += x[j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += x[j] * x[k]; } }
  for (let j = 0; j < p; j++) A[j][j] += 1e-9;
  /* Gaussian elimination with partial pivoting */
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < p; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k < p; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const x = new Array(p).fill(0);
  for (let c = p - 1; c >= 0; c--) { let s = b[c]; for (let k = c + 1; k < p; k++) s -= A[c][k] * x[k]; x[c] = s / A[c][c]; }
  return x;
}
/** variance function v2: s0 + k v + t (tempo - 68) + m |mu|, every slope >= 0 */
function varFit2(e, rows, mus, useMu) { return varFit2Sq(e.map((x) => x * x), rows, mus, useMu); }
/* the same law fitted to per-row targets of the squared residual (fit() passes
   tie-corrected targets) */
function varFit2Sq(sq, rows, mus, useMu) {
  const cols = (r, i) => [1, r.var_param || 0, (r.tempo == null ? TEMPO_REF : r.tempo) - TEMPO_REF].concat(useMu ? [Math.abs(mus[i])] : []);
  let active = [true, true, true, useMu];
  for (let pass = 0; pass < 4; pass++) {
    const idx = active.map((a, j) => (a ? j : -1)).filter((j) => j >= 0);
    const X = rows.map((r, i) => { const c = cols(r, i); return idx.map((j) => c[j]); });
    const beta = lsq(X, sq); const full = [0, 0, 0, 0]; idx.forEach((j, q) => { full[j] = beta[q]; });
    /* a negative slope is not a variance law we would publish: drop it and refit */
    const neg = [1, 2, 3].filter((j) => active[j] && full[j] < 0);
    if (!neg.length) return { s0: Math.max(VAR_FLOOR, full[0]), k: full[1], t: full[2], m: full[3] };
    for (const j of neg) active[j] = false;
  }
  return varFitSq(sq, rows.map((r) => r.var_param || 0));
}
function varFit(e, v) { return varFitSq(e.map((x) => x * x), v); }
function varFitSq(sq, v) {
  const n = sq.length;
  const mv = v.reduce((a, x) => a + x, 0) / n; const ms = sq.reduce((a, x) => a + x, 0) / n;
  let svv = 0; for (const x of v) svv += (x - mv) * (x - mv);
  if (svv / n > 1e-9) {
    const f = ols(v, sq); let k = Math.max(0, f.b); let s0 = ms - k * mv;
    if (s0 < 1) { s0 = 1; k = Math.max(0, (ms - s0) / Math.max(1e-9, mv)); }
    return { s0, k };
  }
  return { s0: ms, k: 0 };
}

const MIN_ROWS = 300;
function fit(all, o) {
  o = o || {};
  const rows = all.filter((r) => Number.isFinite(r.margin) && Number.isFinite(r.total) && Number.isFinite(r.var_param || 0) && r.y);
  if (rows.length < (o.min_rows || MIN_ROWS)) return null;
  const regM = rows.map((r) => (r.y.n_ot > 0 ? 0 : r.y.margin));
  const home = rows.map((r) => (r.neutral ? 0 : 1)); const x = rows.map((r) => r.margin);
  /* the variance law per target: o.variance = { margin: 'v1'|'v2', total: 'v1'|'v2' } (or one string for both) */
  const vspec = typeof o.variance === 'string' ? { margin: o.variance, total: o.variance } : Object.assign({ margin: 'v1', total: 'v2' }, o.variance || {});
  const fitVar = (sq, mus) => (vspec.margin === 'v2' ? varFit2Sq(sq, rows, mus, true) : varFitSq(sq, rows.map((r) => r.var_param || 0)));
  const nOt = rows.reduce((a, r) => a + (r.y.n_ot > 0 ? 1 : 0), 0);
  const kappaOf = (mus, vm) => {
    let pred = 0; for (let i = 0; i < rows.length; i++) pred += cellMass(0, mus[i], Math.sqrt(varAt(vm, rows[i], mus[i])));
    return { pred, kappa: o.kappa != null ? o.kappa : Math.min(3, Math.max(0.5, pred > 0 ? nOt / pred : 1)) };
  };
  /* The intercept is a HOME-game correction: a neutral site has no home side
     to correct (basketball/walkforward.js CAL_VERSION v2 found the pooled
     intercept mispriced every neutral game).
     LOCATION AND SPREAD ARE FITTED TO THE MODEL'S OWN REGULATION MARGIN. The
     endgame factor moves mass into the tie and shrinks every other cell by
     scale = (1 - kappa p0) / (1 - p0) (tieMass), so under the model
       E[M_reg] = scale mu,   Var[M_reg] = scale sd^2 + scale / 12 + scale (1 - scale) mu^2.
     A plain regression of the regulation margin estimates scale * b, and its
     squared residuals the compressed variance; read back as mu and sd they
     would shrink every forecast twice (a synthetic-recovery test caught it).
     So the location (regressors scaled by each row's scale), the variance law
     (fitted to the tie-corrected targets) and kappa are solved together by
     fixed-point iteration, started from the plain fit. */
  /* o.location_fit: 'tie_consistent' (below) or 'plain' (the first champion's
     fit, kept bit-for-bit so a promoted model reproduces; model.js
     DEFAULT_CALIBRATION) */
  const tieConsistent = o.location_fit === 'tie_consistent';
  let m = olsHome(home, x, regM);
  let mus = rows.map((r, i) => m.a * home[i] + m.b * x[i]);
  const e0 = regM.map((y, i) => y - mus[i]);
  let vm = vspec.margin === 'v2' ? varFit2(e0, rows, mus, true) : varFit(e0, rows.map((r) => r.var_param || 0));
  let kk = kappaOf(mus, vm); let iterations = 0;
  for (let it = 0; tieConsistent && it < 50; it++) {
    iterations = it + 1;
    const sc = rows.map((r, i) => tieMass(mus[i], Math.sqrt(varAt(vm, r, mus[i])), kk.kappa).scale);
    const m2 = olsHome(home.map((h, i) => h * sc[i]), x.map((v, i) => v * sc[i]), regM);
    mus = rows.map((r, i) => m2.a * home[i] + m2.b * x[i]);
    const vm2 = fitVar(regM.map((y, i) => (y - sc[i] * mus[i]) ** 2 / sc[i] - (1 - sc[i]) * mus[i] * mus[i] - 1 / 12), mus);
    const kk2 = kappaOf(mus, vm2);
    const moved = Math.max(Math.abs(m2.a - m.a), Math.abs(m2.b - m.b), Math.abs(vm2.s0 - vm.s0) / vm.s0, Math.abs(vm2.k - vm.k), Math.abs(kk2.kappa - kk.kappa));
    m = m2; vm = vm2; kk = kk2;
    if (moved < 1e-9) break;
  }
  const muOf = (r) => m.a * (r.neutral ? 0 : 1) + m.b * r.margin;
  const cal = { n: rows.length, margin: { a: m.a, b: m.b, intercept: 'home_games_only', fit: tieConsistent ? 'tie_consistent' : 'plain', iterations }, var_margin: vm, kappa: kk.kappa, ot: { sd: 5 }, rho: 0, total: null, var_total: null, ot_total: null };
  /* tie mass: observed overtime games / predicted smooth tie mass */
  cal.tie = { observed_ot_games: nOt, predicted_smooth: +kk.pred.toFixed(2) };
  /* overtime period sd: ML over the final margins of overtime games */
  const otRows = rows.filter((r) => r.y.n_ot > 0);
  if (otRows.length >= 30) {
    let best = null;
    for (let s = 2; s <= 14.0001; s += 0.05) {
      let ll = 0;
      for (const r of otRows) {
        const mu = muOf(r) * OT_FRACTION;
        const pk = cellMass(r.y.margin, mu, s); const dec = 1 - cellMass(0, mu, s);
        ll += Math.log(Math.max(1e-300, pk / dec));
      }
      if (!best || ll > best.ll) best = { s, ll };
    }
    cal.ot.sd = +best.s.toFixed(2); cal.ot.n = otRows.length;
  } else cal.ot.n = otRows.length;
  /* totals: regulation total on non-overtime games */
  const reg = rows.filter((r) => !(r.y.n_ot > 0));
  const t = ols(reg.map((r) => r.total), reg.map((r) => r.y.total));
  const et = reg.map((r) => r.y.total - (t.a + t.b * r.total));
  cal.total = { c: t.a, d: t.b };
  cal.var_total = vspec.total === 'v2' ? varFit2(et, reg, null, false) : varFit(et, reg.map((r) => r.var_param || 0));
  cal.variance_law = vspec;
  const emReg = reg.map((r) => r.y.margin - muOf(r));
  const mE = emReg.reduce((a, x) => a + x, 0) / emReg.length; const mT = et.reduce((a, x) => a + x, 0) / et.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < et.length; i++) { sab += (emReg[i] - mE) * (et[i] - mT); saa += (emReg[i] - mE) ** 2; sbb += (et[i] - mT) ** 2; }
  cal.rho = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  /* overtime totals: points per OT period relative to the regulation rate,
     measured against the regulation total GIVEN a tie (the forecast's own
     conditional mean); the per-period sd from single-overtime games */
  if (otRows.length >= 30) {
    const per = otRows.map((r) => {
      const muT = t.a + t.b * r.total; const sdT = Math.sqrt(varAt(cal.var_total, r, 0));
      const sd = Math.sqrt(varAt(vm, r, muOf(r))); const muTie = muT + cal.rho * (sdT / sd) * (0 - muOf(r));
      return { n: r.y.n_ot, x: r.y.total - muTie, base: muT * OT_FRACTION, condVar: sdT * sdT * (1 - cal.rho * cal.rho) };
    });
    const ratio = per.reduce((a, p) => a + p.x, 0) / per.reduce((a, p) => a + p.n * p.base, 0);
    const one = per.filter((p) => p.n === 1);
    const v = one.length >= 20 ? one.reduce((a, p) => a + (p.x - ratio * p.base) ** 2 - p.condVar, 0) / one.length : 36;
    cal.ot_total = { ratio: ratio, sd: Math.sqrt(Math.max(4, v)), n: otRows.length };
  } else cal.ot_total = { ratio: 1, sd: 6, n: otRows.length };
  return cal;
}

/** the persistent per-team strength variance the simulator draws once per run,
    in RAW rating units (points per 100 possessions), so that the calibrated
    single-game variance s0 + k * var_param is reproduced exactly: the game
    then carries only s0 */
function strengthScale(cal) { return cal.margin.b > 0 ? cal.var_margin.k / (cal.margin.b * cal.margin.b) : 0; }

module.exports = { varAt, lsq, varFit2, varFit2Sq, varFitSq, TEMPO_REF, VAR_FLOOR, Phi, phi, invPhi, cellMass, winProbAt, parts, mixCdf, mixMoments, mixQuantile, pmfQuantile, forecast, regulation, overtime, tieMass, drawWinner, drawRegulation, drawGame, fit, ols, olsHome, varFit, strengthScale, OT_FRACTION };

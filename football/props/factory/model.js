/* ===========================================================================
   EdgeDesk player props — OUTCOME DISTRIBUTION MODELS (Phase E).

   Not one universal model: one model per league × position group × market
   (nfl_wr_receiving_yards_v1, cfb_qb_pass_yards_v1, …), each predicting the
   FULL distribution of the stat before any market price is seen.

     mean      ridge-penalised Poisson GLM (log link) fitted by IRLS on the
               point-in-time features; λ chosen on the last training season
     shape     counts:  a variance function Var = a·μ + b·μ² fitted on
                        OUT-OF-FOLD residuals → negative binomial (b > 0),
                        Poisson, or binomial (under-dispersed)
               yardage: the empirical distribution of actual / predicted mean
                        from OUT-OF-FOLD predictions, conditioned on the size
                        of μ (8 bins) — lib/player_props.js continuousFromRatio
               anytime TD: the rush + receiving TD count model, P(TD ≥ 1)
   One distribution per player-market-scoring time. Every line — main or
   alternate, any book — is priced from that same distribution.

   Out-of-fold means: the shape is fitted on predictions for seasons the mean
   model did not see (season-blocked folds), so it carries the model's real
   out-of-sample error rather than its in-sample fit.
   =========================================================================== */
'use strict';
const EDP = require('./dist.js');
const F = require('./features.js');
const MK = require('./config/markets.json');

const MODEL_SCHEMA = 'edgedesk_props_model_v1';
const ALGO = { count: 'ridge_poisson_glm+variance_function', continuous: 'ridge_poisson_glm+empirical_ratio', binary: 'ridge_poisson_glm+td_count' };
const PROBS = [0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.275, 0.3, 0.325, 0.35, 0.375, 0.4, 0.425, 0.45, 0.475, 0.5,
  0.525, 0.55, 0.575, 0.6, 0.625, 0.65, 0.675, 0.7, 0.725, 0.75, 0.775, 0.8, 0.825, 0.85, 0.875, 0.9, 0.925, 0.95, 0.97, 0.98, 0.99, 0.995, 0.998];

/* ------------------------------------------------------------ specs */
const COMMON = ['home_flag', 'rest_days', 'team_implied_points', 'game_total', 'team_spread', 'market_context_is_model', 'games_l8', 'games_season', 'games_career', 'week_of_season'];
const WEATHER = ['weather_wind_mph', 'roof_closed_flag', 'weather_temp_f'];
const TEAM = ['team_plays_l5', 'team_pass_rate_l5', 'pace_seconds_per_play_l5', 'neutral_pass_rate_l5', 'proe_l5', 'team_points_l5', 'team_pass_attempts_l5', 'team_rushes_l5'];
const OPP_PASS = ['opp_pass_yards_allowed_per_att_l8', 'opp_completion_rate_allowed_l8', 'opp_pressure_rate_l8', 'opp_sack_rate_l8', 'opp_explosive_pass_rate_allowed_l8',
  'opp_epa_per_dropback_allowed_l8', 'opp_pass_attempts_allowed_l8', 'opp_points_allowed_l8', 'opp_plays_allowed_l8'];
const OPP_RUSH = ['opp_rush_yards_allowed_per_carry_l8', 'opp_rush_epa_allowed_l8', 'opp_explosive_rush_rate_allowed_l8', 'opp_rushes_allowed_l8', 'opp_points_allowed_l8'];
const OPP_REC = { RB: ['opp_target_rate_allowed_rb_l8', 'opp_rec_yards_allowed_rb_l8'], TE: ['opp_target_rate_allowed_te_l8', 'opp_rec_yards_allowed_te_l8'], WR: ['opp_rec_yards_allowed_wr_l8'], QB: [] };
const AVAIL = ['teammate_target_vacated_share', 'teammate_rush_vacated_share', 'teammate_air_yards_vacated_share', 'teammate_rz_vacated_share', 'qb_change', 'qb_starts_with_team'];
const TRANSITION = ['rookie_flag', 'years_experience', 'draft_capital_log', 'cfb_career_reception_share', 'cfb_career_rec_ypg', 'cfb_final_rec_yards_share', 'cfb_career_rush_share',
  'cfb_career_rush_ypg', 'cfb_final_pass_ypg', 'cfb_best_season_yprr_proxy', 'cfb_seasons'];
function statBlock(s) { return [s + '_eb', s + '_avg_l3', s + '_avg_l5', s + '_avg_l8', s + '_season_avg', s + '_prev_season_avg']; }
const PASS_EFF = ['yards_per_attempt_l8', 'epa_per_dropback_l8', 'cpoe_l8', 'designed_qb_rush_rate_l5', 'scramble_rate_l5'];
const RUSH_USE = ['rush_share_l3', 'rush_share_l5', 'rush_share_season', 'yards_per_carry_l8', 'explosive_rush_rate_l8', 'rz_opportunity_share_l5', 'goal_line_opportunity_share_l5'];
const REC_USE = ['target_share_l3', 'target_share_l5', 'target_share_season', 'air_yard_share_l3', 'air_yard_share_l5', 'reception_share_l5', 'rec_yards_share_l5', 'yards_per_target_l8',
  'catch_rate_l8', 'explosive_rec_rate_l8', 'snap_share_l3', 'snap_share_l5', 'rz_opportunity_share_l5'];
const SPEC = {
  pass_yards: { stats: ['passing_yards', 'attempts', 'completions'], use: PASS_EFF, opp: OPP_PASS, weather: true },
  pass_attempts: { stats: ['attempts', 'dropbacks'], use: PASS_EFF, opp: OPP_PASS, weather: true },
  pass_completions: { stats: ['completions', 'attempts'], use: PASS_EFF, opp: OPP_PASS, weather: true },
  pass_tds: { stats: ['passing_tds', 'passing_yards', 'attempts'], use: PASS_EFF, opp: OPP_PASS, weather: true },
  pass_interceptions: { stats: ['interceptions', 'attempts'], use: PASS_EFF, opp: OPP_PASS, weather: true },
  pass_longest_completion: { stats: ['longest_completion', 'passing_yards', 'attempts'], use: PASS_EFF, opp: OPP_PASS, weather: true },
  rush_yards: { stats: ['rushing_yards', 'carries', 'designed_rushes', 'scrambles'], use: RUSH_USE.concat(['designed_qb_rush_rate_l5', 'scramble_rate_l5']), opp: OPP_RUSH },
  rush_attempts: { stats: ['carries', 'designed_rushes'], use: RUSH_USE.concat(['designed_qb_rush_rate_l5']), opp: OPP_RUSH },
  rush_tds: { stats: ['rushing_tds', 'carries', 'red_zone_touches', 'goal_line_touches'], use: RUSH_USE, opp: OPP_RUSH },
  longest_rush: { stats: ['longest_rush', 'carries', 'rushing_yards'], use: RUSH_USE, opp: OPP_RUSH },
  receiving_yards: { stats: ['receiving_yards', 'targets', 'receptions', 'air_yards', 'yac'], use: REC_USE, opp: OPP_PASS, rec: true, weather: true },
  receptions: { stats: ['receptions', 'targets'], use: REC_USE, opp: OPP_PASS, rec: true },
  targets: { stats: ['targets', 'receptions'], use: REC_USE, opp: OPP_PASS, rec: true },
  receiving_tds: { stats: ['receiving_tds', 'targets', 'red_zone_touches', 'receptions'], use: REC_USE, opp: OPP_PASS, rec: true },
  longest_reception: { stats: ['longest_reception', 'receiving_yards', 'receptions', 'air_yards'], use: REC_USE, opp: OPP_PASS, rec: true, weather: true },
  anytime_td: { stats: ['tds', 'rushing_tds', 'receiving_tds', 'red_zone_touches', 'goal_line_touches', 'carries', 'targets', 'receptions'], use: RUSH_USE.concat(REC_USE), opp: OPP_RUSH.concat(OPP_PASS), rec: true },
  pass_rush_yards: { stats: ['pass_rush_yards', 'passing_yards', 'rushing_yards', 'attempts', 'carries'], use: PASS_EFF.concat(RUSH_USE), opp: OPP_PASS.concat(OPP_RUSH), weather: true },
  rush_rec_yards: { stats: ['rush_rec_yards', 'rushing_yards', 'receiving_yards', 'carries', 'targets', 'receptions'], use: RUSH_USE.concat(REC_USE), opp: OPP_RUSH.concat(OPP_PASS), rec: true },
  pass_rush_rec_yards: { stats: ['pass_rush_rec_yards', 'passing_yards', 'rushing_yards', 'receiving_yards'], use: PASS_EFF.concat(RUSH_USE), opp: OPP_PASS.concat(OPP_RUSH), weather: true },
  receptions_rush_attempts: { stats: ['receptions_rush_attempts', 'receptions', 'carries', 'targets'], use: RUSH_USE.concat(REC_USE), opp: OPP_RUSH.concat(OPP_PASS), rec: true }
};
/* which markets each position group is modelled for, by league (the catalog's
   positions, less what a league's source cannot settle) */
const NOT_IN = { CFB: { targets: 'CFB box scores carry no targets', pass_longest_completion: 'CFB box scores carry no longest completion' } };
function marketsFor(league, pg) {
  return MK.markets.filter((m) => m.modeled && SPEC[m.market_key] && m.positions.indexOf(pg) >= 0 && (league === 'NFL' ? m.nfl : m.cfb) && !(NOT_IN[league] || {})[m.market_key])
    .map((m) => m.market_key);
}
function modelName(league, pg, market, version) { return [league.toLowerCase(), pg.toLowerCase(), market, version || 'v1'].join('_'); }
function familyOf(market) { const m = MK.markets.find((x) => x.market_key === market); return m ? m.family : null; }

/* the target a market settles on, from a historical row's targets. A longest
   play with no play of that kind settles at 0 (the over loses). */
function targetFor(row, market) {
  const t = row.targets;
  if (market === 'longest_reception') return t.receptions === 0 ? 0 : t.longest_reception;
  if (market === 'longest_rush') return t.rush_attempts === 0 ? 0 : t.longest_rush;
  if (market === 'pass_longest_completion') return t.pass_completions === 0 ? 0 : t.pass_longest_completion;
  if (market === 'anytime_td') return t.anytime_td;
  return t[market];
}

function featuresOf(market, pg) {
  const sp = SPEC[market];
  const out = [];
  const add = (n) => { if (F.IDX.has(n) && out.indexOf(n) < 0) out.push(n); };
  sp.stats.forEach((s) => statBlock(s).forEach(add));
  sp.use.forEach(add); sp.opp.forEach(add);
  if (sp.rec) (OPP_REC[pg] || []).forEach(add);
  if (sp.weather) WEATHER.forEach(add);
  COMMON.forEach(add); TEAM.forEach(add); AVAIL.forEach(add); TRANSITION.forEach(add);
  return out;
}
/* non-negative volumes enter on a log scale; rates and context as they are */
function transformOf(name) {
  if (/_(avg_l[358]|season_avg|prev_season_avg|eb)$/.test(name) || /^games_/.test(name) || name === 'qb_starts_with_team' || name === 'cfb_career_rec_ypg' || name === 'cfb_career_rush_ypg' || name === 'cfb_final_pass_ypg') return 'log1p';
  return 'id';
}
function tx(v, t) { return t === 'log1p' ? Math.log1p(Math.max(0, v)) : v; }

/* ------------------------------------------------------------ design matrix */
function prepare(rows, featNames, fitStats) {
  const idx = featNames.map((n) => F.IDX.get(n));
  const tr = featNames.map(transformOf);
  let stats = fitStats;
  if (!stats) {
    stats = featNames.map((n, j) => {
      let s = 0, s2 = 0, c = 0;
      rows.forEach((r) => { const v = r.f[idx[j]]; if (isFinite(v)) { const x = tx(v, tr[j]); s += x; s2 += x * x; c++; } });
      const miss = 1 - c / Math.max(1, rows.length);
      const m = c ? s / c : 0, sd = c > 1 ? Math.sqrt(Math.max(1e-12, s2 / c - m * m)) : 1;
      return { name: n, transform: tr[j], mean: m, sd: sd > 1e-9 ? sd : 1, missing_rate: miss, keep: miss < 0.99 && sd > 1e-9, indicator: miss >= 0.02 && miss <= 0.98 };
    });
  }
  const cols = [];
  stats.forEach((s, j) => { if (s.keep) cols.push({ j, kind: 'x', s }); });
  stats.forEach((s, j) => { if (s.keep && s.indicator) cols.push({ j, kind: 'miss', s }); });
  const X = rows.map((r) => {
    const x = new Float64Array(cols.length + 1); x[0] = 1;
    cols.forEach((c, k) => {
      const v = r.f[idx[c.j]];
      if (c.kind === 'x') x[k + 1] = isFinite(v) ? (tx(v, c.s.transform) - c.s.mean) / c.s.sd : 0;
      else x[k + 1] = isFinite(v) ? 0 : 1;
    });
    return x;
  });
  return { X, stats, cols };
}

/* ------------------------------------------------------------ IRLS */
function cholSolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j];
    for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-10)); else L[i * n + j] = s / L[j * n + j];
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
function fitPoissonRidge(X, y, lambda, opts) {
  opts = opts || {};
  const n = X.length, p = X[0].length;
  const ybar = y.reduce((a, b) => a + b, 0) / n;
  let beta = new Float64Array(p); beta[0] = Math.log(Math.max(ybar, 0.05));
  let dev0 = Infinity;
  for (let it = 0; it < (opts.maxIter || 25); it++) {
    const A = new Float64Array(p * p), b = new Float64Array(p);
    let dev = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i];
      let eta = 0; for (let k = 0; k < p; k++) eta += x[k] * beta[k];
      eta = Math.max(-12, Math.min(12, eta));
      const mu = Math.exp(eta);
      const w = mu, z = eta + (y[i] - mu) / mu;
      for (let a = 0; a < p; a++) { const wa = w * x[a]; if (wa === 0) continue; b[a] += wa * z; for (let c = 0; c <= a; c++) A[a * p + c] += wa * x[c]; }
      dev += y[i] > 0 ? 2 * (y[i] * Math.log(y[i] / mu) - (y[i] - mu)) : 2 * mu;
    }
    for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[c * p + a] = A[a * p + c];
    for (let a = 1; a < p; a++) A[a * p + a] += lambda;
    const nb = cholSolve(A, b, p);
    let delta = 0; for (let k = 0; k < p; k++) delta = Math.max(delta, Math.abs(nb[k] - beta[k]));
    beta = nb;
    if (Math.abs(dev0 - dev) < 1e-6 * (Math.abs(dev) + 1) || delta < 1e-7) break;
    dev0 = dev;
  }
  return beta;
}
function predictMu(beta, x) { let eta = 0; for (let k = 0; k < beta.length; k++) eta += x[k] * beta[k]; return Math.exp(Math.max(-12, Math.min(12, eta))); }
function poissonDev(y, mu) { let d = 0; for (let i = 0; i < y.length; i++) d += y[i] > 0 ? 2 * (y[i] * Math.log(y[i] / mu[i]) - (y[i] - mu[i])) : 2 * mu[i]; return d / y.length; }

/* ------------------------------------------------------------ shape */
function quantileSorted(a, q) { if (!a.length) return null; const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return a[lo] + (a[hi] - a[lo]) * (pos - lo); }
function ratioTable(mu, y, nBins) {
  nBins = nBins || 8;
  const order = mu.map((m, i) => i).sort((a, b) => mu[a] - mu[b]);
  const per = Math.ceil(order.length / nBins), bins = [];
  for (let b = 0; b < nBins; b++) {
    const ids = order.slice(b * per, (b + 1) * per);
    if (ids.length < 30) { if (bins.length && ids.length) { /* fold a thin last bin into the previous */ } continue; }
    const ratios = ids.map((i) => y[i] / Math.max(mu[i], 1e-6)).sort((a, c) => a - c);
    const mus = ids.map((i) => mu[i]);
    const q = PROBS.map((p) => quantileSorted(ratios, p));
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    bins.push({ mu_lo: r4(mus[0]), mu_hi: r4(mus[mus.length - 1]), mu_mid: r4(quantileSorted(mus.slice().sort((a, c) => a - c), 0.5)), n: ids.length, q: q.map(r4) });
  }
  return { probs: PROBS, bins };
}
function varianceFunction(mu, y) {
  /* least squares of (y-mu)^2 on [mu, mu^2], both coefficients >= 0 */
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < mu.length; i++) { const m = mu[i], e = (y[i] - m) * (y[i] - m); s11 += m * m; s12 += m * m * m; s22 += m * m * m * m; t1 += e * m; t2 += e * m * m; }
  const det = s11 * s22 - s12 * s12;
  let a = det !== 0 ? (t1 * s22 - t2 * s12) / det : 1, b = det !== 0 ? (s11 * t2 - s12 * t1) / det : 0;
  if (b < 0) { b = 0; a = t1 / s11; }
  if (a < 0) { a = 0; b = t2 / s22; }
  return { a: r6(Math.max(a, 0.05)), b: r6(Math.max(b, 0)) };
}
function r4(x) { return Math.round(x * 1e4) / 1e4; }
function r6(x) { return Math.round(x * 1e6) / 1e6; }

/* The PIT map from held-out outcomes: G(u) = share of held-out PIT values
   <= u, on 21 knots, shrunk toward the identity by n / (n + 300) so a thin
   calibration season cannot bend the distribution far. */
function pitMap(pits) {
  const a = pits.filter((v) => isFinite(v)).sort((x, y) => x - y);
  const n = a.length;
  if (n < 50) return null;
  const u = [], g = [];
  const w = n / (n + 300);
  let j = 0;
  for (let k = 0; k <= 20; k++) {
    const uk = k / 20;
    while (j < n && a[j] <= uk) j++;
    const emp = k === 0 ? 0 : (k === 20 ? 1 : j / n);
    u.push(uk); g.push(r4(w * emp + (1 - w) * uk));
  }
  for (let k = 1; k < g.length; k++) if (g[k] < g[k - 1]) g[k] = g[k - 1];
  return { u, g, n, weight: r4(w) };
}
function distFor(model, mu, sigma) {
  if (model.family === 'continuous') return EDP.dist.continuousFromRatio(mu, model.ratio, sigma || 0, { integer: true });
  const pmf = EDP.dist.countWithUncertainty(mu, model.variance.a * mu + model.variance.b * mu * mu, sigma || 0);
  return model.family === 'count' ? pmf : EDP.dist.bernoulli(1 - pmf.v[0]);
}
function pitOf(d, y, u) {
  if (d.t === 'bern') { const p0 = 1 - d.p; return y >= 1 ? p0 + u * (1 - p0) : u * p0; }
  return EDP.metrics.pit(d, y, u);
}
/* deterministic pseudo-random u for randomised PIT (reproducible builds) */
function hashU(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

/* ------------------------------------------------------------ train */
function trainOne(rows, o) {
  const { league, pg, market } = o;
  const fam = familyOf(market);
  const tgtMarket = market === 'anytime_td' ? 'anytime_td' : market;
  const data = rows.filter((r) => r.position_group === pg && isFinite(targetFor(r, tgtMarket)) && targetFor(r, tgtMarket) !== null && (r.identity_confidence == null || r.identity_confidence >= 0.9));
  if (data.length < (o.minRows || 400)) return { skipped: 'only ' + data.length + ' training rows' };
  const names = featuresOf(market, pg);
  const prep = prepare(data, names);
  const y = data.map((r) => targetFor(r, tgtMarket));
  const seasons = Array.from(new Set(data.map((r) => r.season))).sort();
  /* λ on the last training season */
  const lastS = seasons[seasons.length - 1];
  const trI = [], vaI = [];
  data.forEach((r, i) => (r.season === lastS && seasons.length > 2 ? vaI : trI).push(i));
  let lambda = o.lambda || (o.selectLambda ? null : 100), lamTrace = [];
  if (!lambda && vaI.length > 100) {
    let best = null;
    [1, 10, 100].forEach((lam) => {
      const beta = fitPoissonRidge(trI.map((i) => prep.X[i]), trI.map((i) => y[i]), lam);
      const d = poissonDev(vaI.map((i) => y[i]).map((v) => Math.max(v, 0)), vaI.map((i) => predictMu(beta, prep.X[i])));
      lamTrace.push({ lambda: lam, val_deviance: r4(d) });
      if (!best || d < best.d) best = { lam, d };
    });
    lambda = best.lam;
  }
  lambda = lambda || 10;
  const yFit = y.map((v) => Math.max(v, 0));                          /* the mean model sees yardage floored at 0; the shape keeps negatives */
  const beta = fitPoissonRidge(prep.X, yFit, lambda);
  /* out-of-fold predictions: season-blocked folds (only when the shape is fitted on them) */
  const K = o.shape === 'oof' ? Math.min(4, seasons.length) : 0;
  const foldOf = new Map(seasons.map((s, i) => [s, i % K]));
  const oof = new Float64Array(data.length);
  for (let k = 0; k < K; k++) {
    const tI = [], hI = [];
    data.forEach((r, i) => (foldOf.get(r.season) === k ? hI : tI).push(i));
    if (!hI.length || tI.length < 100) { hI.forEach((i) => { oof[i] = predictMu(beta, prep.X[i]); }); continue; }
    const b = fitPoissonRidge(tI.map((i) => prep.X[i]), tI.map((i) => yFit[i]), lambda);
    hI.forEach((i) => { oof[i] = predictMu(b, prep.X[i]); });
  }
  const oofArr = K ? Array.from(oof) : null;
  /* the SHAPE source. 'oof' uses fold models (trained on less data, other
     seasons: too wide for the final model); 'insample' uses the final model's
     own predictions (ridge-penalised, so close to out-of-sample); 'recent' =
     in-sample on the most recent seasons only (the era the model will score). */
  const shape = o.shape || 'recent';
  const inMu = data.map((r, i) => predictMu(beta, prep.X[i]));
  let shapeIdx = data.map((r, i) => i);
  if (shape === 'recent') { const cut = seasons[Math.max(0, seasons.length - 4)]; shapeIdx = shapeIdx.filter((i) => data[i].season >= cut); }
  const shapeMu = shape === 'oof' ? oofArr : shapeIdx.map((i) => inMu[i]);
  const shapeY = shape === 'oof' ? y : shapeIdx.map((i) => y[i]);
  const shapeYFit = shape === 'oof' ? yFit : shapeIdx.map((i) => yFit[i]);
  const model = {
    schema: MODEL_SCHEMA, model_name: modelName(league, pg, market, null).replace(/_v1$/, ''), model_version: modelName(league, pg, market, o.version),
    league, position_group: pg, market_key: market, family: fam, algorithm: ALGO[fam], feature_version: F.FEATURE_VERSION,
    features: prep.stats.map((s) => ({ name: s.name, transform: s.transform, mean: r6(s.mean), sd: r6(s.sd), missing_rate: r4(s.missing_rate), keep: s.keep, indicator: s.indicator })),
    coef: Array.from(beta).map(r6), lambda, lambda_trace: lamTrace,
    training: { seasons: [seasons[0], seasons[seasons.length - 1]], n_rows: data.length, cutoff: data.reduce((m, r) => (r.kickoff_utc > m ? r.kickoff_utc : m), ''),
      trained_at: o.now || new Date().toISOString(), fold: o.fold || null, target_mean: r4(y.reduce((a, b) => a + b, 0) / y.length) }
  };
  model.shape_source = shape;
  if (fam === 'continuous') model.ratio = ratioTable(shapeMu, shapeY);
  else model.variance = varianceFunction(shapeMu, shapeYFit);
  /* recalibration: the whole recipe re-run on the seasons before the last,
     scored on the last (a season it never saw); the PIT map it yields is
     stored with the final model and applied at every prediction */
  if (vaI.length >= 100 && o.recalibrate !== false) {
    const bA = fitPoissonRidge(trI.map((i) => prep.X[i]), trI.map((i) => yFit[i]), lambda);
    const trS = Array.from(new Set(trI.map((i) => data[i].season))).sort();
    const cutA = trS[Math.max(0, trS.length - 4)];
    const sIdx = trI.filter((i) => data[i].season >= cutA);
    const mA = { family: fam };
    const muA = sIdx.map((i) => predictMu(bA, prep.X[i]));
    if (fam === 'continuous') mA.ratio = ratioTable(muA, sIdx.map((i) => y[i])); else mA.variance = varianceFunction(muA, sIdx.map((i) => yFit[i]));
    const pits = vaI.map((i) => pitOf(distFor(mA, predictMu(bA, prep.X[i]), 0), y[i], hashU(data[i].game_id + data[i].player_id)));
    model.pit_map = pitMap(pits);
    model.pit_map_season = lastS;
  }
  /* diagnostics: in-sample MAE of the mean (the walk-forward backtest carries the honest numbers) */
  let mae = 0; for (let i = 0; i < y.length; i++) mae += Math.abs(y[i] - inMu[i]);
  model.training.insample_mae = r4(mae / y.length);
  return { model, data, oof: oofArr, y };
}

/* ------------------------------------------------------------ score */
function designRow(model, frow) {
  const x = [1];
  const kept = model.features.filter((s) => s.keep);
  kept.forEach((s) => { const v = frow[F.IDX.get(s.name)]; x.push(isFinite(v) ? (tx(v, s.transform) - s.mean) / s.sd : 0); });
  kept.forEach((s) => { if (s.indicator) { const v = frow[F.IDX.get(s.name)]; x.push(isFinite(v) ? 0 : 1); } });
  return x;
}
/* contributions of each kept feature to log(mu), for the explanation layer */
function contributions(model, frow) {
  const kept = model.features.filter((s) => s.keep);
  const out = [];
  kept.forEach((s, k) => {
    const v = frow[F.IDX.get(s.name)];
    if (!isFinite(v)) return;
    const z = (tx(v, s.transform) - s.mean) / s.sd;
    out.push({ feature: s.name, value: v, z, effect: model.coef[k + 1] * z });
  });
  return out.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
}
function imputedOf(model, frow) { return model.features.filter((s) => s.keep && !isFinite(frow[F.IDX.get(s.name)])).map((s) => s.name); }
function completeness(model, frow) {
  const kept = model.features.filter((s) => s.keep);
  let w = 0, t = 0;
  kept.forEach((s, k) => { const wt = Math.abs(model.coef[k + 1]) + 1e-3; w += wt; if (isFinite(frow[F.IDX.get(s.name)])) t += wt; });
  return w ? t / w : null;
}
/* The stored distribution for one player-market (lib/player_props.js form). */
function predictDist(model, frow, opts) {
  opts = opts || {};
  const x = designRow(model, frow);
  let mu = predictMu(model.coef, x);
  if (isFinite(opts.muScale)) mu *= opts.muScale;
  const sig = opts.sigmaMu || 0;
  let dist = distFor(model, mu, sig);
  if (model.pit_map && opts.recalibrate !== false) dist = EDP.dist.recalibrate(dist, model.pit_map);
  return { mu, dist };
}

module.exports = { SPEC, PROBS, MODEL_SCHEMA, marketsFor, modelName, familyOf, targetFor, featuresOf, prepare, fitPoissonRidge, predictMu, ratioTable, varianceFunction,
  trainOne, designRow, predictDist, contributions, imputedOf, completeness, NOT_IN, pitMap, pitOf, hashU, distFor };

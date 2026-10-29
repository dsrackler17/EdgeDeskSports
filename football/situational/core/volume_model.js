/* ============================================================================
   FSIE — team play-volume model (shared framework, sport-specific fits).

   NOT "average plays x season pass rate". The mean structure is
     plays      ridge on the rung's features
     drives     ridge on the rung's features (possessions)
     db_rate    ridge whose lead feature is the SCRIPT MIXTURE: the expected
                dropback rate = sum over game scripts of P(script | pregame
                expected margin) x the matchup's dropback rate in that script
                (offence's rate and the defence's faced rate combined on the
                logit scale). Script probabilities come from a table fitted on
                the training seasons (competitive / leading / trailing /
                garbage / two-minute shares by expected margin).
   The distribution is a correlated two-team simulation of the same game:
     - one realized margin draw drives BOTH teams' scripts (home ahead is away
       behind), shifting each team's plays-per-drive and dropback rate by the
       training-fitted sensitivity to the margin surprise;
     - one game possession count, split so the two teams differ by at most
       one drive — the teams' volumes cannot drift apart independently;
     - dropbacks ~ Binomial(plays, rate); sacks and scrambles ~ Binomial of
       dropbacks; then the IDENTITY holds on every draw:
         pass_att + sacks + rush_att == plays,  rush_att = plays - dropbacks + scrambles.
   The interval scale factor phi is chosen on the walk-forward validation
   folds (never the holdout) to bring P10-P90 coverage to 80%.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));

const SCRIPTS = ['competitive', 'leading', 'trailing', 'garbage', 'two_minute'];
const M_BINS = [-Infinity, -17, -10, -6, -2.5, 2.5, 6, 10, 17, Infinity];

function v(x) { return x && typeof x === 'object' ? x.v : (U.isNum(x) ? x : null); }
function logit(p) { const q = U.clamp(p, 1e-4, 1 - 1e-4); return Math.log(q / (1 - q)); }
function expit(x) { return 1 / (1 + Math.exp(-x)); }
function combine(off, def, lg) { if (![off, def, lg].every(U.isNum)) return U.isNum(off) ? off : lg; return expit(logit(off) + logit(def) - logit(lg)); }
function binOf(m) { for (let i = 0; i < M_BINS.length - 1; i++) if (m > M_BINS[i] && m <= M_BINS[i + 1]) return i; return 4; }

/* ---------------------------------------------------- script share table */
/* shares[bin][script] fitted on training rows by (key) margin: 'm' (pregame
   expectation) or 'margin' (realized final margin). Light smoothing toward
   the all-rows mean so a thin bin cannot produce a degenerate share. */
function fitScriptTable(rows, key) {
  const tot = SCRIPTS.reduce((o, s) => { o[s] = 0; return o; }, {}); let N = 0;
  const bins = M_BINS.slice(0, -1).map(() => ({ n: 0, s: SCRIPTS.reduce((o, k) => { o[k] = 0; return o; }, {}) }));
  rows.forEach((r) => {
    const x = key === 'm' ? r.m : (r.labels && r.labels.margin);
    if (!U.isNum(x) || !r.script) return;
    const n = SCRIPTS.reduce((s, k) => s + r.script[k].n, 0); if (!n) return;
    const b = bins[binOf(x)]; b.n++; N++;
    SCRIPTS.forEach((k) => { const sh = r.script[k].n / n; b.s[k] += sh; tot[k] += sh; });
  });
  const mean = SCRIPTS.reduce((o, k) => { o[k] = N ? tot[k] / N : 1 / SCRIPTS.length; return o; }, {});
  const k0 = 20;
  return { key, edges: M_BINS.slice(1, -1), mean, bins: bins.map((b) => { const o = {}; SCRIPTS.forEach((k) => { o[k] = U.round((b.s[k] + k0 * mean[k]) / (b.n + k0), 4); }); o._n = b.n; return o; }) };
}
function sharesFor(table, x) { const b = U.isNum(x) ? table.bins[binOf(x)] : table.mean; const o = {}; SCRIPTS.forEach((k) => { o[k] = b[k] != null ? b[k] : table.mean[k]; }); return o; }

/* matchup dropback rate in each script */
function scriptRates(r) {
  const out = {};
  SCRIPTS.forEach((s) => {
    const key = 'pr_x_' + s;
    out[s] = combine(v(r.T.off[key]), v(r.O.def[key]), r.league[key]);
  });
  return out;
}
function mixRate(shares, rates) { let s = 0, w = 0; SCRIPTS.forEach((k) => { if (U.isNum(rates[k])) { s += shares[k] * rates[k]; w += shares[k]; } }); return w > 0 ? s / w : null; }
function teamOnlyRates(r) { const out = {}; SCRIPTS.forEach((s) => { out[s] = U.isNum(v(r.T.off['pr_x_' + s])) ? v(r.T.off['pr_x_' + s]) : r.league['pr_x_' + s]; }); return out; }

/* ------------------------------------------------------------- features */
function f(x, lg) { return U.isNum(x) ? x : (U.isNum(lg) ? lg : 0); }
const RUNGS = ['situational', 'opponent', 'pace_script', 'formation'];

/* -> { plays: {name: value}, db: {...}, drives: {...} } for one rung (cumulative) */
function featuresFor(r, rung, tables) {
  const L = r.league; const T = r.T, O = r.O;
  const P = {}, D = {}, DR = {};
  const lvl = RUNGS.indexOf(rung);
  /* situational (team only): situation-normalized rates and per-drive volume */
  P.t_plays_pg = f(v(T.off.plays_pg), L.plays_pg); P.t_drives_pg = f(v(T.off.drives_pg), L.drives_pg); P.t_ppd = f(v(T.off.ppd), L.ppd);
  P.t_spp_neutral = f(v(T.off.spp_neutral), L.spp_neutral); P.t_spp_all = f(v(T.off.spp_all), L.spp_all);
  /* the league's own level so far this season (point-in-time), so a league-wide
     drift in volume or pass rate is not read as every team's bias */
  P.lg_plays_pg = f(L.plays_pg, 0); D.lg_pr_all = f(L.pr_all, 0);
  DR.t_drives_pg = P.t_drives_pg; DR.t_spp_neutral = P.t_spp_neutral; DR.lg_drives_pg = f(L.drives_pg, 0);
  const leagueShares = tables.script_m.mean;
  D.t_pr_all = f(v(T.off.pr_all), L.pr_all); D.t_pr_neutral = f(v(T.off.pr_neutral), L.pr_neutral); D.t_pr_early = f(v(T.off.pr_early), L.pr_early);
  D.t_pr_passing_down = f(v(T.off.pr_passing_down), L.pr_passing_down);
  D.t_mix_leagueshares = f(mixRate(leagueShares, teamOnlyRates(r)), L.pr_all);
  if (lvl >= 1) {
    P.o_plays_allowed = f(v(O.def.plays_pg), L.plays_pg); P.o_ppd_allowed = f(v(O.def.ppd), L.ppd); P.o_drives_faced = f(v(O.def.drives_pg), L.drives_pg);
    P.o_off_plays_pg = f(v(O.off.plays_pg), L.plays_pg); P.t_def_plays_allowed = f(v(T.def.plays_pg), L.plays_pg);
    P.t_adj_plays = f(T.adj && T.adj.off.plays_pg, 0); P.o_adj_plays = f(O.adj && O.adj.def.plays_pg, 0);
    DR.o_drives_faced = P.o_drives_faced; DR.o_off_drives_pg = f(v(O.off.drives_pg), L.drives_pg); DR.t_def_drives_faced = f(v(T.def.drives_pg), L.drives_pg);
    D.o_pr_all_faced = f(v(O.def.pr_all), L.pr_all); D.o_pr_neutral_faced = f(v(O.def.pr_neutral), L.pr_neutral);
    D.t_adj_pr_neutral = f(T.adj && T.adj.off.pr_neutral, 0);
    D.mix_matchup_leagueshares = f(mixRate(leagueShares, scriptRates(r)), L.pr_all);
  }
  if (lvl >= 2) {
    const m = U.isNum(r.m) ? r.m : 0, tot = U.isNum(r.total) ? r.total : (L.points_pg != null ? 2 * L.points_pg : 0);
    P.m = m; P.abs_m = Math.abs(m); P.total = tot; P.home = r.home; P.rest_diff = r.rest_diff;
    P.o_spp_neutral = f(v(O.off.spp_neutral), L.spp_neutral); P.o_def_spp_faced = f(v(O.def.spp_neutral), L.spp_neutral);
    P.no_line = r.m_source === 'line' ? 0 : 1;
    DR.m = m; DR.abs_m = Math.abs(m); DR.total = tot; DR.o_spp_neutral = P.o_spp_neutral; DR.t_spp_all = P.t_spp_all; DR.no_line = P.no_line;
    D.mix_matchup_marketshares = f(mixRate(sharesFor(tables.script_m, r.m), scriptRates(r)), L.pr_all);
    D.m = m; D.total = tot; D.home = r.home;
  }
  if (lvl >= 3) {
    /* observed formation/charting enters as a deviation from the league's
       observed rate, and as exactly 0 where it was not observed (pre-2022 NFL
       has no FTN; an uncharted college game has no formation tokens). Nothing
       is imputed into the unobserved cases. */
    const dev = (x, k) => { const y = v(x); return U.isNum(y) && U.isNum(L[k]) ? y - L[k] : 0; };
    const has = (x) => (U.isNum(v(x)) ? 1 : 0);
    P.t_no_huddle = dev(T.off.no_huddle_rate, 'no_huddle_rate'); P.t_shotgun = dev(T.off.shotgun_rate, 'shotgun_rate'); P.o_no_huddle = dev(O.off.no_huddle_rate, 'no_huddle_rate');
    D.t_shotgun = P.t_shotgun; D.t_no_huddle = P.t_no_huddle; D.has_charting = has(T.off.shotgun_rate);
    D.t_play_action = dev(T.off.play_action_rate, 'play_action_rate'); D.t_rpo = dev(T.off.rpo_rate, 'rpo_rate'); D.t_screen = dev(T.off.screen_rate, 'screen_rate');
    D.t_motion = dev(T.off.motion_rate, 'motion_rate'); D.o_box_avg = dev(O.def.box_avg, 'box_avg'); D.o_blitz_avg = dev(O.def.blitz_avg, 'blitz_avg');
    D.o_box8 = dev(O.def.box8_rush_rate, 'box8_rush_rate'); D.has_ftn = has(T.off.play_action_rate);
    DR.t_no_huddle = P.t_no_huddle; DR.o_no_huddle = P.o_no_huddle;
  }
  return { plays: P, db: D, drives: DR };
}
function marketFeatures(r) {
  const m = U.isNum(r.m) ? r.m : 0; const tot = U.isNum(r.total) ? r.total : 0;
  const x = { m, abs_m: Math.abs(m), total: tot, home: r.home, no_line: r.m_source === 'line' ? 0 : 1 };
  return { plays: x, db: x, drives: x };
}

/* ------------------------------------------------------------ ridge fit */
function fitRidge(X, y, names, lambda) {
  const p = names.length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  /* a constant column (or one whose spread is floating-point noise) is left
     unscaled: an sd of 1e-17 would be stored as 0 and divide 0 by 0 later */
  for (let j = 0; j < p; j++) { const col = X.map((r) => r[j]); mu[j] = U.mean(col); const s = U.sd(col); sd[j] = s != null && s > 1e-9 ? s : 1; }
  const Z = X.map((r) => [1].concat(r.map((x, j) => (x - mu[j]) / sd[j])));
  const b = U.ridge(Z, y, lambda);
  return { names, mu: mu.map((x) => U.round(x, 6)), sd: sd.map((x) => U.round(x, 6)), b: b.map((x) => U.round(x, 6)), lambda, n: y.length };
}
function predictRidge(model, feats) {
  let s = model.b[0];
  for (let j = 0; j < model.names.length; j++) { const x = feats[model.names[j]]; s += model.b[j + 1] * (((U.isNum(x) ? x : model.mu[j]) - model.mu[j]) / (model.sd[j] > 0 ? model.sd[j] : 1)); }
  return s;
}

/* ---------------------------------------------------------- the model */
/* train: rows with labels (training seasons only). -> params */
function train(sport, rows, opts) {
  opts = opts || {};
  const lambda = opts.lambda == null ? 5 : opts.lambda;
  const lab = rows.filter((r) => r.labels && r.labels.plays > 0);
  const tables = { script_m: fitScriptTable(lab, 'm'), script_realized: fitScriptTable(lab, 'margin') };
  const models = {};
  const variants = RUNGS.concat(['market_only']);
  for (const rung of variants) {
    const fx = (r) => rung === 'market_only' ? marketFeatures(r) : featuresFor(r, rung, tables);
    const one = fx(lab[0]);
    const out = {};
    ['plays', 'db', 'drives'].forEach((target) => {
      const names = Object.keys(one[target]).sort();
      const use = target === 'drives' ? lab.filter((r) => r.labels.drives > 0) : lab;
      const X = use.map((r) => { const ff = fx(r)[target]; return names.map((n) => ff[n]); });
      const y = use.map((r) => target === 'plays' ? r.labels.plays : (target === 'db' ? r.labels.db_rate : r.labels.drives));
      out[target] = fitRidge(X, y, names, lambda);
    });
    models[rung] = out;
  }
  /* rates for sacks / scrambles: logit-combined offence + defence-faced, calibrated by a linear fit */
  const sackFit = linFit(lab.map((r) => [rateSack(r)]), lab.map((r) => r.labels.dropbacks ? r.labels.sacks / r.labels.dropbacks : null));
  const scrFit = sport === 'nfl' ? linFit(lab.map((r) => [rateScr(r)]), lab.map((r) => r.labels.dropbacks ? r.labels.scrambles / r.labels.dropbacks : null)) : null;
  const params = { sport, version: opts.version || 'situational_v1', trained_on: opts.trained_on || null, n_rows: lab.length, lambda, tables, models, sack: sackFit, scramble: scrFit };
  params.residual = fitResiduals(sport, params, lab);
  params.phi = 1;
  return params;
}
function rateSack(r) { return combine(v(r.T.off.sack_rate), v(r.O.def.sack_rate), r.league.sack_rate); }
function rateScr(r) { return U.isNum(v(r.T.off.scramble_rate)) ? v(r.T.off.scramble_rate) : r.league.scramble_rate; }
function linFit(X, y) {
  const keep = []; X.forEach((x, i) => { if (U.isNum(y[i]) && U.isNum(x[0])) keep.push(i); });
  if (keep.length < 30) return { a: 0, b: 1 };
  const b = U.ridge(keep.map((i) => [1, X[i][0]]), keep.map((i) => y[i]), 0);
  return { a: U.round(b[0], 6), b: U.round(b[1], 6) };
}

/* means for one row under a variant */
function predictMean(params, r, variant) {
  const rung = variant || 'formation';
  const fx = rung === 'market_only' ? marketFeatures(r) : featuresFor(r, rung, params.tables);
  const M = params.models[rung];
  const plays = Math.max(25, predictRidge(M.plays, fx.plays));
  const db = U.clamp(predictRidge(M.db, fx.db), 0.2, 0.85);
  const drives = Math.max(6, predictRidge(M.drives, fx.drives));
  const lg = r.league;
  const sr = U.clamp(rung === 'market_only' ? lg.sack_rate : params.sack.a + params.sack.b * rateSack(r), 0.01, 0.2);
  const scr = params.scramble ? U.clamp(rung === 'market_only' ? lg.scramble_rate : params.scramble.a + params.scramble.b * rateScr(r), 0, 0.15) : 0;
  const dropbacks = plays * db; const sacks = dropbacks * sr; const scrambles = (dropbacks - sacks) * scr;
  const pass_att = dropbacks - sacks - scrambles; const rush_att = plays - dropbacks + scrambles;
  return { plays, drives, db_rate: db, sack_rate: sr, scramble_rate: scr, dropbacks, sacks, scrambles, pass_att, rush_att, pass_rate: pass_att / (pass_att + rush_att) };
}

/* residual structure, from the training rows' own full-model residuals.
   Game level: total plays P (both offences) and its residual; the team split
   of P and its sensitivity to the margin surprise; game possessions D given
   the plays residual (more snaps in a game means more possessions, but each
   one shorter — modelling D and plays-per-drive as independent overstates the
   variance, which the first validation run showed: 97% P10-P90 coverage). */
function fitResiduals(sport, params, lab) {
  const byGame = {};
  lab.forEach((r) => { (byGame[r.game_id] = byGame[r.game_id] || []).push(r); });
  const marg = [], eP = [], eS = [], eD = [], eDb = [], sampVar = [];
  Object.values(byGame).forEach((pair) => {
    if (pair.length !== 2) return;
    const [a, b] = pair;
    if (!U.isNum(a.labels.margin) || !U.isNum(a.m) || !(a.labels.drives > 0) || !(b.labels.drives > 0)) return;
    const ma = predictMean(params, a, 'formation'), mb = predictMean(params, b, 'formation');
    const dm = a.labels.margin - a.m; marg.push(dm);
    const P = a.labels.plays + b.labels.plays, Ph = ma.plays + mb.plays; eP.push(P - Ph);
    eS.push([dm, a.labels.plays / P - ma.plays / Ph]);
    eD.push([P - Ph, a.labels.drives + b.labels.drives - (ma.drives + mb.drives)]);
    [[a, ma, dm], [b, mb, -dm]].forEach(([r, mu, d]) => { eDb.push([d, r.labels.db_rate - mu.db_rate]); sampVar.push(mu.db_rate * (1 - mu.db_rate) / r.labels.plays); });
  });
  const slope = (xy) => { const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]); const mx = U.mean(xs), my = U.mean(ys); let sxy = 0, sxx = 0; xy.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }); return sxx ? sxy / sxx : 0; };
  const bS = slope(eS), gD = slope(eD), bD = slope(eDb);
  const remS = eS.map(([x, y]) => y - bS * x), remD = eD.map(([x, y]) => y - gD * x), remDb = eDb.map(([x, y]) => y - bD * x);
  return {
    sigma_margin: U.round(U.sd(marg) || (sport === 'nfl' ? 13.5 : 16), 4),
    sigma_game_plays: U.round(U.sd(eP) || 10, 4),
    beta_share_margin: U.round(bS, 6), sigma_share: U.round(U.sd(remS) || 0.04, 6),
    gamma_drives_plays: U.round(gD, 6), sigma_game_drives: U.round(U.sd(remD) || 1.5, 4),
    beta_db_margin: U.round(bD, 6), sigma_db_extra: U.round(Math.sqrt(Math.max((U.variance(remDb) || 0) - (U.mean(sampVar) || 0), 1e-6)), 6),
    n_games: eP.length
  };
}

/* correlated simulation of one game: a = team row, b = its opponent's row
   (each the offence's perspective). -> { a: summary, b: summary } */
function simulateGame(params, a, b, opts) {
  opts = opts || {};
  const n = opts.draws || 4000; const phi = opts.phi != null ? opts.phi : (params.phi || 1);
  const R = params.residual; const u = U.rng(opts.seed || ('fsie|' + a.game_id)); const N = U.normalSampler(u);
  const muA = predictMean(params, a, opts.variant), muB = predictMean(params, b, opts.variant);
  const mA = U.isNum(a.m) ? a.m : 0;
  const draws = { a: { plays: [], pass_att: [], rush_att: [], sacks: [], drives: [], dropbacks: [] }, b: { plays: [], pass_att: [], rush_att: [], sacks: [], drives: [], dropbacks: [] } };
  const scriptAcc = { a: SCRIPTS.reduce((o, k) => { o[k] = 0; return o; }, {}), b: SCRIPTS.reduce((o, k) => { o[k] = 0; return o; }, {}) };
  const binom = (nn, p) => { if (nn <= 0) return 0; if (nn > 60) { const z = N(); return U.clamp(Math.round(nn * p + z * Math.sqrt(nn * p * (1 - p))), 0, nn); } let k = 0; for (let i = 0; i < nn; i++) if (u() < p) k++; return k; };
  const Ph = muA.plays + muB.plays, shA = muA.plays / Ph, Dh = muA.drives + muB.drives;
  for (let i = 0; i < n; i++) {
    /* realized margin surprise, team a's perspective; a caller that owns a margin
       model (the season simulators) supplies its own sigma */
    const dM = (U.isNum(opts.sigma_margin) ? opts.sigma_margin : R.sigma_margin) * N();
    /* one game: total snaps, their split, and possessions that follow from them */
    const zP = phi * R.sigma_game_plays * N();
    const P = Math.max(70, Math.round(Ph + zP));
    const s = U.clamp(shA + R.beta_share_margin * dM + phi * R.sigma_share * N(), 0.3, 0.7);
    const pA = Math.round(P * s), pB = P - pA;
    const D = Math.max(12, Math.round(Dh + R.gamma_drives_plays * (P - Ph) + phi * R.sigma_game_drives * N()));
    let dA = Math.floor(D / 2), dB = D - dA; if (D % 2 && u() < 0.5) { dA += 1; dB -= 1; }
    [['a', muA, pA, dA, dM], ['b', muB, pB, dB, -dM]].forEach(([k, mu, plays, d, dm]) => {
      const rate = U.clamp(mu.db_rate + R.beta_db_margin * dm + phi * R.sigma_db_extra * N(), 0.12, 0.92);
      const dropbacks = binom(plays, rate); const sacks = binom(dropbacks, mu.sack_rate); const scr = binom(dropbacks - sacks, mu.scramble_rate);
      const out = draws[k];
      out.plays.push(plays); out.dropbacks.push(dropbacks); out.sacks.push(sacks); out.drives.push(d);
      out.pass_att.push(dropbacks - sacks - scr); out.rush_att.push(plays - dropbacks + scr);
      const sh = sharesFor(params.tables.script_realized, (k === 'a' ? mA : -mA) + dm);
      SCRIPTS.forEach((sc) => { scriptAcc[k][sc] += sh[sc] / n; });
    });
  }
  const summ = (k, mu) => {
    const d = draws[k]; const o = { mean: {}, p10: {}, p50: {}, p90: {}, point: {} };
    ['plays', 'pass_att', 'rush_att', 'sacks', 'drives', 'dropbacks'].forEach((m) => { const q = U.quantiles(d[m], [0.1, 0.5, 0.9]); o.p10[m] = q[0]; o.p50[m] = q[1]; o.p90[m] = q[2]; o.mean[m] = U.round(U.mean(d[m]), 2); });
    ['plays', 'pass_att', 'rush_att', 'sacks', 'drives', 'dropbacks'].forEach((m) => { o.point[m] = U.round(mu[m], 2); });
    o.point.pass_rate = U.round(mu.pass_rate, 4); o.point.db_rate = U.round(mu.db_rate, 4);
    o.script = {}; SCRIPTS.forEach((s) => { o.script[s] = U.round(scriptAcc[k][s], 4); });
    o.plays_by_script = {}; SCRIPTS.forEach((s) => { o.plays_by_script[s] = U.round(o.script[s] * o.mean.plays, 1); });
    o.draws = opts.keep_draws ? d : undefined;
    return o;
  };
  return { a: summ('a', muA), b: summ('b', muB), draws: n, seed: String(opts.seed || ('fsie|' + a.game_id)) };
}

module.exports = { train, predictMean, simulateGame, featuresFor, marketFeatures, fitScriptTable, sharesFor, scriptRates, mixRate, combine, RUNGS, SCRIPTS, fitRidge, predictRidge };

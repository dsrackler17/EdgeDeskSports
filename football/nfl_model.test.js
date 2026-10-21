#!/usr/bin/env node
/* ===========================================================================
   football/nfl_model.js — the v2 NFL model — held to the parity-tested v1.

   1. Its geometric configuration IS engine.js's v1 recursion: replaying the
      full 2025 and 2026 seasons from python's own start-of-2025 state
      (football/research/nfl_v2/parity/), both through the shared row
      building, every rating, league mean and QB value agrees within 1e-12.
   2. Its predictions in that configuration, with v1's weights, equal
      engine.js predictGame's fair spread and the card's rows.
   3. The hyperbolic prior weight is k/(k+n), the prior/current split is exact,
      the season break carries the final rating, the ridge recovers a known
      linear model, isotonic calibration is monotone, travel is geometry.
   4. Round 2: the regular starter (most starts in the club's last 8, ties to
      the most recent) and qb_out_diff; the standardised ridge is the raw
      ridge at lambda 0 and is scale-free otherwise.

   Run: node football/nfl_model.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
const { parseCsv } = require(path.join(ROOT, 'football', 'nfl', 'build_team_week.js'));
const P = globalThis.EDFootballParams.nfl;

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('PASS | ' + name); } else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 300) : '')); } }

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'football', 'research', 'nfl_v2', 'parity', 'nfl_parity_2025_2026.json.gz'))).toString('utf8'));
const byGame = (file) => { const o = {}; if (fs.existsSync(file)) parseCsv(fs.readFileSync(file, 'utf8')).rows.forEach((r) => { (o[r.game_id] = o[r.game_id] || []).push(r); }); return o; };
const stw = Object.assign({}, byGame(path.join(ROOT, 'football/nfl/stats_team_week_2025.csv')), byGame(path.join(ROOT, 'football/nfl/stats_team_week_2026.csv')));
const qbg = Object.assign({}, byGame(path.join(ROOT, 'football/nfl/qb_games_2025.csv')), byGame(path.join(ROOT, 'football/nfl/qb_games_2026.csv')));

/* ---- 1. the geometric configuration is v1 ---- */
const cfgV1 = M.config({ carry: P.hyperparams.carry, prior: { kind: 'geometric', alpha: P.hyperparams.alpha, alpha_pts: P.hyperparams.alpha_pts },
  alpha_league: P.hyperparams.alpha_league, qb: { alpha_qb: P.hyperparams.alpha_qb, qb_shrink: P.hyperparams.qb_shrink, qb_prior: P.hyperparams.qb_prior } });
const v2 = M.fromSeeds(cfgV1, { team: fx.start.team, lmean: fx.start.lmean, qb: fx.start.qb, team_qb: fx.start.team_qb, season: 2025 });
const v1 = E.nfl.coldState();
v1.team = JSON.parse(JSON.stringify(fx.start.team)); v1.lmean = JSON.parse(JSON.stringify(fx.start.lmean));
v1.qb = JSON.parse(JSON.stringify(fx.start.qb)); v1.teamQb = JSON.parse(JSON.stringify(fx.start.team_qb)); v1.ngames = JSON.parse(JSON.stringify(fx.start.ngames));
let season = 2025, worst = 0, where = null, n = 0;
for (const g of fx.games) {
  if (g.season !== season) { E.nfl.seasonBreak(v1); M.seasonBreak(v2, g.season); season = g.season; }
  const a = E.nfl.absorbCompleted(v1, g, stw[g.game_id] || [], qbg[g.game_id] || []);
  const b = M.absorbCompleted(v2, g, stw[g.game_id] || [], qbg[g.game_id] || []);
  if (a !== b) { worst = Infinity; where = g.game_id + ' absorbed by one model only'; break; }
  if (!a) continue;
  n++;
  for (const t of [g.home_team, g.away_team]) for (const f of M.RATE_FEATS) {
    const d = Math.abs(M.rating(v2, t, f) - v1.team[t][f]);
    if (d > worst) { worst = d; where = g.game_id + ' ' + t + '.' + f; }
  }
}
chk(`nfl_model geometric = engine.js v1 over ${n} games of 2025-2026 (worst ${worst.toExponential(2)} at ${where})`, worst < 1e-12 && n === fx.meta.absorbed, { worst, where, n });
let qw = 0; for (const id in v1.qb) qw = Math.max(qw, Math.abs(v1.qb[id].v - v2.qb[id].v) + Math.abs(v1.qb[id].n - v2.qb[id].n));
let tq = 0; for (const t in v1.teamQb) tq = Math.max(tq, Math.abs((v1.teamQb[t] || 0) - (v2.teamQb[t] || 0)));
let lmw = 0; for (const f in v1.lmean) lmw = Math.max(lmw, Math.abs(v1.lmean[f] - v2.lmean[f]));
chk('… and every QB value, team QB level and league mean', qw < 1e-12 && tq < 1e-12 && lmw < 1e-12, { qw, tq, lmw });

/* ---- 2. predictions with v1's weights equal predictGame ---- */
const v1Params = {
  spread: { names: P.spread_feats.slice(), w: P.w_spread.slice(0, -1), b: P.w_spread[P.w_spread.length - 1] },
  ctx: { names: P.ctx_feats.slice(), w: P.w_ctx.slice(0, -1), b: P.w_ctx[P.w_ctx.length - 1] },
  total: { names: P.total_feats.slice(), w: P.w_total.slice(0, -1), b: P.w_total[P.w_total.length - 1] }
};
const game = { home: 'SEA', away: 'KC', week: 7, season: 2026, home_rest: 10, away_rest: 7, roof: 'outdoors', surface: 'fieldturf', div_game: 0,
  home_qb_id: '00-0034869', away_qb_id: '00-0033873', neutral: false };
const pe = E.predictGame({ sport: 'nfl', state: v1, season: 2026, game });
const pm = M.predict(v2, game, v1Params);
chk('nfl_model.predict with v1 weights = engine.js predictGame fair spread (KC @ SEA)', Math.abs(pm.margin - pe.model.fair_spread) < 1e-9, { m: pm.margin, e: pe.model.fair_spread });
chk('… and the fair total', Math.abs(pm.total - pe.model.fair_total) < 1e-9, { m: pm.total, e: pe.model.fair_total });
const cardM = E.nfl.card({ terms: M.engineTerms(pm), model_spread: pm.margin });
chk('the card folds nfl_model\'s terms into the same seven rows, reconciling', cardM && cardM.reconciles && cardM.rows.length === 7, cardM && cardM.unplaced);
chk('… row for row the same as the engine\'s card', cardM.rows.every((r, i) => Math.abs(r.points - pe.card.rows[i].points) < 1e-9), cardM.rows.map((r, i) => [r.key, r.points, pe.card.rows[i].points]));
chk('… with the same prior / this-season split', cardM.rows.every((r, i) => (r.prior == null) === (pe.card.rows[i].prior == null) && (r.prior == null || Math.abs(r.prior - pe.card.rows[i].prior) < 1e-9)));

/* ---- 3. the pieces ---- */
const cfgH = M.config({ prior: { kind: 'hyperbolic', k: 4, k_pts: 8 }, recency: 1 });
chk('hyperbolic prior weight is k/(k+n)', Math.abs(M.priorWeight(cfgH, 'pass_epa_db', 6) - 0.4) < 1e-15 && Math.abs(M.priorWeight(cfgH, 'pts_for', 8) - 0.5) < 1e-15 && M.priorWeight(cfgH, 'pass_epa_db', 0) === 1);
{
  const st = M.newState(cfgH); M.team(st, 'A'); M.team(st, 'B'); st.team.A.pass_epa_db.p = 0.2; st.lmean.pass_epa_db = 0;
  const row = (t, pe2) => ({ team: t, attempts: 30, carries: 20, sacks_suffered: 0, passing_epa: pe2, rushing_epa: 0, passing_20: 2, rushing_10: 2 });
  M.absorbCompleted(st, { home_team: 'A', away_team: 'B', home_score: 20, away_score: 10 }, [row('A', 3), row('B', 0)], []);
  M.absorbCompleted(st, { home_team: 'A', away_team: 'B', home_score: 20, away_score: 10 }, [row('A', 6), row('B', 0)], []);
  const r = M.rating(st, 'A', 'pass_epa_db'), pp = M.priorPart(st, 'A', 'pass_epa_db');
  chk('after two games the prior keeps k/(k+2) = 2/3 of its value', Math.abs(pp - 0.2 * 4 / 6) < 1e-15, pp);
  chk('rating = prior part + (1 - w) x this season\'s mean', Math.abs(r - pp - (1 - 4 / 6) * (st.team.A.pass_epa_db.S / st.team.A.pass_epa_db.W)) < 1e-15);
  const before = M.rating(st, 'A', 'pass_epa_db');
  M.seasonBreak(st, 2027);
  chk('the season break carries the final rating x carry into next season\'s prior', Math.abs(st.team.A.pass_epa_db.p - cfgH.carry * before) < 1e-15 && st.team.A.pass_epa_db.n === 0);
}
{
  const X = [], y = [];
  for (let i = 0; i < 400; i++) { const a = Math.sin(i), b = Math.cos(i * 1.7); X.push([a, b]); y.push(2 * a - 3 * b + 1.5); }
  const fit = M.ridge(X, y, 0, true);
  chk('ridge (lambda 0) recovers a known linear model', Math.abs(fit.w[0] - 2) < 1e-9 && Math.abs(fit.w[1] + 3) < 1e-9 && Math.abs(fit.b - 1.5) < 1e-9, fit);
  const fit0 = M.ridge(X, y.map((v) => v - 1.5), 0, false);
  chk('… and without an intercept', Math.abs(fit0.w[0] - 2) < 1e-9 && fit0.b === 0);
}
{
  const pairs = []; for (let i = 0; i < 500; i++) { const p = (i + 0.5) / 500; pairs.push([p, (i * 7919) % 100 < p * 100 * 0.8 + 10 ? 1 : 0]); }
  const cal = M.fitIsotonic(pairs);
  let mono = true; for (let i = 1; i < cal.y.length; i++) if (cal.y[i] < cal.y[i - 1] - 1e-12) mono = false;
  chk('isotonic calibration is monotone and clipped to [0.01, 0.99]', mono && M.calibrate(cal, 0) >= 0.01 && M.calibrate(cal, 1) <= 0.99);
}
{
  const stad = M.indexStadiums(JSON.parse(fs.readFileSync(path.join(ROOT, 'football/venues/nfl_stadiums.json'), 'utf8')));
  const t = M.travelFor(stad, { season: 2026, gameday: '2026-10-25', gametime: '13:00', home: 'NYJ', away: 'SEA', neutral: false });
  chk('travel: Seattle to MetLife is about 3,870 km and three time zones, a 1 pm ET body-clock game', t && Math.abs(t.away_km - 3870) < 60 && t.away_tz === 3 && t.away_west_early === 1 && t.home_km === 0, t);
  const t2 = M.travelFor(stad, { season: 2015, gameday: '2015-10-25', gametime: '16:25', home: 'LA', away: 'SF', neutral: false });
  chk('travel: the Rams\' 2015 home is St. Louis (relocation history)', t2 && Math.abs(t2.away_km - 2790) < 80, t2);
}

/* ---- 4. round 2 ---- */
{
  const cfgQ = M.config({ features: { qb_out: true } });
  const st = M.newState(cfgQ);
  const start = (t, id, dev) => M.absorbGame(st, [[t, {}], [t === 'A' ? 'B' : 'A', {}]], [[t, id, dev]]);
  for (let i = 0; i < 5; i++) start('A', 'x', 0.1);
  for (let i = 0; i < 3; i++) start('A', 'y', 0.0);
  chk('regular starter: the most starts in the last 8 (5 of x against 3 of y)', M.regularStarter(st, 'A') === 'x' && st.starts.A.length === 8);
  chk('a side is OUT when its starter is not the regular starter', M.qbOut(st, 'A', 'y') === 1 && M.qbOut(st, 'A', 'x') === 0);
  chk('no named starter, or no history, is never OUT', M.qbOut(st, 'A', null) === 0 && M.qbOut(st, 'C', 'z') === 0);
  start('A', 'y', null);
  chk('a start with no EPA line still counts toward the window (now 4 x, 4 y: the tie goes to the most recent)', M.regularStarter(st, 'A') === 'y' && st.starts.A.length === 8);
  M.seasonBreak(st, 2027);
  chk('the window carries over the season break', M.regularStarter(st, 'A') === 'y');
  for (let i = 0; i < 6; i++) start('B', 'p', 0.05);
  const F = M.features(st, { season: 2027, week: 1, home: 'A', away: 'B', home_qb_id: 'x', away_qb_id: 'p', home_rest: 7, away_rest: 7, neutral: false });
  chk('qb_out_diff = home out - away out', F.spread.qb_out_diff === 1, F.spread.qb_out_diff);
  const F2 = M.features(st, { season: 2027, week: 1, home: 'B', away: 'A', home_qb_id: 'p', away_qb_id: 'x', home_rest: 7, away_rest: 7, neutral: false });
  chk('… and -1 with the sides swapped', F2.spread.qb_out_diff === -1, F2.spread.qb_out_diff);
  chk('qb_out_diff is a strength feature only when the configuration turns it on',
    M.featureNames(cfgQ).spread.indexOf('qb_out_diff') >= 0 && M.featureNames(M.config()).spread.indexOf('qb_out_diff') < 0);
  const cfgG = M.config({ features: { qb_out: true, qb_out_gap: true } });
  const sg = M.fromSeeds(cfgG, { starts: { A: ['r', 'r', 'r'], B: ['p', 'p'] }, qb: { r: { v: 0.2, n: 30 }, b: { v: 0, n: 1 }, p: { v: 0.05, n: 20 } } });
  const gap = M.qbEff(sg, 'r') - M.qbEff(sg, 'b');
  chk('Q3: the out gap is the regular starter\'s QB value minus his replacement\'s', Math.abs(M.qbOutGap(sg, 'A', 'b') - gap) < 1e-15 && Math.abs(gap - 0.16835) < 1e-4, gap);
  chk('… and 0 when the regular starter plays or no starter is named', M.qbOutGap(sg, 'A', 'r') === 0 && M.qbOutGap(sg, 'A', null) === 0);
  const Fg = M.features(sg, { season: 2027, week: 1, home: 'A', away: 'B', home_qb_id: 'b', away_qb_id: 'p', home_rest: 7, away_rest: 7, neutral: false });
  chk('qb_out_gap_diff = home gap - away gap, and a feature only when turned on', Math.abs(Fg.spread.qb_out_gap_diff - gap) < 1e-15 &&
    M.featureNames(cfgG).spread.indexOf('qb_out_gap_diff') >= 0 && M.featureNames(cfgQ).spread.indexOf('qb_out_gap_diff') < 0, Fg.spread.qb_out_gap_diff);
  const st2 = M.fromSeeds(cfgQ, { starts: { A: ['x', 'x', 'y'] } });
  st2.starts.A.push('y');
  chk('the trained seeds carry the window, copied (the params are never written through)', M.regularStarter(M.fromSeeds(cfgQ, { starts: { A: ['x', 'x', 'y'] } }), 'A') === 'x' && st2.starts.A.length === 4);
}
{
  const B = require(path.join(ROOT, 'football', 'research', 'nfl_v2', 'backtest.js'));
  const X = [], y = [];
  for (let i = 0; i < 300; i++) { const a = Math.sin(i), b = 40 * Math.cos(i * 1.3), c = (i % 7) / 7; X.push([a, b, c]); y.push(3 * a - 0.05 * b + 2 * c + 0.3 * Math.sin(i * 0.37) + 1); }
  const raw = M.ridge(X, y, 0, true), std = B.ridgeStd(X, y, 0, true);
  chk('standardised ridge at lambda 0 is the raw least-squares fit', raw.w.every((w, j) => Math.abs(w - std.w[j]) < 1e-8) && Math.abs(raw.b - std.b) < 1e-8, { raw, std });
  const X100 = X.map((r) => [r[0] * 100, r[1], r[2]]);
  const pr = (f, Z) => Z.map((r) => f.b + r.reduce((s, x, j) => s + f.w[j] * x, 0));
  const p1 = pr(B.ridgeStd(X, y, 50, true), X), p2 = pr(B.ridgeStd(X100, y, 50, true), X100);
  chk('standardised ridge is scale-free: rescaling a feature leaves every prediction unchanged', p1.every((v, i) => Math.abs(v - p2[i]) < 1e-8));
  const q1 = pr(M.ridge(X, y, 50, true), X), q2 = pr(M.ridge(X100, y, 50, true), X100);
  chk('… where the raw ridge is not (its penalty depends on the units)', q1.some((v, i) => Math.abs(v - q2[i]) > 1e-4));
}

console.log(fail ? `FAILURES ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);

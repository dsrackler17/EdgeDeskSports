/* The served NBA model as the simulator reads it, and the availability layer:
   - the live parameters are nba/params/live.json + ml_live.json, unchanged;
   - the game distribution at any mean is the served one (exact P(home) to < 1e-6 on the grid,
     the final margin never 0, the margin given the winner drawn from the served pmf);
   - return trajectories: the appearance scan (SYNTHETIC game logs), unit mass, monotone survival,
     the committed hazard table and its holdout evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { kit } from './_kit.ts';
import { REPO, liveParams, marginTable, nbaModules } from '../src/sports/nba/model_adapter.ts';
import { NbaGameDist } from '../src/sports/nba/game_dist.ts';
import { AppearanceScan, returnDistribution, hazard, hazards, kBin, MIN_MINUTES, type HazardTable, type TeamGame } from '../src/sports/nba/availability.ts';
import { AvailabilityPlan } from '../src/core/hooks.ts';
import { sigmaFor } from '../src/sports/nba/inputs.ts';
import { streamFor } from '../src/core/prng.ts';

const T = kit('NBA served model and availability');

/* 1 the live parameters */
{
  const lp = liveParams(); const live = JSON.parse(fs.readFileSync(path.join(REPO, 'nba', 'params', 'live.json'), 'utf8')), ml = JSON.parse(fs.readFileSync(path.join(REPO, 'nba', 'params', 'ml_live.json'), 'utf8'));
  T.eq('the projected-track choice is the walk-forward\'s (E_ridge_P)', [lp.chosen, live.chosen.P], ['E_ridge_P', 'E_ridge_P']);
  T.eq('the ridge models are ml_live.json\'s, unchanged', [lp.ml.ridge_m, lp.ml.ridge_t, lp.ml.features], [ml.models.P.ridge_m, ml.models.P.ridge_t, ml.models.P.features]);
  T.eq('the calibration, shape and overtime are live.json\'s, unchanged', [lp.calibration, lp.shape, lp.ot], [live.calibration.E_ridge_P, live.shape, live.ot]);
  T.chk('the ridge carries the postseason term (feature playoff)', lp.ml.features.includes('playoff'));
}

/* 2 the distribution */
{
  const lp = liveParams(); const { DIST, DF } = nbaModules();
  const dist = new NbaGameDist({ calibration: { sd_m: lp.calibration.sd_m }, shape: lp.shape, ot: lp.ot });
  let worst = 0, n = 0;
  for (let mu = -25; mu <= 25; mu += 0.0731) { worst = Math.max(worst, Math.abs(dist.pHome(mu) - dist.exactPHome(mu))); n++; }
  T.chk('P(home win) on the grid equals the served marginals() to < 1e-6 at ' + n + ' means', worst < 1e-6, worst);
  const p = { mu_m: 3.2, sd_m: DF.sdOf(lp.calibration.sd_m, 3.2), theta: lp.shape.theta, ot: lp.ot, mu_t: 220, sd_t: 18 };
  const mg = DIST.marginals(p), mt = marginTable(p);
  T.near('the margin table is the served final margin (P(home) = served p_home)', mt.pHome, mg.p_home, 1e-12);
  T.near('the served final margin has no mass at 0 (overtime resolves every tie)', mg.margin.pmf[-mg.margin.lo], 0, 1e-15);
  T.near('the cdf ends at 1', mt.cdf[mt.cdf.length - 1], 1, 0);
  /* the margin given the winner: draws at a fine grid of u reproduce the served pmf restricted to that side */
  for (const mu of [-7.3, 0, 4.25]) {
    const q = marginTable({ ...p, mu_m: Math.round(mu * 10) / 10, sd_m: DF.sdOf(lp.calibration.sd_m, Math.round(mu * 10) / 10) });
    const pmf = q.cdf.map((c, i) => c - (i ? q.cdf[i - 1] : 0));
    for (const home of [true, false]) {
      const cnt = new Map<number, number>(); const K = 20000;
      for (let i = 0; i < K; i++) { const m = dist.drawMargin(mu, home, (i + 0.5) / K); cnt.set(m, (cnt.get(m) || 0) + 1); }
      let s = 0; for (let i = 0; i < pmf.length; i++) { const m = q.lo + i; if (home ? m > 0 : m < 0) s += pmf[i]; }
      let err = 0, signOk = true;
      for (let i = 0; i < pmf.length; i++) { const m = q.lo + i; if (!(home ? m > 0 : m < 0)) continue; err = Math.max(err, Math.abs((cnt.get(m) || 0) / K - pmf[i] / s)); }
      for (const m of cnt.keys()) if (home ? m <= 0 : m >= 0) signOk = false;
      T.chk('mu ' + mu + (home ? ', home wins' : ', away wins') + ': every drawn margin is on the winner\'s side', signOk);
      T.chk('mu ' + mu + (home ? ', home wins' : ', away wins') + ': the margin draws follow the served pmf (max error ' + err.toExponential(1) + ')', err < 1.5e-4, err);
    }
  }
}

/* 3 the appearance scan (SYNTHETIC game logs) */
{
  const g = (id: number, season: number, team: string, players: Array<[string, number]>): TeamGame => ({ game_id: 'x' + id, season, start_ms: id * 864e5, team, players: players.map(([p, min]) => ({ p, min })) });
  const s = new AppearanceScan();
  s.add(g(1, 2026, 'A', [['star', 36], ['bench', 6], ['role', 20]]));
  s.add(g(2, 2026, 'A', [['star', 35], ['role', 22]]));
  s.add(g(3, 2026, 'A', [['role', 25]]));
  let ab = s.absent('A', 2026);
  T.eq('a rotation player missing the latest game is tracked with k = 1; a bench player under ' + MIN_MINUTES + ' minutes is not', ab.map((a) => [a.p, a.k, a.carried]), [['star', 1, false]]);
  s.add(g(4, 2026, 'B', [['star', 30]]));
  ab = s.absent('A', 2026);
  T.eq('once he plays for another club he is no longer A\'s absence', ab.length, 0);
  T.eq('... he is tracked by nobody while he plays for B', s.absent('B', 2026).length, 0);
  s.add(g(5, 2027, 'B', [['other', 30]]));
  T.eq('a club\'s player missing since last season is carried', s.absent('B', 2027).map((a) => [a.p, a.k, a.carried]), [['star', 1, true]]);
  s.add(g(6, 2027, 'B', [['other', 30]]));
  T.eq('... k counts the club\'s games since his last appearance', s.absent('B', 2027).map((a) => a.k), [2]);
  T.eq('two seasons later he is no longer tracked', s.absent('B', 2028).length, 0);
}

/* 4 return distributions from the committed hazard table */
{
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'simulator', 'data', 'nba_return_hazards.json'), 'utf8'));
  const H = doc.production as HazardTable;
  T.chk('the production table is fitted on completed seasons only (through 2025-26)', Math.max(...H.estimation_seasons) === 2026 && !H.estimation_seasons.includes(2020) && !H.estimation_seasons.includes(2021));
  T.chk('every cell has entries, and returns + leaves <= entries', Object.values(H.cells).every(([r, n, l]) => n > 0 && r >= 0 && l >= 0 && r + l <= n));
  T.chk('a carried absence leaves (appears for another club) more often than an in-season one', hazards(H, true, 1, 1).leave > hazards(H, false, 1, 1).leave, [hazards(H, true, 1, 1), hazards(H, false, 1, 1)]);
  for (const a of [{ k: 1, carried: false, exp_min: 30 }, { k: 12, carried: false, exp_min: 15 }, { k: 70, carried: true, exp_min: 33 }]) {
    const d = returnDistribution(H, a, 60, 'test');
    const mass = d.periods.reduce((u, p) => u + p.probability, 0) + d.out_for_season;
    T.near('k ' + a.k + (a.carried ? ' carried' : '') + ': the distribution is a unit mass', mass, 1, 1e-12);
    T.chk('k ' + a.k + ': periods are the club\'s games 1..60, each probability positive', d.periods.every((p, i) => p.period === i + 1 && p.probability > 0) && d.periods.length === 60);
    const h0 = hazards(H, a.carried, a.exp_min >= 24 ? 1 : 0, a.k);
    T.chk('k ' + a.k + ': the first game is (1 - leave) x return at k games missed', Math.abs(d.periods[0].probability - (1 - h0.leave) * h0.ret) < 1e-15);
  }
  T.chk('a fresh absence returns sooner than a long one (hazard at k=1 vs k=40)', hazard(H, false, 1, 1) > 3 * hazard(H, false, 1, 40));
  T.chk('a carried absence (since last season) rarely returns', hazard(H, true, 1, 70) < 0.05);
  T.eq('k bins cover 1..9999 without a gap', [kBin(1), kBin(5), kBin(6), kBin(60), kBin(500)], [0, 4, 4, 10, 10]);
  /* the plan draws once per run, from the distribution */
  const d = returnDistribution(H, { k: 3, carried: false, exp_min: 28 }, 40, 'test');
  let hit = 0, at5 = 0; const N = 20000;
  for (let r = 0; r < N; r++) { const plan = new AvailabilityPlan([{ player_id: 'p', team: 'A', dist: d }], streamFor(5n, r, 7)); const x = plan.returnPeriod('p') as number; if (x <= 10) hit++; if (x === 5) at5++; }
  const p10 = d.periods.filter((p) => p.period <= 10).reduce((u, p) => u + p.probability, 0), p5 = d.periods.find((p) => p.period === 5)!.probability;
  T.near('the plan\'s draws follow the distribution: P(return within 10 games)', hit / N, p10, 4 * Math.sqrt(p10 * (1 - p10) / N));
  T.near('... and P(return at game 5)', at5 / N, p5, 4 * Math.sqrt(p5 * (1 - p5) / N));
  /* the holdout evidence the plan is switched on with */
  const h = doc.holdout.by_within as any[];
  T.chk('holdout 2023-24..2025-26: the hazards beat "never returns" (the frozen projection) at every horizon', h.every((x) => x.brier < x.brier_never_returns), h.map((x) => [x.within_games, x.brier, x.brier_never_returns]));
  T.chk('holdout: mean predicted return within 1-41 games is within 6 points of what happened', h.every((x) => Math.abs(x.mean_predicted - x.observed) < 0.06), h.map((x) => [x.within_games, x.mean_predicted, x.observed]));
}

/* 5 the strength sigma a snapshot takes from the committed study */
{
  const unc = JSON.parse(fs.readFileSync(path.join(REPO, 'simulator', 'data', 'nba_strength_uncertainty.json'), 'utf8'));
  const at = (g: number) => unc.by_as_of.find((b: any) => b.as_of_games === g).win_total_calibration.sigma;
  T.eq('the study calibrates five as-of points, estimation seasons before the 2024-25..2025-26 holdout', [unc.by_as_of.map((b: any) => b.as_of_games), Math.max(...unc.estimation_seasons) < Math.min(...unc.holdout_seasons)], [[1, 10, 20, 41, 61], true]);
  T.near('at a calibrated point the snapshot takes its sigma (10 games)', sigmaFor(10)!.sigma_points, at(10), 1e-12);
  T.near('between two points, linear (5.5 games)', sigmaFor(5.5)!.sigma_points, at(1) + 0.5 * (at(10) - at(1)), 1e-12);
  T.near('before the first point, flat (0.93 games)', sigmaFor(0.93)!.sigma_points, at(1), 1e-12);
  T.near('after the last point, flat (82 games)', sigmaFor(82)!.sigma_points, at(61), 1e-12);
  T.chk('the method says which', /linear between the as-of points 1 and 10/.test(sigmaFor(5.5)!.method) && /nearest calibrated point/.test(sigmaFor(0.93)!.method));
  T.chk('every calibrated sigma is positive with its interval around it', unc.by_as_of.every((b: any) => b.win_total_calibration.sigma > 0 && b.win_total_calibration.sigma_ci95[0] <= b.win_total_calibration.sigma && b.win_total_calibration.sigma <= b.win_total_calibration.sigma_ci95[1]));
}

process.exit(T.done());

/* ===========================================================================
   HOW WRONG IS A FROZEN CFB RATING, AND FOR HOW LONG? — the evidence behind
   the CFB simulator's persistent per-team strength offsets.

   A season simulation prices every remaining game from the ratings as they
   stand at the as-of date, frozen. Whatever is wrong with a team's frozen
   rating is wrong in ALL of its remaining games at once. That shared error is
   the persistent offset d_t ~ Normal(0, tau^2), drawn once per team per run;
   the rest of the engine's margin error is game-to-game noise.

   THE DECOMPOSITION. The engine's margin distribution Normal(fair, sigma^2)
   is calibrated per game on these same forecasts (the reliability tables in
   simulator/data/cfb_calibration.json), so the simulator keeps it exactly and
   SPLITS it: margin = fair + d_home - d_away + e, with
       d_t ~ Normal(0, tau^2) persistent per team per run,
       e   ~ Normal(0, sigma^2 - k tau^2) per game,
   k = the number of FBS sides (2, or 1 against an FCS opponent, whose single
   floor rating carries no offset). Every game's marginal probability is then
   Phi(fair / sigma), the engine's own, while a team's games share its d_t,
   which is what spreads its simulated win total. Adding tau ON TOP of sigma
   instead (Phi(f / sqrt(sigma^2 + 2 tau^2)) per game) was measured and
   rejected: it makes the calibrated per-game probabilities underconfident
   (`additive_alternative` below).

   THE ESTIMATE (the NFL study's win-total calibration, simulator/src/research/
   nfl_strength_uncertainty.ts, applied to the served CFB engine):
   1. cfb_replay.ts: the served engine replayed cold 2006-2025; the state is
      frozen after regular-season weeks 4, 7 and 10 of 2014-2025 and every
      remaining regular-season game (FBS opponents and FCS opponents) is priced
      from the frozen state.
   2. For each (season, as-of week) and tau on a grid 0..8 by 0.1 (capped so
      sigma^2 - 2 tau^2 stays positive), simulate
      400 draws of the offsets (common random numbers across tau), compute each
      FBS team's expected remaining wins and its simulated variance, and
      compare the variance with the squared deviation of the ACTUAL remaining
      wins from the simulated mean.
   3. tau = the value where pooled simulated variance equals the pooled
      empirical mean squared deviation (linear interpolation). Estimation
      seasons 2014-2023 except 2020 (a shortened, irregular season); holdout
      2024-2025, reported, never used to fit. FCS opponents carry no offset
      (the engine prices every FCS team at one floor rating).
   4. Uncertainty: a bootstrap over seasons (2000 resamples).
   5. The per-game reliability of the frozen forecasts is reported (it is the
      simulator's per-game probability by construction), with the rejected
      additive alternative beside it.

   Output (committed): simulator/data/cfb_strength_uncertainty.json
   Usage: node simulator/src/research/cfb_strength_uncertainty.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../sports/cfb/engine_adapter.ts';
import { cachedReplay, type ReplayRow } from './cfb_replay.ts';
import { streamFor } from '../core/prng.ts';
import { normalQuantile, normalCdf } from '../core/normal.ts';
import { wilson } from '../core/stats.ts';
import { sha256Hex } from '../core/canonical.ts';

export const CFB_STRENGTH_FILE = path.join(REPO, 'simulator', 'data', 'cfb_strength_uncertainty.json');
export const REPLAY = { from: 2014, to: 2025, asOfWeeks: [4, 7, 10] };
const EST = [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023], HOLDOUT = [2024, 2025];
const DRAWS = 400, BOOT = 2000;
const TAUS: number[] = []; for (let i = 0; i <= 80; i++) TAUS.push(i / 10);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** per (season:week) cell: for each tau [emp, sim, n] sums over FBS teams */
export function winTotalCells(rows: ReplayRow[], mode: 'decomposed' | 'additive' = 'decomposed'): Map<string, Float64Array> {
  const byCell = new Map<string, ReplayRow[]>();
  for (const x of rows) if (x[1] === 1) { const k = x[0] + ':' + x[2]; let a = byCell.get(k); if (!a) { a = []; byCell.set(k, a); } a.push(x); }
  const out = new Map<string, Float64Array>();
  for (const [k, games] of byCell) {
    const [s, w] = k.split(':').map(Number);
    const teams = [...new Set(games.flatMap((g) => [g[6] ? g[4] : null, g[7] ? g[5] : null]).filter((t): t is string => !!t))].sort();
    const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t] = i; });
    const C = teams.length, actual = new Float64Array(C);
    for (const g of games) {
      const hw = g[12] > 0 ? 1 : 0;
      if (g[6]) actual[ix[g[4]]] += hw;
      if (g[7]) actual[ix[g[5]]] += 1 - hw;
    }
    const rng = streamFor(BigInt(s * 100 + w), 0, 96);
    const z = new Float64Array(DRAWS * C);
    for (let i = 0; i < z.length; i++) z[i] = normalQuantile(rng.nextOpen());
    const acc = new Float64Array(TAUS.length * 3);
    TAUS.forEach((tau, ti) => {
      const sum = new Float64Array(C), sum2 = new Float64Array(C);
      for (let d = 0; d < DRAWS; d++) {
        const mu = new Float64Array(C), v = new Float64Array(C);
        for (const g of games) {
          const h = g[6] ? ix[g[4]] : -1, a = g[7] ? ix[g[5]] : -1;
          const off = tau * ((h >= 0 ? z[d * C + h] : 0) - (a >= 0 ? z[d * C + a] : 0));
          const k = (h >= 0 ? 1 : 0) + (a >= 0 ? 1 : 0);
          const sd = mode === 'decomposed' ? gameNoiseSd(g[10], tau, k) : g[10];
          const p = normalCdf((g[9] + off) / sd), vv = p * (1 - p);
          if (h >= 0) { mu[h] += p; v[h] += vv; }
          if (a >= 0) { mu[a] += 1 - p; v[a] += vv; }
        }
        for (let i = 0; i < C; i++) { sum[i] += mu[i]; sum2[i] += mu[i] * mu[i] + v[i]; }
      }
      let emp = 0, sim = 0;
      for (let i = 0; i < C; i++) { const m = sum[i] / DRAWS; emp += (actual[i] - m) ** 2; sim += sum2[i] / DRAWS - m * m; }
      acc[ti * 3] = emp; acc[ti * 3 + 1] = sim; acc[ti * 3 + 2] = C;
    });
    out.set(k, acc);
  }
  return out;
}
/** the game-noise sd that keeps the engine's marginal Normal(fair, sigma^2): sqrt(sigma^2 - k tau^2) */
export function gameNoiseSd(sigma: number, tau: number, k: number): number {
  const v = sigma * sigma - k * tau * tau;
  if (!(v > 0)) throw new Error('strength tau ' + tau + ' leaves no game noise inside sigma ' + sigma + ' (k = ' + k + ')');
  return Math.sqrt(v);
}
function pooled(cells: Map<string, Float64Array>, seasons: number[], weeks: number[]): Float64Array {
  const acc = new Float64Array(TAUS.length * 3);
  for (const s of seasons) for (const w of weeks) { const o = cells.get(s + ':' + w); if (o) for (let i = 0; i < acc.length; i++) acc[i] += o[i]; }
  return acc;
}
/** tau where simulated variance = empirical mean squared deviation (0 when already over-dispersed at tau 0) */
export function solveTau(acc: Float64Array): number {
  const f = (i: number) => (acc[i * 3 + 1] - acc[i * 3]) / acc[i * 3 + 2];
  if (f(0) >= 0) return 0;
  for (let i = 1; i < TAUS.length; i++) if (f(i) >= 0) { const a = f(i - 1), b = f(i); return TAUS[i - 1] + (TAUS[i] - TAUS[i - 1]) * (-a) / (b - a); }
  return TAUS[TAUS.length - 1];
}
function at(acc: Float64Array, tau: number) {
  const i = Math.min(TAUS.length - 2, Math.floor(tau * 10)), t = tau * 10 - i;
  const g = (o: number) => (1 - t) * acc[i * 3 + o] / acc[i * 3 + 2] + t * acc[(i + 1) * 3 + o] / acc[(i + 1) * 3 + 2];
  return { emp: r6(g(0)), sim: r6(g(1)), n: acc[i * 3 + 2] };
}

/** favourite-bucket reliability of a probability column over frozen FBS-vs-FBS rows */
export function reliability(rows: ReplayRow[], prob: (r: ReplayRow) => number) {
  const B = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.0000001];
  return B.slice(0, -1).map((lo, i) => {
    const hi = B[i + 1], s = rows.filter((r) => { const p = prob(r), f = Math.max(p, 1 - p); return f >= lo && f < hi; });
    if (!s.length) return { bucket: [lo, Math.min(1, hi)], n: 0 };
    const pred = s.reduce((a, r) => { const p = prob(r); return a + Math.max(p, 1 - p); }, 0) / s.length;
    const won = s.filter((r) => (r[12] > 0) === (prob(r) >= 0.5)).length, w = wilson(won, s.length);
    return { bucket: [lo, Math.min(1, hi)], n: s.length, predicted: r6(pred), won: r6(won / s.length), wilson95: [r6(w.lo), r6(w.hi)],
      verdict: pred > w.hi ? 'OVERCONFIDENT' : pred < w.lo ? 'UNDERCONFIDENT' : 'within interval' };
  });
}

function main() {
  const R = cachedReplay(REPLAY, (s) => process.stderr.write(s + '\n'));
  const cells = winTotalCells(R.rows, 'decomposed');
  const additive = winTotalCells(R.rows, 'additive');
  const out: Record<string, any> = {};
  const rng = streamFor(20261023n, 0, 95);
  for (const w of REPLAY.asOfWeeks) {
    const acc = pooled(cells, EST, [w]), tau = solveTau(acc);
    const bs: number[] = [];
    for (let b = 0; b < BOOT; b++) { const res: number[] = []; for (let i = 0; i < EST.length; i++) res.push(EST[rng.nextInt(EST.length)]); bs.push(solveTau(pooled(cells, res, [w]))); }
    bs.sort((a, b) => a - b);
    const ho = pooled(cells, HOLDOUT, [w]);
    out[w] = { tau: r6(tau), tau_ci95: [r6(bs[Math.floor(0.025 * BOOT)]), r6(bs[Math.floor(0.975 * BOOT)])],
      estimation: { at_tau: at(acc, tau), at_zero: at(acc, 0) },
      holdout: { seasons: HOLDOUT, at_tau: at(ho, tau), at_zero: at(ho, 0), tau_fitted_on_holdout_for_reference_only: r6(solveTau(ho)) },
      per_season_tau: Object.fromEntries([...EST, ...HOLDOUT].map((s) => [s, r6(solveTau(pooled(cells, [s], [w])))])),
      additive_alternative: { tau: r6(solveTau(pooled(additive, EST, [w]))), note: 'tau stacked on top of sigma (rejected: per-game probabilities become underconfident)' } };
  }
  /* per-game reliability: the decomposed simulator's per-game probability IS the
     engine's; the additive alternative is scored beside it */
  const tau7 = out[7].additive_alternative.tau;
  const frozen = R.rows.filter((x) => x[1] === 1 && x[6] === 1 && x[7] === 1 && x[0] !== 2020);
  const fcs = R.rows.filter((x) => x[1] === 1 && (x[6] === 0 || x[7] === 0));
  const withTau = (r: ReplayRow) => normalCdf(r[9] / Math.sqrt(r[10] * r[10] + 2 * tau7 * tau7));
  const fcsTau = (r: ReplayRow) => normalCdf(r[9] / Math.sqrt(r[10] * r[10] + tau7 * tau7));
  const doc = {
    schema: 'edgedesk_sim_cfb_strength_uncertainty_v1',
    generated_by: 'simulator/src/research/cfb_strength_uncertainty.ts',
    model_version: R.model_version,
    replay: { ...REPLAY, replay_from: REPLAY.from - 8, method: 'cfb_replay.ts: football/cfb_p4 engine cold walk-forward (backtest_engine.js), frozen after regular-season week K', rows: R.rows.length, refused: R.refused },
    method: 'win-total calibration: tau where pooled simulated variance of remaining wins equals pooled mean squared deviation of actual remaining wins from the simulated mean; ' + DRAWS + ' offset draws per cell (common random numbers), tau grid 0-8 by 0.1, linear interpolation; season bootstrap ' + BOOT,
    estimation_seasons: EST, holdout_seasons: HOLDOUT, excluded: { 2020: 'shortened, irregular season (cancellations, conference-only schedules)' },
    by_as_of_week: out,
    production: { model: 'margin = fair + d_home - d_away + e; d ~ Normal(0, tau^2) per team per run; e ~ Normal(0, sigma^2 - k tau^2) per game (k FBS sides)',
      as_of_week_rule: 'the nearest studied as-of week at or below the snapshot\'s as-of week (4, 7, 10)', distribution: 'normal', fcs_offset: 'none (FCS opponents are priced at the engine\'s single FCS floor rating)' },
    per_game_calibration: {
      note: 'frozen forecasts 2014-2025 (2020 excluded), favourite perspective. The decomposed simulator\'s per-game probability equals the engine\'s (exact for a normal margin), so `simulator` is the engine column; `additive_alternative` is Phi(f / sqrt(sigma^2 + k tau_add^2)) with the additive fit\'s week-7 tau',
      simulator_fbs: reliability(frozen, (r) => r[11]),
      simulator_fcs: reliability(fcs, (r) => r[11]),
      additive_alternative_tau: tau7,
      additive_alternative_fbs: reliability(frozen, withTau),
      additive_alternative_fcs: reliability(fcs, fcsTau)
    }
  };
  fs.writeFileSync(CFB_STRENGTH_FILE, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, CFB_STRENGTH_FILE) + ' sha256 ' + sha256Hex(fs.readFileSync(CFB_STRENGTH_FILE)).slice(0, 16));
  for (const w of REPLAY.asOfWeeks) console.log('as-of week ' + w + ': tau ' + out[w].tau + ' CI ' + out[w].tau_ci95.join('-') + ' · est emp/sim@tau ' + out[w].estimation.at_tau.emp + '/' + out[w].estimation.at_tau.sim + ' sim@0 ' + out[w].estimation.at_zero.sim + ' · holdout emp ' + out[w].holdout.at_tau.emp + ' sim ' + out[w].holdout.at_tau.sim);
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('research', 'cfb_strength_uncertainty.ts'));
if (isMain) main();

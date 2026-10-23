/* ===========================================================================
   HOW WRONG IS A FROZEN NBA FORECAST OF THE REST OF A SEASON? — the evidence
   behind the simulator's persistent per-club strength offsets.

   A season simulation prices every remaining game from the states frozen at
   the as-of time. Whatever is wrong with a club's frozen strength is wrong in
   ALL of its remaining games at once: that shared error is what makes a
   club's simulated games move together, and what the persistent offset
   d_t ~ Normal(0, sigma^2) (points of margin) represents. Game-to-game
   randomness is separate: it is the served model's own margin distribution.

   EVIDENCE: the frozen forecasts of nba_frozen_forecasts.ts — season S,
   as-of point g (the league has played 15·g games), every remaining
   regular-season game priced out of sample from the frozen pass — for
   2009-10..2025-26 (2019-20 and 2020-21 excluded) at g = 1, 10, 20, 41, 61.

   WIN-TOTAL CALIBRATION (the production sigma, as the NFL's): per club and
   cell, D = actual remaining wins - the simulated expectation; sigma is the
   value at which the mean simulated variance of remaining wins equals the
   mean of D^2 over the estimation seasons (grid 0-8 by 0.1, linear between
   grid points, common random numbers, DRAWS per cell). The simulation it is
   calibrated for is the production one: return trajectories ON (each tracked
   absence's return drawn from the hazards fitted on seasons before S, the
   served player model's value of each subset), ratings frozen. The same with
   returns OFF is reported beside it, and so is the mean squared deviation of
   the two regimes' expectations at sigma 0 (does modelling returns move
   the frozen forecasts closer to what happened?).
   Uncertainty: a bootstrap over SEASONS (BOOT resamples). Holdout: 2024-25
   and 2025-26, reported separately (never in the estimate).

     node simulator/src/research/nba_strength_uncertainty.ts
   Output (committed): simulator/data/nba_strength_uncertainty.json
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, nbaModules } from '../sports/nba/model_adapter.ts';
import { NbaGameDist } from '../sports/nba/game_dist.ts';
import { estimateHazards, returnDistribution, type HazardTable } from '../sports/nba/availability.ts';
import { FROZEN_DIR, STUDY_SEASONS, AS_OF_POINTS } from './nba_frozen_forecasts.ts';
import { hazardSeasons } from './nba_return_hazards.ts';
import { streamFor } from '../core/prng.ts';
import { normalQuantile } from '../core/normal.ts';
import { sha256Hex } from '../core/canonical.ts';

const OUT = path.join(REPO, 'simulator', 'data', 'nba_strength_uncertainty.json');
const HOLDOUT = [2025, 2026];
const EST = STUDY_SEASONS.filter((s) => !HOLDOUT.includes(s));
const DRAWS = 300, BOOT = 2000;
const GRID = Array.from({ length: 81 }, (_, i) => i / 10);
const round = (v: number, k = 6) => Math.round(v * 10 ** k) / 10 ** k;

/** per club of one (season, as-of) cell: D^2 and V(sigma) on the grid, for one availability regime */
interface CellOut { season: number; g: number; team: string; d2: number; d2Zero: number; V: number[] }

function cell(file: string, H: HazardTable | null): CellOut[] {
  const fz = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dist = new NbaGameDist({ calibration: { sd_m: fz.params.calibration_sd_m }, shape: fz.params.shape, ot: fz.params.ot });
  const teams = Object.keys(fz.teams).sort(); const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t] = i; });
  const T = teams.length;
  const games = (fz.games as any[]).slice().sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const actual = new Float64Array(T);
  for (const g of games) actual[g.hs > g.as ? ix[g.home] : ix[g.away]]++;
  /* return plans: tracked absences with their distributions over the club's remaining games */
  const remaining = new Int32Array(T); for (const g of games) { remaining[ix[g.home]]++; remaining[ix[g.away]]++; }
  const tracked = teams.map((t, i) => {
    const e = fz.teams[t];
    if (!H) return [];
    return (e.absent as any[]).filter((a) => e.tracked.includes(a.p)).map((a) => returnDistribution(H, a, remaining[i], 'study'));
  });
  const sub = teams.map((t) => fz.teams[t].subsets as { net: number[]; full: number[] });
  const W = new Float64Array(T), Vb = new Float64Array(T);
  const sumW = GRID.map(() => new Float64Array(T)), sumW2 = GRID.map(() => new Float64Array(T)), sumV = GRID.map(() => new Float64Array(T));
  const zeroW = new Float64Array(T);
  const played = new Int32Array(T);
  const rs = streamFor(BigInt(fz.season * 100 + fz.as_of_games), 0, 1), ra = streamFor(BigInt(fz.season * 100 + fz.as_of_games), 0, 7);
  for (let b = 0; b < DRAWS; b++) {
    const z = new Float64Array(T); for (let t = 0; t < T; t++) z[t] = normalQuantile(rs.nextOpen());
    /* one return draw per tracked absence, shared by every sigma of this draw (common random numbers) */
    const ret = tracked.map((ds) => ds.map((d) => { let u = ra.nextDouble(); for (const p of d.periods) { u -= p.probability; if (u < 0) return p.period; } return Infinity; }));
    for (let gi = 0; gi < GRID.length; gi++) {
      const s = GRID[gi];
      W.fill(0); Vb.fill(0); played.fill(0);
      for (const g of games) {
        const h = ix[g.home], a = ix[g.away]; played[h]++; played[a]++;
        let sft = 0;
        if (H) {
          let mh = 0, ma = 0;
          ret[h].forEach((r, k) => { if (played[h] >= r) mh |= 1 << k; }); ret[a].forEach((r, k) => { if (played[a] >= r) ma |= 1 << k; });
          if (mh || ma) {
            const dnh = sub[h].net[mh] - sub[h].net[0], dfh = sub[h].full[mh] - sub[h].full[0], dna = sub[a].net[ma] - sub[a].net[0], dfa = sub[a].full[ma] - sub[a].full[0];
            sft = g.s_plr * g.pace * (dnh - dna) / 100 + g.s_adj * g.pace * ((dnh - dfh) - (dna - dfa)) / 100;
          }
        }
        const p = dist.pHome(g.mu + s * (z[h] - z[a]) + sft);
        W[h] += p; W[a] += 1 - p; Vb[h] += p * (1 - p); Vb[a] += p * (1 - p);
      }
      for (let t = 0; t < T; t++) { sumW[gi][t] += W[t]; sumW2[gi][t] += W[t] * W[t]; sumV[gi][t] += Vb[t]; }
      if (gi === 0) for (let t = 0; t < T; t++) zeroW[t] += W[t];
    }
  }
  return teams.map((t, i) => {
    const V = GRID.map((_, gi) => { const m = sumW[gi][i] / DRAWS; return sumV[gi][i] / DRAWS + (sumW2[gi][i] / DRAWS - m * m); });
    const e0 = zeroW[i] / DRAWS;
    return { season: fz.season, g: fz.as_of_games, team: t, d2: (actual[i] - sumW[0][i] / DRAWS) ** 2, d2Zero: (actual[i] - e0) ** 2, V };
  });
}

function solve(cells: CellOut[]): { sigma: number; msd: number; vAt: (s: number) => number; v0: number } {
  const msd = cells.reduce((u, c) => u + c.d2, 0) / cells.length;
  const v = GRID.map((_, gi) => cells.reduce((u, c) => u + c.V[gi], 0) / cells.length);
  let sigma = NaN;
  if (msd <= v[0]) sigma = 0;
  else for (let i = 0; i + 1 < GRID.length; i++) if (v[i] <= msd && msd <= v[i + 1]) { sigma = GRID[i] + (msd - v[i]) / (v[i + 1] - v[i]) * (GRID[i + 1] - GRID[i]); break; }
  if (!Number.isFinite(sigma)) sigma = GRID[GRID.length - 1];
  const vAt = (s: number) => { const x = s * 10, i = Math.min(GRID.length - 2, Math.floor(x)); return v[i] + (x - i) * (v[i + 1] - v[i]); };
  return { sigma, msd, vAt, v0: v[0] };
}

function main() {
  const { D } = nbaModules();
  const hz = new Map<number, HazardTable>();
  const haz = (S: number) => { if (!hz.has(S)) hz.set(S, estimateHazards(D, hazardSeasons(S))); return hz.get(S)!; };
  const byPoint: any[] = [];
  const files: Record<string, string> = {};
  for (const g of AS_OF_POINTS) {
    const on: CellOut[] = [], off: CellOut[] = [];
    for (const S of STUDY_SEASONS) {
      const f = path.join(FROZEN_DIR, S + '_' + g + '.json');
      if (!fs.existsSync(f)) throw new Error('missing frozen forecasts ' + path.relative(REPO, f) + ': run node simulator/src/research/nba_frozen_forecasts.ts --all');
      files[S + '_' + g] = sha256Hex(fs.readFileSync(f));
      on.push(...cell(f, haz(S))); off.push(...cell(f, null));
      console.error('[nba sigma] ' + S + ':' + g);
    }
    const est = (cs: CellOut[]) => cs.filter((c) => EST.includes(c.season)), hold = (cs: CellOut[]) => cs.filter((c) => HOLDOUT.includes(c.season));
    const main_ = solve(est(on)), offS = solve(est(off));
    /* season bootstrap of the production sigma */
    const rng = streamFor(20261023n + BigInt(g), 0, 9);
    const sig: number[] = [];
    for (let b = 0; b < BOOT; b++) {
      const pick: CellOut[] = []; for (let i = 0; i < EST.length; i++) { const s = EST[rng.nextInt(EST.length)]; pick.push(...on.filter((c) => c.season === s)); }
      sig.push(solve(pick).sigma);
    }
    sig.sort((a, b) => a - b);
    const ci: [number, number] = [sig[Math.floor(0.025 * (BOOT - 1))], sig[Math.floor(0.975 * (BOOT - 1))]];
    const h = hold(on), ho = solve(h);
    byPoint.push({ as_of_games: g,
      win_total_calibration: { sigma: round(main_.sigma), sigma_ci95: [round(ci[0]), round(ci[1])], regime: 'production: return trajectories ON, ratings frozen', empirical_msd: round(main_.msd), simulated_var: round(main_.vAt(main_.sigma)), simulated_var_at_zero: round(main_.v0), n_club_cells: est(on).length, draws_per_cell: DRAWS, sigma_grid: '0 to 8 by 0.1, linear interpolation', bootstrap: BOOT + ' season resamples' },
      returns_off: { sigma: round(offS.sigma), empirical_msd: round(offS.msd), simulated_var_at_zero: round(offS.v0) },
      returns_effect_at_zero: { msd_returns_on: round(est(on).reduce((u, c) => u + c.d2Zero, 0) / est(on).length), msd_returns_off: round(est(off).reduce((u, c) => u + c.d2Zero, 0) / est(off).length), note: 'mean squared deviation of actual remaining wins from the sigma-0 expectation; lower is closer to what happened' },
      holdout: { seasons: HOLDOUT, empirical_msd: round(ho.msd), simulated_var_at_estimation_sigma: round(ho.vAt(main_.sigma)), simulated_var_at_zero: round(ho.v0), sigma_that_would_fit: round(ho.sigma), n_club_cells: h.length } });
    console.error('[nba sigma] g ' + g + ': sigma ' + main_.sigma.toFixed(3) + ' CI ' + ci.map((x) => x.toFixed(3)).join('-') + ' (returns off ' + offS.sigma.toFixed(3) + ')');
  }
  const doc = { schema: 'edgedesk_nba_strength_uncertainty_v1', generated_at: new Date().toISOString(),
    served_model: { chosen: 'E_ridge_P', parameters: 'rebuilt out of sample per season (simulator/src/sports/nba/model_adapter.ts seasonParams)' },
    method: 'win-total calibration of one persistent normal offset per club (points of margin), on frozen out-of-sample forecasts; see the file header of simulator/src/research/nba_strength_uncertainty.ts',
    estimation_seasons: EST, holdout_seasons: HOLDOUT, by_as_of: byPoint,
    code_sha256: Object.fromEntries(['simulator/src/research/nba_strength_uncertainty.ts', 'simulator/src/research/nba_frozen_forecasts.ts', 'simulator/src/sports/nba/availability.ts', 'simulator/src/sports/nba/game_dist.ts'].map((f) => [f, sha256Hex(fs.readFileSync(path.join(REPO, f)))])),
    frozen_sha256: files };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, OUT));
}
main();

/* ===========================================================================
   NHL STRENGTH UNCERTAINTY — the persistent per-club offset's sigma.

     node simulator/src/research/nhl_strength_uncertainty.ts [--check]

   The season simulator draws ONE offset per club per run, d ~ Normal(0, σ²)
   on the log scale of the goal rate (model_adapter.ts offsetRates), and keeps
   it through every remaining game and the postseason. It stands for what the
   frozen ratings do not know about a club's true strength; game randomness is
   the served score distribution itself.

   DATA. Frozen forecasts (nhl_replay.ts frozenForecasts) of every remaining
   regular-season game at checkpoints of 10, 20, 30, 41, 55 and 70 games
   played (2020-21: up to 41 of 56), seasons 2013-14 .. 2018-19 and
   2020-21 .. 2024-25 for estimation, 2025-26 held out. 2019-20 is excluded
   (the season stopped; its remaining games were never played). Each game is
   priced by the distribution the simulator uses
   (simulator/data/nhl_goal_distribution.json decision).

   RULES (written before the first run):
     Pricing variant: of `asof` (ratings read at the as-of day) and
     `game_date` (ratings decayed to each game's date), the one with the
     lower mean squared error of remaining points over the estimation
     seasons, all checkpoints pooled.
     Production σ at a checkpoint: the σ at which the simulated variance of a
     club's remaining points (persistent offsets + game randomness) equals
     the estimation seasons' mean squared deviation of actual remaining points
     from the σ = 0 forecast, after removing each season-checkpoint's
     league-wide mean residual (the loser points the served distribution
     under-prices are common to every club; they are not strength
     uncertainty) and correcting that centring by n/(n−1). σ grid 0-0.30 by
     0.01, 300 offset draws per cell with common random numbers, linear
     interpolation between grid points. 95% interval: 2,000 season-bootstrap
     resamples. A σ below the grid floor is 0 (the model alone is already as
     dispersed as history).

   Writes simulator/data/nhl_strength_uncertainty.json.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkforwardReplay, frozenForecasts, type Frozen } from './nhl_replay.ts';
import { OutcomeTable, tieSplit, offsetRates, liveParamsHash, type DistParams } from '../sports/nhl/model_adapter.ts';
import { streamFor, STREAM } from '../core/prng.ts';
import { normalQuantile } from '../core/normal.ts';
import { sha256Hex } from '../core/canonical.ts';
import { REPO } from '../sports/nfl/model_adapter.ts';
import { GOAL_STUDY_FILE } from './nhl_goal_distribution.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STRENGTH_STUDY_FILE = path.join(SIM, 'data', 'nhl_strength_uncertainty.json');
export const ESTIMATION = [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025];
export const HOLDOUT = [2026];
export const CHECKPOINTS = [10, 20, 30, 41, 55, 70];
const SIGMAS = Array.from({ length: 31 }, (_, i) => i / 100);
const DRAWS = 300, BOOT = 2000;
const r = (v: number, d = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

interface Cell { season: number; g: number; teams: string[]; e0: number[]; v0: number[]; actual: number[]; vSim: number[] /* per sigma, summed over clubs */ }

/** per-club expected remaining points and variance under one set of offsets */
function clubMoments(fr: Frozen, tab: OutcomeTable, dp: DistParams, idx: Record<string, number>, off: Float64Array | null, E: Float64Array, V: Float64Array) {
  E.fill(0); V.fill(0);
  for (const x of fr.remaining) {
    const h = idx[x.home], a = idx[x.away];
    const [lh, la] = off ? offsetRates(x.lh, x.la, off[h], off[a]) : [x.lh, x.la];
    const p = tab.probs(lh, la, false), s = tieSplit(dp, lh, la, false);
    const hw = p.home + p.tie * (s.ot_home + s.so_home), aw = 1 - hw;
    const h1 = p.tie * (s.ot_away + s.so_away), a1 = p.tie * (s.ot_home + s.so_home);
    const eh = 2 * hw + h1, ea = 2 * aw + a1;
    E[h] += eh; V[h] += 4 * hw + h1 - eh * eh;
    E[a] += ea; V[a] += 4 * aw + a1 - ea * ea;
  }
}

export function runStudy(log: (s: string) => void = console.log) {
  const t0 = Date.now();
  const goal = JSON.parse(fs.readFileSync(GOAL_STUDY_FILE, 'utf8'));
  const adopted = !!goal.decision.adopted;
  const deltaOf = (S: number) => (adopted ? goal.delta_by_season[S].delta : 0);
  const rep = walkforwardReplay(2026);
  const seasons = ESTIMATION.concat(HOLDOUT);
  const tables = new Map<number, { tab: OutcomeTable; dp: DistParams }>();
  const tableFor = (S: number) => {
    if (!tables.has(S)) { const dp: DistParams = { effects: rep.P[S].effects, ot: rep.P[S].ot, draw_inflation: deltaOf(S) }; tables.set(S, { tab: new OutcomeTable(dp), dp }); }
    return tables.get(S)!;
  };
  const variants: Array<'asof' | 'game_date'> = ['asof', 'game_date'];
  const frozen: Record<string, Frozen[]> = {};
  for (const v of variants) frozen[v] = frozenForecasts(rep, seasons, CHECKPOINTS, v).filter((f) => f.season !== 2021 || f.checkpoint <= 41);
  log('frozen forecasts built (' + frozen.asof.length + ' cells per variant) in ' + (Date.now() - t0) + ' ms');
  /* actual remaining points per club */
  const actualOf = (fr: Frozen, teams: string[]) => {
    const pts: Record<string, number> = Object.fromEntries(teams.map((t) => [t, 0]));
    for (const x of fr.remaining) { const w = x.hw === 1 ? x.home : x.away, l = x.hw === 1 ? x.away : x.home; pts[w] += 2; if (x.decided !== 'REG') pts[l] += 1; }
    return teams.map((t) => pts[t]);
  };
  /* 1 the pricing variant: MSE of remaining points at sigma 0, estimation seasons */
  const mse: Record<string, { mse: number; mse_centred: number; n: number; mean_residual: number }> = {};
  const base: Record<string, Cell[]> = {};
  for (const v of variants) {
    let s2 = 0, s2c = 0, n = 0, sr = 0;
    base[v] = frozen[v].map((fr) => {
      const teams = Object.keys(fr.points_so_far).sort(), idx = Object.fromEntries(teams.map((t, i) => [t, i]));
      const { tab, dp } = tableFor(fr.season);
      const E = new Float64Array(teams.length), V = new Float64Array(teams.length);
      clubMoments(fr, tab, dp, idx, null, E, V);
      const actual = actualOf(fr, teams);
      if (ESTIMATION.includes(fr.season)) {
        const res = actual.map((x, i) => x - E[i]), m = res.reduce((a, b) => a + b, 0) / res.length;
        res.forEach((e) => { s2 += e * e; s2c += (e - m) * (e - m) * teams.length / (teams.length - 1); sr += e; n++; });
      }
      return { season: fr.season, g: fr.checkpoint, teams, e0: Array.from(E), v0: Array.from(V), actual, vSim: [] };
    });
    mse[v] = { mse: s2 / n, mse_centred: s2c / n, n, mean_residual: sr / n };
  }
  const chosen = mse.asof.mse <= mse.game_date.mse ? 'asof' : 'game_date';
  log('variant MSE ' + JSON.stringify(mse) + ' -> ' + chosen);
  /* 2 simulated variance per sigma (common random numbers) */
  const cells = base[chosen];
  const fz = frozen[chosen];
  cells.forEach((c, ci) => {
    const fr = fz[ci];
    const idx = Object.fromEntries(c.teams.map((t, i) => [t, i]));
    const { tab, dp } = tableFor(fr.season);
    const nT = c.teams.length;
    const z: Float64Array[] = [];
    for (let d = 0; d < DRAWS; d++) { const rs = streamFor(0x5eedn, d, STREAM.strength); const v = new Float64Array(nT); for (let t = 0; t < nT; t++) v[t] = normalQuantile(rs.nextOpen()); z.push(v); }
    const E = new Float64Array(nT), V = new Float64Array(nT), off = new Float64Array(nT);
    c.vSim = SIGMAS.map((sg) => {
      if (sg === 0) return c.v0.reduce((a, b) => a + b, 0);
      const sumE = new Float64Array(nT), sumE2 = new Float64Array(nT), sumV = new Float64Array(nT);
      for (let d = 0; d < DRAWS; d++) {
        for (let t = 0; t < nT; t++) off[t] = sg * z[d][t];
        clubMoments(fr, tab, dp, idx, off, E, V);
        for (let t = 0; t < nT; t++) { sumE[t] += E[t]; sumE2[t] += E[t] * E[t]; sumV[t] += V[t]; }
      }
      let tot = 0;
      for (let t = 0; t < nT; t++) { const m = sumE[t] / DRAWS; tot += sumV[t] / DRAWS + (sumE2[t] / DRAWS - m * m); }
      return tot;
    });
  });
  log('simulated variances computed in ' + (Date.now() - t0) + ' ms');
  /* 3 sigma per checkpoint, with a season bootstrap */
  const solve = (vs: number[], target: number) => {
    if (vs[0] >= target) return 0;
    for (let i = 1; i < vs.length; i++) if (vs[i] >= target) return SIGMAS[i - 1] + (SIGMAS[i] - SIGMAS[i - 1]) * (target - vs[i - 1]) / (vs[i] - vs[i - 1]);
    return NaN;
  };
  const sums = (seasonList: number[], g: number) => {
    const vs = new Array(SIGMAS.length).fill(0); let sq = 0, sqRaw = 0, n = 0;
    for (const S of seasonList) {
      const c = cells.find((x) => x.season === S && x.g === g); if (!c) continue;
      const res = c.actual.map((x, i) => x - c.e0[i]), m = res.reduce((a, b) => a + b, 0) / res.length;
      res.forEach((e) => { sq += (e - m) * (e - m) * c.teams.length / (c.teams.length - 1); sqRaw += e * e; n++; });
      c.vSim.forEach((v, i) => { vs[i] += v; });
    }
    return { vs: vs.map((v) => v / n), target: sq / n, targetRaw: sqRaw / n, n };
  };
  const table = CHECKPOINTS.map((g) => {
    const est = sums(ESTIMATION, g);
    const sigma = solve(est.vs, est.target), sigmaRaw = solve(est.vs, est.targetRaw);
    const rng = streamFor(0xb007n, g, STREAM.strength);
    const boot: number[] = [];
    for (let b = 0; b < BOOT; b++) {
      const pick = ESTIMATION.map(() => ESTIMATION[rng.nextInt(ESTIMATION.length)]);
      const s = sums(pick, g); const x = solve(s.vs, s.target); if (Number.isFinite(x)) boot.push(x);
    }
    boot.sort((a, b) => a - b);
    const q = (p: number) => boot[Math.min(boot.length - 1, Math.max(0, Math.floor(p * boot.length)))];
    const hold = sums(HOLDOUT, g);
    const at = (vs: number[], s: number) => { if (!Number.isFinite(s)) return NaN; const i = Math.min(SIGMAS.length - 2, Math.floor(s / 0.01)); const f = (s - SIGMAS[i]) / 0.01; return vs[i] + f * (vs[i + 1] - vs[i]); };
    /* slope of actual on forecast remaining points, centred within season */
    let sxy = 0, sxx = 0;
    for (const S of ESTIMATION) { const c = cells.find((x) => x.season === S && x.g === g); if (!c) continue; const me = c.e0.reduce((a, b) => a + b, 0) / c.e0.length, ma = c.actual.reduce((a, b) => a + b, 0) / c.actual.length; c.e0.forEach((e, i) => { sxy += (e - me) * (c.actual[i] - ma); sxx += (e - me) * (e - me); }); }
    return {
      checkpoint_games_played: g, club_seasons: est.n,
      sigma: r(sigma), sigma_ci95: [r(q(0.025)), r(q(0.975))], bootstrap_valid: boot.length,
      sigma_uncentred: r(sigmaRaw),
      empirical_msd_centred: r(est.target, 3), empirical_msd: r(est.targetRaw, 3),
      simulated_variance_at_sigma0: r(est.vs[0], 3), simulated_variance_at_sigma: r(at(est.vs, sigma), 3),
      slope_actual_on_forecast: r(sxy / sxx, 4),
      holdout: { seasons: HOLDOUT, club_seasons: hold.n, empirical_msd_centred: r(hold.target, 3), simulated_variance_at_sigma: r(at(hold.vs, sigma), 3), simulated_variance_at_sigma0: r(hold.vs[0], 3) }
    };
  });
  const file = (p: string) => sha256Hex(fs.readFileSync(path.join(REPO, p)));
  return {
    schema: 'edgedesk_sim_nhl_strength_uncertainty_v1',
    generated_at: new Date().toISOString(),
    model: { id: 'edgedesk_nhl_v1:xg_core', live_params_sha256: file('hockey/model/params/live.json'), live_params_model_sha256: liveParamsHash(), distribution: adopted ? 'served + walk-forward draw inflation' : 'served (no draw inflation)', goal_study_sha256: sha256Hex(fs.readFileSync(GOAL_STUDY_FILE)) },
    method: 'One persistent offset per club per run on the log goal rate (λH·exp((dH−dA)/2)); σ by variance matching of remaining points against frozen-forecast residuals (centred per season-checkpoint, n/(n−1)); 300 common-random-number offset draws per σ cell; σ grid 0-0.30 by 0.01; 2,000-resample season bootstrap.',
    estimation_seasons: ESTIMATION, holdout_seasons: HOLDOUT, excluded: { 2020: 'the 2019-20 season stopped; remaining games never played' },
    pricing_variant: { rule: 'lower pooled MSE of remaining points at σ = 0, estimation seasons', mse: Object.fromEntries(Object.entries(mse).map(([k, v]) => [k, { mse: r(v.mse, 3), mse_centred: r(v.mse_centred, 3), mean_residual: r(v.mean_residual, 4), club_checkpoints: v.n }])), chosen },
    by_checkpoint: table,
    code: { replay_ts: file('simulator/src/research/nhl_replay.ts'), study_ts: file('simulator/src/research/nhl_strength_uncertainty.ts'), distribution_js: file('hockey/model/distribution.js'), ratings_js: file('hockey/model/ratings.js') },
    runtime_ms: Date.now() - t0
  };
}

/** the production σ for an as-of point (mean games played per club): linear between checkpoints, flat outside */
export function sigmaAt(study: any, gamesPlayed: number): { sigma: number; ci95: [number, number]; checkpoint: string } {
  const t = study.by_checkpoint as Array<{ checkpoint_games_played: number; sigma: number; sigma_ci95: [number, number] }>;
  if (gamesPlayed <= t[0].checkpoint_games_played) return { sigma: t[0].sigma, ci95: t[0].sigma_ci95, checkpoint: 'at or before ' + t[0].checkpoint_games_played + ' games' };
  for (let i = 1; i < t.length; i++) if (gamesPlayed <= t[i].checkpoint_games_played) {
    const a = t[i - 1], b = t[i], f = (gamesPlayed - a.checkpoint_games_played) / (b.checkpoint_games_played - a.checkpoint_games_played);
    const lerp = (x: number, y: number) => x + f * (y - x);
    return { sigma: lerp(a.sigma, b.sigma), ci95: [lerp(a.sigma_ci95[0], b.sigma_ci95[0]), lerp(a.sigma_ci95[1], b.sigma_ci95[1])], checkpoint: 'between ' + a.checkpoint_games_played + ' and ' + b.checkpoint_games_played + ' games' };
  }
  const z = t[t.length - 1];
  return { sigma: z.sigma, ci95: z.sigma_ci95, checkpoint: 'after ' + z.checkpoint_games_played + ' games' };
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes('--check')) {
    const s = JSON.parse(fs.readFileSync(STRENGTH_STUDY_FILE, 'utf8'));
    const ok = s.schema === 'edgedesk_sim_nhl_strength_uncertainty_v1' && s.by_checkpoint.every((c: any) => Number.isFinite(c.sigma));
    console.log(ok ? 'nhl strength study: ok' : 'nhl strength study: INVALID'); process.exit(ok ? 0 : 1);
  }
  const out = runStudy();
  fs.writeFileSync(STRENGTH_STUDY_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out.pricing_variant));
  for (const c of out.by_checkpoint) console.log(JSON.stringify(c));
  console.log('runtime', out.runtime_ms, 'ms');
}

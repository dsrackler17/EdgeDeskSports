/* ===========================================================================
   HOW WRONG IS A FROZEN NFL RATING, AND FOR HOW LONG? — the evidence behind
   the simulator's per-club strength offsets.

   A season simulation prices every remaining game from the ratings as they
   stand today, frozen. Whatever is wrong with a club's frozen rating is wrong
   in ALL of its remaining games at once: that shared error is what makes a
   club's simulated games move together, and it is what the simulator's
   persistent offset represents. Game-to-game randomness is separate: it is
   already the served model's own margin distribution.

   THE ESTIMATE, from owned history only (football/research/nfl_v2/.cache,
   nflverse games + team-week + player-week, fetch_history.sh CORE=1):

   1. Replay the SERVED configuration of football/nfl_model.js
      (football/nfl_params_v2.js cfg) over every game 1999-2026 exactly as the
      v2 backtest does (football/research/nfl_v2/backtest.js replay), and
      freeze a copy of the rating state before the first game of each
      regular-season week w of each season S, 2006-2025.
   2. Price every remaining regular-season game of S from that frozen state
      with weights fitted on seasons before S only (backtest.js fit: the walk
      forward). A game in week w carries its starting quarterbacks (the live
      board knows next week's starters); a later game carries none (the live
      board prices the club's carried quarterback level), as in production.
   3. Residual r = actual home margin - frozen fair margin; from a club's side
      r_t = +-r. If e_t is club t's persistent error, two of t's remaining
      games against DIFFERENT opponents satisfy E[r_t,1 r_t,2] = Var(e_t)
      (the opponents' errors are uncorrelated with each other). So
         sigma_e^2(w) = mean over clubs, seasons and opponent-distinct pairs of
                        r_t,1 * r_t,2
      Rematches are excluded (their product also carries the opponent's
      error). Weighting is by pair.
   4. Uncertainty of sigma_e: a bootstrap over SEASONS (2000 resamples), so the
      dependence between clubs and weeks of one season is kept.
   5. Consistency check: the mean squared frozen residual should equal the
      served distribution's own variance at the frozen fair margin plus
      2 sigma_e^2 (both clubs' errors). The gap is reported, not hidden.

   2006-2024 is the estimation window; 2025 is reported separately as a
   holdout. 2026 is never used. The output is a committed artifact:
     simulator/data/nfl_strength_uncertainty.json
   Usage: node simulator/src/research/nfl_strength_uncertainty.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../sports/nfl/model_adapter.ts';
import { frozenReplay, V2 } from './nfl_replay.ts';
import { streamFor } from '../core/prng.ts';
import { normalQuantile } from '../core/normal.ts';
import { sha256Hex } from '../core/canonical.ts';

const OUT = path.join(REPO, 'simulator', 'data', 'nfl_strength_uncertainty.json');

const FIRST = 2006, LAST_EST = 2024, HOLDOUT = 2025;
const BOOT = 2000;

function main() {
  /* 1. the replay, with frozen states before each regular-season week (nfl_replay.ts) */
  const R = frozenReplay(FIRST, HOLDOUT);
  const { B, D, E, PV, cfg, fitRows, snaps } = R;

  /* 2-3. frozen forecasts, residuals, pair products, per (season, week) */
  interface Cell { sumProd: number; nPairs: number; sumR2: number; nR: number; sumPmfVar: number; nTeams: number }
  const cells: Record<string, Cell> = {};
  const winTables: Record<number, WinTable> = {};
  /* every frozen forecast, for the win-total calibration below: [season, asOfWeek, home, away, fair, margin] */
  const fz: Array<[number, number, string, string, number, number]> = [];
  const games = D.games().filter((g: any) => g.done && g.type === 'REG');
  for (let S = FIRST; S <= HOLDOUT; S++) {
    const model = B.fit(cfg, fitRows.filter((r) => r.g.season >= B.FIRST_TRAIN && r.g.season < S));
    const gS = games.filter((g: any) => g.season === S);
    const weeks: number[] = ([...new Set(gS.map((g: any) => g.week as number))] as number[]).sort((a, b) => a - b);
    const pmfVarMemo = new Map<number, number>();
    B.withTable(S, () => {
      for (const w of weeks) {
        const snap = snaps[S + ':' + w];
        if (!snap) continue;
        const frozen = JSON.parse(snap); frozen.cfg = cfg;
        const rem = gS.filter((g: any) => g.week >= w);
        const byTeam: Record<string, Array<{ opp: string; r: number }>> = {};
        let sumR2 = 0, sumPmf = 0;
        for (const g of rem) {
          const go = B.gameObj(g);
          if (g.week > w) { go.home_qb_id = null; go.away_qb_id = null; }
          const pr = R.price(frozen, model, go, g);
          const r = (g.home_score - g.away_score) - pr.margin;
          fz.push([S, w, g.home, g.away, pr.margin, g.home_score - g.away_score]);
          sumR2 += r * r;
          const key = Math.round(pr.margin * 100);
          let v = pmfVarMemo.get(key);
          if (v === undefined) { v = pmfVariance(E, key / 100); pmfVarMemo.set(key, v); }
          sumPmf += v;
          (byTeam[g.home] = byTeam[g.home] || []).push({ opp: g.away, r });
          (byTeam[g.away] = byTeam[g.away] || []).push({ opp: g.home, r: -r });
        }
        let sp = 0, np = 0;
        for (const t of Object.keys(byTeam)) {
          const L = byTeam[t];
          for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) if (L[i].opp !== L[j].opp) { sp += L[i].r * L[j].r; np++; }
        }
        cells[S + ':' + w] = { sumProd: sp, nPairs: np, sumR2, nR: rem.length, sumPmfVar: sumPmf, nTeams: Object.keys(byTeam).length };
      }
      winTables[S] = winTable(E);
    });
    process.stderr.write('season ' + S + ' done\n');
  }

  /* 4. estimates, bootstrap over seasons */
  const calib = calibrateWinTotals(fz, winTables, FIRST, LAST_EST, HOLDOUT);
  const estSeasons: number[] = []; for (let s = FIRST; s <= LAST_EST; s++) estSeasons.push(s);
  const rng = streamFor(20261023n, 0, 99);
  const est = (seasons: number[], weeks: number[]) => {
    let sp = 0, np = 0, r2 = 0, nr = 0, pv = 0;
    for (const s of seasons) for (const w of weeks) { const c = cells[s + ':' + w]; if (!c) continue; sp += c.sumProd; np += c.nPairs; r2 += c.sumR2; nr += c.nR; pv += c.sumPmfVar; }
    return { var_e: np ? sp / np : null, n_pairs: np, mse: nr ? r2 / nr : null, pmf_var: nr ? pv / nr : null, n_games: nr };
  };
  const boot = (weeks: number[]) => {
    const out: number[] = [];
    for (let b = 0; b < BOOT; b++) {
      const res: number[] = []; for (let i = 0; i < estSeasons.length; i++) res.push(estSeasons[rng.nextInt(estSeasons.length)]);
      const e = est(res, weeks); if (e.var_e != null) out.push(e.var_e);
    }
    out.sort((a, b) => a - b);
    return { lo: out[Math.floor(0.025 * out.length)], hi: out[Math.floor(0.975 * out.length)] };
  };
  const byWeek: any[] = [];
  for (let w = 1; w <= 18; w++) {
    const e = est(estSeasons, [w]);
    if (e.var_e == null) continue;
    const band = [w - 1, w, w + 1].filter((x) => x >= 1 && x <= 18);
    const eb = est(estSeasons, band), ci = boot(band), h = est([HOLDOUT], band);
    byWeek.push({
      as_of_week: w,
      raw: { var_e: r(e.var_e), n_pairs: e.n_pairs, n_games: e.n_games },
      selected: {
        smoothing: 'pooled over as-of weeks ' + band.join(','),
        var_e: r(eb.var_e as number), sigma_e: r(Math.sqrt(Math.max(0, eb.var_e as number))),
        var_e_ci95: [r(ci.lo), r(ci.hi)], sigma_e_ci95: [r(Math.sqrt(Math.max(0, ci.lo))), r(Math.sqrt(Math.max(0, ci.hi)))],
        n_pairs: eb.n_pairs, n_games: eb.n_games
      },
      consistency: {
        mse_frozen_residual: r(eb.mse as number), served_pmf_variance: r(eb.pmf_var as number),
        excess: r((eb.mse as number) - (eb.pmf_var as number)), two_var_e: r(2 * (eb.var_e as number)),
        note: 'excess = mse - pmf variance; it equals 2 var_e when the persistent error explains all forecast error beyond the served distribution'
      },
      holdout_2025: { var_e: h.var_e == null ? null : r(h.var_e), n_pairs: h.n_pairs, mse: h.mse == null ? null : r(h.mse), pmf_var: h.pmf_var == null ? null : r(h.pmf_var) },
      win_total_calibration: calib[w] || null
    });
  }
  const files = ['football/nfl_params_v2.js', 'football/nfl_model.js', 'football/engine.js', 'football/research/nfl_v2/backtest.js', 'football/research/nfl_v2/data.js'];
  const doc = {
    schema: 'edgedesk_sim_nfl_strength_uncertainty_v1',
    generated_at: new Date().toISOString(),
    served_model: { model_version: PV.model_version, config_sha: PV.config_sha },
    method: 'frozen-forecast residual covariance (simulator/src/research/nfl_strength_uncertainty.ts header)',
    estimation_seasons: [FIRST, LAST_EST], holdout_season: HOLDOUT,
    bootstrap: { resamples: BOOT, unit: 'season', seed: '20261023' },
    distribution: 'normal, mean 0, variance var_e (selected) per club per simulated season',
    code_sha256: Object.fromEntries(files.map((f) => [f, sha256Hex(fs.readFileSync(path.join(REPO, f)))])),
    data_sha256: { games_csv: sha256Hex(fs.readFileSync(path.join(V2, '.cache', 'raw', 'games.csv'))) },
    by_week: byWeek,
    per_cell: Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, { sum_prod: r(c.sumProd), n_pairs: c.nPairs, sum_r2: r(c.sumR2), n: c.nR, sum_pmf_var: r(c.sumPmfVar) }]))
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, OUT));
  for (const b of byWeek) {
    const c = b.win_total_calibration;
    console.log('week ' + String(b.as_of_week).padStart(2) + '  cov sigma_e ' + b.selected.sigma_e.toFixed(2) + ' [' + b.selected.sigma_e_ci95.map((x: number) => x.toFixed(2)).join(', ') + ']'
      + '  excess ' + b.consistency.excess.toFixed(1) + ' vs 2var_e ' + b.consistency.two_var_e.toFixed(1)
      + (c ? '  | win-total sigma ' + c.sigma.toFixed(2) + ' [' + c.sigma_ci95.map((x: number) => x.toFixed(2)).join(', ') + ']  emp ' + c.empirical_msd.toFixed(3) + ' sim@0 ' + c.simulated_var_at_zero.toFixed(3) + ' holdout emp/sim ' + c.holdout.empirical_msd.toFixed(3) + '/' + c.holdout.simulated_var.toFixed(3) : ''));
  }
}
function r(x: number): number { return Math.round(x * 1e6) / 1e6; }
/** the served distribution's variance at a fair margin, from the engine's own PMF */
function pmfVariance(E: any, fair: number): number {
  let m1 = 0, m2 = 0, prevGe = 1;
  for (let k = -90; k <= 91; k++) {
    const ge = k === -90 ? 1 : E.dist.coverProbSpread('nfl', fair, k - 0.5).win;
    if (k > -90) { const p = prevGe - ge; m1 += (k - 1) * p; m2 += (k - 1) * (k - 1) * p; }
    prevGe = ge;
  }
  return m2 - m1 * m1;
}
/* ------------------------------------------------- the win-total calibration
   The season-level quantity a simulation must get right is how far a club's
   remaining wins land from what the frozen ratings expect. For a candidate
   sigma, every club's remaining wins are simulated from the frozen fair
   margins exactly as the simulator does (a persistent normal offset per club,
   each game's win/tie/loss read from that season's served distribution at
   the shifted centre); sigma is the value at which the simulated variance of
   remaining wins equals the historical mean squared deviation of actual
   remaining wins from the simulated mean. Pooled over as-of weeks w-1..w+1
   and seasons 2006-2024; 2025 is the holdout check. */
interface WinTable { lo: number; step: number; win: Float64Array; tie: Float64Array }
function winTable(E: any): WinTable {
  const lo = -60, step = 0.01, n = 12001, win = new Float64Array(n), tie = new Float64Array(n);
  for (let i = 0; i < n; i++) { const c = E.dist.coverProbSpread('nfl', lo + i * step, 0); win[i] = c.win; tie[i] = c.push; }
  return { lo, step, win, tie };
}
function wt(T: WinTable, c: number): [number, number] {
  let i = Math.round((c - T.lo) / T.step); if (i < 0) i = 0; if (i >= T.win.length) i = T.win.length - 1;
  return [T.win[i], T.tie[i]];
}
type Fz = Array<[number, number, string, string, number, number]>;
function calibrateWinTotals(fz: Fz, tables: Record<number, WinTable>, first: number, lastEst: number, holdout: number) {
  /* cells: (season, week) -> games */
  const byCell = new Map<string, Fz>();
  for (const x of fz) { const k = x[0] + ':' + x[1]; let a = byCell.get(k); if (!a) { a = []; byCell.set(k, a); } a.push(x); }
  const DRAWS = 400;
  const SIGMAS: number[] = []; for (let x = 0; x <= 8.0001; x += 0.1) SIGMAS.push(Math.round(x * 10) / 10);
  /* per (season, week, sigma): sums over clubs of the squared deviation of actual
     remaining wins from the simulated mean, of the simulated variance, and the club count.
     The same offset draws (common random numbers, seeded by season and week) are
     scaled for every sigma, so the curve in sigma is smooth. */
  const sums = new Map<string, Float64Array>();   // key season:week -> [emp_0, sim_0, n, emp_1, sim_1, n, ...]
  for (const [k, games] of byCell) {
    const [s, w] = k.split(':').map(Number);
    const T = tables[s];
    const clubs = [...new Set(games.flatMap((g) => [g[2], g[3]]))].sort();
    const ix: Record<string, number> = {}; clubs.forEach((c, i) => { ix[c] = i; });
    const C = clubs.length, actual = new Float64Array(C);
    for (const g of games) { const a = g[5] > 0 ? 1 : g[5] === 0 ? 0.5 : 0; actual[ix[g[2]]] += a; actual[ix[g[3]]] += 1 - a; }
    const rng = streamFor(BigInt(s * 100 + w), 0, 98);
    const z = new Float64Array(DRAWS * C);
    for (let i = 0; i < z.length; i++) z[i] = normalQ(rng.nextOpen());
    const out = new Float64Array(SIGMAS.length * 3);
    SIGMAS.forEach((sg, si) => {
      const sum = new Float64Array(C), sum2 = new Float64Array(C);
      for (let d = 0; d < DRAWS; d++) {
        const mu = new Float64Array(C), v = new Float64Array(C);
        for (const g of games) {
          const h = ix[g[2]], a = ix[g[3]], [pw, pt] = wt(T, g[4] + sg * (z[d * C + h] - z[d * C + a]));
          const m = pw + 0.5 * pt, e2 = pw + 0.25 * pt;
          mu[h] += m; mu[a] += 1 - m; v[h] += e2 - m * m; v[a] += e2 - m * m;
        }
        for (let i = 0; i < C; i++) { sum[i] += mu[i]; sum2[i] += mu[i] * mu[i] + v[i]; }
      }
      let emp = 0, sim = 0;
      for (let i = 0; i < C; i++) { const m = sum[i] / DRAWS; emp += (actual[i] - m) * (actual[i] - m); sim += sum2[i] / DRAWS - m * m; }
      out[si * 3] = emp; out[si * 3 + 1] = sim; out[si * 3 + 2] = C;
    });
    sums.set(k, out);
  }
  const pooled = (seasons: number[], weeks: number[]) => {
    const acc = new Float64Array(SIGMAS.length * 3);
    for (const s of seasons) for (const w of weeks) { const o = sums.get(s + ':' + w); if (o) for (let i = 0; i < acc.length; i++) acc[i] += o[i]; }
    return acc;
  };
  /* sigma where simulated variance = empirical mean squared deviation (linear interpolation on the grid) */
  const solve = (acc: Float64Array) => {
    const f = (si: number) => (acc[si * 3 + 1] - acc[si * 3]) / acc[si * 3 + 2];
    if (f(0) >= 0) return 0;
    for (let si = 1; si < SIGMAS.length; si++) if (f(si) >= 0) { const a = f(si - 1), b = f(si); return SIGMAS[si - 1] + (SIGMAS[si] - SIGMAS[si - 1]) * (-a) / (b - a); }
    return SIGMAS[SIGMAS.length - 1];
  };
  const at = (acc: Float64Array, sg: number) => {
    const si = Math.min(SIGMAS.length - 2, Math.floor(sg / 0.1)), t = (sg - SIGMAS[si]) / 0.1;
    const g = (o: number) => ((1 - t) * acc[si * 3 + o] / acc[si * 3 + 2] + t * acc[(si + 1) * 3 + o] / acc[(si + 1) * 3 + 2]);
    return { emp: g(0), sim: g(1), n: acc[si * 3 + 2] };
  };
  const est: number[] = []; for (let s = first; s <= lastEst; s++) est.push(s);
  const out: Record<number, any> = {};
  const rng = streamFor(20261024n, 0, 97);
  for (let w = 1; w <= 17; w++) {
    const band = [w - 1, w, w + 1].filter((x) => x >= 1 && x <= 18);
    const acc = pooled(est, band), sg = solve(acc);
    const bs: number[] = [];
    for (let b = 0; b < 2000; b++) { const res: number[] = []; for (let i = 0; i < est.length; i++) res.push(est[rng.nextInt(est.length)]); bs.push(solve(pooled(res, band))); }
    bs.sort((a, b) => a - b);
    const a0 = at(acc, 0), aS = at(acc, sg), ho = at(pooled([holdout], band), sg), ho0 = at(pooled([holdout], band), 0);
    out[w] = { sigma: r(sg), sigma_ci95: [r(bs[Math.floor(0.025 * bs.length)]), r(bs[Math.floor(0.975 * bs.length)])], smoothing: 'pooled over as-of weeks ' + band.join(','),
      empirical_msd: r(aS.emp), simulated_var: r(aS.sim), simulated_var_at_zero: r(a0.sim), empirical_msd_at_zero: r(a0.emp), n_club_cells: aS.n,
      holdout: { season: holdout, empirical_msd: r(ho.emp), simulated_var: r(ho.sim), simulated_var_at_zero: r(ho0.sim), n_club_cells: ho.n },
      draws_per_cell: DRAWS, sigma_grid: '0 to 8 by 0.1, linear interpolation', bootstrap: '2000 season resamples' };
  }
  return out;
}
function normalQ(p: number): number { return normalQuantile(p); }

main();

/* ===========================================================================
   MLB strength uncertainty for the simulator:
   simulator/data/mlb_strength_uncertainty.json

   A simulated season draws, once per run and kept through the regular
   season and the postseason:
     theta_t ~ Normal(0, sigma_team^2)   one offset per club, in log runs:
               the club's runs scored x exp(theta_t / 2), its runs allowed
               x exp(-theta_t / 2)
     phi_p   ~ Normal(0, sigma_sp^2)     one offset per named starting
               pitcher (rotation members, confirmed starters): the runs his
               opponents score x exp(-phi_p)
   These are the uncertainty in the FROZEN as-of ratings, distinct from game
   randomness (the negative binomial). Every number below comes from frozen
   forecasts: the served model as of a stage of a past season (the shared
   replay, point-in-time by construction), pricing that season's remaining
   games with PROJECTED starters (the simulator's rotation model, the
   simulator's code), against what actually happened.

   1 sigma_sp: the within-pitcher covariance of opponents' relative run
     residuals e = (runs - lambda) / lambda (lambda with the ACTUAL starters)
     between two remaining starts of the same pitcher, minus the same
     covariance between starts of two different pitchers of the same club
     (the club's own error), pooled over every stage.
   2 the replacement level: an unnamed starter (spot start, a departed
     member's slot) is priced at s_replacement = -log(sum runs / sum lambda)
     over the remaining starts made outside the as-of rotation, lambda with
     s = 0 for that starter.
   3 sigma_team by stage (20, 40, 60, 81, 100, 120, 140 club games): the
     sigma at which the simulated variance of each club's remaining wins
     (rotation draws, theta, phi with sigma_sp, game randomness) equals the
     mean squared deviation of the actual remaining wins from the simulated
     mean. Grid 0 to 0.30 by 0.01, 200 seeded draws per cell with common
     random numbers across the grid, linear interpolation.
   4 uncertainty: 1,000 season-bootstrap resamples. ESTIMATION 2012-2023
     (2020 and 2024 left out), HOLDOUT 2025 reported only.
   The postseason uses the last stage's sigma (no remaining regular-season
   games exist to calibrate against after the season): stated, not tested.

     node simulator/src/research/mlb_strength_uncertainty.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { studyReplay, studyCaptureDays, stageDays, STUDY_SEASONS, STAGES, fileSha } from './mlb_replay.ts';
import { loadRegularSeason, dayOf, REPO } from '../sports/mlb/history.ts';
import { WinTable, calibratedHome, starterEffect, type ModelState } from '../sports/mlb/model_adapter.ts';
import { rotationAt, lastStarts, RotationState, drawDepartures, projectRegular, REPLACEMENT, type RotationParams, type GameKind, type Start } from '../sports/mlb/rotation.ts';
import { ROTATION_STUDY } from './mlb_rotation_study.ts';
import { streamFor, Xoshiro128 } from '../core/prng.ts';
import { normalQuantile } from '../core/normal.ts';

export const STRENGTH_STUDY = path.join(REPO, 'simulator', 'data', 'mlb_strength_uncertainty.json');
const ESTIMATION = STUDY_SEASONS.filter((s) => s <= 2023), HOLDOUT = [2025];
const GRID = Array.from({ length: 31 }, (_, i) => i / 100);
const DRAWS = 200, BOOT = 1000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface Cell { season: number; stage: number; sumVar: number[]; sumSq: number[]; clubs: number; games: number }

function main() {
  const log = (s: string) => console.log('[mlb strength] ' + s);
  if (!fs.existsSync(ROTATION_STUDY)) throw new Error('run simulator/src/research/mlb_rotation_study.ts first');
  const rotDoc = JSON.parse(fs.readFileSync(ROTATION_STUDY, 'utf8'));
  const P: RotationParams = rotDoc.simulator_parameters;
  const R = studyReplay(studyCaptureDays(), log);
  const tables = new Map<number, WinTable>();
  const tableFor = (r: number) => { let t = tables.get(r); if (!t) { t = new WinTable(r); tables.set(r, t); } return t; };

  /* per season: the club games in order, with starters and the remaining-game list */
  interface G { day: number; game_no: number; home: string; away: string; hs: number; as: number; sp_home: string; sp_away: string; kind: GameKind }
  const seasonGames = new Map<number, G[]>();
  for (const s of STUDY_SEASONS) seasonGames.set(s, loadRegularSeason(s).games.filter((g) => g.hs !== g.as).map((g) => ({ day: dayOf(g.date), game_no: g.game_no, home: g.home, away: g.away, hs: g.hs, as: g.as,
    sp_home: g.sp_home || '', sp_away: g.sp_away || '', kind: (g.game_no === 0 ? 'single' : g.game_no === 1 ? 'dh1' : 'dh2') as GameKind })));

  /* 1 + 2: residual covariances and the replacement level, with the ACTUAL starters */
  const cov = { samePitcher: [0, 0], sameClubOther: [0, 0] } as Record<string, number[]>;
  const covBySeason: Record<number, { sp: number[]; club: number[] }> = {};
  const repl = { runs: 0, lam: 0, n: 0 }, member = { runs: 0, lam: 0, n: 0 };
  const stagePlan: Array<{ season: number; stage: number; day: number }> = [];
  for (const s of STUDY_SEASONS) for (const x of stageDays(s)) stagePlan.push({ season: s, stage: x.stage, day: x.day });
  for (const c of stagePlan) {
    const M = R.captures.get(c.day)!; const gs = seasonGames.get(c.season)!;
    const before = gs.filter((g) => g.day < c.day), rem = gs.filter((g) => g.day >= c.day);
    const rot: Record<string, string[]> = {};
    for (const t of new Set(gs.map((g) => g.home))) rot[t] = rotationAt(before.flatMap((g) => (g.home === t ? [{ day: g.day, game_no: g.game_no, pitcher: g.sp_home }] : g.away === t ? [{ day: g.day, game_no: g.game_no, pitcher: g.sp_away }] : [])), 5);
    const byPitcher = new Map<string, number[]>(), byClub = new Map<string, number[]>();
    for (const g of rem) {
      for (const [t, opp, sp, runsAllowed] of [[g.home, g.away, g.sp_home, g.as], [g.away, g.home, g.sp_away, g.hs]] as Array<[string, string, string, number]>) {
        const th = M.teams[t] || { o: 0, d: 0, k: 0 }, to = M.teams[opp] || { o: 0, d: 0, k: 0 }, park = (M.teams[g.home] || { k: 0 }).k;
        const homeOpp = opp === g.home;
        const base = M.mu + (homeOpp ? M.home : 0) + to.o - th.d + park;
        const inRot = rot[t].includes(sp);
        const lam = Math.exp(base - starterEffect(M, sp));
        const e = (runsAllowed - lam) / lam;
        if (!byPitcher.has(sp)) byPitcher.set(sp, []); byPitcher.get(sp)!.push(e);
        if (!byClub.has(t)) byClub.set(t, []); byClub.get(t)!.push(e);
        if (inRot) { member.runs += runsAllowed; member.lam += lam; member.n++; }
        else { const lam0 = Math.exp(base); repl.runs += runsAllowed; repl.lam += lam0; repl.n++; }
      }
    }
    const pairSum = (xs: number[]) => { let s1 = 0, s2 = 0; for (const x of xs) { s1 += x; s2 += x * x; } return [(s1 * s1 - s2) / 2, xs.length * (xs.length - 1) / 2]; };
    const cs = covBySeason[c.season] || (covBySeason[c.season] = { sp: [0, 0], club: [0, 0] });
    const spOf = new Map<string, string>();
    for (const g of rem) { spOf.set(g.sp_home, g.home); spOf.set(g.sp_away, g.away); }
    const spPairsByClub = new Map<string, number[]>();
    for (const [p, xs] of byPitcher) { const [ps, pn] = pairSum(xs); cs.sp[0] += ps; cs.sp[1] += pn; const t = spOf.get(p)!; const a = spPairsByClub.get(t) || [0, 0]; a[0] += ps; a[1] += pn; spPairsByClub.set(t, a); }
    for (const [t, xs] of byClub) { const [ps, pn] = pairSum(xs); const sp = spPairsByClub.get(t) || [0, 0]; cs.club[0] += ps - sp[0]; cs.club[1] += pn - sp[1]; }
  }
  const covEstimate = (seasons: number[]) => {
    let a = 0, b = 0, c = 0, d = 0;
    for (const s of seasons) { const x = covBySeason[s]; if (!x) continue; a += x.sp[0]; b += x.sp[1]; c += x.club[0]; d += x.club[1]; }
    const same = a / b, club = c / d;
    return { same_pitcher: same, same_club_other_pitcher: club, var_pitcher: same - club };
  };
  const covEst = covEstimate(ESTIMATION);
  /* the relative residual is ~ exp(-phi) - 1 ~ -phi to first order: its variance is phi's (in log runs) */
  const sigmaSp = Math.sqrt(Math.max(0, covEst.var_pitcher));
  const spBoot: number[] = [];
  { const rng = new Xoshiro128(20261023, 3, 5, 7);
    for (let b = 0; b < BOOT; b++) { const pick: number[] = []; for (let i = 0; i < ESTIMATION.length; i++) pick.push(ESTIMATION[rng.nextInt(ESTIMATION.length)]);
      let a = 0, bb = 0, c = 0, d = 0; for (const s of pick) { const x = covBySeason[s]; a += x.sp[0]; bb += x.sp[1]; c += x.club[0]; d += x.club[1]; }
      spBoot.push(Math.sqrt(Math.max(0, a / bb - c / d))); }
    spBoot.sort((x, y) => x - y); }
  const sReplacement = -Math.log(repl.runs / repl.lam);
  log('sigma_sp ' + sigmaSp.toFixed(4) + ' (pitcher cov ' + covEst.same_pitcher.toExponential(3) + ', club cov ' + covEst.same_club_other_pitcher.toExponential(3) + '); replacement s ' + sReplacement.toFixed(4) + ' over ' + repl.n + ' starts; members ratio ' + (member.runs / member.lam).toFixed(4));

  /* 3 the win-total calibration of sigma_team, per stage */
  const cells: Cell[] = [];
  for (const c of stagePlan) {
    const M: ModelState = R.captures.get(c.day)!; const cal = R.calibration[c.season]; const tab = tableFor(cal.r);
    const gs = seasonGames.get(c.season)!; const before = gs.filter((g) => g.day < c.day), rem = gs.filter((g) => g.day >= c.day);
    const clubs = [...new Set(gs.map((g) => g.home))].sort(); const ci: Record<string, number> = {}; clubs.forEach((t, i) => { ci[t] = i; });
    const T = clubs.length;
    const states = clubs.map((t) => {
      const starts: Start[] = before.flatMap((g) => (g.home === t ? [{ day: g.day, game_no: g.game_no, pitcher: g.sp_home }] : g.away === t ? [{ day: g.day, game_no: g.game_no, pitcher: g.sp_away }] : []));
      const ids = rotationAt(starts, 5); const ls = lastStarts(starts);
      return { st: new RotationState(ids, ids.map((p) => starterEffect(M, p)), ids.map((p) => ls[p])), last0: ids.map((p) => ls[p]) };
    });
    const nG = rem.length;
    const gh = Int16Array.from(rem.map((g) => ci[g.home])), ga = Int16Array.from(rem.map((g) => ci[g.away]));
    const bh = Float64Array.from(rem.map((g) => { const h = M.teams[g.home], a = M.teams[g.away]; return M.mu + M.home + h.o - a.d + h.k; }));
    const ba = Float64Array.from(rem.map((g) => { const h = M.teams[g.home], a = M.teams[g.away]; return M.mu + a.o - h.d + h.k; }));
    const actualW = new Float64Array(T); for (const g of rem) actualW[ci[g.hs > g.as ? g.home : g.away]]++;
    const S = GRID.map(() => new Float64Array(T)), S2 = GRID.map(() => new Float64Array(T)), V = GRID.map(() => new Float64Array(T));
    const sH = new Float64Array(nG), sA = new Float64Array(nG), zH = new Float64Array(nG), zA = new Float64Array(nG);
    const theta = new Float64Array(T), out = new Float64Array(2);
    for (let d = 0; d < DRAWS; d++) {
      const rng: Xoshiro128 = streamFor(BigInt(c.season * 1000 + c.stage), d, 9);
      for (let t = 0; t < T; t++) theta[t] = normalQuantile(rng.nextOpen());
      const pz = states.map((x) => x.st.ids.map(() => normalQuantile(rng.nextOpen())));
      states.forEach((x) => { x.st.reset(x.last0); drawDepartures(x.st, P, rng); });
      for (let g = 0; g < nG; g++) {
        for (const side of [0, 1]) {
          const t = side === 0 ? gh[g] : ga[g]; const x = states[t];
          const slot = projectRegular(x.st, rem[g].day, rem[g].kind, P, rng); x.st.games++;
          const s = slot === REPLACEMENT ? sReplacement : x.st.s[slot], z = slot === REPLACEMENT ? 0 : pz[t][slot];
          if (side === 0) { sH[g] = s; zH[g] = z; } else { sA[g] = s; zA[g] = z; }
        }
      }
      for (let k = 0; k < GRID.length; k++) {
        const sig = GRID[k], Sk = S[k], S2k = S2[k], Vk = V[k];
        const tot = new Float64Array(T), vv = new Float64Array(T);
        for (let g = 0; g < nG; g++) {
          const h = gh[g], a = ga[g], dth = sig * (theta[h] - theta[a]) / 2;
          const lh = Math.exp(bh[g] + dth - sA[g] - sigmaSp * zA[g]), la = Math.exp(ba[g] - dth - sH[g] - sigmaSp * zH[g]);
          tab.at(lh, la, out);
          const p = calibratedHome(out[0], out[1], cal.xi, cal.recal);
          tot[h] += p; tot[a] += 1 - p; vv[h] += p * (1 - p); vv[a] += p * (1 - p);
        }
        for (let t = 0; t < T; t++) { Sk[t] += tot[t]; S2k[t] += tot[t] * tot[t]; Vk[t] += vv[t]; }
      }
    }
    const cell: Cell = { season: c.season, stage: c.stage, sumVar: [], sumSq: [], clubs: T, games: nG };
    for (let k = 0; k < GRID.length; k++) {
      let sv = 0, sq = 0;
      for (let t = 0; t < T; t++) { const m = S[k][t] / DRAWS; const varS = S2[k][t] / DRAWS - m * m; sv += V[k][t] / DRAWS + varS; sq += (actualW[t] - m) ** 2; }
      cell.sumVar.push(sv); cell.sumSq.push(sq);
    }
    cells.push(cell);
    if (c.stage === STAGES[0]) log('season ' + c.season + ' ...');
  }

  /* solve sigma where simulated variance = mean squared deviation; linear interpolation on the grid */
  const solve = (cs: Cell[]): { sigma: number | null; ratio_at_zero: number } => {
    const v = GRID.map((_, k) => cs.reduce((a, c) => a + c.sumVar[k], 0)), q = GRID.map((_, k) => cs.reduce((a, c) => a + c.sumSq[k], 0));
    const f = GRID.map((_, k) => v[k] - q[k]);
    const ratio0 = q[0] / v[0];
    if (f[0] >= 0) return { sigma: 0, ratio_at_zero: ratio0 };
    for (let k = 1; k < GRID.length; k++) if (f[k] >= 0) { const x0 = GRID[k - 1], x1 = GRID[k]; return { sigma: x0 + (x1 - x0) * (-f[k - 1]) / (f[k] - f[k - 1]), ratio_at_zero: ratio0 }; }
    return { sigma: null, ratio_at_zero: ratio0 };
  };
  const boot = new Xoshiro128(20261023, 7, 11, 13);
  const byStage: Record<string, unknown> = {};
  for (const stage of STAGES) {
    const est = cells.filter((c) => c.stage === stage && ESTIMATION.includes(c.season));
    const hold = cells.filter((c) => c.stage === stage && HOLDOUT.includes(c.season));
    const point = solve(est);
    const bs: number[] = [];
    for (let b = 0; b < BOOT; b++) {
      const pick: Cell[] = [];
      for (let i = 0; i < ESTIMATION.length; i++) { const s = ESTIMATION[boot.nextInt(ESTIMATION.length)]; pick.push(...est.filter((c) => c.season === s)); }
      const x = solve(pick).sigma; bs.push(x == null ? GRID[GRID.length - 1] : x);
    }
    bs.sort((a, b) => a - b);
    const k0 = GRID.indexOf(0);
    byStage[String(stage)] = {
      sigma_team: point.sigma == null ? null : r6(point.sigma), ci95: [r6(bs[Math.floor(0.025 * BOOT)]), r6(bs[Math.floor(0.975 * BOOT)])],
      estimation: { seasons: ESTIMATION, club_seasons: est.reduce((a, c) => a + c.clubs, 0), remaining_games: est.reduce((a, c) => a + c.games, 0), msd_over_simulated_variance_at_sigma0: r6(point.ratio_at_zero) },
      holdout_2025: hold.length ? { msd: r6(hold[0].sumSq[k0] / hold[0].clubs), simulated_variance_at_sigma0: r6(hold[0].sumVar[k0] / hold[0].clubs), sigma_matching_2025: solve(hold).sigma == null ? null : r6(solve(hold).sigma as number) } : null
    };
    log('stage ' + stage + ': sigma_team ' + JSON.stringify(byStage[String(stage)]));
  }
  const doc = {
    schema: 'edgedesk_sim_mlb_strength_uncertainty_v1',
    built_at: new Date().toISOString(),
    served_model: { version: R.served.version, config_sha256: R.served.config_sha256 },
    inputs: { data_sha256: R.data_sha256, rotation_study_sha256: fileSha('simulator/data/mlb_rotation_study.json'), model_sha256: fileSha('mlb/history/model.js') },
    units: 'log runs: theta_t moves a club\'s runs scored by exp(theta/2) and runs allowed by exp(-theta/2); phi_p moves the runs a starter\'s opponents score by exp(-phi)',
    sigma_sp: { value: r6(sigmaSp), ci95: [r6(spBoot[Math.floor(0.025 * BOOT)]), r6(spBoot[Math.floor(0.975 * BOOT)])], holdout_2025: covBySeason[2025] ? r6(Math.sqrt(Math.max(0, covBySeason[2025].sp[0] / covBySeason[2025].sp[1] - covBySeason[2025].club[0] / covBySeason[2025].club[1]))) : null, method: 'within-pitcher minus within-club covariance of relative run residuals, remaining starts, ESTIMATION seasons', covariances: { same_pitcher: r6(covEst.same_pitcher), same_club_other_pitcher: r6(covEst.same_club_other_pitcher) },
      by_season: Object.fromEntries(Object.entries(covBySeason).map(([s, x]) => [s, { same_pitcher: r6(x.sp[0] / x.sp[1]), same_club_other_pitcher: r6(x.club[0] / x.club[1]), pairs: x.sp[1] }])) },
    replacement_starter: { s: r6(sReplacement), starts: repl.n, runs_over_lambda_at_s0: r6(repl.runs / repl.lam), rotation_members_runs_over_lambda: r6(member.runs / member.lam), member_starts: member.n },
    sigma_team_by_stage: byStage,
    postseason: { sigma_team: 'the stage-140 value', note: 'no remaining regular-season games exist after the season to calibrate against; the last stage\'s sigma is carried, not tested' },
    method: { grid: '0 to 0.30 by 0.01', draws_per_cell: DRAWS, common_random_numbers: true, bootstrap: BOOT + ' season resamples (seed 20261023)', rotation: 'simulator_parameters of simulator/data/mlb_rotation_study.json', stages: STAGES }
  };
  fs.writeFileSync(STRENGTH_STUDY, JSON.stringify(doc, null, 1) + '\n');
  log('wrote ' + path.relative(REPO, STRENGTH_STUDY));
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();

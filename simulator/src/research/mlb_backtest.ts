/* ===========================================================================
   MLB season backtest: simulator/data/mlb_backtest.json

   As-of replays of the MLB-2022 seasons with starters on file (2022, 2023,
   2025; 2024's table has no starters) at four stages (40, 81, 120 and 140
   club games), each simulated with the production sigmas and with
   sigma = 0 (the frozen model's game probabilities only), scored against
   what happened: division titles, postseason berths, pennants and the World
   Series (Brier; log loss with probabilities clipped at max(1e-6, 0.5/N)).

   Descriptive only. sigma_team and sigma_sp were calibrated on 2012-2023,
   so 2022 and 2023 are in-sample for them; 2025 is the one out-of-sample
   season. Three seasons are far too few to decide anything; the season
   cluster (the four stages of a season share outcomes) is the unit of the
   bootstrap interval. No market baseline exists (no owned MLB futures
   prices).

     node simulator/src/research/mlb_backtest.ts [--runs 2000]
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { studyReplay, studyCaptureDays, stageDays } from './mlb_replay.ts';
import { buildMlbHistorySnapshot } from '../sports/mlb/inputs.ts';
import { mlbModule } from '../sports/mlb/module.ts';
import { Season, Standings, qualify } from '../sports/mlb/rules.ts';
import { teamsFor, formatFor } from '../sports/mlb/config.ts';
import { loadRegularSeason, loadPostseason, dayOf, REPO } from '../sports/mlb/history.ts';
import { runRange, summarise } from '../core/engine.ts';
import { hashCanonical } from '../core/canonical.ts';
import { Xoshiro128 } from '../core/prng.ts';

export const MLB_BACKTEST = path.join(REPO, 'simulator', 'data', 'mlb_backtest.json');
const SEASONS = [2022, 2023, 2025], STAGES = [40, 81, 120, 140];
const FAMILIES = ['win_division', 'make_playoffs', 'win_pennant', 'win_world_series'] as const;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

function actualOutcomes(season: number): Record<string, Record<string, 0 | 1>> {
  const teams = teamsFor(season); const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const games = loadRegularSeason(season).games;
  const S = new Season(teams, games.map((g) => ({ home: ix[g.home], away: ix[g.away], day: dayOf(g.date), game_no: g.game_no })));
  const st = new Standings(S, Int8Array.from(games.map((g) => (g.hs > g.as ? 1 : g.hs < g.as ? -1 : 0))), { rng: null });
  const q = qualify(st, formatFor(season));
  const ws = loadPostseason().games.filter((g) => g.season === season && g.round === 'WS');
  const wins: Record<string, number> = {}; for (const g of ws) { const w = g.hs > g.as ? g.home : g.away; wins[w] = (wins[w] || 0) + 1; }
  const champ = Object.entries(wins).find(([, n]) => n === 4)![0];
  const pennants = new Set(ws.flatMap((g) => [g.home, g.away]));
  const out: Record<string, Record<string, 0 | 1>> = {};
  teams.forEach((t, i) => { out[t.code] = { win_division: q.some((L) => L.divisionWinners.includes(i)) ? 1 : 0, make_playoffs: q.some((L) => L.seeds.includes(i)) ? 1 : 0, win_pennant: pennants.has(t.code) ? 1 : 0, win_world_series: t.code === champ ? 1 : 0 }; });
  return out;
}

function main() {
  const i = process.argv.indexOf('--runs'); const RUNS = i > 0 ? Number(process.argv[i + 1]) : 2000;
  const log = (s: string) => console.log('[mlb backtest] ' + s);
  const R = studyReplay(studyCaptureDays(), log);
  const clip = Math.max(1e-6, 0.5 / RUNS);
  interface Row { season: number; stage: number; team: string; family: string; y: 0 | 1; p_prod: number; p_zero: number }
  const rows: Row[] = [];
  const t0 = Date.now();
  for (const season of SEASONS) {
    const act = actualOutcomes(season);
    for (const stage of STAGES) {
      const sd = stageDays(season).find((x) => x.stage === stage)!;
      const snap = buildMlbHistorySnapshot({ season, asOf: sd.date, model: { state: R.captures.get(sd.day)!, calibration: R.calibration[season] } });
      const seed = BigInt('0x' + hashCanonical({ season, stage }).slice(0, 16));
      const prod = summarise(mlbModule(snap.data, { seed }), runRange(mlbModule(snap.data, { seed }), { start: 0, end: RUNS }));
      const zero = summarise(mlbModule(snap.data, { seed, sigma: 0, sigmaSp: 0 }), runRange(mlbModule(snap.data, { seed, sigma: 0, sigmaSp: 0 }), { start: 0, end: RUNS }));
      for (const e of prod) for (const f of FAMILIES) {
        const z = zero.find((x) => x.entity_id === e.entity_id)!;
        rows.push({ season, stage, team: e.entity_id, family: f, y: act[e.entity_id][f], p_prod: e.outcomes[f].probability, p_zero: z.outcomes[f].probability });
      }
      log(season + ' stage ' + stage + ' (' + sd.date + ') done, ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    }
  }
  const brier = (p: number, y: number) => (p - y) ** 2;
  const ll = (p: number, y: number) => { const q = Math.min(1 - clip, Math.max(clip, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
  const metric = (rs: Row[]) => ({ n: rs.length, brier_prod: r6(rs.reduce((a, r) => a + brier(r.p_prod, r.y), 0) / rs.length), brier_zero: r6(rs.reduce((a, r) => a + brier(r.p_zero, r.y), 0) / rs.length),
    log_loss_prod: r6(rs.reduce((a, r) => a + ll(r.p_prod, r.y), 0) / rs.length), log_loss_zero: r6(rs.reduce((a, r) => a + ll(r.p_zero, r.y), 0) / rs.length) });
  const rng = new Xoshiro128(20261023, 1, 2, 3);
  const byFamily: Record<string, unknown> = {};
  for (const f of FAMILIES) {
    const rs = rows.filter((r) => r.family === f);
    const diffs: number[] = [];
    for (let b = 0; b < 2000; b++) {
      const pick = SEASONS.map(() => SEASONS[rng.nextInt(SEASONS.length)]);
      const sub = pick.flatMap((s) => rs.filter((r) => r.season === s));
      diffs.push(sub.reduce((a, r) => a + brier(r.p_prod, r.y) - brier(r.p_zero, r.y), 0) / sub.length);
    }
    diffs.sort((a, b) => a - b);
    byFamily[f] = { ...metric(rs), brier_diff_ci95_season_bootstrap: [r6(diffs[50]), r6(diffs[1949])], holdout_2025: metric(rs.filter((r) => r.season === 2025)),
      by_stage: Object.fromEntries(STAGES.map((s) => [s, metric(rs.filter((r) => r.stage === s))])) };
  }
  const doc = {
    schema: 'edgedesk_sim_mlb_backtest_v1', built_at: new Date().toISOString(),
    design: { seasons: SEASONS, stages: STAGES, runs_per_cell: RUNS, log_loss_clip: clip, baseline: 'the same simulator with sigma_team = sigma_sp = 0', unit: 'season cluster (four stages of a season share outcomes)',
      caveats: ['sigma_team and sigma_sp were calibrated on 2012-2023: 2022 and 2023 are in-sample for them; 2025 is the one out-of-sample season', 'three seasons cannot decide anything; the intervals are a three-cluster bootstrap and are wide', 'no market baseline: EdgeDesk owns no MLB futures prices', '2024 left out: its game table has no starting pitchers'] },
    by_family: byFamily,
    rows_sha256: hashCanonical(rows)
  };
  fs.writeFileSync(MLB_BACKTEST, JSON.stringify(doc, null, 1) + '\n');
  for (const f of FAMILIES) { const x = byFamily[f] as any; log(f + ': Brier ' + x.brier_prod + ' vs sigma0 ' + x.brier_zero + ' diff CI ' + JSON.stringify(x.brier_diff_ci95_season_bootstrap) + ' | 2025 ' + x.holdout_2025.brier_prod + ' vs ' + x.holdout_2025.brier_zero); }
  log('wrote ' + path.relative(REPO, MLB_BACKTEST));
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();

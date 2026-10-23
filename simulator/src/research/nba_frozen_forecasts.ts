/* ===========================================================================
   FROZEN NBA FORECASTS — what the served model would have said, at a fixed
   point of a past season, about every one of that season's remaining games.

   The evidence base of the NBA strength-uncertainty study
   (nba_strength_uncertainty.ts) and of the return-trajectory check.

   For season S and as-of point g (the moment the league has completed 15·g
   regular-season games, i.e. the average club has played g):
     1. the served pass (nba/model/pass.js, the live tuning) runs over every
        season 2003..S with every game from that moment on treated as
        unplayed (model_adapter.ts frozenPass): the states are frozen there;
     2. season S's parameters are rebuilt OUT OF SAMPLE (seasonParams: the
        ridge trained on seasons before S, the calibration, shape and
        overtime on S-3..S-1), exactly as nba/model/live.js builds the live
        season's;
     3. every remaining regular-season game of S is priced by the chosen
        model from the frozen states (its schedule context — rest, travel —
        is the schedule's, known in advance), with the two availability
        slopes (d mean / d plr_m_proj and d mean / d adj_proj) measured on the
        same path;
     4. each club's tracked absences at that moment (availability.ts) are
        recorded with the player model's value of each one returning.
   One job is one (S, g); jobs run as separate processes.

     node simulator/src/research/nba_frozen_forecasts.ts --all --parallel 3
     node simulator/src/research/nba_frozen_forecasts.ts --job 2024:1

   Output (not committed; large and rebuildable): simulator/.cache/nba_frozen/<S>_<g>.json
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO, nbaModules, seasonParams, priceRow, frozenPass, type SeasonParams } from '../sports/nba/model_adapter.ts';
import { AppearanceScan, teamGameLog } from '../sports/nba/availability.ts';

export const FROZEN_DIR = path.join(REPO, 'simulator', '.cache', 'nba_frozen');
export const STUDY_SEASONS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024, 2025, 2026];
export const AS_OF_POINTS = [1, 10, 20, 41, 61];
/** at most this many tracked absences per club enter the exact subset table */
export const MAX_TRACKED = 6;

export function freezeTime(D: any, S: number, g: number): number {
  const reg = D.games([S]).filter((x: any) => x.status === 'FINAL' && x.type === 'R' && x.scope === 'regular_season').sort((a: any, b: any) => a.start_ms - b.start_ms);
  if (reg.length <= 15 * g) throw new Error('season ' + S + ' has only ' + reg.length + ' regular-season games');
  return reg[15 * g].start_ms;
}

/** the subset table of a club's tracked absences: net (projected set + R) and full (regulars + R) for every subset R */
export function subsetTable(pm: any, proj: string[], regs: string[], tracked: string[]): { net: number[]; full: number[] } {
  const n = tracked.length, net: number[] = [], full: number[] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    const R = tracked.filter((_, i) => mask & (1 << i));
    const P = proj.concat(R.filter((p) => !proj.includes(p))), F = regs.concat(R.filter((p) => !regs.includes(p)));
    net.push(pm.strength(P).net); full.push(pm.strength(F).net);
  }
  return { net, full };
}

async function runJob(S: number, g: number): Promise<void> {
  const { D, WF } = nbaModules();
  const tuning = JSON.parse(fs.readFileSync(WF.TUNING, 'utf8'));
  const t0 = Date.now();
  const rows = await WF.buildRows(tuning);
  const sp: SeasonParams = seasonParams(rows, S, tuning);
  const freezeAt = freezeTime(D, S, g);
  const pass = await frozenPass({ tuning: tuning, freezeAt, upTo: S });
  const pm = pass.states.pm;
  const gamesS = D.games([S]);
  const byId = new Map<string, any>(gamesS.map((x: any) => [String(x.game_id), x]));
  const out: any[] = [];
  for (const row of pass.rows) {
    if (row.season !== S || row.y || row.start < freezeAt) continue;
    const gm = byId.get(String(row.id));
    if (!gm || gm.type !== 'R' || gm.scope !== 'regular_season') continue;
    const p = priceRow(sp, row); if (!p) throw new Error('unpriced frozen game ' + row.id);
    const p1 = priceRow(sp, row, { plr_m_proj: row.f.plr_m_proj + 1 }), p2 = priceRow(sp, row, { adj_proj: row.f.adj_proj + 1 });
    out.push({ id: String(row.id), start: row.start, home: String(row.home), away: String(row.away), neutral: row.neutral, mu: p.mu_m, sd: p.sd_m, pace: row.f.pace,
      s_plr: p1.mu_m - p.mu_m, s_adj: p2.mu_m - p.mu_m, hs: gm.hs, as: gm.as });
  }
  /* standings at the freeze and the tracked absences */
  const done = gamesS.filter((x: any) => x.status === 'FINAL' && x.type === 'R' && x.scope === 'regular_season' && x.start_ms < freezeAt);
  const wins: Record<string, number> = {}, played: Record<string, number> = {};
  for (const x of done) { const h = String(x.home_id), a = String(x.away_id); played[h] = (played[h] || 0) + 1; played[a] = (played[a] || 0) + 1; const w = x.hs > x.as ? h : a; wins[w] = (wins[w] || 0) + 1; }
  const scan = new AppearanceScan();
  for (const tg of teamGameLog(D, [S - 1, S], freezeAt)) scan.add(tg);
  const teams: Record<string, any> = {};
  const ids = [...new Set(out.flatMap((x) => [x.home, x.away]))].sort();
  for (const t of ids) {
    const proj: string[] = pm.lastGamePlayers(t) || [], regs: string[] = pm.regulars(t);
    const abs = scan.absent(t, S).filter((a) => !proj.includes(a.p));
    const tracked = abs.slice(0, MAX_TRACKED);
    teams[t] = { wins: wins[t] || 0, played: played[t] || 0, proj, absent: abs, tracked: tracked.map((a) => a.p), subsets: subsetTable(pm, proj, regs, tracked.map((a) => a.p)) };
  }
  fs.mkdirSync(FROZEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(FROZEN_DIR, S + '_' + g + '.json'), JSON.stringify({ schema: 'edgedesk_nba_frozen_v1', season: S, as_of_games: g, freeze_at: new Date(freezeAt).toISOString(),
    params: { calibration_sd_m: sp.calibration.sd_m, shape: sp.shape, ot: sp.ot, beta_m: sp.calibration.beta_m }, games: out, teams, seconds: (Date.now() - t0) / 1000 }));
  console.log('[nba frozen] ' + S + ':' + g + ' ' + out.length + ' remaining games, ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s, rss ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB');
}

async function runAll(parallel: number, seasons: number[], points: number[]): Promise<void> {
  const { WF } = nbaModules();
  const tuning = JSON.parse(fs.readFileSync(WF.TUNING, 'utf8'));
  await WF.buildRows(tuning);   /* the walk-forward rows, cached once for every job */
  const jobs: Array<[number, number]> = [];
  for (const g of points) for (const S of seasons.slice().reverse()) if (!fs.existsSync(path.join(FROZEN_DIR, S + '_' + g + '.json'))) jobs.push([S, g]);
  const self = fileURLToPath(import.meta.url);
  let next = 0, failed = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [S, g] = jobs[next++];
      await new Promise<void>((res) => {
        const ch = spawn(process.execPath, ['--max-old-space-size=4096', self, '--job', S + ':' + g], { stdio: ['ignore', 'inherit', 'inherit'] });
        ch.on('exit', (code) => { if (code !== 0) { failed++; console.error('[nba frozen] job ' + S + ':' + g + ' failed (' + code + ')'); } res(); });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  if (failed) throw new Error(failed + ' frozen-forecast jobs failed');
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  (async () => {
    const job = val('--job');
    if (job) { const [S, g] = job.split(':').map(Number); await runJob(S, g); return; }
    if (argv.includes('--all')) {
      const seasons = val('--seasons') ? String(val('--seasons')).split(',').map(Number) : STUDY_SEASONS;
      const points = val('--asof') ? String(val('--asof')).split(',').map(Number) : AS_OF_POINTS;
      await runAll(Number(val('--parallel') || 3), seasons, points); return;
    }
    throw new Error('usage: --all [--parallel 3] [--seasons ...] [--asof ...] | --job S:g');
  })().catch((e) => { console.error(e); process.exit(1); });
}

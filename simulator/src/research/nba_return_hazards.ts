/* ===========================================================================
   WHEN DOES A MISSING NBA ROTATION PLAYER PLAY AGAIN? — the evidence behind
   the simulator's return trajectories (simulator/src/sports/nba/availability.ts).

   From owned appearance data only (nba/data/games + .cache/nba_work
   player_games: who played, minutes). The reason of an absence is mostly not
   observed (the box lists dressed players), so the hazard is the average over
   every reason in the record.

   1. ESTIMATION: hazards fitted on 2004-05..2022-23 (2019-20 and 2020-21,
      the restart and the protocol season, excluded).
   2. HOLDOUT 2023-24..2025-26: at each as-of point g (the league has played
      15·g games; g = 1, 10, 20, 41, 61), every tracked absence's predicted
      chance to play again within m of its club's games (m = 1, 3, 5, 10, 20,
      41) against what happened, and against the served frozen projection's
      implicit assumption (he never returns: 0). Calibration by bins of the
      prediction.
   3. PRODUCTION table: fitted on every completed season 2004-05..2025-26
      (the same two excluded), the one the snapshot reads.

     node simulator/src/research/nba_return_hazards.ts
   Output (committed): simulator/data/nba_return_hazards.json
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, nbaModules } from '../sports/nba/model_adapter.ts';
import { AppearanceScan, teamGameLog, estimateHazards, returnDistribution, type HazardTable } from '../sports/nba/availability.ts';
import { freezeTime } from './nba_frozen_forecasts.ts';
import { sha256Hex } from '../core/canonical.ts';

export const HAZARD_FILE = path.join(REPO, 'simulator', 'data', 'nba_return_hazards.json');
const EXCL = new Set([2020, 2021]);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((s) => !EXCL.has(s));
export const FIRST_HAZARD_SEASON = 2005;
export const EST = range(FIRST_HAZARD_SEASON, 2023), HOLDOUT = [2024, 2025, 2026], PRODUCTION = range(FIRST_HAZARD_SEASON, 2026);
/** the hazards a season-S simulation may use: every season from 2004-05 to S-1, the two excluded */
export const hazardSeasons = (S: number) => range(FIRST_HAZARD_SEASON, S - 1);
const POINTS = [1, 10, 20, 41, 61], WITHIN = [1, 3, 5, 10, 20, 41];

function main() {
  const { D } = nbaModules();
  const H = estimateHazards(D, EST);
  /* holdout evaluation */
  const rows: Array<{ season: number; g: number; m: number; p: number; y: number }> = [];
  /* return within the rest of the regular season, by as-of point, carried or in-season, minutes tier */
  const cls: Record<string, { n: number; p: number; y: number }> = {};
  for (const S of HOLDOUT) {
    const log = teamGameLog(D, [S - 1, S]);
    for (const g of POINTS) {
      const fz = freezeTime(D, S, g);
      const scan = new AppearanceScan();
      const before = log.filter((x) => x.start_ms < fz), after = log.filter((x) => x.start_ms >= fz && x.season === S);
      for (const x of before) scan.add(x);
      const byTeam = new Map<string, typeof after>(); for (const x of after) { const a = byTeam.get(x.team); if (a) a.push(x); else byTeam.set(x.team, [x]); }
      /* each player's next appearance after the freeze: [team, that team's game index] */
      const next = new Map<string, { team: string; j: number }>();
      const count = new Map<string, number>();
      for (const x of after) {
        const j = (count.get(x.team) || 0) + 1; count.set(x.team, j);
        for (const p of x.players) if (!next.has(p.p)) next.set(p.p, { team: x.team, j });
      }
      for (const [team, games] of byTeam) {
        const reg = games.length;
        for (const a of scan.absent(team, S)) {
          const d = returnDistribution(H, a, reg, 'holdout');
          const nx = next.get(a.p); const at = nx && nx.team === team ? nx.j : Infinity;
          const ck = 'g' + g + '|' + (a.carried ? 'carried' : 'in_season') + '|' + (a.exp_min >= 24 ? '24+' : '10-24');
          const cc = cls[ck] || (cls[ck] = { n: 0, p: 0, y: 0 }); cc.n++; cc.p += 1 - d.out_for_season; cc.y += at <= reg ? 1 : 0;
          for (const m of WITHIN) {
            if (m > reg) continue;
            const p = d.periods.filter((q) => q.period <= m).reduce((u, q) => u + q.probability, 0);
            rows.push({ season: S, g, m, p, y: at <= m ? 1 : 0 });
          }
        }
      }
    }
  }
  const summary = WITHIN.map((m) => {
    const r = rows.filter((x) => x.m === m), n = r.length;
    const mp = r.reduce((u, x) => u + x.p, 0) / n, my = r.reduce((u, x) => u + x.y, 0) / n;
    const brier = r.reduce((u, x) => u + (x.p - x.y) ** 2, 0) / n, brierNever = r.reduce((u, x) => u + x.y, 0) / n, brierBase = r.reduce((u, x) => u + (my - x.y) ** 2, 0) / n;
    const edges = [0, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0001];
    const bins = edges.slice(0, -1).map((lo, i) => { const hi = edges[i + 1]; const b = r.filter((x) => x.p >= lo && x.p < hi); return { lo, hi: Math.min(1, hi), n: b.length, mean_p: b.length ? round(b.reduce((u, x) => u + x.p, 0) / b.length) : null, observed: b.length ? round(b.reduce((u, x) => u + x.y, 0) / b.length) : null }; });
    return { within_games: m, n, mean_predicted: round(mp), observed: round(my), brier: round(brier), brier_never_returns: round(brierNever), brier_holdout_base_rate: round(brierBase), calibration: bins };
  });
  const prod: HazardTable = estimateHazards(D, PRODUCTION);
  const out = { schema: 'edgedesk_nba_return_hazards_v1', generated_at: new Date().toISOString(),
    definition: 'tracked absence: last appearance (minutes played) for the club in the current or previous season, not in its latest game, expected minutes (player-model EWM, half-life 8 games) >= ' + prod.min_minutes + '; hazard = share of at-risk club games in which he played, by (carried from an earlier season, minutes tier, games missed so far)',
    estimation_seasons: EST, holdout_seasons: HOLDOUT, as_of_points: POINTS,
    holdout: { rows: rows.length, by_within: summary,
      by_class: Object.entries(cls).sort().map(([k, c]) => { const [g, kind, tier] = k.split('|'); return { as_of_games: Number(g.slice(1)), kind, minutes: tier, n: c.n, predicted_return_this_season: round(c.p / c.n), observed: round(c.y / c.n) }; }), note: 'brier_never_returns is the served frozen projection\'s implicit assumption (a missing player never comes back); brier_holdout_base_rate is an oracle constant equal to the holdout\'s own observed rate (not available ahead of time)' },
    production: prod,
    code_sha256: { 'simulator/src/sports/nba/availability.ts': sha256Hex(fs.readFileSync(path.join(REPO, 'simulator', 'src', 'sports', 'nba', 'availability.ts'))) } };
  fs.writeFileSync(HAZARD_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, HAZARD_FILE));
  for (const s of summary) console.log('within ' + String(s.within_games).padStart(2) + ' games: n ' + s.n + ', predicted ' + s.mean_predicted + ', observed ' + s.observed + ', Brier ' + s.brier + ' (never returns ' + s.brier_never_returns + ', oracle base rate ' + s.brier_holdout_base_rate + ')');
}
const round = (v: number) => Math.round(v * 1e4) / 1e4;

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();

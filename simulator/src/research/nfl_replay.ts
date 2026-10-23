/* ===========================================================================
   THE FROZEN-STATE REPLAY both NFL research tools stand on
   (nfl_strength_uncertainty.ts, nfl_backtest.ts).

   The SERVED configuration of football/nfl_model.js is replayed over every
   game 1999-2026 exactly as football/research/nfl_v2/backtest.js replays it,
   and a copy of the rating state is frozen before the first game of each
   regular-season week of each season in [first, last]. Point-in-time by
   construction: a frozen state has absorbed only games that kicked off
   before it. Weights for season S are fitted on seasons before S only
   (backtest.js fit), and the margin distribution is backtest.js pmfFor(S),
   fitted on seasons before S.
   Needs the cached history: CORE=1 bash football/research/nfl_v2/fetch_history.sh 2026
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from '../sports/nfl/model_adapter.ts';

const require = createRequire(import.meta.url);
export const V2 = path.join(REPO, 'football', 'research', 'nfl_v2');

export interface Replay {
  B: any; D: any; M: any; E: any; PV: any; cfg: any; names: any;
  fitRows: any[];
  /** 'season:week' -> JSON of the state before that week's first regular-season game */
  snaps: Record<string, string>;
  vec(o: any, ns: string[]): number[];
  /** the frozen fair (home margin, total) of a game object priced from a frozen state with season S's weights */
  price(frozen: any, model: any, go: any, g: any): { margin: number; total: number };
}

export function frozenReplay(first: number, last: number): Replay {
  if (!fs.existsSync(path.join(V2, '.cache', 'raw', 'games.csv'))) {
    throw new Error('history not cached: run   CORE=1 bash football/research/nfl_v2/fetch_history.sh 2026   (on Windows: Git Bash or WSL)');
  }
  require(path.join(REPO, 'football', 'params.js'));
  require(path.join(REPO, 'football', 'nfl_params_v2.js'));
  const B = require(path.join(V2, 'backtest.js'));
  const D = require(path.join(V2, 'data.js'));
  const M = require(path.join(REPO, 'football', 'nfl_model.js'));
  const E = require(path.join(REPO, 'football', 'engine.js'));
  const PV = (globalThis as any).EDNflParamsV2;
  const cfg = M.config(PV.cfg);
  const names = M.featureNames(cfg);
  const vec = (o: any, ns: string[]) => ns.map((n) => (Number.isFinite(o[n]) ? o[n] : 0));
  const st = M.newState(cfg);
  const rows = D.teamRows(cfg.source), qb = D.qbRows();
  const fitRows: any[] = [];
  const snaps: Record<string, string> = {};
  for (const g of D.games()) {
    if (!g.done) continue;
    if (st.season !== g.season) M.seasonBreak(st, g.season);
    if (g.type === 'REG' && g.season >= first && g.season <= last) {
      const key = g.season + ':' + g.week;
      if (!(key in snaps)) snaps[key] = JSON.stringify(st);
    }
    if (g.season >= B.FIRST_TRAIN) {
      const F = M.features(st, B.gameObj(g));
      fitRows.push({ g, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa });
    }
    M.absorbCompleted(st, { home_team: g.home_raw, away_team: g.away_raw, home_score: g.home_score, away_score: g.away_score }, rows[g.id] || [], qb[g.id] || []);
    M.afterGame(st, B.gameObj(g));
  }
  const price = (frozen: any, model: any, go: any, g: any) => {
    const F = M.features(frozen, go);
    const pr = B.predictRows(model, [{ g, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa }])[0];
    return { margin: pr.margin, total: pr.total };
  };
  return { B, D, M, E, PV, cfg, names, fitRows, snaps, vec, price };
}

/* ===========================================================================
   THE SERVED NHL MODEL, AS THE SIMULATOR READS IT.

   No new game model. Each team's expected regulation goals (λ) come from the
   served chosen model (hockey/model/params/live.json `model`, the
   `xg_core` Poisson GLM on the point-in-time ratings of
   hockey/model/ratings.js, pair-recalibrated by glm.js
   applyPairCalibration) — the exact code path hockey/build_slate.js prices
   the slate with. The game distribution is hockey/model/distribution.js
   EDNHLDist.game: sixty minutes with score effects (the 60-minute home win,
   away win and TIE), then, for a tie, the overtime/shootout split:
     regular season  5-minute 3-on-3 sudden death (rate k x regulation rate),
                     then a shootout won by the home club at so_home
     playoffs        sudden death until a goal, won in proportion to the two
                     rates; never a shootout
   so a simulated game is one of six results (home or away; regulation,
   overtime or shootout), the classification standings points, regulation
   wins and ROW are counted from.

   THE 60-MINUTE DRAW. The served distribution under-prices the regulation
   tie (hockey/validation/nhl_walkforward.json: confirmation 20.3% predicted,
   22.4% observed). The distribution's own draw-inflation term (Karlis &
   Ntzoufras diagonal inflation, `draw_inflation`, OFF in the served price)
   is passed through when the snapshot carries a value; whether it does is
   decided by simulator/src/research/nhl_goal_distribution.ts under a rule
   written before that study ran (NHL_SIMULATOR_NOTES.md §Goal distribution).

   STRENGTH OFFSETS. A run moves a game by the two clubs' persistent offsets
   (d, on the log scale of the goal rate): λH' = λH·exp((dH − dA)/2),
   λA' = λA·exp((dA − dH)/2). With every offset zero the game is the served
   model exactly (an exact-key cache, no interpolation).

   TABLE. With offsets λ is continuous. The regulation outcome probabilities
   are tabulated lazily on a grid of (ln λH, ln λA) with step 0.02 and read by
   bilinear interpolation; every cell is EDNHLDist.game itself.
   simulator/tests/nhl_sim.test.ts bounds the interpolation error against the
   exact distribution (under 1e-4 on any probability, far inside the
   100,000-run sampling error). The overtime/shootout split is computed
   exactly for every game (it is closed-form in the two rates) and held equal
   to EDNHLDist.game's tie_split by the same test.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from '../nfl/model_adapter.ts';

const require = createRequire(import.meta.url);

let DIST: any = null;
/** hockey/model/distribution.js (EDNHLDist) */
export function hockeyDist(): any {
  if (!DIST) DIST = require(path.join(REPO, 'hockey', 'model', 'distribution.js'));
  return DIST;
}

export interface OtParams { format: 'R3v3' | 'R4v4'; k: number; so_home: number }
export interface DistParams {
  /** score-effect multipliers (hockey/model/params/live.json effects) */
  effects: unknown;
  /** regular-season overtime/shootout parameters (live.json ot) */
  ot: OtParams;
  /** 60-minute diagonal inflation (0 = the served distribution) */
  draw_inflation: number;
}

export const LN_STEP = 0.02;
export const LAMBDA_MIN = 0.5, LAMBDA_MAX = 10;
const LN_LO = Math.log(LAMBDA_MIN);
const NGRID = Math.ceil((Math.log(LAMBDA_MAX) - LN_LO) / LN_STEP) + 1;
const MAXG = 12, N1 = MAXG + 1;

export interface RegProbs { home: number; away: number; tie: number }
export interface TieSplit { ot_home: number; ot_away: number; so_home: number; so_away: number }

/** the served game distribution at one pair of rates */
export function exactGame(p: DistParams, lh: number, la: number, playoff = false): any {
  return hockeyDist().game({ lamH: lh, lamA: la, effects: p.effects, ot: playoff ? { format: 'PO' } : p.ot, draw_inflation: p.draw_inflation || 0 });
}

/** the overtime/shootout split of a tied game (sums to 1): EDNHLDist.game's tie_split, closed form */
export function tieSplit(p: DistParams, lh: number, la: number, playoff: boolean): TieSplit {
  if (playoff) { const h = lh / (lh + la); return { ot_home: h, ot_away: 1 - h, so_home: 0, so_away: 0 }; }
  const h60 = p.ot.k * lh / 60, a60 = p.ot.k * la / 60;
  const pGoal = 1 - Math.exp(-(h60 + a60) * 5);
  const pSo = 1 - pGoal;
  return { ot_home: pGoal * h60 / (h60 + a60), ot_away: pGoal * a60 / (h60 + a60), so_home: pSo * p.ot.so_home, so_away: pSo * (1 - p.ot.so_home) };
}

interface Cell { home: number; away: number; tie: number; m: Float64Array }

export class OutcomeTable {
  readonly p: DistParams;
  private cells: Array<Cell | undefined> = new Array(NGRID * NGRID);
  private ncells = 0;
  private exact = new Map<string, Cell>();
  builds = 0;
  clamped = 0;
  constructor(p: DistParams) {
    if (!p || !p.effects || !p.ot || !(p.ot.k > 0) || !(p.ot.so_home > 0 && p.ot.so_home < 1)) throw new Error('distribution parameters incomplete');
    if (!(p.draw_inflation >= 0 && p.draw_inflation < 1)) throw new Error('draw inflation out of range: ' + p.draw_inflation);
    this.p = p;
  }
  private compute(lh: number, la: number): Cell {
    const D = exactGame(this.p, lh, la);
    this.builds++;
    return { home: D.reg.home, away: D.reg.away, tie: D.reg.draw, m: D.reg_matrix as Float64Array };
  }
  private cell(i: number, j: number): Cell {
    const key = i * NGRID + j;
    let c = this.cells[key];
    if (!c) { c = this.compute(Math.exp(LN_LO + i * LN_STEP), Math.exp(LN_LO + j * LN_STEP)); this.cells[key] = c; this.ncells++; }
    return c;
  }
  /** the exact served distribution at (lh, la), cached by value (the zero-offset path) */
  exactAt(lh: number, la: number): Cell {
    const k = lh + ':' + la;
    let c = this.exact.get(k);
    if (!c) { c = this.compute(lh, la); this.exact.set(k, c); }
    return c;
  }
  private coord(l: number): number {
    let x = (Math.log(l) - LN_LO) / LN_STEP;
    if (!(x >= 0 && x <= NGRID - 1)) { this.clamped++; x = Math.max(0, Math.min(NGRID - 1, x || 0)); }
    return x;
  }
  /** regulation outcome probabilities; exact when `exact`, else bilinear on the grid */
  probs(lh: number, la: number, exact: boolean): RegProbs {
    if (exact) { const c = this.exactAt(lh, la); return { home: c.home, away: c.away, tie: c.tie }; }
    const x = this.coord(lh), y = this.coord(la);
    const i = Math.min(NGRID - 2, Math.floor(x)), j = Math.min(NGRID - 2, Math.floor(y));
    const fx = x - i, fy = y - j;
    const c00 = this.cell(i, j), c10 = this.cell(i + 1, j), c01 = this.cell(i, j + 1), c11 = this.cell(i + 1, j + 1);
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    return {
      home: w00 * c00.home + w10 * c10.home + w01 * c01.home + w11 * c11.home,
      away: w00 * c00.away + w10 * c10.away + w01 * c01.away + w11 * c11.away,
      tie: w00 * c00.tie + w10 * c10.tie + w01 * c01.tie + w11 * c11.tie
    };
  }
  /** the regulation score matrix nearest (lh, la) (the exact one at zero offset) */
  matrix(lh: number, la: number, exact: boolean): Float64Array {
    if (exact) return this.exactAt(lh, la).m;
    const i = Math.round(this.coord(lh)), j = Math.round(this.coord(la));
    return this.cell(i, j).m;
  }
  get size(): number { return this.ncells + this.exact.size; }
}

/** the rates of one game moved by the clubs' offsets */
export function offsetRates(lh: number, la: number, dHome: number, dAway: number): [number, number] {
  if (dHome === dAway) return [lh, la];
  const f = Math.exp((dHome - dAway) / 2);
  return [lh * f, la / f];
}

/**
 * Draw the 60-minute score of a game given how it ended at 60 minutes
 * (0 home ahead, 1 away ahead, 2 tied), from the regulation matrix.
 */
export function drawRegScore(m: Float64Array, cls: 0 | 1 | 2, u: number): [number, number] {
  let tot = 0;
  for (let h = 0; h < N1; h++) for (let a = 0; a < N1; a++) {
    const c = h > a ? 0 : h < a ? 1 : 2;
    if (c === cls) tot += m[h * N1 + a];
  }
  if (!(tot > 0)) throw new Error('no regulation mass for outcome class ' + cls);
  let acc = 0; const target = u * tot;
  let last: [number, number] = cls === 1 ? [0, 1] : cls === 0 ? [1, 0] : [0, 0];
  for (let h = 0; h < N1; h++) for (let a = 0; a < N1; a++) {
    const c = h > a ? 0 : h < a ? 1 : 2;
    if (c !== cls) continue;
    const p = m[h * N1 + a]; if (!(p > 0)) continue;
    acc += p; last = [h, a];
    if (acc >= target) return last;
  }
  return last;
}

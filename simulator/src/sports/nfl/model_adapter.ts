/* ===========================================================================
   THE SERVED NFL MODEL, AS THE SIMULATOR READS IT.

   No new game model. Every simulated NFL game is drawn from the served
   model's own outcome distribution: football/engine.js dist.coverProbSpread,
   the median-centred margin PMF of football/nfl_params_v2.js (the same
   distribution the board's win probability, moneyline and cover
   probabilities are read from). Its tie mass is the model's own (margin 0);
   no tie rate is invented.

   The distribution is read through the engine's PUBLIC function, one line at
   a time: P(margin >= k) = coverProbSpread(fair, k - 0.5).win, so the PMF is
   P(margin = k) = P(>= k) - P(>= k + 1). Nothing of the engine is copied.

   STRENGTH OFFSETS. A run moves a game's centre by the two clubs' persistent
   offsets (fair + d_home - d_away, in points of home margin, the unit the
   model's fair spread is in). The model is linear in its strength terms, so
   this is the same as shifting each club's rating contribution. With every
   offset zero the game is priced at the model's exact fair margin (an exact
   cache key), so a zero-offset run IS the model: simulator/tests/nfl_model.test.ts
   holds the adapter's P(home) + P(tie)/2 to predictGame's home_win_prob.

   CACHE. With offsets the centre is continuous; distributions are cached on a
   0.001-point grid of the centre (round half away from zero). That is the
   same as drawing each club's offset from a normal discretised to 0.001 of a
   point; the game itself is still priced by the exact model at that centre.
   The largest effect of the rounding on one game's win probability is
   measured by simulator/tests/nfl_model.test.ts (about 5e-5 at the key number
   3, where the table moves fastest), far inside the 100,000-run sampling
   error of a probability (up to 1.6e-3).
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export interface EngineHandle {
  E: any;           // football/engine.js API (EDFootball)
  PV: any;          // football/nfl_params_v2.js (EDNflParamsV2)
  P: any;           // football/params.js (EDFootballParams)
}

let ENGINE: EngineHandle | null = null;
/** load the shipped engine and parameters (the browser files, as Node modules) */
export function loadEngine(): EngineHandle {
  if (ENGINE) return ENGINE;
  require(path.join(REPO, 'football', 'params.js'));
  require(path.join(REPO, 'football', 'nfl_params_v2.js'));
  const E = require(path.join(REPO, 'football', 'engine.js'));
  require(path.join(REPO, 'football', 'nfl_model.js'));
  const g = globalThis as any;
  ENGINE = { E, PV: g.EDNflParamsV2, P: g.EDFootballParams };
  if (!ENGINE.PV || !ENGINE.PV.active || !ENGINE.PV.margin_pmf_by_spread) throw new Error('the served NFL v2 parameters are not active: the simulator prices only the served model');
  return ENGINE;
}

/** install a snapshot's margin table as the served table (what replay needs);
    returns a restore function */
export function withMarginTable(table: Record<string, Record<string, number>>): () => void {
  const H = loadEngine();
  const keep = H.PV.margin_pmf_by_spread;
  H.PV.margin_pmf_by_spread = table;
  return () => { H.PV.margin_pmf_by_spread = keep; };
}

export const MARGIN_LO = -90;
export const MARGIN_HI = 90;
const NBINS = MARGIN_HI - MARGIN_LO + 1;

export interface MarginDist {
  /** cdf[i] = P(margin <= MARGIN_LO + i) */
  cdf: Float64Array;
  pTie: number;
  pHome: number;  // P(margin > 0)
}

/** the engine's distribution at one fair home margin */
export function engineMarginDist(fair: number): MarginDist {
  const { E } = loadEngine();
  const ge = new Float64Array(NBINS + 1);   // ge[i] = P(margin >= MARGIN_LO + i)
  for (let i = 0; i <= NBINS; i++) {
    const k = MARGIN_LO + i;
    const c = E.dist.coverProbSpread('nfl', fair, k - 0.5);
    if (!c || c.basis !== 'margin_pmf_by_spread') throw new Error('the served margin table did not answer at fair ' + fair + ' (basis ' + (c && c.basis) + ')');
    ge[i] = c.win;
  }
  if (ge[0] < 1 - 1e-9 || ge[NBINS] > 1e-9) throw new Error('margin mass outside [' + MARGIN_LO + ', ' + MARGIN_HI + '] at fair ' + fair + ': ' + (1 - ge[0]) + ' / ' + ge[NBINS]);
  const cdf = new Float64Array(NBINS);
  let acc = 0;
  for (let i = 0; i < NBINS; i++) {
    let p = ge[i] - ge[i + 1];
    if (p < 0) { if (p < -1e-12) throw new Error('negative mass at margin ' + (MARGIN_LO + i)); p = 0; }
    acc += p;
    cdf[i] = acc;
  }
  if (Math.abs(acc - 1) > 1e-9) throw new Error('margin distribution sums to ' + acc + ' at fair ' + fair);
  for (let i = 0; i < NBINS; i++) cdf[i] /= acc;
  cdf[NBINS - 1] = 1;
  const i0 = -MARGIN_LO;
  const pTie = cdf[i0] - cdf[i0 - 1];
  return { cdf, pTie, pHome: 1 - cdf[i0] };
}

/** grid points per point of margin */
export const GRID = 1000;

export class MarginCache {
  private exact = new Map<number, MarginDist>();
  private grid = new Map<number, MarginDist>();
  builds = 0;
  /** the exact distribution at a fair margin (no rounding) */
  exactAt(fair: number): MarginDist {
    let d = this.exact.get(fair);
    if (!d) { d = engineMarginDist(fair); this.exact.set(fair, d); this.builds++; }
    return d;
  }
  /** the distribution at a centre rounded to 0.001 point */
  gridAt(centre: number): MarginDist {
    const k = centre >= 0 ? Math.floor(centre * GRID + 0.5) : -Math.floor(-centre * GRID + 0.5);
    let d = this.grid.get(k);
    if (!d) { d = engineMarginDist(k / GRID); this.grid.set(k, d); this.builds++; }
    return d;
  }
  at(fair: number, offset: number): MarginDist {
    return offset === 0 ? this.exactAt(fair) : this.gridAt(fair + offset);
  }
}

/** inverse-CDF draw of a home margin from u in (0,1) */
export function drawMargin(d: MarginDist, u: number): number {
  const c = d.cdf;
  let lo = 0, hi = c.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (c[mid] >= u) hi = mid; else lo = mid + 1; }
  return MARGIN_LO + lo;
}

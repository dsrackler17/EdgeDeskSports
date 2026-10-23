/* ===========================================================================
   THE SERVED NBA GAME DISTRIBUTION AT ANY MEAN, FAST AND EXACT ENOUGH.

   A simulated game's regulation-margin mean is the served model's plus the
   two clubs' strength offsets and any availability shift — continuous. Its
   distribution is the served one at that mean: nba/model/distribution.js
   marginals() with the season calibration's spread rule sd(mu)
   (nba/model/dist_fit.js sdOf), the end-game shape theta and the overtime
   parameters — the FINAL margin, overtime included, never 0.

     P(home win)   the served P(margin > 0) on a 0.01-point grid of the mean,
                   linearly interpolated (the function is smooth: the largest
                   interpolation error, measured by simulator/tests/nba_model.test.ts,
                   is below 1e-6)
     the margin    given the winner, from the served pmf at the mean rounded
                   to 0.1 point. Only the point-differential tiebreak reads a
                   margin; the winner never depends on this rounding.
   Tables are built lazily and cached per worker.
   =========================================================================== */
import { nbaModules, marginTable } from './model_adapter.ts';

const P_STEP = 0.01, M_STEP = 0.1, LIM = 60;

export class NbaGameDist {
  private model: { calibration: { sd_m: any }; shape: any; ot: any };
  private pGrid = new Map<number, number>();
  private mGrid = new Map<number, { lo: number; cdfHome: Float64Array; cdfAway: Float64Array }>();
  builds = 0;
  constructor(model: { calibration: { sd_m: any }; shape: any; ot: any }) { this.model = model; }
  /** the served distribution parameters at a regulation-margin mean */
  params(mu: number): any {
    const { DF } = nbaModules();
    return { mu_m: mu, sd_m: DF.sdOf(this.model.calibration.sd_m, mu), theta: this.model.shape.theta, ot: this.model.ot, mu_t: 220, sd_t: 18, gamma: 0 };
  }
  /** the exact served P(home win) at a mean (no grid) */
  exactPHome(mu: number): number { return marginTable(this.params(mu)).pHome; }
  private pAt(i: number): number {
    let v = this.pGrid.get(i);
    if (v === undefined) { v = this.exactPHome(i * P_STEP); this.pGrid.set(i, v); this.builds++; }
    return v;
  }
  pHome(mu: number): number {
    const x = Math.max(-LIM, Math.min(LIM, mu)) / P_STEP, i = Math.floor(x), w = x - i;
    const a = this.pAt(i);
    return w === 0 ? a : a + w * (this.pAt(i + 1) - a);
  }
  /** a final margin given the winner, from u in (0,1) */
  drawMargin(mu: number, homeWins: boolean, u: number): number {
    const c = Math.max(-LIM, Math.min(LIM, mu));
    const k = c >= 0 ? Math.floor(c / M_STEP + 0.5) : -Math.floor(-c / M_STEP + 0.5);
    let t = this.mGrid.get(k);
    if (!t) {
      const mt = marginTable(this.params(k * M_STEP));
      const n = mt.cdf.length, z = -mt.lo;   /* index of margin 0 */
      const pmf = new Float64Array(n); for (let i = 0; i < n; i++) pmf[i] = mt.cdf[i] - (i ? mt.cdf[i - 1] : 0);
      const cdfHome = new Float64Array(n - z - 1), cdfAway = new Float64Array(z);
      let s = 0; for (let i = z + 1; i < n; i++) s += pmf[i];
      let acc = 0; for (let i = z + 1; i < n; i++) { acc += pmf[i]; cdfHome[i - z - 1] = acc / s; }
      cdfHome[cdfHome.length - 1] = 1;
      let s2 = 0; for (let i = 0; i < z; i++) s2 += pmf[i];
      acc = 0; for (let i = z - 1; i >= 0; i--) { acc += pmf[i]; cdfAway[z - 1 - i] = acc / s2; }
      cdfAway[cdfAway.length - 1] = 1;
      t = { lo: mt.lo, cdfHome, cdfAway }; this.mGrid.set(k, t); this.builds++;
    }
    const cdf = homeWins ? t.cdfHome : t.cdfAway;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cdf[mid] >= u) hi = mid; else lo = mid + 1; }
    return homeWins ? lo + 1 : -(lo + 1);
  }
}

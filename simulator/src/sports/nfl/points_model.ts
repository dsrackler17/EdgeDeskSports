/* ===========================================================================
   SCORING-BASED TIEBREAK INPUTS (combined points rankings) — Estimated.

   The NFL's 7th and 8th tiebreak steps rank clubs by points scored and
   allowed, which needs every game's SCORE, not only its margin. The served
   margin model does not produce scores. EdgeDesk's linemaker does: its NFL
   team-points distributions (lib/edgedesk_fairline.js KERNEL_JOINT, fitted
   by tools/football/linemaker_calibrate.js and recorded with status
   CALIBRATED for team totals in football/validation/linemaker_nfl.json) are
   each club's points as a kernel-weighted distribution of real NFL scores
   given its projected points.

   A simulated game's margin is already drawn from the served model. Its
   score is then drawn from the linemaker's two team distributions
   CONDITIONED on that margin:
       P(home = h | margin = m)  proportional to  H(h) * A(h - m)
   so the score always agrees with the margin the standings used, and the
   points model only splits it into two scores. Completed games keep their
   real scores.

   Drawn only when a tie actually reaches a points step (it is rare: none of
   2002-2025's real ties did), from its own PRNG stream, so whether it is
   drawn never changes any other number in the run. Every run that uses it is
   counted and the reader labels the input Estimated.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from './model_adapter.ts';
import type { Xoshiro128 } from '../../core/prng.ts';

const require = createRequire(import.meta.url);

export interface TeamPmf { lo: number; p: number[] }

let FL: any = null;
function fairline(): any {
  if (FL) return FL;
  require(path.join(REPO, 'lib', 'research_core.js'));
  FL = require(path.join(REPO, 'lib', 'edgedesk_fairline.js'));
  return FL;
}

export class PointsModel {
  live: any;
  private memo = new Map<string, { home: TeamPmf; away: TeamPmf } | null>();
  constructor(live: any) {
    if (!live || !live.markets || !live.team_grid) throw new Error('the linemaker record has no live block');
    const tt = live.markets.team_total;
    if (!tt || tt.method !== 'KERNEL_JOINT') throw new Error('the NFL team-total method is ' + (tt && tt.method) + ', not KERNEL_JOINT: scores cannot be drawn');
    this.live = live;
  }
  /** the two team-points PMFs at a game's projected (home margin, total) */
  teams(margin: number, total: number): { home: TeamPmf; away: TeamPmf } | null {
    const key = (Math.round(margin * 100) / 100) + '|' + (Math.round(total * 100) / 100);
    if (this.memo.has(key)) return this.memo.get(key) as { home: TeamPmf; away: TeamPmf } | null;
    const d = fairline().distributions({ home_margin: margin, total }, this.live);
    const out = d && !d.error && d.home && d.away ? { home: { lo: d.home.lo, p: d.home.p }, away: { lo: d.away.lo, p: d.away.p } } : null;
    if (this.memo.size > 50000) this.memo.clear();
    this.memo.set(key, out);
    return out;
  }
  /** draw (home, away) points whose difference is exactly `m` */
  drawGivenMargin(margin: number, total: number, m: number, rng: Xoshiro128): [number, number] | null {
    const T = this.teams(margin, total);
    if (!T) return null;
    const H = T.home, A = T.away;
    let tot = 0;
    const w: number[] = [];
    for (let i = 0; i < H.p.length; i++) {
      const h = H.lo + i, a = h - m, j = a - A.lo;
      const x = a >= 0 && j >= 0 && j < A.p.length ? H.p[i] * A.p[j] : 0;
      w.push(x); tot += x;
    }
    if (!(tot > 0)) return null;
    let u = rng.nextDouble() * tot, last = -1;
    for (let i = 0; i < w.length; i++) {
      if (!(w[i] > 0)) continue;
      last = i; u -= w[i];
      if (u < 0) return [H.lo + i, H.lo + i - m];
    }
    return last >= 0 ? [H.lo + last, H.lo + last - m] : null;
  }
}

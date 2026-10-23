/* ===========================================================================
   Two engine hooks every sport shares, each OFF unless evidence turns it on.

   AVAILABILITY TRAJECTORIES. For a sport whose game model accepts player
   availability, each injury's return period is drawn ONCE per simulated
   season from an OWNED, documented distribution, and that one draw decides
   every affected game of the run. A distribution without a named source is
   refused: a label like "questionable" is not a return probability. No sport
   is active with availability sampling today (the NFL runs with it OFF).

   STRENGTH DRIFT. A within-season random-walk hook. It is refused unless the
   configuration names validation evidence; no sport has any, so every active
   configuration runs with drift OFF and the hook is a no-op.
   =========================================================================== */
import type { Xoshiro128 } from './prng.ts';

export interface ReturnDistribution {
  /** the period (week, game day, round) from which the player is available, with its probability */
  periods: Array<{ period: number; probability: number }>;
  /** probability the player does not return this season */
  out_for_season: number;
  /** where the distribution came from (an owned, timestamped table) */
  source: string;
}
export interface Injury { player_id: string; team: string; dist: ReturnDistribution }

export class AvailabilityPlan {
  private ret = new Map<string, number>();   // player -> first available period (Infinity = out)
  constructor(injuries: Injury[], rng: Xoshiro128) {
    for (const inj of injuries) {
      const d = inj.dist;
      if (!d || !d.source || !String(d.source).trim()) throw new Error('availability: no owned source for the return distribution of ' + inj.player_id);
      const total = d.periods.reduce((a, p) => a + p.probability, 0) + d.out_for_season;
      if (!(Math.abs(total - 1) < 1e-9) || d.periods.some((p) => !(p.probability >= 0)) || !(d.out_for_season >= 0)) throw new Error('availability: the return distribution of ' + inj.player_id + ' does not sum to 1');
      let u = rng.nextDouble(), at = Infinity;
      for (const p of d.periods.slice().sort((a, b) => a.period - b.period)) { u -= p.probability; if (u < 0) { at = p.period; break; } }
      this.ret.set(inj.player_id, at);
    }
  }
  /** whether a player is available in a period: the same answer for every game of the run */
  available(player: string, period: number): boolean {
    const r = this.ret.get(player);
    return r === undefined ? true : period >= r;
  }
  returnPeriod(player: string): number | undefined { return this.ret.get(player); }
}

export interface DriftConfig { mode: 'off' | 'random_walk'; per_period_sd?: number; evidence?: string }
/** the drift hook: a no-op when off; refuses to run without named evidence */
export function applyDrift(cfg: DriftConfig, offsets: Float64Array, rng: Xoshiro128, normal: (u: number) => number): void {
  if (cfg.mode === 'off') return;
  if (!cfg.evidence || !String(cfg.evidence).trim()) throw new Error('strength drift is not validated: no evidence named, so it cannot run');
  const sd = cfg.per_period_sd as number;
  if (!(sd > 0)) throw new Error('strength drift needs a positive per-period sd');
  for (let i = 0; i < offsets.length; i++) offsets[i] += sd * normal(rng.nextOpen());
}

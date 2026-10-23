/* ===========================================================================
   Binomial statistics for simulated outcome frequencies.

   probability = count / N.
   MCSE (Monte Carlo standard error) = sqrt(p (1 - p) / N): the sampling
   error of the simulation itself, ONLY. It says nothing about whether the
   model is right; it shrinks to zero as N grows while the model's own error
   does not.

   At p = 0 or p = 1 the MCSE is exactly 0, which would read as certainty, so
   every outcome also carries a Wilson score interval (95%), whose bounds stay
   strictly inside (0, 1) unless N is tiny. A zero count is reported as
   "0 of N, Wilson upper bound u", never as "impossible".
   =========================================================================== */

/** z for a two-sided 95% interval */
export const Z95 = 1.959963984540054;

export function mcse(p: number, n: number): number {
  if (!(n > 0)) throw new Error('mcse: n must be positive');
  if (!(p >= 0 && p <= 1)) throw new Error('mcse: p out of [0,1]: ' + p);
  return Math.sqrt(p * (1 - p) / n);
}

/** Wilson score interval for k successes in n trials */
export function wilson(k: number, n: number, z: number = Z95): { lo: number; hi: number } {
  if (!(n > 0) || !(k >= 0) || k > n) throw new Error('wilson: bad counts ' + k + '/' + n);
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  /* the interval always contains the estimate, exactly: rounding at k = 0 or
     k = n must never put a bound on the wrong side of it */
  const lo = k === 0 ? 0 : Math.min(p, Math.max(0, centre - half));
  const hi = k === n ? 1 : Math.max(p, Math.min(1, centre + half));
  return { lo, hi };
}

export interface OutcomeStat {
  count: number;
  n: number;
  probability: number;
  mcse: number;
  wilson_lo: number;
  wilson_hi: number;
}

export function outcomeStat(count: number, n: number): OutcomeStat {
  const p = count / n, w = wilson(count, n);
  return { count, n, probability: p, mcse: mcse(p, n), wilson_lo: w.lo, wilson_hi: w.hi };
}

/** model fair decimal odds = 1 / p; undefined (null) at p = 0, exactly 1 at p = 1 */
export function fairDecimal(p: number): number | null {
  if (!(p >= 0 && p <= 1)) throw new Error('fairDecimal: p out of [0,1]');
  if (p === 0) return null;
  return 1 / p;
}

/* -------------------------------------------------------------- scoring
   Probability clipping for log loss: a simulated 0 or 1 is clipped to
   [eps, 1 - eps] with eps = max(1e-6, 0.5 / N) — half of one simulated
   season — because a zero count from N runs means "below about 1/N", not
   "impossible". The clip is reported beside every log loss. */
export function logLossClip(n: number): number {
  return Math.max(1e-6, 0.5 / n);
}
export function brier(p: number, y: 0 | 1): number {
  return (p - y) * (p - y);
}
export function logLoss(p: number, y: 0 | 1, eps: number): number {
  const q = Math.min(1 - eps, Math.max(eps, p));
  return y === 1 ? -Math.log(q) : -Math.log(1 - q);
}

// ============================================================================
// EdgeDesk : model_predict / core / rng
//
// Deterministic randomness (spec §24).
//
// v1.2 called Math.random() directly, so two runs of the same slate produced
// two different sets of probabilities and no test could pin the simulator. The
// draw functions are unchanged — same algorithms, same distributions — but the
// uniform stream is now injectable. `?seed=12345` makes a run reproducible;
// production without a seed draws one from crypto and REPORTS it, so any live
// run can be replayed exactly.
//
// This is a stream change, not a distribution change. mulberry32 is a uniform
// [0,1) generator with a period of 2^32 and passes the smallcrunch battery;
// substituting it for Math.random leaves every distribution below identical in
// law. The MLB regression test asserts that directly.
// ============================================================================

import type { Rng } from "./types.ts";

/** mulberry32 — small, fast, seedable, and good enough for Monte Carlo. */
export function makeRng(seed?: number): Rng {
  let s: number;
  if (seed != null && Number.isFinite(seed)) {
    s = seed >>> 0;
  } else {
    const buf = new Uint32Array(1);
    const g = globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => void } };
    if (g.crypto && typeof g.crypto.getRandomValues === "function") g.crypto.getRandomValues(buf);
    else buf[0] = (Math.random() * 0x100000000) >>> 0;
    s = buf[0] >>> 0;
  }
  const reported = s;
  let a = s >>> 0;
  return {
    seed: reported,
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Knuth Poisson. Identical to v1.2's pois(), with the uniform stream injected. */
export function poisson(rng: Rng, lam: number): number {
  if (!(lam > 0)) return 0;
  // Guard the multiplicative form against underflow on large means.
  if (lam > 500) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss(rng)));
  const L = Math.exp(-lam);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

/** standard normal, Box-Muller. Identical to v1.2's gauss(). */
export function gauss(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape k, scale th), Marsaglia-Tsang. Identical to v1.2's gammaDraw(). */
export function gammaDraw(rng: Rng, k: number, th: number): number {
  if (k < 1) return gammaDraw(rng, k + 1, th) * Math.pow(rng.next(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = gauss(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * th;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * th;
  }
}

/**
 * Negative binomial run count as a Gamma-Poisson mixture.
 *
 * Identical to v1.2's runDraw(). `disp` is variance/mean; 1.0 collapses to a
 * plain Poisson, which is exactly v1.0 behaviour. See the v1.1 note in the MLB
 * model for why MLB run totals need the extra right skew.
 */
export function negBinomial(rng: Rng, lam: number, disp: number): number {
  if (!(disp > 1.0001) || lam <= 0) return poisson(rng, lam);
  const th = disp - 1;
  return poisson(rng, gammaDraw(rng, lam / th, th));
}

/** Draw from a discrete distribution given as [value, weight] pairs. */
export function categorical(rng: Rng, pairs: Array<[number, number]>): number {
  let total = 0;
  for (const p of pairs) total += p[1];
  if (!(total > 0)) return pairs.length ? pairs[0][0] : 0;
  let u = rng.next() * total;
  for (const p of pairs) {
    u -= p[1];
    if (u <= 0) return p[0];
  }
  return pairs[pairs.length - 1][0];
}

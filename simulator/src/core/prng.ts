/* ===========================================================================
   THE SIMULATOR'S ONLY SOURCE OF RANDOMNESS.

   Generator: xoshiro128** 1.1 (D. Blackman and S. Vigna, "Scrambled linear
   pseudorandom number generators", ACM TOMS 47(4), 2021; reference C at
   https://prng.di.unimi.it/xoshiro128starstar.c). 128 bits of state, period
   2^128 - 1, 32-bit outputs, every operation a 32-bit integer one, so the
   sequence is bit-identical on every platform Node runs on.

   Seeding: SplitMix64 (Steele, Lea, Flood 2014; the seeding generator the
   xoshiro authors recommend). A stream is named by
       (master seed, run index, stream id)
   and its state is four 32-bit words drawn from SplitMix64 started at a key
   mixed from the three. Every simulated season therefore owns its own
   streams: the result of run r never depends on which worker ran it, in
   what order, or how many runs came before. That is what makes a parallel
   run identical to a serial one.

   Math.random is never used anywhere in the simulator (a test greps for it).
   =========================================================================== */

export const PRNG_VERSION = 'xoshiro128starstar-1.1/splitmix64-seed/v1';

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

/** One SplitMix64 step: returns [next state, output]. */
export function splitmix64(state: bigint): [bigint, bigint] {
  const s = (state + GOLDEN) & MASK64;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return [s, z];
}

/** The SplitMix64 finaliser alone, used to mix the stream name into a key. */
function mix64(x: bigint): bigint {
  let z = x & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

/** Parse a master seed: a decimal or 0x-hex string, or a safe integer. */
export function parseSeed(seed: string | number | bigint): bigint {
  if (typeof seed === 'bigint') {
    if (seed < 0n || seed > MASK64) throw new Error('seed must be an unsigned 64-bit integer');
    return seed;
  }
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a non-negative safe integer');
    return BigInt(seed);
  }
  const s = String(seed).trim();
  if (!/^(0x[0-9a-fA-F]{1,16}|[0-9]{1,20})$/.test(s)) throw new Error('seed must be a decimal or 0x-hex unsigned 64-bit integer: ' + s);
  const v = BigInt(s);
  if (v > MASK64) throw new Error('seed exceeds 64 bits');
  return v;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Xoshiro128 {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  constructor(s0: number, s1: number, s2: number, s3: number) {
    if ((s0 | s1 | s2 | s3) === 0) throw new Error('xoshiro128** state must not be all zero');
    this.s0 = s0 >>> 0; this.s1 = s1 >>> 0; this.s2 = s2 >>> 0; this.s3 = s3 >>> 0;
  }
  /** the next 32-bit output, as an unsigned integer */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }
  /** a double uniform on [0, 1) with 53 random bits */
  nextDouble(): number {
    const a = this.nextU32() >>> 5, b = this.nextU32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }
  /** a double uniform on the open interval (0, 1): never 0, never 1 */
  nextOpen(): number {
    let u = this.nextDouble();
    while (u === 0) u = this.nextDouble();
    return u;
  }
  /** an integer uniform on [0, n) without modulo bias (n <= 2^32) */
  nextInt(n: number): number {
    if (!(n >= 1 && n <= 4294967296 && Number.isInteger(n))) throw new Error('nextInt: bad bound ' + n);
    const limit = 4294967296 - (4294967296 % n);
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return x % n;
  }
}

/** Stream ids. Fixed numbers: changing one changes every published result. */
export const STREAM = {
  strength: 1,      // persistent per-team latent strength offsets
  games: 2,         // regular-season game outcomes
  postseason: 3,    // postseason game outcomes
  coin: 4,          // tiebreaker coin tosses
  overtime: 5,      // postseason overtime resolution of the model's tie mass
  points: 6,        // scoring-based tiebreak inputs (drawn only when a tie reaches them)
  availability: 7,  // injury return draws (reserved: no sport samples availability today)
  drift: 8,         // within-season strength drift (reserved: OFF, see config)
  committee: 9      // the CFB committee proxy: its parameter draw and ranking noise
} as const;

/** The generator for (master seed, run index, stream id). */
export function streamFor(master: bigint, run: number, stream: number): Xoshiro128 {
  if (!Number.isSafeInteger(run) || run < 0) throw new Error('run index must be a non-negative integer');
  if (!Number.isSafeInteger(stream) || stream < 0) throw new Error('stream id must be a non-negative integer');
  let key = mix64(master ^ mix64(BigInt(run) * 0xd1b54a32d192ed03n + 1n));
  key = mix64(key ^ mix64((BigInt(stream) + 1n) * 0x8cb92ba72f3d8dd7n));
  let st = key;
  const [s1, o1] = splitmix64(st); st = s1;
  const [, o2] = splitmix64(st);
  const w0 = Number(o1 & 0xffffffffn), w1 = Number(o1 >> 32n), w2 = Number(o2 & 0xffffffffn), w3 = Number(o2 >> 32n);
  if ((w0 | w1 | w2 | w3) === 0) return new Xoshiro128(1, 0, 0, 0);
  return new Xoshiro128(w0, w1, w2, w3);
}

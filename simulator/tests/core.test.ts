/* Core: the PRNG against its reference vectors, stream independence and
   determinism, the normal quantile, the binomial statistics and canonical
   hashing. node simulator/tests/core.test.ts */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kit } from './_kit.ts';
import { Xoshiro128, splitmix64, streamFor, parseSeed, STREAM } from '../src/core/prng.ts';
import { normalQuantile, normalCdf } from '../src/core/normal.ts';
import { mcse, wilson, outcomeStat, fairDecimal, logLossClip, logLoss } from '../src/core/stats.ts';
import { canonicalJson, hashCanonical } from '../src/core/canonical.ts';

const T = kit('simulator core');
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* xoshiro128** from state {1,2,3,4}: the first three outputs worked by hand
   from the reference C (11520, 0, 5927040) — see the derivation in
   SIMULATOR_NOTES.md §Engine */
{
  const g = new Xoshiro128(1, 2, 3, 4);
  T.eq('xoshiro128** reference outputs from state {1,2,3,4}', [g.nextU32(), g.nextU32(), g.nextU32()], [11520, 0, 5927040]);
}
/* SplitMix64 from 0: 0xE220A8397B1DCDAF, the published first output */
{
  const [, o] = splitmix64(0n);
  T.eq('splitmix64(0) first output', o.toString(16), 'e220a8397b1dcdaf');
}
T.throws('an all-zero state is refused', () => new Xoshiro128(0, 0, 0, 0), /all zero/);
T.eq('seeds parse as decimal and hex', [parseSeed('20261023').toString(), parseSeed('0xff').toString(), parseSeed(7).toString()], ['20261023', '255', '7']);
T.throws('a negative seed is refused', () => parseSeed(-1));
T.throws('a seed over 64 bits is refused', () => parseSeed('0x1ffffffffffffffff'));
T.throws('a non-numeric seed is refused', () => parseSeed('abc'));

/* determinism: the same (seed, run, stream) gives the same sequence */
{
  const a = streamFor(42n, 7, STREAM.games), b = streamFor(42n, 7, STREAM.games);
  const sa = Array.from({ length: 50 }, () => a.nextU32()), sb = Array.from({ length: 50 }, () => b.nextU32());
  T.eq('same seed, run and stream: identical sequence', sa, sb);
  const c = streamFor(42n, 8, STREAM.games), d = streamFor(42n, 7, STREAM.coin), e = streamFor(43n, 7, STREAM.games);
  T.chk('another run differs', c.nextU32() !== streamFor(42n, 7, STREAM.games).nextU32());
  T.chk('another stream differs', d.nextU32() !== streamFor(42n, 7, STREAM.games).nextU32());
  T.chk('another seed differs', e.nextU32() !== streamFor(42n, 7, STREAM.games).nextU32());
}
/* uniformity sanity: 200k doubles, mean ~ 0.5, decile counts within 5 sigma */
{
  const g = streamFor(1n, 0, 1), n = 200000, bins = new Array(10).fill(0);
  let s = 0, mn = 1, mx = 0;
  for (let i = 0; i < n; i++) { const u = g.nextDouble(); s += u; bins[Math.floor(u * 10)]++; if (u < mn) mn = u; if (u > mx) mx = u; }
  T.near('uniform mean', s / n, 0.5, 5 * Math.sqrt(1 / 12 / n));
  const sd = Math.sqrt(n * 0.1 * 0.9);
  T.chk('uniform deciles within 5 sigma', bins.every((b) => Math.abs(b - n / 10) < 5 * sd), bins);
  T.chk('doubles stay in [0,1)', mn >= 0 && mx < 1);
  const h = streamFor(9n, 3, 2), counts = new Array(7).fill(0);
  for (let i = 0; i < 70000; i++) counts[h.nextInt(7)]++;
  T.chk('nextInt(7) is unbiased within 5 sigma', counts.every((c) => Math.abs(c - 10000) < 5 * Math.sqrt(70000 * (1 / 7) * (6 / 7))), counts);
}
/* the normal quantile */
T.near('Phi^-1(0.975)', normalQuantile(0.975), 1.959963984540054, 1e-12);
T.near('Phi^-1(0.5)', normalQuantile(0.5), 0, 1e-15);
T.near('Phi^-1(1e-10)', normalQuantile(1e-10), -6.361340902404056, 1e-9);
T.near('Phi(Phi^-1(0.3))', normalCdf(normalQuantile(0.3)), 0.3, 2e-7);
T.throws('Phi^-1(0) is refused', () => normalQuantile(0));
/* binomial statistics */
T.near('MCSE at p=0.3, N=100000', mcse(0.3, 100000), Math.sqrt(0.21 / 100000), 1e-15);
T.eq('MCSE is 0 at p=0 (the interval carries the uncertainty)', mcse(0, 100000), 0);
{
  const w = wilson(0, 100000);
  T.chk('Wilson at 0/100000: lower 0, upper > 0', w.lo === 0 && w.hi > 0 && w.hi < 1e-4, w);
  const w1 = wilson(100000, 100000);
  T.chk('Wilson at N/N: upper 1, lower < 1', w1.hi === 1 && w1.lo < 1 && w1.lo > 0.9999, w1);
  const w2 = wilson(30, 100);
  T.near('Wilson 30/100 lower (published value 0.2189)', w2.lo, 0.2189, 1e-4);
  T.near('Wilson 30/100 upper (published value 0.3958)', w2.hi, 0.3958, 1e-4);
  const st = outcomeStat(25000, 100000);
  T.chk('outcomeStat carries count, n, p, MCSE, interval', st.count === 25000 && st.n === 100000 && st.probability === 0.25 && st.wilson_lo < 0.25 && st.wilson_hi > 0.25);
}
T.eq('fair odds at p=0 are undefined, not infinite', fairDecimal(0), null);
T.eq('fair odds at p=1 are exactly 1', fairDecimal(1), 1);
T.near('fair odds at p=0.25', fairDecimal(0.25) as number, 4, 1e-12);
T.eq('log-loss clip is half a simulated season', logLossClip(100000), 5e-6);
T.chk('log loss of a simulated 0 that happened is finite', Number.isFinite(logLoss(0, 1, logLossClip(1000))));
/* canonical JSON */
T.eq('canonical JSON sorts keys and drops whitespace', canonicalJson({ b: 1, a: [1, { d: 2, c: -0 }] }), '{"a":[1,{"c":0,"d":2}],"b":1}');
T.throws('canonical JSON refuses NaN', () => canonicalJson({ a: NaN }), /non-finite/);
T.throws('canonical JSON refuses undefined in arrays', () => canonicalJson([1, undefined]), /undefined/);
T.chk('equal content, equal hash', hashCanonical({ x: 1, y: 2 }) === hashCanonical({ y: 2, x: 1 }));
/* Math.random never appears in the simulator's source */
{
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((f) => {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
  });
  walk(path.join(HERE, '..', 'src'));
  const offenders = files.filter((f) => /Math\.random\s*\(/.test(fs.readFileSync(f, 'utf8')));
  T.chk('no Math.random anywhere in simulator/src', files.length >= 5 && offenders.length === 0, { files: files.length, offenders });
}
process.exit(T.done());

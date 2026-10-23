/* The two engine hooks: availability trajectories and strength drift.
   node simulator/tests/hooks.test.ts */
import { kit } from './_kit.ts';
import { AvailabilityPlan, applyDrift, type Injury } from '../src/core/hooks.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';
import { normalQuantile } from '../src/core/normal.ts';

const T = kit('engine hooks');
const SRC = 'owned table simulator/fixtures/test_returns.json (TEST ONLY), retrieved 2026-10-23';
const inj = (player_id: string, periods: Array<[number, number]>, out: number, source = SRC): Injury =>
  ({ player_id, team: 'AAA', dist: { periods: periods.map(([period, probability]) => ({ period, probability })), out_for_season: out, source } });

/* 1 refusals: no owned source, a distribution that does not sum to 1, a negative probability */
{
  const rng = streamFor(1n, 0, STREAM.availability);
  T.throws('a return distribution with no named source is refused', () => new AvailabilityPlan([inj('p1', [[9, 1]], 0, '')], rng), /no owned source/);
  T.throws('a whitespace source is refused', () => new AvailabilityPlan([inj('p1', [[9, 1]], 0, '   ')], rng), /no owned source/);
  T.throws('a distribution summing to 0.9 is refused', () => new AvailabilityPlan([inj('p1', [[9, 0.5], [10, 0.3]], 0.1)], rng), /does not sum to 1/);
  T.throws('a negative probability is refused', () => new AvailabilityPlan([inj('p1', [[9, 1.2], [10, -0.2]], 0)], rng), /does not sum to 1/);
  T.throws('a negative out-for-season probability is refused', () => new AvailabilityPlan([inj('p1', [[9, 1.1]], -0.1)], rng), /does not sum to 1/);
}
/* 2 one draw per injury per run, and that draw decides every period of the run */
{
  const injuries = [inj('qb', [[9, 0.25], [11, 0.25], [14, 0.25]], 0.25), inj('wr', [[10, 0.5], [12, 0.5]], 0)];
  let consistent = true, monotone = true, consumed = true;
  for (let run = 0; run < 400; run++) {
    const rng = streamFor(77n, run, STREAM.availability);
    const plan = new AvailabilityPlan(injuries, rng);
    /* the plan consumed exactly one uniform per injury: the stream's next value is its third */
    const fresh = streamFor(77n, run, STREAM.availability); fresh.nextDouble(); fresh.nextDouble();
    if (rng.nextDouble() !== fresh.nextDouble()) consumed = false;
    for (const p of ['qb', 'wr']) {
      const r = plan.returnPeriod(p);
      let prev = false;
      for (let w = 1; w <= 18; w++) {
        const a = plan.available(p, w);
        if (a !== plan.available(p, w)) consistent = false;           // asked twice, same answer
        if (a !== (r !== undefined && w >= r)) consistent = false;    // the one drawn return period decides it
        if (prev && !a) monotone = false;                             // once back, back for the rest of the run
        prev = a;
      }
    }
  }
  T.chk('every query in a run agrees with the one drawn return period', consistent);
  T.chk('a returned player stays available for every later period of the run', monotone);
  T.chk('the plan draws exactly one uniform per injury (stream position checked)', consumed);
}
/* 3 the return-period frequencies equal the owned distribution (40,000 runs, 5 standard errors) */
{
  const injuries = [inj('qb', [[9, 0.2], [11, 0.3], [14, 0.1]], 0.4)];
  const N = 40000, count: Record<string, number> = {};
  for (let run = 0; run < N; run++) {
    const r = new AvailabilityPlan(injuries, streamFor(2026n, run, STREAM.availability)).returnPeriod('qb') as number;
    const k = Number.isFinite(r) ? String(r) : 'out'; count[k] = (count[k] || 0) + 1;
  }
  for (const [k, p] of [['9', 0.2], ['11', 0.3], ['14', 0.1], ['out', 0.4]] as Array<[string, number]>) {
    const se = Math.sqrt(p * (1 - p) / N);
    T.near('P(return ' + k + ') = ' + p, (count[k] || 0) / N, p, 5 * se);
  }
  const plan = new AvailabilityPlan([inj('gone', [], 1)], streamFor(1n, 0, STREAM.availability));
  T.chk('out for the season: never available', [1, 9, 18, 99].every((w) => !plan.available('gone', w)));
  T.chk('a player with no injury entry is always available', plan.available('someone_else', 1) && plan.returnPeriod('someone_else') === undefined);
}
/* 4 determinism: the same (seed, run) gives the same plan; another run gives an independent one */
{
  const injuries = [inj('a', [[2, 0.5], [3, 0.5]], 0), inj('b', [[2, 0.5], [3, 0.5]], 0), inj('c', [[2, 0.5], [3, 0.5]], 0)];
  const at = (run: number) => injuries.map((i) => new AvailabilityPlan(injuries, streamFor(5n, run, STREAM.availability)).returnPeriod(i.player_id));
  T.eq('same seed and run, same return periods', at(12), at(12));
  let differs = 0; for (let r = 0; r < 50; r++) if (JSON.stringify(at(r)) !== JSON.stringify(at(r + 50))) differs++;
  T.chk('different runs draw different trajectories', differs > 30, differs);
}
/* 5 drift: off is a no-op that consumes nothing; on is refused without evidence */
{
  const offsets = Float64Array.from([1, -2, 0.5]), before = Array.from(offsets);
  const rng = streamFor(9n, 0, STREAM.drift), ref = streamFor(9n, 0, STREAM.drift);
  applyDrift({ mode: 'off' }, offsets, rng, normalQuantile);
  T.eq('drift off leaves every offset unchanged', Array.from(offsets), before);
  T.chk('drift off consumes no random number', rng.nextU32() === ref.nextU32());
  T.throws('random-walk drift without named evidence is refused', () => applyDrift({ mode: 'random_walk', per_period_sd: 0.5 }, offsets, rng, normalQuantile), /not validated/);
  T.throws('random-walk drift with blank evidence is refused', () => applyDrift({ mode: 'random_walk', per_period_sd: 0.5, evidence: ' ' }, offsets, rng, normalQuantile), /not validated/);
  T.throws('random-walk drift needs a positive sd', () => applyDrift({ mode: 'random_walk', per_period_sd: 0, evidence: 'TEST ONLY' }, offsets, rng, normalQuantile), /positive/);
  T.eq('a refused drift changed nothing', Array.from(offsets), before);
  const o2 = Float64Array.from(before), r2 = streamFor(9n, 0, STREAM.drift), r3 = streamFor(9n, 0, STREAM.drift);
  applyDrift({ mode: 'random_walk', per_period_sd: 0.5, evidence: 'TEST ONLY: the mechanics, not a validated parameter' }, o2, r2, normalQuantile);
  T.chk('enabled drift (test-only evidence string) adds sd x a standard normal per club', Array.from(o2).every((v, i) => Math.abs(v - (before[i] + 0.5 * normalQuantile(r3.nextOpen()))) < 1e-12));
}
process.exit(T.done());

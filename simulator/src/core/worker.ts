/* One simulation worker: a contiguous range of runs over the frozen snapshot. */
import { parentPort, workerData } from 'node:worker_threads';
import { runRange } from './engine.ts';
import { buildModule } from '../sports/factory.ts';

const W = workerData as { sport: string; data: unknown; seed: string; start: number; end: number; traceRuns: number[]; sigma?: number };
try {
  const m = buildModule(W.sport, W.data, { seed: BigInt(W.seed), sigma: W.sigma });
  const agg = runRange(m, { start: W.start, end: W.end, traceRuns: W.traceRuns });
  parentPort!.postMessage({ ok: true, agg });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: String((e as Error).stack || e) });
}

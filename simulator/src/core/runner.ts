/* ===========================================================================
   Run N simulated seasons, serially or over worker threads.

   Each worker receives the frozen snapshot data (structured clone, no
   network, no database) and a contiguous range of run indices; every run's
   random streams derive from (master seed, run index) only, and aggregates
   are integer sums, so the merged result is identical for any worker count
   and any scheduling. simulator/tests/engine.test.ts holds that.
   =========================================================================== */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { runRange, mergeAggregates, emptyAggregate, type Aggregate, type SimModule } from './engine.ts';
import { buildModule } from '../sports/factory.ts';

export interface RunPlan { sport: string; data: unknown; seed: bigint; runs: number; workers: number; traceRuns: number[]; sigma?: number }

export async function runPlan(plan: RunPlan): Promise<{ agg: Aggregate; module: SimModule; workers: number }> {
  const module = buildModule(plan.sport, plan.data, { seed: plan.seed, sigma: plan.sigma });
  const workers = Math.max(1, Math.min(plan.workers || 1, plan.runs, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
  if (workers === 1) return { agg: runRange(module, { start: 0, end: plan.runs, traceRuns: plan.traceRuns }), module, workers };
  const per = Math.ceil(plan.runs / workers);
  const parts: Array<Promise<Aggregate>> = [];
  for (let w = 0; w < workers; w++) {
    const start = w * per, end = Math.min(plan.runs, start + per);
    if (start >= end) continue;
    parts.push(new Promise((resolve, reject) => {
      const wk = new Worker(new URL('./worker.ts', import.meta.url), {
        workerData: { sport: plan.sport, data: plan.data, seed: plan.seed.toString(), start, end, traceRuns: plan.traceRuns.filter((r) => r >= start && r < end), sigma: plan.sigma },
        resourceLimits: { maxOldGenerationSizeMb: 2048 }
      });
      wk.once('message', (m: { ok: boolean; agg?: Aggregate; error?: string }) => { if (m.ok) resolve(m.agg as Aggregate); else reject(new Error(m.error)); });
      wk.once('error', reject);
      wk.once('exit', (code) => { if (code !== 0) reject(new Error('simulation worker exited with code ' + code)); });
    }));
  }
  const aggs = await Promise.all(parts);
  let agg = emptyAggregate(module);
  for (const a of aggs) agg = mergeAggregates(agg, a);
  return { agg, module, workers };
}

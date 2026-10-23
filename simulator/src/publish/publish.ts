/* ===========================================================================
   PUBLISH A RUN — begin, upload into the unpublished run, publish atomically.

   1  sim_begin_run       a 'running' run row, keyed by the idempotency key
                          (sport, competition, season, seed, N, input hash,
                          config hash, engine and model versions). The same
                          key again returns the existing run: a rerun of
                          identical inputs publishes nothing new.
   2  sim_put_snapshot    the frozen input snapshot, by content hash
   3  sim_put_results     every (entity, outcome) row, in chunks
      sim_put_entities    records, mean wins, histograms, clinch status
      sim_put_traces      at most 5 traces
   4  sim_publish_run     the database re-verifies counts, sums and gates and
                          moves the pointer in ONE transaction, or refuses
   Anything that fails after step 1 marks the run failed (sim_fail_run). The
   previously published run is never touched by a failure.
   =========================================================================== */
import { postgrestDb, type SimDb } from './db.ts';
import { hashCanonical } from '../core/canonical.ts';
import { sportRegistry } from '../sports/registry.ts';
import type { RunOutcome } from '../cli/run.ts';

export function idempotencyKey(o: Pick<RunOutcome, 'results'>): string {
  const r = o.results.run;
  return hashCanonical({ sport: r.sport, competition: r.competition, season: r.season, seed: r.seed, n: r.n_sims, input_hash: r.input_hash,
    config_hash: r.config_hash, engine: r.engine_version, model: r.model_version });
}

export function resultRows(o: Pick<RunOutcome, 'results'>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const cat: Record<string, string> = {}; o.results.outcomes.forEach((x) => { cat[x.key] = x.category; });
  for (const e of o.results.entities as any[]) for (const [k, s] of Object.entries(e.outcomes as Record<string, any>)) {
    rows.push({ entity_id: e.entity_id, entity_name: e.entity_name, entity_groups: e.groups, outcome: k, category: cat[k], applicable: s.applicable !== false,
      outcome_count: s.count, n_sims: s.n, probability: s.probability, mcse: s.mcse, wilson_lo: s.wilson_lo, wilson_hi: s.wilson_hi,
      interval_method: 'wilson_95', fair_decimal: s.fair_decimal, provenance: s.provenance || 'Research' });
  }
  return rows;
}

export interface PublishOptions { db?: SimDb; log?: (s: string) => void; chunk?: number }
export interface PublishResult { run_id: string; status: string; existing: boolean; published: boolean; detail?: unknown }

export async function publishRun(o: RunOutcome, opt: PublishOptions = {}): Promise<PublishResult> {
  const db = opt.db || postgrestDb();
  const log = opt.log || (() => {});
  const r = o.results.run, chunk = opt.chunk || 500;
  const reg = sportRegistry().find((s) => s.key === r.sport);
  const begin = await db.rpc('sim_begin_run', { p: {
    sport: r.sport, competition: r.competition, season: r.season, idempotency_key: idempotencyKey(o), seed: r.seed, prng_version: r.prng_version,
    n_sims: r.n_sims, model_version: r.model_version, engine_version: r.engine_version, source_commit: r.source_commit || '', rules_version: r.rules_version,
    config_hash: r.config_hash, input_snapshot_at: r.input_snapshot_at, input_ref: 'db:sim_input_snapshots/' + r.input_hash, input_hash: r.input_hash,
    expected: { entities: o.results.entities.length, outcomes: o.results.outcomes.length, sum_rules: o.results.sum_rules },
    gates: o.gates, validation_summary: { checks: o.results.checks, flags: o.results.flags },
    diagnostics: o.results.diagnostics, limitations: reg ? reg.limitations : [],
    runtime: { runtime_ms: r.runtime_ms, workers: r.workers, peak_rss_mb: r.peak_rss_mb, node: r.node, platform: r.platform },
    started_at: r.started_at, finished_at: r.finished_at
  } }) as { run_id: string; status: string; existing: boolean };
  if (begin.existing && begin.status !== 'running') {
    log('a run with identical inputs, seed and versions already exists (' + begin.run_id + ', ' + begin.status + '): nothing new to publish');
    return { run_id: begin.run_id, status: begin.status, existing: true, published: false };
  }
  const runId = begin.run_id;
  try {
    await db.rpc('sim_put_snapshot', { p: { input_hash: o.snapshot.input_hash, sport: r.sport, schema: o.snapshot.schema, data: o.snapshot.data, meta: { built_at: o.snapshot.meta.built_at, feeds: o.snapshot.meta.feeds } } });
    const rows = resultRows(o);
    for (let i = 0; i < rows.length; i += chunk) await db.rpc('sim_put_results', { p_run: runId, p_rows: rows.slice(i, i + chunk) });
    const ents = (o.results.entities as any[]).map((e) => ({ entity_id: e.entity_id, entity_name: e.entity_name, entity_groups: e.groups, record: e.record || null,
      mean_wins: e.mean_wins ?? null, wins_hist_x2: e.wins_hist_x2 ?? null, math_status: e.math_status || null }));
    await db.rpc('sim_put_entities', { p_run: runId, p_rows: ents });
    const tr = o.results.traces.slice(0, 5).map((t) => ({ run_index: t.run, trace: { events: t.events } })).filter((t) => JSON.stringify(t.trace).length <= 65536);
    if (tr.length) await db.rpc('sim_put_traces', { p_run: runId, p_rows: tr });
    const pub = await db.rpc('sim_publish_run', { p_run: runId }) as { published: boolean; status: string; errors?: unknown };
    log('publication: ' + JSON.stringify(pub));
    if (!pub.published && pub.status === 'failed') throw Object.assign(new Error('the database refused the publication: ' + JSON.stringify(pub.errors)), { alreadyFailed: true });
    return { run_id: runId, status: pub.status, existing: false, published: pub.published, detail: pub };
  } catch (e) {
    if (!(e as any).alreadyFailed) {
      try { await db.rpc('sim_fail_run', { p_run: runId, p_error: { code: 'upload_failed', message: String((e as Error).message || e).slice(0, 500) } }); }
      catch (e2) { log('could not mark run ' + runId + ' failed: ' + String((e2 as Error).message)); }
    }
    throw e;
  }
}

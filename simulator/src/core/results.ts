/* ===========================================================================
   The results document a run produces — what is written locally in a dry
   run and what the publisher uploads. Probabilities are count / N; every one
   carries its count, its Monte Carlo standard error and a 95% Wilson
   interval; fair decimal odds are 1 / p (null at p = 0).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarise, checkAggregateSums, type Aggregate, type SimModule } from './engine.ts';
import { fairDecimal } from './stats.ts';
import { PRNG_VERSION } from './prng.ts';
import { sha256Hex, hashCanonical } from './canonical.ts';

const SIM_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RESULTS_SCHEMA = 'edgedesk_sim_results_v1';
export const PRODUCTION_RUNS = 100000;

/** a hash of every simulator source file: the engine version a result was computed by */
export function engineHash(): string {
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
  });
  walk(path.join(SIM_ROOT, 'src'));
  return sha256Hex(files.map((f) => path.relative(SIM_ROOT, f).split(path.sep).join('/') + '\n' + sha256Hex(fs.readFileSync(f))).join('\n'));
}
export function sourceCommit(): string | null {
  if (process.env.GITHUB_SHA && /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA)) return process.env.GITHUB_SHA;
  try { return execSync('git rev-parse HEAD', { cwd: SIM_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch (_) { return null; }
}

export interface ResultsInput {
  module: SimModule;
  agg: Aggregate;
  seed: bigint;
  runs: number;
  workers: number;
  input_hash: string;
  input_snapshot_at: string;
  model_version: string;
  config: unknown;
  rules_version: string;
  started_at: string;
  finished_at: string;
  runtime_ms: number;
  peak_rss_mb: number;
  entityExtras?: (id: string) => Record<string, unknown>;
}

export function buildResults(x: ResultsInput) {
  const sumErrors = checkAggregateSums(x.module, x.agg).concat(x.agg.violations.map((v) => 'run ' + v.run + ': ' + v.rule + ' ' + v.detail));
  const ents = summarise(x.module, x.agg).map((e) => {
    const outcomes: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(e.outcomes)) outcomes[k] = { ...s, applicable: true, fair_decimal: fairDecimal(s.probability), provenance: 'Research' };
    const n = x.agg.n, hist = e.value_hist, v = x.module.value;
    const mean = hist.reduce((a, c, b) => a + c * b, 0) / n / (v ? v.divisor : 2);
    const value = v ? { ['mean_' + v.key]: Math.round(mean * 1e4) / 1e4, [v.key + '_hist']: hist } : { mean_wins: Math.round(mean * 1e4) / 1e4, wins_hist_x2: hist };
    return { entity_id: e.entity_id, entity_name: e.entity_name, groups: e.groups, outcomes, ...value, ...(x.entityExtras ? x.entityExtras(e.entity_id) : {}) };
  });
  const finiteOk = ents.every((e) => Object.values(e.outcomes as Record<string, any>).every((o) => Number.isFinite(o.probability) && o.probability >= 0 && o.probability <= 1 && Number.isFinite(o.mcse)));
  return {
    schema: RESULTS_SCHEMA,
    run: {
      sport: x.module.sport, competition: x.module.competition, season: x.module.season,
      seed: x.seed.toString(), prng_version: PRNG_VERSION, n_sims: x.agg.n, workers: x.workers,
      model_version: x.model_version, rules_version: x.rules_version,
      config_hash: hashCanonical({ config: x.config, rules_version: x.rules_version }),
      engine_version: 'edgedesk-sim/0.1.0+' + engineHash().slice(0, 16), source_commit: sourceCommit(),
      input_hash: x.input_hash, input_snapshot_at: x.input_snapshot_at,
      started_at: x.started_at, finished_at: x.finished_at, runtime_ms: x.runtime_ms, peak_rss_mb: x.peak_rss_mb,
      node: process.version, platform: process.platform + '/' + process.arch
    },
    outcomes: x.module.outcomes,
    sum_rules: x.module.sumRules,
    entities: ents,
    checks: { sum_rule_errors: sumErrors, finite_and_bounded: finiteOk },
    diagnostics: x.agg.diags,
    flags: x.agg.flags,
    traces: x.agg.traces.slice(0, 5),
    interval: { method: 'Wilson score', level: 0.95, mcse: 'sqrt(p(1-p)/N): Monte Carlo sampling error only, not model error' }
  };
}
export type ResultsDoc = ReturnType<typeof buildResults>;

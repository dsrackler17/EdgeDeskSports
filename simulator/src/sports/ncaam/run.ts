/* ===========================================================================
   edgedesk-sim run, NCAAM: snapshot -> gates -> simulate -> results -> local
   files; publication through the shared publisher (publish/publish.ts) only
   when every gate passes. Called by cli/run.ts for --sport ncaam.

   Gates (any FAIL that blocks simulation stops before a single run):
     inputs.bracket          the bracket is a valid tree (bracket.ts)
     inputs.rated            every entrant has a rating history in the artifact
     inputs.strength         the strength study exists and V is inside its CI
     inputs.pairs            every pair has a finite mean and sd > sqrt(V_a + V_b)
     model.champion          a publishable run uses the CHAMPION (not the
                             development selection)
   then run.sum_rules, run.finite, run.count (100,000 to publish) and
   sport.active (registry.ts: the 2027 facts must be VERIFIED).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { runPlan } from '../../core/runner.ts';
import { buildResults, PRODUCTION_RUNS, type ResultsDoc } from '../../core/results.ts';
import { parseSeed } from '../../core/prng.ts';
import { sha256Hex } from '../../core/canonical.ts';
import { validateBracket } from './bracket.ts';
import { buildNcaamSnapshot, readNcaamSnapshot, writeNcaamSnapshot, REPO, type NcaamSnapshot } from './inputs.ts';
import { sportRegistry } from '../registry.ts';
import { NCAAM_2027 } from './config.ts';
import type { Gate } from '../nfl/validate.ts';

export interface NcaamArgs { season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; out: string | null; traceRuns: number[];
  mode: 'official' | 'historical'; modelSource: 'champion' | 'selection'; bracketFile: string | null; asOf: string | null }

export function validateNcaamInputs(snap: NcaamSnapshot): Gate[] {
  const d = snap.data; const out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation'): void => { out.push({ id, status: ok ? 'PASS' : 'FAIL', blocks: ok ? 'none' : blocks, detail }); };
  const be = validateBracket(d.bracket);
  g('inputs.bracket', !be.length, be.length ? be.slice(0, 5).join('; ') : d.bracket.slots.length + ' slots, ' + Object.keys(d.bracket.entrants).length + ' entrants, rounds ' + d.bracket.rounds.join('/'));
  const unrated = d.teams.filter((t) => !(t.rating_games > 0)).map((t) => t.id);
  g('inputs.rated', !unrated.length, unrated.length ? 'entrants without games in the artifact: ' + unrated.join(', ') : 'every entrant rated');
  const V = d.strength.variance[0]; const ci = d.strength.ci95;
  g('inputs.strength', Number.isFinite(V) && V >= 0 && (!ci || (V >= ci[0] && V <= ci[1])), 'V = ' + V + ' margin pts^2' + (ci ? ' (95% CI ' + ci.join('-') + ')' : '') + ' from ' + d.strength.source);
  const n = d.teams.length; let bad = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) { const s = d.pairs.sd[i * n + j]; if (!(Number.isFinite(d.pairs.mu[i * n + j]) && s * s > d.strength.variance[i] + d.strength.variance[j])) bad++; }
  g('inputs.pairs', !bad, bad ? bad + ' pairs without a usable forecast' : n * (n - 1) + ' ordered pairs priced');
  g('model.champion', snap.meta.model_source === 'champion', snap.meta.model_source === 'champion' ? 'the champion model ' + (d.model as any).key : 'the development selection (dry runs and backtests only)', 'publication');
  return out;
}

export async function executeNcaam(a: NcaamArgs, log: (s: string) => void = console.log): Promise<{ results: ResultsDoc; gates: Gate[]; snapshot: NcaamSnapshot; outDir: string; publishable: boolean }> {
  const snap = a.snapshot ? readNcaamSnapshot(a.snapshot) : buildNcaamSnapshot({ season: a.season, mode: a.mode, modelSource: a.modelSource, bracketFile: a.bracketFile || undefined, asOf: a.asOf || undefined });
  const inputGates = validateNcaamInputs(snap);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const seed = a.seed != null ? parseSeed(a.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · ' + snap.meta.mode + ' ' + snap.data.season + ' · ' + snap.data.teams.length + ' entrants · model ' + (snap.data.model as any).key + ' as of ' + snap.meta.as_of + ' · V ' + snap.data.strength.variance[0] + ' · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'ncaam', data: snap.data, seed, runs: a.runs, workers: a.workers, traceRuns: a.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const team = new Map(snap.data.teams.map((t) => [t.id, t]));
  const results = buildResults({ module, agg, seed, runs: a.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: (snap.data.model as any).key + '#' + snap.data.model.artifact_sha256.slice(0, 12), config: { model: snap.data.model, strength: { variance: snap.data.strength.variance[0], source: snap.data.strength.source }, calibration: snap.data.calibration, rules: snap.data.config },
    rules_version: snap.data.rules_version, started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: ms, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: { seed: (team.get(id) as any).seed, region: (team.get(id) as any).region }, math_status: null }) });
  const reg = sportRegistry().find((s) => s.key === 'ncaam')!;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none', detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate bracket sum holds' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'run.mode', status: snap.meta.mode === 'official' ? 'PASS' : 'FAIL', blocks: snap.meta.mode === 'official' ? 'none' : 'publication', detail: snap.meta.mode === 'official' ? 'the official bracket' : 'a historical reconstruction (backtest only)' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((g) => g.blocks === 'none');
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = a.out || path.join(REPO, 'simulator', 'out', 'ncaam-' + snap.data.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeNcaamSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false, season_facts: { format: NCAAM_2027.format.verification, bracket: NCAAM_2027.official_bracket.verification } }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

export function printNcaamSummary(o: { results: ResultsDoc; gates: Gate[]; outDir: string; publishable: boolean }, log: (s: string) => void): void {
  const r = o.results;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1) : '    —   ');
  const ents = (r.entities as any[]).slice().sort((a, b) => b.outcomes.win_title.probability - a.outcomes.win_title.probability).slice(0, 16);
  log('team                         seed  S16        E8         F4         title      (percent, ±95% Monte Carlo half-width)');
  for (const e of ents) log(String(e.entity_name).slice(0, 28).padEnd(29) + String(e.record && e.record.seed != null ? e.record.seed : '—').padStart(4) + '  ' + pp(e.outcomes.reach_s16) + '  ' + pp(e.outcomes.reach_e8) + '  ' + pp(e.outcomes.reach_f4) + '  ' + pp(e.outcomes.win_title));
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}

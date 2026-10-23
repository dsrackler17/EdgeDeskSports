/* ===========================================================================
   edgedesk-sim run, college football: build (or replay) the CFB snapshot,
   validate it, simulate, check, write the results locally. Called by
   run.ts for --sport cfb; the options, exit codes and output files are the
   same as the NFL's (docs/simulator/README.md).

     node simulator/src/cli/run.ts --sport cfb --season 2026 --runs 100000 --workers 4 --dry-run
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSeed } from '../core/prng.ts';
import { runPlan } from '../core/runner.ts';
import { buildResults, PRODUCTION_RUNS, type ResultsDoc } from '../core/results.ts';
import { buildCfbSnapshot, readSnapshot, writeSnapshot, type CfbSnapshot } from '../sports/cfb/inputs.ts';
import { validateCfbInputs, cfbRunGates, conferenceStatus, type Gate } from '../sports/cfb/validate.ts';
import { cfpMode } from '../sports/cfb/module.ts';
import { cfbMathStatus } from '../sports/cfb/status.ts';
import { sportRegistry } from '../sports/registry.ts';
import { CFB_2026 } from '../sports/cfb/config.ts';
import { sha256Hex } from '../core/canonical.ts';
import type { CliArgs } from './run.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export interface CfbRunOutcome { results: ResultsDoc & { cfb: any }; gates: Gate[]; snapshot: CfbSnapshot; outDir: string; publishable: boolean }

export async function executeCfb(args: CliArgs, log: (s: string) => void = console.log): Promise<CfbRunOutcome> {
  if (args.season !== CFB_2026.season) throw Object.assign(new Error('no CFB season config for ' + args.season), { exitCode: 2 });
  const snap = args.snapshot ? readSnapshot(args.snapshot) : await buildCfbSnapshot({ offline: args.offline });
  const inputGates = validateCfbInputs(snap);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const seed = args.seed != null ? parseSeed(args.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  const d = snap.data, cm = cfpMode(d);
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · as-of week ' + d.as_of_week + ' · ' + d.games.filter((g) => !g.done).length + ' remaining games · tau ' + d.strength.tau_points.toFixed(3) + ' · CFP: ' + cm.mode + ' (' + cm.reason + ') · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'cfb', data: d, seed, runs: args.runs, workers: args.workers, traceRuns: args.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const status = cfbMathStatus(d);
  /* games: every regular-season game on the team's schedule, played or not (the games its wins histogram counts),
     so the reader can turn the histogram into a projected record and an unbeaten regular season */
  const rec: Record<string, { w: number; l: number; games: number }> = {};
  d.teams.forEach((t) => { rec[t.id] = { w: 0, l: 0, games: 0 }; });
  for (const g of d.games) {
    if (g.home >= 0) rec[d.teams[g.home].id].games++;
    if (g.away >= 0) rec[d.teams[g.away].id].games++;
    if (!g.done) continue;
    const hw = (g.home_points as number) > (g.away_points as number);
    if (g.home >= 0) rec[d.teams[g.home].id][hw ? 'w' : 'l']++;
    if (g.away >= 0) rec[d.teams[g.away].id][hw ? 'l' : 'w']++;
  }
  const base = buildResults({ module, agg, seed, runs: args.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.model.model_version, config: d.config, rules_version: 'CFB-2026:' + d.config.cfp.rules + '/' + d.config.conferences.map((c) => c.procedure).join(','),
    started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: Date.now() - t0, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: rec[id], math_status: status[id] }) });
  const confStatus = conferenceStatus(d, agg.flags, agg.n);
  const results = { ...base, cfb: {
    uncertainty_layers: {
      game_results: 'Research: engine distribution per game, persistent strength offset tau ' + d.strength.tau_points + ' (carved out of the engine sigma)',
      conference_qualification: 'rules per conference (config.ts); external-ranking steps resolved by an Estimated surrogate and counted',
      committee: cm.mode === 'off' ? 'none: no CFP or national-title probability is produced (' + cm.reason + ')' : cm.mode === 'proxy' ? 'Estimated: ' + cm.reason : cm.mode === 'observed' ? 'Observed bracket: ' + cm.reason : 'CONDITIONAL on a stated scenario: ' + cm.reason
    },
    cfp_mode: cm.mode, cfp_mode_reason: cm.reason,
    conferences: confStatus,
    calibration: d.calibration,
    notes: d.notes
  } };
  const reg = sportRegistry().find((s) => s.key === 'cfb')!;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none', detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate format sum holds' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    ...cfbRunGates(d, agg.flags, agg.n),
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((g) => g.blocks === 'none');
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = args.out || path.join(SIM, 'out', 'cfb-' + args.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

export function printCfbSummary(o: CfbRunOutcome, log: (s: string) => void) {
  const r = o.results, cm = r.cfb.cfp_mode;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1).padEnd(3) : '    —    ');
  for (const c of r.cfb.conferences as any[]) {
    const ents = (r.entities as any[]).filter((e) => e.groups.conference === c.conference).sort((a, b) => b.outcomes.conf_champion.probability - a.outcomes.conf_champion.probability).slice(0, 4);
    log(c.conference.padEnd(18) + ' [' + c.status + ', estimated-ranking runs ' + (100 * c.runs_decided_by_estimated_ranking).toFixed(1) + '%]  ' + ents.map((e) => e.entity_name + ' ' + e.record.w + '-' + e.record.l + ' title game ' + pp(e.outcomes.ccg_appearance).trim() + ' champion ' + pp(e.outcomes.conf_champion).trim()).join(' | '));
  }
  if (cm !== 'off') {
    const ents = (r.entities as any[]).slice().sort((a, b) => b.outcomes.cfp_field.probability - a.outcomes.cfp_field.probability).slice(0, 16);
    log('CFP (' + cm + ', ' + (cm === 'proxy' ? 'Estimated' : cm) + ')  team  W-L   make CFP   bye        semis      title');
    for (const e of ents) log('  ' + e.entity_name.padEnd(20) + (e.record.w + '-' + e.record.l).padEnd(6) + pp(e.outcomes.cfp_field) + '  ' + pp(e.outcomes.cfp_bye) + '  ' + pp(e.outcomes.reach_sf) + '  ' + pp(e.outcomes.national_champion));
  } else log('CFP: no unconditional CFP or national-title probability (' + r.cfb.cfp_mode_reason + ')');
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail.slice(0, 300));
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}

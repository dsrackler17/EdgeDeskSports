/* ===========================================================================
   edgedesk-sim run — build (or replay) a snapshot, validate it, simulate,
   check, write the results locally, and publish only when asked AND every
   gate passes.

     node simulator/src/cli/run.ts --sport nfl --season 2026 --dry-run
     node simulator/src/cli/run.ts --sport nfl --season 2026 --runs 100000 --workers 4 --publish
     node simulator/src/cli/run.ts --snapshot simulator/out/<dir>/snapshot.json --dry-run   (replay)
     node simulator/src/cli/run.ts --sport nhl --season 2027 --workers 4 --dry-run   (2026-27; NHL season keys are end years)

   Options
     --sport nfl|nhl          the sport (simulator/src/sports/registry.ts)
     --season 2026            must match the sport's season config (NHL: 2027 = 2026-27, the default for --sport nhl)
     --runs N                 default 100000 (production); fewer only for a dry run
     --seed S                 decimal or 0x-hex u64; default: derived from the input hash
     --workers K              worker threads (results identical for any K)
     --snapshot FILE          replay a frozen snapshot instead of building one
     --offline                build from cached feeds only
     --dry-run                never write to the database (the default unless --publish)
     --publish                publish through supabase (needs SB_URL and SB_SERVICE_ROLE)
     --out DIR                local output directory (default simulator/out/<sport>-<season>-<stamp>)
     --trace-runs 0,1,2       runs to trace in full (at most 5)
     --allow-unreconciled     dry run only: proceed when the standings source is unavailable
   Exit codes: 0 ok, 1 a gate blocked (nothing published), 2 invalid inputs or arguments, 3 publish failed.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSeed } from '../core/prng.ts';
import { runPlan } from '../core/runner.ts';
import { buildResults, PRODUCTION_RUNS, type ResultsDoc } from '../core/results.ts';
import { buildNflSnapshot, readSnapshot, writeSnapshot, type NflSnapshot } from '../sports/nfl/inputs.ts';
import { validateNflInputs, nflMathStatus, type Gate } from '../sports/nfl/validate.ts';
import { sportRegistry } from '../sports/registry.ts';
import { NFL_2026 } from '../sports/nfl/config.ts';
import { NHL_2027 } from '../sports/nhl/config.ts';
import { buildNhlSnapshot, readNhlSnapshot, writeNhlSnapshot, type NhlSnapshot } from '../sports/nhl/inputs.ts';
import { validateNhlInputs } from '../sports/nhl/validate.ts';
import { sha256Hex } from '../core/canonical.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CliArgs {
  sport: string; season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; offline: boolean;
  publish: boolean; out: string | null; traceRuns: number[]; allowUnreconciled: boolean; maxUnsupportedFraction: number;
}
export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { sport: 'nfl', season: NFL_2026.season, runs: PRODUCTION_RUNS, seed: null, workers: 1, snapshot: null, offline: false,
    publish: false, out: null, traceRuns: [0, 1, 2], allowUnreconciled: false, maxUnsupportedFraction: 1e-4 };
  const need = (i: number) => { if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(argv[i] + ' needs a value'); return argv[i + 1]; };
  let seasonGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--sport': a.sport = need(i); i++; break;
      case '--season': a.season = Number(need(i)); seasonGiven = true; i++; break;
      case '--runs': a.runs = Number(need(i)); i++; break;
      case '--seed': a.seed = need(i); i++; break;
      case '--workers': a.workers = Number(need(i)); i++; break;
      case '--snapshot': a.snapshot = need(i); i++; break;
      case '--offline': a.offline = true; break;
      case '--dry-run': a.publish = false; break;
      case '--publish': a.publish = true; break;
      case '--out': a.out = need(i); i++; break;
      case '--trace-runs': a.traceRuns = need(i).split(',').filter(Boolean).map(Number); i++; break;
      case '--allow-unreconciled': a.allowUnreconciled = true; break;
      default: throw new Error('unknown option ' + k);
    }
  }
  if (!sportRegistry().some((s) => s.key === a.sport)) throw new Error('unknown sport ' + a.sport);
  if (a.sport === 'nhl' && !seasonGiven) a.season = NHL_2027.season;
  if (!Number.isInteger(a.season) || a.season < 2000 || a.season > 2100) throw new Error('bad season ' + a.season);
  if (!Number.isInteger(a.runs) || a.runs < 1 || a.runs > 10000000) throw new Error('--runs must be an integer in [1, 10000000]');
  if (!Number.isInteger(a.workers) || a.workers < 1 || a.workers > 64) throw new Error('--workers must be an integer in [1, 64]');
  if (a.seed != null) parseSeed(a.seed);
  if (a.traceRuns.length > 5 || a.traceRuns.some((r) => !Number.isInteger(r) || r < 0)) throw new Error('--trace-runs: at most 5 non-negative run indices');
  if (a.publish && a.allowUnreconciled) throw new Error('--allow-unreconciled is for dry runs only');
  return a;
}

export interface RunOutcome { results: ResultsDoc; gates: Gate[]; snapshot: NflSnapshot | NhlSnapshot; outDir: string; publishable: boolean }

export async function execute(args: CliArgs, log: (s: string) => void = console.log): Promise<RunOutcome> {
  if (args.sport === 'nhl') return executeNhl(args, log);
  if (args.sport !== 'nfl') throw Object.assign(new Error('sport ' + args.sport + ' has no simulation module: ' + (sportRegistry().find((s) => s.key === args.sport) as any).blockers.join(' | ')), { exitCode: 2 });
  if (args.season !== NFL_2026.season) throw Object.assign(new Error('no NFL season config for ' + args.season), { exitCode: 2 });
  /* 1 inputs: build (network, before any simulation) or replay */
  const snap = args.snapshot ? readSnapshot(args.snapshot) : await buildNflSnapshot({ offline: args.offline });
  const inputGates = validateNflInputs(snap, { allowUnreconciled: args.allowUnreconciled });
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const seed = args.seed != null ? parseSeed(args.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · as-of week ' + snap.data.as_of_week + ' · ' + snap.data.games.filter((g) => !g.done).length + ' remaining games · sigma ' + snap.data.strength.sigma_points.toFixed(3) + ' · seed ' + seed);
  /* 2 simulate */
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'nfl', data: snap.data, seed, runs: args.runs, workers: args.workers, traceRuns: args.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const status = nflMathStatus(snap.data);
  const rec: Record<string, { w: number; l: number; t: number }> = {};
  for (const t of snap.data.teams) rec[t.code] = { w: 0, l: 0, t: 0 };
  for (const g of snap.data.games) if (g.done) { const m = (g.home_score as number) - (g.away_score as number); if (m > 0) { rec[g.home].w++; rec[g.away].l++; } else if (m < 0) { rec[g.away].w++; rec[g.home].l++; } else { rec[g.home].t++; rec[g.away].t++; } }
  const results = buildResults({ module, agg, seed, runs: args.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: snap.data.model.model_version, config: snap.data.config, rules_version: snap.data.config.rules_version,
    started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: ms, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: rec[id], math_status: status[id] }) });
  /* 3 gates */
  const unsupported = agg.flags.tiebreak_unsupported_input || 0, frac = unsupported / agg.n;
  const gates = inputGates.concat(runGates(results, agg.n, 'nfl', [
    { id: 'run.unsupported_tiebreaks', status: frac <= args.maxUnsupportedFraction ? 'PASS' : 'FAIL', blocks: frac <= args.maxUnsupportedFraction ? 'none' : 'publication',
      detail: unsupported + ' of ' + agg.n + ' runs reached a tiebreak step without a model input (net touchdowns) and were resolved by the seeded coin toss; every published probability can differ by at most ' + frac + ' from a fully rule-resolved run (limit ' + args.maxUnsupportedFraction + ')' },
    { id: 'run.estimated_points_tiebreaks', status: 'PASS', blocks: 'none', detail: (agg.flags.tiebreak_estimated_points || 0) + ' of ' + agg.n + ' runs used Estimated scores for a points-ranking tiebreak' }
  ]));
  return writeOut(args, startedAt, snap, results, gates, (f) => writeSnapshot(f, snap));
}

/** write the run locally (always); publishable only when no gate blocks anything (a WARN that blocks publication still blocks it) */
function writeOut(args: CliArgs, startedAt: string, snap: NflSnapshot | NhlSnapshot, results: ResultsDoc, gates: Gate[], save: (file: string) => void): RunOutcome {
  const publishable = gates.every((g) => g.blocks === 'none');
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = args.out || path.join(SIM, 'out', args.sport + '-' + args.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  save(path.join(outDir, 'snapshot.json'));
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false
  }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

/** the shared run gates of a finished simulation */
function runGates(results: ResultsDoc, n: number, sport: string, extra: Gate[]): Gate[] {
  const reg = sportRegistry().find((s) => s.key === sport)!;
  return [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none', detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate format sum holds' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    ...extra,
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
}

/* ---------------- the NHL ---------------- */
async function executeNhl(args: CliArgs, log: (s: string) => void): Promise<RunOutcome> {
  if (args.season !== NHL_2027.season) throw Object.assign(new Error('no NHL season config for ' + args.season + ' (NHL seasons are keyed by their end year: ' + NHL_2027.season + ' = ' + NHL_2027.season_label + ')'), { exitCode: 2 });
  /* 1 inputs: build (network, before any simulation) or replay */
  const snap = args.snapshot ? readNhlSnapshot(args.snapshot) : await buildNhlSnapshot({ offline: args.offline });
  const inputGates = validateNhlInputs(snap);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const seed = args.seed != null ? parseSeed(args.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  const D = snap.data;
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · ' + D.season_label + ' as of ' + D.as_of.last_result_date + ' · ' + D.games.filter((g) => !g.done).length + ' remaining games · sigma ' + D.strength.sigma.toFixed(4) + ' · seed ' + seed);
  /* 2 simulate */
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'nhl', data: D, seed, runs: args.runs, workers: args.workers, traceRuns: args.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const rec: Record<string, { gp: number; w: number; l: number; otl: number; pts: number; rw: number; row: number }> = {};
  for (const t of D.teams) rec[t.code] = { gp: 0, w: 0, l: 0, otl: 0, pts: 0, rw: 0, row: 0 };
  for (const g of D.games) if (g.done) {
    const hw = (g.home_score as number) > (g.away_score as number), win = rec[hw ? g.home : g.away], lose = rec[hw ? g.away : g.home];
    win.gp++; lose.gp++; win.w++; win.pts += 2;
    if (g.decided === 'REG') { win.rw++; win.row++; lose.l++; } else { if (g.decided === 'OT') win.row++; lose.otl++; lose.pts++; }
  }
  const results = buildResults({ module, agg, seed, runs: args.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: D.model.model_version, config: D.config, rules_version: D.config.rules_version,
    started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: Date.now() - t0, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: rec[id], math_status: null }) });
  /* 3 gates */
  const coin = agg.flags.tiebreak_coin || 0, unsup = agg.flags.tiebreak_unsupported_input || 0, frac = (coin + unsup) / agg.n;
  const clamped = agg.diags['model:lambda_clamped'] || 0;
  const gates = inputGates.concat(runGates(results, agg.n, 'nhl', [
    { id: 'run.unsupported_tiebreaks', status: frac <= args.maxUnsupportedFraction ? 'PASS' : 'FAIL', blocks: frac <= args.maxUnsupportedFraction ? 'none' : 'publication',
      detail: coin + ' of ' + agg.n + ' runs needed a coin toss beyond the last published tiebreaker (goals for) to decide a reported place, ' + unsup + ' lacked a goals input; limit ' + args.maxUnsupportedFraction },
    { id: 'run.goals_tiebreaks', status: 'PASS', blocks: 'none', detail: (agg.flags.tiebreak_goals || 0) + ' of ' + agg.n + ' runs reached goal differential or goals for (scores of simulated games drawn from the served distribution, conditional on each result)' },
    { id: 'run.lambda_range', status: clamped === 0 ? 'PASS' : 'WARN', blocks: clamped === 0 ? 'none' : 'publication', detail: clamped + ' game evaluations outside the outcome table (rates clamped to [0.5, 10] goals)' }
  ]));
  return writeOut(args, startedAt, snap, results, gates, (f) => writeNhlSnapshot(f, snap as NhlSnapshot));
}

function printSummary(o: RunOutcome, log: (s: string) => void) {
  const r = o.results;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (o: any) => (100 * o.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * o.mcse).toFixed(1);
  if (r.run.sport === 'nhl') {
    const ents = r.entities.slice().sort((a: any, b: any) => b.outcomes.win_stanley_cup.probability - a.outcomes.win_stanley_cup.probability);
    log('club  W-L-OTL   pts  mean pts  playoffs   division   Presidents  conf (PO)  Cup         (percent, ±95% Monte Carlo interval half-width)');
    for (const e of ents as any[]) log(e.entity_id.padEnd(5) + (e.record.w + '-' + e.record.l + '-' + e.record.otl).padEnd(9) + String(e.record.pts).padStart(4) + e.mean_points.toFixed(1).padStart(9) + '   ' + pp(e.outcomes.make_playoffs) + '  ' + pp(e.outcomes.win_division) + '  ' + pp(e.outcomes.presidents_trophy) + '  ' + pp(e.outcomes.win_conference) + '  ' + pp(e.outcomes.win_stanley_cup));
    for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
    log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
    return;
  }
  const ents = r.entities.slice().sort((a: any, b: any) => b.outcomes.win_super_bowl.probability - a.outcomes.win_super_bowl.probability);
  log('club  W-L-T   mean W   playoffs   division   seed 1     conf       SB          (percent, ±95% Monte Carlo interval half-width)');
  for (const e of ents as any[]) log(e.entity_id.padEnd(5) + (e.record.w + '-' + e.record.l + '-' + e.record.t).padEnd(8) + e.mean_wins.toFixed(2).padStart(6) + '   ' + pp(e.outcomes.make_playoffs) + '  ' + pp(e.outcomes.win_division) + '  ' + pp(e.outcomes.seed_1) + '  ' + pp(e.outcomes.win_conference) + '  ' + pp(e.outcomes.win_super_bowl));
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  (async () => {
    let args: CliArgs;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error('error: ' + (e as Error).message); process.exit(2); }
    try {
      const o = await execute(args);
      printSummary(o, console.log);
      if (args.publish) {
        if (!o.publishable) { console.error('nothing published: a gate failed (see gates.json)'); process.exit(1); }
        const { publishRun } = await import('../publish/publish.ts');
        try {
          const p = await publishRun(o, { log: console.log });
          fs.writeFileSync(path.join(o.outDir, 'publish.json'), JSON.stringify(p, null, 1));
          console.log('published run ' + p.run_id + ' (' + p.status + ')');
        }
        catch (e) { console.error('publish failed: ' + (e as Error).message + ' — the previously published run is unchanged'); process.exit(3); }
      }
    } catch (e) {
      const err = e as Error & { exitCode?: number; gates?: Gate[] };
      console.error('error: ' + err.message);
      if (err.gates) for (const g of err.gates) if (g.status !== 'PASS') console.error('  ' + g.status + ' ' + g.id + ': ' + g.detail);
      process.exit(err.exitCode || 2);
    }
  })();
}

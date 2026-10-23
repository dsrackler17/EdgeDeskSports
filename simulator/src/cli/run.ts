/* ===========================================================================
   edgedesk-sim run — build (or replay) a snapshot, validate it, simulate,
   check, write the results locally, and publish only when asked AND every
   gate passes.

     node simulator/src/cli/run.ts --sport nfl --season 2026 --dry-run
     node simulator/src/cli/run.ts --sport nfl --season 2026 --runs 100000 --workers 4 --publish
     node simulator/src/cli/run.ts --snapshot simulator/out/<dir>/snapshot.json --dry-run   (replay)
     node simulator/src/cli/run.ts --sport mlb --season 2026 --dry-run                 (live: MLB Stats API)
     node simulator/src/cli/run.ts --sport mlb --season 2025 --as-of 2025-10-27 --dry-run   (history replay, 2022-2025)

   Options
     --sport nfl              the sport (simulator/src/sports/registry.ts)
     --season 2026            must match the sport's season config
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
     --as-of YYYY-MM-DD       MLB: the morning to simulate from (history seasons: required; live: default today)
     --confirm-through DATE   MLB history only: games before DATE (from --as-of) carry their actual starters as Confirmed
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
import { MLB_2026 } from '../sports/mlb/config.ts';
import { buildMlbHistorySnapshot, readSnapshot as readMlbSnapshot, writeSnapshot as writeMlbSnapshot, type MlbSnapshot } from '../sports/mlb/inputs.ts';
import { validateMlbInputs, mlbMathStatus } from '../sports/mlb/validate.ts';
import { sha256Hex } from '../core/canonical.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CliArgs {
  sport: string; season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; offline: boolean;
  publish: boolean; out: string | null; traceRuns: number[]; allowUnreconciled: boolean; maxUnsupportedFraction: number;
  asOf: string | null; confirmThrough: string | null;
}
export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { sport: 'nfl', season: NFL_2026.season, runs: PRODUCTION_RUNS, seed: null, workers: 1, snapshot: null, offline: false,
    publish: false, out: null, traceRuns: [0, 1, 2], allowUnreconciled: false, maxUnsupportedFraction: 1e-4, asOf: null, confirmThrough: null };
  const need = (i: number) => { if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(argv[i] + ' needs a value'); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--sport': a.sport = need(i); i++; break;
      case '--season': a.season = Number(need(i)); i++; break;
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
      case '--as-of': a.asOf = need(i); i++; break;
      case '--confirm-through': a.confirmThrough = need(i); i++; break;
      default: throw new Error('unknown option ' + k);
    }
  }
  if (!sportRegistry().some((s) => s.key === a.sport)) throw new Error('unknown sport ' + a.sport);
  if (!Number.isInteger(a.season) || a.season < 2000 || a.season > 2100) throw new Error('bad season ' + a.season);
  if (!Number.isInteger(a.runs) || a.runs < 1 || a.runs > 10000000) throw new Error('--runs must be an integer in [1, 10000000]');
  if (!Number.isInteger(a.workers) || a.workers < 1 || a.workers > 64) throw new Error('--workers must be an integer in [1, 64]');
  if (a.seed != null) parseSeed(a.seed);
  if (a.traceRuns.length > 5 || a.traceRuns.some((r) => !Number.isInteger(r) || r < 0)) throw new Error('--trace-runs: at most 5 non-negative run indices');
  if (a.publish && a.allowUnreconciled) throw new Error('--allow-unreconciled is for dry runs only');
  for (const d of [a.asOf, a.confirmThrough]) if (d != null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('dates are YYYY-MM-DD: ' + d);
  if (a.sport !== 'mlb' && (a.asOf || a.confirmThrough)) throw new Error('--as-of and --confirm-through are MLB options');
  if (a.sport === 'mlb' && a.season < MLB_2026.season && !a.snapshot && !a.asOf) throw new Error('an MLB history season needs --as-of YYYY-MM-DD');
  if (a.sport === 'mlb' && a.season < MLB_2026.season && a.publish) throw new Error('an MLB history replay is never published');
  if (a.confirmThrough && (a.season >= MLB_2026.season || !a.asOf)) throw new Error('--confirm-through is for MLB history replays (with --as-of)');
  return a;
}

export interface RunOutcome { results: ResultsDoc; gates: Gate[]; snapshot: NflSnapshot | MlbSnapshot; outDir: string; publishable: boolean }

export async function execute(args: CliArgs, log: (s: string) => void = console.log): Promise<RunOutcome> {
  if (args.sport === 'mlb') return executeMlb(args, log);
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
  const reg = sportRegistry().find((s) => s.key === 'nfl')!;
  const unsupported = agg.flags.tiebreak_unsupported_input || 0, frac = unsupported / agg.n;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none', detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate format sum holds' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'run.unsupported_tiebreaks', status: frac <= args.maxUnsupportedFraction ? 'PASS' : 'FAIL', blocks: frac <= args.maxUnsupportedFraction ? 'none' : 'publication',
      detail: unsupported + ' of ' + agg.n + ' runs reached a tiebreak step without a model input (net touchdowns) and were resolved by the seeded coin toss; every published probability can differ by at most ' + frac + ' from a fully rule-resolved run (limit ' + args.maxUnsupportedFraction + ')' },
    { id: 'run.estimated_points_tiebreaks', status: 'PASS', blocks: 'none', detail: (agg.flags.tiebreak_estimated_points || 0) + ' of ' + agg.n + ' runs used Estimated scores for a points-ranking tiebreak' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  /* publishable only when no gate blocks anything (a WARN that blocks publication still blocks it) */
  const publishable = gates.every((g) => g.blocks === 'none');
  /* 4 write locally (always) */
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = args.out || path.join(SIM, 'out', 'nfl-' + args.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false
  }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

/* ---------------- MLB ---------------- */
async function executeMlb(args: CliArgs, log: (s: string) => void): Promise<RunOutcome> {
  if (args.season > MLB_2026.season || args.season < 2022) throw Object.assign(new Error('MLB seasons: 2022-2025 as history replays (--as-of), ' + MLB_2026.season + ' live'), { exitCode: 2 });
  /* 1 inputs: replay a snapshot, rebuild a history morning, or read the live season (network, before any simulation) */
  let snap: MlbSnapshot;
  if (args.snapshot) { snap = readMlbSnapshot(args.snapshot); if (snap.data.season !== args.season) throw Object.assign(new Error('the snapshot is season ' + snap.data.season + ', not ' + args.season), { exitCode: 2 }); }
  else if (args.season < MLB_2026.season) snap = buildMlbHistorySnapshot({ season: args.season, asOf: args.asOf as string, confirmThrough: args.confirmThrough || undefined });
  else { const { buildMlbLiveSnapshot } = await import('../sports/mlb/statsapi.ts'); snap = await buildMlbLiveSnapshot({ offline: args.offline, asOf: args.asOf || undefined }); }
  const inputGates = validateMlbInputs(snap);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const d = snap.data;
  const seed = args.seed != null ? parseSeed(args.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · ' + d.mode + ' ' + d.season + ' as of ' + d.as_of + ' · ' + d.games.filter((g) => g.status !== 'final').length + ' scheduled games · sigma ' + d.strength.sigma_team + ' / ' + d.strength.sigma_sp + ' · seed ' + seed);
  /* 2 simulate */
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'mlb', data: d, seed, runs: args.runs, workers: args.workers, traceRuns: args.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const status = mlbMathStatus(d);
  const rec: Record<string, { w: number; l: number }> = {}; for (const t of d.teams) rec[t.code] = { w: 0, l: 0 };
  for (const g of d.games) if (g.phase === 'regular' && g.status === 'final') { if ((g.home_score as number) > (g.away_score as number)) { rec[g.home].w++; rec[g.away].l++; } else if ((g.home_score as number) < (g.away_score as number)) { rec[g.away].w++; rec[g.home].l++; } }
  /* the starter distribution of every simulated postseason game and of each club's next regular-season games:
     Confirmed where announced, otherwise Projected and never one name */
  const starters: Record<string, Record<string, Record<string, number>>> = {}, labels: Record<string, Set<string>> = {};
  const diags: Record<string, number> = {};
  for (const [k, v] of Object.entries(agg.diags)) {
    if (!k.startsWith('starter|')) { diags[k] = v; continue; }
    const [, game, club, pitcher, label] = k.split('|');
    ((starters[game] = starters[game] || {})[club] = starters[game][club] || {})[pitcher] = (starters[game][club][pitcher] || 0) + v;
    (labels[game + '|' + club] = labels[game + '|' + club] || new Set()).add(label);
  }
  agg.diags = diags;
  const results = buildResults({ module, agg, seed, runs: args.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.model.model_version, config: d.config, rules_version: d.format.id,
    started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: Date.now() - t0, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: rec[id], math_status: status[id] }) });
  const starterDoc = Object.fromEntries(Object.entries(starters).sort().map(([game, clubs]) => [game, Object.fromEntries(Object.entries(clubs).map(([club, ps]) => {
    const n = Object.values(ps).reduce((a, b) => a + b, 0);
    const ls = [...labels[game + '|' + club]];
    return [club, { label: ls.length === 1 ? ls[0] : 'Projected', games_played_in_runs: n, share: Object.fromEntries(Object.entries(ps).sort((a, b) => b[1] - a[1]).map(([p, c]) => [p === 'REPLACEMENT' ? 'replacement (unnamed)' : (d.pitcher_names[p] ? d.pitcher_names[p] + ' (' + p + ')' : p), Math.round(c / n * 1e4) / 1e4])) }];
  }))]));
  const confirmed = d.games.filter((g) => g.status === 'scheduled' && (g.starters.home || g.starters.away)).map((g) => ({ game: g.id, date: g.date, home: g.home, away: g.away, home_starter: g.starters.home ? (d.pitcher_names[g.starters.home.id] || g.starters.home.id) : null, away_starter: g.starters.away ? (d.pitcher_names[g.starters.away.id] || g.starters.away.id) : null, label: 'Confirmed' }));
  const fullResults = Object.assign(results, { starting_pitchers: { confirmed, by_game: starterDoc, note: 'Per game and club, the share of runs (in which that game was played) that each pitcher started it. Confirmed: the announced probable. Projected: drawn run by run from the rotation model, so a projected start is a distribution, never one name.' } });
  /* 3 gates */
  const reg = sportRegistry().find((s) => s.key === 'mlb')!;
  const exhausted = agg.flags.tiebreak_exhausted || 0;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none', detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate format sum holds' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'run.tiebreak_exhausted', status: exhausted / agg.n <= args.maxUnsupportedFraction ? 'PASS' : 'FAIL', blocks: exhausted / agg.n <= args.maxUnsupportedFraction ? 'none' : 'publication', detail: exhausted + ' of ' + agg.n + ' runs exhausted every tiebreak step and were resolved by the seeded draw (limit ' + args.maxUnsupportedFraction + ')' },
    { id: 'mode.live', status: d.mode === 'live' ? 'PASS' : 'FAIL', blocks: d.mode === 'live' ? 'none' : 'publication', detail: d.mode === 'live' ? 'live season inputs' : 'a history replay (' + d.season + ' as of ' + d.as_of + ') is research output, never published' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((g) => g.blocks === 'none');
  /* 4 write locally (always) */
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = args.out || path.join(SIM, 'out', 'mlb-' + d.season + '-' + d.as_of + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeMlbSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(fullResults, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false
  }, null, 1));
  return { results: fullResults, gates, snapshot: snap, outDir, publishable };
}

function printSummary(o: RunOutcome, log: (s: string) => void) {
  if (o.results.run.sport === 'mlb') return printMlbSummary(o, log);
  const r = o.results;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (o: any) => (100 * o.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * o.mcse).toFixed(1);
  const ents = r.entities.slice().sort((a: any, b: any) => b.outcomes.win_super_bowl.probability - a.outcomes.win_super_bowl.probability);
  log('club  W-L-T   mean W   playoffs   division   seed 1     conf       SB          (percent, ±95% Monte Carlo interval half-width)');
  for (const e of ents as any[]) log(e.entity_id.padEnd(5) + (e.record.w + '-' + e.record.l + '-' + e.record.t).padEnd(8) + e.mean_wins.toFixed(2).padStart(6) + '   ' + pp(e.outcomes.make_playoffs) + '  ' + pp(e.outcomes.win_division) + '  ' + pp(e.outcomes.seed_1) + '  ' + pp(e.outcomes.win_conference) + '  ' + pp(e.outcomes.win_super_bowl));
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}

function printMlbSummary(o: RunOutcome, log: (s: string) => void) {
  const r = o.results as any;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (x: any) => (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1);
  const ents = r.entities.slice().sort((a: any, b: any) => b.outcomes.win_world_series.probability - a.outcomes.win_world_series.probability || b.outcomes.make_playoffs.probability - a.outcomes.make_playoffs.probability);
  log('club W-L      mean W  division   postseason bye        LCS        pennant    World Series   (percent, ±95% Monte Carlo half-width)');
  for (const e of ents) log(e.entity_id.padEnd(5) + (e.record.w + '-' + e.record.l).padEnd(8) + e.mean_wins.toFixed(1).padStart(6) + '  ' + pp(e.outcomes.win_division) + '  ' + pp(e.outcomes.make_playoffs) + '  ' + pp(e.outcomes.bye) + '  ' + pp(e.outcomes.reach_lcs) + '  ' + pp(e.outcomes.win_pennant) + '  ' + pp(e.outcomes.win_world_series));
  for (const g of r.starting_pitchers.confirmed) log('Confirmed ' + g.date + ' ' + g.away + ' @ ' + g.home + ': ' + g.away_starter + ' / ' + g.home_starter);
  for (const [game, clubs] of Object.entries(r.starting_pitchers.by_game as Record<string, any>).filter(([k]) => /^WS-/.test(k))) for (const [club, x] of Object.entries(clubs as Record<string, any>)) log(x.label + ' ' + game + ' ' + club + ': ' + Object.entries(x.share).slice(0, 3).map(([p, v]) => p + ' ' + (100 * (v as number)).toFixed(0) + '%').join(', '));
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

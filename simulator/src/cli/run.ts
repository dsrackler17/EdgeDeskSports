/* ===========================================================================
   edgedesk-sim run — build (or replay) a snapshot, validate it, simulate,
   check, write the results locally, and publish only when asked AND every
   gate passes.

     node simulator/src/cli/run.ts --sport nfl --season 2026 --dry-run
     node simulator/src/cli/run.ts --sport nfl --season 2026 --runs 100000 --workers 4 --publish
     node simulator/src/cli/run.ts --snapshot simulator/out/<dir>/snapshot.json --dry-run   (replay)
     node simulator/src/cli/run.ts --sport nhl --season 2027 --workers 4 --dry-run   (2026-27; NHL season keys are end years)
     node simulator/src/cli/run.ts --sport nba --dry-run                               (2026-27; NBA season keys are end years)
     node simulator/src/cli/run.ts --sport cfb --season 2026 --dry-run                 (college football: run_cfb.ts)
     node simulator/src/cli/run.ts --sport mlb --season 2026 --dry-run                 (live: MLB Stats API)
     node simulator/src/cli/run.ts --sport mlb --season 2025 --as-of 2025-10-27 --dry-run   (history replay, 2022-2025)
     node simulator/src/cli/run.ts --sport nba --workers 4 --dry-run --allow-incomplete-schedule   (2026-27; NBA season keys are end years)
     node simulator/src/cli/run.ts --sport ufc --season 2026 --workers 4 --dry-run     (every booked bout and each division's title path)
     node simulator/src/cli/run.ts --sport golf --workers 4 --dry-run                  (every tour's current event: live ESPN leaderboard, else the committed feed)
     node simulator/src/cli/run.ts --sport golf --tour pga --offline --dry-run         (one tour, from the committed feed)
     node simulator/src/cli/run.ts --sport tennis --workers 4 --dry-run                (every singles main draw whose order is known, and the day's matches)

   Options
     --sport nfl|nhl|nba|mlb|cfb|ncaam|wnba|ufc|golf|tennis  the sport (simulator/src/sports/registry.ts)
     --season 2026            must match the sport's season config (default: it; NHL and NBA keys are end years, 2027 = 2026-27)
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
     --as-of ISO              NBA: freeze the season at this time (games from then on are unplayed);
                              a historical replay, dry run only
     --allow-incomplete-schedule
                              NBA, dry run only: simulate a season whose NBA Cup-dependent games are
                              not on the schedule yet (WARN: never publishable)
   Golf only (--sport golf; one competition per tour event, each published on its own):
     --tour pga,lpga,eur          the tours to simulate (default: all three)
   NCAAM only (--sport ncaam; season 2027 = 2026-27 by default):
     --mode official|historical   the official bracket file (default) or an exact
                                  reconstruction of a past season (backtest, never published)
     --model champion|selection   the registry's champion (default; required to publish)
                                  or the frozen development selection (dry runs, backtests)
     --bracket FILE               an official bracket file other than config/brackets/<season>.json
     --as-of ISO                  the moment the model artifact and the frozen results are as of
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
import { sportRegistry, isVerified } from '../sports/registry.ts';
import type { SeasonFact } from '../sports/nfl/config.ts';
import { NFL_2026 } from '../sports/nfl/config.ts';
import { NHL_2027 } from '../sports/nhl/config.ts';
import { buildNhlSnapshot, readNhlSnapshot, writeNhlSnapshot, type NhlSnapshot } from '../sports/nhl/inputs.ts';
import { validateNhlInputs } from '../sports/nhl/validate.ts';
import { MLB_2026 } from '../sports/mlb/config.ts';
import { buildMlbHistorySnapshot, readSnapshot as readMlbSnapshot, writeSnapshot as writeMlbSnapshot, type MlbSnapshot } from '../sports/mlb/inputs.ts';
import { validateMlbInputs, mlbMathStatus } from '../sports/mlb/validate.ts';
import { NBA_2026_27 } from '../sports/nba/config.ts';
import { buildNbaSnapshot, readSnapshot as readNbaSnapshot, writeSnapshot as writeNbaSnapshot, NBA_READABLE_SCHEMAS, type NbaSnapshot } from '../sports/nba/inputs.ts';
import { validateNbaInputs, nbaMathStatus } from '../sports/nba/validate.ts';
import { NBA_OUTCOME_SEMANTICS } from '../sports/nba/module.ts';
import { sha256Hex } from '../core/canonical.ts';
import { executeCfb, printCfbSummary, type CfbRunOutcome } from './run_cfb.ts';
import { NCAAM_2027 } from '../sports/ncaam/config.ts';
import { executeNcaam, printNcaamSummary } from '../sports/ncaam/run.ts';
import { WNBA_2026 } from '../sports/wnba/config.ts';
import { executeWnba, printWnbaSummary } from '../sports/wnba/run.ts';
import { WNBA_INPUT_SCHEMA } from '../sports/wnba/inputs.ts';
import { UFC_2026 } from '../sports/ufc/config.ts';
import { executeUfc, printUfcSummary } from '../sports/ufc/run.ts';
import { UFC_INPUT_SCHEMA } from '../sports/ufc/inputs.ts';
import { GOLF_2026 } from '../sports/golf/config.ts';
import { executeGolf, printGolfSummary, publishGolf, type GolfOutcome } from '../sports/golf/run.ts';
import { GOLF_INPUT_SCHEMA } from '../sports/golf/inputs.ts';
import type { Tour } from '../sports/golf/model.ts';
import { TENNIS_2026 } from '../sports/tennis/config.ts';
import { executeTennis, printTennisSummary, publishTennis, type TennisOutcome } from '../sports/tennis/run.ts';
import { TENNIS_INPUT_SCHEMA } from '../sports/tennis/inputs.ts';

const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CliArgs {
  sport: string; season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; offline: boolean;
  publish: boolean; out: string | null; traceRuns: number[]; allowUnreconciled: boolean; maxUnsupportedFraction: number;
  asOf: string | null; confirmThrough: string | null; allowIncompleteSchedule: boolean;
  /** NCAAM only: the bracket source, the model source and an official bracket file other than the default */
  mode: 'official' | 'historical'; model: 'champion' | 'selection'; bracket: string | null;
  /** golf only: the tours to simulate (default all) */
  tours: string[] | null;
}
/** each sport's configured season (the NHL's and the NBA's are end years: 2027 = 2026-27) */
export const SEASON_DEFAULT: Record<string, number> = { nfl: NFL_2026.season, nhl: NHL_2027.season, mlb: MLB_2026.season, nba: NBA_2026_27.season, ncaam: NCAAM_2027.season, wnba: WNBA_2026.season, ufc: UFC_2026.season, golf: GOLF_2026.season, tennis: TENNIS_2026.season };
export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { sport: 'nfl', season: NaN, runs: PRODUCTION_RUNS, seed: null, workers: 1, snapshot: null, offline: false,
    publish: false, out: null, traceRuns: [0, 1, 2], allowUnreconciled: false, maxUnsupportedFraction: 1e-4, asOf: null, confirmThrough: null, allowIncompleteSchedule: false,
    mode: 'official', model: 'champion', bracket: null, tours: null };
  const need = (i: number) => { if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(argv[i] + ' needs a value'); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--sport': a.sport = need(i); i++; break;
      case '--season': a.season = Number(need(i)); i++; break;
      case '--mode': { const v = need(i); if (v !== 'official' && v !== 'historical') throw new Error('--mode must be official or historical'); a.mode = v; i++; break; }
      case '--model': { const v = need(i); if (v !== 'champion' && v !== 'selection') throw new Error('--model must be champion or selection'); a.model = v; i++; break; }
      case '--bracket': a.bracket = need(i); i++; break;
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
      case '--allow-incomplete-schedule': a.allowIncompleteSchedule = true; break;
      case '--tour': a.tours = need(i).split(',').filter(Boolean); i++; break;
      case '--mode': { const v = need(i); if (v !== 'official' && v !== 'historical') throw new Error('--mode must be official or historical'); a.mode = v; i++; break; }
      case '--model': { const v = need(i); if (v !== 'champion' && v !== 'selection') throw new Error('--model must be champion or selection'); a.model = v; i++; break; }
      case '--bracket': a.bracket = need(i); i++; break;
      default: throw new Error('unknown option ' + k);
    }
  }
  if (Number.isNaN(a.season)) a.season = SEASON_DEFAULT[a.sport] != null ? SEASON_DEFAULT[a.sport] : NFL_2026.season;
  if (!sportRegistry().some((s) => s.key === a.sport)) throw new Error('unknown sport ' + a.sport);
  if (!Number.isInteger(a.season) || a.season < 2000 || a.season > 2100) throw new Error('bad season ' + a.season);
  if (!Number.isInteger(a.runs) || a.runs < 1 || a.runs > 10000000) throw new Error('--runs must be an integer in [1, 10000000]');
  if (!Number.isInteger(a.workers) || a.workers < 1 || a.workers > 64) throw new Error('--workers must be an integer in [1, 64]');
  if (a.seed != null) parseSeed(a.seed);
  if (a.traceRuns.length > 5 || a.traceRuns.some((r) => !Number.isInteger(r) || r < 0)) throw new Error('--trace-runs: at most 5 non-negative run indices');
  if (a.publish && a.allowUnreconciled) throw new Error('--allow-unreconciled is for dry runs only');
  /* --as-of: the MLB morning (YYYY-MM-DD), the NBA freeze time (an ISO time, dry runs only) or the time
     the NCAAM model artifact is built as of (an ISO time) */
  if (a.sport === 'nba' && a.asOf != null && !(Number.isFinite(Date.parse(a.asOf)) && /^\d{4}-\d{2}-\d{2}/.test(a.asOf))) throw new Error('--as-of needs an ISO time');
  if (a.publish && (a.allowIncompleteSchedule || (a.sport === 'nba' && a.asOf != null))) throw new Error('--as-of (NBA) and --allow-incomplete-schedule are for dry runs only');
  /* with --snapshot the sport comes from the file (execute() checks again) */
  if (a.allowIncompleteSchedule && a.sport !== 'nba' && !a.snapshot) throw new Error('--allow-incomplete-schedule applies to the NBA only');
  if (a.sport !== 'nba' && a.sport !== 'ncaam') for (const d of [a.asOf, a.confirmThrough]) if (d != null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('dates are YYYY-MM-DD: ' + d);
  if (a.sport !== 'mlb' && (a.confirmThrough || (a.asOf && a.sport !== 'nba' && a.sport !== 'ncaam'))) throw new Error('--as-of and --confirm-through are MLB options (--as-of is also an NBA and an NCAAM option)');
  if (a.sport === 'mlb' && a.season < MLB_2026.season && !a.snapshot && !a.asOf) throw new Error('an MLB history season needs --as-of YYYY-MM-DD');
  if (a.sport === 'mlb' && a.season < MLB_2026.season && a.publish) throw new Error('an MLB history replay is never published');
  if (a.confirmThrough && (a.season >= MLB_2026.season || !a.asOf)) throw new Error('--confirm-through is for MLB history replays (with --as-of)');
  if (a.sport === 'ncaam' && a.asOf != null && !Number.isFinite(Date.parse(a.asOf))) throw new Error('--as-of must be an ISO time');
  if (a.sport !== 'ncaam' && (a.mode !== 'official' || a.model !== 'champion' || a.bracket)) throw new Error('--mode, --model and --bracket apply to --sport ncaam only');
  if (a.publish && a.sport === 'ncaam' && (a.mode !== 'official' || a.model !== 'champion')) throw new Error('an NCAAM run is published only from the official bracket with the champion model');
  if (a.tours && (a.sport !== 'golf' || !a.tours.length || a.tours.some((t) => !(GOLF_2026.tours as string[]).includes(t)))) throw new Error('--tour applies to --sport golf only, with tours from ' + GOLF_2026.tours.join(','));
  return a;
}

export interface RunOutcome { results: ResultsDoc; gates: Gate[]; snapshot: NflSnapshot | NhlSnapshot | MlbSnapshot | NbaSnapshot; outDir: string; publishable: boolean }

export async function execute(args: CliArgs, log: (s: string) => void = console.log): Promise<RunOutcome> {
  /* an NBA replay takes its sport and season from the snapshot itself */
  if (args.snapshot && NBA_READABLE_SCHEMAS.includes(snapshotSchema(args.snapshot) || '')) args = { ...args, sport: 'nba' };
  if (args.snapshot && snapshotSchema(args.snapshot) === WNBA_INPUT_SCHEMA) args = { ...args, sport: 'wnba' };
  if (args.snapshot && snapshotSchema(args.snapshot) === UFC_INPUT_SCHEMA) args = { ...args, sport: 'ufc' };
  if (args.snapshot && snapshotSchema(args.snapshot) === GOLF_INPUT_SCHEMA) args = { ...args, sport: 'golf' };
  if (args.snapshot && snapshotSchema(args.snapshot) === TENNIS_INPUT_SCHEMA) args = { ...args, sport: 'tennis' };
  if (args.sport === 'nba') return executeNba(args, log);
  /* golf runs one competition per tour event: the outcome carries each event's run (printGolfSummary, publishGolf) */
  if (args.sport === 'golf') return executeGolf({ season: args.season, runs: args.runs, seed: args.seed, workers: args.workers, snapshot: args.snapshot, out: args.out, traceRuns: args.traceRuns, offline: args.offline, tours: (args.tours as Tour[] | null) || undefined }, log) as unknown as RunOutcome;
  /* tennis runs one competition per singles main draw, and one for the day's matches */
  if (args.sport === 'tennis') return executeTennis({ season: args.season, runs: args.runs, seed: args.seed, workers: args.workers, snapshot: args.snapshot, out: args.out, traceRuns: args.traceRuns, offline: args.offline }, log) as unknown as RunOutcome;
  if (args.sport === 'wnba') return executeWnba({ season: args.season, runs: args.runs, seed: args.seed, workers: args.workers, snapshot: args.snapshot, out: args.out, traceRuns: args.traceRuns, offline: args.offline }, log) as unknown as RunOutcome;
  /* the UFC reads only committed files (the feeds and the model loop's data): --offline changes nothing */
  if (args.sport === 'ufc') return executeUfc({ season: args.season, runs: args.runs, seed: args.seed, workers: args.workers, snapshot: args.snapshot, out: args.out, traceRuns: args.traceRuns }, log) as unknown as RunOutcome;
  if (args.allowIncompleteSchedule) throw Object.assign(new Error('--allow-incomplete-schedule applies to the NBA only'), { exitCode: 2 });
  if (args.sport === 'nhl') return executeNhl(args, log);
  if (args.sport === 'mlb') return executeMlb(args, log);
  if (args.sport === 'cfb') return (await executeCfb(args, log)) as unknown as RunOutcome;
  if (args.sport === 'ncaam') {
    return executeNcaam({ season: args.season, runs: args.runs, seed: args.seed, workers: args.workers, snapshot: args.snapshot, out: args.out, traceRuns: args.traceRuns,
      mode: args.mode, modelSource: args.model, bracketFile: args.bracket, asOf: args.asOf }, log) as unknown as RunOutcome;
  }
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
function writeOut(args: CliArgs, startedAt: string, snap: NflSnapshot | NhlSnapshot | NbaSnapshot, results: ResultsDoc, gates: Gate[], save: (file: string) => void): RunOutcome {
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

/* ---------------- the NBA ---------------- */
/** a snapshot file's schema, read from its head */
function snapshotSchema(file: string): string | null {
  try { const head = fs.readFileSync(file, 'utf8').slice(0, 200); const m = /"schema"\s*:\s*"([^"]+)"/.exec(head); return m ? m[1] : null; } catch (_) { return null; }
}

async function executeNba(args: CliArgs, log: (s: string) => void): Promise<RunOutcome> {
  /* 1 inputs: build (frozen at --as-of, or now) or replay */
  const snap = args.snapshot ? readNbaSnapshot(args.snapshot) : await buildNbaSnapshot({ season: args.season, asOf: args.asOf, log });
  if (args.snapshot && args.asOf != null) throw Object.assign(new Error('--as-of builds a snapshot; a replayed snapshot carries its own as-of time'), { exitCode: 2 });
  if (!args.snapshot && snap.data.season !== args.season) throw Object.assign(new Error('the snapshot is season ' + snap.data.season + ', the run asks for ' + args.season), { exitCode: 2 });
  args = { ...args, season: snap.data.season };
  const inputGates = validateNbaInputs(snap, { allowIncompleteSchedule: args.allowIncompleteSchedule });
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const seed = args.seed != null ? parseSeed(args.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  const d = snap.data;
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · ' + d.season_label + ' as of ' + d.as_of + ' (' + d.as_of_games + ' games per club) · ' + d.games.filter((g) => !g.done).length + ' remaining games · sigma ' + (d.strength ? d.strength.sigma_points.toFixed(3) : '?') + ' · seed ' + seed);
  /* 2 simulate */
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'nba', data: d, seed, runs: args.runs, workers: args.workers, traceRuns: args.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const status = nbaMathStatus(d);
  const rec: Record<string, { w: number; l: number }> = {};
  for (const t of d.teams) rec[t.code] = { w: 0, l: 0 };
  for (const g of d.games) if (g.done) { if ((g.home_score as number) > (g.away_score as number)) { rec[g.home].w++; rec[g.away].l++; } else { rec[g.away].w++; rec[g.home].l++; } }
  const results = buildResults({ module, agg, seed, runs: args.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.model.model_version, config: d.config, rules_version: d.rules_version,
    started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: Date.now() - t0, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: rec[id], math_status: status[id] }) });
  (results as any).outcome_semantics = NBA_OUTCOME_SEMANTICS;
  /* 3 gates */
  const draws = agg.flags.tiebreak_random_drawing || 0, frac = draws / agg.n;
  const cupPts = agg.flags.cup_total_points_unmodelled || 0, cupDraws = agg.flags.cup_random_drawing || 0;
  const gates = inputGates.concat(runGates(results, agg.n, 'nba', [
    { id: 'run.random_drawings', status: frac <= args.maxUnsupportedFraction ? 'PASS' : 'WARN', blocks: 'none', detail: draws + ' of ' + agg.n + ' runs reached the random drawing of the tiebreaker (a rule of the league, seeded here, not an unsupported input)' },
    { id: 'run.configured_season', status: d.season === NBA_2026_27.season ? 'PASS' : 'FAIL', blocks: d.season === NBA_2026_27.season ? 'none' : 'publication', detail: 'the snapshot is season ' + d.season_label + (d.season === NBA_2026_27.season ? ', the configured season' : '; only ' + NBA_2026_27.label + ' is published (a past season is a replay)') },
    ...(d.cup ? [{ id: 'run.cup_tiebreaks', status: 'PASS' as const, blocks: 'none' as const, detail: cupPts + ' of ' + agg.n + ' runs reached the NBA Cup\'s total-points step without a game\'s points (the next step, the 2025-26 record, decided it; 0 when every simulated Group Play game has its served total); ' + cupDraws + ' reached the Cup\'s random drawing (a rule of the league, seeded)' }] : [])
  ]));
  return writeOut(args, startedAt, snap, results, gates, (f) => writeNbaSnapshot(f, snap));
}

/* ---------------- MLB ---------------- */
/** the tiebreak procedure, measured while unverified (mlb/config.ts tiebreakers.measured): a tie that decided a
    reported place in any run (a division title, a postseason place, a seed, the World Series host) refuses
    publication. Standings.rank breaks ties only inside the places it fills, so a tie below them is never counted. */
export function mlbTiebreakGate(tb: SeasonFact<string>, diags: Record<string, number>, n: number): Gate {
  const measured = tb.measured === true && !isVerified(tb);
  const ties = (diags['tiebreak:groups'] || 0) + (diags['tiebreak:world_series_home'] || 0);
  const ok = !measured || ties === 0;
  return { id: 'run.tiebreak_measured', status: ok ? 'PASS' : 'FAIL', blocks: ok ? 'none' : 'publication',
    detail: !measured ? 'not measured: the tiebreak procedure is ' + tb.verification
      : ties + ' tie(s) across ' + n + ' runs reached a reported place (a division title, a postseason place, a seed or the World Series host); the procedure is unverified, so ' + (ties ? 'the run is refused' : 'it decided nothing') };
}
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
    mlbTiebreakGate(d.config.tiebreakers, agg.diags, agg.n),
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
  if (o.results.run.sport === 'nba') return printNbaSummary(o, log);
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

function printNbaSummary(o: RunOutcome, log: (s: string) => void) {
  const r = o.results;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (o: any) => (100 * o.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * o.mcse).toFixed(1);
  const ents = (r.entities as any[]).slice().sort((a, b) => b.outcomes.win_title.probability - a.outcomes.win_title.probability);
  log('club  W-L    mean W   division   1st conf   play-in    playoffs   conf semis conf final conf champ title      (percent, ±95% Monte Carlo interval half-width)');
  for (const e of ents) log(e.entity_id.padEnd(5) + (e.record.w + '-' + e.record.l).padEnd(7) + e.mean_wins.toFixed(1).padStart(6) + '   ' + [e.outcomes.win_division, e.outcomes.finish_1, e.outcomes.play_in, e.outcomes.make_playoffs, e.outcomes.reach_conference_semifinals, e.outcomes.reach_conference_finals, e.outcomes.win_conference, e.outcomes.win_title].map(pp).join('  '));
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
      if ((o as unknown as GolfOutcome).sport === 'golf') {
        const g = o as unknown as GolfOutcome;
        printGolfSummary(g, console.log);
        if (!g.runs.length && g.refused.length) process.exit(2);
        process.exit(args.publish ? await publishGolf(g, console.log) : 0);
      }
      if ((o as unknown as TennisOutcome).sport === 'tennis') {
        const t = o as unknown as TennisOutcome;
        printTennisSummary(t, console.log);
        if (!t.runs.length && t.refused.length) process.exit(2);
        process.exit(args.publish ? await publishTennis(t, console.log) : 0);
      }
      if (args.sport === 'cfb') printCfbSummary(o as unknown as CfbRunOutcome, console.log);
      else if (args.sport === 'ncaam') printNcaamSummary(o as any, console.log);
      else if (o.results.run.sport === 'wnba') printWnbaSummary(o as any, console.log);
      else if (o.results.run.sport === 'ufc') printUfcSummary(o as any, console.log);
      else printSummary(o, console.log);
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

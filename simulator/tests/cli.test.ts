/* The command line and the workflow's plan: argument validation, replay of a
   frozen snapshot, and results that do not depend on the worker count.
   node simulator/tests/cli.test.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kit } from './_kit.ts';
import { nflFixture, clone } from './_fixture.ts';
import { parseArgs, execute } from '../src/cli/run.ts';
import { planRuns, NBA_CRON } from '../src/cli/plan.ts';
import { writeSnapshot, readSnapshot, codeHashes } from '../src/sports/nfl/inputs.ts';
import { hashCanonical, canonicalJson } from '../src/core/canonical.ts';
import { sportRegistry } from '../src/sports/registry.ts';

const T = kit('simulator command line');
const quiet = () => {};

/* 1 parseArgs refuses what it cannot run */
{
  T.eq('the production default is 100,000 runs and a dry run', [parseArgs([]).runs, parseArgs([]).publish], [100000, false]);
  T.throws('an unknown option', () => parseArgs(['--rnus', '5']), /unknown option/);
  T.throws('an option missing its value', () => parseArgs(['--runs', '--publish']), /needs a value/);
  T.throws('a fractional run count', () => parseArgs(['--runs', '1.5']), /--runs/);
  T.throws('zero workers', () => parseArgs(['--workers', '0']), /--workers/);
  T.throws('an invalid seed', () => parseArgs(['--seed', 'abc']));
  T.throws('more than five traced runs', () => parseArgs(['--trace-runs', '0,1,2,3,4,5']), /at most 5/);
  T.throws('--allow-unreconciled with --publish', () => parseArgs(['--publish', '--allow-unreconciled']), /dry runs only/);
  T.throws('an unknown sport', () => parseArgs(['--sport', 'cricket']), /unknown sport/);
}
/* 2 the workflow plan: strict validation of every value a shell will see */
{
  const ok = { sport: 'nfl', season: '2026', runs: '100000', seed: '', publish: 'false' };
  T.eq('a valid dispatch plans one dry run', planRuns('workflow_dispatch', ok).map((r) => [r.sport, r.season, r.runs, r.publish]), [['nfl', '2026', '100000', false]]);
  T.throws('runs with a shell metacharacter', () => planRuns('workflow_dispatch', { ...ok, runs: '100000;id' }), /runs must be/);
  T.throws('a seed with a space', () => planRuns('workflow_dispatch', { ...ok, seed: '1 2' }), /seed must be/);
  T.throws('a seed beyond 64 bits', () => planRuns('workflow_dispatch', { ...ok, seed: '18446744073709551616' }));
  T.throws('a season other than the configured one', () => planRuns('workflow_dispatch', { ...ok, season: '2025' }), /season must be 2026/);
  T.throws('a sport without a module', () => planRuns('workflow_dispatch', { ...ok, sport: 'tennis' }), /no simulation module/);
  T.throws('publish must be a boolean', () => planRuns('workflow_dispatch', { ...ok, publish: 'yes' }), /publish must be/);
  const blocked = sportRegistry().map((r) => r.key === 'nfl' ? { ...r, status: 'BLOCKED' as const, blockers: ['TEST: an unverified fact'] } : r);
  T.throws('publishing a BLOCKED sport is refused before anything runs', () => planRuns('workflow_dispatch', { ...ok, publish: 'true' }, blocked), /BLOCKED/);
  const nfl = sportRegistry().find((r) => r.key === 'nfl')!;
  if (nfl.status === 'ACTIVE') {
    T.chk('an ACTIVE sport plans a publication at 100,000 runs', planRuns('workflow_dispatch', { ...ok, publish: 'true' })[0].publish === true);
    T.throws('...but never with fewer than 100,000 runs', () => planRuns('workflow_dispatch', { ...ok, runs: '99999', publish: 'true' }), /at least 100000/);
  }
  const sch = planRuns('schedule', {}, undefined, new Date('2026-11-09T10:17:00Z'));
  T.chk('the schedule plans the nightly sports at 100,000 runs, publishing only an ACTIVE one (MLB and the WNBA after their seasons\' windows: not planned)', sch.map((r) => r.sport).join() === 'nfl,cfb,nhl' && sch.every((r) => r.runs === '100000' && r.publish === (r.status === 'ACTIVE')));
  T.eq('college football plans its configured season, and a dispatch can name it', [sch[1].season, planRuns('workflow_dispatch', { ...ok, sport: 'cfb' })[0].sport], ['2026', 'cfb']);
  T.eq('the NHL is planned under its end-year season key', sch.find((r) => r.sport === 'nhl')!.season, '2027');
  T.eq('a valid NHL dispatch', planRuns('workflow_dispatch', { ...ok, sport: 'nhl', season: '2027' }).map((r) => [r.sport, r.season]), [['nhl', '2027']]);
  T.throws('an NHL dispatch with the NFL\'s season is refused', () => planRuns('workflow_dispatch', { ...ok, sport: 'nhl', season: '2026' }), /season must be 2027/);
  T.throws('an unknown event', () => planRuns('push', {}), /unsupported event/);
  /* the NBA: its own cron, its end-year season key */
  const nbaSch = planRuns('schedule', { cron: NBA_CRON });
  T.eq('the NBA\'s cron plans the NBA alone, under its end-year key, at 100,000 runs', nbaSch.map((r) => [r.sport, r.season, r.runs]), [['nba', '2027', '100000']]);
  T.chk('... publishing exactly when the NBA is ACTIVE', nbaSch[0].publish === (sportRegistry().find((r) => r.key === 'nba')!.status === 'ACTIVE'));
  T.chk('the nightly cron never plans the NBA', !planRuns('schedule', { cron: '17 10 * * *' }).some((r) => r.sport === 'nba') && !sch.some((r) => r.sport === 'nba'));
  T.eq('a valid NBA dispatch', planRuns('workflow_dispatch', { ...ok, sport: 'nba', season: '2027' }).map((r) => [r.sport, r.season]), [['nba', '2027']]);
  T.throws('an NBA dispatch with the start-year season is refused', () => planRuns('workflow_dispatch', { ...ok, sport: 'nba', season: '2026' }), /season must be 2027/);
  const wf = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.github', 'workflows', 'simulator.yml'), 'utf8');
  T.chk('the workflow schedules the NBA\'s cron and passes it to the plan', wf.includes("- cron: '" + NBA_CRON + "'") && /SIM_CRON: \$\{\{ github\.event\.schedule \}\}/.test(wf));
}
/* 3 replay a frozen snapshot through the real command path. The fixture's
   recorded code identity is re-stamped to this checkout (TEST ONLY: this
   suite tests the command line, not the code-identity gate, which
   nfl_sim.test.ts covers), and its content hash recomputed. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-sim-cli-'));
try {
  const snap = clone(nflFixture());
  snap.data.code_sha256 = codeHashes();
  snap.input_hash = hashCanonical(snap.data);
  const file = path.join(tmp, 'snapshot.json');
  writeSnapshot(file, snap);
  T.eq('writeSnapshot / readSnapshot round-trip the content hash', readSnapshot(file).input_hash, snap.input_hash);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8')); tampered.data.games[0].home_score = 99;
  fs.writeFileSync(path.join(tmp, 'tampered.json'), JSON.stringify(tampered));
  T.throws('a snapshot edited after it was built is refused', () => readSnapshot(path.join(tmp, 'tampered.json')), /hash mismatch/);

  const base = ['--snapshot', file, '--runs', '3000', '--dry-run', '--allow-unreconciled'];
  const a = await execute(parseArgs([...base, '--workers', '1', '--out', path.join(tmp, 'a')]), quiet);
  const b = await execute(parseArgs([...base, '--workers', '3', '--out', path.join(tmp, 'b')]), quiet);
  const c = await execute(parseArgs([...base, '--workers', '2', '--seed', '12345', '--out', path.join(tmp, 'c')]), quiet);
  const body = (o: typeof a) => canonicalJson(o.results.entities);
  T.chk('1 worker and 3 workers give identical results (same seed: derived from the input hash)', body(a) === body(b));
  T.chk('the derived seed is the first 64 bits of the input hash', a.results.run.seed === BigInt('0x' + snap.input_hash.slice(0, 16)).toString());
  T.chk('another seed gives different counts', body(a) !== body(c));
  T.eq('the results name the replayed input hash', [a.results.run.input_hash, b.results.run.input_hash], [snap.input_hash, snap.input_hash]);
  T.chk('every format sum holds in the replay', a.results.checks.sum_rule_errors.length === 0 && a.results.checks.finite_and_bounded);
  const gate = (o: typeof a, id: string) => o.gates.find((g) => g.id === id)!;
  T.chk('3,000 runs can never be published (run.count blocks publication)', gate(a, 'run.count').blocks === 'publication' && !a.publishable);
  const st = sportRegistry().find((r) => r.key === 'nfl')!.status;
  T.chk('the sport.active gate follows the registry: it blocks publication unless the sport is ACTIVE', gate(a, 'sport.active').status === (st === 'ACTIVE' ? 'PASS' : 'FAIL') && gate(a, 'sport.active').blocks === (st === 'ACTIVE' ? 'none' : 'publication'));
  const files = fs.readdirSync(path.join(tmp, 'a')).sort();
  T.eq('a dry run writes the snapshot, results, gates and manifest locally, and no publish record', files, ['gates.json', 'manifest.json', 'results.json', 'snapshot.json']);
  const man = JSON.parse(fs.readFileSync(path.join(tmp, 'a', 'manifest.json'), 'utf8'));
  T.chk('the manifest says not published, with the input hash', man.published === false && man.publishable === false && man.input_hash === snap.input_hash);
  T.eq('the written snapshot replays to the same input hash', readSnapshot(path.join(tmp, 'a', 'snapshot.json')).input_hash, snap.input_hash);
  const d = await execute(parseArgs(['--snapshot', path.join(tmp, 'a', 'snapshot.json'), '--runs', '3000', '--dry-run', '--allow-unreconciled', '--workers', '2', '--out', path.join(tmp, 'd')]), quiet);
  T.chk('replaying the written snapshot reproduces every count', body(d) === body(a));
  /* a snapshot whose recorded model code differs from this checkout is not replayed */
  const drift = clone(snap); drift.data.code_sha256['football/nfl_model.js'] = '0'.repeat(64); drift.input_hash = hashCanonical(drift.data);
  writeSnapshot(path.join(tmp, 'drift.json'), drift);
  let refused: any = null;
  try { await execute(parseArgs(['--snapshot', path.join(tmp, 'drift.json'), '--runs', '1000', '--dry-run', '--allow-unreconciled', '--out', path.join(tmp, 'e')]), quiet); } catch (e) { refused = e; }
  T.chk('a snapshot built with other model code is refused before anything is simulated (exit 2)', !!refused && refused.exitCode === 2 && /replay\.code_identity/.test(refused.message) && !fs.existsSync(path.join(tmp, 'e')), refused && refused.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(T.done());

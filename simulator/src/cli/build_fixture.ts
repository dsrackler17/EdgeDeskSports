/* Rebuild simulator/fixtures/nfl_2026_wk7_snapshot.json.gz — the frozen NFL
   input snapshot the test suites run on (inputs only: schedule, results, the
   served model's fair margins; never a simulated probability).
     node simulator/src/cli/build_fixture.ts [--from simulator/out/<dir>/snapshot.json] [--offline]
   With --sport nhl: simulator/fixtures/nhl_2027_snapshot.json.gz, the NHL
   2026-27 input snapshot (results, schedule, the served model's λ). */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO } from '../sports/nfl/model_adapter.ts';
import { buildNflSnapshot, readSnapshot } from '../sports/nfl/inputs.ts';
import { buildNhlSnapshot, readNhlSnapshot } from '../sports/nhl/inputs.ts';

const a = process.argv.slice(2), from = a.indexOf('--from') >= 0 ? a[a.indexOf('--from') + 1] : null;
if (a.includes('--sport') && a[a.indexOf('--sport') + 1] === 'nhl') {
  const snap = from ? readNhlSnapshot(from) : await buildNhlSnapshot({ offline: a.includes('--offline') });
  (snap.meta as any).fixture_note = 'TEST FIXTURE: the NHL 2026-27 input snapshot as built on ' + snap.meta.built_at.slice(0, 10) + ' (results through ' + snap.data.as_of.last_result_date + '). Inputs only; no simulated probability. Rebuild with simulator/src/cli/build_fixture.ts --sport nhl when the hockey model, a study file or the snapshot schema changes.';
  const out = path.join(REPO, 'simulator', 'fixtures', 'nhl_2027_snapshot.json.gz');
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
  console.log('wrote ' + path.relative(REPO, out) + ' (input ' + snap.input_hash.slice(0, 12) + ', ' + fs.statSync(out).size + ' bytes)');
  process.exit(0);
}
const snap = from ? readSnapshot(from) : await buildNflSnapshot({ offline: a.includes('--offline') });
(snap.meta as any).fixture_note = 'TEST FIXTURE: the NFL input snapshot as built on ' + snap.meta.built_at.slice(0, 10) + ' (as-of week ' + snap.data.as_of_week + '). Inputs only; no simulated probability. Rebuild with simulator/src/cli/build_fixture.ts when football/engine.js or the snapshot schema changes.';
const out = path.join(REPO, 'simulator', 'fixtures', 'nfl_2026_wk7_snapshot.json.gz');
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
console.log('wrote ' + path.relative(REPO, out) + ' (input ' + snap.input_hash.slice(0, 12) + ', ' + fs.statSync(out).size + ' bytes)');

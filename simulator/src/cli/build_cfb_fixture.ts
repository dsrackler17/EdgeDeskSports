/* Rebuild simulator/fixtures/cfb_2026_wk7_snapshot.json.gz — the frozen CFB
   input snapshot the test suites run on (inputs only: membership, schedule,
   results, the engine's fair margins and postseason pairings; never a
   simulated probability).
     node simulator/src/cli/build_cfb_fixture.ts [--from simulator/out/<dir>/snapshot.json] [--offline] */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO } from '../sports/cfb/engine_adapter.ts';
import { buildCfbSnapshot, readSnapshot } from '../sports/cfb/inputs.ts';

const a = process.argv.slice(2), from = a.indexOf('--from') >= 0 ? a[a.indexOf('--from') + 1] : null;
const snap = from ? readSnapshot(from) : await buildCfbSnapshot({ offline: a.includes('--offline') });
(snap.meta as any).fixture_note = 'TEST FIXTURE: the CFB input snapshot as built on ' + snap.meta.built_at.slice(0, 10) + ' (as-of week ' + snap.data.as_of_week + '). Inputs only; no simulated probability. Rebuild with simulator/src/cli/build_cfb_fixture.ts when football/cfb_p4, the rules config or the snapshot schema changes.';
const out = path.join(REPO, 'simulator', 'fixtures', 'cfb_2026_wk' + snap.data.as_of_week + '_snapshot.json.gz');
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
console.log('wrote ' + path.relative(REPO, out) + ' (input ' + snap.input_hash.slice(0, 12) + ', ' + fs.statSync(out).size + ' bytes)');

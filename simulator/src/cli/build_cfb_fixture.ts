/* Rebuild simulator/fixtures/cfb_2026_wk7_snapshot.json.gz — the frozen CFB
   input snapshot the test suites run on (inputs only: membership, schedule,
   results, the engine's fair margins and postseason pairings; never a
   simulated probability).
     node simulator/src/cli/build_cfb_fixture.ts [--from simulator/out/<dir>/snapshot.json] [--offline] [--restamp]

   --restamp: the pricing code changed but the snapshot's numbers did not. A
   fresh build is compared with the committed fixture of the same as-of week,
   field by field (teams and ratings, every game and its engine price, every
   postseason pairing, the model, the configs); only when all of them are
   identical is the committed fixture kept, with its code identity moved to
   this checkout. Anything else is a real change and is refused: rebuild
   without --restamp. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO } from '../sports/cfb/engine_adapter.ts';
import { buildCfbSnapshot, readSnapshot } from '../sports/cfb/inputs.ts';
import { hashCanonical } from '../core/canonical.ts';

const a = process.argv.slice(2), from = a.indexOf('--from') >= 0 ? a[a.indexOf('--from') + 1] : null;
const snap = from ? readSnapshot(from) : await buildCfbSnapshot({ offline: a.includes('--offline') });
const out = path.join(REPO, 'simulator', 'fixtures', 'cfb_2026_wk' + snap.data.as_of_week + '_snapshot.json.gz');
if (a.includes('--restamp')) {
  if (!fs.existsSync(out)) throw new Error('--restamp: no committed fixture for as-of week ' + snap.data.as_of_week + ' (' + path.relative(REPO, out) + '): rebuild without --restamp');
  const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString('utf8'));
  const fresh = snap.data as unknown as Record<string, unknown>, kept = old.data as Record<string, unknown>;
  /* the code identity is what moves; the live availability layer's clock and
     the finals overlay's read log are not inputs to a price (an applied final
     changes the games, which are compared) */
  const skip = new Set(['code_sha256', 'availability', 'results_overlay']);
  const keys = [...new Set([...Object.keys(fresh), ...Object.keys(kept)])].filter((k) => !skip.has(k));
  const diff = keys.filter((k) => JSON.stringify(fresh[k]) !== JSON.stringify(kept[k]));
  if (JSON.stringify(snap.data.availability.entries) !== JSON.stringify(old.data.availability.entries)) diff.push('availability.entries');
  if (diff.length) throw new Error('--restamp: a fresh build differs from the committed fixture in ' + diff.join(', ') + ': the pricing change moved the snapshot, rebuild without --restamp');
  const moved = Object.keys(snap.data.code_sha256).filter((f) => snap.data.code_sha256[f] !== old.data.code_sha256[f]);
  old.data.code_sha256 = snap.data.code_sha256;
  old.input_hash = hashCanonical(old.data);
  old.meta.code_identity_restamped = { at: snap.meta.built_at, files: moved,
    basis: 'a fresh build on ' + snap.meta.built_at.slice(0, 10) + ' reproduced every compared field of this fixture exactly (' + keys.length + ' fields and the availability entries); only the code identity was moved' };
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(old), { level: 9 }));
  console.log('restamped ' + path.relative(REPO, out) + ' (' + (moved.join(', ') || 'no file moved') + '; input ' + old.input_hash.slice(0, 12) + ')');
} else {
  (snap.meta as any).fixture_note = 'TEST FIXTURE: the CFB input snapshot as built on ' + snap.meta.built_at.slice(0, 10) + ' (as-of week ' + snap.data.as_of_week + '). Inputs only; no simulated probability. Rebuild with simulator/src/cli/build_cfb_fixture.ts when football/cfb_p4, the rules config or the snapshot schema changes (--restamp when a pricing change leaves every number as it was).';
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
  console.log('wrote ' + path.relative(REPO, out) + ' (input ' + snap.input_hash.slice(0, 12) + ', ' + fs.statSync(out).size + ' bytes)');
}

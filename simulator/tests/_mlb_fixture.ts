/* the committed MLB history snapshots (simulator/src/cli/build_mlb_fixture.ts) */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { checkSnapshot, type MlbSnapshot } from '../src/sports/mlb/inputs.ts';
import { MLB_FIXTURES } from '../src/cli/build_mlb_fixture.ts';

const cache = new Map<string, MlbSnapshot>();
export function mlbFixture(which: 'ws' | 'aug'): MlbSnapshot {
  if (!cache.has(which)) cache.set(which, checkSnapshot(JSON.parse(zlib.gunzipSync(fs.readFileSync(MLB_FIXTURES[which].file)).toString('utf8'))));
  return JSON.parse(JSON.stringify(cache.get(which)));
}

/* the committed NBA input snapshots (simulator/fixtures): the 2026-27 season as of its first week, and
   2025-26 frozen during the first round (2026-04-25) — inputs only, never a simulated probability */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { NbaSnapshot } from '../src/sports/nba/inputs.ts';
import { hashCanonical } from '../src/core/canonical.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NBA_LIVE_FIXTURE = path.join(HERE, '..', 'fixtures', 'nba_2027_snapshot.json.gz');
export const NBA_REPLAY_FIXTURE = path.join(HERE, '..', 'fixtures', 'nba_2026_r1_snapshot.json.gz');
export function nbaFixture(which: 'live' | 'replay'): NbaSnapshot {
  const f = which === 'live' ? NBA_LIVE_FIXTURE : NBA_REPLAY_FIXTURE;
  const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')) as NbaSnapshot;
  if (hashCanonical(s.data) !== s.input_hash) throw new Error('fixture snapshot hash mismatch: ' + f);
  return s;
}

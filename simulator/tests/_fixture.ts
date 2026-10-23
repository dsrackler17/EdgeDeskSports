/* the committed NFL input snapshot (simulator/fixtures/nfl_2026_wk7_snapshot.json.gz) */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { NflSnapshot } from '../src/sports/nfl/inputs.ts';
import { hashCanonical } from '../src/core/canonical.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(HERE, '..', 'fixtures', 'nfl_2026_wk7_snapshot.json.gz');
export function nflFixture(): NflSnapshot {
  const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8')) as NflSnapshot;
  if (hashCanonical(s.data) !== s.input_hash) throw new Error('fixture snapshot hash mismatch');
  return s;
}
export function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

/* the committed NHL 2026-27 input snapshot (simulator/fixtures/nhl_2027_snapshot.json.gz) */
import type { NhlSnapshot } from '../src/sports/nhl/inputs.ts';
export const NHL_FIXTURE = path.join(HERE, '..', 'fixtures', 'nhl_2027_snapshot.json.gz');
export function nhlFixture(): NhlSnapshot {
  const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(NHL_FIXTURE)).toString('utf8')) as NhlSnapshot;
  if (hashCanonical(s.data) !== s.input_hash) throw new Error('NHL fixture snapshot hash mismatch');
  return s;
}

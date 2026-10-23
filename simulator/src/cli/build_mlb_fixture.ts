/* ===========================================================================
   Build the committed MLB history snapshots the MLB suites run against
   (each needs a full point-in-time replay of the served model, ~90 s):

     simulator/fixtures/mlb_2025_ws_g3_snapshot.json.gz   2025, the morning of World
         Series game 3 (2025-10-27): the regular season, the Wild Card Series,
         Division Series, LCS and World Series games 1-2 are final (fixed);
         game 3's starters are the announced ones (Confirmed)
     simulator/fixtures/mlb_2025_aug15_snapshot.json.gz   2025 as of 2025-08-15:
         a mid-season state with every rotation, doubleheader and the whole
         postseason still to be simulated

     node simulator/src/cli/build_mlb_fixture.ts [ws|aug|all]
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildMlbHistorySnapshot } from '../sports/mlb/inputs.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MLB_FIXTURES = {
  ws: { file: path.join(HERE, '..', '..', 'fixtures', 'mlb_2025_ws_g3_snapshot.json.gz'), season: 2025, asOf: '2025-10-27', confirmThrough: '2025-10-28' },
  aug: { file: path.join(HERE, '..', '..', 'fixtures', 'mlb_2025_aug15_snapshot.json.gz'), season: 2025, asOf: '2025-08-15', confirmThrough: undefined }
};

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const which = process.argv[2] || 'all';
  for (const [k, f] of Object.entries(MLB_FIXTURES)) {
    if (which !== 'all' && which !== k) continue;
    const t = Date.now();
    const snap = buildMlbHistorySnapshot({ season: f.season, asOf: f.asOf, confirmThrough: f.confirmThrough });
    fs.writeFileSync(f.file, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
    console.log('wrote ' + path.relative(process.cwd(), f.file) + ' (input ' + snap.input_hash.slice(0, 12) + ', ' + snap.data.games.filter((g) => g.status !== 'final').length + ' games to simulate, ' + ((Date.now() - t) / 1000).toFixed(0) + ' s)');
  }
}

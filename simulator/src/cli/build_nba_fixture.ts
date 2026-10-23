/* Rebuild the committed NBA input snapshots the test suites run on (inputs only: schedule, results,
   the served model's means; never a simulated probability):
     simulator/fixtures/nba_2027_snapshot.json.gz      the 2026-27 season as built (live)
     simulator/fixtures/nba_2026_r1_snapshot.json.gz   2025-26 frozen at 2026-04-25 (first round in progress)
   Needs the NBA work tables (node nba/ingest/season.js --season all) and about ten minutes per snapshot.
     node simulator/src/cli/build_nba_fixture.ts [--live FILE] [--replay FILE]   (reuse built snapshots) */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO } from '../sports/nba/model_adapter.ts';
import { buildNbaSnapshot, readSnapshot } from '../sports/nba/inputs.ts';

const a = process.argv.slice(2), opt = (k: string) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : null);
for (const [which, file] of [['live', 'nba_2027_snapshot.json.gz'], ['replay', 'nba_2026_r1_snapshot.json.gz']] as const) {
  const from = opt('--' + which);
  const snap = from ? readSnapshot(from) : which === 'live' ? await buildNbaSnapshot({ log: console.log }) : await buildNbaSnapshot({ season: 2026, asOf: '2026-04-25T00:00:00Z', log: console.log });
  /* the slate check, recorded with the fixture: for every game the committed slate priced from the same data,
     the snapshot's mean must be the slate's baseline (nba/roster_inputs.json) */
  const ri = JSON.parse(fs.readFileSync(path.join(REPO, 'nba', 'roster_inputs.json'), 'utf8'));
  const byId = new Map(snap.data.games.map((g) => [g.game_id, g]));
  const slate = which === 'live' ? (ri.games as any[]).filter((g) => byId.get(String(g.game_id)) && byId.get(String(g.game_id))!.model).map((g) => ({ game_id: String(g.game_id), slate_mu: g.baseline.mu_m, snapshot_mu: byId.get(String(g.game_id))!.model!.mu })) : [];
  (snap.meta as any).fixture_note = 'TEST FIXTURE: the NBA input snapshot (' + which + ') as built on ' + snap.meta.built_at.slice(0, 10) + ', as of ' + snap.data.as_of + '. Inputs only; no simulated probability. Rebuild with simulator/src/cli/build_nba_fixture.ts when the NBA model, the snapshot schema or a study file changes.';
  (snap.meta as any).slate_check = { source: 'nba/roster_inputs.json', generated_at: ri.generated_at, games: slate };
  const out = path.join(REPO, 'simulator', 'fixtures', file);
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(snap), { level: 9 }));
  console.log('wrote ' + path.relative(REPO, out) + ' (input ' + snap.input_hash.slice(0, 12) + ', ' + fs.statSync(out).size + ' bytes; slate check ' + slate.length + ' games, max |diff| ' + Math.max(0, ...slate.map((x) => Math.abs(x.slate_mu - x.snapshot_mu))) + ')');
}

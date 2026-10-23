/* Rebuild simulator/fixtures/cfb_history.json.gz — the 2014-2025 FBS games the
   CFB rules and committee suites replay offline: every game with an FBS side,
   from cfbfastR-data schedules (the simulator's own feed), with only the
   columns the suites read. Observed data; no model output.
     node simulator/src/research/build_cfb_history_fixture.ts */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO, loadSeasonFeedSync, schedUrl } from '../sports/cfb/engine_adapter.ts';
import { sha256Hex } from '../core/canonical.ts';

const rows: unknown[] = [], sources: Array<{ season: number; url: string; sha256: string }> = [];
for (let y = 2014; y <= 2025; y++) {
  const file = path.join(REPO, 'simulator', '.cache', 'feeds', 'cfb', 'sched_' + y + '.csv');
  sources.push({ season: y, url: schedUrl(y), sha256: sha256Hex(fs.readFileSync(file)) });
  for (const g of loadSeasonFeedSync(y)) {
    if (g.home_division !== 'fbs' && g.away_division !== 'fbs') continue;
    rows.push([g.game_id, g.season, g.week, g.season_type, g.start_date, g.completed ? 1 : 0, g.neutral ? 1 : 0, g.conference_game ? 1 : 0, g.notes, g.venue_id,
      g.home, g.home_division, g.home_conference, g.home_points, g.away, g.away_division, g.away_conference, g.away_points]);
  }
}
const doc = { schema: 'edgedesk_sim_cfb_history_v1', columns: ['game_id', 'season', 'week', 'season_type', 'start_date', 'completed', 'neutral', 'conference_game', 'notes', 'venue_id',
  'home', 'home_division', 'home_conference', 'home_points', 'away', 'away_division', 'away_conference', 'away_points'], sources, rows };
const out = path.join(REPO, 'simulator', 'fixtures', 'cfb_history.json.gz');
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
console.log('wrote ' + path.relative(REPO, out) + ' (' + rows.length + ' games, ' + fs.statSync(out).size + ' bytes)');

#!/usr/bin/env node
/* ===========================================================================
   The NHL warehouse (supabase/nhl_warehouse.sql) on a real PostgreSQL:
   it applies with an all-ok report, re-applies without change, keeps the
   pregame predictions append-only and pregame, serves EdgeDesk's outputs to
   readers, and keeps the player statistics (NHL-derived) away from them.

   Run: node tools/hockey/nhl_warehouse_sql.test.js   (NHL_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('NHL warehouse SQL');
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'nhl_warehouse.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
T.chk('the migration is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261013150000_nhl_warehouse.sql'), 'utf8') === SQL);
T.chk('the file is additive: no drop table, no truncate, no delete from', !/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\b/i.test(SQL.replace(/--[^\n]*/g, '')));
const db = PG.start('nhlwh');
if (db.skip) {
  if (process.env.NHL_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const refused = (label, fn, re) => { const m = db.mustFail(fn); T.chk(label, m != null && re.test(m), m); };
try {
  let out = db.applyFile(FILE);
  T.chk('it applies and its report is all ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 5, out);
  out = db.applyFile(FILE);
  T.chk('re-applying is a no-op with the same report', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 5, out);
  db.service(`insert into nhl.games (game_id, season, game_type, game_date, start_utc, home, away, source) values (2026020090, 2027, 'R', '2026-10-13', '2026-10-13T23:00:00Z', 'DET', 'NJD', 'sportsdataverse_nhl');`);
  db.service(`insert into nhl.predictions (id, game_id, model_id, recorded_at, start_utc, home, away, p_home) values ('abc', 2026020090, 'edgedesk_nhl_v1:xg_no_goalie', '2026-10-13T12:51:18Z', '2026-10-13T23:00:00Z', 'DET', 'NJD', 0.5764);`);
  T.chk('a pregame prediction is stored', db.service(`select p_home from nhl.predictions where id = 'abc';`) === '0.5764');
  refused('an update to a prediction is refused (append-only)', () => db.service(`update nhl.predictions set p_home = 0.6 where id = 'abc';`), /append-only/);
  refused('a delete of a prediction is refused (append-only)', () => db.service(`delete from nhl.predictions where id = 'abc';`), /append-only/);
  refused('a prediction recorded at or after the start is refused', () => db.service(`insert into nhl.predictions (id, game_id, model_id, recorded_at, start_utc, home, away, p_home) values ('late', 2026020090, 'm', '2026-10-13T23:00:00Z', '2026-10-13T23:00:00Z', 'DET', 'NJD', 0.5);`), /nhl_predictions_pregame/);
  db.service(`insert into nhl.predictions (id, game_id, model_id, recorded_at, start_utc, home, away, p_home) values ('abc', 2026020090, 'x', '2026-10-13T12:00:00Z', '2026-10-13T23:00:00Z', 'DET', 'NJD', 0.1) on conflict (id) do nothing;`);
  T.chk('insert-or-ignore leaves the original prediction untouched', db.service(`select p_home from nhl.predictions where id = 'abc';`) === '0.5764');
  T.chk('readers (anon) see EdgeDesk\'s predictions', db.anon(`select count(*) from nhl.predictions;`) === '1');
  T.chk('readers (anon) see the games', db.anon(`select home from nhl.games;`) === 'DET');
  refused('readers cannot write a prediction', () => db.anon(`insert into nhl.predictions (id, game_id, model_id, recorded_at, start_utc, home, away, p_home) values ('z', 1, 'm', now(), now() + interval '1 hour', 'A', 'B', 0.5);`), /permission denied|row-level security/);
  db.service(`insert into nhl.skater_games (game_id, player_id, team, goals) values (2026020090, 8477987, 'DET', 1);`);
  refused('readers cannot see per-player statistics (NHL-derived, pending licence review)', () => db.anon(`select count(*) from nhl.skater_games;`), /permission denied/);
  refused('an unknown source status is refused', () => db.service(`insert into nhl.sources (source_id, name, status) values ('x', 'X', 'MAYBE');`), /check/);
  db.service(`insert into nhl.sync_state (dataset, part, sha256, rows) values ('games', '2027', 'h', 1) on conflict (dataset, part) do update set sha256 = excluded.sha256;`);
  T.chk('sync state upserts on (dataset, part)', db.service(`select count(*) from nhl.sync_state;`) === '1');
} catch (e) { T.chk('the run completed', false, String(e.message).slice(0, 500)); }
finally { db.stop(); }
process.exit(T.done());

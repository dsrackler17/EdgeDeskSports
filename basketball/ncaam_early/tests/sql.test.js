#!/usr/bin/env node
'use strict';
/* ===========================================================================
   supabase/ncaam_early.sql on a real, throwaway PostgreSQL (with the repo's
   Supabase shim, which reproduces Supabase's default client grants).

     1  it applies twice; every report row ok; the mirror is a byte copy
     2  no client role (anon, authenticated) can read or write any table or
        call any writer; readiness is callable by anyone and holds no row
     3  writes: upsert counts; a changed row updates, an identical one does not
     4  snapshots: a line or portal entry is stored again only when it changes
     5  rosters: a team's capture is stored only when it changes, and the
        roster known at a moment is reconstructable (point in time)
     6  append-only tables refuse update, delete and truncate; a finished run
        cannot change; a write needs a running run
     7  derived rows: the stale ones of a season are removed by the moves run
     8  readiness: not_started -> warn (stale) -> ok -> down (repeated failure),
        box coverage and the quota warning
   NCAAM_EARLY_SQL_REQUIRED=1 (CI): a missing PostgreSQL FAILS, never skips.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', '..', '..', 'tools', 'personal', '_pg.js'));

const T = PG.kit('NCAAM-EARLY SQL');
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'ncaam_early.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const code = SQL.replace(/--[^\n]*/g, ' ');
T.chk('static: no psql meta-command', !/^\s*\\/m.test(code));
T.chk('static: it ends in a report', /case when got = want then 'ok' else 'CHECK THIS' end/.test(SQL.slice(-3000)));
T.chk('static: nothing is dropped', !/\bdrop\s+(table|function|view|schema|trigger|policy)\b/i.test(code));
T.chk('static: the migration mirror is a byte copy', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261101130000_ncaam_early.sql')).equals(fs.readFileSync(FILE)));

const db = PG.start('ncaamearly');
if (db.skip) {
  if (process.env.NCAAM_EARLY_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did NOT run (not verified)');
  process.exit(T.done());
}
const J = (o) => { try { return JSON.parse(o); } catch (_) { return o; } };
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const svc = (s) => J(db.service(s + ';'));
const begin = (part, season) => svc("select public.ncaam_es_begin_run('" + part + "', " + season + ", 'scheduled', 'sha')");
const put = (run, table, rows) => svc("select public.ncaam_es_put('" + run + "', '" + table + "', " + lit(rows) + ')');
const finish = (run, status, quota) => svc("select public.ncaam_es_finish_run('" + run + "', '" + status + "', 1, 0, 1, 1, " + (quota == null ? 'null' : quota) + ", '{}'::jsonb)");
const rows = (o) => (o.match(/\|(ok|CHECK THIS)$/gm) || []);
const TABLES = ['ncaam_es_runs', 'ncaam_es_alerts', 'ncaam_es_config', 'ncaam_es_teams', 'ncaam_es_conferences', 'ncaam_es_conference_members', 'ncaam_es_venues', 'ncaam_es_games', 'ncaam_es_box_team',
  'ncaam_es_player_seasons', 'ncaam_es_roster_captures', 'ncaam_es_rosters', 'ncaam_es_portal', 'ncaam_es_recruits', 'ncaam_es_lines', 'ncaam_es_player_moves', 'ncaam_es_departed', 'ncaam_es_coaches', 'ncaam_es_availability'];

try {
  /* ── 1 ── */
  let out = db.applyFile(FILE);
  T.chk('1 · it applies; every report row ok', rows(out).length === 6 && rows(out).every((r) => /ok$/.test(r)), out.slice(-800));
  out = db.applyFile(FILE);
  T.chk('1 · and a second time', rows(out).length === 6 && rows(out).every((r) => /ok$/.test(r)));
  T.chk('1 · readiness before any run: not_started', J(db.anon('select public.ncaam_es_readiness();')).state === 'not_started');

  /* ── 2 ── */
  const deniedRead = TABLES.filter((t) => db.mustFail(() => db.anon('select count(*) from public.' + t + ';')) && db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from public.' + t + ';')));
  T.chk('2 · anon and authenticated cannot read any of the 19 tables', deniedRead.length === 19, TABLES.filter((t) => !deniedRead.includes(t)));
  T.chk('2 · a client cannot insert a game', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', "insert into public.ncaam_es_games (game_id, season, start_utc, status, home_team_id, away_team_id) values (1, 2027, now(), 'SCHEDULED', 1, 2);")));
  const writers = ["public.ncaam_es_begin_run('games', 2027, 'scheduled', 'x')", "public.ncaam_es_put(gen_random_uuid(), 'ncaam_es_games', '[]'::jsonb)", "public.ncaam_es_put_rosters(gen_random_uuid(), '[]'::jsonb)",
    "public.ncaam_es_alert(null, 'FAILURE', 'X', 'y')", "public.ncaam_es_replace_derived(gen_random_uuid(), 2027)"];
  T.chk('2 · no client can call a writer', writers.every((w) => /permission denied/.test(db.mustFail(() => db.anon('select ' + w + ';')) || '') && /permission denied/.test(db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', 'select ' + w + ';')) || '')));

  /* ── 3 ── */
  const r1 = begin('games', 2027);
  const g = (o) => Object.assign({ game_id: 1, season: 2027, start_utc: '2026-11-03T00:00:00Z', status: 'SCHEDULED', home_team_id: 1, away_team_id: 2 }, o);
  T.chk('3 · upsert: new rows are inserted', put(r1, 'ncaam_es_games', [g(), g({ game_id: 2 })]).inserted === 2);
  T.chk('3 · upsert: the same rows again change nothing', put(r1, 'ncaam_es_games', [g(), g({ game_id: 2 })]).unchanged === 2);
  const u = put(r1, 'ncaam_es_games', [g({ status: 'FINAL', home_points: 70, away_points: 60, assumed_available_at: '2026-11-03T04:00:00Z' })]);
  T.chk('3 · upsert: a changed row is updated', u.updated === 1 && db.sql("select status || home_points from public.ncaam_es_games where game_id = 1") === 'FINAL70');
  T.chk('3 · an unknown table is refused', /not a table it writes/.test(db.mustFail(() => db.service("select public.ncaam_es_put('" + r1 + "', 'ncaam_es_runs', '[]'::jsonb);")) || ''));
  T.chk('3 · player seasons: a whole-season row and an "as of" row of one player coexist',
    put(r1, 'ncaam_es_player_seasons', [{ season: 2026, team_id: 1, athlete_id: 9, minutes: 900 }, { season: 2026, team_id: 1, athlete_id: 9, as_of: '2025-12-01', minutes: 200 }]).inserted === 2);

  /* ── 4 ── */
  const ln = (spread, at) => ({ game_id: 1, season: 2027, provider: 'P', spread, captured_at: at, pit: 'LIVE' });
  T.chk('4 · lines: a first capture is stored', put(r1, 'ncaam_es_lines', [ln(-3, '2026-11-01T00:00:00Z')]).inserted === 1);
  T.chk('4 · lines: an identical later capture is not', put(r1, 'ncaam_es_lines', [ln(-3, '2026-11-01T01:00:00Z')]).inserted === 0);
  T.chk('4 · lines: a moved line is stored as a new row, the old one kept', put(r1, 'ncaam_es_lines', [ln(-4.5, '2026-11-01T02:00:00Z')]).inserted === 1 && db.sql('select count(*) from public.ncaam_es_lines') === '2');
  const pe = (dest, at) => ({ portal_id: 7, year: 2026, first_name: 'A', last_name: 'B', origin_name: 'X', dest_team_id: dest, captured_at: at });
  T.chk('4 · portal: an entry whose destination is filled in later is stored again', put(r1, 'ncaam_es_portal', [pe(null, '2026-04-01T00:00:00Z')]).inserted === 1 && put(r1, 'ncaam_es_portal', [pe(null, '2026-04-02T00:00:00Z')]).inserted === 0 && put(r1, 'ncaam_es_portal', [pe(5, '2026-05-01T00:00:00Z')]).inserted === 1);
  finish(r1, 'ok', 900);

  /* ── 5 ── */
  const r2 = begin('rosters', 2027);
  const ro = (pid, name, at) => ({ season: 2027, team_id: 1, player_id: pid, name, captured_at: at, pit: 'LIVE' });
  const pr = (rs) => svc("select public.ncaam_es_put_rosters('" + r2 + "', " + lit(rs) + ')');
  T.chk('5 · rosters: the first capture of a team is stored', pr([ro(1, 'A', '2026-10-20T00:00:00Z'), ro(2, 'B', '2026-10-20T00:00:00Z')]).teams_changed === 1);
  T.chk('5 · rosters: the same roster the next day is not stored again', pr([ro(1, 'A', '2026-10-21T00:00:00Z'), ro(2, 'B', '2026-10-21T00:00:00Z')]).teams_unchanged === 1);
  T.chk('5 · rosters: a player leaving makes a new capture', pr([ro(1, 'A', '2026-10-25T00:00:00Z')]).teams_changed === 1);
  const asOf = (t) => db.sql("select string_agg(r.name, ',' order by r.name) from public.ncaam_es_rosters r join (select season, team_id, max(captured_at) as at from public.ncaam_es_roster_captures where captured_at <= '" + t + "' group by 1, 2) c using (season, team_id) where r.captured_at = c.at");
  T.chk('5 · point in time: the roster known on 22 Oct has A and B; on 26 Oct only A', asOf('2026-10-22T00:00:00Z') === 'A,B' && asOf('2026-10-26T00:00:00Z') === 'A');
  T.chk('5 · rosters: two capture times for one team in one call are refused', /more than one capture time/.test(db.mustFail(() => db.service("select public.ncaam_es_put_rosters('" + r2 + "', " + lit([ro(1, 'A', '2026-10-27T00:00:00Z'), ro(2, 'B', '2026-10-28T00:00:00Z')]) + ');')) || ''));
  finish(r2, 'ok', 880);

  /* ── 6 ── */
  for (const t of ['ncaam_es_rosters', 'ncaam_es_lines', 'ncaam_es_portal']) {
    T.chk('6 · ' + t + ' refuses update and delete, even for service_role', /append-only/.test(db.mustFail(() => db.service('update public.' + t + ' set captured_at = captured_at;')) || '') && /append-only/.test(db.mustFail(() => db.service('delete from public.' + t + ';')) || ''));
  }
  T.chk('6 · truncate is refused', /append-only/.test(db.mustFail(() => db.sql('truncate public.ncaam_es_lines;')) || ''));
  T.chk('6 · a finished run cannot change or be deleted', /finished/.test(db.mustFail(() => db.service("update public.ncaam_es_runs set status = 'error' where run_id = '" + r1 + "';")) || '') && /never deleted/.test(db.mustFail(() => db.service("delete from public.ncaam_es_runs where run_id = '" + r1 + "';")) || ''));
  T.chk('6 · a write into a finished run is refused', /not running/.test(db.mustFail(() => db.service("select public.ncaam_es_put('" + r1 + "', 'ncaam_es_games', '[]'::jsonb);")) || ''));
  T.chk('6 · availability: append-only, an id is written once', (() => { const r = begin('availability', 2027); const e = { id: 'av_1', season: 2027, team_id: 1, game_date: '2026-11-04', player_name: 'X', status: 'OUT', source_url: 'https://x.test', published_at: '2026-11-03T00:00:00Z', entered_at: '2026-11-03T01:00:00Z', entered_by: 't', confidence_note: 'n' };
    const a = put(r, 'ncaam_es_availability', [e]).inserted, b = put(r, 'ncaam_es_availability', [Object.assign({}, e, { status: 'AVAILABLE' })]).inserted; finish(r, 'ok'); return a === 1 && b === 0 && db.sql("select status from public.ncaam_es_availability where id = 'av_1'") === 'OUT'; })());

  /* ── 7 ── */
  const m1 = begin('moves', 2027);
  const mv = (pid) => ({ season: 2027, player_id: pid, to_team_id: 1, kind: 'RETURNING', evidence: 'player_season_same_team' });
  put(m1, 'ncaam_es_player_moves', [mv(1), mv(2)]); finish(m1, 'ok');
  const m2 = begin('moves', 2027);
  put(m2, 'ncaam_es_player_moves', [mv(1)]);
  const rep = svc("select public.ncaam_es_replace_derived('" + m2 + "', 2027)");
  finish(m2, 'ok');
  T.chk('7 · a moves run removes its season\'s stale derived rows (player 2 left the roster)', rep.stale_moves_removed === 1 && db.sql('select string_agg(player_id::text, \',\') from public.ncaam_es_player_moves') === '1');
  T.chk('7 · only a moves run of that season may replace', /not a running moves run/.test(db.mustFail(() => { const r = begin('games', 2027); db.service("select public.ncaam_es_replace_derived('" + r + "', 2027);"); }) || ''));
  T.chk('7 · a kind outside the list is refused by the table', !!db.mustFail(() => { const r = begin('moves', 2026); put(r, 'ncaam_es_player_moves', [Object.assign(mv(3), { season: 2026, kind: 'GUESS' })]); }));

  /* ── 8 ── readiness */
  const R = () => J(db.anon('select public.ncaam_es_readiness();'));
  db.sql("update public.ncaam_es_config set value = '01-01' where key = 'in_season_from'; update public.ncaam_es_config set value = '12-31' where key = 'in_season_to';");
  let rd = R();
  T.chk('8 · in season with no box_team sync: warn, and the reason names it', rd.state === 'warn' && rd.reasons.some((x) => /box_team/.test(x)), rd);
  T.chk('8 · readiness holds KPIs, never a row of data (no team or player name, no score)', !/"name"|home_points|"A"|"B"/.test(JSON.stringify(rd)));
  const b1 = begin('box_team', 2027);
  const bx = (tid) => ({ game_id: 1, team_id: tid, season: 2027, box_ok: true });
  put(b1, 'ncaam_es_box_team', [bx(1), bx(2)]); finish(b1, 'ok', 900);
  db.sql("update public.ncaam_es_games set start_utc = now() - interval '1 day', assumed_available_at = now() - interval '20 hours' where game_id = 1");
  const gr = begin('games', 2027); finish(gr, 'ok', 900);
  rd = R();
  T.chk('8 · fresh games and box lines, full coverage: ok', rd.state === 'ok' && rd.completeness.box_coverage === 1 && rd.completeness.finals_available === 1 && rd.completeness.teams_with_live_roster === 1, rd);
  const q = begin('games', 2027); finish(q, 'ok', 120);
  T.chk('8 · the shared quota under the warning level: warn, with the number', R().state === 'warn' && R().reasons.some((x) => /quota: 120/.test(x)));
  const f1 = begin('rosters', 2027); svc("select public.ncaam_es_alert('" + f1 + "', 'FAILURE', 'SYNC_FAILED', 'test')"); finish(f1, 'error');
  const f2 = begin('rosters', 2027); finish(f2, 'error');
  rd = R();
  T.chk('8 · a part failing twice in a row: down, with the reason', rd.state === 'down' && rd.reasons.some((x) => /twice in a row/.test(x)) && rd.parts.find((p) => p.part === 'rosters').consecutive_failures === 2, rd.reasons);
} catch (e) {
  T.chk('the LIVE layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());

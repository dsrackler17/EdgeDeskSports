#!/usr/bin/env node
/* ===========================================================================
   supabase/mlb_offense_history.sql, against a real PostgreSQL.

   The import suite (tools/mlb/offense_import.test.js) proves the DATA is
   right. This proves the CONTRACT is right, which is a different question:

     * the file applies to an empty database and applies AGAIN to the database
       it just made, changing nothing — the property that lets an operator run
       it without first working out whether they already have;
     * every row of its own report reads ok, twice;
     * the record is readable by anon and authenticated and writable by
       neither, on every table it creates;
     * STAGING IS UNREACHABLE from a client. An unpromoted dataset has not
       passed its gate, and a screen that could read it could show numbers the
       gate was about to refuse;
     * neither promote gate is executable by a client, and neither is the
       abandon gate;
     * the two archives share one ledger without interfering: each gate
       supersedes only its own dataset and each status view reads only its own
       rows — the bug this file was written after finding;
     * the indexes the product's reads depend on exist.

   Without a reachable PostgreSQL it skips loudly and passes.

   Run: node tools/mlb/mlb_offense_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('./pg_client.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_mlboff_sql';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const PITCH_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const OFF_SQL = path.join(ROOT, 'supabase', 'mlb_offense_history.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

const conn = PG.findServer();
if (!conn) {
  console.log('SKIP | mlb offense history SQL | no reachable PostgreSQL server');
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}

const RECORD = ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'batter_team_history',
  'observed_batter_team_runs', 'team_offense_seasons', 'team_offense_overview',
  'league_offense_seasons', 'offense_validation', 'offense_source_repairs',
  'offense_games_reconciliation'];
const STAGING = RECORD.map((t) => 'stg_' + t);

(function main() {
  if (!PG.createDatabase(conn, DB)) {
    console.log('SKIP | mlb offense history SQL | could not create the test database');
    process.exit(0);
  }
  const db = PG.pgClient(conn, { database: DB });
  let code = 0;
  try {
    const applied = PG.applyFile(conn, DB, SHIM);
    ok('the supabase shim applies', applied.ok, applied.stderr.split('\n')[0]);

    /* ---- 1. applies, and applies again -------------------------------- */
    for (const round of [1, 2]) {
      for (const f of [PITCH_SQL, OFF_SQL]) {
        const r = PG.applyFile(conn, DB, f);
        ok(`${path.basename(f)} applies (pass ${round})`, r.ok,
          r.ok ? '' : r.stderr.split('\n').slice(0, 4).join(' | '));
        if (!r.ok) throw new Error('apply failed');
      }
    }

    /* The report is a SELECT at the end of the file, so it is re-run here
       directly against the database the file just built. Every row must read
       ok — a row that says CHECK THIS is the file telling an operator it did
       not finish, and a test that ignored it would be theatre. */
    const report = PG.applyFile(conn, DB, OFF_SQL);
    ok('the offensive report ran', report.ok);
    const badRows = (report.stdout || '').split('\n').filter((l) => /CHECK THIS/.test(l));
    eq('every row of the offensive report reads ok', badRows.length, 0, badRows.slice(0, 3).join(' | '));

    const pReport = PG.applyFile(conn, DB, PITCH_SQL);
    const pBad = (pReport.stdout || '').split('\n').filter((l) => /CHECK THIS/.test(l));
    eq('every row of the pitching report still reads ok', pBad.length, 0, pBad.slice(0, 3).join(' | '));

    /* ---- 2. the tables, the keys and the indexes ---------------------- */
    const tables = db.rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname = 'mlbhist' and c.relkind = 'r'`).map((r) => r.relname);
    RECORD.forEach((t) => ok('table mlbhist.' + t + ' exists', tables.indexOf(t) >= 0));
    STAGING.forEach((t) => ok('staging mlbhist.' + t + ' exists', tables.indexOf(t) >= 0));

    const cons = db.rows(`select conname from pg_constraint where conname like 'mlbhist_%'`).map((r) => r.conname);
    ok('(player_id, season) is unique', cons.indexOf('mlbhist_batter_seasons_key') >= 0);
    ok('(player_id, season, team_id) is unique', cons.indexOf('mlbhist_batter_team_seasons_key') >= 0);
    ok('(player_id, team_id) is unique', cons.indexOf('mlbhist_batter_team_history_key') >= 0);
    ok('(season, team_id) is unique', cons.indexOf('mlbhist_team_offense_seasons_key') >= 0);

    ['mlbhist_bat_seasons_player_idx', 'mlbhist_bat_seasons_season_idx', 'mlbhist_bat_seasons_name_idx',
      'mlbhist_bat_seasons_rating_idx', 'mlbhist_bat_seasons_pa_idx', 'mlbhist_bat_seasons_hr_idx',
      'mlbhist_bat_seasons_pos_idx', 'mlbhist_bat_team_seasons_team_idx', 'mlbhist_bat_overview_name_idx',
      'mlbhist_team_off_seasons_rating_idx', 'mlbhist_team_off_seasons_rpg_idx'].forEach((ix) => {
      ok('index ' + ix + ' exists',
        db.rows(`select to_regclass('mlbhist.${ix}') is not null as ok`)[0].ok === true);
    });

    /* ---- 3. RLS, grants, and what a client may do --------------------- */
    RECORD.forEach((t) => {
      const r = db.rows(`select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'mlbhist' and c.relname = '${t}'`)[0];
      ok('RLS is on for ' + t, r && r.relrowsecurity === true);
    });
    const writePolicies = db.rows(`select count(*)::int as n from pg_policies
                                    where schemaname = 'mlbhist' and cmd in ('INSERT','UPDATE','DELETE','ALL')`)[0].n;
    eq('no client write policy exists anywhere in mlbhist', Number(writePolicies), 0);

    function asRole(role, stmt) {
      try { db.sql(`set role ${role}; ${stmt}; reset role;`); return 'ALLOWED'; }
      catch (e) { try { db.sql('reset role;'); } catch (_) { /* best effort */ } return 'DENIED'; }
    }
    ['anon', 'authenticated'].forEach((role) => {
      RECORD.forEach((t) => {
        eq(role + ' may read ' + t, asRole(role, `select count(*) from mlbhist.${t}`), 'ALLOWED');
        eq(role + ' may NOT write ' + t,
          asRole(role, `delete from mlbhist.${t}`), 'DENIED');
      });
      STAGING.forEach((t) => {
        eq(role + ' may NOT read ' + t, asRole(role, `select count(*) from mlbhist.${t}`), 'DENIED');
      });
      eq(role + ' may read the two-way view',
        asRole(role, 'select count(*) from mlbhist.two_way_players'), 'ALLOWED');
      eq(role + ' may read offense_status',
        asRole(role, 'select count(*) from mlbhist.offense_status'), 'ALLOWED');
      eq(role + ' may NOT promote an offensive import',
        asRole(role, "select mlbhist.promote_offense_import('x')"), 'DENIED');
      eq(role + ' may NOT abandon one',
        asRole(role, "select mlbhist.abandon_offense_import('x','y')"), 'DENIED');
      eq(role + ' may NOT promote a pitching import',
        asRole(role, "select mlbhist.promote_import('x')"), 'DENIED');
    });

    /* ---- 4. the two archives share one ledger WITHOUT interfering ----- */
    /* This is the regression test for a real bug: the pitching gate used to
       supersede every promoted row in the shared ledger, which retired the
       offensive dataset and emptied offense_status without touching a single
       offensive row. Both directions are checked. */
    db.sql(`insert into mlbhist.import_runs (import_id, dataset, status, coverage_start, coverage_end,
              rating_version, promoted_at)
            values ('off-1', 'offense', 'promoted', 2016, 2025, 'ED_BAT_PERF_V1', now()),
                   ('pit-1', 'pitching', 'promoted', 2016, 2025, 'ED_PITCH_PERF_V1', now());`);
    eq('the ledger holds one promoted run per dataset',
      Number(db.rows(`select count(*)::int as n from mlbhist.import_runs where status = 'promoted'`)[0].n), 2);
    eq('dataset_status shows the pitching run',
      db.rows('select import_id from mlbhist.dataset_status')[0].import_id, 'pit-1');
    eq('offense_status shows the offensive run',
      db.rows('select import_id from mlbhist.offense_status')[0].import_id, 'off-1');

    /* Now promote a new PITCHING run over empty staging: it must refuse, and
       whatever it does, it must not touch the offensive row. */
    db.sql(`insert into mlbhist.import_runs (import_id, dataset, status) values ('pit-2', 'pitching', 'staging');`);
    const refused = db.rows(`select mlbhist.promote_import('pit-2') as r`)[0].r;
    eq('a pitching promote over empty staging is refused by name',
      (typeof refused === 'string' ? JSON.parse(refused) : refused).code, 'EMPTY_STAGING');
    eq('…and the offensive run is still promoted',
      db.rows(`select status from mlbhist.import_runs where import_id = 'off-1'`)[0].status, 'promoted');
    eq('…and offense_status still answers',
      db.rows('select import_id from mlbhist.offense_status')[0].import_id, 'off-1');

    db.sql(`insert into mlbhist.import_runs (import_id, dataset, status) values ('off-2', 'offense', 'staging');`);
    const refused2 = db.rows(`select mlbhist.promote_offense_import('off-2') as r`)[0].r;
    eq('an offensive promote over empty staging is refused by name',
      (typeof refused2 === 'string' ? JSON.parse(refused2) : refused2).code, 'EMPTY_STAGING');
    eq('…and the pitching run is still promoted',
      db.rows(`select status from mlbhist.import_runs where import_id = 'pit-1'`)[0].status, 'promoted');
    eq('…and dataset_status still answers',
      db.rows('select import_id from mlbhist.dataset_status')[0].import_id, 'pit-1');

    /* The discriminator is constrained: a third dataset cannot be invented by
       a typo in an importer. */
    let badDataset = 'ALLOWED';
    try { db.sql(`insert into mlbhist.import_runs (import_id, dataset) values ('x-1', 'defence');`); }
    catch (e) { badDataset = 'DENIED'; }
    eq('the ledger refuses a dataset it does not know', badDataset, 'DENIED');

    /* ---- 5. the two-way view is a view, so it cannot drift ------------ */
    const twKind = db.rows(`select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname = 'mlbhist' and c.relname = 'two_way_players'`)[0];
    eq('two_way_players is a view, not a table', twKind.relkind, 'v');
    eq('…and mlbhist.teams was not duplicated for the offensive archive',
      db.rows(`select to_regclass('mlbhist.team_offense_teams') is null as ok`)[0].ok, true);

    console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
    if (fail === 0) console.log('PASS | mlb offense history SQL | ' + pass + ' assertions against a real PostgreSQL');
    code = fail === 0 ? 0 : 1;
  } catch (e) {
    console.log('FAIL | mlb offense history SQL | ' + (e && e.stack || e));
    code = 1;
  } finally {
    try { db.close(); } catch (_) { /* best effort */ }
    PG.dropDatabase(conn, DB);
  }
  process.exit(code);
})();

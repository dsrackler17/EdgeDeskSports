#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/server_only_lockdown.sql, run against a real PostgreSQL.

   The file takes EXECUTE on the Collective's functions, public.edge_call and
   five helpers away from anon, authenticated and PUBLIC, and SELECT on three
   financial views away from anon and authenticated. Two ways it could be
   wrong, and both are tested here rather than reasoned about:

     * it misses a path. The attacks are made as the roles that made them,
       on a rebuild of the catalog the August audit read
       (sql/server_only_lockdown_fixture.sql).
     * it takes too much. The Collective edge functions run as service_role,
       which in the fixture reaches every one of these only through PUBLIC.
       Revoke PUBLIC without granting service_role first and the Collective
       stops, so that is the case the fixture is built around.

   Also: the file is run a second time as one raw string, the way the SQL
   editor sends it, and must leave the grants exactly as the first run did.
   A collective function created after the lockdown is PUBLIC-executable again
   (PostgreSQL's default), and the report must say so. On a database with none
   of these objects the file must apply and report ok.

   Same shape and skip behaviour as tools/app/issue_reports_sql.test.js:
   without PostgreSQL it skips loudly and passes. CI runs it in games-sql.yml,
   where a skip is refused.

   Run: node tools/app/server_only_lockdown_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/app/server_only_lockdown_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'server_only_lockdown.sql');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const FIXTURE = path.join(__dirname, 'sql', 'server_only_lockdown_fixture.sql');
const SUITE = path.join(__dirname, 'sql', 'server_only_lockdown.test.sql');
const DB = 'edgedesk_lockdown_sqltest';
const BARE = 'edgedesk_lockdown_bare_sqltest';
const SQL = fs.readFileSync(SCHEMA, 'utf8');

const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  console.log('FAIL | server-only lockdown SQL | ' + name);
  if (detail) console.log(String(detail).trim().split('\n').slice(0, 12).map((l) => '     | ' + l).join('\n'));
  throw new Error('check');
}

/* ═══ STATIC: the conventions supabase/README.md states, for this file ═══ */
check('no psql meta-command (the SQL editor cannot run one)', !/^\s*\\/m.test(SQL));
check('the grants change inside one transaction',
  /^begin;/m.test(SQL) && /^commit;/m.test(SQL) && SQL.indexOf('\nbegin;') < SQL.indexOf('\ncommit;'));
check('the report runs after the commit', SQL.lastIndexOf('order by row;') > SQL.indexOf('\ncommit;'));
check('the report rows say ok or CHECK THIS', /'ok'/.test(SQL) && /'CHECK THIS/.test(SQL));
check('nothing is dropped, deleted or truncated',
  !/\b(drop|delete\s+from|truncate)\b/i.test(SQL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')));
check('PUBLIC is revoked, not only anon and authenticated',
  /revoke execute on routine %s from public/.test(SQL));
check('service_role is granted before PUBLIC is revoked',
  SQL.indexOf("to service_role', r.fn") > 0
  && SQL.indexOf("to service_role', r.fn") < SQL.indexOf("from public', r.fn"));
check('has_active_sub is not on the lockdown list',
  !/'has_active_sub'/.test(SQL.slice(0, SQL.indexOf('\ncommit;'))));

function skip(why) {
  console.log('SKIP | server-only lockdown SQL | ' + why + ' (' + passed + ' static checks passed)');
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
let conn = null;
for (const c of candidates()) {
  if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

function drop(db) { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + db + ' (force)']); }
function create(db) {
  drop(db);
  const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + db]);
  if (mk.status !== 0) { console.error(mk.stderr); skip('could not create the test database'); }
}
function apply(db, file) {
  const r = psql(conn, ['-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  check(path.basename(file) + ' applies to ' + db, r.status === 0, r.stderr);
}
/* The way the SQL editor sends it: the whole file as one raw string, one round
   trip, nothing handled client-side. */
function asEditor(db) {
  const r = psql(conn, ['-d', db, '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', SQL]);
  check('the file runs as one raw string (the SQL editor) on ' + db, r.status === 0, r.stderr);
  return r.stdout || '';
}
function report(out) {
  return out.split('\n').filter((l) => /^\d+\|/.test(l))
    .map((l) => { const [n, name, ...rest] = l.split('|'); return { n: Number(n), name, result: rest.join('|') }; });
}
function allOk(db, rows) {
  check('the report on ' + db + ' has 8 rows', rows.length === 8, JSON.stringify(rows));
  const bad = rows.filter((r) => !/^ok/.test(r.result));
  check('every report row on ' + db + ' says ok', bad.length === 0,
    bad.map((r) => r.n + ' ' + r.name + ' → ' + r.result).join('\n'));
}
const ACLS = "select coalesce(string_agg(n.nspname || '.' || p.oid::regprocedure::text || '=' "
  + "|| coalesce(p.proacl::text, '<default>'), E'\\n' order by p.oid::regprocedure::text), '') "
  + "from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
  + "where n.nspname in ('collective', 'public') and n.nspname <> 'pg_catalog'";
const VIEW_ACLS = "select coalesce(string_agg(relname || '=' || coalesce(relacl::text, '<default>'), E'\\n' "
  + "order by relname), '') from pg_class where relname in "
  + "('ai_cost_per_user', 'guarantee_refunds_due', 'partner_rollup')";
const snap = (db) => psql(conn, ['-d', db, '-tAc', ACLS]).stdout + psql(conn, ['-d', db, '-tAc', VIEW_ACLS]).stdout;

let code = 0;
try {
  /* ═══ THE AUDITED CATALOG ═══════════════════════════════════════════════ */
  create(DB);
  psql(conn, ['-d', DB, '-q', '-c', 'create extension if not exists pgcrypto;']);
  apply(DB, SHIM);
  apply(DB, FIXTURE);

  const before = report(psql(conn, ['-d', DB, '-tA', '-F', '|', '-c',
    SQL.slice(SQL.indexOf('\ncommit;') + '\ncommit;'.length)]).stdout || '');
  check('before the lockdown the report sees the holes (rows 1, 2, 4, 5, 6 say CHECK THIS)',
    [1, 2, 4, 5, 6].every((n) => /^CHECK THIS/.test((before.find((r) => r.n === n) || {}).result || '')),
    JSON.stringify(before));

  apply(DB, SCHEMA);
  allOk(DB, report(psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', SCHEMA]).stdout || ''));

  const once = snap(DB);
  allOk(DB, report(asEditor(DB)));
  check('a second run leaves every grant exactly as the first did', snap(DB) === once,
    'before:\n' + once + '\nafter:\n' + snap(DB));

  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const out = (r.stdout || '') + (r.stderr || '');
  const attacks = (out.match(/NOTICE:\s+ok\s/g) || []).length;
  check('the attack suite passes (' + attacks + ' assertions before it stopped)',
    r.status === 0 && !/FAIL:/.test(out),
    out.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 8).join('\n'));
  check('the attack suite ran all the way through (' + attacks + ' assertions)', attacks >= 50);
  passed += attacks;

  /* ═══ THE LIMIT THE HEADER STATES ══════════════════════════════════════
     A collective function created after the lockdown gets PostgreSQL's
     default EXECUTE to PUBLIC. The report must catch it and a re-run must
     close it. */
  psql(conn, ['-d', DB, '-q', '-c',
    'create function collective.added_later() returns int language sql as $$ select 1 $$']);
  const stale = report(psql(conn, ['-d', DB, '-tA', '-F', '|', '-c',
    SQL.slice(SQL.indexOf('\ncommit;') + '\ncommit;'.length)]).stdout || '');
  const row1 = (stale.find((x) => x.n === 1) || {}).result || '';
  check('a collective function added later makes row 1 say CHECK THIS and name it',
    /^CHECK THIS/.test(row1) && /collective\.added_later\(\)/.test(row1), row1);
  allOk(DB, report(asEditor(DB)));

  /* ═══ A DATABASE WITH NONE OF IT ═══════════════════════════════════════ */
  create(BARE);
  apply(BARE, SHIM);
  allOk(BARE, report(asEditor(BARE)));

  console.log('PASS | server-only lockdown SQL | ' + passed + ' checks against a real PostgreSQL');
} catch (e) {
  if (String(e && e.message) !== 'check') console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  drop(DB);
  drop(BARE);
}
process.exit(code);

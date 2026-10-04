#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK GAMES — the social layer's SQL, run against a real PostgreSQL.
 
   supabase/games_social.sql is where Head-to-Head answer privacy actually
   lives. Reasoning about RLS is not evidence that RLS works, so this applies
   the real file to a real database and then attacks it as a client would:
   as `anon`, as `authenticated`, as the wrong player, with the wrong secret.
 
   tools/games/sql/games_social.test.sql holds the assertions. This file is the
   harness: it creates a throwaway database, applies a small Supabase shim
   (auth.uid(), auth.users, the three roles), applies the SHIPPED sql unmodified,
   runs the suite, and drops the database again.
 
   WITHOUT POSTGRES IT SKIPS, LOUDLY, AND PASSES. The rest of this repository
   runs on a bare Node install and that property is worth keeping; a contributor
   without a database should not see a red suite. CI installs Postgres and gets
   the real thing (see .github/workflows/games-sql.yml).
 
   Run: node tools/games/sql_security.test.js
        EDGD_PG="postgres://user@host:5432" node tools/games/sql_security.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'games_social.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const SUITE = path.join(__dirname, 'sql', 'games_social.test.sql');
const DB = 'edgedesk_games_sqltest';

function have(bin) {
  return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0;
}

/* Connection: an explicit EDGD_PG wins; otherwise try a local socket dir that a
   developer or the CI job may have started a cluster in, then the default. */
function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}

function psql(conn, args, opts) {
  return cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, opts || {}));
}

function skip(why) {
  console.log('SKIP | games social SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}

if (!have('psql')) skip('psql is not installed');

let conn = null;
for (const c of candidates()) {
  const r = psql(c, ['-d', 'postgres', '-tAc', 'select 1']);
  if (r.status === 0 && String(r.stdout).trim() === '1') { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

/* Always from a clean database: the suite settles challenges and moves ratings,
   so replaying it over its own leftovers fails on state, not on logic. That is
   exactly how this harness first went wrong. */
psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
let mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) {
  /* older servers have no (force) */
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
  mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
}
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());

function run(file, label) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) {
    console.log('FAIL | games social SQL | ' + label);
    const err = ((r.stderr || '') + (r.stdout || '')).split('\n')
      .filter(l => /ERROR|FAIL|DETAIL|CONTEXT/.test(l)).slice(0, 12);
    err.forEach(l => console.log('  × ' + l.trim()));
    psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
    process.exit(1);
  }
  return r;
}

run(SHIM, 'the Supabase shim did not apply');
run(SCHEMA, 'supabase/games_social.sql did not apply cleanly');

/* the suite itself: every assertion is a NOTICE, every failure an ERROR */
const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
const all = (r.stdout || '') + (r.stderr || '');
const passed = (all.match(/NOTICE:\s+ok\s/g) || []).length;

if (r.status !== 0) {
  console.log('FAIL | games social SQL | ' + passed + ' passed before the failure');
  all.split('\n').filter(l => /ERROR|FAIL|CONTEXT/.test(l)).slice(0, 10)
    .forEach(l => console.log('  × ' + l.trim()));
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
  process.exit(1);
}

/* A suite that asserts nothing must not be able to report success. */
if (passed < 60) {
  console.log('FAIL | games social SQL | only ' + passed + ' assertions ran; the suite did not complete');
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
  process.exit(1);
}

psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
console.log('PASS | games social SQL | ' + passed + ' passed, 0 failed');

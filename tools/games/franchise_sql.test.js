#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK GAMES — the franchise layer's SQL, run against a real PostgreSQL.

   supabase/games_franchise.sql is where every reward is decided and every
   roster is generated. Reasoning about that is not evidence, so this applies
   the shipped file — over the social layer it depends on — to a real database
   and attacks it as a client would: as anon, as the wrong account, with a
   forged price, with a replayed request, with a card for the wrong week.

   tools/games/sql/games_franchise.test.sql holds the assertions. This file is
   the harness, the same one sql_security.test.js is: a throwaway database,
   the Supabase shim, the SHIPPED sql unmodified, the suite, and the database
   dropped again.

   WITHOUT POSTGRES IT SKIPS, LOUDLY, AND PASSES — the repository runs on a
   bare Node install. CI installs Postgres and gets the real thing
   (.github/workflows/games-sql.yml).

   Run: node tools/games/franchise_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/games/franchise_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SOCIAL = path.join(ROOT, 'supabase', 'games_social.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'games_franchise.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const SUITE = path.join(__dirname, 'sql', 'games_franchise.test.sql');
const DB = 'edgedesk_games_franchise_sqltest';
const MIN_ASSERTIONS = 120;

function have(bin) {
  return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0;
}

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
  console.log('SKIP | games franchise SQL | ' + why);
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

psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
let mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) {
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
  mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
}
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]); }

function run(file, label) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) {
    console.log('FAIL | games franchise SQL | ' + label);
    ((r.stderr || '') + (r.stdout || '')).split('\n')
      .filter(l => /ERROR|FAIL|DETAIL|CONTEXT/.test(l)).slice(0, 12)
      .forEach(l => console.log('  × ' + l.trim()));
    drop();
    process.exit(1);
  }
  return r;
}

run(SHIM, 'the Supabase shim did not apply');
run(SOCIAL, 'supabase/games_social.sql did not apply cleanly');
run(SCHEMA, 'supabase/games_franchise.sql did not apply cleanly');
/* the file must be re-runnable: the whole supabase/ convention rests on it */
run(SCHEMA, 'supabase/games_franchise.sql did not apply cleanly a SECOND time');

const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
const all = (r.stdout || '') + (r.stderr || '');
const passed = (all.match(/NOTICE:\s+ok\s/g) || []).length;

if (r.status !== 0) {
  console.log('FAIL | games franchise SQL | ' + passed + ' passed before the failure');
  all.split('\n').filter(l => /ERROR|FAIL|CONTEXT/.test(l)).slice(0, 10)
    .forEach(l => console.log('  × ' + l.trim()));
  drop();
  process.exit(1);
}

if (passed < MIN_ASSERTIONS) {
  console.log('FAIL | games franchise SQL | only ' + passed + ' assertions ran; the suite did not complete');
  drop();
  process.exit(1);
}

drop();
console.log('PASS | games franchise SQL | ' + passed + ' passed, 0 failed');

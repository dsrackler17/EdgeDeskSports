#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/ufc_live_center.sql, run against a real PostgreSQL.

   Applies the SHIPPED file unmodified to a throwaway database, checks its own
   report says ok on every row, applies it again (idempotent), and then runs
   tools/ufc/sql/ufc_live_center.test.sql: reads as anon and authenticated,
   every write a client could attempt, the lock's race semantics, the dedup
   constraints and the cascade.

   Same shape and skip behaviour as tools/app/issue_reports_sql.test.js —
   without PostgreSQL it skips loudly and passes; CI runs it with a database.

   Run: node tools/ufc/ufc_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/ufc/ufc_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'ufc_live_center.sql');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SUITE = path.join(__dirname, 'sql', 'ufc_live_center.test.sql');
const DB = 'edgedesk_ufc_sqltest';

const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | UFC live center SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
drop();
const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) { console.error(mk.stderr); skip('could not create the test database'); }

let code = 0;
try {
  psql(conn, ['-d', DB, '-q', '-c', 'create extension if not exists pgcrypto']);
  for (const f of [SHIM, SCHEMA]) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (r.status !== 0) {
      console.log('FAIL | UFC live center SQL | ' + path.basename(f) + ' did not apply');
      console.error((r.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
      throw new Error('apply');
    }
  }
  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', SCHEMA]);
  const bad = (rep.stdout || '').split('\n').filter((l) => /^\d+\|/.test(l) && !/\|ok/.test(l));
  if (bad.length) {
    console.log('FAIL | UFC live center SQL | the migration report is not all ok');
    bad.forEach((l) => console.log('     | ' + l));
    throw new Error('report');
  }
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  if (twice.status !== 0) {
    console.log('FAIL | UFC live center SQL | the file is not idempotent — a second run failed');
    console.error((twice.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
    throw new Error('idempotent');
  }
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const out = (r.stdout || '') + (r.stderr || '');
  const passed = (out.match(/NOTICE:\s+ok\s/g) || []).length;
  if (r.status !== 0 || /FAIL:/.test(out)) {
    console.log('FAIL | UFC live center SQL | ' + passed + ' passed before the failure');
    console.error(out.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 8).join('\n'));
    throw new Error('suite');
  }
  if (passed < 30) {
    console.log('FAIL | UFC live center SQL | only ' + passed + ' assertions ran — the suite exited early');
    throw new Error('short');
  }
  console.log('PASS | UFC live center SQL | ' + passed + ' assertions against a real PostgreSQL');
} catch (e) {
  if (!/^(apply|report|idempotent|suite|short)$/.test(String(e && e.message))) console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  drop();
}
process.exit(code);

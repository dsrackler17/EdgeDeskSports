#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/issue_reports.sql, run against a real PostgreSQL.

   "Report a problem" accepts writes from `anon`, because the report worth
   most in this product is "I could not sign up" and it is filed without a
   session. Reasoning about whether that is safe is not evidence, so this
   applies the SHIPPED file unmodified to a throwaway database and attacks it:
   as anon, as one reporter reaching for another's rows, as somebody trying to
   promote themselves to operator, and with a JWT pasted into the body.

   Same shape and same skip behaviour as tools/games/sql_security.test.js —
   without PostgreSQL it skips loudly and passes, so a bare Node checkout is
   still green. CI runs it with a database.

   Run: node tools/app/issue_reports_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/app/issue_reports_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'issue_reports.sql');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SUITE = path.join(__dirname, 'sql', 'issue_reports.test.sql');
const DB = 'edgedesk_issue_reports_sqltest';

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
  console.log('SKIP | issue reports SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');

let conn = null;
for (const c of candidates()) {
  if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
drop();
const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) { console.error(mk.stderr); skip('could not create the test database'); }

let code = 0;
try {
  /* The founding operator the shipped file allowlists exists in the real
     project, so the test database gets that row too — otherwise report line 11
     would say CHECK THIS here and pass in production, which is the wrong way
     round for a check that is meant to catch an empty allowlist. */
  psql(conn, ['-d', DB, '-q', '-c',
    "create schema if not exists auth; create extension if not exists pgcrypto;"]);
  for (const f of [SHIM, SCHEMA]) {
    if (f === SCHEMA) {
      psql(conn, ['-d', DB, '-q', '-c',
        "insert into auth.users(id,email) values ('e7e46801-80c4-4f47-b718-4aff211c8d3a','owner@example.com') on conflict do nothing"]);
    }
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (r.status !== 0) {
      console.log('FAIL | issue reports SQL | ' + path.basename(f) + ' did not apply');
      console.error((r.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
      throw new Error('apply');
    }
  }
  /* The shipped file ends in a report of its own. Every row must say ok —
     a migration you cannot verify from its own output is one you have to
     trust, and that is exactly what this repository refuses to do. */
  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', SCHEMA]);
  const bad = (rep.stdout || '').split('\n')
    .filter((l) => /^\d+\|/.test(l) && !/\|ok/.test(l));
  if (bad.length) {
    console.log('FAIL | issue reports SQL | the migration report is not all ok');
    bad.forEach((l) => console.log('     | ' + l));
    throw new Error('report');
  }
  /* Applying it twice must be indistinguishable from applying it once. */
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  if (twice.status !== 0) {
    console.log('FAIL | issue reports SQL | the file is not idempotent — a second run failed');
    console.error((twice.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
    throw new Error('idempotent');
  }

  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const out = (r.stdout || '') + (r.stderr || '');
  const passed = (out.match(/NOTICE:\s+ok\s/g) || []).length;
  if (r.status !== 0 || /FAIL:/.test(out)) {
    console.log('FAIL | issue reports SQL | ' + passed + ' passed before the failure');
    console.error(out.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 8).join('\n'));
    throw new Error('suite');
  }
  if (passed < 18) {
    console.log('FAIL | issue reports SQL | only ' + passed + ' assertions ran — the suite exited early');
    throw new Error('short');
  }
  console.log('PASS | issue reports SQL | ' + passed + ' assertions against a real PostgreSQL');
} catch (e) {
  /* A harness that swallows its own errors is a harness that reports green for
     the wrong reason. Say what broke. */
  if (!/^(apply|report|idempotent|suite|short)$/.test(String(e && e.message)))
    console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  drop();
}
process.exit(code);

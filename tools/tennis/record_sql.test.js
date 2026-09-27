#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/tennis_record.sql, run against a real PostgreSQL.

   Applies the SHIPPED file unmodified to a throwaway database that already has
   the Supabase shim, billing.sql (public.subscriptions, so the entitlement rule
   has something real to read) and the live tennis contract. Checks its own
   report says ok on every row, applies it AGAIN (idempotent), re-runs the live
   contract's report to prove nothing there broke, and then runs
   tools/tennis/sql/tennis_record.test.sql — which attacks it as anon, as a
   signed-in free account and as an entitled subscriber.

   Same shape and skip behaviour as tools/tennis/tennis_sql.test.js — without
   PostgreSQL it skips loudly and passes; CI runs it with a database.

   Run: node tools/tennis/record_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/tennis/record_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const BILLING = path.join(ROOT, 'supabase', 'billing.sql');
const LIVE = path.join(ROOT, 'supabase', 'tennis_live_center.sql');
const RECORD = path.join(ROOT, 'supabase', 'tennis_record.sql');
const SUITE = path.join(__dirname, 'sql', 'tennis_record.test.sql');
const DB = 'edgedesk_tennis_record_sqltest';

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
  console.log('SKIP | tennis record SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) skip('could not create the test database');

let code = 0;
function reportBad(out) {
  return (out || '').split('\n').filter((l) => /^\d+(\.\d+)?\|/.test(l) && !/\|ok/.test(l));
}
try {
  psql(conn, ['-d', DB, '-q', '-c', 'create extension if not exists pgcrypto']);

  for (const f of [SHIM, BILLING, LIVE, RECORD]) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (r.status !== 0) {
      console.log('FAIL | tennis record SQL | ' + path.basename(f) + ' did not apply');
      console.error((r.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
      throw new Error('apply');
    }
  }

  /* the contract's own report */
  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', RECORD]);
  const bad = reportBad(rep.stdout);
  if (bad.length) {
    console.log('FAIL | tennis record SQL | the migration report is not all ok');
    bad.forEach((l) => console.log('     | ' + l));
    throw new Error('report');
  }
  const rows = (rep.stdout || '').split('\n').filter((l) => /^\d+\|/.test(l)).length;
  if (rows < 20) {
    console.log('FAIL | tennis record SQL | the report printed only ' + rows + ' rows');
    throw new Error('report');
  }

  /* idempotent */
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', RECORD]);
  if (twice.status !== 0) {
    console.log('FAIL | tennis record SQL | the file is not idempotent — a second run failed');
    console.error((twice.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
    throw new Error('idempotent');
  }

  /* THE LIVE CONTRACT MUST STILL BE OK. This file adds columns to a table the
     live contract owns, so its report is re-run rather than reasoned about. */
  const live = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', LIVE]);
  const liveBad = reportBad(live.stdout);
  if (liveBad.length) {
    console.log('FAIL | tennis record SQL | the LIVE contract stopped reporting ok after the record contract ran');
    liveBad.forEach((l) => console.log('     | ' + l));
    throw new Error('live');
  }

  /* and the record contract applied in the OTHER ORDER, on a bare database */
  const DB2 = DB + '_order';
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB2 + ' (force)']);
  psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB2]);
  try {
    psql(conn, ['-d', DB2, '-q', '-c', 'create extension if not exists pgcrypto']);
    for (const f of [SHIM, RECORD, LIVE]) {
      const r = psql(conn, ['-d', DB2, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
      if (r.status !== 0) {
        console.log('FAIL | tennis record SQL | apply order record-then-live failed at ' + path.basename(f));
        console.error((r.stderr || '').trim().split('\n').slice(0, 10).join('\n'));
        throw new Error('order');
      }
    }
    const o = psql(conn, ['-d', DB2, '-tA', '-F', '|', '-f', RECORD]);
    if (reportBad(o.stdout).length) {
      console.log('FAIL | tennis record SQL | the report is not ok when the record contract is applied FIRST');
      reportBad(o.stdout).forEach((l) => console.log('     | ' + l));
      throw new Error('order');
    }
  } finally {
    psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB2 + ' (force)']);
  }

  /* the attack suite */
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const out = (r.stdout || '') + (r.stderr || '');
  const passed = (out.match(/NOTICE:\s+ok\s/g) || []).length;
  if (r.status !== 0 || /FAIL:/.test(out)) {
    console.log('FAIL | tennis record SQL | ' + passed + ' passed before the failure');
    console.error(out.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 10).join('\n'));
    throw new Error('suite');
  }
  if (passed < 55) {
    console.log('FAIL | tennis record SQL | only ' + passed + ' assertions ran — the suite exited early');
    throw new Error('short');
  }
  console.log('PASS | tennis record SQL | ' + passed + ' assertions against a real PostgreSQL');
} catch (e) {
  if (!/^(apply|report|idempotent|live|order|suite|short)$/.test(String(e && e.message)))
    console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  drop();
}
process.exit(code);

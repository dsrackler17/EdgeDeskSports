#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/tennis_lab.sql, run against a real PostgreSQL.

   Applies the SHIPPED file unmodified to a throwaway database that already has
   the Supabase shim, billing.sql (so the entitlement rule has something real to
   read), the live tennis contract and the record contract. Then:

     - checks the migration's own report says ok on every row
     - applies it AGAIN, to prove it is idempotent
     - re-runs the RECORD contract's report, to prove this file did not break
       the contract it extends (it adds columns to a table that file owns)
     - applies it in the other order on a bare database
     - runs tools/tennis/sql/tennis_lab.test.sql, which attacks it as anon and
       as a signed-in free account

   Reasoning about RLS is not evidence. Every claim the Lab makes about what a
   browser can and cannot do is checked here by trying it.

   Same skip behaviour as the other SQL suites: without PostgreSQL it skips
   loudly and passes, so `npm test` stays green on a bare Node install. CI runs
   it with a real database.

   Run: node tools/tennis/lab_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/tennis/lab_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const BILLING = path.join(ROOT, 'supabase', 'billing.sql');
const LIVE = path.join(ROOT, 'supabase', 'tennis_live_center.sql');
const RECORD = path.join(ROOT, 'supabase', 'tennis_record.sql');
const LAB = path.join(ROOT, 'supabase', 'tennis_lab.sql');
const SUITE = path.join(__dirname, 'sql', 'tennis_lab.test.sql');
const DB = 'edgedesk_tennis_lab_sqltest';

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
  console.log('SKIP | tennis lab SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');

function drop(db) { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + db + ' (force)']); }
function reportBad(out) {
  return (out || '').split('\n').filter((l) => /^\d+(\.\d+)?\|/.test(l) && !/\|ok/.test(l));
}

drop(DB);
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) {
  skip('could not create the test database');
}

let code = 0;
try {
  psql(conn, ['-d', DB, '-q', '-c', 'create extension if not exists pgcrypto']);

  for (const f of [SHIM, BILLING, LIVE, RECORD, LAB]) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (r.status !== 0) {
      console.log('FAIL | tennis lab SQL | ' + path.basename(f) + ' did not apply');
      console.error((r.stderr || '').trim().split('\n').slice(0, 14).join('\n'));
      throw new Error('apply');
    }
  }

  /* the contract's own report */
  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', LAB]);
  const bad = reportBad(rep.stdout);
  if (bad.length) {
    console.log('FAIL | tennis lab SQL | the migration report is not all ok');
    bad.forEach((l) => console.log('     | ' + l));
    throw new Error('report');
  }
  const rows = (rep.stdout || '').split('\n').filter((l) => /^\d+\|/.test(l)).length;
  if (rows < 18) {
    console.log('FAIL | tennis lab SQL | the report printed only ' + rows + ' rows');
    throw new Error('report');
  }

  /* idempotent — applied a third time now */
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', LAB]);
  if (twice.status !== 0) {
    console.log('FAIL | tennis lab SQL | the file is not idempotent — a later run failed');
    console.error((twice.stderr || '').trim().split('\n').slice(0, 14).join('\n'));
    throw new Error('idempotent');
  }

  /* THE RECORD CONTRACT MUST STILL BE OK. This file adds columns to
     tennis.player_ratings_current, which the record contract owns, so its
     report is re-run rather than reasoned about. */
  const rec = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', RECORD]);
  const recBad = reportBad(rec.stdout);
  if (recBad.length) {
    console.log('FAIL | tennis lab SQL | the RECORD contract stopped reporting ok after the lab contract ran');
    recBad.forEach((l) => console.log('     | ' + l));
    throw new Error('record');
  }

  /* and the LIVE contract, which shares tennis.tournaments */
  const live = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', LIVE]);
  const liveBad = reportBad(live.stdout);
  if (liveBad.length) {
    console.log('FAIL | tennis lab SQL | the LIVE contract stopped reporting ok after the lab contract ran');
    liveBad.forEach((l) => console.log('     | ' + l));
    throw new Error('live');
  }

  /* applied in a different order on a bare database */
  const DB2 = DB + '_order';
  drop(DB2);
  psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB2]);
  try {
    psql(conn, ['-d', DB2, '-q', '-c', 'create extension if not exists pgcrypto']);
    for (const f of [SHIM, RECORD, LAB, LIVE]) {
      const r = psql(conn, ['-d', DB2, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
      if (r.status !== 0) {
        console.log('FAIL | tennis lab SQL | apply order record-lab-live failed at ' + path.basename(f));
        console.error((r.stderr || '').trim().split('\n').slice(0, 10).join('\n'));
        throw new Error('order');
      }
    }
    const o = psql(conn, ['-d', DB2, '-tA', '-F', '|', '-f', LAB]);
    if (reportBad(o.stdout).length) {
      console.log('FAIL | tennis lab SQL | the report is not ok under a different apply order');
      reportBad(o.stdout).forEach((l) => console.log('     | ' + l));
      throw new Error('order');
    }
    /* THE ONE THING THIS FILE MUST REFUSE: applying without the record
       contract underneath it. A half-applied Lab over a missing record would
       fail later, in production, with a confusing missing-relation error. */
    const DB3 = DB + '_bare';
    drop(DB3);
    psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB3]);
    psql(conn, ['-d', DB3, '-q', '-c', 'create extension if not exists pgcrypto']);
    psql(conn, ['-d', DB3, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SHIM]);
    const bare = psql(conn, ['-d', DB3, '-v', 'ON_ERROR_STOP=1', '-q', '-f', LAB]);
    if (bare.status === 0) {
      console.log('FAIL | tennis lab SQL | the lab contract applied WITHOUT the record contract underneath it');
      throw new Error('guard');
    }
    if (!/requires supabase\/tennis_record\.sql/.test(bare.stderr || '')) {
      console.log('FAIL | tennis lab SQL | it refused, but not with the message that says what to do');
      console.error((bare.stderr || '').trim().split('\n').slice(0, 6).join('\n'));
      throw new Error('guard');
    }
    drop(DB3);
  } finally { drop(DB2); }

  /* the attack suite */
  const suite = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const out = ((suite.stdout || '') + '\n' + (suite.stderr || ''));
  /* psql prefixes every NOTICE with "psql:<file>:<line>: ", so an anchored
     /^NOTICE:/ matched nothing and the suite "passed" with a count of zero —
     which the thinness guard below then reported as a failure. Match the
     NOTICE wherever it appears on the line. */
  const oks = (out.match(/NOTICE:\s+ok /g) || []).length;
  const fails = out.split('\n').filter((l) => /FAIL:/.test(l));
  if (suite.status !== 0 || fails.length) {
    console.log('FAIL | tennis lab SQL | the attack suite did not pass');
    fails.slice(0, 20).forEach((l) => console.log('     | ' + l.trim()));
    if (!fails.length) {
      /* Show the ERROR, not the first fourteen lines — which are all NOTICEs
         from the assertions that PASSED, and told the reader nothing about why
         the suite stopped. */
      const errs = out.split('\n').filter((l) => /ERROR|DETAIL|HINT/.test(l));
      (errs.length ? errs : out.split('\n').slice(-14)).slice(0, 14)
        .forEach((l) => console.log('     | ' + l.trim()));
    }
    throw new Error('suite');
  }
  /* A suite that silently stopped asserting would "pass" with two oks. It has
     to have actually run its assertions. */
  if (oks < 70) {
    console.log('FAIL | tennis lab SQL | the attack suite made only ' + oks + ' assertions; expected at least 70');
    throw new Error('thin');
  }
  console.log('ok | tennis lab SQL | report all ok, idempotent, record and live contracts intact, '
            + oks + ' assertions against a real PostgreSQL');
} catch (e) {
  code = 1;
} finally {
  drop(DB);
}
process.exit(code);

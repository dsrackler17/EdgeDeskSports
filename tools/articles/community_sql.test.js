#!/usr/bin/env node
/* ============================================================================
   supabase/community_posts.sql, APPLIED AND ATTACKED on a real PostgreSQL.

   The rule the whole member-post feature rests on — any account may write,
   only an entitled subscriber may publish without an editor — is a statement
   about a VALUE in a column, which no RLS policy can express. It lives in a
   trigger, and a trigger nobody attacked is a trigger nobody has checked.

   This applies the shipped file UNMODIFIED over a reconstruction of the parts
   of Supabase it depends on, runs it twice to prove idempotency, checks its
   own report, and then attacks it as anon, as a free account, as a
   subscriber, as one member reaching for another's queued post, and as
   somebody publishing six times in a day.

   If no PostgreSQL is reachable the suite SAYS SO and exits clean. A skipped
   check that announces itself is honest; one that stays silent is a lie the
   next person inherits.

   Run: node tools/articles/community_sql.test.js
        EDGD_PG='-h /var/tmp/edpg/sock -U postgres' node tools/articles/community_sql.test.js
   ========================================================================== */
'use strict';
const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const BILLING = path.join(ROOT, 'supabase', 'billing.sql');
const ARTICLES = path.join(ROOT, 'supabase', 'site_articles.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'community_posts.sql');
const SUITE = path.join(__dirname, 'sql', 'community.test.sql');
const DB = 'edgedesk_community_sqltest';

const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edpg/sock', '-U', 'postgres']);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | member posts SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; the offline half is tools/articles/community.test.js)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');

let conn = null;
for (const c of candidates()) {
  if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; console.log('  × ' + name + (detail ? ' — ' + String(detail).trim().slice(0, 400) : ''));
  return false;
}

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) {
  skip('could not create the test database');
}

try {
  psql(conn, ['-d', DB, '-q', '-c', 'create schema if not exists auth; create extension if not exists pgcrypto;']);

  /* THE DEPENDENCIES ARE APPLIED IN THE ORDER THE README SAYS TO APPLY THEM,
     and deliberately WITHOUT issue_reports.sql: site_articles.sql carries an
     optional carry-over from that table, and the first version of it resolved
     the table name at parse time, so the whole article system could not be
     installed on a project that had never run the unrelated migration. Not
     installing it here is how that stays fixed. */
  for (const f of [SHIM, BILLING, ARTICLES, SCHEMA]) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (!ok(path.basename(f) + ' applies to a bare project', r.status === 0, r.stderr)) throw new Error('apply');
  }

  /* Its own report. Row 12 of site_articles.sql is allowed to say CHECK THIS
     on a fresh project — it is the "add yourself to the allowlist" prompt. */
  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', SCHEMA]);
  const bad = (rep.stdout || '').split('\n').filter(l => /^\d+\|/.test(l) && !/\|ok$/.test(l));
  ok('every row of its own report says ok', bad.length === 0, bad.join(' ; '));

  /* Twice is indistinguishable from once. */
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('applying it again changes nothing and fails nothing', twice.status === 0, twice.stderr);

  /* The attack suite. Every check inside raises on failure, so a clean exit
     is the whole suite passing. */
  const run = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const notices = (run.stderr || '').split('\n').filter(l => /NOTICE:\s+ok\s/.test(l));
  const failed = (run.stderr || '').split('\n').filter(l => /FAIL:/.test(l));
  notices.forEach(() => { pass++; });
  if (run.status !== 0 || failed.length) {
    fail += Math.max(1, failed.length);
    console.log((failed.join('\n') || (run.stderr || '').trim().split('\n').slice(-8).join('\n')));
  }
  ok('the suite reached its end', /ALL COMMUNITY SQL CHECKS PASSED/.test(run.stderr || ''),
    (run.stderr || '').trim().split('\n').slice(-4).join(' | '));
} catch (e) {
  if (String(e && e.message) !== 'apply') { fail++; console.log('  × harness: ' + (e && e.message)); }
} finally {
  drop();
}

console.log((fail ? 'FAIL' : 'PASS') + ' | member posts SQL | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

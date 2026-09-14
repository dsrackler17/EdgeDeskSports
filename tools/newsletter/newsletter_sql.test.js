#!/usr/bin/env node
/* ============================================================================
   supabase/newsletter.sql, APPLIED AND ATTACKED on a real PostgreSQL.

   The rules this schema enforces are statements about WHO MAY SEE WHAT and
   about VALUES rather than about rows, so most of them are grants, unique
   indexes and check constraints rather than application code — and a
   constraint nobody attacked is a constraint nobody has checked.

   So this applies the shipped file UNMODIFIED, runs it twice to prove
   idempotency, applies it to a BARE project to prove it names its one
   prerequisite rather than half-installing, checks its own report, and then
   attacks it as anon, as a signed-in reader and as the operator.

   If no PostgreSQL is reachable the suite SAYS SO and exits clean. A skipped
   check that announces itself is honest; one that stays silent is a lie the
   next person inherits.

   Run: node tools/newsletter/newsletter_sql.test.js
        EDGD_PG='-h /var/tmp/edpg/sock -U postgres' node tools/newsletter/newsletter_sql.test.js
   ========================================================================== */
'use strict';
const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const BILLING = path.join(ROOT, 'supabase', 'billing.sql');
const ARTICLES = path.join(ROOT, 'supabase', 'site_articles.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'newsletter.sql');
const SUITE = path.join(__dirname, 'sql', 'newsletter.test.sql');
const DB = 'edgedesk_newsletter_sqltest';
const BARE = 'edgedesk_newsletter_baretest';

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
  console.log('SKIP | newsletter SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; the offline half is tools/newsletter/newsletter.test.js)');
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
  fail++; console.log('  × ' + name + (detail ? ' — ' + String(detail).trim().slice(0, 500) : ''));
  return false;
}
function drop(db) { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + db + ' (force)']); }
function fresh(db) {
  drop(db);
  if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + db]).status !== 0) return false;
  psql(conn, ['-d', db, '-q', '-c', 'create schema if not exists auth; create extension if not exists pgcrypto;']);
  return true;
}

try {
  /* ---------------------------------------------------------------------- */
  /* 1 — ITS ONE PREREQUISITE IS NAMED, NOT DISCOVERED HALFWAY THROUGH.      */
  /* ---------------------------------------------------------------------- */
  if (!fresh(BARE)) skip('could not create the bare test database');
  psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SHIM]);
  const noDep = psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('with site_articles absent it refuses rather than half-installing', noDep.status !== 0);
  ok('and the error names the file to run first',
    /site_articles\.sql first/.test(noDep.stderr || ''),
    (noDep.stderr || '').split('\n').filter(l => /ERROR/.test(l))[0]);
  const halfway = psql(conn, ['-d', BARE, '-tAc',
    "select count(*) from information_schema.tables where table_schema='public' and table_name like 'newsletter_%'"]);
  ok('and nothing was left half-created', (halfway.stdout || '').trim() === '0', halfway.stdout);

  /* OVER site_articles.sql ALONE — no billing — because "it only installs if
     some other unrelated migration happened to run first" is the bug this
     check exists to catch. The membership test must degrade to `false`
     rather than fail when public.subscriptions does not exist. */
  psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', ARTICLES]);
  const overArticles = psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('it applies over site_articles.sql alone', overArticles.status === 0, overArticles.stderr);
  const noBilling = psql(conn, ['-d', BARE, '-tAc',
    "select public.newsletter_is_member('nobody@example.com', null)"]);
  ok('with no billing table everybody is a free reader rather than an error',
    noBilling.status === 0 && (noBilling.stdout || '').trim() === 'f',
    noBilling.stderr || noBilling.stdout);
  drop(BARE);

  /* ---------------------------------------------------------------------- */
  /* 2 — IT APPLIES BESIDE THE REST, TWICE, AND ITS OWN REPORT IS CLEAN.     */
  /* ---------------------------------------------------------------------- */
  if (!fresh(DB)) skip('could not create the test database');
  for (const f of [SHIM, BILLING, ARTICLES, SCHEMA]) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (!ok(path.basename(f) + ' applies', r.status === 0, r.stderr)) throw new Error('apply');
  }
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('applying it again changes nothing and fails nothing', twice.status === 0, twice.stderr);

  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', SCHEMA]);
  const badRows = (rep.stdout || '').split('\n').filter(l => /^\d+\|/.test(l) && !/\|ok$/.test(l));
  ok('every row of its own report says ok', badRows.length === 0, badRows.join(' ; '));

  /* A MEMBER IS READ FROM THE BILLING TABLE THE PAYWALL ALREADY READS. */
  psql(conn, ['-d', DB, '-q', '-c',
    "insert into auth.users (id, email, email_confirmed_at) values "
    + "('11111111-1111-1111-1111-111111111111','member@example.com', now()) on conflict do nothing;"
    + "insert into public.subscriptions (user_id, status, price_id, current_period_end) values "
    + "('11111111-1111-1111-1111-111111111111','active','price_x', now() + interval '30 days') "
    + "on conflict (user_id) do update set status='active';"]);
  const isMember = psql(conn, ['-d', DB, '-tAc', "select public.newsletter_is_member('member@example.com', null)"]);
  ok('a paying account reads as a member', (isMember.stdout || '').trim() === 't', isMember.stderr);
  const notMember = psql(conn, ['-d', DB, '-tAc', "select public.newsletter_is_member('stranger@example.com', null)"]);
  ok('a stranger does not', (notMember.stdout || '').trim() === 'f', notMember.stderr);
  psql(conn, ['-d', DB, '-q', '-c',
    "update public.subscriptions set current_period_end = now() - interval '1 day' "
    + "where user_id = '11111111-1111-1111-1111-111111111111'"]);
  const lapsed = psql(conn, ['-d', DB, '-tAc', "select public.newsletter_is_member('member@example.com', null)"]);
  ok('a lapsed subscription reads as a free reader', (lapsed.stdout || '').trim() === 'f',
    lapsed.stderr || lapsed.stdout);

  /* ---------------------------------------------------------------------- */
  /* 3 — THE ATTACK SUITE.                                                   */
  /* ---------------------------------------------------------------------- */
  const run = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const notices = (run.stderr || '').split('\n').filter(l => /NOTICE:\s+ok\s/.test(l));
  const failed = (run.stderr || '').split('\n').filter(l => /FAIL:/.test(l));
  notices.forEach(() => { pass++; });
  if (run.status !== 0 || failed.length) {
    fail += Math.max(1, failed.length);
    console.log(failed.join('\n') || (run.stderr || '').trim().split('\n').slice(-10).join('\n'));
  }
  ok('the suite reached its end', /ALL NEWSLETTER SQL CHECKS PASSED/.test(run.stderr || ''),
    (run.stderr || '').trim().split('\n').slice(-4).join(' | '));
  ok('it made at least forty checks', notices.length >= 40, notices.length + ' checks');
} catch (e) {
  if (String(e && e.message) !== 'apply') { fail++; console.log('  × harness: ' + ((e && e.stack) || e)); }
} finally {
  drop(DB); drop(BARE);
}

console.log((fail ? 'FAIL' : 'PASS') + ' | newsletter SQL | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

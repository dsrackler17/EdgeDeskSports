#!/usr/bin/env node
/* ============================================================================
   supabase/editorial_system.sql, APPLIED AND ATTACKED on a real PostgreSQL.

   Two rules in that schema are statements about VALUES rather than about rows,
   so neither can be an RLS policy and both are triggers:

     1  A PREGAME SNAPSHOT IS IMMUTABLE — to the operator, and to the service
        role the pipeline itself runs as. Every postgame audit on the site
        rests on the pregame state not having moved, and a rule that the thing
        doing the writing could bypass is not a rule.
     2  ONLY A PERSON CLOSES A MODEL-REVIEW CANDIDATE, with a disposition and a
        note long enough to act on. A pipeline that could close its own
        investigations is a pipeline that retunes itself on one Sunday.

   A trigger nobody attacked is a trigger nobody has checked, so this applies
   the shipped file UNMODIFIED, runs it twice to prove idempotency, applies it
   to a BARE project to prove it does not depend on an unrelated migration
   having been run first, checks its own report, and then attacks it as anon,
   as a signed-in reader and as the operator.

   If no PostgreSQL is reachable the suite SAYS SO and exits clean. A skipped
   check that announces itself is honest; one that stays silent is a lie the
   next person inherits.

   Run: node tools/editorial/editorial_sql.test.js
        EDGD_PG='-h /var/tmp/edpg/sock -U postgres' node tools/editorial/editorial_sql.test.js
   ========================================================================== */
'use strict';
const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const BILLING = path.join(ROOT, 'supabase', 'billing.sql');
const ARTICLES = path.join(ROOT, 'supabase', 'site_articles.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'editorial_system.sql');
const SUITE = path.join(__dirname, 'sql', 'editorial.test.sql');
const DB = 'edgedesk_editorial_sqltest';
const BARE = 'edgedesk_editorial_baretest';

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
  console.log('SKIP | editorial SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; the offline half is tools/editorial/editorial.test.js)');
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
  /* This schema genuinely depends on site_articles: the public-read boundary
     of every table in it is "what a published article already shows", which
     is an RLS policy referencing that table, and a policy body is parsed when
     the policy is created. What must NOT happen is the failure arriving four
     hundred lines in as `relation "public.site_articles" does not exist`,
     which is true and useless. The message must name the fix.

     supabase/README.md records the same class of trap against site_articles
     itself, caught in the other direction: that file must not depend on an
     unrelated migration, and this one must depend on exactly one and say so. */
  if (!fresh(BARE)) skip('could not create the bare test database');
  psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SHIM]);
  const noDep = psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('with site_articles absent it refuses rather than half-installing', noDep.status !== 0);
  ok('and the error names the file to run first',
    /site_articles\.sql first/.test(noDep.stderr || ''),
    (noDep.stderr || '').split('\n').filter(l => /ERROR/.test(l))[0]);
  const halfway = psql(conn, ['-d', BARE, '-tAc',
    "select count(*) from information_schema.tables where table_schema='public' and table_name like 'editorial_%'"]);
  ok('and nothing was left half-created', (halfway.stdout || '').trim() === '0', halfway.stdout);

  /* Over site_articles.sql ALONE — no billing, no issue_reports — because
     "it only installs if some other unrelated migration happened to run
     first" is the bug this check exists to catch. */
  psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', ARTICLES]);
  const overArticles = psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('it applies over site_articles.sql alone', overArticles.status === 0, overArticles.stderr);
  const bareHasFn = psql(conn, ['-d', BARE, '-tAc',
    "select to_regprocedure('public.site_article_is_admin()') is not null"]);
  ok('and shares that file’s operator allowlist rather than building a second one',
    (bareHasFn.stdout || '').trim() === 't', bareHasFn.stdout);
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

  /* ---------------------------------------------------------------------- */
  /* 3 — THE ATTACK SUITE.                                                   */
  /* ---------------------------------------------------------------------- */
  const run = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const notices = (run.stderr || '').split('\n').filter(l => /NOTICE:\s+ok\s/.test(l));
  const failed = (run.stderr || '').split('\n').filter(l => /FAIL:/.test(l));
  notices.forEach(() => { pass++; });
  if (run.status !== 0 || failed.length) {
    fail += Math.max(1, failed.length);
    console.log(failed.join('\n') || (run.stderr || '').trim().split('\n').slice(-8).join('\n'));
  }
  ok('the suite reached its end', /ALL EDITORIAL SQL CHECKS PASSED/.test(run.stderr || ''),
    (run.stderr || '').trim().split('\n').slice(-4).join(' | '));
  ok('it made at least thirty checks', notices.length >= 30, notices.length + ' checks');
} catch (e) {
  if (String(e && e.message) !== 'apply') { fail++; console.log('  × harness: ' + (e && e.stack || e)); }
} finally {
  drop(DB); drop(BARE);
}

console.log((fail ? 'FAIL' : 'PASS') + ' | editorial SQL | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

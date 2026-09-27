#!/usr/bin/env node
/* ============================================================================
   THE SQL DISPATCHER POKE, tested on a real database.

   supabase/editorial_dispatch_sql.sql is the edge-function-free primary
   scheduler: the pause check, the debounce and the GitHub poke all live in
   plpgsql so the whole thing can be installed from the SQL editor. Its
   decisions are therefore database behaviour, and only a database can prove
   them.

   pg_net is not installed here and does not need to be — net.http_post is
   stubbed, exactly as the edge function's suite stubs fetch, so the assertions
   are about WHAT THE FUNCTION ASKED GITHUB FOR rather than about a live call.
   The stub records every request, which is what makes "it did not dispatch"
   a checkable claim rather than an absence.

   WHAT MATTERS HERE, and it is the same list as the edge function's:

     · a missing token must NOT report success — a permanently unscheduled
       system that looks healthy is the failure this scheduler exists to remove
     · the operator's pause must be honoured here, not only in the pipeline
     · it must not stampede: a run already in flight needs no second one
     · it must never run the pipeline itself, only poke the canonical one
     · it must not be reachable from a browser: it reads a GitHub token and
       can start a workflow

   Run: node tools/editorial/dispatch_sql.test.js
        EDGD_PG='-h 127.0.0.1 -p 5432 -U postgres' node tools/editorial/dispatch_sql.test.js
   ========================================================================== */
'use strict';
const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const RUNTIME = path.join(ROOT, 'supabase', 'editorial_runtime.sql');
const ARTICLES = path.join(ROOT, 'supabase', 'site_articles.sql');
const DISPATCH = path.join(ROOT, 'supabase', 'editorial_dispatch_sql.sql');
const DB = 'edgedesk_dispatch_sql_test';

const have = b => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) =>
  cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push(['-h', '/var/tmp/edpg/sock', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | editorial dispatch SQL | ' + why);
  console.log('       (needs PostgreSQL; the poke is plpgsql, so there is no offline half)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');

let conn = null;
for (const c of candidates()) {
  if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + String(detail).slice(0, 240) : ''));
  return false;
}
function eq(name, got, want) {
  return ok(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function section(t) { console.log('\n' + t); }

const q = (sql, db) => psql(conn, ['-d', db || DB, '-tAc', sql]);
const val = (sql, db) => {
  const r = q(sql, db);
  return r.status === 0 ? r.stdout.trim().split('\n').pop().trim() : ('ERR:' + (r.stderr || '').trim());
};

/* ------------------------------------------------------------------------ */
section('0. INSTALL');
/* ------------------------------------------------------------------------ */
psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) {
  skip('could not create the test database');
}
psql(conn, ['-d', DB, '-q', '-c',
  'create schema if not exists auth; create extension if not exists pgcrypto;']);
/* The same Supabase stand-ins (auth.uid(), the roles) the sibling SQL suites
   use, so site_articles.sql applies off a hosted project. */
psql(conn, ['-d', DB, '-q', '-f', SHIM]);

/* THE STUBS. pg_cron and pg_net are extensions this machine does not have, so
   the objects the file needs are created by hand with the SAME SIGNATURES the
   real ones expose. net.http_post records instead of sending; that recording
   is the whole point. */
const stubs = `
create schema if not exists net;
create schema if not exists cron;

create table net.sent (
  id bigserial primary key,
  url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer,
  at timestamptz default now()
);
create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language plpgsql as $s$
declare v bigint;
begin
  insert into net.sent (url, body, params, headers, timeout_milliseconds)
  values (url, body, params, headers, timeout_milliseconds) returning id into v;
  return v;
end $s$;

create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql as $s$
declare v bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  returning jobid into v; return v;
end $s$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $s$
begin delete from cron.job where jobname = job_name; return true; end $s$;
`;
const stubRes = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-c', stubs]);
ok('the pg_net and pg_cron stubs install', stubRes.status === 0, stubRes.stderr);

/* The real dependencies. */
const art = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', ARTICLES]);
ok('site_articles.sql applies', art.status === 0, art.stderr);
const rt = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', RUNTIME]);
ok('editorial_runtime.sql applies', rt.status === 0, rt.stderr);

/* THE FILE UNDER TEST. `create extension` for pg_cron/pg_net cannot succeed
   here, so those two lines are dropped — everything else runs verbatim, which
   is the part whose behaviour is being asserted. */
const fs = require('fs');
let sql = fs.readFileSync(DISPATCH, 'utf8')
  .replace(/^create extension if not exists pg_cron;$/m, '-- (stubbed)')
  .replace(/^create extension if not exists pg_net;$/m, '-- (stubbed)');
const TMP = path.join(require('os').tmpdir(), 'edgd_dispatch_under_test.sql');
fs.writeFileSync(TMP, sql);

const first = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', TMP]);
ok('editorial_dispatch_sql.sql applies', first.status === 0, first.stderr);

/* IDEMPOTENT. An operator who runs the file twice must not end up with two
   schedules poking GitHub twice as often. */
const again = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', TMP]);
ok('and applies a second time', again.status === 0, again.stderr);
eq('leaving exactly one schedule',
  val("select count(*)::text from cron.job where jobname = 'editorial_dispatch_sql'"), '1');
eq('at the ten-minute cadence',
  val("select schedule from cron.job where jobname = 'editorial_dispatch_sql'"), '*/10 * * * *');

/* The guard has to fire when the runtime schema is absent, or an operator gets
   a broken function instead of a sentence telling them what to run first. */
const BARE = DB + '_bare';
psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + BARE + ' (force)']);
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + BARE]).status === 0) {
  psql(conn, ['-d', BARE, '-q', '-c', stubs]);
  psql(conn, ['-d', BARE, '-q', '-f', SHIM]);
  const noDep = psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', TMP]);
  ok('without editorial_runtime.sql it refuses', noDep.status !== 0);
  ok('and names the file to run first',
    /editorial_runtime\.sql/.test(noDep.stderr || ''), noDep.stderr);
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + BARE + ' (force)']);
}

/* THE TOKEN IS SET ON THE DATABASE, not the session: every psql call here is a
   fresh connection, so a set_config would be gone by the time the function ran
   — and `alter database ... set edgedesk.gh_token` is the exact fallback the
   file documents for a project without Vault, so this exercises the real path. */
const token = v => psql(conn, ['-d', 'postgres', '-q', '-c',
  v === null ? 'alter database ' + DB + ' reset edgedesk.gh_token'
             : "alter database " + DB + " set edgedesk.gh_token = '" + v + "'"]);
const reset = () => {
  token('ghp_testtoken');
  q("delete from net.sent; delete from public.editorial_heartbeats; "
    + "update public.editorial_settings set dispatcher_enabled = true where id = 1;");
};
const sent = () => Number(val('select count(*)::text from net.sent'));

/* ------------------------------------------------------------------------ */
section('1. IT POKES THE ONE CANONICAL DISPATCHER');
/* ------------------------------------------------------------------------ */
reset();
let out = val("select public.editorial_poke('supabase_cron')");
let j = {};
try { j = JSON.parse(out); } catch (e) { /* reported below */ }
eq('a clear run dispatches', j.action, 'dispatched');
ok('and says so', j.ok === true, out);
eq('exactly one request was made', sent(), 1);

eq('to the configured repository and workflow',
  val('select url from net.sent order by id desc limit 1'),
  'https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/editorial.yml/dispatches');
eq('on the right ref', val("select body->>'ref' from net.sent order by id desc limit 1"), 'main');
eq('identifying itself as the primary scheduler',
  val("select body->'inputs'->>'source' from net.sent order by id desc limit 1"), 'supabase_cron');
eq('with the token as a bearer credential',
  val("select headers->>'authorization' from net.sent order by id desc limit 1"),
  'Bearer ghp_testtoken');
eq('and a user-agent, which the GitHub API requires',
  val("select headers->>'user-agent' from net.sent order by id desc limit 1"),
  'edgedesk-editorial-cron');
ok('it returns the pg_net request id so the reply can be traced',
  Number(j.request_id) > 0, out);

/* THE SOURCE IS NOT HARDCODED. Health tells the primary scheduler apart from
   GitHub's triggers by this value, so a manual poke must say `manual`. */
reset();
q("select public.editorial_poke('manual')");
eq('a manual poke records itself as manual',
  val("select body->'inputs'->>'source' from net.sent order by id desc limit 1"), 'manual');

/* IT NEVER RUNS THE PIPELINE ITSELF. The whole design rests on there being
   exactly one editorial pipeline. */
eq('nothing was written to the editorial tables',
  val('select (select count(*) from public.editorial_heartbeats)::text'), '0');

/* ------------------------------------------------------------------------ */
section('2. A MISSING TOKEN IS NOT A SUCCESS');
/* ------------------------------------------------------------------------ */
reset();
token(null);
out = val("select public.editorial_poke('supabase_cron')");
try { j = JSON.parse(out); } catch (e) { j = {}; }
ok('no token fails', j.ok === false, out);
eq('and names the reason', j.action, 'no_token');
ok('explaining what is missing',
  /edgedesk_gh_token/.test(j.reason || ''), j.reason);
eq('and it did not pretend to dispatch', sent(), 0);

/* ------------------------------------------------------------------------ */
section('3. THE OPERATOR PAUSE IS HONOURED HERE TOO');
/* ------------------------------------------------------------------------ */
reset();
q('update public.editorial_settings set dispatcher_enabled = false where id = 1');
out = val("select public.editorial_poke('supabase_cron')");
try { j = JSON.parse(out); } catch (e) { j = {}; }
eq('a disabled dispatcher is not poked', j.action, 'paused');
ok('which is not an error', j.ok === true, out);
eq('and nothing was dispatched', sent(), 0);

/* A MISSING SETTINGS ROW IS NOT A PAUSE. A fresh install with no row yet must
   still schedule, or the system is silently dead on arrival. */
reset();
q('delete from public.editorial_settings where id = 1');
out = val("select public.editorial_poke('supabase_cron')");
try { j = JSON.parse(out); } catch (e) { j = {}; }
eq('no settings row still dispatches', j.action, 'dispatched');
q("insert into public.editorial_settings (id) values (1) on conflict do nothing");

/* ------------------------------------------------------------------------ */
section('4. IT DOES NOT STAMPEDE');
/* ------------------------------------------------------------------------ */
reset();
q("insert into public.editorial_heartbeats (scheduler_source, started_at) "
  + "values ('github_schedule', now() - interval '30 seconds')");
out = val("select public.editorial_poke('supabase_cron')");
try { j = JSON.parse(out); } catch (e) { j = {}; }
eq('a run already in flight is not duplicated', j.action, 'debounced');
ok('which is not an error', j.ok === true, out);
ok('and it says what it saw',
  /github_schedule/.test(j.reason || '') && /debounce/.test(j.reason || ''), j.reason);
eq('nothing was dispatched', sent(), 0);

/* THE DEBOUNCE IS A WINDOW, not a permanent stop. */
reset();
q("insert into public.editorial_heartbeats (scheduler_source, started_at) "
  + "values ('github_schedule', now() - interval '20 minutes')");
out = val("select public.editorial_poke('supabase_cron')");
try { j = JSON.parse(out); } catch (e) { j = {}; }
eq('an old heartbeat does not block a new run', j.action, 'dispatched');
eq('and it dispatched', sent(), 1);

/* THE WINDOW IS THE CALLER'S. A shorter debounce must let a closer run through,
   which is what makes the parameter real rather than decorative. */
reset();
q("insert into public.editorial_heartbeats (scheduler_source, started_at) "
  + "values ('github_schedule', now() - interval '120 seconds')");
out = val("select public.editorial_poke('supabase_cron', 300)");
try { j = JSON.parse(out); } catch (e) { j = {}; }
eq('120s ago is inside a 300s debounce', j.action, 'debounced');
out = val("select public.editorial_poke('supabase_cron', 60)");
try { j = JSON.parse(out); } catch (e) { j = {}; }
eq('and outside a 60s one', j.action, 'dispatched');

/* ------------------------------------------------------------------------ */
section('5. A BROWSER MAY NOT HOLD THE TOKEN OR START A WORKFLOW');
/* ------------------------------------------------------------------------ */
/* The function is security definer, reads a GitHub PAT and can start a CI run.
   If PostgREST could reach it, anyone with the anon key could spend Actions
   minutes at will. */
reset();
for (const role of ['anon', 'authenticated']) {
  const r = q("set role " + role + "; select public.editorial_poke('supabase_cron')");
  ok(role + ' cannot call editorial_poke', r.status !== 0, (r.stdout || '').trim());
  ok('and is refused on privilege, not on a missing token',
    /permission denied/i.test(r.stderr || ''), r.stderr);
}
eq('and no such call dispatched anything', sent(), 0);

/* ------------------------------------------------------------------------ */
section('6. THE SCHEDULE CALLS THE FUNCTION, NOT A PIPELINE');
/* ------------------------------------------------------------------------ */
const cmd = val("select command from cron.job where jobname = 'editorial_dispatch_sql'");
ok('the scheduled command pokes', /editorial_poke/.test(cmd), cmd);
ok('as the primary scheduler', /supabase_cron/.test(cmd), cmd);
ok('and does nothing else at all',
  !/(insert|update|delete|articles|snapshot)/i.test(cmd), cmd);

/* ------------------------------------------------------------------------ */
psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
try { fs.unlinkSync(TMP); } catch (e) { /* nothing to clean */ }

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | editorial dispatch SQL | '
  + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ', 0 failed'));
if (fail) { failures.forEach(f => console.log('  ×  ' + f)); process.exit(1); }

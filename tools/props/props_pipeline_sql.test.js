#!/usr/bin/env node
/* ===========================================================================
   supabase/player_props_pipeline.sql, AGAINST A REAL POSTGRESQL, AS REAL
   READERS.

   The pipeline's run log and health are readable by signed-in readers and
   written by the service role only; a reader's refresh request is admitted
   atomically, once, under a per-reader and a global cool-down, and a reader
   sees only their own; the execution window the database uses is the
   kernel's (EDProps FRESHNESS.executable_max_minutes); and the executable-
   quote view returns only pregame prices inside that window while
   player_prop_best_quotes keeps every price (history is never lost).

   Run: node tools/props/props_pipeline_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const EDP = require(path.join(PG.ROOT, 'lib', 'edgedesk_props.js'));

const T = PG.kit('player props pipeline SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'player_props_pipeline.sql');
const CRON = path.join(PG.ROOT, 'supabase', 'player_props_cron.sql');
const CAPTURE_V11 = path.join(PG.ROOT, 'supabase', 'capture_v11_player_props.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL) && /create unique index if not exists/.test(SQL));
chk('additive — nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL) && !/\bdelete from\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('under the SQL editor paste limit (18 KB)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
chk('the database execution window is the kernel\'s (EDProps FRESHNESS)', new RegExp('player_props_executable_max_minutes\\(\\)\\s*returns integer language sql immutable as \\$\\$ select ' + EDP.FRESHNESS.executable_max_minutes + ' \\$\\$').test(SQL));
const CRON_SQL = fs.readFileSync(CRON, 'utf8');
chk('the scheduler file: no meta-commands, replaces its own job, every five minutes', !/^\\/m.test(CRON_SQL) && /cron\.unschedule\('player_props_dispatch'\)/.test(CRON_SQL) && /\*\/5 \* \* \* \*/.test(CRON_SQL));
/* Supabase refuses `alter database postgres set edgedesk.*` (42501), so a job
   that reads those settings can never be configured: the URL is the project's
   own, and props_cron runs with JWT verification off, so no key is sent */
chk('the scheduler file reads no database setting and calls props_cron at the project URL', !/current_setting\(/.test(CRON_SQL) && /url\s*:= 'https:\/\/iattxbkbufslbauoumga\.supabase\.co\/functions\/v1\/props_cron'/.test(CRON_SQL));
chk('the scheduler file commits no key', !/eyJ[A-Za-z0-9_-]{10,}/.test(CRON_SQL) && !/service_role_key\s*=\s*'[^<]/.test(CRON_SQL));

const db = PG.start('ppipe');
if (db.skip) {
  if (process.env.PLAYER_PROPS_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
try {
  let out = db.applyFileAtomic(FILE);
  chk('the file applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-700));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out), out.slice(-500));
  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com'), ('${B}','b@example.com');`);

  /* ── the run log and the health row ─────────────────────────────────── */
  db.service(`insert into public.player_props_pipeline_runs (run_key, league, trigger, started_at, completed_at, status, reason, health, health_reason, events_requested, events_succeeded, events_failed, quotes_received, provider_http, duration_ms)
    values ('123.1', 'nfl', 'supabase_cron', now() - interval '2 minutes', now(), 'PARTIAL', 'SOME_REQUESTS_FAILED', 'DEGRADED', 'SOME_EVENTS_FAILED', 5, 4, 1, 2400, '200', 61000);`);
  chk('the service role records a run', db.sql('select count(*) from public.player_props_pipeline_runs;') === '1');
  chk('one row per run and league (a replayed sync is refused, never doubled)', db.mustFail(() => db.service(`insert into public.player_props_pipeline_runs (run_key, league, started_at) values ('123.1', 'nfl', now());`)) !== null);
  chk('an unknown league is refused', db.mustFail(() => db.service(`insert into public.player_props_pipeline_runs (run_key, league, started_at) values ('9', 'nba', now());`)) !== null);
  chk('an unknown health word is refused', db.mustFail(() => db.service(`insert into public.player_props_pipeline_runs (run_key, league, started_at, health) values ('10', 'nfl', now(), 'FINE');`)) !== null);
  db.service(`insert into public.player_props_pipeline_health (league, health, health_reason, last_attempt_at, next_due_at) values ('nfl', 'DEGRADED', 'SOME_EVENTS_FAILED', now(), now() + interval '5 minutes')
    on conflict (league) do update set health = excluded.health, updated_at = now();`);
  chk('a signed-in reader reads the health and the run log', db.as(A, 'select health from public.player_props_pipeline_health;') === 'DEGRADED' && db.as(A, 'select count(*) from public.player_props_pipeline_runs;') === '1');
  chk('a reader cannot write health', db.mustFail(() => db.as(A, "update public.player_props_pipeline_health set health = 'HEALTHY';")) !== null
    && db.sql("select health from public.player_props_pipeline_health where league = 'nfl';") === 'DEGRADED');
  chk('a reader cannot write a run', db.mustFail(() => db.as(A, "insert into public.player_props_pipeline_runs (run_key, league, started_at) values ('x', 'nfl', now());")) !== null);
  chk('anon reads nothing', db.mustFail(() => db.anon('select count(*) from public.player_props_pipeline_health;')) !== null || db.anon('select count(*) from public.player_props_pipeline_health;') === '0');

  /* ── refresh admission ───────────────────────────────────────────────── */
  const admit = (u, lg, uc, gc) => db.service(`select admitted || '|' || coalesce(request_id::text, '') || '|' || status || '|' || coalesce(reason, '') || '|' || coalesce(retry_after_s::text, '') from public.player_props_refresh_admit('${u}', '${lg}', null, ${uc || 300}, ${gc || 120});`).split('|');
  const r1 = admit(A, 'nfl');
  chk('a first refresh is admitted and queued', r1[0] === 'true' && r1[2] === 'queued' && r1[1].length === 36, r1);
  const r2 = admit(A, 'nfl');
  chk('a second click while it is in flight returns the same request (idempotent, nothing bought twice)', r2[0] === 'true' && r2[1] === r1[1] && /in progress/.test(r2[3]), r2);
  const r3 = admit(B, 'nfl');
  chk('another reader during the same refresh joins it too', r3[0] === 'true' && r3[1] === r1[1], r3);
  db.service(`update public.player_props_refresh_requests set status = 'completed', completed_at = now() where id = '${r1[1]}';`);
  const r4 = admit(A, 'nfl');
  chk('once it finishes, the same reader is told to wait, and for how long', r4[0] === 'false' && r4[2] === 'rejected' && /recently/.test(r4[3]) && Number(r4[4]) > 0 && Number(r4[4]) <= 300, r4);
  const r5 = admit(B, 'nfl');
  chk('another reader is held by the global cool-down, with the wait', r5[0] === 'false' && /moments ago/.test(r5[3]) && Number(r5[4]) > 0 && Number(r5[4]) <= 120, r5);
  chk('a rejection is never stored as a request (it cannot extend its own cool-down)', db.sql("select count(*) from public.player_props_refresh_requests where status = 'rejected';") === '0');
  db.service(`update public.player_props_refresh_requests set requested_at = now() - interval '10 minutes' where id = '${r1[1]}';`);
  const r6 = admit(B, 'cfb');
  chk('after the cool-downs a new refresh is admitted', r6[0] === 'true' && r6[2] === 'queued' && r6[1] !== r1[1], r6);
  chk('an unknown league is rejected', admit(A, 'nba')[2] === 'rejected');
  chk('reader A sees only their own requests', db.as(A, 'select count(*) from public.player_props_refresh_requests;') === '1' && db.as(B, 'select count(*) from public.player_props_refresh_requests;') === '1');
  chk('a reader cannot admit a refresh directly (only the function behind props_cron can)', db.mustFail(() => db.as(A, `select * from public.player_props_refresh_admit('${A}', 'nfl');`)) !== null);
  chk('a reader cannot write a request', db.mustFail(() => db.as(A, "insert into public.player_props_refresh_requests (league) values ('nfl');")) !== null);
  chk('an unknown status is refused', db.mustFail(() => db.service(`update public.player_props_refresh_requests set status = 'done' where id = '${r6[1]}';`)) !== null);

  /* ── the executable-quote view over capture v11 ──────────────────────── */
  chk('without capture v11 the view is not created (the report says so, ok)', db.sql("select count(*) from information_schema.views where table_name = 'player_prop_executable_quotes';") === '0');
  db.sql('create table if not exists public.signals (sig_key text primary key, event_id text, sport_key text, market text, commence_time timestamptz);');
  out = db.applyFileAtomic(CAPTURE_V11);
  chk('capture v11 applies', !/CHECK THIS/.test(out), out.slice(-400));
  out = db.applyFileAtomic(FILE);
  chk('re-applied beside capture v11: the view exists and every row ok', !/CHECK THIS/.test(out) && db.sql("select count(*) from information_schema.views where table_name = 'player_prop_executable_quotes';") === '1', out.slice(-500));
  const ins = (key, book, dec, agoMin, kickH) => db.service(`insert into public.player_prop_quotes (quote_key, event_id, sport_key, commence_time, player_name, player_key, market, source_market, side, point, book_key, decimal_odds, captured_at)
    values ('${key}', 'ev1', 'americanfootball_nfl', now() + interval '${kickH} hours', 'Bijan Robinson', 'bijan robinson', 'player_rush_yds', 'player_rush_yds', 'Over', 84.5, '${book}', ${dec}, now() - interval '${agoMin} minutes');`);
  ins('k1', 'draftkings', 1.95, 5, 20);       /* current */
  ins('k2', 'fanduel', 2.40, 180, 20);        /* the best number, but 3 hours old */
  ins('k3', 'betmgm', 1.91, 20, 20);          /* current, worse price */
  chk('the executable best price is the best CURRENT one — never the old best number', db.as(A, "select book_key || '|' || decimal_odds from public.player_prop_executable_quotes where event_id = 'ev1';") === 'draftkings|1.95');
  chk('player_prop_best_quotes keeps the historical best (history and CLV, not execution)', db.as(A, "select book_key from public.player_prop_best_quotes where event_id = 'ev1';") === 'fanduel');
  db.service("insert into public.player_prop_quotes (quote_key, event_id, sport_key, commence_time, player_name, player_key, market, source_market, side, point, book_key, decimal_odds, captured_at) values ('k4', 'ev2', 'americanfootball_nfl', now() - interval '1 hour', 'X', 'x', 'player_rush_yds', 'player_rush_yds', 'Over', 50.5, 'draftkings', 1.9, now() - interval '2 minutes');");
  chk('a started game has no executable price, however fresh', db.as(A, "select count(*) from public.player_prop_executable_quotes where event_id = 'ev2';") === '0');
  chk('an old quote is never deleted (history retained)', db.sql("select count(*) from public.player_prop_quotes;") === '4');

  /* ── the scheduler file, against stand-ins for pg_cron and pg_net ────── */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid serial, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    create schema if not exists net;
    create table if not exists net.posted (url text, body jsonb, headers jsonb, timeout_ms integer);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
      language sql as $$ insert into net.posted values (url, body, headers, timeout_milliseconds); select 1::bigint $$;
    insert into cron.job (jobname, schedule, command) values ('player_props_dispatch', '*/5 * * * *', 'select current_setting(''edgedesk.project_url'', true)');`);
  const cronDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ppcron-')), cronFile = path.join(cronDir, 'cron.sql');
  fs.writeFileSync(cronFile, CRON_SQL.replace(/^create extension if not exists pg_(cron|net);$/mg, ''));
  out = db.applyFileAtomic(cronFile);
  chk('the scheduler file applies over the old settings-reading job; every report row ok', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 2, out.slice(-400));
  out = db.applyFileAtomic(cronFile);
  chk('…and a second time: still exactly one job', !/CHECK THIS/.test(out) && db.sql("select count(*) from cron.job where jobname = 'player_props_dispatch';") === '1');
  db.sql("do $$ begin execute (select command from cron.job where jobname = 'player_props_dispatch'); end $$;");
  chk('a tick posts to props_cron with no authorization header, and waits up to 30 s', db.sql("select url || '|' || (headers ? 'authorization')::text || '|' || timeout_ms || '|' || (body->>'source') from net.posted;") === 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/props_cron|false|30000|supabase_cron');
  fs.rmSync(cronDir, { recursive: true, force: true });
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 800));
} finally { db.stop(); }
process.exit(T.done());

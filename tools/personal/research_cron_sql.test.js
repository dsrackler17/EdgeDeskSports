#!/usr/bin/env node
/* ===========================================================================
   supabase/research_state_cron.sql, AGAINST A REAL POSTGRESQL.

   The scheduler's record is the research_cron function's debounce, so a
   reader who could write it could silence the research-state job: it is the
   service role's alone. The pg_cron job calls research_cron at the project's
   own URL with no key and no database setting (Supabase refuses
   `alter database … set edgedesk.*`), re-running the file replaces the job
   rather than adding a second, and the file refuses to run before
   personal_research.sql, whose table the tick reads.

   pg_cron and pg_net are stood in for by a cron.job table and a net.posted
   log (the pattern of tools/props/props_pipeline_sql.test.js).

   Run: node tools/personal/research_cron_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PG = require('./_pg.js');

const T = PG.kit('research-state scheduler SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'research_state_cron.sql');
const PERSONAL = path.join(PG.ROOT, 'supabase', 'personal_research.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const URL = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/research_cron';

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent: create if not exists, and it replaces its own job', /create table if not exists/.test(SQL) && /create index if not exists/.test(SQL)
  && /cron\.unschedule\('research_state_dispatch'\)/.test(SQL));
chk('additive: nothing is dropped or deleted', !/\bdrop (table|column|index)\b/i.test(SQL) && !/\bdelete from\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload (the function reads the new table through it)', /notify pgrst, 'reload schema'/.test(SQL));
chk('under the SQL editor paste limit (18 KB)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
chk('every five minutes', /'research_state_dispatch',\s*'\*\/5 \* \* \* \*'/.test(SQL));
chk('it reads no database setting and calls research_cron at the project URL', !/current_setting\(/.test(SQL) && SQL.indexOf("url                  := '" + URL + "'") >= 0);
chk('it commits no key', !/eyJ[A-Za-z0-9_-]{10,}/.test(SQL) && !/(service_role_key|gh_token)\s*=\s*'[^<]/.test(SQL) && !/github_pat_|ghp_[A-Za-z0-9]{10,}/.test(SQL));

const db = PG.start('rscron');
if (db.skip) {
  if (process.env.RESEARCH_CRON_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rscron-')), cronFile = path.join(dir, 'cron.sql');
fs.writeFileSync(cronFile, SQL.replace(/^create extension if not exists pg_(cron|net);$/mg, ''));
try {
  /* the stand-ins, and an older job of the same name to be replaced */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid serial, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    create schema if not exists net;
    create table if not exists net.posted (url text, body jsonb, headers jsonb, timeout_ms integer);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
      language sql as $$ insert into net.posted values (url, body, headers, timeout_milliseconds); select 1::bigint $$;
    insert into cron.job (jobname, schedule, command) values ('research_state_dispatch', '38 * * * *', 'select 1');`);

  let err = db.mustFail(() => db.applyFileAtomic(cronFile));
  chk('before personal_research.sql it refuses, and names the file to apply first', err && /personal_research\.sql/.test(err), err);
  chk('…having changed nothing (one transaction)', db.sql("select count(*) from cron.job where jobname = 'research_state_dispatch' and schedule = '38 * * * *';") === '1'
    && db.sql("select to_regclass('public.research_state_scheduler') is null;") === 't');

  db.applyFileAtomic(PERSONAL);
  let out = db.applyFileAtomic(cronFile);
  chk('the file applies over the old job; all four report rows ok', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 4, out.slice(-500));
  out = db.applyFileAtomic(cronFile);
  chk('…and a second time: still all ok, still exactly one job', !/CHECK THIS/.test(out)
    && db.sql("select count(*) from cron.job where jobname = 'research_state_dispatch';") === '1', out.slice(-300));
  chk('the job is every five minutes', db.sql("select schedule from cron.job where jobname = 'research_state_dispatch';") === '*/5 * * * *');

  /* ── a tick, as pg_cron would run it ─────────────────────────────────── */
  db.sql("do $$ begin execute (select command from cron.job where jobname = 'research_state_dispatch'); end $$;");
  chk('a tick posts to research_cron with no authorization header, the scheduler source, and waits up to 30 s',
    db.sql("select url || '|' || (headers ? 'authorization')::text || '|' || timeout_ms || '|' || (body->>'source') from net.posted;") === URL + '|false|30000|supabase_cron');

  /* ── the scheduler's record ──────────────────────────────────────────── */
  const upsert = (extra) => `insert into public.research_state_scheduler (id, scheduler_tick_at, scheduler_action, scheduler_reason, state_computed_at, next_kickoff_at, cadence_minutes${extra ? ', last_dispatch_at, last_dispatch_reason' : ''})
    values (1, now(), 'dispatched', 'research-state.yml dispatched on main', now() - interval '61 minutes', now() + interval '3 hours', 25${extra ? ", now(), 'research-state.yml dispatched on main'" : ''})
    on conflict (id) do update set scheduler_tick_at = excluded.scheduler_tick_at, scheduler_action = excluded.scheduler_action${extra ? ', last_dispatch_at = excluded.last_dispatch_at' : ''};`;
  db.service(upsert(true));
  chk('the service role writes it the way research_cron does (an upsert on id)', db.service('select cadence_minutes from public.research_state_scheduler where id = 1;') === '25');
  db.service(upsert(false));
  chk('…and a tick that did not dispatch leaves the last dispatch time alone', db.service('select last_dispatch_at is not null from public.research_state_scheduler;') === 't');
  err = db.mustFail(() => db.service("insert into public.research_state_scheduler (id) values (2);"));
  chk('it is one row: a second is refused', err && /check/i.test(err), err);

  db.sql(`insert into auth.users (id, email) values ('${A}', 'a@example.com') on conflict do nothing;`);
  chk('a signed-in reader cannot read it', db.mustFail(() => db.as(A, 'select count(*) from public.research_state_scheduler;')) !== null);
  chk('…nor forge a dispatch time that would silence the job',
    db.mustFail(() => db.as(A, "update public.research_state_scheduler set last_dispatch_at = now() + interval '10 years';")) !== null
    && db.service("select last_dispatch_at < now() + interval '1 day' from public.research_state_scheduler;") === 't');
  chk('anon can neither read nor write it', db.mustFail(() => db.anon('select 1 from public.research_state_scheduler;')) !== null
    && db.mustFail(() => db.anon("insert into public.research_state_scheduler (id) values (1) on conflict do nothing;")) !== null);

  /* ── the tick's one question ─────────────────────────────────────────── */
  chk('game_research_state is indexed on computed_at', db.sql("select indexdef from pg_indexes where indexname = 'game_research_state_computed_idx';").indexOf('(computed_at DESC)') >= 0);
  chk('the service role can ask it (the newest computed_at, the next kickoff)',
    db.mustFail(() => db.service('select max(computed_at), min(kickoff_at) filter (where kickoff_at > now()) from public.game_research_state;')) === null);
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 800));
} finally { db.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
process.exit(T.done());

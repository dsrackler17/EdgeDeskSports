-- ============================================================================
-- 022_ufc_meta.sql — build metadata + a build ledger for the ufc schema.
--
-- WHY THIS EXISTS
-- The UFC research screen renders "no build time published" and "Freshness SLA
-- inactive". That is not a UI bug: there is genuinely nowhere for a UFC build
-- time to come from. `wta.meta` and `tennis.meta` both exist and both publish
-- key/value build stamps that the app reads; the `ufc` schema has no equivalent
-- table, so `RESEARCH_MODULES.ufc.freshness()` had nothing to return but null
-- and the app — correctly — refused to invent an age from the clock.
--
-- This migration adds the SAME table, in the SAME shape, with the SAME key
-- convention as the two schemas that already work. It does not invent a second
-- freshness system.
--
--   ufc.meta       key/value build stamps  (identical shape to tennis.meta)
--   ufc.build_log  one row per pipeline run — the observability ledger
--   ufc.stamp_build(...)  one call a sync job makes to write both
--
-- IMPORTANT: this migration deliberately seeds NO build time. Until a real
-- pipeline run calls ufc.stamp_build(), the app keeps showing "no build time
-- published", because that is the truth. There is an explicit, opt-in backfill
-- at the bottom that derives a stamp from real row write times — read it before
-- you run it.
--
-- Safe to run more than once.
-- ============================================================================

create schema if not exists ufc;

-- ------------------------------------------------------------------ meta ----
create table if not exists ufc.meta (
  key          text primary key,
  value        text,
  updated_at   timestamptz not null default now()
);
comment on table ufc.meta is
  'Pipeline build stamps, e.g. built_at, last_ingest, row_count_fighters, schema_version. The app reads these for its freshness SLA. Same contract as wta.meta and tennis.meta.';

-- Keys the app reads (it takes the first one present, in this order):
--   built_at        timestamptz as text — when the dataset was last REBUILT
--   last_ingest     timestamptz as text — fallback if the job only tracks ingest
-- Keys the app displays but does not depend on:
--   row_count_fighters, row_count_fights, source, schema_version
--
-- Nothing else reads these; adding a key is free, renaming one is not.

-- ------------------------------------------------------------- build log ----
-- The ledger. A stamp in `meta` tells you WHEN; this tells you what happened,
-- including the runs that failed. A pipeline that only records its successes
-- cannot be debugged, so failures are first-class rows here, not exceptions.
create table if not exists ufc.build_log (
  id           bigint generated always as identity primary key,
  job          text        not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text        not null default 'running'
                 check (status in ('running','ok','error')),
  rows_written integer,
  source       text,
  detail       jsonb       not null default '{}'::jsonb,
  error        text
);
comment on table ufc.build_log is
  'One row per pipeline run (ufcstats_sync, ufc_fighters_sync, ufc_live, ...). Failed runs are recorded with status=error and the message, so a silent pipeline stall is visible instead of looking like stale data.';

create index if not exists ufc_build_log_job_idx
  on ufc.build_log (job, started_at desc);
create index if not exists ufc_build_log_status_idx
  on ufc.build_log (status, started_at desc)
  where status <> 'ok';

-- ------------------------------------------------------- stamp_build() ------
-- What a sync job calls when it finishes. One call writes the ledger row and
-- the meta keys together, so the two can never disagree.
--
--   select ufc.stamp_build('ufcstats_sync', 4679, 'UFCStats', '{"schema_version":"1"}');
--
-- Passing p_error marks the run failed. It still writes the ledger row, and it
-- deliberately does NOT advance built_at — a failed run must not make the data
-- look freshly built.
--
-- p_advance_built_at exists for the live poller. ufc_live runs every few seconds
-- during a card, but it does not rebuild the fighter dataset, so it must record
-- that it ran without making the research data look freshly built. It passes
-- false; the sync jobs leave the default.
create or replace function ufc.stamp_build(
  p_job              text,
  p_rows             integer default null,
  p_source           text    default null,
  p_detail           jsonb   default '{}'::jsonb,
  p_error            text    default null,
  p_advance_built_at boolean default true
) returns bigint
language plpgsql
security definer
set search_path = ufc, pg_catalog
as $$
declare
  v_id bigint;
  v_ok boolean := (p_error is null);
  -- ISO-8601 UTC. Postgres' own now()::text ("2026-08-15 01:55:20.87+00") is
  -- parsed by V8 but rejected by other JS engines, and a build stamp the phone
  -- cannot parse reads to the app as "no build time published". Write the one
  -- format every engine agrees on.
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  insert into ufc.build_log (job, started_at, finished_at, status, rows_written, source, detail, error)
  values (p_job, now(), now(), case when v_ok then 'ok' else 'error' end,
          p_rows, p_source, coalesce(p_detail, '{}'::jsonb), p_error)
  returning id into v_id;

  -- Per-job stamps always update, success or failure, so you can see that a job
  -- ran at all and whether it worked.
  insert into ufc.meta (key, value, updated_at) values
    (p_job || '_last_run',    v_now, now()),
    (p_job || '_last_status', case when v_ok then 'ok' else 'error' end, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  if not v_ok then
    return v_id;   -- a failed run publishes no build time
  end if;

  -- The dataset-wide build time the app's freshness SLA reads.
  if p_advance_built_at then
    insert into ufc.meta (key, value, updated_at)
    values ('built_at', v_now, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;

  if p_rows is not null then
    insert into ufc.meta (key, value, updated_at)
    values ('row_count_' || p_job, p_rows::text, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;

  if p_source is not null then
    insert into ufc.meta (key, value, updated_at)
    values ('source', p_source, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;

  return v_id;
end $$;

comment on function ufc.stamp_build(text,integer,text,jsonb,text,boolean) is
  'Call at the end of every UFC pipeline run. Writes the build_log row and the ufc.meta stamps atomically. A run passed p_error records the failure and does NOT advance built_at. Pass p_advance_built_at=false from jobs that do not rebuild the dataset (the live poller).';

-- Only the service role writes build times. Postgres grants EXECUTE on new
-- functions to PUBLIC by default, which would let the signed-in app stamp its
-- own freshness — exactly the thing this whole change exists to prevent.
revoke execute on function ufc.stamp_build(text,integer,text,jsonb,text,boolean) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function ufc.stamp_build(text,integer,text,jsonb,text,boolean) to service_role';
  end if;
end $$;

-- ------------------------------------------------- what a sync job adds -----
-- One call, at the end of the run. ufcstats_sync and ufc_fighters_sync are
-- deployed Edge Functions and are not in this repo, so add this to each of
-- them by hand. `db` is a service-role client; if it is not pinned to the ufc
-- schema, use createClient(..., { db: { schema: "ufc" } }) for this call.
--
--   // success
--   await db.rpc("stamp_build", {
--     p_job: "ufcstats_sync",          // must match the function's own name
--     p_rows: written,                 // rows this run actually wrote
--     p_source: "UFCStats",
--     p_detail: { schema_version: "1" },
--   });
--
--   // failure — wrap the body in try/catch and stamp from the catch
--   await db.rpc("stamp_build", {
--     p_job: "ufcstats_sync",
--     p_error: String(e?.message ?? e).slice(0, 2000),
--   });
--
-- The live poller (ufc_live) additionally passes p_advance_built_at:false — it
-- streams a card, it does not rebuild the dataset. See its index.ts.

-- ------------------------------------------------------------------ RLS -----
-- Mirrors tennis/wta: readable by the signed-in app role, written only by the
-- service role (which bypasses RLS). The client never writes a build time.
alter table ufc.meta      enable row level security;
alter table ufc.build_log enable row level security;

drop policy if exists read_meta      on ufc.meta;
drop policy if exists read_build_log on ufc.build_log;
create policy read_meta      on ufc.meta      for select to authenticated using (true);
create policy read_build_log on ufc.build_log for select to authenticated using (true);

grant usage on schema ufc to authenticated;
grant select on ufc.meta, ufc.build_log to authenticated;

-- ------------------------------------------------------- health view --------
-- What you look at when the app says something is stale. One row per job.
create or replace view ufc.pipeline_health as
select l.job,
       l.status,
       l.started_at                  as last_run,
       now() - l.started_at          as age,
       l.rows_written,
       l.source,
       l.error
  from (
    select distinct on (job) *
      from ufc.build_log
     order by job, started_at desc
  ) l
 order by l.started_at desc;
comment on view ufc.pipeline_health is
  'Latest run per UFC pipeline job. If the app reports stale data, read this first: it distinguishes "job never ran" from "job ran and failed" from "job ran fine, source had nothing new".';

grant select on ufc.pipeline_health to authenticated;

-- ============================================================================
-- OPTIONAL BACKFILL — read this before running it.
--
-- The tables were built by runs that predate this ledger, so there is no
-- honest record of when. The statement below derives a build time from the
-- newest actual row write in ufc.fighters. That is a real timestamp from real
-- data, not a guess — but it is the time rows were last WRITTEN, which is only
-- the same as "built" if the sync writes every row each run.
--
-- If you would rather wait for the next real run to stamp itself, skip this.
-- The app will keep saying "no build time published" until then, which is
-- accurate.
--
-- Uncomment to run:
--
-- insert into ufc.meta (key, value, updated_at)
-- select 'built_at', to_char(max(updated_at) at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'), now()
--   from ufc.fighters
--  having max(updated_at) is not null
-- on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- insert into ufc.meta (key, value, updated_at)
-- values ('built_at_origin', 'backfilled from max(ufc.fighters.updated_at); not a recorded build', now())
-- on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- (If ufc.fighters has no updated_at column, do not substitute another column —
--  leave the stamp unpublished and let the next real run write it.)
-- ============================================================================

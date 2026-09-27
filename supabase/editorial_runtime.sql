-- ============================================================================
-- EDITORIAL RUNTIME — the production source of truth for how the autonomous
-- editorial system is configured, whether anything is actually invoking it,
-- and who is allowed to do a given piece of work right now.
--
-- WHY THIS EXISTS. Three weaknesses, all of them operational rather than
-- editorial:
--
--   1  Nothing reliably woke the dispatcher. GitHub's scheduler is degraded on
--      this repository — every scheduled workflow here is firing roughly every
--      four to five hours rather than on its stated cadence, and the editorial
--      workflow's own cron has never fired at all. A publisher that has to
--      notice a twenty-to-ninety-minute window cannot be built on that.
--
--   2  Editorial settings lived in a committed JSON file, so the admin console
--      could only ever display them. A browser cannot write to a git
--      repository, and a control that writes somewhere the pipeline does not
--      read is worse than no control.
--
--   3  Several schedulers invoking one dispatcher is the CORRECT design, but
--      without a lease two of them will make the same expensive provider and
--      model calls at the same time.
--
-- WHAT IS DELIBERATELY NOT HERE. Articles, snapshots, theses, audits and
-- grades are unchanged and live where they already lived. This file holds
-- runtime control only: configuration, liveness, and mutual exclusion.
--
-- Idempotent. Safe to run repeatedly. Reports at the end.
-- ============================================================================

-- site_articles.sql owns site_article_is_admin(), which every write policy
-- here reuses rather than building a second notion of who an operator is.
do $$
begin
  if to_regprocedure('public.site_article_is_admin()') is null then
    raise exception
      'editorial_runtime.sql needs public.site_article_is_admin(); run supabase/site_articles.sql first';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- settings --
-- ONE ROW. A singleton, because there is one editorial system and a second
-- settings row would immediately become a second source of truth.
create table if not exists public.editorial_settings (
  id integer primary key default 1,

  -- THE KILL SWITCH. False pauses all autonomous work: no generation, no
  -- publication, no postgame. It does NOT unpublish anything already public,
  -- does not touch an immutable record, and does not stop the dispatcher
  -- heartbeating — an operator needs to know a paused system is still alive.
  editorial_enabled boolean not null default true,
  -- the dispatcher may be stopped separately from the editorial work itself,
  -- which is what you want while debugging a scheduler
  dispatcher_enabled boolean not null default true,

  auto_publish_pregame boolean not null default true,
  auto_publish_postgame boolean not null default true,
  retry_enabled boolean not null default true,

  -- the publication windows; tools/editorial/windows.js is the only reader
  pregame_normal_lead_minutes integer not null default 90,
  pregame_minimum_publish_lead_minutes integer not null default 20,
  postgame_settle_minutes integer not null default 20,

  quality_floor integer not null default 70,

  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint editorial_settings_singleton check (id = 1)
);

-- Columns added after the first release land here rather than in the create,
-- so a project that already ran an earlier version is completed rather than
-- left half-shaped by a no-op `create table if not exists`.
alter table public.editorial_settings add column if not exists retry_enabled boolean not null default true;
alter table public.editorial_settings add column if not exists dispatcher_enabled boolean not null default true;
alter table public.editorial_settings add column if not exists updated_by uuid;

insert into public.editorial_settings (id) values (1) on conflict (id) do nothing;

-- VALIDATED IN THE DATABASE, not only in the form. A minimum above the normal
-- lead makes the late window negative: every article falls through to the
-- final hold and nothing publishes automatically, which is a silent outage.
-- Rejected here so no client can cause it, not even the service role.
alter table public.editorial_settings drop constraint if exists editorial_settings_leads_ck;
alter table public.editorial_settings add constraint editorial_settings_leads_ck check (
  pregame_minimum_publish_lead_minutes >= 0
  and pregame_normal_lead_minutes > pregame_minimum_publish_lead_minutes
  and pregame_normal_lead_minutes <= 2880          -- two days is already absurd
  and postgame_settle_minutes >= 0
  and postgame_settle_minutes <= 1440
  and quality_floor between 0 and 100
);

-- ------------------------------------------------------------- the audit ---
-- THE SYSTEM CONTROLS PUBLIC PUBLISHING, so a change to it is traceable: what
-- moved, from what, to what, when and by whom.
create table if not exists public.editorial_settings_audit (
  id bigserial primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  field text not null,
  old_value text,
  new_value text
);
create index if not exists editorial_settings_audit_at_idx
  on public.editorial_settings_audit (changed_at desc);

create or replace function public.editorial_settings_audit_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text;
  o text;
  n text;
begin
  -- every column except the bookkeeping ones, compared as text so one trigger
  -- covers booleans and integers alike
  for k in
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'editorial_settings'
      and column_name not in ('id', 'updated_at', 'updated_by')
  loop
    execute format('select ($1).%I::text, ($2).%I::text', k, k)
      into o, n using old, new;
    if o is distinct from n then
      insert into public.editorial_settings_audit (changed_by, field, old_value, new_value)
      values (new.updated_by, k, o, n);
    end if;
  end loop;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists editorial_settings_audit_trg on public.editorial_settings;
create trigger editorial_settings_audit_trg
  before update on public.editorial_settings
  for each row execute function public.editorial_settings_audit_fn();

-- ------------------------------------------------------------ heartbeats ---
-- WAS ANYTHING ACTUALLY INVOKED? Health used to infer the dispatcher's pulse
-- from the run log, which only exists when a run did something. A heartbeat is
-- written by EVERY invocation including the ones that found nothing to do, so
-- "the scheduler is not running" and "there was no work" stop looking alike.
create table if not exists public.editorial_heartbeats (
  id bigserial primary key,
  scheduler_source text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer,
  ok boolean,
  actions_considered integer not null default 0,
  actions_executed integer not null default 0,
  error text,
  detail jsonb,
  constraint editorial_heartbeats_source_ck check (
    scheduler_source in ('supabase_cron', 'github_schedule', 'github_workflow_run',
                         'github_push', 'manual', 'admin', 'test')
  )
);
create index if not exists editorial_heartbeats_started_idx
  on public.editorial_heartbeats (started_at desc);
create index if not exists editorial_heartbeats_source_idx
  on public.editorial_heartbeats (scheduler_source, started_at desc);

-- ----------------------------------------------------------------- leases ---
-- SEVERAL SCHEDULERS INVOKING ONE DISPATCHER IS THE DESIGN, not an accident,
-- so the dispatcher has to be safe to run twice at once. Article-level
-- idempotency already stops a duplicate PAGE; it does not stop two workers
-- paying for the same provider fetch and the same model call.
--
-- A lease rather than a lock: it carries an expiry, so a worker that dies
-- mid-run releases it by doing nothing. Nothing can stay stuck forever, and no
-- cleanup job is needed.
create table if not exists public.editorial_leases (
  lease_key text primary key,
  owner text not null,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  meta jsonb
);
create index if not exists editorial_leases_expires_idx
  on public.editorial_leases (expires_at);

-- ATOMIC CLAIM. The whole thing is one statement: insert if nobody holds it,
-- or take it over if the holder's lease has expired. Two workers racing this
-- produce exactly one winner because the conflict is resolved inside the
-- statement, not between a select and an insert.
--
-- Re-claiming a lease you already own EXTENDS it, so a long run does not lose
-- its own lease halfway through.
create or replace function public.editorial_claim(
  p_key text,
  p_owner text,
  p_ttl_seconds integer default 600,
  p_meta jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  got boolean;
begin
  if p_key is null or p_key = '' or p_owner is null or p_owner = '' then
    raise exception 'editorial_claim needs a key and an owner';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'editorial_claim ttl must be between 1 and 3600 seconds';
  end if;

  insert into public.editorial_leases (lease_key, owner, claimed_at, expires_at, meta)
  values (p_key, p_owner, now(), now() + make_interval(secs => p_ttl_seconds), p_meta)
  on conflict (lease_key) do update
    set owner = excluded.owner,
        claimed_at = now(),
        expires_at = excluded.expires_at,
        meta = excluded.meta
    where public.editorial_leases.expires_at < now()            -- the holder died
       or public.editorial_leases.owner = excluded.owner        -- or it is ours
  returning true into got;

  return coalesce(got, false);
end $$;

-- Release only what you hold. A worker cannot drop somebody else's lease by
-- accident, which is the failure mode that makes leases worse than useless.
create or replace function public.editorial_release(
  p_key text,
  p_owner text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  delete from public.editorial_leases
   where lease_key = p_key and owner = p_owner;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- What is held right now, for the health panel. Expired rows are reported as
-- expired rather than hidden: a lease that outlived its worker is a fact an
-- operator may want to see.
create or replace view public.editorial_leases_live as
  select lease_key, owner, claimed_at, expires_at, meta,
         (expires_at < now()) as expired
    from public.editorial_leases;

-- ------------------------------------------------------------------- RLS ---
alter table public.editorial_settings enable row level security;
alter table public.editorial_settings_audit enable row level security;
alter table public.editorial_heartbeats enable row level security;
alter table public.editorial_leases enable row level security;

-- SETTINGS ARE PUBLICLY READABLE. They describe how a public publisher
-- behaves, there is nothing secret in a lead time, and the build job reads
-- them through the anon key. WRITES ARE OPERATORS ONLY.
drop policy if exists "editorial settings read" on public.editorial_settings;
create policy "editorial settings read" on public.editorial_settings
  for select to anon, authenticated using (true);

drop policy if exists "editorial settings admin write" on public.editorial_settings;
create policy "editorial settings admin write" on public.editorial_settings
  for update to authenticated
  using (public.site_article_is_admin())
  with check (public.site_article_is_admin());

-- The audit trail is an operator record, not public.
drop policy if exists "editorial audit admin read" on public.editorial_settings_audit;
create policy "editorial audit admin read" on public.editorial_settings_audit
  for select to authenticated using (public.site_article_is_admin());

-- Heartbeats are readable so the health panel can render them without a
-- credential; only the service role writes them.
drop policy if exists "editorial heartbeats read" on public.editorial_heartbeats;
create policy "editorial heartbeats read" on public.editorial_heartbeats
  for select to anon, authenticated using (true);

-- Leases are operator-visible, never client-writable.
drop policy if exists "editorial leases admin read" on public.editorial_leases;
create policy "editorial leases admin read" on public.editorial_leases
  for select to authenticated using (public.site_article_is_admin());

grant select on public.editorial_settings to anon, authenticated;
grant update on public.editorial_settings to authenticated;
grant select on public.editorial_heartbeats to anon, authenticated;
grant select on public.editorial_settings_audit to authenticated;
grant select on public.editorial_leases to authenticated;
grant select on public.editorial_leases_live to authenticated;

-- NO CLIENT MAY CLAIM A LEASE. Claiming is a server-side act performed by the
-- pipeline under the service role; exposing it to a browser would let any
-- signed-in user stall the publisher by holding the dispatcher lease.
revoke all on function public.editorial_claim(text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.editorial_release(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- report ---
do $$
declare
  r record;
begin
  raise notice '--- editorial runtime ---';
  for r in
    select 'editorial_settings' as t, count(*) as n from public.editorial_settings
    union all select 'editorial_heartbeats', count(*) from public.editorial_heartbeats
    union all select 'editorial_leases', count(*) from public.editorial_leases
    union all select 'editorial_settings_audit', count(*) from public.editorial_settings_audit
  loop
    raise notice '  % : % row(s)', rpad(r.t, 26), r.n;
  end loop;
  raise notice '  claim/release: %',
    case when to_regprocedure('public.editorial_claim(text,text,integer,jsonb)') is not null
         then 'installed' else 'MISSING' end;
  raise notice '  lead constraint: %',
    case when exists (select 1 from pg_constraint
                       where conname = 'editorial_settings_leads_ck') then 'ok' else 'MISSING' end;
end $$;

-- =============================================================================
-- odds_api_emergency_stop — THE ODDS API CIRCUIT BREAKER, ON. RUN THIS FIRST.
--
-- Incident 2026-10-10: 99,336 of 100,000 monthly credits used, 664 left, 21
-- days before the provider resets (2026-11-01 00:00 UTC). See
-- docs/odds-api-incident-2026-10/INCIDENT.md.
--
-- WHAT THIS FILE DOES, in order, and nothing else:
--   1. creates the one-row switch public.odds_api_config if it is not there,
--      with odds_api_enabled = false (FAIL CLOSED: a missing row, a missing
--      table or an unreadable value is treated as OFF by every caller);
--   2. sets odds_api_enabled = false and the paid monthly budget AND the daily
--      target to ZERO, remembering the previous values;
--   3. PAUSES (cron.alter_job active := false — never unschedules, never
--      deletes) every pg_cron job whose command can reach a paid Odds API path,
--      and records each one in public.odds_api_paused_jobs so the exact set can
--      be resumed later by public.odds_api_resume_schedules();
--   4. lists jobs that MIGHT spend (deployed functions this repository cannot
--      see) without pausing them, so an operator decides with the list in hand.
--
-- WHAT IT DOES NOT DO: delete a job, drop a table, touch a stored odds row, a
-- signal, a quote or a projection. Every research surface keeps reading what
-- is already stored. Running it twice is the same as running it once.
--
-- THE FASTER, STRONGER STOP sits outside SQL and is in the runbook: unset the
-- ODDS_API_KEY / THE_ODDS_API_KEY function secrets and the ODDS_API_KEY GitHub
-- secret. Code this repository cannot see (functions deployed by hand, listed
-- by tools/supabase/download_functions.sh) cannot read a switch it was never
-- written to read, but it cannot spend a key that is not there.
--
-- Paste into the Supabase SQL editor. No psql meta-commands. Ends in a report.
-- =============================================================================

create table if not exists public.odds_api_config (
  id                 smallint primary key default 1 check (id = 1),
  odds_api_enabled   boolean not null default false,
  breaker_reason     text,
  breaker_changed_at timestamptz,
  breaker_changed_by text,
  monthly_budget     integer not null default 0,
  monthly_reserve    integer not null default 40000,
  daily_target       integer not null default 0,
  updated_at         timestamptz not null default now()
);
alter table public.odds_api_config add column if not exists prev_monthly_budget integer;
alter table public.odds_api_config add column if not exists prev_daily_target integer;
alter table public.odds_api_config enable row level security;
revoke all on public.odds_api_config from anon, authenticated;

insert into public.odds_api_config (id, odds_api_enabled, breaker_reason, breaker_changed_at, breaker_changed_by)
values (1, false, 'created disabled (fail closed)', now(), 'odds_api_emergency_stop.sql')
on conflict (id) do nothing;

create table if not exists public.odds_api_paused_jobs (
  id            bigserial primary key,
  jobid         bigint not null,
  jobname       text,
  schedule      text,
  command       text,
  paused_at     timestamptz not null default now(),
  paused_reason text,
  resumed_at    timestamptz,
  resumed_by    text
);
create index if not exists odds_api_paused_jobs_open_idx on public.odds_api_paused_jobs (jobid) where resumed_at is null;
alter table public.odds_api_paused_jobs enable row level security;
revoke all on public.odds_api_paused_jobs from anon, authenticated;

-- The command patterns that reach a paid Odds API path. `capture`, `close`,
-- `collective_odds_ingest` and `props_cron` (which dispatches the GitHub prop
-- capture) are in this repository; the rest are functions that are deployed
-- but not exported (tools/supabase/download_functions.sh) and whose names say
-- odds. A job is paused when its command matches any of these.
create or replace function public.odds_api_spend_patterns()
returns text[] language sql immutable as $$
  select array[
    '%/functions/v1/capture%', '%capture_poke%', '%/functions/v1/close%',
    '%/functions/v1/collective_odds_ingest%', '%/functions/v1/props_cron%',
    '%/functions/v1/odds?%', '%/functions/v1/odds''%', '%/functions/v1/odds"%',
    '%/functions/v1/wta_odds%', '%/functions/v1/wta_close%', '%/functions/v1/cfb_close%',
    '%/functions/v1/close_backfill%', '%/functions/v1/capture_boards%', '%/functions/v1/model_conf_odds%',
    '%/functions/v1/ingest_multisport%', '%/functions/v1/run_slate%', '%/functions/v1/scores_diag%'
  ]::text[]
$$;

-- Deployed functions that MAY call a paid endpoint (a /scores call costs 1-2
-- credits) but also do research work. Reported, never paused automatically.
create or replace function public.odds_api_suspect_patterns()
returns text[] language sql immutable as $$
  select array['%/functions/v1/settle%', '%/functions/v1/tennis_ingest%', '%/functions/v1/mark_provider_exhausted%']::text[]
$$;

create or replace function public.odds_api_emergency_stop(p_reason text default 'emergency stop')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paused jsonb := '[]'::jsonb;
  v_suspect jsonb := '[]'::jsonb;
  v_other jsonb := '[]'::jsonb;
  j record;
begin
  update public.odds_api_config
     set prev_monthly_budget = case when monthly_budget > 0 then monthly_budget else prev_monthly_budget end,
         prev_daily_target   = case when daily_target > 0 then daily_target else prev_daily_target end,
         odds_api_enabled = false, monthly_budget = 0, daily_target = 0,
         breaker_reason = left(coalesce(p_reason, 'emergency stop'), 300),
         breaker_changed_at = now(), breaker_changed_by = 'odds_api_emergency_stop', updated_at = now()
   where id = 1;

  if to_regclass('cron.job') is null or to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
    return jsonb_build_object('breaker', 'off', 'budget', 0, 'pg_cron', 'not installed: nothing to pause');
  end if;

  for j in execute 'select jobid, jobname, schedule, command, active from cron.job order by jobid' loop
    if j.command ilike any (public.odds_api_spend_patterns()) then
      if j.active then
        execute 'select cron.alter_job($1, null, null, null, null, false)' using j.jobid;
        insert into public.odds_api_paused_jobs (jobid, jobname, schedule, command, paused_reason)
        values (j.jobid, j.jobname, j.schedule, left(j.command, 2000), left(coalesce(p_reason, 'emergency stop'), 300));
        v_paused := v_paused || jsonb_build_object('jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule);
      end if;
    elsif j.command ilike any (public.odds_api_suspect_patterns()) then
      v_suspect := v_suspect || jsonb_build_object('jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active);
    elsif j.command ilike '%/functions/v1/%' then
      v_other := v_other || jsonb_build_object('jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active);
    end if;
  end loop;

  return jsonb_build_object(
    'breaker', 'off', 'monthly_budget', 0, 'daily_target', 0,
    'paused_now', v_paused,
    'suspects_not_paused', v_suspect,
    'other_function_jobs', v_other,
    'next', 'Unset ODDS_API_KEY / THE_ODDS_API_KEY (Supabase secrets) and ODDS_API_KEY (GitHub). See docs/odds-api-incident-2026-10/INCIDENT.md.'
  );
end $$;
revoke all on function public.odds_api_emergency_stop(text) from public, anon, authenticated;

-- Resume EXACTLY the jobs the emergency stop paused, and only those that call
-- code routed through the gateway (capture, close, collective_odds_ingest,
-- props_cron). A job for a function this repository cannot see stays paused:
-- resuming it would let unaudited code spend credits directly. This does NOT
-- turn the breaker on; public.odds_api_set_enabled() does, under its own checks.
create or replace function public.odds_api_resume_schedules(p_resumed_by text default 'operator')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resumed jsonb := '[]'::jsonb;
  v_kept jsonb := '[]'::jsonb;
  p record;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('resumed', v_resumed, 'note', 'pg_cron is not installed');
  end if;
  for p in select * from public.odds_api_paused_jobs where resumed_at is null order by id loop
    if p.command ilike any (array['%/functions/v1/capture?%', '%capture_poke%', '%/functions/v1/close%',
                                  '%/functions/v1/collective_odds_ingest%', '%/functions/v1/props_cron%'])
       and p.command not ilike any (array['%close_backfill%', '%capture_boards%']) then
      begin
        execute 'select cron.alter_job($1, null, null, null, null, true)' using p.jobid;
        update public.odds_api_paused_jobs set resumed_at = now(), resumed_by = left(p_resumed_by, 120) where id = p.id;
        v_resumed := v_resumed || jsonb_build_object('jobid', p.jobid, 'jobname', p.jobname);
      exception when others then
        v_kept := v_kept || jsonb_build_object('jobid', p.jobid, 'jobname', p.jobname, 'error', left(sqlerrm, 200));
      end;
    else
      v_kept := v_kept || jsonb_build_object('jobid', p.jobid, 'jobname', p.jobname, 'why', 'not routed through odds_gateway');
    end if;
  end loop;
  return jsonb_build_object('resumed', v_resumed, 'kept_paused', v_kept,
    'note', 'Schedules resumed. The breaker is unchanged; paid calls still need odds_api_set_enabled(true, ...).');
end $$;
revoke all on function public.odds_api_resume_schedules(text) from public, anon, authenticated;

-- How many ACTIVE pg_cron jobs can still reach a paid path. Dynamic, so this
-- file runs (and reports 0) on a database without pg_cron.
create or replace function public.odds_api_active_spend_jobs()
returns integer language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v integer := 0;
begin
  if to_regclass('cron.job') is null then return 0; end if;
  execute 'select count(*)::int from cron.job where active and command ilike any ($1)' into v using public.odds_api_spend_patterns();
  return v;
end $$;
revoke all on function public.odds_api_active_spend_jobs() from public, anon, authenticated;

do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.odds_api_config, public.odds_api_paused_jobs to service_role';
    execute 'grant execute on function public.odds_api_emergency_stop(text), public.odds_api_resume_schedules(text) to service_role';
  end if;
end $g$;

-- ── THE STOP ITSELF ─────────────────────────────────────────────────────────
select public.odds_api_emergency_stop('2026-10-10 incident: 99,336/100,000 credits used; paid retrieval paused pending audit') as emergency_stop;

-- ── THE REPORT ──────────────────────────────────────────────────────────────
with checks as (
  select 1 as n, 'the circuit breaker is OFF (odds_api_enabled = false)' as check_name,
         (select count(*) from public.odds_api_config where id = 1 and not odds_api_enabled)::int as got, 1 as want
  union all select 2, 'the paid monthly budget and daily target are ZERO',
         (select count(*) from public.odds_api_config where id = 1 and monthly_budget = 0 and daily_target = 0)::int, 1
  union all select 3, 'the switch is private (RLS on, no anon/authenticated read)',
         (case when (select relrowsecurity from pg_class where oid = 'public.odds_api_config'::regclass)
                and not has_table_privilege('anon', 'public.odds_api_config', 'select')
                and not has_table_privilege('authenticated', 'public.odds_api_config', 'update')
               then 1 else 0 end), 1
  union all select 4, 'no active pg_cron job can reach a known paid Odds API path',
         public.odds_api_active_spend_jobs(), 0
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by n;

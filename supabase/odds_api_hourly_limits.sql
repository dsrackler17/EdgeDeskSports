-- ============================================================================
-- ODDS API — NOTHING RUNS OR BUYS MORE OFTEN THAN HOURLY (2026-10-21)
--
-- Paste into the Supabase SQL editor and run. Safe to re-run. Every report row
-- at the bottom should say ok.
--
-- WHY. October's 100,000 credits were spent in 9.5 days
-- (docs/odds-api-incident-2026-10/INCIDENT.md): paid jobs fired every 5, 10
-- and 20 minutes. The operator's rule since 2026-10-21: no paid Odds API path
-- runs, and no stored snapshot is refreshed, more often than once an hour.
--
-- TWO LAYERS, so undoing one does not undo the rule:
--   1. PURCHASES. public.odds_api_cadence is how old a stored snapshot may get
--      before the gateway buys a fresh one, whoever asks and however often.
--      Every band under 60 minutes becomes 60 (the main markets inside 3 h of
--      kickoff were 20), and a constraint refuses any band under an hour.
--   2. SCHEDULES. Every pg_cron job that can reach a paid Odds API path fires
--      at most once an hour:
--        capture_near           hourly at :12     (was every 20 min; 10 before the incident)
--        capture_day            every 2 h at :04  (was hourly; :04 and :34 before)
--        capture_board          every 6 h at :18  (every 4 h before the incident)
--        player_props_dispatch  hourly at :38     (was every 15 min; 5 before)
--        any other paid job     hourly, at the first minute it already used
--                               (else :27), its hours, days and months kept
--      A job's command and its paused/active state are never touched: a job
--      the emergency stop paused stays paused, and the stop still finds every
--      one of them. Jobs that cannot reach a paid path (Kalshi, stats,
--      settlement) are left exactly as they are.
--
-- WHAT IT DOES NOT DO.
--   - Turn the breaker on or off, or change the budget. Those still cap what
--     any hour may buy (the recovery budget: 60,000 a month, 1,500 a day).
--   - Bind a function that calls the provider itself. Only the functions
--     deployed from this repository since 2026-10-10 (odds_gateway, capture,
--     close, collective_odds_ingest, props_cron) go through the gateway.
--     Deploy them, and remove ODDS_API_KEY / THE_ODDS_API_KEY from the
--     edge-function secrets, so nothing but odds_gateway can buy at all.
--
-- The repository's own files agree (supabase/capture_cron.sql,
-- supabase/player_props_cron.sql, supabase/odds_api_gateway.sql), so
-- re-applying any of them cannot bring a faster schedule back.
-- ============================================================================

do $guard$
begin
  if to_regclass('public.odds_api_cadence') is null then
    raise exception 'Apply supabase/odds_api_gateway.sql first: the purchase cadence lives in public.odds_api_cadence.';
  end if;
  if to_regprocedure('public.odds_api_spend_patterns()') is null then
    raise exception 'Apply supabase/odds_api_emergency_stop.sql first: it names the paid Odds API paths this file slows.';
  end if;
end $guard$;

-- ── 1. PURCHASES: no band under an hour ─────────────────────────────────────
update public.odds_api_cadence set interval_minutes = 60 where interval_minutes < 60;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'odds_api_cadence_hourly_floor') then
    alter table public.odds_api_cadence add constraint odds_api_cadence_hourly_floor
      check (interval_minutes is null or interval_minutes >= 60);
  end if;
end $$;

-- ── 2. SCHEDULES: no paid job more than once an hour ────────────────────────
-- At most hourly = one fixed minute, or an @hourly-or-slower macro. pg_cron's
-- '[1-59] seconds' form is sub-minute and never qualifies.
create or replace function public.odds_api_cron_at_most_hourly(p_schedule text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $f$
  select case
    when p_schedule is null or p_schedule ~* 'second' then false
    when btrim(p_schedule) like '@%' then
      lower(btrim(p_schedule)) in ('@hourly', '@daily', '@midnight', '@weekly', '@monthly', '@yearly', '@annually', '@reboot')
    else coalesce(array_length(regexp_split_to_array(btrim(p_schedule), '\s+'), 1) = 5
                  and (regexp_split_to_array(btrim(p_schedule), '\s+'))[1] ~ '^[0-5]?[0-9]$', false)
  end
$f$;

-- The same schedule slowed to hourly: the first minute it names (else
-- p_minute), with its hour, day, month and weekday fields kept. A schedule
-- already hourly or slower comes back unchanged.
create or replace function public.odds_api_cron_hourly(p_schedule text, p_minute integer default 27)
returns text language plpgsql immutable set search_path = pg_catalog, pg_temp as $f$
declare f text[]; m text;
begin
  if public.odds_api_cron_at_most_hourly(p_schedule) then return p_schedule; end if;
  f := regexp_split_to_array(btrim(coalesce(p_schedule, '')), '\s+');
  if array_length(f, 1) = 5 then
    m := substring(f[1] from '^([0-9]+)');
    if m is null or m::int > 59 then m := p_minute::text; end if;
    return m::int::text || ' ' || array_to_string(f[2:5], ' ');
  end if;
  return p_minute::text || ' * * * *';
end $f$;

-- What the schedules are now: the jobs this file names, and every paid job
-- that still fires more than once an hour. Also the place to look later:
--   select public.odds_api_schedule_audit();
create or replace function public.odds_api_schedule_audit()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare v jsonb;
begin
  if to_regclass('cron.job') is null then return null; end if;
  execute $q$
    select jsonb_build_object(
      'capture_hourly', (select count(*) from cron.job where (jobname, schedule) in
                          (('capture_near', '12 * * * *'), ('capture_day', '4 */2 * * *'), ('capture_board', '18 */6 * * *'))),
      'props_hourly', (select count(*) from cron.job where jobname = 'player_props_dispatch' and schedule = '38 * * * *'),
      'paid_jobs', (select coalesce(jsonb_agg(jsonb_build_object('job', jobname, 'schedule', schedule, 'active', active) order by jobid), '[]'::jsonb)
                      from cron.job where command ilike any (public.odds_api_spend_patterns())),
      'faster_than_hourly', (select coalesce(jsonb_agg(jobname || ' (' || schedule || ')' order by jobid), '[]'::jsonb)
                               from cron.job where command ilike any (public.odds_api_spend_patterns())
                                 and not public.odds_api_cron_at_most_hourly(schedule)))
  $q$ into v;
  return v;
end $f$;

revoke all on function public.odds_api_cron_at_most_hourly(text) from public, anon, authenticated;
revoke all on function public.odds_api_cron_hourly(text, integer) from public, anon, authenticated;
revoke all on function public.odds_api_schedule_audit() from public, anon, authenticated;

do $$
declare j record; v_target text;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed: there is no schedule to slow.';
    return;
  end if;
  for j in execute 'select jobid, jobname, schedule, command from cron.job order by jobid' loop
    v_target := case j.jobname
      when 'capture_near' then '12 * * * *'
      when 'capture_day' then '4 */2 * * *'
      when 'capture_board' then '18 */6 * * *'
      when 'player_props_dispatch' then '38 * * * *'
      else case when j.command ilike any (public.odds_api_spend_patterns()) then public.odds_api_cron_hourly(j.schedule) end
    end;
    if v_target is not null and v_target is distinct from j.schedule then
      execute 'select cron.alter_job($1, $2)' using j.jobid, v_target;
      raise notice 'slowed %: % -> %', j.jobname, j.schedule, v_target;
    end if;
  end loop;
end $$;

-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- A CHECK THIS on row 5: select public.odds_api_schedule_audit(); names the job.
with a as (select public.odds_api_schedule_audit() as s),
checks as (
  select 1 as n, 'no purchase band under an hour (main markets inside 3 h of kickoff: 60 min, was 20)' as check_name,
         (select count(*) from public.odds_api_cadence where interval_minutes < 60)::int as got, 0 as want
  union all select 2, 'the database refuses any band under an hour (odds_api_cadence_hourly_floor)',
         (select count(*) from pg_constraint where conname = 'odds_api_cadence_hourly_floor')::int, 1
  union all select 3, 'capture: near hourly at :12, day every 2 h at :04, board every 6 h at :18',
         coalesce((select (s ->> 'capture_hourly')::int from a), 0), 3
  union all select 4, 'player_props_dispatch: hourly at :38',
         coalesce((select (s ->> 'props_hourly')::int from a), 0), 1
  union all select 5, 'no pg_cron job that can reach a paid Odds API path fires more than once an hour',
         coalesce((select jsonb_array_length(s -> 'faster_than_hourly') from a), 0), 0
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by n;

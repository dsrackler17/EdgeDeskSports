-- =============================================================================
-- nfl_market_structure_cron.sql — the Thursday freeze, on pg_cron.
-- docs/market-structure/README.md
--
-- REQUIRES supabase/nfl_market_structure.sql and the pg_cron extension.
--
-- The job is pure SQL — public.nfl_line_snapshot_take() — so there is no edge
-- function, no HTTP hop and no x-cron-secret: it runs inside the database as
-- the role that scheduled it.
--
-- WHEN. The freeze is Thursday 13:00 America/New_York (market_snapshot_config),
-- which is 17:00 UTC under daylight time and 18:00 UTC under standard time.
-- pg_cron runs in UTC, so the job runs every 15 minutes through Thursday
-- afternoon and evening UTC, plus hourly Friday to Sunday as a backstop. That
-- is safe because the function is idempotent and reads capture history AT OR
-- BEFORE the freeze instant: a run at 17:15, at 22:00 or on Saturday records
-- the same number a run at 17:00:00 would (taken_at says which it was). A run
-- before this week's freeze resolves to last week's and skips what is frozen.
--
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.nfl_line_snapshot_take(timestamptz,text)') is null then
    raise exception 'apply supabase/nfl_market_structure.sql first';
  end if;
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)';
  end if;
end $req$;

select cron.unschedule(jobid) from cron.job where jobname in ('nfl_line_snapshot', 'nfl_line_snapshot_backstop');
select cron.schedule('nfl_line_snapshot', '*/15 16-23 * * 4', $job$ select public.nfl_line_snapshot_take(); $job$);
select cron.schedule('nfl_line_snapshot_backstop', '23 * * * 5,6,0', $job$ select public.nfl_line_snapshot_take(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 the Thursday job is scheduled' as piece, case when exists (select 1 from cron.job where jobname = 'nfl_line_snapshot' and active) then 'ok' else 'CHECK THIS' end as state
  union all select '2 the Friday-Sunday backstop is scheduled', case when exists (select 1 from cron.job where jobname = 'nfl_line_snapshot_backstop' and active) then 'ok' else 'CHECK THIS' end
  union all select '3 the freeze due now', coalesce(to_char(public.market_snapshot_instant(now()) at time zone 'America/New_York', 'Dy YYYY-MM-DD HH24:MI "ET"'), 'CHECK THIS: no config')
) r order by 1;

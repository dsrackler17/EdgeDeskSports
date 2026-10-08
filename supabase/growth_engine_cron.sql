-- =============================================================================
-- growth_engine_cron — freeze last week's growth report every Monday.
--
-- One pg_cron job, entirely inside the database: it calls
-- public.growth_weekly_snapshot() (supabase/growth_engine.sql), which builds
-- the report for the previous Monday-to-Monday week and stores it in
-- growth_weekly_reports, where /admin/acquisition/ reads it. Nothing leaves
-- the database: no email, no HTTP call, no public log.
--
-- RUN ORDER: supabase/growth_engine.sql first. Idempotent: running this
-- again replaces the job with the same schedule.
-- =============================================================================
create extension if not exists pg_cron;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not available. Enable it in the Supabase dashboard (Database → Extensions) before running this file.';
  end if;
  if to_regprocedure('public.growth_weekly_snapshot(boolean)') is null then
    raise exception 'Apply supabase/growth_engine.sql first.';
  end if;
end $$;

-- Monday 06:17 UTC: the week is over in every US time zone, and the minute
-- avoids the top of the hour every other job uses.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'growth_weekly_snapshot';
  perform cron.schedule('growth_weekly_snapshot', '17 6 * * 1', 'select public.growth_weekly_snapshot()');
end $$;

select 1 as row, 'the weekly growth snapshot is scheduled' as check,
  case when exists (select 1 from cron.job where jobname = 'growth_weekly_snapshot' and schedule = '17 6 * * 1')
       then 'ok' else 'CHECK THIS' end as result;

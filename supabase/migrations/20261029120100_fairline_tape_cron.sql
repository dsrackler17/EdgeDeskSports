-- =============================================================================
-- fairline_tape_cron.sql — when The Tape is built: Monday morning in
-- America/Chicago. docs/fairline.md
--
-- One pg_cron job, entirely inside the database (as growth_engine_cron.sql):
-- it calls public.fairline_tape_build() (supabase/fairline_tape.sql), which
-- builds last week's Tape for every Fairline reader and queues its email.
-- Nothing leaves the database here: no HTTP call, no secret. The email goes
-- out through the existing email pipeline, the trial emails' hourly job
-- (.github/workflows/lifecycle-email.yml, tools/fairline/tape_send.js).
--
-- CENTRAL TIME AND DST (as discord_cron.sql). 06:00 in Chicago is 11:00 UTC
-- under daylight time and 12:00 UTC under standard time, so the job fires at
-- :23 in BOTH UTC hours on Monday and the function decides, from the
-- America/Chicago zone database, whether it is Monday from 06:00 there. The
-- hour before answers due: false and builds nothing. The hour after is a
-- catch-up that adds nothing: one Tape per reader per week is the table's
-- unique key, so a second or overlapping run can never build one twice.
-- The minute keeps clear of the top of the hour and of the email job's :17.
--
-- RUN ORDER: supabase/fairline_tape.sql first. pg_cron enabled.
-- CONVENTION (supabase/README.md): idempotent, pasted into the SQL editor, no
-- psql meta-commands, ends in a report. Safe to run again: it replaces the
-- job with the same schedule.
-- =============================================================================

do $req$ begin
  if to_regprocedure('public.fairline_tape_build(timestamptz,boolean)') is null then raise exception 'apply supabase/fairline_tape.sql first'; end if;
  if to_regclass('cron.job') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not enabled (Database -> Extensions -> pg_cron)';
  end if;
end $req$;

select cron.unschedule(jobid) from cron.job where jobname = 'fairline_tape_build';
select cron.schedule('fairline_tape_build', '23 11,12 * * 1', $job$ select public.fairline_tape_build(); $job$);

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 The Tape is built on Mondays at :23, 11:00-12:59 UTC (06:00 CT under CDT and CST)' as piece,
         case when (select count(*) from cron.job where jobname = 'fairline_tape_build' and schedule = '23 11,12 * * 1' and active) = 1
              then 'ok' else 'CHECK THIS' end as state
  union all select '2 the build decides the hour in America/Chicago',
         case when (public.fairline_tape_build('2026-11-02 11:23+00'::timestamptz) ->> 'due')::boolean = false
               and (public.fairline_rules() #>> '{tape,time_zone}') = 'America/Chicago'
              then 'ok (05:23 CST on 2 Nov 2026 is not yet due)' else 'CHECK THIS' end
  union all select '3 the email job that sends it (lifecycle-email.yml) needs both switches',
         'ok (Tape email ' || case when (select email_enabled from public.fairline_tape_settings where id = 1) then 'ON' else 'off' end
         || ', email pipeline ' || case when (select sending_enabled from public.lifecycle_settings where id = 1) then 'ON' else 'off' end || ')'
) r order by 1;

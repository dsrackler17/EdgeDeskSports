-- ============================================================================
-- THE MORNING RUN'S CLOCK — pg_cron calling growth_outbound.schedule_tick()
-- every five minutes (Phase 9 of the outbound engine; docs/growth-outbound.md).
--
-- WHAT A TICK DOES. Nothing, unless the owner has turned automation on
-- (Outbound → Outbound settings) and it is inside their morning window, in
-- their time zone. Then it does ONE step of today's morning run:
--   1  search the saved searches (once a day);
--   2  research the next new candidate (up to "Prospects to prepare per day");
--   3  draft for whoever is due, a few at a time (up to the daily send cap).
-- Each step is a run with a single-use ticket, posted through pg_net to the
-- research or drafting Edge Function. The ticket opens only the engine's own
-- doors, for that run, for 15 minutes; the database keeps only its hash.
--
-- WHAT IT NEVER DOES: approve or send. Every draft waits for the owner in
-- the review queue; approving and sending are the owner's, checked by the
-- database, and no ticket reaches those doors.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS.
--
--   1  Run supabase/growth_outbound.sql first (Phase 9 or later).
--   2  Enable pg_cron and pg_net (Database → Extensions). Already on if any
--      other *_cron.sql in this folder has been run.
--   3  Deploy growth_outbound_research and growth_outbound_draft (Actions →
--      Deploy outbound Edge Functions). Both are deployed with JWT
--      verification OFF: pg_cron sends no JWT, and the ticket is checked by
--      the database.
--   4  Run this file. It needs no key and no database setting.
--   5  In the console, turn automation on and set the window.
--
-- To stop the clock entirely:  select cron.unschedule('growth_outbound_tick');
-- To pause the morning run:    turn automation off in the console (every
--                              live ticket stops working at once).
-- Idempotent: re-running replaces the job rather than adding a second.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception
      'pg_cron is not available. Enable it in the Supabase dashboard (Database → Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception
      'pg_net is not available, or is an older build without net.http_post(url, body, params, headers, timeout). Enable or upgrade it in the Supabase dashboard (Database → Extensions).';
  end if;
  if to_regprocedure('growth_outbound.schedule_tick(text,timestamp with time zone)') is null then
    raise exception
      'Run supabase/growth_outbound.sql (Phase 9 or later) first: this file schedules its growth_outbound.schedule_tick().';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE JOB. Every five minutes; the tick decides whether there is anything to
-- do, so an idle tick is a few small reads and one update. The address is
-- this project's Edge Functions; the tick appends the function's name.
-- ---------------------------------------------------------------------------
select cron.unschedule('growth_outbound_tick')
  where exists (select 1 from cron.job where jobname = 'growth_outbound_tick');

select cron.schedule(
  'growth_outbound_tick',
  '*/5 * * * *',
  $job$select growth_outbound.schedule_tick('https://iattxbkbufslbauoumga.supabase.co/functions/v1/');$job$
);

-- THE REPORT. Every row should say ok. Whether the ticks ARRIVE is proven
-- five minutes later, in the console (Outbound → Morning run: "last tick"),
-- or here:  select * from growth_outbound.scheduler;
with checks as (
  select 1 as n, 'the growth_outbound_tick job is scheduled every five minutes' as check_name,
         (select count(*) from cron.job where jobname = 'growth_outbound_tick' and schedule = '*/5 * * * *' and active)::int as got, 1 as want
  union all select 2, 'the job calls growth_outbound.schedule_tick with this project''s functions address, and no key',
         (select count(*) from cron.job where jobname = 'growth_outbound_tick'
            and command like '%growth_outbound.schedule_tick(''https://%.supabase.co/functions/v1/'')%'
            and command not like '%authorization%' and command not like '%current_setting%')::int, 1
  union all select 3, 'the scheduler''s record exists (the console reads the last tick from it)',
         (select count(*) from growth_outbound.scheduler where id = 1)::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks
union all
select 4, 'automation is ' || (select case when automation_enabled then 'ON' else 'off (turn it on in the console when ready)' end
                                 from growth_outbound.settings where id = 1), 1, 1, 'ok'
order by 1;

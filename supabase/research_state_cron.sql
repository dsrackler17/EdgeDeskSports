-- ============================================================================
-- THE PRIMARY RESEARCH-STATE SCHEDULER — pg_cron calling the research_cron
-- edge function every five minutes.
--
-- WHY NOT GITHUB ACTIONS. Because it does not fire. research-state.yml is
-- scheduled `38 * * * *` and GitHub ran it at 01:09, 07:34, 15:55 and 22:15
-- UTC on 2026-09-28, then 02:16, 08:59, 16:06 and 21:00 on 2026-09-29: every
-- five to eight hours, the gaps every scheduled workflow here has shown since
-- 2026-09-13 (editorial_cron.sql, player_props_cron.sql). The game lines are
-- captured every few minutes, but game_research_state — what the landing
-- page and the terminal read — only moves when that job runs, so on game day
-- lines fell outside the landing page's three-hour window and off the board.
-- GitHub's own cron stays in research-state.yml as the BACKUP path.
--
-- WHAT THIS SCHEDULES. Not the job — the POKE. research_cron reads the newest
-- computed_at in game_research_state and asks GitHub to run
-- research-state.yml when it is older than the cadence: 25 minutes while a
-- kickoff is inside 24 hours (a run about every half hour), 55 otherwise
-- (hourly). It never dispatches twice inside one cadence, and it keeps its
-- last dispatch in the table below to know that.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS.
--
--   1  Enable pg_cron and pg_net (Database → Extensions). Already on if
--      player_props_cron.sql or capture_cron.sql has been run.
--   2  personal_research.sql must have been applied (game_research_state).
--   3  Deploy the function with JWT verification OFF — the Deploy research
--      scheduler workflow does it that way, or:
--          supabase functions deploy research_cron --no-verify-jwt
--   4  A GitHub token with `actions:write` on this repository. Nothing new
--      if props_cron already has one: Supabase secrets are shared by every
--      function in the project, and research_cron reads RESEARCH_GH_TOKEN,
--      then PROPS_GH_TOKEN, then EDITORIAL_GH_TOKEN. Otherwise:
--          supabase secrets set RESEARCH_GH_TOKEN=<token>
--   5  Run this file. It needs no database setting and no key.
--
-- Until step 3 is done pg_net logs a 404 for each tick and nothing else
-- happens; until step 4, research_cron answers 503 and says the token is
-- missing — it never reports a schedule it cannot keep.
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
  if to_regclass('public.game_research_state') is null then
    raise exception
      'Apply supabase/personal_research.sql first: research_cron reads game_research_state to know when the research state is due.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE SCHEDULER'S RECORD. One row. research_cron writes it on every tick
-- (what it decided and why) and on every dispatch (last_dispatch_at, which is
-- its debounce). Service role only: nothing a reader needs, and nothing a
-- reader may write, since a forged last_dispatch_at would silence the job.
-- ---------------------------------------------------------------------------
create table if not exists public.research_state_scheduler (
  id                    smallint primary key default 1 check (id = 1),
  scheduler_tick_at     timestamptz,
  scheduler_action      text,
  scheduler_reason      text,
  state_computed_at     timestamptz,
  next_kickoff_at       timestamptz,
  cadence_minutes       int,
  last_dispatch_at      timestamptz,
  last_dispatch_reason  text
);
alter table public.research_state_scheduler enable row level security;
revoke all on public.research_state_scheduler from anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.research_state_scheduler to service_role';
  end if;
end $g$;

-- The tick asks for the newest computed_at every five minutes.
create index if not exists game_research_state_computed_idx on public.game_research_state (computed_at desc);

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- THE JOB. Every five minutes; the function decides whether a run is due, so
-- the tick is cheap (three small reads and one upsert). Fire-and-forget:
-- pg_net queues the request and returns at once; thirty seconds leaves room
-- for a slow GitHub answer (pg_net's own default is five).
-- ---------------------------------------------------------------------------
select cron.unschedule('research_state_dispatch')
  where exists (select 1 from cron.job where jobname = 'research_state_dispatch');

select cron.schedule(
  'research_state_dispatch',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/research_cron',
      body                 := jsonb_build_object('source', 'supabase_cron'),
      headers              := jsonb_build_object('content-type', 'application/json'),
      timeout_milliseconds := 30000
    );
  $job$
);

-- THE REPORT. Every row should say ok. Whether the ticks ARRIVE is proven
-- five minutes later, not here:
--   select * from public.research_state_scheduler;
-- scheduler_tick_at within the last five minutes is a working scheduler;
-- still empty, look in net._http_response for a 404 (research_cron is not
-- deployed) or a 401 (it was deployed with JWT verification on).
with checks as (
  select 1 as n, 'the scheduler record is private (RLS on, no reader role can read or write it)' as check_name,
         (select count(*) from pg_class where oid = 'public.research_state_scheduler'::regclass and relrowsecurity)::int
         + (case when not has_table_privilege('anon', 'public.research_state_scheduler', 'select')
                  and not has_table_privilege('authenticated', 'public.research_state_scheduler', 'select')
                  and not has_table_privilege('anon', 'public.research_state_scheduler', 'insert')
                  and not has_table_privilege('authenticated', 'public.research_state_scheduler', 'update')
                 then 1 else 0 end) as got, 2 as want
  union all select 2, 'the research_state_dispatch job is scheduled every five minutes',
         (select count(*) from cron.job where jobname = 'research_state_dispatch' and schedule = '*/5 * * * *' and active)::int, 1
  union all select 3, 'the job calls research_cron with no key and no database setting',
         (select count(*) from cron.job where jobname = 'research_state_dispatch'
            and command like '%/functions/v1/research_cron%' and command not like '%current_setting%'
            and command not like '%authorization%')::int, 1
  union all select 4, 'game_research_state is indexed on computed_at (the tick''s one question)',
         (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'game_research_state_computed_idx')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;

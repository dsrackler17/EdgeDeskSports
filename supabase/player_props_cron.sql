-- ============================================================================
-- THE PRIMARY PLAYER PROPS SCHEDULER — pg_cron calling the props_cron edge
-- function every five minutes.
--
-- WHY NOT GITHUB ACTIONS. Because it does not fire. On 2026-09-29 the hourly
-- Player props workflow ran on schedule twice in eight hours (08:42 and
-- 15:59 UTC); the rest of the repository has shown the same multi-hour gaps
-- since 2026-09-13 (see editorial_cron.sql). A price that is worth something
-- only while it is minutes old cannot depend on it. GitHub's own cron stays in
-- player-props.yml as the BACKUP path.
--
-- WHAT THIS SCHEDULES. Not the capture — the POKE. props_cron reads
-- player_props_pipeline_health (supabase/player_props_pipeline.sql) and asks
-- GitHub to run player-props.yml only when a game is due for a price check
-- (each game's own cadence, or a failed game's back-off) or a reader asked for
-- a refresh. The capture, the board build and the commit stay in ONE pipeline;
-- this is one more, reliable, way to wake it.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS. Three of them are yours.
--
--   1  Enable pg_cron and pg_net (Database → Extensions).
--   2  Apply supabase/player_props_pipeline.sql, then deploy the function:
--          supabase functions deploy props_cron
--      (JWT verification stays ON: pg_cron sends the service key, the page
--      sends the reader's session.)
--   3  Give it a GitHub token with `actions:write` on this repository:
--          supabase secrets set PROPS_GH_TOKEN=github_pat_xxx
--      (EDITORIAL_GH_TOKEN is used when PROPS_GH_TOKEN is unset.)
--   4  Run this file. It reads the same two database settings as
--      editorial_cron.sql:
--          alter database postgres set edgedesk.project_url = 'https://<project>.supabase.co';
--          alter database postgres set edgedesk.service_key = '<service-role-key>';
--
-- Until step 3 is done the function answers 503 and says the token is
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
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb)') is null then
    raise exception
      'pg_net is not available. Enable it in the Supabase dashboard (Database → Extensions) before running this file.';
  end if;
  if to_regclass('public.player_props_pipeline_health') is null then
    raise exception
      'Apply supabase/player_props_pipeline.sql first: props_cron reads player_props_pipeline_health to know when a capture is due.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE JOB. Every five minutes: the tightest capture cadence is fifteen minutes
-- (inside ninety minutes of kickoff) and a failed game's first retry is five,
-- so a five-minute tick meets both. Fire-and-forget: pg_net queues the request
-- and returns at once. props_cron debounces against its own last dispatch and
-- the workflow's concurrency group serializes runs, so a duplicate poke costs
-- nothing.
-- ---------------------------------------------------------------------------
select cron.unschedule('player_props_dispatch')
  where exists (select 1 from cron.job where jobname = 'player_props_dispatch');

select cron.schedule(
  'player_props_dispatch',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url     := current_setting('edgedesk.project_url', true) || '/functions/v1/props_cron',
      headers := jsonb_build_object(
                   'content-type', 'application/json',
                   'authorization', 'Bearer ' || current_setting('edgedesk.service_key', true)
                 ),
      body    := jsonb_build_object('source', 'supabase_cron')
    );
  $job$
);

do $$
declare
  u text := current_setting('edgedesk.project_url', true);
  k text := current_setting('edgedesk.service_key', true);
begin
  raise notice '--- player props primary scheduler ---';
  raise notice '  job scheduled : %',
    case when exists (select 1 from cron.job where jobname = 'player_props_dispatch')
         then 'player_props_dispatch, */5 * * * *' else 'MISSING' end;
  raise notice '  project_url   : %', case when u is null or u = '' then 'NOT SET — the job will no-op' else u end;
  raise notice '  service_key   : %', case when k is null or k = '' then 'NOT SET — the job will no-op' else 'set' end;
  raise notice '  reminder      : supabase secrets set PROPS_GH_TOKEN=... , or the function returns 503';
end $$;

-- THE REPORT. Every row should say ok.
with checks as (
  select 1 as n, 'the player_props_dispatch job is scheduled every five minutes' as check_name,
         (select count(*) from cron.job where jobname = 'player_props_dispatch' and schedule = '*/5 * * * *')::int as got, 1 as want
  union all select 2, 'edgedesk.project_url is set',
         (case when coalesce(current_setting('edgedesk.project_url', true), '') = '' then 0 else 1 end), 1
  union all select 3, 'edgedesk.service_key is set',
         (case when coalesce(current_setting('edgedesk.service_key', true), '') = '' then 0 else 1 end), 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;

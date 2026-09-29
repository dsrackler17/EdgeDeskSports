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
-- OPERATOR STEPS.
--
--   1  Enable pg_cron and pg_net (Database → Extensions).
--   2  Apply supabase/player_props_pipeline.sql, then deploy the function with
--      JWT verification OFF:
--          supabase functions deploy props_cron --no-verify-jwt
--      (or Edge Functions → props_cron → turn off "Enforce JWT verification";
--      the Deploy player props pipeline workflow deploys it that way).
--   3  Give it a GitHub token with `actions:write` on this repository:
--          supabase secrets set PROPS_GH_TOKEN=github_pat_xxx
--      (EDITORIAL_GH_TOKEN is used when PROPS_GH_TOKEN is unset.)
--   4  Run this file. It needs no database setting and no key.
--
-- WHY JWT VERIFICATION IS OFF. On 2026-09-29 this project's gateway answered
-- every pg_cron poke carrying the anon key with 401 "Invalid JWT"
-- (UNAUTHORIZED_INVALID_JWT_FORMAT), with the key verified byte for byte, and
-- Supabase refuses `alter database postgres set edgedesk.*` ("permission
-- denied to set parameter"), so the settings this file used to read could
-- never be set. Same fix as capture (deploy-intelligence.yml). Nothing is
-- opened by it: the Refresh and status actions check the reader's session
-- themselves (getUser), and a tick only dispatches when a game is due, a
-- refresh is waiting or the health record has gone quiet, never inside the
-- four-minute debounce.
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
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception
      'pg_net is not available, or is an older build without net.http_post(url, body, params, headers, timeout). Enable or upgrade it in the Supabase dashboard (Database → Extensions).';
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
-- and returns at once; thirty seconds leaves room for a slow GitHub answer
-- (pg_net's own default is five). props_cron debounces against its own last
-- dispatch and the workflow's concurrency group serializes runs, so a
-- duplicate poke costs nothing.
-- ---------------------------------------------------------------------------
select cron.unschedule('player_props_dispatch')
  where exists (select 1 from cron.job where jobname = 'player_props_dispatch');

select cron.schedule(
  'player_props_dispatch',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url                  := 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/props_cron',
      body                 := jsonb_build_object('source', 'supabase_cron'),
      headers              := jsonb_build_object('content-type', 'application/json'),
      timeout_milliseconds := 30000
    );
  $job$
);

-- THE REPORT. Every row should say ok. Whether the ticks ARRIVE is proven
-- five minutes later, not here:
--   select league, scheduler_tick_at, scheduler_action, scheduler_reason
--   from player_props_pipeline_health;
-- scheduler_tick_at within the last five minutes is a working scheduler; still
-- empty, look for a 401 in net._http_response (JWT verification is still on).
with checks as (
  select 1 as n, 'the player_props_dispatch job is scheduled every five minutes' as check_name,
         (select count(*) from cron.job where jobname = 'player_props_dispatch' and schedule = '*/5 * * * *' and active)::int as got, 1 as want
  union all select 2, 'the job calls props_cron with no key and no database setting',
         (select count(*) from cron.job where jobname = 'player_props_dispatch'
            and command like '%/functions/v1/props_cron%' and command not like '%current_setting%')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by 1;

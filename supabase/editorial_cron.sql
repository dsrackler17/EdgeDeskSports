-- ============================================================================
-- THE PRIMARY EDITORIAL SCHEDULER — pg_cron calling the editorial_cron edge
-- function every ten minutes.
--
-- WHY NOT GITHUB ACTIONS. Because it does not fire. On 2026-09-13 the
-- editorial workflow logged zero scheduled runs between 12:58 and 17:03 across
-- two different cron expressions, while every other scheduled workflow in the
-- repository showed the same ~4.5 hour gap (settle-finals is hourly and went
-- 11:24 to 15:54). GitHub's scheduler is degraded for this repository. A
-- publisher that must notice a twenty-to-ninety-minute window cannot be built
-- on it, and GitHub Actions stays as the BACKUP rather than the only path.
--
-- WHAT THIS SCHEDULES. Not the pipeline — the POKE. The edge function asks
-- GitHub to run the existing workflow, because the pipeline boots the real
-- football module out of app.html and commits to the git repository, neither
-- of which an edge runtime can do. One canonical dispatcher, several ways to
-- wake it.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS. This file cannot complete itself; two of them are yours.
--
--   1  Enable the extensions (Supabase dashboard → Database → Extensions,
--      or the statements below if your project allows it):
--          pg_cron   scheduling
--          pg_net    outbound HTTP from the database
--
--   2  Deploy the function:
--          supabase functions deploy editorial_cron --no-verify-jwt
--
--   3  Give it a GitHub token with `actions:write` on the repository:
--          supabase secrets set EDITORIAL_GH_TOKEN=ghp_xxx
--      A fine-grained token scoped to this one repository with only
--      "Actions: read and write" is enough. Nothing else here needs it, and
--      the token never reaches the browser or the repository.
--
--   4  Run this file, having set the two settings below.
--
-- Until step 3 is done the function returns 503 and says the token is missing,
-- rather than reporting success while scheduling nothing.
-- ---------------------------------------------------------------------------
-- Idempotent: re-running replaces the schedule rather than adding a second.
-- ============================================================================

-- These are read by the job body below. Set them for the session before
-- running this file, or edit the two literals in the schedule.
--   \set edgedesk_project_url 'https://<project>.supabase.co'
--   \set edgedesk_service_key '<service-role-key>'

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
end $$;

-- ---------------------------------------------------------------------------
-- THE JOB. Every ten minutes, which is inside the twenty-minute minimum
-- publish lead, so a game entering its late window is noticed with time to
-- refresh and publish before the final hold.
--
-- The call is fire-and-forget by design: pg_net queues the request and returns
-- immediately, so a slow GitHub API can never hold a database worker open.
-- The edge function debounces against the heartbeat table, and the dispatcher
-- holds a lease, so a duplicate poke costs nothing.
-- ---------------------------------------------------------------------------
select cron.unschedule('editorial_dispatch')
  where exists (select 1 from cron.job where jobname = 'editorial_dispatch');

select cron.schedule(
  'editorial_dispatch',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url     := current_setting('edgedesk.project_url', true) || '/functions/v1/editorial_cron',
      headers := jsonb_build_object(
                   'content-type', 'application/json',
                   'authorization', 'Bearer ' || current_setting('edgedesk.service_key', true)
                 ),
      body    := jsonb_build_object('source', 'supabase_cron')
    );
  $job$
);

-- The two settings the job body reads. ALTER DATABASE so they survive a
-- restart; the service key lives in the database rather than in this file.
--
--   alter database postgres set edgedesk.project_url = 'https://<project>.supabase.co';
--   alter database postgres set edgedesk.service_key = '<service-role-key>';
--
-- Deliberately not set here: committing a service key to a git repository is
-- exactly the mistake this system is otherwise careful to avoid.

do $$
declare
  u text := current_setting('edgedesk.project_url', true);
  k text := current_setting('edgedesk.service_key', true);
begin
  raise notice '--- editorial primary scheduler ---';
  raise notice '  job scheduled : %',
    case when exists (select 1 from cron.job where jobname = 'editorial_dispatch')
         then 'editorial_dispatch, */10 * * * *' else 'MISSING' end;
  raise notice '  project_url   : %', case when u is null or u = '' then 'NOT SET — the job will no-op' else u end;
  raise notice '  service_key   : %', case when k is null or k = '' then 'NOT SET — the job will no-op' else 'set' end;
  raise notice '  reminder      : supabase secrets set EDITORIAL_GH_TOKEN=... , or the function returns 503';
end $$;

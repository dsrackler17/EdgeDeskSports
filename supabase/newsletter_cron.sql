-- ============================================================================
-- THE PRIMARY NEWSLETTER SCHEDULER — pg_cron calling the newsletter_cron edge
-- function across the hours the two editions can fall in.
--
-- WHY THE CRON LINE IS NOT THE SCHEDULE. The editions are due at 10:00
-- America/Chicago, which is 15:00 UTC for most of the year and 16:00 UTC
-- between November and March. A cron expression is a fixed UTC instant, so no
-- single line is right all season and a line per half is a thing somebody has
-- to remember to change twice a year.
--
-- So this fires OFTEN across the plausible window and lets the pipeline decide.
-- tools/newsletter/schedule.js converts the Chicago wall clock to an instant
-- with the zone database and answers "is an edition owed?"; a tick with
-- nothing owed reads a few files, writes a held row and exits. Daylight saving
-- is then a property of the zone database rather than of anybody's memory.
--
-- MONDAY AND TUESDAY ONLY, 13:00–19:00 UTC. That covers 08:00–13:00 Central in
-- winter and 07:00–14:00 in summer: the 10:00 send and its four-hour retry
-- window in both, with margin at each end.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS. This file cannot complete itself; three of them are yours.
--
--   1  Enable the extensions (Supabase dashboard -> Database -> Extensions):
--          pg_cron   scheduling
--          pg_net    outbound HTTP from the database
--
--   2  Deploy the function:
--          supabase functions deploy newsletter_cron --no-verify-jwt
--
--   3  Give it a GitHub token with `actions:write` on the repository:
--          supabase secrets set NEWSLETTER_GH_TOKEN=ghp_xxx
--      A fine-grained token scoped to this one repository with only
--      "Actions: read and write" is enough. It never reaches the browser or
--      the repository.
--
--   4  Set the two database settings the job body reads, then run this file:
--          alter database postgres set edgedesk.project_url = 'https://<project>.supabase.co';
--          alter database postgres set edgedesk.service_key = '<service-role-key>';
--
-- Until step 3 is done the function returns 503 and says the token is missing,
-- rather than reporting success while scheduling nothing.
-- ---------------------------------------------------------------------------
-- Idempotent: re-running replaces the schedule rather than adding a second.
-- No psql meta-commands: this is pasted into the SQL editor.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception
      'pg_cron is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb)') is null then
    raise exception
      'pg_net is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
  if to_regclass('public.newsletter_settings') is null then
    raise exception 'run supabase/newsletter.sql first';
  end if;
end $$;

select cron.unschedule('newsletter_dispatch')
  where exists (select 1 from cron.job where jobname = 'newsletter_dispatch');

-- Minute 9 and 29 and 49 rather than 0, 20, 40: GitHub's own documentation
-- names the start of every hour as the worst time for a scheduled event, and
-- the same stampede reaches the API this pokes.
select cron.schedule(
  'newsletter_dispatch',
  '9,29,49 13-19 * * 1,2',
  $job$
    select net.http_post(
      url     := current_setting('edgedesk.project_url', true) || '/functions/v1/newsletter_cron',
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
  raise notice '--- newsletter primary scheduler ---';
  raise notice '  job scheduled : %',
    case when exists (select 1 from cron.job where jobname = 'newsletter_dispatch')
         then 'newsletter_dispatch, 9,29,49 13-19 * * 1,2 (UTC)' else 'MISSING' end;
  raise notice '  project_url   : %', case when u is null or u = '' then 'NOT SET — the job will no-op' else u end;
  raise notice '  service_key   : %', case when k is null or k = '' then 'NOT SET — the job will no-op' else 'set' end;
  raise notice '  reminder      : supabase secrets set NEWSLETTER_GH_TOKEN=... , or the function returns 503';
  raise notice '  reminder      : sending stays OFF until newsletter_settings.sending_enabled is true';
end $$;

select 1 as step, 'the newsletter schema is installed' as check,
  case when to_regclass('public.newsletter_settings') is not null then 'ok' else 'CHECK THIS' end as outcome
union all select 2, 'the dispatch job exists',
  case when exists (select 1 from cron.job where jobname = 'newsletter_dispatch') then 'ok' else 'CHECK THIS' end
union all select 3, 'the job body has a project url to call',
  case when coalesce(current_setting('edgedesk.project_url', true), '') <> '' then 'ok'
       else 'CHECK THIS — alter database postgres set edgedesk.project_url = ...' end
union all select 4, 'the job body has a service key',
  case when coalesce(current_setting('edgedesk.service_key', true), '') <> '' then 'ok'
       else 'CHECK THIS — alter database postgres set edgedesk.service_key = ...' end
order by 1;

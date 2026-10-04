-- ============================================================================
-- THE PRIMARY EDITORIAL SCHEDULER, WITHOUT AN EDGE FUNCTION.
--
-- supabase/editorial_cron.sql schedules an edge function that pokes GitHub.
-- That works, but deploying it needs the Supabase CLI (`supabase functions
-- deploy`) and a CLI-set secret, neither of which can be done from the SQL
-- editor. This file does the same job entirely in Postgres: the pause check,
-- the debounce and the GitHub poke are all pg_net + plpgsql.
--
-- USE ONE OR THE OTHER, not both. They are not harmful together — the poke is
-- debounced here and the dispatcher holds a lease besides — but two schedulers
-- doing the same thing is just noise in the logs.
--
-- WHAT IT STILL DOES NOT DO, and cannot: run the editorial pipeline. The
-- pipeline boots the football module out of app.html in a Node VM and commits
-- to the git repository. Postgres can do neither. This POKES the one canonical
-- dispatcher — `editorial.yml` — exactly as the edge function does. One
-- pipeline, one publisher, several ways to wake it.
--
-- ---------------------------------------------------------------------------
-- EVERYTHING BELOW RUNS IN THE SUPABASE SQL EDITOR. There are three steps and
-- the first two are one statement each.
--
--   1  Enable the extensions, if they are not already on:
--          create extension if not exists pg_cron;
--          create extension if not exists pg_net;
--      (Dashboard → Database → Extensions also works.)
--
--   2  Store the GitHub token. A fine-grained PAT scoped to this one
--      repository with "Actions: read and write" is enough; nothing else here
--      needs it and it never reaches a browser.
--
--          select vault.create_secret(
--            'ghp_xxxxxxxxxxxxxxxxxxxx',   -- the token
--            'edgedesk_gh_token',          -- the name this file looks for
--            'GitHub PAT with actions:write, used to dispatch editorial.yml'
--          );
--
--      Supabase Vault encrypts it at rest and keeps it out of table dumps.
--      To rotate later:
--          select vault.update_secret(
--            (select id from vault.secrets where name = 'edgedesk_gh_token'),
--            'ghp_newtoken'
--          );
--
--      If this project has no Vault, the fallback is a database setting:
--          alter database postgres set edgedesk.gh_token = 'ghp_xxx';
--      then reconnect. The function reads Vault first and falls back to that.
--
--   3  Run this whole file.
--
-- Nothing here stores a secret in the repository, which is the one mistake
-- this system is otherwise careful to avoid.
-- ---------------------------------------------------------------------------
-- Idempotent: re-running replaces the function and the schedule rather than
-- adding a second of either.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception
      'pg_cron is not available. Enable it in the Supabase dashboard (Database -> Extensions) before running this file.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception
      'pg_net is not available, or is an older build without net.http_post(url, body, params, headers, timeout). Enable or upgrade it in the Supabase dashboard (Database -> Extensions).';
  end if;
  if to_regclass('public.editorial_settings') is null
     or to_regclass('public.editorial_heartbeats') is null then
    raise exception
      'editorial_dispatch_sql.sql needs public.editorial_settings and public.editorial_heartbeats; run supabase/editorial_runtime.sql first';
  end if;
end $$;

-- --------------------------------------------------------------- the poke ---
-- Returns jsonb rather than void so that running it by hand in the SQL editor
-- tells you what it decided and why. The shape matches the edge function's
-- result, so health and the operator console read the same vocabulary either
-- way: dispatched | debounced | paused | no_token | error.
--
-- pg_net is FIRE AND FORGET. It queues the request and returns a request id
-- immediately, so a slow GitHub API can never hold a database worker open. The
-- response lands in net._http_response; the file footer has the query.
create or replace function public.editorial_poke(
  p_source           text    default 'supabase_cron',
  p_debounce_seconds integer default 300,
  p_repo             text    default 'dsrackler17/EdgeDeskSports',
  p_workflow         text    default 'editorial.yml',
  p_ref              text    default 'main'
) returns jsonb
language plpgsql
security definer
set search_path = public, net, vault, pg_temp
as $fn$
declare
  v_enabled   boolean := true;
  v_token     text;
  v_recent    record;
  v_request   bigint;
begin
  -- THE OPERATOR'S PAUSE IS HONOURED HERE TOO, not only inside the pipeline.
  -- A missing settings row is not a pause: a fresh install should schedule.
  select dispatcher_enabled into v_enabled
    from public.editorial_settings where id = 1;
  if v_enabled is false then
    return jsonb_build_object(
      'ok', true, 'action', 'paused',
      'reason', 'dispatcher_enabled is false');
  end if;

  -- DO NOT STAMPEDE. A run already in flight needs no second one. The
  -- dispatcher's lease makes a duplicate safe; this makes it unnecessary.
  select id, started_at, scheduler_source into v_recent
    from public.editorial_heartbeats
   where started_at >= now() - make_interval(secs => p_debounce_seconds)
   order by started_at desc
   limit 1;
  if found then
    return jsonb_build_object(
      'ok', true, 'action', 'debounced',
      'reason', format('a dispatcher run started at %s (%s), inside the %ss debounce',
                       v_recent.started_at, v_recent.scheduler_source, p_debounce_seconds));
  end if;

  -- THE TOKEN. Vault first, then a database setting.
  begin
    select decrypted_secret into v_token
      from vault.decrypted_secrets where name = 'edgedesk_gh_token';
  exception when others then
    v_token := null;                       -- no Vault in this project
  end;
  if v_token is null or v_token = '' then
    v_token := nullif(current_setting('edgedesk.gh_token', true), '');
  end if;

  -- A MISSING TOKEN IS NOT A SUCCESS. Returning ok here would leave a
  -- permanently unscheduled system looking healthy, which is the exact failure
  -- this scheduler exists to remove. The warning reaches the Postgres logs so
  -- it is visible even when nobody is reading the return value.
  if v_token is null then
    raise warning 'editorial_poke: no GitHub token. Set vault secret edgedesk_gh_token, or edgedesk.gh_token. Nothing was dispatched.';
    return jsonb_build_object(
      'ok', false, 'action', 'no_token',
      'reason', 'no edgedesk_gh_token in vault and no edgedesk.gh_token setting, so the dispatcher cannot be invoked');
  end if;

  -- POKE THE ONE CANONICAL DISPATCHER.
  -- `source` is recorded on the run's heartbeat, so health can tell the
  -- primary scheduler apart from GitHub's own triggers. editorial.yml has
  -- accepted this input since the primary scheduler shipped; a workflow older
  -- than that answers 422 "Unexpected inputs provided", which the footer
  -- query will show you.
  select net.http_post(
    url     := format('https://api.github.com/repos/%s/actions/workflows/%s/dispatches',
                      p_repo, p_workflow),
    body    := jsonb_build_object('ref', p_ref,
                                  'inputs', jsonb_build_object('source', p_source)),
    headers := jsonb_build_object(
                 'authorization', 'Bearer ' || v_token,
                 'accept',        'application/vnd.github+json',
                 'content-type',  'application/json',
                 'user-agent',    'edgedesk-editorial-cron'),
    timeout_milliseconds := 10000
  ) into v_request;

  return jsonb_build_object(
    'ok', true, 'action', 'dispatched',
    'reason', format('%s dispatched on %s as %s', p_workflow, p_ref, p_source),
    'request_id', v_request);
exception when others then
  return jsonb_build_object(
    'ok', false, 'action', 'error', 'reason', sqlerrm);
end;
$fn$;

-- THE FUNCTION READS A GITHUB TOKEN AND CAN START A WORKFLOW, and it is
-- security definer, so it must not be reachable from a browser. Same treatment
-- as editorial_claim(): the schedule calls it as the job owner, nobody else
-- calls it at all.
revoke all on function public.editorial_poke(text, integer, text, text, text)
  from public, anon, authenticated;

comment on function public.editorial_poke(text, integer, text, text, text) is
  'Wakes the editorial dispatcher by asking GitHub to run editorial.yml. Honours dispatcher_enabled, debounces against editorial_heartbeats, and reports a missing token rather than returning success. Never runs the pipeline itself.';

-- ------------------------------------------------------------- the schedule --
-- EVERY TEN MINUTES, which is inside the twenty-minute minimum publish lead,
-- so a game entering its late window is noticed with time to refresh and
-- publish before the final hold.
select cron.unschedule('editorial_dispatch_sql')
  where exists (select 1 from cron.job where jobname = 'editorial_dispatch_sql');

select cron.schedule(
  'editorial_dispatch_sql',
  '*/10 * * * *',
  $job$ select public.editorial_poke('supabase_cron'); $job$
);

-- ------------------------------------------------------------------ report --
do $$
declare
  v_has_vault  boolean := false;
  v_has_set    boolean := nullif(current_setting('edgedesk.gh_token', true), '') is not null;
begin
  begin
    select exists (select 1 from vault.decrypted_secrets where name = 'edgedesk_gh_token')
      into v_has_vault;
  exception when others then v_has_vault := false;
  end;

  raise notice '--- editorial primary scheduler (SQL, no edge function) ---';
  raise notice '  job scheduled : %',
    case when exists (select 1 from cron.job where jobname = 'editorial_dispatch_sql')
         then 'editorial_dispatch_sql, */10 * * * *' else 'MISSING' end;
  raise notice '  github token  : %',
    case when v_has_vault then 'vault secret edgedesk_gh_token'
         when v_has_set   then 'edgedesk.gh_token database setting'
         else 'NOT SET -- every tick will return no_token and dispatch nothing' end;
  raise notice '  edge function : not required by this file';
  raise notice '';
  raise notice '  Test it now        select public.editorial_poke(''manual'');';
  raise notice '  See GitHub''s reply select status_code, content from net._http_response order by id desc limit 1;';
end $$;

-- ---------------------------------------------------------------------------
-- VERIFYING IT, all from the SQL editor.
--
--   -- 1. poke by hand; expect {"ok": true, "action": "dispatched", ...}
--   select public.editorial_poke('manual');
--
--   -- 2. what GitHub actually said. 204 is success and has an empty body.
--   --    401/403 = bad or unscoped token. 404 = wrong repo or workflow name.
--   --    422 = the workflow on that ref does not accept the `source` input.
--   select id, status_code, content, error_msg, created
--     from net._http_response order by id desc limit 5;
--
--   -- 3. is the schedule actually running, and did its runs succeed?
--   select jobid, jobname, schedule, active from cron.job
--    where jobname = 'editorial_dispatch_sql';
--
--   select start_time, status, return_message
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'editorial_dispatch_sql')
--    order by start_time desc limit 10;
--
--   -- 4. is the pipeline reporting back? Every run writes one row, including
--   --    runs that found nothing to do — that is how "no scheduler is running"
--   --    is told apart from "there was no work".
--   select scheduler_source, started_at, ok, actions_executed
--     from public.editorial_heartbeats order by started_at desc limit 10;
--
-- TURNING IT OFF.
--   select cron.unschedule('editorial_dispatch_sql');          -- stop the poke
--   update public.editorial_settings set dispatcher_enabled = false where id = 1;
--                                                              -- or pause it
-- ---------------------------------------------------------------------------

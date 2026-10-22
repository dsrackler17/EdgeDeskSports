-- ============================================================================
-- THE PRIMARY COLLEGE BASEBALL SCHEDULER — pg_cron asking GitHub to run the
-- college baseball and collegiate workflows, entirely in SQL (the pattern of
-- supabase/editorial_dispatch_sql.sql: no edge function, nothing to deploy).
--
-- WHY NOT GITHUB ACTIONS. Because it does not fire. On 2026-10-22 the daily
-- collegiate backfill (09:17 UTC) and the weekly college baseball loop
-- (Thursday 13:13 UTC) never ran on their schedules, and Model loop health,
-- scheduled every 3 hours, ran at 17:03, 21:31, 04:25 and 11:37: the gaps every
-- scheduled workflow here has shown since 2026-09-13 (player_props_cron.sql,
-- research_state_cron.sql). A closing price must be minutes old at first
-- pitch (EXPERIMENTS.md CBASE-H1: no more than 60), and a capture that runs
-- every five hours keeps almost none. GitHub's own cron stays in each workflow
-- as the BACKUP, later in the day, and each job skips a run it does not need:
-- the price job when its last capture is under 55 minutes old, the backfill
-- when today's slice has run, the loop when this week's record exists.
--
-- WHAT IT SCHEDULES (UTC; Supabase's pg_cron runs in UTC):
--   cbase_prices         24 14-23,0-4 * 2-6 *   college-baseball-prices.yml: hourly, 14:24 to 04:24,
--                                                 February to June. Nothing that can reach a paid path
--                                                 runs more often than hourly (the operator's rule since
--                                                 2026-10-21, docs/odds-api-incident-2026-10/INCIDENT.md).
--                                                 Not woken while the Odds API breaker is off; the job
--                                                 itself does nothing unless CBASE_PRICES is on and the
--                                                 gateway's baseball_ncaa row is enabled.
--   cbase_build          23 11 * 2-6 *          college-baseball-research-build.yml: daily, in season
--   collegiate_backfill  17 9 * * *             collegiate-backfill.yml: daily
--   collegiate_rosters   41 7 * * 1             collegiate-rosters.yml: Monday
--   cbase_loop           13 13 * * 4            model-loop-college-baseball.yml (mode research): Thursday.
--                                                 Never `release`: serving a version stays the owner's.
--
-- ---------------------------------------------------------------------------
-- OPERATOR STEPS (the SQL editor).
--
--   1  pg_cron and pg_net on (Database → Extensions). Already on if
--      capture_cron.sql or editorial_dispatch_sql.sql has been run.
--   2  The GitHub token: the Vault secret edgedesk_gh_token, the same one
--      supabase/editorial_dispatch_sql.sql reads, so nothing new if that is
--      set. Otherwise a fine-grained PAT on this repository with "Actions:
--      read and write":
--          select vault.create_secret('github_pat_xxx', 'edgedesk_gh_token',
--            'GitHub PAT with actions:write, used to dispatch workflows');
--   3  Run this whole file. Its last statement reports each piece.
--
-- Until step 2 is done every tick returns no_token, with a warning in the
-- Postgres log, and nothing is dispatched: it never reports a schedule it
-- cannot keep. Idempotent: re-running replaces the function and the five jobs
-- rather than adding more.
--
-- To stop one:   select cron.unschedule('cbase_prices');
-- To stop all:   select cron.unschedule(jobname) from cron.job where jobname in
--                  ('cbase_prices', 'cbase_build', 'collegiate_backfill', 'collegiate_rosters', 'cbase_loop');
-- What GitHub answered: select id, status_code, content from net._http_response order by id desc limit 10;
--   (204 = dispatched; 401/403 = the token; 404 = the workflow or the token's repository access;
--    422 = an input the workflow does not declare)
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- pg_net is fire and forget: the request is queued and its id returned, so a
-- slow GitHub API never holds a database worker. The answer lands in
-- net._http_response.
create or replace function public.cbase_poke(
  p_workflow text,
  p_inputs   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, net, vault, pg_temp
as $fn$
declare
  v_token   text;
  v_request bigint;
begin
  -- ONLY THESE WORKFLOWS: the token can start any workflow in the repository,
  -- and this function starts college baseball's and the collector's, no other.
  if p_workflow is null or p_workflow not in ('college-baseball-prices.yml', 'college-baseball-research-build.yml',
       'collegiate-backfill.yml', 'collegiate-rosters.yml', 'model-loop-college-baseball.yml') then
    return jsonb_build_object('ok', false, 'action', 'refused',
      'reason', format('%s is not a college baseball workflow', coalesce(p_workflow, 'null')));
  end if;
  if p_workflow = 'model-loop-college-baseball.yml' and coalesce(p_inputs->>'mode', 'research') <> 'research' then
    return jsonb_build_object('ok', false, 'action', 'refused',
      'reason', 'the loop is only ever woken to research; release is the owner''s, by hand');
  end if;

  -- THE ODDS API BREAKER (supabase/odds_api_gateway.sql). Off, the gateway
  -- refuses every board anyway; not waking the price job saves the run.
  if p_workflow = 'college-baseball-prices.yml' and to_regprocedure('public.odds_api_enabled()') is not null then
    if not public.odds_api_enabled() then
      return jsonb_build_object('ok', true, 'action', 'paused',
        'reason', 'odds_api_enabled is false: the price job is not woken');
    end if;
  end if;

  -- THE TOKEN. Vault first, then a database setting.
  begin
    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'edgedesk_gh_token';
  exception when others then
    v_token := null;                       -- no Vault in this project
  end;
  if v_token is null or v_token = '' then
    v_token := nullif(current_setting('edgedesk.gh_token', true), '');
  end if;
  -- A MISSING TOKEN IS NOT A SUCCESS: a permanently unscheduled job that looks
  -- healthy is the failure this scheduler exists to remove.
  if v_token is null then
    raise warning 'cbase_poke: no GitHub token. Set vault secret edgedesk_gh_token. Nothing was dispatched.';
    return jsonb_build_object('ok', false, 'action', 'no_token',
      'reason', 'no edgedesk_gh_token in vault and no edgedesk.gh_token setting, so nothing was dispatched');
  end if;

  select net.http_post(
    url     := format('https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/%s/dispatches', p_workflow),
    body    := jsonb_build_object('ref', 'main', 'inputs', coalesce(p_inputs, '{}'::jsonb)),
    headers := jsonb_build_object(
                 'authorization', 'Bearer ' || v_token,
                 'accept',        'application/vnd.github+json',
                 'content-type',  'application/json',
                 'user-agent',    'edgedesk-cbase-cron'),
    timeout_milliseconds := 10000
  ) into v_request;

  return jsonb_build_object('ok', true, 'action', 'dispatched',
    'reason', format('%s dispatched on main', p_workflow), 'request_id', v_request);
exception when others then
  return jsonb_build_object('ok', false, 'action', 'error', 'reason', sqlerrm);
end;
$fn$;

-- IT READS A GITHUB TOKEN AND CAN START A WORKFLOW, and it is security
-- definer: never reachable from a browser. The schedule calls it as the job
-- owner; nobody else calls it at all.
revoke all on function public.cbase_poke(text, jsonb) from public, anon, authenticated;

comment on function public.cbase_poke(text, jsonb) is
  'Asks GitHub to run one of the college baseball or collegiate workflows on main. Refuses any other workflow and any loop mode but research, honours the Odds API breaker for the price job, and reports a missing token rather than returning success. Never runs a job itself.';

-- ------------------------------------------------------------- the schedule --
do $s$
declare j record;
begin
  for j in select * from (values
      ('cbase_prices',        '24 14-23,0-4 * 2-6 *', $c$select public.cbase_poke('college-baseball-prices.yml')$c$),
      ('cbase_build',         '23 11 * 2-6 *',        $c$select public.cbase_poke('college-baseball-research-build.yml')$c$),
      ('collegiate_backfill', '17 9 * * *',           $c$select public.cbase_poke('collegiate-backfill.yml')$c$),
      ('collegiate_rosters',  '41 7 * * 1',           $c$select public.cbase_poke('collegiate-rosters.yml')$c$),
      ('cbase_loop',          '13 13 * * 4',          $c$select public.cbase_poke('model-loop-college-baseball.yml', '{"mode":"research"}'::jsonb)$c$)
    ) as t(name, schedule, command)
  loop
    perform cron.unschedule(c.jobname) from cron.job c where c.jobname = j.name;
    perform cron.schedule(j.name, j.schedule, j.command);
  end loop;
end
$s$;

-- ------------------------------------------------------------- the report --
create or replace function public.cbase_cron_report()
returns table (piece text, state text)
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $fn$
declare v_token boolean := false;
begin
  begin
    select exists (select 1 from vault.decrypted_secrets where name = 'edgedesk_gh_token' and coalesce(decrypted_secret, '') <> '') into v_token;
  exception when others then
    v_token := false;
  end;
  v_token := v_token or coalesce(nullif(current_setting('edgedesk.gh_token', true), ''), '') <> '';
  return query
  select '1 cbase_poke exists and no browser can call it'::text,
         case when to_regprocedure('public.cbase_poke(text, jsonb)') is not null
               and not has_function_privilege('anon', 'public.cbase_poke(text, jsonb)', 'execute')
               and not has_function_privilege('authenticated', 'public.cbase_poke(text, jsonb)', 'execute')
              then 'ok' else 'CHECK THIS' end
  union all
  select '2 five jobs scheduled, the price job hourly',
         case when (select count(*) from cron.job where jobname in ('cbase_prices', 'cbase_build', 'collegiate_backfill', 'collegiate_rosters', 'cbase_loop')) = 5
               and (select schedule from cron.job where jobname = 'cbase_prices') ~ '^[0-9]+ '
              then 'ok' else 'CHECK THIS' end
  union all
  select '3 the GitHub token (vault edgedesk_gh_token)',
         case when v_token then 'ok' else 'pending: step 2, nothing is dispatched until it is set' end;
end;
$fn$;
revoke all on function public.cbase_cron_report() from public, anon, authenticated;

select piece, state from public.cbase_cron_report() order by piece;

-- cfb_weekly -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- The current (newest) team state of every team and week.
create or replace view public.cfb_team_week_state_current as
select distinct on (s.team_id, s.season, s.week, s.feature_version) s.*
  from public.cfb_team_week_state s
 order by s.team_id, s.season, s.week, s.feature_version, s.state_version desc;

-- The latest run per season and mode.
create or replace view public.cfb_pipeline_latest as
select distinct on (r.season, r.mode) r.*
  from public.cfb_pipeline_runs r
 order by r.season, r.mode, r.started_at desc;

do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.cfb_team_week_state_current to authenticated';
    execute 'grant select on public.cfb_pipeline_latest to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.cfb_team_week_state_current from anon';
    execute 'revoke all on public.cfb_pipeline_latest from anon';
  end if;
end $blk$;

-- ======================================================== the dispatcher
-- Asks GitHub to run .github/workflows/cfb-v2-shadow.yml on main with
-- inputs.mode = p_mode (weekly | daily | freeze). Returns what it did:
-- dispatched | no_token | error. pg_net is fire and forget; GitHub's answer
-- lands in net._http_response (204 accepted; 401/403 token; 422 bad input).
do $blk$
begin
  begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
      execute 'create extension if not exists pg_cron';
    end if;
  exception when others then
    raise notice 'cfb_weekly: pg_cron could not be enabled here (%); the schedule is skipped', sqlerrm;
  end;
  begin
    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      execute 'create extension if not exists pg_net';
    end if;
  exception when others then
    raise notice 'cfb_weekly: pg_net could not be enabled here (%); the dispatch is skipped', sqlerrm;
  end;
end $blk$;

create or replace function public.cfb_weekly_poke(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_token text;
  v_req   bigint;
begin
  if p_mode is null or p_mode not in ('weekly','daily','freeze') then
    return jsonb_build_object('ok', false, 'action', 'error', 'reason', 'mode must be weekly, daily or freeze');
  end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_token using 'edgedesk_gh_token';
  exception when others then
    v_token := null;
  end;
  if v_token is null then
    v_token := nullif(current_setting('edgedesk.gh_token', true), '');
  end if;
  if v_token is null then
    raise warning 'cfb_weekly_poke: no GitHub token. Set vault secret edgedesk_gh_token. Nothing was dispatched.';
    return jsonb_build_object('ok', false, 'action', 'no_token',
      'reason', 'no edgedesk_gh_token in vault and no edgedesk.gh_token setting');
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return jsonb_build_object('ok', false, 'action', 'error', 'reason', 'pg_net is not installed');
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    into v_req
    using 'https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/cfb-v2-shadow.yml/dispatches',
          jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('mode', p_mode)),
          jsonb_build_object('accept', 'application/vnd.github+json', 'authorization', 'Bearer ' || v_token,
                             'x-github-api-version', '2022-11-28', 'user-agent', 'edgedesk-cfb-weekly');
  return jsonb_build_object('ok', true, 'action', 'dispatched', 'mode', p_mode, 'request_id', v_req);
exception when others then
  return jsonb_build_object('ok', false, 'action', 'error', 'reason', sqlerrm);
end $fn$;

revoke all on function public.cfb_weekly_poke(text) from public;
do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.cfb_weekly_poke(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.cfb_weekly_poke(text) from authenticated';
  end if;
end $blk$;

-- The schedule (UTC, August through January): weekly state after the
-- Saturday slate (Sun, Mon 10:05), the EARLY freeze (Tue 12:07, after the
-- 12:00 freeze instant), and a daily football-change check (10:47).
do $blk$
declare
  v_has_cron boolean := to_regprocedure('cron.schedule(text,text,text)') is not null and to_regclass('cron.job') is not null;
  v_has_net  boolean := to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null;
  j record;
begin
  if not v_has_cron then
    raise notice 'cfb_weekly: pg_cron is not available: no job was scheduled (skipped)';
    return;
  end if;
  for j in select * from (values
      ('cfb_weekly_sunday', '5 10 * 8-12,1 0', 'select public.cfb_weekly_poke(''weekly'');'),
      ('cfb_weekly_monday', '5 10 * 8-12,1 1', 'select public.cfb_weekly_poke(''weekly'');'),
      ('cfb_weekly_freeze', '7 12 * 8-12,1 2', 'select public.cfb_weekly_poke(''freeze'');'),
      ('cfb_weekly_daily',  '47 10 * 8-12,1 3-6', 'select public.cfb_weekly_poke(''daily'');')
    ) as v(name, sched, cmd)
  loop
    if exists (select 1 from cron.job where jobname = j.name) then
      execute 'select cron.unschedule($1)' using j.name;
    end if;
    if v_has_net then
      execute 'select cron.schedule($1, $2, $3)' using j.name, j.sched, j.cmd;
    end if;
  end loop;
  if not v_has_net then
    raise notice 'cfb_weekly: pg_net is not available: no dispatch job was scheduled (skipped)';
  end if;
end $blk$;

notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_pipeline_runs'),('cfb_pipeline_stage_log'),('cfb_game_validation'),('cfb_game_performance'),
         ('cfb_team_week_state'),('cfb_qb_week_state'),('cfb_unit_week_state'),('cfb_qb_events'),
         ('cfb_upcoming_game_features'),('cfb_weekly_projections'),('cfb_projection_changes'),
         ('cfb_weekly_research'),('cfb_source_health'),('cfb_weekly_misses')
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only, row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg where tg.tgrelid = to_regclass('public.' || t)
                     and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'exactly-once keys (team, QB, unit state; features; projections)',
         case when to_regclass('public.cfb_team_week_state_key') is not null
               and to_regclass('public.cfb_qb_week_state_key') is not null
               and to_regclass('public.cfb_unit_week_state_key') is not null
               and to_regclass('public.cfb_upcoming_features_key') is not null
               and to_regclass('public.cfb_weekly_projections_key') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'views: cfb_team_week_state_current, cfb_pipeline_latest',
         case when to_regclass('public.cfb_team_week_state_current') is not null
               and to_regclass('public.cfb_pipeline_latest') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'dispatcher cfb_weekly_poke(mode)',
         case when to_regprocedure('public.cfb_weekly_poke(text)') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'schedule (needs pg_cron + pg_net + vault edgedesk_gh_token)',
         case when to_regclass('cron.job') is null then 'skipped: pg_cron not installed'
              else 'see cron.job for cfb_weekly_sunday/monday/freeze/daily' end
) r
order by ord, check_name;


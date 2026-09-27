-- cfb_production -- part 5 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ============================================================ health
create or replace function public.cfb_prod_age_status(p_age_min numeric, p_source text, p_applies boolean)
returns text language sql stable
set search_path = pg_catalog, pg_temp
as $fn$
  select case when not p_applies then 'OK'
              when p_age_min is null then 'CRITICAL'
              when p_age_min >= (select f.critical_minutes from public.cfb_freshness_rules f where f.source = p_source) then 'CRITICAL'
              when p_age_min >= (select f.warn_minutes from public.cfb_freshness_rules f where f.source = p_source) then 'WARNING'
              else 'OK' end
$fn$;

create or replace function public.cfb_health(p_now timestamptz default now())
returns table (check_name text, status text, detail text, observed jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_in_season boolean := extract(month from p_now at time zone 'UTC')::int in (8, 9, 10, 11, 12, 1);
  v_ts        timestamptz;
  v_ts2       timestamptz;
  v_n         bigint;
  v_n2        bigint;
  v_txt       text;
  v_age       numeric;
  v_soon      boolean := false;
  m           record;
  v_bet_flag  boolean;
begin
  check_name := 'database'; status := 'OK';
  detail := 'connected: ' || current_setting('server_version') || ', ' || current_database();
  observed := jsonb_build_object('now', p_now, 'in_season', v_in_season); return next;

  select string_agg(t, ', ' order by t) into v_txt from unnest(array['cfb_lab_predictions','cfb_lab_market_quotes','cfb_pipeline_runs',
    'cfb_team_week_state','cfb_weekly_projections','cfb_decision_snapshots','cfb_players']) as t where to_regclass('public.' || t) is null;
  check_name := 'contracts'; status := case when v_txt is null then 'OK' else 'WARNING' end;
  detail := case when v_txt is null then 'cfb_lab, cfb_weekly, cfb_decision and cfb_personnel contracts are applied'
                 else 'missing: ' || v_txt || ' (apply the CFB contracts; this file is applied last)' end;
  observed := null; return next;

  select * into m from public.cfb_production_manifest_current;
  check_name := 'model_manifest';
  if m.manifest_id is null then
    status := 'CRITICAL'; detail := 'no production manifest recorded: "what exact model produced this prediction?" has no answer'; observed := null;
  else
    status := case when m.git_dirty then 'WARNING' else 'OK' end;
    detail := format('production %s (%s), champion %s, champion_selection %s, commit %s%s', m.production_model_version, m.production_model_status,
      m.champion_model_version, m.champion_selection, left(m.git_commit, 12), case when m.git_dirty then ' (DIRTY working tree)' else '' end);
    observed := jsonb_build_object('manifest_id', m.manifest_id, 'deployed_at', m.deployed_at, 'artifacts', (select count(*) from jsonb_object_keys(m.artifact_hashes)));
  end if;
  return next;

  check_name := 'latest_team_state';
  if to_regclass('public.cfb_team_week_state') is null then
    status := 'WARNING'; detail := 'cfb_team_week_state is not here (supabase/cfb_weekly.sql)'; observed := null;
  else
    execute 'select max(as_of), count(*) from public.cfb_team_week_state where as_of <= $1' into v_ts, v_n using p_now;
    v_age := extract(epoch from p_now - v_ts) / 60;
    status := public.cfb_prod_age_status(v_age, 'team_state', v_in_season);
    detail := case when v_ts is null then 'no team state mirrored' else format('newest team state as of %s (%s min old), %s rows', v_ts, round(v_age), v_n) end;
    observed := jsonb_build_object('as_of', v_ts, 'age_minutes', round(v_age), 'rows', v_n);
  end if;
  return next;

  check_name := 'odds_freshness';
  if to_regclass('public.cfb_lab_market_quotes') is null then
    status := 'WARNING'; detail := 'cfb_lab_market_quotes is not here (supabase/cfb_lab.sql)'; observed := null;
  else
    execute 'select max(observed_at) from public.cfb_lab_market_quotes where source = $1 and observed_at <= $2' into v_ts using 'odds_api', p_now;
    if to_regclass('public.cfb_lab_predictions') is not null then
      execute 'select exists (select 1 from public.cfb_lab_predictions where kickoff_ts > $1 and kickoff_ts <= $1 + interval ''48 hours'')' into v_soon using p_now;
    end if;
    v_age := extract(epoch from p_now - v_ts) / 60;
    status := public.cfb_prod_age_status(v_age, 'odds', v_in_season and v_soon);
    detail := case when v_ts is null then 'no odds_api quote captured' else format('newest odds_api quote %s min old; games within 48 h: %s', round(v_age), v_soon) end
      || case when status <> 'OK' then ' — decisions fail closed (MARKET_STALE); football projections still display' else '' end;
    observed := jsonb_build_object('newest_quote', v_ts, 'age_minutes', round(v_age), 'games_within_48h', v_soon);
  end if;
  return next;

  check_name := 'pbp_freshness';
  if to_regclass('public.cfb_source_health') is null then
    status := 'WARNING'; detail := 'cfb_source_health is not here (supabase/cfb_weekly.sql)'; observed := null;
  else
    execute 'select as_of, status, payload ->> ''last_successful_ingestion'' from public.cfb_source_health where source = $1 and as_of <= $2 order by as_of desc limit 1'
      into v_ts, v_txt, v_ts2 using 'pbp', p_now;
    v_age := extract(epoch from p_now - coalesce(v_ts2, v_ts)) / 60;
    status := case when v_txt in ('MISSING') and v_in_season then 'CRITICAL'
                   when v_txt in ('DEGRADED', 'STALE') and v_in_season then 'WARNING'
                   else public.cfb_prod_age_status(v_age, 'pbp', v_in_season) end;
    detail := case when v_ts is null then 'no PBP source-health row mirrored'
                   else format('PBP %s at %s; last successful ingestion %s min ago', v_txt, v_ts, round(v_age)) end
      || case when status <> 'OK' then ' — advanced metrics are not advanced on missing plays (degraded, never zero EPA)' else '' end;
    observed := jsonb_build_object('status', v_txt, 'as_of', v_ts, 'last_success', v_ts2, 'age_minutes', round(v_age));
  end if;
  return next;

  check_name := 'prediction_freshness';
  if to_regclass('public.cfb_weekly_projections') is null then
    status := 'WARNING'; detail := 'cfb_weekly_projections is not here (supabase/cfb_weekly.sql)'; observed := null;
  else
    execute 'select max(prediction_ts), count(*) from public.cfb_weekly_projections where prediction_ts <= $1' into v_ts, v_n using p_now;
    v_n2 := null; v_ts2 := null;
    if to_regclass('public.cfb_lab_predictions') is not null then
      execute 'select max(prediction_ts), count(*) from public.cfb_lab_predictions where prediction_ts <= $1' into v_ts2, v_n2 using p_now;
    end if;
    v_age := extract(epoch from p_now - v_ts) / 60;
    status := public.cfb_prod_age_status(v_age, 'weekly_projection', v_in_season);
    detail := format('newest V2.1 weekly projection %s (%s rows); newest Model Lab snapshot %s (%s rows)',
      coalesce(v_ts::text, 'none'), v_n, coalesce(v_ts2::text, 'none'), coalesce(v_n2, 0));
    observed := jsonb_build_object('weekly_newest', v_ts, 'weekly_rows', v_n, 'lab_newest', v_ts2, 'lab_rows', v_n2);
  end if;
  return next;

  select count(*), string_agg(h.job || coalesce(' (last ok ' || h.last_ok_at::text || ')', ' (never ok)'), '; ' order by h.job)
    into v_n, v_txt
    from public.cfb_job_registry g
    join lateral (select max(x.at) filter (where x.status in ('OK','WARN','SKIPPED_LOCKED')) as last_ok_at, g.job
                    from public.cfb_job_heartbeats x where x.job = g.job and x.at <= p_now) h on true
   where extract(month from p_now at time zone 'UTC')::int = any (g.season_months)
     and coalesce(h.last_ok_at, '-infinity'::timestamptz) < p_now - make_interval(mins => g.max_silence_minutes)
     and exists (select 1 from public.cfb_job_heartbeats y where y.job = g.job);
  select count(*) into v_n2 from public.cfb_job_registry g
   where not exists (select 1 from public.cfb_job_heartbeats y where y.job = g.job);
  check_name := 'cron_heartbeats';
  status := case when v_n > 0 and exists (
                   select 1 from public.cfb_job_registry g
                    where g.severity_on_miss = 'CRITICAL' and extract(month from p_now at time zone 'UTC')::int = any (g.season_months)
                      and exists (select 1 from public.cfb_job_heartbeats y where y.job = g.job)
                      and coalesce((select max(x.at) from public.cfb_job_heartbeats x where x.job = g.job and x.status in ('OK','WARN','SKIPPED_LOCKED') and x.at <= p_now),
                                   '-infinity'::timestamptz) < p_now - make_interval(mins => g.max_silence_minutes)) then 'CRITICAL'
                 when v_n > 0 then 'WARNING' else 'OK' end;
  detail := case when v_n > 0 then 'overdue: ' || v_txt else 'every reporting job completed inside its deadline' end
    || case when v_n2 > 0 then format('; %s registered jobs have never sent a heartbeat (not yet wired)', v_n2) else '' end;
  observed := jsonb_build_object('overdue', v_n, 'never_reported', v_n2); return next;

  select count(*) filter (where c.status = 'OPEN' and c.severity = 'CRITICAL'), count(*) filter (where c.status = 'OPEN')
    into v_n, v_n2 from public.cfb_incidents_current c;
  check_name := 'open_incidents';
  status := case when v_n > 0 then 'CRITICAL' when v_n2 > 0 then 'WARNING' else 'OK' end;
  detail := format('%s open incidents (%s critical)', v_n2, v_n); observed := jsonb_build_object('open', v_n2, 'critical', v_n); return next;

  select count(*) into v_n from public.cfb_incidents i
   where i.error_code = 'DATABASE_DEADLOCK' and i.event <> 'RESOLVED' and i.at > p_now - interval '1 hour' and i.at <= p_now;
  check_name := 'deadlock_storm';
  status := case when v_n >= 10 then 'CRITICAL' when v_n >= 3 then 'WARNING' else 'OK' end;
  detail := format('%s deadlocks reported in the last hour', v_n); observed := jsonb_build_object('last_hour', v_n); return next;

  select count(*), string_agg(l.job || '/' || l.lock_key || ' held by ' || l.holder, '; ') into v_n, v_txt
    from public.cfb_job_locks l where l.expires_at < p_now;
  check_name := 'job_locks';
  status := case when v_n > 0 then 'WARNING' else 'OK' end;
  detail := case when v_n > 0 then 'expired leases (a holder crashed or overran; the next run takes over): ' || v_txt else 'no expired lease' end;
  observed := jsonb_build_object('expired', v_n); return next;

  check_name := 'partial_sync';
  if to_regclass('public.cfb_team_week_state') is null or to_regclass('public.cfb_pipeline_runs') is null then
    status := 'OK'; detail := 'weekly contract not applied'; observed := null;
  else
    execute 'select count(*) from public.cfb_team_week_state s where s.run_id is not null and s.recorded_at < $1 - interval ''2 hours''
               and not exists (select 1 from public.cfb_pipeline_runs r where r.run_id = s.run_id)' into v_n using p_now;
    status := case when v_n > 0 then 'WARNING' else 'OK' end;
    detail := case when v_n > 0 then format('%s team-state rows belong to a run whose run row never arrived (an interrupted mirror): hidden from the published view until the next sync', v_n)
                   else 'every mirrored team-state row belongs to a committed run' end;
    observed := jsonb_build_object('orphan_state_rows', v_n);
  end if;
  return next;

  select f.enabled into v_bet_flag from public.cfb_feature_flags f where f.flag = 'cfb_bet_actionable_enabled';
  check_name := 'fail_closed_betting';
  if to_regclass('public.cfb_decision_snapshots') is null then
    status := 'OK'; detail := 'decision contract not applied; official BET output flag ' || coalesce(v_bet_flag::text, 'unset'); observed := null;
  else
    execute 'select count(*) from public.cfb_decision_snapshots where status = ''BET'' and decided_at > $1 - interval ''7 days'' and decided_at <= $1'
      into v_n using p_now;
    status := case when v_n > 0 and coalesce(v_bet_flag, false) is not true then 'CRITICAL' else 'OK' end;
    detail := format('%s BET decisions in the last 7 days; official BET output is %s', v_n, case when coalesce(v_bet_flag, false) then 'ENABLED' else 'DISABLED' end)
      || case when status = 'CRITICAL' then ' — a BET exists while betting is disabled: investigate before anything is published' else '' end;
    observed := jsonb_build_object('bets_7d', v_n, 'bet_flag', v_bet_flag);
  end if;
  return next;

  select string_agg(f.flag || '=' || f.enabled::text, ', ' order by f.flag) into v_txt from public.cfb_feature_flags f;
  check_name := 'feature_flags';
  status := case when exists (select 1 from public.cfb_feature_flags f where f.kind = 'KILL_SWITCH' and not f.enabled) then 'WARNING' else 'OK' end;
  detail := coalesce(v_txt, 'no flags'); observed := null; return next;
end $fn$;

revoke all on function public.cfb_health(timestamptz) from public;
do $blk$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.cfb_health(timestamptz) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.cfb_health(timestamptz) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.cfb_health(timestamptz) to service_role'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.cfb_incidents_current, public.cfb_job_heartbeat_status, public.cfb_production_manifest_current, public.cfb_compatibility_current, public.cfb_data_corrections_current to authenticated';
    if to_regclass('public.cfb_team_week_state_published') is not null then execute 'grant select on public.cfb_team_week_state_published to authenticated'; end if;
    if to_regclass('public.cfb_weekly_projections_published') is not null then execute 'grant select on public.cfb_weekly_projections_published to authenticated'; end if;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.cfb_incidents_current, public.cfb_job_heartbeat_status, public.cfb_production_manifest_current, public.cfb_compatibility_current, public.cfb_data_corrections_current to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.cfb_incidents_current, public.cfb_job_heartbeat_status, public.cfb_production_manifest_current, public.cfb_compatibility_current, public.cfb_data_corrections_current from anon';
    if to_regclass('public.cfb_team_week_state_published') is not null then execute 'revoke all on public.cfb_team_week_state_published from anon'; end if;
    if to_regclass('public.cfb_weekly_projections_published') is not null then execute 'revoke all on public.cfb_weekly_projections_published from anon'; end if;
  end if;
end $blk$;

notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_production_model_manifest'),('cfb_compatibility_matrix'),('cfb_audit_log'),('cfb_data_corrections'),
         ('cfb_job_heartbeats'),('cfb_job_lock_events'),('cfb_incidents')
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
  select 2, 'feature flags: guarded door + audit triggers, seeded',
         case when (select count(*) from pg_trigger where tgrelid = to_regclass('public.cfb_feature_flags')
                     and tgname in ('cfb_feature_flags_guard_trg','cfb_feature_flags_no_truncate_trg','cfb_feature_flags_audit_trg')) = 3
               and (select count(*) from public.cfb_feature_flags) >= 8 then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'audit log hash chain verifies',
         case when (public.cfb_audit_verify() ->> 'ok')::boolean then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'job locks, heartbeats, incidents: functions present',
         case when to_regprocedure('public.cfb_job_lock(text,text,text,integer,text)') is not null
               and to_regprocedure('public.cfb_job_unlock(text,text,text)') is not null
               and to_regprocedure('public.cfb_heartbeat(text,text,text,text,bigint,jsonb)') is not null
               and to_regprocedure('public.cfb_record_incident(text,text,text,text,text,text,jsonb)') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'job registry seeded (' || (select count(*) from public.cfb_job_registry) || ' jobs)',
         case when (select count(*) from public.cfb_job_registry) >= 9 then 'ok' else 'CHECK THIS' end
  union all
  select 6, 'health check cfb_health()',
         case when to_regprocedure('public.cfb_health(timestamptz)') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 7, 'published weekly views (need supabase/cfb_weekly.sql first)',
         case when to_regclass('public.cfb_team_week_state_published') is not null and to_regclass('public.cfb_weekly_projections_published') is not null
              then 'ok' else 'skipped: apply supabase/cfb_weekly.sql, then this file again' end
  union all
  select 8, 'production manifest recorded',
         case when exists (select 1 from public.cfb_production_model_manifest) then 'ok'
              else 'none yet: node football/cfb_production/manifest.js --push' end
) r
order by ord, check_name;


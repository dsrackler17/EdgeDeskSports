-- cfb_production -- part 3 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- lock a job key: acquired | held by another (a clean skip, never an overlap)
create or replace function public.cfb_job_lock(p_job text, p_key text, p_holder text, p_ttl_seconds int default 900,
  p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  r      public.cfb_job_locks;
  v_now  timestamptz := clock_timestamp();
  v_ttl  int := p_ttl_seconds;
  v_lease text;
begin
  if p_job is null or p_job !~ '^[a-z][a-z0-9_]{2,63}$' or p_key is null or p_key !~ '^[A-Za-z0-9_.:-]{1,128}$'
     or p_holder is null or length(btrim(p_holder)) = 0 or length(p_holder) > 200 then
    raise exception 'cfb_job_lock: job (lower_snake), key ([A-Za-z0-9_.:-]) and holder are required' using errcode = 'invalid_parameter_value';
  end if;
  if v_ttl is null or v_ttl < 30 or v_ttl > 21600 then
    raise exception 'cfb_job_lock: ttl must be 30..21600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  -- one decision at a time per (job, key); other keys are never blocked
  perform pg_advisory_xact_lock(hashtext('cfb_job_lock'), hashtext(p_job || '/' || p_key));
  select * into r from public.cfb_job_locks where job = p_job and lock_key = p_key;
  if not found then
    v_lease := 'lease_' || substr(encode(sha256(convert_to(concat_ws('|', p_job, p_key, p_holder, v_now::text, random()::text), 'UTF8')), 'hex'), 1, 24);
    insert into public.cfb_job_locks values (p_job, p_key, p_holder, v_lease, p_correlation_id, v_now, v_now, v_now + make_interval(secs => v_ttl));
    insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id, correlation_id) values (p_job, p_key, 'ACQUIRED', p_holder, v_lease, p_correlation_id);
    return jsonb_build_object('acquired', true, 'lease_id', v_lease, 'holder', p_holder, 'expires_at', v_now + make_interval(secs => v_ttl));
  end if;
  if r.holder = p_holder and r.expires_at > v_now then
    update public.cfb_job_locks set renewed_at = v_now, expires_at = v_now + make_interval(secs => v_ttl) where job = p_job and lock_key = p_key;
    insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id, correlation_id) values (p_job, p_key, 'REENTERED', p_holder, r.lease_id, p_correlation_id);
    return jsonb_build_object('acquired', true, 'reentrant', true, 'lease_id', r.lease_id, 'holder', p_holder, 'expires_at', v_now + make_interval(secs => v_ttl));
  end if;
  if r.expires_at <= v_now then
    v_lease := 'lease_' || substr(encode(sha256(convert_to(concat_ws('|', p_job, p_key, p_holder, v_now::text, random()::text), 'UTF8')), 'hex'), 1, 24);
    update public.cfb_job_locks set holder = p_holder, lease_id = v_lease, correlation_id = p_correlation_id, acquired_at = v_now,
           renewed_at = v_now, expires_at = v_now + make_interval(secs => v_ttl)
     where job = p_job and lock_key = p_key;
    insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id, other_holder, correlation_id)
    values (p_job, p_key, 'TAKEOVER_EXPIRED', p_holder, v_lease, r.holder, p_correlation_id);
    return jsonb_build_object('acquired', true, 'took_over_from', r.holder, 'expired_at', r.expires_at, 'lease_id', v_lease,
      'holder', p_holder, 'expires_at', v_now + make_interval(secs => v_ttl));
  end if;
  insert into public.cfb_job_lock_events (job, lock_key, event, holder, other_holder, correlation_id) values (p_job, p_key, 'CONTENDED', p_holder, r.holder, p_correlation_id);
  return jsonb_build_object('acquired', false, 'reason', 'held', 'holder', r.holder, 'acquired_at', r.acquired_at, 'expires_at', r.expires_at);
end $fn$;

create or replace function public.cfb_job_lock_renew(p_job text, p_key text, p_lease_id text, p_ttl_seconds int default 900)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  r     public.cfb_job_locks;
  v_now timestamptz := clock_timestamp();
begin
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 21600 then
    raise exception 'cfb_job_lock_renew: ttl must be 30..21600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_job_lock'), hashtext(p_job || '/' || p_key));
  select * into r from public.cfb_job_locks where job = p_job and lock_key = p_key;
  if not found or r.lease_id <> p_lease_id then
    insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id, other_holder)
    values (p_job, p_key, 'RENEW_REFUSED', coalesce(r.holder, '-'), p_lease_id, r.holder);
    return jsonb_build_object('renewed', false, 'reason', case when not found then 'not_held' else 'lease_lost' end, 'holder', r.holder);
  end if;
  update public.cfb_job_locks set renewed_at = v_now, expires_at = v_now + make_interval(secs => p_ttl_seconds) where job = p_job and lock_key = p_key;
  insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id) values (p_job, p_key, 'RENEWED', r.holder, p_lease_id);
  return jsonb_build_object('renewed', true, 'lease_id', p_lease_id, 'expires_at', v_now + make_interval(secs => p_ttl_seconds));
end $fn$;

create or replace function public.cfb_job_unlock(p_job text, p_key text, p_lease_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  r public.cfb_job_locks;
begin
  perform pg_advisory_xact_lock(hashtext('cfb_job_lock'), hashtext(p_job || '/' || p_key));
  select * into r from public.cfb_job_locks where job = p_job and lock_key = p_key;
  if not found or r.lease_id <> p_lease_id then
    insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id, other_holder)
    values (p_job, p_key, 'RELEASE_REFUSED', coalesce(r.holder, '-'), p_lease_id, r.holder);
    return jsonb_build_object('released', false, 'reason', case when not found then 'not_held' else 'not_holder' end, 'holder', r.holder);
  end if;
  delete from public.cfb_job_locks where job = p_job and lock_key = p_key and lease_id = p_lease_id;
  insert into public.cfb_job_lock_events (job, lock_key, event, holder, lease_id) values (p_job, p_key, 'RELEASED', r.holder, p_lease_id);
  return jsonb_build_object('released', true);
end $fn$;

create or replace function public.cfb_heartbeat(p_job text, p_status text, p_correlation_id text default null, p_run_id text default null,
  p_duration_ms bigint default null, p_detail jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare v_id bigint;
begin
  if not exists (select 1 from public.cfb_job_registry where job = p_job) then
    raise exception 'cfb_heartbeat: % is not a registered CFB job (football/cfb_production/jobs.json)', p_job
      using errcode = 'invalid_parameter_value';
  end if;
  insert into public.cfb_job_heartbeats (job, status, correlation_id, run_id, duration_ms, detail)
  values (p_job, p_status, p_correlation_id, p_run_id, p_duration_ms, coalesce(p_detail, '{}'::jsonb))
  returning heartbeat_id into v_id;
  return v_id;
end $fn$;

-- one incident per key while open: the first report OPENS it, repeats are OCCURRED
create or replace function public.cfb_record_incident(p_incident_key text, p_error_code text, p_severity text, p_job text default null,
  p_correlation_id text default null, p_message text default null, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_last text;
  v_evt  text;
  v_n    int;
begin
  if p_incident_key is null or length(p_incident_key) > 300 then
    raise exception 'cfb_record_incident: an incident key (<= 300 characters) is required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_production'), hashtext('incident:' || p_incident_key));
  select i.event into v_last from public.cfb_incidents i where i.incident_key = p_incident_key order by i.incident_event_id desc limit 1;
  v_evt := case when v_last is null or v_last = 'RESOLVED' then 'OPENED' else 'OCCURRED' end;
  insert into public.cfb_incidents (incident_key, event, error_code, runlog_class, severity, job, correlation_id, message, detail)
  values (p_incident_key, v_evt, coalesce(p_error_code, 'UNKNOWN'), public.cfb_runlog_class(coalesce(p_error_code, 'UNKNOWN')),
          coalesce(p_severity, 'WARNING'), p_job, p_correlation_id, left(p_message, 2000), coalesce(p_detail, '{}'::jsonb));
  select count(*) into v_n from public.cfb_incidents i where i.incident_key = p_incident_key
     and i.incident_event_id > coalesce((select max(x.incident_event_id) from public.cfb_incidents x
                                          where x.incident_key = p_incident_key and x.event = 'RESOLVED'), 0);
  return jsonb_build_object('incident_key', p_incident_key, 'event', v_evt, 'occurrences', v_n);
end $fn$;

create or replace function public.cfb_resolve_incident(p_incident_key text, p_actor text, p_resolution text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  r public.cfb_incidents;
begin
  if p_actor is null or length(btrim(p_actor)) = 0 or p_resolution is null or length(btrim(p_resolution)) < 8 then
    raise exception 'cfb_resolve_incident: an actor and a resolution (8+ characters) are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_production'), hashtext('incident:' || p_incident_key));
  select * into r from public.cfb_incidents i where i.incident_key = p_incident_key order by i.incident_event_id desc limit 1;
  if not found or r.event = 'RESOLVED' then
    return jsonb_build_object('resolved', false, 'reason', case when not found then 'unknown' else 'already resolved' end);
  end if;
  insert into public.cfb_incidents (incident_key, event, error_code, runlog_class, severity, job, message, actor)
  values (p_incident_key, 'RESOLVED', r.error_code, r.runlog_class, r.severity, r.job, p_resolution, p_actor);
  perform public.cfb_audit('INCIDENT_RESOLVED', p_incident_key, jsonb_build_object('error_code', r.error_code), null, p_resolution, p_actor, null);
  return jsonb_build_object('resolved', true);
end $fn$;

create or replace view public.cfb_incidents_current as
with last_open as (
  select incident_key, max(incident_event_id) filter (where event = 'OPENED') as opened_id
    from public.cfb_incidents group by incident_key
), agg as (
  select i.incident_key,
         min(i.at) as opened_at, max(i.at) as last_at, count(*) filter (where i.event <> 'RESOLVED') as occurrences,
         (array_agg(i.event order by i.incident_event_id desc))[1] as last_event,
         (array_agg(i.error_code order by i.incident_event_id desc))[1] as error_code,
         (array_agg(i.job order by i.incident_event_id desc))[1] as job,
         (array_agg(i.message order by i.incident_event_id desc) filter (where i.event <> 'RESOLVED'))[1] as message,
         max(case i.severity when 'CRITICAL' then 3 when 'WARNING' then 2 else 1 end) as sev_rank
    from public.cfb_incidents i join last_open l on l.incident_key = i.incident_key and i.incident_event_id >= l.opened_id
   group by i.incident_key
)
select incident_key, case when last_event = 'RESOLVED' then 'RESOLVED' else 'OPEN' end as status,
       case sev_rank when 3 then 'CRITICAL' when 2 then 'WARNING' else 'INFO' end as severity,
       error_code, public.cfb_runlog_class(error_code) as runlog_class, job, occurrences, opened_at, last_at, message
  from agg;

create or replace view public.cfb_job_heartbeat_status as
select g.job, g.workflow, g.trigger_kind, g.schedule, g.season_months, g.max_silence_minutes, g.severity_on_miss,
       s.last_started_at, s.last_ok_at, s.last_failed_at, s.last_status, s.last_at,
       (extract(month from now() at time zone 'UTC')::int = any (g.season_months)) as in_season,
       ((extract(month from now() at time zone 'UTC')::int = any (g.season_months))
        and coalesce(s.last_ok_at, '-infinity'::timestamptz) < now() - make_interval(mins => g.max_silence_minutes)) as overdue
  from public.cfb_job_registry g
  left join lateral (
    select max(h.at) filter (where h.status = 'STARTED') as last_started_at,
           max(h.at) filter (where h.status in ('OK','WARN','SKIPPED_LOCKED')) as last_ok_at,
           max(h.at) filter (where h.status = 'FAILED') as last_failed_at,
           (array_agg(h.status order by h.at desc, h.heartbeat_id desc))[1] as last_status,
           max(h.at) as last_at
      from public.cfb_job_heartbeats h where h.job = g.job
  ) s on true;

create or replace view public.cfb_production_manifest_current as
select m.* from public.cfb_production_model_manifest m order by m.deployed_at desc, m.recorded_at desc limit 1;

create or replace view public.cfb_compatibility_current as
select distinct on (c.model_version, c.feature_version, c.calibration_version, c.decision_policy_version, c.decision_engine_version, c.market_engine_version) c.*
  from public.cfb_compatibility_matrix c
 order by c.model_version, c.feature_version, c.calibration_version, c.decision_policy_version, c.decision_engine_version,
          c.market_engine_version, c.decided_at desc, c.recorded_at desc;

create or replace function public.cfb_is_compatible(p_model text, p_feature text, p_calibration text, p_policy text,
  p_engine text, p_market text)
returns boolean language sql stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
  select coalesce((select c.status = 'COMPATIBLE' from public.cfb_compatibility_current c
                    where c.model_version = p_model and c.feature_version = p_feature and c.calibration_version = p_calibration
                      and c.decision_policy_version = p_policy and c.decision_engine_version = p_engine
                      and c.market_engine_version = p_market), false)
$fn$;

-- raise (never warn) when a tuple is not explicitly COMPATIBLE
create or replace function public.cfb_assert_compatible(p_model text, p_feature text, p_calibration text, p_policy text,
  p_engine text, p_market text)
returns boolean language plpgsql stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if not public.cfb_is_compatible(p_model, p_feature, p_calibration, p_policy, p_engine, p_market) then
    raise exception 'CALIBRATION: % with feature %, calibration %, policy %, decision engine %, market engine % is not a COMPATIBLE row of cfb_compatibility_matrix',
      p_model, p_feature, p_calibration, p_policy, p_engine, p_market using errcode = 'check_violation';
  end if;
  return true;
end $fn$;

-- the manifest is audited on the way in
create or replace function public.cfb_manifest_audit()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  perform public.cfb_audit(case when new.supersedes is not null then 'MODEL_ROLLBACK' else 'MANIFEST_RECORDED' end,
    new.manifest_id, case when new.supersedes is not null then jsonb_build_object('manifest_id', new.supersedes) else null end,
    jsonb_build_object('production_model_version', new.production_model_version, 'champion_model_version', new.champion_model_version,
      'champion_selection', new.champion_selection, 'git_commit', new.git_commit, 'content_sha256', new.content_sha256),
    coalesce(new.reason, 'manifest recorded by football/cfb_production/manifest.js'), coalesce(new.payload ->> 'recorded_by', 'cfb_production manifest'), null);
  return null;
end $fn$;

create or replace function public.cfb_compat_audit()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  perform public.cfb_audit('COMPATIBILITY_CHANGE', new.model_version,
    null, jsonb_build_object('status', new.status, 'feature_version', new.feature_version, 'calibration_version', new.calibration_version,
      'decision_policy_version', new.decision_policy_version, 'row_id', new.row_id), new.evidence, new.decided_by, null);
  return null;
end $fn$;

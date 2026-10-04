-- cfb_production -- part 2 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function public.cfb_feature_flags_audit()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.cfb_audit('FEATURE_FLAG_SEEDED', new.flag, null, jsonb_build_object('enabled', new.enabled, 'kind', new.kind),
      new.reason, new.updated_by, null);
  elsif new.enabled is distinct from old.enabled or new.evidence_ref is distinct from old.evidence_ref then
    perform public.cfb_audit('FEATURE_FLAG_CHANGE', new.flag, jsonb_build_object('enabled', old.enabled, 'evidence_ref', old.evidence_ref),
      jsonb_build_object('enabled', new.enabled, 'evidence_ref', new.evidence_ref), new.reason, new.updated_by, null);
  end if;
  return null;
end $fn$;

-- the one door. Betting cannot be switched on while the current manifest's
-- decision policy has betting disabled: the flag is never a bypass of the policy gate.
create or replace function public.cfb_set_feature_flag(p_flag text, p_enabled boolean, p_actor text, p_reason text,
  p_evidence text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  f        public.cfb_feature_flags;
  v_policy jsonb;
begin
  if p_flag is null or p_enabled is null then
    raise exception 'cfb_set_feature_flag: flag and enabled are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_actor is null or length(btrim(p_actor)) = 0 or p_reason is null or length(btrim(p_reason)) < 8 then
    raise exception 'cfb_set_feature_flag: an actor and a reason (8+ characters) are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_production'), hashtext('flag:' || p_flag));
  select * into f from public.cfb_feature_flags where flag = p_flag;
  if not found then
    raise exception 'cfb_set_feature_flag: unknown flag % (flags are declared in supabase/cfb_production.sql)', p_flag
      using errcode = 'invalid_parameter_value';
  end if;
  if f.enabled = p_enabled and f.evidence_ref is not distinct from coalesce(p_evidence, f.evidence_ref) then
    return jsonb_build_object('flag', p_flag, 'enabled', f.enabled, 'changed', false);
  end if;
  if p_enabled and f.guarded then
    if p_evidence is null or length(btrim(p_evidence)) = 0 then
      raise exception 'cfb_set_feature_flag: % is guarded: switching it on needs the evidence reference', p_flag
        using errcode = 'check_violation';
    end if;
    if p_actor ~* '^(automation|system|cfb_|github|pg_cron)' then
      raise exception 'cfb_set_feature_flag: % is guarded: only a person may switch it on', p_flag using errcode = 'check_violation';
    end if;
  end if;
  if p_enabled and f.kind = 'BETTING' then
    select m.payload -> 'decision_policy' into v_policy
      from public.cfb_production_model_manifest m order by m.deployed_at desc, m.recorded_at desc limit 1;
    if v_policy is null or coalesce((v_policy ->> 'bet_enabled')::boolean, false) is not true then
      raise exception 'cfb_set_feature_flag: % cannot be switched on: the current manifest''s decision policy (%) has betting disabled',
        p_flag, coalesce(v_policy ->> 'version', 'none recorded') using errcode = 'check_violation';
    end if;
  end if;
  perform set_config('cfb.flag_door', 'on', true);
  update public.cfb_feature_flags
     set enabled = p_enabled, updated_by = p_actor, reason = p_reason,
         evidence_ref = coalesce(p_evidence, evidence_ref)
   where flag = p_flag;
  perform set_config('cfb.flag_door', 'off', true);
  return jsonb_build_object('flag', p_flag, 'enabled', p_enabled, 'changed', true);
end $fn$;

-- ============================================================ data corrections
create table if not exists public.cfb_data_corrections (
  correction_id    text primary key,
  target_table     text not null,
  target_key       jsonb not null,
  field            text not null,
  original_value   jsonb,
  corrected_value  jsonb,
  status           text not null,
  reason           text not null,
  source           text not null,
  actor            text not null,
  supersedes       text,
  created_at       timestamptz not null default clock_timestamp(),
  constraint cfb_corr_id check (correction_id ~ '^cfbc_[0-9a-f]{24}$'),
  constraint cfb_corr_status check (status in ('ACTIVE','REVOKED')),
  constraint cfb_corr_key check (jsonb_typeof(target_key) = 'object' and target_key <> '{}'::jsonb),
  constraint cfb_corr_reason check (length(btrim(reason)) >= 8 and length(btrim(source)) > 0 and length(btrim(actor)) > 0),
  constraint cfb_corr_changes check (status <> 'ACTIVE' or original_value is distinct from corrected_value)
);
create index if not exists cfb_corr_target_idx on public.cfb_data_corrections (target_table, field, created_at desc);

-- Raw SOURCE tables only. Model outputs (predictions, projections, decisions) are
-- never corrected: a fix to an output is a new version of the output.
create or replace function public.cfb_correctable_tables()
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select array['cfb_lab_results','cfb_lab_market_quotes','cfb_lab_event_map','cfb_game_validation','cfb_qb_events',
               'cfb_players','cfb_player_aliases','cfb_transfer_history','cfb_player_events']::text[]
$fn$;

create or replace function public.cfb_record_correction(p_table text, p_key jsonb, p_field text, p_corrected jsonb,
  p_reason text, p_source text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_where  text := '';
  k        text;
  v_n      int;
  v_orig   jsonb;
  v_prev   text;
  v_id     text;
begin
  if p_table is null or not (p_table = any (public.cfb_correctable_tables())) then
    raise exception 'cfb_record_correction: % is not a correctable source table (outputs are re-versioned, never corrected)', p_table
      using errcode = 'invalid_parameter_value';
  end if;
  if to_regclass('public.' || p_table) is null then
    raise exception 'cfb_record_correction: public.% does not exist here', p_table using errcode = 'undefined_table';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 8 or p_source is null or length(btrim(p_source)) = 0
     or p_actor is null or length(btrim(p_actor)) = 0 then
    raise exception 'cfb_record_correction: reason (8+ characters), source and actor are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_key is null or jsonb_typeof(p_key) <> 'object' or p_key = '{}'::jsonb then
    raise exception 'cfb_record_correction: the key must be a JSON object of column -> value' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || p_table) and a.attname = p_field
                   and a.attnum > 0 and not a.attisdropped) then
    raise exception 'cfb_record_correction: % has no column %', p_table, p_field using errcode = 'undefined_column';
  end if;
  -- serialise corrections of one target field BEFORE reading its original value
  perform pg_advisory_xact_lock(hashtext('cfb_production'), hashtext('corr:' || p_table || ':' || p_key::text || ':' || p_field));
  for k in select jsonb_object_keys(p_key) loop
    if not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || p_table) and a.attname = k
                     and a.attnum > 0 and not a.attisdropped) then
      raise exception 'cfb_record_correction: % has no key column %', p_table, k using errcode = 'undefined_column';
    end if;
    v_where := v_where || case when v_where = '' then '' else ' and ' end
      || format('to_jsonb(t.%I) = %L::jsonb', k, (p_key -> k)::text);
  end loop;
  -- the key must name exactly one row; the ORIGINAL value is read from it, never typed in
  execute format('select count(*), max((to_jsonb(t.*) -> %L)::text) from public.%I t where %s', p_field, p_table, v_where)
    into v_n, v_orig;
  if v_n <> 1 then
    raise exception 'cfb_record_correction: the key matches % rows of % (exactly one required)', v_n, p_table
      using errcode = 'invalid_parameter_value';
  end if;
  if v_orig is not distinct from p_corrected then
    raise exception 'cfb_record_correction: the corrected value equals the stored value' using errcode = 'invalid_parameter_value';
  end if;
  select c.correction_id into v_prev from public.cfb_data_corrections c
   where c.target_table = p_table and c.target_key = p_key and c.field = p_field
   order by c.created_at desc, c.correction_id desc limit 1;
  v_id := 'cfbc_' || substr(encode(sha256(convert_to(concat_ws('|', p_table, p_key::text, p_field, coalesce(p_corrected::text, 'null'),
    coalesce(v_prev, '-'), clock_timestamp()::text), 'UTF8')), 'hex'), 1, 24);
  insert into public.cfb_data_corrections (correction_id, target_table, target_key, field, original_value, corrected_value,
    status, reason, source, actor, supersedes)
  values (v_id, p_table, p_key, p_field, v_orig, p_corrected, 'ACTIVE', p_reason, p_source, p_actor, v_prev);
  perform public.cfb_audit('MANUAL_CORRECTION', p_table || ' ' || p_key::text || ' ' || p_field,
    jsonb_build_object('value', v_orig), jsonb_build_object('value', p_corrected, 'correction_id', v_id, 'source', p_source),
    p_reason, p_actor, null);
  return jsonb_build_object('correction_id', v_id, 'original_value', v_orig, 'corrected_value', p_corrected, 'supersedes', v_prev);
end $fn$;

create or replace function public.cfb_revoke_correction(p_correction_id text, p_actor text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c    public.cfb_data_corrections;
  v_id text;
begin
  select * into c from public.cfb_data_corrections where correction_id = p_correction_id;
  if not found then
    raise exception 'cfb_revoke_correction: unknown correction %', p_correction_id using errcode = 'invalid_parameter_value';
  end if;
  if p_actor is null or length(btrim(p_actor)) = 0 or p_reason is null or length(btrim(p_reason)) < 8 then
    raise exception 'cfb_revoke_correction: an actor and a reason (8+ characters) are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_production'), hashtext('corr:' || c.target_table || ':' || c.target_key::text || ':' || c.field));
  -- only the CURRENT, ACTIVE correction of a field can be revoked (revoking an older
  -- one would silently discard the newer correction)
  if c.status <> 'ACTIVE' or exists (select 1 from public.cfb_data_corrections x where x.supersedes = c.correction_id) then
    raise exception 'cfb_revoke_correction: % is not the current active correction of its field', p_correction_id
      using errcode = 'invalid_parameter_value';
  end if;
  v_id := 'cfbc_' || substr(encode(sha256(convert_to(concat_ws('|', 'revoke', p_correction_id, clock_timestamp()::text), 'UTF8')), 'hex'), 1, 24);
  insert into public.cfb_data_corrections (correction_id, target_table, target_key, field, original_value, corrected_value,
    status, reason, source, actor, supersedes)
  values (v_id, c.target_table, c.target_key, c.field, c.original_value, c.original_value, 'REVOKED', p_reason, 'revocation', p_actor, c.correction_id);
  perform public.cfb_audit('CORRECTION_REVOKED', c.target_table || ' ' || c.target_key::text || ' ' || c.field,
    jsonb_build_object('correction_id', c.correction_id, 'value', c.corrected_value), jsonb_build_object('value', c.original_value),
    p_reason, p_actor, null);
  return jsonb_build_object('correction_id', v_id, 'revoked', p_correction_id);
end $fn$;

-- the latest correction per target field; REVOKED means "read the raw value"
create or replace view public.cfb_data_corrections_current as
select distinct on (c.target_table, c.target_key, c.field) c.*
  from public.cfb_data_corrections c
 order by c.target_table, c.target_key, c.field, c.created_at desc, c.correction_id desc;

-- a reader's one call: the corrected value when an ACTIVE correction exists, else the raw value
create or replace function public.cfb_corrected(p_table text, p_key jsonb, p_field text, p_raw jsonb)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
  select coalesce((select case when c.status = 'ACTIVE' then c.corrected_value else p_raw end
                     from public.cfb_data_corrections_current c
                    where c.target_table = p_table and c.target_key = p_key and c.field = p_field), p_raw)
$fn$;

-- ============================================================ jobs, heartbeats, locks, incidents
create table if not exists public.cfb_job_registry (
  job                  text primary key,
  workflow             text not null,
  trigger_kind         text not null,
  schedule             text not null,
  season_months        int[] not null,
  max_silence_minutes  int not null,
  expected_minutes     int not null,
  timeout_minutes      int not null,
  lock_scope           text not null,
  severity_on_miss     text not null,
  purpose              text not null,
  updated_at           timestamptz not null default now(),
  constraint cfb_job_name check (job ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint cfb_job_trigger check (trigger_kind in ('pg_cron','github_schedule','pg_cron+github_schedule','dispatch','manual')),
  constraint cfb_job_miss check (severity_on_miss in ('INFO','WARNING','CRITICAL')),
  constraint cfb_job_silence check (max_silence_minutes > 0 and expected_minutes > 0 and timeout_minutes >= expected_minutes)
);

create table if not exists public.cfb_job_heartbeats (
  heartbeat_id    bigint generated always as identity primary key,
  job             text not null,
  status          text not null,
  correlation_id  text,
  run_id          text,
  duration_ms     bigint,
  detail          jsonb not null default '{}'::jsonb,
  at              timestamptz not null default clock_timestamp(),
  constraint cfb_hb_status check (status in ('STARTED','OK','WARN','FAILED','SKIPPED_LOCKED','SKIPPED_DISABLED'))
);
create index if not exists cfb_hb_job_idx on public.cfb_job_heartbeats (job, at desc);

create table if not exists public.cfb_job_locks (
  job             text not null,
  lock_key        text not null,
  holder          text not null,
  lease_id        text not null,
  correlation_id  text,
  acquired_at     timestamptz not null,
  renewed_at      timestamptz not null,
  expires_at      timestamptz not null,
  primary key (job, lock_key),
  constraint cfb_lock_expiry check (expires_at > acquired_at)
);
comment on table public.cfb_job_locks is
  'Lease locks behind cfb_job_lock(): one row per held (job, key). Written only by the lock functions (advisory lock first, then the row).';

create table if not exists public.cfb_job_lock_events (
  event_id        bigint generated always as identity primary key,
  job             text not null,
  lock_key        text not null,
  event           text not null,
  holder          text not null,
  lease_id        text,
  other_holder    text,
  correlation_id  text,
  at              timestamptz not null default clock_timestamp(),
  constraint cfb_lock_event check (event in ('ACQUIRED','RENEWED','REENTERED','TAKEOVER_EXPIRED','CONTENDED','RELEASED','RELEASE_REFUSED','RENEW_REFUSED'))
);
create index if not exists cfb_lock_events_idx on public.cfb_job_lock_events (job, lock_key, at desc);

create table if not exists public.cfb_incidents (
  incident_event_id  bigint generated always as identity primary key,
  incident_key       text not null,
  event              text not null,
  error_code         text not null,
  runlog_class       text not null,
  severity           text not null,
  job                text,
  correlation_id     text,
  message            text,
  detail             jsonb not null default '{}'::jsonb,
  actor              text,
  at                 timestamptz not null default clock_timestamp(),
  constraint cfb_inc_event check (event in ('OPENED','OCCURRED','RESOLVED')),
  constraint cfb_inc_code check (error_code = any (public.cfb_error_codes())),
  constraint cfb_inc_class check (runlog_class = public.cfb_runlog_class(error_code)),
  constraint cfb_inc_severity check (severity in ('INFO','WARNING','CRITICAL')),
  constraint cfb_inc_resolved check (event <> 'RESOLVED' or (actor is not null and message is not null))
);
create index if not exists cfb_inc_key_idx on public.cfb_incidents (incident_key, incident_event_id desc);
create index if not exists cfb_inc_code_at_idx on public.cfb_incidents (error_code, at desc);

create table if not exists public.cfb_freshness_rules (
  source             text primary key,
  warn_minutes       int not null,
  critical_minutes   int not null,
  applies            text not null,
  basis              text not null,
  constraint cfb_fr_order check (warn_minutes > 0 and critical_minutes >= warn_minutes)
);

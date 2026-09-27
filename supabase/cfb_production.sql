-- =============================================================================
-- cfb_production — the operational contract of the EdgeDesk CFB production
-- pathway (docs/cfb-production/ARCHITECTURE.md).
--
-- WHAT IT IS
--   cfb_production_model_manifest  write-once: the exact system that produced
--                                  a prediction (versions, artifact hashes,
--                                  git commit, migration set, deployment time).
--                                  champion_selection records whether a Model
--                                  Championship selected the champion; none has
--                                  been run, so every manifest says NOT_RUN.
--   cfb_compatibility_matrix       append-only: which model x feature schema x
--                                  calibration x decision policy x market engine
--                                  tuples may run together (cfb_assert_compatible).
--   cfb_feature_flags              component switches; changed only through
--                                  cfb_set_feature_flag(), every change audited;
--                                  betting cannot be switched on while the
--                                  manifest's decision policy says no.
--   cfb_audit_log                  append-only, hash-chained (cfb_audit_verify):
--                                  promotion, rollback, policy / calibration /
--                                  feature-version / source changes, flag
--                                  changes, manual corrections, manifests.
--   cfb_data_corrections           controlled manual corrections: the original
--                                  value is read from the row itself, the raw
--                                  row is never touched, a revocation is a new row.
--   cfb_job_registry               every CFB scheduled job (jobs.json), with its
--                                  deadline; cfb_job_heartbeats (append-only);
--                                  cfb_job_heartbeat_status (overdue jobs).
--   cfb_job_locks                  lease locks behind cfb_job_lock(job, key):
--                                  one weekly refresh writes team state at a
--                                  time; per-game refreshes lock per game.
--   cfb_incidents                  append-only incident events (OPENED /
--                                  OCCURRED / RESOLVED), cfb_record_incident().
--   cfb_freshness_rules            the maximum acceptable age per source.
--   cfb_health(p_now)              database, manifest, team state, odds / PBP /
--                                  prediction freshness, heartbeats, incidents,
--                                  locks, partial syncs, fail-closed betting.
--   cfb_team_week_state_published, cfb_weekly_projections_published
--                                  state and projections of COMMITTED weekly runs
--                                  only (the run row is mirrored last), so a
--                                  reader never sees a half-mirrored refresh.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only for audit, manifest, heartbeat, incident, lock-event,
--      correction and compatibility tables: BEFORE UPDATE / DELETE / TRUNCATE
--      triggers raise restrict_violation for every role, the owner included.
--   2. No ACCESS EXCLUSIVE lock on a table when this file is re-applied:
--      triggers, row level security and policies are created only when
--      missing (a DROP TRIGGER or ALTER TABLE ... ENABLE ROW LEVEL SECURITY
--      would take ACCESS EXCLUSIVE on a live table). A lock that cannot be
--      had within lock_timeout fails the statement instead of queueing every
--      reader behind it. football/cfb_production/sql.test.js measures it.
--   3. Routine writes are single-row, short and in one deterministic lock
--      order: the advisory lock first (two-int key space, never colliding with
--      the lab's one-key hashtext locks), then the row.
--   4. Who reads what: authenticated may SELECT the operational tables and call
--      cfb_health(); anon nothing; writes only through the service role's
--      functions (plus INSERT of manifests and matrix rows).
--
-- DEPENDENCIES: none. The published views and the health checks that read the
-- lab / weekly / decision tables are created or evaluated only where those
-- tables exist; apply this file LAST (the Deploy intelligence workflow does).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

set lock_timeout = '5s';

-- ============================================================ vocabulary
-- The error taxonomy (football/cfb_production/taxonomy.js; tests prove the two agree).
create or replace function public.cfb_error_codes()
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select array['DATA_STALE','DATA_MISSING','PROVIDER_TRANSIENT','PROVIDER_RATE_LIMIT','PROVIDER_REJECTED',
               'PROVIDER_SCHEMA','AUTH','TEAM_MAPPING','PLAYER_MAPPING','MODEL_ARTIFACT','MODEL_INPUT',
               'CALIBRATION','MARKET_INVALID','DATABASE_DEADLOCK','DATABASE_TIMEOUT','DATABASE_UNAVAILABLE',
               'DATABASE_CONSTRAINT','DATABASE_SCHEMA','PIPELINE_CONFLICT','UNKNOWN']::text[]
$fn$;

-- code -> the weekly engine's runlog class (cfb_pipeline_stage_log.error_class)
create or replace function public.cfb_runlog_class(p_code text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select case p_code
    when 'PROVIDER_TRANSIENT' then 'TRANSIENT' when 'DATABASE_UNAVAILABLE' then 'TRANSIENT'
    when 'PROVIDER_RATE_LIMIT' then 'RATE_LIMIT'
    when 'AUTH' then 'AUTH'
    when 'PROVIDER_REJECTED' then 'SCHEMA' when 'PROVIDER_SCHEMA' then 'SCHEMA' when 'MODEL_ARTIFACT' then 'SCHEMA'
    when 'CALIBRATION' then 'SCHEMA' when 'DATABASE_SCHEMA' then 'SCHEMA'
    when 'DATA_STALE' then 'DATA_QUALITY' when 'DATA_MISSING' then 'DATA_QUALITY' when 'TEAM_MAPPING' then 'DATA_QUALITY'
    when 'PLAYER_MAPPING' then 'DATA_QUALITY' when 'MODEL_INPUT' then 'DATA_QUALITY' when 'MARKET_INVALID' then 'DATA_QUALITY'
    when 'DATABASE_DEADLOCK' then 'DATABASE' when 'DATABASE_TIMEOUT' then 'DATABASE' when 'DATABASE_CONSTRAINT' then 'DATABASE'
    when 'PIPELINE_CONFLICT' then 'DATABASE'
    else 'UNKNOWN' end
$fn$;

create or replace function public.cfb_prod_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a correction or a rollback is a new row)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name using errcode = 'restrict_violation';
  end if;
end $fn$;

-- ============================================================ the manifest
create table if not exists public.cfb_production_model_manifest (
  manifest_id                text primary key,
  content_sha256             text not null,
  champion_model_version     text not null,
  champion_selection         text not null,
  production_model_version   text not null,
  production_model_status    text not null,
  git_commit                 text not null,
  git_dirty                  boolean not null,
  migration_version          text not null,
  migrations                 jsonb not null,
  feature_version            text not null,
  training_data_version      text not null,
  team_rating_version        text not null,
  player_model_version       text not null,
  matchup_model_version      text not null,
  ensemble_version           text not null,
  calibration_version        text not null,
  uncertainty_version        text not null,
  market_engine_version      text not null,
  decision_policy_version    text not null,
  decision_engine_version    text not null,
  artifact_hashes            jsonb not null,
  compatibility              jsonb not null,
  fallback_hierarchy         jsonb not null,
  deployed_at                timestamptz not null,
  supersedes                 text,
  reason                     text,
  payload                    jsonb not null,
  recorded_at                timestamptz not null default now(),
  constraint cfb_manifest_id check (manifest_id ~ '^cfbm_[0-9a-f]{24}$'),
  constraint cfb_manifest_content check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint cfb_manifest_commit check (git_commit ~ '^[0-9a-f]{40}$'),
  constraint cfb_manifest_selection check (champion_selection in ('NOT_RUN','SELECTED')),
  -- a SELECTED champion needs the championship's evidence on the record
  constraint cfb_manifest_selected_evidence check (champion_selection <> 'SELECTED' or payload ? 'championship_evidence'),
  constraint cfb_manifest_hashes check (jsonb_typeof(artifact_hashes) = 'object' and artifact_hashes <> '{}'::jsonb),
  constraint cfb_manifest_fallback check (jsonb_typeof(fallback_hierarchy) = 'array' and jsonb_array_length(fallback_hierarchy) >= 2),
  constraint cfb_manifest_rollback check (supersedes is null or (reason is not null and length(btrim(reason)) >= 8))
);
create unique index if not exists cfb_manifest_deploy_key on public.cfb_production_model_manifest (content_sha256, deployed_at);
create index if not exists cfb_manifest_deployed_idx on public.cfb_production_model_manifest (deployed_at desc);
comment on table public.cfb_production_model_manifest is
  'Write-once record of the exact CFB production system per deployment (football/cfb_production/manifest.js). A rollback is a new row that supersedes. champion_selection = NOT_RUN: no Model Championship has been run.';

-- ============================================================ compatibility
create table if not exists public.cfb_compatibility_matrix (
  row_id                    text primary key,
  model_version             text not null,
  feature_version           text not null,
  calibration_version       text not null,
  decision_policy_version   text not null,
  decision_engine_version   text not null,
  market_engine_version     text not null,
  status                    text not null,
  evidence                  text not null,
  decided_by                text not null,
  decided_at                timestamptz not null,
  payload                   jsonb not null,
  recorded_at               timestamptz not null default now(),
  constraint cfb_compat_id check (row_id ~ '^cfbk_[0-9a-f]{24}$'),
  constraint cfb_compat_status check (status in ('COMPATIBLE','INCOMPATIBLE','RETIRED')),
  constraint cfb_compat_evidence check (length(btrim(evidence)) >= 8)
);
create unique index if not exists cfb_compat_key on public.cfb_compatibility_matrix
  (model_version, feature_version, calibration_version, decision_policy_version, decision_engine_version, market_engine_version, decided_at);

-- ============================================================ audit log
create table if not exists public.cfb_audit_log (
  audit_id        bigint generated always as identity primary key,
  chain_seq       bigint not null,
  event_type      text not null,
  subject         text not null,
  before          jsonb,
  after           jsonb,
  reason          text not null,
  actor           text not null,
  actor_kind      text not null,
  correlation_id  text,
  created_at      timestamptz not null default clock_timestamp(),
  prev_hash       text,
  row_hash        text not null,
  constraint cfb_audit_type check (event_type in ('MODEL_PROMOTION','MODEL_ROLLBACK','DECISION_POLICY_CHANGE','CALIBRATION_CHANGE',
    'FEATURE_VERSION_CHANGE','SOURCE_CHANGE','MANUAL_CORRECTION','CORRECTION_REVOKED','FEATURE_FLAG_CHANGE','FEATURE_FLAG_SEEDED',
    'MANIFEST_RECORDED','COMPATIBILITY_CHANGE','INCIDENT_RESOLVED','RELEASE')),
  constraint cfb_audit_reason check (length(btrim(reason)) >= 8 and length(btrim(actor)) > 0),
  constraint cfb_audit_actor_kind check (actor_kind in ('PERSON','SYSTEM'))
);
create unique index if not exists cfb_audit_chain_key on public.cfb_audit_log (chain_seq);
create index if not exists cfb_audit_subject_idx on public.cfb_audit_log (subject, created_at desc);

create or replace function public.cfb_audit_row_hash(p_seq bigint, p_prev text, p_type text, p_subject text, p_before jsonb,
  p_after jsonb, p_reason text, p_actor text, p_kind text, p_corr text, p_at timestamptz)
returns text language sql immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select encode(sha256(convert_to(concat_ws('|', p_seq::text, coalesce(p_prev, '-'), p_type, p_subject,
    coalesce(p_before::text, '-'), coalesce(p_after::text, '-'), p_reason, p_actor, p_kind, coalesce(p_corr, '-'),
    to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex')
$fn$;

-- Chains every row to the one before it. The advisory lock serialises writers so
-- chain_seq is gap-free; under READ COMMITTED the SELECT after the wait sees the
-- row the previous writer committed.
create or replace function public.cfb_audit_chain()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_seq  bigint;
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('cfb_production'), hashtext('cfb_audit_log'));
  select a.chain_seq, a.row_hash into v_seq, v_prev from public.cfb_audit_log a order by a.chain_seq desc limit 1;
  new.chain_seq  := coalesce(v_seq, 0) + 1;
  new.prev_hash  := v_prev;
  new.created_at := clock_timestamp();
  if new.actor_kind is null then
    new.actor_kind := case when new.actor ~* '^(automation|system|cfb_|github|pg_cron)' then 'SYSTEM' else 'PERSON' end;
  end if;
  new.row_hash := public.cfb_audit_row_hash(new.chain_seq, new.prev_hash, new.event_type, new.subject, new.before, new.after,
    new.reason, new.actor, new.actor_kind, new.correlation_id, new.created_at);
  return new;
end $fn$;

create or replace function public.cfb_audit(p_type text, p_subject text, p_before jsonb, p_after jsonb, p_reason text,
  p_actor text, p_correlation_id text default null)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare v_id bigint;
begin
  insert into public.cfb_audit_log (chain_seq, event_type, subject, before, after, reason, actor, actor_kind, correlation_id, row_hash)
  values (0, p_type, p_subject, p_before, p_after, p_reason, p_actor, null, p_correlation_id, '-')
  returning audit_id into v_id;
  return v_id;
end $fn$;

-- Recomputes every link. ok = false names the first row whose hash or link breaks.
create or replace function public.cfb_audit_verify()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  r      record;
  v_prev text := null;
  v_seq  bigint := 0;
  v_n    int := 0;
begin
  for r in select * from public.cfb_audit_log order by chain_seq loop
    v_n := v_n + 1;
    if r.chain_seq <> v_seq + 1 then
      return jsonb_build_object('ok', false, 'rows', v_n, 'break_at', r.chain_seq, 'reason', 'chain_seq gap');
    end if;
    if r.prev_hash is distinct from v_prev then
      return jsonb_build_object('ok', false, 'rows', v_n, 'break_at', r.chain_seq, 'reason', 'prev_hash does not match the previous row');
    end if;
    if r.row_hash <> public.cfb_audit_row_hash(r.chain_seq, r.prev_hash, r.event_type, r.subject, r.before, r.after,
         r.reason, r.actor, r.actor_kind, r.correlation_id, r.created_at) then
      return jsonb_build_object('ok', false, 'rows', v_n, 'break_at', r.chain_seq, 'reason', 'row_hash does not match the row');
    end if;
    v_prev := r.row_hash;
    v_seq := r.chain_seq;
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_n, 'head', v_prev);
end $fn$;

-- ============================================================ feature flags
create table if not exists public.cfb_feature_flags (
  flag          text primary key,
  enabled       boolean not null,
  kind          text not null,
  guarded       boolean not null default false,
  description   text not null,
  updated_by    text not null,
  reason        text not null,
  evidence_ref  text,
  updated_at    timestamptz not null default now(),
  constraint cfb_ff_flag check (flag ~ '^cfb_[a-z0-9_]{3,60}$'),
  constraint cfb_ff_kind check (kind in ('KILL_SWITCH','COMPONENT','BETTING')),
  constraint cfb_ff_reason check (length(btrim(reason)) >= 8 and length(btrim(updated_by)) > 0),
  -- a guarded flag is ON only with the evidence on the record
  constraint cfb_ff_guarded check (not (guarded and enabled) or evidence_ref is not null)
);
comment on table public.cfb_feature_flags is
  'CFB component switches. Change only with cfb_set_feature_flag(flag, enabled, actor, reason[, evidence]); every change is in cfb_audit_log.';

create or replace function public.cfb_feature_flags_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'cfb_feature_flags: a flag is never deleted (switch it off with cfb_set_feature_flag)' using errcode = 'restrict_violation';
  end if;
  if coalesce(current_setting('cfb.flag_door', true), '') <> 'on' then
    raise exception 'cfb_feature_flags: change a flag with public.cfb_set_feature_flag(flag, enabled, actor, reason[, evidence]) so it is audited'
      using errcode = 'restrict_violation';
  end if;
  if new.flag <> old.flag or new.kind <> old.kind or new.guarded <> old.guarded then
    raise exception 'cfb_feature_flags: a flag''s name, kind and guard never change' using errcode = 'restrict_violation';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $fn$;

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

-- ============================================================ triggers, RLS, grants
-- Created only when missing: DROP TRIGGER and ENABLE ROW LEVEL SECURITY take
-- ACCESS EXCLUSIVE, which a re-apply against live tables must not.
do $blk$
declare
  t text;
  v_rel regclass;
begin
  foreach t in array array['cfb_production_model_manifest','cfb_compatibility_matrix','cfb_audit_log','cfb_data_corrections',
    'cfb_job_heartbeats','cfb_job_lock_events','cfb_incidents']
  loop
    v_rel := to_regclass('public.' || t);
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = t || '_no_update_trg') then
      execute format('create trigger %I before update on public.%I for each row execute function public.cfb_prod_append_only()', t || '_no_update_trg', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = t || '_no_delete_trg') then
      execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_prod_append_only()', t || '_no_delete_trg', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = t || '_no_truncate_trg') then
      execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_prod_append_only()', t || '_no_truncate_trg', t);
    end if;
  end loop;

  v_rel := to_regclass('public.cfb_audit_log');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_audit_log_chain_trg') then
    create trigger cfb_audit_log_chain_trg before insert on public.cfb_audit_log for each row execute function public.cfb_audit_chain();
  end if;
  v_rel := to_regclass('public.cfb_feature_flags');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_feature_flags_guard_trg') then
    create trigger cfb_feature_flags_guard_trg before update or delete on public.cfb_feature_flags for each row execute function public.cfb_feature_flags_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_feature_flags_no_truncate_trg') then
    create trigger cfb_feature_flags_no_truncate_trg before truncate on public.cfb_feature_flags for each statement execute function public.cfb_feature_flags_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_feature_flags_audit_trg') then
    create trigger cfb_feature_flags_audit_trg after insert or update on public.cfb_feature_flags for each row execute function public.cfb_feature_flags_audit();
  end if;
  v_rel := to_regclass('public.cfb_production_model_manifest');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_manifest_audit_trg') then
    create trigger cfb_manifest_audit_trg after insert on public.cfb_production_model_manifest for each row execute function public.cfb_manifest_audit();
  end if;
  v_rel := to_regclass('public.cfb_compatibility_matrix');
  if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'cfb_compat_audit_trg') then
    create trigger cfb_compat_audit_trg after insert on public.cfb_compatibility_matrix for each row execute function public.cfb_compat_audit();
  end if;
end $blk$;

do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_production_model_manifest','cfb_compatibility_matrix','cfb_audit_log','cfb_feature_flags',
    'cfb_data_corrections','cfb_job_registry','cfb_job_heartbeats','cfb_job_locks','cfb_job_lock_events','cfb_incidents','cfb_freshness_rules']
  loop
    if not (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t)) then
      execute format('alter table public.%I enable row level security', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    end if;
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from service_role', t);
      execute format('grant select on table public.%I to service_role', t);
    end if;
  end loop;
  -- the two rows a job inserts directly (PostgREST, ignore-duplicates); everything else goes through a function
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant insert on table public.cfb_production_model_manifest to service_role';
    execute 'grant insert on table public.cfb_compatibility_matrix to service_role';
  end if;
end $blk$;

do $blk$
declare
  f text;
begin
  foreach f in array array['public.cfb_audit(text,text,jsonb,jsonb,text,text,text)', 'public.cfb_audit_verify()',
    'public.cfb_set_feature_flag(text,boolean,text,text,text)', 'public.cfb_record_correction(text,jsonb,text,jsonb,text,text,text)',
    'public.cfb_revoke_correction(text,text,text)', 'public.cfb_corrected(text,jsonb,text,jsonb)',
    'public.cfb_job_lock(text,text,text,integer,text)', 'public.cfb_job_lock_renew(text,text,text,integer)', 'public.cfb_job_unlock(text,text,text)',
    'public.cfb_heartbeat(text,text,text,text,bigint,jsonb)', 'public.cfb_record_incident(text,text,text,text,text,text,jsonb)',
    'public.cfb_resolve_incident(text,text,text)', 'public.cfb_is_compatible(text,text,text,text,text,text)',
    'public.cfb_assert_compatible(text,text,text,text,text,text)']
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $blk$;

-- ============================================================ seeds
-- Flags: inserted once and never overwritten by a re-apply (a person's switch stays switched).
insert into public.cfb_feature_flags (flag, enabled, kind, guarded, description, updated_by, reason) values
  ('cfb_weekly_engine_enabled', true, 'KILL_SWITCH', false,
   'Kill switch for the scheduled weekly refresh (cfb-v2-shadow.yml). Off: the gate skips the engine and the mirror; the last published state stays.',
   'cfb_production seed', 'initial state: the weekly engine runs on its schedule'),
  ('cfb_model_lab_enabled', true, 'KILL_SWITCH', false,
   'Kill switch for the hourly Model Lab job (cfb-lab.yml). Off: no checkpoint snapshots are taken (a missed window is never re-taken).',
   'cfb_production seed', 'initial state: the Model Lab runs hourly in season'),
  ('cfb_v21_pure_model_enabled', true, 'COMPONENT', false,
   'The V2.1 pure model (edgedesk_cfb_v2.1.0) produces weekly projections. Off: the fallback hierarchy serves V1 (the governance champion).',
   'cfb_production seed', 'initial state: V2.1 projects in shadow, V1 is champion'),
  ('cfb_v1_fallback_enabled', true, 'COMPONENT', false,
   'V1 (edgedesk_cfb_p4_v1.0.0), the governance champion, stays available as the fallback level of the hierarchy.',
   'cfb_production seed', 'initial state: the previous stable champion is available'),
  ('cfb_decision_engine_enabled', true, 'COMPONENT', false,
   'The wagering decision engine runs in shadow on every captured quote. Off: no decision rows are produced (status UNAVAILABLE).',
   'cfb_production seed', 'initial state: decisions in shadow under cfb_decision_policy_v0'),
  ('cfb_player_model_enabled', false, 'COMPONENT', true,
   'Personnel unit adjustments as a model input. Not part of edgedesk_cfb_v2.1.0 (a research layer); on only with a new, validated model version.',
   'cfb_production seed', 'initial state: personnel is research, not a production input'),
  ('cfb_matchup_correction_enabled', false, 'COMPONENT', true,
   'The scheme/matchup residual correction. Not part of edgedesk_cfb_v2.1.0; on only with a new, validated model version.',
   'cfb_production seed', 'initial state: the matchup correction is research, not a production input'),
  ('cfb_bet_actionable_enabled', false, 'BETTING', true,
   'Official BET output. Off: every decision is PASS / LEAN with NO_BET_BETTING_DISABLED. Cannot be switched on while the manifest''s decision policy has betting disabled.',
   'cfb_production seed', 'initial state: cfb_decision_policy_v0 is an UNVALIDATED_DEFAULT with betting disabled')
on conflict (flag) do nothing;

-- The job registry is reference data (football/cfb_production/jobs.json; sql.test.js proves they agree).
insert into public.cfb_job_registry (job, workflow, trigger_kind, schedule, season_months, max_silence_minutes, expected_minutes,
  timeout_minutes, lock_scope, severity_on_miss, purpose) values
  ('cfb_lab_hourly', '.github/workflows/cfb-lab.yml', 'pg_cron+github_schedule', '7 * * * * (pg_cron) | 37 * * 8-12,1 * (github)',
   '{8,9,10,11,12,1}', 150, 4, 30, 'cfb_lab_hourly/<season>', 'CRITICAL',
   'Model Lab: market capture, checkpoint snapshots, settlement, reports; decision shadow; mirror to Supabase'),
  ('cfb_weekly_refresh', '.github/workflows/cfb-v2-shadow.yml', 'pg_cron+github_schedule', 'Sun/Mon 10:05 weekly, Tue 12:07/12:17 freeze, Wed-Sat 10:47 daily',
   '{8,9,10,11,12,1}', 1560, 35, 90, 'cfb_weekly_refresh/<season>', 'CRITICAL',
   'Weekly engine: validate finals and PBP, team/QB/unit state, V2.1 projections, EARLY freeze, mirror to Supabase'),
  ('cfb_v1_board_build', '.github/workflows/football-weekly-build.yml', 'github_schedule', '40 9 * 8-12,1 * | 20 */2 * 8-12,1 *',
   '{8,9,10,11,12,1}', 1560, 30, 90, 'none (concurrency group football-weekly-build)', 'WARNING',
   'V1 champion board (football/fbs/slate.json): the fallback level and the Model Lab V1 adapter input'),
  ('cfb_enrichment', '.github/workflows/football-enrichment.yml', 'github_schedule', '25 * * 9-12,1 6 | 25 */2 * 9-12,1 5 | 25 */6 * 9-12,1 0-4',
   '{9,10,11,12,1}', 480, 10, 30, 'none (concurrency group football-weekly-build)', 'WARNING',
   'V1 board enrichment: availability, starters, weather for the board'),
  ('cfb_odds_capture', 'supabase/capture_cron.sql', 'pg_cron', '*/10 * * * * near | 4,34 * * * * day | 18 */4 * * * board',
   '{8,9,10,11,12,1}', 60, 1, 5, 'row-level (capture function)', 'CRITICAL',
   'Per-sportsbook odds capture (edge function capture) into cfb_lab_market_quotes via cfb_lab_ingest_quotes()'),
  ('cfb_football_record', '.github/workflows/football-model-record.yml', 'github_schedule', '47 * * 8-12,1 * | 47 12 * 2-7 1',
   '{8,9,10,11,12,1}', 150, 5, 30, 'none (concurrency group football-model-record)', 'WARNING',
   'Public football record: settles V1 projections against finals'),
  ('cfb_availability_sync', '.github/workflows/availability-sync.yml', 'github_schedule', 'hourly Fri/Sat, 3-hourly Tue-Thu, 6-hourly Sun/Mon',
   '{8,9,10,11,12,1}', 480, 10, 30, 'none (concurrency group availability-sync)', 'WARNING',
   'Injury / availability reports (source for QB status and the injury-source freshness rule)'),
  ('cfb_starter_context', '.github/workflows/starter-context.yml', 'github_schedule', '20 7,19 * * 0,1 | 20 13 * * 2-5 | 20 13,21 * * 6',
   '{8,9,10,11,12,1}', 1560, 15, 45, 'none (concurrency group starter-context)', 'WARNING',
   'QB starter context (football/starters/cfb_<season>.json): the QB-status source'),
  ('cfb_roster_sync', '.github/workflows/roster-sync.yml', 'github_schedule', '0 10 * * 1',
   '{8,9,10,11,12,1}', 11520, 10, 30, 'none (concurrency group roster-sync)', 'INFO',
   'Weekly roster sync (football/rosters): roster freshness bound 8 days')
on conflict (job) do update set workflow = excluded.workflow, trigger_kind = excluded.trigger_kind, schedule = excluded.schedule,
  season_months = excluded.season_months, max_silence_minutes = excluded.max_silence_minutes, expected_minutes = excluded.expected_minutes,
  timeout_minutes = excluded.timeout_minutes, lock_scope = excluded.lock_scope, severity_on_miss = excluded.severity_on_miss,
  purpose = excluded.purpose, updated_at = now()
where (public.cfb_job_registry.workflow, public.cfb_job_registry.trigger_kind, public.cfb_job_registry.schedule, public.cfb_job_registry.season_months,
       public.cfb_job_registry.max_silence_minutes, public.cfb_job_registry.expected_minutes, public.cfb_job_registry.timeout_minutes,
       public.cfb_job_registry.lock_scope, public.cfb_job_registry.severity_on_miss, public.cfb_job_registry.purpose)
   is distinct from (excluded.workflow, excluded.trigger_kind, excluded.schedule, excluded.season_months, excluded.max_silence_minutes,
       excluded.expected_minutes, excluded.timeout_minutes, excluded.lock_scope, excluded.severity_on_miss, excluded.purpose);

-- Freshness: the bounds the engines already use, gathered in one place (never retuned here).
insert into public.cfb_freshness_rules (source, warn_minutes, critical_minutes, applies, basis) values
  ('odds', 180, 360, 'in season, while a game kicks off within 48 h',
   'warn = cfb_decision_policy_v0 stale_minutes (a decision fails closed as MARKET_STALE); critical = the weekly engine market bound (6 h)'),
  ('pbp', 2160, 10080, 'in season',
   'weekly engine: a game past kickoff + 36 h needs a final; the PBP source must advance weekly (7 d critical)'),
  ('qb_status', 2160, 4320, 'in season', 'weekly engine qb_status bound 36 h; Model Lab qb_status_freshness 72 h'),
  ('injury', 720, 4320, 'in season', 'weekly engine injury bound 12 h; Model Lab injury_freshness 72 h'),
  ('roster', 11520, 20160, 'in season', 'weekly engine roster bound 8 days'),
  ('team_state', 11520, 21600, 'in season', 'one weekly refresh per week (8 d warn, 15 d critical)'),
  ('weekly_projection', 11520, 21600, 'in season', 'one EARLY freeze per week (8 d warn, 15 d critical)')
on conflict (source) do update set warn_minutes = excluded.warn_minutes, critical_minutes = excluded.critical_minutes,
  applies = excluded.applies, basis = excluded.basis
where (public.cfb_freshness_rules.warn_minutes, public.cfb_freshness_rules.critical_minutes, public.cfb_freshness_rules.applies, public.cfb_freshness_rules.basis)
   is distinct from (excluded.warn_minutes, excluded.critical_minutes, excluded.applies, excluded.basis);

-- ============================================================ published (committed) weekly state
-- The weekly mirror writes the run row LAST (football/cfb_weekly/sync_supabase.js),
-- so state whose run row is absent belongs to a mirror still in flight or cut
-- short; these views show only state and projections of PUBLISHED runs.
do $blk$
begin
  if to_regclass('public.cfb_team_week_state') is not null and to_regclass('public.cfb_pipeline_runs') is not null then
    execute $v$
      create or replace view public.cfb_team_week_state_published as
      select distinct on (s.team_id, s.season, s.week, s.feature_version) s.*
        from public.cfb_team_week_state s
        join public.cfb_pipeline_runs r on r.run_id = s.run_id and r.published and r.status = 'PUBLISHED'
       order by s.team_id, s.season, s.week, s.feature_version, s.state_version desc
    $v$;
  end if;
  if to_regclass('public.cfb_weekly_projections') is not null and to_regclass('public.cfb_pipeline_runs') is not null then
    execute $v$
      create or replace view public.cfb_weekly_projections_published as
      select p.*
        from public.cfb_weekly_projections p
        join public.cfb_pipeline_runs r on r.run_id = p.run_id and r.published and r.status = 'PUBLISHED'
    $v$;
  end if;
end $blk$;

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

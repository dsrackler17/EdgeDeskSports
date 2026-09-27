-- cfb_production -- part 1 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
  constraint cfb_compat_id check (row_id ~ '^cfbcm_[0-9a-f]{24}$'),
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

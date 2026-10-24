-- =============================================================================
-- signal_center.sql — EdgeDesk Signal Center: versioned research signals, the
-- graphics drawn from them, Model DNA snapshots, reader preferences and
-- in-app notices, behind server-enforced free / Full Access / operator doors.
-- docs/signal-center/README.md (architecture), METHODOLOGY.md (the rules).
--
-- WHAT IT ADDS
--   sc_config             the switches: mode (shadow | live), the sports that
--                         may publish, the free tier's limits, notice and
--                         graphic rules. Changed only by an operator door,
--                         every change appended to sc_config_log
--   sc_runs               one row per evaluation run (a lease: one at a time)
--   sc_signals            one row per signal identity (signal_key): its
--                         current version, lifecycle and publication state,
--                         and the columns the feed filters and sorts on
--   sc_signal_versions    APPEND-ONLY: every version of every signal, the full
--                         payload the reader, the graphic and the notice all
--                         read, with its SHA-256. Never updated, never deleted
--   sc_signal_events      APPEND-ONLY audit trail: detected, versioned,
--                         published, held, withdrawn, superseded, expired,
--                         invalidated, graphic and notice events, with actor
--   sc_graphics           one row per (version, template, template version,
--                         format): the render content, its hash, its status
--                         (READY / FAILED / OUTDATED / WITHDRAWN) and the
--                         operator's external-publication approval. Content
--                         is immutable; only the status moves
--   sc_model_dna          APPEND-ONLY Model DNA records, one per distinct audit
--   sc_preferences        a reader's sports, teams, categories and notice level
--   sc_notification_log   which reader was told about which signal (dedupe and
--                         cooldown); the notice itself is a public.user_alerts
--                         row, the bell that already exists
--   sc_failures           the dead-letter list: every item a run could not take
--
-- WRITES. No client role writes any table, and the service role writes only
-- through the job doors below (table DML is revoked from it too), so every
-- invariant is enforced in one place:
--   sc_begin_run(p)            a run, or {busy} while another holds the lease
--   sc_current(keys)           the current version of known keys (the worker's
--                              material-update decision)
--   sc_prior_divergences()     active divergences, for convergence
--   sc_active(cats) / sc_graphics_due(tv)   what to re-verify; what still needs
--                              a graphic at this template version
--   sc_ingest(run, items)      idempotent upsert by signal_key; a new version
--                              only for a new version_hash; per-key advisory
--                              lock; supersession and expiry; the publication
--                              rule; simulator signals re-checked against
--                              sim_team_results
--   sc_put_graphics(run, items) / sc_put_dna(run, items) / sc_fail(run, items)
--   sc_notify(run)             fan-out into public.user_alerts, deduplicated,
--                              cooled down, entitled readers only
--   sc_finish_run(run, ...)    closes the run and expires started events
--
-- READS. Every table is row-level secured with no client policy, and SELECT is
-- revoked: the only way in is a door that checks the caller.
--   anon + signed in   sc_status(), sc_pulse(hours) (counts only, no number),
--                      sc_public_feed(limit) (the free preview: number-free
--                      headlines, at most sc_config.free.feed_limit)
--   signed in          sc_feed(filters, cursor, limit), sc_signal(id),
--                      sc_signal_version(id, version), sc_model_dna_current(sport):
--                      Full Access readers (sc_viewer_entitled, the project's
--                      one rule, fail closed) get everything published; anyone
--                      else gets the preview. sc_save_preferences(p),
--                      sc_my_preferences(), sc_unread_count()
--   operators          sc_admin_queue, sc_admin_act, sc_admin_graphic,
--                      sc_admin_set_mode, sc_admin_runs, sc_admin_failures,
--                      sc_admin_resolve_failure — sc_is_admin(): the business
--                      consoles' operator list (billing_is_admin), fail closed
--
-- SHADOW FIRST. sc_config.mode starts 'shadow': every signal is stored and an
-- operator can review it, and nothing is published. 'live' publishes VERIFIED,
-- non-fixture signals of the sports in sc_config.live_sports at or above
-- sc_config.publish.min_label. An operator's hold or withdrawal always sticks.
--
-- HISTORY IS KEPT. A correction is a new version, an invalidation withdraws the
-- signal and its graphics, and both leave every earlier version readable.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261024120000_signal_center.sql.
--
-- CORE POSTGRES ONLY (supabase/games_social.sql's lesson). Supabase installs
-- pgcrypto in the `extensions` schema, which the doors' pinned search_path
-- (public, pg_temp) does not reach: digest() there failed every ingest with
-- "function digest(bytea, unknown) does not exist". Hashes use sha256(bytea)
-- (core since PostgreSQL 11) and ids gen_random_uuid() (core since 13).
-- =============================================================================

begin;

-- Every constraint is checked at its statement in this file, never at commit.
-- The upgrade updates rows of sc_signals twice (dating, then placement); the
-- second update of a row this transaction already wrote queues the deferred
-- current_version_id check, and ALTER TABLE refuses to run while a check is
-- pending ("cannot ALTER TABLE ... pending trigger events": the deploy of
-- 2026-10-24 01:14 UTC, rolled back). Only this transaction is affected.
set constraints all immediate;

-- ---------------------------------------------------------------- guards
create or replace function public.sc_keep()
returns trigger language plpgsql as $$
begin
  raise exception 'public.% is append-only: % refused (history is kept; write a new row instead)', tg_table_name, tg_op;
end $$;

-- the research-not-picks rule for every string a reader is shown (the same
-- phrases as lib/edgedesk_signal_engine.js BANNED; edp_copy_ok too when the
-- personal research layer is installed)
create or replace function public.sc_copy_ok(p text)
returns boolean language plpgsql immutable as $$
begin
  if p is null then return true; end if;
  if p ~* '(bet this|\mlocks?\M|guarantee|\msmash|must[- ]bet|can''?t lose|best bets?|winning plays?|free money|sure thing|\medge\M|value play|\+ev\M|positive[- ]ev|profitable|hammer)' then return false; end if;
  return true;
end $$;

create or replace function public.sc_label_rank(p text)
returns integer language sql immutable as $$
  select case p when 'Major' then 4 when 'Notable' then 3 when 'Routine' then 2 when 'Monitor' then 1 else 0 end;
$$;

-- may a signal of this sport publish under these live sports? A shared
-- source's warning names the family it serves: 'football' (NFL and college
-- football) is live when either is, 'all' when any sport is.
create or replace function public.sc_sport_live(p_live jsonb, p_sport text)
returns boolean language sql immutable as $$
  select case p_sport when 'football' then coalesce(p_live ?| array['nfl', 'cfb'], false)
                      when 'all' then coalesce(jsonb_typeof(p_live) = 'array' and jsonb_array_length(p_live) > 0, false)
                      else coalesce(p_live ? p_sport, false) end;
$$;

-- ---------------------------------------------------------------- entitlement
-- The caller's Full Access, through the project's one rule (simulator.sql's
-- precedent). Fails CLOSED: with no entitlement authority installed, nobody
-- is entitled. Answers only for auth.uid(), returns only a boolean.
create or replace function public.sc_viewer_entitled()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare uid uuid; ok boolean;
begin
  begin uid := auth.uid(); exception when others then return false; end;
  if uid is null then return false; end if;
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using uid;
    return coalesce(ok, false);
  end if;
  if to_regclass('public.subscriptions') is not null and to_regprocedure('public.billing_row_grants_access(text,text,timestamptz,timestamptz)') is not null then
    execute 'select exists (select 1 from public.subscriptions s where s.user_id = $1 and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))' into ok using uid;
    return coalesce(ok, false);
  end if;
  return false;
end $$;

-- the same rule for ANY user (the notice fan-out), fail closed
create or replace function public.sc_user_entitled(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare ok boolean;
begin
  if p_user is null then return false; end if;
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute 'select public.community_is_entitled($1)' into ok using p_user;
    return coalesce(ok, false);
  end if;
  if to_regclass('public.subscriptions') is not null and to_regprocedure('public.billing_row_grants_access(text,text,timestamptz,timestamptz)') is not null then
    execute 'select exists (select 1 from public.subscriptions s where s.user_id = $1 and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))' into ok using p_user;
    return coalesce(ok, false);
  end if;
  return false;
end $$;

-- The operator: the business consoles' list (billing_is_admin, else the
-- partner program's), checked against the caller's own token. Fail closed.
create or replace function public.sc_is_admin()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean := false;
begin
  if auth.uid() is null then return false; end if;
  if to_regprocedure('public.billing_is_admin()') is not null then
    execute 'select public.billing_is_admin()' into v; return coalesce(v, false);
  end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v; return coalesce(v, false);
  end if;
  return false;
exception when others then return false;
end $$;

-- ---------------------------------------------------------------- config
create table if not exists public.sc_config (
  key         text primary key check (key ~ '^[a-z_]{2,40}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create table if not exists public.sc_config_log (
  id          bigint generated always as identity primary key,
  key         text not null,
  old_value   jsonb,
  new_value   jsonb not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
-- why (the owner's door requires one; an operator's switch may leave it empty)
alter table public.sc_config_log add column if not exists reason text;
insert into public.sc_config (key, value) values
  ('mode', '"shadow"'),
  ('live_sports', '["nfl","cfb"]'),
  ('publish', '{"min_label":"Routine"}'),
  ('free', '{"feed_limit":3,"max_age_hours":72,"min_label":"Notable","categories":["FORECAST_SHIFT","MARKET_DIVERGENCE","INJURY_IMPACT","MODEL_RELIABILITY_WARNING","DATA_QUALITY_WARNING"],"example_graphics":2,"example_min_age_hours":72}'),
  ('notify', '{"min_label":"Notable","cooldown_hours":6,"max_per_run":500,"window_hours":24,"max_per_reader_run":5,"max_per_reader_day":20}'),
  ('graphics', '{"auto":true,"min_label":"Notable","formats":["square","landscape","portrait"]}'),
  ('lease_minutes', '45'),
  ('allow_fixtures', 'false')
on conflict (key) do nothing;

create or replace function public.sc_cfg(p_key text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.sc_config where key = p_key;
$$;

-- ---------------------------------------------------------------- runs
create table if not exists public.sc_runs (
  run_id           uuid primary key default gen_random_uuid(),
  idempotency_key  text,
  mode             text not null check (mode in ('shadow', 'live', 'dry')),
  status           text not null default 'running' check (status in ('running', 'completed', 'failed')),
  engine_version   text not null,
  spec_version     text not null,
  source_commit    text check (source_commit is null or source_commit ~ '^[0-9a-f]{7,40}$'),
  sources          jsonb not null default '{}'::jsonb,
  counts           jsonb not null default '{}'::jsonb,
  error            jsonb,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  check ((status = 'running') = (finished_at is null))
);
create unique index if not exists sc_runs_key_uk on public.sc_runs (idempotency_key) where idempotency_key is not null and status <> 'failed';
create index if not exists sc_runs_started_idx on public.sc_runs (started_at desc);

-- ---------------------------------------------------------------- signals
create table if not exists public.sc_signals (
  signal_id          bigint generated always as identity primary key,
  signal_key         text not null unique check (signal_key ~ '^sc1-[0-9a-f]{16}$'),
  category           text not null check (category in ('FORECAST_SHIFT', 'MARKET_DIVERGENCE', 'MARKET_CONVERGENCE', 'LINE_MOVEMENT', 'SIMULATION_SHIFT', 'INJURY_IMPACT',
                       'ROSTER_MOVEMENT', 'MODEL_DISAGREEMENT', 'MODEL_RELIABILITY_WARNING', 'HISTORICAL_ANOMALY', 'DATA_QUALITY_WARNING')),
  subtype            text,
  sport              text not null check (sport ~ '^[a-z_]{2,24}$'),
  league             text,
  season             text,
  event_kind         text not null check (event_kind in ('game', 'season', 'player', 'model', 'source')),
  subject_key        text not null,
  subject_label      text not null,
  outcome_id         text not null,
  event_key          text,
  event_at           timestamptz,
  teams              text[] not null default '{}',
  market_type        text,
  headline           text not null check (length(headline) between 1 and 240),
  public_headline    text not null check (length(public_headline) between 1 and 240),
  change_pp          numeric,
  abs_change_pp      numeric generated always as (abs(change_pp)) stored,
  evidence_class     text not null check (evidence_class in ('CONFIRMED_CAUSE', 'SUPPORTED_ASSOCIATION', 'OBSERVED', 'UNEXPLAINED', 'MODEL_VERSION_CHANGE')),
  evidence_rank      smallint not null,
  verification_state text not null check (verification_state in ('VERIFIED', 'UNVERIFIED', 'INVALIDATED')),
  score              numeric not null check (score between 0 and 100),
  label              text not null check (label in ('Major', 'Notable', 'Routine', 'Monitor')),
  rarity             numeric check (rarity is null or rarity between 0 and 1),
  reliability_grade  text,
  research_grade     text,
  model_version      text,
  source_at          timestamptz,
  fixture            boolean not null default false,
  lifecycle          text not null default 'ACTIVE' check (lifecycle in ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN')),
  lifecycle_reason   text,
  publication        text not null default 'SHADOW' check (publication in ('SHADOW', 'PUBLISHED', 'HELD', 'WITHDRAWN')),
  publication_by     text,
  published_at       timestamptz,
  public_preview     boolean not null default false,
  first_detected_at  timestamptz not null default now(),
  -- found after the fact (E.SPEC.backfill): decided once, at the first version
  backfilled         boolean not null default false,
  -- the moment the signal describes, which the feed sorts and the pulse counts
  -- by: its detection, or for a backfilled signal the source record it was
  -- scored as of (never later than its detection)
  signal_at          timestamptz not null default now(),
  first_run_id       uuid,
  current_version    integer not null default 1,
  current_version_id bigint,
  superseded_by      bigint references public.sc_signals (signal_id),
  updated_at         timestamptz not null default now(),
  check (public.sc_copy_ok(headline) and public.sc_copy_ok(public_headline)),
  check (not fixture or publication <> 'PUBLISHED'),
  check (publication <> 'PUBLISHED' or verification_state = 'VERIFIED')
);
-- added after the first deployment: an installed table gets them here
alter table public.sc_signals add column if not exists backfilled boolean not null default false;
alter table public.sc_signals add column if not exists signal_at timestamptz;
-- The deploy applies this file as ONE transaction (psql -1). The row updates
-- below rewrite rows this transaction already rewrote, so PostgreSQL queues
-- the deferred current_version_id foreign key's check for each, and a queued
-- check makes any later ALTER TABLE on sc_signals fail ("pending trigger
-- events": the first production try of this file, 2026-10-24 01:14 UTC).
-- Checking constraints at each statement's end for the rest of this
-- transaction leaves nothing pending. The doors' own transactions keep the
-- deferral (it is a per-transaction setting).
set constraints all immediate;
-- rows stored before these columns existed (the first production runs) are
-- dated by the same rule the engine applies (E.SPEC.backfill): a signal first
-- detected more than 180 minutes after its source record was found later, and
-- describes the moment of that record. A data freshness warning describes its
-- detection (its source time is the stale record's). Runs once per row.
update public.sc_signals
   set backfilled = (category <> 'DATA_QUALITY_WARNING' and source_at is not null and first_detected_at - source_at > interval '180 minutes'),
       signal_at = case when category <> 'DATA_QUALITY_WARNING' and source_at is not null and first_detected_at - source_at > interval '180 minutes'
                        then source_at else first_detected_at end
 where signal_at is null;
alter table public.sc_signals alter column signal_at set default now();
alter table public.sc_signals alter column signal_at set not null;
create index if not exists sc_signals_feed_idx on public.sc_signals (publication, first_detected_at desc, signal_id desc);
create index if not exists sc_signals_time_idx on public.sc_signals (publication, signal_at desc, signal_id desc);
create index if not exists sc_signals_sport_idx on public.sc_signals (sport, publication, first_detected_at desc);
create index if not exists sc_signals_cat_idx on public.sc_signals (category, publication, first_detected_at desc);
create index if not exists sc_signals_sport_time_idx on public.sc_signals (sport, publication, signal_at desc);
create index if not exists sc_signals_cat_time_idx on public.sc_signals (category, publication, signal_at desc);
create index if not exists sc_signals_subject_idx on public.sc_signals (category, subject_key, outcome_id, event_key) where lifecycle = 'ACTIVE';
create index if not exists sc_signals_event_idx on public.sc_signals (event_at) where lifecycle = 'ACTIVE';
create index if not exists sc_signals_teams_idx on public.sc_signals using gin (teams);

create table if not exists public.sc_signal_versions (
  version_id      bigint generated always as identity primary key,
  signal_id       bigint not null references public.sc_signals (signal_id),
  version         integer not null check (version >= 1),
  version_hash    text not null check (version_hash ~ '^sv1-[0-9a-f]{16}$'),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536),
  payload_sha256  text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  reason          text not null check (reason in ('initial', 'evidence_update', 'methodology', 'correction', 'invalidation')),
  run_id          uuid,
  engine_version  text not null,
  spec_version    text not null,
  created_at      timestamptz not null default now(),
  unique (signal_id, version),
  unique (signal_id, version_hash)
);
do $fk$ begin
  if not exists (select 1 from pg_constraint where conname = 'sc_signals_current_version_fk') then
    alter table public.sc_signals add constraint sc_signals_current_version_fk foreign key (current_version_id) references public.sc_signal_versions (version_id) deferrable initially deferred;
  end if;
end $fk$;

create table if not exists public.sc_signal_events (
  id         bigint generated always as identity primary key,
  signal_id  bigint not null references public.sc_signals (signal_id),
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('detected', 'versioned', 'published', 'held', 'withdrawn', 'republished', 'superseded', 'expired', 'invalidated',
                'preview_on', 'preview_off', 'graphic_ready', 'graphic_failed', 'graphic_outdated', 'graphic_withdrawn', 'graphic_approved', 'graphic_revoked',
                'regenerate_requested', 'notified', 'server_check')),
  actor      text not null check (actor in ('system', 'owner') or actor ~ '^admin:[0-9a-f-]{36}$'),
  run_id     uuid,
  detail     jsonb not null default '{}'::jsonb
);
-- 'owner': the database owner's mode switch (sc_owner_set_mode). Replaced in
-- place so an existing table takes it too (it reads rows, changes none)
do $actor$ begin
  alter table public.sc_signal_events drop constraint if exists sc_signal_events_actor_check;
  alter table public.sc_signal_events add constraint sc_signal_events_actor_check check (actor in ('system', 'owner') or actor ~ '^admin:[0-9a-f-]{36}$');
end $actor$;
create index if not exists sc_signal_events_signal_idx on public.sc_signal_events (signal_id, at);

-- placement in record time, for rows stored before sc_ingest_one enforced it
-- (an earlier engine superseded only on an ACTIVE insert, in key order): in
-- each subject, outcome and event, every active or expired signal older than
-- the newest is superseded by it. A placed table has nothing to move, so
-- this is a no-op on every later application.
with ranked as (
  select signal_id, first_value(signal_id) over w as newest, row_number() over w as rn
    from public.sc_signals
   where lifecycle in ('ACTIVE', 'EXPIRED')
  window w as (partition by category, subject_key, outcome_id, coalesce(event_key, '') order by source_at desc nulls last, signal_id desc)
), moved as (
  update public.sc_signals s set lifecycle = 'SUPERSEDED', lifecycle_reason = 'a newer signal about the same subject and outcome', superseded_by = r.newest
    from ranked r where r.signal_id = s.signal_id and r.rn > 1
  returning s.signal_id, r.newest)
insert into public.sc_signal_events (signal_id, kind, actor, detail)
select signal_id, 'superseded', 'system', jsonb_build_object('by', newest, 'note', 'placed in record time') from moved;

-- ---------------------------------------------------------------- graphics
create table if not exists public.sc_graphics (
  graphic_id        bigint generated always as identity primary key,
  signal_id         bigint not null references public.sc_signals (signal_id),
  version_id        bigint not null references public.sc_signal_versions (version_id),
  template          text not null check (template in ('probability_shift', 'market_disagreement', 'injury_impact', 'simulator_movement', 'reliability_alert', 'weekly_recap')),
  template_version  text not null,
  format            text not null check (format in ('square', 'landscape', 'portrait')),
  content           jsonb,
  content_sha256    text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256    text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status            text not null check (status in ('READY', 'FAILED', 'OUTDATED', 'WITHDRAWN')),
  error             text,
  external_approval text not null default 'NONE' check (external_approval in ('NONE', 'APPROVED', 'REVOKED')),
  approved_by       uuid,
  approved_at       timestamptz,
  generated_at      timestamptz not null default now(),
  status_at         timestamptz not null default now(),
  unique (version_id, template, template_version, format),
  check ((status = 'FAILED') = (content is null)),
  check (status <> 'READY' or content_sha256 is not null),
  check (external_approval <> 'APPROVED' or status = 'READY')
);
create index if not exists sc_graphics_signal_idx on public.sc_graphics (signal_id, generated_at desc);

-- ---------------------------------------------------------------- Model DNA
create table if not exists public.sc_model_dna (
  id             bigint generated always as identity primary key,
  model_key      text not null,
  sport          text not null,
  grade          text not null check (grade in ('VALIDATED', 'PARTIAL', 'EARLY', 'EXPERIMENTAL', 'UNVALIDATED')),
  record         jsonb not null check (jsonb_typeof(record) = 'object' and pg_column_size(record) <= 65536),
  record_sha256  text not null,
  evaluated_at   timestamptz,
  run_id         uuid,
  created_at     timestamptz not null default now(),
  unique (model_key, record_sha256)
);
create index if not exists sc_model_dna_sport_idx on public.sc_model_dna (sport, created_at desc);

-- ---------------------------------------------------------------- readers
create table if not exists public.sc_preferences (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  sports      text[] not null default '{}' check (cardinality(sports) <= 20),
  teams       text[] not null default '{}' check (cardinality(teams) <= 60),
  categories  text[] not null default '{}' check (cardinality(categories) <= 11),
  min_label   text not null default 'Notable' check (min_label in ('Major', 'Notable', 'Routine', 'Monitor')),
  notify      boolean not null default false,
  updated_at  timestamptz not null default now()
);
create table if not exists public.sc_notification_log (
  user_id      uuid not null references auth.users (id) on delete cascade,
  signal_id    bigint not null references public.sc_signals (signal_id),
  subject_key  text not null,
  sent_at      timestamptz not null default now(),
  alert_id     bigint,
  -- true: considered and held back by the per-reader cap, never sent and never retried
  held         boolean not null default false,
  primary key (user_id, signal_id)
);
alter table public.sc_notification_log add column if not exists held boolean not null default false;
create index if not exists sc_notification_log_cool_idx on public.sc_notification_log (user_id, subject_key, sent_at desc);

create table if not exists public.sc_failures (
  id           bigint generated always as identity primary key,
  run_id       uuid,
  stage        text not null,
  item_key     text,
  error        text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid
);
create index if not exists sc_failures_open_idx on public.sc_failures (created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------- immutability
-- an identity, once written, is the signal's identity forever
create or replace function public.sc_signals_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.sc_signals: delete refused (withdraw it instead; history is kept)'; end if;
  if new.signal_key is distinct from old.signal_key or new.category is distinct from old.category or new.sport is distinct from old.sport
     or new.subject_key is distinct from old.subject_key or new.outcome_id is distinct from old.outcome_id or new.event_key is distinct from old.event_key
     or new.first_detected_at is distinct from old.first_detected_at or new.first_run_id is distinct from old.first_run_id or new.fixture is distinct from old.fixture
     -- when a signal happened is dated once (a row stored before the column existed is dated by this file)
     or (old.signal_at is not null and (new.signal_at is distinct from old.signal_at or new.backfilled is distinct from old.backfilled)) then
    raise exception 'public.sc_signals: a signal''s identity is immutable (signal %)', old.signal_key;
  end if;
  if new.current_version < old.current_version then raise exception 'public.sc_signals: the current version never goes backwards'; end if;
  new.updated_at := now();
  return new;
end $$;
-- a graphic's drawing never changes; only its status and approval move
create or replace function public.sc_graphics_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.sc_graphics: delete refused (withdraw it instead)'; end if;
  if new.content is distinct from old.content or new.content_sha256 is distinct from old.content_sha256 or new.payload_sha256 is distinct from old.payload_sha256
     or new.version_id is distinct from old.version_id or new.template is distinct from old.template or new.template_version is distinct from old.template_version or new.format is distinct from old.format then
    raise exception 'public.sc_graphics: a generated graphic is immutable; generate a new one';
  end if;
  if old.status in ('WITHDRAWN') and new.status <> old.status then raise exception 'public.sc_graphics: a withdrawn graphic stays withdrawn'; end if;
  new.status_at := case when new.status is distinct from old.status then now() else old.status_at end;
  return new;
end $$;
create or replace function public.sc_failures_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'public.sc_failures: delete refused'; end if;
  if new.run_id is distinct from old.run_id or new.stage is distinct from old.stage or new.item_key is distinct from old.item_key or new.error is distinct from old.error
     or new.detail is distinct from old.detail or new.created_at is distinct from old.created_at then raise exception 'public.sc_failures: only resolution may change'; end if;
  return new;
end $$;

do $trg$
declare t text;
begin
  foreach t in array array['sc_signal_versions', 'sc_signal_events', 'sc_model_dna', 'sc_config_log', 'sc_notification_log'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.sc_keep()', t || '_frozen', t);
  end loop;
  foreach t in array array['sc_signal_versions', 'sc_signal_events', 'sc_model_dna', 'sc_config_log', 'sc_notification_log', 'sc_signals', 'sc_graphics', 'sc_failures', 'sc_runs'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.sc_keep()', t || '_no_truncate', t);
  end loop;
  drop trigger if exists sc_signals_guard on public.sc_signals;
  create trigger sc_signals_guard before update or delete on public.sc_signals for each row execute function public.sc_signals_guard();
  drop trigger if exists sc_graphics_guard on public.sc_graphics;
  create trigger sc_graphics_guard before update or delete on public.sc_graphics for each row execute function public.sc_graphics_guard();
  drop trigger if exists sc_failures_guard on public.sc_failures;
  create trigger sc_failures_guard before update or delete on public.sc_failures for each row execute function public.sc_failures_guard();
end $trg$;

-- ---------------------------------------------------------------- job doors (service_role)
create or replace function public.sc_event(p_signal bigint, p_kind text, p_actor text, p_run uuid, p_detail jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.sc_signal_events (signal_id, kind, actor, run_id, detail) values (p_signal, p_kind, coalesce(p_actor, 'system'), p_run, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function public.sc_begin_run(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run uuid; v_other record; v_lease integer;
begin
  perform pg_advisory_xact_lock(hashtext('public.sc_runs lease'));
  v_lease := coalesce((public.sc_cfg('lease_minutes'))::text::integer, 45);
  update public.sc_runs set status = 'failed', finished_at = now(), error = jsonb_build_object('reason', 'lease expired: the run never finished')
   where status = 'running' and started_at < now() - make_interval(mins => v_lease);
  select run_id, started_at into v_other from public.sc_runs where status = 'running' order by started_at desc limit 1;
  if found then return jsonb_build_object('busy', true, 'run_id', v_other.run_id, 'started_at', v_other.started_at); end if;
  if p ? 'idempotency_key' and exists (select 1 from public.sc_runs where idempotency_key = p->>'idempotency_key' and status = 'completed') then
    return jsonb_build_object('duplicate', true, 'run_id', (select run_id from public.sc_runs where idempotency_key = p->>'idempotency_key' and status = 'completed' limit 1));
  end if;
  if coalesce(p->>'engine_version', '') = '' or coalesce(p->>'spec_version', '') = '' then raise exception 'sc_begin_run: engine_version and spec_version are required'; end if;
  insert into public.sc_runs (idempotency_key, mode, engine_version, spec_version, source_commit, sources)
  values (nullif(p->>'idempotency_key', ''), coalesce(nullif(p->>'mode', ''), (public.sc_cfg('mode'))#>>'{}'), p->>'engine_version', p->>'spec_version', nullif(p->>'source_commit', ''), coalesce(p->'sources', '{}'::jsonb))
  returning run_id into v_run;
  return jsonb_build_object('busy', false, 'run_id', v_run, 'mode', (public.sc_cfg('mode'))#>>'{}', 'live_sports', public.sc_cfg('live_sports'));
end $$;

create or replace function public.sc_require_run(p_run uuid)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.sc_runs where run_id = p_run and status = 'running') then
    raise exception 'sc: run % is not running (begin a run first; a finished run takes no more writes)', p_run;
  end if;
end $$;

create or replace function public.sc_current(p_keys text[])
returns table (signal_key text, signal_id bigint, version integer, version_hash text, payload jsonb, lifecycle text, publication text)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.signal_key, s.signal_id, v.version, v.version_hash, v.payload, s.lifecycle, s.publication
    from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id
   where s.signal_key = any (p_keys[1:2000]);
$$;

create or replace function public.sc_prior_divergences()
returns table (payload jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  -- a disagreement whose closing is already on record is not a candidate
  -- again: a convergence is recorded once, not once per later quote
  select v.payload from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id
   where s.category = 'MARKET_DIVERGENCE' and s.lifecycle = 'ACTIVE' and s.verification_state = 'VERIFIED' and (s.event_at is null or s.event_at > now())
     and not exists (select 1 from public.sc_signals c join public.sc_signal_versions cv on cv.version_id = c.current_version_id
                      where c.category = 'MARKET_CONVERGENCE' and c.event_key = s.event_key and cv.payload#>>'{identity,from}' = s.signal_key)
   order by s.signal_id desc limit 2000;
$$;

-- active signals of the given categories, for the worker's re-verification of
-- their source records (a record that disappears invalidates the signal)
create or replace function public.sc_active(p_categories text[], p_limit integer default 2000)
returns table (signal_key text, payload jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.signal_key, v.payload from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id
   where s.lifecycle = 'ACTIVE' and s.category = any (p_categories) and s.verification_state = 'VERIFIED'
   order by s.signal_id desc limit greatest(1, least(coalesce(p_limit, 2000), 5000));
$$;

-- the current versions that still need a graphic at this template version
-- (verified, not withdrawn, at or above sc_config.graphics.min_label), and any
-- an operator asked to regenerate since its newest graphic; highest score first
create or replace function public.sc_graphics_due(p_template_version text, p_limit integer default 150)
returns table (version_id bigint, signal_id bigint, version integer, payload_sha256 text, payload jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select v.version_id, s.signal_id, v.version, v.payload_sha256, v.payload
    from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id
   where coalesce((public.sc_cfg('graphics')->>'auto')::boolean, true)
     and s.verification_state = 'VERIFIED' and s.publication <> 'WITHDRAWN' and s.lifecycle in ('ACTIVE', 'EXPIRED')
     and s.category in ('FORECAST_SHIFT', 'MARKET_DIVERGENCE', 'MARKET_CONVERGENCE', 'LINE_MOVEMENT', 'INJURY_IMPACT', 'SIMULATION_SHIFT', 'MODEL_RELIABILITY_WARNING')
     and public.sc_label_rank(s.label) >= public.sc_label_rank(coalesce(public.sc_cfg('graphics')->>'min_label', 'Notable'))
     and (not exists (select 1 from public.sc_graphics g where g.version_id = v.version_id and g.template_version = p_template_version)
          or exists (select 1 from public.sc_signal_events e where e.signal_id = s.signal_id and e.kind = 'regenerate_requested'
                      and e.at > coalesce((select max(g.generated_at) from public.sc_graphics g where g.signal_id = s.signal_id), '-infinity')))
   order by (s.lifecycle = 'ACTIVE') desc, s.score desc, s.signal_id desc
   limit greatest(1, least(coalesce(p_limit, 150), 500));
$$;

-- the server's own check of a simulator signal: both runs' numbers must be the
-- published rows, to four decimals. Returns null when the Simulator is not
-- installed here (the check is then reported as not run, never as passed).
create or replace function public.sc_check_simulation(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ent text := p#>>'{subject,entity_id}'; oc text := p#>>'{outcome,id}'; prev_ok boolean; cur_ok boolean;
begin
  if to_regclass('public.sim_team_results') is null or to_regclass('public.sim_runs') is null then return null; end if;
  execute 'select exists (select 1 from public.sim_team_results t join public.sim_runs r on r.run_id = t.run_id where t.run_id = $1::uuid and t.entity_id = $2 and t.outcome = $3 and r.status in (''completed'',''superseded'') and round(t.probability::numeric, 4) = round(($4)::numeric, 4))'
    into prev_ok using p#>>'{values,previous,run_id}', ent, oc, p#>>'{values,previous,value}';
  execute 'select exists (select 1 from public.sim_team_results t join public.sim_runs r on r.run_id = t.run_id where t.run_id = $1::uuid and t.entity_id = $2 and t.outcome = $3 and r.status in (''completed'',''superseded'') and round(t.probability::numeric, 4) = round(($4)::numeric, 4))'
    into cur_ok using p#>>'{values,current,run_id}', ent, oc, p#>>'{values,current,value}';
  return jsonb_build_object('previous', prev_ok, 'current', cur_ok, 'ok', prev_ok and cur_ok);
exception when others then return jsonb_build_object('ok', false, 'error', sqlerrm);
end $$;

-- one item: validate, lock its key, insert or version it, place it
create or replace function public.sc_ingest_one(p_run uuid, p jsonb, p_reason text, p_mode text, p_live jsonb, p_min_label text, p_allow_fixtures boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k text := p->>'signal_key'; h text := p->>'version_hash'; cat text := p->>'category';
  s record; v_id bigint; v_sig bigint; v_ver integer; v_state text := p#>>'{verification,state}'; v_check jsonb;
  v_pub text; v_life text := 'ACTIVE'; v_event_at timestamptz; v_fixture boolean := coalesce((p->>'fixture')::boolean, false);
  v_reason text := coalesce(nullif(p_reason, ''), 'evidence_update'); v_sha text;
  v_backfilled boolean := coalesce((p->>'backfilled')::boolean, false); v_signal_at timestamptz; v_source_at timestamptz; v_newer bigint;
begin
  -- shape
  if coalesce(p->>'schema', '') <> 'edgedesk_signal_v1' then return jsonb_build_object('signal_key', k, 'rejected', 'schema is not edgedesk_signal_v1'); end if;
  if k is null or k !~ '^sc1-[0-9a-f]{16}$' then return jsonb_build_object('signal_key', k, 'rejected', 'bad signal_key'); end if;
  if h is null or h !~ '^sv1-[0-9a-f]{16}$' then return jsonb_build_object('signal_key', k, 'rejected', 'bad version_hash'); end if;
  if v_state is null or v_state not in ('VERIFIED', 'UNVERIFIED', 'INVALIDATED') then return jsonb_build_object('signal_key', k, 'rejected', 'verification state missing'); end if;
  if coalesce(p->>'headline', '') = '' or coalesce(p->>'public_headline', '') = '' then return jsonb_build_object('signal_key', k, 'rejected', 'headline missing'); end if;
  if not public.sc_copy_ok(p->>'headline') or not public.sc_copy_ok(p->>'public_headline') or not public.sc_copy_ok(p->>'summary') or not public.sc_copy_ok(p#>>'{evidence,summary}') then
    return jsonb_build_object('signal_key', k, 'rejected', 'copy rule: research, not picks');
  end if;
  if to_regprocedure('public.edp_copy_ok(text)') is not null then
    declare ok boolean; begin execute 'select public.edp_copy_ok($1) and public.edp_copy_ok($2)' into ok using p->>'headline', p->>'summary'; if not ok then return jsonb_build_object('signal_key', k, 'rejected', 'copy rule (edp_copy_ok)'); end if; end;
  end if;
  if v_fixture and not p_allow_fixtures then return jsonb_build_object('signal_key', k, 'rejected', 'fixture payloads are refused here (sc_config.allow_fixtures is false)'); end if;
  if coalesce((p#>>'{score,total}')::numeric, -1) not between 0 and 100 then return jsonb_build_object('signal_key', k, 'rejected', 'score out of range'); end if;

  -- the server's own check where the source lives here
  if cat = 'SIMULATION_SHIFT' then
    v_check := public.sc_check_simulation(p);
    if v_check is not null and not coalesce((v_check->>'ok')::boolean, false) and v_state = 'VERIFIED' then v_state := 'UNVERIFIED'; end if;
  end if;

  v_event_at := nullif(p#>>'{event,at}', '')::timestamptz;
  v_source_at := nullif(p#>>'{timestamps,source_published_at}', '')::timestamptz;
  if v_event_at is not null and v_event_at <= now() then v_life := 'EXPIRED'; end if;
  if v_state = 'INVALIDATED' then v_life := 'WITHDRAWN'; end if;
  -- a backfilled signal is placed at the record it was scored as of; anything
  -- else at its detection. Never in the future.
  v_signal_at := case when v_backfilled then least(now(), coalesce(nullif(p#>>'{timestamps,scored_as_of}', '')::timestamptz, v_source_at, now())) else now() end;
  v_sha := encode(sha256(convert_to(p::text, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtext('public.sc_signals ' || k));
  select * into s from public.sc_signals where signal_key = k;

  if not found then
    -- placement in time: a newer signal about the same subject and outcome
    -- already stored (a backfill can find the older one second) makes this
    -- one history at once, exactly as if it had been found first
    if v_life <> 'WITHDRAWN' and v_source_at is not null then
      select o.signal_id into v_newer from public.sc_signals o
       where o.category = cat and o.subject_key = p#>>'{subject,key}' and o.outcome_id = p#>>'{outcome,id}' and o.event_key is not distinct from p#>>'{event,key}'
         and o.lifecycle in ('ACTIVE', 'EXPIRED', 'SUPERSEDED') and o.source_at > v_source_at
       order by o.source_at desc, o.signal_id desc limit 1;
      if v_newer is not null then v_life := 'SUPERSEDED'; end if;
    end if;
    -- published: a live run, a live sport, VERIFIED, at or above the label,
    -- not a fixture, and not withdrawn. History (expired, or superseded by a
    -- newer record) is published as history; notices go only to fresh,
    -- active, non-backfilled signals (sc_notify)
    v_pub := case when v_fixture then 'SHADOW'
                  when p_mode = 'live' and v_state = 'VERIFIED' and v_life <> 'WITHDRAWN' and public.sc_sport_live(p_live, p->>'sport') and public.sc_label_rank(p#>>'{score,label}') >= public.sc_label_rank(p_min_label) then 'PUBLISHED'
                  else 'SHADOW' end;
    insert into public.sc_signals (signal_key, category, subtype, sport, league, season, event_kind, subject_key, subject_label, outcome_id, event_key, event_at, teams, market_type,
        headline, public_headline, change_pp, evidence_class, evidence_rank, verification_state, score, label, rarity, reliability_grade, research_grade, model_version, source_at, fixture,
        backfilled, signal_at, superseded_by,
        lifecycle, lifecycle_reason, publication, publication_by, published_at, first_run_id, current_version)
    values (k, cat, p->>'subtype', p->>'sport', p->>'league', p->>'season', p->>'event_kind', p#>>'{subject,key}', p#>>'{subject,label}', p#>>'{outcome,id}', p#>>'{event,key}', v_event_at,
        coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'teams', '[]'::jsonb)) x), '{}'), p->>'market_type',
        p->>'headline', p->>'public_headline', nullif(p#>>'{values,change_pp}', '')::numeric, p#>>'{evidence,class}',
        case p#>>'{evidence,class}' when 'CONFIRMED_CAUSE' then 4 when 'SUPPORTED_ASSOCIATION' then 3 when 'OBSERVED' then 3 when 'UNEXPLAINED' then 1 else 0 end,
        v_state, (p#>>'{score,total}')::numeric, p#>>'{score,label}', nullif(p#>>'{values,distribution,rarity}', '')::numeric, p#>>'{reliability,grade}', p#>>'{research_grade,letter}',
        p#>>'{model,version}', v_source_at, v_fixture,
        v_backfilled, v_signal_at, v_newer,
        v_life, case when v_life = 'EXPIRED' and p->>'event_kind' = 'season' then 'the competition had ended when the signal was detected'
                     when v_life = 'EXPIRED' then 'the event had started when the signal was detected' when v_life = 'WITHDRAWN' then 'invalidated at detection'
                     when v_life = 'SUPERSEDED' then 'a newer signal about the same subject and outcome was already on record' end,
        v_pub, 'system', case when v_pub = 'PUBLISHED' then now() end, p_run, 1)
    returning signal_id into v_sig;
    insert into public.sc_signal_versions (signal_id, version, version_hash, payload, payload_sha256, reason, run_id, engine_version, spec_version)
    values (v_sig, 1, h, p, v_sha, 'initial', p_run, coalesce(p->>'engine_version', '?'), coalesce(p->>'spec_version', '?'))
    returning version_id into v_id;
    update public.sc_signals set current_version_id = v_id where signal_id = v_sig;
    perform public.sc_event(v_sig, 'detected', 'system', p_run, jsonb_build_object('version', 1, 'verification', v_state, 'lifecycle', v_life));
    if v_check is not null then perform public.sc_event(v_sig, 'server_check', 'system', p_run, v_check); end if;
    if v_pub = 'PUBLISHED' then perform public.sc_event(v_sig, 'published', 'system', p_run, '{}'); end if;
    if v_life = 'SUPERSEDED' then perform public.sc_event(v_sig, 'superseded', 'system', p_run, jsonb_build_object('by', v_newer, 'note', 'the newer signal was stored first')); end if;
    -- an older signal about the same thing, from an earlier record, is
    -- superseded (an expired one too: a backfill stores history in any order)
    if v_life in ('ACTIVE', 'EXPIRED') then
      with old as (
        update public.sc_signals o set lifecycle = 'SUPERSEDED', lifecycle_reason = 'a newer signal about the same subject and outcome', superseded_by = v_sig
         where o.lifecycle in ('ACTIVE', 'EXPIRED') and o.signal_id <> v_sig and o.category = cat and o.subject_key = p#>>'{subject,key}' and o.outcome_id = p#>>'{outcome,id}'
           and o.event_key is not distinct from p#>>'{event,key}'
           and coalesce(o.source_at, '-infinity') <= coalesce(v_source_at, 'infinity')
        returning o.signal_id)
      insert into public.sc_signal_events (signal_id, kind, actor, run_id, detail) select signal_id, 'superseded', 'system', p_run, jsonb_build_object('by', v_sig) from old;
    end if;
    return jsonb_build_object('signal_key', k, 'signal_id', v_sig, 'version_id', v_id, 'version', 1, 'result', 'inserted', 'publication', v_pub, 'verification', v_state, 'lifecycle', v_life, 'label', p#>>'{score,label}', 'payload_sha256', v_sha);
  end if;

  -- known key: the same version is a no-op
  if exists (select 1 from public.sc_signal_versions where signal_id = s.signal_id and version_hash = h) then
    return jsonb_build_object('signal_key', k, 'signal_id', s.signal_id, 'result', 'unchanged', 'publication', s.publication);
  end if;
  if v_reason not in ('evidence_update', 'methodology', 'correction', 'invalidation') then v_reason := 'evidence_update'; end if;
  if v_state = 'INVALIDATED' then v_reason := 'invalidation'; end if;
  v_ver := s.current_version + 1;
  insert into public.sc_signal_versions (signal_id, version, version_hash, payload, payload_sha256, reason, run_id, engine_version, spec_version)
  values (s.signal_id, v_ver, h, p, v_sha, v_reason, p_run, coalesce(p->>'engine_version', '?'), coalesce(p->>'spec_version', '?'))
  returning version_id into v_id;
  -- placement: an operator's hold or withdrawal sticks; an invalidation withdraws
  v_pub := case when v_state = 'INVALIDATED' then 'WITHDRAWN'
                when s.publication in ('HELD', 'WITHDRAWN') then s.publication
                when s.publication = 'PUBLISHED' and v_state <> 'VERIFIED' then 'SHADOW'
                when s.publication = 'SHADOW' and p_mode = 'live' and v_state = 'VERIFIED' and s.lifecycle <> 'WITHDRAWN' and not s.fixture and public.sc_sport_live(p_live, s.sport)
                     and public.sc_label_rank(p#>>'{score,label}') >= public.sc_label_rank(p_min_label) then 'PUBLISHED'
                else s.publication end;
  update public.sc_signals set current_version = v_ver, current_version_id = v_id, headline = p->>'headline', public_headline = p->>'public_headline',
         change_pp = nullif(p#>>'{values,change_pp}', '')::numeric, evidence_class = p#>>'{evidence,class}',
         evidence_rank = case p#>>'{evidence,class}' when 'CONFIRMED_CAUSE' then 4 when 'SUPPORTED_ASSOCIATION' then 3 when 'OBSERVED' then 3 when 'UNEXPLAINED' then 1 else 0 end,
         verification_state = v_state, score = (p#>>'{score,total}')::numeric, label = p#>>'{score,label}', rarity = nullif(p#>>'{values,distribution,rarity}', '')::numeric,
         reliability_grade = p#>>'{reliability,grade}', research_grade = p#>>'{research_grade,letter}', model_version = p#>>'{model,version}',
         source_at = nullif(p#>>'{timestamps,source_published_at}', '')::timestamptz,
         lifecycle = case when v_state = 'INVALIDATED' then 'WITHDRAWN' else lifecycle end,
         lifecycle_reason = case when v_state = 'INVALIDATED' then 'invalidated: a later evaluation could not reproduce it from its sources' else lifecycle_reason end,
         publication = v_pub, publication_by = case when v_pub is distinct from s.publication then 'system' else publication_by end,
         published_at = case when v_pub = 'PUBLISHED' and s.published_at is null then now() else published_at end
   where signal_id = s.signal_id;
  perform public.sc_event(s.signal_id, case when v_state = 'INVALIDATED' then 'invalidated' else 'versioned' end, 'system', p_run, jsonb_build_object('version', v_ver, 'reason', v_reason, 'verification', v_state));
  if v_check is not null then perform public.sc_event(s.signal_id, 'server_check', 'system', p_run, v_check); end if;
  if v_pub = 'PUBLISHED' and s.publication <> 'PUBLISHED' then perform public.sc_event(s.signal_id, 'published', 'system', p_run, '{}'); end if;
  if v_pub = 'WITHDRAWN' and s.publication <> 'WITHDRAWN' then perform public.sc_event(s.signal_id, 'withdrawn', 'system', p_run, jsonb_build_object('reason', 'invalidated')); end if;
  -- the previous version's graphics are no longer current
  -- (an outdated graphic is no longer approved for external publication)
  with g as (update public.sc_graphics set status = case when v_state = 'INVALIDATED' then 'WITHDRAWN' else 'OUTDATED' end,
                     external_approval = case when external_approval = 'APPROVED' then 'REVOKED' else external_approval end
              where signal_id = s.signal_id and version_id <> v_id and status = 'READY' returning graphic_id, status)
  insert into public.sc_signal_events (signal_id, kind, actor, run_id, detail)
  select s.signal_id, case when g.status = 'WITHDRAWN' then 'graphic_withdrawn' else 'graphic_outdated' end, 'system', p_run, jsonb_build_object('graphic_id', g.graphic_id, 'new_version', v_ver) from g;
  return jsonb_build_object('signal_key', k, 'signal_id', s.signal_id, 'version_id', v_id, 'version', v_ver, 'result', 'versioned', 'publication', v_pub, 'verification', v_state, 'lifecycle', s.lifecycle, 'label', p#>>'{score,label}', 'payload_sha256', v_sha);
end $$;

create or replace function public.sc_ingest(p_run uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare it jsonb; r jsonb; out jsonb := '[]'::jsonb; n_ins integer := 0; n_ver integer := 0; n_same integer := 0; n_rej integer := 0; n_pub integer := 0;
  v_mode text; v_live jsonb; v_min text; v_fx boolean;
begin
  perform public.sc_require_run(p_run);
  if jsonb_typeof(p_items) <> 'array' then raise exception 'sc_ingest: items must be an array'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'sc_ingest: at most 500 items per call'; end if;
  v_mode := (select mode from public.sc_runs where run_id = p_run);
  if v_mode = 'dry' then v_mode := 'shadow'; end if;
  v_live := coalesce(public.sc_cfg('live_sports'), '[]'::jsonb);
  v_min := coalesce(public.sc_cfg('publish')->>'min_label', 'Routine');
  v_fx := coalesce((public.sc_cfg('allow_fixtures'))::text::boolean, false);
  for it in select * from jsonb_array_elements(p_items) loop
    begin
      r := public.sc_ingest_one(p_run, coalesce(it->'payload', it), it->>'reason', v_mode, v_live, v_min, v_fx);
    exception when others then
      r := jsonb_build_object('signal_key', coalesce(it#>>'{payload,signal_key}', it->>'signal_key'), 'rejected', 'error: ' || sqlerrm);
    end;
    if r ? 'rejected' then
      n_rej := n_rej + 1;
      insert into public.sc_failures (run_id, stage, item_key, error, detail) values (p_run, 'ingest', r->>'signal_key', r->>'rejected', jsonb_build_object('category', coalesce(it#>>'{payload,category}', it->>'category')));
    elsif r->>'result' = 'inserted' then n_ins := n_ins + 1;
    elsif r->>'result' = 'versioned' then n_ver := n_ver + 1;
    else n_same := n_same + 1; end if;
    if r->>'publication' = 'PUBLISHED' and r->>'result' in ('inserted', 'versioned') then n_pub := n_pub + 1; end if;
    out := out || jsonb_build_array(r);
  end loop;
  return jsonb_build_object('inserted', n_ins, 'versioned', n_ver, 'unchanged', n_same, 'rejected', n_rej, 'published', n_pub, 'items', out);
end $$;

create or replace function public.sc_put_graphics(p_run uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare it jsonb; v record; n_new integer := 0; n_same integer := 0; n_bad integer := 0; v_id bigint; v_status text; v_sha text;
begin
  perform public.sc_require_run(p_run);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'sc_put_graphics: an array of at most 500 items'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select sv.version_id, sv.signal_id, sv.payload_sha256, s.current_version_id, s.publication into v
      from public.sc_signal_versions sv join public.sc_signals s on s.signal_id = sv.signal_id where sv.version_id = (it->>'version_id')::bigint;
    if not found then n_bad := n_bad + 1; insert into public.sc_failures (run_id, stage, item_key, error) values (p_run, 'graphics', it->>'version_id', 'no such signal version'); continue; end if;
    if v.version_id <> v.current_version_id then n_bad := n_bad + 1; insert into public.sc_failures (run_id, stage, item_key, error) values (p_run, 'graphics', it->>'version_id', 'not the current version: a graphic is drawn for the current version only'); continue; end if;
    if coalesce(it->>'payload_sha256', '') <> v.payload_sha256 then n_bad := n_bad + 1; insert into public.sc_failures (run_id, stage, item_key, error) values (p_run, 'graphics', it->>'version_id', 'the graphic was built from a different payload than the stored version'); continue; end if;
    v_status := case when it ? 'error' and coalesce(it->>'error', '') <> '' then 'FAILED' else 'READY' end;
    if v_status = 'READY' and (it->'content' is null or jsonb_typeof(it->'content') <> 'object') then v_status := 'FAILED'; end if;
    v_sha := case when v_status = 'READY' then encode(sha256(convert_to((it->'content')::text, 'UTF8')), 'hex') end;
    insert into public.sc_graphics (signal_id, version_id, template, template_version, format, content, content_sha256, payload_sha256, status, error)
    values (v.signal_id, v.version_id, it->>'template', it->>'template_version', it->>'format', case when v_status = 'READY' then it->'content' end, v_sha, v.payload_sha256, v_status,
            case when v_status = 'FAILED' then coalesce(nullif(it->>'error', ''), 'no content') end)
    on conflict (version_id, template, template_version, format) do nothing
    returning graphic_id into v_id;
    if v_id is null then n_same := n_same + 1; continue; end if;
    n_new := n_new + 1;
    perform public.sc_event(v.signal_id, case when v_status = 'READY' then 'graphic_ready' else 'graphic_failed' end, 'system', p_run,
      jsonb_build_object('graphic_id', v_id, 'template', it->>'template', 'format', it->>'format', 'template_version', it->>'template_version', 'error', it->>'error'));
    -- an older template version of the same graphic is no longer current
    update public.sc_graphics set status = 'OUTDATED', external_approval = case when external_approval = 'APPROVED' then 'REVOKED' else external_approval end
     where version_id = v.version_id and template = it->>'template' and format = it->>'format'
       and template_version <> it->>'template_version' and status = 'READY' and v_status = 'READY';
  end loop;
  return jsonb_build_object('generated', n_new, 'unchanged', n_same, 'refused', n_bad);
end $$;

create or replace function public.sc_put_dna(p_run uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare it jsonb; n integer := 0; v_sha text;
begin
  perform public.sc_require_run(p_run);
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then raise exception 'sc_put_dna: an array of at most 100 records'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce(it->>'schema', '') <> 'edgedesk_model_dna_v1' then insert into public.sc_failures (run_id, stage, item_key, error) values (p_run, 'dna', it->>'model_key', 'not a Model DNA record'); continue; end if;
    v_sha := encode(sha256(convert_to(it::text, 'UTF8')), 'hex');
    insert into public.sc_model_dna (model_key, sport, grade, record, record_sha256, evaluated_at, run_id)
    values (it->>'model_key', it->>'sport', it->>'grade', it, v_sha, nullif(it->>'evaluated_at', '')::timestamptz, p_run)
    on conflict (model_key, record_sha256) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('stored', n);
end $$;

create or replace function public.sc_fail(p_run uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare it jsonb; n integer := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'sc_fail: an array of at most 500 items'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.sc_failures (run_id, stage, item_key, error, detail) values (p_run, coalesce(it->>'stage', 'worker'), it->>'item_key', coalesce(it->>'error', 'unknown'), coalesce(it->'detail', '{}'::jsonb));
    n := n + 1;
  end loop;
  return jsonb_build_object('recorded', n);
end $$;

-- THE ONE PLACEMENT RULE for what is still SHADOW, the same as sc_ingest_one
-- publishes by: VERIFIED, not a fixture, not withdrawn (history included:
-- expired, or superseded by a newer record), a live sport, at or above
-- publish.min_label (a shared source's warning by sc_sport_live). Only the system's own placements move; HELD and
-- WITHDRAWN (an operator's decisions) never do. Two callers: the switch to
-- live (sc_promote_shadow) and every live run (sc_publish_pending). The
-- callers check the mode; notices are never sent for history (sc_notify).
create or replace function public.sc_place_shadow(p_actor text, p_run uuid, p_reason text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer := 0; v_live jsonb := coalesce(public.sc_cfg('live_sports'), '[]'::jsonb);
  v_min text := coalesce(public.sc_cfg('publish')->>'min_label', 'Routine');
begin
  with p as (
    update public.sc_signals s set publication = 'PUBLISHED', publication_by = 'system', published_at = coalesce(s.published_at, now())
     where s.publication = 'SHADOW' and coalesce(s.publication_by, 'system') = 'system'
       and s.verification_state = 'VERIFIED' and s.lifecycle <> 'WITHDRAWN' and not s.fixture
       and public.sc_sport_live(v_live, s.sport) and public.sc_label_rank(s.label) >= public.sc_label_rank(v_min)
    returning s.signal_id)
  insert into public.sc_signal_events (signal_id, kind, actor, run_id, detail)
  select signal_id, 'published', p_actor, p_run, jsonb_build_object('reason', p_reason) from p;
  get diagnostics n = row_count;
  return n;
end $$;

-- a run that began in live mode places what is still SHADOW: what a shadow
-- period stored (the backfilled history included), and what an earlier engine
-- stored before history was publishable, without waiting for a new version
create or replace function public.sc_publish_pending(p_run uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.sc_require_run(p_run);
  if (select mode from public.sc_runs where run_id = p_run) is distinct from 'live' then return 0; end if;
  return public.sc_place_shadow('system', p_run, 'stored unpublished; published by a live run');
end $$;

create or replace function public.sc_expire()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  -- a game expires when it starts; a season-kind signal (a tournament) carries
  -- the time its competition ends instead
  with e as (update public.sc_signals set lifecycle = 'EXPIRED', lifecycle_reason = case when event_kind = 'season' then 'the competition it is about has ended' else 'the event started' end
              where lifecycle = 'ACTIVE' and event_at is not null and event_at <= now() returning signal_id)
  insert into public.sc_signal_events (signal_id, kind, actor, detail) select signal_id, 'expired', 'system', '{}'::jsonb from e;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sc_finish_run(p_run uuid, p_status text, p_counts jsonb, p_error jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if p_status not in ('completed', 'failed') then raise exception 'sc_finish_run: completed or failed'; end if;
  update public.sc_runs set status = p_status, finished_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = p_error where run_id = p_run and status = 'running';
  if not found then raise exception 'sc_finish_run: run % is not running', p_run; end if;
  n := public.sc_expire();
  return jsonb_build_object('run_id', p_run, 'status', p_status, 'expired', n);
end $$;

-- the notice fan-out: published, active, recent signals to entitled readers
-- who asked for them, once per signal, one per subject per cooldown window.
-- The notice is a public.user_alerts row (the bell readers already have),
-- under the existing kinds; nothing is sent outside EdgeDesk.
create or replace function public.sc_notify(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg jsonb := coalesce(public.sc_cfg('notify'), '{}'::jsonb); s record; u record; n integer := 0; skipped integer := 0; v_alert bigint; v_kind text; v_sev text; v_max integer;
  v_run_cap integer := greatest(1, coalesce((cfg->>'max_per_reader_run')::integer, 5)); v_day_cap integer := greatest(1, coalesce((cfg->>'max_per_reader_day')::integer, 20));
begin
  perform public.sc_require_run(p_run);
  if to_regclass('public.user_alerts') is null then return jsonb_build_object('sent', 0, 'note', 'public.user_alerts is not installed: no notices'); end if;
  v_max := coalesce((cfg->>'max_per_run')::integer, 500);
  for s in select x.*, v.payload from public.sc_signals x join public.sc_signal_versions v on v.version_id = x.current_version_id
            where x.publication = 'PUBLISHED' and x.lifecycle = 'ACTIVE' and x.verification_state = 'VERIFIED' and not x.fixture and not x.backfilled
              and x.published_at >= now() - make_interval(hours => coalesce((cfg->>'window_hours')::integer, 24))
              and x.signal_at >= now() - make_interval(hours => coalesce((cfg->>'window_hours')::integer, 24))
              and public.sc_label_rank(x.label) >= public.sc_label_rank(coalesce(cfg->>'min_label', 'Notable'))
            order by x.score desc, x.signal_id desc loop
    for u in select p.* from public.sc_preferences p
              where p.notify and public.sc_label_rank(s.label) >= public.sc_label_rank(p.min_label)
                and (cardinality(p.sports) = 0 or s.sport = any (p.sports))
                and (cardinality(p.categories) = 0 or s.category = any (p.categories))
                and (cardinality(p.teams) = 0 or s.teams && (select array_agg(lower(t)) from unnest(p.teams) t))
                and not exists (select 1 from public.sc_notification_log l where l.user_id = p.user_id and l.signal_id = s.signal_id)
              order by p.user_id loop
      if n >= v_max then exit; end if;
      if not public.sc_user_entitled(u.user_id) then skipped := skipped + 1; continue; end if;
      if exists (select 1 from public.sc_notification_log l where l.user_id = u.user_id and l.subject_key = s.subject_key and not l.held
                  and l.sent_at > now() - make_interval(hours => coalesce((cfg->>'cooldown_hours')::integer, 6))) then skipped := skipped + 1; continue; end if;
      -- a reader hears about the most important few, never a flood: at most
      -- max_per_reader_run in this call (one transaction, so sent_at = now()) and
      -- max_per_reader_day in 24 hours, highest score first. What the cap holds
      -- back is logged as held, so no later run drips it out hours late
      if (select count(*) from public.sc_notification_log l where l.user_id = u.user_id and not l.held and l.sent_at = now()) >= v_run_cap
         or (select count(*) from public.sc_notification_log l where l.user_id = u.user_id and not l.held and l.sent_at > now() - interval '24 hours') >= v_day_cap then
        insert into public.sc_notification_log (user_id, signal_id, subject_key, alert_id, held) values (u.user_id, s.signal_id, s.subject_key, null, true) on conflict do nothing;
        skipped := skipped + 1; continue;
      end if;
      v_kind := case s.category when 'FORECAST_SHIFT' then 'fair_move' when 'SIMULATION_SHIFT' then 'fair_move' when 'MARKET_DIVERGENCE' then 'diverge'
                  when 'MARKET_CONVERGENCE' then 'converge' when 'LINE_MOVEMENT' then 'market_move' when 'INJURY_IMPACT' then 'injury_change' else 'reliability_change' end;
      v_sev := case when s.category in ('MODEL_RELIABILITY_WARNING', 'DATA_QUALITY_WARNING') then 'caution' when s.label = 'Major' then 'notable' else 'info' end;
      v_alert := null;
      execute 'insert into public.user_alerts (user_id, game_key, kind, title, body, severity, payload, dedupe_key)
               values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (user_id, dedupe_key) do nothing returning id'
        into v_alert
        using u.user_id, case when s.sport in ('nfl', 'cfb') and s.event_kind = 'game' then s.event_key end, v_kind, left(s.headline, 160), left(s.payload->>'summary', 600), v_sev,
              jsonb_build_object('source', 'signal_center', 'signal_id', s.signal_id, 'href', '#signals/s/' || s.signal_id, 'category', s.category, 'label', s.label),
              'sc:' || s.signal_key;
      insert into public.sc_notification_log (user_id, signal_id, subject_key, alert_id) values (u.user_id, s.signal_id, s.subject_key, v_alert) on conflict do nothing;
      if v_alert is not null then n := n + 1; end if;
    end loop;
    if n >= v_max then exit; end if;
  end loop;
  return jsonb_build_object('sent', n, 'skipped', skipped);
end $$;

-- ---------------------------------------------------------------- reader doors
-- the item a reader sees in a list: Full Access gets the numbers; the preview
-- gets the number-free headline and the evidence class only
create or replace function public.sc_item(s public.sc_signals, p_full boolean)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_full then
    jsonb_build_object('signal_id', s.signal_id, 'signal_key', s.signal_key, 'category', s.category, 'subtype', s.subtype, 'sport', s.sport, 'league', s.league,
      'event_kind', s.event_kind, 'subject', s.subject_label, 'event_key', s.event_key, 'event_at', s.event_at, 'headline', s.headline, 'public_headline', s.public_headline,
      'change_pp', s.change_pp, 'score', s.score, 'label', s.label, 'evidence_class', s.evidence_class, 'verification', s.verification_state, 'rarity', s.rarity,
      'reliability_grade', s.reliability_grade, 'research_grade', s.research_grade, 'model_version', s.model_version, 'market_type', s.market_type,
      'first_detected_at', s.first_detected_at, 'signal_at', s.signal_at, 'source_at', s.source_at, 'lifecycle', s.lifecycle, 'publication', s.publication, 'version', s.current_version,
      'fixture', s.fixture,
      'event', v.payload->'event', 'values', jsonb_build_object('previous', v.payload#>'{values,previous}', 'current', v.payload#>'{values,current}', 'change_display', v.payload#>'{values,change_display}', 'unit', v.payload#>'{values,unit}'),
      'links', v.payload->'links', 'summary', v.payload->>'summary', 'timestamps', v.payload->'timestamps', 'backfilled', s.backfilled,
      'graphics', (select count(*) from public.sc_graphics g where g.version_id = s.current_version_id and g.status = 'READY'))
  else
    jsonb_build_object('signal_id', s.signal_id, 'category', s.category, 'sport', s.sport, 'league', s.league, 'event_kind', s.event_kind, 'subject', s.subject_label,
      'event_at', s.event_at, 'event_label', v.payload#>>'{event,label}', 'public_headline', s.public_headline, 'label', s.label, 'evidence_class', s.evidence_class,
      'explanation', v.payload->>'public_summary', 'first_detected_at', s.first_detected_at, 'signal_at', s.signal_at, 'backfilled', s.backfilled, 'locked', true)
  end
  from public.sc_signal_versions v where v.version_id = s.current_version_id;
$$;

create or replace function public.sc_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; f jsonb := coalesce(public.sc_cfg('free'), '{}'::jsonb);
begin
  select run_id, status, started_at, finished_at, counts into r from public.sc_runs order by started_at desc limit 1;
  return jsonb_build_object('deployed', true, 'mode', (public.sc_cfg('mode'))#>>'{}', 'live_sports', public.sc_cfg('live_sports'),
    'entitled', public.sc_viewer_entitled(), 'admin', public.sc_is_admin(), 'signed_in', auth.uid() is not null,
    'last_run', case when r.run_id is null then null else jsonb_build_object('status', r.status, 'started_at', r.started_at, 'finished_at', r.finished_at,
       'signals', r.counts->'signals', 'published', r.counts->'published') end,
    'last_completed_at', (select max(finished_at) from public.sc_runs where status = 'completed'),
    'free', jsonb_build_object('feed_limit', f->'feed_limit', 'max_age_hours', f->'max_age_hours', 'min_label', f->'min_label', 'categories', f->'categories'));
end $$;

-- Research Pulse: counts of published signals whose moment (signal_at) is in
-- the window, so a backfill counts on the day each change happened. Counts
-- only: no number, no headline, so anyone may see how much changed. An
-- operator in shadow mode counts the unpublished (shadow) signals too, the
-- same ones their feed shows, and the answer says so.
create or replace function public.sc_pulse(p_hours integer default 24)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare h integer := greatest(1, least(coalesce(p_hours, 24), 24 * 14)); j jsonb;
  v_shadow boolean := public.sc_is_admin() and coalesce((public.sc_cfg('mode'))#>>'{}', 'shadow') = 'shadow';
begin
  select jsonb_build_object(
    'hours', h,
    'published', count(*),
    'major', count(*) filter (where label = 'Major'),
    'notable', count(*) filter (where label = 'Notable'),
    'forecast_shifts', count(*) filter (where category = 'FORECAST_SHIFT' and evidence_class <> 'MODEL_VERSION_CHANGE' and abs_change_pp >= 5),
    'model_version_changes', count(*) filter (where category = 'FORECAST_SHIFT' and evidence_class = 'MODEL_VERSION_CHANGE'),
    'market_divergences', count(*) filter (where category = 'MARKET_DIVERGENCE' and label in ('Major', 'Notable')),
    'availability', count(*) filter (where category = 'INJURY_IMPACT'),
    'simulator', count(*) filter (where category = 'SIMULATION_SHIFT'),
    'reliability_warnings', count(*) filter (where category = 'MODEL_RELIABILITY_WARNING'),
    'freshness_warnings', count(*) filter (where category = 'DATA_QUALITY_WARNING' and lifecycle = 'ACTIVE'),
    'backfilled', count(*) filter (where backfilled),
    'by_sport', coalesce((select jsonb_object_agg(sport, n) from (select sport, count(*) n from public.sc_signals
                  where (publication = 'PUBLISHED' or (v_shadow and publication = 'SHADOW')) and verification_state = 'VERIFIED' and not fixture
                    and signal_at >= now() - make_interval(hours => h) group by sport) q), '{}'::jsonb),
    'includes_unpublished', v_shadow,
    'since', now() - make_interval(hours => h),
    'last_completed_at', (select max(finished_at) from public.sc_runs where status = 'completed'))
  into j
  from public.sc_signals
  where (publication = 'PUBLISHED' or (v_shadow and publication = 'SHADOW')) and verification_state = 'VERIFIED' and not fixture and signal_at >= now() - make_interval(hours => h);
  return j;
end $$;

-- the free preview: published, verified, recent, in the free categories, at
-- or above the free label, number-free; operator-pinned first; the limit is
-- sc_config.free.feed_limit. Example graphics are published signals whose
-- event is history (older than example_min_age_hours), labelled as examples.
create or replace function public.sc_public_feed(p_limit integer default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f jsonb := coalesce(public.sc_cfg('free'), '{}'::jsonb); lim integer; items jsonb; ex jsonb;
begin
  lim := least(coalesce(p_limit, 100), coalesce((f->>'feed_limit')::integer, 3), 20);
  select coalesce(jsonb_agg(public.sc_item(t.x, false) order by t.pin desc, t.score desc, t.sid desc), '[]'::jsonb) into items
    from (select x, x.public_preview as pin, x.score as score, x.signal_id as sid from public.sc_signals x
           where x.publication = 'PUBLISHED' and x.verification_state = 'VERIFIED' and not x.fixture and x.lifecycle in ('ACTIVE', 'EXPIRED')
             and x.signal_at >= now() - make_interval(hours => coalesce((f->>'max_age_hours')::integer, 72))
             and (x.public_preview or (f->'categories' ? x.category and public.sc_label_rank(x.label) >= public.sc_label_rank(coalesce(f->>'min_label', 'Notable'))))
           order by x.public_preview desc, x.score desc, x.signal_id desc limit lim) t;
  select coalesce(jsonb_agg(jsonb_build_object('signal_id', g.signal_id, 'template', g.template, 'format', g.format, 'content', g.content, 'content_sha256', g.content_sha256,
           'example', true, 'note', 'An example from EdgeDesk’s published history. The event has passed; this is not current research.') order by g.generated_at desc), '[]'::jsonb) into ex
    from (select g.* from public.sc_graphics g join public.sc_signals s on s.signal_id = g.signal_id
           where g.status = 'READY' and g.format = 'square' and s.publication = 'PUBLISHED' and s.verification_state = 'VERIFIED' and not s.fixture
             and s.lifecycle = 'EXPIRED' and coalesce(s.event_at, s.first_detected_at) < now() - make_interval(hours => coalesce((f->>'example_min_age_hours')::integer, 72))
           order by g.generated_at desc limit least(coalesce((f->>'example_graphics')::integer, 2), 4)) g;
  return jsonb_build_object('access', 'preview', 'items', items, 'examples', ex, 'limit', lim,
    'note', 'A free preview: what changed, without the numbers. Full Access shows the numbers, the evidence, the model’s record and the history.');
end $$;

-- the feed. Full Access: every published signal, filtered, sorted, keyset-paged.
-- Operators may add shadow and unverified signals. Everyone else: the preview.
create or replace function public.sc_feed(p_filters jsonb default '{}'::jsonb, p_cursor text default null, p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb); full_access boolean := public.sc_viewer_entitled(); adm boolean := public.sc_is_admin();
  lim integer := greatest(1, least(coalesce(p_limit, 25), 100)); sort text := coalesce(f->>'sort', 'recent'); sortexpr text; where_sql text; q text;
  cur jsonb; items jsonb; last_item jsonb; next_cursor text; scope text := coalesce(f->>'scope', 'active');
begin
  if not full_access and not adm then
    return public.sc_public_feed(lim) || jsonb_build_object('reason', case when auth.uid() is null then 'signed_out' else 'not_entitled' end);
  end if;
  sortexpr := case sort
    when 'recent' then 'extract(epoch from s.signal_at)'
    when 'shift' then 'coalesce(s.abs_change_pp, -1)'
    when 'disagreement' then 'coalesce(s.abs_change_pp, -1)'
    when 'evidence' then '(s.evidence_rank * 1000 + s.score)'
    when 'rarity' then 'coalesce(s.rarity, -1)'
    when 'score' then 's.score'
    else null end;
  if sortexpr is null then raise exception 'sc_feed: unknown sort %', sort; end if;
  where_sql := ' where not s.fixture ';
  if adm and coalesce((f->>'include_shadow')::boolean, false) then where_sql := ' where true ';
  else where_sql := where_sql || ' and s.publication = ''PUBLISHED'' and s.verification_state = ''VERIFIED'' '; end if;
  -- active: the event is still ahead; timeline: the latest signal per subject,
  -- current and past (active or expired, not superseded or withdrawn);
  -- history: everything no longer active; all: everything
  if scope not in ('active', 'timeline', 'history', 'all') then raise exception 'sc_feed: unknown scope %', scope; end if;
  where_sql := where_sql || case scope when 'active' then ' and s.lifecycle = ''ACTIVE'' ' when 'timeline' then ' and s.lifecycle in (''ACTIVE'', ''EXPIRED'') '
                                       when 'history' then ' and s.lifecycle <> ''ACTIVE'' ' else '' end;
  if sort = 'shift' then where_sql := where_sql || ' and s.category in (''FORECAST_SHIFT'', ''SIMULATION_SHIFT'', ''LINE_MOVEMENT'') and s.evidence_class <> ''MODEL_VERSION_CHANGE'' '; end if;
  if sort = 'disagreement' then where_sql := where_sql || ' and s.category = ''MARKET_DIVERGENCE'' '; end if;
  if p_cursor is not null then
    begin cur := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb; exception when others then raise exception 'sc_feed: bad cursor'; end;
    if (cur->>'sort') is distinct from sort then raise exception 'sc_feed: the cursor belongs to another sort'; end if;
    where_sql := where_sql || ' and (' || sortexpr || ', s.signal_id) < (($7->>''v'')::numeric, ($7->>''id'')::bigint) ';
  end if;
  q := 'select coalesce(jsonb_agg(public.sc_item(t.s, true) || jsonb_build_object(''_v'', t.v) order by t.v desc, t.sid desc), ''[]''::jsonb) from (select s, ' || sortexpr || ' as v, s.signal_id as sid from public.sc_signals s '
    || where_sql
    || ' and ($1 is null or s.sport = any ($1))'
    || ' and ($2 is null or s.category = any ($2))'
    || ' and ($3 is null or s.subject_label ilike ''%'' || $3 || ''%'' or exists (select 1 from unnest(s.teams) t where t ilike ''%'' || $3 || ''%''))'
    || ' and ($4 is null or public.sc_label_rank(s.label) >= public.sc_label_rank($4))'
    || ' and ($5 is null or s.signal_at >= $5) and ($6 is null or s.signal_at < $6)'
    || ' and ($8 is null or s.event_kind = any ($8))'
    || ' and ($9 is null or s.reliability_grade = any ($9))'
    || ' and ($10 is null or s.market_type = any ($10))'
    || ' and ($11 is null or s.verification_state = any ($11))'
    || ' and ($12 is null or s.evidence_class = any ($12))'
    || ' and ($13 is null or ($13 = ''fresh'' and s.source_at >= now() - interval ''3 hours'') or ($13 = ''stale'' and (s.source_at is null or s.source_at < now() - interval ''3 hours'')))'
    || ' and ($14 is null or s.research_grade = any ($14))'
    || ' order by 2 desc, 3 desc limit ' || (lim + 1) || ') t';
  execute q into items using
    (select array_agg(x) from jsonb_array_elements_text(case when f ? 'sports' then f->'sports' when f ? 'sport' then jsonb_build_array(f->'sport') end) x),
    (select array_agg(x) from jsonb_array_elements_text(case when f ? 'categories' then f->'categories' when f ? 'category' then jsonb_build_array(f->'category') end) x),
    nullif(f->>'team', ''), nullif(f->>'min_label', ''), nullif(f->>'from', '')::timestamptz, nullif(f->>'to', '')::timestamptz, cur,
    (select array_agg(x) from jsonb_array_elements_text(f->'event_kinds') x),
    (select array_agg(x) from jsonb_array_elements_text(f->'reliability') x),
    (select array_agg(x) from jsonb_array_elements_text(f->'market_types') x),
    case when adm then (select array_agg(x) from jsonb_array_elements_text(f->'verification') x) end,
    (select array_agg(x) from jsonb_array_elements_text(f->'evidence') x),
    nullif(f->>'freshness', ''),
    (select array_agg(x) from jsonb_array_elements_text(f->'research_grades') x);
  if jsonb_array_length(items) > lim then
    last_item := items->(lim - 1);
    next_cursor := encode(convert_to(jsonb_build_object('sort', sort, 'v', last_item->'_v', 'id', last_item->'signal_id')::text, 'UTF8'), 'base64');
    next_cursor := replace(next_cursor, E'\n', '');
    items := (select jsonb_agg(e) from (select e from jsonb_array_elements(items) with ordinality a(e, i) where i <= lim order by i) z);
  end if;
  items := (select coalesce(jsonb_agg(e - '_v'), '[]'::jsonb) from jsonb_array_elements(items) e);
  return jsonb_build_object('access', 'full', 'admin', adm, 'items', items, 'next_cursor', next_cursor, 'sort', sort, 'limit', lim);
end $$;

-- one signal in full: its current payload, every version, the audit trail,
-- its graphics and the latest Model DNA for its sport. Preview readers get
-- the free item of a signal that is in the free preview, and nothing else.
create or replace function public.sc_signal(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.sc_signals; full_access boolean := public.sc_viewer_entitled(); adm boolean := public.sc_is_admin(); pv jsonb;
begin
  select * into s from public.sc_signals where signal_id = p_id;
  if not found then return jsonb_build_object('found', false); end if;
  if not adm and (s.fixture or s.publication <> 'PUBLISHED' or s.verification_state <> 'VERIFIED') then return jsonb_build_object('found', false); end if;
  if not full_access and not adm then
    pv := public.sc_public_feed(100);
    if exists (select 1 from jsonb_array_elements(pv->'items') e where (e->>'signal_id')::bigint = p_id) then
      return jsonb_build_object('found', true, 'access', 'preview', 'item', public.sc_item(s, false));
    end if;
    return jsonb_build_object('found', true, 'access', 'locked', 'reason', case when auth.uid() is null then 'signed_out' else 'not_entitled' end);
  end if;
  return jsonb_build_object('found', true, 'access', 'full', 'admin', adm,
    'item', public.sc_item(s, true) || case when adm then jsonb_build_object('public_preview', s.public_preview, 'publication_by', s.publication_by) else '{}'::jsonb end,
    'payload', (select payload from public.sc_signal_versions where version_id = s.current_version_id),
    'payload_sha256', (select payload_sha256 from public.sc_signal_versions where version_id = s.current_version_id),
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'version_hash', v.version_hash, 'reason', v.reason, 'created_at', v.created_at,
                   'headline', v.payload->>'headline', 'change_display', v.payload#>>'{values,change_display}', 'verification', v.payload#>>'{verification,state}', 'label', v.payload#>>'{score,label}') order by v.version), '[]'::jsonb)
                 from public.sc_signal_versions v where v.signal_id = s.signal_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'actor', case when adm then e.actor else case when e.actor = 'system' then 'system' else 'operator' end end, 'detail', e.detail) order by e.at, e.id), '[]'::jsonb)
               from public.sc_signal_events e where e.signal_id = s.signal_id),
    'graphics', (select coalesce(jsonb_agg(jsonb_build_object('graphic_id', g.graphic_id, 'template', g.template, 'template_version', g.template_version, 'format', g.format, 'status', g.status,
                   'content', case when g.status in ('READY', 'OUTDATED') then g.content end, 'content_sha256', g.content_sha256, 'payload_sha256', g.payload_sha256, 'generated_at', g.generated_at,
                   'external_approval', g.external_approval, 'current', g.version_id = s.current_version_id, 'error', case when adm then g.error end) order by g.generated_at desc), '[]'::jsonb)
                 from public.sc_graphics g where g.signal_id = s.signal_id and g.status <> 'WITHDRAWN'),
    'dna', (select d.record from public.sc_model_dna d where d.sport = s.sport order by d.created_at desc, d.id desc limit 1),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object('signal_id', o.signal_id, 'headline', o.headline, 'first_detected_at', o.first_detected_at, 'signal_at', o.signal_at, 'backfilled', o.backfilled, 'lifecycle', o.lifecycle, 'change_pp', o.change_pp) order by o.signal_at, o.signal_id), '[]'::jsonb)
                 from public.sc_signals o where o.category = s.category and o.subject_key = s.subject_key and o.outcome_id = s.outcome_id and o.event_key is not distinct from s.event_key
                   and (adm or (o.publication = 'PUBLISHED' and o.verification_state = 'VERIFIED' and not o.fixture))));
end $$;

create or replace function public.sc_signal_version(p_id bigint, p_version integer)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.sc_signals;
begin
  select * into s from public.sc_signals where signal_id = p_id;
  if not found then return jsonb_build_object('found', false); end if;
  if not public.sc_is_admin() and (not public.sc_viewer_entitled() or s.fixture or s.publication <> 'PUBLISHED' or s.verification_state <> 'VERIFIED') then return jsonb_build_object('found', false); end if;
  return (select jsonb_build_object('found', true, 'version', v.version, 'reason', v.reason, 'created_at', v.created_at, 'payload', v.payload, 'payload_sha256', v.payload_sha256, 'current', v.version_id = s.current_version_id)
            from public.sc_signal_versions v where v.signal_id = p_id and v.version = p_version);
end $$;

create or replace function public.sc_model_dna_current(p_sport text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare full_access boolean := public.sc_viewer_entitled() or public.sc_is_admin();
begin
  return (select coalesce(jsonb_agg(case when full_access then d.record || jsonb_build_object('stored_at', d.created_at, 'history', (
                   select coalesce(jsonb_agg(jsonb_build_object('grade', h.grade, 'evaluated_at', h.evaluated_at, 'n', h.record#>'{live,winner,n}', 'brier', h.record#>'{live,winner,brier}') order by h.created_at), '[]'::jsonb)
                   from public.sc_model_dna h where h.model_key = d.model_key))
                 else jsonb_build_object('model_key', d.model_key, 'sport', d.sport, 'label', d.record->>'label', 'grade', d.grade, 'grade_means', d.record->>'grade_means',
                   'live_n', d.record#>'{live,winner,n}', 'evaluated_at', d.evaluated_at, 'locked', true) end order by d.sport), '[]'::jsonb)
            from (select distinct on (model_key) * from public.sc_model_dna where p_sport is null or sport = p_sport order by model_key, created_at desc, id desc) d);
end $$;

create or replace function public.sc_my_preferences()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select to_jsonb(p) - 'user_id' from public.sc_preferences p where p.user_id = auth.uid()),
    jsonb_build_object('sports', '[]'::jsonb, 'teams', '[]'::jsonb, 'categories', '[]'::jsonb, 'min_label', 'Notable', 'notify', false, 'stored', false));
$$;

create or replace function public.sc_save_preferences(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); v_sports text[]; v_teams text[]; v_cats text[]; v_min text; bad text;
begin
  if uid is null then raise exception 'sign in to save Signal Center preferences' using errcode = '42501'; end if;
  v_sports := coalesce((select array_agg(distinct lower(x)) from jsonb_array_elements_text(coalesce(p->'sports', '[]'::jsonb)) x), '{}');
  v_teams := coalesce((select array_agg(distinct lower(left(x, 60))) from jsonb_array_elements_text(coalesce(p->'teams', '[]'::jsonb)) x where length(trim(x)) > 0), '{}');
  v_cats := coalesce((select array_agg(distinct upper(x)) from jsonb_array_elements_text(coalesce(p->'categories', '[]'::jsonb)) x), '{}');
  v_min := coalesce(nullif(p->>'min_label', ''), 'Notable');
  select x into bad from unnest(v_sports) x where x !~ '^[a-z_]{2,24}$' limit 1;
  if bad is not null then raise exception 'unknown sport %', bad; end if;
  select x into bad from unnest(v_cats) x where x not in ('FORECAST_SHIFT', 'MARKET_DIVERGENCE', 'MARKET_CONVERGENCE', 'LINE_MOVEMENT', 'SIMULATION_SHIFT', 'INJURY_IMPACT',
      'ROSTER_MOVEMENT', 'MODEL_DISAGREEMENT', 'MODEL_RELIABILITY_WARNING', 'HISTORICAL_ANOMALY', 'DATA_QUALITY_WARNING') limit 1;
  if bad is not null then raise exception 'unknown category %', bad; end if;
  insert into public.sc_preferences (user_id, sports, teams, categories, min_label, notify, updated_at)
  values (uid, v_sports, v_teams, v_cats, v_min, coalesce((p->>'notify')::boolean, false), now())
  on conflict (user_id) do update set sports = excluded.sports, teams = excluded.teams, categories = excluded.categories, min_label = excluded.min_label,
     notify = excluded.notify, updated_at = now();
  return public.sc_my_preferences() || jsonb_build_object('stored', true, 'notices_need_full_access', not public.sc_viewer_entitled());
end $$;

create or replace function public.sc_unread_count()
returns integer language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n integer := 0;
begin
  if auth.uid() is null or to_regclass('public.user_alerts') is null then return 0; end if;
  execute 'select count(*) from public.user_alerts where user_id = $1 and read_at is null and dismissed_at is null and payload->>''source'' = ''signal_center''' into n using auth.uid();
  return n;
end $$;

-- ---------------------------------------------------------------- operator doors
create or replace function public.sc_require_admin()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.sc_is_admin() then raise exception 'Signal Center operators only' using errcode = '42501'; end if;
  return auth.uid();
end $$;

create or replace function public.sc_admin_queue(p_filters jsonb default '{}'::jsonb, p_cursor text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb) || jsonb_build_object('include_shadow', true, 'scope', coalesce(p_filters->>'scope', 'all')); r jsonb;
begin
  perform public.sc_require_admin();
  r := public.sc_feed(f, p_cursor, p_limit);
  return r || jsonb_build_object('graphics', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.sc_graphics group by status) q),
    'publication', (select jsonb_object_agg(publication, n) from (select publication, count(*) n from public.sc_signals group by publication) q),
    'open_failures', (select count(*) from public.sc_failures where resolved_at is null),
    'mode', (public.sc_cfg('mode'))#>>'{}', 'live_sports', public.sc_cfg('live_sports'));
end $$;

create or replace function public.sc_admin_act(p_signal bigint, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.sc_require_admin(); s public.sc_signals; actor text;
begin
  actor := 'admin:' || uid::text;
  select * into s from public.sc_signals where signal_id = p_signal for update;
  if not found then raise exception 'no such signal'; end if;
  if p_action = 'publish' then
    if s.fixture then raise exception 'a fixture is never published'; end if;
    if s.verification_state <> 'VERIFIED' then raise exception 'only a VERIFIED signal can be published'; end if;
    if s.publication = 'WITHDRAWN' and coalesce(p_reason, '') = '' then raise exception 'republishing a withdrawn signal needs a reason'; end if;
    update public.sc_signals set publication = 'PUBLISHED', publication_by = actor, published_at = coalesce(published_at, now()) where signal_id = p_signal;
    perform public.sc_event(p_signal, case when s.publication = 'WITHDRAWN' then 'republished' else 'published' end, actor, null, jsonb_build_object('reason', p_reason));
  elsif p_action = 'hold' then
    update public.sc_signals set publication = 'HELD', publication_by = actor where signal_id = p_signal;
    perform public.sc_event(p_signal, 'held', actor, null, jsonb_build_object('reason', p_reason));
  elsif p_action = 'withdraw' then
    if coalesce(p_reason, '') = '' then raise exception 'a withdrawal needs a reason (it is kept in the audit trail)'; end if;
    update public.sc_signals set publication = 'WITHDRAWN', publication_by = actor, lifecycle = 'WITHDRAWN', lifecycle_reason = p_reason where signal_id = p_signal;
    with g as (update public.sc_graphics set status = 'WITHDRAWN', external_approval = case when external_approval = 'APPROVED' then 'REVOKED' else external_approval end
                where signal_id = p_signal and status <> 'WITHDRAWN' returning graphic_id)
    insert into public.sc_signal_events (signal_id, kind, actor, detail) select p_signal, 'graphic_withdrawn', actor, jsonb_build_object('graphic_id', graphic_id) from g;
    perform public.sc_event(p_signal, 'withdrawn', actor, null, jsonb_build_object('reason', p_reason));
  elsif p_action = 'preview_on' then
    if s.publication <> 'PUBLISHED' then raise exception 'only a published signal can be in the free preview'; end if;
    update public.sc_signals set public_preview = true where signal_id = p_signal;
    perform public.sc_event(p_signal, 'preview_on', actor, null, '{}');
  elsif p_action = 'preview_off' then
    update public.sc_signals set public_preview = false where signal_id = p_signal;
    perform public.sc_event(p_signal, 'preview_off', actor, null, '{}');
  elsif p_action = 'regenerate' then
    perform public.sc_event(p_signal, 'regenerate_requested', actor, null, jsonb_build_object('reason', p_reason));
  else raise exception 'unknown action %', p_action; end if;
  return public.sc_signal(p_signal);
end $$;

create or replace function public.sc_admin_graphic(p_graphic bigint, p_action text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.sc_require_admin(); g record; actor text := 'admin:' || uid::text;
begin
  select x.*, s.publication, s.verification_state, s.current_version_id, s.fixture into g from public.sc_graphics x join public.sc_signals s on s.signal_id = x.signal_id where x.graphic_id = p_graphic for update of x;
  if not found then raise exception 'no such graphic'; end if;
  if p_action = 'approve_external' then
    if g.status <> 'READY' or g.version_id <> g.current_version_id then raise exception 'only the current, READY graphic can be approved'; end if;
    if g.publication <> 'PUBLISHED' or g.verification_state <> 'VERIFIED' or g.fixture then raise exception 'only the graphic of a published, verified signal can be approved for external publication'; end if;
    update public.sc_graphics set external_approval = 'APPROVED', approved_by = uid, approved_at = now() where graphic_id = p_graphic;
    perform public.sc_event(g.signal_id, 'graphic_approved', actor, null, jsonb_build_object('graphic_id', p_graphic, 'note', 'approved for external publication; nothing is posted automatically'));
  elsif p_action = 'revoke_external' then
    update public.sc_graphics set external_approval = 'REVOKED' where graphic_id = p_graphic and external_approval = 'APPROVED';
    perform public.sc_event(g.signal_id, 'graphic_revoked', actor, null, jsonb_build_object('graphic_id', p_graphic));
  elsif p_action = 'withdraw' then
    update public.sc_graphics set status = 'WITHDRAWN', external_approval = case when external_approval = 'APPROVED' then 'REVOKED' else external_approval end where graphic_id = p_graphic;
    perform public.sc_event(g.signal_id, 'graphic_withdrawn', actor, null, jsonb_build_object('graphic_id', p_graphic));
  else raise exception 'unknown action %', p_action; end if;
  return jsonb_build_object('graphic_id', p_graphic, 'action', p_action, 'ok', true);
end $$;

-- Going live publishes what the publication rule would have published had the
-- runs begun in live (sc_place_shadow, above), at the moment of the switch.
create or replace function public.sc_promote_shadow(p_actor text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce((public.sc_cfg('mode'))#>>'{}', 'shadow') <> 'live' then return 0; end if;
  return public.sc_place_shadow(p_actor, null, 'the mode was switched to live');
end $$;

-- one switch, two doors: the operator's (signed in) and the owner's (below)
create or replace function public.sc_set_mode(p_mode text, p_live_sports text[], p_by uuid, p_actor text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare old jsonb; n integer := 0;
begin
  if p_mode not in ('shadow', 'live') then raise exception 'mode is shadow or live'; end if;
  if p_live_sports is not null and exists (select 1 from unnest(p_live_sports) x where x !~ '^[a-z_]{2,24}$') then raise exception 'bad sport key'; end if;
  select value into old from public.sc_config where key = 'mode';
  update public.sc_config set value = to_jsonb(p_mode), updated_at = now(), updated_by = p_by where key = 'mode';
  insert into public.sc_config_log (key, old_value, new_value, changed_by, reason) values ('mode', old, to_jsonb(p_mode), p_by, p_reason);
  if p_live_sports is not null then
    select value into old from public.sc_config where key = 'live_sports';
    update public.sc_config set value = to_jsonb(p_live_sports), updated_at = now(), updated_by = p_by where key = 'live_sports';
    insert into public.sc_config_log (key, old_value, new_value, changed_by, reason) values ('live_sports', old, to_jsonb(p_live_sports), p_by, p_reason);
  end if;
  if p_mode = 'live' then n := public.sc_promote_shadow(p_actor); end if;
  return jsonb_build_object('mode', p_mode, 'live_sports', public.sc_cfg('live_sports'), 'promoted', n,
    'note', case when p_mode = 'live' then n || ' shadow signal' || case when n = 1 then '' else 's' end || ' of the live sports that clear the publication rule were published; held and withdrawn signals were left as they are.'
                 else 'Nothing new is published; signals already published stay published until an operator holds or withdraws them.' end);
end $$;

create or replace function public.sc_admin_set_mode(p_mode text, p_live_sports text[] default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.sc_require_admin();
begin
  return public.sc_set_mode(p_mode, p_live_sports, uid, 'admin:' || uid::text, null);
end $$;

-- THE OWNER'S DOOR: the same switch for the database owner, who holds the
-- connection string rather than an operator account (the SQL editor, or
-- .github/workflows/signal-center-mode.yml with SB_DB_URL). It is granted to
-- no API role, so no token reaches it; it requires a reason, kept in
-- sc_config_log.
create or replace function public.sc_owner_set_mode(p_mode text, p_live_sports text[], p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'say why: the reason is kept in sc_config_log'; end if;
  return public.sc_set_mode(p_mode, p_live_sports, null, 'owner', left(btrim(p_reason), 500));
end $$;

create or replace function public.sc_admin_runs(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.sc_require_admin();
  return (select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc), '[]'::jsonb) from (select * from public.sc_runs order by started_at desc limit greatest(1, least(coalesce(p_limit, 20), 200))) r);
end $$;

create or replace function public.sc_admin_failures(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.sc_require_admin();
  return (select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at desc), '[]'::jsonb) from (select * from public.sc_failures where resolved_at is null order by created_at desc limit greatest(1, least(coalesce(p_limit, 50), 500))) f);
end $$;

create or replace function public.sc_admin_resolve_failure(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public.sc_require_admin();
begin
  update public.sc_failures set resolved_at = now(), resolved_by = uid where id = p_id and resolved_at is null;
  return jsonb_build_object('resolved', found);
end $$;

-- ---------------------------------------------------------------- row level security
do $rls$
declare t text;
begin
  foreach t in array array['sc_config', 'sc_config_log', 'sc_runs', 'sc_signals', 'sc_signal_versions', 'sc_signal_events', 'sc_graphics', 'sc_model_dna',
                           'sc_preferences', 'sc_notification_log', 'sc_failures'] loop
    execute format('alter table public.%I enable row level security', t);
    -- no client role reads or writes a table: every read is a door that checks the caller
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- the job writes through its doors too (they run as the owner)
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke insert, update, delete, truncate on public.%I from service_role', t);
      execute format('grant select on public.%I to service_role', t);
    end if;
  end loop;
end $rls$;
-- a reader may see their own preferences row (writes go through sc_save_preferences)
drop policy if exists sc_preferences_own on public.sc_preferences;
create policy sc_preferences_own on public.sc_preferences for select to authenticated using (user_id = auth.uid());
grant select on public.sc_preferences to authenticated;

-- ---------------------------------------------------------------- function grants
do $g$
declare f text;
begin
  -- the job's doors: service_role only
  foreach f in array array['public.sc_begin_run(jsonb)', 'public.sc_require_run(uuid)', 'public.sc_current(text[])', 'public.sc_prior_divergences()', 'public.sc_check_simulation(jsonb)',
    'public.sc_active(text[],integer)', 'public.sc_graphics_due(text,integer)',
    'public.sc_ingest_one(uuid,jsonb,text,text,jsonb,text,boolean)', 'public.sc_ingest(uuid,jsonb)', 'public.sc_put_graphics(uuid,jsonb)', 'public.sc_put_dna(uuid,jsonb)',
    'public.sc_fail(uuid,jsonb)', 'public.sc_publish_pending(uuid)', 'public.sc_expire()', 'public.sc_finish_run(uuid,text,jsonb,jsonb)', 'public.sc_notify(uuid)', 'public.sc_event(bigint,text,text,uuid,jsonb)',
    'public.sc_user_entitled(uuid)', 'public.sc_cfg(text)', 'public.sc_item(public.sc_signals,boolean)',
    'public.sc_keep()', 'public.sc_signals_guard()', 'public.sc_graphics_guard()', 'public.sc_failures_guard()'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') and f !~ '(keep|guard)\(\)$' then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  -- anyone: the status, the pulse (counts only) and the free preview
  foreach f in array array['public.sc_status()', 'public.sc_pulse(integer)', 'public.sc_public_feed(integer)', 'public.sc_viewer_entitled()', 'public.sc_is_admin()',
    'public.sc_copy_ok(text)', 'public.sc_label_rank(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    execute 'grant execute on function ' || f || ' to anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  -- a signed-in account: the feed and the detail (each decides full or preview inside), preferences, the count
  foreach f in array array['public.sc_feed(jsonb,text,integer)', 'public.sc_signal(bigint)', 'public.sc_signal_version(bigint,integer)', 'public.sc_model_dna_current(text)',
    'public.sc_my_preferences()', 'public.sc_save_preferences(jsonb)', 'public.sc_unread_count()',
    'public.sc_require_admin()', 'public.sc_admin_queue(jsonb,text,integer)', 'public.sc_admin_act(bigint,text,text)', 'public.sc_admin_graphic(bigint,text)',
    'public.sc_admin_set_mode(text,text[])', 'public.sc_admin_runs(integer)', 'public.sc_admin_failures(integer)', 'public.sc_admin_resolve_failure(bigint)'] loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $g$;
grant execute on function public.sc_public_feed(integer) to anon, authenticated;
grant execute on function public.sc_pulse(integer) to anon, authenticated;
grant execute on function public.sc_status() to anon, authenticated;
grant execute on function public.sc_feed(jsonb,text,integer) to authenticated;
-- the switch's internals and the owner's door: no API role, the job's included
do $o$
declare f text;
begin
  foreach f in array array['public.sc_place_shadow(text,uuid,text)', 'public.sc_promote_shadow(text)', 'public.sc_set_mode(text,text[],uuid,text,text)', 'public.sc_owner_set_mode(text,text[],text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || f || ' from service_role'; end if;
  end loop;
end $o$;

-- ---------------------------------------------------------------- navigation evidence
-- The Signal Center seat's taps (app.html edNavTrack → lib/edgedesk_track.js),
-- registered here so deploying Signal Center needs no re-run of funnel.sql
-- (which carries the same row for a fresh install). Skipped without the funnel.
do $nav$ begin
  if to_regclass('public.user_event_kinds') is not null then
    insert into public.user_event_kinds (event_name, source, dedupe, stage, signed_in, description)
    values ('primary_nav_signals', 'client', 'session', 60, true, 'The Signal Center seat in the primary navigation was tapped.')
    on conflict (event_name) do nothing;
  end if;
end $nav$;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- report
select 1 as row, 'tables exist' as check,
       case when to_regclass('public.sc_signals') is not null and to_regclass('public.sc_signal_versions') is not null and to_regclass('public.sc_graphics') is not null
             and to_regclass('public.sc_model_dna') is not null and to_regclass('public.sc_preferences') is not null and to_regclass('public.sc_runs') is not null
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'row level security on every sc table',
       case when (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'sc\_%') then 'ok' else 'CHECK THIS' end
union all select 3, 'no client role can read or write an sc table directly (preferences: own row, read only)',
       case when not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name like 'sc\_%'
                              and g.grantee in ('anon', 'authenticated') and (g.privilege_type <> 'SELECT' or g.table_name <> 'sc_preferences' or g.grantee = 'anon')) then 'ok' else 'CHECK THIS' end
union all select 4, 'the job doors are not callable by clients',
       case when not has_function_privilege('anon', 'public.sc_ingest(uuid,jsonb)', 'execute') and not has_function_privilege('authenticated', 'public.sc_ingest(uuid,jsonb)', 'execute')
             and not has_function_privilege('authenticated', 'public.sc_notify(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.sc_put_graphics(uuid,jsonb)', 'execute') then 'ok' else 'CHECK THIS' end
union all select 5, 'the feed is not callable without an account',
       case when not has_function_privilege('anon', 'public.sc_feed(jsonb,text,integer)', 'execute') and not has_function_privilege('anon', 'public.sc_signal(bigint)', 'execute') then 'ok' else 'CHECK THIS' end
union all select 6, 'the entitlement gate defers to the project rule',
       case when to_regprocedure('public.community_is_entitled(uuid)') is not null then 'ok' else 'CHECK THIS: public.community_is_entitled(uuid) is not installed — nobody gets Full Access to Signal Center (fail closed) until it is' end
union all select 7, 'an anonymous caller is neither entitled nor an operator',
       case when not public.sc_viewer_entitled() and not public.sc_is_admin() then 'ok' else 'CHECK THIS' end
union all select 8, 'history tables refuse update and delete',
       case when (select count(*) from pg_trigger where tgname in ('sc_signal_versions_frozen', 'sc_signal_events_frozen', 'sc_model_dna_frozen', 'sc_config_log_frozen', 'sc_notification_log_frozen')) = 5 then 'ok' else 'CHECK THIS' end
union all select 9, 'mode',
       case when (public.sc_cfg('mode'))#>>'{}' = 'shadow' then 'ok: shadow (nothing is published until an operator switches to live)'
            when (public.sc_cfg('mode'))#>>'{}' = 'live' then 'ok: live for ' || (public.sc_cfg('live_sports'))::text else 'CHECK THIS' end
union all select 10, 'notices',
       case when to_regclass('public.user_alerts') is not null then 'ok' else 'pending: public.user_alerts (supabase/personal_research.sql) is not installed — notices are skipped' end
union all select 11, 'the Signal Center seat is counted',
       case when to_regclass('public.user_event_kinds') is null then 'pending: supabase/funnel.sql is not installed — seat taps are not kept'
            -- read dynamically: a plain reference would fail to parse where the funnel is not installed
            when (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.user_event_kinds where event_name = ''primary_nav_signals''', false, true, '')))[1]::text = '1'
            then 'ok' else 'CHECK THIS' end
union all select 12, 'the owner''s mode door is reachable by no API role',
       case when not has_function_privilege('anon', 'public.sc_owner_set_mode(text,text[],text)', 'execute')
             and not has_function_privilege('authenticated', 'public.sc_owner_set_mode(text,text[],text)', 'execute')
             and not has_function_privilege('authenticated', 'public.sc_set_mode(text,text[],uuid,text,text)', 'execute')
             and (not exists (select 1 from pg_roles where rolname = 'service_role') or not has_function_privilege('service_role', 'public.sc_owner_set_mode(text,text[],text)', 'execute'))
            then 'ok' else 'CHECK THIS' end;

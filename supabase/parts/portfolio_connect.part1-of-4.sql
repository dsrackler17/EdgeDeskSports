-- portfolio_connect -- part 1 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- portfolio_connect.sql — the platform registry, connector smoke tests,
-- connect sessions, sync runs and the service-only ingest path, over
-- supabase/portfolio.sql.
--
-- THE PIPELINE
--   SOURCE → SOURCE ADAPTER → NORMALIZER (lib/edgedesk_portfolio_connect_core.js,
--   run inside supabase/functions/portfolio_connect) → portfolio_svc_ingest()
--   here → platform_accounts / portfolio_positions / portfolio_transactions →
--   reconciliation → the Portfolio, the journal and the grade, unchanged.
--
-- NOTHING IS ENABLED BY CODE. portfolio_platform_registry.automatic_enabled
-- can only become true when a recorded live smoke test for that platform and
-- that connector version passed all ten stages (CONNECT → IMPORT → VERIFY →
-- INCREMENTAL → NEW ACTIVITY → SETTLEMENT → RECONCILE → DISCONNECT → RECONNECT
-- → NO DUPLICATES) against production in the last 30 days, AND its terms
-- review is CLEARED. A new connector version switches it off again.
--
-- CREDENTIALS never reach a table the API serves: ciphertext only, in
-- portfolio_private (portfolio.sql § 9), written and read by the service role
-- through the functions below. A reader sees a hint ("…608c"), the scopes and
-- when it was stored — never the key.
--
-- EVERY portfolio_svc_* FUNCTION is the service role's alone: execute is
-- granted to nobody else, AND each one refuses any other caller itself, so
-- an accidental grant still opens nothing.
--
-- Run AFTER supabase/portfolio.sql (and portfolio_journal.sql if installed).
-- Idempotent, additive, ends in a report.
-- Paste-sized: supabase/parts/portfolio_connect.part*-of-*.sql (npm run portfolio:parts).
-- =============================================================================

do $$ begin
  if to_regclass('public.portfolio_positions') is null or to_regclass('portfolio_private.platform_credentials') is null then
    raise exception 'portfolio_connect: run supabase/portfolio.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'platform_accounts' and column_name = 'ingestion_method') then
    raise exception 'portfolio_connect: run the current supabase/portfolio.sql first (platform_accounts.ingestion_method is missing)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. WHO MAY CALL A SERVICE FUNCTION
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_svc_assert() returns void
language plpgsql stable as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'portfolio: this is a connector''s function, not a reader''s' using errcode = '42501';
  end if;
end $$;

-- The operator list for the business consoles, as billing.sql decides it.
create or replace function public.portfolio_is_admin() returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean := false;
begin
  if auth.uid() is null then return false; end if;
  if to_regprocedure('public.billing_is_admin()') is not null then
    execute 'select public.billing_is_admin()' into v;
    return coalesce(v, false);
  end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v;
    if v then return true; end if;
  end if;
  return auth.uid() = 'e7e46801-80c4-4f47-b718-4aff211c8d3a'::uuid;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE PLATFORM REGISTRY — what each platform offers, and the runtime switch
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_platform_registry (
  platform_key         text        primary key,
  label                text        not null,
  source_type          text        not null,
  automatic_method     text        null,
  connector_version    text        null,
  automatic_enabled    boolean     not null default false,
  enabled_by_smoke_test uuid       null,
  enabled_at           timestamptz null,
  tos_review           text        not null default 'NOT_STARTED',
  docs_verified_on     date        null,
  import_profile       text        null,
  import_verified      boolean     not null default false,
  notes                text        null,
  updated_at           timestamptz not null default now(),
  constraint portfolio_registry_key check (platform_key ~ '^[a-z0-9][a-z0-9_]{1,47}$'),
  constraint portfolio_registry_source check (source_type in ('SPORTSBOOK', 'PREDICTION_MARKET')),
  constraint portfolio_registry_method check (automatic_method is null or automatic_method in ('OAUTH', 'API_KEY', 'PUBLIC_WALLET', 'AUTHORIZED_API')),
  constraint portfolio_registry_tos check (tos_review in ('NOT_STARTED', 'IN_REVIEW', 'CLEARED', 'BLOCKED')),
  -- on is only ever on with its evidence
  constraint portfolio_registry_enabled_evidence check (not automatic_enabled
    or (automatic_method is not null and connector_version is not null and enabled_by_smoke_test is not null and tos_review = 'CLEARED' and enabled_at is not null)),
  constraint portfolio_registry_text check (length(label) between 1 and 60 and coalesce(length(notes), 0) <= 1000)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE LIVE SMOKE TEST — recorded stage by stage, service role only
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.portfolio_smoke_stages() returns text[]
language sql immutable as $$
  select array['CONNECT', 'IMPORT', 'VERIFY', 'INCREMENTAL', 'NEW_ACTIVITY', 'SETTLEMENT', 'RECONCILE', 'DISCONNECT', 'RECONNECT', 'NO_DUPLICATES']
$$;
create or replace function public.portfolio_smoke_all_ok(p jsonb) returns boolean
language sql immutable as $$
  select coalesce(bool_and(coalesce((p -> s ->> 'ok')::boolean, false)), false)
    from unnest(public.portfolio_smoke_stages()) s
$$;
create table if not exists portfolio_private.connector_smoke_tests (
  id                uuid        primary key default gen_random_uuid(),
  platform_key      text        not null,
  connector_version text        not null,
  environment       text        not null,
  stages            jsonb       not null default '{}'::jsonb,
  status            text        not null default 'RUNNING',
  run_by            text        null,
  notes             text        null,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz null,
  constraint smoke_env check (environment in ('PRODUCTION', 'DEMO')),
  constraint smoke_status check (status in ('RUNNING', 'PASSED', 'FAILED')),
  -- PASSED means all ten stages, against production
  constraint smoke_passed check (status <> 'PASSED' or (public.portfolio_smoke_all_ok(stages) and environment = 'PRODUCTION' and finished_at is not null)),
  constraint smoke_text check (coalesce(length(run_by), 0) <= 120 and coalesce(length(notes), 0) <= 2000 and pg_column_size(stages) <= 16384)
);
alter table portfolio_private.connector_smoke_tests enable row level security;

-- The registry's switch: throwing it needs a passing test of THIS version.
create or replace function public.portfolio_registry_guard() returns trigger
language plpgsql security definer set search_path = public, portfolio_private, pg_temp as $$
declare ok boolean;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.connector_version is distinct from old.connector_version and new.automatic_enabled
     and new.enabled_by_smoke_test is not distinct from old.enabled_by_smoke_test then
    -- a new connector version is a new connector: off until it is tested
    new.automatic_enabled := false; new.enabled_by_smoke_test := null; new.enabled_at := null;
  end if;
  if new.automatic_enabled and (tg_op = 'INSERT' or not old.automatic_enabled or new.enabled_by_smoke_test is distinct from old.enabled_by_smoke_test) then
    select exists (select 1 from portfolio_private.connector_smoke_tests t
                    where t.id = new.enabled_by_smoke_test and t.platform_key = new.platform_key and t.connector_version = new.connector_version
                      and t.status = 'PASSED' and t.environment = 'PRODUCTION' and t.finished_at > now() - interval '30 days') into ok;
    if not ok then
      raise exception 'portfolio: % cannot be enabled without a passing live smoke test of connector %', new.platform_key, new.connector_version
        using errcode = '23514', hint = 'Run tools/portfolio/connector_smoke.js against production; all ten stages must pass.';
    end if;
    new.enabled_at := coalesce(new.enabled_at, now());
  end if;
  if not new.automatic_enabled then new.enabled_at := null; end if;
  return new;
end $$;
drop trigger if exists portfolio_registry_guard_trg on public.portfolio_platform_registry;
create trigger portfolio_registry_guard_trg before insert or update on public.portfolio_platform_registry
  for each row execute function public.portfolio_registry_guard();

-- What the code knows (lib/edgedesk_portfolio_connect_core.js REGISTRY). A
-- re-run refreshes the description, never the switch: only a new connector
-- version changes it, and that switches it OFF.
insert into public.portfolio_platform_registry (platform_key, label, source_type, automatic_method, connector_version, docs_verified_on, import_profile, import_verified, notes) values
  ('kalshi', 'Kalshi', 'PREDICTION_MARKET', 'API_KEY', 'kalshi_v1', date '2026-10-04', 'kalshi_csv', false,
   'Read-only API key (RSA-PSS or Ed25519 signed requests). Verified from Kalshi''s published API client source; re-read docs.kalshi.com and the API terms before enabling.'),
  ('polymarket', 'Polymarket', 'PREDICTION_MARKET', 'PUBLIC_WALLET', 'polymarket_v1', date '2026-10-04', 'polymarket_csv', false,
   'Public wallet address; no credential. Verified from Polymarket''s published client source (data API v2); re-read docs.polymarket.com and the terms before enabling.'),
  ('draftkings', 'DraftKings', 'SPORTSBOOK', null, null, null, 'draftkings', false, 'No customer API. File import; the profile is unverified until checked against a real export.'),
  ('fanduel', 'FanDuel', 'SPORTSBOOK', null, null, null, 'fanduel', false, 'No customer API. File import; the profile is unverified until checked against a real export.'),
  ('betmgm', 'BetMGM', 'SPORTSBOOK', null, null, null, 'betmgm', false, 'No customer API. File import; the profile is unverified until checked against a real export.'),
  ('williamhill_us', 'Caesars', 'SPORTSBOOK', null, null, null, 'caesars', false, 'No customer API. File import; the profile is unverified until checked against a real export.'),
  ('bet365', 'bet365', 'SPORTSBOOK', null, null, null, 'bet365', false, 'No customer API. File import; the profile is unverified until checked against a real export.')
on conflict (platform_key) do update set label = excluded.label, source_type = excluded.source_type, automatic_method = excluded.automatic_method,
  connector_version = excluded.connector_version, docs_verified_on = excluded.docs_verified_on, import_profile = excluded.import_profile, notes = excluded.notes;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CONNECT SESSIONS — one-time state for a connect flow (service role only)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists portfolio_private.connect_sessions (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  platform_key  text        not null,
  method        text        not null,
  state_hash    text        not null,
  challenge     text        null,
  expires_at    timestamptz not null,
  consumed_at   timestamptz null,
  created_at    timestamptz not null default now(),
  constraint connect_sessions_state unique (state_hash),
  constraint connect_sessions_method check (method in ('OAUTH', 'API_KEY', 'PUBLIC_WALLET', 'AUTHORIZED_API')),
  constraint connect_sessions_window check (expires_at > created_at and expires_at <= created_at + interval '30 minutes'),
  constraint connect_sessions_text check (length(state_hash) = 64 and coalesce(length(challenge), 0) <= 1000)
);
alter table portfolio_private.connect_sessions enable row level security;
create index if not exists connect_sessions_user on portfolio_private.connect_sessions (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ACCOUNTS: the scheduler's fields, and SYNC RUNS the reader can see
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.platform_accounts add column if not exists next_sync_at timestamptz null;
alter table public.platform_accounts add column if not exists consecutive_failures int not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'platform_accounts_failures') then
    alter table public.platform_accounts add constraint platform_accounts_failures check (consecutive_failures between 0 and 1000);
  end if;
end $$;
create index if not exists platform_accounts_due on public.platform_accounts (next_sync_at) where connection_type in ('API', 'OAUTH', 'AGGREGATOR');

create table if not exists public.portfolio_sync_runs (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references auth.users(id) on delete cascade,
  platform_account_id    uuid        not null,
  platform               text        not null,
  kind                   text        not null,
  status                 text        not null default 'RUNNING',
  started_at             timestamptz not null default now(),
  finished_at            timestamptz null,
  duration_ms            int         null,
  fetched                int         not null default 0,
  positions_inserted     int         not null default 0,
  positions_updated      int         not null default 0,
  transactions_inserted  int         not null default 0,
  transactions_unchanged int         not null default 0,
  rejected               int         not null default 0,
  issues                 jsonb       not null default '[]'::jsonb,
  reconcile              jsonb       null,
  error_code             text        null,
  error_message          text        null,
  constraint portfolio_sync_runs_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete cascade,
  constraint portfolio_sync_runs_kind check (kind in ('INITIAL', 'INCREMENTAL', 'RECONCILE', 'MANUAL', 'SMOKE')),
  constraint portfolio_sync_runs_status check (status in ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  constraint portfolio_sync_runs_issues check (jsonb_typeof(issues) = 'array' and jsonb_array_length(issues) <= 200 and pg_column_size(issues) <= 65536),
  constraint portfolio_sync_runs_text check (coalesce(length(error_code), 0) <= 40 and coalesce(length(error_message), 0) <= 500)
);
create index if not exists portfolio_sync_runs_account on public.portfolio_sync_runs (platform_account_id, started_at desc);
create index if not exists portfolio_sync_runs_recent on public.portfolio_sync_runs (started_at desc);

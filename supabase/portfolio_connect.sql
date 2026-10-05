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

-- Connection attempts, for the operator's health panel: counts only — no
-- reader, no credential, no wallet. Written by the connect function.
create table if not exists portfolio_private.connector_events (
  id            bigserial   primary key,
  platform_key  text        not null,
  kind          text        not null,
  code          text        null,
  at            timestamptz not null default now(),
  constraint connector_events_kind check (kind in ('ATTEMPT', 'CONNECTED', 'FAILED', 'DISCONNECTED')),
  constraint connector_events_text check (length(platform_key) <= 48 and coalesce(length(code), 0) <= 40)
);
alter table portfolio_private.connector_events enable row level security;
create index if not exists connector_events_at on portfolio_private.connector_events (at desc);

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
alter table public.portfolio_sync_runs add column if not exists positions_settled int not null default 0;
create index if not exists portfolio_sync_runs_account on public.portfolio_sync_runs (platform_account_id, started_at desc);
create index if not exists portfolio_sync_runs_recent on public.portfolio_sync_runs (started_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE SERVICE ENTRY POINTS
-- ─────────────────────────────────────────────────────────────────────────────
-- Connect (or reconnect) an automatic account. A reader's QUICK IMPORT or
-- manual account for the same platform is UPGRADED IN PLACE, so its history
-- stays theirs; a disconnected automatic account is reused, so reconnecting
-- never duplicates. Refused while the registry has the platform switched
-- off, unless the call belongs to a running smoke test of that platform.
create or replace function public.portfolio_svc_account_connect(p_user uuid, p_platform text, p_method text, p_external_account_id text,
    p_display_name text default null, p_smoke_test uuid default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare reg record; acct uuid; ext text := nullif(btrim(p_external_account_id), '');
begin
  perform public.portfolio_svc_assert();
  select * into reg from public.portfolio_platform_registry where platform_key = p_platform;
  if not found or reg.automatic_method is null or reg.automatic_method <> p_method then
    raise exception 'portfolio: % has no % connection', p_platform, p_method using errcode = '22023';
  end if;
  if not reg.automatic_enabled and not exists (select 1 from portfolio_private.connector_smoke_tests t
       where t.id = p_smoke_test and t.platform_key = p_platform and t.status = 'RUNNING' and t.started_at > now() - interval '30 days') then
    raise exception 'portfolio: automatic connection for % is not enabled', p_platform using errcode = '42501';
  end if;
  -- the same automatic account, connected before
  select id into acct from public.platform_accounts
   where user_id = p_user and platform = p_platform and connection_type = 'API' and coalesce(external_account_id, '') = coalesce(ext, '')
   order by created_at limit 1;
  if acct is null then
    -- upgrade QUICK IMPORT / manual in place
    select id into acct from public.platform_accounts
     where user_id = p_user and platform = p_platform and connection_type in ('CSV', 'MANUAL')
       and not exists (select 1 from public.platform_accounts b where b.user_id = p_user and b.platform = p_platform and b.connection_type = 'API')
     order by case connection_type when 'CSV' then 0 else 1 end, created_at limit 1;
  end if;
  if acct is null then
    insert into public.platform_accounts (user_id, platform, platform_label, platform_type, connection_type, ingestion_method, external_account_id,
        display_name, status, next_sync_at)
    values (p_user, p_platform, reg.label, reg.source_type, 'API', p_method, ext, nullif(btrim(p_display_name), ''), 'SYNCING', now())
    returning id into acct;
  else
    update public.platform_accounts set connection_type = 'API', ingestion_method = p_method, external_account_id = ext,
           display_name = coalesce(nullif(btrim(p_display_name), ''), display_name), status = 'SYNCING', last_error = null,
           consecutive_failures = 0, next_sync_at = now()
     where id = acct;
  end if;
  return acct;
end $$;

-- Store the sealed credential (ciphertext and nonce, base64) for an account.
-- The account's metadata carries only what a reader may see about it.
create or replace function public.portfolio_svc_store_credential(p_account uuid, p_kind text, p_ciphertext_b64 text, p_nonce_b64 text,
    p_key_version int, p_key_hint text default null, p_scopes text[] default null)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare a record;
begin
  perform public.portfolio_svc_assert();
  select id, user_id into a from public.platform_accounts where id = p_account;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  insert into portfolio_private.platform_credentials (platform_account_id, user_id, credential_kind, ciphertext, nonce, key_version, key_hint, scopes)
  values (a.id, a.user_id, p_kind, decode(p_ciphertext_b64, 'base64'), decode(p_nonce_b64, 'base64'), p_key_version, p_key_hint, p_scopes)
  on conflict (platform_account_id) do update set credential_kind = excluded.credential_kind, ciphertext = excluded.ciphertext, nonce = excluded.nonce,
    key_version = excluded.key_version, key_hint = excluded.key_hint, scopes = excluded.scopes, rotated_at = now(), revoked_at = null, updated_at = now();
  update public.platform_accounts set metadata = (metadata - 'credential') || jsonb_build_object('credential',
      jsonb_build_object('kind', p_kind, 'hint', p_key_hint, 'scopes', to_jsonb(coalesce(p_scopes, '{}'::text[])), 'stored_at', now()))
   where id = a.id;
end $$;

-- The sealed credential, for the sync worker to open in memory.
create or replace function public.portfolio_svc_credential(p_account uuid)
returns table (user_id uuid, credential_kind text, ciphertext_b64 text, nonce_b64 text, key_version int)
language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.platform_credentials set last_used_at = now() where platform_account_id = p_account and revoked_at is null;
  return query select c.user_id, c.credential_kind, encode(c.ciphertext, 'base64'), encode(c.nonce, 'base64'), c.key_version
    from portfolio_private.platform_credentials c where c.platform_account_id = p_account and c.revoked_at is null;
end $$;

-- A one-time session for a connect flow; consumed once, within its window.
create or replace function public.portfolio_svc_session_begin(p_user uuid, p_platform text, p_method text, p_state_hash text, p_challenge text default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare sid uuid;
begin
  perform public.portfolio_svc_assert();
  delete from portfolio_private.connect_sessions where expires_at < now() - interval '1 day';
  insert into portfolio_private.connect_sessions (user_id, platform_key, method, state_hash, challenge, expires_at)
  values (p_user, p_platform, p_method, p_state_hash, p_challenge, now() + interval '15 minutes') returning id into sid;
  return sid;
end $$;
create or replace function public.portfolio_svc_session_consume(p_user uuid, p_state_hash text)
returns table (platform_key text, method text, challenge text)
language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query update portfolio_private.connect_sessions s set consumed_at = now()
     where s.state_hash = p_state_hash and s.user_id = p_user and s.consumed_at is null and s.expires_at > now()
    returning s.platform_key, s.method, s.challenge;
end $$;

-- A sync run begins: one at a time per account (a run stuck for 15 minutes
-- is presumed dead and closed as FAILED).
create or replace function public.portfolio_svc_run_begin(p_account uuid, p_kind text)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare a record; rid uuid;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform into a from public.platform_accounts where id = p_account for update;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  update public.portfolio_sync_runs set status = 'FAILED', finished_at = now(), error_code = 'TIMEOUT', error_message = 'The sync stopped responding and was closed.'
   where platform_account_id = p_account and status = 'RUNNING' and started_at < now() - interval '15 minutes';
  if exists (select 1 from public.portfolio_sync_runs where platform_account_id = p_account and status = 'RUNNING') then return null; end if;
  insert into public.portfolio_sync_runs (user_id, platform_account_id, platform, kind) values (a.user_id, a.id, a.platform, p_kind) returning id into rid;
  update public.platform_accounts set last_sync_at = now(), status = case when status in ('CONNECTED', 'ERROR') then 'SYNCING' else status end
   where id = p_account and connection_type = 'API';
  return rid;
end $$;

-- What an account holds now, for an incremental replay and reconciliation.
create or replace function public.portfolio_svc_account_positions(p_account uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select coalesce(jsonb_agg(jsonb_build_object('external_position_id', p.external_position_id, 'contracts', p.contracts, 'status', p.status,
            'resolution', p.resolution, 'realized_profit_loss', p.realized_profit_loss) order by p.external_position_id), '[]'::jsonb)
    from public.portfolio_positions p where p.platform_account_id = p_account and p.source = 'SYNC' and p.external_position_id is not null);
end $$;

-- THE INGEST. Normalized positions with their fills and fees, upserted by
-- the platform's own ids: running the same payload twice changes nothing.
-- Each position is its own sub-transaction: one that would break a rule
-- (no buy, more sold than bought, an impossible price) is rejected and
-- reported in the run — never silently dropped, never half-written.
-- SELF-HEALING: a payload may name replace_prefixes (a market whose holding
-- disagreed with the platform's at reconciliation). That market's synced
-- buys and sells are replaced by the full history the payload re-fetched,
-- and a side left with no buys is removed — the figure is rebuilt from the
-- platform's own record, never edited to agree.
create or replace function public.portfolio_svc_ingest(p_account uuid, p_run uuid, p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  a record; p jsonb; f jsonb; pid uuid; was_new boolean; n int;
  pos_ins int := 0; pos_upd int := 0; tx_ins int := 0; tx_same int := 0; v_rejected int := 0;
  v_issues jsonb := coalesce(p_payload->'issues', '[]'::jsonb);
  b numeric; s numeric; first_at timestamptz; pre text; healed int := 0;
  pos_settled int := 0; old_res text; old_sp numeric; new_res text;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform, platform_label, platform_type into a from public.platform_accounts where id = p_account;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  for p in select x from jsonb_array_elements(coalesce(p_payload->'positions', '[]'::jsonb)) x loop
    begin
      if coalesce(p->>'platform', '') <> a.platform or nullif(btrim(p->>'external_position_id'), '') is null then
        raise exception using errcode = '22023', message = 'portfolio: a position for another platform, or without its id';
      end if;
      perform set_config('portfolio.bulk_fills', 'on', true);
      select min((x->>'executed_at')::timestamptz) into first_at from jsonb_array_elements(coalesce(p->'fills', '[]'::jsonb)) x;
      -- what the position was settled as before this payload, so a new or
      -- changed settlement is counted (observability), never inferred
      old_res := null; old_sp := null; new_res := nullif(p->>'resolution', '');
      select resolution, settlement_price into old_res, old_sp from public.portfolio_positions
       where user_id = a.user_id and platform = a.platform and external_position_id = p->>'external_position_id';
      insert into public.portfolio_positions (user_id, platform_account_id, platform, platform_label, platform_type, external_position_id, contract_key,
          position_type, sport, league, event_name, event_id, event_start_at, market_name, selection, side, current_price, current_price_at,
          resolution, settlement_price, settled_at, placed_at, source)
      values (a.user_id, a.id, a.platform, coalesce(nullif(p->>'platform_label', ''), a.platform_label), 'PREDICTION_MARKET', p->>'external_position_id',
          nullif(p->>'contract_key', ''), coalesce(nullif(p->>'position_type', ''), 'EVENT_CONTRACT'), nullif(p->>'sport', ''), nullif(p->>'league', ''),
          left(coalesce(nullif(btrim(p->>'event_name'), ''), p->>'external_position_id'), 200), nullif(p->>'event_id', ''), (nullif(p->>'event_start_at', ''))::timestamptz,
          left(coalesce(nullif(btrim(p->>'market_name'), ''), nullif(btrim(p->>'event_name'), ''), p->>'external_position_id'), 200),
          left(coalesce(nullif(btrim(p->>'selection'), ''), p->>'side'), 200), left(nullif(btrim(p->>'side'), ''), 80),
          (nullif(p->>'current_price', ''))::numeric, (nullif(p->>'current_price_at', ''))::timestamptz,
          nullif(p->>'resolution', ''), (nullif(p->>'settlement_price', ''))::numeric, (nullif(p->>'settled_at', ''))::timestamptz,
          coalesce(first_at, now()), 'SYNC')
      on conflict (user_id, platform, external_position_id) where external_position_id is not null do update set
          platform_account_id = excluded.platform_account_id,
          event_name = excluded.event_name, event_id = coalesce(excluded.event_id, portfolio_positions.event_id),
          event_start_at = coalesce(excluded.event_start_at, portfolio_positions.event_start_at),
          market_name = excluded.market_name, selection = excluded.selection,
          current_price = coalesce(excluded.current_price, portfolio_positions.current_price),
          current_price_at = case when excluded.current_price is not null then excluded.current_price_at else portfolio_positions.current_price_at end,
          -- an updated settlement replaces the earlier one; a payload without one keeps it
          resolution = coalesce(excluded.resolution, portfolio_positions.resolution),
          settlement_price = case when excluded.resolution is not null then excluded.settlement_price else portfolio_positions.settlement_price end,
          settled_at = coalesce(excluded.settled_at, portfolio_positions.settled_at)
      returning id, (xmax = 0) into pid, was_new;
      -- a market being rebuilt: its old buys and sells go, in this position's
      -- own sub-transaction, so a rejected rebuild leaves them as they were
      if exists (select 1 from jsonb_array_elements_text(coalesce(p_payload->'replace_prefixes', '[]'::jsonb)) r
                  where length(r) >= 4 and left(p->>'external_position_id', length(r)) = r) then
        delete from public.portfolio_transactions where position_id = pid and source = 'SYNC' and transaction_type in ('BUY', 'SELL', 'FILL');
      end if;
      for f in select x from jsonb_array_elements(coalesce(p->'fills', '[]'::jsonb)) x loop
        insert into public.portfolio_transactions (user_id, platform_account_id, position_id, platform, external_transaction_id, transaction_type, side,
            quantity, price, fee, executed_at, source)
        values (a.user_id, a.id, pid, a.platform, f->>'external_transaction_id', upper(f->>'action'), upper(f->>'action'),
            (f->>'quantity')::numeric, (f->>'price')::numeric, coalesce((nullif(f->>'fee', ''))::numeric, 0), (f->>'executed_at')::timestamptz, 'SYNC')
        on conflict (user_id, platform, external_transaction_id) where external_transaction_id is not null do nothing;
        get diagnostics n = row_count;
        if n > 0 then tx_ins := tx_ins + 1; else tx_same := tx_same + 1; end if;
      end loop;
      for f in select x from jsonb_array_elements(coalesce(p->'fees', '[]'::jsonb)) x loop
        insert into public.portfolio_transactions (user_id, platform_account_id, position_id, platform, external_transaction_id, transaction_type,
            fee, executed_at, source)
        values (a.user_id, a.id, pid, a.platform, f->>'external_transaction_id', 'FEE', (f->>'fee')::numeric,
            coalesce((nullif(f->>'executed_at', ''))::timestamptz, now()), 'SYNC')
        on conflict (user_id, platform, external_transaction_id) where external_transaction_id is not null
          do update set fee = excluded.fee where portfolio_transactions.fee is distinct from excluded.fee;
        get diagnostics n = row_count;
        if n > 0 then tx_ins := tx_ins + 1; else tx_same := tx_same + 1; end if;
      end loop;
      perform set_config('portfolio.bulk_fills', 'off', true);
      -- the rules a contract position keeps, checked now so a bad one is
      -- rejected alone rather than failing the whole run at commit
      select coalesce(sum(quantity) filter (where transaction_type = 'BUY'), 0), coalesce(sum(quantity) filter (where transaction_type = 'SELL'), 0)
        into b, s from public.portfolio_transactions where position_id = pid;
      if b <= 0 then raise exception using errcode = '23514', message = 'portfolio: a prediction-market position needs at least one buy'; end if;
      if s > b then raise exception using errcode = '23514', message = 'portfolio: more contracts sold than bought'; end if;
      update public.portfolio_positions set updated_at = now() where id = pid;
      if was_new then pos_ins := pos_ins + 1; else pos_upd := pos_upd + 1; end if;
      if new_res is not null and (old_res is distinct from new_res or old_sp is distinct from (nullif(p->>'settlement_price', ''))::numeric) then
        pos_settled := pos_settled + 1;
      end if;
    exception when others then
      perform set_config('portfolio.bulk_fills', 'off', true);
      v_rejected := v_rejected + 1;
      if jsonb_array_length(v_issues) < 200 then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object('code', 'REJECTED', 'ref', left(coalesce(p->>'external_position_id', '?'), 120),
          'message', left(regexp_replace(sqlerrm, '^portfolio: ', ''), 300)));
      end if;
    end;
  end loop;
  -- a rebuilt market: a side the platform's full history no longer has is
  -- removed (its record was the error being repaired)
  for pre in select jsonb_array_elements_text(coalesce(p_payload->'replace_prefixes', '[]'::jsonb)) loop
    if length(pre) < 4 or left(pre, length(a.platform) + 1) <> a.platform || ':' then continue; end if;
    delete from public.portfolio_positions p2 where p2.platform_account_id = a.id and p2.source = 'SYNC' and left(p2.external_position_id, length(pre)) = pre
       and not exists (select 1 from jsonb_array_elements(coalesce(p_payload->'positions', '[]'::jsonb)) x where x->>'external_position_id' = p2.external_position_id);
    healed := healed + 1;
  end loop;
  if p_run is not null then
    update public.portfolio_sync_runs set positions_inserted = positions_inserted + pos_ins, positions_updated = positions_updated + pos_upd,
           positions_settled = positions_settled + pos_settled,
           transactions_inserted = transactions_inserted + tx_ins, transactions_unchanged = transactions_unchanged + tx_same,
           rejected = portfolio_sync_runs.rejected + v_rejected,
           fetched = fetched + coalesce((p_payload->>'fetched')::int, 0),
           issues = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(portfolio_sync_runs.issues || v_issues) e limit 200) q)
     where id = p_run and platform_account_id = p_account;
  end if;
  return jsonb_build_object('positions_inserted', pos_ins, 'positions_updated', pos_upd, 'transactions_inserted', tx_ins,
    'transactions_unchanged', tx_same, 'rejected', v_rejected, 'issues', v_issues, 'healed', healed, 'positions_settled', pos_settled);
end $$;

-- A sync run ends. Success: CONNECTED, the cursor kept, the next run in 30
-- minutes. A credential the platform refused: ACTION_REQUIRED (the reader must
-- reconnect; no retry storm). Anything else: retried with backoff (5 min,
-- 10, 20 … capped at 6 hours), ERROR after five failures in a row.
create or replace function public.portfolio_svc_run_finish(p_run uuid, p_status text, p_error_code text default null, p_error_message text default null,
    p_cursor text default null, p_reconcile jsonb default null)
returns void language plpgsql set search_path = public, pg_temp as $$
declare r record; fails int;
begin
  perform public.portfolio_svc_assert();
  select * into r from public.portfolio_sync_runs where id = p_run for update;
  if not found or r.status <> 'RUNNING' then return; end if;
  update public.portfolio_sync_runs set status = p_status, finished_at = now(),
         duration_ms = least(2147483647, (extract(epoch from (now() - started_at)) * 1000)::bigint)::int,
         error_code = left(p_error_code, 40), error_message = left(p_error_message, 500), reconcile = p_reconcile
   where id = p_run;
  if p_status in ('SUCCEEDED', 'PARTIAL') then
    update public.platform_accounts set status = 'CONNECTED', last_success_at = now(), last_error = null, consecutive_failures = 0,
           sync_cursor = coalesce(left(p_cursor, 2000), sync_cursor), next_sync_at = now() + interval '30 minutes'
     where id = r.platform_account_id and connection_type = 'API';
  elsif p_error_code in ('BAD_CREDENTIAL', 'WRITE_SCOPE', 'SCOPE_UNKNOWN') then
    update public.platform_accounts set status = 'ACTION_REQUIRED', last_error = left(p_error_message, 500), next_sync_at = null
     where id = r.platform_account_id and connection_type = 'API';
  else
    update public.platform_accounts set consecutive_failures = consecutive_failures + 1 where id = r.platform_account_id returning consecutive_failures into fails;
    -- connected only once something has synced: a first sync that failed is still SYNCING
    update public.platform_accounts set status = case when fails >= 5 then 'ERROR' when last_success_at is null then 'SYNCING' else 'CONNECTED' end,
           last_error = left(p_error_message, 500),
           next_sync_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(fails - 1, 10)))
                                 + case when p_error_code = 'RATE_LIMITED' then interval '10 minutes' else interval '0' end
     where id = r.platform_account_id and connection_type = 'API';
  end if;
end $$;

-- The accounts the scheduler should sync now: connected, due, not waiting on
-- the reader, and on a platform that is switched on.
create or replace function public.portfolio_svc_due_accounts(p_limit int default 25)
returns table (account_id uuid, user_id uuid, platform text, ingestion_method text, external_account_id text, sync_cursor text, has_run boolean)
language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query select a.id, a.user_id, a.platform, a.ingestion_method, a.external_account_id, a.sync_cursor,
         exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status in ('SUCCEEDED', 'PARTIAL'))
    from public.platform_accounts a join public.portfolio_platform_registry g on g.platform_key = a.platform and g.automatic_enabled
   where a.connection_type = 'API' and a.status in ('CONNECTED', 'SYNCING', 'ERROR') and coalesce(a.next_sync_at, now()) <= now()
     and not exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status = 'RUNNING' and r.started_at > now() - interval '15 minutes')
   order by a.next_sync_at nulls first limit greatest(1, least(p_limit, 200));
end $$;

-- Disconnect: the credential is deleted (not merely flagged), the account
-- reads DISCONNECTED and syncs no more. History stays unless the reader asks
-- for it to go; then the synced positions and their transactions are deleted
-- with the account.
create or replace function public.portfolio_svc_disconnect(p_account uuid, p_delete_history boolean default false)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare cred int; pos int := 0;
begin
  perform public.portfolio_svc_assert();
  delete from portfolio_private.platform_credentials where platform_account_id = p_account;
  get diagnostics cred = row_count;
  if p_delete_history then
    delete from public.portfolio_positions where platform_account_id = p_account and source = 'SYNC';
    get diagnostics pos = row_count;
    delete from public.platform_accounts where id = p_account;
  else
    update public.platform_accounts set status = 'DISCONNECTED', next_sync_at = null, metadata = metadata - 'credential' where id = p_account;
  end if;
  return jsonb_build_object('credential_deleted', cred > 0, 'positions_deleted', pos);
end $$;

-- THE LIVE SMOKE TEST, recorded by tools/portfolio/connector_smoke.js. A
-- stage can pass only after every stage before it has passed; the test can
-- be PASSED only with all ten (the table's own check enforces it again).
create or replace function public.portfolio_svc_smoke_begin(p_platform text, p_run_by text default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare v text; tid uuid;
begin
  perform public.portfolio_svc_assert();
  select connector_version into v from public.portfolio_platform_registry where platform_key = p_platform and automatic_method is not null;
  if v is null then raise exception 'portfolio: % has no automatic connector to test', p_platform using errcode = '22023'; end if;
  insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment, run_by)
  values (p_platform, v, 'PRODUCTION', left(p_run_by, 120)) returning id into tid;
  return tid;
end $$;
create or replace function public.portfolio_svc_smoke_stage(p_test uuid, p_stage text, p_ok boolean, p_detail jsonb default '{}'::jsonb)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare t record; idx int; prev text;
begin
  perform public.portfolio_svc_assert();
  select * into t from portfolio_private.connector_smoke_tests where id = p_test for update;
  if not found or t.status <> 'RUNNING' then raise exception 'portfolio: no running smoke test %', p_test using errcode = 'P0002'; end if;
  idx := array_position(public.portfolio_smoke_stages(), p_stage);
  if idx is null then raise exception 'portfolio: unknown stage %', p_stage using errcode = '22023'; end if;
  if p_ok then
    foreach prev in array (public.portfolio_smoke_stages())[1:idx - 1] loop
      if not coalesce((t.stages -> prev ->> 'ok')::boolean, false) then
        raise exception 'portfolio: % cannot pass before % has', p_stage, prev using errcode = '22023';
      end if;
    end loop;
  end if;
  update portfolio_private.connector_smoke_tests set stages = stages || jsonb_build_object(p_stage,
      jsonb_build_object('ok', p_ok, 'at', now(), 'detail', coalesce(p_detail, '{}'::jsonb)))
   where id = p_test;
  return (select stages from portfolio_private.connector_smoke_tests where id = p_test);
end $$;
create or replace function public.portfolio_svc_smoke_finish(p_test uuid)
returns text language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare st text;
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.connector_smoke_tests
     set status = case when public.portfolio_smoke_all_ok(stages) and environment = 'PRODUCTION' then 'PASSED' else 'FAILED' end, finished_at = now()
   where id = p_test and status = 'RUNNING' returning status into st;
  return st;
end $$;
create or replace function public.portfolio_svc_smoke_status(p_test uuid)
returns jsonb language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select to_jsonb(t) from portfolio_private.connector_smoke_tests t where t.id = p_test);
end $$;
-- Forget an account's cursor, so its next sync re-reads the whole history
-- (the smoke test's NO DUPLICATES stage; an operator's repair).
create or replace function public.portfolio_svc_reset_cursor(p_account uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update public.platform_accounts set sync_cursor = null, next_sync_at = now() where id = p_account and connection_type = 'API';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. WHAT A READER CALLS
-- ─────────────────────────────────────────────────────────────────────────────
-- Disconnect one of MY automatic accounts. Runs as the definer to reach the
-- credential row, and checks the account is the caller's before touching it.
create or replace function public.portfolio_disconnect(p_account uuid, p_delete_history boolean default false)
returns jsonb language plpgsql security definer set search_path = public, portfolio_private, pg_temp as $$
declare a record; me uuid := auth.uid(); cred int; pos int := 0;
begin
  if me is null then raise exception 'portfolio: sign in first' using errcode = '42501'; end if;
  select id, connection_type into a from public.platform_accounts where id = p_account and user_id = me;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  if a.connection_type not in ('API', 'OAUTH', 'AGGREGATOR') then raise exception 'portfolio: only an automatic account is disconnected' using errcode = '22023'; end if;
  /* the account is the caller's: what follows is the connector's own change
     (status, the credential note), which the account's guard keeps from
     readers — so the rest of this transaction runs without the reader's
     identity, on the one account checked above */
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  delete from portfolio_private.platform_credentials where platform_account_id = p_account and user_id = me;
  get diagnostics cred = row_count;
  if p_delete_history then
    delete from public.portfolio_positions where platform_account_id = p_account and user_id = me and source = 'SYNC';
    get diagnostics pos = row_count;
    delete from public.platform_accounts where id = p_account and user_id = me;
  else
    update public.platform_accounts set status = 'DISCONNECTED', next_sync_at = null, metadata = metadata - 'credential'
     where id = p_account and user_id = me;
  end if;
  return jsonb_build_object('credential_deleted', cred > 0, 'positions_deleted', pos);
end $$;

-- The operator's view of every connector: run counts, failure codes and
-- timings by platform over a window. Counts only: no reader, no position,
-- no credential.
-- One connection attempt and how it ended (the connect function). Counts only.
create or replace function public.portfolio_svc_connector_event(p_platform text, p_kind text, p_code text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  insert into portfolio_private.connector_events (platform_key, kind, code) values (left(p_platform, 48), p_kind, left(p_code, 40));
end $$;

-- What the operator sees: per platform, every sync's outcome and what it
-- moved (records discovered, inserted, updated, duplicates rejected,
-- settlements recorded, rejected, reconciliations); connection attempts and
-- their failures; imports, parser failures and new file layouts. Counts and
-- rates only — never a reader, a credential or a position.
create or replace function public.portfolio_admin_connector_health(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare h int := greatest(1, least(coalesce(p_hours, 24), 720)); since timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return jsonb_build_object('window_hours', h,
    'platforms', (select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
        select jsonb_build_object('platform', r.platform, 'runs', count(*), 'succeeded', count(*) filter (where r.status = 'SUCCEEDED'),
            'partial', count(*) filter (where r.status = 'PARTIAL'), 'failed', count(*) filter (where r.status = 'FAILED'),
            'running', count(*) filter (where r.status = 'RUNNING'),
            'p50_ms', percentile_cont(0.5) within group (order by r.duration_ms), 'p95_ms', percentile_cont(0.95) within group (order by r.duration_ms),
            'discovered', coalesce(sum(r.fetched), 0), 'positions_inserted', coalesce(sum(r.positions_inserted), 0),
            'positions_updated', coalesce(sum(r.positions_updated), 0), 'transactions_inserted', coalesce(sum(r.transactions_inserted), 0),
            'duplicates_rejected', coalesce(sum(r.transactions_unchanged), 0), 'settlements', coalesce(sum(r.positions_settled), 0),
            'rejected', coalesce(sum(r.rejected), 0),
            'reconciled', count(*) filter (where (r.reconcile->>'ok')::boolean is true),
            'reconcile_mismatches', count(*) filter (where (r.reconcile->>'ok')::boolean is false),
            'errors', (select jsonb_object_agg(code, c) from (select r2.error_code as code, count(*) as c from public.portfolio_sync_runs r2
                        where r2.platform = r.platform and r2.started_at > since and r2.error_code is not null group by r2.error_code) e),
            'last_success', max(r.finished_at) filter (where r.status in ('SUCCEEDED', 'PARTIAL'))) as x
          from public.portfolio_sync_runs r where r.started_at > since group by r.platform) t),
    'connections', (select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
        select jsonb_build_object('platform', e.platform_key, 'attempts', count(*) filter (where e.kind = 'ATTEMPT'),
            'connected', count(*) filter (where e.kind = 'CONNECTED'), 'failed', count(*) filter (where e.kind = 'FAILED'),
            'disconnected', count(*) filter (where e.kind = 'DISCONNECTED'),
            'failures', (select jsonb_object_agg(code, c) from (select e2.code, count(*) as c from portfolio_private.connector_events e2
                          where e2.platform_key = e.platform_key and e2.at > since and e2.kind = 'FAILED' and e2.code is not null group by e2.code) f)) as x
          from portfolio_private.connector_events e where e.at > since group by e.platform_key) t),
    'imports', (select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
        select jsonb_build_object('platform', coalesce(i.platform, 'unknown'), 'files', count(*),
            'committed', count(*) filter (where i.status = 'COMMITTED'), 'failed', count(*) filter (where i.status = 'FAILED'),
            'not_finished', count(*) filter (where i.status in ('STAGED', 'CLASSIFIED')),
            'rows', coalesce(sum(i.rows_total), 0), 'parser_failures', coalesce(sum(i.rows_invalid), 0),
            'files_with_parser_failures', count(*) filter (where i.rows_invalid > 0),
            -- a layout first seen in the window, for a platform imported before
            -- with another layout: the platform may have changed its export
            'new_layouts', (select count(*) from (select i2.header_signature, min(i2.created_at) as first_at from public.portfolio_imports i2
                              where i2.platform is not distinct from i.platform and i2.header_signature is not null group by i2.header_signature) sig
                             where sig.first_at > since
                               and exists (select 1 from public.portfolio_imports i3 where i3.platform is not distinct from i.platform
                                            and i3.header_signature is not null and i3.header_signature <> sig.header_signature and i3.created_at <= since))) as x
          from public.portfolio_imports i where i.created_at > since group by i.platform) t),
    'registry', (select jsonb_agg(jsonb_build_object('platform', g.platform_key, 'automatic_method', g.automatic_method, 'connector_version', g.connector_version,
         'automatic_enabled', g.automatic_enabled, 'enabled_at', g.enabled_at, 'tos_review', g.tos_review, 'docs_verified_on', g.docs_verified_on,
         'import_verified', g.import_verified) order by g.platform_key) from public.portfolio_platform_registry g),
    'accounts', (select jsonb_object_agg(k, v) from (select status as k, count(*) as v from public.platform_accounts where connection_type = 'API' group by status) q));
end $$;

-- Time to value, for the operator: how long readers take from starting setup
-- to a first position and to a ready portfolio, how many abandon setup, and
-- how often imports and connections fail. Medians and rates only; no reader.
create or replace function public.portfolio_admin_ttv(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365))); out jsonb;
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  if to_regclass('public.user_events') is null then
    return jsonb_build_object('window_days', p_days, 'events', false, 'note', 'supabase/funnel.sql is not installed: no event data.');
  end if;
  execute $q$
    with ev as (select user_id, event_name, min(created_at) as at from public.user_events
                 where created_at > $1 and user_id is not null and event_name in ('portfolio_onboarding_started', 'first_position_created', 'portfolio_ready',
                   'connection_started', 'connection_completed', 'import_started', 'import_completed') group by user_id, event_name),
    starts as (select user_id, at from ev where event_name = 'portfolio_onboarding_started'),
    t as (select s.user_id, s.at as started,
                 (select at from ev e where e.user_id = s.user_id and e.event_name = 'first_position_created') as first_pos,
                 (select at from ev e where e.user_id = s.user_id and e.event_name = 'portfolio_ready') as ready
            from starts s)
    select jsonb_build_object(
      'window_days', $2, 'events', true,
      'onboarding_started', (select count(*) from t),
      'time_to_first_position_minutes_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from first_pos - started) / 60))::numeric, 1) from t where first_pos >= started),
      'time_to_portfolio_ready_minutes_median', (select round((percentile_cont(0.5) within group (order by extract(epoch from ready - started) / 60))::numeric, 1) from t where ready >= started),
      'onboarding_abandonment', (select case when count(*) > 0 then round(count(*) filter (where ready is null)::numeric / count(*), 4) end from t where started < now() - interval '7 days'),
      'import_failure_rate', (select case when count(*) > 0 then round(count(*) filter (where status = 'FAILED' or rows_failed > 0)::numeric / count(*), 4) end
                                from public.portfolio_imports where created_at > $1 and status in ('COMMITTED', 'FAILED')),
      'imports_abandoned', (select count(*) from public.portfolio_imports where created_at > $1 and created_at < now() - interval '1 day' and status in ('STAGED', 'CLASSIFIED')),
      'connection_failure_rate', (select case when count(*) > 0 then round(count(*) filter (where not exists (select 1 from ev c where c.user_id = s.user_id
                                    and c.event_name = 'connection_completed' and c.at >= s.at))::numeric / count(*), 4) end
                                    from ev s where s.event_name = 'connection_started'))
  $q$ into out using since, greatest(1, least(p_days, 365));
  return out;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_platform_registry enable row level security;
alter table public.portfolio_sync_runs enable row level security;
drop policy if exists portfolio_registry_read on public.portfolio_platform_registry;
create policy portfolio_registry_read on public.portfolio_platform_registry for select to authenticated using (true);
drop policy if exists portfolio_sync_runs_own on public.portfolio_sync_runs;
create policy portfolio_sync_runs_own on public.portfolio_sync_runs for select to authenticated using (user_id = auth.uid());

revoke all on public.portfolio_platform_registry, public.portfolio_sync_runs from public, anon;
revoke all on public.portfolio_platform_registry, public.portfolio_sync_runs from authenticated;
grant select on public.portfolio_platform_registry, public.portfolio_sync_runs to authenticated;
grant select, insert, update, delete on public.portfolio_platform_registry, public.portfolio_sync_runs to service_role;

revoke all on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions, portfolio_private.connector_events from public;
do $$ begin
  execute 'revoke all on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions, portfolio_private.connector_events from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.connector_smoke_tests, portfolio_private.connect_sessions, portfolio_private.connector_events to service_role';
  execute 'grant usage on sequence portfolio_private.connector_events_id_seq to service_role';
end $$;

-- Service functions: the service role only. Reader functions: signed-in readers.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_%' or p.proname in ('portfolio_disconnect', 'portfolio_admin_connector_health', 'portfolio_admin_ttv',
              'portfolio_is_admin', 'portfolio_registry_guard', 'portfolio_smoke_stages', 'portfolio_smoke_all_ok')) loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname like 'portfolio\_svc\_%' or f.proname = 'portfolio_registry_guard' then
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the registry, sync runs, smoke tests, connect sessions and connector events exist' as item,
    case when to_regclass('public.portfolio_platform_registry') is not null and to_regclass('public.portfolio_sync_runs') is not null
      and to_regclass('portfolio_private.connector_smoke_tests') is not null and to_regclass('portfolio_private.connect_sessions') is not null
      and to_regclass('portfolio_private.connector_events') is not null
      then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'no connector is switched on without a passing live smoke test',
    case when not exists (select 1 from public.portfolio_platform_registry g where g.automatic_enabled and not exists (
      select 1 from portfolio_private.connector_smoke_tests t where t.id = g.enabled_by_smoke_test and t.status = 'PASSED' and t.connector_version = g.connector_version))
      then 'ok' else 'CHECK THIS — a connector is on without its evidence' end
  union all select 3, 'no sportsbook has an automatic method',
    case when not exists (select 1 from public.portfolio_platform_registry where source_type = 'SPORTSBOOK' and automatic_method is not null) then 'ok' else 'CHECK THIS' end
  union all select 4, 'readers cannot call a service function, read a credential or a smoke test',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'portfolio\_svc\_%'
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
      and not has_schema_privilege('authenticated', 'portfolio_private', 'usage')
      then 'ok' else 'CHECK THIS — a service function or the private schema is reachable by a reader' end
  union all select 5, 'sync runs: row level security on, the reader''s own only',
    case when (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'portfolio_sync_runs')
      and exists (select 1 from pg_policies where tablename = 'portfolio_sync_runs' and qual like '%user_id = auth.uid()%') then 'ok' else 'CHECK THIS' end
  union all select 6, 'anon reads nothing here',
    case when not has_table_privilege('anon', 'public.portfolio_platform_registry', 'select') and not has_table_privilege('anon', 'public.portfolio_sync_runs', 'select')
      then 'ok' else 'CHECK THIS' end
) r order by 1;

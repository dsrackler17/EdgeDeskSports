-- =============================================================================
-- portfolio_aggregator.sql — sportsbook history through an APPROVED
-- AGGREGATOR (SharpSports BetSync first), over supabase/portfolio.sql and
-- supabase/portfolio_connect.sql.
--
-- WHY AN AGGREGATOR. No US sportsbook offers its customers an API for their
-- own bet history (docs/platform-support.md). An aggregator does: the reader
-- links their book on the AGGREGATOR's own page, the aggregator reads the
-- book, and EdgeDesk reads the aggregator with its own server-side key.
-- EdgeDesk never sees, asks for or stores a sportsbook password.
--
-- WHAT THIS ADDS (provider-agnostic; every row names its provider and its
-- environment, so a second aggregator is rows, not tables):
--   portfolio_private.aggregator_bettors         reader ↔ the aggregator's bettor:
--                                                an opaque internal id EdgeDesk
--                                                sends (never the auth id), and
--                                                the bettor id the aggregator's
--                                                own API confirmed
--   portfolio_private.aggregator_webhook_events  every delivery, once (dedupe
--                                                key), its references, how it was
--                                                authenticated, what became of it
--   portfolio_private.aggregator_webhook_rejections
--                                                refused deliveries: a reason and
--                                                a time, nothing else
--   public.portfolio_refresh_requests            each refresh EdgeDesk asked the
--                                                aggregator for, and its answer
--                                                (the reader reads their own)
--   public.portfolio_position_settlements        append-only: every settlement a
--                                                sync recorded or changed
--   portfolio_svc_ingest_wagers()                the sportsbook ingest: upsert by
--                                                the platform's id, reconcile with
--                                                the reader's own records, keep
--                                                notes, journal and attribution
--
-- THE TRUST RULE FOR WEBHOOKS. A delivery is a HINT, never data: it names
-- what changed, and EdgeDesk re-reads that bettor or account from the
-- aggregator's API with its own key before anything is stored. A forged
-- delivery can at most make EdgeDesk re-read an account it already holds;
-- it cannot add a wager, change a status or link an account.
--
-- THE SWITCH. Production linking needs the registry row
-- portfolio_platform_registry('sharpsports') switched on — which takes a
-- passing ten-stage live smoke test and a CLEARED terms review
-- (portfolio_connect.sql). Sandbox accounts are a separate environment: the
-- edge function lets only operators link them, every account and position
-- carries its environment, and a function configured for one environment
-- never reads or syncs the other's.
--
-- Run AFTER supabase/portfolio.sql, portfolio_journal.sql and
-- portfolio_connect.sql. Idempotent, additive, ends in a report.
-- Paste-sized: supabase/parts/portfolio_aggregator.part*-of-*.sql (npm run portfolio:parts).
-- =============================================================================

do $$ begin
  if to_regclass('public.portfolio_positions') is null or to_regclass('public.portfolio_platform_registry') is null
     or to_regprocedure('public.portfolio_svc_assert()') is null then
    raise exception 'portfolio_aggregator: run supabase/portfolio.sql and supabase/portfolio_connect.sql first';
  end if;
  if position('AGGREGATOR' in pg_get_functiondef('public.portfolio_svc_run_finish(uuid,text,text,text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'portfolio_aggregator: re-apply the current supabase/portfolio_connect.sql first (its run lifecycle must serve AGGREGATOR accounts)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE REGISTRY ROW — off. A re-run refreshes the description, never the switch.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.portfolio_platform_registry (platform_key, label, source_type, automatic_method, connector_version, docs_verified_on, import_profile, import_verified, notes) values
  ('sharpsports', 'SharpSports BetSync', 'SPORTSBOOK', 'AUTHORIZED_API', 'sharpsports_v1', null, null, false,
   'Sportsbook history through SharpSports BetSync: the reader links their book on SharpSports'' own page; EdgeDesk reads SharpSports with its server-side key. '
   || 'Built against the SharpSports documentation as indexed on 2026-10-14 (docs.sharpsports.io unreachable from the build environment); re-read it, '
   || 'pass the live smoke test and clear the terms review before enabling.')
on conflict (platform_key) do update set label = excluded.label, source_type = excluded.source_type, automatic_method = excluded.automatic_method,
  connector_version = excluded.connector_version, docs_verified_on = excluded.docs_verified_on, notes = excluded.notes;

-- May this provider link and sync accounts in this environment? Production:
-- only when the registry has it switched on, or for a running live smoke
-- test. Sandbox: the edge function admits operators only (it checks the
-- caller's own token); here it is simply a separate environment.
create or replace function public.portfolio_svc_ag_allowed(p_provider text, p_env text, p_smoke_test uuid default null)
returns boolean language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
declare reg record;
begin
  perform public.portfolio_svc_assert();
  if p_env not in ('sandbox', 'production') then raise exception 'portfolio: unknown environment %', p_env using errcode = '22023'; end if;
  select * into reg from public.portfolio_platform_registry where platform_key = p_provider and automatic_method = 'AUTHORIZED_API';
  if not found then raise exception 'portfolio: % is not a registered aggregator', p_provider using errcode = '22023'; end if;
  if p_env = 'sandbox' then return true; end if;
  return reg.automatic_enabled or exists (select 1 from portfolio_private.connector_smoke_tests t
    where t.id = p_smoke_test and t.platform_key = p_provider and t.status = 'RUNNING' and t.started_at > now() - interval '30 days');
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BETTORS — one per reader, provider and environment
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists portfolio_private.aggregator_bettors (
  id                  uuid        primary key default gen_random_uuid(),
  provider            text        not null,
  environment         text        not null,
  user_id             uuid        not null references auth.users(id) on delete cascade,
  internal_id         text        not null,
  provider_bettor_id  text        null,
  discover_at         timestamptz null,
  created_at          timestamptz not null default now(),
  confirmed_at        timestamptz null,
  last_discovered_at  timestamptz null,
  constraint aggregator_bettors_one unique (provider, environment, user_id),
  constraint aggregator_bettors_internal unique (provider, environment, internal_id),
  constraint aggregator_bettors_provider check (provider ~ '^[a-z0-9][a-z0-9_]{1,39}$'),
  constraint aggregator_bettors_env check (environment in ('sandbox', 'production')),
  constraint aggregator_bettors_ids check (internal_id ~ '^[A-Za-z0-9_-]{8,64}$' and coalesce(length(provider_bettor_id), 0) <= 120)
);
create unique index if not exists aggregator_bettors_provider_id
  on portfolio_private.aggregator_bettors (provider, environment, provider_bettor_id) where provider_bettor_id is not null;
create index if not exists aggregator_bettors_discover on portfolio_private.aggregator_bettors (discover_at) where discover_at is not null;
alter table portfolio_private.aggregator_bettors enable row level security;

-- The reader's bettor reference, made on first use. The internal id is
-- random: the aggregator never learns the reader's EdgeDesk account id.
create or replace function public.portfolio_svc_ag_bettor(p_provider text, p_env text, p_user uuid, p_smoke_test uuid default null)
returns table (internal_id text, provider_bettor_id text)
language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  if not public.portfolio_svc_ag_allowed(p_provider, p_env, p_smoke_test) then
    raise exception 'portfolio: automatic connection through % is not enabled', p_provider using errcode = '42501';
  end if;
  insert into portfolio_private.aggregator_bettors (provider, environment, user_id, internal_id)
  values (p_provider, p_env, p_user, 'ed_' || replace(gen_random_uuid()::text, '-', ''))
  on conflict (provider, environment, user_id) do nothing;
  return query select b.internal_id, b.provider_bettor_id from portfolio_private.aggregator_bettors b
    where b.provider = p_provider and b.environment = p_env and b.user_id = p_user;
end $$;

-- The aggregator's own API said which bettor carries this internal id. A
-- different answer for a bettor already confirmed is refused, never adopted.
create or replace function public.portfolio_svc_ag_bettor_confirm(p_provider text, p_env text, p_internal_id text, p_provider_bettor_id text)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare b record;
begin
  perform public.portfolio_svc_assert();
  if nullif(btrim(p_provider_bettor_id), '') is null or length(p_provider_bettor_id) > 120 then
    raise exception 'portfolio: a bettor id is required' using errcode = '22023';
  end if;
  select * into b from portfolio_private.aggregator_bettors where provider = p_provider and environment = p_env and internal_id = p_internal_id for update;
  if not found then raise exception 'portfolio: no such bettor reference' using errcode = 'P0002'; end if;
  if b.provider_bettor_id is not null and b.provider_bettor_id <> p_provider_bettor_id then
    raise exception 'portfolio: this bettor reference is already confirmed as another bettor' using errcode = '23505';
  end if;
  update portfolio_private.aggregator_bettors set provider_bettor_id = p_provider_bettor_id, confirmed_at = coalesce(confirmed_at, now()) where id = b.id;
  return b.user_id;
end $$;

-- A link was started: list the bettor's accounts in a few minutes even if
-- the reader never comes back to the page (or the provider's webhook is lost).
create or replace function public.portfolio_svc_ag_bettor_discover_soon(p_provider text, p_env text, p_user uuid, p_minutes int default 3)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.aggregator_bettors set discover_at = least(coalesce(discover_at, 'infinity'::timestamptz),
         now() + make_interval(mins => greatest(1, least(coalesce(p_minutes, 3), 60))))
   where provider = p_provider and environment = p_env and user_id = p_user;
end $$;

-- A discovery pass finished: the bettor's accounts were listed from the API.
create or replace function public.portfolio_svc_ag_bettor_discovered(p_provider text, p_env text, p_user uuid)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.aggregator_bettors set discover_at = null, last_discovered_at = now()
   where provider = p_provider and environment = p_env and user_id = p_user;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ACCOUNTS — a linked book is a platform account of connection_type
--    AGGREGATOR (tier 1, AUTHORIZED_API), its platform the BOOK's key
-- ─────────────────────────────────────────────────────────────────────────────
-- Create or refresh the reader's account for one linked book, from what the
-- aggregator's API says about it (p_detail: the provider's own state —
-- verified, access, paused, the book — never a credential). A QUICK IMPORT or
-- manual account for the same book is UPGRADED IN PLACE, so its history stays
-- where it is; a disconnected one is reused, so relinking never duplicates.
create or replace function public.portfolio_svc_ag_account_upsert(p_provider text, p_env text, p_user uuid, p_external_account_id text,
    p_platform text, p_platform_label text, p_detail jsonb default '{}'::jsonb, p_smoke_test uuid default null)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare acct uuid; prev text; created boolean := false; ext text := nullif(btrim(p_external_account_id), '');
        meta jsonb; clash record;
begin
  perform public.portfolio_svc_assert();
  if not public.portfolio_svc_ag_allowed(p_provider, p_env, p_smoke_test) then
    raise exception 'portfolio: automatic connection through % is not enabled', p_provider using errcode = '42501';
  end if;
  if ext is null or length(ext) > 200 then raise exception 'portfolio: the linked account''s id is required' using errcode = '22023'; end if;
  if p_platform !~ '^[a-z0-9][a-z0-9_]{1,47}$' or length(btrim(coalesce(p_platform_label, ''))) not between 1 and 60 then
    raise exception 'portfolio: a book needs a key and a label' using errcode = '22023';
  end if;
  if exists (select 1 from public.platform_accounts where user_id = p_user and platform = p_platform and platform_type <> 'SPORTSBOOK') then
    raise exception 'portfolio: % is not a sportsbook on this account', p_platform using errcode = '22023';
  end if;
  meta := jsonb_build_object('provider', p_provider, 'environment', p_env,
            'provider_state', coalesce(case when jsonb_typeof(p_detail) = 'object' then p_detail end, '{}'::jsonb), 'provider_state_at', now());
  -- the same linked account, seen before: it may not change environment or provider
  select id, status, metadata into clash from public.platform_accounts
   where user_id = p_user and platform = p_platform and connection_type = 'AGGREGATOR' and external_account_id = ext;
  if found then
    if clash.metadata->>'provider' is distinct from p_provider or clash.metadata->>'environment' is distinct from p_env then
      raise exception 'portfolio: that linked account belongs to another provider or environment' using errcode = '23505';
    end if;
    acct := clash.id; prev := clash.status;
  end if;
  if acct is null then
    -- upgrade QUICK IMPORT / manual in place, while this book has no linked account yet
    select id, status into acct, prev from public.platform_accounts
     where user_id = p_user and platform = p_platform and connection_type in ('CSV', 'MANUAL')
       and not exists (select 1 from public.platform_accounts b where b.user_id = p_user and b.platform = p_platform and b.connection_type = 'AGGREGATOR')
     order by case connection_type when 'CSV' then 0 else 1 end, created_at limit 1;
  end if;
  if acct is null then
    insert into public.platform_accounts (user_id, platform, platform_label, platform_type, connection_type, ingestion_method, external_account_id,
        status, next_sync_at, metadata)
    values (p_user, p_platform, btrim(p_platform_label), 'SPORTSBOOK', 'AGGREGATOR', 'AUTHORIZED_API', ext, 'SYNCING', now(), meta)
    returning id into acct;
    created := true;
  else
    update public.platform_accounts set connection_type = 'AGGREGATOR', ingestion_method = 'AUTHORIZED_API', external_account_id = ext,
           -- relinking a disconnected account starts it syncing again; any other state is the sync's to decide
           status = case when status in ('DISCONNECTED', 'IMPORT_ONLY', 'MANUAL') then 'SYNCING' else status end,
           last_error = case when status in ('DISCONNECTED', 'IMPORT_ONLY', 'MANUAL') then null else last_error end,
           consecutive_failures = case when status in ('DISCONNECTED', 'IMPORT_ONLY', 'MANUAL') then 0 else consecutive_failures end,
           next_sync_at = now(), metadata = (metadata - 'credential') || meta
     where id = acct;
  end if;
  return jsonb_build_object('account_id', acct, 'created', created, 'previous_status', prev);
end $$;

-- What the aggregator's API says about a linked account now (verified,
-- access, paused, the book, the latest refresh): kept on the account for the
-- reader and the operator to see. Never a credential; never from a webhook.
create or replace function public.portfolio_svc_ag_account_state(p_account uuid, p_detail jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  if jsonb_typeof(p_detail) is distinct from 'object' or pg_column_size(p_detail) > 4096 then
    raise exception 'portfolio: the provider state must be a small object' using errcode = '22023';
  end if;
  update public.platform_accounts set metadata = metadata || jsonb_build_object('provider_state', p_detail, 'provider_state_at', now())
   where id = p_account and connection_type = 'AGGREGATOR';
  if not found then raise exception 'portfolio: no such linked account' using errcode = 'P0002'; end if;
end $$;

-- The reader's linked accounts at one provider and environment (for a
-- discovery pass to compare with the aggregator's list).
create or replace function public.portfolio_svc_ag_accounts(p_provider text, p_env text, p_user uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'external_account_id', a.external_account_id, 'platform', a.platform,
            'status', a.status, 'last_success_at', a.last_success_at, 'sync_cursor', a.sync_cursor) order by a.created_at), '[]'::jsonb)
    from public.platform_accounts a
   where a.user_id = p_user and a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = p_provider and a.metadata->>'environment' = p_env);
end $$;

-- What the scheduler should do now at one provider and environment: linked
-- accounts that are due (a webhook makes one due at once — even one waiting
-- on the reader, so a relink that worked is noticed), and bettors whose
-- account list should be re-read. Production returns nothing while the
-- registry has the provider switched off.
create or replace function public.portfolio_svc_ag_due(p_provider text, p_env text, p_limit int default 10)
returns table (kind text, account_id uuid, user_id uuid, platform text, external_account_id text, sync_cursor text, status text, has_run boolean,
               internal_id text, provider_bettor_id text)
language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  if not public.portfolio_svc_ag_allowed(p_provider, p_env, null) then return; end if;
  return query
  (select 'ACCOUNT'::text, a.id, a.user_id, a.platform, a.external_account_id, a.sync_cursor, a.status,
          exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status in ('SUCCEEDED', 'PARTIAL')),
          b.internal_id, b.provider_bettor_id
     from public.platform_accounts a
     left join portfolio_private.aggregator_bettors b on b.user_id = a.user_id and b.provider = p_provider and b.environment = p_env
    where a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = p_provider and a.metadata->>'environment' = p_env
      and a.status in ('CONNECTED', 'SYNCING', 'ERROR', 'ACTION_REQUIRED') and a.next_sync_at is not null and a.next_sync_at <= now()
      and not exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status = 'RUNNING' and r.started_at > now() - interval '15 minutes')
    order by a.next_sync_at limit greatest(1, least(p_limit, 200)))
  union all
  (select 'BETTOR'::text, null::uuid, b.user_id, null::text, null::text, null::text, null::text, false, b.internal_id, b.provider_bettor_id
     from portfolio_private.aggregator_bettors b
    where b.provider = p_provider and b.environment = p_env and b.discover_at is not null and b.discover_at <= now()
    order by b.discover_at limit greatest(1, least(p_limit, 200)));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. WEBHOOK DELIVERIES — recorded once, applied as hints
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists portfolio_private.aggregator_webhook_events (
  id               bigserial   primary key,
  provider         text        not null,
  environment      text        not null,
  dedupe_key       text        not null,
  event_type       text        not null,
  authenticated_by text        not null,
  refs             jsonb       not null default '{}'::jsonb,
  payload          jsonb       null,
  status           text        not null default 'RECEIVED',
  attempts         int         not null default 1,
  received_at      timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  processed_at     timestamptz null,
  accounts_marked  int         not null default 0,
  bettors_marked   int         not null default 0,
  error_code       text        null,
  error_message    text        null,
  constraint aggregator_webhook_once unique (provider, environment, dedupe_key),
  constraint aggregator_webhook_env check (environment in ('sandbox', 'production')),
  constraint aggregator_webhook_status check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  constraint aggregator_webhook_auth check (authenticated_by in ('SIGNATURE', 'FETCH_BACK')),
  constraint aggregator_webhook_text check (length(provider) <= 40 and length(dedupe_key) between 8 and 200 and length(event_type) between 1 and 80
    and coalesce(length(error_code), 0) <= 40 and coalesce(length(error_message), 0) <= 500),
  constraint aggregator_webhook_json check (jsonb_typeof(refs) = 'object' and pg_column_size(refs) <= 4096
    and (payload is null or pg_column_size(payload) <= 32768))
);
create index if not exists aggregator_webhook_recent on portfolio_private.aggregator_webhook_events (received_at desc);
alter table portfolio_private.aggregator_webhook_events enable row level security;
-- which request header carried a valid signature: the operator reads it from
-- the first genuine delivery and pins it (supabase/functions/sharpsports-webhook)
alter table portfolio_private.aggregator_webhook_events add column if not exists signature_header text null;
alter table portfolio_private.aggregator_webhook_events add column if not exists subscription_id text null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'aggregator_webhook_sig_text') then
    alter table portfolio_private.aggregator_webhook_events add constraint aggregator_webhook_sig_text
      check (coalesce(length(signature_header), 0) <= 60 and coalesce(length(subscription_id), 0) <= 80);
  end if;
end $$;

create table if not exists portfolio_private.aggregator_webhook_rejections (
  id        bigserial   primary key,
  provider  text        not null,
  reason    text        not null,
  at        timestamptz not null default now(),
  constraint aggregator_rejection_text check (length(provider) <= 40 and length(reason) <= 40)
);
create index if not exists aggregator_rejections_at on portfolio_private.aggregator_webhook_rejections (at desc);
alter table portfolio_private.aggregator_webhook_rejections enable row level security;

-- Record a delivery. A repeat of one already PROCESSED or IGNORED is a
-- duplicate (answered, not applied again); a repeat of one that FAILED, or
-- is still RECEIVED, is applied again — that is what the provider's retry is for.
create or replace function public.portfolio_svc_ag_webhook_record(p_provider text, p_env text, p_dedupe_key text, p_event_type text,
    p_authenticated_by text, p_refs jsonb default '{}'::jsonb, p_payload jsonb default null, p_signature_header text default null,
    p_subscription_id text default null)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare r record;
begin
  perform public.portfolio_svc_assert();
  insert into portfolio_private.aggregator_webhook_events (provider, environment, dedupe_key, event_type, authenticated_by, refs, payload,
      signature_header, subscription_id)
  values (p_provider, p_env, p_dedupe_key, left(coalesce(nullif(btrim(p_event_type), ''), 'unknown'), 80), p_authenticated_by,
          coalesce(case when jsonb_typeof(p_refs) = 'object' then p_refs end, '{}'::jsonb), p_payload, left(p_signature_header, 60), left(p_subscription_id, 80))
  on conflict (provider, environment, dedupe_key) do update set attempts = aggregator_webhook_events.attempts + 1, last_received_at = now()
  returning id, status, attempts into r;
  return jsonb_build_object('event_id', r.id, 'duplicate', r.attempts > 1 and r.status in ('PROCESSED', 'IGNORED'), 'status', r.status, 'attempts', r.attempts);
end $$;

-- Apply a delivery: make the accounts and bettors it names due NOW. Nothing
-- from the payload is stored on them; the sync re-reads the aggregator.
-- A delivery naming nothing EdgeDesk holds is IGNORED (answered 200: the
-- provider must not retry it).
create or replace function public.portfolio_svc_ag_webhook_apply(p_event bigint)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare e record; accts text[]; bettors text[]; internals text[]; n_acct int := 0; n_bettor int := 0; st text;
begin
  perform public.portfolio_svc_assert();
  select * into e from portfolio_private.aggregator_webhook_events where id = p_event for update;
  if not found then raise exception 'portfolio: no such delivery' using errcode = 'P0002'; end if;
  select array_agg(distinct v) into accts from jsonb_array_elements_text(case when jsonb_typeof(e.refs->'bettor_account_ids') = 'array'
    then e.refs->'bettor_account_ids' else '[]'::jsonb end) v where length(v) between 1 and 200;
  select array_agg(distinct v) into bettors from jsonb_array_elements_text(case when jsonb_typeof(e.refs->'bettor_ids') = 'array'
    then e.refs->'bettor_ids' else '[]'::jsonb end) v where length(v) between 1 and 120;
  select array_agg(distinct v) into internals from jsonb_array_elements_text(case when jsonb_typeof(e.refs->'internal_ids') = 'array'
    then e.refs->'internal_ids' else '[]'::jsonb end) v where length(v) between 8 and 64;
  if accts is not null then
    -- at most once a minute per account, however often the provider calls
    update public.platform_accounts a set next_sync_at = greatest(now(), coalesce(a.last_sync_at, now() - interval '1 minute') + interval '1 minute')
     where a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = e.provider and a.metadata->>'environment' = e.environment
       and a.external_account_id = any (accts) and a.status <> 'DISCONNECTED';
    get diagnostics n_acct = row_count;
  end if;
  if bettors is not null or internals is not null then
    -- a bettor named by the delivery: list its accounts again (a new link,
    -- a relink, an account the reader added on the aggregator's page)
    update portfolio_private.aggregator_bettors b set discover_at = now()
     where b.provider = e.provider and b.environment = e.environment
       and (b.provider_bettor_id = any (coalesce(bettors, '{}')) or b.internal_id = any (coalesce(internals, '{}')));
    get diagnostics n_bettor = row_count;
  end if;
  st := case when n_acct + n_bettor > 0 then 'PROCESSED' else 'IGNORED' end;
  update portfolio_private.aggregator_webhook_events set status = st, processed_at = now(), accounts_marked = n_acct, bettors_marked = n_bettor,
         error_code = case when st = 'IGNORED' then 'UNKNOWN_REFERENCE' end, error_message = null
   where id = p_event;
  return jsonb_build_object('status', st, 'accounts_marked', n_acct, 'bettors_marked', n_bettor);
end $$;

create or replace function public.portfolio_svc_ag_webhook_finish(p_event bigint, p_status text, p_error_code text default null, p_error_message text default null)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.aggregator_webhook_events set status = p_status, processed_at = now(), error_code = left(p_error_code, 40),
         error_message = left(p_error_message, 500)
   where id = p_event;
end $$;

-- A refused delivery: counted, nothing of it kept.
create or replace function public.portfolio_svc_ag_webhook_reject(p_provider text, p_reason text)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  insert into portfolio_private.aggregator_webhook_rejections (provider, reason) values (left(p_provider, 40), left(p_reason, 40));
end $$;

-- Old deliveries go: processed or ignored ones after p_days, rejections
-- after p_days. A FAILED delivery is kept until an operator has seen it.
create or replace function public.portfolio_svc_ag_prune(p_days int default 90)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare d int := greatest(7, least(coalesce(p_days, 90), 3650)); n1 int; n2 int;
begin
  perform public.portfolio_svc_assert();
  delete from portfolio_private.aggregator_webhook_events where status in ('PROCESSED', 'IGNORED') and received_at < now() - make_interval(days => d);
  get diagnostics n1 = row_count;
  delete from portfolio_private.aggregator_webhook_rejections where at < now() - make_interval(days => d);
  get diagnostics n2 = row_count;
  return jsonb_build_object('events', n1, 'rejections', n2);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. REFRESH REQUESTS — what EdgeDesk asked the aggregator to fetch, and when
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_refresh_requests (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references auth.users(id) on delete cascade,
  platform_account_id  uuid        not null,
  provider             text        not null,
  requested_by         text        not null,
  status               text        not null default 'REQUESTED',
  requested_at         timestamptz not null default now(),
  responded_at         timestamptz null,
  provider_request_id  text        null,
  provider_response_id text        null,
  provider_code        text        null,
  message              text        null,
  constraint portfolio_refresh_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete cascade,
  constraint portfolio_refresh_by check (requested_by in ('READER', 'SCHEDULER', 'CONNECT', 'OPERATOR')),
  constraint portfolio_refresh_status check (status in ('REQUESTED', 'ACCEPTED', 'SUCCEEDED', 'FAILED', 'REFUSED', 'TIMED_OUT')),
  constraint portfolio_refresh_text check (length(provider) <= 40 and coalesce(length(provider_request_id), 0) <= 120
    and coalesce(length(provider_response_id), 0) <= 120 and coalesce(length(provider_code), 0) <= 40 and coalesce(length(message), 0) <= 300)
);
create index if not exists portfolio_refresh_account on public.portfolio_refresh_requests (platform_account_id, requested_at desc);
create unique index if not exists portfolio_refresh_response_once
  on public.portfolio_refresh_requests (platform_account_id, provider_response_id) where provider_response_id is not null;

-- Ask for a refresh, unless one was asked for this account within
-- p_min_minutes (then null: too soon). A request still open after two hours
-- is closed as TIMED_OUT first.
create or replace function public.portfolio_svc_ag_refresh_begin(p_account uuid, p_requested_by text, p_min_minutes int default 15)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare a record; rid uuid;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, metadata->>'provider' as provider into a from public.platform_accounts where id = p_account and connection_type = 'AGGREGATOR' for update;
  if not found then raise exception 'portfolio: no such linked account' using errcode = 'P0002'; end if;
  update public.portfolio_refresh_requests set status = 'TIMED_OUT', responded_at = now()
   where platform_account_id = p_account and status in ('REQUESTED', 'ACCEPTED') and requested_at < now() - interval '2 hours';
  if exists (select 1 from public.portfolio_refresh_requests where platform_account_id = p_account and status not in ('FAILED', 'REFUSED')
              and requested_at > now() - make_interval(mins => greatest(1, least(coalesce(p_min_minutes, 15), 10080)))) then
    return null;
  end if;
  insert into public.portfolio_refresh_requests (user_id, platform_account_id, provider, requested_by)
  values (a.user_id, a.id, a.provider, p_requested_by) returning id into rid;
  return rid;
end $$;

-- The aggregator's answer to the request itself (accepted, refused, failed).
create or replace function public.portfolio_svc_ag_refresh_update(p_refresh uuid, p_status text, p_provider_request_id text default null,
    p_code text default null, p_message text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update public.portfolio_refresh_requests set status = p_status, provider_request_id = coalesce(left(p_provider_request_id, 120), provider_request_id),
         provider_code = left(p_code, 40), message = left(p_message, 300),
         responded_at = case when p_status in ('SUCCEEDED', 'FAILED', 'REFUSED', 'TIMED_OUT') then now() else responded_at end
   where id = p_refresh;
end $$;

-- The outcome of the latest refresh, as the aggregator's API reports it on
-- the linked account (read by the sync, never taken from a webhook). It
-- closes the newest open request made before it; seen twice, it changes nothing.
create or replace function public.portfolio_svc_ag_refresh_seen(p_account uuid, p_provider_response_id text, p_ok boolean,
    p_code text default null, p_message text default null, p_at timestamptz default null)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare rid uuid;
begin
  perform public.portfolio_svc_assert();
  if nullif(btrim(p_provider_response_id), '') is null then return false; end if;
  if exists (select 1 from public.portfolio_refresh_requests where platform_account_id = p_account and provider_response_id = p_provider_response_id) then
    return false;
  end if;
  select id into rid from public.portfolio_refresh_requests
   where platform_account_id = p_account and status in ('REQUESTED', 'ACCEPTED') and requested_at <= coalesce(p_at, now()) + interval '1 minute'
   order by requested_at desc limit 1;
  if rid is null then return false; end if;
  update public.portfolio_refresh_requests set status = case when p_ok then 'SUCCEEDED' else 'FAILED' end, provider_response_id = left(p_provider_response_id, 120),
         provider_code = left(p_code, 40), message = left(p_message, 300), responded_at = coalesce(p_at, now())
   where id = rid;
  return true;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SETTLEMENT HISTORY — append-only, the reader's own
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_position_settlements (
  id                   bigserial   primary key,
  user_id              uuid        not null references auth.users(id) on delete cascade,
  position_id          uuid        not null,
  platform             text        not null,
  external_position_id text        null,
  previous_status      text        null,
  status               text        not null,
  previous_payout      numeric     null,
  reported_payout      numeric     null,
  settled_at           timestamptz null,
  run_id               uuid        null,
  recorded_at          timestamptz not null default now(),
  constraint portfolio_settlements_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_settlements_status check (status in ('OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED')
    and (previous_status is null or previous_status in ('OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED'))),
  constraint portfolio_settlements_text check (length(platform) <= 48 and coalesce(length(external_position_id), 0) <= 200)
);
create index if not exists portfolio_settlements_position on public.portfolio_position_settlements (position_id, recorded_at);
create index if not exists portfolio_settlements_user on public.portfolio_position_settlements (user_id, recorded_at desc);
create or replace function public.portfolio_position_settlements_frozen() returns trigger
language plpgsql as $$
begin
  raise exception 'portfolio: the settlement history is append-only' using errcode = '42501';
end $$;
drop trigger if exists portfolio_position_settlements_frozen_trg on public.portfolio_position_settlements;
create trigger portfolio_position_settlements_frozen_trg before update on public.portfolio_position_settlements
  for each row execute function public.portfolio_position_settlements_frozen();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. THE SPORTSBOOK INGEST
-- ─────────────────────────────────────────────────────────────────────────────
-- Normalized wagers (lib/edgedesk_portfolio_connect_core.js), upserted by the
-- platform's own id: the same payload twice writes nothing. The platform owns
-- the wager — stake, price, legs, status, payout, times — and a newer record
-- of it replaces the older; the reader owns their notes, the journal and
-- where the idea came from, and the ingest never touches those.
-- RECONCILIATION: a wager arriving for the first time that matches EXACTLY
-- ONE record the reader typed or imported (same book, same stake, same price,
-- same line where both have one, placed within 15 minutes) — and that record
-- matches exactly one wager arriving — ADOPTS it: one position, the reader's
-- journal kept. Two or more candidates stay apart and are reported, never guessed.
-- Each wager is its own sub-transaction: a bad one is rejected and reported alone.
create or replace function public.portfolio_svc_ingest_wagers(p_account uuid, p_run uuid, p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  a record; p jsonb; cur record; had boolean; pid uuid; was_new boolean; adopt uuid[]; cand record; twins int; did_adopt boolean;
  v_stake numeric; v_odds int; v_dec numeric; v_line numeric; v_placed timestamptz; v_settled timestamptz; v_status text; v_payout numeric;
  v_legs jsonb; v_raw jsonb; now_row record;
  pos_ins int := 0; pos_upd int := 0; pos_same int := 0; v_rejected int := 0; pos_settled int := 0; adopted int := 0;
  v_issues jsonb := coalesce(case when jsonb_typeof(p_payload->'issues') = 'array' then p_payload->'issues' end, '[]'::jsonb);
  list jsonb := coalesce(p_payload->'positions', '[]'::jsonb);
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform, platform_label, platform_type into a from public.platform_accounts where id = p_account;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  if a.platform_type <> 'SPORTSBOOK' then raise exception 'portfolio: wagers belong to a sportsbook account' using errcode = '22023'; end if;
  if jsonb_typeof(list) <> 'array' or jsonb_array_length(list) > 500 then
    raise exception 'portfolio: between 0 and 500 wagers per call' using errcode = '22023';
  end if;
  for p in select x from jsonb_array_elements(list) x loop
    begin
      if coalesce(p->>'platform', '') <> a.platform or nullif(btrim(p->>'external_position_id'), '') is null then
        raise exception using errcode = '22023', message = 'portfolio: a wager for another book, or without its id';
      end if;
      v_stake := (p->>'stake')::numeric; v_odds := (nullif(p->>'odds_american', ''))::int; v_dec := (nullif(p->>'odds_decimal', ''))::numeric;
      v_line := (nullif(p->>'line', ''))::numeric; v_placed := (p->>'placed_at')::timestamptz; v_settled := (nullif(p->>'settled_at', ''))::timestamptz;
      v_status := upper(coalesce(nullif(btrim(p->>'status'), ''), 'OPEN')); v_payout := (nullif(p->>'reported_payout', ''))::numeric;
      v_legs := case when jsonb_typeof(p->'legs') = 'array' and jsonb_array_length(p->'legs') > 0 then p->'legs' end;
      v_raw := case when jsonb_typeof(p->'raw') = 'object' then p->'raw' end;
      if v_placed is null then raise exception using errcode = '22023', message = 'portfolio: a wager without the time it was placed'; end if;
      select id, status, reported_payout, settled_at into cur from public.portfolio_positions
       where user_id = a.user_id and platform = a.platform and external_position_id = p->>'external_position_id';
      had := found; did_adopt := false;
      if not had then
        select array_agg(x.id order by x.placed_at) into adopt from public.portfolio_positions x
         where x.user_id = a.user_id and x.platform = a.platform and x.platform_type = 'SPORTSBOOK' and x.external_position_id is null
           and x.source in ('MANUAL', 'CSV', 'EDGEDESK') and x.stake = v_stake
           and ((v_odds is not null and x.odds_american = v_odds) or (v_odds is null and x.odds_american is null and x.odds_decimal = v_dec))
           and (x.line is null or v_line is null or x.line = v_line)
           and x.placed_at between v_placed - interval '15 minutes' and v_placed + interval '15 minutes';
        if coalesce(array_length(adopt, 1), 0) = 1 then
          select id, placed_at, stake, odds_american, odds_decimal into cand from public.portfolio_positions where id = adopt[1];
          -- the other direction: exactly one wager — arriving now or synced before — fits that record
          select (select count(*) from jsonb_array_elements(list) y
                   where (y->>'stake')::numeric = cand.stake
                     and ((cand.odds_american is not null and (nullif(y->>'odds_american', ''))::int = cand.odds_american)
                       or (cand.odds_american is null and (nullif(y->>'odds_decimal', ''))::numeric = cand.odds_decimal))
                     and (y->>'placed_at')::timestamptz between cand.placed_at - interval '15 minutes' and cand.placed_at + interval '15 minutes')
               + (select count(*) from public.portfolio_positions s
                   where s.user_id = a.user_id and s.platform = a.platform and s.source = 'SYNC' and s.stake = cand.stake
                     and s.odds_american is not distinct from cand.odds_american
                     and s.placed_at between cand.placed_at - interval '15 minutes' and cand.placed_at + interval '15 minutes')
            into twins;
          if twins = 1 then
            update public.portfolio_positions set external_position_id = p->>'external_position_id', platform_account_id = a.id where id = adopt[1];
            select id, status, reported_payout, settled_at into cur from public.portfolio_positions where id = adopt[1];
            had := true; did_adopt := true;
          end if;
        end if;
        if not did_adopt and coalesce(array_length(adopt, 1), 0) >= 1 and jsonb_array_length(v_issues) < 200 then
          v_issues := v_issues || jsonb_build_array(jsonb_build_object('code', 'POSSIBLE_DUPLICATE', 'ref', left(p->>'external_position_id', 120),
            'message', 'A bet you recorded yourself looks like this synced bet, but not uniquely enough to merge them; both are kept. Delete the copy you do not want.'));
        end if;
      end if;
      insert into public.portfolio_positions (user_id, platform_account_id, platform, platform_label, platform_type, external_position_id,
          position_type, sport, league, event_name, event_id, event_start_at, market_name, selection, side, line, legs,
          odds_american, odds_decimal, stake, stake_type, currency, reported_payout, fees, status, placed_at, settled_at, source, raw_payload)
      values (a.user_id, a.id, a.platform, coalesce(nullif(btrim(p->>'platform_label'), ''), a.platform_label), 'SPORTSBOOK', p->>'external_position_id',
          coalesce(nullif(p->>'position_type', ''), 'OTHER'), left(nullif(btrim(p->>'sport'), ''), 30), left(nullif(btrim(p->>'league'), ''), 30),
          left(coalesce(nullif(btrim(p->>'event_name'), ''), 'Wager ' || (p->>'external_position_id')), 200), left(nullif(p->>'event_id', ''), 120),
          (nullif(p->>'event_start_at', ''))::timestamptz,
          left(coalesce(nullif(btrim(p->>'market_name'), ''), 'Wager'), 200), left(coalesce(nullif(btrim(p->>'selection'), ''), 'As placed'), 200),
          left(nullif(btrim(p->>'side'), ''), 80), v_line, v_legs, v_odds, case when v_odds is null then v_dec end, v_stake,
          coalesce(nullif(p->>'stake_type', ''), 'CASH'), coalesce(nullif(p->>'currency', ''), 'USD'), v_payout, 0, v_status, v_placed, v_settled, 'SYNC', v_raw)
      on conflict (user_id, platform, external_position_id) where external_position_id is not null do update set
          platform_account_id = excluded.platform_account_id, position_type = excluded.position_type,
          sport = coalesce(excluded.sport, portfolio_positions.sport), league = coalesce(excluded.league, portfolio_positions.league),
          event_name = excluded.event_name, event_id = coalesce(excluded.event_id, portfolio_positions.event_id),
          event_start_at = coalesce(excluded.event_start_at, portfolio_positions.event_start_at),
          market_name = excluded.market_name, selection = excluded.selection, side = excluded.side, line = excluded.line, legs = excluded.legs,
          odds_american = excluded.odds_american, odds_decimal = excluded.odds_decimal, stake = excluded.stake, stake_type = excluded.stake_type,
          currency = excluded.currency, reported_payout = excluded.reported_payout, status = excluded.status, placed_at = excluded.placed_at,
          -- a settled wager whose record names no closing time keeps the one it has
          settled_at = case when excluded.status = 'OPEN' then null else coalesce(excluded.settled_at, portfolio_positions.settled_at) end,
          raw_payload = excluded.raw_payload
        where (portfolio_positions.platform_account_id, portfolio_positions.position_type, portfolio_positions.event_name, portfolio_positions.market_name,
               portfolio_positions.selection, portfolio_positions.side, portfolio_positions.line, portfolio_positions.legs, portfolio_positions.odds_american,
               portfolio_positions.stake, portfolio_positions.stake_type, portfolio_positions.currency, portfolio_positions.reported_payout,
               portfolio_positions.status, portfolio_positions.placed_at, portfolio_positions.raw_payload)
          is distinct from (excluded.platform_account_id, excluded.position_type, excluded.event_name, excluded.market_name,
               excluded.selection, excluded.side, excluded.line, excluded.legs, excluded.odds_american,
               excluded.stake, excluded.stake_type, excluded.currency, excluded.reported_payout,
               excluded.status, excluded.placed_at, excluded.raw_payload)
           or (excluded.odds_american is null and portfolio_positions.odds_decimal is distinct from excluded.odds_decimal)
           or (excluded.sport is not null and portfolio_positions.sport is distinct from excluded.sport)
           or (excluded.league is not null and portfolio_positions.league is distinct from excluded.league)
           or (excluded.event_id is not null and portfolio_positions.event_id is distinct from excluded.event_id)
           or (excluded.event_start_at is not null and portfolio_positions.event_start_at is distinct from excluded.event_start_at)
           or (excluded.status <> 'OPEN' and excluded.settled_at is not null and portfolio_positions.settled_at is distinct from excluded.settled_at)
      returning id, (xmax = 0) into pid, was_new;
      if pid is null then
        pos_same := pos_same + 1;
      else
        select status, reported_payout, settled_at into now_row from public.portfolio_positions where id = pid;
        if was_new then pos_ins := pos_ins + 1; else pos_upd := pos_upd + 1; end if;
        if did_adopt then adopted := adopted + 1; end if;
        -- the settlement history: every result this sync recorded or changed
        if (not had and now_row.status <> 'OPEN')
           or (had and (cur.status, cur.reported_payout) is distinct from (now_row.status, now_row.reported_payout)) then
          insert into public.portfolio_position_settlements (user_id, position_id, platform, external_position_id, previous_status, status,
              previous_payout, reported_payout, settled_at, run_id)
          values (a.user_id, pid, a.platform, p->>'external_position_id', case when had then cur.status end, now_row.status,
              case when had then cur.reported_payout end, now_row.reported_payout, now_row.settled_at, p_run);
          if now_row.status <> 'OPEN' then pos_settled := pos_settled + 1; end if;
        end if;
      end if;
    exception when others then
      v_rejected := v_rejected + 1;
      if jsonb_array_length(v_issues) < 200 then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object('code', 'REJECTED', 'ref', left(coalesce(p->>'external_position_id', '?'), 120),
          'message', left(regexp_replace(sqlerrm, '^portfolio: ', ''), 300)));
      end if;
    end;
  end loop;
  if p_run is not null then
    update public.portfolio_sync_runs set positions_inserted = positions_inserted + pos_ins, positions_updated = positions_updated + pos_upd,
           positions_settled = positions_settled + pos_settled, rejected = portfolio_sync_runs.rejected + v_rejected,
           fetched = fetched + coalesce((p_payload->>'fetched')::int, 0),
           issues = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(portfolio_sync_runs.issues || v_issues) e limit 200) q)
     where id = p_run and platform_account_id = p_account;
  end if;
  return jsonb_build_object('positions_inserted', pos_ins, 'positions_updated', pos_upd, 'positions_unchanged', pos_same, 'positions_settled', pos_settled,
    'positions_adopted', adopted, 'rejected', v_rejected, 'issues', v_issues, 'transactions_inserted', 0, 'transactions_unchanged', 0, 'healed', 0);
end $$;

-- What a linked account already holds, for an incremental sync: the wagers
-- still open (re-read until they settle) and the newest record seen.
create or replace function public.portfolio_svc_ag_open_wagers(p_account uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return jsonb_build_object(
    'open', (select coalesce(jsonb_agg(p.external_position_id order by p.placed_at), '[]'::jsonb) from public.portfolio_positions p
              where p.platform_account_id = p_account and p.external_position_id is not null and p.status = 'OPEN'),
    'stored', (select count(*) from public.portfolio_positions p where p.platform_account_id = p_account and p.external_position_id is not null));
end $$;

-- The operator's view of each aggregator: deliveries by status and how they
-- were authenticated (and which header carried the signature), refused
-- deliveries by reason, refresh requests by outcome, linked accounts by
-- environment and status. Counts only — no reader, payload or account id.
create or replace function public.portfolio_admin_aggregator_health(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public, portfolio_private, pg_temp as $$
declare since timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return jsonb_build_object('window_hours', greatest(1, least(coalesce(p_hours, 24), 720)),
    'deliveries', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object('provider', provider, 'environment', environment, 'event_type', event_type, 'status', status,
          'authenticated_by', authenticated_by, 'signature_header', signature_header, 'deliveries', count(*), 'attempts', sum(attempts),
          'last_at', max(last_received_at)) as x
          from portfolio_private.aggregator_webhook_events where last_received_at > since
         group by provider, environment, event_type, status, authenticated_by, signature_header order by provider, environment, event_type) q),
    'rejections', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from (select reason, count(*) as n
        from portfolio_private.aggregator_webhook_rejections where at > since group by reason) q),
    'failed_unresolved', (select count(*) from portfolio_private.aggregator_webhook_events where status = 'FAILED'),
    'refreshes', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select requested_by || ':' || status as k, count(*) as n
        from public.portfolio_refresh_requests where requested_at > since group by requested_by, status) q),
    'accounts', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select coalesce(metadata->>'provider', '?') || ':' || coalesce(metadata->>'environment', '?')
        || ':' || status as k, count(*) as n from public.platform_accounts where connection_type = 'AGGREGATOR' group by 1) q));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ROW LEVEL SECURITY AND GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.portfolio_refresh_requests enable row level security;
alter table public.portfolio_position_settlements enable row level security;
drop policy if exists portfolio_refresh_requests_own on public.portfolio_refresh_requests;
create policy portfolio_refresh_requests_own on public.portfolio_refresh_requests for select to authenticated using (user_id = auth.uid());
drop policy if exists portfolio_position_settlements_own on public.portfolio_position_settlements;
create policy portfolio_position_settlements_own on public.portfolio_position_settlements for select to authenticated using (user_id = auth.uid());

revoke all on public.portfolio_refresh_requests, public.portfolio_position_settlements from public, anon, authenticated;
grant select on public.portfolio_refresh_requests, public.portfolio_position_settlements to authenticated;
grant select, insert, update, delete on public.portfolio_refresh_requests, public.portfolio_position_settlements to service_role;
grant usage, select on sequence public.portfolio_position_settlements_id_seq to service_role;

revoke all on portfolio_private.aggregator_bettors, portfolio_private.aggregator_webhook_events, portfolio_private.aggregator_webhook_rejections from public;
do $$ begin
  execute 'revoke all on portfolio_private.aggregator_bettors, portfolio_private.aggregator_webhook_events, portfolio_private.aggregator_webhook_rejections from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.aggregator_bettors, portfolio_private.aggregator_webhook_events, portfolio_private.aggregator_webhook_rejections to service_role';
  execute 'grant usage on sequence portfolio_private.aggregator_webhook_events_id_seq, portfolio_private.aggregator_webhook_rejections_id_seq to service_role';
end $$;

-- service functions: the service role only (portfolio.sql's reader loop
-- skips portfolio_svc_*, and each one asserts its caller as well)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_ag\_%' or p.proname in ('portfolio_svc_ingest_wagers', 'portfolio_position_settlements_frozen')) loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
    if f.proname <> 'portfolio_position_settlements_frozen' then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  -- the operator panel checks its caller itself
  revoke all on function public.portfolio_admin_aggregator_health(int) from public, anon;
  grant execute on function public.portfolio_admin_aggregator_health(int) to authenticated, service_role;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the bettor, webhook, refresh and settlement tables exist' as item,
    case when to_regclass('portfolio_private.aggregator_bettors') is not null and to_regclass('portfolio_private.aggregator_webhook_events') is not null
      and to_regclass('portfolio_private.aggregator_webhook_rejections') is not null and to_regclass('public.portfolio_refresh_requests') is not null
      and to_regclass('public.portfolio_position_settlements') is not null then 'ok' else 'CHECK THIS — a table is missing' end as outcome
  union all select 2, 'SharpSports is registered as an aggregator, and is on only with its evidence',
    case when exists (select 1 from public.portfolio_platform_registry g where g.platform_key = 'sharpsports' and g.automatic_method = 'AUTHORIZED_API'
        and (not g.automatic_enabled or exists (select 1 from portfolio_private.connector_smoke_tests t where t.id = g.enabled_by_smoke_test
              and t.status = 'PASSED' and t.connector_version = g.connector_version and g.tos_review = 'CLEARED')))
      then 'ok' else 'CHECK THIS — the row is missing, or on without a passing smoke test and a cleared terms review' end
  union all select 3, 'no sportsbook has a direct automatic method (only an approved aggregator)',
    case when not exists (select 1 from public.portfolio_platform_registry where source_type = 'SPORTSBOOK'
      and automatic_method is not null and automatic_method <> 'AUTHORIZED_API') then 'ok' else 'CHECK THIS' end
  union all select 4, 'readers cannot call an aggregator service function, or reach the private tables',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
           and (p.proname like 'portfolio\_svc\_ag\_%' or p.proname = 'portfolio_svc_ingest_wagers')
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
      and not has_schema_privilege('authenticated', 'portfolio_private', 'usage') and not has_schema_privilege('anon', 'portfolio_private', 'usage')
      then 'ok' else 'CHECK THIS — a service function or the private schema is reachable by a reader' end
  union all select 5, 'refresh requests and settlements: row level security on, the reader''s own, read-only',
    case when (select bool_and(rowsecurity) from pg_tables where schemaname = 'public' and tablename in ('portfolio_refresh_requests', 'portfolio_position_settlements'))
      and (select count(*) from pg_policies where schemaname = 'public' and tablename in ('portfolio_refresh_requests', 'portfolio_position_settlements')
             and qual like '%user_id = auth.uid()%' and cmd = 'SELECT') = 2
      and not has_table_privilege('authenticated', 'public.portfolio_refresh_requests', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_position_settlements', 'update')
      and not has_table_privilege('authenticated', 'public.portfolio_position_settlements', 'delete') then 'ok' else 'CHECK THIS' end
  union all select 6, 'the settlement history is append-only',
    case when exists (select 1 from pg_trigger where tgname = 'portfolio_position_settlements_frozen_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select 7, 'anon reads nothing here',
    case when not has_table_privilege('anon', 'public.portfolio_refresh_requests', 'select') and not has_table_privilege('anon', 'public.portfolio_position_settlements', 'select')
      then 'ok' else 'CHECK THIS' end
  union all select 8, 'the run lifecycle serves aggregator accounts (portfolio_connect.sql is current)',
    case when position('AGGREGATOR' in pg_get_functiondef('public.portfolio_svc_run_begin(uuid,text)'::regprocedure)) > 0
      and position('RELINK_REQUIRED' in pg_get_functiondef('public.portfolio_svc_run_finish(uuid,text,text,text,text,jsonb)'::regprocedure)) > 0
      then 'ok' else 'CHECK THIS — re-apply supabase/portfolio_connect.sql' end
) r order by 1;

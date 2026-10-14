-- portfolio_aggregator -- part 1 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
  -- only a PRODUCTION smoke test opens production; a sandbox rehearsal (DEMO) never does
  return reg.automatic_enabled or exists (select 1 from portfolio_private.connector_smoke_tests t
    where t.id = p_smoke_test and t.platform_key = p_provider and t.status = 'RUNNING' and t.environment = 'PRODUCTION'
      and t.started_at > now() - interval '30 days');
end $$;

-- A smoke test of an aggregator, in the environment it really runs in: a
-- sandbox rehearsal is recorded as DEMO, so it can never be the evidence
-- that switches production on (the registry guard wants PRODUCTION).
create or replace function public.portfolio_svc_ag_smoke_begin(p_provider text, p_env text, p_run_by text default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare v text; tid uuid;
begin
  perform public.portfolio_svc_assert();
  if p_env not in ('sandbox', 'production') then raise exception 'portfolio: unknown environment %', p_env using errcode = '22023'; end if;
  select connector_version into v from public.portfolio_platform_registry where platform_key = p_provider and automatic_method = 'AUTHORIZED_API';
  if v is null then raise exception 'portfolio: % is not a registered aggregator', p_provider using errcode = '22023'; end if;
  insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment, run_by)
  values (p_provider, v, case p_env when 'production' then 'PRODUCTION' else 'DEMO' end, left(p_run_by, 120)) returning id into tid;
  return tid;
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

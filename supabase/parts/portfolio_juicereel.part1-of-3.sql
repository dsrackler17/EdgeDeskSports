-- portfolio_juicereel -- part 1 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- portfolio_juicereel.sql — sportsbook history through JUICE REEL's OAuth 2.0
-- API, over supabase/portfolio.sql, portfolio_connect.sql and
-- portfolio_aggregator.sql.
--
-- WHAT JUICE REEL IS HERE. A bet tracker that syncs a bettor's sportsbook
-- accounts. The reader signs in on Juice Reel's own page and approves
-- EdgeDesk (authorization code + PKCE); EdgeDesk's server exchanges the code
-- and reads the reader's open and settled bets with the bearer token. ONE
-- grant covers every book Juice Reel tracks for the reader; each bet names
-- its book, and each book is the reader's own platform_accounts row under
-- the book's key (connection_type AGGREGATOR, provider 'juicereel'), so the
-- existing ingest (portfolio_svc_ingest_wagers), settlement history,
-- reconciliation with file and manual records, P&L, ROI, units and every
-- analytic read Juice Reel bets exactly as they read any other synced book.
-- No second betting ledger exists.
--
-- WHAT THIS ADDS
--   the registry row 'juicereel'        OFF. Switching it on takes a PASSED
--                                       ten-stage PRODUCTION smoke test of
--                                       juicereel_v1 and a CLEARED terms
--                                       review (portfolio_registry_guard,
--                                       unchanged). Until then only an
--                                       operator running that test can link.
--   portfolio_private.oauth_grants      one per reader, provider and
--                                       environment: the access / refresh
--                                       pair as AES-256-GCM CIPHERTEXT only
--                                       (sealed by the edge function, key in
--                                       its secrets), the token generation,
--                                       the refresh lease, the sync lease,
--                                       the checkpoint and the schedule. Not
--                                       served by PostgREST; no client grant;
--                                       row level security on with no policy.
--   portfolio_svc_jr_*                  the service role's only door to it.
--
-- REFRESH-TOKEN ROTATION IS ATOMIC. Juice Reel's refresh token is single-use,
-- and sending a consumed one revokes the whole grant. So: a worker takes the
-- refresh LEASE for the generation it read (one statement; only one worker
-- can hold it), sends the refresh, and stores the new pair with
-- portfolio_svc_jr_rotate — one statement that succeeds only for the lease
-- holder, only from that generation, and only while the grant is still
-- connected. Every other worker waits for the new generation.
--
-- NOTHING READER-FACING CHANGES. Readers see their book accounts, positions,
-- sync runs and settlements under the RLS they already have; the grant is
-- described to them by the edge function (portfolio_svc_jr_status), never
-- read directly. Disconnect keeps the synced history unless the reader asks
-- for it to go (the existing retention rule, portfolio_disconnect's).
--
-- Run AFTER supabase/portfolio.sql, portfolio_journal.sql, portfolio_connect.sql
-- and portfolio_aggregator.sql (and, if installed, portfolio_decision.sql —
-- its "delete everything" then removes the grant as well).
-- Idempotent, additive, ends in a report. No existing table or row is
-- changed except by adding the registry row.
-- Paste-sized: supabase/parts/portfolio_juicereel.part*-of-*.sql (npm run portfolio:parts).
-- =============================================================================

do $$ begin
  if to_regprocedure('public.portfolio_svc_ag_account_upsert(text,text,uuid,text,text,text,jsonb,uuid)') is null
     or to_regprocedure('public.portfolio_svc_ingest_wagers(uuid,uuid,jsonb)') is null
     or to_regprocedure('public.portfolio_svc_ag_allowed(text,text,uuid)') is null then
    raise exception 'portfolio_juicereel: run supabase/portfolio_aggregator.sql first';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE REGISTRY ROW — off. A re-run refreshes the description, never the switch.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.portfolio_platform_registry (platform_key, label, source_type, automatic_method, connector_version, docs_verified_on, import_profile, import_verified, notes) values
  ('juicereel', 'Juice Reel', 'SPORTSBOOK', 'AUTHORIZED_API', 'juicereel_v1', date '2026-10-14', null, false,
   'Sportsbook history through Juice Reel (OAuth 2.0 authorization code + PKCE): the reader approves EdgeDesk on Juice Reel''s own page; EdgeDesk reads '
   || 'their open, settled and changed bets server-side. Built against juicereel.com/api-docs as of 2026-10-14. Off until Juice Reel approves the '
   || 'application, a PRODUCTION smoke test passes and the terms review clears.')
on conflict (platform_key) do update set label = excluded.label, source_type = excluded.source_type, automatic_method = excluded.automatic_method,
  connector_version = excluded.connector_version, docs_verified_on = excluded.docs_verified_on, notes = excluded.notes;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE GRANTS — ciphertext only
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists portfolio_private.oauth_grants (
  id                   uuid        primary key default gen_random_uuid(),
  provider             text        not null,
  environment          text        not null,
  user_id              uuid        not null references auth.users(id) on delete cascade,
  provider_user_id     text        null,
  display_name         text        null,
  status               text        not null default 'DISCONNECTED',
  scopes               text[]      null,
  ciphertext           bytea       null,
  nonce                bytea       null,
  key_version          int         null,
  access_expires_at    timestamptz null,
  token_generation     bigint      not null default 0,
  refresh_lease        uuid        null,
  refresh_lease_until  timestamptz null,
  sync_lease           uuid        null,
  sync_lease_until     timestamptz null,
  sync_cursor          text        null,
  smoke_test           uuid        null,
  next_sync_at         timestamptz null,
  last_sync_at         timestamptz null,
  last_success_at      timestamptz null,
  last_error_code      text        null,
  last_error           text        null,
  consecutive_failures int         not null default 0,
  last_issues          jsonb       not null default '[]'::jsonb,
  connected_at         timestamptz null,
  rotated_at           timestamptz null,
  revoked_at           timestamptz null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint oauth_grants_one unique (provider, environment, user_id),
  constraint oauth_grants_provider check (provider ~ '^[a-z0-9][a-z0-9_]{1,39}$'),
  constraint oauth_grants_env check (environment in ('sandbox', 'production')),
  constraint oauth_grants_status check (status in ('CONNECTED', 'ACTION_REQUIRED', 'ERROR', 'DISCONNECTED')),
  -- a sealed pair is whole or absent; a connected grant has one; a disconnected one never does
  constraint oauth_grants_sealed check ((ciphertext is null) = (nonce is null) and (ciphertext is null) = (key_version is null)
    and (status <> 'CONNECTED' or ciphertext is not null) and (status <> 'DISCONNECTED' or ciphertext is null)),
  constraint oauth_grants_text check (coalesce(length(provider_user_id), 0) <= 64 and coalesce(length(display_name), 0) <= 60
    and coalesce(length(sync_cursor), 0) <= 4000 and coalesce(length(last_error_code), 0) <= 40 and coalesce(length(last_error), 0) <= 500
    and coalesce(octet_length(ciphertext), 0) <= 16384 and coalesce(array_length(scopes, 1), 0) <= 20),
  constraint oauth_grants_issues check (jsonb_typeof(last_issues) = 'array' and jsonb_array_length(last_issues) <= 50 and pg_column_size(last_issues) <= 32768),
  constraint oauth_grants_failures check (consecutive_failures between 0 and 1000)
);
-- one Juice Reel account belongs to one EdgeDesk reader at a time
create unique index if not exists oauth_grants_provider_user
  on portfolio_private.oauth_grants (provider, environment, provider_user_id) where provider_user_id is not null and status <> 'DISCONNECTED';
create index if not exists oauth_grants_due on portfolio_private.oauth_grants (next_sync_at) where status in ('CONNECTED', 'ERROR');
alter table portfolio_private.oauth_grants enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE SERVICE FUNCTIONS (service role only; each asserts its caller)
-- ─────────────────────────────────────────────────────────────────────────────
-- The PRODUCTION smoke test of Juice Reel that is running now, if any (the
-- edge function lets an operator link under it while the registry is off).
create or replace function public.portfolio_svc_jr_smoke_current(p_env text)
returns uuid language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select t.id from portfolio_private.connector_smoke_tests t
           where t.platform_key = 'juicereel' and t.status = 'RUNNING' and t.environment = case p_env when 'production' then 'PRODUCTION' else 'DEMO' end
             and t.started_at > now() - interval '30 days' order by t.started_at desc limit 1);
end $$;

-- The reader's grant row, made on first use (DISCONNECTED, no tokens) — so a
-- pair can be sealed to its id before it is stored. Refused while Juice Reel
-- is off, unless the call belongs to a running PRODUCTION smoke test.
create or replace function public.portfolio_svc_jr_grant_prepare(p_user uuid, p_env text, p_smoke_test uuid default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare gid uuid;
begin
  perform public.portfolio_svc_assert();
  if not public.portfolio_svc_ag_allowed('juicereel', p_env, p_smoke_test) then
    raise exception 'portfolio: automatic connection through juicereel is not enabled' using errcode = '42501';
  end if;
  insert into portfolio_private.oauth_grants (provider, environment, user_id) values ('juicereel', p_env, p_user)
  on conflict (provider, environment, user_id) do nothing;
  select id into gid from portfolio_private.oauth_grants where provider = 'juicereel' and environment = p_env and user_id = p_user;
  return gid;
end $$;

-- A completed authorization: the sealed pair, the Juice Reel user it belongs
-- to, the scopes granted. The grant reads CONNECTED only from here — after a
-- real code exchange. A Juice Reel account already connected to another
-- EdgeDesk reader is refused. Reconnecting the same Juice Reel account keeps
-- the checkpoint; another account starts a fresh import.
create or replace function public.portfolio_svc_jr_grant_store(p_grant uuid, p_provider_user_id text, p_display_name text, p_ciphertext_b64 text,
    p_nonce_b64 text, p_key_version int, p_access_expires_at timestamptz, p_scopes text[], p_smoke_test uuid default null)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare g record; same boolean;
begin
  perform public.portfolio_svc_assert();
  select * into g from portfolio_private.oauth_grants where id = p_grant for update;
  if not found then raise exception 'portfolio: no such grant' using errcode = 'P0002'; end if;
  if not public.portfolio_svc_ag_allowed(g.provider, g.environment, p_smoke_test) then
    raise exception 'portfolio: automatic connection through % is not enabled', g.provider using errcode = '42501';
  end if;
  if coalesce(p_provider_user_id, '') !~ '^[0-9]{1,18}$' then raise exception 'portfolio: a Juice Reel user id is required' using errcode = '22023'; end if;
  if nullif(p_ciphertext_b64, '') is null or nullif(p_nonce_b64, '') is null or p_key_version is null or p_access_expires_at is null then
    raise exception 'portfolio: a sealed token pair is required' using errcode = '22023';
  end if;
  if exists (select 1 from portfolio_private.oauth_grants o where o.provider = g.provider and o.environment = g.environment
              and o.provider_user_id = p_provider_user_id and o.user_id <> g.user_id and o.status <> 'DISCONNECTED') then
    raise exception 'portfolio: JR_ACCOUNT_IN_USE — that Juice Reel account is connected to another EdgeDesk account' using errcode = '23505';
  end if;
  same := g.provider_user_id is not distinct from p_provider_user_id;
  update portfolio_private.oauth_grants set provider_user_id = p_provider_user_id, display_name = left(nullif(btrim(p_display_name), ''), 60),
         scopes = p_scopes, ciphertext = decode(p_ciphertext_b64, 'base64'), nonce = decode(p_nonce_b64, 'base64'), key_version = p_key_version,
         access_expires_at = p_access_expires_at, token_generation = token_generation + 1, refresh_lease = null, refresh_lease_until = null,
         sync_lease = null, sync_lease_until = null, sync_cursor = case when same then sync_cursor end, smoke_test = p_smoke_test,
         status = 'CONNECTED', last_error = null, last_error_code = null, consecutive_failures = 0, last_issues = '[]'::jsonb,
         next_sync_at = now(), connected_at = now(), rotated_at = now(), revoked_at = null, updated_at = now()
   where id = p_grant;
  return jsonb_build_object('grant_id', p_grant, 'reconnected', g.connected_at is not null, 'same_account', same);
end $$;

-- The sealed pair, for the edge function to open in memory (with what it
-- needs to decide whether to refresh). Never readable by any client role.
create or replace function public.portfolio_svc_jr_grant_tokens(p_grant uuid)
returns table (user_id uuid, status text, provider_user_id text, ciphertext_b64 text, nonce_b64 text, key_version int, access_expires_at timestamptz, generation bigint)
language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query select g.user_id, g.status, g.provider_user_id, encode(g.ciphertext, 'base64'), encode(g.nonce, 'base64'), g.key_version, g.access_expires_at,
         g.token_generation from portfolio_private.oauth_grants g where g.id = p_grant;
end $$;

-- THE REFRESH LEASE: for the generation the caller read, if nobody holds an
-- unexpired lease. Null: someone else is refreshing, or already has.
create or replace function public.portfolio_svc_jr_refresh_lease(p_grant uuid, p_generation bigint, p_seconds int default 60)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare l uuid;
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.oauth_grants set refresh_lease = gen_random_uuid(),
         refresh_lease_until = now() + make_interval(secs => greatest(10, least(coalesce(p_seconds, 60), 120))), updated_at = now()
   where id = p_grant and token_generation = p_generation and ciphertext is not null and status <> 'DISCONNECTED'
     and (refresh_lease is null or refresh_lease_until < now())
  returning refresh_lease into l;
  return l;
end $$;

-- THE ROTATION: the new pair replaces the old in one statement — only for the
-- lease holder (its lease id is unchanged even if the lease time ran out, as
-- no one else has taken it), only from the generation it refreshed, never on
-- a grant disconnected meanwhile. false: not stored (the caller revokes it).
create or replace function public.portfolio_svc_jr_rotate(p_grant uuid, p_lease uuid, p_generation bigint, p_ciphertext_b64 text, p_nonce_b64 text,
    p_key_version int, p_access_expires_at timestamptz, p_scopes text[] default null)
returns boolean language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  if nullif(p_ciphertext_b64, '') is null or nullif(p_nonce_b64, '') is null or p_key_version is null then return false; end if;
  update portfolio_private.oauth_grants set ciphertext = decode(p_ciphertext_b64, 'base64'), nonce = decode(p_nonce_b64, 'base64'), key_version = p_key_version,
         access_expires_at = p_access_expires_at, scopes = coalesce(p_scopes, scopes), token_generation = token_generation + 1,
         refresh_lease = null, refresh_lease_until = null, rotated_at = now(), updated_at = now()
   where id = p_grant and refresh_lease = p_lease and token_generation = p_generation and status <> 'DISCONNECTED' and ciphertext is not null;
  return found;
end $$;

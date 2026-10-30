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
--   public.portfolio_sync_matches       synced bets HELD for the reader's
--                                       review because they resemble a bet
--                                       the reader recorded or imported
--                                       themselves (2b). Not positions: never
--                                       counted until the reader decides.
--                                       The reader reads their own rows (RLS);
--                                       only the service role writes.
--   portfolio_positions_juicereel_once  one position per reader and Juice
--                                       Reel bet id, whichever book it is filed
--                                       under.
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
-- Idempotent, additive, ends in a report. No existing row is changed except
-- by adding the registry row; portfolio_positions gains one unique index
-- (made only when its data already satisfies it).
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
-- 2b. BETS HELD FOR THE READER'S REVIEW — never counted twice, never merged unasked
-- ─────────────────────────────────────────────────────────────────────────────
-- Juice Reel's bet ids are not the book's, so nothing identifies a synced
-- bet with one the reader typed, imported from a file, a screenshot or
-- pasted text. A synced bet that RESEMBLES such a record — the same book, the
-- stake within a cent, the same price, and placed close to it, or for the
-- same event (portfolio_svc_jr_candidates says exactly) — is therefore not
-- stored as a position. It is HELD here, its newest copy kept, until the
-- reader decides:
--   the same bet   their record takes the synced id and Juice Reel's figures
--                  (the shared ingest; its settlement history appended); their
--                  notes, journal and attribution stay; what the record said
--                  before is kept on the decision (merged_record);
--   a different bet  it is stored as its own position.
-- Until then the reader's own record is the one counted, so P&L, ROI, the
-- record and every count stay exactly as they were. EXACT marks a look-alike
-- the automatic adoption used to take (the same stake, price and line, placed
-- within 15 minutes, one each way), so all of those can be confirmed at once.
-- A held bet that no longer resembles anything of the reader's when it next
-- arrives (they deleted their copy) is stored, and the row says the sync
-- released it.
create table if not exists public.portfolio_sync_matches (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references auth.users(id) on delete cascade,
  provider             text        not null,
  platform_account_id  uuid        not null,
  platform             text        not null,
  external_position_id text        not null,
  wager                jsonb       not null,
  candidates           uuid[]      not null default '{}',
  exact                boolean     not null default false,
  status               text        not null default 'PENDING',
  resolved_by          text        null,
  merged_into          uuid        null,
  merged_record        jsonb       null,
  received_at          timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  resolved_at          timestamptz null,
  constraint portfolio_sync_matches_once unique (user_id, provider, external_position_id),
  constraint portfolio_sync_matches_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete cascade,
  constraint portfolio_sync_matches_ids check (provider ~ '^[a-z][a-z0-9_]{1,30}$' and left(external_position_id, length(provider) + 1) = provider || ':'
    and length(external_position_id) <= 200 and platform ~ '^[a-z0-9][a-z0-9_]{1,47}$'),
  constraint portfolio_sync_matches_status check (status in ('PENDING', 'MERGED', 'SEPARATE')
    and (status = 'PENDING') = (resolved_at is null) and (status = 'PENDING') = (resolved_by is null)
    and (resolved_by is null or resolved_by in ('READER', 'SYNC')) and (status = 'MERGED') = (merged_into is not null)),
  -- room for any wager the shared ingest accepts (its raw record alone may be 64 KB), so holding one never fails where storing it would not
  constraint portfolio_sync_matches_shape check (jsonb_typeof(wager) = 'object' and pg_column_size(wager) <= 200000
    and cardinality(candidates) <= 10 and (merged_record is null or pg_column_size(merged_record) <= 200000))
);
create index if not exists portfolio_sync_matches_pending on public.portfolio_sync_matches (user_id, received_at) where status = 'PENDING';
alter table public.portfolio_sync_matches enable row level security;
drop policy if exists portfolio_sync_matches_own on public.portfolio_sync_matches;
create policy portfolio_sync_matches_own on public.portfolio_sync_matches for select to authenticated using (user_id = auth.uid());

-- One position per reader, provider and Juice Reel bet id, whichever book it
-- is filed under (a bet whose book is edited in Juice Reel moves; it is never
-- a second row). Made only over data that already satisfies it: otherwise the
-- report below says CHECK THIS and names nothing it changed.
do $$ begin
  if to_regclass('public.portfolio_positions_juicereel_once') is null
     and not exists (select 1 from public.portfolio_positions where external_position_id like 'juicereel:%'
                      group by user_id, external_position_id having count(*) > 1) then
    create unique index portfolio_positions_juicereel_once on public.portfolio_positions (user_id, external_position_id)
      where external_position_id like 'juicereel:%';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE SERVICE FUNCTIONS (service role only; each asserts its caller)
-- ─────────────────────────────────────────────────────────────────────────────
-- The PRODUCTION smoke test of Juice Reel that is running now, if any (the
-- edge function lets every signed-in reader link under it while the
-- registry is off). It has no expiry: it runs until it is finished.
create or replace function public.portfolio_svc_jr_smoke_current(p_env text)
returns uuid language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select t.id from portfolio_private.connector_smoke_tests t
           where t.platform_key = 'juicereel' and t.status = 'RUNNING' and t.environment = case p_env when 'production' then 'PRODUCTION' else 'DEMO' end
           order by t.started_at desc limit 1);
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

-- A refresh that did not complete (Juice Reel down, rate limited): the lease
-- is given back, the pair is unchanged.
create or replace function public.portfolio_svc_jr_refresh_release(p_grant uuid, p_lease uuid)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.oauth_grants set refresh_lease = null, refresh_lease_until = null, updated_at = now() where id = p_grant and refresh_lease = p_lease;
end $$;

-- The reader's Juice Reel book accounts at one environment (the set every
-- grant-level change below applies to). In the svc namespace on purpose:
-- portfolio.sql and portfolio_journal.sql grant every other portfolio_*
-- function to readers when they are re-applied.
create or replace function public.portfolio_svc_jr_book_ids(p_user uuid, p_env text)
returns setof uuid language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query select a.id from public.platform_accounts a
   where a.user_id = p_user and a.connection_type = 'AGGREGATOR' and a.metadata->>'provider' = 'juicereel' and a.metadata->>'environment' = p_env;
end $$;

-- An authorization that can no longer be used (refresh refused, scope
-- withdrawn): ACTION REQUIRED — no retries until the reader reconnects —
-- and, when the pair is dead, the ciphertext goes. The book accounts say so.
-- p_generation: the pair the caller was refused for. A refusal of an older
-- pair (a reconnect stored a new one meanwhile) changes nothing.
create or replace function public.portfolio_svc_jr_grant_failed(p_grant uuid, p_code text, p_message text, p_drop_tokens boolean default false,
    p_generation bigint default null)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare g record;
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.oauth_grants set status = 'ACTION_REQUIRED', last_error_code = left(p_code, 40), last_error = left(p_message, 500), next_sync_at = null,
         ciphertext = case when p_drop_tokens then null else ciphertext end, nonce = case when p_drop_tokens then null else nonce end,
         key_version = case when p_drop_tokens then null else key_version end, access_expires_at = case when p_drop_tokens then null else access_expires_at end,
         refresh_lease = null, refresh_lease_until = null, updated_at = now()
   where id = p_grant and status <> 'DISCONNECTED' and (p_generation is null or token_generation = p_generation)
  returning user_id, environment into g;
  if found then
    update public.platform_accounts set status = 'ACTION_REQUIRED', last_error = left(p_message, 500), next_sync_at = null
     where id in (select public.portfolio_svc_jr_book_ids(g.user_id, g.environment)) and status <> 'DISCONNECTED';
  end if;
end $$;

-- A SYNC BEGINS: one at a time per grant (the sync lease; a worker that died
-- lets it lapse after five minutes). Null: running already, or not syncable.
create or replace function public.portfolio_svc_jr_sync_begin(p_grant uuid, p_kind text default 'INCREMENTAL')
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare g record;
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.oauth_grants set sync_lease = gen_random_uuid(), sync_lease_until = now() + interval '5 minutes', last_sync_at = now(), updated_at = now()
   where id = p_grant and status in ('CONNECTED', 'ERROR') and ciphertext is not null and (sync_lease is null or sync_lease_until < now())
  returning * into g;
  if not found then return null; end if;
  return jsonb_build_object('lease', g.sync_lease, 'user_id', g.user_id, 'environment', g.environment, 'cursor', g.sync_cursor, 'generation', g.token_generation,
    'provider_user_id', g.provider_user_id, 'smoke_test', g.smoke_test, 'kind', p_kind);
end $$;

-- A Juice Reel book's account for the sync holding the lease: made, or a
-- QUICK IMPORT / manual account of that book upgraded in place
-- (portfolio_svc_ag_account_upsert, unchanged). Refused once the lease is
-- lost — a disconnect or a reconnect happened while the sync ran.
create or replace function public.portfolio_svc_jr_book_account(p_grant uuid, p_lease uuid, p_site_key text, p_platform text, p_label text,
    p_detail jsonb default '{}'::jsonb)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare g record;
begin
  perform public.portfolio_svc_assert();
  select * into g from portfolio_private.oauth_grants where id = p_grant;
  if not found or g.sync_lease is distinct from p_lease or g.status in ('DISCONNECTED', 'ACTION_REQUIRED') then
    raise exception 'portfolio: this Juice Reel sync no longer holds its connection' using errcode = '55000';
  end if;
  if coalesce(p_site_key, '') !~ '^(id:[A-Za-z0-9_-]{1,40}|name:[a-z0-9_]{1,48}|none)$' then
    raise exception 'portfolio: a sportsbook key is required' using errcode = '22023';
  end if;
  return public.portfolio_svc_ag_account_upsert('juicereel', g.environment, g.user_id, 'juicereel:site:' || p_site_key, p_platform, p_label,
    coalesce(case when jsonb_typeof(p_detail) = 'object' and pg_column_size(p_detail) <= 2048 then p_detail end, '{}'::jsonb), g.smoke_test);
end $$;

-- A bet Juice Reel now files under another book (its sportsbook was edited
-- in Juice Reel) MOVES to that book's account: one position, its journal,
-- notes and attribution kept — never a second copy.
create or replace function public.portfolio_svc_jr_rehome(p_account uuid, p_ids text[])
returns int language plpgsql set search_path = public, pg_temp as $$
declare a record; n int;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform, platform_label into a from public.platform_accounts
   where id = p_account and connection_type = 'AGGREGATOR' and metadata->>'provider' = 'juicereel';
  if not found then raise exception 'portfolio: no such Juice Reel account' using errcode = 'P0002'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 1000 then raise exception 'portfolio: at most 1000 bets per call' using errcode = '22023'; end if;
  update public.portfolio_positions p set platform = a.platform, platform_label = a.platform_label, platform_account_id = a.id
   where p.user_id = a.user_id and p.external_position_id = any (p_ids) and p.external_position_id like 'juicereel:%' and p.platform <> a.platform
     and not exists (select 1 from public.portfolio_positions q where q.user_id = a.user_id and q.platform = a.platform
                      and q.external_position_id = p.external_position_id);
  get diagnostics n = row_count;
  return n;
end $$;

-- The reader's Juice Reel bets EdgeDesk holds as OPEN (for reconciliation
-- with Juice Reel's own open list), whichever book they sit under.
-- (a bet of a Juice Reel account the reader connected before — another
-- Juice Reel user — is not this grant's to reconcile)
create or replace function public.portfolio_svc_jr_open_positions(p_grant uuid)
returns jsonb language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
declare g record;
begin
  perform public.portfolio_svc_assert();
  select user_id, provider_user_id into g from portfolio_private.oauth_grants where id = p_grant;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', p.external_position_id, 'placed_at', p.placed_at) order by p.placed_at), '[]'::jsonb)
    from public.portfolio_positions p where p.user_id = g.user_id and p.status = 'OPEN' and p.external_position_id like 'juicereel:%'
      and (g.provider_user_id is null or p.raw_payload->>'userId' is null or p.raw_payload->>'userId' = g.provider_user_id));
end $$;

-- A SYNC ENDS. Only the run holding the lease records anything. Success:
-- CONNECTED, the checkpoint, and the next run in 20 minutes while the reader
-- has open bets (60 without; one minute when an import is part-way). The
-- book accounts read CONNECTED and synced now — the grant reads them all.
-- Failure: a dead or narrowed authorization is ACTION REQUIRED (no retry
-- storm); anything else backs off 5 min × 2^(n−1), capped at 6 hours (+5 min
-- when rate limited: Juice Reel's buckets are five minutes), ERROR after five.
create or replace function public.portfolio_svc_jr_sync_finish(p_grant uuid, p_lease uuid, p_ok boolean, p_cursor text default null, p_code text default null,
    p_message text default null, p_open int default null, p_more boolean default false, p_issues jsonb default null)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare g record; fails int; st text;
begin
  perform public.portfolio_svc_assert();
  select * into g from portfolio_private.oauth_grants where id = p_grant for update;
  if not found or g.sync_lease is distinct from p_lease then return; end if;
  if p_ok then
    update portfolio_private.oauth_grants set sync_lease = null, sync_lease_until = null, status = 'CONNECTED', last_success_at = now(), last_error = null,
           last_error_code = null, consecutive_failures = 0, sync_cursor = coalesce(left(p_cursor, 4000), sync_cursor),
           last_issues = coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(case when jsonb_typeof(p_issues) = 'array' then p_issues else '[]'::jsonb end) e limit 50) q), '[]'::jsonb),
           next_sync_at = now() + case when p_more then interval '1 minute' when coalesce(p_open, 0) > 0 then interval '20 minutes' else interval '60 minutes' end,
           updated_at = now()
     where id = p_grant;
    update public.platform_accounts set status = 'CONNECTED', last_sync_at = now(), last_success_at = now(), last_error = null, consecutive_failures = 0, next_sync_at = null
     where id in (select public.portfolio_svc_jr_book_ids(g.user_id, g.environment)) and status <> 'DISCONNECTED';
    return;
  end if;
  if p_code in ('GRANT_EXPIRED', 'JR_SCOPE_MISSING') then
    update portfolio_private.oauth_grants set sync_lease = null, sync_lease_until = null, updated_at = now() where id = p_grant;
    perform public.portfolio_svc_jr_grant_failed(p_grant, p_code, p_message, p_code = 'GRANT_EXPIRED');
    return;
  end if;
  if p_code = 'JR_DISCONNECTED' then
    update portfolio_private.oauth_grants set sync_lease = null, sync_lease_until = null, updated_at = now() where id = p_grant;
    return;
  end if;
  fails := g.consecutive_failures + 1;
  st := case when g.status = 'CONNECTED' and fails >= 5 then 'ERROR' else g.status end;
  -- a run cut short (429, 5xx, a cursor refused) still keeps the cursors it advanced: the pages it read were stored
  update portfolio_private.oauth_grants set sync_lease = null, sync_lease_until = null, consecutive_failures = fails, status = st,
         sync_cursor = coalesce(left(p_cursor, 4000), sync_cursor),
         last_error_code = left(p_code, 40), last_error = left(p_message, 500), updated_at = now(),
         next_sync_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(fails - 1, 10)))
                               + case when p_code = 'RATE_LIMITED' then interval '5 minutes' else interval '0' end
   where id = p_grant;
  update public.platform_accounts set last_error = left(p_message, 500), consecutive_failures = least(1000, consecutive_failures + 1),
         status = case when st = 'ERROR' then 'ERROR' else status end
   where id in (select public.portfolio_svc_jr_book_ids(g.user_id, g.environment)) and status <> 'DISCONNECTED';
end $$;

-- What the scheduler syncs now: connected (or failing) grants that are due,
-- whose sync is not running — and only while Juice Reel is switched on, or
-- the grant belongs to a running PRODUCTION smoke test.
create or replace function public.portfolio_svc_jr_due(p_env text, p_limit int default 10)
returns table (grant_id uuid, user_id uuid, has_success boolean)
language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query select g.id, g.user_id, g.last_success_at is not null and g.sync_cursor is not null
    from portfolio_private.oauth_grants g
   where g.provider = 'juicereel' and g.environment = p_env and g.status in ('CONNECTED', 'ERROR') and g.ciphertext is not null
     and g.next_sync_at is not null and g.next_sync_at <= now() and (g.sync_lease is null or g.sync_lease_until < now())
     and public.portfolio_svc_ag_allowed('juicereel', p_env, g.smoke_test)
   order by g.next_sync_at limit greatest(1, least(coalesce(p_limit, 10), 200));
end $$;

-- The reader's grant, for the reader's own page: state and times only — no
-- token, no ciphertext, no Juice Reel user id. Counted from the records
-- themselves: the bets carrying a Juice Reel id, the books they were placed
-- at, and the synced bets held for the reader's review (2b).
create or replace function public.portfolio_svc_jr_grant_for_user(p_user uuid, p_env text)
returns jsonb language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
declare g record;
begin
  perform public.portfolio_svc_assert();
  select * into g from portfolio_private.oauth_grants where provider = 'juicereel' and environment = p_env and user_id = p_user;
  if not found then return null; end if;
  return jsonb_build_object('grant_id', g.id, 'status', g.status, 'display_name', g.display_name, 'scopes', to_jsonb(coalesce(g.scopes, '{}'::text[])),
    'connected_at', g.connected_at, 'last_sync_at', g.last_sync_at, 'last_success_at', g.last_success_at, 'next_sync_at', g.next_sync_at,
    'last_error_code', g.last_error_code, 'last_error', g.last_error, 'consecutive_failures', g.consecutive_failures,
    'syncing', g.sync_lease is not null and g.sync_lease_until > now(), 'imported', g.sync_cursor is not null and g.sync_cursor like '%"initial_done":true%',
    'issues', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(g.last_issues) e limit 5) q),
    'revoked_at', g.revoked_at, 'smoke_test', g.smoke_test,
    'books', (select count(*) from public.platform_accounts a where a.id in (select public.portfolio_svc_jr_book_ids(g.user_id, g.environment)) and a.status <> 'DISCONNECTED'),
    'open_bets', (select count(*) from public.portfolio_positions p where p.user_id = g.user_id and p.status = 'OPEN' and p.external_position_id like 'juicereel:%'),
    'bets', (select count(*) from public.portfolio_positions p where p.user_id = g.user_id and p.external_position_id like 'juicereel:%'),
    'platforms', (select coalesce(jsonb_agg(q.platform_label order by q.n desc, q.platform_label), '[]'::jsonb) from (select p.platform_label, count(*) as n
        from public.portfolio_positions p where p.user_id = g.user_id and p.external_position_id like 'juicereel:%' group by p.platform_label
        order by count(*) desc, p.platform_label limit 20) q),
    'review', (select count(*) from public.portfolio_sync_matches s where s.user_id = g.user_id and s.provider = 'juicereel' and s.status = 'PENDING'),
    'review_exact', (select count(*) from public.portfolio_sync_matches s where s.user_id = g.user_id and s.provider = 'juicereel' and s.status = 'PENDING' and s.exact));
end $$;

-- DISCONNECT: the ciphertext goes now (the edge function revokes the pair at
-- Juice Reel with the copy it read just before), syncing stops, every Juice
-- Reel book account reads DISCONNECTED. History stays, unless the reader
-- asks: then the bets this connection synced go with its book accounts —
-- a bet the reader recorded or imported themselves stays, unlinked.
create or replace function public.portfolio_svc_jr_disconnect(p_user uuid, p_env text, p_delete_history boolean default false)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare had boolean; accts uuid[]; pos int := 0; n int := 0; g record;
begin
  perform public.portfolio_svc_assert();
  -- the pair as stored at this instant, a rotation committed a moment ago
  -- included (the row is locked): exactly this one is handed back to be
  -- revoked at Juice Reel, so no live pair survives a disconnect
  select id, ciphertext, nonce, key_version into g from portfolio_private.oauth_grants
   where provider = 'juicereel' and environment = p_env and user_id = p_user and status <> 'DISCONNECTED' for update;
  had := found;
  if had then
    update portfolio_private.oauth_grants set status = 'DISCONNECTED', ciphertext = null, nonce = null, key_version = null, access_expires_at = null,
           token_generation = token_generation + 1, refresh_lease = null, refresh_lease_until = null, sync_lease = null, sync_lease_until = null,
           sync_cursor = null, next_sync_at = null, last_error = null, last_error_code = null, consecutive_failures = 0, revoked_at = now(), updated_at = now()
     where id = g.id;
  end if;
  select array_agg(x) into accts from public.portfolio_svc_jr_book_ids(p_user, p_env) x;
  if accts is not null then
    if p_delete_history then
      delete from public.portfolio_positions where platform_account_id = any (accts) and user_id = p_user and source = 'SYNC';
      get diagnostics pos = row_count;
      delete from public.platform_accounts where id = any (accts) and user_id = p_user;
      get diagnostics n = row_count;
    else
      update public.platform_accounts set status = 'DISCONNECTED', next_sync_at = null where id = any (accts) and status <> 'DISCONNECTED';
      get diagnostics n = row_count;
    end if;
  end if;
  return jsonb_build_object('grant_disconnected', had, 'accounts', n, 'positions_deleted', pos, 'grant_id', case when had then g.id end,
    'sealed', case when had and g.ciphertext is not null then jsonb_build_object('ciphertext_b64', encode(g.ciphertext, 'base64'),
      'nonce_b64', encode(g.nonce, 'base64'), 'key_version', g.key_version) end);
end $$;

-- Forget a grant's checkpoint, so its next sync re-reads the whole history
-- (the smoke test's NO DUPLICATES stage; an operator's repair).
create or replace function public.portfolio_svc_jr_reset_cursor(p_grant uuid)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.oauth_grants set sync_cursor = null, next_sync_at = now(), updated_at = now() where id = p_grant and status <> 'DISCONNECTED';
end $$;

-- THE HELD BETS (2b). The reader's OWN records a synced wager may be: their
-- typed, file, screenshot or pasted bets at the same book that no provider
-- holds yet, with the stake within a cent and the same price — and placed
-- within 2 hours of it; or within 36 hours (a time typed late, a file read in
-- the wrong time zone) with the same event start (3 hours) or a word of the
-- pick or event in common; or, whenever placed (up to 14 days on), the same
-- event start: a screenshot whose time is when it was imported. Nearest
-- placement first, at most ten. p_strict: only the look-alikes the automatic
-- adoption used to take (the same stake, price and line, within 15 minutes).
create or replace function public.portfolio_svc_jr_candidates(p_user uuid, p_platform text, p_wager jsonb, p_strict boolean default false)
returns uuid[] language plpgsql stable set search_path = public, pg_temp as $$
declare v_stake numeric; v_odds int; v_dec numeric; v_line numeric; v_placed timestamptz; v_start timestamptz; v_price numeric; v_words text[]; ids uuid[];
  -- words too common in bet descriptions to say two bets are the same
  stop text[] := array['over', 'under', 'total', 'totals', 'spread', 'moneyline', 'money', 'line', 'parlay', 'parlays', 'teaser', 'wager', 'straight', 'single',
    'game', 'match', 'points', 'point', 'runs', 'goals', 'yards', 'first', 'second', 'half', 'quarter', 'period', 'inning', 'innings', 'player', 'prop', 'props',
    'alternate', 'plus', 'minus', 'team', 'with', 'from', 'legs', 'placed', 'other', 'wins', 'live'];
begin
  perform public.portfolio_svc_assert();
  v_stake := (nullif(p_wager->>'stake', ''))::numeric; v_odds := (nullif(p_wager->>'odds_american', ''))::int; v_dec := (nullif(p_wager->>'odds_decimal', ''))::numeric;
  v_line := (nullif(p_wager->>'line', ''))::numeric; v_placed := (nullif(p_wager->>'placed_at', ''))::timestamptz;
  v_start := (nullif(p_wager->>'event_start_at', ''))::timestamptz;
  -- the price as decimal odds, so a bet typed in decimal finds its American twin
  v_price := case when v_odds > 0 then 1 + v_odds / 100.0 when v_odds < 0 then 1 + 100.0 / abs(v_odds) else v_dec end;
  if v_stake is null or v_placed is null or v_price is null then return '{}'::uuid[]; end if;
  v_words := array(select distinct w from regexp_split_to_table(lower(coalesce(p_wager->>'selection', '') || ' ' || coalesce(p_wager->>'event_name', '')), '[^a-z0-9]+') w
                    where length(w) >= 4 and w <> all (stop));
  select coalesce(array_agg(q.id order by q.apart, q.id), '{}'::uuid[]) into ids from (
    select x.id, abs(extract(epoch from x.placed_at - v_placed)) as apart
      from public.portfolio_positions x
     where x.user_id = p_user and x.platform = p_platform and x.platform_type = 'SPORTSBOOK'
       and (x.external_position_id is null or x.external_position_id !~ '^[a-z][a-z0-9_]{1,30}:')
       and x.source in ('MANUAL', 'CSV', 'EDGEDESK', 'IMPORT_SCREENSHOT', 'IMPORT_PASTE')
       and x.placed_at between v_placed - interval '7 days' and v_placed + interval '14 days'
       and case when p_strict then
             x.stake = v_stake
             and ((v_odds is not null and x.odds_american = v_odds) or (v_odds is null and x.odds_american is null and x.odds_decimal = v_dec))
             and (x.line is null or v_line is null or x.line = v_line)
             and x.placed_at between v_placed - interval '15 minutes' and v_placed + interval '15 minutes'
           else
             abs(x.stake - v_stake) <= 0.01
             and abs(case when x.odds_american > 0 then 1 + x.odds_american / 100.0 when x.odds_american < 0 then 1 + 100.0 / abs(x.odds_american)
                          else x.odds_decimal end - v_price) <= 0.01
             and (x.placed_at between v_placed - interval '2 hours' and v_placed + interval '2 hours'
               or (v_start is not null and x.event_start_at between v_start - interval '3 hours' and v_start + interval '3 hours')
               or (x.placed_at between v_placed - interval '36 hours' and v_placed + interval '36 hours'
                   and array(select w from regexp_split_to_table(lower(coalesce(x.selection, '') || ' ' || coalesce(x.event_name, '')), '[^a-z0-9]+') w
                              where length(w) >= 4) && v_words))
           end
     order by apart, x.id limit 10) q;
  return ids;
end $$;

-- THE JUICE REEL INGEST. Each wager either goes on to the shared ingest
-- (portfolio_svc_ingest_wagers, told to adopt nothing) — a bet already
-- stored, a bet the reader already decided on, or one nothing of theirs
-- resembles — or is HELD for the reader, its newest copy kept. Both happen in
-- this one statement, so a run that fails stores neither, and no checkpoint
-- moves past a bet that is held nowhere.
create or replace function public.portfolio_svc_jr_ingest(p_account uuid, p_run uuid, p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  a record; p jsonb; ext text; held_id uuid; held_status text; cands uuid[]; tight uuid[]; cand record; twins int; v_exact boolean; got uuid;
  pass jsonb := '[]'::jsonb; n_held int := 0;
  list jsonb := coalesce(p_payload->'positions', '[]'::jsonb);
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform into a from public.platform_accounts
   where id = p_account and connection_type = 'AGGREGATOR' and metadata->>'provider' = 'juicereel';
  if not found then raise exception 'portfolio: no such Juice Reel account' using errcode = 'P0002'; end if;
  if jsonb_typeof(list) <> 'array' or jsonb_array_length(list) > 500 then
    raise exception 'portfolio: between 0 and 500 wagers per call' using errcode = '22023';
  end if;
  for p in select x from jsonb_array_elements(list) x loop
    ext := p->>'external_position_id'; held_id := null; held_status := null; got := null;
    begin
      -- not Juice Reel's shape or not this book (the shared ingest rejects it, with its reason), or already a position: updated in place
      if coalesce(ext, '') !~ '^juicereel:[0-9]{1,18}$' or p->>'platform' is distinct from a.platform
         or exists (select 1 from public.portfolio_positions where user_id = a.user_id and external_position_id = ext and external_position_id like 'juicereel:%') then
        pass := pass || jsonb_build_array(p); continue;
      end if;
      select id, status into held_id, held_status from public.portfolio_sync_matches where user_id = a.user_id and provider = 'juicereel' and external_position_id = ext;
      -- decided already (and its position since deleted by the reader): stored again, like any synced bet
      if held_status is not null and held_status <> 'PENDING' then pass := pass || jsonb_build_array(p); continue; end if;
      cands := public.portfolio_svc_jr_candidates(a.user_id, a.platform, p, false);
      if cardinality(cands) = 0 then
        if held_id is not null then
          update public.portfolio_sync_matches set status = 'SEPARATE', resolved_by = 'SYNC', resolved_at = now(), updated_at = now() where id = held_id and status = 'PENDING';
        end if;
        pass := pass || jsonb_build_array(p); continue;
      end if;
      -- EXACT: one strict look-alike, and that record fits exactly one synced wager — arriving now, held, or stored
      v_exact := false;
      tight := public.portfolio_svc_jr_candidates(a.user_id, a.platform, p, true);
      if cardinality(tight) = 1 then
        select id, placed_at, stake, odds_american, odds_decimal into cand from public.portfolio_positions where id = tight[1];
        select (select count(*) from jsonb_array_elements(list) y
                 where y->>'platform' = a.platform and (y->>'stake')::numeric = cand.stake
                   and ((cand.odds_american is not null and (nullif(y->>'odds_american', ''))::int = cand.odds_american)
                     or (cand.odds_american is null and (nullif(y->>'odds_decimal', ''))::numeric = cand.odds_decimal))
                   and (y->>'placed_at')::timestamptz between cand.placed_at - interval '15 minutes' and cand.placed_at + interval '15 minutes')
             + (select count(*) from public.portfolio_sync_matches o
                 where o.user_id = a.user_id and o.status = 'PENDING' and o.platform = a.platform and o.external_position_id <> ext
                   and (o.wager->>'stake')::numeric = cand.stake
                   and ((cand.odds_american is not null and (nullif(o.wager->>'odds_american', ''))::int = cand.odds_american)
                     or (cand.odds_american is null and (nullif(o.wager->>'odds_decimal', ''))::numeric = cand.odds_decimal))
                   and (o.wager->>'placed_at')::timestamptz between cand.placed_at - interval '15 minutes' and cand.placed_at + interval '15 minutes')
             + (select count(*) from public.portfolio_positions s
                 where s.user_id = a.user_id and s.platform = a.platform and s.source = 'SYNC' and s.stake = cand.stake
                   and s.odds_american is not distinct from cand.odds_american
                   and s.placed_at between cand.placed_at - interval '15 minutes' and cand.placed_at + interval '15 minutes')
          into twins;
        v_exact := twins = 1;
      end if;
      insert into public.portfolio_sync_matches (user_id, provider, platform_account_id, platform, external_position_id, wager, candidates, exact)
      values (a.user_id, 'juicereel', a.id, a.platform, ext, p, cands, v_exact)
      on conflict (user_id, provider, external_position_id) do update set platform_account_id = excluded.platform_account_id, platform = excluded.platform,
          wager = excluded.wager, candidates = excluded.candidates, exact = excluded.exact, updated_at = now()
        where portfolio_sync_matches.status = 'PENDING'
      returning id into got;
      -- decided a moment ago, by the reader (its row was locked): the shared ingest applies this copy to what they decided
      if got is null then pass := pass || jsonb_build_array(p); else n_held := n_held + 1; end if;
    exception when others then
      pass := pass || jsonb_build_array(p);
    end;
  end loop;
  return public.portfolio_svc_ingest_wagers(p_account, p_run, (p_payload - 'positions') || jsonb_build_object('positions', pass, 'adopt', false))
    || jsonb_build_object('positions_review', n_held);
end $$;

-- The reader's held bets, for their own review: what Juice Reel reported, and
-- each record of theirs it resembles that is still theirs to merge — how far
-- apart the two were placed, and whether the line agrees. Their own note is
-- shown to them, to tell two look-alikes apart.
create or replace function public.portfolio_svc_jr_matches(p_user uuid, p_limit int default 100)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return jsonb_build_object(
    'pending', (select count(*) from public.portfolio_sync_matches where user_id = p_user and status = 'PENDING'),
    'exact', (select count(*) from public.portfolio_sync_matches where user_id = p_user and status = 'PENDING' and exact),
    'matches', (select coalesce(jsonb_agg(m.o order by m.placed desc, m.ref), '[]'::jsonb) from (
      select (s.wager->>'placed_at')::timestamptz as placed, s.external_position_id as ref, jsonb_build_object(
          'id', s.id, 'ref', s.external_position_id, 'exact', s.exact, 'received_at', s.received_at, 'updated_at', s.updated_at,
          'wager', jsonb_build_object('platform', s.platform, 'platform_label', s.wager->>'platform_label', 'event_name', s.wager->>'event_name',
            'market_name', s.wager->>'market_name', 'selection', s.wager->>'selection', 'line', s.wager->>'line', 'stake', s.wager->>'stake',
            'odds_american', (nullif(s.wager->>'odds_american', ''))::int, 'odds_decimal', s.wager->>'odds_decimal', 'status', s.wager->>'status',
            'reported_payout', s.wager->>'reported_payout', 'placed_at', s.wager->>'placed_at', 'settled_at', s.wager->>'settled_at',
            'legs', case when jsonb_typeof(s.wager->'legs') = 'array' then jsonb_array_length(s.wager->'legs') else 0 end),
          'candidates', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'source', x.source, 'platform_label', x.platform_label, 'event_name', x.event_name,
                'market_name', x.market_name, 'selection', x.selection, 'line', x.line, 'stake', x.stake, 'odds_american', x.odds_american, 'odds_decimal', x.odds_decimal,
                'status', x.status, 'profit_loss', x.profit_loss, 'placed_at', x.placed_at, 'note', left(x.notes, 120),
                'minutes_apart', round(abs(extract(epoch from x.placed_at - (s.wager->>'placed_at')::timestamptz)) / 60)::int,
                'line_agrees', case when x.line is null or nullif(s.wager->>'line', '') is null then null else x.line = (s.wager->>'line')::numeric end)
              order by abs(extract(epoch from x.placed_at - (s.wager->>'placed_at')::timestamptz)), x.id), '[]'::jsonb)
             from public.portfolio_positions x where x.id = any (s.candidates) and x.user_id = p_user and x.platform = s.platform
              and (x.external_position_id is null or x.external_position_id !~ '^[a-z][a-z0-9_]{1,30}:'))) as o
        from public.portfolio_sync_matches s where s.user_id = p_user and s.status = 'PENDING'
       order by (s.wager->>'placed_at')::timestamptz desc, s.external_position_id limit greatest(1, least(coalesce(p_limit, 100), 500))) m));
end $$;

-- "The same bet": the reader's record p_position — one of the held bet's
-- look-alikes, still theirs and still unlinked — takes the synced id and
-- Juice Reel's figures through the shared ingest (the settlement history
-- appended; notes, journal and attribution untouched). What the record said
-- before is kept on the decision. All of it, or nothing.
create or replace function public.portfolio_svc_jr_merge(p_match uuid, p_position uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare m record; x record; r jsonb;
begin
  perform public.portfolio_svc_assert();
  select * into m from public.portfolio_sync_matches where id = p_match for update;
  if not found then raise exception 'portfolio: no such held bet' using errcode = 'P0002'; end if;
  if m.status <> 'PENDING' then raise exception 'portfolio: this synced bet was already decided' using errcode = '55000'; end if;
  if p_position is null or not (p_position = any (m.candidates)) then
    raise exception 'portfolio: that is not one of the bets this synced bet resembles' using errcode = '22023';
  end if;
  select * into x from public.portfolio_positions where id = p_position and user_id = m.user_id for update;
  if not found then raise exception 'portfolio: that bet is no longer in your portfolio' using errcode = 'P0002'; end if;
  if x.platform <> m.platform or (x.external_position_id is not null and x.external_position_id ~ '^[a-z][a-z0-9_]{1,30}:') then
    raise exception 'portfolio: that bet is already linked to a synced bet' using errcode = '55000';
  end if;
  update public.portfolio_positions set external_position_id = m.external_position_id, platform_account_id = m.platform_account_id where id = x.id;
  r := public.portfolio_svc_ingest_wagers(m.platform_account_id, null, jsonb_build_object('positions', jsonb_build_array(m.wager), 'adopt', false));
  if coalesce((r->>'rejected')::int, 0) > 0 then
    raise exception 'portfolio: the synced bet could not be applied (%)', coalesce(r->'issues'->-1->>'message', 'rejected') using errcode = '22023';
  end if;
  update public.portfolio_sync_matches set status = 'MERGED', resolved_by = 'READER', merged_into = x.id, resolved_at = now(), updated_at = now(),
         merged_record = jsonb_build_object('external_position_id', x.external_position_id, 'source', x.source, 'platform_account_id', x.platform_account_id,
           'position_type', x.position_type, 'event_name', x.event_name, 'market_name', x.market_name, 'selection', x.selection, 'side', x.side, 'line', x.line,
           'legs', x.legs, 'odds_american', x.odds_american, 'odds_decimal', x.odds_decimal, 'stake', x.stake, 'status', x.status, 'reported_payout', x.reported_payout,
           'placed_at', x.placed_at, 'settled_at', x.settled_at, 'raw_payload', x.raw_payload)
   where id = m.id;
  return jsonb_build_object('merged', 1, 'position_id', x.id);
end $$;

-- The reader's decision on one of THEIR held bets, once:
--   MERGE        it is their record p_position (portfolio_svc_jr_merge);
--   SEPARATE     a different bet: stored as its own position;
--   MERGE_EXACT  (no p_match) every held EXACT look-alike whose record is
--                still its only strict one, and no other held bet's.
create or replace function public.portfolio_svc_jr_match_resolve(p_user uuid, p_match uuid, p_decision text, p_position uuid default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare m record; r jsonb; ids uuid[]; n int := 0;
begin
  perform public.portfolio_svc_assert();
  if p_decision = 'MERGE_EXACT' then
    for m in select s.id, s.platform, s.wager from public.portfolio_sync_matches s
              where s.user_id = p_user and s.status = 'PENDING' and s.exact order by s.received_at, s.id for update loop
      ids := public.portfolio_svc_jr_candidates(p_user, m.platform, m.wager, true);
      if cardinality(ids) = 1 and not exists (select 1 from public.portfolio_sync_matches o
                                               where o.user_id = p_user and o.status = 'PENDING' and o.id <> m.id and ids[1] = any (o.candidates)) then
        perform public.portfolio_svc_jr_merge(m.id, ids[1]);
        n := n + 1;
      end if;
    end loop;
    return jsonb_build_object('merged', n, 'separate', 0);
  end if;
  select * into m from public.portfolio_sync_matches where id = p_match and user_id = p_user for update;
  if not found then raise exception 'portfolio: no such held bet' using errcode = 'P0002'; end if;
  if m.status <> 'PENDING' then raise exception 'portfolio: this synced bet was already decided' using errcode = '55000'; end if;
  if p_decision = 'MERGE' then
    return public.portfolio_svc_jr_merge(m.id, p_position) || jsonb_build_object('separate', 0);
  end if;
  if p_decision <> 'SEPARATE' then raise exception 'portfolio: decide MERGE, SEPARATE or MERGE_EXACT' using errcode = '22023'; end if;
  r := public.portfolio_svc_ingest_wagers(m.platform_account_id, null, jsonb_build_object('positions', jsonb_build_array(m.wager), 'adopt', false));
  if coalesce((r->>'rejected')::int, 0) > 0 then
    raise exception 'portfolio: the synced bet could not be stored (%)', coalesce(r->'issues'->-1->>'message', 'rejected') using errcode = '22023';
  end if;
  update public.portfolio_sync_matches set status = 'SEPARATE', resolved_by = 'READER', resolved_at = now(), updated_at = now() where id = m.id;
  return jsonb_build_object('merged', 0, 'separate', 1);
end $$;

-- The operator's view of Juice Reel connections: grants by status and how
-- recently they synced. Counts only — no reader, token or Juice Reel id.
create or replace function public.portfolio_admin_juicereel_health()
returns jsonb language plpgsql stable security definer set search_path = public, portfolio_private, pg_temp as $$
begin
  if not public.portfolio_is_admin() then raise exception 'portfolio: operators only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'grants', (select coalesce(jsonb_object_agg(environment || ':' || status, n), '{}'::jsonb) from (select environment, status, count(*) as n
        from portfolio_private.oauth_grants where provider = 'juicereel' group by environment, status) q),
    'errors', (select coalesce(jsonb_object_agg(last_error_code, n), '{}'::jsonb) from (select last_error_code, count(*) as n
        from portfolio_private.oauth_grants where provider = 'juicereel' and last_error_code is not null group by last_error_code) q),
    'synced_last_24h', (select count(*) from portfolio_private.oauth_grants where provider = 'juicereel' and last_success_at > now() - interval '24 hours'),
    'overdue', (select count(*) from portfolio_private.oauth_grants where provider = 'juicereel' and status in ('CONNECTED', 'ERROR')
        and next_sync_at < now() - interval '1 hour'));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. GRANTS: the service role only (and the operator panel checks its caller)
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on portfolio_private.oauth_grants from public;
do $$ begin
  execute 'revoke all on portfolio_private.oauth_grants from anon, authenticated';
  execute 'grant select, insert, update, delete on portfolio_private.oauth_grants to service_role';
  -- the held bets: the reader reads their own (RLS); only the service role decides or writes
  execute 'revoke all on public.portfolio_sync_matches from public, anon, authenticated';
  execute 'grant select on public.portfolio_sync_matches to authenticated';
  execute 'grant select, insert, update, delete on public.portfolio_sync_matches to service_role';
end $$;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and (p.proname like 'portfolio\_svc\_jr\_%' or p.proname = 'portfolio_admin_juicereel_health') loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    if f.proname = 'portfolio_admin_juicereel_health' then
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    else
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row should read ok.
-- ─────────────────────────────────────────────────────────────────────────────
select step, item, outcome from (
  select 1 as step, 'the grants table exists in the private schema, row level security on, no policy' as item,
    case when to_regclass('portfolio_private.oauth_grants') is not null
      and (select relrowsecurity from pg_class where oid = 'portfolio_private.oauth_grants'::regclass)
      and not exists (select 1 from pg_policies where schemaname = 'portfolio_private' and tablename = 'oauth_grants')
      then 'ok' else 'CHECK THIS' end as outcome
  union all select 2, 'tokens are stored only as ciphertext (no text column can hold one)',
    -- every text or JSON column is one of these, none of which a token is ever written to
    case when not exists (select 1 from information_schema.columns where table_schema = 'portfolio_private' and table_name = 'oauth_grants'
        and data_type in ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
        and column_name not in ('provider', 'environment', 'provider_user_id', 'display_name', 'status', 'scopes', 'sync_cursor', 'last_error_code',
                                'last_error', 'last_issues'))
      and (select data_type from information_schema.columns where table_schema = 'portfolio_private' and table_name = 'oauth_grants' and column_name = 'ciphertext') = 'bytea'
      then 'ok' else 'CHECK THIS' end
  union all select 3, 'Juice Reel is registered as an aggregator, and is on only with its evidence',
    case when exists (select 1 from public.portfolio_platform_registry g where g.platform_key = 'juicereel' and g.automatic_method = 'AUTHORIZED_API'
        and g.source_type = 'SPORTSBOOK'
        and (not g.automatic_enabled or exists (select 1 from portfolio_private.connector_smoke_tests t where t.id = g.enabled_by_smoke_test
              and t.status = 'PASSED' and t.environment = 'PRODUCTION' and t.connector_version = g.connector_version and g.tos_review = 'CLEARED')))
      then 'ok' else 'CHECK THIS — the row is missing, or on without a passing PRODUCTION smoke test and a cleared terms review' end
  union all select 4, 'readers cannot call a Juice Reel service function, or reach the grants',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'
           and p.proname like 'portfolio\_svc\_jr\_%'
           and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
      and not has_table_privilege('authenticated', 'portfolio_private.oauth_grants', 'select')
      and not has_table_privilege('anon', 'portfolio_private.oauth_grants', 'select')
      and not has_schema_privilege('authenticated', 'portfolio_private', 'usage') then 'ok' else 'CHECK THIS — a service function or the grants are reachable by a reader' end
  union all select 5, 'every Juice Reel service function asserts its caller',
    case when not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'portfolio\_svc\_jr\_%'
           and position('portfolio_svc_assert()' in pg_get_functiondef(p.oid)) = 0) then 'ok' else 'CHECK THIS' end
  union all select 6, 'a reader''s grant goes with their auth account',
    case when exists (select 1 from pg_constraint where conrelid = 'portfolio_private.oauth_grants'::regclass and contype = 'f' and confdeltype = 'c')
      then 'ok' else 'CHECK THIS' end
  union all select 7, '"delete everything" removes the grant too (when portfolio_decision.sql is installed)',
    case when to_regprocedure('public.portfolio_delete_everything(text)') is null then 'ok'
         when position('oauth_grants' in pg_get_functiondef('public.portfolio_delete_everything(text)'::regprocedure)) > 0 then 'ok'
         else 'CHECK THIS — re-apply the current supabase/portfolio_decision.sql' end
  union all select 8, 'no sportsbook has a direct automatic method (only an approved aggregator)',
    case when not exists (select 1 from public.portfolio_platform_registry where source_type = 'SPORTSBOOK'
      and automatic_method is not null and automatic_method <> 'AUTHORIZED_API') then 'ok' else 'CHECK THIS' end
  union all select 9, 'held bets: row level security on, a reader reads only their own and writes none',
    case when (select relrowsecurity from pg_class where oid = 'public.portfolio_sync_matches'::regclass)
      and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'portfolio_sync_matches') = 1
      and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'portfolio_sync_matches' and cmd = 'SELECT')
      and not has_table_privilege('authenticated', 'public.portfolio_sync_matches', 'insert')
      and not has_table_privilege('authenticated', 'public.portfolio_sync_matches', 'update')
      and not has_table_privilege('authenticated', 'public.portfolio_sync_matches', 'delete')
      and not has_table_privilege('anon', 'public.portfolio_sync_matches', 'select') then 'ok' else 'CHECK THIS' end
  union all select 10, 'one position per reader and Juice Reel bet id (unique, whichever book)',
    case when to_regclass('public.portfolio_positions_juicereel_once') is not null then 'ok'
      else 'CHECK THIS — the same Juice Reel bet is stored twice for a reader: keep one of each pair, then apply this file again' end
) r order by 1;

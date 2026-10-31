-- portfolio_juicereel -- part 1 of 5.
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

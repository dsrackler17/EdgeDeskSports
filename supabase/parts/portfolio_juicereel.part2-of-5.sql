-- portfolio_juicereel -- part 2 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

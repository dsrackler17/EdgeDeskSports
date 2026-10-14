-- portfolio_juicereel -- part 2 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
-- token, no ciphertext, no Juice Reel user id.
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
    'open_bets', (select count(*) from public.portfolio_positions p where p.user_id = g.user_id and p.status = 'OPEN' and p.external_position_id like 'juicereel:%'));
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

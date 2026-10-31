-- portfolio_juicereel -- part 3 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

-- The scopes Juice Reel granted on the most recent token (connect or
-- refresh), for the operator's credential check (jr_check). No reader, no
-- token, no Juice Reel id: the scopes, when, and the grant's status.
create or replace function public.portfolio_svc_jr_latest_scopes(p_env text)
returns jsonb language plpgsql stable set search_path = public, portfolio_private, pg_temp as $$
declare g record;
begin
  perform public.portfolio_svc_assert();
  select scopes, rotated_at, status into g from portfolio_private.oauth_grants
   where provider = 'juicereel' and environment = p_env and rotated_at is not null
   order by rotated_at desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('scopes', to_jsonb(coalesce(g.scopes, '{}'::text[])), 'at', g.rotated_at, 'status', g.status);
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

-- portfolio_juicereel -- part 4 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

-- portfolio_juicereel -- part 4 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

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


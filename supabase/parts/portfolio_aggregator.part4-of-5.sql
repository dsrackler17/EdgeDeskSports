-- portfolio_aggregator -- part 4 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. THE SPORTSBOOK INGEST
-- ─────────────────────────────────────────────────────────────────────────────
-- Normalized wagers (lib/edgedesk_portfolio_connect_core.js), upserted by the
-- platform's own id: the same payload twice writes nothing. The platform owns
-- the wager — stake, price, legs, status, payout, times — and a newer record
-- of it replaces the older; the reader owns their notes, the journal and
-- where the idea came from, and the ingest never touches those.
-- RECONCILIATION: a wager arriving for the first time that matches EXACTLY
-- ONE record the reader typed or imported — with or without the bet id the
-- book's own file carried (same book, same stake, same price,
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
         where x.user_id = a.user_id and x.platform = a.platform and x.platform_type = 'SPORTSBOOK'
           -- a bet the reader typed or imported, the book's own bet id from its file included; never one a
           -- provider already adopted (its id now in a provider's namespace: 'juicereel:…', 'sharpsports:…')
           and (x.external_position_id is null or x.external_position_id !~ '^[a-z][a-z0-9_]{1,30}:')
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

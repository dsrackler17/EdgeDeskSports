-- portfolio_connect -- part 3 of 5.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- THE INGEST. Normalized positions with their fills and fees, upserted by
-- the platform's own ids: running the same payload twice changes nothing.
-- Each position is its own sub-transaction: one that would break a rule
-- (no buy, more sold than bought, an impossible price) is rejected and
-- reported in the run — never silently dropped, never half-written.
-- SELF-HEALING: a payload may name replace_prefixes (a market whose holding
-- disagreed with the platform's at reconciliation). That market's synced
-- buys and sells are replaced by the full history the payload re-fetched,
-- and a side left with no buys is removed — the figure is rebuilt from the
-- platform's own record, never edited to agree.
create or replace function public.portfolio_svc_ingest(p_account uuid, p_run uuid, p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  a record; p jsonb; f jsonb; pid uuid; was_new boolean; n int;
  pos_ins int := 0; pos_upd int := 0; tx_ins int := 0; tx_same int := 0; v_rejected int := 0;
  v_issues jsonb := coalesce(p_payload->'issues', '[]'::jsonb);
  b numeric; s numeric; first_at timestamptz; pre text; healed int := 0;
  pos_settled int := 0; old_res text; old_sp numeric; new_res text;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform, platform_label, platform_type into a from public.platform_accounts where id = p_account;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  for p in select x from jsonb_array_elements(coalesce(p_payload->'positions', '[]'::jsonb)) x loop
    begin
      if coalesce(p->>'platform', '') <> a.platform or nullif(btrim(p->>'external_position_id'), '') is null then
        raise exception using errcode = '22023', message = 'portfolio: a position for another platform, or without its id';
      end if;
      perform set_config('portfolio.bulk_fills', 'on', true);
      select min((x->>'executed_at')::timestamptz) into first_at from jsonb_array_elements(coalesce(p->'fills', '[]'::jsonb)) x;
      -- what the position was settled as before this payload, so a new or
      -- changed settlement is counted (observability), never inferred
      old_res := null; old_sp := null; new_res := nullif(p->>'resolution', '');
      select resolution, settlement_price into old_res, old_sp from public.portfolio_positions
       where user_id = a.user_id and platform = a.platform and external_position_id = p->>'external_position_id';
      insert into public.portfolio_positions (user_id, platform_account_id, platform, platform_label, platform_type, external_position_id, contract_key,
          position_type, sport, league, event_name, event_id, event_start_at, market_name, selection, side, current_price, current_price_at,
          resolution, settlement_price, settled_at, placed_at, source)
      values (a.user_id, a.id, a.platform, coalesce(nullif(p->>'platform_label', ''), a.platform_label), 'PREDICTION_MARKET', p->>'external_position_id',
          nullif(p->>'contract_key', ''), coalesce(nullif(p->>'position_type', ''), 'EVENT_CONTRACT'), nullif(p->>'sport', ''), nullif(p->>'league', ''),
          left(coalesce(nullif(btrim(p->>'event_name'), ''), p->>'external_position_id'), 200), nullif(p->>'event_id', ''), (nullif(p->>'event_start_at', ''))::timestamptz,
          left(coalesce(nullif(btrim(p->>'market_name'), ''), nullif(btrim(p->>'event_name'), ''), p->>'external_position_id'), 200),
          left(coalesce(nullif(btrim(p->>'selection'), ''), p->>'side'), 200), left(nullif(btrim(p->>'side'), ''), 80),
          (nullif(p->>'current_price', ''))::numeric, (nullif(p->>'current_price_at', ''))::timestamptz,
          nullif(p->>'resolution', ''), (nullif(p->>'settlement_price', ''))::numeric, (nullif(p->>'settled_at', ''))::timestamptz,
          coalesce(first_at, now()), 'SYNC')
      on conflict (user_id, platform, external_position_id) where external_position_id is not null do update set
          platform_account_id = excluded.platform_account_id,
          event_name = excluded.event_name, event_id = coalesce(excluded.event_id, portfolio_positions.event_id),
          event_start_at = coalesce(excluded.event_start_at, portfolio_positions.event_start_at),
          market_name = excluded.market_name, selection = excluded.selection,
          current_price = coalesce(excluded.current_price, portfolio_positions.current_price),
          current_price_at = case when excluded.current_price is not null then excluded.current_price_at else portfolio_positions.current_price_at end,
          -- an updated settlement replaces the earlier one; a payload without one keeps it
          resolution = coalesce(excluded.resolution, portfolio_positions.resolution),
          settlement_price = case when excluded.resolution is not null then excluded.settlement_price else portfolio_positions.settlement_price end,
          settled_at = coalesce(excluded.settled_at, portfolio_positions.settled_at)
      returning id, (xmax = 0) into pid, was_new;
      -- a market being rebuilt: its old buys and sells go, in this position's
      -- own sub-transaction, so a rejected rebuild leaves them as they were
      if exists (select 1 from jsonb_array_elements_text(coalesce(p_payload->'replace_prefixes', '[]'::jsonb)) r
                  where length(r) >= 4 and left(p->>'external_position_id', length(r)) = r) then
        delete from public.portfolio_transactions where position_id = pid and source = 'SYNC' and transaction_type in ('BUY', 'SELL', 'FILL');
      end if;
      for f in select x from jsonb_array_elements(coalesce(p->'fills', '[]'::jsonb)) x loop
        insert into public.portfolio_transactions (user_id, platform_account_id, position_id, platform, external_transaction_id, transaction_type, side,
            quantity, price, fee, executed_at, source)
        values (a.user_id, a.id, pid, a.platform, f->>'external_transaction_id', upper(f->>'action'), upper(f->>'action'),
            (f->>'quantity')::numeric, (f->>'price')::numeric, coalesce((nullif(f->>'fee', ''))::numeric, 0), (f->>'executed_at')::timestamptz, 'SYNC')
        on conflict (user_id, platform, external_transaction_id) where external_transaction_id is not null do nothing;
        get diagnostics n = row_count;
        if n > 0 then tx_ins := tx_ins + 1; else tx_same := tx_same + 1; end if;
      end loop;
      for f in select x from jsonb_array_elements(coalesce(p->'fees', '[]'::jsonb)) x loop
        insert into public.portfolio_transactions (user_id, platform_account_id, position_id, platform, external_transaction_id, transaction_type,
            fee, executed_at, source)
        values (a.user_id, a.id, pid, a.platform, f->>'external_transaction_id', 'FEE', (f->>'fee')::numeric,
            coalesce((nullif(f->>'executed_at', ''))::timestamptz, now()), 'SYNC')
        on conflict (user_id, platform, external_transaction_id) where external_transaction_id is not null
          do update set fee = excluded.fee where portfolio_transactions.fee is distinct from excluded.fee;
        get diagnostics n = row_count;
        if n > 0 then tx_ins := tx_ins + 1; else tx_same := tx_same + 1; end if;
      end loop;
      perform set_config('portfolio.bulk_fills', 'off', true);
      -- the rules a contract position keeps, checked now so a bad one is
      -- rejected alone rather than failing the whole run at commit
      select coalesce(sum(quantity) filter (where transaction_type = 'BUY'), 0), coalesce(sum(quantity) filter (where transaction_type = 'SELL'), 0)
        into b, s from public.portfolio_transactions where position_id = pid;
      if b <= 0 then raise exception using errcode = '23514', message = 'portfolio: a prediction-market position needs at least one buy'; end if;
      if s > b then raise exception using errcode = '23514', message = 'portfolio: more contracts sold than bought'; end if;
      update public.portfolio_positions set updated_at = now() where id = pid;
      if was_new then pos_ins := pos_ins + 1; else pos_upd := pos_upd + 1; end if;
      if new_res is not null and (old_res is distinct from new_res or old_sp is distinct from (nullif(p->>'settlement_price', ''))::numeric) then
        pos_settled := pos_settled + 1;
      end if;
    exception when others then
      perform set_config('portfolio.bulk_fills', 'off', true);
      v_rejected := v_rejected + 1;
      if jsonb_array_length(v_issues) < 200 then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object('code', 'REJECTED', 'ref', left(coalesce(p->>'external_position_id', '?'), 120),
          'message', left(regexp_replace(sqlerrm, '^portfolio: ', ''), 300)));
      end if;
    end;
  end loop;
  -- a rebuilt market: a side the platform's full history no longer has is
  -- removed (its record was the error being repaired)
  for pre in select jsonb_array_elements_text(coalesce(p_payload->'replace_prefixes', '[]'::jsonb)) loop
    if length(pre) < 4 or left(pre, length(a.platform) + 1) <> a.platform || ':' then continue; end if;
    delete from public.portfolio_positions p2 where p2.platform_account_id = a.id and p2.source = 'SYNC' and left(p2.external_position_id, length(pre)) = pre
       and not exists (select 1 from jsonb_array_elements(coalesce(p_payload->'positions', '[]'::jsonb)) x where x->>'external_position_id' = p2.external_position_id);
    healed := healed + 1;
  end loop;
  if p_run is not null then
    update public.portfolio_sync_runs set positions_inserted = positions_inserted + pos_ins, positions_updated = positions_updated + pos_upd,
           positions_settled = positions_settled + pos_settled,
           transactions_inserted = transactions_inserted + tx_ins, transactions_unchanged = transactions_unchanged + tx_same,
           rejected = portfolio_sync_runs.rejected + v_rejected,
           fetched = fetched + coalesce((p_payload->>'fetched')::int, 0),
           issues = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(portfolio_sync_runs.issues || v_issues) e limit 200) q)
     where id = p_run and platform_account_id = p_account;
  end if;
  return jsonb_build_object('positions_inserted', pos_ins, 'positions_updated', pos_upd, 'transactions_inserted', tx_ins,
    'transactions_unchanged', tx_same, 'rejected', v_rejected, 'issues', v_issues, 'healed', healed, 'positions_settled', pos_settled);
end $$;

-- A sync run ends. Success: CONNECTED, the cursor kept, the next run in 30
-- minutes. A credential the platform refused: ACTION_REQUIRED (the reader must
-- reconnect; no retry storm). Anything else: retried with backoff (5 min,
-- 10, 20 … capped at 6 hours), ERROR after five failures in a row.
create or replace function public.portfolio_svc_run_finish(p_run uuid, p_status text, p_error_code text default null, p_error_message text default null,
    p_cursor text default null, p_reconcile jsonb default null)
returns void language plpgsql set search_path = public, pg_temp as $$
declare r record; fails int;
begin
  perform public.portfolio_svc_assert();
  select * into r from public.portfolio_sync_runs where id = p_run for update;
  if not found or r.status <> 'RUNNING' then return; end if;
  update public.portfolio_sync_runs set status = p_status, finished_at = now(),
         duration_ms = least(2147483647, (extract(epoch from (now() - started_at)) * 1000)::bigint)::int,
         error_code = left(p_error_code, 40), error_message = left(p_error_message, 500), reconcile = p_reconcile
   where id = p_run;
  if p_status in ('SUCCEEDED', 'PARTIAL') then
    update public.platform_accounts set status = 'CONNECTED', last_success_at = now(), last_error = null, consecutive_failures = 0,
           sync_cursor = coalesce(left(p_cursor, 2000), sync_cursor), next_sync_at = now() + interval '30 minutes'
     where id = r.platform_account_id and connection_type = 'API';
  elsif p_error_code in ('BAD_CREDENTIAL', 'WRITE_SCOPE', 'SCOPE_UNKNOWN') then
    update public.platform_accounts set status = 'ACTION_REQUIRED', last_error = left(p_error_message, 500), next_sync_at = null
     where id = r.platform_account_id and connection_type = 'API';
  else
    update public.platform_accounts set consecutive_failures = consecutive_failures + 1 where id = r.platform_account_id returning consecutive_failures into fails;
    -- connected only once something has synced: a first sync that failed is still SYNCING
    update public.platform_accounts set status = case when fails >= 5 then 'ERROR' when last_success_at is null then 'SYNCING' else 'CONNECTED' end,
           last_error = left(p_error_message, 500),
           next_sync_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(fails - 1, 10)))
                                 + case when p_error_code = 'RATE_LIMITED' then interval '10 minutes' else interval '0' end
     where id = r.platform_account_id and connection_type = 'API';
  end if;
end $$;

-- The accounts the scheduler should sync now: connected, due, not waiting on
-- the reader, and on a platform that is switched on.
create or replace function public.portfolio_svc_due_accounts(p_limit int default 25)
returns table (account_id uuid, user_id uuid, platform text, ingestion_method text, external_account_id text, sync_cursor text, has_run boolean)
language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query select a.id, a.user_id, a.platform, a.ingestion_method, a.external_account_id, a.sync_cursor,
         exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status in ('SUCCEEDED', 'PARTIAL'))
    from public.platform_accounts a join public.portfolio_platform_registry g on g.platform_key = a.platform and g.automatic_enabled
   where a.connection_type = 'API' and a.status in ('CONNECTED', 'SYNCING', 'ERROR') and coalesce(a.next_sync_at, now()) <= now()
     and not exists (select 1 from public.portfolio_sync_runs r where r.platform_account_id = a.id and r.status = 'RUNNING' and r.started_at > now() - interval '15 minutes')
   order by a.next_sync_at nulls first limit greatest(1, least(p_limit, 200));
end $$;

-- Disconnect: the credential is deleted (not merely flagged), the account
-- reads DISCONNECTED and syncs no more. History stays unless the reader asks
-- for it to go; then the synced positions and their transactions are deleted
-- with the account.
create or replace function public.portfolio_svc_disconnect(p_account uuid, p_delete_history boolean default false)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare cred int; pos int := 0;
begin
  perform public.portfolio_svc_assert();
  delete from portfolio_private.platform_credentials where platform_account_id = p_account;
  get diagnostics cred = row_count;
  if p_delete_history then
    delete from public.portfolio_positions where platform_account_id = p_account and source = 'SYNC';
    get diagnostics pos = row_count;
    delete from public.platform_accounts where id = p_account;
  else
    update public.platform_accounts set status = 'DISCONNECTED', next_sync_at = null, metadata = metadata - 'credential' where id = p_account;
  end if;
  return jsonb_build_object('credential_deleted', cred > 0, 'positions_deleted', pos);
end $$;

-- THE LIVE SMOKE TEST, recorded by tools/portfolio/connector_smoke.js. A
-- stage can pass only after every stage before it has passed; the test can
-- be PASSED only with all ten (the table's own check enforces it again).
create or replace function public.portfolio_svc_smoke_begin(p_platform text, p_run_by text default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare v text; tid uuid;
begin
  perform public.portfolio_svc_assert();
  select connector_version into v from public.portfolio_platform_registry where platform_key = p_platform and automatic_method is not null;
  if v is null then raise exception 'portfolio: % has no automatic connector to test', p_platform using errcode = '22023'; end if;
  insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment, run_by)
  values (p_platform, v, 'PRODUCTION', left(p_run_by, 120)) returning id into tid;
  return tid;
end $$;
create or replace function public.portfolio_svc_smoke_stage(p_test uuid, p_stage text, p_ok boolean, p_detail jsonb default '{}'::jsonb)
returns jsonb language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare t record; idx int; prev text;
begin
  perform public.portfolio_svc_assert();
  select * into t from portfolio_private.connector_smoke_tests where id = p_test for update;
  if not found or t.status <> 'RUNNING' then raise exception 'portfolio: no running smoke test %', p_test using errcode = 'P0002'; end if;
  idx := array_position(public.portfolio_smoke_stages(), p_stage);
  if idx is null then raise exception 'portfolio: unknown stage %', p_stage using errcode = '22023'; end if;
  if p_ok then
    foreach prev in array (public.portfolio_smoke_stages())[1:idx - 1] loop
      if not coalesce((t.stages -> prev ->> 'ok')::boolean, false) then
        raise exception 'portfolio: % cannot pass before % has', p_stage, prev using errcode = '22023';
      end if;
    end loop;
  end if;
  update portfolio_private.connector_smoke_tests set stages = stages || jsonb_build_object(p_stage,
      jsonb_build_object('ok', p_ok, 'at', now(), 'detail', coalesce(p_detail, '{}'::jsonb)))
   where id = p_test;
  return (select stages from portfolio_private.connector_smoke_tests where id = p_test);
end $$;

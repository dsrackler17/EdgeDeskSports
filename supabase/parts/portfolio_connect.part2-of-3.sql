-- portfolio_connect -- part 2 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE SERVICE ENTRY POINTS
-- ─────────────────────────────────────────────────────────────────────────────
-- Connect (or reconnect) an automatic account. A reader's QUICK IMPORT or
-- manual account for the same platform is UPGRADED IN PLACE, so its history
-- stays theirs; a disconnected automatic account is reused, so reconnecting
-- never duplicates. Refused while the registry has the platform switched
-- off, unless the call belongs to a running smoke test of that platform.
create or replace function public.portfolio_svc_account_connect(p_user uuid, p_platform text, p_method text, p_external_account_id text,
    p_display_name text default null, p_smoke_test uuid default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare reg record; acct uuid; ext text := nullif(btrim(p_external_account_id), '');
begin
  perform public.portfolio_svc_assert();
  select * into reg from public.portfolio_platform_registry where platform_key = p_platform;
  if not found or reg.automatic_method is null or reg.automatic_method <> p_method then
    raise exception 'portfolio: % has no % connection', p_platform, p_method using errcode = '22023';
  end if;
  if not reg.automatic_enabled and not exists (select 1 from portfolio_private.connector_smoke_tests t
       where t.id = p_smoke_test and t.platform_key = p_platform and t.status = 'RUNNING' and t.started_at > now() - interval '30 days') then
    raise exception 'portfolio: automatic connection for % is not enabled', p_platform using errcode = '42501';
  end if;
  -- the same automatic account, connected before
  select id into acct from public.platform_accounts
   where user_id = p_user and platform = p_platform and connection_type = 'API' and coalesce(external_account_id, '') = coalesce(ext, '')
   order by created_at limit 1;
  if acct is null then
    -- upgrade QUICK IMPORT / manual in place
    select id into acct from public.platform_accounts
     where user_id = p_user and platform = p_platform and connection_type in ('CSV', 'MANUAL')
       and not exists (select 1 from public.platform_accounts b where b.user_id = p_user and b.platform = p_platform and b.connection_type = 'API')
     order by case connection_type when 'CSV' then 0 else 1 end, created_at limit 1;
  end if;
  if acct is null then
    insert into public.platform_accounts (user_id, platform, platform_label, platform_type, connection_type, ingestion_method, external_account_id,
        display_name, status, next_sync_at)
    values (p_user, p_platform, reg.label, reg.source_type, 'API', p_method, ext, nullif(btrim(p_display_name), ''), 'SYNCING', now())
    returning id into acct;
  else
    update public.platform_accounts set connection_type = 'API', ingestion_method = p_method, external_account_id = ext,
           display_name = coalesce(nullif(btrim(p_display_name), ''), display_name), status = 'SYNCING', last_error = null,
           consecutive_failures = 0, next_sync_at = now()
     where id = acct;
  end if;
  return acct;
end $$;

-- Store the sealed credential (ciphertext and nonce, base64) for an account.
-- The account's metadata carries only what a reader may see about it.
create or replace function public.portfolio_svc_store_credential(p_account uuid, p_kind text, p_ciphertext_b64 text, p_nonce_b64 text,
    p_key_version int, p_key_hint text default null, p_scopes text[] default null)
returns void language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare a record;
begin
  perform public.portfolio_svc_assert();
  select id, user_id into a from public.platform_accounts where id = p_account;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  insert into portfolio_private.platform_credentials (platform_account_id, user_id, credential_kind, ciphertext, nonce, key_version, key_hint, scopes)
  values (a.id, a.user_id, p_kind, decode(p_ciphertext_b64, 'base64'), decode(p_nonce_b64, 'base64'), p_key_version, p_key_hint, p_scopes)
  on conflict (platform_account_id) do update set credential_kind = excluded.credential_kind, ciphertext = excluded.ciphertext, nonce = excluded.nonce,
    key_version = excluded.key_version, key_hint = excluded.key_hint, scopes = excluded.scopes, rotated_at = now(), revoked_at = null, updated_at = now();
  update public.platform_accounts set metadata = (metadata - 'credential') || jsonb_build_object('credential',
      jsonb_build_object('kind', p_kind, 'hint', p_key_hint, 'scopes', to_jsonb(coalesce(p_scopes, '{}'::text[])), 'stored_at', now()))
   where id = a.id;
end $$;

-- The sealed credential, for the sync worker to open in memory.
create or replace function public.portfolio_svc_credential(p_account uuid)
returns table (user_id uuid, credential_kind text, ciphertext_b64 text, nonce_b64 text, key_version int)
language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  update portfolio_private.platform_credentials set last_used_at = now() where platform_account_id = p_account and revoked_at is null;
  return query select c.user_id, c.credential_kind, encode(c.ciphertext, 'base64'), encode(c.nonce, 'base64'), c.key_version
    from portfolio_private.platform_credentials c where c.platform_account_id = p_account and c.revoked_at is null;
end $$;

-- A one-time session for a connect flow; consumed once, within its window.
create or replace function public.portfolio_svc_session_begin(p_user uuid, p_platform text, p_method text, p_state_hash text, p_challenge text default null)
returns uuid language plpgsql set search_path = public, portfolio_private, pg_temp as $$
declare sid uuid;
begin
  perform public.portfolio_svc_assert();
  delete from portfolio_private.connect_sessions where expires_at < now() - interval '1 day';
  insert into portfolio_private.connect_sessions (user_id, platform_key, method, state_hash, challenge, expires_at)
  values (p_user, p_platform, p_method, p_state_hash, p_challenge, now() + interval '15 minutes') returning id into sid;
  return sid;
end $$;
create or replace function public.portfolio_svc_session_consume(p_user uuid, p_state_hash text)
returns table (platform_key text, method text, challenge text)
language plpgsql set search_path = public, portfolio_private, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return query update portfolio_private.connect_sessions s set consumed_at = now()
     where s.state_hash = p_state_hash and s.user_id = p_user and s.consumed_at is null and s.expires_at > now()
    returning s.platform_key, s.method, s.challenge;
end $$;

-- A sync run begins: one at a time per account (a run stuck for 15 minutes
-- is presumed dead and closed as FAILED).
create or replace function public.portfolio_svc_run_begin(p_account uuid, p_kind text)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare a record; rid uuid;
begin
  perform public.portfolio_svc_assert();
  select id, user_id, platform into a from public.platform_accounts where id = p_account for update;
  if not found then raise exception 'portfolio: no such account' using errcode = 'P0002'; end if;
  update public.portfolio_sync_runs set status = 'FAILED', finished_at = now(), error_code = 'TIMEOUT', error_message = 'The sync stopped responding and was closed.'
   where platform_account_id = p_account and status = 'RUNNING' and started_at < now() - interval '15 minutes';
  if exists (select 1 from public.portfolio_sync_runs where platform_account_id = p_account and status = 'RUNNING') then return null; end if;
  insert into public.portfolio_sync_runs (user_id, platform_account_id, platform, kind) values (a.user_id, a.id, a.platform, p_kind) returning id into rid;
  update public.platform_accounts set last_sync_at = now(), status = case when status in ('CONNECTED', 'ERROR') then 'SYNCING' else status end
   where id = p_account and connection_type = 'API';
  return rid;
end $$;

-- What an account holds now, for an incremental replay and reconciliation.
create or replace function public.portfolio_svc_account_positions(p_account uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public.portfolio_svc_assert();
  return (select coalesce(jsonb_agg(jsonb_build_object('external_position_id', p.external_position_id, 'contracts', p.contracts, 'status', p.status,
            'resolution', p.resolution, 'realized_profit_loss', p.realized_profit_loss) order by p.external_position_id), '[]'::jsonb)
    from public.portfolio_positions p where p.platform_account_id = p_account and p.source = 'SYNC' and p.external_position_id is not null);
end $$;

-- THE INGEST. Normalized positions with their fills and fees, upserted by
-- the platform's own ids: running the same payload twice changes nothing.
-- Each position is its own sub-transaction: one that would break a rule
-- (no buy, more sold than bought, an impossible price) is rejected and
-- reported in the run — never silently dropped, never half-written.
create or replace function public.portfolio_svc_ingest(p_account uuid, p_run uuid, p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  a record; p jsonb; f jsonb; pid uuid; was_new boolean; n int;
  pos_ins int := 0; pos_upd int := 0; tx_ins int := 0; tx_same int := 0; v_rejected int := 0;
  v_issues jsonb := coalesce(p_payload->'issues', '[]'::jsonb);
  b numeric; s numeric; first_at timestamptz;
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
    exception when others then
      perform set_config('portfolio.bulk_fills', 'off', true);
      v_rejected := v_rejected + 1;
      if jsonb_array_length(v_issues) < 200 then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object('code', 'REJECTED', 'ref', left(coalesce(p->>'external_position_id', '?'), 120),
          'message', left(regexp_replace(sqlerrm, '^portfolio: ', ''), 300)));
      end if;
    end;
  end loop;
  if p_run is not null then
    update public.portfolio_sync_runs set positions_inserted = positions_inserted + pos_ins, positions_updated = positions_updated + pos_upd,
           transactions_inserted = transactions_inserted + tx_ins, transactions_unchanged = transactions_unchanged + tx_same,
           rejected = portfolio_sync_runs.rejected + v_rejected,
           fetched = fetched + coalesce((p_payload->>'fetched')::int, 0),
           issues = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(portfolio_sync_runs.issues || v_issues) e limit 200) q)
     where id = p_run and platform_account_id = p_account;
  end if;
  return jsonb_build_object('positions_inserted', pos_ins, 'positions_updated', pos_upd, 'transactions_inserted', tx_ins,
    'transactions_unchanged', tx_same, 'rejected', v_rejected, 'issues', v_issues);
end $$;

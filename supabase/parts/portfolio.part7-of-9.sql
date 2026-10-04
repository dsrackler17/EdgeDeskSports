-- portfolio -- part 7 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- Inserts exactly the rows the reader confirmed: NEW rows by default, any
-- other non-INVALID row only on an explicit IMPORT decision. Each call
-- re-classifies what is not yet imported (a stale or edited classification is
-- never trusted) and then imports up to p_max rows, so no single request can
-- outrun the API's statement timeout; the page calls it until "remaining" is
-- 0. A batch goes in with one statement; if any row in it fails, the batch is
-- redone row by row and only the failing rows are recorded as FAILED. A
-- market of fills goes in together and is rebuilt once. Running it again
-- after the import is COMMITTED imports nothing twice.
create or replace function public.portfolio_import_commit(p_import uuid, p_max int default 1000)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  imp public.portfolio_imports;
  acct_platform text;
  lim int := greatest(1, least(coalesce(p_max, 1000), 5000));
  r record; g record; n jsonb; first jsonb;
  v_pos uuid; v_n int; v_done int := 0; v_remaining int;
  v_res text; v_settle numeric; v_mark numeric; v_settled timestamptz; v_payout numeric;
  chk record;
begin
  select * into imp from public.portfolio_imports where id = p_import;
  if not found then raise exception 'portfolio: no such import' using errcode = 'P0002'; end if;
  if imp.status = 'COMMITTED' then
    return jsonb_build_object('status', imp.status, 'remaining', 0, 'total', imp.rows_total, 'new', imp.rows_new, 'duplicate', imp.rows_duplicate,
      'review', imp.rows_review, 'invalid', imp.rows_invalid, 'imported', imp.rows_imported, 'skipped', imp.rows_skipped, 'failed', imp.rows_failed);
  end if;
  perform public.portfolio_import_classify(p_import);
  update public.portfolio_imports set commit_started_at = coalesce(commit_started_at, clock_timestamp()) where id = p_import
  returning * into imp;
  select a.platform into acct_platform from public.platform_accounts a where a.id = imp.platform_account_id;

  /* ── wagers: one statement per batch ── */
  begin
    with batch as (
      select ir.*, row_number() over (partition by ir.fingerprint order by ir.row_number) as rn
        from public.portfolio_import_rows ir
       where ir.import_id = p_import and ir.outcome is null and ir.normalized->>'kind' = 'wager'
         and public.portfolio_import_row_wanted(ir.classification, ir.decision)
       order by ir.row_number limit lim),
    ins as (
      insert into public.portfolio_positions (platform_account_id, platform, platform_label, platform_type, external_position_id,
          position_type, sport, league, event_name, event_id, event_start_at, market_name, selection, side, line,
          odds_american, odds_decimal, stake, reported_payout, fees, status, placed_at, settled_at, source, import_id, notes,
          raw_payload, dedupe_occurrence)
      select case when acct_platform = b.normalized->>'platform' then imp.platform_account_id end, b.normalized->>'platform',
          b.normalized->>'platform_label', 'SPORTSBOOK', nullif(b.normalized->>'external_position_id', ''),
          coalesce(nullif(b.normalized->>'position_type', ''), 'OTHER'), b.normalized->>'sport', b.normalized->>'league',
          b.normalized->>'event_name', b.normalized->>'event_id', (nullif(b.normalized->>'event_start_at', ''))::timestamptz,
          b.normalized->>'market_name', b.normalized->>'selection', b.normalized->>'side', (nullif(b.normalized->>'line', ''))::numeric,
          (nullif(b.normalized->>'odds_american', ''))::numeric::int, (nullif(b.normalized->>'odds_decimal', ''))::numeric,
          (b.normalized->>'stake')::numeric, (nullif(b.normalized->>'reported_payout', ''))::numeric,
          coalesce((nullif(b.normalized->>'fees', ''))::numeric, 0), coalesce(upper(nullif(b.normalized->>'status', '')), 'OPEN'),
          (b.normalized->>'placed_at')::timestamptz, (nullif(b.normalized->>'settled_at', ''))::timestamptz, 'CSV', imp.id,
          b.normalized->>'notes', jsonb_build_object('csv', b.raw, 'import_row', b.id),
          case when nullif(b.normalized->>'external_position_id', '') is not null then 1
               else coalesce((select max(p.dedupe_occurrence) from public.portfolio_positions p
                               where p.user_id = imp.user_id and p.fingerprint = b.fingerprint and p.external_position_id is null), 0) + b.rn::int end
        from batch b
      returning id, (raw_payload->>'import_row')::bigint as row_id)
    update public.portfolio_import_rows ir set outcome = 'IMPORTED', outcome_message = null, position_id = ins.id
      from ins where ir.id = ins.row_id;
    get diagnostics v_n = row_count;
    v_done := v_done + v_n;
  exception when others then
    /* one row refused: redo this batch row by row, and record only the failures */
    for r in select ir.* from public.portfolio_import_rows ir
              where ir.import_id = p_import and ir.outcome is null and ir.normalized->>'kind' = 'wager'
                and public.portfolio_import_row_wanted(ir.classification, ir.decision)
              order by ir.row_number limit lim loop
      begin
        n := r.normalized;
        insert into public.portfolio_positions (platform_account_id, platform, platform_label, platform_type, external_position_id,
            position_type, sport, league, event_name, event_id, event_start_at, market_name, selection, side, line,
            odds_american, odds_decimal, stake, reported_payout, fees, status, placed_at, settled_at, source, import_id, notes,
            raw_payload, dedupe_occurrence)
        values (case when acct_platform = n->>'platform' then imp.platform_account_id end, n->>'platform', n->>'platform_label',
            'SPORTSBOOK', nullif(n->>'external_position_id', ''), coalesce(nullif(n->>'position_type', ''), 'OTHER'),
            n->>'sport', n->>'league', n->>'event_name', n->>'event_id', (nullif(n->>'event_start_at', ''))::timestamptz,
            n->>'market_name', n->>'selection', n->>'side', (nullif(n->>'line', ''))::numeric,
            (nullif(n->>'odds_american', ''))::numeric::int, (nullif(n->>'odds_decimal', ''))::numeric,
            (n->>'stake')::numeric, (nullif(n->>'reported_payout', ''))::numeric, coalesce((nullif(n->>'fees', ''))::numeric, 0),
            coalesce(upper(nullif(n->>'status', '')), 'OPEN'), (n->>'placed_at')::timestamptz,
            (nullif(n->>'settled_at', ''))::timestamptz, 'CSV', imp.id, n->>'notes', jsonb_build_object('csv', r.raw, 'import_row', r.id),
            case when nullif(n->>'external_position_id', '') is not null then 1
                 else 1 + coalesce((select max(p.dedupe_occurrence) from public.portfolio_positions p
                                     where p.user_id = imp.user_id and p.fingerprint = r.fingerprint and p.external_position_id is null), 0) end)
        returning id into v_pos;
        update public.portfolio_import_rows set outcome = 'IMPORTED', outcome_message = null, position_id = v_pos where id = r.id;
      exception when others then
        update public.portfolio_import_rows set outcome = 'FAILED', outcome_message = left(sqlerrm, 300) where id = r.id;
      end;
      v_done := v_done + 1;
    end loop;
  end;

  /* ── fills: one market at a time, rebuilt once ── */
  perform set_config('portfolio.bulk_fills', 'on', true);
  for g in select ir.group_key, min(ir.row_number) as first_row, count(*) as n
             from public.portfolio_import_rows ir
            where ir.import_id = p_import and ir.outcome is null and ir.normalized->>'kind' = 'fill'
              and public.portfolio_import_row_wanted(ir.classification, ir.decision)
            group by ir.group_key order by 2 loop
    exit when v_done >= lim;
    begin
      select ir.normalized into first from public.portfolio_import_rows ir where ir.import_id = p_import and ir.row_number = g.first_row;
      v_pos := null;
      /* a fill this market already holds names its position — only if that
         position IS this market: a platform id reused by another market
         (EXTERNAL_ID_IN_USE) must not pull these fills into it */
      select t.position_id into v_pos from public.portfolio_import_rows ir
        join public.portfolio_transactions t on t.id = ir.duplicate_of
        join public.portfolio_positions p on p.id = t.position_id and p.contract_key = g.group_key
       where ir.import_id = p_import and ir.group_key = g.group_key and ir.duplicate_of is not null limit 1;
      if v_pos is null then
        select p.id into v_pos from public.portfolio_positions p
         where p.user_id = imp.user_id and p.platform_type = 'PREDICTION_MARKET' and p.status = 'OPEN' and p.source <> 'SYNC'
           and p.contract_key = g.group_key
         order by p.placed_at desc limit 1;
      end if;
      if v_pos is null then
        insert into public.portfolio_positions (platform_account_id, platform, platform_label, platform_type, position_type, sport,
            league, event_name, event_id, market_name, selection, side, placed_at, source, import_id, dedupe_occurrence)
        values (case when acct_platform = first->>'platform' then imp.platform_account_id end, first->>'platform',
            first->>'platform_label', 'PREDICTION_MARKET', coalesce(nullif(first->>'position_type', ''), 'EVENT_CONTRACT'),
            first->>'sport', first->>'league', first->>'event_name', first->>'event_id', first->>'market_name',
            coalesce(nullif(first->>'selection', ''), first->>'side'), first->>'side',
            (select min((ir.normalized->>'executed_at')::timestamptz) from public.portfolio_import_rows ir
              where ir.import_id = p_import and ir.group_key = g.group_key and ir.outcome is null
                and public.portfolio_import_row_wanted(ir.classification, ir.decision)),
            'CSV', imp.id,
            1 + coalesce((select max(p.dedupe_occurrence) from public.portfolio_positions p
                           where p.user_id = imp.user_id and p.contract_key = g.group_key), 0))
        returning id into v_pos;
      end if;
      with batch as (
        select ir.*, row_number() over (partition by ir.fingerprint order by ir.row_number) as rn
          from public.portfolio_import_rows ir
         where ir.import_id = p_import and ir.group_key = g.group_key and ir.outcome is null and ir.normalized->>'kind' = 'fill'
           and public.portfolio_import_row_wanted(ir.classification, ir.decision)),
      ins as (
        insert into public.portfolio_transactions (position_id, external_transaction_id, transaction_type, quantity, price, fee,
            executed_at, source, import_id, raw_payload, dedupe_occurrence)
        select v_pos, nullif(b.normalized->>'external_transaction_id', ''), upper(b.normalized->>'action'), (b.normalized->>'quantity')::numeric,
            (b.normalized->>'price')::numeric, coalesce((nullif(b.normalized->>'fee', ''))::numeric, 0), (b.normalized->>'executed_at')::timestamptz,
            'CSV', imp.id, jsonb_build_object('csv', b.raw, 'import_row', b.id),
            case when nullif(b.normalized->>'external_transaction_id', '') is not null then 1
                 else coalesce((select max(t.dedupe_occurrence) from public.portfolio_transactions t
                                 where t.user_id = imp.user_id and t.fingerprint = b.fingerprint and t.external_transaction_id is null), 0) + b.rn::int end
          from batch b
         order by (b.normalized->>'executed_at')::timestamptz, (upper(b.normalized->>'action') = 'SELL'), b.row_number
        returning id, (raw_payload->>'import_row')::bigint as row_id)
      update public.portfolio_import_rows ir set outcome = 'IMPORTED', outcome_message = null, position_id = v_pos, transaction_id = ins.id
        from ins where ir.id = ins.row_id;
      /* what the file says about the market as a whole: the last value given wins */
      select (array_agg(nullif(ir.normalized->>'resolution', '') order by ir.row_number desc) filter (where nullif(ir.normalized->>'resolution', '') is not null))[1],
             (array_agg(public.portfolio_try_numeric(ir.normalized->>'settlement_price') order by ir.row_number desc) filter (where public.portfolio_try_numeric(ir.normalized->>'settlement_price') is not null))[1],
             (array_agg(public.portfolio_try_numeric(ir.normalized->>'current_price') order by ir.row_number desc) filter (where public.portfolio_try_numeric(ir.normalized->>'current_price') is not null))[1],
             (array_agg(public.portfolio_try_timestamptz(ir.normalized->>'settled_at') order by ir.row_number desc) filter (where public.portfolio_try_timestamptz(ir.normalized->>'settled_at') is not null))[1],
             (array_agg(public.portfolio_try_numeric(ir.normalized->>'reported_payout') order by ir.row_number desc) filter (where public.portfolio_try_numeric(ir.normalized->>'reported_payout') is not null))[1]
        into v_res, v_settle, v_mark, v_settled, v_payout
        from public.portfolio_import_rows ir
       where ir.import_id = p_import and ir.group_key = g.group_key and ir.transaction_id is not null;
      /* the one rebuild of this position */
      update public.portfolio_positions
         set resolution = coalesce(v_res, resolution), settlement_price = coalesce(v_settle, settlement_price),
             current_price = coalesce(v_mark, current_price), reported_payout = coalesce(v_payout, reported_payout),
             settled_at = case when v_res is not null then coalesce(v_settled, settled_at) else settled_at end, updated_at = now()
       where id = v_pos;
      /* the commit-time rule, checked now so one bad market cannot sink the rest */
      select contracts_bought, contracts into chk from public.portfolio_positions where id = v_pos;
      if coalesce(chk.contracts_bought, 0) <= 0 or chk.contracts < 0 then
        raise exception 'portfolio: more contracts sold than bought in this market' using errcode = '23514';
      end if;
    exception when others then
      update public.portfolio_import_rows ir set outcome = 'FAILED', outcome_message = left(sqlerrm, 300), position_id = null, transaction_id = null
       where ir.import_id = p_import and ir.group_key = g.group_key and ir.outcome is null
         and public.portfolio_import_row_wanted(ir.classification, ir.decision);
    end;
    v_done := v_done + g.n::int;
  end loop;
  perform set_config('portfolio.bulk_fills', 'off', true);

  select count(*) into v_remaining from public.portfolio_import_rows ir
   where ir.import_id = p_import and ir.outcome is null and public.portfolio_import_row_wanted(ir.classification, ir.decision);
  if v_remaining > 0 then
    return jsonb_build_object('status', 'IMPORTING', 'remaining', v_remaining,
      'imported', (select count(*) from public.portfolio_import_rows where import_id = p_import and outcome = 'IMPORTED'));
  end if;

  /* everything wanted is in: the rest was not wanted */
  update public.portfolio_import_rows set outcome = 'SKIPPED', outcome_message = null where import_id = p_import and outcome is null;
  update public.portfolio_imports i set status = 'COMMITTED', committed_at = now(),
         rows_imported = c.n_ok, rows_skipped = c.n_skip, rows_failed = c.n_fail
    from (select count(*) filter (where outcome = 'IMPORTED') as n_ok, count(*) filter (where outcome = 'SKIPPED') as n_skip,
                 count(*) filter (where outcome = 'FAILED') as n_fail
            from public.portfolio_import_rows where import_id = p_import) c
   where i.id = p_import
  returning i.* into imp;
  insert into public.portfolio_sync_logs (user_id, platform_account_id, platform, sync_kind, import_id, status, started_at, completed_at,
      records_fetched, records_inserted, records_updated, duplicates_ignored, errors_count, error_code)
  values (imp.user_id, imp.platform_account_id, imp.platform, 'CSV_IMPORT', imp.id,
      case when imp.rows_failed = 0 then 'SUCCESS' when imp.rows_imported > 0 then 'PARTIAL' else 'FAILED' end,
      coalesce(imp.commit_started_at, clock_timestamp()), clock_timestamp(), imp.rows_total, imp.rows_imported, 0,
      (select count(*) from public.portfolio_import_rows where import_id = p_import and outcome = 'SKIPPED'
          and classification in ('DUPLICATE', 'DUPLICATE_IN_FILE')),
      imp.rows_failed, case when imp.rows_failed > 0 then 'ROWS_FAILED' end);
  return jsonb_build_object('status', imp.status, 'remaining', 0, 'total', imp.rows_total, 'new', imp.rows_new, 'duplicate', imp.rows_duplicate,
    'review', imp.rows_review, 'invalid', imp.rows_invalid, 'imported', imp.rows_imported, 'skipped', imp.rows_skipped,
    'failed', imp.rows_failed);
end $$;

-- portfolio -- part 4 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function public.portfolio_positions_derive() returns trigger
language plpgsql as $$
declare
  reader boolean := auth.uid() is not null;
  acct record;
  b numeric; bc numeric; s numeric; sp numeric; f numeric; held numeric;
  first_buy timestamptz; last_sell timestamptz; settle numeric; settle_amt numeric;
begin
  -- ── ownership and frozen fields ──
  if tg_op = 'INSERT' then
    if reader then new.user_id := auth.uid(); end if;
    new.created_at := now();
    if reader and new.source = 'SYNC' then
      raise exception 'portfolio: only a connector can record a synced position' using errcode = '42501';
    end if;
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.source := old.source; new.platform_type := old.platform_type;
    /* the import that created a position is fixed for life, except that
       deleting the import itself clears the link (its ON DELETE SET NULL);
       restoring it there would leave the position naming an import that no
       longer exists */
    if not public.portfolio_link_released(old.import_id, new.import_id, 'import') then new.import_id := old.import_id; end if;
    if reader then
      new.external_position_id := old.external_position_id; new.raw_payload := old.raw_payload;
      /* a synced position is the platform's record: the reader keeps notes,
         attribution and the labels the platform left blank, nothing else */
      if old.source = 'SYNC' and ((new.platform, new.event_name, new.market_name, new.selection, new.side, new.line, new.odds_american,
          new.odds_decimal, new.stake, new.reported_payout, new.fees, new.status, new.placed_at, new.settled_at, new.resolution,
          new.settlement_price, new.current_price, new.position_type, new.legs, new.event_id, new.dedupe_occurrence)
         is distinct from (old.platform, old.event_name, old.market_name, old.selection, old.side, old.line, old.odds_american,
          old.odds_decimal, old.stake, old.reported_payout, old.fees, old.status, old.placed_at, old.settled_at, old.resolution,
          old.settlement_price, old.current_price, old.position_type, old.legs, old.event_id, old.dedupe_occurrence)
         or (new.platform_account_id is distinct from old.platform_account_id
             and not public.portfolio_link_released(old.platform_account_id, new.platform_account_id, 'account'))
         or (old.sport is not null and new.sport is distinct from old.sport)
         or (old.league is not null and new.league is distinct from old.league)
         or (old.event_start_at is not null and new.event_start_at is distinct from old.event_start_at)) then
        raise exception 'portfolio: a synced position is read-only except its notes and attribution' using errcode = '42501';
      end if;
    end if;
  end if;
  new.updated_at := now();
  new.calc_version := 'portfolio_calc_v1';

  -- ── tidy the inputs ──
  new.platform := lower(btrim(new.platform));
  new.platform_label := btrim(new.platform_label);
  new.platform_type := upper(btrim(new.platform_type));
  new.position_type := upper(btrim(new.position_type));
  new.status := upper(btrim(new.status));
  new.event_name := btrim(new.event_name); new.market_name := btrim(new.market_name); new.selection := btrim(new.selection);
  new.side := nullif(btrim(new.side), '');
  new.resolution := nullif(btrim(new.resolution), '');
  if upper(new.side) in ('YES', 'NO') then new.side := upper(new.side); end if;
  if upper(new.resolution) in ('YES', 'NO', 'VOID') then new.resolution := upper(new.resolution); end if;
  new.sport := nullif(btrim(new.sport), ''); new.league := nullif(btrim(new.league), '');
  if tg_op = 'INSERT' or new.current_price is distinct from old.current_price then
    new.current_price_at := case when new.current_price is null then null else now() end;
  end if;

  -- ── the account it belongs to: the reader's own, found or opened when the
  -- position arrives or moves platform. An account removed later leaves its
  -- positions unlinked in the history; it is not silently re-opened. ──
  if tg_op = 'UPDATE' and new.platform <> old.platform and new.platform_account_id is not distinct from old.platform_account_id then
    new.platform_account_id := null;
  end if;
  if new.platform_account_id is null and (tg_op = 'INSERT' or new.platform <> old.platform) then
    select a.id into new.platform_account_id from public.platform_accounts a
     where a.user_id = new.user_id and a.platform = new.platform and a.platform_type = new.platform_type
     order by (a.connection_type = case when new.source = 'CSV' then 'CSV' else 'MANUAL' end) desc, a.created_at
     limit 1;
    if new.platform_account_id is null and new.source <> 'SYNC' then
      insert into public.platform_accounts (user_id, platform, platform_label, platform_type, connection_type, status)
      values (new.user_id, new.platform, new.platform_label, new.platform_type,
              case when new.source = 'CSV' then 'CSV' else 'MANUAL' end,
              case when new.source = 'CSV' then 'IMPORT_ONLY' else 'MANUAL' end)
      on conflict do nothing
      returning id into new.platform_account_id;
      if new.platform_account_id is null then
        select a.id into new.platform_account_id from public.platform_accounts a
         where a.user_id = new.user_id and a.platform = new.platform and a.platform_type = new.platform_type
         order by a.created_at limit 1;
      end if;
    end if;
  elsif new.platform_account_id is not null then
    select a.platform, a.platform_type into acct from public.platform_accounts a
     where a.id = new.platform_account_id and a.user_id = new.user_id;
    if found and (acct.platform <> new.platform or acct.platform_type <> new.platform_type) then
      raise exception 'portfolio: this position''s platform does not match the account it names' using errcode = '23514';
    end if;
  end if;

  -- ── attribution: explicit, and only to the reader's own EdgeDesk record ──
  if new.edge_ref_type is not null and (tg_op = 'INSERT' or (new.edge_ref_type, new.edge_ref_id) is distinct from (old.edge_ref_type, old.edge_ref_id)) then
    if not public.portfolio_edge_ref_owned(new.user_id, new.edge_ref_type, new.edge_ref_id) then
      raise exception 'portfolio: that EdgeDesk record does not exist or is not yours' using errcode = '23503';
    end if;
  end if;

  if new.platform_type = 'SPORTSBOOK' then
    -- ── a wager: stake × price, settled by status ──
    new.contracts := null; new.contracts_bought := null; new.contracts_sold := null; new.average_entry_price := null;
    new.average_exit_price := null; new.sell_proceeds := null; new.current_price := null; new.current_price_at := null;
    new.current_value := null; new.unrealized_profit_loss := null; new.resolution := null; new.settlement_price := null;
    if new.odds_american is not null then
      new.odds_decimal := public.portfolio_american_to_decimal(new.odds_american);
    end if;
    new.potential_profit := public.portfolio_wager_profit(new.stake, new.odds_american, new.odds_decimal);
    /* a bonus bet risks no cash and pays only its winnings */
    new.potential_payout := case when new.stake_type = 'BONUS' then new.potential_profit else trim_scale(new.stake + new.potential_profit) end;
    new.cost_basis := case when new.stake_type = 'BONUS' then 0 else new.stake end;
    if new.status = 'OPEN' then
      new.open_cost_basis := new.cost_basis; new.gross_payout := null; new.profit_loss := null; new.realized_profit_loss := null;
      new.result := null; new.settled_at := null;
    else
      new.gross_payout := case new.status
        when 'WON' then coalesce(new.reported_payout, new.potential_payout)
        when 'LOST' then coalesce(new.reported_payout, 0)
        when 'PUSH' then coalesce(new.reported_payout, new.cost_basis)
        when 'VOID' then coalesce(new.reported_payout, new.cost_basis)
        else new.reported_payout end;
      new.gross_payout := trim_scale(new.gross_payout);
      new.profit_loss := trim_scale(new.gross_payout - new.cost_basis - new.fees);
      new.realized_profit_loss := new.profit_loss;
      new.open_cost_basis := 0;
      new.result := case new.status when 'WON' then 'WIN' when 'LOST' then 'LOSS' when 'PUSH' then 'PUSH' when 'VOID' then 'VOID'
        when 'CASHED_OUT' then 'CASHOUT'
        else case when new.profit_loss > 0 then 'WIN' when new.profit_loss < 0 then 'LOSS' else 'PUSH' end end;
      new.settled_at := greatest(coalesce(new.settled_at, now()), new.placed_at);
    end if;
  else
    -- ── a contract position: rebuilt from its fills, average-cost method ──
    new.odds_american := null; new.odds_decimal := null; new.stake := null; new.stake_type := 'CASH';
    select coalesce(sum(t.quantity) filter (where t.transaction_type = 'BUY' or (t.transaction_type = 'FILL' and t.side = 'BUY')), 0),
           coalesce(sum(t.amount)   filter (where t.transaction_type = 'BUY' or (t.transaction_type = 'FILL' and t.side = 'BUY')), 0),
           coalesce(sum(t.quantity) filter (where t.transaction_type = 'SELL' or (t.transaction_type = 'FILL' and t.side = 'SELL')), 0),
           coalesce(sum(t.amount)   filter (where t.transaction_type = 'SELL' or (t.transaction_type = 'FILL' and t.side = 'SELL')), 0),
           coalesce(sum(t.fee), 0),
           min(t.executed_at) filter (where t.transaction_type = 'BUY' or (t.transaction_type = 'FILL' and t.side = 'BUY')),
           max(t.executed_at) filter (where t.transaction_type = 'SELL' or (t.transaction_type = 'FILL' and t.side = 'SELL'))
      into b, bc, s, sp, f, first_buy, last_sell
      from public.portfolio_transactions t
     where t.position_id = new.id and t.user_id = new.user_id;
    held := b - s;
    new.contracts_bought := trim_scale(b); new.contracts_sold := trim_scale(s); new.contracts := trim_scale(held);
    new.sell_proceeds := trim_scale(sp); new.fees := trim_scale(f); new.cost_basis := trim_scale(bc);
    new.average_entry_price := case when b > 0 then public.portfolio_div_round(bc, b, 6) end;
    new.average_exit_price := case when s > 0 then public.portfolio_div_round(sp, s, 6) end;
    new.open_cost_basis := case when b > 0 then public.portfolio_div_round(held * bc, b, 6) else 0 end;
    new.placed_at := coalesce(first_buy, new.placed_at);

    new.status := case when upper(new.resolution) = 'VOID' then 'VOID'
                       when new.resolution is not null then 'SETTLED'
                       when b > 0 and held <= 0 then 'SETTLED'
                       else 'OPEN' end;
    if new.status = 'OPEN' then
      new.realized_profit_loss := trim_scale(sp - (bc - new.open_cost_basis) - f);
      new.current_value := case when new.current_price is not null then trim_scale(held * new.current_price) end;
      new.unrealized_profit_loss := trim_scale(new.current_value - new.open_cost_basis);
      new.potential_payout := trim_scale(held);
      new.potential_profit := trim_scale(held - new.open_cost_basis);
      new.gross_payout := null; new.profit_loss := null; new.result := null; new.settled_at := null;
    else
      settle := coalesce(new.settlement_price,
                         case when new.status = 'VOID' then null
                              when upper(new.resolution) = upper(coalesce(new.side, '')) then 1
                              when new.resolution is not null then 0 end);
      settle_amt := coalesce(new.reported_payout,
                             case when held <= 0 then 0
                                  when settle is not null then held * settle
                                  else new.open_cost_basis end);  -- a void with no price refunds at cost
      new.gross_payout := trim_scale(sp + settle_amt);
      new.profit_loss := trim_scale(new.gross_payout - bc - f);
      new.realized_profit_loss := new.profit_loss;
      new.open_cost_basis := 0; new.current_value := null; new.unrealized_profit_loss := null;
      new.potential_payout := null; new.potential_profit := null;
      new.result := case when new.status = 'VOID' then 'VOID'
                         when new.profit_loss > 0 then 'WIN' when new.profit_loss < 0 then 'LOSS' else 'PUSH' end;
      new.settled_at := greatest(coalesce(new.settled_at, case when new.resolution is null then last_sell end, now()), new.placed_at);
    end if;
  end if;

  -- ── identity ──
  new.fingerprint := case when new.platform_type = 'SPORTSBOOK'
    then public.portfolio_sha256(public.portfolio_fp_wager_material(new.platform, new.event_name, new.market_name, new.selection,
           new.line, new.odds_american, case when new.odds_american is null then new.odds_decimal end, new.stake, new.placed_at))
    else public.portfolio_sha256(public.portfolio_fp_contract_material(new.platform, new.event_name, new.market_name, new.side, new.placed_at)) end;
  /* one market and one side: where an imported or synced fill finds its position */
  new.contract_key := case when new.platform_type = 'PREDICTION_MARKET'
    then public.portfolio_contract_key(new.platform, new.event_name, new.market_name, new.side) end;

  if tg_op = 'INSERT' and new.placed_at > now() + interval '1 day' then
    raise exception 'portfolio: a position cannot be placed in the future' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists portfolio_positions_derive_trg on public.portfolio_positions;
create trigger portfolio_positions_derive_trg before insert or update on public.portfolio_positions
  for each row execute function public.portfolio_positions_derive();

-- Checked at COMMIT, so a position and its first fill can arrive in one
-- transaction in either order: a contract position has at least one buy and
-- never more contracts sold than bought.
create or replace function public.portfolio_positions_check_fills() returns trigger
language plpgsql as $$
declare b numeric; s numeric;
begin
  if new.platform_type <> 'PREDICTION_MARKET' then return null; end if;
  if not exists (select 1 from public.portfolio_positions where id = new.id) then return null; end if;
  select coalesce(sum(quantity) filter (where transaction_type = 'BUY' or (transaction_type = 'FILL' and side = 'BUY')), 0),
         coalesce(sum(quantity) filter (where transaction_type = 'SELL' or (transaction_type = 'FILL' and side = 'SELL')), 0)
    into b, s from public.portfolio_transactions where position_id = new.id;
  if b <= 0 then
    raise exception 'portfolio: a prediction-market position needs at least one buy' using errcode = '23514';
  end if;
  if s > b then
    raise exception 'portfolio: more contracts sold than bought' using errcode = '23514';
  end if;
  return null;
end $$;
drop trigger if exists portfolio_positions_fills_trg on public.portfolio_positions;
create constraint trigger portfolio_positions_fills_trg after insert or update on public.portfolio_positions
  deferrable initially deferred for each row execute function public.portfolio_positions_check_fills();

-- a renamed market re-fingerprints its fills
create or replace function public.portfolio_positions_after_update() returns trigger
language plpgsql as $$
begin
  if new.platform_type = 'PREDICTION_MARKET'
     and (new.platform, new.event_name, new.market_name, new.side) is distinct from (old.platform, old.event_name, old.market_name, old.side) then
    update public.portfolio_transactions set updated_at = now() where position_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists portfolio_positions_after_update_trg on public.portfolio_positions;
create trigger portfolio_positions_after_update_trg after update on public.portfolio_positions
  for each row execute function public.portfolio_positions_after_update();

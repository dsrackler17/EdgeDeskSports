-- portfolio -- part 4 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

create or replace function public.portfolio_transactions_prepare() returns trigger
language plpgsql as $$
declare
  reader boolean := auth.uid() is not null;
  pos record;
  action text;
  old_account uuid := case when tg_op = 'UPDATE' then old.platform_account_id end;
begin
  if tg_op = 'INSERT' then
    if reader then new.user_id := auth.uid(); end if;
    new.created_at := now();
    if reader and new.source = 'SYNC' then
      raise exception 'portfolio: only a connector can record a synced transaction' using errcode = '42501';
    end if;
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at; new.source := old.source;
    new.position_id := old.position_id;
    if not public.portfolio_link_released(old.import_id, new.import_id, 'import') then new.import_id := old.import_id; end if;
    if reader then
      new.external_transaction_id := old.external_transaction_id; new.raw_payload := old.raw_payload;
      if old.source = 'SYNC' and ((new.quantity, new.price, new.fee, new.executed_at, new.transaction_type, new.side, new.amount, new.dedupe_occurrence)
           is distinct from (old.quantity, old.price, old.fee, old.executed_at, old.transaction_type, old.side, old.amount, old.dedupe_occurrence)
         or (new.platform_account_id is distinct from old.platform_account_id
             and not public.portfolio_link_released(old.platform_account_id, new.platform_account_id, 'account'))) then
        raise exception 'portfolio: a synced transaction is read-only' using errcode = '42501';
      end if;
    end if;
  end if;
  new.updated_at := now();
  new.transaction_type := upper(btrim(new.transaction_type));
  new.side := upper(nullif(btrim(new.side), ''));
  if new.transaction_type in ('BUY', 'SELL') then new.side := new.transaction_type; end if;

  if new.position_id is null and new.transaction_type in ('BUY', 'SELL', 'FILL') then
    raise exception 'portfolio: a buy or sell belongs to a position' using errcode = '23502';
  end if;
  if new.position_id is not null then
    select p.platform, p.platform_type, p.event_name, p.market_name, p.side, p.source, p.platform_account_id into pos
      from public.portfolio_positions p where p.id = new.position_id and p.user_id = new.user_id;
    if not found then
      raise exception 'portfolio: no such position' using errcode = '23503';
    end if;
    if reader and pos.source = 'SYNC' and tg_op = 'INSERT' then
      raise exception 'portfolio: a synced position takes its transactions from its connector' using errcode = '42501';
    end if;
    if new.transaction_type in ('BUY', 'SELL', 'FILL') and pos.platform_type <> 'PREDICTION_MARKET' then
      raise exception 'portfolio: buys and sells belong to prediction-market positions' using errcode = '23514';
    end if;
    new.platform := pos.platform;
    /* the position's account, if it still exists: while an account is being
       deleted its rows are unlinked one table at a time, and a fill must not
       be re-pointed at the account that is going away */
    if new.platform_account_id is null and not public.portfolio_link_released(old_account, null, 'account') then
      select a.id into new.platform_account_id from public.platform_accounts a
       where a.id = pos.platform_account_id and a.user_id = new.user_id;
    end if;
  end if;
  new.platform := lower(btrim(new.platform));

  if new.transaction_type in ('BUY', 'SELL', 'FILL') then
    new.amount := trim_scale(new.quantity * new.price);
    action := coalesce(new.side, new.transaction_type);
    new.fingerprint := public.portfolio_sha256(public.portfolio_fp_fill_material(new.platform, pos.event_name, pos.market_name, pos.side,
                         action, new.quantity, new.price, new.executed_at));
  else
    new.fingerprint := public.portfolio_sha256(concat_ws('|', 'pf1', 'cash', new.platform, new.transaction_type,
                         coalesce(new.position_id::text, ''), public.portfolio_num_text(new.amount), public.portfolio_minute_utc(new.executed_at)));
  end if;
  return new;
end $$;
drop trigger if exists portfolio_transactions_prepare_trg on public.portfolio_transactions;
create trigger portfolio_transactions_prepare_trg before insert or update on public.portfolio_transactions
  for each row execute function public.portfolio_transactions_prepare();

-- every change to a fill rebuilds the position it belongs to
create or replace function public.portfolio_transactions_rollup() returns trigger
language plpgsql as $$
begin
  /* an import inserting a market's fills together rebuilds that position
     once, itself, after the last fill (portfolio_import_commit) */
  if current_setting('portfolio.bulk_fills', true) = 'on' then return null; end if;
  if tg_op in ('UPDATE', 'DELETE') and old.position_id is not null then
    update public.portfolio_positions set updated_at = now() where id = old.position_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.position_id is not null
     and (tg_op = 'INSERT' or new.position_id is distinct from old.position_id) then
    update public.portfolio_positions set updated_at = now() where id = new.position_id;
  end if;
  return null;
end $$;
drop trigger if exists portfolio_transactions_rollup_trg on public.portfolio_transactions;
create trigger portfolio_transactions_rollup_trg after insert or update or delete on public.portfolio_transactions
  for each row execute function public.portfolio_transactions_rollup();

-- A prediction-market position and its fills, in one transaction. Runs as
-- the caller: every row is the caller's, under row level security.
create or replace function public.portfolio_record_prediction(p jsonb)
returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_pos uuid; f jsonb; v_first timestamptz; v_src text := coalesce(nullif(p->>'source', ''), 'MANUAL');
begin
  if jsonb_typeof(p->'fills') is distinct from 'array' or jsonb_array_length(p->'fills') = 0 or jsonb_array_length(p->'fills') > 500 then
    raise exception 'portfolio: a prediction-market position needs between 1 and 500 fills' using errcode = '22023';
  end if;
  select min((x->>'executed_at')::timestamptz) into v_first from jsonb_array_elements(p->'fills') x;
  insert into public.portfolio_positions (platform_account_id, platform, platform_label, platform_type, position_type, sport, league,
      event_name, event_id, event_start_at, market_name, selection, side, current_price, resolution, settlement_price, reported_payout,
      settled_at, placed_at, source, notes, edge_source, edge_ref_type, edge_ref_id, model_version, model_probability,
      model_fair_line, market_line_at_research, market_line_at_entry, edge_at_entry, clv, confidence_tier, dedupe_occurrence)
  values ((p->>'platform_account_id')::uuid, p->>'platform', p->>'platform_label', 'PREDICTION_MARKET',
      coalesce(nullif(p->>'position_type', ''), 'EVENT_CONTRACT'), p->>'sport', p->>'league', p->>'event_name', p->>'event_id',
      (p->>'event_start_at')::timestamptz, p->>'market_name', coalesce(nullif(p->>'selection', ''), p->>'side'), p->>'side',
      (p->>'current_price')::numeric, p->>'resolution', (p->>'settlement_price')::numeric, (p->>'reported_payout')::numeric,
      (p->>'settled_at')::timestamptz, v_first, v_src, p->>'notes', p->>'edge_source', p->>'edge_ref_type', p->>'edge_ref_id',
      p->>'model_version', (p->>'model_probability')::numeric, (p->>'model_fair_line')::numeric,
      (p->>'market_line_at_research')::numeric, (p->>'market_line_at_entry')::numeric, (p->>'edge_at_entry')::numeric,
      (p->>'clv')::numeric, p->>'confidence_tier', coalesce((p->>'dedupe_occurrence')::int, 1))
  returning id into v_pos;
  for f in select x from jsonb_array_elements(p->'fills') x
            order by (x->>'executed_at')::timestamptz, (upper(x->>'action') = 'SELL') loop
    insert into public.portfolio_transactions (position_id, transaction_type, quantity, price, fee, executed_at, source, notes)
    values (v_pos, upper(f->>'action'), (f->>'quantity')::numeric, (f->>'price')::numeric,
            coalesce((f->>'fee')::numeric, 0), (f->>'executed_at')::timestamptz, v_src, f->>'notes');
  end loop;
  return v_pos;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. IMPORT ROWS — staged, classified on the server, committed on confirm
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_import_rows (
  id              bigint      generated always as identity primary key,
  import_id       uuid        not null,
  user_id         uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  row_number      int         not null,
  raw             jsonb       not null default '{}'::jsonb,
  normalized      jsonb       null,
  issues          jsonb       not null default '[]'::jsonb,
  group_key       text        null,
  fingerprint     text        null,
  classification  text        not null default 'PENDING',
  duplicate_of    uuid        null,
  decision        text        null,
  outcome         text        null,
  outcome_message text        null,
  position_id     uuid        null,
  transaction_id  uuid        null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint portfolio_import_rows_import_fk foreign key (import_id, user_id)
    references public.portfolio_imports (id, user_id) on delete cascade,
  constraint portfolio_import_rows_once unique (import_id, row_number),
  constraint portfolio_import_rows_number check (row_number between 1 and 20000),
  constraint portfolio_import_rows_class check (classification in ('PENDING', 'NEW', 'DUPLICATE', 'DUPLICATE_IN_FILE', 'NEEDS_REVIEW', 'INVALID')),
  constraint portfolio_import_rows_decision check (decision is null or decision in ('IMPORT', 'SKIP')),
  constraint portfolio_import_rows_outcome check (outcome is null or outcome in ('IMPORTED', 'SKIPPED', 'FAILED')),
  constraint portfolio_import_rows_json check (jsonb_typeof(raw) = 'object' and pg_column_size(raw) <= 16384
    and (normalized is null or (jsonb_typeof(normalized) = 'object' and pg_column_size(normalized) <= 16384))
    and jsonb_typeof(issues) = 'array' and coalesce(length(outcome_message), 0) <= 300)
);
create index if not exists portfolio_import_rows_user on public.portfolio_import_rows (user_id);
create index if not exists portfolio_import_rows_group on public.portfolio_import_rows (import_id, group_key) where group_key is not null;

create or replace function public.portfolio_import_rows_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); end if;
    new.classification := 'PENDING'; new.outcome := null; new.position_id := null; new.transaction_id := null;
  else
    new.id := old.id; new.user_id := old.user_id; new.import_id := old.import_id; new.row_number := old.row_number; new.raw := old.raw;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_import_rows_guard_trg on public.portfolio_import_rows;
create trigger portfolio_import_rows_guard_trg before insert or update on public.portfolio_import_rows
  for each row execute function public.portfolio_import_rows_guard();

-- A committed or cancelled import's rows no longer change. Checked once per
-- statement over the rows it touched, so classifying or committing 5,000 rows
-- costs one lookup, not 5,000.
create or replace function public.portfolio_import_rows_frozen() returns trigger
language plpgsql as $$
declare st text;
begin
  select i.status into st from changed c join public.portfolio_imports i on i.id = c.import_id and i.user_id = c.user_id
   where i.status in ('COMMITTED', 'CANCELLED') limit 1;
  if st is not null then
    raise exception 'portfolio: this import is % and can no longer change', lower(st) using errcode = '55000';
  end if;
  return null;
end $$;
drop trigger if exists portfolio_import_rows_frozen_ins_trg on public.portfolio_import_rows;
create trigger portfolio_import_rows_frozen_ins_trg after insert on public.portfolio_import_rows
  referencing new table as changed for each statement execute function public.portfolio_import_rows_frozen();
drop trigger if exists portfolio_import_rows_frozen_upd_trg on public.portfolio_import_rows;
create trigger portfolio_import_rows_frozen_upd_trg after update on public.portfolio_import_rows
  referencing new table as changed for each statement execute function public.portfolio_import_rows_frozen();

-- The server's own checks on a staged row. The browser's checks are advisory;
-- these decide whether a row can be imported at all.
create or replace function public.portfolio_import_validate(n jsonb)
returns jsonb language plpgsql stable as $$
declare out jsonb := '[]'::jsonb; k text;
begin
  if n is null or jsonb_typeof(n) <> 'object' then
    return jsonb_build_array(jsonb_build_object('level', 'error', 'code', 'NOT_NORMALIZED'));
  end if;
  foreach k in array array['platform', 'platform_label', 'event_name', 'market_name'] loop
    if coalesce(btrim(n->>k), '') = '' then out := out || jsonb_build_object('level', 'error', 'code', 'MISSING_' || upper(k)); end if;
  end loop;
  if coalesce(n->>'platform', '') !~ '^[a-z0-9][a-z0-9_]{1,47}$' then
    out := out || jsonb_build_object('level', 'error', 'code', 'BAD_PLATFORM');
  end if;
  if n->>'kind' = 'wager' then
    if coalesce(btrim(n->>'selection'), '') = '' then out := out || jsonb_build_object('level', 'error', 'code', 'MISSING_SELECTION'); end if;
    if public.portfolio_try_numeric(n->>'stake') is null then out := out || jsonb_build_object('level', 'error', 'code', 'BAD_STAKE'); end if;
    if public.portfolio_try_numeric(n->>'odds_american') is null and public.portfolio_try_numeric(n->>'odds_decimal') is null then
      out := out || jsonb_build_object('level', 'error', 'code', 'BAD_ODDS');
    end if;
    if public.portfolio_try_timestamptz(n->>'placed_at') is null then out := out || jsonb_build_object('level', 'error', 'code', 'BAD_PLACED_AT'); end if;
    if coalesce(upper(n->>'status'), 'OPEN') not in ('OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED') then
      out := out || jsonb_build_object('level', 'error', 'code', 'BAD_STATUS');
    end if;
  elsif n->>'kind' = 'fill' then
    if coalesce(btrim(n->>'side'), '') = '' then out := out || jsonb_build_object('level', 'error', 'code', 'MISSING_SIDE'); end if;
    if coalesce(upper(n->>'action'), '') not in ('BUY', 'SELL') then out := out || jsonb_build_object('level', 'error', 'code', 'BAD_ACTION'); end if;
    if coalesce(public.portfolio_try_numeric(n->>'quantity'), 0) <= 0 then out := out || jsonb_build_object('level', 'error', 'code', 'BAD_QUANTITY'); end if;
    if public.portfolio_try_numeric(n->>'price') is null or public.portfolio_try_numeric(n->>'price') not between 0 and 1 then
      out := out || jsonb_build_object('level', 'error', 'code', 'BAD_PRICE');
    end if;
    if public.portfolio_try_timestamptz(n->>'executed_at') is null then out := out || jsonb_build_object('level', 'error', 'code', 'BAD_EXECUTED_AT'); end if;
  else
    out := out || jsonb_build_object('level', 'error', 'code', 'BAD_KIND');
  end if;
  return out;
end $$;

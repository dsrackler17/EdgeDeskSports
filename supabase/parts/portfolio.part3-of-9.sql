-- portfolio -- part 3 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. TRANSACTIONS / FILLS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_transactions (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  platform_account_id     uuid        null,
  position_id             uuid        null,
  platform                text        not null,
  external_transaction_id text        null,
  transaction_type        text        not null,
  side                    text        null,
  quantity                numeric     null,
  price                   numeric     null,
  amount                  numeric     null,
  fee                     numeric     not null default 0,
  executed_at             timestamptz not null default now(),
  source                  text        not null default 'MANUAL',
  import_id               uuid        null,
  notes                   text        null,
  raw_payload             jsonb       null,
  fingerprint             text        null,
  dedupe_occurrence       int         not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint portfolio_transactions_id_owner unique (id, user_id),
  constraint portfolio_transactions_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_transactions_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete set null (platform_account_id),
  constraint portfolio_transactions_import_fk foreign key (import_id, user_id)
    references public.portfolio_imports (id, user_id) on delete set null (import_id),
  constraint portfolio_transactions_platform_key check (platform ~ '^[a-z0-9][a-z0-9_]{1,47}$'),
  constraint portfolio_transactions_type check (transaction_type in ('BET', 'BUY', 'SELL', 'FILL', 'CASHOUT', 'SETTLEMENT',
    'VOID', 'REFUND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT')),
  constraint portfolio_transactions_side check (side is null or side in ('BUY', 'SELL')),
  constraint portfolio_transactions_source check (source in ('MANUAL', 'CSV', 'SYNC', 'EDGEDESK')),
  -- a trade is a quantity of contracts at a price between $0 and $1
  constraint portfolio_transactions_trade check (transaction_type not in ('BUY', 'SELL', 'FILL')
    or (position_id is not null and quantity > 0 and quantity <= 1000000000 and quantity = round(quantity, 6)
        and price between 0 and 1 and price = round(price, 6)
        and (transaction_type <> 'FILL' or side is not null)
        and (transaction_type <> 'BUY' or side = 'BUY') and (transaction_type <> 'SELL' or side = 'SELL'))),
  constraint portfolio_transactions_cash check (transaction_type not in ('DEPOSIT', 'WITHDRAWAL') or (position_id is null and amount > 0)),
  constraint portfolio_transactions_money check ((amount is null or (amount >= 0 and amount <= 1000000000 and amount = round(amount, 6)))
    and fee >= 0 and fee <= 10000000 and fee = round(fee, 6)),
  constraint portfolio_transactions_text check (coalesce(length(external_transaction_id), 0) <= 200 and coalesce(length(notes), 0) <= 1000
    and (raw_payload is null or pg_column_size(raw_payload) <= 32768)),
  constraint portfolio_transactions_occurrence check (dedupe_occurrence between 1 and 50)
);
-- An existing database keeps its original type check; widen it to the
-- current list (adds ADJUSTMENT: a correction the platform itself made).
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'portfolio_transactions_type'
              and pg_get_constraintdef(oid) not like '%ADJUSTMENT%') then
    alter table public.portfolio_transactions drop constraint portfolio_transactions_type;
    alter table public.portfolio_transactions add constraint portfolio_transactions_type check (transaction_type in ('BET', 'BUY', 'SELL',
      'FILL', 'CASHOUT', 'SETTLEMENT', 'VOID', 'REFUND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT'));
  end if;
end $$;

comment on table public.portfolio_transactions is
  'Fills, sells, settlements and cash moves. BUY / SELL / FILL rows drive a prediction-market position''s contracts, cost and fees; a position is rebuilt from them on every change.';
create index if not exists portfolio_transactions_position on public.portfolio_transactions (position_id, executed_at);
create index if not exists portfolio_transactions_user on public.portfolio_transactions (user_id, executed_at desc);
create index if not exists portfolio_transactions_fp_lookup on public.portfolio_transactions (user_id, fingerprint);
create unique index if not exists portfolio_transactions_external_once
  on public.portfolio_transactions (user_id, platform, external_transaction_id) where external_transaction_id is not null;
create unique index if not exists portfolio_transactions_fingerprint_once
  on public.portfolio_transactions (user_id, fingerprint, dedupe_occurrence) where external_transaction_id is null and fingerprint is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE ARITHMETIC — every derived column, computed here and nowhere else
-- ─────────────────────────────────────────────────────────────────────────────
-- Is this a link being cleared because what it pointed at was deleted? A
-- foreign key's ON DELETE SET NULL runs as an UPDATE of the referencing row,
-- after the referenced row is gone; the triggers below that keep a link fixed
-- for life must let exactly that update through, or the row keeps naming a
-- record that no longer exists.
create or replace function public.portfolio_link_released(p_old uuid, p_new uuid, p_kind text)
returns boolean language sql stable as $$
  select p_old is not null and p_new is null and case p_kind
    when 'import' then not exists (select 1 from public.portfolio_imports i where i.id = p_old)
    when 'account' then not exists (select 1 from public.platform_accounts a where a.id = p_old)
    else false end
$$;

create or replace function public.portfolio_american_to_decimal(p_american int)
returns numeric language sql immutable strict as $$
  select case when p_american >= 100 then 1 + public.portfolio_div_round(p_american, 100, 6)
              when p_american <= -100 then 1 + public.portfolio_div_round(100, abs(p_american), 6) end
$$;

-- profit on a winning wager, to the cent, from the price as the source gave it
create or replace function public.portfolio_wager_profit(p_stake numeric, p_american int, p_decimal numeric)
returns numeric language sql immutable as $$
  select case when p_stake is null then null
              when p_american >= 100 then public.portfolio_div_round(p_stake * p_american, 100, 2)
              when p_american <= -100 then public.portfolio_div_round(p_stake * 100, abs(p_american), 2)
              when p_decimal > 1 then public.portfolio_div_round(p_stake * (p_decimal - 1), 1, 2) end
$$;

-- Does the reader own the EdgeDesk record this position names? Runs as the
-- caller, so row level security on the named table applies as well.
create or replace function public.portfolio_edge_ref_owned(p_user uuid, p_type text, p_id text)
returns boolean language plpgsql stable as $$
declare ok boolean := false;
begin
  if p_type = 'stake_recommendation' and to_regclass('public.stake_recommendations') is not null then
    execute 'select exists (select 1 from public.stake_recommendations where recommendation_id = $1 and user_id = $2)' into ok using p_id, p_user;
  elsif p_type = 'research_journal' and to_regclass('public.research_journal') is not null then
    execute 'select exists (select 1 from public.research_journal where entry_id::text = $1 and user_id = $2)' into ok using p_id, p_user;
  elsif p_type = 'card_opportunity' and to_regclass('public.card_opportunities') is not null then
    execute 'select exists (select 1 from public.card_opportunities where id::text = $1 and user_id = $2)' into ok using p_id, p_user;
  elsif p_type = 'user_bet' and to_regclass('public.user_bets') is not null then
    execute 'select exists (select 1 from public.user_bets where id::text = $1 and user_id = $2)' into ok using p_id, p_user;
  end if;
  return coalesce(ok, false);
end $$;

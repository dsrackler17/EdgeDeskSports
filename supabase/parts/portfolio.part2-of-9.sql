-- portfolio -- part 2 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace function public.platform_accounts_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); end if;
    if new.connection_type = 'CSV' and new.status = 'MANUAL' then new.status := 'IMPORT_ONLY'; end if;
    new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.platform := old.platform; new.platform_type := old.platform_type;
    if auth.uid() is not null then
      new.connection_type := old.connection_type; new.ingestion_method := old.ingestion_method; new.connection_tier := old.connection_tier;
      new.external_account_id := old.external_account_id; new.status := old.status;
      new.last_sync_at := old.last_sync_at; new.last_success_at := old.last_success_at; new.last_error := old.last_error;
      new.sync_cursor := old.sync_cursor; new.metadata := old.metadata; new.history_start_at := old.history_start_at;
    end if;
  end if;
  /* how the data arrives follows from the connection, unless a connector
     names a finer method (an API connection by key, by public wallet, or by
     an authorized partner) */
  if auth.uid() is not null or new.ingestion_method is null
     or (tg_op = 'UPDATE' and new.connection_type is distinct from old.connection_type and new.ingestion_method is not distinct from old.ingestion_method) then
    new.ingestion_method := case new.connection_type when 'MANUAL' then 'MANUAL' when 'CSV' then 'FILE_IMPORT'
      when 'OAUTH' then 'OAUTH' when 'AGGREGATOR' then 'AUTHORIZED_API'
      else case when new.ingestion_method in ('API_KEY', 'PUBLIC_WALLET', 'AUTHORIZED_API') then new.ingestion_method else 'API_KEY' end end;
  end if;
  new.connection_tier := case new.ingestion_method when 'OAUTH' then 1 when 'AUTHORIZED_API' then 1 when 'API_KEY' then 2
    when 'PUBLIC_WALLET' then 2 when 'FILE_IMPORT' then 3 else 4 end;
  new.platform_label := btrim(new.platform_label);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists platform_accounts_guard_trg on public.platform_accounts;
create trigger platform_accounts_guard_trg before insert or update on public.platform_accounts
  for each row execute function public.platform_accounts_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. IMPORTS (before positions, which name the import that created them)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_imports (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  platform_account_id uuid        null,
  platform            text        null,
  platform_type       text        not null,
  importer            text        not null,
  file_name           text        null,
  file_sha256         text        null,
  timezone            text        not null default 'UTC',
  column_map          jsonb       not null default '{}'::jsonb,
  status              text        not null default 'STAGED',
  rows_total          int         not null default 0,
  rows_new            int         not null default 0,
  rows_duplicate      int         not null default 0,
  rows_review         int         not null default 0,
  rows_invalid        int         not null default 0,
  rows_imported       int         not null default 0,
  rows_skipped        int         not null default 0,
  rows_failed         int         not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  classified_at       timestamptz null,
  commit_started_at   timestamptz null,
  committed_at        timestamptz null,
  constraint portfolio_imports_id_owner unique (id, user_id),
  constraint portfolio_imports_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete set null (platform_account_id),
  constraint portfolio_imports_type check (platform_type in ('SPORTSBOOK', 'PREDICTION_MARKET')),
  constraint portfolio_imports_importer check (importer ~ '^[a-z0-9_]{2,60}$'),
  constraint portfolio_imports_status check (status in ('STAGED', 'CLASSIFIED', 'COMMITTED', 'CANCELLED', 'FAILED')),
  constraint portfolio_imports_file check ((file_name is null or length(file_name) <= 200) and (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$')),
  constraint portfolio_imports_tz check (length(timezone) between 1 and 64),
  constraint portfolio_imports_map check (jsonb_typeof(column_map) = 'object' and pg_column_size(column_map) <= 8192)
);

create or replace function public.portfolio_imports_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.user_id := auth.uid(); end if;
    new.status := 'STAGED'; new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.created_at := old.created_at;
    new.platform_type := old.platform_type; new.importer := old.importer;
    if old.status = 'COMMITTED' then new.status := 'COMMITTED'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists portfolio_imports_guard_trg on public.portfolio_imports;
create trigger portfolio_imports_guard_trg before insert or update on public.portfolio_imports
  for each row execute function public.portfolio_imports_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. POSITIONS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_positions (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  platform_account_id     uuid        null,
  platform                text        not null,
  platform_label          text        not null,
  platform_type           text        not null,
  external_position_id    text        null,
  position_type           text        not null,
  sport                   text        null,
  league                  text        null,
  event_name              text        not null,
  event_id                text        null,
  event_start_at          timestamptz null,
  market_name             text        not null,
  selection               text        not null,
  side                    text        null,
  line                    numeric     null,
  legs                    jsonb       null,
  -- sportsbook inputs
  odds_american           integer     null,
  odds_decimal            numeric     null,
  stake                   numeric     null,
  reported_payout         numeric     null,
  fees                    numeric     not null default 0,
  -- prediction-market inputs
  current_price           numeric     null,
  current_price_at        timestamptz null,
  resolution              text        null,
  settlement_price        numeric     null,
  -- prediction-market aggregates: DERIVED from portfolio_transactions
  contracts               numeric     null,
  contracts_bought        numeric     null,
  contracts_sold          numeric     null,
  average_entry_price     numeric     null,
  average_exit_price      numeric     null,
  sell_proceeds           numeric     null,
  -- money: DERIVED by portfolio_positions_derive()
  cost_basis              numeric     null,
  open_cost_basis         numeric     null,
  potential_profit        numeric     null,
  potential_payout        numeric     null,
  current_value           numeric     null,
  gross_payout            numeric     null,
  realized_profit_loss    numeric     null,
  unrealized_profit_loss  numeric     null,
  profit_loss             numeric     null,
  status                  text        not null default 'OPEN',
  result                  text        null,
  placed_at               timestamptz not null default now(),
  settled_at              timestamptz null,
  source                  text        not null default 'MANUAL',
  import_id               uuid        null,
  notes                   text        null,
  raw_payload             jsonb       null,
  -- EdgeDesk attribution: explicit, never inferred from an event name
  edge_source             text        null,
  edge_ref_type           text        null,
  edge_ref_id             text        null,
  model_version           text        null,
  model_probability       numeric     null,
  model_fair_line         numeric     null,
  market_line_at_research numeric     null,
  market_line_at_entry    numeric     null,
  edge_at_entry           numeric     null,
  clv                     numeric     null,
  confidence_tier         text        null,
  -- identity
  fingerprint             text        null,
  contract_key            text        null,
  dedupe_occurrence       int         not null default 1,
  calc_version            text        not null default 'portfolio_calc_v1',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint portfolio_positions_id_owner unique (id, user_id),
  constraint portfolio_positions_account_fk foreign key (platform_account_id, user_id)
    references public.platform_accounts (id, user_id) on delete set null (platform_account_id),
  constraint portfolio_positions_import_fk foreign key (import_id, user_id)
    references public.portfolio_imports (id, user_id) on delete set null (import_id),
  constraint portfolio_positions_platform_key check (platform ~ '^[a-z0-9][a-z0-9_]{1,47}$'),
  constraint portfolio_positions_label check (length(btrim(platform_label)) between 1 and 60),
  constraint portfolio_positions_platform_type check (platform_type in ('SPORTSBOOK', 'PREDICTION_MARKET')),
  constraint portfolio_positions_position_type check (position_type in ('MONEYLINE', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'PARLAY',
    'SAME_GAME_PARLAY', 'FUTURE', 'EVENT_CONTRACT', 'PREDICTION_MARKET', 'OTHER')),
  constraint portfolio_positions_status check (status in ('OPEN', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'SETTLED')),
  constraint portfolio_positions_status_by_type check (platform_type = 'SPORTSBOOK' or status in ('OPEN', 'SETTLED', 'VOID')),
  constraint portfolio_positions_result check (result is null or result in ('WIN', 'LOSS', 'PUSH', 'VOID', 'CASHOUT')),
  constraint portfolio_positions_source check (source in ('MANUAL', 'CSV', 'SYNC', 'EDGEDESK')),
  constraint portfolio_positions_text check (length(btrim(event_name)) between 1 and 200 and length(btrim(market_name)) between 1 and 200
    and length(btrim(selection)) between 1 and 200 and coalesce(length(side), 0) <= 80 and coalesce(length(sport), 0) <= 30
    and coalesce(length(league), 0) <= 30 and coalesce(length(event_id), 0) <= 120 and coalesce(length(notes), 0) <= 2000
    and coalesce(length(external_position_id), 0) <= 200 and coalesce(length(resolution), 0) <= 80
    and coalesce(length(model_version), 0) <= 60 and coalesce(length(confidence_tier), 0) <= 30),
  constraint portfolio_positions_json check ((legs is null or (jsonb_typeof(legs) = 'array' and jsonb_array_length(legs) <= 30))
    and (raw_payload is null or pg_column_size(raw_payload) <= 65536)),
  constraint portfolio_positions_odds check ((odds_american is null or ((odds_american <= -100 or odds_american >= 100) and abs(odds_american) <= 1000000))
    and (odds_decimal is null or (odds_decimal > 1 and odds_decimal <= 10001))),
  constraint portfolio_positions_money check ((stake is null or (stake > 0 and stake <= 10000000 and stake = round(stake, 2)))
    and (reported_payout is null or (reported_payout >= 0 and reported_payout <= 1000000000 and reported_payout = round(reported_payout, 6)))
    and fees >= 0 and fees <= 10000000),
  constraint portfolio_positions_prices check ((current_price is null or current_price between 0 and 1)
    and (settlement_price is null or settlement_price between 0 and 1)),
  constraint portfolio_positions_wager_shape check (platform_type <> 'SPORTSBOOK'
    or (stake is not null and (odds_american is not null or odds_decimal is not null))),
  constraint portfolio_positions_payout_needed check (platform_type <> 'SPORTSBOOK' or status not in ('CASHED_OUT', 'SETTLED') or reported_payout is not null),
  constraint portfolio_positions_settled_at check ((status = 'OPEN') = (settled_at is null) and (settled_at is null or settled_at >= placed_at)),
  constraint portfolio_positions_edge check ((edge_source is null or edge_source in ('EDGEDESK', 'SELF', 'OTHER'))
    and (edge_ref_type is null or edge_ref_type in ('stake_recommendation', 'research_journal', 'card_opportunity', 'user_bet'))
    and ((edge_ref_type is null) = (edge_ref_id is null)) and (edge_ref_type is null or edge_source = 'EDGEDESK')
    and (model_probability is null or (model_probability > 0 and model_probability < 1)) and coalesce(length(edge_ref_id), 0) <= 120),
  constraint portfolio_positions_occurrence check (dedupe_occurrence between 1 and 50)
);
-- A bonus bet (site credit) risks no cash and, as books pay them, returns
-- only the winnings: its cost basis is 0, a win pays the profit, a loss or a
-- void returns nothing. Everything is in one currency per position (USD
-- today); amounts are never converted.
alter table public.portfolio_positions add column if not exists stake_type text not null default 'CASH';
alter table public.portfolio_positions add column if not exists currency text not null default 'USD';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'portfolio_positions_stake_type') then
    alter table public.portfolio_positions add constraint portfolio_positions_stake_type
      check (stake_type in ('CASH', 'BONUS') and (stake_type = 'CASH' or platform_type = 'SPORTSBOOK'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portfolio_positions_currency') then
    alter table public.portfolio_positions add constraint portfolio_positions_currency check (currency ~ '^[A-Z]{3}$');
  end if;
end $$;

comment on table public.portfolio_positions is
  'One normalized row per wager or prediction-market position. Every money column after the inputs is derived by trigger (portfolio_positions_derive); a prediction-market position''s contracts, cost and fees come from its rows in portfolio_transactions.';
comment on column public.portfolio_positions.reported_payout is
  'What the platform actually paid. Sportsbook: the whole return (required for CASHED_OUT and SETTLED; overrides the computed payout otherwise). Prediction market: the resolution payout on contracts still held.';
comment on column public.portfolio_positions.profit_loss is
  'Final P&L, set only once the position is settled. realized_profit_loss carries partial exits of a still-open prediction-market position; unrealized_profit_loss carries the mark at current_price.';

create index if not exists portfolio_positions_user_placed on public.portfolio_positions (user_id, placed_at desc);
create index if not exists portfolio_positions_user_open on public.portfolio_positions (user_id) where status = 'OPEN';
create index if not exists portfolio_positions_account on public.portfolio_positions (platform_account_id);
create index if not exists portfolio_positions_fp_lookup on public.portfolio_positions (user_id, fingerprint);
create index if not exists portfolio_positions_contract_lookup on public.portfolio_positions (user_id, contract_key) where contract_key is not null;
create unique index if not exists portfolio_positions_external_once
  on public.portfolio_positions (user_id, platform, external_position_id) where external_position_id is not null;
create unique index if not exists portfolio_positions_fingerprint_once
  on public.portfolio_positions (user_id, fingerprint, dedupe_occurrence) where external_position_id is null and fingerprint is not null;

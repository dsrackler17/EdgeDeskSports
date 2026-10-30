-- =============================================================================
-- radar.sql — Prediction Radar (EXPERIMENTAL): where the best prediction-market
-- bettors put real money on the games EdgeDesk covers, graded honestly.
-- docs/prediction-radar.md
--
-- NOT A PICK SERVICE. Radar shows what graded money on Polymarket is doing and
-- how following it has actually performed. It never says what to bet, it is
-- the same for every subscriber, and it trades for no one.
--
-- WHO WRITES. Only the service role, through supabase/functions/polymarket_sync
-- (the scheduled job), every Polymarket request through the Radar gateway
-- (lib/edgedesk_poly_gateway.js), whose budget is decided here:
--   poly_api_acquire / poly_api_settle   the daily ceiling, the per-run cap,
--                                        the breaker, under one row lock
--   poly_wallets        the candidate pool (the sports leaderboard) and each
--                       wallet's public name, if it made one public
--   poly_markets        Polymarket markets, each matched ONCE to one EdgeDesk
--                       game (signals.event_id) or left unmapped with a reason
--   poly_trades         every trade, redemption, split and merge, with its
--                       transaction hash (APPEND-ONLY)
--   poly_bets           each graded bet: entry, close, CLV, the 5- and
--                       15-minute follow, the result (APPEND-ONLY, once)
--   poly_grade_runs     one row per grading run: the rules it used
--   poly_wallet_grades  every wallet's grade, versioned by run (APPEND-ONLY)
--   poly_holder_snapshots, poly_price_snapshots   who holds each side of the
--                       markets on upcoming games, and the price, every 10
--                       minutes (APPEND-ONLY)
--   poly_sync_runs, poly_alerts   what each run did (APPEND-ONLY)
--
-- WHO READS (the database decides; the pages never filter access):
--   anyone              radar_status(); and once POLYMARKET_DATA_ENABLED is on
--                       and H-RADAR-01 is registered: the graded leaderboard
--                       (radar_leaderboard, and poly_wallet_grades by RLS),
--                       each trader's graded history (radar_trader), and a
--                       teaser of the first Smart Money card (radar_teaser:
--                       the game, the count, the dollars; never the side)
--   subscribers         (has_active_sub(), the terminal's own rule) Smart Money
--                       Tonight (radar_tonight) and a trader's open positions
--   nobody else         trades, holders, prices, the pool, the budget
--
-- THE RULES are ONE constant, public.radar_rules(): every threshold the
-- grading, the leaderboard and Smart Money Tonight use. The scheduled job
-- reads it at the start of every run; the H-RADAR-01 registration carries a
-- frozen copy, and tools/radar/radar_sql.test.js holds the two equal.
--
-- THE SWITCH. radar_config POLYMARKET_DATA_ENABLED starts OFF: nothing is
-- fetched and nothing is shown until the owner has read Polymarket's terms of
-- use for commercial display and turned it on (one statement, no deploy;
-- docs/prediction-radar.md, open items). Turning it off hides every reader
-- door at once and stops the job at its next run.
--
-- REQUIRES capture's public.signals (it names any column it reads that is
-- missing). Uses public.has_active_sub() when present (without it, nobody but
-- the service role sees Smart Money Tonight). Nothing existing is altered.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored byte for byte in supabase/migrations/20261029120000_radar.sql.
-- =============================================================================

do $req$
declare missing text;
begin
  if to_regclass('public.signals') is null then
    raise exception 'radar.sql reads public.signals (capture''s board), which does not exist here';
  end if;
  select string_agg(c, ', ' order by i) into missing
    from unnest(array['sig_key', 'event_id', 'sport_key', 'commence_time', 'home_team', 'away_team', 'market', 'selection', 'point', 'sharp_fair', 'last_seen_at']) with ordinality u(c, i)
   where not exists (select 1 from pg_attribute a where a.attrelid = 'public.signals'::regclass and a.attname = c and a.attnum > 0 and not a.attisdropped);
  if missing is not null then
    raise exception 'radar.sql: public.signals has no column(s) % (capture writes them)', missing;
  end if;
end $req$;

begin;

-- ---------------------------------------------------------------- the rules: ONE constant
create or replace function public.radar_rules()
returns jsonb language sql immutable as $r$
  select jsonb_build_object(
    -- H-RADAR-02 (research/radar/registration_h_radar_02.json): rules version 2. H-RADAR-01's rules were version 1
    'rules_version',           2,
    -- who is graded, and how
    'min_graded',              50,      -- graded bets to be ranked; fewer is a small sample with no rank and no Radar Score
    'top_wallets',             10,      -- featured: at most this many, each with a Radar Score above featured_min_score; fewer when fewer qualify
    'featured_min_score',      0,
    'pool_size',               200,     -- the pool: the eligible wallets with the most covered-league dollars in the window
    'pool_period',             'MONTH', -- candidates: Polymarket's 30-day sports board (it ranks candidates only: it qualifies nobody)
    'pool_order',              'VOL',
    'pool_window_days',        90,      -- each candidate's complete last 90 days, read newest first
    'pool_min_covered_bets',   20,      -- covered pregame bets in the window to be eligible for the pool
    'discovery_max_rank',      1000,    -- how far down the board discovery reads
    'max_bets_per_wallet',     150,     -- a grade reads a wallet's most recent graded bets
    'wallet_max_pages',        30,      -- the processing cap: more activity pages in the window is insufficient history (ungraded)
    'screen_actions',          1000,    -- the screening flag: this many actions inside screen_days (it proves nothing)
    'screen_days',             3,
    'hf_changes_per_day',      100,     -- high-frequency, not followable: above this in every sample, each known
    'hf_sample_hours',         24,      -- each sample: the 24 hours ending now, 30 and 60 days ago
    'hf_sample_days_ago',      jsonb_build_array(0, 30, 60),
    'hf_change_gap_min',       10,      -- fills on one token and side within this of the last are one position change
    'follow_cost',             0.01,    -- a historical follow pays the midpoint plus this (the price history is the midpoint)
    'follow_lag_min',          5,       -- the follow: the market price this long after the wallet's first buy
    'follow_lag_alt_min',      15,
    'follow_max_gap_min',      10,      -- a follow price is no older than this
    'close_max_gap_min',       60,      -- the close: the last price at or before the start, no older than this
    'conviction_high_x',       3,       -- a position this many times the wallet's median stake is flagged
    'mm_two_sided_share',      0.5,     -- Market Maker: this share of markets two-sided,
    'mm_median_trades',        6,       --   this many trades a market (median),
    'mm_max_net_ratio',        0.3,     --   and shares this balanced (median |A - B| / (A + B))
    'hedger_two_sided_share',  0.2,     -- Hedger: not a market maker, this share two-sided
    'score_weight_follow_roi', 0.5,     -- the Radar Score (EXPERIMENTAL composite, always shown with its parts)
    'score_weight_clv_pct',    0.3,
    'score_weight_roi',        0.2,
    'score_shrink_n',          50,      -- each part shrunk by n / (n + 50)
    'leagues',                 jsonb_build_array('nfl', 'cfb', 'nba', 'nhl', 'mlb'),
    'market_types',            jsonb_build_array('moneyline', 'spreads', 'totals'),
    -- H-RADAR-02 and the record
    'validation_min_followed', 200,
    'ci_level',                0.95,
    'bootstrap_resamples',     2000,
    'bootstrap_seed',          20261030,
    'follow_slippage_sensitivity', 0.01,
    -- Smart Money Tonight
    'upcoming_hours',          36,      -- games starting within this many hours
    'holders_fresh_min',       30,      -- a holders snapshot older than this is not shown
    'moved_min',               0.01,    -- the price has moved since they entered: by at least a cent
    'fair_max_age_min',        90,      -- EdgeDesk's fair is current within 90 minutes (the board's past-price rule)
    'kickoff_tolerance_min',   360,     -- a Polymarket market and an EdgeDesk game start within 6 hours of each other
    -- the gateway
    'daily_request_ceiling',   40000,
    'run_request_cap',         3000,
    'breaker_minutes',         15
  )
$r$;
create or replace function public.radar_rule(p_key text)
returns numeric language sql immutable as $r$ select (public.radar_rules() ->> p_key)::numeric $r$;

-- ---------------------------------------------------------------- append-only
create or replace function public.radar_keep()
returns trigger language plpgsql as $k$
begin
  raise exception 'public.% is append-only: % refused (write a new row instead)', tg_table_name, tg_op;
end $k$;
create or replace function public.radar_seal(p_tables text[])
returns void language plpgsql as $s$
declare t text;
begin
  foreach t in array p_tables loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.radar_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.radar_keep()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert on public.%I to service_role', t);
    end if;
  end loop;
end $s$;
revoke all on function public.radar_seal(text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------- the switch and its log
create table if not exists public.radar_config (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);
create table if not exists public.radar_config_log (
  id         bigint generated always as identity primary key,
  key        text not null,
  old_value  text,
  new_value  text,
  note       text,
  changed_at timestamptz not null default now(),
  changed_by text not null default current_user
);
create or replace function public.radar_config_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $a$
begin
  insert into public.radar_config_log (key, old_value, new_value, note)
  values (coalesce(new.key, old.key), case when tg_op = 'INSERT' then null else old.value end,
          case when tg_op = 'DELETE' then null else new.value end, case when tg_op = 'DELETE' then old.note else new.note end);
  return coalesce(new, old);
end $a$;
drop trigger if exists radar_config_audit on public.radar_config;
create trigger radar_config_audit after insert or update or delete on public.radar_config
  for each row execute function public.radar_config_audit();
insert into public.radar_config (key, value, note) values
  ('POLYMARKET_DATA_ENABLED', 'off', 'off until the owner has read Polymarket''s terms of use for commercial display of its public data and they permit it. on: polymarket_sync fetches and the reader doors show Radar. Record who, when and the clause in this note.')
on conflict (key) do nothing;
create or replace function public.radar_setting(p_key text)
returns text language sql stable security definer set search_path = public, pg_temp as $s$
  select value from public.radar_config where key = p_key
$s$;
create or replace function public.radar_enabled()
returns boolean language sql stable security definer set search_path = public, pg_temp as $s$
  select coalesce((select value from public.radar_config where key = 'POLYMARKET_DATA_ENABLED'), 'off') = 'on'
$s$;
-- REGISTERED BEFORE SHOWN: supabase/radar_registry.sql is the only writer of these links. The hypothesis whose
-- rules are live must be registered: H-RADAR-02 for rules version 2 (H-RADAR-01's stays, and its result stands)
create or replace function public.radar_hypothesis()
returns text language sql immutable as $s$
  select case when coalesce((public.radar_rules() ->> 'rules_version')::int, 1) >= 2 then 'H-RADAR-02' else 'H-RADAR-01' end
$s$;
create or replace function public.radar_registered()
returns boolean language sql stable security definer set search_path = public, pg_temp as $s$
  select exists (select 1 from public.radar_config where key = 'registry_ref:' || public.radar_hypothesis())
$s$;
alter table public.radar_config enable row level security;
revoke all on public.radar_config from anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.radar_config to service_role';
  end if;
end $g$;
select public.radar_seal(array['radar_config_log']);

-- ---------------------------------------------------------------- the gateway's budget
create table if not exists public.poly_api_days (
  day            date primary key,
  granted        integer not null default 0 check (granted >= 0),   -- reserved by open grants plus used by settled ones
  used           integer not null default 0 check (used >= 0),
  rate_limited   integer not null default 0,
  breaker_until  timestamptz,
  updated_at     timestamptz not null default now()
);
create table if not exists public.poly_api_grants (
  grant_id   bigint generated always as identity primary key,
  run_id     uuid,
  caller     text not null,
  requested  integer not null check (requested >= 0),
  granted    integer not null check (granted >= 0),
  decision   text not null check (decision in ('granted', 'denied_disabled', 'denied_breaker', 'denied_budget')),
  reason     text,
  granted_at timestamptz not null default now()
);
create table if not exists public.poly_api_settlements (
  grant_id      bigint primary key references public.poly_api_grants (grant_id),
  used          integer not null check (used >= 0),
  rate_limited  integer not null default 0,
  breaker       boolean not null default false,
  statuses      jsonb not null default '{}'::jsonb,
  settled_at    timestamptz not null default now()
);
select public.radar_seal(array['poly_api_grants', 'poly_api_settlements']);
alter table public.poly_api_days enable row level security;
revoke all on public.poly_api_days from anon, authenticated;

-- one grant per run, decided under the day's row lock: the switch, the breaker,
-- the daily ceiling and the per-run cap. A refusal is answered, never waited out.
create or replace function public.poly_api_acquire(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare d public.poly_api_days; want int := greatest(0, coalesce((p ->> 'requested')::int, 0));
        cap int := public.radar_rule('run_request_cap')::int; ceiling int := public.radar_rule('daily_request_ceiling')::int;
        give int := 0; dec text; why text; gid bigint;
begin
  insert into public.poly_api_days (day) values ((now() at time zone 'utc')::date) on conflict (day) do nothing;
  select * into d from public.poly_api_days where day = (now() at time zone 'utc')::date for update;
  if not public.radar_enabled() then dec := 'denied_disabled'; why := 'POLYMARKET_DATA_ENABLED is off';
  elsif d.breaker_until is not null and d.breaker_until > now() then dec := 'denied_breaker'; why := 'the breaker is open until ' || d.breaker_until;
  else
    give := least(want, cap, greatest(0, ceiling - d.granted));
    if give = 0 then dec := 'denied_budget'; why := 'the daily ceiling of ' || ceiling || ' requests is reserved'; else dec := 'granted'; end if;
  end if;
  update public.poly_api_days set granted = granted + give, updated_at = now() where day = d.day;
  insert into public.poly_api_grants (run_id, caller, requested, granted, decision, reason)
  values (nullif(p ->> 'run_id', '')::uuid, coalesce(nullif(p ->> 'caller', ''), 'unknown'), want, give, dec, why) returning grant_id into gid;
  return jsonb_build_object('decision', dec, 'granted', give, 'grant_id', gid, 'reason', why, 'ceiling', ceiling, 'run_cap', cap);
end $f$;
-- the run's account: what it used (the unused part goes back to the day), the
-- rate limits, and the breaker it opened
create or replace function public.poly_api_settle(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare g public.poly_api_grants; u int := greatest(0, coalesce((p ->> 'used')::int, 0)); brk boolean := coalesce((p ->> 'breaker')::boolean, false);
begin
  select * into g from public.poly_api_grants where grant_id = (p ->> 'grant_id')::bigint;
  if not found then raise exception 'poly_api_settle: no grant %', p ->> 'grant_id'; end if;
  if exists (select 1 from public.poly_api_settlements where grant_id = g.grant_id) then return jsonb_build_object('settled', false, 'reason', 'already settled'); end if;
  if u > g.granted then raise exception 'poly_api_settle: % requests used on a grant of %', u, g.granted; end if;
  insert into public.poly_api_settlements (grant_id, used, rate_limited, breaker, statuses)
  values (g.grant_id, u, coalesce((p ->> 'rate_limited')::int, 0), brk, coalesce(p -> 'statuses', '{}'::jsonb));
  update public.poly_api_days set granted = granted - (g.granted - u), used = used + u,
         rate_limited = rate_limited + coalesce((p ->> 'rate_limited')::int, 0),
         breaker_until = case when brk then now() + make_interval(mins => public.radar_rule('breaker_minutes')::int) else breaker_until end,
         updated_at = now()
   where day = (g.granted_at at time zone 'utc')::date;
  return jsonb_build_object('settled', true, 'used', u, 'returned', g.granted - u);
end $f$;

-- ---------------------------------------------------------------- the pool
create table if not exists public.poly_wallets (
  wallet              text primary key check (wallet ~ '^0x[0-9a-f]{40}$'),
  display_name        text,                       -- the Polymarket name, shown only when display_public
  display_public      boolean not null default false,
  in_pool             boolean not null default false,
  pool_rank           integer,
  pool_volume         numeric,
  pool_pnl            numeric,                    -- Polymarket's own figure, kept for reference; Radar never shows it
  pool_refreshed_at   timestamptz,
  activity_synced_at  timestamptz,
  activity_cursor     jsonb,
  history_truncated   boolean not null default false,
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.poly_wallets is 'Prediction Radar: the candidate pool (the sports leaderboard) and each wallet''s name, shown only when the wallet made it public. No bio or profile is stored.';
-- H-RADAR-02: discovery (the 30-day board ranks candidates; it qualifies nobody) and each candidate's evaluation
alter table public.poly_wallets add column if not exists board_rank          integer;
alter table public.poly_wallets add column if not exists board_shares        numeric;     -- the board's volume: shares, not dollars (probe run 40975893030)
alter table public.poly_wallets add column if not exists board_seen_at       timestamptz;
alter table public.poly_wallets add column if not exists eval_status         text not null default 'pending'
  check (eval_status in ('pending', 'evaluating', 'evaluated', 'high_frequency', 'insufficient_history'));
alter table public.poly_wallets add column if not exists window_covered_usd  numeric;     -- dollars on covered-league game markets in the window
alter table public.poly_wallets add column if not exists window_covered_bets integer;     -- covered pregame bets in the window
alter table public.poly_wallets add column if not exists screen_flag         boolean not null default false;
alter table public.poly_wallets add column if not exists hf                  jsonb;       -- the three samples, each known or unknown, and the verdict
alter table public.poly_wallets add column if not exists high_frequency      boolean not null default false;
alter table public.poly_wallets add column if not exists evaluated_at        timestamptz;
create index if not exists poly_wallets_board_idx on public.poly_wallets (board_rank) where board_rank is not null;
alter table public.poly_wallets enable row level security;
revoke all on public.poly_wallets from anon, authenticated;

-- ---------------------------------------------------------------- markets, and their one EdgeDesk game
create table if not exists public.poly_markets (
  condition_id      text primary key check (condition_id ~ '^0x[0-9a-f]{64}$'),
  market_id         text,
  question          text,
  slug              text,
  event_slug        text,
  event_ref         text,                         -- Polymarket's event: the game, for clustering
  event_title       text,
  league            text,
  market_type       text check (market_type is null or market_type in ('moneyline', 'spreads', 'totals')),
  type_source       text,
  line              numeric,
  outcomes          jsonb not null default '[]'::jsonb,
  token_ids         jsonb not null default '[]'::jsonb,
  game_start_at     timestamptz,
  closed            boolean not null default false,
  settle            jsonb,                        -- each outcome's settlement (0, 0.5, 1), once resolved
  resolved_at       timestamptz,
  -- the EdgeDesk game, written once
  event_id          text,
  sport_key         text,
  sides             jsonb,                        -- per outcome: token, selection, point, sig_key (the board's fair at THAT line, or null)
  match_status      text not null default 'pending' check (match_status in ('pending', 'mapped', 'unmapped', 'not_covered')),
  match_reason      text,
  match_detail      jsonb,
  match_confidence  text,
  match_method      text,
  matched_at        timestamptz,
  linker_version    text,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((match_status = 'mapped') = (event_id is not null)),
  check (event_id is null or (sides is not null and jsonb_array_length(sides) = 2))
);
-- H-RADAR-02: what a market charges a taker, as it says itself (Gamma feesEnabled, feeSchedule); null: never read
alter table public.poly_markets add column if not exists fees_enabled boolean;
alter table public.poly_markets add column if not exists fee_schedule jsonb;
create index if not exists poly_markets_event_idx on public.poly_markets (event_id) where event_id is not null;
create index if not exists poly_markets_start_idx on public.poly_markets (game_start_at);
-- a mapping is written once and never moved; a resolution is final
create or replace function public.poly_markets_guard()
returns trigger language plpgsql as $g$
begin
  if tg_op = 'DELETE' then raise exception 'poly_markets: a market is never deleted'; end if;
  if old.event_id is not null and (new.event_id is distinct from old.event_id or new.sides is distinct from old.sides
     or new.sport_key is distinct from old.sport_key or new.match_status is distinct from old.match_status) then
    raise exception 'poly_markets: % is already matched to % (a mapping is written once)', old.condition_id, old.event_id;
  end if;
  if old.settle is not null and new.settle is distinct from old.settle then
    raise exception 'poly_markets: % already resolved (a resolution is final)', old.condition_id;
  end if;
  if new.token_ids is distinct from old.token_ids and jsonb_array_length(old.token_ids) > 0 then
    raise exception 'poly_markets: % keeps its tokens', old.condition_id;
  end if;
  new.updated_at := now();
  return new;
end $g$;
drop trigger if exists poly_markets_guard on public.poly_markets;
create trigger poly_markets_guard before update or delete on public.poly_markets for each row execute function public.poly_markets_guard();
alter table public.poly_markets enable row level security;
revoke all on public.poly_markets from anon, authenticated;

-- ---------------------------------------------------------------- trades (append-only)
create table if not exists public.poly_trades (
  id             bigint generated always as identity primary key,
  wallet         text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  kind           text not null check (kind in ('TRADE', 'REDEEM', 'SPLIT', 'MERGE', 'CONVERSION')),
  side           text check (side is null or side in ('BUY', 'SELL')),
  condition_id   text not null,
  token_id       text,
  outcome_index  integer,
  size           numeric,
  price          numeric check (price is null or (price >= 0 and price <= 1)),
  usdc           numeric,
  traded_at      timestamptz not null,
  tx_hash        text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),   -- every row: its transaction on Polygon
  slug           text,
  event_slug     text,
  run_id         uuid,
  ingested_at    timestamptz not null default now(),
  token_key      text generated always as (coalesce(token_id, '')) stored,
  side_key       text generated always as (coalesce(side, '')) stored,
  size_key       numeric generated always as (coalesce(size, -1)) stored,
  price_key      numeric generated always as (coalesce(price, -1)) stored,
  check (kind <> 'TRADE' or (side is not null and token_id is not null and size > 0 and price is not null))
);
create unique index if not exists poly_trades_once_idx on public.poly_trades (tx_hash, wallet, kind, token_key, side_key, size_key, price_key);
create index if not exists poly_trades_wallet_idx on public.poly_trades (wallet, traded_at);
create index if not exists poly_trades_condition_idx on public.poly_trades (condition_id);
select public.radar_seal(array['poly_trades']);
comment on table public.poly_trades is 'Prediction Radar: every trade, redemption, split and merge of the pool''s wallets, with its Polygon transaction hash. Append-only.';

-- ---------------------------------------------------------------- graded bets (append-only, once)
create table if not exists public.poly_bets (
  wallet          text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  token_id        text not null,
  condition_id    text not null references public.poly_markets (condition_id),
  outcome_index   integer not null check (outcome_index >= 0),
  outcome         text,
  league          text not null,
  market_type     text not null,
  line            numeric,
  event_ref       text,
  event_slug      text,
  question        text,
  game_start_at   timestamptz not null,
  entry_at        timestamptz not null,
  entry_tx        text not null check (entry_tx ~ '^0x[0-9a-f]{64}$'),
  txs             text[] not null,
  entry_price     numeric not null check (entry_price > 0 and entry_price < 1),
  stake           numeric not null check (stake > 0),
  shares_pregame  numeric not null check (shares_pregame > 0),
  buy_cost        numeric not null check (buy_cost >= stake - 1e-6),
  sell_proceeds   numeric not null check (sell_proceeds >= 0),
  shares_held     numeric not null check (shares_held >= 0),
  trades          integer not null check (trades >= 1),
  settle          numeric not null check (settle in (0, 0.5, 1)),
  result          text not null check (result in ('win', 'loss', 'push')),
  profit          numeric not null,
  close_price     numeric check (close_price is null or (close_price >= 0 and close_price <= 1)),
  close_at        timestamptz,
  clv_pp          numeric,
  clv_pct         numeric,
  follow5_price   numeric check (follow5_price is null or (follow5_price > 0 and follow5_price < 1)),
  follow5_at      timestamptz,
  follow5_reason  text,
  follow5_roi     numeric,
  follow15_price  numeric check (follow15_price is null or (follow15_price > 0 and follow15_price < 1)),
  follow15_at     timestamptz,
  follow15_reason text,
  follow15_roi    numeric,
  beat_close5     boolean,
  grading_version text not null,
  run_id          uuid,
  graded_at       timestamptz not null default now(),
  follow5_mid     numeric check (follow5_mid is null or (follow5_mid > 0 and follow5_mid < 1)),    -- version 2: the midpoint the follow paid follow_cost over
  follow15_mid    numeric check (follow15_mid is null or (follow15_mid > 0 and follow15_mid < 1)),
  primary key (wallet, token_id, grading_version),
  check (entry_at < game_start_at),
  check (result = case settle when 1 then 'win' when 0 then 'loss' else 'push' end),
  check (abs(profit - (sell_proceeds + settle * shares_held - buy_cost)) < 1e-4),
  check ((close_price is null) = (clv_pct is null)),
  follow5_fee     numeric check (follow5_fee is null or follow5_fee >= 0),    -- version 2: the market's taker fee a share at the follow price
  follow15_fee    numeric check (follow15_fee is null or follow15_fee >= 0),
  constraint poly_bets_follow5_roi check (follow5_roi is null or abs(follow5_roi - (settle / (follow5_price + coalesce(follow5_fee, 0)) - 1)) < 1e-4),
  constraint poly_bets_follow15_roi check (follow15_roi is null or abs(follow15_roi - (settle / (follow15_price + coalesce(follow15_fee, 0)) - 1)) < 1e-4),
  check (beat_close5 is null or beat_close5 = (close_price > follow5_price)),
  check (entry_tx = any (txs))
);
alter table public.poly_bets add column if not exists follow5_mid numeric check (follow5_mid is null or (follow5_mid > 0 and follow5_mid < 1));
alter table public.poly_bets add column if not exists follow15_mid numeric check (follow15_mid is null or (follow15_mid > 0 and follow15_mid < 1));
alter table public.poly_bets add column if not exists follow5_fee numeric check (follow5_fee is null or follow5_fee >= 0);
alter table public.poly_bets add column if not exists follow15_fee numeric check (follow15_fee is null or follow15_fee >= 0);
-- a follow's ROI is settlement / (price + the taker fee) - 1: the version-1 checks (no fee) become these, which read the
-- same for every version-1 row (its fee is null)
do $roi$ declare c record; begin
  for c in select conname from pg_constraint where conrelid = 'public.poly_bets'::regclass and contype = 'c'
            and conname not in ('poly_bets_follow5_roi', 'poly_bets_follow15_roi')
            and pg_get_constraintdef(oid) ~ 'follow(5|15)_roi - \(\(?settle / follow(5|15)_price\)?' loop
    execute format('alter table public.poly_bets drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'poly_bets_follow5_roi') then
    alter table public.poly_bets add constraint poly_bets_follow5_roi check (follow5_roi is null or abs(follow5_roi - (settle / (follow5_price + coalesce(follow5_fee, 0)) - 1)) < 1e-4);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'poly_bets_follow15_roi') then
    alter table public.poly_bets add constraint poly_bets_follow15_roi check (follow15_roi is null or abs(follow15_roi - (settle / (follow15_price + coalesce(follow15_fee, 0)) - 1)) < 1e-4);
  end if;
end $roi$;
-- one grade of a bet per grading version: version 2 rows sit beside version 1's, which are never edited
do $pk$ begin
  if (select array_agg(a.attname::text order by k.ord) from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'public.poly_bets'::regclass and c.contype = 'p') is distinct from array['wallet', 'token_id', 'grading_version'] then
    execute 'alter table public.poly_bets drop constraint if exists poly_bets_pkey';
    execute 'alter table public.poly_bets add constraint poly_bets_pkey primary key (wallet, token_id, grading_version)';
  end if;
end $pk$;
create index if not exists poly_bets_wallet_idx on public.poly_bets (wallet, entry_at desc);
create index if not exists poly_bets_version_idx on public.poly_bets (wallet, grading_version, entry_at desc);
-- THE TAKER FEE a share at price p, in USDC (docs.polymarket.com, trading/fees and market-data/market-details):
-- rate x (p x (1 - p))^exponent from the market's own fee schedule; no fee when fees are not enabled; null (unknown)
-- when the fee status was never read or the schedule cannot be read. Rounded as lib/edgedesk_radar.js R.takerFee does
create or replace function public.radar_taker_fee(p numeric, schedule jsonb, enabled boolean)
returns numeric language sql immutable as $t$
  select case
    when p is null or p <= 0 or p >= 1 or enabled is null then null
    when not enabled then 0::numeric
    when jsonb_typeof(schedule -> 'rate') = 'number' and jsonb_typeof(schedule -> 'exponent') = 'number' and (schedule ->> 'rate')::numeric >= 0
      then round((schedule ->> 'rate')::numeric * power(p * (1 - p), (schedule ->> 'exponent')::numeric), 6)
  end
$t$;
-- a bet is graded only on a resolved market, at its own outcome's settlement
create or replace function public.poly_bets_guard()
returns trigger language plpgsql as $g$
declare m public.poly_markets;
begin
  select * into m from public.poly_markets where condition_id = new.condition_id;
  if m.settle is null then raise exception 'poly_bets: % has not resolved: nothing to grade', new.condition_id; end if;
  if (m.settle ->> new.outcome_index)::numeric is distinct from new.settle then
    raise exception 'poly_bets: outcome % of % settled at %, not %', new.outcome_index, new.condition_id, m.settle ->> new.outcome_index, new.settle;
  end if;
  if m.token_ids ->> new.outcome_index is distinct from new.token_id then raise exception 'poly_bets: token % is not outcome % of %', new.token_id, new.outcome_index, new.condition_id; end if;
  if m.game_start_at is distinct from new.game_start_at then raise exception 'poly_bets: the start must be the market''s'; end if;
  -- the follow and the close are the rules' own
  if new.follow5_at is not null and new.follow5_at > new.entry_at + make_interval(mins => public.radar_rule('follow_lag_min')::int) then
    raise exception 'poly_bets: a 5-minute follow price may not come from after entry + % minutes', public.radar_rule('follow_lag_min');
  end if;
  if new.follow15_at is not null and new.follow15_at > new.entry_at + make_interval(mins => public.radar_rule('follow_lag_alt_min')::int) then
    raise exception 'poly_bets: a 15-minute follow price may not come from after entry + % minutes', public.radar_rule('follow_lag_alt_min');
  end if;
  if new.close_at is not null and (new.close_at > new.game_start_at or new.close_at < new.game_start_at - make_interval(mins => public.radar_rule('close_max_gap_min')::int)) then
    raise exception 'poly_bets: a close must be the last price at or before the start, at most % minutes before it', public.radar_rule('close_max_gap_min');
  end if;
  -- version 2: a follow pays the midpoint plus follow_cost, never less, and the market's taker fee at that price
  if new.grading_version = 'radar-grade-2' then
    if (new.follow5_price is not null and (new.follow5_fee is null or public.radar_taker_fee(new.follow5_price, m.fee_schedule, m.fees_enabled) is null
          or abs(new.follow5_fee - public.radar_taker_fee(new.follow5_price, m.fee_schedule, m.fees_enabled)) > 1e-6))
       or (new.follow15_price is not null and (new.follow15_fee is null or public.radar_taker_fee(new.follow15_price, m.fee_schedule, m.fees_enabled) is null
          or abs(new.follow15_fee - public.radar_taker_fee(new.follow15_price, m.fee_schedule, m.fees_enabled)) > 1e-6)) then
      raise exception 'poly_bets: a version-2 follow fee is the market''s taker fee at the follow price (rate x (p x (1 - p))^exponent)';
    end if;
    if new.follow5_price is not null and (new.follow5_mid is null or abs(new.follow5_price - (new.follow5_mid + public.radar_rule('follow_cost'))) > 1e-6) then
      raise exception 'poly_bets: a version-2 follow price is the midpoint plus % (follow_cost)', public.radar_rule('follow_cost');
    end if;
    if new.follow15_price is not null and (new.follow15_mid is null or abs(new.follow15_price - (new.follow15_mid + public.radar_rule('follow_cost'))) > 1e-6) then
      raise exception 'poly_bets: a version-2 follow price is the midpoint plus % (follow_cost)', public.radar_rule('follow_cost');
    end if;
  end if;
  return new;
end $g$;
drop trigger if exists poly_bets_guard on public.poly_bets;
create trigger poly_bets_guard before insert on public.poly_bets for each row execute function public.poly_bets_guard();
select public.radar_seal(array['poly_bets']);
comment on table public.poly_bets is 'Prediction Radar: each graded bet (a position whose first buy came before the start), with its close, CLV and the price a follower could get 5 and 15 minutes later. Written once the market resolved. Append-only.';

-- ---------------------------------------------------------------- grades, versioned per run (append-only)
create table if not exists public.poly_grade_runs (
  run_id           uuid primary key,
  started_at       timestamptz not null,
  finished_at      timestamptz not null default now(),
  grading_version  text not null,
  rules            jsonb not null,
  wallets          integer not null,
  ranked           integer not null,
  top_directional  integer not null,
  note             text,
  discovery        jsonb    -- H-RADAR-02: how many wallets were screened, flagged, marked high-frequency, left ungraded, fully evaluated
);
alter table public.poly_grade_runs add column if not exists discovery jsonb;
create table if not exists public.poly_wallet_grades (
  run_id            uuid not null references public.poly_grade_runs (run_id),
  wallet            text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  graded_bets       integer not null check (graded_bets >= 0),
  wins              integer not null,
  losses            integer not null,
  pushes            integer not null,
  staked            numeric not null,
  profit            numeric not null,
  roi               numeric,
  clv_n             integer not null,
  clv_pp            numeric,
  clv_pct           numeric,
  follow5_n         integer not null,
  follow5_roi       numeric,
  follow15_n        integer not null,
  follow15_roi      numeric,
  beat_close5_rate  numeric,
  median_stake      numeric,
  style             text not null check (style in ('Directional', 'Market Maker', 'Hedger')),
  style_detail      jsonb,
  sample            text not null check (sample in ('ranked', 'small_sample')),
  radar_score       numeric,
  score_parts       jsonb,
  rank              integer check (rank is null or rank >= 1),
  top_directional   boolean not null default false,
  history_truncated boolean not null default false,
  first_bet_at      timestamptz,
  last_bet_at       timestamptz,
  high_frequency    boolean not null default false,   -- H-RADAR-02 (last, as an added column lands on a live table)
  primary key (run_id, wallet),
  check (wins + losses + pushes = graded_bets),
  check ((sample = 'ranked') = (radar_score is not null)),
  check ((sample = 'ranked') = (rank is not null)),
  check (radar_score is null or score_parts is not null),
  check (not top_directional or (style = 'Directional' and sample = 'ranked' and not history_truncated)),
  check (roi is null or staked = 0 or abs(roi - profit / staked) < 1e-4)
);
alter table public.poly_wallet_grades add column if not exists high_frequency boolean not null default false;
create index if not exists poly_wallet_grades_rank_idx on public.poly_wallet_grades (run_id, rank);
-- the sample rule is the rules' own, not the writer's
create or replace function public.poly_wallet_grades_guard()
returns trigger language plpgsql as $g$
begin
  if (new.graded_bets >= public.radar_rule('min_graded')) <> (new.sample = 'ranked') then
    raise exception 'poly_wallet_grades: % graded bets is % under radar_rules() (min_graded %)', new.graded_bets,
      case when new.graded_bets >= public.radar_rule('min_graded') then 'ranked' else 'a small sample' end, public.radar_rule('min_graded');
  end if;
  -- featured (version 2): never a high-frequency wallet, and only with a Radar Score above featured_min_score
  if new.top_directional and new.high_frequency then raise exception 'poly_wallet_grades: a high-frequency wallet is never featured'; end if;
  if new.top_directional and coalesce(public.radar_rule('rules_version'), 1) >= 2 and not (new.radar_score > public.radar_rule('featured_min_score')) then
    raise exception 'poly_wallet_grades: featured needs a Radar Score above % (featured_min_score), not %', public.radar_rule('featured_min_score'), new.radar_score;
  end if;
  return new;
end $g$;
drop trigger if exists poly_wallet_grades_guard on public.poly_wallet_grades;
create trigger poly_wallet_grades_guard before insert on public.poly_wallet_grades for each row execute function public.poly_wallet_grades_guard();
select public.radar_seal(array['poly_grade_runs', 'poly_wallet_grades']);

-- one grading run, whole or not at all: the ranks run 1..n by score, at most
-- top_wallets top-graded, every wallet once, the run's rules the database's own
create or replace function public.radar_put_grades(p_run jsonb, p_grades jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare rid uuid := (p_run ->> 'run_id')::uuid; n int; nr int; nt int; bad text;
begin
  if rid is null then raise exception 'radar_put_grades: run_id is required'; end if;
  if (p_run -> 'rules') is distinct from public.radar_rules() then
    raise exception 'radar_put_grades: the run graded with rules that are not radar_rules(): refused';
  end if;
  select count(*), count(*) filter (where (g ->> 'sample') = 'ranked'), count(*) filter (where coalesce((g ->> 'top_directional')::boolean, false))
    into n, nr, nt from jsonb_array_elements(p_grades) g;
  if nt > public.radar_rule('top_wallets') then raise exception 'radar_put_grades: % top-graded wallets, more than %', nt, public.radar_rule('top_wallets'); end if;
  select string_agg(r, ', ') into bad from (
    select (g ->> 'wallet') || ' rank ' || coalesce(g ->> 'rank', 'null') as r,
           (g ->> 'rank')::int as rk, row_number() over (order by (g ->> 'radar_score')::numeric desc, (g ->> 'graded_bets')::int desc, (g ->> 'wallet') collate "C") as want
      from jsonb_array_elements(p_grades) g where (g ->> 'sample') = 'ranked') x
   where rk is distinct from want;
  if bad is not null then raise exception 'radar_put_grades: ranks must run 1..n by Radar Score: %', bad; end if;
  insert into public.poly_grade_runs (run_id, started_at, grading_version, rules, wallets, ranked, top_directional, note, discovery)
  values (rid, coalesce((p_run ->> 'started_at')::timestamptz, now()), coalesce(p_run ->> 'grading_version', 'unknown'), p_run -> 'rules', n, nr, nt, p_run ->> 'note', p_run -> 'discovery');
  insert into public.poly_wallet_grades (run_id, wallet, graded_bets, wins, losses, pushes, staked, profit, roi, clv_n, clv_pp, clv_pct, follow5_n, follow5_roi,
         follow15_n, follow15_roi, beat_close5_rate, median_stake, style, style_detail, sample, radar_score, score_parts, rank, top_directional,
         history_truncated, high_frequency, first_bet_at, last_bet_at)
  select rid, x.wallet, x.graded_bets, x.wins, x.losses, x.pushes, x.staked, x.profit, x.roi, x.clv_n, x.clv_pp, x.clv_pct, x.follow5_n, x.follow5_roi,
         x.follow15_n, x.follow15_roi, x.beat_close5_rate, x.median_stake, x.style, x.style_detail, x.sample, x.radar_score, x.score_parts, x.rank,
         coalesce(x.top_directional, false), coalesce(x.history_truncated, false), coalesce(x.high_frequency, false), x.first_bet_at, x.last_bet_at
    from jsonb_to_recordset(p_grades) as x(wallet text, graded_bets int, wins int, losses int, pushes int, staked numeric, profit numeric, roi numeric,
         clv_n int, clv_pp numeric, clv_pct numeric, follow5_n int, follow5_roi numeric, follow15_n int, follow15_roi numeric, beat_close5_rate numeric,
         median_stake numeric, style text, style_detail jsonb, sample text, radar_score numeric, score_parts jsonb, rank int, top_directional boolean,
         history_truncated boolean, high_frequency boolean, first_bet_at timestamptz, last_bet_at timestamptz);
  return jsonb_build_object('run_id', rid, 'wallets', n, 'ranked', nr, 'top_directional', nt);
end $f$;
-- the market-maker rule's inputs, one row per covered market a wallet traded
-- since p_since (lib/edgedesk_radar.js styleFromStats applies the rule)
create or replace function public.radar_style_stats(p_wallet text, p_since timestamptz)
returns setof jsonb language sql stable security definer set search_path = public, pg_temp as $f$
  select jsonb_build_object('wallet', t.wallet, 'condition_id', t.condition_id,
           'trades', count(*) filter (where t.kind = 'TRADE'),
           'bought', jsonb_build_object(
             '0', coalesce(sum(t.size) filter (where t.kind = 'TRADE' and t.side = 'BUY' and t.outcome_index = 0), 0),
             '1', coalesce(sum(t.size) filter (where t.kind = 'TRADE' and t.side = 'BUY' and t.outcome_index = 1), 0)),
           'split', coalesce(bool_or(t.kind in ('SPLIT', 'MERGE', 'CONVERSION')), false))
    from public.poly_trades t join public.poly_markets m on m.condition_id = t.condition_id
   where t.wallet = lower(p_wallet) and t.traded_at >= p_since
     and m.league in (select jsonb_array_elements_text(public.radar_rules() -> 'leagues'))
     and m.market_type in (select jsonb_array_elements_text(public.radar_rules() -> 'market_types'))
   group by t.wallet, t.condition_id
   order by t.condition_id
$f$;
-- the latest grading run: what every reader is shown
-- the grading version of the live rules: a grade and a trader page read only that version's bets
create or replace function public.radar_grading_version()
returns text language sql immutable as $s$
  select case when coalesce((public.radar_rules() ->> 'rules_version')::int, 1) >= 2 then 'radar-grade-2' else 'radar-grade-1' end
$s$;
-- the latest grading run made under the live rules' version: an H-RADAR-01 run (its top 25, negative scores and all)
-- is never shown as H-RADAR-02's featured bettors while the first version-2 grade has not run yet
create or replace function public.radar_current_run()
returns uuid language sql stable security definer set search_path = public, pg_temp as $s$
  select run_id from public.poly_grade_runs
   where coalesce((rules ->> 'rules_version')::int, 1) = coalesce((public.radar_rules() ->> 'rules_version')::int, 1)
   order by finished_at desc, run_id limit 1
$s$;

-- grades and the runs are readable by anyone, once Radar is on and registered (RLS)
do $p$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'poly_wallet_grades' and policyname = 'radar_grades_public') then
    create policy radar_grades_public on public.poly_wallet_grades for select to anon, authenticated using (public.radar_enabled() and public.radar_registered());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'poly_grade_runs' and policyname = 'radar_runs_public') then
    create policy radar_runs_public on public.poly_grade_runs for select to anon, authenticated using (public.radar_enabled() and public.radar_registered());
  end if;
end $p$;
grant select on public.poly_wallet_grades to anon, authenticated;
grant select on public.poly_grade_runs to anon, authenticated;

-- ---------------------------------------------------------------- holders and prices (append-only)
create table if not exists public.poly_holder_snapshots (
  id             bigint generated always as identity primary key,
  run_id         uuid not null,
  captured_at    timestamptz not null,
  condition_id   text not null references public.poly_markets (condition_id),
  token_id       text not null,
  outcome_index  integer not null,
  wallet         text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  shares         numeric not null check (shares > 0),
  avg_price      numeric check (avg_price is null or (avg_price >= 0 and avg_price <= 1)),
  cost           numeric,
  pnl            numeric
);
create unique index if not exists poly_holder_snapshots_once_idx on public.poly_holder_snapshots (run_id, condition_id, token_id, wallet);
create index if not exists poly_holder_snapshots_cond_idx on public.poly_holder_snapshots (condition_id, captured_at desc);
create table if not exists public.poly_price_snapshots (
  id             bigint generated always as identity primary key,
  run_id         uuid not null,
  captured_at    timestamptz not null,
  condition_id   text not null references public.poly_markets (condition_id),
  token_id       text not null,
  outcome_index  integer not null,
  price          numeric not null check (price >= 0 and price <= 1),
  source         text not null check (source in ('gamma_outcome_prices', 'clob_midpoint', 'clob_price'))
);
create unique index if not exists poly_price_snapshots_once_idx on public.poly_price_snapshots (run_id, token_id);
create index if not exists poly_price_snapshots_token_idx on public.poly_price_snapshots (token_id, captured_at desc);
select public.radar_seal(array['poly_holder_snapshots', 'poly_price_snapshots']);

-- ---------------------------------------------------------------- runs and alerts (append-only)
create table if not exists public.poly_sync_runs (
  run_id       uuid primary key,
  mode         text not null check (mode in ('tonight', 'pool', 'wallets', 'grade', 'markets')),
  trigger      text not null default 'manual',
  status       text not null check (status in ('ok', 'warn', 'error', 'skipped')),
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  requests     integer not null default 0,
  message      text,
  details      jsonb not null default '{}'::jsonb
);
create index if not exists poly_sync_runs_finished_idx on public.poly_sync_runs (mode, finished_at desc);
create table if not exists public.poly_alerts (
  id          bigint generated always as identity primary key,
  run_id      uuid,
  severity    text not null check (severity in ('FAILURE', 'DEGRADED', 'DRIFT', 'WARNING')),
  code        text not null,
  message     text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
select public.radar_seal(array['poly_sync_runs', 'poly_alerts']);

-- ---------------------------------------------------------------- readers
-- a subscriber is whoever public.signals admits (has_active_sub()); without
-- that function nobody but the service role sees Smart Money Tonight
create or replace function public.radar_is_subscriber()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $s$
declare v boolean := false;
begin
  if to_regprocedure('public.has_active_sub()') is null then return false; end if;
  execute 'select public.has_active_sub()' into v;
  return coalesce(v, false);
exception when others then return false;
end $s$;
-- the name a page may show: the wallet's own public name, else its address shortened
create or replace function public.radar_display(p_wallet text, p_name text, p_public boolean)
returns text language sql immutable as $d$
  select case when coalesce(p_public, false) and nullif(btrim(p_name), '') is not null then btrim(p_name)
              else substr(p_wallet, 1, 6) || '…' || substr(p_wallet, length(p_wallet) - 3) end
$d$;

-- THE STATUS, for anyone: whether Radar is on, registered, and what H-RADAR-01 found
create or replace function public.radar_status()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $s$
  select jsonb_build_object(
    'enabled', public.radar_enabled(),
    'registered', public.radar_registered(),
    'status', 'EXPERIMENTAL',
    'access', case when public.radar_is_subscriber() then 'subscriber' else 'public' end,
    'min_graded', public.radar_rule('min_graded'), 'top_wallets', public.radar_rule('top_wallets'),
    'graded_at', case when public.radar_enabled() then (select finished_at from public.poly_grade_runs where run_id = public.radar_current_run()) end,
    'h_radar_01', case when public.radar_registered() then (select value::jsonb from public.radar_config where key = 'h_radar_01_result') end,
    'as_of', now())
$s$;

-- THE LEADERBOARD, for anyone (once on and registered): every ranked wallet,
-- then the small samples, with the components always beside the score
create or replace function public.radar_leaderboard(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare rid uuid;
begin
  if not public.radar_enabled() then return jsonb_build_object('status', 'disabled', 'rows', '[]'::jsonb); end if;
  if not public.radar_registered() then return jsonb_build_object('status', 'not_registered', 'rows', '[]'::jsonb); end if;
  rid := public.radar_current_run();
  if rid is null then return jsonb_build_object('status', 'not_graded', 'rows', '[]'::jsonb); end if;
  return jsonb_build_object('status', 'ok', 'run_id', rid, 'graded_at', (select finished_at from public.poly_grade_runs where run_id = rid),
    'radar_score_status', 'EXPERIMENTAL', 'min_graded', public.radar_rule('min_graded'), 'top_wallets', public.radar_rule('top_wallets'),
    'rows', coalesce((select jsonb_agg(r order by r.ord, r.rank nulls last, r.graded_bets desc, r.wallet) from (
      select case when g.sample = 'ranked' then 0 else 1 end as ord, g.rank, g.wallet,
             public.radar_display(g.wallet, w.display_name, w.display_public) as display,
             g.style, g.sample, g.graded_bets, g.wins, g.losses, g.pushes, round(g.roi, 4) as roi, round(g.clv_pp, 2) as clv_pp,
             round(g.clv_pct, 4) as clv_pct, g.follow5_n, round(g.follow5_roi, 4) as follow5_roi, g.follow15_n, round(g.follow15_roi, 4) as follow15_roi,
             round(g.beat_close5_rate, 4) as beat_close5_rate, g.radar_score, g.score_parts, g.top_directional, g.history_truncated, g.high_frequency
        from public.poly_wallet_grades g left join public.poly_wallets w on w.wallet = g.wallet
       where g.run_id = rid
       order by case when g.sample = 'ranked' then 0 else 1 end, g.rank nulls last, g.graded_bets desc, g.wallet
       limit greatest(1, least(coalesce(p_limit, 100), 500))) r), '[]'::jsonb));
end $f$;

-- ONE TRADER, for anyone (once on and registered): the grade, and every graded
-- bet with its transactions. Open positions on games not yet started are the
-- terminal's (Smart Money Tonight's), so only a subscriber gets them.
create or replace function public.radar_trader(p_wallet text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare w text := lower(btrim(coalesce(p_wallet, ''))); rid uuid; sub boolean := public.radar_is_subscriber(); g jsonb;
begin
  if not public.radar_enabled() then return jsonb_build_object('status', 'disabled'); end if;
  if not public.radar_registered() then return jsonb_build_object('status', 'not_registered'); end if;
  if w !~ '^0x[0-9a-f]{40}$' then return jsonb_build_object('status', 'bad_wallet'); end if;
  rid := public.radar_current_run();
  select to_jsonb(x) into g from (
    select gr.*, public.radar_display(gr.wallet, pw.display_name, pw.display_public) as display
      from public.poly_wallet_grades gr left join public.poly_wallets pw on pw.wallet = gr.wallet
     where gr.run_id = rid and gr.wallet = w) x;
  if g is null then return jsonb_build_object('status', 'not_graded', 'wallet', w); end if;
  g := g - 'run_id';
  return jsonb_build_object('status', 'ok', 'access', case when sub then 'subscriber' else 'public' end, 'radar_score_status', 'EXPERIMENTAL',
    'min_graded', public.radar_rule('min_graded'), 'grade', g,
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'condition_id', b.condition_id, 'question', b.question, 'league', b.league, 'market_type', b.market_type, 'outcome', b.outcome, 'line', b.line,
        'game_start_at', b.game_start_at, 'entry_at', b.entry_at, 'entry_price', b.entry_price, 'stake', round(b.stake, 2), 'result', b.result,
        'profit', round(b.profit, 2), 'close_price', b.close_price, 'clv_pp', b.clv_pp, 'follow5_price', b.follow5_price, 'follow5_roi', round(b.follow5_roi, 4),
        'follow15_roi', round(b.follow15_roi, 4), 'entry_tx', b.entry_tx, 'txs', to_jsonb(b.txs)) order by b.entry_at desc)
      from (select * from public.poly_bets where wallet = w and grading_version = public.radar_grading_version() order by entry_at desc limit 500) b), '[]'::jsonb),
    'positions', case when not sub then null else coalesce((
      select jsonb_agg(jsonb_build_object('condition_id', h.condition_id, 'question', m.question, 'outcome', m.outcomes ->> h.outcome_index,
               'event_id', m.event_id, 'game_start_at', m.game_start_at, 'shares', h.shares, 'avg_price', h.avg_price, 'cost', round(h.cost, 2),
               'captured_at', h.captured_at) order by m.game_start_at)
        from public.poly_holder_snapshots h join public.poly_markets m on m.condition_id = h.condition_id
       where h.wallet = w and m.game_start_at > now()
         and h.run_id = (select h2.run_id from public.poly_holder_snapshots h2 where h2.condition_id = h.condition_id order by h2.captured_at desc, h2.run_id limit 1)
         and h.captured_at > now() - make_interval(mins => public.radar_rule('holders_fresh_min')::int)), '[]'::jsonb) end,
    'positions_locked', not sub);
end $f$;

-- SMART MONEY TONIGHT, computed once, here: one card per upcoming EdgeDesk game
-- with a matched Polymarket market that top-graded directional wallets hold.
-- The card's side is the side most of them are on (then the most dollars);
-- a game with none of them gets no card. Internal: the doors call it.
create or replace function public.radar_tonight_cards()
returns setof jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare rid uuid := public.radar_current_run(); fresh interval := make_interval(mins => public.radar_rule('holders_fresh_min')::int);
        horizon interval := make_interval(hours => public.radar_rule('upcoming_hours')::int); hi numeric := public.radar_rule('conviction_high_x');
        moved numeric := public.radar_rule('moved_min'); fair_age interval := make_interval(mins => public.radar_rule('fair_max_age_min')::int);
begin
  if rid is null then return; end if;
  return query
  with top as (
    select g.wallet, g.rank, g.radar_score, g.median_stake, public.radar_display(g.wallet, w.display_name, w.display_public) as display
      from public.poly_wallet_grades g left join public.poly_wallets w on w.wallet = g.wallet
     where g.run_id = rid and g.top_directional
  ), mk as (
    select m.* from public.poly_markets m
     where m.event_id is not null and m.game_start_at > now() and m.game_start_at <= now() + horizon
  ), snap as (
    -- each market's latest holders run, if it is fresh
    select distinct on (h.condition_id) h.condition_id, h.run_id, h.captured_at as at
      from public.poly_holder_snapshots h join mk on mk.condition_id = h.condition_id
     where h.captured_at > now() - fresh
     order by h.condition_id, h.captured_at desc, h.run_id
  ), held as (
    select h.condition_id, h.token_id, h.outcome_index, h.wallet, h.shares, h.avg_price, coalesce(h.cost, h.shares * h.avg_price) as cost, s.at as captured_at,
           t.rank, t.display, t.median_stake
      from public.poly_holder_snapshots h join snap s on s.condition_id = h.condition_id and s.run_id = h.run_id
      join top t on t.wallet = h.wallet
  ), sides as (
    select condition_id, outcome_index, min(token_id) as token_id, count(*)::int as n_wallets, sum(cost) as dollars, sum(shares) as shares,
           case when sum(shares) > 0 and bool_and(avg_price is not null) then sum(cost) / sum(shares) end as avg_entry, max(captured_at) as captured_at,
           jsonb_agg(jsonb_build_object('wallet', wallet, 'display', display, 'rank', rank, 'cost', round(cost, 2), 'avg_price', avg_price, 'shares', shares,
             'conviction', case when median_stake > 0 and cost is not null then round(cost / median_stake, 2) end,
             'high_conviction', median_stake > 0 and cost is not null and cost / median_stake >= hi) order by cost desc nulls last, rank) as wallets,
           count(*) filter (where median_stake > 0 and cost is not null and cost / median_stake >= hi)::int as high_conviction
      from held group by condition_id, outcome_index
  ), ranked as (
    select s.*, m.event_id, m.sport_key, m.market_type, m.question, m.game_start_at, m.sides -> s.outcome_index as side, m.outcomes ->> s.outcome_index as outcome,
           row_number() over (partition by m.event_id order by s.n_wallets desc, s.dollars desc nulls last, s.condition_id, s.outcome_index) as pos,
           (select coalesce(sum(o.n_wallets), 0) from sides o where o.condition_id = s.condition_id and o.outcome_index <> s.outcome_index)::int as other_wallets,
           (select sum(o.dollars) from sides o where o.condition_id = s.condition_id and o.outcome_index <> s.outcome_index) as other_dollars
      from sides s join mk m on m.condition_id = s.condition_id
  )
  select jsonb_build_object(
      'event_id', r.event_id, 'sport_key', r.sport_key, 'condition_id', r.condition_id, 'token_id', r.token_id, 'market_type', r.market_type,
      'question', r.question, 'outcome', r.outcome, 'selection', r.side ->> 'selection', 'point', (r.side ->> 'point')::numeric,
      'home_team', ev.home_team, 'away_team', ev.away_team, 'commence_time', coalesce(ev.commence_time, r.game_start_at),
      'n_wallets', r.n_wallets, 'dollars', round(r.dollars, 2), 'avg_entry', round(r.avg_entry, 4),
      'current_price', px.price, 'price_at', px.captured_at,
      'moved', case when px.price is null or r.avg_entry is null then null else round(px.price - r.avg_entry, 4) end,
      'has_moved', case when px.price is null or r.avg_entry is null then null else abs(px.price - r.avg_entry) >= moved end,
      'fair', fr.sharp_fair, 'fair_seen_at', fr.last_seen_at, 'fair_current', fr.last_seen_at is not null and fr.last_seen_at > now() - fair_age,
      'agrees', case when fr.sharp_fair is null or px.price is null or not coalesce(fr.last_seen_at > now() - fair_age, false) then null else fr.sharp_fair >= px.price end,
      'other_side_wallets', r.other_wallets, 'other_side_dollars', round(r.other_dollars, 2),
      'high_conviction', r.high_conviction, 'wallets', r.wallets, 'holders_at', r.captured_at)
    from ranked r
    left join lateral (select s.home_team, s.away_team, s.commence_time from public.signals s where s.event_id = r.event_id order by s.commence_time desc nulls last limit 1) ev on true
    left join lateral (select p.price, p.captured_at from public.poly_price_snapshots p where p.token_id = r.token_id and p.captured_at > now() - fresh order by p.captured_at desc limit 1) px on true
    left join lateral (select s.sharp_fair, s.last_seen_at from public.signals s where s.sig_key = r.side ->> 'sig_key' limit 1) fr on true
   where r.pos = 1
   order by r.n_wallets desc, r.dollars desc nulls last, r.event_id;
end $f$;

-- OBSERVED ACTIVITY (H-RADAR-02), apart from the featured cards: what the other fully evaluated pool wallets
-- graded this run hold on tonight's games, side by side, counted and summed. Observed, never a signal: no
-- wallet is named and no side is called smart. A high-frequency wallet or a market maker is never in it: their
-- positions are inventory, not a view, and would not be represented accurately. Internal: the door calls it.
create or replace function public.radar_observed_cards()
returns setof jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare rid uuid := public.radar_current_run(); fresh interval := make_interval(mins => public.radar_rule('holders_fresh_min')::int);
        horizon interval := make_interval(hours => public.radar_rule('upcoming_hours')::int);
begin
  if rid is null then return; end if;
  return query
  with tracked as (
    select g.wallet from public.poly_wallet_grades g where g.run_id = rid and not g.top_directional and not g.high_frequency and g.style <> 'Market Maker'
  ), mk as (
    select m.* from public.poly_markets m
     where m.event_id is not null and m.game_start_at > now() and m.game_start_at <= now() + horizon
  ), snap as (
    select distinct on (h.condition_id) h.condition_id, h.run_id, h.captured_at as at
      from public.poly_holder_snapshots h join mk on mk.condition_id = h.condition_id
     where h.captured_at > now() - fresh
     order by h.condition_id, h.captured_at desc, h.run_id
  ), held as (
    select h.condition_id, h.outcome_index, coalesce(h.cost, h.shares * h.avg_price) as cost, s.at
      from public.poly_holder_snapshots h join snap s on s.condition_id = h.condition_id and s.run_id = h.run_id
      join tracked t on t.wallet = h.wallet
  ), sides as (
    select condition_id, outcome_index, count(*)::int as n_wallets, sum(cost) as dollars, max(at) as at from held group by condition_id, outcome_index
  ), markets as (
    select m.event_id, m.condition_id, m.market_type, m.question, m.game_start_at, sum(s.n_wallets)::int as n_wallets, max(s.at) as at,
           jsonb_agg(jsonb_build_object('outcome', m.outcomes ->> s.outcome_index, 'selection', m.sides -> s.outcome_index ->> 'selection',
             'point', (m.sides -> s.outcome_index ->> 'point')::numeric, 'n_wallets', s.n_wallets, 'dollars', round(s.dollars, 2))
             order by s.n_wallets desc, s.dollars desc nulls last, s.outcome_index) as sides,
           row_number() over (partition by m.event_id order by sum(s.n_wallets) desc, m.condition_id) as pos
      from sides s join mk m on m.condition_id = s.condition_id
     group by m.event_id, m.condition_id, m.market_type, m.question, m.game_start_at
  )
  select jsonb_build_object('kind', 'observed', 'event_id', x.event_id, 'condition_id', x.condition_id, 'market_type', x.market_type, 'question', x.question,
      'home_team', ev.home_team, 'away_team', ev.away_team, 'commence_time', coalesce(ev.commence_time, x.game_start_at),
      'n_wallets', x.n_wallets, 'sides', x.sides, 'holders_at', x.at)
    from markets x
    left join lateral (select s.home_team, s.away_team, s.commence_time from public.signals s where s.event_id = x.event_id order by s.commence_time desc nulls last limit 1) ev on true
   where x.pos = 1
   order by x.n_wallets desc, x.event_id;
end $f$;

-- THE SYNC STATE, for the page: whether what Smart Money Tonight shows is current, so "the sync is pending",
-- "the sync failed" and "no featured bettor holds a position right now" never read alike. Presentation only:
-- no rule in radar_rules() changes and nothing here selects a wallet. pending: no grading run under the live
-- rules yet. failed: the holders sync (every 10 minutes) last ended in error or has not succeeded for 30
-- minutes, or a grade failed after the current one, or the current one is more than 36 hours old. ok: both are
-- current, so an empty slate means no position. Internal: the door calls it.
create or replace function public.radar_sync_state()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare rid uuid := public.radar_current_run(); g_at timestamptz; h_ok timestamptz;
        h_status text; h_msg text; g_status text; g_msg text; g_fin timestamptz; st text; why text; cand int; done int;
begin
  select status, message into h_status, h_msg from public.poly_sync_runs where mode = 'tonight' order by finished_at desc limit 1;
  select max(finished_at) into h_ok from public.poly_sync_runs where mode = 'tonight' and status in ('ok', 'warn');
  select status, message, finished_at into g_status, g_msg, g_fin from public.poly_sync_runs where mode = 'grade' order by finished_at desc limit 1;
  select finished_at into g_at from public.poly_grade_runs where run_id = rid;
  select count(*) filter (where board_rank is not null), count(*) filter (where board_rank is not null and eval_status in ('evaluated', 'high_frequency', 'insufficient_history'))
    into cand, done from public.poly_wallets;
  if rid is null then st := 'pending'; why := 'first_grade';
  elsif h_status = 'error' then st := 'failed'; why := 'holders_error';
  elsif h_ok is null or h_ok < now() - interval '30 minutes' then st := 'failed'; why := 'holders_stale';
  elsif g_status = 'error' and g_fin > g_at then st := 'failed'; why := 'grade_error';
  elsif g_at < now() - interval '36 hours' then st := 'failed'; why := 'grade_stale';
  else st := 'ok'; end if;
  return jsonb_build_object('state', st, 'reason', why, 'holders_at', h_ok, 'graded_at', g_at,
    'last_error', case why when 'holders_error' then left(h_msg, 200) when 'grade_error' then left(g_msg, 200) end,
    'candidates', cand, 'evaluated', done);
end $f$;

-- the door: subscribers only, once on and registered
create or replace function public.radar_tonight()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
begin
  if not public.radar_enabled() then return jsonb_build_object('status', 'disabled', 'cards', '[]'::jsonb); end if;
  if not public.radar_registered() then return jsonb_build_object('status', 'not_registered', 'cards', '[]'::jsonb); end if;
  if not public.radar_is_subscriber() then return jsonb_build_object('status', 'subscribers_only', 'cards', '[]'::jsonb); end if;
  return jsonb_build_object('status', 'ok', 'as_of', now(), 'radar_score_status', 'EXPERIMENTAL', 'hypothesis', public.radar_hypothesis(),
    'top_wallets', public.radar_rule('top_wallets'), 'conviction_high_x', public.radar_rule('conviction_high_x'),
    'graded_at', (select finished_at from public.poly_grade_runs where run_id = public.radar_current_run()),
    -- how many wallets are featured this run (at most top_wallets; fewer when fewer qualify), and how discovery went
    'featured', (select count(*) from public.poly_wallet_grades where run_id = public.radar_current_run() and top_directional),
    'discovery', (select discovery from public.poly_grade_runs where run_id = public.radar_current_run()),
    'cards', coalesce((select jsonb_agg(c) from public.radar_tonight_cards() c), '[]'::jsonb),
    'observed', coalesce((select jsonb_agg(o) from (select o from public.radar_observed_cards() o limit 40) x), '[]'::jsonb),
    'sync', public.radar_sync_state());
end $f$;

-- THE TEASER, for anyone (the public /radar/ page): the first card's game, how
-- many top bettors and how many dollars. Never the side, a price, or a wallet:
-- those are the terminal's.
create or replace function public.radar_teaser()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare c jsonb;
begin
  if not public.radar_enabled() then return jsonb_build_object('status', 'disabled'); end if;
  if not public.radar_registered() then return jsonb_build_object('status', 'not_registered'); end if;
  select x into c from public.radar_tonight_cards() x limit 1;
  return jsonb_build_object('status', 'ok', 'hypothesis', public.radar_hypothesis(), 'games', (select count(*) from public.radar_tonight_cards()),
    'card', case when c is null then null else jsonb_build_object('sport_key', c ->> 'sport_key', 'home_team', c ->> 'home_team', 'away_team', c ->> 'away_team',
      'commence_time', c ->> 'commence_time', 'n_wallets', (c ->> 'n_wallets')::int, 'dollars', round((c ->> 'dollars')::numeric, -2)) end);
end $f$;

do $g$ begin
  -- internal: no client may call these
  execute 'revoke all on function public.radar_setting(text), public.radar_is_subscriber(), public.radar_put_grades(jsonb, jsonb), public.radar_tonight_cards(), '
       || 'public.poly_api_acquire(jsonb), public.poly_api_settle(jsonb), public.radar_current_run(), public.radar_config_audit(), '
       || 'public.radar_style_stats(text, timestamptz), public.radar_observed_cards(), public.radar_grading_version(), public.radar_hypothesis(), public.radar_sync_state() from public, anon, authenticated';
  execute 'revoke all on function public.radar_status(), public.radar_leaderboard(integer), public.radar_trader(text), public.radar_tonight(), public.radar_teaser() from public';
  execute 'revoke all on function public.radar_enabled(), public.radar_registered() from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.radar_setting(text), public.radar_is_subscriber(), public.radar_put_grades(jsonb, jsonb), public.radar_tonight_cards(), '
         || 'public.poly_api_acquire(jsonb), public.poly_api_settle(jsonb), public.radar_current_run(), public.radar_enabled(), public.radar_registered(), '
         || 'public.radar_style_stats(text, timestamptz), public.radar_observed_cards(), public.radar_grading_version(), public.radar_hypothesis(), public.radar_sync_state() to service_role';
    execute 'grant select, insert, update on public.poly_wallets, public.poly_markets, public.poly_api_days to service_role';
  end if;
end $g$;
-- the reader doors (lib/edgedesk_plans.js DOORS.anon): the database decides what each reader gets
grant execute on function public.radar_status() to anon, authenticated;
grant execute on function public.radar_leaderboard(integer) to anon, authenticated;
grant execute on function public.radar_trader(text) to anon, authenticated;
grant execute on function public.radar_tonight() to anon, authenticated;
grant execute on function public.radar_teaser() to anon, authenticated;
-- the RLS policies on the grades call these as the reader
grant execute on function public.radar_enabled() to anon, authenticated;
grant execute on function public.radar_registered() to anon, authenticated;

comment on table public.poly_wallet_grades is 'Prediction Radar: every pool wallet''s grade, one row per grading run (versioned). Readable by anyone once Radar is on and its live hypothesis (radar_hypothesis()) registered. The Radar Score is EXPERIMENTAL. Append-only.';

notify pgrst, 'reload schema';
commit;

-- THE REPORT. Every row should say ok; row 6 says pending until the owner turns Radar on, row 7 until H-RADAR-01 is registered.
select piece, state from (
  select '1 every Radar record table is append-only (update, delete and truncate refused)' as piece,
         case when (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                      and c.relname in ('radar_config_log', 'poly_api_grants', 'poly_api_settlements', 'poly_trades', 'poly_bets', 'poly_grade_runs', 'poly_wallet_grades',
                                        'poly_holder_snapshots', 'poly_price_snapshots', 'poly_sync_runs', 'poly_alerts')
                      and exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = c.relname || '_frozen')
                      and exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = c.relname || '_no_truncate')) = 11
              then 'ok' else 'CHECK THIS' end as state
  union all select '2 no trade, holder, price, pool or budget table is readable by anon or a signed-in browser',
         case when not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
               and relname in ('poly_trades', 'poly_bets', 'poly_holder_snapshots', 'poly_price_snapshots', 'poly_wallets', 'poly_markets', 'poly_api_days',
                               'poly_api_grants', 'poly_api_settlements', 'poly_sync_runs', 'poly_alerts', 'radar_config', 'radar_config_log')
               and (has_table_privilege('anon', oid, 'select') or has_table_privilege('authenticated', oid, 'select'))) then 'ok' else 'CHECK THIS' end
  union all select '3 the grades are behind RLS (readable by anyone only while Radar is on and registered)',
         case when (select relrowsecurity from pg_class where oid = 'public.poly_wallet_grades'::regclass)
                and exists (select 1 from pg_policies where tablename = 'poly_wallet_grades' and policyname = 'radar_grades_public') then 'ok' else 'CHECK THIS' end
  union all select '4 subscribers are recognised (public.has_active_sub exists)',
         case when to_regprocedure('public.has_active_sub()') is not null then 'ok' else 'CHECK THIS: without has_active_sub() nobody sees Smart Money Tonight' end
  union all select '5 the rules are one constant (radar_rules) with every key the grading reads',
         case when (select count(*) from jsonb_object_keys(public.radar_rules())) >= 33 then 'ok' else 'CHECK THIS' end
  union all select '6 POLYMARKET_DATA_ENABLED (off until Polymarket''s terms are read)',
         case when public.radar_setting('POLYMARKET_DATA_ENABLED') = 'on' then 'ok' when public.radar_setting('POLYMARKET_DATA_ENABLED') = 'off' then 'pending: off' else 'CHECK THIS' end
  union all select '7 ' || public.radar_hypothesis() || ' is registered before anything is shown (supabase/radar_registry.sql)',
         case when public.radar_registered() then 'ok' else 'pending: apply supabase/radar_registry.sql' end
) r order by 1;

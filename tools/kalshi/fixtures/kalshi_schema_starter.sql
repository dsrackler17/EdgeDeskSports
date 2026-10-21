-- EdgeDesk x Kalshi: starter schema
-- Append-only price history, same philosophy as closing-line capture.

create table if not exists kalshi_series (
  ticker        text primary key,
  title         text,
  category      text,
  categories    text[],
  tags          text[],
  frequency     text,
  tracked       boolean not null default false,  -- flip to true for series you want snapshotted
  updated_at    timestamptz not null default now()
);

create table if not exists kalshi_markets (
  ticker                    text primary key,
  event_ticker              text not null,
  series_ticker             text references kalshi_series(ticker),
  market_type               text,
  yes_sub_title             text,
  no_sub_title              text,
  rules_primary             text,
  open_time                 timestamptz,
  close_time                timestamptz,
  expected_expiration_time  timestamptz,
  status                    text,
  result                    text,
  first_seen_at             timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists kalshi_markets_event_idx on kalshi_markets (event_ticker);
create index if not exists kalshi_markets_close_idx on kalshi_markets (close_time);

-- Never updated, never deleted. One row per market per sync run.
create table if not exists kalshi_price_snapshots (
  id                 bigint generated always as identity primary key,
  ticker             text not null references kalshi_markets(ticker),
  captured_at        timestamptz not null default now(),
  minutes_to_close   numeric,
  status             text,
  yes_bid            numeric,
  yes_ask            numeric,
  no_bid             numeric,
  no_ask             numeric,
  last_price         numeric,
  yes_bid_size       numeric,
  yes_ask_size       numeric,
  volume             numeric,
  volume_24h         numeric,
  open_interest      numeric
);

create index if not exists kalshi_snap_ticker_time_idx
  on kalshi_price_snapshots (ticker, captured_at desc);

-- Midpoint and spread per snapshot. Mid is the market's implied YES probability.
create or replace view kalshi_snapshot_mid as
select
  s.*,
  case when s.yes_bid > 0 and s.yes_ask > 0 then (s.yes_bid + s.yes_ask) / 2 end as yes_mid,
  case when s.yes_bid > 0 and s.yes_ask > 0 then s.yes_ask - s.yes_bid end       as spread
from kalshi_price_snapshots s;

-- Kalshi "closing line": last snapshot taken at or before close_time.
create or replace view kalshi_closing_snapshot as
select distinct on (m.ticker)
  m.ticker, m.event_ticker, m.series_ticker, m.yes_sub_title, m.close_time, m.result,
  s.captured_at, s.minutes_to_close, s.yes_bid, s.yes_ask,
  case when s.yes_bid > 0 and s.yes_ask > 0 then (s.yes_bid + s.yes_ask) / 2 end as close_mid,
  s.volume, s.open_interest
from kalshi_markets m
join kalshi_price_snapshots s on s.ticker = m.ticker
where s.captured_at <= m.close_time
order by m.ticker, s.captured_at desc;

-- Capture health: how close to close_time did the last snapshot land?
create or replace view kalshi_close_capture_health as
select
  date_trunc('day', close_time) as close_day,
  count(*)                                                   as markets_closed,
  count(*) filter (where minutes_to_close <= 10)             as captured_within_10m,
  round(100.0 * count(*) filter (where minutes_to_close <= 10) / nullif(count(*), 0), 1) as pct_within_10m
from kalshi_closing_snapshot
where close_time < now()
group by 1
order by 1 desc;

alter table kalshi_series          enable row level security;
alter table kalshi_markets         enable row level security;
alter table kalshi_price_snapshots enable row level security;
-- Service role (edge function) bypasses RLS. Add read policies later if the frontend needs them.

-- ---------------------------------------------------------------
-- Cron (run after deploying the function). Requires pg_cron + pg_net.
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY>.
-- ---------------------------------------------------------------
-- select cron.schedule('kalshi_discover_daily', '7 9 * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kalshi_sync?mode=discover',
--     headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb
--   );
-- $$);
--
-- select cron.schedule('kalshi_snapshot_5m', '*/5 * * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kalshi_sync?mode=snapshot',
--     headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb
--   );
-- $$);

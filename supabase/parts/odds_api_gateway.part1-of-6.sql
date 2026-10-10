-- odds_api_gateway -- part 1 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- odds_api_gateway — the ONE control plane for every The Odds API request.
--
-- Apply AFTER supabase/odds_api_emergency_stop.sql (its report says so if you
-- did not). Idempotent and additive: create ... if not exists, add column if
-- not exists, create or replace; a re-run changes no stored row except the
-- seed rows it owns (categories, cadence, sports), which it only inserts.
-- Paste supabase/parts/odds_api_gateway.part*-of-*.sql in order in the SQL
-- editor, or apply this file with psql. Ends in a report.
--
-- WHY (docs/odds-api-incident-2026-10/INCIDENT.md). Six call paths spent the
-- same key with six private budgets and no shared view of the account: the
-- GitHub prop capture, capture's own prop pass, capture's per-event alternate
-- ladders, capture's featured board on three schedulers, close, and
-- collective_odds_ingest. Each was "budgeted" against itself. 99,336 of
-- 100,000 credits were gone by 2026-10-10.
--
-- THE CONTRACT. supabase/functions/odds_gateway is the only code that holds
-- the provider key, and it dispatches nothing without a grant from
-- odds_api_acquire(), which, under one row lock shared by every worker:
--   1. serves a stored snapshot when one is fresh enough for the event-aware
--      cadence policy (odds_api_cadence) — zero credits;
--   2. collapses a request already in flight for the same fingerprint (sport,
--      event, markets, books, format) into that one fetch;
--   3. refuses when the breaker is off, the category or sport is disabled, the
--      provider is cooling down, this cycle's quota has not been confirmed by a
--      provider header, the monthly ceiling / emergency threshold / provider
--      reserve would be crossed, or the daily allowance's shedding level has
--      dropped the request's priority;
--   4. otherwise RESERVES a conservative upper-bound cost and returns a lease.
-- odds_api_settle() reconciles the lease against x-requests-last /
-- x-requests-used / x-requests-remaining, stores the snapshot, learns event
-- commence times, trips the breaker on quota exhaustion or a rejected key, and
-- raises alerts. Every decision — granted, cache hit, collapsed, refused — is
-- a row in odds_api_requests.
--
-- FAIL CLOSED everywhere: no config row, budget 0, an unconfirmed quota, an
-- unknown category or sport, or any error in the gateway's call to this file
-- means no provider request.
-- =============================================================================

-- ── 0. THE SWITCH (created by odds_api_emergency_stop.sql; widened here) ────
create table if not exists public.odds_api_config (
  id                 smallint primary key default 1 check (id = 1),
  odds_api_enabled   boolean not null default false,
  breaker_reason     text,
  breaker_changed_at timestamptz,
  breaker_changed_by text,
  monthly_budget     integer not null default 0,
  monthly_reserve    integer not null default 40000,
  daily_target       integer not null default 0,
  updated_at         timestamptz not null default now()
);
alter table public.odds_api_config add column if not exists prev_monthly_budget integer;
alter table public.odds_api_config add column if not exists prev_daily_target integer;
alter table public.odds_api_config add column if not exists plan_monthly_credits integer not null default 100000;
alter table public.odds_api_config add column if not exists warning_pct numeric not null default 0.50;
alter table public.odds_api_config add column if not exists critical_pct numeric not null default 0.80;
alter table public.odds_api_config add column if not exists emergency_pct numeric not null default 0.95;
alter table public.odds_api_config add column if not exists daily_overdraft_pct numeric not null default 0.25;
alter table public.odds_api_config add column if not exists day_weights jsonb not null
  default '{"0":1.5,"1":1.0,"2":0.6,"3":0.6,"4":1.0,"5":1.0,"6":1.6}'::jsonb;
alter table public.odds_api_config add column if not exists free_endpoints_enabled boolean not null default false;
alter table public.odds_api_config add column if not exists bookmakers text[] not null
  default array['pinnacle','betonlineag','draftkings','fanduel','betmgm','williamhill_us','betrivers','bovada','espnbet','hardrockbet']::text[];
alter table public.odds_api_config add column if not exists regions text not null default 'us';
alter table public.odds_api_config add column if not exists lease_seconds integer not null default 120;
alter table public.odds_api_config add column if not exists completed_after_hours numeric not null default 5;
alter table public.odds_api_config add column if not exists empty_market_recheck_minutes integer not null default 720;
alter table public.odds_api_config add column if not exists provider_requests_used integer;
alter table public.odds_api_config add column if not exists provider_requests_remaining integer;
alter table public.odds_api_config add column if not exists provider_observed_at timestamptz;
alter table public.odds_api_config add column if not exists provider_observed_source text;
alter table public.odds_api_config add column if not exists untracked_baseline integer;
alter table public.odds_api_config add column if not exists untracked_baseline_cycle date;
alter table public.odds_api_config add column if not exists provider_cooldown_until timestamptz;
alter table public.odds_api_config add column if not exists cooldown_reason text;
alter table public.odds_api_config add column if not exists consecutive_failures integer not null default 0;
alter table public.odds_api_config add column if not exists store_snapshot_bodies boolean not null default true;
alter table public.odds_api_config add column if not exists snapshot_retention_hours integer not null default 72;
alter table public.odds_api_config add column if not exists decision_retention_days integer not null default 14;
alter table public.odds_api_config add column if not exists ledger_retention_days integer not null default 400;
alter table public.odds_api_config enable row level security;
revoke all on public.odds_api_config from anon, authenticated;
insert into public.odds_api_config (id, odds_api_enabled, breaker_reason, breaker_changed_at, breaker_changed_by)
values (1, false, 'created disabled (fail closed)', now(), 'odds_api_gateway.sql')
on conflict (id) do nothing;

-- ── 1. WHAT MAY BE ASKED FOR ────────────────────────────────────────────────
-- Sports: anything not listed (or disabled) is refused, whatever CAPTURE_SPORTS
-- or /sports discovery says. Football first; MMA and MLB feed the UFC and
-- Baseball research modules and are shed before football.
create table if not exists public.odds_api_sports (
  sport_key   text primary key,
  sport_group text not null,
  enabled     boolean not null default true,
  priority    smallint not null default 1,
  label       text
);
insert into public.odds_api_sports (sport_key, sport_group, enabled, priority, label) values
  ('americanfootball_nfl', 'nfl', true, 1, 'NFL'),
  ('americanfootball_ncaaf', 'ncaaf', true, 1, 'College football'),
  ('mma_mixed_martial_arts', 'mma', true, 3, 'UFC / MMA'),
  ('baseball_mlb', 'mlb', true, 3, 'MLB')
on conflict (sport_key) do nothing;

-- Categories: what each kind of request is, what it costs, how far it can be
-- shed. `markets` is the canonical market set — a category ALWAYS asks for all
-- of it, so every caller of a category shares one fingerprint and one fetch.
create table if not exists public.odds_api_categories (
  category        text primary key,
  endpoint        text not null,
  enabled         boolean not null default false,
  priority        smallint not null default 5,
  markets         text[] not null default '{}'::text[],
  bookmakers      text[],
  default_format  text not null default 'decimal',
  cost_multiplier integer not null default 1,
  description     text
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'odds_api_categories_endpoint_chk') then
    alter table public.odds_api_categories add constraint odds_api_categories_endpoint_chk check (endpoint in
      ('odds', 'event_odds', 'events', 'sports', 'scores', 'historical_odds', 'historical_events', 'historical_event_odds'));
  end if;
end $$;
insert into public.odds_api_categories (category, endpoint, enabled, priority, markets, bookmakers, default_format, cost_multiplier, description) values
  ('featured',   'odds',       true,  1, array['h2h','spreads','totals'], null, 'decimal', 1,
   'Sport-level main markets. One call prices every upcoming event of a sport; capture, close and the research board share it.'),
  ('close',      'odds',       true,  1, array['h2h','spreads','totals'], null, 'decimal', 1,
   'Closing lines for CLV. Same fingerprint as featured, so a fresh featured snapshot serves it at zero cost.'),
  ('collective', 'odds',       true,  2, array['h2h','spreads','totals'], null, 'american', 1,
   'collective_odds_ingest when its provider is The Odds API (american prices).'),
  ('props',      'event_odds', true,  3, array['player_pass_yds','player_pass_attempts','player_pass_completions','player_pass_tds',
     'player_pass_interceptions','player_rush_yds','player_rush_attempts','player_reception_yds','player_receptions',
     'player_rush_reception_yds','player_anytime_td'],
   array['draftkings','fanduel','betmgm','williamhill_us','espnbet','betrivers','hardrockbet','fanatics','pinnacle','betonlineag'],
   'american', 1, 'Core player props the props board, projections and grades use. One request per event.'),
  ('props_extra', 'event_odds', false, 5, array['player_pass_longest_completion','player_rush_longest','player_reception_longest'],
   array['draftkings','fanduel','betmgm','williamhill_us','espnbet','betrivers','hardrockbet','fanatics','pinnacle','betonlineag'],
   'american', 1, 'Secondary player markets. Off by default.'),
  ('props_alt',  'event_odds', false, 5, array['player_pass_yds_alternate','player_rush_yds_alternate','player_reception_yds_alternate',
     'player_receptions_alternate','player_rush_reception_yds_alternate','player_pass_tds_alternate'],
   array['draftkings','fanduel','betmgm','williamhill_us','espnbet','betrivers','hardrockbet','fanatics','pinnacle','betonlineag'],
   'american', 1, 'Alternate player ladders. Off by default.'),
  ('alternates', 'event_odds', true,  4, array['alternate_spreads','alternate_totals'], null, 'decimal', 1,
   'Alternate spread / total ladders per event, inside 24 h only. First to be shed.'),
  ('sports_index', 'sports',   true,  0, '{}'::text[], null, 'decimal', 0, 'GET /v4/sports. Free.'),
  ('events_index', 'events',   true,  0, '{}'::text[], null, 'decimal', 0, 'GET /v4/sports/{sport}/events. Free.'),
  ('scores',     'scores',     false, 6, '{}'::text[], null, 'decimal', 2, 'GET /scores. 1 credit, 2 with daysFrom. Unused; off.'),
  ('historical_events', 'historical_events', false, 9, '{}'::text[], null, 'american', 1, 'Historical event list. Off.'),
  ('historical_props', 'historical_event_odds', false, 9, array['player_pass_yds','player_pass_tds','player_pass_completions',
     'player_pass_attempts','player_pass_interceptions','player_rush_yds','player_rush_attempts','player_reception_yds',
     'player_receptions','player_anytime_td','player_pass_rush_yds','player_rush_reception_yds','player_reception_longest',
     'player_rush_longest','player_pass_longest_completion','player_reception_tds','player_rush_tds'],
   array['draftkings','fanduel','betmgm','williamhill_us','espnbet','betrivers','hardrockbet','fanatics','pinnacle','bovada'],
   'american', 10, 'Historical props backfill at 10x. Never part of normal polling; off.')
on conflict (category) do nothing;

-- The event-aware cadence: the LONGEST a snapshot is reused before a refresh
-- MAY be bought — an upper frequency limit, never a schedule. Rows are read in
-- order of max_hours_to_start; the first row whose bound covers the event's
-- hours to kickoff wins. interval_minutes NULL = not polled at that distance.
-- Sport-level requests use the sport's NEAREST upcoming event. Live and
-- completed events are never polled (odds_api_acquire).
create table if not exists public.odds_api_cadence (
  category           text not null,
  sport_group        text not null default '*',
  max_hours_to_start numeric not null,
  interval_minutes   integer,
  primary key (category, sport_group, max_hours_to_start)
);
insert into public.odds_api_cadence (category, sport_group, max_hours_to_start, interval_minutes) values
  ('featured', '*', 3, 20), ('featured', '*', 24, 60), ('featured', '*', 72, 120), ('featured', '*', 1000000, 360),
  ('close', '*', 3, 20), ('close', '*', 24, 60), ('close', '*', 72, 120), ('close', '*', 1000000, 360),
  ('collective', '*', 3, 20), ('collective', '*', 24, 60), ('collective', '*', 72, 120), ('collective', '*', 1000000, 360),
  ('props', 'nfl', 3, 60), ('props', 'nfl', 24, 120), ('props', 'nfl', 48, 360), ('props', 'nfl', 1000000, null),
  ('props', 'ncaaf', 3, 60), ('props', 'ncaaf', 24, 180), ('props', 'ncaaf', 1000000, null),
  ('props', '*', 1000000, null),
  ('props_extra', '*', 3, 120), ('props_extra', '*', 24, 360), ('props_extra', '*', 1000000, null),
  ('props_alt', '*', 3, 120), ('props_alt', '*', 24, 360), ('props_alt', '*', 1000000, null),
  ('alternates', '*', 3, 120), ('alternates', '*', 24, 360), ('alternates', '*', 1000000, null),
  ('sports_index', '*', 1000000, 60), ('events_index', '*', 1000000, 60),
  ('scores', '*', 1000000, 60),
  ('historical_events', '*', 1000000, 525600), ('historical_props', '*', 1000000, 525600)
on conflict (category, sport_group, max_hours_to_start) do nothing;

-- ── 2. THE LEDGER: one row per gateway decision ─────────────────────────────
create table if not exists public.odds_api_requests (
  id                 bigserial primary key,
  created_at         timestamptz not null default now(),
  cycle_start        date not null,
  usage_day          date not null,
  caller             text not null,
  trigger            text,
  category           text,
  sport_key          text,
  event_id           text,
  endpoint           text,
  markets            text[],
  selection          text,
  odds_format        text,
  region_equivalents integer,
  fingerprint        text,
  decision           text not null,
  reason             text,
  dispatched         boolean not null default false,
  status             text not null,
  priority           smallint,
  shed_level         smallint,
  hours_to_start     numeric,
  interval_minutes   numeric,
  reserved_credits   integer not null default 0,
  actual_credits     integer,
  cost_is_exact      boolean,
  http_status        integer,
  requests_used      integer,
  requests_remaining integer,
  requests_last      integer,
  attempt            smallint not null default 1,
  parent_request_id  bigint,
  served_request_id  bigint,
  duration_ms        integer,
  error              text,
  lease_expires_at   timestamptz,
  settled_at         timestamptz
);
create index if not exists odds_api_requests_cycle_idx on public.odds_api_requests (cycle_start) where dispatched;
create index if not exists odds_api_requests_day_idx on public.odds_api_requests (usage_day, caller);
create index if not exists odds_api_requests_open_idx on public.odds_api_requests (fingerprint, lease_expires_at) where status = 'reserved';
create index if not exists odds_api_requests_recent_idx on public.odds_api_requests (created_at desc);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'odds_api_requests_status_chk') then
    alter table public.odds_api_requests add constraint odds_api_requests_status_chk
      check (status in ('reserved', 'settled', 'failed', 'expired', 'not_dispatched'));
  end if;
end $$;
alter table public.odds_api_requests enable row level security;
revoke all on public.odds_api_requests from anon, authenticated;

-- ── 3. THE SNAPSHOT STORE: the latest successful answer per fingerprint ─────
create table if not exists public.odds_api_snapshots (
  fingerprint         text primary key,
  category            text,
  sport_key           text,
  event_id            text,
  endpoint            text,
  markets             text[],
  selection           text,
  odds_format         text,
  last_request_id     bigint,
  last_attempt_at     timestamptz,
  last_status         text,
  last_http_status    integer,
  last_success_at     timestamptz,
  body                jsonb,
  events_count        integer,
  markets_returned    integer,
  bookmakers_returned integer,
  cost_last           integer,
  updated_at          timestamptz not null default now()
);
create index if not exists odds_api_snapshots_sport_idx on public.odds_api_snapshots (sport_key, category, last_success_at desc);
alter table public.odds_api_snapshots enable row level security;
revoke all on public.odds_api_snapshots from anon, authenticated;

-- Commence times learned from responses: the cadence's clock, for free.
create table if not exists public.odds_api_events (
  event_id      text primary key,
  sport_key     text not null,
  commence_time timestamptz not null,
  home_team     text,
  away_team     text,
  last_seen_at  timestamptz not null default now()
);
create index if not exists odds_api_events_sport_idx on public.odds_api_events (sport_key, commence_time);
alter table public.odds_api_events enable row level security;
revoke all on public.odds_api_events from anon, authenticated;

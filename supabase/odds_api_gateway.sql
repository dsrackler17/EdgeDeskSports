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

create table if not exists public.odds_api_alerts (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  cycle_start     date,
  level           text not null,
  code            text not null,
  message         text not null,
  details         jsonb,
  acknowledged_at timestamptz,
  acknowledged_by text
);
alter table public.odds_api_alerts add column if not exists alert_day date not null default ((now() at time zone 'utc')::date);
-- One alert per code per cycle per day: a hot loop raises it once, not a thousand times.
create unique index if not exists odds_api_alerts_once_idx on public.odds_api_alerts (code, cycle_start, alert_day);
alter table public.odds_api_alerts enable row level security;
revoke all on public.odds_api_alerts from anon, authenticated;

-- One holder per job at a time: an overlapping cron run of the same job skips.
create table if not exists public.odds_api_job_locks (
  job         text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table public.odds_api_job_locks enable row level security;
revoke all on public.odds_api_job_locks from anon, authenticated;

-- ── 4. HELPERS ──────────────────────────────────────────────────────────────
create or replace function public.odds_api_cycle_start(p_at timestamptz default now())
returns date language sql stable as $$ select date_trunc('month', p_at at time zone 'utc')::date $$;

create or replace function public.odds_api_sorted(p text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct m order by m), '{}'::text[])
  from unnest(coalesce(p, '{}'::text[])) m where m is not null and m <> ''
$$;

create or replace function public.odds_api_fingerprint(p_endpoint text, p_sport text, p_event text, p_markets text[],
  p_selection text, p_format text, p_date text)
returns text language sql immutable as $$
  select md5(concat_ws('|', coalesce(p_endpoint, ''), coalesce(p_sport, ''), coalesce(p_event, ''),
    array_to_string(public.odds_api_sorted(p_markets), ','), coalesce(p_selection, ''), coalesce(p_format, ''), coalesce(p_date, '')))
$$;

create or replace function public.odds_api_day_weight(p_weights jsonb, p_day date)
returns numeric language sql immutable as $$
  select coalesce(nullif(p_weights->>(extract(dow from p_day)::int::text), '')::numeric, 1)
$$;

-- A caller holding the service role, or a direct database session (the SQL
-- editor, psql with the database URL). Never a signed-in browser.
create or replace function public.odds_api_privileged()
returns boolean language plpgsql stable as $$
declare v text;
begin
  begin v := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role'; exception when others then v := null; end;
  if v = 'service_role' then return true; end if;
  return session_user not in ('authenticator', 'anon', 'authenticated');
end $$;

-- The business consoles' operator list (billing_is_admin, else the partner
-- program's), checked against the caller's own token.
create or replace function public.odds_api_is_admin()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean := false;
begin
  if to_regprocedure('public.billing_is_admin()') is not null then
    execute 'select public.billing_is_admin()' into v; return coalesce(v, false);
  end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v; return coalesce(v, false);
  end if;
  return false;
exception when others then return false;
end $$;

create or replace function public.odds_api_alert(p_level text, p_code text, p_message text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.odds_api_alerts (cycle_start, level, code, message, details)
  values (public.odds_api_cycle_start(now()), p_level, p_code, left(p_message, 600), p_details)
  on conflict (code, cycle_start, alert_day) do nothing;
end $$;

-- Trip the breaker from inside the gateway: latching, so turning paid
-- retrieval back on is always a deliberate operator act.
create or replace function public.odds_api_trip(p_reason text, p_by text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.odds_api_config set odds_api_enabled = false, breaker_reason = left(p_reason, 300),
         breaker_changed_at = now(), breaker_changed_by = left(p_by, 120), updated_at = now()
   where id = 1 and odds_api_enabled;
  if found then perform public.odds_api_alert('emergency', 'breaker_tripped', p_reason, jsonb_build_object('by', p_by)); end if;
end $$;

-- ── 5. THE BUDGET PICTURE ───────────────────────────────────────────────────
-- Spend this cycle is the larger of what the ledger reserved/settled and what
-- the provider's own x-requests-used says (plus leases still open), so usage
-- outside the gateway still counts. The daily allowance paces what is left of
-- the monthly budget over the days left, weighted toward football days, and
-- never above daily_target x today's weight.
create or replace function public.odds_api_budget_state(p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.odds_api_config;
  v_cycle date := public.odds_api_cycle_start(p_now);
  v_next date := (public.odds_api_cycle_start(p_now) + interval '1 month')::date;
  v_today date := (p_now at time zone 'utc')::date;
  v_cycle_ts timestamptz := (public.odds_api_cycle_start(p_now)::timestamp at time zone 'utc');
  v_next_ts timestamptz := ((public.odds_api_cycle_start(p_now) + interval '1 month')::timestamp at time zone 'utc');
  v_ledger bigint; v_today_spent bigint; v_open bigint; v_spent bigint; v_rem bigint; v_confirmed boolean;
  v_wt numeric; v_ws numeric; v_before bigint; v_allow integer; v_elapsed numeric; v_proj numeric; v_pct numeric;
begin
  select * into c from public.odds_api_config where id = 1;
  if not found then return jsonb_build_object('configured', false); end if;
  select coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where cycle_start = v_cycle), 0),
         coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where usage_day = v_today), 0),
         coalesce(sum(reserved_credits) filter (where status = 'reserved'), 0)
    into v_ledger, v_today_spent, v_open
    from public.odds_api_requests where dispatched and (cycle_start = v_cycle or status = 'reserved');
  v_confirmed := c.provider_observed_at is not null and c.provider_observed_at >= v_cycle_ts;
  if v_confirmed then
    v_spent := greatest(v_ledger, coalesce(c.provider_requests_used, 0) + v_open);
    v_rem := coalesce(c.provider_requests_remaining, 0) - v_open;
  else
    v_spent := v_ledger; v_rem := null;
  end if;
  v_before := greatest(0, v_spent - v_today_spent);
  v_wt := public.odds_api_day_weight(c.day_weights, v_today);
  select coalesce(sum(public.odds_api_day_weight(c.day_weights, d::date)), 1) into v_ws
    from generate_series(v_today::timestamp, (v_next - 1)::timestamp, interval '1 day') d;
  v_allow := floor(greatest(0, least(c.daily_target * v_wt,
               greatest(0, c.monthly_budget - v_before) * v_wt / greatest(v_ws, 0.0001))))::int;
  v_elapsed := extract(epoch from (p_now - v_cycle_ts)) / extract(epoch from (v_next_ts - v_cycle_ts));
  v_proj := case when v_elapsed >= 0.02 then round(v_spent / v_elapsed) end;
  v_pct := case when c.monthly_budget > 0 then round(v_spent::numeric / c.monthly_budget, 4) end;
  return jsonb_build_object(
    'configured', true, 'cycle_start', v_cycle, 'next_reset', v_next_ts, 'today', v_today,
    'monthly_budget', c.monthly_budget, 'monthly_reserve', c.monthly_reserve, 'daily_target', c.daily_target,
    'spent_cycle', v_spent, 'spent_cycle_ledger', v_ledger, 'spent_today', v_today_spent, 'open_reservations', v_open,
    'budget_used_pct', v_pct, 'budget_remaining', greatest(0, c.monthly_budget - v_spent),
    'quota_confirmed', v_confirmed, 'provider_used', c.provider_requests_used, 'provider_remaining', c.provider_requests_remaining,
    'provider_remaining_effective', v_rem, 'provider_observed_at', c.provider_observed_at,
    'day_weight', v_wt, 'daily_allowance', v_allow, 'projected_cycle', v_proj,
    'warning_at', floor(c.warning_pct * c.monthly_budget), 'critical_at', floor(c.critical_pct * c.monthly_budget),
    'emergency_at', floor(c.emergency_pct * c.monthly_budget),
    'threshold', case when c.monthly_budget <= 0 then 'no_budget'
                      when v_pct >= c.emergency_pct then 'emergency' when v_pct >= c.critical_pct then 'critical'
                      when v_pct >= c.warning_pct then 'warning' else 'normal' end);
end $$;

-- Shedding: 0 everything enabled · 1 optional (priority >= 4) off · 2 props off,
-- far events off · 3 only priority-1 main markets inside 24 h · 4 nothing paid.
-- The critical monthly threshold forces at least level 2 for the rest of the cycle.
create or replace function public.odds_api_shed_level(p_spent_today bigint, p_est integer, p_allowance integer,
  p_overdraft numeric, p_month_pct numeric, p_critical numeric)
returns smallint language sql immutable as $$
  select greatest(
    case when p_allowance is null or p_allowance <= 0 then 4
         when (p_spent_today + p_est)::numeric / p_allowance <= 0.60 then 0
         when (p_spent_today + p_est)::numeric / p_allowance <= 0.80 then 1
         when (p_spent_today + p_est)::numeric / p_allowance <= 1.00 then 2
         when (p_spent_today + p_est)::numeric / p_allowance <= 1 + p_overdraft then 3
         else 4 end,
    case when coalesce(p_month_pct, 1) >= p_critical then 2 else 0 end)::smallint
$$;

create or replace function public.odds_api_level_admits(p_level smallint, p_priority smallint, p_hours numeric)
returns boolean language sql immutable as $$
  select case p_level
    when 0 then true
    when 1 then p_priority <= 3
    when 2 then (p_priority <= 1 and coalesce(p_hours, 1e9) <= 72) or (p_priority = 2 and coalesce(p_hours, 1e9) <= 24)
    when 3 then p_priority <= 1 and coalesce(p_hours, 1e9) <= 24
    else false end
$$;

-- Under pressure the cadence stretches before anything is refused outright.
create or replace function public.odds_api_level_stretch(p_level smallint)
returns numeric language sql immutable as $$
  select (case p_level when 0 then 1 when 1 then 1.5 when 2 then 2 when 3 then 3 else 4 end)::numeric
$$;

create or replace function public.odds_api_interval(p_category text, p_group text, p_hours numeric)
returns jsonb language sql stable as $$
  with r as (
    select sport_group, max_hours_to_start, interval_minutes from public.odds_api_cadence
     where category = p_category and sport_group in (p_group, '*')
  ), g as (
    select case when exists (select 1 from r where sport_group = p_group) then p_group else '*' end as grp
  )
  select coalesce((
    select jsonb_build_object('found', true, 'interval', r.interval_minutes, 'bucket', r.max_hours_to_start)
      from r, g where r.sport_group = g.grp and coalesce(p_hours, 999999) <= r.max_hours_to_start
     order by r.max_hours_to_start limit 1), jsonb_build_object('found', false))
$$;

-- ── 6. ACQUIRE: the one door before any provider request ───────────────────
-- p: { caller, trigger, category, sport_key, event_id, odds_format,
--      max_age_seconds, commence_time (hint), date (historical), attempt,
--      parent_request_id }. Markets, books and regions are NOT the caller's to
-- choose: the category decides them, which is what lets every caller of a
-- category share one fingerprint, one snapshot and one fetch.
create or replace function public.odds_api_acquire(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.odds_api_config;
  cat public.odds_api_categories;
  sp public.odds_api_sports;
  snap public.odds_api_snapshots;
  v_now timestamptz;
  v_caller text := left(coalesce(nullif(trim(p->>'caller'), ''), 'unknown'), 80);
  v_trigger text := left(nullif(trim(p->>'trigger'), ''), 40);
  v_category text := lower(coalesce(p->>'category', ''));
  v_sport text := coalesce(p->>'sport_key', '');
  v_event text := coalesce(p->>'event_id', '');
  v_date text := nullif(p->>'date', '');
  v_max_age numeric := 0;
  v_attempt smallint := 1;
  v_parent bigint;
  v_endpoint text; v_format text; v_markets text[]; v_books text[]; v_selection text := ''; v_regeq integer;
  v_fp text; v_est integer := 0; v_priority smallint; v_group text := '*';
  v_hint timestamptz; v_commence timestamptz; v_hours numeric; v_iv jsonb; v_interval numeric; v_eff_age numeric;
  st jsonb; v_level smallint; v_level_now smallint := 0; v_stretch numeric := 1;
  v_spent_today bigint; v_allow integer; v_spent bigint; v_rem bigint; v_confirmed boolean; v_pct numeric;
  v_open_id bigint; v_id bigint; v_decision text; v_reason text; v_tripped boolean := false;
begin
  begin
    v_max_age := greatest(0, coalesce(nullif(p->>'max_age_seconds', '')::numeric, 0));
    v_attempt := greatest(1, least(5, coalesce(nullif(p->>'attempt', '')::int, 1)))::smallint;
    v_parent := nullif(p->>'parent_request_id', '')::bigint;
    v_hint := nullif(p->>'commence_time', '')::timestamptz;
  exception when others then v_hint := null;
  end;

  -- ONE LOCK FOR EVERY WORKER. The budget check and the reservation are one
  -- step: two gateways cannot both see the last credits as free.
  select * into c from public.odds_api_config where id = 1 for update;
  if not found then
    return jsonb_build_object('decision', 'denied_unconfigured', 'granted', false,
      'reason', 'odds_api_config has no row: fail closed');
  end if;
  v_now := clock_timestamp();

  -- A lease whose holder never settled is charged at its reservation.
  update public.odds_api_requests
     set status = 'expired', actual_credits = reserved_credits, cost_is_exact = false, settled_at = v_now,
         error = coalesce(error, 'lease expired before settle; charged at the reservation')
   where status = 'reserved' and lease_expires_at <= v_now;

  <<decide>>
  begin
    select * into cat from public.odds_api_categories where category = v_category;
    if not found then
      v_decision := 'denied_category'; v_reason := 'unknown category: ' || v_category; exit decide;
    end if;
    v_endpoint := cat.endpoint;
    if v_endpoint = 'sports' then
      v_sport := ''; v_event := '';
    else
      select * into sp from public.odds_api_sports where sport_key = v_sport;
      if not found or not sp.enabled then
        v_decision := 'denied_sport'; v_reason := 'sport not enabled for paid retrieval: ' || v_sport; exit decide;
      end if;
      v_group := sp.sport_group;
    end if;
    if v_endpoint in ('event_odds', 'historical_event_odds') and v_event = '' then
      v_decision := 'denied_bad_request'; v_reason := 'event_id is required for ' || v_endpoint; exit decide;
    end if;
    if v_endpoint not in ('event_odds', 'historical_event_odds') then v_event := ''; end if;
    if v_endpoint like 'historical%' and v_date is null then
      v_decision := 'denied_bad_request'; v_reason := 'historical requests need a date'; exit decide;
    end if;
    if v_endpoint not like 'historical%' then v_date := null; end if;

    v_priority := greatest(cat.priority, coalesce(sp.priority, 0));
    v_format := lower(coalesce(nullif(p->>'odds_format', ''), cat.default_format));
    if v_format not in ('decimal', 'american') then v_format := cat.default_format; end if;
    v_markets := public.odds_api_sorted(cat.markets);
    if v_endpoint in ('odds', 'event_odds', 'historical_odds', 'historical_event_odds') then
      v_books := public.odds_api_sorted(coalesce(cat.bookmakers, c.bookmakers));
      if coalesce(array_length(v_books, 1), 0) > 0 then
        v_selection := 'bookmakers:' || array_to_string(v_books, ',');
        v_regeq := greatest(1, ceil(array_length(v_books, 1) / 10.0))::int;
      else
        v_books := null;
        v_selection := 'regions:' || c.regions;
        v_regeq := greatest(1, coalesce(array_length(string_to_array(c.regions, ','), 1), 1));
      end if;
      -- UPPER BOUND: every market returned. The provider bills markets
      -- RETURNED, so settle usually gives some of this back.
      v_est := coalesce(array_length(v_markets, 1), 0) * v_regeq * greatest(cat.cost_multiplier, 1);
      if v_est <= 0 then v_decision := 'denied_bad_request'; v_reason := 'category has no markets'; exit decide; end if;
    elsif v_endpoint in ('historical_events', 'scores') then
      v_est := greatest(cat.cost_multiplier, 1);
    else
      v_est := 0;
    end if;
    v_fp := public.odds_api_fingerprint(v_endpoint, v_sport, v_event, v_markets, v_selection, v_format, v_date);
    select * into snap from public.odds_api_snapshots where fingerprint = v_fp;

    -- THE EVENT'S CLOCK, learned from earlier answers (free).
    if v_event <> '' then
      select commence_time into v_commence from public.odds_api_events where event_id = v_event;
      v_commence := coalesce(v_commence, v_hint);
    elsif v_endpoint in ('odds', 'events', 'scores') then
      select min(commence_time) into v_commence from public.odds_api_events
       where sport_key = v_sport and commence_time > v_now and last_seen_at > v_now - interval '4 days';
    end if;
    v_hours := case when v_commence is null then null else extract(epoch from (v_commence - v_now)) / 3600 end;
    if v_event <> '' and v_commence is not null and v_endpoint not like 'historical%' then
      if v_now >= v_commence + make_interval(secs => (c.completed_after_hours * 3600)::int) then
        v_decision := 'skipped_completed'; v_reason := 'event has finished: completed events are never polled'; exit decide;
      end if;
      if v_now >= v_commence then
        v_decision := 'skipped_live'; v_reason := 'event is in progress: regular odds polling stops at kickoff'; exit decide;
      end if;
    end if;

    st := public.odds_api_budget_state(v_now);
    v_spent_today := (st->>'spent_today')::bigint;
    v_allow := (st->>'daily_allowance')::int;
    v_spent := (st->>'spent_cycle')::bigint;
    v_confirmed := (st->>'quota_confirmed')::boolean;
    v_rem := nullif(st->>'provider_remaining_effective', '')::bigint;
    v_pct := case when c.monthly_budget > 0 then v_spent::numeric / c.monthly_budget end;
    v_level_now := public.odds_api_shed_level(v_spent_today, 0, v_allow, c.daily_overdraft_pct, v_pct, c.critical_pct);
    v_stretch := public.odds_api_level_stretch(v_level_now);

    v_iv := public.odds_api_interval(v_category, v_group, v_hours);
    if not coalesce((v_iv->>'found')::boolean, false) or jsonb_typeof(v_iv->'interval') is distinct from 'number' then
      v_decision := 'skipped_window'; v_reason := 'outside this category''s polling window'; exit decide;
    end if;
    v_interval := (v_iv->>'interval')::numeric;

    -- CACHE FIRST. A snapshot inside the (stretched) cadence window is the
    -- answer, whoever asks and however often.
    if snap.last_success_at is not null then
      v_eff_age := greatest(v_interval * 60 * v_stretch, v_max_age);
      if v_endpoint = 'event_odds' and coalesce(snap.markets_returned, 0) = 0 then
        v_eff_age := greatest(v_eff_age, c.empty_market_recheck_minutes * 60);
      end if;
      if v_now - snap.last_success_at < make_interval(secs => v_eff_age::double precision) then
        v_decision := 'cache_hit'; v_reason := 'stored snapshot is inside the cadence window'; exit decide;
      end if;
    end if;

    -- SINGLE FLIGHT. The same fingerprint already leased: collapse into it.
    select id into v_open_id from public.odds_api_requests
     where fingerprint = v_fp and status = 'reserved' and lease_expires_at > v_now order by id desc limit 1;
    if v_open_id is not null then
      v_decision := 'in_flight'; v_reason := 'the same request is already in flight'; exit decide;
    end if;

    if not c.odds_api_enabled and not (v_est = 0 and c.free_endpoints_enabled) then
      v_decision := 'denied_breaker'; v_reason := 'circuit breaker is off: ' || coalesce(c.breaker_reason, 'no reason recorded'); exit decide;
    end if;
    if not cat.enabled then
      v_decision := 'denied_category'; v_reason := 'category disabled: ' || v_category; exit decide;
    end if;

    if v_est > 0 then
      if c.provider_cooldown_until is not null and v_now < c.provider_cooldown_until then
        v_decision := 'denied_cooldown'; v_reason := 'provider cooling down: ' || coalesce(c.cooldown_reason, ''); exit decide;
      end if;
      if c.monthly_budget <= 0 or c.daily_target <= 0 then
        v_decision := 'denied_no_budget'; v_reason := 'paid budget is zero'; exit decide;
      end if;
      if not v_confirmed then
        v_decision := 'denied_unconfirmed_quota';
        v_reason := 'this cycle''s quota is not confirmed by a provider header yet (free quota probe, or odds_api_confirm_quota)';
        exit decide;
      end if;
      if v_spent + v_est > c.monthly_budget then
        perform public.odds_api_trip('auto: monthly paid-provider ceiling reached', 'odds_api_acquire');
        v_tripped := true; v_decision := 'denied_ceiling'; v_reason := 'monthly ceiling would be crossed: fail closed'; exit decide;
      end if;
      if v_spent + v_est > floor(c.emergency_pct * c.monthly_budget) then
        perform public.odds_api_trip(format('auto: %s%% of the monthly operational budget used', round(c.emergency_pct * 100)), 'odds_api_acquire');
        v_tripped := true; v_decision := 'denied_emergency'; v_reason := 'emergency threshold reached: breaker tripped'; exit decide;
      end if;
      if v_rem is not null and v_rem - v_est < c.monthly_reserve then
        perform public.odds_api_alert('warning', 'reserve_floor', 'A request was refused to protect the provider reserve.',
          jsonb_build_object('provider_remaining_effective', v_rem, 'reserve', c.monthly_reserve));
        v_decision := 'denied_reserve'; v_reason := 'provider reserve would be crossed'; exit decide;
      end if;
      v_level := public.odds_api_shed_level(v_spent_today, v_est, v_allow, c.daily_overdraft_pct, v_pct, c.critical_pct);
      if not public.odds_api_level_admits(v_level, v_priority, v_hours) then
        v_decision := 'denied_daily_budget';
        v_reason := format('daily shedding level %s drops priority %s (spent today %s of %s)', v_level, v_priority, v_spent_today, v_allow);
        exit decide;
      end if;
    end if;
    v_decision := 'granted';
  end decide;

  if snap.fingerprint is null and v_fp is not null then
    select * into snap from public.odds_api_snapshots where fingerprint = v_fp;
  end if;

  insert into public.odds_api_requests (cycle_start, usage_day, caller, trigger, category, sport_key, event_id, endpoint,
    markets, selection, odds_format, region_equivalents, fingerprint, decision, reason, dispatched, status, priority,
    shed_level, hours_to_start, interval_minutes, reserved_credits, attempt, parent_request_id, served_request_id,
    lease_expires_at)
  values (public.odds_api_cycle_start(v_now), (v_now at time zone 'utc')::date, v_caller, v_trigger, v_category,
    nullif(v_sport, ''), nullif(v_event, ''), v_endpoint, v_markets, nullif(v_selection, ''), v_format, v_regeq, v_fp,
    v_decision, left(v_reason, 400), v_decision = 'granted',
    case when v_decision = 'granted' then 'reserved' else 'not_dispatched' end,
    v_priority, coalesce(v_level, v_level_now), round(v_hours, 3), v_interval,
    case when v_decision = 'granted' then v_est else 0 end, v_attempt, v_parent,
    case when v_decision = 'in_flight' then v_open_id when v_decision = 'cache_hit' then snap.last_request_id end,
    case when v_decision = 'granted' then v_now + make_interval(secs => c.lease_seconds) end)
  returning id into v_id;

  return jsonb_build_object(
    'decision', v_decision, 'granted', v_decision = 'granted', 'reason', v_reason, 'request_id', v_id,
    'fingerprint', v_fp, 'category', v_category, 'endpoint', v_endpoint,
    'sport_key', nullif(v_sport, ''), 'event_id', nullif(v_event, ''), 'date', v_date,
    'markets', to_jsonb(v_markets), 'bookmakers', to_jsonb(v_books),
    'regions', case when v_selection like 'regions:%' then c.regions end,
    'odds_format', v_format, 'est_credits', v_est, 'lease_seconds', c.lease_seconds,
    'hours_to_start', round(v_hours, 2), 'interval_minutes', v_interval,
    'shed_level', coalesce(v_level, v_level_now), 'priority', v_priority,
    'in_flight_request_id', v_open_id,
    'breaker', case when c.odds_api_enabled and not v_tripped then 'on' else 'off' end,
    'snapshot', case when snap.last_success_at is not null then jsonb_build_object(
        'request_id', snap.last_request_id, 'fetched_at', snap.last_success_at,
        'age_seconds', round(extract(epoch from (v_now - snap.last_success_at))),
        'has_body', snap.body is not null, 'events_count', snap.events_count,
        'markets_returned', snap.markets_returned) end);
end $$;

-- ── 7. SETTLE: reconcile against the provider's own headers ────────────────
-- p: { request_id, ok, http_status, requests_used, requests_remaining,
--      requests_last, duration_ms, error, body, quota_exhausted }
create or replace function public.odds_api_settle(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.odds_api_config;
  r public.odds_api_requests;
  v_now timestamptz;
  v_id bigint;
  v_ok boolean;
  v_http integer; v_last integer; v_used integer; v_rem integer; v_dur integer;
  v_err text := nullif(p->>'error', '');
  v_body jsonb := p->'body';
  v_quota boolean;
  v_actual integer; v_cycle date; v_events integer; v_markets integer; v_books integer;
  v_ledger bigint; v_untracked integer; st jsonb; v_pct numeric;
begin
  begin
    v_id := nullif(p->>'request_id', '')::bigint;
    v_ok := coalesce((p->>'ok')::boolean, false);
    v_http := nullif(p->>'http_status', '')::int;
    v_last := nullif(p->>'requests_last', '')::int;
    v_used := nullif(p->>'requests_used', '')::int;
    v_rem := nullif(p->>'requests_remaining', '')::int;
    v_dur := nullif(p->>'duration_ms', '')::int;
    v_quota := coalesce((p->>'quota_exhausted')::boolean, false);
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'malformed settle payload');
  end;

  select * into c from public.odds_api_config where id = 1 for update;
  v_now := clock_timestamp();
  select * into r from public.odds_api_requests where id = v_id for update;
  if not found or r.status not in ('reserved', 'expired') then
    return jsonb_build_object('ok', false, 'reason', 'not a settleable lease');
  end if;

  -- NEVER A CREDENTIAL IN THE LEDGER, whatever an upstream error echoed.
  v_err := regexp_replace(coalesce(v_err, ''), '(api_?key)=[^&[:space:]"'']*', '\1=REDACTED', 'gi');
  -- What the provider says it charged; without the header, the reservation.
  v_actual := case when v_last is not null then greatest(v_last, 0) else r.reserved_credits end;
  update public.odds_api_requests set
    status = case when v_ok then 'settled' else 'failed' end,
    actual_credits = v_actual, cost_is_exact = v_last is not null,
    http_status = v_http, requests_used = v_used, requests_remaining = v_rem, requests_last = v_last,
    duration_ms = v_dur, error = nullif(left(v_err, 400), ''), settled_at = v_now
  where id = v_id;

  v_cycle := public.odds_api_cycle_start(v_now);
  if v_used is not null and v_rem is not null and (c.provider_observed_at is null
       or c.provider_observed_at < (v_cycle::timestamp at time zone 'utc')
       or v_used >= coalesce(c.provider_requests_used, 0)) then
    update public.odds_api_config set provider_requests_used = v_used, provider_requests_remaining = v_rem,
           provider_observed_at = v_now, provider_observed_source = left('header: ' || r.caller, 120)
     where id = 1;
    -- USAGE THE GATEWAY DID NOT SEE: the provider counting more than the
    -- ledger, beyond the cycle's baseline, means something else holds the key.
    select coalesce(sum(coalesce(actual_credits, reserved_credits)), 0) into v_ledger
      from public.odds_api_requests where dispatched and cycle_start = v_cycle;
    if c.untracked_baseline_cycle is distinct from v_cycle then
      update public.odds_api_config set untracked_baseline = v_used - v_ledger, untracked_baseline_cycle = v_cycle where id = 1;
    else
      v_untracked := (v_used - v_ledger) - coalesce(c.untracked_baseline, 0);
      if v_untracked > greatest(25, ceil(0.02 * greatest(v_used, 1))) then
        perform public.odds_api_alert('critical', 'untracked_provider_usage',
          format('The provider counts %s more credits this cycle than the gateway ledger: something is spending the key outside odds_gateway.', v_untracked),
          jsonb_build_object('provider_used', v_used, 'ledger', v_ledger, 'baseline', c.untracked_baseline));
      end if;
    end if;
  end if;

  if v_ok then
    update public.odds_api_config set consecutive_failures = 0 where id = 1;
  else
    update public.odds_api_config set consecutive_failures = consecutive_failures + 1 where id = 1;
    if v_http = 401 then
      perform public.odds_api_trip('auto: the provider rejected the key (401)', 'odds_api_settle');
    elsif v_http = 429 and (v_quota or coalesce(v_rem, 1) <= 0) then
      perform public.odds_api_trip('auto: provider quota exhausted (429)', 'odds_api_settle');
    elsif v_http = 429 then
      update public.odds_api_config set provider_cooldown_until = v_now + interval '5 minutes',
             cooldown_reason = 'provider rate limit (429)' where id = 1;
      perform public.odds_api_alert('warning', 'provider_rate_limited', 'The provider answered 429; paid calls cool down for 5 minutes.', null);
    elsif c.consecutive_failures + 1 >= 5 then
      update public.odds_api_config set provider_cooldown_until = v_now + interval '15 minutes',
             cooldown_reason = 'five consecutive provider failures' where id = 1;
      perform public.odds_api_alert('warning', 'provider_failing', 'Five consecutive provider failures; paid calls cool down for 15 minutes.', null);
    end if;
  end if;
  if v_rem is not null and v_rem <= 0 then
    perform public.odds_api_trip('auto: the provider reports zero credits remaining', 'odds_api_settle');
  end if;

  if v_ok and v_body is not null and jsonb_typeof(v_body) in ('array', 'object') then
    begin
      if jsonb_typeof(v_body) = 'array' then
        v_events := jsonb_array_length(v_body);
        select count(distinct m->>'key'), count(distinct b->>'key') into v_markets, v_books
          from jsonb_array_elements(v_body) e, jsonb_array_elements(coalesce(e->'bookmakers', '[]'::jsonb)) b,
               jsonb_array_elements(coalesce(b->'markets', '[]'::jsonb)) m;
      else
        v_events := 1;
        select count(distinct m->>'key'), count(distinct b->>'key') into v_markets, v_books
          from jsonb_array_elements(coalesce(v_body->'bookmakers', '[]'::jsonb)) b,
               jsonb_array_elements(coalesce(b->'markets', '[]'::jsonb)) m;
      end if;
    exception when others then v_markets := null; v_books := null;
    end;
    insert into public.odds_api_snapshots (fingerprint, category, sport_key, event_id, endpoint, markets, selection,
      odds_format, last_request_id, last_attempt_at, last_status, last_http_status, last_success_at, body,
      events_count, markets_returned, bookmakers_returned, cost_last, updated_at)
    values (r.fingerprint, r.category, r.sport_key, r.event_id, r.endpoint, r.markets, r.selection, r.odds_format,
      r.id, v_now, 'ok', v_http, v_now, case when c.store_snapshot_bodies then v_body end,
      v_events, v_markets, v_books, v_actual, v_now)
    on conflict (fingerprint) do update set
      category = excluded.category, last_request_id = excluded.last_request_id, last_attempt_at = excluded.last_attempt_at,
      last_status = 'ok', last_http_status = excluded.last_http_status, last_success_at = excluded.last_success_at,
      body = excluded.body, events_count = excluded.events_count, markets_returned = excluded.markets_returned,
      bookmakers_returned = excluded.bookmakers_returned, cost_last = excluded.cost_last, updated_at = excluded.updated_at;
    begin
      if r.endpoint in ('odds', 'events') and jsonb_typeof(v_body) = 'array' then
        insert into public.odds_api_events (event_id, sport_key, commence_time, home_team, away_team, last_seen_at)
        select distinct on (e->>'id') e->>'id', coalesce(e->>'sport_key', r.sport_key), (e->>'commence_time')::timestamptz,
               e->>'home_team', e->>'away_team', v_now
          from jsonb_array_elements(v_body) e
         where coalesce(e->>'id', '') <> '' and coalesce(e->>'commence_time', '') <> ''
        on conflict (event_id) do update set commence_time = excluded.commence_time, home_team = excluded.home_team,
          away_team = excluded.away_team, last_seen_at = excluded.last_seen_at;
      elsif r.endpoint = 'event_odds' and jsonb_typeof(v_body) = 'object' and coalesce(v_body->>'commence_time', '') <> '' then
        insert into public.odds_api_events (event_id, sport_key, commence_time, home_team, away_team, last_seen_at)
        values (coalesce(v_body->>'id', r.event_id), coalesce(v_body->>'sport_key', r.sport_key),
                (v_body->>'commence_time')::timestamptz, v_body->>'home_team', v_body->>'away_team', v_now)
        on conflict (event_id) do update set commence_time = excluded.commence_time, last_seen_at = excluded.last_seen_at;
      end if;
    exception when others then null;   -- a malformed commence time costs the clock, never the settle
    end;
  else
    insert into public.odds_api_snapshots (fingerprint, category, sport_key, event_id, endpoint, markets, selection,
      odds_format, last_request_id, last_attempt_at, last_status, last_http_status, updated_at)
    values (r.fingerprint, r.category, r.sport_key, r.event_id, r.endpoint, r.markets, r.selection, r.odds_format,
      r.id, v_now, 'failed', v_http, v_now)
    on conflict (fingerprint) do update set last_attempt_at = excluded.last_attempt_at, last_status = 'failed',
      last_http_status = excluded.last_http_status, updated_at = excluded.updated_at;
  end if;

  st := public.odds_api_budget_state(v_now);
  if c.monthly_budget > 0 then
    v_pct := (st->>'spent_cycle')::numeric / c.monthly_budget;
    if v_pct >= c.critical_pct then
      perform public.odds_api_alert('critical', 'monthly_critical', format('%s%% of the monthly operational budget is used.', round(v_pct * 100)), st);
    elsif v_pct >= c.warning_pct then
      perform public.odds_api_alert('warning', 'monthly_warning', format('%s%% of the monthly operational budget is used.', round(v_pct * 100)), st);
    end if;
    if nullif(st->>'projected_cycle', '')::numeric > c.monthly_budget then
      perform public.odds_api_alert('warning', 'pace_over_budget', 'At the current pace this cycle will exceed its operational budget.', st);
    end if;
  end if;
  if coalesce((st->>'daily_allowance')::int, 0) > 0 and (st->>'spent_today')::bigint > (st->>'daily_allowance')::int then
    perform public.odds_api_alert('warning', 'daily_allowance_exceeded', 'Today''s spend is above today''s allowance; optional polling is being shed.', st);
  end if;

  return jsonb_build_object('ok', true, 'request_id', v_id, 'actual_credits', v_actual, 'cost_is_exact', v_last is not null,
    'provider_remaining', v_rem);
end $$;

create or replace function public.odds_api_snapshot(p_fingerprint text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('fingerprint', s.fingerprint, 'request_id', s.last_request_id, 'fetched_at', s.last_success_at,
           'age_seconds', round(extract(epoch from (now() - s.last_success_at))), 'body', s.body,
           'events_count', s.events_count, 'markets_returned', s.markets_returned, 'cost_last', s.cost_last)
    from public.odds_api_snapshots s where s.fingerprint = p_fingerprint and s.last_success_at is not null
$$;

-- ONE FETCH, EVERY CONSUMER, EACH ONCE. capture, close, the GitHub prop
-- capture and collective_odds_ingest share snapshots; each records the last
-- snapshot it processed, so a fetch bought by one is processed by the others
-- exactly once (a cache hit carrying data a consumer has not seen yet is NEW
-- for that consumer) and never twice.
create table if not exists public.odds_api_consumer_marks (
  consumer    text not null,
  fingerprint text not null,
  request_id  bigint not null,
  consumed_at timestamptz not null default now(),
  primary key (consumer, fingerprint)
);
alter table public.odds_api_consumer_marks enable row level security;
revoke all on public.odds_api_consumer_marks from anon, authenticated;

create or replace function public.odds_api_consume(p_consumer text, p_fingerprint text, p_request_id bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if p_consumer is null or p_fingerprint is null or p_request_id is null then return false; end if;
  insert into public.odds_api_consumer_marks (consumer, fingerprint, request_id, consumed_at)
  values (left(p_consumer, 80), p_fingerprint, p_request_id, now())
  on conflict (consumer, fingerprint) do update set request_id = excluded.request_id, consumed_at = excluded.consumed_at
   where public.odds_api_consumer_marks.request_id < excluded.request_id
  returning true into v;
  return coalesce(v, false);
end $$;

-- ── 8. OPERATOR CONTROLS (service role / SQL editor) ───────────────────────
create or replace function public.odds_api_set_budget(p_monthly integer, p_reserve integer, p_daily integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config;
begin
  select * into c from public.odds_api_config where id = 1 for update;
  if p_monthly is null or p_reserve is null or p_daily is null or p_monthly < 0 or p_reserve < 0 or p_daily < 0 then
    return jsonb_build_object('ok', false, 'reason', 'budget values must be non-negative integers');
  end if;
  if p_monthly + p_reserve > c.plan_monthly_credits then
    return jsonb_build_object('ok', false, 'reason', format('budget %s + reserve %s exceeds the plan''s %s credits', p_monthly, p_reserve, c.plan_monthly_credits));
  end if;
  update public.odds_api_config set monthly_budget = p_monthly, monthly_reserve = p_reserve, daily_target = p_daily, updated_at = now() where id = 1;
  perform public.odds_api_alert('info', 'budget_changed', format('Budget set: monthly %s, reserve %s, daily %s.', p_monthly, p_reserve, p_daily), null);
  return jsonb_build_object('ok', true, 'monthly_budget', p_monthly, 'monthly_reserve', p_reserve, 'daily_target', p_daily);
end $$;

-- The post-recovery targets: 60,000 operational, 40,000 reserve, 1,500/day.
create or replace function public.odds_api_apply_recovery_budget()
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.odds_api_set_budget(60000, 40000, 1500)
$$;

-- Turning the breaker ON is refused without a budget. It does not by itself
-- spend anything: paid calls still wait for a provider-confirmed quota.
create or replace function public.odds_api_set_enabled(p_enabled boolean, p_reason text, p_by text default 'operator')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config; st jsonb;
begin
  select * into c from public.odds_api_config where id = 1 for update;
  if p_enabled and (c.monthly_budget <= 0 or c.daily_target <= 0) then
    return jsonb_build_object('ok', false, 'reason', 'set a budget first: select public.odds_api_apply_recovery_budget();');
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'a reason is required');
  end if;
  update public.odds_api_config set odds_api_enabled = p_enabled, breaker_reason = left(p_reason, 300),
         breaker_changed_at = now(), breaker_changed_by = left(coalesce(p_by, 'operator'), 120),
         provider_cooldown_until = case when p_enabled then null else provider_cooldown_until end,
         consecutive_failures = case when p_enabled then 0 else consecutive_failures end, updated_at = now()
   where id = 1;
  perform public.odds_api_alert(case when p_enabled then 'info' else 'warning' end, 'breaker_' || case when p_enabled then 'on' else 'off' end,
    format('Breaker turned %s by %s: %s', case when p_enabled then 'ON' else 'OFF' end, coalesce(p_by, 'operator'), p_reason), null);
  st := public.odds_api_budget_state(now());
  return jsonb_build_object('ok', true, 'enabled', p_enabled, 'quota_confirmed', st->'quota_confirmed',
    'note', case when p_enabled and not coalesce((st->>'quota_confirmed')::boolean, false)
                 then 'Paid calls wait until this cycle''s quota is confirmed (odds_api_confirm_quota or a free quota probe).' end);
end $$;

-- Record the account's usage as read from the provider's dashboard (or a free
-- /v4/sports header). This is what "confirmed" means for a new cycle.
create or replace function public.odds_api_confirm_quota(p_used integer, p_remaining integer, p_source text default 'operator')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_used is null or p_remaining is null or p_used < 0 or p_remaining < 0 then
    return jsonb_build_object('ok', false, 'reason', 'used and remaining must be non-negative');
  end if;
  update public.odds_api_config set provider_requests_used = p_used, provider_requests_remaining = p_remaining,
         provider_observed_at = now(), provider_observed_source = left('manual: ' || coalesce(p_source, 'operator'), 120),
         untracked_baseline = null, untracked_baseline_cycle = null, updated_at = now()
   where id = 1;
  perform public.odds_api_alert('info', 'quota_confirmed', format('Quota confirmed: %s used, %s remaining (%s).', p_used, p_remaining, coalesce(p_source, 'operator')), null);
  return jsonb_build_object('ok', true, 'used', p_used, 'remaining', p_remaining);
end $$;

create or replace function public.odds_api_set_category(p_category text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.odds_api_categories set enabled = p_enabled where category = p_category;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown category'); end if;
  return jsonb_build_object('ok', true, 'category', p_category, 'enabled', p_enabled);
end $$;

create or replace function public.odds_api_set_sport(p_sport text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.odds_api_sports set enabled = p_enabled where sport_key = p_sport;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown sport'); end if;
  return jsonb_build_object('ok', true, 'sport_key', p_sport, 'enabled', p_enabled);
end $$;

create or replace function public.odds_api_enabled()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select odds_api_enabled from public.odds_api_config where id = 1), false)
$$;

-- ── 9. JOB LOCKS: overlapping runs of one job collapse into one ────────────
create or replace function public.odds_api_job_lock(p_job text, p_holder text, p_ttl_seconds integer default 300)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  insert into public.odds_api_job_locks (job, holder, acquired_at, expires_at)
  values (left(p_job, 120), left(p_holder, 120), now(), now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 3600))))
  on conflict (job) do update set holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
   where public.odds_api_job_locks.expires_at <= now() or public.odds_api_job_locks.holder = excluded.holder
  returning true into v;
  return coalesce(v, false);
end $$;

create or replace function public.odds_api_job_unlock(p_job text, p_holder text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.odds_api_job_locks where job = p_job and holder = p_holder;
  return found;
end $$;

-- ── 10. WHAT A READER MAY KNOW: the feed's state and its last verified prices
create or replace function public.odds_feed_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config; st jsonb; v_state text; v_level smallint;
begin
  select * into c from public.odds_api_config where id = 1;
  st := public.odds_api_budget_state(now());
  v_level := public.odds_api_shed_level(coalesce((st->>'spent_today')::bigint, 0), 0, (st->>'daily_allowance')::int,
               coalesce(c.daily_overdraft_pct, 0.25), nullif(st->>'budget_used_pct', '')::numeric, coalesce(c.critical_pct, 0.8));
  v_state := case when c.id is null or not c.odds_api_enabled then 'paused'
                  when c.provider_cooldown_until > now() or v_level >= 3 then 'degraded' else 'live' end;
  return jsonb_build_object(
    'state', v_state,
    'paid_refresh', v_state <> 'paused',
    'message', case v_state
      when 'paused' then 'Sportsbook price refresh is paused. Prices shown are the last verified prices, with the time they were captured.'
      when 'degraded' then 'Sportsbook prices are refreshing less often than usual. Check each price''s capture time.'
      else 'Sportsbook prices refresh on an event-aware schedule: more often as kickoff approaches.' end,
    'checked_at', now(),
    'sports', coalesce((select jsonb_agg(jsonb_build_object('sport_key', s.sport_key, 'label', s.label,
        'last_verified_at', f.last_ok, 'age_minutes', round(extract(epoch from (now() - f.last_ok)) / 60))
        order by s.priority, s.sport_key)
      from public.odds_api_sports s
      left join lateral (select max(last_success_at) as last_ok from public.odds_api_snapshots n
                          where n.sport_key = s.sport_key and n.category in ('featured', 'close', 'collective')) f on true
      where s.enabled), '[]'::jsonb),
    'props', coalesce((select jsonb_agg(jsonb_build_object('sport_key', x.sport_key, 'last_verified_at', x.last_ok))
      from (select n.sport_key, max(n.last_success_at) as last_ok from public.odds_api_snapshots n
             where n.category like 'props%' and n.last_success_at is not null group by n.sport_key) x), '[]'::jsonb));
end $$;

-- ── 11. THE COST DASHBOARD: local records only, never a provider call ──────
create or replace function public.odds_api_dashboard(p_days integer default 14)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.odds_api_config; st jsonb; v_from date; v_today date := (now() at time zone 'utc')::date;
begin
  if not (public.odds_api_privileged() or public.odds_api_is_admin()) then
    raise exception 'odds_api_dashboard: operators only' using errcode = '42501';
  end if;
  v_from := v_today - greatest(1, least(coalesce(p_days, 14), 62));
  select * into c from public.odds_api_config where id = 1;
  st := public.odds_api_budget_state(now());
  return jsonb_build_object(
    'generated_at', now(),
    'breaker', jsonb_build_object('enabled', c.odds_api_enabled, 'reason', c.breaker_reason, 'changed_at', c.breaker_changed_at,
      'changed_by', c.breaker_changed_by, 'free_endpoints_enabled', c.free_endpoints_enabled,
      'cooldown_until', c.provider_cooldown_until, 'cooldown_reason', c.cooldown_reason, 'consecutive_failures', c.consecutive_failures),
    'budget', st,
    'shed_level_now', public.odds_api_shed_level(coalesce((st->>'spent_today')::bigint, 0), 0, (st->>'daily_allowance')::int,
       c.daily_overdraft_pct, nullif(st->>'budget_used_pct', '')::numeric, c.critical_pct),
    'today', (select jsonb_build_object(
        'credits', coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where dispatched), 0),
        'dispatched', count(*) filter (where dispatched),
        'cache_hits', count(*) filter (where decision = 'cache_hit'),
        'collapsed_in_flight', count(*) filter (where decision = 'in_flight'),
        'skipped_live_or_completed', count(*) filter (where decision in ('skipped_live', 'skipped_completed')),
        'denied', count(*) filter (where decision like 'denied%'),
        'decisions', count(*),
        'cache_hit_rate', round((count(*) filter (where decision in ('cache_hit', 'in_flight')))::numeric
                               / nullif(count(*) filter (where decision in ('cache_hit', 'in_flight', 'granted')), 0), 4),
        'props_credits', coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where dispatched and category like 'props%'), 0))
      from public.odds_api_requests where usage_day = v_today),
    'daily', coalesce((select jsonb_agg(d order by d->>'day') from (
        select jsonb_build_object('day', usage_day,
          'credits', coalesce(sum(coalesce(actual_credits, reserved_credits)) filter (where dispatched), 0),
          'dispatched', count(*) filter (where dispatched), 'cache_hits', count(*) filter (where decision = 'cache_hit'),
          'collapsed', count(*) filter (where decision = 'in_flight'), 'denied', count(*) filter (where decision like 'denied%')) as d
        from public.odds_api_requests where usage_day >= v_from group by usage_day) x), '[]'::jsonb),
    'by_caller', coalesce((select jsonb_agg(x order by x->>'day', x->>'caller') from (
        select jsonb_build_object('day', usage_day, 'caller', caller, 'requests', count(*),
          'credits', sum(coalesce(actual_credits, reserved_credits))) as x
        from public.odds_api_requests where dispatched and usage_day >= v_from group by usage_day, caller) y), '[]'::jsonb),
    'by_sport', coalesce((select jsonb_agg(x order by x->>'day', x->>'sport_key') from (
        select jsonb_build_object('day', usage_day, 'sport_key', coalesce(sport_key, '(none)'), 'requests', count(*),
          'credits', sum(coalesce(actual_credits, reserved_credits))) as x
        from public.odds_api_requests where dispatched and usage_day >= v_from group by usage_day, sport_key) y), '[]'::jsonb),
    'by_endpoint', coalesce((select jsonb_agg(x order by x->>'day', x->>'endpoint', x->>'category') from (
        select jsonb_build_object('day', usage_day, 'endpoint', endpoint, 'category', category, 'requests', count(*),
          'credits', sum(coalesce(actual_credits, reserved_credits)),
          'avg_cost', round(avg(coalesce(actual_credits, reserved_credits)), 2)) as x
        from public.odds_api_requests where dispatched and usage_day >= v_from group by usage_day, endpoint, category) y), '[]'::jsonb),
    'freshness', coalesce((select jsonb_agg(jsonb_build_object('sport_key', sport_key, 'category', category,
        'snapshots', n, 'last_success_at', last_ok, 'age_minutes', round(extract(epoch from (now() - last_ok)) / 60),
        'last_attempt_at', last_try, 'failing', failing) order by sport_key, category)
      from (select sport_key, category, count(*) as n, max(last_success_at) as last_ok, max(last_attempt_at) as last_try,
                   count(*) filter (where last_status = 'failed') as failing
              from public.odds_api_snapshots group by sport_key, category) f), '[]'::jsonb),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'level', level, 'code', code,
        'message', message, 'acknowledged_at', acknowledged_at) order by created_at desc)
      from (select * from public.odds_api_alerts order by created_at desc limit 50) a), '[]'::jsonb),
    'open_alerts', (select count(*) from public.odds_api_alerts where acknowledged_at is null and level in ('warning', 'critical', 'emergency')),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'caller', caller, 'category', category,
        'sport_key', sport_key, 'event_id', event_id, 'decision', decision, 'status', status, 'reserved', reserved_credits,
        'actual', actual_credits, 'exact', cost_is_exact, 'http', http_status, 'remaining', requests_remaining,
        'reason', reason, 'error', error) order by id desc)
      from (select * from public.odds_api_requests order by id desc limit 60) r), '[]'::jsonb),
    'categories', (select jsonb_agg(to_jsonb(k) order by k.priority, k.category) from public.odds_api_categories k),
    'sports', (select jsonb_agg(to_jsonb(s) order by s.priority, s.sport_key) from public.odds_api_sports s),
    'cadence', (select jsonb_agg(to_jsonb(d) order by d.category, d.sport_group, d.max_hours_to_start) from public.odds_api_cadence d));
end $$;

-- An admin may PAUSE paid retrieval from the dashboard. Turning it back on is
-- a SQL-editor / service-role act (odds_api_set_enabled), never a click.
create or replace function public.odds_api_admin_pause(p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (public.odds_api_privileged() or public.odds_api_is_admin()) then
    raise exception 'odds_api_admin_pause: operators only' using errcode = '42501';
  end if;
  update public.odds_api_config set odds_api_enabled = false, breaker_reason = left('dashboard: ' || coalesce(p_reason, 'paused'), 300),
         breaker_changed_at = now(), breaker_changed_by = 'dashboard', updated_at = now() where id = 1;
  perform public.odds_api_alert('warning', 'breaker_off', 'Paid retrieval paused from the dashboard: ' || coalesce(p_reason, ''), null);
  return jsonb_build_object('ok', true, 'enabled', false);
end $$;

create or replace function public.odds_api_ack_alert(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (public.odds_api_privileged() or public.odds_api_is_admin()) then
    raise exception 'odds_api_ack_alert: operators only' using errcode = '42501';
  end if;
  update public.odds_api_alerts set acknowledged_at = now(), acknowledged_by = coalesce(current_setting('request.jwt.claims', true)::jsonb->>'sub', session_user)
   where id = p_id and acknowledged_at is null;
  return jsonb_build_object('ok', found);
end $$;

-- ── 12. RETENTION ───────────────────────────────────────────────────────────
-- Event-level snapshot bodies go after snapshot_retention_hours; the latest
-- sport-level board is always kept (it is the last verified price when the
-- breaker is off). Refusals and cache hits go after decision_retention_days;
-- dispatched (billed) rows after ledger_retention_days.
create or replace function public.odds_api_prune()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.odds_api_config; a integer; b integer; d integer; e integer;
begin
  select * into c from public.odds_api_config where id = 1;
  delete from public.odds_api_snapshots where event_id is not null and updated_at < now() - make_interval(hours => c.snapshot_retention_hours);
  get diagnostics a = row_count;
  delete from public.odds_api_requests where not dispatched and created_at < now() - make_interval(days => c.decision_retention_days);
  get diagnostics b = row_count;
  delete from public.odds_api_requests where dispatched and created_at < now() - make_interval(days => c.ledger_retention_days);
  get diagnostics d = row_count;
  delete from public.odds_api_events where commence_time < now() - interval '30 days';
  get diagnostics e = row_count;
  delete from public.odds_api_alerts where acknowledged_at is not null and created_at < now() - interval '90 days';
  delete from public.odds_api_job_locks where expires_at < now() - interval '1 day';
  delete from public.odds_api_consumer_marks where consumed_at < now() - interval '30 days';
  return jsonb_build_object('snapshots', a, 'decisions', b, 'ledger', d, 'events', e);
end $$;

-- ── 13. WHO MAY CALL WHAT ───────────────────────────────────────────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'public.odds_api_acquire(jsonb)', 'public.odds_api_settle(jsonb)', 'public.odds_api_snapshot(text)',
    'public.odds_api_consume(text,text,bigint)',
    'public.odds_api_set_budget(integer,integer,integer)', 'public.odds_api_apply_recovery_budget()',
    'public.odds_api_set_enabled(boolean,text,text)', 'public.odds_api_confirm_quota(integer,integer,text)',
    'public.odds_api_set_category(text,boolean)', 'public.odds_api_set_sport(text,boolean)',
    'public.odds_api_job_lock(text,text,integer)', 'public.odds_api_job_unlock(text,text)',
    'public.odds_api_prune()', 'public.odds_api_budget_state(timestamptz)', 'public.odds_api_enabled()',
    'public.odds_api_trip(text,text)', 'public.odds_api_alert(text,text,text,jsonb)',
    'public.odds_api_dashboard(integer)', 'public.odds_api_admin_pause(text)', 'public.odds_api_ack_alert(bigint)',
    'public.odds_feed_status()', 'public.odds_api_is_admin()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  -- signed-in operators: the dashboard, pause and acknowledge (each checks the operator list itself)
  execute 'grant execute on function public.odds_api_dashboard(integer), public.odds_api_admin_pause(text), public.odds_api_ack_alert(bigint), public.odds_api_is_admin() to authenticated';
  -- everyone: whether prices are refreshing, and when each sport was last verified
  execute 'grant execute on function public.odds_feed_status() to anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.odds_api_config, public.odds_api_requests, public.odds_api_snapshots, public.odds_api_events,
             public.odds_api_alerts, public.odds_api_categories, public.odds_api_sports, public.odds_api_cadence to service_role';
  end if;
end $g$;
alter table public.odds_api_categories enable row level security;
alter table public.odds_api_sports enable row level security;
alter table public.odds_api_cadence enable row level security;
revoke all on public.odds_api_categories, public.odds_api_sports, public.odds_api_cadence from anon, authenticated;

-- Daily retention, where pg_cron exists. It calls no provider.
do $c$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null and to_regclass('cron.job') is not null then
    if not exists (select 1 from cron.job where jobname = 'odds_api_prune') then
      perform cron.schedule('odds_api_prune', '37 4 * * *', 'select public.odds_api_prune();');
    end if;
  end if;
end $c$;

notify pgrst, 'reload schema';

-- ── THE REPORT ──────────────────────────────────────────────────────────────
with checks as (
  select 1 as n, 'odds_api_emergency_stop.sql has been applied (its stop and resume functions exist)' as check_name,
         (case when to_regprocedure('public.odds_api_emergency_stop(text)') is not null
                and to_regprocedure('public.odds_api_resume_schedules(text)') is not null then 1 else 0 end) as got, 1 as want
  union all select 2, 'the switch row exists',
         (select count(*) from public.odds_api_config where id = 1)::int, 1
  union all select 3, 'every gateway table has row level security on and no anon read',
         (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity
            and relname in ('odds_api_config', 'odds_api_requests', 'odds_api_snapshots', 'odds_api_events', 'odds_api_alerts',
                            'odds_api_job_locks', 'odds_api_categories', 'odds_api_sports', 'odds_api_cadence', 'odds_api_consumer_marks')
            and not has_table_privilege('anon', oid, 'select'))::int, 10
  union all select 4, 'acquire and settle cannot be called by anon or a signed-in browser',
         (case when not has_function_privilege('anon', 'public.odds_api_acquire(jsonb)', 'execute')
                and not has_function_privilege('authenticated', 'public.odds_api_acquire(jsonb)', 'execute')
                and not has_function_privilege('authenticated', 'public.odds_api_settle(jsonb)', 'execute') then 1 else 0 end), 1
  union all select 5, 'readers can see the feed status (and nothing else)',
         (case when has_function_privilege('anon', 'public.odds_feed_status()', 'execute')
                and not has_function_privilege('anon', 'public.odds_api_dashboard(integer)', 'execute') then 1 else 0 end), 1
  union all select 6, 'alternate player props, secondary props, scores and historical calls are OFF',
         (select count(*) from public.odds_api_categories where category in ('props_alt', 'props_extra', 'scores', 'historical_events', 'historical_props') and not enabled)::int, 5
  union all select 7, 'main markets within 3 h of kickoff refresh at most every 20 minutes',
         (select count(*) from public.odds_api_cadence where category = 'featured' and sport_group = '*' and max_hours_to_start = 3 and interval_minutes = 20)::int, 1
  union all select 8, 'NFL props within 3 h at most hourly; beyond 48 h never',
         (select count(*) from public.odds_api_cadence where category = 'props' and sport_group = 'nfl'
            and ((max_hours_to_start = 3 and interval_minutes = 60) or (max_hours_to_start = 1000000 and interval_minutes is null)))::int, 2
  union all select 9, 'the provider allowlist is football first (NFL and NCAAF at priority 1)',
         (select count(*) from public.odds_api_sports where sport_key in ('americanfootball_nfl', 'americanfootball_ncaaf') and priority = 1)::int, 2
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by n;

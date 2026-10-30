-- =============================================================================
-- novig_market_data.sql — Novig exchange prices (T0, provider Novig) beside the
-- DraftKings price for the SAME bet, with what each would actually cost at a
-- stake. docs/novig/README.md is the narrative.
--
-- A NEW DATA SOURCE, NOT A MODEL CHANGE. Nothing here touches a projection,
-- ranking, threshold, EV guard, grade, the CLV record or any frozen protocol.
-- It reads public.signals (the book's events) and public.sharp_price_snapshots
-- (the DraftKings tape the Sharp-lag pipeline already keeps); it writes neither.
--
-- WHO WRITES. Only supabase/functions/novig_sync (service_role), and the
-- stream worker (tools/novig/stream_worker.js, service_role) once it is
-- switched on.
--   novig_events            every Novig event of a tracked league (catalog)
--   novig_markets           every game-line market of those events, with its
--                           fee schedule, void rule and outcomes (catalog)
--   novig_book_snapshots    APPEND-ONLY: one row per market per CHANGED book
--                           (a book whose seq has not moved is not stored
--                           again): the top of book and what the standard
--                           stakes would fill at. Kept for the record (line
--                           history, the close, lead-lag)
--   novig_book_depth        the full ladder behind a snapshot (up to 10
--                           levels per outcome). Pruned after
--                           novig_rule('depth_retention_days') days, except
--                           each market's last book before kickoff (its close)
--   novig_market_links      APPEND-ONLY: one row per Novig market that matched
--                           exactly one book event, market, period, line and
--                           side (lib/novig_market_map.js). The one later
--                           write allowed: invalidating it, once, with a reason
--   novig_unmapped          the queue of markets and events that did not
--                           match, with the reason, how often and since when
--   novig_sync_runs         APPEND-ONLY: one row per run
--   novig_alerts            APPEND-ONLY: FAILURE / DEGRADED / DRIFT / WARNING
--   novig_config            the operator's switches; every change is logged in
--   novig_config_log        APPEND-ONLY
--
-- WHO READS. Nobody but the operator until Novig's permission to display its
-- prices commercially is on record (docs/novig/README.md §Data rights):
--   public.novig_can_read()  operator (billing_is_admin / affiliate_is_admin),
--                            or, ONCE novig_config.public_display = 'on', a
--                            subscriber (has_active_sub(), as public.signals)
-- Every table's RLS uses it; anon reads nothing. The comparison and the
-- history come through SECURITY DEFINER functions that check it first,
-- because the DraftKings tape (public.sharp_price_snapshots) is service-role
-- only and stays that way: the functions return DraftKings prices only for
-- markets linked to Novig, only to a reader novig_can_read() admits — the
-- subscribers who already read book prices through public.signals.
-- No secret, key or credential is stored anywhere in this layer.
--
-- THE RULES live in public.novig_rule(), frozen like kalshi_rule(): a change
-- is a reviewed code change, and lib/edgedesk_venue_compare.js RULES must
-- match (tools/novig/venue_compare.test.js).
--
-- STORAGE. Snapshots are written only for markets a DraftKings line can be
-- compared with (the moneyline, and the spreads and totals at a line
-- DraftKings has quoted) and only when the book changed; the cadence slows
-- far from kickoff (novig_rule snapshot_*); depth is pruned daily
-- (novig_prune(), scheduled by novig_market_data_cron.sql). Growth is on
-- novig_readiness.
--
-- REQUIRES public.signals (capture) and public.sharp_price_snapshots
-- (supabase/sharp_lag.sql).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261030120000_novig_market_data.sql.
-- =============================================================================

do $req$ begin
  if to_regclass('public.signals') is null then
    raise exception 'novig_market_data.sql needs public.signals (the capture tables): apply capture first';
  end if;
  if to_regclass('public.sharp_price_snapshots') is null then
    raise exception 'novig_market_data.sql needs public.sharp_price_snapshots (the DraftKings tape): apply supabase/sharp_lag.sql first';
  end if;
end $req$;

begin;

-- ---------------------------------------------------------------- guards
create or replace function public.novig_keep()
returns trigger language plpgsql as $k$
begin
  raise exception 'public.% is append-only: % refused (write a new row instead)', tg_table_name, tg_op;
end $k$;

-- ---------------------------------------------------------------- the rules (frozen; a change is a code change)
create or replace function public.novig_rule(p_key text)
returns numeric language sql immutable as $r$
  select case p_key
    when 'novig_live_seconds'       then 90    -- a streamed book this fresh may be called Live
    when 'novig_recent_minutes'     then 10    -- a REST snapshot this fresh is Recently updated; older is Stale
    when 'book_live_minutes'        then 10    -- a sportsbook read this fresh may be called Live
    when 'book_recent_minutes'      then 90    -- a sportsbook quote older than this is Stale (EDINTEL quote_ttl_min)
    when 'pair_max_gap_minutes'     then 10    -- two venues' observations further apart are not a simultaneous comparison
    when 'tie_pp'                   then 0.10  -- implied-probability difference below this (pp) is a tie
    when 'model_max_age_hours'      then 36    -- a model probability older than this is not current
    when 'depth_retention_days'     then 7     -- full ladders older than this are pruned (each market's close is kept)
    when 'silent_scheduler_minutes' then 20    -- no snapshot run in this long: the scheduler is not calling
    when 'discover_max_age_hours'   then 3     -- no successful discover in this long: degraded
    when 'unmapped_window_hours'    then 30    -- an unmapped market starting inside this window is a warning
    when 'snapshot_near_minutes'    then 5     -- book cadence inside 2 hours of kickoff
    when 'snapshot_mid_minutes'     then 10    -- 2 to 24 hours out
    when 'snapshot_far_minutes'     then 30    -- further out
  end
$r$;

-- ---------------------------------------------------------------- config (the operator's switches; every change logged)
create table if not exists public.novig_config (
  key         text primary key,
  value       text not null,
  note        text,
  updated_at  timestamptz not null default now()
);
create table if not exists public.novig_config_log (
  id          bigint generated always as identity primary key,
  key         text not null,
  old_value   text,
  new_value   text not null,
  note        text,
  changed_by  text not null default current_user,
  changed_at  timestamptz not null default now()
);

create or replace function public.novig_config_audit()
returns trigger language plpgsql as $a$
begin
  if tg_op = 'DELETE' then raise exception 'public.novig_config rows are never deleted (set the value instead)'; end if;
  -- an insert of a key that exists is about to be skipped by ON CONFLICT DO NOTHING: log nothing
  if tg_op = 'INSERT' and exists (select 1 from public.novig_config c where c.key = new.key) then return new; end if;
  if tg_op = 'UPDATE' and new.key <> old.key then raise exception 'a novig_config key cannot be renamed'; end if;
  if new.key = 'public_display' and new.value not in ('off', 'on') then raise exception 'public_display is off or on'; end if;
  if new.key = 'expected_environment' and new.value not in ('production', 'paper') then raise exception 'expected_environment is production or paper'; end if;
  if tg_op = 'INSERT' or new.value is distinct from old.value then
    insert into public.novig_config_log (key, old_value, new_value, note)
    values (new.key, case when tg_op = 'UPDATE' then old.value end, new.value, new.note);
  end if;
  new.updated_at := now();
  return new;
end $a$;
drop trigger if exists novig_config_logged on public.novig_config;
create trigger novig_config_logged before insert or update or delete on public.novig_config for each row execute function public.novig_config_audit();
-- after the trigger, so the first values are logged too; a re-run inserts nothing and logs nothing
insert into public.novig_config (key, value, note) values
  ('public_display', 'off', 'NOVIG_PUBLIC_DISPLAY_ENABLED. off until Novig''s written permission to display its prices commercially (live quotes, history, subscriber display, graphics, logo) is on record: docs/novig/README.md §Data rights. on: subscribers (has_active_sub()) read the comparison. Record who, when and the permission''s reference in this note.'),
  ('expected_environment', 'production', 'The Novig environment subscriber-facing prices may come from. A paper (play-money) row is never served to a reader.')
on conflict (key) do nothing;

create or replace function public.novig_setting(p_key text)
returns text language sql stable security definer set search_path = public, pg_temp as $s$
  select value from public.novig_config where key = p_key
$s$;

-- ---------------------------------------------------------------- who may read
create or replace function public.novig_is_operator()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $o$
declare v boolean := false;
begin
  if to_regprocedure('public.billing_is_admin()') is not null then
    execute 'select public.billing_is_admin()' into v;
    if coalesce(v, false) then return true; end if;
  end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v;
    if coalesce(v, false) then return true; end if;
  end if;
  return false;
exception when others then return false;
end $o$;

create or replace function public.novig_is_subscriber()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $s$
declare v boolean := false;
begin
  if to_regprocedure('public.has_active_sub()') is null then return false; end if;
  execute 'select public.has_active_sub()' into v;
  return coalesce(v, false);
exception when others then return false;
end $s$;

create or replace function public.novig_can_read()
returns boolean language sql stable security definer set search_path = public, pg_temp as $c$
  select public.novig_is_operator()
      or (coalesce(public.novig_setting('public_display'), 'off') = 'on' and public.novig_is_subscriber())
$c$;

-- ---------------------------------------------------------------- the catalog (refreshed every discover)
create table if not exists public.novig_events (
  event_id            text primary key,
  environment         text not null check (environment in ('production', 'paper')),
  league              text not null,
  sport               text,
  description         text,
  status              text,
  starts_at           timestamptz,
  home_competitor_id  text,
  away_competitor_id  text,
  home_name           text,
  away_name           text,
  home_symbol         text,
  away_symbol         text,
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists novig_events_league_idx on public.novig_events (environment, league, starts_at);

create table if not exists public.novig_markets (
  market_id         text primary key,
  environment       text not null check (environment in ('production', 'paper')),
  event_id          text not null references public.novig_events (event_id),
  market_type       text not null,
  strike            text,                    -- Novig's decimal string, as sent
  status            text,
  voids             text,                    -- PUSH | FMV
  fee_coefficient   text,                    -- c in c·P(1−P)·N, as sent
  fee_maker_credit  text,
  fee_charged       text,                    -- ALWAYS | WHEN_LIVE
  description       text,
  outcomes          jsonb not null default '[]'::jsonb,   -- [{outcomeId, name, status}]
  volume            bigint,
  open_interest     bigint,
  is_consensus      boolean not null default false,
  last_book_seq     bigint,
  last_book_etag    text,
  last_snapshot_at  timestamptz,
  book_confirmed_at timestamptz,             -- the last time the book at last_book_seq was read again unchanged (304 / same seq)
  gone_at           timestamptz,             -- left the open catalog (closed, settled or delisted)
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists novig_markets_event_idx on public.novig_markets (event_id);
alter table public.novig_markets add column if not exists book_confirmed_at timestamptz;
create index if not exists novig_markets_type_idx on public.novig_markets (environment, market_type, status);

-- ---------------------------------------------------------------- snapshots (T0, append-only)
create table if not exists public.novig_book_snapshots (
  id               bigint generated always as identity primary key,
  environment      text not null check (environment in ('production', 'paper')),
  market_id        text not null references public.novig_markets (market_id),
  captured_at      timestamptz not null,     -- when EdgeDesk read the book (Novig's book carries a seq, not a time)
  source           text not null check (source in ('rest_book', 'ws_book')),
  book_seq         bigint not null,          -- Novig's book sequence number at this snapshot
  event_status     text,
  market_status    text,
  fee_charged_now  boolean,                  -- would a taker pay the fee at this moment (WHEN_LIVE and in play, or ALWAYS)
  top              jsonb not null default '{}'::jsonb,  -- {outcomeId: {bid, bid_qty, ask, ask_qty}} (prices as Novig's strings)
  exec             jsonb not null default '{}'::jsonb,  -- {outcomeId: {"25": [status, contracts, total, payout, unspent, vwap], ...}}
  levels           integer,                  -- price levels read per outcome (depth requested)
  run_id           uuid,
  ingested_at      timestamptz not null default now()
);
-- the same book state (same market, same seq, same source) is stored once
create unique index if not exists novig_book_snapshots_seq_idx on public.novig_book_snapshots (environment, market_id, source, book_seq);
create index if not exists novig_book_snapshots_market_time_idx on public.novig_book_snapshots (market_id, captured_at desc);
create index if not exists novig_book_snapshots_captured_idx on public.novig_book_snapshots (captured_at desc);

create table if not exists public.novig_book_depth (
  snapshot_id  bigint primary key references public.novig_book_snapshots (id),
  market_id    text not null,
  captured_at  timestamptz not null,
  depth        jsonb not null                -- {outcomeId: [[price, qty, [orderQty...]], ...]} best bid first
);
create index if not exists novig_book_depth_market_time_idx on public.novig_book_depth (market_id, captured_at desc);
create index if not exists novig_book_depth_captured_idx on public.novig_book_depth (captured_at);

-- ---------------------------------------------------------------- links (append-only; one invalidation allowed)
create table if not exists public.novig_market_links (
  market_id          text primary key references public.novig_markets (market_id),
  environment        text not null check (environment in ('production', 'paper')),
  novig_event_id     text not null,
  novig_market_type  text not null,
  league             text not null,
  sport              text,
  odds_event_id      text not null,          -- public.signals.event_id (The Odds API's event id)
  odds_sport_key     text not null,
  book_market        text not null,          -- h2h | spreads | totals | h2h_h1 | spreads_h1 | totals_h1
  period             text not null check (period in ('game', 'first_half')),
  line               numeric,                -- the exact strike (spread: the HOME handicap); null for a moneyline
  outcomes           jsonb not null,         -- [{outcome_id, novig_name, side (as the book names it), point}]
  home_team          text not null,
  away_team          text not null,
  kickoff_at         timestamptz not null,   -- the book's commence_time
  novig_starts_at    timestamptz,
  kickoff_delta_min  numeric,
  match_confidence   text not null check (match_confidence in ('high', 'medium')),
  match_method       text not null,
  constraints        jsonb not null default '{}'::jsonb,
  settlement_notes   text[] not null default '{}',
  linker_version     text not null,
  run_id             uuid,
  linked_at          timestamptz not null default now(),   -- the verification time
  invalidated_at     timestamptz,
  invalidated_reason text,
  check (jsonb_array_length(outcomes) = 2),
  check ((invalidated_at is null) = (invalidated_reason is null))
);
create index if not exists novig_market_links_event_idx on public.novig_market_links (odds_event_id, book_market);
create index if not exists novig_market_links_kickoff_idx on public.novig_market_links (kickoff_at);

create or replace function public.novig_market_links_guard()
returns trigger language plpgsql as $g$
declare fill text[] := array['invalidated_at', 'invalidated_reason'];
begin
  if tg_op = 'UPDATE' and old.invalidated_at is null and new.invalidated_at is not null
     and (to_jsonb(new) - fill) = (to_jsonb(old) - fill) then
    return new;
  end if;
  raise exception 'public.novig_market_links is append-only: % refused (only an invalidation may be written, once)', tg_op;
end $g$;
drop trigger if exists novig_market_links_frozen on public.novig_market_links;
create trigger novig_market_links_frozen before update or delete on public.novig_market_links for each row execute function public.novig_market_links_guard();

-- ---------------------------------------------------------------- the unmapped queue
create table if not exists public.novig_unmapped (
  id             bigint generated always as identity primary key,
  environment    text not null,
  novig_event_id text not null,
  market_id      text not null default '',  -- '' for an event-level reason
  reason         text not null,
  detail         jsonb,
  starts_at      timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  seen_count     integer not null default 1,
  resolved_at    timestamptz,
  unique (environment, novig_event_id, market_id, reason)
);
create index if not exists novig_unmapped_open_idx on public.novig_unmapped (resolved_at, starts_at);

-- the sync records a run's unmapped list here (service role only): each row
-- is counted again, a market that has since linked is resolved, and a reason
-- that no longer applies to an event this run looked at is resolved.
create or replace function public.novig_record_unmapped(p_environment text, p_rows jsonb, p_linked text[], p_events text[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $u$
declare v_up integer := 0; v_res integer := 0;
begin
  insert into public.novig_unmapped as u (environment, novig_event_id, market_id, reason, detail, starts_at)
  select p_environment, r ->> 'novig_event_id', coalesce(r ->> 'market_id', ''), r ->> 'reason', r -> 'detail', nullif(r ->> 'starts_at', '')::timestamptz
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (environment, novig_event_id, market_id, reason) do update
     set last_seen_at = now(), seen_count = u.seen_count + 1, detail = excluded.detail, starts_at = excluded.starts_at, resolved_at = null;
  get diagnostics v_up = row_count;
  update public.novig_unmapped u set resolved_at = now()
   where u.environment = p_environment and u.resolved_at is null
     and (u.market_id = any(coalesce(p_linked, '{}'))
          or (u.novig_event_id = any(coalesce(p_events, '{}'))
              and not exists (select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
                               where r ->> 'novig_event_id' = u.novig_event_id and coalesce(r ->> 'market_id', '') = u.market_id and r ->> 'reason' = u.reason)));
  get diagnostics v_res = row_count;
  return jsonb_build_object('recorded', v_up, 'resolved', v_res);
end $u$;

-- ---------------------------------------------------------------- runs and alerts
create table if not exists public.novig_sync_runs (
  run_id              uuid primary key default gen_random_uuid(),
  build               text,
  trigger             text not null default 'cron' check (trigger in ('cron', 'manual', 'test', 'stream')),
  mode                text not null check (mode in ('probe', 'discover', 'snapshot', 'stream')),
  environment         text,
  status              text not null check (status in ('ok', 'warn', 'error', 'skipped')),
  skipped_reason      text,
  started_at          timestamptz not null,
  finished_at         timestamptz not null default now(),
  auth                jsonb,          -- probe: time, echo, limits, geolocation standing (never a key or a signature)
  clock_offset_ms     integer,
  requests            integer,
  requests_not_modified integer,
  rate_limited        integer,
  events_seen         integer,
  markets_seen        integer,
  links_new           integer,
  links_invalidated   integer,
  unmapped            integer,
  books_read          integer,
  snapshots_written   integer,
  snapshots_unchanged integer,
  halt_until          timestamptz,    -- a 451 / 423 / auth failure stops every run until then
  halt_reason         text,
  message             text,
  details             jsonb not null default '{}'::jsonb,
  check (finished_at >= started_at)
);
create index if not exists novig_sync_runs_finished_idx on public.novig_sync_runs (finished_at desc);
create index if not exists novig_sync_runs_mode_idx on public.novig_sync_runs (mode, finished_at desc);

create table if not exists public.novig_alerts (
  id          bigint generated always as identity primary key,
  run_id      uuid references public.novig_sync_runs (run_id),
  severity    text not null check (severity in ('FAILURE', 'DEGRADED', 'DRIFT', 'WARNING')),
  code        text not null,
  message     text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists novig_alerts_created_idx on public.novig_alerts (created_at desc);

-- append-only: snapshots, runs, alerts, the config log
do $t$ declare t text; begin
  foreach t in array array['novig_book_snapshots', 'novig_sync_runs', 'novig_alerts', 'novig_config_log'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.novig_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.novig_keep()', t || '_no_truncate', t);
  end loop;
end $t$;

-- depth: never updated; deleted only by novig_prune()
create or replace function public.novig_depth_guard()
returns trigger language plpgsql as $d$
begin
  if tg_op = 'DELETE' and current_setting('novig.pruning', true) = 'on' then return old; end if;
  raise exception 'public.novig_book_depth: % refused (rows are pruned only by public.novig_prune())', tg_op;
end $d$;
drop trigger if exists novig_book_depth_guard on public.novig_book_depth;
create trigger novig_book_depth_guard before update or delete on public.novig_book_depth for each row execute function public.novig_depth_guard();

comment on table public.novig_book_snapshots is 'T0 Observed, provider Novig: one row per changed order book (seq), the top of book and the standard stakes'' fills. Append-only.';
comment on table public.novig_market_links is 'Novig market -> the book''s event, market, period, line and side (lib/novig_market_map.js). Unmatched markets are queued in novig_unmapped, never guessed.';

-- ---------------------------------------------------------------- retention
create or replace function public.novig_prune()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $p$
declare v_depth integer := 0; v_queue integer := 0;
begin
  perform set_config('novig.pruning', 'on', true);
  with keep as (
    -- each market's last depth before its kickoff is its close: kept
    select distinct on (d.market_id) d.snapshot_id
      from public.novig_book_depth d
      join public.novig_market_links l on l.market_id = d.market_id
     where d.captured_at <= l.kickoff_at
     order by d.market_id, d.captured_at desc
  ), gone as (
    delete from public.novig_book_depth d
     where d.captured_at < now() - make_interval(days => public.novig_rule('depth_retention_days')::int)
       and d.snapshot_id not in (select snapshot_id from keep)
    returning 1
  ) select count(*) into v_depth from gone;
  perform set_config('novig.pruning', 'off', true);
  delete from public.novig_unmapped where resolved_at is not null and resolved_at < now() - interval '30 days';
  get diagnostics v_queue = row_count;
  return jsonb_build_object('depth_rows_pruned', v_depth, 'resolved_unmapped_pruned', v_queue);
end $p$;

-- ---------------------------------------------------------------- the DraftKings side (from the Sharp-lag tape)
-- the DraftKings price of one linked outcome, as of p_at: the latest row at or
-- before it. SECURITY DEFINER because the tape is service-role only; callable
-- only by the functions below (not granted to any client).
create or replace function public.novig_dk_price(p_event text, p_market text, p_side text, p_point numeric, p_at timestamptz)
returns table (price_dec numeric, captured_at timestamptz, book_last_update timestamptz)
language sql stable security definer set search_path = public, pg_temp as $dk$
  select s.price_dec, s.captured_at, s.book_last_update
    from public.sharp_price_snapshots s
   where s.event_id = p_event and s.book = 'draftkings' and s.market = p_market and s.side = p_side
     and s.participant is null
     and (p_point is null and s.point is null or s.point = p_point)
     and s.captured_at <= p_at
   order by s.captured_at desc, s.id desc
   limit 1
$dk$;

-- ---------------------------------------------------------------- THE COMPARISON (one row per linked outcome)
-- What a game card and the comparison module read. The display rule is
-- applied HERE, once, from novig_rule(): each venue's freshness state, and
-- `comparable` only when both are current. A paper-environment row is never
-- returned. The stake-aware numbers for the standard stakes are the
-- snapshot's own (computed from the book by lib/edgedesk_venue_compare.js
-- when it was read); the full ladder comes with it for a custom stake.
create or replace function public.novig_compare(p_sport text default null, p_from timestamptz default null, p_to timestamptz default null, p_odds_event_id text default null)
returns setof jsonb language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare v_env text := coalesce(public.novig_setting('expected_environment'), 'production');
begin
  if not public.novig_can_read() then return; end if;
  return query
  with l as (
    select k.*, e.status as event_status
      from public.novig_market_links k
      join public.novig_markets m on m.market_id = k.market_id
      join public.novig_events e on e.event_id = m.event_id
     where k.invalidated_at is null and k.environment = v_env
       and (p_sport is null or k.sport = p_sport)
       and (p_odds_event_id is null or k.odds_event_id = p_odds_event_id)
       and k.kickoff_at >= coalesce(p_from, now() - interval '1 day')
       and k.kickoff_at <= coalesce(p_to, now() + interval '8 days')
  ), s as (
    -- an unchanged book read again confirms the snapshot is still the book: its observation time moves up
    select l.*, x.id as snapshot_id, x.captured_at as snapshot_at,
           case when m.last_book_seq = x.book_seq and m.book_confirmed_at > x.captured_at then m.book_confirmed_at else x.captured_at end as novig_at,
           x.source as novig_source, x.book_seq, x.top, x.exec, x.market_status, x.event_status as snap_event_status, x.fee_charged_now,
           m.fee_coefficient, m.fee_charged, m.fee_maker_credit, m.voids, m.status as catalog_status, m.gone_at
      from l
      join public.novig_markets m on m.market_id = l.market_id
      left join lateral (select y.* from public.novig_book_snapshots y where y.market_id = l.market_id and y.environment = v_env
                         order by y.captured_at desc, y.id desc limit 1) x on true
  ), o as (
    select s.*, oc ->> 'outcome_id' as outcome_id, oc ->> 'side' as side, nullif(oc ->> 'point', '')::numeric as point, oc ->> 'novig_name' as novig_name
      from s, jsonb_array_elements(s.outcomes) oc
  ), j as (
    select o.*, dk.price_dec as dk_price_dec, dk.captured_at as dk_at, dk.book_last_update as dk_book_last_update,
           extract(epoch from now() - o.novig_at) as novig_age_s, extract(epoch from now() - dk.captured_at) as dk_age_s
      from o
      left join lateral public.novig_dk_price(o.odds_event_id, o.book_market, o.side, o.point, now()) dk on true
  )
  select jsonb_build_object(
    'odds_event_id', j.odds_event_id, 'sport', j.sport, 'league', j.league, 'home_team', j.home_team, 'away_team', j.away_team, 'kickoff_at', j.kickoff_at,
    'book_market', j.book_market, 'period', j.period, 'line', j.line, 'side', j.side, 'point', j.point,
    'match_confidence', j.match_confidence, 'settlement_notes', to_jsonb(j.settlement_notes), 'linked_at', j.linked_at,
    'novig', jsonb_build_object('market_id', j.market_id, 'outcome_id', j.outcome_id, 'name', j.novig_name, 'market_type', j.novig_market_type, 'environment', j.environment,
       'snapshot_id', j.snapshot_id, 'observed_at', j.novig_at, 'snapshot_at', j.snapshot_at, 'source', j.novig_source, 'book_seq', j.book_seq,
       'top', j.top -> j.outcome_id, 'exec', j.exec -> j.outcome_id, 'market_status', coalesce(j.market_status, j.catalog_status), 'event_status', coalesce(j.snap_event_status, j.event_status),
       'fee', jsonb_build_object('coefficient', j.fee_coefficient, 'makerCredit', j.fee_maker_credit, 'charged', j.fee_charged, 'charged_now', j.fee_charged_now), 'voids', j.voids,
       'depth', (select d.depth from public.novig_book_depth d where d.snapshot_id = j.snapshot_id),
       'outcome_ids', (select jsonb_agg(z ->> 'outcome_id') from jsonb_array_elements(j.outcomes) z),
       'state', case when j.snapshot_id is null then 'AWAITING'
                     -- either signal closes it: the catalog (refreshed every discover) or the book's own snapshot
                     when j.gone_at is not null or coalesce(j.catalog_status, 'OPEN') <> 'OPEN' or coalesce(j.market_status, 'OPEN') <> 'OPEN'
                       or j.event_status = 'DELAYED' or coalesce(j.snap_event_status, '') = 'DELAYED' then 'SUSPENDED'
                     when j.novig_source = 'ws_book' and j.novig_age_s <= public.novig_rule('novig_live_seconds') then 'LIVE'
                     when j.novig_age_s <= public.novig_rule('novig_recent_minutes') * 60 then case when (j.top -> j.outcome_id ->> 'ask') is null then 'NO_LIQUIDITY' else 'RECENT' end
                     else 'STALE' end),
    'draftkings', jsonb_build_object('price_dec', j.dk_price_dec, 'observed_at', j.dk_at, 'book_last_update', j.dk_book_last_update, 'source', 'The Odds API via the odds gateway (public.sharp_price_snapshots)',
       'state', case when j.dk_at is null then 'AWAITING'
                     when j.dk_age_s <= public.novig_rule('book_live_minutes') * 60 then 'LIVE'
                     when j.dk_age_s <= public.novig_rule('book_recent_minutes') * 60 then 'RECENT'
                     else 'STALE' end),
    'pair_gap_minutes', round((abs(extract(epoch from j.novig_at - j.dk_at)) / 60)::numeric, 1),
    'rules', jsonb_build_object('novig_recent_minutes', public.novig_rule('novig_recent_minutes'), 'book_recent_minutes', public.novig_rule('book_recent_minutes'),
       'pair_max_gap_minutes', public.novig_rule('pair_max_gap_minutes'), 'tie_pp', public.novig_rule('tie_pp'))
  )
  from j
  order by j.kickoff_at, j.odds_event_id, j.book_market, j.line nulls first, j.side;
end $f$;

-- ---------------------------------------------------------------- THE HISTORY (both venues, their own timestamps)
-- Every Novig snapshot of one event's linked markets and every DraftKings row
-- for the same markets, each at its own time, for the line-movement chart and
-- the lead-lag study (lib/edgedesk_lead_lag.js). Nothing is interpolated or
-- shifted; a DraftKings close stays DraftKings', a Novig close Novig's.
create or replace function public.novig_history(p_odds_event_id text)
returns setof jsonb language plpgsql stable security definer set search_path = public, pg_temp as $h$
declare v_env text := coalesce(public.novig_setting('expected_environment'), 'production');
begin
  if not public.novig_can_read() then return; end if;
  return query
  with l as (
    select k.*, oc ->> 'outcome_id' as outcome_id, oc ->> 'side' as side, nullif(oc ->> 'point', '')::numeric as point
      from public.novig_market_links k, jsonb_array_elements(k.outcomes) oc
     where k.odds_event_id = p_odds_event_id and k.invalidated_at is null and k.environment = v_env
  )
  select jsonb_build_object('venue', 'novig', 'book_market', l.book_market, 'line', l.line, 'side', l.side, 'point', l.point, 'at', s.captured_at,
           'ask', s.top -> l.outcome_id ->> 'ask', 'ask_qty', s.top -> l.outcome_id -> 'ask_qty', 'bid', s.top -> l.outcome_id ->> 'bid', 'seq', s.book_seq, 'source', s.source,
           'pregame', s.captured_at < l.kickoff_at, 'kickoff_at', l.kickoff_at)
    from l join public.novig_book_snapshots s on s.market_id = l.market_id and s.environment = v_env
  union all
  select jsonb_build_object('venue', 'draftkings', 'book_market', l.book_market, 'line', l.line, 'side', l.side, 'point', l.point, 'at', d.captured_at,
           'price_dec', d.price_dec, 'book_last_update', d.book_last_update, 'pregame', d.captured_at < l.kickoff_at, 'kickoff_at', l.kickoff_at)
    from l join public.sharp_price_snapshots d on d.event_id = l.odds_event_id and d.book = 'draftkings' and d.market = l.book_market and d.side = l.side
         and d.participant is null and (l.point is null and d.point is null or d.point = l.point);
end $h$;

-- ---------------------------------------------------------------- THE RESEARCH VIEW: is Novig consistently better?
-- Every pregame Novig snapshot of a linked outcome, paired with the DraftKings
-- price in force at that moment (the latest DraftKings row at or before it, no
-- older than pair_max_gap_minutes): the only pairs that are simultaneous.
-- Grouped by sport, market and pregame, with the coverage that bounds it.
-- Nothing is said about a market Novig does not list or a pair that is not
-- simultaneous; those are counted as exclusions, not dropped silently.
create or replace function public.novig_price_gap_summary(p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $g$
declare v_env text := coalesce(public.novig_setting('expected_environment'), 'production');
        v_out jsonb;
begin
  if not public.novig_can_read() then return jsonb_build_object('access', 'none'); end if;
  with l as (
    select k.*, oc ->> 'outcome_id' as outcome_id, oc ->> 'side' as side, nullif(oc ->> 'point', '')::numeric as point
      from public.novig_market_links k, jsonb_array_elements(k.outcomes) oc
     where k.invalidated_at is null and k.environment = v_env
  ), snaps as (
    select l.sport, l.book_market, l.market_id, l.outcome_id, l.odds_event_id, l.side, l.point, l.kickoff_at, s.captured_at,
           nullif(s.top -> l.outcome_id ->> 'ask', '')::numeric as n_ask,
           s.exec -> l.outcome_id -> '100' as n100
      from l join public.novig_book_snapshots s on s.market_id = l.market_id and s.environment = v_env
     where s.captured_at < l.kickoff_at
       and s.captured_at >= coalesce(p_from, now() - interval '30 days') and s.captured_at <= coalesce(p_to, now())
  ), paired as (
    select n.*, dk.price_dec, dk.captured_at as dk_at,
           (dk.captured_at is not null and n.captured_at - dk.captured_at <= make_interval(mins => public.novig_rule('pair_max_gap_minutes')::int)) as simultaneous
      from snaps n
      left join lateral public.novig_dk_price(n.odds_event_id, n.book_market, n.side, n.point, n.captured_at) dk on true
  ), cmp as (
    select p.*, 1 / p.price_dec as dk_implied,
           (1 / p.price_dec - p.n_ask) * 100 as gap_pp,
           case when p.n100 ->> 0 = 'FILLED' then (p.n100 ->> 3)::numeric + (p.n100 ->> 4)::numeric - 100 * p.price_dec end as payout_diff_100,
           p.n100 ->> 0 as fill_100
      from paired p where p.simultaneous and p.n_ask is not null and p.price_dec > 1
  ), grp as (
    select sport, book_market, count(*) as pairs,
           count(*) filter (where gap_pp >= public.novig_rule('tie_pp')) as novig_better,
           count(*) filter (where gap_pp <= -public.novig_rule('tie_pp')) as dk_better,
           count(*) filter (where abs(gap_pp) < public.novig_rule('tie_pp')) as ties,
           percentile_cont(0.5) within group (order by gap_pp) as median_gap_pp,
           percentile_cont(0.25) within group (order by gap_pp) as p25_gap_pp,
           percentile_cont(0.75) within group (order by gap_pp) as p75_gap_pp,
           percentile_cont(0.5) within group (order by payout_diff_100) as median_payout_diff_100,
           count(*) filter (where fill_100 = 'PARTIAL') as partial_100,
           count(*) filter (where fill_100 = 'NO_LIQUIDITY') as no_liquidity_100,
           count(distinct odds_event_id) as events, min(captured_at) as first_at, max(captured_at) as last_at
      from cmp group by sport, book_market
  )
  select jsonb_build_object(
    'access', case when public.novig_is_operator() then 'operator' else 'subscriber' end,
    'environment', v_env, 'from', coalesce(p_from, now() - interval '30 days'), 'to', coalesce(p_to, now()),
    'definition', 'gap_pp = DraftKings implied probability minus Novig''s best ask, in percentage points, for the same side at the same line; positive means Novig''s price is better. Pairs are pregame and simultaneous (the DraftKings price in force at the Novig snapshot, at most pair_max_gap_minutes old). A better price is not a positive-EV bet.',
    'groups', coalesce((select jsonb_agg(to_jsonb(g) order by g.sport, g.book_market) from grp g), '[]'::jsonb),
    'coverage', jsonb_build_object(
       'snapshots_pregame', (select count(*) from snaps),
       'snapshots_with_ask', (select count(*) from snaps where n_ask is not null),
       'pairs_simultaneous', (select count(*) from cmp),
       'excluded_no_simultaneous_dk', (select count(*) from paired where not coalesce(simultaneous, false)),
       'links_active', (select count(*) from public.novig_market_links where invalidated_at is null and environment = v_env),
       'unmapped_open', (select count(*) from public.novig_unmapped where resolved_at is null and environment = v_env),
       'unmapped_by_reason', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from (select reason, count(*) n from public.novig_unmapped where resolved_at is null and environment = v_env group by reason) u)),
    'rules', jsonb_build_object('pair_max_gap_minutes', public.novig_rule('pair_max_gap_minutes'), 'tie_pp', public.novig_rule('tie_pp'))
  ) into v_out;
  return v_out;
end $g$;

-- ---------------------------------------------------------------- the reader's access, for the UI
create or replace function public.novig_access()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $a$
  select jsonb_build_object(
    'access', case when public.novig_is_operator() then 'operator' when public.novig_can_read() then 'subscriber' else 'none' end,
    'public_display', coalesce(public.novig_setting('public_display'), 'off'),
    'environment', coalesce(public.novig_setting('expected_environment'), 'production'))
$a$;

-- ---------------------------------------------------------------- THE KPIs (operator)
create or replace view public.novig_readiness with (security_invoker = true) as
with any_run   as (select * from public.novig_sync_runs order by finished_at desc limit 1),
     snap_any  as (select * from public.novig_sync_runs where mode = 'snapshot' and status <> 'skipped' order by finished_at desc limit 1),
     snap_good as (select * from public.novig_sync_runs where mode = 'snapshot' and status in ('ok', 'warn') order by finished_at desc limit 1),
     disc_good as (select * from public.novig_sync_runs where mode = 'discover' and status in ('ok', 'warn') order by finished_at desc limit 1),
     probe     as (select * from public.novig_sync_runs where mode = 'probe' order by finished_at desc limit 1),
     halt      as (select halt_until, halt_reason from public.novig_sync_runs where halt_until is not null order by finished_at desc limit 1),
     a24 as (select count(*) filter (where severity = 'FAILURE') as failures, count(*) filter (where severity = 'DEGRADED') as degraded,
                    count(*) filter (where severity = 'DRIFT') as drift, count(*) filter (where severity = 'WARNING') as warnings,
                    count(*) filter (where code like 'auth%' or code = 'signature_rejected') as auth_failures,
                    count(*) filter (where code like 'geolocation%') as geolocation, count(*) filter (where code = 'rate_limited') as rate_limited,
                    count(*) filter (where code like 'stream_%') as stream_events
               from public.novig_alerts where created_at > now() - interval '24 hours'),
     s24 as (select count(*) as rows, count(distinct market_id) as markets from public.novig_book_snapshots where captured_at > now() - interval '24 hours'),
     lk  as (select count(*) filter (where invalidated_at is null) as active, count(*) filter (where invalidated_at is null and match_confidence = 'high') as high,
                    count(*) filter (where invalidated_at is not null) as invalidated from public.novig_market_links where kickoff_at > now() - interval '1 day'),
     um  as (select count(*) as open, count(*) filter (where starts_at < now() + make_interval(hours => public.novig_rule('unmapped_window_hours')::int)) as soon
               from public.novig_unmapped where resolved_at is null and (starts_at is null or starts_at > now())),
     fr  as (select count(*) as linked_open,
                    count(*) filter (where s.captured_at > now() - make_interval(mins => public.novig_rule('novig_recent_minutes')::int)) as fresh
               from public.novig_market_links l
               left join lateral (select captured_at from public.novig_book_snapshots x where x.market_id = l.market_id order by captured_at desc limit 1) s on true
              where l.invalidated_at is null and l.kickoff_at > now() and l.kickoff_at < now() + interval '2 days'),
     sz  as (select pg_total_relation_size('public.novig_book_snapshots') as snapshots_bytes, pg_total_relation_size('public.novig_book_depth') as depth_bytes)
select
  (select finished_at from any_run) as last_run_at, (select status from any_run) as last_run_status,
  (select finished_at from snap_any) as last_snapshot_run_at, (select status from snap_any) as last_snapshot_run_status, (select message from snap_any) as last_snapshot_run_message,
  (select finished_at from snap_good) as last_successful_snapshot_at,
  (select finished_at from disc_good) as last_discover_at,
  (select finished_at from probe) as last_probe_at, (select status from probe) as last_probe_status, (select auth from probe) as last_probe_auth,
  (select environment from any_run) as environment, (select clock_offset_ms from any_run) as clock_offset_ms,
  (select halt_until from halt) as halted_until, (select halt_reason from halt) as halt_reason,
  (select rows from s24)::int as snapshot_rows_24h, (select markets from s24)::int as snapshot_markets_24h,
  (select active from lk)::int as links_active, (select high from lk)::int as links_high, (select invalidated from lk)::int as links_invalidated,
  (select open from um)::int as unmapped_open, (select soon from um)::int as unmapped_starting_soon,
  (select linked_open from fr)::int as linked_markets_next_48h, (select fresh from fr)::int as linked_markets_fresh,
  case when (select linked_open from fr) > 0 then round(100.0 * (1 - (select fresh from fr)::numeric / (select linked_open from fr)), 1) end as stale_pct,
  (select snapshots_bytes from sz) as snapshots_bytes, (select depth_bytes from sz) as depth_bytes,
  (select failures from a24)::int as failures_24h, (select degraded from a24)::int as degraded_24h, (select drift from a24)::int as drift_24h, (select warnings from a24)::int as warnings_24h,
  (select auth_failures from a24)::int as auth_failures_24h, (select geolocation from a24)::int as geolocation_24h, (select rate_limited from a24)::int as rate_limited_24h,
  (select stream_events from a24)::int as stream_events_24h,
  coalesce(public.novig_setting('public_display'), 'off') as public_display,
  case
    when (select finished_at from any_run) is null then 'error'
    when (select halt_until from halt) > now() then 'error'
    when (select status from snap_any) = 'error' then 'error'
    when (select finished_at from snap_any) is null
      or now() - (select finished_at from snap_any) > make_interval(mins => public.novig_rule('silent_scheduler_minutes')::int) then 'error'
    when (select failures from a24) > 0 or (select degraded from a24) > 0 or (select drift from a24) > 0
      or (select finished_at from disc_good) is null
      or now() - (select finished_at from disc_good) > make_interval(hours => public.novig_rule('discover_max_age_hours')::int)
      or (select soon from um) > 0 then 'warn'
    else 'ok'
  end as state,
  case
    when (select finished_at from any_run) is null then 'the Novig sync has never run (it is off until NOVIG_INGEST_ENABLED=true and read credentials are set)'
    when (select halt_until from halt) > now() then 'halted until ' || (select halt_until from halt)::text || ': ' || coalesce((select halt_reason from halt), '')
    when (select status from snap_any) = 'error' then 'the last snapshot failed: ' || coalesce((select message from snap_any), 'no message')
    when (select finished_at from snap_any) is null then 'no snapshot run yet'
    when now() - (select finished_at from snap_any) > make_interval(mins => public.novig_rule('silent_scheduler_minutes')::int)
      then 'no snapshot run in over ' || public.novig_rule('silent_scheduler_minutes')::int || ' minutes: the scheduler is not calling the sync'
    when (select finished_at from disc_good) is null then 'discover has not succeeded yet'
    when (select soon from um) > 0 then (select soon from um) || ' Novig market(s) starting soon could not be matched (public.novig_unmapped)'
    else null
  end as state_reason;

create or replace view public.novig_meta with (security_invoker = true) as
select 'novig_snapshot_last_run'::text as key, (select finished_at::text from public.novig_sync_runs where mode = 'snapshot' and status <> 'skipped' order by finished_at desc limit 1) as value
union all select 'novig_snapshot_last_status', (select status from public.novig_sync_runs where mode = 'snapshot' and status <> 'skipped' order by finished_at desc limit 1)
union all select 'row_count_novig_snapshot', (select snapshots_written::text from public.novig_sync_runs where mode = 'snapshot' and status in ('ok', 'warn') order by finished_at desc limit 1)
union all select 'novig_discover_last_run', (select finished_at::text from public.novig_sync_runs where mode = 'discover' and status <> 'skipped' order by finished_at desc limit 1)
union all select 'novig_link_last_run', (select max(linked_at)::text from public.novig_market_links);

-- ---------------------------------------------------------------- access
do $p$ declare t text; begin
  foreach t in array array['novig_events', 'novig_markets', 'novig_book_snapshots', 'novig_book_depth', 'novig_market_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.novig_can_read())', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['novig_unmapped', 'novig_sync_runs', 'novig_alerts', 'novig_config', 'novig_config_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.novig_is_operator())', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $p$;
revoke all on public.novig_readiness, public.novig_meta from anon, authenticated;
grant select on public.novig_readiness, public.novig_meta to authenticated;   -- as the reader: an operator sees rows, anyone else sees an empty ledger
revoke all on function public.novig_keep(), public.novig_market_links_guard(), public.novig_depth_guard(), public.novig_config_audit() from public, anon, authenticated;
revoke all on function public.novig_dk_price(text, text, text, numeric, timestamptz), public.novig_prune(), public.novig_record_unmapped(text, jsonb, text[], text[]),
                       public.novig_is_subscriber() from public, anon, authenticated;
-- the switches hold no secret (public_display, expected_environment): the readiness view reads them as the reader
revoke all on function public.novig_setting(text) from public, anon;
grant execute on function public.novig_setting(text) to authenticated;
revoke all on function public.novig_compare(text, timestamptz, timestamptz, text), public.novig_history(text), public.novig_price_gap_summary(timestamptz, timestamptz),
                       public.novig_access(), public.novig_can_read(), public.novig_is_operator() from public, anon;
grant execute on function public.novig_compare(text, timestamptz, timestamptz, text), public.novig_history(text), public.novig_price_gap_summary(timestamptz, timestamptz),
                          public.novig_access(), public.novig_can_read(), public.novig_is_operator() to authenticated;
grant execute on function public.novig_rule(text) to anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.novig_events, public.novig_markets, public.novig_unmapped to service_role';
    execute 'grant select, insert, update on public.novig_market_links to service_role';
    execute 'grant select, insert on public.novig_book_snapshots, public.novig_book_depth, public.novig_sync_runs, public.novig_alerts to service_role';
    execute 'grant select on public.novig_config, public.novig_config_log, public.novig_readiness, public.novig_meta to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    execute 'grant execute on function public.novig_rule(text), public.novig_setting(text), public.novig_compare(text, timestamptz, timestamptz, text), public.novig_history(text), public.novig_price_gap_summary(timestamptz, timestamptz), public.novig_access(), public.novig_prune(), public.novig_record_unmapped(text, jsonb, text[], text[]) to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok.
select piece, state from (
  select '1 snapshots, runs, alerts and the config log are append-only' as piece,
         case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('novig_book_snapshots_frozen', 'novig_sync_runs_frozen', 'novig_alerts_frozen', 'novig_config_log_frozen',
              'novig_book_snapshots_no_truncate', 'novig_sync_runs_no_truncate', 'novig_alerts_no_truncate', 'novig_config_log_no_truncate')) = 8 then 'ok' else 'CHECK THIS' end as state
  union all select '2 a link is written once (one invalidation); depth only pruned',
         case when exists (select 1 from pg_trigger where tgname = 'novig_market_links_frozen' and not tgisinternal)
               and exists (select 1 from pg_trigger where tgname = 'novig_book_depth_guard' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select '3 row level security on every table',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity and relname in
              ('novig_events', 'novig_markets', 'novig_book_snapshots', 'novig_book_depth', 'novig_market_links', 'novig_unmapped', 'novig_sync_runs', 'novig_alerts', 'novig_config', 'novig_config_log')) = 10 then 'ok' else 'CHECK THIS' end
  union all select '4 no client write policy, no anon read policy',
         case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'novig\_%' escape '\' and (cmd <> 'SELECT' or 'anon' = any(roles))) then 'ok' else 'CHECK THIS' end
  union all select '5 public display is off until Novig''s permission is on record',
         case when public.novig_setting('public_display') = 'off' then 'ok'
              when public.novig_setting('public_display') = 'on' then 'ok (on: see novig_config_log for who switched it and why)' else 'CHECK THIS' end
  union all select '6 the readiness view answers', case when (select count(*) from public.novig_readiness) = 1 then 'ok' else 'CHECK THIS' end
  union all select '7 the DraftKings tape is readable by the layer (sharp_price_snapshots has the columns it reads)',
         case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sharp_price_snapshots'
              and column_name in ('event_id', 'book', 'market', 'side', 'point', 'participant', 'price_dec', 'captured_at', 'book_last_update')) = 9 then 'ok' else 'CHECK THIS' end
) r order by 1;

-- =============================================================================
-- kalshi_market_data.sql — Kalshi prediction-market prices (T0, provider
-- Kalshi), their link to EdgeDesk's NFL and CFB games, and the comparison of
-- the Kalshi mid with EdgeDesk's de-vigged book fair (T2). README §Kalshi
-- market data.
--
-- A NEW DATA SOURCE, NOT A MODEL CHANGE. Nothing here touches a projection,
-- ranking, threshold, EV flag, score, grade or the CLV record. It reads
-- public.signals and public.signal_ticks; it writes neither.
--
-- WHO WRITES. Only supabase/functions/kalshi_sync (service_role).
--   kalshi_series            every Sports series Kalshi lists (discover, daily).
--                            `tracked` is the operator's switch; discover never
--                            writes it
--   kalshi_link_series       which series are NFL / CFB game-winner markets
--                            (one market per team, YES pays if that team wins);
--                            seeded KXNFLGAME and KXNCAAFGAME
--   kalshi_markets           one row per market seen in a tracked series (its
--                            metadata, refreshed each snapshot run)
--   kalshi_price_snapshots   APPEND-ONLY: one row per market per snapshot run
--                            (every 5 minutes), never updated, never deleted
--   kalshi_game_links        APPEND-ONLY: one row per game-winner market that
--                            matched exactly one book event on both teams and
--                            the game date; the only later write allowed is
--                            filling a missing game_id, once. An event that
--                            does not match is left unmapped, never guessed
--   kalshi_sync_runs         APPEND-ONLY: one row per run (ok/warn/error/skipped)
--   kalshi_alerts            APPEND-ONLY: FAILURE / DEGRADED / DRIFT / WARNING
--
-- VIEWS (provenance in brackets)
--   kalshi_snapshot_mid             [T0 + T2] every snapshot with its spread and
--                                   YES mid; the mid is NULL when the quote is
--                                   one-sided or the spread is over 0.06
--   kalshi_closing_snapshot         [T0] the last snapshot at or before each
--                                   market's close: KICKOFF for a linked game
--                                   market, close_time otherwise. Kalshi game
--                                   markets keep trading in-game, their
--                                   close_time sits about 48 hours after
--                                   kickoff (room for a reschedule) and they
--                                   close early once a winner is declared, so
--                                   close_time is not a pregame close
--   kalshi_close_capture_health     [T0] per close day: markets closed, and how
--                                   many had a snapshot within 10 minutes of
--                                   their close (a market with NO snapshot is
--                                   counted as a miss, not dropped)
--   kalshi_book_comparison          [T2] every pregame snapshot of a linked
--                                   market beside the book's de-vigged fair for
--                                   the same team at the nearest capture pass;
--                                   flagged when more than 10 minutes apart;
--                                   rows with spread > 0.06 excluded
--   kalshi_book_closing_comparison  [T2] the Kalshi close (last snapshot before
--                                   kickoff) beside the book close
--                                   (signals.closing_sharp_fair)
--   kalshi_card_current             what one game card shows, with the display
--                                   rule applied in one place
--   kalshi_readiness                the KPIs, one row (System health)
--   kalshi_meta                     {job}_last_run rows for the pipeline ledger
--
-- WHO READS. Kalshi's prices are public, so its tables are readable by anon
-- and authenticated, as the NBA injury layer's are. Every view that touches
-- the book fair runs AS THE READER (security_invoker): public.signals is
-- gated by RLS on has_active_sub(), and a view must not hand that number to
-- anyone the table would not. No client may write anything here.
--
-- THE RULES live in public.kalshi_rule(), not in a config row: changing one
-- is a reviewed code change, not an edit someone can make in the table
-- editor.
--
-- KNOWN LIMITATIONS (stated on every surface that shows this data):
--   * prices are 5-minute snapshots, not live;
--   * a market whose YES spread is over 0.06 has no mid: it is excluded, not
--     estimated;
--   * Kalshi's trading fees are not reflected in the raw gap.
--
-- REQUIRES public.signals and public.signal_ticks (capture) and
-- signals.closing_at_observed (supabase/close_v7_parity.sql).
--
-- OVER THE STARTER. Safe on a database where the starter kalshi_schema.sql
-- ran: its tables and rows are kept and given this layer's columns, and its
-- three views (no data) are replaced. kalshi_market_data_cron.sql removes the
-- starter's cron jobs if they were scheduled.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Mirrored in supabase/migrations/20261021230000_kalshi_market_data.sql.
-- =============================================================================

do $req$ begin
  if to_regclass('public.signals') is null or to_regclass('public.signal_ticks') is null then
    raise exception 'kalshi_market_data.sql needs public.signals and public.signal_ticks (the capture tables): apply capture first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'signals' and column_name = 'closing_at_observed') then
    raise exception 'kalshi_market_data.sql needs signals.closing_at_observed (when the book close was observed): apply supabase/close_v7_parity.sql first';
  end if;
end $req$;

begin;

-- ---------------------------------------------------------------- the guard
create or replace function public.kalshi_keep()
returns trigger language plpgsql as $k$
begin
  raise exception 'public.% is append-only: % refused (write a new row instead)', tg_table_name, tg_op;
end $k$;

-- ---------------------------------------------------------------- the rules (frozen; a change is a code change)
create or replace function public.kalshi_rule(p_key text)
returns numeric language sql immutable as $r$
  select case p_key
    when 'max_spread'               then 0.06  -- YES ask minus YES bid above this: the mid is not trusted, not shown, not compared
    when 'max_fair_gap_minutes'     then 10    -- a book fair further than this from the Kalshi snapshot is flagged
    when 'close_capture_minutes'    then 10    -- a close captured within this of kickoff counts as captured
    when 'stale_snapshot_minutes'   then 15    -- a pregame card whose latest snapshot is older than this is inactive
    when 'silent_scheduler_minutes' then 20    -- no snapshot run of any kind in this long: the scheduler is not calling
    when 'close_capture_target_pct' then 90    -- below this over 7 days, close capture is degraded
    when 'discover_max_age_hours'   then 30    -- no successful discover in this long: degraded
    when 'unmapped_window_hours'    then 30    -- an unmapped game market settling inside this window is a warning
  end
$r$;

-- ---------------------------------------------------------------- series (discover)
create table if not exists public.kalshi_series (
  ticker         text primary key,
  title          text,
  category       text,
  categories     text[] not null default '{}',
  tags           text[] not null default '{}',
  frequency      text,
  tracked        boolean not null default false,   -- the operator's switch: true = snapshot this series every 5 minutes
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- the series whose markets are NFL / CFB game winners (one market per team).
-- Only these are linked to games and compared with the book.
create table if not exists public.kalshi_link_series (
  series_ticker  text primary key,
  sport          text not null check (sport in ('nfl', 'cfb')),
  market_kind    text not null default 'game_winner' check (market_kind = 'game_winner'),
  note           text,
  created_at     timestamptz not null default now()
);
insert into public.kalshi_link_series (series_ticker, sport, note) values
  ('KXNFLGAME',   'nfl', 'Pro football game winner: one market per club, YES pays if that club wins'),
  ('KXNCAAFGAME', 'cfb', 'College football game winner: one market per school, YES pays if that school wins')
on conflict (series_ticker) do nothing;

-- ---------------------------------------------------------------- markets (metadata; refreshed each run)
create table if not exists public.kalshi_markets (
  ticker                    text primary key,
  event_ticker              text not null,
  series_ticker             text not null references public.kalshi_series (ticker),
  market_type               text,
  title                     text,
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
create index if not exists kalshi_markets_event_idx on public.kalshi_markets (event_ticker);
create index if not exists kalshi_markets_series_idx on public.kalshi_markets (series_ticker, status);
create index if not exists kalshi_markets_close_idx on public.kalshi_markets (close_time);

-- THE STARTER SCHEMA, UPGRADED IN PLACE. kalshi_schema.sql (the starter this
-- layer replaced) created kalshi_series, kalshi_markets and
-- kalshi_price_snapshots with fewer columns. On a database where it ran, the
-- tables above already exist and `create table if not exists` leaves them as
-- they are: their rows are kept, and they get the columns this layer and
-- kalshi_sync write. (kalshi_price_snapshots.run_id is added after that table.)
alter table public.kalshi_series add column if not exists first_seen_at timestamptz not null default now();
alter table public.kalshi_series alter column categories set default '{}';
alter table public.kalshi_series alter column tags set default '{}';
alter table public.kalshi_markets add column if not exists title text;

-- ---------------------------------------------------------------- runs and alerts
create table if not exists public.kalshi_sync_runs (
  run_id                 uuid primary key default gen_random_uuid(),
  build                  text,
  trigger                text not null default 'cron' check (trigger in ('cron', 'manual', 'test')),
  mode                   text not null check (mode in ('discover', 'snapshot')),
  status                 text not null check (status in ('ok', 'warn', 'error', 'skipped')),
  skipped_reason         text,
  started_at             timestamptz not null,
  finished_at            timestamptz not null default now(),
  series_found           integer,     -- discover: Sports series listed
  series_tracked         integer,     -- snapshot: tracked series read
  series_failed          text[],
  markets_seen           integer,     -- open markets returned
  markets_snapshotted    integer,     -- snapshot rows written
  markets_beyond_horizon integer,     -- open markets settling past the snapshot horizon (metadata only)
  links_new              integer,
  game_ids_filled        integer,
  unmapped_markets       integer,     -- open game-winner markets still unlinked after this run
  message                text,
  details                jsonb not null default '{}'::jsonb,
  check (finished_at >= started_at)
);
create index if not exists kalshi_sync_runs_finished_idx on public.kalshi_sync_runs (finished_at desc);
create index if not exists kalshi_sync_runs_mode_idx on public.kalshi_sync_runs (mode, finished_at desc);

create table if not exists public.kalshi_alerts (
  id          bigserial primary key,
  run_id      uuid references public.kalshi_sync_runs (run_id),
  severity    text not null check (severity in ('FAILURE', 'DEGRADED', 'DRIFT', 'WARNING')),
  code        text not null,
  message     text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists kalshi_alerts_created_idx on public.kalshi_alerts (created_at desc);

-- ---------------------------------------------------------------- price snapshots (T0, append-only)
create table if not exists public.kalshi_price_snapshots (
  id                 bigint generated always as identity primary key,
  ticker             text not null references public.kalshi_markets (ticker),
  captured_at        timestamptz not null default now(),
  minutes_to_close   numeric,          -- to Kalshi's close_time as Kalshi states it (not kickoff)
  status             text,
  yes_bid            numeric check (yes_bid is null or (yes_bid >= 0 and yes_bid <= 1)),
  yes_ask            numeric check (yes_ask is null or (yes_ask >= 0 and yes_ask <= 1)),
  no_bid             numeric check (no_bid is null or (no_bid >= 0 and no_bid <= 1)),
  no_ask             numeric check (no_ask is null or (no_ask >= 0 and no_ask <= 1)),
  last_price         numeric check (last_price is null or (last_price >= 0 and last_price <= 1)),
  yes_bid_size       numeric,
  yes_ask_size       numeric,
  volume             numeric,
  volume_24h         numeric,
  open_interest      numeric,
  run_id             uuid   -- the run that wrote it (no foreign key: the run row is written last)
);
create index if not exists kalshi_snap_ticker_time_idx on public.kalshi_price_snapshots (ticker, captured_at desc);
create index if not exists kalshi_snap_captured_idx on public.kalshi_price_snapshots (captured_at desc);
alter table public.kalshi_price_snapshots add column if not exists run_id uuid;   -- the starter's table had no run id

-- ---------------------------------------------------------------- game links (append-only; one game-id fill allowed)
create table if not exists public.kalshi_game_links (
  market_ticker     text primary key references public.kalshi_markets (ticker),
  event_ticker      text not null,
  series_ticker     text not null,
  sport             text not null check (sport in ('nfl', 'cfb')),
  kalshi_yes_name   text,                 -- Kalshi's yes_sub_title, as read
  yes_team          text not null,        -- the team YES pays on, as the BOOK names it (= the h2h signals.selection)
  opponent          text not null,
  home_team         text not null,        -- the book event's (signals.home_team / away_team)
  away_team         text not null,
  kickoff_at        timestamptz not null, -- signals.commence_time
  odds_event_id     text not null,        -- signals.event_id
  odds_sport_key    text not null,
  odds_sig_key      text not null,        -- signals.sig_key of the book's h2h row for yes_team: the fair this market is compared with
  game_id           text,                 -- game_research_state.game_id: the card's own id (nflverse for NFL, CFBD for CFB)
  game_key          text,
  game_method       text,
  game_linked_at    timestamptz,
  match_confidence  text not null check (match_confidence in ('high', 'medium')),
  match_method      text not null,
  match_detail      jsonb not null default '{}'::jsonb,
  linker_version    text not null,
  run_id            uuid,
  linked_at         timestamptz not null default now(),
  check (yes_team <> opponent),
  check ((game_id is null) = (game_key is null))
);
create index if not exists kalshi_game_links_game_idx on public.kalshi_game_links (sport, game_id);
create index if not exists kalshi_game_links_event_idx on public.kalshi_game_links (odds_event_id);
create index if not exists kalshi_game_links_kickoff_idx on public.kalshi_game_links (kickoff_at);

-- a link is written once. The one later write: a game id that had not
-- resolved (the research state had not been built yet) may be filled, once,
-- and nothing else on the row may change with it.
create or replace function public.kalshi_game_links_guard()
returns trigger language plpgsql as $g$
declare fill text[] := array['game_id', 'game_key', 'game_method', 'game_linked_at'];
begin
  if tg_op = 'UPDATE' and old.game_id is null and new.game_id is not null
     and (to_jsonb(new) - fill) = (to_jsonb(old) - fill) then
    return new;
  end if;
  raise exception 'public.kalshi_game_links is append-only: % refused (only a missing game id may be filled, once)', tg_op;
end $g$;
drop trigger if exists kalshi_game_links_frozen on public.kalshi_game_links;
create trigger kalshi_game_links_frozen before update or delete on public.kalshi_game_links for each row execute function public.kalshi_game_links_guard();
drop trigger if exists kalshi_game_links_no_truncate on public.kalshi_game_links;
create trigger kalshi_game_links_no_truncate before truncate on public.kalshi_game_links for each statement execute function public.kalshi_keep();

-- append-only: snapshots, runs, alerts
do $t$ declare t text; begin
  foreach t in array array['kalshi_price_snapshots', 'kalshi_sync_runs', 'kalshi_alerts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.kalshi_keep()', t || '_frozen', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.kalshi_keep()', t || '_no_truncate', t);
  end loop;
end $t$;

comment on table public.kalshi_price_snapshots is 'T0 Observed, provider Kalshi: the public order book''s best YES/NO bid and ask, last price, volume and open interest, every 5 minutes. Append-only.';
comment on table public.kalshi_game_links is 'Kalshi game-winner market -> EdgeDesk game: matched on both teams (lib/football_identity.js) and the game date against public.signals, then public.game_research_state for the card id. Unmatched events are not stored.';

-- ---------------------------------------------------------------- views
-- The starter's three views (kalshi_snapshot_mid, kalshi_closing_snapshot,
-- kalshi_close_capture_health) have other columns, and `create or replace
-- view` cannot rename a column. They hold no data: a view still in the
-- starter's shape is dropped here and created below in this layer's.
do $sv$ begin
  if to_regclass('public.kalshi_close_capture_health') is not null and not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'kalshi_close_capture_health' and column_name = 'close_basis') then
    drop view public.kalshi_close_capture_health;
  end if;
  if to_regclass('public.kalshi_closing_snapshot') is not null and not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'kalshi_closing_snapshot' and column_name = 'close_basis') then
    drop view public.kalshi_closing_snapshot;
  end if;
  if to_regclass('public.kalshi_snapshot_mid') is not null and not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'kalshi_snapshot_mid' and column_name = 'mid_excluded_reason') then
    drop view public.kalshi_snapshot_mid;
  end if;
end $sv$;

-- every snapshot with its spread and mid. Two-sided means a real bid (> 0)
-- and a real ask (< 1); the mid is NULL when the quote is not two-sided or
-- the spread is over kalshi_rule('max_spread').
create or replace view public.kalshi_snapshot_mid with (security_invoker = true) as
select s.id, s.ticker, s.captured_at, s.minutes_to_close, s.status, s.yes_bid, s.yes_ask, s.no_bid, s.no_ask, s.last_price,
       s.yes_bid_size, s.yes_ask_size, s.volume, s.volume_24h, s.open_interest, s.run_id,
       (s.yes_bid > 0 and s.yes_ask < 1 and s.yes_ask >= s.yes_bid) is true as two_sided,
       case when s.yes_bid > 0 and s.yes_ask < 1 and s.yes_ask >= s.yes_bid then round(s.yes_ask - s.yes_bid, 4) end as spread,
       case when s.yes_bid > 0 and s.yes_ask < 1 and s.yes_ask >= s.yes_bid and s.yes_ask - s.yes_bid <= public.kalshi_rule('max_spread')
            then round((s.yes_bid + s.yes_ask) / 2, 4) end as yes_mid,
       case when s.yes_bid is null or s.yes_ask is null or s.yes_bid <= 0 or s.yes_ask >= 1 then 'one_sided'
            when s.yes_ask < s.yes_bid then 'crossed'
            when s.yes_ask - s.yes_bid > public.kalshi_rule('max_spread') then 'wide_spread' end as mid_excluded_reason
  from public.kalshi_price_snapshots s;

-- each market's close: kickoff for a linked game market, Kalshi's close_time
-- for any other tracked market. An UNLINKED game-winner market has no
-- pregame close EdgeDesk can name, so it is left out (readiness counts it).
create or replace view public.kalshi_market_close_ref with (security_invoker = true) as
select m.ticker, m.event_ticker, m.series_ticker, m.yes_sub_title, m.close_time, m.status as market_status, m.result, m.first_seen_at,
       case when l.market_ticker is not null then 'kickoff' else 'close_time' end as close_basis,
       coalesce(l.kickoff_at, m.close_time) as close_reference_at,
       l.sport, l.game_id, l.odds_event_id
  from public.kalshi_markets m
  left join public.kalshi_game_links l on l.market_ticker = m.ticker
 where (l.market_ticker is not null or not exists (select 1 from public.kalshi_link_series ls where ls.series_ticker = m.series_ticker))
   and coalesce(l.kickoff_at, m.close_time) is not null;

create or replace view public.kalshi_closing_snapshot with (security_invoker = true) as
select r.ticker, r.event_ticker, r.series_ticker, r.yes_sub_title, r.close_basis, r.close_reference_at, r.close_time, r.market_status, r.result,
       r.sport, r.game_id, r.odds_event_id,
       s.id as snapshot_id, s.captured_at, round(extract(epoch from r.close_reference_at - s.captured_at) / 60, 2) as minutes_before_close,
       s.minutes_to_close, s.yes_bid, s.yes_ask, s.spread, s.yes_mid as close_mid, s.mid_excluded_reason, s.volume, s.open_interest
  from public.kalshi_market_close_ref r
  join lateral (select x.* from public.kalshi_snapshot_mid x
                 where x.ticker = r.ticker and x.captured_at <= r.close_reference_at
                 order by x.captured_at desc, x.id desc limit 1) s on true
 where r.close_reference_at <= now();

-- close capture: every tracked market whose close has passed and that was
-- known before it closed. A market with no snapshot before its close is a
-- miss, counted, never dropped.
create or replace view public.kalshi_close_capture_health with (security_invoker = true) as
with closed as (
  select r.*, s.captured_at as last_at, s.yes_mid as last_mid
    from public.kalshi_market_close_ref r
    join public.kalshi_series sr on sr.ticker = r.series_ticker and sr.tracked
    left join lateral (select x.captured_at, x.yes_mid from public.kalshi_snapshot_mid x
                        where x.ticker = r.ticker and x.captured_at <= r.close_reference_at
                        order by x.captured_at desc, x.id desc limit 1) s on true
   where r.close_reference_at <= now() and r.first_seen_at < r.close_reference_at
)
select (close_reference_at at time zone 'America/New_York')::date as close_day,
       close_basis,
       count(*)::int as markets_closed,
       count(*) filter (where last_at is not null)::int as with_snapshot,
       count(*) filter (where last_at >= close_reference_at - make_interval(mins => public.kalshi_rule('close_capture_minutes')::int))::int as captured_within_10m,
       count(*) filter (where last_at >= close_reference_at - make_interval(mins => public.kalshi_rule('close_capture_minutes')::int) and last_mid is not null)::int as usable_within_10m,
       round(100.0 * count(*) filter (where last_at >= close_reference_at - make_interval(mins => public.kalshi_rule('close_capture_minutes')::int)) / nullif(count(*), 0), 1) as pct_within_10m,
       round(100.0 * count(*) filter (where last_at >= close_reference_at - make_interval(mins => public.kalshi_rule('close_capture_minutes')::int) and last_mid is not null) / nullif(count(*), 0), 1) as pct_usable_within_10m
  from closed
 group by 1, 2
 order by 1 desc, 2;

-- THE COMPARISON (T2). Every pregame snapshot of a linked market whose mid is
-- trusted (two-sided, spread <= 0.06), beside the book's de-vigged fair for
-- the same team at the nearest pregame capture pass (signal_ticks, one row
-- per pass). Nearest either way; a tie goes to the earlier pass.
create or replace view public.kalshi_book_comparison with (security_invoker = true) as
select l.sport, l.game_id, l.odds_event_id, l.event_ticker, l.market_ticker, l.yes_team, l.opponent, l.kickoff_at, l.match_confidence,
       s.id as snapshot_id, s.captured_at, round(extract(epoch from l.kickoff_at - s.captured_at) / 60, 1) as minutes_to_kickoff,
       s.yes_bid as kalshi_yes_bid, s.yes_ask as kalshi_yes_ask, s.yes_mid as kalshi_mid, s.spread as kalshi_spread,
       s.volume as kalshi_volume, s.open_interest as kalshi_open_interest,
       b.sharp_fair as book_fair_prob, b.created_at as book_at, b.n_books as book_n_books,
       round(extract(epoch from b.created_at - s.captured_at) / 60, 1) as time_diff_minutes,
       abs(extract(epoch from b.created_at - s.captured_at)) / 60 > public.kalshi_rule('max_fair_gap_minutes') as time_gap_flag,
       round((s.yes_mid - b.sharp_fair) * 100, 2) as gap_pp,
       'T0'::text as kalshi_tier, 'Kalshi'::text as kalshi_provider, 'T2'::text as comparison_tier
  from public.kalshi_game_links l
  join public.kalshi_snapshot_mid s on s.ticker = l.market_ticker and s.captured_at < l.kickoff_at and s.yes_mid is not null
  join lateral (
    select y.created_at, y.sharp_fair, y.n_books from (
      (select t.created_at, t.sharp_fair, t.n_books from public.signal_ticks t
        where t.sig_key = l.odds_sig_key and t.created_at <= s.captured_at and t.created_at < l.kickoff_at
          and t.sharp_fair > 0 and t.sharp_fair < 1
        order by t.created_at desc limit 1)
      union all
      (select t.created_at, t.sharp_fair, t.n_books from public.signal_ticks t
        where t.sig_key = l.odds_sig_key and t.created_at > s.captured_at and t.created_at < l.kickoff_at
          and t.sharp_fair > 0 and t.sharp_fair < 1
        order by t.created_at asc limit 1)
    ) y
    order by abs(extract(epoch from y.created_at - s.captured_at)), y.created_at
    limit 1) b on true;

-- THE CLOSE (T2). The Kalshi close is the last snapshot taken before kickoff
-- (if that one is wide or one-sided the market has no close mid and is left
-- out, never replaced by an earlier one); the book close is the record's own
-- (signals.closing_sharp_fair, observed at closing_at_observed). A close
-- whose observation time is unknown is flagged.
create or replace view public.kalshi_book_closing_comparison with (security_invoker = true) as
select l.sport, l.game_id, l.odds_event_id, l.event_ticker, l.market_ticker, l.yes_team, l.opponent, l.kickoff_at, l.match_confidence,
       k.id as kalshi_snapshot_id, k.captured_at as kalshi_close_at,
       round(extract(epoch from l.kickoff_at - k.captured_at) / 60, 1) as kalshi_minutes_before_kickoff,
       k.yes_bid as kalshi_yes_bid, k.yes_ask as kalshi_yes_ask, k.yes_mid as kalshi_close_mid, k.spread as kalshi_close_spread,
       k.volume as kalshi_close_volume, k.open_interest as kalshi_close_open_interest,
       g.closing_sharp_fair as book_close_fair, g.closing_at_observed as book_close_at, g.closing_source as book_close_source,
       round(extract(epoch from g.closing_at_observed - k.captured_at) / 60, 1) as time_diff_minutes,
       coalesce(abs(extract(epoch from g.closing_at_observed - k.captured_at)) / 60 > public.kalshi_rule('max_fair_gap_minutes'), true) as time_gap_flag,
       round((k.yes_mid - g.closing_sharp_fair) * 100, 2) as gap_pp,
       m.result as kalshi_result,
       'T0'::text as kalshi_tier, 'Kalshi'::text as kalshi_provider, 'T2'::text as comparison_tier
  from public.kalshi_game_links l
  join public.kalshi_markets m on m.ticker = l.market_ticker
  join lateral (select x.* from public.kalshi_snapshot_mid x
                 where x.ticker = l.market_ticker and x.captured_at <= l.kickoff_at
                 order by x.captured_at desc, x.id desc limit 1) k on true
  join public.signals g on g.sig_key = l.odds_sig_key and g.closing_sharp_fair > 0 and g.closing_sharp_fair < 1
 where l.kickoff_at <= now() and k.yes_mid is not null;

-- THE CARD. One row per linked market for games from a week ago onward. The
-- display rule is applied HERE, once:
--   state  OK                  the latest snapshot is fresh and its mid is trusted
--          WIDE_SPREAD         spread over 0.06: no mid
--          NO_TWO_SIDED_QUOTE  no bid or no ask: no mid
--          STALE               pregame: older than 15 minutes; after kickoff:
--                              the last pregame snapshot was more than 10
--                              minutes before kickoff — no mid either way
--          NO_SNAPSHOT         linked, but never snapshotted before kickoff
--   yes_mid is returned only with OK.
--   The gap is the latest UNFLAGGED comparison row (book fair within 10
--   minutes of a trusted snapshot); before kickoff, from kalshi_book_comparison,
--   after it, the close from kalshi_book_closing_comparison when that is
--   unflagged. None: no gap. A reader who cannot read signals gets none.
create or replace view public.kalshi_card_current with (security_invoker = true) as
with base as (
  select l.*, (now() < l.kickoff_at) as pregame, least(now(), l.kickoff_at) as as_of
    from public.kalshi_game_links l
   where l.kickoff_at > now() - interval '7 days'
), snap as (
  select b.*, s.id as snapshot_id, s.captured_at as snapshot_at, s.yes_bid, s.yes_ask, s.spread, s.yes_mid as raw_mid, s.mid_excluded_reason,
         s.volume, s.volume_24h, s.open_interest, s.last_price, s.status as snapshot_status,
         round(extract(epoch from b.as_of - s.captured_at) / 60, 1) as snapshot_age_minutes
    from base b
    left join lateral (select x.* from public.kalshi_snapshot_mid x
                        where x.ticker = b.market_ticker and x.captured_at <= b.as_of
                        order by x.captured_at desc, x.id desc limit 1) s on true
), judged as (
  select n.*,
         case when n.snapshot_id is null then 'NO_SNAPSHOT'
              when n.snapshot_age_minutes > case when n.pregame then public.kalshi_rule('stale_snapshot_minutes') else public.kalshi_rule('close_capture_minutes') end then 'STALE'
              when n.mid_excluded_reason = 'wide_spread' then 'WIDE_SPREAD'
              when n.mid_excluded_reason is not null then 'NO_TWO_SIDED_QUOTE'
              else 'OK' end as state
    from snap n
)
select j.sport, j.game_id, j.game_key, j.odds_event_id, j.event_ticker, j.market_ticker, j.series_ticker, j.kalshi_yes_name,
       j.yes_team, j.opponent, j.home_team, j.away_team, j.kickoff_at, j.match_confidence, j.pregame,
       j.state, j.snapshot_at, j.snapshot_age_minutes, j.snapshot_status,
       case when j.state = 'OK' then j.raw_mid end as yes_mid,
       j.yes_bid, j.yes_ask, j.spread, j.volume, j.volume_24h, j.open_interest, j.last_price,
       c.basis as gap_basis, c.captured_at as gap_snapshot_at, c.kalshi_mid as gap_kalshi_mid, c.book_fair_prob, c.book_at,
       c.time_diff_minutes, c.gap_pp,
       public.kalshi_rule('max_spread') as rule_max_spread, public.kalshi_rule('max_fair_gap_minutes') as rule_max_fair_gap_minutes
  from judged j
  left join lateral (
    select * from (
      (select 'latest_pregame'::text as basis, k.captured_at, k.kalshi_mid, k.book_fair_prob, k.book_at, k.time_diff_minutes, k.gap_pp
         from public.kalshi_book_comparison k
        where j.pregame and k.market_ticker = j.market_ticker and not k.time_gap_flag
        order by k.captured_at desc limit 1)
      union all
      (select 'close'::text, z.kalshi_close_at, z.kalshi_close_mid, z.book_close_fair, z.book_close_at, z.time_diff_minutes, z.gap_pp
         from public.kalshi_book_closing_comparison z
        where not j.pregame and z.market_ticker = j.market_ticker and not z.time_gap_flag
        limit 1)
    ) u limit 1) c on true;

-- THE KPIs. One row: freshness, failures, degradation, mapping, close capture.
create or replace view public.kalshi_readiness with (security_invoker = true) as
with any_run   as (select * from public.kalshi_sync_runs order by finished_at desc limit 1),
     snap_any  as (select * from public.kalshi_sync_runs where mode = 'snapshot' order by finished_at desc limit 1),
     snap_good as (select * from public.kalshi_sync_runs where mode = 'snapshot' and status in ('ok', 'warn') order by finished_at desc limit 1),
     disc_good as (select * from public.kalshi_sync_runs where mode = 'discover' and status in ('ok', 'warn') order by finished_at desc limit 1),
     a24 as (select count(*) filter (where severity = 'FAILURE') as failures, count(*) filter (where severity = 'DEGRADED') as degraded,
                    count(*) filter (where severity = 'DRIFT') as drift, count(*) filter (where severity = 'WARNING') as warnings
               from public.kalshi_alerts where created_at > now() - interval '24 hours'),
     r24 as (select count(*) filter (where mode = 'snapshot') as snapshot_runs, count(*) filter (where status = 'error') as errors
               from public.kalshi_sync_runs where finished_at > now() - interval '24 hours'),
     s24 as (select count(*) as rows from public.kalshi_price_snapshots where captured_at > now() - interval '24 hours'),
     streak as (select count(*) as n from public.kalshi_sync_runs
                 where mode = 'snapshot' and status = 'error' and finished_at > coalesce((select finished_at from snap_good), '-infinity'::timestamptz)),
     tracked as (select count(*) filter (where tracked) as n, count(*) as listed from public.kalshi_series),
     gm as (select count(*) filter (where l.market_ticker is not null) as linked,
                   count(*) filter (where l.market_ticker is null) as unmapped,
                   count(*) filter (where l.market_ticker is null and coalesce(m.expected_expiration_time, m.close_time) < now() + make_interval(hours => public.kalshi_rule('unmapped_window_hours')::int)) as unmapped_soon
              from public.kalshi_markets m
              join public.kalshi_link_series ls on ls.series_ticker = m.series_ticker
              join public.kalshi_series sr on sr.ticker = m.series_ticker and sr.tracked
              left join public.kalshi_game_links l on l.market_ticker = m.ticker
             where m.status in ('open', 'active') and coalesce(m.expected_expiration_time, m.close_time, now()) > now()),
     cap as (select coalesce(sum(markets_closed), 0) as closed, coalesce(sum(captured_within_10m), 0) as captured, coalesce(sum(usable_within_10m), 0) as usable
               from public.kalshi_close_capture_health
              where close_basis = 'kickoff' and close_day > (now() at time zone 'America/New_York')::date - 7)
select
  (select finished_at from any_run)                                                   as last_run_at,
  (select status from any_run)                                                        as last_run_status,
  (select finished_at from snap_any)                                                  as last_snapshot_run_at,
  (select status from snap_any)                                                       as last_snapshot_run_status,
  (select message from snap_any)                                                      as last_snapshot_run_message,
  (select finished_at from snap_good)                                                 as last_successful_snapshot_at,
  round(extract(epoch from now() - (select finished_at from snap_good)) / 60)::int    as minutes_since_snapshot,
  coalesce((select markets_snapshotted from snap_good), 0)                            as markets_last_snapshot,
  (select finished_at from disc_good)                                                 as last_discover_at,
  (select n from tracked)::int as tracked_series, (select listed from tracked)::int as listed_series,
  (select rows from s24)::int as snapshot_rows_24h,
  (select linked from gm)::int as open_game_markets_linked, (select unmapped from gm)::int as open_game_markets_unmapped,
  (select unmapped_soon from gm)::int as unmapped_settling_soon,
  (select closed from cap)::int as closes_7d, (select captured from cap)::int as closes_captured_7d, (select usable from cap)::int as closes_usable_7d,
  case when (select closed from cap) > 0 then round(100.0 * (select captured from cap) / (select closed from cap), 1) end as close_capture_pct_7d,
  (select n from streak)::int                                                         as consecutive_failures,
  (select failures from a24)::int as failures_24h, (select degraded from a24)::int as degraded_24h,
  (select drift from a24)::int as drift_24h, (select warnings from a24)::int as warnings_24h,
  (select snapshot_runs from r24)::int as snapshot_runs_24h, (select errors from r24)::int as errors_24h,
  case
    when (select finished_at from any_run) is null then 'error'
    when (select status from snap_any) = 'error' then 'error'
    when (select finished_at from snap_any) is null
      or now() - (select finished_at from snap_any) > make_interval(mins => public.kalshi_rule('silent_scheduler_minutes')::int) then 'error'
    when (select failures from a24) > 0 or (select degraded from a24) > 0 or (select drift from a24) > 0
      or (select n from tracked) = 0
      or (select finished_at from snap_good) is null
      or now() - (select finished_at from snap_good) > make_interval(mins => public.kalshi_rule('stale_snapshot_minutes')::int)
      or (select finished_at from disc_good) is null
      or now() - (select finished_at from disc_good) > make_interval(hours => public.kalshi_rule('discover_max_age_hours')::int)
      or (select unmapped_soon from gm) > 0
      or ((select closed from cap) > 0 and 100.0 * (select captured from cap) / (select closed from cap) < public.kalshi_rule('close_capture_target_pct')) then 'warn'
    else 'ok'
  end as state,
  case
    when (select finished_at from any_run) is null then 'the Kalshi sync has never run'
    when (select status from snap_any) = 'error' then 'the last snapshot failed: ' || coalesce((select message from snap_any), 'no message')
    when (select finished_at from snap_any) is null then 'no snapshot run yet (only discover has run)'
    when now() - (select finished_at from snap_any) > make_interval(mins => public.kalshi_rule('silent_scheduler_minutes')::int)
      then 'no snapshot run in over ' || public.kalshi_rule('silent_scheduler_minutes')::int || ' minutes: the scheduler is not calling the sync'
    when (select n from tracked) = 0 then 'no series is tracked: set kalshi_series.tracked = true on the game series'
    when (select finished_at from disc_good) is null then 'discover has not succeeded yet'
    when now() - (select finished_at from disc_good) > make_interval(hours => public.kalshi_rule('discover_max_age_hours')::int) then 'discover has not succeeded in over ' || public.kalshi_rule('discover_max_age_hours')::int || ' hours'
    when (select unmapped_soon from gm) > 0 then (select unmapped_soon from gm) || ' game market(s) settling soon could not be matched to a game'
    when (select closed from cap) > 0 and 100.0 * (select captured from cap) / (select closed from cap) < public.kalshi_rule('close_capture_target_pct')
      then 'close capture ' || round(100.0 * (select captured from cap) / (select closed from cap), 1) || '% over 7 days (target ' || public.kalshi_rule('close_capture_target_pct')::int || '%)'
    else null
  end as state_reason
;

-- the research module's pipeline ledger reads {job}_last_run / {job}_last_status / row_count_{job}
create or replace view public.kalshi_meta with (security_invoker = true) as
select 'kalshi_snapshot_last_run'::text as key, (select finished_at::text from public.kalshi_sync_runs where mode = 'snapshot' and status <> 'skipped' order by finished_at desc limit 1) as value
union all select 'kalshi_snapshot_last_status', (select status from public.kalshi_sync_runs where mode = 'snapshot' and status <> 'skipped' order by finished_at desc limit 1)
union all select 'row_count_kalshi_snapshot', (select markets_snapshotted::text from public.kalshi_sync_runs where mode = 'snapshot' and status in ('ok', 'warn') order by finished_at desc limit 1)
union all select 'kalshi_discover_last_run', (select finished_at::text from public.kalshi_sync_runs where mode = 'discover' and status <> 'skipped' order by finished_at desc limit 1)
union all select 'kalshi_discover_last_status', (select status from public.kalshi_sync_runs where mode = 'discover' and status <> 'skipped' order by finished_at desc limit 1)
union all select 'kalshi_link_last_run', (select max(linked_at)::text from public.kalshi_game_links);

-- ---------------------------------------------------------------- access
do $p$ declare t text; begin
  foreach t in array array['kalshi_series', 'kalshi_link_series', 'kalshi_markets', 'kalshi_price_snapshots', 'kalshi_game_links', 'kalshi_sync_runs', 'kalshi_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $p$;
-- the views run as the reader; those that touch signals answer only what the reader may read there
grant select on public.kalshi_snapshot_mid, public.kalshi_market_close_ref, public.kalshi_closing_snapshot, public.kalshi_close_capture_health,
                public.kalshi_book_comparison, public.kalshi_book_closing_comparison, public.kalshi_card_current,
                public.kalshi_readiness, public.kalshi_meta to anon, authenticated;
revoke all on function public.kalshi_keep() from public, anon, authenticated;
revoke all on function public.kalshi_game_links_guard() from public, anon, authenticated;
grant execute on function public.kalshi_rule(text) to anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.kalshi_series, public.kalshi_markets to service_role';
    execute 'grant select, insert, update on public.kalshi_game_links to service_role';
    execute 'grant select, insert on public.kalshi_price_snapshots, public.kalshi_sync_runs, public.kalshi_alerts to service_role';
    execute 'grant select on public.kalshi_link_series to service_role';
    execute 'grant select on public.kalshi_snapshot_mid, public.kalshi_market_close_ref, public.kalshi_closing_snapshot, public.kalshi_close_capture_health, public.kalshi_book_comparison, public.kalshi_book_closing_comparison, public.kalshi_card_current, public.kalshi_readiness, public.kalshi_meta to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    execute 'grant execute on function public.kalshi_rule(text) to service_role';
  end if;
end $g$;

commit;

notify pgrst, 'reload schema';

-- THE REPORT. Every row should say ok (row 8 says pending until a series is tracked).
select piece, state from (
  select '1 snapshots, runs and alerts are append-only' as piece,
         case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('kalshi_price_snapshots_frozen', 'kalshi_sync_runs_frozen', 'kalshi_alerts_frozen',
              'kalshi_price_snapshots_no_truncate', 'kalshi_sync_runs_no_truncate', 'kalshi_alerts_no_truncate')) = 6 then 'ok' else 'CHECK THIS' end as state
  union all select '2 a game link is written once (one game-id fill)',
         case when exists (select 1 from pg_trigger where tgname = 'kalshi_game_links_frozen' and not tgisinternal) then 'ok' else 'CHECK THIS' end
  union all select '3 row level security on every table',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity and relname in
              ('kalshi_series', 'kalshi_link_series', 'kalshi_markets', 'kalshi_price_snapshots', 'kalshi_game_links', 'kalshi_sync_runs', 'kalshi_alerts')) = 7 then 'ok' else 'CHECK THIS' end
  union all select '4 no client write policy',
         case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'kalshi\_%' escape '\' and cmd <> 'SELECT') then 'ok' else 'CHECK THIS' end
  union all select '5 every view runs as the reader (the book fair stays behind signals'' own access rule)',
         case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' and relname like 'kalshi\_%' escape '\') >= 9
               and not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' and relname like 'kalshi\_%' escape '\'
                                  and coalesce(reloptions::text, '') not like '%security_invoker=true%') then 'ok' else 'CHECK THIS' end
  union all select '6 the readiness view answers', case when (select count(*) from public.kalshi_readiness) = 1 then 'ok' else 'CHECK THIS' end
  union all select '7 the game-winner series are named', case when (select count(*) from public.kalshi_link_series) >= 1 then 'ok' else 'CHECK THIS' end
  union all select '8 a series is tracked',
         case when exists (select 1 from public.kalshi_series where tracked) then 'ok'
              else 'pending: run kalshi_sync discover, then update public.kalshi_series set tracked = true where ticker in (select series_ticker from public.kalshi_link_series);' end
  union all select '10 the tables carry every column kalshi_sync writes (a starter schema is upgraded in place)',
         case when (select count(*) from information_schema.columns where table_schema = 'public' and (table_name, column_name) in
              (('kalshi_series', 'first_seen_at'), ('kalshi_markets', 'title'), ('kalshi_price_snapshots', 'run_id'))) = 3
               and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'kalshi_snapshot_mid' and column_name = 'mid_excluded_reason')
              then 'ok' else 'CHECK THIS' end
  union all select '9 the capture tick index the comparison reads through',
         case when exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'signal_ticks' and indexdef like '%(sig_key, created_at%') then 'ok'
              else 'CHECK THIS (apply capture_v9_qualification.sql: without it every comparison scans signal_ticks)' end
) r order by 1;

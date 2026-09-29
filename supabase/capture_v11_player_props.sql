-- =============================================================================
-- capture_v11_player_props — the storage capture-v11-player-props writes.
--
-- Paste into the Supabase SQL editor and run BEFORE deploying capture v11.
-- Safe to run again. Needs capture_v9_qualification.sql first (it adds the
-- `signals` columns this file sits beside).
--
-- WHAT IT ADDS
--   1. signals: participant, participant_key, is_player_prop, source_market.
--      Written ONLY on player rows, and only when CAPTURE_PLAYER_PROP_SIGNALS is
--      on. Every game-market row keeps its v9 shape and its sig_key; an
--      existing row reads is_player_prop = false.
--   2. player_prop_quotes — the CURRENT price of every player quote capture
--      has seen: one row per (event, market, player, side, line, book), upserted
--      on quote_key. Every quote, qualified or not, fresh or stale, one-sided
--      or two: this is what a reader line-shops from.
--   3. player_prop_quote_ticks — the history: the database appends a tick when
--      a quote first appears and whenever its price changes, never when a run
--      merely re-sees the same price. Line movement, the close and CLV read it.
--   4. player_prop_event_polls — each event's last prop poll, the clock capture
--      reads so the DAY tier does not re-buy a full prop board every 30 minutes.
--   5. player_prop_identities — EMPTY. The Odds API gives a player's name, not
--      an identity; this is where a real roster source (nflverse, ESPN) joins
--      (event_id, player_key) to a player id, team and position later.
--      Nothing in capture pretends a normalised name is a player id.
--   6. View player_prop_best_quotes — the best current price per selection.
--
-- CONVENTION (supabase/README.md): idempotent, additive, no psql
-- meta-commands, ends in a report whose rows say ok.
-- Tested by tools/capture/migration.test.js against a real PostgreSQL.
-- =============================================================================

begin;

-- ── 1. SIGNALS: the player on a player row ───────────────────────────────────
alter table public.signals
  add column if not exists participant     text,
  add column if not exists participant_key text,
  add column if not exists is_player_prop  boolean not null default false,
  add column if not exists source_market   text;

comment on column public.signals.participant_key is
  'playerKey() of the book''s player name, scoped to the event. Part of a player row''s sig_key '
  '(event|market|participant_key|selection|point). A normalised name, NOT a player id.';
comment on column public.signals.source_market is
  'Provider market of the best quote on a player row (standard or *_alternate). NULL on game rows.';

create index if not exists signals_event_market_participant_idx
  on public.signals (event_id, market, participant_key);
create index if not exists signals_sport_commence_prop_idx
  on public.signals (sport_key, commence_time, is_player_prop);

-- ── 2. THE CURRENT QUOTE ─────────────────────────────────────────────────────
create table if not exists public.player_prop_quotes (
  quote_key             text primary key,
  event_id              text not null,
  sport_key             text not null,
  sport_title           text,
  commence_time         timestamptz,
  home_team             text,
  away_team             text,
  player_name           text not null,
  player_key            text not null,
  market                text not null,
  source_market         text not null,
  side                  text not null,
  point                 numeric,
  book_key              text not null,
  book_title            text,
  decimal_odds          numeric not null,
  opposite_decimal_odds numeric,
  book_fair_probability numeric,
  quote_age_s           integer,
  is_fresh              boolean not null default false,
  source_updated_at     timestamptz,
  captured_at           timestamptz not null,
  is_two_sided          boolean not null default false,
  qualifiable           boolean not null default false,
  unqualifiable_reason  text,
  first_seen_at         timestamptz,
  first_decimal_odds    numeric,
  price_changed_at      timestamptz
);

-- Shape rules, added only if missing. A quote that breaks one is a capture bug,
-- and the database refuses it rather than storing it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_market_chk') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_market_chk
      check (market ~ '^player_[a-z0-9_]+$' and source_market ~ '^player_[a-z0-9_]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_identity_chk') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_identity_chk
      check (length(player_key) > 0 and length(side) > 0 and length(book_key) > 0 and length(event_id) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_price_chk') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_price_chk
      check (decimal_odds > 1 and (opposite_decimal_odds is null or opposite_decimal_odds > 1));
  end if;
  -- A fair probability exists exactly when the book quoted both sides: a
  -- one-sided quote with a fair value would be a number built on an invented side.
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_fair_chk') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_fair_chk
      check (is_two_sided = (book_fair_probability is not null)
             and (book_fair_probability is null or (book_fair_probability > 0 and book_fair_probability < 1)));
  end if;
end $$;

comment on table public.player_prop_quotes is
  'Current price of every player-prop quote capture has seen, one row per (event, market, player_key, '
  'side, point, book). Upserted by capture v11; history is in player_prop_quote_ticks.';
comment on column public.player_prop_quotes.player_key is
  'The book''s player name folded for case, accents, periods, apostrophes and spacing — scoped to the event, '
  'never merged across a suffix. NOT a player id: join player_prop_identities for one.';
comment on column public.player_prop_quotes.book_fair_probability is
  'This book''s own devigged probability for this side at this line. NULL when the book quoted one side only.';
comment on column public.player_prop_quotes.price_changed_at is
  'Set by the database: the capture instant at which this price last changed. Capture reads it back to count ticks.';

create index if not exists player_prop_quotes_event_idx
  on public.player_prop_quotes (event_id, market, player_key, side, point);
create index if not exists player_prop_quotes_board_idx
  on public.player_prop_quotes (sport_key, commence_time);

-- The opening never moves, and price_changed_at is the database's own stamp.
create or replace function public.player_prop_quotes_track()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'INSERT' then
    NEW.first_seen_at      := coalesce(NEW.first_seen_at, NEW.captured_at);
    NEW.first_decimal_odds := coalesce(NEW.first_decimal_odds, NEW.decimal_odds);
    NEW.price_changed_at   := NEW.captured_at;
    return NEW;
  end if;
  NEW.first_seen_at      := OLD.first_seen_at;
  NEW.first_decimal_odds := OLD.first_decimal_odds;
  if NEW.decimal_odds is distinct from OLD.decimal_odds
     or NEW.opposite_decimal_odds is distinct from OLD.opposite_decimal_odds then
    NEW.price_changed_at := NEW.captured_at;
  else
    NEW.price_changed_at := OLD.price_changed_at;
  end if;
  return NEW;
end $$;

drop trigger if exists player_prop_quotes_track_trg on public.player_prop_quotes;
create trigger player_prop_quotes_track_trg
  before insert or update on public.player_prop_quotes
  for each row execute function public.player_prop_quotes_track();

-- ── 3. THE HISTORY ───────────────────────────────────────────────────────────
create table if not exists public.player_prop_quote_ticks (
  id                    bigserial primary key,
  quote_key             text not null,
  event_id              text not null,
  sport_key             text,
  commence_time         timestamptz,
  player_key            text not null,
  player_name           text,
  market                text not null,
  source_market         text,
  side                  text not null,
  point                 numeric,
  book_key              text not null,
  decimal_odds          numeric not null,
  opposite_decimal_odds numeric,
  book_fair_probability numeric,
  is_fresh              boolean,
  source_updated_at     timestamptz,
  captured_at           timestamptz not null
);
create unique index if not exists player_prop_quote_ticks_once_idx
  on public.player_prop_quote_ticks (quote_key, captured_at);
create index if not exists player_prop_quote_ticks_event_idx
  on public.player_prop_quote_ticks (event_id, market, player_key, side, point, captured_at);
create index if not exists player_prop_quote_ticks_captured_idx
  on public.player_prop_quote_ticks (captured_at);

comment on table public.player_prop_quote_ticks is
  'One row when a player quote first appears and one each time its price changes. Written by the '
  'player_prop_quotes trigger, never by capture directly; a run that re-sees the same price adds nothing.';

create or replace function public.player_prop_quotes_tick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and NEW.price_changed_at is not distinct from OLD.price_changed_at then
    return null;
  end if;
  insert into public.player_prop_quote_ticks (
    quote_key, event_id, sport_key, commence_time, player_key, player_name, market, source_market,
    side, point, book_key, decimal_odds, opposite_decimal_odds, book_fair_probability, is_fresh,
    source_updated_at, captured_at)
  values (
    NEW.quote_key, NEW.event_id, NEW.sport_key, NEW.commence_time, NEW.player_key, NEW.player_name,
    NEW.market, NEW.source_market, NEW.side, NEW.point, NEW.book_key, NEW.decimal_odds,
    NEW.opposite_decimal_odds, NEW.book_fair_probability, NEW.is_fresh, NEW.source_updated_at,
    NEW.captured_at)
  on conflict (quote_key, captured_at) do nothing;
  return null;
end $$;

drop trigger if exists player_prop_quotes_tick_trg on public.player_prop_quotes;
create trigger player_prop_quotes_tick_trg
  after insert or update on public.player_prop_quotes
  for each row execute function public.player_prop_quotes_tick();

-- A tick is an observation. It can be pruned; it cannot be edited.
create or replace function public.player_prop_quote_ticks_frozen()
returns trigger
language plpgsql
as $$
begin
  raise exception 'player_prop_quote_ticks is append-only: a recorded price is never edited';
end $$;

drop trigger if exists player_prop_quote_ticks_frozen_trg on public.player_prop_quote_ticks;
create trigger player_prop_quote_ticks_frozen_trg
  before update on public.player_prop_quote_ticks
  for each row execute function public.player_prop_quote_ticks_frozen();

-- ── 4. EACH EVENT'S PROP CLOCK ───────────────────────────────────────────────
create table if not exists public.player_prop_event_polls (
  event_id          text primary key,
  sport_key         text not null,
  commence_time     timestamptz,
  home_team         text,
  away_team         text,
  last_polled_at    timestamptz not null,
  markets_requested integer,
  markets_returned  integer,
  requests_failed   integer,
  credits_spent     numeric,
  quotes            integer,
  players           integer,
  poll_status       text
);
create index if not exists player_prop_event_polls_commence_idx
  on public.player_prop_event_polls (commence_time);

comment on table public.player_prop_event_polls is
  'The last successful player-prop poll of each event and what it cost. Capture reads it to decide which '
  'events are due (CAPTURE_PLAYER_PROP_INTERVAL_MIN / _NEAR_INTERVAL_MIN).';

-- ── 5. WHERE A REAL PLAYER IDENTITY WILL JOIN ────────────────────────────────
create table if not exists public.player_prop_identities (
  event_id    text not null,
  player_key  text not null,
  player_id   text not null,
  id_source   text not null,
  team        text,
  position    text,
  matched_at  timestamptz not null default now(),
  primary key (event_id, player_key)
);
comment on table public.player_prop_identities is
  'Empty until a roster source writes it: which real player a book''s name means in one event. Capture '
  'never writes here — a name is not an id, and an ambiguous name must stay unmatched.';

-- ── 6. LINE SHOPPING ─────────────────────────────────────────────────────────
create or replace view public.player_prop_best_quotes with (security_invoker = true) as
select distinct on (event_id, market, player_key, side, point)
       event_id, sport_key, commence_time, home_team, away_team, player_name, player_key,
       market, side, point, book_key, book_title, source_market, decimal_odds,
       book_fair_probability, is_fresh, quote_age_s, captured_at
  from public.player_prop_quotes
 order by event_id, market, player_key, side, point, is_fresh desc, decimal_odds desc, book_key;

-- ── 7. ACCESS: signed-in readers read; only the service role writes ─────────
alter table public.player_prop_quotes      enable row level security;
alter table public.player_prop_quote_ticks enable row level security;
alter table public.player_prop_event_polls enable row level security;
alter table public.player_prop_identities  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['player_prop_quotes', 'player_prop_quote_ticks', 'player_prop_event_polls', 'player_prop_identities'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete on public.%I from authenticated', t);
      execute format('grant select on public.%I to authenticated', t);
      execute format('drop policy if exists %I on public.%I', t || '_read', t);
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.player_prop_best_quotes to authenticated';
  end if;
end $$;

commit;

-- ── 8. THE REPORT ────────────────────────────────────────────────────────────
-- Every row should say ok.
with checks as (
  select 1 as n, 'signals.participant exists' as check_name,
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='participant')::int as got, 1 as want
  union all select 2, 'signals.participant_key exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='participant_key')::int, 1
  union all select 3, 'signals.is_player_prop exists, not null',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='is_player_prop'
             and is_nullable='NO')::int, 1
  union all select 4, 'signals.source_market exists',
         (select count(*) from information_schema.columns
           where table_schema='public' and table_name='signals' and column_name='source_market')::int, 1
  union all select 5, 'signals player index exists',
         (select count(*) from pg_indexes where schemaname='public'
            and indexname in ('signals_event_market_participant_idx','signals_sport_commence_prop_idx'))::int, 2
  union all select 6, 'no game-market signal is marked as a player prop',
         (select count(*) from public.signals where is_player_prop and market !~ '^player_')::int, 0
  union all select 7, 'player_prop_quotes exists with quote_key as its key',
         (select count(*) from pg_constraint
           where conrelid='public.player_prop_quotes'::regclass and contype='p')::int, 1
  union all select 8, 'player_prop_quotes shape rules are in place',
         (select count(*) from pg_constraint where conname in
           ('player_prop_quotes_market_chk','player_prop_quotes_identity_chk',
            'player_prop_quotes_price_chk','player_prop_quotes_fair_chk'))::int, 4
  union all select 9, 'player_prop_quote_ticks exists',
         (select count(*) from information_schema.tables
           where table_schema='public' and table_name='player_prop_quote_ticks')::int, 1
  union all select 10, 'one tick per quote per capture instant',
         (select count(*) from pg_indexes where schemaname='public'
            and indexname='player_prop_quote_ticks_once_idx')::int, 1
  union all select 11, 'the quote table carries its track and tick triggers',
         (select count(*) from pg_trigger where tgrelid='public.player_prop_quotes'::regclass
            and tgname in ('player_prop_quotes_track_trg','player_prop_quotes_tick_trg') and not tgisinternal)::int, 2
  union all select 12, 'a recorded tick cannot be edited',
         (select count(*) from pg_trigger where tgrelid='public.player_prop_quote_ticks'::regclass
            and tgname='player_prop_quote_ticks_frozen_trg' and not tgisinternal)::int, 1
  union all select 13, 'player_prop_event_polls exists with event_id as its key',
         (select count(*) from pg_constraint
           where conrelid='public.player_prop_event_polls'::regclass and contype='p')::int, 1
  union all select 14, 'player_prop_identities exists (empty until a roster source joins)',
         (select count(*) from information_schema.tables
           where table_schema='public' and table_name='player_prop_identities')::int, 1
  union all select 15, 'RLS is on for all four player-prop tables',
         (select count(*) from pg_class where relrowsecurity and oid in
           ('public.player_prop_quotes'::regclass, 'public.player_prop_quote_ticks'::regclass,
            'public.player_prop_event_polls'::regclass, 'public.player_prop_identities'::regclass))::int, 4
  union all select 16, 'player_prop_best_quotes view exists',
         (select count(*) from information_schema.views
           where table_schema='public' and table_name='player_prop_best_quotes')::int, 1
)
select n, check_name, got, want, case when got = want then 'ok' else 'CHECK THIS' end as status
from checks order by n;

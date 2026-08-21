-- ============================================================================
-- Model Collective — centralized NFL odds infrastructure
--
-- One ingestion path (provider -> edge function -> here), one canonical
-- representation, one read surface. Everything the Collective shows about a
-- market comes out of these tables; nothing in the browser ever talks to an
-- odds provider.
--
-- Layout
--   odds.*        storage and logic. Never exposed through PostgREST.
--   collective.*  the thin API surface (odds_* views and RPCs). The collective
--                 schema is already exposed to PostgREST, so the edge
--                 functions reach the odds layer without a project-level
--                 schema config change. Every added object is granted to
--                 service_role only, so the anon key cannot read odds
--                 directly and the gate stays server side.
--
-- History is append-only: odds.snapshots keeps every price change forever.
-- Opening lines are a view over the first snapshot (immutable by
-- construction). Closing lines are written once, only after a market has
-- actually closed, so nothing can pass a current price off as a close.
-- ============================================================================

create schema if not exists odds;

-- ---------------------------------------------------------------- settings
-- Every tunable lives here so no interval or book list is hardcoded in more
-- than one place. The edge functions read these; nothing is compiled in.
create table if not exists odds.settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

insert into odds.settings (key, value, description) values
  ('nfl.enabled',                 'true'::jsonb,        'Master switch for NFL odds ingestion'),
  ('nfl.league_id',               '"nfl"'::jsonb,       'Provider league identifier for the NFL'),
  ('nfl.refresh_seconds.live',    '60'::jsonb,          'Poll interval while at least one NFL game is in progress'),
  ('nfl.refresh_seconds.pregame', '300'::jsonb,         'Poll interval when a game kicks off within the pregame window'),
  ('nfl.refresh_seconds.idle',    '1800'::jsonb,        'Poll interval when no game is near'),
  ('nfl.pregame_window_hours',    '36'::jsonb,          'Hours before kickoff that counts as the pregame window'),
  ('nfl.stale_after_seconds',     '900'::jsonb,         'Age at which the read API stops calling a price current'),
  ('nfl.max_books_per_run',       '12'::jsonb,          'Upper bound on provider requests in a single ingest run'),
  ('nfl.books',
    '["pinnacle","draftkings","fanduel","betmgm","caesars","espnbet","bet365","betrivers"]'::jsonb,
    'Sportsbooks requested each run, in priority order'),
  ('nfl.markets',
    '["moneyline","spread","total"]'::jsonb,
    'Canonical markets stored for NFL game lines'),
  ('nfl.close_grace_minutes',     '0'::jsonb,           'Minutes after kickoff before a market may be finalized as closed'),
  ('nfl.book_stale_seconds',      '5400'::jsonb,        'How far behind the freshest price a book may be and still count toward consensus'),
  ('provider.default',            '"oddsblaze"'::jsonb, 'Provider used for NFL odds')
on conflict (key) do nothing;

create or replace function odds.get_setting(p_key text)
returns jsonb language sql stable as $$
  select value from odds.settings where key = p_key;
$$;

-- How stale a single book's price may be and still count.
--
-- current_main_state keeps the newest price per book forever, so a book that
-- takes a market down, or that the run stops requesting, would otherwise go
-- on voting in the consensus and offering a "best price" nobody can take.
-- Measured against the freshest price ON THAT GAME, not against now, so a
-- settled game whose prices are all equally old keeps its whole book list.
create or replace function odds.book_stale_seconds()
returns integer language sql stable as $$
  select coalesce((odds.get_setting('nfl.book_stale_seconds'))::text::int, 5400);
$$;

-- --------------------------------------------------------------- providers
create table if not exists odds.providers (
  id         text primary key,
  name       text not null,
  enabled    boolean not null default true,
  notes      text,
  created_at timestamptz not null default now()
);

insert into odds.providers (id, name, notes) values
  ('oddsblaze', 'OddsBlaze',
   'REST pull. Credential lives only in the NFL_ODDS_API_KEY edge function secret.')
on conflict (id) do nothing;

-- ------------------------------------------------------------------- books
-- A sportsbook is a first-class row, not a string on a price. is_sharp marks
-- books whose number is a reference, not a retail price: they are reported
-- separately and never blended into the retail consensus.
create table if not exists odds.books (
  id                   text primary key,
  name                 text not null,
  is_sharp             boolean not null default false,
  include_in_consensus boolean not null default true,
  priority             smallint not null default 100,
  enabled              boolean not null default true,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz
);

insert into odds.books (id, name, is_sharp, include_in_consensus, priority) values
  ('pinnacle',    'Pinnacle',     true,  false, 10),
  ('circa',       'Circa',        true,  false, 15),
  ('bookmaker',   'BookMaker',    true,  false, 20),
  ('draftkings',  'DraftKings',   false, true,  30),
  ('fanduel',     'FanDuel',      false, true,  31),
  ('betmgm',      'BetMGM',       false, true,  32),
  ('caesars',     'Caesars',      false, true,  33),
  ('espnbet',     'ESPN BET',     false, true,  34),
  ('bet365',      'bet365',       false, true,  35),
  ('betrivers',   'BetRivers',    false, true,  36),
  ('fanatics',    'Fanatics',     false, true,  37),
  ('hardrock',    'Hard Rock Bet',false, true,  38),
  ('novig',       'Novig',        false, true,  40),
  ('prophetx',    'ProphetX',     false, true,  41)
on conflict (id) do nothing;

-- ----------------------------------------------------------------- markets
-- kind separates game lines from the prop and futures families, so adding
-- player props later is new rows here, not a schema rebuild.
create table if not exists odds.markets (
  id            text primary key,
  name          text not null,
  kind          text not null default 'game'
                check (kind in ('game','team_prop','player_prop','future','other')),
  has_line      boolean not null default false,
  two_sided     boolean not null default true,
  enabled       boolean not null default true,
  auto_added    boolean not null default false,
  first_seen_at timestamptz not null default now()
);

insert into odds.markets (id, name, kind, has_line, two_sided, enabled) values
  ('moneyline',        'Moneyline',            'game', false, true,  true),
  ('spread',           'Point Spread',         'game', true,  true,  true),
  ('total',            'Total Points',         'game', true,  true,  true),
  ('team_total',       'Team Total',           'team_prop', true, true, false),
  ('alternate_spread', 'Alternate Spread',     'game', true,  true,  false),
  ('alternate_total',  'Alternate Total',      'game', true,  true,  false)
on conflict (id) do nothing;

-- ------------------------------------------------------------ team aliases
-- Provider team strings, Collective team codes, and everything a human might
-- type all resolve to one code. Without this the same game arrives twice
-- under two spellings.
create or replace function odds.norm_text(p_in text)
returns text language sql immutable as $$
  select nullif(regexp_replace(lower(coalesce(p_in,'')), '[^a-z0-9]', '', 'g'), '');
$$;

create table if not exists odds.team_aliases (
  league     text not null,
  alias_norm text not null,
  team_code  text not null,
  source     text not null default 'seed',
  created_at timestamptz not null default now(),
  primary key (league, alias_norm)
);

create index if not exists team_aliases_code_idx on odds.team_aliases (league, team_code);

-- Seeds: canonical code, then every spelling that maps to it. Codes match the
-- abbreviations the Collective slate upload already uses (KC, BUF, DAL, NYG).
insert into odds.team_aliases (league, alias_norm, team_code, source)
select 'nfl', odds.norm_text(alias), code, 'seed'
from (values
  ('ARI','Arizona Cardinals'),('ARI','Arizona'),('ARI','Cardinals'),('ARI','ARI'),('ARI','ARZ'),('ARI','CRD'),
  ('ATL','Atlanta Falcons'),('ATL','Atlanta'),('ATL','Falcons'),('ATL','ATL'),
  ('BAL','Baltimore Ravens'),('BAL','Baltimore'),('BAL','Ravens'),('BAL','BAL'),('BAL','RAV'),
  ('BUF','Buffalo Bills'),('BUF','Buffalo'),('BUF','Bills'),('BUF','BUF'),
  ('CAR','Carolina Panthers'),('CAR','Carolina'),('CAR','Panthers'),('CAR','CAR'),
  ('CHI','Chicago Bears'),('CHI','Chicago'),('CHI','Bears'),('CHI','CHI'),
  ('CIN','Cincinnati Bengals'),('CIN','Cincinnati'),('CIN','Bengals'),('CIN','CIN'),
  ('CLE','Cleveland Browns'),('CLE','Cleveland'),('CLE','Browns'),('CLE','CLE'),('CLE','CLV'),
  ('DAL','Dallas Cowboys'),('DAL','Dallas'),('DAL','Cowboys'),('DAL','DAL'),
  ('DEN','Denver Broncos'),('DEN','Denver'),('DEN','Broncos'),('DEN','DEN'),
  ('DET','Detroit Lions'),('DET','Detroit'),('DET','Lions'),('DET','DET'),
  ('GB','Green Bay Packers'),('GB','Green Bay'),('GB','Packers'),('GB','GB'),('GB','GNB'),('GB','GBP'),
  ('HOU','Houston Texans'),('HOU','Houston'),('HOU','Texans'),('HOU','HOU'),('HOU','HST'),
  ('IND','Indianapolis Colts'),('IND','Indianapolis'),('IND','Colts'),('IND','IND'),('IND','CLT'),
  ('JAX','Jacksonville Jaguars'),('JAX','Jacksonville'),('JAX','Jaguars'),('JAX','JAX'),('JAX','JAC'),
  ('KC','Kansas City Chiefs'),('KC','Kansas City'),('KC','Chiefs'),('KC','KC'),('KC','KAN'),('KC','KCC'),
  ('LV','Las Vegas Raiders'),('LV','Las Vegas'),('LV','Raiders'),('LV','LV'),('LV','LVR'),('LV','OAK'),('LV','Oakland Raiders'),
  ('LAC','Los Angeles Chargers'),('LAC','LA Chargers'),('LAC','Chargers'),('LAC','LAC'),('LAC','SD'),('LAC','SDG'),('LAC','San Diego Chargers'),
  ('LAR','Los Angeles Rams'),('LAR','LA Rams'),('LAR','Rams'),('LAR','LAR'),('LAR','LA'),('LAR','STL'),('LAR','St. Louis Rams'),
  ('MIA','Miami Dolphins'),('MIA','Miami'),('MIA','Dolphins'),('MIA','MIA'),
  ('MIN','Minnesota Vikings'),('MIN','Minnesota'),('MIN','Vikings'),('MIN','MIN'),
  ('NE','New England Patriots'),('NE','New England'),('NE','Patriots'),('NE','NE'),('NE','NWE'),('NE','NEP'),
  ('NO','New Orleans Saints'),('NO','New Orleans'),('NO','Saints'),('NO','NO'),('NO','NOR'),('NO','NOS'),
  ('NYG','New York Giants'),('NYG','Giants'),('NYG','NYG'),
  ('NYJ','New York Jets'),('NYJ','Jets'),('NYJ','NYJ'),
  ('PHI','Philadelphia Eagles'),('PHI','Philadelphia'),('PHI','Eagles'),('PHI','PHI'),
  ('PIT','Pittsburgh Steelers'),('PIT','Pittsburgh'),('PIT','Steelers'),('PIT','PIT'),
  ('SF','San Francisco 49ers'),('SF','San Francisco'),('SF','49ers'),('SF','Niners'),('SF','SF'),('SF','SFO'),
  ('SEA','Seattle Seahawks'),('SEA','Seattle'),('SEA','Seahawks'),('SEA','SEA'),
  ('TB','Tampa Bay Buccaneers'),('TB','Tampa Bay'),('TB','Buccaneers'),('TB','Bucs'),('TB','TB'),('TB','TAM'),('TB','TBB'),
  ('TEN','Tennessee Titans'),('TEN','Tennessee'),('TEN','Titans'),('TEN','TEN'),('TEN','OTI'),
  ('WAS','Washington Commanders'),('WAS','Washington'),('WAS','Commanders'),('WAS','WAS'),('WAS','WSH'),
  ('WAS','Washington Football Team'),('WAS','Redskins')
) as t(code, alias)
on conflict (league, alias_norm) do nothing;

-- Reuse whatever aliases the Collective already learned from its own
-- quarantine flow, if that table is present. Same normalization, one source
-- of truth; a missing or differently shaped table is simply skipped.
do $mig$
declare v_rel regclass := to_regclass('collective.team_aliases');
begin
  if v_rel is not null then
    begin
      execute $q$
        insert into odds.team_aliases (league, alias_norm, team_code, source)
        select lower(sport_code), odds.norm_text(alias), upper(team_code), 'collective'
        from collective.team_aliases
        where alias is not null and team_code is not null
        on conflict (league, alias_norm) do nothing
      $q$;
    exception when others then
      raise notice 'odds: collective.team_aliases present but not importable (%), skipping', sqlerrm;
    end;
  end if;
end
$mig$;

create or replace function odds.resolve_team(p_league text, p_raw text)
returns text language plpgsql stable as $$
declare
  v_norm text := odds.norm_text(p_raw);
  v_code text;
begin
  if v_norm is null then return null; end if;
  select team_code into v_code
  from odds.team_aliases
  where league = lower(p_league) and alias_norm = v_norm;
  if v_code is not null then return v_code; end if;
  -- Last resort: a provider string that ends in a known nickname
  -- ("Kansas City Chiefs" when only "Chiefs" is aliased).
  select team_code into v_code
  from odds.team_aliases
  where league = lower(p_league)
    and length(alias_norm) >= 4
    and v_norm like '%' || alias_norm
  order by length(alias_norm) desc
  limit 1;
  return v_code;
end;
$$;

-- The NFL's own calendar day. A kickoff at 20:20 ET is still that Sunday's
-- game; converting to UTC would file it under Monday and fork the identity.
create or replace function odds.league_day(p_when timestamptz, p_league text default 'nfl')
returns date language sql stable as $$
  select (p_when at time zone 'America/New_York')::date;
$$;

-- ------------------------------------------------------------------ events
-- Canonical NFL game. Identity is ours (uuid) and is derived from league +
-- teams + kickoff date, never from a provider id, so a provider change or a
-- second provider cannot fork one game into two.
create table if not exists odds.events (
  id                 uuid primary key default gen_random_uuid(),
  league             text not null default 'nfl',
  sport              text not null default 'football',
  season             integer,
  week               integer,
  home_code          text not null,
  away_code          text not null,
  home_name          text,
  away_name          text,
  commence_time      timestamptz not null,
  -- The game's calendar day in league time. Stored rather than computed: a
  -- time zone conversion is only STABLE, so it cannot index, and a UTC date
  -- would split a Sunday night game from its own Sunday afternoon slot.
  commence_date      date not null,
  status             text not null default 'scheduled'
                     check (status in ('scheduled','live','final','postponed','canceled')),
  is_live            boolean not null default false,
  collective_game_id uuid,
  closing_finalized  boolean not null default false,
  first_seen_at      timestamptz not null default now(),
  last_updated       timestamptz not null default now()
);

create unique index if not exists events_identity_idx
  on odds.events (league, home_code, away_code, commence_date);
create index if not exists events_commence_idx on odds.events (league, commence_time);
create index if not exists events_status_idx on odds.events (status) where status <> 'final';
create index if not exists events_collective_idx on odds.events (collective_game_id)
  where collective_game_id is not null;

-- Provider identity is a mapping, not the identity itself.
create table if not exists odds.event_providers (
  provider          text not null references odds.providers(id),
  provider_event_id text not null,
  event_id          uuid not null references odds.events(id) on delete cascade,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  primary key (provider, provider_event_id)
);
create index if not exists event_providers_event_idx on odds.event_providers (event_id);

-- --------------------------------------------------------------- snapshots
-- Append-only. Chiefs -3.5 -110 then -3.5 -115 then -4.0 -110 are three rows
-- and all three stay recoverable forever.
create table if not exists odds.snapshots (
  id                  bigint generated always as identity primary key,
  event_id            uuid not null references odds.events(id) on delete cascade,
  provider            text not null references odds.providers(id),
  book_id             text not null references odds.books(id),
  market_id           text not null references odds.markets(id),
  outcome             text not null,
  outcome_label       text,
  line                numeric(8,2),
  price               integer not null,
  price_decimal       numeric(12,5) not null,
  implied_prob        numeric(9,6) not null,
  is_live             boolean not null default false,
  is_main             boolean not null default true,
  captured_at         timestamptz not null default now(),
  provider_updated_at timestamptz,
  content_hash        text not null,
  ingest_run_id       bigint,
  raw                 jsonb
);

-- The read path is always "latest / history for this event+market+book+outcome".
create index if not exists snapshots_series_idx
  on odds.snapshots (event_id, market_id, book_id, outcome, captured_at desc);
create index if not exists snapshots_event_time_idx on odds.snapshots (event_id, captured_at desc);
create index if not exists snapshots_captured_idx on odds.snapshots (captured_at desc);
create index if not exists snapshots_book_idx on odds.snapshots (book_id, captured_at desc);
create index if not exists snapshots_market_idx on odds.snapshots (market_id, captured_at desc);

-- --------------------------------------------------------- current state
-- The newest main-line price per series, maintained on write.
--
-- Deriving this with DISTINCT ON over odds.snapshots is correct but scans the
-- whole history, and a board render asks for it once per game per market. At
-- one NFL week of movement that was ~450ms a page. Keeping the current state
-- as a keyed table turns every read into an index lookup, and the history
-- stays exactly as it was: append-only and complete.
create table if not exists odds.current_main_state (
  event_id      uuid not null references odds.events(id) on delete cascade,
  market_id     text not null references odds.markets(id),
  book_id       text not null references odds.books(id),
  outcome       text not null,
  provider      text not null,
  outcome_label text,
  line          numeric(8,2),
  price         integer not null,
  price_decimal numeric(12,5) not null,
  implied_prob  numeric(9,6) not null,
  is_live       boolean not null default false,
  captured_at   timestamptz not null,
  snapshot_id   bigint not null,
  primary key (event_id, market_id, book_id, outcome)
);
create index if not exists current_main_state_event_idx
  on odds.current_main_state (event_id, market_id);
-- The staleness horizon asks for max(captured_at) per event, once per market
-- per game on every board render.
create index if not exists current_main_state_fresh_idx
  on odds.current_main_state (event_id, captured_at desc);

-- ----------------------------------------------------------- closing lines
-- Written once, by odds.finalize_closing, and only after kickoff. A current
-- price is never a closing price.
create table if not exists odds.closing_lines (
  event_id      uuid not null references odds.events(id) on delete cascade,
  book_id       text not null references odds.books(id),
  market_id     text not null references odds.markets(id),
  outcome       text not null,
  line          numeric(8,2),
  price         integer not null,
  price_decimal numeric(12,5) not null,
  implied_prob  numeric(9,6) not null,
  captured_at   timestamptz not null,
  closed_at     timestamptz not null default now(),
  snapshot_id   bigint,
  primary key (event_id, book_id, market_id, outcome)
);

-- ------------------------------------------------------------ ingest runs
-- Observability with no secrets: counts, durations, and sanitized errors.
create table if not exists odds.ingest_runs (
  id                 bigint generated always as identity primary key,
  provider           text not null,
  league             text not null,
  trigger            text not null default 'cron',
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text not null default 'running'
                     check (status in ('running','ok','partial','error')),
  books_requested    integer not null default 0,
  books_ok           integer not null default 0,
  books_failed       integer not null default 0,
  events_seen        integer not null default 0,
  events_created     integer not null default 0,
  events_matched     integer not null default 0,
  snapshots_written  integer not null default 0,
  snapshots_unchanged integer not null default 0,
  rows_rejected      integer not null default 0,
  unmatched          jsonb,
  error_code         text,
  error_message      text
);
create index if not exists ingest_runs_started_idx on odds.ingest_runs (started_at desc);

-- --------------------------------------------------------------- price math
create or replace function odds.american_to_decimal(p_price integer)
returns numeric language sql immutable as $$
  select case
    when p_price is null then null
    when p_price >= 100 then 1 + (p_price::numeric / 100)
    when p_price <= -100 then 1 + (100::numeric / abs(p_price))
    else null
  end;
$$;

create or replace function odds.american_to_prob(p_price integer)
returns numeric language sql immutable as $$
  select case
    when odds.american_to_decimal(p_price) is null then null
    else round(1 / odds.american_to_decimal(p_price), 6)
  end;
$$;

-- Two-way multiplicative de-vig. Used for the consensus moneyline: raw
-- American prices are never averaged, the no-vig probabilities are.
create or replace function odds.devig_two_way(p_a numeric, p_b numeric)
returns numeric language sql immutable as $$
  select case when p_a is null or p_b is null or (p_a + p_b) <= 0
              then null else round(p_a / (p_a + p_b), 6) end;
$$;

create or replace function odds.prob_to_american(p_prob numeric)
returns integer language sql immutable as $$
  select case
    when p_prob is null or p_prob <= 0 or p_prob >= 1 then null
    when p_prob >= 0.5 then (-round(100 * p_prob / (1 - p_prob)))::integer
    else round(100 * (1 - p_prob) / p_prob)::integer
  end;
$$;

-- ------------------------------------------------------------------- views
-- Current: the newest snapshot per series.
create or replace view odds.current_odds as
  select distinct on (s.event_id, s.market_id, s.book_id, s.outcome, s.line)
         s.*
  from odds.snapshots s
  order by s.event_id, s.market_id, s.book_id, s.outcome, s.line, s.captured_at desc, s.id desc;

-- Main current line only: one row per event/market/book/outcome, the main
-- line. This is what a price display reads. Same columns as before it was
-- backed by a table, so every consumer is unchanged.
create or replace view odds.current_main as
  select c.snapshot_id as id, c.event_id, c.provider, c.book_id, c.market_id,
         c.outcome, c.outcome_label, c.line, c.price, c.price_decimal,
         c.implied_prob, c.is_live, true as is_main, c.captured_at,
         c.snapshot_id
  from odds.current_main_state c;

-- Opening: the first snapshot per series. Immutable by construction, so it
-- needs no writer and cannot drift.
create or replace view odds.opening_lines as
  select distinct on (s.event_id, s.market_id, s.book_id, s.outcome)
         s.event_id, s.market_id, s.book_id, s.outcome, s.outcome_label,
         s.line, s.price, s.price_decimal, s.implied_prob, s.captured_at, s.id as snapshot_id
  from odds.snapshots s
  where s.is_main and not s.is_live
  order by s.event_id, s.market_id, s.book_id, s.outcome, s.captured_at asc, s.id asc;

-- ------------------------------------------------------------ ingest RPCs
create or replace function odds.begin_ingest(
  p_provider text, p_league text, p_trigger text default 'cron'
) returns bigint language sql security definer set search_path = odds, public as $$
  insert into odds.ingest_runs (provider, league, trigger)
  values (p_provider, p_league, coalesce(p_trigger,'cron'))
  returning id;
$$;

create or replace function odds.finish_ingest(p_run_id bigint, p_stats jsonb)
returns void language sql security definer set search_path = odds, public as $$
  update odds.ingest_runs set
    finished_at         = now(),
    status              = coalesce(p_stats->>'status','ok'),
    books_requested     = coalesce((p_stats->>'books_requested')::int, books_requested),
    books_ok            = coalesce((p_stats->>'books_ok')::int, books_ok),
    books_failed        = coalesce((p_stats->>'books_failed')::int, books_failed),
    events_seen         = coalesce((p_stats->>'events_seen')::int, events_seen),
    events_created      = coalesce((p_stats->>'events_created')::int, events_created),
    events_matched      = coalesce((p_stats->>'events_matched')::int, events_matched),
    snapshots_written   = coalesce((p_stats->>'snapshots_written')::int, snapshots_written),
    snapshots_unchanged = coalesce((p_stats->>'snapshots_unchanged')::int, snapshots_unchanged),
    rows_rejected       = coalesce((p_stats->>'rows_rejected')::int, rows_rejected),
    unmatched           = coalesce(p_stats->'unmatched', unmatched),
    error_code          = p_stats->>'error_code',
    error_message       = left(p_stats->>'error_message', 500)
  where id = p_run_id;
$$;

-- The whole write path. The edge function normalizes and hands over one
-- envelope; everything below happens in a single transaction so a partial
-- provider response can never leave half a slate behind.
--
-- p_payload:
-- { "events": [ {
--     "provider_event_id": "...", "home": "KC", "away": "BUF",
--     "commence_time": "2026-09-21T17:00:00Z", "season": 2026, "week": 3,
--     "is_live": false, "status": "scheduled", "provider_updated_at": "...",
--     "odds": [ { "book": "draftkings", "market": "spread",
--                 "outcome": "home", "outcome_label": "Kansas City Chiefs",
--                 "line": -3.5, "price": -110, "is_live": false,
--                 "is_main": true, "raw": {...} } ] } ] }
create or replace function odds.ingest_batch(
  p_run_id   bigint,
  p_provider text,
  p_league   text,
  p_payload  jsonb
) returns jsonb language plpgsql security definer set search_path = odds, public as $$
declare
  v_ev            jsonb;
  v_od            jsonb;
  v_home          text;
  v_away          text;
  v_event_id      uuid;
  v_created       int := 0;
  v_seen          int := 0;
  v_written       int := 0;
  v_unchanged     int := 0;
  v_rejected      int := 0;
  v_unmatched     jsonb := '[]'::jsonb;
  v_league        text := lower(coalesce(p_league,'nfl'));
  v_commence      timestamptz;
  v_hash          text;
  v_last_hash     text;
  v_price         integer;
  v_line          numeric;
  v_decimal       numeric;
  v_prob          numeric;
  v_book          text;
  v_market        text;
  v_outcome       text;
  v_is_live       boolean;
  v_is_main       boolean;
  v_inserted      boolean;
  v_snapshot_id   bigint;
  v_commence_date date;
  v_prov_updated  timestamptz;
begin
  -- coalesce, not a bare comparison: jsonb_typeof of a missing key is NULL,
  -- and NULL <> 'array' is NULL, which would fall straight through the guard.
  if p_payload is null or coalesce(jsonb_typeof(p_payload->'events'), '') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'invalid_payload',
                              'message', 'payload.events must be an array');
  end if;

  for v_ev in select * from jsonb_array_elements(p_payload->'events') loop
    v_seen := v_seen + 1;
    v_home := odds.resolve_team(v_league, v_ev->>'home');
    v_away := odds.resolve_team(v_league, v_ev->>'away');
    begin
      v_commence := (v_ev->>'commence_time')::timestamptz;
    exception when others then
      v_commence := null;
    end;

    -- An event we cannot name is reported, never guessed at and never stored
    -- under a made-up identity.
    if v_home is null or v_away is null or v_commence is null then
      v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
        'provider_event_id', v_ev->>'provider_event_id',
        'home', v_ev->>'home', 'away', v_ev->>'away',
        'commence_time', v_ev->>'commence_time',
        'reason', case when v_commence is null then 'unparsable_commence_time'
                       else 'unknown_team' end));
      v_rejected := v_rejected + coalesce(jsonb_array_length(v_ev->'odds'), 0);
      continue;
    end if;

    -- Identity first: the provider id only ever maps onto it.
    v_commence_date := odds.league_day(v_commence, v_league);
    v_inserted := false;
    v_event_id := null;

    -- An existing mapping wins outright: the provider is telling us this is
    -- the same event it sent last time, even if the kickoff moved.
    select ep.event_id into v_event_id
    from odds.event_providers ep
    where ep.provider = p_provider
      and ep.provider_event_id = nullif(v_ev->>'provider_event_id','');

    -- Otherwise match on our own identity, allowing a few days of drift so a
    -- flexed or rescheduled kickoff updates the game instead of forking it.
    if v_event_id is null then
      select e.id into v_event_id
      from odds.events e
      where e.league = v_league
        and e.home_code = v_home
        and e.away_code = v_away
        and e.commence_time between v_commence - interval '4 days'
                                and v_commence + interval '4 days'
      order by abs(extract(epoch from (e.commence_time - v_commence)))
      limit 1;
    end if;

    if v_event_id is null then
      begin
        insert into odds.events (league, season, week, home_code, away_code,
                                 home_name, away_name, commence_time, commence_date,
                                 status, is_live)
        values (v_league,
                nullif(v_ev->>'season','')::int,
                nullif(v_ev->>'week','')::int,
                v_home, v_away,
                v_ev->>'home_name', v_ev->>'away_name',
                v_commence, v_commence_date,
                -- The column has a CHECK constraint and the whole slate
                -- rides on one transaction, so an unrecognised vendor status
                -- must not be allowed to abort the batch and lose every
                -- price in it.
                case when nullif(v_ev->>'status','') in
                          ('scheduled','live','final','postponed','canceled')
                     then v_ev->>'status' else 'scheduled' end,
                coalesce((v_ev->>'is_live')::boolean, false))
        returning id into v_event_id;
        v_inserted := true;
      exception when unique_violation then
        -- A concurrent run won the race; adopt its row.
        select id into v_event_id from odds.events
        where league = v_league and home_code = v_home and away_code = v_away
          and commence_date = v_commence_date;
      end;
    end if;

    if v_inserted then
      v_created := v_created + 1;
    else
      update odds.events e set
        commence_time = v_commence,
        commence_date = v_commence_date,
        is_live       = coalesce((v_ev->>'is_live')::boolean, e.is_live),
        -- A game already settled stays settled; a feed blip cannot reopen it.
        status        = case
                          when e.status = 'final' then e.status
                          when nullif(v_ev->>'status','') in
                               ('scheduled','live','final','postponed','canceled')
                            then v_ev->>'status'
                          else e.status
                        end,
        season        = coalesce(nullif(v_ev->>'season','')::int, e.season),
        week          = coalesce(nullif(v_ev->>'week','')::int, e.week),
        home_name     = coalesce(nullif(v_ev->>'home_name',''), e.home_name),
        away_name     = coalesce(nullif(v_ev->>'away_name',''), e.away_name),
        last_updated  = now()
      where e.id = v_event_id;
    end if;

    if nullif(v_ev->>'provider_event_id','') is not null then
      insert into odds.event_providers (provider, provider_event_id, event_id)
      values (p_provider, v_ev->>'provider_event_id', v_event_id)
      on conflict (provider, provider_event_id)
      do update set last_seen_at = now(), event_id = excluded.event_id;
    end if;

    begin
      v_prov_updated := nullif(v_ev->>'provider_updated_at','')::timestamptz;
    exception when others then
      v_prov_updated := null;
    end;

    for v_od in select * from jsonb_array_elements(coalesce(v_ev->'odds','[]'::jsonb)) loop
      v_book    := lower(nullif(v_od->>'book',''));
      v_market  := lower(nullif(v_od->>'market',''));
      v_outcome := lower(nullif(v_od->>'outcome',''));
      v_price   := nullif(v_od->>'price','')::integer;
      v_line    := nullif(v_od->>'line','')::numeric;
      v_is_live := coalesce((v_od->>'is_live')::boolean, false);
      v_is_main := coalesce((v_od->>'is_main')::boolean, true);

      if v_book is null or v_market is null or v_outcome is null or v_price is null then
        v_rejected := v_rejected + 1;
        continue;
      end if;

      v_decimal := odds.american_to_decimal(v_price);
      if v_decimal is null then
        v_rejected := v_rejected + 1;   -- a price between -99 and +99 is not American odds
        continue;
      end if;
      v_prob := round(1 / v_decimal, 6);

      -- A book or market we have never seen is registered rather than
      -- dropped, so an unexpected feed value is visible instead of silent.
      insert into odds.books (id, name, priority, enabled)
      values (v_book, initcap(replace(v_book,'_',' ')), 900, true)
      on conflict (id) do update set last_seen_at = now();

      insert into odds.markets (id, name, kind, has_line, enabled, auto_added)
      values (v_market, initcap(replace(v_market,'_',' ')), 'other', v_line is not null, false, true)
      on conflict (id) do nothing;

      v_hash := md5(concat_ws('|', v_book, v_market, v_outcome,
                              coalesce(v_line::text,''), v_price::text,
                              v_is_live::text, v_is_main::text));

      -- Only a real change becomes a row. Re-polling an unchanged market adds
      -- nothing, so the history stays a record of movement.
      --
      -- The comparison is against the newest row for the SERIES, not the
      -- newest row at this line. Keying on the line meant a market that went
      -- -3.5 -> -4.0 -> -3.5 matched the first -3.5 row, scored "unchanged",
      -- and left the current state stuck on -4.0 until the book moved to a
      -- third number. Oscillating between two adjacent numbers is ordinary,
      -- so that froze the published line and the closing line with it.
      --
      -- Alternates are the exception: a book quotes many alternate lines at
      -- once, so there the line really is part of the series identity.
      select content_hash into v_last_hash
      from odds.snapshots
      where event_id = v_event_id and market_id = v_market
        and book_id = v_book and outcome = v_outcome
        and is_main = v_is_main
        and (v_is_main or line is not distinct from v_line)
      order by captured_at desc, id desc
      limit 1;

      if v_last_hash is not null and v_last_hash = v_hash then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;

      insert into odds.snapshots (
        event_id, provider, book_id, market_id, outcome, outcome_label,
        line, price, price_decimal, implied_prob, is_live, is_main,
        provider_updated_at, content_hash, ingest_run_id, raw)
      values (
        v_event_id, p_provider, v_book, v_market, v_outcome,
        nullif(v_od->>'outcome_label',''),
        v_line, v_price, v_decimal, v_prob, v_is_live, v_is_main,
        v_prov_updated, v_hash, p_run_id, v_od->'raw')
      returning id into v_snapshot_id;
      v_written := v_written + 1;

      -- The current-state row moves with the newest main price. Guarded on
      -- captured_at so an out-of-order write cannot walk the market backwards.
      if v_is_main then
        insert into odds.current_main_state (
          event_id, market_id, book_id, outcome, provider, outcome_label,
          line, price, price_decimal, implied_prob, is_live, captured_at, snapshot_id)
        values (v_event_id, v_market, v_book, v_outcome, p_provider,
                nullif(v_od->>'outcome_label',''), v_line, v_price, v_decimal,
                v_prob, v_is_live, now(), v_snapshot_id)
        on conflict (event_id, market_id, book_id, outcome) do update set
          provider = excluded.provider, outcome_label = excluded.outcome_label,
          line = excluded.line, price = excluded.price,
          price_decimal = excluded.price_decimal, implied_prob = excluded.implied_prob,
          is_live = excluded.is_live, captured_at = excluded.captured_at,
          snapshot_id = excluded.snapshot_id
        where excluded.captured_at >= odds.current_main_state.captured_at;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'events_seen', v_seen,
    'events_created', v_created,
    'snapshots_written', v_written,
    'snapshots_unchanged', v_unchanged,
    'rows_rejected', v_rejected,
    'unmatched', v_unmatched);
end;
$$;

-- Rebuilds the current state from history. Run after a backfill, or by this
-- migration so applying it to a database that already has snapshots is
-- correct rather than empty.
create or replace function odds.rebuild_current()
returns integer language plpgsql security definer set search_path = odds, public as $$
declare v_n int;
begin
  truncate odds.current_main_state;
  insert into odds.current_main_state (
    event_id, market_id, book_id, outcome, provider, outcome_label, line,
    price, price_decimal, implied_prob, is_live, captured_at, snapshot_id)
  select distinct on (s.event_id, s.market_id, s.book_id, s.outcome)
         s.event_id, s.market_id, s.book_id, s.outcome, s.provider,
         s.outcome_label, s.line, s.price, s.price_decimal, s.implied_prob,
         s.is_live, s.captured_at, s.id
  from odds.snapshots s
  where s.is_main
  order by s.event_id, s.market_id, s.book_id, s.outcome, s.captured_at desc, s.id desc;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ------------------------------------------------ link to Collective games
-- odds.events and collective.games are separate identities on purpose: the
-- Collective's slate is authored by an admin, the odds feed is authored by a
-- provider. This joins them where they describe the same game. It reads
-- collective.game_detail, the view the public API already depends on, and is
-- a no-op if that view is absent.
create or replace function odds.link_collective_games(p_league text default 'nfl')
returns integer language plpgsql security definer set search_path = odds, public as $$
declare
  v_linked int := 0;
begin
  if to_regclass('collective.game_detail') is null then
    return 0;
  end if;
  execute format($q$
    with cand as (
      select g.game_id, g.season, g.week,
             odds.resolve_team(%L, g.home) as home_code,
             odds.resolve_team(%L, g.away) as away_code,
             odds.league_day(g.kickoff_at, %L) as kdate
      from collective.game_detail g
      where lower(g.sport) = %L
    )
    update odds.events e
       set collective_game_id = cand.game_id,
           -- The odds feed does not carry season or week; the Collective's
           -- own slate does. Without this, events.week stays null and the
           -- week filter on the read API silently returns nothing.
           season = coalesce(cand.season, e.season),
           week   = coalesce(cand.week, e.week),
           last_updated = now()
      from cand
     where e.league = %L
       and cand.home_code is not null
       and e.home_code = cand.home_code
       and e.away_code = cand.away_code
       and e.commence_date = cand.kdate
       and (e.collective_game_id is distinct from cand.game_id
            or e.season is distinct from cand.season
            or e.week is distinct from cand.week)
  $q$, p_league, p_league, p_league, p_league, p_league);
  get diagnostics v_linked = row_count;
  return v_linked;
exception when others then
  raise notice 'odds.link_collective_games skipped: %', sqlerrm;
  return 0;
end;
$$;

-- --------------------------------------------------------------- closing
-- A market closes when the game starts. Until then there is no closing line,
-- only a current one. This writes each series' last pre-kickoff, non-live
-- price exactly once and never rewrites it.
create or replace function odds.finalize_closing(p_event_id uuid default null)
returns integer language plpgsql security definer set search_path = odds, public as $$
declare
  v_grace int := coalesce((odds.get_setting('nfl.close_grace_minutes'))::text::int, 0);
  v_rows  int := 0;
  v_total int := 0;
  v_ev    record;
begin
  for v_ev in
    select id, commence_time from odds.events
    where not closing_finalized
      and commence_time + make_interval(mins => v_grace) <= now()
      and (p_event_id is null or id = p_event_id)
  loop
    insert into odds.closing_lines (
      event_id, book_id, market_id, outcome, line, price, price_decimal,
      implied_prob, captured_at, snapshot_id)
    select distinct on (s.market_id, s.book_id, s.outcome)
           s.event_id, s.book_id, s.market_id, s.outcome, s.line, s.price,
           s.price_decimal, s.implied_prob, s.captured_at, s.id
    from odds.snapshots s
    where s.event_id = v_ev.id
      and s.is_main
      and not s.is_live
      and s.captured_at <= v_ev.commence_time
    order by s.market_id, s.book_id, s.outcome, s.captured_at desc, s.id desc
    on conflict (event_id, book_id, market_id, outcome) do nothing;
    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;

    -- The pass is marked done either way so it does not retry forever. An
    -- event that closed with nothing captured before kickoff simply has no
    -- closing line, and the read path says exactly that rather than
    -- reaching for a post-kickoff price.
    --
    -- Only closing_finalized is set here. Kickoff means the market closed,
    -- not that the game ended: writing status='final' and is_live=false at
    -- kickoff marked every game in progress as over, and because ingest
    -- refuses to move a game out of 'final' the feed could never correct it.
    -- Status and liveness belong to the feed.
    update odds.events
       set closing_finalized = true, last_updated = now()
     where id = v_ev.id;
  end loop;
  return v_total;
end;
$$;

-- ------------------------------------------------------------- consensus
-- Rules, deliberately not "average the American odds":
--   spread / total  -> median of the main lines across retail books
--   moneyline       -> median of the DE-VIGGED home win probabilities
--   sharp books     -> reported separately, never folded into the retail
--                      consensus, so Pinnacle stays a reference not a vote
create or replace function odds.consensus(p_event_id uuid)
returns jsonb language plpgsql stable as $$
declare
  v jsonb;
begin
  with horizon as (
    select max(captured_at) as newest from odds.current_main_state
    where event_id = p_event_id
  ),
  cur as (
    select c.*, b.is_sharp, b.include_in_consensus
    from odds.current_main c
    join odds.books b on b.id = c.book_id
    cross join horizon h
    where h.newest is null
       or c.captured_at >= h.newest - make_interval(secs => odds.book_stale_seconds())
  ),
  spreads as (
    select percentile_cont(0.5) within group (order by line)::numeric as median_line,
           avg(line) as mean_line, stddev_samp(line) as stdev_line,
           min(line) as min_line, max(line) as max_line, count(*) as n
    from cur where event_id = p_event_id and market_id = 'spread'
      and outcome = 'home' and include_in_consensus
  ),
  totals as (
    select percentile_cont(0.5) within group (order by line)::numeric as median_line,
           avg(line) as mean_line, min(line) as min_line, max(line) as max_line,
           count(*) as n
    from cur where event_id = p_event_id and market_id = 'total'
      and outcome = 'over' and include_in_consensus
  ),
  ml as (
    select h.book_id,
           odds.devig_two_way(h.implied_prob, a.implied_prob) as fair_home
    from cur h
    join cur a on a.event_id = h.event_id and a.book_id = h.book_id
              and a.market_id = 'moneyline' and a.outcome = 'away'
    where h.event_id = p_event_id and h.market_id = 'moneyline'
      and h.outcome = 'home' and h.include_in_consensus
  ),
  mlagg as (
    select percentile_cont(0.5) within group (order by fair_home)::numeric as median_fair,
           count(*) as n
    from ml where fair_home is not null
  ),
  sharp as (
    select jsonb_object_agg(book_id, payload) as books from (
      select s.book_id, jsonb_build_object(
        'spread',    max(case when s.market_id='spread'    and s.outcome='home' then s.line end),
        'spread_price', max(case when s.market_id='spread' and s.outcome='home' then s.price end),
        'total',     max(case when s.market_id='total'     and s.outcome='over' then s.line end),
        'moneyline_home', max(case when s.market_id='moneyline' and s.outcome='home' then s.price end),
        'moneyline_away', max(case when s.market_id='moneyline' and s.outcome='away' then s.price end),
        'captured_at', max(s.captured_at)
      ) as payload
      from cur s
      where s.event_id = p_event_id and s.is_sharp
      group by s.book_id
    ) t
  )
  select jsonb_build_object(
    'spread', case when (select n from spreads) > 0 then jsonb_build_object(
        'median', (select round(median_line,2) from spreads),
        'mean',   (select round(mean_line,2) from spreads),
        'stdev',  (select round(stdev_line,3) from spreads),
        'min',    (select min_line from spreads),
        'max',    (select max_line from spreads),
        'books',  (select n from spreads)) end,
    'total', case when (select n from totals) > 0 then jsonb_build_object(
        'median', (select round(median_line,2) from totals),
        'mean',   (select round(mean_line,2) from totals),
        'min',    (select min_line from totals),
        'max',    (select max_line from totals),
        'books',  (select n from totals)) end,
    'moneyline', case when (select n from mlagg) > 0 then jsonb_build_object(
        'home_fair_prob', (select round(median_fair,4) from mlagg),
        'home_fair_american', (select odds.prob_to_american(median_fair) from mlagg),
        'away_fair_prob', (select round(1 - median_fair,4) from mlagg),
        'away_fair_american', (select odds.prob_to_american(1 - median_fair) from mlagg),
        'books', (select n from mlagg),
        'method', 'median of de-vigged two-way probabilities') end,
    'sharp', coalesce((select books from sharp), '{}'::jsonb),
    'note', 'Retail consensus excludes sharp books; sharp numbers are reported separately.'
  ) into v;
  return v;
end;
$$;

-- ------------------------------------------------------------ best price
-- Grouped BY LINE. -4 -105 is not automatically better than -3.5 -110: they
-- are different bets. Within a line the best price is unambiguous, so that is
-- where a winner is named. The primary line is the one the most books are on
-- (ties break toward the consensus median).
-- p_detail false keeps the winning price per line but drops the per-book
-- arrays. A slate of sixteen games with eight books repeats that detail
-- hundreds of times, and a list view never reads it.
create or replace function odds.best_price(
  p_event_id uuid, p_market text, p_detail boolean default true)
returns jsonb language plpgsql stable as $$
declare
  v jsonb;
begin
  with horizon as (
    select max(captured_at) as newest from odds.current_main_state
    where event_id = p_event_id
  ),
  cur as (
    select c.event_id, c.market_id, c.book_id, c.outcome, c.outcome_label,
           c.line, c.price, c.price_decimal, c.implied_prob, c.captured_at,
           b.name as book_name, b.is_sharp
    from odds.current_main c
    join odds.books b on b.id = c.book_id
    cross join horizon h
    where c.event_id = p_event_id and c.market_id = p_market
      -- A price a book has since taken down is not a price you can get.
      and (h.newest is null
           or c.captured_at >= h.newest - make_interval(secs => odds.book_stale_seconds()))
  ),
  median_line as (
    select outcome, percentile_cont(0.5) within group (order by line)::numeric as med
    from cur group by outcome
  ),
  counts as (
    select c.outcome, c.line, count(*) as n_books,
           abs(c.line - m.med) as off_median
    from cur c join median_line m on m.outcome = c.outcome
    group by c.outcome, c.line, m.med
  ),
  -- "The" line is the one the most books are actually on. Ties break toward
  -- the median so the pick is meaningful rather than alphabetical, and the
  -- final ordering keeps it deterministic.
  primary_line as (
    select outcome, line from (
      select outcome, line, n_books,
             row_number() over (partition by outcome
                                order by n_books desc, off_median asc, line asc) as rn
      from counts) t where rn = 1
  ),
  grouped as (
    select c.outcome, c.line,
           jsonb_agg(jsonb_build_object(
             'book', c.book_id, 'book_name', c.book_name, 'is_sharp', c.is_sharp,
             'price', c.price, 'price_decimal', c.price_decimal,
             'implied_prob', c.implied_prob, 'captured_at', c.captured_at
           ) order by c.price_decimal desc) as books,
           (array_agg(c.book_id order by c.price_decimal desc))[1] as best_book,
           max(c.price_decimal) as best_decimal,
           (array_agg(c.price order by c.price_decimal desc))[1] as best_price,
           max(c.captured_at) as latest
    from cur c group by c.outcome, c.line
  )
  select jsonb_build_object(
    'market', p_market,
    'outcomes', coalesce(jsonb_object_agg(g.outcome, g.payload), '{}'::jsonb)
  ) into v
  from (
    select outcome, jsonb_build_object(
      'primary_line', (select pl.line from primary_line pl where pl.outcome = x.outcome),
      'lines', jsonb_agg(jsonb_build_object(
        'line', x.line,
        'best', jsonb_build_object('book', x.best_book, 'price', x.best_price,
                                   'price_decimal', x.best_decimal),
        'books', case when p_detail then x.books else '[]'::jsonb end,
        'book_count', jsonb_array_length(x.books),
        'is_primary', x.line is not distinct from
                      (select pl.line from primary_line pl where pl.outcome = x.outcome),
        'latest_captured_at', x.latest
      ) order by x.line)
    ) as payload
    from grouped x group by x.outcome
  ) g;
  return coalesce(v, jsonb_build_object('market', p_market, 'outcomes', '{}'::jsonb));
end;
$$;

-- ============================================================================
-- collective.* API surface
--
-- The edge functions already speak PostgREST against the collective schema.
-- These views and functions are the only way in or out of the odds layer, and
-- every one of them is granted to service_role alone: the anon key cannot
-- read odds tables, so the browser cannot bypass the edge function.
-- ============================================================================

create or replace view collective.odds_events as
  select e.id as event_id, e.league, e.sport, e.season, e.week,
         e.home_code, e.away_code, e.home_name, e.away_name,
         e.commence_time, e.status, e.is_live, e.collective_game_id,
         e.closing_finalized, e.last_updated,
         (select max(s.captured_at) from odds.snapshots s where s.event_id = e.id)
           as last_odds_at,
         (select count(distinct s.book_id) from odds.current_main s where s.event_id = e.id)
           as book_count
  from odds.events e;

create or replace view collective.odds_current as
  select c.event_id, c.book_id, b.name as book_name, b.is_sharp,
         b.include_in_consensus, c.market_id, c.outcome, c.outcome_label,
         c.line, c.price, c.price_decimal, c.implied_prob, c.is_live,
         c.captured_at, c.provider, c.id as snapshot_id
  from odds.current_main c
  join odds.books b on b.id = c.book_id;

create or replace view collective.odds_history as
  select s.id as snapshot_id, s.event_id, s.book_id, s.market_id, s.outcome,
         s.line, s.price, s.price_decimal, s.implied_prob, s.is_live,
         s.is_main, s.captured_at
  from odds.snapshots s;

create or replace view collective.odds_opening as
  select o.* from odds.opening_lines o;

create or replace view collective.odds_closing as
  select c.event_id, c.book_id, c.market_id, c.outcome, c.line, c.price,
         c.price_decimal, c.implied_prob, c.captured_at, c.closed_at
  from odds.closing_lines c;

create or replace view collective.odds_runs as
  select * from odds.ingest_runs;

create or replace view collective.odds_books as
  select id, name, is_sharp, include_in_consensus, priority, enabled, last_seen_at
  from odds.books;

-- Health in one row: is the feed current, and how current.
-- The last run that actually reached the provider and came back. This is
-- what "is the feed current" means; max(captured_at) answers a different
-- question, which is when a price last MOVED.
create or replace function odds.last_poll_at()
returns timestamptz language sql stable as $$
  select max(coalesce(finished_at, started_at))
  from odds.ingest_runs where status in ('ok','partial');
$$;

create or replace function collective.odds_status(p_league text default 'nfl')
returns jsonb language sql stable security definer set search_path = odds, collective, public as $$
  select jsonb_build_object(
    'league', p_league,
    -- last_poll_at: the feed is current as of this moment.
    -- last_odds_at: a price last changed at this moment. A quiet market is
    -- not a stale feed, so freshness is judged on the first.
    'last_poll_at',   odds.last_poll_at(),
    'last_odds_at',   (select max(captured_at) from odds.snapshots),
    'stale_after_seconds', coalesce((odds.get_setting('nfl.stale_after_seconds'))::text::int, 900),
    'events_upcoming', (select count(*) from odds.events
                        where league = p_league and commence_time > now()),
    'events_live',     (select count(*) from odds.events
                        where league = p_league and is_live),
    'books_current',   (select count(distinct book_id) from odds.current_main),
    'snapshots_total', (select count(*) from odds.snapshots),
    'last_run', (select to_jsonb(r) - 'unmatched' from odds.ingest_runs r
                 order by started_at desc limit 1)
  );
$$;

create or replace function collective.odds_ingest(
  p_run_id bigint, p_provider text, p_league text, p_payload jsonb)
returns jsonb language sql security definer set search_path = odds, public as $$
  select odds.ingest_batch(p_run_id, p_provider, p_league, p_payload);
$$;

create or replace function collective.odds_begin_run(
  p_provider text, p_league text, p_trigger text default 'cron')
returns bigint language sql security definer set search_path = odds, public as $$
  select odds.begin_ingest(p_provider, p_league, p_trigger);
$$;

create or replace function collective.odds_finish_run(p_run_id bigint, p_stats jsonb)
returns void language sql security definer set search_path = odds, public as $$
  select odds.finish_ingest(p_run_id, p_stats);
$$;

create or replace function collective.odds_finalize_closing(p_event_id uuid default null)
returns integer language sql security definer set search_path = odds, public as $$
  select odds.finalize_closing(p_event_id);
$$;

create or replace function collective.odds_link_games(p_league text default 'nfl')
returns integer language sql security definer set search_path = odds, public as $$
  select odds.link_collective_games(p_league);
$$;

create or replace function collective.odds_consensus(p_event_id uuid)
returns jsonb language sql stable security definer set search_path = odds, public as $$
  select odds.consensus(p_event_id);
$$;

create or replace function collective.odds_best_price(p_event_id uuid, p_market text)
returns jsonb language sql stable security definer set search_path = odds, public as $$
  select odds.best_price(p_event_id, p_market);
$$;

create or replace function collective.odds_get_setting(p_key text)
returns jsonb language sql stable security definer set search_path = odds, public as $$
  select odds.get_setting(p_key);
$$;

create or replace function collective.odds_set_setting(p_key text, p_value jsonb)
returns jsonb language sql security definer set search_path = odds, public as $$
  insert into odds.settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now()
  returning value;
$$;

-- The closing line the Collective grades against, for one of its own games.
-- The admin Results screen reads this instead of asking a human to type a
-- number from memory. Returns null until the market has actually closed.
create or replace function collective.odds_closing_for_game(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path = odds, public as $$
declare
  v_event uuid;
  v jsonb;
begin
  select id into v_event from odds.events
  where collective_game_id = p_game_id limit 1;
  if v_event is null then
    return jsonb_build_object('available', false, 'reason', 'no_linked_odds_event');
  end if;
  if not exists (select 1 from odds.closing_lines where event_id = v_event) then
    return jsonb_build_object(
      'available', false,
      'reason', case when (select closing_finalized from odds.events where id = v_event)
                     then 'no_pregame_capture'   -- closed, but we never saw a price in time
                     else 'market_not_closed' end,
      'event_id', v_event);
  end if;
  with c as (
    select cl.*, b.is_sharp, b.include_in_consensus
    from odds.closing_lines cl join odds.books b on b.id = cl.book_id
    where cl.event_id = v_event
  ),
  ml as (
    select odds.devig_two_way(h.implied_prob, a.implied_prob) as fair_home
    from c h join c a on a.book_id = h.book_id and a.market_id='moneyline' and a.outcome='away'
    where h.market_id = 'moneyline' and h.outcome = 'home' and h.include_in_consensus
  )
  select jsonb_build_object(
    'available', true,
    'event_id', v_event,
    'closing_spread', (select percentile_cont(0.5) within group (order by line)::numeric
                       from c where market_id='spread' and outcome='home' and include_in_consensus),
    'closing_total',  (select percentile_cont(0.5) within group (order by line)::numeric
                       from c where market_id='total' and outcome='over' and include_in_consensus),
    'closing_home_ml_prob', (select round(percentile_cont(0.5) within group (order by fair_home)::numeric, 4)
                             from ml where fair_home is not null),
    'closed_at', (select max(closed_at) from c),
    'books', (select count(distinct book_id) from c),
    'sharp', coalesce((select jsonb_object_agg(t.book_id, t.payload) from (
                select s.book_id, jsonb_build_object(
                  'spread', max(case when s.market_id='spread' and s.outcome='home' then s.line end),
                  'total',  max(case when s.market_id='total'  and s.outcome='over' then s.line end)
                ) as payload
                from c s where s.is_sharp group by s.book_id) t), '{}'::jsonb),
    'method', 'median closing line across retail books, moneyline de-vigged'
  ) into v;
  return v;
end;
$$;

-- ------------------------------------------------------------------ grants
-- RLS on with no policies: only the service role (which bypasses RLS) can
-- read or write. Edge functions hold that key; browsers never do.
alter table odds.settings        enable row level security;
alter table odds.providers       enable row level security;
alter table odds.books           enable row level security;
alter table odds.markets         enable row level security;
alter table odds.team_aliases    enable row level security;
alter table odds.events          enable row level security;
alter table odds.event_providers enable row level security;
alter table odds.snapshots       enable row level security;
alter table odds.current_main_state enable row level security;
alter table odds.closing_lines   enable row level security;
alter table odds.ingest_runs     enable row level security;

do $mig$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema odds to service_role';
    execute 'grant select, insert, update, delete on all tables in schema odds to service_role';
    execute 'grant usage, select on all sequences in schema odds to service_role';
    execute 'grant execute on all functions in schema odds to service_role';
    execute 'grant select on collective.odds_events, collective.odds_current,
             collective.odds_history, collective.odds_opening, collective.odds_closing,
             collective.odds_runs, collective.odds_books to service_role';
  end if;
  -- The odds layer is server side only. Revoke explicitly rather than relying
  -- on defaults, so a permissive default grant cannot leak it to the anon key.
  begin
    execute 'revoke all on collective.odds_events, collective.odds_current,
             collective.odds_history, collective.odds_opening, collective.odds_closing,
             collective.odds_runs, collective.odds_books from anon, authenticated';
  exception when others then
    raise notice 'odds: anon/authenticated revoke skipped (%)', sqlerrm;
  end;
end
$mig$;

do $mig$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on odds.current_main_state to service_role';
  end if;
end
$mig$;

-- Safe on a fresh database (nothing to rebuild) and correct on one that
-- already holds history.
select odds.rebuild_current();

comment on schema odds is
  'Centralized odds infrastructure. Written only by the collective_odds_ingest edge function, read only through the collective.odds_* API surface.';

-- ============================================================================
-- Read payloads
--
-- The market math (median consensus, de-vig, best price per line) lives in
-- SQL and nowhere else. The edge function makes one call and formats the
-- result; it never recomputes a number, so the API, the embed, the admin
-- console and the AI assistant cannot drift apart.
-- ============================================================================

create or replace function odds.event_payload(p_event_id uuid, p_include_books boolean default true)
returns jsonb language plpgsql stable as $$
declare
  v_ev  record;
  v_out jsonb;
begin
  select * into v_ev from odds.events where id = p_event_id;
  if not found then return null; end if;

  with horizon as (
    select max(captured_at) as newest from odds.current_main_state
    where event_id = p_event_id
  ),
  cur as (
    select c.*, b.name as book_name, b.is_sharp, b.include_in_consensus
    from odds.current_main c
    join odds.books b on b.id = c.book_id
    cross join horizon h
    where c.event_id = p_event_id
      and c.market_id in ('moneyline','spread','total')
      and (h.newest is null
           or c.captured_at >= h.newest - make_interval(secs => odds.book_stale_seconds()))
  ),
  books as (
    select jsonb_object_agg(m.market_id, m.rows) as by_market from (
      select c.market_id, jsonb_agg(jsonb_build_object(
               'book', c.book_id, 'book_name', c.book_name, 'is_sharp', c.is_sharp,
               'outcome', c.outcome, 'line', c.line, 'price', c.price,
               'price_decimal', c.price_decimal, 'implied_prob', c.implied_prob,
               'is_live', c.is_live, 'captured_at', c.captured_at)
               order by c.is_sharp desc, c.book_id, c.outcome) as rows
      from cur c group by c.market_id) m
  ),
  -- Books do not open on the same number at the same minute, so "the
  -- opening line" is a consensus, computed exactly the way the closing line
  -- is: the median of each book's own opener across retail books. Picking
  -- one book's opener and calling it the market's would be arbitrary.
  opens as (
    select jsonb_object_agg(o.market_id || ':' || o.outcome, jsonb_build_object(
             'line', o.median_line, 'books', o.n, 'first_at', o.first_at,
             'by_book', o.by_book)) as by_key
    from (
      select ol.market_id, ol.outcome,
             percentile_cont(0.5) within group (order by ol.line)::numeric as median_line,
             count(*) as n,
             min(ol.captured_at) as first_at,
             jsonb_object_agg(ol.book_id, jsonb_build_object(
               'line', ol.line, 'price', ol.price, 'at', ol.captured_at)) as by_book
      from odds.opening_lines ol
      join odds.books b on b.id = ol.book_id and b.include_in_consensus
      where ol.event_id = p_event_id and ol.market_id in ('moneyline','spread','total')
      group by ol.market_id, ol.outcome
    ) o
  ),
  closes as (
    select jsonb_object_agg(c.market_id || ':' || c.outcome, jsonb_build_object(
             'line', c.median_line, 'books', c.n)) as by_key
    from (
      select market_id, outcome,
             percentile_cont(0.5) within group (order by line)::numeric as median_line,
             count(*) as n
      from odds.closing_lines cl
      join odds.books b on b.id = cl.book_id and b.include_in_consensus
      where cl.event_id = p_event_id
      group by market_id, outcome
    ) c
  )
  select jsonb_build_object(
    'event_id', v_ev.id,
    'collective_game_id', v_ev.collective_game_id,
    'league', v_ev.league,
    'season', v_ev.season,
    'week', v_ev.week,
    'home', v_ev.home_code,
    'away', v_ev.away_code,
    'home_name', coalesce(v_ev.home_name, v_ev.home_code),
    'away_name', coalesce(v_ev.away_name, v_ev.away_code),
    'commence_time', v_ev.commence_time,
    'status', v_ev.status,
    'is_live', v_ev.is_live,
    'market_closed', v_ev.closing_finalized,
    'last_odds_at', (select max(captured_at) from cur),
    'book_count', (select count(distinct book_id) from cur),
    'consensus', odds.consensus(p_event_id),
    'best', jsonb_build_object(
       'moneyline', odds.best_price(p_event_id,'moneyline',p_include_books),
       'spread',    odds.best_price(p_event_id,'spread',p_include_books),
       'total',     odds.best_price(p_event_id,'total',p_include_books)),
    'opening', coalesce((select by_key from opens), '{}'::jsonb),
    'closing', coalesce((select by_key from closes), '{}'::jsonb),
    'book_names', coalesce((select jsonb_object_agg(book_id, book_name)
                            from (select distinct book_id, book_name from cur) n), '{}'::jsonb),
    'books', case when p_include_books
                  then coalesce((select by_market from books), '{}'::jsonb)
                  else null end
  ) into v_out;
  return v_out;
end;
$$;

-- The slate. One call returns every game in a window with its full market
-- picture, so a board render is a single round trip.
create or replace function collective.odds_board(
  p_league text default 'nfl',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_include_books boolean default true,
  p_limit integer default 40
) returns jsonb language sql stable security definer set search_path = odds, collective, public as $$
  select jsonb_build_object(
    'league', p_league,
    'generated_at', now(),
    'last_poll_at', odds.last_poll_at(),
    'last_odds_at', (select max(s.captured_at) from odds.snapshots s
                     join odds.events e on e.id = s.event_id where e.league = p_league),
    'stale_after_seconds',
      coalesce((odds.get_setting('nfl.stale_after_seconds'))::text::int, 900),
    'games', coalesce((
      select jsonb_agg(odds.event_payload(e.id, p_include_books) order by e.commence_time)
      from (
        select id, commence_time from odds.events
        where league = p_league
          and (p_from is null or commence_time >= p_from)
          and (p_to   is null or commence_time <= p_to)
        order by commence_time
        limit greatest(1, least(coalesce(p_limit, 40), 200))
      ) e), '[]'::jsonb));
$$;

-- One game, by our event id or by the Collective's own game id. The model
-- pages join on the latter, so both are first-class lookups.
create or replace function collective.odds_event(
  p_event_id uuid default null, p_game_id uuid default null,
  p_include_books boolean default true)
returns jsonb language plpgsql stable security definer set search_path = odds, collective, public as $$
declare v_id uuid;
begin
  if p_event_id is not null then
    v_id := p_event_id;
  elsif p_game_id is not null then
    select id into v_id from odds.events where collective_game_id = p_game_id limit 1;
  end if;
  if v_id is null then return null; end if;
  return odds.event_payload(v_id, p_include_books);
end;
$$;

-- Line movement for one series, oldest first. This is the raw record: every
-- stored state, nothing collapsed.
create or replace function collective.odds_history(
  p_event_id uuid, p_market text default null, p_book text default null,
  p_outcome text default null, p_limit integer default 500)
returns jsonb language sql stable security definer set search_path = odds, collective, public as $$
  select jsonb_build_object(
    'event_id', p_event_id,
    'filters', jsonb_build_object('market', p_market, 'book', p_book, 'outcome', p_outcome),
    'points', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', s.captured_at, 'book', s.book_id, 'market', s.market_id,
        'outcome', s.outcome, 'line', s.line, 'price', s.price,
        'implied_prob', s.implied_prob, 'is_live', s.is_live) order by s.captured_at, s.id)
      from (
        select * from odds.snapshots
        where event_id = p_event_id
          and (p_market  is null or market_id = p_market)
          and (p_book    is null or book_id  = p_book)
          and (p_outcome is null or outcome  = p_outcome)
        order by captured_at desc, id desc
        limit greatest(1, least(coalesce(p_limit, 500), 2000))
      ) s), '[]'::jsonb));
$$;

do $mig$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on all functions in schema odds to service_role';
    execute 'grant execute on function collective.odds_board(text,timestamptz,timestamptz,boolean,integer),
             collective.odds_event(uuid,uuid,boolean),
             collective.odds_history(uuid,text,text,text,integer) to service_role';
  end if;
end
$mig$;

-- ------------------------------------------------ function privileges
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Combined
-- with SECURITY DEFINER and a PostgREST-exposed schema that is a writable
-- back door: odds_set_setting, odds_ingest and odds_finalize_closing would be
-- callable by anyone who can reach the schema, and odds_board would hand back
-- everything the view revokes above were meant to protect.
--
-- Least privilege, stated rather than assumed. Runs last so it covers every
-- function defined in this file, including ones added later.
do $mig$
declare r record; has_sr boolean;
begin
  select exists (select 1 from pg_roles where rolname = 'service_role') into has_sr;
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'odds')
       or (n.nspname = 'collective' and p.proname like 'odds\_%')
  loop
    execute format('revoke all on function %s from public', r.sig);
    if has_sr then
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end
$mig$;

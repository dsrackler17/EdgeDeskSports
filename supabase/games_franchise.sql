-- ===========================================================================
-- EDGEDESK GAMES — the franchise layer: a persistent fictional football
-- franchise above the games people already play.
--
-- Paste into the Supabase SQL editor and run. Safe to run again. Run it AFTER
-- supabase/games_social.sql: it references game_challenges (for the trigger
-- that turns a settled Head-to-Head into Coach Points) and auth.users.
--
-- WHAT THIS IS FOR
--   Every player can own ONE fictional franchise: a name, a city, a roster of
--   fictional players, and resources earned by playing EdgeDesk's real games.
--   The franchise is the thing a player returns for; the games are how they
--   improve it. Nothing here is a wager, a prize or a purchase: the resources
--   are points in a free game, and there is no way to buy any of them.
--
-- A TEAM BEFORE AN ACCOUNT
--   Nobody is asked to sign up to get a team. A franchise is founded at once,
--   on the server, and owned by an ACCOUNT or by the DEVICE SECRET the social
--   layer already uses for anonymous Head-to-Head play (games_hash of a
--   256-bit bearer secret the browser generated; the server keeps only the
--   hash). franchise_claim() binds a device-owned franchise to an account
--   later, so signing up keeps everything that earned the signup. An account
--   beats a secret everywhere: a signed-in caller is their account's
--   franchise, never a device's.
--
-- THE ONE ARCHITECTURAL RULE, RESTATED
--   This file computes NO price. game_board is a published COPY of the
--   committed challenge artifact (games/data/challenges.json), written by the
--   trusted build worker with the service role. The canonical Power 4 exporter
--   remains the only thing that prices a game; the server merely needs its
--   own copy so that a browser's numbers are never what a reward is scored
--   against.
--
-- WHAT IS SERVER-AUTHORITATIVE, AND WHY
--   * Player generation. A roster is generated here, from a seed the server
--     derives, so nobody can hand-pick a squad.
--   * Rewards. Every credit goes through franchise_credit(), which writes one
--     ledger row per real thing that happened, keyed (franchise, currency,
--     kind, key). The same thing cannot be credited twice; replaying a request
--     changes nothing. The totals on the franchise row are a cache of the
--     ledger, never the source.
--   * Scoring. Price It is scored against game_board, never a client-supplied
--     price. Pick 5 snapshots the board's line at submission and is settled by
--     the service role from the board's finals.
--   * The weekly game (Phase 2). The schedule is drawn here from a seed the
--     server derives; the opponent's strength is frozen on the game row; the
--     simulator runs here, seeded, from the roster, the scheme, the opponent
--     and the week's recorded preparation. A client sends "play" and nothing
--     else. The same game simulated twice is the same game.
--   * The trust boundary is stated where it is thin: a Two-Minute Drill result
--     is client-reported (the drill is built in the browser from the same
--     artifact). The server enforces one per day and the size of the reward;
--     it cannot verify the answers, and the reward is sized accordingly.
--
-- RLS
--   Enabled everywhere; the default is deny. Owners may READ their own rows.
--   No client role may write any table directly.
-- ===========================================================================

begin;

-- ── helpers ───────────────────────────────────────────────────────────────
-- Core Postgres only, for the reason games_social.sql states: every definer
-- function pins its search_path, so extensions are out of reach by design.

-- The football week: Tuesday 07:00 UTC, the boundary games/lib/week.js
-- documents. The key is the ISO date of the Tuesday the week began on.
create or replace function public.games_week_key(p_at timestamptz default now())
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select to_char(
    date_trunc('day', (p_at at time zone 'UTC') - interval '7 hours')
      - (((extract(dow from ((p_at at time zone 'UTC') - interval '7 hours'))::int - 2 + 7) % 7)
         * interval '1 day'),
    'YYYY-MM-DD');
$$;

-- The calendar day in the boundary's own zone, so "today" means the same
-- thing on the server as in games/lib/week.js dayKey().
create or replace function public.games_day_key(p_at timestamptz default now())
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select to_char((p_at at time zone 'UTC') - interval '7 hours', 'YYYY-MM-DD');
$$;

-- The football season a date belongs to: January and February are the tail
-- of the prior season, the same rule games/build_challenges.js applies.
create or replace function public.games_season_of(p_at timestamptz default now())
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when extract(month from (p_at at time zone 'UTC')) < 3
              then extract(year from (p_at at time zone 'UTC'))::int - 1
              else extract(year from (p_at at time zone 'UTC'))::int end;
$$;

-- THE PRICE IT RULE, exactly as games/lib/scoring.js publishes it:
--     score = max(0, 100 − 10 × ceil(max(0, d − 1)))
-- d is the distance in points, rounded to a tenth first so float noise cannot
-- cost a band. Versioned price_it_v1 on every stored result.
create or replace function public.games_price_it_score(p_distance numeric)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when p_distance is null or p_distance < 0 then null
         else greatest(0, 100 - 10 * ceil(greatest(0, round(p_distance - 1, 1))))::int end;
$$;

-- Which side covered, from a final score and the HOME line the card was
-- picked at (home favoured by 7 is -7). The same rule as scoring.js atsResult.
create or replace function public.games_ats_result(p_home_spread numeric, p_home integer, p_away integer)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when p_home_spread is null or p_home is null or p_away is null then null
    when round(((p_home - p_away) + p_home_spread)::numeric, 2) > 0 then 'home'
    when round(((p_home - p_away) + p_home_spread)::numeric, 2) < 0 then 'away'
    else 'push' end;
$$;

-- Season numerals: Season I, Season II, … the way a franchise counts its own
-- years, independent of the real calendar.
create or replace function public.games_roman(p_n integer)
returns text language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare n integer := coalesce(p_n, 0); out text := '';
  vals integer[] := array[1000,900,500,400,100,90,50,40,10,9,5,4,1];
  syms text[] := array['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  i integer;
begin
  if n < 1 then return '0'; end if;
  for i in 1..array_length(vals, 1) loop
    while n >= vals[i] loop out := out || syms[i]; n := n - vals[i]; end loop;
  end loop;
  return out;
end;
$$;

-- The level curve, the one games/lib/dynasty.js publishes:
--     xpForLevel(L) = 25 × (L − 1) × (L + 2), capped at level 30.
create or replace function public.games_xp_for_level(p_level integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select 25 * (greatest(1, least(30, coalesce(p_level, 1))) - 1)
            * (greatest(1, least(30, coalesce(p_level, 1))) + 2);
$$;

create or replace function public.games_level_for(p_xp integer)
returns integer language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare l integer := 1;
begin
  while l < 30 and coalesce(p_xp, 0) >= 25 * l * (l + 3) loop
    l := l + 1;
  end loop;
  return l;
end;
$$;

-- THE ECONOMY, published as one immutable table so the client (which shows
-- it) and the server (which applies it) cannot disagree without a test
-- noticing. Versioned economy_v1: if any number changes, the version changes
-- and games/README.md says what the old rule was. Nothing here is
-- purchasable, and a subscriber earns exactly what anyone else earns.
create or replace function public.franchise_economy()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'economy_v2',
    'price_it',      jsonb_build_object('xp', 50, 'sp_base', 5, 'sp_per_score', 0.35, 'tc_base', 10, 'tc_per_ten', 1),
    'pick5_card',    jsonb_build_object('xp', 75, 'tc', 25),
    'pick5_correct', jsonb_build_object('xp', 10, 'tc', 15),
    'pick5_perfect', jsonb_build_object('xp', 150, 'tc', 200),
    'drill_daily',   jsonb_build_object('xp', 40, 'tc_per_correct', 3, 'tc_max', 30),
    'research_open', jsonb_build_object('xp', 15, 'cap_per_week', 10),
    'h2h_locked',    jsonb_build_object('xp', 40, 'cp', 1),
    'h2h_win',       jsonb_build_object('xp', 20, 'cp', 2),
    'founded',       jsonb_build_object('tc', 100),
    -- the weekly game (Phase 2): playing it, winning it, beating the rival,
    -- finishing a season
    'weekly_game',   jsonb_build_object('xp', 100, 'tc', 40),
    'weekly_win',    jsonb_build_object('xp', 60, 'tc', 60, 'cp', 2),
    'rival_win',     jsonb_build_object('xp', 50, 'cp', 1),
    'season_complete', jsonb_build_object('xp', 250, 'tc', 150),
    -- the bowl (Phase 7): the ninth game a winning season earns, and taking it
    'bowl_game',     jsonb_build_object('xp', 150, 'tc', 60),
    'bowl_win',      jsonb_build_object('xp', 300, 'tc', 200, 'cp', 5),
    -- franchise vs franchise (Phase 3): a challenge played, won, and won
    -- against a stronger team
    'fc_played',     jsonb_build_object('xp', 60, 'tc', 30),
    'fc_win',        jsonb_build_object('xp', 40, 'tc', 40, 'cp', 2),
    'fc_upset',      jsonb_build_object('xp', 40, 'cp', 1),
    -- the conference (Phase 6): a round played, a round won, a playoff game
    -- won on top of it, and the title
    'conf_game',     jsonb_build_object('xp', 80, 'tc', 35),
    'conf_win',      jsonb_build_object('xp', 50, 'tc', 50, 'cp', 2),
    'conf_playoff',  jsonb_build_object('xp', 100, 'cp', 1),
    'conf_title',    jsonb_build_object('xp', 400, 'tc', 300, 'cp', 10),
    'import_unverified_price_it', jsonb_build_object('xp', 50),
    'import_unverified_pick5',    jsonb_build_object('xp', 75),
    -- THE GAME YOU HOLD (Phase 21): a live game finished, a live game won,
    -- and what the performance itself is worth — capped a day so a grind
    -- pays nothing, scaled by the tier the defence was set to
    'live_game',     jsonb_build_object('xp', 60, 'tc', 25),
    'live_win',      jsonb_build_object('xp', 40, 'tc', 25, 'cp', 1),
    'live_perf',     jsonb_build_object('tc_per_td', 3, 'tc_per_100', 4, 'tc_max', 30, 'xp_per_100', 5, 'xp_max', 40),
    'live_cap',      jsonb_build_object('per_day', 5),
    'live_tier',     jsonb_build_object('rookie', 0.6, 'pro', 1, 'allpro', 1.15, 'legend', 1.3)
  );
$$;

-- Scouting Points for one Price It: 5 + round(score × 0.35). A dead-on read
-- (100) is 40, a score of 60 is 26, a score of 0 is 5 — you always scouted
-- the game, you just did not read it the way the benchmark did.
create or replace function public.franchise_sp_for_score(p_score integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select 5 + round(coalesce(p_score, 0) * 0.35)::int;
$$;

-- Team Credits for one Price It: 10 + one per ten points of score.
create or replace function public.franchise_tc_for_score(p_score integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select 10 + floor(coalesce(p_score, 0) / 10.0)::int;
$$;

-- ── INJURIES — injury_v1 (Phase 7) ───────────────────────────────────────
-- Drawn AFTER a game, from the same seeded stream, and never inside the
-- simulator: the simulator plays exactly the game it always played, and an injury
-- is a thing that is recorded to have happened in it. What it costs is the
-- WEEKS AHEAD — the player is unavailable, the team rating drops, and the
-- next game is played without him.
--
-- Exposure is by position (a back carries the ball; a kicker does not), and
-- doubled for a starter. Conditioning buys the risk down; the Iron Man
-- trait, which until now was stated as having no effect, halves the chance
-- its owner is the one drawn.
create or replace function public.franchise_injuries()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'injury_v1',
    'base', 0.22,                       -- the chance a franchise loses somebody in a game
    'per_conditioning', 0.03,           -- less, per level of the Conditioning facility
    'iron_man', 0.5,                    -- the weight multiplier on a player who has the trait
    'exposure', jsonb_build_object('QB', 0.8, 'RB', 1.6, 'WR', 1.0, 'TE', 0.9, 'OL', 1.2,
                                   'DL', 1.3, 'LB', 1.2, 'CB', 1.0, 'S', 0.9, 'K', 0.05, 'P', 0.05),
    'starter_weight', 2.0,
    'severity', jsonb_build_array(
      jsonb_build_object('key', 'knock',    'name', 'Knock',    'games', 1, 'p', 0.45),
      jsonb_build_object('key', 'strain',   'name', 'Strain',   'games', 2, 'p', 0.30),
      jsonb_build_object('key', 'sprain',   'name', 'Sprain',   'games', 3, 'p', 0.18),
      jsonb_build_object('key', 'fracture', 'name', 'Fracture', 'games', 5, 'p', 0.07)));
$$;

-- IS THIS PLAYER AVAILABLE? Availability is a function of the CLOCK, not of
-- a job: a player carries the football week he is fit again, and every read
-- compares it against the time it is asked about. There is no heal step to
-- run, no cron to miss, and no window in which a healed player is still
-- listed as hurt. (`game_players.status` still admits 'injured'; it stays
-- unused room, because a status would need somebody to change it back.)
create or replace function public.franchise_is_available(
  p_status text, p_injured_until timestamptz, p_at timestamptz default now())
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select p_status = 'active' and (p_injured_until is null or p_injured_until <= p_at);
$$;

-- ── the published board ──────────────────────────────────────────────────
-- A COPY of games/data/challenges.json, one row per game, written only by the
-- service role (games/publish_board.js). Public read: it is the same artifact
-- every /games page already fetches. Finals land here too, which is what lets
-- Pick 5 settle on the server.
create table if not exists public.game_board (
  game_id          text primary key,
  season           integer,
  week             integer,
  slug             text,
  home_team        text,
  away_team        text,
  kickoff          timestamptz,
  neutral_site     boolean not null default false,
  edgedesk_spread  numeric,
  market_spread    numeric,
  confidence       integer,
  research_state   text,
  status           text,
  final_home       integer,
  final_away       integer,
  final_at         timestamptz,
  published_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists game_board_kickoff on public.game_board (kickoff);
create index if not exists game_board_open_finals on public.game_board (final_at) where final_home is not null;

-- ── franchises ────────────────────────────────────────────────────────────
-- One per account. Identity is lightweight on purpose: a name, a city, an
-- abbreviation, a mark from a fixed set, a colour theme from a fixed set,
-- and two scheme identities. The check constraints ARE the option lists;
-- games/lib/franchise.js carries the same lists and a test holds them equal.
create table if not exists public.franchises (
  id               uuid primary key default gen_random_uuid(),
  -- owned by an account OR by a device secret's hash, never neither
  user_id          uuid unique references auth.users (id) on delete cascade,
  anon_hash        text unique,
  name             text not null check (char_length(name) between 2 and 28),
  city             text not null check (char_length(city) between 2 and 24),
  abbr             text not null check (abbr ~ '^[A-Z0-9]{2,4}$'),
  logo             text not null check (logo in
                     ('star','bolt','shield','wolf','horn','anchor','arrow','flame',
                      'crown','wing','gear','wave','peak','eagle','bull','spear')),
  theme            text not null check (theme in
                     ('forest','navy','crimson','gold','slate','violet','teal','orange','maroon','black')),
  offense          text not null check (offense in
                     ('air_raid','spread','pro_style','power_run','option','west_coast')),
  defense          text not null check (defense in
                     ('four_three','three_four','press_man','zone','blitz_heavy','bend_dont_break')),
  founded_season   integer not null,
  seed             text not null,
  -- cached totals: a READ MODEL of franchise_ledger, recomputed on every
  -- credit. The ledger is the truth; these exist so the home page is one row.
  xp               integer not null default 0,
  scouting_points  integer not null default 0,
  team_credits     integer not null default 0,
  coach_points     integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint franchises_owned check (user_id is not null or anon_hash is not null)
);

-- A season of a franchise's life. TWO CALENDARS: the franchise keeps its own
-- — Season I, Season II, … each a fixed number of weeks, several to a real
-- year — and records which real football season it began in. Real football
-- makes the games richer while it is on; the franchise does not stop existing
-- when it is not. Created with the franchise (Season I, the founder season)
-- and by rollover later; the record a season leaves is permanent.
create table if not exists public.franchise_seasons (
  franchise_id     uuid not null references public.franchises (id) on delete cascade,
  number           integer not null check (number >= 1),
  label            text not null,
  season           integer not null,          -- the real football season it began in
  status           text not null default 'preseason'
                     check (status in ('preseason', 'active', 'playoffs', 'complete')),
  weeks            integer not null default 8 check (weeks between 4 and 16),
  week             integer not null default 0 check (week >= 0),
  wins             integer not null default 0,
  losses           integer not null default 0,
  ties             integer not null default 0,
  points_for       integer not null default 0,
  points_against   integer not null default 0,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  primary key (franchise_id, number)
);
-- the offseason that followed a completed season: who grew, who declined,
-- who retired, who was signed — written once by the server (Phase 4)
alter table public.franchise_seasons add column if not exists offseason jsonb;

-- ── fictional players ─────────────────────────────────────────────────────
-- Generated here, never by a client. Ratings are small: four visible
-- attributes per position and an overall that is their mean, so a card is
-- readable on a phone and a future simulator has something honest to run on.
create table if not exists public.game_players (
  id                 uuid primary key default gen_random_uuid(),
  franchise_id       uuid references public.franchises (id) on delete cascade,
  first_name         text not null,
  last_name          text not null,
  position           text not null check (position in ('QB','RB','WR','TE','OL','DL','LB','CB','S','K','P')),
  jersey             integer not null check (jersey between 0 and 99),
  age                integer not null check (age between 18 and 45),
  overall            integer not null check (overall between 1 and 99),
  archetype          text not null,
  dev_tier           text not null check (dev_tier in ('normal','quick','star','superstar')),
  potential          integer not null check (potential between 1 and 99),
  stamina            integer not null check (stamina between 1 and 99),
  chemistry          integer not null default 50 check (chemistry between 0 and 100),
  rarity             text not null check (rarity in ('common','uncommon','rare','elite')),
  ratings            jsonb not null default '{}'::jsonb,
  traits             jsonb not null default '[]'::jsonb,
  depth              integer not null default 1,
  status             text not null default 'active' check (status in ('active','injured','retired','released')),
  acquired_source    text not null,
  acquired_season    integer not null,
  acquired_detail    text,
  career_stats       jsonb not null default '{}'::jsonb,
  season_stats       jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- the franchise season a player retired after (Phase 4); an alumnus keeps
-- his row, his card and his career line
alter table public.game_players add column if not exists retired_season integer;
-- THE DRAFT AND THE MARKET (Phase 5). A prospect is a player of the
-- franchise who is not on the roster yet: he sits in a window's draft class
-- with his true ratings hidden until a scouting report is bought with
-- Scouting Points. A free agent sits on the market with an asking price in
-- Team Credits. Either joins the roster only through the server
-- (franchise_draft, franchise_sign); one passed over when the next window
-- opens is `passed` and stays as a record. The status check is replaced by
-- name so an earlier installation admits the new states without a rebuild.
alter table public.game_players drop constraint if exists game_players_status_check;
alter table public.game_players add constraint game_players_status_check
  check (status in ('active','injured','retired','released','prospect','free_agent','passed'));
alter table public.game_players add column if not exists class_season integer;
alter table public.game_players add column if not exists scouted boolean not null default false;
alter table public.game_players add column if not exists asking integer;
alter table public.franchises add column if not exists draft_picks integer not null default 0;
alter table public.franchises add column if not exists market_season integer;
create index if not exists game_players_market on public.game_players (franchise_id, status, class_season);

create index if not exists game_players_franchise on public.game_players (franchise_id, position, depth);

-- INJURIES (Phase 7). The instant a player is fit again, and what happened
-- to him. He is still on the roster while he is hurt — he counts against
-- the ceiling, holds his number and his place on the depth chart — he
-- simply cannot play. Null is fit.
alter table public.game_players add column if not exists injured_until timestamptz;
alter table public.game_players add column if not exists injury jsonb;
create index if not exists game_players_injured on public.game_players (franchise_id, injured_until);


-- ── the record: one row per real thing that happened ─────────────────────
-- Rewards are DERIVED from these rows through the ledger. A row is keyed
-- (franchise, kind, key) so the same Price It, card, drill day or research
-- open cannot be recorded twice. `verified` says whether the server could
-- check it against the board; `detail` holds what was checked.
create table if not exists public.franchise_activity (
  id             bigserial primary key,
  franchise_id   uuid not null references public.franchises (id) on delete cascade,
  kind           text not null check (kind in
                   ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
                    'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
                    'market','scout','draft','signing','release')),
  key            text not null,
  week_key       text not null,
  day_key        text not null,
  verified       boolean not null default true,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (franchise_id, kind, key)
);

create index if not exists franchise_activity_week on public.franchise_activity (franchise_id, week_key);

-- ── the ledger ────────────────────────────────────────────────────────────
-- APPEND ONLY. Every credit names the real row it came from. A player's
-- resources are the sum of this table, and the franchise row's cached totals
-- are recomputed from it on every write.
create table if not exists public.franchise_ledger (
  id             bigserial primary key,
  franchise_id   uuid not null references public.franchises (id) on delete cascade,
  currency       text not null check (currency in ('xp','sp','tc','cp')),
  delta          integer not null,
  kind           text not null,
  key            text not null,
  label          text,
  economy        text not null default 'economy_v2',
  created_at     timestamptz not null default now(),
  unique (franchise_id, currency, kind, key)
);

create index if not exists franchise_ledger_recent on public.franchise_ledger (franchise_id, created_at desc);

-- ── Pick 5 on the server ──────────────────────────────────────────────────
-- The card snapshots the BOARD'S line at submission, never the browser's,
-- and is settled by the service role from the board's finals.
create table if not exists public.franchise_pick5_cards (
  id             uuid primary key default gen_random_uuid(),
  franchise_id   uuid not null references public.franchises (id) on delete cascade,
  week_key       text not null,
  imported       boolean not null default false,
  submitted_at   timestamptz not null default now(),
  settled_at     timestamptz,
  correct        integer not null default 0,
  decided        integer not null default 0,
  unique (franchise_id, week_key)
);

create table if not exists public.franchise_pick5_selections (
  card_id        uuid not null references public.franchise_pick5_cards (id) on delete cascade,
  game_id        text not null,
  pick           text not null check (pick in ('home','away')),
  market_spread  numeric,
  result         text check (result in ('win','loss','push')),
  settled_at     timestamptz,
  primary key (card_id, game_id)
);

-- ── achievements ─────────────────────────────────────────────────────────
-- Definitions are rows so the Trophy Room can list what exists; an exclusive
-- season means the achievement can never be earned outside that season.
create table if not exists public.franchise_achievement_defs (
  id               text primary key,
  name             text not null,
  description      text not null,
  exclusive_season integer,
  sort             integer not null default 100
);

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('founder_2026',   'Founder Season 2026', 'Founded a franchise in the 2026 season. Never available again.', 2026, 1),
  ('first_price',    'First Scout',         'The first Price It your scouting department filed.', null, 10),
  ('market_master',  'Market Master',       'A Price It scored 100 against the benchmark.', null, 11),
  ('first_card',     'First Card',          'The first Pick 5 card your franchise submitted.', null, 20),
  ('perfect_card',   'Perfect Card',        'A Pick 5 card that went 5–0.', null, 21),
  ('first_h2h_win',  'First Head-to-Head',  'Your franchise''s first Head-to-Head win.', null, 30)
on conflict (id) do nothing;

create table if not exists public.franchise_achievements (
  franchise_id   uuid not null references public.franchises (id) on delete cascade,
  achievement_id text not null references public.franchise_achievement_defs (id),
  season         integer not null,
  earned_at      timestamptz not null default now(),
  detail         jsonb not null default '{}'::jsonb,
  primary key (franchise_id, achievement_id)
);

-- ── THE WEEKLY GAME: the opponent pool and the schedule ──────────────────
-- Phase 2. A franchise season is eight weekly games against fictional clubs
-- from a fixed pool, one game per football week, each one simulated on the
-- server from the roster, the scheme, the opponent and that week's
-- preparation. Nothing about a game is decided in a browser.
--
-- The pool is rows, not a constant, so the Game Day page can show a club's
-- mark and character without a round trip through code. Every club shares
-- the franchise's own identity lists, so one set of marks and colours
-- serves both.
create table if not exists public.franchise_opponents (
  key      text primary key,
  city     text not null,
  name     text not null,
  abbr     text not null check (abbr ~ '^[A-Z0-9]{2,4}$'),
  logo     text not null check (logo in
             ('star','bolt','shield','wolf','horn','anchor','arrow','flame',
              'crown','wing','gear','wave','peak','eagle','bull','spear')),
  theme    text not null check (theme in
             ('forest','navy','crimson','gold','slate','violet','teal','orange','maroon','black')),
  offense  text not null check (offense in
             ('air_raid','spread','pro_style','power_run','option','west_coast')),
  defense  text not null check (defense in
             ('four_three','three_four','press_man','zone','blitz_heavy','bend_dont_break')),
  style    text not null,
  sort     integer not null default 100
);

insert into public.franchise_opponents (key, city, name, abbr, logo, theme, offense, defense, style, sort) values
  ('bayou',      'Bayou',       'Marsh Hawks',  'BAY', 'wing',   'teal',    'spread',     'zone',            'Tempo, and a secondary that reads eyes.',            1),
  ('iron_ridge', 'Iron Ridge',  'Forgemen',     'IRF', 'gear',   'slate',   'power_run',  'three_four',      'Downhill, two-gap, no apologies.',                   2),
  ('cape',       'Cape Harbor', 'Gulls',        'CPH', 'wave',   'navy',    'west_coast', 'bend_dont_break', 'Short throws and a long field.',                     3),
  ('prairie',    'Prairie',     'Bison',        'PRB', 'bull',   'maroon',  'power_run',  'four_three',      'Runs it until you stop it.',                         4),
  ('summit',     'Summit',      'Peaks',        'SMT', 'peak',   'forest',  'pro_style',  'four_three',      'Play-action from under center.',                     5),
  ('delta',      'Delta',       'Dukes',        'DLK', 'crown',  'gold',    'air_raid',   'press_man',       'Four wide, and corners on an island.',               6),
  ('north_fork', 'North Fork',  'Greywolves',   'NFW', 'wolf',   'black',   'option',     'blitz_heavy',     'Reads at the mesh, pressure from everywhere.',       7),
  ('coal',       'Coal County', 'Miners',       'CCM', 'peak',   'orange',  'power_run',  'three_four',      'Grinds the clock and the line.',                     8),
  ('salt_flats', 'Salt Flats',  'Anchors',      'SLT', 'anchor', 'navy',    'pro_style',  'zone',            'Patient, balanced, hard to fool.',                   9),
  ('red_river',  'Red River',   'Outriders',    'RRO', 'spear',  'crimson', 'spread',     'press_man',       'Fast, aggressive, sometimes reckless.',              10),
  ('lakeshore',  'Lakeshore',   'Voltage',      'LKS', 'bolt',   'violet',  'air_raid',   'zone',            'Throws it fifty times and dares you.',               11),
  ('canyon',     'Canyon',      'Condors',      'CYN', 'eagle',  'orange',  'west_coast', 'four_three',      'Rhythm passing, sound tackling.',                    12),
  ('harbor',     'Harbor',      'Wardens',      'HBR', 'shield', 'slate',   'pro_style',  'bend_dont_break', 'Gives you yards, not points.',                       13),
  ('high_plains','High Plains', 'Stampede',     'HPS', 'horn',   'gold',    'option',     'four_three',      'The quarterback runs. A lot.',                       14),
  ('bluegrass',  'Bluegrass',   'Blaze',        'BLG', 'star',   'navy',    'spread',     'blitz_heavy',     'Points in bunches, both directions.',                15),
  ('foundry',    'Foundry',     'Smiths',       'FDR', 'flame',  'crimson', 'air_raid',   'blitz_heavy',     'Chaos on both sides of the ball.',                   16),
  ('river_bend', 'River Bend',  'Otters',       'RVB', 'wave',   'teal',    'west_coast', 'zone',            'Neat, efficient, rarely beaten badly.',              17),
  ('granite',    'Granite',     'Guards',       'GRN', 'shield', 'black',   'power_run',  'bend_dont_break', 'Wins 17–13 and likes it.',                           18),
  ('sunset',     'Sunset',      'Arrows',       'SNS', 'arrow',  'orange',  'spread',     'zone',            'Quick, spread out, a step fast.',                    19),
  ('timberline', 'Timberline',  'Oxen',         'TMB', 'bull',   'forest',  'pro_style',  'three_four',      'Big up front, patient behind it.',                   20),
  ('capital',    'Capital',     'Regents',      'CAP', 'crown',  'violet',  'west_coast', 'press_man',       'Composed, precise, and it presses you.',             21),
  ('estuary',    'Estuary',     'Herons',       'EST', 'wing',   'slate',   'option',     'zone',            'Misdirection, then discipline.',                     22),
  ('mesa',       'Mesa',        'Monarchs',     'MSA', 'crown',  'maroon',  'air_raid',   'four_three',      'Airs it out in thin air.',                           23),
  ('frontier',   'Frontier',    'Wranglers',    'FRT', 'horn',   'gold',    'power_run',  'press_man',       'Runs, and dares you to throw.',                      24)
on conflict (key) do nothing;

-- THE RIVAL. Chosen once, when Season I is scheduled, and kept for life:
-- every season ends against them, and the rivalry record is permanent.
alter table public.franchises add column if not exists rival_key text references public.franchise_opponents (key);
-- the device hash a franchise was claimed FROM, kept so a Head-to-Head
-- entered anonymously before the claim still maps to the franchise after it
alter table public.franchises add column if not exists claimed_hash text;
-- FACILITIES (Phase 4): the first place earned resources are spent. Levels
-- per facility; the table of costs and effects is franchise_facilities().
alter table public.franchises add column if not exists facilities jsonb not null default '{"training":0,"film":0,"conditioning":0,"stadium":0}'::jsonb;

-- ONE GAME. Scheduled with the season (the opponent's identity and ratings
-- frozen at scheduling, so a schedule cannot change under a player), opened
-- on the Saturday of its football week, and played once. `seed` is derived
-- by the server; the simulator is a pure function of it and the state of
-- the roster, which is what makes a result reproducible and unforgeable.
create table if not exists public.franchise_games (
  id              uuid primary key default gen_random_uuid(),
  franchise_id    uuid not null references public.franchises (id) on delete cascade,
  season_number   integer not null,
  week            integer not null check (week >= 1),
  week_key        text not null,          -- the football week the game belongs to
  opens_at        timestamptz not null,   -- Saturday 07:00 UTC of that week
  opponent_key    text not null references public.franchise_opponents (key),
  opponent        jsonb not null,         -- identity + ratings, frozen at scheduling
  home            boolean not null,
  rival           boolean not null default false,
  status          text not null default 'scheduled' check (status in ('scheduled', 'final')),
  seed            text not null,
  played_at       timestamptz,
  score_for       integer,
  score_against   integer,
  result          text check (result in ('W', 'L', 'T')),
  box             jsonb not null default '{}'::jsonb,
  sim_version     text,
  created_at      timestamptz not null default now(),
  unique (franchise_id, season_number, week),
  foreign key (franchise_id, season_number) references public.franchise_seasons (franchise_id, number) on delete cascade
);

create index if not exists franchise_games_next on public.franchise_games (franchise_id, season_number, status, week);

-- THE BOWL (Phase 7): the ninth game a winning season earns. It is a
-- franchise_games row like any other — same simulator, same box — flagged so
-- the pages can name it and the ledger can pay it its own rate.
alter table public.franchise_games add column if not exists bowl boolean not null default false;

-- The record grows kinds with the weekly game. The constraint is replaced by
-- name (the name Postgres gives an inline column check) so an installation
-- that applied Phase 1 gets the new kinds without a rebuild.
alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('first_win',       'First Win',       'Your franchise''s first weekly game won.', null, 40),
  ('bragging_rights', 'Bragging Rights', 'Beat your rival.', null, 41),
  ('shutout',         'Shutout',         'Held an opponent scoreless.', null, 42),
  ('first_season',    'A Full Season',   'Completed your first franchise season.', null, 43),
  ('winning_season',  'Winning Season',  'Finished a season with more wins than losses.', null, 44),
  ('perfect_season',  'Perfect Season',  'Won every game of a season.', null, 45)
on conflict (id) do nothing;

-- ── FRANCHISE VS FRANCHISE: challenges, rivalries, the ladder ────────────
-- Phase 3. A franchise can challenge another franchise to a game on the
-- same simulator the season runs on: both rosters, both schemes, both
-- weeks' preparation, a neutral field. The challenge is an invite link, the
-- same shape as Head-to-Head's; whoever opens it with a franchise of their
-- own plays it at once, on the server. Every challenge writes a rivalry
-- record between the two franchises, and moves both on a ladder that lists
-- franchises only — never accounts.
alter table public.franchises add column if not exists ladder_rating integer not null default 1500;
alter table public.franchises add column if not exists ladder_games integer not null default 0;

create table if not exists public.franchise_challenges (
  id               uuid primary key default gen_random_uuid(),
  invite_token     text not null unique default public.games_token(),
  challenger_id    uuid not null references public.franchises (id) on delete cascade,
  opponent_id      uuid references public.franchises (id) on delete set null,
  status           text not null default 'OPEN' check (status in ('OPEN', 'FINAL', 'EXPIRED', 'CANCELLED')),
  note             text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '14 days',
  played_at        timestamptz,
  week_key         text,
  seed             text,
  score_challenger integer,
  score_opponent   integer,
  result           text check (result in ('W', 'L', 'T')),   -- the challenger's
  box              jsonb not null default '{}'::jsonb,
  sim_version      text,
  rating_delta     integer                                   -- the challenger's ladder move
);

create index if not exists franchise_challenges_challenger on public.franchise_challenges (challenger_id, created_at desc);
create index if not exists franchise_challenges_opponent on public.franchise_challenges (opponent_id, played_at desc);

-- One row per (franchise, other franchise), both directions, kept for good.
-- Franchise challenges and real-game Head-to-Heads are counted apart, so a
-- page can say "2–1 on the field, 3–0 on the board".
create table if not exists public.franchise_rivalries (
  franchise_id   uuid not null references public.franchises (id) on delete cascade,
  other_id       uuid not null references public.franchises (id) on delete cascade,
  fc_wins        integer not null default 0,
  fc_losses      integer not null default 0,
  fc_ties        integer not null default 0,
  h2h_wins       integer not null default 0,
  h2h_losses     integer not null default 0,
  h2h_draws      integer not null default 0,
  last_played_at timestamptz,
  primary key (franchise_id, other_id)
);

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('fc_first',     'Exhibition Debut', 'Played your first franchise challenge.', null, 50),
  ('fc_first_win', 'Beat a Friend',    'Won a franchise challenge.', null, 51),
  ('fc_upset',     'Giant Killer',     'Beat a franchise rated five or more points higher than yours.', null, 52),
  ('fc_three',     'Three Straight',   'Won three franchise challenges in a row.', null, 53)
on conflict (id) do nothing;

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('first_upgrade', 'Groundbreaking', 'Upgraded a facility with resources your franchise earned.', null, 60),
  ('breakout',      'Breakout',       'A player gained four or more overall in one offseason.', null, 61),
  ('farewell',      'Farewell',       'A founding-roster player retired with your franchise.', null, 62)
on conflict (id) do nothing;

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('draft_day',     'Draft Day',         'Drafted your first prospect.', null, 70),
  ('full_scout',    'Scouted the Class', 'Bought a scouting report on every prospect in a draft class.', null, 71),
  ('gut_call',      'Gut Call',          'Drafted a prospect unscouted who turned out to have a potential of 80 or more.', null, 72),
  ('first_signing', 'Open for Business', 'Signed your first free agent.', null, 73)
on conflict (id) do nothing;

-- ===========================================================================
-- ROW LEVEL SECURITY — deny by default; owners read their own; nobody writes.
-- ===========================================================================

alter table public.game_board                  enable row level security;
alter table public.franchises                  enable row level security;
alter table public.franchise_seasons           enable row level security;
alter table public.game_players                enable row level security;
alter table public.franchise_activity          enable row level security;
alter table public.franchise_ledger            enable row level security;
alter table public.franchise_pick5_cards       enable row level security;
alter table public.franchise_pick5_selections  enable row level security;
alter table public.franchise_achievement_defs  enable row level security;
alter table public.franchise_achievements      enable row level security;

-- "Does the caller own this franchise?" — a definer function for the same
-- reason games_is_member is one: a policy that asks its own table recurses.
create or replace function public.franchise_is_mine(p_franchise uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.franchises f where f.id = p_franchise and f.user_id = auth.uid());
$$;

drop policy if exists game_board_read on public.game_board;
create policy game_board_read on public.game_board for select using (true);

drop policy if exists franchise_achievement_defs_read on public.franchise_achievement_defs;
create policy franchise_achievement_defs_read on public.franchise_achievement_defs for select using (true);

drop policy if exists franchises_own on public.franchises;
create policy franchises_own on public.franchises for select
  using (user_id is not null and user_id = auth.uid());

drop policy if exists franchise_seasons_own on public.franchise_seasons;
create policy franchise_seasons_own on public.franchise_seasons for select
  using (public.franchise_is_mine(franchise_id));

-- a prospect's true ratings are for sale, so the direct read admits no
-- prospect and no free agent: the market board (franchise_market_board) is
-- the only way to look at either, and it shows what has been paid for
drop policy if exists game_players_own on public.game_players;
create policy game_players_own on public.game_players for select
  using (franchise_id is not null and public.franchise_is_mine(franchise_id) and status not in ('prospect', 'free_agent'));

drop policy if exists franchise_activity_own on public.franchise_activity;
create policy franchise_activity_own on public.franchise_activity for select
  using (public.franchise_is_mine(franchise_id));

drop policy if exists franchise_ledger_own on public.franchise_ledger;
create policy franchise_ledger_own on public.franchise_ledger for select
  using (public.franchise_is_mine(franchise_id));

drop policy if exists franchise_pick5_cards_own on public.franchise_pick5_cards;
create policy franchise_pick5_cards_own on public.franchise_pick5_cards for select
  using (public.franchise_is_mine(franchise_id));

drop policy if exists franchise_pick5_selections_own on public.franchise_pick5_selections;
create policy franchise_pick5_selections_own on public.franchise_pick5_selections for select
  using (exists (select 1 from public.franchise_pick5_cards c
                  where c.id = franchise_pick5_selections.card_id
                    and public.franchise_is_mine(c.franchise_id)));

drop policy if exists franchise_achievements_own on public.franchise_achievements;
create policy franchise_achievements_own on public.franchise_achievements for select
  using (public.franchise_is_mine(franchise_id));

alter table public.franchise_opponents         enable row level security;
alter table public.franchise_games             enable row level security;

drop policy if exists franchise_opponents_read on public.franchise_opponents;
create policy franchise_opponents_read on public.franchise_opponents for select using (true);

drop policy if exists franchise_games_own on public.franchise_games;
create policy franchise_games_own on public.franchise_games for select
  using (public.franchise_is_mine(franchise_id));

alter table public.franchise_challenges        enable row level security;
alter table public.franchise_rivalries         enable row level security;

drop policy if exists franchise_challenges_party on public.franchise_challenges;
create policy franchise_challenges_party on public.franchise_challenges for select
  using (public.franchise_is_mine(challenger_id) or (opponent_id is not null and public.franchise_is_mine(opponent_id)));

drop policy if exists franchise_rivalries_own on public.franchise_rivalries;
create policy franchise_rivalries_own on public.franchise_rivalries for select
  using (public.franchise_is_mine(franchise_id));

commit;

-- ===========================================================================
-- THE LEDGER WRITE, THE PLAYER GENERATOR, THE TEAM RATING
--
-- Internal functions. None is granted to a client role; they are reached only
-- through the public functions further down, which decide who is calling.
-- ===========================================================================

begin;

-- ONE credit. Idempotent by (franchise, currency, kind, key): the same real
-- thing credits once, and the cached totals are recomputed from the ledger
-- rather than incremented, so they cannot drift. Returns whether it wrote.
create or replace function public.franchise_credit(
  p_franchise uuid, p_currency text, p_delta integer, p_kind text, p_key text, p_label text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if p_franchise is null or p_delta is null or p_delta = 0 then return false; end if;
  insert into public.franchise_ledger (franchise_id, currency, delta, kind, key, label)
  values (p_franchise, p_currency, p_delta, p_kind, p_key, p_label)
  on conflict (franchise_id, currency, kind, key) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update public.franchises f
     set xp = (select coalesce(sum(l.delta), 0) from public.franchise_ledger l
                where l.franchise_id = f.id and l.currency = 'xp'),
         scouting_points = (select coalesce(sum(l.delta), 0) from public.franchise_ledger l
                where l.franchise_id = f.id and l.currency = 'sp'),
         team_credits = (select coalesce(sum(l.delta), 0) from public.franchise_ledger l
                where l.franchise_id = f.id and l.currency = 'tc'),
         coach_points = (select coalesce(sum(l.delta), 0) from public.franchise_ledger l
                where l.franchise_id = f.id and l.currency = 'cp'),
         updated_at = now()
   where f.id = p_franchise;
  return true;
end;
$$;

-- One achievement, once. Exclusive achievements refuse any other season.
create or replace function public.franchise_award(
  p_franchise uuid, p_achievement text, p_season integer, p_detail jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.franchise_achievement_defs%rowtype; n integer;
begin
  select * into d from public.franchise_achievement_defs where id = p_achievement;
  if not found then return false; end if;
  if d.exclusive_season is not null and d.exclusive_season <> p_season then return false; end if;
  insert into public.franchise_achievements (franchise_id, achievement_id, season, detail)
  values (p_franchise, p_achievement, p_season, coalesce(p_detail, '{}'::jsonb))
  on conflict (franchise_id, achievement_id) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- A seed string to a setseed() argument in [-1, 1]. The generator is a pure
-- function of this number, which is what makes a roster reproducible and
-- testable: the same seed always builds the same 38 players.
create or replace function public.franchise_seed_float(p_seed text)
returns double precision language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select greatest(-1.0, least(1.0,
    (('x' || substr(md5(coalesce(p_seed, '')), 1, 8))::bit(32)::int)::double precision / 2147483647.0));
$$;

-- ── the pools the generator draws from ───────────────────────────────────
-- The name lists, the roster plan, the archetypes and the trait pool, as
-- immutable functions so the founding generator and the offseason's rookie
-- generator draw from the same well. The founding generator's draws are
-- unchanged: it reads the same values in the same order.
create or replace function public.franchise_pool_first_names()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'Mason','Cameron','Jalen','Trey','Dorian','Malik','Bryce','Colton','Elijah','Deshawn',
    'Tanner','Marcus','Kellen','Rashad','Tyler','Isaiah','Devin','Grant','Xavier','Jordan',
    'Caleb','Andre','Brock','Terrell','Wyatt','Darius','Hunter','Jamal','Cody','Antonio',
    'Landon','Kwame','Reid','Tavion','Ethan','Deandre','Cole','Jaylen','Nolan','Marquis',
    'Griffin','Omari','Beau','Zion','Sawyer','Ezekiel','Parker','Amari','Weston','Kendrick',
    'Dalton','Javon','Miles','Roman','Silas','Terrance','Blake','Kalil','Rhett','Dashawn',
    'Emmett','Lamar','Everett','Quincy','Holden','Tremaine','Jasper','Cedric','Wade','Jerome',
    'Hayes','Donovan','Ford','Micah','Boone','Keon','Lincoln','Reggie','Cash','Marlon',
    'Tucker','Isaac','Brooks','Andre','Knox','Terrell','Cruz','Dante','Sterling','Kofi',
    'Ridge','Josiah','Colby','Malachi','Turner','Rasheed','Gage','Adrian','Walker','Jabari',
    'Bishop','Tobias','Cyrus','Elias','Vance','Amos','Judah','Levi','Rowan','Otis'];
$$;

create or replace function public.franchise_pool_last_names()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'Crowe','Redd','Vale','Hargrove','Whitlock','Bell','Okafor','Dawson','Pruitt','Marsh',
    'Calloway','Reyes','Sutton','Banks','Thorne','Delgado','Mercer','Kincaid','Ashby','Fontaine',
    'Greer','Holloway','Ingram','Jessup','Kerrigan','Lockhart','Maddox','Navarro','Osei','Pemberton',
    'Quinlan','Rourke','Sable','Tillman','Underwood','Vickers','Wolfe','Yates','Zeller','Abernathy',
    'Barlow','Coyle','Driscoll','Easton','Fairbanks','Gaines','Hensley','Ivory','Jarrett','Keller',
    'Lattimore','Moncrief','Northcutt','Oakes','Pettigrew','Ramsey','Sheppard','Tremble','Upshaw','Voss',
    'Whitfield','Beaumont','Castellano','Duvall','Everly','Falk','Gatlin','Harlan','Iverson','Jubilee',
    'Kessler','Lindqvist','Montague','Nash','Oduya','Prescott','Ridley','Stovall','Tolbert','Vaughn',
    'Wexler','Bloom','Corbin','Denning','Ellsworth','Fenwick','Granger','Hobbs','Isley','Jennings',
    'Knowles','Landry','Mathis','Newsome','Orland','Pike','Rutledge','Sizemore','Truett','Vandiver',
    'Whitaker','Ainsley','Bright','Chisholm','Dorsey','Emerson','Fielder','Goodwin','Haskins','Irwin',
    'Jacoby','Kilgore','Lemieux','Mallory','Nix','Overton','Pinkney','Rawls','Stanton','Tibbs',
    'Ulrich','Villanueva','Waverly','Blackwood','Coleman','Darby','Escobar','Frost','Gilliam','Hollis',
    'Ibarra','Judd','Kemp','Lacey','Merriweather','Oyelaran','Pace','Reinholt','Sloan','Tatum',
    'Vega','Winslow','Ackerman','Boudreaux','Carrick','Dunbar','Farrow','Guthrie','Hyde','Larkin'];
$$;

create or replace function public.franchise_pool_plan()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '[
    {"pos":"QB","starters":1,"targets":[72,62],"attrs":["arm","acc","iq","spd"],"nums":[1,19]},
    {"pos":"RB","starters":1,"targets":[70,64,58],"attrs":["spd","pwr","elu","hnd"],"nums":[20,39]},
    {"pos":"WR","starters":3,"targets":[72,69,66,60,56],"attrs":["spd","rte","hnd","iq"],"nums":[80,89]},
    {"pos":"TE","starters":1,"targets":[68,60],"attrs":["hnd","blk","rte","spd"],"nums":[40,49]},
    {"pos":"OL","starters":5,"targets":[70,69,68,67,66,60,56],"attrs":["pbk","rbk","str","iq"],"nums":[60,79]},
    {"pos":"DL","starters":4,"targets":[71,69,68,66,60,56],"attrs":["prs","rst","str","spd"],"nums":[90,99]},
    {"pos":"LB","starters":3,"targets":[70,68,66,59],"attrs":["tkl","cov","spd","iq"],"nums":[50,59]},
    {"pos":"CB","starters":2,"targets":[71,68,61,57],"attrs":["cov","spd","tkl","bhk"],"nums":[20,39]},
    {"pos":"S","starters":2,"targets":[69,67,59],"attrs":["cov","tkl","bhk","iq"],"nums":[20,39]},
    {"pos":"K","starters":1,"targets":[70],"attrs":["pwr","acc","clu","con"],"nums":[1,19]},
    {"pos":"P","starters":1,"targets":[69],"attrs":["pwr","acc","clu","con"],"nums":[1,19]}
  ]'::jsonb;
$$;

create or replace function public.franchise_pool_archetypes()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{
    "QB":[{"name":"Field General","skew":{"iq":6,"acc":3,"arm":-2,"spd":-4}},
          {"name":"Gunslinger","skew":{"arm":7,"acc":-2,"iq":-1,"spd":-2}},
          {"name":"Scrambler","skew":{"spd":8,"arm":-3,"acc":-2,"iq":-1}}],
    "RB":[{"name":"Power Back","skew":{"pwr":7,"elu":-3,"spd":-2}},
          {"name":"Elusive Back","skew":{"elu":7,"spd":3,"pwr":-5}},
          {"name":"Receiving Back","skew":{"hnd":7,"elu":2,"pwr":-4}}],
    "WR":[{"name":"Deep Threat","skew":{"spd":8,"rte":-3,"hnd":-2}},
          {"name":"Route Runner","skew":{"rte":7,"iq":3,"spd":-3}},
          {"name":"Possession","skew":{"hnd":7,"iq":2,"spd":-4}}],
    "TE":[{"name":"Seam Stretcher","skew":{"spd":6,"rte":3,"blk":-6}},
          {"name":"In-Line","skew":{"blk":7,"hnd":-2,"spd":-4}},
          {"name":"Move TE","skew":{"hnd":4,"rte":3,"blk":-3}}],
    "OL":[{"name":"Pass Protector","skew":{"pbk":6,"rbk":-3}},
          {"name":"Road Grader","skew":{"rbk":6,"str":3,"pbk":-4}},
          {"name":"Technician","skew":{"iq":5,"pbk":2,"rbk":1,"str":-4}}],
    "DL":[{"name":"Edge Rusher","skew":{"prs":8,"rst":-4}},
          {"name":"Run Stopper","skew":{"rst":7,"str":3,"prs":-5}},
          {"name":"Hybrid","skew":{"prs":2,"rst":2}}],
    "LB":[{"name":"Run Stopper","skew":{"tkl":6,"cov":-4}},
          {"name":"Coverage","skew":{"cov":7,"tkl":-3}},
          {"name":"Hybrid","skew":{"tkl":2,"cov":2,"spd":2}}],
    "CB":[{"name":"Ball Hawk","skew":{"bhk":8,"tkl":-4}},
          {"name":"Coverage","skew":{"cov":6,"bhk":-2}},
          {"name":"Hybrid","skew":{"tkl":4,"cov":2,"spd":-2}}],
    "S":[{"name":"Ball Hawk","skew":{"bhk":8,"tkl":-3}},
         {"name":"Run Stopper","skew":{"tkl":7,"cov":-4}},
         {"name":"Coverage","skew":{"cov":6,"iq":2,"tkl":-3}}],
    "K":[{"name":"Big Leg","skew":{"pwr":8,"acc":-3}},
         {"name":"Precision","skew":{"acc":7,"pwr":-4}},
         {"name":"Clutch","skew":{"clu":8,"con":-2}}],
    "P":[{"name":"Big Leg","skew":{"pwr":8,"acc":-3}},
         {"name":"Precision","skew":{"acc":7,"pwr":-4}},
         {"name":"Directional","skew":{"con":6,"pwr":-2}}]
  }'::jsonb;
$$;

create or replace function public.franchise_pool_traits()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '[
    {"id":"ice_veins","name":"Ice Veins","desc":"+4 late-game passing performance","pos":["QB"],"effect":{"late_game_passing":4}},
    {"id":"quick_release","name":"Quick Release","desc":"Harder to bring down under pressure","pos":["QB"],"effect":{"pressure_resist":3}},
    {"id":"workhorse","name":"Workhorse","desc":"Holds up under a heavy workload","pos":["RB"],"effect":{"fatigue_resist":4}},
    {"id":"home_run","name":"Home Run Threat","desc":"Breakaway speed in the open field","pos":["RB","WR"],"effect":{"breakaway":3}},
    {"id":"sure_hands","name":"Sure Hands","desc":"Fewer drops in traffic","pos":["WR","TE","RB"],"effect":{"drop_resist":4}},
    {"id":"red_zone","name":"Red Zone Target","desc":"+3 inside the 20","pos":["WR","TE"],"effect":{"red_zone":3}},
    {"id":"anchor","name":"Anchor","desc":"Holds up against the bull rush","pos":["OL"],"effect":{"pass_block_anchor":3}},
    {"id":"road_grader","name":"Road Grader","desc":"+3 run blocking on power plays","pos":["OL"],"effect":{"run_block_power":3}},
    {"id":"motor","name":"Motor","desc":"Relentless late in games","pos":["DL","LB"],"effect":{"late_game_pressure":3}},
    {"id":"bend_the_edge","name":"Bend the Edge","desc":"+3 pass rush off the edge","pos":["DL"],"effect":{"edge_rush":3}},
    {"id":"thumper","name":"Thumper","desc":"+3 run stopping between the tackles","pos":["LB","S"],"effect":{"run_stop":3}},
    {"id":"ball_hawk","name":"Ball Hawk","desc":"More takeaways on tipped balls","pos":["CB","S"],"effect":{"interception":3}},
    {"id":"shutdown","name":"Shutdown","desc":"Sticky in man coverage","pos":["CB"],"effect":{"man_coverage":3}},
    {"id":"clutch_leg","name":"Clutch Leg","desc":"+4 on kicks that decide a game","pos":["K"],"effect":{"clutch_kick":4}},
    {"id":"coffin_corner","name":"Coffin Corner","desc":"Pins punts inside the 10","pos":["P"],"effect":{"punt_placement":3}},
    {"id":"leader","name":"Leader","desc":"+2 chemistry to the position group","pos":["QB","OL","LB","S","WR","DL"],"effect":{"chemistry":2}},
    {"id":"iron_man","name":"Iron Man","desc":"Rarely misses time","pos":["QB","RB","WR","TE","OL","DL","LB","CB","S"],"effect":{"injury_resist":3}},
    {"id":"film_junkie","name":"Film Junkie","desc":"Prepares better every week","pos":["QB","LB","S","CB","OL"],"effect":{"preparation":2}}
  ]'::jsonb;
$$;

-- THE GENERATOR.
--
-- The roster plan: 38 players. Per position, the target overall of each
-- depth slot (starters first), the four visible attributes, the jersey
-- range, and how many start. Targets are tuned so a founding team lands at
-- roughly 68–72 overall — playable, and clearly improvable.
--
-- Each player: target ± 3, an archetype whose skew moves the four attributes
-- apart, ± 2 noise per attribute, and the overall is the rounded mean of the
-- four — so a card is always consistent with its own numbers. Age leans
-- young; potential grows with youth and a development tier; rarity is read
-- off overall and potential. Starters carry a trait more often than backups.
create or replace function public.franchise_generate_roster(p_franchise uuid, p_seed text, p_season integer)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  first_names text[] := public.franchise_pool_first_names();
  last_names text[] := public.franchise_pool_last_names();
  plan jsonb := public.franchise_pool_plan();
  archetypes jsonb := public.franchise_pool_archetypes();
  trait_pool jsonb := public.franchise_pool_traits();
  p jsonb; a jsonb; arch jsonb; eligible jsonb; tr jsonb;
  used_names text[] := '{}'; used_nums integer[] := '{}';
  pos text; d integer; nstart integer; target integer; ovr integer; attrs jsonb; k text; v integer;
  fn text; ln text; tries integer; num integer; lo integer; hi integer;
  age integer; tier text; r double precision; bump integer; pot integer; rarity text; youth double precision;
  made integer := 0;
begin
  if p_franchise is null then raise exception 'no franchise' using errcode = '22023'; end if;
  perform setseed(public.franchise_seed_float(p_seed));

  for p in select * from jsonb_array_elements(plan) loop
    pos := p->>'pos';
    nstart := (p->>'starters')::int;
    lo := (p->'nums'->>0)::int; hi := (p->'nums'->>1)::int;
    for d in 1..jsonb_array_length(p->'targets') loop
      target := (p->'targets'->>(d - 1))::int + floor(random() * 7)::int - 3;

      -- archetype and the four attributes it shapes
      a := archetypes->pos;
      arch := a->(floor(random() * jsonb_array_length(a))::int);
      attrs := '{}'::jsonb;
      for k in select jsonb_array_elements_text(p->'attrs') loop
        v := target + coalesce((arch->'skew'->>k)::int, 0) + floor(random() * 5)::int - 2;
        attrs := attrs || jsonb_build_object(k, greatest(40, least(99, v)));
      end loop;
      select round(avg(x.value::int))::int into ovr from jsonb_each_text(attrs) x;

      -- AGES SPREAD EVENLY across the range, not skewed young (career_v1).
      -- the old curve leaned so hard toward 21 that twenty-seven of
      -- thirty-eight founding players retired inside seasons 8 to 14 and
      -- barely anybody before, which is the cliff a sixty-season measurement
      -- falls off. Flat means about three men go every season, from the
      -- first, and the roster is always part-way through renewing itself.
      age := (public.franchise_career()->>'found_age_min')::int
           + floor(random() * ((public.franchise_career()->>'found_age_max')::int
                             - (public.franchise_career()->>'found_age_min')::int + 1))::int;
      r := random();
      tier := case when r < 0.03 then 'superstar' when r < 0.15 then 'star'
                   when r < 0.40 then 'quick' else 'normal' end;
      bump := case tier when 'superstar' then 18 + floor(random() * 9)::int
                        when 'star'      then 12 + floor(random() * 9)::int
                        when 'quick'     then 6 + floor(random() * 9)::int
                        else 2 + floor(random() * 7)::int end;
      youth := (33 - age) / 12.0;
      pot := least(99, greatest(ovr, ovr + round(bump * youth)::int));
      rarity := case when ovr >= 82 or pot >= 90 then 'elite'
                     when ovr >= 75 or pot >= 84 then 'rare'
                     when ovr >= 68 or pot >= 77 then 'uncommon'
                     else 'common' end;

      -- a trait, more often for a starter
      tr := null;
      if random() < (case when d <= nstart then 0.55 else 0.20 end) then
        select jsonb_agg(x) into eligible from jsonb_array_elements(trait_pool) x where x->'pos' ? pos;
        if eligible is not null and jsonb_array_length(eligible) > 0 then
          tr := eligible->(floor(random() * jsonb_array_length(eligible))::int);
          tr := tr - 'pos';
        end if;
      end if;

      -- a name nobody else on this roster has
      tries := 0;
      loop
        fn := first_names[1 + floor(random() * array_length(first_names, 1))::int];
        ln := last_names[1 + floor(random() * array_length(last_names, 1))::int];
        exit when not ((fn || ' ' || ln) = any (used_names)) or tries > 20;
        tries := tries + 1;
      end loop;
      used_names := used_names || (fn || ' ' || ln);

      -- a jersey in the position's range, unique on the roster
      tries := 0;
      loop
        num := lo + floor(random() * (hi - lo + 1))::int;
        exit when not (num = any (used_nums)) or tries > 40;
        tries := tries + 1;
      end loop;
      used_nums := used_nums || num;

      insert into public.game_players
        (franchise_id, first_name, last_name, position, jersey, age, overall, archetype,
         dev_tier, potential, stamina, chemistry, rarity, ratings, traits, depth, status,
         acquired_source, acquired_season, acquired_detail)
      values
        (p_franchise, fn, ln, pos, num, age, ovr, arch->>'name',
         tier, pot, 70 + floor(random() * 26)::int, 50, rarity, attrs,
         case when tr is null then '[]'::jsonb else jsonb_build_array(tr) end, d, 'active',
         'founding_roster', p_season, 'Founder roster');
      made := made + 1;
    end loop;
  end loop;
  return made;
end;
$$;

-- The average overall of a position's top-N by depth.
create or replace function public.franchise_pos_avg(p_franchise uuid, p_pos text, p_n integer)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(avg(overall), 50)
  from (select overall from public.game_players
         where franchise_id = p_franchise and position = p_pos
           and public.franchise_is_available(status, injured_until)
         order by depth, overall desc limit greatest(1, p_n)) s;
$$;

-- TEAM OVERALL, and the three dimensions under it. Weighted averages of the
-- starters, with the weights stated once here and mirrored in
-- games/lib/franchise.js for display only.
--
--   offense  = .30 QB + .12 RB + .22 WR(3) + .08 TE + .28 OL(5)
--   defense  = .30 DL(4) + .22 LB(3) + .28 CB(2) + .20 S(2)
--   special  = .50 K + .50 P
--   overall  = .45 offense + .45 defense + .10 special
create or replace function public.franchise_team_rating(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  qb numeric; rb numeric; wr numeric; te numeric; ol numeric;
  dl numeric; lb numeric; cb numeric; s numeric; k numeric; p numeric;
  off numeric; def numeric; st numeric;
begin
  qb := public.franchise_pos_avg(p_franchise, 'QB', 1);
  rb := public.franchise_pos_avg(p_franchise, 'RB', 1);
  wr := public.franchise_pos_avg(p_franchise, 'WR', 3);
  te := public.franchise_pos_avg(p_franchise, 'TE', 1);
  ol := public.franchise_pos_avg(p_franchise, 'OL', 5);
  dl := public.franchise_pos_avg(p_franchise, 'DL', 4);
  lb := public.franchise_pos_avg(p_franchise, 'LB', 3);
  cb := public.franchise_pos_avg(p_franchise, 'CB', 2);
  s  := public.franchise_pos_avg(p_franchise, 'S', 2);
  k  := public.franchise_pos_avg(p_franchise, 'K', 1);
  p  := public.franchise_pos_avg(p_franchise, 'P', 1);
  off := 0.30 * qb + 0.12 * rb + 0.22 * wr + 0.08 * te + 0.28 * ol;
  def := 0.30 * dl + 0.22 * lb + 0.28 * cb + 0.20 * s;
  st  := 0.50 * k + 0.50 * p;
  return jsonb_build_object(
    'overall', round(0.45 * off + 0.45 * def + 0.10 * st)::int,
    'offense', round(off)::int, 'defense', round(def)::int, 'special', round(st)::int,
    'groups', jsonb_build_object(
      'QB', round(qb)::int, 'RB', round(rb)::int, 'WR', round(wr)::int, 'TE', round(te)::int, 'OL', round(ol)::int,
      'DL', round(dl)::int, 'LB', round(lb)::int, 'CB', round(cb)::int, 'S', round(s)::int,
      'K', round(k)::int, 'P', round(p)::int),
    'weights', jsonb_build_object(
      'offense', jsonb_build_object('QB', 0.30, 'RB', 0.12, 'WR', 0.22, 'TE', 0.08, 'OL', 0.28),
      'defense', jsonb_build_object('DL', 0.30, 'LB', 0.22, 'CB', 0.28, 'S', 0.20),
      'special', jsonb_build_object('K', 0.50, 'P', 0.50),
      'overall', jsonb_build_object('offense', 0.45, 'defense', 0.45, 'special', 0.10)));
end;
$$;

commit;

-- ===========================================================================
-- THE PUBLIC FUNCTIONS
--
-- Every one re-derives WHO IS CALLING from auth.uid(); none accepts a user or
-- a franchise id as proof of anything. search_path is pinned throughout.
-- ===========================================================================

begin;

-- The caller's ACCOUNT franchise, or null. Used where an account is the
-- only identity that counts (claiming, the direct-read policies).
create or replace function public.franchise_mine()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select f.id from public.franchises f where auth.uid() is not null and f.user_id = auth.uid();
$$;

-- WHO IS CALLING, resolved to a franchise. A signed-in caller is their
-- account's franchise and nothing else; a caller with no session is the
-- franchise whose anon_hash matches the secret they present. A guessed
-- secret matches nothing. This is the same rule h2h_slot_of applies.
create or replace function public.franchise_of(p_secret text default null)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select f.id from public.franchises f
  where (auth.uid() is not null and f.user_id = auth.uid())
     or (auth.uid() is null and p_secret is not null and f.anon_hash is not null
         and f.anon_hash = public.games_hash(p_secret))
  order by (f.user_id is not null) desc
  limit 1;
$$;

-- The cached totals and the level, as one object every mutation returns.
create or replace function public.franchise_totals(p_franchise uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'xp', f.xp, 'level', public.games_level_for(f.xp),
    'next_level_at', case when public.games_level_for(f.xp) >= 30 then null
                          else public.games_xp_for_level(public.games_level_for(f.xp) + 1) end,
    'level_at', public.games_xp_for_level(public.games_level_for(f.xp)),
    'scouting_points', f.scouting_points, 'team_credits', f.team_credits, 'coach_points', f.coach_points)
  from public.franchises f where f.id = p_franchise;
$$;

-- A franchise identity string, cleaned: trimmed, whitespace collapsed, angle
-- brackets removed, cut to the column's limit.
create or replace function public.franchise_clean(p_text text, p_max integer)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select left(regexp_replace(regexp_replace(btrim(coalesce(p_text, '')), '[<>]', '', 'g'), '\s+', ' ', 'g'), p_max);
$$;

-- CREATE. One franchise per account, with its founder season, its roster and
-- its founding grant, in one statement — a franchise can never exist half
-- built. Returns the home read model.
create or replace function public.franchise_create(
  p_name text, p_city text, p_abbr text, p_logo text, p_theme text, p_offense text, p_defense text,
  p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_season integer := public.games_season_of(now()); v_seed text;
  v_name text := public.franchise_clean(p_name, 28);
  v_city text := public.franchise_clean(p_city, 24);
  v_abbr text := upper(regexp_replace(coalesce(p_abbr, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hash text := case when auth.uid() is null then public.games_hash(p_secret) end;
  n integer;
begin
  if auth.uid() is null and v_hash is null then
    raise exception 'a franchise is owned by an account or by a device secret' using errcode = '28000';
  end if;
  if auth.uid() is not null and exists (select 1 from public.franchises where user_id = auth.uid()) then
    raise exception 'you already own a franchise' using errcode = '23505';
  end if;
  if v_hash is not null and exists (select 1 from public.franchises where anon_hash = v_hash) then
    raise exception 'this device already owns a franchise' using errcode = '23505';
  end if;
  if char_length(v_name) < 2 then raise exception 'a franchise needs a name' using errcode = '22023'; end if;
  if char_length(v_city) < 2 then raise exception 'a franchise needs a city' using errcode = '22023'; end if;
  if v_abbr !~ '^[A-Z0-9]{2,4}$' then raise exception 'an abbreviation is 2 to 4 letters or digits' using errcode = '22023'; end if;

  v_seed := md5(gen_random_uuid()::text || coalesce(auth.uid()::text, v_hash) || clock_timestamp()::text);

  insert into public.franchises (user_id, anon_hash, name, city, abbr, logo, theme, offense, defense, founded_season, seed)
  values (auth.uid(), v_hash, v_name, v_city, v_abbr, p_logo, p_theme, p_offense, p_defense, v_season, v_seed)
  returning id into v_id;

  insert into public.franchise_seasons (franchise_id, number, label, season, status)
  values (v_id, 1, 'Season ' || public.games_roman(1), v_season, 'preseason');

  n := public.franchise_generate_roster(v_id, v_seed, v_season);
  if n < 30 then raise exception 'roster generation produced % players', n using errcode = 'P0001'; end if;
  -- the first draft class and the first free agents, so Scouting Points
  -- have somewhere to go from the first day (franchise_open_market, below)
  perform public.franchise_open_market(v_id, 1);

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_id, 'founded', v_season::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('season', v_season, 'players', n));
  perform public.franchise_credit(v_id, 'tc', (public.franchise_economy()->'founded'->>'tc')::int,
    'founded', v_season::text, 'Founding grant');
  perform public.franchise_award(v_id, 'founder_' || v_season::text, v_season);

  -- a team, and a schedule: Season I opens at once, so the HQ can answer
  -- "who am I playing?" from the first second (franchise_open_season, below)
  perform public.franchise_open_season(v_id, 1, now());

  return public.franchise_home(p_secret);
end;
$$;

-- CLAIM a device-owned franchise into the signed-in account. Proof is
-- possession of the secret, nothing else — the same rule as h2h_claim. An
-- account that already owns a franchise keeps it; the device's stays where
-- it is and the answer says so.
create or replace function public.franchise_claim(p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hash text := public.games_hash(p_secret); v_id uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '28000'; end if;
  if v_hash is null then raise exception 'a device secret is required to claim a franchise' using errcode = '22023'; end if;
  if exists (select 1 from public.franchises where user_id = auth.uid()) then
    return jsonb_build_object('claimed', false, 'reason', 'account_has_franchise', 'home', public.franchise_home());
  end if;
  select id into v_id from public.franchises where anon_hash = v_hash;
  if v_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'no_device_franchise', 'home', null);
  end if;
  update public.franchises set user_id = auth.uid(), anon_hash = null, claimed_hash = coalesce(claimed_hash, anon_hash), updated_at = now() where id = v_id;
  return jsonb_build_object('claimed', true, 'reason', null, 'home', public.franchise_home());
end;
$$;

-- The Price It write, shared by the live path and the import. The score is
-- computed from the BOARD; the caller's only inputs are which game and what
-- line. `p_verified` is false only for an imported row whose game had kicked
-- off before the import — history the server could not check.
create or replace function public.franchise_apply_price_it(
  p_franchise uuid, p_game_id text, p_user_spread numeric, p_verified boolean, p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.game_board%rowtype;
  v_user numeric := round(coalesce(p_user_spread, 0) * 2) / 2.0;
  v_dist numeric; v_dmkt numeric; v_score integer; v_sp integer; v_tc integer;
  v_detail jsonb; v_existing jsonb; v_new text[] := '{}'; v_season integer;
  v_at timestamptz := coalesce(p_at, now());
begin
  select * into b from public.game_board where game_id = p_game_id;
  if not found or b.edgedesk_spread is null then
    raise exception 'that game is not on the board' using errcode = 'P0002';
  end if;
  if v_user < -60 or v_user > 60 then
    raise exception 'a line is between -60 and 60' using errcode = '22023';
  end if;
  select detail into v_existing from public.franchise_activity
   where franchise_id = p_franchise and kind = 'price_it' and key = p_game_id;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'already', true, 'result', v_existing,
      'rewards', jsonb_build_object('xp', 0, 'sp', 0, 'tc', 0), 'achievements', '[]'::jsonb,
      'totals', public.franchise_totals(p_franchise));
  end if;

  v_dist := round(abs(v_user - b.edgedesk_spread), 1);
  v_dmkt := case when b.market_spread is null then null else round(abs(v_user - b.market_spread), 1) end;
  v_score := public.games_price_it_score(v_dist);
  v_detail := jsonb_build_object(
    'game_id', b.game_id, 'slug', b.slug, 'home_team', b.home_team, 'away_team', b.away_team,
    'user_spread', v_user, 'edgedesk_spread', b.edgedesk_spread, 'market_spread', b.market_spread,
    'distance', v_dist, 'distance_to_market', v_dmkt, 'score', v_score,
    'benchmark', 'edgedesk', 'scoring_version', 'price_it_v1', 'verified', p_verified, 'at', v_at);

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, verified, detail, created_at)
  values (p_franchise, 'price_it', p_game_id, public.games_week_key(v_at), public.games_day_key(v_at), p_verified, v_detail, v_at);

  if p_verified then
    v_sp := public.franchise_sp_for_score(v_score);
    v_tc := public.franchise_tc_for_score(v_score);
    perform public.franchise_credit(p_franchise, 'xp', (public.franchise_economy()->'price_it'->>'xp')::int,
      'price_it', p_game_id, 'Priced ' || coalesce(b.away_team, '?') || ' vs ' || coalesce(b.home_team, '?'));
    perform public.franchise_credit(p_franchise, 'sp', v_sp, 'price_it', p_game_id, 'Scouting: score ' || v_score);
    perform public.franchise_credit(p_franchise, 'tc', v_tc, 'price_it', p_game_id, 'Priced ' || coalesce(b.away_team, '?') || ' vs ' || coalesce(b.home_team, '?'));
  else
    v_sp := 0; v_tc := 0;
    perform public.franchise_credit(p_franchise, 'xp', (public.franchise_economy()->'import_unverified_price_it'->>'xp')::int,
      'price_it', p_game_id, 'Priced ' || coalesce(b.away_team, '?') || ' vs ' || coalesce(b.home_team, '?') || ' (history)');
  end if;

  v_season := coalesce(b.season, public.games_season_of(v_at));
  if public.franchise_award(p_franchise, 'first_price', v_season, jsonb_build_object('game_id', b.game_id)) then v_new := array_append(v_new, 'first_price'); end if;
  if p_verified and v_score = 100 and public.franchise_award(p_franchise, 'market_master', v_season, jsonb_build_object('game_id', b.game_id)) then v_new := array_append(v_new, 'market_master'); end if;

  return jsonb_build_object('ok', true, 'already', false, 'result', v_detail,
    'rewards', jsonb_build_object('xp', case when p_verified then (public.franchise_economy()->'price_it'->>'xp')::int
                                             else (public.franchise_economy()->'import_unverified_price_it'->>'xp')::int end,
                                  'sp', v_sp, 'tc', v_tc),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(p_franchise));
end;
$$;

-- PRICE IT, live. The game must still be ahead: a line set after kickoff is
-- not a read of the game.
create or replace function public.franchise_record_price_it(p_game_id text, p_user_spread numeric, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_kick timestamptz;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select kickoff into v_kick from public.game_board where game_id = p_game_id;
  if not found then raise exception 'that game is not on the board' using errcode = 'P0002'; end if;
  if exists (select 1 from public.franchise_activity where franchise_id = v_f and kind = 'price_it' and key = p_game_id) then
    return public.franchise_apply_price_it(v_f, p_game_id, p_user_spread, true, now());
  end if;
  if v_kick is not null and v_kick <= now() then
    raise exception 'that game has kicked off' using errcode = '22023';
  end if;
  return public.franchise_apply_price_it(v_f, p_game_id, p_user_spread, true, now());
end;
$$;

-- PICK 5. This week's card, one per franchise, the board's line snapshotted
-- onto every selection. Settled later by the service role.
create or replace function public.franchise_submit_pick5(p_week_key text, p_selections jsonb, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); v_week text := public.games_week_key(now());
  v_card uuid; sel jsonb; b public.game_board%rowtype; n integer; v_ids text[] := '{}';
  v_new text[] := '{}'; v_rows jsonb;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  if p_week_key is distinct from v_week then
    raise exception 'that card is not for this football week' using errcode = '22023';
  end if;
  select id into v_card from public.franchise_pick5_cards where franchise_id = v_f and week_key = v_week;
  if found then
    return jsonb_build_object('ok', true, 'already', true, 'card', public.franchise_pick5_card(v_card),
      'rewards', jsonb_build_object('xp', 0, 'tc', 0), 'achievements', '[]'::jsonb,
      'totals', public.franchise_totals(v_f));
  end if;
  if p_selections is null or jsonb_typeof(p_selections) <> 'array'
     or jsonb_array_length(p_selections) < 1 or jsonb_array_length(p_selections) > 5 then
    raise exception 'a card is one to five selections' using errcode = '22023';
  end if;

  insert into public.franchise_pick5_cards (franchise_id, week_key) values (v_f, v_week) returning id into v_card;

  for sel in select * from jsonb_array_elements(p_selections) loop
    if (sel->>'game_id') is null or (sel->>'pick') not in ('home', 'away') then
      raise exception 'each selection names a game and a side' using errcode = '22023';
    end if;
    if (sel->>'game_id') = any (v_ids) then
      raise exception 'a game appears once on a card' using errcode = '22023';
    end if;
    select * into b from public.game_board where game_id = sel->>'game_id';
    if not found or b.market_spread is null then
      raise exception 'game % carries no line to pick against', sel->>'game_id' using errcode = 'P0002';
    end if;
    if b.kickoff is not null and b.kickoff <= now() then
      raise exception 'game % has kicked off', sel->>'game_id' using errcode = '22023';
    end if;
    insert into public.franchise_pick5_selections (card_id, game_id, pick, market_spread)
    values (v_card, b.game_id, sel->>'pick', b.market_spread);
    v_ids := v_ids || b.game_id;
  end loop;

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'pick5_card', v_week, v_week, public.games_day_key(now()), jsonb_build_object('games', to_jsonb(v_ids)));
  perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'pick5_card'->>'xp')::int, 'pick5_card', v_week, 'Pick 5 card, week of ' || v_week);
  perform public.franchise_credit(v_f, 'tc', (public.franchise_economy()->'pick5_card'->>'tc')::int, 'pick5_card', v_week, 'Pick 5 card, week of ' || v_week);
  if public.franchise_award(v_f, 'first_card', public.games_season_of(now()), jsonb_build_object('week', v_week)) then v_new := array_append(v_new, 'first_card'); end if;

  return jsonb_build_object('ok', true, 'already', false, 'card', public.franchise_pick5_card(v_card),
    'rewards', jsonb_build_object('xp', (public.franchise_economy()->'pick5_card'->>'xp')::int,
                                  'tc', (public.franchise_economy()->'pick5_card'->>'tc')::int),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- One card, with its selections, as the page renders it.
create or replace function public.franchise_pick5_card(p_card uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', c.id, 'week_key', c.week_key, 'imported', c.imported, 'submitted_at', c.submitted_at,
    'settled_at', c.settled_at, 'correct', c.correct, 'decided', c.decided,
    'selections', coalesce((select jsonb_agg(jsonb_build_object(
        'game_id', s.game_id, 'pick', s.pick, 'market_spread', s.market_spread,
        'result', s.result, 'settled_at', s.settled_at,
        'home_team', b.home_team, 'away_team', b.away_team, 'slug', b.slug,
        'final_home', b.final_home, 'final_away', b.final_away) order by b.kickoff, s.game_id)
      from public.franchise_pick5_selections s left join public.game_board b on b.game_id = s.game_id
      where s.card_id = c.id), '[]'::jsonb))
  from public.franchise_pick5_cards c where c.id = p_card;
$$;

-- THE TWO-MINUTE DRILL. Client-reported, by design and said so: the drill is
-- built and scored in the browser from the same artifact. The server enforces
-- one daily run per day, the day being today or yesterday in the week's zone,
-- and sizes the reward; it cannot check the answers.
create or replace function public.franchise_record_drill(
  p_day_key text, p_rounds integer, p_correct integer, p_total integer, p_seed text default null, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); v_today text := public.games_day_key(now());
  v_yday text := public.games_day_key(now() - interval '1 day'); v_tc integer; v_existing jsonb;
  v_detail jsonb;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  if p_day_key is null or p_day_key not in (v_today, v_yday) then
    raise exception 'a drill is recorded on the day it was run' using errcode = '22023';
  end if;
  if p_rounds is null or p_rounds < 1 or p_rounds > 10 or p_correct is null or p_correct < 0 or p_correct > p_rounds
     or p_total is null or p_total < 0 or p_total > 2000 then
    raise exception 'that is not a drill result' using errcode = '22023';
  end if;
  select detail into v_existing from public.franchise_activity
   where franchise_id = v_f and kind = 'drill_daily' and key = p_day_key;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'already', true, 'result', v_existing,
      'rewards', jsonb_build_object('xp', 0, 'tc', 0), 'totals', public.franchise_totals(v_f));
  end if;
  v_tc := least((public.franchise_economy()->'drill_daily'->>'tc_max')::int,
                p_correct * (public.franchise_economy()->'drill_daily'->>'tc_per_correct')::int);
  v_detail := jsonb_build_object('day', p_day_key, 'rounds', p_rounds, 'correct', p_correct, 'total', p_total,
    'seed', p_seed, 'verified', false);
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, verified, detail)
  values (v_f, 'drill_daily', p_day_key, public.games_week_key(now()), p_day_key, false, v_detail);
  perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'drill_daily'->>'xp')::int, 'drill_daily', p_day_key, 'Two-Minute Drill, ' || p_day_key);
  perform public.franchise_credit(v_f, 'tc', v_tc, 'drill_daily', p_day_key, 'Two-Minute Drill, ' || p_correct || ' of ' || p_rounds);
  return jsonb_build_object('ok', true, 'already', false, 'result', v_detail,
    'rewards', jsonb_build_object('xp', (public.franchise_economy()->'drill_daily'->>'xp')::int, 'tc', v_tc),
    'totals', public.franchise_totals(v_f));
end;
$$;

-- A RESEARCH OPEN. The game must be on the board; one row per game; XP for at
-- most ten games a football week, the same cap the War Room applies.
create or replace function public.franchise_record_research(p_game_id text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); v_week text := public.games_week_key(now()); n integer; v_xp integer := 0;
  b public.game_board%rowtype;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select * into b from public.game_board where game_id = p_game_id;
  if not found then raise exception 'that game is not on the board' using errcode = 'P0002'; end if;
  if exists (select 1 from public.franchise_activity where franchise_id = v_f and kind = 'research_open' and key = p_game_id) then
    return jsonb_build_object('ok', true, 'already', true, 'rewards', jsonb_build_object('xp', 0), 'totals', public.franchise_totals(v_f));
  end if;
  select count(*) into n from public.franchise_activity
   where franchise_id = v_f and kind = 'research_open' and week_key = v_week;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'research_open', p_game_id, v_week, public.games_day_key(now()),
          jsonb_build_object('game_id', b.game_id, 'slug', b.slug, 'home_team', b.home_team, 'away_team', b.away_team,
                             'capped', n >= (public.franchise_economy()->'research_open'->>'cap_per_week')::int));
  if n < (public.franchise_economy()->'research_open'->>'cap_per_week')::int then
    v_xp := (public.franchise_economy()->'research_open'->>'xp')::int;
    perform public.franchise_credit(v_f, 'xp', v_xp, 'research_open', p_game_id,
      'Reviewed ' || coalesce(b.away_team, '?') || ' vs ' || coalesce(b.home_team, '?'));
  end if;
  return jsonb_build_object('ok', true, 'already', false, 'capped', v_xp = 0,
    'rewards', jsonb_build_object('xp', v_xp), 'totals', public.franchise_totals(v_f));
end;
$$;

-- A jsonb value as an array, or an empty array when it is anything else —
-- so a malformed history payload imports nothing rather than raising.
create or replace function public.games_jsonb_array(p_value jsonb)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when p_value is not null and jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end;
$$;

-- IMPORT the anonymous history a browser kept before the franchise existed.
--
-- The rule: credit fully only what the server can check. A Price It on a
-- game that has not kicked off is scored exactly as a live one. A Price It
-- on a game already played earns XP only — the browser's timestamp is not
-- evidence of when the line was set. A card for a past week is kept as
-- history with XP for the card and nothing for its results. Drill days are
-- accepted under the drill's own stated trust boundary. Research opens carry
-- over up to the weekly cap. Everything is idempotent by key, so importing
-- twice is importing once.
create or replace function public.franchise_import_history(p_history jsonb, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); v_week text := public.games_week_key(now());
  row_ jsonb; sel jsonb; b public.game_board%rowtype; r jsonb;
  pi_credited integer := 0; pi_xp_only integer := 0; pi_skipped integer := 0;
  c_live integer := 0; c_history integer := 0; c_skipped integer := 0;
  d_credited integer := 0; d_skipped integer := 0; r_credited integer := 0; r_skipped integer := 0;
  v_card uuid; v_ok boolean; v_ids text[]; n integer := 0; v_wk text; v_day text; v_at timestamptz;
  v_live_sel jsonb;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  if p_history is null or jsonb_typeof(p_history) <> 'object' then
    return jsonb_build_object('ok', true, 'imported', false, 'totals', public.franchise_totals(v_f));
  end if;

  -- Price It: at most 200 rows
  n := 0;
  for row_ in select * from jsonb_array_elements(public.games_jsonb_array(p_history->'price_it')) loop
    n := n + 1; exit when n > 200;
    begin
      select * into b from public.game_board where game_id = row_->>'game_id';
      if not found or b.edgedesk_spread is null or (row_->>'user_spread') is null then
        pi_skipped := pi_skipped + 1; continue;
      end if;
      v_at := coalesce(nullif(row_->>'at', '')::timestamptz, now());
      if b.kickoff is null or b.kickoff > now() then
        r := public.franchise_apply_price_it(v_f, b.game_id, (row_->>'user_spread')::numeric, true, least(v_at, now()));
        if (r->>'already')::boolean then pi_skipped := pi_skipped + 1; else pi_credited := pi_credited + 1; end if;
      else
        r := public.franchise_apply_price_it(v_f, b.game_id, (row_->>'user_spread')::numeric, false, least(v_at, now()));
        if (r->>'already')::boolean then pi_skipped := pi_skipped + 1; else pi_xp_only := pi_xp_only + 1; end if;
      end if;
    exception when others then
      pi_skipped := pi_skipped + 1;
    end;
  end loop;

  -- Pick 5 cards: at most 30
  n := 0;
  for row_ in select * from jsonb_array_elements(public.games_jsonb_array(p_history->'pick5')) loop
    n := n + 1; exit when n > 30;
    v_wk := row_->>'week';
    if v_wk is null or v_wk !~ '^\d{4}-\d{2}-\d{2}$' or jsonb_typeof(row_->'selections') <> 'array'
       or jsonb_array_length(row_->'selections') < 1 or jsonb_array_length(row_->'selections') > 5 then
      c_skipped := c_skipped + 1; continue;
    end if;
    if exists (select 1 from public.franchise_pick5_cards where franchise_id = v_f and week_key = v_wk) then
      c_skipped := c_skipped + 1; continue;
    end if;
    if v_wk = v_week then
      -- this week's card goes through the live path when every game is still ahead
      begin
        select jsonb_agg(jsonb_build_object('game_id', x->>'game_id', 'pick', x->>'pick')) into v_live_sel
          from jsonb_array_elements(row_->'selections') x;
        r := public.franchise_submit_pick5(v_week, v_live_sel, p_secret);
        c_live := c_live + 1;
        continue;
      exception when others then
        -- fall through to history
        null;
      end;
    end if;
    if v_wk > v_week then c_skipped := c_skipped + 1; continue; end if;
    -- history: kept, XP for the card, no results
    v_ok := true; v_ids := '{}';
    for sel in select * from jsonb_array_elements(row_->'selections') loop
      if (sel->>'game_id') is null or (sel->>'pick') not in ('home', 'away') or (sel->>'game_id') = any (v_ids) then v_ok := false; end if;
      v_ids := v_ids || (sel->>'game_id');
    end loop;
    if not v_ok then c_skipped := c_skipped + 1; continue; end if;
    v_at := coalesce(nullif(row_->>'submitted_at', '')::timestamptz, now());
    insert into public.franchise_pick5_cards (franchise_id, week_key, imported, submitted_at, settled_at)
    values (v_f, v_wk, true, least(v_at, now()), now()) returning id into v_card;
    for sel in select * from jsonb_array_elements(row_->'selections') loop
      insert into public.franchise_pick5_selections (card_id, game_id, pick, market_spread)
      values (v_card, sel->>'game_id', sel->>'pick', nullif(sel->>'market_spread', '')::numeric)
      on conflict do nothing;
    end loop;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, verified, detail, created_at)
    values (v_f, 'pick5_card', v_wk, v_wk, public.games_day_key(least(v_at, now())), false,
            jsonb_build_object('games', to_jsonb(v_ids), 'imported', true), least(v_at, now()))
    on conflict do nothing;
    perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'import_unverified_pick5'->>'xp')::int,
      'pick5_card', v_wk, 'Pick 5 card, week of ' || v_wk || ' (history)');
    c_history := c_history + 1;
  end loop;

  -- Drill days: at most 60, none in the future
  n := 0;
  for row_ in select * from jsonb_array_elements(public.games_jsonb_array(p_history->'drill')) loop
    n := n + 1; exit when n > 60;
    v_day := row_->>'day';
    if v_day is null or v_day !~ '^\d{4}-\d{2}-\d{2}$' or v_day > public.games_day_key(now())
       or (row_->>'rounds') is null or (row_->>'correct') is null
       or (row_->>'rounds')::int < 1 or (row_->>'rounds')::int > 10
       or (row_->>'correct')::int < 0 or (row_->>'correct')::int > (row_->>'rounds')::int then
      d_skipped := d_skipped + 1; continue;
    end if;
    if exists (select 1 from public.franchise_activity where franchise_id = v_f and kind = 'drill_daily' and key = v_day) then
      d_skipped := d_skipped + 1; continue;
    end if;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, verified, detail)
    values (v_f, 'drill_daily', v_day, public.games_week_key((v_day || 'T12:00:00Z')::timestamptz), v_day, false,
            jsonb_build_object('day', v_day, 'rounds', (row_->>'rounds')::int, 'correct', (row_->>'correct')::int,
                               'total', coalesce((row_->>'total')::int, 0), 'imported', true, 'verified', false));
    perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'drill_daily'->>'xp')::int, 'drill_daily', v_day, 'Two-Minute Drill, ' || v_day);
    perform public.franchise_credit(v_f, 'tc', least((public.franchise_economy()->'drill_daily'->>'tc_max')::int,
      (row_->>'correct')::int * (public.franchise_economy()->'drill_daily'->>'tc_per_correct')::int),
      'drill_daily', v_day, 'Two-Minute Drill, ' || (row_->>'correct') || ' of ' || (row_->>'rounds'));
    d_credited := d_credited + 1;
  end loop;

  -- Research opens: at most 100 rows, XP for at most ten
  n := 0;
  for row_ in select * from jsonb_array_elements(public.games_jsonb_array(p_history->'research')) loop
    n := n + 1; exit when n > 100;
    select * into b from public.game_board where game_id = row_->>'game_id';
    if not found or exists (select 1 from public.franchise_activity where franchise_id = v_f and kind = 'research_open' and key = b.game_id) then
      r_skipped := r_skipped + 1; continue;
    end if;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
    values (v_f, 'research_open', b.game_id, coalesce(public.games_week_key(b.kickoff), v_week), public.games_day_key(now()),
            jsonb_build_object('game_id', b.game_id, 'slug', b.slug, 'home_team', b.home_team, 'away_team', b.away_team, 'imported', true, 'capped', r_credited >= 10));
    if r_credited < (public.franchise_economy()->'research_open'->>'cap_per_week')::int then
      perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'research_open'->>'xp')::int, 'research_open', b.game_id,
        'Reviewed ' || coalesce(b.away_team, '?') || ' vs ' || coalesce(b.home_team, '?'));
      r_credited := r_credited + 1;
    else
      r_skipped := r_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'imported', true,
    'price_it', jsonb_build_object('credited', pi_credited, 'xp_only', pi_xp_only, 'skipped', pi_skipped),
    'pick5', jsonb_build_object('live', c_live, 'history', c_history, 'skipped', c_skipped),
    'drill', jsonb_build_object('credited', d_credited, 'skipped', d_skipped),
    'research', jsonb_build_object('credited', r_credited, 'skipped', r_skipped),
    'totals', public.franchise_totals(v_f));
end;
$$;

-- SET A STARTER. Swap a player into one of their position's starting slots;
-- whoever held it takes the mover's old depth. The roster stays the roster.
create or replace function public.franchise_set_starter(p_player uuid, p_slot integer, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); me public.game_players%rowtype; other public.game_players%rowtype;
  v_starters integer;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select * into me from public.game_players where id = p_player and franchise_id = v_f and status = 'active';
  if not found then raise exception 'that player is not on your roster' using errcode = 'P0002'; end if;
  v_starters := case me.position when 'WR' then 3 when 'OL' then 5 when 'DL' then 4 when 'LB' then 3
                                 when 'CB' then 2 when 'S' then 2 else 1 end;
  if p_slot is null or p_slot < 1 or p_slot > v_starters then
    raise exception 'that position has % starting slot(s)', v_starters using errcode = '22023';
  end if;
  select * into other from public.game_players
   where franchise_id = v_f and position = me.position and status = 'active'
   order by depth, overall desc offset p_slot - 1 limit 1;
  if not found or other.id = me.id then
    return public.franchise_roster(p_secret);
  end if;
  update public.game_players set depth = other.depth, updated_at = now() where id = me.id;
  update public.game_players set depth = me.depth, updated_at = now() where id = other.id;
  return public.franchise_roster(p_secret);
end;
$$;

commit;

-- ===========================================================================
-- THE WEEKLY GAME — sim_v4
--
-- The franchise's own calendar, and the game that gives a week its stakes.
--
-- THE CALENDAR RULE. A franchise season is `weeks` games (eight by default),
-- one per football week, scheduled all at once when the season opens. Week
-- w belongs to the football week w − 1 weeks after the opening one, and its
-- game opens on that week's Saturday at 07:00 UTC — Saturday everywhere in
-- the United States. A game stays playable until it is played, so a week
-- missed is not a game lost; but the preparation a game runs on is the
-- preparation recorded in ITS football week, so a week missed is a game
-- played unprepared. Real football makes the week richer while it is on;
-- the franchise season runs on this clock whether or not there is a slate.
--
-- THE SIMULATOR is a possession model: eleven to fourteen drives a side,
-- each one resolved from the offense's effective rating against the
-- defense's — the team rating, home field (+1.5), that week's preparation
-- (−3 to +3), the published scheme matchup (−2 to +2), and the starters'
-- traits. Overtime is up to two rounds, then a tie. It is seeded from the
-- game's server-derived seed, so the same game simulated twice is the same
-- game; nothing a client sends changes a result, because a client sends
-- nothing but "play".
--
-- Every function here is internal except franchise_start_season,
-- franchise_play_week, franchise_schedule and franchise_game.
-- ===========================================================================

begin;

-- Sum two objects of numbers, key by key. Used for the career and season
-- lines on a player, and for the team totals in a box score.
create or replace function public.games_jsonb_sum(p_a jsonb, p_b jsonb)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce((select jsonb_object_agg(k, v) from (
    select key as k, to_jsonb(sum(val)) as v from (
      select key, case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric else 0 end as val
        from jsonb_each(coalesce(p_a, '{}'::jsonb))
      union all
      select key, case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric else 0 end
        from jsonb_each(coalesce(p_b, '{}'::jsonb))
    ) u group by key) s), '{}'::jsonb);
$$;

-- THE SCHEME MATCHUP, published. Offense against defense, in rating points
-- for the offense: an Air Raid against Press Man loses two, against a
-- Blitz-Heavy front gains two. Mirrored in games/lib/franchise.js for the
-- pregame read; a test holds the two equal.
create or replace function public.franchise_scheme_edges()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select '{
    "air_raid":   {"four_three": 0, "three_four": 0,  "press_man": -2, "zone": 1,  "blitz_heavy": 2,  "bend_dont_break": -1},
    "spread":     {"four_three": 0, "three_four": -1, "press_man": 1,  "zone": 0,  "blitz_heavy": 1,  "bend_dont_break": -1},
    "pro_style":  {"four_three": 0, "three_four": 1,  "press_man": 0,  "zone": 1,  "blitz_heavy": -2, "bend_dont_break": 1},
    "power_run":  {"four_three": 1, "three_four": -2, "press_man": 2,  "zone": 0,  "blitz_heavy": -1, "bend_dont_break": 1},
    "option":     {"four_three": -1, "three_four": 1, "press_man": 1,  "zone": -2, "blitz_heavy": 1,  "bend_dont_break": 0},
    "west_coast": {"four_three": 0, "three_four": 0,  "press_man": -1, "zone": -1, "blitz_heavy": 1,  "bend_dont_break": 1}
  }'::jsonb;
$$;

create or replace function public.franchise_scheme_edge(p_offense text, p_defense text)
returns numeric language sql immutable
set search_path = public, pg_temp as $$
  select coalesce((public.franchise_scheme_edges() -> p_offense ->> p_defense)::numeric, 0);
$$;

-- How much of an offense goes through the air, by scheme.
create or replace function public.franchise_pass_share(p_offense text)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_offense when 'air_raid' then 0.68 when 'spread' then 0.58 when 'pro_style' then 0.50
                        when 'power_run' then 0.40 when 'option' then 0.36 when 'west_coast' then 0.60 else 0.50 end;
$$;

-- How much of the rushing a quarterback carries, by scheme.
create or replace function public.franchise_qb_rush_share(p_offense text)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_offense when 'option' then 0.35 when 'spread' then 0.22 when 'air_raid' then 0.06 else 0.10 end;
$$;

-- PREPARATION, prep_v1 — the server's restatement of EDFranchise.prep. A
-- read of what the franchise did in ONE football week: three scouting
-- reports are full Scouting; the card, practice and film complete
-- Preparation; Market IQ is the average Price It score. Capped at 100 and
-- never a roster rating — it is the one input to Saturday the week decides.
create or replace function public.franchise_prep(p_franchise uuid, p_week_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare priced integer; card boolean; drills integer; research integer; avg_score numeric;
begin
  select count(*) filter (where kind = 'price_it'), count(*) filter (where kind = 'pick5_card') > 0,
         count(*) filter (where kind = 'drill_daily'), count(*) filter (where kind = 'research_open'),
         round(avg((detail->>'score')::numeric) filter (where kind = 'price_it'))
    into priced, card, drills, research, avg_score
    from public.franchise_activity where franchise_id = p_franchise and week_key = p_week_key;
  return jsonb_build_object(
    'version', 'prep_v1', 'week_key', p_week_key,
    'scouting', least(100, round(priced / 3.0 * 100))::int,
    'preparation', least(100, round(40 * least(1, priced / 3.0) + 25 * (case when card then 1 else 0 end)
                                  + 20 * least(1, drills) + 15 * least(1, research / 2.0)))::int,
    'market_iq', case when avg_score is null then null else greatest(0, least(100, avg_score))::int end,
    'counts', jsonb_build_object('price_it', priced, 'pick5_submitted', card, 'drills', drills, 'research', research));
end;
$$;

-- What the starters' traits add up to, in the units the simulator reads.
-- A trait's `effect` is the object the generator wrote; here each kind of
-- effect is summed across the starting lineup.
create or replace function public.franchise_trait_effects(p_franchise uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with st as (
    select p.position, e.key, (e.value)::numeric as v
    from public.game_players p
    cross join lateral jsonb_array_elements(p.traits) t
    cross join lateral jsonb_each_text(t -> 'effect') e
    where p.franchise_id = p_franchise and public.franchise_is_available(p.status, p.injured_until)
      and p.depth <= case p.position when 'WR' then 3 when 'OL' then 5 when 'DL' then 4 when 'LB' then 3
                                     when 'CB' then 2 when 'S' then 2 else 1 end
  )
  select jsonb_build_object(
    'offense', coalesce(sum(v) filter (where key in ('pressure_resist','fatigue_resist','breakaway','drop_resist','red_zone','pass_block_anchor','run_block_power')), 0)
             + coalesce(sum(v) filter (where key = 'chemistry' and position in ('QB','RB','WR','TE','OL')), 0),
    'defense', coalesce(sum(v) filter (where key in ('edge_rush','run_stop','man_coverage','interception')), 0)
             + coalesce(sum(v) filter (where key = 'chemistry' and position in ('DL','LB','CB','S')), 0),
    'special', coalesce(sum(v) filter (where key in ('clutch_kick','punt_placement')), 0),
    'late_offense', coalesce(sum(v) filter (where key = 'late_game_passing'), 0),
    'late_defense', coalesce(sum(v) filter (where key = 'late_game_pressure'), 0),
    'takeaway', coalesce(sum(v) filter (where key = 'interception'), 0),
    'clutch', coalesce(sum(v) filter (where key = 'clutch_kick'), 0),
    'edge_rush', coalesce(sum(v) filter (where key = 'edge_rush'), 0),
    'drop_resist', coalesce(sum(v) filter (where key = 'drop_resist'), 0),
    'preparation', coalesce(sum(v) filter (where key = 'preparation'), 0),
    'count', count(*))
  from st;
$$;

-- The season row as the pages read it.
create or replace function public.franchise_season_json(p_franchise uuid, p_number integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('number', s.number, 'label', s.label, 'season', s.season, 'status', s.status,
      'weeks', s.weeks, 'week', s.week, 'wins', s.wins, 'losses', s.losses, 'ties', s.ties,
      'points_for', s.points_for, 'points_against', s.points_against,
      'created_at', s.created_at, 'completed_at', s.completed_at)
  from public.franchise_seasons s where s.franchise_id = p_franchise and s.number = p_number;
$$;

-- A game as the pages read it. The full box only when asked for.
create or replace function public.franchise_game_json(p_game uuid, p_full boolean default true)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', g.id, 'season_number', g.season_number, 'week', g.week, 'week_key', g.week_key,
      'opens_at', g.opens_at, 'open', g.opens_at <= now(), 'opponent', g.opponent, 'home', g.home, 'rival', g.rival,
      -- the ninth game a winning season earned, and what it is called (Phase 7)
      'bowl', g.bowl, 'bowl_name', g.opponent->>'bowl_name',
      'status', g.status, 'played_at', g.played_at, 'score_for', g.score_for, 'score_against', g.score_against,
      'result', g.result, 'ot', coalesce((g.box->>'ot')::boolean, false), 'potg', g.box->'potg',
      'prep', g.box->'edges'->'prep', 'sim_version', g.sim_version,
      'injuries', coalesce(g.box->'injuries', '[]'::jsonb),
      'box', case when p_full then g.box else null end)
  from public.franchise_games g where g.id = p_game;
$$;

-- SCHEDULE A SEASON. Seven clubs drawn from the pool and the rival to close,
-- their ratings set around the franchise's own team overall at scheduling
-- (from six below to four above, shuffled; the rival two above), home and
-- away alternating from a coin flip. Seeded from the franchise seed and the
-- season number, so the same franchise always draws the same schedule.
create or replace function public.franchise_schedule_season(p_franchise uuid, p_number integer, p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; s public.franchise_seasons%rowtype;
  keys text[]; k text; w integer; i integer; o public.franchise_opponents%rowtype;
  oovr integer; spread integer; home boolean; wk text; opens timestamptz; made integer := 0;
begin
  select * into f from public.franchises where id = p_franchise for update;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise and number = p_number;
  if not found then raise exception 'no such season' using errcode = 'P0002'; end if;
  if exists (select 1 from public.franchise_games where franchise_id = p_franchise and season_number = p_number) then
    return 0;
  end if;
  perform setseed(public.franchise_seed_float(f.seed || ':season:' || p_number));

  -- the rival, once
  if f.rival_key is null then
    select key into k from public.franchise_opponents order by random() limit 1;
    update public.franchises set rival_key = k, updated_at = now() where id = p_franchise;
    f.rival_key := k;
  end if;

  -- THE SLATE, DRAWN AROUND YOUR STANDING (league_v1). Before this phase the
  -- opponents were rated from your own team overall, which meant a better
  -- roster could not win a single extra game. Now the clubs have ratings of
  -- their own and the schedule picks WHICH clubs by where you stand: most of
  -- the slate near you, one well above to measure yourself against, one well
  -- below, and the rival last. Climb and it hardens; fall and it softens.
  select array_agg(q.ck) into keys from (
    select c.key as ck from public.franchise_opponents c
     where c.key <> f.rival_key
     order by abs(public.franchise_league_gap(f.standing, c.strength))
       + case when random() < 0.5 then 2 else 0 end, random()
     limit greatest(1, s.weeks - 3)) q;
  -- one club well above and one well below, so a season is not all one note
  select array_cat(keys, coalesce(array_agg(q.ck), '{}')) into keys from (
    select c.key as ck from public.franchise_opponents c
     where c.key <> f.rival_key and not (c.key = any(coalesce(keys, '{}')))
       and public.franchise_league_gap(f.standing, c.strength) > 6
     order by public.franchise_league_gap(f.standing, c.strength), random() limit 1) q;
  select array_cat(keys, coalesce(array_agg(q.ck), '{}')) into keys from (
    select c.key as ck from public.franchise_opponents c
     where c.key <> f.rival_key and not (c.key = any(coalesce(keys, '{}')))
       and public.franchise_league_gap(f.standing, c.strength) < -6
     order by public.franchise_league_gap(f.standing, c.strength) desc, random() limit 1) q;
  -- anything still short (an extreme standing near the ends of the table) is
  -- filled from whoever is nearest, so a slate is never short a club
  for i in 1..s.weeks loop
    exit when coalesce(array_length(keys, 1), 0) >= s.weeks - 1;
    select array_cat(keys, coalesce(array_agg(q.ck), '{}')) into keys from (
      select c.key as ck from public.franchise_opponents c
       where c.key <> f.rival_key and not (c.key = any(coalesce(keys, '{}')))
       order by abs(public.franchise_league_gap(f.standing, c.strength)), random() limit 1) q;
  end loop;
  home := random() < 0.5;

  for w in 1..s.weeks loop
    if w = s.weeks then k := f.rival_key; else k := keys[w]; end if;
    select * into o from public.franchise_opponents where key = k;
    -- THE CLUB'S OWN RATING, not yours. A seeded point either way so the same
    -- club is not the same game twice, and nothing here reads team overall.
    oovr := greatest(45, least(95, o.strength + floor(random() * 3)::int - 1));
    spread := floor(random() * 9)::int - 4;
    wk := public.games_week_key(p_now + ((w - 1) * interval '7 days'));
    opens := ((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC';
    insert into public.franchise_games (franchise_id, season_number, week, week_key, opens_at, opponent_key, opponent, home, rival, seed)
    values (p_franchise, p_number, w, wk, opens, o.key,
      jsonb_build_object('key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr, 'logo', o.logo, 'theme', o.theme,
        'offense', o.offense, 'defense', o.defense, 'style', o.style,
        'overall', oovr, 'offense_r', greatest(40, least(99, oovr + spread)), 'defense_r', greatest(40, least(99, oovr - spread)),
        'special_r', greatest(40, least(99, oovr + floor(random() * 7)::int - 3))),
      home, w = s.weeks, md5(f.seed || ':game:' || p_number || ':' || w));
    home := not home;
    made := made + 1;
  end loop;
  return made;
end;
$$;

-- OPEN A SEASON: schedule it, mark it active, record that it began.
create or replace function public.franchise_open_season(p_franchise uuid, p_number integer, p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  n := public.franchise_schedule_season(p_franchise, p_number, p_now);
  update public.franchise_seasons set status = 'active' where franchise_id = p_franchise and number = p_number and status = 'preseason';
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
  values (p_franchise, 'season_started', p_number::text, public.games_week_key(p_now), public.games_day_key(p_now),
          jsonb_build_object('season_number', p_number, 'games', n), p_now)
  on conflict (franchise_id, kind, key) do nothing;
  return n;
end;
$$;

-- ONE DRIVE. The offense's effective rating against the defense's decides
-- the odds of a touchdown, a field-goal try, a turnover or a punt; the
-- kicker's unit decides whether a try is good. Yards and plays are drawn to
-- fit the outcome, split by the offense's pass share. Returns the drive.
-- A trailing default makes a new signature, so the seven-argument form is
-- dropped first — otherwise both would exist and the simulator would keep
-- calling the one that knows nothing about a call.
drop function if exists public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean);
drop function if exists public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text);
drop function if exists public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean);
drop function if exists public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text);
create or replace function public.franchise_sim_drive(
  p_off numeric, p_def numeric, p_st numeric, p_pass_share numeric, p_takeaway numeric, p_clutch numeric, p_short_field boolean,
  p_call text default null, p_lean numeric default 0, p_giveaway boolean default false,
  p_front text default null, p_play text default null, p_used integer default 0)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  edge numeric := p_off - p_def; p_td numeric; p_fg numeric; p_to numeric; r numeric := random();
  outcome text; pts integer := 0; yds integer; plays integer; is_pass boolean; py integer; pp integer;
  c jsonb; fr jsonb; fr_td numeric := 0; fr_to numeric := 0;
  pl jsonb; tell numeric; bought numeric; fresh numeric; gain numeric := 0; boom numeric := 0; broke boolean := false;
begin
  -- THE CALL (snap_v1) is one more input beside home field, preparation and
  -- the scheme matchup: it shifts how the ball is moved and what it risks,
  -- and the server applies it. A client sends the call, never the outcome.
  -- A PLAY IS A SPECIALISATION OF A CALL (playbook_v1), not a replacement: it
  -- names one of the four and inherits that call's numbers exactly as they
  -- were measured, then adds its own on top. So p_call is set FROM the play
  -- when a play was run, and everything below is the path it always was.
  pl := case when p_play is null then null else public.franchise_play(p_play) end;
  if pl is not null then
    p_call := pl->>'call';
    boom := (pl->>'explosive')::numeric;
  end if;
  c := case when p_call is null then null else public.franchise_snap_call(p_call) end;
  if c is not null then
    p_pass_share := greatest(0.05, least(0.95, p_pass_share + (c->>'pass')::numeric));
    -- YOUR OWN ROSTER DECIDES WHICH CALL IS YOURS. p_lean is how much better
    -- this team throws it than runs it, in rating points, and a call cashes
    -- that in proportion to how far it leans on the pass: a franchise with a
    -- quarterback gains on the shot and loses on the ground, and one built
    -- around a line and a back is the other way round. Same table, different
    -- best call, because it is a different team.
    p_off := p_off + (c->>'edge')::numeric + p_lean * (c->>'pass')::numeric;
    edge := p_off - p_def;
  end if;
  -- THE FRONT (defense_v1) is answered AFTER the offense has chosen how to
  -- move the ball, because that is what a defensive call is: a guess at what
  -- is coming. Stacking the box against a team that is throwing is worse than
  -- playing it honest, and sitting deep against a team that is running is
  -- worse still. p_pass_share is already the offense's own, call included, so
  -- the weighting is the read.
  fr := case when p_front is null then null else public.franchise_front_call(p_front) end;
  if fr is not null then
    fr_td := (fr->>'td_vs_pass')::numeric * p_pass_share
           + (fr->>'td_vs_run')::numeric * (1 - p_pass_share);
    fr_to := (fr->>'to_vs_pass')::numeric * p_pass_share
           + (fr->>'to_vs_run')::numeric * (1 - p_pass_share);
  end if;
  -- A GIVEAWAY HANDS THE OTHER SIDE THE BALL IN SCORING RANGE, which is what
  -- makes a turnover cost anything at all. Before this it cost exactly what a
  -- punt cost — nothing — and eight thousand measured drives said so: Take a
  -- shot scored 2.32 a drive against Balanced's 1.78 and gave up nothing for
  -- it, so there was no decision to make. This is the price.
  p_td := greatest(0.05, least(0.48, 0.21 + edge * 0.005
                                   + (case when p_giveaway then 0.26 when p_short_field then 0.15 else 0 end)
                                   + coalesce((c->>'td')::numeric, 0)
                                   + fr_td));
  p_fg := greatest(0.06, least(0.30, 0.15 + edge * 0.003
                                   + (case when p_giveaway then 0.16 when p_short_field then 0.12 else 0 end)));
  p_to := 0.12 - edge * 0.003 + p_takeaway
        + coalesce((c->>'turnover')::numeric, 0) + fr_to;
  -- WHAT THE PLAY ITSELF IS WORTH, and — for a trick — whether they bought
  -- the formation's tell. A flea flicker out of the I-Formation into a
  -- stacked box is a touchdown; the same play into a defense sitting deep is
  -- the ball on the floor. And it goes stale: every time you have called it
  -- already in this game, the payoff is worth less.
  if pl is not null then
    if pl->>'type' = 'trick' then
      tell := coalesce((public.franchise_formation(pl->>'formation')->>'tell')::numeric, 0);
      bought := case
        when p_front = 'stack' and tell <= -0.3 then 1.0     -- they sold out on the run look
        when p_front = 'cover' and tell >= 0.3 then 1.0      -- they sat deep on the pass look
        when p_front = 'blitz' then 0.75                     -- nobody left in to cover it
        when p_front is null then 0.5
        else 0.25 end;
      fresh := greatest(0, 1 - 0.5 * greatest(0, coalesce(p_used, 0)));
      gain := bought * fresh;
      -- A TRICK THEY HAVE SEEN IS WORSE THAN AN HONEST PLAY, not merely less
      -- good. The first cut only withheld the bonus, which left a stale trick
      -- looking like a Take-a-shot with a few more giveaways — and measuring
      -- whole games said so: calling the flea flicker on EVERY possession beat
      -- a real mix by a point of margin and grinding it out by three and a
      -- half. That is a trick-play strategy, which is the one thing this
      -- phase exists to make impossible. So being read costs you.
      p_td := p_td + (pl->>'td')::numeric * gain - 0.060 * (1 - fresh);
      p_to := p_to + (pl->>'turnover')::numeric * (1 - 0.6 * gain) + 0.040 * (1 - fresh);
      boom := boom * greatest(0.20, gain);
    else
      p_td := p_td + (pl->>'td')::numeric;
      p_to := p_to + (pl->>'turnover')::numeric;
    end if;
    p_td := greatest(0.05, least(0.60, p_td));
  end if;
  -- the ceiling was 0.40 and a stale trick reached it, so the penalty was
  -- being absorbed by the cap rather than paid
  p_to := greatest(0.04, least(0.52, p_to));
  if r < p_td then outcome := 'td'; pts := 7;
  elsif r < p_td + p_fg then
    if random() < greatest(0.45, least(0.97, 0.72 + (p_st - 70) * 0.012 + p_clutch)) then outcome := 'fg'; pts := 3;
    else outcome := 'fg_miss'; end if;
  elsif r < p_td + p_fg + p_to then outcome := 'turnover';
  else outcome := 'punt'; end if;
  yds := case outcome when 'td' then 55 + floor(random() * 31)::int
                      when 'fg' then 40 + floor(random() * 31)::int
                      when 'fg_miss' then 35 + floor(random() * 26)::int
                      when 'turnover' then 8 + floor(random() * 38)::int
                      else 3 + floor(random() * 33)::int end;
  plays := case outcome when 'td' then 6 + floor(random() * 5)::int
                        when 'fg' then 6 + floor(random() * 4)::int
                        when 'fg_miss' then 5 + floor(random() * 4)::int
                        when 'turnover' then 3 + floor(random() * 5)::int
                        else 3 + floor(random() * 4)::int end;
  -- A CHUNK PLAY. Eight thousand drives said a touchdown drive was 55 to 85
  -- yards EVERY TIME — there was no such thing as a big play. An explosive
  -- play is more yards in fewer snaps, which the clock then feels: the ball
  -- goes further and the drive takes less time.
  if boom > 0 and random() < boom then
    yds := least(99, round(yds * (1 + 0.55 * boom))::int);
    plays := greatest(2, plays - greatest(1, round(3 * boom)::int));
    broke := true;
  end if;
  is_pass := random() < p_pass_share;
  py := round(yds * p_pass_share)::int; pp := round(plays * p_pass_share)::int;
  return jsonb_build_object('outcome', outcome, 'pts', pts, 'yds', yds, 'plays', plays, 'is_pass', is_pass,
    'pass_yds', py, 'rush_yds', yds - py, 'pass_plays', pp, 'rush_plays', plays - pp,
    'call', case when c is null then null else c->>'key' end,
    'front', case when fr is null then null else fr->>'key' end,
    'play', case when pl is null then null else pl->>'key' end,
    'formation', case when pl is null then null else pl->>'formation' end,
    'trick', case when pl is null then null else pl->>'type' = 'trick' end,
    'fooled', case when pl is null or pl->>'type' <> 'trick' then null else round(gain, 2) end,
    'big', broke);
end;
$$;

-- A drive folded into team totals.
create or replace function public.franchise_drive_totals(p_d jsonb)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'possessions', 1, 'plays', (p_d->>'plays')::int, 'yds', (p_d->>'yds')::int,
    'pass_yds', (p_d->>'pass_yds')::int, 'rush_yds', (p_d->>'rush_yds')::int,
    'pass_plays', (p_d->>'pass_plays')::int, 'rush_plays', (p_d->>'rush_plays')::int,
    'td', case when p_d->>'outcome' = 'td' then 1 else 0 end,
    'pass_td', case when p_d->>'outcome' = 'td' and (p_d->>'is_pass')::boolean then 1 else 0 end,
    'rush_td', case when p_d->>'outcome' = 'td' and not (p_d->>'is_pass')::boolean then 1 else 0 end,
    'fg', case when p_d->>'outcome' = 'fg' then 1 else 0 end,
    'fga', case when p_d->>'outcome' in ('fg', 'fg_miss') then 1 else 0 end,
    'turnovers', case when p_d->>'outcome' = 'turnover' then 1 else 0 end,
    'int', case when p_d->>'outcome' = 'turnover' and (p_d->>'is_pass')::boolean then 1 else 0 end,
    'punts', case when p_d->>'outcome' = 'punt' then 1 else 0 end,
    'points', (p_d->>'pts')::int);
$$;

-- The n-th starter at a position, from the lineup the simulator loaded.
create or replace function public.franchise_nth(p_players jsonb, p_pos text, p_n integer)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select x from jsonb_array_elements(p_players) x
  where x->>'position' = p_pos
  order by (x->>'depth')::int, (x->>'overall')::int desc
  offset greatest(0, p_n - 1) limit 1;
$$;

-- ANYBODY STILL STANDING. A touchdown has to be credited to a player, and
-- ten thousand seasons found franchises with NO QUARTERBACK AT ALL — every
-- one retired and the offseason never signed another. The attribution then
-- built a jsonb key out of a player who did not exist, the simulator threw
-- "key must not be null", and THE FRANCHISE COULD NEVER PLAY AGAIN: nine of
-- fifteen measured franchises were bricked this way, one as early as season
-- five. franchise_offseason now keeps every position stocked so it cannot
-- happen (offseason_v2) — and this is the belt for those braces. A thin
-- roster is a bad team; it is never a dead one.
create or replace function public.franchise_anybody(p_players jsonb, p_pos text, p_n integer)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select coalesce(
    public.franchise_nth(p_players, p_pos, p_n),
    public.franchise_nth(p_players, p_pos, 1),
    (select x from jsonb_array_elements(coalesce(p_players, '[]'::jsonb)) x
      order by (x->>'overall')::int desc limit 1));
$$;

-- THE SIMULATOR. Reads the game, the roster, the opponent frozen on the
-- game, this week's preparation and the starters' traits; plays it; returns
-- the box. Writes nothing — franchise_play_game does the writing.
create or replace function public.franchise_sim(p_franchise uuid, p_game uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; g public.franchise_games%rowtype; rt jsonb; opp jsonb; prep jsonb; tr jsonb; ps jsonb; st jsonb;
  my_off numeric; my_def numeric; my_st numeric; op_off numeric; op_def numeric; op_st numeric;
  h_me numeric; h_op numeric; prep_pts numeric; prep_adj numeric; sch_me numeric; sch_op numeric;
  a_off numeric; a_def numeric; b_off numeric; b_def numeric; late_off numeric; late_def numeric;
  pass_me numeric; pass_op numeric; qb_share numeric;
  n integer; i integer; k integer; q integer; d jsonb; who text; ot boolean := false; rnd integer := 0;
  pts_me integer := 0; pts_op integer := 0; q_me integer[] := '{0,0,0,0,0}'; q_op integer[] := '{0,0,0,0,0}';
  scoring jsonb := '[]'::jsonb; tot_me jsonb := '{}'::jsonb; tot_op jsonb := '{}'::jsonb; me_first boolean;
  tally jsonb := '{}'::jsonb; scorer jsonb; passer jsonb; kicker jsonb; r numeric; dist integer; desc_ text;
  rec_w numeric[] := array[0.30, 0.22, 0.14, 0.16, 0.12, 0.06]; rec_pos text[] := array['WR','WR','WR','TE','RB','WR'];
  rec_n integer[] := array[1, 2, 3, 1, 1, 4];
  players jsonb; potg jsonb; result text; short boolean;
  fac jsonb; film numeric; cond numeric; stad numeric;
  calls jsonb; my_drive integer := 0; drives jsonb := '[]'::jsonb; lean numeric; give boolean := false;
  v_left integer; v_stake numeric; v_key boolean;   -- what is at stake here (moment_v1)
  clk jsonb; total_secs integer; secs_left integer; v_secs integer; v_tempo numeric;   -- the clock (clock_v1)
  my_call text; v_call text; v_front text;   -- what I called, and what each side ran
  v_play text; v_used integer;   -- the play, and how stale the trick is (playbook_v1)
  play jsonb;
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into g from public.franchise_games where id = p_game and franchise_id = p_franchise;
  if not found then raise exception 'no such game' using errcode = 'P0002'; end if;
  perform setseed(public.franchise_seed_float(g.seed));
  -- what was called, possession by possession (snap_v1). Null for a game
  -- played through quick play, which is a game called Balanced throughout.
  calls := coalesce(g.calls, '[]'::jsonb);

  rt := public.franchise_team_rating(p_franchise);
  opp := g.opponent;
  prep := public.franchise_prep(p_franchise, g.week_key);
  tr := public.franchise_trait_effects(p_franchise);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
      'jersey', p.jersey, 'depth', p.depth, 'overall', p.overall, 'ratings', p.ratings) order by p.depth, p.overall desc), '[]'::jsonb)
    into ps from public.game_players p
   where p.franchise_id = p_franchise and public.franchise_is_available(p.status, p.injured_until);

  -- effective ratings
  my_off := (rt->>'offense')::numeric; my_def := (rt->>'defense')::numeric; my_st := (rt->>'special')::numeric;
  op_off := (opp->>'offense_r')::numeric; op_def := (opp->>'defense_r')::numeric; op_st := coalesce((opp->>'special_r')::numeric, op_off);
  -- the facilities: the Film Room in every game, Conditioning late, the
  -- Stadium at home (franchise_facilities)
  fac := coalesce(f.facilities, '{}'::jsonb);
  film := 0.5 * coalesce((fac->>'film')::numeric, 0);
  cond := 0.5 * coalesce((fac->>'conditioning')::numeric, 0);
  stad := 0.25 * coalesce((fac->>'stadium')::numeric, 0);
  h_me := case when g.home then 1.5 + stad else 0 end; h_op := case when g.home then 0 else 1.5 end;
  prep_pts := least(100, (prep->>'preparation')::numeric + 2 * (tr->>'preparation')::numeric);
  prep_adj := round((prep_pts - 50) / 50.0 * 3, 2);
  sch_me := public.franchise_scheme_edge(f.offense, opp->>'defense');
  sch_op := public.franchise_scheme_edge(opp->>'offense', f.defense);
  -- the coaching staff (Phase 8), in the same units everything else here is
  st := public.franchise_staff_effects(p_franchise);
  a_off := my_off + h_me + prep_adj + sch_me + film + 0.25 * (tr->>'offense')::numeric + (st->>'offense')::numeric;
  a_def := my_def + h_me + prep_adj + film + 0.25 * (tr->>'defense')::numeric + (st->>'defense')::numeric;
  b_off := op_off + h_op + sch_op;
  b_def := op_def + h_op;
  late_off := cond + 0.5 * (tr->>'late_offense')::numeric + (st->>'late_offense')::numeric;
  late_def := cond + 0.5 * (tr->>'late_defense')::numeric + (st->>'late_defense')::numeric;
  pass_me := public.franchise_pass_share(f.offense); pass_op := public.franchise_pass_share(opp->>'offense');
  -- HOW MUCH BETTER THIS TEAM THROWS IT THAN RUNS IT, in rating points, from
  -- the same position groups franchise_team_rating() publishes. A call cashes
  -- this in proportion to how far it leans on the pass (snap_v1), so the right
  -- call is a fact about YOUR roster rather than a number every franchise
  -- shares. Held inside ten points either way: a team is a team, not a cheat.
  lean := greatest(-10, least(10,
      (0.55 * (rt->'groups'->>'QB')::numeric + 0.30 * (rt->'groups'->>'WR')::numeric
         + 0.15 * (rt->'groups'->>'TE')::numeric)
    - (0.45 * (rt->'groups'->>'RB')::numeric + 0.55 * (rt->'groups'->>'OL')::numeric)));
  qb_share := public.franchise_qb_rush_share(f.offense);
  -- WHOEVER IS LEFT throws it and kicks it. A roster with no quarterback is
  -- a bad team, not a dead one, and the score still has to land on a name or
  -- the box stops adding up.
  passer := public.franchise_anybody(ps, 'QB', 1); kicker := public.franchise_anybody(ps, 'K', 1);

  -- THE CLOCK (clock_v1). There is no set number of possessions any more:
  -- there are sixty minutes, and possessions are what fits inside them. A
  -- drive costs time in proportion to its plays and how they were run.
  clk := public.franchise_clock();
  total_secs := (clk->>'quarters')::int * (clk->>'quarter_seconds')::int;
  secs_left := total_secs;
  me_first := random() < 0.5;
  n := 0;   -- counted as it happens, and reported afterwards

  -- REGULATION. One possession at a time, alternating, until the clock is
  -- gone. i counts possessions in the order they happen, which is also the
  -- order the calls array is in — because you call BOTH sides now.
  i := 0;
  while secs_left > 0 and i < 60 loop
    i := i + 1;
    q := least((clk->>'quarters')::int,
               1 + ((total_secs - secs_left) / (clk->>'quarter_seconds')::int));
    short := false;
    -- WHAT IS AT STAKE ON THIS POSSESSION (moment_v1), from the score as it
    -- stands and the possessions left. Computed BEFORE anything resolves, and
    -- it consumes no randomness — a seeded game plays out exactly as it did
    -- before this phase existed. The stake is a property of the game state, so
    -- it is the same number for the side chasing and the side defending.
    -- how many possessions this side has left, near enough to price what is
    -- at stake: the clock divided by what a possession costs, halved because
    -- the other team gets every other one.
    v_left := greatest(1, round(secs_left::numeric
                                / ((clk->>'nominal_drive')::numeric * 2))::int);
    v_stake := public.franchise_stake(pts_me - pts_op, v_left);
    v_key := public.franchise_is_key(v_stake);
    -- whose ball: they alternate, and who received decides which is odd
    who := case when (i % 2 = 1) = me_first then 'me' else 'opp' end;
    -- YOUR CALL FOR THIS POSSESSION, whichever side of the ball it is on.
    -- One array, one entry per possession, in the order they happened.
    my_call := calls->>(i - 1);
    if who = 'me' then
        -- MY drive: the call for this possession, if one was made (snap_v1).
        -- The calls live on the game, so re-running the simulator reproduces
        -- every drive already played and adds the new one.
        my_drive := my_drive + 1;
        -- MY BALL: an offensive call if I made one, otherwise the caller
        -- plays the situation for me — which is what quick play now is.
        -- MY BALL. A PLAY if I called one out of my own book (playbook_v1),
        -- otherwise a plain call — and if I called nothing at all, the caller
        -- plays the situation for me, which is what quick play is.
        v_play := case when my_call is not null and public.franchise_play_allowed(f.offense, my_call)
                       then my_call end;
        v_call := case when v_play is not null then null
                       when public.franchise_call_side(my_call) = 'off' then my_call
                       else public.franchise_ai_call(f.offense, pts_me - pts_op, v_left) end;
        -- HOW STALE THE TRICK IS: how many times this exact play has already
        -- been called in this game. There is no trick-play strategy.
        v_used := case when v_play is null then 0 else
          (select count(*) from jsonb_array_elements_text(calls) with ordinality t(cc, oo)
            where oo < i and cc = v_play) end;
        -- THE DEFENSE READS THE FORMATION I LINED UP IN. Lining up heavy
        -- really does get a stacked box — which is what the trick play out of
        -- it is for.
        v_front := case when v_play is null then null else
          public.franchise_ai_front(
            (public.franchise_formation(public.franchise_play(v_play)->>'formation')->>'tell')::numeric,
            pts_op - pts_me, v_left) end;
        v_tempo := public.franchise_tempo(pts_me - pts_op, secs_left);
        d := public.franchise_sim_drive(a_off + case when q >= 4 then late_off else 0 end, b_def, my_st, pass_me, 0,
               case when q >= 4 then 0.02 * ((tr->>'clutch')::numeric + (st->>'clutch')::numeric) else 0 end, short,
               v_call, lean, give, v_front, v_play, v_used);
        -- a turnover on this drive is the next side's short field, and this
        -- one's gift is spent
        give := d->>'outcome' = 'turnover';
        pts_me := pts_me + (d->>'pts')::int; q_me[q] := q_me[q] + (d->>'pts')::int;
        tot_me := public.games_jsonb_sum(tot_me, public.franchise_drive_totals(d));
        -- EVERY DRIVE ON THE RECORD, not only the scoring ones: this is what
        -- a game you call has to show you back, possession by possession.
        v_secs := public.franchise_drive_seconds((d->>'plays')::int,
                    coalesce(nullif((d->>'pass_plays')::numeric, 0) / nullif((d->>'plays')::numeric, 0), pass_me),
                    d->>'outcome', v_tempo);
        v_secs := least(v_secs, secs_left); secs_left := secs_left - v_secs;
        drives := drives || jsonb_build_object('n', my_drive, 'side', 'me', 'q', q,
          'call', d->>'call', 'front', d->>'front', 'outcome', d->>'outcome', 'pts', (d->>'pts')::int,
          'yds', (d->>'yds')::int, 'plays', (d->>'plays')::int,
          'me', pts_me, 'op', pts_op,
          'play', d->>'play', 'formation', d->>'formation',
          'trick', (d->>'trick')::boolean, 'fooled', (d->>'fooled')::numeric, 'big', (d->>'big')::boolean,
          'stake', v_stake, 'key', v_key, 'left', v_left,
          'secs', v_secs, 'clock', secs_left, 'mine', true);
        if d->>'outcome' = 'td' then
          if (d->>'is_pass')::boolean then
            -- a receiver by share
            r := random(); scorer := null;
            for j in 1..array_length(rec_w, 1) loop
              r := r - rec_w[j];
              if r < 0 then scorer := public.franchise_nth(ps, rec_pos[j], rec_n[j]); exit; end if;
            end loop;
            if scorer is null then scorer := public.franchise_anybody(ps, 'WR', 1); end if;
            dist := 1 + floor(random() * 40)::int;
            desc_ := (passer->>'name') || ' to ' || (scorer->>'name') || ', ' || dist || '-yd TD pass';
            -- a score with nobody left to credit still plays out; it simply
            -- goes on no line rather than killing the franchise
            if scorer is not null then
              tally := tally || jsonb_build_object(scorer->>'id', public.games_jsonb_sum(tally->(scorer->>'id'), '{"rec_td":1}'::jsonb));
            end if;
            if passer is not null then
              tally := tally || jsonb_build_object(passer->>'id', public.games_jsonb_sum(tally->(passer->>'id'), '{"pass_td":1}'::jsonb));
            end if;
          else
            r := random();
            scorer := case when r < qb_share then passer when r < qb_share + (1 - qb_share) * 0.8 then public.franchise_nth(ps, 'RB', 1)
                           else public.franchise_nth(ps, 'RB', 2) end;
            if scorer is null then scorer := public.franchise_anybody(ps, 'RB', 1); end if;
            dist := 1 + floor(random() * 25)::int;
            desc_ := (scorer->>'name') || ', ' || dist || '-yd TD run';
            if scorer is not null then
              tally := tally || jsonb_build_object(scorer->>'id', public.games_jsonb_sum(tally->(scorer->>'id'), '{"rush_td":1}'::jsonb));
            end if;
          end if;
          scoring := scoring || jsonb_build_object('q', q, 'side', 'for', 'type', 'TD', 'pts', 7, 'desc', desc_, 'for', pts_me, 'against', pts_op);
        elsif d->>'outcome' = 'fg' then
          dist := 20 + floor(random() * 33)::int;
          scoring := scoring || jsonb_build_object('q', q, 'side', 'for', 'type', 'FG', 'pts', 3,
            'desc', coalesce(kicker->>'name', 'Field goal') || ', ' || dist || '-yd FG', 'for', pts_me, 'against', pts_op);
        end if;
      else
        -- THEIR BALL. They call from their own scheme and the situation they
        -- are in — so a power-run team nursing a lead runs at you, and the
        -- same team down ten late has to throw. That is the read. My front is
        -- the answer to it, and it is answered without seeing their card.
        v_call := public.franchise_ai_call(opp->>'offense', pts_op - pts_me, v_left);
        v_front := case when public.franchise_call_side(my_call) = 'def' then my_call
                        else public.franchise_fronts()->>'default' end;
        v_tempo := public.franchise_tempo(pts_op - pts_me, secs_left);
        d := public.franchise_sim_drive(b_off, a_def + case when q >= 4 then late_def else 0 end, op_st, pass_op,
               0.01 * ((tr->>'takeaway')::numeric + (st->>'takeaway')::numeric), 0, short,
               v_call, 0, give, v_front);
        give := d->>'outcome' = 'turnover';
        pts_op := pts_op + (d->>'pts')::int; q_op[q] := q_op[q] + (d->>'pts')::int;
        v_secs := public.franchise_drive_seconds((d->>'plays')::int,
                    coalesce(nullif((d->>'pass_plays')::numeric, 0) / nullif((d->>'plays')::numeric, 0), pass_op),
                    d->>'outcome', v_tempo);
        v_secs := least(v_secs, secs_left); secs_left := secs_left - v_secs;
        drives := drives || jsonb_build_object('n', my_drive, 'side', 'op', 'q', q,
          'call', d->>'call', 'front', d->>'front', 'outcome', d->>'outcome', 'pts', (d->>'pts')::int,
          'yds', (d->>'yds')::int, 'plays', (d->>'plays')::int,
          'me', pts_me, 'op', pts_op,
          'stake', v_stake, 'key', v_key, 'left', v_left,
          'secs', v_secs, 'clock', secs_left, 'mine', false);
        tot_op := public.games_jsonb_sum(tot_op, public.franchise_drive_totals(d));
        if d->>'outcome' = 'td' then
          scoring := scoring || jsonb_build_object('q', q, 'side', 'against', 'type', 'TD', 'pts', 7,
            'desc', (opp->>'name') || ', ' || (d->>'plays') || '-play drive, ' || (case when (d->>'is_pass')::boolean then 'TD pass' else 'TD run' end),
            'for', pts_me, 'against', pts_op);
        elsif d->>'outcome' = 'fg' then
          scoring := scoring || jsonb_build_object('q', q, 'side', 'against', 'type', 'FG', 'pts', 3,
            'desc', (opp->>'name') || ', field goal', 'for', pts_me, 'against', pts_op);
        end if;
    end if;
    n := greatest(n, my_drive);
  end loop;

  -- OVERTIME. The clock is gone and it is level: possessions each, from a
  -- short field, until somebody is in front at the end of a round.
  if pts_me = pts_op then
    ot := true; q := (clk->>'quarters')::int + 1;
    for rnd in 1..(clk->>'ot_rounds')::int loop
      v_left := 1;
      v_stake := public.franchise_stake(pts_me - pts_op, v_left);
      v_key := public.franchise_is_key(v_stake);
      for k in 0..1 loop
        who := case when (k = 0) = me_first then 'me' else 'opp' end;
        i := i + 1;
        my_call := calls->>(i - 1);
        if who = 'me' then
          my_drive := my_drive + 1;
          v_call := case when public.franchise_call_side(my_call) = 'off' then my_call
                         else public.franchise_ai_call(f.offense, pts_me - pts_op, 1) end;
          d := public.franchise_sim_drive(a_off + late_off, b_def, my_st, pass_me, 0,
                 0.02 * ((tr->>'clutch')::numeric + (st->>'clutch')::numeric), true,
                 v_call, lean, give, null);
          give := d->>'outcome' = 'turnover';
          pts_me := pts_me + (d->>'pts')::int; q_me[q] := q_me[q] + (d->>'pts')::int;
          tot_me := public.games_jsonb_sum(tot_me, public.franchise_drive_totals(d));
          drives := drives || jsonb_build_object('n', my_drive, 'side', 'me', 'q', q,
            'call', d->>'call', 'front', null, 'outcome', d->>'outcome', 'pts', (d->>'pts')::int,
            'yds', (d->>'yds')::int, 'plays', (d->>'plays')::int, 'me', pts_me, 'op', pts_op,
            'stake', v_stake, 'key', v_key, 'left', v_left, 'secs', 0, 'clock', 0, 'mine', true);
          -- A SCORE HAS TO BE SOMEBODY'S. Writing this block by hand left an
          -- overtime touchdown in the team totals and on nobody's line, and
          -- one box in four hundred stopped adding up because of it. This is
          -- the same attribution regulation does, through the helper the
          -- versus simulator already shares.
          play := public.franchise_sim_score_play(d, ps, passer, kicker, qb_share, tally);
          if play is not null then
            tally := play->'tally';
            scoring := scoring || jsonb_build_object('q', q, 'side', 'for', 'type', play->>'type',
              'pts', play->'pts', 'desc', play->>'desc', 'for', pts_me, 'against', pts_op);
          end if;
        else
          v_call := public.franchise_ai_call(opp->>'offense', pts_op - pts_me, 1);
          v_front := case when public.franchise_call_side(my_call) = 'def' then my_call
                          else public.franchise_fronts()->>'default' end;
          d := public.franchise_sim_drive(b_off, a_def + late_def, op_st, pass_op,
                 0.01 * ((tr->>'takeaway')::numeric + (st->>'takeaway')::numeric), 0, true,
                 v_call, 0, give, v_front);
          give := d->>'outcome' = 'turnover';
          pts_op := pts_op + (d->>'pts')::int; q_op[q] := q_op[q] + (d->>'pts')::int;
          tot_op := public.games_jsonb_sum(tot_op, public.franchise_drive_totals(d));
          drives := drives || jsonb_build_object('n', my_drive, 'side', 'op', 'q', q,
            'call', d->>'call', 'front', d->>'front', 'outcome', d->>'outcome', 'pts', (d->>'pts')::int,
            'yds', (d->>'yds')::int, 'plays', (d->>'plays')::int, 'me', pts_me, 'op', pts_op,
            'stake', v_stake, 'key', v_key, 'left', v_left, 'secs', 0, 'clock', 0, 'mine', false);
          if (d->>'pts')::int > 0 then
            scoring := scoring || jsonb_build_object('q', q, 'side', 'against',
              'type', case when d->>'outcome' = 'td' then 'TD' else 'FG' end, 'pts', (d->>'pts')::int,
              'desc', (opp->>'name') || ', overtime ' || (d->>'plays') || '-play drive',
              'for', pts_me, 'against', pts_op);
          end if;
        end if;
      end loop;
      exit when pts_me <> pts_op;
    end loop;
    n := greatest(n, my_drive);
  end if;

  result := case when pts_me > pts_op then 'W' when pts_me < pts_op then 'L' else 'T' end;
  players := public.franchise_sim_lines(ps, f.offense, tot_me, tot_op, tally, tr);
  select p into potg from jsonb_array_elements(players) p order by (p->>'impact')::numeric desc limit 1;

  return jsonb_build_object(
    'sim', 'sim_v4', 'seed', g.seed, 'home', g.home, 'rival', g.rival, 'week', g.week, 'season_number', g.season_number,
    'opponent', opp, 'final', jsonb_build_object('for', pts_me, 'against', pts_op), 'result', result, 'ot', ot,
    'quarters', jsonb_build_object('for', to_jsonb(q_me), 'against', to_jsonb(q_op), 'ot', ot),
    'scoring', scoring,
    'team', jsonb_build_object('for', tot_me, 'against', tot_op),
    'edges', jsonb_build_object('home', h_me, 'prep', prep, 'prep_adj', prep_adj, 'scheme_offense', sch_me, 'scheme_defense', sch_op,
      'facilities', jsonb_build_object('film', film, 'conditioning', cond, 'stadium', case when g.home then stad else 0 end),
      'traits', tr, 'offense', round(a_off, 1), 'defense', round(a_def, 1), 'opp_offense', round(b_off, 1), 'opp_defense', round(b_def, 1),
      'lean', round(lean, 1), 'possessions', n,
      'clock', clk, 'seconds', total_secs, 'defense', public.franchise_fronts()->>'version',
      'playbook', public.franchise_plays()->>'version'),
    'players', players, 'potg', potg, 'drives', drives,
    'story', public.franchise_game_story(drives), 'moment', public.franchise_moments()->>'version',
    'calls', case when jsonb_array_length(calls) > 0 then calls end,
    'snap', case when jsonb_array_length(calls) > 0 then public.franchise_snaps()->>'version' end);
end;
$$;

-- THE LINES. Team totals and the scoring tally distributed over the
-- starters by role and share, so a box score adds up to its own team totals
-- and a card's career line is the sum of its box scores. Returns one entry
-- per starter: the line the page shows, the increments the record keeps,
-- and an impact number that names the player of the game.
create or replace function public.franchise_sim_lines(p_players jsonb, p_offense text, p_me jsonb, p_op jsonb, p_tally jsonb, p_tr jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  lines jsonb := '[]'::jsonb; p jsonb; x jsonb; ln jsonb; st jsonb; imp numeric;
  att integer; cmp integer; pass_yds integer; rush_yds integer; rush_plays integer; cmp_rate numeric;
  qb_share numeric := public.franchise_qb_rush_share(p_offense);
  qb_yds integer; rb1_yds integer; rb2_yds integer; qb_car integer; rb1_car integer; rb2_car integer;
  rec_w numeric[] := array[0.30, 0.22, 0.14, 0.16, 0.12, 0.06]; rec_pos text[] := array['WR','WR','WR','TE','RB','WR'];
  rec_n integer[] := array[1, 2, 3, 1, 1, 4]; rec_yds integer[] := '{0,0,0,0,0,0}'; rec_cnt integer[] := '{0,0,0,0,0,0}';
  j integer; ry integer; rc integer;
  opp_plays integer; opp_pass integer; tkl_total integer; sacks integer; ints integer; sack_rate numeric; dl_prs numeric;
  tk_pos text[] := array['LB','LB','LB','S','S','CB','CB','DL','DL','DL','DL']; tk_n integer[] := array[1,2,3,1,2,1,2,1,2,3,4];
  tk_w numeric[] := array[0.16, 0.13, 0.10, 0.11, 0.09, 0.08, 0.07, 0.07, 0.06, 0.05, 0.04];
  dtally jsonb := '{}'::jsonb; who jsonb; r numeric; i integer; given_tkl integer := 0; tk integer;
begin
  att := coalesce((p_me->>'pass_plays')::int, 0); pass_yds := coalesce((p_me->>'pass_yds')::int, 0);
  rush_yds := coalesce((p_me->>'rush_yds')::int, 0); rush_plays := coalesce((p_me->>'rush_plays')::int, 0);
  opp_plays := coalesce((p_op->>'plays')::int, 0); opp_pass := coalesce((p_op->>'pass_plays')::int, 0);

  -- the quarterback
  p := public.franchise_nth(p_players, 'QB', 1);
  cmp_rate := greatest(0.40, least(0.80, 0.52 + (coalesce((p->'ratings'->>'acc')::int, 70) - 70) / 200.0 + 0.005 * (p_tr->>'drop_resist')::numeric));
  cmp := round(att * cmp_rate)::int;
  qb_yds := round(rush_yds * qb_share)::int; qb_car := round(rush_plays * qb_share)::int;
  rb1_yds := round((rush_yds - qb_yds) * 0.72)::int; rb2_yds := rush_yds - qb_yds - rb1_yds;
  rb1_car := round((rush_plays - qb_car) * 0.72)::int; rb2_car := rush_plays - qb_car - rb1_car;
  -- receiving by share, rounded cumulatively (each receiver takes the
  -- difference of two rounded running totals), so the six lines add up to
  -- the team's passing yards and completions exactly, whatever the totals
  declare cum numeric := 0; prev_y integer := 0; prev_c integer := 0; cy integer; cc integer;
  begin
    for j in 1..6 loop
      cum := cum + rec_w[j];
      if j = 6 then cy := pass_yds; cc := cmp; else cy := round(pass_yds * cum)::int; cc := round(cmp * cum)::int; end if;
      rec_yds[j] := greatest(0, cy - prev_y); rec_cnt[j] := greatest(0, cc - prev_c);
      prev_y := cy; prev_c := cc;
    end loop;
  end;

  -- the defensive tally: tackles by weight, sacks and interceptions by draw
  tkl_total := round(opp_plays * 0.85)::int;
  select coalesce(avg((dl->'ratings'->>'prs')::int), 70) into dl_prs
    from jsonb_array_elements(p_players) dl where dl->>'position' = 'DL' and (dl->>'depth')::int <= 4;
  sack_rate := greatest(0.02, least(0.12, 0.055 + (dl_prs - 70) * 0.002 + 0.003 * (p_tr->>'edge_rush')::numeric));
  sacks := round(opp_pass * sack_rate)::int;
  ints := coalesce((p_op->>'int')::int, 0);
  for i in 1..sacks loop
    r := random();
    who := case when r < 0.35 then public.franchise_nth(p_players, 'DL', 1) when r < 0.60 then public.franchise_nth(p_players, 'DL', 2)
                when r < 0.75 then public.franchise_nth(p_players, 'DL', 3) when r < 0.90 then public.franchise_nth(p_players, 'LB', 1)
                else public.franchise_nth(p_players, 'DL', 4) end;
    if who is not null then dtally := dtally || jsonb_build_object(who->>'id', public.games_jsonb_sum(dtally->(who->>'id'), '{"sacks":1}'::jsonb)); end if;
  end loop;
  for i in 1..ints loop
    r := random();
    who := case when r < 0.30 then public.franchise_nth(p_players, 'CB', 1) when r < 0.55 then public.franchise_nth(p_players, 'CB', 2)
                when r < 0.80 then public.franchise_nth(p_players, 'S', 1) else public.franchise_nth(p_players, 'S', 2) end;
    if who is not null then dtally := dtally || jsonb_build_object(who->>'id', public.games_jsonb_sum(dtally->(who->>'id'), '{"int":1}'::jsonb)); end if;
  end loop;
  for i in 1..array_length(tk_pos, 1) loop
    who := public.franchise_nth(p_players, tk_pos[i], tk_n[i]);
    if who is null then continue; end if;
    tk := case when i = array_length(tk_pos, 1) then tkl_total - given_tkl else round(tkl_total * tk_w[i])::int end;
    tk := greatest(0, tk); given_tkl := given_tkl + tk;
    dtally := dtally || jsonb_build_object(who->>'id', public.games_jsonb_sum(dtally->(who->>'id'), jsonb_build_object('tkl', tk)));
  end loop;

  -- every starter gets a line, and so do the second back and the fourth
  -- receiver, who carry the ball too
  for x in select * from jsonb_array_elements(p_players) loop
    if (x->>'depth')::int > (case x->>'position' when 'WR' then 4 when 'RB' then 2 when 'OL' then 5 when 'DL' then 4 when 'LB' then 3
                                                   when 'CB' then 2 when 'S' then 2 else 1 end) then continue; end if;
    st := '{"games":1}'::jsonb; imp := 0;
    case x->>'position'
      when 'QB' then
        st := st || jsonb_build_object('att', att, 'cmp', cmp, 'yds', pass_yds, 'td', coalesce((p_tally->(x->>'id')->>'pass_td')::int, 0),
                'int', coalesce((p_me->>'int')::int, 0), 'car', qb_car, 'rush_yds', qb_yds, 'rush_td', coalesce((p_tally->(x->>'id')->>'rush_td')::int, 0));
        imp := pass_yds / 25.0 + (st->>'td')::int * 4 - (st->>'int')::int * 3 + qb_yds / 15.0 + (st->>'rush_td')::int * 4;
      when 'RB' then
        j := case when (x->>'depth')::int = 1 then 1 else 2 end;
        st := st || jsonb_build_object('car', case when j = 1 then rb1_car else rb2_car end, 'yds', case when j = 1 then rb1_yds else rb2_yds end,
                'td', coalesce((p_tally->(x->>'id')->>'rush_td')::int, 0));
        if j = 1 then
          ry := rec_yds[5]; rc := rec_cnt[5];
          st := st || jsonb_build_object('rec', rc, 'rec_yds', ry, 'rec_td', coalesce((p_tally->(x->>'id')->>'rec_td')::int, 0));
          imp := (st->>'yds')::int / 12.0 + (st->>'td')::int * 4 + ry / 15.0 + (st->>'rec_td')::int * 4;
        else
          imp := (st->>'yds')::int / 12.0 + (st->>'td')::int * 4;
        end if;
      when 'WR', 'TE' then
        j := 0;
        for i in 1..array_length(rec_pos, 1) loop
          if rec_pos[i] = x->>'position' and rec_n[i] = (x->>'depth')::int then j := i; exit; end if;
        end loop;
        if j = 0 then ry := 0; rc := 0; else ry := rec_yds[j]; rc := rec_cnt[j]; end if;
        st := st || jsonb_build_object('rec', rc, 'yds', ry, 'td', coalesce((p_tally->(x->>'id')->>'rec_td')::int, 0));
        imp := ry / 15.0 + (st->>'td')::int * 4;
      when 'OL' then
        imp := 0.1;
      when 'DL', 'LB', 'CB', 'S' then
        st := st || jsonb_build_object('tkl', coalesce((dtally->(x->>'id')->>'tkl')::int, 0), 'sacks', coalesce((dtally->(x->>'id')->>'sacks')::int, 0),
                'int', coalesce((dtally->(x->>'id')->>'int')::int, 0));
        imp := (st->>'tkl')::int * 0.6 + (st->>'sacks')::int * 3.5 + (st->>'int')::int * 4.5;
      when 'K' then
        st := st || jsonb_build_object('fg', coalesce((p_me->>'fg')::int, 0), 'fga', coalesce((p_me->>'fga')::int, 0), 'xp', coalesce((p_me->>'td')::int, 0));
        imp := (st->>'fg')::int * 2 + (case when (st->>'fga')::int > 0 and (st->>'fg')::int = (st->>'fga')::int then 1 else 0 end);
      when 'P' then
        st := st || jsonb_build_object('punts', coalesce((p_me->>'punts')::int, 0),
                'punt_yds', coalesce((p_me->>'punts')::int, 0) * (38 + round((coalesce((x->'ratings'->>'pwr')::int, 70) - 70) * 0.15)::int + floor(random() * 5)::int));
        imp := 0.2;
      else
        imp := 0;
    end case;
    lines := lines || jsonb_build_object('id', x->>'id', 'name', x->>'name', 'position', x->>'position', 'jersey', x->'jersey',
      'depth', x->'depth', 'stats', st, 'impact', round(imp, 2));
  end loop;
  return lines;
end;
$$;

-- PLAY THE NEXT GAME. The season must be active, the game must have opened,
-- and it is played exactly once: the franchise row is locked for the
-- duration, the result is written with the box, every starter's season and
-- career lines grow by their box, the season's record moves, and the ledger
-- is credited by the table — once, keyed by season and week. The last game
-- of the season completes it.
-- ONE GAME'S INJURIES, for one franchise. Drawn after the game from a seed
-- derived from the game's own, so the same game hurts the same man twice.
--
-- Whether anybody is hurt at all is one draw against the published chance,
-- bought down by the Conditioning facility. Who it is, is a weighted draw
-- over the men who were available to play: by position exposure, doubled
-- for a starter, halved for an Iron Man. How long is a draw against the
-- published severity table.
--
-- THE ONE REFUSAL: a position is never taken below the starters it needs.
-- A team of thirty-eight with one kicker keeps its kicker, and the draw
-- comes back empty rather than leaving a lineup the simulator cannot fill.
-- ── THE BOWL — bowl_v1 (Phase 7) ─────────────────────────────────────────
-- A postseason for the franchise's OWN season, for the player who never
-- joins a conference. Finish the eight weeks with more wins than losses and
-- a ninth game is scheduled: one club, drawn from the pool, rated above you
-- by as much as the season was good. Win it and it is on the wall.
--
-- The conference keeps the bracket; this is one game, and it is the reason
-- a 5–3 season is worth chasing.
create or replace function public.franchise_postseason()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'bowl_v1',
    'qualify', 'more wins than losses',
    'games', 1,
    'edge_base', 2,        -- the club is this much better than you, plus…
    'edge_per_win', 1,     -- …this much for every win over .500
    'edge_max', 8,
    'names', jsonb_build_array('Frost', 'Harvest', 'Copper', 'Lantern', 'Bluff',
                               'Ironwood', 'Salt Pine', 'Cascade', 'Redstone', 'Tidewater'));
$$;

-- Does this season earn a bowl? More wins than losses, and nothing else:
-- no committee, no ranking, no tiebreak to argue about.
create or replace function public.franchise_bowl_earned(p_wins integer, p_losses integer)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_wins, 0) > coalesce(p_losses, 0);
$$;

-- SCHEDULE THE BOWL. Called once, by the writer of the eighth game, when the
-- record has earned it. The opponent is drawn from the clubs the season did
-- NOT play, seeded from the franchise's own seed, and rated above the
-- franchise by the published edge — so a 7–1 season draws a harder game than
-- a 5–3 one. Returns the game, or null when the record did not earn it.
create or replace function public.franchise_schedule_bowl(p_franchise uuid, p_number integer, p_now timestamptz default now())
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; s public.franchise_seasons%rowtype; cfg jsonb := public.franchise_postseason();
  ovr numeric; o public.franchise_opponents%rowtype; oovr integer; d integer; spread integer;
  wk text; opens timestamptz; v_id uuid; v_name text; v_seed text;
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then return null; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise and number = p_number;
  if not found or not public.franchise_bowl_earned(s.wins, s.losses) then return null; end if;
  -- written once
  select id into v_id from public.franchise_games
   where franchise_id = p_franchise and season_number = p_number and bowl;
  if v_id is not null then return v_id; end if;

  v_seed := f.seed || ':bowl:' || p_number;
  perform setseed(public.franchise_seed_float(v_seed));
  ovr := (public.franchise_team_rating(p_franchise)->>'overall')::numeric;
  d := least((cfg->>'edge_max')::int,
             (cfg->>'edge_base')::int + (cfg->>'edge_per_win')::int * greatest(0, s.wins - s.losses));

  -- a club the season did not already play; if it played them all, any club
  select * into o from public.franchise_opponents
   where key not in (select opponent_key from public.franchise_games
                      where franchise_id = p_franchise and season_number = p_number)
   order by random() limit 1;
  if not found then select * into o from public.franchise_opponents order by random() limit 1; end if;

  oovr := greatest(45, least(97, round(ovr + d)::int));
  spread := floor(random() * 9)::int - 4;
  v_name := 'The ' || (cfg->'names'->>(floor(random() * jsonb_array_length(cfg->'names'))::int)) || ' Bowl';
  wk := public.games_week_key(p_now + interval '7 days');
  opens := ((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC';

  insert into public.franchise_games
    (franchise_id, season_number, week, week_key, opens_at, opponent_key, opponent, home, rival, bowl, seed)
  values (p_franchise, p_number, s.weeks + 1, wk, opens, o.key,
    jsonb_build_object('key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr, 'logo', o.logo, 'theme', o.theme,
      'offense', o.offense, 'defense', o.defense, 'style', o.style, 'bowl_name', v_name,
      'overall', oovr, 'offense_r', greatest(40, least(99, oovr + spread)),
      'defense_r', greatest(40, least(99, oovr - spread)),
      'special_r', greatest(40, least(99, oovr + floor(random() * 7)::int - 3))),
    false, false, true, md5(v_seed || ':game'))
  returning id into v_id;

  update public.franchise_seasons set status = 'playoffs'
   where franchise_id = p_franchise and number = p_number and status = 'active';
  perform public.franchise_award(p_franchise, 'bowl_bid', s.season,
    jsonb_build_object('season_number', p_number, 'bowl', v_name, 'record', s.wins || '-' || s.losses));
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
  values (p_franchise, 'bowl_bid', p_number::text, wk, public.games_day_key(p_now),
    jsonb_build_object('season_number', p_number, 'game_id', v_id, 'bowl', v_name,
      'record', s.wins || '-' || s.losses, 'opponent', o.name, 'overall', oovr), p_now)
  on conflict (franchise_id, kind, key) do nothing;
  return v_id;
end;
$$;

create or replace function public.franchise_draw_injuries(
  p_franchise uuid, p_seed text, p_week_key text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cfg jsonb := public.franchise_injuries(); f public.franchises%rowtype;
  v_chance numeric; v_cond integer; r numeric; total numeric := 0; acc numeric := 0;
  cand jsonb := '[]'::jsonb; c jsonb; pick jsonb; w numeric;
  sev jsonb; sp numeric; games integer; v_until timestamptz; starters integer; left_at integer;
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then return '[]'::jsonb; end if;
  v_cond := coalesce((f.facilities->>'conditioning')::int, 0);
  v_chance := greatest(0, (cfg->>'base')::numeric - (cfg->>'per_conditioning')::numeric * v_cond);
  -- and the head trainer takes a slice off what is left (Phase 8)
  v_chance := v_chance * (1 - coalesce((public.franchise_staff_effects(p_franchise)->>'injury_resist')::numeric, 0));

  perform setseed(public.franchise_seed_float(p_seed || ':inj:' || p_franchise::text));
  if random() >= v_chance then return '[]'::jsonb; end if;

  -- the men who could have been hurt, and how exposed each was
  for c in
    select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
        'depth', p.depth, 'overall', p.overall,
        'weight', coalesce((cfg->'exposure'->>p.position)::numeric, 1.0)
          * (case when p.depth <= coalesce((select (x->>'starters')::int from jsonb_array_elements(public.franchise_pool_plan()) x
                                             where x->>'pos' = p.position), 1)
                  then (cfg->>'starter_weight')::numeric else 1.0 end)
          * (case when p.traits @> '[{"id":"iron_man"}]'::jsonb then (cfg->>'iron_man')::numeric else 1.0 end))
      from public.game_players p
     where p.franchise_id = p_franchise and public.franchise_is_available(p.status, p.injured_until, p_now)
     order by p.position, p.depth, p.id
  loop
    cand := cand || jsonb_build_array(c);
    total := total + (c->>'weight')::numeric;
  end loop;
  if total <= 0 then return '[]'::jsonb; end if;

  r := random() * total;
  for c in select * from jsonb_array_elements(cand) loop
    acc := acc + (c->>'weight')::numeric;
    if acc >= r then pick := c; exit; end if;
  end loop;
  if pick is null then return '[]'::jsonb; end if;

  -- the refusal: his position must still field its starters without him
  select coalesce((x->>'starters')::int, 1) into starters
    from jsonb_array_elements(public.franchise_pool_plan()) x where x->>'pos' = pick->>'position';
  select count(*) into left_at from public.game_players p
   where p.franchise_id = p_franchise and p.position = pick->>'position'
     and p.id <> (pick->>'id')::uuid and public.franchise_is_available(p.status, p.injured_until, p_now);
  if left_at < coalesce(starters, 1) then return '[]'::jsonb; end if;

  -- how long
  r := random(); acc := 0;
  for sev in select * from jsonb_array_elements(cfg->'severity') loop
    acc := acc + (sev->>'p')::numeric;
    if r <= acc then exit; end if;
  end loop;
  if sev is null then sev := cfg->'severity'->0; end if;
  games := (sev->>'games')::int;

  -- he is fit again at the football-week boundary `games` weeks after the
  -- one he was hurt in, so he misses exactly that many Saturdays
  v_until := ((p_week_key::date + (7 * (games + 1)))::timestamp) at time zone 'UTC';
  update public.game_players
     set injured_until = greatest(coalesce(injured_until, v_until), v_until),
         injury = jsonb_build_object('kind', sev->>'key', 'name', sev->>'name', 'games', games,
                                     'week_key', p_week_key, 'until', v_until, 'version', cfg->>'version'),
         updated_at = p_now
   where id = (pick->>'id')::uuid;

  return jsonb_build_array(jsonb_build_object(
    'player', pick->>'id', 'name', pick->>'name', 'position', pick->>'position',
    'kind', sev->>'key', 'label', sev->>'name', 'games', games, 'until', v_until));
end;
$$;

create or replace function public.franchise_play_game(p_franchise uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; s public.franchise_seasons%rowtype; g public.franchise_games%rowtype;
  v_box jsonb; pf integer; pa integer; res text; ln jsonb; econ jsonb := public.franchise_economy();
  v_key text; v_xp integer := 0; v_tc integer := 0; v_cp integer := 0; v_new text[] := '{}'; v_label text; v_done boolean := false;
  v_kind text; v_kind_win text; v_bowl uuid; v_move integer; v_standing integer;
begin
  select * into f from public.franchises where id = p_franchise for update;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise order by number desc limit 1;
  -- 'playoffs' is the bowl waiting to be played (Phase 7); it is still a
  -- season under way, and the ninth game is played exactly like the other eight
  if not found or s.status not in ('active', 'playoffs') then
    raise exception 'the season is not under way' using errcode = '55000';
  end if;
  select * into g from public.franchise_games
   where franchise_id = p_franchise and season_number = s.number and status = 'scheduled' order by week limit 1;
  if not found then raise exception 'no game is scheduled' using errcode = 'P0002'; end if;
  if g.opens_at > p_now then
    raise exception 'week % opens on %', g.week, to_char(g.opens_at, 'Dy DD Mon HH24:MI "UTC"') using errcode = '55000';
  end if;

  v_box := public.franchise_sim(p_franchise, g.id);
  -- who it cost. Drawn after the game, from the game's own seed, and merged
  -- onto the box so the result says who left and for how long.
  v_box := v_box || jsonb_build_object('injuries', public.franchise_draw_injuries(p_franchise, g.seed, g.week_key, p_now));
  pf := (v_box->'final'->>'for')::int; pa := (v_box->'final'->>'against')::int; res := v_box->>'result';
  update public.franchise_games
     set status = 'final', played_at = p_now, score_for = pf, score_against = pa, result = res, box = v_box, sim_version = v_box->>'sim'
   where id = g.id;
  for ln in select * from jsonb_array_elements(v_box->'players') loop
    update public.game_players
       set season_stats = public.games_jsonb_sum(season_stats, ln->'stats'),
           career_stats = public.games_jsonb_sum(career_stats, ln->'stats'),
           updated_at = p_now
     where id = (ln->>'id')::uuid and franchise_id = p_franchise;
  end loop;
  update public.franchise_seasons
     set week = g.week, wins = wins + (res = 'W')::int, losses = losses + (res = 'L')::int, ties = ties + (res = 'T')::int,
         points_for = points_for + pf, points_against = points_against + pa
   where franchise_id = p_franchise and number = s.number returning * into s;

  -- WHERE THIS PUTS YOU IN THE LEAGUE (league_v1). Results move the standing
  -- and nothing else does: beating a club above you is worth several points,
  -- beating one well below is worth almost nothing, and the rival counts
  -- double. The standing is what next season's slate is drawn around.
  v_move := public.franchise_standing_delta(res, f.standing,
              coalesce((g.opponent->>'overall')::int,
                       (select strength from public.franchise_opponents where key = g.opponent_key)),
              g.rival);
  if v_move <> 0 then
    update public.franchises
       set standing = greatest((public.franchise_league()->>'standing_min')::int,
                        least((public.franchise_league()->>'standing_max')::int, standing + v_move)),
           updated_at = p_now
     where id = p_franchise returning standing into v_standing;
  else
    v_standing := f.standing;
  end if;

  v_key := s.number || ':' || g.week;
  -- the bowl pays its own line; everything else about it is an ordinary game
  v_kind := case when g.bowl then 'bowl_game' else 'weekly_game' end;
  v_kind_win := case when g.bowl then 'bowl_win' else 'weekly_win' end;
  v_label := case when g.bowl
    then coalesce(g.opponent->>'bowl_name', 'The bowl') || ' vs ' || (g.opponent->>'name') || ': ' || res || ' ' || pf || '–' || pa
    else 'Week ' || g.week || ' ' || (case when g.home then 'vs ' else 'at ' end) || (g.opponent->>'name') || ': ' || res || ' ' || pf || '–' || pa end;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
  values (p_franchise, 'weekly_game', v_key, g.week_key, public.games_day_key(p_now),
    jsonb_build_object('game_id', g.id, 'season_number', s.number, 'week', g.week, 'result', res, 'for', pf, 'against', pa,
      'opponent', g.opponent->>'name', 'rival', g.rival, 'preparation', v_box->'edges'->'prep'->'preparation'), p_now);
  if public.franchise_credit(p_franchise, 'xp', (econ->v_kind->>'xp')::int, v_kind, v_key, v_label) then
    v_xp := v_xp + (econ->v_kind->>'xp')::int; end if;
  if public.franchise_credit(p_franchise, 'tc', (econ->v_kind->>'tc')::int, v_kind, v_key, v_label) then
    v_tc := v_tc + (econ->v_kind->>'tc')::int; end if;

  if res = 'W' then
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
    values (p_franchise, 'weekly_win', v_key, g.week_key, public.games_day_key(p_now),
      jsonb_build_object('game_id', g.id, 'season_number', s.number, 'week', g.week, 'rival', g.rival), p_now);
    if public.franchise_credit(p_franchise, 'xp', (econ->v_kind_win->>'xp')::int, v_kind_win, v_key, v_label) then
      v_xp := v_xp + (econ->v_kind_win->>'xp')::int; end if;
    if public.franchise_credit(p_franchise, 'tc', (econ->v_kind_win->>'tc')::int, v_kind_win, v_key, v_label) then
      v_tc := v_tc + (econ->v_kind_win->>'tc')::int; end if;
    if public.franchise_credit(p_franchise, 'cp', (econ->v_kind_win->>'cp')::int, v_kind_win, v_key, v_label) then
      v_cp := v_cp + (econ->v_kind_win->>'cp')::int; end if;
    if public.franchise_award(p_franchise, 'first_win', s.season, jsonb_build_object('game_id', g.id)) then v_new := array_append(v_new, 'first_win'); end if;
    if g.bowl and public.franchise_award(p_franchise, 'bowl_win', s.season,
         jsonb_build_object('game_id', g.id, 'season_number', s.number, 'bowl', g.opponent->>'bowl_name')) then
      v_new := array_append(v_new, 'bowl_win'); end if;
    -- won it short-handed: a starter was unavailable when the game was played
    if exists (select 1 from public.game_players p
                where p.franchise_id = p_franchise and p.status = 'active'
                  and not public.franchise_is_available(p.status, p.injured_until, p_now)
                  and p.depth <= coalesce((select (x->>'starters')::int from jsonb_array_elements(public.franchise_pool_plan()) x
                                            where x->>'pos' = p.position), 1))
       and public.franchise_award(p_franchise, 'next_man_up', s.season, jsonb_build_object('game_id', g.id)) then
      v_new := array_append(v_new, 'next_man_up'); end if;
    if g.rival then
      if public.franchise_credit(p_franchise, 'xp', (econ->'rival_win'->>'xp')::int, 'rival_win', v_key, 'Beat the ' || (g.opponent->>'name')) then
        v_xp := v_xp + (econ->'rival_win'->>'xp')::int; end if;
      if public.franchise_credit(p_franchise, 'cp', (econ->'rival_win'->>'cp')::int, 'rival_win', v_key, 'Beat the ' || (g.opponent->>'name')) then
        v_cp := v_cp + (econ->'rival_win'->>'cp')::int; end if;
      if public.franchise_award(p_franchise, 'bragging_rights', s.season, jsonb_build_object('game_id', g.id)) then v_new := array_append(v_new, 'bragging_rights'); end if;
    end if;
    if pa = 0 and public.franchise_award(p_franchise, 'shutout', s.season, jsonb_build_object('game_id', g.id)) then v_new := array_append(v_new, 'shutout'); end if;
  end if;

  -- THE EIGHTH GAME either ends the season or earns the ninth. A record with
  -- more wins than losses draws a bowl a week later; anything else is done.
  if g.week >= s.weeks and not g.bowl and public.franchise_bowl_earned(s.wins, s.losses) then
    v_bowl := public.franchise_schedule_bowl(p_franchise, s.number, p_now);
    if v_bowl is not null then
      select * into s from public.franchise_seasons where franchise_id = p_franchise and number = s.number;
    end if;
  end if;

  if (g.week >= s.weeks and v_bowl is null) or g.bowl then
    v_done := true;
    update public.franchise_seasons set status = 'complete', completed_at = p_now
     where franchise_id = p_franchise and number = s.number returning * into s;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
    values (p_franchise, 'season_complete', s.number::text, g.week_key, public.games_day_key(p_now),
      jsonb_build_object('season_number', s.number, 'wins', s.wins, 'losses', s.losses, 'ties', s.ties,
        'points_for', s.points_for, 'points_against', s.points_against), p_now);
    if public.franchise_credit(p_franchise, 'xp', (econ->'season_complete'->>'xp')::int, 'season_complete', s.number::text, s.label || ' complete: ' || s.wins || '–' || s.losses || (case when s.ties > 0 then '–' || s.ties else '' end)) then
      v_xp := v_xp + (econ->'season_complete'->>'xp')::int; end if;
    if public.franchise_credit(p_franchise, 'tc', (econ->'season_complete'->>'tc')::int, 'season_complete', s.number::text, s.label || ' complete') then
      v_tc := v_tc + (econ->'season_complete'->>'tc')::int; end if;
    if public.franchise_award(p_franchise, 'first_season', s.season, jsonb_build_object('season_number', s.number)) then v_new := array_append(v_new, 'first_season'); end if;
    if s.wins > s.losses and public.franchise_award(p_franchise, 'winning_season', s.season, jsonb_build_object('season_number', s.number, 'record', s.wins || '-' || s.losses)) then v_new := array_append(v_new, 'winning_season'); end if;
    if s.losses = 0 and s.ties = 0 and public.franchise_award(p_franchise, 'perfect_season', s.season, jsonb_build_object('season_number', s.number)) then v_new := array_append(v_new, 'perfect_season'); end if;
  end if;

  return jsonb_build_object('ok', true, 'already', false,
    'game', public.franchise_game_json(g.id, true),
    'season', public.franchise_season_json(p_franchise, s.number),
    'season_complete', v_done,
    'bowl', case when v_bowl is not null then public.franchise_game_json(v_bowl, false) end,
    'injuries', coalesce(v_box->'injuries', '[]'::jsonb),
    'standing', jsonb_build_object('was', f.standing, 'now', v_standing, 'move', v_move),
    'rewards', jsonb_build_object('xp', v_xp, 'tc', v_tc, 'cp', v_cp),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(p_franchise));
end;
$$;

commit;

-- ===========================================================================
-- FRANCHISE VS FRANCHISE — the challenge, the rivalry, the ladder
--
-- The same simulator, two real rosters. A challenge is an invite link; the
-- franchise that opens it plays it at once, on the server, on a neutral
-- field, with each side's own scheme, traits and this week's preparation.
-- Both franchises are paid by the table, keyed once by the challenge;
-- both careers grow by the box; the rivalry record between the two moves;
-- and both move on the ladder by ordinary Elo (K = 24, from 1500). A
-- client sends a token and nothing else.
--
-- The ladder lists franchises — a name, a city, a mark, a record — and
-- never an account. A franchise appears on it only once it has played a
-- challenge; founding alone puts nobody on a public list.
-- ===========================================================================

begin;

-- A franchise as another player may see it: identity, strength, record.
-- No account, no secret, no resources.
create or replace function public.franchise_identity_json(p_franchise uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
    'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season,
    'overall', (public.franchise_team_rating(f.id)->>'overall')::int,
    'level', public.games_level_for(f.xp),
    'ladder_rating', f.ladder_rating, 'ladder_games', f.ladder_games,
    'record', (select jsonb_build_object('wins', coalesce(sum(s.wins), 0), 'losses', coalesce(sum(s.losses), 0), 'ties', coalesce(sum(s.ties), 0))
                 from public.franchise_seasons s where s.franchise_id = f.id),
    'fc_record', (select jsonb_build_object('wins', coalesce(sum(r.fc_wins), 0), 'losses', coalesce(sum(r.fc_losses), 0), 'ties', coalesce(sum(r.fc_ties), 0))
                    from public.franchise_rivalries r where r.franchise_id = f.id))
  from public.franchises f where f.id = p_franchise;
$$;

-- The rank of a franchise on the ladder, or null until it has played.
create or replace function public.franchise_ladder_rank(p_franchise uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select case when f.ladder_games = 0 then null
         else (select count(*) + 1 from public.franchises o
                where o.ladder_games > 0 and o.id <> f.id
                  and (o.ladder_rating > f.ladder_rating
                       or (o.ladder_rating = f.ladder_rating and (o.ladder_games > f.ladder_games
                            or (o.ladder_games = f.ladder_games and o.created_at < f.created_at)))))::int end
  from public.franchises f where f.id = p_franchise;
$$;

-- The rivalry record moves, both directions, once per game.
create or replace function public.franchise_rivalry_bump(p_a uuid, p_b uuid, p_kind text, p_result_a text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare rb text := case p_result_a when 'W' then 'L' when 'L' then 'W' else 'T' end;
begin
  if p_a is null or p_b is null or p_a = p_b then return; end if;
  insert into public.franchise_rivalries (franchise_id, other_id, last_played_at)
  values (p_a, p_b, now()), (p_b, p_a, now())
  on conflict (franchise_id, other_id) do update set last_played_at = now();
  update public.franchise_rivalries set
      fc_wins = fc_wins + (p_kind = 'fc' and p_result_a = 'W')::int,
      fc_losses = fc_losses + (p_kind = 'fc' and p_result_a = 'L')::int,
      fc_ties = fc_ties + (p_kind = 'fc' and p_result_a = 'T')::int,
      h2h_wins = h2h_wins + (p_kind = 'h2h' and p_result_a = 'W')::int,
      h2h_losses = h2h_losses + (p_kind = 'h2h' and p_result_a = 'L')::int,
      h2h_draws = h2h_draws + (p_kind = 'h2h' and p_result_a = 'T')::int
    where franchise_id = p_a and other_id = p_b;
  update public.franchise_rivalries set
      fc_wins = fc_wins + (p_kind = 'fc' and rb = 'W')::int,
      fc_losses = fc_losses + (p_kind = 'fc' and rb = 'L')::int,
      fc_ties = fc_ties + (p_kind = 'fc' and rb = 'T')::int,
      h2h_wins = h2h_wins + (p_kind = 'h2h' and rb = 'W')::int,
      h2h_losses = h2h_losses + (p_kind = 'h2h' and rb = 'L')::int,
      h2h_draws = h2h_draws + (p_kind = 'h2h' and rb = 'T')::int
    where franchise_id = p_b and other_id = p_a;
end;
$$;

-- A scoring play named for the side that scored it: the scorer drawn by
-- share, the distance drawn, the tally moved. Returns null for a drive
-- that did not score.
create or replace function public.franchise_sim_score_play(
  p_d jsonb, p_ps jsonb, p_passer jsonb, p_kicker jsonb, p_qb_share numeric, p_tally jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  rec_w numeric[] := array[0.30, 0.22, 0.14, 0.16, 0.12, 0.06]; rec_pos text[] := array['WR','WR','WR','TE','RB','WR'];
  rec_n integer[] := array[1, 2, 3, 1, 1, 4];
  r numeric; j integer; scorer jsonb; dist integer; desc_ text; tally jsonb := coalesce(p_tally, '{}'::jsonb);
begin
  if p_d->>'outcome' = 'td' then
    if (p_d->>'is_pass')::boolean then
      r := random(); scorer := null;
      for j in 1..array_length(rec_w, 1) loop
        r := r - rec_w[j];
        if r < 0 then scorer := public.franchise_nth(p_ps, rec_pos[j], rec_n[j]); exit; end if;
      end loop;
      if scorer is null then scorer := public.franchise_anybody(p_ps, 'WR', 1); end if;
      dist := 1 + floor(random() * 40)::int;
      desc_ := (p_passer->>'name') || ' to ' || (scorer->>'name') || ', ' || dist || '-yd TD pass';
      if scorer is not null then
        tally := tally || jsonb_build_object(scorer->>'id', public.games_jsonb_sum(tally->(scorer->>'id'), '{"rec_td":1}'::jsonb));
      end if;
      if p_passer is not null then
        tally := tally || jsonb_build_object(p_passer->>'id', public.games_jsonb_sum(tally->(p_passer->>'id'), '{"pass_td":1}'::jsonb));
      end if;
    else
      r := random();
      scorer := case when r < p_qb_share then p_passer
                     when r < p_qb_share + (1 - p_qb_share) * 0.8 then public.franchise_nth(p_ps, 'RB', 1)
                     else public.franchise_nth(p_ps, 'RB', 2) end;
      if scorer is null then scorer := public.franchise_anybody(p_ps, 'RB', 1); end if;
      dist := 1 + floor(random() * 25)::int;
      desc_ := (scorer->>'name') || ', ' || dist || '-yd TD run';
      if scorer is not null then
        tally := tally || jsonb_build_object(scorer->>'id', public.games_jsonb_sum(tally->(scorer->>'id'), '{"rush_td":1}'::jsonb));
      end if;
    end if;
    return jsonb_build_object('type', 'TD', 'pts', 7, 'desc', desc_, 'tally', tally);
  elsif p_d->>'outcome' = 'fg' then
    dist := 20 + floor(random() * 33)::int;
    return jsonb_build_object('type', 'FG', 'pts', 3, 'desc', coalesce(p_kicker->>'name', 'Field goal') || ', ' || dist || '-yd FG', 'tally', tally);
  end if;
  return null;
end;
$$;

-- THE VERSUS SIMULATOR. Two franchises, one seed, a neutral field. The
-- same drive model as the season (franchise_sim_drive), with each side's
-- own rating, scheme matchup, preparation and traits, and a line for every
-- starter on both sides. Writes nothing.
create or replace function public.franchise_sim_versus(p_a uuid, p_b uuid, p_seed text, p_week_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  fa public.franchises%rowtype; fb public.franchises%rowtype;
  rta jsonb; rtb jsonb; prepa jsonb; prepb jsonb; tra jsonb; trb jsonb; psa jsonb; psb jsonb; sta jsonb; stb jsonb;
  a_off numeric; a_def numeric; a_st numeric; b_off numeric; b_def numeric; b_st numeric;
  a_prep numeric; b_prep numeric; a_sch numeric; b_sch numeric;
  a_late_off numeric; a_late_def numeric; b_late_off numeric; b_late_def numeric;
  a_pass numeric; b_pass numeric; a_qb numeric; b_qb numeric;
  a_passer jsonb; b_passer jsonb; a_kicker jsonb; b_kicker jsonb;
  n integer; i integer; k integer; q integer; d jsonb; who text; ot boolean := false; rnd integer := 0; short boolean;
  give boolean := false;   -- a giveaway is the other side's short field
  clk jsonb; total_secs integer; secs_left integer; v_secs integer; v_tempo numeric; v_left integer; v_call text;
  pts_a integer := 0; pts_b integer := 0; q_a integer[] := '{0,0,0,0,0}'; q_b integer[] := '{0,0,0,0,0}';
  scoring jsonb := '[]'::jsonb; tot_a jsonb := '{}'::jsonb; tot_b jsonb := '{}'::jsonb; a_first boolean;
  tally_a jsonb := '{}'::jsonb; tally_b jsonb := '{}'::jsonb; play jsonb;
  players_a jsonb; players_b jsonb; potg_a jsonb; potg_b jsonb; result_a text;
  a_film numeric; b_film numeric; a_cond numeric; b_cond numeric;
begin
  select * into fa from public.franchises where id = p_a;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into fb from public.franchises where id = p_b;
  if not found then raise exception 'no opponent' using errcode = '22023'; end if;
  perform setseed(public.franchise_seed_float(p_seed));

  rta := public.franchise_team_rating(p_a); rtb := public.franchise_team_rating(p_b);
  prepa := public.franchise_prep(p_a, p_week_key); prepb := public.franchise_prep(p_b, p_week_key);
  tra := public.franchise_trait_effects(p_a); trb := public.franchise_trait_effects(p_b);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
      'jersey', p.jersey, 'depth', p.depth, 'overall', p.overall, 'ratings', p.ratings) order by p.depth, p.overall desc), '[]'::jsonb)
    into psa from public.game_players p
   where p.franchise_id = p_a and public.franchise_is_available(p.status, p.injured_until);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
      'jersey', p.jersey, 'depth', p.depth, 'overall', p.overall, 'ratings', p.ratings) order by p.depth, p.overall desc), '[]'::jsonb)
    into psb from public.game_players p
   where p.franchise_id = p_b and public.franchise_is_available(p.status, p.injured_until);

  a_prep := round((least(100, (prepa->>'preparation')::numeric + 2 * (tra->>'preparation')::numeric) - 50) / 50.0 * 3, 2);
  b_prep := round((least(100, (prepb->>'preparation')::numeric + 2 * (trb->>'preparation')::numeric) - 50) / 50.0 * 3, 2);
  a_sch := public.franchise_scheme_edge(fa.offense, fb.defense);
  b_sch := public.franchise_scheme_edge(fb.offense, fa.defense);
  a_film := 0.5 * coalesce((fa.facilities->>'film')::numeric, 0); b_film := 0.5 * coalesce((fb.facilities->>'film')::numeric, 0);
  a_cond := 0.5 * coalesce((fa.facilities->>'conditioning')::numeric, 0); b_cond := 0.5 * coalesce((fb.facilities->>'conditioning')::numeric, 0);
  -- each side's own coaching staff (Phase 8)
  sta := public.franchise_staff_effects(p_a); stb := public.franchise_staff_effects(p_b);
  a_off := (rta->>'offense')::numeric + a_prep + a_sch + a_film + 0.25 * (tra->>'offense')::numeric + (sta->>'offense')::numeric;
  a_def := (rta->>'defense')::numeric + a_prep + a_film + 0.25 * (tra->>'defense')::numeric + (sta->>'defense')::numeric;
  a_st := (rta->>'special')::numeric;
  b_off := (rtb->>'offense')::numeric + b_prep + b_sch + b_film + 0.25 * (trb->>'offense')::numeric + (stb->>'offense')::numeric;
  b_def := (rtb->>'defense')::numeric + b_prep + b_film + 0.25 * (trb->>'defense')::numeric + (stb->>'defense')::numeric;
  b_st := (rtb->>'special')::numeric;
  a_late_off := a_cond + 0.5 * (tra->>'late_offense')::numeric + (sta->>'late_offense')::numeric;
  a_late_def := a_cond + 0.5 * (tra->>'late_defense')::numeric + (sta->>'late_defense')::numeric;
  b_late_off := b_cond + 0.5 * (trb->>'late_offense')::numeric + (stb->>'late_offense')::numeric;
  b_late_def := b_cond + 0.5 * (trb->>'late_defense')::numeric + (stb->>'late_defense')::numeric;
  a_pass := public.franchise_pass_share(fa.offense); b_pass := public.franchise_pass_share(fb.offense);
  a_qb := public.franchise_qb_rush_share(fa.offense); b_qb := public.franchise_qb_rush_share(fb.offense);
  a_passer := public.franchise_anybody(psa, 'QB', 1); a_kicker := public.franchise_anybody(psa, 'K', 1);
  b_passer := public.franchise_anybody(psb, 'QB', 1); b_kicker := public.franchise_anybody(psb, 'K', 1);

  -- A CHALLENGE IS THE SAME FOOTBALL AS A SATURDAY, so it is played on the
  -- same clock (clock_v1) rather than a possession count of its own. Neither
  -- side is at a keyboard here, so both call from their own scheme and the
  -- situation they are in — which is what quick play is on a Saturday too.
  clk := public.franchise_clock();
  total_secs := (clk->>'quarters')::int * (clk->>'quarter_seconds')::int;
  secs_left := total_secs;
  a_first := random() < 0.5;
  n := 0; i := 0;

  while secs_left > 0 and i < 60 loop
    i := i + 1;
    q := least((clk->>'quarters')::int,
               1 + ((total_secs - secs_left) / (clk->>'quarter_seconds')::int));
    short := false;
    v_left := greatest(1, round(secs_left::numeric / ((clk->>'nominal_drive')::numeric * 2))::int);
    who := case when (i % 2 = 1) = a_first then 'a' else 'b' end;
    if true then
      if who = 'a' then
        v_call := public.franchise_ai_call(fa.offense, pts_a - pts_b, v_left);
        v_tempo := public.franchise_tempo(pts_a - pts_b, secs_left);
        d := public.franchise_sim_drive(a_off + case when q >= 4 then a_late_off else 0 end, b_def + case when q >= 4 then b_late_def else 0 end,
               a_st, a_pass, 0.01 * ((trb->>'takeaway')::numeric + (stb->>'takeaway')::numeric),
               case when q >= 4 then 0.02 * ((tra->>'clutch')::numeric + (sta->>'clutch')::numeric) else 0 end, short, v_call, 0, give, null, null, 0);
        give := d->>'outcome' = 'turnover';
        v_secs := public.franchise_drive_seconds((d->>'plays')::int,
                    coalesce(nullif((d->>'pass_plays')::numeric, 0) / nullif((d->>'plays')::numeric, 0), a_pass),
                    d->>'outcome', v_tempo);
        v_secs := least(v_secs, secs_left); secs_left := secs_left - v_secs; n := n + 1;
        pts_a := pts_a + (d->>'pts')::int; q_a[q] := q_a[q] + (d->>'pts')::int;
        tot_a := public.games_jsonb_sum(tot_a, public.franchise_drive_totals(d));
        play := public.franchise_sim_score_play(d, psa, a_passer, a_kicker, a_qb, tally_a);
        if play is not null then
          tally_a := play->'tally';
          scoring := scoring || jsonb_build_object('q', q, 'side', 'a', 'type', play->>'type', 'pts', play->'pts', 'desc', play->>'desc', 'a', pts_a, 'b', pts_b);
        end if;
      else
        v_call := public.franchise_ai_call(fb.offense, pts_b - pts_a, v_left);
        v_tempo := public.franchise_tempo(pts_b - pts_a, secs_left);
        d := public.franchise_sim_drive(b_off + case when q >= 4 then b_late_off else 0 end, a_def + case when q >= 4 then a_late_def else 0 end,
               b_st, b_pass, 0.01 * ((tra->>'takeaway')::numeric + (sta->>'takeaway')::numeric),
               case when q >= 4 then 0.02 * ((trb->>'clutch')::numeric + (stb->>'clutch')::numeric) else 0 end, short, v_call, 0, give, null);
        give := d->>'outcome' = 'turnover';
        v_secs := public.franchise_drive_seconds((d->>'plays')::int,
                    coalesce(nullif((d->>'pass_plays')::numeric, 0) / nullif((d->>'plays')::numeric, 0), b_pass),
                    d->>'outcome', v_tempo);
        v_secs := least(v_secs, secs_left); secs_left := secs_left - v_secs; n := n + 1;
        pts_b := pts_b + (d->>'pts')::int; q_b[q] := q_b[q] + (d->>'pts')::int;
        tot_b := public.games_jsonb_sum(tot_b, public.franchise_drive_totals(d));
        play := public.franchise_sim_score_play(d, psb, b_passer, b_kicker, b_qb, tally_b);
        if play is not null then
          tally_b := play->'tally';
          scoring := scoring || jsonb_build_object('q', q, 'side', 'b', 'type', play->>'type', 'pts', play->'pts', 'desc', play->>'desc', 'a', pts_a, 'b', pts_b);
        end if;
      end if;
    end if;
  end loop;

  -- overtime, on the same terms a Saturday gets
  if pts_a = pts_b then
    ot := true; q := (clk->>'quarters')::int + 1;
    for rnd in 1..(clk->>'ot_rounds')::int loop
      for k in 0..1 loop
        who := case when (k = 0) = a_first then 'a' else 'b' end;
        if who = 'a' then
          d := public.franchise_sim_drive(a_off + a_late_off, b_def + b_late_def, a_st, a_pass,
                 0.01 * ((trb->>'takeaway')::numeric + (stb->>'takeaway')::numeric),
                 0.02 * ((tra->>'clutch')::numeric + (sta->>'clutch')::numeric), true,
                 public.franchise_ai_call(fa.offense, pts_a - pts_b, 1), 0, give, null);
          give := d->>'outcome' = 'turnover';
          pts_a := pts_a + (d->>'pts')::int; q_a[q] := q_a[q] + (d->>'pts')::int;
          tot_a := public.games_jsonb_sum(tot_a, public.franchise_drive_totals(d));
          play := public.franchise_sim_score_play(d, psa, a_passer, a_kicker, a_qb, tally_a);
          if play is not null then
            tally_a := play->'tally';
            scoring := scoring || jsonb_build_object('q', q, 'side', 'a', 'type', play->>'type', 'pts', play->'pts', 'desc', play->>'desc', 'a', pts_a, 'b', pts_b);
          end if;
        else
          d := public.franchise_sim_drive(b_off + b_late_off, a_def + a_late_def, b_st, b_pass,
                 0.01 * ((tra->>'takeaway')::numeric + (sta->>'takeaway')::numeric),
                 0.02 * ((trb->>'clutch')::numeric + (stb->>'clutch')::numeric), true,
                 public.franchise_ai_call(fb.offense, pts_b - pts_a, 1), 0, give, null);
          give := d->>'outcome' = 'turnover';
          pts_b := pts_b + (d->>'pts')::int; q_b[q] := q_b[q] + (d->>'pts')::int;
          tot_b := public.games_jsonb_sum(tot_b, public.franchise_drive_totals(d));
          play := public.franchise_sim_score_play(d, psb, b_passer, b_kicker, b_qb, tally_b);
          if play is not null then
            tally_b := play->'tally';
            scoring := scoring || jsonb_build_object('q', q, 'side', 'b', 'type', play->>'type', 'pts', play->'pts', 'desc', play->>'desc', 'a', pts_a, 'b', pts_b);
          end if;
        end if;
      end loop;
      exit when pts_a <> pts_b;
    end loop;
  end if;

  result_a := case when pts_a > pts_b then 'W' when pts_a < pts_b then 'L' else 'T' end;
  players_a := public.franchise_sim_lines(psa, fa.offense, tot_a, tot_b, tally_a, tra);
  players_b := public.franchise_sim_lines(psb, fb.offense, tot_b, tot_a, tally_b, trb);
  select p into potg_a from jsonb_array_elements(players_a) p order by (p->>'impact')::numeric desc limit 1;
  select p into potg_b from jsonb_array_elements(players_b) p order by (p->>'impact')::numeric desc limit 1;

  return jsonb_build_object(
    'sim', 'sim_v4', 'seed', p_seed, 'neutral', true, 'week_key', p_week_key, 'ot', ot, 'possessions', n,
    'result_a', result_a, 'scoring', scoring,
    'a', jsonb_build_object('id', fa.id, 'final', pts_a, 'quarters', to_jsonb(q_a), 'team', tot_a, 'players', players_a, 'potg', potg_a,
      'edges', jsonb_build_object('prep', prepa, 'prep_adj', a_prep, 'scheme', a_sch, 'traits', tra, 'film', a_film, 'conditioning', a_cond, 'staff', sta, 'offense', round(a_off, 1), 'defense', round(a_def, 1))),
    'b', jsonb_build_object('id', fb.id, 'final', pts_b, 'quarters', to_jsonb(q_b), 'team', tot_b, 'players', players_b, 'potg', potg_b,
      'edges', jsonb_build_object('prep', prepb, 'prep_adj', b_prep, 'scheme', b_sch, 'traits', trb, 'film', b_film, 'conditioning', b_cond, 'staff', stb, 'offense', round(b_off, 1), 'defense', round(b_def, 1))));
end;
$$;

-- A challenge as ONE franchise reads it: me and them, the score from my
-- side, my lines and theirs. A non-participant (someone holding the link)
-- reads it from the challenger's side and never sees the token.
create or replace function public.franchise_challenge_json(p_id uuid, p_viewer uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.franchise_challenges%rowtype; v_you text; v_me uuid; v_them uuid; v_side text; v_mine jsonb; v_theirs jsonb;
  v_for integer; v_against integer; v_res text; v_scoring jsonb; v_delta integer;
begin
  select * into c from public.franchise_challenges where id = p_id;
  if not found then return null; end if;
  v_you := case when c.challenger_id = p_viewer then 'challenger' when c.opponent_id is not null and c.opponent_id = p_viewer then 'opponent' end;
  v_me := case when v_you = 'opponent' then c.opponent_id else c.challenger_id end;
  v_them := case when v_you = 'opponent' then c.challenger_id else c.opponent_id end;
  v_side := case when v_you = 'opponent' then 'b' else 'a' end;
  if c.status = 'FINAL' then
    v_mine := case when v_side = 'a' then c.box->'a' else c.box->'b' end;
    v_theirs := case when v_side = 'a' then c.box->'b' else c.box->'a' end;
    v_for := (v_mine->>'final')::int; v_against := (v_theirs->>'final')::int;
    v_res := case when v_for > v_against then 'W' when v_for < v_against then 'L' else 'T' end;
    v_delta := case when v_side = 'a' then c.rating_delta else -c.rating_delta end;
    select coalesce(jsonb_agg((p - 'a' - 'b') || jsonb_build_object(
        'side', case when p->>'side' = v_side then 'for' else 'against' end,
        'for', case when v_side = 'a' then p->'a' else p->'b' end,
        'against', case when v_side = 'a' then p->'b' else p->'a' end)), '[]'::jsonb)
      into v_scoring from jsonb_array_elements(c.box->'scoring') p;
  end if;
  return jsonb_build_object(
    'id', c.id, 'invite_token', case when v_you is not null then c.invite_token else null end,
    'status', c.status, 'note', c.note, 'created_at', c.created_at, 'expires_at', c.expires_at, 'played_at', c.played_at,
    'you', v_you, 'me', public.franchise_identity_json(v_me),
    'them', case when v_them is null then null else public.franchise_identity_json(v_them) end,
    'score_for', v_for, 'score_against', v_against, 'result', v_res, 'ot', coalesce((c.box->>'ot')::boolean, false),
    'rating_delta', v_delta, 'potg', v_mine->'potg', 'their_potg', v_theirs->'potg', 'sim_version', c.sim_version,
    'box', case when c.status = 'FINAL' then jsonb_build_object(
      'sim', c.box->>'sim', 'neutral', true, 'ot', coalesce((c.box->>'ot')::boolean, false),
      'final', jsonb_build_object('for', v_for, 'against', v_against),
      'quarters', jsonb_build_object('for', v_mine->'quarters', 'against', v_theirs->'quarters', 'ot', coalesce((c.box->>'ot')::boolean, false)),
      'scoring', v_scoring,
      'team', jsonb_build_object('for', v_mine->'team', 'against', v_theirs->'team'),
      'players', v_mine->'players', 'their_players', v_theirs->'players',
      'potg', v_mine->'potg', 'their_potg', v_theirs->'potg',
      'edges', jsonb_build_object('mine', v_mine->'edges', 'theirs', v_theirs->'edges', 'possessions', c.box->'possessions'))
      else null end);
end;
$$;

-- CHALLENGE. One invite link; up to ten open at once; fourteen days.
create or replace function public.franchise_challenge_create(p_note text default null, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_id uuid; v_token text; v_exp timestamptz;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  if (select count(*) from public.franchise_challenges where challenger_id = v_f and status = 'OPEN' and expires_at > now()) >= 10 then
    raise exception 'you already have ten open challenges' using errcode = '55000';
  end if;
  insert into public.franchise_challenges (challenger_id, note)
  values (v_f, nullif(public.franchise_clean(p_note, 80), ''))
  returning id, invite_token, expires_at into v_id, v_token, v_exp;
  return jsonb_build_object('ok', true, 'id', v_id, 'invite_token', v_token, 'expires_at', v_exp, 'status', 'OPEN',
    'challenger', public.franchise_identity_json(v_f));
end;
$$;

-- PEEK at a challenge by its link: who is calling you out, and whether you
-- can answer. Open to anyone holding the link, franchise or not — the
-- landing must work before a franchise exists.
create or replace function public.franchise_challenge_peek(p_token text, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); c public.franchise_challenges%rowtype; v jsonb; v_status text;
begin
  select * into c from public.franchise_challenges where invite_token = p_token;
  if not found then return null; end if;
  v_status := case when c.status = 'OPEN' and c.expires_at <= now() then 'EXPIRED' else c.status end;
  v := public.franchise_challenge_json(c.id, v_f);
  return v || jsonb_build_object('status', v_status,
    'can_accept', v_status = 'OPEN' and v_f is not null and v_f <> c.challenger_id,
    'needs_franchise', v_f is null,
    'is_challenger', v_f is not null and v_f = c.challenger_id);
end;
$$;

-- ACCEPT, AND PLAY. The whole game, on the server, in one statement: both
-- rows locked, the versus simulator run on a seed the server derives, the
-- result written, both careers grown, the rivalry moved, both ladder
-- ratings moved, both ledgers credited by the table and keyed by the
-- challenge. Returns the game from the acceptor's side and what THEY were
-- paid; the challenger finds theirs on the ledger and in their list.
create or replace function public.franchise_challenge_accept(p_token text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); c public.franchise_challenges%rowtype; econ jsonb := public.franchise_economy();
  v_seed text; v_wk text := public.games_week_key(now()); v_box jsonb; pts_a integer; pts_b integer; res_a text;
  ra integer; rb integer; da integer; db integer; ln jsonb; v_new text[] := '{}'; v_xp integer := 0; v_tc integer := 0; v_cp integer := 0;
  side record; v_label text; v_season integer := public.games_season_of(now()); v_streak integer; v_ovr_a integer; v_ovr_b integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into c from public.franchise_challenges where invite_token = p_token for update;
  if not found then raise exception 'no such challenge' using errcode = 'P0002'; end if;
  if c.challenger_id = v_f then raise exception 'you cannot accept your own challenge' using errcode = '22023'; end if;
  if c.status <> 'OPEN' then raise exception 'this challenge has already been played' using errcode = '55000'; end if;
  if c.expires_at <= now() then
    update public.franchise_challenges set status = 'EXPIRED' where id = c.id;
    raise exception 'this challenge has expired' using errcode = '55000';
  end if;
  -- both franchise rows, in id order, so two accepts cannot deadlock
  perform 1 from public.franchises where id in (c.challenger_id, v_f) order by id for update;
  select ladder_rating, (public.franchise_team_rating(id)->>'overall')::int into ra, v_ovr_a from public.franchises where id = c.challenger_id;
  select ladder_rating, (public.franchise_team_rating(id)->>'overall')::int into rb, v_ovr_b from public.franchises where id = v_f;

  v_seed := md5(c.id::text || ':' || clock_timestamp()::text);
  v_box := public.franchise_sim_versus(c.challenger_id, v_f, v_seed, v_wk);
  -- what it cost each side, on the same terms a season game costs
  v_box := jsonb_set(v_box, '{a,injuries}', public.franchise_draw_injuries(c.challenger_id, v_seed, v_wk, now()));
  v_box := jsonb_set(v_box, '{b,injuries}', public.franchise_draw_injuries(v_f, v_seed, v_wk, now()));
  pts_a := (v_box->'a'->>'final')::int; pts_b := (v_box->'b'->>'final')::int; res_a := v_box->>'result_a';
  da := public.games_elo_delta(ra, rb, case res_a when 'W' then 1 when 'L' then 0 else 0.5 end, 24);
  db := public.games_elo_delta(rb, ra, case res_a when 'W' then 0 when 'L' then 1 else 0.5 end, 24);

  update public.franchise_challenges
     set opponent_id = v_f, status = 'FINAL', played_at = clock_timestamp(), week_key = v_wk, seed = v_seed,
         score_challenger = pts_a, score_opponent = pts_b, result = res_a, box = v_box, sim_version = v_box->>'sim', rating_delta = da
   where id = c.id;
  update public.franchises set ladder_rating = ladder_rating + da, ladder_games = ladder_games + 1, updated_at = now() where id = c.challenger_id;
  update public.franchises set ladder_rating = ladder_rating + db, ladder_games = ladder_games + 1, updated_at = now() where id = v_f;
  perform public.franchise_rivalry_bump(c.challenger_id, v_f, 'fc', res_a);

  -- careers grow by the box, on both sides; the season lines do not — an
  -- exhibition is not a season game
  for ln in select * from jsonb_array_elements(v_box->'a'->'players') loop
    update public.game_players set career_stats = public.games_jsonb_sum(career_stats, ln->'stats'), updated_at = now()
     where id = (ln->>'id')::uuid and franchise_id = c.challenger_id;
  end loop;
  for ln in select * from jsonb_array_elements(v_box->'b'->'players') loop
    update public.game_players set career_stats = public.games_jsonb_sum(career_stats, ln->'stats'), updated_at = now()
     where id = (ln->>'id')::uuid and franchise_id = v_f;
  end loop;

  -- both sides paid by the table, keyed by the challenge
  for side in
    select c.challenger_id as fid, res_a as res, pts_a as pf, pts_b as pa, v_ovr_a as mine, v_ovr_b as theirs,
           (select name from public.franchises where id = v_f) as opp
    union all
    select v_f, case res_a when 'W' then 'L' when 'L' then 'W' else 'T' end, pts_b, pts_a, v_ovr_b, v_ovr_a,
           (select name from public.franchises where id = c.challenger_id)
  loop
    v_label := 'Challenge vs ' || side.opp || ': ' || side.res || ' ' || side.pf || '–' || side.pa;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
    values (side.fid, 'fc_played', c.id::text, v_wk, public.games_day_key(now()),
      jsonb_build_object('challenge', c.id, 'result', side.res, 'for', side.pf, 'against', side.pa, 'opponent', side.opp))
    on conflict (franchise_id, kind, key) do nothing;
    if public.franchise_credit(side.fid, 'xp', (econ->'fc_played'->>'xp')::int, 'fc_played', c.id::text, v_label) and side.fid = v_f then v_xp := v_xp + (econ->'fc_played'->>'xp')::int; end if;
    if public.franchise_credit(side.fid, 'tc', (econ->'fc_played'->>'tc')::int, 'fc_played', c.id::text, v_label) and side.fid = v_f then v_tc := v_tc + (econ->'fc_played'->>'tc')::int; end if;
    if public.franchise_award(side.fid, 'fc_first', v_season, jsonb_build_object('challenge', c.id)) and side.fid = v_f then v_new := array_append(v_new, 'fc_first'); end if;
    if side.res = 'W' then
      insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
      values (side.fid, 'fc_win', c.id::text, v_wk, public.games_day_key(now()), jsonb_build_object('challenge', c.id, 'opponent', side.opp))
      on conflict (franchise_id, kind, key) do nothing;
      if public.franchise_credit(side.fid, 'xp', (econ->'fc_win'->>'xp')::int, 'fc_win', c.id::text, v_label) and side.fid = v_f then v_xp := v_xp + (econ->'fc_win'->>'xp')::int; end if;
      if public.franchise_credit(side.fid, 'tc', (econ->'fc_win'->>'tc')::int, 'fc_win', c.id::text, v_label) and side.fid = v_f then v_tc := v_tc + (econ->'fc_win'->>'tc')::int; end if;
      if public.franchise_credit(side.fid, 'cp', (econ->'fc_win'->>'cp')::int, 'fc_win', c.id::text, v_label) and side.fid = v_f then v_cp := v_cp + (econ->'fc_win'->>'cp')::int; end if;
      if public.franchise_award(side.fid, 'fc_first_win', v_season, jsonb_build_object('challenge', c.id)) and side.fid = v_f then v_new := array_append(v_new, 'fc_first_win'); end if;
      if side.theirs >= side.mine + 5 then
        if public.franchise_credit(side.fid, 'xp', (econ->'fc_upset'->>'xp')::int, 'fc_upset', c.id::text, 'Upset: beat a ' || side.theirs || ' with a ' || side.mine) and side.fid = v_f then v_xp := v_xp + (econ->'fc_upset'->>'xp')::int; end if;
        if public.franchise_credit(side.fid, 'cp', (econ->'fc_upset'->>'cp')::int, 'fc_upset', c.id::text, 'Upset: beat a ' || side.theirs || ' with a ' || side.mine) and side.fid = v_f then v_cp := v_cp + (econ->'fc_upset'->>'cp')::int; end if;
        if public.franchise_award(side.fid, 'fc_upset', v_season, jsonb_build_object('challenge', c.id, 'theirs', side.theirs, 'mine', side.mine)) and side.fid = v_f then v_new := array_append(v_new, 'fc_upset'); end if;
      end if;
      -- three straight: the last three challenges this franchise played, all won
      select count(*) into v_streak from (
        select case when x.challenger_id = side.fid then x.result else (case x.result when 'W' then 'L' when 'L' then 'W' else 'T' end) end as r
          from public.franchise_challenges x
         where x.status = 'FINAL' and (x.challenger_id = side.fid or x.opponent_id = side.fid)
         order by x.played_at desc limit 3) s where s.r = 'W';
      if v_streak >= 3 and public.franchise_award(side.fid, 'fc_three', v_season, jsonb_build_object('challenge', c.id)) and side.fid = v_f then v_new := array_append(v_new, 'fc_three'); end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'game', public.franchise_challenge_json(c.id, v_f),
    'rewards', jsonb_build_object('xp', v_xp, 'tc', v_tc, 'cp', v_cp),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- CANCEL an open invite of yours.
create or replace function public.franchise_challenge_cancel(p_id uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); n integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  update public.franchise_challenges set status = 'CANCELLED' where id = p_id and challenger_id = v_f and status = 'OPEN';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'cancelled', n > 0);
end;
$$;

-- MY CHALLENGES: the invites I have out, the games played, the rivalries,
-- and where I stand on the ladder.
create or replace function public.franchise_challenges_mine(p_limit integer default 20, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_open jsonb; v_played jsonb; v_riv jsonb; v_rec jsonb; f public.franchises%rowtype;
begin
  if v_f is null then return null; end if;
  select * into f from public.franchises where id = v_f;
  select coalesce(jsonb_agg(public.franchise_challenge_json(c.id, v_f) order by c.created_at desc), '[]'::jsonb) into v_open
    from public.franchise_challenges c where c.challenger_id = v_f and c.status = 'OPEN' and c.expires_at > now();
  select coalesce(jsonb_agg(j order by (j->>'played_at') desc), '[]'::jsonb) into v_played
    from (select public.franchise_challenge_json(c.id, v_f) - 'box' as j from public.franchise_challenges c
           where (c.challenger_id = v_f or c.opponent_id = v_f) and c.status = 'FINAL'
           order by c.played_at desc limit greatest(1, least(coalesce(p_limit, 20), 100))) s;
  select coalesce(jsonb_agg(jsonb_build_object('other', public.franchise_identity_json(r.other_id),
      'fc_wins', r.fc_wins, 'fc_losses', r.fc_losses, 'fc_ties', r.fc_ties,
      'h2h_wins', r.h2h_wins, 'h2h_losses', r.h2h_losses, 'h2h_draws', r.h2h_draws, 'last_played_at', r.last_played_at)
      order by (r.fc_wins + r.fc_losses + r.fc_ties + r.h2h_wins + r.h2h_losses + r.h2h_draws) desc, r.last_played_at desc), '[]'::jsonb)
    into v_riv from (select * from public.franchise_rivalries where franchise_id = v_f
                      order by (fc_wins + fc_losses + fc_ties + h2h_wins + h2h_losses + h2h_draws) desc, last_played_at desc limit 12) r;
  select jsonb_build_object('wins', coalesce(sum(fc_wins), 0), 'losses', coalesce(sum(fc_losses), 0), 'ties', coalesce(sum(fc_ties), 0),
      'h2h_wins', coalesce(sum(h2h_wins), 0), 'h2h_losses', coalesce(sum(h2h_losses), 0), 'h2h_draws', coalesce(sum(h2h_draws), 0))
    into v_rec from public.franchise_rivalries where franchise_id = v_f;
  return jsonb_build_object('me', public.franchise_identity_json(v_f), 'open', v_open, 'played', v_played, 'rivalries', v_riv, 'record', v_rec,
    'ladder', jsonb_build_object('rating', f.ladder_rating, 'games', f.ladder_games, 'rank', public.franchise_ladder_rank(v_f)));
end;
$$;

-- THE LADDER. Franchises that have played a challenge, best first: a name,
-- a mark, a record, a rating. No accounts, no emails, no ids a client
-- could use for anything. Open to read.
create or replace function public.franchise_ladder(p_limit integer default 25, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_rows jsonb; v_total integer; f public.franchises%rowtype;
begin
  select coalesce(jsonb_agg(jsonb_build_object('rank', s.rn, 'name', s.name, 'city', s.city, 'abbr', s.abbr, 'logo', s.logo, 'theme', s.theme,
      'overall', (public.franchise_team_rating(s.id)->>'overall')::int, 'ladder_rating', s.ladder_rating, 'ladder_games', s.ladder_games,
      'fc_record', (select jsonb_build_object('wins', coalesce(sum(r.fc_wins), 0), 'losses', coalesce(sum(r.fc_losses), 0), 'ties', coalesce(sum(r.fc_ties), 0))
                      from public.franchise_rivalries r where r.franchise_id = s.id),
      'is_you', s.id = v_f) order by s.rn), '[]'::jsonb)
    into v_rows
    from (select o.*, row_number() over (order by o.ladder_rating desc, o.ladder_games desc, o.created_at) as rn
            from public.franchises o where o.ladder_games > 0
           order by o.ladder_rating desc, o.ladder_games desc, o.created_at
           limit greatest(1, least(coalesce(p_limit, 25), 100))) s;
  select count(*) into v_total from public.franchises where ladder_games > 0;
  if v_f is not null then select * into f from public.franchises where id = v_f; end if;
  return jsonb_build_object('rows', v_rows, 'total', v_total,
    'me', case when v_f is null then null else jsonb_build_object('rating', f.ladder_rating, 'games', f.ladder_games, 'rank', public.franchise_ladder_rank(v_f)) end);
end;
$$;

-- FRANCHISE CONTEXT FOR A REAL-GAME HEAD-TO-HEAD: the two entries'
-- franchises, if they have them, and the rivalry between them. Read by the
-- Head-to-Head page next to the names; the settlement itself is untouched.
create or replace function public.franchise_h2h_context(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_a uuid; v_b uuid; e record; v_riv jsonb;
begin
  select id into v_id from public.game_challenges where invite_token = p_token;
  if v_id is null then return null; end if;
  for e in select * from public.game_challenge_entries where challenge_id = v_id loop
    if e.player_slot = 'a' then
      select id into v_a from public.franchises where (e.user_id is not null and user_id = e.user_id)
        or (e.anon_hash is not null and (anon_hash = e.anon_hash or claimed_hash = e.anon_hash)) limit 1;
    else
      select id into v_b from public.franchises where (e.user_id is not null and user_id = e.user_id)
        or (e.anon_hash is not null and (anon_hash = e.anon_hash or claimed_hash = e.anon_hash)) limit 1;
    end if;
  end loop;
  if v_a is not null and v_b is not null then
    select jsonb_build_object('fc_wins', r.fc_wins, 'fc_losses', r.fc_losses, 'fc_ties', r.fc_ties,
        'h2h_wins', r.h2h_wins, 'h2h_losses', r.h2h_losses, 'h2h_draws', r.h2h_draws)
      into v_riv from public.franchise_rivalries r where r.franchise_id = v_a and r.other_id = v_b;
  end if;
  return jsonb_build_object('a', case when v_a is null then null else public.franchise_identity_json(v_a) end,
                            'b', case when v_b is null then null else public.franchise_identity_json(v_b) end,
                            'rivalry_a', v_riv);
end;
$$;

commit;

begin;

commit;

-- ===========================================================================
-- THE OFFSEASON AND THE FACILITIES — Phase 4
--
-- A season ends; before the next one is scheduled the offseason runs, on
-- the server, seeded from the franchise seed and the season number: every
-- player ages a year and moves by his development tier, his age, the games
-- he played and the Training Center's level; nobody grows past his
-- potential; the old decline; a player of 35 (or 33 and below 55) retires,
-- keeps his card and his career line, and a rookie is signed at his
-- position from the same pools the founding roster came from. The report
-- is written once, on the completed season.
--
-- Facilities are the first thing resources are spent on. The table of
-- costs and effects is published once here and mirrored in the client; an
-- upgrade is one negative ledger row, keyed by facility and level, so a
-- replayed request cannot debit twice. Nothing here can be bought with
-- money: the only currencies are the earned ones.
-- ===========================================================================

begin;

-- THE FACILITIES TABLE, facilities_v1. Costs per level, and the effect the
-- simulator or the offseason applies per level.
create or replace function public.franchise_facilities()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'facilities_v1',
    'training',     jsonb_build_object('name', 'Training Center', 'currency', 'tc', 'costs', jsonb_build_array(300, 600, 1000), 'per_level', 1,
                      'effect', '+1 development a level for players 26 and under, each offseason; veterans fade slower at levels 2 and 3'),
    'film',         jsonb_build_object('name', 'Film Room', 'currency', 'cp', 'costs', jsonb_build_array(6, 12, 20), 'per_level', 0.5,
                      'effect', '+0.5 offense and defense in every game'),
    'conditioning', jsonb_build_object('name', 'Conditioning', 'currency', 'tc', 'costs', jsonb_build_array(300, 600, 1000), 'per_level', 0.5,
                      'effect', '+0.5 in the fourth quarter and overtime'),
    'stadium',      jsonb_build_object('name', 'Stadium', 'currency', 'cp', 'costs', jsonb_build_array(6, 12, 20), 'per_level', 0.25,
                      'effect', '+0.25 home field in season games'));
$$;

-- ONE ROOKIE, at a position, from the same pools as the founding roster,
-- seeded so the same offseason signs the same player. Rated below the
-- founding backups, young, with room to grow. (Phase 5 generalised the
-- body into franchise_generate_player, which also makes the draft class
-- and the free agents; this is the rookie's door to it.)
-- WHAT A FRANCHISE'S REPUTATION IS WORTH TO A ROOKIE (rookie_v2).
--
-- TEN THOUSAND SEASONS SAID THIS PLAINLY. A rookie's level was pegged to
-- `lowest` — the WORST BACKUP IN A FOUNDING ROSTER — for ever, whatever the
-- franchise had become. So a club fifty seasons deep signed exactly the
-- calibre a club founded yesterday signed, every man on an eighty-season
-- roster was an offseason rookie, and the team converged downward to the
-- rookie pool:
--
--   season      1     3     5    10    20    40    60    80
--   overall   69.7  70.4  68.9  66.1  62.1  61.9  62.1  62.2
--   wins      5.73  5.53  4.20  4.67  3.87  4.13  3.60  4.60
--
-- A player who simply turned up and played got WORSE for eighty seasons and
-- settled eight points below the team he was handed. That is the wrong curve
-- for the person this game is easiest to lose: the one who does not know
-- there is a front office.
--
-- So a rookie arrives at what the franchise's reputation commands, exactly
-- as a coach has since Phase 12: a quarter of a point for every rank, one for
-- every twelve points of standing, capped. Turning up raises the rank, and
-- winning raises the standing, so the two things a passive player DOES are
-- the two things that lift the men he signs. The cap is what stops the
-- feedback loop — better rookies, better standing, better rookies — from
-- running away.
create or replace function public.franchise_rookie_lift(p_rank integer, p_standing integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select greatest(0, least(14,
      floor(greatest(0, coalesce(p_rank, 1) - 1) * 0.25)::int
    + floor(greatest(0, least(100, coalesce(p_standing, 0))) / 12.0)::int));
$$;

create or replace function public.franchise_generate_rookie(
  p_franchise uuid, p_pos text, p_depth integer, p_season integer, p_seed text, p_detail text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lift integer;
begin
  -- the reputation the franchise has actually earned, read on the server
  select public.franchise_rookie_lift(
           coalesce((public.franchise_rank_report(p_franchise)->>'rank')::int, 1),
           coalesce((select standing from public.franchises where id = p_franchise), 0))
    into v_lift;
  return public.franchise_generate_player(p_franchise, p_pos, p_depth, p_season, p_seed, p_detail,
           'rookie', null, null, v_lift);
end;
$$;

-- ONE GENERATED PLAYER of a kind: a rookie (a little under the founding
-- backups, young, room to grow), a prospect (anywhere from raw to ready,
-- with the better development odds — the reason a report is worth buying),
-- or a free agent (a veteran who can play now, priced by his overall).
-- Seeded; the same seed makes the same player.
-- A TRAILING DEFAULT MAKES A NEW SIGNATURE, not a replacement, so the eight
-- argument form is dropped first — otherwise both would exist and a caller
-- would silently keep the old one.
drop function if exists public.franchise_generate_player(uuid, text, integer, integer, text, text, text, integer);
drop function if exists public.franchise_generate_player(uuid, text, integer, integer, text, text, text, integer, integer);
create or replace function public.franchise_generate_player(
  p_franchise uuid, p_pos text, p_depth integer, p_season integer, p_seed text, p_detail text,
  p_kind text default 'rookie', p_class integer default null, p_target integer default null,
  p_lift integer default 0)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  first_names text[] := public.franchise_pool_first_names();
  last_names text[] := public.franchise_pool_last_names();
  plan jsonb := public.franchise_pool_plan();
  archetypes jsonb := public.franchise_pool_archetypes();
  trait_pool jsonb := public.franchise_pool_traits();
  p jsonb; a jsonb; arch jsonb; eligible jsonb; tr jsonb; used_names text[]; used_nums integer[];
  target integer; ovr integer; attrs jsonb; k text; v integer; fn text; ln text; tries integer; num integer; lo integer; hi integer;
  age integer; tier text; r double precision; bump integer; pot integer; v_rarity text; youth double precision; v_id uuid; lowest integer;
begin
  perform setseed(public.franchise_seed_float(p_seed));
  select x into p from jsonb_array_elements(plan) x where x->>'pos' = p_pos;
  if p is null then raise exception 'no such position' using errcode = '22023'; end if;
  lo := (p->'nums'->>0)::int; hi := (p->'nums'->>1)::int;
  select min(t::int) into lowest from jsonb_array_elements_text(p->'targets') t;
  -- p_target is packs_v1 asking for a man of about a given overall. The
  -- attributes are still rolled and still skewed by the archetype, so two
  -- men at the same target are not the same man; the target only says where
  -- the roll is centred.
  target := case
    when p_target is not null then greatest(40, least(99, p_target))
    when p_kind = 'prospect'   then lowest - 7 + floor(random() * 11)::int - 5
    when p_kind = 'free_agent' then lowest + floor(random() * 11)::int - 1
    -- a rookie: a little under the founding backups, LIFTED by what this
    -- franchise has become (rookie_v2)
    else lowest - 4 + floor(random() * 7)::int - 3 + greatest(0, coalesce(p_lift, 0)) end;
  a := archetypes->p_pos;
  arch := a->(floor(random() * jsonb_array_length(a))::int);
  attrs := '{}'::jsonb;
  for k in select jsonb_array_elements_text(p->'attrs') loop
    v := target + coalesce((arch->'skew'->>k)::int, 0) + floor(random() * 5)::int - 2;
    attrs := attrs || jsonb_build_object(k, greatest(40, least(99, v)));
  end loop;
  select round(avg(x.value::int))::int into ovr from jsonb_each_text(attrs) x;
  -- WHEN A TARGET WAS ASKED FOR, LAND ON IT. The archetype's skew can pull an
  -- average several points off the number the roll was centred on, and a pack
  -- that advertises 59 to 71 and hands over a 73 has told the player
  -- something untrue. The spread between his attributes is kept; the whole
  -- man is shifted so his overall is the number that was asked for.
  if p_target is not null and ovr <> greatest(40, least(99, p_target)) then
    select jsonb_object_agg(x.key, greatest(40, least(99, x.value::int + (greatest(40, least(99, p_target)) - ovr))))
      into attrs from jsonb_each_text(attrs) x;
    select round(avg(x.value::int))::int into ovr from jsonb_each_text(attrs) x;
  end if;
  age := case p_kind when 'prospect' then 21 + floor(random() * 2)::int
                     when 'free_agent' then 26 + floor(random() * 6)::int
                     -- a pack man is young enough to be worth developing
                     when 'pack' then 21 + floor(random() * 5)::int
                     else 21 + floor(random() * 3)::int end;
  r := random();
  tier := case p_kind
    when 'prospect'   then (case when r < 0.06 then 'superstar' when r < 0.20 then 'star' when r < 0.45 then 'quick' else 'normal' end)
    when 'free_agent' then (case when r < 0.05 then 'star' when r < 0.20 then 'quick' else 'normal' end)
    when 'pack'       then (case when r < 0.08 then 'superstar' when r < 0.24 then 'star' when r < 0.50 then 'quick' else 'normal' end)
    else (case when r < 0.03 then 'superstar' when r < 0.15 then 'star' when r < 0.40 then 'quick' else 'normal' end) end;
  bump := case tier when 'superstar' then 18 + floor(random() * 9)::int when 'star' then 12 + floor(random() * 9)::int
                    when 'quick' then 6 + floor(random() * 9)::int else 2 + floor(random() * 7)::int end;
  youth := (33 - age) / 12.0;
  pot := least(99, greatest(ovr, ovr + round(bump * youth)::int));
  v_rarity := case when ovr >= 82 or pot >= 90 then 'elite' when ovr >= 75 or pot >= 84 then 'rare'
                   when ovr >= 68 or pot >= 77 then 'uncommon' else 'common' end;
  tr := null;
  if random() < 0.25 then
    select jsonb_agg(x) into eligible from jsonb_array_elements(trait_pool) x where x->'pos' ? p_pos;
    if eligible is not null and jsonb_array_length(eligible) > 0 then
      tr := eligible->(floor(random() * jsonb_array_length(eligible))::int);
      tr := tr - 'pos';
    end if;
  end if;
  -- no name of anyone who was ever in the building, prospects and free
  -- agents included; a number is taken from the roster's unused ones, and
  -- a prospect or a free agent has none until he joins (franchise_draft
  -- and franchise_sign give him one)
  select coalesce(array_agg(first_name || ' ' || last_name), '{}') into used_names
    from public.game_players where franchise_id = p_franchise;
  select coalesce(array_agg(jersey), '{}') into used_nums
    from public.game_players where franchise_id = p_franchise and status = 'active';
  tries := 0;
  loop
    fn := first_names[1 + floor(random() * array_length(first_names, 1))::int];
    ln := last_names[1 + floor(random() * array_length(last_names, 1))::int];
    exit when not ((fn || ' ' || ln) = any (used_names)) or tries > 20;
    tries := tries + 1;
  end loop;
  tries := 0; num := 0;
  if p_kind not in ('prospect', 'free_agent') then
    loop
      num := lo + floor(random() * (hi - lo + 1))::int;
      exit when not (num = any (used_nums)) or tries > 40;
      tries := tries + 1;
    end loop;
  end if;
  insert into public.game_players
    (franchise_id, first_name, last_name, position, jersey, age, overall, archetype, dev_tier, potential, stamina, chemistry,
     rarity, ratings, traits, depth, status, acquired_source, acquired_season, acquired_detail, class_season, asking)
  values
    (p_franchise, fn, ln, p_pos, num, age, ovr, arch->>'name', tier, pot, 70 + floor(random() * 26)::int, 50,
     v_rarity, attrs, case when tr is null then '[]'::jsonb else jsonb_build_array(tr) end, p_depth,
     -- a pack man waits on the table until one of the three is kept; he is
     -- not on the roster and does not count against it
     case p_kind when 'prospect' then 'prospect' when 'free_agent' then 'free_agent'
                 when 'pack' then 'pack' else 'active' end,
     case p_kind when 'prospect' then 'draft' when 'free_agent' then 'free_agent'
                 when 'pack' then 'pack' else 'offseason_rookie' end,
     p_season, p_detail, p_class, case when p_kind = 'free_agent' then public.franchise_signing_cost(ovr) end)
  returning id into v_id;
  return v_id;
end;
$$;

-- THE OFFSEASON, after season p_from. Runs once; a second call returns the
-- report already written.
-- WHAT THE OFFSEASON IS, without running one. The report row needs the
-- version and an offseason writes to the database, so the version is named
-- here and read from there.
create or replace function public.franchise_offseason_version()
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select 'offseason_v2';
$$;

create or replace function public.franchise_offseason(p_franchise uuid, p_from integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; pl record; training integer; g integer; growth integer; k text; v integer; newattrs jsonb; ovr integer;
  pot integer; v_rarity text; age_new integer; report jsonb; players jsonb := '[]'::jsonb; retired jsonb := '[]'::jsonb;
  rookies jsonb := '[]'::jsonb; nimp integer := 0; ndec integer := 0; nret integer := 0; rid uuid; v_pos text; d integer; k2 integer;
  delta integer; retire boolean; big integer := 0; founder_retired boolean := false; v_real integer; existing jsonb; mk jsonb;
begin
  select * into f from public.franchises where id = p_franchise for update;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select offseason, season into existing, v_real from public.franchise_seasons where franchise_id = p_franchise and number = p_from;
  if existing is not null then return existing; end if;
  perform setseed(public.franchise_seed_float(f.seed || ':offseason:' || p_from));
  training := coalesce((f.facilities->>'training')::int, 0);
  -- the head trainer works alongside the Training Center (Phase 8): his
  -- curve and his specialties add to the same number, rounded down, so a
  -- staff built over years grows the young like another facility
  training := training + floor(coalesce((public.franchise_staff_effects(p_franchise)->>'development')::numeric, 0))::int;

  -- everybody reports fit: an injury is a cost inside a season, never across one
  update public.game_players set injured_until = null, injury = null
   where franchise_id = p_franchise and injured_until is not null;
  for pl in select * from public.game_players where franchise_id = p_franchise and status = 'active' order by position, depth, id loop
    age_new := pl.age + 1;
    g := coalesce((pl.season_stats->>'games')::int, 0);
    growth := case
      when age_new <= 26 then (case pl.dev_tier when 'superstar' then 4 when 'star' then 3 when 'quick' then 2 else 1 end)
                              + (case when g >= 4 then 1 else 0 end) + training + floor(random() * 3)::int - 1
      when age_new <= 29 then floor(random() * 3)::int - 1 + (case when g >= 4 and training >= 2 then 1 else 0 end)
      when age_new <= 32 then -1 + floor(random() * 2)::int - 1 + (case when training >= 3 then 1 else 0 end)
      else -2 + floor(random() * 2)::int - 1 end;
    newattrs := '{}'::jsonb;
    for k, v in select key, value::int from jsonb_each_text(pl.ratings) loop
      newattrs := newattrs || jsonb_build_object(k, greatest(40, least(99, v + growth + floor(random() * 3)::int - 1)));
    end loop;
    select round(avg(x.value::int))::int into ovr from jsonb_each_text(newattrs) x;
    -- the ceiling: growth cannot lift a player past his potential
    if ovr > pl.potential and growth > 0 then
      select jsonb_object_agg(x.key, greatest(40, x.value::int - (ovr - pl.potential))) into newattrs from jsonb_each_text(newattrs) x;
      select round(avg(x.value::int))::int into ovr from jsonb_each_text(newattrs) x;
    end if;
    pot := case when age_new >= 30 then ovr else greatest(pl.potential, ovr) end;
    v_rarity := case when ovr >= 82 or pot >= 90 then 'elite' when ovr >= 75 or pot >= 84 then 'rare'
                     when ovr >= 68 or pot >= 77 then 'uncommon' else 'common' end;
    delta := ovr - pl.overall;
    retire := age_new >= 35 or (age_new >= 33 and ovr < 55);
    update public.game_players
       set age = age_new, ratings = newattrs, overall = ovr, potential = pot, rarity = v_rarity,
           status = case when retire then 'retired' else status end,
           retired_season = case when retire then p_from else retired_season end,
           updated_at = now()
     where id = pl.id;
    players := players || jsonb_build_object('id', pl.id, 'name', pl.first_name || ' ' || pl.last_name, 'position', pl.position,
      'age', age_new, 'before', pl.overall, 'after', ovr, 'delta', delta, 'retired', retire);
    if delta > 0 then nimp := nimp + 1; elsif delta < 0 then ndec := ndec + 1; end if;
    if delta > big then big := delta; end if;
    if retire then
      nret := nret + 1;
      retired := retired || jsonb_build_object('id', pl.id, 'name', pl.first_name || ' ' || pl.last_name, 'position', pl.position,
        'age', age_new, 'overall', ovr, 'founder', pl.acquired_source = 'founding_roster', 'games', coalesce((pl.career_stats->>'games')::int, 0));
      if pl.acquired_source = 'founding_roster' then founder_retired := true; end if;
    end if;
  end loop;

  -- THE CHART IS RE-EARNED, not merely closed up. Measured over sixty
  -- seasons: this loop used to run only for positions that lost somebody and
  -- to order by DEPTH, so it compacted the chart while preserving whoever was
  -- already in front. Every man acquired — drafted, signed, kept from a pack,
  -- developed — joins at the bottom, so he stayed at the bottom for the rest
  -- of his career while the ageing starter kept playing. A franchise sixty
  -- seasons deep was starting a 59 receiver ahead of a 75 and a 53 corner
  -- ahead of a 66, and its team overall DECAYED from 74 to 67 while its
  -- roster got better. A preseason sorts by who is best now; a player who
  -- wants it otherwise still says so with franchise_set_starter().
  -- EVERY POSITION IN THE PLAN, not only the ones that still have a man
  -- standing. This read "select distinct position ... where status = 'active'"
  -- until ten thousand seasons showed what that means: an empty position is
  -- invisible to it, so an empty position stays empty for ever.
  for v_pos in
    select pp->>'pos' from jsonb_array_elements(public.franchise_pool_plan()) pp
    union
    select distinct position from public.game_players
     where franchise_id = p_franchise and status = 'active'
  loop
    k2 := 0;
    for pl in select id from public.game_players where franchise_id = p_franchise and position = v_pos and status = 'active' order by overall desc, potential desc, id loop
      k2 := k2 + 1;
      update public.game_players set depth = k2 where id = pl.id;
    end loop;
    -- EVERY POSITION IS RESTOCKED TO THE ROSTER PLAN, not merely replaced
    -- one-for-one. Ten thousand seasons found what the old rule did: it
    -- signed one rookie per man who retired AT A POSITION THAT STILL HAD
    -- SOMEBODY ACTIVE, because the loop above it read
    -- "select distinct position ... where status = 'active'". The moment the
    -- last quarterback retired, QB stopped appearing in that list and could
    -- never be signed again. Measured across fifteen franchises: fourteen
    -- had NO KICKER and NO PUNTER, nine had NO QUARTERBACK, and the first
    -- touchdown after that killed the game for good.
    --
    -- franchise_pool_plan() already says how many of each a roster carries —
    -- it is what a founding roster is built from — so it is the floor here
    -- too. A team may go deeper than the plan by drafting and signing; it can
    -- no longer fall through it.
    --
    -- ONE HONEST CONSEQUENCE: a position left short by a TRADE is topped back
    -- up at the next offseason too, so you cannot run a deliberately thin
    -- roster. The replacement is a rookie, though — trading a good lineman
    -- away still costs you the lineman, it just does not cost you the body.
    -- Against a bug that ended 38.5% of careers, that is the right trade.
    for d in 1..greatest(
        (select count(*) from public.game_players
          where franchise_id = p_franchise and position = v_pos
            and status = 'retired' and retired_season = p_from),
        (select coalesce(jsonb_array_length(pp->'targets'), 0)
           from jsonb_array_elements(public.franchise_pool_plan()) pp
          where pp->>'pos' = v_pos) - k2) loop
      k2 := k2 + 1;
      rid := public.franchise_generate_rookie(p_franchise, v_pos, k2, coalesce(v_real, public.games_season_of(now())),
               f.seed || ':rookie:' || p_from || ':' || v_pos || ':' || d, 'Signed after Season ' || public.games_roman(p_from));
      rookies := rookies || (select jsonb_build_object('id', id, 'name', first_name || ' ' || last_name, 'position', position,
        'overall', overall, 'age', age, 'potential', potential, 'depth', depth) from public.game_players where id = rid);
    end loop;
  end loop;

  -- the next window: a new draft class, new free agents, the picks renewed
  mk := public.franchise_open_market(p_franchise, p_from + 1);

  report := jsonb_build_object('version', public.franchise_offseason_version(), 'after_season', p_from, 'training', training,
    'players', players, 'retired', retired, 'rookies', rookies, 'market', mk,
    'summary', jsonb_build_object('improved', nimp, 'declined', ndec, 'retired', nret, 'signed', jsonb_array_length(rookies), 'biggest', big));
  update public.franchise_seasons set offseason = report where franchise_id = p_franchise and number = p_from;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (p_franchise, 'offseason', p_from::text, public.games_week_key(now()), public.games_day_key(now()), report->'summary')
  on conflict (franchise_id, kind, key) do nothing;
  if big >= 4 then perform public.franchise_award(p_franchise, 'breakout', public.games_season_of(now()), jsonb_build_object('after_season', p_from, 'delta', big)); end if;
  if founder_retired then perform public.franchise_award(p_franchise, 'farewell', public.games_season_of(now()), jsonb_build_object('after_season', p_from)); end if;
  return report;
end;
$$;

-- UPGRADE A FACILITY. One negative ledger row, keyed by facility and level;
-- refused when the level is the top one or the resource is short.
create or replace function public.franchise_upgrade(p_facility text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; tbl jsonb := public.franchise_facilities();
  spec jsonb; lvl integer; cost integer; cur text; bal integer; ok boolean; v_new text[] := '{}';
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  if p_facility is null or p_facility = 'version' then raise exception 'no such facility' using errcode = '22023'; end if;
  spec := tbl->p_facility;
  if spec is null then raise exception 'no such facility' using errcode = '22023'; end if;
  select * into f from public.franchises where id = v_f for update;
  lvl := coalesce((f.facilities->>p_facility)::int, 0);
  if lvl >= jsonb_array_length(spec->'costs') then
    raise exception '% is already at its top level', spec->>'name' using errcode = '55000';
  end if;
  cost := (spec->'costs'->>lvl)::int; cur := spec->>'currency';
  bal := case cur when 'tc' then f.team_credits when 'cp' then f.coach_points when 'sp' then f.scouting_points else 0 end;
  if bal < cost then
    raise exception 'not enough %: % needed, % on hand',
      (case cur when 'tc' then 'Team Credits' when 'cp' then 'Coach Points' else 'Scouting Points' end), cost, bal
      using errcode = '55000';
  end if;
  ok := public.franchise_credit(v_f, cur, -cost, 'facility', p_facility || ':' || (lvl + 1), (spec->>'name') || ' level ' || (lvl + 1));
  if not ok then raise exception 'that upgrade is already on the books' using errcode = '55000'; end if;
  update public.franchises set facilities = coalesce(facilities, '{}'::jsonb) || jsonb_build_object(p_facility, lvl + 1), updated_at = now() where id = v_f;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'facility', p_facility || ':' || (lvl + 1), public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('facility', p_facility, 'level', lvl + 1, 'cost', cost, 'currency', cur))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_f, 'first_upgrade', public.games_season_of(now()), jsonb_build_object('facility', p_facility)) then
    v_new := array_append(v_new, 'first_upgrade');
  end if;
  return jsonb_build_object('ok', true, 'facility', p_facility, 'level', lvl + 1, 'cost', cost, 'currency', cur,
    'facilities', (select facilities from public.franchises where id = v_f),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- THE TROPHY ROOM: everything permanent about a franchise, in one read.
create or replace function public.franchise_trophies(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; v_ach jsonb; v_seasons jsonb; v_leaders jsonb; v_alumni jsonb; v_record jsonb; v_riv jsonb;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'description', d.description, 'exclusive_season', d.exclusive_season,
      'sort', d.sort, 'earned', a.franchise_id is not null, 'earned_at', a.earned_at, 'season', a.season) order by d.sort), '[]'::jsonb)
    into v_ach from public.franchise_achievement_defs d
    left join public.franchise_achievements a on a.achievement_id = d.id and a.franchise_id = f.id;
  select coalesce(jsonb_agg(public.franchise_season_json(f.id, s.number) || jsonb_build_object(
      'offseason', s.offseason,
      'games', (select coalesce(jsonb_agg(jsonb_build_object('week', g.week, 'home', g.home, 'rival', g.rival, 'status', g.status,
                  'result', g.result, 'score_for', g.score_for, 'score_against', g.score_against, 'ot', coalesce((g.box->>'ot')::boolean, false),
                  'potg', g.box->'potg'->>'name', 'bowl', g.bowl, 'bowl_name', g.opponent->>'bowl_name',
                  'injuries', coalesce(g.box->'injuries', '[]'::jsonb),
                  'opponent', jsonb_build_object('name', g.opponent->>'name', 'city', g.opponent->>'city', 'abbr', g.opponent->>'abbr',
                    'logo', g.opponent->>'logo', 'theme', g.opponent->>'theme', 'overall', g.opponent->'overall')) order by g.week), '[]'::jsonb)
                 from public.franchise_games g where g.franchise_id = f.id and g.season_number = s.number))
      order by s.number desc), '[]'::jsonb)
    into v_seasons from public.franchise_seasons s where s.franchise_id = f.id;
  select jsonb_build_object(
    'passing', (select coalesce(jsonb_agg(l order by (l->>'yds')::int desc), '[]'::jsonb) from (
       select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'status', p.status,
         'yds', (p.career_stats->>'yds')::int, 'td', coalesce((p.career_stats->>'td')::int, 0), 'games', coalesce((p.career_stats->>'games')::int, 0)) l
       from public.game_players p where p.franchise_id = f.id and p.position = 'QB' and (p.career_stats->>'yds')::int > 0 order by (p.career_stats->>'yds')::int desc limit 3) s),
    'rushing', (select coalesce(jsonb_agg(l order by (l->>'yds')::int desc), '[]'::jsonb) from (
       select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'status', p.status,
         'yds', (p.career_stats->>'yds')::int, 'td', coalesce((p.career_stats->>'td')::int, 0), 'games', coalesce((p.career_stats->>'games')::int, 0)) l
       from public.game_players p where p.franchise_id = f.id and p.position = 'RB' and (p.career_stats->>'yds')::int > 0 order by (p.career_stats->>'yds')::int desc limit 3) s),
    'receiving', (select coalesce(jsonb_agg(l order by (l->>'yds')::int desc), '[]'::jsonb) from (
       select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'status', p.status,
         'yds', (p.career_stats->>'yds')::int, 'td', coalesce((p.career_stats->>'td')::int, 0), 'games', coalesce((p.career_stats->>'games')::int, 0)) l
       from public.game_players p where p.franchise_id = f.id and p.position in ('WR', 'TE') and (p.career_stats->>'yds')::int > 0 order by (p.career_stats->>'yds')::int desc limit 3) s),
    'tackles', (select coalesce(jsonb_agg(l order by (l->>'tkl')::int desc), '[]'::jsonb) from (
       select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'status', p.status,
         'tkl', (p.career_stats->>'tkl')::int, 'sacks', coalesce((p.career_stats->>'sacks')::int, 0), 'int', coalesce((p.career_stats->>'int')::int, 0), 'games', coalesce((p.career_stats->>'games')::int, 0)) l
       from public.game_players p where p.franchise_id = f.id and p.position in ('DL', 'LB', 'CB', 'S') and (p.career_stats->>'tkl')::int > 0 order by (p.career_stats->>'tkl')::int desc limit 3) s),
    'sacks', (select coalesce(jsonb_agg(l order by (l->>'sacks')::int desc), '[]'::jsonb) from (
       select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'status', p.status,
         'sacks', (p.career_stats->>'sacks')::int, 'games', coalesce((p.career_stats->>'games')::int, 0)) l
       from public.game_players p where p.franchise_id = f.id and p.position in ('DL', 'LB') and (p.career_stats->>'sacks')::int > 0 order by (p.career_stats->>'sacks')::int desc limit 3) s))
    into v_leaders;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'jersey', p.jersey,
      'age', p.age, 'overall', p.overall, 'archetype', p.archetype, 'rarity', p.rarity, 'retired_season', p.retired_season,
      'acquired_source', p.acquired_source, 'acquired_season', p.acquired_season, 'career_stats', p.career_stats)
      order by p.retired_season desc, p.overall desc), '[]'::jsonb)
    into v_alumni from public.game_players p where p.franchise_id = f.id and p.status = 'retired';
  select jsonb_build_object('wins', coalesce(sum(wins), 0), 'losses', coalesce(sum(losses), 0), 'ties', coalesce(sum(ties), 0),
      'points_for', coalesce(sum(points_for), 0), 'points_against', coalesce(sum(points_against), 0), 'seasons', count(*) filter (where status = 'complete'))
    into v_record from public.franchise_seasons where franchise_id = f.id;
  select jsonb_build_object('key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr, 'logo', o.logo, 'theme', o.theme,
      'wins', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'W'),
      'losses', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'L'),
      'ties', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'T'))
    into v_riv from public.franchise_opponents o where o.key = f.rival_key;
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season, 'created_at', f.created_at,
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'achievements', v_ach, 'seasons', v_seasons, 'leaders', v_leaders, 'alumni', v_alumni, 'record', v_record, 'rival', v_riv,
    'facilities', coalesce(f.facilities, '{}'::jsonb), 'facilities_table', public.franchise_facilities(),
    'staff', public.franchise_staff_board(p_secret),
    'ladder', jsonb_build_object('rating', f.ladder_rating, 'games', f.ladder_games, 'rank', public.franchise_ladder_rank(f.id)),
    'fc_record', (select jsonb_build_object('wins', coalesce(sum(fc_wins), 0), 'losses', coalesce(sum(fc_losses), 0), 'ties', coalesce(sum(fc_ties), 0))
                    from public.franchise_rivalries r where r.franchise_id = f.id),
    -- the titles, wherever they were won: the conference, the season, the
    -- team beaten in the final. A franchise that has since left the
    -- conference keeps every one of them.
    'titles', (select coalesce(jsonb_agg(jsonb_build_object(
        'conference', c.name, 'season_number', t.season_number,
        'label', 'Season ' || public.games_roman(t.season_number),
        'runner_up', public.franchise_identity_json(t.runner_up_id),
        'completed_at', t.completed_at) order by t.completed_at desc), '[]'::jsonb)
      from public.franchise_conference_titles t join public.franchise_conferences c on c.id = t.conference_id
      where t.champion_id = f.id),
    'conference', (select public.franchise_conference_json(m.conference_id)
                     from public.franchise_conference_members m where m.franchise_id = f.id));
end;
$$;

-- ── THE DRAFT AND THE MARKET — market_v1 ─────────────────────────────────
-- Where Scouting Points are spent. Every window — founding, and every
-- offseason — a franchise gets a draft class of its own: prospects whose
-- true ratings are hidden until a scouting report is bought with Scouting
-- Points; a number of picks, renewed each window and never banked; and a
-- short list of free agents with an asking price in Team Credits. The
-- roster has a ceiling and a floor; at the ceiling a player must be
-- released before another joins. Everything is generated, priced, hidden
-- and revealed on the server; the direct read policy on game_players does
-- not admit a prospect or a free agent at all, so the board is the only
-- way to look.
-- A NUMBER for a player joining the roster: the first unused one in his
-- position's range, walking from a point fixed by the seed.
create or replace function public.franchise_free_number(p_franchise uuid, p_pos text, p_seed text)
returns integer language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p jsonb; lo integer; hi integer; used integer[]; i integer; n integer; size integer;
begin
  select x into p from jsonb_array_elements(public.franchise_pool_plan()) x where x->>'pos' = p_pos;
  lo := coalesce((p->'nums'->>0)::int, 1); hi := coalesce((p->'nums'->>1)::int, 99); size := hi - lo + 1;
  select coalesce(array_agg(jersey), '{}') into used from public.game_players where franchise_id = p_franchise and status = 'active';
  for i in 0..(size - 1) loop
    n := lo + ((abs(hashtext(coalesce(p_seed, ''))) + i) % size);
    if not (n = any (used)) then return n; end if;
  end loop;
  -- every number in the range is worn: the first free one anywhere
  for n in 1..99 loop
    if not (n = any (used)) then return n; end if;
  end loop;
  return 0;
end;
$$;

create or replace function public.franchise_market()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'market_v1',
    'scout_sp', 20,
    'picks', 2,
    'class_size', 10,
    'agents', 6,
    'roster_max', 42,
    'roster_min', 38,
    'signing', jsonb_build_object('floor', 100, 'per_point', 20, 'over', 55));
$$;

-- a free agent's asking price: 100 Team Credits, or 20 for every point over 55
create or replace function public.franchise_signing_cost(p_overall integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select greatest(100, (coalesce(p_overall, 0) - 55) * 20);
$$;

-- A PROSPECT OR A FREE AGENT AS THE BOARD SHOWS HIM. Unscouted, a prospect
-- shows his name, position, age and archetype, and an overall RANGE ten
-- points wide whose placement is fixed per player, so asking twice narrows
-- nothing. Scouted, or once on the roster, everything. A free agent hides
-- nothing and carries his asking price.
create or replace function public.franchise_prospect_json(p public.game_players)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare lo integer; hi integer; w integer; base jsonb; reveal boolean := p.scouted or p.status <> 'prospect';
begin
  /* THE BAND. Its width was stamped on this prospect by the department that
     found him (scout_band, scouting_v1) and does not move afterwards; a class
     stays true to the grade it was found under. Eleven is what every class
     generated before Phase 9 was shown at.

     Inside the band the true overall is UNIFORM — the rule is in this file
     and anyone may read it, so the honest thing is for the band to mean
     exactly what it looks like: somewhere in here, nothing narrower implied.
     The band always contains the truth, so a report never contradicts it. */
  w := greatest(2, coalesce(p.scout_band, 11));
  lo := greatest(40, p.overall - (abs(hashtext(p.id::text || ':band')) % w));
  hi := least(99, lo + w - 1);
  base := jsonb_build_object('id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'position', p.position,
    'age', p.age, 'archetype', p.archetype, 'status', p.status, 'scouted', p.scouted, 'class_season', p.class_season,
    'acquired_source', p.acquired_source, 'acquired_detail', p.acquired_detail, 'asking', p.asking,
    'jersey', case when p.status = 'active' then p.jersey end, 'depth', p.depth);
  if reveal then
    return base || jsonb_build_object('overall', p.overall, 'potential', p.potential, 'dev_tier', p.dev_tier,
      'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits, 'stamina', p.stamina);
  end if;
  return base || jsonb_build_object('range', jsonb_build_array(lo, hi), 'band', w, 'overall', null, 'potential', null);
end;
$$;

-- OPEN A WINDOW: the class and the market for the season about to be
-- played, generated once per franchise per window from the founding pools
-- and seeded from the franchise; the previous window's leftovers are
-- passed over and kept as a record; the picks are renewed, not banked.
create or replace function public.franchise_open_market(p_franchise uuid, p_window integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; m jsonb := public.franchise_market(); v_real integer; i integer; pos text; pid uuid;
  class_pool text[] := array['QB','RB','WR','TE','OL','DL','LB','CB','S','WR','OL','DL'];
  agent_pool text[] := array['WR','OL','DL','LB','CB','RB','S','TE','QB','K','P','OL'];
  n_class integer := (m->>'class_size')::int; n_agents integer := (m->>'agents')::int;
  /* the department, graded ONCE, here (scouting_v1) */
  sc jsonb; v_grade integer; v_band integer; v_lift integer; v_picks integer;
begin
  select * into f from public.franchises where id = p_franchise for update;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select season into v_real from public.franchise_seasons where franchise_id = p_franchise and number = p_window;
  v_real := coalesce(v_real, public.games_season_of(now()));
  update public.game_players set status = 'passed', updated_at = now()
   where franchise_id = p_franchise and status in ('prospect', 'free_agent') and class_season < p_window;
  if exists (select 1 from public.franchise_activity where franchise_id = p_franchise and kind = 'market' and key = p_window::text) then
    return jsonb_build_object('window', p_window, 'opened', false);
  end if;
  /* THE DEPARTMENT, GRADED ONCE. Everything scouting_v1 is worth is decided
     here, from the grade standing at the moment the window opens, and does
     not move again until the next one: a class cannot be improved by pricing
     games after you have seen it, and cannot be taken away by a bad week
     either. The weeks BEFORE an offseason are the ones that count. */
  sc := public.franchise_scout_report(p_franchise);
  v_grade := (sc->>'score')::int;
  v_band  := (sc->>'band')::int;
  v_lift  := (sc->>'lift')::int;
  v_picks := (m->>'picks')::int + case when (sc->>'extra_pick')::boolean then 1 else 0 end;

  for i in 1..n_class loop
    pos := class_pool[1 + ((p_window - 1) * 5 + i - 1) % array_length(class_pool, 1)];
    pid := public.franchise_generate_player(p_franchise, pos, 0, v_real, f.seed || ':class:' || p_window || ':' || i,
             'Season ' || public.games_roman(p_window) || ' draft class', 'prospect', p_window);
  end loop;
  /* WHAT THE DEPARTMENT FOUND: potential, never overall. A good department
     does not make a nineteen-year-old better today — it finds the one who
     will be. Rarity is derived from overall and potential, so it is restated
     here by the same rule the generator used rather than left stale. */
  update public.game_players
     set potential = least(99, greatest(overall, potential + v_lift)),
         scout_band = v_band,
         rarity = case when overall >= 82 or least(99, greatest(overall, potential + v_lift)) >= 90 then 'elite'
                       when overall >= 75 or least(99, greatest(overall, potential + v_lift)) >= 84 then 'rare'
                       when overall >= 68 or least(99, greatest(overall, potential + v_lift)) >= 77 then 'uncommon'
                       else 'common' end,
         updated_at = now()
   where franchise_id = p_franchise and status = 'prospect' and class_season = p_window;
  for i in 1..n_agents loop
    pos := agent_pool[1 + ((p_window - 1) * 7 + i - 1) % array_length(agent_pool, 1)];
    pid := public.franchise_generate_player(p_franchise, pos, 0, v_real, f.seed || ':agent:' || p_window || ':' || i,
             'Free agent, Season ' || public.games_roman(p_window), 'free_agent', p_window);
  end loop;
  update public.franchises set draft_picks = v_picks, market_season = p_window,
         scout_grade = v_grade, updated_at = now() where id = p_franchise;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (p_franchise, 'market', p_window::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('prospects', n_class, 'agents', n_agents, 'picks', v_picks,
            /* the record of the department that found this class */
            'scout_grade', v_grade, 'scout_name', sc->>'grade_name', 'band', v_band, 'lift', v_lift,
            'report_cost', public.franchise_scout_cost(v_grade), 'scouting_version', sc->>'version'))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('window', p_window, 'opened', true, 'prospects', n_class, 'agents', n_agents,
    'picks', v_picks, 'scouting', sc);
end;
$$;

-- THE BOARD: the class, the market, the picks, the roster's room, what a
-- report costs, and what the franchise has done here — one read.
create or replace function public.franchise_market_board(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; m jsonb := public.franchise_market(); v_active integer; v_pros jsonb; v_agents jsonb; v_hist jsonb; v_label text;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select count(*) into v_active from public.game_players where franchise_id = f.id and status = 'active';
  select coalesce(jsonb_agg(public.franchise_prospect_json(p)
      order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.last_name, p.first_name), '[]'::jsonb)
    into v_pros from public.game_players p where p.franchise_id = f.id and p.status = 'prospect' and p.class_season = f.market_season;
  select coalesce(jsonb_agg(public.franchise_prospect_json(p) || jsonb_build_object('affordable', f.team_credits >= p.asking)
      order by p.overall desc, p.asking desc, p.last_name), '[]'::jsonb)
    into v_agents from public.game_players p where p.franchise_id = f.id and p.status = 'free_agent' and p.class_season = f.market_season;
  select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'at', a.created_at, 'detail', a.detail) order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_hist from (select * from public.franchise_activity where franchise_id = f.id and kind in ('scout', 'draft', 'signing', 'release')
                      order by created_at desc, id desc limit 12) a;
  select label into v_label from public.franchise_seasons where franchise_id = f.id and number = f.market_season;
  return jsonb_build_object(
    'version', m->>'version', 'rules', m,
    'window', jsonb_build_object('number', f.market_season,
      'label', coalesce(v_label, 'Season ' || public.games_roman(coalesce(f.market_season, 1)))),
    'picks', f.draft_picks,
    'roster', jsonb_build_object('active', v_active, 'max', (m->>'roster_max')::int, 'min', (m->>'roster_min')::int,
      'room', greatest(0, (m->>'roster_max')::int - v_active)),
    'resources', public.franchise_totals(f.id),
    /* THE DEPARTMENT, twice, because they are different questions.
       `department` is the grade THIS CLASS was found under — the band on the
       cards below, what a report costs, whether the extra pick is there. It
       is fixed. `scouting` is the grade RIGHT NOW, which is what the next
       window will open under, and the only reason to price another game
       before the offseason. */
    'department', case when f.scout_grade is null then null else jsonb_build_object(
      'score', f.scout_grade,
      'grade', public.franchise_scout_grade_of(f.scout_grade)->>'key',
      'grade_name', public.franchise_scout_grade_of(f.scout_grade)->>'name',
      'band', public.franchise_scout_band(f.scout_grade),
      'lift', public.franchise_scout_lift(f.scout_grade),
      'report_cost', public.franchise_scout_cost(f.scout_grade)) end,
    'scouting', public.franchise_scout_report(f.id),
    'scout_cost', case when f.scout_grade is null then (m->>'scout_sp')::int
                       else public.franchise_scout_cost(f.scout_grade) end,
    'prospects', v_pros, 'agents', v_agents,
    'scouted', (select count(*) from public.game_players where franchise_id = f.id and status = 'prospect' and class_season = f.market_season and scouted),
    'drafted', (select count(*) from public.game_players where franchise_id = f.id and acquired_source = 'draft' and class_season = f.market_season and status = 'active'),
    'history', v_hist);
end;
$$;

-- A SCOUTING REPORT. Scouting Points buy the truth about one prospect,
-- once, as one negative ledger row keyed by the player. A free agent hides
-- nothing, so there is no report to sell.
create or replace function public.franchise_scout(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; p public.game_players%rowtype;
  cost integer; ok boolean; v_new text[] := '{}'; left_n integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  /* PRICED BY THE DEPARTMENT THAT FOUND THE CLASS, not by the one you have
     today: scout_grade was stamped when this window opened and does not move
     until the next one. A class opened before Phase 9 has no grade, and pays
     what it always paid. */
  cost := case when f.scout_grade is null then (public.franchise_market()->>'scout_sp')::int
               else public.franchise_scout_cost(f.scout_grade) end;
  select * into p from public.game_players where id = p_player and franchise_id = v_f for update;
  if not found or p.status <> 'prospect' or p.class_season is distinct from f.market_season then
    raise exception 'that prospect is not in your draft class' using errcode = 'P0002';
  end if;
  if p.scouted then
    raise exception 'you already have the report on %', p.first_name || ' ' || p.last_name using errcode = '55000';
  end if;
  if f.scouting_points < cost then
    raise exception 'not enough Scouting Points: % needed, % on hand', cost, f.scouting_points using errcode = '55000';
  end if;
  ok := public.franchise_credit(v_f, 'sp', -cost, 'scout', p.id::text, 'Scouting report: ' || p.first_name || ' ' || p.last_name);
  if not ok then raise exception 'that report is already on the books' using errcode = '55000'; end if;
  update public.game_players set scouted = true, updated_at = now() where id = p.id;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'scout', p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position, 'overall', p.overall,
                             'potential', p.potential, 'cost', cost, 'currency', 'sp'))
  on conflict (franchise_id, kind, key) do nothing;
  select count(*) into left_n from public.game_players
   where franchise_id = v_f and status = 'prospect' and class_season = f.market_season and not scouted;
  if left_n = 0 and public.franchise_award(v_f, 'full_scout', public.games_season_of(now()), jsonb_build_object('window', f.market_season)) then
    v_new := array_append(v_new, 'full_scout');
  end if;
  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'player', public.franchise_prospect_json(p), 'cost', cost, 'currency', 'sp',
    'unscouted', left_n, 'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- A DRAFT PICK. A prospect from this window's class joins the roster at
-- the bottom of his position's chart; the pick is spent; the ceiling
-- holds. Scouted or not — an owner may take a chance.
create or replace function public.franchise_draft(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; p public.game_players%rowtype;
  m jsonb := public.franchise_market(); v_active integer; v_depth integer; v_pick integer; v_new text[] := '{}';
  v_real integer := public.games_season_of(now()); v_label text;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  select * into p from public.game_players where id = p_player and franchise_id = v_f for update;
  if not found or p.status <> 'prospect' or p.class_season is distinct from f.market_season then
    raise exception 'that prospect is not in your draft class' using errcode = 'P0002';
  end if;
  if f.draft_picks <= 0 then
    raise exception 'no draft picks left until the next offseason' using errcode = '55000';
  end if;
  select count(*) into v_active from public.game_players where franchise_id = v_f and status = 'active';
  if v_active >= (m->>'roster_max')::int then
    raise exception 'the roster is full at %: release a player first', (m->>'roster_max')::int using errcode = '55000';
  end if;
  select coalesce(max(depth), 0) + 1 into v_depth from public.game_players where franchise_id = v_f and position = p.position and status = 'active';
  v_pick := (m->>'picks')::int - f.draft_picks + 1;
  select label into v_label from public.franchise_seasons where franchise_id = v_f and number = f.market_season;
  update public.game_players
     set status = 'active', depth = v_depth, acquired_source = 'draft', acquired_season = v_real,
         jersey = public.franchise_free_number(v_f, p.position, p.id::text),
         acquired_detail = 'Pick ' || v_pick || ' of the ' || coalesce(v_label, 'Season ' || public.games_roman(f.market_season)) || ' class',
         updated_at = now()
   where id = p.id;
  update public.franchises set draft_picks = draft_picks - 1, updated_at = now() where id = v_f;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'draft', p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position, 'overall', p.overall,
                             'potential', p.potential, 'pick', v_pick, 'scouted', p.scouted, 'window', f.market_season))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_f, 'draft_day', v_real, jsonb_build_object('player', p.id, 'pick', v_pick)) then
    v_new := array_append(v_new, 'draft_day');
  end if;
  if not p.scouted and p.potential >= 80
     and public.franchise_award(v_f, 'gut_call', v_real, jsonb_build_object('player', p.id, 'potential', p.potential)) then
    v_new := array_append(v_new, 'gut_call');
  end if;
  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'player', public.franchise_prospect_json(p), 'pick', v_pick, 'picks', f.draft_picks - 1,
    'roster_active', v_active + 1, 'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- A SIGNING. A free agent from this window's market joins the roster for
-- his asking price in Team Credits — one negative ledger row keyed by the
-- player — at the bottom of his position's chart; the ceiling holds.
create or replace function public.franchise_sign(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; p public.game_players%rowtype;
  m jsonb := public.franchise_market(); v_active integer; v_depth integer; ok boolean; v_new text[] := '{}';
  v_real integer := public.games_season_of(now()); v_label text;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  select * into p from public.game_players where id = p_player and franchise_id = v_f for update;
  if not found or p.status <> 'free_agent' or p.class_season is distinct from f.market_season then
    raise exception 'that player is not on your market' using errcode = 'P0002';
  end if;
  select count(*) into v_active from public.game_players where franchise_id = v_f and status = 'active';
  if v_active >= (m->>'roster_max')::int then
    raise exception 'the roster is full at %: release a player first', (m->>'roster_max')::int using errcode = '55000';
  end if;
  if f.team_credits < p.asking then
    raise exception 'not enough Team Credits: % needed, % on hand', p.asking, f.team_credits using errcode = '55000';
  end if;
  ok := public.franchise_credit(v_f, 'tc', -p.asking, 'signing', p.id::text, 'Signed ' || p.first_name || ' ' || p.last_name);
  if not ok then raise exception 'that signing is already on the books' using errcode = '55000'; end if;
  select coalesce(max(depth), 0) + 1 into v_depth from public.game_players where franchise_id = v_f and position = p.position and status = 'active';
  select label into v_label from public.franchise_seasons where franchise_id = v_f and number = f.market_season;
  update public.game_players
     set status = 'active', depth = v_depth, acquired_source = 'free_agent', acquired_season = v_real,
         jersey = public.franchise_free_number(v_f, p.position, p.id::text),
         acquired_detail = 'Signed as a free agent before ' || coalesce(v_label, 'Season ' || public.games_roman(f.market_season)),
         updated_at = now()
   where id = p.id;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'signing', p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position, 'overall', p.overall,
                             'cost', p.asking, 'currency', 'tc', 'window', f.market_season))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_f, 'first_signing', v_real, jsonb_build_object('player', p.id, 'cost', p.asking)) then
    v_new := array_append(v_new, 'first_signing');
  end if;
  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'player', public.franchise_prospect_json(p), 'cost', p.asking, 'currency', 'tc',
    'roster_active', v_active + 1, 'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- A RELEASE. The roster has a floor, and every position keeps at least
-- its starters; a released player is gone for good. Free, irreversible,
-- and on the record.
create or replace function public.franchise_release(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); p public.game_players%rowtype; m jsonb := public.franchise_market();
  v_active integer; v_at_pos integer; v_starters integer; k integer := 0; r record;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  perform 1 from public.franchises where id = v_f for update;
  select * into p from public.game_players where id = p_player and franchise_id = v_f and status = 'active' for update;
  if not found then raise exception 'that player is not on your roster' using errcode = 'P0002'; end if;
  select count(*) into v_active from public.game_players where franchise_id = v_f and status = 'active';
  if v_active <= (m->>'roster_min')::int then
    raise exception 'the roster cannot go below %', (m->>'roster_min')::int using errcode = '55000';
  end if;
  v_starters := case p.position when 'WR' then 3 when 'OL' then 5 when 'DL' then 4 when 'LB' then 3
                                when 'CB' then 2 when 'S' then 2 else 1 end;
  select count(*) into v_at_pos from public.game_players where franchise_id = v_f and position = p.position and status = 'active';
  if v_at_pos - 1 < v_starters then
    raise exception 'you need at least % at %', v_starters, p.position using errcode = '55000';
  end if;
  update public.game_players set status = 'released', updated_at = now() where id = p.id;
  for r in select id from public.game_players where franchise_id = v_f and position = p.position and status = 'active' order by depth, overall desc loop
    k := k + 1;
    update public.game_players set depth = k where id = r.id;
  end loop;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'release', p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position, 'overall', p.overall, 'age', p.age))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true,
    'released', jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'overall', p.overall),
    'roster_active', v_active - 1, 'roster', public.franchise_roster(p_secret));
end;
$$;

commit;

begin;

-- ── the public side of the weekly game ────────────────────────────────────

-- START A SEASON. A franchise still in preseason gets its schedule; a
-- franchise whose season is complete gets the next one, numbered on, with
-- the season lines reset and the careers kept. A season under way is left
-- alone and the answer says so.
create or replace function public.franchise_start_season(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); s public.franchise_seasons%rowtype;
  v_n integer; v_started boolean := false; v_real integer := public.games_season_of(now());
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  perform 1 from public.franchises where id = v_f for update;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found then raise exception 'no season' using errcode = 'P0002'; end if;
  if s.status = 'preseason' then
    perform public.franchise_open_season(v_f, s.number, now());
    v_n := s.number; v_started := true;
  elsif s.status = 'complete' then
    -- the offseason first: ageing, development, retirements and rookies,
    -- reported once on the season that just ended
    perform public.franchise_offseason(v_f, s.number);
    v_n := s.number + 1;
    insert into public.franchise_seasons (franchise_id, number, label, season, status, weeks)
    values (v_f, v_n, 'Season ' || public.games_roman(v_n), v_real, 'preseason', s.weeks);
    update public.game_players set season_stats = '{}'::jsonb, updated_at = now() where franchise_id = v_f;
    perform public.franchise_open_season(v_f, v_n, now());
    v_started := true;
  else
    v_n := s.number;
  end if;
  return jsonb_build_object('ok', true, 'started', v_started, 'season_number', v_n, 'home', public.franchise_home(p_secret));
end;
$$;

-- PLAY THIS WEEK'S GAME. The only input is "play".
create or replace function public.franchise_play_week(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret);
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  return public.franchise_play_game(v_f, now());
end;
$$;

-- THE SCHEDULE: a season's games with results, every season's record, the
-- all-time record, the rival and the rivalry, and this week's preparation.
create or replace function public.franchise_schedule(p_number integer default null, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; v_n integer; v_games jsonb; v_seasons jsonb; v_rival jsonb; v_record jsonb;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select coalesce(p_number, max(number)) into v_n from public.franchise_seasons where franchise_id = f.id;
  select coalesce(jsonb_agg(public.franchise_game_json(g.id, false) order by g.week), '[]'::jsonb) into v_games
    from public.franchise_games g where g.franchise_id = f.id and g.season_number = v_n;
  select coalesce(jsonb_agg(public.franchise_season_json(f.id, s.number) order by s.number desc), '[]'::jsonb) into v_seasons
    from public.franchise_seasons s where s.franchise_id = f.id;
  select jsonb_build_object('wins', coalesce(sum(wins), 0), 'losses', coalesce(sum(losses), 0), 'ties', coalesce(sum(ties), 0),
      'points_for', coalesce(sum(points_for), 0), 'points_against', coalesce(sum(points_against), 0), 'seasons', count(*) filter (where status = 'complete'))
    into v_record from public.franchise_seasons where franchise_id = f.id;
  select jsonb_build_object('key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr, 'logo', o.logo, 'theme', o.theme,
      'offense', o.offense, 'defense', o.defense, 'style', o.style,
      'wins', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'W'),
      'losses', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'L'),
      'ties', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'T'))
    into v_rival from public.franchise_opponents o where o.key = f.rival_key;
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season,
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'season', public.franchise_season_json(f.id, v_n), 'games', v_games, 'seasons', v_seasons,
    'record', v_record, 'rival', v_rival,
    'prep', public.franchise_prep(f.id, public.games_week_key(now())),
    'scheme_edges', public.franchise_scheme_edges());
end;
$$;

-- ONE GAME, with its box. Yours, or nothing.
create or replace function public.franchise_game(p_game uuid, p_secret text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select public.franchise_game_json(g.id, true)
  from public.franchise_games g
  where g.id = p_game and g.franchise_id = public.franchise_of(p_secret);
$$;

commit;

begin;

-- ── read models ───────────────────────────────────────────────────────────

-- HOME. Everything the HQ paints, in one call.
create or replace function public.franchise_home(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; v_week text := public.games_week_key(now()); v_season integer;
  v_wk jsonb; v_ach jsonb; v_ss jsonb; v_recent jsonb; v_conf jsonb; v_cid uuid;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  v_cid := public.franchise_conference_of(f.id);
  if v_cid is not null then
    v_conf := public.franchise_conference_json(v_cid) || jsonb_build_object(
      'place', (select (j->>'place')::int from jsonb_array_elements(public.franchise_conference_standings_json(v_cid)) j
                 where (j->'franchise'->>'id')::uuid = f.id),
      'line', (select (j->>'wins') || '–' || (j->>'losses') || (case when (j->>'ties')::int > 0 then '–' || (j->>'ties') else '' end)
                 from jsonb_array_elements(public.franchise_conference_standings_json(v_cid)) j
                where (j->'franchise'->>'id')::uuid = f.id),
      'titles', (select coalesce(m.titles, 0) from public.franchise_conference_members m
                  where m.conference_id = v_cid and m.franchise_id = f.id),
      'ready', exists (select 1 from public.franchise_conference_games g
                        where g.conference_id = v_cid and g.status = 'scheduled' and g.opens_at <= now()
                          and g.season_number = (select season_number from public.franchise_conferences where id = v_cid)),
      'next', (select public.franchise_conference_game_json(g.id, false) from public.franchise_conference_games g
                where g.conference_id = v_cid and g.status = 'scheduled' and (g.a_id = f.id or g.b_id = f.id)
                order by g.round limit 1));
  end if;
  select jsonb_build_object(
      'week_key', v_week,
      'price_it', count(*) filter (where kind = 'price_it'),
      'price_it_avg_score', round(avg((detail->>'score')::numeric) filter (where kind = 'price_it')),
      'pick5_submitted', count(*) filter (where kind = 'pick5_card') > 0,
      'pick5_correct', count(*) filter (where kind = 'pick5_result' and detail->>'result' = 'win'),
      'pick5_decided', count(*) filter (where kind = 'pick5_result' and detail->>'result' in ('win', 'loss')),
      'drills', count(*) filter (where kind = 'drill_daily'),
      'research', count(*) filter (where kind = 'research_open'),
      'h2h', count(*) filter (where kind = 'h2h_locked'),
      'h2h_wins', count(*) filter (where kind = 'h2h_win'),
      'fc', count(*) filter (where kind = 'fc_played'),
      'fc_wins', count(*) filter (where kind = 'fc_win'),
      'conf', count(*) filter (where kind = 'conf_game'),
      'conf_wins', count(*) filter (where kind = 'conf_win'))
    into v_wk from public.franchise_activity where franchise_id = f.id and week_key = v_week;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.achievement_id, 'name', d.name, 'description', d.description,
      'season', a.season, 'earned_at', a.earned_at, 'exclusive_season', d.exclusive_season) order by d.sort), '[]'::jsonb)
    into v_ach from public.franchise_achievements a join public.franchise_achievement_defs d on d.id = a.achievement_id
    where a.franchise_id = f.id;
  select jsonb_build_object('number', s.number, 'label', s.label, 'season', s.season, 'status', s.status,
      'weeks', s.weeks, 'week', s.week, 'wins', s.wins, 'losses', s.losses, 'ties', s.ties,
      'points_for', s.points_for, 'points_against', s.points_against)
    into v_ss from public.franchise_seasons s where s.franchise_id = f.id order by s.number desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('currency', l.currency, 'delta', l.delta, 'kind', l.kind, 'label', l.label, 'at', l.created_at)
      order by l.created_at desc, l.id desc), '[]'::jsonb)
    into v_recent from (select * from public.franchise_ledger where franchise_id = f.id order by created_at desc, id desc limit 12) l;
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo,
      'theme', f.theme, 'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season, 'created_at', f.created_at,
      -- 'account' once claimed; 'device' while it lives on the secret alone
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'resources', public.franchise_totals(f.id),
    'rating', public.franchise_team_rating(f.id),
    'season', v_ss,
    'week', v_wk,
    'achievements', v_ach,
    'recent', v_recent,
    'roster_count', (select count(*) from public.game_players where franchise_id = f.id and status = 'active'),
    -- the treatment room (Phase 7): who cannot play, and when the first of
    -- them is back. The roster count is unchanged — a hurt man is still yours
    'injuries', (select jsonb_build_object(
        'out', count(*) filter (where not public.franchise_is_available(p.status, p.injured_until)),
        'back_at', min(p.injured_until) filter (where not public.franchise_is_available(p.status, p.injured_until)),
        'names', coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name,
            'position', p.position, 'injury', p.injury, 'until', p.injured_until)
            order by p.injured_until) filter (where not public.franchise_is_available(p.status, p.injured_until)), '[]'::jsonb))
      from public.game_players p where p.franchise_id = f.id and p.status = 'active'),
    -- the weekly game: who is next, what happened last, how prepared this
    -- week is (the server's number), the all-time record and the rival
    'next_game', (select public.franchise_game_json(g.id, false) from public.franchise_games g
                   where g.franchise_id = f.id and g.season_number = (v_ss->>'number')::int and g.status = 'scheduled'
                   order by g.week limit 1),
    'last_game', (select public.franchise_game_json(g.id, false) from public.franchise_games g
                   where g.franchise_id = f.id and g.status = 'final' order by g.played_at desc, g.week desc limit 1),
    'prep', public.franchise_prep(f.id, v_week),
    'record', (select jsonb_build_object('wins', coalesce(sum(wins), 0), 'losses', coalesce(sum(losses), 0), 'ties', coalesce(sum(ties), 0),
                 'seasons', count(*) filter (where status = 'complete')) from public.franchise_seasons where franchise_id = f.id),
    'rival', (select jsonb_build_object('key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr, 'logo', o.logo, 'theme', o.theme,
                 'wins', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'W'),
                 'losses', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'L'),
                 'ties', (select count(*) from public.franchise_games g where g.franchise_id = f.id and g.rival and g.result = 'T'))
               from public.franchise_opponents o where o.key = f.rival_key),
    -- franchise vs franchise: where I stand, and the last one played
    'ladder', jsonb_build_object('rating', f.ladder_rating, 'games', f.ladder_games, 'rank', public.franchise_ladder_rank(f.id)),
    -- WHAT TURNING UP IS WORTH, on the page a player actually opens. The rank
    -- and the packs it owes were reachable only from /games/packs/, which on a
    -- phone is not in the tab bar at all — so the one moment the whole
    -- progression pays out was invisible to the player it was built for.
    -- Derived, so this adds no write and cannot drift from the record.
    'reputation', public.franchise_rank_report(f.id),
    'facilities', coalesce(f.facilities, '{}'::jsonb),
    -- the coaching staff (Phase 8): who is in the building, and what it cost
    'staff', (select jsonb_build_object(
        'filled', count(*), 'seats', jsonb_array_length(public.franchise_staff()->'seats'),
        'levels', coalesce(sum(m.level), 0), 'best', coalesce(max(m.level), 0),
        'hire_cost', (public.franchise_staff()->>'hire_cost')::int,
        'next_cost', min(public.franchise_staff_cost(m.level)))
      from public.franchise_staff_members m where m.franchise_id = f.id),
    'offseason', (select s.offseason - 'players' from public.franchise_seasons s where s.franchise_id = f.id and s.offseason is not null order by s.number desc limit 1),
    -- the draft and the market: what is on the board and what a report costs
    'market', jsonb_build_object('window', f.market_season, 'picks', f.draft_picks,
      'prospects', (select count(*) from public.game_players where franchise_id = f.id and status = 'prospect' and class_season = f.market_season),
      'unscouted', (select count(*) from public.game_players where franchise_id = f.id and status = 'prospect' and class_season = f.market_season and not scouted),
      'agents', (select count(*) from public.game_players where franchise_id = f.id and status = 'free_agent' and class_season = f.market_season),
      'active', (select count(*) from public.game_players where franchise_id = f.id and status = 'active'),
      'max', (public.franchise_market()->>'roster_max')::int,
      /* what a report costs on THIS class — the grade it was found under, or
         the flat price for a class opened before Phase 9 */
      'scout_sp', case when f.scout_grade is null then (public.franchise_market()->>'scout_sp')::int
                       else public.franchise_scout_cost(f.scout_grade) end,
      'scout_grade', f.scout_grade),
    -- the scouting department (Phase 9): how well this franchise is reading
    -- real games right now, and what the next window would be worth
    'scouting', public.franchise_scout_report(f.id),
    -- where the franchise stands in the league, and what the next slate is
    -- drawn around (Phase 10, league_v1)
    'standing', jsonb_build_object('value', f.standing,
      'facing', 50 + round(f.standing * 0.40)::int,
      'top', (select max(strength) from public.franchise_opponents),
      'bottom', (select min(strength) from public.franchise_opponents),
      'above', (select count(*) from public.franchise_opponents o
                 where public.franchise_league_gap(f.standing, o.strength) > 0)),
    -- the development window (Phase 10): open only between a completed
    -- season and the next one, which is the whole ritual
    'development', jsonb_build_object(
      'open', exists (select 1 from public.franchise_seasons x
                       where x.franchise_id = f.id and x.status = 'complete'
                         and x.number = (select max(number) from public.franchise_seasons where franchise_id = f.id)),
      'slots', public.franchise_dev_slots(f.id),
      'used', (select count(*) from public.franchise_activity a
                where a.franchise_id = f.id and a.kind = 'program'
                  and a.key like (select max(number) from public.franchise_seasons where franchise_id = f.id) || ':%'),
      'version', public.franchise_development()->>'version'),
    'challenges', jsonb_build_object(
      'open', (select count(*) from public.franchise_challenges c where c.challenger_id = f.id and c.status = 'OPEN' and c.expires_at > now()),
      'played', (select count(*) from public.franchise_challenges c where (c.challenger_id = f.id or c.opponent_id = f.id) and c.status = 'FINAL'),
      'last', (select public.franchise_challenge_json(c.id, f.id) - 'box' from public.franchise_challenges c
                where (c.challenger_id = f.id or c.opponent_id = f.id) and c.status = 'FINAL' order by c.played_at desc limit 1)),
    -- the conference (Phase 6): where the franchise stands in its league of
    -- friends, whether a round is waiting to be played, and the titles won
    'conference', v_conf,
    -- THE GAME YOU HOLD (Phase 21): the man most recently kept from a pack,
    -- for the storyline on Game Day, and how the live games are counting
    'weapon', (select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'overall', p.overall,
                 'depth', p.depth, 'tier', public.franchise_card_tier(p.overall), 'kept_at', a.created_at, 'live_stats', p.live_stats,
                 'games_since', (select count(*) from public.franchise_activity g
                                  where g.franchise_id = f.id and g.kind in ('live_game', 'live_game_extra') and g.created_at > a.created_at))
                 from public.game_players p join public.franchise_activity a on a.franchise_id = f.id and a.kind = 'signing' and a.key = p.id::text
                where p.franchise_id = f.id and p.status = 'active' and p.acquired_source = 'pack'
                order by a.created_at desc limit 1),
    'live', public.franchise_gameday_progress(f.id),
    'economy', public.franchise_economy()->>'version');
end;
$$;

-- ROSTER. Every active player, in depth order, with the team rating.
create or replace function public.franchise_roster(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; v_players jsonb;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'position', p.position, 'jersey', p.jersey,
      'age', p.age, 'overall', p.overall, 'archetype', p.archetype, 'dev_tier', p.dev_tier, 'potential', p.potential,
      'stamina', p.stamina, 'chemistry', p.chemistry, 'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits,
      'depth', p.depth, 'status', p.status, 'acquired_source', p.acquired_source, 'acquired_season', p.acquired_season,
      'acquired_detail', p.acquired_detail, 'career_stats', p.career_stats, 'season_stats', p.season_stats, 'live_stats', p.live_stats,
      -- hurt or fit, and when he is back (Phase 7)
      'available', public.franchise_is_available(p.status, p.injured_until),
      'injured_until', p.injured_until, 'injury', p.injury)
      order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth, p.overall desc), '[]'::jsonb)
    into v_players from public.game_players p where p.franchise_id = f.id and p.status = 'active';
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season,
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'rating', public.franchise_team_rating(f.id),
    'starters', jsonb_build_object('QB', 1, 'RB', 1, 'WR', 3, 'TE', 1, 'OL', 5, 'DL', 4, 'LB', 3, 'CB', 2, 'S', 2, 'K', 1, 'P', 1),
    'injuries', public.franchise_injuries(),
    'injured', (select count(*) from public.game_players p where p.franchise_id = f.id and p.status = 'active'
                 and not public.franchise_is_available(p.status, p.injured_until)),
    'players', v_players);
end;
$$;

-- THE LEDGER, most recent first, for the Front Office.
create or replace function public.franchise_ledger_recent(p_limit integer default 50, p_secret text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('currency', l.currency, 'delta', l.delta, 'kind', l.kind, 'key', l.key,
      'label', l.label, 'economy', l.economy, 'at', l.created_at) order by l.created_at desc, l.id desc), '[]'::jsonb)
  from (select * from public.franchise_ledger
         where franchise_id = public.franchise_of(p_secret)
         order by created_at desc, id desc limit greatest(1, least(coalesce(p_limit, 50), 200))) l;
$$;

-- THIS WEEK'S CARD, for the Pick 5 page.
create or replace function public.franchise_pick5_mine(p_week_key text default null, p_secret text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select public.franchise_pick5_card(c.id)
  from public.franchise_pick5_cards c
  where c.franchise_id = public.franchise_of(p_secret)
    and c.week_key = coalesce(p_week_key, public.games_week_key(now()));
$$;

commit;

-- ===========================================================================
-- THE TRUSTED SIDE: the board publisher, Pick 5 settlement, the H2H trigger.
-- game_board_upsert and franchise_settle_pick5 are granted to NO client role.
-- ===========================================================================

begin;

-- Upsert rows of the committed artifact. `kickoff` arrives as an ISO instant
-- (the exporter stamps kickoffs UTC). A row that carries finals lands them;
-- a row without them never erases finals already landed.
create or replace function public.game_board_upsert(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; n integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if (r->>'game_id') is null then continue; end if;
    insert into public.game_board as b
      (game_id, season, week, slug, home_team, away_team, kickoff, neutral_site, edgedesk_spread, market_spread,
       confidence, research_state, status, final_home, final_away, final_at, published_at, updated_at)
    values
      (r->>'game_id', nullif(r->>'season', '')::int, nullif(r->>'week', '')::int, r->>'slug', r->>'home_team', r->>'away_team',
       nullif(r->>'kickoff', '')::timestamptz, coalesce((r->>'neutral_site')::boolean, false),
       nullif(r->>'edgedesk_spread', '')::numeric, nullif(r->>'market_spread', '')::numeric,
       nullif(r->>'confidence', '')::int, r->>'research_state', r->>'status',
       nullif(r->>'final_home', '')::int, nullif(r->>'final_away', '')::int,
       case when (r->>'final_home') is not null then now() end, now(), now())
    on conflict (game_id) do update set
      season = coalesce(excluded.season, b.season),
      week = coalesce(excluded.week, b.week),
      slug = coalesce(excluded.slug, b.slug),
      home_team = coalesce(excluded.home_team, b.home_team),
      away_team = coalesce(excluded.away_team, b.away_team),
      kickoff = coalesce(excluded.kickoff, b.kickoff),
      neutral_site = coalesce(excluded.neutral_site, b.neutral_site),
      edgedesk_spread = coalesce(excluded.edgedesk_spread, b.edgedesk_spread),
      market_spread = coalesce(excluded.market_spread, b.market_spread),
      confidence = coalesce(excluded.confidence, b.confidence),
      research_state = coalesce(excluded.research_state, b.research_state),
      status = coalesce(excluded.status, b.status),
      final_home = coalesce(excluded.final_home, b.final_home),
      final_away = coalesce(excluded.final_away, b.final_away),
      final_at = coalesce(b.final_at, excluded.final_at),
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- SETTLE PICK 5 from the board's finals. Idempotent: a selection with a
-- result is never regraded, a card with a settlement is never recounted, and
-- every credit is keyed once.
create or replace function public.franchise_settle_pick5()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record; c record; v_res text; v_sel integer := 0; v_cards integer := 0; v_perfect integer := 0;
  v_correct integer; v_decided integer; v_total integer; v_open integer; v_season integer;
begin
  for s in select sel.card_id, sel.game_id, sel.pick, sel.market_spread, cd.franchise_id, cd.week_key,
                  b.final_home, b.final_away, b.home_team, b.away_team, b.season
             from public.franchise_pick5_selections sel
             join public.franchise_pick5_cards cd on cd.id = sel.card_id
             join public.game_board b on b.game_id = sel.game_id
            where sel.result is null and cd.imported = false
              and b.final_home is not null and b.final_away is not null
  loop
    v_res := public.games_ats_result(s.market_spread, s.final_home, s.final_away);
    if v_res is null then continue; end if;
    update public.franchise_pick5_selections
       set result = case when v_res = 'push' then 'push' when v_res = s.pick then 'win' else 'loss' end,
           settled_at = now()
     where card_id = s.card_id and game_id = s.game_id;
    v_res := case when v_res = 'push' then 'push' when v_res = s.pick then 'win' else 'loss' end;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
    values (s.franchise_id, 'pick5_result', s.week_key || ':' || s.game_id, s.week_key, public.games_day_key(now()),
            jsonb_build_object('game_id', s.game_id, 'pick', s.pick, 'result', v_res, 'market_spread', s.market_spread,
                               'final_home', s.final_home, 'final_away', s.final_away))
    on conflict do nothing;
    if v_res = 'win' then
      perform public.franchise_credit(s.franchise_id, 'xp', (public.franchise_economy()->'pick5_correct'->>'xp')::int,
        'pick5_correct', s.week_key || ':' || s.game_id, 'Correct side: ' || coalesce(case when s.pick = 'home' then s.home_team else s.away_team end, s.game_id));
      perform public.franchise_credit(s.franchise_id, 'tc', (public.franchise_economy()->'pick5_correct'->>'tc')::int,
        'pick5_correct', s.week_key || ':' || s.game_id, 'Correct side: ' || coalesce(case when s.pick = 'home' then s.home_team else s.away_team end, s.game_id));
    end if;
    v_sel := v_sel + 1;
  end loop;

  for c in select cd.id, cd.franchise_id, cd.week_key from public.franchise_pick5_cards cd
            where cd.settled_at is null and cd.imported = false
  loop
    select count(*) filter (where result = 'win'), count(*) filter (where result in ('win', 'loss')),
           count(*), count(*) filter (where result is null)
      into v_correct, v_decided, v_total, v_open
      from public.franchise_pick5_selections where card_id = c.id;
    update public.franchise_pick5_cards set correct = v_correct, decided = v_decided where id = c.id;
    if v_open = 0 and v_total > 0 then
      update public.franchise_pick5_cards set settled_at = now() where id = c.id;
      v_cards := v_cards + 1;
      if v_total = 5 and v_correct = 5 then
        v_season := public.games_season_of(now());
        perform public.franchise_credit(c.franchise_id, 'xp', (public.franchise_economy()->'pick5_perfect'->>'xp')::int,
          'pick5_perfect', c.week_key, 'Perfect card, week of ' || c.week_key);
        perform public.franchise_credit(c.franchise_id, 'tc', (public.franchise_economy()->'pick5_perfect'->>'tc')::int,
          'pick5_perfect', c.week_key, 'Perfect card, week of ' || c.week_key);
        perform public.franchise_award(c.franchise_id, 'perfect_card', v_season, jsonb_build_object('week', c.week_key));
        v_perfect := v_perfect + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('selections_settled', v_sel, 'cards_settled', v_cards, 'perfect_cards', v_perfect);
end;
$$;

-- A SETTLED HEAD-TO-HEAD becomes Coach Points and XP for each player who owns
-- a franchise. Fired by the settlement games_social.sql already performs;
-- that file is not changed. Keyed on the challenge, so a correction that
-- re-settles credits nothing twice (and does not retract — a correction is
-- visible in game_challenge_corrections, and the ledger is append-only).
create or replace function public.franchise_on_h2h_settled()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare e record; v_f uuid; v_key text := new.id::text; v_label text; v_fa uuid; v_fb uuid; v_res_a text; v_fresh boolean := true; n integer;
begin
  if new.settled_at is null then return new; end if;
  v_label := coalesce(new.away_team, '?') || ' vs ' || coalesce(new.home_team, '?');
  -- an entry is an account or a device secret; a franchise may be either
  for e in select * from public.game_challenge_entries where challenge_id = new.id loop
    v_f := null;
    if e.user_id is not null then
      select id into v_f from public.franchises where user_id = e.user_id;
    elsif e.anon_hash is not null then
      select id into v_f from public.franchises where anon_hash = e.anon_hash or claimed_hash = e.anon_hash;
    end if;
    if v_f is null then continue; end if;
    if e.player_slot = 'a' then v_fa := v_f; v_res_a := case e.result when 'win' then 'W' when 'loss' then 'L' when 'draw' then 'T' end;
    else v_fb := v_f; end if;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
    values (v_f, 'h2h_locked', v_key, public.games_week_key(now()), public.games_day_key(now()),
            jsonb_build_object('challenge', new.invite_token, 'mode', new.mode, 'result', e.result, 'game', v_label))
    on conflict do nothing;
    get diagnostics n = row_count;
    if n = 0 then v_fresh := false; end if;   -- a correction: credited before, the rivalry already counted
    perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'h2h_locked'->>'xp')::int, 'h2h_locked', v_key, 'Head-to-Head: ' || v_label);
    perform public.franchise_credit(v_f, 'cp', (public.franchise_economy()->'h2h_locked'->>'cp')::int, 'h2h_locked', v_key, 'Head-to-Head: ' || v_label);
    if e.result = 'win' then
      insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
      values (v_f, 'h2h_win', v_key, public.games_week_key(now()), public.games_day_key(now()),
              jsonb_build_object('challenge', new.invite_token, 'mode', new.mode, 'game', v_label))
      on conflict do nothing;
      perform public.franchise_credit(v_f, 'xp', (public.franchise_economy()->'h2h_win'->>'xp')::int, 'h2h_win', v_key, 'Head-to-Head win: ' || v_label);
      perform public.franchise_credit(v_f, 'cp', (public.franchise_economy()->'h2h_win'->>'cp')::int, 'h2h_win', v_key, 'Head-to-Head win: ' || v_label);
      perform public.franchise_award(v_f, 'first_h2h_win', public.games_season_of(now()), jsonb_build_object('challenge', new.invite_token));
    end if;
  end loop;
  -- two franchises on one board: the rivalry between them moves once, on
  -- the first settlement. A correction re-settles, and like the ledger the
  -- rivalry record is append-only: it is not rewritten.
  if v_fa is not null and v_fb is not null and v_res_a is not null and v_fresh then
    perform public.franchise_rivalry_bump(v_fa, v_fb, 'h2h', v_res_a);
  end if;
  return new;
end;
$$;

drop trigger if exists franchise_h2h_settled on public.game_challenges;
create trigger franchise_h2h_settled
  after update of settled_at on public.game_challenges
  for each row
  when (new.settled_at is not null and old.settled_at is distinct from new.settled_at)
  execute function public.franchise_on_h2h_settled();

commit;

-- ===========================================================================
-- CONFERENCES AND PLAYOFFS — Phase 6, conference_v1
--
-- A LEAGUE OF FRIENDS WITH STANDINGS OF ITS OWN. Phase 3 gave a franchise a
-- one-off game against another franchise; a conference gives it a season
-- against several: a round robin drawn on the server, one round a football
-- week, standings that are the sum of what happened, a bracket at the end
-- and a title that stays on the record.
--
-- It is the same simulator, the same neutral field and the same ladder the
-- challenge already uses. What is new is the SHAPE: a table of franchises
-- that all play each other, a round that opens on a clock rather than on an
-- invite, seeds drawn from the standings, and a champion.
--
-- WHO DECIDES WHAT
--   * the commissioner (the franchise that created it) names it, and starts
--     a season when the conference is full enough;
--   * the SERVER draws the schedule, from the conference's own seed, so
--     nobody picks their own opponents or their own week;
--   * ANY member may advance the conference — the round is played once, on
--     the server, and a second caller changes nothing. There is no cron and
--     no privileged client: whoever opens the page after the round opens
--     plays it for everybody.
--
-- A CONFERENCE IS FRANCHISES, NEVER ACCOUNTS. Every row a member reads names
-- a franchise — a city, a mark, a record. The invite is a link, the same
-- shape Head-to-Head and the challenge already use, and a franchise founded
-- on a device secret joins on the same terms as one on an account.
-- ===========================================================================

begin;

-- THE CONFERENCE. One row per league; its season state lives here, and the
-- permanent record of each season it has finished lives in
-- franchise_conference_titles.
create table if not exists public.franchise_conferences (
  id               uuid primary key default gen_random_uuid(),
  invite_token     text not null unique default public.games_token(),
  name             text not null check (char_length(name) between 2 and 32),
  commissioner_id  uuid not null references public.franchises (id) on delete cascade,
  seed             text not null,
  status           text not null default 'forming'
                     check (status in ('forming', 'regular', 'playoffs', 'complete')),
  season_number    integer not null default 0 check (season_number >= 0),
  rounds           integer not null default 0 check (rounds >= 0),   -- regular rounds this season
  playoff_teams    integer not null default 0 check (playoff_teams in (0, 2, 4)),
  champion_id      uuid references public.franchises (id) on delete set null,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);

create index if not exists franchise_conferences_commissioner on public.franchise_conferences (commissioner_id);

-- A MEMBER, and its standing in the season under way. A franchise belongs to
-- at most one conference at a time — the unique key says so rather than a
-- comment — and leaving deletes the row; what it earned stays on the title
-- record and on its own ledger.
create table if not exists public.franchise_conference_members (
  conference_id    uuid not null references public.franchise_conferences (id) on delete cascade,
  franchise_id     uuid not null unique references public.franchises (id) on delete cascade,
  role             text not null default 'member' check (role in ('commissioner', 'member')),
  joined_at        timestamptz not null default now(),
  wins             integer not null default 0,
  losses           integer not null default 0,
  ties             integer not null default 0,
  points_for       integer not null default 0,
  points_against   integer not null default 0,
  seed             integer,                    -- set when the regular rounds end
  eliminated       boolean not null default false,
  titles           integer not null default 0,
  primary key (conference_id, franchise_id)
);

-- ONE CONFERENCE GAME. Neutral, like every franchise-versus-franchise game:
-- two real rosters, two schemes, each side's own week of preparation. `a` is
-- the higher seed in a playoff round, which is also who advances from a tie
-- the overtime could not break.
create table if not exists public.franchise_conference_games (
  id               uuid primary key default gen_random_uuid(),
  conference_id    uuid not null references public.franchise_conferences (id) on delete cascade,
  season_number    integer not null,
  round            integer not null check (round >= 1),
  kind             text not null default 'regular' check (kind in ('regular', 'semifinal', 'final')),
  week_key         text not null,
  opens_at         timestamptz not null,
  a_id             uuid not null references public.franchises (id) on delete cascade,
  b_id             uuid not null references public.franchises (id) on delete cascade,
  a_seed           integer,
  b_seed           integer,
  status           text not null default 'scheduled' check (status in ('scheduled', 'final')),
  seed             text not null,
  played_at        timestamptz,
  score_a          integer,
  score_b          integer,
  result           text check (result in ('W', 'L', 'T')),   -- a's
  advanced_id      uuid references public.franchises (id) on delete set null,
  box              jsonb not null default '{}'::jsonb,
  sim_version      text,
  created_at       timestamptz not null default now(),
  constraint franchise_conference_games_two_sides check (a_id <> b_id),
  unique (conference_id, season_number, round, a_id)
);

create index if not exists franchise_conference_games_round
  on public.franchise_conference_games (conference_id, season_number, round, status);
create index if not exists franchise_conference_games_side
  on public.franchise_conference_games (a_id, played_at desc);
create index if not exists franchise_conference_games_side_b
  on public.franchise_conference_games (b_id, played_at desc);

-- A FINISHED CONFERENCE SEASON, frozen. The champion, the runner-up and the
-- standings exactly as they read when the final was played — so a franchise
-- that later leaves the conference is still in the record it earned.
create table if not exists public.franchise_conference_titles (
  conference_id    uuid not null references public.franchise_conferences (id) on delete cascade,
  season_number    integer not null,
  champion_id      uuid references public.franchises (id) on delete set null,
  runner_up_id     uuid references public.franchises (id) on delete set null,
  standings        jsonb not null default '[]'::jsonb,
  completed_at     timestamptz not null default now(),
  primary key (conference_id, season_number)
);

create index if not exists franchise_conference_titles_champion
  on public.franchise_conference_titles (champion_id, completed_at desc);

-- The record grows the kinds a conference writes.
alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release',
   'conf_joined','conf_season','conf_game','conf_win','conf_playoff','conf_title',
   'bowl_bid','injury','trade'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('bowl_bid',     'Bowl Bid',     'Finished a season with more wins than losses and earned the bowl.', null, 90),
  ('bowl_win',     'Bowl Winner',  'Won your bowl.', null, 91),
  ('trade_first',  'The Deal',     'Made a trade with another franchise.', null, 92),
  ('next_man_up',  'Next Man Up',  'Won a game with a starter unavailable.', null, 93)
on conflict (id) do nothing;

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('conf_first', 'League of Friends', 'Joined a conference of franchises.', null, 80),
  ('conf_top',   'Top Seed',          'Finished a conference regular season in first.', null, 81),
  ('conf_post',  'Postseason',        'Won a conference playoff game.', null, 82),
  ('conf_title', 'Champion',          'Won a conference title.', null, 83),
  ('conf_two',   'Two Rings',         'Won a second conference title.', null, 84)
on conflict (id) do nothing;

-- RLS: deny by default, as everywhere else. A member reads the conference it
-- is in, the members of it, its games and its titles — the invite link
-- included, because inviting a friend is what a member is for. A stranger
-- holding a link reads nothing from the tables; franchise_conference_peek()
-- decides what they may see, and nobody writes anything directly.
alter table public.franchise_conferences         enable row level security;
alter table public.franchise_conference_members  enable row level security;
alter table public.franchise_conference_games    enable row level security;
alter table public.franchise_conference_titles   enable row level security;

-- "Is the caller's account a member of this conference?" — a definer
-- function for the same reason franchise_is_mine is one: a policy that asks
-- its own table recurses.
create or replace function public.franchise_conference_is_mine(p_conference uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.franchise_conference_members m
      join public.franchises f on f.id = m.franchise_id
     where m.conference_id = p_conference and f.user_id = auth.uid());
$$;

drop policy if exists franchise_conferences_member on public.franchise_conferences;
create policy franchise_conferences_member on public.franchise_conferences for select
  using (public.franchise_conference_is_mine(id));

drop policy if exists franchise_conference_members_member on public.franchise_conference_members;
create policy franchise_conference_members_member on public.franchise_conference_members for select
  using (public.franchise_conference_is_mine(conference_id));

drop policy if exists franchise_conference_games_member on public.franchise_conference_games;
create policy franchise_conference_games_member on public.franchise_conference_games for select
  using (public.franchise_conference_is_mine(conference_id));

drop policy if exists franchise_conference_titles_member on public.franchise_conference_titles;
create policy franchise_conference_titles_member on public.franchise_conference_titles for select
  using (public.franchise_conference_is_mine(conference_id));

commit;

begin;

-- THE PUBLISHED TABLE — conference_v1. Sizes, the round cap, how many make
-- the bracket and what the ladder moves by, in one place, so the client can
-- render the rules without a round trip and the test can pin the two
-- together number for number.
create or replace function public.franchise_conference_config()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'conference_v1',
    'name_max', 32,
    'min_teams', 4, 'max_teams', 12, 'start_min', 4,
    'rounds_max', 7,
    'playoff_teams', 4, 'playoff_small', 2, 'playoff_large_from', 6,
    'ladder_k', 24,
    'tiebreak', jsonb_build_array('wins', 'point differential', 'points scored', 'ladder rating', 'joined first'));
$$;

-- How many franchises make the bracket, for a conference of n.
create or replace function public.franchise_conference_playoff_teams(p_n integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_n, 0) >= (public.franchise_conference_config()->>'playoff_large_from')::int
              then (public.franchise_conference_config()->>'playoff_teams')::int
              else (public.franchise_conference_config()->>'playoff_small')::int end;
$$;

-- ── read models ───────────────────────────────────────────────────────────

-- THE STANDINGS, in the order the tiebreak publishes: wins (a tie is half a
-- win), then point differential, then points scored, then ladder rating,
-- then who joined first. Every row is a FRANCHISE — a city, a mark, a
-- record — and never an account.
create or replace function public.franchise_conference_standings_json(p_conference uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'place', s.rn, 'franchise', public.franchise_identity_json(s.franchise_id),
      'role', s.role, 'wins', s.wins, 'losses', s.losses, 'ties', s.ties,
      'points_for', s.points_for, 'points_against', s.points_against,
      'diff', s.points_for - s.points_against, 'played', s.wins + s.losses + s.ties,
      'seed', s.seed, 'eliminated', s.eliminated, 'titles', s.titles) order by s.rn), '[]'::jsonb)
  from (select m.*, row_number() over (
            order by (m.wins * 2 + m.ties) desc, (m.points_for - m.points_against) desc,
                     m.points_for desc, f.ladder_rating desc, m.joined_at, m.franchise_id) as rn
          from public.franchise_conference_members m
          join public.franchises f on f.id = m.franchise_id
         where m.conference_id = p_conference) s;
$$;

-- ONE CONFERENCE GAME as the pages read it: both sides named, the score, and
-- the full box only when asked for.
create or replace function public.franchise_conference_game_json(p_game uuid, p_full boolean default false)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', g.id, 'season_number', g.season_number, 'round', g.round, 'kind', g.kind,
      'week_key', g.week_key, 'opens_at', g.opens_at, 'open', g.opens_at <= now(), 'status', g.status,
      'a', public.franchise_identity_json(g.a_id), 'b', public.franchise_identity_json(g.b_id),
      'a_seed', g.a_seed, 'b_seed', g.b_seed,
      'played_at', g.played_at, 'score_a', g.score_a, 'score_b', g.score_b, 'result', g.result,
      'ot', coalesce((g.box->>'ot')::boolean, false), 'advanced_id', g.advanced_id,
      'potg', case when g.status = 'final' then jsonb_build_object('a', g.box->'a'->'potg'->>'name', 'b', g.box->'b'->'potg'->>'name') end,
      'sim_version', g.sim_version,
      'box', case when p_full then g.box else null end)
  from public.franchise_conference_games g where g.id = p_game;
$$;

-- The conference itself, without the standings or the schedule: what a chip
-- or a line on the HQ needs.
create or replace function public.franchise_conference_json(p_conference uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status,
      'season_number', c.season_number, 'label', case when c.season_number > 0 then 'Season ' || public.games_roman(c.season_number) end,
      'rounds', c.rounds, 'playoff_teams', c.playoff_teams,
      'members', (select count(*) from public.franchise_conference_members m where m.conference_id = c.id),
      'commissioner', public.franchise_identity_json(c.commissioner_id),
      'champion', case when c.champion_id is not null then public.franchise_identity_json(c.champion_id) end,
      'created_at', c.created_at, 'started_at', c.started_at, 'completed_at', c.completed_at,
      'round_played', (select coalesce(max(g.round), 0) from public.franchise_conference_games g
                        where g.conference_id = c.id and g.season_number = c.season_number and g.status = 'final'),
      'next_opens_at', (select min(g.opens_at) from public.franchise_conference_games g
                         where g.conference_id = c.id and g.season_number = c.season_number and g.status = 'scheduled'))
  from public.franchise_conferences c where c.id = p_conference;
$$;

-- The conference a franchise belongs to, or null.
create or replace function public.franchise_conference_of(p_franchise uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select conference_id from public.franchise_conference_members where franchise_id = p_franchise;
$$;

commit;

begin;

-- ── the schedule ──────────────────────────────────────────────────────────

-- DRAW A SEASON. A single round robin by the circle method: one franchise
-- held still, the rest rotated a place a round, so everybody plays everybody
-- once and nobody plays twice in a round. An odd conference carries a ghost,
-- and whoever draws it has the week off. The order the franchises enter the
-- circle is seeded from the conference's own seed and the season number, so
-- the same conference always draws the same schedule and no client chooses
-- its own opponents. Rounds are capped by the published table, so a large
-- conference plays a partial round robin rather than a season without end.
create or replace function public.franchise_conference_draw(p_conference uuid, p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.franchise_conferences%rowtype; cfg jsonb := public.franchise_conference_config();
  ids uuid[]; n integer; m integer; l integer; v_rounds integer; r integer; t integer;
  ia uuid; ib uuid; wk text; opens timestamptz; made integer := 0;
  slot integer[];
begin
  select * into c from public.franchise_conferences where id = p_conference for update;
  if not found then raise exception 'no conference' using errcode = '22023'; end if;
  select array_agg(franchise_id order by md5(c.seed || ':' || c.season_number || ':' || franchise_id::text))
    into ids from public.franchise_conference_members where conference_id = p_conference;
  n := coalesce(array_length(ids, 1), 0);
  if n < (cfg->>'start_min')::int then
    raise exception 'a conference needs % franchises to start; there are %', (cfg->>'start_min')::int, n using errcode = '55000';
  end if;
  if exists (select 1 from public.franchise_conference_games
              where conference_id = p_conference and season_number = c.season_number) then
    return 0;
  end if;

  m := n + (n % 2);                       -- the ghost makes it even
  l := m - 1;                             -- the rotating places
  v_rounds := least((cfg->>'rounds_max')::int, l);

  for r in 1..v_rounds loop
    wk := public.games_week_key(p_now + ((r - 1) * interval '7 days'));
    opens := ((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC';
    -- the rotated places, 1..l, for this round (r - 1 turns of the circle)
    slot := array(select 2 + ((s - 1 + (r - 1)) % l) from generate_series(1, l) s);
    for t in 0..(m / 2 - 1) loop
      if t = 0 then
        ia := ids[1];                     -- the franchise held still
        ib := ids[slot[l]];
      else
        ia := ids[slot[t]];
        ib := ids[slot[l - t]];
      end if;
      -- a bye: the ghost sits at index m, which no franchise fills
      continue when ia is null or ib is null;
      insert into public.franchise_conference_games
        (conference_id, season_number, round, kind, week_key, opens_at, a_id, b_id, seed)
      values (p_conference, c.season_number, r, 'regular', wk, opens, ia, ib,
        md5(c.seed || ':g:' || c.season_number || ':' || r || ':' || ia::text || ':' || ib::text));
      made := made + 1;
    end loop;
  end loop;
  update public.franchise_conferences set rounds = v_rounds, playoff_teams = public.franchise_conference_playoff_teams(n)
   where id = p_conference;
  return made;
end;
$$;

-- SEED THE BRACKET. Called once, when the last regular round has been
-- played: every member takes the place the standings gave it, the ones who
-- did not make the bracket are eliminated, and the first playoff round is
-- scheduled for the following football week. Four make a bracket where the
-- conference is big enough for one; otherwise the top two meet in the final.
create or replace function public.franchise_conference_bracket(p_conference uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.franchise_conferences%rowtype; st jsonb; k integer; pt integer; n integer;
  wk text; opens timestamptz; base timestamptz; made integer := 0; s1 uuid; s2 uuid; s3 uuid; s4 uuid;
  row_ jsonb; v_season integer := public.games_season_of(now());
begin
  select * into c from public.franchise_conferences where id = p_conference for update;
  if not found then raise exception 'no conference' using errcode = '22023'; end if;
  st := public.franchise_conference_standings_json(p_conference);
  n := jsonb_array_length(st);
  pt := least(coalesce(nullif(c.playoff_teams, 0), public.franchise_conference_playoff_teams(n)), n);
  -- the place each member finished, and who is out
  for k in 0..n - 1 loop
    row_ := st->k;
    update public.franchise_conference_members
       set seed = k + 1, eliminated = (k + 1) > pt
     where conference_id = p_conference and franchise_id = (row_->'franchise'->>'id')::uuid;
  end loop;
  if n > 0 then
    perform public.franchise_award((st->0->'franchise'->>'id')::uuid, 'conf_top', v_season,
      jsonb_build_object('conference', p_conference, 'season_number', c.season_number));
  end if;

  -- the playoff round opens the football week after the last regular one
  select max(opens_at) into base from public.franchise_conference_games
   where conference_id = p_conference and season_number = c.season_number;
  wk := public.games_week_key(coalesce(base, now()) + interval '7 days');
  opens := ((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC';

  -- a bracket needs two sides. The only way a season reaches this with fewer
  -- is an account deleted mid-season taking its franchise with it; the
  -- season is closed where it stands rather than left half-drawn.
  if n < 2 then
    update public.franchise_conferences
       set status = 'complete', champion_id = case when n = 1 then (st->0->'franchise'->>'id')::uuid end,
           completed_at = now()
     where id = p_conference;
    return 0;
  end if;
  s1 := (st->0->'franchise'->>'id')::uuid;
  s2 := (st->1->'franchise'->>'id')::uuid;
  if pt >= 4 then
    s3 := (st->2->'franchise'->>'id')::uuid; s4 := (st->3->'franchise'->>'id')::uuid;
    insert into public.franchise_conference_games
      (conference_id, season_number, round, kind, week_key, opens_at, a_id, b_id, a_seed, b_seed, seed)
    values (p_conference, c.season_number, c.rounds + 1, 'semifinal', wk, opens, s1, s4, 1, 4,
            md5(c.seed || ':sf1:' || c.season_number)),
           (p_conference, c.season_number, c.rounds + 1, 'semifinal', wk, opens, s2, s3, 2, 3,
            md5(c.seed || ':sf2:' || c.season_number));
    made := 2;
  else
    insert into public.franchise_conference_games
      (conference_id, season_number, round, kind, week_key, opens_at, a_id, b_id, a_seed, b_seed, seed)
    values (p_conference, c.season_number, c.rounds + 1, 'final', wk, opens, s1, s2, 1, 2,
            md5(c.seed || ':fin:' || c.season_number));
    made := 1;
  end if;
  update public.franchise_conferences set status = 'playoffs', playoff_teams = pt where id = p_conference;
  return made;
end;
$$;

-- THE FINAL, once both semifinals are in: the two who advanced, the higher
-- seed listed first, the football week after the semifinals.
create or replace function public.franchise_conference_final(p_conference uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.franchise_conferences%rowtype; a uuid; b uuid; sa integer; sb integer;
  swap_id uuid; swap_seed integer;
  wk text; opens timestamptz; base timestamptz; sf_round integer;
begin
  select * into c from public.franchise_conferences where id = p_conference for update;
  if not found then return 0; end if;
  select round into sf_round from public.franchise_conference_games
   where conference_id = p_conference and season_number = c.season_number and kind = 'semifinal' limit 1;
  if sf_round is null then return 0; end if;
  if exists (select 1 from public.franchise_conference_games
              where conference_id = p_conference and season_number = c.season_number and kind = 'final') then
    return 0;
  end if;
  if exists (select 1 from public.franchise_conference_games
              where conference_id = p_conference and season_number = c.season_number and kind = 'semifinal' and status <> 'final') then
    return 0;
  end if;
  select g.advanced_id, case when g.advanced_id = g.a_id then g.a_seed else g.b_seed end, g.opens_at
    into a, sa, base
    from public.franchise_conference_games g
   where g.conference_id = p_conference and g.season_number = c.season_number and g.kind = 'semifinal'
   order by least(g.a_seed, g.b_seed) limit 1;
  select g.advanced_id, case when g.advanced_id = g.a_id then g.a_seed else g.b_seed end
    into b, sb
    from public.franchise_conference_games g
   where g.conference_id = p_conference and g.season_number = c.season_number and g.kind = 'semifinal'
   order by least(g.a_seed, g.b_seed) desc limit 1;
  if a is null or b is null or a = b then return 0; end if;
  if sb < sa then                                    -- the better seed is listed first
    swap_id := a; swap_seed := sa; a := b; sa := sb; b := swap_id; sb := swap_seed;
  end if;
  wk := public.games_week_key(coalesce(base, now()) + interval '7 days');
  opens := ((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC';
  insert into public.franchise_conference_games
    (conference_id, season_number, round, kind, week_key, opens_at, a_id, b_id, a_seed, b_seed, seed)
  values (p_conference, c.season_number, sf_round + 1, 'final', wk, opens, a, b, sa, sb,
          md5(c.seed || ':fin:' || c.season_number));
  return 1;
end;
$$;

commit;

begin;

-- ── playing a round ───────────────────────────────────────────────────────

-- ONE CONFERENCE GAME, played on the server. The same versus simulator a
-- challenge runs on: both rosters, both schemes, both weeks of preparation,
-- a neutral field, seeded from the conference's own seed so the same game
-- simulated twice is the same game. Both sides are paid by the table, keyed
-- once by the game; both careers grow by the box; the rivalry between them
-- moves; and both move on the ladder by the same ordinary Elo the challenge
-- uses. A playoff tie the overtime could not break advances the better seed,
-- and the row says so.
create or replace function public.franchise_conference_play_one(p_game uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g public.franchise_conference_games%rowtype; c public.franchise_conferences%rowtype;
  econ jsonb := public.franchise_economy(); v_box jsonb; pts_a integer; pts_b integer; res_a text;
  ra integer; rb integer; da integer; db integer; ln jsonb; adv uuid;
  side record; v_label text; v_season integer := public.games_season_of(p_now); v_titles integer;
begin
  select * into g from public.franchise_conference_games where id = p_game for update;
  if not found then raise exception 'no game' using errcode = 'P0002'; end if;
  if g.status = 'final' then return public.franchise_conference_game_json(g.id, false); end if;
  select * into c from public.franchise_conferences where id = g.conference_id;

  -- both franchise rows, in id order, so two callers cannot deadlock
  perform 1 from public.franchises where id in (g.a_id, g.b_id) order by id for update;
  select ladder_rating into ra from public.franchises where id = g.a_id;
  select ladder_rating into rb from public.franchises where id = g.b_id;

  v_box := public.franchise_sim_versus(g.a_id, g.b_id, g.seed, g.week_key);
  -- what the round cost each side
  v_box := jsonb_set(v_box, '{a,injuries}', public.franchise_draw_injuries(g.a_id, g.seed, g.week_key, p_now));
  v_box := jsonb_set(v_box, '{b,injuries}', public.franchise_draw_injuries(g.b_id, g.seed, g.week_key, p_now));
  pts_a := (v_box->'a'->>'final')::int; pts_b := (v_box->'b'->>'final')::int; res_a := v_box->>'result_a';
  -- a playoff cannot end level: the better seed is `a`, and advances
  adv := case when g.kind = 'regular' then null
              when pts_a >= pts_b then g.a_id else g.b_id end;
  da := public.games_elo_delta(ra, rb, case res_a when 'W' then 1 when 'L' then 0 else 0.5 end, (public.franchise_conference_config()->>'ladder_k')::int);
  db := public.games_elo_delta(rb, ra, case res_a when 'W' then 0 when 'L' then 1 else 0.5 end, (public.franchise_conference_config()->>'ladder_k')::int);

  update public.franchise_conference_games
     set status = 'final', played_at = p_now, score_a = pts_a, score_b = pts_b, result = res_a,
         advanced_id = adv, box = v_box, sim_version = v_box->>'sim'
   where id = g.id;
  update public.franchises set ladder_rating = ladder_rating + da, ladder_games = ladder_games + 1, updated_at = p_now where id = g.a_id;
  update public.franchises set ladder_rating = ladder_rating + db, ladder_games = ladder_games + 1, updated_at = p_now where id = g.b_id;
  perform public.franchise_rivalry_bump(g.a_id, g.b_id, 'fc', res_a);

  -- the standings are the sum of what happened, not a number a client sends
  update public.franchise_conference_members
     set wins = wins + (res_a = 'W')::int, losses = losses + (res_a = 'L')::int, ties = ties + (res_a = 'T')::int,
         points_for = points_for + pts_a, points_against = points_against + pts_b
   where conference_id = g.conference_id and franchise_id = g.a_id;
  update public.franchise_conference_members
     set wins = wins + (res_a = 'L')::int, losses = losses + (res_a = 'W')::int, ties = ties + (res_a = 'T')::int,
         points_for = points_for + pts_b, points_against = points_against + pts_a
   where conference_id = g.conference_id and franchise_id = g.b_id;
  if g.kind <> 'regular' and adv is not null then
    update public.franchise_conference_members set eliminated = true
     where conference_id = g.conference_id and franchise_id in (g.a_id, g.b_id) and franchise_id <> adv;
  end if;

  -- careers grow by the box on both sides; the solo season's lines do not —
  -- a conference is its own competition
  for ln in select * from jsonb_array_elements(v_box->'a'->'players') loop
    update public.game_players set career_stats = public.games_jsonb_sum(career_stats, ln->'stats'), updated_at = p_now
     where id = (ln->>'id')::uuid and franchise_id = g.a_id;
  end loop;
  for ln in select * from jsonb_array_elements(v_box->'b'->'players') loop
    update public.game_players set career_stats = public.games_jsonb_sum(career_stats, ln->'stats'), updated_at = p_now
     where id = (ln->>'id')::uuid and franchise_id = g.b_id;
  end loop;

  for side in
    select g.a_id as fid, res_a as res, pts_a as pf, pts_b as pa, (select name from public.franchises where id = g.b_id) as opp
    union all
    select g.b_id, case res_a when 'W' then 'L' when 'L' then 'W' else 'T' end, pts_b, pts_a,
           (select name from public.franchises where id = g.a_id)
  loop
    v_label := c.name || ' · ' || (case g.kind when 'regular' then 'Round ' || g.round when 'semifinal' then 'Semifinal' else 'The final' end)
      || ' vs ' || side.opp || ': ' || side.res || ' ' || side.pf || '–' || side.pa;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
    values (side.fid, 'conf_game', g.id::text, g.week_key, public.games_day_key(p_now),
      jsonb_build_object('conference', c.id, 'conference_name', c.name, 'game', g.id, 'season_number', g.season_number,
        'round', g.round, 'kind', g.kind, 'result', side.res, 'for', side.pf, 'against', side.pa, 'opponent', side.opp), p_now)
    on conflict (franchise_id, kind, key) do nothing;
    perform public.franchise_credit(side.fid, 'xp', (econ->'conf_game'->>'xp')::int, 'conf_game', g.id::text, v_label);
    perform public.franchise_credit(side.fid, 'tc', (econ->'conf_game'->>'tc')::int, 'conf_game', g.id::text, v_label);
    perform public.franchise_award(side.fid, 'conf_first', v_season, jsonb_build_object('conference', c.id));
    if side.res = 'W' then
      insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
      values (side.fid, 'conf_win', g.id::text, g.week_key, public.games_day_key(p_now),
        jsonb_build_object('conference', c.id, 'game', g.id, 'kind', g.kind, 'opponent', side.opp), p_now)
      on conflict (franchise_id, kind, key) do nothing;
      perform public.franchise_credit(side.fid, 'xp', (econ->'conf_win'->>'xp')::int, 'conf_win', g.id::text, v_label);
      perform public.franchise_credit(side.fid, 'tc', (econ->'conf_win'->>'tc')::int, 'conf_win', g.id::text, v_label);
      perform public.franchise_credit(side.fid, 'cp', (econ->'conf_win'->>'cp')::int, 'conf_win', g.id::text, v_label);
    end if;
    -- a playoff game won is worth more than a round in the middle of it
    if g.kind <> 'regular' and side.fid = adv then
      insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
      values (side.fid, 'conf_playoff', g.id::text, g.week_key, public.games_day_key(p_now),
        jsonb_build_object('conference', c.id, 'game', g.id, 'kind', g.kind, 'opponent', side.opp), p_now)
      on conflict (franchise_id, kind, key) do nothing;
      perform public.franchise_credit(side.fid, 'xp', (econ->'conf_playoff'->>'xp')::int, 'conf_playoff', g.id::text,
        c.name || ' · ' || (case g.kind when 'semifinal' then 'Semifinal' else 'The final' end) || ' won');
      perform public.franchise_credit(side.fid, 'cp', (econ->'conf_playoff'->>'cp')::int, 'conf_playoff', g.id::text,
        c.name || ' · ' || (case g.kind when 'semifinal' then 'Semifinal' else 'The final' end) || ' won');
      perform public.franchise_award(side.fid, 'conf_post', v_season, jsonb_build_object('conference', c.id, 'game', g.id));
    end if;
  end loop;

  -- the final decides a champion, and the record is written once
  if g.kind = 'final' and adv is not null then
    v_label := c.name || ' · ' || 'Season ' || public.games_roman(g.season_number) || ' champion';
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
    values (adv, 'conf_title', c.id::text || ':' || g.season_number, g.week_key, public.games_day_key(p_now),
      jsonb_build_object('conference', c.id, 'conference_name', c.name, 'season_number', g.season_number,
        'opponent', (select name from public.franchises where id = case when adv = g.a_id then g.b_id else g.a_id end)), p_now)
    on conflict (franchise_id, kind, key) do nothing;
    perform public.franchise_credit(adv, 'xp', (econ->'conf_title'->>'xp')::int, 'conf_title', c.id::text || ':' || g.season_number, v_label);
    perform public.franchise_credit(adv, 'tc', (econ->'conf_title'->>'tc')::int, 'conf_title', c.id::text || ':' || g.season_number, v_label);
    perform public.franchise_credit(adv, 'cp', (econ->'conf_title'->>'cp')::int, 'conf_title', c.id::text || ':' || g.season_number, v_label);
    update public.franchise_conference_members set titles = titles + 1
     where conference_id = c.id and franchise_id = adv returning titles into v_titles;
    perform public.franchise_award(adv, 'conf_title', v_season, jsonb_build_object('conference', c.id, 'season_number', g.season_number));
    if coalesce(v_titles, 0) >= 2 then
      perform public.franchise_award(adv, 'conf_two', v_season, jsonb_build_object('conference', c.id, 'titles', v_titles));
    end if;
  end if;

  return public.franchise_conference_game_json(g.id, false);
end;
$$;

-- CLOSE THE SEASON. The champion, the runner-up and the standings frozen as
-- they read; the conference goes complete and waits for its commissioner to
-- start another. Written once — a second call finds the row already there.
create or replace function public.franchise_conference_settle(p_conference uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.franchise_conferences%rowtype; f public.franchise_conference_games%rowtype; loser uuid;
begin
  select * into c from public.franchise_conferences where id = p_conference for update;
  if not found then raise exception 'no conference' using errcode = '22023'; end if;
  select * into f from public.franchise_conference_games
   where conference_id = p_conference and season_number = c.season_number and kind = 'final' and status = 'final' limit 1;
  if not found then return null; end if;
  loser := case when f.advanced_id = f.a_id then f.b_id else f.a_id end;
  insert into public.franchise_conference_titles (conference_id, season_number, champion_id, runner_up_id, standings, completed_at)
  values (p_conference, c.season_number, f.advanced_id, loser, public.franchise_conference_standings_json(p_conference), p_now)
  on conflict (conference_id, season_number) do nothing;
  update public.franchise_conferences
     set status = 'complete', champion_id = f.advanced_id, completed_at = p_now
   where id = p_conference and status <> 'complete';
  return jsonb_build_object('champion', public.franchise_identity_json(f.advanced_id),
                            'runner_up', public.franchise_identity_json(loser),
                            'season_number', c.season_number);
end;
$$;

commit;

begin;

-- ── what a client may call ────────────────────────────────────────────────

-- CREATE a conference. The franchise that creates it is its commissioner and
-- its first member. A franchise belongs to one conference at a time, and the
-- server says so rather than silently moving it.
create or replace function public.franchise_conference_create(p_name text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); cfg jsonb := public.franchise_conference_config();
  v_name text; v_id uuid; v_token text;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  if public.franchise_conference_of(v_f) is not null then
    raise exception 'your franchise is already in a conference' using errcode = '55000';
  end if;
  v_name := public.franchise_clean(p_name, (cfg->>'name_max')::int);
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'a conference needs a name' using errcode = '22023';
  end if;
  insert into public.franchise_conferences (name, commissioner_id, seed)
  values (v_name, v_f, md5(gen_random_uuid()::text || ':' || v_f::text))
  returning id, invite_token into v_id, v_token;
  insert into public.franchise_conference_members (conference_id, franchise_id, role)
  values (v_id, v_f, 'commissioner');
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'conf_joined', v_id::text, public.games_week_key(now()), public.games_day_key(now()),
    jsonb_build_object('conference', v_id, 'conference_name', v_name, 'role', 'commissioner'))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true, 'id', v_id, 'invite_token', v_token,
    'conference', public.franchise_conference_json(v_id), 'config', cfg);
end;
$$;

-- WHAT A LINK SHOWS before joining: the conference, who is in it, and
-- whether the caller could join. Franchises, never accounts; no token.
create or replace function public.franchise_conference_peek(p_token text, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.franchise_conferences%rowtype; v_f uuid := public.franchise_of(p_secret);
  cfg jsonb := public.franchise_conference_config(); v_n integer; v_mine uuid;
begin
  select * into c from public.franchise_conferences where invite_token = p_token;
  if not found then return null; end if;
  select count(*) into v_n from public.franchise_conference_members where conference_id = c.id;
  v_mine := case when v_f is null then null else public.franchise_conference_of(v_f) end;
  return jsonb_build_object(
    'conference', public.franchise_conference_json(c.id),
    'members', public.franchise_conference_standings_json(c.id),
    'me', case when v_f is null then null else public.franchise_identity_json(v_f) end,
    'is_member', coalesce(v_mine = c.id, false),
    'needs_franchise', v_f is null,
    'full', v_n >= (cfg->>'max_teams')::int,
    'open', c.status in ('forming', 'complete'),
    'in_another', v_mine is not null and v_mine <> c.id,
    'can_join', v_f is not null and v_mine is null and v_n < (cfg->>'max_teams')::int and c.status in ('forming', 'complete'),
    'config', cfg);
end;
$$;

-- JOIN by link. Open while the conference is forming and between its
-- seasons; never in the middle of one, because a schedule already drawn
-- cannot grow a team.
create or replace function public.franchise_conference_join(p_token text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); c public.franchise_conferences%rowtype;
  cfg jsonb := public.franchise_conference_config(); v_n integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into c from public.franchise_conferences where invite_token = p_token for update;
  if not found then raise exception 'no such conference' using errcode = 'P0002'; end if;
  if exists (select 1 from public.franchise_conference_members where conference_id = c.id and franchise_id = v_f) then
    return jsonb_build_object('ok', true, 'already', true, 'conference', public.franchise_conference_json(c.id));
  end if;
  if public.franchise_conference_of(v_f) is not null then
    raise exception 'your franchise is already in a conference' using errcode = '55000';
  end if;
  if c.status not in ('forming', 'complete') then
    raise exception 'the % season is under way; a conference cannot grow a team mid-season', c.name using errcode = '55000';
  end if;
  select count(*) into v_n from public.franchise_conference_members where conference_id = c.id;
  if v_n >= (cfg->>'max_teams')::int then
    raise exception 'the % is full at % franchises', c.name, (cfg->>'max_teams')::int using errcode = '55000';
  end if;
  -- an empty conference kept for its record takes its new commissioner from
  -- whoever opens the link first; there is nobody else to hand it to
  insert into public.franchise_conference_members (conference_id, franchise_id, role)
  values (c.id, v_f, case when v_n = 0 then 'commissioner' else 'member' end);
  if v_n = 0 then
    update public.franchise_conferences set commissioner_id = v_f where id = c.id;
  end if;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'conf_joined', c.id::text, public.games_week_key(now()), public.games_day_key(now()),
    jsonb_build_object('conference', c.id, 'conference_name', c.name, 'role', case when v_n = 0 then 'commissioner' else 'member' end))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true, 'already', false, 'conference', public.franchise_conference_json(c.id));
end;
$$;

-- LEAVE. Between seasons only, for the same reason joining is: the schedule
-- under way names you. A commissioner who leaves hands the conference to
-- whoever joined next.
--
-- THE LAST ONE OUT. An empty conference that never decided a season is
-- deleted — there is nothing in it to keep. One that DID decide a season is
-- kept, empty and dormant, because deleting it would take its titles with
-- it, and a title is a record rather than a possession of whoever is still
-- in the room. The first franchise to open its link again becomes its
-- commissioner.
create or replace function public.franchise_conference_leave(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); c public.franchise_conferences%rowtype; v_next uuid; v_titles integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into c from public.franchise_conferences where id = public.franchise_conference_of(v_f) for update;
  if not found then return jsonb_build_object('ok', true, 'left', false); end if;
  if c.status in ('regular', 'playoffs') then
    raise exception 'the % season is under way; you can leave when it is decided', c.name using errcode = '55000';
  end if;
  delete from public.franchise_conference_members where conference_id = c.id and franchise_id = v_f;
  select franchise_id into v_next from public.franchise_conference_members
   where conference_id = c.id order by joined_at, franchise_id limit 1;
  if v_next is null then
    select count(*) into v_titles from public.franchise_conference_titles where conference_id = c.id;
    if v_titles = 0 then
      delete from public.franchise_conferences where id = c.id;
      return jsonb_build_object('ok', true, 'left', true, 'dissolved', true);
    end if;
    update public.franchise_conferences set status = 'forming' where id = c.id;
    return jsonb_build_object('ok', true, 'left', true, 'dissolved', false, 'dormant', true);
  end if;
  if c.commissioner_id = v_f then
    update public.franchise_conferences set commissioner_id = v_next where id = c.id;
    update public.franchise_conference_members set role = 'commissioner' where conference_id = c.id and franchise_id = v_next;
  end if;
  return jsonb_build_object('ok', true, 'left', true, 'dissolved', false, 'dormant', false);
end;
$$;

-- START A SEASON. The commissioner's call, and the only one of theirs: the
-- schedule is the server's to draw. Records are cleared, the season number
-- turns, and round one opens on the Saturday of this football week.
create or replace function public.franchise_conference_start(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); c public.franchise_conferences%rowtype;
  cfg jsonb := public.franchise_conference_config(); v_n integer; v_made integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into c from public.franchise_conferences where id = public.franchise_conference_of(v_f) for update;
  if not found then raise exception 'join a conference first' using errcode = 'P0002'; end if;
  if c.commissioner_id <> v_f then
    raise exception 'only the commissioner starts a season' using errcode = '42501';
  end if;
  if c.status in ('regular', 'playoffs') then
    raise exception 'the % season is already under way', c.name using errcode = '55000';
  end if;
  select count(*) into v_n from public.franchise_conference_members where conference_id = c.id;
  if v_n < (cfg->>'start_min')::int then
    raise exception 'a conference needs % franchises to start; there are %', (cfg->>'start_min')::int, v_n using errcode = '55000';
  end if;
  update public.franchise_conferences
     set season_number = c.season_number + 1, status = 'regular', started_at = now(),
         completed_at = null, champion_id = null
   where id = c.id returning * into c;
  update public.franchise_conference_members
     set wins = 0, losses = 0, ties = 0, points_for = 0, points_against = 0, seed = null, eliminated = false
   where conference_id = c.id;
  v_made := public.franchise_conference_draw(c.id, now());
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  select m.franchise_id, 'conf_season', c.id::text || ':' || c.season_number,
         public.games_week_key(now()), public.games_day_key(now()),
         jsonb_build_object('conference', c.id, 'conference_name', c.name, 'season_number', c.season_number, 'games', v_made)
    from public.franchise_conference_members m where m.conference_id = c.id
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true, 'started', true, 'games', v_made,
    'conference', public.franchise_conference_json(c.id));
end;
$$;

-- RUN THE CONFERENCE FORWARD. Every round whose Saturday has come is played
-- here, in order, and the first round that has not opened stops the walk.
-- The bracket is drawn when the regular rounds are done, the final when the
-- semifinals are, and the season is closed when the final is played. Running
-- it twice changes nothing: a game already final is left alone.
--
-- It takes the clock, the way franchise_play_game() does, so the suite can
-- play a whole conference season without waiting eleven weeks for it. No
-- client role may call it; franchise_conference_advance() below is the door,
-- and it passes now().
create or replace function public.franchise_conference_run(p_conference uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.franchise_conferences%rowtype;
  v_round integer; v_kind text; v_opens timestamptz; g record; guard integer := 0;
  v_played jsonb := '[]'::jsonb; v_settled jsonb;
begin
  select * into c from public.franchise_conferences where id = p_conference for update;
  if not found then raise exception 'no conference' using errcode = '22023'; end if;
  if c.status not in ('regular', 'playoffs') then
    return jsonb_build_object('played', 0, 'games', v_played, 'settled', null);
  end if;

  loop
    guard := guard + 1;
    exit when guard > 24;
    select round, kind, min(opens_at) into v_round, v_kind, v_opens
      from public.franchise_conference_games
     where conference_id = c.id and season_number = c.season_number and status = 'scheduled'
     group by round, kind order by round limit 1;
    exit when v_round is null;
    exit when v_opens > p_now;
    for g in select id from public.franchise_conference_games
              where conference_id = c.id and season_number = c.season_number and round = v_round and status = 'scheduled'
              order by id loop
      v_played := v_played || jsonb_build_array(public.franchise_conference_play_one(g.id, p_now));
    end loop;
    if v_kind = 'regular' and v_round >= c.rounds then
      perform public.franchise_conference_bracket(c.id);
      select * into c from public.franchise_conferences where id = c.id;
    elsif v_kind = 'semifinal' then
      perform public.franchise_conference_final(c.id);
    elsif v_kind = 'final' then
      v_settled := public.franchise_conference_settle(c.id, p_now);
      exit;
    end if;
  end loop;

  return jsonb_build_object('played', jsonb_array_length(v_played), 'games', v_played, 'settled', v_settled);
end;
$$;

-- ADVANCE THE CONFERENCE. Any member may call it, and calling it twice
-- changes nothing. There is no cron and no privileged client: whoever opens
-- the page after a round's Saturday plays that round for everybody, and the
-- answer names what happened and which of it was theirs.
create or replace function public.franchise_conference_advance(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_cid uuid; v_run jsonb; v_mine jsonb;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  v_cid := public.franchise_conference_of(v_f);
  if v_cid is null then raise exception 'join a conference first' using errcode = 'P0002'; end if;
  v_run := public.franchise_conference_run(v_cid, now());
  select coalesce(jsonb_agg(j), '[]'::jsonb) into v_mine
    from jsonb_array_elements(v_run->'games') j
   where (j->'a'->>'id')::uuid = v_f or (j->'b'->>'id')::uuid = v_f;
  return jsonb_build_object('ok', true, 'played', (v_run->>'played')::int,
    'games', v_run->'games', 'mine', v_mine, 'settled', v_run->'settled',
    'conference', public.franchise_conference_json(v_cid),
    'totals', public.franchise_totals(v_f));
end;
$$;

-- THE CONFERENCE PAGE, in one call: the conference, the standings, the
-- schedule round by round, the bracket, the caller's own next game, and the
-- titles the conference has awarded. A franchise with no conference reads
-- its shape and nothing else.
create or replace function public.franchise_conference_board(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); c public.franchise_conferences%rowtype;
  cfg jsonb := public.franchise_conference_config(); v_games jsonb; v_titles jsonb; v_n integer;
begin
  if v_f is null then return null; end if;
  select * into c from public.franchise_conferences where id = public.franchise_conference_of(v_f);
  if not found then
    return jsonb_build_object('me', public.franchise_identity_json(v_f), 'conference', null, 'config', cfg);
  end if;
  select count(*) into v_n from public.franchise_conference_members where conference_id = c.id;
  select coalesce(jsonb_agg(public.franchise_conference_game_json(g.id, false)
      order by g.round, g.kind, g.a_seed nulls last, g.created_at), '[]'::jsonb)
    into v_games from public.franchise_conference_games g
   where g.conference_id = c.id and g.season_number = c.season_number;
  select coalesce(jsonb_agg(jsonb_build_object('season_number', t.season_number,
      'label', 'Season ' || public.games_roman(t.season_number),
      'champion', public.franchise_identity_json(t.champion_id),
      'runner_up', public.franchise_identity_json(t.runner_up_id),
      'standings', t.standings, 'completed_at', t.completed_at) order by t.season_number desc), '[]'::jsonb)
    into v_titles from public.franchise_conference_titles t where t.conference_id = c.id;
  return jsonb_build_object(
    'me', public.franchise_identity_json(v_f),
    'conference', public.franchise_conference_json(c.id),
    'invite_token', c.invite_token,
    'is_commissioner', c.commissioner_id = v_f,
    'can_start', c.commissioner_id = v_f and c.status in ('forming', 'complete') and v_n >= (cfg->>'start_min')::int,
    'can_leave', c.status in ('forming', 'complete'),
    'needs', greatest(0, (cfg->>'start_min')::int - v_n),
    'standings', public.franchise_conference_standings_json(c.id),
    'games', v_games,
    'mine', (select coalesce(jsonb_agg(j order by (j->>'round')::int), '[]'::jsonb) from jsonb_array_elements(v_games) j
              where (j->'a'->>'id')::uuid = v_f or (j->'b'->>'id')::uuid = v_f),
    'next', (select public.franchise_conference_game_json(g.id, false) from public.franchise_conference_games g
              where g.conference_id = c.id and g.season_number = c.season_number and g.status = 'scheduled'
                and (g.a_id = v_f or g.b_id = v_f) order by g.round limit 1),
    'ready', exists (select 1 from public.franchise_conference_games g
                      where g.conference_id = c.id and g.season_number = c.season_number
                        and g.status = 'scheduled' and g.opens_at <= now()),
    'titles', v_titles,
    'config', cfg);
end;
$$;

-- ONE CONFERENCE GAME with its box — a member's to read, and nobody else's.
create or replace function public.franchise_conference_game(p_game uuid, p_secret text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select public.franchise_conference_game_json(g.id, true)
  from public.franchise_conference_games g
  where g.id = p_game
    and exists (select 1 from public.franchise_conference_members m
                 where m.conference_id = g.conference_id and m.franchise_id = public.franchise_of(p_secret));
$$;

commit;

-- ===========================================================================
-- TRADES — Phase 7, trade_v1
--
-- Players change hands between two franchises IN THE SAME CONFERENCE. That
-- is the whole rule about who may deal with whom, and it is why conferences
-- came first: a league of people who play each other every week is the only
-- place a trade means anything, and it is also the only place it is fair to
-- let one franchise read another's roster.
--
-- THE SERVER CHECKS LEGALITY, NOT FAIRNESS. Whether a deal is lopsided is
-- for the two of them to argue about; whether it leaves a roster that cannot
-- field a team is not. Every offer is re-checked at the moment it is
-- accepted, because a roster can move under an offer that has been sitting
-- for a day: the men named must still be there, both rosters must stay
-- inside the floor and the ceiling, and neither side may drop below the
-- starters a position needs.
--
-- The deadline is the bracket. While a conference is playing its playoffs
-- nothing moves; before and between, it does.
-- ===========================================================================

begin;

create or replace function public.franchise_trade_rules()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'trade_v1',
    'max_per_side', 3,
    'expires_days', 7,
    'who', 'franchises in the same conference',
    'closed_during', 'playoffs',
    'checks', jsonb_build_array('the players named are still on the rosters that offered them',
                                'both rosters stay between the floor and the ceiling',
                                'neither side drops below the starters a position needs'));
$$;

-- AN OFFER. `give` is what the franchise making it sends; `get` is what it
-- asks for. Both are small, and both are re-read at acceptance rather than
-- trusted from when the offer was written.
create table if not exists public.franchise_trades (
  id            uuid primary key default gen_random_uuid(),
  conference_id uuid references public.franchise_conferences (id) on delete set null,
  from_id       uuid not null references public.franchises (id) on delete cascade,
  to_id         uuid not null references public.franchises (id) on delete cascade,
  give_ids      uuid[] not null,
  get_ids       uuid[] not null,
  note          text,
  status        text not null default 'OPEN'
                  check (status in ('OPEN', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED')),
  reason        text,                       -- why it could not be done, when it could not
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  decided_at    timestamptz,
  constraint franchise_trades_two_sides check (from_id <> to_id),
  constraint franchise_trades_sizes check (
    array_length(give_ids, 1) between 1 and 3 and array_length(get_ids, 1) between 1 and 3)
);

create index if not exists franchise_trades_from on public.franchise_trades (from_id, created_at desc);
create index if not exists franchise_trades_to on public.franchise_trades (to_id, created_at desc);

alter table public.franchise_trades enable row level security;

drop policy if exists franchise_trades_party on public.franchise_trades;
create policy franchise_trades_party on public.franchise_trades for select
  using (public.franchise_is_mine(from_id) or public.franchise_is_mine(to_id));

commit;

begin;

-- WHY THIS DEAL CANNOT BE DONE, or null when it can. One function, called
-- both when an offer is written and again when it is accepted, so the answer
-- a player is shown is the answer the server will actually give.
create or replace function public.franchise_trade_illegal(
  p_from uuid, p_to uuid, p_give uuid[], p_get uuid[])
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  mk jsonb := public.franchise_market(); v_conf uuid; c public.franchise_conferences%rowtype;
  n_from integer; n_to integer; v_pos text; starters integer; v_left integer;
begin
  if p_from = p_to then return 'a franchise cannot trade with itself'; end if;
  if coalesce(array_length(p_give, 1), 0) between 1 and (public.franchise_trade_rules()->>'max_per_side')::int
     and coalesce(array_length(p_get, 1), 0) between 1 and (public.franchise_trade_rules()->>'max_per_side')::int
  then null; else return 'a trade is one to three players a side'; end if;

  v_conf := public.franchise_conference_of(p_from);
  if v_conf is null or v_conf <> public.franchise_conference_of(p_to) then
    return 'you can only trade with a franchise in your conference';
  end if;
  select * into c from public.franchise_conferences where id = v_conf;
  if c.status = 'playoffs' then return 'the deadline has passed: nothing moves during the playoffs'; end if;

  -- the men named are still where they were offered from
  if (select count(*) from public.game_players
       where id = any(p_give) and franchise_id = p_from and status = 'active') <> array_length(p_give, 1) then
    return 'a player offered is no longer on that roster';
  end if;
  if (select count(*) from public.game_players
       where id = any(p_get) and franchise_id = p_to and status = 'active') <> array_length(p_get, 1) then
    return 'a player asked for is no longer on that roster';
  end if;
  if p_give && p_get then return 'a player cannot be on both sides of a trade'; end if;

  -- both rosters stay between the floor and the ceiling
  select count(*) into n_from from public.game_players where franchise_id = p_from and status = 'active';
  select count(*) into n_to from public.game_players where franchise_id = p_to and status = 'active';
  n_from := n_from - array_length(p_give, 1) + array_length(p_get, 1);
  n_to := n_to - array_length(p_get, 1) + array_length(p_give, 1);
  if n_from > (mk->>'roster_max')::int or n_to > (mk->>'roster_max')::int then
    return 'that would put a roster over ' || (mk->>'roster_max')::int;
  end if;
  if n_from < (mk->>'roster_min')::int or n_to < (mk->>'roster_min')::int then
    return 'that would put a roster under ' || (mk->>'roster_min')::int;
  end if;

  -- neither side drops below the starters a position needs
  for v_pos in
    select distinct position from public.game_players where id = any(p_give) or id = any(p_get)
  loop
    select coalesce((x->>'starters')::int, 1) into starters
      from jsonb_array_elements(public.franchise_pool_plan()) x where x->>'pos' = v_pos;
    select count(*) into v_left from public.game_players
     where franchise_id = p_from and position = v_pos and status = 'active' and not (id = any(p_give));
    v_left := v_left + (select count(*) from public.game_players where id = any(p_get) and position = v_pos);
    if v_left < starters then return 'that would leave you short at ' || v_pos; end if;

    select count(*) into v_left from public.game_players
     where franchise_id = p_to and position = v_pos and status = 'active' and not (id = any(p_get));
    v_left := v_left + (select count(*) from public.game_players where id = any(p_give) and position = v_pos);
    if v_left < starters then return 'that would leave them short at ' || v_pos; end if;
  end loop;
  return null;
end;
$$;

-- A player as the other side of a trade reads him: everything a card shows,
-- and nothing that is not on one.
create or replace function public.franchise_trade_player_json(p_player uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
      'jersey', p.jersey, 'age', p.age, 'overall', p.overall, 'archetype', p.archetype, 'potential', p.potential,
      'dev_tier', p.dev_tier, 'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits, 'depth', p.depth,
      'available', public.franchise_is_available(p.status, p.injured_until), 'injury', p.injury,
      'career_stats', p.career_stats, 'season_stats', p.season_stats,
      'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'abbr', f.abbr))
  from public.game_players p join public.franchises f on f.id = p.franchise_id
  where p.id = p_player and p.status = 'active';
$$;

create or replace function public.franchise_trade_json(p_trade uuid, p_viewer uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.franchise_trades%rowtype; v_give jsonb; v_get jsonb;
begin
  select * into t from public.franchise_trades where id = p_trade;
  if not found then return null; end if;
  select coalesce(jsonb_agg(public.franchise_trade_player_json(x) order by x), '[]'::jsonb) into v_give from unnest(t.give_ids) x;
  select coalesce(jsonb_agg(public.franchise_trade_player_json(x) order by x), '[]'::jsonb) into v_get from unnest(t.get_ids) x;
  return jsonb_build_object('id', t.id, 'status', t.status, 'note', t.note, 'reason', t.reason,
    'created_at', t.created_at, 'expires_at', t.expires_at, 'decided_at', t.decided_at,
    'mine', t.from_id = p_viewer, 'incoming', t.to_id = p_viewer,
    'from', public.franchise_identity_json(t.from_id), 'to', public.franchise_identity_json(t.to_id),
    -- named from the VIEWER's side: what leaves, and what arrives
    'give', case when t.to_id = p_viewer then v_get else v_give end,
    'get',  case when t.to_id = p_viewer then v_give else v_get end,
    'legal', t.status <> 'OPEN' or public.franchise_trade_illegal(t.from_id, t.to_id, t.give_ids, t.get_ids) is null,
    'illegal_because', case when t.status = 'OPEN' then public.franchise_trade_illegal(t.from_id, t.to_id, t.give_ids, t.get_ids) end);
end;
$$;

commit;

begin;

-- THE OTHER ROSTERS IN YOUR CONFERENCE, to deal from. A league where you
-- cannot see what anyone else has is a league where nobody trades; outside
-- a conference nothing here is readable at all.
create or replace function public.franchise_trade_partners(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_conf uuid; v_rows jsonb;
begin
  if v_f is null then return null; end if;
  v_conf := public.franchise_conference_of(v_f);
  if v_conf is null then
    return jsonb_build_object('me', public.franchise_identity_json(v_f), 'conference', null,
      'partners', '[]'::jsonb, 'rules', public.franchise_trade_rules());
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'franchise', public.franchise_identity_json(m.franchise_id),
      'players', (select coalesce(jsonb_agg(public.franchise_trade_player_json(p.id)
                    order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth), '[]'::jsonb)
                    from public.game_players p where p.franchise_id = m.franchise_id and p.status = 'active'))
      order by m.joined_at, m.franchise_id), '[]'::jsonb)
    into v_rows from public.franchise_conference_members m
   where m.conference_id = v_conf and m.franchise_id <> v_f;
  return jsonb_build_object('me', public.franchise_identity_json(v_f),
    'conference', public.franchise_conference_json(v_conf),
    'mine', (select coalesce(jsonb_agg(public.franchise_trade_player_json(p.id)
                order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth), '[]'::jsonb)
                from public.game_players p where p.franchise_id = v_f and p.status = 'active'),
    'partners', v_rows, 'rules', public.franchise_trade_rules());
end;
$$;

-- OFFER a deal. Refused before anything is written when it could not be
-- done, so nobody sends an offer the server would only reject later.
create or replace function public.franchise_trade_offer(
  p_other uuid, p_give uuid[], p_get uuid[], p_note text default null, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_why text; v_id uuid; v_conf uuid;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  v_why := public.franchise_trade_illegal(v_f, p_other, p_give, p_get);
  if v_why is not null then raise exception '%', v_why using errcode = '55000'; end if;
  v_conf := public.franchise_conference_of(v_f);
  insert into public.franchise_trades (conference_id, from_id, to_id, give_ids, get_ids, note, expires_at)
  values (v_conf, v_f, p_other, p_give, p_get, public.franchise_clean(p_note, 120),
          now() + ((public.franchise_trade_rules()->>'expires_days')::int || ' days')::interval)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'trade', public.franchise_trade_json(v_id, v_f));
end;
$$;

-- ACCEPT or DECLINE one that was offered to you. Accepting re-checks the
-- whole deal and then moves the players: a new number where the old one is
-- taken, the bottom of the new depth chart, and the record says where he
-- came from. Irreversible, and on the record for both.
create or replace function public.franchise_trade_respond(
  p_trade uuid, p_accept boolean, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); t public.franchise_trades%rowtype; v_why text;
  pl public.game_players%rowtype; v_depth integer; v_real integer := public.games_season_of(now());
  v_from_name text; v_to_name text; v_new text[] := '{}';
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into t from public.franchise_trades where id = p_trade for update;
  if not found then raise exception 'no such trade' using errcode = 'P0002'; end if;
  if t.to_id <> v_f then raise exception 'that offer was not made to you' using errcode = '42501'; end if;
  if t.status <> 'OPEN' then raise exception 'that offer has already been decided' using errcode = '55000'; end if;
  if t.expires_at <= now() then
    update public.franchise_trades set status = 'EXPIRED', decided_at = now() where id = t.id;
    raise exception 'that offer has expired' using errcode = '55000';
  end if;

  if not p_accept then
    update public.franchise_trades set status = 'DECLINED', decided_at = now() where id = t.id;
    return jsonb_build_object('ok', true, 'accepted', false, 'trade', public.franchise_trade_json(t.id, v_f));
  end if;

  -- RE-CHECKED at the moment it is taken, not when it was written: a roster
  -- moves under an offer that has been sitting for a day. A deal that has
  -- gone bad is CLOSED WITH ITS REASON rather than raised — an exception here
  -- would roll back the very row that records why it died, and the person
  -- looking at a dead offer is owed the reason on it.
  v_why := public.franchise_trade_illegal(t.from_id, t.to_id, t.give_ids, t.get_ids);
  if v_why is not null then
    update public.franchise_trades set status = 'EXPIRED', reason = v_why, decided_at = now() where id = t.id;
    return jsonb_build_object('ok', false, 'accepted', false, 'reason', v_why,
      'trade', public.franchise_trade_json(t.id, v_f));
  end if;

  perform 1 from public.franchises where id in (t.from_id, t.to_id) order by id for update;
  select name into v_from_name from public.franchises where id = t.from_id;
  select name into v_to_name from public.franchises where id = t.to_id;

  for pl in select * from public.game_players where id = any(t.give_ids) loop
    select coalesce(max(depth), 0) + 1 into v_depth from public.game_players
     where franchise_id = t.to_id and position = pl.position and status = 'active';
    -- OWNERSHIP MOVES THROUGH THE ONE DOOR (cards_v1); the chart, the number
    -- and how he arrived follow it
    perform public.franchise_card_transfer(pl.card_id, t.to_id, 'trade', t.id::text, null);
    update public.game_players
       set depth = v_depth,
           jersey = case when exists (select 1 from public.game_players o
                                       where o.franchise_id = t.to_id and o.status = 'active' and o.jersey = pl.jersey and o.id <> pl.id)
                         then public.franchise_free_number(t.to_id, pl.position, pl.id::text) else pl.jersey end,
           -- his season and his career travel with him, untouched
           acquired_source = 'trade', acquired_season = v_real,
           acquired_detail = 'From the ' || v_from_name, updated_at = now()
     where id = pl.id;
  end loop;
  for pl in select * from public.game_players where id = any(t.get_ids) loop
    select coalesce(max(depth), 0) + 1 into v_depth from public.game_players
     where franchise_id = t.from_id and position = pl.position and status = 'active';
    perform public.franchise_card_transfer(pl.card_id, t.from_id, 'trade', t.id::text, null);
    update public.game_players
       set depth = v_depth,
           jersey = case when exists (select 1 from public.game_players o
                                       where o.franchise_id = t.from_id and o.status = 'active' and o.jersey = pl.jersey and o.id <> pl.id)
                         then public.franchise_free_number(t.from_id, pl.position, pl.id::text) else pl.jersey end,
           acquired_source = 'trade', acquired_season = v_real,
           acquired_detail = 'From the ' || v_to_name, updated_at = now()
     where id = pl.id;
  end loop;

  update public.franchise_trades set status = 'ACCEPTED', decided_at = now() where id = t.id;

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (t.from_id, 'trade', t.id::text, public.games_week_key(now()), public.games_day_key(now()),
      jsonb_build_object('trade', t.id, 'with', v_to_name, 'sent', array_length(t.give_ids, 1), 'got', array_length(t.get_ids, 1))),
         (t.to_id, 'trade', t.id::text, public.games_week_key(now()), public.games_day_key(now()),
      jsonb_build_object('trade', t.id, 'with', v_from_name, 'sent', array_length(t.get_ids, 1), 'got', array_length(t.give_ids, 1)))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(t.from_id, 'trade_first', v_real, jsonb_build_object('trade', t.id)) then null; end if;
  if public.franchise_award(t.to_id, 'trade_first', v_real, jsonb_build_object('trade', t.id)) then
    v_new := array_append(v_new, 'trade_first'); end if;

  return jsonb_build_object('ok', true, 'accepted', true, 'trade', public.franchise_trade_json(t.id, v_f),
    'achievements', to_jsonb(v_new), 'roster', public.franchise_roster(p_secret));
end;
$$;

-- WITHDRAW one of yours that has not been decided.
create or replace function public.franchise_trade_withdraw(p_trade uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); n integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  update public.franchise_trades set status = 'WITHDRAWN', decided_at = now()
   where id = p_trade and from_id = v_f and status = 'OPEN';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'withdrawn', n > 0);
end;
$$;

-- EVERY DEAL THIS FRANCHISE IS PART OF: what is waiting on you, what you are
-- waiting on, and what has been done.
create or replace function public.franchise_trades_mine(p_limit integer default 20, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_in jsonb; v_out jsonb; v_done jsonb;
begin
  if v_f is null then return null; end if;
  select coalesce(jsonb_agg(public.franchise_trade_json(t.id, v_f) order by t.created_at desc), '[]'::jsonb) into v_in
    from public.franchise_trades t where t.to_id = v_f and t.status = 'OPEN' and t.expires_at > now();
  select coalesce(jsonb_agg(public.franchise_trade_json(t.id, v_f) order by t.created_at desc), '[]'::jsonb) into v_out
    from public.franchise_trades t where t.from_id = v_f and t.status = 'OPEN' and t.expires_at > now();
  select coalesce(jsonb_agg(j order by (j->>'decided_at') desc), '[]'::jsonb) into v_done
    from (select public.franchise_trade_json(t.id, v_f) as j from public.franchise_trades t
           where (t.from_id = v_f or t.to_id = v_f) and t.status <> 'OPEN'
           order by t.decided_at desc nulls last limit greatest(1, least(coalesce(p_limit, 20), 100))) s;
  return jsonb_build_object('me', public.franchise_identity_json(v_f),
    'incoming', v_in, 'outgoing', v_out, 'done', v_done, 'rules', public.franchise_trade_rules());
end;
$$;

commit;

-- ===========================================================================
-- THE COACHING STAFF — Phase 8, staff_v1
--
-- WHERE COACH POINTS GO. Every other currency has somewhere to spend itself
-- forever: Scouting Points buy reports, ten a window; Team Credits buy free
-- agents, priced per point. Coach Points had two facilities worth 76 CP in
-- total and then nothing, which was backwards — CP is the currency you earn
-- by WINNING, and the hardest content in the game paid in the thing with
-- nothing behind it.
--
-- Four seats: a head coach, two coordinators and a trainer. Each is one
-- named person, generated on the server from the same name pools the roster
-- draws from, hired with CP and levelled with CP — to a thousand.
--
-- THE TWO CURVES, and they are the whole design.
--
--   COST      the next level costs 1 CP, going up a CP every ten levels:
--                 cost(L → L+1) = 1 + floor((L − 1) / 10)
--             so level 10 arrives in a first season, level 50 inside a year,
--             level 100 at about three, and level 1000 is a horizon rather
--             than a plan. That is deliberate. There is always another level.
--
--   EFFECT    every TENFOLD in level is another third of the cap:
--                 effect(L) = cap × ln(L) / ln(1000)
--             level 10 is a third of the way, level 100 two thirds, level
--             1000 all of it. A coach is useful immediately and never
--             finished, and the long tail is honest about being a long tail.
--
-- Because the tail is long, the levels themselves carry rewards: a SPECIALTY
-- every twenty-five levels (ten of them, to level 250) and a GRADE that
-- reads off the number — Rookie, Assistant, Coordinator, Veteran, Legend,
-- and Hall of Fame at a thousand.
--
-- A COACH DOES NOT LEAVE. Nothing poaches him, nothing retires him. Three
-- years of levelling cannot be taken away by a die roll — the sink is the
-- levelling itself, four seats deep and effectively bottomless, and it does
-- not need turnover to work. Firing a coach is allowed and resets that seat
-- to nothing, which is why almost nobody will.
-- ===========================================================================

begin;

create or replace function public.franchise_staff()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'staff_v2',
    -- what a rank pays in Coach Points, and what a reputation is worth to a
    -- new hire (Phase 12) — the two numbers that make a building staffable
    'rank_cp_base', 20, 'rank_cp_step', 2,
    'hire_level_max', 60, 'hire_per_rank', 0.5, 'hire_per_standing', 10,
    'max_level', 1000,
    'hire_cost', 12,            -- CP to fill an empty seat
    'cost_base', 1,             -- CP for the first level…
    'cost_step', 10,            -- …and a CP more every ten levels
    'specialty_every', 25,
    'specialty_max', 10,
    'promote_max', 100,         -- levels one call may buy, so a loop is bounded
    'seats', jsonb_build_array(
      jsonb_build_object('key', 'head',    'name', 'Head Coach',
        'means', 'Steadies the fourth quarter and overtime', 'cap', 2.5, 'sort', 1),
      jsonb_build_object('key', 'offense', 'name', 'Offensive Coordinator',
        'means', 'Adds to the offense in every game', 'cap', 3.0, 'sort', 2),
      jsonb_build_object('key', 'defense', 'name', 'Defensive Coordinator',
        'means', 'Adds to the defense in every game', 'cap', 3.0, 'sort', 3),
      jsonb_build_object('key', 'trainer', 'name', 'Head Trainer',
        'means', 'Cuts the chance a game costs somebody, and grows the young faster', 'cap', 1.0, 'sort', 4)),
    'grades', jsonb_build_array(
      jsonb_build_object('at', 1,    'name', 'Rookie'),
      jsonb_build_object('at', 25,   'name', 'Assistant'),
      jsonb_build_object('at', 100,  'name', 'Coordinator'),
      jsonb_build_object('at', 250,  'name', 'Veteran'),
      jsonb_build_object('at', 500,  'name', 'Legend'),
      jsonb_build_object('at', 1000, 'name', 'Hall of Fame')),
    -- what a specialty adds, in the units the simulator already reads
    'specialties', jsonb_build_array(
      jsonb_build_object('id', 'red_zone',   'name', 'Red Zone Architect', 'seats', jsonb_build_array('head','offense'), 'effect', jsonb_build_object('offense', 0.3)),
      jsonb_build_object('id', 'tempo',      'name', 'Tempo Merchant',     'seats', jsonb_build_array('offense'),        'effect', jsonb_build_object('offense', 0.3)),
      jsonb_build_object('id', 'protection', 'name', 'Protection Guru',    'seats', jsonb_build_array('offense'),        'effect', jsonb_build_object('offense', 0.2, 'injury_resist', 0.02)),
      jsonb_build_object('id', 'pressure',   'name', 'Pressure Package',   'seats', jsonb_build_array('defense'),        'effect', jsonb_build_object('defense', 0.3)),
      jsonb_build_object('id', 'coverage',   'name', 'Coverage Mind',      'seats', jsonb_build_array('defense'),        'effect', jsonb_build_object('defense', 0.3)),
      jsonb_build_object('id', 'takeaway',   'name', 'Takeaway Drill',     'seats', jsonb_build_array('defense','head'), 'effect', jsonb_build_object('takeaway', 0.5)),
      jsonb_build_object('id', 'closer',     'name', 'The Closer',         'seats', jsonb_build_array('head'),           'effect', jsonb_build_object('late_offense', 0.3, 'clutch', 0.5)),
      jsonb_build_object('id', 'motivator',  'name', 'Motivator',          'seats', jsonb_build_array('head'),           'effect', jsonb_build_object('late_defense', 0.3)),
      jsonb_build_object('id', 'sports_sci', 'name', 'Sports Scientist',   'seats', jsonb_build_array('trainer'),        'effect', jsonb_build_object('injury_resist', 0.03)),
      jsonb_build_object('id', 'rehab',      'name', 'Rehab Specialist',   'seats', jsonb_build_array('trainer'),        'effect', jsonb_build_object('injury_resist', 0.02, 'development', 0.2)),
      jsonb_build_object('id', 'strength',   'name', 'Strength Coach',     'seats', jsonb_build_array('trainer'),        'effect', jsonb_build_object('development', 0.3)),
      jsonb_build_object('id', 'teacher',    'name', 'Teacher',            'seats', jsonb_build_array('head','trainer'), 'effect', jsonb_build_object('development', 0.3))),
    'archetypes', jsonb_build_array('Players'' Coach', 'Disciplinarian', 'Innovator', 'Grinder',
                                    'Tactician', 'Motivator', 'Technician', 'Old School'));
$$;

-- WHAT THE NEXT LEVEL COSTS: 1 CP, and a CP more every ten levels.
create or replace function public.franchise_staff_cost(p_level integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_level, 1) < 1 then 1
              else 1 + floor((least(coalesce(p_level, 1), 1000) - 1) / 10.0)::int end;
$$;

-- WHAT IT COSTS TO GET FROM ONE LEVEL TO ANOTHER, summed. Used to price a
-- promotion before it is bought and to say "N CP to the next grade".
create or replace function public.franchise_staff_cost_between(p_from integer, p_to integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(sum(public.franchise_staff_cost(L)), 0)::int
  from generate_series(greatest(1, coalesce(p_from, 1)),
                       greatest(0, least(coalesce(p_to, 1), 1000) - 1)) L;
$$;

-- WHAT A LEVEL IS WORTH: every tenfold is another third of the cap.
create or replace function public.franchise_staff_effect(p_level integer, p_cap numeric)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select round((coalesce(p_cap, 0) * ln(greatest(1, least(coalesce(p_level, 1), 1000))) / ln(1000))::numeric, 3);
$$;

-- The name a level carries.
create or replace function public.franchise_staff_grade(p_level integer)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select g->>'name' from jsonb_array_elements(public.franchise_staff()->'grades') g
   where (g->>'at')::int <= greatest(1, coalesce(p_level, 1))
   order by (g->>'at')::int desc limit 1;
$$;

-- How many specialties a level has earned: one every twenty-five, ten at most.
create or replace function public.franchise_staff_specialty_count(p_level integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select least((public.franchise_staff()->>'specialty_max')::int,
               floor(greatest(1, coalesce(p_level, 1)) / (public.franchise_staff()->>'specialty_every')::numeric)::int);
$$;

-- ONE SEAT, one person. The level belongs to the coach: firing him resets it,
-- and nothing else can.
create table if not exists public.franchise_staff_members (
  franchise_id   uuid not null references public.franchises (id) on delete cascade,
  seat           text not null check (seat in ('head', 'offense', 'defense', 'trainer')),
  first_name     text not null,
  last_name      text not null,
  archetype      text not null,
  level          integer not null default 1 check (level between 1 and 1000),
  specialties    jsonb not null default '[]'::jsonb,
  seed           text not null,
  hired_season   integer not null,
  hired_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (franchise_id, seat)
);

create index if not exists franchise_staff_members_franchise on public.franchise_staff_members (franchise_id);

alter table public.franchise_staff_members enable row level security;

drop policy if exists franchise_staff_members_own on public.franchise_staff_members;
create policy franchise_staff_members_own on public.franchise_staff_members for select
  using (public.franchise_is_mine(franchise_id));

alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release',
   'conf_joined','conf_season','conf_game','conf_win','conf_playoff','conf_title',
   'bowl_bid','injury','trade',
   'staff_hire','staff_promote','staff_fire'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('staff_first',  'A Staff',       'Hired your first coach.', null, 100),
  ('staff_full',   'Full Building', 'Filled all four seats.', null, 101),
  ('staff_100',    'Coordinator',   'Took a coach to level 100.', null, 102),
  ('staff_250',    'Veteran Staff', 'Took a coach to level 250.', null, 103),
  ('staff_1000',   'Hall of Fame',  'Took a coach to level 1000.', null, 104)
on conflict (id) do nothing;

commit;

begin;

-- ONE COACH, generated on the server from the same name pools the roster
-- draws from, seeded so the same franchise hiring for the same seat in the
-- same season gets the same man. He starts at level one with nothing; the
-- levels are what make him.
-- A trailing default makes a new signature, so the four-argument form is
-- dropped first — otherwise both would exist and the hire would keep the old.
drop function if exists public.franchise_generate_coach(uuid, text, text, integer);
create or replace function public.franchise_generate_coach(
  p_franchise uuid, p_seat text, p_seed text, p_season integer, p_level integer default 1)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  firsts text[] := public.franchise_pool_first_names();
  lasts text[] := public.franchise_pool_last_names();
  cfg jsonb := public.franchise_staff(); v_arch text;
begin
  perform setseed(public.franchise_seed_float(p_seed));
  v_arch := (cfg->'archetypes')->>(floor(random() * jsonb_array_length(cfg->'archetypes'))::int);
  insert into public.franchise_staff_members
    (franchise_id, seat, first_name, last_name, archetype, level, specialties, seed, hired_season)
  values (p_franchise, p_seat,
    firsts[1 + floor(random() * array_length(firsts, 1))::int],
    lasts[1 + floor(random() * array_length(lasts, 1))::int],
    v_arch, greatest(1, coalesce(p_level, 1)), '[]'::jsonb, p_seed, p_season)
  on conflict (franchise_id, seat) do nothing;
end;
$$;

-- THE SPECIALTIES A COACH HAS EARNED, drawn from the pool his seat can take,
-- seeded from his own seed so the same coach always unlocks the same ones in
-- the same order. Recomputed from the level rather than stored twice: the
-- level is the only thing that decides them.
create or replace function public.franchise_staff_specialties(p_seat text, p_seed text, p_level integer)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cfg jsonb := public.franchise_staff(); pool jsonb := '[]'::jsonb; out_ jsonb := '[]'::jsonb;
  n integer := public.franchise_staff_specialty_count(p_level); s jsonb; i integer; j integer; tmp jsonb;
  arr jsonb[];
begin
  if n <= 0 then return '[]'::jsonb; end if;
  for s in select * from jsonb_array_elements(cfg->'specialties') loop
    if s->'seats' @> to_jsonb(p_seat) then pool := pool || jsonb_build_array(s); end if;
  end loop;
  if jsonb_array_length(pool) = 0 then return '[]'::jsonb; end if;
  -- a seeded shuffle, so the order is his and never moves
  select array_agg(x) into arr from jsonb_array_elements(pool) x;
  perform setseed(public.franchise_seed_float(p_seed || ':spec'));
  for i in reverse array_length(arr, 1)..2 loop
    j := 1 + floor(random() * i)::int;
    tmp := arr[i]; arr[i] := arr[j]; arr[j] := tmp;
  end loop;
  for i in 1..least(n, array_length(arr, 1)) loop
    out_ := out_ || jsonb_build_array(arr[i]);
  end loop;
  return out_;
end;
$$;

-- WHAT THE STAFF ADDS UP TO, in the units the simulator already reads — the
-- same shape franchise_trait_effects returns, so the sim reads one more
-- object rather than learning anything new. Each seat contributes its own
-- curve, and its specialties on top.
create or replace function public.franchise_staff_effects(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cfg jsonb := public.franchise_staff(); m record; seat jsonb; e numeric; sp jsonb; k text;
  v_off numeric := 0; v_def numeric := 0; v_late_o numeric := 0; v_late_d numeric := 0;
  v_clutch numeric := 0; v_take numeric := 0; v_inj numeric := 0; v_dev numeric := 0;
  v_seats jsonb := '{}'::jsonb; v_n integer := 0;
begin
  for m in select * from public.franchise_staff_members where franchise_id = p_franchise loop
    select x into seat from jsonb_array_elements(cfg->'seats') x where x->>'key' = m.seat;
    if seat is null then continue; end if;
    v_n := v_n + 1;
    e := public.franchise_staff_effect(m.level, (seat->>'cap')::numeric);
    -- the seat's own curve
    if m.seat = 'offense' then v_off := v_off + e;
    elsif m.seat = 'defense' then v_def := v_def + e;
    elsif m.seat = 'head' then v_late_o := v_late_o + e; v_late_d := v_late_d + e;
    elsif m.seat = 'trainer' then v_inj := v_inj + e * 0.4; v_dev := v_dev + e;
    end if;
    -- and what his specialties add
    for sp in select * from jsonb_array_elements(public.franchise_staff_specialties(m.seat, m.seed, m.level)) loop
      for k in select jsonb_object_keys(sp->'effect') loop
        if k = 'offense' then v_off := v_off + (sp->'effect'->>k)::numeric;
        elsif k = 'defense' then v_def := v_def + (sp->'effect'->>k)::numeric;
        elsif k = 'late_offense' then v_late_o := v_late_o + (sp->'effect'->>k)::numeric;
        elsif k = 'late_defense' then v_late_d := v_late_d + (sp->'effect'->>k)::numeric;
        elsif k = 'clutch' then v_clutch := v_clutch + (sp->'effect'->>k)::numeric;
        elsif k = 'takeaway' then v_take := v_take + (sp->'effect'->>k)::numeric;
        elsif k = 'injury_resist' then v_inj := v_inj + (sp->'effect'->>k)::numeric;
        elsif k = 'development' then v_dev := v_dev + (sp->'effect'->>k)::numeric;
        end if;
      end loop;
    end loop;
    v_seats := v_seats || jsonb_build_object(m.seat, jsonb_build_object(
      'level', m.level, 'grade', public.franchise_staff_grade(m.level), 'effect', e));
  end loop;
  return jsonb_build_object('version', cfg->>'version',
    'offense', round(v_off, 3), 'defense', round(v_def, 3),
    'late_offense', round(v_late_o, 3), 'late_defense', round(v_late_d, 3),
    'clutch', round(v_clutch, 3), 'takeaway', round(v_take, 3),
    -- a fraction of the injury chance, never more than four fifths of it
    'injury_resist', least(0.8, round(v_inj, 3)),
    'development', round(v_dev, 3), 'seats', v_seats, 'filled', v_n);
end;
$$;

-- A COACH as the pages read him.
create or replace function public.franchise_staff_json(p_franchise uuid, p_seat text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m public.franchise_staff_members%rowtype; cfg jsonb := public.franchise_staff(); v_seat jsonb; nxt integer;
begin
  select x into v_seat from jsonb_array_elements(cfg->'seats') x where x->>'key' = p_seat;
  select * into m from public.franchise_staff_members t where t.franchise_id = p_franchise and t.seat = p_seat;
  if not found then
    return jsonb_build_object('seat', p_seat, 'name', v_seat->>'name', 'means', v_seat->>'means',
      'sort', (v_seat->>'sort')::int, 'filled', false, 'hire_cost', (cfg->>'hire_cost')::int);
  end if;
  -- the next level that changes something visible: the next specialty, or
  -- the next grade, whichever comes first
  nxt := least(
    ((floor(m.level / (cfg->>'specialty_every')::numeric)::int + 1) * (cfg->>'specialty_every')::int),
    coalesce((select min((g->>'at')::int) from jsonb_array_elements(cfg->'grades') g where (g->>'at')::int > m.level), 1000));
  nxt := least(nxt, (cfg->>'max_level')::int);
  return jsonb_build_object('seat', m.seat, 'name', v_seat->>'name', 'means', v_seat->>'means',
    'sort', (v_seat->>'sort')::int, 'filled', true,
    'coach', m.first_name || ' ' || m.last_name, 'archetype', m.archetype,
    'level', m.level, 'grade', public.franchise_staff_grade(m.level),
    'max_level', (cfg->>'max_level')::int,
    'effect', public.franchise_staff_effect(m.level, (v_seat->>'cap')::numeric), 'cap', (v_seat->>'cap')::numeric,
    'next_cost', case when m.level < (cfg->>'max_level')::int then public.franchise_staff_cost(m.level) end,
    'specialties', public.franchise_staff_specialties(m.seat, m.seed, m.level),
    'next_milestone', case when m.level < (cfg->>'max_level')::int then nxt end,
    'to_milestone', case when m.level < (cfg->>'max_level')::int
                         then public.franchise_staff_cost_between(m.level, nxt) end,
    'hired_season', m.hired_season, 'hired_at', m.hired_at);
end;
$$;

commit;

begin;

-- HIRE into an empty seat. One CP price, the same for every seat, and the
-- man who turns up is the server's to pick.
create or replace function public.franchise_staff_hire(p_seat text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); cfg jsonb := public.franchise_staff();
  f public.franchises%rowtype; cost integer := (cfg->>'hire_cost')::int; v_seat jsonb;
  v_season integer := public.games_season_of(now()); v_new text[] := '{}'; v_n integer; v_level integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select x into v_seat from jsonb_array_elements(cfg->'seats') x where x->>'key' = p_seat;
  if v_seat is null then raise exception 'no such seat' using errcode = '22023'; end if;
  select * into f from public.franchises where id = v_f for update;
  if exists (select 1 from public.franchise_staff_members t where t.franchise_id = v_f and t.seat = p_seat) then
    raise exception 'that seat is filled: fire the coach in it first' using errcode = '55000';
  end if;
  if f.coach_points < cost then
    raise exception 'not enough Coach Points: % needed, % on hand', cost, f.coach_points using errcode = '55000';
  end if;
  -- WHAT YOUR REPUTATION COMMANDS (staff_v2). A replacement used to start at
  -- level one, which made firing anybody unthinkable and left the choice a
  -- trap rather than a decision. A club that has been at it for years and
  -- wins its games attracts a man who has done the job before.
  v_level := public.franchise_staff_hire_level(
    (public.franchise_rank_report(v_f)->>'rank')::int, f.standing);
  perform public.franchise_generate_coach(v_f, p_seat,
    md5(f.seed || ':coach:' || p_seat || ':' || v_season || ':' || clock_timestamp()::text), v_season, v_level);
  perform public.franchise_credit(v_f, 'cp', -cost, 'staff_hire', p_seat || ':' || v_season,
    'Hired a ' || (v_seat->>'name'));
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'staff_hire', p_seat || ':' || v_season, public.games_week_key(now()), public.games_day_key(now()),
    jsonb_build_object('seat', p_seat, 'cost', cost, 'level', v_level))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_f, 'staff_first', v_season, jsonb_build_object('seat', p_seat)) then
    v_new := array_append(v_new, 'staff_first'); end if;
  select count(*) into v_n from public.franchise_staff_members where franchise_id = v_f;
  if v_n >= jsonb_array_length(cfg->'seats')
     and public.franchise_award(v_f, 'staff_full', v_season, jsonb_build_object('seats', v_n)) then
    v_new := array_append(v_new, 'staff_full'); end if;
  return jsonb_build_object('ok', true, 'cost', cost, 'level', v_level,
    'seat', public.franchise_staff_json(v_f, p_seat),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- PROMOTE. Buys as many levels as asked for and can afford, one at a time so
-- the price rises as it climbs, and stops at the first one it cannot pay
-- for rather than refusing the lot. One ledger row for the whole promotion,
-- keyed by the level reached, so the same promotion cannot be paid twice.
create or replace function public.franchise_staff_promote(
  p_seat text, p_levels integer default 1, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); cfg jsonb := public.franchise_staff();
  f public.franchises%rowtype; m public.franchise_staff_members%rowtype;
  want integer; spent integer := 0; step integer; gained integer := 0; v_from integer;
  v_season integer := public.games_season_of(now()); v_new text[] := '{}'; v_spec_before integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  select * into m from public.franchise_staff_members t where t.franchise_id = v_f and t.seat = p_seat for update;
  if not found then raise exception 'that seat is empty: hire somebody first' using errcode = 'P0002'; end if;
  if m.level >= (cfg->>'max_level')::int then
    raise exception 'a coach stops at %', (cfg->>'max_level')::int using errcode = '55000';
  end if;
  want := greatest(1, least(coalesce(p_levels, 1), (cfg->>'promote_max')::int));
  v_from := m.level; v_spec_before := public.franchise_staff_specialty_count(m.level);

  while gained < want and (v_from + gained) < (cfg->>'max_level')::int loop
    step := public.franchise_staff_cost(v_from + gained);
    exit when spent + step > f.coach_points;
    spent := spent + step; gained := gained + 1;
  end loop;
  if gained = 0 then
    raise exception 'not enough Coach Points: % needed for the next level, % on hand',
      public.franchise_staff_cost(v_from), f.coach_points using errcode = '55000';
  end if;

  update public.franchise_staff_members
     set level = v_from + gained,
         specialties = public.franchise_staff_specialties(p_seat, m.seed, v_from + gained),
         updated_at = now()
   where franchise_id = v_f and seat = p_seat returning * into m;
  perform public.franchise_credit(v_f, 'cp', -spent, 'staff_promote', p_seat || ':' || m.level,
    (select x->>'name' from jsonb_array_elements(cfg->'seats') x where x->>'key' = p_seat) || ' to level ' || m.level);
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'staff_promote', p_seat || ':' || m.level, public.games_week_key(now()), public.games_day_key(now()),
    jsonb_build_object('seat', p_seat, 'from', v_from, 'to', m.level, 'cost', spent))
  on conflict (franchise_id, kind, key) do nothing;

  if m.level >= 100 and public.franchise_award(v_f, 'staff_100', v_season, jsonb_build_object('seat', p_seat, 'level', m.level)) then
    v_new := array_append(v_new, 'staff_100'); end if;
  if m.level >= 250 and public.franchise_award(v_f, 'staff_250', v_season, jsonb_build_object('seat', p_seat, 'level', m.level)) then
    v_new := array_append(v_new, 'staff_250'); end if;
  if m.level >= 1000 and public.franchise_award(v_f, 'staff_1000', v_season, jsonb_build_object('seat', p_seat)) then
    v_new := array_append(v_new, 'staff_1000'); end if;

  return jsonb_build_object('ok', true, 'from', v_from, 'to', m.level, 'levels', gained, 'cost', spent,
    'asked', want, 'short', gained < want,
    'new_specialties', public.franchise_staff_specialty_count(m.level) - v_spec_before,
    'seat', public.franchise_staff_json(v_f, p_seat),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- FIRE. Free, irreversible, and it takes the level with him — which is the
-- whole reason a coach is worth keeping.
create or replace function public.franchise_staff_fire(p_seat text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); m public.franchise_staff_members%rowtype;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into m from public.franchise_staff_members t where t.franchise_id = v_f and t.seat = p_seat;
  if not found then return jsonb_build_object('ok', true, 'fired', false); end if;
  delete from public.franchise_staff_members where franchise_id = v_f and seat = p_seat;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'staff_fire', p_seat || ':' || m.level || ':' || m.hired_at::text,
    public.games_week_key(now()), public.games_day_key(now()),
    jsonb_build_object('seat', p_seat, 'coach', m.first_name || ' ' || m.last_name, 'level', m.level))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true, 'fired', true, 'level', m.level,
    'seat', public.franchise_staff_json(v_f, p_seat));
end;
$$;

-- THE STAFF PAGE, in one call.
create or replace function public.franchise_staff_board(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); cfg jsonb := public.franchise_staff(); v_seats jsonb; s jsonb;
begin
  if v_f is null then return null; end if;
  v_seats := '[]'::jsonb;
  for s in select x from jsonb_array_elements(cfg->'seats') x order by (x->>'sort')::int loop
    v_seats := v_seats || jsonb_build_array(public.franchise_staff_json(v_f, s->>'key'));
  end loop;
  return jsonb_build_object('me', public.franchise_identity_json(v_f),
    'seats', v_seats, 'effects', public.franchise_staff_effects(v_f),
    'resources', public.franchise_totals(v_f), 'rules', cfg);
end;
$$;

commit;

-- ===========================================================================
-- THE SCOUTING DEPARTMENT — Phase 9, scouting_v1
--
-- WHAT READING REAL FOOTBALL WELL IS WORTH. Eight phases in, the two halves
-- of this game touch in exactly one place: currency. Price a game and you
-- earn XP, Scouting Points and Team Credits. Price it WELL and you earn a
-- few more of each. Nothing else in the franchise has ever known whether
-- you were any good at it.
--
-- The evidence was already in the file. franchise_prep() computes three
-- numbers every football week. Two of them count VOLUME — how many games
-- you priced, whether you sent a card, whether you ran a drill — and the
-- simulator reads one of those. The third is MARKET IQ, the average Price It
-- score, the only measure of accuracy anywhere in the schema, and it was
-- computed, returned, and read by nothing. Not by the simulator, not by a
-- page. A dead stat, and behind it a dead dimension: skill at the real game
-- made you richer and never better.
--
-- So: a scouting department, graded on how well you actually price games,
-- and what it is good at is finding football players.
--
--   THE GRADE      the average Price It score over your LAST TWENTY verified
--                  pricings — not a week, because three games is noise, and
--                  not all time, because a department is what it is doing
--                  now. Short of twenty on the record, the grade is pulled
--                  toward a neutral 50 in proportion to what is missing, so
--                  a new franchise starts in the middle: not punished for
--                  having no record, and not an A on one lucky pricing.
--
--   WHAT IT BUYS   everything it buys is in the draft window, and all of it
--                  is decided ONCE, when the window opens, from the grade
--                  standing at that moment:
--
--                    the BAND on an unscouted prospect — eighteen points
--                    wide at the bottom, four at the top. A department that
--                    reads games well sees more before it pays to look;
--
--                    the PRICE of a report — 28 Scouting Points down to 12;
--
--                    the CEILING of the class — up to six points of
--                    POTENTIAL, never of overall. A good department does not
--                    make a nineteen-year-old better today; it finds the one
--                    who will be;
--
--                    an EXTRA PICK at the top grade, and only there.
--
-- DECIDED ONCE, ON PURPOSE. The grade the window opened under is stamped on
-- the franchise and on the class, and it does not move again until the next
-- window. A class cannot be improved by pricing games after you have seen
-- it, and it cannot be taken away by a bad week either. The consequence is
-- that the weeks BEFORE an offseason are the ones that matter, which is
-- exactly the habit this is meant to reward.
--
-- WHAT IT DOES NOT TOUCH. Not the simulator, not team overall, not a rating
-- on any player already on the roster, not Saturday. Reading real football
-- well decides WHO YOU FIND. It has never decided, and does not now decide,
-- how the game itself goes — that is the roster's and the staff's job.
--
-- Only Price It feeds the grade. Pick 5 and the Drill measure real skill too
-- and are deliberately left out: Price It is the game where you set a number
-- against EdgeDesk's own, and a scouting grade should mean one thing.
-- ===========================================================================

begin;

-- the band shown for a prospect nobody has paid to look at, stamped on him
-- when his class was generated: the class stays true to the department that
-- found it, however good or bad the department is by the time he is drafted
alter table public.game_players add column if not exists scout_band integer;
-- the grade the current window was opened under; null until one is opened
alter table public.franchises add column if not exists scout_grade integer;

-- THE TABLE. Six grades, and what each is worth, in one place a page can
-- render without a round trip.
create or replace function public.franchise_scouting()
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'scouting_v1',
    'window', 20,          -- the last twenty verified pricings are the record
    'neutral', 50,         -- and what a franchise short of twenty is pulled toward
    /* THE ENDS ARE CHOSEN SO THAT NEUTRAL IS THE STATUS QUO. At grade 50 —
       a franchise with no record at all — the band is 11 points and a report
       is 20 Scouting Points, which is exactly what every class was shown at
       and every report cost before this phase. scouting_v1 only ever
       DIFFERENTIATES: read games well and you see more for less; read them
       badly and you see less for more; do neither and nothing changed. */
    'band',    jsonb_build_object('wide', 18, 'tight', 4),
    'report',  jsonb_build_object('dear', 28, 'cheap', 12),
    'ceiling', 6,          -- at most six points of POTENTIAL across the class
    'extra_pick', 90,      -- one more pick, at the top grade and only there
    'grades', jsonb_build_array(
      jsonb_build_object('key', 'unrated',  'name', 'Unrated',           'min',  0),
      jsonb_build_object('key', 'regional', 'name', 'Regional scout',    'min', 40),
      jsonb_build_object('key', 'area',     'name', 'Area scout',        'min', 55),
      jsonb_build_object('key', 'national', 'name', 'National scout',    'min', 68),
      jsonb_build_object('key', 'director', 'name', 'Scouting director', 'min', 80),
      jsonb_build_object('key', 'war_room', 'name', 'War room',          'min', 90)));
$$;

-- which grade a number is
create or replace function public.franchise_scout_grade_of(p_score integer)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select g from jsonb_array_elements(public.franchise_scouting()->'grades') g
   where (g->>'min')::int <= greatest(0, coalesce(p_score, 0))
   order by (g->>'min')::int desc limit 1;
$$;

-- THE BAND a prospect is shown in, at a grade. Eighteen points at 0, eleven
-- at neutral — what every class was shown at before this phase — and four at
-- the top; a straight line between, and never fewer than four, because a
-- department that sees the exact number has not scouted anybody, it has read
-- the answer.
create or replace function public.franchise_scout_band(p_score integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select greatest((public.franchise_scouting()->'band'->>'tight')::int,
    (public.franchise_scouting()->'band'->>'wide')::int
    - round(((public.franchise_scouting()->'band'->>'wide')::int
           - (public.franchise_scouting()->'band'->>'tight')::int)
           * least(100, greatest(0, coalesce(p_score, 0))) / 100.0)::int);
$$;

-- WHAT A REPORT COSTS at a grade: 28 Scouting Points down to 12 on the same
-- straight line, passing through the flat 20 of market_v1 at neutral.
create or replace function public.franchise_scout_cost(p_score integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select greatest((public.franchise_scouting()->'report'->>'cheap')::int,
    (public.franchise_scouting()->'report'->>'dear')::int
    - round(((public.franchise_scouting()->'report'->>'dear')::int
           - (public.franchise_scouting()->'report'->>'cheap')::int)
           * least(100, greatest(0, coalesce(p_score, 0))) / 100.0)::int);
$$;

-- HOW MUCH POTENTIAL the department finds: nothing at a neutral grade, up to
-- six points at the top. Below neutral it finds nothing rather than taking
-- something away — a bad department is a department that misses, not one
-- that makes players worse.
create or replace function public.franchise_scout_lift(p_score integer)
returns integer language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select greatest(0, round((public.franchise_scouting()->>'ceiling')::int
    * least(100, greatest(0, coalesce(p_score, 0) - (public.franchise_scouting()->>'neutral')::int))
    / (100.0 - (public.franchise_scouting()->>'neutral')::int))::int);
$$;

-- THE GRADE ITSELF. The last twenty VERIFIED pricings — an imported history
-- earns XP and is not evidence of anything, so it is not counted — averaged,
-- and pulled toward neutral in proportion to how far short of twenty the
-- record is. Fifteen pricings at 80 grade 72, not 80; the twentieth is worth
-- more than the first, which is the point.
create or replace function public.franchise_scout_report(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cfg jsonb := public.franchise_scouting();
  n_win integer := (cfg->>'window')::int; neutral integer := (cfg->>'neutral')::int;
  n_have integer; v_avg numeric; v_score integer; g jsonb; nxt jsonb;
begin
  select count(*), avg((detail->>'score')::numeric) into n_have, v_avg from (
    select detail from public.franchise_activity
     where franchise_id = p_franchise and kind = 'price_it' and verified
       and detail ? 'score'
     order by created_at desc, id desc limit n_win) t;
  v_score := round((coalesce(v_avg, 0) * n_have + neutral * (n_win - least(n_win, n_have))) / n_win)::int;
  v_score := greatest(0, least(100, v_score));
  g := public.franchise_scout_grade_of(v_score);
  select x into nxt from jsonb_array_elements(cfg->'grades') x
   where (x->>'min')::int > v_score order by (x->>'min')::int limit 1;
  return jsonb_build_object(
    'version', cfg->>'version', 'score', v_score,
    'grade', g->>'key', 'grade_name', g->>'name',
    'priced', n_have, 'window', n_win,
    'raw', case when n_have = 0 then null else round(v_avg)::int end,
    'settled', n_have >= n_win,
    'band', public.franchise_scout_band(v_score),
    'report_cost', public.franchise_scout_cost(v_score),
    'lift', public.franchise_scout_lift(v_score),
    'extra_pick', v_score >= (cfg->>'extra_pick')::int,
    'next', case when nxt is null then null else jsonb_build_object(
      'name', nxt->>'name', 'at', (nxt->>'min')::int, 'need', (nxt->>'min')::int - v_score) end);
end;
$$;

commit;

-- ===========================================================================
-- THE DEVELOPMENT PROGRAM — Phase 10, development_v1
--
-- A PLAYER CANNOT BE MADE BETTER THAN HE WAS BORN, and that was the ceiling
-- on the whole game. This is what the file measured before the phase was
-- written, over ten seasons of a franchise that did everything right — every
-- facility maxed, every pick used, every free agent signed, every prospect
-- scouted, four coaches hired and promoted:
--
--   team overall  season 1: 69   season 4: 71   season 10: 71
--   record        6-3            4-4            6-3
--
-- Ten years of perfect play was worth two points. The cause is one line in
-- franchise_offseason(): growth past a man's potential is clawed straight
-- back, and potential itself only ever holds the line. By season ten, 76%
-- of the roster sat exactly at its ceiling with 1.43 points of headroom
-- left across the whole squad. The facilities and the trainer do not raise
-- the wall; they only get a man to it sooner.
--
-- And the wall is low, and the same for everybody. Of 425 players generated
-- across twenty franchise-seasons: none with 90 potential, two with 85, the
-- generator's best 83. THE FINEST 42 EVER ROLLED WOULD RATE 78. There was no
-- great team to reach — though the simulator pays for one handsomely: a
-- roster pinned at 55 wins 37% of its games, one pinned at 85 wins all of
-- them, 40.5 points for against 8.1.
--
-- Meanwhile Scouting Points had become the mirror of the Coach Points
-- problem Phase 8 fixed — dead by SURPLUS. The same ten seasons banked
-- 6,050 and spent 1,550. And every yard, touchdown, tackle and sack a man
-- accumulated over a decade was written, shown in the Trophy Room, and read
-- by nothing: the only statistic the game consumed was a binary "played
-- four games".
--
-- So: an offseason in which you invest in your own players, paid for with
-- the currency nobody could spend, and graded on the football they actually
-- played.
--
--   THE WINDOW    a program is bought AFTER a season completes and BEFORE
--                 the next is started — the one moment the season just
--                 played is still on the books. Starting the next season
--                 clears it. That is the ritual: finish, look at who played,
--                 invest, advance.
--
--   THE SLOTS     two, plus one for every level of the Training Center, so
--                 two to five a year. Scarcity is the whole decision: not
--                 "can I afford it" but WHO.
--
--   THE GRADE     what he did on the field, 0 to 100, read straight out of
--                 the boxes the simulator already wrote:
--                     40  availability — he played the games
--                     30  the team's record in the games he played
--                     30  his impact against PAR for his position and depth
--                 Par is published below and was measured off 4,000 real
--                 box lines. Where the box score does not measure a man —
--                 the offensive line, the punter — impact sits exactly at
--                 par by construction and his grade is availability and the
--                 team's record, which is the honest way to grade a lineman.
--
--   WHAT IT BUYS  POTENTIAL, never overall. A program does not make a
--                 nineteen-year-old better today; it earns him the RIGHT to
--                 grow, and he still has to grow into it through the same
--                 offseason curve as everybody else. So the Training Center
--                 and the head trainer become more valuable, not less.
--
--   THE LIMITS    +1 to +6 a program by grade, so a benched man gains almost
--                 nothing and an ever-present starter on a winning team gains
--                 six. Full value to 26, half from 27 to 29, nothing at 30 —
--                 the same shape the development curve already has. And a
--                 lifetime cap of +15 per man, about three good programs, so
--                 an 83-potential prospect can become a 98 and no man is ever
--                 remade in one offseason.
--
-- WHAT THIS IS NOT. It is not a way to buy overall, not a way to fix a bad
-- roster in an offseason, and not available to a man over thirty. It is a
-- decade-long project for a franchise that plays its young men and reads
-- real football well enough to pay for it.
-- ===========================================================================

begin;

-- how much potential this man has been given beyond what he was born with,
-- and how many programs it took: the cost curve reads the first, the record
-- reads both, and neither ever falls
alter table public.game_players add column if not exists developed integer not null default 0;
alter table public.game_players add column if not exists programs integer not null default 0;

alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release',
   'conf_joined','conf_season','conf_game','conf_win','conf_playoff','conf_title',
   'bowl_bid','injury','trade',
   'staff_hire','staff_promote','staff_fire',
   'program',
   'live_game','live_game_extra'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('dev_first',  'Development Program', 'Put a player through his first development program.', null, 110),
  ('dev_ten',    'Ten Points Better',   'Carried a player ten points past the ceiling he was born with.', null, 111),
  ('dev_capped', 'Made, Not Found',     'Took a player to the top of what a development program can give.', null, 112),
  ('dynasty_80', 'A Real Team',         'Fielded a roster rated 80 overall.', null, 113)
on conflict (id) do nothing;

-- THE TABLE. Everything development_v1 is, in one place a page can render
-- without a round trip.
create or replace function public.franchise_development()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'development_v1',
    'slots_base', 2,          -- plus one for every level of the Training Center
    'slots_per_rank', 10,     -- and one for every ten ranks of having played
    'cap', 15,                -- the most potential one man can ever be given
    'cost_base', 100,         -- Scouting Points for a man never developed
    'cost_step', 15,          -- and 15 more for every point already given
    'lift_base', 1, 'lift_span', 5,        -- +1 at grade 0, +6 at grade 100
    'age_full', 26, 'age_half', 29,        -- half from 27, nothing at 30
    'grade', jsonb_build_object('available', 40, 'record', 30, 'impact', 30),
    -- PAR: the average impact per game for a position at a depth, measured
    -- off four thousand box lines the simulator wrote. The offensive line
    -- and the punter are flat by construction — the box score does not
    -- measure them — so their grade is availability and the team's record.
    'par', jsonb_build_object(
      'QB', jsonb_build_array(18.0),
      'RB', jsonb_build_array(14.8, 4.5),
      'WR', jsonb_build_array(6.9, 5.4, 3.7, 1.6),
      'TE', jsonb_build_array(3.8),
      'OL', jsonb_build_array(0.1),
      'DL', jsonb_build_array(5.7, 4.4, 3.3, 4.0),
      'LB', jsonb_build_array(7.5, 4.9, 3.8),
      'CB', jsonb_build_array(4.5, 4.0),
      'S',  jsonb_build_array(5.1, 4.0),
      'K',  jsonb_build_array(3.7),
      'P',  jsonb_build_array(0.2)));
$$;

-- par for a position at a depth: the last entry stands for every deeper slot,
-- so a sixth receiver is graded against the fourth and nobody falls off the
-- end of the table
create or replace function public.franchise_dev_par(p_position text, p_depth integer)
returns numeric language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(
    (public.franchise_development()->'par'->coalesce(p_position, '')
      ->> least(greatest(coalesce(p_depth, 1), 1) - 1,
                jsonb_array_length(coalesce(public.franchise_development()->'par'->coalesce(p_position, ''),
                                            '[]'::jsonb)) - 1))::numeric,
    1.0);
$$;

-- WHAT THE NEXT PROGRAM COSTS: 100 Scouting Points for a man never
-- developed, 15 more for every point already given him. Priced so that a
-- franchise reading real football diligently can fill its places — the
-- decision this phase asks for is WHO, not whether the purse stretches.
create or replace function public.franchise_dev_cost(p_developed integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (public.franchise_development()->>'cost_base')::int
       + (public.franchise_development()->>'cost_step')::int
         * least(greatest(coalesce(p_developed, 0), 0), (public.franchise_development()->>'cap')::int);
$$;

-- WHAT A GRADE IS WORTH: +1 at nothing, +4 at a perfect season, halved from
-- twenty-seven and nothing at thirty — the shape the offseason curve has.
create or replace function public.franchise_dev_lift(p_grade integer, p_age integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when coalesce(p_age, 0) > (public.franchise_development()->>'age_half')::int then 0
    when coalesce(p_age, 0) > (public.franchise_development()->>'age_full')::int
      then greatest(1, ((public.franchise_development()->>'lift_base')::int
        + round((public.franchise_development()->>'lift_span')::int
                * least(100, greatest(0, coalesce(p_grade, 0))) / 100.0)::int) / 2)
    else (public.franchise_development()->>'lift_base')::int
       + round((public.franchise_development()->>'lift_span')::int
               * least(100, greatest(0, coalesce(p_grade, 0))) / 100.0)::int end;
$$;

-- HOW MANY PROGRAMS A YEAR: two, plus a level of the Training Center. The
-- facility that was finished by season four has something to do again.
-- ...AND ONE FOR EVERY TEN RANKS (rank_v1). Measured over sixty seasons: at
-- two-to-five places a year a franchise could not spend what it earned —
-- 7,950 Scouting Points banked against about nine hundred a season spent —
-- and it could not rebuild through the retirement wave that takes a founding
-- roster out together around season ten, after which team overall fell from
-- 81 and never came back. A franchise that has played for years has a bigger
-- department; that is what the rank measures, and it is what the surplus is
-- for.
create or replace function public.franchise_dev_slots(p_franchise uuid)
returns integer language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return (public.franchise_development()->>'slots_base')::int
       + coalesce((select (facilities->>'training')::int from public.franchises where id = p_franchise), 0)
       + floor(coalesce((public.franchise_rank_report(p_franchise)->>'rank')::int, 1)
               / (public.franchise_development()->>'slots_per_rank')::numeric)::int;
end;
$$;

-- THE GRADE, read out of the boxes the simulator already wrote. Nothing is
-- accumulated for this and nothing was added to the hot path: a season's
-- games carry their own box, and the box carries every player's line and the
-- impact number the simulator computed to name a player of the game.
create or replace function public.franchise_dev_grade(p_franchise uuid, p_player uuid, p_season integer)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cfg jsonb := public.franchise_development(); pl public.game_players%rowtype;
  n_games integer; n_played integer; n_won integer; v_imp numeric; v_par numeric;
  a numeric; r numeric; i numeric; v_grade integer;
begin
  select * into pl from public.game_players where id = p_player and franchise_id = p_franchise;
  if not found then return null; end if;
  select count(*) into n_games from public.franchise_games
   where franchise_id = p_franchise and season_number = p_season and status = 'final';
  select count(*), count(*) filter (where g.result = 'W'), coalesce(sum((ln->>'impact')::numeric), 0)
    into n_played, n_won, v_imp
    from public.franchise_games g, jsonb_array_elements(g.box->'players') ln
   where g.franchise_id = p_franchise and g.season_number = p_season and g.status = 'final'
     and g.box is not null and (ln->>'id')::uuid = p_player;
  v_par := public.franchise_dev_par(pl.position, pl.depth);
  -- availability, the team's record in the games he played, and his own
  -- impact against par. A man who did not play at all grades zero.
  a := case when n_games = 0 then 0 else least(1, n_played::numeric / n_games) end;
  r := case when n_played = 0 then 0 else n_won::numeric / n_played end;
  i := case when n_played = 0 or v_par <= 0 then 0
            else least(1, (v_imp / n_played) / (2 * v_par)) end;
  v_grade := least(100, greatest(0, round(
      (cfg->'grade'->>'available')::int * a
    + (cfg->'grade'->>'record')::int * r
    + (cfg->'grade'->>'impact')::int * i)::int));
  return jsonb_build_object('grade', v_grade, 'played', n_played, 'games', n_games, 'won', n_won,
    'impact', round(case when n_played = 0 then 0 else v_imp / n_played end, 2), 'par', v_par,
    'parts', jsonb_build_object('available', round(a * 100)::int, 'record', round(r * 100)::int, 'impact', round(i * 100)::int));
end;
$$;

commit;

begin;

-- PUT A MAN THROUGH A PROGRAM. Refused before anything is written: the
-- window must be open, a slot must be free, the purse must cover it, he must
-- be under thirty and not already at his cap. One negative ledger row keyed
-- by the season and the player, so a replayed request cannot pay twice.
create or replace function public.franchise_develop(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; p public.game_players%rowtype;
  cfg jsonb := public.franchise_development(); s public.franchise_seasons%rowtype;
  v_cost integer; v_slots integer; v_used integer; v_grade jsonb; v_lift integer; v_cap integer;
  ok boolean; v_new text[] := '{}'; v_real integer := public.games_season_of(now()); v_ovr integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found or s.status <> 'complete' then
    raise exception 'the development window opens when a season is complete and closes when the next one starts'
      using errcode = '55000';
  end if;
  select * into p from public.game_players where id = p_player and franchise_id = v_f for update;
  if not found or p.status <> 'active' then
    raise exception 'that player is not on your roster' using errcode = 'P0002';
  end if;
  v_cap := (cfg->>'cap')::int;
  if p.developed >= v_cap then
    raise exception '% has had everything a program can give (+% is the cap)',
      p.first_name || ' ' || p.last_name, v_cap using errcode = '55000';
  end if;
  if p.age > (cfg->>'age_half')::int then
    raise exception '% is %; a program does nothing past %',
      p.first_name || ' ' || p.last_name, p.age, (cfg->>'age_half')::int using errcode = '55000';
  end if;
  v_slots := public.franchise_dev_slots(v_f);
  select count(*) into v_used from public.franchise_activity
   where franchise_id = v_f and kind = 'program' and key like s.number || ':%';
  if v_used >= v_slots then
    raise exception 'no places left this offseason: % of %', v_used, v_slots using errcode = '55000';
  end if;
  v_cost := public.franchise_dev_cost(p.developed);
  if f.scouting_points < v_cost then
    raise exception 'not enough Scouting Points: % needed, % on hand', v_cost, f.scouting_points using errcode = '55000';
  end if;

  v_grade := public.franchise_dev_grade(v_f, p.id, s.number);
  v_lift := least(public.franchise_dev_lift((v_grade->>'grade')::int, p.age), v_cap - p.developed);

  ok := public.franchise_credit(v_f, 'sp', -v_cost, 'program', s.number || ':' || p.id::text,
          'Development: ' || p.first_name || ' ' || p.last_name);
  if not ok then raise exception 'that program is already on the books' using errcode = '55000'; end if;

  -- POTENTIAL, NEVER OVERALL. He has earned the right to grow; the offseason
  -- that follows is where he grows into it.
  update public.game_players
     set potential = least(99, potential + v_lift),
         developed = developed + v_lift,
         programs = programs + 1,
         rarity = case when overall >= 82 or least(99, potential + v_lift) >= 90 then 'elite'
                       when overall >= 75 or least(99, potential + v_lift) >= 84 then 'rare'
                       when overall >= 68 or least(99, potential + v_lift) >= 77 then 'uncommon'
                       else 'common' end,
         updated_at = now()
   where id = p.id;

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'program', s.number || ':' || p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position, 'age', p.age,
            'season', s.number, 'grade', (v_grade->>'grade')::int, 'lift', v_lift, 'cost', v_cost, 'currency', 'sp',
            'developed', p.developed + v_lift, 'potential', least(99, p.potential + v_lift),
            'version', cfg->>'version'))
  on conflict (franchise_id, kind, key) do nothing;

  if public.franchise_award(v_f, 'dev_first', v_real, jsonb_build_object('player', p.id)) then
    v_new := array_append(v_new, 'dev_first'); end if;
  if p.developed + v_lift >= 10
     and public.franchise_award(v_f, 'dev_ten', v_real, jsonb_build_object('player', p.id, 'developed', p.developed + v_lift)) then
    v_new := array_append(v_new, 'dev_ten'); end if;
  if p.developed + v_lift >= v_cap
     and public.franchise_award(v_f, 'dev_capped', v_real, jsonb_build_object('player', p.id)) then
    v_new := array_append(v_new, 'dev_capped'); end if;

  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'player', public.franchise_prospect_json(p), 'grade', v_grade,
    'lift', v_lift, 'cost', v_cost, 'currency', 'sp',
    'slots', jsonb_build_object('used', v_used + 1, 'of', v_slots),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_f));
end;
$$;

-- THE BOARD: whether the window is open, what a place costs, and every man
-- on the roster with the season he just played and what a program would give
-- him. One read.
create or replace function public.franchise_development_board(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; cfg jsonb := public.franchise_development(); s public.franchise_seasons%rowtype;
  v_open boolean; v_slots integer; v_used integer; v_men jsonb := '[]'::jsonb; p public.game_players%rowtype;
  g jsonb; v_lift integer; v_cost integer; v_cap integer := (cfg->>'cap')::int;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select * into s from public.franchise_seasons where franchise_id = f.id order by number desc limit 1;
  v_open := found and s.status = 'complete';
  v_slots := public.franchise_dev_slots(f.id);
  select count(*) into v_used from public.franchise_activity
   where franchise_id = f.id and kind = 'program' and key like coalesce(s.number, 0) || ':%';
  for p in select * from public.game_players where franchise_id = f.id and status = 'active'
            order by position, depth, overall desc loop
    g := case when s.number is null then null else public.franchise_dev_grade(f.id, p.id, s.number) end;
    v_cost := public.franchise_dev_cost(p.developed);
    v_lift := case when p.developed >= v_cap then 0
                   else least(public.franchise_dev_lift(coalesce((g->>'grade')::int, 0), p.age), v_cap - p.developed) end;
    v_men := v_men || jsonb_build_object(
      'id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'depth', p.depth,
      'age', p.age, 'overall', p.overall, 'potential', p.potential, 'dev_tier', p.dev_tier,
      'developed', p.developed, 'programs', p.programs, 'capped', p.developed >= v_cap,
      'grade', g, 'lift', v_lift, 'cost', v_cost,
      'affordable', f.scouting_points >= v_cost,
      'eligible', v_open and p.developed < v_cap and p.age <= (cfg->>'age_half')::int,
      'done', exists (select 1 from public.franchise_activity a
                       where a.franchise_id = f.id and a.kind = 'program'
                         and a.key = coalesce(s.number, 0) || ':' || p.id::text));
  end loop;
  return jsonb_build_object(
    'version', cfg->>'version', 'rules', cfg,
    'open', v_open,
    'season', jsonb_build_object('number', s.number, 'label', s.label, 'status', s.status,
      'wins', s.wins, 'losses', s.losses, 'ties', s.ties),
    'slots', jsonb_build_object('of', v_slots, 'used', v_used, 'left', greatest(0, v_slots - v_used),
      'base', (cfg->>'slots_base')::int, 'training', coalesce((f.facilities->>'training')::int, 0)),
    'resources', public.franchise_totals(f.id),
    'players', v_men,
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', a.created_at, 'detail', a.detail)
        order by a.created_at desc, a.id desc)
      from (select * from public.franchise_activity where franchise_id = f.id and kind = 'program'
             order by created_at desc, id desc limit 12) a), '[]'::jsonb));
end;
$$;

commit;

-- ===========================================================================
-- A LEAGUE THAT STANDS STILL — Phase 10, league_v1
--
-- THE DEEPER HALF OF THE SAME PROBLEM. A development program raises a man's
-- ceiling, but before this phase raising it could not win a single extra
-- game, because of one line in franchise_schedule_season():
--
--     oovr := greatest(45, least(95, round(ovr + d + (random() * 2 - 1))));
--
-- Every opponent was rated FROM YOUR OWN TEAM OVERALL, plus a fixed offset
-- from [-6,-3,-1,0,1,2,4]. The league was a rubber band: get better and it
-- got better with you, exactly in step, and your record was pinned to those
-- seven offsets whatever you did. Twelve seasons of A/B measurement, four
-- franchises an arm on identical seeds, found the program worth +2.8 team
-- overall and NOT ONE EXTRA WIN. It could not have been otherwise.
--
-- So the twenty-four clubs get ratings of their own. They are published,
-- absolute, and have nothing to do with you: Trenton is a 58 and Kingsport
-- is an 86 whether you are a 60 or a 95.
--
--   STANDING      where the franchise sits in the league, 0 to 100, moved by
--                 RESULTS and nothing else. Beating a club above you is worth
--                 several; beating one well below is worth one. Losing to a
--                 club above you costs one; losing to one below costs several.
--                 The rival counts double either way. It starts at 40,
--                 which is the bottom third: a new franchise begins among
--                 clubs it can beat.
--
--   THE SLATE     each season is drawn around your standing — most of it
--                 near you, one club well above, one well below, and the
--                 rival last. Climb and the schedule hardens; fall and it
--                 softens. That is the protection the rubber band used to
--                 give, kept, without the part that made improvement
--                 pointless: WITHIN a season the clubs do not move, and a
--                 better roster beats them.
--
--   THE CLIMB     is the point. At standing 40 you play clubs in the sixties
--                 and win. Winning lifts you into the seventies, where the
--                 roster you have is no longer enough — and the development
--                 program is how you answer. A dynasty is a franchise that
--                 climbed to the top of the league and can still win there.
-- ===========================================================================

begin;

-- an absolute rating for every club, and the tier it sits in. Published, so
-- a page can show the league table, and fixed, so a season means something.
-- A DEFAULT, NOT A NULL. The pool's own seed insert sits in Phase 1, far
-- above this line, and re-runs before it — a not-null with no default makes
-- the second application of this file fail on the first club. The real
-- ratings are set immediately below; the default only has to be legal.
alter table public.franchise_opponents add column if not exists strength integer not null default 70;
-- where this franchise stands in that league, 0 to 100
alter table public.franchises add column if not exists standing integer not null default 40;

-- THE LEAGUE TABLE. Twenty-four clubs from 54 to 88, spread evenly so every
-- standing has somebody to play, keyed off the pool's own sort order so the
-- table is the same in every database that ever applies this file.
update public.franchise_opponents o set strength = t.s
  from (select key, 54 + ((sort - 1) * 34) / 23 as s from public.franchise_opponents) t
 where o.key = t.key and o.strength is distinct from t.s;

create or replace function public.franchise_league()
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'version', 'league_v1',
    'standing_start', 40, 'standing_min', 0, 'standing_max', 100,
    -- what a result moves the standing: a win is worth more against a better
    -- club, a loss costs more against a worse one, and the rival counts double
    'win_base', 2, 'loss_base', -3, 'edge_per_point', 0.20, 'rival_multiplier', 2,
    'clubs', coalesce((select jsonb_agg(jsonb_build_object(
        'key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr,
        'logo', o.logo, 'theme', o.theme, 'style', o.style, 'strength', o.strength)
        order by o.strength desc, o.key) from public.franchise_opponents o), '[]'::jsonb));
$$;

-- WHAT A CLUB IS WORTH TO YOU, at a standing: the gap between where you
-- stand and what it rates, so a page can say "you are not ready for these"
-- without pretending to simulate anything.
-- The middle of the slate at a standing. MEASURED, not guessed: with rosters
-- pinned at fixed ratings, a team playing clubs of its own rating wins about
-- four of nine, not half — so the slate sits a little BELOW where you stand,
-- or a franchise ratchets into a difficulty it cannot answer and simply loses
-- from then on. At the top of the standing it is 82, and the best clubs in
-- the league rate 88, so the very top is always a stretch.
create or replace function public.franchise_league_gap(p_standing integer, p_strength integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_strength, 0) - (48 + round(coalesce(p_standing, 40) * 0.34)::int);
$$;

-- WHAT A RESULT MOVES THE STANDING. A win over a club well above you is worth
-- several; a win over one well below is worth almost nothing. Losing to a
-- weaker club costs. The rival counts double, either way.
-- ROUNDED FIRST, THEN DOUBLED. "A rival win is worth twice as much" is a
-- promise the game makes to a player, so it is kept exactly: rounding the
-- doubled figure instead would make a 3.6 into 4 and a 7.2 into 7, and 7 is
-- not twice 4.
create or replace function public.franchise_standing_delta(
  p_result text, p_standing integer, p_strength integer, p_rival boolean default false)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select round(
    case p_result
      when 'W' then greatest(1, (public.franchise_league()->>'win_base')::numeric
             + (public.franchise_league()->>'edge_per_point')::numeric
               * public.franchise_league_gap(p_standing, p_strength))
      -- the gap is added, not subtracted: a NEGATIVE gap is a club below you,
      -- and losing to one of those is what costs. Losing to a club well above
      -- you costs the floor of one and no more.
      when 'L' then least(-1, (public.franchise_league()->>'loss_base')::numeric
             + (public.franchise_league()->>'edge_per_point')::numeric
               * public.franchise_league_gap(p_standing, p_strength))
      else 0 end)::int
    * case when p_rival then (public.franchise_league()->>'rival_multiplier')::int else 1 end;
$$;

commit;

-- ===========================================================================
-- THE RANK AND THE PACKS — Phase 11, rank_v1 and packs_v1
--
-- WHAT PLAYING A LOT IS WORTH. Every other progression in this game is paid
-- for by being GOOD at something: Scouting Points by pricing games well,
-- Coach Points by winning, the standing by beating better clubs. Nothing was
-- paid for by simply turning up, and the one number that measured turning up
-- — the franchise LEVEL, off XP — was displayed on the Front Office and
-- decided nothing at all. It also stopped: the curve caps at level 30, which
-- a franchise playing three Price Its a week reaches in about nine seasons
-- and then never moves again.
--
-- So: a RANK that counts what you did rather than how well, never caps, and
-- pays in the one thing a football franchise always wants — players.
--
--   THE RANK      counted from the activity already on the record: every
--                 game played, every game priced, every drill, every card,
--                 every research read, and five for finishing a season.
--                 Nothing new is written for it and nothing was added to a
--                 hot path — it is DERIVED, the way scouting_points is
--                 derived from the ledger, so it can never drift from what
--                 the franchise actually did.
--
--                 Rank 2 costs 15 points, and every rank after costs three
--                 more than the one before. A first season is worth about
--                 fifty points and lands around rank 3; sixty seasons land
--                 in the forties. There is always another rank.
--
--   THE PACK      one for every rank, held until opened. A pack is THREE
--                 players and you keep ONE — that is the decision, and it is
--                 also what keeps forty packs from burying a forty-two man
--                 roster. The other two are passed over and stay on the
--                 record as men you turned down.
--
--   WHO IS IN IT  drawn around YOUR OWN TEAM OVERALL, so a pack is never
--                 junk and never a shortcut: the floor sits ten below your
--                 team and the ceiling rises with the rank — plus two at
--                 rank 1, plus fourteen at rank 40. Playing more does not
--                 hand you better players outright; it widens the top of
--                 what a pack can contain, and the roll still has to land.
--
-- NOTHING HERE IS PURCHASABLE. A pack is earned by playing and by nothing
-- else. There is no pack to buy, no currency that buys one, and no way to
-- open one faster with money — the same rule every other phase of this file
-- keeps, and the reason a rank counts activity rather than spending.
-- ===========================================================================

begin;

alter table public.game_players drop constraint if exists game_players_status_check;
alter table public.game_players add constraint game_players_status_check
  check (status in ('active','injured','retired','released','prospect','free_agent','passed','pack'));

-- how many ranks have been paid out in packs. The rank itself is derived, so
-- this is the only thing that needs remembering: what has already been given.
alter table public.franchises add column if not exists rank_claimed integer not null default 0;
-- which pack a man came out of, so a card can say so for the rest of his career
alter table public.game_players add column if not exists pack_rank integer;

alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release',
   'conf_joined','conf_season','conf_game','conf_win','conf_playoff','conf_title',
   'bowl_bid','injury','trade',
   'staff_hire','staff_promote','staff_fire',
   'program','pack'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('pack_first', 'First Pack',    'Opened your first pack and kept a player.', null, 120),
  ('pack_ten',   'Ten Packs',     'Opened ten packs.', null, 121),
  ('rank_ten',   'Rank Ten',      'Reached rank ten by playing.', null, 122),
  ('rank_25',    'Rank Twenty-Five', 'Reached rank twenty-five. That is a lot of football.', null, 123)
on conflict (id) do nothing;

-- THE TABLE. What an activity is worth, what a rank costs, and what a pack
-- can hold — in one place a page can render without a round trip.
create or replace function public.franchise_ranks()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'rank_v1',
    'pack_version', 'packs_v1',
    'cost_base', 15, 'cost_step', 3,     -- rank 2 costs 15, and three more each time
    'pack_size', 3, 'pack_keep', 1,      -- three men, one kept
    'floor_below', 10,                   -- a pack's floor, under your team overall
    'edge_base', 2, 'edge_per_rank', 0.3, 'edge_max', 14,
    -- what turning up is worth. A season of playing weekly, pricing three
    -- games a week and running a drill is about fifty.
    'weights', jsonb_build_object(
      'weekly_game', 3, 'bowl_bid', 3, 'conf_game', 3, 'fc_played', 2,
      'price_it', 1, 'drill_daily', 1, 'research_open', 1,
      'pick5_card', 2, 'season_complete', 5, 'live_game', 2));
$$;

-- WHAT THE NEXT RANK COSTS: 15 points, and three more for every rank already
-- held. Uncapped on purpose — the staff climbs to a thousand and this climbs
-- with the seasons; there is always another one.
create or replace function public.franchise_rank_cost(p_rank integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (public.franchise_ranks()->>'cost_base')::int
       + (public.franchise_ranks()->>'cost_step')::int * greatest(0, coalesce(p_rank, 1) - 1);
$$;

-- the points it takes to STAND at a rank: the sum of every step below it
create or replace function public.franchise_rank_at(p_rank integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce((select sum(public.franchise_rank_cost(t.n))::int
                     from generate_series(1, greatest(0, coalesce(p_rank, 1) - 1)) as t(n)), 0);
$$;

-- and the rank a pile of points buys. Closed form rather than a loop: the
-- cost is an arithmetic series, so the rank is the root of a quadratic, and
-- a franchise sixty seasons deep should not cost sixty iterations to read.
create or replace function public.franchise_rank_for(p_points integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select greatest(1, floor(
    (2 * ((public.franchise_ranks()->>'cost_base')::numeric
          - (public.franchise_ranks()->>'cost_step')::numeric / 2)
     * -1
     + sqrt(power(2 * (public.franchise_ranks()->>'cost_base')::numeric
                  - (public.franchise_ranks()->>'cost_step')::numeric, 2)
            + 8 * (public.franchise_ranks()->>'cost_step')::numeric * greatest(0, coalesce(p_points, 0))))
    / (2 * (public.franchise_ranks()->>'cost_step')::numeric) + 1)::int);
$$;

-- HOW FAR A PACK CAN REACH ABOVE YOUR TEAM: two at rank one, and three
-- tenths of a rank after, to a ceiling of fourteen. Playing more does not
-- hand you better players — it widens the top of what a pack can contain.
create or replace function public.franchise_rank_edge(p_rank integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select least((public.franchise_ranks()->>'edge_max')::int,
    (public.franchise_ranks()->>'edge_base')::int
    + floor((public.franchise_ranks()->>'edge_per_rank')::numeric * greatest(0, coalesce(p_rank, 1) - 1))::int);
$$;

-- WHAT THIS FRANCHISE HAS DONE, and what it is worth. Derived from the
-- activity already on the record — nothing is written for a rank and nothing
-- was added to a hot path, so this can never drift from what was played.
create or replace function public.franchise_rank_report(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cfg jsonb := public.franchise_ranks(); w jsonb := cfg->'weights';
  v_points integer; v_rank integer; v_claimed integer;
begin
  select coalesce(sum(coalesce((w->>a.kind)::int, 0)), 0) into v_points
    from public.franchise_activity a where a.franchise_id = p_franchise;
  v_rank := public.franchise_rank_for(v_points);
  select rank_claimed into v_claimed from public.franchises where id = p_franchise;
  return jsonb_build_object(
    'version', cfg->>'version', 'points', v_points, 'rank', v_rank,
    'at', public.franchise_rank_at(v_rank),
    'next_at', public.franchise_rank_at(v_rank + 1),
    'next_cost', public.franchise_rank_cost(v_rank),
    'to_next', greatest(0, public.franchise_rank_at(v_rank + 1) - v_points),
    'edge', public.franchise_rank_edge(v_rank),
    'claimed', coalesce(v_claimed, 0),
    'packs', greatest(0, v_rank - coalesce(v_claimed, 0)));
end;
$$;

commit;

begin;

-- OPEN A PACK. One rank, one pack: the rank must be ahead of what has been
-- claimed, and claiming it is the same statement that generates the men, so
-- a replayed request cannot open the same rank twice.
create or replace function public.franchise_pack_open(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype;
  cfg jsonb := public.franchise_ranks(); rep jsonb; v_rank integer; v_ovr integer;
  v_low integer; v_high integer; v_target integer; i integer; pos text; pid uuid;
  pool text[] := array['QB','RB','WR','TE','OL','DL','LB','CB','S','WR','DL','CB'];
  v_men jsonb := '[]'::jsonb; v_new text[] := '{}'; v_real integer := public.games_season_of(now());
  v_seed text; v_cp integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  rep := public.franchise_rank_report(v_f);
  if (rep->>'packs')::int < 1 then
    raise exception 'no pack to open: rank % and % already claimed', rep->>'rank', rep->>'claimed'
      using errcode = '55000';
  end if;
  -- an unopened pack of a previous rank is finished first, so the three men
  -- on the table are never two packs' worth
  if exists (select 1 from public.game_players where franchise_id = v_f and status = 'pack') then
    raise exception 'open pack on the table: keep a man from it, or pass on it' using errcode = '55000';
  end if;

  v_rank := coalesce(f.rank_claimed, 0) + 1;
  v_ovr := (public.franchise_team_rating(v_f)->>'overall')::int;
  v_low := greatest(40, v_ovr - (cfg->>'floor_below')::int);
  -- a team rated below the floor would otherwise get a ceiling under it
  v_high := greatest(v_low, least(99, v_ovr + public.franchise_rank_edge(v_rank)));
  v_seed := f.seed || ':pack:' || v_rank;

  for i in 1..(cfg->>'pack_size')::int loop
    perform setseed(public.franchise_seed_float(v_seed || ':' || i));
    pos := pool[1 + ((v_rank - 1) * 5 + i - 1) % array_length(pool, 1)];
    -- the roll: somewhere between the floor and the ceiling, and the SERVER
    -- rolls it. A pack is generated once, from the franchise's own seed and
    -- the rank, so the same rank opens the same pack however often it is read.
    v_target := v_low + floor(random() * greatest(1, v_high - v_low + 1))::int;
    pid := public.franchise_generate_player(v_f, pos, 0, v_real, v_seed || ':' || i,
             'Pack, rank ' || v_rank, 'pack', null, v_target);
    update public.game_players set pack_rank = v_rank where id = pid;
    select v_men || public.franchise_prospect_json(p) into v_men
      from public.game_players p where p.id = pid;
  end loop;

  update public.franchises set rank_claimed = v_rank, updated_at = now() where id = v_f;
  -- A RANK PAYS COACH POINTS TOO (staff_v2). Sixty seasons of winning paid
  -- 621 CP, against a building that costs thousands — one coach at level 99
  -- and three empty chairs. Turning up is what staffs a building, and the
  -- rank is what measures turning up. Keyed by the rank, so it pays once.
  v_cp := public.franchise_rank_coach_points(v_rank);
  perform public.franchise_credit(v_f, 'cp', v_cp, 'pack', v_rank::text,
    'Rank ' || v_rank || ': the building');
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'pack', v_rank::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('rank', v_rank, 'team_overall', v_ovr, 'low', v_low, 'high', v_high,
            'edge', public.franchise_rank_edge(v_rank), 'coach_points', v_cp,
            'version', cfg->>'pack_version'))
  on conflict (franchise_id, kind, key) do nothing;

  if public.franchise_award(v_f, 'pack_first', v_real, jsonb_build_object('rank', v_rank)) then
    v_new := array_append(v_new, 'pack_first'); end if;
  if v_rank >= 10 and public.franchise_award(v_f, 'pack_ten', v_real, jsonb_build_object('rank', v_rank)) then
    v_new := array_append(v_new, 'pack_ten'); end if;
  if v_rank >= 10 and public.franchise_award(v_f, 'rank_ten', v_real, jsonb_build_object('rank', v_rank)) then
    v_new := array_append(v_new, 'rank_ten'); end if;
  if v_rank >= 25 and public.franchise_award(v_f, 'rank_25', v_real, jsonb_build_object('rank', v_rank)) then
    v_new := array_append(v_new, 'rank_25'); end if;

  return jsonb_build_object('ok', true, 'rank', v_rank, 'players', v_men,
    'range', jsonb_build_array(v_low, v_high), 'team_overall', v_ovr, 'coach_points', v_cp,
    'keep', (cfg->>'pack_keep')::int, 'achievements', to_jsonb(v_new),
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- KEEP ONE. He joins the roster at the bottom of his position's chart; the
-- other two are passed over and stay on the record as men you turned down.
create or replace function public.franchise_pack_keep(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; p public.game_players%rowtype;
  m jsonb := public.franchise_market(); v_active integer; v_depth integer; v_passed integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  select * into p from public.game_players where id = p_player and franchise_id = v_f and status = 'pack' for update;
  if not found then raise exception 'that man is not in an open pack of yours' using errcode = 'P0002'; end if;
  select count(*) into v_active from public.game_players where franchise_id = v_f and status = 'active';
  if v_active >= (m->>'roster_max')::int then
    raise exception 'the roster is full at %: release a player first', (m->>'roster_max')::int using errcode = '55000';
  end if;

  select coalesce(max(depth), 0) + 1 into v_depth from public.game_players
   where franchise_id = v_f and position = p.position and status = 'active';
  update public.game_players
     set status = 'active', depth = v_depth,
         jersey = public.franchise_free_number(v_f, p.position, p.id::text),
         acquired_source = 'pack', acquired_season = public.games_season_of(now()),
         updated_at = now()
   where id = p.id;
  -- the two you turned down
  update public.game_players set status = 'passed', updated_at = now()
   where franchise_id = v_f and status = 'pack' and id <> p.id;
  get diagnostics v_passed = ROW_COUNT;

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'signing', p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position,
            'overall', p.overall, 'potential', p.potential, 'cost', 0, 'currency', 'pack',
            'pack_rank', p.pack_rank, 'passed', v_passed))
  on conflict (franchise_id, kind, key) do nothing;

  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'player', public.franchise_prospect_json(p),
    'passed', v_passed, 'roster_active', v_active + 1,
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- PASS ON THE WHOLE PACK. Measured over sixty seasons: a pack opened with a
-- full roster could not be kept from, and because two packs are never on the
-- table at once it then refused every pack after it — a franchise reached
-- rank 45 having claimed 37, with three men stuck on the table for twenty
-- seasons. There must always be a way forward, so this is it: turn all three
-- down. The rank is already spent either way, which is what makes it a real
-- decision rather than a free re-roll.
create or replace function public.franchise_pack_pass(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_n integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  update public.game_players set status = 'passed', updated_at = now()
   where franchise_id = v_f and status = 'pack';
  get diagnostics v_n = ROW_COUNT;
  if v_n = 0 then raise exception 'no pack on the table' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'passed', v_n,
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- THE BOARD: the rank, what the next one costs, how many packs are waiting,
-- and the three men on the table if a pack is open. One read.
create or replace function public.franchise_rank_board(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; cfg jsonb := public.franchise_ranks(); rep jsonb; v_ovr integer; v_active integer;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  rep := public.franchise_rank_report(f.id);
  v_ovr := (public.franchise_team_rating(f.id)->>'overall')::int;
  select count(*) into v_active from public.game_players where franchise_id = f.id and status = 'active';
  return jsonb_build_object(
    'version', cfg->>'version', 'pack_version', cfg->>'pack_version', 'rules', cfg,
    'rank', rep,
    'team_overall', v_ovr,
    'would_hold', jsonb_build_array(greatest(40, v_ovr - (cfg->>'floor_below')::int),
      greatest(greatest(40, v_ovr - (cfg->>'floor_below')::int),
               least(99, v_ovr + public.franchise_rank_edge((rep->>'rank')::int)))),
    'roster', jsonb_build_object('active', v_active, 'max', (public.franchise_market()->>'roster_max')::int,
      'room', greatest(0, (public.franchise_market()->>'roster_max')::int - v_active)),
    'open', coalesce((select jsonb_agg(public.franchise_prospect_json(p) order by p.overall desc)
                        from public.game_players p
                       where p.franchise_id = f.id and p.status = 'pack'), '[]'::jsonb),
    'kept', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name,
              'position', p.position, 'overall', p.overall, 'potential', p.potential, 'rank', p.pack_rank)
              order by p.pack_rank desc)
              from public.game_players p
             where p.franchise_id = f.id and p.acquired_source = 'pack' and p.status = 'active'), '[]'::jsonb),
    'resources', public.franchise_totals(f.id));
end;
$$;

commit;

-- ===========================================================================
-- THE LONG HAUL — Phase 12, career_v1 and staff_v2
--
-- MEASURED OVER SIXTY SEASONS, on the game as Phase 11 left it. It climbs
-- beautifully to season ten and then cannot carry on:
--
--   season    1    5   10   15   20   30   45   60
--   overall  69   80   81   75   73   74   76   71
--
-- Three faults, all of them about the LONG game rather than the first one.
--
-- ONE: THE ROSTER TURNS OVER IN A WAVE. The founding roster is generated at
-- ages 21 to 32, but skewed hard young by power(random(), 1.4) — so almost
-- nobody retires for seven seasons and then everybody does:
--
--   season       1-7    8    9   10   11   12   13   14   15+
--   founders out   1    4    1    5    4    2    4    7     0
--
-- Twenty-seven of thirty-eight founding players left in seven seasons, which
-- is the cliff the curve above falls off. Worse, their replacements were all
-- signed at once too, so the wave re-forms every fourteen years for ever.
-- Ages are now spread EVENLY across the same range, so about three men go
-- every season from the first, and the roster is always part-way through
-- renewing itself instead of doing it all at once.
--
-- TWO: THE BUILDING COULD NEVER BE STAFFED. Coach Points came only from
-- winning — two a win, five a bowl, one for the rival — which measured out
-- at TEN AND A HALF A SEASON. Reaching level 100 costs 540; four seats at
-- that level cost 2,160, or two hundred seasons. After sixty seasons of
-- winning football the measured franchise had ONE COACH AT LEVEL 99 and
-- three empty chairs. So the rank now pays Coach Points as well as a pack:
-- turning up is what staffs a building, and the rank is the number that
-- measures turning up.
--
-- THREE: A REPLACEMENT COACH STARTED AT LEVEL ONE, which made firing one
-- unthinkable — the README said so itself: "which is why almost nobody
-- will". That is not a choice, it is a trap. A coach now arrives at a level
-- set by the FRANCHISE'S REPUTATION — its rank and its standing — because a
-- club that has been at it for years and wins its games attracts somebody
-- who has done the job before. So both ways of playing work:
--
--   a new head coach every year, if you are bad and want to keep trying:
--   your reputation is low, so the men you hire are cheap and you lose
--   almost nothing by moving on;
--
--   three or four coaches across sixty seasons, if you are good: each
--   replacement arrives near what your reputation commands, and the years
--   you then put into him are what take him past it.
--
-- Keeping one man for sixty seasons is still the best a single seat can do.
-- It is no longer the only thing that is not a disaster.
-- ===========================================================================

begin;

-- ── ONE: a roster that renews itself every season ────────────────────────

-- what a career looks like, published so a page can say it
create or replace function public.franchise_career()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'career_v1',
    'found_age_min', 21, 'found_age_max', 32,   -- spread EVENLY across this
    'retire_age', 35, 'retire_fade_age', 33, 'retire_fade_under', 55);
$$;

commit;

begin;

-- ── TWO: the rank pays Coach Points ──────────────────────────────────────

-- WHAT A RANK IS WORTH IN COACH POINTS: twenty, and two more for every rank
-- already held. Rank 10 pays 38, rank 45 pays 108; the forty-five ranks a
-- sixty-season franchise earns pay about three thousand, against the six
-- hundred that sixty seasons of winning paid before. That is the difference
-- between one coach at level 99 and a building with four people in it.
create or replace function public.franchise_rank_coach_points(p_rank integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (public.franchise_staff()->>'rank_cp_base')::int
       + (public.franchise_staff()->>'rank_cp_step')::int * greatest(0, coalesce(p_rank, 1) - 1);
$$;

-- ── THREE: what a franchise's reputation is worth to a new coach ─────────

-- A club that has been at it for years and wins attracts somebody who has
-- done the job before. Half a level for every rank, and one for every ten
-- points of standing — a new franchise hires at level 1 and a sixty-season
-- contender at about thirty. Capped, so reputation never hands over a coach
-- who would take a decade of Coach Points to build.
create or replace function public.franchise_staff_hire_level(p_rank integer, p_standing integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select greatest(1, least((public.franchise_staff()->>'hire_level_max')::int,
    1 + floor(greatest(0, coalesce(p_rank, 1) - 1) * (public.franchise_staff()->>'hire_per_rank')::numeric)::int
      + floor(greatest(0, coalesce(p_standing, 0)) / (public.franchise_staff()->>'hire_per_standing')::numeric)::int));
$$;

commit;

-- ===========================================================================
-- THE DRIVES YOU CALL — Phase 13, snap_v1
--
-- RETRO BOWL, BUT LEAGUES. Everything under this game is deeper than the
-- game it is named after — a roster, a draft, a market, trades, a staff, a
-- development programme, a league of twenty-four clubs and a league of your
-- friends. What it did not have is the part your hands do. Game Day was one
-- button, and the page said so in as many words: "Simulated on the server
-- from your roster, your scheme, the opponent and this week's preparation."
-- You never played a down.
--
-- So the weekly game becomes a game you play. Not sixty snaps — a dozen
-- decisions, one a possession, two or three minutes with a thumb:
--
--     WEEK 6 · 2nd quarter · you 10, Bayou 7 · your ball
--     They have been stopping the run.
--       [ Ground ]  [ Balanced ]  [ Air it out ]  [ Take a shot ]
--
-- THE SERVER STILL DECIDES EVERYTHING. A call is a DECISION, not a result:
-- the client sends "air", never "touchdown". The drive is resolved from the
-- game's own seed, your roster, the opponent and the call, exactly as it was
-- before — the call is one more input beside home field, preparation and the
-- scheme matchup. Nothing here lets a client hand itself a score, and the
-- report row proves it.
--
-- HOW IT STAYS ONE SIMULATOR. The calls are stored on the game and
-- franchise_sim() reads them. Because the simulator is seeded and resolves
-- drives in order, a drive's outcome depends only on the seed and the calls
-- BEFORE it — so re-running after each call reproduces every drive already
-- played and adds the new one. There is no second simulator, no half-played
-- game to store, and no way for a replayed request to change a drive that
-- has already happened. The last call finalises through franchise_play_game
-- itself, so the box, the rewards, the standing and the achievements are the
-- ones every other game has always produced.
--
-- QUICK PLAY STAYS. franchise_play_week() still plays the whole game at
-- once, and a game played that way is a game called Balanced the whole way
-- through. Nobody is made to tap twelve times to see a result.
--
--   THE FOUR CALLS:
--
--     GROUND      leans on the backs and the line. Fewer turnovers, fewer
--                 touchdowns, and it takes the air out of the ball.
--     BALANCED    the scheme's own shape. What quick play calls.
--     AIR         leans on the quarterback and the receivers. More
--                 touchdowns and more of the other thing.
--     SHOT        everything at once: the best chance of seven and the best
--                 chance of handing it back.
--
-- WHAT THE FIRST CUT OF THAT TABLE GOT WRONG, and how it was found. Eight
-- thousand measured drives at an even matchup said Take a shot scored 2.32
-- points a drive against Balanced's 1.78 and gave up NOTHING for it — because
-- a turnover ended a drive exactly the way a punt did, at nothing. A button
-- with a right answer is not a decision, which is the thing this phase exists
-- to get rid of. Two changes fixed it:
--
--   ONE — A GIVEAWAY HANDS THE OTHER SIDE THE BALL IN SCORING RANGE. That is
--   what makes a turnover cost anything at all, and it is a rule of football
--   rather than a rule of calling, so it applies to quick play and to
--   franchise-vs-franchise challenges too. The simulator is therefore SIM_V2;
--   boxes already stored still say sim_v1 and stay true to the rules they
--   were played under.
--
--   TWO — WHICH CALL IS YOURS IS A FACT ABOUT YOUR ROSTER. The simulator
--   computes a LEAN: how much better this team throws it than runs it, in
--   rating points, off the same position groups franchise_team_rating()
--   already publishes. A call cashes that lean in proportion to how far it
--   leans on the pass.
--
-- Measured again, two thousand whole games a cell, evenly matched sides,
-- every possession called the same way (average margin, in points):
--
--   roster                   ground  balanced   air    shot
--   runs it better (-8)       +0.28    +0.07   -1.30  -1.26
--   balanced        (0)       -0.58    +0.19   -0.41  -0.15
--   throws it better (+8)     -0.93    -0.29   +0.64  +0.74
--
-- Read down a column and it flips. On a balanced roster all four sit inside a
-- point of each other: no button has a right answer. And they swing a game by
-- different amounts — Ground +/-14.6, Shot +/-16.6 — which is the other half
-- of the decision: grind with a lead, shoot from behind.
-- ===========================================================================

begin;

-- what a franchise called, drive by drive. Null until the first call; a
-- game played through quick play never has one.
alter table public.franchise_games add column if not exists calls jsonb;

-- THE TABLE. The four calls and what each does, in one place a page can
-- render without a round trip, and the same numbers the simulator applies.
create or replace function public.franchise_snaps()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'snap_v1',
    'default', 'balanced',
    'calls', jsonb_build_array(
      jsonb_build_object('key', 'ground', 'name', 'Ground',
        'means', 'Lean on the backs and the line. Safer, slower, fewer scores.',
        'pass', -0.22, 'td', -0.025, 'turnover', -0.075, 'edge', 0.0),
      jsonb_build_object('key', 'balanced', 'name', 'Balanced',
        'means', 'Your scheme''s own shape. What quick play calls.',
        'pass', 0.0, 'td', 0.0, 'turnover', 0.0, 'edge', 0.0),
      jsonb_build_object('key', 'air', 'name', 'Air it out',
        'means', 'Lean on the quarterback and the receivers. More scores, more risk.',
        'pass', 0.20, 'td', 0.030, 'turnover', 0.095, 'edge', 0.0),
      jsonb_build_object('key', 'shot', 'name', 'Take a shot',
        'means', 'Everything at once: the best chance of seven, and of handing it back.',
        'pass', 0.28, 'td', 0.060, 'turnover', 0.190, 'edge', 0.0)));
$$;

-- one call, by key, defaulting to the scheme's own shape
create or replace function public.franchise_snap_call(p_key text)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(
    (select c from jsonb_array_elements(public.franchise_snaps()->'calls') c
      where c->>'key' = coalesce(p_key, '')),
    (select c from jsonb_array_elements(public.franchise_snaps()->'calls') c
      where c->>'key' = public.franchise_snaps()->>'default'));
$$;

commit;

begin;

-- HOW MANY POSSESSIONS YOU GET. Asked of the simulator itself rather than
-- guessed at: it is seeded, so the answer is the same every time it is
-- asked of the same game with the same calls, and the page can say "twelve
-- drives" before a single one is called. It can still GROW mid-game, because
-- a game your calls drag into overtime has more possessions in it than the
-- one you started; the caller re-reads it after every call.
create or replace function public.franchise_game_drives(p_franchise uuid, p_game uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if not exists (select 1 from public.franchise_games
                  where id = p_game and franchise_id = p_franchise) then return 0; end if;
  select count(*) into n from jsonb_array_elements(public.franchise_sim(p_franchise, p_game)->'drives') x
   where x->>'side' = 'me';
  return coalesce(n, 0);
end;
$$;

-- OPEN THE GAME. Nothing is resolved: this says what you are about to call
-- and what the four calls do. The window and the state are the same ones
-- quick play checks, so a game that cannot be played cannot be called either.
create or replace function public.franchise_game_open(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype;
  s public.franchise_seasons%rowtype; g public.franchise_games%rowtype; v_box jsonb; v_called integer;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found or s.status not in ('active', 'playoffs') then
    raise exception 'the season is not under way' using errcode = '55000';
  end if;
  select * into g from public.franchise_games
   where franchise_id = v_f and season_number = s.number and status = 'scheduled' order by week limit 1;
  if not found then raise exception 'no game is scheduled' using errcode = 'P0002'; end if;
  if g.opens_at > now() then
    raise exception 'week % opens on %', g.week, to_char(g.opens_at, 'Dy DD Mon HH24:MI "UTC"') using errcode = '55000';
  end if;
  -- A first look at the game — the calls already made and no others, so a
  -- game reopened part-way through says exactly where it stands. Nothing is
  -- written: the simulator returns the box, it never stores one.
  --
  -- SINCE PHASE 15 YOU CALL BOTH SIDES, so a possession is a possession
  -- whoever has the ball, and the number of them is whatever the clock left
  -- room for rather than a figure drawn before kickoff.
  v_box := public.franchise_sim(v_f, g.id);
  v_called := jsonb_array_length(coalesce(g.calls, '[]'::jsonb));
  return jsonb_build_object('ok', true,
    'game', public.franchise_game_json(g.id, false),
    'rules', public.franchise_snaps(),
    'fronts', public.franchise_fronts(),
    'playbook', public.franchise_playbook(f.offense),
    'clock', public.franchise_clock(),
    'possessions', jsonb_array_length(v_box->'drives'),
    'drives', (select count(*) from jsonb_array_elements(v_box->'drives') x where x->>'side' = 'me'),
    'called', v_called,
    -- whose ball is next, so the page knows which table to show you
    'next', case when v_called < jsonb_array_length(v_box->'drives') then jsonb_build_object(
              'n', v_called + 1, 'of', jsonb_array_length(v_box->'drives'),
              'side', case when (v_box->'drives'->v_called->>'mine')::boolean then 'off' else 'def' end) end,
    -- every possession already played, in the order it happened. A drive is
    -- numbered by MY possession, so the opponent's opening drive — the one
    -- before your first call, when they receive — is n = 0 and belongs here
    -- from the start.
    'played', coalesce((select jsonb_agg(x order by ord)
                          from jsonb_array_elements(v_box->'drives') with ordinality t(x, ord)
                         where (x->>'n')::int <= jsonb_array_length(coalesce(g.calls, '[]'::jsonb))),
                       '[]'::jsonb),
    'edges', v_box->'edges');
end;
$$;

-- CALL A DRIVE. The client sends a CALL — "air" — and never a result. The
-- drive is resolved on the server from the game's seed, the roster, the
-- opponent and the call, and the simulator is re-run over every call made so
-- far: because it is seeded and resolves drives in order, every drive already
-- played comes back identical and the new one is added. A replayed request
-- cannot change a drive that has already happened.
--
-- The last call finalises through franchise_play_game itself, so the box, the
-- rewards, the standing and the achievements are the ones every other game
-- has always produced.
create or replace function public.franchise_game_call(p_call text, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); s public.franchise_seasons%rowtype; g public.franchise_games%rowtype;
  v_calls jsonb; v_box jsonb; v_mine integer; v_n integer; v_drive jsonb; v_last jsonb;
  v_side text; v_want text; f public.franchises%rowtype;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f;
  -- A call names its own side of the ball, and the two tables never share a
  -- key, so one meant for the other can be refused rather than quietly
  -- treated as a default.
  v_side := public.franchise_call_side(p_call);
  if v_side is null then
    raise exception 'no such call: %', p_call using errcode = '22023';
  end if;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found or s.status not in ('active', 'playoffs') then
    raise exception 'the season is not under way' using errcode = '55000';
  end if;
  select * into g from public.franchise_games
   where franchise_id = v_f and season_number = s.number and status = 'scheduled' order by week limit 1
   for update;
  if not found then raise exception 'no game is scheduled' using errcode = 'P0002'; end if;
  if g.opens_at > now() then
    raise exception 'week % opens on %', g.week, to_char(g.opens_at, 'Dy DD Mon HH24:MI "UTC"') using errcode = '55000';
  end if;

  -- WHOSE POSSESSION IS THIS. Asked of the simulator, which is the only thing
  -- that knows: who received is drawn from the game's own seed, and the
  -- number of possessions is whatever the clock left room for.
  v_box := public.franchise_sim(v_f, g.id);
  v_n := jsonb_array_length(v_box->'drives');
  v_mine := jsonb_array_length(coalesce(g.calls, '[]'::jsonb));
  if v_mine >= v_n then
    raise exception 'every possession has been called' using errcode = '55000';
  end if;
  -- A PLAY HAS TO BE IN YOUR OWN BOOK. An Air Raid has no I-Formation, so it
  -- has no flea flicker, and asking for one is refused rather than run.
  if public.franchise_play(p_call)->>'key' = p_call
     and not public.franchise_play_allowed(f.offense, p_call) then
    raise exception '% is not in your playbook', p_call using errcode = '22023';
  end if;
  v_want := case when (v_box->'drives'->v_mine->>'mine')::boolean then 'off' else 'def' end;
  if v_side <> v_want then
    raise exception '% is not a call for %', p_call,
      case when v_want = 'off' then 'your own possession' else 'defending theirs' end
      using errcode = '22023';
  end if;

  v_calls := coalesce(g.calls, '[]'::jsonb) || to_jsonb(p_call);
  update public.franchise_games set calls = v_calls where id = g.id;
  select * into g from public.franchise_games where id = g.id;

  v_box := public.franchise_sim(v_f, g.id);
  v_n := jsonb_array_length(v_box->'drives');
  v_mine := jsonb_array_length(v_calls);
  -- What this possession did. One entry per possession now, in the order they
  -- happened, so this is simply the one just called.
  select jsonb_agg(x order by ord), (array_agg(x order by ord))[count(*)::int]
    into v_drive, v_last
    from (select x, ord from jsonb_array_elements(v_box->'drives') with ordinality t(x, ord)
           where ord = v_mine) q;

  if v_mine >= v_n then
    -- the last possession: the game is played, once, through the same door
    -- every other game goes through
    return public.franchise_play_game(v_f, now()) || jsonb_build_object('called', v_mine, 'complete', true);
  end if;

  return jsonb_build_object('ok', true, 'complete', false,
    'called', v_mine, 'drives', v_n, 'possessions', v_n,
    'drive', v_drive,
    'score', jsonb_build_object('me', coalesce((v_last->>'me')::int, 0), 'op', coalesce((v_last->>'op')::int, 0)),
    'clock', coalesce((v_last->>'clock')::int, 0),
    'next', jsonb_build_object('n', v_mine + 1, 'of', v_n,
      'side', case when (v_box->'drives'->v_mine->>'mine')::boolean then 'off' else 'def' end),
    'rules', public.franchise_snaps(), 'fronts', public.franchise_fronts(),
    'playbook', public.franchise_playbook(f.offense));
end;
$$;

commit;

-- ===========================================================================
-- KEY MOMENTS — Phase 14, moment_v1
--
-- MEASURED FIRST, on the game as Phase 13 left it. Four hundred real games,
-- and then fifteen hundred more between two IDENTICAL sides so that nothing
-- here could be blamed on one team simply being better:
--
--   possession        1     4     8    10    12
--   still live       100%   67%   51%   46%   44%      (within one score)
--   average gap      2.9   7.0   9.9  11.1  12.3
--
-- By the last possession only FORTY-FOUR PER CENT of games are within a
-- score, and the leader has stopped changing about two fifths of the way in.
-- You call twelve possessions and more than half the late ones are taps on a
-- game already over.
--
-- THE FIRST THING I TRIED WAS THE WRONG FIX. I gave the trailing side
-- urgency late — push when behind, grind when ahead, mapped onto the snap_v1
-- calls the game already has — and measured it: the average margin went from
-- 12.3 to 11.9 and the share of live finishes from 43.9% to 44.1%. Nothing.
-- Pushing raises scoring AND giveaways; it buys variance, not points, so it
-- widens the distribution without closing the gap.
--
-- And it should not close the gap, because THE FOOTBALL IS NOT BROKEN. Real
-- games average about eleven or twelve points of margin too. Blowouts are
-- what football does. Building a rubber band to hide that would have made the
-- simulator worse to chase drama — the same mistake Phase 10 found in the
-- league and tore out.
--
-- So the fault is not the football. It is that THE GAME DOES NOT KNOW WHICH
-- POSSESSIONS MATTERED. Every one of the twelve is presented identically,
-- none is ever marked, none is ever remembered, and you are made to tap
-- through the dead ones. Four things follow, and not one of them touches how
-- a drive resolves — the simulator stays sim_v2 and a seeded game plays out
-- exactly as it did before:
--
--   STAKE. Every possession gets a number in [0, 1]: how much this one could
--   swing the game, from the score and the possessions left. Tied with two to
--   go is 1. Down four scores with one to go is 0. It is published, it is
--   pure, and the client computes the same number from the same table.
--
--   A KEY MOMENT is a possession at or above the threshold. The page marks
--   it, and the call you make there is the one that decides the game — which
--   was always true and was never once said out loud.
--
--   THE STORY. Every box now carries what happened to the lead: how often it
--   changed hands, the drive that took it for good, the biggest moment in the
--   game, and the possession after which it was over.
--
--   PLAY IT OUT. When the stake is gone, one tap finishes the game rather
--   than eleven. It runs through franchise_play_game like everything else.
--
-- AND THE FRANCHISE KEEPS THEM. Sixty seasons of football and nothing stood
-- out from anything else. The reel is DERIVED from the boxes already stored,
-- so there is no new table, no new policy, and nothing to keep in step: the
-- moments a franchise remembers are the ones it actually played.
-- ===========================================================================

begin;

-- THE RULES, in one place a page can render and a test can pin.
create or replace function public.franchise_moments()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'moment_v1',
    'key_stake', 0.50,      -- at or above this, the possession is a key moment
    'one_score', 8,         -- a touchdown and the kick
    'close', 3,             -- inside a field goal is as close as close gets
    'late', 4,              -- "late" begins with this many possessions left
    'dead', 21);            -- three scores back with the clock gone is nothing
$$;

-- WHAT IS AT STAKE ON ONE POSSESSION, in [0, 1]. Two halves, each obviously
-- right on its own, multiplied together:
--
--   LATENESS  — nothing is at stake in the first quarter of a tied game,
--               because there is a whole game left to put it right.
--   CLOSENESS — nothing is at stake three scores down, because there is not.
--
-- p_gap is the score difference (either sign; a possession is worth the same
-- to the side defending a lead as to the side chasing it) and p_left is how
-- many possessions this side has left, including this one.
create or replace function public.franchise_stake(p_gap integer, p_left integer)
returns numeric language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_left, 0) <= 0 then 0::numeric else
    round(
      -- lateness: 0 with five or more to play, 1 on the last possession
      greatest(0, least(1,
        ((public.franchise_moments()->>'late')::numeric + 1 - least((public.franchise_moments()->>'late')::numeric + 1, p_left))
        / (public.franchise_moments()->>'late')::numeric))
      *
      -- closeness: 1 inside a field goal, 0 at three scores and beyond
      greatest(0, least(1,
        1 - greatest(0, abs(coalesce(p_gap, 0)) - (public.franchise_moments()->>'close')::numeric)
            / ((public.franchise_moments()->>'dead')::numeric - (public.franchise_moments()->>'close')::numeric)))
    , 3) end;
$$;

-- a possession at or above the threshold is one of the ones that decided it
create or replace function public.franchise_is_key(p_stake numeric)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_stake, 0) >= (public.franchise_moments()->>'key_stake')::numeric;
$$;

commit;

begin;

-- WHAT HAPPENED TO THE LEAD. Derived from the drive log the box already
-- carries, so it costs no randomness and cannot disagree with the game: how
-- often the lead changed hands, the drive that took it for the last time, the
-- biggest moment played, and the possession after which it was over.
create or replace function public.franchise_game_story(p_drives jsonb)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  with d as (
    select x, ord,
           (x->>'me')::int as me, (x->>'op')::int as op,
           sign((x->>'me')::int - (x->>'op')::int) as lead
      from jsonb_array_elements(coalesce(p_drives, '[]'::jsonb)) with ordinality t(x, ord)),
  fin as (select coalesce((select lead from d order by ord desc limit 1), 0) as final,
                 coalesce((select max(ord) from d), 0) as last_ord),
  led as (select ord, lead, lag(lead) over (order by ord) as was from d where lead <> 0),
  chg as (select count(*) as changes from led where was is not null and lead <> was)
  select jsonb_build_object(
    'lead_changes', coalesce((select changes from chg), 0),
    -- the last possession after which the eventual leader was ever behind:
    -- everything after it was a game already decided
    'decided_at', coalesce((select max(ord) from d, fin
                             where fin.final <> 0 and d.lead <> fin.final), 0),
    'possessions', (select last_ord from fin),
    -- the drive that took the lead for the last time and kept it
    'go_ahead', (select x from d, fin
                  where fin.final <> 0 and d.lead = fin.final and (x->>'pts')::int > 0
                    and d.ord > coalesce((select max(d2.ord) from d d2 where d2.lead <> fin.final), 0) - 1
                  order by d.ord limit 1),
    -- the biggest thing that happened: the highest-stake possession that scored
    'biggest', (select x from d where (x->>'pts')::int > 0
                 order by coalesce((x->>'stake')::numeric, 0) desc, (x->>'pts')::int desc, ord desc limit 1),
    -- how many DECISIONS mattered: both drives in a possession share the
    -- stake, so counting them both would double every moment
    'key', coalesce((select count(*) from d where (x->>'key')::boolean and x->>'side' = 'me'), 0),
    'key_drives', coalesce((select jsonb_agg(x order by ord) from d
                             where (x->>'key')::boolean and x->>'side' = 'me'), '[]'::jsonb));
$$;

commit;

begin;

-- PLAY IT OUT. Half the late possessions in a measured game are taps on a
-- game already over, so when the stake is gone this finishes it in one. It is
-- not a shortcut past the football: every remaining possession is called
-- BALANCED and resolved by the same simulator, which is exactly what quick
-- play has always been. The game ends through franchise_play_game like every
-- other game, so the box, the rewards and the standing are the usual ones.
create or replace function public.franchise_game_finish(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); s public.franchise_seasons%rowtype; g public.franchise_games%rowtype;
  v_box jsonb; v_n integer; v_mine integer; v_guard integer := 0;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found or s.status not in ('active', 'playoffs') then
    raise exception 'the season is not under way' using errcode = '55000';
  end if;
  select * into g from public.franchise_games
   where franchise_id = v_f and season_number = s.number and status = 'scheduled' order by week limit 1
   for update;
  if not found then raise exception 'no game is scheduled' using errcode = 'P0002'; end if;
  if g.opens_at > now() then
    raise exception 'week % opens on %', g.week, to_char(g.opens_at, 'Dy DD Mon HH24:MI "UTC"') using errcode = '55000';
  end if;

  -- fill every possession still to come. Re-simmed each time because a game
  -- your calls drag into overtime has more possessions in it than the one you
  -- started; the guard is there so a pathological seed cannot spin.
  loop
    v_guard := v_guard + 1;
    exit when v_guard > 60;
    v_box := public.franchise_sim(v_f, g.id);
    v_n := jsonb_array_length(v_box->'drives');
    v_mine := jsonb_array_length(coalesce(g.calls, '[]'::jsonb));
    exit when v_mine >= v_n;
    -- the published default for whichever side of the ball this one is on
    update public.franchise_games
       set calls = coalesce(calls, '[]'::jsonb) || to_jsonb(
             case when (v_box->'drives'->v_mine->>'mine')::boolean
                  then public.franchise_snaps()->>'default'
                  else public.franchise_fronts()->>'default' end)
     where id = g.id;
    select * into g from public.franchise_games where id = g.id;
  end loop;

  return public.franchise_play_game(v_f, now())
      || jsonb_build_object('called', jsonb_array_length(coalesce(g.calls, '[]'::jsonb)),
                            'complete', true, 'played_out', true);
end;
$$;

commit;

begin;

-- THE REEL. Sixty seasons of football and nothing stood out from anything
-- else. These are the possessions that decided games, DERIVED from the boxes
-- already stored rather than kept in a table of their own — so there is no new
-- policy, nothing to keep in step, and the moments a franchise remembers are
-- exactly the ones it actually played. Read of one's own franchise only.
create or replace function public.franchise_reel(p_secret text default null, p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; v_n integer;
begin
  if v_f is null then raise exception 'create a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f;
  v_n := greatest(1, least(100, coalesce(p_limit, 20)));
  return jsonb_build_object(
    'ok', true, 'version', public.franchise_moments()->>'version',
    'rules', public.franchise_moments(),
    'played', (select count(*) from public.franchise_games
                where franchise_id = v_f and status = 'final'),
    'with_a_moment', (select count(*) from public.franchise_games
                       where franchise_id = v_f and status = 'final'
                         and coalesce((box->'story'->>'key')::int, 0) > 0),
    'moments', coalesce((
      select jsonb_agg(m order by (m->>'stake')::numeric desc, (m->>'season')::int desc, (m->>'week')::int desc)
        from (
          select jsonb_build_object(
                   'season', g.season_number, 'week', g.week, 'bowl', g.bowl,
                   'opponent', g.opponent->>'name', 'opponent_abbr', g.opponent->>'abbr',
                   'result', g.result, 'for', (g.box->'final'->>'for')::int,
                   'against', (g.box->'final'->>'against')::int,
                   'stake', (x->>'stake')::numeric, 'call', x->>'call',
                   'outcome', x->>'outcome', 'pts', (x->>'pts')::int,
                   'yds', (x->>'yds')::int, 'q', (x->>'q')::int,
                   'me', (x->>'me')::int, 'op', (x->>'op')::int) as m
            from public.franchise_games g,
                 jsonb_array_elements(g.box->'story'->'key_drives') x
           where g.franchise_id = v_f and g.status = 'final'
           order by (x->>'stake')::numeric desc, g.season_number desc, g.week desc
           limit v_n) q), '[]'::jsonb));
end;
$$;

commit;

-- ===========================================================================
-- BOTH SIDES OF THE BALL — Phase 15, clock_v1 and defense_v1
--
-- MEASURED FIRST, on the game as Phase 14 left it. Six hundred games, the
-- same seeds, every possession called the same way:
--
--   called every possession   ground   balanced   air    shot
--   possessions a side         10.95    10.95    10.95   10.95
--   spread                      0.83     0.83     0.83    0.83
--
-- IDENTICAL TO TWO DECIMAL PLACES. Possessions were drawn once, before a
-- snap, from two scheme labels and a dice roll, and nothing that happened in
-- the game ever touched them. Grind it out for sixty minutes and you got the
-- same number of possessions as a team that threw on every down. That is not
-- football; it is a turn counter wearing football's clothes.
--
-- And you only ever played half the game. Eleven possessions a side means
-- eleven possessions where the other team had the ball and you watched.
--
-- So two things, and they are the same thing:
--
--   THE CLOCK (clock_v1). There is no set number of plays any more. There is
--   a game clock, and possessions are what is left over when it runs out. A
--   drive takes time in proportion to the plays in it and HOW those plays are
--   run: the ball on the ground keeps the clock moving, the ball in the air
--   stops it. Grind and there are fewer possessions in the game for both of
--   you. Throw and there are more.
--
--   Clock management lives here too — a trailing side hurries, a leading side
--   bleeds it against the other team's timeouts — and I should say plainly
--   what that DOES NOT do, because I wrote the opposite in this comment
--   before I measured it.
--
--   I claimed the clock would manufacture comebacks where Phase 14's variance
--   experiment could not. It does not. Trailing with five minutes left, a
--   side gets 2.93 possessions after that mark; leading, 2.95. Sweeping the
--   leading side's tempo from 1.30 down to 0.70 moved the comeback rate 13.4,
--   17.9, 15.7, 13.8 per cent — non-monotonic, and all of it inside the noise
--   on a hundred-odd games a cell.
--
--   And the reason is structural rather than a tuning problem: POSSESSIONS
--   STRICTLY ALTERNATE, so every second you save by hurrying hands the ball
--   back sooner and buys the other side a possession too. Real football gets
--   around that with timeouts, incompletions and onside kicks — a trailing
--   team stopping the clock while it is NOT holding the ball — and none of
--   that exists here.
--
--   So this is the second measurement in two phases to say the same thing:
--   the football is fine, and drama is not a thing to manufacture. Tempo
--   stays because it is true — a game late and close does run at a different
--   speed — and it is described here as what it is rather than as a comeback
--   engine.
--
--   DEFENSE (defense_v1). You call the other side's possessions too. Four
--   fronts, and which one is right depends on what they are about to run —
--   so the read is the game. Stack the box and a passing team goes over your
--   head. Sit deep and a running team walks it down the field. Blitz and it
--   is a coin with two very different faces.
--
--   The opponent is not a dice roll to be guessed at blindly: franchise_ai_call
--   picks their play from THEIR SCHEME and THE SITUATION, so a power-run team
--   protecting a lead will run at you, and the same team down ten with two
--   minutes left has to throw. That is the read, and it is readable.
--
-- ONE SIMULATOR STILL. The calls array is now one entry per POSSESSION in the
-- order they happen — your offensive call when you have the ball, your
-- defensive call when they do — and franchise_sim() reads it exactly as it
-- did before. Re-running still reproduces every possession already played.
-- The simulator is SIM_V3; boxes already stored keep their own version and
-- stay true to the rules they were played under.
-- ===========================================================================

begin;

-- THE CLOCK. Sixty minutes, and what a play costs from it. The ball on the
-- ground keeps the clock moving; the ball in the air stops it — which is the
-- whole reason a trailing team throws and a leading team does not.
create or replace function public.franchise_clock()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'clock_v1',
    'quarters', 4,
    'quarter_seconds', 900,          -- fifteen minutes a quarter
    'run_seconds', 38,               -- a running play, huddle and all
    'pass_seconds', 19,              -- the clock stops often enough to matter
    'score_seconds', 18,             -- the kickoff after a score
    'change_seconds', 12,            -- a punt or a turnover
    'nominal_drive', 175,            -- what a possession costs, near enough,
                                     -- for working out how many are left
    'hurry_from', 300,               -- the last five minutes of a half
    'hurry_tempo', 0.62,             -- trailing: no huddle
    'grind_tempo', 1.15,             -- leading: bleed it, against timeouts
    'ot_rounds', 2);
$$;

-- WHAT A DRIVE COST THE CLOCK. Plays, split by how they were run, plus what
-- happens at the end of a possession. Pure — it consumes no randomness, so
-- the clock cannot change a football outcome, only how many there are room for.
create or replace function public.franchise_drive_seconds(
  p_plays integer, p_pass_share numeric, p_outcome text, p_tempo numeric default 1)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select greatest(12, round(
      greatest(1, coalesce(p_plays, 1))
      * ( coalesce(p_pass_share, 0.5) * (public.franchise_clock()->>'pass_seconds')::numeric
        + (1 - coalesce(p_pass_share, 0.5)) * (public.franchise_clock()->>'run_seconds')::numeric )
      * greatest(0.4, least(2.0, coalesce(p_tempo, 1)))
    + case when p_outcome in ('td', 'fg') then (public.franchise_clock()->>'score_seconds')::numeric
           else (public.franchise_clock()->>'change_seconds')::numeric end
  ))::int;
$$;

-- HOW A SIDE PLAYS THE CLOCK. Only late, and only when there is a lead to
-- protect or chase. This is what makes a comeback possible: the trailing side
-- buys possessions, which is the thing variance could never do.
create or replace function public.franchise_tempo(p_gap integer, p_seconds_left integer)
returns numeric language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when coalesce(p_seconds_left, 0) > (public.franchise_clock()->>'hurry_from')::int then 1::numeric
    when coalesce(p_gap, 0) < 0 then (public.franchise_clock()->>'hurry_tempo')::numeric
    when coalesce(p_gap, 0) > 0 then (public.franchise_clock()->>'grind_tempo')::numeric
    else 1::numeric end;
$$;

commit;

begin;

-- THE FOUR FRONTS (defense_v1). Which one is right depends entirely on what
-- they are about to run, and that read is the whole game.
--
-- THE FIRST CUT OF THIS TABLE MOVED RATING POINTS, and measuring it showed
-- why that was hopeless: a defensive call worth three rating points moves the
-- touchdown odds by 0.015, which is five hundredths of a point a drive. Stack
-- the box against a running team came out at 1.625 points allowed against
-- Base's 1.584 — the wrong way round, and both inside the noise. A defensive
-- call has to pull the same lever an offensive one does.
--
-- So a front moves the TOUCHDOWN and TURNOVER odds directly, exactly as
-- snap_v1 does, and each number is split by whether the ball is on the ground
-- or in the air: eff = vs_pass * pass_share + vs_run * (1 - pass_share),
-- where pass_share is the offense's own, THEIR call already in it. Guess
-- right and you take it away; guess wrong and you are the reason they scored.
create or replace function public.franchise_fronts()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'defense_v1',
    'default', 'base',
    'calls', jsonb_build_array(
      jsonb_build_object('key', 'stack', 'name', 'Stack the box',
        'means', 'Crowd the line. Murder on the run — and they can go over the top of it.',
        'td_vs_run', -0.060, 'td_vs_pass', 0.050,
        'to_vs_run', 0.035, 'to_vs_pass', -0.020),
      jsonb_build_object('key', 'base', 'name', 'Base',
        'means', 'Play it honest. What quick play calls.',
        'td_vs_run', 0.0, 'td_vs_pass', 0.0,
        'to_vs_run', 0.0, 'to_vs_pass', 0.0),
      jsonb_build_object('key', 'cover', 'name', 'Cover deep',
        'means', 'Take the pass away. They can run it down your throat instead.',
        'td_vs_run', 0.050, 'td_vs_pass', -0.060,
        'to_vs_run', -0.020, 'to_vs_pass', 0.035),
      jsonb_build_object('key', 'blitz', 'name', 'Blitz',
        'means', 'Send them. The best chance of taking it away, and of being taken apart.',
        'td_vs_run', 0.030, 'td_vs_pass', 0.040,
        'to_vs_run', 0.080, 'to_vs_pass', 0.095)));
$$;

create or replace function public.franchise_front_call(p_key text)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(
    (select c from jsonb_array_elements(public.franchise_fronts()->'calls') c
      where c->>'key' = coalesce(p_key, '')),
    (select c from jsonb_array_elements(public.franchise_fronts()->'calls') c
      where c->>'key' = public.franchise_fronts()->>'default'));
$$;

-- (franchise_call_side is defined once, below, where the playbook is: the
--  earlier immutable definition that lived here was dead on arrival — the
--  later one replaced it on every install.)

commit;

begin;

-- WHAT THE OTHER SIDE IS ABOUT TO RUN. Not a blind dice roll — their scheme
-- and their situation, so the read is a real read: a power-run team nursing a
-- lead will run at you, and the same team down ten with two minutes left has
-- to throw. Weighted rather than fixed, so it stays a read and never a
-- certainty.
create or replace function public.franchise_ai_call(p_scheme text, p_gap integer, p_left integer)
returns text language plpgsql set search_path = public, pg_temp as $$
declare w_ground numeric := 1; w_bal numeric := 2; w_air numeric := 1; w_shot numeric := 0.35;
        r numeric; tot numeric; gap integer := coalesce(p_gap, 0); lf integer := greatest(1, coalesce(p_left, 9));
begin
  -- the scheme they were built to run
  -- THE SCHEME HAS TO BITE, or every team looks the same and there is nothing
  -- to read. The first cut moved these by 1.4 and 1.6, which left a power-run
  -- team throwing on 47% of its plays against a pro-style team's 57% — ten
  -- points apart, and the measurement said so: Stack the box came out WORSE
  -- than Base against a running team, because the running team was barely
  -- running. These numbers put them 41% and 69% apart instead.
  if p_scheme in ('air_raid', 'spread') then
    w_air := w_air + 2.2; w_shot := w_shot + 0.7; w_bal := w_bal - 0.5; w_ground := w_ground - 0.7;
  elsif p_scheme in ('power_run', 'option') then
    w_ground := w_ground + 3.0; w_bal := w_bal - 0.8; w_air := w_air - 0.7; w_shot := w_shot - 0.25;
  end if;
  -- and the situation they are actually in
  if lf <= 3 then
    if gap < -8 then w_shot := w_shot + 2.2; w_air := w_air + 1.8; w_ground := 0.05;
    elsif gap < 0 then w_air := w_air + 1.2; w_shot := w_shot + 0.5; w_ground := greatest(0.1, w_ground - 0.6);
    elsif gap > 3 then w_ground := w_ground + 2.4; w_air := greatest(0.1, w_air - 0.7); w_shot := 0.05;
    end if;
  end if;
  w_ground := greatest(0.02, w_ground); w_bal := greatest(0.02, w_bal);
  w_air := greatest(0.02, w_air); w_shot := greatest(0.02, w_shot);
  tot := w_ground + w_bal + w_air + w_shot;
  r := random() * tot;
  if r < w_ground then return 'ground'; end if;
  r := r - w_ground;
  if r < w_bal then return 'balanced'; end if;
  r := r - w_bal;
  if r < w_air then return 'air'; end if;
  return 'shot';
end;
$$;

commit;

-- ===========================================================================
-- THE PLAYBOOK — Phase 16, playbook_v1
--
-- MEASURED FIRST, on the game as Phase 15 left it:
--
--   offensive options, any scheme     4
--   do they differ by scheme?         no — franchise_snaps() takes no argument
--   formations                        0
--   trick plays                       0
--
-- Four calls was the ENTIRE offensive vocabulary, and every franchise in the
-- game had the same four. Your scheme picked your pass share and nothing
-- else, so an Air Raid and a Power-Run team called from an identical menu.
--
-- And there was no such thing as a big play. Eight thousand drives: a
-- touchdown drive was 55 to 85 yards, every time, spread 9.0. Every score
-- looked exactly like every other score.
--
--   FORMATIONS. Five of them, and each one TELLS the defense something. The
--   I-Formation screams run; Empty screams pass. That tell is not flavour: the
--   other side reads it and calls their front off it (franchise_ai_front), so
--   lining up heavy really does get you a stacked box.
--
--   PLAYBOOKS. Which formations you carry depends on your scheme, so the menu
--   is genuinely different from team to team: an Air Raid has no I-Formation
--   and a Power-Run team has no Empty set. Twenty plays, and no franchise
--   holds all of them.
--
--   TRICK PLAYS, and this is where the formation earns its keep. A trick play
--   CONTRADICTS its own formation's tell — a flea flicker out of the
--   I-Formation, a quarterback draw out of Empty — so it pays off exactly when
--   the defense has bought the tell. Fool a stacked box with a flea flicker
--   and it is a touchdown; run it into a defense sitting deep and it is the
--   ball on the floor.
--
--   AND THEY GO STALE. Every time you call the same trick in a game it works
--   less well, because the payoff scales by how fresh it is. There is no
--   trick-play strategy, only a trick play.
--
-- HOW IT LAYERS. A play does not replace snap_v1, it SPECIALISES it: every
-- play names one of the four calls as its category and inherits that call's
-- numbers exactly as they were measured and tuned, then adds its own on top.
-- So nothing measured in Phase 13 is thrown away, and quick play is still a
-- game called Balanced.
--
-- The simulator is SIM_V4, because my own drives now face a real front rather
-- than nobody: the other side reads my formation and answers it.
-- ===========================================================================

begin;

-- THE FIVE FORMATIONS. `tell` is what lining up in it says to the defense:
-- -1 screams run, +1 screams pass. It is the whole reason a trick play works.
create or replace function public.franchise_formations()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'playbook_v1',
    'sets', jsonb_build_array(
      jsonb_build_object('key', 'i_form', 'name', 'I-Formation', 'tell', -0.75,
        'means', 'Two backs, tight ends, everybody close. It says run before the snap.'),
      jsonb_build_object('key', 'single', 'name', 'Singleback', 'tell', -0.25,
        'means', 'One back, balanced personnel. It says nothing much, which is its own virtue.'),
      jsonb_build_object('key', 'gun', 'name', 'Shotgun', 'tell', 0.45,
        'means', 'Quarterback off the line, receivers spread. It leans pass and keeps the run.'),
      jsonb_build_object('key', 'empty', 'name', 'Empty', 'tell', 0.90,
        'means', 'Five out, nobody in the backfield. Everyone in the stadium knows what this is.'),
      jsonb_build_object('key', 'wildcat', 'name', 'Wildcat', 'tell', -0.90,
        'means', 'The ball to a back directly. No quarterback on the field, and they can see that.')));
$$;

-- THE PLAYBOOK. Twenty plays. Every one names a snap_v1 CALL as its category
-- and inherits that call's numbers, then adds its own — so the four calls
-- measured in Phase 13 are still underneath all of this, and a play is a
-- specialisation rather than a replacement.
--
--   type      'run', 'pass' or 'trick'
--   td / to   this play's own edge, on top of its category's
--   explosive how much of a chunk play it is: raises the yards and cuts the
--             plays it took, which the clock then feels
create or replace function public.franchise_plays()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'playbook_v1',
    'default', 'inside_zone',
    'plays', jsonb_build_array(
      -- I-FORMATION: it says run, so the run is honest and the pass is a lie
      jsonb_build_object('key', 'iso', 'name', 'Iso', 'formation', 'i_form', 'type', 'run', 'call', 'ground',
        'td', 0.0, 'turnover', -0.010, 'explosive', 0.0,
        'means', 'Lead back through the hole. Nothing clever, nothing lost.'),
      jsonb_build_object('key', 'power_o', 'name', 'Power O', 'formation', 'i_form', 'type', 'run', 'call', 'ground',
        'td', 0.010, 'turnover', 0.0, 'explosive', 0.05,
        'means', 'Pull the guard and follow him. The short-yardage answer.'),
      jsonb_build_object('key', 'play_action', 'name', 'Play-action deep', 'formation', 'i_form', 'type', 'pass', 'call', 'air',
        'td', 0.030, 'turnover', 0.015, 'explosive', 0.30,
        'means', 'Sell the run from a run look, then throw over the top of it.'),
      jsonb_build_object('key', 'flea_flicker', 'name', 'Flea flicker', 'formation', 'i_form', 'type', 'trick', 'call', 'shot',
        'td', 0.110, 'turnover', 0.090, 'explosive', 0.55,
        'means', 'Hand it off, get it back, throw it deep. Ruin against a stacked box.'),
      -- SINGLEBACK: the formation that tells them nothing
      jsonb_build_object('key', 'inside_zone', 'name', 'Inside zone', 'formation', 'single', 'type', 'run', 'call', 'ground',
        'td', 0.0, 'turnover', 0.0, 'explosive', 0.05,
        'means', 'The play every team has. It works often enough and loses nothing.'),
      jsonb_build_object('key', 'curl_flat', 'name', 'Curl-flat', 'formation', 'single', 'type', 'pass', 'call', 'balanced',
        'td', 0.0, 'turnover', -0.015, 'explosive', 0.0,
        'means', 'Two receivers, high and low, and an easy read. Safe football.'),
      jsonb_build_object('key', 'hb_screen', 'name', 'Screen', 'formation', 'single', 'type', 'pass', 'call', 'balanced',
        'td', 0.015, 'turnover', 0.020, 'explosive', 0.25,
        'means', 'Let them come, then throw behind them. Murder on a blitz.'),
      jsonb_build_object('key', 'hb_pass', 'name', 'Halfback pass', 'formation', 'single', 'type', 'trick', 'call', 'shot',
        'td', 0.100, 'turnover', 0.100, 'explosive', 0.50,
        'means', 'Give it to the back and let him throw it. He is not a quarterback.'),
      -- SHOTGUN: leans pass, keeps the run
      jsonb_build_object('key', 'draw', 'name', 'Draw', 'formation', 'gun', 'type', 'run', 'call', 'balanced',
        'td', 0.010, 'turnover', -0.010, 'explosive', 0.20,
        'means', 'Wait for them to drop, then run through where they were.'),
      jsonb_build_object('key', 'mesh', 'name', 'Mesh', 'formation', 'gun', 'type', 'pass', 'call', 'air',
        'td', 0.0, 'turnover', -0.020, 'explosive', 0.05,
        'means', 'Crossers underneath. Somebody is always open, nobody is ever deep.'),
      jsonb_build_object('key', 'four_verts', 'name', 'Four verticals', 'formation', 'gun', 'type', 'pass', 'call', 'shot',
        'td', 0.015, 'turnover', 0.010, 'explosive', 0.40,
        'means', 'Everybody runs. Somebody wins, or nobody does.'),
      jsonb_build_object('key', 'qb_keep', 'name', 'Quarterback keep', 'formation', 'gun', 'type', 'run', 'call', 'ground',
        'td', 0.015, 'turnover', 0.010, 'explosive', 0.15,
        'means', 'He pulls it and goes. Worth what your quarterback is worth on his feet.'),
      jsonb_build_object('key', 'double_reverse', 'name', 'Double reverse', 'formation', 'gun', 'type', 'trick', 'call', 'ground',
        'td', 0.085, 'turnover', 0.110, 'explosive', 0.45,
        'means', 'Across, back across, and gone — if nobody stayed home.'),
      -- EMPTY: everyone in the stadium knows what this is
      jsonb_build_object('key', 'quick_slants', 'name', 'Quick slants', 'formation', 'empty', 'type', 'pass', 'call', 'air',
        'td', 0.010, 'turnover', -0.025, 'explosive', 0.10,
        'means', 'Out of his hands before anyone gets there. The blitz-beater.'),
      jsonb_build_object('key', 'smash', 'name', 'Smash', 'formation', 'empty', 'type', 'pass', 'call', 'air',
        'td', 0.020, 'turnover', 0.0, 'explosive', 0.20,
        'means', 'Corner and hitch against the same defender. Pick your half.'),
      jsonb_build_object('key', 'deep_shot', 'name', 'Deep shot', 'formation', 'empty', 'type', 'pass', 'call', 'shot',
        'td', 0.020, 'turnover', 0.020, 'explosive', 0.55,
        'means', 'One receiver, one defender, one throw.'),
      jsonb_build_object('key', 'qb_draw', 'name', 'Quarterback draw', 'formation', 'empty', 'type', 'trick', 'call', 'ground',
        'td', 0.090, 'turnover', 0.075, 'explosive', 0.35,
        'means', 'Five receivers out and he runs it himself. Nobody is left in the box.'),
      -- WILDCAT: no quarterback on the field, and they can see that
      jsonb_build_object('key', 'wildcat_power', 'name', 'Wildcat power', 'formation', 'wildcat', 'type', 'run', 'call', 'ground',
        'td', 0.020, 'turnover', 0.0, 'explosive', 0.10,
        'means', 'An extra blocker where the quarterback used to be.'),
      jsonb_build_object('key', 'jet_sweep', 'name', 'Jet sweep', 'formation', 'wildcat', 'type', 'run', 'call', 'ground',
        'td', 0.015, 'turnover', 0.015, 'explosive', 0.30,
        'means', 'Full speed to the edge. All of it or none of it.'),
      jsonb_build_object('key', 'wildcat_pass', 'name', 'Wildcat pass', 'formation', 'wildcat', 'type', 'trick', 'call', 'shot',
        'td', 0.120, 'turnover', 0.115, 'explosive', 0.60,
        'means', 'The back pulls up and throws. Against eight in the box it is a touchdown.')));
$$;

create or replace function public.franchise_play(p_key text)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(
    (select p from jsonb_array_elements(public.franchise_plays()->'plays') p
      where p->>'key' = coalesce(p_key, '')),
    (select p from jsonb_array_elements(public.franchise_plays()->'plays') p
      where p->>'key' = public.franchise_plays()->>'default'));
$$;

create or replace function public.franchise_formation(p_key text)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p from jsonb_array_elements(public.franchise_formations()->'sets') p
   where p->>'key' = coalesce(p_key, '');
$$;

commit;

begin;

-- WHICH FORMATIONS A SCHEME CARRIES. This is what makes a playbook a
-- playbook: an Air Raid has no I-Formation and a Power-Run team has no Empty
-- set, so the menu genuinely differs from franchise to franchise.
create or replace function public.franchise_playbook_sets(p_scheme text)
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case coalesce(p_scheme, 'pro_style')
    when 'power_run' then array['i_form', 'single', 'wildcat', 'gun']
    when 'option'    then array['i_form', 'single', 'wildcat', 'gun']
    when 'pro_style' then array['i_form', 'single', 'gun', 'empty']
    when 'spread'    then array['single', 'gun', 'empty', 'wildcat']
    when 'air_raid'  then array['gun', 'empty', 'single']
    else array['i_form', 'single', 'gun', 'empty'] end;
$$;

-- THE PLAYBOOK ONE FRANCHISE ACTUALLY HAS, grouped the way a page draws it.
create or replace function public.franchise_playbook(p_scheme text)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'version', public.franchise_plays()->>'version',
    'scheme', coalesce(p_scheme, 'pro_style'),
    'default', public.franchise_plays()->>'default',
    'formations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', fm->>'key', 'name', fm->>'name', 'tell', (fm->>'tell')::numeric,
               'means', fm->>'means',
               'plays', (select jsonb_agg(pl order by ord)
                           from jsonb_array_elements(public.franchise_plays()->'plays') with ordinality t(pl, ord)
                          where pl->>'formation' = fm->>'key'))
               order by ord)
        from jsonb_array_elements(public.franchise_formations()->'sets') with ordinality f(fm, ord)
       where fm->>'key' = any (public.franchise_playbook_sets(p_scheme))), '[]'::jsonb));
$$;

-- is this play in this franchise's book at all?
-- AND A PLAY IS AN OFFENSIVE CALL TOO. franchise_call_side() is defined in
-- Phase 15, above the playbook, so it is extended here rather than there:
-- a SQL function body is checked when it is created, and it cannot name a
-- table of plays that does not exist yet.
create or replace function public.franchise_call_side(p_key text)
returns text language sql stable set search_path = pg_catalog, pg_temp as $$
  select case
    when exists (select 1 from jsonb_array_elements(public.franchise_snaps()->'calls') c
                  where c->>'key' = coalesce(p_key, '')) then 'off'
    when exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') c
                  where c->>'key' = coalesce(p_key, '')) then 'off'
    when exists (select 1 from jsonb_array_elements(public.franchise_fronts()->'calls') c
                  where c->>'key' = coalesce(p_key, '')) then 'def'
    else null end;
$$;

create or replace function public.franchise_play_allowed(p_scheme text, p_key text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
                  where p->>'key' = coalesce(p_key, '')
                    and p->>'formation' = any (public.franchise_playbook_sets(p_scheme)));
$$;

commit;

begin;

-- THE DEFENSE READS YOUR FORMATION. This is what makes lining up a decision
-- rather than a costume: a heavy set really does get you a stacked box, which
-- is exactly why the trick play out of it works. Weighted, never certain.
create or replace function public.franchise_ai_front(p_tell numeric, p_gap integer, p_left integer)
returns text language plpgsql set search_path = public, pg_temp as $$
declare w_stack numeric := 1; w_base numeric := 1.6; w_cover numeric := 1; w_blitz numeric := 0.45;
        tell numeric := coalesce(p_tell, 0); r numeric; tot numeric;
begin
  -- what the formation told them
  if tell < 0 then w_stack := w_stack + 2.4 * (-tell); w_cover := greatest(0.1, w_cover + 1.2 * tell);
  else            w_cover := w_cover + 2.4 * tell;     w_stack := greatest(0.1, w_stack - 1.2 * tell);
  end if;
  -- and the situation: a defense needing the ball sends them
  if coalesce(p_left, 9) <= 3 and coalesce(p_gap, 0) > 0 then w_blitz := w_blitz + 1.6; end if;
  w_stack := greatest(0.02, w_stack); w_base := greatest(0.02, w_base);
  w_cover := greatest(0.02, w_cover); w_blitz := greatest(0.02, w_blitz);
  tot := w_stack + w_base + w_cover + w_blitz;
  r := random() * tot;
  if r < w_stack then return 'stack'; end if;
  r := r - w_stack;
  if r < w_base then return 'base'; end if;
  r := r - w_base;
  if r < w_cover then return 'cover'; end if;
  return 'blitz';
end;
$$;

commit;

-- ===========================================================================
-- GRANTS
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, so every
-- internal function is revoked explicitly. Clients reach the public functions
-- and nothing else; the trusted worker reaches the two service functions.
-- ===========================================================================

begin;

revoke all on function public.franchise_credit(uuid, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.franchise_award(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.franchise_generate_roster(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.franchise_apply_price_it(uuid, text, numeric, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_pos_avg(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.franchise_team_rating(uuid) from public, anon, authenticated;
revoke all on function public.franchise_totals(uuid) from public, anon, authenticated;
revoke all on function public.franchise_pick5_card(uuid) from public, anon, authenticated;
revoke all on function public.game_board_upsert(jsonb) from public, anon, authenticated;
revoke all on function public.franchise_settle_pick5() from public, anon, authenticated;
revoke all on function public.franchise_on_h2h_settled() from public, anon, authenticated;
-- the weekly game's internals: the scheduler, the simulator, the writer
revoke all on function public.franchise_prep(uuid, text) from public, anon, authenticated;
revoke all on function public.franchise_trait_effects(uuid) from public, anon, authenticated;
revoke all on function public.franchise_season_json(uuid, integer) from public, anon, authenticated;
revoke all on function public.franchise_game_json(uuid, boolean) from public, anon, authenticated;
revoke all on function public.franchise_schedule_season(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_open_season(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer) from public, anon, authenticated;
revoke all on function public.franchise_drive_totals(jsonb) from public, anon, authenticated;
revoke all on function public.franchise_nth(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.franchise_sim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.franchise_sim_lines(jsonb, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.franchise_play_game(uuid, timestamptz) from public, anon, authenticated;
-- franchise vs franchise internals
revoke all on function public.franchise_identity_json(uuid) from public, anon, authenticated;
revoke all on function public.franchise_ladder_rank(uuid) from public, anon, authenticated;
revoke all on function public.franchise_rivalry_bump(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.franchise_sim_score_play(jsonb, jsonb, jsonb, jsonb, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.franchise_sim_versus(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.franchise_challenge_json(uuid, uuid) from public, anon, authenticated;
-- the offseason and its rookie generator, and the pools they draw from
revoke all on function public.franchise_offseason(uuid, integer) from public, anon, authenticated;
revoke all on function public.franchise_generate_rookie(uuid, text, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.franchise_pool_first_names() from public, anon, authenticated;
revoke all on function public.franchise_pool_last_names() from public, anon, authenticated;
revoke all on function public.franchise_pool_plan() from public, anon, authenticated;
revoke all on function public.franchise_pool_archetypes() from public, anon, authenticated;
revoke all on function public.franchise_pool_traits() from public, anon, authenticated;
-- the draft and the market: the generator, the window opener and the
-- prospect reader are the server's; the board and the four moves are open
revoke all on function public.franchise_generate_player(uuid, text, integer, integer, text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.franchise_open_market(uuid, integer) from public, anon, authenticated;
revoke all on function public.franchise_free_number(uuid, text, text) from public, anon, authenticated;
revoke all on function public.franchise_prospect_json(public.game_players) from public, anon, authenticated;
-- the conference: the draw, the bracket, the final, the game writer, the
-- settlement and the read models are the server's; the eight a member calls
-- are opened below
revoke all on function public.franchise_conference_standings_json(uuid) from public, anon, authenticated;
revoke all on function public.franchise_conference_game_json(uuid, boolean) from public, anon, authenticated;
revoke all on function public.franchise_conference_json(uuid) from public, anon, authenticated;
revoke all on function public.franchise_conference_of(uuid) from public, anon, authenticated;
revoke all on function public.franchise_conference_playoff_teams(integer) from public, anon, authenticated;
revoke all on function public.franchise_conference_draw(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_conference_bracket(uuid) from public, anon, authenticated;
revoke all on function public.franchise_conference_final(uuid) from public, anon, authenticated;
revoke all on function public.franchise_conference_play_one(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_conference_settle(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_conference_run(uuid, timestamptz) from public, anon, authenticated;
-- Phase 7: the injury draw, the bowl scheduler and the trade internals are
-- the server's; the pages reach them through the functions granted below
revoke all on function public.franchise_draw_injuries(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_schedule_bowl(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.franchise_trade_json(uuid, uuid) from public, anon, authenticated;
revoke all on function public.franchise_trade_player_json(uuid) from public, anon, authenticated;
-- Phase 8: the coach generator, the effects aggregate and the seat readers are
-- the server's; the four moves and the published table are opened below
revoke all on function public.franchise_generate_coach(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.franchise_staff_effects(uuid) from public, anon, authenticated;
revoke all on function public.franchise_staff_json(uuid, text) from public, anon, authenticated;
revoke all on function public.franchise_staff_specialties(text, text, integer) from public, anon, authenticated;

grant execute on function public.franchise_economy() to anon, authenticated;
grant execute on function public.games_week_key(timestamptz) to anon, authenticated;
grant execute on function public.games_day_key(timestamptz) to anon, authenticated;
grant execute on function public.games_season_of(timestamptz) to anon, authenticated;
grant execute on function public.games_price_it_score(numeric) to anon, authenticated;
grant execute on function public.games_ats_result(numeric, integer, integer) to anon, authenticated;
grant execute on function public.games_xp_for_level(integer) to anon, authenticated;
grant execute on function public.games_level_for(integer) to anon, authenticated;
grant execute on function public.games_roman(integer) to anon, authenticated;
grant execute on function public.franchise_sp_for_score(integer) to anon, authenticated;
grant execute on function public.franchise_tc_for_score(integer) to anon, authenticated;
grant execute on function public.franchise_seed_float(text) to anon, authenticated;
grant execute on function public.franchise_clean(text, integer) to anon, authenticated;
grant execute on function public.games_jsonb_array(jsonb) to anon, authenticated;
grant execute on function public.franchise_is_mine(uuid) to anon, authenticated;

-- The player functions are open to anon AND authenticated, because a team
-- comes before an account: an anonymous caller is identified by the device
-- secret they present, exactly as in Head-to-Head, and a guessed secret
-- resolves to nothing. The two account-only functions — the account
-- resolver and the claim — are revoked from anon explicitly, because
-- Postgres grants EXECUTE to PUBLIC by default.
revoke all on function public.franchise_mine() from public, anon;
revoke all on function public.franchise_claim(text) from public, anon;
grant execute on function public.franchise_mine() to authenticated;
grant execute on function public.franchise_claim(text) to authenticated;

grant execute on function public.franchise_of(text) to anon, authenticated;
grant execute on function public.franchise_create(text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.franchise_record_price_it(text, numeric, text) to anon, authenticated;
grant execute on function public.franchise_submit_pick5(text, jsonb, text) to anon, authenticated;
grant execute on function public.franchise_record_drill(text, integer, integer, integer, text, text) to anon, authenticated;
grant execute on function public.franchise_record_research(text, text) to anon, authenticated;
grant execute on function public.franchise_import_history(jsonb, text) to anon, authenticated;
grant execute on function public.franchise_set_starter(uuid, integer, text) to anon, authenticated;
grant execute on function public.franchise_home(text) to anon, authenticated;
grant execute on function public.franchise_roster(text) to anon, authenticated;
grant execute on function public.franchise_ledger_recent(integer, text) to anon, authenticated;
grant execute on function public.franchise_pick5_mine(text, text) to anon, authenticated;
-- the weekly game: open to anon for the same reason founding is
grant execute on function public.franchise_scheme_edges() to anon, authenticated;
grant execute on function public.franchise_scheme_edge(text, text) to anon, authenticated;
grant execute on function public.franchise_pass_share(text) to anon, authenticated;
grant execute on function public.franchise_qb_rush_share(text) to anon, authenticated;
grant execute on function public.games_jsonb_sum(jsonb, jsonb) to anon, authenticated;
grant execute on function public.franchise_start_season(text) to anon, authenticated;
grant execute on function public.franchise_play_week(text) to anon, authenticated;
grant execute on function public.franchise_schedule(integer, text) to anon, authenticated;
grant execute on function public.franchise_game(uuid, text) to anon, authenticated;
-- franchise vs franchise: the link is the key; the ladder is public
grant execute on function public.franchise_challenge_create(text, text) to anon, authenticated;
grant execute on function public.franchise_challenge_peek(text, text) to anon, authenticated;
grant execute on function public.franchise_challenge_accept(text, text) to anon, authenticated;
grant execute on function public.franchise_challenge_cancel(uuid, text) to anon, authenticated;
grant execute on function public.franchise_challenges_mine(integer, text) to anon, authenticated;
grant execute on function public.franchise_ladder(integer, text) to anon, authenticated;
grant execute on function public.franchise_h2h_context(text) to anon, authenticated;
-- facilities and the Trophy Room
grant execute on function public.franchise_facilities() to anon, authenticated;
grant execute on function public.franchise_upgrade(text, text) to anon, authenticated;
grant execute on function public.franchise_trophies(text) to anon, authenticated;
grant execute on function public.franchise_market() to anon, authenticated;
grant execute on function public.franchise_signing_cost(integer) to anon, authenticated;
grant execute on function public.franchise_market_board(text) to anon, authenticated;
grant execute on function public.franchise_scout(uuid, text) to anon, authenticated;
grant execute on function public.franchise_draft(uuid, text) to anon, authenticated;
grant execute on function public.franchise_sign(uuid, text) to anon, authenticated;
grant execute on function public.franchise_release(uuid, text) to anon, authenticated;
-- the conference: a league of friends is joined by link, on the same terms
-- as Head-to-Head, so every one of these is open to a device franchise too
grant execute on function public.franchise_conference_config() to anon, authenticated;
grant execute on function public.franchise_conference_is_mine(uuid) to anon, authenticated;
grant execute on function public.franchise_conference_create(text, text) to anon, authenticated;
grant execute on function public.franchise_conference_peek(text, text) to anon, authenticated;
grant execute on function public.franchise_conference_join(text, text) to anon, authenticated;
grant execute on function public.franchise_conference_leave(text) to anon, authenticated;
grant execute on function public.franchise_conference_start(text) to anon, authenticated;
grant execute on function public.franchise_conference_advance(text) to anon, authenticated;
grant execute on function public.franchise_conference_board(text) to anon, authenticated;
grant execute on function public.franchise_conference_game(uuid, text) to anon, authenticated;
-- Phase 7: the published tables are open to read, and the four trade moves
-- are open on the same terms every other franchise move is
grant execute on function public.franchise_injuries() to anon, authenticated;
grant execute on function public.franchise_is_available(text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.franchise_postseason() to anon, authenticated;
grant execute on function public.franchise_bowl_earned(integer, integer) to anon, authenticated;
grant execute on function public.franchise_trade_rules() to anon, authenticated;
grant execute on function public.franchise_trade_illegal(uuid, uuid, uuid[], uuid[]) to anon, authenticated;
grant execute on function public.franchise_trade_partners(text) to anon, authenticated;
grant execute on function public.franchise_trade_offer(uuid, uuid[], uuid[], text, text) to anon, authenticated;
grant execute on function public.franchise_trade_respond(uuid, boolean, text) to anon, authenticated;
grant execute on function public.franchise_trade_withdraw(uuid, text) to anon, authenticated;
grant execute on function public.franchise_trades_mine(integer, text) to anon, authenticated;
-- Phase 8: the staff table and its two curves are open to read, and the four
-- moves are open on the same terms every other franchise move is
grant execute on function public.franchise_staff() to anon, authenticated;
grant execute on function public.franchise_staff_cost(integer) to anon, authenticated;
grant execute on function public.franchise_staff_cost_between(integer, integer) to anon, authenticated;
grant execute on function public.franchise_staff_effect(integer, numeric) to anon, authenticated;
grant execute on function public.franchise_staff_grade(integer) to anon, authenticated;
grant execute on function public.franchise_staff_specialty_count(integer) to anon, authenticated;
grant execute on function public.franchise_staff_board(text) to anon, authenticated;
grant execute on function public.franchise_staff_hire(text, text) to anon, authenticated;
grant execute on function public.franchise_staff_promote(text, integer, text) to anon, authenticated;
grant execute on function public.franchise_staff_fire(text, text) to anon, authenticated;
-- Phase 9: the scouting table and its four curves are open to read, the way
-- every other table in this file is. The grade itself is a definer read of
-- one franchise's own record and is reached through franchise_home() and
-- franchise_market_board(), which already prove who is asking.
grant execute on function public.franchise_scouting() to anon, authenticated;
grant execute on function public.franchise_scout_grade_of(integer) to anon, authenticated;
grant execute on function public.franchise_scout_band(integer) to anon, authenticated;
grant execute on function public.franchise_scout_cost(integer) to anon, authenticated;
grant execute on function public.franchise_scout_lift(integer) to anon, authenticated;
revoke all on function public.franchise_scout_report(uuid) from public, anon, authenticated;
-- Phase 10: the development table and its four curves are open to read, the
-- move and the board are open on the same terms every other franchise move
-- is, and the two definer reads that touch one franchise's own record are not
grant execute on function public.franchise_development() to anon, authenticated;
grant execute on function public.franchise_dev_par(text, integer) to anon, authenticated;
grant execute on function public.franchise_dev_cost(integer) to anon, authenticated;
grant execute on function public.franchise_dev_lift(integer, integer) to anon, authenticated;
grant execute on function public.franchise_develop(uuid, text) to anon, authenticated;
grant execute on function public.franchise_development_board(text) to anon, authenticated;
revoke all on function public.franchise_dev_slots(uuid) from public, anon, authenticated;
revoke all on function public.franchise_dev_grade(uuid, uuid, integer) from public, anon, authenticated;
-- and the league is public: the table of clubs, what a standing faces, and
-- what a result is worth are the same for everybody and hide nothing
grant execute on function public.franchise_league() to anon, authenticated;
-- Phase 11: the rank table and its curves are open to read, the two moves are
-- open on the same terms every other franchise move is, and the derived read
-- of one franchise's own record is not
grant execute on function public.franchise_ranks() to anon, authenticated;
grant execute on function public.franchise_rank_cost(integer) to anon, authenticated;
grant execute on function public.franchise_rank_at(integer) to anon, authenticated;
grant execute on function public.franchise_rank_for(integer) to anon, authenticated;
grant execute on function public.franchise_rank_edge(integer) to anon, authenticated;
grant execute on function public.franchise_pack_open(text) to anon, authenticated;
grant execute on function public.franchise_pack_keep(uuid, text) to anon, authenticated;
grant execute on function public.franchise_pack_pass(text) to anon, authenticated;
-- Phase 13: the calls are a published table, and the two moves are open on
-- the same terms every other franchise move is. A client sends a CALL and
-- never a result; the drive resolver stays reachable by no client role.
grant execute on function public.franchise_snaps() to anon, authenticated;
grant execute on function public.franchise_snap_call(text) to anon, authenticated;
grant execute on function public.franchise_game_open(text) to anon, authenticated;
grant execute on function public.franchise_game_call(text, text) to anon, authenticated;
-- Phase 14: the rules and the stake are a published table anyone may read;
-- playing a decided game out and reading your own reel are franchise moves.
grant execute on function public.franchise_moments() to anon, authenticated;
grant execute on function public.franchise_stake(integer, integer) to anon, authenticated;
grant execute on function public.franchise_is_key(numeric) to anon, authenticated;
grant execute on function public.franchise_game_story(jsonb) to anon, authenticated;
grant execute on function public.franchise_game_finish(text) to anon, authenticated;
grant execute on function public.franchise_reel(text, integer) to anon, authenticated;
-- Phase 15: the clock and the fronts are published tables. The opponent's
-- play-caller is NOT: seeing their card before you answer it would be the
-- whole game handed over.
grant execute on function public.franchise_clock() to anon, authenticated;
grant execute on function public.franchise_drive_seconds(integer, numeric, text, numeric) to anon, authenticated;
grant execute on function public.franchise_tempo(integer, integer) to anon, authenticated;
grant execute on function public.franchise_fronts() to anon, authenticated;
grant execute on function public.franchise_front_call(text) to anon, authenticated;
grant execute on function public.franchise_call_side(text) to anon, authenticated;
-- Phase 16: the playbook is a published table anyone may read. What the
-- DEFENSE is about to line up in is not — reading your formation is their
-- move, and seeing their answer before you commit would be the whole game.
grant execute on function public.franchise_formations() to anon, authenticated;
grant execute on function public.franchise_formation(text) to anon, authenticated;
grant execute on function public.franchise_plays() to anon, authenticated;
grant execute on function public.franchise_play(text) to anon, authenticated;
grant execute on function public.franchise_playbook_sets(text) to anon, authenticated;
grant execute on function public.franchise_playbook(text) to anon, authenticated;
grant execute on function public.franchise_play_allowed(text, text) to anon, authenticated;
revoke all on function public.franchise_ai_front(numeric, integer, integer) from public, anon, authenticated;
revoke all on function public.franchise_ai_call(text, integer, integer) from public, anon, authenticated;
revoke all on function public.franchise_game_drives(uuid, uuid) from public, anon, authenticated;
-- Phase 12: what a career looks like, what a rank pays the building, and what
-- a reputation is worth to a new coach — all public tables
grant execute on function public.franchise_career() to anon, authenticated;
grant execute on function public.franchise_rank_coach_points(integer) to anon, authenticated;
grant execute on function public.franchise_staff_hire_level(integer, integer) to anon, authenticated;
grant execute on function public.franchise_rookie_lift(integer, integer) to anon, authenticated;
grant execute on function public.franchise_rank_board(text) to anon, authenticated;
revoke all on function public.franchise_rank_report(uuid) from public, anon, authenticated;
grant execute on function public.franchise_league_gap(integer, integer) to anon, authenticated;
grant execute on function public.franchise_standing_delta(text, integer, integer, boolean) to anon, authenticated;

commit;

-- ===========================================================================
-- WHAT THIS FILE JUST INSTALLED
--
-- One row per phase, into the log games_social.sql created. The file is still
-- the whole deployment and re-running it is still safe; this is the record
-- that lets a page, the report and a person all ask what a database has and
-- get the same answer. A database that stops at phase 6 says so.
-- ===========================================================================

begin;
select public.games_schema_note('franchise', 1, 'the franchise, the roster, the ledger and the achievements');
select public.games_schema_note('franchise', 2, 'the weekly game: the schedule, the simulator and the season');
select public.games_schema_note('franchise', 3, 'franchise vs franchise: challenges, rivalries and the ladder');
select public.games_schema_note('franchise', 4, 'the offseason, the facilities and the Trophy Room');
select public.games_schema_note('franchise', 5, 'the draft and the market');
select public.games_schema_note('franchise', 6, 'conferences and playoffs');
select public.games_schema_note('franchise', 7, 'injuries, the bowl and trades');
select public.games_schema_note('franchise', 8, 'the coaching staff');
select public.games_schema_note('franchise', 9, 'the scouting department');
select public.games_schema_note('franchise', 10, 'the development program and the league');
select public.games_schema_note('franchise', 11, 'the rank and the packs');
select public.games_schema_note('franchise', 12, 'the long haul: careers and a building you can staff');
select public.games_schema_note('franchise', 13, 'the drives you call');
select public.games_schema_note('franchise', 14, 'key moments');
select public.games_schema_note('franchise', 15, 'both sides of the ball');
select public.games_schema_note('franchise', 16, 'the playbook');
commit;

-- ===========================================================================
-- THE PLAYER UNIVERSE — profile_v1 (Phase 17)
--
-- Every athlete carries four stored ratings for his position; the simulator
-- plays with them and the overall is their mean. A football game wants more
-- than four numbers on a card. THE PROFILE DERIVES THEM: speed, acceleration,
-- agility, strength, awareness and stamina for everybody, and the position's
-- own vocabulary on top (a quarterback's throw power and accuracy by depth, a
-- corner's man and zone coverage, a lineman's pass and run block).
--
-- It is a PURE FUNCTION of what is already stored — position, the four
-- ratings, the archetype, and four small integers the card carries (jersey,
-- age, stamina, the letters of the last name) — so it needs no column, no
-- migration and no ageing code: when the four grow, the profile grows, and it
-- can never disagree with the card it is printed on. games/lib/gridiron/
-- profile.js restates every formula in JavaScript with INTEGER arithmetic in
-- both languages, and tools/games/profile.test.js pins the two together
-- against a real database.
--
-- Also here: the collector's eight tiers off the overall (Prospect to
-- Mythic), how far a man can go in words (Limited to Generational), a body
-- and a home town from the same four integers, a bigger pool of names, and
-- the archetypes the brief names. Nothing here is random.
-- ===========================================================================

begin;

-- more names: the original lists are kept in place and grown, so an existing
-- roster is unchanged and a new one draws from a wider well. Believable, and
-- nobody famous.
create or replace function public.franchise_pool_first_names()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'Mason','Cameron','Jalen','Trey','Dorian','Malik','Bryce','Colton','Elijah','Deshawn',
    'Tanner','Marcus','Kellen','Rashad','Tyler','Isaiah','Devin','Grant','Xavier','Jordan',
    'Caleb','Andre','Brock','Terrell','Wyatt','Darius','Hunter','Jamal','Cody','Antonio',
    'Landon','Kwame','Reid','Tavion','Ethan','Deandre','Cole','Jaylen','Nolan','Marquis',
    'Griffin','Omari','Beau','Zion','Sawyer','Ezekiel','Parker','Amari','Weston','Kendrick',
    'Dalton','Javon','Miles','Roman','Silas','Terrance','Blake','Kalil','Rhett','Dashawn',
    'Emmett','Lamar','Everett','Quincy','Holden','Tremaine','Jasper','Cedric','Wade','Jerome',
    'Hayes','Donovan','Ford','Micah','Boone','Keon','Lincoln','Reggie','Cash','Marlon',
    'Tucker','Isaac','Brooks','Andre','Knox','Terrell','Cruz','Dante','Sterling','Kofi',
    'Ridge','Josiah','Colby','Malachi','Turner','Rasheed','Gage','Adrian','Walker','Jabari',
    'Bishop','Tobias','Cyrus','Elias','Vance','Amos','Judah','Levi','Rowan','Otis',
    -- profile_v1: the well widens
    'Jace','Andres','Darnell','Kameron','Braxton','Tariq','Corey','Desmond','Lamont','Nathaniel',
    'Rodney','Shane','Trent','Vernon','Wesley','Zachary','Alonzo','Brendan','Cortez','Damien',
    'Ellis','Fabian','Garrett','Hollis','Ignacio','Jarvis','Kendall','Leland','Maurice','Nasir',
    'Orlando','Preston','Quentin','Rafael','Santiago','Tyrese','Ulysses','Vaughn','Warren','Yusuf',
    'Abram','Barrett','Clayton','Deon','Elliot','Franklin','Gideon','Harlan','Irving','Jeremiah',
    'Kobe','Lorenzo','Mateo','Nehemiah','Octavio','Percy','Rex','Solomon','Titus','Uriel',
    'Victor','Wilson','Xander','Yosef','Zeke','Alvin','Bennett','Curtis','Dexter','Emilio',
    'Felix','Gavin','Hugo','Ivan','Jonas','Kyler','Lucas','Marvin','Nikolai','Oscar',
    'Phoenix','Quinn','Ramon','Simeon','Theo','Ulrich','Vince','Wilder','Yancy','Zavier',
    'Ahmad','Booker','Cassius','Demarcus','Enzo','Frederick','Gerald','Hakeem','Idris','Jamison',
    'Kareem','Lionel','Moses','Nigel','Omar','Pierce','Raheem','Sebastian','Tremont','Vaughan',
    'Whitman','Alden','Bo','Carver','Denzel','Eamon','Fletcher','Graham','Heath','Imani',
    'Jett','Kade','Lane','Mekhi','Nash','Odell','Paxton','Rocco','Stellan','Tate',
    'Ugo','Vidal','Wendell','Xzavier','York','Zander','Anson','Bram','Colt','Dax',
    'Ezra','Flynn','Grady','Hollins','Ike','Jaxon','Kian','Lyle','Merritt','Nico',
    'Onyx','Pryor','Ransom','Slade','Thaddeus','Ulises','Vaughnn','Wes','Yael','Zephyr',
    'Abel','Baylor','Cannon','Deacon','Emory','Forrest','Gunnar','Hendrix','Ira','Jonah'];
$$;

create or replace function public.franchise_pool_last_names()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'Crowe','Redd','Vale','Hargrove','Whitlock','Bell','Okafor','Dawson','Pruitt','Marsh',
    'Calloway','Reyes','Sutton','Banks','Thorne','Delgado','Mercer','Kincaid','Ashby','Fontaine',
    'Greer','Holloway','Ingram','Jessup','Kerrigan','Lockhart','Maddox','Navarro','Osei','Pemberton',
    'Quinlan','Rourke','Sable','Tillman','Underwood','Vickers','Wolfe','Yates','Zeller','Abernathy',
    'Barlow','Coyle','Driscoll','Easton','Fairbanks','Gaines','Hensley','Ivory','Jarrett','Keller',
    'Lattimore','Moncrief','Northcutt','Oakes','Pettigrew','Ramsey','Sheppard','Tremble','Upshaw','Voss',
    'Whitfield','Beaumont','Castellano','Duvall','Everly','Falk','Gatlin','Harlan','Iverson','Jubilee',
    'Kessler','Lindqvist','Montague','Nash','Oduya','Prescott','Ridley','Stovall','Tolbert','Vaughn',
    'Wexler','Bloom','Corbin','Denning','Ellsworth','Fenwick','Granger','Hobbs','Isley','Jennings',
    'Knowles','Landry','Mathis','Newsome','Orland','Pike','Rutledge','Sizemore','Truett','Vandiver',
    'Whitaker','Ainsley','Bright','Chisholm','Dorsey','Emerson','Fielder','Goodwin','Haskins','Irwin',
    'Jacoby','Kilgore','Lemieux','Mallory','Nix','Overton','Pinkney','Rawls','Stanton','Tibbs',
    'Ulrich','Villanueva','Waverly','Blackwood','Coleman','Darby','Escobar','Frost','Gilliam','Hollis',
    'Ibarra','Judd','Kemp','Lacey','Merriweather','Oyelaran','Pace','Reinholt','Sloan','Tatum',
    'Vega','Winslow','Ackerman','Boudreaux','Carrick','Dunbar','Farrow','Guthrie','Hyde','Larkin',
    -- profile_v1: the well widens
    'Vance','Brennan','Ricks','Fields','Adeyemi','Bautista','Colvin','Dumas','Eze','Fitzgerald',
    'Galloway','Hairston','Ikande','Jimenez','Kirkland','Lockett','Mbatha','Nwosu','Ortega','Pickens',
    'Quarles','Reddick','Sandoval','Talley','Urbina','Valentine','Wheatley','Yancey','Zapata','Alston',
    'Bledsoe','Cordova','Dickerson','Espinoza','Foreman','Gaskins','Hairfield','Igwe','Jeffcoat','Kearse',
    'Lassiter','McCray','Nunez','Ojeda','Paschal','Rainey','Satterfield','Toussaint','Vasquez','Wilkerson',
    'Acosta','Battle','Cartwright','Deloach','Ellison','Fuentes','Gadsden','Holcomb','Ingle','Joyner',
    'Kittrell','Lowry','Mabry','Norwood','Olamide','Poindexter','Rucker','Spivey','Trotter','Umana',
    'Vanterpool','Wingate','Ybarra','Zamora','Applewhite','Broussard','Cullen','Dupree','Etienne','Ferrell',
    'Goins','Harrell','Isom','Jeter','Kelso','Lipscomb','Mendez','Nolan','Osborne','Pruett',
    'Rhodes','Shackleford','Threadgill','Vinson','Westbrook','Adair','Boykin','Cobb','Dozier','Eldridge',
    'Fairchild','Grissom','Hutto','Ivey','Jasper','Kirby','Leblanc','Mayfield','Odom','Parrish',
    'Rankin','Stallworth','Teague','Vann','Whitehurst','Arrington','Blackmon','Crenshaw','Dellinger','Estrada',
    'Fowler','Gowdy','Hairston','Ingalls','Jernigan','Kimbrough','Lanier','Melton','Newby','Oakley',
    'Pettaway','Ruffin','Strickland','Tolliver','Varnado','Weathers','Aldridge','Brister','Cofield','Dansby',
    'Ealy','Fontenot','Gaither','Hightower','Inman','Jolley','Kinsey','Lovett','Mims','Nettles',
    'Ousley','Pryor','Rambo','Shivers','Thigpen','Veal','Wimberly','Amos','Bostic','Cheatham',
    'Dortch','Ensley','Furlow','Gholston','Hardaway','Irby','Jordan','Keyes','Lipsey','Marable'];
$$;

-- the archetypes the brief names, appended to the pools the generator
-- already draws from. Every skew sums near zero across the four, so a
-- founding roster still lands where it always has.
create or replace function public.franchise_pool_archetypes()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{
    "QB":[{"name":"Field General","skew":{"iq":6,"acc":3,"arm":-2,"spd":-4}},
          {"name":"Gunslinger","skew":{"arm":7,"acc":-2,"iq":-1,"spd":-2}},
          {"name":"Scrambler","skew":{"spd":8,"arm":-3,"acc":-2,"iq":-1}},
          {"name":"Improviser","skew":{"spd":4,"iq":3,"acc":-3,"arm":-2}},
          {"name":"Game Manager","skew":{"acc":6,"iq":3,"arm":-5,"spd":-3}}],
    "RB":[{"name":"Power Back","skew":{"pwr":7,"elu":-3,"spd":-2}},
          {"name":"Elusive Back","skew":{"elu":7,"spd":3,"pwr":-5}},
          {"name":"Receiving Back","skew":{"hnd":7,"elu":2,"pwr":-4}},
          {"name":"Workhorse","skew":{"pwr":3,"hnd":2,"elu":-2,"spd":-1}}],
    "WR":[{"name":"Deep Threat","skew":{"spd":8,"rte":-3,"hnd":-2}},
          {"name":"Route Runner","skew":{"rte":7,"iq":3,"spd":-3}},
          {"name":"Possession","skew":{"hnd":7,"iq":2,"spd":-4}},
          {"name":"Route Technician","skew":{"rte":8,"iq":2,"spd":-4,"hnd":-2}},
          {"name":"Possession Receiver","skew":{"hnd":8,"iq":1,"spd":-5}},
          {"name":"Slot Weapon","skew":{"rte":4,"spd":3,"hnd":-2,"iq":-3}},
          {"name":"Physical Target","skew":{"hnd":5,"iq":2,"rte":-2,"spd":-3}}],
    "TE":[{"name":"Seam Stretcher","skew":{"spd":6,"rte":3,"blk":-6}},
          {"name":"In-Line","skew":{"blk":7,"hnd":-2,"spd":-4}},
          {"name":"Move TE","skew":{"hnd":4,"rte":3,"blk":-3}}],
    "OL":[{"name":"Pass Protector","skew":{"pbk":6,"rbk":-3}},
          {"name":"Road Grader","skew":{"rbk":6,"str":3,"pbk":-4}},
          {"name":"Technician","skew":{"iq":5,"pbk":2,"rbk":1,"str":-4}}],
    "DL":[{"name":"Edge Rusher","skew":{"prs":8,"rst":-4}},
          {"name":"Run Stopper","skew":{"rst":7,"str":3,"prs":-5}},
          {"name":"Hybrid","skew":{"prs":2,"rst":2}},
          {"name":"Speed Rusher","skew":{"spd":7,"prs":4,"str":-5,"rst":-4}},
          {"name":"Power Rusher","skew":{"str":7,"prs":2,"spd":-5,"rst":-2}},
          {"name":"Balanced","skew":{"prs":1,"rst":1,"str":1,"spd":-1}}],
    "LB":[{"name":"Run Stopper","skew":{"tkl":6,"cov":-4}},
          {"name":"Coverage","skew":{"cov":7,"tkl":-3}},
          {"name":"Hybrid","skew":{"tkl":2,"cov":2,"spd":2}}],
    "CB":[{"name":"Ball Hawk","skew":{"bhk":8,"tkl":-4}},
          {"name":"Coverage","skew":{"cov":6,"bhk":-2}},
          {"name":"Hybrid","skew":{"tkl":4,"cov":2,"spd":-2}},
          {"name":"Shutdown","skew":{"cov":8,"spd":1,"tkl":-4,"bhk":-3}},
          {"name":"Press Specialist","skew":{"tkl":4,"cov":3,"bhk":-4,"spd":-1}},
          {"name":"Zone Specialist","skew":{"bhk":4,"cov":3,"spd":-4,"tkl":-1}}],
    "S":[{"name":"Ball Hawk","skew":{"bhk":8,"tkl":-3}},
         {"name":"Run Stopper","skew":{"tkl":7,"cov":-4}},
         {"name":"Coverage","skew":{"cov":6,"iq":2,"tkl":-3}}],
    "K":[{"name":"Big Leg","skew":{"pwr":8,"acc":-3}},
         {"name":"Precision","skew":{"acc":7,"pwr":-4}},
         {"name":"Clutch","skew":{"clu":8,"con":-2}}],
    "P":[{"name":"Big Leg","skew":{"pwr":8,"acc":-3}},
         {"name":"Precision","skew":{"acc":7,"pwr":-4}},
         {"name":"Directional","skew":{"con":6,"pwr":-2}}]
  }'::jsonb;
$$;

-- ── the arithmetic, shared with games/lib/gridiron/profile.js to the digit ──
-- a weighted mean in tenths, rounded the same way in both languages
create or replace function public.franchise_pw(a integer, wa integer, b integer, wb integer,
                                               c integer default 0, wc integer default 0)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (coalesce(a, 0) * wa + coalesce(b, 0) * wb + coalesce(c, 0) * wc + 5) / 10;
$$;
-- the letters of a name, as a number: printable ASCII only, so the two
-- languages count the same thing
create or replace function public.franchise_letters(p text)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(sum(ascii(ch)), 0)::int
    from regexp_split_to_table(coalesce(p, ''), '') ch
   where ascii(ch) between 32 and 126;
$$;
-- a little deterministic noise, -3..3, from the four integers a card carries
create or replace function public.franchise_noise(p_jersey integer, p_age integer, p_stamina integer, p_last text, p_m integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select ((coalesce(p_jersey, 0) * 7 + coalesce(p_age, 0) * 13 + coalesce(p_stamina, 0) * 3
           + public.franchise_letters(p_last) * p_m) % 7) - 3;
$$;
-- a core rating, or the overall where the position does not carry it
create or replace function public.franchise_cr(r jsonb, k text, ov integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce((r->>k)::int, ov);
$$;

-- what an archetype adds on top of the four it already skewed — the same
-- table games/lib/gridiron/profile.js carries as ARCH
create or replace function public.franchise_profile_skews()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{
    "Field General":{"awr":5,"tup":4,"scr":-3},
    "Gunslinger":{"thp":5,"dac":4,"sac":-2},
    "Scrambler":{"scr":7,"agi":5,"acc":3,"thp":-2},
    "Improviser":{"tup":6,"scr":4,"agi":3,"mac":-2},
    "Game Manager":{"sac":5,"awr":4,"thp":-3},
    "Power Back":{"btk":6,"str":5,"agi":-3},
    "Elusive Back":{"agi":6,"acc":4,"btk":-3},
    "Receiving Back":{"cth":6,"rel":3,"btk":-3},
    "Workhorse":{"sta":7,"car":5,"acc":-2},
    "Deep Threat":{"spd":4,"rel":5,"cit":-3},
    "Route Runner":{"rte":6,"agi":3,"str":-2},
    "Route Technician":{"rte":7,"rel":3,"str":-2},
    "Possession":{"cth":5,"cit":5,"spd":-2},
    "Possession Receiver":{"cth":5,"cit":6,"spd":-3},
    "Slot Weapon":{"agi":5,"acc":4,"rel":3,"str":-3},
    "Physical Target":{"str":6,"cit":5,"agi":-3},
    "Seam Stretcher":{"spd":4,"rel":3,"blk":-3},
    "In-Line":{"blk":6,"str":4,"rel":-3},
    "Move TE":{"agi":3,"rte":3},
    "Pass Protector":{"pbk":4,"awr":2},
    "Road Grader":{"rbk":4,"str":3},
    "Technician":{"awr":4,"pbk":2,"rbk":2},
    "Edge Rusher":{"prsh":4,"acc":3,"bsh":-2},
    "Speed Rusher":{"prsh":5,"acc":4,"spd":3,"bsh":-3},
    "Power Rusher":{"bsh":5,"str":5,"acc":-2},
    "Balanced":{"prsh":2,"bsh":2},
    "Run Stopper":{"bsh":4,"tck":4,"str":3,"agi":-2},
    "Coverage":{"mcv":3,"zcv":4,"tck":-2},
    "Hybrid":{"pur":3,"awr":2},
    "Ball Hawk":{"bhk":5,"zcv":3,"tck":-2},
    "Shutdown":{"mcv":6,"prs":3,"zcv":-2},
    "Press Specialist":{"prs":6,"str":3,"zcv":-3},
    "Zone Specialist":{"zcv":6,"awr":3,"mcv":-3},
    "Big Leg":{"kpw":5,"kac":-2},
    "Precision":{"kac":5,"kpw":-2},
    "Clutch":{"clu":5},
    "Directional":{"con":4,"kac":2}
  }'::jsonb;
$$;

-- THE PROFILE. Pure, immutable, and restated key for key in profile.js.
create or replace function public.franchise_profile(p_pos text, p_ratings jsonb, p_overall integer, p_archetype text,
                                                    p_jersey integer, p_age integer, p_stamina integer, p_last text)
returns jsonb language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  ov integer := coalesce(nullif(p_overall, 0), 60);
  r jsonb := coalesce(p_ratings, '{}'::jsonb);
  sta integer := coalesce(p_stamina, 75);
  n1 integer := public.franchise_noise(p_jersey, p_age, p_stamina, p_last, 1);
  n2 integer := public.franchise_noise(p_jersey, p_age, p_stamina, p_last, 2);
  n3 integer := public.franchise_noise(p_jersey, p_age, p_stamina, p_last, 3);
  o jsonb; sk jsonb; k text; v text;
begin
  if p_pos is null then return null; end if;
  case p_pos
    when 'QB' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'iq', ov), 4) + n1,
      'agi', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'acc', ov), 4) + n2,
      'str', public.franchise_pw(public.franchise_cr(r, 'arm', ov), 4, 58, 6) + n3,
      'awr', public.franchise_cr(r, 'iq', ov),
      'thp', public.franchise_cr(r, 'arm', ov),
      'sac', greatest(30, least(99, public.franchise_cr(r, 'acc', ov) + 2 + n1)),
      'mac', public.franchise_cr(r, 'acc', ov),
      'dac', public.franchise_pw(public.franchise_cr(r, 'acc', ov), 6, public.franchise_cr(r, 'arm', ov), 4) - 3 + n2,
      'tup', public.franchise_pw(public.franchise_cr(r, 'iq', ov), 6, public.franchise_cr(r, 'acc', ov), 4) + n3,
      'scr', public.franchise_cr(r, 'spd', ov));
    when 'RB' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'elu', ov), 5, public.franchise_cr(r, 'spd', ov), 5) + n1,
      'agi', public.franchise_cr(r, 'elu', ov),
      'str', public.franchise_cr(r, 'pwr', ov),
      'awr', public.franchise_pw(public.franchise_cr(r, 'elu', ov), 3, public.franchise_cr(r, 'hnd', ov), 3, ov, 4) + n2,
      'btk', public.franchise_pw(public.franchise_cr(r, 'pwr', ov), 6, public.franchise_cr(r, 'elu', ov), 4) + n3,
      'car', public.franchise_pw(public.franchise_cr(r, 'pwr', ov), 5, public.franchise_cr(r, 'hnd', ov), 5) - n1,
      'vis', public.franchise_pw(public.franchise_cr(r, 'elu', ov), 5, public.franchise_cr(r, 'hnd', ov), 5) + n2,
      'cth', public.franchise_cr(r, 'hnd', ov));
    when 'WR' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'rte', ov), 4) + n1,
      'agi', public.franchise_pw(public.franchise_cr(r, 'rte', ov), 6, public.franchise_cr(r, 'spd', ov), 4) + n2,
      'str', public.franchise_pw(public.franchise_cr(r, 'hnd', ov), 3, 52, 7) + n3,
      'awr', public.franchise_cr(r, 'iq', ov),
      'cth', public.franchise_cr(r, 'hnd', ov),
      'rte', public.franchise_cr(r, 'rte', ov),
      'rel', public.franchise_pw(public.franchise_cr(r, 'rte', ov), 5, public.franchise_cr(r, 'spd', ov), 5) + n1,
      'cit', public.franchise_pw(public.franchise_cr(r, 'hnd', ov), 6, public.franchise_cr(r, 'iq', ov), 4) + n3);
    when 'TE' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'rte', ov), 4) + n1,
      'agi', public.franchise_pw(public.franchise_cr(r, 'rte', ov), 5, public.franchise_cr(r, 'spd', ov), 5) + n2,
      'str', public.franchise_pw(public.franchise_cr(r, 'blk', ov), 6, 60, 4) + n3,
      'awr', public.franchise_pw(public.franchise_cr(r, 'rte', ov), 4, public.franchise_cr(r, 'hnd', ov), 3, public.franchise_cr(r, 'blk', ov), 3) + n1,
      'cth', public.franchise_cr(r, 'hnd', ov),
      'rte', public.franchise_cr(r, 'rte', ov),
      'rel', public.franchise_pw(public.franchise_cr(r, 'rte', ov), 5, public.franchise_cr(r, 'spd', ov), 5) - 2 + n2,
      'cit', public.franchise_pw(public.franchise_cr(r, 'hnd', ov), 6, public.franchise_cr(r, 'blk', ov), 4) + n3,
      'blk', public.franchise_cr(r, 'blk', ov));
    when 'OL' then o := jsonb_build_object(
      'spd', public.franchise_pw(public.franchise_cr(r, 'str', ov), 2, 46, 8) + n1,
      'acc', public.franchise_pw(public.franchise_cr(r, 'iq', ov), 2, 50, 8) + n2,
      'agi', public.franchise_pw(public.franchise_cr(r, 'iq', ov), 3, 48, 7) + n3,
      'str', public.franchise_cr(r, 'str', ov),
      'awr', public.franchise_cr(r, 'iq', ov),
      'pbk', public.franchise_cr(r, 'pbk', ov),
      'rbk', public.franchise_cr(r, 'rbk', ov));
    when 'DL' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'prs', ov), 5, public.franchise_cr(r, 'spd', ov), 5) + n1,
      'agi', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'prs', ov), 4) + n2,
      'str', public.franchise_cr(r, 'str', ov),
      'awr', public.franchise_pw(public.franchise_cr(r, 'rst', ov), 5, public.franchise_cr(r, 'prs', ov), 3, 60, 2) + n3,
      'prsh', public.franchise_cr(r, 'prs', ov),
      'bsh', public.franchise_pw(public.franchise_cr(r, 'str', ov), 6, public.franchise_cr(r, 'rst', ov), 4) + n1,
      'pur', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'rst', ov), 4) + n2);
    when 'LB' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'tkl', ov), 4) + n1,
      'agi', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'cov', ov), 4) + n2,
      'str', public.franchise_pw(public.franchise_cr(r, 'tkl', ov), 6, 58, 4) + n3,
      'awr', public.franchise_cr(r, 'iq', ov),
      'tck', public.franchise_cr(r, 'tkl', ov),
      'pur', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 6, public.franchise_cr(r, 'tkl', ov), 4) + n1,
      'mcv', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'spd', ov), 4) + n2,
      'zcv', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'iq', ov), 4) + n3,
      'bsh', public.franchise_pw(public.franchise_cr(r, 'tkl', ov), 5, public.franchise_cr(r, 'iq', ov), 5) - 4 + n1);
    when 'CB' then o := jsonb_build_object(
      'spd', public.franchise_cr(r, 'spd', ov),
      'acc', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 7, public.franchise_cr(r, 'cov', ov), 3) + n1,
      'agi', public.franchise_pw(public.franchise_cr(r, 'spd', ov), 5, public.franchise_cr(r, 'cov', ov), 5) + n2,
      'str', public.franchise_pw(public.franchise_cr(r, 'tkl', ov), 5, 50, 5) + n3,
      'awr', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 5, public.franchise_cr(r, 'bhk', ov), 5) + n1,
      'mcv', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'spd', ov), 4) + n2,
      'zcv', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'bhk', ov), 4) + n3,
      'tck', public.franchise_cr(r, 'tkl', ov),
      'prs', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 5, public.franchise_cr(r, 'tkl', ov), 5) + n1);
    when 'S' then o := jsonb_build_object(
      'spd', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 5, public.franchise_cr(r, 'bhk', ov), 3, 70, 2) + n1,
      'acc', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'tkl', ov), 4) + n2,
      'agi', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'bhk', ov), 4) + n3,
      'str', public.franchise_pw(public.franchise_cr(r, 'tkl', ov), 6, 55, 4) + n1,
      'awr', public.franchise_cr(r, 'iq', ov),
      'mcv', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'tkl', ov), 2, public.franchise_cr(r, 'bhk', ov), 2) - 2 + n2,
      'zcv', public.franchise_pw(public.franchise_cr(r, 'cov', ov), 6, public.franchise_cr(r, 'iq', ov), 4) + n3,
      'tck', public.franchise_cr(r, 'tkl', ov),
      'bhk', public.franchise_cr(r, 'bhk', ov));
    else o := jsonb_build_object(
      'spd', 52 + n1, 'acc', 50 + n2, 'agi', 50 + n3,
      'str', public.franchise_pw(public.franchise_cr(r, 'pwr', ov), 5, 45, 5) + n1,
      'awr', public.franchise_cr(r, 'con', ov),
      'kpw', public.franchise_cr(r, 'pwr', ov), 'kac', public.franchise_cr(r, 'acc', ov),
      'clu', public.franchise_cr(r, 'clu', ov), 'con', public.franchise_cr(r, 'con', ov));
  end case;
  o := o || jsonb_build_object('sta', sta);
  sk := public.franchise_profile_skews()->coalesce(p_archetype, '');
  if sk is not null then
    for k, v in select key, value from jsonb_each_text(sk) loop
      if o ? k then o := o || jsonb_build_object(k, (o->>k)::int + v::int); end if;
    end loop;
  end if;
  select jsonb_object_agg(key, greatest(30, least(99, value::int))) into o from jsonb_each_text(o);
  return o || jsonb_build_object('version', 'profile_v1');
end;
$$;

-- the collector's eight tiers, off the overall. The rarity a card already
-- carries (common..elite) is the generator's; this is the collector's.
create or replace function public.franchise_card_tier(p_overall integer)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_overall, 0) >= 98 then 'mythic'
              when p_overall >= 93 then 'legend'
              when p_overall >= 87 then 'apex'
              when p_overall >= 81 then 'elite'
              when p_overall >= 75 then 'prime'
              when p_overall >= 69 then 'impact'
              when p_overall >= 62 then 'starter'
              else 'prospect' end;
$$;
-- how far he can go, in words
create or replace function public.franchise_potential_tier(p_overall integer, p_potential integer, p_dev_tier text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_potential, p_overall) >= 95 and p_dev_tier = 'superstar' then 'generational'
              when coalesce(p_potential, p_overall) >= 90 then 'elite'
              when coalesce(p_potential, p_overall) - coalesce(p_overall, 0) >= 12 then 'breakout'
              when coalesce(p_potential, p_overall) - coalesce(p_overall, 0) >= 6 then 'rising'
              when coalesce(p_potential, p_overall) - coalesce(p_overall, 0) >= 2 then 'normal'
              else 'limited' end;
$$;
-- a body, from the position and the same four integers
create or replace function public.franchise_body(p_pos text, p_jersey integer, p_age integer, p_stamina integer, p_last text)
returns jsonb language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  b jsonb := coalesce(('{"QB":[74,3,215,12],"RB":[70,3,212,14],"WR":[72,3,195,14],"TE":[76,2,250,12],'
    || '"OL":[77,2,312,16],"DL":[75,2,282,22],"LB":[73,2,238,12],"CB":[71,2,190,10],'
    || '"S":[72,2,202,10],"K":[71,2,190,12],"P":[73,2,200,12]}')::jsonb->coalesce(p_pos, ''),
    '[73,2,238,12]'::jsonb);
  n1 integer := public.franchise_noise(p_jersey, p_age, p_stamina, p_last, 1);
  n2 integer := public.franchise_noise(p_jersey, p_age, p_stamina, p_last, 2);
  inches integer; lbs integer;
begin
  inches := (b->>0)::int + floor((n1 * (b->>1)::int + 1)::numeric / 3)::int;
  lbs := (b->>2)::int + n2 * ((b->>3)::int / 3);
  return jsonb_build_object('height_in', inches, 'weight_lb', lbs,
    'height', (inches / 12)::text || '''' || (inches % 12)::text || '"');
end;
$$;
-- a home town: real American places, none of them a team, a brand or a person
create or replace function public.franchise_towns()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['Tyler, TX', 'Odessa, TX', 'Lufkin, TX', 'Waco, TX', 'Killeen, TX', 'Beaumont, TX', 'Valdosta, GA', 'Macon, GA',
    'Albany, GA', 'Rome, GA', 'Mobile, AL', 'Dothan, AL', 'Gadsden, AL', 'Hattiesburg, MS', 'Meridian, MS', 'Tupelo, MS',
    'Lafayette, LA', 'Monroe, LA', 'Lake Charles, LA', 'Shreveport, LA', 'Pine Bluff, AR', 'Jonesboro, AR', 'Tulsa, OK', 'Lawton, OK',
    'Muskogee, OK', 'Wichita, KS', 'Topeka, KS', 'Lincoln, NE', 'Grand Island, NE', 'Sioux Falls, SD', 'Bismarck, ND', 'Billings, MT',
    'Boise, ID', 'Pocatello, ID', 'Ogden, UT', 'Provo, UT', 'Pueblo, CO', 'Grand Junction, CO', 'Las Cruces, NM', 'Yuma, AZ',
    'Mesa, AZ', 'Bakersfield, CA', 'Fresno, CA', 'Stockton, CA', 'Modesto, CA', 'Oceanside, CA', 'Inglewood, CA', 'Long Beach, CA',
    'Compton, CA', 'Vallejo, CA', 'Salinas, CA', 'Eugene, OR', 'Medford, OR', 'Tacoma, WA', 'Yakima, WA', 'Spokane, WA', 'Reno, NV',
    'Henderson, NV', 'Flint, MI', 'Saginaw, MI', 'Muskegon, MI', 'Toledo, OH', 'Akron, OH', 'Youngstown, OH', 'Canton, OH', 'Dayton, OH',
    'Gary, IN', 'Fort Wayne, IN', 'Evansville, IN', 'Peoria, IL', 'Joliet, IL', 'Rockford, IL', 'Racine, WI', 'Green Bay, WI',
    'Duluth, MN', 'Rochester, MN', 'Davenport, IA', 'Waterloo, IA', 'Springfield, MO', 'Joplin, MO', 'Cape Girardeau, MO',
    'Paducah, KY', 'Bowling Green, KY', 'Owensboro, KY', 'Chattanooga, TN', 'Jackson, TN', 'Clarksville, TN', 'Huntsville, AL',
    'Charleston, WV', 'Huntington, WV', 'Roanoke, VA', 'Hampton, VA', 'Norfolk, VA', 'Lynchburg, VA', 'Fayetteville, NC',
    'Greenville, NC', 'Wilmington, NC', 'Rock Hill, SC', 'Florence, SC', 'Sumter, SC', 'Pensacola, FL', 'Ocala, FL', 'Lakeland, FL',
    'Fort Pierce, FL', 'Homestead, FL', 'Daytona Beach, FL', 'Erie, PA', 'Scranton, PA', 'Altoona, PA', 'Reading, PA', 'Camden, NJ',
    'Paterson, NJ', 'Trenton, NJ', 'Utica, NY', 'Binghamton, NY', 'Schenectady, NY', 'New Britain, CT', 'Waterbury, CT',
    'Brockton, MA', 'Lowell, MA', 'Manchester, NH', 'Lewiston, ME', 'Dover, DE', 'Hagerstown, MD', 'Salisbury, MD', 'Anchorage, AK',
    'Hilo, HI', 'Laredo, TX', 'Brownsville, TX', 'McAllen, TX', 'Amarillo, TX', 'Abilene, TX', 'San Angelo, TX', 'Wichita Falls, TX',
    'Texarkana, TX', 'Nacogdoches, TX', 'Columbus, GA', 'Savannah, GA', 'Augusta, GA', 'Tuscaloosa, AL', 'Montgomery, AL', 'Jackson, MS'];
$$;
create or replace function public.franchise_hometown(p_jersey integer, p_age integer, p_stamina integer, p_last text, p_first text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (public.franchise_towns())[
    ((coalesce(p_jersey, 0) * 31 + coalesce(p_age, 0) * 17 + coalesce(p_stamina, 0) * 7
      + public.franchise_letters(p_last) + public.franchise_letters(p_first))
     % array_length(public.franchise_towns(), 1)) + 1];
$$;

-- one object with all of it, for the read models
create or replace function public.franchise_profile_of(p public.game_players)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'profile', public.franchise_profile(p.position, p.ratings, p.overall, p.archetype, p.jersey, p.age, p.stamina, p.last_name),
    'tier', public.franchise_card_tier(p.overall),
    'potential_tier', public.franchise_potential_tier(p.overall, p.potential, p.dev_tier),
    'body', public.franchise_body(p.position, p.jersey, p.age, p.stamina, p.last_name),
    'hometown', public.franchise_hometown(p.jersey, p.age, p.stamina, p.last_name, p.first_name));
$$;

-- ── the read models carry it ──────────────────────────────────────────────
create or replace function public.franchise_roster(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; v_players jsonb;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select coalesce(jsonb_agg((jsonb_build_object(
      'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'position', p.position, 'jersey', p.jersey,
      'age', p.age, 'overall', p.overall, 'archetype', p.archetype, 'dev_tier', p.dev_tier, 'potential', p.potential,
      'stamina', p.stamina, 'chemistry', p.chemistry, 'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits,
      'depth', p.depth, 'status', p.status, 'acquired_source', p.acquired_source, 'acquired_season', p.acquired_season,
      'acquired_detail', p.acquired_detail, 'career_stats', p.career_stats, 'season_stats', p.season_stats, 'live_stats', p.live_stats,
      -- hurt or fit, and when he is back (Phase 7)
      'available', public.franchise_is_available(p.status, p.injured_until),
      'injured_until', p.injured_until, 'injury', p.injury)
      -- the profile, the tier, the body and the home town (Phase 17)
      || public.franchise_profile_of(p))
      order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth, p.overall desc), '[]'::jsonb)
    into v_players from public.game_players p where p.franchise_id = f.id and p.status = 'active';
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season,
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'rating', public.franchise_team_rating(f.id),
    'starters', jsonb_build_object('QB', 1, 'RB', 1, 'WR', 3, 'TE', 1, 'OL', 5, 'DL', 4, 'LB', 3, 'CB', 2, 'S', 2, 'K', 1, 'P', 1),
    'injuries', public.franchise_injuries(),
    'injured', (select count(*) from public.game_players p where p.franchise_id = f.id and p.status = 'active'
                 and not public.franchise_is_available(p.status, p.injured_until)),
    'players', v_players);
end;
$$;

create or replace function public.franchise_prospect_json(p public.game_players)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare lo integer; hi integer; w integer; base jsonb; reveal boolean := p.scouted or p.status <> 'prospect';
begin
  /* THE BAND. Its width was stamped on this prospect by the department that
     found him (scout_band, scouting_v1) and does not move afterwards; a class
     stays true to the grade it was found under. Eleven is what every class
     generated before Phase 9 was shown at.

     Inside the band the true overall is UNIFORM — the rule is in this file
     and anyone may read it, so the honest thing is for the band to mean
     exactly what it looks like: somewhere in here, nothing narrower implied.
     The band always contains the truth, so a report never contradicts it. */
  w := greatest(2, coalesce(p.scout_band, 11));
  lo := greatest(40, p.overall - (abs(hashtext(p.id::text || ':band')) % w));
  hi := least(99, lo + w - 1);
  base := jsonb_build_object('id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'position', p.position,
    'age', p.age, 'archetype', p.archetype, 'status', p.status, 'scouted', p.scouted, 'class_season', p.class_season,
    'acquired_source', p.acquired_source, 'acquired_detail', p.acquired_detail, 'asking', p.asking,
    'jersey', case when p.status = 'active' then p.jersey end, 'depth', p.depth,
    -- a body and a home town are not a scouting report: a prospect has them
    -- before anybody has paid to look at him (Phase 17)
    'body', public.franchise_body(p.position, case when p.status = 'active' then p.jersey end, p.age, p.stamina, p.last_name),
    'hometown', public.franchise_hometown(case when p.status = 'active' then p.jersey end, p.age, p.stamina, p.last_name, p.first_name));
  if reveal then
    return base || jsonb_build_object('overall', p.overall, 'potential', p.potential, 'dev_tier', p.dev_tier,
      'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits, 'stamina', p.stamina,
      -- the profile is derived from the ratings, so it is revealed with them
      'profile', public.franchise_profile(p.position, p.ratings, p.overall, p.archetype,
                   case when p.status = 'active' then p.jersey end, p.age, p.stamina, p.last_name),
      'tier', public.franchise_card_tier(p.overall),
      'potential_tier', public.franchise_potential_tier(p.overall, p.potential, p.dev_tier));
  end if;
  return base || jsonb_build_object('range', jsonb_build_array(lo, hi), 'band', w, 'overall', null, 'potential', null);
end;
$$;

create or replace function public.franchise_trade_player_json(p_player uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
      'jersey', p.jersey, 'age', p.age, 'overall', p.overall, 'archetype', p.archetype, 'potential', p.potential,
      'dev_tier', p.dev_tier, 'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits, 'depth', p.depth,
      'available', public.franchise_is_available(p.status, p.injured_until), 'injury', p.injury,
      'career_stats', p.career_stats, 'season_stats', p.season_stats,
      'first_name', p.first_name, 'last_name', p.last_name, 'stamina', p.stamina,
      'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'abbr', f.abbr))
    || public.franchise_profile_of(p)
  from public.game_players p join public.franchises f on f.id = p.franchise_id
  where p.id = p_player and p.status = 'active';
$$;

-- the pure functions are open to read; nothing here writes
grant execute on function public.franchise_pw(integer, integer, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.franchise_letters(text) to anon, authenticated;
grant execute on function public.franchise_noise(integer, integer, integer, text, integer) to anon, authenticated;
grant execute on function public.franchise_cr(jsonb, text, integer) to anon, authenticated;
grant execute on function public.franchise_profile_skews() to anon, authenticated;
grant execute on function public.franchise_profile(text, jsonb, integer, text, integer, integer, integer, text) to anon, authenticated;
grant execute on function public.franchise_card_tier(integer) to anon, authenticated;
grant execute on function public.franchise_potential_tier(integer, integer, text) to anon, authenticated;
grant execute on function public.franchise_body(text, integer, integer, integer, text) to anon, authenticated;
grant execute on function public.franchise_towns() to anon, authenticated;
grant execute on function public.franchise_hometown(integer, integer, integer, text, text) to anon, authenticated;
revoke all on function public.franchise_profile_of(public.game_players) from public, anon, authenticated;
-- two helpers from earlier phases that were neither granted nor revoked, so
-- they kept PostgreSQL's default; the convention here is that every function
-- says which it is
revoke all on function public.franchise_anybody(jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.franchise_offseason_version() to anon, authenticated;

select public.games_schema_note('franchise', 17, 'the player universe: profiles, tiers, bodies and home towns');
commit;

-- ===========================================================================
-- THE VAULT — packs_v2, and the card's own history (Phase 18)
--
-- A pack was one thing: a rank earned, three men drawn around your own team,
-- keep one. That stays, exactly — it is what the rank pays. What changes is
-- that a pack is now a THING YOU HOLD: a row in franchise_packs, sealed until
-- you open it, with a kind (the Gridiron Cache the rank pays, the Postseason
-- Pack a season seen out pays, the Championship Vault a bowl won pays, the
-- Scout's Find three sharp Price Its in a week pay, the Rookie Cache founding
-- pays), a published reward table per kind, ODDS a page can print before you
-- open it, and bad-luck protection you can read the rule of.
--
-- THE SERVER DECIDES WHAT IS IN IT, and writes it down before any animation
-- runs: the men exist in game_players with status 'pack' and their pack_id
-- the moment franchise_pack_open_id returns. A refresh, a retry or a closed
-- tab changes nothing; the Vault on the client is a reveal of a result that
-- is already true. Nothing here is bought.
--
-- AND THE CARD REMEMBERS. game_players.history is written by a trigger, so
-- every path that changes a man — the offseason, a program, a draft, a
-- signing, a pack, a trade, retirement — leaves a line without any of those
-- functions knowing about it. A card is more than an overall now.
-- ===========================================================================

begin;

create table if not exists public.franchise_packs (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises (id) on delete cascade,
  kind          text not null,
  source        text not null,            -- what earned it, in words
  source_key    text not null,            -- what earned it, as a key: one pack per (kind, key)
  seed          text not null,
  status        text not null default 'sealed' check (status in ('sealed', 'open', 'done')),
  granted_at    timestamptz not null default now(),
  opened_at     timestamptz,
  done_at       timestamptz,
  contents      jsonb not null default '{}'::jsonb,   -- what came out, and the band it came out of
  unique (franchise_id, kind, source_key)
);
create index if not exists franchise_packs_mine on public.franchise_packs (franchise_id, status, granted_at);
alter table public.franchise_packs enable row level security;
drop policy if exists franchise_packs_read on public.franchise_packs;
create policy franchise_packs_read on public.franchise_packs for select using (public.franchise_is_mine(franchise_id));

alter table public.game_players add column if not exists pack_id uuid references public.franchise_packs (id) on delete set null;
alter table public.game_players add column if not exists history jsonb not null default '[]'::jsonb;
alter table public.franchises add column if not exists packs_since_prime integer not null default 0;

-- ── THE PACK TABLE, PUBLISHED ─────────────────────────────────────────────
-- Every kind: what earns it, how many men, how many you keep, where the band
-- sits against your own team, what is guaranteed, and the protection rule.
-- Mirrored by EDFranchise.PACKS for display; the SQL is what applies.
create or replace function public.franchise_pack_defs()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{
    "version": "packs_v4",
    "prime_at": 75,
    "pass_sp": {"prospect":3,"starter":5,"impact":8,"prime":15,"elite":30,"apex":60,"legend":120,"mythic":250},
    "kinds": {
      "gridiron_cache":     {"name":"Gridiron Cache","art":"cache","size":3,"keep":1,"floor_below":10,"edge":"rank","edge_bonus":0,
                             "pool":"rotation","guarantee":null,"pity":{"after":5,"lift":6,"guarantee":"prime"},
                             "earned":"every rank you reach","blurb":"Drawn around your own team. The floor sits under your overall, the ceiling rises with your rank."},
      "rookie_cache":       {"name":"Rookie Cache","art":"rookie","size":3,"keep":1,"floor_below":8,"edge":"flat","edge_bonus":4,
                             "pool":"need","guarantee":null,"pity":null,
                             "earned":"founding the franchise","blurb":"Three young men drawn at the positions your founding roster is thinnest."},
      "postseason_pack":    {"name":"Postseason Pack","art":"postseason","size":3,"keep":1,"floor_below":6,"edge":"rank","edge_bonus":4,
                             "pool":"need","guarantee":null,"pity":null,
                             "earned":"a season seen out","blurb":"A season is worth a look at what you were missing: drawn at your weakest groups, a little above the rank."},
      "championship_vault": {"name":"Championship Vault","art":"vault","size":4,"keep":2,"floor_below":2,"edge":"rank","edge_bonus":8,
                             "pool":"need","guarantee":"prime","pity":null,
                             "earned":"a bowl won","blurb":"Four men, two kept, one of them Prime or better. The best pack in the game, and it is only ever won."},
      "scouts_find":        {"name":"Scout''s Find","art":"scout","size":2,"keep":1,"floor_below":4,"edge":"rank","edge_bonus":2,
                             "pool":"need","guarantee":null,"pity":null,"potential_lift":6,
                             "earned":"three Price Its scoring 80 or better in one week","blurb":"Read the real games well and the scouting department finds you somebody with a ceiling."},
      "gameday_pack":       {"name":"Game Day Pack","art":"gameday","size":3,"keep":1,"floor_below":8,"edge":"rank","edge_bonus":2,
                             "pool":"need","guarantee":null,"pity":null,
                             "earned":"five live games finished at Pro or harder","blurb":"Played, not simulated. Every fifth game you finish with your own thumbs at Pro or harder, the Vault seals one of these."},
      "speed_lab":          {"name":"Speed Lab","art":"speed","size":3,"keep":1,"floor_below":6,"edge":"rank","edge_bonus":3,
                             "pool":"speed","guarantee":null,"pity":null,
                             "earned":"every 1,500 live yards in your hands at Pro or harder","blurb":"Backs, receivers and the men who cover them. Every 1,500 yards your thumbs gain at Pro or harder, the lab sends three who can run."},
      "trench_unit":        {"name":"Trench Unit","art":"trench","size":3,"keep":1,"floor_below":6,"edge":"rank","edge_bonus":3,
                             "pool":"trench","guarantee":null,"pity":null,
                             "earned":"three live games at Pro or harder holding them to ten points or fewer","blurb":"Linemen, both sides of the ball. Hold a side to ten points three times with your own thumbs and the trench sends reinforcements."},
      "primetime_vault":    {"name":"Primetime Vault","art":"primetime","size":4,"keep":1,"floor_below":3,"edge":"rank","edge_bonus":6,
                             "pool":"need","guarantee":"prime","pity":null,
                             "earned":"five live wins at Pro or harder","blurb":"Four men under the lights, one of them Prime or better, and you keep one. Five games won with your own thumbs at Pro or harder earn it."}
    }
  }'::jsonb;
$$;
create or replace function public.franchise_pack_def(p_kind text)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select public.franchise_pack_defs()->'kinds'->coalesce(p_kind, '');
$$;

-- GRANT A PACK. Internal: the sources call it with a key that makes a replay
-- a no-op. Returns the pack's id, or null when it already existed.
create or replace function public.franchise_pack_grant(p_franchise uuid, p_kind text, p_source_key text, p_source text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; v_id uuid;
begin
  if public.franchise_pack_def(p_kind) is null then raise exception 'no such pack kind: %', p_kind using errcode = '22023'; end if;
  select * into f from public.franchises where id = p_franchise;
  if not found then return null; end if;
  insert into public.franchise_packs (franchise_id, kind, source, source_key, seed)
  values (p_franchise, p_kind, coalesce(p_source, p_kind), p_source_key, f.seed || ':pack:' || p_kind || ':' || p_source_key)
  on conflict (franchise_id, kind, source_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- EVERY PACK IS DERIVED FROM THE RECORD, the way the rank is. Nothing hands
-- a pack out on a hot path: whenever the Vault is read or a pack is opened,
-- this looks at what the franchise has done and materialises the sealed
-- packs it is owed, idempotently — the rank's caches for every rank between
-- rank_claimed and the rank; the Rookie Cache for founding; a Postseason Pack
-- for each of the two most recent seasons seen out; the Championship Vault
-- for every bowl won; a Scout's Find for every week in the last eight with
-- three verified Price Its at 80 or better. Once a row exists it stays, so a
-- pack earned is never taken away; the windows only say how far back a
-- newly installed Vault looks.
create or replace function public.franchise_packs_sync(p_franchise uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare rep jsonb := public.franchise_rank_report(p_franchise); v_claimed integer; v_rank integer; i integer; n integer := 0; r record;
  v_yds integer; v_walls integer; v_wins integer;
begin
  v_claimed := coalesce((rep->>'claimed')::int, 0); v_rank := coalesce((rep->>'rank')::int, 1);
  for i in (v_claimed + 1)..v_rank loop
    if public.franchise_pack_grant(p_franchise, 'gridiron_cache', i::text, 'Rank ' || i) is not null then n := n + 1; end if;
  end loop;
  if public.franchise_pack_grant(p_franchise, 'rookie_cache', 'founding', 'Founding the franchise') is not null then n := n + 1; end if;
  for r in select s.number, s.label from public.franchise_seasons s
            where s.franchise_id = p_franchise and s.status = 'complete'
            order by s.number desc limit 2 loop
    if public.franchise_pack_grant(p_franchise, 'postseason_pack', r.number::text, r.label || ' seen out') is not null then n := n + 1; end if;
  end loop;
  for r in select g.season_number, coalesce(g.opponent->>'bowl_name', 'The bowl') as bowl from public.franchise_games g
            where g.franchise_id = p_franchise and g.bowl and g.result = 'W' loop
    if public.franchise_pack_grant(p_franchise, 'championship_vault', r.season_number::text,
         r.bowl || ', Season ' || public.games_roman(r.season_number) || ', won') is not null then n := n + 1; end if;
  end loop;
  for r in select a.week_key from public.franchise_activity a
            where a.franchise_id = p_franchise and a.kind = 'price_it' and a.verified
              and coalesce((a.detail->>'score')::int, 0) >= 80 and a.created_at > now() - interval '56 days'
            group by a.week_key having count(*) >= 3 loop
    if public.franchise_pack_grant(p_franchise, 'scouts_find', r.week_key, 'Three sharp reads, week ' || r.week_key) is not null then n := n + 1; end if;
  end loop;
  -- THE GAME YOU HOLD (Phase 21): every fifth live game finished at Pro or harder
  for i in 1..coalesce((public.franchise_gameday_progress(p_franchise)->>'packs')::int, 0) loop
    if public.franchise_pack_grant(p_franchise, 'gameday_pack', i::text, 'Game Day, five played') is not null then n := n + 1; end if;
  end loop;
  -- THE PROGRAMS (packs_v4): what the games in your hands add up to, from the
  -- filed results at Pro or harder — the yards for the Speed Lab, the walls
  -- (ten points or fewer allowed) for the Trench Unit, the wins for the
  -- Primetime Vault. Capped games count for the record, not for these.
  select coalesce(sum(greatest(0, (a.detail->>'yards')::int)), 0),
         count(*) filter (where (a.detail->>'score_against')::int <= 10),
         count(*) filter (where coalesce((a.detail->>'won')::boolean, false))
    into v_yds, v_walls, v_wins
    from public.franchise_activity a
   where a.franchise_id = p_franchise and a.kind = 'live_game' and a.detail->>'difficulty' in ('pro', 'allpro', 'legend');
  for i in 1..(v_yds / 1500) loop
    if public.franchise_pack_grant(p_franchise, 'speed_lab', i::text, 'Speed Lab, ' || (i * 1500) || ' live yards') is not null then n := n + 1; end if;
  end loop;
  for i in 1..(v_walls / 3) loop
    if public.franchise_pack_grant(p_franchise, 'trench_unit', i::text, 'Trench Unit, three walls') is not null then n := n + 1; end if;
  end loop;
  for i in 1..(v_wins / 5) loop
    if public.franchise_pack_grant(p_franchise, 'primetime_vault', i::text, 'Primetime Vault, five wins') is not null then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- WHERE THE BAND SITS for a kind, on this franchise, right now: the floor
-- under the team overall, the ceiling from the rank (or flat), the bonus the
-- kind carries, the protection when it is due. One object, and the odds and
-- the generator both read it, so what is printed is what is rolled.
create or replace function public.franchise_pack_band(p_franchise uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d jsonb := public.franchise_pack_def(p_kind); f public.franchises%rowtype; rep jsonb;
  v_ovr integer; v_low integer; v_high integer; v_rank integer; pity jsonb; v_active boolean := false; v_guar text;
begin
  if d is null then return null; end if;
  select * into f from public.franchises where id = p_franchise;
  if not found then return null; end if;
  rep := public.franchise_rank_report(p_franchise);
  v_rank := coalesce((rep->>'rank')::int, 1);
  v_ovr := (public.franchise_team_rating(p_franchise)->>'overall')::int;
  v_low := greatest(40, v_ovr - (d->>'floor_below')::int);
  v_high := case when d->>'edge' = 'rank' then v_ovr + public.franchise_rank_edge(v_rank) else v_ovr end + (d->>'edge_bonus')::int;
  v_guar := d->>'guarantee';
  pity := d->'pity';
  if pity is not null and pity <> 'null'::jsonb and coalesce(f.packs_since_prime, 0) >= (pity->>'after')::int then
    v_active := true;
    v_high := v_high + (pity->>'lift')::int;
    v_guar := coalesce(v_guar, pity->>'guarantee');
  end if;
  v_high := greatest(v_low, least(99, v_high));
  return jsonb_build_object('kind', p_kind, 'low', v_low, 'high', v_high, 'team_overall', v_ovr, 'rank', v_rank,
    'guarantee', v_guar, 'prime_at', (public.franchise_pack_defs()->>'prime_at')::int,
    'pity', case when pity is null or pity = 'null'::jsonb then null else
      jsonb_build_object('after', (pity->>'after')::int, 'since', coalesce(f.packs_since_prime, 0), 'active', v_active,
                         'lift', (pity->>'lift')::int, 'guarantee', pity->>'guarantee') end);
end;
$$;

-- THE ODDS, PRINTED. The roll inside the band is uniform over whole numbers
-- (franchise_pack_generate says so), so the chance of each tier is the share
-- of the band that falls inside it — arithmetic anyone can check. A
-- guaranteed man is stated separately: the odds are the odds for the others.
create or replace function public.franchise_pack_odds(p_franchise uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b jsonb := public.franchise_pack_band(p_franchise, p_kind); lo integer; hi integer; n integer; tiers jsonb := '{}'::jsonb;
  t text; tl integer; th integer; k integer;
  bounds int[] := array[0, 62, 69, 75, 81, 87, 93, 98, 100];
  names text[] := array['prospect', 'starter', 'impact', 'prime', 'elite', 'apex', 'legend', 'mythic'];
begin
  if b is null then return null; end if;
  lo := (b->>'low')::int; hi := (b->>'high')::int; n := hi - lo + 1;
  for k in 1..8 loop
    tl := greatest(lo, bounds[k]); th := least(hi, bounds[k + 1] - 1);
    t := names[k];
    tiers := tiers || jsonb_build_object(t, case when th < tl then 0 else round(100.0 * (th - tl + 1) / n, 1) end);
  end loop;
  return b || jsonb_build_object('tiers', tiers, 'size', (public.franchise_pack_def(p_kind)->>'size')::int,
    'keep', (public.franchise_pack_def(p_kind)->>'keep')::int, 'version', public.franchise_pack_defs()->>'version');
end;
$$;

-- WHICH POSITIONS A PACK DRAWS AT. The rank's cache walks a fixed rotation
-- (unchanged from packs_v1); everything else draws at the groups your team
-- is weakest in, which is what makes a pack a roster decision.
create or replace function public.franchise_pack_positions(p_franchise uuid, p_kind text, p_ordinal integer)
returns text[] language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d jsonb := public.franchise_pack_def(p_kind); v_size integer := (d->>'size')::int; out text[] := '{}'; i integer;
  rot text[] := array['QB','RB','WR','TE','OL','DL','LB','CB','S','WR','DL','CB']; g jsonb; need text[];
begin
  if d->>'pool' = 'rotation' then
    for i in 1..v_size loop out := array_append(out, rot[1 + ((coalesce(p_ordinal, 1) - 1) * 5 + i - 1) % array_length(rot, 1)]); end loop;
    return out;
  end if;
  -- THE PROGRAMS DRAW FROM THEIR OWN POOLS: the Speed Lab from the men who
  -- run and the men who chase them, the Trench Unit from both lines.
  if d->>'pool' = 'speed' then
    rot := array['RB','WR','CB','S','WR','RB'];
    for i in 1..v_size loop out := array_append(out, rot[1 + ((coalesce(p_ordinal, 1) - 1) * 3 + i - 1) % array_length(rot, 1)]); end loop;
    return out;
  end if;
  if d->>'pool' = 'trench' then
    rot := array['OL','DL'];
    for i in 1..v_size loop out := array_append(out, rot[1 + ((coalesce(p_ordinal, 1) - 1) + i - 1) % 2]); end loop;
    return out;
  end if;
  g := public.franchise_team_rating(p_franchise)->'groups';
  select array_agg(k order by (g->>k)::int, k) into need
    from unnest(array['QB','RB','WR','TE','OL','DL','LB','CB','S']) k;
  for i in 1..v_size loop out := array_append(out, need[1 + (i - 1) % array_length(need, 1)]); end loop;
  return out;
end;
$$;

-- GENERATE A SEALED PACK'S MEN. Internal. Seeded from the pack, so the same
-- pack opens the same way however often it is read; the men are written
-- with status 'pack' and the pack's id, and the pack row records the band
-- they were rolled from. Returns the men.
create or replace function public.franchise_pack_generate(p_franchise uuid, p_pack uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  pk public.franchise_packs%rowtype; d jsonb; b jsonb; poss text[]; i integer; pid uuid; v_target integer; v_men jsonb := '[]'::jsonb;
  v_low integer; v_high integer; v_prime integer; v_guar text; v_size integer; got_prime boolean := false; v_lift integer;
  v_ordinal integer; v_real integer := public.games_season_of(now()); v_pity boolean;
begin
  select * into pk from public.franchise_packs where id = p_pack and franchise_id = p_franchise for update;
  if not found then raise exception 'no such pack' using errcode = 'P0002'; end if;
  if pk.status <> 'sealed' then raise exception 'that pack is already open' using errcode = '55000'; end if;
  d := public.franchise_pack_def(pk.kind);
  b := public.franchise_pack_band(p_franchise, pk.kind);
  v_low := (b->>'low')::int; v_high := (b->>'high')::int; v_prime := (b->>'prime_at')::int;
  v_guar := b->>'guarantee'; v_size := (d->>'size')::int; v_lift := coalesce((d->>'potential_lift')::int, 0);
  v_pity := coalesce((b->'pity'->>'active')::boolean, false);
  v_ordinal := case when pk.kind in ('gridiron_cache', 'speed_lab', 'trench_unit', 'primetime_vault') and pk.source_key ~ '^[0-9]+$' then pk.source_key::int else 1 end;
  poss := public.franchise_pack_positions(p_franchise, pk.kind, v_ordinal);
  for i in 1..v_size loop
    perform setseed(public.franchise_seed_float(pk.seed || ':' || i));
    -- THE ROLL: uniform over the whole numbers of the band, and the SERVER
    -- rolls it. franchise_pack_odds prints exactly this distribution.
    v_target := v_low + floor(random() * greatest(1, v_high - v_low + 1))::int;
    -- the guarantee lands on the last man if nobody before him met it
    if v_guar = 'prime' and i = v_size and not got_prime then v_target := greatest(v_target, least(v_high, v_prime)); end if;
    if v_target >= v_prime then got_prime := true; end if;
    pid := public.franchise_generate_player(p_franchise, poss[i], 0, v_real, pk.seed || ':' || i,
             (d->>'name') || case when pk.kind = 'gridiron_cache' then ', rank ' || pk.source_key else '' end,
             'pack', null, v_target);
    update public.game_players
       set pack_id = p_pack,
           pack_rank = case when pk.kind = 'gridiron_cache' then pk.source_key::int else pack_rank end,
           -- a Scout's Find carries a ceiling: the potential the roll gave him, lifted
           potential = least(99, potential + v_lift),
           updated_at = now()
     where id = pid;
    select v_men || public.franchise_prospect_json(p) into v_men from public.game_players p where p.id = pid;
  end loop;
  update public.franchise_packs
     set status = 'open', opened_at = now(),
         contents = jsonb_build_object('band', b, 'positions', to_jsonb(poss), 'got_prime', got_prime,
                                       'ids', (select jsonb_agg(m->>'id') from jsonb_array_elements(v_men) m))
   where id = p_pack;
  -- bad-luck protection: the counter the rule reads, kept honestly. Only the
  -- kinds that carry a pity rule move it.
  if d->'pity' is not null and d->'pity' <> 'null'::jsonb then
    update public.franchises
       set packs_since_prime = case when got_prime then 0 else packs_since_prime + 1 end, updated_at = now()
     where id = p_franchise;
  end if;
  return v_men;
end;
$$;

-- OPEN THE NEXT RANK PACK. The same door packs_v1 had, with the same
-- promises: one rank, one pack; nothing to open until a rank is earned; one
-- pack on the table at a time; claiming the rank and generating the men in
-- one statement. It now goes through the pack row like every other kind.
create or replace function public.franchise_pack_open(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; cfg jsonb := public.franchise_ranks(); rep jsonb;
  v_rank integer; pk public.franchise_packs%rowtype; v_men jsonb; b jsonb; v_new text[] := '{}';
  v_real integer := public.games_season_of(now()); v_cp integer; v_ovr integer;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  rep := public.franchise_rank_report(v_f);
  if (rep->>'packs')::int < 1 then
    raise exception 'no pack to open: rank % and % already claimed', rep->>'rank', rep->>'claimed'
      using errcode = '55000';
  end if;
  if exists (select 1 from public.game_players where franchise_id = v_f and status = 'pack') then
    raise exception 'open pack on the table: keep a man from it, or pass on it' using errcode = '55000';
  end if;
  perform public.franchise_packs_sync(v_f);
  v_rank := coalesce(f.rank_claimed, 0) + 1;
  select * into pk from public.franchise_packs
   where franchise_id = v_f and kind = 'gridiron_cache' and source_key = v_rank::text;
  if not found then raise exception 'the rank''s pack is missing' using errcode = 'P0002'; end if;
  v_ovr := (public.franchise_team_rating(v_f)->>'overall')::int;
  b := public.franchise_pack_band(v_f, 'gridiron_cache');
  v_men := public.franchise_pack_generate(v_f, pk.id);
  update public.franchises set rank_claimed = v_rank, updated_at = now() where id = v_f;
  v_cp := public.franchise_rank_coach_points(v_rank);
  perform public.franchise_credit(v_f, 'cp', v_cp, 'pack', v_rank::text, 'Rank ' || v_rank || ': the building');
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'pack', v_rank::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('rank', v_rank, 'kind', 'gridiron_cache', 'pack_id', pk.id, 'team_overall', v_ovr,
            'low', (b->>'low')::int, 'high', (b->>'high')::int,
            'edge', public.franchise_rank_edge(v_rank), 'coach_points', v_cp, 'pity', coalesce((b->'pity'->>'active')::boolean, false),
            'men', (select jsonb_agg(jsonb_build_object('name', m->>'first_name' || ' ' || (m->>'last_name'), 'position', m->>'position',
                        'overall', (m->>'overall')::int, 'tier', m->>'tier')) from jsonb_array_elements(v_men) m),
            'version', public.franchise_pack_defs()->>'version'))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_f, 'pack_first', v_real, jsonb_build_object('rank', v_rank)) then v_new := array_append(v_new, 'pack_first'); end if;
  if v_rank >= 10 and public.franchise_award(v_f, 'pack_ten', v_real, jsonb_build_object('rank', v_rank)) then v_new := array_append(v_new, 'pack_ten'); end if;
  if v_rank >= 10 and public.franchise_award(v_f, 'rank_ten', v_real, jsonb_build_object('rank', v_rank)) then v_new := array_append(v_new, 'rank_ten'); end if;
  if v_rank >= 25 and public.franchise_award(v_f, 'rank_25', v_real, jsonb_build_object('rank', v_rank)) then v_new := array_append(v_new, 'rank_25'); end if;
  return jsonb_build_object('ok', true, 'rank', v_rank, 'players', v_men,
    'range', jsonb_build_array((b->>'low')::int, (b->>'high')::int), 'team_overall', v_ovr, 'coach_points', v_cp,
    'keep', (cfg->>'pack_keep')::int, 'achievements', to_jsonb(v_new),
    'pack', jsonb_build_object('id', pk.id, 'kind', pk.kind, 'name', public.franchise_pack_def(pk.kind)->>'name',
                               'source', pk.source, 'band', b, 'keep', (public.franchise_pack_def(pk.kind)->>'keep')::int),
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- OPEN ONE PACK, BY ID. Any kind the caller holds. A rank's cache must be
-- opened in rank order (the earliest sealed one first) and goes through the
-- rank door above, so a rank is still spent exactly once.
create or replace function public.franchise_pack_open_id(p_pack uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; pk public.franchise_packs%rowtype; b jsonb; v_men jsonb;
  v_new text[] := '{}'; v_real integer := public.games_season_of(now()); d jsonb;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  perform public.franchise_packs_sync(v_f);
  select * into pk from public.franchise_packs where id = p_pack and franchise_id = v_f for update;
  if not found then raise exception 'that pack is not yours' using errcode = 'P0002'; end if;
  if pk.status <> 'sealed' then raise exception 'that pack is already open' using errcode = '55000'; end if;
  if exists (select 1 from public.game_players where franchise_id = v_f and status = 'pack') then
    raise exception 'open pack on the table: keep a man from it, or pass on it' using errcode = '55000';
  end if;
  if pk.kind = 'gridiron_cache' then
    if pk.source_key::int <> coalesce(f.rank_claimed, 0) + 1 then
      raise exception 'open rank % first', coalesce(f.rank_claimed, 0) + 1 using errcode = '55000';
    end if;
    return public.franchise_pack_open(p_secret);
  end if;
  d := public.franchise_pack_def(pk.kind);
  b := public.franchise_pack_band(v_f, pk.kind);
  v_men := public.franchise_pack_generate(v_f, pk.id);
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'pack', pk.kind || ':' || pk.source_key, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('kind', pk.kind, 'pack_id', pk.id, 'source', pk.source, 'team_overall', (b->>'team_overall')::int,
            'low', (b->>'low')::int, 'high', (b->>'high')::int, 'guarantee', b->>'guarantee',
            'men', (select jsonb_agg(jsonb_build_object('name', m->>'first_name' || ' ' || (m->>'last_name'), 'position', m->>'position',
                        'overall', (m->>'overall')::int, 'tier', m->>'tier')) from jsonb_array_elements(v_men) m),
            'version', public.franchise_pack_defs()->>'version'))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_f, 'pack_first', v_real, jsonb_build_object('kind', pk.kind)) then v_new := array_append(v_new, 'pack_first'); end if;
  return jsonb_build_object('ok', true, 'players', v_men,
    'range', jsonb_build_array((b->>'low')::int, (b->>'high')::int), 'team_overall', (b->>'team_overall')::int,
    'keep', (d->>'keep')::int, 'achievements', to_jsonb(v_new),
    'pack', jsonb_build_object('id', pk.id, 'kind', pk.kind, 'name', d->>'name', 'source', pk.source, 'band', b, 'keep', (d->>'keep')::int),
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- KEEP ONE. He joins the roster at the bottom of his position's chart. A pack
-- that lets you keep two (the Championship Vault) leaves the others on the
-- table until the second is kept; otherwise the rest are passed over and
-- stay on the record as men you turned down.
create or replace function public.franchise_pack_keep(p_player uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; p public.game_players%rowtype; pk public.franchise_packs%rowtype;
  m jsonb := public.franchise_market(); v_active integer; v_depth integer; v_passed integer := 0; v_keep integer := 1; v_kept integer;
  v_left integer; v_ids uuid[]; v_sp integer := 0;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into f from public.franchises where id = v_f for update;
  select * into p from public.game_players where id = p_player and franchise_id = v_f and status = 'pack' for update;
  if not found then raise exception 'that man is not in an open pack of yours' using errcode = 'P0002'; end if;
  select count(*) into v_active from public.game_players where franchise_id = v_f and status = 'active';
  if v_active >= (m->>'roster_max')::int then
    raise exception 'the roster is full at %: release a player first', (m->>'roster_max')::int using errcode = '55000';
  end if;
  if p.pack_id is not null then
    select * into pk from public.franchise_packs where id = p.pack_id for update;
    if found then v_keep := coalesce((public.franchise_pack_def(pk.kind)->>'keep')::int, 1); end if;
  end if;

  select coalesce(max(depth), 0) + 1 into v_depth from public.game_players
   where franchise_id = v_f and position = p.position and status = 'active';
  update public.game_players
     set status = 'active', depth = v_depth,
         jersey = public.franchise_free_number(v_f, p.position, p.id::text),
         acquired_source = 'pack', acquired_season = public.games_season_of(now()),
         acquired_detail = coalesce(acquired_detail, 'Pack'),
         updated_at = now()
   where id = p.id;
  -- how many this pack has given up so far, and whether it is spent
  select count(*) into v_kept from public.game_players where franchise_id = v_f and pack_id = p.pack_id and status = 'active';
  select count(*) into v_left from public.game_players where franchise_id = v_f and status = 'pack';
  if p.pack_id is null or v_kept >= v_keep or v_left = 0 then
    with moved as (
      update public.game_players set status = 'passed', updated_at = now()
       where franchise_id = v_f and status = 'pack' and id <> p.id returning id)
    select array_agg(id) into v_ids from moved;
    v_passed := coalesce(array_length(v_ids, 1), 0);
    v_sp := public.franchise_pack_pass_credit(v_f, p.pack_id, v_ids);
    if p.pack_id is not null then
      update public.franchise_packs set status = 'done', done_at = now(),
             contents = contents || jsonb_build_object('kept', (select jsonb_agg(id) from public.game_players where pack_id = p.pack_id and status = 'active'))
       where id = p.pack_id;
    end if;
  end if;

  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'signing', p.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position,
            'overall', p.overall, 'potential', p.potential, 'cost', 0, 'currency', 'pack',
            'pack_rank', p.pack_rank, 'pack_kind', pk.kind, 'passed', v_passed, 'passed_sp', v_sp))
  on conflict (franchise_id, kind, key) do nothing;

  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'player', public.franchise_prospect_json(p),
    'passed', v_passed, 'sp', v_sp, 'roster_active', v_active + 1,
    'keep_left', case when p.pack_id is null then 0 else greatest(0, v_keep - v_kept) end,
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- WHAT A PASSED MAN IS WORTH. Never silently gone: a man passed over is
-- scouted, and the department books scouting points by his tier — the table
-- in franchise_pack_defs()->'pass_sp', so the page prints what is paid.
create or replace function public.franchise_pass_sp(p_overall integer)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select coalesce((public.franchise_pack_defs()->'pass_sp'->>public.franchise_card_tier(p_overall))::int, 0);
$$;
-- Book the pass for the men of one pack: one ledger row per pack, so a
-- replay pays nothing twice. Returns the points booked.
create or replace function public.franchise_pack_pass_credit(p_franchise uuid, p_pack uuid, p_ids uuid[])
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sp integer;
begin
  if p_ids is null or array_length(p_ids, 1) is null then return 0; end if;
  select coalesce(sum(public.franchise_pass_sp(p.overall)), 0) into v_sp
    from public.game_players p where p.id = any(p_ids) and p.franchise_id = p_franchise;
  if v_sp > 0 then
    perform public.franchise_credit(p_franchise, 'sp', v_sp, 'pack_pass', coalesce(p_pack::text, p_ids[1]::text),
      array_length(p_ids, 1) || ' passed over, scouted');
  end if;
  return v_sp;
end;
$$;
revoke all on function public.franchise_pack_pass_credit(uuid, uuid, uuid[]) from public, anon, authenticated;

-- PASS ON THE WHOLE PACK. The rank (or whatever earned it) is spent either
-- way, which is what makes it a real decision rather than a free re-roll.
-- The men passed over are scouted: their value comes back as points.
create or replace function public.franchise_pack_pass(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_n integer; v_pk uuid; v_ids uuid[]; v_sp integer := 0;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select id into v_pk from public.franchise_packs where franchise_id = v_f and status = 'open' order by opened_at desc limit 1;
  update public.franchise_packs set status = 'done', done_at = now()
   where franchise_id = v_f and status = 'open';
  with moved as (
    update public.game_players set status = 'passed', updated_at = now()
     where franchise_id = v_f and status = 'pack' returning id)
  select array_agg(id) into v_ids from moved;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then raise exception 'no pack on the table' using errcode = 'P0002'; end if;
  v_sp := public.franchise_pack_pass_credit(v_f, v_pk, v_ids);
  return jsonb_build_object('ok', true, 'passed', v_n, 'sp', v_sp,
    'rank_report', public.franchise_rank_report(v_f), 'totals', public.franchise_totals(v_f));
end;
$$;

-- THE VAULT'S BOARD: every sealed pack with its odds, the one on the table
-- with its men, the men kept from packs, and the last packs opened. One read.
create or replace function public.franchise_packs_board(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; rep jsonb; v_ovr integer; v_active integer; v_open public.franchise_packs%rowtype;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  perform public.franchise_packs_sync(f.id);
  rep := public.franchise_rank_report(f.id);
  v_ovr := (public.franchise_team_rating(f.id)->>'overall')::int;
  select count(*) into v_active from public.game_players where franchise_id = f.id and status = 'active';
  select * into v_open from public.franchise_packs where franchise_id = f.id and status = 'open' order by opened_at desc limit 1;
  return jsonb_build_object(
    'version', public.franchise_pack_defs()->>'version',
    'defs', public.franchise_pack_defs(),
    'rank', rep, 'team_overall', v_ovr,
    'roster', jsonb_build_object('active', v_active, 'max', (public.franchise_market()->>'roster_max')::int,
      'room', greatest(0, (public.franchise_market()->>'roster_max')::int - v_active)),
    'pity', public.franchise_pack_band(f.id, 'gridiron_cache')->'pity',
    -- sealed, oldest first, a rank's caches in rank order; every one with the
    -- odds it would open at right now
    'sealed', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'kind', k.kind, 'name', public.franchise_pack_def(k.kind)->>'name',
                 'art', public.franchise_pack_def(k.kind)->>'art', 'source', k.source, 'granted_at', k.granted_at,
                 'size', (public.franchise_pack_def(k.kind)->>'size')::int, 'keep', (public.franchise_pack_def(k.kind)->>'keep')::int,
                 'odds', public.franchise_pack_odds(f.id, k.kind),
                 'next', k.kind = 'gridiron_cache' and k.source_key::int = coalesce(f.rank_claimed, 0) + 1)
                 order by case when k.kind = 'gridiron_cache' then k.source_key::int else 0 end, k.granted_at)
               from public.franchise_packs k where k.franchise_id = f.id and k.status = 'sealed'), '[]'::jsonb),
    'open', case when v_open.id is null then null else jsonb_build_object(
      'id', v_open.id, 'kind', v_open.kind, 'name', public.franchise_pack_def(v_open.kind)->>'name',
      'art', public.franchise_pack_def(v_open.kind)->>'art', 'source', v_open.source, 'opened_at', v_open.opened_at,
      'keep', (public.franchise_pack_def(v_open.kind)->>'keep')::int,
      'kept', (select count(*) from public.game_players p where p.pack_id = v_open.id and p.status = 'active'),
      'band', v_open.contents->'band',
      'men', coalesce((select jsonb_agg(public.franchise_prospect_json(p) || public.franchise_profile_of(p) order by p.overall desc)
                        from public.game_players p where p.franchise_id = f.id and p.status = 'pack'), '[]'::jsonb)) end,
    'kept', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name,
              'position', p.position, 'overall', p.overall, 'potential', p.potential, 'rank', p.pack_rank,
              'tier', public.franchise_card_tier(p.overall), 'kind', k.kind, 'kind_name', public.franchise_pack_def(k.kind)->>'name',
              'acquired_season', p.acquired_season)
              order by p.updated_at desc)
              from public.game_players p left join public.franchise_packs k on k.id = p.pack_id
             where p.franchise_id = f.id and p.acquired_source = 'pack' and p.status = 'active'), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('key', a.key, 'at', a.created_at, 'detail', a.detail) order by a.created_at desc)
                 from (select * from public.franchise_activity where franchise_id = f.id and kind = 'pack' order by created_at desc limit 12) a), '[]'::jsonb),
    'resources', public.franchise_totals(f.id));
end;
$$;

-- ── THE CARD REMEMBERS: history, by trigger ───────────────────────────────
-- Every change that matters to a card leaves a line, whoever made it. A
-- BEFORE trigger writes NEW.history and cannot recurse; the list is capped.
create or replace function public.franchise_card_history_trg()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_season integer; note jsonb; notes jsonb := '[]'::jsonb;
begin
  select max(number) into v_season from public.franchise_seasons where franchise_id = NEW.franchise_id;
  if TG_OP = 'INSERT' then
    NEW.history := jsonb_build_array(jsonb_build_object('kind', 'generated', 'at', now(), 'season', v_season,
      'source', NEW.acquired_source, 'detail', NEW.acquired_detail, 'overall', NEW.overall, 'potential', NEW.potential, 'age', NEW.age));
    return NEW;
  end if;
  if NEW.status = 'active' and OLD.status <> 'active' then
    notes := notes || jsonb_build_object('kind', 'acquired', 'at', now(), 'season', v_season,
      'source', NEW.acquired_source, 'detail', NEW.acquired_detail, 'overall', NEW.overall, 'jersey', NEW.jersey);
  end if;
  if NEW.franchise_id is distinct from OLD.franchise_id then
    notes := notes || jsonb_build_object('kind', 'traded', 'at', now(), 'season', v_season,
      'from', OLD.franchise_id, 'to', NEW.franchise_id, 'overall', NEW.overall);
  end if;
  if NEW.overall <> OLD.overall or NEW.ratings <> OLD.ratings then
    notes := notes || jsonb_build_object('kind', 'ratings', 'at', now(), 'season', v_season,
      'before', OLD.overall, 'after', NEW.overall, 'age', NEW.age, 'ratings', NEW.ratings);
  end if;
  if NEW.potential <> OLD.potential and NEW.overall = OLD.overall then
    notes := notes || jsonb_build_object('kind', 'potential', 'at', now(), 'season', v_season,
      'before', OLD.potential, 'after', NEW.potential);
  end if;
  if NEW.status = 'retired' and OLD.status <> 'retired' then
    notes := notes || jsonb_build_object('kind', 'retired', 'at', now(), 'season', v_season,
      'age', NEW.age, 'overall', NEW.overall, 'games', coalesce((NEW.career_stats->>'games')::int, 0));
  end if;
  if NEW.status = 'released' and OLD.status <> 'released' then
    notes := notes || jsonb_build_object('kind', 'released', 'at', now(), 'season', v_season, 'overall', NEW.overall);
  end if;
  if jsonb_array_length(notes) > 0 then
    NEW.history := coalesce(NEW.history, '[]'::jsonb) || notes;
    -- capped: the first line (how he arrived) and the last seventy-nine
    if jsonb_array_length(NEW.history) > 80 then
      select jsonb_build_array(NEW.history->0) || coalesce(jsonb_agg(e order by i), '[]'::jsonb) into NEW.history
        from jsonb_array_elements(NEW.history) with ordinality t(e, i)
       where i > jsonb_array_length(NEW.history) - 79;
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists franchise_card_history on public.game_players;
create trigger franchise_card_history before insert or update of status, franchise_id, overall, ratings, potential
  on public.game_players for each row execute function public.franchise_card_history_trg();

-- THE CARD, WHOLE: what a profile page shows. Your own man, or one on your
-- table. The market and the trade floor carry their own views of a man who
-- is not yours.
create or replace function public.franchise_card(p_player uuid, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); p public.game_players%rowtype; k public.franchise_packs%rowtype;
begin
  if v_f is null then return null; end if;
  select * into p from public.game_players where id = p_player and franchise_id = v_f;
  if not found then return null; end if;
  if p.pack_id is not null then select * into k from public.franchise_packs where id = p.pack_id; end if;
  return public.franchise_prospect_json(p) || public.franchise_profile_of(p) || jsonb_build_object(
    'history', p.history, 'career_stats', p.career_stats, 'season_stats', p.season_stats, 'live_stats', p.live_stats,
    'acquired_season', p.acquired_season, 'retired_season', p.retired_season,
    'available', public.franchise_is_available(p.status, p.injured_until), 'injury', p.injury, 'injured_until', p.injured_until,
    'developed', p.developed, 'programs', p.programs,
    'pack', case when k.id is null then null else jsonb_build_object('id', k.id, 'kind', k.kind,
                'name', public.franchise_pack_def(k.kind)->>'name', 'source', k.source, 'opened_at', k.opened_at) end,
    -- HONOURS: a bowl won while he was on the roster. A badge the card keeps,
    -- derived from the record, never a change to what he was rolled at.
    'honours', coalesce((select jsonb_agg(jsonb_build_object('kind', 'champion', 'season', g.season_number,
                  'label', coalesce(g.opponent->>'bowl_name', 'The bowl') || ', Season ' || public.games_roman(g.season_number)) order by g.season_number)
                  from public.franchise_games g
                 where g.franchise_id = v_f and g.bowl and g.result = 'W'
                   and g.season_number >= coalesce(p.acquired_season, 0)
                   and (p.retired_season is null or g.season_number <= p.retired_season)), '[]'::jsonb),
    -- every man is one of one: there is no second print of him anywhere
    'edition', jsonb_build_object('serial', 1, 'of', 1, 'label', 'One of one'));
end;
$$;

grant execute on function public.franchise_pack_defs() to anon, authenticated;
grant execute on function public.franchise_pack_def(text) to anon, authenticated;
grant execute on function public.franchise_pack_open_id(uuid, text) to anon, authenticated;
grant execute on function public.franchise_packs_board(text) to anon, authenticated;
grant execute on function public.franchise_card(uuid, text) to anon, authenticated;
revoke all on function public.franchise_pack_grant(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.franchise_packs_sync(uuid) from public, anon, authenticated;
revoke all on function public.franchise_pack_band(uuid, text) from public, anon, authenticated;
revoke all on function public.franchise_pack_odds(uuid, text) from public, anon, authenticated;
revoke all on function public.franchise_pack_positions(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.franchise_pack_generate(uuid, uuid) from public, anon, authenticated;
revoke all on function public.franchise_card_history_trg() from public, anon, authenticated;

select public.games_schema_note('franchise', 18, 'the Vault: packs you hold, odds you can read, and a card that remembers');
commit;

-- ===========================================================================
-- PHASE 19 — THE LINEUP, CHEMISTRY, AND THE EXCHANGE
--
-- Three things a roster page owed the player.
--
-- CHEMISTRY (chemistry_v1). The column on game_players has sat at fifty since
-- the day it was made and nothing read it. Chemistry is not a number a man
-- carries around; it is a property of the ELEVEN who take the field
-- together, so it is derived here from the starting lineup and nothing else:
-- how the starters' archetypes fit the scheme the franchise runs, how many
-- games the starters have played for this franchise, whether whole units
-- (the line, the secondary, the passing game) have grown up together, how
-- many new arrivals are still learning the calls, and who among them leads.
-- It moves the simulation the way every trait does — through
-- franchise_trait_effects, a quarter of a point of rating per point — so a
-- churned roster plays a little below its paper and a settled one a little
-- above, and the lineup page can say exactly why.
--
-- THE LINEUP. franchise_set_starter already swaps one man into one slot.
-- franchise_lineup_best orders every position by who is best and fit, in one
-- call, for the player who wants the server's answer rather than eleven taps.
--
-- THE EXCHANGE (exchange_v1). The first market between franchises. A seller
-- lists one of his own active men at a price of his choosing, inside
-- published bounds; the man keeps playing for him until he is sold. A buyer
-- sends a LISTING ID and nothing else — never a price, never a balance —
-- and the server decides, under row locks taken in a fixed order: the
-- listing is still open, the man is still where he was listed, both rosters
-- stay legal, the buyer can pay from the balance the ledger says he has.
-- Five per cent of the price is the house's fee and leaves the economy; the
-- rest reaches the seller as one ledger row keyed by the listing, so nothing
-- can pay twice. Every sale is kept, and the comparable sales for a position
-- and an overall are printed beside the asking price, so a price is a
-- decision made with the record in view. Nothing here can be bought with
-- money: Credits are earned by playing and by nothing else.
-- ===========================================================================

begin;

-- ── CHEMISTRY ──────────────────────────────────────────────────────────────
create or replace function public.franchise_chemistry_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'chemistry_v1',
    -- the score is 50 plus per_point for every point of raw chemistry, held to 0..100
    'per_point', 2,
    -- and the effect on the rating, in the units a trait uses (a quarter reaches the rating), is
    -- (score - 50) / 50 * scale — so ±8 here is ±2 on the field
    'scale', 8,
    -- a starter who has played this many games for the franchise counts as settled
    'tenure_games', 8,
    -- a man who arrived by market, trade, free agency, pack or draft and has played fewer than this is still learning the calls
    'new_games', 3, 'new_cap', 4,
    -- whole units that have grown up together
    'core', jsonb_build_object('line', 2, 'secondary', 2, 'passing', 2),
    'sides', jsonb_build_object('offense', jsonb_build_array('QB','RB','WR','TE','OL'), 'defense', jsonb_build_array('DL','LB','CB','S')),
    'fit_range', jsonb_build_array(-2, 2));
$$;

-- WHICH ARCHETYPES A SCHEME LOVES. Per scheme, per position, the archetype
-- and how well it fits, -2 to +2. Anything unlisted is 0: a fine player in
-- a scheme that is neither built for him nor against him.
create or replace function public.franchise_scheme_fit()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select '{
    "offense": {
      "air_raid":   {"QB":{"Gunslinger":2,"Field General":1,"Game Manager":-1},
                     "WR":{"Deep Threat":2,"Route Runner":1,"Route Technician":1,"Slot Weapon":1,"Possession":-1,"Possession Receiver":-1},
                     "TE":{"Seam Stretcher":2,"Move TE":1,"In-Line":-1},
                     "RB":{"Receiving Back":2,"Power Back":-1},
                     "OL":{"Pass Protector":2,"Road Grader":-1}},
      "spread":     {"QB":{"Scrambler":2,"Improviser":2,"Game Manager":-1},
                     "WR":{"Slot Weapon":2,"Deep Threat":1,"Route Runner":1},
                     "TE":{"Move TE":2,"In-Line":-1},
                     "RB":{"Elusive Back":2,"Receiving Back":1,"Power Back":-1},
                     "OL":{"Technician":2,"Pass Protector":1}},
      "pro_style":  {"QB":{"Field General":2,"Game Manager":1,"Scrambler":-1},
                     "WR":{"Possession":1,"Possession Receiver":1,"Route Runner":1,"Route Technician":1},
                     "TE":{"In-Line":1,"Move TE":1},
                     "RB":{"Workhorse":2,"Power Back":1},
                     "OL":{"Technician":1,"Pass Protector":1,"Road Grader":1}},
      "power_run":  {"QB":{"Game Manager":2,"Field General":1,"Gunslinger":-1},
                     "WR":{"Physical Target":2,"Possession":1,"Possession Receiver":1,"Deep Threat":-1},
                     "TE":{"In-Line":2,"Seam Stretcher":-1},
                     "RB":{"Power Back":2,"Workhorse":2,"Elusive Back":-1},
                     "OL":{"Road Grader":2,"Pass Protector":-1}},
      "option":     {"QB":{"Scrambler":2,"Improviser":1,"Gunslinger":-1,"Game Manager":-1},
                     "WR":{"Deep Threat":1,"Physical Target":1},
                     "TE":{"In-Line":1,"Move TE":1},
                     "RB":{"Elusive Back":2,"Workhorse":1},
                     "OL":{"Road Grader":2,"Technician":1,"Pass Protector":-1}},
      "west_coast": {"QB":{"Game Manager":2,"Field General":1,"Gunslinger":-1},
                     "WR":{"Route Runner":2,"Route Technician":2,"Possession":1,"Slot Weapon":1,"Deep Threat":-1},
                     "TE":{"Move TE":2,"Seam Stretcher":1},
                     "RB":{"Receiving Back":2,"Elusive Back":1},
                     "OL":{"Technician":2,"Pass Protector":1}}
    },
    "defense": {
      "four_three":      {"DL":{"Edge Rusher":1,"Run Stopper":1,"Balanced":1,"Hybrid":1},
                          "LB":{"Run Stopper":1,"Hybrid":1},
                          "CB":{"Coverage":1,"Hybrid":1},
                          "S":{"Coverage":1,"Run Stopper":1}},
      "three_four":      {"DL":{"Run Stopper":2,"Power Rusher":1,"Speed Rusher":-1},
                          "LB":{"Hybrid":2,"Coverage":1,"Run Stopper":1},
                          "CB":{"Coverage":1},
                          "S":{"Ball Hawk":1,"Coverage":1}},
      "press_man":       {"DL":{"Edge Rusher":2,"Speed Rusher":2,"Run Stopper":-1},
                          "LB":{"Coverage":1},
                          "CB":{"Shutdown":2,"Press Specialist":2,"Zone Specialist":-2,"Ball Hawk":-1},
                          "S":{"Coverage":2,"Run Stopper":-1}},
      "zone":            {"DL":{"Hybrid":1,"Balanced":1,"Run Stopper":1},
                          "LB":{"Coverage":2,"Hybrid":1,"Run Stopper":-1},
                          "CB":{"Zone Specialist":2,"Ball Hawk":2,"Press Specialist":-2},
                          "S":{"Ball Hawk":2,"Coverage":1}},
      "blitz_heavy":     {"DL":{"Speed Rusher":2,"Edge Rusher":2,"Power Rusher":1,"Run Stopper":-1},
                          "LB":{"Run Stopper":1,"Hybrid":2,"Coverage":-1},
                          "CB":{"Shutdown":1,"Press Specialist":1,"Coverage":1},
                          "S":{"Run Stopper":1,"Ball Hawk":1}},
      "bend_dont_break": {"DL":{"Run Stopper":2,"Balanced":1,"Speed Rusher":-1},
                          "LB":{"Coverage":2,"Run Stopper":1},
                          "CB":{"Zone Specialist":1,"Coverage":2,"Press Specialist":-1},
                          "S":{"Coverage":2,"Ball Hawk":1}}
    }
  }'::jsonb;
$$;

-- THE CHEMISTRY OF THE ELEVEN WHO PLAY. Internal. The starters are the men
-- franchise_pos_avg counts — fit, in depth order, as many as the position
-- starts — so the rating and the chemistry describe the same lineup.
create or replace function public.franchise_chemistry(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; rules jsonb := public.franchise_chemistry_rules(); fit jsonb := public.franchise_scheme_fit();
  st record; side text; v_fit numeric; v_games integer; v_ten boolean; v_new boolean; v_lead boolean; v_scheme text;
  o_fit numeric := 0; d_fit numeric := 0; o_ten integer := 0; d_ten integer := 0; o_new integer := 0; d_new integer := 0;
  o_lead integer := 0; d_lead integer := 0; o_core numeric := 0; d_core numeric := 0; o_n integer := 0; d_n integer := 0;
  ol_n integer := 0; ol_ten integer := 0; sec_n integer := 0; sec_ten integer := 0; pass_n integer := 0; pass_ten integer := 0;
  o_raw numeric; d_raw numeric; o_score integer; d_score integer; o_eff numeric; d_eff numeric;
  o_men jsonb := '[]'::jsonb; d_men jsonb := '[]'::jsonb; o_units jsonb := '[]'::jsonb; d_units jsonb := '[]'::jsonb;
  per_point numeric := (rules->>'per_point')::numeric; scale numeric := (rules->>'scale')::numeric;
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then return null; end if;
  for st in
    with s as (
      select p.id, p.first_name, p.last_name, p.position, p.archetype, p.overall, p.depth, p.acquired_source, p.career_stats, p.traits,
             row_number() over (partition by p.position order by p.depth, p.overall desc) as rn,
             (select (x->>'starters')::int from jsonb_array_elements(public.franchise_pool_plan()) x where x->>'pos' = p.position) as n
        from public.game_players p
       where p.franchise_id = p_franchise and public.franchise_is_available(p.status, p.injured_until))
    select * from s where rn <= n and position not in ('K', 'P')
    order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S'], position), rn
  loop
    side := case when st.position in ('QB','RB','WR','TE','OL') then 'offense' else 'defense' end;
    v_scheme := case side when 'offense' then f.offense else f.defense end;
    v_fit := coalesce((fit -> side -> v_scheme -> st.position ->> st.archetype)::numeric, 0);
    v_games := coalesce((st.career_stats->>'games')::int, 0);
    v_ten := v_games >= (rules->>'tenure_games')::int;
    v_new := st.acquired_source in ('market','trade','free_agent','pack','draft') and v_games < (rules->>'new_games')::int;
    v_lead := exists (select 1 from jsonb_array_elements(coalesce(st.traits, '[]'::jsonb)) t where (t->'effect') ? 'chemistry');
    if side = 'offense' then
      o_n := o_n + 1; o_fit := o_fit + v_fit; o_ten := o_ten + v_ten::int; o_new := o_new + v_new::int; o_lead := o_lead + v_lead::int;
      if st.position = 'OL' then ol_n := ol_n + 1; ol_ten := ol_ten + v_ten::int; end if;
      if st.position in ('QB','WR') then pass_n := pass_n + 1; pass_ten := pass_ten + v_ten::int; end if;
      o_men := o_men || jsonb_build_object('id', st.id, 'name', st.first_name || ' ' || st.last_name, 'position', st.position,
        'archetype', st.archetype, 'fit', v_fit, 'games', v_games, 'settled', v_ten, 'new', v_new, 'leader', v_lead);
    else
      d_n := d_n + 1; d_fit := d_fit + v_fit; d_ten := d_ten + v_ten::int; d_new := d_new + v_new::int; d_lead := d_lead + v_lead::int;
      if st.position in ('CB','S') then sec_n := sec_n + 1; sec_ten := sec_ten + v_ten::int; end if;
      d_men := d_men || jsonb_build_object('id', st.id, 'name', st.first_name || ' ' || st.last_name, 'position', st.position,
        'archetype', st.archetype, 'fit', v_fit, 'games', v_games, 'settled', v_ten, 'new', v_new, 'leader', v_lead);
    end if;
  end loop;
  -- whole units that have grown up together
  if ol_n = 5 and ol_ten = 5 then o_core := o_core + (rules->'core'->>'line')::numeric; end if;
  if pass_n = 4 and pass_ten = 4 then o_core := o_core + (rules->'core'->>'passing')::numeric; end if;
  if sec_n = 4 and sec_ten = 4 then d_core := d_core + (rules->'core'->>'secondary')::numeric; end if;
  o_units := jsonb_build_array(
    jsonb_build_object('key', 'line', 'name', 'The line', 'settled', ol_ten, 'of', ol_n, 'on', ol_n = 5 and ol_ten = 5),
    jsonb_build_object('key', 'passing', 'name', 'The passing game', 'settled', pass_ten, 'of', pass_n, 'on', pass_n = 4 and pass_ten = 4));
  d_units := jsonb_build_array(
    jsonb_build_object('key', 'secondary', 'name', 'The secondary', 'settled', sec_ten, 'of', sec_n, 'on', sec_n = 4 and sec_ten = 4));
  -- the arithmetic, printed with the result so the page can show every term
  o_raw := o_fit + o_ten + o_core - least(o_new, (rules->>'new_cap')::int);
  d_raw := d_fit + d_ten + d_core - least(d_new, (rules->>'new_cap')::int);
  o_score := greatest(0, least(100, round(50 + per_point * o_raw)::int));
  d_score := greatest(0, least(100, round(50 + per_point * d_raw)::int));
  o_eff := round((o_score - 50) / 50.0 * scale, 2);
  d_eff := round((d_score - 50) / 50.0 * scale, 2);
  return jsonb_build_object(
    'version', rules->>'version',
    'scheme', jsonb_build_object('offense', f.offense, 'defense', f.defense),
    'offense', jsonb_build_object('score', o_score, 'effect', o_eff, 'raw', o_raw, 'fit', o_fit, 'settled', o_ten, 'core', o_core,
                                  'new', o_new, 'leaders', o_lead, 'starters', o_n, 'men', o_men, 'units', o_units),
    'defense', jsonb_build_object('score', d_score, 'effect', d_eff, 'raw', d_raw, 'fit', d_fit, 'settled', d_ten, 'core', d_core,
                                  'new', d_new, 'leaders', d_lead, 'starters', d_n, 'men', d_men, 'units', d_units),
    'team', round((o_score + d_score) / 2.0)::int,
    'rules', rules);
end;
$$;

-- WHAT THE STARTERS' TRAITS ADD UP TO, AND NOW THEIR CHEMISTRY. Redefined
-- from Phase 2 with one addition: the lineup's chemistry effect rides on the
-- same offense and defense terms a trait does, so franchise_sim and
-- franchise_sim_versus feel it without a line of either changing.
create or replace function public.franchise_trait_effects(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare base jsonb; ch jsonb;
begin
  with st as (
    select p.position, e.key, (e.value)::numeric as v
    from public.game_players p
    cross join lateral jsonb_array_elements(p.traits) t
    cross join lateral jsonb_each_text(t -> 'effect') e
    where p.franchise_id = p_franchise and public.franchise_is_available(p.status, p.injured_until)
      and p.depth <= case p.position when 'WR' then 3 when 'OL' then 5 when 'DL' then 4 when 'LB' then 3
                                     when 'CB' then 2 when 'S' then 2 else 1 end
  )
  select jsonb_build_object(
    'offense', coalesce(sum(v) filter (where key in ('pressure_resist','fatigue_resist','breakaway','drop_resist','red_zone','pass_block_anchor','run_block_power')), 0)
             + coalesce(sum(v) filter (where key = 'chemistry' and position in ('QB','RB','WR','TE','OL')), 0),
    'defense', coalesce(sum(v) filter (where key in ('edge_rush','run_stop','man_coverage','interception')), 0)
             + coalesce(sum(v) filter (where key = 'chemistry' and position in ('DL','LB','CB','S')), 0),
    'special', coalesce(sum(v) filter (where key in ('clutch_kick','punt_placement')), 0),
    'late_offense', coalesce(sum(v) filter (where key = 'late_game_passing'), 0),
    'late_defense', coalesce(sum(v) filter (where key = 'late_game_pressure'), 0),
    'takeaway', coalesce(sum(v) filter (where key = 'interception'), 0),
    'clutch', coalesce(sum(v) filter (where key = 'clutch_kick'), 0),
    'edge_rush', coalesce(sum(v) filter (where key = 'edge_rush'), 0),
    'drop_resist', coalesce(sum(v) filter (where key = 'drop_resist'), 0),
    'preparation', coalesce(sum(v) filter (where key = 'preparation'), 0),
    'count', count(*))
    into base from st;
  ch := public.franchise_chemistry(p_franchise);
  if ch is null then return base; end if;
  return base || jsonb_build_object(
    'traits_offense', (base->>'offense')::numeric, 'traits_defense', (base->>'defense')::numeric,
    'offense', (base->>'offense')::numeric + (ch->'offense'->>'effect')::numeric,
    'defense', (base->>'defense')::numeric + (ch->'defense'->>'effect')::numeric,
    'chemistry', jsonb_build_object('version', ch->>'version', 'team', ch->'team',
      'offense', ch->'offense'->'score', 'defense', ch->'defense'->'score',
      'offense_effect', ch->'offense'->'effect', 'defense_effect', ch->'defense'->'effect'));
end;
$$;

-- ── THE LINEUP ─────────────────────────────────────────────────────────────
create or replace function public.franchise_lineup_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'lineup_v1',
    'starters', jsonb_build_object('QB', 1, 'RB', 1, 'WR', 3, 'TE', 1, 'OL', 5, 'DL', 4, 'LB', 3, 'CB', 2, 'S', 2, 'K', 1, 'P', 1),
    'offense', jsonb_build_array('QB','RB','WR','TE','OL'), 'defense', jsonb_build_array('DL','LB','CB','S'), 'special', jsonb_build_array('K','P'),
    'best', 'the fit men first, then by overall; the hurt man keeps his card and loses his slot until he is back');
$$;

-- THE BEST LINEUP, in one call: every position ordered by availability then
-- overall. A hurt starter drops behind the fit men; his place comes back
-- when he does, if you ask again. Returns the roster.
create or replace function public.franchise_lineup_best(p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); r record; v_moved integer := 0;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  perform 1 from public.franchises where id = v_f for update;
  for r in
    select p.id, p.depth as was,
           row_number() over (partition by p.position
                              order by public.franchise_is_available(p.status, p.injured_until) desc, p.overall desc, p.depth, p.id) as d
      from public.game_players p where p.franchise_id = v_f and p.status = 'active'
  loop
    if r.was <> r.d then
      update public.game_players set depth = r.d, updated_at = now() where id = r.id;
      v_moved := v_moved + 1;
    end if;
  end loop;
  return public.franchise_roster(p_secret) || jsonb_build_object('moved', v_moved);
end;
$$;

-- ── THE EXCHANGE ───────────────────────────────────────────────────────────
create or replace function public.franchise_exchange_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'exchange_v1',
    'currency', 'tc',
    'fee_pct', 5,
    'min_price', 50, 'max_price', 50000,
    'max_open', 5,
    'expires_days', 7,
    'comps_days', 60, 'comps_band', 2, 'comps_shown', 12,
    'who', 'any franchise',
    'what', 'an active man of your own; he keeps playing for you until he is sold',
    'checks', jsonb_build_array(
      'the listing is still open and has not expired',
      'the man is still on the roster that listed him',
      'the seller keeps the floor and the starters a position needs',
      'the buyer has the room and the Credits the ledger says he has',
      'five per cent of the price is the fee and leaves the economy; the rest reaches the seller as one ledger row'));
$$;

create table if not exists public.franchise_listings (
  id            uuid primary key default gen_random_uuid(),
  franchise_id  uuid not null references public.franchises (id) on delete cascade,
  player_id     uuid not null references public.game_players (id) on delete cascade,
  price         integer not null check (price between 1 and 1000000),
  status        text not null default 'open' check (status in ('open', 'sold', 'withdrawn', 'expired')),
  reason        text,
  -- the man as he was listed: comps and the record read him from here, whatever he becomes later
  snapshot      jsonb not null default '{}'::jsonb,
  buyer_id      uuid references public.franchises (id) on delete set null,
  fee           integer,
  net           integer,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  closed_at     timestamptz
);
create unique index if not exists franchise_listings_one_open on public.franchise_listings (player_id) where status = 'open';
create index if not exists franchise_listings_open on public.franchise_listings (status, created_at desc);
create index if not exists franchise_listings_seller on public.franchise_listings (franchise_id, created_at desc);
create index if not exists franchise_listings_sold on public.franchise_listings ((snapshot->>'position'), closed_at desc) where status = 'sold';

alter table public.franchise_listings enable row level security;
drop policy if exists franchise_listings_party on public.franchise_listings;
create policy franchise_listings_party on public.franchise_listings for select
  using (public.franchise_is_mine(franchise_id) or public.franchise_is_mine(buyer_id));

alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release',
   'conf_joined','conf_season','conf_game','conf_win','conf_playoff','conf_title',
   'bowl_bid','injury','trade',
   'staff_hire','staff_promote','staff_fire',
   'program','pack',
   'exchange_list','exchange_sale','exchange_buy',
   'live_game','live_game_extra'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('exchange_first_sale', 'First Sale',     'Sold a player on the Exchange.', null, 130),
  ('exchange_first_buy',  'Exchange Buyer', 'Bought a player on the Exchange.', null, 131)
on conflict (id) do nothing;

-- the fee, rounded up: the house never rounds in its own favour by less
create or replace function public.franchise_exchange_fee(p_price integer)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select ceil(coalesce(p_price, 0) * (public.franchise_exchange_rules()->>'fee_pct')::numeric / 100.0)::int;
$$;

-- WHY A MAN CANNOT LEAVE, or null when he can. The same floor and starter
-- rules a release and a trade obey, asked at listing and again at sale.
create or replace function public.franchise_exchange_illegal(p_seller uuid, p_player uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.game_players%rowtype; mk jsonb := public.franchise_market(); n integer; starters integer; v_left integer;
begin
  select * into p from public.game_players where id = p_player;
  if not found or p.franchise_id is distinct from p_seller then return 'that player is not on your roster'; end if;
  if p.status <> 'active' then return 'only a man on the roster can be listed'; end if;
  select count(*) into n from public.game_players where franchise_id = p_seller and status = 'active';
  if n - 1 < (mk->>'roster_min')::int then return 'that would put your roster under ' || (mk->>'roster_min')::int; end if;
  select coalesce((x->>'starters')::int, 1) into starters from jsonb_array_elements(public.franchise_pool_plan()) x where x->>'pos' = p.position;
  select count(*) into v_left from public.game_players where franchise_id = p_seller and position = p.position and status = 'active' and id <> p.id;
  if v_left < starters then return 'that would leave you short at ' || p.position; end if;
  return null;
end;
$$;

-- CLOSE WHAT HAS LAPSED. Internal, called at the door of every read and
-- write: a listing past its date, or whose man has since left the roster
-- that listed him, is closed with the reason kept on it.
create or replace function public.franchise_exchange_sweep()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer := 0; m integer := 0;
begin
  update public.franchise_listings set status = 'expired', reason = 'the listing ran out', closed_at = now()
   where status = 'open' and expires_at < now();
  get diagnostics n = row_count;
  update public.franchise_listings l set status = 'expired', reason = 'the player left the roster', closed_at = now()
    from public.game_players p
   where l.player_id = p.id and l.status = 'open' and (p.franchise_id is distinct from l.franchise_id or p.status <> 'active');
  get diagnostics m = row_count;
  return n + m;
end;
$$;

-- a listing as the board shows it: the man, the price, the seller, the clock
create or replace function public.franchise_listing_json(l public.franchise_listings, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', l.id, 'price', l.price, 'status', l.status, 'reason', l.reason,
    'fee', public.franchise_exchange_fee(l.price), 'net', l.price - public.franchise_exchange_fee(l.price),
    'created_at', l.created_at, 'expires_at', l.expires_at, 'closed_at', l.closed_at,
    'mine', l.franchise_id = p_viewer,
    'seller', (select jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme)
                 from public.franchises f where f.id = l.franchise_id),
    'buyer', (select jsonb_build_object('name', f.name, 'city', f.city, 'abbr', f.abbr) from public.franchises f where f.id = l.buyer_id),
    'man', l.snapshot || coalesce((select jsonb_build_object('overall', p.overall, 'age', p.age, 'potential', p.potential,
                                            'available', public.franchise_is_available(p.status, p.injured_until))
                                     from public.game_players p where p.id = l.player_id and l.status = 'open'), '{}'::jsonb),
    'asking_reference', public.franchise_signing_cost((l.snapshot->>'overall')::int));
$$;

-- COMPARABLE SALES: what men like this one actually went for. Public
-- arithmetic on the record — the same window and band for everybody.
create or replace function public.franchise_exchange_comps(p_position text, p_overall integer)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rules jsonb := public.franchise_exchange_rules(); band integer := (rules->>'comps_band')::int; v jsonb; n integer; med numeric; lo integer; hi integer; v_open integer;
begin
  select count(*), percentile_cont(0.5) within group (order by price), min(price), max(price)
    into n, med, lo, hi
    from public.franchise_listings
   where status = 'sold' and closed_at >= now() - ((rules->>'comps_days')::int || ' days')::interval
     and snapshot->>'position' = p_position and (snapshot->>'overall')::int between p_overall - band and p_overall + band;
  select coalesce(jsonb_agg(jsonb_build_object('price', l.price, 'overall', (l.snapshot->>'overall')::int, 'tier', l.snapshot->>'tier',
             'age', (l.snapshot->>'age')::int, 'name', l.snapshot->>'name', 'sold_at', l.closed_at) order by l.closed_at desc), '[]'::jsonb)
    into v
    from (select * from public.franchise_listings
           where status = 'sold' and closed_at >= now() - ((rules->>'comps_days')::int || ' days')::interval
             and snapshot->>'position' = p_position and (snapshot->>'overall')::int between p_overall - band and p_overall + band
           order by closed_at desc limit (rules->>'comps_shown')::int) l;
  select count(*) into v_open from public.franchise_listings
   where status = 'open' and expires_at >= now() and snapshot->>'position' = p_position
     and (snapshot->>'overall')::int between p_overall - band and p_overall + band;
  return jsonb_build_object('position', p_position, 'overall', p_overall, 'band', band, 'days', (rules->>'comps_days')::int,
    'sold', n, 'median', case when n > 0 then round(med)::int end, 'low', lo, 'high', hi, 'open', v_open,
    'asking_reference', public.franchise_signing_cost(p_overall), 'sales', v);
end;
$$;

-- LIST A MAN. The seller's own price, inside the published bounds; the man
-- keeps playing for him until he is sold.
create or replace function public.franchise_exchange_list(p_player uuid, p_price integer, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); rules jsonb := public.franchise_exchange_rules(); p public.game_players%rowtype;
  v_why text; n integer; l public.franchise_listings%rowtype; v_new text[] := '{}';
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  perform public.franchise_exchange_sweep();
  perform 1 from public.franchises where id = v_f for update;
  if p_price is null or p_price < (rules->>'min_price')::int or p_price > (rules->>'max_price')::int then
    raise exception 'a price is between % and % Credits', (rules->>'min_price')::int, (rules->>'max_price')::int using errcode = '22023';
  end if;
  select count(*) into n from public.franchise_listings where franchise_id = v_f and status = 'open';
  if n >= (rules->>'max_open')::int then
    raise exception 'you can have % listings open at once', (rules->>'max_open')::int using errcode = '55000';
  end if;
  v_why := public.franchise_exchange_illegal(v_f, p_player);
  if v_why is not null then raise exception '%', v_why using errcode = '55000'; end if;
  select * into p from public.game_players where id = p_player for update;
  if exists (select 1 from public.franchise_listings where player_id = p.id and status = 'open') then
    raise exception 'he is already listed' using errcode = '55000';
  end if;
  insert into public.franchise_listings (franchise_id, player_id, price, snapshot, expires_at)
  values (v_f, p.id, p_price,
          public.franchise_prospect_json(p) || public.franchise_profile_of(p)
            || jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'tier', public.franchise_card_tier(p.overall)),
          now() + ((rules->>'expires_days')::int || ' days')::interval)
  returning * into l;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'exchange_list', l.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('listing', l.id, 'player', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
                             'overall', p.overall, 'price', p_price, 'currency', 'tc'))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true, 'listing', public.franchise_listing_json(l, v_f),
    'comps', public.franchise_exchange_comps(p.position, p.overall), 'achievements', to_jsonb(v_new));
end;
$$;

-- TAKE IT DOWN. Only the seller, only while it is open. Idempotent.
create or replace function public.franchise_exchange_withdraw(p_listing uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); l public.franchise_listings%rowtype;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into l from public.franchise_listings where id = p_listing and franchise_id = v_f for update;
  if not found then raise exception 'that listing is not yours' using errcode = 'P0002'; end if;
  if l.status = 'open' then
    update public.franchise_listings set status = 'withdrawn', reason = 'taken down by the seller', closed_at = now() where id = l.id returning * into l;
  end if;
  return jsonb_build_object('ok', true, 'listing', public.franchise_listing_json(l, v_f));
end;
$$;

-- BUY. A listing id and an identity: the server decides everything else,
-- under locks taken in one order so two buyers can never both win.
create or replace function public.franchise_exchange_buy(p_listing uuid, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b uuid := public.franchise_of(p_secret); rules jsonb := public.franchise_exchange_rules(); mk jsonb := public.franchise_market();
  l public.franchise_listings%rowtype; p public.game_players%rowtype; fb public.franchises%rowtype; fs public.franchises%rowtype;
  v_why text; v_fee integer; v_net integer; v_active integer; v_depth integer; ok boolean; v_real integer := public.games_season_of(now());
  v_new text[] := '{}'; k integer := 0; r record;
begin
  if v_b is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  -- the listing first: whoever holds this row is the only one deciding it
  select * into l from public.franchise_listings where id = p_listing for update;
  if not found then raise exception 'no such listing' using errcode = 'P0002'; end if;
  if l.status <> 'open' then raise exception 'that listing is closed: %', coalesce(l.reason, l.status) using errcode = '55000'; end if;
  if l.expires_at < now() then
    update public.franchise_listings set status = 'expired', reason = 'the listing ran out', closed_at = now() where id = l.id;
    raise exception 'that listing has expired' using errcode = '55000';
  end if;
  if l.franchise_id = v_b then raise exception 'that is your own listing' using errcode = '55000'; end if;
  -- then both franchises, in id order, whichever side is buying
  perform 1 from public.franchises where id in (l.franchise_id, v_b) order by id for update;
  select * into fs from public.franchises where id = l.franchise_id;
  select * into fb from public.franchises where id = v_b;
  -- the man is still where he was listed, and can still be spared
  select * into p from public.game_players where id = l.player_id for update;
  v_why := public.franchise_exchange_illegal(l.franchise_id, l.player_id);
  if v_why is not null then
    update public.franchise_listings set status = 'expired', reason = v_why, closed_at = now() where id = l.id;
    raise exception 'that listing is no longer good: %', v_why using errcode = '55000';
  end if;
  -- the buyer has the room and the Credits
  select count(*) into v_active from public.game_players where franchise_id = v_b and status = 'active';
  if v_active >= (mk->>'roster_max')::int then
    raise exception 'the roster is full at %: release a player first', (mk->>'roster_max')::int using errcode = '55000';
  end if;
  if fb.team_credits < l.price then
    raise exception 'not enough Credits: % needed, % on hand', l.price, fb.team_credits using errcode = '55000';
  end if;
  v_fee := public.franchise_exchange_fee(l.price); v_net := l.price - v_fee;
  -- the money: one row out of the buyer, one row into the seller, both keyed by the listing
  ok := public.franchise_credit(v_b, 'tc', -l.price, 'exchange_buy', l.id::text, 'Bought ' || p.first_name || ' ' || p.last_name || ' on the Exchange');
  if not ok then raise exception 'that purchase is already on the books' using errcode = '55000'; end if;
  perform public.franchise_credit(l.franchise_id, 'tc', v_net, 'exchange_sale', l.id::text,
    'Sold ' || p.first_name || ' ' || p.last_name || ' on the Exchange (' || v_fee || ' fee)');
  -- the man: bottom of the buyer's chart, a new number only on a clash, his career untouched
  select coalesce(max(depth), 0) + 1 into v_depth from public.game_players where franchise_id = v_b and position = p.position and status = 'active';
  update public.game_players
     set franchise_id = v_b, depth = v_depth,
         jersey = case when exists (select 1 from public.game_players o where o.franchise_id = v_b and o.status = 'active' and o.jersey = p.jersey)
                       then public.franchise_free_number(v_b, p.position, p.id::text) else p.jersey end,
         acquired_source = 'market', acquired_season = v_real,
         acquired_detail = 'Bought on the Exchange from the ' || fs.name || ' for ' || l.price || ' Credits',
         updated_at = now()
   where id = p.id;
  -- the card remembers the sale itself, with the price; the trigger has already written the move
  update public.game_players
     set history = history || jsonb_build_object('kind', 'sold', 'at', now(), 'price', l.price, 'fee', v_fee,
                                                 'from', fs.name, 'to', fb.name, 'overall', p.overall)
   where id = p.id;
  -- the seller's chart closes up
  for r in select id from public.game_players where franchise_id = l.franchise_id and position = p.position and status = 'active' order by depth, overall desc loop
    k := k + 1; update public.game_players set depth = k where id = r.id;
  end loop;
  update public.franchise_listings set status = 'sold', buyer_id = v_b, fee = v_fee, net = v_net, closed_at = now() where id = l.id returning * into l;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_b, 'exchange_buy', l.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('listing', l.id, 'player', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
                             'overall', p.overall, 'price', l.price, 'from', fs.name, 'currency', 'tc')),
         (l.franchise_id, 'exchange_sale', l.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('listing', l.id, 'player', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
                             'overall', p.overall, 'price', l.price, 'fee', v_fee, 'net', v_net, 'to', fb.name, 'currency', 'tc'))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_b, 'exchange_first_buy', v_real, jsonb_build_object('listing', l.id, 'price', l.price)) then
    v_new := array_append(v_new, 'exchange_first_buy'); end if;
  perform public.franchise_award(l.franchise_id, 'exchange_first_sale', v_real, jsonb_build_object('listing', l.id, 'price', l.price));
  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'listing', public.franchise_listing_json(l, v_b),
    'player', public.franchise_prospect_json(p) || public.franchise_profile_of(p),
    'price', l.price, 'fee', v_fee, 'net', v_net, 'currency', 'tc',
    'roster_active', v_active + 1, 'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_b));
end;
$$;

-- BROWSE. Open listings, filtered and sorted on the server; the caller's own
-- listings are marked, never hidden. Sweeps first, so nothing lapsed is shown.
create or replace function public.franchise_exchange_browse(
  p_position text default null, p_min integer default null, p_max integer default null,
  p_sort text default 'newest', p_query text default null, p_limit integer default 40, p_offset integer default 0,
  p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); rules jsonb := public.franchise_exchange_rules(); v_total integer; v_rows jsonb; v_mine jsonb; f public.franchises%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 100); v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := case when p_sort in ('newest','price_asc','price_desc','overall_desc','overall_asc','ending') then p_sort else 'newest' end;
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  perform public.franchise_exchange_sweep();
  if v_f is not null then select * into f from public.franchises where id = v_f; end if;
  select count(*) into v_total from public.franchise_listings l
   where l.status = 'open'
     and (p_position is null or l.snapshot->>'position' = p_position)
     and (p_min is null or (l.snapshot->>'overall')::int >= p_min)
     and (p_max is null or (l.snapshot->>'overall')::int <= p_max)
     and (v_q is null or l.snapshot->>'name' ilike '%' || v_q || '%' or l.snapshot->>'archetype' ilike '%' || v_q || '%');
  select coalesce(jsonb_agg(public.franchise_listing_json(l, v_f) order by
             case v_sort when 'price_asc' then l.price end asc,
             case v_sort when 'price_desc' then l.price end desc,
             case v_sort when 'overall_desc' then (l.snapshot->>'overall')::int end desc,
             case v_sort when 'overall_asc' then (l.snapshot->>'overall')::int end asc,
             case v_sort when 'ending' then l.expires_at end asc,
             l.created_at desc), '[]'::jsonb) into v_rows
    from public.franchise_listings l
   where l.id in (select x.id from public.franchise_listings x
           where x.status = 'open'
             and (p_position is null or x.snapshot->>'position' = p_position)
             and (p_min is null or (x.snapshot->>'overall')::int >= p_min)
             and (p_max is null or (x.snapshot->>'overall')::int <= p_max)
             and (v_q is null or x.snapshot->>'name' ilike '%' || v_q || '%' or x.snapshot->>'archetype' ilike '%' || v_q || '%')
           order by
             case v_sort when 'price_asc' then x.price end asc,
             case v_sort when 'price_desc' then x.price end desc,
             case v_sort when 'overall_desc' then (x.snapshot->>'overall')::int end desc,
             case v_sort when 'overall_asc' then (x.snapshot->>'overall')::int end asc,
             case v_sort when 'ending' then x.expires_at end asc,
             x.created_at desc
           limit v_limit offset v_offset);
  select coalesce(jsonb_agg(public.franchise_listing_json(l, v_f) order by l.created_at desc), '[]'::jsonb) into v_mine
    from public.franchise_listings l where v_f is not null and l.franchise_id = v_f and l.status = 'open';
  return jsonb_build_object(
    'version', rules->>'version', 'rules', rules,
    'total', v_total, 'limit', v_limit, 'offset', v_offset, 'sort', v_sort,
    'filter', jsonb_build_object('position', p_position, 'min', p_min, 'max', p_max, 'query', v_q),
    'listings', v_rows,
    'mine', v_mine,
    'open_slots', case when v_f is null then null else (rules->>'max_open')::int - jsonb_array_length(v_mine) end,
    'balance', case when v_f is null then null else f.team_credits end,
    'roster', case when v_f is null then null else jsonb_build_object(
        'active', (select count(*) from public.game_players where franchise_id = v_f and status = 'active'),
        'max', (public.franchise_market()->>'roster_max')::int) end,
    'resources', case when v_f is null then null else public.franchise_totals(v_f) end);
end;
$$;

-- THE RECORD. What this franchise listed, sold and bought, and the last
-- sales on the whole Exchange — the price history a buyer reads.
create or replace function public.franchise_exchange_history(p_limit integer default 20, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  perform public.franchise_exchange_sweep();
  return jsonb_build_object(
    'mine', case when v_f is null then '[]'::jsonb else coalesce((select jsonb_agg(public.franchise_listing_json(l, v_f) order by coalesce(l.closed_at, l.created_at) desc)
              from public.franchise_listings l
             where l.id in (select x.id from public.franchise_listings x where (x.franchise_id = v_f or x.buyer_id = v_f) and x.status <> 'open'
                             order by coalesce(x.closed_at, x.created_at) desc limit v_limit)), '[]'::jsonb) end,
    'recent', coalesce((select jsonb_agg(jsonb_build_object('price', l.price, 'position', l.snapshot->>'position', 'overall', (l.snapshot->>'overall')::int,
                          'tier', l.snapshot->>'tier', 'name', l.snapshot->>'name', 'sold_at', l.closed_at) order by l.closed_at desc)
                from (select * from public.franchise_listings where status = 'sold' order by closed_at desc limit v_limit) l), '[]'::jsonb),
    'volume', jsonb_build_object(
      'sold_30d', (select count(*) from public.franchise_listings where status = 'sold' and closed_at >= now() - interval '30 days'),
      'credits_30d', (select coalesce(sum(price), 0) from public.franchise_listings where status = 'sold' and closed_at >= now() - interval '30 days'),
      'fees_30d', (select coalesce(sum(fee), 0) from public.franchise_listings where status = 'sold' and closed_at >= now() - interval '30 days'),
      'open', (select count(*) from public.franchise_listings where status = 'open')));
end;
$$;

-- ── THE ROSTER READ MODEL, REDEFINED ────────────────────────────────────────
-- Phase 17's roster with three more things on it: the chemistry of the
-- lineup with every term printed, the lineup rules, and on each man the open
-- listing he carries, if he does.
create or replace function public.franchise_roster(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.franchises%rowtype; v_players jsonb;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
  select coalesce(jsonb_agg((jsonb_build_object(
      'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'position', p.position, 'jersey', p.jersey,
      'age', p.age, 'overall', p.overall, 'archetype', p.archetype, 'dev_tier', p.dev_tier, 'potential', p.potential,
      'stamina', p.stamina, 'chemistry', p.chemistry, 'rarity', p.rarity, 'ratings', p.ratings, 'traits', p.traits,
      'depth', p.depth, 'status', p.status, 'acquired_source', p.acquired_source, 'acquired_season', p.acquired_season,
      'acquired_detail', p.acquired_detail, 'career_stats', p.career_stats, 'season_stats', p.season_stats, 'live_stats', p.live_stats,
      'available', public.franchise_is_available(p.status, p.injured_until),
      'injured_until', p.injured_until, 'injury', p.injury,
      -- the open listing he carries, if any (Phase 19)
      'listing', (select jsonb_build_object('id', l.id, 'price', l.price, 'expires_at', l.expires_at)
                    from public.franchise_listings l where l.player_id = p.id and l.status = 'open'))
      || public.franchise_profile_of(p))
      order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth, p.overall desc), '[]'::jsonb)
    into v_players from public.game_players p where p.franchise_id = f.id and p.status = 'active';
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season,
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'rating', public.franchise_team_rating(f.id),
    'starters', jsonb_build_object('QB', 1, 'RB', 1, 'WR', 3, 'TE', 1, 'OL', 5, 'DL', 4, 'LB', 3, 'CB', 2, 'S', 2, 'K', 1, 'P', 1),
    'lineup', public.franchise_lineup_rules(),
    'chemistry', public.franchise_chemistry(f.id),
    'exchange', public.franchise_exchange_rules(),
    'injuries', public.franchise_injuries(),
    'injured', (select count(*) from public.game_players p where p.franchise_id = f.id and p.status = 'active'
                 and not public.franchise_is_available(p.status, p.injured_until)),
    'totals', public.franchise_totals(f.id),
    'players', v_players);
end;
$$;

-- ── WHO MAY CALL WHAT ───────────────────────────────────────────────────────
grant execute on function public.franchise_chemistry_rules() to anon, authenticated;
grant execute on function public.franchise_scheme_fit() to anon, authenticated;
grant execute on function public.franchise_lineup_rules() to anon, authenticated;
grant execute on function public.franchise_lineup_best(text) to anon, authenticated;
grant execute on function public.franchise_exchange_rules() to anon, authenticated;
grant execute on function public.franchise_exchange_fee(integer) to anon, authenticated;
grant execute on function public.franchise_exchange_comps(text, integer) to anon, authenticated;
grant execute on function public.franchise_exchange_list(uuid, integer, text) to anon, authenticated;
grant execute on function public.franchise_exchange_withdraw(uuid, text) to anon, authenticated;
grant execute on function public.franchise_exchange_buy(uuid, text) to anon, authenticated;
grant execute on function public.franchise_exchange_browse(text, integer, integer, text, text, integer, integer, text) to anon, authenticated;
grant execute on function public.franchise_exchange_history(integer, text) to anon, authenticated;
revoke all on function public.franchise_chemistry(uuid) from public, anon, authenticated;
revoke all on function public.franchise_trait_effects(uuid) from public, anon, authenticated;
revoke all on function public.franchise_exchange_illegal(uuid, uuid) from public, anon, authenticated;
revoke all on function public.franchise_exchange_sweep() from public, anon, authenticated;
revoke all on function public.franchise_listing_json(public.franchise_listings, uuid) from public, anon, authenticated;

select public.games_schema_note('franchise', 19, 'the lineup, chemistry, and the Exchange');
commit;

-- ===========================================================================
-- PHASE 20 — THE PULL RECORD
--
-- "My pulls": every pack this franchise ever opened, the men who came out of
-- it AS THEY WERE THE NIGHT THEY WERE PULLED, which of them were kept, the
-- best pull of all, and the counts by tier. Nothing is stored for it — the
-- pack rows and the men carry everything, and the first line of every card's
-- history is the overall he was generated at, so a man developed since still
-- shows the pull as it was. A read, like the rank: nothing here writes.
-- ===========================================================================
begin;

create or replace function public.franchise_pulls_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('version', 'pulls_v1', 'shown', 30, 'premium_from', 87);
$$;

-- the overall a man was pulled at: the first line of his history, written by
-- the card trigger the moment he was generated
create or replace function public.franchise_pulled_overall(p public.game_players)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce((p.history->0->>'overall')::int, p.overall);
$$;

-- every man who ever came out of one of this franchise's packs, whatever
-- became of him since: kept, passed over, traded on, retired
create or replace function public.franchise_pulled_men(p_franchise uuid)
returns table (pack_id uuid, kind text, source text, opened_at timestamptz, band jsonb, player_id uuid, name text, pos text,
               overall integer, tier text, kept boolean, now_overall integer, status text)
language sql stable security definer set search_path = public, pg_temp as $$
  select k.id, k.kind, k.source, k.opened_at, k.contents->'band', p.id, p.first_name || ' ' || p.last_name, p.position,
         public.franchise_pulled_overall(p), public.franchise_card_tier(public.franchise_pulled_overall(p)),
         p.status not in ('pack', 'passed'), p.overall, p.status
    from public.franchise_packs k join public.game_players p on p.pack_id = k.id
   where k.franchise_id = p_franchise and k.status in ('open', 'done');
$$;

create or replace function public.franchise_pulls(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype; v_best jsonb; v_list jsonb; v_tiers jsonb;
  v_opened integer; v_men integer; v_kept integer; v_passed integer; v_table integer; v_premium integer;
  v_shown integer := (public.franchise_pulls_rules()->>'shown')::int;
  v_from integer := (public.franchise_pulls_rules()->>'premium_from')::int;
begin
  if v_f is null then return null; end if;
  select * into f from public.franchises where id = v_f;
  if not found then return null; end if;
  select count(distinct m.pack_id), count(*), count(*) filter (where m.kept), count(*) filter (where m.status = 'passed'),
         count(*) filter (where m.status = 'pack'), count(*) filter (where m.overall >= v_from)
    into v_opened, v_men, v_kept, v_passed, v_table, v_premium
    from public.franchise_pulled_men(v_f) m;
  select coalesce(jsonb_object_agg(t.tier, t.n), '{}'::jsonb) into v_tiers
    from (select m.tier, count(*) as n from public.franchise_pulled_men(v_f) m group by m.tier) t;
  -- the best pull of all: the highest overall as pulled, the earliest if tied
  select jsonb_build_object('id', m.player_id, 'name', m.name, 'position', m.pos, 'overall', m.overall, 'tier', m.tier,
           'kept', m.kept, 'status', m.status, 'now_overall', m.now_overall, 'kind', m.kind,
           'kind_name', public.franchise_pack_def(m.kind)->>'name', 'source', m.source, 'opened_at', m.opened_at, 'pack_id', m.pack_id)
    into v_best
    from public.franchise_pulled_men(v_f) m
   order by m.overall desc, m.opened_at asc, m.player_id limit 1;
  -- the last packs, newest first, each with its men best first
  select coalesce(jsonb_agg(jsonb_build_object('pack_id', g.pack_id, 'kind', g.kind, 'kind_name', public.franchise_pack_def(g.kind)->>'name',
           'source', g.source, 'opened_at', g.opened_at, 'low', (g.band->>'low')::int, 'high', (g.band->>'high')::int,
           'best', g.best, 'kept', g.kept_n, 'men', g.men) order by g.opened_at desc, g.pack_id), '[]'::jsonb)
    into v_list
    from (select m.pack_id, m.kind, m.source, m.opened_at, m.band, max(m.overall) as best, count(*) filter (where m.kept) as kept_n,
                 jsonb_agg(jsonb_build_object('id', m.player_id, 'name', m.name, 'position', m.pos, 'overall', m.overall,
                   'tier', m.tier, 'kept', m.kept, 'status', m.status) order by m.overall desc, m.player_id) as men
            from public.franchise_pulled_men(v_f) m
           group by m.pack_id, m.kind, m.source, m.opened_at, m.band
           order by m.opened_at desc, m.pack_id limit v_shown) g;
  return jsonb_build_object('version', public.franchise_pulls_rules()->>'version',
    'opened', v_opened, 'men', v_men, 'kept', v_kept, 'passed', v_passed, 'on_table', v_table,
    'premium', v_premium, 'premium_from', v_from, 'by_tier', v_tiers, 'best', v_best,
    'since_prime', coalesce(f.packs_since_prime, 0), 'shown', v_shown, 'pulls', v_list);
end;
$$;

grant execute on function public.franchise_pulls(text) to anon, authenticated;
grant execute on function public.franchise_pulls_rules() to anon, authenticated;
revoke all on function public.franchise_pulled_men(uuid) from public, anon, authenticated;
revoke all on function public.franchise_pulled_overall(public.game_players) from public, anon, authenticated;

select public.games_schema_note('franchise', 20, 'the pull record: every pack you opened and the best of them');
commit;

-- ===========================================================================
-- PHASE 21 — THE GAME YOU HOLD COUNTS
--
-- The live game — the one played with thumbs on glass — was the best thing
-- in the building and the only thing that fed nothing back. A finished game
-- is filed here with its own key: the score, the yards, the touchdowns, the
-- difficulty, and every man of yours with his line. The server checks the
-- shape (a score of 150 is not a score; nine touchdowns do not fit in seven
-- points), credits it once by the economy's own table scaled by the tier the
-- defence was set to, caps the credited games at five a day so a grind pays
-- nothing while the record and the careers still take it, weighs it toward
-- the rank (so the Gridiron Cache is closer for having played), and seals a
-- Game Day pack for every fifth game finished at Pro or harder.
--
-- The men's lines land in live_stats — a career in your hands, kept apart
-- from the simulation's career_stats so neither can quietly inflate the
-- other — and only the keys a career knows, bounded, for men who are yours.
-- ===========================================================================
begin;

alter table public.game_players add column if not exists live_stats jsonb not null default '{}'::jsonb;

-- how the live games are counting toward the Game Day pack: the credited
-- games finished at Pro or harder, five to a pack
create or replace function public.franchise_gameday_progress(p_franchise uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_n integer; v_all integer; v_today integer; v_per integer := 5;
begin
  select count(*) filter (where detail->>'difficulty' in ('pro', 'allpro', 'legend')), count(*),
         count(*) filter (where day_key = public.games_day_key(now()))
    into v_n, v_all, v_today
    from public.franchise_activity where franchise_id = p_franchise and kind = 'live_game';
  return jsonb_build_object('played', v_all, 'counted', v_n, 'per_pack', v_per, 'packs', v_n / v_per,
    'toward', v_n % v_per, 'next_in', v_per - (v_n % v_per),
    'today', v_today, 'cap', (public.franchise_economy()->'live_cap'->>'per_day')::int);
end;
$$;

create or replace function public.franchise_record_live_game(p_key text, p_game jsonb, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); econ jsonb := public.franchise_economy(); v_day text := public.games_day_key(now());
  v_diff text; v_len text; v_for integer; v_against integer; v_plays integer; v_yards integer; v_tds integer; v_to integer;
  v_won boolean; v_tier numeric; v_xp integer := 0; v_tc integer := 0; v_cp integer := 0; v_today integer; v_capped boolean := false;
  v_kind text; v_existing jsonb; ln jsonb; v_stats jsonb; v_k text; v_val numeric; v_men integer := 0; v_detail jsonb; v_packs integer;
  v_before jsonb; v_rep jsonb; v_had text[]; v_new_kinds jsonb;
  allowed text[] := array['games','att','cmp','yds','td','int','car','rush_yds','rush_td','rec','rec_yds','rec_td','tkl','sacks','tfl','pd','fg','fga','xp'];
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  if p_key is null or length(p_key) < 6 or length(p_key) > 120 then raise exception 'that is not a game key' using errcode = '22023'; end if;
  if p_game is null or jsonb_typeof(p_game) <> 'object' then raise exception 'that is not a game' using errcode = '22023'; end if;
  v_diff := coalesce(p_game->>'difficulty', 'pro'); v_len := coalesce(p_game->>'length', 'blitz');
  if v_diff not in ('rookie', 'pro', 'allpro', 'legend') or v_len not in ('arcade', 'blitz', 'quick', 'standard') then
    raise exception 'that is not a game' using errcode = '22023';
  end if;
  begin
    v_for := (p_game->>'score_for')::int; v_against := (p_game->>'score_against')::int; v_plays := (p_game->>'plays')::int;
    v_yards := coalesce((p_game->>'yards')::int, 0); v_tds := coalesce((p_game->>'touchdowns')::int, 0); v_to := coalesce((p_game->>'turnovers')::int, 0);
  exception when others then raise exception 'that is not a game result' using errcode = '22023'; end;
  -- THE SHAPE OF A RESULT. Not a simulation of the game — a check that the
  -- numbers could have come from one.
  if v_for is null or v_against is null or v_plays is null
     or v_for not between 0 and 99 or v_against not between 0 and 99 or v_plays not between 8 and 250
     or v_yards not between -60 and 999 or v_tds not between 0 and 15 or v_to not between 0 and 12
     or v_tds * 6 > v_for then
    raise exception 'that is not a game result' using errcode = '22023';
  end if;
  -- filed once: the same key comes back with what it already paid
  select detail into v_existing from public.franchise_activity
   where franchise_id = v_f and kind in ('live_game', 'live_game_extra') and key = p_key;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'already', true, 'result', v_existing, 'capped', coalesce((v_existing->>'capped')::boolean, false),
      'rewards', jsonb_build_object('xp', 0, 'tc', 0, 'cp', 0), 'rank_gain', 0, 'packs_new', 0,
      'rank', public.franchise_rank_report(v_f), 'gameday', public.franchise_gameday_progress(v_f), 'totals', public.franchise_totals(v_f));
  end if;
  perform 1 from public.franchises where id = v_f for update;
  select count(*) into v_today from public.franchise_activity where franchise_id = v_f and kind = 'live_game' and day_key = v_day;
  v_capped := v_today >= (econ->'live_cap'->>'per_day')::int;
  v_kind := case when v_capped then 'live_game_extra' else 'live_game' end;
  v_won := v_for > v_against;
  v_tier := coalesce((econ->'live_tier'->>v_diff)::numeric, 1);
  if not v_capped then
    v_xp := (econ->'live_game'->>'xp')::int; v_tc := (econ->'live_game'->>'tc')::int;
    if v_won then
      v_xp := v_xp + (econ->'live_win'->>'xp')::int; v_tc := v_tc + (econ->'live_win'->>'tc')::int; v_cp := (econ->'live_win'->>'cp')::int;
    end if;
    -- the performance itself, capped: touchdowns and every hundred yards
    v_tc := v_tc + least((econ->'live_perf'->>'tc_max')::int,
                         v_tds * (econ->'live_perf'->>'tc_per_td')::int + (greatest(0, v_yards) / 100) * (econ->'live_perf'->>'tc_per_100')::int);
    v_xp := v_xp + least((econ->'live_perf'->>'xp_max')::int, (greatest(0, v_yards) / 100) * (econ->'live_perf'->>'xp_per_100')::int);
    v_xp := round(v_xp * v_tier)::int; v_tc := round(v_tc * v_tier)::int;
  end if;
  v_before := public.franchise_rank_report(v_f);
  -- THE MEN: only yours, only the keys a career knows, nothing negative,
  -- nothing past a season's worth in one game; a stranger's id takes nothing
  for ln in select x from jsonb_array_elements(coalesce(p_game->'players', '[]'::jsonb)) x limit 60 loop
    if ln->>'id' is null or ln->>'id' !~ '^[0-9a-fA-F-]{36}$' or jsonb_typeof(ln->'stats') <> 'object' then continue; end if;
    v_stats := '{}'::jsonb;
    for v_k, v_val in select key, case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric else null end from jsonb_each(ln->'stats') loop
      if v_k = any(allowed) and v_val is not null and v_val between 0 and 999 then v_stats := v_stats || jsonb_build_object(v_k, floor(v_val)::int); end if;
    end loop;
    if v_stats = '{}'::jsonb then continue; end if;
    update public.game_players set live_stats = public.games_jsonb_sum(live_stats, v_stats), updated_at = now()
     where id = (ln->>'id')::uuid and franchise_id = v_f and status = 'active';
    if found then v_men := v_men + 1; end if;
  end loop;
  v_detail := jsonb_build_object('key', p_key, 'difficulty', v_diff, 'length', v_len, 'score_for', v_for, 'score_against', v_against,
    'won', v_won, 'plays', v_plays, 'yards', v_yards, 'touchdowns', v_tds, 'turnovers', v_to,
    'opponent', left(coalesce(p_game->>'opponent', ''), 60), 'men', v_men, 'capped', v_capped, 'tier', v_tier,
    'rewards', jsonb_build_object('xp', v_xp, 'tc', v_tc, 'cp', v_cp), 'version', econ->>'version');
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, verified, detail)
  values (v_f, v_kind, p_key, public.games_week_key(now()), v_day, false, v_detail);
  if v_xp > 0 then perform public.franchise_credit(v_f, 'xp', v_xp, 'live_game', p_key, 'Game Day, ' || v_for || '–' || v_against); end if;
  if v_tc > 0 then perform public.franchise_credit(v_f, 'tc', v_tc, 'live_game', p_key, 'Game Day, ' || v_for || '–' || v_against); end if;
  if v_cp > 0 then perform public.franchise_credit(v_f, 'cp', v_cp, 'live_game', p_key, 'Game Day, won'); end if;
  -- WHICH PACKS THIS GAME SEALED, not just how many. A live game can earn a
  -- Game Day Pack and a program pack at the same moment (packs_v4), and a
  -- panel that names the wrong one is a panel nobody can trust.
  select coalesce(array_agg(k.kind || ':' || k.source_key), '{}') into v_had
    from public.franchise_packs k where k.franchise_id = v_f;
  v_packs := public.franchise_packs_sync(v_f);
  select coalesce(jsonb_agg(distinct jsonb_build_object('kind', k.kind, 'name', public.franchise_pack_def(k.kind)->>'name')), '[]'::jsonb)
    into v_new_kinds
    from public.franchise_packs k
   where k.franchise_id = v_f and not (k.kind || ':' || k.source_key = any(v_had));
  v_rep := public.franchise_rank_report(v_f);
  return jsonb_build_object('ok', true, 'already', false, 'result', v_detail, 'capped', v_capped,
    'rewards', jsonb_build_object('xp', v_xp, 'tc', v_tc, 'cp', v_cp),
    'rank', v_rep, 'rank_gain', (v_rep->>'points')::int - (v_before->>'points')::int,
    'packs_new', v_packs, 'packs_sealed', v_new_kinds, 'gameday', public.franchise_gameday_progress(v_f),
    'totals', public.franchise_totals(v_f));
end;
$$;

grant execute on function public.franchise_record_live_game(text, jsonb, text) to anon, authenticated;
revoke all on function public.franchise_gameday_progress(uuid) from public, anon, authenticated;

select public.games_schema_note('franchise', 21, 'the game you hold counts: live results, careers, and the Game Day pack');
commit;

-- ===========================================================================

-- ===========================================================================
-- PHASE 22 — THE CARD IS NOT THE MAN (cards_v1)
--
-- Until now one table carried five different ideas at once. `game_players`
-- held WHO A MAN IS (his name, his body, where he is from), WHAT HIS CARD
-- SAYS (the edition, the rarity, the printed ratings), WHO OWNS HIM (a
-- franchise_id column), WHERE HE PLAYS (a depth number) and, by way of a
-- listing pointing straight at him, WHETHER HE IS FOR SALE. The Exchange
-- traded that row: a sale was an UPDATE of one column on the same record
-- that also held his career. There is no way to hold two editions of one
-- man, no way to say who owned a card before you, and no way to price a
-- card apart from the man.
--
-- These are now separate things:
--
--   game_player_identities  the persistent fictional athlete
--   game_card_defs          a printed edition of that athlete
--   game_cards              one instance of that edition, with its serial
--   game_card_ownership     who holds that instance, right now
--   game_card_provenance    every hand it has passed through
--   game_lineup_slots       where an owned card is playing
--   franchise_listings      a temporary offer of an owned card
--   game_market_txns        a completed transfer, with money
--   game_market_prices      what editions like it have sold for
--
-- `game_players` keeps what is genuinely its own: THE CAREER SHEET. The
-- stats, the development, the injuries and the ratings as they have moved
-- since the card was printed. Its franchise_id and depth columns survive
-- only as a READ PROJECTION for code that has not been rewritten yet, and
-- the database refuses to let anything write them behind the new tables'
-- back: ownership moves through franchise_card_transfer() or it does not
-- move. The parity test holds the projection to the source.
--
-- MIGRATION. Idempotent and additive. Every existing row is minted an
-- identity, an edition, an instance and an ownership record; every open
-- listing is pointed at the instance; every sold listing becomes a
-- transaction and a price. Nothing is deleted, nothing is duplicated, no
-- roster moves, no ledger changes, no result changes.
-- ===========================================================================
begin;

create or replace function public.franchise_cards_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'cards_v1',
    -- what a card can be acquired by, and what it means
    'acquisition', jsonb_build_object(
      'founding_roster', 'the founding roster',
      'offseason_rookie', 'a rookie signed in the offseason',
      'draft', 'the draft',
      'free_agent', 'free agency',
      'pack', 'a pack in the Vault',
      'market', 'the Exchange',
      'trade', 'a trade',
      'migration', 'minted from the record'),
    -- one athlete, one printed edition, one instance of it: the Vault has
    -- always said "one of one" and the schema now means it
    'default_supply', 1);
$$;
grant execute on function public.franchise_cards_rules() to anon, authenticated;

-- ── WHO HE IS ────────────────────────────────────────────────────────────
create table if not exists public.game_player_identities (
  id              uuid primary key default gen_random_uuid(),
  identity_seed   text not null,
  first_name      text not null,
  last_name       text not null,
  position        text not null,
  height_in       integer,
  weight_lb       integer,
  hometown        text,
  archetype       text,
  base_profile    jsonb not null default '{}'::jsonb,
  appearance_seed text,
  born_season     integer,
  created_at      timestamptz not null default now()
);
create unique index if not exists game_player_identities_seed on public.game_player_identities (identity_seed);

-- ── WHAT THE CARD SAYS ───────────────────────────────────────────────────
create table if not exists public.game_card_defs (
  id            uuid primary key default gen_random_uuid(),
  player_id     uuid not null references public.game_player_identities (id) on delete cascade,
  edition       text not null default 'base',
  program       text,
  rarity        text not null,
  base_overall  integer not null check (base_overall between 1 and 99),
  attributes    jsonb not null default '{}'::jsonb,
  art_variant   text,
  supply_limit  integer,
  created_at    timestamptz not null default now()
);
create unique index if not exists game_card_defs_one_per_edition on public.game_card_defs (player_id, edition);
create index if not exists game_card_defs_player on public.game_card_defs (player_id);

-- ── ONE OF THEM ──────────────────────────────────────────────────────────
create table if not exists public.game_cards (
  id           uuid primary key default gen_random_uuid(),
  card_def_id  uuid not null references public.game_card_defs (id) on delete cascade,
  serial_number integer,
  minted_at    timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb
);
create unique index if not exists game_cards_serial on public.game_cards (card_def_id, serial_number) where serial_number is not null;
create index if not exists game_cards_def on public.game_cards (card_def_id);

-- ── WHO HOLDS IT ─────────────────────────────────────────────────────────
-- One row per card, ever. A card cannot be owned twice: the primary key on
-- card_id is what makes duplicate ownership impossible rather than unlikely.
create table if not exists public.game_card_ownership (
  card_id          uuid primary key references public.game_cards (id) on delete cascade,
  owner_id         uuid references public.franchises (id) on delete cascade,
  acquired_at      timestamptz not null default now(),
  acquisition_type text not null default 'migration',
  acquisition_ref  text
);
create index if not exists game_card_ownership_owner on public.game_card_ownership (owner_id);

-- ── EVERY HAND IT HAS PASSED THROUGH ─────────────────────────────────────
create table if not exists public.game_card_provenance (
  id               bigserial primary key,
  card_id          uuid not null references public.game_cards (id) on delete cascade,
  from_id          uuid references public.franchises (id) on delete set null,
  to_id            uuid references public.franchises (id) on delete set null,
  acquisition_type text not null,
  acquisition_ref  text,
  price            integer,
  at               timestamptz not null default now()
);
create index if not exists game_card_provenance_card on public.game_card_provenance (card_id, at);

-- ── WHERE IT PLAYS ───────────────────────────────────────────────────────
-- The lineup is a place, not a number on a man: one row per franchise, per
-- position, per slot, naming the card that fills it. Maintained from the
-- career sheet's depth by trigger, so every existing way of setting a
-- lineup keeps working and the lineup is still queryable as its own thing.
create table if not exists public.game_lineup_slots (
  franchise_id uuid not null references public.franchises (id) on delete cascade,
  position     text not null,
  slot         integer not null check (slot >= 1),
  card_id      uuid not null references public.game_cards (id) on delete cascade,
  updated_at   timestamptz not null default now(),
  primary key (franchise_id, position, slot)
);
create unique index if not exists game_lineup_slots_card on public.game_lineup_slots (card_id);

-- ── WHAT SOLD, AND FOR WHAT ──────────────────────────────────────────────
create table if not exists public.game_market_txns (
  id            uuid primary key default gen_random_uuid(),
  listing_id    uuid references public.franchise_listings (id) on delete set null,
  card_id       uuid not null references public.game_cards (id) on delete cascade,
  seller_id     uuid references public.franchises (id) on delete set null,
  buyer_id      uuid references public.franchises (id) on delete set null,
  sale_price    integer not null,
  fee           integer not null default 0,
  net           integer not null default 0,
  op_key        text,
  completed_at  timestamptz not null default now()
);
-- ONE TRANSACTION PER LISTING, ENFORCED BY THE DATABASE. Two buyers racing
-- for the same card cannot both write here; the loser's transaction rolls
-- back whole.
create unique index if not exists game_market_txns_listing on public.game_market_txns (listing_id) where listing_id is not null;
create unique index if not exists game_market_txns_op on public.game_market_txns (op_key) where op_key is not null;
create index if not exists game_market_txns_card on public.game_market_txns (card_id, completed_at desc);
create index if not exists game_market_txns_buyer on public.game_market_txns (buyer_id, completed_at desc);

create table if not exists public.game_market_prices (
  id           bigserial primary key,
  card_def_id  uuid not null references public.game_card_defs (id) on delete cascade,
  player_id    uuid not null references public.game_player_identities (id) on delete cascade,
  position     text not null,
  overall      integer not null,
  sale_price   integer not null,
  sold_at      timestamptz not null default now()
);
create index if not exists game_market_prices_def on public.game_market_prices (card_def_id, sold_at desc);
create index if not exists game_market_prices_comp on public.game_market_prices (position, overall, sold_at desc);

-- the career sheet points at the instance it is the career of
alter table public.game_players add column if not exists card_id uuid references public.game_cards (id) on delete set null;
create unique index if not exists game_players_card on public.game_players (card_id) where card_id is not null;
-- a listing offers a card, not a row of career stats
alter table public.franchise_listings add column if not exists card_id uuid references public.game_cards (id) on delete cascade;
create index if not exists franchise_listings_card on public.franchise_listings (card_id);

alter table public.game_player_identities enable row level security;
alter table public.game_card_defs enable row level security;
alter table public.game_cards enable row level security;
alter table public.game_card_ownership enable row level security;
alter table public.game_card_provenance enable row level security;
alter table public.game_lineup_slots enable row level security;
alter table public.game_market_txns enable row level security;
alter table public.game_market_prices enable row level security;
-- identities, editions and what things sold for are public knowledge; who
-- holds what, and what is in a lineup, is the owner's business
drop policy if exists game_player_identities_read on public.game_player_identities;
create policy game_player_identities_read on public.game_player_identities for select using (true);
drop policy if exists game_card_defs_read on public.game_card_defs;
create policy game_card_defs_read on public.game_card_defs for select using (true);
drop policy if exists game_cards_read on public.game_cards;
create policy game_cards_read on public.game_cards for select using (true);
drop policy if exists game_market_prices_read on public.game_market_prices;
create policy game_market_prices_read on public.game_market_prices for select using (true);
drop policy if exists game_card_ownership_mine on public.game_card_ownership;
create policy game_card_ownership_mine on public.game_card_ownership for select using (public.franchise_is_mine(owner_id));
drop policy if exists game_lineup_slots_mine on public.game_lineup_slots;
create policy game_lineup_slots_mine on public.game_lineup_slots for select using (public.franchise_is_mine(franchise_id));
drop policy if exists game_card_provenance_party on public.game_card_provenance;
create policy game_card_provenance_party on public.game_card_provenance for select
  using (public.franchise_is_mine(from_id) or public.franchise_is_mine(to_id));
drop policy if exists game_market_txns_party on public.game_market_txns;
create policy game_market_txns_party on public.game_market_txns for select
  using (public.franchise_is_mine(seller_id) or public.franchise_is_mine(buyer_id));

-- ── MINTING ──────────────────────────────────────────────────────────────
-- Given a career sheet, make the man, the edition and the instance behind
-- it, and hand the instance back. Idempotent on the identity seed, so a
-- second run of the migration mints nothing twice.
create or replace function public.franchise_card_mint(p public.game_players, p_type text default 'migration', p_ref text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seed text; v_ident uuid; v_def uuid; v_card uuid; v_body jsonb; v_minted integer; v_prof jsonb;
begin
  if p.id is null then return null; end if;
  v_seed := 'p:' || p.id::text;
  select id into v_ident from public.game_player_identities where identity_seed = v_seed;
  if v_ident is null then
    v_body := public.franchise_body(p.position, p.jersey, p.age, p.stamina, p.last_name);
    v_prof := public.franchise_profile(p.position, p.ratings, p.overall, p.archetype, p.jersey, p.age, p.stamina, p.last_name);
    insert into public.game_player_identities
      (identity_seed, first_name, last_name, position, height_in, weight_lb, hometown, archetype, base_profile, appearance_seed, born_season)
    values (v_seed, p.first_name, p.last_name, p.position,
            nullif((v_body->>'height_in')::int, 0), nullif((v_body->>'weight_lb')::int, 0),
            public.franchise_hometown(p.jersey, p.age, p.stamina, p.last_name, p.first_name),
            p.archetype, coalesce(v_prof, '{}'::jsonb), v_seed, p.acquired_season)
    returning id into v_ident;
  end if;
  -- the edition is the card as it was PRINTED: the overall he was rolled at,
  -- from his own first line, not the overall he has since developed into
  v_minted := coalesce((p.history->0->>'overall')::int, p.overall);
  select id into v_def from public.game_card_defs where player_id = v_ident and edition = 'base';
  if v_def is null then
    insert into public.game_card_defs (player_id, edition, program, rarity, base_overall, attributes, art_variant, supply_limit)
    values (v_ident, 'base',
            case when p.pack_id is not null then (select k.kind from public.franchise_packs k where k.id = p.pack_id) else null end,
            p.rarity, greatest(1, least(99, v_minted)),
            coalesce(p.history->0->'ratings', p.ratings), public.franchise_card_tier(v_minted),
            (public.franchise_cards_rules()->>'default_supply')::int)
    returning id into v_def;
  end if;
  select c.id into v_card from public.game_cards c where c.card_def_id = v_def order by c.minted_at limit 1;
  if v_card is null then
    insert into public.game_cards (card_def_id, serial_number, minted_at, metadata)
    values (v_def, 1, coalesce(p.created_at, now()),
            jsonb_build_object('minted_overall', v_minted, 'acquired_source', p.acquired_source))
    returning id into v_card;
  end if;
  insert into public.game_card_ownership (card_id, owner_id, acquired_at, acquisition_type, acquisition_ref)
  values (v_card, p.franchise_id, coalesce(p.created_at, now()), coalesce(p_type, 'migration'), p_ref)
  on conflict (card_id) do nothing;
  return v_card;
end;
$$;
revoke all on function public.franchise_card_mint(public.game_players, text, text) from public, anon, authenticated;

-- ── THE ONLY DOOR OWNERSHIP MOVES THROUGH ────────────────────────────────
-- Locks the ownership row, moves it, writes the provenance, and projects the
-- move onto the legacy column under a transaction-local flag the guard
-- trigger checks. Nothing else in the schema may change who owns a card.
create or replace function public.franchise_card_transfer(
  p_card uuid, p_to uuid, p_type text, p_ref text default null, p_price integer default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_from uuid; v_player uuid;
begin
  if p_card is null then raise exception 'no card' using errcode = 'P0002'; end if;
  select owner_id into v_from from public.game_card_ownership where card_id = p_card for update;
  if not found then raise exception 'that card has no ownership record' using errcode = 'P0002'; end if;
  update public.game_card_ownership
     set owner_id = p_to, acquired_at = now(), acquisition_type = p_type, acquisition_ref = p_ref
   where card_id = p_card;
  insert into public.game_card_provenance (card_id, from_id, to_id, acquisition_type, acquisition_ref, price)
  values (p_card, v_from, p_to, p_type, p_ref, p_price);
  -- the projection: the career sheet follows the card, never the other way
  perform set_config('edgd.card_transfer', '1', true);
  update public.game_players set franchise_id = p_to, updated_at = now() where card_id = p_card returning id into v_player;
  perform set_config('edgd.card_transfer', '', true);
  return v_player;
end;
$$;
revoke all on function public.franchise_card_transfer(uuid, uuid, text, text, integer) from public, anon, authenticated;

-- ── THE GUARD, AND THE PROJECTION ────────────────────────────────────────
create or replace function public.game_players_card_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_card uuid;
begin
  if TG_OP = 'INSERT' then
    -- every career sheet is the career of a card; mint one at the door
    if NEW.card_id is null then
      NEW.card_id := public.franchise_card_mint(NEW, coalesce(NEW.acquired_source, 'migration'), NEW.acquired_detail);
    end if;
    return NEW;
  end if;
  if NEW.franchise_id is distinct from OLD.franchise_id
     and coalesce(current_setting('edgd.card_transfer', true), '') <> '1' then
    raise exception 'ownership moves through franchise_card_transfer(), not by writing game_players.franchise_id'
      using errcode = '55000';
  end if;
  return NEW;
end;
$$;
revoke all on function public.game_players_card_trg() from public, anon, authenticated;
drop trigger if exists game_players_card on public.game_players;
create trigger game_players_card before insert or update on public.game_players
  for each row execute function public.game_players_card_trg();

-- the lineup follows the chart, after the fact, so every existing way of
-- setting a depth keeps working and the slot is still a row of its own
create or replace function public.game_players_lineup_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_starters integer;
begin
  if NEW.card_id is null then return NEW; end if;
  delete from public.game_lineup_slots where card_id = NEW.card_id;
  if NEW.franchise_id is null or NEW.status <> 'active' then return NEW; end if;
  select coalesce((x->>'starters')::int, 1) into v_starters
    from jsonb_array_elements(public.franchise_pool_plan()) x where x->>'pos' = NEW.position;
  if NEW.depth is null or NEW.depth < 1 or NEW.depth > coalesce(v_starters, 1) then return NEW; end if;
  insert into public.game_lineup_slots (franchise_id, position, slot, card_id, updated_at)
  values (NEW.franchise_id, NEW.position, NEW.depth, NEW.card_id, now())
  on conflict (franchise_id, position, slot) do update
    set card_id = excluded.card_id, updated_at = now();
  return NEW;
end;
$$;
revoke all on function public.game_players_lineup_trg() from public, anon, authenticated;
drop trigger if exists game_players_lineup on public.game_players;
create trigger game_players_lineup after insert or update on public.game_players
  for each row execute function public.game_players_lineup_trg();

-- ── THE MIGRATION ────────────────────────────────────────────────────────
-- Every existing row minted, every listing pointed at its card, every sale
-- already on the books turned into a transaction and a price. Runs whole or
-- not at all, and a second run does nothing.
create or replace function public.franchise_cards_migrate()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.game_players%rowtype; l public.franchise_listings%rowtype;
  v_cards integer := 0; v_lists integer := 0; v_txns integer := 0; v_slots integer := 0; v_card uuid; v_def uuid; v_ident uuid;
begin
  for p in select * from public.game_players where card_id is null order by created_at loop
    v_card := public.franchise_card_mint(p, coalesce(p.acquired_source, 'migration'), p.acquired_detail);
    if v_card is not null then
      perform set_config('edgd.card_transfer', '1', true);
      update public.game_players set card_id = v_card where id = p.id;
      perform set_config('edgd.card_transfer', '', true);
      v_cards := v_cards + 1;
    end if;
  end loop;
  -- the lineup, rebuilt from the chart as it stands
  insert into public.game_lineup_slots (franchise_id, position, slot, card_id, updated_at)
  select gp.franchise_id, gp.position, gp.depth, gp.card_id, now()
    from public.game_players gp
    join jsonb_array_elements(public.franchise_pool_plan()) x on x->>'pos' = gp.position
   where gp.card_id is not null and gp.franchise_id is not null and gp.status = 'active'
     and gp.depth between 1 and coalesce((x->>'starters')::int, 1)
  on conflict (franchise_id, position, slot) do nothing;
  get diagnostics v_slots = ROW_COUNT;
  -- every listing offers the instance the man is
  update public.franchise_listings l2
     set card_id = gp.card_id
    from public.game_players gp
   where gp.id = l2.player_id and l2.card_id is null and gp.card_id is not null;
  get diagnostics v_lists = ROW_COUNT;
  -- and every sale already on the books is a transaction and a price
  for l in select * from public.franchise_listings where status = 'sold' and card_id is not null
             and not exists (select 1 from public.game_market_txns t where t.listing_id = franchise_listings.id) loop
    insert into public.game_market_txns (listing_id, card_id, seller_id, buyer_id, sale_price, fee, net, completed_at, op_key)
    values (l.id, l.card_id, l.franchise_id, l.buyer_id, l.price, coalesce(l.fee, 0), coalesce(l.net, l.price), coalesce(l.closed_at, now()),
            'migrate:' || l.id::text)
    on conflict do nothing;
    select c.card_def_id, d.player_id into v_def, v_ident
      from public.game_cards c join public.game_card_defs d on d.id = c.card_def_id where c.id = l.card_id;
    if v_def is not null then
      insert into public.game_market_prices (card_def_id, player_id, position, overall, sale_price, sold_at)
      select v_def, v_ident, coalesce(l.snapshot->>'position', 'QB'), coalesce((l.snapshot->>'overall')::int, 60), l.price, coalesce(l.closed_at, now())
       where not exists (select 1 from public.game_market_prices h where h.card_def_id = v_def and h.sold_at = coalesce(l.closed_at, now()));
      v_txns := v_txns + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'version', public.franchise_cards_rules()->>'version',
    'cards_minted', v_cards, 'lineup_slots', v_slots, 'listings_linked', v_lists, 'sales_recorded', v_txns,
    'cards_total', (select count(*) from public.game_cards), 'owned', (select count(*) from public.game_card_ownership where owner_id is not null));
end;
$$;
revoke all on function public.franchise_cards_migrate() from public, anon, authenticated;

select public.franchise_cards_migrate();

-- ── THE COMPATIBILITY ADAPTER ────────────────────────────────────────────
-- Gameplay wants one flat object. It gets one, assembled from the four
-- separate things rather than from one conflated row: who he is, what his
-- card says, who holds it and where it plays.
create or replace function public.franchise_card_entity(p_card uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'card_id', c.id,
    'serial', c.serial_number,
    'minted_at', c.minted_at,
    'edition', jsonb_build_object('id', d.id, 'name', d.edition, 'program', d.program, 'rarity', d.rarity,
                                  'base_overall', d.base_overall, 'art', d.art_variant,
                                  'supply', d.supply_limit, 'serial', c.serial_number,
                                  'label', case when d.supply_limit = 1 then 'One of one'
                                                else 'No. ' || coalesce(c.serial_number, 1) || ' of ' || coalesce(d.supply_limit::text, '∞') end),
    'player', jsonb_build_object('id', i.id, 'first_name', i.first_name, 'last_name', i.last_name,
                                 'position', i.position, 'archetype', i.archetype, 'hometown', i.hometown,
                                 'height_in', i.height_in, 'weight_lb', i.weight_lb),
    'ownership', jsonb_build_object('owner_id', o.owner_id, 'acquired_at', o.acquired_at,
                                    'acquisition_type', o.acquisition_type, 'acquisition_ref', o.acquisition_ref,
                                    'hands', (select count(*) from public.game_card_provenance v where v.card_id = c.id)),
    'lineup', case when s.card_id is null then null else jsonb_build_object('position', s.position, 'slot', s.slot) end,
    'listing', (select jsonb_build_object('id', l.id, 'price', l.price, 'expires_at', l.expires_at)
                  from public.franchise_listings l where l.card_id = c.id and l.status = 'open' limit 1),
    -- the career sheet, as gameplay has always read it
    'career', case when gp.id is null then null else public.franchise_prospect_json(gp) || public.franchise_profile_of(gp) end)
    from public.game_cards c
    join public.game_card_defs d on d.id = c.card_def_id
    join public.game_player_identities i on i.id = d.player_id
    left join public.game_card_ownership o on o.card_id = c.id
    left join public.game_lineup_slots s on s.card_id = c.id
    left join public.game_players gp on gp.card_id = c.id
   where c.id = p_card;
$$;
grant execute on function public.franchise_card_entity(uuid) to anon, authenticated;

-- what a card has sold for, and what men like it have: the price history is
-- the card's, the comps are the edition's shape
create or replace function public.franchise_card_market(p_card uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'sales', coalesce((select jsonb_agg(jsonb_build_object('price', h.sale_price, 'at', h.sold_at) order by h.sold_at desc)
                         from (select * from public.game_market_prices h2
                                where h2.card_def_id = (select card_def_id from public.game_cards where id = p_card)
                                order by h2.sold_at desc limit 10) h), '[]'::jsonb),
    'comps', (select public.franchise_exchange_comps(i.position, d.base_overall)
                from public.game_cards c join public.game_card_defs d on d.id = c.card_def_id
                join public.game_player_identities i on i.id = d.player_id where c.id = p_card),
    'provenance', coalesce((select jsonb_agg(jsonb_build_object('type', v.acquisition_type, 'price', v.price, 'at', v.at) order by v.at desc)
                              from public.game_card_provenance v where v.card_id = p_card), '[]'::jsonb));
$$;
grant execute on function public.franchise_card_market(uuid) to anon, authenticated;

-- A LISTING SAYS WHAT IS FOR SALE. Re-created here, where the card tables
-- exist: the board trades an instance, and the tile can print its edition,
-- its serial, how many hands it has been through and what it has sold for.
create or replace function public.franchise_listing_json(l public.franchise_listings, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', l.id, 'price', l.price, 'status', l.status, 'reason', l.reason,
    'fee', public.franchise_exchange_fee(l.price), 'net', l.price - public.franchise_exchange_fee(l.price),
    'created_at', l.created_at, 'expires_at', l.expires_at, 'closed_at', l.closed_at,
    'mine', l.franchise_id = p_viewer,
    'seller', (select jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme)
                 from public.franchises f where f.id = l.franchise_id),
    'buyer', (select jsonb_build_object('name', f.name, 'city', f.city, 'abbr', f.abbr) from public.franchises f where f.id = l.buyer_id),
    'man', l.snapshot || coalesce((select jsonb_build_object('overall', p.overall, 'age', p.age, 'potential', p.potential,
                                            'available', public.franchise_is_available(p.status, p.injured_until))
                                     from public.game_players p where p.id = l.player_id and l.status = 'open'), '{}'::jsonb),
    'card_id', l.card_id,
    'card', (select jsonb_build_object('id', c.id, 'serial', c.serial_number, 'minted_at', c.minted_at,
                      'edition', d.edition, 'program', d.program, 'rarity', d.rarity, 'base_overall', d.base_overall,
                      'supply', d.supply_limit,
                      'label', case when d.supply_limit = 1 then 'One of one'
                                    else 'No. ' || coalesce(c.serial_number, 1) || ' of ' || coalesce(d.supply_limit::text, '?') end,
                      'hands', (select count(*) from public.game_card_provenance v where v.card_id = c.id),
                      'sales', coalesce((select jsonb_agg(jsonb_build_object('price', h.sale_price, 'at', h.sold_at) order by h.sold_at desc)
                                           from public.game_market_prices h where h.card_def_id = d.id), '[]'::jsonb))
                 from public.game_cards c join public.game_card_defs d on d.id = c.card_def_id where c.id = l.card_id),
    'asking_reference', public.franchise_signing_cost((l.snapshot->>'overall')::int));
$$;

-- ── THE EXCHANGE TRADES CARDS ────────────────────────────────────────────
-- A listing offers an INSTANCE. The seller must still own that instance
-- when it sells, the money moves once, ownership moves through the one
-- door, and the sale is written as a transaction and a price. An operation
-- key makes a repeated request the same purchase rather than a second one.
create or replace function public.franchise_exchange_list(p_player uuid, p_price integer, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); rules jsonb := public.franchise_exchange_rules(); p public.game_players%rowtype;
  v_why text; n integer; l public.franchise_listings%rowtype; v_new text[] := '{}'; v_owner uuid;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  perform public.franchise_exchange_sweep();
  perform 1 from public.franchises where id = v_f for update;
  if p_price is null or p_price < (rules->>'min_price')::int or p_price > (rules->>'max_price')::int then
    raise exception 'a price is between % and % Credits', (rules->>'min_price')::int, (rules->>'max_price')::int using errcode = '22023';
  end if;
  select count(*) into n from public.franchise_listings where franchise_id = v_f and status = 'open';
  if n >= (rules->>'max_open')::int then
    raise exception 'you can have % listings open at once', (rules->>'max_open')::int using errcode = '55000';
  end if;
  v_why := public.franchise_exchange_illegal(v_f, p_player);
  if v_why is not null then raise exception '%', v_why using errcode = '55000'; end if;
  select * into p from public.game_players where id = p_player for update;
  -- THE SELLER MUST OWN THE CARD, not merely have the career sheet
  select owner_id into v_owner from public.game_card_ownership where card_id = p.card_id;
  if p.card_id is null or v_owner is distinct from v_f then
    raise exception 'you do not own that card' using errcode = '55000';
  end if;
  if exists (select 1 from public.franchise_listings where card_id = p.card_id and status = 'open') then
    raise exception 'he is already listed' using errcode = '55000';
  end if;
  insert into public.franchise_listings (franchise_id, player_id, card_id, price, snapshot, expires_at)
  values (v_f, p.id, p.card_id, p_price,
          public.franchise_prospect_json(p) || public.franchise_profile_of(p)
            || jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'tier', public.franchise_card_tier(p.overall),
                                  'card_id', p.card_id),
          now() + ((rules->>'expires_days')::int || ' days')::interval)
  returning * into l;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_f, 'exchange_list', l.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('listing', l.id, 'player', p.id, 'card', p.card_id, 'name', p.first_name || ' ' || p.last_name,
                             'position', p.position, 'overall', p.overall, 'price', p_price, 'currency', 'tc'))
  on conflict (franchise_id, kind, key) do nothing;
  return jsonb_build_object('ok', true, 'listing', public.franchise_listing_json(l, v_f),
    'card', public.franchise_card_entity(p.card_id),
    'comps', public.franchise_exchange_comps(p.position, p.overall), 'achievements', to_jsonb(v_new));
end;
$$;

-- the two-argument door is retired: leaving it beside the three-argument one
-- makes every existing two-argument call ambiguous
drop function if exists public.franchise_exchange_buy(uuid, text);
create or replace function public.franchise_exchange_buy(p_listing uuid, p_secret text default null, p_op text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b uuid := public.franchise_of(p_secret); mk jsonb := public.franchise_market();
  l public.franchise_listings%rowtype; p public.game_players%rowtype; fb public.franchises%rowtype; fs public.franchises%rowtype;
  v_why text; v_fee integer; v_net integer; v_active integer; v_depth integer; ok boolean; v_real integer := public.games_season_of(now());
  v_new text[] := '{}'; k integer := 0; r record; v_owner uuid; v_txn public.game_market_txns%rowtype; v_def uuid; v_ident uuid;
  v_op text := nullif(p_op, '');
begin
  if v_b is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  -- A REPEATED REQUEST IS THE SAME PURCHASE. A dropped connection asks
  -- again with the key it used before, and gets the answer it already had.
  if v_op is not null then
    select * into v_txn from public.game_market_txns where op_key = v_op;
    if found then
      if v_txn.buyer_id is distinct from v_b then raise exception 'that operation belongs to another franchise' using errcode = '55000'; end if;
      select * into l from public.franchise_listings where id = v_txn.listing_id;
      return jsonb_build_object('ok', true, 'already', true, 'listing', public.franchise_listing_json(l, v_b),
        'card', public.franchise_card_entity(v_txn.card_id), 'price', v_txn.sale_price, 'fee', v_txn.fee, 'net', v_txn.net,
        'currency', 'tc', 'transaction', v_txn.id, 'totals', public.franchise_totals(v_b));
    end if;
  end if;
  select * into l from public.franchise_listings where id = p_listing for update;
  if not found then raise exception 'no such listing' using errcode = 'P0002'; end if;
  if l.status <> 'open' then raise exception 'that listing is closed: %', coalesce(l.reason, l.status) using errcode = '55000'; end if;
  if l.expires_at < now() then
    update public.franchise_listings set status = 'expired', reason = 'the listing ran out', closed_at = now() where id = l.id;
    raise exception 'that listing has expired' using errcode = '55000';
  end if;
  if l.franchise_id = v_b then raise exception 'that is your own listing' using errcode = '55000'; end if;
  perform 1 from public.franchises where id in (l.franchise_id, v_b) order by id for update;
  select * into fs from public.franchises where id = l.franchise_id;
  select * into fb from public.franchises where id = v_b;
  select * into p from public.game_players where id = l.player_id for update;
  -- THE SELLER STILL OWNS THE CARD. Checked against the ownership record,
  -- not against a column on the career sheet.
  select owner_id into v_owner from public.game_card_ownership where card_id = coalesce(l.card_id, p.card_id) for update;
  if v_owner is distinct from l.franchise_id then
    update public.franchise_listings set status = 'expired', reason = 'the seller no longer holds that card', closed_at = now() where id = l.id;
    raise exception 'that listing is no longer good: the seller no longer holds that card' using errcode = '55000';
  end if;
  v_why := public.franchise_exchange_illegal(l.franchise_id, l.player_id);
  if v_why is not null then
    update public.franchise_listings set status = 'expired', reason = v_why, closed_at = now() where id = l.id;
    raise exception 'that listing is no longer good: %', v_why using errcode = '55000';
  end if;
  select count(*) into v_active from public.game_players where franchise_id = v_b and status = 'active';
  if v_active >= (mk->>'roster_max')::int then
    raise exception 'the roster is full at %: release a player first', (mk->>'roster_max')::int using errcode = '55000';
  end if;
  if fb.team_credits < l.price then
    raise exception 'not enough Credits: % needed, % on hand', l.price, fb.team_credits using errcode = '55000';
  end if;
  v_fee := public.franchise_exchange_fee(l.price); v_net := l.price - v_fee;
  ok := public.franchise_credit(v_b, 'tc', -l.price, 'exchange_buy', l.id::text, 'Bought ' || p.first_name || ' ' || p.last_name || ' on the Exchange');
  if not ok then raise exception 'that purchase is already on the books' using errcode = '55000'; end if;
  perform public.franchise_credit(l.franchise_id, 'tc', v_net, 'exchange_sale', l.id::text,
    'Sold ' || p.first_name || ' ' || p.last_name || ' on the Exchange (' || v_fee || ' fee)');
  -- OWNERSHIP MOVES THROUGH THE ONE DOOR
  perform public.franchise_card_transfer(coalesce(l.card_id, p.card_id), v_b, 'market', l.id::text, l.price);
  select coalesce(max(depth), 0) + 1 into v_depth from public.game_players where franchise_id = v_b and position = p.position and status = 'active' and id <> p.id;
  update public.game_players
     set depth = v_depth,
         jersey = case when exists (select 1 from public.game_players o where o.franchise_id = v_b and o.status = 'active' and o.jersey = p.jersey and o.id <> p.id)
                       then public.franchise_free_number(v_b, p.position, p.id::text) else p.jersey end,
         acquired_source = 'market', acquired_season = v_real,
         acquired_detail = 'Bought on the Exchange from the ' || fs.name || ' for ' || l.price || ' Credits',
         history = history || jsonb_build_object('kind', 'sold', 'at', now(), 'price', l.price, 'fee', v_fee,
                                                 'from', fs.name, 'to', fb.name, 'overall', p.overall),
         updated_at = now()
   where id = p.id;
  for r in select id from public.game_players where franchise_id = l.franchise_id and position = p.position and status = 'active' order by depth, overall desc loop
    k := k + 1; update public.game_players set depth = k where id = r.id;
  end loop;
  update public.franchise_listings set status = 'sold', buyer_id = v_b, fee = v_fee, net = v_net, closed_at = now() where id = l.id returning * into l;
  -- THE TRANSACTION. The unique index on the listing is what makes a second
  -- buyer impossible rather than unlikely.
  insert into public.game_market_txns (listing_id, card_id, seller_id, buyer_id, sale_price, fee, net, op_key)
  values (l.id, coalesce(l.card_id, p.card_id), l.franchise_id, v_b, l.price, v_fee, v_net, v_op)
  returning * into v_txn;
  select c.card_def_id, d.player_id into v_def, v_ident
    from public.game_cards c join public.game_card_defs d on d.id = c.card_def_id where c.id = coalesce(l.card_id, p.card_id);
  insert into public.game_market_prices (card_def_id, player_id, position, overall, sale_price)
  values (v_def, v_ident, p.position, p.overall, l.price);
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
  values (v_b, 'exchange_buy', l.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('listing', l.id, 'player', p.id, 'card', coalesce(l.card_id, p.card_id), 'name', p.first_name || ' ' || p.last_name,
                             'position', p.position, 'overall', p.overall, 'price', l.price, 'from', fs.name, 'currency', 'tc')),
         (l.franchise_id, 'exchange_sale', l.id::text, public.games_week_key(now()), public.games_day_key(now()),
          jsonb_build_object('listing', l.id, 'player', p.id, 'card', coalesce(l.card_id, p.card_id), 'name', p.first_name || ' ' || p.last_name,
                             'position', p.position, 'overall', p.overall, 'price', l.price, 'fee', v_fee, 'net', v_net, 'to', fb.name, 'currency', 'tc'))
  on conflict (franchise_id, kind, key) do nothing;
  if public.franchise_award(v_b, 'exchange_first_buy', v_real, jsonb_build_object('listing', l.id, 'price', l.price)) then
    v_new := array_append(v_new, 'exchange_first_buy'); end if;
  perform public.franchise_award(l.franchise_id, 'exchange_first_sale', v_real, jsonb_build_object('listing', l.id, 'price', l.price));
  select * into p from public.game_players where id = p.id;
  return jsonb_build_object('ok', true, 'already', false, 'listing', public.franchise_listing_json(l, v_b),
    'player', public.franchise_prospect_json(p) || public.franchise_profile_of(p),
    'card', public.franchise_card_entity(coalesce(l.card_id, p.card_id)),
    'price', l.price, 'fee', v_fee, 'net', v_net, 'currency', 'tc', 'transaction', v_txn.id,
    'roster_active', v_active + 1, 'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(v_b));
end;
$$;
grant execute on function public.franchise_exchange_buy(uuid, text, text) to anon, authenticated;

-- WHAT HAPPENED TO MY PURCHASE. A client whose connection dropped mid-buy
-- asks with the key it used; the answer is never "maybe".
create or replace function public.franchise_market_op(p_op text, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); t public.game_market_txns%rowtype;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  select * into t from public.game_market_txns where op_key = p_op and buyer_id = v_f;
  if not found then return jsonb_build_object('ok', true, 'state', 'not_completed', 'op', p_op); end if;
  return jsonb_build_object('ok', true, 'state', 'completed', 'op', p_op, 'transaction', t.id,
    'card', public.franchise_card_entity(t.card_id), 'price', t.sale_price, 'fee', t.fee,
    'completed_at', t.completed_at, 'totals', public.franchise_totals(v_f));
end;
$$;
grant execute on function public.franchise_market_op(text, text) to anon, authenticated;

select public.games_schema_note('franchise', 22, 'the card is not the man: identity, edition, instance, ownership');
commit;



-- ===========================================================================
-- PHASE 23 — THE LIVING SEASON (season_v1)
--
-- A season that only tells you your own record is a spreadsheet. This phase
-- gives it three things it was missing, all of them derived from what has
-- actually happened and none of them invented:
--
--   POWER RANKINGS   every club in the league rated weekly, with movement
--   AWARD RACES      the men actually having seasons, ranked by performance
--   THE CHAMPIONSHIP a game that does not look like the other eight
--
-- WHAT THE RANKINGS ARE HONEST ABOUT. Your franchise has a record because it
-- has played games. The other clubs are opponents: they have rosters and
-- ratings, and they have whatever they have shown against you, and that is
-- all the record knows about them. So the model rates every club on ROSTER
-- STRENGTH and adjusts it by EVIDENCE — results, margins, who they came
-- against, and how recent they were. Nothing simulates a game that was never
-- played, and nothing sorts by record alone. Every row carries the reason it
-- is where it is, in the numbers that put it there.
--
-- WHAT THE AWARDS ARE HONEST ABOUT. A man is a candidate when the record
-- holds a season line for him. That is every man on your roster, because
-- those are the men whose games are written down. The score is
-- position-specific, per-game where volume would otherwise decide it, and
-- weighted by what the team did and who it played. Nobody is picked by
-- overall, and nobody is picked at random.
-- ===========================================================================
begin;

create or replace function public.franchise_season_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'season_v1',
    -- THE POWER RATING, PRINTED. Anyone can check the arithmetic.
    'power', jsonb_build_object(
      'base', 'roster strength, on the same scale the league is drawn on',
      'win_pct', 26,          -- what a perfect record is worth over a winless one
      'margin_cap', 21,       -- a blowout past this counts as this
      'margin', 10,           -- what an average margin of the cap is worth
      'sos', 8,               -- what playing the top of the league is worth
      'form', 6,              -- the last three, over the season
      'quality_win', 3.0,     -- each win over a club rated above you
      'bad_loss', -3.5,       -- each loss to a club rated well below you
      'home_road', 1.5,       -- a road win counts for a little more
      'unplayed_pull', 0.35), -- a club that has not played is pulled toward its roster
    'awards', jsonb_build_array(
      jsonb_build_object('key', 'poy',  'name', 'Player of the Year',           'pos', jsonb_build_array('QB','RB','WR','TE','OL','DL','LB','CB','S')),
      jsonb_build_object('key', 'opoy', 'name', 'Offensive Player of the Year', 'pos', jsonb_build_array('QB','RB','WR','TE')),
      jsonb_build_object('key', 'dpoy', 'name', 'Defensive Player of the Year', 'pos', jsonb_build_array('DL','LB','CB','S')),
      jsonb_build_object('key', 'qb',   'name', 'Quarterback of the Year',      'pos', jsonb_build_array('QB')),
      jsonb_build_object('key', 'rb',   'name', 'Back of the Year',             'pos', jsonb_build_array('RB')),
      jsonb_build_object('key', 'wr',   'name', 'Receiver of the Year',         'pos', jsonb_build_array('WR','TE')),
      jsonb_build_object('key', 'rush', 'name', 'Pass Rusher of the Year',      'pos', jsonb_build_array('DL','LB')),
      jsonb_build_object('key', 'db',   'name', 'Defensive Back of the Year',   'pos', jsonb_build_array('CB','S')),
      jsonb_build_object('key', 'rook', 'name', 'Rookie of the Year',           'pos', jsonb_build_array('QB','RB','WR','TE','OL','DL','LB','CB','S')),
      jsonb_build_object('key', 'clutch','name', 'Clutch Player of the Year',   'pos', jsonb_build_array('QB','RB','WR','TE','DL','LB','CB','S'))),
    'candidates', 5);
$$;
grant execute on function public.franchise_season_rules() to anon, authenticated;

-- ── THE RANKINGS, WEEK BY WEEK ───────────────────────────────────────────
create table if not exists public.franchise_rank_weeks (
  franchise_id  uuid not null references public.franchises (id) on delete cascade,
  season_number integer not null,
  week          integer not null check (week >= 0),
  computed_at   timestamptz not null default now(),
  rows          jsonb not null default '[]'::jsonb,
  primary key (franchise_id, season_number, week)
);
create table if not exists public.franchise_award_weeks (
  franchise_id  uuid not null references public.franchises (id) on delete cascade,
  season_number integer not null,
  week          integer not null check (week >= 0),
  computed_at   timestamptz not null default now(),
  races         jsonb not null default '[]'::jsonb,
  primary key (franchise_id, season_number, week)
);
alter table public.franchise_rank_weeks enable row level security;
alter table public.franchise_award_weeks enable row level security;
drop policy if exists franchise_rank_weeks_own on public.franchise_rank_weeks;
create policy franchise_rank_weeks_own on public.franchise_rank_weeks for select using (public.franchise_is_mine(franchise_id));
drop policy if exists franchise_award_weeks_own on public.franchise_award_weeks;
create policy franchise_award_weeks_own on public.franchise_award_weeks for select using (public.franchise_is_mine(franchise_id));

-- THE CHAMPIONSHIP is a game row like any other, flagged so the pages can
-- treat it like nothing else.
alter table public.franchise_games add column if not exists championship boolean not null default false;

-- ── THE POWER RATING ─────────────────────────────────────────────────────
-- One number per club, built from roster strength and moved by evidence.
-- Every term is in the rules above and every row says which ones moved it.
create or replace function public.franchise_power_rankings(p_franchise uuid, p_season integer default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  rules jsonb := public.franchise_season_rules()->'power';
  f public.franchises%rowtype; s public.franchise_seasons%rowtype;
  v_rows jsonb := '[]'::jsonb; r record; me jsonb;
  v_played integer; v_w integer; v_l integer; v_pf integer; v_pa integer; v_margin numeric;
  v_sos numeric; v_form numeric; v_qw integer; v_bl integer; v_road integer; v_rating numeric; v_why text[];
  v_season integer;
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then return null; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise
    and number = coalesce(p_season, (select max(number) from public.franchise_seasons where franchise_id = p_franchise));
  if not found then return null; end if;
  v_season := s.number;

  -- YOUR CLUB, ON THE EVIDENCE
  select count(*), count(*) filter (where result = 'W'), count(*) filter (where result = 'L'),
         coalesce(sum(score_for), 0), coalesce(sum(score_against), 0)
    into v_played, v_w, v_l, v_pf, v_pa
    from public.franchise_games where franchise_id = p_franchise and season_number = v_season and status = 'final';
  v_margin := case when v_played > 0 then (v_pf - v_pa)::numeric / v_played else 0 end;
  select coalesce(avg(coalesce((g.opponent->>'overall')::int, o.strength, 70)), 70) into v_sos
    from public.franchise_games g left join public.franchise_opponents o on o.key = g.opponent_key
   where g.franchise_id = p_franchise and g.season_number = v_season and g.status = 'final';
  select coalesce(avg(case when result = 'W' then 1 when result = 'L' then 0 else 0.5 end), 0.5) into v_form
    from (select result from public.franchise_games where franchise_id = p_franchise and season_number = v_season
            and status = 'final' order by week desc limit 3) q;
  select count(*) filter (where g.result = 'W' and coalesce((g.opponent->>'overall')::int, 70) >= (public.franchise_team_rating(p_franchise)->>'overall')::int),
         count(*) filter (where g.result = 'L' and coalesce((g.opponent->>'overall')::int, 70) <= (public.franchise_team_rating(p_franchise)->>'overall')::int - 6),
         count(*) filter (where g.result = 'W' and not g.home)
    into v_qw, v_bl, v_road
    from public.franchise_games g where g.franchise_id = p_franchise and g.season_number = v_season and g.status = 'final';

  v_rating := (public.franchise_team_rating(p_franchise)->>'overall')::numeric;
  v_why := '{}';
  if v_played > 0 then
    v_rating := v_rating
      + (rules->>'win_pct')::numeric * ((v_w::numeric / v_played) - 0.5)
      + (rules->>'margin')::numeric * (greatest(-1, least(1, v_margin / (rules->>'margin_cap')::numeric)))
      + (rules->>'sos')::numeric * ((v_sos - 70) / 12.0)
      + (rules->>'form')::numeric * (v_form - 0.5)
      + (rules->>'quality_win')::numeric * v_qw
      + (rules->>'bad_loss')::numeric * v_bl
      + (rules->>'home_road')::numeric * v_road;
    if v_w >= 3 and v_l = 0 then v_why := array_append(v_why, v_w || ' straight to open'); end if;
    if v_form >= 0.99 and v_played >= 3 then v_why := array_append(v_why, '3 straight wins'); end if;
    if v_form <= 0.01 and v_played >= 3 then v_why := array_append(v_why, '3 straight losses'); end if;
    v_why := array_append(v_why, (case when v_margin >= 0 then '+' else '' end) || round(v_margin, 1) || ' average margin');
    if v_qw > 0 then v_why := array_append(v_why, v_qw || ' win' || case when v_qw = 1 then '' else 's' end || ' over a club rated above you'); end if;
    if v_bl > 0 then v_why := array_append(v_why, v_bl || ' loss' || case when v_bl = 1 then '' else 'es' end || ' to a club well below'); end if;
    v_why := array_append(v_why, 'strength of schedule ' || round(v_sos)::text);
  else
    v_why := array_append(v_why, 'no games played yet: rated on the roster');
  end if;
  me := jsonb_build_object('key', 'me', 'mine', true, 'id', f.id,
    'city', f.city, 'name', f.name, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
    'wins', v_w, 'losses', v_l, 'played', v_played,
    'roster', (public.franchise_team_rating(p_franchise)->>'overall')::int,
    'rating', round(v_rating, 1), 'why', to_jsonb(v_why),
    'margin', round(v_margin, 1), 'sos', round(v_sos), 'quality_wins', v_qw, 'bad_losses', v_bl);
  v_rows := v_rows || me;

  -- EVERY OTHER CLUB, ON ITS ROSTER AND ON WHAT IT HAS SHOWN AGAINST YOU
  for r in
    select o.key, o.city, o.name, o.abbr, o.logo, o.theme, o.strength,
           count(g.id) filter (where g.status = 'final') as played,
           count(g.id) filter (where g.status = 'final' and g.result = 'L') as wins_vs_me,
           count(g.id) filter (where g.status = 'final' and g.result = 'W') as losses_vs_me,
           coalesce(avg(case when g.status = 'final' then g.score_against - g.score_for end), 0) as margin_vs_me
      from public.franchise_opponents o
      left join public.franchise_games g
        on g.opponent_key = o.key and g.franchise_id = p_franchise and g.season_number = v_season
     group by o.key, o.city, o.name, o.abbr, o.logo, o.theme, o.strength
  loop
    v_why := '{}';
    v_rating := r.strength::numeric;
    if r.played > 0 then
      -- what they showed: their margin against you, against your own rating
      v_rating := v_rating
        + (rules->>'margin')::numeric * greatest(-1, least(1, r.margin_vs_me / (rules->>'margin_cap')::numeric)) * 0.8
        + (rules->>'quality_win')::numeric * r.wins_vs_me
        + (rules->>'bad_loss')::numeric * r.losses_vs_me * 0.6;
      v_why := array_append(v_why, r.wins_vs_me || '-' || r.losses_vs_me || ' against you, '
        || (case when r.margin_vs_me >= 0 then '+' else '' end) || round(r.margin_vs_me, 1));
    else
      -- unplayed: pulled gently toward the middle, because nothing is known
      v_rating := v_rating + (rules->>'unplayed_pull')::numeric * (70 - r.strength);
      v_why := array_append(v_why, 'not played yet: rated on the roster');
    end if;
    v_rows := v_rows || jsonb_build_object('key', r.key, 'mine', false,
      'city', r.city, 'name', r.name, 'abbr', r.abbr, 'logo', r.logo, 'theme', r.theme,
      'wins', r.wins_vs_me, 'losses', r.losses_vs_me, 'played', r.played,
      'roster', r.strength, 'rating', round(v_rating, 1), 'why', to_jsonb(v_why),
      'margin', round(r.margin_vs_me, 1), 'sos', null, 'quality_wins', r.wins_vs_me, 'bad_losses', 0);
  end loop;

  -- ranked, and told what rank it is
  return (select jsonb_agg(x || jsonb_build_object('rank', rn) order by rn)
            from (select x, row_number() over (order by (x->>'rating')::numeric desc, (x->>'roster')::int desc, x->>'abbr') rn
                    from jsonb_array_elements(v_rows) x) q);
end;
$$;
revoke all on function public.franchise_power_rankings(uuid, integer) from public, anon, authenticated;

-- ── THE SNAPSHOT, AND THE MOVEMENT ───────────────────────────────────────
-- Written once a week. Movement is this week's rank against the last week
-- that was written, so a jump is a fact rather than a flourish.
create or replace function public.franchise_rankings_write(p_franchise uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.franchise_seasons%rowtype; v_now jsonb; v_prev jsonb; v_out jsonb;
begin
  select * into s from public.franchise_seasons where franchise_id = p_franchise
    order by number desc limit 1;
  if not found then return null; end if;
  v_now := public.franchise_power_rankings(p_franchise, s.number);
  if v_now is null then return null; end if;
  select rows into v_prev from public.franchise_rank_weeks
   where franchise_id = p_franchise and season_number = s.number and week < s.week
   order by week desc limit 1;
  v_out := (select jsonb_agg(x || jsonb_build_object(
      'previous', p.rank, 'movement', case when p.rank is null then null else p.rank - (x->>'rank')::int end)
      order by (x->>'rank')::int)
    from jsonb_array_elements(v_now) x
    left join lateral (select (y->>'rank')::int rank from jsonb_array_elements(coalesce(v_prev, '[]'::jsonb)) y
                        where y->>'key' = x->>'key' limit 1) p on true);
  insert into public.franchise_rank_weeks (franchise_id, season_number, week, rows, computed_at)
  values (p_franchise, s.number, s.week, v_out, now())
  on conflict (franchise_id, season_number, week) do update set rows = excluded.rows, computed_at = now();
  return v_out;
end;
$$;
revoke all on function public.franchise_rankings_write(uuid) from public, anon, authenticated;

-- WHAT MOVED THIS WEEK. Risers, fallers, the biggest jump, the biggest drop
-- and anyone new in the top ten — all read off the two snapshots.
create or replace function public.franchise_rankings(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); s public.franchise_seasons%rowtype; v_rows jsonb; v_week integer;
begin
  if v_f is null then return null; end if;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found then return null; end if;
  select rows, week into v_rows, v_week from public.franchise_rank_weeks
   where franchise_id = v_f and season_number = s.number order by week desc limit 1;
  if v_rows is null then v_rows := public.franchise_power_rankings(v_f, s.number); v_week := s.week; end if;
  return jsonb_build_object(
    'version', public.franchise_season_rules()->>'version',
    'season', s.number, 'label', s.label, 'week', v_week,
    'rows', v_rows,
    'me', (select x from jsonb_array_elements(v_rows) x where (x->>'mine')::boolean limit 1),
    'risers', coalesce((select jsonb_agg(x order by (x->>'movement')::int desc)
                          from jsonb_array_elements(v_rows) x where (x->>'movement')::int > 0), '[]'::jsonb),
    'fallers', coalesce((select jsonb_agg(x order by (x->>'movement')::int)
                           from jsonb_array_elements(v_rows) x where (x->>'movement')::int < 0), '[]'::jsonb),
    'biggest_jump', (select x from jsonb_array_elements(v_rows) x where x ? 'movement' and (x->>'movement')::int > 0
                      order by (x->>'movement')::int desc limit 1),
    'biggest_drop', (select x from jsonb_array_elements(v_rows) x where x ? 'movement' and (x->>'movement')::int < 0
                      order by (x->>'movement')::int limit 1),
    'new_top_ten', coalesce((select jsonb_agg(x) from jsonb_array_elements(v_rows) x
                              where (x->>'rank')::int <= 10 and (x->>'previous') is not null and (x->>'previous')::int > 10), '[]'::jsonb));
end;
$$;
grant execute on function public.franchise_rankings(text) to anon, authenticated;

-- ── THE AWARD SCORE ──────────────────────────────────────────────────────
-- Position-specific, per game, and blind to overall. A back is measured
-- against what a back does; a corner against what a corner does. Volume
-- cannot win a race on its own because every term is a rate, and the two
-- multipliers — what the team did and who it played — move a score by a
-- fifth at the very most.
--
-- The reference is the season a very good player at that position has. A
-- score of 100 is a season nobody argues with; 50 is a starter having a
-- year. The arithmetic is printed in the rules so any number on the page
-- can be checked.
create or replace function public.franchise_award_refs()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'QB', 30, 'RB', 22, 'WR', 20, 'TE', 20,
    'DL', 20, 'LB', 20, 'CB', 16, 'S', 16);
$$;
grant execute on function public.franchise_award_refs() to anon, authenticated;

create or replace function public.franchise_award_score(p_pos text, p_st jsonb, p_win_pct numeric, p_sos numeric)
returns jsonb language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  g numeric := greatest(1, coalesce((p_st->>'games')::numeric, 0));
  raw numeric := 0; ref numeric := coalesce((public.franchise_award_refs()->>p_pos)::numeric, 20);
  team numeric := 0.86 + 0.28 * coalesce(p_win_pct, 0.5);
  sched numeric := greatest(0.85, least(1.12, 0.94 + 0.12 * (coalesce(p_sos, 70) - 70) / 12.0));
  parts jsonb := '{}'::jsonb; ypc numeric; cmp_pct numeric;
begin
  if coalesce((p_st->>'games')::int, 0) <= 0 then
    return jsonb_build_object('score', 0, 'raw', 0, 'games', 0, 'parts', '{}'::jsonb);
  end if;
  case p_pos
    when 'QB' then
      cmp_pct := case when coalesce((p_st->>'att')::numeric, 0) > 0
                      then 100 * coalesce((p_st->>'cmp')::numeric, 0) / (p_st->>'att')::numeric else 55 end;
      parts := jsonb_build_object(
        'passing',  round(0.055 * coalesce((p_st->>'yds')::numeric, 0) / g, 2),
        'touchdowns', round(4.2 * coalesce((p_st->>'td')::numeric, 0) / g, 2),
        'giveaways', round(-3.4 * coalesce((p_st->>'int')::numeric, 0) / g, 2),
        'accuracy', round(0.30 * (cmp_pct - 55), 2),
        'legs', round(0.05 * coalesce((p_st->>'rush_yds')::numeric, 0) / g
                    + 3.0 * coalesce((p_st->>'rush_td')::numeric, 0) / g, 2));
    when 'RB' then
      ypc := case when coalesce((p_st->>'car')::numeric, 0) > 0
                  then coalesce((p_st->>'yds')::numeric, 0) / (p_st->>'car')::numeric else 4.0 end;
      parts := jsonb_build_object(
        'rushing', round(0.10 * coalesce((p_st->>'yds')::numeric, 0) / g, 2),
        'touchdowns', round(5.0 * coalesce((p_st->>'td')::numeric, 0) / g, 2),
        'receiving', round(0.05 * coalesce((p_st->>'rec_yds')::numeric, 0) / g
                         + 3.0 * coalesce((p_st->>'rec_td')::numeric, 0) / g, 2),
        'per_carry', round(2.2 * (ypc - 4.0), 2));
    when 'WR', 'TE' then
      parts := jsonb_build_object(
        'receiving', round(0.105 * coalesce((p_st->>'yds')::numeric, 0) / g, 2),
        'touchdowns', round(5.5 * coalesce((p_st->>'td')::numeric, 0) / g, 2),
        'volume', round(0.80 * coalesce((p_st->>'rec')::numeric, 0) / g, 2));
    when 'DL', 'LB' then
      parts := jsonb_build_object(
        'pressure', round(9.0 * coalesce((p_st->>'sacks')::numeric, 0) / g, 2),
        'tackles', round(1.1 * coalesce((p_st->>'tkl')::numeric, 0) / g, 2),
        'takeaways', round(6.0 * coalesce((p_st->>'int')::numeric, 0) / g, 2));
    when 'CB', 'S' then
      parts := jsonb_build_object(
        'takeaways', round(11.0 * coalesce((p_st->>'int')::numeric, 0) / g, 2),
        'tackles', round(1.3 * coalesce((p_st->>'tkl')::numeric, 0) / g, 2),
        'pressure', round(5.0 * coalesce((p_st->>'sacks')::numeric, 0) / g, 2));
    else
      return jsonb_build_object('score', 0, 'raw', 0, 'games', (p_st->>'games')::int, 'parts', '{}'::jsonb);
  end case;
  select coalesce(sum(v::numeric), 0) into raw from jsonb_each_text(parts) t(k, v);
  return jsonb_build_object(
    'score', greatest(0, least(100, round(100 * raw / ref * team * sched)::int)),
    'raw', round(raw, 2), 'games', (p_st->>'games')::int, 'ref', ref,
    'team_mult', round(team, 3), 'schedule_mult', round(sched, 3), 'parts', parts);
end;
$$;
grant execute on function public.franchise_award_score(text, jsonb, numeric, numeric) to anon, authenticated;

-- THE LINE, IN WORDS. What a candidate card prints under the name.
create or replace function public.franchise_award_line(p_pos text, p_st jsonb)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_pos = 'QB' then coalesce((p_st->>'yds')::int, 0) || ' pass yds, ' || coalesce((p_st->>'td')::int, 0) || ' TD, '
                || coalesce((p_st->>'int')::int, 0) || ' INT'
                || case when coalesce((p_st->>'rush_yds')::int, 0) >= 60 then ', ' || (p_st->>'rush_yds')::int || ' rush' else '' end
    when p_pos = 'RB' then coalesce((p_st->>'yds')::int, 0) || ' rush yds, ' || coalesce((p_st->>'td')::int, 0) || ' TD'
                || case when coalesce((p_st->>'rec')::int, 0) > 0 then ', ' || (p_st->>'rec')::int || ' rec' else '' end
    when p_pos in ('WR', 'TE') then coalesce((p_st->>'rec')::int, 0) || ' rec, ' || coalesce((p_st->>'yds')::int, 0) || ' yds, '
                || coalesce((p_st->>'td')::int, 0) || ' TD'
    when p_pos in ('DL', 'LB', 'CB', 'S') then coalesce((p_st->>'tkl')::int, 0) || ' tkl, ' || coalesce((p_st->>'sacks')::int, 0) || ' sacks, '
                || coalesce((p_st->>'int')::int, 0) || ' INT'
    else coalesce((p_st->>'games')::int, 0) || ' games' end;
$$;
grant execute on function public.franchise_award_line(text, jsonb) to anon, authenticated;

-- ── THE RACES ────────────────────────────────────────────────────────────
-- Ten of them, updated every week, each with the five men actually having
-- the seasons. Nobody is here because of an overall and nobody is here at
-- random: a man is a candidate because the record holds a line for him.
--
-- WHAT THE RECORD HOLDS. Season lines are written for the men who played,
-- and the men who played are yours. Opponents are clubs, not rosters, so
-- there are no opposing candidates to invent — and none are invented. The
-- race is over the men whose games are written down.
--
-- CLUTCH is not a feeling. It is the same score computed over the one-score
-- games only, read back out of those games' own box scores.
create or replace function public.franchise_award_races(p_franchise uuid, p_season integer default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  rules jsonb := public.franchise_season_rules();
  s public.franchise_seasons%rowtype; v_season integer;
  v_played integer; v_w integer; v_sos numeric; v_win_pct numeric;
  v_close jsonb := '{}'::jsonb; v_close_games integer := 0;
  a jsonb; out_races jsonb := '[]'::jsonb; cand jsonb; ln jsonb; r record;
  v_pos text[]; v_n integer := coalesce((rules->>'candidates')::int, 5);
begin
  select * into s from public.franchise_seasons where franchise_id = p_franchise
    and number = coalesce(p_season, (select max(number) from public.franchise_seasons where franchise_id = p_franchise));
  if not found then return null; end if;
  v_season := s.number;
  select count(*), count(*) filter (where result = 'W') into v_played, v_w
    from public.franchise_games where franchise_id = p_franchise and season_number = v_season and status = 'final';
  v_win_pct := case when v_played > 0 then v_w::numeric / v_played else 0.5 end;
  select coalesce(avg(coalesce((g.opponent->>'overall')::int, o.strength, 70)), 70) into v_sos
    from public.franchise_games g left join public.franchise_opponents o on o.key = g.opponent_key
   where g.franchise_id = p_franchise and g.season_number = v_season and g.status = 'final';

  -- the one-score games, added up out of their own box scores
  select count(*) into v_close_games from public.franchise_games
   where franchise_id = p_franchise and season_number = v_season and status = 'final'
     and abs(coalesce(score_for, 0) - coalesce(score_against, 0)) <= 8;
  for ln in
    select x from public.franchise_games g, jsonb_array_elements(g.box->'players') x
     where g.franchise_id = p_franchise and g.season_number = v_season and g.status = 'final'
       and abs(coalesce(g.score_for, 0) - coalesce(g.score_against, 0)) <= 8
  loop
    v_close := v_close || jsonb_build_object(ln->>'id',
      public.games_jsonb_sum(coalesce(v_close->(ln->>'id'), '{}'::jsonb), ln->'stats'));
  end loop;

  for a in select * from jsonb_array_elements(rules->'awards') loop
    select array_agg(value::text) into v_pos from jsonb_array_elements_text(a->'pos');
    cand := '[]'::jsonb;
    for r in
      select p.id, p.first_name, p.last_name, p.position, p.jersey, p.overall, p.archetype, p.depth,
             p.acquired_season, p.acquired_source, p.status, p.card_id,
             case when a->>'key' = 'clutch' then coalesce(v_close->(p.id::text), '{}'::jsonb) else p.season_stats end as st
        from public.game_players p
       where p.franchise_id = p_franchise
         and p.status in ('active', 'injured')
         and p.position = any (v_pos)
         and coalesce(((case when a->>'key' = 'clutch' then coalesce(v_close->(p.id::text), '{}'::jsonb) else p.season_stats end)->>'games')::int, 0) > 0
         and (a->>'key' <> 'rook' or (p.acquired_season = v_season
              and coalesce((p.career_stats->>'games')::int, 0) <= coalesce((p.season_stats->>'games')::int, 0)))
    loop
      cand := cand || (public.franchise_award_score(r.position, r.st, v_win_pct, v_sos) || jsonb_build_object(
        'player_id', r.id, 'card_id', r.card_id,
        'name', r.first_name || ' ' || r.last_name, 'position', r.position, 'jersey', r.jersey,
        'archetype', r.archetype, 'depth', r.depth, 'status', r.status,
        'rookie', r.acquired_season = v_season and coalesce((r.st->>'games')::int, 0) > 0,
        'team_record', v_w || '-' || (v_played - v_w),
        'stats', r.st, 'line', public.franchise_award_line(r.position, r.st)));
    end loop;
    out_races := out_races || jsonb_build_object(
      'key', a->>'key', 'name', a->>'name',
      'basis', case when a->>'key' = 'clutch'
                    then v_close_games || ' one-score game' || case when v_close_games = 1 then '' else 's' end
                    else v_played || ' game' || case when v_played = 1 then '' else 's' end end,
      'candidates', coalesce((select jsonb_agg(x || jsonb_build_object('place', rn) order by rn)
        from (select x, row_number() over (order by (x->>'score')::int desc, (x->>'raw')::numeric desc, x->>'name') rn
                from jsonb_array_elements(cand) x) q where rn <= v_n), '[]'::jsonb));
  end loop;
  return out_races;
end;
$$;
revoke all on function public.franchise_award_races(uuid, integer) from public, anon, authenticated;

-- THE SNAPSHOT. Written weekly beside the rankings; movement is a man's
-- place this week against his place in the last week written down.
create or replace function public.franchise_awards_write(p_franchise uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.franchise_seasons%rowtype; v_now jsonb; v_prev jsonb; v_out jsonb;
begin
  select * into s from public.franchise_seasons where franchise_id = p_franchise order by number desc limit 1;
  if not found then return null; end if;
  v_now := public.franchise_award_races(p_franchise, s.number);
  if v_now is null then return null; end if;
  select races into v_prev from public.franchise_award_weeks
   where franchise_id = p_franchise and season_number = s.number and week < s.week
   order by week desc limit 1;
  v_out := (select jsonb_agg(race || jsonb_build_object('candidates', coalesce((
      select jsonb_agg(c || jsonb_build_object('previous', p.place,
               'movement', case when p.place is null then null else p.place - (c->>'place')::int end)
             order by (c->>'place')::int)
        from jsonb_array_elements(race->'candidates') c
        left join lateral (
          select (y->>'place')::int place
            from jsonb_array_elements(coalesce(v_prev, '[]'::jsonb)) pr,
                 jsonb_array_elements(pr->'candidates') y
           where pr->>'key' = race->>'key' and y->>'player_id' = c->>'player_id' limit 1) p on true), '[]'::jsonb))
      order by ord)
    from jsonb_array_elements(v_now) with ordinality t(race, ord));
  insert into public.franchise_award_weeks (franchise_id, season_number, week, races, computed_at)
  values (p_franchise, s.number, s.week, v_out, now())
  on conflict (franchise_id, season_number, week) do update set races = excluded.races, computed_at = now();
  return v_out;
end;
$$;
revoke all on function public.franchise_awards_write(uuid) from public, anon, authenticated;

create or replace function public.franchise_awards(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); s public.franchise_seasons%rowtype; v_races jsonb; v_week integer;
begin
  if v_f is null then return null; end if;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found then return null; end if;
  select races, week into v_races, v_week from public.franchise_award_weeks
   where franchise_id = v_f and season_number = s.number order by week desc limit 1;
  if v_races is null then v_races := public.franchise_award_races(v_f, s.number); v_week := s.week; end if;
  return jsonb_build_object(
    'version', public.franchise_season_rules()->>'version',
    'season', s.number, 'label', s.label, 'week', v_week,
    'scope', 'the men whose games this record keeps: your roster',
    'races', coalesce(v_races, '[]'::jsonb),
    'watch', coalesce((select jsonb_agg(jsonb_build_object(
        'award', r->>'name', 'key', r->>'key',
        'leader', r->'candidates'->0->>'name', 'position', r->'candidates'->0->>'position',
        'score', (r->'candidates'->0->>'score')::int, 'line', r->'candidates'->0->>'line',
        'movement', r->'candidates'->0->'movement'))
      from jsonb_array_elements(coalesce(v_races, '[]'::jsonb)) r
      where jsonb_array_length(r->'candidates') > 0), '[]'::jsonb));
end;
$$;
grant execute on function public.franchise_awards(text) to anon, authenticated;

-- ── THE WEEK'S SNAPSHOT, TAKEN WITHOUT BEING ASKED ───────────────────────
-- A constraint trigger, deferred to the end of the transaction, so it runs
-- AFTER the season lines the same transaction is still writing. Whichever
-- path finished the game — the simulator or a live result filed against the
-- schedule — the week gets its rankings and its award race, once.
create or replace function public.franchise_season_snapshot_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.franchise_rankings_write(new.franchise_id);
  perform public.franchise_awards_write(new.franchise_id);
  return null;
end;
$$;
drop trigger if exists franchise_games_snapshot on public.franchise_games;
create constraint trigger franchise_games_snapshot
  after update on public.franchise_games
  deferrable initially deferred
  for each row when (new.status = 'final' and old.status is distinct from 'final')
  execute function public.franchise_season_snapshot_trg();

-- ── THE CHAMPIONSHIP ─────────────────────────────────────────────────────
-- A bowl is what a winning season earns. THE CHAMPIONSHIP is what a great
-- one earns, and it is not the same game: you draw the best club in the
-- league rather than one at random, the page treats it like nothing else,
-- and the man who wins it is named from what he did in it.
create or replace function public.franchise_championship_earned(p_wins integer, p_losses integer, p_weeks integer)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_losses, 99) <= 1 and coalesce(p_wins, 0) >= coalesce(p_weeks, 8) - 1;
$$;
grant execute on function public.franchise_championship_earned(integer, integer, integer) to anon, authenticated;

-- SCHEDULE THE NINTH GAME. Same rule as before for the bowl; one more rule
-- on top of it. Losing once at most, in a full season, and the ninth game
-- is the title game: the strongest club you have not seen, at the top of the
-- published edge, under its own name.
create or replace function public.franchise_schedule_bowl(p_franchise uuid, p_number integer, p_now timestamptz default now())
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; s public.franchise_seasons%rowtype; cfg jsonb := public.franchise_postseason();
  ovr numeric; o public.franchise_opponents%rowtype; oovr integer; d integer; spread integer;
  wk text; opens timestamptz; v_id uuid; v_name text; v_seed text; v_title boolean;
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then return null; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise and number = p_number;
  if not found or not public.franchise_bowl_earned(s.wins, s.losses) then return null; end if;
  select id into v_id from public.franchise_games
   where franchise_id = p_franchise and season_number = p_number and bowl;
  if v_id is not null then return v_id; end if;

  v_title := public.franchise_championship_earned(s.wins, s.losses, s.weeks);
  v_seed := f.seed || ':bowl:' || p_number;
  perform setseed(public.franchise_seed_float(v_seed));
  ovr := (public.franchise_team_rating(p_franchise)->>'overall')::numeric;
  d := least((cfg->>'edge_max')::int,
             (cfg->>'edge_base')::int + (cfg->>'edge_per_win')::int * greatest(0, s.wins - s.losses));

  if v_title then
    -- the best club you have not seen. No draw: the title game is earned and
    -- so is the opponent.
    d := (cfg->>'edge_max')::int;
    select * into o from public.franchise_opponents
     where key not in (select opponent_key from public.franchise_games
                        where franchise_id = p_franchise and season_number = p_number)
     order by strength desc, key limit 1;
    if not found then select * into o from public.franchise_opponents order by strength desc, key limit 1; end if;
    v_name := 'The EdgeDesk Championship';
  else
    select * into o from public.franchise_opponents
     where key not in (select opponent_key from public.franchise_games
                        where franchise_id = p_franchise and season_number = p_number)
     order by random() limit 1;
    if not found then select * into o from public.franchise_opponents order by random() limit 1; end if;
    v_name := 'The ' || (cfg->'names'->>(floor(random() * jsonb_array_length(cfg->'names'))::int)) || ' Bowl';
  end if;

  oovr := greatest(45, least(97, round(ovr + d)::int));
  spread := floor(random() * 9)::int - 4;
  wk := public.games_week_key(p_now + interval '7 days');
  opens := ((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC';

  insert into public.franchise_games
    (franchise_id, season_number, week, week_key, opens_at, opponent_key, opponent, home, rival, bowl, championship, seed)
  values (p_franchise, p_number, s.weeks + 1, wk, opens, o.key,
    jsonb_build_object('key', o.key, 'city', o.city, 'name', o.name, 'abbr', o.abbr, 'logo', o.logo, 'theme', o.theme,
      'offense', o.offense, 'defense', o.defense, 'style', o.style, 'bowl_name', v_name, 'championship', v_title,
      'overall', oovr, 'offense_r', greatest(40, least(99, oovr + spread)),
      'defense_r', greatest(40, least(99, oovr - spread)),
      'special_r', greatest(40, least(99, oovr + floor(random() * 7)::int - 3))),
    false, false, true, v_title, md5(v_seed || ':game'))
  returning id into v_id;

  update public.franchise_seasons set status = 'playoffs'
   where franchise_id = p_franchise and number = p_number and status = 'active';
  perform public.franchise_award(p_franchise, 'bowl_bid', s.season,
    jsonb_build_object('season_number', p_number, 'bowl', v_name, 'record', s.wins || '-' || s.losses));
  if v_title then
    perform public.franchise_award(p_franchise, 'title_bid', s.season,
      jsonb_build_object('season_number', p_number, 'record', s.wins || '-' || s.losses, 'opponent', o.name));
  end if;
  -- the ninth game earned is always on the record; the title bid is a second
  -- line beside it, never instead of it
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
  select p_franchise, k, p_number::text, wk, public.games_day_key(p_now),
    jsonb_build_object('season_number', p_number, 'game_id', v_id, 'bowl', v_name, 'championship', v_title,
      'record', s.wins || '-' || s.losses, 'opponent', o.name, 'overall', oovr), p_now
    from unnest(case when v_title then array['bowl_bid', 'title_bid'] else array['bowl_bid'] end) k
  on conflict (franchise_id, kind, key) do nothing;
  return v_id;
end;
$$;
revoke all on function public.franchise_schedule_bowl(uuid, integer, timestamptz) from public, anon, authenticated;

-- THE MOST VALUABLE MAN IN THE TITLE GAME. Read out of the game's own box
-- score: the line he put up in it, on the same impact scale the simulator
-- uses to name a player of the game. An overall is not consulted anywhere
-- in this function, and a man who did not play cannot win it.
create or replace function public.franchise_championship_mvp(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.franchise_games%rowtype; ln jsonb; v_why text[];
begin
  select * into g from public.franchise_games where id = p_game;
  if not found or g.status <> 'final' or g.box is null then return null; end if;
  select x into ln from jsonb_array_elements(g.box->'players') x
   where coalesce((x->>'impact')::numeric, 0) > 0
   order by (x->>'impact')::numeric desc, x->>'name' limit 1;
  if ln is null then return null; end if;
  v_why := '{}';
  if coalesce((ln->'stats'->>'yds')::int, 0) > 0 then
    v_why := array_append(v_why, (ln->'stats'->>'yds') || ' yards'); end if;
  if coalesce((ln->'stats'->>'td')::int, 0) > 0 then
    v_why := array_append(v_why, (ln->'stats'->>'td') || ' touchdown' || case when (ln->'stats'->>'td')::int = 1 then '' else 's' end); end if;
  if coalesce((ln->'stats'->>'sacks')::int, 0) > 0 then
    v_why := array_append(v_why, (ln->'stats'->>'sacks') || ' sack' || case when (ln->'stats'->>'sacks')::int = 1 then '' else 's' end); end if;
  if coalesce((ln->'stats'->>'int')::int, 0) > 0 and ln->>'position' in ('DL','LB','CB','S') then
    v_why := array_append(v_why, (ln->'stats'->>'int') || ' interception' || case when (ln->'stats'->>'int')::int = 1 then '' else 's' end); end if;
  if coalesce((ln->'stats'->>'tkl')::int, 0) > 0 then
    v_why := array_append(v_why, (ln->'stats'->>'tkl') || ' tackles'); end if;
  return jsonb_build_object(
    'player_id', ln->>'id', 'name', ln->>'name', 'position', ln->>'position', 'jersey', ln->'jersey',
    'stats', ln->'stats', 'line', public.franchise_award_line(ln->>'position', ln->'stats'),
    'impact', (ln->>'impact')::numeric, 'why', to_jsonb(v_why),
    'basis', 'the box score of this game, and nothing else',
    'card_id', (select card_id from public.game_players where id = (ln->>'id')::uuid));
end;
$$;
grant execute on function public.franchise_championship_mvp(uuid) to anon, authenticated;

-- THE TITLE GAME, BEFORE AND AFTER. One call. Before it is played this is
-- the pregame: how both clubs got here, who is playing, what is on the line
-- and where the game turns. After it is played this is the postgame: the
-- whistle, the trophy, the man who won it, what the season was, and what
-- the record will say about it forever.
create or replace function public.franchise_championship(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); f public.franchises%rowtype;
  s public.franchise_seasons%rowtype; g public.franchise_games%rowtype;
  tr jsonb; v_path jsonb; v_stars jsonb; v_final jsonb; v_races jsonb;
  v_mine_g text; v_theirs_g text; v_edge text; v_key jsonb; v_pack jsonb; v_won boolean;
  v_ovr integer; v_off integer; v_def integer;
begin
  if v_f is null then return null; end if;
  select * into f from public.franchises where id = v_f;
  select * into s from public.franchise_seasons where franchise_id = v_f order by number desc limit 1;
  if not found then return null; end if;
  select * into g from public.franchise_games
   where franchise_id = v_f and season_number = s.number and championship order by week desc limit 1;
  if not found then
    return jsonb_build_object('version', public.franchise_season_rules()->>'version', 'scheduled', false,
      'earned', public.franchise_championship_earned(s.wins, s.losses, s.weeks),
      'rule', 'win all but one of the ' || s.weeks || ' and the ninth game is the title game',
      'record', s.wins || '-' || s.losses, 'season', s.number);
  end if;

  tr := public.franchise_team_rating(v_f);
  v_ovr := coalesce((g.opponent->>'overall')::int, 70);
  v_off := coalesce((g.opponent->>'offense_r')::int, v_ovr);
  v_def := coalesce((g.opponent->>'defense_r')::int, v_ovr);

  -- HOW YOU GOT HERE. Every game of the season, in order, with the result.
  select coalesce(jsonb_agg(jsonb_build_object(
      'week', x.week, 'opponent', x.opponent->>'name', 'abbr', x.opponent->>'abbr',
      'home', x.home, 'rival', x.rival, 'result', x.result,
      'score', case when x.status = 'final' then x.score_for || '–' || x.score_against end,
      'status', x.status) order by x.week), '[]'::jsonb) into v_path
    from public.franchise_games x where x.franchise_id = v_f and x.season_number = s.number and not x.championship;

  -- WHO IS PLAYING. The men having the seasons, by the award score, not by
  -- the overall on the card.
  select coalesce(jsonb_agg(y order by (y->>'score')::int desc), '[]'::jsonb) into v_stars from (
    select public.franchise_award_score(p.position, p.season_stats,
             case when s.wins + s.losses > 0 then s.wins::numeric / (s.wins + s.losses) else 0.5 end, 70)
           || jsonb_build_object('name', p.first_name || ' ' || p.last_name, 'position', p.position,
                'jersey', p.jersey, 'player_id', p.id, 'card_id', p.card_id,
                'line', public.franchise_award_line(p.position, p.season_stats)) as y
      from public.game_players p
     where p.franchise_id = v_f and p.status in ('active', 'injured')
       and coalesce((p.season_stats->>'games')::int, 0) > 0
       and p.position in ('QB','RB','WR','TE','DL','LB','CB','S')
     order by (public.franchise_award_score(p.position, p.season_stats,
                 case when s.wins + s.losses > 0 then s.wins::numeric / (s.wins + s.losses) else 0.5 end, 70)->>'score')::int desc
     limit 5) q;

  -- WHERE IT TURNS. Your strongest group against their weaker side.
  if (tr->>'offense')::int - v_def >= (tr->>'defense')::int - v_off then
    v_key := jsonb_build_object('side', 'offense',
      'mine', (tr->>'offense')::int, 'theirs', v_def,
      'text', 'your offense (' || (tr->>'offense') || ') against their defense (' || v_def || ')');
  else
    v_key := jsonb_build_object('side', 'defense',
      'mine', (tr->>'defense')::int, 'theirs', v_off,
      'text', 'your defense (' || (tr->>'defense') || ') against their offense (' || v_off || ')');
  end if;
  v_edge := case when (tr->>'overall')::int > v_ovr then 'you are the better club on paper by ' || ((tr->>'overall')::int - v_ovr)
                 when (tr->>'overall')::int < v_ovr then 'they are the better club on paper by ' || (v_ovr - (tr->>'overall')::int)
                 else 'the two clubs are rated dead level' end;

  select races into v_races from public.franchise_award_weeks
   where franchise_id = v_f and season_number = s.number order by week desc limit 1;
  if v_races is null then v_races := public.franchise_award_races(v_f, s.number); end if;

  if g.status <> 'final' then
    return jsonb_build_object(
      'version', public.franchise_season_rules()->>'version', 'scheduled', true, 'played', false,
      'game_id', g.id, 'season', s.number, 'label', s.label, 'week', g.week,
      'name', coalesce(g.opponent->>'bowl_name', 'The EdgeDesk Championship'),
      'opens_at', g.opens_at,
      'club', jsonb_build_object('city', f.city, 'name', f.name, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
        'record', s.wins || '-' || s.losses, 'points_for', s.points_for, 'points_against', s.points_against,
        'rating', tr),
      'opponent', g.opponent || jsonb_build_object('record', 'the best club you have not played'),
      'path', v_path, 'stars', v_stars, 'key_matchup', v_key, 'edge', v_edge,
      'finalists', coalesce((select jsonb_agg(jsonb_build_object('award', r->>'name',
          'name', r->'candidates'->0->>'name', 'position', r->'candidates'->0->>'position',
          'score', (r->'candidates'->0->>'score')::int, 'line', r->'candidates'->0->>'line'))
        from jsonb_array_elements(coalesce(v_races, '[]'::jsonb)) r
        where jsonb_array_length(r->'candidates') > 0
          and r->>'key' in ('poy', 'opoy', 'dpoy', 'rook')), '[]'::jsonb),
      'stadium', jsonb_build_object('name', f.city || ' at a neutral field', 'neutral', true,
        'dressing', 'title', 'level', coalesce((f.facilities->>'stadium')::int, 0),
        'note', 'a neutral field, dressed for the title'),
      'introductions', coalesce((select jsonb_agg(jsonb_build_object(
          'name', p.first_name || ' ' || p.last_name, 'position', p.position, 'jersey', p.jersey,
          'hometown', public.franchise_hometown(p.jersey, p.age, p.stamina, p.last_name, p.first_name))
          order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth)
        from public.game_players p where p.franchise_id = v_f and p.status = 'active' and p.depth = 1), '[]'::jsonb));
  end if;

  v_won := g.result = 'W';
  v_final := jsonb_build_object('for', g.score_for, 'against', g.score_against,
    'quarters', g.box->'quarters', 'scoring', g.box->'scoring', 'ot', coalesce((g.box->>'ot')::boolean, false));
  select jsonb_build_object('kind', kind, 'status', status, 'id', id) into v_pack
    from public.franchise_packs where franchise_id = v_f and kind = 'championship_vault'
    order by granted_at desc limit 1;

  return jsonb_build_object(
    'version', public.franchise_season_rules()->>'version', 'scheduled', true, 'played', true, 'won', v_won,
    'game_id', g.id, 'season', s.number, 'label', s.label, 'week', g.week,
    'name', coalesce(g.opponent->>'bowl_name', 'The EdgeDesk Championship'),
    'club', jsonb_build_object('city', f.city, 'name', f.name, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'record', s.wins || '-' || s.losses, 'rating', tr),
    'opponent', g.opponent, 'final', v_final, 'path', v_path, 'key_matchup', v_key,
    'mvp', public.franchise_championship_mvp(g.id),
    'whistle', case when v_won then 'CHAMPIONS' else 'IT ENDS HERE' end,
    'headline', case when v_won
      then f.name || ' win ' || coalesce(g.opponent->>'bowl_name', 'the title') || ', ' || g.score_for || '–' || g.score_against
      else f.name || ' fall in ' || coalesce(g.opponent->>'bowl_name', 'the title game') || ', ' || g.score_for || '–' || g.score_against end,
    'celebration', case when v_won
      then jsonb_build_array('The clock hits zero.', 'Confetti.', 'The trophy comes out.', 'They are champions.')
      else jsonb_build_array('The clock hits zero.', 'The other side celebrates.', 'A season that was worth it, one game short.') end,
    'trophy', case when v_won then jsonb_build_object('name', 'The EdgeDesk Trophy',
        'season', s.label, 'record', (s.wins) || '-' || s.losses, 'presented_to', f.city || ' ' || f.name) end,
    'season_summary', jsonb_build_object('record', s.wins || '-' || s.losses,
      'points_for', s.points_for, 'points_against', s.points_against,
      'differential', s.points_for - s.points_against, 'weeks', s.weeks),
    'recognition', v_stars,
    'awards', coalesce((select jsonb_agg(jsonb_build_object('award', r->>'name', 'key', r->>'key',
        'winner', r->'candidates'->0->>'name', 'position', r->'candidates'->0->>'position',
        'score', (r->'candidates'->0->>'score')::int, 'line', r->'candidates'->0->>'line'))
      from jsonb_array_elements(coalesce(v_races, '[]'::jsonb)) r
      where jsonb_array_length(r->'candidates') > 0), '[]'::jsonb),
    'vault', v_pack,
    'legacy', jsonb_build_object('title', v_won, 'season', s.number, 'label', s.label,
      'line', case when v_won then s.label || ': champions at ' || s.wins || '-' || s.losses
                   else s.label || ': ' || s.wins || '-' || s.losses || ', lost the title game' end),
    'record_book', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'season', a.detail->>'season_number',
        'detail', a.detail) order by a.created_at desc)
      from public.franchise_activity a where a.franchise_id = v_f and a.kind in ('title_bid', 'title_win')), '[]'::jsonb));
end;
$$;
grant execute on function public.franchise_championship(text) to anon, authenticated;

-- THE RECORD OF A TITLE. Written by the same deferred trigger that takes the
-- week's snapshot, so it does not matter which path played the game.
alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete','fc_played','fc_win','facility','offseason',
   'market','scout','draft','signing','release',
   'conf_joined','conf_season','conf_game','conf_win','conf_playoff','conf_title',
   'bowl_bid','injury','trade',
   'staff_hire','staff_promote','staff_fire',
   'program','pack',
   'exchange_list','exchange_sale','exchange_buy',
   'live_game','live_game_extra',
   'title_bid','title_win'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('title_bid', 'Title Game',  'Lost at most once in a full season and earned the EdgeDesk Championship.', null, 94),
  ('title_win', 'Champions',   'Won the EdgeDesk Championship.', null, 95)
on conflict (id) do nothing;

create or replace function public.franchise_season_snapshot_trg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.franchise_seasons%rowtype;
begin
  perform public.franchise_rankings_write(new.franchise_id);
  perform public.franchise_awards_write(new.franchise_id);
  if new.championship and new.result = 'W' then
    select * into s from public.franchise_seasons
     where franchise_id = new.franchise_id and number = new.season_number;
    perform public.franchise_award(new.franchise_id, 'title_win', s.season,
      jsonb_build_object('game_id', new.id, 'season_number', new.season_number,
        'score', new.score_for || '-' || new.score_against));
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
    values (new.franchise_id, 'title_win', new.season_number::text, new.week_key, public.games_day_key(now()),
      jsonb_build_object('season_number', new.season_number, 'game_id', new.id,
        'opponent', new.opponent->>'name', 'score', new.score_for || '–' || new.score_against,
        'mvp', public.franchise_championship_mvp(new.id)->>'name'), now())
    on conflict (franchise_id, kind, key) do nothing;
  end if;
  return null;
end;
$$;

revoke all on function public.franchise_season_snapshot_trg() from public, anon, authenticated;

select public.games_schema_note('franchise', 23, 'the living season: rankings, award races, the title game');
commit;

-- ===========================================================================
-- PHASE 24 — ONE DOOR, ONCE (resume_v1)
--
-- Everything in this game that hands out value now goes through a door that
-- can be knocked on twice. A phone loses signal in a lift, a tab is closed
-- mid-animation, a request times out on a train — and the question the
-- client is left holding is always the same: DID IT HAPPEN?
--
-- The wrong answers are the ones this phase exists to make impossible:
--   • guessing yes, and showing a reward the server never granted
--   • guessing no, and asking again, and granting it twice
--
-- So: every operation that must happen exactly once carries an OPERATION KEY
-- generated by the client before it asks. franchise_once() takes the key,
-- locks the franchise, and looks it up. If the key is on the ledger the work
-- already happened and the ORIGINAL RESULT comes back — not a new one. If it
-- is not, the work runs and the key is written in the SAME TRANSACTION, so
-- there is no window where one is true without the other.
--
-- And when the client does not even know whether its request left the
-- building, franchise_op() answers the question directly: COMPLETED, with
-- what it produced, or NOT COMPLETED. Never "maybe".
--
-- WHAT WAS ALREADY SAFE, AND STAYS SO. A live game result is filed under its
-- own game key. A purchase is written under its operation key with a unique
-- index (cards_v1). An achievement is a primary key. A pack grant is unique
-- on (franchise, kind, source). Those doors are not re-plumbed here; the
-- suite holds each of them to the same promise.
-- ===========================================================================
begin;

create or replace function public.franchise_resume_rules()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'version', 'resume_v1',
    'key_min', 8, 'key_max', 120,
    -- the operations that take a key, and what each one runs
    'ops', jsonb_build_object(
      'pack_open',    'open the pack your rank has earned',
      'pack_open_id', 'open one sealed pack you hold',
      'pack_keep',    'keep a man from the pack on the table',
      'play_week',    'play the next game on the schedule',
      'start_season', 'schedule and start the next season'),
    -- the doors that were already exactly-once, and what makes them so
    'already_once', jsonb_build_object(
      'market_purchase', 'game_market_txns.op_key, unique',
      'game_reward',     'franchise_activity (franchise, kind, key), unique',
      'award_grant',     'franchise_achievements primary key',
      'pack_grant',      'franchise_packs (franchise, kind, source_key), unique'),
    'states', jsonb_build_array('completed', 'not_completed'));
$$;
grant execute on function public.franchise_resume_rules() to anon, authenticated;

-- ── THE LEDGER OF OPERATIONS ─────────────────────────────────────────────
-- One row per key. The result is the answer the first call gave, kept so the
-- second call can be given the same one rather than a fresh outcome.
create table if not exists public.franchise_ops (
  franchise_id uuid not null references public.franchises (id) on delete cascade,
  op_key       text not null,
  kind         text not null,
  created_at   timestamptz not null default now(),
  result       jsonb not null default '{}'::jsonb,
  primary key (franchise_id, op_key)
);
create index if not exists franchise_ops_mine on public.franchise_ops (franchise_id, created_at desc);
alter table public.franchise_ops enable row level security;
drop policy if exists franchise_ops_own on public.franchise_ops;
create policy franchise_ops_own on public.franchise_ops for select using (public.franchise_is_mine(franchise_id));

-- ── THE DOOR ─────────────────────────────────────────────────────────────
-- Knock twice and the second knock is answered with what the first one got.
--
-- THE LOCK IS THE POINT. Two tabs pressing the same button at the same
-- moment would otherwise both find the ledger empty and both do the work.
-- The franchise row is taken FOR UPDATE first, so the second transaction
-- waits for the first to commit and then finds the key sitting there.
create or replace function public.franchise_once(p_kind text, p_op text, p_ref text default null, p_secret text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_f uuid := public.franchise_of(p_secret); cfg jsonb := public.franchise_resume_rules();
  v_prev jsonb; v_kind text; v_res jsonb;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  if p_op is null or length(p_op) < (cfg->>'key_min')::int or length(p_op) > (cfg->>'key_max')::int then
    raise exception 'that is not an operation key' using errcode = '22023';
  end if;
  if not (cfg->'ops' ? p_kind) then
    raise exception 'no such operation: %', p_kind using errcode = '22023';
  end if;
  -- nobody else may be inside this franchise while this is decided
  perform 1 from public.franchises where id = v_f for update;
  select result, kind into v_prev, v_kind from public.franchise_ops
   where franchise_id = v_f and op_key = p_op;
  if found then
    return jsonb_build_object('ok', true, 'already', true, 'kind', v_kind,
      'state', 'completed', 'op', p_op, 'result', v_prev);
  end if;
  case p_kind
    when 'pack_open'    then v_res := public.franchise_pack_open(p_secret);
    when 'pack_open_id' then v_res := public.franchise_pack_open_id(p_ref::uuid, p_secret);
    when 'pack_keep'    then v_res := public.franchise_pack_keep(p_ref::uuid, p_secret);
    when 'play_week'    then v_res := public.franchise_play_week(p_secret);
    when 'start_season' then v_res := public.franchise_start_season(p_secret);
    else raise exception 'no such operation: %', p_kind using errcode = '22023';
  end case;
  insert into public.franchise_ops (franchise_id, op_key, kind, result)
  values (v_f, p_op, p_kind, coalesce(v_res, '{}'::jsonb))
  on conflict (franchise_id, op_key) do nothing;
  return jsonb_build_object('ok', true, 'already', false, 'kind', p_kind,
    'state', 'completed', 'op', p_op, 'result', v_res);
end;
$$;
grant execute on function public.franchise_once(text, text, text, text) to anon, authenticated;

-- ── DID IT HAPPEN? ───────────────────────────────────────────────────────
-- The only two answers a client is ever given. A purchase is answered out of
-- the market's own transaction record (cards_v1); everything else out of the
-- ledger above. A key nobody has ever seen is NOT COMPLETED, which is the
-- honest answer and the one that makes a retry safe.
create or replace function public.franchise_op(p_op text, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); v_prev jsonb; v_kind text; v_at timestamptz; v_mk jsonb;
begin
  if v_f is null then raise exception 'found a franchise first' using errcode = '28000'; end if;
  if p_op is null or length(p_op) < 1 then raise exception 'that is not an operation key' using errcode = '22023'; end if;
  select result, kind, created_at into v_prev, v_kind, v_at
    from public.franchise_ops where franchise_id = v_f and op_key = p_op;
  if found then
    return jsonb_build_object('ok', true, 'state', 'completed', 'kind', v_kind,
      'op', p_op, 'at', v_at, 'result', v_prev);
  end if;
  -- the market keeps its own record of exactly-once, so ask it
  v_mk := public.franchise_market_op(p_op, p_secret);
  if v_mk is not null and v_mk->>'state' = 'completed' then
    return jsonb_build_object('ok', true, 'state', 'completed', 'kind', 'market_purchase',
      'op', p_op, 'result', v_mk);
  end if;
  return jsonb_build_object('ok', true, 'state', 'not_completed', 'kind', null, 'op', p_op, 'result', null);
end;
$$;
grant execute on function public.franchise_op(text, text) to anon, authenticated;

-- WHAT THE PACK ON THE TABLE IS. A connection that dropped between the
-- server writing a pack and the client drawing it leaves men sitting in
-- `pack` status: the outcome exists and the reveal never ran. This says what
-- is there, so the page can finish an animation it never started rather than
-- open a second pack or invent a reward.
create or replace function public.franchise_pack_pending(p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f uuid := public.franchise_of(p_secret); pk public.franchise_packs%rowtype; v_men jsonb; d jsonb;
begin
  if v_f is null then return null; end if;
  select jsonb_agg(public.franchise_prospect_json(p) order by p.created_at) into v_men
    from public.game_players p where p.franchise_id = v_f and p.status = 'pack';
  if v_men is null then
    return jsonb_build_object('ok', true, 'pending', false);
  end if;
  select * into pk from public.franchise_packs
   where franchise_id = v_f and status = 'open' order by opened_at desc nulls last limit 1;
  d := public.franchise_pack_def(coalesce(pk.kind, 'gridiron_cache'));
  return jsonb_build_object('ok', true, 'pending', true, 'players', v_men,
    'keep', coalesce((d->>'keep')::int, 1),
    'pack', case when pk.id is not null then jsonb_build_object('id', pk.id, 'kind', pk.kind,
      'name', d->>'name', 'source', pk.source, 'opened_at', pk.opened_at, 'keep', (d->>'keep')::int) end,
    'totals', public.franchise_totals(v_f));
end;
$$;
grant execute on function public.franchise_pack_pending(text) to anon, authenticated;

select public.games_schema_note('franchise', 24, 'one door, once: operation keys and the answer to did it happen');
commit;

-- THE REPORT. Every row should say ok.
-- ===========================================================================
select 1 as row, 'franchise tables exist' as what,
  case when (select count(*) from pg_tables where schemaname = 'public' and tablename in
    ('game_board','franchises','franchise_seasons','game_players','franchise_activity','franchise_ledger',
     'franchise_pick5_cards','franchise_pick5_selections','franchise_achievement_defs','franchise_achievements',
     'franchise_opponents','franchise_games','franchise_challenges','franchise_rivalries',
     'franchise_conferences','franchise_conference_members','franchise_conference_games','franchise_conference_titles',
     'franchise_trades','franchise_staff_members')) = 20
    then 'ok' else 'CHECK THIS' end as status
union all
select 2, 'row level security is on for every franchise table',
  case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in
    ('game_board','franchises','franchise_seasons','game_players','franchise_activity','franchise_ledger',
     'franchise_pick5_cards','franchise_pick5_selections','franchise_achievement_defs','franchise_achievements',
     'franchise_opponents','franchise_games','franchise_challenges','franchise_rivalries',
     'franchise_conferences','franchise_conference_members','franchise_conference_games','franchise_conference_titles',
     'franchise_trades','franchise_staff_members')) = 20
    then 'ok' else 'CHECK THIS' end
union all
select 3, 'no client role may write a franchise table directly',
  case when not exists (select 1 from pg_policies where schemaname = 'public' and cmd <> 'SELECT' and tablename in
    ('game_board','franchises','franchise_seasons','game_players','franchise_activity','franchise_ledger',
     'franchise_pick5_cards','franchise_pick5_selections','franchise_achievement_defs','franchise_achievements',
     'franchise_opponents','franchise_games','franchise_challenges','franchise_rivalries',
     'franchise_conferences','franchise_conference_members','franchise_conference_games','franchise_conference_titles',
     'franchise_trades','franchise_staff_members'))
    then 'ok' else 'CHECK THIS' end
union all
select 4, 'the ledger write is reachable by no client role',
  case when not has_function_privilege('anon', 'public.franchise_credit(uuid, text, integer, text, text, text)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_credit(uuid, text, integer, text, text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 5, 'the board publisher and the settlement are service-only',
  case when not has_function_privilege('authenticated', 'public.game_board_upsert(jsonb)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_settle_pick5()', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 6, 'the H2H settlement trigger is attached',
  case when exists (select 1 from pg_trigger where tgname = 'franchise_h2h_settled') then 'ok' else 'CHECK THIS' end
union all
select 7, 'the economy is ' || (public.franchise_economy()->>'version'),
  case when public.franchise_economy()->>'version' = 'economy_v2' then 'ok' else 'CHECK THIS' end
union all
select 8, 'the achievement definitions are seeded',
  case when (select count(*) from public.franchise_achievement_defs) >= 6 then 'ok' else 'CHECK THIS' end
union all
select 9, 'a team comes before an account: founding is open to anon, claiming is not',
  case when has_function_privilege('anon', 'public.franchise_create(text, text, text, text, text, text, text, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_claim(text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_mine()', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 10, 'the simulator, the scheduler and the game writer are reachable by no client role',
  case when not has_function_privilege('anon', 'public.franchise_sim(uuid, uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_sim(uuid, uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_play_game(uuid, timestamptz)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_schedule_season(uuid, integer, timestamptz)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 11, 'the opponent pool is seeded',
  case when (select count(*) from public.franchise_opponents) >= 24 then 'ok' else 'CHECK THIS' end
union all
select 12, 'the weekly game is open to every franchise: play, start a season, read the schedule',
  case when has_function_privilege('anon', 'public.franchise_play_week(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_start_season(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_schedule(integer, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 13, 'a franchise challenge is played on the server: the versus simulator is reachable by no client role',
  case when not has_function_privilege('anon', 'public.franchise_sim_versus(uuid, uuid, text, text)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_sim_versus(uuid, uuid, text, text)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_rivalry_bump(uuid, uuid, text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 14, 'the link is the key: a challenge is created, read and accepted by any franchise',
  case when has_function_privilege('anon', 'public.franchise_challenge_create(text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_challenge_accept(text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_challenge_peek(text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 15, 'the ladder is public and lists franchises, never accounts',
  case when has_function_privilege('anon', 'public.franchise_ladder(integer, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_identity_json(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 16, 'the offseason and the rookie generator are reachable by no client role',
  case when not has_function_privilege('anon', 'public.franchise_offseason(uuid, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_offseason(uuid, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_generate_rookie(uuid, text, integer, integer, text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 17, 'facilities are ' || (public.franchise_facilities()->>'version') || ', bought with earned resources through the ledger only',
  case when public.franchise_facilities()->>'version' = 'facilities_v1'
        and has_function_privilege('anon', 'public.franchise_upgrade(text, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_credit(uuid, text, integer, text, text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 18, 'the market is ' || (public.franchise_market()->>'version') || ': scouting, the draft and signings are open to every franchise, the generator to no client role',
  case when public.franchise_market()->>'version' = 'market_v1'
        and has_function_privilege('anon', 'public.franchise_scout(uuid, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_draft(uuid, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_sign(uuid, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_release(uuid, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_open_market(uuid, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_generate_player(uuid, text, integer, integer, text, text, text, integer, integer, integer)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 19, 'a prospect''s true ratings are read through the board only: the direct policy admits no prospect or free agent',
  case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'game_players' and policyname = 'game_players_own'
                      and qual like '%prospect%' and qual like '%free_agent%')
    then 'ok' else 'CHECK THIS' end
union all
select 20, 'the conference is ' || (public.franchise_conference_config()->>'version') || ': created, joined, started and advanced by every franchise, drawn and simulated by none',
  case when public.franchise_conference_config()->>'version' = 'conference_v1'
        and has_function_privilege('anon', 'public.franchise_conference_create(text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_conference_join(text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_conference_start(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_conference_advance(text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_conference_draw(uuid, timestamptz)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_conference_play_one(uuid, timestamptz)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_conference_bracket(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_conference_settle(uuid, timestamptz)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_conference_run(uuid, timestamptz)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 21, 'a conference is read by its members only, and names franchises rather than accounts',
  case when (select count(*) from pg_policies where schemaname = 'public' and cmd = 'SELECT' and tablename in
              ('franchise_conferences','franchise_conference_members','franchise_conference_games','franchise_conference_titles')
              and qual like '%franchise_conference_is_mine%') = 4
        and not has_function_privilege('anon', 'public.franchise_conference_standings_json(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 22, 'a franchise belongs to one conference at a time, and the key says so',
  case when exists (select 1 from pg_constraint where conname = 'franchise_conference_members_franchise_id_key'
                      and conrelid = 'public.franchise_conference_members'::regclass and contype = 'u')
    then 'ok' else 'CHECK THIS' end
union all
select 23, 'injuries are ' || (public.franchise_injuries()->>'version') || ': drawn by the server, and availability is read off the clock',
  case when public.franchise_injuries()->>'version' = 'injury_v1'
        and not has_function_privilege('anon', 'public.franchise_draw_injuries(uuid, text, text, timestamptz)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_draw_injuries(uuid, text, text, timestamptz)', 'execute')
        and has_function_privilege('anon', 'public.franchise_is_available(text, timestamptz, timestamptz)', 'execute')
        and public.franchise_is_available('active', null) and not public.franchise_is_available('active', now() + interval '1 day')
    then 'ok' else 'CHECK THIS' end
union all
select 24, 'the bowl is ' || (public.franchise_postseason()->>'version') || ': earned by a winning record, scheduled by no client role',
  case when public.franchise_postseason()->>'version' = 'bowl_v1'
        and public.franchise_bowl_earned(5, 3) and not public.franchise_bowl_earned(4, 4)
        and not has_function_privilege('anon', 'public.franchise_schedule_bowl(uuid, integer, timestamptz)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_schedule_bowl(uuid, integer, timestamptz)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 25, 'trades are ' || (public.franchise_trade_rules()->>'version') || ': open to both parties only, checked by the server, and free',
  case when public.franchise_trade_rules()->>'version' = 'trade_v1'
        and has_function_privilege('anon', 'public.franchise_trade_offer(uuid, uuid[], uuid[], text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_trade_respond(uuid, boolean, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_trade_json(uuid, uuid)', 'execute')
        and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'franchise_trades'
                      and cmd = 'SELECT' and qual like '%franchise_is_mine%')
        and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'franchise_trades' and cmd <> 'SELECT')
    then 'ok' else 'CHECK THIS' end
union all
select 0, 'the schema log says what this database has: ' ||
    coalesce('social ' || (public.games_schema()->>'social') || ' · franchise ' || (public.games_schema()->>'franchise'), 'nothing'),
  case when (public.games_schema()->>'franchise')::int = 24 and (public.games_schema()->>'social')::int >= 1
    then 'ok' else 'CHECK THIS' end
union all
select 26, 'the staff is ' || (public.franchise_staff()->>'version') || ': a thousand levels bought with Coach Points, generated and scored by the server',
  case when public.franchise_staff()->>'version' = 'staff_v2'
        and (public.franchise_staff()->>'max_level')::int = 1000
        and public.franchise_staff_cost(1) = 1 and public.franchise_staff_cost(1000) = 100
        and public.franchise_staff_cost_between(1, 1000) = 50400
        and public.franchise_staff_effect(1, 3.0) = 0 and public.franchise_staff_effect(1000, 3.0) = 3.0
        and has_function_privilege('anon', 'public.franchise_staff_hire(text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_staff_promote(text, integer, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_generate_coach(uuid, text, text, integer, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_staff_effects(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 27, 'scouting is ' || (public.franchise_scouting()->>'version') || ': accuracy at real games decides the draft class, and the grade is the server''s to compute',
  case when public.franchise_scouting()->>'version' = 'scouting_v1'
        -- the band tightens and the report cheapens as the grade rises, and neither runs past its end
        and public.franchise_scout_band(0) = 18 and public.franchise_scout_band(100) = 4
        and public.franchise_scout_cost(0) = 28 and public.franchise_scout_cost(100) = 12
        -- and a franchise with no record at all gets exactly what market_v1 gave
        and public.franchise_scout_band(50) = 11
        and public.franchise_scout_cost(50) = (public.franchise_market()->>'scout_sp')::int
        -- a department below neutral finds nothing; it never makes a player worse
        and public.franchise_scout_lift(0) = 0 and public.franchise_scout_lift(50) = 0
        and public.franchise_scout_lift(100) = 6
        and public.franchise_scout_grade_of(0)->>'key' = 'unrated'
        and public.franchise_scout_grade_of(100)->>'key' = 'war_room'
        -- the class carries the band it was found under, the franchise the grade
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'game_players' and column_name = 'scout_band')
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'franchises' and column_name = 'scout_grade')
        -- the table is public; the franchise's own grade is a definer read
        and has_function_privilege('anon', 'public.franchise_scouting()', 'execute')
        and has_function_privilege('anon', 'public.franchise_scout_band(integer)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_scout_report(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_scout_report(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 28, 'development is ' || (public.franchise_development()->>'version') || ': a ceiling can be raised, paid in Scouting Points and graded on the football played',
  case when public.franchise_development()->>'version' = 'development_v1'
        -- the lift runs +1 to +4 by grade, halves at 27, and stops at 30
        and public.franchise_dev_lift(0, 21) = 1 and public.franchise_dev_lift(100, 21) = 6
        and public.franchise_dev_lift(100, 27) = 3 and public.franchise_dev_lift(100, 30) = 0
        -- the price rises with what a man has already been given
        and public.franchise_dev_cost(0) = 100 and public.franchise_dev_cost(15) = 325
        and public.franchise_dev_cost(0) < public.franchise_dev_cost(1)
        -- par is published for every position the roster can hold
        and (select bool_and(public.franchise_dev_par(t.p, 1) > 0)
               from unnest(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P']) as t(p))
        -- the record of what a man was given, and what it took
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'game_players' and column_name = 'developed')
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'game_players' and column_name = 'programs')
        -- the table and the move are open; the grade and the slot count are not
        and has_function_privilege('anon', 'public.franchise_development()', 'execute')
        and has_function_privilege('anon', 'public.franchise_develop(uuid, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_development_board(text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_dev_grade(uuid, uuid, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_dev_slots(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 29, 'the league is ' || (public.franchise_league()->>'version') || ': twenty-four clubs with ratings of their own, and a standing moved by results',
  case when public.franchise_league()->>'version' = 'league_v1'
        -- every club has an absolute rating, and they are spread across the table
        and (select count(*) from public.franchise_opponents where strength is null) = 0
        and (select max(strength) - min(strength) from public.franchise_opponents) >= 25
        -- THE LOAD-BEARING ONE: nothing in the scheduler reads team overall any
        -- more. While it did, a better roster could not win one extra game.
        and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_schedule_season'
                and p.prosrc like '%franchise_team_rating%') = 0
        -- a win over a better club is worth more than one over a worse
        and public.franchise_standing_delta('W', 40, 85) > public.franchise_standing_delta('W', 40, 55)
        and public.franchise_standing_delta('L', 40, 55) < public.franchise_standing_delta('L', 40, 85)
        and public.franchise_standing_delta('L', 40, 85) = -1
        and public.franchise_standing_delta('W', 40, 70, true) = 2 * public.franchise_standing_delta('W', 40, 70, false)
        and public.franchise_standing_delta('T', 40, 70) = 0
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'franchises' and column_name = 'standing')
        and has_function_privilege('anon', 'public.franchise_league()', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 30, 'the rank is ' || (public.franchise_ranks()->>'version') || ' and packs are '
        || (public.franchise_ranks()->>'pack_version') || ': earned by playing, never bought, and drawn around your own team',
  case when public.franchise_ranks()->>'version' = 'rank_v1'
        and public.franchise_ranks()->>'pack_version' = 'packs_v1'
        -- the rank never caps and every step costs more than the last
        and public.franchise_rank_cost(1) = 15 and public.franchise_rank_cost(2) = 18
        and public.franchise_rank_cost(100) > public.franchise_rank_cost(99)
        -- the closed form and the sum of the steps agree at every rank
        and (select bool_and(public.franchise_rank_for(public.franchise_rank_at(t.n)) = t.n)
               from generate_series(1, 60) as t(n))
        and (select bool_and(public.franchise_rank_at(t.n + 1) - public.franchise_rank_at(t.n)
                             = public.franchise_rank_cost(t.n))
               from generate_series(1, 60) as t(n))
        -- a pack reaches further as the rank rises, and stops at fourteen
        and public.franchise_rank_edge(1) = 2 and public.franchise_rank_edge(1000) = 14
        and (select bool_and(public.franchise_rank_edge(t.n) <= public.franchise_rank_edge(t.n + 1))
               from generate_series(1, 200) as t(n))
        -- a pack is three men and one is kept
        and (public.franchise_ranks()->>'pack_size')::int = 3
        and (public.franchise_ranks()->>'pack_keep')::int = 1
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'franchises' and column_name = 'rank_claimed')
        -- the moves are open; the derived read of one franchise's record is not
        and has_function_privilege('anon', 'public.franchise_pack_open(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_pack_keep(uuid, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_rank_report(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_rank_report(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 31, 'the long haul is ' || (public.franchise_career()->>'version') || ' and '
        || (public.franchise_staff()->>'version') || ': a roster that renews every season, and a building a rank can staff',
  case when public.franchise_career()->>'version' = 'career_v1'
        and public.franchise_staff()->>'version' = 'staff_v2'
        -- the founding ages are spread EVENLY, not skewed young
        and (select p.prosrc like '%franchise_career()->>''found_age_min''%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_generate_roster')
        -- a rank pays the building, and pays more the further you have come
        and public.franchise_rank_coach_points(1) = 20
        and public.franchise_rank_coach_points(45) = 108
        and (select bool_and(public.franchise_rank_coach_points(t.n) < public.franchise_rank_coach_points(t.n + 1))
               from generate_series(1, 200) as t(n))
        -- a new coach arrives at what the reputation commands, never past the cap
        and public.franchise_staff_hire_level(1, 0) = 1
        and public.franchise_staff_hire_level(45, 60) = 29
        and public.franchise_staff_hire_level(9999, 100) = (public.franchise_staff()->>'hire_level_max')::int
        and (select bool_and(public.franchise_staff_hire_level(t.n, 50)
                             <= public.franchise_staff_hire_level(t.n + 1, 50))
               from generate_series(1, 300) as t(n))
        and has_function_privilege('anon', 'public.franchise_career()', 'execute')
        and has_function_privilege('anon', 'public.franchise_staff_hire_level(integer, integer)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_generate_coach(uuid, text, text, integer, integer)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 32, 'the game is ' || (public.franchise_snaps()->>'version') || ': you call the drives, and a call is a decision the server resolves — never a result the client hands in',
  case when public.franchise_snaps()->>'version' = 'snap_v1'
        -- four calls, each a real trade: the ball moves further through the
        -- air and the risk rises with it
        and jsonb_array_length(public.franchise_snaps()->'calls') = 4
        and (public.franchise_snap_call('ground')->>'pass')::numeric < 0
        and (public.franchise_snap_call('air')->>'pass')::numeric > 0
        and (public.franchise_snap_call('shot')->>'td')::numeric > (public.franchise_snap_call('air')->>'td')::numeric
        and (public.franchise_snap_call('shot')->>'turnover')::numeric > (public.franchise_snap_call('air')->>'turnover')::numeric
        and (public.franchise_snap_call('ground')->>'turnover')::numeric < 0
        -- nothing a call does is free: no call is better than Balanced at
        -- both scoring and keeping the ball
        and not exists (select 1 from jsonb_array_elements(public.franchise_snaps()->'calls') c
                         where (c->>'td')::numeric > 0 and (c->>'turnover')::numeric <= 0)
        -- quick play is a game called Balanced: the default names a real call
        -- and that call moves nothing
        and public.franchise_snap_call(null)->>'key' = public.franchise_snaps()->>'default'
        and (public.franchise_snap_call(null)->>'pass')::numeric = 0
        and (public.franchise_snap_call(null)->>'td')::numeric = 0
        and (public.franchise_snap_call(null)->>'turnover')::numeric = 0
        -- the calls are stored on the game, and the simulator reads them
        -- from there: there is no second simulator and no half-played game
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'franchise_games' and column_name = 'calls')
        and (select p.prosrc like '%g.calls%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_sim')
        -- THE LOAD-BEARING ONE. A client sends a CALL and never a result:
        -- franchise_game_call takes only a call and a secret, and the drive
        -- resolver and the simulator stay reachable by no client role.
        and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_game_call'
                and (select array_agg(format_type(t, null) order by o)
                       from unnest(p.proargtypes) with ordinality u(t, o)) = array['text', 'text']) = 1
        and not has_function_privilege('anon',
              'public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer)', 'execute')
        and not has_function_privilege('authenticated',
              'public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_game_drives(uuid, uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_game_drives(uuid, uuid)', 'execute')
        -- the seven-argument drive resolver is gone, so nothing can call the
        -- form that knows nothing about a call
        and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_sim_drive') = 1
        -- the two moves are open on the same terms every franchise move is
        and has_function_privilege('anon', 'public.franchise_snaps()', 'execute')
        and has_function_privilege('anon', 'public.franchise_game_open(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_game_call(text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 33, 'moments are ' || (public.franchise_moments()->>'version') || ': the game knows which possessions mattered, and the reel is derived from the boxes rather than kept beside them',
  case when public.franchise_moments()->>'version' = 'moment_v1'
        -- the stake is a real number in [0, 1], and both halves of it bite
        and public.franchise_stake(0, 1) = 1
        and public.franchise_stake(0, 9) = 0          -- a tied first quarter decides nothing
        and public.franchise_stake(28, 1) = 0         -- and neither does four scores down
        and (select bool_and(public.franchise_stake(t.g, 2) between 0 and 1)
               from generate_series(0, 60) as t(g))
        -- closer is never worth less, and later is never worth less
        and (select bool_and(public.franchise_stake(t.g, 2) >= public.franchise_stake(t.g + 1, 2))
               from generate_series(0, 60) as t(g))
        and (select bool_and(public.franchise_stake(7, t.l) >= public.franchise_stake(7, t.l + 1))
               from generate_series(1, 20) as t(l))
        -- a possession that cannot happen is worth nothing
        and public.franchise_stake(0, 0) = 0
        and public.franchise_is_key(public.franchise_stake(0, 1))
        and not public.franchise_is_key(public.franchise_stake(0, 9))
        -- THE LOAD-BEARING ONE, and it asserts the RULE rather than the
        -- version number it happened to hold when it was written: the stake
        -- is read off the running score the simulator already keeps, so it
        -- consumes no randomness and cannot move a football outcome. (It said
        -- "sim_v2" until Phase 15 put the game on a clock, which is exactly
        -- how a number pinned in place of a rule goes wrong.)
        and (select p.prosrc like '%v_stake := public.franchise_stake(pts_me - pts_op, v_left);%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_sim')
        and (select p.provolatile = 'i'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_stake')
        and (select p.provolatile = 'i'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_game_story')
        -- the reel is derived: no table of moments to drift out of step
        and not exists (select 1 from information_schema.tables
                         where table_schema = 'public' and table_name like 'franchise_moment%')
        -- playing a decided game out is quick play, not a shortcut past it:
        -- every possession left is called by the published default
        and (select p.prosrc like '%public.franchise_snaps()->>''default''%'
               and p.prosrc like '%public.franchise_play_game(v_f, now())%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_game_finish')
        -- the moves are open; a franchise reads its own reel and nobody else's
        and has_function_privilege('anon', 'public.franchise_moments()', 'execute')
        and has_function_privilege('anon', 'public.franchise_stake(integer, integer)', 'execute')
        and has_function_privilege('anon', 'public.franchise_game_finish(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_reel(text, integer)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 34, 'the game is ' || (public.franchise_clock()->>'version') || ' and ' || (public.franchise_fronts()->>'version')
        || ': a clock rather than a set number of plays, and you call both sides of the ball',
  case when public.franchise_clock()->>'version' = 'clock_v1'
        and public.franchise_fronts()->>'version' = 'defense_v1'
        -- SIXTY MINUTES, and possessions are what fits inside them. There is
        -- no possession count anywhere in the simulator any more.
        and (public.franchise_clock()->>'quarters')::int * (public.franchise_clock()->>'quarter_seconds')::int = 3600
        and (select p.prosrc not like '%n := 11 + floor(random() * 3)::int;%'
               and p.prosrc like '%while secs_left > 0%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_sim')
        -- the ball on the ground keeps the clock moving; the ball in the air
        -- stops it, which is the whole reason a trailing team throws
        and (public.franchise_clock()->>'run_seconds')::int > (public.franchise_clock()->>'pass_seconds')::int
        and public.franchise_drive_seconds(6, 0.20, 'punt') > public.franchise_drive_seconds(6, 0.80, 'punt')
        and public.franchise_drive_seconds(10, 0.5, 'punt') > public.franchise_drive_seconds(4, 0.5, 'punt')
        and public.franchise_drive_seconds(6, 0.5, 'td') > public.franchise_drive_seconds(6, 0.5, 'punt')
        -- a drive always costs something, so the clock can never stall
        and (select bool_and(public.franchise_drive_seconds(t.n, 0.5, 'punt') > 0)
               from generate_series(0, 30) as t(n))
        -- trailing hurries up and leading bleeds it, but only late
        and public.franchise_tempo(-7, 120) < 1 and public.franchise_tempo(7, 120) > 1
        and public.franchise_tempo(-7, 1800) = 1 and public.franchise_tempo(0, 120) = 1
        -- FOUR FRONTS, and every one of them is a real guess: nothing is
        -- strong against the run and the pass both, and the one that is
        -- neither pays for it in what it gives up
        and jsonb_array_length(public.franchise_fronts()->'calls') = 4
        -- NOTHING TAKES BOTH AWAY. Every front that helps against the run
        -- hurts against the pass and the other way about — except the blitz,
        -- which pays for helping against both in touchdowns allowed.
        and not exists (select 1 from jsonb_array_elements(public.franchise_fronts()->'calls') c
                         where (c->>'td_vs_run')::numeric < 0 and (c->>'td_vs_pass')::numeric < 0)
        and (public.franchise_front_call('stack')->>'td_vs_run')::numeric < 0
        and (public.franchise_front_call('stack')->>'td_vs_pass')::numeric > 0
        and (public.franchise_front_call('cover')->>'td_vs_pass')::numeric < 0
        and (public.franchise_front_call('cover')->>'td_vs_run')::numeric > 0
        and (public.franchise_front_call('blitz')->>'to_vs_pass')::numeric > 0
        and (public.franchise_front_call('blitz')->>'td_vs_pass')::numeric > 0
        -- quick play is Base: the default names a real front that moves nothing
        and public.franchise_front_call(null)->>'key' = public.franchise_fronts()->>'default'
        and (select bool_and((public.franchise_front_call(null)->>k)::numeric = 0)
               from unnest(array['td_vs_run', 'td_vs_pass', 'to_vs_run', 'to_vs_pass']) k)
        -- the two tables never share a key, so a call names its own side and
        -- one meant for the other can be refused
        and public.franchise_call_side('shot') = 'off'
        and public.franchise_call_side('blitz') = 'def'
        and public.franchise_call_side('nonsense') is null
        and not exists (select 1 from jsonb_array_elements(public.franchise_snaps()->'calls') o
                          join jsonb_array_elements(public.franchise_fronts()->'calls') dd
                            on dd->>'key' = o->>'key')
        -- THE LOAD-BEARING ONE, still. A client sends a call — on either side
        -- of the ball — and never a result; the resolver stays out of reach.
        and not has_function_privilege('anon',
              'public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer)', 'execute')
        and not has_function_privilege('authenticated',
              'public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer)', 'execute')
        -- the opponent's play comes off their scheme and their situation, on
        -- the server, so the read is real and no client ever sees their card
        and not has_function_privilege('anon', 'public.franchise_ai_call(text, integer, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_ai_call(text, integer, integer)', 'execute')
        -- the tables are open to read
        and has_function_privilege('anon', 'public.franchise_clock()', 'execute')
        and has_function_privilege('anon', 'public.franchise_fronts()', 'execute')
        and has_function_privilege('anon', 'public.franchise_call_side(text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 35, 'the playbook is ' || (public.franchise_plays()->>'version')
        || ': twenty plays across five formations, a different book per scheme, and a trick play that needs a formation that lies',
  case when public.franchise_plays()->>'version' = 'playbook_v1'
        and public.franchise_formations()->>'version' = 'playbook_v1'
        -- twenty plays, five formations, and a trick in every one of them
        and jsonb_array_length(public.franchise_plays()->'plays') = 20
        and jsonb_array_length(public.franchise_formations()->'sets') = 5
        and (select count(*) from jsonb_array_elements(public.franchise_plays()->'plays') p
              where p->>'type' = 'trick') = 5
        -- every play lives in a real formation and names a real snap_v1 call,
        -- so a play SPECIALISES a call rather than replacing it
        and not exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
                         where public.franchise_formation(p->>'formation') is null)
        and not exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
                         where not exists (select 1 from jsonb_array_elements(public.franchise_snaps()->'calls') c
                                            where c->>'key' = p->>'call'))
        and not exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
                         where p->>'type' not in ('run', 'pass', 'trick'))
        -- A TRICK CONTRADICTS ITS OWN FORMATION'S TELL. That is what makes it
        -- a trick: a run look that throws, or a pass look that runs.
        and not exists (
              select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
               where p->>'type' = 'trick'
                 and sign((public.franchise_formation(p->>'formation')->>'tell')::numeric)
                     = sign(case when public.franchise_snap_call(p->>'call')->>'key' in ('air', 'shot')
                                 then 1 else -1 end))
        -- the tells run the whole way from a run look to a pass look
        and (public.franchise_formation('i_form')->>'tell')::numeric < -0.5
        and (public.franchise_formation('empty')->>'tell')::numeric > 0.5
        and (select bool_and(abs((fm->>'tell')::numeric) <= 1)
               from jsonb_array_elements(public.franchise_formations()->'sets') fm)
        -- EVERY SCHEME HAS ITS OWN BOOK, and none of them has all of it
        and array_length(public.franchise_playbook_sets('air_raid'), 1) between 2 and 4
        and not ('i_form' = any (public.franchise_playbook_sets('air_raid')))
        and not ('empty' = any (public.franchise_playbook_sets('power_run')))
        and public.franchise_play_allowed('power_run', 'flea_flicker')
        and not public.franchise_play_allowed('air_raid', 'flea_flicker')
        and (select bool_and(jsonb_array_length(public.franchise_playbook(sch)->'formations') > 0)
               from unnest(array['power_run', 'option', 'pro_style', 'spread', 'air_raid']) sch)
        -- a play out of the book is an offensive call like any other
        and public.franchise_call_side('flea_flicker') = 'off'
        and public.franchise_call_side('blitz') = 'def'
        -- and the book never collides with the four calls or the four fronts
        and not exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
                          join jsonb_array_elements(public.franchise_snaps()->'calls') c
                            on c->>'key' = p->>'key')
        and not exists (select 1 from jsonb_array_elements(public.franchise_plays()->'plays') p
                          join jsonb_array_elements(public.franchise_fronts()->'calls') c
                            on c->>'key' = p->>'key')
        -- THE LOAD-BEARING ONE, still. The client sends a play; the server
        -- resolves it. And what the DEFENSE is about to line up in is theirs:
        -- seeing their answer before you commit would be the whole game.
        and not has_function_privilege('anon', 'public.franchise_ai_front(numeric, integer, integer)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_ai_front(numeric, integer, integer)', 'execute')
        and not has_function_privilege('anon',
              'public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer)', 'execute')
        -- the book itself is open to read
        and has_function_privilege('anon', 'public.franchise_plays()', 'execute')
        and has_function_privilege('anon', 'public.franchise_playbook(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_play_allowed(text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 36, 'the roster is ' || (public.franchise_offseason_version())
        || ': every position is restocked to the plan, a rookie arrives at what the franchise has become, and losing a position cannot brick a career',
  case when public.franchise_offseason_version() = 'offseason_v2'
        -- THE OFFSEASON WALKS THE PLAN, not only the positions that still
        -- have somebody standing. Ten thousand seasons found what the old
        -- rule did: it read "select distinct position ... where status =
        -- 'active'", so the moment the last quarterback retired the position
        -- became invisible and could never be signed again. Fourteen of
        -- fifteen measured franchises had no kicker and no punter, nine had
        -- no quarterback, and 38.5% of them could never play again.
        and (select p.prosrc like '%select pp->>''pos'' from jsonb_array_elements(public.franchise_pool_plan()) pp%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_offseason')
        -- and it signs up to the plan's count rather than one-for-one
        and (select p.prosrc like '%jsonb_array_length(pp->''targets'')%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_offseason')
        -- THE BELT FOR THOSE BRACES. A score has to be credited to somebody,
        -- and a jsonb key built from a player who does not exist threw
        -- "key must not be null" and killed the franchise for good. A thin
        -- roster is a bad team; it is never a dead one.
        and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_anybody') = 1
        and public.franchise_anybody('[]'::jsonb, 'QB', 1) is null
        and public.franchise_anybody('[{"id":"x","position":"RB","overall":70,"depth":1}]'::jsonb, 'QB', 1)->>'id' = 'x'
        and public.franchise_anybody('[{"id":"q","position":"QB","overall":60,"depth":1},
                                       {"id":"r","position":"RB","overall":80,"depth":1}]'::jsonb, 'QB', 9)->>'id' = 'q'
        -- neither simulator may build a scoring key out of nobody
        and (select bool_and(p.prosrc not like '%tally || jsonb_build_object(scorer->>''id''%'
                          or p.prosrc like '%if scorer is not null then%')
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('franchise_sim', 'franchise_sim_score_play'))
        -- the plan is a published table, so the floor and the founding
        -- roster can never disagree about the shape of a team
        and (select sum(jsonb_array_length(pp->'targets'))
               from jsonb_array_elements(public.franchise_pool_plan()) pp) = 38
        -- AND A ROOKIE ARRIVES AT WHAT THE FRANCHISE HAS BECOME. The level was
        -- pegged to the worst backup in a FOUNDING roster for ever, so a club
        -- fifty seasons deep signed what a club founded yesterday signed and
        -- every team converged downward to the rookie pool: 69.7 overall at
        -- season one, 62.2 at season eighty. Rank and standing lift it now,
        -- which are exactly the two things a player who only plays moves.
        and public.franchise_rookie_lift(1, 0) = 0
        and public.franchise_rookie_lift(1, 100) = 8
        and public.franchise_rookie_lift(40, 100) = 14
        and public.franchise_rookie_lift(9999, 100) = 14
        and (select bool_and(public.franchise_rookie_lift(t.n, 50) <= public.franchise_rookie_lift(t.n + 1, 50))
               from generate_series(1, 300) as t(n))
        and (select bool_and(public.franchise_rookie_lift(20, t.n) <= public.franchise_rookie_lift(20, t.n + 1))
               from generate_series(0, 200) as t(n))
        and (select bool_and(public.franchise_rookie_lift(t.n, t.n) between 0 and 14)
               from generate_series(-50, 400) as t(n))
        -- the lift is read on the SERVER, from the record, never handed in
        and (select p.prosrc like '%public.franchise_rookie_lift(%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_generate_rookie')
        and not has_function_privilege('anon',
              'public.franchise_generate_player(uuid, text, integer, integer, text, text, text, integer, integer, integer)', 'execute')
        -- the plan is the server's own; a client never needs it and cannot
        -- reach it, which is why the floor lives on the server too
        and not has_function_privilege('anon', 'public.franchise_pool_plan()', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 37, 'the rank is derived from the record and a replayed reward cannot count twice, so a week played offline connects exactly as it was earned',
  case when
        -- THE RANK IS A READ, NOT A RECORD. franchise_rank_report sums the
        -- activity log with the published weights and writes nothing, so
        -- there is no rank counter to synchronise, drift or replay. If it
        -- ever stopped being STABLE something started writing.
        (select p.provolatile = 's' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'franchise_rank_report')
        -- and nothing anywhere stores a rank or a point total: only how many
        -- packs have been claimed, which is what was SPENT, not what was won
        and not exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'franchises'
                           and column_name in ('rank', 'rank_points', 'reputation', 'reputation_points'))
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'franchises'
                       and column_name = 'rank_claimed')
        -- THE ONE CONSTRAINT THE WHOLE OFFLINE STORY RESTS ON. The browser
        -- queues a reward under (kind, key) and replays it when it can reach
        -- the server again — including when the server already wrote the row
        -- and only the answer went missing. Drop this and a lost answer pays
        -- twice, and a rank is bought by a bad connection.
        and exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
                     where t.relname = 'franchise_activity' and c.contype = 'u'
                       and (select array_agg(a.attname::text order by a.attname)
                              from unnest(c.conkey) as u(att) join pg_attribute a
                                on a.attrelid = c.conrelid and a.attnum = u.att)
                           = array['franchise_id','key','kind'])
        -- every rank-bearing kind the client can earn with no server is a
        -- kind the activity table will actually accept
        and (select bool_and(pg_get_constraintdef(c.oid) like '%''' || k || '''%')
               from pg_constraint c join pg_class t on t.oid = c.conrelid,
                    unnest(array['price_it','pick5_card','drill_daily','research_open']) k
              where t.relname = 'franchise_activity' and c.conname = 'franchise_activity_kind_check')
        -- and each of them is worth something toward a rank, or playing
        -- offline would be playing for nothing
        and (select bool_and(((public.franchise_ranks()->'weights'->>k)::int) > 0)
               from unnest(array['price_it','pick5_card','drill_daily','research_open']) k)
        -- the rank curve never caps and never cheapens, at any depth
        and public.franchise_rank_for(0) = 1 and public.franchise_rank_for(-99) = 1
        and (select bool_and(public.franchise_rank_for(public.franchise_rank_at(t.n)) = t.n)
               from generate_series(2, 200) as t(n))
    then 'ok' else 'CHECK THIS' end
union all
select 38, 'the player universe is ' || (public.franchise_profile('QB', '{}'::jsonb, 70, null, 1, 25, 70, 'X')->>'version')
        || ': a profile derived from the four, eight tiers, a body and a home town, pure and open to read',
  case when public.franchise_profile('QB', '{}'::jsonb, 70, null, 1, 25, 70, 'X')->>'version' = 'profile_v1'
        -- pure: the same card gives the same profile, and the functions say so
        and (select bool_and(p.provolatile = 'i') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('franchise_profile', 'franchise_card_tier', 'franchise_potential_tier',
                                                            'franchise_body', 'franchise_hometown', 'franchise_pw', 'franchise_letters', 'franchise_noise'))
        -- every position carries the universal six and its own words
        and (select bool_and(pr ? 'spd' and pr ? 'acc' and pr ? 'agi' and pr ? 'str' and pr ? 'awr' and pr ? 'sta')
               from unnest(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P']) pos,
                    lateral (select public.franchise_profile(pos, '{}'::jsonb, 70, null, 10, 25, 75, 'Vance') pr) x)
        and public.franchise_profile('QB', '{"arm":90}'::jsonb, 70, null, 1, 25, 70, 'X') ? 'thp'
        and public.franchise_profile('CB', '{}'::jsonb, 70, null, 1, 25, 70, 'X') ? 'mcv'
        -- everything lands inside a rating
        and (select bool_and(v.value::int between 30 and 99) from jsonb_each_text(public.franchise_profile('WR', '{"spd":99,"rte":99,"hnd":99,"iq":99}'::jsonb, 99, 'Deep Threat', 81, 24, 99, 'Vance') - 'version') v)
        -- the tiers climb with the overall and the words with the ceiling
        and public.franchise_card_tier(50) = 'prospect' and public.franchise_card_tier(62) = 'starter' and public.franchise_card_tier(75) = 'prime'
        and public.franchise_card_tier(87) = 'apex' and public.franchise_card_tier(93) = 'legend' and public.franchise_card_tier(99) = 'mythic'
        and public.franchise_potential_tier(70, 70, 'normal') = 'limited' and public.franchise_potential_tier(70, 84, 'star') = 'breakout'
        and public.franchise_potential_tier(80, 96, 'superstar') = 'generational'
        -- a home town is a real place from the list, and the same one every time
        and public.franchise_hometown(7, 24, 80, 'Vance', 'Malik') = any (public.franchise_towns())
        and public.franchise_hometown(7, 24, 80, 'Vance', 'Malik') = public.franchise_hometown(7, 24, 80, 'Vance', 'Malik')
        -- the roster read model carries it
        and (select p.prosrc like '%franchise_profile_of(p)%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_roster')
        -- the brief's archetypes are in the generator, and the pools are wider
        and (select bool_and(exists (select 1 from jsonb_array_elements(public.franchise_pool_archetypes()->pos) a where a->>'name' = nm))
               from (values ('QB','Improviser'),('QB','Game Manager'),('RB','Workhorse'),('WR','Route Technician'),('WR','Slot Weapon'),
                            ('WR','Physical Target'),('DL','Speed Rusher'),('DL','Power Rusher'),('CB','Shutdown'),('CB','Press Specialist'),
                            ('CB','Zone Specialist')) t(pos, nm))
        and array_length(public.franchise_pool_first_names(), 1) >= 250
        and array_length(public.franchise_pool_last_names(), 1) >= 300
        and has_function_privilege('anon', 'public.franchise_profile(text, jsonb, integer, text, integer, integer, integer, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_profile_of(public.game_players)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 39, 'the Vault is ' || (public.franchise_pack_defs()->>'version')
        || ': packs you hold, derived from the record, rolled and written on the server, with odds a page can print and a rule you can read',
  case when public.franchise_pack_defs()->>'version' = 'packs_v4'
        -- nine kinds, each with a size, a keep and the words for what earns it
        and (select count(*) from jsonb_object_keys(public.franchise_pack_defs()->'kinds')) = 9
        -- and a passed man is worth something, by his tier
        and (select count(*) from jsonb_object_keys(public.franchise_pack_defs()->'pass_sp')) = 8
        and public.franchise_pass_sp(80) > public.franchise_pass_sp(60)
        and (select bool_and((k.value->>'size')::int between 2 and 4 and (k.value->>'keep')::int between 1 and 2
                             and k.value->>'earned' is not null and k.value->>'name' is not null)
               from jsonb_each(public.franchise_pack_defs()->'kinds') k)
        -- the men are written before anybody sees them: a pack row, a status, an id on every man
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'franchise_packs' and column_name = 'contents')
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'game_players' and column_name = 'pack_id')
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'game_players' and column_name = 'history')
        -- the card remembers, by trigger, so no path can forget to write the line
        and exists (select 1 from pg_trigger where tgname = 'franchise_card_history' and not tgisinternal)
        -- the client sends an id or nothing; the generator, the band, the odds and the grant are the server's
        and has_function_privilege('anon', 'public.franchise_pack_open_id(uuid, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_packs_board(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_card(uuid, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_pack_generate(uuid, uuid)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_pack_grant(uuid, text, text, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_pack_band(uuid, text)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_packs_sync(uuid)', 'execute')
        -- the odds are arithmetic on the band and add up to a hundred
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'franchise_pack_odds')
        -- the pack table is read by its owner and written by nobody
        and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'franchise_packs' and cmd = 'SELECT')
        and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'franchise_packs' and cmd <> 'SELECT')
    then 'ok' else 'CHECK THIS' end
union all
select 40, 'the lineup is ' || (public.franchise_lineup_rules()->>'version') || ', chemistry is ' || (public.franchise_chemistry_rules()->>'version')
        || ' and the Exchange is ' || (public.franchise_exchange_rules()->>'version')
        || ': a market between franchises where the server holds the price, the balance and the man',
  case when public.franchise_exchange_rules()->>'version' = 'exchange_v1'
        and public.franchise_chemistry_rules()->>'version' = 'chemistry_v1'
        and public.franchise_lineup_rules()->>'version' = 'lineup_v1'
        -- the fee is five per cent, rounded up, and leaves the economy
        and (public.franchise_exchange_rules()->>'fee_pct')::int = 5
        and public.franchise_exchange_fee(50) = 3 and public.franchise_exchange_fee(1000) = 50 and public.franchise_exchange_fee(999) = 50
        -- every scheme the franchise can run has a fit table
        and (select count(*) from jsonb_object_keys(public.franchise_scheme_fit()->'offense')) = 6
        and (select count(*) from jsonb_object_keys(public.franchise_scheme_fit()->'defense')) = 6
        -- chemistry reaches the simulation through the trait effects, and the roster prints it
        and (select p.prosrc like '%franchise_chemistry(p_franchise)%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_trait_effects')
        and (select p.prosrc like '%franchise_chemistry(f.id)%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_roster')
        -- the listings table is read by its parties and written by nobody but the server
        and exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'franchise_listings')
        and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'franchise_listings' and cmd = 'SELECT')
        and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'franchise_listings' and cmd <> 'SELECT')
        and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'franchise_listings_one_open')
        -- a client sends a listing id or a price of its own to list; the buy takes no price and no balance
        and has_function_privilege('anon', 'public.franchise_exchange_buy(uuid, text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_exchange_list(uuid, integer, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_exchange_browse(text, integer, integer, text, text, integer, integer, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_exchange_comps(text, integer)', 'execute')
        and has_function_privilege('anon', 'public.franchise_lineup_best(text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_chemistry(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_exchange_sweep()', 'execute')
        and not has_function_privilege('anon', 'public.franchise_exchange_illegal(uuid, uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_credit(uuid, text, integer, text, text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 41, 'the pull record is ' || (public.franchise_pulls_rules()->>'version')
        || ': every pack opened, read from the packs and the men as they were pulled, never stored twice',
  case when public.franchise_pulls_rules()->>'version' = 'pulls_v1'
        -- a read: if it ever stopped being STABLE something started writing
        and (select p.provolatile = 's' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_pulls')
        -- the pull as it was: the first history line, not the overall now
        and (select p.prosrc like '%history->0->>''overall''%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_pulled_overall')
        and has_function_privilege('anon', 'public.franchise_pulls(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_pulls_rules()', 'execute')
        and not has_function_privilege('anon', 'public.franchise_pulled_men(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.franchise_pulled_overall(public.game_players)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 42, 'the game you hold counts (' || (public.franchise_economy()->>'version') || ', ' || (public.franchise_pack_defs()->>'version')
        || '): a live result filed once, bounded, capped a day, weighed toward the rank, the careers in your hands kept apart, a Game Day pack every fifth game',
  case when public.franchise_economy()->>'version' = 'economy_v2' and public.franchise_pack_defs()->>'version' = 'packs_v4'
        and (public.franchise_ranks()->'weights'->>'live_game')::int = 2
        and not (public.franchise_ranks()->'weights' ? 'live_game_extra')
        and (public.franchise_economy()->'live_cap'->>'per_day')::int = 5
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'game_players' and column_name = 'live_stats')
        and (select bool_and(pg_get_constraintdef(c.oid) like '%''' || k || '''%')
               from pg_constraint c join pg_class t on t.oid = c.conrelid, unnest(array['live_game','live_game_extra']) k
              where t.relname = 'franchise_activity' and c.conname = 'franchise_activity_kind_check')
        and public.franchise_pack_def('gameday_pack')->>'art' = 'gameday'
        and (select p.prosrc like '%franchise_gameday_progress(p_franchise)%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_packs_sync')
        -- the lines land in live_stats and never in the simulation's career
        and (select p.prosrc like '%set live_stats = public.games_jsonb_sum(live_stats, v_stats)%' and p.prosrc not like '%career_stats = public.games_jsonb_sum%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'franchise_record_live_game')
        and has_function_privilege('anon', 'public.franchise_record_live_game(text, jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_gameday_progress(uuid)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 43, 'the card is not the man (' || (public.franchise_cards_rules()->>'version')
        || '): identities, editions, instances, ownership, lineup slots, listings, transactions and prices, each a table of its own',
  case when public.franchise_cards_rules()->>'version' = 'cards_v1'
        -- the six new things exist
        and (select count(*) from information_schema.tables where table_schema = 'public'
              and table_name in ('game_player_identities','game_card_defs','game_cards','game_card_ownership',
                                 'game_lineup_slots','game_market_txns','game_market_prices','game_card_provenance')) = 8
        -- every career sheet is the career of exactly one instance, and every
        -- instance has exactly one owner
        and not exists (select 1 from public.game_players where card_id is null)
        and not exists (select 1 from public.game_cards c where (select count(*) from public.game_card_ownership o where o.card_id = c.id) <> 1)
        -- the legacy owner column never drifts from the ownership record
        and not exists (select 1 from public.game_players p join public.game_card_ownership o on o.card_id = p.card_id
                         where p.franchise_id is distinct from o.owner_id)
        -- ownership moves through one door, and nothing else may write it
        and (select p.prosrc like '%franchise_card_transfer(), not by writing game_players.franchise_id%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'game_players_card_trg')
        and not has_function_privilege('anon', 'public.franchise_card_transfer(uuid, uuid, text, text, integer)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_cards_migrate()', 'execute')
        -- a listing offers an instance, and a sale can only be written once
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'franchise_listings' and column_name = 'card_id')
        and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'game_market_txns_listing')
        and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'game_market_txns_op')
        -- the adapter is public; the doors that move value are not
        and has_function_privilege('anon', 'public.franchise_card_entity(uuid)', 'execute')
        and has_function_privilege('anon', 'public.franchise_market_op(text, text)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 44, 'the living season (' || (public.franchise_season_rules()->>'version')
        || '): a power rating that is not the standings, ten award races scored on performance, and a title game of its own',
  case when public.franchise_season_rules()->>'version' = 'season_v1'
        -- the weekly snapshots exist and the title game has a flag of its own
        and (select count(*) from information_schema.tables where table_schema = 'public'
              and table_name in ('franchise_rank_weeks','franchise_award_weeks')) = 2
        and exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'franchise_games' and column_name = 'championship')
        -- the rating is not the record: every published term is in the rules
        and (public.franchise_season_rules()->'power' ? 'sos')
        and (public.franchise_season_rules()->'power' ? 'margin_cap')
        and (public.franchise_season_rules()->'power' ? 'quality_win')
        and jsonb_array_length(public.franchise_season_rules()->'awards') = 10
        -- an award score never reads an overall, and never reads a name
        and (select p.prosrc not like '%overall%' and p.prosrc not like '%archetype%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_award_score')
        -- and neither does the most valuable man in the title game
        and (select p.prosrc not like '%overall%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_championship_mvp')
        -- the week takes its own snapshot, after the season lines are written
        and exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                     where c.relname = 'franchise_games' and t.tgname = 'franchise_games_snapshot' and t.tgdeferrable)
        -- the pages may read; only the server may write a snapshot
        and has_function_privilege('anon', 'public.franchise_rankings(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_awards(text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_championship(text)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_rankings_write(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_awards_write(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_power_rankings(uuid, integer)', 'execute')
        and not has_function_privilege('anon', 'public.franchise_award_races(uuid, integer)', 'execute')
    then 'ok' else 'CHECK THIS' end
union all
select 45, 'one door, once (' || (public.franchise_resume_rules()->>'version')
        || '): every operation that hands out value takes a key, and a client is never told maybe',
  case when public.franchise_resume_rules()->>'version' = 'resume_v1'
        and exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'franchise_ops')
        -- the ledger is one row per key, so a second knock cannot do the work twice
        and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'franchise_ops'
              and column_name in ('franchise_id', 'op_key', 'kind', 'result')) = 4
        and exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
                     where t.relname = 'franchise_ops' and c.contype = 'p')
        -- the door locks the franchise before it decides, so two tabs cannot race
        and (select p.prosrc like '%from public.franchises where id = v_f for update%'
               and p.prosrc like '%on conflict (franchise_id, op_key) do nothing%'
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'franchise_once')
        -- five operations take a key, and the answer is only ever one of two
        and (select count(*) from jsonb_object_keys(public.franchise_resume_rules()->'ops')) = 5
        and public.franchise_resume_rules()->'states' = '["completed","not_completed"]'::jsonb
        -- and the client may ask any of them, including what it is holding
        and has_function_privilege('anon', 'public.franchise_once(text, text, text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_op(text, text)', 'execute')
        and has_function_privilege('anon', 'public.franchise_pack_pending(text)', 'execute')
    then 'ok' else 'CHECK THIS' end
order by 1;

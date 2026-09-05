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
    'version', 'economy_v1',
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
    'import_unverified_price_it', jsonb_build_object('xp', 50),
    'import_unverified_pick5',    jsonb_build_object('xp', 75)
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

create index if not exists game_players_franchise on public.game_players (franchise_id, position, depth);

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
                    'season_started','weekly_game','weekly_win','season_complete')),
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
  economy        text not null default 'economy_v1',
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

-- The record grows kinds with the weekly game. The constraint is replaced by
-- name (the name Postgres gives an inline column check) so an installation
-- that applied Phase 1 gets the new kinds without a rebuild.
alter table public.franchise_activity drop constraint if exists franchise_activity_kind_check;
alter table public.franchise_activity add constraint franchise_activity_kind_check check (kind in
  ('price_it','pick5_card','pick5_result','drill_daily','research_open','h2h_locked','h2h_win','founded',
   'season_started','weekly_game','weekly_win','season_complete'));

insert into public.franchise_achievement_defs (id, name, description, exclusive_season, sort) values
  ('first_win',       'First Win',       'Your franchise''s first weekly game won.', null, 40),
  ('bragging_rights', 'Bragging Rights', 'Beat your rival.', null, 41),
  ('shutout',         'Shutout',         'Held an opponent scoreless.', null, 42),
  ('first_season',    'A Full Season',   'Completed your first franchise season.', null, 43),
  ('winning_season',  'Winning Season',  'Finished a season with more wins than losses.', null, 44),
  ('perfect_season',  'Perfect Season',  'Won every game of a season.', null, 45)
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

drop policy if exists game_players_own on public.game_players;
create policy game_players_own on public.game_players for select
  using (franchise_id is not null and public.franchise_is_mine(franchise_id));

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
  first_names text[] := array[
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
  last_names text[] := array[
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
  plan jsonb := '[
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
  archetypes jsonb := '{
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
  trait_pool jsonb := '[
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

      -- age leans young; development and potential follow
      age := 21 + floor(power(random(), 1.4) * 12)::int;
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
         where franchise_id = p_franchise and position = p_pos and status = 'active'
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
  update public.franchises set user_id = auth.uid(), anon_hash = null, updated_at = now() where id = v_id;
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
-- THE WEEKLY GAME — sim_v1
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
    where p.franchise_id = p_franchise and p.status = 'active'
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
      'status', g.status, 'played_at', g.played_at, 'score_for', g.score_for, 'score_against', g.score_against,
      'result', g.result, 'ot', coalesce((g.box->>'ot')::boolean, false), 'potg', g.box->'potg',
      'prep', g.box->'edges'->'prep', 'sim_version', g.sim_version,
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
  f public.franchises%rowtype; s public.franchise_seasons%rowtype; ovr numeric;
  keys text[]; k text; w integer; offsets integer[] := array[-6, -3, -1, 0, 1, 2, 4];
  i integer; j integer; tmp integer; o public.franchise_opponents%rowtype;
  oovr integer; d integer; spread integer; home boolean; wk text; opens timestamptz; made integer := 0;
begin
  select * into f from public.franchises where id = p_franchise for update;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise and number = p_number;
  if not found then raise exception 'no such season' using errcode = 'P0002'; end if;
  if exists (select 1 from public.franchise_games where franchise_id = p_franchise and season_number = p_number) then
    return 0;
  end if;
  perform setseed(public.franchise_seed_float(f.seed || ':season:' || p_number));
  ovr := (public.franchise_team_rating(p_franchise)->>'overall')::numeric;

  -- the rival, once
  if f.rival_key is null then
    select key into k from public.franchise_opponents order by random() limit 1;
    update public.franchises set rival_key = k, updated_at = now() where id = p_franchise;
    f.rival_key := k;
  end if;

  -- the other clubs, distinct, and the offsets shuffled
  select array_agg(key) into keys
    from (select key from public.franchise_opponents where key <> f.rival_key order by random() limit s.weeks - 1) q;
  for i in reverse array_length(offsets, 1)..2 loop
    j := 1 + floor(random() * i)::int;
    tmp := offsets[i]; offsets[i] := offsets[j]; offsets[j] := tmp;
  end loop;
  home := random() < 0.5;

  for w in 1..s.weeks loop
    if w = s.weeks then k := f.rival_key; d := 2;
    else k := keys[w]; d := offsets[((w - 1) % array_length(offsets, 1)) + 1]; end if;
    select * into o from public.franchise_opponents where key = k;
    oovr := greatest(45, least(95, round(ovr + d + (random() * 2 - 1))::int));
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
create or replace function public.franchise_sim_drive(
  p_off numeric, p_def numeric, p_st numeric, p_pass_share numeric, p_takeaway numeric, p_clutch numeric, p_short_field boolean)
returns jsonb language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  edge numeric := p_off - p_def; p_td numeric; p_fg numeric; p_to numeric; r numeric := random();
  outcome text; pts integer := 0; yds integer; plays integer; is_pass boolean; py integer; pp integer;
begin
  p_td := greatest(0.05, least(0.45, 0.21 + edge * 0.005 + (case when p_short_field then 0.15 else 0 end)));
  p_fg := greatest(0.06, least(0.28, 0.15 + edge * 0.003 + (case when p_short_field then 0.12 else 0 end)));
  p_to := greatest(0.04, least(0.24, 0.12 - edge * 0.003 + p_takeaway));
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
  is_pass := random() < p_pass_share;
  py := round(yds * p_pass_share)::int; pp := round(plays * p_pass_share)::int;
  return jsonb_build_object('outcome', outcome, 'pts', pts, 'yds', yds, 'plays', plays, 'is_pass', is_pass,
    'pass_yds', py, 'rush_yds', yds - py, 'pass_plays', pp, 'rush_plays', plays - pp);
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

-- THE SIMULATOR. Reads the game, the roster, the opponent frozen on the
-- game, this week's preparation and the starters' traits; plays it; returns
-- the box. Writes nothing — franchise_play_game does the writing.
create or replace function public.franchise_sim(p_franchise uuid, p_game uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; g public.franchise_games%rowtype; rt jsonb; opp jsonb; prep jsonb; tr jsonb; ps jsonb;
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
begin
  select * into f from public.franchises where id = p_franchise;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into g from public.franchise_games where id = p_game and franchise_id = p_franchise;
  if not found then raise exception 'no such game' using errcode = 'P0002'; end if;
  perform setseed(public.franchise_seed_float(g.seed));

  rt := public.franchise_team_rating(p_franchise);
  opp := g.opponent;
  prep := public.franchise_prep(p_franchise, g.week_key);
  tr := public.franchise_trait_effects(p_franchise);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.position,
      'jersey', p.jersey, 'depth', p.depth, 'overall', p.overall, 'ratings', p.ratings) order by p.depth, p.overall desc), '[]'::jsonb)
    into ps from public.game_players p where p.franchise_id = p_franchise and p.status = 'active';

  -- effective ratings
  my_off := (rt->>'offense')::numeric; my_def := (rt->>'defense')::numeric; my_st := (rt->>'special')::numeric;
  op_off := (opp->>'offense_r')::numeric; op_def := (opp->>'defense_r')::numeric; op_st := coalesce((opp->>'special_r')::numeric, op_off);
  h_me := case when g.home then 1.5 else 0 end; h_op := case when g.home then 0 else 1.5 end;
  prep_pts := least(100, (prep->>'preparation')::numeric + 2 * (tr->>'preparation')::numeric);
  prep_adj := round((prep_pts - 50) / 50.0 * 3, 2);
  sch_me := public.franchise_scheme_edge(f.offense, opp->>'defense');
  sch_op := public.franchise_scheme_edge(opp->>'offense', f.defense);
  a_off := my_off + h_me + prep_adj + sch_me + 0.25 * (tr->>'offense')::numeric;
  a_def := my_def + h_me + prep_adj + 0.25 * (tr->>'defense')::numeric;
  b_off := op_off + h_op + sch_op;
  b_def := op_def + h_op;
  late_off := 0.5 * (tr->>'late_offense')::numeric; late_def := 0.5 * (tr->>'late_defense')::numeric;
  pass_me := public.franchise_pass_share(f.offense); pass_op := public.franchise_pass_share(opp->>'offense');
  qb_share := public.franchise_qb_rush_share(f.offense);
  passer := public.franchise_nth(ps, 'QB', 1); kicker := public.franchise_nth(ps, 'K', 1);

  -- possessions a side: tempo by scheme
  n := 11 + floor(random() * 3)::int;
  if f.offense in ('air_raid', 'spread') then n := n + 1; end if;
  if (opp->>'offense') in ('air_raid', 'spread') then n := n + 1; end if;
  if f.offense in ('power_run', 'option') then n := n - 1; end if;
  if (opp->>'offense') in ('power_run', 'option') then n := n - 1; end if;
  n := greatest(9, least(14, n));
  me_first := random() < 0.5;

  for i in 1..n + 4 loop
    -- regulation is n possessions a side; then overtime rounds while tied
    if i > n then
      exit when pts_me <> pts_op or rnd >= 2;
      rnd := rnd + 1; ot := true; q := 5; short := true;
    else
      q := 1 + ((i - 1) * 4) / n; short := false;
    end if;
    for k in 0..1 loop
      who := case when (k = 0) = me_first then 'me' else 'opp' end;
      if who = 'me' then
        d := public.franchise_sim_drive(a_off + case when q >= 4 then late_off else 0 end, b_def, my_st, pass_me, 0,
               case when q >= 4 then 0.02 * (tr->>'clutch')::numeric else 0 end, short);
        pts_me := pts_me + (d->>'pts')::int; q_me[q] := q_me[q] + (d->>'pts')::int;
        tot_me := public.games_jsonb_sum(tot_me, public.franchise_drive_totals(d));
        if d->>'outcome' = 'td' then
          if (d->>'is_pass')::boolean then
            -- a receiver by share
            r := random(); scorer := null;
            for j in 1..array_length(rec_w, 1) loop
              r := r - rec_w[j];
              if r < 0 then scorer := public.franchise_nth(ps, rec_pos[j], rec_n[j]); exit; end if;
            end loop;
            if scorer is null then scorer := public.franchise_nth(ps, 'WR', 1); end if;
            dist := 1 + floor(random() * 40)::int;
            desc_ := (passer->>'name') || ' to ' || (scorer->>'name') || ', ' || dist || '-yd TD pass';
            tally := tally || jsonb_build_object(scorer->>'id', public.games_jsonb_sum(tally->(scorer->>'id'), '{"rec_td":1}'::jsonb));
            tally := tally || jsonb_build_object(passer->>'id', public.games_jsonb_sum(tally->(passer->>'id'), '{"pass_td":1}'::jsonb));
          else
            r := random();
            scorer := case when r < qb_share then passer when r < qb_share + (1 - qb_share) * 0.8 then public.franchise_nth(ps, 'RB', 1)
                           else public.franchise_nth(ps, 'RB', 2) end;
            if scorer is null then scorer := public.franchise_nth(ps, 'RB', 1); end if;
            dist := 1 + floor(random() * 25)::int;
            desc_ := (scorer->>'name') || ', ' || dist || '-yd TD run';
            tally := tally || jsonb_build_object(scorer->>'id', public.games_jsonb_sum(tally->(scorer->>'id'), '{"rush_td":1}'::jsonb));
          end if;
          scoring := scoring || jsonb_build_object('q', q, 'side', 'for', 'type', 'TD', 'pts', 7, 'desc', desc_, 'for', pts_me, 'against', pts_op);
        elsif d->>'outcome' = 'fg' then
          dist := 20 + floor(random() * 33)::int;
          scoring := scoring || jsonb_build_object('q', q, 'side', 'for', 'type', 'FG', 'pts', 3,
            'desc', coalesce(kicker->>'name', 'Field goal') || ', ' || dist || '-yd FG', 'for', pts_me, 'against', pts_op);
        end if;
      else
        d := public.franchise_sim_drive(b_off, a_def + case when q >= 4 then late_def else 0 end, op_st, pass_op,
               0.01 * (tr->>'takeaway')::numeric, 0, short);
        pts_op := pts_op + (d->>'pts')::int; q_op[q] := q_op[q] + (d->>'pts')::int;
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
    end loop;
  end loop;

  result := case when pts_me > pts_op then 'W' when pts_me < pts_op then 'L' else 'T' end;
  players := public.franchise_sim_lines(ps, f.offense, tot_me, tot_op, tally, tr);
  select p into potg from jsonb_array_elements(players) p order by (p->>'impact')::numeric desc limit 1;

  return jsonb_build_object(
    'sim', 'sim_v1', 'seed', g.seed, 'home', g.home, 'rival', g.rival, 'week', g.week, 'season_number', g.season_number,
    'opponent', opp, 'final', jsonb_build_object('for', pts_me, 'against', pts_op), 'result', result, 'ot', ot,
    'quarters', jsonb_build_object('for', to_jsonb(q_me), 'against', to_jsonb(q_op), 'ot', ot),
    'scoring', scoring,
    'team', jsonb_build_object('for', tot_me, 'against', tot_op),
    'edges', jsonb_build_object('home', h_me, 'prep', prep, 'prep_adj', prep_adj, 'scheme_offense', sch_me, 'scheme_defense', sch_op,
      'traits', tr, 'offense', round(a_off, 1), 'defense', round(a_def, 1), 'opp_offense', round(b_off, 1), 'opp_defense', round(b_def, 1),
      'possessions', n),
    'players', players, 'potg', potg);
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
create or replace function public.franchise_play_game(p_franchise uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f public.franchises%rowtype; s public.franchise_seasons%rowtype; g public.franchise_games%rowtype;
  v_box jsonb; pf integer; pa integer; res text; ln jsonb; econ jsonb := public.franchise_economy();
  v_key text; v_xp integer := 0; v_tc integer := 0; v_cp integer := 0; v_new text[] := '{}'; v_label text; v_done boolean := false;
begin
  select * into f from public.franchises where id = p_franchise for update;
  if not found then raise exception 'no franchise' using errcode = '22023'; end if;
  select * into s from public.franchise_seasons where franchise_id = p_franchise order by number desc limit 1;
  if not found or s.status <> 'active' then
    raise exception 'the season is not under way' using errcode = '55000';
  end if;
  select * into g from public.franchise_games
   where franchise_id = p_franchise and season_number = s.number and status = 'scheduled' order by week limit 1;
  if not found then raise exception 'no game is scheduled' using errcode = 'P0002'; end if;
  if g.opens_at > p_now then
    raise exception 'week % opens on %', g.week, to_char(g.opens_at, 'Dy DD Mon HH24:MI "UTC"') using errcode = '55000';
  end if;

  v_box := public.franchise_sim(p_franchise, g.id);
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

  v_key := s.number || ':' || g.week;
  v_label := 'Week ' || g.week || ' ' || (case when g.home then 'vs ' else 'at ' end) || (g.opponent->>'name') || ': ' || res || ' ' || pf || '–' || pa;
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
  values (p_franchise, 'weekly_game', v_key, g.week_key, public.games_day_key(p_now),
    jsonb_build_object('game_id', g.id, 'season_number', s.number, 'week', g.week, 'result', res, 'for', pf, 'against', pa,
      'opponent', g.opponent->>'name', 'rival', g.rival, 'preparation', v_box->'edges'->'prep'->'preparation'), p_now);
  if public.franchise_credit(p_franchise, 'xp', (econ->'weekly_game'->>'xp')::int, 'weekly_game', v_key, v_label) then
    v_xp := v_xp + (econ->'weekly_game'->>'xp')::int; end if;
  if public.franchise_credit(p_franchise, 'tc', (econ->'weekly_game'->>'tc')::int, 'weekly_game', v_key, v_label) then
    v_tc := v_tc + (econ->'weekly_game'->>'tc')::int; end if;

  if res = 'W' then
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail, created_at)
    values (p_franchise, 'weekly_win', v_key, g.week_key, public.games_day_key(p_now),
      jsonb_build_object('game_id', g.id, 'season_number', s.number, 'week', g.week, 'rival', g.rival), p_now);
    if public.franchise_credit(p_franchise, 'xp', (econ->'weekly_win'->>'xp')::int, 'weekly_win', v_key, v_label) then
      v_xp := v_xp + (econ->'weekly_win'->>'xp')::int; end if;
    if public.franchise_credit(p_franchise, 'tc', (econ->'weekly_win'->>'tc')::int, 'weekly_win', v_key, v_label) then
      v_tc := v_tc + (econ->'weekly_win'->>'tc')::int; end if;
    if public.franchise_credit(p_franchise, 'cp', (econ->'weekly_win'->>'cp')::int, 'weekly_win', v_key, v_label) then
      v_cp := v_cp + (econ->'weekly_win'->>'cp')::int; end if;
    if public.franchise_award(p_franchise, 'first_win', s.season, jsonb_build_object('game_id', g.id)) then v_new := array_append(v_new, 'first_win'); end if;
    if g.rival then
      if public.franchise_credit(p_franchise, 'xp', (econ->'rival_win'->>'xp')::int, 'rival_win', v_key, 'Beat the ' || (g.opponent->>'name')) then
        v_xp := v_xp + (econ->'rival_win'->>'xp')::int; end if;
      if public.franchise_credit(p_franchise, 'cp', (econ->'rival_win'->>'cp')::int, 'rival_win', v_key, 'Beat the ' || (g.opponent->>'name')) then
        v_cp := v_cp + (econ->'rival_win'->>'cp')::int; end if;
      if public.franchise_award(p_franchise, 'bragging_rights', s.season, jsonb_build_object('game_id', g.id)) then v_new := array_append(v_new, 'bragging_rights'); end if;
    end if;
    if pa = 0 and public.franchise_award(p_franchise, 'shutout', s.season, jsonb_build_object('game_id', g.id)) then v_new := array_append(v_new, 'shutout'); end if;
  end if;

  if g.week >= s.weeks then
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
    'rewards', jsonb_build_object('xp', v_xp, 'tc', v_tc, 'cp', v_cp),
    'achievements', to_jsonb(v_new), 'totals', public.franchise_totals(p_franchise));
end;
$$;

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
  v_wk jsonb; v_ach jsonb; v_ss jsonb; v_recent jsonb;
begin
  select * into f from public.franchises where id = public.franchise_of(p_secret);
  if not found then return null; end if;
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
      'h2h_wins', count(*) filter (where kind = 'h2h_win'))
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
      'acquired_detail', p.acquired_detail, 'career_stats', p.career_stats, 'season_stats', p.season_stats)
      order by array_position(array['QB','RB','WR','TE','OL','DL','LB','CB','S','K','P'], p.position), p.depth, p.overall desc), '[]'::jsonb)
    into v_players from public.game_players p where p.franchise_id = f.id and p.status = 'active';
  return jsonb_build_object(
    'franchise', jsonb_build_object('id', f.id, 'name', f.name, 'city', f.city, 'abbr', f.abbr, 'logo', f.logo, 'theme', f.theme,
      'offense', f.offense, 'defense', f.defense, 'founded_season', f.founded_season,
      'owner', case when f.user_id is not null then 'account' else 'device' end),
    'rating', public.franchise_team_rating(f.id),
    'starters', jsonb_build_object('QB', 1, 'RB', 1, 'WR', 3, 'TE', 1, 'OL', 5, 'DL', 4, 'LB', 3, 'CB', 2, 'S', 2, 'K', 1, 'P', 1),
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
declare e record; v_f uuid; v_key text := new.id::text; v_label text;
begin
  if new.settled_at is null then return new; end if;
  v_label := coalesce(new.away_team, '?') || ' vs ' || coalesce(new.home_team, '?');
  -- an entry is an account or a device secret; a franchise may be either
  for e in select * from public.game_challenge_entries where challenge_id = new.id loop
    v_f := null;
    if e.user_id is not null then
      select id into v_f from public.franchises where user_id = e.user_id;
    elsif e.anon_hash is not null then
      select id into v_f from public.franchises where anon_hash = e.anon_hash;
    end if;
    if v_f is null then continue; end if;
    insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail)
    values (v_f, 'h2h_locked', v_key, public.games_week_key(now()), public.games_day_key(now()),
            jsonb_build_object('challenge', new.invite_token, 'mode', new.mode, 'result', e.result, 'game', v_label))
    on conflict do nothing;
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
revoke all on function public.franchise_sim_drive(numeric, numeric, numeric, numeric, numeric, numeric, boolean) from public, anon, authenticated;
revoke all on function public.franchise_drive_totals(jsonb) from public, anon, authenticated;
revoke all on function public.franchise_nth(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.franchise_sim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.franchise_sim_lines(jsonb, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.franchise_play_game(uuid, timestamptz) from public, anon, authenticated;

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

commit;

-- ===========================================================================
-- THE REPORT. Every row should say ok.
-- ===========================================================================
select 1 as row, 'franchise tables exist' as what,
  case when (select count(*) from pg_tables where schemaname = 'public' and tablename in
    ('game_board','franchises','franchise_seasons','game_players','franchise_activity','franchise_ledger',
     'franchise_pick5_cards','franchise_pick5_selections','franchise_achievement_defs','franchise_achievements',
     'franchise_opponents','franchise_games')) = 12
    then 'ok' else 'CHECK THIS' end as status
union all
select 2, 'row level security is on for every franchise table',
  case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in
    ('game_board','franchises','franchise_seasons','game_players','franchise_activity','franchise_ledger',
     'franchise_pick5_cards','franchise_pick5_selections','franchise_achievement_defs','franchise_achievements',
     'franchise_opponents','franchise_games')) = 12
    then 'ok' else 'CHECK THIS' end
union all
select 3, 'no client role may write a franchise table directly',
  case when not exists (select 1 from pg_policies where schemaname = 'public' and cmd <> 'SELECT' and tablename in
    ('game_board','franchises','franchise_seasons','game_players','franchise_activity','franchise_ledger',
     'franchise_pick5_cards','franchise_pick5_selections','franchise_achievement_defs','franchise_achievements',
     'franchise_opponents','franchise_games'))
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
  case when public.franchise_economy()->>'version' = 'economy_v1' then 'ok' else 'CHECK THIS' end
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
order by 1;

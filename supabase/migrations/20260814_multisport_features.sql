-- ============================================================================
-- 20260814_multisport_features.sql
--
-- Gives NFL, college football and college basketball the same depth MLB has.
--
-- The MLB layer works because the engine owns a table per thing that decides a
-- baseball game: the starter, the offense he faces, the bullpen behind him, the
-- park, the weather. Three tables here do the same job for football and
-- basketball, and the columns are chosen from how these sports are ACTUALLY
-- handicapped rather than from what is easy to scrape:
--
--   team_features     efficiency, not points. In football that is EPA per play
--                     and success rate; in basketball it is tempo-adjusted
--                     offensive and defensive efficiency plus the four factors.
--                     Points per game is a pace artifact and decides nothing.
--
--   qb_features       football's equivalent of pitcher_features. No other
--                     position moves a number this much, and a backup starting
--                     is the single largest predictable line move in the sport.
--
--   matchup_context   the situational layer: rest, travel, altitude, surface,
--                     neutral site, conference/rivalry, rankings. In college
--                     especially, these swing games that the efficiency numbers
--                     alone will not explain.
--
-- Every column is nullable. A source that cannot fill one leaves it null and
-- the ingest reports the fill rate, so a column that is quietly always empty is
-- visible rather than mistaken for a fact that happens to be missing today.
--
-- Additive and idempotent. Nothing is dropped, no column changes type.
-- ============================================================================

-- ---------------------------------------------------------- team_features
create table if not exists public.team_features (
  game_id        text not null,
  side           text not null check (side in ('home','away')),
  sport_key      text,
  team           text,
  team_id        text,

  -- record and form
  wins           integer,
  losses         integer,
  win_pct        numeric,
  last5_wins     integer,
  points_for_pg  numeric,
  points_against_pg numeric,
  margin_pg      numeric,

  -- ---- efficiency: the part that actually predicts ----
  -- Football (nflverse / play-by-play derived)
  off_epa_play        numeric,   -- expected points added per offensive play
  def_epa_play        numeric,   -- allowed; NEGATIVE is good for a defence
  off_success_rate    numeric,
  def_success_rate    numeric,
  pass_epa_play       numeric,
  rush_epa_play       numeric,
  def_pass_epa_play   numeric,
  def_rush_epa_play   numeric,
  explosive_play_rate numeric,
  yards_per_play      numeric,
  opp_yards_per_play  numeric,
  third_down_pct      numeric,
  def_third_down_pct  numeric,
  red_zone_td_pct     numeric,
  def_red_zone_td_pct numeric,
  turnover_margin_pg  numeric,
  sack_rate           numeric,   -- defence: sacks per opponent dropback
  sack_rate_allowed   numeric,   -- offence: how often the QB goes down
  penalty_yards_pg    numeric,
  st_epa              numeric,   -- special teams
  plays_per_game      numeric,   -- pace; the totals input

  -- Basketball (tempo-free; Torvik/KenPom shape)
  adj_o          numeric,        -- points scored per 100 possessions, adjusted
  adj_d          numeric,        -- allowed per 100, adjusted. LOWER is better.
  adj_em         numeric,        -- adj_o - adj_d
  adj_tempo      numeric,        -- possessions per 40 minutes
  -- four factors, offence then defence
  efg_pct        numeric,
  to_pct         numeric,
  orb_pct        numeric,
  ft_rate        numeric,
  def_efg_pct    numeric,
  def_to_pct     numeric,
  def_orb_pct    numeric,        -- opponent offensive rebound rate allowed
  def_ft_rate    numeric,
  three_rate     numeric,        -- share of shots from three
  three_pct      numeric,
  def_three_rate numeric,
  def_three_pct  numeric,
  ft_pct         numeric,
  avg_height     numeric,
  experience     numeric,        -- average years
  bench_minutes  numeric,
  wab            numeric,        -- wins above bubble

  metrics        jsonb,          -- anything a source provides that has no column yet
  source         text,
  updated_at     timestamptz not null default now(),
  primary key (game_id, side)
);

create index if not exists team_features_sport_idx on public.team_features (sport_key, updated_at desc);
create index if not exists team_features_team_idx  on public.team_features (team);

comment on table public.team_features is
  'Per-game, per-side team efficiency. Football uses EPA/play and success rate; basketball uses tempo-adjusted efficiency and the four factors. Points per game is recorded but is a pace artifact and should not drive a conclusion.';
comment on column public.team_features.def_epa_play is
  'EPA allowed per play. NEGATIVE is a good defence — the sign is the opposite of the offensive column and reversing it silently flips every conclusion.';
comment on column public.team_features.adj_d is
  'Adjusted points allowed per 100 possessions. LOWER is better, unlike every other efficiency column here.';
comment on column public.team_features.adj_tempo is
  'Possessions per 40 minutes. This is the totals input in basketball: two slow teams can be excellent and still play under.';

-- ------------------------------------------------------------ qb_features
-- Football's pitcher_features. A backup starting is the largest predictable
-- line move in the sport, so `status` and `is_backup` matter as much as the
-- efficiency columns.
create table if not exists public.qb_features (
  game_id            text not null,
  side               text not null check (side in ('home','away')),
  sport_key          text,
  player_id          text,
  name               text,
  team               text,

  epa_per_dropback   numeric,
  cpoe               numeric,     -- completion % over expected
  ypa                numeric,
  comp_pct           numeric,
  td_rate            numeric,
  int_rate           numeric,
  sack_rate_taken    numeric,
  pressure_rate      numeric,
  rush_epa           numeric,
  qbr                numeric,
  passer_rating      numeric,
  attempts           integer,
  games_started      integer,

  status             text,        -- active / questionable / doubtful / out
  is_backup          boolean,
  depth_order        integer,
  injury_note        text,

  source             text,
  updated_at         timestamptz not null default now(),
  primary key (game_id, side)
);

create index if not exists qb_features_sport_idx on public.qb_features (sport_key, updated_at desc);

comment on table public.qb_features is
  'Starting quarterback per game side. The football equivalent of pitcher_features: no other position moves a number this much, and an unconfirmed or backup starter is the single most valuable thing to know before betting a football game.';
comment on column public.qb_features.is_backup is
  'True when the listed starter is not the season-long starter. Treat any conclusion built on the starter as PROVISIONAL until status is active and is_backup is false.';

-- -------------------------------------------------------- matchup_context
-- The situational layer. In college especially, these decide games that the
-- efficiency numbers alone will not explain.
create table if not exists public.matchup_context (
  game_id          text primary key,
  sport_key        text,
  game_date        date,
  neutral_site     boolean,
  conference_game  boolean,
  is_rivalry       boolean,
  home_rest_days   integer,
  away_rest_days   integer,
  short_week       boolean,       -- football: Thursday off a Sunday
  off_bye_home     boolean,
  off_bye_away     boolean,
  home_rank        integer,
  away_rank        integer,
  ranking_poll     text,
  venue            text,
  indoor           boolean,
  surface          text,
  altitude_ft      numeric,
  travel_miles_away numeric,
  tv               text,
  attendance_pct   numeric,
  notes            jsonb,
  source           text,
  updated_at       timestamptz not null default now()
);

create index if not exists matchup_context_sport_idx on public.matchup_context (sport_key, game_date desc);

comment on table public.matchup_context is
  'Situational context per game: rest, travel, altitude, surface, neutral site, conference/rivalry, rankings. Cheap to store and frequently the difference between a number that looks wrong and one that is.';
comment on column public.matchup_context.short_week is
  'Football: playing on a materially shorter rest than normal (a Thursday game off a Sunday). One of the few situational factors with a durable, well-evidenced effect.';

-- ------------------------------------------------------------------- RLS
alter table public.team_features    enable row level security;
alter table public.qb_features      enable row level security;
alter table public.matchup_context  enable row level security;

-- These hold no user data. Any signed-in user may read; only the service role
-- (which bypasses RLS) writes, so no write policy is needed.
drop policy if exists tf_read on public.team_features;
create policy tf_read on public.team_features for select using (auth.role() = 'authenticated');
drop policy if exists qf_read on public.qb_features;
create policy qf_read on public.qb_features for select using (auth.role() = 'authenticated');
drop policy if exists mc_read on public.matchup_context;
create policy mc_read on public.matchup_context for select using (auth.role() = 'authenticated');

grant select on public.team_features   to authenticated;
grant select on public.qb_features     to authenticated;
grant select on public.matchup_context to authenticated;

-- ------------------------------------------------------------------ health
-- The same lesson as mlb_ingest_health: a cron returning 200 while a table
-- quietly stops filling is invisible for weeks. This makes it a number.
create or replace view public.multisport_ingest_health as
select
  sport_key,
  count(*)                                                          as team_rows,
  count(*) filter (where off_epa_play is not null)                  as with_football_epa,
  count(*) filter (where adj_o is not null)                         as with_basketball_efficiency,
  count(*) filter (where updated_at > now() - interval '36 hours')  as fresh_rows,
  max(updated_at)                                                   as newest
from public.team_features
group by sport_key;

comment on view public.multisport_ingest_health is
  'Per-sport row counts for the multisport ingest. A sport whose fresh_rows is zero has a broken feed regardless of what the cron returned.';

grant select on public.multisport_ingest_health to authenticated;

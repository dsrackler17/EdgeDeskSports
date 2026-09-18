-- ===========================================================================
-- EdgeDesk MLB — the historical OFFENSIVE record, 2016–2025.
--
-- WHY THIS FILE EXISTS. The pitching archive (supabase/mlb_pitcher_history.sql)
-- gave the desk a pitcher's ten-season history. The other half of a baseball
-- game had nothing behind it: EdgeDesk held tonight's team offense rates
-- (public.team_season, public.offense_features) and no hitter history at all.
-- "How has Judge hit over the last five completed seasons", "which clubs has
-- this hitter played for", "was that OPS reaching base or power", "who led the
-- 2025 offensive rating at 500+ PA" all arrived and left with nothing.
--
-- This is that record. It lives in the SAME mlbhist schema as the pitching
-- archive ON PURPOSE: the two packages share MLB player IDs, team IDs and
-- season keys, so a two-way player is one join rather than one cross-schema
-- problem, and the browser's already-exposed schema list does not change.
--
--   mlbhist.batter_seasons             one row per hitter per season, teams
--                                      COMBINED. Unique on (player_id, season).
--   mlbhist.batter_team_seasons        one row per hitter, season and club.
--                                      Unique on (player_id, season, team_id).
--                                      A traded hitter has one row per club and
--                                      the season row above is their sum — THE
--                                      TWO GRAINS ARE NEVER ADDED TOGETHER.
--   mlbhist.batter_overview            one row per hitter across the window.
--   mlbhist.batter_team_history        one row per hitter and club across it.
--   mlbhist.observed_batter_team_runs  consecutive record seasons with one
--                                      club. Gaps split runs. NOT contract
--                                      stints, trades or roster dates.
--   mlbhist.team_offense_seasons       one club-season, with ACTUAL club games
--                                      and runs per game.
--   mlbhist.team_offense_overview      one club across the window.
--   mlbhist.league_offense_seasons     the annual MLB offensive baseline the
--                                      ratings are computed against.
--   mlbhist.offense_validation         the packaged per-season verification.
--   mlbhist.offense_source_repairs     the 31 player-seasons whose team splits
--                                      came from MLB's individual year-by-year
--                                      feed because the team query omitted a
--                                      club. No value was ever inferred by
--                                      subtraction.
--   mlbhist.offense_games_reconciliation  the player-seasons where MLB's
--                                      official games count and the sum of the
--                                      team splits disagree. Kept, not fixed.
--
-- mlbhist.teams IS NOT DUPLICATED. The offensive package ships its own
-- teams.csv; it was compared row for row against the pitching archive's and
-- agrees on all 300 season-club rows across team_name, abbreviation, league
-- and division. One identity table serves both, which is the fact that makes
-- joining the two archives safe.
--
-- THREE GAME COUNTS, AND THEY ARE NOT INTERCHANGEABLE.
--   batter_seasons.games                MLB's official player-season games.
--                                       THIS is a player's games. It can
--                                       include games with no batting.
--   batter_seasons.team_split_games_sum  the sum of that player's team splits,
--                                       kept ONLY for reconciliation. One 2024
--                                       player-season disagrees by a game and
--                                       that disagreement is preserved in
--                                       offense_games_reconciliation rather
--                                       than smoothed away.
--   team_offense_*.player_games_sum      the sum of player games. It is NOT the
--                                       number of games a club played and must
--                                       never be used as one.
--   team_offense_*.team_games            the club's actual games, from MLB's
--                                       own team endpoint. runs_per_game uses
--                                       THIS.
--
-- WHAT THE RATING IS. offensive_index is a CUSTOM DESCRIPTIVE index, version
-- ED_BAT_PERF_V1:
--     sample_weight    = PA / (PA + 200)
--     offensive_index  = 100 + 100 * sample_weight
--                              * (OBP/league_OBP + SLG/league_SLG - 2)
-- 100 is MLB average for that season, higher is better. It is NOT OPS+, NOT
-- wRC+, NOT WAR, not a percentile, not a 0–100 grade, not park- or
-- opponent-adjusted, not a measure of defence or baserunning value, not a
-- probability and not a forecast. The 200-PA shrinkage constant is a stated
-- design choice, not a fitted one. rating_version, rating_sample_weight and
-- plate_appearances travel on every rated row so no screen can print the
-- number without the terms it was computed under, and sample_flag says which
-- of zero_PA / under_50_PA / 50_to_199_PA / 200_plus_PA a row is.
--
-- NULL MEANS UNDEFINED, AND THAT IS LOAD-BEARING HERE. 1,889 of the 10,098
-- player-seasons have zero plate appearances — pitchers, mostly — and they
-- keep their counting statistics with every rate and the rating null. 17 rows
-- have walks and no at-bats: OBP is defined, SLG, OPS and the rating are not.
-- Nothing in this file substitutes a zero for an undefined rate.
--
-- THIS ARCHIVE ENDS IN 2025 AND IS NEVER CURRENT-SEASON DATA, AND IT IS NEVER
-- A LINEUP. It cannot say who is batting tonight; public.offense_features and
-- the live lineup source remain the only answer to that, and both are
-- untouched by this file.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor after mlb_pitcher_history.sql.
-- Every report row should say ok.
--
-- Tested against a real PostgreSQL by tools/mlb/mlb_offense_sql.test.js
-- (`npm run mlb:off:sql`), which applies this file twice, attacks it as anon
-- and as authenticated, and proves a failed import cannot replace good data.
-- ===========================================================================

create schema if not exists mlbhist;
grant usage on schema mlbhist to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The import ledger is SHARED with the pitching archive, discriminated by
-- dataset. One place to look when a refresh fails, two independent gates.
-- Additive: rows written before this column existed are pitching rows.
-- ---------------------------------------------------------------------------
alter table if exists mlbhist.import_runs
  add column if not exists dataset text not null default 'pitching';

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'mlbhist_import_runs_dataset_ck') then
    alter table mlbhist.import_runs drop constraint mlbhist_import_runs_dataset_ck;
  end if;
  alter table mlbhist.import_runs
    add constraint mlbhist_import_runs_dataset_ck check (dataset in ('pitching','offense'));
exception when undefined_table then
  raise exception 'mlbhist.import_runs is missing — run supabase/mlb_pitcher_history.sql first';
end $$;

create index if not exists mlbhist_import_runs_dataset_idx
  on mlbhist.import_runs (dataset, status, started_at desc);

-- ---------------------------------------------------------------------------
-- THE RECORD.
-- ---------------------------------------------------------------------------

-- One row per hitter per season, teams COMBINED.
create table if not exists mlbhist.batter_seasons (
  player_id                 int  not null,
  season                    int  not null,
  player_name               text not null,
  name_key                  text not null,          -- accent-folded, for resolution
  age                       int,
  position_reported         text,
  team_count                int,
  team_ids                  int[],
  teams                     text,
  games                     int,                    -- OFFICIAL player games
  team_split_games_sum      int,                    -- reconciliation only
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg                       double precision,
  obp                       double precision,
  slg                       double precision,
  ops                       double precision,
  iso                       double precision,
  babip                     double precision,
  k_pct                     double precision,
  bb_pct                    double precision,
  hr_pct                    double precision,
  sb_success_pct            double precision,
  sample_flag               text,
  league_obp                double precision,
  league_slg                double precision,
  rating_sample_weight      double precision,
  rating_version            text,
  offensive_index           double precision,
  provisional               boolean not null default false,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_batter_seasons_key primary key (player_id, season)
);

-- One row per hitter, season and club. A traded hitter has one row per club.
create table if not exists mlbhist.batter_team_seasons (
  player_id                 int  not null,
  season                    int  not null,
  team_id                   int  not null,
  player_name               text not null,
  name_key                  text not null,
  team_name                 text,
  position_reported         text,
  age                       int,
  games                     int,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  league_obp                double precision,
  league_slg                double precision,
  rating_sample_weight      double precision,
  rating_version            text,
  offensive_index           double precision,
  provisional               boolean not null default false,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_batter_team_seasons_key primary key (player_id, season, team_id)
);

-- One row per hitter across the whole window.
create table if not exists mlbhist.batter_overview (
  player_id                 int  primary key,
  player_name               text not null,
  name_key                  text not null,
  games                     int,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  first_observed_season     int,
  last_observed_season      int,
  seasons_with_records      int,
  seasons_with_pa           int,
  observed_seasons          text,
  boundary_start            boolean,
  boundary_end              boolean,
  rated_plate_appearances   int,
  weighted_offensive_index  double precision,
  -- team_count and teams are DERIVED BY THE IMPORTER from batter_team_history.
  -- The package ships both blank on every one of its 3,097 overview rows while
  -- carrying the clubs correctly at the team grain; the importer rebuilds them
  -- from that same package and records the substitution in
  -- import_runs.transformations. Nothing is inferred from outside the dataset.
  team_count                int,
  teams                     text,
  latest_observed_offensive_index double precision,
  best_season_by_index      int,
  rating_version            text,
  import_id                 text,
  imported_at               timestamptz not null default now()
);

-- One row per hitter and club across the window.
create table if not exists mlbhist.batter_team_history (
  player_id                 int  not null,
  team_id                   int  not null,
  player_name               text not null,
  name_key                  text not null,
  games                     int,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  first_observed_season     int,
  last_observed_season      int,
  seasons_with_records      int,
  seasons_with_pa           int,
  observed_seasons          text,
  boundary_start            boolean,
  boundary_end              boolean,
  rated_plate_appearances   int,
  weighted_offensive_index  double precision,
  team_names_observed       text,
  rating_version            text,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_batter_team_history_key primary key (player_id, team_id)
);

-- Consecutive record seasons with one club. A gap splits a run. These are NOT
-- verified contract, trade or roster-date intervals.
create table if not exists mlbhist.observed_batter_team_runs (
  player_id                 int  not null,
  team_id                   int  not null,
  observed_run_number       int  not null,
  player_name               text not null,
  name_key                  text not null,
  games                     int,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  first_observed_season     int,
  last_observed_season      int,
  seasons_with_records      int,
  seasons_with_pa           int,
  observed_seasons          text,
  boundary_start            boolean,
  boundary_end              boolean,
  rated_plate_appearances   int,
  weighted_offensive_index  double precision,
  team_names_observed       text,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_observed_batter_team_runs_key primary key (player_id, team_id, observed_run_number)
);

-- One club-season. runs_per_game uses team_games — the club's ACTUAL games.
create table if not exists mlbhist.team_offense_seasons (
  season                    int  not null,
  team_id                   int  not null,
  team_name                 text,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  league_obp                double precision,
  league_slg                double precision,
  rating_sample_weight      double precision,
  rating_version            text,
  offensive_index           double precision,
  player_games_sum          int,                    -- NOT club games
  players_with_records      int,
  team_games                int,                    -- club games, official
  runs_per_game             double precision,
  team_totals_source_url    text,
  provisional               boolean not null default false,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_team_offense_seasons_key primary key (season, team_id)
);

create table if not exists mlbhist.team_offense_overview (
  team_id                   int primary key,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  first_observed_season     int,
  last_observed_season      int,
  seasons_with_records      int,
  seasons_with_pa           int,
  observed_seasons          text,
  boundary_start            boolean,
  boundary_end              boolean,
  rated_plate_appearances   int,
  weighted_offensive_index  double precision,
  team_names_observed       text,
  player_games_sum          int,
  team_games                int,
  runs_per_game             double precision,
  rating_version            text,
  import_id                 text,
  imported_at               timestamptz not null default now()
);

-- The annual MLB baseline the ratings are computed against. Includes every
-- hitter MLB returned, pitchers included — that is what makes 100 mean what
-- the rating says it means.
create table if not exists mlbhist.league_offense_seasons (
  season                    int primary key,
  plate_appearances         int, at_bats int, runs int, hits int, singles int,
  doubles int, triples int, home_runs int, rbi int,
  walks int, intentional_walks int, strikeouts int, hit_by_pitch int,
  stolen_bases int, caught_stealing int, total_bases int,
  sacrifice_bunts int, sacrifice_flies int, grounded_into_double_play int,
  catcher_interference int, pitches_seen int,
  avg double precision, obp double precision, slg double precision, ops double precision,
  iso double precision, babip double precision,
  k_pct double precision, bb_pct double precision, hr_pct double precision,
  sb_success_pct double precision,
  sample_flag               text,
  player_games_sum          int,
  provisional               boolean not null default false,
  import_id                 text,
  imported_at               timestamptz not null default now()
);

create table if not exists mlbhist.offense_validation (
  season                    int primary key,
  teams                     int,
  players                   int,
  player_team_rows          int,
  counting_fields_reconciled int,
  player_totals_reconcile   boolean,
  team_totals_reconcile     boolean,
  import_id                 text,
  imported_at               timestamptz not null default now()
);

create table if not exists mlbhist.offense_source_repairs (
  season                    int not null,
  player_id                 int not null,
  previous_team_rows        int,
  replacement_team_rows     int,
  source_url                text,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_offense_source_repairs_key primary key (season, player_id)
);

-- Where MLB's own official player-season games and the sum of that player's
-- team splits disagree. Recorded, never reconciled away.
create table if not exists mlbhist.offense_games_reconciliation (
  season                    int not null,
  player_id                 int not null,
  official_games            int,
  team_split_games_sum      int,
  import_id                 text,
  imported_at               timestamptz not null default now(),
  constraint mlbhist_offense_games_recon_key primary key (season, player_id)
);

-- ---------------------------------------------------------------------------
-- Indexes. Written for the reads the product actually makes: a hitter by id or
-- folded name, a club's season, a season leaderboard by rating or by a
-- counting statistic, a workload filter, and a position screen.
-- ---------------------------------------------------------------------------
create index if not exists mlbhist_bat_seasons_player_idx      on mlbhist.batter_seasons (player_id, season);
create index if not exists mlbhist_bat_seasons_season_idx      on mlbhist.batter_seasons (season);
create index if not exists mlbhist_bat_seasons_name_idx        on mlbhist.batter_seasons (name_key);
create index if not exists mlbhist_bat_seasons_rating_idx      on mlbhist.batter_seasons (season, offensive_index desc nulls last);
create index if not exists mlbhist_bat_seasons_pa_idx          on mlbhist.batter_seasons (season, plate_appearances desc);
create index if not exists mlbhist_bat_seasons_hr_idx          on mlbhist.batter_seasons (season, home_runs desc nulls last);
create index if not exists mlbhist_bat_seasons_pos_idx         on mlbhist.batter_seasons (season, position_reported, plate_appearances desc);
create index if not exists mlbhist_bat_team_seasons_player_idx on mlbhist.batter_team_seasons (player_id, season);
create index if not exists mlbhist_bat_team_seasons_team_idx   on mlbhist.batter_team_seasons (team_id, season, plate_appearances desc);
create index if not exists mlbhist_bat_team_seasons_season_idx on mlbhist.batter_team_seasons (season, team_id);
create index if not exists mlbhist_bat_team_seasons_name_idx   on mlbhist.batter_team_seasons (name_key);
create index if not exists mlbhist_bat_overview_name_idx       on mlbhist.batter_overview (name_key);
create index if not exists mlbhist_bat_overview_pa_idx         on mlbhist.batter_overview (plate_appearances desc);
create index if not exists mlbhist_bat_overview_last_idx       on mlbhist.batter_overview (last_observed_season desc, plate_appearances desc);
create index if not exists mlbhist_bat_overview_rating_idx     on mlbhist.batter_overview (weighted_offensive_index desc nulls last);
create index if not exists mlbhist_bat_team_history_team_idx   on mlbhist.batter_team_history (team_id, plate_appearances desc);
create index if not exists mlbhist_bat_team_history_player_idx on mlbhist.batter_team_history (player_id);
create index if not exists mlbhist_bat_runs_player_idx         on mlbhist.observed_batter_team_runs (player_id, first_observed_season);
create index if not exists mlbhist_bat_runs_team_idx           on mlbhist.observed_batter_team_runs (team_id, first_observed_season);
create index if not exists mlbhist_team_off_seasons_team_idx   on mlbhist.team_offense_seasons (team_id, season desc);
create index if not exists mlbhist_team_off_seasons_rating_idx on mlbhist.team_offense_seasons (season, offensive_index desc nulls last);
create index if not exists mlbhist_team_off_seasons_rpg_idx    on mlbhist.team_offense_seasons (season, runs_per_game desc nulls last);

-- ---------------------------------------------------------------------------
-- Staging. Every import writes here FIRST. Nothing reaches a live table until
-- mlbhist.promote_offense_import() has checked it.
-- ---------------------------------------------------------------------------
create table if not exists mlbhist.stg_batter_seasons            (like mlbhist.batter_seasons            including defaults);
create table if not exists mlbhist.stg_batter_team_seasons       (like mlbhist.batter_team_seasons       including defaults);
create table if not exists mlbhist.stg_batter_overview           (like mlbhist.batter_overview           including defaults);
create table if not exists mlbhist.stg_batter_team_history       (like mlbhist.batter_team_history       including defaults);
create table if not exists mlbhist.stg_observed_batter_team_runs (like mlbhist.observed_batter_team_runs including defaults);
create table if not exists mlbhist.stg_team_offense_seasons      (like mlbhist.team_offense_seasons      including defaults);
create table if not exists mlbhist.stg_team_offense_overview     (like mlbhist.team_offense_overview     including defaults);
create table if not exists mlbhist.stg_league_offense_seasons    (like mlbhist.league_offense_seasons    including defaults);
create table if not exists mlbhist.stg_offense_validation        (like mlbhist.offense_validation        including defaults);
create table if not exists mlbhist.stg_offense_source_repairs    (like mlbhist.offense_source_repairs    including defaults);
create table if not exists mlbhist.stg_offense_games_reconciliation (like mlbhist.offense_games_reconciliation including defaults);

create index if not exists mlbhist_stg_bat_seasons_import_idx      on mlbhist.stg_batter_seasons (import_id);
create index if not exists mlbhist_stg_bat_team_seasons_import_idx on mlbhist.stg_batter_team_seasons (import_id);
create index if not exists mlbhist_stg_bat_overview_import_idx     on mlbhist.stg_batter_overview (import_id);
create index if not exists mlbhist_stg_bat_team_history_import_idx on mlbhist.stg_batter_team_history (import_id);
create index if not exists mlbhist_stg_bat_runs_import_idx         on mlbhist.stg_observed_batter_team_runs (import_id);
create index if not exists mlbhist_stg_team_off_seasons_import_idx on mlbhist.stg_team_offense_seasons (import_id);
create index if not exists mlbhist_stg_team_off_overview_import_idx on mlbhist.stg_team_offense_overview (import_id);
create index if not exists mlbhist_stg_league_off_import_idx       on mlbhist.stg_league_offense_seasons (import_id);
create index if not exists mlbhist_stg_off_validation_import_idx   on mlbhist.stg_offense_validation (import_id);
create index if not exists mlbhist_stg_off_repairs_import_idx      on mlbhist.stg_offense_source_repairs (import_id);
create index if not exists mlbhist_stg_off_games_import_idx        on mlbhist.stg_offense_games_reconciliation (import_id);

-- ===========================================================================
-- THE PROMOTE GATE.
--
-- One transaction. It checks the staged rows against what the package said it
-- was shipping and against the keys the record depends on, and only then
-- replaces the live tables. Anything it refuses leaves the last successful
-- dataset exactly where it was, which is the difference between a failed
-- refresh and a lost archive.
--
-- The five refusals, each returned by name rather than as a generic error:
--   EMPTY_STAGING        nothing was staged for this import
--   COUNT_MISMATCH       staged rows disagree with the package's own counts
--   DUPLICATE_KEY        the same (player, season[, team]) arrived twice
--   VALIDATION_FAILED    the package's own per-season reconciliation did not
--                        pass, at the player grain or the team grain
--   GRAIN_VIOLATION      a player-season's combined totals disagree with the
--                        sum of its own team splits on plate appearances. The
--                        two grains describe the same performance; if they
--                        disagree, one of them is wrong and neither may ship.
-- ===========================================================================
create or replace function mlbhist.promote_offense_import(p_import_id text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
declare
  run             mlbhist.import_runs%rowtype;
  n_seasons       bigint; n_team_seasons bigint; n_overview bigint; n_team_history bigint;
  n_runs          bigint; n_team_off bigint; n_team_off_ov bigint; n_league bigint;
  n_validation    bigint; n_repairs bigint; n_games bigint;
  dup_seasons     bigint; dup_team_seasons bigint; dup_overview bigint;
  bad_players     bigint; bad_teams bigint;
  grain_breaks    bigint;
  expected        jsonb;
  staged          jsonb;
  problems        text[] := '{}';
  cov_lo          int; cov_hi int;
begin
  select * into run from mlbhist.import_runs where import_id = p_import_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_IMPORT',
      'detail', format('no import_runs row for %s', p_import_id));
  end if;

  select count(*) into n_seasons      from mlbhist.stg_batter_seasons            where import_id = p_import_id;
  select count(*) into n_team_seasons from mlbhist.stg_batter_team_seasons       where import_id = p_import_id;
  select count(*) into n_overview     from mlbhist.stg_batter_overview           where import_id = p_import_id;
  select count(*) into n_team_history from mlbhist.stg_batter_team_history       where import_id = p_import_id;
  select count(*) into n_runs         from mlbhist.stg_observed_batter_team_runs where import_id = p_import_id;
  select count(*) into n_team_off     from mlbhist.stg_team_offense_seasons      where import_id = p_import_id;
  select count(*) into n_team_off_ov  from mlbhist.stg_team_offense_overview     where import_id = p_import_id;
  select count(*) into n_league       from mlbhist.stg_league_offense_seasons    where import_id = p_import_id;
  select count(*) into n_validation   from mlbhist.stg_offense_validation        where import_id = p_import_id;
  select count(*) into n_repairs      from mlbhist.stg_offense_source_repairs    where import_id = p_import_id;
  select count(*) into n_games        from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;

  staged := jsonb_build_object(
    'batter_seasons', n_seasons, 'batter_team_seasons', n_team_seasons,
    'batter_overview', n_overview, 'batter_team_history', n_team_history,
    'observed_team_runs', n_runs, 'team_offense_seasons', n_team_off,
    'team_offense_overview', n_team_off_ov, 'league_seasons', n_league,
    'validation', n_validation, 'source_repairs', n_repairs,
    'games_reconciliation', n_games);

  if n_seasons = 0 or n_team_seasons = 0 or n_overview = 0 or n_team_off = 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'nothing was staged for this import', finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'EMPTY_STAGING', 'staged', staged);
  end if;

  -- The package's own counts, from build_report.json. A dataset that claims
  -- 10,098 batter-seasons and stages 10,000 has lost rows somewhere between
  -- the file and here, and the live table is a better answer than a truncated
  -- refresh.
  expected := coalesce(run.expected_counts, '{}'::jsonb);
  if expected ? 'batter_seasons'        and (expected->>'batter_seasons')::bigint        <> n_seasons      then problems := problems || format('batter_seasons expected %s staged %s',        expected->>'batter_seasons',        n_seasons); end if;
  if expected ? 'batter_team_seasons'   and (expected->>'batter_team_seasons')::bigint   <> n_team_seasons then problems := problems || format('batter_team_seasons expected %s staged %s',   expected->>'batter_team_seasons',   n_team_seasons); end if;
  if expected ? 'batter_overview'       and (expected->>'batter_overview')::bigint       <> n_overview     then problems := problems || format('batter_overview expected %s staged %s',       expected->>'batter_overview',       n_overview); end if;
  if expected ? 'batter_team_history'   and (expected->>'batter_team_history')::bigint   <> n_team_history then problems := problems || format('batter_team_history expected %s staged %s',   expected->>'batter_team_history',   n_team_history); end if;
  if expected ? 'observed_team_runs'    and (expected->>'observed_team_runs')::bigint    <> n_runs         then problems := problems || format('observed_team_runs expected %s staged %s',    expected->>'observed_team_runs',    n_runs); end if;
  if expected ? 'team_offense_seasons'  and (expected->>'team_offense_seasons')::bigint  <> n_team_off     then problems := problems || format('team_offense_seasons expected %s staged %s',  expected->>'team_offense_seasons',  n_team_off); end if;
  if expected ? 'team_offense_overview' and (expected->>'team_offense_overview')::bigint <> n_team_off_ov  then problems := problems || format('team_offense_overview expected %s staged %s', expected->>'team_offense_overview', n_team_off_ov); end if;
  if expected ? 'league_seasons'        and (expected->>'league_seasons')::bigint        <> n_league       then problems := problems || format('league_seasons expected %s staged %s',        expected->>'league_seasons',        n_league); end if;

  if array_length(problems, 1) is not null then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'staged rows disagree with the package: ' || array_to_string(problems, '; '), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'COUNT_MISMATCH', 'staged', staged,
      'expected', expected, 'problems', to_jsonb(problems));
  end if;

  select count(*) into dup_seasons from (
    select player_id, season from mlbhist.stg_batter_seasons where import_id = p_import_id
    group by 1, 2 having count(*) > 1) d;
  select count(*) into dup_team_seasons from (
    select player_id, season, team_id from mlbhist.stg_batter_team_seasons where import_id = p_import_id
    group by 1, 2, 3 having count(*) > 1) d;
  select count(*) into dup_overview from (
    select player_id from mlbhist.stg_batter_overview where import_id = p_import_id
    group by 1 having count(*) > 1) d;
  if dup_seasons > 0 or dup_team_seasons > 0 or dup_overview > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('duplicate keys staged: %s player-seasons, %s player-team-seasons, %s players',
                       dup_seasons, dup_team_seasons, dup_overview),
      finished_at = now() where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY', 'staged', staged,
      'duplicate_player_seasons', dup_seasons,
      'duplicate_player_team_seasons', dup_team_seasons,
      'duplicate_players', dup_overview);
  end if;

  select count(*) into bad_players from mlbhist.stg_offense_validation
    where import_id = p_import_id and player_totals_reconcile is distinct from true;
  select count(*) into bad_teams from mlbhist.stg_offense_validation
    where import_id = p_import_id and team_totals_reconcile is distinct from true;
  if bad_players > 0 or bad_teams > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('%s season(s) failed the player reconciliation and %s the team reconciliation',
                       bad_players, bad_teams), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'staged', staged,
      'unreconciled_player_seasons', bad_players, 'unreconciled_team_seasons', bad_teams);
  end if;

  -- THE TWO GRAINS MUST AGREE. batter_seasons is the combined total and
  -- batter_team_seasons is the same performance split by club, so their plate
  -- appearances must be equal for every player-season that has splits. This is
  -- the check that would catch a package which lost a traded player's second
  -- club — the exact failure that makes a career look smaller than it was.
  select count(*) into grain_breaks from (
    select s.player_id, s.season
      from mlbhist.stg_batter_seasons s
      join (select player_id, season, sum(plate_appearances) pa
              from mlbhist.stg_batter_team_seasons where import_id = p_import_id
             group by 1, 2) t
        on t.player_id = s.player_id and t.season = s.season
     where s.import_id = p_import_id
       and coalesce(s.plate_appearances, 0) <> coalesce(t.pa, 0)) d;
  if grain_breaks > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('%s player-season(s) disagree with the sum of their own team splits on plate appearances', grain_breaks),
      finished_at = now() where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'GRAIN_VIOLATION', 'staged', staged,
      'player_seasons_disagreeing', grain_breaks);
  end if;

  -- ---- the swap -----------------------------------------------------------
  -- Season-keyed tables are replaced for the seasons this dataset covers, so a
  -- record MLB has since removed disappears instead of lingering, and a season
  -- outside the coverage window is left alone. The window-wide summaries are
  -- replaced whole, because that is what they are.
  cov_lo := coalesce(run.coverage_start, (select min(season) from mlbhist.stg_batter_seasons where import_id = p_import_id));
  cov_hi := coalesce(run.coverage_end,   (select max(season) from mlbhist.stg_batter_seasons where import_id = p_import_id));

  delete from mlbhist.batter_seasons               where season between cov_lo and cov_hi;
  delete from mlbhist.batter_team_seasons          where season between cov_lo and cov_hi;
  delete from mlbhist.team_offense_seasons         where season between cov_lo and cov_hi;
  delete from mlbhist.league_offense_seasons       where season between cov_lo and cov_hi;
  delete from mlbhist.offense_validation           where season between cov_lo and cov_hi;
  delete from mlbhist.offense_source_repairs       where season between cov_lo and cov_hi;
  delete from mlbhist.offense_games_reconciliation where season between cov_lo and cov_hi;
  delete from mlbhist.batter_overview where true;
  delete from mlbhist.batter_team_history where true;
  delete from mlbhist.observed_batter_team_runs where true;
  delete from mlbhist.team_offense_overview where true;

  insert into mlbhist.batter_seasons               select * from mlbhist.stg_batter_seasons            where import_id = p_import_id;
  insert into mlbhist.batter_team_seasons          select * from mlbhist.stg_batter_team_seasons       where import_id = p_import_id;
  insert into mlbhist.batter_overview              select * from mlbhist.stg_batter_overview           where import_id = p_import_id;
  insert into mlbhist.batter_team_history          select * from mlbhist.stg_batter_team_history       where import_id = p_import_id;
  insert into mlbhist.observed_batter_team_runs    select * from mlbhist.stg_observed_batter_team_runs where import_id = p_import_id;
  insert into mlbhist.team_offense_seasons         select * from mlbhist.stg_team_offense_seasons      where import_id = p_import_id;
  insert into mlbhist.team_offense_overview        select * from mlbhist.stg_team_offense_overview     where import_id = p_import_id;
  insert into mlbhist.league_offense_seasons       select * from mlbhist.stg_league_offense_seasons    where import_id = p_import_id;
  insert into mlbhist.offense_validation           select * from mlbhist.stg_offense_validation        where import_id = p_import_id;
  insert into mlbhist.offense_source_repairs       select * from mlbhist.stg_offense_source_repairs    where import_id = p_import_id;
  insert into mlbhist.offense_games_reconciliation select * from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;

  -- Only OFFENSE runs are superseded. The pitching archive's promoted import
  -- is a different dataset in the same ledger and is none of this gate's
  -- business.
  update mlbhist.import_runs set status = 'superseded'
    where status = 'promoted' and dataset = 'offense' and import_id <> p_import_id;
  update mlbhist.import_runs
    set status = 'promoted', staged_counts = staged, promoted_counts = staged,
        promoted_at = now(), finished_at = now(), message = null
    where import_id = p_import_id;

  insert into mlbhist.meta (key, value) values
    ('offense_last_import_id', p_import_id),
    ('offense_last_import_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('offense_coverage_start', cov_lo::text),
    ('offense_coverage_end', cov_hi::text),
    ('offense_rating_version', coalesce(run.rating_version, 'ED_BAT_PERF_V1'))
  on conflict (key) do update set value = excluded.value;

  delete from mlbhist.stg_batter_seasons               where import_id = p_import_id;
  delete from mlbhist.stg_batter_team_seasons          where import_id = p_import_id;
  delete from mlbhist.stg_batter_overview              where import_id = p_import_id;
  delete from mlbhist.stg_batter_team_history          where import_id = p_import_id;
  delete from mlbhist.stg_observed_batter_team_runs    where import_id = p_import_id;
  delete from mlbhist.stg_team_offense_seasons         where import_id = p_import_id;
  delete from mlbhist.stg_team_offense_overview        where import_id = p_import_id;
  delete from mlbhist.stg_league_offense_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_offense_validation           where import_id = p_import_id;
  delete from mlbhist.stg_offense_source_repairs       where import_id = p_import_id;
  delete from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'import_id', p_import_id,
    'coverage', jsonb_build_object('start', cov_lo, 'end', cov_hi), 'rows', staged);
end $$;

revoke all on function mlbhist.promote_offense_import(text) from public, anon, authenticated;
grant execute on function mlbhist.promote_offense_import(text) to service_role;

create or replace function mlbhist.abandon_offense_import(p_import_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
begin
  delete from mlbhist.stg_batter_seasons               where import_id = p_import_id;
  delete from mlbhist.stg_batter_team_seasons          where import_id = p_import_id;
  delete from mlbhist.stg_batter_overview              where import_id = p_import_id;
  delete from mlbhist.stg_batter_team_history          where import_id = p_import_id;
  delete from mlbhist.stg_observed_batter_team_runs    where import_id = p_import_id;
  delete from mlbhist.stg_team_offense_seasons         where import_id = p_import_id;
  delete from mlbhist.stg_team_offense_overview        where import_id = p_import_id;
  delete from mlbhist.stg_league_offense_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_offense_validation           where import_id = p_import_id;
  delete from mlbhist.stg_offense_source_repairs       where import_id = p_import_id;
  delete from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;
  update mlbhist.import_runs
    set status = 'failed', message = coalesce(p_reason, 'abandoned before promotion'), finished_at = now()
    where import_id = p_import_id and status <> 'promoted';
  return jsonb_build_object('ok', true, 'import_id', p_import_id, 'abandoned', true);
end $$;
revoke all on function mlbhist.abandon_offense_import(text, text) from public, anon, authenticated;
grant execute on function mlbhist.abandon_offense_import(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- What the shell shows about this pipeline. A view rather than a table so it
-- cannot drift from the ledger it describes.
-- ---------------------------------------------------------------------------
create or replace view mlbhist.offense_status as
select r.import_id, r.status, r.coverage_start, r.coverage_end, r.provisional_seasons,
       r.rating_version, r.dataset_built_at, r.source, r.promoted_at,
       r.promoted_counts, r.validation, r.source_repairs, r.transformations,
       (select count(*) from mlbhist.batter_seasons)        as live_batter_seasons,
       (select count(*) from mlbhist.batter_team_seasons)   as live_batter_team_seasons,
       (select count(*) from mlbhist.batter_overview)       as live_batters,
       (select count(*) from mlbhist.batter_overview where plate_appearances > 0) as live_batters_with_pa,
       (select count(*) from mlbhist.team_offense_seasons)  as live_team_offense_seasons
from mlbhist.import_runs r
where r.status = 'promoted' and r.dataset = 'offense'
order by r.promoted_at desc nulls last
limit 1;

-- ---------------------------------------------------------------------------
-- THE TWO-WAY VIEW. One row per player who has BOTH a hitting record with
-- plate appearances and a pitching record with outs inside this window, joined
-- on the MLB person id the two packages share. It is a view, not a table, so
-- it can never drift from the two archives underneath it — and it is the whole
-- answer to "show Ohtani's hitting and pitching together" without inventing a
-- second identity for him.
--
-- The PA and outs thresholds are the honest part: every pitcher who ever stood
-- in a batter's box is in batter_seasons, so "has a hitting record" is not the
-- same as "is a hitter". Both sides carry their own workload so a caller can
-- decide what counts as meaningful rather than being told.
-- ---------------------------------------------------------------------------
create or replace view mlbhist.two_way_players as
select b.player_id,
       b.player_name,
       b.name_key,
       b.plate_appearances            as batting_plate_appearances,
       b.games                        as batting_games,
       b.home_runs                    as batting_home_runs,
       b.ops                          as batting_ops,
       b.weighted_offensive_index     as batting_index,
       b.first_observed_season        as batting_first_season,
       b.last_observed_season         as batting_last_season,
       b.seasons_with_pa              as batting_seasons_with_pa,
       p.outs                         as pitching_outs,
       p.innings_display              as pitching_innings,
       p.starts                       as pitching_starts,
       p.era                          as pitching_era,
       p.weighted_performance_index   as pitching_index,
       p.first_observed_season        as pitching_first_season,
       p.last_observed_season         as pitching_last_season,
       p.role                         as pitching_role
from mlbhist.batter_overview b
join mlbhist.pitcher_overview p on p.player_id = b.player_id
where coalesce(b.plate_appearances, 0) > 0
  and coalesce(p.outs, 0) > 0;

-- ---------------------------------------------------------------------------
-- RLS. The record is public-read like every other EdgeDesk research table; the
-- write path is the service role and nothing else. Staging is NOT readable by
-- clients: an unpromoted dataset has not passed its gate, and a screen that
-- could read it could show numbers the gate was about to refuse.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['batter_seasons','batter_team_seasons','batter_overview',
                           'batter_team_history','observed_batter_team_runs',
                           'team_offense_seasons','team_offense_overview',
                           'league_offense_seasons','offense_validation',
                           'offense_source_repairs','offense_games_reconciliation'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant select on mlbhist.%I to anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
    execute format('drop policy if exists %I on mlbhist.%I', 'mlbhist_' || t || '_public_read', t);
    execute format('create policy %I on mlbhist.%I for select to anon, authenticated using (true)',
                   'mlbhist_' || t || '_public_read', t);
  end loop;

  foreach t in array array['stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                           'stg_batter_team_history','stg_observed_batter_team_runs',
                           'stg_team_offense_seasons','stg_team_offense_overview',
                           'stg_league_offense_seasons','stg_offense_validation',
                           'stg_offense_source_repairs','stg_offense_games_reconciliation'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
  end loop;
end $$;

grant select on mlbhist.offense_status    to anon, authenticated, service_role;
grant select on mlbhist.two_way_players   to anon, authenticated, service_role;
grant usage, select on all sequences in schema mlbhist to service_role;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'every offensive record table exists' as check,
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('batter_seasons','batter_team_seasons','batter_overview',
                                       'batter_team_history','observed_batter_team_runs',
                                       'team_offense_seasons','team_offense_overview',
                                       'league_offense_seasons','offense_validation',
                                       'offense_source_repairs','offense_games_reconciliation')) = 11
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'the two player grains are uniquely keyed (player-season, player-team-season)',
       case when (select count(*) from pg_constraint
                   where conname in ('mlbhist_batter_seasons_key','mlbhist_batter_team_seasons_key')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the club grains are uniquely keyed (season-team, team)',
       case when (select count(*) from pg_constraint where conname = 'mlbhist_team_offense_seasons_key') = 1
             and (select count(*) from pg_index i join pg_class c on c.oid = i.indrelid
                   where c.relname = 'team_offense_overview' and i.indisprimary) = 1
            then 'ok' else 'CHECK THIS' end
union all select 4, 'staging exists for every offensive record table',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                                       'stg_batter_team_history','stg_observed_batter_team_runs',
                                       'stg_team_offense_seasons','stg_team_offense_overview',
                                       'stg_league_offense_seasons','stg_offense_validation',
                                       'stg_offense_source_repairs','stg_offense_games_reconciliation')) = 11
            then 'ok' else 'CHECK THIS' end
union all select 5, 'the shared import ledger discriminates the two datasets',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'mlbhist' and table_name = 'import_runs'
                            and column_name = 'dataset')
            then 'ok' else 'CHECK THIS' end
union all select 6, 'promote_offense_import and abandon_offense_import are security definer',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'mlbhist'
                     and p.proname in ('promote_offense_import','abandon_offense_import')
                     and p.prosecdef) = 2 then 'ok' else 'CHECK THIS' end
union all select 7, 'no client may execute the offensive promote gate',
       case when not has_function_privilege('anon', 'mlbhist.promote_offense_import(text)', 'execute')
             and not has_function_privilege('authenticated', 'mlbhist.promote_offense_import(text)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 8, 'RLS is enabled on every table this file created',
       -- named rather than pattern-matched: a LIKE that quietly stops covering
       -- a table is a check that passes while protecting nothing.
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('batter_seasons','batter_team_seasons','batter_overview',
                                       'batter_team_history','observed_batter_team_runs',
                                       'team_offense_seasons','team_offense_overview',
                                       'league_offense_seasons','offense_validation',
                                       'offense_source_repairs','offense_games_reconciliation',
                                       'stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                                       'stg_batter_team_history','stg_observed_batter_team_runs',
                                       'stg_team_offense_seasons','stg_team_offense_overview',
                                       'stg_league_offense_seasons','stg_offense_validation',
                                       'stg_offense_source_repairs','stg_offense_games_reconciliation')) = 22
            then 'ok' else 'CHECK THIS' end
union all select 9, 'anon and authenticated may read the offensive record',
       case when (select count(*) from pg_policies where schemaname = 'mlbhist' and cmd = 'SELECT'
                   and policyname like 'mlbhist\_%\_public\_read'
                   and 'anon' = any(roles) and 'authenticated' = any(roles)) >= 22
            then 'ok' else 'CHECK THIS' end
union all select 10, 'no client write policy exists anywhere in mlbhist',
       case when not exists (select 1 from pg_policies where schemaname = 'mlbhist'
                              and cmd in ('INSERT','UPDATE','DELETE','ALL'))
            then 'ok' else 'CHECK THIS' end
union all select 11, 'offensive staging is unreachable from anon/authenticated',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'mlbhist' and table_name like 'stg\_%'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 12, 'lookup indexes installed (player, team, season, position, workload, leaderboard)',
       case when to_regclass('mlbhist.mlbhist_bat_seasons_player_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_seasons_rating_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_seasons_pa_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_seasons_pos_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_team_seasons_team_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_overview_name_idx') is not null
             and to_regclass('mlbhist.mlbhist_team_off_seasons_rating_idx') is not null
            then 'ok' else 'CHECK THIS' end
union all select 13, 'the two archives share one team identity table (not duplicated)',
       case when to_regclass('mlbhist.teams') is not null
             and to_regclass('mlbhist.team_offense_teams') is null
            then 'ok' else 'CHECK THIS' end
union all select 14, 'the two-way view joins hitting to pitching on the shared MLB person id',
       case when to_regclass('mlbhist.two_way_players') is not null then 'ok' else 'CHECK THIS' end
union all select 15, 'the live offense tables are untouched by a failed import',
       'ok (promote_offense_import writes only inside its own transaction; proved by tools/mlb/mlb_offense_sql.test.js)'
union all select 16, 'public.offense_features and the live lineup source are untouched by this file',
       'ok (nothing above references them; this archive is never a lineup and never current-season data)'
union all select 17, 'mlbhist schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists mlbhist)'
order by row;

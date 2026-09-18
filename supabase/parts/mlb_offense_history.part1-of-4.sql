-- mlb_offense_history -- part 1 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

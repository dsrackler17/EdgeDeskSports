-- mlb_pitcher_history -- part 2 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- Consecutive appearance seasons with one club. THIS IS NOT A CONTRACT STINT:
-- a gap year may be injury, the minors, another club or inactivity, and the
-- run numbers exist precisely so a gap stays visible instead of being smoothed
-- into one span.
create table if not exists mlbhist.observed_team_runs (
  player_id                int not null,
  team_id                  int not null,
  observed_run_number      int not null,
  player_name              text not null,
  name_key                 text not null,
  team_names_observed      text,
  games int, starts int, outs int,
  wins int, losses int, saves int, save_opportunities int, holds int, blown_saves int,
  hits int, runs int, earned_runs int, home_runs int, strikeouts int, walks int,
  intentional_walks int, hit_batters int, batters_faced int, pitches int,
  complete_games int, shutouts int, inherited_runners int, inherited_runners_scored int,
  wild_pitches int, balks int,
  innings_display          text,
  innings_decimal          double precision,
  era                      double precision,
  whip                     double precision,
  k_per_9                  double precision,
  bb_per_9                 double precision,
  hr_per_9                 double precision,
  k_pct                    double precision,
  bb_pct                   double precision,
  k_minus_bb_pct           double precision,
  role                     text,
  sample_flag              text,
  first_observed_season    int,
  last_observed_season     int,
  seasons_with_appearances int,
  observed_seasons         text,
  boundary_start           boolean,
  boundary_end             boolean,
  weighted_performance_index double precision,
  rating_version           text,
  import_id                text,
  imported_at              timestamptz not null default now(),
  constraint mlbhist_observed_team_runs_key primary key (player_id, team_id, observed_run_number)
);

create table if not exists mlbhist.league_seasons (
  season                   int primary key,
  games int, starts int, outs int,
  wins int, losses int, saves int, save_opportunities int, holds int, blown_saves int,
  hits int, runs int, earned_runs int, home_runs int, strikeouts int, walks int,
  intentional_walks int, hit_batters int, batters_faced int, pitches int,
  complete_games int, shutouts int, inherited_runners int, inherited_runners_scored int,
  wild_pitches int, balks int,
  league_era               double precision,
  fip_constant             double precision,
  rating_version           text,
  provisional              boolean not null default false,
  import_id                text,
  imported_at              timestamptz not null default now()
);

-- Season-specific club identity. A franchise keeps its team_id through a name
-- change, so (season, team_id) is the key and the name is a per-season fact.
create table if not exists mlbhist.teams (
  season       int not null,
  team_id      int not null,
  team_name    text,
  abbreviation text,
  league       text,
  division     text,
  import_id    text,
  imported_at  timestamptz not null default now(),
  constraint mlbhist_teams_key primary key (season, team_id)
);

create table if not exists mlbhist.validation (
  season                 int primary key,
  teams                  int,
  pitchers               int,
  pitcher_team_rows      int,
  player_totals_reconcile boolean,
  import_id              text,
  imported_at            timestamptz not null default now()
);

-- The player-seasons whose team splits were REPLACED with MLB's individual
-- year-by-year history because the per-team query omitted an earlier club.
-- Kept so a traded pitcher's record can be shown to have been repaired rather
-- than silently corrected.
create table if not exists mlbhist.source_repairs (
  season                 int not null,
  player_id              int not null,
  previous_team_rows     int,
  replacement_team_rows  int,
  source_url             text,
  import_id              text,
  imported_at            timestamptz not null default now(),
  constraint mlbhist_source_repairs_key primary key (season, player_id)
);

-- ---------------------------------------------------------------------------
-- Indexes. Player, team, season and the comparison/leaderboard reads named in
-- the query layer (lib/mlb_pitcher_history.js). Everything the UI and the AI
-- ask for lands on one of these.
-- ---------------------------------------------------------------------------
create index if not exists mlbhist_seasons_player_idx        on mlbhist.pitcher_seasons (player_id, season);
create index if not exists mlbhist_seasons_season_idx        on mlbhist.pitcher_seasons (season);
create index if not exists mlbhist_seasons_name_idx          on mlbhist.pitcher_seasons (name_key);
create index if not exists mlbhist_seasons_board_idx         on mlbhist.pitcher_seasons (season, role, outs desc);
create index if not exists mlbhist_seasons_rating_idx        on mlbhist.pitcher_seasons (season, performance_index desc nulls last);
create index if not exists mlbhist_team_seasons_player_idx   on mlbhist.pitcher_team_seasons (player_id, season);
create index if not exists mlbhist_team_seasons_team_idx     on mlbhist.pitcher_team_seasons (team_id, season, outs desc);
create index if not exists mlbhist_team_seasons_season_idx   on mlbhist.pitcher_team_seasons (season, team_id);
create index if not exists mlbhist_team_seasons_name_idx     on mlbhist.pitcher_team_seasons (name_key);
create index if not exists mlbhist_overview_name_idx         on mlbhist.pitcher_overview (name_key);
create index if not exists mlbhist_overview_last_idx         on mlbhist.pitcher_overview (last_observed_season desc, outs desc);
create index if not exists mlbhist_overview_workload_idx     on mlbhist.pitcher_overview (outs desc);
create index if not exists mlbhist_team_history_team_idx     on mlbhist.pitcher_team_history (team_id, outs desc);
create index if not exists mlbhist_team_history_player_idx   on mlbhist.pitcher_team_history (player_id);
create index if not exists mlbhist_runs_player_idx           on mlbhist.observed_team_runs (player_id, first_observed_season);
create index if not exists mlbhist_runs_team_idx             on mlbhist.observed_team_runs (team_id, first_observed_season);
create index if not exists mlbhist_teams_team_idx            on mlbhist.teams (team_id, season desc);

-- ===========================================================================
-- STAGING. A structural copy of every record table. The importer writes here
-- first; promote_import() is the only thing that moves rows across.
-- `create table ... (like ...)` copies columns, types, defaults and not-null
-- but deliberately NOT the primary keys — staging is a landing strip, and a
-- duplicate arriving there is a fact the promote gate should report rather
-- than a write that fails halfway through an import.
-- ===========================================================================
create table if not exists mlbhist.stg_pitcher_seasons      (like mlbhist.pitcher_seasons      including defaults);
create table if not exists mlbhist.stg_pitcher_team_seasons (like mlbhist.pitcher_team_seasons including defaults);
create table if not exists mlbhist.stg_pitcher_overview     (like mlbhist.pitcher_overview     including defaults);
create table if not exists mlbhist.stg_pitcher_team_history (like mlbhist.pitcher_team_history including defaults);
create table if not exists mlbhist.stg_observed_team_runs   (like mlbhist.observed_team_runs   including defaults);
create table if not exists mlbhist.stg_league_seasons       (like mlbhist.league_seasons       including defaults);
create table if not exists mlbhist.stg_teams                (like mlbhist.teams                including defaults);
create table if not exists mlbhist.stg_validation           (like mlbhist.validation           including defaults);
create table if not exists mlbhist.stg_source_repairs       (like mlbhist.source_repairs       including defaults);

create index if not exists mlbhist_stg_seasons_import_idx      on mlbhist.stg_pitcher_seasons (import_id);
create index if not exists mlbhist_stg_team_seasons_import_idx on mlbhist.stg_pitcher_team_seasons (import_id);
create index if not exists mlbhist_stg_overview_import_idx     on mlbhist.stg_pitcher_overview (import_id);
create index if not exists mlbhist_stg_team_history_import_idx on mlbhist.stg_pitcher_team_history (import_id);
create index if not exists mlbhist_stg_runs_import_idx         on mlbhist.stg_observed_team_runs (import_id);
create index if not exists mlbhist_stg_league_import_idx       on mlbhist.stg_league_seasons (import_id);
create index if not exists mlbhist_stg_teams_import_idx        on mlbhist.stg_teams (import_id);
create index if not exists mlbhist_stg_validation_import_idx   on mlbhist.stg_validation (import_id);
create index if not exists mlbhist_stg_repairs_import_idx      on mlbhist.stg_source_repairs (import_id);

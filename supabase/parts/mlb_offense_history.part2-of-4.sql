-- mlb_offense_history -- part 2 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

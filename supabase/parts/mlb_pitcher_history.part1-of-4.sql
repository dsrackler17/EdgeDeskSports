-- mlb_pitcher_history -- part 1 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- EdgeDesk MLB — the historical pitching record, 2016–2025.
--
-- WHY THIS FILE EXISTS. EdgeDesk holds tonight's MLB card, tonight's probable
-- starters, and a season-to-date pitching line (public.pitcher_season). What
-- it has never held is a pitcher's HISTORY: how he has changed across ten
-- seasons, which clubs he threw for and how he did with each, whether an ERA
-- was supported by the FIP underneath it, or where a rating sits against the
-- league in the year it was earned. Every one of those questions arrived at
-- the desk and left with "EdgeDesk does not carry that".
--
-- This is that record, as its own schema, fed from the packaged
-- MLB Stats API build (mlb/pitchers/dataset) by tools/mlb/import_pitcher_history.js
-- over PostgREST with the service role. No Edge Function is in the write
-- path. The browser and the AI read it through the same anon/RLS door every
-- other research table uses.
--
--   mlbhist.pitcher_seasons        one row per pitcher per season, teams
--                                  COMBINED. Unique on (player_id, season).
--   mlbhist.pitcher_team_seasons   one row per pitcher, season and club.
--                                  Unique on (player_id, season, team_id).
--                                  A traded pitcher has one row per club and
--                                  the season row above is their sum — the two
--                                  grains are NEVER added together.
--   mlbhist.pitcher_overview       one row per pitcher across the window.
--   mlbhist.pitcher_team_history   one row per pitcher and club across it.
--   mlbhist.observed_team_runs     consecutive appearance seasons with one
--                                  club. Gaps split runs. NOT contract stints.
--   mlbhist.league_seasons         the annual MLB baseline the ratings use.
--   mlbhist.teams                  season-specific club names, leagues,
--                                  divisions. A club renamed mid-window keeps
--                                  its team_id and gains a second row.
--   mlbhist.validation             the packaged per-season verification.
--   mlbhist.source_repairs         the player-seasons whose team splits came
--                                  from MLB's individual year-by-year feed
--                                  because the team query omitted a club.
--   mlbhist.import_runs            one row per import: coverage, counts,
--                                  rating version, source snapshot, validation
--                                  outcome, and whether it was promoted.
--   mlbhist.stg_*                  the staging copy every import writes FIRST.
--                                  Nothing reaches a live table until
--                                  mlbhist.promote_import() has checked it.
--   mlbhist.meta                   the freshness ledger the shell reads.
--   mlbhist.pipeline_runs          heartbeat and diagnostics per job.
--
-- WHAT THE RATING IS. performance_index is a CUSTOM DESCRIPTIVE index,
-- version ED_PITCH_PERF_V1: 100 is league average, higher is better, and it
-- is shrunk toward 100 by IP/(IP+40). It is not a percentile, not a 0–100
-- grade, not WAR, not ERA+, not a win probability and not a validated
-- forecast. rating_version and rating_sample_weight travel on every rated row
-- so no screen can show the number without the terms it was computed under.
--
-- NULL MEANS UNDEFINED. A pitcher who recorded zero outs keeps his counting
-- statistics and has no ERA, FIP, WHIP or rating. Nothing here substitutes a
-- zero for an undefined rate.
--
-- THIS ARCHIVE ENDS IN 2025 AND IS NEVER CURRENT-SEASON DATA. Every table
-- carries coverage_start/coverage_end through import_runs, and a season
-- imported before its regular season finished is flagged `provisional`.
-- public.pitcher_season remains the season-to-date source and is untouched.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Run it in the SQL editor. Every report row should say ok.
--
-- Tested against a real PostgreSQL by tools/mlb/mlb_pitchers_sql.test.js
-- (`npm run mlb:sql`), which applies this file twice, attacks it as anon and
-- as authenticated, and proves a failed import cannot replace good data.
-- ===========================================================================

create schema if not exists mlbhist;
grant usage on schema mlbhist to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The freshness ledger. Granted to service_role explicitly: a schema's
-- pre-existing meta table has been found owned without that grant before, and
-- the tennis sync paid for it with "permission denied for table meta".
-- ---------------------------------------------------------------------------
create table if not exists mlbhist.meta (
  key   text primary key,
  value text
);
grant select, insert, update on mlbhist.meta to service_role;
grant select on mlbhist.meta to anon, authenticated;

create or replace function mlbhist.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ===========================================================================
-- THE IMPORT LEDGER — provenance, and the gate a dataset passes through.
--
-- An import is a two-step move: write everything into the staging tables, then
-- ask promote_import() to check it and swap it in. A run that dies halfway
-- leaves the live tables exactly as they were, which is the whole point.
-- ===========================================================================
create table if not exists mlbhist.import_runs (
  import_id            text primary key,
  status               text not null default 'staging'
                       check (status in ('staging','validated','promoted','failed','superseded')),
  -- WHICH ARCHIVE THIS RUN BELONGS TO. One ledger serves the pitching record
  -- and the offensive record (supabase/mlb_offense_history.sql) so an operator
  -- has one place to look when a refresh fails, but the two have independent
  -- gates: each supersedes only its own dataset, and each status view reads
  -- only its own rows. Defaulting to 'pitching' keeps rows written before this
  -- column existed correct.
  dataset              text not null default 'pitching',
  -- what this dataset covers
  coverage_start       int,
  coverage_end         int,
  provisional_seasons  int[]  not null default '{}',
  -- where it came from
  rating_version       text,
  dataset_built_at     timestamptz,
  source               text,
  source_manifest_sha  text,
  -- what the package said it contained, and what actually landed
  expected_counts      jsonb  not null default '{}'::jsonb,
  staged_counts        jsonb  not null default '{}'::jsonb,
  promoted_counts      jsonb  not null default '{}'::jsonb,
  validation           jsonb  not null default '{}'::jsonb,
  source_repairs       int    not null default 0,
  transformations      jsonb  not null default '[]'::jsonb,
  -- operations
  started_at           timestamptz not null default now(),
  promoted_at          timestamptz,
  finished_at          timestamptz,
  message              text,
  github_run_url       text,
  updated_at           timestamptz not null default now()
);
drop trigger if exists mlbhist_import_runs_touch on mlbhist.import_runs;
create trigger mlbhist_import_runs_touch before update on mlbhist.import_runs
  for each row execute function mlbhist.touch_updated_at();

alter table mlbhist.import_runs
  add column if not exists dataset text not null default 'pitching';

create index if not exists mlbhist_import_runs_status_idx
  on mlbhist.import_runs (status, started_at desc);
create index if not exists mlbhist_import_runs_dataset_idx
  on mlbhist.import_runs (dataset, status, started_at desc);

-- The run ledger every EdgeDesk job writes, in the shape tools/lib/pgrest.js
-- runLedger() already speaks.
create table if not exists mlbhist.pipeline_runs (
  run_id         text primary key,
  job            text not null,
  scope          text,
  status         text not null default 'running',
  details        jsonb not null default '{}'::jsonb,
  message        text,
  github_run_id  text,
  github_run_url text,
  workflow       text,
  started_at     timestamptz not null default now(),
  heartbeat_at   timestamptz,
  finished_at    timestamptz
);
create index if not exists mlbhist_pipeline_runs_job_idx
  on mlbhist.pipeline_runs (job, started_at desc);

-- ===========================================================================
-- THE RECORD.
--
-- Columns follow the packaged data dictionary exactly, so a value on screen
-- can be traced to a documented field rather than to a transformation nobody
-- wrote down. `outs` is the canonical workload measure — innings_display is
-- baseball notation (6.2 is six innings and two outs) and innings_decimal is
-- outs/3, so nothing ever adds 6.2 to 6.2 and gets 12.4.
-- ===========================================================================

create table if not exists mlbhist.pitcher_seasons (
  player_id                int  not null,
  season                   int  not null,
  player_name              text not null,
  name_key                 text not null,          -- accent-folded, for resolution
  age                      int,
  position_reported        text,
  team_count               int,
  team_ids                 int[],
  teams                    text,
  games                    int, starts int, outs int,
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
  league_era               double precision,
  fip_constant             double precision,
  fip                      double precision,
  performance_index        double precision,
  rating_version           text,
  rating_sample_weight     double precision,
  provisional              boolean not null default false,
  import_id                text,
  imported_at              timestamptz not null default now(),
  constraint mlbhist_pitcher_seasons_key primary key (player_id, season)
);

create table if not exists mlbhist.pitcher_team_seasons (
  player_id                int  not null,
  season                   int  not null,
  team_id                  int  not null,
  player_name              text not null,
  name_key                 text not null,
  team_name                text,
  position_reported        text,
  age                      int,
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
  league_era               double precision,
  fip_constant             double precision,
  fip                      double precision,
  performance_index        double precision,
  rating_version           text,
  rating_sample_weight     double precision,
  source_url               text,
  provisional              boolean not null default false,
  import_id                text,
  imported_at              timestamptz not null default now(),
  constraint mlbhist_pitcher_team_seasons_key primary key (player_id, season, team_id)
);

create table if not exists mlbhist.pitcher_overview (
  player_id                int primary key,
  player_name              text not null,
  name_key                 text not null,
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
  weighted_performance_index        double precision,
  latest_observed_performance_index double precision,
  latest_observed_role     text,
  best_season_by_index     int,
  team_count               int,
  teams                    text,
  rating_version           text,
  import_id                text,
  imported_at              timestamptz not null default now()
);

create table if not exists mlbhist.pitcher_team_history (
  player_id                int not null,
  team_id                  int not null,
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
  constraint mlbhist_pitcher_team_history_key primary key (player_id, team_id)
);

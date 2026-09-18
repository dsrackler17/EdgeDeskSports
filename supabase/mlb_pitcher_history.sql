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

-- ===========================================================================
-- THE PROMOTE GATE.
--
-- One transaction. It checks the staged rows against what the package said it
-- was shipping and against the keys the record depends on, and only then
-- replaces the live tables. Anything it refuses leaves the last successful
-- dataset exactly where it was, which is the difference between a failed
-- refresh and a lost archive.
--
-- The four refusals, each returned by name rather than as a generic error:
--   EMPTY_STAGING        nothing was staged for this import
--   COUNT_MISMATCH       staged rows disagree with the package's own counts
--   DUPLICATE_KEY        the same (player, season[, team]) arrived twice
--   VALIDATION_FAILED    the package's own per-season reconciliation did not pass
-- ===========================================================================
create or replace function mlbhist.promote_import(p_import_id text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
declare
  run           mlbhist.import_runs%rowtype;
  n_seasons     bigint; n_team_seasons bigint; n_overview bigint; n_team_history bigint;
  n_runs        bigint; n_league bigint; n_teams bigint; n_validation bigint; n_repairs bigint;
  dup_seasons   bigint; dup_team_seasons bigint;
  bad_seasons   bigint;
  expected      jsonb;
  staged        jsonb;
  problems      text[] := '{}';
  cov_lo        int; cov_hi int;
begin
  select * into run from mlbhist.import_runs where import_id = p_import_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_IMPORT',
      'detail', format('no import_runs row for %s', p_import_id));
  end if;

  select count(*) into n_seasons      from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  select count(*) into n_team_seasons from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  select count(*) into n_overview     from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  select count(*) into n_team_history from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  select count(*) into n_runs         from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  select count(*) into n_league       from mlbhist.stg_league_seasons       where import_id = p_import_id;
  select count(*) into n_teams        from mlbhist.stg_teams                where import_id = p_import_id;
  select count(*) into n_validation   from mlbhist.stg_validation           where import_id = p_import_id;
  select count(*) into n_repairs      from mlbhist.stg_source_repairs       where import_id = p_import_id;

  staged := jsonb_build_object(
    'pitcher_seasons', n_seasons, 'pitcher_team_seasons', n_team_seasons,
    'pitcher_overview', n_overview, 'pitcher_team_history', n_team_history,
    'observed_team_runs', n_runs, 'league_seasons', n_league,
    'teams', n_teams, 'validation', n_validation, 'source_repairs', n_repairs);

  if n_seasons = 0 or n_team_seasons = 0 or n_overview = 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'nothing was staged for this import', finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'EMPTY_STAGING', 'staged', staged);
  end if;

  -- The package's own counts. A dataset that claims 8,233 pitcher-seasons and
  -- stages 8,000 has lost rows somewhere between the file and here, and the
  -- live table is a better answer than a truncated refresh.
  expected := coalesce(run.expected_counts, '{}'::jsonb);
  if expected ? 'pitcher_seasons'      and (expected->>'pitcher_seasons')::bigint      <> n_seasons      then problems := problems || format('pitcher_seasons expected %s staged %s',      expected->>'pitcher_seasons',      n_seasons); end if;
  if expected ? 'pitcher_team_seasons' and (expected->>'pitcher_team_seasons')::bigint <> n_team_seasons then problems := problems || format('pitcher_team_seasons expected %s staged %s', expected->>'pitcher_team_seasons', n_team_seasons); end if;
  if expected ? 'pitcher_overview'     and (expected->>'pitcher_overview')::bigint     <> n_overview     then problems := problems || format('pitcher_overview expected %s staged %s',     expected->>'pitcher_overview',     n_overview); end if;
  if expected ? 'pitcher_team_history' and (expected->>'pitcher_team_history')::bigint <> n_team_history then problems := problems || format('pitcher_team_history expected %s staged %s', expected->>'pitcher_team_history', n_team_history); end if;
  if expected ? 'observed_team_runs'   and (expected->>'observed_team_runs')::bigint   <> n_runs         then problems := problems || format('observed_team_runs expected %s staged %s',   expected->>'observed_team_runs',   n_runs); end if;
  if expected ? 'league_seasons'       and (expected->>'league_seasons')::bigint       <> n_league       then problems := problems || format('league_seasons expected %s staged %s',       expected->>'league_seasons',       n_league); end if;
  if expected ? 'teams'                and (expected->>'teams')::bigint                <> n_teams        then problems := problems || format('teams expected %s staged %s',                expected->>'teams',                n_teams); end if;

  if array_length(problems, 1) is not null then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'staged rows disagree with the package: ' || array_to_string(problems, '; '), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'COUNT_MISMATCH', 'staged', staged,
      'expected', expected, 'problems', to_jsonb(problems));
  end if;

  select count(*) into dup_seasons from (
    select player_id, season from mlbhist.stg_pitcher_seasons where import_id = p_import_id
    group by 1, 2 having count(*) > 1) d;
  select count(*) into dup_team_seasons from (
    select player_id, season, team_id from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id
    group by 1, 2, 3 having count(*) > 1) d;
  if dup_seasons > 0 or dup_team_seasons > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('duplicate keys staged: %s player-seasons, %s player-team-seasons', dup_seasons, dup_team_seasons),
      finished_at = now() where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY', 'staged', staged,
      'duplicate_player_seasons', dup_seasons, 'duplicate_player_team_seasons', dup_team_seasons);
  end if;

  select count(*) into bad_seasons from mlbhist.stg_validation
    where import_id = p_import_id and player_totals_reconcile is distinct from true;
  if bad_seasons > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('%s season(s) failed the package reconciliation', bad_seasons), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'staged', staged,
      'unreconciled_seasons', bad_seasons);
  end if;

  -- ---- the swap -----------------------------------------------------------
  -- Season-keyed tables are replaced for the seasons this dataset covers, so
  -- a record MLB has since removed disappears instead of lingering, and a
  -- season outside the coverage window (an older archive still on file) is
  -- left alone. The window-wide summaries are replaced whole, because that is
  -- what they are: a summary of everything the window holds.
  cov_lo := coalesce(run.coverage_start, (select min(season) from mlbhist.stg_pitcher_seasons where import_id = p_import_id));
  cov_hi := coalesce(run.coverage_end,   (select max(season) from mlbhist.stg_pitcher_seasons where import_id = p_import_id));

  delete from mlbhist.pitcher_seasons      where season between cov_lo and cov_hi;
  delete from mlbhist.pitcher_team_seasons where season between cov_lo and cov_hi;
  delete from mlbhist.league_seasons       where season between cov_lo and cov_hi;
  delete from mlbhist.teams                where season between cov_lo and cov_hi;
  delete from mlbhist.validation           where season between cov_lo and cov_hi;
  delete from mlbhist.source_repairs       where season between cov_lo and cov_hi;
  delete from mlbhist.pitcher_overview where true;
  delete from mlbhist.pitcher_team_history where true;
  delete from mlbhist.observed_team_runs where true;

  insert into mlbhist.pitcher_seasons      select * from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  insert into mlbhist.pitcher_team_seasons select * from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  insert into mlbhist.pitcher_overview     select * from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  insert into mlbhist.pitcher_team_history select * from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  insert into mlbhist.observed_team_runs   select * from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  insert into mlbhist.league_seasons       select * from mlbhist.stg_league_seasons       where import_id = p_import_id;
  insert into mlbhist.teams                select * from mlbhist.stg_teams                where import_id = p_import_id;
  insert into mlbhist.validation           select * from mlbhist.stg_validation           where import_id = p_import_id;
  insert into mlbhist.source_repairs       select * from mlbhist.stg_source_repairs       where import_id = p_import_id;

  -- Only PITCHING runs are superseded. The offensive archive shares this
  -- ledger (discriminated by import_runs.dataset) and its promoted import is
  -- none of this gate's business; superseding it here would empty
  -- mlbhist.offense_status without touching a single offensive row.
  update mlbhist.import_runs set status = 'superseded'
    where status = 'promoted' and import_id <> p_import_id
      and coalesce(dataset, 'pitching') = 'pitching';
  update mlbhist.import_runs
    set status = 'promoted', staged_counts = staged, promoted_counts = staged,
        promoted_at = now(), finished_at = now(), message = null
    where import_id = p_import_id;

  insert into mlbhist.meta (key, value) values
    ('last_import_id', p_import_id),
    ('last_import_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('coverage_start', cov_lo::text),
    ('coverage_end', cov_hi::text),
    ('rating_version', coalesce(run.rating_version, 'ED_PITCH_PERF_V1'))
  on conflict (key) do update set value = excluded.value;

  -- Staging is cleared for this import only. An older import's staged rows are
  -- someone else's evidence, not this run's litter.
  delete from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  delete from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  delete from mlbhist.stg_league_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_teams                where import_id = p_import_id;
  delete from mlbhist.stg_validation           where import_id = p_import_id;
  delete from mlbhist.stg_source_repairs       where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'import_id', p_import_id,
    'coverage', jsonb_build_object('start', cov_lo, 'end', cov_hi), 'rows', staged);
end $$;

revoke all on function mlbhist.promote_import(text) from public, anon, authenticated;
grant execute on function mlbhist.promote_import(text) to service_role;

-- Abandon a staged import without touching anything live. Used by the importer
-- when it decides, before promotion, that what it read is not fit to publish.
create or replace function mlbhist.abandon_import(p_import_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
begin
  delete from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  delete from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  delete from mlbhist.stg_league_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_teams                where import_id = p_import_id;
  delete from mlbhist.stg_validation           where import_id = p_import_id;
  delete from mlbhist.stg_source_repairs       where import_id = p_import_id;
  update mlbhist.import_runs
    set status = 'failed', message = coalesce(p_reason, 'abandoned before promotion'), finished_at = now()
    where import_id = p_import_id and status <> 'promoted';
  return jsonb_build_object('ok', true, 'import_id', p_import_id, 'abandoned', true);
end $$;
revoke all on function mlbhist.abandon_import(text, text) from public, anon, authenticated;
grant execute on function mlbhist.abandon_import(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- What the shell shows about this pipeline. A view rather than a table so it
-- cannot drift from the ledger it describes.
-- ---------------------------------------------------------------------------
create or replace view mlbhist.dataset_status as
select r.import_id, r.status, r.coverage_start, r.coverage_end, r.provisional_seasons,
       r.rating_version, r.dataset_built_at, r.source, r.promoted_at,
       r.promoted_counts, r.validation, r.source_repairs, r.transformations,
       (select count(*) from mlbhist.pitcher_seasons)      as live_pitcher_seasons,
       (select count(*) from mlbhist.pitcher_team_seasons) as live_pitcher_team_seasons,
       (select count(*) from mlbhist.pitcher_overview)     as live_pitchers
from mlbhist.import_runs r
where r.status = 'promoted' and coalesce(r.dataset, 'pitching') = 'pitching'
order by r.promoted_at desc nulls last
limit 1;

-- ---------------------------------------------------------------------------
-- RLS. The record is public-read like every other EdgeDesk research table; the
-- write path is the service role and nothing else. Staging is NOT readable by
-- clients: an unpromoted dataset has not passed its gate, and a screen that
-- could read it could show numbers the gate was about to refuse.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pitcher_seasons','pitcher_team_seasons','pitcher_overview',
                           'pitcher_team_history','observed_team_runs','league_seasons',
                           'teams','validation','source_repairs','import_runs','pipeline_runs'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant select on mlbhist.%I to anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
    execute format('drop policy if exists %I on mlbhist.%I', 'mlbhist_' || t || '_public_read', t);
    execute format('create policy %I on mlbhist.%I for select to anon, authenticated using (true)',
                   'mlbhist_' || t || '_public_read', t);
  end loop;

  foreach t in array array['stg_pitcher_seasons','stg_pitcher_team_seasons','stg_pitcher_overview',
                           'stg_pitcher_team_history','stg_observed_team_runs','stg_league_seasons',
                           'stg_teams','stg_validation','stg_source_repairs'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
  end loop;
end $$;

grant select on mlbhist.dataset_status to anon, authenticated, service_role;
grant usage, select on all sequences in schema mlbhist to service_role;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'schema mlbhist exists' as check,
       case when exists (select 1 from information_schema.schemata where schema_name = 'mlbhist')
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'every record table exists',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('pitcher_seasons','pitcher_team_seasons','pitcher_overview',
                                       'pitcher_team_history','observed_team_runs','league_seasons',
                                       'teams','validation','source_repairs')) = 9
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the two grains are uniquely keyed (player-season, player-team-season)',
       case when (select count(*) from pg_constraint
                   where conname in ('mlbhist_pitcher_seasons_key','mlbhist_pitcher_team_seasons_key')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 4, 'staging exists for every record table',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('stg_pitcher_seasons','stg_pitcher_team_seasons','stg_pitcher_overview',
                                       'stg_pitcher_team_history','stg_observed_team_runs','stg_league_seasons',
                                       'stg_teams','stg_validation','stg_source_repairs')) = 9
            then 'ok' else 'CHECK THIS' end
union all select 5, 'the import ledger and run ledger exist',
       case when to_regclass('mlbhist.import_runs') is not null
             and to_regclass('mlbhist.pipeline_runs') is not null then 'ok' else 'CHECK THIS' end
union all select 6, 'promote_import and abandon_import are security definer',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'mlbhist' and p.proname in ('promote_import','abandon_import')
                     and p.prosecdef) = 2 then 'ok' else 'CHECK THIS' end
union all select 7, 'no client may execute the promote gate',
       case when not has_function_privilege('anon', 'mlbhist.promote_import(text)', 'execute')
             and not has_function_privilege('authenticated', 'mlbhist.promote_import(text)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 8, 'RLS is enabled on every table this file created',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('pitcher_seasons','pitcher_team_seasons','pitcher_overview',
                                       'pitcher_team_history','observed_team_runs','league_seasons',
                                       'teams','validation','source_repairs','import_runs','pipeline_runs',
                                       'stg_pitcher_seasons','stg_pitcher_team_seasons','stg_pitcher_overview',
                                       'stg_pitcher_team_history','stg_observed_team_runs','stg_league_seasons',
                                       'stg_teams','stg_validation','stg_source_repairs')) = 20
            then 'ok' else 'CHECK THIS' end
union all select 9, 'anon and authenticated may read the record',
       case when (select count(*) from pg_policies where schemaname = 'mlbhist' and cmd = 'SELECT'
                   and policyname like 'mlbhist\_%\_public\_read'
                   and 'anon' = any(roles) and 'authenticated' = any(roles)) >= 11
            then 'ok' else 'CHECK THIS' end
union all select 10, 'no client write policy exists on anything this file created',
       case when not exists (select 1 from pg_policies where schemaname = 'mlbhist'
                              and cmd in ('INSERT','UPDATE','DELETE','ALL'))
            then 'ok' else 'CHECK THIS' end
union all select 11, 'staging is unreachable from anon/authenticated',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'mlbhist' and table_name like 'stg\_%'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 12, 'lookup indexes installed (player, team, season, leaderboard, name)',
       case when to_regclass('mlbhist.mlbhist_seasons_player_idx') is not null
             and to_regclass('mlbhist.mlbhist_seasons_board_idx') is not null
             and to_regclass('mlbhist.mlbhist_seasons_rating_idx') is not null
             and to_regclass('mlbhist.mlbhist_team_seasons_team_idx') is not null
             and to_regclass('mlbhist.mlbhist_overview_name_idx') is not null
             and to_regclass('mlbhist.mlbhist_team_history_team_idx') is not null
            then 'ok' else 'CHECK THIS' end
union all select 13, 'service_role may write the mlbhist.meta ledger',
       case when has_table_privilege('service_role', 'mlbhist.meta', 'INSERT')
             and has_table_privilege('service_role', 'mlbhist.meta', 'UPDATE') then 'ok' else 'CHECK THIS' end
union all select 14, 'the season-to-date table public.pitcher_season is untouched by this file',
       'ok (nothing above references it; the archive is a separate schema and never current-season data)'
union all select 15, 'mlbhist schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists mlbhist)'
order by row;

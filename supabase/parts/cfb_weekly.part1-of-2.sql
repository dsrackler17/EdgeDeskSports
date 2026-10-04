-- cfb_weekly -- part 1 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- =============================================================================
-- cfb_weekly — the Postgres half of the CFB weekly learning and rating refresh
-- engine (docs/cfb-weekly/DESIGN.md).
--
-- WHAT IT IS
--   The run table (cfb_pipeline_runs) and its stage log, and every state the
--   weekly engine keeps: game validation, game performance, team-week state,
--   QB-week state, unit-week state, QB events, upcoming-game feature
--   snapshots, pure projections, projection changes (with their attribution),
--   research items and source health. The repository
--   (football/cfb_weekly/<season>/*.jsonl) is the source of truth;
--   football/cfb_weekly/sync_supabase.js mirrors it here insert-only.
--   Each table has typed columns for what is queried and `payload jsonb`
--   holding the complete row exactly as the engine wrote it.
--   Also here: cfb_weekly_poke(mode), which dispatches the weekly workflow,
--   and its pg_cron schedule (the primary clock; GitHub's schedule is the
--   backup).
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only. BEFORE UPDATE / DELETE / TRUNCATE triggers on every table
--      raise restrict_violation (the service role included). A correction is
--      a new state_version that names what it supersedes.
--   2. Exactly once. One row per natural key and state_version (team x
--      season x week x feature_version for team state), by unique index.
--   3. Point in time. A feature snapshot's feature_ts precedes its kickoff; a
--      state row's as_of is recorded; a projection names the feature
--      snapshot it was made from.
--   4. Who reads what. authenticated may SELECT; anon nothing; writes only
--      from the service role (insert).
--
-- DEPENDENCIES: none for the tables. The schedule block needs pg_cron and
-- pg_net and the Vault secret edgedesk_gh_token (the same token as
-- supabase/cfb_lab_cron.sql and editorial_dispatch_sql.sql). Without them it
-- creates the poke, schedules nothing, and the report says so.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Tested against a real PostgreSQL by football/cfb_weekly/sql.test.js.
-- =============================================================================

create table if not exists public.cfb_pipeline_runs (
  run_id                      text primary key,
  run_key                     text not null,
  season                      int not null,
  source_week                 int,
  target_week                 int,
  mode                        text not null,
  started_at                  timestamptz not null,
  completed_at                timestamptz,
  model_version               text not null,
  feature_version             text not null,
  data_version                text,
  status                      text not null,
  published                   boolean not null default false,
  score_ingestion_status      text,
  pbp_status                  text,
  drive_status                text,
  player_status               text,
  opponent_adjustment_status  text,
  team_rating_status          text,
  projection_status           text,
  market_status               text,
  model_lab_status            text,
  games_expected              int,
  games_final                 int,
  games_processed             int,
  plays_expected              int,
  plays_processed             int,
  warnings_count              int not null default 0,
  errors_count                int not null default 0,
  payload                     jsonb not null,
  recorded_at                 timestamptz not null default now(),
  constraint cfb_pipeline_runs_id check (run_id ~ '^cfbw_[0-9a-f]{24}$'),
  constraint cfb_pipeline_runs_mode check (mode in ('weekly','daily','freeze','rebuild')),
  constraint cfb_pipeline_runs_status check (status in ('PUBLISHED','GATE_FAILED','FAILED','LOCKED','RUNNING'))
);
create index if not exists cfb_pipeline_runs_key on public.cfb_pipeline_runs (run_key);
comment on table public.cfb_pipeline_runs is
  'One row per weekly-engine run: versions, per-stage statuses, counts. Every weekly refresh is traceable to one run.';

create table if not exists public.cfb_pipeline_stage_log (
  run_id       text not null,
  stage        text not null,
  status       text not null,
  started_at   timestamptz,
  finished_at  timestamptz,
  ms           int,
  error_class  text,
  error        text,
  counts       jsonb,
  recorded_at  timestamptz not null default now(),
  primary key (run_id, stage),
  constraint cfb_pipeline_stage_status check (status in ('OK','WARN','FAILED','BLOCKED','SKIPPED')),
  constraint cfb_pipeline_stage_error check (error_class is null or error_class in
    ('TRANSIENT','DATA_QUALITY','AUTH','RATE_LIMIT','SCHEMA','DATABASE','UNKNOWN'))
);

create table if not exists public.cfb_game_validation (
  validation_id           text primary key,
  game_id                 text not null,
  season                  int,
  week                    int,
  status                  text not null,
  pbp_completeness_score  numeric,
  score_reconciles        boolean,
  rule_version            text not null,
  state_version           int not null default 1,
  supersedes              text,
  payload                 jsonb not null,
  recorded_at             timestamptz not null default now(),
  constraint cfb_game_validation_status check (status in
    ('FINAL_VALIDATED','FINAL_PARTIAL_DATA','POSTPONED','CANCELED','DATA_ERROR','SCHEDULED','IN_PROGRESS'))
);
create unique index if not exists cfb_game_validation_key on public.cfb_game_validation (game_id, rule_version, state_version);

create table if not exists public.cfb_game_performance (
  performance_id                 text primary key,
  game_id                        text not null,
  team_id                        text not null,
  season                         int,
  rule_version                   text not null,
  expected_performance_margin    numeric,
  scoreboard_overperformance     numeric,
  state_version                  int not null default 1,
  supersedes                     text,
  payload                        jsonb not null,
  recorded_at                    timestamptz not null default now()
);
create unique index if not exists cfb_game_performance_key on public.cfb_game_performance (game_id, team_id, rule_version, state_version);

create table if not exists public.cfb_team_week_state (
  state_id          text primary key,
  team_id           text not null,
  season            int not null,
  week              int not null,
  feature_version   text not null,
  model_version     text not null,
  data_version      text,
  pbp_version       text,
  roster_version    text,
  injury_version    text,
  as_of             timestamptz not null,
  overall_mean      numeric,
  overall_sd        numeric,
  offense_mean      numeric,
  offense_sd        numeric,
  defense_mean      numeric,
  defense_sd        numeric,
  st_mean           numeric,
  st_sd             numeric,
  state_version     int not null default 1,
  supersedes        text,
  reason            text,
  run_id            text,
  payload           jsonb not null,
  recorded_at       timestamptz not null default now(),
  constraint cfb_team_week_state_id check (state_id ~ '^cfbs_[0-9a-f]{24}$'),
  constraint cfb_team_week_state_version check (state_version >= 1 and (state_version = 1) = (supersedes is null))
);
create unique index if not exists cfb_team_week_state_key
  on public.cfb_team_week_state (team_id, season, week, feature_version, state_version);
comment on table public.cfb_team_week_state is
  'Exactly one canonical team state per team x season x week x feature_version; a provider correction is a new state_version.';

create table if not exists public.cfb_qb_week_state (
  qb_state_id        text primary key,
  player_id          text not null,
  team_id            text not null,
  season             int not null,
  week               int not null,
  feature_version    text not null,
  expected_starter   boolean,
  starter_probability numeric,
  posterior_value    numeric,
  posterior_sd       numeric,
  state_version      int not null default 1,
  supersedes         text,
  run_id             text,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_qb_week_state_prob check (starter_probability is null or (starter_probability >= 0 and starter_probability <= 1))
);
create unique index if not exists cfb_qb_week_state_key
  on public.cfb_qb_week_state (player_id, team_id, season, week, feature_version, state_version);

create table if not exists public.cfb_unit_week_state (
  unit_state_id   text primary key,
  team_id         text not null,
  season          int not null,
  week            int not null,
  unit            text not null,
  knowledge       text not null,
  rule_version    text not null,
  state_version   int not null default 1,
  supersedes      text,
  payload         jsonb not null,
  recorded_at     timestamptz not null default now(),
  constraint cfb_unit_week_state_unit check (unit in ('QB','OL','WR_TE','RB','DL','LB','DB','ST')),
  constraint cfb_unit_week_state_knowledge check (knowledge in ('KNOWN','UNKNOWN'))
);
create unique index if not exists cfb_unit_week_state_key
  on public.cfb_unit_week_state (team_id, season, week, unit, rule_version, state_version);

create table if not exists public.cfb_qb_events (
  event_id     text primary key,
  team_id      text not null,
  season       int not null,
  week         int,
  event_type   text not null,
  player_id    text,
  payload      jsonb not null,
  recorded_at  timestamptz not null default now(),
  constraint cfb_qb_events_type check (event_type in ('NEW_STARTER','RETURNING_STARTER','INJURED_STARTER','BENCHING',
    'TRANSFER_STARTER','MULTI_QB_ROTATION','AMBIGUOUS_STARTER','QB_STABILIZING'))
);

create table if not exists public.cfb_upcoming_game_features (
  feature_snapshot_id  text primary key,
  game_id              text not null,
  season               int not null,
  week                 int not null,
  kickoff_ts           timestamptz not null,
  prediction_ts        timestamptz not null,
  feature_ts           timestamptz not null,
  feature_version      text not null,
  model_version        text not null,
  data_version         text,
  input_hash           text not null,
  payload              jsonb not null,
  recorded_at          timestamptz not null default now(),
  constraint cfb_upcoming_features_pit check (feature_ts < kickoff_ts),
  constraint cfb_upcoming_features_id check (feature_snapshot_id ~ '^cfbf_[0-9a-f]{24}$')
);
create unique index if not exists cfb_upcoming_features_key
  on public.cfb_upcoming_game_features (game_id, prediction_ts, feature_version, input_hash);
comment on table public.cfb_upcoming_game_features is
  'Immutable model-input snapshot for an upcoming game, as of its freeze instant; a changed input is a new snapshot.';

create table if not exists public.cfb_weekly_projections (
  projection_id           text primary key,
  game_id                 text not null,
  season                  int not null,
  week                    int not null,
  kickoff_ts              timestamptz,
  prediction_ts           timestamptz not null,
  model_version           text not null,
  feature_version         text not null,
  feature_snapshot_id     text not null,
  input_hash              text not null,
  ens_pred                numeric not null,
  sigma                   numeric not null,
  p_home_raw              numeric,
  p_home_calibrated       numeric,
  model_mode              text not null,
  previous_projection_id  text,
  run_id                  text,
  payload                 jsonb not null,
  recorded_at             timestamptz not null default now(),
  constraint cfb_weekly_projections_id check (projection_id ~ '^cfbj_[0-9a-f]{24}$'),
  constraint cfb_weekly_projections_mode check (model_mode in
    ('FULL','DEGRADED_PBP','DEGRADED_AVAILABILITY','DEGRADED_MARKET','FALLBACK')),
  constraint cfb_weekly_projections_prob check (p_home_raw is null or (p_home_raw > 0 and p_home_raw < 1)),
  constraint cfb_weekly_projections_sigma check (sigma > 0)
);
create unique index if not exists cfb_weekly_projections_key
  on public.cfb_weekly_projections (game_id, feature_version, input_hash, model_version);

create table if not exists public.cfb_projection_changes (
  change_id            text primary key,
  game_id              text not null,
  from_projection_id   text not null,
  to_projection_id     text not null,
  from_margin          numeric,
  to_margin            numeric,
  new_games_since      boolean,
  review_flag          jsonb,
  payload              jsonb not null,
  recorded_at          timestamptz not null default now()
);
comment on table public.cfb_projection_changes is
  'Why a pure projection moved (projection_change_reason in payload): exact ridge contributions + GBM TreeSHAP differences.';

create table if not exists public.cfb_weekly_research (
  item_id         text primary key,
  pattern         text not null,
  origin          text not null,
  season          int,
  n               int not null,
  mean_residual   numeric,
  status          text not null,
  payload         jsonb not null,
  recorded_at     timestamptz not null default now(),
  constraint cfb_weekly_research_origin check (origin in ('BACKTEST_DEV','LIVE')),
  constraint cfb_weekly_research_status check (status in ('RESEARCH','CLOSED','REJECTED'))
);

create table if not exists public.cfb_source_health (
  health_id    text primary key,
  season       int not null,
  as_of        timestamptz not null,
  source       text not null,
  status       text not null,
  payload      jsonb not null,
  recorded_at  timestamptz not null default now(),
  constraint cfb_source_health_status check (status in
    ('HEALTHY','STALE','DEGRADED','MISSING','NOT_CONFIGURED','NOT_USED_BY_MODEL'))
);

-- Misses: games the pure projection missed by 14+ points, decomposed with postgame data
-- (performance gap + scoreboard gap) and a data-based primary driver. Never a narrative.
create table if not exists public.cfb_weekly_misses (
  miss_id            text primary key,
  game_id            text not null,
  season             int,
  week               int,
  rule_version       text not null,
  projected_margin   numeric,
  actual_margin      numeric,
  error              numeric not null,
  performance_gap    numeric,
  scoreboard_gap     numeric,
  primary_driver     text not null,
  payload            jsonb not null,
  recorded_at        timestamptz not null default now(),
  constraint cfb_weekly_misses_driver check (primary_driver in ('TURNOVER_LUCK','SPECIAL_TEAMS','SCOREBOARD_OTHER',
    'QB_CHANGE','PERSONNEL','EXPLOSIVE_VARIANCE','TEAM_PERFORMANCE','UNEXPLAINED')),
  constraint cfb_weekly_misses_size check (abs(error) >= 14)
);

-- ===================================================== append-only + access
create or replace function public.cfb_weekly_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a correction is a new state_version)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name
      using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name
      using errcode = 'restrict_violation';
  end if;
end $fn$;

do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_pipeline_runs','cfb_pipeline_stage_log','cfb_game_validation','cfb_game_performance',
    'cfb_team_week_state','cfb_qb_week_state','cfb_unit_week_state','cfb_qb_events','cfb_upcoming_game_features',
    'cfb_weekly_projections','cfb_projection_changes','cfb_weekly_research','cfb_source_health','cfb_weekly_misses']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_weekly_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_weekly_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_weekly_append_only()', t || '_no_truncate_trg', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke update, delete, truncate on table public.%I from service_role', t);
      execute format('grant select, insert on table public.%I to service_role', t);
    end if;
  end loop;
end $blk$;

-- props_factory -- part 1 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- EdgeDesk Player Props — the CFB + NFL player-prop research warehouse.
-- docs/player-props/FACTORY.md  ·  football/props/factory/  ·  football/props/factory/dist.js
--
-- The spec (EdgeDesk_Player_Props_Historical_Data_Factory.xlsx) mapped onto
-- EdgeDesk's own conventions: its own schema (`props`, like tennis / mlbhist /
-- cbb), EdgeDesk's canonical ids (CFB game = the ESPN event id, NFL game = the
-- nflverse game_id, CFB player = 'espn:<athlete id>' as cfb_personnel.sql
-- enforces), and The Odds API — the provider EdgeDesk already captures from —
-- as the observed prop-quote source.
--
-- THE LAYERS, and the rule each one obeys:
--
--   0  catalog         props.prop_catalog, provider_market_map, feature_registry,
--                      quality_rules, backtest_splits, pipeline_jobs,
--                      source_registry — seeded from football/props/factory/config/*.json
--   1  operations      props.ingestion_runs (the resumable diary),
--                      props.quarantine (bad data kept, never repaired) — PRIVATE
--   2  staging         props.stg_player_game — COPY target for bulk history — PRIVATE
--   3  entities        props.dim_team, dim_player, player_id_map,
--                      player_id_merges, bridge_cfb_nfl_player, identity_review
--   4  history         props.dim_game, fact_player_game, fact_team_game,
--                      fact_corrections (a changed source value is logged)
--   5  market          props.fact_prop_quote — APPEND-ONLY for every role;
--                      lineage observed|reconstructed, and the two can never meet
--   6  point-in-time   props.fact_feature_snapshot — source_max_timestamp <=
--                      asof_at <= kickoff, append-only — PRIVATE
--   7  model           props.model_registry (immutable), model_status_events,
--                      props.model_prediction (immutable, pregame only)
--   8  settlement      props.fact_prop_result
--   9  validation      props.backtest_run, props.backtest_decision (observed
--                      quotes only)
--  10  record          props.prop_record — frozen before kickoff; the grade is
--                      written once beside it
--  11  serving         views v_* and props.dist_probs() — the same distribution
--                      arithmetic as football/props/factory/dist.js, so the database and
--                      the page price a line identically
--  12  AI context      props.ai_* — bounded security-definer functions
--
-- NOTHING EXISTING IS TOUCHED. public.signals, book_quotes, the capture edge
-- function and public.model_props (MLB/WNBA projections written by deployed
-- functions) are not altered by a single statement here; no football row is
-- ever written to model_props.
--
-- EXPOSE THE SCHEMA. PostgREST serves only the schemas in its db-schemas
-- setting: add `props` in Supabase > Project Settings > API > Exposed schemas,
-- or run supabase/expose_schemas.sql (which now lists it).
--
-- Idempotent, additive, no psql meta-commands, and it ends in a report whose
-- every row must read ok. Tested against a real PostgreSQL by
-- football/props/factory/sql.test.js (`npm run props:factory:sql`).
-- ===========================================================================

create extension if not exists pgcrypto;
create schema if not exists props;
grant usage on schema props to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The one append-only guard, used by every immutable table below. It raises
-- for UPDATE, DELETE and TRUNCATE for every role — the service role bypasses
-- row level security but not a trigger.
-- ---------------------------------------------------------------------------
create or replace function props.append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'props.%: rows are immutable (% refused)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

-- ===========================================================================
-- 0. CATALOG
-- ===========================================================================
create table if not exists props.source_registry (
  source text primary key,
  league text not null,
  data text not null,
  coverage text,
  access text,
  license_note text,
  url text,
  role text not null
);
create table if not exists props.prop_catalog (
  market_key text primary key,
  market_group text not null,
  positions text[] not null,
  target_column text not null,
  bet_type text not null check (bet_type in ('OU','YESNO')),
  priority text not null check (priority in ('P0','P1','P2','P3')),
  cfb boolean not null,
  nfl boolean not null,
  family text not null check (family in ('continuous','count','binary')),
  modeled boolean not null,
  settle_stats text[] not null default '{}',
  notes text
);
create table if not exists props.provider_market_map (
  provider text not null,
  provider_market_key text not null,
  market_key text not null references props.prop_catalog(market_key),
  is_alternate boolean not null default false,
  primary key (provider, provider_market_key)
);
create table if not exists props.feature_registry (
  feature_key text primary key,
  feature_group text not null,
  positions text[] not null,
  league text not null check (league in ('CFB','NFL','BOTH')),
  time_window text not null,
  definition text not null,
  source text not null,
  leakage_rule text not null,
  priority text not null
);
create table if not exists props.quality_rules (
  rule_id text primary key,
  scope text not null,
  check_type text not null,
  rule text not null,
  severity text not null check (severity in ('ERROR','WARN')),
  action text not null
);
create table if not exists props.backtest_splits (
  fold text primary key,
  family text not null,
  train_from int not null,
  train_to int not null,
  test_season int not null,
  method text not null,
  notes text,
  check (train_to < test_season or method <> 'Walk-forward')
);
create table if not exists props.pipeline_jobs (
  job text primary key,
  job_order int not null,
  league text not null,
  cadence text not null,
  layer text not null,
  input text,
  output text
);

-- ===========================================================================
-- 1. OPERATIONS — PRIVATE
-- ===========================================================================
create table if not exists props.ingestion_runs (
  run_id text primary key,
  job text not null,
  league text,
  season int,
  source text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','partial','failed','skipped')),
  rows_read bigint,
  rows_loaded bigint,
  rows_quarantined bigint,
  file_sha256 text,
  notes jsonb not null default '{}'::jsonb
);
create table if not exists props.quarantine (
  quarantine_id bigint generated always as identity primary key,
  detected_at timestamptz not null default now(),
  rule_id text not null references props.quality_rules(rule_id),
  scope text not null,
  natural_key text not null,
  reasons text[] not null,
  payload jsonb,
  run_id text references props.ingestion_runs(run_id),
  resolved_at timestamptz,
  resolution text
);
create unique index if not exists uq_props_quarantine_key on props.quarantine(rule_id, scope, natural_key) where resolved_at is null;

-- ===========================================================================
-- 3. ENTITIES
-- ===========================================================================
create table if not exists props.dim_team (
  league text not null check (league in ('CFB','NFL')),
  team_id text not null,
  abbr text,
  name text,
  conference text,
  division text,
  primary key (league, team_id)
);
create table if not exists props.dim_player (
  player_id text primary key check (player_id ~ '^(espn|gsis):[A-Za-z0-9-]+$'),
  full_name text not null,
  birth_date date,
  position text,
  college_last text,
  college_last_name text,
  nfl_gsis_id text,
  nfl_espn_id text,
  cfb_espn_id text,
  pfr_id text,
  identity_confidence numeric(5,4) not null default 1.0 check (identity_confidence between 0 and 1),
  identity_status text not null default 'cfb_only' check (identity_status in ('cfb_only','nfl_only','bridged')),
  first_seen_season int,
  last_seen_season int,
  cfb_first_season int,
  cfb_last_season int,
  nfl_first_season int,
  nfl_last_season int,
  draft_year int,
  draft_round int,
  draft_pick int,
  headshot text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_props_dim_player_gsis on props.dim_player(nfl_gsis_id) where nfl_gsis_id is not null;
create unique index if not exists uq_props_dim_player_cfb on props.dim_player(cfb_espn_id) where cfb_espn_id is not null;
create index if not exists ix_props_dim_player_name on props.dim_player(lower(full_name));

create table if not exists props.player_id_map (
  source text not null check (source in ('espn_cfb','nfl_gsis','nfl_espn','pfr','manual')),
  source_id text not null,
  player_id text not null references props.dim_player(player_id),
  method text not null,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  primary key (source, source_id)
);
create table if not exists props.player_id_merges (
  merge_id bigint generated always as identity primary key,
  from_player_id text not null,
  to_player_id text not null,
  gsis_id text,
  reason text not null,
  merged_at timestamptz not null default now(),
  check (from_player_id <> to_player_id)
);
drop trigger if exists props_merges_immutable on props.player_id_merges;
create trigger props_merges_immutable before update or delete on props.player_id_merges for each row execute function props.append_only();

-- The CFB → NFL bridge. The spec's composite key used coalesce() inside a
-- PRIMARY KEY, which PostgreSQL does not allow; the same uniqueness is a
-- unique index on the expressions, and the row id is deterministic.
create table if not exists props.bridge_cfb_nfl_player (
  bridge_id text primary key,
  player_id text not null references props.dim_player(player_id) on delete cascade,
  cfb_espn_id text,
  nfl_gsis_id text,
  college_team text,
  college_name text,
  draft_year int,
  draft_round int,
  draft_pick int,
  match_method text not null check (match_method in ('manual','exact_espn_id','name_college_draft','name_college_position_chronology','name_chronology_position')),
  match_confidence numeric(5,4) not null check (match_confidence between 0 and 1),
  manual_reviewed boolean not null default false,
  needs_review boolean not null default false,
  name_variant text,
  -- Q009: below .90 without a person's review, a link never reaches production
  production_eligible boolean generated always as (match_confidence >= 0.90 or manual_reviewed) stored,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_props_bridge on props.bridge_cfb_nfl_player(player_id, coalesce(cfb_espn_id, ''), coalesce(nfl_gsis_id, ''));
create table if not exists props.identity_review (
  review_id text primary key,
  gsis_id text,
  name text,
  college text,
  reason text not null,
  candidates text[] not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);

-- ===========================================================================
-- 4. HISTORY
-- ===========================================================================
create table if not exists props.dim_game (
  game_id text primary key,
  league text not null check (league in ('CFB','NFL')),
  source_game_id text not null,
  espn_event_id text,
  season int not null,
  week int,
  season_type text not null check (season_type in ('regular','postseason')),
  kickoff_utc timestamptz not null,             -- Q013: a timezone-aware instant, never local time
  home_team_id text not null,
  away_team_id text not null,
  venue_id text,
  venue_name text,
  surface text,
  roof text,
  neutral_site boolean not null default false,
  home_division text,
  away_division text,
  status text not null default 'scheduled' check (status in ('scheduled','final','cancelled')),
  home_score numeric,
  away_score numeric,
  weather_temp_f numeric,
  weather_wind_mph numeric,
  market_home_line numeric,
  market_total numeric,
  market_basis text check (market_basis is null or market_basis in ('close','current','model')),
  market_source text,
  source_provider text not null,                -- Q014
  unique (league, source_game_id),
  check ((league = 'NFL' and game_id ~ '^[0-9]{4}_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$') or (league = 'CFB' and game_id ~ '^[0-9]+$'))
);
create index if not exists ix_props_dim_game_league_season on props.dim_game(league, season, week);
create index if not exists ix_props_dim_game_kickoff on props.dim_game(kickoff_utc);

create table if not exists props.fact_player_game (
  game_id text not null references props.dim_game(game_id) on delete cascade,
  player_id text not null references props.dim_player(player_id) on delete cascade,
  team_id text not null,
  opponent_id text not null,
  player_name text,
  position text,
  position_group text,
  season int not null,
  week int,
  kickoff_utc timestamptz not null,
  is_home boolean,
  starter boolean,
  active_status text,
  injury_status text,
  snaps int,
  snap_share numeric,
  routes int,
  attempts int, completions int, passing_yards numeric, passing_tds int, interceptions int, sacks_taken int,
  passing_air_yards numeric, passing_epa numeric, passing_cpoe numeric, dropbacks int, scrambles int, designed_rushes int,
  carries int, rushing_yards numeric, rushing_tds int, rushing_epa numeric,
  targets int, receptions int, receiving_yards numeric, receiving_tds int, receiving_epa numeric,
  air_yards numeric, yac numeric, target_share numeric, air_yard_share numeric,
  red_zone_touches int, goal_line_touches int, rz_targets int, rz_carries int, gl_carries int,
  explosive_rec int, explosive_rush int,
  longest_completion numeric, longest_rush numeric, longest_reception numeric,
  fumbles_lost int, special_teams_tds int,
  fg_made int, fg_att int, pat_made int, kicking_points numeric,
  def_interceptions int, def_sacks numeric, def_tackles_assists int,
  source_quality numeric(5,4) not null default 1.0 check (source_quality between 0 and 1),
  source_provider text not null,                -- Q014
  source_detail text,
  source_updated_at timestamptz,
  qa_warnings text[],
  loaded_at timestamptz not null default now(),
  primary key (game_id, player_id),             -- Q001
  -- Q002: counting stats are never negative (yards, longest plays, EPA and CPOE are signed)
  check (coalesce(attempts,0) >= 0 and coalesce(completions,0) >= 0 and coalesce(passing_tds,0) >= 0 and coalesce(interceptions,0) >= 0
     and coalesce(carries,0) >= 0 and coalesce(rushing_tds,0) >= 0 and coalesce(targets,0) >= 0 and coalesce(receptions,0) >= 0
     and coalesce(receiving_tds,0) >= 0 and coalesce(snaps,0) >= 0 and coalesce(red_zone_touches,0) >= 0 and coalesce(goal_line_touches,0) >= 0),
  -- Q003
  check (completions is null or attempts is null or completions <= attempts),
  -- Q004
  check (receptions is null or targets is null or targets = 0 or receptions <= targets)
);
create index if not exists ix_props_fpg_player on props.fact_player_game(player_id, kickoff_utc);
create index if not exists ix_props_fpg_team on props.fact_player_game(team_id, game_id);
create index if not exists ix_props_fpg_season on props.fact_player_game(season, position_group);

create table if not exists props.fact_team_game (
  game_id text not null references props.dim_game(game_id) on delete cascade,
  team_id text not null,
  opponent_id text not null,
  season int not null,
  week int,
  kickoff_utc timestamptz not null,
  plays int, dropbacks int, pass_attempts int, completions int, rushes int, pass_yards numeric, rush_yards numeric,
  sacks int, qb_hits int, scrambles int, points numeric, seconds_per_play numeric, neutral_pass_rate numeric, proe numeric, epa_per_play numeric,
  pass_epa_sum numeric, rush_epa_sum numeric, air_yards numeric, explosive_pass int, explosive_rush int, rz_plays int, gl_plays int,
  tgt_rb int, tgt_wr int, tgt_te int, recyds_rb numeric, recyds_wr numeric, recyds_te numeric, rec_rb int, rec_wr int, rec_te int,
  total_yards numeric, turnovers numeric, first_downs numeric,
  source_provider text not null,
  primary key (game_id, team_id)
);

-- A changed source value is never silently overwritten: the promotion logs
-- the old and new row here first.
create table if not exists props.fact_corrections (
  correction_id bigint generated always as identity primary key,
  game_id text not null,
  player_id text not null,
  corrected_at timestamptz not null default now(),
  run_id text,
  old_row jsonb not null,
  new_row jsonb not null
);
drop trigger if exists props_corrections_immutable on props.fact_corrections;
create trigger props_corrections_immutable before update or delete on props.fact_corrections for each row execute function props.append_only();

-- 2. STAGING — the COPY target of football/props/factory/db.js. PRIVATE.
create table if not exists props.stg_player_game (like props.fact_player_game including defaults);
alter table props.stg_player_game add column if not exists run_id text;
alter table props.stg_player_game drop constraint if exists stg_player_game_pkey;

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

-- ===========================================================================
-- 5. MARKET — observed sportsbook prop quotes. APPEND-ONLY.
-- ===========================================================================
create table if not exists props.fact_prop_quote (
  quote_id text primary key,
  league text not null check (league in ('CFB','NFL')),
  game_id text not null references props.dim_game(game_id),
  player_id text not null references props.dim_player(player_id),
  team_id text,
  market_key text not null references props.prop_catalog(market_key),
  sportsbook text not null,
  provider text not null,                       -- Q014
  snapshot_at timestamptz not null,
  provider_updated_at timestamptz,
  minutes_to_kick int not null,
  side text not null check (side in ('over','under','yes','no')),
  line numeric,
  american_price int not null,
  decimal_price numeric not null check (decimal_price > 1),
  implied_prob numeric not null check (implied_prob > 0 and implied_prob < 1),
  no_vig_prob numeric check (no_vig_prob is null or (no_vig_prob > 0 and no_vig_prob < 1)),
  is_main_line boolean not null default false,
  is_alt_line boolean not null default false,
  lineage text not null,                        -- Q006: never defaulted
  source_market_key text,
  source_player_name text,
  player_match text,
  provider_event_id text,
  source_payload_hash text,
  fingerprint text,
  pair_hold_out_of_bounds boolean not null default false,
  created_at timestamptz not null default now(),
  constraint props_quote_lineage check (lineage in ('observed','reconstructed')),
  -- a reconstructed line can never claim a sportsbook: its provider and book name it for what it is
  constraint props_quote_lineage_provider check ((lineage = 'reconstructed') = (provider = 'edgedesk_reconstruction')),
  constraint props_quote_reconstructed_book check (lineage = 'observed' or sportsbook = 'reconstructed'),
  -- Q011: no American price inside -99..99
  constraint props_quote_american check (american_price <= -100 or american_price >= 100),
  constraint props_quote_line check ((side in ('over','under') and line is not null) or (side in ('yes','no'))),
  constraint props_quote_decimal check (abs(decimal_price - case when american_price > 0 then 1 + american_price / 100.0 else 1 + 100.0 / (-american_price) end) < 0.0001)
);
create unique index if not exists uq_props_quote_snapshot on props.fact_prop_quote(game_id, player_id, market_key, sportsbook, side, coalesce(line, -9999), is_alt_line, snapshot_at);
create index if not exists ix_props_quote_lookup on props.fact_prop_quote(game_id, player_id, market_key, sportsbook, snapshot_at desc);
create index if not exists ix_props_quote_snapshot on props.fact_prop_quote(snapshot_at);
create index if not exists ix_props_quote_market on props.fact_prop_quote(market_key, lineage);
drop trigger if exists props_quote_immutable on props.fact_prop_quote;
create trigger props_quote_immutable before update or delete on props.fact_prop_quote for each row execute function props.append_only();
drop trigger if exists props_quote_no_truncate on props.fact_prop_quote;
create trigger props_quote_no_truncate before truncate on props.fact_prop_quote for each statement execute function props.append_only();

-- minutes_to_kick must agree with the game's kickoff (the Q007 boundary is computed from it)
create or replace function props.quote_kickoff_check() returns trigger
language plpgsql as $$
declare k timestamptz;
begin
  select kickoff_utc into k from props.dim_game where game_id = new.game_id;
  if k is null then raise exception 'props.fact_prop_quote: unknown game %', new.game_id using errcode = 'foreign_key_violation'; end if;
  if abs(new.minutes_to_kick - round(extract(epoch from (k - new.snapshot_at)) / 60.0)) > 2 then
    raise exception 'props.fact_prop_quote: minutes_to_kick % disagrees with kickoff % and snapshot %', new.minutes_to_kick, k, new.snapshot_at using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists props_quote_kickoff on props.fact_prop_quote;
create trigger props_quote_kickoff before insert on props.fact_prop_quote for each row execute function props.quote_kickoff_check();

-- THE POLL LISTING. Quotes are stored change-only, so the latest row per key
-- would keep a line a book has since withdrawn. Each poll records the keys
-- (side|line|alt) each book offered for a player-market; the current market is
-- the book's latest listing, each listed key at its latest price. APPEND-ONLY.
create table if not exists props.fact_prop_listing (
  listing_id text primary key,
  league text not null check (league in ('CFB','NFL')),
  game_id text not null references props.dim_game(game_id),
  player_id text not null references props.dim_player(player_id),
  market_key text not null references props.prop_catalog(market_key),
  sportsbook text not null,
  snapshot_at timestamptz not null,
  keys text[] not null,
  created_at timestamptz not null default now()
);
create index if not exists ix_props_listing_lookup on props.fact_prop_listing(game_id, player_id, market_key, sportsbook, snapshot_at desc);
drop trigger if exists props_listing_immutable on props.fact_prop_listing;
create trigger props_listing_immutable before update or delete on props.fact_prop_listing for each row execute function props.append_only();

-- Raw provider payloads: outside every browser-facing table. PRIVATE.
create table if not exists props.raw_odds_payloads (
  payload_hash text primary key,
  provider text not null,
  league text,
  game_id text,
  provider_event_id text,
  fetched_at timestamptz not null default now(),
  payload jsonb not null
);

-- ===========================================================================
-- 6. POINT-IN-TIME FEATURES — PRIVATE, APPEND-ONLY
-- ===========================================================================
create table if not exists props.fact_feature_snapshot (
  game_id text not null references props.dim_game(game_id) on delete cascade,
  player_id text not null references props.dim_player(player_id) on delete cascade,
  asof_at timestamptz not null,
  feature_name text not null,
  feature_value numeric,
  feature_text text,
  source_max_timestamp timestamptz,
  is_imputed boolean not null default false,
  feature_version text not null default 'pf1',
  created_at timestamptz not null default now(),
  primary key (game_id, player_id, asof_at, feature_name, feature_version),
  -- Q008: the hard leakage gate
  constraint props_feature_pit check (source_max_timestamp is null or source_max_timestamp <= asof_at)
);
create index if not exists ix_props_feature_lookup on props.fact_feature_snapshot(game_id, player_id, asof_at desc);
create or replace function props.feature_pregame_check() returns trigger
language plpgsql as $$
declare k timestamptz;
begin
  select kickoff_utc into k from props.dim_game where game_id = new.game_id;
  if k is not null and new.asof_at > k then
    raise exception 'props.fact_feature_snapshot: asof_at % is after kickoff % (Q015: no post-kickoff feature)', new.asof_at, k using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists props_feature_pregame on props.fact_feature_snapshot;
create trigger props_feature_pregame before insert on props.fact_feature_snapshot for each row execute function props.feature_pregame_check();
drop trigger if exists props_feature_immutable on props.fact_feature_snapshot;
create trigger props_feature_immutable before update or delete on props.fact_feature_snapshot for each row execute function props.append_only();

-- ===========================================================================
-- 7. MODEL
-- ===========================================================================
create table if not exists props.model_registry (
  model_version text primary key,
  model_name text not null,
  league text not null check (league in ('CFB','NFL')),
  position_group text not null,
  market_key text not null references props.prop_catalog(market_key),
  family text not null check (family in ('continuous','count','binary')),
  algorithm text not null,
  feature_version text not null,
  training_from int not null,
  training_to int not null,
  training_cutoff timestamptz not null,
  trained_at timestamptz not null,
  n_rows int not null,
  sha256 text not null,
  outcome_tier text not null default 'RESEARCH' check (outcome_tier in ('OUTCOME_VALIDATED','OUTCOME_LEAN','RESEARCH')),
  use_recalibration boolean not null default true,
  walk_forward jsonb,
  artifact jsonb not null,
  registered_at timestamptz not null default now()
);
drop trigger if exists props_registry_immutable on props.model_registry;
create trigger props_registry_immutable before update or delete on props.model_registry for each row execute function props.append_only();
create table if not exists props.model_status_events (
  event_id bigint generated always as identity primary key,
  model_version text not null references props.model_registry(model_version),
  status text not null check (status in ('CANDIDATE','SHADOW','CHAMPION','RETIRED')),
  market_tier text not null default 'RESEARCH' check (market_tier in ('VALIDATED','LEAN','RESEARCH')),
  reason text not null,
  actor text not null,
  at timestamptz not null default now()
);
drop trigger if exists props_status_immutable on props.model_status_events;
create trigger props_status_immutable before update or delete on props.model_status_events for each row execute function props.append_only();
create or replace view props.v_model_status with (security_invoker = false) as
select distinct on (model_version) model_version, status, market_tier, reason, actor, at
from props.model_status_events order by model_version, event_id desc;

create table if not exists props.model_prediction (
  prediction_id text primary key,
  game_id text not null references props.dim_game(game_id),
  player_id text not null references props.dim_player(player_id),
  market_key text not null references props.prop_catalog(market_key),
  league text not null check (league in ('CFB','NFL')),
  asof_at timestamptz not null,
  scored_at timestamptz not null,
  model_version text not null references props.model_registry(model_version),
  feature_version text not null,
  training_cutoff timestamptz not null,
  projected_mean numeric,
  projected_median numeric,
  projected_p10 numeric,
  projected_p25 numeric,
  projected_p75 numeric,
  projected_p90 numeric,
  projected_sd numeric,
  over_probability numeric,                     -- at ref_line (the consensus line, else the model median's half point)
  under_probability numeric,
  ref_line numeric,
  fair_over_american int,
  fair_under_american int,
  uncertainty numeric,
  sigma_mu numeric,
  data_quality numeric,
  confidence numeric,
  confidence_components jsonb,
  feature_completeness numeric,
  imputed text[],
  source_max_timestamp timestamptz,
  dist jsonb not null,
  created_at timestamptz not null default now(),
  unique (game_id, player_id, market_key, asof_at, model_version),
  check (training_cutoff < asof_at),
  check (source_max_timestamp is null or source_max_timestamp <= asof_at),
  check (dist ? 't' and (dist->>'t') in ('pmf','cdf','bern'))
);
create index if not exists ix_props_prediction_lookup on props.model_prediction(game_id, player_id, market_key, scored_at desc);
create or replace function props.prediction_pregame_check() returns trigger
language plpgsql as $$
declare k timestamptz;
begin
  select kickoff_utc into k from props.dim_game where game_id = new.game_id;
  if k is null or new.asof_at >= k then
    raise exception 'props.model_prediction: a prediction must be made before kickoff (asof %, kickoff %)', new.asof_at, k using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists props_prediction_pregame on props.model_prediction;
create trigger props_prediction_pregame before insert on props.model_prediction for each row execute function props.prediction_pregame_check();
drop trigger if exists props_prediction_immutable on props.model_prediction;
create trigger props_prediction_immutable before update or delete on props.model_prediction for each row execute function props.append_only();
drop trigger if exists props_prediction_no_truncate on props.model_prediction;
create trigger props_prediction_no_truncate before truncate on props.model_prediction for each statement execute function props.append_only();

-- ===========================================================================
-- 8. SETTLEMENT
-- ===========================================================================
create table if not exists props.fact_prop_result (
  game_id text not null references props.dim_game(game_id) on delete cascade,
  player_id text not null references props.dim_player(player_id) on delete cascade,
  market_key text not null references props.prop_catalog(market_key),
  actual_value numeric,
  participated boolean not null default true,
  void_reason text,
  result_quality numeric(5,4) not null default 1.0 check (result_quality between 0 and 1),
  settled_at timestamptz not null default now(),
  primary key (game_id, player_id, market_key),
  check (participated or void_reason is not null)
);

-- ===========================================================================
-- 9. VALIDATION
-- ===========================================================================
create table if not exists props.backtest_run (
  run_id text primary key,
  kind text not null check (kind in ('outcome','market')),
  league text,
  fold text references props.backtest_splits(fold),
  model_version text,
  metrics jsonb not null,
  created_at timestamptz not null default now()
);
drop trigger if exists props_backtest_run_immutable on props.backtest_run;
create trigger props_backtest_run_immutable before update or delete on props.backtest_run for each row execute function props.append_only();
create table if not exists props.backtest_decision (
  decision_id uuid primary key default gen_random_uuid(),
  run_id text references props.backtest_run(run_id),
  game_id text not null,
  player_id text not null,
  market_key text not null,
  quote_id text not null references props.fact_prop_quote(quote_id),
  model_version text not null,
  decision_at timestamptz not null,
  model_probability numeric,
  market_no_vig_probability numeric,
  edge_probability numeric,
  expected_value_pct numeric,
  stake_units numeric,
  decision text not null check (decision in ('BET','LEAN','WATCH','PASS')),
  settled_result text check (settled_result is null or settled_result in ('WIN','LOSS','PUSH','VOID')),
  pnl_units numeric,
  clv_probability numeric,
  created_at timestamptz not null default now()
);
-- A backtest decision may only stand on an OBSERVED quote taken before kickoff (Q006, Q007).
create or replace function props.backtest_observed_only() returns trigger
language plpgsql as $$
declare lin text; snap timestamptz; k timestamptz;
begin
  select q.lineage, q.snapshot_at, g.kickoff_utc into lin, snap, k
    from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id where q.quote_id = new.quote_id;
  if lin is distinct from 'observed' then
    raise exception 'props.backtest_decision: quote % is %, not an observed sportsbook price', new.quote_id, coalesce(lin, 'missing') using errcode = 'check_violation';
  end if;
  if snap >= k or new.decision_at >= k then
    raise exception 'props.backtest_decision: a decision and its quote must precede kickoff' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists props_backtest_observed on props.backtest_decision;
create trigger props_backtest_observed before insert or update on props.backtest_decision for each row execute function props.backtest_observed_only();

-- ===========================================================================
-- 10. RECORD — frozen before kickoff; the grade is written once beside it
-- ===========================================================================
create table if not exists props.prop_record (
  entry_id text primary key,
  frozen_at timestamptz not null,
  league text not null check (league in ('CFB','NFL')),
  season int not null,
  game_id text not null references props.dim_game(game_id),
  kickoff_utc timestamptz not null,
  player_id text not null references props.dim_player(player_id),
  player text,
  position text,
  team text,
  is_home boolean,
  market_key text not null references props.prop_catalog(market_key),
  side text not null check (side in ('over','under','yes','no')),
  line numeric,
  sportsbook text not null,
  american int not null check (american <= -100 or american >= 100),
  quote_id text,
  lineage text not null check (lineage = 'observed'),
  model_prob numeric not null,
  market_prob numeric,
  edge numeric,
  fair_american int,
  ev numeric,
  conservative_ev numeric,
  confidence numeric,
  data_quality numeric,
  decision text not null check (decision in ('BET','LEAN')),
  stake_units numeric check (stake_units is null or (stake_units > 0 and stake_units <= 1)),
  model_version text not null,
  feature_version text not null,
  prediction_id text,
  -- the grade: null until settled, then written once
  result text check (result is null or result in ('WIN','LOSS','PUSH','VOID')),
  actual numeric,
  units numeric,
  units_flat numeric,
  clv_price numeric,
  clv_line numeric,
  close jsonb,
  graded_at timestamptz,
  check (frozen_at < kickoff_utc)
);
create index if not exists ix_props_record_league_season on props.prop_record(league, season);
create or replace function props.record_freeze() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'props.prop_record: entries are never deleted' using errcode = 'restrict_violation'; end if;
  -- everything EdgeDesk said before kickoff is frozen
  if (new.entry_id, new.frozen_at, new.league, new.season, new.game_id, new.kickoff_utc, new.player_id, new.market_key, new.side, new.line, new.sportsbook, new.american,
      new.lineage, new.model_prob, new.market_prob, new.edge, new.fair_american, new.ev, new.conservative_ev, new.confidence, new.data_quality, new.decision,
      new.stake_units, new.model_version, new.feature_version, new.prediction_id)
     is distinct from
     (old.entry_id, old.frozen_at, old.league, old.season, old.game_id, old.kickoff_utc, old.player_id, old.market_key, old.side, old.line, old.sportsbook, old.american,
      old.lineage, old.model_prob, old.market_prob, old.edge, old.fair_american, old.ev, old.conservative_ev, old.confidence, old.data_quality, old.decision,
      old.stake_units, old.model_version, old.feature_version, old.prediction_id) then
    raise exception 'props.prop_record: a frozen entry cannot be rewritten' using errcode = 'restrict_violation';
  end if;
  -- the grade is written once
  if old.result is not null and (new.result, new.actual, new.units, new.units_flat, new.clv_price, new.clv_line, new.graded_at)
       is distinct from (old.result, old.actual, old.units, old.units_flat, old.clv_price, old.clv_line, old.graded_at) then
    raise exception 'props.prop_record: a grade is written once' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists props_record_freeze on props.prop_record;
create trigger props_record_freeze before update or delete on props.prop_record for each row execute function props.record_freeze();

-- ===========================================================================
-- 11. SERVING — the distribution arithmetic, identical to football/props/factory/dist.js
-- ===========================================================================
-- P(Y <= x) for a stored distribution {t:'pmf'|'cdf'|'bern', …}
create or replace function props.dist_cdf(d jsonb, x numeric) returns numeric
language plpgsql immutable as $$
declare
  t text := d->>'t'; n int; k int; s numeric := 0; i int; xs numeric; xe numeric; ps numeric; pe numeric;
begin
  if d is null or x is null then return null; end if;
  if t = 'pmf' then
    if x < 0 then return 0; end if;
    n := jsonb_array_length(d->'v');
    k := floor(x + 0.000000001)::int;
    if k >= n then return 1; end if;
    for i in 0..k loop s := s + (d->'v'->>i)::numeric; end loop;
    return least(1, greatest(0, s));
  elsif t = 'cdf' then
    n := jsonb_array_length(d->'x');
    if x < (d->'x'->>0)::numeric then return 0; end if;
    if x >= (d->'x'->>(n - 1))::numeric then return 1; end if;
    for i in 0..n - 2 loop
      xs := (d->'x'->>i)::numeric; xe := (d->'x'->>(i + 1))::numeric;
      if x >= xs and x < xe then
        ps := (d->'p'->>i)::numeric; pe := (d->'p'->>(i + 1))::numeric;
        if xe = xs then return pe; end if;
        return ps + (pe - ps) * (x - xs) / (xe - xs);
      end if;
    end loop;
    return 1;
  elsif t = 'bern' then
    if x < 0 then return 0; elsif x < 1 then return 1 - (d->>'p')::numeric; else return 1; end if;
  end if;
  return null;
end $$;

-- {over, under, push} at a line: whole-number lines carry a push on integer stats
create or replace function props.dist_probs(d jsonb, line numeric, out p_over numeric, out p_under numeric, out p_push numeric)
language plpgsql immutable as $$
declare t text := d->>'t'; is_int boolean; k numeric; below numeric; atbelow numeric;
begin
  if d is null then return; end if;
  if t = 'bern' then p_over := (d->>'p')::numeric; p_under := 1 - p_over; p_push := 0; return; end if;
  if line is null then return; end if;
  is_int := t = 'pmf' or coalesce((d->>'int')::boolean, false);
  if is_int and line = round(line) then
    k := round(line);
    if t = 'pmf' then below := props.dist_cdf(d, k - 1); atbelow := props.dist_cdf(d, k);
    else below := props.dist_cdf(d, k - 0.5); atbelow := props.dist_cdf(d, k + 0.5); end if;
    p_under := below; p_push := greatest(0, atbelow - below);
  else
    if t = 'pmf' then p_under := props.dist_cdf(d, floor(line)); else p_under := props.dist_cdf(d, line); end if;
    p_push := 0;
  end if;
  p_over := greatest(0, 1 - p_under - p_push);
end $$;

create or replace function props.american_to_decimal(a int) returns numeric
language sql immutable as $$ select case when a is null or abs(a) < 100 then null when a > 0 then 1 + a / 100.0 else 1 + 100.0 / (-a) end $$;
create or replace function props.fair_american(p_win numeric, p_push numeric default 0) returns int
language sql immutable as $$
  select case when p_win is null or p_win <= 0 or p_win >= 1 then null
    else case when (1 - coalesce(p_push,0)) / p_win >= 2 then round(((1 - coalesce(p_push,0)) / p_win - 1) * 100)::int
              else round(-100 / ((1 - coalesce(p_push,0)) / p_win - 1))::int end end $$;

-- observed quotes only: the one dataset a backtest or a calibration may read
create or replace view props.v_observed_prop_quotes with (security_invoker = true) as
select * from props.fact_prop_quote where lineage = 'observed';

-- observed, taken before kickoff, pair-sane: the training / calibration view (Q006, Q007, Q012)
create or replace view props.v_training_prop_quotes with (security_invoker = true) as
select q.* from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id
where q.lineage = 'observed' and q.snapshot_at < g.kickoff_utc and not q.pair_hold_out_of_bounds;

-- The board's building blocks run as their owner (security_invoker = false):
-- a view nested in the owner-run board would otherwise be checked against the
-- reader. None of them widens access — each is granted only to the roles that
-- may already read the tables beneath it.
-- the latest observed pregame quote per book / side / line
create or replace view props.v_latest_prop_quotes with (security_invoker = false) as
with latest as (
  select distinct on (q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, coalesce(q.line, -9999), q.is_alt_line) q.*
  from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id
  where q.lineage = 'observed' and q.snapshot_at < g.kickoff_utc
  order by q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, coalesce(q.line, -9999), q.is_alt_line, q.snapshot_at desc
), listing as (
  select distinct on (game_id, player_id, market_key, sportsbook) game_id, player_id, market_key, sportsbook, keys
  from props.fact_prop_listing order by game_id, player_id, market_key, sportsbook, snapshot_at desc
)
select l.* from latest l
left join listing li on li.game_id = l.game_id and li.player_id = l.player_id and li.market_key = l.market_key and li.sportsbook = l.sportsbook
-- a listed book shows only what its latest poll listed; a book with no listing on file shows its latest rows
where li.keys is null or (l.side || '|' || coalesce(trim_scale(l.line)::text, '') || '|' || case when l.is_alt_line then '1' else '0' end) = any (li.keys);

-- line shopping: consensus main line, depth, dispersion, best prices and best numbers
create or replace view props.v_prop_line_shopping with (security_invoker = false) as
with main as (
  select * from props.v_latest_prop_quotes where is_main_line
), per_book as (
  select game_id, player_id, market_key, sportsbook, max(line) filter (where side = 'over') as book_line,
         max(no_vig_prob) filter (where side in ('over','yes')) as book_over_nv
  from main group by game_id, player_id, market_key, sportsbook
), cons as (
  select game_id, player_id, market_key, count(*) as book_count,
         percentile_cont(0.5) within group (order by book_line) as consensus_line,
         max(book_line) - min(book_line) as line_dispersion,
         stddev_samp(book_over_nv) as price_dispersion
  from per_book group by game_id, player_id, market_key
)
select c.*,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('over','yes')
     order by m.line asc nulls last, m.decimal_price desc limit 1) as best_over_line,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('under','no')
     order by m.line desc nulls last, m.decimal_price desc limit 1) as best_under_line,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('over','yes')
       and (m.line is null or m.line = c.consensus_line) order by m.decimal_price desc limit 1) as best_over_price,
  (select jsonb_build_object('sportsbook', m.sportsbook, 'line', m.line, 'american', m.american_price) from main m
     where m.game_id = c.game_id and m.player_id = c.player_id and m.market_key = c.market_key and m.side in ('under','no')
       and (m.line is null or m.line = c.consensus_line) order by m.decimal_price desc limit 1) as best_under_price
from cons c;

-- movement: opener, current and close of the main over line per book
create or replace view props.v_prop_movement with (security_invoker = false) as
with q as (
  select q.*, g.kickoff_utc from props.fact_prop_quote q join props.dim_game g on g.game_id = q.game_id
  where q.lineage = 'observed' and q.is_main_line and q.side in ('over','yes')
)
select game_id, player_id, market_key, sportsbook,
  (array_agg(line order by snapshot_at))[1] as open_line,
  (array_agg(american_price order by snapshot_at))[1] as open_price,
  min(snapshot_at) as open_at,
  (array_agg(line order by snapshot_at desc))[1] as current_line,
  (array_agg(american_price order by snapshot_at desc))[1] as current_price,
  max(snapshot_at) as current_at,
  (array_agg(line order by snapshot_at desc) filter (where snapshot_at < kickoff_utc))[1] as close_line,
  (array_agg(american_price order by snapshot_at desc) filter (where snapshot_at < kickoff_utc))[1] as close_price,
  (array_agg(line order by snapshot_at desc))[1] - (array_agg(line order by snapshot_at))[1] as line_move,
  count(*) as n_snapshots
from q group by game_id, player_id, market_key, sportsbook;

-- the newest prediction per player-market-game from a CHAMPION model
create or replace view props.v_latest_predictions with (security_invoker = false) as
select distinct on (p.game_id, p.player_id, p.market_key) p.*
from props.model_prediction p join props.v_model_status s on s.model_version = p.model_version and s.status = 'CHAMPION'
order by p.game_id, p.player_id, p.market_key, p.scored_at desc;

-- every latest observed quote priced against the latest prediction's distribution
create or replace view props.v_prop_quote_eval with (security_invoker = false) as
select q.quote_id, q.league, q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, q.line, q.american_price, q.decimal_price, q.implied_prob, q.no_vig_prob,
  q.is_main_line, q.is_alt_line, q.snapshot_at, p.prediction_id, p.model_version, p.projected_mean, p.projected_median, p.confidence, p.data_quality,
  case q.side when 'over' then pr.p_over when 'under' then pr.p_under when 'yes' then pr.p_over else pr.p_under end as model_win,
  pr.p_push as model_push,
  case when q.side in ('over','yes') then pr.p_over / nullif(pr.p_over + pr.p_under, 0) else pr.p_under / nullif(pr.p_over + pr.p_under, 0) end as model_prob,
  props.fair_american(case q.side when 'over' then pr.p_over when 'under' then pr.p_under when 'yes' then pr.p_over else pr.p_under end, pr.p_push) as fair_american,
  (case q.side when 'over' then pr.p_over when 'under' then pr.p_under when 'yes' then pr.p_over else pr.p_under end) * (q.decimal_price - 1)
    - (case q.side when 'over' then pr.p_under when 'under' then pr.p_over when 'yes' then pr.p_under else pr.p_over end) as expected_value
from props.v_latest_prop_quotes q
join props.v_latest_predictions p on p.game_id = q.game_id and p.player_id = q.player_id and p.market_key = q.market_key
cross join lateral props.dist_probs(p.dist, q.line) pr;

-- THE WEBSITE BOARD (workbook sheet 09): one row per player-market with the
-- best over price at the consensus line, the model and the market side by side
-- Owner-run on purpose (the pattern of cfb_lab_public_record): it exposes only
-- these curated columns, so a reader may see the board without reading the raw
-- quote history or the prediction table it is built from.
create or replace view props.v_player_props_board with (security_invoker = false) as
select p.league, p.game_id, g.kickoff_utc, p.player_id, dp.full_name as player_name, dp.position, p.market_key,
  bo.sportsbook, bo.line, bo.american_price as price,
  p.projected_mean as model_mean, p.projected_median as model_median,
  coalesce(e.model_prob, p.over_probability) as model_over_prob,
  ls.consensus_over_nv as market_no_vig_over_prob,
  coalesce(e.model_prob, p.over_probability) - ls.consensus_over_nv as edge_prob,
  e.expected_value as expected_value_pct,
  coalesce(e.fair_american, p.fair_over_american) as fair_price,
  p.confidence, p.data_quality, mv.line_move, ls.book_count,
  greatest(p.scored_at, bo.snapshot_at) as updated_at,
  p.model_version
from props.v_latest_predictions p
join props.dim_game g on g.game_id = p.game_id
join props.dim_player dp on dp.player_id = p.player_id
left join lateral (
  select l.*, (select percentile_cont(0.5) within group (order by q2.no_vig_prob) from props.v_latest_prop_quotes q2
     where q2.game_id = p.game_id and q2.player_id = p.player_id and q2.market_key = p.market_key and q2.is_main_line and q2.side in ('over','yes')
       and (q2.line is null or q2.line = l.consensus_line)) as consensus_over_nv
  from props.v_prop_line_shopping l where l.game_id = p.game_id and l.player_id = p.player_id and l.market_key = p.market_key) ls on true
left join lateral (
  select q.* from props.v_latest_prop_quotes q where q.game_id = p.game_id and q.player_id = p.player_id and q.market_key = p.market_key
    and q.side in ('over','yes') and q.is_main_line and (q.line is null or q.line = ls.consensus_line) order by q.decimal_price desc limit 1) bo on true
left join props.v_prop_quote_eval e on e.quote_id = bo.quote_id
left join lateral (select avg(m.line_move) as line_move from props.v_prop_movement m where m.game_id = p.game_id and m.player_id = p.player_id and m.market_key = p.market_key) mv on true
where g.kickoff_utc > now() - interval '6 hours';

-- the graded record by segment; bad segments are never folded away
create or replace view props.v_prop_record_summary with (security_invoker = false) as
select league, market_key, position,
  case when edge is null then null when edge < 0 then 'negative' when edge < 0.02 then '0-2%' when edge < 0.04 then '2-4%' when edge < 0.06 then '4-6%'
       when edge < 0.08 then '6-8%' when edge < 0.10 then '8-10%' else '10%+' end as edge_bucket,
  count(*) as entries,
  count(*) filter (where result is not null) as graded,
  count(*) filter (where result = 'WIN') as wins, count(*) filter (where result = 'LOSS') as losses,
  count(*) filter (where result = 'PUSH') as pushes, count(*) filter (where result = 'VOID') as voids,
  round(sum(units_flat) filter (where result in ('WIN','LOSS','PUSH')), 3) as units_flat,
  round(sum(units_flat) filter (where result in ('WIN','LOSS','PUSH')) / nullif(count(*) filter (where result in ('WIN','LOSS','PUSH')), 0), 4) as roi_flat,
  round(avg(clv_price), 4) as mean_clv_price,
  count(*) filter (where result is not null) >= 100 as sufficient_sample
from props.prop_record group by 1, 2, 3, 4;

-- ===========================================================================
-- QUALITY — every rule as a query; nothing here mutates a row
-- ===========================================================================
create or replace function props.run_quality_checks()
returns table(rule_id text, scope text, severity text, violations bigint, status text)
language sql stable security definer set search_path = props, pg_temp as $$
  select 'Q001', 'fact_player_game', 'ERROR', (select count(*) from (select game_id, player_id from props.fact_player_game group by 1, 2 having count(*) > 1) d), null
  union all select 'Q002', 'fact_player_game', 'ERROR', (select count(*) from props.fact_player_game where least(coalesce(attempts,0), coalesce(carries,0), coalesce(targets,0), coalesce(receptions,0)) < 0), null
  union all select 'Q003', 'fact_player_game', 'ERROR', (select count(*) from props.fact_player_game where completions > attempts), null
  union all select 'Q004', 'fact_player_game', 'ERROR', (select count(*) from props.fact_player_game where targets > 0 and receptions > targets), null
  union all select 'Q005', 'fact_player_game', 'WARN', (select count(*) from props.fact_player_game where passing_tds + interceptions > attempts or rushing_tds > carries or receiving_tds > receptions), null
  union all select 'Q006', 'fact_prop_quote', 'ERROR', (select count(*) from props.fact_prop_quote where lineage not in ('observed','reconstructed')), null
  union all select 'Q007', 'v_training_prop_quotes', 'ERROR', (select count(*) from props.v_training_prop_quotes q join props.dim_game g using (game_id) where q.snapshot_at >= g.kickoff_utc), null
  union all select 'Q008', 'fact_feature_snapshot', 'ERROR', (select count(*) from props.fact_feature_snapshot where source_max_timestamp > asof_at), null
  union all select 'Q009', 'bridge_cfb_nfl_player', 'ERROR', (select count(*) from props.dim_player p where p.identity_status = 'bridged' and not exists (select 1 from props.bridge_cfb_nfl_player b where b.player_id = p.player_id and b.production_eligible)), null
  union all select 'Q010', 'fact_prop_result', 'ERROR', (select count(*) from props.fact_prop_result where participated and result_quality < 0.95), null
  union all select 'Q011', 'fact_prop_quote', 'ERROR', (select count(*) from props.fact_prop_quote where american_price between -99 and 99), null
  union all select 'Q012', 'fact_prop_quote', 'WARN', (select count(*) from props.v_latest_prop_quotes o where o.is_main_line and o.side = 'over' and not exists (
        select 1 from props.v_latest_prop_quotes u where u.game_id = o.game_id and u.player_id = o.player_id and u.market_key = o.market_key and u.sportsbook = o.sportsbook
          and u.side = 'under' and u.line = o.line and u.snapshot_at = o.snapshot_at)), null
  union all select 'Q013', 'dim_game', 'ERROR', (select count(*) from props.dim_game where kickoff_utc is null), null
  union all select 'Q014', 'all', 'ERROR', (select count(*) from props.fact_player_game where source_provider is null) + (select count(*) from props.fact_prop_quote where provider is null), null
  union all select 'Q015', 'model_prediction', 'ERROR', (select count(*) from props.model_prediction p join props.dim_game g using (game_id) where p.asof_at >= g.kickoff_utc), null
$$;
-- the view form, with the status column filled
create or replace view props.v_quality with (security_invoker = true) as
select rule_id, scope, severity, violations, case when violations = 0 then 'ok' when severity = 'WARN' then 'warn' else 'FAIL' end as status
from props.run_quality_checks();

-- ===========================================================================
-- INGESTION DOORS (service role only)
-- ===========================================================================
-- Quotes, one JSON array at a time: invalid rows quarantined, duplicates
-- ignored, valid rows appended. Running it twice appends nothing twice.
create or replace function props.ingest_prop_quotes(p_quotes jsonb, p_run_id text default null)
returns jsonb language plpgsql security definer set search_path = props, pg_temp as $$
declare q jsonb; n_in int := 0; n_ok int := 0; n_dup int := 0; n_bad int := 0; reasons text[]; ins int; nv numeric; opp jsonb;
begin
  for q in select * from jsonb_array_elements(coalesce(p_quotes, '[]'::jsonb)) loop
    n_in := n_in + 1; reasons := '{}';
    if (q->>'lineage') is null or (q->>'lineage') not in ('observed','reconstructed') then reasons := array_append(reasons, 'Q006: lineage missing or invalid'::text); end if;
    if (q->>'american_price') is null or ((q->>'american_price')::int between -99 and 99) then reasons := array_append(reasons, 'Q011: invalid American price'::text); end if;
    if (q->>'provider') is null then reasons := array_append(reasons, 'Q014: no provider'::text); end if;
    if not exists (select 1 from props.dim_game where game_id = q->>'game_id') then reasons := array_append(reasons, 'unknown game'::text); end if;
    if not exists (select 1 from props.dim_player where player_id = q->>'player_id') then reasons := array_append(reasons, 'Q009: unknown player'::text); end if;
    if not exists (select 1 from props.prop_catalog where market_key = q->>'market_key') then reasons := array_append(reasons, 'unknown market'::text); end if;
    if array_length(reasons, 1) > 0 then
      n_bad := n_bad + 1;
      insert into props.quarantine(rule_id, scope, natural_key, reasons, payload, run_id)
      values (coalesce(substring(reasons[1] from '^(Q[0-9]{3})'), 'Q014'), 'fact_prop_quote', coalesce(q->>'quote_id', md5(q::text)), reasons, q, p_run_id)
      on conflict do nothing;
      continue;
    end if;
    -- the no-vig probability from this quote's own pair (same book, snapshot, player, market, line) in the batch;
    -- the table is append-only, so it must be right on the way in
    nv := (q->>'no_vig_prob')::numeric;
    if nv is null then
      select o into opp from jsonb_array_elements(p_quotes) o
       where o->>'game_id' = q->>'game_id' and o->>'player_id' = q->>'player_id' and o->>'market_key' = q->>'market_key' and o->>'sportsbook' = q->>'sportsbook'
         and o->>'snapshot_at' = q->>'snapshot_at' and coalesce(o->>'line', '') = coalesce(q->>'line', '') and coalesce(o->>'is_alt_line', 'false') = coalesce(q->>'is_alt_line', 'false')
         and o->>'side' = case q->>'side' when 'over' then 'under' when 'under' then 'over' when 'yes' then 'no' else 'yes' end
       limit 1;
      if opp is not null and (opp->>'american_price') is not null and abs((opp->>'american_price')::int) >= 100 then
        nv := (1 / props.american_to_decimal((q->>'american_price')::int)) / ((1 / props.american_to_decimal((q->>'american_price')::int)) + (1 / props.american_to_decimal((opp->>'american_price')::int)));
      end if;
    end if;
    insert into props.fact_prop_quote(quote_id, league, game_id, player_id, team_id, market_key, sportsbook, provider, snapshot_at, provider_updated_at, minutes_to_kick,
      side, line, american_price, decimal_price, implied_prob, no_vig_prob, is_main_line, is_alt_line, lineage, source_market_key, source_player_name, player_match,
      provider_event_id, source_payload_hash, fingerprint, pair_hold_out_of_bounds)
    values (q->>'quote_id', q->>'league', q->>'game_id', q->>'player_id', q->>'team_id', q->>'market_key', q->>'sportsbook', q->>'provider', (q->>'snapshot_at')::timestamptz,
      (q->>'provider_updated_at')::timestamptz, (q->>'minutes_to_kick')::int, q->>'side', (q->>'line')::numeric, (q->>'american_price')::int,
      props.american_to_decimal((q->>'american_price')::int), 1 / props.american_to_decimal((q->>'american_price')::int), nv,
      coalesce((q->>'is_main_line')::boolean, false), coalesce((q->>'is_alt_line')::boolean, false), q->>'lineage', q->>'source_market_key', q->>'source_player_name',
      q->>'player_match', q->>'provider_event_id', q->>'source_payload_hash', q->>'fingerprint', coalesce((q->>'pair_hold_out_of_bounds')::boolean, false))
    on conflict do nothing;
    get diagnostics ins = row_count;
    if ins = 1 then n_ok := n_ok + 1; else n_dup := n_dup + 1; end if;
  end loop;
  return jsonb_build_object('received', n_in, 'inserted', n_ok, 'duplicates', n_dup, 'quarantined', n_bad);
end $$;

-- Promote staged player-games: new rows inserted, changed rows logged in
-- fact_corrections THEN updated, unchanged rows untouched, rows failing a
-- quality gate quarantined. Idempotent.
create or replace function props.promote_player_games(p_run_id text)
returns jsonb language plpgsql security definer set search_path = props, pg_temp as $$
declare n_new int; n_changed int; n_bad int;
begin
  with bad as (
    select s.* from props.stg_player_game s where s.run_id = p_run_id and (
      (s.completions > s.attempts) or (s.targets > 0 and s.receptions > s.targets)
      or least(coalesce(s.attempts,0), coalesce(s.carries,0), coalesce(s.targets,0), coalesce(s.receptions,0), coalesce(s.completions,0)) < 0
      or s.source_provider is null
      or not exists (select 1 from props.dim_player p where p.player_id = s.player_id)
      or not exists (select 1 from props.dim_game g where g.game_id = s.game_id))
  ), q as (
    insert into props.quarantine(rule_id, scope, natural_key, reasons, payload, run_id)
    select case when b.completions > b.attempts then 'Q003' when b.targets > 0 and b.receptions > b.targets then 'Q004' when b.source_provider is null then 'Q014'
                when not exists (select 1 from props.dim_player p where p.player_id = b.player_id) then 'Q009' else 'Q002' end,
           'fact_player_game', b.game_id || '|' || b.player_id, array['failed a quality gate at promotion'], to_jsonb(b), p_run_id
    from bad b on conflict do nothing returning 1
  ) select count(*) into n_bad from q;
  delete from props.stg_player_game s where s.run_id = p_run_id and (
      (s.completions > s.attempts) or (s.targets > 0 and s.receptions > s.targets)
      or least(coalesce(s.attempts,0), coalesce(s.carries,0), coalesce(s.targets,0), coalesce(s.receptions,0), coalesce(s.completions,0)) < 0
      or s.source_provider is null
      or not exists (select 1 from props.dim_player p where p.player_id = s.player_id)
      or not exists (select 1 from props.dim_game g where g.game_id = s.game_id));
  -- corrections first: an existing row whose measured values changed
  insert into props.fact_corrections(game_id, player_id, run_id, old_row, new_row)
  select f.game_id, f.player_id, p_run_id, to_jsonb(f) - 'loaded_at', to_jsonb(s) - 'run_id' - 'loaded_at'
  from props.stg_player_game s join props.fact_player_game f using (game_id, player_id)
  where s.run_id = p_run_id and (s.attempts, s.completions, s.passing_yards, s.passing_tds, s.interceptions, s.carries, s.rushing_yards, s.rushing_tds,
        s.targets, s.receptions, s.receiving_yards, s.receiving_tds, s.longest_reception, s.longest_rush, s.longest_completion, s.snaps)
     is distinct from (f.attempts, f.completions, f.passing_yards, f.passing_tds, f.interceptions, f.carries, f.rushing_yards, f.rushing_tds,
        f.targets, f.receptions, f.receiving_yards, f.receiving_tds, f.longest_reception, f.longest_rush, f.longest_completion, f.snaps);
  get diagnostics n_changed = row_count;
  insert into props.fact_player_game
  select game_id, player_id, team_id, opponent_id, player_name, position, position_group, season, week, kickoff_utc, is_home, starter, active_status, injury_status, snaps, snap_share, routes,
      attempts, completions, passing_yards, passing_tds, interceptions, sacks_taken, passing_air_yards, passing_epa, passing_cpoe, dropbacks, scrambles, designed_rushes,
      carries, rushing_yards, rushing_tds, rushing_epa, targets, receptions, receiving_yards, receiving_tds, receiving_epa, air_yards, yac, target_share, air_yard_share,
      red_zone_touches, goal_line_touches, rz_targets, rz_carries, gl_carries, explosive_rec, explosive_rush, longest_completion, longest_rush, longest_reception,
      fumbles_lost, special_teams_tds, fg_made, fg_att, pat_made, kicking_points, def_interceptions, def_sacks, def_tackles_assists, source_quality, source_provider,
      source_detail, source_updated_at, qa_warnings, now()
  from props.stg_player_game where run_id = p_run_id
  on conflict (game_id, player_id) do update set
    attempts = excluded.attempts, completions = excluded.completions, passing_yards = excluded.passing_yards, passing_tds = excluded.passing_tds, interceptions = excluded.interceptions,
    carries = excluded.carries, rushing_yards = excluded.rushing_yards, rushing_tds = excluded.rushing_tds, targets = excluded.targets, receptions = excluded.receptions,
    receiving_yards = excluded.receiving_yards, receiving_tds = excluded.receiving_tds, longest_reception = excluded.longest_reception, longest_rush = excluded.longest_rush,
    longest_completion = excluded.longest_completion, snaps = excluded.snaps, snap_share = excluded.snap_share, source_quality = excluded.source_quality, loaded_at = now()
  where (excluded.attempts, excluded.completions, excluded.passing_yards, excluded.passing_tds, excluded.interceptions, excluded.carries, excluded.rushing_yards, excluded.rushing_tds,
         excluded.targets, excluded.receptions, excluded.receiving_yards, excluded.receiving_tds, excluded.longest_reception, excluded.longest_rush, excluded.longest_completion, excluded.snaps)
     is distinct from (props.fact_player_game.attempts, props.fact_player_game.completions, props.fact_player_game.passing_yards, props.fact_player_game.passing_tds,
         props.fact_player_game.interceptions, props.fact_player_game.carries, props.fact_player_game.rushing_yards, props.fact_player_game.rushing_tds, props.fact_player_game.targets,
         props.fact_player_game.receptions, props.fact_player_game.receiving_yards, props.fact_player_game.receiving_tds, props.fact_player_game.longest_reception,
         props.fact_player_game.longest_rush, props.fact_player_game.longest_completion, props.fact_player_game.snaps);
  get diagnostics n_new = row_count;
  delete from props.stg_player_game where run_id = p_run_id;
  return jsonb_build_object('upserted', n_new, 'corrections_logged', n_changed, 'quarantined', n_bad);
end $$;

-- ===========================================================================
-- 12. AI CONTEXT — bounded, read-only, the only door the desk reads props through
-- ===========================================================================
create or replace function props.ai_prop_context(p_player text, p_market text default null, p_league text default null)
returns jsonb language sql stable security definer set search_path = props, pg_temp as $$
  with pl as (
    select player_id, full_name, position from props.dim_player
    where (player_id = p_player or lower(full_name) = lower(p_player)) limit 5
  ), pr as (
    select p.*, g.kickoff_utc, g.home_team_id, g.away_team_id from props.v_latest_predictions p join pl using (player_id) join props.dim_game g using (game_id)
    where g.kickoff_utc > now() and (p_market is null or p.market_key = p_market) and (p_league is null or p.league = upper(p_league))
    order by g.kickoff_utc limit 12
  )
  select jsonb_build_object(
    'player', (select jsonb_agg(to_jsonb(pl)) from pl),
    'predictions', coalesce((select jsonb_agg(jsonb_build_object('game_id', game_id, 'kickoff_utc', kickoff_utc, 'market_key', market_key, 'model_version', model_version,
        'mean', projected_mean, 'median', projected_median, 'p10', projected_p10, 'p90', projected_p90, 'ref_line', ref_line, 'over', over_probability, 'under', under_probability,
        'fair_over', fair_over_american, 'fair_under', fair_under_american, 'confidence', confidence, 'data_quality', data_quality, 'scored_at', scored_at)) from pr), '[]'::jsonb),
    'quotes', coalesce((select jsonb_agg(jsonb_build_object('market_key', e.market_key, 'sportsbook', e.sportsbook, 'side', e.side, 'line', e.line, 'american', e.american_price,
        'model_prob', round(e.model_prob, 4), 'fair_american', e.fair_american, 'ev', round(e.expected_value, 4), 'no_vig', round(e.no_vig_prob, 4), 'snapshot_at', e.snapshot_at))
        from props.v_prop_quote_eval e join pr on pr.game_id = e.game_id and pr.player_id = e.player_id and pr.market_key = e.market_key), '[]'::jsonb),
    'record', (select jsonb_agg(to_jsonb(s)) from props.v_prop_record_summary s where p_market is null or s.market_key = p_market),
    'rule', 'Only what is stored here may be quoted. A missing field is missing; nothing is filled in.')
$$;
create or replace function props.ai_prop_board(p_league text default null, p_limit int default 20)
returns jsonb language sql stable security definer set search_path = props, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from (
    select * from props.v_player_props_board where (p_league is null or league = upper(p_league)) and expected_value_pct is not null
    order by expected_value_pct desc nulls last limit least(greatest(coalesce(p_limit, 20), 1), 50)) b
$$;
create or replace function props.ai_data_health()
returns jsonb language sql stable security definer set search_path = props, pg_temp as $$
  select jsonb_build_object(
    'player_games', (select count(*) from props.fact_player_game), 'games', (select count(*) from props.dim_game),
    'observed_quotes', (select count(*) from props.fact_prop_quote where lineage = 'observed'),
    'reconstructed_quotes', (select count(*) from props.fact_prop_quote where lineage = 'reconstructed'),
    'last_quote_at', (select max(snapshot_at) from props.fact_prop_quote), 'last_prediction_at', (select max(scored_at) from props.model_prediction),
    'champion_models', (select count(*) from props.v_model_status where status = 'CHAMPION'),
    'quality', (select jsonb_agg(jsonb_build_object('rule', rule_id, 'violations', violations, 'status', status)) from props.v_quality))
$$;

-- ===========================================================================
-- SEEDS (on conflict do nothing: a re-run never rewrites a stored value)
-- ===========================================================================
insert into props.quality_rules(rule_id, scope, check_type, rule, severity, action) values
 ('Q001','fact_player_game','PRIMARY KEY','game_id + player_id unique','ERROR','Reject duplicate player-game rows'),
 ('Q002','fact_player_game','RANGE','all counting stats >= 0','ERROR','Reject negatives except explicitly signed metrics'),
 ('Q003','fact_player_game','CONSISTENCY','completions <= attempts','ERROR','Reject or quarantine'),
 ('Q004','fact_player_game','CONSISTENCY','receptions <= targets when targets present','ERROR','Reject or quarantine'),
 ('Q005','fact_player_game','CONSISTENCY','passing_tds/interceptions plausible vs attempts','WARN','Flag extreme provider errors'),
 ('Q006','fact_prop_quote','LINEAGE','lineage in observed,reconstructed','ERROR','Never default missing lineage'),
 ('Q007','fact_prop_quote','TIMESTAMP','snapshot_at < kickoff_utc for pregame backtest','ERROR','Prevents in-game leakage'),
 ('Q008','fact_feature_snapshot','POINT IN TIME','source_max_timestamp <= asof_at','ERROR','Hard leakage gate'),
 ('Q009','bridge_cfb_nfl_player','IDENTITY','match_confidence >= .90 or manual_reviewed=true for production','ERROR','Prevents cross-player contamination'),
 ('Q010','fact_prop_result','SETTLEMENT','result_quality >= .95 for training target','ERROR','Quarantine uncertain settlements'),
 ('Q011','fact_prop_quote','ODDS','american_price not between -99 and 99','ERROR','Invalid American-odds gap'),
 ('Q012','fact_prop_quote','PAIRING','main OU should pair over+under at same book/snapshot/line','WARN','Needed for de-vigging'),
 ('Q013','dim_game','TIME','kickoff_utc non-null and timezone-aware','ERROR','No local-time ambiguity'),
 ('Q014','all','SOURCE','source/provider present','ERROR','Every row must retain provenance'),
 ('Q015','training_view','LEAKAGE','no post-kickoff/in-game/injury-resolution-after-bet fields','ERROR','Automated feature whitelist only')
on conflict (rule_id) do nothing;

insert into props.prop_catalog(market_key, market_group, positions, target_column, bet_type, priority, cfb, nfl, family, modeled, settle_stats, notes) values
 ('pass_yards','passing','{QB}','passing_yards','OU','P0',true,true,'continuous',true,'{passing_yards}','Core continuous prop'),
 ('pass_tds','passing','{QB}','passing_tds','OU','P0',true,true,'count',true,'{passing_tds}','Count distribution'),
 ('pass_completions','passing','{QB}','completions','OU','P0',true,true,'count',true,'{completions}','Volume + efficiency'),
 ('pass_attempts','passing','{QB}','attempts','OU','P0',true,true,'count',true,'{attempts}','Highly role/game-script dependent'),
 ('pass_interceptions','passing','{QB}','interceptions','OU','P0',true,true,'count',true,'{interceptions}','Low-count discrete'),
 ('pass_longest_completion','passing','{QB}','longest_completion','OU','P1',true,true,'continuous',true,'{longest_completion}','Tail-sensitive'),
 ('rush_yards','rushing','{QB,RB,WR}','rushing_yards','OU','P0',true,true,'continuous',true,'{rushing_yards}','Core continuous prop'),
 ('rush_attempts','rushing','{QB,RB,WR}','carries','OU','P0',true,true,'count',true,'{carries}','Usage prop'),
 ('rush_tds','rushing','{QB,RB,WR}','rushing_tds','OU','P1',true,true,'count',true,'{rushing_tds}','Count distribution'),
 ('longest_rush','rushing','{QB,RB,WR}','longest_rush','OU','P1',true,true,'continuous',true,'{longest_rush}','Tail-sensitive'),
 ('receiving_yards','receiving','{RB,WR,TE}','receiving_yards','OU','P0',true,true,'continuous',true,'{receiving_yards}','Core continuous prop'),
 ('receptions','receiving','{RB,WR,TE}','receptions','OU','P0',true,true,'count',true,'{receptions}','Target + catch model'),
 ('targets','receiving','{RB,WR,TE}','targets','OU','P1',true,true,'count',true,'{targets}','Not offered everywhere'),
 ('receiving_tds','receiving','{RB,WR,TE}','receiving_tds','OU','P1',true,true,'count',true,'{receiving_tds}','Count distribution'),
 ('longest_reception','receiving','{RB,WR,TE}','longest_reception','OU','P1',true,true,'continuous',true,'{longest_reception}','Tail-sensitive'),
 ('anytime_td','scoring','{QB,RB,WR,TE}','any_touchdown','YESNO','P0',true,true,'binary',true,'{rushing_tds,receiving_tds}','Binary scoring probability; define passing TD exclusion by book'),
 ('first_td','scoring','{QB,RB,WR,TE}','first_touchdown','YESNO','P2',true,true,'binary',false,'{}','High variance; lineup/drive-order sensitive'),
 ('pass_rush_yards','combo','{QB}','pass_plus_rush_yards','OU','P0',true,true,'continuous',true,'{passing_yards,rushing_yards}','Strong QB market'),
 ('rush_rec_yards','combo','{RB,WR,TE}','rush_plus_receiving_yards','OU','P0',true,true,'continuous',true,'{rushing_yards,receiving_yards}','Useful for hybrid usage'),
 ('pass_rush_rec_yards','combo','{QB,RB,WR,TE}','total_offense_yards','OU','P1',true,true,'continuous',true,'{passing_yards,rushing_yards,receiving_yards}','Provider-specific naming'),
 ('receptions_rush_attempts','combo','{RB,WR,TE}','receptions_plus_carries','OU','P2',true,true,'count',true,'{receptions,carries}','Provider-specific'),
 ('kicking_points','kicking','{K}','kicking_points','OU','P2',true,true,'count',false,'{}','Can add after offensive markets stabilize'),
 ('field_goals_made','kicking','{K}','field_goals_made','OU','P2',true,true,'count',false,'{}','Discrete'),
 ('extra_points_made','kicking','{K}','extra_points_made','OU','P2',true,true,'count',false,'{}','Often low edge'),
 ('def_interceptions','defense','{DB,LB}','defensive_interceptions','OU','P3',true,true,'count',false,'{}','Historical player stat quality varies'),
 ('sacks','defense','{DL,LB}','sacks','OU','P3',true,true,'count',false,'{}','Provider/stat attribution variance'),
 ('tackles_assists','defense','{LB,DB,DL}','tackles_assists','OU','P3',false,true,'count',false,'{}','NFL first; CFB historical consistency weaker')
on conflict (market_key) do nothing;

insert into props.provider_market_map(provider, provider_market_key, market_key, is_alternate) values
 ('the-odds-api','player_pass_yds','pass_yards',false),('the-odds-api','player_pass_yds_alternate','pass_yards',true),
 ('the-odds-api','player_pass_tds','pass_tds',false),('the-odds-api','player_pass_tds_alternate','pass_tds',true),
 ('the-odds-api','player_pass_completions','pass_completions',false),('the-odds-api','player_pass_completions_alternate','pass_completions',true),
 ('the-odds-api','player_pass_attempts','pass_attempts',false),('the-odds-api','player_pass_attempts_alternate','pass_attempts',true),
 ('the-odds-api','player_pass_interceptions','pass_interceptions',false),('the-odds-api','player_pass_interceptions_alternate','pass_interceptions',true),
 ('the-odds-api','player_pass_longest_completion','pass_longest_completion',false),('the-odds-api','player_pass_longest_completion_alternate','pass_longest_completion',true),
 ('the-odds-api','player_rush_yds','rush_yards',false),('the-odds-api','player_rush_yds_alternate','rush_yards',true),
 ('the-odds-api','player_rush_attempts','rush_attempts',false),('the-odds-api','player_rush_attempts_alternate','rush_attempts',true),
 ('the-odds-api','player_rush_tds','rush_tds',false),('the-odds-api','player_rush_tds_alternate','rush_tds',true),
 ('the-odds-api','player_rush_longest','longest_rush',false),('the-odds-api','player_rush_longest_alternate','longest_rush',true),
 ('the-odds-api','player_reception_yds','receiving_yards',false),('the-odds-api','player_reception_yds_alternate','receiving_yards',true),
 ('the-odds-api','player_receptions','receptions',false),('the-odds-api','player_receptions_alternate','receptions',true),
 ('the-odds-api','player_reception_tds','receiving_tds',false),('the-odds-api','player_reception_tds_alternate','receiving_tds',true),
 ('the-odds-api','player_reception_longest','longest_reception',false),('the-odds-api','player_reception_longest_alternate','longest_reception',true),
 ('the-odds-api','player_anytime_td','anytime_td',false),('the-odds-api','player_1st_td','first_td',false),
 ('the-odds-api','player_pass_rush_yds','pass_rush_yards',false),('the-odds-api','player_pass_rush_yds_alternate','pass_rush_yards',true),
 ('the-odds-api','player_rush_reception_yds','rush_rec_yards',false),('the-odds-api','player_rush_reception_yds_alternate','rush_rec_yards',true),
 ('the-odds-api','player_pass_rush_reception_yds','pass_rush_rec_yards',false),('the-odds-api','player_pass_rush_reception_yds_alternate','pass_rush_rec_yards',true),
 ('the-odds-api','player_kicking_points','kicking_points',false),('the-odds-api','player_kicking_points_alternate','kicking_points',true),
 ('the-odds-api','player_field_goals','field_goals_made',false),('the-odds-api','player_field_goals_alternate','field_goals_made',true),
 ('the-odds-api','player_pats','extra_points_made',false),('the-odds-api','player_pats_alternate','extra_points_made',true),
 ('the-odds-api','player_defensive_interceptions','def_interceptions',false),('the-odds-api','player_defensive_interceptions_alternate','def_interceptions',true),
 ('the-odds-api','player_sacks','sacks',false),('the-odds-api','player_sacks_alternate','sacks',true),
 ('the-odds-api','player_tackles_assists','tackles_assists',false),('the-odds-api','player_tackles_assists_alternate','tackles_assists',true)
on conflict (provider, provider_market_key) do nothing;

insert into props.backtest_splits(fold, family, train_from, train_to, test_season, method, notes) values
 ('OUTCOME_CFB_1','CFB outcome model',2014,2018,2019,'Walk-forward','Primary baseline'),
 ('OUTCOME_CFB_2','CFB outcome model',2014,2019,2020,'Walk-forward','Pandemic season tagged; report separately'),
 ('OUTCOME_CFB_3','CFB outcome model',2014,2020,2021,'Walk-forward','No random split'),
 ('OUTCOME_CFB_4','CFB outcome model',2014,2021,2022,'Walk-forward','No random split'),
 ('OUTCOME_CFB_5','CFB outcome model',2014,2022,2023,'Walk-forward','Begins overlap with prop-market labels'),
 ('OUTCOME_CFB_6','CFB outcome model',2014,2023,2024,'Walk-forward',null),
 ('OUTCOME_CFB_7','CFB outcome model',2014,2024,2025,'Walk-forward',null),
 ('OUTCOME_CFB_8','CFB outcome model',2014,2025,2026,'Live/holdout','Do not tune to current-season results'),
 ('OUTCOME_NFL_1','NFL outcome model',2011,2017,2018,'Walk-forward',null),
 ('OUTCOME_NFL_2','NFL outcome model',2011,2018,2019,'Walk-forward',null),
 ('OUTCOME_NFL_3','NFL outcome model',2011,2019,2020,'Walk-forward','Pandemic tagged'),
 ('OUTCOME_NFL_4','NFL outcome model',2011,2020,2021,'Walk-forward',null),
 ('OUTCOME_NFL_5','NFL outcome model',2011,2021,2022,'Walk-forward',null),
 ('OUTCOME_NFL_6','NFL outcome model',2011,2022,2023,'Walk-forward','Market overlap begins'),
 ('OUTCOME_NFL_7','NFL outcome model',2011,2023,2024,'Walk-forward',null),
 ('OUTCOME_NFL_8','NFL outcome model',2011,2024,2025,'Walk-forward',null),
 ('OUTCOME_NFL_9','NFL outcome model',2011,2025,2026,'Live/holdout',null),
 ('MARKET_1','Market calibration / EV',2023,2023,2024,'Walk-forward','Observed player-prop quotes only'),
 ('MARKET_2','Market calibration / EV',2023,2024,2025,'Walk-forward','Observed quotes only'),
 ('MARKET_3','Market calibration / EV',2023,2025,2026,'Live/holdout','Observed quotes only')
on conflict (fold) do nothing;

insert into props.pipeline_jobs(job, job_order, league, cadence, layer, input, output) values
 ('ingest_nfl_players',1,'NFL','daily in season / weekly offseason','RAW','nflverse players','dim_player staging'),
 ('ingest_nfl_rosters',2,'NFL','daily in season','RAW','nflverse rosters','roster staging'),
 ('ingest_nfl_player_stats',3,'NFL','after games','RAW','nflverse weekly stats','player_game staging'),
 ('ingest_nfl_pbp',4,'NFL','after games','RAW','nflverse PBP','PBP staging'),
 ('ingest_cfb_rosters',5,'CFB','daily in season','RAW','SportsDataverse','roster staging'),
 ('ingest_cfb_player_box',6,'CFB','after games','RAW','SportsDataverse player box','player_game staging'),
 ('ingest_cfb_pbp',7,'CFB','after games','RAW','SportsDataverse PBP','PBP staging'),
 ('ingest_cfb_recruiting',8,'CFB','weekly/monthly','RAW','CFBD','recruiting staging'),
 ('ingest_prop_quotes',9,'BOTH','5-15 min pregame','RAW','Odds API provider','fact_prop_quote'),
 ('snapshot_market_open',10,'BOTH','event-driven','CURATED','fact_prop_quote','open snapshot flags'),
 ('snapshot_market_close',11,'BOTH','10 min pre-kick','CURATED','fact_prop_quote','close snapshot flags'),
 ('resolve_player_identity',12,'BOTH','after source loads','CURATED','all identity sources','dim_player + bridge'),
 ('build_player_game_fact',13,'BOTH','after stats/PBP','CURATED','stats + PBP','fact_player_game'),
 ('settle_prop_results',14,'BOTH','after game final','CURATED','player_game + quotes','fact_prop_result'),
 ('build_pit_features',15,'BOTH','hourly / pre-board','FEATURE','curated facts','fact_feature_snapshot'),
 ('score_prop_models',16,'BOTH','on quote change','MODEL','features + models','model_prediction'),
 ('publish_props_board',17,'BOTH','on scoring update','SERVE','predictions + quotes','API/public view'),
 ('nightly_qa',18,'BOTH','nightly','QA','all layers','quality metrics + quarantine')
on conflict (job) do nothing;

insert into props.source_registry(source, league, data, coverage, access, license_note, url, role) values
 ('nflverse','NFL','Player stats, PBP, rosters, schedules, players','1999+','Public data releases','CC BY 4.0 for most nflverse data; verify dataset-specific notes','https://nflverse.nflverse.com/','PRIMARY'),
 ('nflreadr player stats','NFL','Weekly player stats','1999+','Season-partitioned releases','nflverse license applies','https://nflreadr.nflverse.com/reference/load_player_stats','PRIMARY'),
 ('nflreadr PBP','NFL','Play-by-play','1999+','Season-partitioned releases','nflverse license applies','https://nflreadr.nflverse.com/reference/load_pbp','PRIMARY'),
 ('SportsDataverse / cfbfastR','CFB','PBP, schedules, player box, rosters, advanced stats','2004+ varies by family','GitHub release assets / package loaders','SportsDataverse release store is CC BY 4.0; upstream-source terms still matter','https://cfbfastr.sportsdataverse.org/','PRIMARY'),
 ('CollegeFootballData','CFB','Games, players, recruiting, ratings, analytics','Varies by endpoint','Bearer API','Check current API terms and access tier','https://api.collegefootballdata.com/','ENRICH'),
 ('The Odds API','BOTH','Observed sportsbook odds, player props, historical snapshots','Props history from 2023-05-03','Paid historical API','Commercial API terms','https://the-odds-api.com/historical-odds-data/','PRIMARY MARKET'),
 ('SportsGameOdds','BOTH','Player props, per-book open/close, historical odds','Availability varies by league/tier','Commercial REST API','Commercial API terms','https://sportsgameodds.com/use-cases/historical-odds-data-api','SECONDARY MARKET'),
 ('Open-Meteo / weather archive','BOTH','Weather observations / historical forecast context','Historical','REST','Check attribution/terms for deployed usage','https://open-meteo.com/','ENRICH')
on conflict (source) do nothing;

-- feature_registry is seeded by football/props/factory/db.js from config/feature_registry.json (121 rows);
-- the report below says whether it has been.

-- ===========================================================================
-- ROW LEVEL SECURITY AND GRANTS
-- Readers: the catalog, the entities, the history, the registry, the serving
-- views and the record. Signed-in only: quote history and predictions.
-- Nobody but the service role: staging, raw payloads, features, quarantine,
-- the ingestion diary, corrections.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['source_registry','prop_catalog','provider_market_map','feature_registry','quality_rules','backtest_splits','pipeline_jobs','ingestion_runs','quarantine',
    'dim_team','dim_player','player_id_map','player_id_merges','bridge_cfb_nfl_player','identity_review','dim_game','fact_player_game','fact_team_game','fact_corrections',
    'stg_player_game','fact_prop_quote','fact_prop_listing','raw_odds_payloads','fact_feature_snapshot','model_registry','model_status_events','model_prediction','fact_prop_result',
    'backtest_run','backtest_decision','prop_record'] loop
    execute format('alter table props.%I enable row level security', t);
    execute format('revoke all on props.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on props.%I to service_role', t);
  end loop;
  -- public reads
  foreach t in array array['source_registry','prop_catalog','provider_market_map','feature_registry','quality_rules','backtest_splits','pipeline_jobs','dim_team','dim_player',
    'bridge_cfb_nfl_player','dim_game','fact_player_game','fact_team_game','model_registry','model_status_events','fact_prop_result','prop_record','backtest_run'] loop
    execute format('grant select on props.%I to anon, authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'props' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on props.%I for select to anon, authenticated using (true)', t || '_read', t);
    end if;
  end loop;
  -- signed-in reads
  foreach t in array array['fact_prop_quote','fact_prop_listing','model_prediction','backtest_decision'] loop
    execute format('grant select on props.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'props' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on props.%I for select to authenticated using (true)', t || '_read', t);
    end if;
  end loop;
end $$;
grant select on props.v_player_props_board, props.v_prop_record_summary, props.v_model_status, props.v_quality to anon, authenticated;
grant select on props.v_observed_prop_quotes, props.v_training_prop_quotes, props.v_latest_prop_quotes, props.v_prop_line_shopping, props.v_prop_movement,
  props.v_latest_predictions, props.v_prop_quote_eval to authenticated;
grant select on all tables in schema props to service_role;
grant execute on function props.dist_cdf(jsonb, numeric), props.dist_probs(jsonb, numeric), props.american_to_decimal(int), props.fair_american(numeric, numeric) to anon, authenticated, service_role;
revoke all on function props.ingest_prop_quotes(jsonb, text) from public, anon, authenticated;
revoke all on function props.promote_player_games(text) from public, anon, authenticated;
grant execute on function props.ingest_prop_quotes(jsonb, text), props.promote_player_games(text) to service_role;
revoke all on function props.ai_prop_context(text, text, text), props.ai_prop_board(text, int), props.ai_data_health(), props.run_quality_checks() from public;
grant execute on function props.ai_prop_context(text, text, text), props.ai_prop_board(text, int), props.ai_data_health(), props.run_quality_checks() to authenticated, service_role;
grant usage, select on all sequences in schema props to service_role;

notify pgrst, 'reload schema';

-- ===========================================================================
-- THE REPORT. Every row must read ok.
-- ===========================================================================
with checks as (
select 1 as row, 'the props schema and its core tables exist' as guarantee,
  case when to_regclass('props.dim_player') is not null and to_regclass('props.dim_game') is not null and to_regclass('props.fact_player_game') is not null
        and to_regclass('props.fact_prop_quote') is not null and to_regclass('props.fact_prop_result') is not null and to_regclass('props.fact_feature_snapshot') is not null
        and to_regclass('props.model_prediction') is not null and to_regclass('props.bridge_cfb_nfl_player') is not null then 'ok' else 'CHECK THIS' end as status
union all select 2, 'quotes are append-only for every role (update, delete and truncate refused)',
  case when (select count(*) from pg_trigger where tgrelid = 'props.fact_prop_quote'::regclass and tgname in ('props_quote_immutable','props_quote_no_truncate')) = 2 then 'ok' else 'CHECK THIS' end
union all select 3, 'lineage is required, never defaulted, and a reconstructed line cannot name a sportsbook provider',
  case when exists (select 1 from pg_constraint where conname = 'props_quote_lineage') and exists (select 1 from pg_constraint where conname = 'props_quote_lineage_provider')
        and (select column_default from information_schema.columns where table_schema = 'props' and table_name = 'fact_prop_quote' and column_name = 'lineage') is null then 'ok' else 'CHECK THIS' end
union all select 4, 'a backtest decision can only stand on an observed pregame quote',
  case when exists (select 1 from pg_trigger where tgname = 'props_backtest_observed') then 'ok' else 'CHECK THIS' end
union all select 5, 'features obey source_max_timestamp <= asof_at <= kickoff and are append-only',
  case when exists (select 1 from pg_constraint where conname = 'props_feature_pit') and exists (select 1 from pg_trigger where tgname = 'props_feature_pregame')
        and exists (select 1 from pg_trigger where tgname = 'props_feature_immutable') then 'ok' else 'CHECK THIS' end
union all select 6, 'predictions are immutable, pregame and name their model version',
  case when exists (select 1 from pg_trigger where tgname = 'props_prediction_immutable') and exists (select 1 from pg_trigger where tgname = 'props_prediction_pregame')
        and exists (select 1 from pg_constraint where conrelid = 'props.model_prediction'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%model_registry%') then 'ok' else 'CHECK THIS' end
union all select 7, 'the record is frozen before kickoff and graded once',
  case when exists (select 1 from pg_trigger where tgname = 'props_record_freeze') then 'ok' else 'CHECK THIS' end
union all select 8, 'the catalog is seeded (27 markets, 15 quality rules, 20 folds, 18 jobs)',
  case when (select count(*) from props.prop_catalog) >= 27 and (select count(*) from props.quality_rules) = 15 and (select count(*) from props.backtest_splits) = 20
        and (select count(*) from props.pipeline_jobs) = 18 then 'ok' else 'CHECK THIS' end
union all select 9, 'provider labels map to canonical markets (player_pass_yds -> pass_yards)',
  case when (select market_key from props.provider_market_map where provider = 'the-odds-api' and provider_market_key = 'player_pass_yds') = 'pass_yards' then 'ok' else 'CHECK THIS' end
union all select 10, 'the distribution arithmetic prices a line (dist_probs)',
  case when (select round(p_over, 4) from props.dist_probs('{"t":"bern","p":0.4}'::jsonb, null)) = 0.4
        and (select round(p_push, 4) from props.dist_probs('{"t":"pmf","v":[0.2,0.3,0.5],"tail":0}'::jsonb, 1)) = 0.3 then 'ok' else 'CHECK THIS' end
union all select 11, 'staging, raw payloads, features, quarantine and corrections are private',
  case when not has_table_privilege('anon', 'props.stg_player_game', 'SELECT') and not has_table_privilege('authenticated', 'props.raw_odds_payloads', 'SELECT')
        and not has_table_privilege('authenticated', 'props.fact_feature_snapshot', 'SELECT') and not has_table_privilege('authenticated', 'props.quarantine', 'SELECT')
        and not has_table_privilege('anon', 'props.fact_corrections', 'SELECT') then 'ok' else 'CHECK THIS' end
union all select 12, 'the website board view and the AI doors exist',
  case when to_regclass('props.v_player_props_board') is not null and to_regprocedure('props.ai_prop_context(text,text,text)') is not null
        and to_regprocedure('props.ai_data_health()') is not null then 'ok' else 'CHECK THIS' end
union all select 13, 'every quality rule has a query',
  case when (select count(*) from props.run_quality_checks()) = 15 then 'ok' else 'CHECK THIS' end
union all select 14, 'the ingestion doors belong to the service role only',
  case when not has_function_privilege('anon', 'props.ingest_prop_quotes(jsonb,text)', 'EXECUTE') and not has_function_privilege('authenticated', 'props.ingest_prop_quotes(jsonb,text)', 'EXECUTE')
        and has_function_privilege('service_role', 'props.ingest_prop_quotes(jsonb,text)', 'EXECUTE') then 'ok' else 'CHECK THIS' end
)
select row, guarantee, status from checks order by row;

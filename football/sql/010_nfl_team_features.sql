-- ============================================================================
-- football/sql/010_nfl_team_features.sql   (idempotent — safe to re-run)
--
-- The feature table model_predict's nfl_game_v1 is already coded against:
-- its loadContext() reads public.nfl_team_features and runs the moment the
-- required columns (off_epa_play, def_epa_play, plays_per_game) hold rows.
-- Populated by the ingest_nfl_features Edge Function
-- (supabase/functions/ingest_nfl_features/index.ts) from nflverse public data
-- using the trained opponent-adjusted ratings in football/params.js.
--
-- team_norm is the PRIMARY KEY and is the normalized FULL team name
-- ("kansascitychiefs") — exactly what nfl_game_v1's nrm(home_team) computes
-- from the captured market, so the join needs no mapping table.
--
-- RLS is ENABLED with no policies: only the service role (the Edge Functions)
-- can read or write. Nothing in the browser needs this table — the app's
-- Football research module computes its own ratings client-side from the same
-- public sources.
-- ============================================================================

create table if not exists public.nfl_team_features (
  team_norm          text primary key,
  team               text not null,
  team_code          text not null,
  season             integer not null,
  games_absorbed     integer not null default 0,

  -- REQUIRED by nfl_game_v1 (levels: league mean + opponent-adjusted deviation)
  off_epa_play       double precision not null,
  def_epa_play       double precision not null,   -- EPA per play ALLOWED
  plays_per_game     double precision not null,

  -- optional columns nfl_game_v1 reports on when present
  off_pass_epa_play  double precision,
  off_rush_epa_play  double precision,
  def_pass_epa_play  double precision,
  def_rush_epa_play  double precision,
  sack_rate          double precision,            -- sacks MADE per opp dropback
  sack_rate_allowed  double precision,
  explosive_rate     double precision,
  explosive_allowed  double precision,
  points_for_pg      double precision,
  points_against_pg  double precision,

  -- provenance (mandatory: every number must be traceable)
  ratings_source     text not null,
  model_version      text not null,
  feature_version    text not null,
  updated_at         timestamptz not null default now()
);

alter table public.nfl_team_features enable row level security;

comment on table public.nfl_team_features is
  'NFL team features for model_predict/nfl_game_v1. Written by the '
  'ingest_nfl_features Edge Function from nflverse public data via the '
  'EdgeDesk Football Engine ratings (football/engine.js + football/params.js; '
  'walk-forward trained 1999-2025 — see football/research/report/BACKTEST.md). '
  'Current state, refreshed each run; NOT a frozen snapshot table.';

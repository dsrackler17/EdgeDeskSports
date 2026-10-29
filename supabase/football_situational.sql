-- =============================================================================
-- football_situational — the Football Situational Intelligence Engine's
-- durable store (football/situational/README.md).
--
-- WHAT IT ADDS (all prefixed fsie_)
--   1. fsie_source_files        every source file version the engine read:
--                               URL, sha256, size, Last-Modified, pulled_at.
--   2. fsie_team_games          one normalized situational observation per team
--                               per game per SOURCE VERSION (a later revision of
--                               a game is a new row; nothing is overwritten),
--                               with its quality status and rejection reasons.
--   3. fsie_quality_failures    every failed source / game / team check.
--   4. fsie_coverage            the per-team coverage inventory of each run.
--   5. fsie_tendencies          point-in-time tendency snapshots.
--   6. fsie_team_projections    experimental team volume projections (P10/P50/P90).
--   7. fsie_player_projections  experimental player opportunity projections.
--   8. fsie_prop_comparisons    model vs market (projection disagreement unless a
--                               calibrated probability exists).
--   9. fsie_clv_evaluations     closing-line value per comparison, with the
--                               exclusion reason when no close exists.
--  10. fsie_shadow_integrations what the situational layer would have done to an
--                               existing model's output, and what it did (0).
--  11. fsie_pipeline_runs       stage, duration, status, freshness per run.
--  12. View fsie_team_games_current: the latest source version of each team-game.
--  13. fsie_prune(): retention for the operational tables only.
--
-- Projections, comparisons, CLV, shadow rows and team-game observations are
-- WRITE-ONCE (an update or delete raises). Market snapshots are NOT duplicated
-- here: the props pipeline's player_prop_ledger_quotes (supabase/player_props.sql)
-- is the line history; a comparison names the quote time it read.
-- Readers (authenticated) read; only the service role writes. anon reads nothing.
--
-- DEPENDS ON nothing. CONVENTION (supabase/README.md): idempotent, additive,
-- no psql meta-commands, ends in a report. Safe to run again.
-- Rollback: supabase/football_situational_rollback.sql.
-- =============================================================================

-- 1. SOURCE FILES ---------------------------------------------------------------
create table if not exists public.fsie_source_files (
  sport text not null check (sport in ('nfl', 'cfb')),
  season int not null,
  source_name text not null,
  url text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint,
  last_modified text,
  pulled_at timestamptz not null,
  schema_ok boolean not null default true,
  missing_columns text[] not null default '{}',
  recorded_at timestamptz not null default now(),
  primary key (sport, source_name, sha256)
);

-- 2. TEAM-GAME OBSERVATIONS -------------------------------------------------------
create table if not exists public.fsie_team_games (
  sport text not null check (sport in ('nfl', 'cfb')),
  season int not null,
  week int not null,
  season_type text not null,
  game_id text not null,
  team_id text not null,
  opponent_id text not null,
  is_home boolean,
  kickoff_at timestamptz,
  source_name text not null,
  source_ref text not null,
  source_sha256 text,
  pulled_at timestamptz,
  available_at timestamptz,
  situations_version text not null,
  quality_version text not null,
  fingerprint text,
  volume_ok boolean not null,
  situation_ok boolean not null,
  player_ok boolean not null,
  quality_status text not null check (quality_status in ('accepted', 'partial', 'rejected')),
  rejection_reasons text[] not null default '{}',
  warnings text[] not null default '{}',
  counts jsonb not null,
  situations jsonb,
  scripts jsonb,
  pace jsonb,
  formation jsonb,
  market jsonb,
  ingested_at timestamptz not null default now(),
  constraint fsie_team_games_identity unique (sport, game_id, team_id, source_ref),
  constraint fsie_team_games_ok_implies check ((not situation_ok or volume_ok) and (not player_ok or volume_ok))
);
create index if not exists fsie_team_games_lookup on public.fsie_team_games (sport, season, week);
create index if not exists fsie_team_games_team on public.fsie_team_games (sport, team_id, kickoff_at desc);

-- 3. QUALITY FAILURES ---------------------------------------------------------------
create table if not exists public.fsie_quality_failures (
  sport text not null check (sport in ('nfl', 'cfb')),
  season int not null,
  game_id text not null default '',
  team_id text not null default '',
  scope text not null check (scope in ('source', 'game', 'team', 'play')),
  check_name text not null,
  detail text,
  source_ref text not null,
  run_id text,
  detected_at timestamptz not null default now(),
  primary key (sport, game_id, team_id, scope, check_name, source_ref)
);

-- 4. COVERAGE -------------------------------------------------------------------------
create table if not exists public.fsie_coverage (
  run_id text not null,
  sport text not null check (sport in ('nfl', 'cfb')),
  season int not null,
  team_id text not null,
  team_name text,
  conference text,
  division text,
  tier text not null check (tier in ('A', 'B', 'C', 'D')),
  games_expected int not null,
  games_available int not null,
  games_accepted int not null,
  games_rejected int not null,
  formation_observed_share numeric,
  last_game_at timestamptz,
  missing_fields text[] not null default '{}',
  built_at timestamptz not null,
  primary key (run_id, sport, team_id)
);
create index if not exists fsie_coverage_latest on public.fsie_coverage (sport, season, built_at desc);

-- 5. TENDENCIES -------------------------------------------------------------------------
create table if not exists public.fsie_tendencies (
  sport text not null check (sport in ('nfl', 'cfb')),
  season int not null,
  team_id text not null,
  side text not null check (side in ('offense', 'defense')),
  as_of timestamptz not null,
  features_version text not null,
  situations_version text not null,
  metrics jsonb not null,
  sample jsonb,
  built_at timestamptz not null default now(),
  primary key (sport, season, team_id, side, as_of, features_version)
);

-- 6. TEAM PROJECTIONS (write-once, pregame) ---------------------------------------------
create table if not exists public.fsie_team_projections (
  projection_id text primary key,
  sport text not null check (sport in ('nfl', 'cfb')),
  season int not null,
  week int not null,
  game_id text not null,
  team_id text not null,
  opponent_id text not null,
  model_key text not null,
  model_version text not null,
  as_of timestamptz not null,
  kickoff_at timestamptz,
  point jsonb not null,
  p10 jsonb not null,
  p50 jsonb not null,
  p90 jsonb not null,
  script jsonb,
  inputs_sha256 text,
  data_quality text not null,
  missing_reasons text[] not null default '{}',
  experimental boolean not null default true check (experimental),
  created_at timestamptz not null default now(),
  constraint fsie_team_projections_identity unique (sport, game_id, team_id, model_version, as_of),
  constraint fsie_team_projections_pregame check (kickoff_at is null or as_of < kickoff_at)
);
create index if not exists fsie_team_projections_game on public.fsie_team_projections (sport, game_id);

-- 7. PLAYER PROJECTIONS (write-once, pregame) ---------------------------------------------
create table if not exists public.fsie_player_projections (
  projection_id text primary key,
  sport text not null check (sport in ('nfl', 'cfb')),
  game_id text not null,
  team_id text not null,
  player_id text not null,
  player_name text,
  role text,
  market text not null check (market in ('pass_att', 'rush_att', 'targets', 'receptions')),
  model_version text not null,
  as_of timestamptz not null,
  kickoff_at timestamptz,
  mean numeric not null,
  p10 numeric not null,
  p50 numeric not null,
  p90 numeric not null,
  share numeric,
  availability text,
  experimental boolean not null default true check (experimental),
  created_at timestamptz not null default now(),
  constraint fsie_player_projections_identity unique (sport, game_id, player_id, market, model_version, as_of),
  constraint fsie_player_projections_pregame check (kickoff_at is null or as_of < kickoff_at),
  constraint fsie_player_projections_order check (p10 <= p50 and p50 <= p90)
);
create index if not exists fsie_player_projections_game on public.fsie_player_projections (sport, game_id);

-- 8. PROP COMPARISONS (write-once) -------------------------------------------------------
create table if not exists public.fsie_prop_comparisons (
  comparison_id text primary key,
  sport text not null check (sport in ('nfl', 'cfb')),
  game_id text not null,
  event_id text,
  player_id text not null,
  player_name text,
  market text not null check (market in ('pass_att', 'rush_att', 'receptions')),
  model_version text not null,
  model_as_of timestamptz not null,
  model_median numeric not null,
  model_p10 numeric,
  model_p90 numeric,
  market_line numeric not null check (market_line * 2 = round(market_line * 2)),
  market_over int,
  market_under int,
  market_books int,
  market_at timestamptz not null,
  difference numeric not null,
  p_over numeric check (p_over is null or (p_over >= 0 and p_over <= 1)),
  label text not null check (label in ('projection_disagreement', 'calibrated_probability')),
  data_quality text not null,
  experimental boolean not null default true check (experimental),
  created_at timestamptz not null default now()
);
create index if not exists fsie_prop_comparisons_game on public.fsie_prop_comparisons (sport, game_id);

-- 9. CLV (write-once; a missing close is recorded, never guessed) -------------------------
create table if not exists public.fsie_clv_evaluations (
  clv_id text primary key,
  comparison_id text,
  sport text not null check (sport in ('nfl', 'cfb')),
  game_id text not null,
  player_id text not null,
  market text not null,
  direction text not null check (direction in ('over', 'under')),
  entry_line numeric not null,
  entry_price int,
  entry_at timestamptz not null,
  model_as_of timestamptz not null,
  close_available boolean not null,
  close_line numeric,
  close_price int,
  close_at timestamptz,
  line_clv numeric,
  price_clv_cents numeric,
  prob_clv_pp numeric,
  beat_close boolean,
  exclusion_reason text,
  outcome_value numeric,
  outcome_result text check (outcome_result is null or outcome_result in ('WIN', 'LOSS', 'PUSH', 'VOID')),
  graded_at timestamptz not null default now(),
  constraint fsie_clv_close_or_reason check (close_available or exclusion_reason is not null),
  constraint fsie_clv_timestamps check (model_as_of <= entry_at and (close_at is null or entry_at <= close_at))
);

-- 10. SHADOW INTEGRATIONS (write-once; nothing applied unless ACTIVE) ----------------------
create table if not exists public.fsie_shadow_integrations (
  sport text not null check (sport in ('nfl', 'cfb')),
  game_id text not null,
  target text not null check (target in ('nfl_slate', 'fbs_slate', 'nfl_simulator', 'cfb_simulator')),
  mode text not null check (mode in ('OFF', 'SHADOW', 'ACTIVE')),
  model_version text not null,
  as_of timestamptz not null,
  existing jsonb not null,
  situational jsonb,
  candidate jsonb,
  applied_points numeric not null default 0,
  created_at timestamptz not null default now(),
  primary key (sport, game_id, target, model_version, as_of),
  constraint fsie_shadow_nothing_applied_unless_active check (applied_points = 0 or mode = 'ACTIVE')
);

-- 11. PIPELINE RUNS ------------------------------------------------------------------------
create table if not exists public.fsie_pipeline_runs (
  run_id text not null,
  sport text not null check (sport in ('nfl', 'cfb', 'all')),
  stage text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms int,
  status text not null check (status in ('ok', 'partial', 'failed', 'skipped')),
  rows_in int,
  rows_out int,
  errors jsonb not null default '[]'::jsonb,
  freshness jsonb,
  primary key (run_id, sport, stage)
);

-- 12. WRITE-ONCE --------------------------------------------------------------------------
create or replace function public.fsie_frozen() returns trigger language plpgsql as $$
begin raise exception '% is write-once and never deleted', tg_table_name using errcode = 'restrict_violation'; end $$;
do $frozen$
declare t text;
begin
  foreach t in array array['fsie_team_games', 'fsie_team_projections', 'fsie_player_projections', 'fsie_prop_comparisons', 'fsie_clv_evaluations', 'fsie_shadow_integrations', 'fsie_source_files'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_frozen_trg', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.fsie_frozen()', t || '_frozen_trg', t);
  end loop;
end $frozen$;

-- 13. ACCESS: signed-in readers read; only the service role writes -------------------------
do $rls$
declare t text;
begin
  foreach t in array array['fsie_source_files', 'fsie_team_games', 'fsie_quality_failures', 'fsie_coverage', 'fsie_tendencies', 'fsie_team_projections', 'fsie_player_projections', 'fsie_prop_comparisons', 'fsie_clv_evaluations', 'fsie_shadow_integrations', 'fsie_pipeline_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $rls$;

-- 14. CURRENT VIEW ------------------------------------------------------------------------
create or replace view public.fsie_team_games_current with (security_invoker = true) as
select distinct on (sport, game_id, team_id) *
from public.fsie_team_games
order by sport, game_id, team_id, ingested_at desc, source_ref desc;
revoke all on public.fsie_team_games_current from anon;
grant select on public.fsie_team_games_current to authenticated;

-- 15. RETENTION: operational tables only. Observations, projections, comparisons,
-- CLV and shadow rows are never pruned.
create or replace function public.fsie_prune(keep_days int default 400) returns table (pruned_table text, rows_deleted bigint)
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if keep_days < 120 then raise exception 'fsie_prune keeps at least 120 days'; end if;
  delete from public.fsie_pipeline_runs where started_at < now() - make_interval(days => keep_days);
  get diagnostics n = row_count; pruned_table := 'fsie_pipeline_runs'; rows_deleted := n; return next;
  delete from public.fsie_quality_failures where detected_at < now() - make_interval(days => keep_days);
  get diagnostics n = row_count; pruned_table := 'fsie_quality_failures'; rows_deleted := n; return next;
  delete from public.fsie_coverage c where c.built_at < now() - make_interval(days => keep_days)
    and c.run_id not in (select distinct on (sport, season) run_id from public.fsie_coverage order by sport, season, built_at desc);
  get diagnostics n = row_count; pruned_table := 'fsie_coverage'; rows_deleted := n; return next;
end $$;
revoke all on function public.fsie_prune(int) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'fsie tables (11)' as piece, case when (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('fsie_source_files', 'fsie_team_games', 'fsie_quality_failures', 'fsie_coverage', 'fsie_tendencies', 'fsie_team_projections', 'fsie_player_projections', 'fsie_prop_comparisons', 'fsie_clv_evaluations', 'fsie_shadow_integrations', 'fsie_pipeline_runs')) = 11 then 'ok' else 'CHECK THIS' end as state
  union all select 'write-once triggers (7)', case when (select count(*) from pg_trigger where tgname ~ '^fsie_.*_frozen_trg$') = 7 then 'ok' else 'CHECK THIS' end
  union all select 'RLS on every fsie table', case when (select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'fsie\_%') then 'ok' else 'CHECK THIS' end
  union all select 'pregame checks on projections', case when exists (select 1 from pg_constraint where conname = 'fsie_team_projections_pregame') and exists (select 1 from pg_constraint where conname = 'fsie_player_projections_pregame') then 'ok' else 'CHECK THIS' end
  union all select 'shadow rows cannot apply points unless ACTIVE', case when exists (select 1 from pg_constraint where conname = 'fsie_shadow_nothing_applied_unless_active') then 'ok' else 'CHECK THIS' end
  union all select 'CLV: a close or an exclusion reason', case when exists (select 1 from pg_constraint where conname = 'fsie_clv_close_or_reason') then 'ok' else 'CHECK THIS' end
  union all select 'current view', case when to_regclass('public.fsie_team_games_current') is not null then 'ok' else 'CHECK THIS' end
  union all select 'retention function', case when exists (select 1 from pg_proc where proname = 'fsie_prune') then 'ok' else 'CHECK THIS' end
) r order by 1;

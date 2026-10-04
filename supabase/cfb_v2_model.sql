-- =============================================================================
-- cfb_v2_model — the auditable store behind the CFB V2 prediction engine.
--
-- WHAT IT IS
--   Every table the V2 engine needs to make a prediction reproducible:
--   the model version, the frozen weekly team features, the frozen game
--   feature snapshot, each submodel's prediction before stacking, the pure
--   projection and its intervals, the SEPARATE market decision, market
--   snapshots, player availability as reported, backtest runs, calibration
--   tables and weekly monitoring.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Pregame records are WRITE ONCE and NEVER DELETED (triggers). A
--      correction is a new model_version or a new prediction_ts, never an edit.
--   2. No look-ahead: a prediction's prediction_ts and feature_ts must precede
--      kickoff; a market decision must be made before kickoff (triggers).
--   3. The pure projection and the market decision are different tables. The
--      pure table has no market column; a market column cannot be added to it
--      by accident because nothing writes one there.
--   4. Sign convention: *_margin columns are HOME margin (+ = home favoured);
--      *_home_line columns are BOOK convention (-7 = home laying 7).
--      cfb_market_snapshots derives home_margin from home_line in the database
--      (a generated column), so the conversion exists in exactly one place.
--   5. Additive and backwards compatible: nothing here touches V1 tables.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

-- ------------------------------------------------------------ shared triggers
create or replace function public.cfb_v2_write_once()
returns trigger language plpgsql as $$
begin
  raise exception '% is write-once: rows cannot be updated', tg_table_name
    using errcode = 'restrict_violation';
end $$;

create or replace function public.cfb_v2_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception '% rows are never deleted', tg_table_name
    using errcode = 'restrict_violation';
end $$;

create or replace function public.cfb_v2_pregame()
returns trigger language plpgsql as $$
begin
  if new.prediction_ts >= new.kickoff_ts then
    raise exception '%: prediction_ts % is not before kickoff %', tg_table_name, new.prediction_ts, new.kickoff_ts
      using errcode = 'check_violation';
  end if;
  if new.feature_ts > new.prediction_ts then
    raise exception '%: feature_ts % is after prediction_ts %', tg_table_name, new.feature_ts, new.prediction_ts
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------- model versions
create table if not exists public.cfb_model_versions (
  model_version       text primary key,
  feature_version     text not null,
  trained_through     int not null,
  created_at          timestamptz not null default now(),
  code_commit         text,
  artifacts_path      text,
  params              jsonb not null default '{}'::jsonb,
  validation          jsonb not null default '{}'::jsonb,
  promotion_decision  text check (promotion_decision in ('ELIGIBLE_FOR_PROMOTION','KEEP_V1','PROMOTED','RETIRED')),
  is_champion         boolean not null default false,
  is_shadow           boolean not null default true,
  notes               text
);
comment on table public.cfb_model_versions is
  'Every CFB model version: parameters, validation record and promotion decision. Only is_champion/is_shadow/promotion_decision/notes may change (by a person).';

create or replace function public.cfb_v2_versions_guard()
returns trigger language plpgsql as $$
begin
  if new.model_version is distinct from old.model_version or new.feature_version is distinct from old.feature_version
     or new.trained_through is distinct from old.trained_through or new.params is distinct from old.params
     or new.validation is distinct from old.validation or new.created_at is distinct from old.created_at then
    raise exception 'cfb_model_versions: only is_champion, is_shadow, promotion_decision and notes may change'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists cfb_versions_guard_trg on public.cfb_model_versions;
create trigger cfb_versions_guard_trg before update on public.cfb_model_versions
  for each row execute function public.cfb_v2_versions_guard();
create unique index if not exists cfb_versions_one_champion on public.cfb_model_versions (is_champion) where is_champion;

-- -------------------------------------------------------- weekly team features
create table if not exists public.cfb_team_week_features (
  season          int not null,
  prediction_ts   timestamptz not null,
  team_id         bigint not null,
  metric          text not null,
  feature_version text not null,
  off             double precision, def double precision,
  off_var         double precision, def_var double precision,
  off_rec         double precision, def_rec double precision,
  prior_off       double precision, prior_def double precision,
  l4_off          double precision, l4_def double precision,
  l2_off          double precision, l2_def double precision,
  vol             double precision,
  n_obs           double precision, n_eff double precision,
  created_at      timestamptz not null default now(),
  primary key (season, prediction_ts, team_id, metric, feature_version)
);
create index if not exists cfb_twf_team_idx on public.cfb_team_week_features (team_id, season, prediction_ts);

create table if not exists public.cfb_team_ratings (
  season          int not null,
  prediction_ts   timestamptz not null,
  team_id         bigint not null,
  model_version   text not null references public.cfb_model_versions(model_version),
  off_epa         double precision, def_epa double precision,
  off_pass_epa    double precision, def_pass_epa double precision,
  off_rush_epa    double precision, def_rush_epa double precision,
  st_net          double precision, elo double precision,
  qb_exp_rating   double precision,
  games_played    int,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  primary key (season, prediction_ts, team_id, model_version)
);
create index if not exists cfb_ratings_team_idx on public.cfb_team_ratings (team_id, season);

-- --------------------------------------------------------- availability (as reported)
create table if not exists public.cfb_player_availability (
  id                  bigint generated always as identity primary key,
  season              int not null,
  game_id             bigint,
  team_id             bigint not null,
  player_id           bigint,
  player_name         text,
  position            text,
  unit                text check (unit in ('QB','OL','SKILL','FRONT7','SECONDARY','ST')),
  usage_share         double precision check (usage_share between 0 and 1),
  status              text check (status in ('CONFIRMED','ACTIVE','PROBABLE','QUESTIONABLE','GTD','DOUBTFUL','OUT','UNKNOWN')),
  source              text not null,
  source_published_at timestamptz,
  observed_at         timestamptz not null,
  created_at          timestamptz not null default now()
);
create index if not exists cfb_avail_game_idx on public.cfb_player_availability (game_id, team_id, observed_at);

-- --------------------------------------------------------------- market snapshots
create table if not exists public.cfb_market_snapshots (
  id            bigint generated always as identity primary key,
  game_id       bigint not null,
  captured_at   timestamptz not null,
  book          text not null,
  home_line     numeric,                                   -- BOOK convention
  home_margin   numeric generated always as (-home_line) stored,  -- INTERNAL, the one conversion
  price_home    numeric, price_away numeric,
  total         numeric,
  is_open       boolean not null default false,
  is_close      boolean not null default false,
  source        text not null,
  unique (game_id, book, captured_at)
);
create index if not exists cfb_mkt_game_idx on public.cfb_market_snapshots (game_id, captured_at);

-- ----------------------------------------------------- frozen game feature snapshot
create table if not exists public.cfb_game_feature_snapshots (
  game_id           bigint not null,
  prediction_ts     timestamptz not null,
  feature_version   text not null,
  season            int not null,
  week              int,
  kickoff_ts        timestamptz not null,
  feature_ts        timestamptz not null,
  home_team_id      bigint not null,
  away_team_id      bigint not null,
  neutral_site      boolean not null,
  features          jsonb not null,
  source_timestamps jsonb not null default '{}'::jsonb,
  snapshot_hash     text not null,
  created_at        timestamptz not null default now(),
  primary key (game_id, prediction_ts, feature_version)
);

-- the training export the data pack names; outcomes live in their own columns and
-- are filled only after the game (never read as features)
create table if not exists public.cfb_model_training_snapshots (
  game_id          bigint not null,
  prediction_ts    timestamptz not null,
  feature_version  text not null,
  season           int not null,
  week             int,
  features         jsonb not null,
  sample_quality   jsonb not null default '{}'::jsonb,
  final_home_points int, final_away_points int,
  created_at       timestamptz not null default now(),
  primary key (game_id, prediction_ts, feature_version)
);
create table if not exists public.cfb_market_training_snapshots (
  game_id          bigint not null,
  prediction_ts    timestamptz not null,
  open_margin      numeric, close_margin numeric,        -- close is EVALUATION ONLY
  total_open       numeric, total_close numeric,
  books            int, source text,
  created_at       timestamptz not null default now(),
  primary key (game_id, prediction_ts)
);

-- -------------------------------------------- component predictions (before stacking)
create table if not exists public.cfb_model_component_predictions (
  game_id          bigint not null,
  prediction_ts    timestamptz not null,
  model_version    text not null,
  component        text not null check (component in ('A_adj_eff','B_elo','C_ridge','D_gbm','E_drive','total')),
  predicted        double precision not null,
  stack_weight     double precision,
  created_at       timestamptz not null default now(),
  primary key (game_id, prediction_ts, model_version, component)
);

-- -------------------------------------------------- the PURE model projection
create table if not exists public.cfb_predictions (
  game_id            bigint not null,
  prediction_ts      timestamptz not null,
  model_version      text not null,
  feature_version    text not null,
  season             int not null,
  week               int,
  kickoff_ts         timestamptz not null,
  feature_ts         timestamptz not null,
  home_team_id       bigint not null,
  away_team_id       bigint not null,
  neutral_site       boolean not null,
  projected_margin   double precision not null,             -- + = home
  fair_home_line     double precision not null,             -- BOOK convention (= -projected_margin)
  fair_total         double precision,
  home_win_prob      double precision not null check (home_win_prob > 0 and home_win_prob < 1),
  sigma              double precision not null check (sigma > 0),
  t_df               int,
  ensemble_sd        double precision,
  football_prediction_confidence int check (football_prediction_confidence between 0 and 100),
  drivers            jsonb not null default '[]'::jsonb,
  uncertainty_drivers jsonb not null default '[]'::jsonb,
  stack_weights      jsonb not null default '{}'::jsonb,
  source_timestamps  jsonb not null default '{}'::jsonb,
  snapshot_hash      text not null,
  created_at         timestamptz not null default now(),
  primary key (game_id, prediction_ts, model_version),
  check (abs(fair_home_line + projected_margin) < 1e-6)
);
create index if not exists cfb_pred_season_idx on public.cfb_predictions (season, week);

create table if not exists public.cfb_prediction_intervals (
  game_id        bigint not null,
  prediction_ts  timestamptz not null,
  model_version  text not null,
  level          numeric not null check (level in (0.5, 0.8, 0.95)),
  lo             double precision not null,
  hi             double precision not null check (hi >= lo),
  primary key (game_id, prediction_ts, model_version, level),
  foreign key (game_id, prediction_ts, model_version)
    references public.cfb_predictions (game_id, prediction_ts, model_version)
);

-- --------------------------------------------------- the MARKET decision (separate)
create table if not exists public.cfb_market_decisions (
  id                     bigint generated always as identity primary key,
  game_id                bigint not null,
  prediction_ts          timestamptz not null,
  model_version          text not null,
  decided_at             timestamptz not null,
  kickoff_ts             timestamptz not null,
  book                   text,
  current_home_line      numeric,
  current_market_margin  numeric,
  open_home_line         numeric,
  pure_fair_margin       double precision not null,
  raw_gap_pts            double precision,
  side                   text check (side in ('HOME','AWAY')),
  cover_probability_raw  double precision,
  cover_probability      double precision,
  price_american         numeric,
  break_even_probability double precision,
  expected_value_per_unit double precision,
  clv_opportunity_pts    double precision,
  market_dispersion_iqr  double precision,
  edge_reliability       int,
  betting_edge_strength  int,
  status                 text not null check (status in ('BET','LEAN','REVIEW','PASS')),
  reasons                jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  foreign key (game_id, prediction_ts, model_version)
    references public.cfb_predictions (game_id, prediction_ts, model_version)
);
create index if not exists cfb_dec_game_idx on public.cfb_market_decisions (game_id, decided_at);

create or replace function public.cfb_v2_decision_pregame()
returns trigger language plpgsql as $$
begin
  if new.decided_at >= new.kickoff_ts then
    raise exception 'cfb_market_decisions: decided_at % is not before kickoff %', new.decided_at, new.kickoff_ts
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ backtests
create table if not exists public.cfb_backtest_runs (
  run_id        text primary key,
  model_version text not null,
  created_at    timestamptz not null default now(),
  code_commit   text,
  config        jsonb not null,
  windows       jsonb not null,
  summary       jsonb not null
);
create table if not exists public.cfb_backtest_predictions (
  run_id        text not null references public.cfb_backtest_runs(run_id),
  game_id       bigint not null,
  season        int not null,
  week          int,
  prediction_ts timestamptz not null,
  components    jsonb not null,
  ens_pred      double precision, sigma double precision, home_win_prob double precision,
  lo_80         double precision, hi_80 double precision,
  open_margin   numeric, close_margin numeric, final_margin int,
  reliability   double precision, ev double precision, status text,
  primary key (run_id, game_id)
);
create table if not exists public.cfb_calibration_results (
  run_id        text not null references public.cfb_backtest_runs(run_id),
  target        text not null check (target in ('win','cover','interval')),
  window_name   text not null,
  bin           text not null,
  n             int not null,
  mean_pred     double precision,
  observed      double precision,
  primary key (run_id, target, window_name, bin)
);

-- --------------------------------------------------- weekly learning + monitoring
create table if not exists public.cfb_model_monitoring (
  id            bigint generated always as identity primary key,
  model_version text not null,
  season        int not null,
  week          int,
  computed_at   timestamptz not null default now(),
  metrics       jsonb not null,
  alerts        jsonb not null default '[]'::jsonb
);
create table if not exists public.cfb_prediction_misses (
  game_id        bigint not null,
  model_version  text not null,
  prediction_ts  timestamptz not null,
  abs_error      double precision not null,
  classification text not null check (classification in (
    'bad_team_rating','qb_injury_miss','matchup_interaction','opponent_adjustment',
    'explosive_variance','turnover_variance','special_teams','garbage_time',
    'weather','market_news_unavailable','ordinary_variance')),
  evidence       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  primary key (game_id, model_version)
);

create table if not exists public.cfb_data_dictionary (
  column_name        text not null,
  feature_version    text not null,
  layer              text not null check (layer in ('context','pure','market','evaluation','target','unknown')),
  definition         text,
  source             text,
  transform          text,
  update_cadence     text,
  null_policy        text,
  primary key (column_name, feature_version)
);

-- ------------------------------------------------ immutability wiring (idempotent)
do $$
declare t text;
begin
  foreach t in array array['cfb_team_week_features','cfb_team_ratings','cfb_player_availability',
    'cfb_market_snapshots','cfb_game_feature_snapshots','cfb_model_training_snapshots',
    'cfb_market_training_snapshots','cfb_model_component_predictions','cfb_predictions',
    'cfb_prediction_intervals','cfb_market_decisions','cfb_backtest_runs','cfb_backtest_predictions',
    'cfb_calibration_results','cfb_prediction_misses']
  loop
    if t <> 'cfb_model_training_snapshots' then
      execute format('drop trigger if exists %I on public.%I', t || '_write_once_trg', t);
      execute format('create trigger %I before update on public.%I for each row execute function public.cfb_v2_write_once()', t || '_write_once_trg', t);
    end if;
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_v2_no_delete()', t || '_no_delete_trg', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- training snapshots: features are frozen; only the outcome columns may be filled, once
create or replace function public.cfb_v2_training_outcome_only()
returns trigger language plpgsql as $$
begin
  if new.features is distinct from old.features or new.prediction_ts is distinct from old.prediction_ts
     or new.sample_quality is distinct from old.sample_quality
     or (old.final_home_points is not null and new.final_home_points is distinct from old.final_home_points)
     or (old.final_away_points is not null and new.final_away_points is distinct from old.final_away_points) then
    raise exception 'cfb_model_training_snapshots: features are frozen; outcomes may be filled once'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists cfb_training_outcome_trg on public.cfb_model_training_snapshots;
create trigger cfb_training_outcome_trg before update on public.cfb_model_training_snapshots
  for each row execute function public.cfb_v2_training_outcome_only();

drop trigger if exists cfb_predictions_pregame_trg on public.cfb_predictions;
create trigger cfb_predictions_pregame_trg before insert on public.cfb_predictions
  for each row execute function public.cfb_v2_pregame();
drop trigger if exists cfb_gfs_pregame_trg on public.cfb_game_feature_snapshots;
create trigger cfb_gfs_pregame_trg before insert on public.cfb_game_feature_snapshots
  for each row execute function public.cfb_v2_pregame();
drop trigger if exists cfb_decisions_pregame_trg on public.cfb_market_decisions;
create trigger cfb_decisions_pregame_trg before insert on public.cfb_market_decisions
  for each row execute function public.cfb_v2_decision_pregame();

alter table public.cfb_model_versions enable row level security;
alter table public.cfb_model_monitoring enable row level security;
alter table public.cfb_data_dictionary enable row level security;

-- read access: predictions, decisions, versions, monitoring and the dictionary are
-- EdgeDesk's own outputs (no user data) and readable by every signed-in reader.
-- Writes come only from the service role (the weekly job), which bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['cfb_model_versions','cfb_predictions','cfb_prediction_intervals',
    'cfb_market_decisions','cfb_model_component_predictions','cfb_model_monitoring','cfb_data_dictionary',
    'cfb_team_ratings']
  loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_read') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------------- report
select 'table ' || t as check_name,
       case when to_regclass('public.' || t) is not null then 'ok' else 'CHECK THIS' end as status
  from unnest(array['cfb_model_versions','cfb_team_week_features','cfb_team_ratings','cfb_player_availability',
    'cfb_market_snapshots','cfb_game_feature_snapshots','cfb_model_training_snapshots',
    'cfb_market_training_snapshots','cfb_model_component_predictions','cfb_predictions',
    'cfb_prediction_intervals','cfb_market_decisions','cfb_backtest_runs','cfb_backtest_predictions',
    'cfb_calibration_results','cfb_model_monitoring','cfb_prediction_misses','cfb_data_dictionary']) t
union all
select 'write-once trigger on cfb_predictions',
       case when exists (select 1 from pg_trigger where tgname = 'cfb_predictions_write_once_trg') then 'ok' else 'CHECK THIS' end
union all
select 'pregame trigger on cfb_predictions',
       case when exists (select 1 from pg_trigger where tgname = 'cfb_predictions_pregame_trg') then 'ok' else 'CHECK THIS' end
union all
select 'pregame trigger on cfb_market_decisions',
       case when exists (select 1 from pg_trigger where tgname = 'cfb_decisions_pregame_trg') then 'ok' else 'CHECK THIS' end
union all
select 'market margin is the negated book line',
       case when (select generation_expression from information_schema.columns
                   where table_schema = 'public' and table_name = 'cfb_market_snapshots' and column_name = 'home_margin')
                 like '%home_line%' then 'ok' else 'CHECK THIS' end;

-- ============================================================================
-- EdgeDesk : 021_model_predict_multisport
--
-- Everything model_predict needs to serve six sports instead of one.
--
-- SAFETY. Every statement is additive and idempotent. No column is dropped, no
-- type is narrowed, and no existing MLB row is rewritten — historical
-- mlb_runs_v1.2_nbinom_dh rows keep working unchanged and simply carry NULL in
-- the columns added below.
--
-- THE ONE THING THAT MUST NOT CHANGE. The unique index on
-- (model_version, event_id, market, selection) is what makes the FIRST
-- prediction for a selection the immutable CLV baseline: the function upserts
-- with `Prefer: resolution=ignore-duplicates`, so a re-run hits the conflict
-- and is discarded rather than overwriting the entry snapshot. Dropping or
-- widening that index silently destroys EdgeDesk's ability to measure CLV,
-- calibration or ROI after the fact. It is created here IF NOT EXISTS because
-- v1.2 already relies on it.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. model_predictions: the audit columns
-- ---------------------------------------------------------------------------

-- Expected value on the best captured price. DELIBERATELY SEPARATE from
-- model_edge, which is a probability gap (model_prob - market_fair_prob). The
-- two answer different questions and have been conflated in enough places that
-- they get their own columns and their own comments.
alter table public.model_predictions
  add column if not exists model_ev numeric;

comment on column public.model_predictions.model_edge is
  'PROBABILITY GAP: model_prob - market_prob_at_pred, in probability points. NOT an expected value and not comparable to the MARKET engine''s edge.';
comment on column public.model_predictions.model_ev is
  'EXPECTED VALUE: model_prob * best_decimal_price - 1, as a fraction of stake. NOT the same as model_edge.';

-- What the model actually knew when it produced the row.
alter table public.model_predictions
  add column if not exists context_quality text;
alter table public.model_predictions
  add column if not exists missing_features text[];
alter table public.model_predictions
  add column if not exists data_as_of timestamptz;
alter table public.model_predictions
  add column if not exists feature_snapshot_id text;
alter table public.model_predictions
  add column if not exists model_detail jsonb;

comment on column public.model_predictions.context_quality is
  'HIGH / MEDIUM / LOW. METADATA ONLY — it never scales model_prob.';
comment on column public.model_predictions.missing_features is
  'Inputs the model wanted and did not get for THIS row.';
comment on column public.model_predictions.feature_snapshot_id is
  'Identifies the exact input set, so a probability can be traced back months later.';
comment on column public.model_predictions.model_detail is
  'Per-sport diagnostics: expected runs/points, ratings, matchup terms, simulation settings.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_predictions_context_quality_chk'
  ) then
    alter table public.model_predictions
      add constraint model_predictions_context_quality_chk
      check (context_quality is null or context_quality in ('HIGH', 'MEDIUM', 'LOW'));
  end if;

  -- A probability outside (0,1) is a bug, not a prediction. The function
  -- already refuses to build such a row; this is the backstop.
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_predictions_prob_range_chk'
  ) then
    alter table public.model_predictions
      add constraint model_predictions_prob_range_chk
      check (model_prob is null or (model_prob > 0 and model_prob < 1));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Indexes
--
-- The uniqueness rule protecting the entry snapshot, plus the paths the
-- frontend and the calibration views actually query on.
-- ---------------------------------------------------------------------------

create unique index if not exists model_predictions_identity_uidx
  on public.model_predictions (model_version, event_id, market, selection);

create index if not exists model_predictions_sport_time_idx
  on public.model_predictions (sport_key, commence_time desc);

create index if not exists model_predictions_event_idx
  on public.model_predictions (event_id);

create index if not exists model_predictions_version_market_idx
  on public.model_predictions (model_version, market, selection);

create index if not exists model_predictions_commence_idx
  on public.model_predictions (commence_time desc);

-- ---------------------------------------------------------------------------
-- 3. model_parameters — fitted coefficients and the evidence for them
--
-- The ONLY sanctioned home for a model coefficient. A row here is meaningless
-- without its metrics: n_train, n_test and the holdout score are what let a
-- reader decide whether to trust the weights. Written by
-- model_predict?calibrate=1&sport=..., read at prediction time.
-- ---------------------------------------------------------------------------

create table if not exists public.model_parameters (
  model_version text not null,
  param_set     text not null default 'default',
  params        jsonb not null,
  n_train       integer,
  n_test        integer,
  metrics       jsonb,
  fitted_at     timestamptz not null default now(),
  primary key (model_version, param_set)
);

comment on table public.model_parameters is
  'Fitted model coefficients. Every row must carry the sample size and holdout metrics that justified it. Unlike model_predictions, rows here ARE meant to be replaced by a newer fit.';

alter table public.model_parameters enable row level security;
-- No policy is created: the edge function reads and writes with the service
-- role, which bypasses RLS. Anon and authenticated see nothing, which is
-- correct — model coefficients are not customer-facing.

-- ---------------------------------------------------------------------------
-- 4. nfl_team_features — the contract nfl_game_v1 is built against
--
-- CREATED EMPTY ON PURPOSE. EdgeDesk does not currently ingest NFL efficiency
-- data from any provider, so nfl_game_v1 returns model_status =
-- insufficient_data and writes nothing until this table is populated. The
-- columns below are the model's declared contract: the three NOT NULL ones are
-- required, the rest degrade the prediction's context_quality when absent
-- rather than blocking it.
-- ---------------------------------------------------------------------------

create table if not exists public.nfl_team_features (
  team              text not null,
  team_norm         text not null,
  season            integer,
  week              integer,
  -- required
  off_epa_play      numeric not null,
  def_epa_play      numeric not null,
  plays_per_game    numeric not null,
  -- optional, opponent-adjusted where the provider supports it
  off_pass_epa_play numeric,
  off_rush_epa_play numeric,
  def_pass_epa_play numeric,
  def_rush_epa_play numeric,
  off_success_rate  numeric,
  def_success_rate  numeric,
  sack_rate         numeric,
  sack_rate_allowed numeric,
  explosive_rate    numeric,
  explosive_allowed numeric,
  points_for_pg     numeric,
  points_against_pg numeric,
  td_per_game       numeric,
  fg_per_game       numeric,
  rest_days         numeric,
  source            text,
  updated_at        timestamptz not null default now(),
  primary key (team_norm)
);

comment on table public.nfl_team_features is
  'Team efficiency inputs for nfl_game_v1. EMPTY until an NFL provider is ingested; the model returns insufficient_data rather than predicting without it. team_norm must match lower(regexp_replace(team, ''[^a-zA-Z0-9]'', '''', ''g'')) so it joins the Odds API team names.';
comment on column public.nfl_team_features.off_epa_play is
  'Expected points added per offensive play. Opponent-adjusted if the provider supports it; state which in `source`.';

alter table public.nfl_team_features enable row level security;

-- ---------------------------------------------------------------------------
-- 5. wnba_team_features — the contract wnba_game_v1 is built against
--
-- Also created empty, for the same reason. NOTE: every league baseline the
-- model uses (pace, rating, three-point rate) is computed from the rows in
-- THIS table. Populating it with NBA-derived numbers would silently make the
-- WNBA model an NBA model.
-- ---------------------------------------------------------------------------

create table if not exists public.wnba_team_features (
  team           text not null,
  team_norm      text not null,
  season         integer,
  -- required
  off_rating     numeric not null,
  def_rating     numeric not null,
  pace           numeric not null,
  -- optional four factors and shooting profile
  efg_pct        numeric,
  opp_efg_pct    numeric,
  tov_pct        numeric,
  opp_tov_pct    numeric,
  orb_pct        numeric,
  drb_pct        numeric,
  ft_rate        numeric,
  opp_ft_rate    numeric,
  three_rate     numeric,
  rest_days      numeric,
  source         text,
  updated_at     timestamptz not null default now(),
  primary key (team_norm)
);

comment on table public.wnba_team_features is
  'Team rating inputs for wnba_game_v1. EMPTY until a WNBA provider is ingested. off_rating/def_rating are points per 100 possessions; pace is possessions per game. Populate from WNBA data only — the model derives its league baselines from these rows.';

alter table public.wnba_team_features enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Calibration views
--
-- Spec §21: MLB, NFL, UFC, ATP, WTA and WNBA performance must never be mixed
-- into one number. Every view below groups by sport_key AND model_version, so
-- there is no way to read a blended figure out of them by accident.
--
-- security_invoker keeps the caller's RLS in force; without it these views
-- would run as their owner and expose model_predictions and signals to anyone
-- who can select from the view.
-- ---------------------------------------------------------------------------

-- Graded predictions: a model row joined to the outcome `signals` already
-- carries. Predictions with no graded signal simply do not appear.
create or replace view public.model_prediction_grades
with (security_invoker = true) as
select
  p.model_version,
  p.sport_key,
  p.market,
  p.selection,
  p.point,
  p.event_id,
  p.commence_time,
  p.model_prob,
  p.market_prob_at_pred,
  p.model_edge,
  p.model_ev,
  p.context_quality,
  s.result,
  s.closing_sharp_fair,
  s.graded_at,
  case s.result when 'win' then 1 when 'loss' then 0 else null end as outcome,
  -- CLV against the close, on the model's own entry snapshot
  case
    when s.closing_sharp_fair is not null and p.market_prob_at_pred is not null
    then p.market_prob_at_pred - s.closing_sharp_fair
    else null
  end as entry_vs_close
from public.model_predictions p
join public.signals s
  on s.event_id = p.event_id
 and s.market   = p.market
 and s.selection = p.selection
 and (s.point is not distinct from p.point)
where s.graded_at is not null;

comment on view public.model_prediction_grades is
  'One row per graded model prediction. entry_vs_close is the model entry snapshot measured against the closing sharp fair — the CLV question. Never aggregate across model_version.';

-- Brier / log loss / realised win rate, per sport and version and market.
create or replace view public.model_calibration_by_sport
with (security_invoker = true) as
select
  model_version,
  sport_key,
  market,
  count(*)                                            as graded,
  count(*) filter (where outcome = 1)                 as wins,
  count(*) filter (where outcome = 0)                 as losses,
  round(avg(model_prob)::numeric, 4)                  as avg_predicted,
  round(avg(outcome)::numeric, 4)                     as realised_rate,
  round(avg((model_prob - outcome) ^ 2)::numeric, 4)  as brier,
  round(avg(
    -(outcome * ln(greatest(model_prob, 1e-9))
      + (1 - outcome) * ln(greatest(1 - model_prob, 1e-9)))
  )::numeric, 4)                                      as log_loss,
  round((avg(model_prob) - avg(outcome))::numeric, 4) as calibration_error,
  round(avg(entry_vs_close)::numeric, 4)              as avg_entry_vs_close,
  min(commence_time)                                  as first_event,
  max(commence_time)                                  as last_event
from public.model_prediction_grades
where outcome is not null
group by model_version, sport_key, market;

comment on view public.model_calibration_by_sport is
  'Calibration per sport, model version and market. Deliberately never aggregated across sports — a blended Brier across MLB, UFC and tennis is not a number about anything.';

-- Reliability by predicted-probability bucket, still split by sport.
create or replace view public.model_reliability_buckets
with (security_invoker = true) as
select
  model_version,
  sport_key,
  market,
  width_bucket(model_prob, 0, 1, 10)                       as bucket,
  (width_bucket(model_prob, 0, 1, 10) - 1) * 10 || '-'
    || width_bucket(model_prob, 0, 1, 10) * 10 || '%'      as bucket_label,
  count(*)                                                 as graded,
  round(avg(model_prob)::numeric, 4)                       as avg_predicted,
  round(avg(outcome)::numeric, 4)                          as realised_rate
from public.model_prediction_grades
where outcome is not null
group by model_version, sport_key, market, width_bucket(model_prob, 0, 1, 10);

comment on view public.model_reliability_buckets is
  'Reliability curve input: predicted vs realised by decile, per sport and model version.';

commit;

-- ============================================================================
-- ROLLBACK NOTES
--
-- Everything here is additive. To back it out:
--
--   drop view if exists public.model_reliability_buckets;
--   drop view if exists public.model_calibration_by_sport;
--   drop view if exists public.model_prediction_grades;
--   drop table if exists public.wnba_team_features;
--   drop table if exists public.nfl_team_features;
--   drop table if exists public.model_parameters;
--   alter table public.model_predictions
--     drop column if exists model_ev,
--     drop column if exists context_quality,
--     drop column if exists missing_features,
--     drop column if exists data_as_of,
--     drop column if exists feature_snapshot_id,
--     drop column if exists model_detail;
--
-- Do NOT drop model_predictions_identity_uidx as part of a rollback. It
-- predates this migration and the CLV baseline depends on it.
-- ============================================================================

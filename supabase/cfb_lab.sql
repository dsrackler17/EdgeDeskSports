-- =============================================================================
-- cfb_lab — the Postgres half of the CFB Live Model Lab.
--
-- WHAT IT IS
--   Every table the lab keeps (docs/cfb-lab/SCHEMA.md), prefixed cfb_lab_ in the
--   public schema: the live prediction ledger, market quotes, derived openers
--   and closes, the provider-event map, settlement facts, evaluations, miss
--   reviews and the governance logs. The repository ledger is the source of
--   truth; football/cfb_lab/sync_supabase.js mirrors it here insert-only
--   (service role, ignore-duplicates). Quotes also arrive through
--   cfb_lab_ingest_quotes() (the capture function's per-sportsbook feed), and
--   role changes can be made with cfb_lab_set_role(). cfb_lab_derive_lines()
--   is the parity copy of the opener/close rules, run by hand; no job
--   schedules it (supabase/cfb_lab_cron.sql says why). The column names are
--   the same in the ledger and here.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Append-only. BEFORE UPDATE, BEFORE DELETE and BEFORE TRUNCATE triggers
--      on EVERY cfb_lab_ table raise restrict_violation — the service role
--      bypasses row level security, not triggers. A correction is a new row
--      carrying `supersedes`.
--   2. No look-ahead. A prediction precedes its kickoff; a LIVE prediction
--      cannot be future-dated; a pregame quote precedes kickoff; a CLOSE line
--      is derived at least three hours after kickoff.
--   3. Deterministic ids. prefix + first 24 hex of sha256 of the fields
--      rendered and joined with '|' (SCHEMA.md rule 4): cfb_lab_h(),
--      cfb_lab_ts(), cfb_lab_num() reproduce the JavaScript rendering.
--   4. One sign convention. *_home_line is book convention (negative = home
--      favoured), *_margin is home margin; fair_spread_home_line must equal
--      -pure_home_margin.
--   5. The market rules of METRICS.md §4 live here as functions:
--      cfb_lab_ingest_quotes() (cfb_lab_quote_dedupe_v1) and
--      cfb_lab_derive_lines() (cfb_lab_open_v1 / cfb_lab_close_v1), with the
--      pure helpers cfb_lab_median() and cfb_lab_median_price().
--      football/cfb_lab/fixtures/market_rules.json holds the cases both this
--      file and the JavaScript copy must reproduce exactly.
--   6. Who reads what. authenticated may SELECT every table and may write
--      nothing. anon may read cfb_lab_public_record and cfb_lab_public_summary
--      and nothing else. Writes come only from the service role.
--
-- DEPENDENCIES: none. It does not need cfb_v2_model.sql (no shared table).
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Tested against a real PostgreSQL by football/cfb_lab/sql.test.js.
-- =============================================================================

-- ------------------------------------------------------------------ helpers
-- SCHEMA.md rule 4. h(a, b, c) = first 24 hex of sha256('a|b|c'), NULL -> ''.
-- The parts arrive already rendered: numbers through cfb_lab_num, timestamps
-- through cfb_lab_ts, booleans as true/false, text as is.
create or replace function public.cfb_lab_h(variadic p_parts text[])
returns text language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $fn$
  select left(encode(sha256(convert_to(array_to_string(p_parts, '|', ''), 'UTF8')), 'hex'), 24)
$fn$;

-- A timestamp as JavaScript's Date#toISOString prints it: UTC, milliseconds, Z.
create or replace function public.cfb_lab_ts(p timestamptz)
returns text language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $fn$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$fn$;

-- A number as JavaScript's String(Number(x)) prints it for the values the lab
-- hashes (half-point lines, totals, American prices): the shortest decimal,
-- no trailing zeros, -0 -> 0. (JavaScript switches to exponent notation below
-- 1e-6 and from 1e21; no lab column reaches either.)
create or replace function public.cfb_lab_num(p numeric)
returns text language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $fn$
  select case when p is null then null else trim_scale(p)::text end
$fn$;

-- Median of a set of numbers; an even count is the mean of the two middle
-- values. NULLs are ignored; an empty set is NULL.
create or replace function public.cfb_lab_median(p numeric[])
returns numeric language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $fn$
  with v as (
    select x, row_number() over (order by x) as rn, count(*) over () as n
      from unnest(p) as u(x) where x is not null
  )
  select case when max(n) is null then null
              when max(n) % 2 = 1 then max(x) filter (where rn = (n + 1) / 2)
              else (max(x) filter (where rn = n / 2) + max(x) filter (where rn = n / 2 + 1)) / 2 end
    from v
$fn$;

-- Median of American prices, taken in DECIMAL-odds space (American odds jump
-- from -100 to +100, so -105 and +105 must not average to 0):
--   decimal d = 1 + a/100 (a > 0) or 1 + 100/(-a) (a < 0); 0 and NULL ignored;
--   median of d (even count: (d1 + d2) / 2);
--   back: d >= 2 -> (d - 1) * 100, d < 2 -> -100 / (d - 1);
--   rounded half away from zero to an integer.
-- Computed in float8 in exactly that order, so it is bit-for-bit the same
-- arithmetic as the JavaScript copy (IEEE 754 doubles on both sides).
create or replace function public.cfb_lab_median_price(p int[])
returns int language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $fn$
  with d as (
    select case when a > 0 then 1::float8 + a::float8 / 100::float8
                else 1::float8 + 100::float8 / (-a)::float8 end as dec
      from unnest(p) as u(a) where a is not null and a <> 0
  ), v as (
    select dec, row_number() over (order by dec) as rn, count(*) over () as n from d
  ), m as (
    select case when max(n) is null then null
                when max(n) % 2 = 1 then max(dec) filter (where rn = (n + 1) / 2)
                else (max(dec) filter (where rn = n / 2) + max(dec) filter (where rn = n / 2 + 1)) / 2::float8 end as dm
      from v
  ), b as (
    select case when dm is null then null
                when dm >= 2 then (dm - 1::float8) * 100::float8
                else -100::float8 / (dm - 1::float8) end as am
      from m
  )
  select case when am is null then null else (sign(am) * floor(abs(am) + 0.5::float8))::int end from b
$fn$;

-- ============================================================== the tables
-- 1. The live prediction ledger (SCHEMA.md §1).
create table if not exists public.cfb_lab_predictions (
  prediction_id              text primary key,
  ledger_version             text not null,
  origin                     text not null,
  game_id                    text not null,
  season                     int not null,
  week                       int not null,
  season_type                text,
  home_team                  text not null,
  away_team                  text not null,
  home_id                    text,
  away_id                    text,
  neutral_site               boolean,
  kickoff_ts                 timestamptz not null,
  prediction_ts              timestamptz not null,
  hours_to_kickoff           numeric(8,3) not null,
  checkpoint_type            text not null,
  is_first_snapshot          boolean not null,
  official_families          text[] not null,
  projection_computed_at     timestamptz,
  feature_ts                 timestamptz,
  model_version              text not null,
  model_label                text,
  model_role                 text not null,
  feature_version            text,
  calibration_version        text,
  ensemble_version           text,
  engine_id                  text,
  params_hash                text,
  pure_home_margin           numeric(7,3) not null,
  fair_spread_home_line      numeric(7,3) not null,
  fair_spread_display        text,
  projected_home_points      numeric(6,2),
  projected_away_points      numeric(6,2),
  projected_total            numeric(6,2),
  home_win_probability       numeric(6,5),
  away_win_probability       numeric(6,5),
  prediction_sigma           numeric(7,3),
  t_df                       numeric(6,2),
  interval_50_low            numeric(7,2),
  interval_50_high           numeric(7,2),
  interval_80_low            numeric(7,2),
  interval_80_high           numeric(7,2),
  interval_95_low            numeric(7,2),
  interval_95_high           numeric(7,2),
  football_confidence        int,
  football_confidence_raw    int,
  internal_consensus_score   int,
  ensemble_disagreement      numeric(6,3),
  expected_model_error       numeric(6,3),
  qb_certainty               int,
  injury_certainty           int,
  data_completeness          numeric(5,4),
  pbp_completeness           numeric(5,4),
  data_quality_status        text not null,
  data_quality_issues        jsonb not null,
  efficiency_margin          numeric(7,3),
  bayesian_margin            numeric(7,3),
  drive_margin               numeric(7,3),
  dynamic_rating_margin      numeric(7,3),
  matchup_ml_margin          numeric(7,3),
  residual_adjusted_margin   numeric(7,3),
  components                 jsonb,
  market_as_of               timestamptz,
  market_sources             text[],
  opening_spread             numeric(6,2),
  opening_market_ts          timestamptz,
  opening_quality            text,
  current_spread             numeric(6,2),
  best_available_spread_home numeric(6,2),
  best_available_spread_away numeric(6,2),
  best_price_home            int,
  best_price_away            int,
  consensus_spread           numeric(6,2),
  consensus_price_home       int,
  consensus_price_away       int,
  market_dispersion          numeric(6,3),
  sportsbook_count           int,
  line_move_from_open        numeric(6,2),
  market_total               numeric(6,2),
  market_stale               boolean,
  model_market_gap           numeric(7,3),
  cover_probability          numeric(6,5),
  break_even_probability     numeric(6,5),
  estimated_ev               numeric(7,4),
  edge_quality               int,
  betting_reliability        int,
  status                     text not null,
  decision_class             text not null,
  decision_source            text not null,
  side                       text,
  recommended_line           numeric(6,2),
  recommended_price          int,
  stake_units                numeric(5,2) not null,
  bet_enabled                boolean not null,
  decision_reason            text,
  pass_reason                text,
  threshold_distance         jsonb,
  near_miss                  boolean not null,
  primary_edge               text,
  secondary_edge             text,
  primary_uncertainty        text,
  disagreement_summary       text,
  inputs_ref                 jsonb not null,
  row_hash                   text not null,
  recorded_at                timestamptz not null default now(),
  constraint cfb_lab_pred_id_format check (prediction_id ~ '^cfbp_[0-9a-f]{24}$'),
  constraint cfb_lab_pred_origin check (origin in ('LIVE','GIT_RECONSTRUCTED','REPLAY')),
  constraint cfb_lab_pred_checkpoint check (checkpoint_type in ('OPEN','T72','T48','T24','T12','T6','T2','FINAL','WEEKLY_FREEZE','ADHOC')),
  constraint cfb_lab_pred_status check (status in ('BET','LEAN','REVIEW','PASS','NOT_PRICED')),
  constraint cfb_lab_pred_decision_class check (decision_class in ('BET','LEAN','RESEARCH','PASS')),
  constraint cfb_lab_pred_side check (side is null or side in ('HOME','AWAY')),
  constraint cfb_lab_pred_dq_status check (data_quality_status in ('GREEN','YELLOW','RED')),
  constraint cfb_lab_pred_opening_quality check (opening_quality is null or opening_quality in ('OBSERVED','PROVIDER_DECLARED','MISSING')),
  constraint cfb_lab_pred_pregame check (prediction_ts < kickoff_ts),
  constraint cfb_lab_pred_hours check (hours_to_kickoff > 0
    and abs(hours_to_kickoff - extract(epoch from (kickoff_ts - prediction_ts)) / 3600) <= 0.01),
  constraint cfb_lab_pred_sign check (abs(fair_spread_home_line + pure_home_margin) < 0.000001),
  constraint cfb_lab_pred_prob_range check (
    (home_win_probability is null or (home_win_probability > 0 and home_win_probability < 1))
    and (away_win_probability is null or (away_win_probability > 0 and away_win_probability < 1))),
  constraint cfb_lab_pred_prob_sum check (home_win_probability is null or away_win_probability is null
    or abs(home_win_probability + away_win_probability - 1) <= 0.0001),
  constraint cfb_lab_pred_sigma check (prediction_sigma is null or prediction_sigma > 0),
  constraint cfb_lab_pred_interval_order check (
    (interval_50_low is null or interval_50_high is null or interval_50_low <= interval_50_high)
    and (interval_80_low is null or interval_80_high is null or interval_80_low <= interval_80_high)
    and (interval_95_low is null or interval_95_high is null or interval_95_low <= interval_95_high)),
  constraint cfb_lab_pred_interval_nesting check (
    (interval_80_low is null or interval_50_low is null or interval_80_low <= interval_50_low)
    and (interval_80_high is null or interval_50_high is null or interval_50_high <= interval_80_high)
    and (interval_95_low is null or interval_80_low is null or interval_95_low <= interval_80_low)
    and (interval_95_high is null or interval_80_high is null or interval_80_high <= interval_95_high)
    and (interval_95_low is null or interval_50_low is null or interval_95_low <= interval_50_low)
    and (interval_95_high is null or interval_50_high is null or interval_50_high <= interval_95_high)),
  constraint cfb_lab_pred_stake check (stake_units >= 0 and (bet_enabled or stake_units = 0)),
  constraint cfb_lab_pred_families check (official_families <@ array['EARLY_MODEL','MIDWEEK_MODEL','OFFICIAL','FINAL_MODEL']::text[]),
  constraint cfb_lab_pred_official check (not ('OFFICIAL' = any (official_families))
    or (checkpoint_type = 'T24' and origin = 'LIVE'))
);
comment on table public.cfb_lab_predictions is
  'CFB Model Lab live prediction ledger: one row per model per game per checkpoint (SCHEMA.md §1). Append-only.';

-- 2. Market history (SCHEMA.md §2).
create table if not exists public.cfb_lab_market_quotes (
  quote_id            text primary key,
  game_id             text,
  season              int,
  week                int,
  source              text not null,
  provider_event_id   text,
  book                text not null,
  market_type         text not null,
  home_line           numeric(6,2),
  total_points        numeric(6,2),
  price_home          int,
  price_away          int,
  price_over          int,
  price_under         int,
  observed_at         timestamptz not null,
  provider_updated_at timestamptz,
  kickoff_ts          timestamptz,
  is_heartbeat        boolean not null default false,
  is_provider_open    boolean not null default false,
  is_provider_close   boolean not null default false,
  is_pregame          boolean not null default true,
  home_team           text,
  away_team           text,
  fingerprint         text not null,
  retrieved_at        timestamptz not null default now(),
  recorded_at         timestamptz not null default now(),
  constraint cfb_lab_quote_id_format check (quote_id ~ '^cfbq_[0-9a-f]{24}$'),
  constraint cfb_lab_quote_source check (source in ('espn','cfbd','odds_api','record')),
  constraint cfb_lab_quote_market check (market_type in ('spread','total','moneyline')),
  constraint cfb_lab_quote_book check (length(book) > 0),
  constraint cfb_lab_quote_game_key check (game_id is not null or provider_event_id is not null),
  constraint cfb_lab_quote_pregame_before_kickoff check (not is_pregame or kickoff_ts is null or observed_at < kickoff_ts),
  constraint cfb_lab_quote_pregame_flag check (is_pregame <> is_provider_close),
  constraint cfb_lab_quote_one_provider_flag check (not (is_provider_open and is_provider_close)),
  constraint cfb_lab_quote_spread_line check (market_type <> 'spread' or home_line is not null),
  constraint cfb_lab_quote_total_points check (market_type <> 'total' or total_points is not null),
  constraint cfb_lab_quote_moneyline_price check (market_type <> 'moneyline' or price_home is not null or price_away is not null)
);
comment on table public.cfb_lab_market_quotes is
  'CFB Model Lab market history: one row per observed change (plus heartbeats) per source, book, game and market (SCHEMA.md §2). Written through cfb_lab_ingest_quotes(). Append-only.';

-- 3. Openers and closes (SCHEMA.md §3), written by cfb_lab_derive_lines().
create table if not exists public.cfb_lab_market_lines (
  line_id         text primary key,
  game_id         text not null,
  kind            text not null,
  book            text not null,
  market_type     text not null,
  home_line       numeric(6,2),
  total_points    numeric(6,2),
  price_home      int,
  price_away      int,
  observed_at     timestamptz,
  n_books         int,
  quality         text not null,
  best_line_home  numeric(6,2),
  best_line_away  numeric(6,2),
  rule_version    text not null,
  quote_ids       text[],
  derived_at      timestamptz not null,
  kickoff_ts      timestamptz,
  recorded_at     timestamptz not null default now(),
  constraint cfb_lab_line_id_format check (line_id ~ '^cfbl_[0-9a-f]{24}$'),
  constraint cfb_lab_line_kind check (kind in ('OPEN','CLOSE')),
  constraint cfb_lab_line_market check (market_type in ('spread','total','moneyline')),
  constraint cfb_lab_line_quality check (quality in ('OBSERVED','PROVIDER_DECLARED','MISSING'))
);
comment on table public.cfb_lab_market_lines is
  'CFB Model Lab write-once openers and closes, per book and CONSENSUS (SCHEMA.md §3, METRICS.md §4). A CLOSE is derived at least 3 hours after kickoff.';

-- 3b. Provider event -> EdgeDesk game (SCHEMA.md §3b).
create table if not exists public.cfb_lab_event_map (
  map_id             text primary key,
  source             text not null,
  provider_event_id  text not null,
  game_id            text not null,
  method             text not null,
  confidence         numeric,
  created_at         timestamptz not null default now(),
  supersedes         text,
  recorded_at        timestamptz not null default now(),
  constraint cfb_lab_map_id_format check (map_id ~ '^cfbx_[0-9a-f]{24}$'),
  constraint cfb_lab_map_source check (source in ('espn','cfbd','odds_api','record')),
  constraint cfb_lab_map_method check (method in ('exact_id','teams_and_kickoff')),
  constraint cfb_lab_map_confidence check (confidence is null or (confidence >= 0 and confidence <= 1))
);
comment on table public.cfb_lab_event_map is
  'CFB Model Lab provider event -> game map. Append-only; the newest row per (source, provider_event_id) wins.';

-- 4. Settlement facts (SCHEMA.md §4).
create table if not exists public.cfb_lab_results (
  result_id      text primary key,
  game_id        text not null,
  season         int,
  week           int,
  status         text not null,
  home_points    int,
  away_points    int,
  final_margin   int,
  final_total    int,
  overtime       boolean,
  sources        jsonb not null,
  sources_agree  boolean not null,
  recorded_at    timestamptz not null default now(),
  supersedes     text,
  reason         text,
  constraint cfb_lab_result_id_format check (result_id ~ '^cfbr_[0-9a-f]{24}$'),
  constraint cfb_lab_result_status check (status in ('FINAL','POSTPONED','CANCELED','NO_CONTEST')),
  constraint cfb_lab_result_final_agreed check (status <> 'FINAL'
    or (home_points is not null and away_points is not null and sources_agree)),
  constraint cfb_lab_result_final_derived check (status <> 'FINAL'
    or (final_margin = home_points - away_points and final_total = home_points + away_points)),
  constraint cfb_lab_result_not_self check (supersedes is null or supersedes <> result_id)
);
comment on table public.cfb_lab_results is
  'CFB Model Lab settlement facts. A FINAL needs every source to agree; a correction is a new row with supersedes.';

-- 5. Grading of each snapshot (SCHEMA.md §5, every column defined in METRICS.md).
create table if not exists public.cfb_lab_evaluations (
  evaluation_id             text primary key,
  prediction_id             text not null,
  eval_version              text not null,
  result_id                 text,
  evaluated_at              timestamptz not null,
  game_id                   text not null,
  model_version             text not null,
  checkpoint_type           text not null,
  origin                    text not null,
  official                  boolean not null,
  season                    int,
  week                      int,
  kickoff_ts                timestamptz,
  model_label               text,
  model_role                text,
  hours_to_kickoff          numeric,
  is_first_snapshot         boolean,
  football_confidence       int,
  edge_quality              int,
  ensemble_disagreement     numeric,
  model_market_gap          numeric,
  near_miss                 boolean,
  data_quality_status       text,
  result_status             text,
  final_home_points         int,
  final_away_points         int,
  final_margin              int,
  final_total               int,
  overtime                  boolean,
  void                      boolean not null default false,
  margin_error              numeric,
  abs_margin_error          numeric,
  squared_margin_error      numeric,
  home_points_error         numeric,
  away_points_error         numeric,
  total_error               numeric,
  winner_correct            boolean,
  brier_win                 numeric,
  log_loss_win              numeric,
  p_home                    numeric,
  home_won                  int,
  in_interval_50            boolean,
  in_interval_80            boolean,
  in_interval_95            boolean,
  open_home_line            numeric,
  open_quality              text,
  close_home_line           numeric,
  close_quality             text,
  close_line_id             text,
  close_books               int,
  open_abs_error            numeric,
  close_abs_error           numeric,
  edgedesk_beat_open        boolean,
  edgedesk_beat_close       boolean,
  tie_vs_open               boolean,
  tie_vs_close              boolean,
  error_diff_vs_open        numeric,
  error_diff_vs_close       numeric,
  edge_vs_open              numeric,
  market_move_points        numeric,
  market_move_toward_model  boolean,
  move_since_snapshot       numeric,
  decision_class            text,
  side                      text,
  graded_line               numeric,
  graded_price              int,
  price_assumed             boolean,
  ats_result                text,
  ats_result_at_close       text,
  units                     numeric,
  stake_units               numeric,
  hypothetical_units        numeric,
  cover_probability         numeric,
  covered                   boolean,
  brier_cover               numeric,
  clv_points                numeric,
  clv_price                 numeric,
  positive_clv              boolean,
  process_quality           text,
  outcome_quadrant          text,
  recorded_at               timestamptz not null default now(),
  constraint cfb_lab_eval_id_format check (evaluation_id ~ '^cfbe_[0-9a-f]{24}$'),
  constraint cfb_lab_eval_origin check (origin in ('LIVE','GIT_RECONSTRUCTED','REPLAY')),
  constraint cfb_lab_eval_checkpoint check (checkpoint_type in ('OPEN','T72','T48','T24','T12','T6','T2','FINAL','WEEKLY_FREEZE','ADHOC')),
  constraint cfb_lab_eval_result_status check (result_status is null or result_status in ('FINAL','POSTPONED','CANCELED','NO_CONTEST')),
  constraint cfb_lab_eval_home_won check (home_won is null or home_won in (0, 1)),
  constraint cfb_lab_eval_open_quality check (open_quality is null or open_quality in ('OBSERVED','PROVIDER_DECLARED','MISSING')),
  constraint cfb_lab_eval_close_quality check (close_quality is null or close_quality in ('OBSERVED','PROVIDER_DECLARED','MISSING')),
  constraint cfb_lab_eval_decision_class check (decision_class is null or decision_class in ('BET','LEAN','RESEARCH','PASS')),
  constraint cfb_lab_eval_side check (side is null or side in ('HOME','AWAY')),
  constraint cfb_lab_eval_ats check (ats_result is null or ats_result in ('WIN','LOSS','PUSH','VOID')),
  constraint cfb_lab_eval_ats_close check (ats_result_at_close is null or ats_result_at_close in ('WIN','LOSS','PUSH','VOID')),
  constraint cfb_lab_eval_process check (process_quality is null or process_quality in ('GOOD','POOR','UNKNOWN')),
  constraint cfb_lab_eval_quadrant check (outcome_quadrant is null or outcome_quadrant in
    ('GOOD_PROCESS_WIN','GOOD_PROCESS_LOSS','POOR_PROCESS_WIN','POOR_PROCESS_LOSS','UNKNOWN'))
);
comment on table public.cfb_lab_evaluations is
  'CFB Model Lab grading of each snapshot. Append-only; a new eval_version or a corrected result adds rows.';

-- 6. Miss reviews (SCHEMA.md §6).
create table if not exists public.cfb_lab_miss_reviews (
  review_id               text primary key,
  prediction_id           text not null,
  game_id                 text not null,
  model_version           text not null,
  severity                int,
  predicted_margin        numeric,
  actual_margin           numeric,
  market_close_home_line  numeric,
  abs_error               numeric,
  close_abs_error         numeric,
  evidence                jsonb,
  classification          text not null,
  classified_by           text not null,
  rationale               text,
  created_at              timestamptz not null default now(),
  supersedes              text,
  recorded_at             timestamptz not null default now(),
  constraint cfb_lab_miss_id_format check (review_id ~ '^cfbm_[0-9a-f]{24}$'),
  constraint cfb_lab_miss_severity check (severity is null or severity in (10, 14, 21)),
  constraint cfb_lab_miss_class check (classification in
    ('MODEL_FAILURE','DATA_FAILURE','INFORMATION_CHANGE','HIGH_VARIANCE_OUTCOME','UNKNOWN'))
);

-- 7. Governance (SCHEMA.md §7).
create table if not exists public.cfb_lab_model_roles (
  event_id       text primary key,
  model_version  text not null,
  model_label    text,
  role           text not null,
  effective_at   timestamptz not null,
  reason         text,
  evidence_ref   text,
  actor          text,
  supersedes     text,
  recorded_at    timestamptz not null default now(),
  constraint cfb_lab_role_event_id_format check (event_id ~ '^cfbg_[0-9a-f]{24}$'),
  constraint cfb_lab_role_value check (role in ('champion','challenger','candidate','retired'))
);

create table if not exists public.cfb_lab_experiments (
  event_id           text primary key,
  experiment_id      text not null,
  event              text not null,
  experiment_name    text,
  baseline_model     text,
  challenger_model   text,
  hypothesis         text,
  change             text,
  scope              text,
  start_date         date,
  evaluation_window  text,
  metrics            jsonb,
  status             text,
  result             jsonb,
  actor              text,
  created_at         timestamptz not null default now(),
  recorded_at        timestamptz not null default now(),
  constraint cfb_lab_experiment_event_id_format check (event_id ~ '^cfbg_[0-9a-f]{24}$'),
  constraint cfb_lab_experiment_event check (event in ('CREATED','STATUS','RESULT')),
  constraint cfb_lab_experiment_scope check (scope is null or scope in ('SINGLE_CHANGE','BUNDLE','ARCHITECTURE'))
);

create table if not exists public.cfb_lab_audit_log (
  event_id     text primary key,
  event_type   text not null,
  subject      text,
  before       jsonb,
  after        jsonb,
  reason       text,
  actor        text,
  created_at   timestamptz not null default now(),
  recorded_at  timestamptz not null default now(),
  constraint cfb_lab_audit_event_id_format check (event_id ~ '^cfbg_[0-9a-f]{24}$'),
  constraint cfb_lab_audit_event_type check (event_type in ('MODEL_REGISTERED','MODEL_PROMOTED','MODEL_RETIRED',
    'ROLE_CHANGED','CALIBRATION_CHANGED','THRESHOLD_CHANGED','FEATURE_VERSION_CHANGED','DATA_SOURCE_CHANGED',
    'PARTITION_RELEASED','EXPERIMENT_CREATED','EXPERIMENT_STATUS','RULE_CHANGED'))
);

create table if not exists public.cfb_lab_partitions (
  event_id      text primary key,
  pool          text not null,
  season        int,
  week_from     int,
  week_to       int,
  origin_scope  text,
  effective_at  timestamptz not null,
  reason        text,
  actor         text,
  recorded_at   timestamptz not null default now(),
  constraint cfb_lab_partition_event_id_format check (event_id ~ '^cfbg_[0-9a-f]{24}$'),
  constraint cfb_lab_partition_pool check (pool in ('live_observation_pool','development_pool','future_holdout_pool'))
);

create table if not exists public.cfb_lab_research_queue (
  event_id     text primary key,
  item_key     text not null,
  event        text not null,
  title        text,
  evidence     jsonb,
  n            int,
  effect       numeric,
  effect_se    numeric,
  created_at   timestamptz not null default now(),
  recorded_at  timestamptz not null default now(),
  constraint cfb_lab_research_event check (event in ('OPENED','EVIDENCE','CLOSED'))
);

create table if not exists public.cfb_lab_reports (
  report_id     text primary key,
  kind          text not null,
  season        int,
  week          int,
  generated_at  timestamptz not null,
  body          jsonb not null,
  recorded_at   timestamptz not null default now(),
  constraint cfb_lab_report_kind check (kind in ('weekly','season','promotion'))
);

-- ================================================================== indexes
-- one row per game, model, checkpoint and origin (ADHOC excepted): a
-- GIT_RECONSTRUCTED or REPLAY row never occupies a LIVE checkpoint's slot
create unique index if not exists cfb_lab_pred_checkpoint_slot
  on public.cfb_lab_predictions (game_id, model_version, checkpoint_type, origin) where checkpoint_type <> 'ADHOC';
create index if not exists cfb_lab_pred_game_idx on public.cfb_lab_predictions (game_id);
create index if not exists cfb_lab_pred_model_idx on public.cfb_lab_predictions (model_version, checkpoint_type);
create index if not exists cfb_lab_pred_week_idx on public.cfb_lab_predictions (season, week);
create index if not exists cfb_lab_pred_kickoff_idx on public.cfb_lab_predictions (kickoff_ts);
create index if not exists cfb_lab_quote_game_idx on public.cfb_lab_market_quotes (game_id, market_type, observed_at desc);
create index if not exists cfb_lab_quote_event_idx on public.cfb_lab_market_quotes (source, provider_event_id);
create index if not exists cfb_lab_quote_week_idx on public.cfb_lab_market_quotes (season, week);
-- the de-duplication key of cfb_lab_quote_dedupe_v1, newest first
create index if not exists cfb_lab_quote_dedupe_idx on public.cfb_lab_market_quotes
  (source, book, (coalesce(game_id, provider_event_id)), market_type, observed_at desc);
create index if not exists cfb_lab_line_game_idx on public.cfb_lab_market_lines (game_id, kind);
create index if not exists cfb_lab_result_game_idx on public.cfb_lab_results (game_id, recorded_at desc);
create index if not exists cfb_lab_result_supersedes_idx on public.cfb_lab_results (supersedes) where supersedes is not null;
create index if not exists cfb_lab_eval_pred_idx on public.cfb_lab_evaluations (prediction_id, evaluated_at desc);
create index if not exists cfb_lab_miss_pred_idx on public.cfb_lab_miss_reviews (prediction_id);
create index if not exists cfb_lab_map_event_idx on public.cfb_lab_event_map (source, provider_event_id, created_at desc);
create index if not exists cfb_lab_map_game_idx on public.cfb_lab_event_map (game_id);
create index if not exists cfb_lab_role_model_idx on public.cfb_lab_model_roles (model_version, effective_at desc);

-- ============================================================ append-only
create or replace function public.cfb_lab_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows are never updated (a correction is a new row with supersedes)', tg_table_name
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    raise exception '% is append-only: rows are never deleted', tg_table_name
      using errcode = 'restrict_violation';
  else
    raise exception '% is append-only: it is never truncated', tg_table_name
      using errcode = 'restrict_violation';
  end if;
end $fn$;

-- A LIVE prediction is taken by the lab before kickoff, now: it cannot be
-- dated in the future. (Every row-local rule is a named check constraint on
-- the table; this is the one that needs the clock.)
create or replace function public.cfb_lab_predictions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if new.origin = 'LIVE' and new.prediction_ts > now() + interval '10 minutes' then
    raise exception 'cfb_lab_predictions: LIVE prediction % is dated % which is in the future (now %)',
      new.prediction_id, new.prediction_ts, now()
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

-- The quotes of one game: rows written with its game_id, plus rows written
-- before their provider event was mapped (game_id NULL) whose NEWEST map row
-- (per source + provider_event_id) now names the game. The same resolution
-- cfb_lab_ingest_quotes applies at write time, applied again at read time, so
-- an Odds API event's earliest quotes still count once the event is mapped.
create or replace function public.cfb_lab_game_quotes(p_game_id text)
returns setof public.cfb_lab_market_quotes language sql stable
set search_path = pg_catalog, pg_temp
as $fn$
  select q.* from public.cfb_lab_market_quotes q where q.game_id = p_game_id
  union all
  select q.* from public.cfb_lab_market_quotes q
    join (
      select distinct on (m.source, m.provider_event_id) m.source, m.provider_event_id, m.game_id
        from public.cfb_lab_event_map m
       where (m.source, m.provider_event_id) in
             (select m2.source, m2.provider_event_id from public.cfb_lab_event_map m2 where m2.game_id = p_game_id)
       order by m.source, m.provider_event_id, m.created_at desc, m.recorded_at desc, m.map_id desc
    ) cur on cur.game_id = p_game_id and q.source = cur.source and q.provider_event_id = cur.provider_event_id
   where q.game_id is null
$fn$;

-- The kickoff the lab knows for a game: the newest of what the predictions
-- (by prediction_ts) and the game's quotes (cfb_lab_game_quotes, by
-- observed_at) say. A tie takes the later kickoff. NULL when the game is unknown.
create or replace function public.cfb_lab_game_kickoff(p_game_id text)
returns timestamptz language sql stable
set search_path = pg_catalog, pg_temp
as $fn$
  select k from (
    select p.kickoff_ts as k, p.prediction_ts as seen
      from public.cfb_lab_predictions p where p.game_id = p_game_id
    union all
    select q.kickoff_ts, q.observed_at
      from public.cfb_lab_game_quotes(p_game_id) q where q.kickoff_ts is not null
  ) x
  order by seen desc, k desc
  limit 1
$fn$;

-- A CLOSE line is derived at least three hours after kickoff, so late quote
-- syncs land first (METRICS.md §4). The kickoff is the later of the row's own
-- kickoff_ts and cfb_lab_game_kickoff(); the check is skipped when both are NULL.
create or replace function public.cfb_lab_lines_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
declare k timestamptz;
begin
  if new.kind = 'CLOSE' then
    -- the later of the kickoff the row carries and the one the lab knows
    k := greatest(new.kickoff_ts, public.cfb_lab_game_kickoff(new.game_id));
    if k is not null and new.derived_at < k + interval '3 hours' then
      raise exception 'cfb_lab_market_lines: CLOSE % for game % derived at %, before kickoff % + 3 hours',
        new.line_id, new.game_id, new.derived_at, k
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $fn$;

-- A correction names an earlier result of the SAME game.
create or replace function public.cfb_lab_results_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if new.supersedes is not null and not exists (
       select 1 from public.cfb_lab_results r
        where r.result_id = new.supersedes and r.game_id = new.game_id) then
    raise exception 'cfb_lab_results: % supersedes %, which is not an existing result of game %',
      new.result_id, new.supersedes, new.game_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $fn$;

-- One champion. A champion event is refused while another model's current
-- role is champion: demote it first (cfb_lab_set_role does both, in order).
create or replace function public.cfb_lab_roles_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $fn$
declare other text;
begin
  if new.role = 'champion' then
    select c.model_version into other from (
      select distinct on (r.model_version) r.model_version, r.role
        from public.cfb_lab_model_roles r
       where r.model_version <> new.model_version
       order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc
    ) c where c.role = 'champion' limit 1;
    if other is not null then
      raise exception 'cfb_lab_model_roles: % cannot become champion while % is champion; demote it first',
        new.model_version, other
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists cfb_lab_predictions_guard_trg on public.cfb_lab_predictions;
create trigger cfb_lab_predictions_guard_trg before insert on public.cfb_lab_predictions
  for each row execute function public.cfb_lab_predictions_guard();
drop trigger if exists cfb_lab_market_lines_guard_trg on public.cfb_lab_market_lines;
create trigger cfb_lab_market_lines_guard_trg before insert on public.cfb_lab_market_lines
  for each row execute function public.cfb_lab_lines_guard();
drop trigger if exists cfb_lab_results_guard_trg on public.cfb_lab_results;
create trigger cfb_lab_results_guard_trg before insert on public.cfb_lab_results
  for each row execute function public.cfb_lab_results_guard();
drop trigger if exists cfb_lab_model_roles_guard_trg on public.cfb_lab_model_roles;
create trigger cfb_lab_model_roles_guard_trg before insert on public.cfb_lab_model_roles
  for each row execute function public.cfb_lab_roles_guard();

-- Append-only triggers, row level security, the authenticated read policy and
-- the grants, on every table. anon gets nothing on any table; authenticated
-- reads; the service role inserts and reads (and cannot update, delete or
-- truncate even before the triggers are reached).
do $blk$
declare
  t text;
begin
  foreach t in array array['cfb_lab_predictions','cfb_lab_market_quotes','cfb_lab_market_lines',
    'cfb_lab_event_map','cfb_lab_results','cfb_lab_evaluations','cfb_lab_miss_reviews',
    'cfb_lab_model_roles','cfb_lab_experiments','cfb_lab_audit_log','cfb_lab_partitions',
    'cfb_lab_research_queue','cfb_lab_reports']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_update_trg', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.cfb_lab_append_only()', t || '_no_update_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete_trg', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.cfb_lab_append_only()', t || '_no_delete_trg', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.cfb_lab_append_only()', t || '_no_truncate_trg', t);

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

-- ====================================================== quote de-duplication
-- A lenient timestamp parse, used only to order an incoming batch.
create or replace function public.cfb_lab_try_ts(p text)
returns timestamptz language plpgsql stable
set search_path = pg_catalog, pg_temp
as $fn$
begin
  return p::timestamptz;
exception when others then
  return null;
end $fn$;

-- cfb_lab_quote_dedupe_v1 (METRICS.md §4). Takes a JSON array of quote objects
-- (the columns of cfb_lab_market_quotes; quote_id, fingerprint, is_heartbeat
-- and recorded_at are always computed here, whatever the caller sent) and
-- writes the ones the rule keeps. Returns
--   {received, written, duplicates, refused, rule_version, refusals:[{index, reason}]}.
--
-- Per quote, in observed_at order (ties in array order):
--   * game_id NULL -> resolved from cfb_lab_event_map (newest row per source +
--     provider_event_id), BEFORE the id is computed;
--   * key = (source, book, coalesce(game_id, provider_event_id), market_type);
--   * fingerprint = h(home_line, total_points, price_home, price_away, price_over, price_under);
--     quote_id = 'cfbq_' + h(source, book, key, market_type, observed_at) for an
--     ordinary quote, with a sixth part 'provider_open' / 'provider_close' for
--     a provider-declared row (so a declared number and an ordinary quote seen
--     at the same instant are two rows, not one id);
--   * REFUSED: unreadable; bad enum; no key; spread without home_line, total
--     without total_points, moneyline without a price; is_pregame not the
--     opposite of is_provider_close (in-play odds are never stored); both
--     provider flags; or, unless is_provider_close, observed_at >= kickoff_ts;
--   * provider-declared rows (is_provider_open or is_provider_close) are
--     stored at most once per key and flag -> otherwise DUPLICATE;
--   * an ordinary quote is WRITTEN when there is no earlier ordinary row for
--     the key, its fingerprint differs from the latest earlier one, that row
--     is >= 6 h older, or kickoff_ts - observed_at <= 3 h and that row is
--     >= 50 min older (the last two are heartbeats, is_heartbeat = true);
--     otherwise DUPLICATE. An existing quote_id is always DUPLICATE.
create or replace function public.cfb_lab_ingest_quotes(p_quotes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c_rule     constant text := 'cfb_lab_quote_dedupe_v1';
  v_item     record;
  q          public.cfb_lab_market_quotes;
  v_key      text;
  v_reason   text;
  v_prev_at  timestamptz;
  v_prev_fp  text;
  v_write    boolean;
  v_hb       boolean;
  v_n        int;
  v_received int := 0;
  v_written  int := 0;
  v_dup      int := 0;
  v_refused  int := 0;
  v_refusals jsonb := '[]'::jsonb;
begin
  if p_quotes is null or jsonb_typeof(p_quotes) <> 'array' then
    raise exception 'cfb_lab_ingest_quotes: p_quotes must be a JSON array of quote objects'
      using errcode = 'invalid_parameter_value';
  end if;
  -- one writer at a time, so two overlapping syncs cannot both write a change
  perform pg_advisory_xact_lock(hashtext('cfb_lab_ingest_quotes'));

  for v_item in
    select e.value as j, e.ordinality as idx
      from jsonb_array_elements(p_quotes) with ordinality as e
     order by public.cfb_lab_try_ts(e.value ->> 'observed_at') nulls first, e.ordinality
  loop
    v_received := v_received + 1;
    v_reason := null;
    begin
      if jsonb_typeof(v_item.j) <> 'object' then
        raise exception 'not a JSON object';
      end if;
      q := jsonb_populate_record(null::public.cfb_lab_market_quotes, v_item.j);
    exception when others then
      v_reason := 'unreadable: ' || sqlerrm;
    end;

    if v_reason is null then
      q.is_provider_open  := coalesce(q.is_provider_open, false);
      q.is_provider_close := coalesce(q.is_provider_close, false);
      q.is_pregame        := coalesce(q.is_pregame, not q.is_provider_close);
      q.retrieved_at      := coalesce(q.retrieved_at, now());
      q.recorded_at       := now();
      if q.game_id is null and q.provider_event_id is not null then
        select m.game_id into q.game_id
          from public.cfb_lab_event_map m
         where m.source = q.source and m.provider_event_id = q.provider_event_id
         order by m.created_at desc, m.recorded_at desc, m.map_id desc
         limit 1;
      end if;
      v_key := coalesce(q.game_id, q.provider_event_id);

      if q.source is null or q.source not in ('espn','cfbd','odds_api','record') then
        v_reason := 'source must be one of espn, cfbd, odds_api, record';
      elsif coalesce(q.book, '') = '' then
        v_reason := 'book is required';
      elsif q.market_type is null or q.market_type not in ('spread','total','moneyline') then
        v_reason := 'market_type must be spread, total or moneyline';
      elsif q.observed_at is null then
        v_reason := 'observed_at is required';
      elsif v_key is null then
        v_reason := 'game_id or provider_event_id is required';
      elsif q.is_provider_open and q.is_provider_close then
        v_reason := 'a quote cannot be both a provider-declared open and a provider-declared close';
      elsif q.is_pregame = q.is_provider_close then
        v_reason := 'is_pregame must be false exactly for provider-declared closes (in-play odds are never stored)';
      elsif q.market_type = 'spread' and q.home_line is null then
        v_reason := 'a spread quote needs home_line';
      elsif q.market_type = 'total' and q.total_points is null then
        v_reason := 'a total quote needs total_points';
      elsif q.market_type = 'moneyline' and q.price_home is null and q.price_away is null then
        v_reason := 'a moneyline quote needs price_home or price_away';
      elsif not q.is_provider_close and q.kickoff_ts is not null and q.observed_at >= q.kickoff_ts then
        v_reason := 'observed at or after kickoff: never written as pregame';
      end if;
    end if;

    if v_reason is null then
      q.fingerprint := public.cfb_lab_h(
        public.cfb_lab_num(q.home_line), public.cfb_lab_num(q.total_points),
        public.cfb_lab_num(q.price_home), public.cfb_lab_num(q.price_away),
        public.cfb_lab_num(q.price_over), public.cfb_lab_num(q.price_under));
      q.quote_id := 'cfbq_' || case
        when q.is_provider_open then public.cfb_lab_h(q.source, q.book, v_key, q.market_type, public.cfb_lab_ts(q.observed_at), 'provider_open')
        when q.is_provider_close then public.cfb_lab_h(q.source, q.book, v_key, q.market_type, public.cfb_lab_ts(q.observed_at), 'provider_close')
        else public.cfb_lab_h(q.source, q.book, v_key, q.market_type, public.cfb_lab_ts(q.observed_at)) end;

      v_write := false;
      v_hb := false;
      if exists (select 1 from public.cfb_lab_market_quotes x where x.quote_id = q.quote_id) then
        v_write := false;
      elsif q.is_provider_open or q.is_provider_close then
        v_write := not exists (
          select 1 from public.cfb_lab_market_quotes x
           where x.source = q.source and x.book = q.book
             and coalesce(x.game_id, x.provider_event_id) = v_key
             and x.market_type = q.market_type
             and x.is_provider_open = q.is_provider_open
             and x.is_provider_close = q.is_provider_close);
      else
        v_prev_at := null;
        v_prev_fp := null;
        select x.observed_at, x.fingerprint into v_prev_at, v_prev_fp
          from public.cfb_lab_market_quotes x
         where x.source = q.source and x.book = q.book
           and coalesce(x.game_id, x.provider_event_id) = v_key
           and x.market_type = q.market_type
           and not x.is_provider_open and not x.is_provider_close
           and x.observed_at < q.observed_at
         order by x.observed_at desc, x.quote_id desc
         limit 1;
        if v_prev_at is null then
          v_write := true;
        elsif v_prev_fp is distinct from q.fingerprint then
          v_write := true;
        elsif q.observed_at - v_prev_at >= interval '6 hours' then
          v_write := true; v_hb := true;
        elsif q.kickoff_ts is not null and q.kickoff_ts - q.observed_at <= interval '3 hours'
              and q.observed_at - v_prev_at >= interval '50 minutes' then
          v_write := true; v_hb := true;
        end if;
      end if;

      if v_write then
        q.is_heartbeat := v_hb;
        begin
          insert into public.cfb_lab_market_quotes values (q.*) on conflict do nothing;
          get diagnostics v_n = row_count;
          if v_n = 1 then v_written := v_written + 1; else v_dup := v_dup + 1; end if;
        exception when others then
          v_reason := 'insert refused: ' || sqlerrm;
        end;
      else
        v_dup := v_dup + 1;
      end if;
    end if;

    if v_reason is not null then
      v_refused := v_refused + 1;
      if jsonb_array_length(v_refusals) < 100 then
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object('index', v_item.idx - 1, 'reason', v_reason));
      end if;
    end if;
  end loop;

  return jsonb_build_object('received', v_received, 'written', v_written, 'duplicates', v_dup,
    'refused', v_refused, 'rule_version', c_rule, 'refusals', v_refusals);
end $fn$;

-- ======================================================= openers and closes
-- cfb_lab_open_v1 / cfb_lab_close_v1 (METRICS.md §4). For every game whose
-- kickoff + 3 h <= p_now (p_now may not be in the future) and that has no
-- CONSENSUS spread CLOSE yet, derive in one transaction, per market type
-- (spread always; total and moneyline when the game has any quote of that
-- type), over cfb_lab_game_quotes (the game's quotes, including those written
-- before their provider event was mapped). A "book" here is a (source, book) pair, written 'source:book'
-- (e.g. 'odds_api:draftkings'), so each provider's view of a book is its own
-- row and its own line_id. An ordinary pregame quote is is_pregame, neither
-- provider flag, and observed_at < kickoff.
--   per-book OPEN   the book's earliest ordinary pregame quote;
--   per-book CLOSE  the book's latest one in [kickoff - 180 min, kickoff);
--                   (ties: quote_id ascending; per-book n_books = 1)
--   CONSENSUS OPEN  t0 = earliest per-book opener; the band is the books whose
--                   opener is <= t0 + 24 h; provider averages (raw book
--                   'consensus', any case) are dropped when a real book is in
--                   the band; medians of the rest; observed_at = earliest
--                   used opener;
--   CONSENSUS CLOSE medians of the per-book closes, provider averages dropped
--                   when a real book closed; observed_at = latest used quote;
--   spread CONSENSUS (OPEN and CLOSE, OBSERVED or PROVIDER_DECLARED):
--                   best_line_home = max(home_line), best_line_away =
--                   -min(home_line) over the books used;
--   fallback        nothing observed -> the provider-declared rows
--                   (is_provider_open for OPEN, is_provider_close for CLOSE),
--                   each book's LATEST, same provider-average rule, quality
--                   PROVIDER_DECLARED, observed_at NULL (a declared number has
--                   no observation time of its own); none -> MISSING (values
--                   NULL, n_books 0, quote_ids {}).
-- Values per market: spread -> home_line, price_home, price_away; total ->
-- total_points, price_home = the OVER price, price_away = the UNDER price;
-- moneyline -> price_home, price_away. Medians: cfb_lab_median (lines, even
-- count = mean of the middle two) and cfb_lab_median_price (decimal-odds
-- space, 0 and NULL ignored). Lines are stored at 2 decimals. quote_ids are
-- the quotes used, sorted ascending. kickoff_ts is the game's kickoff
-- (cfb_lab_game_kickoff).
-- line_id = 'cfbl_' + h(game_id, kind, book, market_type, rule_version).
create or replace function public.cfb_lab_derive_lines(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c_open    constant text := 'cfb_lab_open_v1';
  c_close   constant text := 'cfb_lab_close_v1';
  v_now     timestamptz := now();
  g         record;
  m         text;
  k         timestamptz;
  v_n       int;
  v_rows    int := 0;
  v_games   int := 0;
  v_obs     int := 0;
  v_decl    int := 0;
  v_missing int := 0;
  r         record;
begin
  if p_now is null or p_now > v_now + interval '1 minute' then
    raise exception 'cfb_lab_derive_lines: p_now % is in the future; a close is derived only after the fact', p_now
      using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_lab_derive_lines'));

  for g in
    select u.game_id, public.cfb_lab_game_kickoff(u.game_id) as kickoff
      from (select q.game_id from public.cfb_lab_market_quotes q where q.game_id is not null
            union
            select p.game_id from public.cfb_lab_predictions p where p.origin = 'LIVE'
            union
            select cur.game_id
              from (select distinct on (m.source, m.provider_event_id) m.source, m.provider_event_id, m.game_id
                      from public.cfb_lab_event_map m
                     order by m.source, m.provider_event_id, m.created_at desc, m.recorded_at desc, m.map_id desc) cur
             where exists (select 1 from public.cfb_lab_market_quotes q
                            where q.game_id is null and q.source = cur.source and q.provider_event_id = cur.provider_event_id)) u
     where not exists (select 1 from public.cfb_lab_market_lines l
                        where l.game_id = u.game_id and l.kind = 'CLOSE'
                          and l.book = 'CONSENSUS' and l.market_type = 'spread')
     order by u.game_id
  loop
    k := g.kickoff;
    continue when k is null or k + interval '3 hours' > least(p_now, v_now);
    v_games := v_games + 1;

    foreach m in array array['spread','total','moneyline'] loop
      continue when m <> 'spread' and not exists (select 1 from public.cfb_lab_game_quotes(g.game_id) x where x.market_type = m);

      -- ------------------------------------------------ per-book OPEN and CLOSE
      insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, home_line, total_points,
             price_home, price_away, observed_at, n_books, quality, best_line_home, best_line_away,
             rule_version, quote_ids, derived_at, kickoff_ts)
      select 'cfbl_' || public.cfb_lab_h(g.game_id, b.kind, b.source || ':' || b.book, m, b.rule), g.game_id, b.kind,
             b.source || ':' || b.book, m,
             case when m = 'spread' then b.home_line end,
             case when m = 'total' then b.total_points end,
             case when m = 'total' then b.price_over else b.price_home end,
             case when m = 'total' then b.price_under else b.price_away end,
             b.observed_at, 1, 'OBSERVED', null, null, b.rule, array[b.quote_id], v_now, k
        from (
          select * from (
            select distinct on (x.source, x.book) 'OPEN'::text as kind, c_open as rule, x.*
              from public.cfb_lab_game_quotes(g.game_id) x
             where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
               and x.observed_at < k
             order by x.source, x.book, x.observed_at asc, x.quote_id asc) o
          union all
          select * from (
            select distinct on (x.source, x.book) 'CLOSE'::text as kind, c_close as rule, x.*
              from public.cfb_lab_game_quotes(g.game_id) x
             where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
               and x.observed_at >= k - interval '180 minutes' and x.observed_at < k
             order by x.source, x.book, x.observed_at desc, x.quote_id asc) c
        ) b
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_rows := v_rows + v_n;

      -- ------------------------------------------------------ CONSENSUS OPEN
      with o as (
        select distinct on (x.source, x.book) x.*
          from public.cfb_lab_game_quotes(g.game_id) x
         where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
           and x.observed_at < k
         order by x.source, x.book, x.observed_at asc, x.quote_id asc
      ), band as (
        select o.* from o where o.observed_at <= (select min(o2.observed_at) from o o2) + interval '24 hours'
      ), used as (
        select * from band b
         where lower(b.book) <> 'consensus' or not exists (select 1 from band r2 where lower(r2.book) <> 'consensus')
      )
      select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
             public.cfb_lab_median(array_agg(total_points)) as total_points,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
             min(observed_at) as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
             max(home_line) as best_home, -min(home_line) as best_away,
             'OBSERVED'::text as quality
        into r from used;
      if r.n = 0 then
        with o as (
          select distinct on (x.source, x.book) x.*
            from public.cfb_lab_game_quotes(g.game_id) x
           where x.market_type = m and x.is_provider_open
           order by x.source, x.book, x.observed_at desc, x.quote_id asc
        ), used as (
          select * from o
           where lower(o.book) <> 'consensus' or not exists (select 1 from o r2 where lower(r2.book) <> 'consensus')
        )
        select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
               public.cfb_lab_median(array_agg(total_points)) as total_points,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
               null::timestamptz as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
               max(home_line) as best_home, -min(home_line) as best_away,
               'PROVIDER_DECLARED'::text as quality
          into r from used;
      end if;
      insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, home_line, total_points,
             price_home, price_away, observed_at, n_books, quality, best_line_home, best_line_away,
             rule_version, quote_ids, derived_at, kickoff_ts)
      values ('cfbl_' || public.cfb_lab_h(g.game_id, 'OPEN', 'CONSENSUS', m, c_open), g.game_id, 'OPEN', 'CONSENSUS', m,
              case when r.n > 0 and m = 'spread' then r.home_line end,
              case when r.n > 0 and m = 'total' then r.total_points end,
              case when r.n > 0 then r.price_home end,
              case when r.n > 0 then r.price_away end,
              case when r.n > 0 then r.observed_at end, r.n,
              case when r.n > 0 then r.quality else 'MISSING' end,
              case when r.n > 0 and m = 'spread' then r.best_home end,
              case when r.n > 0 and m = 'spread' then r.best_away end,
              c_open, coalesce(case when r.n > 0 then r.quote_ids end, '{}'::text[]), v_now, k)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_rows := v_rows + v_n;
      if v_n > 0 then
        if r.n = 0 then v_missing := v_missing + 1;
        elsif r.quality = 'OBSERVED' then v_obs := v_obs + 1;
        else v_decl := v_decl + 1; end if;
      end if;

      -- ----------------------------------------------------- CONSENSUS CLOSE
      with c as (
        select distinct on (x.source, x.book) x.*
          from public.cfb_lab_game_quotes(g.game_id) x
         where x.market_type = m and x.is_pregame and not x.is_provider_open and not x.is_provider_close
           and x.observed_at >= k - interval '180 minutes' and x.observed_at < k
         order by x.source, x.book, x.observed_at desc, x.quote_id asc
      ), used as (
        select * from c
         where lower(c.book) <> 'consensus' or not exists (select 1 from c r2 where lower(r2.book) <> 'consensus')
      )
      select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
             public.cfb_lab_median(array_agg(total_points)) as total_points,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
             public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
             max(observed_at) as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
             max(home_line) as best_home, -min(home_line) as best_away,
             'OBSERVED'::text as quality
        into r from used;
      if r.n = 0 then
        with c as (
          select distinct on (x.source, x.book) x.*
            from public.cfb_lab_game_quotes(g.game_id) x
           where x.market_type = m and x.is_provider_close
           order by x.source, x.book, x.observed_at desc, x.quote_id asc
        ), used as (
          select * from c
           where lower(c.book) <> 'consensus' or not exists (select 1 from c r2 where lower(r2.book) <> 'consensus')
        )
        select count(*) as n, public.cfb_lab_median(array_agg(home_line)) as home_line,
               public.cfb_lab_median(array_agg(total_points)) as total_points,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_over else price_home end)) as price_home,
               public.cfb_lab_median_price(array_agg(case when m = 'total' then price_under else price_away end)) as price_away,
               null::timestamptz as observed_at, array_agg(quote_id order by quote_id) as quote_ids,
               max(home_line) as best_home, -min(home_line) as best_away,
               'PROVIDER_DECLARED'::text as quality
          into r from used;
      end if;
      insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, home_line, total_points,
             price_home, price_away, observed_at, n_books, quality, best_line_home, best_line_away,
             rule_version, quote_ids, derived_at, kickoff_ts)
      values ('cfbl_' || public.cfb_lab_h(g.game_id, 'CLOSE', 'CONSENSUS', m, c_close), g.game_id, 'CLOSE', 'CONSENSUS', m,
              case when r.n > 0 and m = 'spread' then r.home_line end,
              case when r.n > 0 and m = 'total' then r.total_points end,
              case when r.n > 0 then r.price_home end,
              case when r.n > 0 then r.price_away end,
              case when r.n > 0 then r.observed_at end, r.n,
              case when r.n > 0 then r.quality else 'MISSING' end,
              case when r.n > 0 and m = 'spread' then r.best_home end,
              case when r.n > 0 and m = 'spread' then r.best_away end,
              c_close, coalesce(case when r.n > 0 then r.quote_ids end, '{}'::text[]), v_now, k)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_rows := v_rows + v_n;
      if v_n > 0 then
        if r.n = 0 then v_missing := v_missing + 1;
        elsif r.quality = 'OBSERVED' then v_obs := v_obs + 1;
        else v_decl := v_decl + 1; end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('games', v_games, 'rows_written', v_rows,
    'consensus_observed', v_obs, 'consensus_provider_declared', v_decl, 'consensus_missing', v_missing,
    'rule_versions', jsonb_build_object('open', c_open, 'close', c_close), 'p_now', p_now);
end $fn$;

-- ============================================================= model roles
-- cfb_lab_set_role(model, label, role, reason, actor): one role event and one
-- audit event (MODEL_PROMOTED for champion, MODEL_RETIRED for retired,
-- ROLE_CHANGED otherwise). Promoting a champion first demotes the sitting
-- champion to 'challenger' with its own role and audit events. Setting a
-- model to the role it already holds writes nothing.
-- Ids: role event 'cfbg_' + h('model_roles', model, role, effective_at, actor);
--      audit event 'cfbg_' + h('audit_log', event_type, model, created_at, actor).
create or replace function public.cfb_lab_set_role(p_model text, p_label text, p_role text, p_reason text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_prev   record;
  v_old    record;
  v_at     timestamptz;
  v_ev     text;
  v_events jsonb := '[]'::jsonb;
  v_demoted jsonb := '[]'::jsonb;
  v_type   text;
begin
  if coalesce(p_model, '') = '' then
    raise exception 'cfb_lab_set_role: a model_version is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_role is null or p_role not in ('champion','challenger','candidate','retired') then
    raise exception 'cfb_lab_set_role: role must be champion, challenger, candidate or retired' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(p_actor, '') = '' then
    raise exception 'cfb_lab_set_role: an actor is required (a person changes roles, never a job)' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfb_lab_set_role'));

  select r.* into v_prev from public.cfb_lab_model_roles r
   where r.model_version = p_model
   order by r.effective_at desc, r.recorded_at desc, r.event_id desc limit 1;
  if found and v_prev.role = p_role then
    return jsonb_build_object('ok', true, 'changed', false, 'model_version', p_model, 'role', p_role,
      'reason', 'already ' || p_role);
  end if;

  if p_role = 'champion' then
    for v_old in
      select c.* from (
        select distinct on (r.model_version) r.*
          from public.cfb_lab_model_roles r
         where r.model_version <> p_model
         order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc) c
       where c.role = 'champion'
    loop
      v_at := clock_timestamp();
      v_ev := 'cfbg_' || public.cfb_lab_h('model_roles', v_old.model_version, 'challenger', public.cfb_lab_ts(v_at), p_actor);
      insert into public.cfb_lab_model_roles (event_id, model_version, model_label, role, effective_at, reason, evidence_ref, actor, supersedes)
      values (v_ev, v_old.model_version, v_old.model_label, 'challenger', v_at,
              'demoted: ' || p_model || ' promoted to champion' || coalesce(' (' || p_reason || ')', ''), null, p_actor, v_old.event_id);
      insert into public.cfb_lab_audit_log (event_id, event_type, subject, before, after, reason, actor, created_at)
      values ('cfbg_' || public.cfb_lab_h('audit_log', 'ROLE_CHANGED', v_old.model_version, public.cfb_lab_ts(v_at), p_actor),
              'ROLE_CHANGED', v_old.model_version,
              jsonb_build_object('model_version', v_old.model_version, 'role', 'champion'),
              jsonb_build_object('model_version', v_old.model_version, 'role', 'challenger', 'role_event_id', v_ev),
              'demoted: ' || p_model || ' promoted to champion', p_actor, v_at);
      v_demoted := v_demoted || jsonb_build_array(v_old.model_version);
      v_events := v_events || jsonb_build_array(v_ev);
    end loop;
  end if;

  v_at := clock_timestamp();
  v_ev := 'cfbg_' || public.cfb_lab_h('model_roles', p_model, p_role, public.cfb_lab_ts(v_at), p_actor);
  insert into public.cfb_lab_model_roles (event_id, model_version, model_label, role, effective_at, reason, evidence_ref, actor, supersedes)
  values (v_ev, p_model, coalesce(p_label, v_prev.model_label), p_role, v_at, p_reason, null, p_actor, v_prev.event_id);
  v_type := case p_role when 'champion' then 'MODEL_PROMOTED' when 'retired' then 'MODEL_RETIRED' else 'ROLE_CHANGED' end;
  insert into public.cfb_lab_audit_log (event_id, event_type, subject, before, after, reason, actor, created_at)
  values ('cfbg_' || public.cfb_lab_h('audit_log', v_type, p_model, public.cfb_lab_ts(v_at), p_actor),
          v_type, p_model,
          case when v_prev.event_id is null then null
               else jsonb_build_object('model_version', p_model, 'role', v_prev.role) end,
          jsonb_build_object('model_version', p_model, 'role', p_role, 'model_label', coalesce(p_label, v_prev.model_label), 'role_event_id', v_ev),
          p_reason, p_actor, v_at);
  v_events := v_events || jsonb_build_array(v_ev);

  return jsonb_build_object('ok', true, 'changed', true, 'model_version', p_model, 'role', p_role,
    'previous_role', v_prev.role, 'demoted', v_demoted, 'role_events', v_events, 'audit_event_type', v_type);
end $fn$;

-- ================================================================== views
-- Internal views run as the caller (security_invoker): authenticated reads
-- them because it reads the tables; anon reads neither.
create or replace view public.cfb_lab_current_roles as
select distinct on (r.model_version) r.*
  from public.cfb_lab_model_roles r
 order by r.model_version, r.effective_at desc, r.recorded_at desc, r.event_id desc;

create or replace view public.cfb_lab_official_predictions as
select p.* from public.cfb_lab_predictions p
 where p.checkpoint_type = 'T24' and p.origin = 'LIVE';

create or replace view public.cfb_lab_current_results as
select distinct on (r.game_id) r.*
  from public.cfb_lab_results r
 where not exists (select 1 from public.cfb_lab_results s where s.supersedes = r.result_id)
 order by r.game_id, r.recorded_at desc, r.result_id desc;

create or replace view public.cfb_lab_current_evaluations as
select distinct on (e.prediction_id) e.*
  from public.cfb_lab_evaluations e
 order by e.prediction_id, e.evaluated_at desc, e.recorded_at desc, e.evaluation_id desc;

-- The latest ordinary pregame quote per source / book / game / market (quotes
-- that carry a game_id), and per game and market the median over them
-- (provider averages left out when a real book is quoted; for a total the
-- prices are the over and under). A reading aid; the lines table is the record.
create or replace view public.cfb_lab_consensus_now as
with latest as (
  select distinct on (q.source, q.book, q.game_id, q.market_type) q.*
    from public.cfb_lab_market_quotes q
   where q.game_id is not null and q.is_pregame and not q.is_provider_open and not q.is_provider_close
   order by q.source, q.book, q.game_id, q.market_type, q.observed_at desc, q.quote_id desc
), used as (
  select l.* from latest l
   where lower(l.book) <> 'consensus'
      or not exists (select 1 from latest r where r.game_id = l.game_id and r.market_type = l.market_type and lower(r.book) <> 'consensus')
)
select u.game_id, u.market_type,
       max(u.kickoff_ts) as kickoff_ts,
       count(*) as n_quotes,
       count(distinct u.source || ':' || u.book) as n_books,
       public.cfb_lab_median(array_agg(u.home_line)) as median_home_line,
       min(u.home_line) as min_home_line,
       max(u.home_line) as max_home_line,
       public.cfb_lab_median(array_agg(u.total_points)) as median_total_points,
       public.cfb_lab_median_price(array_agg(case when u.market_type = 'total' then u.price_over else u.price_home end)) as median_price_home,
       public.cfb_lab_median_price(array_agg(case when u.market_type = 'total' then u.price_under else u.price_away end)) as median_price_away,
       min(u.observed_at) as oldest_observed_at,
       max(u.observed_at) as as_of,
       array_agg(u.quote_id order by u.quote_id) as quote_ids
  from used u
 group by u.game_id, u.market_type;

-- THE PUBLIC RECORD — the only relation anon may read, with cfb_lab_public_summary.
-- One row per OFFICIAL (T24, LIVE) snapshot of a model that was champion when
-- the snapshot was taken, once it has an evaluation. Pregame numbers of a game
-- not yet graded never appear here. No internal field is exposed.
create or replace view public.cfb_lab_public_record as
select p.season, p.week, p.game_id, p.kickoff_ts, p.home_team, p.away_team, p.model_version,
       p.fair_spread_home_line, p.home_win_probability,
       e.final_home_points, e.final_away_points, e.abs_margin_error, e.brier_win, e.in_interval_80,
       p.decision_class, p.side, p.recommended_line, e.ats_result, e.clv_points
  from public.cfb_lab_predictions p
  join (select distinct on (x.prediction_id) x.*
          from public.cfb_lab_evaluations x
         order by x.prediction_id, x.evaluated_at desc, x.recorded_at desc, x.evaluation_id desc) e
    on e.prediction_id = p.prediction_id
 where p.checkpoint_type = 'T24' and p.origin = 'LIVE' and p.model_role = 'champion';

-- One row per season and one for all seasons (season NULL). VOID snapshots
-- count in n and nowhere else. Research positions are BET and LEAN.
create or replace view public.cfb_lab_public_summary as
with r as (
  select p.season, p.decision_class, e.void, e.abs_margin_error, e.brier_win, e.in_interval_80,
         e.ats_result, e.clv_points
    from public.cfb_lab_predictions p
    join (select distinct on (x.prediction_id) x.*
            from public.cfb_lab_evaluations x
           order by x.prediction_id, x.evaluated_at desc, x.recorded_at desc, x.evaluation_id desc) e
      on e.prediction_id = p.prediction_id
   where p.checkpoint_type = 'T24' and p.origin = 'LIVE' and p.model_role = 'champion'
)
select season,
       count(*)                                                                  as n,
       count(*) filter (where not void)                                          as n_settled,
       count(*) filter (where void)                                              as n_void,
       round(avg(abs_margin_error) filter (where not void), 3)                   as mae,
       round(sqrt(avg(abs_margin_error * abs_margin_error) filter (where not void)), 3) as rmse,
       round(avg(brier_win) filter (where not void), 4)                          as brier,
       round(avg(case when in_interval_80 then 1.0 else 0.0 end)
             filter (where not void and in_interval_80 is not null), 4)          as coverage_80,
       count(*) filter (where decision_class in ('BET','LEAN') and not void)     as research_positions,
       count(*) filter (where decision_class in ('BET','LEAN') and ats_result = 'WIN')  as ats_wins,
       count(*) filter (where decision_class in ('BET','LEAN') and ats_result = 'LOSS') as ats_losses,
       count(*) filter (where decision_class in ('BET','LEAN') and ats_result = 'PUSH') as ats_pushes,
       round(avg(clv_points) filter (where decision_class in ('BET','LEAN') and not void and clv_points is not null), 3) as mean_clv,
       round(avg(case when clv_points > 0 then 1.0 else 0.0 end)
             filter (where decision_class in ('BET','LEAN') and not void and clv_points is not null), 4) as positive_clv_share,
       count(*) filter (where decision_class in ('BET','LEAN') and not void and clv_points is not null) as n_clv,
       case when count(*) filter (where not void) < 30 then 'small sample'
            when count(*) filter (where not void) < 100 then 'provisional'
            else null end                                                        as sample_label
  from r
 group by grouping sets ((season), ());

do $blk$
declare v text;
begin
  foreach v in array array['cfb_lab_current_roles','cfb_lab_official_predictions','cfb_lab_current_results',
    'cfb_lab_current_evaluations','cfb_lab_consensus_now']
  loop
    execute format('alter view public.%I set (security_invoker = true)', v);
    execute format('revoke all on public.%I from public', v);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', v);
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select on public.%I to service_role', v);
    end if;
  end loop;
  foreach v in array array['cfb_lab_public_record','cfb_lab_public_summary']
  loop
    execute format('alter view public.%I set (security_invoker = false)', v);
    execute format('revoke all on public.%I from public', v);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', v);
      execute format('grant select on public.%I to anon', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', v);
      execute format('grant select on public.%I to authenticated', v);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select on public.%I to service_role', v);
    end if;
  end loop;
end $blk$;

-- ============================================================ function grants
-- The three writers are security definer: nobody but the service role (and the
-- owner, e.g. pg_cron) may call them. The helpers are pure and stay callable.
do $blk$
declare f text;
begin
  foreach f in array array['public.cfb_lab_ingest_quotes(jsonb)','public.cfb_lab_derive_lines(timestamptz)',
    'public.cfb_lab_set_role(text,text,text,text,text)','public.cfb_lab_game_kickoff(text)',
    'public.cfb_lab_game_quotes(text)','public.cfb_lab_append_only()','public.cfb_lab_predictions_guard()',
    'public.cfb_lab_lines_guard()','public.cfb_lab_results_guard()','public.cfb_lab_roles_guard()']
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $blk$;

-- PostgREST caches the schema; this makes the tables, views and functions
-- visible to it without a restart. Fires after commit.
notify pgrst, 'reload schema';

-- ================================================================= report
with tables(t) as (
  values ('cfb_lab_predictions'),('cfb_lab_market_quotes'),('cfb_lab_market_lines'),('cfb_lab_event_map'),
         ('cfb_lab_results'),('cfb_lab_evaluations'),('cfb_lab_miss_reviews'),('cfb_lab_model_roles'),
         ('cfb_lab_experiments'),('cfb_lab_audit_log'),('cfb_lab_partitions'),('cfb_lab_research_queue'),
         ('cfb_lab_reports')
), roles as (
  select exists (select 1 from pg_roles where rolname = 'anon') as has_anon,
         exists (select 1 from pg_roles where rolname = 'authenticated') as has_auth
)
select check_name, status from (
  select 1 as ord, 'table ' || t || ': exists, append-only (update/delete/truncate triggers), row level security' as check_name,
         case when to_regclass('public.' || t) is not null
               and (select count(*) from pg_trigger tg
                     where tg.tgrelid = to_regclass('public.' || t)
                       and tg.tgname in (t || '_no_update_trg', t || '_no_delete_trg', t || '_no_truncate_trg')) = 3
               and (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t))
              then 'ok' else 'CHECK THIS' end as status
    from tables
  union all
  select 2, 'validation triggers (prediction clock, CLOSE timing, result supersedes, one champion)',
         case when (select count(*) from pg_trigger where tgname in ('cfb_lab_predictions_guard_trg',
                     'cfb_lab_market_lines_guard_trg','cfb_lab_results_guard_trg','cfb_lab_model_roles_guard_trg')) = 4
              then 'ok' else 'CHECK THIS' end
  union all
  select 3, 'one prediction per game, model, checkpoint and origin (ADHOC excepted)',
         case when to_regclass('public.cfb_lab_pred_checkpoint_slot') is not null then 'ok' else 'CHECK THIS' end
  union all
  select 4, 'functions: cfb_lab_h, cfb_lab_ts, cfb_lab_num, cfb_lab_ingest_quotes, cfb_lab_derive_lines, cfb_lab_set_role',
         case when to_regprocedure('public.cfb_lab_h(text[])') is not null
               and to_regprocedure('public.cfb_lab_ts(timestamptz)') is not null
               and to_regprocedure('public.cfb_lab_num(numeric)') is not null
               and to_regprocedure('public.cfb_lab_ingest_quotes(jsonb)') is not null
               and to_regprocedure('public.cfb_lab_derive_lines(timestamptz)') is not null
               and to_regprocedure('public.cfb_lab_set_role(text,text,text,text,text)') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 5, 'views: current_roles, official_predictions, current_results, current_evaluations, consensus_now, public_record, public_summary',
         case when to_regclass('public.cfb_lab_current_roles') is not null
               and to_regclass('public.cfb_lab_official_predictions') is not null
               and to_regclass('public.cfb_lab_current_results') is not null
               and to_regclass('public.cfb_lab_current_evaluations') is not null
               and to_regclass('public.cfb_lab_consensus_now') is not null
               and to_regclass('public.cfb_lab_public_record') is not null
               and to_regclass('public.cfb_lab_public_summary') is not null
              then 'ok' else 'CHECK THIS' end
  union all
  select 6, 'anon can read cfb_lab_public_record and cfb_lab_public_summary (owner-run views)',
         case when not (select has_anon from roles) then 'CHECK THIS'
              when coalesce(has_table_privilege('anon', to_regclass('public.cfb_lab_public_record'), 'select'), false)
               and coalesce(has_table_privilege('anon', to_regclass('public.cfb_lab_public_summary'), 'select'), false)
               and (select count(*) from pg_class c
                     where c.oid in (to_regclass('public.cfb_lab_public_record'), to_regclass('public.cfb_lab_public_summary'))
                       and coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=false%') = 2
              then 'ok' else 'CHECK THIS' end
  union all
  select 7, 'anon can read no cfb_lab_ table and no internal view',
         case when not (select has_anon from roles) then 'CHECK THIS'
              when not exists (select 1 from tables
                                where coalesce(has_table_privilege('anon', to_regclass('public.' || t), 'select'), true))
               and not exists (select 1 from unnest(array['cfb_lab_current_roles','cfb_lab_official_predictions',
                                 'cfb_lab_current_results','cfb_lab_current_evaluations','cfb_lab_consensus_now']) v
                                where coalesce(has_table_privilege('anon', to_regclass('public.' || v), 'select'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 8, 'authenticated reads every cfb_lab_ table and writes none',
         case when not (select has_auth from roles) then 'CHECK THIS'
              when not exists (select 1 from tables
                                where not coalesce(has_table_privilege('authenticated', to_regclass('public.' || t), 'select'), false)
                                   or coalesce(has_table_privilege('authenticated', to_regclass('public.' || t), 'insert,update,delete,truncate'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 9, 'the writer functions are not callable by anon or authenticated',
         case when not (select has_anon and has_auth from roles) then 'CHECK THIS'
              when not exists (
                select 1 from unnest(array['public.cfb_lab_ingest_quotes(jsonb)','public.cfb_lab_derive_lines(timestamptz)',
                                           'public.cfb_lab_set_role(text,text,text,text,text)']) f, unnest(array['anon','authenticated']) r
                 where coalesce(has_function_privilege(r, to_regprocedure(f), 'execute'), true))
              then 'ok' else 'CHECK THIS' end
  union all
  select 10, 'id hash self-check: cfb_lab_h(''a'', null, ''-3.5'') = 899792685a3d892fa74c18f2 (sha256 of ''a||-3.5'')',
         case when public.cfb_lab_h('a', null, '-3.5') = '899792685a3d892fa74c18f2' then 'ok' else 'CHECK THIS' end
  union all
  select 11, 'rendering self-check: -3.50 -> -3.5, 110.00 -> 110, 0.00 -> 0, timestamps in UTC with milliseconds',
         case when public.cfb_lab_num(-3.50) = '-3.5' and public.cfb_lab_num(110.00) = '110' and public.cfb_lab_num(0.00) = '0'
               and public.cfb_lab_ts('2025-10-04 15:30:00-04'::timestamptz) = '2025-10-04T19:30:00.000Z'
              then 'ok' else 'CHECK THIS' end
  union all
  select 12, 'median self-check: lines -3 and -3.5 -> -3.25; prices -105 and +105 -> +100, -110 and -105 -> -107 (decimal-odds space)',
         case when public.cfb_lab_median(array[-3, -3.5]::numeric[]) = -3.25
               and public.cfb_lab_median_price(array[-105, 105]) = 100
               and public.cfb_lab_median_price(array[-110, -105]) = -107
              then 'ok' else 'CHECK THIS' end
) x
order by ord, check_name;

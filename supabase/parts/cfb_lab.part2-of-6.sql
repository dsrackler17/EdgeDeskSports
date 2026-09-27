-- cfb_lab -- part 2 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

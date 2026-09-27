-- cfb_lab -- part 2 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

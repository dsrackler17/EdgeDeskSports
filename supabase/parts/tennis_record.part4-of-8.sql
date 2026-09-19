-- tennis_record -- part 4 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

create or replace view tennis.player_career
with (security_invoker = true) as
  select player_id,
         count(*) filter (where won)          ::integer as wins,
         count(*) filter (where not won)      ::integer as losses,
         count(*)                             ::integer as matches,
         round(avg(case when won then 1.0 else 0.0 end)::numeric, 4) as win_pct,
         min(match_date) as first_match,
         max(match_date) as last_match
    from tennis.player_match_rows
   group by player_id;

create or replace view tennis.player_season
with (security_invoker = true) as
  select player_id, season,
         count(*) filter (where won)     ::integer as wins,
         count(*) filter (where not won) ::integer as losses,
         count(*)                        ::integer as matches,
         round(avg(case when won then 1.0 else 0.0 end)::numeric, 4) as win_pct
    from tennis.player_match_rows
   where season is not null
   group by player_id, season;

create or replace view tennis.player_surface
with (security_invoker = true) as
  select player_id, surface, season,
         count(*) filter (where won)     ::integer as wins,
         count(*) filter (where not won) ::integer as losses,
         count(*)                        ::integer as matches,
         round(avg(case when won then 1.0 else 0.0 end)::numeric, 4) as win_pct
    from tennis.player_match_rows
   where surface is not null and surface <> 'unknown'
   group by player_id, surface, season;

create or replace view tennis.player_form
with (security_invoker = true) as
  select player_id, match_date, opponent_id, won, surface, tourney_name, round,
         match_id, tour, level, score, minutes
    from tennis.player_match_rows
   where match_date is not null;

create or replace view tennis.h2h
with (security_invoker = true) as
  select player_id, opponent_id,
         count(*) filter (where won)     ::integer as wins,
         count(*) filter (where not won) ::integer as losses,
         count(*)                        ::integer as matches,
         max(match_date) as last_meeting,
         min(match_date) as first_meeting
    from tennis.player_match_rows
   where opponent_id is not null
   group by player_id, opponent_id;

-- ===========================================================================
-- LAYER 11b — WEATHER. Separated from venue identity on purpose.
--
-- THE ARCHIVE'S WEATHER IS A TOURNAMENT-WEEK PROFILE, NOT MATCH-TIME WEATHER.
-- The source dates a match to its tournament week, so the reanalysis attached
-- to it covers seven days around an event, not the hour of first serve.
-- `temporal_precision` says so on every row, and nothing downstream may present
-- a 'tournament_week' observation as conditions at the toss. Indoor events get
-- no weather at all — not a null that looks like missing data, but an explicit
-- 'indoor' precision saying weather is irrelevant rather than absent.
-- ===========================================================================
create table if not exists tennis.weather_observations (
  observation_id      bigserial primary key,
  venue_id            text references tennis.venues (venue_id) on delete cascade,
  tournament_id       text references tennis.tournaments (tournament_id) on delete cascade,
  source_key          text not null default 'open-meteo',
  observed_on         date not null,
  window_start        date,
  window_end          date,
  temporal_precision  text not null default 'tournament_week',
  temp_mean_f         numeric(5,2),
  temp_max_f          numeric(5,2),
  temp_min_f          numeric(5,2),
  humidity_mean_pct   numeric(5,2),
  precip_in           numeric(6,3),
  wind_mean_mph       numeric(5,2),
  gust_max_mph        numeric(5,2),
  solar_mj_m2         numeric(7,3),
  days_covered        integer,
  venue_confidence    text,
  quality             text not null default 'unknown',
  ingestion_run_id    uuid references tennis.ingestion_runs (run_id) on delete set null,
  ingested_at         timestamptz not null default now(),
  constraint tennis_weather_precision_shape
    check (temporal_precision in ('hourly','daily','tournament_week','indoor','unknown')),
  constraint tennis_weather_quality_shape
    check (quality in ('high','usable','low','unusable','unknown')),
  constraint tennis_weather_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create unique index if not exists tennis_weather_unique_idx on tennis.weather_observations
  (coalesce(venue_id, ''), coalesce(tournament_id, ''), source_key, observed_on);
create index if not exists tennis_weather_venue_idx on tennis.weather_observations (venue_id, observed_on desc);
create index if not exists tennis_weather_tournament_idx on tennis.weather_observations (tournament_id);

-- Is this weather observation fit to influence a model or a screen? One rule,
-- in one place, so the importer, the model and the page cannot disagree.
create or replace function tennis.weather_is_usable(
  p_environment text, p_precision text, p_confidence text, p_quality text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_environment, 'unknown') = 'outdoor'
     and coalesce(p_precision, 'unknown') in ('hourly','daily','tournament_week')
     and coalesce(p_confidence, 'unknown') in ('exact','high','name_inferred')
     and coalesce(p_quality, 'unknown') in ('high','usable');
$$;
grant execute on function tennis.weather_is_usable(text, text, text, text) to anon, authenticated, service_role;

-- ===========================================================================
-- LAYER 6 — MARKET ODDS.
--
-- The live contract already stores tennis price observations in
-- tennis.market_captures, tagged PRE or LIVE against the match's own first
-- point. That table is not replaced and not altered. This one is the
-- NORMALISED market surface the model and the research layer read: one row per
-- (match, book, market, selection, capture), with both American and decimal
-- odds and the implied probability spelled out, so nothing downstream has to
-- re-derive a price format.
-- ===========================================================================
create table if not exists tennis.odds_snapshots (
  snapshot_id      bigserial primary key,
  match_scope      text not null default 'live',   -- 'live' (a fixture) or 'archive' (a settled match)
  match_ref        text not null,                  -- tennis.live_matches.match_id or tennis.matches.match_id
  event_id         text,                           -- the odds feed's own fixture id
  tour             text,
  sportsbook       text not null,
  book_trusted     boolean,
  market_type      text not null,
  selection        text not null,
  selection_player_id text references tennis.players (player_id) on delete set null,
  line             numeric(7,2),                   -- spread in games / total games
  odds_american    integer,
  odds_decimal     numeric(10,4),
  implied_prob     numeric(6,5),
  no_vig_prob      numeric(6,5),
  market_state     text not null default 'current',
  market_status    text not null default 'open',
  captured_at      timestamptz not null default now(),
  source_key       text not null default 'odds_api',
  source_updated_at timestamptz,
  ingestion_run_id uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_odds_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_odds_market_shape check (market_type in
    ('match_winner','game_spread','total_games','set_betting','set_spread','player_prop')),
  constraint tennis_odds_state_shape check (market_state in ('opening','current','closing')),
  constraint tennis_odds_status_shape check (market_status in ('open','suspended','settled','void')),
  constraint tennis_odds_prob_shape check (implied_prob is null or (implied_prob > 0 and implied_prob < 1)),
  constraint tennis_odds_decimal_shape check (odds_decimal is null or odds_decimal > 1),
  constraint tennis_odds_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
-- A price is a price AT A MOMENT. Re-capturing the same moment is a no-op; a
-- new moment is a new row, and nothing is ever overwritten. This is a unique
-- INDEX rather than a table constraint because `line` is nullable and a plain
-- UNIQUE treats two nulls as distinct — which would let the same match-winner
-- price be captured twice at the same instant.
create unique index if not exists tennis_odds_unique_idx on tennis.odds_snapshots
  (match_scope, match_ref, sportsbook, market_type, selection, coalesce(line, -99999), captured_at);
create index if not exists tennis_odds_match_idx on tennis.odds_snapshots (match_scope, match_ref, captured_at desc);
create index if not exists tennis_odds_market_idx on tennis.odds_snapshots (market_type, captured_at desc);
create index if not exists tennis_odds_state_idx on tennis.odds_snapshots (match_ref, market_state, captured_at desc);
create index if not exists tennis_odds_book_idx on tennis.odds_snapshots (sportsbook, captured_at desc);

-- ===========================================================================
-- LAYER 7 — MODEL REGISTRY and PREDICTIONS.
--
-- A model version is IMMUTABLE. Its evaluation is what it scored on the window
-- it was measured over; rewriting that later would make every published number
-- unverifiable. The registry's mutable surface is exactly two columns —
-- `status` and `rollback_target` — and a trigger refuses every other change.
-- ===========================================================================
create table if not exists tennis.model_registry (
  model_version      text primary key,              -- 'tennis-baseline-1.0.0'
  family             text not null default 'tennis_match_winner',
  feature_version    text not null,
  algorithm          text,
  description        text,
  training_cutoff    date not null,
  train_from         date,
  train_to           date,
  valid_from         date,
  valid_to           date,
  eval_from          date,
  eval_to            date,
  train_rows         bigint,
  valid_rows         bigint,
  eval_rows          bigint,
  coefficients       jsonb not null default '{}'::jsonb,
  eval_results       jsonb not null default '{}'::jsonb,
  calibration        jsonb not null default '{}'::jsonb,
  baseline_comparison jsonb not null default '{}'::jsonb,
  status             text not null default 'candidate',
  rollback_target    text references tennis.model_registry (model_version) on delete set null,
  activated_at       timestamptz,
  retired_at         timestamptz,
  deployed_at        timestamptz,
  created_by         text,
  build_version      text,
  source_key         text not null default 'edgedesk',
  created_at         timestamptz not null default now(),
  constraint tennis_model_status_shape
    check (status in ('candidate','shadow','active','retired','rejected')),
  constraint tennis_model_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
create index if not exists tennis_model_status_idx on tennis.model_registry (family, status, created_at desc);
-- AT MOST ONE ACTIVE MODEL PER FAMILY. Two active versions would mean two fair
-- prices for the same match with nothing to say which one the record is kept
-- against.
create unique index if not exists tennis_model_one_active_idx
  on tennis.model_registry (family) where status = 'active';

create or replace function tennis.freeze_model_version()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.model_registry rows are immutable: a model version cannot be deleted',
      hint = 'Set status = ''retired'' instead. The published record is kept against this version.';
  end if;
  if new.model_version is distinct from old.model_version
     or new.feature_version is distinct from old.feature_version
     or new.training_cutoff is distinct from old.training_cutoff
     or new.train_from is distinct from old.train_from
     or new.train_to is distinct from old.train_to
     or new.eval_from is distinct from old.eval_from
     or new.eval_to is distinct from old.eval_to
     or new.coefficients is distinct from old.coefficients
     or new.eval_results is distinct from old.eval_results
     or new.calibration is distinct from old.calibration then
    raise exception using errcode = 'restrict_violation',
      message = 'tennis.model_registry: version, features, windows, coefficients and evaluation are immutable',
      hint = 'Register a NEW model_version. Only status, rollback_target, '
             'activated_at, retired_at and deployed_at may change.';
  end if;
  return new;
end $$;
drop trigger if exists tennis_model_freeze on tennis.model_registry;
create trigger tennis_model_freeze before update or delete on tennis.model_registry
  for each row execute function tennis.freeze_model_version();

-- PREDICTIONS. Append-only. A prediction is a claim made at a moment with the
-- information available then; editing one after the result is known is how a
-- public record becomes fiction.
create table if not exists tennis.model_predictions (
  prediction_id        uuid primary key default gen_random_uuid(),
  match_scope          text not null default 'live',
  match_ref            text not null,
  tour                 text,
  model_version        text not null references tennis.model_registry (model_version) on delete restrict,
  feature_version      text,
  generated_at         timestamptz not null default now(),
  -- sides, named rather than positional
  player_a_id          text references tennis.players (player_id) on delete set null,
  player_b_id          text references tennis.players (player_id) on delete set null,
  player_a_name        text,
  player_b_name        text,
  prob_a               numeric(6,5),
  prob_b               numeric(6,5),
  fair_odds_a_decimal  numeric(10,4),
  fair_odds_b_decimal  numeric(10,4),
  fair_odds_a_american integer,
  fair_odds_b_american integer,
  projected_spread     numeric(6,2),
  projected_total      numeric(6,2),
  confidence           numeric(4,3),
  uncertainty          numeric(4,3),
  feature_snapshot_at  timestamptz,
  market_snapshot_id   bigint references tennis.odds_snapshots (snapshot_id) on delete set null,
  market_prob_a        numeric(6,5),
  market_prob_b        numeric(6,5),
  edge_a               numeric(7,5),
  edge_b               numeric(7,5),
  ev_a                 numeric(8,5),
  ev_b                 numeric(8,5),
  research_grade       text not null default 'ungraded',
  exclusion_reasons    text[] not null default '{}'::text[],
  calibration_bucket   text,
  inputs               jsonb not null default '{}'::jsonb,
  missing_inputs       text[] not null default '{}'::text[],
  source_key           text not null default 'edgedesk',
  ingestion_run_id     uuid references tennis.ingestion_runs (run_id) on delete set null,
  constraint tennis_pred_scope_shape check (match_scope in ('live','archive')),
  constraint tennis_pred_prob_shape check (prob_a is null or (prob_a > 0 and prob_a < 1)),
  constraint tennis_pred_probs_sum check
    (prob_a is null or prob_b is null or abs((prob_a + prob_b) - 1) < 0.0005),
  constraint tennis_pred_grade_shape
    check (research_grade in ('ungraded','research','provisional','excluded')),
  constraint tennis_pred_conf_shape check (confidence is null or (confidence between 0 and 1)),
  constraint tennis_pred_unc_shape check (uncertainty is null or (uncertainty between 0 and 1)),
  constraint tennis_pred_source_fk
    foreign key (source_key) references tennis.source_licenses (source_key) on delete restrict
);
-- Re-running the same model over the same features and the same market snapshot
-- is a no-op rather than a second row. A unique INDEX with coalesce, not a
-- UNIQUE constraint: both snapshot columns are nullable and two nulls would
-- otherwise be distinct, so a model re-run before any market existed would
-- write a second prediction every time.
create unique index if not exists tennis_pred_unique_idx on tennis.model_predictions
  (match_scope, match_ref, model_version,
   coalesce(feature_snapshot_at, '-infinity'::timestamptz),
   coalesce(market_snapshot_id, -1));
create index if not exists tennis_pred_match_idx  on tennis.model_predictions (match_scope, match_ref, generated_at desc);
create index if not exists tennis_pred_model_idx  on tennis.model_predictions (model_version, generated_at desc);
create index if not exists tennis_pred_grade_idx  on tennis.model_predictions (research_grade, generated_at desc);
create index if not exists tennis_pred_tour_idx   on tennis.model_predictions (tour, generated_at desc);

create or replace function tennis.freeze_prediction()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = 'restrict_violation',
    message = 'tennis.model_predictions is append-only: a prediction cannot be '
              || lower(tg_op) || 'd after it is written',
    hint = 'Write a new prediction row. The research layer '
           '(tennis.research_opportunities) is the mutable surface; the '
           'prediction that produced it is evidence and stays as it was.';
end $$;
drop trigger if exists tennis_pred_freeze on tennis.model_predictions;
create trigger tennis_pred_freeze before update or delete on tennis.model_predictions
  for each row execute function tennis.freeze_prediction();

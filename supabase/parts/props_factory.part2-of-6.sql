-- props_factory -- part 2 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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

-- cfb_lab -- part 1 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
  -- the MAJOR-DISAGREEMENT INTEGRITY GATE's verdict on this snapshot
  -- (lib/cfb_disagreement.js; docs/cfb-disagreement/DESIGN.md). The raw gap is
  -- model_market_gap; the verified gap is set only when every check passed.
  disagreement_version       text,
  disagreement_status        text,
  disagreement_tier          text,
  verified_market_gap        numeric(7,3),
  calibrated_market_gap      numeric(7,3),
  disagreement_root_cause    text,
  disagreement_checks        jsonb,
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
    or (checkpoint_type = 'T24' and origin = 'LIVE')),
  constraint cfb_lab_pred_disagreement_status check (disagreement_status is null or disagreement_status in
    ('MARKET_ALIGNED','WORTH_RESEARCHING','INVESTIGATE','MARKET_FAULT','DATA_FAULT','VERIFIED_MAJOR_DISAGREEMENT')),
  constraint cfb_lab_pred_verified_gap check (verified_market_gap is null
    or (disagreement_status = 'VERIFIED_MAJOR_DISAGREEMENT' and model_market_gap is not null
        and abs(verified_market_gap - model_market_gap) < 0.001 and abs(model_market_gap) >= 7))
);
comment on table public.cfb_lab_predictions is
  'CFB Model Lab live prediction ledger: one row per model per game per checkpoint (SCHEMA.md §1). Append-only.';

-- 1b. The major-disagreement gate's verdict, added after the first deployment.
--     Idempotent for a table that predates it; a fresh table already has it.
alter table public.cfb_lab_predictions add column if not exists disagreement_version text;
alter table public.cfb_lab_predictions add column if not exists disagreement_status text;
alter table public.cfb_lab_predictions add column if not exists disagreement_tier text;
alter table public.cfb_lab_predictions add column if not exists verified_market_gap numeric(7,3);
alter table public.cfb_lab_predictions add column if not exists calibrated_market_gap numeric(7,3);
alter table public.cfb_lab_predictions add column if not exists disagreement_root_cause text;
alter table public.cfb_lab_predictions add column if not exists disagreement_checks jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cfb_lab_pred_disagreement_status') then
    alter table public.cfb_lab_predictions add constraint cfb_lab_pred_disagreement_status check (disagreement_status is null
      or disagreement_status in ('MARKET_ALIGNED','WORTH_RESEARCHING','INVESTIGATE','MARKET_FAULT','DATA_FAULT','VERIFIED_MAJOR_DISAGREEMENT'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cfb_lab_pred_verified_gap') then
    alter table public.cfb_lab_predictions add constraint cfb_lab_pred_verified_gap check (verified_market_gap is null
      or (disagreement_status = 'VERIFIED_MAJOR_DISAGREEMENT' and model_market_gap is not null
          and abs(verified_market_gap - model_market_gap) < 0.001 and abs(model_market_gap) >= 7));
  end if;
end $$;

-- =============================================================================
-- bankroll_settings + stake_recommendations — the risk policy, and the
-- immutable audit trail of every position EdgeDesk sized.
--
-- WHAT THIS IS
--   Two tables and one log, plus the views that grade them.
--
--   bankroll_settings              one MUTABLE row per reader: the bankroll,
--                                  the base unit, every exposure cap, the
--                                  Kelly multiplier, parlay permission and the
--                                  books they can actually bet at.
--   stake_recommendations          one WRITE-ONCE row per recommendation the
--                                  staking engine produced — BET, WATCH, PASS
--                                  and RESEARCH_ONLY alike — carrying the
--                                  price, every probability, the Kelly
--                                  arithmetic, the units, the exposure before
--                                  and after, the reason for a PASS, and the
--                                  whole snapshot as JSON.
--   stake_recommendation_responses APPEND-ONLY: whether the reader accepted
--                                  the recommendation, and at what size. It is
--                                  a separate table on purpose, so recording
--                                  what someone did cannot rewrite what
--                                  EdgeDesk said.
--
-- WHY THE SPLIT
--   Every claim about whether this sizing engine works is a claim about what
--   it said BEFORE the game, at the price that was on the board at the time.
--   A snapshot that can be edited after the market moves cannot support that
--   claim, so the snapshot is frozen by a trigger and the mutable parts —
--   the settings, the reader's response — live elsewhere. A later view of the
--   same wager is a NEW ROW, never an UPDATE.
--
-- THE RULES, ENFORCED BY THE SERVER
--   1. Write once. Every column of stake_recommendations is frozen after
--      insert by a trigger.
--   2. No deletes. A recommendation that embarrasses the engine stays.
--   3. A forward record cannot postdate kickoff, so nothing produced after a
--      game can masquerade as a pre-game position.
--   4. Units are inside the policy: a stake cannot be recorded above the
--      maximum this file allows, and a BET cannot be recorded at zero units.
--   5. Row level security everywhere: a reader reads and writes their own
--      rows; the service role reads everything for grading.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE RISK POLICY
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.bankroll_settings (
  user_id                       uuid primary key default auth.uid(),
  schema                        text        not null default 'edgedesk_bankroll_policy_v1',
  -- money. NULL bankroll is a real state and is never defaulted: the engine
  -- answers in units and says an exact dollar figure needs this column.
  bankroll_amount               numeric     null check (bankroll_amount is null or bankroll_amount > 0),
  base_unit_amount              numeric     null check (base_unit_amount is null or base_unit_amount > 0),
  -- the caps, in units
  maximum_single_wager_units    numeric     not null default 1.00  check (maximum_single_wager_units > 0),
  maximum_game_exposure_units   numeric     not null default 1.25  check (maximum_game_exposure_units > 0),
  maximum_team_exposure_units   numeric     not null default 1.50  check (maximum_team_exposure_units > 0),
  maximum_daily_exposure_units  numeric     not null default 4.00  check (maximum_daily_exposure_units > 0),
  maximum_weekly_exposure_units numeric     not null default 8.00  check (maximum_weekly_exposure_units > 0),
  -- the staking rule
  fractional_kelly_multiplier   numeric     not null default 0.25  check (fractional_kelly_multiplier > 0 and fractional_kelly_multiplier <= 1),
  allowed_unit_sizes            numeric[]   not null default array[0, 0.25, 0.50, 0.75, 1.00]::numeric[],
  minimum_unit_size             numeric     not null default 0.25  check (minimum_unit_size > 0),
  -- the floors a wager must clear before it is sized at all
  minimum_data_completeness     numeric     not null default 0.50  check (minimum_data_completeness >= 0 and minimum_data_completeness <= 1),
  minimum_reliability           numeric     not null default 0.35  check (minimum_reliability >= 0 and minimum_reliability <= 1),
  minimum_book_families         numeric     not null default 2     check (minimum_book_families >= 0),
  minimum_conservative_ev       numeric     not null default 0     check (minimum_conservative_ev >= 0),
  -- scope
  preferred_sports              text[]      null,
  sportsbook_availability       text[]      null,
  -- parlays: off until the reader turns them on
  parlay_permission             boolean     not null default false,
  minimum_parlay_stake_units    numeric     not null default 0.10  check (minimum_parlay_stake_units > 0),
  maximum_parlay_stake_units    numeric     not null default 0.25  check (maximum_parlay_stake_units > 0),
  maximum_parlay_legs           int         not null default 3     check (maximum_parlay_legs between 2 and 3),
  maximum_positions_per_team    int         not null default 2     check (maximum_positions_per_team >= 1),
  allow_second_market_per_game  boolean     not null default true,
  tier_unit_cap                 jsonb       null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- the caps must be internally coherent, or they are not caps
  constraint bankroll_settings_single_within_game check (maximum_single_wager_units <= maximum_game_exposure_units),
  constraint bankroll_settings_game_within_team   check (maximum_game_exposure_units <= maximum_team_exposure_units),
  constraint bankroll_settings_team_within_daily  check (maximum_team_exposure_units <= maximum_daily_exposure_units),
  constraint bankroll_settings_daily_within_week  check (maximum_daily_exposure_units <= maximum_weekly_exposure_units),
  constraint bankroll_settings_parlay_band        check (minimum_parlay_stake_units <= maximum_parlay_stake_units)
);

comment on table public.bankroll_settings is
  'One row per reader: the bankroll, the base unit and every exposure cap the staking engine obeys. bankroll_amount is deliberately nullable — EdgeDesk answers in units and refuses to assume a bankroll.';
comment on column public.bankroll_settings.bankroll_amount is
  'NULL means no bankroll is on file. The engine then sizes in units under the stated one-unit-is-1%-of-bankroll convention and says an exact dollar amount needs this column. It is never defaulted.';

-- additive columns for a table that already exists from an earlier paste
alter table public.bankroll_settings add column if not exists tier_unit_cap jsonb null;
alter table public.bankroll_settings add column if not exists allow_second_market_per_game boolean not null default true;
alter table public.bankroll_settings add column if not exists minimum_conservative_ev numeric not null default 0;

create or replace function public.bankroll_settings_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.user_id := coalesce(new.user_id, old.user_id);
  new.created_at := coalesce(old.created_at, new.created_at, now());
  return new;
end $$;
drop trigger if exists bankroll_settings_touch_trg on public.bankroll_settings;
create trigger bankroll_settings_touch_trg before update on public.bankroll_settings
  for each row execute function public.bankroll_settings_touch();

alter table public.bankroll_settings enable row level security;
drop policy if exists bankroll_settings_select_own on public.bankroll_settings;
create policy bankroll_settings_select_own on public.bankroll_settings for select
  using (user_id = auth.uid());
drop policy if exists bankroll_settings_insert_own on public.bankroll_settings;
create policy bankroll_settings_insert_own on public.bankroll_settings for insert
  with check (user_id = auth.uid());
drop policy if exists bankroll_settings_update_own on public.bankroll_settings;
create policy bankroll_settings_update_own on public.bankroll_settings for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Settings may be corrected by their owner; they are not a measurement. The
-- MEASUREMENT is stake_recommendations below, which cannot be touched at all.
drop policy if exists bankroll_settings_delete_own on public.bankroll_settings;
create policy bankroll_settings_delete_own on public.bankroll_settings for delete
  using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE AUDIT TRAIL
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.stake_recommendations (
  id                        bigint generated always as identity primary key,
  recommendation_id         text        not null unique,
  card_id                   text        null,
  snapshot_hash             text        not null,
  schema                    text        not null default 'edgedesk_stake_record_v1',
  user_id                   uuid        not null default auth.uid(),
  created_at                timestamptz not null default now(),
  built_at                  timestamptz not null,
  -- the event and the exact market
  sport                     text        null,
  game_id                   text        null,
  matchup                   text        null,
  kickoff                   timestamptz null,
  market                    text        null,
  selection                 text        null,
  side                      text        null,
  handicap                  numeric     null,
  -- the price, exactly as it was available
  odds_american             numeric     null,
  odds_decimal              numeric     null,
  book                      text        null,
  price_captured_at         timestamptz null,
  price_age_seconds         numeric     null,
  price_freshness           text        null,
  -- every probability, each one named
  model_probability         numeric     null,
  calibrated_probability    numeric     null,
  conservative_probability  numeric     null,
  conservative_method       text        null,
  no_vig_market_probability numeric     null,
  -- the arithmetic
  model_edge                numeric     null,
  conservative_edge         numeric     null,
  expected_value            numeric     null,
  fair_odds                 numeric     null,
  reliability_score         numeric     null,
  raw_kelly_fraction        numeric     null,
  fractional_kelly_fraction numeric     null,
  -- the position
  recommended_units         numeric     null check (recommended_units is null or recommended_units >= 0),
  recommended_dollars       numeric     null,
  recommendation_tier       text        null check (recommendation_tier is null or recommendation_tier in ('PASS','SMALL','STANDARD','STRONG','MAX MODEL POSITION','SIZED')),
  exposure_before_units     numeric     null,
  exposure_after_units      numeric     null,
  -- the versions that produced it
  model_version             text        null,
  calibration_version       text        null,
  kernel_version            int         null,
  -- the verdict
  status                    text        not null check (status in ('BET','WATCH','PASS','RESEARCH_ONLY')),
  kind                      text        not null default 'RECOMMENDATION' check (kind in ('RECOMMENDATION','WATCH','PASS','RESEARCH_ONLY')),
  pass_reason               text        null,
  -- the policy in force at the time
  bankroll_amount           numeric     null,
  base_unit_amount          numeric     null,
  -- joins and provenance
  sig_key                   text        null,
  question                  text        null,
  snapshot                  jsonb       null,
  -- RULE 4, stated as a constraint: a BET is never zero units, and a
  -- non-BET is never sized. The engine already enforces it; a table that
  -- cannot hold the contradiction cannot drift from it.
  constraint stake_bet_is_sized      check (status <> 'BET' or (recommended_units is not null and recommended_units > 0)),
  constraint stake_non_bet_unsized   check (status = 'BET' or coalesce(recommended_units, 0) = 0),
  constraint stake_units_within_policy check (coalesce(recommended_units, 0) <= 10)
);

comment on table public.stake_recommendations is
  'Immutable snapshots of every position EdgeDesk sized, PASS included. Never edited, never deleted; a later view of the same wager is a new row. Joined to signals by sig_key for the close, CLV and the result.';

create index if not exists stake_recommendations_user_idx on public.stake_recommendations (user_id, created_at desc);
create index if not exists stake_recommendations_game_idx on public.stake_recommendations (sport, game_id, built_at desc);
create index if not exists stake_recommendations_card_idx on public.stake_recommendations (card_id) where card_id is not null;
create index if not exists stake_recommendations_sig_idx on public.stake_recommendations (sig_key) where sig_key is not null;
create index if not exists stake_recommendations_status_idx on public.stake_recommendations (status, built_at desc);

-- WRITE ONCE. Every column frozen after insert.
create or replace function public.stake_recommendations_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'stake_recommendations is write-once: recommendation % was recorded at % and cannot be updated. Record a new row instead.', old.recommendation_id, old.created_at;
end $$;
drop trigger if exists stake_recommendations_immutable_trg on public.stake_recommendations;
create trigger stake_recommendations_immutable_trg before update on public.stake_recommendations
  for each row execute function public.stake_recommendations_immutable();

-- NO DELETES.
create or replace function public.stake_recommendations_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'stake_recommendations rows are never deleted: recommendation % is part of the record of what EdgeDesk said.', old.recommendation_id;
end $$;
drop trigger if exists stake_recommendations_no_delete_trg on public.stake_recommendations;
create trigger stake_recommendations_no_delete_trg before delete on public.stake_recommendations
  for each row execute function public.stake_recommendations_no_delete();

-- NO LOOK-AHEAD. A position recorded after kickoff is not a position.
create or replace function public.stake_recommendations_no_lookahead() returns trigger
language plpgsql as $$
begin
  if new.kickoff is not null and new.built_at is not null and new.built_at >= new.kickoff then
    raise exception 'a forward stake recommendation cannot postdate kickoff: built_at % is at or after kickoff % for %', new.built_at, new.kickoff, new.recommendation_id;
  end if;
  return new;
end $$;
drop trigger if exists stake_recommendations_no_lookahead_trg on public.stake_recommendations;
create trigger stake_recommendations_no_lookahead_trg before insert on public.stake_recommendations
  for each row execute function public.stake_recommendations_no_lookahead();

alter table public.stake_recommendations enable row level security;
drop policy if exists stake_recommendations_select_own on public.stake_recommendations;
create policy stake_recommendations_select_own on public.stake_recommendations for select
  using (user_id = auth.uid());
drop policy if exists stake_recommendations_insert_own on public.stake_recommendations;
create policy stake_recommendations_insert_own on public.stake_recommendations for insert
  with check (user_id = auth.uid());
-- No update or delete policy exists, and the triggers refuse both regardless.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. WHAT THE READER DID ABOUT IT (append-only, separate on purpose)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.stake_recommendation_responses (
  id                 bigint generated always as identity primary key,
  recommendation_id  text        not null,
  user_id            uuid        not null default auth.uid(),
  responded_at       timestamptz not null default now(),
  response           text        not null check (response in ('ACCEPTED','DECLINED','MODIFIED','EXPIRED')),
  accepted_units     numeric     null check (accepted_units is null or accepted_units >= 0),
  accepted_dollars   numeric     null,
  accepted_odds      numeric     null,
  accepted_book      text        null,
  note               text        null
);
comment on table public.stake_recommendation_responses is
  'Append-only log of whether the reader accepted a recommendation and at what size. Separate from the snapshot so recording behaviour can never rewrite what EdgeDesk said.';
create index if not exists stake_responses_rec_idx on public.stake_recommendation_responses (recommendation_id, responded_at desc);
create index if not exists stake_responses_user_idx on public.stake_recommendation_responses (user_id, responded_at desc);

create or replace function public.stake_responses_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'stake_recommendation_responses is append-only: record a new response row instead of editing %.', old.id;
end $$;
drop trigger if exists stake_responses_append_only_trg on public.stake_recommendation_responses;
create trigger stake_responses_append_only_trg before update or delete on public.stake_recommendation_responses
  for each row execute function public.stake_responses_append_only();

alter table public.stake_recommendation_responses enable row level security;
drop policy if exists stake_responses_select_own on public.stake_recommendation_responses;
create policy stake_responses_select_own on public.stake_recommendation_responses for select
  using (user_id = auth.uid());
drop policy if exists stake_responses_insert_own on public.stake_recommendation_responses;
create policy stake_responses_insert_own on public.stake_recommendation_responses for insert
  with check (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE GRADES — closing line, CLV, result, profit, and the flat baselines
-- ─────────────────────────────────────────────────────────────────────────────
-- Joined to `signals` by sig_key, exactly as research_packet_grades is, so
-- the close and the result arrive without a second identity map. Profit is
-- computed at the RECOMMENDED units and, beside it, at a flat 0.5u and a flat
-- 1u on the same selections — the two baselines the sizing engine has to beat
-- before anyone may claim it adds anything.
create or replace view public.stake_recommendation_grades as
select
  r.id, r.recommendation_id, r.card_id, r.built_at, r.user_id,
  r.sport, r.game_id, r.matchup, r.kickoff, r.market, r.selection, r.side, r.handicap,
  r.odds_american, r.odds_decimal, r.book, r.price_captured_at, r.price_freshness,
  r.model_probability, r.calibrated_probability, r.conservative_probability, r.conservative_method,
  r.no_vig_market_probability, r.model_edge, r.conservative_edge, r.expected_value, r.fair_odds,
  r.reliability_score, r.raw_kelly_fraction, r.fractional_kelly_fraction,
  r.recommended_units, r.recommended_dollars, r.recommendation_tier,
  r.exposure_before_units, r.exposure_after_units,
  r.model_version, r.calibration_version, r.status, r.kind, r.pass_reason, r.sig_key,
  (to_jsonb(s) ->> 'closing_sharp_fair')::numeric      as closing_fair_probability,
  (to_jsonb(s) ->> 'closing_dec')::numeric             as closing_decimal,
  (to_jsonb(s) ->> 'closing_at_observed')::timestamptz as closing_observed_at,
  to_jsonb(s) ->> 'result'                             as result,
  (to_jsonb(s) ->> 'clv')::numeric                     as clv,
  case when (to_jsonb(s) ->> 'beat_close') in ('true','t','1') then true
       when (to_jsonb(s) ->> 'beat_close') in ('false','f','0') then false else null end as beat_close,
  case
    when r.status <> 'BET' then 'NOT_A_BET'
    when r.sig_key is null then 'NO_SIGNAL_KEY'
    when s.sig_key is null then 'SIGNAL_NOT_FOUND'
    when to_jsonb(s) ->> 'closing_sharp_fair' is null then 'NOT_CLOSED'
    when to_jsonb(s) ->> 'result' is null then 'CLOSED_NO_RESULT'
    else 'GRADED'
  end as grade_state,
  -- profit in units at the size EdgeDesk actually recommended
  case when to_jsonb(s) ->> 'result' = 'win'  then r.recommended_units * (r.odds_decimal - 1)
       when to_jsonb(s) ->> 'result' = 'loss' then -r.recommended_units
       when to_jsonb(s) ->> 'result' = 'push' then 0 end as profit_units,
  -- the two baselines, on the same selections and the same prices
  case when to_jsonb(s) ->> 'result' = 'win'  then 0.5 * (r.odds_decimal - 1)
       when to_jsonb(s) ->> 'result' = 'loss' then -0.5
       when to_jsonb(s) ->> 'result' = 'push' then 0 end as profit_units_flat_half,
  case when to_jsonb(s) ->> 'result' = 'win'  then 1.0 * (r.odds_decimal - 1)
       when to_jsonb(s) ->> 'result' = 'loss' then -1.0
       when to_jsonb(s) ->> 'result' = 'push' then 0 end as profit_units_flat_one,
  -- Brier and log loss on the number the engine actually staked on
  case when to_jsonb(s) ->> 'result' in ('win','loss') and r.conservative_probability is not null
       then power(r.conservative_probability - case when to_jsonb(s) ->> 'result' = 'win' then 1 else 0 end, 2) end as brier_conservative,
  case when to_jsonb(s) ->> 'result' in ('win','loss') and r.calibrated_probability is not null
       then power(r.calibrated_probability - case when to_jsonb(s) ->> 'result' = 'win' then 1 else 0 end, 2) end as brier_calibrated,
  case when to_jsonb(s) ->> 'result' = 'win'  and r.conservative_probability between 0.0001 and 0.9999 then -ln(r.conservative_probability)
       when to_jsonb(s) ->> 'result' = 'loss' and r.conservative_probability between 0.0001 and 0.9999 then -ln(1 - r.conservative_probability) end as log_loss_conservative,
  -- did the reader take it? the latest response, read through, never written back
  (select resp.response from public.stake_recommendation_responses resp
    where resp.recommendation_id = r.recommendation_id order by resp.responded_at desc limit 1) as reader_response,
  (select resp.accepted_units from public.stake_recommendation_responses resp
    where resp.recommendation_id = r.recommendation_id order by resp.responded_at desc limit 1) as reader_accepted_units
from public.stake_recommendations r
left join public.signals s on s.sig_key = r.sig_key;

comment on view public.stake_recommendation_grades is
  'Every sized position beside its close, CLV, result and profit in units — with a flat 0.5u and a flat 1u on the same selections, because a sizing engine that does not beat flat staking is not adding anything.';

-- THE SCORECARD. Grouped by sport, market and tier, with the sample floor
-- beside every figure and the baselines in the same row.
create or replace view public.stake_engine_scorecard as
select
  sport, market, recommendation_tier,
  count(*)                                                as positions,
  count(*) filter (where grade_state = 'GRADED')           as graded,
  count(*) filter (where result = 'win')                   as wins,
  count(*) filter (where result = 'loss')                  as losses,
  count(*) filter (where result = 'push')                  as pushes,
  sum(recommended_units) filter (where grade_state = 'GRADED')      as units_staked,
  sum(profit_units)      filter (where grade_state = 'GRADED')      as profit_units,
  sum(profit_units_flat_half) filter (where grade_state = 'GRADED') as profit_units_flat_half,
  sum(profit_units_flat_one)  filter (where grade_state = 'GRADED') as profit_units_flat_one,
  case when coalesce(sum(recommended_units) filter (where grade_state = 'GRADED'), 0) > 0
       then sum(profit_units) filter (where grade_state = 'GRADED') / sum(recommended_units) filter (where grade_state = 'GRADED') end as roi_on_staked,
  avg(clv)                filter (where clv is not null)            as avg_clv,
  avg(case when beat_close then 1.0 else 0.0 end) filter (where beat_close is not null) as beat_close_rate,
  avg(brier_conservative) filter (where brier_conservative is not null) as brier_conservative,
  avg(brier_calibrated)   filter (where brier_calibrated is not null)   as brier_calibrated,
  avg(log_loss_conservative) filter (where log_loss_conservative is not null) as log_loss_conservative,
  avg(expected_value)                                      as avg_expected_value,
  avg(reliability_score)                                   as avg_reliability,
  (count(*) filter (where grade_state = 'GRADED')) >= 50   as sufficient_sample
from public.stake_recommendation_grades
where status = 'BET'
group by sport, market, recommendation_tier;

comment on view public.stake_engine_scorecard is
  'The sizing engine against itself and against flat staking, by sport, market and tier. sufficient_sample is a floor, not a verdict: below it no reading is claimed.';

-- WHY EDGEDESK PASSED. A pass is a result, so it is counted like one.
create or replace view public.stake_pass_reasons as
select
  sport, market, status,
  split_part(coalesce(pass_reason, 'UNRECORDED'), ':', 1) as gate,
  count(*)                                               as passes,
  avg(expected_value)                                    as avg_expected_value,
  avg(reliability_score)                                 as avg_reliability,
  min(built_at)                                          as first_seen,
  max(built_at)                                          as last_seen
from public.stake_recommendations
where status <> 'BET'
group by sport, market, status, split_part(coalesce(pass_reason, 'UNRECORDED'), ':', 1);

-- THE LIVE EXPOSURE THE ENGINE READS BACK. Pending positions by day and week,
-- so the caps see yesterday's card as well as this turn's.
create or replace view public.stake_open_exposure as
select
  user_id, sport, game_id, matchup, market, selection, side, handicap,
  recommended_units, kickoff, built_at, recommendation_id,
  (kickoff at time zone 'UTC')::date as kickoff_date_utc
from public.stake_recommendations
where status = 'BET' and recommended_units > 0 and kickoff > now();

-- The table grants the RLS policies above then narrow to the caller's own
-- rows. Without them a reader is refused before RLS is ever consulted, and
-- the policies would be decoration. The trail grants INSERT and SELECT only:
-- there is no UPDATE or DELETE privilege to lose an argument with.
grant select, insert, update, delete on public.bankroll_settings to authenticated;
grant select, insert on public.stake_recommendations to authenticated;
grant usage, select on sequence public.stake_recommendations_id_seq to authenticated;
grant select, insert on public.stake_recommendation_responses to authenticated;
grant usage, select on sequence public.stake_recommendation_responses_id_seq to authenticated;

grant select on public.stake_recommendation_grades to authenticated;
grant select on public.stake_engine_scorecard to authenticated;
grant select on public.stake_pass_reasons to authenticated;
grant select on public.stake_open_exposure to authenticated;

notify pgrst, 'reload schema';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE REPORT. Every row says ok or CHECK THIS.
-- ─────────────────────────────────────────────────────────────────────────────
select 'bankroll_settings table' as piece,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='bankroll_settings')
       then 'ok' else 'CHECK THIS — table missing' end as state
union all
select 'bankroll_amount is nullable (no assumed bankroll)',
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='bankroll_settings' and column_name='bankroll_amount' and is_nullable='YES')
       then 'ok' else 'CHECK THIS — bankroll must be nullable' end
union all
select 'default policy is the conservative one (0.25 Kelly, 1u single, 4u day, 8u week)',
  case when (select count(*) from information_schema.columns c
              where c.table_schema='public' and c.table_name='bankroll_settings'
                and ((c.column_name='fractional_kelly_multiplier'   and c.column_default like '%0.25%')
                  or (c.column_name='maximum_single_wager_units'    and c.column_default like '%1.00%')
                  or (c.column_name='maximum_daily_exposure_units'  and c.column_default like '%4.00%')
                  or (c.column_name='maximum_weekly_exposure_units' and c.column_default like '%8.00%'))) = 4
       then 'ok' else 'CHECK THIS — the defaults are not the documented policy' end
union all
select 'stake_recommendations table',
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='stake_recommendations')
       then 'ok' else 'CHECK THIS — table missing' end
union all
select 'write-once trigger',
  case when exists (select 1 from pg_trigger where tgname='stake_recommendations_immutable_trg' and not tgisinternal)
       then 'ok' else 'CHECK THIS — recommendations could be edited after the fact' end
union all
select 'no-delete trigger',
  case when exists (select 1 from pg_trigger where tgname='stake_recommendations_no_delete_trg' and not tgisinternal)
       then 'ok' else 'CHECK THIS — recommendations could be deleted' end
union all
select 'no-lookahead trigger',
  case when exists (select 1 from pg_trigger where tgname='stake_recommendations_no_lookahead_trg' and not tgisinternal)
       then 'ok' else 'CHECK THIS — a post-kickoff row could pose as a prediction' end
union all
select 'a BET cannot be recorded at zero units',
  case when exists (select 1 from pg_constraint where conname='stake_bet_is_sized')
       then 'ok' else 'CHECK THIS — constraint missing' end
union all
select 'a PASS cannot be recorded with a stake',
  case when exists (select 1 from pg_constraint where conname='stake_non_bet_unsized')
       then 'ok' else 'CHECK THIS — constraint missing' end
union all
select 'responses are append-only and separate from the snapshot',
  case when exists (select 1 from pg_trigger where tgname='stake_responses_append_only_trg' and not tgisinternal)
       then 'ok' else 'CHECK THIS — acceptance could rewrite the recommendation' end
union all
select 'row level security on all three tables',
  case when (select count(*) from pg_tables where schemaname='public'
              and tablename in ('bankroll_settings','stake_recommendations','stake_recommendation_responses')
              and rowsecurity) = 3
       then 'ok' else 'CHECK THIS — RLS is not on everywhere' end
union all
select 'grades view joins the close by sig_key and carries both flat baselines',
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='stake_recommendation_grades')
   and exists (select 1 from information_schema.columns where table_schema='public' and table_name='stake_recommendation_grades' and column_name='profit_units_flat_half')
   and exists (select 1 from information_schema.columns where table_schema='public' and table_name='stake_recommendation_grades' and column_name='profit_units_flat_one')
       then 'ok' else 'CHECK THIS — the baselines are missing from the grades view' end
union all
select 'the authenticated role can insert a recommendation and read its own',
  case when has_table_privilege('authenticated','public.stake_recommendations','insert')
   and has_table_privilege('authenticated','public.stake_recommendations','select')
   and not has_table_privilege('authenticated','public.stake_recommendations','update')
   and not has_table_privilege('authenticated','public.stake_recommendations','delete')
       then 'ok' else 'CHECK THIS — the trail must be insert+select only for readers' end
union all
select 'the scorecard and the pass-reason view exist',
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='stake_engine_scorecard')
   and exists (select 1 from information_schema.views where table_schema='public' and table_name='stake_pass_reasons')
       then 'ok' else 'CHECK THIS — a view is missing' end;

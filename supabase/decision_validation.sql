-- =============================================================================
-- decision_validation — storage for the validation layer.
-- docs/bettor-decision/QUALITY_UPGRADE.md §5
--
-- WHAT IT ADDS
--   1. bettor_decision_snapshots gains typed version columns read straight
--      out of the frozen snapshot (generated, stored): evaluation_mode,
--      data_snapshot_at, version_key, pricing_model_version. No row is ever
--      UPDATEd to add them — the table stays write-once.
--   2. bettor_decision_evaluations — one graded row for the FIRST snapshot
--      of every decision class per game (BET, LEAN, WATCH, PASS), from
--      football/cfb_terminal/decisions/<season>/evaluations.jsonl: opening,
--      evaluated, bet and closing lines, CLV in points and price-equivalent,
--      the result, and the versions that made the call. Write-once, never
--      deleted, readable by every signed-in reader; a row whose close was
--      captured before the evaluation is refused.
--   3. bettor_decision_validation — per evaluation mode and decision class:
--      n, observed vs expected cover, CLV (mean, median, beat / tie / lose)
--      and a sample state on every row. Modes are never summed together.
--
-- DEPENDS ON supabase/bettor_decisions.sql (bettor_decision_snapshots).
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $dep$ begin
  if to_regclass('public.bettor_decision_snapshots') is null then
    raise exception 'decision_validation.sql needs public.bettor_decision_snapshots: apply supabase/bettor_decisions.sql first';
  end if;
end $dep$;

-- 1. VERSIONS ON EVERY SNAPSHOT, FROM THE SNAPSHOT ITSELF ---------------------
alter table public.bettor_decision_snapshots
  add column if not exists evaluation_mode text generated always as (coalesce(snapshot->>'evaluation_mode', 'LIVE')) stored;
alter table public.bettor_decision_snapshots
  add column if not exists data_snapshot_at text generated always as (snapshot->>'data_snapshot_at') stored;
alter table public.bettor_decision_snapshots
  add column if not exists version_key text generated always as (snapshot->'versions'->>'version_key') stored;
alter table public.bettor_decision_snapshots
  add column if not exists pricing_model_version text generated always as (snapshot->>'pricing_model_version') stored;
create index if not exists bettor_snapshots_version_idx on public.bettor_decision_snapshots (model_version, calibration_version, config_version);

-- 2. EVERY DECISION CLASS, GRADED ---------------------------------------------
create table if not exists public.bettor_decision_evaluations (
  snapshot_id            text primary key references public.bettor_decision_snapshots (snapshot_id),
  game_id                text not null,
  sport                  text not null,
  market_type            text not null default 'spread',
  evaluation_mode        text not null default 'LIVE' check (evaluation_mode in ('BACKTEST', 'WALK_FORWARD', 'LIVE_RECONSTRUCTED', 'LIVE')),
  decision               text not null check (decision in ('BET', 'LEAN', 'WATCH', 'PASS')),
  reason_code            text,
  units                  numeric not null default 0 check (units >= 0 and units <= 1),
  side                   text check (side in ('home', 'away')),
  evaluated_line         numeric not null,
  evaluated_odds         numeric not null,
  evaluated_book         text,
  bet_line               numeric,
  bet_odds               numeric,
  open_line              numeric,
  close_line             numeric,
  close_sharp_line       numeric,
  close_captured_at      timestamptz,
  clv_points             numeric,
  clv_sharp_points       numeric,
  clv_price_pp           numeric,
  clv_ev                 numeric,
  result                 text check (result in ('win', 'loss', 'push')),
  units_won              numeric,
  flat_units_won_hypothetical numeric,
  predicted              numeric check (predicted is null or (predicted >= 0 and predicted <= 1)),
  break_even             numeric,
  edge_pp                numeric,
  calibrated_ev          numeric,
  decision_ev            numeric,
  decision_confidence    numeric,
  probability_source     text,
  reliability            numeric,
  market_quality         text,
  model_version          text,
  calibration_version    text,
  pricing_version        text,
  rules_version          text,
  engine_version         text,
  version_key            text,
  evaluated_at           timestamptz not null,
  kickoff                timestamptz,
  unit_of_analysis       text not null default 'first_per_class',
  graded_at              timestamptz not null,
  evaluation             jsonb not null,
  synced_at              timestamptz not null default now(),
  check ((decision = 'BET') = (units > 0)),
  check ((decision = 'BET') = (bet_line is not null))
);
comment on table public.bettor_decision_evaluations is
  'Every decision class graded the same way: the first snapshot of each class per game (football/cfb_terminal/decisions/<season>/evaluations.jsonl). Write-once, never deleted. LEAN / WATCH / PASS results are hypothetical flat 1U, never mixed with BET units.';
create index if not exists bettor_evaluations_mode_idx on public.bettor_decision_evaluations (evaluation_mode, decision, sport);

create or replace function public.bettor_evaluations_honest() returns trigger
language plpgsql as $$
begin
  if new.kickoff is not null and new.evaluated_at >= new.kickoff then
    raise exception 'bettor_decision_evaluations: % was decided at %, not before kickoff %', new.snapshot_id, new.evaluated_at, new.kickoff using errcode = 'check_violation';
  end if;
  if new.close_captured_at is not null and new.close_captured_at <= new.evaluated_at then
    raise exception 'bettor_decision_evaluations: % carries a "close" captured at %, before its own evaluation at %', new.snapshot_id, new.close_captured_at, new.evaluated_at using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists bettor_evaluations_honest_trg on public.bettor_decision_evaluations;
create trigger bettor_evaluations_honest_trg before insert on public.bettor_decision_evaluations for each row execute function public.bettor_evaluations_honest();
drop trigger if exists bettor_evaluations_frozen_trg on public.bettor_decision_evaluations;
create trigger bettor_evaluations_frozen_trg before update or delete on public.bettor_decision_evaluations for each row execute function public.bettor_decisions_frozen();

alter table public.bettor_decision_evaluations enable row level security;
drop policy if exists bettor_evaluations_select on public.bettor_decision_evaluations;
create policy bettor_evaluations_select on public.bettor_decision_evaluations for select to authenticated using (true);
revoke all on public.bettor_decision_evaluations from anon;
grant select on public.bettor_decision_evaluations to authenticated;

-- 3. THE VALIDATION VIEW: one row per mode × class, n on every row -------------
create or replace view public.bettor_decision_validation with (security_invoker = true) as
with g as (
  select evaluation_mode, sport, decision, result, predicted, clv_points, clv_price_pp, units, units_won, flat_units_won_hypothetical
  from public.bettor_decision_evaluations
)
select evaluation_mode, sport, decision,
       count(*) as n,
       count(*) filter (where result in ('win', 'loss')) as decided,
       round(avg(case when result = 'win' then 1.0 when result = 'loss' then 0.0 end), 4) as observed_cover,
       round(avg(predicted) filter (where result in ('win', 'loss')), 4) as expected_cover,
       count(clv_points) as clv_n,
       round(avg(clv_points), 3) as clv_mean,
       round((percentile_cont(0.5) within group (order by clv_points))::numeric, 3) as clv_median,
       count(*) filter (where clv_points > 0) as clv_beat,
       count(*) filter (where clv_points = 0) as clv_tie,
       count(*) filter (where clv_points < 0) as clv_lose,
       round(avg(clv_price_pp), 3) as clv_price_pp_mean,
       case when sum(units) filter (where result is not null and units > 0) > 0
            then round(sum(units_won) / sum(units) filter (where result is not null and units > 0), 4) end as roi,
       round(avg(flat_units_won_hypothetical) filter (where result is not null), 4) as flat_roi_hypothetical,
       case when count(*) filter (where result in ('win', 'loss')) < 50 then 'DESCRIPTIVE_ONLY'
            when count(*) filter (where result in ('win', 'loss')) < 200 then 'EARLY_SIGNAL'
            when count(*) filter (where result in ('win', 'loss')) < 500 then 'MODERATE_EVIDENCE'
            else 'STRONGER_EVIDENCE' end as sample_state
from g
group by evaluation_mode, sport, decision;
grant select on public.bettor_decision_validation to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'snapshot version columns' as piece,
         case when exists (select 1 from information_schema.columns where table_name = 'bettor_decision_snapshots' and column_name = 'version_key') then 'ok' else 'CHECK THIS' end as state
  union all select 'evaluations table', case when to_regclass('public.bettor_decision_evaluations') is not null then 'ok' else 'CHECK THIS' end
  union all select 'evaluations write-once and honest', case when exists (select 1 from pg_trigger where tgname = 'bettor_evaluations_frozen_trg') and exists (select 1 from pg_trigger where tgname = 'bettor_evaluations_honest_trg') then 'ok' else 'CHECK THIS' end
  union all select 'evaluations RLS', case when (select relrowsecurity from pg_class where oid = 'public.bettor_decision_evaluations'::regclass) then 'ok' else 'CHECK THIS' end
  union all select 'validation view', case when to_regclass('public.bettor_decision_validation') is not null then 'ok' else 'CHECK THIS' end
) r order by 1;

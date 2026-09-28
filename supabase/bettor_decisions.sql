-- =============================================================================
-- bettor_decisions — the bettor-facing decision layer's storage.
-- docs/bettor-decision/DESIGN.md §11
--
-- WHAT IT ADDS
--   1. bankroll_settings (from bankroll_and_stakes.sql) gains the bettor's
--      unit convention: unit_mode ('percent' → 1 unit = unit_percent of the
--      bankroll, default 1%; 'fixed' → base_unit_amount), the active-exposure
--      guardrail, exposure limiting (off by default) and beginner mode.
--      One bankroll per reader, shared with the AI desk's staking engine.
--   2. user_bets — what the READER placed ("BET PLACED"), kept apart from what
--      EdgeDesk recommended. The placement facts and the recommendation
--      snapshot taken at placement are write-once; the owner may change only
--      notes and void status; grades are the service role's.
--   3. bettor_decision_snapshots / bettor_decision_grades — EdgeDesk's own
--      frozen decisions (football/cfb_terminal/decisions/<season>/*.jsonl,
--      synced by football/cfb_terminal/decisions_sync.js). Write-once, never
--      deleted, pregame only; readable by every signed-in reader.
--   4. Views: the decision transitions (BET → PASS …), per-tier performance,
--      and each reader's own CLV.
--
-- DEPENDS ON supabase/bankroll_and_stakes.sql (bankroll_settings). Applied
-- without it, this file stops with a message naming it.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $dep$ begin
  if to_regclass('public.bankroll_settings') is null then
    raise exception 'bettor_decisions.sql needs public.bankroll_settings: apply supabase/bankroll_and_stakes.sql first';
  end if;
end $dep$;

-- 1. THE UNIT CONVENTION ---------------------------------------------------
-- unit_mode is added once; on that first run a reader who already typed a base
-- unit keeps it ('fixed'), everyone else gets 1 unit = 1% of bankroll.
do $unit$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bankroll_settings' and column_name = 'unit_mode') then
    alter table public.bankroll_settings add column unit_mode text not null default 'percent';
    update public.bankroll_settings set unit_mode = 'fixed' where base_unit_amount is not null;
  end if;
end $unit$;
alter table public.bankroll_settings add column if not exists unit_percent numeric not null default 0.01;
alter table public.bankroll_settings add column if not exists max_active_exposure_units numeric not null default 5;
alter table public.bankroll_settings add column if not exists exposure_limit_enabled boolean not null default false;
alter table public.bankroll_settings add column if not exists beginner_mode boolean not null default false;
alter table public.bankroll_settings add column if not exists decision_onboarding_at timestamptz null;
do $chk$ begin
  if not exists (select 1 from pg_constraint where conname = 'bankroll_settings_unit_mode') then
    alter table public.bankroll_settings add constraint bankroll_settings_unit_mode check (unit_mode in ('percent', 'fixed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bankroll_settings_unit_percent') then
    alter table public.bankroll_settings add constraint bankroll_settings_unit_percent check (unit_percent > 0 and unit_percent <= 0.10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bankroll_settings_active_exposure') then
    alter table public.bankroll_settings add constraint bankroll_settings_active_exposure check (max_active_exposure_units > 0 and max_active_exposure_units <= 100);
  end if;
end $chk$;
comment on column public.bankroll_settings.unit_mode is
  'percent: 1 unit = unit_percent × bankroll_amount (default 1%). fixed: 1 unit = base_unit_amount. A bankroll never changes a unit classification; it only converts units to dollars.';

-- 2. WHAT THE READER PLACED ------------------------------------------------
create table if not exists public.user_bets (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid(),
  bet_key                 text not null,
  source                  text not null default 'edgedesk' check (source in ('edgedesk', 'own')),
  sport                   text not null check (sport in ('CFB', 'NFL')),
  game_id                 text not null,
  home_team               text,
  away_team               text,
  kickoff                 timestamptz,
  market_type             text not null default 'spread' check (market_type in ('spread', 'total', 'moneyline')),
  side                    text not null check (side in ('home', 'away', 'over', 'under')),
  team                    text,
  line                    numeric,
  odds                    numeric not null check (odds <= -100 or odds >= 100),
  book                    text,
  units                   numeric not null check (units > 0 and units <= 100),
  stake_dollars           numeric check (stake_dollars is null or stake_dollars >= 0),
  unit_value              numeric check (unit_value is null or unit_value > 0),
  placed_at               timestamptz not null default now(),
  recommendation_id       text,
  recommendation          jsonb,
  entry_vs_recommendation text check (entry_vs_recommendation in ('AT_EDGEDESK_PRICE', 'INSIDE_RANGE', 'OUTSIDE_RANGE', 'OTHER_SIDE', 'NO_RECOMMENDATION', 'UNKNOWN')),
  notes                   text check (notes is null or length(notes) <= 2000),
  status                  text not null default 'open' check (status in ('open', 'void')),
  close_line              numeric,
  close_odds              numeric,
  clv_points              numeric,
  result                  text check (result in ('win', 'loss', 'push', 'void')),
  units_won               numeric,
  graded_at               timestamptz,
  created_at              timestamptz not null default now(),
  unique (user_id, bet_key)
);
comment on table public.user_bets is
  'Bets the reader says they placed. Separate from EdgeDesk recommendations: the recommendation snapshot at placement is frozen beside the entry and never changes afterwards.';
create index if not exists user_bets_user_idx on public.user_bets (user_id, placed_at desc);
create index if not exists user_bets_game_idx on public.user_bets (sport, game_id);

create or replace function public.user_bets_on_insert() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  if new.user_id is null then raise exception 'user_bets: sign in to record a bet' using errcode = 'insufficient_privilege'; end if;
  if new.placed_at > now() + interval '5 minutes' then
    raise exception 'user_bets: placed_at % is in the future', new.placed_at using errcode = 'check_violation';
  end if;
  -- a grade never arrives with the entry; the grading job writes it later
  new.close_line := null; new.close_odds := null; new.clv_points := null; new.result := null; new.units_won := null; new.graded_at := null;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists user_bets_on_insert_trg on public.user_bets;
create trigger user_bets_on_insert_trg before insert on public.user_bets for each row execute function public.user_bets_on_insert();

-- the entry and the recommendation it was compared with are facts: frozen
create or replace function public.user_bets_on_update() returns trigger
language plpgsql as $$
begin
  if (new.user_id, new.bet_key, new.source, new.sport, new.game_id, new.market_type, new.side, new.line, new.odds, new.book, new.units,
      new.stake_dollars, new.unit_value, new.placed_at, new.recommendation_id, new.entry_vs_recommendation, new.kickoff, new.team)
     is distinct from
     (old.user_id, old.bet_key, old.source, old.sport, old.game_id, old.market_type, old.side, old.line, old.odds, old.book, old.units,
      old.stake_dollars, old.unit_value, old.placed_at, old.recommendation_id, old.entry_vs_recommendation, old.kickoff, old.team)
     or new.recommendation::text is distinct from old.recommendation::text then
    raise exception 'user_bets: a recorded bet and its recommendation snapshot are write-once (only notes and void status change)' using errcode = 'restrict_violation';
  end if;
  new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists user_bets_on_update_trg on public.user_bets;
create trigger user_bets_on_update_trg before update on public.user_bets for each row execute function public.user_bets_on_update();

alter table public.user_bets enable row level security;
drop policy if exists user_bets_select_own on public.user_bets;
create policy user_bets_select_own on public.user_bets for select to authenticated using (user_id = auth.uid());
drop policy if exists user_bets_insert_own on public.user_bets;
create policy user_bets_insert_own on public.user_bets for insert to authenticated with check (user_id = auth.uid());
drop policy if exists user_bets_update_own on public.user_bets;
create policy user_bets_update_own on public.user_bets for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists user_bets_delete_own on public.user_bets;
create policy user_bets_delete_own on public.user_bets for delete to authenticated using (user_id = auth.uid());
revoke all on public.user_bets from anon;
grant select, insert, delete on public.user_bets to authenticated;
revoke update on public.user_bets from authenticated;
grant update (notes, status) on public.user_bets to authenticated;

-- 3. EDGEDESK'S FROZEN DECISIONS --------------------------------------------
create table if not exists public.bettor_decision_snapshots (
  snapshot_id              text primary key,
  sport                    text not null,
  game_id                  text not null,
  market_key               text not null,
  home_team                text,
  away_team                text,
  kickoff                  timestamptz,
  evaluated_at             timestamptz not null,
  decision                 text not null check (decision in ('BET', 'WAIT', 'PASS', 'NO_DECISION')),
  reason_code              text not null,
  side                     text check (side is null or side in ('home', 'away')),
  line                     numeric,
  odds                     numeric,
  book                     text,
  units                    numeric not null default 0 check (units >= 0 and units <= 1),
  max_playable_line        numeric,
  max_acceptable_odds      numeric,
  calibrated_ev_pct        numeric,
  raw_ev_pct               numeric,
  reliability_score        numeric,
  market_quality           text,
  model_version            text,
  calibration_version      text,
  decision_engine_version  text not null,
  config_version           text not null,
  validation_state         text not null,
  snapshot                 jsonb not null,
  synced_at                timestamptz not null default now(),
  check ((decision = 'BET') = (units > 0))
);
comment on table public.bettor_decision_snapshots is
  'EdgeDesk''s bettor decisions, one frozen row per change (football/cfb_terminal/decisions/<season>/snapshots.jsonl). Write-once, never deleted, evaluated before kickoff.';
create index if not exists bettor_snapshots_game_idx on public.bettor_decision_snapshots (sport, game_id, evaluated_at);

create table if not exists public.bettor_decision_grades (
  snapshot_id       text primary key references public.bettor_decision_snapshots (snapshot_id),
  units             numeric not null check (units > 0 and units <= 1),
  odds              numeric not null,
  line              numeric,
  close_line        numeric,
  clv_points        numeric,
  result            text check (result in ('win', 'loss', 'push')),
  units_won         numeric,
  calibrated_cover  numeric,
  graded_at         timestamptz not null
);

create or replace function public.bettor_decisions_frozen() returns trigger
language plpgsql as $$
begin
  raise exception '% is write-once and never deleted', tg_table_name using errcode = 'restrict_violation';
end $$;
drop trigger if exists bettor_snapshots_frozen_trg on public.bettor_decision_snapshots;
create trigger bettor_snapshots_frozen_trg before update or delete on public.bettor_decision_snapshots for each row execute function public.bettor_decisions_frozen();
drop trigger if exists bettor_grades_frozen_trg on public.bettor_decision_grades;
create trigger bettor_grades_frozen_trg before update or delete on public.bettor_decision_grades for each row execute function public.bettor_decisions_frozen();

create or replace function public.bettor_snapshots_pregame() returns trigger
language plpgsql as $$
begin
  if new.kickoff is not null and new.evaluated_at >= new.kickoff then
    raise exception 'bettor_decision_snapshots: % was evaluated at %, not before kickoff %', new.snapshot_id, new.evaluated_at, new.kickoff using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists bettor_snapshots_pregame_trg on public.bettor_decision_snapshots;
create trigger bettor_snapshots_pregame_trg before insert on public.bettor_decision_snapshots for each row execute function public.bettor_snapshots_pregame();

alter table public.bettor_decision_snapshots enable row level security;
alter table public.bettor_decision_grades enable row level security;
drop policy if exists bettor_snapshots_select on public.bettor_decision_snapshots;
create policy bettor_snapshots_select on public.bettor_decision_snapshots for select to authenticated using (true);
drop policy if exists bettor_grades_select on public.bettor_decision_grades;
create policy bettor_grades_select on public.bettor_decision_grades for select to authenticated using (true);
revoke all on public.bettor_decision_snapshots, public.bettor_decision_grades from anon;
grant select on public.bettor_decision_snapshots, public.bettor_decision_grades to authenticated;

-- 4. VIEWS -------------------------------------------------------------------
create or replace view public.bettor_decision_transitions with (security_invoker = true) as
select snapshot_id, sport, game_id, market_key, evaluated_at as changed_at,
       lag(decision) over w as from_decision, decision as to_decision, reason_code,
       lag(line) over w as from_line, line as to_line, lag(odds) over w as from_odds, odds as to_odds
from public.bettor_decision_snapshots
window w as (partition by sport, game_id, market_key order by evaluated_at);

create or replace view public.bettor_decision_performance with (security_invoker = true) as
select to_char(g.units, 'FM0.00') || 'U' as tier, count(*) as bets,
       sum(g.units) filter (where g.result is not null) as units_risked,
       sum(g.units_won) as units_won,
       case when sum(g.units) filter (where g.result is not null) > 0 then round(sum(g.units_won) / sum(g.units) filter (where g.result is not null), 4) end as roi,
       round(avg(g.clv_points), 2) as average_clv,
       round(avg(case when g.result = 'win' then 1.0 when g.result = 'loss' then 0.0 end), 4) as observed_cover_rate,
       round(avg(g.calibrated_cover) filter (where g.result in ('win', 'loss')), 4) as expected_cover_rate,
       count(*) filter (where g.result is not null) >= 50 as sufficient_sample
from public.bettor_decision_grades g
group by g.units;

create or replace view public.user_bet_clv with (security_invoker = true) as
select user_id, sport, market_type, source, entry_vs_recommendation, count(*) as bets,
       count(clv_points) as graded, round(avg(clv_points), 2) as average_clv,
       round(avg(case when clv_points > 0 then 1.0 when clv_points is not null then 0.0 end), 3) as positive_clv_rate
from public.user_bets where status = 'open'
group by user_id, sport, market_type, source, entry_vs_recommendation;
grant select on public.bettor_decision_transitions, public.bettor_decision_performance, public.user_bet_clv to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'bankroll_settings unit convention' as piece,
         case when exists (select 1 from information_schema.columns where table_name = 'bankroll_settings' and column_name = 'unit_percent') then 'ok' else 'CHECK THIS' end as state
  union all select 'user_bets table', case when to_regclass('public.user_bets') is not null then 'ok' else 'CHECK THIS' end
  union all select 'user_bets write-once trigger', case when exists (select 1 from pg_trigger where tgname = 'user_bets_on_update_trg') then 'ok' else 'CHECK THIS' end
  union all select 'user_bets RLS', case when (select relrowsecurity from pg_class where oid = 'public.user_bets'::regclass) then 'ok' else 'CHECK THIS' end
  union all select 'decision snapshots (write-once, pregame)', case when exists (select 1 from pg_trigger where tgname = 'bettor_snapshots_pregame_trg') and exists (select 1 from pg_trigger where tgname = 'bettor_snapshots_frozen_trg') then 'ok' else 'CHECK THIS' end
  union all select 'decision grades', case when to_regclass('public.bettor_decision_grades') is not null then 'ok' else 'CHECK THIS' end
  union all select 'transitions view', case when to_regclass('public.bettor_decision_transitions') is not null then 'ok' else 'CHECK THIS' end
  union all select 'performance view', case when to_regclass('public.bettor_decision_performance') is not null then 'ok' else 'CHECK THIS' end
) r order by 1;

-- =============================================================================
-- player_props — the Player Props terminal's durable ledger.
-- docs/player-props/DESIGN.md §9
--
-- WHAT IT ADDS
--   1. player_prop_quotes — every captured sportsbook price, append-only and
--      change-only (football/props/capture.js → sync_supabase.js). A quote is
--      identified by sport, game, player, market, line, side, book and the
--      capture time; the provider's own update time is kept beside it.
--   2. player_prop_projections — the projection and its outcome distribution
--      as priced (family + parameters), one row per prop per model build.
--   3. player_prop_evaluations — the frozen decision records: 'qualified'
--      (the first BET / LEAN of a selection, at its price) and 'final' (the
--      last pregame evaluation of every priced prop — the close). Pregame only.
--   4. player_prop_results — settlement, the statistic, units, CLV.
--   5. Views: the latest price per identity, open → current movement, and the
--      graded record by market and decision.
-- Every table is write-once and never deleted; readers (authenticated) read,
-- only the service role writes.
--
-- DEPENDS ON nothing (public schema, auth.users only through the watchlist
-- file). CONVENTION (supabase/README.md): idempotent, additive, pasted into
-- the SQL editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

-- 1. QUOTES -----------------------------------------------------------------
create table if not exists public.player_prop_quotes (
  quote_id text primary key,
  sport text not null,
  game_id text not null,
  provider_event_id text null,
  player_id text null,
  player_key text not null,
  player_name text not null,
  market text not null,
  line numeric not null,
  side text not null,
  book text not null,
  american integer not null,
  is_alternate boolean not null default false,
  quoted_at timestamptz null,
  captured_at timestamptz not null,
  kickoff timestamptz null,
  source text not null default 'the-odds-api',
  inserted_at timestamptz not null default now()
);
do $chk$ begin
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_side') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_side check (side in ('over', 'under'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_price') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_price check (abs(american) between 100 and 20000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_line') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_line check (line >= 0 and line <= 2000 and line * 2 = round(line * 2));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_sport') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_sport check (sport in ('nfl', 'cfb', 'nba', 'ncaab', 'mlb', 'ufc'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_quotes_player_key') then
    alter table public.player_prop_quotes add constraint player_prop_quotes_player_key check (player_key = coalesce(player_id, player_key) and length(player_key) between 1 and 200);
  end if;
end $chk$;
create unique index if not exists player_prop_quotes_identity
  on public.player_prop_quotes (sport, game_id, player_key, market, line, side, book, captured_at);
create index if not exists player_prop_quotes_game on public.player_prop_quotes (sport, game_id, market);
comment on table public.player_prop_quotes is
  'Every captured player-prop price, append-only and change-only. Identity: sport, game_id, player_key (player_id, or name:<normalised> when the book name matched no single player), market, line, side, book, captured_at.';

-- 2. PROJECTIONS ------------------------------------------------------------
create table if not exists public.player_prop_projections (
  projection_id text primary key,
  sport text not null,
  game_id text not null,
  player_id text not null,
  market text not null,
  model_version text not null,
  built_at timestamptz not null,
  raw_mean numeric null,
  informed_mean numeric null,
  median numeric null,
  p25 numeric null,
  p75 numeric null,
  distribution jsonb not null,
  inputs jsonb null,
  inserted_at timestamptz not null default now()
);
create unique index if not exists player_prop_projections_identity
  on public.player_prop_projections (sport, game_id, player_id, market, model_version, built_at);

-- 3. EVALUATIONS (decisions) ------------------------------------------------
create table if not exists public.player_prop_evaluations (
  evaluation_id text primary key,
  kind text not null,
  selection_key text not null,
  prop_id text not null,
  sport text not null,
  season integer null,
  week integer null,
  game_id text not null,
  kickoff timestamptz not null,
  player_id text not null,
  player_name text null,
  team text null,
  opponent text null,
  position text null,
  market text not null,
  evaluated_at timestamptz not null,
  decision text not null,
  reason_code text null,
  units numeric not null default 0,
  confidence integer null,
  probability_source text not null,
  side text null,
  line numeric null,
  american integer null,
  book text null,
  p_side numeric null,
  ev numeric null,
  ev_raw numeric null,
  edge_pp numeric null,
  consensus jsonb null,
  model_over_at_consensus numeric null,
  model_mean numeric null,
  raw_mean numeric null,
  inserted_at timestamptz not null default now()
);
do $chk$ begin
  if not exists (select 1 from pg_constraint where conname = 'player_prop_evaluations_kind') then
    alter table public.player_prop_evaluations add constraint player_prop_evaluations_kind check (kind in ('qualified', 'final'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_evaluations_decision') then
    alter table public.player_prop_evaluations add constraint player_prop_evaluations_decision check (decision in ('BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_evaluations_units') then
    alter table public.player_prop_evaluations add constraint player_prop_evaluations_units check (units >= 0 and units <= 1 and (units = 0 or decision = 'BET'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_evaluations_prob') then
    alter table public.player_prop_evaluations add constraint player_prop_evaluations_prob check (p_side is null or (p_side >= 0 and p_side <= 1));
  end if;
end $chk$;
create index if not exists player_prop_evaluations_game on public.player_prop_evaluations (sport, game_id);

-- a decision is recorded before the game or not at all
create or replace function public.player_prop_evaluations_pregame() returns trigger language plpgsql as $$
begin
  if new.evaluated_at >= new.kickoff then
    raise exception 'player_prop_evaluations: % was evaluated at or after kickoff', new.evaluation_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists player_prop_evaluations_pregame_trg on public.player_prop_evaluations;
create trigger player_prop_evaluations_pregame_trg before insert on public.player_prop_evaluations
  for each row execute function public.player_prop_evaluations_pregame();

-- 4. RESULTS ------------------------------------------------------------------
create table if not exists public.player_prop_results (
  evaluation_id text primary key references public.player_prop_evaluations (evaluation_id),
  kind text not null,
  result text not null,
  reason text null,
  stat_value numeric null,
  units numeric null,
  units_won numeric null,
  flat_units_won numeric null,
  close_line numeric null,
  close_price integer null,
  line_clv numeric null,
  price_clv_cents numeric null,
  prob_clv_pp numeric null,
  beat_close boolean null,
  graded_at timestamptz not null,
  inserted_at timestamptz not null default now()
);
do $chk$ begin
  if not exists (select 1 from pg_constraint where conname = 'player_prop_results_result') then
    alter table public.player_prop_results add constraint player_prop_results_result check (result in ('WIN', 'LOSS', 'PUSH', 'VOID'));
  end if;
end $chk$;

-- 5. WRITE-ONCE, NEVER DELETED ------------------------------------------------
create or replace function public.player_props_frozen() returns trigger language plpgsql as $$
begin raise exception '% is write-once and never deleted', tg_table_name using errcode = 'restrict_violation'; end $$;
drop trigger if exists player_prop_quotes_frozen_trg on public.player_prop_quotes;
create trigger player_prop_quotes_frozen_trg before update or delete on public.player_prop_quotes for each row execute function public.player_props_frozen();
drop trigger if exists player_prop_projections_frozen_trg on public.player_prop_projections;
create trigger player_prop_projections_frozen_trg before update or delete on public.player_prop_projections for each row execute function public.player_props_frozen();
drop trigger if exists player_prop_evaluations_frozen_trg on public.player_prop_evaluations;
create trigger player_prop_evaluations_frozen_trg before update or delete on public.player_prop_evaluations for each row execute function public.player_props_frozen();
drop trigger if exists player_prop_results_frozen_trg on public.player_prop_results;
create trigger player_prop_results_frozen_trg before update or delete on public.player_prop_results for each row execute function public.player_props_frozen();

-- 6. ACCESS: signed-in readers read; only the service role writes -------------
alter table public.player_prop_quotes enable row level security;
alter table public.player_prop_projections enable row level security;
alter table public.player_prop_evaluations enable row level security;
alter table public.player_prop_results enable row level security;
drop policy if exists player_prop_quotes_read on public.player_prop_quotes;
create policy player_prop_quotes_read on public.player_prop_quotes for select to authenticated using (true);
drop policy if exists player_prop_projections_read on public.player_prop_projections;
create policy player_prop_projections_read on public.player_prop_projections for select to authenticated using (true);
drop policy if exists player_prop_evaluations_read on public.player_prop_evaluations;
create policy player_prop_evaluations_read on public.player_prop_evaluations for select to authenticated using (true);
drop policy if exists player_prop_results_read on public.player_prop_results;
create policy player_prop_results_read on public.player_prop_results for select to authenticated using (true);
revoke all on public.player_prop_quotes, public.player_prop_projections, public.player_prop_evaluations, public.player_prop_results from anon;
revoke insert, update, delete on public.player_prop_quotes, public.player_prop_projections, public.player_prop_evaluations, public.player_prop_results from authenticated;
grant select on public.player_prop_quotes, public.player_prop_projections, public.player_prop_evaluations, public.player_prop_results to authenticated;

-- 7. VIEWS ----------------------------------------------------------------------
create or replace view public.player_prop_quotes_latest with (security_invoker = true) as
select distinct on (sport, game_id, player_key, market, line, side, book)
       sport, game_id, player_id, player_key, player_name, market, line, side, book, american, is_alternate, quoted_at, captured_at, kickoff
from public.player_prop_quotes
order by sport, game_id, player_key, market, line, side, book, captured_at desc;

create or replace view public.player_prop_line_movement with (security_invoker = true) as
with main as (
  select * from public.player_prop_quotes where not is_alternate and side = 'over'
)
select sport, game_id, player_key, max(player_name) as player_name, market, book,
       (array_agg(line order by captured_at asc))[1] as open_line,
       (array_agg(american order by captured_at asc))[1] as open_over,
       min(captured_at) as opened_at,
       (array_agg(line order by captured_at desc))[1] as current_line,
       (array_agg(american order by captured_at desc))[1] as current_over,
       max(captured_at) as current_at,
       count(*) as changes
from main
group by sport, game_id, player_key, market, book;

create or replace view public.player_prop_performance with (security_invoker = true) as
select e.sport, e.market, e.decision, count(*) as graded,
       count(*) filter (where r.result = 'WIN') as wins, count(*) filter (where r.result = 'LOSS') as losses, count(*) filter (where r.result = 'PUSH') as pushes,
       sum(coalesce(r.units_won, 0)) as units_won,
       round(avg(r.prob_clv_pp), 2) as average_prob_clv_pp,
       round(avg(case when r.beat_close then 1.0 when r.beat_close is not null then 0.0 end), 3) as beat_close_rate,
       count(*) filter (where r.result in ('WIN', 'LOSS')) >= 50 as sufficient_sample
from public.player_prop_results r join public.player_prop_evaluations e using (evaluation_id)
where e.kind = 'qualified'
group by e.sport, e.market, e.decision;
grant select on public.player_prop_quotes_latest, public.player_prop_line_movement, public.player_prop_performance to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'player_prop_quotes table' as piece, case when to_regclass('public.player_prop_quotes') is not null then 'ok' else 'CHECK THIS' end as state
  union all select 'quote identity unique index', case when to_regclass('public.player_prop_quotes_identity') is not null then 'ok' else 'CHECK THIS' end
  union all select 'player_prop_projections table', case when to_regclass('public.player_prop_projections') is not null then 'ok' else 'CHECK THIS' end
  union all select 'player_prop_evaluations (pregame only)', case when exists (select 1 from pg_trigger where tgname = 'player_prop_evaluations_pregame_trg') then 'ok' else 'CHECK THIS' end
  union all select 'player_prop_results table', case when to_regclass('public.player_prop_results') is not null then 'ok' else 'CHECK THIS' end
  union all select 'write-once triggers', case when (select count(*) from pg_trigger where tgname like 'player_prop_%_frozen_trg') = 4 then 'ok' else 'CHECK THIS' end
  union all select 'RLS on every table', case when (select bool_and(relrowsecurity) from pg_class where oid in ('public.player_prop_quotes'::regclass, 'public.player_prop_projections'::regclass, 'public.player_prop_evaluations'::regclass, 'public.player_prop_results'::regclass)) then 'ok' else 'CHECK THIS' end
  union all select 'views', case when to_regclass('public.player_prop_quotes_latest') is not null and to_regclass('public.player_prop_line_movement') is not null and to_regclass('public.player_prop_performance') is not null then 'ok' else 'CHECK THIS' end
) r order by 1;

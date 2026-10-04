-- ============================================================================
-- EDGEDESK CARD — the reader's saved opportunities (games and player props)
-- docs/opportunity/DESIGN.md §6 · lib/edgedesk_opportunity.js cardEntry
--
-- ADD TO CARD, from any research surface, stores the opportunity as it was
-- at that moment: its type (GAME / PLAYER_PROP), EdgeDesk's decision, the
-- event, market, line, side, price, book, probability, EV, edge, confidence,
-- units and time — and for a prop the player and prop type. The row is a
-- fact about the past and is WRITE-ONCE: a later market move never rewrites
-- the line, price or EV the reader saved (the Card reads the current market
-- beside it, for PRICE MOVED and CLV). The reader may remove a row from the
-- Card (status 'removed'); the grading job alone writes the result.
--
-- One table for both types, so one bankroll and one exposure read them; the
-- record keeps GAME and PLAYER_PROP apart (the type column), never pooled.
--
-- Idempotent and additive. Apply after supabase/bettor_decisions.sql.
-- ============================================================================

do $dep$ begin
  if to_regclass('public.user_bets') is null then
    raise exception 'card_opportunities.sql sits beside public.user_bets: apply supabase/bettor_decisions.sql first';
  end if;
end $dep$;

create table if not exists public.card_opportunities (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  entry_id           text not null,
  opportunity_id     text,
  key                text not null,
  type               text not null check (type in ('GAME', 'PLAYER_PROP')),
  sport              text not null check (sport in ('CFB', 'NFL')),
  league             text check (league in ('cfb', 'nfl')),
  event_key          text,
  game_id            text not null,
  kickoff            timestamptz,
  home               text,
  away               text,
  market             text not null,
  category           text,
  player_id          text,
  player_name        text,
  team               text,
  position           text,
  prop_type          text,
  side               text check (side is null or side in ('home', 'away', 'over', 'under')),
  line               numeric,
  selection          text,
  american           numeric check (american is null or american <= -100 or american >= 100),
  book               text,
  captured_at        timestamptz,
  probability        numeric check (probability is null or (probability >= 0 and probability <= 1)),
  ev                 numeric,
  edge_pp            numeric,
  confidence         numeric check (confidence is null or (confidence >= 0 and confidence <= 100)),
  decision           text not null check (decision in ('BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION')),
  units              numeric not null default 0 check (units >= 0 and units <= 1),
  code               text,
  probability_source text,
  stage              text,
  saved_at           timestamptz not null default now(),
  evaluated_at       timestamptz,
  snapshot           jsonb,
  status             text not null default 'open' check (status in ('open', 'removed')),
  -- written by the grading job only
  result             text check (result in ('WIN', 'LOSS', 'PUSH', 'VOID')),
  units_won          numeric,
  clv                numeric,
  graded_at          timestamptz,
  created_at         timestamptz not null default now(),
  unique (user_id, entry_id),
  -- a player prop names its player and prop type; a game market names neither
  check ((type = 'PLAYER_PROP') = (player_id is not null and prop_type is not null)),
  -- only a BET carries units (the Card's exposure rule)
  check ((decision = 'BET') or units = 0)
);
comment on table public.card_opportunities is
  'The reader''s EdgeDesk Card: game markets and player props saved from research, frozen at the moment they were added. One bankroll; the record keeps GAME and PLAYER_PROP apart.';
create index if not exists card_opportunities_user_idx on public.card_opportunities (user_id, saved_at desc);
create index if not exists card_opportunities_event_idx on public.card_opportunities (event_key);

create or replace function public.card_opportunities_on_insert() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  if new.user_id is null then raise exception 'card_opportunities: sign in to save to your Card' using errcode = 'insufficient_privilege'; end if;
  if new.saved_at > now() + interval '5 minutes' then
    raise exception 'card_opportunities: saved_at % is in the future', new.saved_at using errcode = 'check_violation';
  end if;
  if new.kickoff is not null and new.saved_at >= new.kickoff then
    raise exception 'card_opportunities: the game has started; a Card position is saved before kickoff' using errcode = 'check_violation';
  end if;
  -- a grade never arrives with the entry
  new.result := null; new.units_won := null; new.clv := null; new.graded_at := null;
  new.status := 'open'; new.created_at := now();
  return new;
end $$;
drop trigger if exists card_opportunities_on_insert_trg on public.card_opportunities;
create trigger card_opportunities_on_insert_trg before insert on public.card_opportunities for each row execute function public.card_opportunities_on_insert();

-- the saved decision is a fact: every column but status (and the grade) is frozen
create or replace function public.card_opportunities_on_update() returns trigger
language plpgsql as $$
begin
  if (new.user_id, new.entry_id, new.opportunity_id, new.key, new.type, new.sport, new.league, new.event_key, new.game_id, new.kickoff, new.market,
      new.player_id, new.prop_type, new.side, new.line, new.american, new.book, new.captured_at, new.probability, new.ev, new.edge_pp,
      new.confidence, new.decision, new.units, new.probability_source, new.stage, new.saved_at, new.evaluated_at)
     is distinct from
     (old.user_id, old.entry_id, old.opportunity_id, old.key, old.type, old.sport, old.league, old.event_key, old.game_id, old.kickoff, old.market,
      old.player_id, old.prop_type, old.side, old.line, old.american, old.book, old.captured_at, old.probability, old.ev, old.edge_pp,
      old.confidence, old.decision, old.units, old.probability_source, old.stage, old.saved_at, old.evaluated_at)
     or new.snapshot::text is distinct from old.snapshot::text then
    raise exception 'card_opportunities: a saved Card position is write-once (only its status changes; the grade is the grading job''s)' using errcode = 'restrict_violation';
  end if;
  if old.status = 'removed' and new.status <> 'removed' then
    raise exception 'card_opportunities: a removed position stays removed' using errcode = 'restrict_violation';
  end if;
  new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists card_opportunities_on_update_trg on public.card_opportunities;
create trigger card_opportunities_on_update_trg before update on public.card_opportunities for each row execute function public.card_opportunities_on_update();

alter table public.card_opportunities enable row level security;
drop policy if exists card_opportunities_select_own on public.card_opportunities;
create policy card_opportunities_select_own on public.card_opportunities for select to authenticated using (user_id = auth.uid());
drop policy if exists card_opportunities_insert_own on public.card_opportunities;
create policy card_opportunities_insert_own on public.card_opportunities for insert to authenticated with check (user_id = auth.uid());
drop policy if exists card_opportunities_update_own on public.card_opportunities;
create policy card_opportunities_update_own on public.card_opportunities for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.card_opportunities from anon;
grant select, insert on public.card_opportunities to authenticated;
revoke update on public.card_opportunities from authenticated;
grant update (status) on public.card_opportunities to authenticated;

-- the record by TYPE: game markets and player props are separate models,
-- so their results are never pooled into one accuracy figure
create or replace view public.card_record_by_type
with (security_invoker = true) as
select user_id, type, sport,
       count(*) filter (where result in ('WIN', 'LOSS', 'PUSH'))                  as settled,
       count(*) filter (where result = 'WIN')                                      as wins,
       count(*) filter (where result = 'LOSS')                                     as losses,
       count(*) filter (where result = 'PUSH')                                     as pushes,
       sum(units) filter (where result in ('WIN', 'LOSS', 'PUSH'))                as units_risked,
       sum(units_won) filter (where result in ('WIN', 'LOSS', 'PUSH'))            as units_won,
       case when sum(units) filter (where result in ('WIN', 'LOSS', 'PUSH')) > 0
            then sum(units_won) filter (where result in ('WIN', 'LOSS', 'PUSH')) / sum(units) filter (where result in ('WIN', 'LOSS', 'PUSH')) end as roi,
       avg(ev) filter (where result in ('WIN', 'LOSS', 'PUSH'))                   as avg_ev_at_decision,
       avg(clv) filter (where clv is not null)                                     as avg_clv
from public.card_opportunities
where status = 'open'
group by user_id, type, sport;
revoke all on public.card_record_by_type from anon;
grant select on public.card_record_by_type to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'card_opportunities table' as piece, case when to_regclass('public.card_opportunities') is not null then 'ok' else 'CHECK THIS' end as state
  union all select 'card_opportunities write-once trigger', case when exists (select 1 from pg_trigger where tgname = 'card_opportunities_on_update_trg') then 'ok' else 'CHECK THIS' end
  union all select 'card_opportunities pregame insert trigger', case when exists (select 1 from pg_trigger where tgname = 'card_opportunities_on_insert_trg') then 'ok' else 'CHECK THIS' end
  union all select 'card_opportunities RLS', case when (select relrowsecurity from pg_class where oid = 'public.card_opportunities'::regclass) then 'ok' else 'CHECK THIS' end
  union all select 'record by type view', case when to_regclass('public.card_record_by_type') is not null then 'ok' else 'CHECK THIS' end
) r order by 1;

-- =============================================================================
-- player_props_watchlist — a reader's starred players, props and games in the
-- Player Props terminal ("My Props"). docs/player-props/DESIGN.md §9
--
-- WHAT IT ADDS
--   player_prop_watchlist (user_id, kind, item_key, league, label, created_at):
--   one row per starred item. kind is 'player' (a player id), 'prop' (a board
--   prop id: league|game|player|market) or 'game' (a game id). The owner reads,
--   stars and un-stars their own rows; nobody else sees them. A star has no
--   state to edit, so there is no update. Signed out, the page keeps stars on
--   the device (localStorage edgedesk_props_watch_v1) and this table is unused.
--
-- DEPENDS ON supabase/player_props.sql (the terminal's ledger). Applied
-- without it, this file stops with a message naming it.
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $dep$ begin
  if to_regclass('public.player_prop_evaluations') is null then
    raise exception 'player_props_watchlist.sql needs public.player_prop_evaluations: apply supabase/player_props.sql first';
  end if;
end $dep$;

create table if not exists public.player_prop_watchlist (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,
  item_key text not null,
  league text not null,
  label text null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, item_key)
);
do $chk$ begin
  if not exists (select 1 from pg_constraint where conname = 'player_prop_watchlist_kind') then
    alter table public.player_prop_watchlist add constraint player_prop_watchlist_kind check (kind in ('player', 'prop', 'game'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_watchlist_key') then
    alter table public.player_prop_watchlist add constraint player_prop_watchlist_key check (length(item_key) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_watchlist_league') then
    alter table public.player_prop_watchlist add constraint player_prop_watchlist_league check (league in ('nfl', 'cfb', 'nba', 'ncaab', 'mlb', 'ufc'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_prop_watchlist_label') then
    alter table public.player_prop_watchlist add constraint player_prop_watchlist_label check (label is null or length(label) <= 200);
  end if;
end $chk$;
create index if not exists player_prop_watchlist_user on public.player_prop_watchlist (user_id, league);

-- the row always belongs to whoever inserts it
create or replace function public.player_prop_watchlist_owner() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  if new.user_id is null then raise exception 'player_prop_watchlist: a star needs a signed-in reader' using errcode = 'check_violation'; end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists player_prop_watchlist_owner_trg on public.player_prop_watchlist;
create trigger player_prop_watchlist_owner_trg before insert on public.player_prop_watchlist
  for each row execute function public.player_prop_watchlist_owner();

alter table public.player_prop_watchlist enable row level security;
drop policy if exists player_prop_watchlist_select_own on public.player_prop_watchlist;
create policy player_prop_watchlist_select_own on public.player_prop_watchlist for select to authenticated using (user_id = auth.uid());
drop policy if exists player_prop_watchlist_insert_own on public.player_prop_watchlist;
create policy player_prop_watchlist_insert_own on public.player_prop_watchlist for insert to authenticated with check (user_id = auth.uid());
drop policy if exists player_prop_watchlist_delete_own on public.player_prop_watchlist;
create policy player_prop_watchlist_delete_own on public.player_prop_watchlist for delete to authenticated using (user_id = auth.uid());
revoke all on public.player_prop_watchlist from anon;
revoke update on public.player_prop_watchlist from authenticated;
grant select, insert, delete on public.player_prop_watchlist to authenticated;

notify pgrst, 'reload schema';

-- THE REPORT.
select piece, state from (
  select 'player_prop_watchlist table' as piece, case when to_regclass('public.player_prop_watchlist') is not null then 'ok' else 'CHECK THIS' end as state
  union all select 'owner trigger', case when exists (select 1 from pg_trigger where tgname = 'player_prop_watchlist_owner_trg') then 'ok' else 'CHECK THIS' end
  union all select 'RLS', case when (select relrowsecurity from pg_class where oid = 'public.player_prop_watchlist'::regclass) then 'ok' else 'CHECK THIS' end
  union all select 'owner-only policies', case when (select count(*) from pg_policies where tablename = 'player_prop_watchlist') = 3 then 'ok' else 'CHECK THIS' end
) r order by 1;

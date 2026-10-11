-- =============================================================================
-- saved_research — a reader's saved desk answers and fair-line sheets, on
-- their account instead of one browser's localStorage.
--
-- WHY
--   The desk's "save" wrote to localStorage (ed_research_snapshots_v1): a new
--   phone, a cleared browser or a second device lost every saved answer, and
--   nothing on the server knew they existed. This table keeps them per
--   reader, under row level security, with the answer frozen as it was given.
--
-- THE RULES, ENFORCED HERE
--   1. A reader reads, saves, edits and deletes only their own rows
--      (auth.uid() = user_id); anon has no access at all.
--   2. What was saved is frozen: the question, the answer, the structured
--      payload, the game and the time cannot be edited after the insert, by
--      anyone. A reader may rename it, annotate it, archive it, or delete
--      their own row (it is their research, not EdgeDesk's record; EdgeDesk's
--      own record is research_packets and desk_prediction_history).
--   3. Bounded: at most 500 saved items per reader, an answer up to 20,000
--      characters and a payload up to 200 KB, so the table cannot be used as
--      free storage.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- Rollback: supabase/saved_research_rollback.sql (keeps the rows).
-- =============================================================================

create table if not exists public.saved_research (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('desk_answer','fair_line','note')),
  sport       text check (sport is null or length(sport) <= 64),
  game_id     text check (game_id is null or length(game_id) <= 64),
  title       text not null check (length(title) between 1 and 160),
  note        text check (note is null or length(note) <= 4000),
  question    text check (question is null or length(question) <= 1000),
  answer      text check (answer is null or length(answer) <= 20000),
  payload     jsonb check (payload is null or octet_length(payload::text) <= 200000),
  archived    boolean not null default false,
  updated_at  timestamptz not null default now()
);
create index if not exists saved_research_user_idx on public.saved_research (user_id, created_at desc);
comment on table public.saved_research is
  'A reader''s saved desk answers and fair-line sheets. Content frozen at insert; title, note and archived are the reader''s to change.';

-- WHAT WAS SAVED STAYS AS IT WAS SAVED.
create or replace function public.saved_research_freeze()
returns trigger language plpgsql as $$
begin
  if new.user_id is distinct from old.user_id or new.created_at is distinct from old.created_at or new.kind is distinct from old.kind
     or new.sport is distinct from old.sport or new.game_id is distinct from old.game_id or new.question is distinct from old.question
     or new.answer is distinct from old.answer or new.payload is distinct from old.payload then
    raise exception 'saved_research: what was saved cannot be edited (row %); rename, annotate, archive or delete it instead', old.id
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists saved_research_freeze_trg on public.saved_research;
create trigger saved_research_freeze_trg
  before update on public.saved_research
  for each row execute function public.saved_research_freeze();

-- AT MOST 500 PER READER.
create or replace function public.saved_research_cap()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.saved_research where user_id = new.user_id) >= 500 then
    raise exception 'saved_research: 500 saved items is the limit; delete or archive some first' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists saved_research_cap_trg on public.saved_research;
create trigger saved_research_cap_trg
  before insert on public.saved_research
  for each row execute function public.saved_research_cap();

alter table public.saved_research enable row level security;
drop policy if exists saved_research_select_own on public.saved_research;
create policy saved_research_select_own on public.saved_research for select to authenticated using (user_id = auth.uid());
drop policy if exists saved_research_insert_own on public.saved_research;
create policy saved_research_insert_own on public.saved_research for insert to authenticated with check (user_id = auth.uid());
drop policy if exists saved_research_update_own on public.saved_research;
create policy saved_research_update_own on public.saved_research for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists saved_research_delete_own on public.saved_research;
create policy saved_research_delete_own on public.saved_research for delete to authenticated using (user_id = auth.uid());

revoke all on public.saved_research from anon;
revoke all on public.saved_research from authenticated;
grant select, insert, delete on public.saved_research to authenticated;
grant update (title, note, archived) on public.saved_research to authenticated;
grant select on public.saved_research to service_role;

notify pgrst, 'reload schema';

select 'saved_research table' as piece, case when to_regclass('public.saved_research') is not null then 'ok' else 'CHECK THIS' end as state
union all select 'row level security', case when (select relrowsecurity from pg_class where oid = 'public.saved_research'::regclass) then 'ok' else 'CHECK THIS' end
union all select 'content frozen after save', case when exists (select 1 from pg_trigger where tgname = 'saved_research_freeze_trg') then 'ok' else 'CHECK THIS' end
union all select 'per-reader cap', case when exists (select 1 from pg_trigger where tgname = 'saved_research_cap_trg') then 'ok' else 'CHECK THIS' end
union all select 'four own-row policies', case when (select count(*) from pg_policies where tablename = 'saved_research') = 4 then 'ok' else 'CHECK THIS' end;

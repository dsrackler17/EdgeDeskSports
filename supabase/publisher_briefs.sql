-- ===========================================================================
-- PUBLISHER BRIEFS — shareable SNAPSHOTS of an EdgeDesk decision.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHY TWO TABLES
--   A published brief must never silently change when live odds change, and
--   a public brief must never expose privileged research. So a brief is a
--   snapshot row, split in two:
--     publisher_briefs          the publishable payload only (call, good-to,
--                               plain-English why/risk/change, data check,
--                               price capture timestamps). Readable by anyone
--                               once is_public is true; owner-only otherwise.
--     publisher_brief_internal  the engine internals behind it (verdict fields,
--                               edge, reasons, falsifiers). Owner-only, always.
--   Column-level grants would also work, but two tables make the boundary a
--   structural fact rather than a policy that has to stay correct.
--
-- VERSIONING
--   Refreshing a brief is deliberate: the client inserts a NEW row with
--   version_no + 1 and parent_id pointing at the old one. Old rows, and old
--   share slugs, stay exactly as published. Every public price carries its
--   capture timestamp inside public_payload.
-- ===========================================================================

begin;

create table if not exists public.publisher_briefs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  report_key         text not null,
  report_type        text not null check (report_type in ('GAME', 'SLATE')),
  preset             text not null default 'GAME' check (preset in ('GAME', 'TNF', 'SNF', 'MNF', 'CFB', 'SLATE')),
  version_no         integer not null default 1 check (version_no >= 1),
  parent_id          uuid references public.publisher_briefs (id) on delete set null,
  sport              text,
  sport_label        text,
  event_ids          text[] not null default '{}',
  title              text not null,
  kicker             text,
  event_label        text,
  when_label         text,
  generated_at       timestamptz not null,
  price_captured_at  timestamptz,
  integrity_status   text not null default 'OK' check (integrity_status in ('OK', 'PROVISIONAL', 'FAILED')),
  freshness_status   text not null default 'CURRENT' check (freshness_status in ('CURRENT', 'AGING', 'UNKNOWN', 'STALE')),
  public_payload     jsonb not null,
  is_public          boolean not null default false,
  share_slug         text unique,
  created_at         timestamptz not null default now()
);

create index if not exists publisher_briefs_owner_idx on public.publisher_briefs (user_id, created_at desc);
create index if not exists publisher_briefs_key_idx on public.publisher_briefs (user_id, report_key, version_no desc);
create index if not exists publisher_briefs_public_idx on public.publisher_briefs (share_slug) where is_public;

create table if not exists public.publisher_brief_internal (
  brief_id         uuid primary key references public.publisher_briefs (id) on delete cascade,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  internal_payload jsonb not null,
  created_at       timestamptz not null default now()
);

alter table public.publisher_briefs enable row level security;
alter table public.publisher_brief_internal enable row level security;

-- Owner: full control over their own briefs.
drop policy if exists "briefs owner select" on public.publisher_briefs;
create policy "briefs owner select" on public.publisher_briefs
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "briefs owner insert" on public.publisher_briefs;
create policy "briefs owner insert" on public.publisher_briefs
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "briefs owner update" on public.publisher_briefs;
create policy "briefs owner update" on public.publisher_briefs
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "briefs owner delete" on public.publisher_briefs;
create policy "briefs owner delete" on public.publisher_briefs
  for delete to authenticated using (user_id = auth.uid());

-- Anyone, signed in or not: a brief the owner deliberately made public,
-- and ONLY that. The public payload is the only payload in this table.
drop policy if exists "briefs public read" on public.publisher_briefs;
create policy "briefs public read" on public.publisher_briefs
  for select to anon, authenticated using (is_public = true and share_slug is not null);

-- Internals: owner only, no public path at all.
drop policy if exists "brief internals owner all" on public.publisher_brief_internal;
create policy "brief internals owner all" on public.publisher_brief_internal
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.publisher_briefs to anon;
grant select, insert, update, delete on public.publisher_briefs to authenticated;
grant select, insert, update, delete on public.publisher_brief_internal to authenticated;

-- A share slug is minted client-side (random, 12+ chars). Belt and braces:
-- a public row must carry one, and nobody may publish without one.
alter table public.publisher_briefs drop constraint if exists publisher_briefs_public_needs_slug;
alter table public.publisher_briefs add constraint publisher_briefs_public_needs_slug
  check (not is_public or share_slug is not null);

commit;

-- Report: rows 1-3 should say ok.
select '1 tables' as step,
  case when to_regclass('public.publisher_briefs') is not null and to_regclass('public.publisher_brief_internal') is not null then 'ok' else 'MISSING' end as outcome
union all
select '2 rls', case when (select relrowsecurity from pg_class where oid = 'public.publisher_briefs'::regclass) then 'ok' else 'OFF' end
union all
select '3 public policy', case when exists (select 1 from pg_policies where tablename = 'publisher_briefs' and policyname = 'briefs public read') then 'ok' else 'MISSING' end;

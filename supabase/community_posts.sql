-- ===========================================================================
-- COMMUNITY POSTS — what a member writes, and who may put it in public.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
-- Run AFTER billing.sql (it reads public.subscriptions) and after
-- site_articles.sql (it reuses public.site_article_admins as the operator
-- allowlist rather than starting a second one).
--
-- THE ONE RULE THIS FILE EXISTS FOR
--   Anybody with an EdgeDesk account may WRITE. Only an entitled subscriber
--   may PUBLISH without an editor reading it first. Everyone else's post
--   lands as `pending` and an operator moves it.
--
--   That rule is a TRIGGER, not a policy and certainly not a browser check.
--   An RLS policy can say which rows you may update; it cannot say which
--   VALUE you may put in a column, and "a free account may set status to
--   anything except published" is a statement about a value. So the trigger
--   below rewrites the status it was handed, and the composer's own copy of
--   the rule (tools/articles/community.js) exists to tell a writer what will
--   happen before they spend twenty minutes on a post — never to decide it.
--
-- WHY MEMBER POSTS ARE A SEPARATE TABLE FROM site_articles
--   An EdgeDesk research article is generated from the model and is checked
--   so that nothing on it can read as a pick. A member post is a person's own
--   writing and no check can make it EdgeDesk's view of a game. Two tables
--   makes that a structural fact rather than a status column somebody has to
--   remember to filter on — the research sitemap cannot accidentally list a
--   member post, because it is not in the table the builder reads.
-- ===========================================================================

begin;

create extension if not exists pgcrypto;

-- ── RUN THE OTHER TWO FIRST ────────────────────────────────────────────────
-- This file's policies are written against public.site_article_is_admin() and
-- its entitlement test reads public.subscriptions. A CREATE POLICY expression
-- is resolved when the policy is created, so a missing predicate does not
-- degrade — it stops the file with `42883: function
-- public.site_article_is_admin() does not exist`, which says what is missing
-- and nothing about what to do. This says it up front instead.
--
-- Worth knowing WHY that happens even to somebody who did run site_articles.sql:
-- until it was fixed, that file died partway through on a project without
-- issue_reports.sql, and because it is one transaction the rollback took the
-- admin function with it. A re-run of the current site_articles.sql fixes it.
do $preflight$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception E'community_posts.sql needs public.subscriptions.\n'
      '  Run supabase/billing.sql first, then supabase/site_articles.sql, then this file.'
      using errcode = '42P01';
  end if;
  if to_regproc('public.site_article_is_admin') is null then
    raise exception E'community_posts.sql needs public.site_article_is_admin().\n'
      '  Run supabase/site_articles.sql first, then this file.\n'
      '  If you already ran it and are still seeing this, it rolled back: the version before\n'
      '  2026-09-08 stopped on a project with no public.issue_report_admins, and the whole file\n'
      '  is one transaction. Re-run the current supabase/site_articles.sql and its report should\n'
      '  end with row 12; then run this file again.'
      using errcode = '42883';
  end if;
end
$preflight$;

create table if not exists public.community_posts (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_name    text not null,
  slug           text not null,
  title          text not null,
  body           text not null,
  sport          text,
  article_slug   text,
  status         text not null default 'pending',
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  moderated_by   uuid references auth.users (id) on delete set null,
  moderated_at   timestamptz,
  moderation_note text,
  flagged_terms  text[] not null default '{}'
);

-- Additive, column by column: `create table if not exists` no-ops against a
-- table somebody made by hand in the dashboard and would leave a partial
-- shape intact. See supabase/README.md.
alter table public.community_posts add column if not exists author_name    text;
alter table public.community_posts add column if not exists slug           text;
alter table public.community_posts add column if not exists title          text;
alter table public.community_posts add column if not exists body           text;
alter table public.community_posts add column if not exists sport          text;
alter table public.community_posts add column if not exists article_slug   text;
alter table public.community_posts add column if not exists status         text not null default 'pending';
alter table public.community_posts add column if not exists published_at   timestamptz;
alter table public.community_posts add column if not exists created_at     timestamptz not null default now();
alter table public.community_posts add column if not exists updated_at     timestamptz not null default now();
alter table public.community_posts add column if not exists moderated_by   uuid;
alter table public.community_posts add column if not exists moderated_at   timestamptz;
alter table public.community_posts add column if not exists moderation_note text;
alter table public.community_posts add column if not exists flagged_terms  text[] not null default '{}';

alter table public.community_posts drop constraint if exists community_posts_status_ck;
alter table public.community_posts add constraint community_posts_status_ck
  check (status in ('draft', 'pending', 'published', 'rejected', 'removed'));
alter table public.community_posts drop constraint if exists community_posts_sport_ck;
alter table public.community_posts add constraint community_posts_sport_ck
  check (sport is null or sport in ('CFB', 'NFL'));
alter table public.community_posts drop constraint if exists community_posts_len_ck;
alter table public.community_posts add constraint community_posts_len_ck
  check (char_length(title) between 8 and 140
     and char_length(body) between 200 and 20000
     and char_length(author_name) between 2 and 40);

create unique index if not exists community_posts_slug_uk on public.community_posts (slug);
create index if not exists community_posts_public_idx on public.community_posts (status, published_at desc);
create index if not exists community_posts_author_idx on public.community_posts (author_id, created_at desc);
create index if not exists community_posts_article_idx on public.community_posts (article_slug) where article_slug is not null;

-- ---------------------------------------------------------------- entitled
-- pgEntitled() from app.html, in the database, because this is the half of it
-- that decides something. Comp rows, the trialing state and Stripe's 21-day
-- past-due grace are all here for the same reason they are there: cutting a
-- customer off on the first failed charge locks out somebody Stripe is still
-- collecting from.
create or replace function public.community_is_entitled(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user
      and (
        (s.status = 'active' and coalesce(s.price_id, '') in ('owner_comp'))
        or (s.status in ('active', 'trialing')
            and (s.current_period_end is null or s.current_period_end >= now()))
        or (s.status = 'past_due'
            and (s.current_period_end is null or now() - s.current_period_end < interval '21 days'))
      )
  );
$$;
revoke all on function public.community_is_entitled(uuid) from public;
grant execute on function public.community_is_entitled(uuid) to authenticated;

-- What the composer asks so it can tell the writer what pressing Publish will
-- do. It answers only about the CALLER — there is no argument for a user id,
-- so nothing a page sends can ask about somebody else.
create or replace function public.community_can_publish()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public.community_is_entitled(auth.uid());
$$;
revoke all on function public.community_can_publish() from public;
grant execute on function public.community_can_publish() to authenticated, anon;

-- ------------------------------------------------------------- the wordlist
-- Mirrors BANNED_TERMS in tools/articles/community.js, one alternative per
-- row. PostgreSQL spells a word boundary `\y` (here `\b` is a backspace), so
-- the boundary is added around the joined list rather than stored with each
-- entry — which is also why the JavaScript list carries no boundary syntax of
-- its own. tools/articles/community.test.js fails if the two drift.
create table if not exists public.community_banned_terms (
  term text primary key
);
insert into public.community_banned_terms (term) values
  ('best bets?'),
  ('lock of the'),
  ('mortal lock'),
  ('guaranteed win(?:ner|s)?'),
  ('free money'),
  ('sure thing'),
  ('cannot lose'),
  ('can.?t lose'),
  ('no.?brainer'),
  ('easy money'),
  ('100% winner'),
  ('bet the house'),
  ('max bet'),
  ('mortgage'),
  ('hammer(?:ing)? (?:this|the|it)'),
  ('smash (?:play|spot|this)'),
  ('(?:my|our|the) pick is'),
  ('take the points'),
  ('play of the (?:day|week|year)'),
  ('guaranteed profit'),
  ('risk.?free')
on conflict (term) do nothing;
alter table public.community_banned_terms enable row level security;
-- readable by anyone (the composer shows the reason), writable by nobody but
-- the service role and an operator
drop policy if exists "banned terms read" on public.community_banned_terms;
create policy "banned terms read" on public.community_banned_terms
  for select to anon, authenticated using (true);
grant select on public.community_banned_terms to anon, authenticated;

create or replace function public.community_flagged(p_text text)
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct t.term), '{}')
  from public.community_banned_terms t
  where p_text ~* ('\y(?:' || t.term || ')\y');
$$;

-- ------------------------------------------------------------- the trigger
-- Everything a browser must not be trusted with, in one place: who may
-- publish, what the timestamps say, how many posts an author may put up in a
-- day, and whether the text carries a phrase this site does not print.
create or replace function public.community_posts_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin   boolean := coalesce(public.site_article_is_admin(), false);
  v_owner   boolean := (auth.uid() is not null and new.author_id = auth.uid());
  v_ent     boolean := public.community_is_entitled(new.author_id);
  v_flags   text[];
  v_recent  integer;
  v_was     text := null;              -- OLD.status, only on an update
  v_published_at timestamptz := null;  -- OLD.published_at, only on an update
begin
  new.updated_at := now();

  -- AN AUTHOR IS NEVER SOMEBODY ELSE. The column defaults to auth.uid() and
  -- an insert that names a different one is refused outright rather than
  -- quietly rewritten, so a page trying it gets an error it has to explain.
  if tg_op = 'INSERT' and auth.uid() is not null and new.author_id <> auth.uid() and not v_admin then
    raise exception 'a post is filed under its own author';
  end if;

  -- the wordlist, on the text as submitted
  v_flags := public.community_flagged(coalesce(new.title, '') || E'\n' || coalesce(new.body, ''));
  new.flagged_terms := v_flags;

  -- OLD IS ONLY READ UNDER tg_op = 'UPDATE', and it is read in its own branch
  -- rather than inside a boolean expression: SQL does not promise to
  -- short-circuit an OR, so `tg_op = 'INSERT' or old.status = ...` is a way
  -- to touch OLD on an insert and find out the hard way.
  if tg_op = 'UPDATE' then
    v_was := old.status;
    v_published_at := old.published_at;
  end if;

  -- MODERATION IS THE OPERATOR'S ALONE. Only an admin may move a row that is
  -- already published, rejected or removed... except for the one case below.
  if not v_admin then
    if tg_op = 'UPDATE' and v_was in ('published', 'rejected', 'removed') and new.status <> v_was then
      -- an author may always withdraw their own post, and nothing else
      if not (v_owner and new.status = 'removed') then
        new.status := v_was;
      end if;
    end if;

    if new.status = 'published' then
      -- ...and this is the rule the whole file is for.
      if not v_ent then
        new.status := 'pending';
      elsif array_length(v_flags, 1) is not null then
        -- an entitled subscriber publishes straight through, but not a post
        -- carrying a phrase EdgeDesk does not print. It queues instead of
        -- being thrown away: the writing is not wasted, it is just read first.
        new.status := 'pending';
      end if;
    end if;

    if new.status not in ('draft', 'pending', 'published', 'removed') then
      new.status := 'pending';
    end if;
  end if;

  -- HOW MANY. A rolling day, counted from rows that are actually public, so a
  -- queue full of pending drafts never locks somebody out of writing.
  if new.status = 'published' and v_was is distinct from 'published' and not v_admin then
    select count(*) into v_recent
    from public.community_posts p
    where p.author_id = new.author_id
      and p.status = 'published'
      and p.published_at > now() - interval '24 hours'
      and p.id <> new.id;
    if v_recent >= 5 then
      raise exception 'five published posts in a day is the limit; the rest keep until tomorrow';
    end if;
  end if;

  -- published_at is stamped ONCE and never rewritten, the same rule the
  -- research articles follow: a reader and a crawler both need to know it is
  -- the same document, and an unpublish-then-approve must not make an old
  -- post look new.
  if new.status = 'published' then
    if v_published_at is not null then
      new.published_at := v_published_at;
    elsif new.published_at is null then
      new.published_at := now();
    end if;
  else
    new.published_at := v_published_at;
  end if;

  if v_admin and tg_op = 'UPDATE' and new.status is distinct from v_was then
    new.moderated_by := auth.uid();
    new.moderated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists community_posts_guard_t on public.community_posts;
create trigger community_posts_guard_t before insert or update on public.community_posts
  for each row execute function public.community_posts_guard();

-- --------------------------------------------------------------------- RLS
alter table public.community_posts enable row level security;

-- ANYONE, signed in or not: a published post. Nothing else. A pending post is
-- not merely hidden from the feed, it is unreadable.
drop policy if exists "community public read" on public.community_posts;
create policy "community public read" on public.community_posts
  for select to anon, authenticated using (status = 'published');

-- An author sees their own, in every state, so a queued post is not a post
-- that vanished.
drop policy if exists "community author read" on public.community_posts;
create policy "community author read" on public.community_posts
  for select to authenticated using (author_id = auth.uid());

-- ANY signed-in account may write. What that write BECOMES is the trigger's
-- decision, not this policy's.
drop policy if exists "community author insert" on public.community_posts;
create policy "community author insert" on public.community_posts
  for insert to authenticated with check (author_id = auth.uid());

-- An author may edit their own post. They may not moderate it: the trigger
-- puts the status back.
drop policy if exists "community author update" on public.community_posts;
create policy "community author update" on public.community_posts
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());

-- The operator, on everything. There is no delete policy for anybody: a post
-- that broke a rule is evidence, and `removed` takes it off the site without
-- destroying the record of what was said.
drop policy if exists "community admin read" on public.community_posts;
create policy "community admin read" on public.community_posts
  for select to authenticated using (public.site_article_is_admin());
drop policy if exists "community admin update" on public.community_posts;
create policy "community admin update" on public.community_posts
  for update to authenticated using (public.site_article_is_admin())
  with check (public.site_article_is_admin());

grant select on public.community_posts to anon;
grant select, insert, update on public.community_posts to authenticated;

comment on table public.community_posts is
  'Member-written posts. NOT EdgeDesk research: they live in their own section at '
  '/articles/community/, carry a member-post label on every surface, are noindex, and '
  'appear in no sitemap. anon reads published rows only. Who may publish without an '
  'editor is decided by community_posts_guard(), never by a client.';

commit;

-- Report: every row should say ok.
select 1 as step, 'table exists' as check,
  case when to_regclass('public.community_posts') is not null then 'ok' else 'CHECK THIS' end as outcome
union all select 2, 'RLS is on',
  case when (select relrowsecurity from pg_class where oid = 'public.community_posts'::regclass) then 'ok' else 'CHECK THIS' end
union all select 3, 'anon reads published rows only',
  case when exists (select 1 from pg_policies where tablename = 'community_posts'
      and policyname = 'community public read' and qual like '%published%') then 'ok' else 'CHECK THIS' end
-- The policy set, not the grant: Supabase hands anon table-level DML by
-- default privilege and lets RLS decide. See the same note in
-- site_articles.sql.
union all select 4, 'anon has no policy that writes',
  case when not exists (select 1 from pg_policies
      where tablename = 'community_posts' and cmd <> 'SELECT'
        and ('anon' = any(roles) or 'public' = any(roles))) then 'ok' else 'CHECK THIS' end
-- A post that broke a rule is evidence. `removed` takes it off the site; no
-- client role has a policy that could destroy the record of what was said.
union all select 5, 'nobody may delete a post',
  case when not exists (select 1 from pg_policies
      where tablename = 'community_posts' and cmd in ('DELETE', 'ALL')) then 'ok' else 'CHECK THIS' end
union all select 6, 'publishing is decided by a trigger',
  case when exists (select 1 from pg_trigger where tgname = 'community_posts_guard_t') then 'ok' else 'CHECK THIS' end
union all select 7, 'the entitlement test reads subscriptions',
  case when to_regclass('public.subscriptions') is not null
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'community_is_entitled' and p.prosecdef)
    then 'ok' else 'CHECK THIS — run billing.sql first' end
union all select 8, 'the operator allowlist is the one site_articles.sql installed',
  case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'site_article_is_admin')
    then 'ok' else 'CHECK THIS — run site_articles.sql first' end
union all select 9, 'a slug belongs to one post',
  case when exists (select 1 from pg_indexes where tablename = 'community_posts'
      and indexname = 'community_posts_slug_uk') then 'ok' else 'CHECK THIS' end
union all select 10, 'the wordlist is loaded',
  case when (select count(*) from public.community_banned_terms) >= 20 then 'ok' else 'CHECK THIS' end
union all select 11, 'the wordlist matches what it should',
  case when array_length(public.community_flagged('this is my best bet and a mortal lock'), 1) = 2
    then 'ok' else 'CHECK THIS' end
union all select 12, 'and clears what it should',
  case when array_length(public.community_flagged('Missouri rates better on a neutral field.'), 1) is null
    then 'ok' else 'CHECK THIS' end
order by 1;

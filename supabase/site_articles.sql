-- ===========================================================================
-- SITE ARTICLES — the publication state of EdgeDesk's public research pages.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHAT THIS IS FOR, AND WHAT IT IS NOT
--   EdgeDesk is served as static files, so the ARTICLE a reader and a crawler
--   see is a committed page under /articles/, built by
--   tools/articles/build_articles.js from a committed record. That does not
--   change and this table does not try to change it: a row here never renders
--   anything.
--
--   What this table holds is the DECISION — draft / ready / published /
--   archived, the auto-publish switch, and the timestamps — so the operator
--   can make it from a browser or a phone without a checkout, and the next
--   pipeline run honours it. The generator reads this table when it can reach
--   it and falls back to the committed store when it cannot, so a network
--   outage delays a publication rather than losing one.
--
-- WHY THE PAYLOAD IS HERE TOO
--   `article` is the structured record, not rendered HTML: the same JSON the
--   repository stores. Keeping it means the operator's preview screen can
--   render a real article without cloning the repo, and it means a published
--   row is self-describing if the store and the table ever disagree. It is
--   NOT a second source of numbers — every figure inside it came out of the
--   research payload the model produced, and nothing reads it as an input.
--
-- WHO MAY DO WHAT
--   anon / any signed-in reader: SELECT rows whose status is 'published'.
--                                Nothing else, ever. A draft is invisible.
--   an operator on the allowlist: everything.
--   Admin is decided by `public.site_article_admins`, a table with RLS on and
--   no client grants at all, asked through a security-definer function — the
--   same shape `issue_reports.sql` uses, so there is one pattern for "is this
--   person the operator" rather than two.
-- ===========================================================================

begin;

create table if not exists public.site_articles (
  id             text primary key,
  game_id        text not null,
  sport          text not null,
  slug           text not null,
  title          text not null,
  seo_title      text,
  seo_description text,
  excerpt        text,
  article        jsonb not null,
  home_team      text not null,
  away_team      text not null,
  game_time      timestamptz,
  published_at   timestamptz,
  updated_at     timestamptz not null default now(),
  generated_at   timestamptz,
  model_version  text,
  model_status   text,
  confidence     numeric,
  hero_image     text,
  canonical_url  text not null,
  status         text not null default 'draft',
  frozen         boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Additive, column by column, so a table somebody made by hand in the
-- dashboard is completed rather than left half-shaped by a no-op
-- `create table if not exists`. close_v7_parity.sql was bitten by exactly
-- that; see supabase/README.md.
alter table public.site_articles add column if not exists game_id text;
alter table public.site_articles add column if not exists sport text;
alter table public.site_articles add column if not exists slug text;
alter table public.site_articles add column if not exists title text;
alter table public.site_articles add column if not exists seo_title text;
alter table public.site_articles add column if not exists seo_description text;
alter table public.site_articles add column if not exists excerpt text;
alter table public.site_articles add column if not exists article jsonb;
alter table public.site_articles add column if not exists home_team text;
alter table public.site_articles add column if not exists away_team text;
alter table public.site_articles add column if not exists game_time timestamptz;
alter table public.site_articles add column if not exists published_at timestamptz;
alter table public.site_articles add column if not exists updated_at timestamptz not null default now();
alter table public.site_articles add column if not exists generated_at timestamptz;
alter table public.site_articles add column if not exists model_version text;
alter table public.site_articles add column if not exists model_status text;
alter table public.site_articles add column if not exists confidence numeric;
alter table public.site_articles add column if not exists hero_image text;
alter table public.site_articles add column if not exists canonical_url text;
alter table public.site_articles add column if not exists status text not null default 'draft';
alter table public.site_articles add column if not exists frozen boolean not null default false;
alter table public.site_articles add column if not exists created_at timestamptz not null default now();

-- The five states the product actually has. A row outside them is a bug that
-- would otherwise reach a reader as a blank page.
alter table public.site_articles drop constraint if exists site_articles_status_ck;
alter table public.site_articles add constraint site_articles_status_ck
  check (status in ('draft', 'ready', 'published', 'updated', 'archived'));

-- A public URL belongs to ONE article. Enforced here as well as in the
-- generator, because two rows racing for one slug is exactly the case a
-- client-side check cannot see.
create unique index if not exists site_articles_slug_uk on public.site_articles (slug);
create index if not exists site_articles_status_idx on public.site_articles (status, published_at desc);
create index if not exists site_articles_sport_idx on public.site_articles (sport, game_time);
create index if not exists site_articles_game_idx on public.site_articles (game_id);

-- A published row must be able to name itself. A page with no canonical URL
-- and no publication date is not published, whatever the column says.
alter table public.site_articles drop constraint if exists site_articles_published_shape_ck;
alter table public.site_articles add constraint site_articles_published_shape_ck
  check (status <> 'published' or (canonical_url is not null and published_at is not null));

-- ---------------------------------------------------------------- settings
-- One row, id = 1. Auto-publish is OFF until somebody turns it on.
create table if not exists public.site_article_settings (
  id            smallint primary key default 1,
  auto_publish  boolean not null default false,
  auto_publish_min_lead_minutes integer not null default 90,
  auto_publish_max_lead_days    integer not null default 14,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  constraint site_article_settings_singleton check (id = 1)
);
insert into public.site_article_settings (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------------- admin
create table if not exists public.site_article_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note    text,
  added_at timestamptz not null default now()
);
alter table public.site_article_admins enable row level security;
revoke all on public.site_article_admins from anon, authenticated;

-- Reuse the operator allowlist that already exists rather than building a
-- second one: anybody who triages problem reports is already the operator.
insert into public.site_article_admins (user_id, note)
select a.user_id, 'carried over from issue_report_admins'
from public.issue_report_admins a
where to_regclass('public.issue_report_admins') is not null
on conflict (user_id) do nothing;

create or replace function public.site_article_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and exists (select 1 from public.site_article_admins a where a.user_id = auth.uid());
$$;
revoke all on function public.site_article_is_admin() from public;
grant execute on function public.site_article_is_admin() to authenticated;

-- --------------------------------------------------------------------- RLS
alter table public.site_articles enable row level security;
alter table public.site_article_settings enable row level security;

-- ANYONE, signed in or not: published articles only. This is the policy the
-- whole design rests on — the keyless build job reads through it, and a draft
-- is not merely hidden from the site, it is unreadable.
drop policy if exists "articles public read" on public.site_articles;
create policy "articles public read" on public.site_articles
  for select to anon, authenticated using (status = 'published');

drop policy if exists "articles admin read" on public.site_articles;
create policy "articles admin read" on public.site_articles
  for select to authenticated using (public.site_article_is_admin());
drop policy if exists "articles admin insert" on public.site_articles;
create policy "articles admin insert" on public.site_articles
  for insert to authenticated with check (public.site_article_is_admin());
drop policy if exists "articles admin update" on public.site_articles;
create policy "articles admin update" on public.site_articles
  for update to authenticated using (public.site_article_is_admin())
  with check (public.site_article_is_admin());
drop policy if exists "articles admin delete" on public.site_articles;
create policy "articles admin delete" on public.site_articles
  for delete to authenticated using (public.site_article_is_admin());

-- The settings row is readable by the build job (it needs to know whether
-- auto-publish is on) and writable only by an operator.
drop policy if exists "article settings read" on public.site_article_settings;
create policy "article settings read" on public.site_article_settings
  for select to anon, authenticated using (true);
drop policy if exists "article settings admin write" on public.site_article_settings;
create policy "article settings admin write" on public.site_article_settings
  for update to authenticated using (public.site_article_is_admin())
  with check (public.site_article_is_admin());

grant select on public.site_articles to anon;
grant select, insert, update, delete on public.site_articles to authenticated;
grant select on public.site_article_settings to anon;
grant select, update on public.site_article_settings to authenticated;

-- Publishing stamps published_at ONCE and moves updated_at on every write.
-- In the trigger rather than the client because "do not silently rewrite a
-- published article without updating updated_at" is a promise to the reader,
-- and a promise a browser can forget to keep is not one.
create or replace function public.site_articles_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  -- an article whose game has started is a record of what was said before it
  if new.game_time is not null and new.game_time <= now() then
    new.frozen := true;
  end if;
  return new;
end;
$$;
drop trigger if exists site_articles_touch_t on public.site_articles;
create trigger site_articles_touch_t before insert or update on public.site_articles
  for each row execute function public.site_articles_touch();

comment on table public.site_articles is
  'Publication state and structured payload for EdgeDesk public research articles. '
  'The RENDERED page is a committed static file under /articles/ built by '
  'tools/articles/build_articles.js; this table holds the decision, not the page. '
  'anon may select published rows only.';
comment on column public.site_articles.article is
  'The structured article record (article_model.js). Every figure in it came from the '
  'research payload the football model produced; nothing reads it back as a model input.';

commit;

-- Report: every row should say ok.
select 1 as step, 'tables exist' as check,
  case when to_regclass('public.site_articles') is not null
        and to_regclass('public.site_article_settings') is not null
        and to_regclass('public.site_article_admins') is not null then 'ok' else 'CHECK THIS' end as outcome
union all select 2, 'RLS on site_articles',
  case when (select relrowsecurity from pg_class where oid = 'public.site_articles'::regclass) then 'ok' else 'CHECK THIS' end
union all select 3, 'RLS on site_article_settings',
  case when (select relrowsecurity from pg_class where oid = 'public.site_article_settings'::regclass) then 'ok' else 'CHECK THIS' end
union all select 4, 'anon reads published only',
  case when exists (select 1 from pg_policies where tablename = 'site_articles'
      and policyname = 'articles public read' and qual like '%published%') then 'ok' else 'CHECK THIS' end
union all select 5, 'anon cannot write',
  case when not exists (select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'site_articles'
        and grantee = 'anon' and privilege_type in ('INSERT','UPDATE','DELETE')) then 'ok' else 'CHECK THIS' end
union all select 6, 'slug is unique',
  case when exists (select 1 from pg_indexes where tablename = 'site_articles'
      and indexname = 'site_articles_slug_uk') then 'ok' else 'CHECK THIS' end
union all select 7, 'status is constrained',
  case when exists (select 1 from pg_constraint where conname = 'site_articles_status_ck') then 'ok' else 'CHECK THIS' end
union all select 8, 'published rows must carry a URL and a date',
  case when exists (select 1 from pg_constraint where conname = 'site_articles_published_shape_ck') then 'ok' else 'CHECK THIS' end
union all select 9, 'updated_at is stamped by a trigger',
  case when exists (select 1 from pg_trigger where tgname = 'site_articles_touch_t') then 'ok' else 'CHECK THIS' end
union all select 10, 'is-admin is security definer',
  case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'site_article_is_admin' and p.prosecdef) then 'ok' else 'CHECK THIS' end
union all select 11, 'the admin allowlist is unreachable from a browser',
  case when not exists (select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'site_article_admins'
        and grantee in ('anon','authenticated')) then 'ok' else 'CHECK THIS' end
union all select 12, 'at least one operator is on the allowlist',
  case when (select count(*) from public.site_article_admins) > 0 then 'ok'
       else 'CHECK THIS — insert into public.site_article_admins(user_id) values (''<your auth.users id>'');' end
order by 1;

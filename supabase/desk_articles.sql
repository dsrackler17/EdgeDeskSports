-- ===========================================================================
-- THE DESK — data-first articles, a human take required, every number traced.
--
-- Paste into the Supabase SQL editor and run. Safe to run again. Apply AFTER
-- supabase/site_articles.sql (its operator allowlist decides who the owner
-- is). Optional neighbours, detected at run time: funnel.sql, growth.sql and
-- the Stripe tables (Article Performance reads them when they exist).
--
-- WHAT LIVES HERE
--   article_drafts   APPEND-ONLY. Every draft a generator produced: its body,
--                    and a data_snapshot holding every number it printed, the
--                    query that produced it and the file (digest + commit) the
--                    query read. Content can never be edited or deleted; only
--                    `status` and `notified_at` move, and only forward.
--   desk_articles    one row per article: which draft is current, which one
--                    is published, and the publication state.
--   article_takes    "My take", the one section a machine never writes, for a
--                    desk article or a game article. Every save is kept in
--                    article_take_revisions (append-only).
--   desk_settings    the minimum take length and the notification switch.
--   desk_notifications  the claim-before-send log for owner notifications.
--
-- THE RULE THE DATABASE ENFORCES
--   A desk article cannot become `published` unless a take of at least
--   desk_settings.min_take_chars exists for it AND the draft being published
--   passed its own voice and source checks. That is a TRIGGER, so it holds for
--   every caller: the owner's page, a script with the service role, a hand
--   UPDATE in this editor. A first publication of a game article through
--   site_articles is held to the same take rule (articles published before
--   this file are untouched).
--
-- WHO MAY DO WHAT
--   anon:           read published desk articles (view desk_published) and the
--                   takes of published game articles (article_takes_published).
--   the owner:      everything, through security-definer doors that check
--                   public.site_article_is_admin().
--   service role:   desk_draft_put (the generator) and the notify claim.
--   Nobody:         update a draft's content, delete a draft, delete a take
--                   revision.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.site_article_is_admin()') is null or to_regclass('public.site_articles') is null then
    raise exception 'Apply supabase/site_articles.sql first: the desk uses its operator allowlist (site_article_is_admin) and its table.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------- settings
create table if not exists public.desk_settings (
  id smallint primary key default 1,
  min_take_chars integer not null default 240,
  notify_enabled boolean not null default true,
  require_take_for_game_articles boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint desk_settings_singleton check (id = 1),
  constraint desk_settings_min_take check (min_take_chars between 1 and 5000)
);
alter table public.desk_settings add column if not exists min_take_chars integer not null default 240;
alter table public.desk_settings add column if not exists notify_enabled boolean not null default true;
alter table public.desk_settings add column if not exists require_take_for_game_articles boolean not null default true;
alter table public.desk_settings add column if not exists updated_at timestamptz not null default now();
alter table public.desk_settings add column if not exists updated_by uuid;
insert into public.desk_settings (id) values (1) on conflict (id) do nothing;

create or replace function public.desk_min_take() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select min_take_chars from public.desk_settings where id = 1), 240);
$$;
revoke all on function public.desk_min_take() from public;
grant execute on function public.desk_min_take() to anon, authenticated, service_role;

-- A take is measured the way a reader sees it: whitespace runs count once.
create or replace function public.desk_take_len(p text) returns integer
language sql immutable as $$
  select coalesce(length(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))), 0);
$$;

-- ------------------------------------------------------- article_drafts
create table if not exists public.article_drafts (
  id               bigint generated always as identity primary key,
  article_key      text not null,
  type             text not null,
  sport            text not null,
  season           integer,
  week             integer,
  period           text,
  slug             text not null,
  title            text not null,
  description      text,
  lead             text not null,
  highlights       jsonb not null default '[]'::jsonb,
  reddit_title     text,
  record_link      text,
  generated_body   text not null,
  body_hash        text not null,
  data_snapshot    jsonb not null,
  data_as_of       timestamptz,
  generator_version text not null,
  source_commit    text,
  generated_at     timestamptz not null default now(),
  status           text not null default 'draft',
  notified_at      timestamptz,
  notify_attempts  integer not null default 0,
  created_at       timestamptz not null default now()
);
alter table public.article_drafts add column if not exists notify_attempts integer not null default 0;
alter table public.article_drafts drop constraint if exists article_drafts_type_ck;
alter table public.article_drafts add constraint article_drafts_type_ck
  check (type in ('weekly_clv', 'disagreement', 'line_movement', 'got_wrong', 'research_notes'));
alter table public.article_drafts drop constraint if exists article_drafts_status_ck;
alter table public.article_drafts add constraint article_drafts_status_ck
  check (status in ('draft', 'superseded', 'published', 'discarded'));
-- a snapshot that carries no numbers cannot trace anything
alter table public.article_drafts drop constraint if exists article_drafts_snapshot_ck;
alter table public.article_drafts add constraint article_drafts_snapshot_ck
  check (jsonb_typeof(data_snapshot -> 'numbers') = 'array' and jsonb_typeof(data_snapshot -> 'sources') = 'array');
create unique index if not exists article_drafts_key_hash_uk on public.article_drafts (article_key, body_hash);
create index if not exists article_drafts_key_idx on public.article_drafts (article_key, id desc);
create index if not exists article_drafts_notify_idx on public.article_drafts (notified_at) where notified_at is null;

-- APPEND-ONLY. The content of a draft is what a published number is traced
-- back to, so no column but the two bookkeeping ones may change, status only
-- moves out of 'draft', and nothing is ever deleted.
create or replace function public.article_drafts_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'article_drafts is append-only: a draft is never deleted (mark it discarded)' using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'status' - 'notified_at' - 'notify_attempts') is distinct from (to_jsonb(old) - 'status' - 'notified_at' - 'notify_attempts') then
    raise exception 'article_drafts is append-only: draft % cannot be edited; generate a new one', old.id using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status and old.status <> 'draft' then
    raise exception 'article_drafts: draft % is % and cannot become %', old.id, old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists article_drafts_guard_t on public.article_drafts;
create trigger article_drafts_guard_t before update or delete on public.article_drafts
  for each row execute function public.article_drafts_guard();
create or replace function public.article_drafts_no_truncate() returns trigger
language plpgsql as $$ begin raise exception 'article_drafts is append-only: truncate refused'; end $$;
drop trigger if exists article_drafts_no_truncate_t on public.article_drafts;
create trigger article_drafts_no_truncate_t before truncate on public.article_drafts
  for each statement execute function public.article_drafts_no_truncate();

-- --------------------------------------------------------- desk_articles
create table if not exists public.desk_articles (
  article_key        text primary key,
  type               text not null,
  sport              text not null,
  season             integer,
  week               integer,
  period             text,
  slug               text not null,
  current_draft_id   bigint references public.article_drafts (id),
  published_draft_id bigint references public.article_drafts (id),
  status             text not null default 'awaiting_take',
  published_take     text,
  published_at       timestamptz,
  published_by       uuid,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now()
);
alter table public.desk_articles drop constraint if exists desk_articles_status_ck;
alter table public.desk_articles add constraint desk_articles_status_ck
  check (status in ('awaiting_take', 'ready', 'published', 'archived'));
create unique index if not exists desk_articles_slug_uk on public.desk_articles (slug);
create index if not exists desk_articles_status_idx on public.desk_articles (status, updated_at desc);

-- ---------------------------------------------------------- the takes
create table if not exists public.article_takes (
  article_id  text primary key,
  kind        text not null,
  take        text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.article_takes drop constraint if exists article_takes_kind_ck;
alter table public.article_takes add constraint article_takes_kind_ck check (kind in ('desk', 'game'));
create table if not exists public.article_take_revisions (
  id          bigint generated always as identity primary key,
  article_id  text not null,
  kind        text not null,
  take        text not null,
  saved_at    timestamptz not null default now(),
  saved_by    uuid
);
create index if not exists article_take_revisions_idx on public.article_take_revisions (article_id, id desc);
create or replace function public.article_take_revisions_guard() returns trigger
language plpgsql as $$ begin raise exception 'article_take_revisions is append-only'; end $$;
drop trigger if exists article_take_revisions_guard_t on public.article_take_revisions;
create trigger article_take_revisions_guard_t before update or delete on public.article_take_revisions
  for each row execute function public.article_take_revisions_guard();

-- --------------------------------------------------- THE PUBLISH GATE
-- Whoever the caller is. A desk article becomes (or is re-) published only
-- with a take of the minimum length and a draft that passed its own checks.
-- The take is copied onto the row at that moment, so the published page and
-- the take that was required for it can never drift apart.
create or replace function public.desk_articles_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_take text; v_min int := public.desk_min_take(); d public.article_drafts;
begin
  new.updated_at := now();
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published'
       or new.published_draft_id is distinct from old.published_draft_id) then
    select take into v_take from public.article_takes where article_id = new.article_key;
    if public.desk_take_len(v_take) < v_min then
      raise exception 'my_take_required: % needs "My take" of at least % characters before it can publish (it has %)',
        new.article_key, v_min, public.desk_take_len(v_take) using errcode = 'check_violation';
    end if;
    if new.published_draft_id is null then
      raise exception 'desk: % has no draft to publish', new.article_key using errcode = 'check_violation';
    end if;
    select * into d from public.article_drafts where id = new.published_draft_id;
    if d.id is null or d.article_key <> new.article_key then
      raise exception 'desk: draft % does not belong to %', new.published_draft_id, new.article_key using errcode = 'check_violation';
    end if;
    if coalesce(d.data_snapshot #>> '{checks,verify,ok}', 'false') <> 'true'
       or coalesce(d.data_snapshot #>> '{checks,voice,ok}', 'false') <> 'true' then
      raise exception 'desk: draft % failed its own source or voice checks and cannot publish', d.id using errcode = 'check_violation';
    end if;
    new.published_take := v_take;
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end $$;
drop trigger if exists desk_articles_gate_t on public.desk_articles;
create trigger desk_articles_gate_t before insert or update on public.desk_articles
  for each row execute function public.desk_articles_gate();

-- The same rule for a FIRST publication of a game article from a browser
-- (the article manager and the terminal's "Publish as article" button write
-- site_articles). An article published before this file has a published_at
-- and is never touched. The editorial pipeline publishes from the repository
-- and is held to the rule in tools/editorial/publisher.js.
create or replace function public.site_articles_take_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_take text; v_min int := public.desk_min_take(); v_on boolean;
begin
  select require_take_for_game_articles into v_on from public.desk_settings where id = 1;
  if coalesce(v_on, true) and new.status = 'published' and new.published_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    select take into v_take from public.article_takes where article_id = new.id;
    if greatest(public.desk_take_len(v_take), public.desk_take_len(new.article ->> 'my_take')) < v_min then
      raise exception 'my_take_required: % needs "My take" of at least % characters before it can publish', new.id, v_min
        using errcode = 'check_violation';
    end if;
    if public.desk_take_len(new.article ->> 'my_take') < v_min then
      new.article := jsonb_set(new.article, '{my_take}', to_jsonb(v_take));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists site_articles_take_gate_t on public.site_articles;
create trigger site_articles_take_gate_t before insert or update on public.site_articles
  for each row execute function public.site_articles_take_gate();

-- ------------------------------------------------------- notifications
create table if not exists public.desk_notifications (
  id          bigint generated always as identity primary key,
  draft_ids   bigint[] not null,
  channel     text not null,
  ok          boolean not null,
  error       text,
  created_at  timestamptz not null default now()
);
-- no secret ever reaches this table
alter table public.desk_notifications drop constraint if exists desk_notifications_no_secret_ck;
alter table public.desk_notifications add constraint desk_notifications_no_secret_ck
  check (coalesce(error, '') !~* 'discord(app)?\.com/api/webhooks|bot [a-z0-9._-]{20,}');

-- ------------------------------------------------------------------ RLS
alter table public.desk_settings enable row level security;
alter table public.article_drafts enable row level security;
alter table public.desk_articles enable row level security;
alter table public.article_takes enable row level security;
alter table public.article_take_revisions enable row level security;
alter table public.desk_notifications enable row level security;
-- No client policies at all: every read and write goes through a door below.
revoke all on public.desk_settings, public.article_drafts, public.desk_articles, public.article_takes,
  public.article_take_revisions, public.desk_notifications from anon, authenticated;

create or replace function public.desk_is_owner() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select public.site_article_is_admin(); $$;
revoke all on function public.desk_is_owner() from public;
grant execute on function public.desk_is_owner() to authenticated;

create or replace function public.desk_require_owner() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.site_article_is_admin() then
    raise exception 'desk: owner only' using errcode = 'insufficient_privilege';
  end if;
end $$;
revoke all on function public.desk_require_owner() from public, anon;

-- ----------------------------------------------- the generator's door
-- Service role only. Appends the draft (or reports it unchanged), and points
-- the article at it. A published article keeps its published draft: the new
-- one waits as "newer data available" until the owner republishes.
create or replace function public.desk_draft_put(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint; v_key text := p ->> 'article_key'; a public.desk_articles; v_take int; v_status text;
begin
  if v_key is null or p ->> 'slug' is null or p ->> 'generated_body' is null or p ->> 'body_hash' is null
     or jsonb_typeof(p -> 'data_snapshot') <> 'object' then
    raise exception 'desk_draft_put: article_key, slug, generated_body, body_hash and data_snapshot are required';
  end if;
  if exists (select 1 from public.site_articles s where s.slug = p ->> 'slug') then
    raise exception 'desk_draft_put: slug % already belongs to a game article', p ->> 'slug';
  end if;
  if exists (select 1 from public.desk_articles x where x.slug = p ->> 'slug' and x.article_key <> v_key) then
    raise exception 'desk_draft_put: slug % already belongs to another desk article', p ->> 'slug';
  end if;
  select id into v_id from public.article_drafts where article_key = v_key and body_hash = p ->> 'body_hash';
  if v_id is not null then
    return jsonb_build_object('stored', false, 'reason', 'unchanged', 'draft_id', v_id, 'article_key', v_key);
  end if;
  insert into public.article_drafts (article_key, type, sport, season, week, period, slug, title, description, lead, highlights,
      reddit_title, record_link, generated_body, body_hash, data_snapshot, data_as_of, generator_version, source_commit, generated_at)
  values (v_key, p ->> 'type', p ->> 'sport', (p ->> 'season')::int, (p ->> 'week')::int, p ->> 'period', p ->> 'slug', p ->> 'title',
      p ->> 'description', p ->> 'lead', coalesce(p -> 'highlights', '[]'::jsonb), p ->> 'reddit_title', p ->> 'record_link',
      p ->> 'generated_body', p ->> 'body_hash', p -> 'data_snapshot', (p ->> 'data_as_of')::timestamptz,
      coalesce(p ->> 'generator_version', 'unknown'), p ->> 'source_commit', coalesce((p ->> 'generated_at')::timestamptz, now()))
  returning id into v_id;

  select * into a from public.desk_articles where article_key = v_key for update;
  select public.desk_take_len(take) into v_take from public.article_takes where article_id = v_key;
  v_status := case when coalesce(v_take, 0) >= public.desk_min_take() then 'ready' else 'awaiting_take' end;
  if a.article_key is null then
    insert into public.desk_articles (article_key, type, sport, season, week, period, slug, current_draft_id, status)
    values (v_key, p ->> 'type', p ->> 'sport', (p ->> 'season')::int, (p ->> 'week')::int, p ->> 'period', p ->> 'slug', v_id, v_status);
  else
    update public.article_drafts set status = 'superseded'
     where id = a.current_draft_id and status = 'draft';
    update public.desk_articles set current_draft_id = v_id,
           status = case when a.status in ('published', 'archived') then a.status else v_status end
     where article_key = v_key;
  end if;
  return jsonb_build_object('stored', true, 'draft_id', v_id, 'article_key', v_key,
    'status', (select status from public.desk_articles where article_key = v_key));
end $$;
revoke all on function public.desk_draft_put(jsonb) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.desk_draft_put(jsonb) to service_role';
  end if;
end $g$;

-- --------------------------------------------------------- owner doors
create or replace function public.desk_queue() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_min int := public.desk_min_take();
begin
  perform public.desk_require_owner();
  return jsonb_build_object(
    'min_take_chars', v_min,
    'settings', (select to_jsonb(s) - 'id' from public.desk_settings s where id = 1),
    'articles', coalesce((select jsonb_agg(x order by x ->> 'sort_at' desc) from (
      select jsonb_build_object(
        'article_key', a.article_key, 'type', a.type, 'sport', a.sport, 'season', a.season, 'week', a.week, 'period', a.period,
        'slug', a.slug, 'status', a.status, 'published_at', a.published_at, 'updated_at', a.updated_at,
        'current_draft_id', a.current_draft_id, 'published_draft_id', a.published_draft_id,
        'newer_draft', a.status = 'published' and a.current_draft_id is distinct from a.published_draft_id,
        'title', d.title, 'lead', d.lead, 'generated_at', d.generated_at, 'data_as_of', d.data_as_of,
        'checks_ok', coalesce(d.data_snapshot #>> '{checks,verify,ok}', 'false') = 'true' and coalesce(d.data_snapshot #>> '{checks,voice,ok}', 'false') = 'true',
        'numbers', jsonb_array_length(d.data_snapshot -> 'numbers'),
        'take_chars', public.desk_take_len(t.take), 'take_ok', public.desk_take_len(t.take) >= v_min,
        'drafts', (select count(*) from public.article_drafts z where z.article_key = a.article_key),
        'sort_at', coalesce(d.generated_at, a.updated_at)) as x
        from public.desk_articles a
        left join public.article_drafts d on d.id = a.current_draft_id
        left join public.article_takes t on t.article_id = a.article_key) q), '[]'::jsonb),
    'counts', jsonb_build_object(
      'awaiting_take', (select count(*) from public.desk_articles where status = 'awaiting_take'),
      'ready', (select count(*) from public.desk_articles where status = 'ready'),
      'published', (select count(*) from public.desk_articles where status = 'published'),
      'newer_drafts', (select count(*) from public.desk_articles where status = 'published' and current_draft_id is distinct from published_draft_id)));
end $$;
revoke all on function public.desk_queue() from public, anon;
grant execute on function public.desk_queue() to authenticated;

-- One article in full: the current draft with its whole snapshot (every
-- number and its query), the published draft when it differs, and the take.
create or replace function public.desk_article(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.desk_articles; r jsonb;
begin
  perform public.desk_require_owner();
  select * into a from public.desk_articles where article_key = p_key;
  if a.article_key is null then raise exception 'desk: no article %', p_key using errcode = 'no_data_found'; end if;
  select jsonb_build_object(
    'article', to_jsonb(a),
    'draft', (select to_jsonb(d) from public.article_drafts d where d.id = a.current_draft_id),
    'published_draft', case when a.published_draft_id is distinct from a.current_draft_id
      then (select to_jsonb(d) from public.article_drafts d where d.id = a.published_draft_id) end,
    'take', (select to_jsonb(t) from public.article_takes t where t.article_id = p_key),
    'take_revisions', (select count(*) from public.article_take_revisions r where r.article_id = p_key),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'status', d.status, 'generated_at', d.generated_at,
                 'body_hash', d.body_hash, 'source_commit', d.source_commit) order by d.id desc)
               from public.article_drafts d where d.article_key = p_key), '[]'::jsonb),
    'min_take_chars', public.desk_min_take()) into r;
  return r;
end $$;
revoke all on function public.desk_article(text) from public, anon;
grant execute on function public.desk_article(text) to authenticated;

create or replace function public.article_take_save(p_article_id text, p_kind text, p_take text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_len int := public.desk_take_len(p_take); v_min int := public.desk_min_take();
begin
  perform public.desk_require_owner();
  if p_kind not in ('desk', 'game') then raise exception 'article_take_save: kind must be desk or game'; end if;
  if p_kind = 'desk' and not exists (select 1 from public.desk_articles where article_key = p_article_id) then
    raise exception 'article_take_save: no desk article %', p_article_id;
  end if;
  insert into public.article_takes (article_id, kind, take, updated_at, updated_by)
  values (p_article_id, p_kind, coalesce(p_take, ''), now(), auth.uid())
  on conflict (article_id) do update set take = excluded.take, kind = excluded.kind, updated_at = now(), updated_by = auth.uid();
  insert into public.article_take_revisions (article_id, kind, take, saved_by) values (p_article_id, p_kind, coalesce(p_take, ''), auth.uid());
  if p_kind = 'desk' then
    update public.desk_articles set status = case when v_len >= v_min then 'ready' else 'awaiting_take' end
     where article_key = p_article_id and status in ('awaiting_take', 'ready');
  end if;
  return jsonb_build_object('saved', true, 'chars', v_len, 'min', v_min, 'ok', v_len >= v_min);
end $$;
revoke all on function public.article_take_save(text, text, text) from public, anon;
grant execute on function public.article_take_save(text, text, text) to authenticated;

-- PUBLISH. The trigger above is the gate; this is the button.
create or replace function public.desk_publish(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.desk_articles;
begin
  perform public.desk_require_owner();
  select * into a from public.desk_articles where article_key = p_key for update;
  if a.article_key is null then raise exception 'desk: no article %', p_key using errcode = 'no_data_found'; end if;
  if a.status = 'archived' then raise exception 'desk: % is archived', p_key using errcode = 'check_violation'; end if;
  update public.desk_articles set status = 'published', published_draft_id = a.current_draft_id, published_by = auth.uid()
   where article_key = p_key;
  update public.article_drafts set status = 'published' where id = a.current_draft_id and status = 'draft';
  return (select jsonb_build_object('published', true, 'article_key', article_key, 'slug', slug, 'published_at', published_at,
    'draft_id', published_draft_id) from public.desk_articles where article_key = p_key);
end $$;
revoke all on function public.desk_publish(text) from public, anon;
grant execute on function public.desk_publish(text) to authenticated;

-- Withdraw: the page is removed on the next build; nothing is deleted.
create or replace function public.desk_withdraw(p_key text, p_archive boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_take int;
begin
  perform public.desk_require_owner();
  select public.desk_take_len(take) into v_take from public.article_takes where article_id = p_key;
  update public.desk_articles
     set status = case when p_archive then 'archived' when coalesce(v_take, 0) >= public.desk_min_take() then 'ready' else 'awaiting_take' end
   where article_key = p_key;
  if not found then raise exception 'desk: no article %', p_key using errcode = 'no_data_found'; end if;
  return jsonb_build_object('withdrawn', true, 'article_key', p_key, 'archived', p_archive);
end $$;
revoke all on function public.desk_withdraw(text, boolean) from public, anon;
grant execute on function public.desk_withdraw(text, boolean) to authenticated;

create or replace function public.desk_settings_save(p_min_take_chars int, p_notify boolean, p_require_game boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.desk_require_owner();
  update public.desk_settings set min_take_chars = coalesce(p_min_take_chars, min_take_chars),
    notify_enabled = coalesce(p_notify, notify_enabled), require_take_for_game_articles = coalesce(p_require_game, require_take_for_game_articles),
    updated_at = now(), updated_by = auth.uid() where id = 1;
  return (select to_jsonb(s) - 'id' from public.desk_settings s where id = 1);
end $$;
revoke all on function public.desk_settings_save(int, boolean, boolean) from public, anon;
grant execute on function public.desk_settings_save(int, boolean, boolean) to authenticated;

-- The dashboard badge: how many things are waiting on the owner.
create or replace function public.desk_pending_count() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.site_article_is_admin() then return jsonb_build_object('owner', false); end if;
  return jsonb_build_object('owner', true,
    'awaiting_take', (select count(*) from public.desk_articles where status = 'awaiting_take'),
    'ready', (select count(*) from public.desk_articles where status = 'ready'),
    'newer_drafts', (select count(*) from public.desk_articles where status = 'published' and current_draft_id is distinct from published_draft_id));
end $$;
revoke all on function public.desk_pending_count() from public, anon;
grant execute on function public.desk_pending_count() to authenticated;

-- Game-article takes, owner side: which game articles have a take.
create or replace function public.article_takes_owner(p_kind text default 'game') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.desk_require_owner();
  return coalesce((select jsonb_agg(jsonb_build_object('article_id', article_id, 'take', take, 'chars', public.desk_take_len(take),
    'ok', public.desk_take_len(take) >= public.desk_min_take(), 'updated_at', updated_at) order by updated_at desc)
    from public.article_takes where kind = p_kind), '[]'::jsonb);
end $$;
revoke all on function public.article_takes_owner(text) from public, anon;
grant execute on function public.article_takes_owner(text) to authenticated;

-- ------------------------------------------------------ service doors
-- The editorial pipeline merges takes into a game record before it decides
-- whether the record may publish.
create or replace function public.article_takes_for_pipeline() returns table (article_id text, take text, updated_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select article_id, take, updated_at from public.article_takes where kind = 'game';
$$;
revoke all on function public.article_takes_for_pipeline() from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.article_takes_for_pipeline() to service_role';
  end if;
end $g$;

-- CLAIM BEFORE SEND. Returns the drafts that have not been announced and
-- stamps them, in one statement, so two ticks can never announce one draft
-- twice. A failed send is released for at most three attempts.
create or replace function public.desk_notify_claim(p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not coalesce((select notify_enabled from public.desk_settings where id = 1), true) then
    return jsonb_build_object('enabled', false, 'drafts', '[]'::jsonb);
  end if;
  with picked as (
    select d.id from public.article_drafts d
      join public.desk_articles a on a.current_draft_id = d.id
     where d.notified_at is null and d.notify_attempts < 3 and a.status in ('awaiting_take', 'ready', 'published')
     order by d.id limit greatest(1, least(coalesce(p_limit, 20), 50))
     for update of d skip locked),
  upd as (
    update public.article_drafts d set notified_at = now(), notify_attempts = d.notify_attempts + 1
      from picked where d.id = picked.id
    returning d.id, d.article_key, d.type, d.title, d.lead, d.generated_at)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'article_key', u.article_key, 'type', u.type, 'title', u.title,
      'lead', u.lead, 'status', a.status) order by u.id), '[]'::jsonb)
    into r from upd u join public.desk_articles a on a.article_key = u.article_key;
  return jsonb_build_object('enabled', true, 'drafts', r);
end $$;
create or replace function public.desk_notify_done(p_ids bigint[], p_channel text, p_ok boolean, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.desk_notifications (draft_ids, channel, ok, error) values (coalesce(p_ids, '{}'), coalesce(p_channel, 'none'), coalesce(p_ok, false), left(p_error, 500));
  if not coalesce(p_ok, false) then
    update public.article_drafts set notified_at = null where id = any (p_ids) and notify_attempts < 3;
  end if;
  return jsonb_build_object('logged', true);
end $$;
revoke all on function public.desk_notify_claim(int) from public, anon, authenticated;
revoke all on function public.desk_notify_done(bigint[], text, boolean, text) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.desk_notify_claim(int) to service_role';
    execute 'grant execute on function public.desk_notify_done(bigint[], text, boolean, text) to service_role';
  end if;
end $g$;

-- ---------------------------------------------------------- public read
-- What the keyless static build (tools/desk/sync.js) reads: published
-- articles only, each with the draft that was published, its snapshot and
-- the take that was required for it. A draft is not merely hidden here, it is
-- not selectable.
create or replace view public.desk_published as
  select a.article_key, a.type, a.sport, a.season, a.week, a.period, a.slug,
         d.id as draft_id, d.title, d.description, d.lead, d.highlights, d.reddit_title, d.record_link,
         d.generated_body, d.data_snapshot, d.data_as_of, d.generated_at, d.source_commit, d.generator_version,
         a.published_take as my_take, a.published_at, a.updated_at
    from public.desk_articles a
    join public.article_drafts d on d.id = a.published_draft_id
   where a.status = 'published';
grant select on public.desk_published to anon, authenticated;

-- The take of a game article, once that article is published through
-- site_articles, for the keyless sync (tools/articles/sync.js).
create or replace function public.article_takes_published(p_ids text[]) returns table (article_id text, take text)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.article_id, t.take from public.article_takes t
   where t.kind = 'game' and t.article_id = any (p_ids)
     and exists (select 1 from public.site_articles s where s.id = t.article_id and s.status = 'published');
$$;
revoke all on function public.article_takes_published(text[]) from public;
grant execute on function public.article_takes_published(text[]) to anon, authenticated;

-- ------------------------------------------------ ARTICLE PERFORMANCE
-- Every published article, ranked by what it led to, not by what it was
-- read. p_articles is the list the owner's page already holds (slug, type,
-- title, published_at from /articles/data/published.json); desk articles and
-- any article that was read in the window are added to it.
--
-- Three ways a conversion is credited, shown apart and never added up:
--   touched      the reader's browser read the article before they started
--                the trial / paid (multi-touch: user_event_links)
--   first_touch  the article was the first page they ever landed on
--   last_touch   it was the last page they landed on from outside
-- Channels come from the article view's own utm_source and referrer, so a
-- Discord or Reddit link is counted as Discord or Reddit here even though the
-- older acquisition classifier calls them "other".
create or replace function public.desk_channel(p_utm_source text, p_utm_medium text, p_referrer text) returns text
language sql immutable as $$
  select case
    when lower(coalesce(p_utm_source, '')) in ('x', 'twitter', 't.co') then 'x'
    when lower(coalesce(p_utm_source, '')) in ('linkedin', 'lnkd') then 'linkedin'
    when lower(coalesce(p_utm_source, '')) = 'discord' then 'discord'
    when lower(coalesce(p_utm_source, '')) = 'reddit' then 'reddit'
    when lower(coalesce(p_utm_source, '')) in ('newsletter', 'edgedesk_newsletter') or lower(coalesce(p_utm_medium, '')) = 'newsletter' then 'newsletter'
    when lower(coalesce(p_utm_source, '')) in ('outbound', 'edgedesk_outbound') then 'outbound_email'
    when coalesce(p_utm_source, '') <> '' then 'other'
    when coalesce(p_referrer, '') = '' then 'direct'
    when lower(p_referrer) ~ '(^|\.)edgedesksports\.com$' then 'internal'
    when lower(p_referrer) in ('t.co', 'x.com', 'twitter.com') then 'x'
    when lower(p_referrer) ~ '(^|\.)linkedin\.com$' or lower(p_referrer) = 'lnkd.in' then 'linkedin'
    when lower(p_referrer) ~ '(^|\.)reddit\.com$' or lower(p_referrer) = 'redd.it' then 'reddit'
    when lower(p_referrer) ~ '(^|\.)discord(app)?\.com$' then 'discord'
    when lower(p_referrer) ~ '(^|\.)(google|bing|duckduckgo|yahoo|ecosia|yandex|baidu)\.' or lower(p_referrer) in ('kagi.com', 'search.brave.com') then 'search'
    else 'referral' end;
$$;

create or replace function public.desk_article_performance(p_days int default 30, p_articles jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d int := greatest(7, least(coalesce(p_days, 30), 365)); f timestamptz;
  has_ev boolean := to_regclass('public.user_events') is not null;
  has_links boolean := to_regclass('public.user_event_links') is not null;
  has_acq boolean := to_regclass('public.user_acquisition') is not null;
  has_bill boolean := to_regprocedure('public.growth_customer_facts()') is not null and to_regclass('public.stripe_events') is not null;
  has_ref boolean := exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'referral_code');
  rows jsonb; bytype jsonb; tot jsonb;
begin
  perform public.desk_require_owner();
  f := now() - make_interval(days => d);
  /* the measurement tables are other files' (funnel.sql, growth.sql); without
     them there is nothing to count, and saying so beats a relation error */
  if not (has_ev and has_links and has_acq) then
    return jsonb_build_object('window', jsonb_build_object('days', d, 'from', f, 'to', now()),
      'measured', jsonb_build_object('events', has_ev, 'linked_sessions', has_links, 'acquisition', has_acq, 'billing', has_bill, 'referral_codes', has_ref),
      'articles', '[]'::jsonb, 'by_type', '[]'::jsonb, 'totals', '{}'::jsonb,
      'note', 'Article Performance needs supabase/funnel.sql and supabase/growth.sql applied; nothing is measured until they are.');
  end if;

  create temp table if not exists desk_perf_articles (slug text primary key, type text, title text, published_at timestamptz) on commit drop;
  create temp table if not exists desk_perf_views (slug text, created_at timestamptz, anon text, user_id uuid, channel text) on commit drop;
  create temp table if not exists desk_perf_people (user_id uuid primary key) on commit drop;
  create temp table if not exists desk_perf_touch (slug text, user_id uuid, first_view timestamptz, primary key (slug, user_id)) on commit drop;
  create temp table if not exists desk_perf_conv (user_id uuid primary key, trial_at timestamptz, paid_at timestamptz, referral_code text) on commit drop;
  truncate desk_perf_articles, desk_perf_views, desk_perf_people, desk_perf_touch, desk_perf_conv;

  insert into desk_perf_articles
  select x ->> 'slug', coalesce(x ->> 'type', 'article'), x ->> 'title', (x ->> 'published_at')::timestamptz
    from jsonb_array_elements(coalesce(p_articles, '[]'::jsonb)) x where coalesce(x ->> 'slug', '') <> ''
  on conflict (slug) do nothing;
  insert into desk_perf_articles
  select a.slug, a.type, d.title, a.published_at from public.desk_articles a
    left join public.article_drafts d on d.id = a.published_draft_id where a.status = 'published'
  on conflict (slug) do update set type = excluded.type, title = coalesce(excluded.title, desk_perf_articles.title),
    published_at = coalesce(desk_perf_articles.published_at, excluded.published_at);

  -- owners never count
  insert into desk_perf_people select user_id from public.site_article_admins on conflict do nothing;
  if to_regclass('growth_outbound.owners') is not null then
    execute 'insert into desk_perf_people select user_id from growth_outbound.owners on conflict do nothing';
  end if;

  if has_ev then
    insert into desk_perf_views
    select substr(e.event_properties ->> 'entity', 9), e.created_at, e.anonymous_session_id, e.user_id,
           public.desk_channel(e.utm_source, e.utm_medium, e.referrer)
      from public.user_events e
     where e.event_name = 'public_page_view' and e.created_at >= f
       and e.event_properties ->> 'entity' like 'article:%'
       and (e.user_id is null or e.user_id not in (select user_id from desk_perf_people));
    insert into desk_perf_articles
    select distinct v.slug, case when v.slug like '%-postgame-analysis' then 'postgame' else 'pregame' end, null::text, null::timestamptz
      from desk_perf_views v where v.slug <> ''
    on conflict (slug) do nothing;

    -- who read what, first time: a signed-in view, or an anonymous view later linked to the account
    insert into desk_perf_touch
    select slug, uid, min(created_at) from (
      select v.slug, v.user_id as uid, v.created_at from desk_perf_views v where v.user_id is not null
      union all
      select v.slug, l.user_id, v.created_at from desk_perf_views v
        join public.user_event_links l on l.anonymous_session_id = v.anon
       where v.anon is not null) t
     where uid is not null and uid not in (select user_id from desk_perf_people)
     group by slug, uid
    on conflict do nothing;
  end if;

  if has_bill then
    insert into desk_perf_conv (user_id, trial_at, paid_at)
    select c.user_id, c.trial_started_at, c.paid_at from public.growth_customer_facts() c
     where c.user_id not in (select user_id from desk_perf_people)
       and (c.trial_started_at >= f or c.paid_at >= f)
    on conflict do nothing;
    if has_ref then
      execute 'update desk_perf_conv c set referral_code = s.referral_code from public.subscriptions s where s.user_id = c.user_id';
    end if;
  end if;

  select coalesce(jsonb_agg(r order by (r ->> 'paid_touched')::int desc, (r ->> 'trials_touched')::int desc, (r ->> 'views')::int desc, r ->> 'slug'), '[]'::jsonb)
    into rows from (
    select jsonb_build_object(
      'slug', a.slug, 'type', a.type, 'title', a.title, 'published_at', a.published_at,
      'views', (select count(*) from desk_perf_views v where v.slug = left(a.slug, 70)),
      'visitors', (select count(distinct v.anon) from desk_perf_views v where v.slug = left(a.slug, 70)),
      'engaged', case when has_ev then (select count(*) from public.user_events e where e.event_name = 'article_engaged' and e.created_at >= f
                   and e.event_properties ->> 'entity' = 'article:' || left(a.slug, 70)) end,
      'cta_clicks', case when has_ev then (select count(*) from public.user_events e where e.event_name = 'public_cta_clicked' and e.created_at >= f
                   and e.event_properties ->> 'page' = 'article:' || left(a.slug, 70)) end,
      'channels', coalesce((select jsonb_object_agg(channel, n) from (select v.channel, count(*) n from desk_perf_views v where v.slug = left(a.slug, 70) group by v.channel) ch), '{}'::jsonb),
      'trials_touched', (select count(*) from desk_perf_touch t join desk_perf_conv c on c.user_id = t.user_id
                          where t.slug = left(a.slug, 70) and c.trial_at is not null and c.trial_at >= t.first_view),
      'paid_touched', (select count(*) from desk_perf_touch t join desk_perf_conv c on c.user_id = t.user_id
                        where t.slug = left(a.slug, 70) and c.paid_at is not null and c.paid_at >= t.first_view),
      'paid_with_referral_code', (select count(*) from desk_perf_touch t join desk_perf_conv c on c.user_id = t.user_id
                        where t.slug = left(a.slug, 70) and c.paid_at is not null and c.paid_at >= t.first_view and c.referral_code is not null),
      'trials_first_touch', case when has_acq then (select count(*) from public.user_acquisition ua join desk_perf_conv c on c.user_id = ua.user_id
                        where coalesce(ua.first_landing, '') ~ ('^/articles/' || a.slug || '/?$') and c.trial_at is not null) end,
      'paid_first_touch', case when has_acq then (select count(*) from public.user_acquisition ua join desk_perf_conv c on c.user_id = ua.user_id
                        where coalesce(ua.first_landing, '') ~ ('^/articles/' || a.slug || '/?$') and c.paid_at is not null) end,
      'paid_last_touch', case when has_acq then (select count(*) from public.user_acquisition ua join desk_perf_conv c on c.user_id = ua.user_id
                        where coalesce(ua.last_landing, '') ~ ('^/articles/' || a.slug || '/?$') and c.paid_at is not null) end
    ) r from desk_perf_articles a) x;

  select coalesce(jsonb_agg(t order by (t ->> 'paid_touched')::int desc, (t ->> 'views')::int desc), '[]'::jsonb) into bytype from (
    select jsonb_build_object('type', r ->> 'type', 'articles', count(*),
      'views', sum((r ->> 'views')::int), 'trials_touched', sum((r ->> 'trials_touched')::int), 'paid_touched', sum((r ->> 'paid_touched')::int),
      'paid_per_1k_views', case when sum((r ->> 'views')::int) > 0 then round(1000.0 * sum((r ->> 'paid_touched')::int) / sum((r ->> 'views')::int), 2) end,
      'trials_per_1k_views', case when sum((r ->> 'views')::int) > 0 then round(1000.0 * sum((r ->> 'trials_touched')::int) / sum((r ->> 'views')::int), 2) end) t
      from jsonb_array_elements(rows) r group by r ->> 'type') y;

  select jsonb_build_object('articles', jsonb_array_length(rows),
    'views', (select count(*) from desk_perf_views),
    'channels', coalesce((select jsonb_object_agg(channel, n) from (select channel, count(*) n from desk_perf_views group by channel) c), '{}'::jsonb),
    'trials_touched_people', (select count(distinct t.user_id) from desk_perf_touch t join desk_perf_conv c on c.user_id = t.user_id where c.trial_at >= t.first_view),
    'paid_touched_people', (select count(distinct t.user_id) from desk_perf_touch t join desk_perf_conv c on c.user_id = t.user_id where c.paid_at >= t.first_view)) into tot;

  return jsonb_build_object('window', jsonb_build_object('days', d, 'from', f, 'to', now()),
    'measured', jsonb_build_object('events', has_ev, 'linked_sessions', has_links, 'acquisition', has_acq, 'billing', has_bill, 'referral_codes', has_ref),
    'articles', rows, 'by_type', bytype, 'totals', tot,
    'note', 'Counts only, owners excluded. "Touched" credits every article a converting reader read before converting, so one person can count for several articles: never add the column up. First and last touch credit one landing page each. Channels are read from each view''s own utm_source and referrer.');
end $$;
revoke all on function public.desk_article_performance(int, jsonb) from public, anon;
grant execute on function public.desk_article_performance(int, jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';

-- Report: every row should say ok.
select n, check_name, case when passed then 'ok' else 'CHECK THIS' end as status from (
  select 1 as n, 'tables exist' as check_name,
    to_regclass('public.article_drafts') is not null and to_regclass('public.desk_articles') is not null
    and to_regclass('public.article_takes') is not null and to_regclass('public.article_take_revisions') is not null
    and to_regclass('public.desk_settings') is not null and to_regclass('public.desk_notifications') is not null as passed
  union all select 2, 'RLS on every desk table',
    (select bool_and(relrowsecurity) from pg_class where oid in ('public.article_drafts'::regclass, 'public.desk_articles'::regclass,
      'public.article_takes'::regclass, 'public.article_take_revisions'::regclass, 'public.desk_settings'::regclass, 'public.desk_notifications'::regclass))
  union all select 3, 'no client policy on any desk table',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename in
      ('article_drafts', 'desk_articles', 'article_takes', 'article_take_revisions', 'desk_settings', 'desk_notifications'))
  union all select 4, 'article_drafts is append-only (update/delete/truncate guards)',
    exists (select 1 from pg_trigger where tgname = 'article_drafts_guard_t') and exists (select 1 from pg_trigger where tgname = 'article_drafts_no_truncate_t')
  union all select 5, 'the publish gate is a trigger on desk_articles',
    exists (select 1 from pg_trigger where tgname = 'desk_articles_gate_t')
  union all select 6, 'a first publication of a game article needs a take',
    exists (select 1 from pg_trigger where tgname = 'site_articles_take_gate_t')
  union all select 7, 'the generator door is service-role only',
    not has_function_privilege('anon', 'public.desk_draft_put(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.desk_draft_put(jsonb)', 'execute')
  union all select 8, 'anon can read published desk articles and nothing else',
    has_table_privilege('anon', 'public.desk_published', 'select')
    and not has_table_privilege('anon', 'public.article_drafts', 'select')
  union all select 9, 'minimum take length is set',
    (select min_take_chars from public.desk_settings where id = 1) >= 1
) checks order by n;

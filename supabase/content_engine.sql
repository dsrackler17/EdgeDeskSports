-- =============================================================================
-- content_engine — the OWNER-ONLY Sports Media Content Engine's database.
--
-- WHAT IT HOLDS
--   publishers      editorial profiles of media partners (Stadium Rant first),
--                   their contacts, partnership terms and distribution method
--   benchmarks      user- or publisher-REPORTED reference figures (never live
--                   analytics), append-only
--   opportunities   scored article opportunities, each with the frozen
--                   research packet it was scored on and its sources (every
--                   source carries a URL and a timestamp — a constraint says so)
--   articles        drafts and their workflow:
--                     draft → in_review → approved → ready_to_send → sent →
--                     published → archived
--   revisions       every saved version, append-only
--   deliveries      the record of what the OWNER sent, by hand, to whom (by
--                   method), at which content hash — append-only
--   performance     publisher-reported or owner-observed numbers, append-only,
--                   kept apart from first-party measurement
--   events          the activity and failure log, append-only
--   runs, usage     scheduled-job leases (idempotency) and the daily AI/fetch
--                   budget
--
-- THE RULES, ENFORCED HERE (triggers no code path can skip)
--   · Software may discover, score, draft, check and queue. It may NOT approve,
--     send or publish. An article becomes `approved` only inside the approve
--     door, by an OWNER, for the exact content hash they reviewed, with every
--     automated check passed and the five-point editorial review complete.
--   · Editing approved content puts it back in review. Sent or published
--     content is frozen.
--   · `sent` exists only with a delivery row the owner recorded; nothing here
--     (or anywhere in the engine) emails a publisher.
--   · Nothing is deleted. Publishers end, opportunities are dismissed, articles
--     are archived; logs, revisions, deliveries, benchmarks and performance
--     reports are append-only.
--
-- WHO MAY SEE ANY OF IT
--   The tables live in the schema content_engine, which PostgREST does not
--   serve and no client role can use. The only way in is a public
--   content_engine_* security-definer door. Owner doors check, first,
--   growth_outbound.owner_active(auth.uid()) — the SAME owner list as the
--   outbound engine (growth_outbound.owners ∩ affiliate_admins). An affiliate
--   admin, a subscriber and the anon key get nothing.
--   The weekly job (GitHub Actions, service role) reaches only the job doors:
--   discover, draft, check, submit for review, spend budget, log. It can never
--   approve, mark sent or publish: those doors require an owner's auth.uid().
--
-- PRIVACY. First-party conversion reporting returns COUNTS joined on an
-- article's campaign code (utm_campaign). No user id, email or visitor hash
-- leaves the database; owners' own accounts are excluded.
--
-- BOOTSTRAP. Owners are the outbound owners. If you are not one yet, in the
-- SQL editor:  select growth_outbound.grant_owner('you@example.com');
--
-- RUN ORDER: affiliates.sql, growth.sql, growth_outbound.sql, then this file
-- (the guard says so). funnel.sql and growth_engine.sql are optional: without
-- them the matching first-party figures read "not measured".
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regprocedure('growth_outbound.owner_active(uuid)') is null then
    raise exception 'Run supabase/growth_outbound.sql first: the Content Engine is owner-only and uses its owner list.';
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'auth.uid() is missing: this file must run on a Supabase project.';
  end if;
end
$guard$;

create schema if not exists content_engine;
comment on schema content_engine is
  'Owner-only Sports Media Content Engine. NOT served by PostgREST: every read and write goes through a public.content_engine_* door.';
revoke all on schema content_engine from public;
do $r$ begin
  execute 'revoke all on schema content_engine from anon, authenticated, service_role';
exception when undefined_object then null; end $r$;

-- =============================================================================
-- 1. TABLES
-- =============================================================================

create table if not exists content_engine.settings (
  id                 smallint primary key default 1 check (id = 1),
  drafts_per_run     int not null default 2 check (drafts_per_run between 0 and 10),
  llm_calls_per_day  int not null default 20 check (llm_calls_per_day between 0 and 200),
  fetch_calls_per_day int not null default 60 check (fetch_calls_per_day between 0 and 500),
  min_priority       int not null default 60 check (min_priority between 0 and 100),
  schedule_enabled   boolean not null default true,
  default_publisher  text,
  landing_url        text not null default 'https://edgedesksports.com/today/'
                       check (landing_url ~ '^https://(www\.)?edgedesksports\.com/'),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
insert into content_engine.settings (id) values (1) on conflict (id) do nothing;

create table if not exists content_engine.publishers (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  name          text not null check (length(btrim(name)) between 2 and 120),
  website       text check (website is null or website ~ '^https://'),
  status        text not null default 'active' check (status in ('prospect', 'active', 'paused', 'ended')),
  utm_source    text not null check (utm_source ~ '^[a-z0-9_.-]{2,40}$'),
  editorial     jsonb not null default '{}'::jsonb check (jsonb_typeof(editorial) = 'object'),
  contacts      jsonb not null default '[]'::jsonb check (jsonb_typeof(contacts) = 'array'),
  partnership   jsonb not null default '{}'::jsonb check (jsonb_typeof(partnership) = 'object'),
  distribution  jsonb not null default '{}'::jsonb check (jsonb_typeof(distribution) = 'object'),
  approval      jsonb not null default '{}'::jsonb check (jsonb_typeof(approval) = 'object'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists content_engine.benchmarks (
  id            bigint generated always as identity primary key,
  publisher_id  uuid not null references content_engine.publishers(id),
  metric        text not null check (metric in ('avg_article_views', 'edgedesk_article_views', 'referral_clicks', 'other')),
  label         text not null check (length(btrim(label)) between 3 and 200),
  value         numeric check (value is null or value >= 0),
  value_low     numeric check (value_low is null or value_low >= 0),
  value_high    numeric check (value_high is null or value_high >= 0),
  sample_size   int check (sample_size is null or sample_size > 0),
  period_label  text,
  source        text not null check (source in ('user_reported', 'publisher_reported')),
  note          text,
  recorded_at   timestamptz not null default now(),
  recorded_by   uuid,
  constraint benchmarks_has_value check (value is not null or (value_low is not null and value_high is not null and value_low <= value_high))
);

-- every source must say where it came from and when
create or replace function content_engine.sources_ok(p jsonb)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select jsonb_typeof(p) = 'array' and not exists (
    select 1 from jsonb_array_elements(p) s
     where jsonb_typeof(s) <> 'object'
        or coalesce(s ->> 'url', '') !~ '^https://'
        or coalesce(s ->> 'as_of', s ->> 'published_at', s ->> 'retrieved_at') is null);
$$;

create table if not exists content_engine.opportunities (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique check (length(key) between 5 and 200),
  league          text not null check (league in ('cfb', 'nfl')),
  season          int,
  week            int,
  kind            text not null check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story')),
  title           text not null check (length(btrim(title)) between 5 and 240),
  angle           text,
  summary         text,
  teams           text[] not null default '{}',
  research        jsonb not null check (jsonb_typeof(research) = 'object'),
  research_hash   text not null,
  research_as_of  timestamptz,
  sources         jsonb not null default '[]'::jsonb check (content_engine.sources_ok(sources)),
  scores          jsonb not null default '{}'::jsonb check (jsonb_typeof(scores) = 'object'),
  priority        int not null check (priority between 0 and 100),
  demand          jsonb,
  seo             jsonb,
  formats         text[] not null default '{}',
  status          text not null default 'new' check (status in ('new', 'shortlisted', 'assigned', 'dismissed', 'expired')),
  dismissed_reason text,
  discovered_by   text not null check (discovered_by in ('owner', 'schedule')),
  run_id          bigint,
  discovered_at   timestamptz not null default now(),
  refreshed_at    timestamptz not null default now(),
  expires_at      timestamptz
);
create index if not exists opportunities_rank on content_engine.opportunities (status, priority desc);

create table if not exists content_engine.articles (
  id                 uuid primary key default gen_random_uuid(),
  opportunity_id     uuid not null references content_engine.opportunities(id),
  publisher_id       uuid references content_engine.publishers(id),
  format             text not null check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'publisher_custom')),
  angle              text not null default 'full_slate' check (angle ~ '^[a-z_]{3,30}$'),
  status             text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'archived')),
  title              text not null check (length(btrim(title)) between 10 and 200),
  slug               text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 90),
  meta_description   text check (meta_description is null or length(meta_description) <= 320),
  standfirst         text,
  primary_keyword    text,
  secondary_keywords text[] not null default '{}',
  sections           jsonb not null check (jsonb_typeof(sections) = 'array' and jsonb_array_length(sections) between 1 and 20),
  word_count         int,
  generator          text not null check (length(generator) between 3 and 80),
  research_hash      text not null,
  research_as_of     timestamptz,
  checks             jsonb not null default '{}'::jsonb check (jsonb_typeof(checks) = 'object'),
  checks_ok          boolean not null default false,
  review             jsonb not null default '{}'::jsonb check (jsonb_typeof(review) = 'object'),
  content_hash       text not null default '',
  revision           int not null default 1,
  campaign_code      text not null unique check (campaign_code ~ '^ce_[a-z0-9]+_[a-z0-9]+$' and length(campaign_code) <= 64),
  approved_at        timestamptz,
  approved_by        uuid,
  approved_hash      text,
  ready_at           timestamptz,
  sent_at            timestamptz,
  published_url      text check (published_url is null or published_url ~ '^https://'),
  published_at       timestamptz,
  archived_at        timestamptz,
  created_by         text not null check (created_by in ('owner', 'schedule')),
  owner_edited       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- one live article per research event × publisher × format × angle: a second
-- angle is a different article, a second copy of the same one is not
create unique index if not exists articles_one_live on content_engine.articles
  (opportunity_id, coalesce(publisher_id, '00000000-0000-0000-0000-000000000000'::uuid), format, angle)
  where status <> 'archived';
create index if not exists articles_status on content_engine.articles (status, updated_at desc);

create table if not exists content_engine.revisions (
  id               bigint generated always as identity primary key,
  article_id       uuid not null references content_engine.articles(id),
  revision         int not null,
  title            text not null,
  meta_description text,
  standfirst       text,
  sections         jsonb not null,
  generator        text not null,
  checks           jsonb,
  content_hash     text not null,
  reason           text,
  actor            text not null check (actor in ('owner', 'schedule')),
  created_at       timestamptz not null default now(),
  unique (article_id, revision)
);

create table if not exists content_engine.deliveries (
  id            bigint generated always as identity primary key,
  article_id    uuid not null references content_engine.articles(id),
  publisher_id  uuid references content_engine.publishers(id),
  method        text not null check (method in ('manual_email', 'cms_upload', 'shared_document', 'other')),
  note          text check (note is null or length(note) <= 500),
  content_hash  text not null,
  delivered_at  timestamptz not null default now(),
  recorded_by   uuid not null
);

create table if not exists content_engine.performance (
  id            bigint generated always as identity primary key,
  article_id    uuid not null references content_engine.articles(id),
  metric        text not null check (metric in ('page_views', 'unique_visitors', 'referral_clicks', 'social_shares', 'comments', 'other')),
  value         numeric not null check (value >= 0),
  source        text not null check (source in ('publisher_reported', 'owner_observed')),
  period_start  date,
  period_end    date,
  note          text check (note is null or length(note) <= 500),
  reported_at   timestamptz not null default now(),
  recorded_by   uuid not null,
  check (period_end is null or period_start is null or period_end >= period_start)
);

create table if not exists content_engine.events (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  actor           text not null check (actor in ('owner', 'schedule', 'system')),
  actor_user      uuid,
  kind            text not null check (kind ~ '^[a-z_]{3,40}$'),
  article_id      uuid,
  opportunity_id  uuid,
  run_id          bigint,
  detail          jsonb not null default '{}'::jsonb
);
create index if not exists events_recent on content_engine.events (at desc);

create table if not exists content_engine.runs (
  id           bigint generated always as identity primary key,
  job          text not null check (job in ('discover', 'draft', 'weekly')),
  period_key   text not null check (length(period_key) between 3 and 80),
  started_by   text not null check (started_by in ('owner', 'schedule')),
  status       text not null default 'running' check (status in ('running', 'done', 'failed', 'superseded')),
  counts       jsonb not null default '{}'::jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
-- the same job for the same period runs once (a forced re-run supersedes)
create unique index if not exists runs_once on content_engine.runs (job, period_key) where status in ('running', 'done');

create table if not exists content_engine.usage (
  day       date not null,
  provider  text not null check (provider in ('llm', 'fetch')),
  calls     int not null default 0 check (calls >= 0),
  primary key (day, provider)
);

alter table content_engine.settings enable row level security;
alter table content_engine.publishers enable row level security;
alter table content_engine.benchmarks enable row level security;
alter table content_engine.opportunities enable row level security;
alter table content_engine.articles enable row level security;
alter table content_engine.revisions enable row level security;
alter table content_engine.deliveries enable row level security;
alter table content_engine.performance enable row level security;
alter table content_engine.events enable row level security;
alter table content_engine.runs enable row level security;
alter table content_engine.usage enable row level security;
-- no policy for any client role: default deny, on top of the schema not being served
revoke all on all tables in schema content_engine from public;
do $r$ begin
  execute 'revoke all on all tables in schema content_engine from anon, authenticated, service_role';
  execute 'revoke all on all sequences in schema content_engine from anon, authenticated, service_role';
exception when undefined_object then null; end $r$;

-- =============================================================================
-- 2. WHO IS CALLING
-- =============================================================================

create or replace function content_engine.owner_ok(p_user uuid)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p_user is not null and growth_outbound.owner_active(p_user);
$$;

-- the service role, as PostgREST presents it (the role setting survives into a
-- security-definer function; newer PostgREST publishes claims as one JSON)
create or replace function content_engine.is_service()
returns boolean language plpgsql stable
set search_path = pg_catalog, pg_temp as $$
declare c text := nullif(current_setting('request.jwt.claims', true), '');
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') = 'service_role' then return true; end if;
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role' then return true; end if;
  if c is not null then
    begin return (c::jsonb ->> 'role') = 'service_role'; exception when others then return false; end;
  end if;
  return false;
end $$;

-- 'owner' | 'schedule', or refuse
create or replace function content_engine.require_actor()
returns text language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is not null and content_engine.owner_ok(v) then return 'owner'; end if;
  if v is null and content_engine.is_service() then return 'schedule'; end if;
  raise exception 'content engine: outbound owner only' using errcode = 'insufficient_privilege';
end $$;

create or replace function content_engine.require_owner()
returns uuid language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is null or not content_engine.owner_ok(v) then
    raise exception 'content engine: outbound owner only' using errcode = 'insufficient_privilege';
  end if;
  return v;
end $$;

create or replace function content_engine.log(p_actor text, p_kind text, p_article uuid, p_opportunity uuid, p_run bigint, p_detail jsonb)
returns void language sql
set search_path = pg_catalog, public, pg_temp as $$
  insert into content_engine.events (actor, actor_user, kind, article_id, opportunity_id, run_id, detail)
  values (p_actor, auth.uid(), p_kind, p_article, p_opportunity, p_run, coalesce(p_detail, '{}'::jsonb));
$$;

-- =============================================================================
-- 3. INVARIANTS
-- =============================================================================

create or replace function content_engine.can_transition(p_from text, p_to text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select (p_from, p_to) in (
    ('draft', 'in_review'), ('draft', 'archived'),
    ('in_review', 'draft'), ('in_review', 'approved'), ('in_review', 'archived'),
    ('approved', 'ready_to_send'), ('approved', 'in_review'), ('approved', 'draft'), ('approved', 'archived'),
    ('ready_to_send', 'sent'), ('ready_to_send', 'approved'), ('ready_to_send', 'in_review'), ('ready_to_send', 'archived'),
    ('sent', 'published'), ('sent', 'archived'),
    ('published', 'archived'),
    ('archived', 'draft'));
$$;

create or replace function content_engine.review_complete(p jsonb)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce((p ->> 'source_verification')::boolean, false)
     and coalesce((p ->> 'data_freshness')::boolean, false)
     and coalesce((p ->> 'model_accuracy')::boolean, false)
     and coalesce((p ->> 'seo_review')::boolean, false)
     and coalesce((p ->> 'compliance')::boolean, false);
$$;

-- the database's own last word on language: what no approved article may say
-- (lib/content_engine.js carries the full list; this is the floor)
create or replace function content_engine.lint(p_text text)
returns text[] language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare out text[] := '{}'; t text := lower(coalesce(p_text, '')); r text;
begin
  foreach r in array array[
    '\ybest bets?\y', '\ylocks? of the\y', '\ymortal lock\y', '\yguarantee[ds]?\y', '\yfree money\y', '\ysure thing\y',
    '\ycan.?t[- ]lose\y', '\ycannot lose\y', '\yrisk.?free\y', '\ybet the house\y', '\ymax bet\y', '\y(my|our|the) pick is\y',
    '\ytake the points\y', '\yplay of the (day|week|year)\y', '\ywill (win|cover)\y', '\yno.?brainer\y', '\yeasy money\y'] loop
    if t ~ r then out := out || regexp_replace(r, '\\y', '', 'g'); end if;
  end loop;
  return out;
end $$;

create or replace function content_engine.content_hash(p_title text, p_meta text, p_standfirst text, p_sections jsonb)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(coalesce(p_title, '') || chr(31) || coalesce(p_meta, '') || chr(31) || coalesce(p_standfirst, '')
                                  || chr(31) || coalesce(p_sections::text, ''), 'UTF8')), 'hex');
$$;

create or replace function content_engine.articles_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare door text := coalesce(current_setting('content_engine.door', true), '');
begin
  if tg_op = 'DELETE' then
    raise exception 'articles are archived, never deleted' using errcode = 'check_violation';
  end if;
  new.content_hash := content_engine.content_hash(new.title, new.meta_description, new.standfirst, new.sections);
  new.updated_at := now();

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'an article starts as a draft' using errcode = 'check_violation'; end if;
    new.approved_at := null; new.approved_by := null; new.approved_hash := null;
    return new;
  end if;

  -- content changed
  if new.content_hash is distinct from old.content_hash then
    if old.status in ('sent', 'published') then
      raise exception 'sent or published content is frozen: archive it and start a new article' using errcode = 'check_violation';
    end if;
    if old.status = 'archived' then
      raise exception 'restore the article to draft before editing it' using errcode = 'check_violation';
    end if;
    if old.status in ('approved', 'ready_to_send') then
      new.status := 'in_review';   -- an edit after approval is reviewed again
    end if;
  end if;

  if new.status is distinct from old.status then
    if not content_engine.can_transition(old.status, new.status) then
      raise exception 'an article cannot move from % to %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'approved' and old.status = 'in_review' then
      if door <> 'approve' then raise exception 'only the approve door approves' using errcode = 'insufficient_privilege'; end if;
      if new.approved_by is null or new.approved_by is distinct from auth.uid() or not content_engine.owner_ok(new.approved_by) then
        raise exception 'only an owner approves, as themselves' using errcode = 'insufficient_privilege';
      end if;
      if new.approved_hash is distinct from new.content_hash then raise exception 'approval is for the exact content reviewed' using errcode = 'check_violation'; end if;
      if not new.checks_ok then raise exception 'automated checks have not passed' using errcode = 'check_violation'; end if;
      if not content_engine.review_complete(new.review) then raise exception 'the editorial review is not complete' using errcode = 'check_violation'; end if;
    end if;
    if new.status = 'ready_to_send' and (new.approved_hash is distinct from new.content_hash or new.approved_by is null) then
      raise exception 'only approved, unchanged content is ready to send' using errcode = 'check_violation';
    end if;
    if new.status = 'sent' then
      if door <> 'mark_sent' then raise exception 'only the mark-sent door records a send' using errcode = 'insufficient_privilege'; end if;
      new.sent_at := coalesce(new.sent_at, now());
    end if;
    if new.status = 'published' and new.published_url is null then
      raise exception 'a published article needs its published URL' using errcode = 'check_violation';
    end if;
    if old.status = 'archived' and new.status = 'draft' and old.sent_at is not null then
      raise exception 'an article that was sent stays archived: start a new one' using errcode = 'check_violation';
    end if;
    if new.status = 'archived' then new.archived_at := now(); end if;
    if new.status = 'ready_to_send' then new.ready_at := now(); end if;
    -- leaving approval for review or rework clears it
    if new.status in ('draft', 'in_review') then
      new.approved_at := null; new.approved_by := null; new.approved_hash := null; new.ready_at := null;
    end if;
  elsif new.status in ('approved', 'ready_to_send') and (new.approved_by is distinct from old.approved_by or new.approved_hash is distinct from old.approved_hash) then
    raise exception 'approval cannot be rewritten' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists articles_guard on content_engine.articles;
create trigger articles_guard before insert or update or delete on content_engine.articles
  for each row execute function content_engine.articles_guard();

create or replace function content_engine.append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end $$;
do $t$
declare t text;
begin
  foreach t in array array['revisions', 'deliveries', 'performance', 'events', 'benchmarks'] loop
    execute format('drop trigger if exists %I_append_only on content_engine.%I', t, t);
    execute format('create trigger %I_append_only before update or delete on content_engine.%I for each row execute function content_engine.append_only()', t, t);
    execute format('drop trigger if exists %I_no_truncate on content_engine.%I', t, t);
    execute format('create trigger %I_no_truncate before truncate on content_engine.%I for each statement execute function content_engine.append_only()', t, t);
  end loop;
  foreach t in array array['opportunities', 'publishers', 'articles'] loop
    execute format('drop trigger if exists %I_no_truncate on content_engine.%I', t, t);
    execute format('create trigger %I_no_truncate before truncate on content_engine.%I for each statement execute function content_engine.append_only()', t, t);
  end loop;
end $t$;

create or replace function content_engine.no_delete()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% rows are never deleted (dismiss or end them instead)', tg_table_name using errcode = 'check_violation';
end $$;
drop trigger if exists opportunities_no_delete on content_engine.opportunities;
create trigger opportunities_no_delete before delete on content_engine.opportunities for each row execute function content_engine.no_delete();
drop trigger if exists publishers_no_delete on content_engine.publishers;
create trigger publishers_no_delete before delete on content_engine.publishers for each row execute function content_engine.no_delete();

-- =============================================================================
-- 4. SMALL HELPERS
-- =============================================================================

create or replace function content_engine.article_json(a content_engine.articles)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select to_jsonb(a) || jsonb_build_object(
    'publisher', (select jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name) from content_engine.publishers p where p.id = a.publisher_id),
    'review_complete', content_engine.review_complete(a.review),
    'lint', to_jsonb(content_engine.lint(a.title || ' ' || coalesce(a.standfirst, '') || ' ' || a.sections::text)));
$$;

create or replace function content_engine.campaign_for(p_publisher uuid, p_article uuid)
returns text language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select 'ce_' || coalesce(left(regexp_replace(lower((select slug from content_engine.publishers where id = p_publisher)), '[^a-z0-9]', '', 'g'), 20), 'direct')
         || '_' || left(replace(p_article::text, '-', ''), 12);
$$;

-- the save every writer goes through (create and edit): content, checks,
-- a revision row
create or replace function content_engine.write_revision(p_article uuid, p_actor text, p_reason text)
returns void language sql
set search_path = pg_catalog, public, pg_temp as $$
  insert into content_engine.revisions (article_id, revision, title, meta_description, standfirst, sections, generator, checks, content_hash, reason, actor)
  select a.id, a.revision, a.title, a.meta_description, a.standfirst, a.sections, a.generator, a.checks, a.content_hash, p_reason, p_actor
    from content_engine.articles a where a.id = p_article;
$$;

-- =============================================================================
-- 5. DOORS — every one: security definer, its first statement the caller check
-- =============================================================================

create or replace function public.content_engine_is_owner()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select content_engine.owner_ok(auth.uid());
$$;

create or replace function public.content_engine_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare s content_engine.settings;
begin
  perform content_engine.require_owner();
  select * into s from content_engine.settings where id = 1;
  return jsonb_build_object(
    'settings', to_jsonb(s),
    'articles', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from content_engine.articles group by status) x), '{}'::jsonb),
    'opportunities', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from content_engine.opportunities group by status) x), '{}'::jsonb),
    'budget', jsonb_build_object(
      'llm', jsonb_build_object('cap', s.llm_calls_per_day, 'used', coalesce((select calls from content_engine.usage where day = (now() at time zone 'utc')::date and provider = 'llm'), 0)),
      'fetch', jsonb_build_object('cap', s.fetch_calls_per_day, 'used', coalesce((select calls from content_engine.usage where day = (now() at time zone 'utc')::date and provider = 'fetch'), 0))),
    'publishers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'name', name, 'status', status) order by name) from content_engine.publishers), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (select * from content_engine.runs order by started_at desc limit 8) r), '[]'::jsonb),
    'problems', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (select * from content_engine.events
        where kind in ('generation_failed', 'validation_failed', 'ai_discarded', 'fetch_failed', 'job_failed') order by at desc limit 12) e), '[]'::jsonb));
end $$;

create or replace function public.content_engine_settings_save(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner();
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  update content_engine.settings set
    drafts_per_run = coalesce((p ->> 'drafts_per_run')::int, drafts_per_run),
    llm_calls_per_day = coalesce((p ->> 'llm_calls_per_day')::int, llm_calls_per_day),
    fetch_calls_per_day = coalesce((p ->> 'fetch_calls_per_day')::int, fetch_calls_per_day),
    min_priority = coalesce((p ->> 'min_priority')::int, min_priority),
    schedule_enabled = coalesce((p ->> 'schedule_enabled')::boolean, schedule_enabled),
    default_publisher = case when p ? 'default_publisher' then nullif(p ->> 'default_publisher', '') else default_publisher end,
    landing_url = coalesce(nullif(p ->> 'landing_url', ''), landing_url),
    updated_at = now(), updated_by = v
  where id = 1;
  perform content_engine.log('owner', 'settings_saved', null, null, null, p);
  return jsonb_build_object('ok', true);
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- ── publishers ───────────────────────────────────────────────────────────────
create or replace function public.content_engine_publishers()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
      'benchmarks', coalesce((select jsonb_agg(to_jsonb(b) order by b.recorded_at) from content_engine.benchmarks b where b.publisher_id = p.id), '[]'::jsonb),
      'articles', (select count(*) from content_engine.articles a where a.publisher_id = p.id))
    order by p.name) from content_engine.publishers p), '[]'::jsonb);
end $$;

-- for the weekly job: editorial profiles only (no contacts, no terms)
create or replace function public.content_engine_job_publishers()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_actor();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'name', name, 'status', status, 'utm_source', utm_source, 'editorial', editorial) order by name)
    from content_engine.publishers where status in ('active', 'prospect')), '[]'::jsonb);
end $$;

create or replace function public.content_engine_publisher_save(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); r content_engine.publishers;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  if nullif(p ->> 'id', '') is not null then
    update content_engine.publishers set
      name = coalesce(nullif(btrim(p ->> 'name'), ''), name),
      website = case when p ? 'website' then nullif(btrim(p ->> 'website'), '') else website end,
      status = coalesce(nullif(p ->> 'status', ''), status),
      utm_source = coalesce(nullif(p ->> 'utm_source', ''), utm_source),
      editorial = coalesce(p -> 'editorial', editorial),
      contacts = coalesce(p -> 'contacts', contacts),
      partnership = coalesce(p -> 'partnership', partnership),
      distribution = coalesce(p -> 'distribution', distribution),
      approval = coalesce(p -> 'approval', approval),
      updated_at = now()
    where id = (p ->> 'id')::uuid returning * into r;
    if r.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  else
    insert into content_engine.publishers (slug, name, website, status, utm_source, editorial, contacts, partnership, distribution, approval)
    values (p ->> 'slug', btrim(p ->> 'name'), nullif(btrim(p ->> 'website'), ''), coalesce(nullif(p ->> 'status', ''), 'prospect'),
            coalesce(nullif(p ->> 'utm_source', ''), replace(p ->> 'slug', '-', '')),
            coalesce(p -> 'editorial', '{}'::jsonb), coalesce(p -> 'contacts', '[]'::jsonb), coalesce(p -> 'partnership', '{}'::jsonb),
            coalesce(p -> 'distribution', '{}'::jsonb), coalesce(p -> 'approval', '{}'::jsonb))
    returning * into r;
  end if;
  perform content_engine.log('owner', 'publisher_saved', null, null, null, jsonb_build_object('publisher', r.slug));
  return jsonb_build_object('ok', true, 'id', r.id);
exception when check_violation or not_null_violation or unique_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

create or replace function public.content_engine_benchmark_add(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); n bigint;
begin
  insert into content_engine.benchmarks (publisher_id, metric, label, value, value_low, value_high, sample_size, period_label, source, note, recorded_by)
  values ((p ->> 'publisher_id')::uuid, p ->> 'metric', p ->> 'label', (p ->> 'value')::numeric, (p ->> 'value_low')::numeric, (p ->> 'value_high')::numeric,
          (p ->> 'sample_size')::int, p ->> 'period_label', coalesce(p ->> 'source', 'user_reported'), p ->> 'note', v)
  returning id into n;
  return jsonb_build_object('ok', true, 'id', n);
exception when check_violation or not_null_violation or foreign_key_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- ── opportunities ───────────────────────────────────────────────────────────
create or replace function public.content_engine_opportunities(p_status text default null, p_limit int default 60)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return coalesce((select jsonb_agg(x order by (x ->> 'priority')::int desc, x ->> 'discovered_at' desc) from (
    select jsonb_build_object('id', o.id, 'key', o.key, 'league', o.league, 'season', o.season, 'week', o.week, 'kind', o.kind,
             'title', o.title, 'angle', o.angle, 'summary', o.summary, 'teams', o.teams, 'scores', o.scores, 'priority', o.priority,
             'demand', o.demand, 'seo', o.seo, 'formats', o.formats, 'status', o.status, 'sources', o.sources,
             'research_as_of', o.research_as_of, 'discovered_by', o.discovered_by, 'discovered_at', o.discovered_at,
             'refreshed_at', o.refreshed_at, 'expires_at', o.expires_at,
             'articles', (select count(*) from content_engine.articles a where a.opportunity_id = o.id and a.status <> 'archived')) x
      from content_engine.opportunities o
     where (p_status is null and o.status not in ('dismissed', 'expired')) or o.status = p_status
     order by o.priority desc limit greatest(1, least(coalesce(p_limit, 60), 200))) q), '[]'::jsonb);
end $$;

create or replace function public.content_engine_opportunity(p_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare r content_engine.opportunities;
begin
  perform content_engine.require_owner();
  select * into r from content_engine.opportunities where id = p_id;
  if r.id is null then return null; end if;
  return to_jsonb(r);
end $$;

-- discovery writes here (owner or the weekly job). Idempotent on the key: the
-- same opportunity found again refreshes its research and scores and keeps
-- its status — a dismissed one stays dismissed.
create or replace function public.content_engine_opportunity_upsert(p jsonb, p_run bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); r content_engine.opportunities; old_hash text; created boolean := false;
begin
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'key', '') = '' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  select research_hash into old_hash from content_engine.opportunities where key = p ->> 'key';
  insert into content_engine.opportunities as o (key, league, season, week, kind, title, angle, summary, teams, research, research_hash,
              research_as_of, sources, scores, priority, demand, seo, formats, discovered_by, run_id, expires_at)
  values (p ->> 'key', p ->> 'league', (p ->> 'season')::int, (p ->> 'week')::int, p ->> 'kind', p ->> 'title', p ->> 'angle', p ->> 'summary',
          coalesce((select array_agg(t) from jsonb_array_elements_text(coalesce(p -> 'teams', '[]'::jsonb)) t), '{}'),
          p -> 'research', coalesce(p ->> 'research_hash', md5((p -> 'research')::text)), nullif(p -> 'research' ->> 'as_of', '')::timestamptz,
          coalesce(p -> 'sources', '[]'::jsonb), coalesce(p -> 'scores', '{}'::jsonb), (p ->> 'priority')::int, p -> 'demand', p -> 'seo',
          coalesce((select array_agg(t) from jsonb_array_elements_text(coalesce(p -> 'formats', '[]'::jsonb)) t), '{}'),
          who, p_run, nullif(p ->> 'expires_at', '')::timestamptz)
  on conflict (key) do update set
    title = excluded.title, angle = excluded.angle, summary = excluded.summary, teams = excluded.teams,
    research = excluded.research, research_hash = excluded.research_hash, research_as_of = excluded.research_as_of,
    sources = excluded.sources, scores = excluded.scores, priority = excluded.priority, demand = excluded.demand, seo = excluded.seo,
    formats = excluded.formats, expires_at = excluded.expires_at, refreshed_at = now(),
    status = case when o.status = 'expired' then 'new' else o.status end
  returning * into r;
  created := old_hash is null;
  return jsonb_build_object('ok', true, 'id', r.id, 'created', created, 'research_changed', old_hash is not null and old_hash is distinct from r.research_hash, 'status', r.status);
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
  perform content_engine.log(who, 'validation_failed', null, null, p_run, jsonb_build_object('stage', 'opportunity_upsert', 'key', p ->> 'key', 'error', sqlerrm));
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

create or replace function public.content_engine_opportunity_set_status(p_id uuid, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner();
begin
  if p_status not in ('new', 'shortlisted', 'dismissed', 'expired') then return jsonb_build_object('ok', false, 'reason', 'bad_status'); end if;
  update content_engine.opportunities set status = p_status, dismissed_reason = case when p_status = 'dismissed' then left(p_reason, 300) else dismissed_reason end
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform content_engine.log('owner', 'opportunity_' || p_status, null, p_id, null, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- ── articles ─────────────────────────────────────────────────────────────────
-- Create a draft from an opportunity (owner or the weekly job). Idempotent:
-- the live article for this research × publisher × format × angle comes back
-- instead of a second copy.
create or replace function public.content_engine_article_create(p_opportunity uuid, p_publisher uuid, p_format text, p_angle text, p jsonb, p_run bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); o content_engine.opportunities; aid uuid; existing uuid;
begin
  select * into o from content_engine.opportunities where id = p_opportunity;
  if o.id is null then return jsonb_build_object('ok', false, 'reason', 'no_opportunity'); end if;
  if o.status = 'dismissed' then return jsonb_build_object('ok', false, 'reason', 'dismissed'); end if;
  if p_publisher is not null and not exists (select 1 from content_engine.publishers where id = p_publisher and status in ('active', 'prospect')) then
    return jsonb_build_object('ok', false, 'reason', 'publisher_inactive');
  end if;
  select id into existing from content_engine.articles
   where opportunity_id = p_opportunity and publisher_id is not distinct from p_publisher and format = p_format
     and angle = coalesce(nullif(p_angle, ''), 'full_slate') and status <> 'archived';
  if existing is not null then return jsonb_build_object('ok', true, 'id', existing, 'existing', true); end if;
  aid := gen_random_uuid();
  insert into content_engine.articles (id, opportunity_id, publisher_id, format, angle, title, slug, meta_description, standfirst,
              primary_keyword, secondary_keywords, sections, word_count, generator, research_hash, research_as_of, checks, checks_ok,
              campaign_code, created_by)
  values (aid, p_opportunity, p_publisher, p_format, coalesce(nullif(p_angle, ''), 'full_slate'), p ->> 'title', p ->> 'slug',
          p ->> 'meta_description', p ->> 'standfirst', p ->> 'primary_keyword',
          coalesce((select array_agg(t) from jsonb_array_elements_text(coalesce(p -> 'secondary_keywords', '[]'::jsonb)) t), '{}'),
          p -> 'sections', (p ->> 'word_count')::int, coalesce(p ->> 'generator', 'template'), o.research_hash, o.research_as_of,
          coalesce(p -> 'checks', '{}'::jsonb), coalesce((p -> 'checks' ->> 'ok')::boolean, false),
          content_engine.campaign_for(p_publisher, aid), who);
  perform content_engine.write_revision(aid, who, 'created');
  update content_engine.opportunities set status = 'assigned' where id = p_opportunity and status in ('new', 'shortlisted');
  perform content_engine.log(who, 'article_created', aid, p_opportunity, p_run, jsonb_build_object('format', p_format, 'generator', p ->> 'generator'));
  return jsonb_build_object('ok', true, 'id', aid, 'existing', false, 'campaign_code', content_engine.campaign_for(p_publisher, aid));
exception when unique_violation then
  select id into existing from content_engine.articles
   where opportunity_id = p_opportunity and publisher_id is not distinct from p_publisher and format = p_format
     and angle = coalesce(nullif(p_angle, ''), 'full_slate') and status <> 'archived';
  return jsonb_build_object('ok', existing is not null, 'id', existing, 'existing', true);
when check_violation or not_null_violation or invalid_text_representation then
  perform content_engine.log(who, 'validation_failed', null, p_opportunity, p_run, jsonb_build_object('stage', 'article_create', 'error', sqlerrm));
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- Save new content and its checks. p_expected_hash guards against saving over
-- a version the caller never saw. The weekly job may only rewrite its own
-- drafts that no owner has touched.
create or replace function public.content_engine_article_save(p_id uuid, p jsonb, p_reason text default null, p_expected_hash text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); a content_engine.articles; before_status text;
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_expected_hash is not null and p_expected_hash is distinct from a.content_hash then
    return jsonb_build_object('ok', false, 'reason', 'changed_since_loaded', 'content_hash', a.content_hash);
  end if;
  if who = 'schedule' and (a.created_by <> 'schedule' or a.owner_edited or a.status <> 'draft') then
    return jsonb_build_object('ok', false, 'reason', 'owner_owned');
  end if;
  if a.status in ('sent', 'published', 'archived') then return jsonb_build_object('ok', false, 'reason', 'frozen', 'status', a.status); end if;
  before_status := a.status;
  update content_engine.articles set
    title = coalesce(p ->> 'title', title),
    slug = coalesce(p ->> 'slug', slug),
    meta_description = case when p ? 'meta_description' then p ->> 'meta_description' else meta_description end,
    standfirst = case when p ? 'standfirst' then p ->> 'standfirst' else standfirst end,
    primary_keyword = case when p ? 'primary_keyword' then p ->> 'primary_keyword' else primary_keyword end,
    secondary_keywords = case when p ? 'secondary_keywords' then coalesce((select array_agg(t) from jsonb_array_elements_text(p -> 'secondary_keywords') t), '{}') else secondary_keywords end,
    sections = coalesce(p -> 'sections', sections),
    word_count = coalesce((p ->> 'word_count')::int, word_count),
    generator = coalesce(p ->> 'generator', generator),
    checks = coalesce(p -> 'checks', checks),
    checks_ok = coalesce((p -> 'checks' ->> 'ok')::boolean, checks_ok),
    research_hash = coalesce(p ->> 'research_hash', research_hash),
    research_as_of = coalesce(nullif(p ->> 'research_as_of', '')::timestamptz, research_as_of),
    owner_edited = owner_edited or who = 'owner',
    revision = revision + 1
  where id = p_id returning * into a;
  perform content_engine.write_revision(p_id, who, left(coalesce(p_reason, 'saved'), 200));
  perform content_engine.log(who, 'article_saved', p_id, a.opportunity_id, null,
    jsonb_build_object('revision', a.revision, 'generator', a.generator, 'checks_ok', a.checks_ok, 'reason', p_reason,
                       'back_to_review', before_status in ('approved', 'ready_to_send') and a.status = 'in_review'));
  return jsonb_build_object('ok', true, 'revision', a.revision, 'content_hash', a.content_hash, 'status', a.status, 'checks_ok', a.checks_ok);
exception when check_violation or not_null_violation or invalid_text_representation then
  perform content_engine.log(who, 'validation_failed', p_id, null, null, jsonb_build_object('stage', 'article_save', 'error', sqlerrm));
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- draft → in_review, only with every automated check passed
create or replace function public.content_engine_article_submit(p_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); a content_engine.articles;
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status <> 'draft' then return jsonb_build_object('ok', false, 'reason', 'not_a_draft', 'status', a.status); end if;
  if not a.checks_ok then return jsonb_build_object('ok', false, 'reason', 'checks_failed', 'failed', a.checks -> 'failed'); end if;
  if who = 'schedule' and (a.created_by <> 'schedule' or a.owner_edited) then return jsonb_build_object('ok', false, 'reason', 'owner_owned'); end if;
  update content_engine.articles set status = 'in_review' where id = p_id;
  perform content_engine.log(who, 'article_submitted', p_id, a.opportunity_id, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'status', 'in_review');
end $$;

-- the five-point editorial review, by the owner
create or replace function public.content_engine_article_review(p_id uuid, p_review jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); a content_engine.articles; rv jsonb;
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status not in ('draft', 'in_review', 'approved', 'ready_to_send') then return jsonb_build_object('ok', false, 'reason', 'frozen'); end if;
  rv := jsonb_build_object(
    'source_verification', coalesce((p_review ->> 'source_verification')::boolean, false),
    'data_freshness', coalesce((p_review ->> 'data_freshness')::boolean, false),
    'model_accuracy', coalesce((p_review ->> 'model_accuracy')::boolean, false),
    'seo_review', coalesce((p_review ->> 'seo_review')::boolean, false),
    'compliance', coalesce((p_review ->> 'compliance')::boolean, false),
    'notes', left(coalesce(p_review ->> 'notes', ''), 2000),
    'by', v, 'at', now(), 'content_hash', a.content_hash);
  update content_engine.articles set review = rv,
    -- an approval whose review is withdrawn goes back to review
    status = case when a.status in ('approved', 'ready_to_send') and not content_engine.review_complete(rv) then 'in_review' else status end
   where id = p_id;
  perform content_engine.log('owner', 'article_reviewed', p_id, a.opportunity_id, null, rv - 'notes');
  return jsonb_build_object('ok', true, 'review_complete', content_engine.review_complete(rv));
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- in_review → approved, by an owner, for the exact content hash they saw
create or replace function public.content_engine_article_approve(p_id uuid, p_content_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); a content_engine.articles; bad text[];
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status <> 'in_review' then return jsonb_build_object('ok', false, 'reason', 'not_in_review', 'status', a.status); end if;
  if p_content_hash is distinct from a.content_hash then return jsonb_build_object('ok', false, 'reason', 'changed_since_loaded', 'content_hash', a.content_hash); end if;
  if not a.checks_ok then return jsonb_build_object('ok', false, 'reason', 'checks_failed', 'failed', a.checks -> 'failed'); end if;
  if not content_engine.review_complete(a.review) then return jsonb_build_object('ok', false, 'reason', 'review_incomplete'); end if;
  if (a.review ->> 'content_hash') is distinct from a.content_hash then return jsonb_build_object('ok', false, 'reason', 'review_is_for_an_older_version'); end if;
  bad := content_engine.lint(a.title || ' ' || coalesce(a.standfirst, '') || ' ' || coalesce(a.meta_description, '') || ' ' || a.sections::text);
  if cardinality(bad) > 0 then return jsonb_build_object('ok', false, 'reason', 'language', 'terms', to_jsonb(bad)); end if;
  perform set_config('content_engine.door', 'approve', true);
  update content_engine.articles set status = 'approved', approved_at = now(), approved_by = v, approved_hash = a.content_hash where id = p_id;
  perform set_config('content_engine.door', '', true);
  perform content_engine.log('owner', 'article_approved', p_id, a.opportunity_id, null, jsonb_build_object('content_hash', a.content_hash));
  return jsonb_build_object('ok', true, 'status', 'approved');
end $$;

-- every other move, by the owner: ready_to_send, sent (with the delivery
-- record), published (with the URL), archived, back to draft or review
create or replace function public.content_engine_article_transition(p_id uuid, p_to text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); a content_engine.articles;
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_to = 'approved' and a.status = 'in_review' then return jsonb_build_object('ok', false, 'reason', 'use_approve'); end if;
  if not content_engine.can_transition(a.status, p_to) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'from', a.status, 'to', p_to);
  end if;
  if p_to = 'sent' then
    if coalesce(p ->> 'method', '') not in ('manual_email', 'cms_upload', 'shared_document', 'other') then
      return jsonb_build_object('ok', false, 'reason', 'method_required');
    end if;
    insert into content_engine.deliveries (article_id, publisher_id, method, note, content_hash, recorded_by)
    values (p_id, a.publisher_id, p ->> 'method', left(p ->> 'note', 500), a.content_hash, v);
    perform set_config('content_engine.door', 'mark_sent', true);
    update content_engine.articles set status = 'sent' where id = p_id;
    perform set_config('content_engine.door', '', true);
  elsif p_to = 'published' then
    if coalesce(p ->> 'url', '') !~ '^https://' then return jsonb_build_object('ok', false, 'reason', 'url_required'); end if;
    update content_engine.articles set status = 'published', published_url = p ->> 'url',
           published_at = coalesce(nullif(p ->> 'published_at', '')::timestamptz, now()) where id = p_id;
  else
    update content_engine.articles set status = p_to where id = p_id;
  end if;
  perform content_engine.log('owner', 'article_' || p_to, p_id, a.opportunity_id, null, coalesce(p, '{}'::jsonb));
  return jsonb_build_object('ok', true, 'status', (select status from content_engine.articles where id = p_id));
exception when check_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

create or replace function public.content_engine_articles(p_status text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return coalesce((select jsonb_agg(x order by x ->> 'updated_at' desc) from (
    select jsonb_build_object('id', a.id, 'title', a.title, 'status', a.status, 'format', a.format, 'angle', a.angle,
             'publisher', (select jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name) from content_engine.publishers p where p.id = a.publisher_id),
             'opportunity', jsonb_build_object('id', o.id, 'title', o.title, 'kind', o.kind, 'league', o.league, 'priority', o.priority),
             'checks_ok', a.checks_ok, 'failed', a.checks -> 'failed', 'warned', a.checks -> 'warned', 'word_count', a.word_count,
             'generator', a.generator, 'revision', a.revision, 'campaign_code', a.campaign_code, 'review_complete', content_engine.review_complete(a.review),
             'created_by', a.created_by, 'updated_at', a.updated_at, 'sent_at', a.sent_at, 'published_url', a.published_url,
             'research_stale', a.research_hash is distinct from o.research_hash) x
      from content_engine.articles a join content_engine.opportunities o on o.id = a.opportunity_id
     where (p_status is null and a.status <> 'archived') or a.status = p_status
     order by a.updated_at desc limit greatest(1, least(coalesce(p_limit, 100), 300))) q), '[]'::jsonb);
end $$;

-- one article with everything the review needs: its opportunity and research,
-- the publisher's profile, revisions, deliveries, reported numbers, and the
-- text of its siblings (other articles from the same research) for the
-- near-duplicate check
create or replace function public.content_engine_article(p_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare a content_engine.articles;
begin
  perform content_engine.require_actor();
  select * into a from content_engine.articles where id = p_id;
  if a.id is null then return null; end if;
  return content_engine.article_json(a) || jsonb_build_object(
    'opportunity', (select to_jsonb(o) from content_engine.opportunities o where o.id = a.opportunity_id),
    'publisher_profile', (select jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'utm_source', p.utm_source, 'editorial', p.editorial)
                            from content_engine.publishers p where p.id = a.publisher_id),
    'landing_url', (select landing_url from content_engine.settings where id = 1),
    'revisions', coalesce((select jsonb_agg(jsonb_build_object('revision', r.revision, 'generator', r.generator, 'reason', r.reason, 'actor', r.actor,
                    'created_at', r.created_at, 'content_hash', r.content_hash) order by r.revision desc)
                  from content_engine.revisions r where r.article_id = a.id), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(to_jsonb(d) order by d.delivered_at) from content_engine.deliveries d where d.article_id = a.id), '[]'::jsonb),
    'performance', coalesce((select jsonb_agg(to_jsonb(m) order by m.reported_at) from content_engine.performance m where m.article_id = a.id), '[]'::jsonb),
    'siblings', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title,
                    'text', (select string_agg(x ->> 'body', E'\n\n') from jsonb_array_elements(s.sections) x)))
                  from content_engine.articles s where s.opportunity_id = a.opportunity_id and s.id <> a.id and s.status <> 'archived'), '[]'::jsonb));
end $$;

-- the revision itself (for comparing or restoring)
create or replace function public.content_engine_revision(p_id uuid, p_revision int)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return (select to_jsonb(r) from content_engine.revisions r where r.article_id = p_id and r.revision = p_revision);
end $$;

-- ── performance ──────────────────────────────────────────────────────────────
create or replace function public.content_engine_performance_add(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); n bigint;
begin
  insert into content_engine.performance (article_id, metric, value, source, period_start, period_end, note, recorded_by)
  values ((p ->> 'article_id')::uuid, p ->> 'metric', (p ->> 'value')::numeric, coalesce(p ->> 'source', 'publisher_reported'),
          nullif(p ->> 'period_start', '')::date, nullif(p ->> 'period_end', '')::date, p ->> 'note', v)
  returning id into n;
  return jsonb_build_object('ok', true, 'id', n);
exception when check_violation or not_null_violation or foreign_key_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- first-party measurement for one campaign code: COUNTS ONLY, owners excluded.
-- Each figure is null (not measured) when the table it needs is not installed.
create or replace function content_engine.first_party(p_code text)
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare visits int; sessions int; signups int; trials int; paid int; users uuid[];
begin
  if to_regclass('public.acquisition_visitors') is not null then
    select count(*) into visits from public.acquisition_visitors v
     where (v.first_utm_campaign = p_code or v.last_utm_campaign = p_code)
       and (v.user_id is null or not exists (select 1 from growth_outbound.owners o where o.user_id = v.user_id));
  end if;
  if to_regclass('public.user_events') is not null then
    select count(distinct coalesce(e.session_id, e.anonymous_session_id)) into sessions from public.user_events e
     where e.utm_campaign = p_code and e.event_name = 'public_page_view';
  end if;
  if to_regclass('public.user_acquisition') is not null then
    select coalesce(array_agg(u.user_id), '{}') into users from public.user_acquisition u
     where (u.first_utm_campaign = p_code or u.last_utm_campaign = p_code)
       and not exists (select 1 from growth_outbound.owners o where o.user_id = u.user_id);
    signups := cardinality(users);
    if to_regprocedure('public.growth_customer_facts()') is not null then
      select count(*) filter (where f.trial_started_at is not null), count(*) filter (where f.paid_at is not null)
        into trials, paid from public.growth_customer_facts() f where f.user_id = any (users);
    end if;
  end if;
  return jsonb_build_object('visits', visits, 'sessions', sessions, 'signups', signups, 'trials', trials, 'paid', paid);
end $$;

create or replace function public.content_engine_performance()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return jsonb_build_object(
    'note', 'first_party: EdgeDesk''s own measurement, joined on each article''s utm_campaign (counts only, owners excluded). publisher_reported: figures the publisher gave us, as entered. benchmarks: user-reported reference values, not live analytics.',
    'articles', coalesce((select jsonb_agg(x order by x ->> 'sent_at' desc nulls last) from (
      select jsonb_build_object('id', a.id, 'title', a.title, 'status', a.status, 'campaign_code', a.campaign_code,
               'publisher', (select jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name) from content_engine.publishers p where p.id = a.publisher_id),
               'sent_at', a.sent_at, 'published_at', a.published_at, 'published_url', a.published_url,
               'first_party', content_engine.first_party(a.campaign_code),
               'publisher_reported', coalesce((select jsonb_object_agg(metric, jsonb_build_object('value', value, 'reported_at', reported_at, 'source', source))
                   from (select distinct on (metric) metric, value, reported_at, source from content_engine.performance m
                          where m.article_id = a.id order by metric, reported_at desc) z), '{}'::jsonb)) x
        from content_engine.articles a where a.status in ('sent', 'published') or exists (select 1 from content_engine.performance m where m.article_id = a.id)) q), '[]'::jsonb),
    'benchmarks', coalesce((select jsonb_agg(to_jsonb(b) || jsonb_build_object('publisher', p.name) order by p.name, b.recorded_at)
        from content_engine.benchmarks b join content_engine.publishers p on p.id = b.publisher_id), '[]'::jsonb),
    'measured', jsonb_build_object(
      'visits', to_regclass('public.acquisition_visitors') is not null,
      'sessions', to_regclass('public.user_events') is not null,
      'signups', to_regclass('public.user_acquisition') is not null,
      'trials_paid', to_regprocedure('public.growth_customer_facts()') is not null));
end $$;

-- ── budget, log, search evidence ─────────────────────────────────────────────
-- one call counted BEFORE it is made; over today's cap → refused
create or replace function public.content_engine_spend(p_provider text, p_n int default 1)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); cap int; used int; d date := (now() at time zone 'utc')::date;
begin
  if p_provider not in ('llm', 'fetch') or coalesce(p_n, 0) < 1 or p_n > 20 then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  select case when p_provider = 'llm' then llm_calls_per_day else fetch_calls_per_day end into cap from content_engine.settings where id = 1;
  insert into content_engine.usage (day, provider, calls) values (d, p_provider, 0) on conflict do nothing;
  select calls into used from content_engine.usage where day = d and provider = p_provider for update;
  if used + p_n > cap then
    perform content_engine.log(who, 'budget_exhausted', null, null, null, jsonb_build_object('provider', p_provider, 'cap', cap, 'used', used));
    return jsonb_build_object('ok', false, 'reason', 'budget_exhausted', 'cap', cap, 'used', used);
  end if;
  update content_engine.usage set calls = calls + p_n where day = d and provider = p_provider;
  return jsonb_build_object('ok', true, 'cap', cap, 'used', used + p_n);
end $$;

create or replace function public.content_engine_log(p_kind text, p_detail jsonb default '{}'::jsonb, p_article uuid default null, p_opportunity uuid default null, p_run bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor();
begin
  if p_kind not in ('generation_failed', 'validation_failed', 'ai_discarded', 'ai_accepted', 'fetch_failed', 'exported', 'note', 'job_note', 'job_failed', 'discovery_run') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  perform content_engine.log(who, p_kind, p_article, p_opportunity, p_run, left(coalesce(p_detail, '{}'::jsonb)::text, 8000)::jsonb);
  return jsonb_build_object('ok', true);
exception when invalid_text_representation then
  perform content_engine.log(who, p_kind, p_article, p_opportunity, p_run, jsonb_build_object('truncated', true));
  return jsonb_build_object('ok', true);
end $$;

-- EdgeDesk's own Search Console exposure for each term (last 28 days). This
-- is measured exposure for edgedesksports.com, not total search volume.
-- p_terms: a JSON array of strings (what a page or a job sends)
create or replace function public.content_engine_search_evidence(p_terms jsonb)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare out jsonb := '{}'::jsonb; t text; r record;
begin
  perform content_engine.require_actor();
  if to_regclass('public.search_console_queries') is null then return jsonb_build_object('_installed', false); end if;
  if p_terms is null or jsonb_typeof(p_terms) <> 'array' then return jsonb_build_object('_installed', true); end if;
  for t in select x from jsonb_array_elements_text(p_terms) x limit 60 loop
    if t is null or length(btrim(t)) < 3 then continue; end if;
    select coalesce(sum(q.impressions), 0) as impressions, coalesce(sum(q.clicks), 0) as clicks, count(distinct q.query) as queries
      into r from public.search_console_queries q
     where q.day >= current_date - 28 and q.query ilike '%' || btrim(t) || '%';
    out := out || jsonb_build_object(lower(btrim(t)), jsonb_build_object('impressions', r.impressions, 'clicks', r.clicks, 'queries', r.queries, 'days', 28));
  end loop;
  return out || jsonb_build_object('_installed', true);
end $$;

-- ── the scheduled job ────────────────────────────────────────────────────────
-- A lease per job and period: the same week's run happens once; a crashed run
-- older than 30 minutes is failed so the next one can start.
create or replace function public.content_engine_job_begin(p_job text, p_period text, p_force boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); s content_engine.settings; n bigint;
begin
  select * into s from content_engine.settings where id = 1;
  if who = 'schedule' and not s.schedule_enabled then return jsonb_build_object('ok', false, 'reason', 'schedule_disabled'); end if;
  update content_engine.runs set status = 'failed', error = 'abandoned (over 30 minutes)', finished_at = now()
   where status = 'running' and started_at < now() - interval '30 minutes';
  if exists (select 1 from content_engine.runs where job = p_job and period_key = p_period and status = 'running') then
    return jsonb_build_object('ok', false, 'reason', 'already_running');
  end if;
  if exists (select 1 from content_engine.runs where job = p_job and period_key = p_period and status = 'done') then
    if not coalesce(p_force, false) then return jsonb_build_object('ok', false, 'reason', 'already_done'); end if;
    update content_engine.runs set status = 'superseded' where job = p_job and period_key = p_period and status = 'done';
  end if;
  insert into content_engine.runs (job, period_key, started_by) values (p_job, p_period, who) returning id into n;
  return jsonb_build_object('ok', true, 'run_id', n, 'settings', to_jsonb(s));
exception when check_violation or unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

create or replace function public.content_engine_job_finish(p_run bigint, p_status text, p_counts jsonb default '{}'::jsonb, p_error text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor();
begin
  if p_status not in ('done', 'failed') then return jsonb_build_object('ok', false, 'reason', 'bad_status'); end if;
  update content_engine.runs set status = p_status, counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 2000), finished_at = now()
   where id = p_run and status = 'running';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_running'); end if;
  if p_status = 'failed' then perform content_engine.log(who, 'job_failed', null, null, p_run, jsonb_build_object('error', left(p_error, 2000))); end if;
  return jsonb_build_object('ok', true);
end $$;

-- what the job should draft next: open opportunities at or above the
-- priority floor, not expired, without a live article for the publisher
create or replace function public.content_engine_job_targets(p_publisher uuid default null, p_limit int default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare s content_engine.settings;
begin
  perform content_engine.require_actor();
  select * into s from content_engine.settings where id = 1;
  return coalesce((select jsonb_agg(to_jsonb(o) order by o.priority desc) from (
    select o.* from content_engine.opportunities o
     where o.status in ('new', 'shortlisted') and o.priority >= s.min_priority
       and (o.expires_at is null or o.expires_at > now())
       and not exists (select 1 from content_engine.articles a where a.opportunity_id = o.id and a.status <> 'archived'
                         and a.publisher_id is not distinct from p_publisher)
     order by o.priority desc limit greatest(0, least(coalesce(p_limit, s.drafts_per_run), 10))) o), '[]'::jsonb);
end $$;

-- =============================================================================
-- 6. THE FIRST PUBLISHER — editorial preferences only. Contacts, partnership
-- terms and the historical view benchmarks are business data: the owner enters
-- them in the Content Engine page (Publishers), never in this public file.
-- =============================================================================
insert into content_engine.publishers (slug, name, website, status, utm_source, editorial, distribution, approval)
values ('stadium-rant', 'Stadium Rant', 'https://www.stadiumrant.com', 'active', 'stadiumrant',
  jsonb_build_object(
    'preferred_sports', jsonb_build_array('cfb', 'nfl'),
    'categories', jsonb_build_array('weekly_preview', 'upset_watch', 'conference_race', 'injury_impact', 'trending_story', 'market_discrepancy'),
    'prefer_broad', true,
    'tone', 'Accessible, energetic sports-fan voice; explain every number in plain words; no betting jargon without a one-line explanation.',
    'audience', 'General college football and NFL fans, beyond experienced bettors',
    'length', jsonb_build_object('min', 900, 'max', 1500),
    'max_games', 6,
    'sections', jsonb_build_array('intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'conference', 'disagreements', 'limits', 'conclusion'),
    'seo_requirements', 'Broad, searchable headline built on a recognisable query ("Week N predictions", team names); primary keyword in the headline and first paragraph; meta description under 160 characters.',
    'links_allowed', true,
    'cadence', 'Weekly: CFB preview by Thursday, NFL preview by Friday',
    'notes', 'Prefer weekly previews and major storylines over isolated low-interest matchups. Integrate predictions naturally; keep EdgeDesk''s analysis meaningful, not promotional.'),
  jsonb_build_object('method', 'manual_email', 'notes', 'The owner sends approved articles by hand. The engine never emails a publisher.'),
  jsonb_build_object('owner_approval_required', true, 'publisher_review', true))
on conflict (slug) do nothing;
update content_engine.settings set default_publisher = 'stadium-rant' where id = 1 and default_publisher is null;

-- =============================================================================
-- 7. WHO MAY CALL WHICH DOOR
-- =============================================================================
do $grants$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'content\_engine\_%' loop
    execute format('revoke all on function %s from public', f);
    begin execute format('revoke all on function %s from anon, authenticated, service_role', f); exception when undefined_object then null; end;
    -- doors the weekly job uses: owner or service role (each checks which)
    if f::text ~ '^content_engine_(opportunity_upsert|article_create|article_save|article_submit|article\(|spend|log|search_evidence|job_)' then
      begin execute format('grant execute on function %s to authenticated, service_role', f); exception when undefined_object then null; end;
    else
      begin execute format('grant execute on function %s to authenticated', f); exception when undefined_object then null; end;
    end if;
  end loop;
end
$grants$;
revoke all on all functions in schema content_engine from public;
do $r$ begin
  execute 'revoke all on all functions in schema content_engine from anon, authenticated, service_role';
exception when undefined_object then null; end $r$;

notify pgrst, 'reload schema';

-- =============================================================================
-- REPORT: every row should say ok.
-- =============================================================================
select check_name, case when passed then 'ok' else 'CHECK THIS' end as result, detail from (
  select 'schema is not served (no client USAGE)' as check_name,
         not has_schema_privilege('anon', 'content_engine', 'usage') and not has_schema_privilege('authenticated', 'content_engine', 'usage') as passed,
         'content_engine is reachable only through public.content_engine_* doors' as detail
  union all
  select 'row level security on every table',
         (select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'content_engine'::regnamespace and c.relkind = 'r'),
         (select count(*)::text || ' tables' from pg_class c where c.relnamespace = 'content_engine'::regnamespace and c.relkind = 'r')
  union all
  select 'no door is callable by anon',
         not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'content\_engine\_%'
                      and has_function_privilege('anon', p.oid, 'execute')),
         (select count(*)::text || ' doors' from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'content\_engine\_%')
  union all
  select 'approve and send doors are owner-only (no service role)',
         not has_function_privilege('service_role', 'public.content_engine_article_approve(uuid, text)', 'execute')
         and not has_function_privilege('service_role', 'public.content_engine_article_transition(uuid, text, jsonb)', 'execute'),
         'the weekly job can draft and queue, never approve, send or publish'
  union all
  select 'article guard installed',
         exists (select 1 from pg_trigger where tgname = 'articles_guard' and tgrelid = 'content_engine.articles'::regclass),
         'approval by an owner for the exact content hash; edits after approval return to review; sent content frozen'
  union all
  select 'append-only logs installed',
         (select count(*) from pg_trigger where tgname like '%\_append\_only' and tgrelid::regclass::text like 'content_engine.%') = 5,
         'revisions, deliveries, performance, events, benchmarks'
  union all
  select 'owner list available',
         to_regprocedure('growth_outbound.owner_active(uuid)') is not null,
         (select count(*)::text || ' outbound owner(s)' from growth_outbound.owners)
  union all
  select 'first publisher seeded (editorial only)',
         exists (select 1 from content_engine.publishers where slug = 'stadium-rant'),
         'contacts and benchmarks are entered by the owner in /admin/content/'
  union all
  select 'first-party measurement tables',
         to_regclass('public.acquisition_visitors') is not null and to_regclass('public.user_acquisition') is not null,
         'without growth.sql the conversion figures read "not measured"'
) r;

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
--   · `sent` exists only with a delivery row: one the owner recorded after
--     sending by hand, or the record of an email the OWNER sent from the page
--     (Send to publisher). Nothing is ever emailed on a schedule or by the job:
--     the send doors need an owner's auth.uid(), go only to a contact on the
--     article's publisher (or, as a test, to the owner's own address), only
--     for the approved content hash, and are claimed here before the provider
--     is called, so a retry can never send twice.
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
  kind            text not null check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story', 'weekend_storylines', 'game_deep_dive', 'model_performance')),
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
  format             text not null check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'publisher_custom', 'weekend_storylines', 'game_deep_dive', 'conference_race', 'upset_watch', 'model_performance_review')),
  angle              text not null default 'full_slate' check (angle ~ '^[a-z_]{3,30}$'),
  status             text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'rejected', 'archived')),
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
  method        text not null check (method in ('manual_email', 'email', 'cms_upload', 'shared_document', 'other')),
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
    -- a draft whose own editorial review is REJECT (content_engine_article_auto_reject)
    ('draft', 'rejected'),
    ('in_review', 'draft'), ('in_review', 'approved'), ('in_review', 'rejected'), ('in_review', 'archived'),
    ('rejected', 'draft'), ('rejected', 'archived'),
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
      -- docs/system-integrity: the integrity engine's verdict on THIS content,
      -- saved with it; an absent verdict is BLOCKED, never PASS
      if not content_engine.integrity_ok(new.checks) then raise exception 'the integrity engine blocks this content: %', coalesce(new.checks -> 'integrity' -> 'blocking', '[]'::jsonb) using errcode = 'check_violation'; end if;
      new.approved_research_hash := new.research_hash;
    end if;
    if new.status = 'ready_to_send' and (new.approved_hash is distinct from new.content_hash or new.approved_by is null) then
      raise exception 'only approved, unchanged content is ready to send' using errcode = 'check_violation';
    end if;
    if new.status in ('ready_to_send', 'sent') then
      if not content_engine.integrity_ok(new.checks) then raise exception 'the integrity engine blocks this content' using errcode = 'check_violation'; end if;
      if not content_engine.research_current(new.opportunity_id, new.research_hash, new.approved_research_hash) then
        raise exception 'the research changed after approval: the article goes back to review' using errcode = 'check_violation';
      end if;
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
    if new.status in ('draft', 'in_review', 'rejected') then
      new.approved_at := null; new.approved_by := null; new.approved_hash := null; new.ready_at := null; new.approved_research_hash := null;
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
    'sender', content_engine.sender(),
    'problems', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (select * from content_engine.events
        where kind in ('generation_failed', 'validation_failed', 'ai_discarded', 'fetch_failed', 'job_failed', 'send_failed') order by at desc limit 12) e), '[]'::jsonb));
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
  -- docs/system-integrity: research that changed under an approved article
  -- revokes the approval; the article goes back to review with the reason
  if old_hash is not null and old_hash is distinct from r.research_hash then
    perform content_engine.revoke_for_research(r.id, old_hash, r.research_hash, who, p_run);
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'created', created, 'research_changed', old_hash is not null and old_hash is distinct from r.research_hash, 'status', r.status,
    'revoked', coalesce((select count(*) from content_engine.events e where e.kind = 'approval_revoked' and e.opportunity_id = r.id and e.at >= now() - interval '1 second'), 0));
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
  if not content_engine.integrity_ok(a.checks) then return jsonb_build_object('ok', false, 'reason', 'integrity_blocked', 'blocking', coalesce(a.checks -> 'integrity' -> 'blocking', '[]'::jsonb)); end if;
  if not content_engine.research_current(a.opportunity_id, a.research_hash, null) then return jsonb_build_object('ok', false, 'reason', 'research_changed', 'detail', 'the research changed since this draft was written: refresh it before approving'); end if;
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
  if p_to in ('ready_to_send', 'sent') then
    if not content_engine.integrity_ok(a.checks) then return jsonb_build_object('ok', false, 'reason', 'integrity_blocked', 'blocking', coalesce(a.checks -> 'integrity' -> 'blocking', '[]'::jsonb)); end if;
    if not content_engine.research_current(a.opportunity_id, a.research_hash, a.approved_research_hash) then
      return jsonb_build_object('ok', false, 'reason', 'research_changed', 'detail', 'the research changed after approval: the article must be reviewed again');
    end if;
  end if;
  if p_to = 'rejected' and coalesce(btrim(p ->> 'reason'), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'reason_required', 'detail', 'say why the draft is rejected');
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
declare a content_engine.articles; who text;
begin
  who := content_engine.require_actor();
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
    'sends', case when who = 'owner' then coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'recipient', x.recipient, 'recipient_name', x.recipient_name,
                    'is_test', x.is_test, 'subject', x.subject, 'status', x.status, 'error', x.error, 'claimed_at', x.claimed_at, 'finished_at', x.finished_at) order by x.id)
                  from content_engine.sends x where x.article_id = a.id), '[]'::jsonb) else '[]'::jsonb end,
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
-- 6b. SEND TO PUBLISHER — only when the owner presses Send
--
-- The Edge Function asks content_engine_send_claim (as the owner) for one
-- send: the database checks the article is approved and ready, the content is
-- the approved hash the owner is looking at, and the recipient is a contact on
-- that publisher's profile (or, for a test, the owner's own address). It
-- writes the send FIRST, with one idempotency key, and only then does the
-- function call Resend with that key. content_engine_send_result records what
-- happened: a delivery row and `sent`, or the failure. An unanswered claim is
-- answered with the same key for 23 hours (a retry cannot send twice), then
-- marked failed.
-- =============================================================================
alter table content_engine.settings add column if not exists sender_name text;
alter table content_engine.settings add column if not exists sender_email text;
alter table content_engine.settings add column if not exists reply_to_email text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_sender_shape' and conrelid = 'content_engine.settings'::regclass) then
    alter table content_engine.settings add constraint settings_sender_shape check (
          (sender_name is null or (length(btrim(sender_name)) between 1 and 60 and sender_name !~ '[<>@\r\n]'))
      and (sender_email is null or sender_email ~ '^[a-z0-9._%+-]+@edgedesksports\.com$')
      and (reply_to_email is null or reply_to_email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'));
  end if;
end $c$;

-- an install from before Send: widen the delivery methods in place
do $c$
declare n text;
begin
  select c.conname into n from pg_constraint c
   where c.conrelid = 'content_engine.deliveries'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%manual_email%'
     and position('''email''' in pg_get_constraintdef(c.oid)) = 0;
  if n is not null then
    execute format('alter table content_engine.deliveries drop constraint %I', n);
    alter table content_engine.deliveries add constraint deliveries_method_check
      check (method in ('manual_email', 'email', 'cms_upload', 'shared_document', 'other'));
  end if;
end $c$;

create table if not exists content_engine.sends (
  id               bigint generated always as identity primary key,
  article_id       uuid not null references content_engine.articles(id),
  publisher_id     uuid references content_engine.publishers(id),
  recipient        text not null check (recipient ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' and length(recipient) <= 254),
  recipient_name   text check (recipient_name is null or length(recipient_name) <= 120),
  is_test          boolean not null default false,
  sender           text not null,
  reply_to         text not null,
  subject          text not null check (length(btrim(subject)) between 3 and 150 and subject !~ '[\r\n]'),
  note             text check (note is null or length(note) <= 4000),
  content_hash     text not null,
  idempotency_key  text not null unique,
  status           text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  provider_id      text unique,
  error            text,
  claimed_by       uuid not null,
  claimed_at       timestamptz not null default now(),
  finished_at      timestamptz
);
-- one real send of an article to one person (a failed one may be tried again)
create unique index if not exists sends_once on content_engine.sends (article_id, lower(recipient))
  where not is_test and status in ('claimed', 'sent');
alter table content_engine.sends enable row level security;
revoke all on content_engine.sends from public;
do $r$ begin
  execute 'revoke all on content_engine.sends from anon, authenticated, service_role';
exception when undefined_object then null; end $r$;

-- a send is a record: only its outcome is ever written, once
create or replace function content_engine.sends_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'sends are never deleted' using errcode = 'check_violation'; end if;
  if old.status <> 'claimed' then raise exception 'a finished send does not change' using errcode = 'check_violation'; end if;
  if (new.article_id, new.publisher_id, new.recipient, new.is_test, new.sender, new.reply_to, new.subject, new.content_hash,
      new.idempotency_key, new.claimed_by, new.claimed_at)
     is distinct from (old.article_id, old.publisher_id, old.recipient, old.is_test, old.sender, old.reply_to, old.subject, old.content_hash,
      old.idempotency_key, old.claimed_by, old.claimed_at) then
    raise exception 'only the outcome of a send is written' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists sends_guard on content_engine.sends;
create trigger sends_guard before update or delete on content_engine.sends for each row execute function content_engine.sends_guard();
drop trigger if exists sends_no_truncate on content_engine.sends;
create trigger sends_no_truncate before truncate on content_engine.sends for each statement execute function content_engine.append_only();

-- who the email is from: this engine's own sender if set, else the outbound
-- engine's (already a verified edgedesksports.com sender on Resend)
create or replace function content_engine.sender()
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare s content_engine.settings; n text; e text; r text; on_ text; oe text; orr text;
begin
  select * into s from content_engine.settings where id = 1;
  n := s.sender_name; e := s.sender_email; r := s.reply_to_email;
  if (n is null or e is null or r is null) and to_regclass('growth_outbound.settings') is not null then
    execute 'select sender_name, sender_email, coalesce(reply_to_email, sender_email) from growth_outbound.settings order by id limit 1' into on_, oe, orr;
    n := coalesce(n, on_); e := coalesce(e, oe); r := coalesce(r, orr);
  end if;
  if n is null or e is null or e !~ '^[a-z0-9._%+-]+@edgedesksports\.com$' then return null; end if;
  return jsonb_build_object('from', n || ' <' || e || '>', 'reply_to', coalesce(r, e), 'name', n, 'email', e);
end $$;

drop function if exists public.content_engine_send_claim(uuid, text, text, text, boolean);
create or replace function public.content_engine_send_claim(p_id uuid, p_recipient text, p_subject text, p_content_hash text, p_test boolean default false, p_note text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); a content_engine.articles; pb content_engine.publishers; prev content_engine.sends;
  rcpt text := lower(btrim(coalesce(p_recipient, ''))); nm text; me text; snd jsonb; sid bigint; k text; subj text; is_t boolean := coalesce(p_test, false);
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_content_hash is distinct from a.content_hash then return jsonb_build_object('ok', false, 'reason', 'changed_since_loaded'); end if;
  if not a.checks_ok then return jsonb_build_object('ok', false, 'reason', 'checks_failed'); end if;
  if a.approved_by is null or a.approved_hash is distinct from a.content_hash then return jsonb_build_object('ok', false, 'reason', 'not_approved'); end if;
  if not content_engine.integrity_ok(a.checks) then return jsonb_build_object('ok', false, 'reason', 'integrity_blocked', 'blocking', a.checks -> 'integrity' -> 'blocking'); end if;
  if not content_engine.research_current(a.opportunity_id, a.research_hash, a.approved_research_hash) then return jsonb_build_object('ok', false, 'reason', 'research_changed'); end if;
  subj := btrim(coalesce(nullif(btrim(p_subject), ''), 'EdgeDesk: ' || a.title));
  if length(subj) > 150 or subj ~ '[\r\n]' or length(subj) < 3 then return jsonb_build_object('ok', false, 'reason', 'bad_subject'); end if;
  if is_t then
    if a.status not in ('approved', 'ready_to_send') then return jsonb_build_object('ok', false, 'reason', 'not_approved'); end if;
    select lower(btrim(u.email)) into me from auth.users u where u.id = v;
    if me is null or rcpt <> me then
      return jsonb_build_object('ok', false, 'reason', 'test_goes_to_you', 'detail', 'a test goes only to your own sign-in address');
    end if;
    if (select count(*) from content_engine.sends where is_test and claimed_by = v and claimed_at > now() - interval '1 hour') >= 10 then
      return jsonb_build_object('ok', false, 'reason', 'too_many_tests');
    end if;
    nm := null;
  else
    if a.status <> 'ready_to_send' then return jsonb_build_object('ok', false, 'reason', 'not_ready', 'status', a.status); end if;
    select * into pb from content_engine.publishers where id = a.publisher_id;
    if pb.id is null then return jsonb_build_object('ok', false, 'reason', 'no_publisher'); end if;
    if pb.status in ('paused', 'ended') then return jsonb_build_object('ok', false, 'reason', 'publisher_inactive'); end if;
    select left(btrim(c ->> 'name'), 120) into nm from jsonb_array_elements(pb.contacts) c where lower(btrim(c ->> 'email')) = rcpt limit 1;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_a_contact', 'detail', 'add this address to the publisher''s contacts first');
    end if;
    select * into prev from content_engine.sends
     where article_id = a.id and lower(recipient) = rcpt and not is_test and status in ('claimed', 'sent') order by id desc limit 1;
    if prev.id is not null then
      if prev.status = 'sent' then return jsonb_build_object('ok', true, 'already', true, 'state', 'sent', 'send_id', prev.id); end if;
      if prev.claimed_at > now() - interval '23 hours' then
        -- unanswered: the same key and the same message, so Resend cannot send it twice
        return jsonb_build_object('ok', true, 'retry', true, 'send_id', prev.id, 'idempotency_key', prev.idempotency_key, 'test', false,
          'message', jsonb_build_object('from', prev.sender, 'to', prev.recipient, 'reply_to', prev.reply_to, 'subject', prev.subject, 'note', prev.note),
          'recipient_name', prev.recipient_name);
      end if;
      update content_engine.sends set status = 'failed', error = 'outcome unknown after 23 hours', finished_at = now() where id = prev.id;
    end if;
  end if;
  snd := content_engine.sender();
  if snd is null then return jsonb_build_object('ok', false, 'reason', 'no_sender', 'detail', 'set an edgedesksports.com sender in Settings'); end if;
  k := 'edgedesk-content-' || replace(gen_random_uuid()::text, '-', '');
  insert into content_engine.sends (article_id, publisher_id, recipient, recipient_name, is_test, sender, reply_to, subject, note, content_hash, idempotency_key, claimed_by)
  values (a.id, a.publisher_id, rcpt, nm, is_t, snd ->> 'from', snd ->> 'reply_to', subj, nullif(btrim(coalesce(p_note, '')), ''), a.content_hash, k, v)
  returning id into sid;
  perform content_engine.log('owner', case when is_t then 'test_send_claimed' else 'send_claimed' end, a.id, a.opportunity_id, null,
    jsonb_build_object('send_id', sid, 'to', rcpt));
  return jsonb_build_object('ok', true, 'send_id', sid, 'idempotency_key', k, 'test', is_t, 'recipient_name', nm,
    'message', jsonb_build_object('from', snd ->> 'from', 'to', rcpt, 'reply_to', snd ->> 'reply_to', 'subject', subj, 'note', nullif(btrim(coalesce(p_note, '')), '')));
exception when check_violation or unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

create or replace function public.content_engine_send_result(p_send_id bigint, p_provider_id text, p_error text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); s content_engine.sends; a content_engine.articles;
begin
  select * into s from content_engine.sends where id = p_send_id for update;
  if s.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if s.status <> 'claimed' then return jsonb_build_object('ok', true, 'already', true, 'state', s.status); end if;
  if nullif(btrim(coalesce(p_provider_id, '')), '') is not null and p_error is null then
    update content_engine.sends set status = 'sent', provider_id = left(btrim(p_provider_id), 200), finished_at = now() where id = s.id;
    if not s.is_test then
      insert into content_engine.deliveries (article_id, publisher_id, method, note, content_hash, recorded_by)
      values (s.article_id, s.publisher_id, 'email',
              left('emailed from EdgeDesk to ' || coalesce(s.recipient_name || ' ', '') || '<' || s.recipient || '>: ' || s.subject, 500), s.content_hash, v);
      select * into a from content_engine.articles where id = s.article_id for update;
      if a.status = 'ready_to_send' and a.content_hash = s.content_hash then
        perform set_config('content_engine.door', 'mark_sent', true);
        update content_engine.articles set status = 'sent' where id = a.id;
        perform set_config('content_engine.door', '', true);
      end if;
    end if;
    perform content_engine.log('owner', case when s.is_test then 'test_emailed' else 'article_emailed' end, s.article_id, null, null,
      jsonb_build_object('send_id', s.id, 'to', s.recipient, 'provider_id', left(p_provider_id, 200)));
    return jsonb_build_object('ok', true, 'state', 'sent', 'test', s.is_test,
      'status', (select status from content_engine.articles where id = s.article_id));
  end if;
  update content_engine.sends set status = 'failed', error = left(coalesce(p_error, 'no provider id'), 500), finished_at = now() where id = s.id;
  perform content_engine.log('owner', 'send_failed', s.article_id, null, null, jsonb_build_object('send_id', s.id, 'error', left(p_error, 300)));
  return jsonb_build_object('ok', true, 'state', 'failed');
end $$;

create or replace function public.content_engine_sender_save(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner();
begin
  update content_engine.settings set
    sender_name = case when p ? 'sender_name' then nullif(btrim(p ->> 'sender_name'), '') else sender_name end,
    sender_email = case when p ? 'sender_email' then nullif(lower(btrim(p ->> 'sender_email')), '') else sender_email end,
    reply_to_email = case when p ? 'reply_to_email' then nullif(lower(btrim(p ->> 'reply_to_email')), '') else reply_to_email end,
    updated_at = now(), updated_by = v
  where id = 1;
  return jsonb_build_object('ok', true, 'sender', content_engine.sender());
exception when check_violation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'the sender must be an edgedesksports.com address; the reply-to one email address');
end $$;

-- =============================================================================
-- 6c. INTEGRITY, AI BUDGET AND ACQUISITION (docs/system-integrity)
--
-- INTEGRITY. lib/content_engine.js validate() runs the integrity engine
-- (lib/edgedesk_integrity.js) and saves its verdict IN the article's checks,
-- in the same save as the content, so the verdict always describes the text
-- it sits beside. Approval, ready-to-send and Send refuse anything but PASS or
-- WARNING; a missing verdict is BLOCKED. Approval records the research it
-- approved; research that changes afterwards revokes the approval (the article
-- returns to review, an approval_revoked event says why), and nothing reaches
-- ready-to-send or a publisher on research other than the research approved.
--
-- AI BUDGET. A dollar budget per calendar month (UTC), default $10, separate
-- from every other AI product's budget, on top of the daily call cap above.
-- content_engine_ai_reserve claims the call's ESTIMATED cost before the call,
-- under a lock on the month's row, so concurrent jobs cannot together pass the
-- cap. One request key per exact request: the same request twice is refused
-- as a duplicate (no second charge); one call in flight per article and
-- purpose; a failed call may be retried up to ai_max_attempts. Settle records
-- the tokens and the ACTUAL cost from the provider's usage; a call that used
-- tokens is charged even when its draft is discarded.
--
-- ACQUISITION. content_engine_acquisition_report: article → publisher →
-- publication → referral visit → registration → trial → paid, by month, with
-- the 90-day targets beside the actuals. Revenue is Stripe's own invoice
-- amounts; profit is not computed (no fee or cost data is held here).
-- =============================================================================
alter table content_engine.articles add column if not exists approved_research_hash text;
do $c$ begin
  alter table content_engine.articles drop constraint if exists articles_status_check;
  alter table content_engine.articles add constraint articles_status_check check (status in ('draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'rejected', 'archived'));
  alter table content_engine.articles drop constraint if exists articles_format_check;
  alter table content_engine.articles add constraint articles_format_check check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'publisher_custom', 'weekend_storylines', 'game_deep_dive', 'conference_race', 'upset_watch', 'model_performance_review'));
  alter table content_engine.opportunities drop constraint if exists opportunities_kind_check;
  alter table content_engine.opportunities add constraint opportunities_kind_check check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story', 'weekend_storylines', 'game_deep_dive', 'model_performance'));
end $c$;

create or replace function content_engine.integrity_ok(p jsonb)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(p ->> 'integrity_status', 'BLOCKED') in ('PASS', 'WARNING');
$$;

-- the article is written on the opportunity's CURRENT research, and that is
-- the research it was approved on (an approval from before this rule has none)
create or replace function content_engine.research_current(p_opportunity uuid, p_article_hash text, p_approved_hash text)
returns boolean language sql stable
set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from content_engine.opportunities o where o.id = p_opportunity and o.research_hash = p_article_hash)
     and (p_approved_hash is null or p_approved_hash = p_article_hash);
$$;

create or replace function content_engine.revoke_for_research(p_opportunity uuid, p_old text, p_new text, p_actor text, p_run bigint)
returns int language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare a record; n int := 0;
begin
  for a in select id, status from content_engine.articles
            where opportunity_id = p_opportunity and status in ('approved', 'ready_to_send') for update loop
    update content_engine.articles set status = 'in_review' where id = a.id;
    perform content_engine.log(p_actor, 'approval_revoked', a.id, p_opportunity, p_run,
      jsonb_build_object('from', a.status, 'old_research_hash', p_old, 'new_research_hash', p_new,
                         'reason', 'the research the article was approved on changed; review the new numbers before it can be sent'));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── the AI budget ────────────────────────────────────────────────────────────
alter table content_engine.settings add column if not exists monthly_budget_usd numeric(10,2) not null default 10.00;
alter table content_engine.settings add column if not exists job_budget_usd numeric(10,2) not null default 2.00;
alter table content_engine.settings add column if not exists ai_max_attempts int not null default 2;
-- THE HARD CAP: the content engine spends at most monthly_budget_usd in a
-- calendar month (UTC) — $10 by default. The owner configures it from the page
-- (content_engine_budget_update, owner only, logged); raising it above the $10
-- default needs an explicit confirmation, and $50 is the ceiling the database
-- itself enforces. Other AI products' budgets live elsewhere and are untouched.
do $c$ begin
  alter table content_engine.settings drop constraint if exists settings_ai_budget_shape;
  alter table content_engine.settings add constraint settings_ai_budget_shape check (
    monthly_budget_usd between 0 and 50 and job_budget_usd between 0 and 50 and job_budget_usd <= monthly_budget_usd and ai_max_attempts between 1 and 5);
end $c$;

create table if not exists content_engine.ai_months (
  month          date primary key,
  committed_usd  numeric(12,6) not null default 0 check (committed_usd >= 0),
  reserved_usd   numeric(12,6) not null default 0 check (reserved_usd >= 0),
  updated_at     timestamptz not null default now()
);
create table if not exists content_engine.ai_spend (
  id                 bigint generated always as identity primary key,
  request_key        text not null unique check (request_key ~ '^[a-f0-9]{16,64}$'),
  month              date not null,
  purpose            text not null check (purpose in ('rewrite', 'section', 'draft', 'other')),
  article_id         uuid references content_engine.articles(id),
  run_id             bigint,
  model              text check (model is null or length(model) <= 80),
  actor              text not null check (actor in ('owner', 'schedule')),
  status             text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
  estimated_usd      numeric(12,6) not null check (estimated_usd > 0 and estimated_usd <= 5),
  attempts           int not null default 1 check (attempts between 1 and 10),
  input_tokens       int check (input_tokens is null or input_tokens >= 0),
  output_tokens      int check (output_tokens is null or output_tokens >= 0),
  cache_read_tokens  int check (cache_read_tokens is null or cache_read_tokens >= 0),
  cache_write_tokens int check (cache_write_tokens is null or cache_write_tokens >= 0),
  actual_usd         numeric(12,6) check (actual_usd is null or actual_usd >= 0),
  billing_source     text not null default 'estimate' check (billing_source in ('estimate', 'usage_tokens', 'provider_invoice')),
  error              text check (error is null or length(error) <= 300),
  created_at         timestamptz not null default now(),
  settled_at         timestamptz
);
-- one call in flight per article and purpose: two concurrent drafts of the
-- same article cannot both be paid for
create unique index if not exists ai_spend_one_in_flight on content_engine.ai_spend (article_id, purpose)
  where status = 'reserved' and article_id is not null;
create index if not exists ai_spend_month on content_engine.ai_spend (month, status);
alter table content_engine.ai_months enable row level security;
alter table content_engine.ai_spend enable row level security;
revoke all on content_engine.ai_months, content_engine.ai_spend from public;
do $r$ begin
  execute 'revoke all on content_engine.ai_months, content_engine.ai_spend from anon, authenticated, service_role';
exception when undefined_object then null; end $r$;

create or replace function content_engine.ai_month_now()
returns date language sql stable
set search_path = pg_catalog, pg_temp as $$ select date_trunc('month', now() at time zone 'utc')::date; $$;

-- a reservation older than 30 minutes was abandoned (the caller died after the
-- reservation, perhaps after the provider had already billed the call): it is
-- CHARGED AT ITS ESTIMATE, which is an upper bound, never released — releasing
-- it could let money already spent go uncounted and the month pass its cap
create or replace function content_engine.ai_sweep(p_month date)
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare r record;
begin
  for r in select id, estimated_usd from content_engine.ai_spend
            where month = p_month and status = 'reserved' and created_at < now() - interval '30 minutes' for update skip locked loop
    update content_engine.ai_spend set status = 'committed', actual_usd = r.estimated_usd, billing_source = 'estimate', settled_at = now(),
           error = 'abandoned: no settlement within 30 minutes; charged at the estimate' where id = r.id;
    update content_engine.ai_months set reserved_usd = greatest(0, reserved_usd - r.estimated_usd), committed_usd = committed_usd + r.estimated_usd, updated_at = now() where month = p_month;
  end loop;
end $$;

create or replace function public.content_engine_ai_reserve(p_request_key text, p_estimated_usd numeric, p_purpose text default 'rewrite',
                                                           p_article uuid default null, p_model text default null, p_run bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); st content_engine.settings; m date := content_engine.ai_month_now();
  mo content_engine.ai_months; ex content_engine.ai_spend; run_used numeric; est numeric := round(coalesce(p_estimated_usd, 0), 6);
begin
  if coalesce(p_request_key, '') !~ '^[a-f0-9]{16,64}$' or est <= 0 or est > 5 or coalesce(p_purpose, '') not in ('rewrite', 'section', 'draft', 'other') then
    return jsonb_build_object('ok', false, 'reason', 'bad_input');
  end if;
  select * into st from content_engine.settings where id = 1;
  insert into content_engine.ai_months (month) values (m) on conflict do nothing;
  -- THE LOCK: every reservation this month waits here, so the cap is checked
  -- against every other reservation, committed or in flight
  select * into mo from content_engine.ai_months where month = m for update;
  perform content_engine.ai_sweep(m);
  select * into mo from content_engine.ai_months where month = m;
  select * into ex from content_engine.ai_spend where request_key = p_request_key for update;
  if ex.id is not null then
    if ex.status = 'committed' then
      perform content_engine.log(who, 'ai_duplicate_refused', ex.article_id, null, p_run, jsonb_build_object('request_key', p_request_key));
      return jsonb_build_object('ok', false, 'reason', 'duplicate', 'detail', 'this exact request was already made and paid for; its result is the one on file', 'spend_id', ex.id);
    end if;
    if ex.status = 'reserved' then return jsonb_build_object('ok', false, 'reason', 'in_flight'); end if;
    if ex.attempts >= st.ai_max_attempts then
      perform content_engine.log(who, 'ai_retry_limit', ex.article_id, null, p_run, jsonb_build_object('request_key', p_request_key, 'attempts', ex.attempts));
      return jsonb_build_object('ok', false, 'reason', 'retry_limit', 'attempts', ex.attempts, 'max', st.ai_max_attempts);
    end if;
  end if;
  if mo.committed_usd + mo.reserved_usd + est > st.monthly_budget_usd then
    perform content_engine.log(who, 'budget_exhausted', p_article, null, p_run,
      jsonb_build_object('provider', 'llm', 'scope', 'month', 'cap_usd', st.monthly_budget_usd, 'committed_usd', mo.committed_usd, 'reserved_usd', mo.reserved_usd, 'estimate_usd', est));
    return jsonb_build_object('ok', false, 'reason', 'monthly_budget_exhausted', 'cap_usd', st.monthly_budget_usd,
      'used_usd', round(mo.committed_usd + mo.reserved_usd, 4), 'detail', 'discretionary AI generation stops at the monthly cap; the deterministic draft still works');
  end if;
  if p_run is not null then
    select coalesce(sum(coalesce(actual_usd, estimated_usd)), 0) into run_used from content_engine.ai_spend where run_id = p_run and status in ('reserved', 'committed');
    if run_used + est > st.job_budget_usd then
      return jsonb_build_object('ok', false, 'reason', 'job_budget_exhausted', 'cap_usd', st.job_budget_usd, 'used_usd', round(run_used, 4));
    end if;
  end if;
  if ex.id is not null then
    update content_engine.ai_spend set status = 'reserved', attempts = attempts + 1, estimated_usd = est, settled_at = null, error = null,
           created_at = now() where id = ex.id;
  else
    insert into content_engine.ai_spend (request_key, month, purpose, article_id, run_id, model, actor, estimated_usd)
    values (p_request_key, m, p_purpose, p_article, p_run, left(p_model, 80), who, est);
  end if;
  update content_engine.ai_months set reserved_usd = reserved_usd + est, updated_at = now() where month = m;
  return jsonb_build_object('ok', true, 'request_key', p_request_key, 'month', m, 'cap_usd', st.monthly_budget_usd,
    'committed_usd', round(mo.committed_usd, 4), 'reserved_usd', round(mo.reserved_usd + est, 4),
    'remaining_usd', round(st.monthly_budget_usd - mo.committed_usd - mo.reserved_usd - est, 4));
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'in_flight', 'detail', 'another call for this article and purpose is already running');
end $$;

create or replace function public.content_engine_ai_settle(p_request_key text, p_ok boolean, p_input_tokens int default null, p_output_tokens int default null,
                                                          p_actual_usd numeric default null, p_error text default null,
                                                          p_cache_read_tokens int default null, p_cache_write_tokens int default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); ex content_engine.ai_spend; cost numeric; used_tokens boolean;
begin
  select * into ex from content_engine.ai_spend where request_key = p_request_key for update;
  if ex.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if ex.status <> 'reserved' then return jsonb_build_object('ok', false, 'reason', 'not_reserved', 'status', ex.status); end if;
  perform 1 from content_engine.ai_months where month = ex.month for update;
  used_tokens := coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0) > 0;
  if coalesce(p_ok, false) or used_tokens then
    cost := round(coalesce(p_actual_usd, ex.estimated_usd), 6);
    update content_engine.ai_spend set status = 'committed', input_tokens = p_input_tokens, output_tokens = p_output_tokens,
           cache_read_tokens = p_cache_read_tokens, cache_write_tokens = p_cache_write_tokens, actual_usd = cost,
           billing_source = case when p_actual_usd is not null then 'usage_tokens' else 'estimate' end,
           settled_at = now(), error = left(p_error, 300) where id = ex.id;
    update content_engine.ai_months set reserved_usd = greatest(0, reserved_usd - ex.estimated_usd), committed_usd = committed_usd + cost, updated_at = now() where month = ex.month;
    -- the estimate is meant to be an upper bound; a call that cost more is
    -- still counted in full (the truth), and flagged so the estimator is fixed
    if cost > ex.estimated_usd then
      perform content_engine.log(who, 'ai_estimate_exceeded', ex.article_id, null, ex.run_id, jsonb_build_object('request_key', p_request_key, 'estimated_usd', ex.estimated_usd, 'actual_usd', cost));
    end if;
    return jsonb_build_object('ok', true, 'status', 'committed', 'actual_usd', cost);
  end if;
  update content_engine.ai_spend set status = 'released', settled_at = now(), error = left(coalesce(p_error, 'failed before any token was used'), 300) where id = ex.id;
  update content_engine.ai_months set reserved_usd = greatest(0, reserved_usd - ex.estimated_usd), updated_at = now() where month = ex.month;
  return jsonb_build_object('ok', true, 'status', 'released');
end $$;

-- the cost dashboard (owner only)
create or replace function public.content_engine_cost_report()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare st content_engine.settings; m date := content_engine.ai_month_now(); mo content_engine.ai_months;
begin
  perform content_engine.require_owner();
  select * into st from content_engine.settings where id = 1;
  select * into mo from content_engine.ai_months where month = m;
  return jsonb_build_object(
    'month', m, 'cap_usd', st.monthly_budget_usd, 'job_cap_usd', st.job_budget_usd, 'max_attempts', st.ai_max_attempts,
    'committed_usd', round(coalesce(mo.committed_usd, 0), 4), 'reserved_usd', round(coalesce(mo.reserved_usd, 0), 4),
    'remaining_usd', round(st.monthly_budget_usd - coalesce(mo.committed_usd, 0) - coalesce(mo.reserved_usd, 0), 4),
    'basis', 'actual_usd is computed from the provider''s reported token usage at the published per-token price; estimates are used only until a call settles. Provider invoices are not imported.',
    'this_month', (select jsonb_build_object('calls', count(*) filter (where status = 'committed'), 'released', count(*) filter (where status = 'released'),
        'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0),
        'by_purpose', coalesce((select jsonb_object_agg(purpose, usd) from (select purpose, round(sum(actual_usd), 4) as usd from content_engine.ai_spend
            where month = m and status = 'committed' group by purpose) q), '{}'::jsonb))
      from content_engine.ai_spend where month = m),
    'refused', (select jsonb_build_object('duplicates', count(*) filter (where kind = 'ai_duplicate_refused'), 'budget', count(*) filter (where kind = 'budget_exhausted'),
        'retry_limit', count(*) filter (where kind = 'ai_retry_limit'))
      from content_engine.events where at >= m::timestamptz),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'committed_usd', round(committed_usd, 4)) order by month desc)
      from (select * from content_engine.ai_months order by month desc limit 6) z), '[]'::jsonb),
    'top_articles', coalesce((select jsonb_agg(x) from (select jsonb_build_object('article_id', s.article_id, 'title', a.title, 'usd', round(sum(s.actual_usd), 4), 'calls', count(*)) as x
        from content_engine.ai_spend s left join content_engine.articles a on a.id = s.article_id
       where s.month = m and s.status = 'committed' group by s.article_id, a.title order by sum(s.actual_usd) desc limit 20) q), '[]'::jsonb));
end $$;

create or replace function public.content_engine_budget_update(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); old_cap numeric;
begin
  select monthly_budget_usd into old_cap from content_engine.settings where id = 1;
  -- above the $10 default only on purpose: the page asks, and says so here
  if (p ->> 'monthly_budget_usd') is not null and (p ->> 'monthly_budget_usd')::numeric > 10
     and (p ->> 'monthly_budget_usd')::numeric > coalesce(old_cap, 10) and coalesce((p ->> 'confirm_raise')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'confirm_raise', 'detail', 'raising the content engine’s monthly AI budget above the $10 default needs an explicit confirmation');
  end if;
  update content_engine.settings set
    monthly_budget_usd = coalesce((p ->> 'monthly_budget_usd')::numeric, monthly_budget_usd),
    job_budget_usd = coalesce((p ->> 'job_budget_usd')::numeric, job_budget_usd),
    ai_max_attempts = coalesce((p ->> 'ai_max_attempts')::int, ai_max_attempts),
    updated_at = now(), updated_by = v where id = 1;
  perform content_engine.log('owner', 'budget_updated', null, null, null, p || jsonb_build_object('previous_monthly_budget_usd', old_cap));
  return jsonb_build_object('ok', true);
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'the monthly budget is 0–50 USD (the database ceiling); the job budget is not above the monthly one; attempts 1–5');
end $$;

-- ── the customer-acquisition loop ────────────────────────────────────────────
create or replace function public.content_engine_acquisition_report(p_months int default 3)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare n int := greatest(1, least(coalesce(p_months, 3), 12)); months jsonb := '[]'::jsonb; i int; m0 date; m1 date;
  pubs int; published int; visits int; regs int; trials int; paid int; rev numeric; cost numeric; users uuid[];
  has_v boolean := to_regclass('public.acquisition_visitors') is not null; has_u boolean := to_regclass('public.user_acquisition') is not null;
  has_f boolean := to_regprocedure('public.growth_customer_facts()') is not null; has_s boolean := to_regclass('public.stripe_events') is not null;
begin
  perform content_engine.require_owner();
  for i in 0 .. n - 1 loop
    m0 := (content_engine.ai_month_now() - make_interval(months => i))::date; m1 := (m0 + interval '1 month')::date;
    select count(distinct publisher_id) filter (where publisher_id is not null), count(*) into pubs, published
      from content_engine.articles where published_at >= m0 and published_at < m1;
    visits := null; regs := null; trials := null; paid := null; rev := null; users := '{}';
    if has_v then
      execute $q$select count(*) from public.acquisition_visitors v where v.first_utm_campaign like 'ce\_%' and v.first_seen_at >= $1 and v.first_seen_at < $2
               and (v.user_id is null or not exists (select 1 from growth_outbound.owners o where o.user_id = v.user_id))$q$ into visits using m0, m1;
    end if;
    if has_u then
      execute $q$select coalesce(array_agg(u.user_id), '{}') from public.user_acquisition u where u.first_utm_campaign like 'ce\_%'
               and coalesce(u.signup_at, u.updated_at) >= $1 and coalesce(u.signup_at, u.updated_at) < $2
               and not exists (select 1 from growth_outbound.owners o where o.user_id = u.user_id)$q$ into users using m0, m1;
      regs := cardinality(users);
    end if;
    if has_u and has_f then
      execute $q$select count(*) filter (where f.trial_started_at >= $1 and f.trial_started_at < $2), count(*) filter (where f.paid_at >= $1 and f.paid_at < $2)
                 from public.growth_customer_facts() f join public.user_acquisition u on u.user_id = f.user_id
                where u.first_utm_campaign like 'ce\_%' and not exists (select 1 from growth_outbound.owners o where o.user_id = u.user_id)$q$
        into trials, paid using m0, m1;
    end if;
    if has_u and has_s then
      execute $q$select coalesce(sum(x.amount), 0) / 100.0 from (
                 select distinct on (public.affiliate_stripe_object(e.payload) ->> 'id') ((public.affiliate_stripe_object(e.payload) ->> 'amount_paid')::bigint) as amount
                   from public.stripe_events e
                   join public.subscriptions s on s.stripe_customer_id = coalesce(e.customer_id, public.affiliate_stripe_id(public.affiliate_stripe_object(e.payload) -> 'customer'))
                   join public.user_acquisition u on u.user_id = s.user_id and u.first_utm_campaign like 'ce\_%'
                  where e.type in ('invoice.payment_succeeded', 'invoice.paid') and coalesce(e.stripe_created, e.created_at) >= $1 and coalesce(e.stripe_created, e.created_at) < $2
                    and (public.affiliate_stripe_object(e.payload) ->> 'amount_paid') ~ '^[0-9]+$') x$q$ into rev using m0, m1;
    end if;
    select coalesce(sum(actual_usd), 0) into cost from content_engine.ai_spend where month = m0 and status = 'committed';
    months := months || jsonb_build_object('month', m0, 'active_partners', pubs, 'published_articles', published, 'referral_visits', visits,
      'registrations', regs, 'trials', trials, 'paid_subscribers', paid, 'subscriber_revenue_usd', rev, 'content_ai_cost_usd', round(cost, 2),
      'cost_per_paid_subscriber_usd', case when paid > 0 then round(cost / paid, 2) end);
  end loop;
  return jsonb_build_object(
    'targets', jsonb_build_object('active_partners', 3, 'published_articles_per_month', 8, 'referral_visits_per_month', 250,
      'registrations_per_month', 25, 'paid_subscribers_per_month', 3, 'max_cost_per_paid_subscriber_usd', 25,
      'kind', 'TARGETS for the first 90 days, not forecasts'),
    'months', months,
    'attribution', 'first touch: a visitor or account whose FIRST utm_campaign is a content-engine code (ce_<publisher>_<article>); owners excluded. Last-touch figures per article are in content_engine_performance.',
    'revenue', 'subscriber revenue is the amount Stripe reports as paid on invoices of attributed customers (gross, in USD). It is not profit: Stripe fees, refunds after the month and every non-AI cost are not held here, so profit is not computed.',
    'cost', 'content AI cost is the content engine''s own committed AI spend (content_engine.ai_spend). No other cost is included.',
    'measured', jsonb_build_object('visits', has_v, 'registrations', has_u, 'trials_paid', has_u and has_f, 'revenue', has_u and has_s),
    'by_publisher', coalesce((select jsonb_agg(jsonb_build_object('publisher', p.name, 'slug', p.slug, 'articles_published', (select count(*) from content_engine.articles a where a.publisher_id = p.id and a.published_at is not null),
        'first_party', (select jsonb_agg(content_engine.first_party(a.campaign_code)) from content_engine.articles a where a.publisher_id = p.id and a.status in ('sent', 'published'))))
      from content_engine.publishers p where p.status in ('active', 'prospect')), '[]'::jsonb));
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
  jsonb_build_object('method', 'manual_email', 'notes', 'The owner sends each approved article: Send in the publishing queue (only when pressed and confirmed), or by hand. Nothing is sent on its own.'),
  jsonb_build_object('owner_approval_required', true, 'publisher_review', true))
on conflict (slug) do nothing;
update content_engine.settings set default_publisher = 'stadium-rant' where id = 1 and default_publisher is null;

-- =============================================================================
-- FIVE GAMES TO WATCH (docs/content-engine/GAMES_TO_WATCH.md). Additive and
-- idempotent; nothing existing is dropped or rewritten.
--   · two formats (publisher and EdgeDesk editions) and one opportunity kind
--   · content_engine.broadcast_checks: the owner's verification of a game's
--     network, streaming and any verified schedule change, from an official
--     source with its URL — append-only; the newest row per game is current
--   · content_engine_article_auto_reject: the job rejects ITS OWN draft only
--     when that draft's stored review verdict is REJECT, with the reasons
--   · the publisher's response (accepted / declined / revisions requested),
--     recorded apart from publication
--   · content_engine_template_report: per template — generated, first-pass
--     approval, auto-rejected, publisher acceptance, external placements,
--     traffic, research-page visits, registrations, trials, paid subscribers,
--     generation cost and attributed revenue — measured, never estimated
-- =============================================================================
do $c$ begin
  alter table content_engine.articles drop constraint if exists articles_format_check;
  alter table content_engine.articles add constraint articles_format_check check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'publisher_custom', 'weekend_storylines', 'game_deep_dive', 'conference_race', 'upset_watch', 'model_performance_review', 'weekly_games_to_watch', 'weekly_games_to_watch_first_party'));
  alter table content_engine.opportunities drop constraint if exists opportunities_kind_check;
  alter table content_engine.opportunities add constraint opportunities_kind_check check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story', 'weekend_storylines', 'game_deep_dive', 'model_performance', 'games_to_watch'));
end $c$;

create table if not exists content_engine.broadcast_checks (
  id           bigint generated always as identity primary key,
  game_id      text not null check (game_id ~ '^[0-9]{6,12}$'),
  season       int not null check (season between 2020 and 2100),
  network      text check (network is null or length(btrim(network)) between 2 and 40),
  streaming    jsonb not null default '[]'::jsonb check (jsonb_typeof(streaming) = 'array' and jsonb_array_length(streaming) <= 4),
  source_url   text not null check (source_url ~ '^https://[^\s]+$' and length(source_url) <= 400),
  source_kind  text not null check (source_kind in ('conference', 'school', 'network', 'league', 'other_official')),
  source_name  text not null check (length(btrim(source_name)) between 3 and 120),
  kickoff      timestamptz,
  reason       text check (reason is null or length(reason) <= 200),
  status       text check (status is null or status in ('postponed', 'canceled')),
  note         text check (note is null or length(note) <= 500),
  verified_at  timestamptz not null default now(),
  verified_by  uuid not null,
  constraint broadcast_check_says_something check (network is not null or kickoff is not null or status is not null),
  constraint broadcast_change_has_reason check (kickoff is null or reason is not null)
);
create index if not exists broadcast_checks_game on content_engine.broadcast_checks (game_id, verified_at desc);
alter table content_engine.broadcast_checks enable row level security;
revoke all on content_engine.broadcast_checks from public;
do $r$ begin
  execute 'revoke all on content_engine.broadcast_checks from anon, authenticated, service_role';
exception when undefined_object then null; end $r$;
drop trigger if exists broadcast_checks_append_only on content_engine.broadcast_checks;
create trigger broadcast_checks_append_only before update or delete on content_engine.broadcast_checks for each row execute function content_engine.append_only();
drop trigger if exists broadcast_checks_no_truncate on content_engine.broadcast_checks;
create trigger broadcast_checks_no_truncate before truncate on content_engine.broadcast_checks for each statement execute function content_engine.append_only();

alter table content_engine.articles add column if not exists publisher_response text;
alter table content_engine.articles add column if not exists publisher_responded_at timestamptz;
alter table content_engine.articles add column if not exists publisher_response_note text;
do $c$ begin
  alter table content_engine.articles drop constraint if exists articles_publisher_response_check;
  alter table content_engine.articles add constraint articles_publisher_response_check check (publisher_response is null or publisher_response in ('accepted', 'declined', 'revisions_requested', 'no_response'));
  alter table content_engine.articles drop constraint if exists articles_publisher_response_note_check;
  alter table content_engine.articles add constraint articles_publisher_response_note_check check (publisher_response_note is null or length(publisher_response_note) <= 500);
end $c$;

-- the owner records a verification: the time is the server's, never typed
create or replace function public.content_engine_broadcast_verify(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); n bigint;
begin
  if coalesce(p ->> 'source_url', '') !~ '^https://' then return jsonb_build_object('ok', false, 'reason', 'source_url_required', 'detail', 'a verification needs the official page it came from'); end if;
  insert into content_engine.broadcast_checks (game_id, season, network, streaming, source_url, source_kind, source_name, kickoff, reason, status, note, verified_by)
  values (p ->> 'game_id', (p ->> 'season')::int, nullif(btrim(p ->> 'network'), ''), coalesce(p -> 'streaming', '[]'::jsonb), p ->> 'source_url',
          coalesce(p ->> 'source_kind', 'other_official'), p ->> 'source_name', nullif(p ->> 'kickoff', '')::timestamptz, nullif(btrim(p ->> 'reason'), ''),
          nullif(p ->> 'status', ''), left(p ->> 'note', 500), v)
  returning id into n;
  perform content_engine.log('owner', 'broadcast_verified', null, null, null, jsonb_build_object('game_id', p ->> 'game_id', 'network', p ->> 'network', 'check', n));
  return jsonb_build_object('ok', true, 'id', n);
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- the current verification per game (the newest row), for the job and the page
create or replace function public.content_engine_broadcast_checks_current(p_days int default 14)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_actor();
  return coalesce((select jsonb_agg(jsonb_build_object('game_id', c.game_id, 'season', c.season, 'network', c.network, 'streaming', c.streaming,
      'source_url', c.source_url, 'source_kind', c.source_kind, 'source_name', c.source_name, 'kickoff', c.kickoff, 'reason', c.reason,
      'status', c.status, 'verified_at', c.verified_at) order by c.game_id)
    from (select distinct on (game_id) * from content_engine.broadcast_checks
           where verified_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 60)))
           order by game_id, verified_at desc) c), '[]'::jsonb);
end $$;

-- AUTO-REJECT: only a draft, only when its own stored review says REJECT;
-- the schedule may reject only its own untouched drafts
create or replace function public.content_engine_article_auto_reject(p_id uuid, p_reasons jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); a content_engine.articles;
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status <> 'draft' then return jsonb_build_object('ok', false, 'reason', 'not_a_draft', 'status', a.status); end if;
  if coalesce(a.checks -> 'review' ->> 'verdict', '') <> 'REJECT' then
    return jsonb_build_object('ok', false, 'reason', 'not_rejected_by_review', 'detail', 'only a draft whose own editorial review says REJECT is rejected automatically');
  end if;
  if who = 'schedule' and (a.created_by <> 'schedule' or a.owner_edited) then return jsonb_build_object('ok', false, 'reason', 'owner_owned'); end if;
  update content_engine.articles set status = 'rejected' where id = p_id;
  perform content_engine.log(who, 'article_auto_rejected', p_id, a.opportunity_id, null,
    jsonb_build_object('reasons', coalesce(a.checks -> 'review' -> 'reject', '[]'::jsonb), 'reported', coalesce(p_reasons, '[]'::jsonb)));
  return jsonb_build_object('ok', true, 'status', 'rejected');
end $$;

-- the publisher's answer, apart from publication: an accepted article may
-- not run, and a published one was not necessarily accepted as sent
create or replace function public.content_engine_publisher_response(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); a content_engine.articles;
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status not in ('sent', 'published') then return jsonb_build_object('ok', false, 'reason', 'not_sent', 'detail', 'a response is recorded for an article that was sent'); end if;
  update content_engine.articles set publisher_response = p ->> 'response', publisher_response_note = left(p ->> 'note', 500),
         publisher_responded_at = coalesce(nullif(p ->> 'responded_at', '')::timestamptz, now()) where id = p_id;
  perform content_engine.log('owner', 'publisher_response', p_id, a.opportunity_id, null, jsonb_build_object('response', p ->> 'response'));
  return jsonb_build_object('ok', true);
exception when check_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- a reservation made before the article existed, tied to it once it does,
-- so a template's generation cost is the sum of its own calls
create or replace function public.content_engine_ai_attribute(p_keys jsonb, p_article uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); n int;
begin
  if jsonb_typeof(p_keys) <> 'array' or jsonb_array_length(p_keys) > 10 then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  if not exists (select 1 from content_engine.articles where id = p_article) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  update content_engine.ai_spend set article_id = p_article
   where article_id is null and status <> 'reserved' and request_key in (select jsonb_array_elements_text(p_keys));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'attributed', n);
end $$;

-- first-party measurement for one EdgeDesk page (its path): sessions that
-- viewed it, those that went on to a research page, and the accounts whose
-- first landing it was. COUNTS ONLY, owners excluded; null = not measured.
create or replace function content_engine.page_metrics(p_path text)
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare views int; research int; signups int; trials int; paid int; users uuid[];
begin
  if to_regclass('public.user_events') is not null then
    execute $q$select count(distinct coalesce(e.session_id, e.anonymous_session_id)) from public.user_events e
              where e.event_name = 'public_page_view' and e.page_path = $1$q$ into views using p_path;
    execute $q$select count(distinct coalesce(r.session_id, r.anonymous_session_id)) from public.user_events e
               join public.user_events r on coalesce(r.session_id, r.anonymous_session_id) = coalesce(e.session_id, e.anonymous_session_id)
                and r.created_at >= e.created_at and r.page_path like '/research/%'
              where e.event_name = 'public_page_view' and e.page_path = $1$q$ into research using p_path;
  end if;
  if to_regclass('public.user_acquisition') is not null then
    execute $q$select coalesce(array_agg(u.user_id), '{}') from public.user_acquisition u where u.first_landing = $1
               and not exists (select 1 from growth_outbound.owners o where o.user_id = u.user_id)$q$ into users using p_path;
    signups := cardinality(users);
    if to_regprocedure('public.growth_customer_facts()') is not null then
      execute $q$select count(*) filter (where f.trial_started_at is not null), count(*) filter (where f.paid_at is not null)
                 from public.growth_customer_facts() f where f.user_id = any ($1)$q$ into trials, paid using users;
    end if;
  end if;
  return jsonb_build_object('views', views, 'research_visits', research, 'signups', signups, 'trials', trials, 'paid', paid);
end $$;

-- Stripe-paid invoice revenue (gross USD) of the accounts a campaign code or
-- a landing path brought in; null when billing is not installed
create or replace function content_engine.attributed_revenue(p_codes text[], p_paths text[])
returns numeric language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare rev numeric;
begin
  if to_regclass('public.user_acquisition') is null or to_regclass('public.stripe_events') is null or to_regclass('public.subscriptions') is null
     or to_regprocedure('public.affiliate_stripe_object(jsonb)') is null then return null; end if;
  execute $q$select coalesce(sum(x.amount), 0) / 100.0 from (
             select distinct on (public.affiliate_stripe_object(e.payload) ->> 'id') ((public.affiliate_stripe_object(e.payload) ->> 'amount_paid')::bigint) as amount
               from public.stripe_events e
               join public.subscriptions s on s.stripe_customer_id = coalesce(e.customer_id, public.affiliate_stripe_id(public.affiliate_stripe_object(e.payload) -> 'customer'))
               join public.user_acquisition u on u.user_id = s.user_id and (u.first_utm_campaign = any ($1) or u.first_landing = any ($2))
              where e.type in ('invoice.payment_succeeded', 'invoice.paid')
                and not exists (select 1 from growth_outbound.owners o where o.user_id = u.user_id)
                and (public.affiliate_stripe_object(e.payload) ->> 'amount_paid') ~ '^[0-9]+$') x$q$ into rev using coalesce(p_codes, '{}'), coalesce(p_paths, '{}');
  return rev;
end $$;

-- THE TEMPLATE REPORT. p_pages: EdgeDesk's own published pages per template,
-- [{ "format": "weekly_games_to_watch_first_party", "path": "/articles/<slug>/" }]
-- (they live in the site's article store, not here). Every figure is a count
-- of something that happened; nothing is projected.
create or replace function public.content_engine_template_report(p_pages jsonb default '[]'::jsonb)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare out jsonb := '[]'::jsonb; f text; m jsonb; codes text[]; paths text[]; fp jsonb; pm jsonb;
  gen int; approved int; first_pass int; auto_rej int; sent int; responded int; accepted int; placements int; cost numeric;
  v int; rv int; su int; tr int; pd int; x jsonb;
begin
  perform content_engine.require_owner();
  for f in select unnest(array['weekly_games_to_watch', 'weekly_games_to_watch_first_party', 'upset_watch', 'market_discrepancy', 'game_deep_dive', 'model_performance_review',
                                'cfb_weekly_preview', 'nfl_weekly_preview', 'weekend_storylines', 'conference_race', 'trending_story', 'publisher_custom']) loop
    select count(*),
           count(*) filter (where status in ('approved', 'ready_to_send', 'sent', 'published')),
           count(*) filter (where status in ('approved', 'ready_to_send', 'sent', 'published') and revision = 1 and not owner_edited),
           count(*) filter (where status = 'sent' or status = 'published'),
           count(*) filter (where publisher_response is not null),
           count(*) filter (where publisher_response = 'accepted'),
           count(*) filter (where status = 'published' and publisher_id is not null),
           coalesce(array_agg(campaign_code) filter (where status in ('sent', 'published')), '{}')
      into gen, approved, first_pass, sent, responded, accepted, placements, codes
      from content_engine.articles where format = f;
    select count(*) into auto_rej from content_engine.events e join content_engine.articles a on a.id = e.article_id
     where e.kind = 'article_auto_rejected' and a.format = f;
    select coalesce(sum(s.actual_usd), 0) into cost from content_engine.ai_spend s join content_engine.articles a on a.id = s.article_id
     where s.status = 'committed' and a.format = f;
    v := null; rv := null; su := null; tr := null; pd := null;
    foreach x in array coalesce((select array_agg(content_engine.first_party(c)) from unnest(codes) c), '{}') loop
      v := coalesce(v, 0) + coalesce((x ->> 'sessions')::int, (x ->> 'visits')::int, 0);
      su := case when x ->> 'signups' is null then su else coalesce(su, 0) + (x ->> 'signups')::int end;
      tr := case when x ->> 'trials' is null then tr else coalesce(tr, 0) + (x ->> 'trials')::int end;
      pd := case when x ->> 'paid' is null then pd else coalesce(pd, 0) + (x ->> 'paid')::int end;
    end loop;
    paths := coalesce((select array_agg(e ->> 'path') from jsonb_array_elements(case when jsonb_typeof(p_pages) = 'array' then p_pages else '[]'::jsonb end) e
                        where e ->> 'format' = f and coalesce(e ->> 'path', '') ~ '^/articles/[a-z0-9-]+/$'), '{}');
    foreach pm in array coalesce((select array_agg(content_engine.page_metrics(p)) from unnest(paths) p), '{}') loop
      v := case when pm ->> 'views' is null then v else coalesce(v, 0) + (pm ->> 'views')::int end;
      rv := case when pm ->> 'research_visits' is null then rv else coalesce(rv, 0) + (pm ->> 'research_visits')::int end;
      su := case when pm ->> 'signups' is null then su else coalesce(su, 0) + (pm ->> 'signups')::int end;
      tr := case when pm ->> 'trials' is null then tr else coalesce(tr, 0) + (pm ->> 'trials')::int end;
      pd := case when pm ->> 'paid' is null then pd else coalesce(pd, 0) + (pm ->> 'paid')::int end;
    end loop;
    if gen = 0 and cardinality(paths) = 0 then continue; end if;
    out := out || jsonb_build_object('format', f, 'articles_generated', gen, 'approved', approved,
      'first_pass_approval_rate', case when gen > 0 then round(first_pass::numeric / gen, 3) end,
      'auto_rejected', auto_rej, 'sent_to_publisher', sent, 'publisher_responses', responded, 'publisher_accepted', accepted,
      'publisher_acceptance_rate', case when responded > 0 then round(accepted::numeric / responded, 3) end,
      'external_placements', placements, 'first_party_pages', cardinality(paths),
      'traffic_sessions', v, 'research_page_visits', rv, 'registrations', su, 'trials', tr, 'paid_subscribers', pd,
      'generation_cost_usd', round(cost, 2), 'attributed_revenue_usd', content_engine.attributed_revenue(codes, paths));
  end loop;
  return jsonb_build_object('templates', out,
    'basis', 'counts of what happened: articles by format; approval on the first revision with no owner edit; publisher responses as the owner recorded them; placements are articles marked published at a publisher URL; traffic, registrations, trials and paid subscribers are first-party counts by campaign code (publisher editions) or landing path (EdgeDesk pages), owners excluded; cost is committed AI spend tied to each article; revenue is Stripe-paid invoices of attributed accounts (gross). A null is not measured, never zero.',
    'not_claimed', 'no search ranking, forecast or projected revenue is reported here');
end $$;

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
    if f::text ~ '^content_engine_(opportunity_upsert|article_create|article_save|article_submit|article\(|spend|log|search_evidence|job_|ai_reserve|ai_settle|ai_attribute|article_auto_reject|broadcast_checks_current)' then
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
  select 'send doors are owner-only (no service role, no anon)',
         not has_function_privilege('service_role', 'public.content_engine_send_claim(uuid, text, text, text, boolean, text)', 'execute')
         and not has_function_privilege('anon', 'public.content_engine_send_claim(uuid, text, text, text, boolean, text)', 'execute'),
         'an email goes out only when an owner presses Send, to a contact on the article''s publisher'
  union all
  select 'a sender for Send to publisher',
         content_engine.sender() is not null,
         coalesce(content_engine.sender() ->> 'from', 'set an edgedesksports.com sender in /admin/content/ Settings')
  union all
  select 'append-only logs installed',
         (select count(*) from pg_trigger where tgname like '%\_append\_only' and tgrelid::regclass::text like 'content_engine.%') = 6,
         'revisions, deliveries, performance, events, benchmarks, broadcast_checks'
  union all
  select 'owner list available',
         to_regprocedure('growth_outbound.owner_active(uuid)') is not null,
         (select count(*)::text || ' outbound owner(s)' from growth_outbound.owners)
  union all
  select 'first publisher seeded (editorial only)',
         exists (select 1 from content_engine.publishers where slug = 'stadium-rant'),
         'contacts and benchmarks are entered by the owner in /admin/content/'
  union all
  select 'AI budget: a monthly dollar cap, reserved before every call',
         to_regclass('content_engine.ai_spend') is not null and (select monthly_budget_usd from content_engine.settings where id = 1) is not null,
         coalesce((select '$' || monthly_budget_usd::text || ' a month' from content_engine.settings where id = 1), 'not configured')
  union all
  select 'approval binds the research; integrity verdict required',
         to_regprocedure('content_engine.integrity_ok(jsonb)') is not null and to_regprocedure('content_engine.research_current(uuid, text, text)') is not null,
         'changed research revokes approval; ready-to-send and Send refuse a BLOCKED or missing integrity verdict'
  union all
  select 'games to watch: owner broadcast checks, auto-reject, template report',
         to_regclass('content_engine.broadcast_checks') is not null and to_regprocedure('public.content_engine_article_auto_reject(uuid, jsonb)') is not null
         and to_regprocedure('public.content_engine_template_report(jsonb)') is not null
         and not has_function_privilege('service_role', 'public.content_engine_broadcast_verify(jsonb)', 'execute'),
         'only an owner verifies a broadcast; the job rejects only a draft its own review rejected'
  union all
  select 'first-party measurement tables',
         to_regclass('public.acquisition_visitors') is not null and to_regclass('public.user_acquisition') is not null,
         'without growth.sql the conversion figures read "not measured"'
) r;

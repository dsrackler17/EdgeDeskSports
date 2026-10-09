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
--   first_party     EdgeDesk's own features: every dry run, held, scheduled,
--                   approved, published, rejected or skipped slot (owner-only)
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
  kind            text not null check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story', 'matchup_preview', 'postgame_review', 'matchup_analysis')),
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
  format             text not null check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'matchup_deep_dive', 'conference_race', 'model_vs_market', 'postgame_review', 'publisher_custom', 'matchup_analysis')),
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
-- the templates added since the first install (matchup deep dive, conference
-- race, model vs. market, postgame review): the same lists, on an existing table
alter table content_engine.opportunities drop constraint if exists opportunities_kind_check;
alter table content_engine.opportunities add constraint opportunities_kind_check check (kind in ('weekly_preview', 'upset_watch', 'conference_race', 'market_discrepancy', 'injury_impact', 'trending_story', 'matchup_preview', 'postgame_review', 'matchup_analysis'));
alter table content_engine.articles drop constraint if exists articles_format_check;
alter table content_engine.articles add constraint articles_format_check check (format in ('cfb_weekly_preview', 'nfl_weekly_preview', 'trending_story', 'market_discrepancy', 'matchup_deep_dive', 'conference_race', 'model_vs_market', 'postgame_review', 'publisher_custom', 'matchup_analysis'));
-- the editorial gate (section 6c): the last report for this article, the
-- version it was run on, and the owner's review acknowledgements
alter table content_engine.articles add column if not exists gate jsonb;
alter table content_engine.articles add column if not exists gate_verdict text;
alter table content_engine.articles add column if not exists gate_hash text;
alter table content_engine.articles add column if not exists gate_at timestamptz;
alter table content_engine.articles add column if not exists acks jsonb not null default '{}'::jsonb;
alter table content_engine.articles add column if not exists first_gate_verdict text;
alter table content_engine.articles add column if not exists first_gate_blocked text[];
do $g$ begin
  if not exists (select 1 from pg_constraint where conname = 'articles_gate_shape') then
    alter table content_engine.articles add constraint articles_gate_shape check (
      (gate_verdict is null or gate_verdict in ('PASS', 'WARNING', 'BLOCKED'))
      and (first_gate_verdict is null or first_gate_verdict in ('PASS', 'WARNING', 'BLOCKED'))
      and jsonb_typeof(acks) = 'object');
  end if;
end $g$;

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
    -- THE EDITORIAL GATE (section 6c): approval and Ready to Send need a gate
    -- report for this exact version, from the last 24 hours, that is not BLOCKED
    if (new.status = 'approved' and old.status = 'in_review') or new.status = 'ready_to_send' then
      /* gate_at is NULL after an owner review is recorded or withdrawn: the
         gate must run again, and a NULL comparison must never read as fresh */
      if new.gate_verdict is null or new.gate_hash is distinct from new.content_hash or new.gate_at is null or new.gate_at < now() - interval '24 hours' then
        raise exception 'run the editorial gate on this exact version first' using errcode = 'check_violation';
      end if;
      if new.gate_verdict = 'BLOCKED' then
        raise exception 'the editorial gate blocked this version' using errcode = 'check_violation';
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
    'sender', content_engine.sender(),
    'ai', content_engine.ai_month(),
    'gate', coalesce((select jsonb_object_agg(coalesce(gate_verdict, 'NOT_RUN'), n) from (select gate_verdict, count(*) n from content_engine.articles
        where status in ('draft', 'in_review', 'approved', 'ready_to_send') group by gate_verdict) x), '{}'::jsonb),
    'problems', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (select * from content_engine.events
        where kind in ('generation_failed', 'validation_failed', 'ai_discarded', 'fetch_failed', 'job_failed', 'send_failed', 'ai_budget_blocked', 'ai_budget_alert') order by at desc limit 12) e), '[]'::jsonb));
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
  if content_engine.gate_problem(a) is not null then return jsonb_build_object('ok', false, 'reason', content_engine.gate_problem(a), 'verdict', a.gate_verdict); end if;
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
  if p_to = 'ready_to_send' and content_engine.gate_problem(a) is not null then
    return jsonb_build_object('ok', false, 'reason', content_engine.gate_problem(a), 'verdict', a.gate_verdict);
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
             'research_stale', a.research_hash is distinct from o.research_hash,
             'gate_verdict', a.gate_verdict, 'gate_current', coalesce(a.gate_hash = a.content_hash and a.gate_at > now() - interval '24 hours', false)) x
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
    if content_engine.gate_problem(a) is not null then return jsonb_build_object('ok', false, 'reason', content_engine.gate_problem(a), 'detail', 'run the editorial gate again before sending'); end if;
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
-- 6c. THE EDITORIAL GATE — a report per version, enforced
--
-- The gate is computed by lib/content_engine.js (CE.gate: fourteen checks,
-- each PASS / WARNING / BLOCKED with evidence and a fix) in the owner's page or
-- the weekly job, against the research re-read at that moment. The database
-- stores the report for the exact content hash, refuses a report whose verdict
-- does not match its own findings or that claims an acknowledgement the owner
-- never made, and REFUSES approval, Ready to Send and Send without a report for
-- this version from the last 24 hours that is not BLOCKED (articles_guard, the
-- doors and content_engine_send_claim). The owner's review acknowledgements
-- (a discrepancy checked, a forecast read) live here, with a note.
-- =============================================================================
create or replace function content_engine.gate_problem(a content_engine.articles)
returns text language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select case
    when a.gate_verdict is null or a.gate_hash is distinct from a.content_hash then 'gate_not_run'
    when a.gate_at is null or a.gate_at < now() - interval '24 hours' then 'gate_stale'
    when a.gate_verdict = 'BLOCKED' then 'gate_blocked'
    else null end;
$$;

create or replace function public.content_engine_article_gate(p_id uuid, p_content_hash text, p_report jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); a content_engine.articles; vd text; worst text; blocked text[];
begin
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_content_hash is distinct from a.content_hash then return jsonb_build_object('ok', false, 'reason', 'changed_since_loaded', 'content_hash', a.content_hash); end if;
  if p_report is null or jsonb_typeof(p_report) <> 'object' or p_report ->> 'schema' is distinct from 'edgedesk_editorial_gate_v1'
     or jsonb_typeof(p_report -> 'items') is distinct from 'array' or octet_length(p_report::text) > 200000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_report');
  end if;
  vd := p_report ->> 'verdict';
  select case when bool_or(i ->> 'status' = 'BLOCKED') then 'BLOCKED' when bool_or(i ->> 'status' = 'WARNING') then 'WARNING' else 'PASS' end
    into worst from jsonb_array_elements(p_report -> 'items') i;
  if vd is distinct from coalesce(worst, 'PASS') then
    return jsonb_build_object('ok', false, 'reason', 'verdict_mismatch', 'detail', 'a report''s verdict is its worst finding');
  end if;
  -- an acknowledgement in a report must be one the owner made, here
  if exists (select 1 from jsonb_array_elements(p_report -> 'items') i, jsonb_array_elements(coalesce(i -> 'findings', '[]'::jsonb)) f
              where f ? 'acknowledged' and not (a.acks ? coalesce(f ->> 'ack_key', ''))) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_acknowledgement');
  end if;
  select coalesce(array_agg(i ->> 'key'), '{}') into blocked from jsonb_array_elements(p_report -> 'items') i where i ->> 'status' = 'BLOCKED';
  update content_engine.articles set gate = p_report, gate_verdict = vd, gate_hash = a.content_hash, gate_at = now(),
         first_gate_verdict = coalesce(first_gate_verdict, vd),
         first_gate_blocked = case when first_gate_verdict is null then blocked else first_gate_blocked end
   where id = p_id;
  perform content_engine.log(who, 'gate_run', p_id, a.opportunity_id, null,
    jsonb_build_object('verdict', vd, 'blocked', to_jsonb(blocked), 'content_hash', a.content_hash, 'revision', a.revision));
  return jsonb_build_object('ok', true, 'verdict', vd, 'blocked', to_jsonb(blocked));
end $$;

-- the owner's acknowledgement of a review finding (a large unexplained
-- discrepancy, a weather hazard, an unverified report): with a note, recorded,
-- reversible. It changes no content; the gate is re-run to apply it.
create or replace function public.content_engine_article_ack(p_id uuid, p_key text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); a content_engine.articles; n text := btrim(coalesce(p_note, ''));
begin
  if coalesce(p_key, '') !~ '^(discrepancy|weather|news):[A-Za-z0-9_-]{1,40}$' then return jsonb_build_object('ok', false, 'reason', 'bad_key'); end if;
  select * into a from content_engine.articles where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status in ('sent', 'published', 'archived') then return jsonb_build_object('ok', false, 'reason', 'not_editable', 'status', a.status); end if;
  if p_note is null then
    update content_engine.articles set acks = acks - p_key, gate_at = null where id = p_id;
    perform content_engine.log('owner', 'review_unacknowledged', p_id, a.opportunity_id, null, jsonb_build_object('key', p_key));
    return jsonb_build_object('ok', true, 'removed', true);
  end if;
  if length(n) < 3 or length(n) > 500 then return jsonb_build_object('ok', false, 'reason', 'note_required', 'detail', 'say what you checked (3–500 characters)'); end if;
  -- the gate must be re-run for the acknowledgement to count
  update content_engine.articles set acks = acks || jsonb_build_object(p_key, jsonb_build_object('note', n, 'at', now(), 'by', v)), gate_at = null where id = p_id;
  perform content_engine.log('owner', 'review_acknowledged', p_id, a.opportunity_id, null, jsonb_build_object('key', p_key, 'note', n));
  return jsonb_build_object('ok', true);
end $$;

-- =============================================================================
-- 6d. THE AI BUDGET — tokens and estimated dollars, a monthly cap that holds
--
-- Every Claude call is RESERVED before it is made: the worst case (the
-- request's estimated input plus max_tokens of output, at the configured list
-- price of the model) is held against the month under one advisory lock, so
-- concurrent workers and requests cannot pass the cap together. The call is
-- SETTLED with the usage the API returned (input, output, cache tokens, the
-- model that actually served it), which replaces the reservation with an
-- ESTIMATE. Estimated is not billed: owner-entered billed amounts live in
-- content_engine.costs (section 6e). An identical request (same model, prompt
-- and draft: request_hash) answered in the last 30 days is served from the
-- ledger without a call. Warnings at 50 / 75 / 90%; at 100% discretionary
-- generation is refused — exports, review, sending and the deterministic
-- writer never depend on it.
-- =============================================================================
alter table content_engine.settings add column if not exists ai_monthly_budget_usd numeric(8,2) not null default 10;
alter table content_engine.settings add column if not exists ai_prices jsonb not null default jsonb_build_object(
  'source', 'Anthropic first-party list prices per million tokens (claude-api reference, cached 2026-10-06). Used for ESTIMATES only; your invoice is the billed amount.',
  'unknown_model', 'priced at the most expensive listed model',
  'models', jsonb_build_object(
    'claude-opus-5-5',   jsonb_build_object('input', 4,    'output', 20,  'cache_read', 0.2,  'cache_write', 5),
    'claude-opus-5',     jsonb_build_object('input', 5,    'output', 25,  'cache_read', 0.5,  'cache_write', 6.25),
    'claude-opus-4-8',   jsonb_build_object('input', 5,    'output', 25,  'cache_read', 0.5,  'cache_write', 6.25),
    'claude-sonnet-5-5', jsonb_build_object('input', 2,    'output', 10,  'cache_read', 0.2,  'cache_write', 2.5),
    'claude-haiku-5-5',  jsonb_build_object('input', 0.1,  'output', 0.5, 'cache_read', 0.01, 'cache_write', 0.125),
    'claude-fable-5-1',  jsonb_build_object('input', 10,   'output', 50,  'cache_read', 0.25, 'cache_write', 12.5)));
do $b$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_ai_budget_shape') then
    alter table content_engine.settings add constraint settings_ai_budget_shape check (
      ai_monthly_budget_usd between 0 and 1000 and jsonb_typeof(ai_prices -> 'models') = 'object');
  end if;
end $b$;

create table if not exists content_engine.ai_calls (
  id                 bigint generated always as identity primary key,
  month              date not null,
  created_at         timestamptz not null default now(),
  actor              text not null check (actor in ('owner', 'schedule')),
  operation          text not null check (operation in ('draft', 'section', 'other')),
  article_id         uuid references content_engine.articles(id),
  model              text not null check (model ~ '^[a-z0-9.-]{3,60}$'),
  request_hash       text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  attempt            int not null default 1 check (attempt between 1 and 3),
  status             text not null default 'reserved' check (status in ('reserved', 'completed', 'failed', 'cache_hit')),
  outcome            text check (outcome is null or outcome in ('accepted', 'discarded', 'error', 'refused', 'max_tokens', 'unknown')),
  reserved_usd       numeric(10,6) not null default 0 check (reserved_usd >= 0),
  est_usd            numeric(10,6) check (est_usd is null or est_usd >= 0),
  usage_known        boolean,
  input_tokens       int check (input_tokens is null or input_tokens >= 0),
  output_tokens      int check (output_tokens is null or output_tokens >= 0),
  cache_read_tokens  int check (cache_read_tokens is null or cache_read_tokens >= 0),
  cache_write_tokens int check (cache_write_tokens is null or cache_write_tokens >= 0),
  served_model       text,
  result             jsonb,
  objections         jsonb,
  cached_from        bigint references content_engine.ai_calls(id),
  settled_at         timestamptz
);
create index if not exists ai_calls_month on content_engine.ai_calls (month, status);
create index if not exists ai_calls_hash on content_engine.ai_calls (request_hash, status, created_at desc);
alter table content_engine.ai_calls enable row level security;

-- a reservation is settled once; nothing else about a call changes; nothing is deleted
create or replace function content_engine.ai_calls_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'AI calls are a ledger: nothing is deleted' using errcode = 'check_violation'; end if;
  if old.status <> 'reserved' then raise exception 'a settled AI call does not change' using errcode = 'check_violation'; end if;
  if new.id <> old.id or new.month <> old.month or new.created_at <> old.created_at or new.actor <> old.actor or new.operation <> old.operation
     or new.model <> old.model or new.request_hash <> old.request_hash or new.reserved_usd <> old.reserved_usd or new.attempt <> old.attempt
     or new.article_id is distinct from old.article_id then
    raise exception 'only the outcome of an AI call is written' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists ai_calls_guard on content_engine.ai_calls;
create trigger ai_calls_guard before update or delete on content_engine.ai_calls for each row execute function content_engine.ai_calls_guard();
create or replace function content_engine.no_truncate() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin raise exception '% is a ledger: it is never truncated', tg_table_name using errcode = 'check_violation'; end $$;
drop trigger if exists ai_calls_no_truncate on content_engine.ai_calls;
create trigger ai_calls_no_truncate before truncate on content_engine.ai_calls for each statement execute function content_engine.no_truncate();

-- a model's price row; an unknown model at the most expensive listed rates
create or replace function content_engine.ai_price(p_model text)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select ai_prices -> 'models' -> p_model from content_engine.settings where id = 1),
    (select m.value || jsonb_build_object('unpriced', true) from content_engine.settings s, jsonb_each(s.ai_prices -> 'models') m where s.id = 1
      order by (m.value ->> 'output')::numeric desc limit 1));
$$;
-- dollars for a usage object as the API returns it: { input_tokens, output_tokens,
-- cache_read_input_tokens, cache_creation_input_tokens, model, iterations: [...] }.
-- A fallback that served part of the turn is priced at its own model's rates.
create or replace function content_engine.ai_cost(p_usage jsonb, p_model text)
returns numeric language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare rows jsonb; r jsonb; pr jsonb; total numeric := 0;
begin
  rows := case when jsonb_typeof(p_usage -> 'iterations') = 'array' and jsonb_array_length(p_usage -> 'iterations') > 0 then p_usage -> 'iterations' else jsonb_build_array(p_usage) end;
  for r in select * from jsonb_array_elements(rows) loop
    pr := content_engine.ai_price(coalesce(r ->> 'model', p_usage ->> 'model', p_model));
    total := total + (coalesce((r ->> 'input_tokens')::numeric, 0) * (pr ->> 'input')::numeric
                    + coalesce((r ->> 'output_tokens')::numeric, 0) * (pr ->> 'output')::numeric
                    + coalesce((r ->> 'cache_read_input_tokens')::numeric, 0) * coalesce((pr ->> 'cache_read')::numeric, (pr ->> 'input')::numeric)
                    + coalesce((r ->> 'cache_creation_input_tokens')::numeric, 0) * coalesce((pr ->> 'cache_write')::numeric, (pr ->> 'input')::numeric)) / 1000000;
  end loop;
  return round(total, 6);
end $$;
-- a token count from a usage object: the top level, else the sum of its iterations (a fallback turn)
create or replace function content_engine.usage_sum(p_usage jsonb, p_key text)
returns int language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce((p_usage ->> p_key)::int,
    (select sum((x ->> p_key)::int)::int from jsonb_array_elements(case when jsonb_typeof(p_usage -> 'iterations') = 'array' then p_usage -> 'iterations' else '[]'::jsonb end) x));
$$;
-- the month so far: settled estimates plus every reservation still open
create or replace function content_engine.ai_month(p_month date default null)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  with m as (select coalesce(p_month, date_trunc('month', now() at time zone 'utc')::date) as month),
  c as (select x.* from content_engine.ai_calls x, m where x.month = m.month),
  t as (select coalesce(sum(case when status = 'reserved' then reserved_usd else coalesce(est_usd, 0) end), 0) as committed,
               coalesce(sum(est_usd) filter (where status in ('completed', 'failed')), 0) as estimated,
               coalesce(sum(reserved_usd) filter (where status = 'reserved'), 0) as open_reserved,
               count(*) filter (where status in ('completed', 'failed')) as calls,
               count(*) filter (where status = 'cache_hit') as cache_hits,
               count(*) filter (where outcome = 'accepted') as accepted,
               count(*) filter (where outcome = 'discarded') as discarded,
               count(*) filter (where outcome in ('error', 'refused', 'max_tokens', 'unknown')) as failed,
               coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens
          from c),
  s as (select ai_monthly_budget_usd as budget from content_engine.settings where id = 1)
  select jsonb_build_object('month', (select month from m), 'budget_usd', s.budget, 'committed_usd', round(t.committed, 4),
    'estimated_usd', round(t.estimated, 4), 'open_reserved_usd', round(t.open_reserved, 4),
    'level', case when s.budget <= 0 then 100 else least(100, floor(t.committed / s.budget * 100))::int end,
    'alert', case when s.budget <= 0 or t.committed >= s.budget then 100 when t.committed >= s.budget * 0.9 then 90
                  when t.committed >= s.budget * 0.75 then 75 when t.committed >= s.budget * 0.5 then 50 else 0 end,
    'calls', t.calls, 'cache_hits', t.cache_hits, 'accepted', t.accepted, 'discarded', t.discarded, 'failed', t.failed,
    'input_tokens', t.input_tokens, 'output_tokens', t.output_tokens,
    'basis', 'estimated from the API''s own token counts at list prices; not your invoice (enter billed amounts under Costs)')
  from t, s;
$$;

create or replace function public.content_engine_ai_reserve(p_operation text, p_article uuid, p_model text, p_request_hash text,
  p_max_output_tokens int, p_input_tokens_est int, p_attempt int default 1)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); s content_engine.settings; m date := date_trunc('month', now() at time zone 'utc')::date;
  pr jsonb; worst numeric; month jsonb; committed numeric; hit content_engine.ai_calls; nid bigint; cap int; used int; d date := (now() at time zone 'utc')::date;
  before_alert int; after_alert int;
begin
  if p_operation not in ('draft', 'section', 'other') or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_model, '') !~ '^[a-z0-9.-]{3,60}$'
     or coalesce(p_max_output_tokens, 0) not between 1 and 64000 or coalesce(p_input_tokens_est, -1) not between 0 and 400000 or coalesce(p_attempt, 0) not between 1 and 3 then
    return jsonb_build_object('ok', false, 'reason', 'bad_input');
  end if;
  -- the same request, already answered: served from the ledger, no call, no cost
  select * into hit from content_engine.ai_calls
   where request_hash = p_request_hash and status = 'completed' and outcome in ('accepted', 'discarded') and result is not null
     and created_at > now() - interval '30 days' order by id desc limit 1;
  if hit.id is not null then
    insert into content_engine.ai_calls (month, actor, operation, article_id, model, request_hash, attempt, status, outcome, est_usd, usage_known, cached_from, settled_at)
    values (m, who, p_operation, p_article, p_model, p_request_hash, p_attempt, 'cache_hit', hit.outcome, 0, true, hit.id, now()) returning id into nid;
    return jsonb_build_object('ok', true, 'cached', true, 'call_id', nid, 'outcome', hit.outcome, 'result', hit.result, 'objections', hit.objections,
      'from_call', hit.id, 'answered_at', hit.created_at);
  end if;
  -- every reservation in the project, one at a time: no two can pass the cap together
  perform pg_advisory_xact_lock(hashtext('content_engine.ai_budget'));
  select * into s from content_engine.settings where id = 1;
  pr := content_engine.ai_price(p_model);
  worst := round((p_input_tokens_est * (pr ->> 'input')::numeric + p_max_output_tokens * (pr ->> 'output')::numeric) / 1000000, 6);
  month := content_engine.ai_month(m);
  committed := (month ->> 'committed_usd')::numeric;
  if s.ai_monthly_budget_usd <= 0 or committed + worst > s.ai_monthly_budget_usd then
    perform content_engine.log(who, 'ai_budget_blocked', p_article, null, null,
      jsonb_build_object('budget_usd', s.ai_monthly_budget_usd, 'committed_usd', committed, 'needed_usd', worst, 'model', p_model));
    return jsonb_build_object('ok', false, 'reason', 'budget_exhausted', 'budget_usd', s.ai_monthly_budget_usd, 'committed_usd', committed, 'needed_usd', worst,
      'detail', 'this month''s AI budget would be exceeded: the deterministic writer, review, exports and sending still work');
  end if;
  -- the daily call cap still applies, counted in the same place as before
  cap := s.llm_calls_per_day;
  insert into content_engine.usage (day, provider, calls) values (d, 'llm', 0) on conflict do nothing;
  select calls into used from content_engine.usage where day = d and provider = 'llm' for update;
  if used + 1 > cap then
    perform content_engine.log(who, 'budget_exhausted', p_article, null, null, jsonb_build_object('provider', 'llm', 'cap', cap, 'used', used));
    return jsonb_build_object('ok', false, 'reason', 'budget_exhausted', 'detail', 'today''s AI call cap (' || cap || ') is reached', 'cap', cap, 'used', used);
  end if;
  update content_engine.usage set calls = calls + 1 where day = d and provider = 'llm';
  before_alert := (month ->> 'alert')::int;
  insert into content_engine.ai_calls (month, actor, operation, article_id, model, request_hash, attempt, reserved_usd)
  values (m, who, p_operation, p_article, p_model, p_request_hash, p_attempt, worst) returning id into nid;
  after_alert := (content_engine.ai_month(m) ->> 'alert')::int;
  if after_alert > before_alert then
    perform content_engine.log(who, 'ai_budget_alert', p_article, null, null, jsonb_build_object('level', after_alert, 'budget_usd', s.ai_monthly_budget_usd));
  end if;
  return jsonb_build_object('ok', true, 'cached', false, 'call_id', nid, 'reserved_usd', worst, 'committed_usd', committed + worst,
    'budget_usd', s.ai_monthly_budget_usd, 'alert', after_alert, 'price', pr);
end $$;

-- the API's answer: tokens and the serving model replace the reservation with an estimate.
-- p_usage null with p_outcome 'unknown' (a timeout): the reservation stands as the estimate.
create or replace function public.content_engine_ai_settle(p_call bigint, p_usage jsonb, p_outcome text, p_result jsonb default null, p_objections jsonb default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); c content_engine.ai_calls; est numeric; known boolean;
begin
  if p_outcome not in ('accepted', 'discarded', 'error', 'refused', 'max_tokens', 'unknown') then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  select * into c from content_engine.ai_calls where id = p_call for update;
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if c.status <> 'reserved' then return jsonb_build_object('ok', true, 'already', true, 'status', c.status); end if;
  known := p_usage is not null and jsonb_typeof(p_usage) = 'object' and (p_usage ? 'input_tokens' or p_usage ? 'iterations');
  est := case when known then content_engine.ai_cost(p_usage, c.model) when p_outcome = 'error' then 0 else c.reserved_usd end;
  update content_engine.ai_calls set
    status = case when p_outcome in ('accepted', 'discarded') then 'completed' else 'failed' end,
    outcome = p_outcome, est_usd = est, usage_known = known,
    input_tokens = case when known then content_engine.usage_sum(p_usage, 'input_tokens') end,
    output_tokens = case when known then content_engine.usage_sum(p_usage, 'output_tokens') end,
    cache_read_tokens = case when known then content_engine.usage_sum(p_usage, 'cache_read_input_tokens') end,
    cache_write_tokens = case when known then content_engine.usage_sum(p_usage, 'cache_creation_input_tokens') end,
    served_model = left(coalesce(p_usage ->> 'model', c.model), 60),
    result = case when p_outcome in ('accepted', 'discarded') and p_result is not null and octet_length(p_result::text) <= 200000 then p_result end,
    objections = case when p_objections is not null and octet_length(p_objections::text) <= 20000 then p_objections end,
    settled_at = now()
   where id = p_call;
  return jsonb_build_object('ok', true, 'est_usd', est, 'usage_known', known, 'month', content_engine.ai_month(c.month));
end $$;

create or replace function public.content_engine_ai_budget()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return content_engine.ai_month() || jsonb_build_object(
    'prices', (select ai_prices from content_engine.settings where id = 1),
    'by_model', coalesce((select jsonb_object_agg(coalesce(served_model, model), jsonb_build_object('calls', n, 'est_usd', round(usd, 4))) from (
        select served_model, model, count(*) n, sum(coalesce(est_usd, 0)) usd from content_engine.ai_calls
         where month = date_trunc('month', now() at time zone 'utc')::date and status in ('completed', 'failed') group by served_model, model) x), '{}'::jsonb),
    'by_operation', coalesce((select jsonb_object_agg(operation, jsonb_build_object('calls', n, 'est_usd', round(usd, 4), 'accepted', ok)) from (
        select operation, count(*) n, sum(coalesce(est_usd, 0)) usd, count(*) filter (where outcome = 'accepted') ok from content_engine.ai_calls
         where month = date_trunc('month', now() at time zone 'utc')::date and status in ('completed', 'failed') group by operation) x), '{}'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'operation', operation, 'model', coalesce(served_model, model),
        'status', status, 'outcome', outcome, 'est_usd', est_usd, 'reserved_usd', reserved_usd, 'input_tokens', input_tokens, 'output_tokens', output_tokens,
        'article_id', article_id, 'cached_from', cached_from) order by id desc)
        from (select * from content_engine.ai_calls order by id desc limit 25) z), '[]'::jsonb));
end $$;

create or replace function public.content_engine_ai_budget_save(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner();
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  update content_engine.settings set
    ai_monthly_budget_usd = coalesce((p ->> 'ai_monthly_budget_usd')::numeric, ai_monthly_budget_usd),
    ai_prices = case when jsonb_typeof(p -> 'ai_prices') = 'object' then p -> 'ai_prices' else ai_prices end
   where id = 1;
  perform content_engine.log('owner', 'settings_changed', null, null, null, jsonb_build_object('ai_budget', p - 'ai_prices', 'prices_changed', p ? 'ai_prices'));
  return jsonb_build_object('ok', true, 'ai', content_engine.ai_month());
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'budget 0–1000 dollars; prices need a models object');
end $$;

-- =============================================================================
-- 6e. MEASUREMENT — the funnel, the revenue, the costs and the targets
--
-- Article → approved → sent → published → referral visit → registration →
-- trial → paid → retained, joined on each article's utm_campaign through the
-- growth tables that already persist attribution across sign-up
-- (acquisition_visitors → acq_claim → user_acquisition) and Stripe's verified
-- webhook events (stripe_events → growth_customer_facts).
--
--   DIRECT     the account's LAST attributable touch was this article's
--              campaign, within attribution_window_days before sign-up. One
--              article at most per account.
--   ASSISTED   an earlier touch (the first) was a content campaign, but the
--              last was not, within assisted_window_days. Never added to the
--              direct totals.
--   REGISTRATION counts confirmed email addresses only (a bot account that
--              never confirms is not a registration); owners are excluded.
--   REVENUE    Stripe's invoices (amount_paid, de-duplicated by invoice) less
--              refunds (charge.refunded, de-duplicated by charge) — collected
--              money, not list price. MRR is each active subscription's latest
--              paid invoice.
-- Counts and sums only; no identity leaves this function.
-- =============================================================================
alter table content_engine.settings add column if not exists attribution_window_days int not null default 30;
alter table content_engine.settings add column if not exists assisted_window_days int not null default 90;
alter table content_engine.settings add column if not exists program_started_at date not null default (now() at time zone 'utc')::date;
alter table content_engine.settings add column if not exists targets jsonb not null default jsonb_build_object(
  'articles_per_week', 2, 'articles_per_month', 8, 'first_pass_rate', 0.9, 'factual_errors', 0,
  'active_publishers', 3, 'placements_per_month', 8, 'referral_visits_per_month', 250, 'registrations_per_month', 25,
  'paid_per_month', 3, 'new_mrr_usd_per_month', 149.97, 'cac_max_usd', 25, 'revenue_to_cost_min', 3, 'price_usd', 49.99, 'ramp_days', 90);
do $m$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_measurement_shape') then
    alter table content_engine.settings add constraint settings_measurement_shape check (
      attribution_window_days between 1 and 180 and assisted_window_days between 1 and 365 and jsonb_typeof(targets) = 'object');
  end if;
end $m$;

-- what the channel cost: billed amounts and estimates the owner enters (an
-- Anthropic invoice, a writer, a tool). AI ESTIMATES come from the ledger.
create table if not exists content_engine.costs (
  id           bigint generated always as identity primary key,
  month        date not null check (extract(day from month) = 1),
  category     text not null check (category in ('ai_billed', 'writing', 'distribution', 'tools', 'other')),
  amount_usd   numeric(10,2) not null check (amount_usd between -100000 and 100000),
  basis        text not null check (basis in ('billed', 'estimate')),
  note         text check (note is null or length(note) <= 300),
  recorded_by  uuid,
  recorded_at  timestamptz not null default now()
);
alter table content_engine.costs enable row level security;
drop trigger if exists costs_append_only on content_engine.costs;
create trigger costs_append_only before update or delete on content_engine.costs for each row execute function content_engine.append_only();

create or replace function public.content_engine_cost_add(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); n bigint;
begin
  insert into content_engine.costs (month, category, amount_usd, basis, note, recorded_by)
  values (date_trunc('month', coalesce(nullif(p ->> 'month', '')::date, (now() at time zone 'utc')::date))::date, p ->> 'category',
          (p ->> 'amount_usd')::numeric, coalesce(p ->> 'basis', 'billed'), nullif(btrim(p ->> 'note'), ''), v)
  returning id into n;
  perform content_engine.log('owner', 'cost_recorded', null, null, null, jsonb_build_object('id', n, 'category', p ->> 'category', 'amount_usd', p ->> 'amount_usd'));
  return jsonb_build_object('ok', true, 'id', n);
exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'category, amount and basis (billed or estimate); a correction is a negative amount');
end $$;

create or replace function public.content_engine_targets_save(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner();
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  update content_engine.settings set
    targets = case when jsonb_typeof(p -> 'targets') = 'object' then targets || (p -> 'targets') else targets end,
    attribution_window_days = coalesce((p ->> 'attribution_window_days')::int, attribution_window_days),
    assisted_window_days = coalesce((p ->> 'assisted_window_days')::int, assisted_window_days),
    program_started_at = coalesce(nullif(p ->> 'program_started_at', '')::date, program_started_at)
   where id = 1;
  perform content_engine.log('owner', 'settings_changed', null, null, null, jsonb_build_object('targets', p));
  return jsonb_build_object('ok', true);
exception when check_violation or invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'reason', 'invalid');
end $$;

-- collected money per account, from Stripe's own events (de-duplicated by
-- invoice and by charge). Null when billing is not installed.
create or replace function content_engine.user_revenue()
returns table (user_id uuid, collected_cents bigint, refunded_cents bigint, invoices int, first_paid_at timestamptz, latest_paid_cents bigint)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
begin
  if to_regclass('public.stripe_events') is null or to_regprocedure('public.affiliate_stripe_object(jsonb)') is null then return; end if;
  return query
  with ev as (
    select e.type, coalesce(e.stripe_created, e.created_at) as at, public.affiliate_stripe_object(e.payload) as o, e.user_id as uid0, e.customer_id, e.subscription_id
      from public.stripe_events e where e.type in ('invoice.paid', 'invoice.payment_succeeded', 'charge.refunded')
  ), ev2 as (
    select ev.*, coalesce(ev.uid0,
      (select s.user_id from public.subscriptions s where s.stripe_subscription_id = coalesce(ev.subscription_id, public.affiliate_stripe_id(ev.o -> 'subscription'),
          public.affiliate_stripe_id(ev.o -> 'parent' -> 'subscription_details' -> 'subscription')) limit 1),
      (select s.user_id from public.subscriptions s where s.stripe_customer_id = coalesce(ev.customer_id, public.affiliate_stripe_id(ev.o -> 'customer')) limit 1)) as uid
      from ev
  ), inv as (
    select distinct on (o ->> 'id') uid, at, (o ->> 'amount_paid')::bigint as cents
      from ev2 where type in ('invoice.paid', 'invoice.payment_succeeded') and uid is not null and (o ->> 'amount_paid') ~ '^[0-9]+$' and (o ->> 'amount_paid')::bigint > 0
     order by o ->> 'id', at
  ), ref as (
    select distinct on (o ->> 'id') uid, (o ->> 'amount_refunded')::bigint as cents
      from ev2 where type = 'charge.refunded' and uid is not null and (o ->> 'amount_refunded') ~ '^[0-9]+$'
     order by o ->> 'id', at desc
  )
  select u.uid, coalesce(sum(i.cents), 0)::bigint, coalesce((select sum(r.cents) from ref r where r.uid = u.uid), 0)::bigint, count(i.cents)::int, min(i.at),
         (select i2.cents from inv i2 where i2.uid = u.uid order by i2.at desc limit 1)
    from (select distinct uid from inv union select distinct uid from ref) u left join inv i on i.uid = u.uid
   group by u.uid;
end $$;

-- one row per account that touched a content campaign: how it was attributed,
-- and what it did. Owners excluded. For the scorecard only.
create or replace function content_engine.attribution(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, signup_at timestamptz, confirmed boolean, direct_code text, assisted_code text,
               trial_at timestamptz, paid_at timestamptz, paid_invoices int, sub_status text,
               collected_cents bigint, refunded_cents bigint, first90_cents bigint, latest_paid_cents bigint)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare w int; aw int;
begin
  if to_regclass('public.user_acquisition') is null then return; end if;
  select attribution_window_days, assisted_window_days into w, aw from content_engine.settings where id = 1;
  return query
  with codes as (select campaign_code from content_engine.articles),
  ua as (
    select u.user_id, coalesce(u.signup_at, au.created_at) as signup_at, au.email_confirmed_at is not null as confirmed,
           case when u.last_utm_campaign in (select campaign_code from codes) and coalesce(u.last_utm_medium, '') = 'publisher'
                 and (u.last_seen_at is null or u.last_seen_at >= coalesce(u.signup_at, au.created_at) - make_interval(days => w)) then u.last_utm_campaign end as direct_code,
           case when u.first_utm_campaign in (select campaign_code from codes)
                 and (u.first_seen_at is null or u.first_seen_at >= coalesce(u.signup_at, au.created_at) - make_interval(days => aw)) then u.first_utm_campaign end as first_code
      from public.user_acquisition u join auth.users au on au.id = u.user_id
     where not exists (select 1 from growth_outbound.owners o where o.user_id = u.user_id)
       and coalesce(u.signup_at, au.created_at) >= p_from and coalesce(u.signup_at, au.created_at) < p_to
  ), att as (
    select ua.*, case when ua.direct_code is null then ua.first_code when ua.first_code is distinct from ua.direct_code then null end as assisted
      from ua where ua.direct_code is not null or ua.first_code is not null
  ), facts as (
    select f.* from public.growth_customer_facts() f where to_regprocedure('public.growth_customer_facts()') is not null
  ), rev as (select * from content_engine.user_revenue())
  select att.user_id, att.signup_at, att.confirmed, att.direct_code, att.assisted,
         f.trial_started_at, f.paid_at, coalesce(f.paid_invoices, 0), f.sub_status,
         coalesce(r.collected_cents, 0), coalesce(r.refunded_cents, 0),
         coalesce((select sum((public.affiliate_stripe_object(e.payload) ->> 'amount_paid')::bigint) from (
             select distinct on (public.affiliate_stripe_object(e2.payload) ->> 'id') e2.* from public.stripe_events e2
              where e2.type in ('invoice.paid', 'invoice.payment_succeeded') and e2.user_id = att.user_id
                and (public.affiliate_stripe_object(e2.payload) ->> 'amount_paid') ~ '^[0-9]+$'
              order by public.affiliate_stripe_object(e2.payload) ->> 'id') e
            where f.paid_at is not null and coalesce(e.stripe_created, e.created_at) < f.paid_at + interval '90 days'), 0)::bigint,
         r.latest_paid_cents
    from att left join facts f on f.user_id = att.user_id left join rev r on r.user_id = att.user_id;
end $$;

-- THE SCORECARD: actual against the 90-day targets, with the bottleneck.
-- Every figure says whether it is measured; nothing is filled in.
create or replace function public.content_engine_scorecard(p_days int default 30)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare s content_engine.settings; d int := greatest(7, least(coalesce(p_days, 30), 365)); f timestamptz; t timestamptz := now();
  tg jsonb; elapsed int; ramp numeric; prod jsonb; dist jsonb; rev jsonb; cost jsonb; out jsonb; scale numeric;
  gen int; gated int; firstpass int; firstpass_auto int; warned int; blocked int; sent int; published int; avg_hours numeric; approved int;
  pubs int; visits int; regs int; regs_assisted int; trials int; paid int; paid_assisted int; mrr bigint; collected bigint; refunded bigint; first90 bigint;
  retained int; churned int; paid_total int; ai_est numeric; ai_billed numeric; other_cost numeric; total_cost numeric;
  measured_visits boolean := to_regclass('public.acquisition_visitors') is not null;
  measured_regs boolean := to_regclass('public.user_acquisition') is not null;
  measured_paid boolean := to_regprocedure('public.growth_customer_facts()') is not null;
  measured_rev boolean := to_regclass('public.stripe_events') is not null;
  targets jsonb := '[]'::jsonb; bottleneck jsonb;
begin
  perform content_engine.require_owner();
  select * into s from content_engine.settings where id = 1;
  f := t - make_interval(days => d);
  scale := d / 30.0;
  tg := s.targets;
  elapsed := greatest(0, (current_date - s.program_started_at));
  ramp := least(1, greatest(0.1, elapsed / greatest(1, coalesce((tg ->> 'ramp_days')::numeric, 90))));

  -- production
  select count(*) filter (where created_at >= f), count(*) filter (where created_at >= f and first_gate_verdict is not null),
         count(*) filter (where created_at >= f and first_gate_verdict in ('PASS', 'WARNING')),
         count(*) filter (where created_at >= f and first_gate_verdict is not null
                            and not (coalesce(first_gate_blocked, '{}') && array['schedule', 'teams', 'projections', 'snapshot', 'market', 'availability', 'claims', 'repetition', 'headline', 'referral', 'responsible'])),
         count(*) filter (where gate_verdict = 'WARNING' and status in ('draft', 'in_review', 'approved', 'ready_to_send')),
         count(*) filter (where gate_verdict = 'BLOCKED' and status in ('draft', 'in_review', 'approved', 'ready_to_send')),
         count(*) filter (where approved_at >= f), count(*) filter (where sent_at >= f), count(*) filter (where published_at >= f),
         avg(extract(epoch from (sent_at - created_at)) / 3600) filter (where sent_at >= f)
    into gen, gated, firstpass, firstpass_auto, warned, blocked, approved, sent, published, avg_hours
    from content_engine.articles;
  prod := jsonb_build_object('generated', gen, 'gated_first', gated, 'first_pass', firstpass, 'first_pass_rate', case when gated > 0 then round(firstpass::numeric / gated, 3) end,
    'first_pass_auto', firstpass_auto, 'first_pass_auto_rate', case when gated > 0 then round(firstpass_auto::numeric / gated, 3) end,
    'open_warnings', warned, 'open_blocked', blocked, 'approved', approved, 'sent', sent, 'published', published,
    'avg_hours_to_sent', round(avg_hours, 1),
    'first_pass_note', 'first_pass: the first gate run on a new article was not BLOCKED. first_pass_auto ignores blocks that need the owner''s judgment (an unexplained market gap).');

  -- distribution
  select count(*) into pubs from content_engine.publishers p where p.status = 'active'
     and exists (select 1 from content_engine.articles a where a.publisher_id = p.id and a.sent_at >= t - interval '60 days');
  if measured_visits then
    select count(*) into visits from public.acquisition_visitors v
     where coalesce(v.last_utm_campaign, v.first_utm_campaign) in (select campaign_code from content_engine.articles)
       and coalesce(v.last_seen_at, v.first_seen_at) >= f
       and (v.user_id is null or not exists (select 1 from growth_outbound.owners o where o.user_id = v.user_id));
  end if;
  if measured_regs then
    select count(*) filter (where direct_code is not null and confirmed), count(*) filter (where assisted_code is not null and confirmed),
           count(*) filter (where direct_code is not null and trial_at is not null),
           count(*) filter (where direct_code is not null and paid_at is not null), count(*) filter (where assisted_code is not null and paid_at is not null),
           coalesce(sum(latest_paid_cents) filter (where direct_code is not null and sub_status in ('active', 'trialing', 'past_due') and paid_at is not null), 0),
           coalesce(sum(collected_cents) filter (where direct_code is not null), 0), coalesce(sum(refunded_cents) filter (where direct_code is not null), 0),
           coalesce(sum(first90_cents) filter (where direct_code is not null), 0),
           count(*) filter (where direct_code is not null and paid_at is not null and paid_invoices >= 2 and coalesce(sub_status, '') in ('active', 'past_due')),
           count(*) filter (where direct_code is not null and paid_at is not null and coalesce(sub_status, 'canceled') not in ('active', 'trialing', 'past_due')),
           count(*) filter (where direct_code is not null and paid_at is not null)
      into regs, regs_assisted, trials, paid, paid_assisted, mrr, collected, refunded, first90, retained, churned, paid_total
      from content_engine.attribution(f, t);
  end if;
  dist := jsonb_build_object('active_publishers', pubs,
    'placements', coalesce((select jsonb_agg(jsonb_build_object('publisher', p.name, 'sent', n_sent, 'published', n_pub) order by n_pub desc, n_sent desc) from (
        select a.publisher_id, count(*) filter (where a.sent_at >= f) n_sent, count(*) filter (where a.published_at >= f) n_pub
          from content_engine.articles a where a.publisher_id is not null group by a.publisher_id) x
        join content_engine.publishers p on p.id = x.publisher_id where n_sent > 0 or n_pub > 0), '[]'::jsonb),
    'referral_visits', visits, 'registrations', regs, 'registrations_assisted', regs_assisted, 'trials', trials,
    'visit_to_registration', case when coalesce(visits, 0) > 0 and regs is not null then round(regs::numeric / visits, 4) end,
    'registration_to_trial', case when coalesce(regs, 0) > 0 and trials is not null then round(trials::numeric / regs, 4) end);
  rev := jsonb_build_object('paid', paid, 'paid_assisted', paid_assisted, 'new_mrr_usd', case when mrr is not null then round(mrr / 100.0, 2) end,
    'collected_usd', case when collected is not null and measured_rev then round(collected / 100.0, 2) end,
    'refunded_usd', case when refunded is not null and measured_rev then round(refunded / 100.0, 2) end,
    'net_collected_usd', case when collected is not null and measured_rev then round((collected - refunded) / 100.0, 2) end,
    'first_three_months_usd', case when first90 is not null and measured_rev then round(first90 / 100.0, 2) end,
    'registration_to_paid', case when coalesce(regs, 0) > 0 and paid is not null then round(paid::numeric / regs, 4) end,
    'retention', jsonb_build_object('paid', paid_total, 'retained', retained, 'churned', churned,
       'note', 'retained: a second paid invoice and an active subscription; churned: paid once, subscription no longer active'),
    'basis', 'direct attribution only; assisted shown apart and never added. Collected money is Stripe''s invoices less refunds, de-duplicated.');

  -- costs over the same window, pro-rated by month
  select coalesce(sum(coalesce(est_usd, case when status = 'reserved' then reserved_usd else 0 end)), 0) into ai_est from content_engine.ai_calls where created_at >= f;
  select coalesce(sum(amount_usd) filter (where category = 'ai_billed'), 0), coalesce(sum(amount_usd) filter (where category <> 'ai_billed'), 0)
    into ai_billed, other_cost from content_engine.costs where month >= date_trunc('month', f)::date;
  total_cost := case when ai_billed > 0 then ai_billed else ai_est end + other_cost;
  cost := jsonb_build_object('ai_estimated_usd', round(ai_est, 2), 'ai_billed_usd', round(ai_billed, 2), 'other_usd', round(other_cost, 2),
    'total_usd', round(total_cost, 2), 'basis', case when ai_billed > 0 then 'AI: billed amounts you entered' else 'AI: estimated from token counts (enter the invoice under Costs for billed)' end,
    'cac_usd', case when coalesce(paid, 0) > 0 then round(total_cost / paid, 2) end,
    'revenue_to_cost', case when total_cost > 0 and first90 is not null and measured_rev then round((first90 / 100.0) / total_cost, 2) end,
    'positive_return', case when total_cost > 0 and collected is not null and measured_rev then (collected - refunded) / 100.0 > total_cost end);

  -- the targets
  targets := jsonb_build_array(
    jsonb_build_object('key', 'articles_per_week', 'label', 'Publisher-ready articles a week', 'group', 'production', 'target', (tg ->> 'articles_per_week')::numeric,
      'actual', round(approved / (d / 7.0), 1), 'measured', true, 'ramped', false),
    jsonb_build_object('key', 'articles_per_month', 'label', 'Completed articles a month', 'group', 'production', 'target', (tg ->> 'articles_per_month')::numeric,
      'actual', round(sent / scale, 1), 'measured', true, 'ramped', false),
    jsonb_build_object('key', 'first_pass_rate', 'label', 'Pass the automated checks on first generation', 'group', 'production', 'target', (tg ->> 'first_pass_rate')::numeric,
      'actual', case when gated > 0 then round(firstpass_auto::numeric / gated, 3) end, 'measured', gated > 0, 'ramped', false, 'unit', 'rate'),
    jsonb_build_object('key', 'factual_errors', 'label', 'Published articles with a recorded factual error', 'group', 'production', 'target', 0,
      'actual', (select count(*) from content_engine.events e where e.kind = 'correction_recorded' and e.at >= f), 'measured', true, 'ramped', false, 'lower_is_better', true),
    jsonb_build_object('key', 'ai_budget', 'label', 'AI spend this month (estimated)', 'group', 'production', 'target', s.ai_monthly_budget_usd,
      'actual', (content_engine.ai_month() ->> 'committed_usd')::numeric, 'measured', true, 'ramped', false, 'lower_is_better', true, 'unit', 'usd'),
    jsonb_build_object('key', 'active_publishers', 'label', 'Active publishing partners', 'group', 'distribution', 'target', (tg ->> 'active_publishers')::numeric,
      'actual', pubs, 'measured', true, 'ramped', true),
    jsonb_build_object('key', 'placements_per_month', 'label', 'External placements a month', 'group', 'distribution', 'target', (tg ->> 'placements_per_month')::numeric,
      'actual', round(published / scale, 1), 'measured', true, 'ramped', true),
    jsonb_build_object('key', 'referral_visits_per_month', 'label', 'Publisher referral visits a month', 'group', 'distribution', 'target', (tg ->> 'referral_visits_per_month')::numeric,
      'actual', case when visits is not null then round(visits / scale) end, 'measured', measured_visits, 'ramped', true),
    jsonb_build_object('key', 'registrations_per_month', 'label', 'Free registrations a month (direct)', 'group', 'distribution', 'target', (tg ->> 'registrations_per_month')::numeric,
      'actual', case when regs is not null then round(regs / scale, 1) end, 'measured', measured_regs, 'ramped', true),
    jsonb_build_object('key', 'paid_per_month', 'label', 'Paid subscribers a month (direct)', 'group', 'revenue', 'target', (tg ->> 'paid_per_month')::numeric,
      'actual', case when paid is not null then round(paid / scale, 1) end, 'measured', measured_paid, 'ramped', true),
    jsonb_build_object('key', 'new_mrr_usd_per_month', 'label', 'New attributable MRR a month', 'group', 'revenue', 'target', (tg ->> 'new_mrr_usd_per_month')::numeric,
      'actual', case when mrr is not null then round(mrr / 100.0 / scale, 2) end, 'measured', measured_paid and measured_rev, 'ramped', true, 'unit', 'usd'),
    jsonb_build_object('key', 'cac_max_usd', 'label', 'Cost per acquired customer', 'group', 'revenue', 'target', (tg ->> 'cac_max_usd')::numeric,
      'actual', case when coalesce(paid, 0) > 0 then round(total_cost / paid, 2) end, 'measured', coalesce(paid, 0) > 0, 'ramped', false, 'lower_is_better', true, 'unit', 'usd'),
    jsonb_build_object('key', 'revenue_to_cost_min', 'label', 'First-three-month revenue to cost', 'group', 'revenue', 'target', (tg ->> 'revenue_to_cost_min')::numeric,
      'actual', case when total_cost > 0 and first90 is not null and measured_rev then round((first90 / 100.0) / total_cost, 2) end,
      'measured', total_cost > 0 and measured_rev, 'ramped', false));
  select jsonb_agg(x || jsonb_build_object(
      'needed_now', case when (x ->> 'ramped')::boolean then round((x ->> 'target')::numeric * ramp, 2) else (x ->> 'target')::numeric end,
      'status', case when not (x ->> 'measured')::boolean or x ->> 'actual' is null then 'not_measured'
                     when coalesce((x ->> 'lower_is_better')::boolean, false) then case when (x ->> 'actual')::numeric <= (x ->> 'target')::numeric then 'met' else 'behind' end
                     when (x ->> 'actual')::numeric >= (x ->> 'target')::numeric then 'met'
                     when (x ->> 'ramped')::boolean and (x ->> 'actual')::numeric >= (x ->> 'target')::numeric * ramp then 'on_track'
                     else 'behind' end))
    into targets from jsonb_array_elements(targets) x;

  -- the bottleneck: the first funnel stage below the rate the targets imply,
  -- with enough of a sample to say so
  bottleneck := case
    when round(approved / (d / 7.0), 1) < (tg ->> 'articles_per_week')::numeric then
      jsonb_build_object('stage', 'production', 'label', 'Not enough articles', 'evidence', approved || ' approved in ' || d || ' days; target ' || (tg ->> 'articles_per_week') || ' a week')
    when sent >= 3 and published::numeric / sent < 0.5 then
      jsonb_build_object('stage', 'acceptance', 'label', 'Low publication acceptance', 'evidence', published || ' of ' || sent || ' sent articles were published')
    when published > 0 and measured_visits and coalesce(visits, 0)::numeric / published < (tg ->> 'referral_visits_per_month')::numeric / greatest(1, (tg ->> 'placements_per_month')::numeric) then
      jsonb_build_object('stage', 'traffic', 'label', 'Weak referral traffic', 'evidence', coalesce(visits, 0) || ' visits from ' || published || ' placements; the targets need about '
        || round((tg ->> 'referral_visits_per_month')::numeric / greatest(1, (tg ->> 'placements_per_month')::numeric)) || ' each')
    when coalesce(visits, 0) >= 50 and coalesce(regs, 0)::numeric / visits < (tg ->> 'registrations_per_month')::numeric / greatest(1, (tg ->> 'referral_visits_per_month')::numeric) then
      jsonb_build_object('stage', 'signup', 'label', 'Weak sign-up conversion', 'evidence', coalesce(regs, 0) || ' registrations from ' || visits || ' visits')
    when coalesce(regs, 0) >= 10 and coalesce(paid, 0)::numeric / regs < (tg ->> 'paid_per_month')::numeric / greatest(1, (tg ->> 'registrations_per_month')::numeric) then
      jsonb_build_object('stage', 'paid', 'label', 'Weak paid conversion', 'evidence', coalesce(paid, 0) || ' paid from ' || regs || ' registrations')
    when total_cost > s.ai_monthly_budget_usd * scale * 2 or (coalesce(paid, 0) > 0 and total_cost / paid > (tg ->> 'cac_max_usd')::numeric) then
      jsonb_build_object('stage', 'cost', 'label', 'Excessive production cost', 'evidence', '$' || round(total_cost, 2) || ' spent' || case when coalesce(paid, 0) > 0 then ', $' || round(total_cost / paid, 2) || ' per customer' else '' end)
    when coalesce(visits, 0) < 50 and published > 0 then
      jsonb_build_object('stage', 'insufficient_data', 'label', 'Too little traffic to judge conversion yet', 'evidence', coalesce(visits, 0) || ' visits so far')
    else jsonb_build_object('stage', 'none', 'label', 'No stage is below the rate the targets need', 'evidence', null) end;

  return jsonb_build_object('window', jsonb_build_object('from', f, 'to', t, 'days', d),
    'program', jsonb_build_object('started', s.program_started_at, 'day', elapsed, 'ramp', round(ramp, 2), 'ramp_days', tg ->> 'ramp_days'),
    'production', prod, 'distribution', dist, 'revenue', rev, 'costs', cost, 'targets', targets, 'bottleneck', bottleneck,
    'measured', jsonb_build_object('visits', measured_visits, 'registrations', measured_regs, 'trials_paid', measured_paid, 'revenue', measured_rev),
    'note', 'Counts and sums only, owners excluded. Registrations are confirmed addresses. Visits are anonymous page loads and cannot be verified; trials, payments and revenue come from Stripe''s verified webhook events.');
end $$;

-- THE WEEKLY SUMMARY'S DATA: what earned publication, traffic, sign-ups and
-- money, which checks keep failing, which AI work was wasted. The page turns
-- it into recommendations (lib/content_engine.js weeklyReview), with
-- sample-size guards; nothing here changes the engine.
create or replace function public.content_engine_weekly_data(p_days int default 28)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare d int := greatest(7, least(coalesce(p_days, 28), 180)); f timestamptz := now() - make_interval(days => greatest(7, least(coalesce(p_days, 28), 180)));
begin
  perform content_engine.require_owner();
  return jsonb_build_object('days', d, 'from', f, 'to', now(),
    'articles', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'format', a.format, 'kind', o.kind, 'league', o.league,
        'publisher', p.name, 'status', a.status, 'created_at', a.created_at, 'sent_at', a.sent_at, 'published_at', a.published_at,
        'generator', a.generator, 'first_gate', a.first_gate_verdict, 'first_gate_blocked', to_jsonb(a.first_gate_blocked), 'gate', a.gate_verdict,
        'campaign', a.campaign_code, 'funnel', content_engine.first_party(a.campaign_code)) order by a.created_at desc)
        from content_engine.articles a join content_engine.opportunities o on o.id = a.opportunity_id left join content_engine.publishers p on p.id = a.publisher_id
       where a.created_at >= f or a.sent_at >= f or a.published_at >= f), '[]'::jsonb),
    'gate_failures', coalesce((select jsonb_object_agg(k, n) from (select k, count(*) n from content_engine.events e, jsonb_array_elements_text(e.detail -> 'blocked') k
        where e.kind = 'gate_run' and e.at >= f group by k) x), '{}'::jsonb),
    'ai', coalesce((select jsonb_build_object('calls', count(*) filter (where status in ('completed', 'failed')), 'accepted', count(*) filter (where outcome = 'accepted'),
        'discarded', count(*) filter (where outcome = 'discarded'), 'failed', count(*) filter (where outcome in ('error', 'refused', 'max_tokens', 'unknown')),
        'cache_hits', count(*) filter (where status = 'cache_hit'), 'est_usd', round(coalesce(sum(est_usd), 0), 4),
        'wasted_usd', round(coalesce(sum(est_usd) filter (where outcome in ('discarded', 'error', 'refused', 'max_tokens', 'unknown')), 0), 4),
        'by_operation', coalesce((select jsonb_object_agg(operation, jsonb_build_object('calls', n, 'accepted', ok, 'est_usd', round(usd, 4))) from (
            select operation, count(*) n, count(*) filter (where outcome = 'accepted') ok, sum(coalesce(est_usd, 0)) usd from content_engine.ai_calls
             where created_at >= f and status in ('completed', 'failed') group by operation) z), '{}'::jsonb))
        from content_engine.ai_calls where created_at >= f), '{}'::jsonb));
end $$;

-- =============================================================================
-- 6f. FIRST-PARTY PUBLISHING — EdgeDesk's own Monday/Wednesday/Friday
-- features on edgedesksports.com (tools/editorial/features.js).
--
-- The public copy of a published feature is a committed file
-- (features/records/, rendered by the article build). EVERYTHING ELSE lives
-- here, owner-only: a dry run, an article HELD FOR REVIEW, one scheduled for
-- later today, the owner's approval or rejection. Nothing unpublished is ever
-- written to the public repository or to a public log.
--
-- The rules the job cannot argue with:
--   * fp_mode: 'off' (nothing runs), 'dry_run' (the default: build, gate and
--     record, publish nothing), 'auto' (publish what clears all twelve gates).
--   * the job (schedule) may mark a feature published only when every one of
--     the twelve gates passed AND the mode is 'auto', or when the owner
--     approved THIS text (content hash) — never on its own judgment;
--   * at most fp_max_per_week (≤ 3) published per Central Time week;
--   * a published feature is final here (its page is the record); a rejected
--     one stays rejected; only the owner approves or rejects.
-- =============================================================================
alter table content_engine.settings add column if not exists fp_mode text not null default 'dry_run';
alter table content_engine.settings add column if not exists fp_publish_hour_ct int not null default 7;
alter table content_engine.settings add column if not exists fp_max_per_week int not null default 3;
do $fp$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_fp_shape') then
    alter table content_engine.settings add constraint settings_fp_shape check (
      fp_mode in ('off', 'dry_run', 'auto') and fp_publish_hour_ct between 5 and 20 and fp_max_per_week between 0 and 3);
  end if;
end $fp$;

create table if not exists content_engine.first_party (
  id            text primary key check (id ~ '^feature-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z-]{5,30}$'),
  kind          text not null check (kind in ('weekend_review', 'storylines', 'research_preview')),
  slot_date     date not null,
  week_of       date not null,
  status        text not null check (status in ('dry_run', 'held', 'scheduled', 'approved', 'published', 'rejected', 'skipped')),
  mode          text not null check (mode in ('dry_run', 'auto', 'owner')),
  title         text check (title is null or length(title) between 10 and 200),
  slug          text check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  url           text check (url is null or url ~ '^https://edgedesksports\.com/articles/[a-z0-9-]+/$'),
  article       jsonb,
  content_hash  text,
  gates         jsonb,
  failed        text[] not null default '{}',
  ce_verdict    text,
  reason        text check (reason is null or length(reason) <= 600),
  overlap       jsonb,
  owner_note    text check (owner_note is null or length(owner_note) <= 500),
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz
);
create index if not exists first_party_week on content_engine.first_party (week_of, status);
alter table content_engine.first_party enable row level security;

/* twelve gates, every one passed */
create or replace function content_engine.fp_all_gates(p jsonb)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) = 12
     and not exists (select 1 from jsonb_array_elements(p) g where coalesce((g ->> 'ok')::boolean, false) is not true);
$$;

-- the job's view: the settings, this week's rows, what the owner approved,
-- and the week's publisher articles (title and text, for the duplicate gate)
create or replace function public.content_engine_fp_state(p_week date)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); s content_engine.settings;
begin
  select * into s from content_engine.settings where id = 1;
  return jsonb_build_object(
    'settings', jsonb_build_object('mode', s.fp_mode, 'publish_hour_ct', s.fp_publish_hour_ct, 'max_per_week', s.fp_max_per_week),
    'week', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'status', f.status, 'content_hash', f.content_hash, 'published_at', f.published_at) order by f.id)
        from content_engine.first_party f where f.week_of = p_week), '[]'::jsonb),
    'approved', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'article', f.article, 'content_hash', f.content_hash, 'decided_at', f.decided_at) order by f.id)
        from content_engine.first_party f where f.status = 'approved'), '[]'::jsonb),
    'published', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'slug', f.slug, 'article', f.article, 'published_at', f.published_at) order by f.id)
        from content_engine.first_party f where f.status = 'published' and f.published_at > now() - interval '21 days'), '[]'::jsonb),
    'publisher_texts', coalesce((select jsonb_agg(jsonb_build_object('label', coalesce(p.name, 'a publisher') || ': ' || a.title,
          'text', (select string_agg(x ->> 'body', E'\n\n') from jsonb_array_elements(a.sections) x)))
        from content_engine.articles a join content_engine.publishers p on p.id = a.publisher_id
       where a.status <> 'archived' and a.created_at > now() - interval '10 days'), '[]'::jsonb));
end $$;

-- record a run's outcome for one slot (the job, or the owner's preview)
create or replace function public.content_engine_fp_record(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare who text := content_engine.require_actor(); s content_engine.settings; cur content_engine.first_party;
  st text := p ->> 'status'; wk date; n int;
begin
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'id', '') = '' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  select * into s from content_engine.settings where id = 1;
  select * into cur from content_engine.first_party where id = p ->> 'id' for update;
  if cur.id is not null and cur.status = 'published' then return jsonb_build_object('ok', false, 'reason', 'already_published'); end if;
  if cur.id is not null and cur.status = 'rejected' and who = 'schedule' then return jsonb_build_object('ok', false, 'reason', 'rejected_by_owner'); end if;
  if st in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'owner_decides', 'detail', 'approve or reject with content_engine_fp_decide'); end if;
  if st not in ('dry_run', 'held', 'scheduled', 'published', 'skipped') then return jsonb_build_object('ok', false, 'reason', 'bad_status'); end if;
  /* an approved article keeps its approval only while its text is unchanged */
  if cur.id is not null and cur.status = 'approved' and st not in ('published', 'skipped') and cur.content_hash is not distinct from p ->> 'content_hash' then
    return jsonb_build_object('ok', true, 'unchanged', true, 'status', 'approved');
  end if;
  wk := (p ->> 'week_of')::date;
  if st = 'published' then
    if s.fp_mode = 'off' then return jsonb_build_object('ok', false, 'reason', 'mode_off'); end if;
    /* coalesce: with no row yet, cur.status is NULL, and NOT (false OR NULL)
       is NULL, which an IF reads as "do not refuse" */
    if not coalesce((s.fp_mode = 'auto' and content_engine.fp_all_gates(p -> 'gates'))
            or (cur.status = 'approved' and cur.content_hash = p ->> 'content_hash'), false) then
      return jsonb_build_object('ok', false, 'reason', 'not_cleared', 'detail', 'publishing needs all twelve gates in auto mode, or the owner''s approval of this exact text');
    end if;
    select count(*) into n from content_engine.first_party where week_of = wk and status = 'published';
    if n >= s.fp_max_per_week then return jsonb_build_object('ok', false, 'reason', 'weekly_cap', 'published', n); end if;
  end if;
  insert into content_engine.first_party as f (id, kind, slot_date, week_of, status, mode, title, slug, url, article, content_hash, gates, failed, ce_verdict, reason, overlap, published_at)
  values (p ->> 'id', p ->> 'kind', (p ->> 'slot_date')::date, wk, st,
          case when cur.status = 'approved' then 'owner' else coalesce(p ->> 'mode', 'dry_run') end,
          p ->> 'title', p ->> 'slug', p ->> 'url', p -> 'article', p ->> 'content_hash', p -> 'gates',
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'failed') x), '{}'), p ->> 'ce_verdict', left(p ->> 'reason', 600), p -> 'overlap',
          case when st = 'published' then now() end)
  on conflict (id) do update set status = excluded.status, mode = excluded.mode, title = excluded.title, slug = excluded.slug, url = excluded.url,
    article = excluded.article, content_hash = excluded.content_hash, gates = excluded.gates, failed = excluded.failed, ce_verdict = excluded.ce_verdict,
    reason = excluded.reason, overlap = excluded.overlap, updated_at = now(), published_at = excluded.published_at,
    decided_by = case when f.content_hash is distinct from excluded.content_hash then null else f.decided_by end,
    decided_at = case when f.content_hash is distinct from excluded.content_hash then null else f.decided_at end;
  perform content_engine.log(who, 'fp_' || st, null, null, null, jsonb_build_object('id', p ->> 'id', 'kind', p ->> 'kind', 'failed', p -> 'failed'));
  return jsonb_build_object('ok', true, 'status', st);
exception when check_violation or invalid_text_representation or invalid_datetime_format or not_null_violation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- the owner's list (everything, including what was never published)
create or replace function public.content_engine_fp_list(p_limit int default 40)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform content_engine.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(f) order by f.slot_date desc, f.id desc) from (
    select * from content_engine.first_party order by slot_date desc, id desc limit greatest(1, least(coalesce(p_limit, 40), 200))) f), '[]'::jsonb);
end $$;

-- the owner's decision on a held feature: approve THIS text, reject, or reopen
create or replace function public.content_engine_fp_decide(p_id text, p_decision text, p_note text, p_content_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner(); cur content_engine.first_party;
begin
  select * into cur from content_engine.first_party where id = p_id for update;
  if cur.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if cur.status = 'published' then return jsonb_build_object('ok', false, 'reason', 'already_published'); end if;
  if p_decision = 'approve' then
    if cur.status not in ('held', 'dry_run', 'scheduled') then return jsonb_build_object('ok', false, 'reason', 'not_approvable', 'status', cur.status); end if;
    if cur.content_hash is distinct from p_content_hash then return jsonb_build_object('ok', false, 'reason', 'changed_since_loaded'); end if;
    if cur.article is null then return jsonb_build_object('ok', false, 'reason', 'no_article'); end if;
    update content_engine.first_party set status = 'approved', decided_by = v, decided_at = now(), owner_note = nullif(btrim(p_note), ''), updated_at = now() where id = p_id;
  elsif p_decision = 'reject' then
    update content_engine.first_party set status = 'rejected', decided_by = v, decided_at = now(), owner_note = nullif(btrim(p_note), ''), updated_at = now() where id = p_id;
  elsif p_decision = 'reopen' then
    if cur.status not in ('rejected', 'approved') then return jsonb_build_object('ok', false, 'reason', 'not_reopenable'); end if;
    update content_engine.first_party set status = 'held', decided_by = null, decided_at = null, owner_note = nullif(btrim(p_note), ''), updated_at = now() where id = p_id;
  else
    return jsonb_build_object('ok', false, 'reason', 'bad_decision');
  end if;
  perform content_engine.log('owner', 'fp_' || p_decision, null, null, null, jsonb_build_object('id', p_id));
  return jsonb_build_object('ok', true);
exception when check_violation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
end $$;

-- the owner's switch: off, dry run, or auto (the default is dry run)
create or replace function public.content_engine_fp_settings_save(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := content_engine.require_owner();
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;
  update content_engine.settings set
    fp_mode = coalesce(p ->> 'fp_mode', fp_mode),
    fp_publish_hour_ct = coalesce((p ->> 'fp_publish_hour_ct')::int, fp_publish_hour_ct),
    fp_max_per_week = coalesce((p ->> 'fp_max_per_week')::int, fp_max_per_week)
   where id = 1;
  perform content_engine.log('owner', 'settings_changed', null, null, null, jsonb_build_object('first_party', p));
  return jsonb_build_object('ok', true, 'settings', (select jsonb_build_object('mode', fp_mode, 'publish_hour_ct', fp_publish_hour_ct, 'max_per_week', fp_max_per_week) from content_engine.settings where id = 1));
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', 'mode off, dry_run or auto; publish hour 5–20 CT; at most 3 a week');
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
    if f::text ~ '^content_engine_(opportunity_upsert|article_create|article_save|article_submit|article\(|article_gate|ai_reserve|ai_settle|spend|log|search_evidence|job_|fp_state|fp_record)' then
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
         'revisions, deliveries, performance, events, benchmarks, costs'
  union all
  select 'owner list available',
         to_regprocedure('growth_outbound.owner_active(uuid)') is not null,
         (select count(*)::text || ' outbound owner(s)' from growth_outbound.owners)
  union all
  select 'first publisher seeded (editorial only)',
         exists (select 1 from content_engine.publishers where slug = 'stadium-rant'),
         'contacts and benchmarks are entered by the owner in /admin/content/'
  union all
  select 'editorial gate enforced (approve, Ready to Send, Send)',
         to_regprocedure('content_engine.gate_problem(content_engine.articles)') is not null
         and pg_get_functiondef('content_engine.articles_guard()'::regprocedure) like '%run the editorial gate%',
         'a BLOCKED, stale or missing gate report stops approval, Ready to Send and Send — in the doors and in the table''s own trigger'
  union all
  select 'AI budget: reservations serialized and capped monthly',
         to_regprocedure('public.content_engine_ai_reserve(text, uuid, text, text, integer, integer, integer)') is not null
         and not has_function_privilege('anon', 'public.content_engine_ai_reserve(text, uuid, text, text, integer, integer, integer)', 'execute'),
         (select '$' || ai_monthly_budget_usd::text || ' a month; ' || (content_engine.ai_month() ->> 'level') || '% used (estimated)' from content_engine.settings where id = 1)
  union all
  select 'scorecard and attribution are owner-only',
         not has_function_privilege('service_role', 'public.content_engine_scorecard(integer)', 'execute')
         and not has_function_privilege('anon', 'public.content_engine_scorecard(integer)', 'execute'),
         'funnel, revenue and costs: counts and sums only, owners excluded, no identities returned'
  union all
  select 'first-party features: owner decides, the job never approves',
         not has_function_privilege('service_role', 'public.content_engine_fp_decide(text, text, text, text)', 'execute')
         and not has_function_privilege('service_role', 'public.content_engine_fp_settings_save(jsonb)', 'execute')
         and not has_function_privilege('anon', 'public.content_engine_fp_state(date)', 'execute'),
         (select 'mode ' || fp_mode || ' (dry_run publishes nothing); at most ' || fp_max_per_week || ' a week; ' || fp_publish_hour_ct || ':00 CT' from content_engine.settings where id = 1)
  union all
  select 'first-party measurement tables',
         to_regclass('public.acquisition_visitors') is not null and to_regclass('public.user_acquisition') is not null,
         'without growth.sql the conversion figures read "not measured"'
) r;

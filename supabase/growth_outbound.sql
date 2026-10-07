-- =============================================================================
-- growth_outbound — the OWNER-ONLY outbound prospecting engine's database.
--
-- THE RULE EVERYTHING HERE SERVES
--   Software may find, research, score, verify, draft and queue.
--   Software may NOT approve or send. A draft becomes approved only by an
--   outbound OWNER pressing approve, for the exact content they reviewed, and
--   a send can only exist for such a draft. Both are enforced HERE, by the
--   database, not by a page.
--
-- WHO MAY SEE ANY OF IT
--   normal user  <  affiliate_admin  <  outbound owner
--
--   growth_outbound.owners is its own explicit list. Every owner must ALSO be
--   in public.affiliate_admins (a foreign key, cascading), but being an
--   affiliate admin grants NOTHING here: partner-program operators keep the
--   partner, growth and billing consoles exactly as before and never see a
--   prospect, an email address, a draft, a send, a suppression or a setting.
--   public.affiliate_admins, affiliate_is_admin() and growth_is_admin() are
--   not touched by this file.
--
-- FIVE LAYERS, EACH ENOUGH ON ITS OWN
--   1  NOT SERVED. Every table lives in the schema growth_outbound, which is
--      not in PostgREST's db-schemas list: no REST path reaches a row.
--   2  NO PRIVILEGE. anon, authenticated, service_role and PUBLIC hold no
--      USAGE on the schema and no privilege on any table, sequence or helper.
--   3  DEFAULT-DENY RLS. Row level security is on for every table, with a
--      RESTRICTIVE deny-all policy for anon and authenticated, so even a
--      mistaken grant plus a mistaken permissive policy still returns nothing.
--   4  OWNER DOORS. The only way in is a public.growth_outbound_* security-
--      definer function whose FIRST statement is growth_outbound.require_owner()
--      — auth.uid() must be in owners and still in affiliate_admins. A
--      subscriber, a partner, an affiliate admin and the service role (which
--      has no auth.uid()) are refused before anything else runs.
--   5  INVARIANTS ON THE TABLES THEMSELVES (triggers no code path can skip):
--        an owner row cannot be written by anything that arrived through the
--          API — not even a security-definer function someone adds later;
--        a draft becomes 'approved' only inside the approve door, by a current
--          owner, for its current content hash and recipient;
--        an approved draft cannot change; editing it puts it back in review;
--        a send row exists only for an approved, unsuppressed draft, to the
--          approved recipient (or, in test mode, ONLY the owner's test inbox),
--          once per draft, once per address per step, under the daily cap,
--          and only while the compliance configuration is complete;
--        suppressions, the activity log and the owner audit are append-only;
--          prospects, evidence and drafts are never deleted;
--        a prospect's name, organization, confidences, fit score, email
--          status and research status are COMPUTED from stored evidence by
--          evaluate() — no statement writes them, the superuser's included —
--          so uncertain information never becomes confident because somebody
--          (or some model) repeated it; evidence is never rewritten, only
--          superseded; an email address or profile names one prospect.
--
-- BOOTSTRAP (Supabase SQL editor only, AFTER this file has run — see
-- docs/growth-outbound.md). The address goes in plain, with no < >:
--   select growth_outbound.grant_owner('you@example.com');
--
-- No pgcrypto: hashes are core sha256(), tokens core gen_random_uuid(), so the
-- pinned search_path of every function resolves on any project.
--
-- RUN ORDER. affiliates.sql, growth.sql, then this file (the guard says so).
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.affiliate_admins') is null or to_regprocedure('public.affiliate_is_admin()') is null then
    raise exception 'Run supabase/affiliates.sql first (outbound owners sit inside its operator list).';
  end if;
  if to_regprocedure('public.growth_is_admin()') is null then
    raise exception 'Run supabase/growth.sql first (this extends the growth console).';
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'auth.uid() is missing: this file must run on a Supabase project.';
  end if;
end
$guard$;

create schema if not exists growth_outbound;
comment on schema growth_outbound is
  'Owner-only outbound prospecting. NOT served by PostgREST and not usable by any client role: '
  'every read and write goes through a public.growth_outbound_* door that checks growth_outbound.owners.';

-- ── re-running this file on a live site: every lock first, all or nothing ──
do $locks$
declare
  v_list text;
  v_try int := 0;
begin
  select string_agg(t, ', ') into v_list from unnest(array[
    'growth_outbound.owners', 'growth_outbound.owner_audit', 'growth_outbound.settings',
    'growth_outbound.prospects', 'growth_outbound.evidence', 'growth_outbound.drafts',
    'growth_outbound.sends', 'growth_outbound.suppressions', 'growth_outbound.activity',
    'growth_outbound.identifiers', 'growth_outbound.fit_factor_catalog']) t
  where to_regclass(t) is not null;
  if v_list is null then return; end if;
  loop
    begin
      execute 'lock table ' || v_list || ' in access exclusive mode nowait';
      return;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 150 then
        raise exception 'could not lock % within 30 seconds. Nothing was changed: run this file again in a minute.', v_list;
      end if;
      perform pg_sleep(0.2);
    end;
  end loop;
end
$locks$;

-- =============================================================================
-- 1. SMALL HELPERS (private schema; no client role can call them)
-- =============================================================================

-- Did this statement arrive through the API? PostgREST logs in as
-- `authenticator`, SETs the request role (visible in the role setting even
-- inside a security-definer function) and publishes the JWT claims. A session
-- in the SQL editor, a migration or pg_cron has none of these.
create or replace function growth_outbound.api_origin()
returns boolean language sql stable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated', 'service_role')
      or session_user = 'authenticator'
      or coalesce(nullif(current_setting('request.jwt.claims', true), ''),
                  nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claim.role', true), '')) is not null;
$$;

create or replace function growth_outbound.norm_email(p text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select nullif(lower(btrim(coalesce(p, ''))), '');
$$;

create or replace function growth_outbound.valid_email(p text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select p is not null and length(p) between 6 and 254
     and p ~* '^[a-z0-9._%+''-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$';
$$;

create or replace function growth_outbound.email_domain(p text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select nullif(split_part(coalesce(p, ''), '@', 2), '');
$$;

create or replace function growth_outbound.content_hash(p_subject text, p_text text, p_html text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(coalesce(p_subject, '') || chr(31) || coalesce(p_text, '') || chr(31) || coalesce(p_html, ''), 'UTF8')), 'hex');
$$;

-- =============================================================================
-- 2. THE OWNERS — the explicit authorization primitive
-- =============================================================================
create table if not exists growth_outbound.owners (
  user_id     uuid primary key references public.affiliate_admins (user_id) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  text not null default session_user,
  note        text
);
comment on table growth_outbound.owners is
  'Outbound OWNERS: the only accounts that may read or act on anything in growth_outbound. Every owner '
  'must be an affiliate admin (FK, cascading on removal), but an affiliate admin is NOT an owner unless '
  'listed here. Written only from the SQL editor: a trigger refuses any write that arrives through the API.';

create table if not exists growth_outbound.owner_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  action      text not null,
  user_id     uuid not null,
  email       text,
  db_login    text not null default session_user,
  db_role     text not null default current_user,
  note        text
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'owner_audit_action_ck') then
    alter table growth_outbound.owner_audit add constraint owner_audit_action_ck check (action in ('granted', 'changed', 'revoked'));
  end if;
end $c$;

create or replace function growth_outbound.owners_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  -- NO SELF-ENROLLMENT, BY ANY ROUTE THROUGH THE API. Checked on the row, so
  -- it holds even inside a security-definer function added later by mistake.
  if growth_outbound.api_origin() then
    raise exception 'outbound owners are granted in the Supabase SQL editor only'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'an owner grant cannot be moved to another account; revoke it and grant anew'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists owners_guard_t on growth_outbound.owners;
create trigger owners_guard_t before insert or update on growth_outbound.owners
  for each row execute function growth_outbound.owners_guard();

create or replace function growth_outbound.owners_audit()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare v_uid uuid := coalesce(new.user_id, old.user_id);
begin
  insert into growth_outbound.owner_audit (action, user_id, email, note)
  values (case tg_op when 'INSERT' then 'granted' when 'UPDATE' then 'changed' else 'revoked' end,
          v_uid, (select u.email from auth.users u where u.id = v_uid),
          coalesce(new.note, old.note));
  return null;
end $$;
drop trigger if exists owners_audit_t on growth_outbound.owners;
create trigger owners_audit_t after insert or update or delete on growth_outbound.owners
  for each row execute function growth_outbound.owners_audit();

-- Is THIS account an owner right now? Both lists, every time (no caching).
create or replace function growth_outbound.owner_active(p_user uuid)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p_user is not null and exists (
    select 1 from growth_outbound.owners o
      join public.affiliate_admins a on a.user_id = o.user_id
     where o.user_id = p_user);
$$;

-- The first statement of every owner door. Refuses with 42501 otherwise.
create or replace function growth_outbound.require_owner()
returns uuid language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is null or not growth_outbound.owner_active(v) then
    raise exception 'outbound owner only' using errcode = 'insufficient_privilege';
  end if;
  return v;
end $$;

-- THE BOOTSTRAP, made hard to get wrong. Run in the Supabase SQL editor:
--   select growth_outbound.grant_owner('you@example.com');
-- It says exactly why it refused (address pasted with its < >, no such
-- account, unconfirmed email, not an affiliate admin) instead of quietly
-- inserting nothing. No client role can execute it, and the owners trigger
-- refuses it anyway if it is ever reached through the API.
create or replace function growth_outbound.grant_owner(p_email text, p_note text default 'owner bootstrap')
returns text language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid uuid;
  v_confirmed boolean;
  v_n int;
begin
  if growth_outbound.api_origin() then
    raise exception 'outbound owners are granted in the Supabase SQL editor only' using errcode = 'insufficient_privilege';
  end if;
  if v_email ~ '[<>]' then
    raise exception 'remove the < > around the address: grant_owner(''%'')', btrim(v_email, '<> ');
  end if;
  if not growth_outbound.valid_email(v_email) then
    raise exception '"%" is not an email address', p_email;
  end if;
  select count(*) into v_n from auth.users u where lower(u.email) = v_email;
  if v_n = 0 then raise exception 'no EdgeDesk account uses %', v_email; end if;
  if v_n > 1 then raise exception '% accounts share %: grant by id instead', v_n, v_email; end if;
  select u.id, u.email_confirmed_at is not null into v_uid, v_confirmed from auth.users u where lower(u.email) = v_email;
  if not v_confirmed then raise exception '% has not confirmed its email address yet', v_email; end if;
  if not exists (select 1 from public.affiliate_admins a where a.user_id = v_uid) then
    raise exception '% is not an affiliate admin: an outbound owner must be one first (add them to public.affiliate_admins)', v_email;
  end if;
  if exists (select 1 from growth_outbound.owners where user_id = v_uid) then
    return 'ok — ' || v_email || ' is already an outbound owner';
  end if;
  insert into growth_outbound.owners (user_id, note) values (v_uid, left(coalesce(p_note, 'owner bootstrap'), 200));
  return 'ok — ' || v_email || ' (' || v_uid || ') is now an outbound owner';
end $$;

-- The one question a signed-in account may ask: am I an outbound owner?
create or replace function public.growth_outbound_is_owner()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select growth_outbound.owner_active(auth.uid());
$$;

-- =============================================================================
-- 3. SETTINGS — one row; no secrets (those are Edge Function secrets)
-- =============================================================================
create table if not exists growth_outbound.settings (
  id                          int primary key default 1,
  automation_enabled          boolean not null default false,
  test_mode                   boolean not null default true,
  test_inbox                  text,
  daily_prospect_target       int not null default 15,
  max_sends_per_day           int not null default 20,
  max_test_sends_per_day      int not null default 25,
  min_fit_score               int not null default 80,
  min_identity_confidence     numeric not null default 0.90,
  min_role_confidence         numeric not null default 0.85,
  min_research_confidence     numeric not null default 0.85,
  min_email_confidence        numeric not null default 0.90,
  followup_enabled            boolean not null default true,
  followup_delay_days         int not null default 5,
  final_followup_enabled      boolean not null default false,
  final_followup_delay_days   int not null default 10,
  sender_name                 text not null default 'Davis',
  sender_email                text not null default 'davis@edgedesksports.com',
  reply_to_email              text,
  cta_url                     text not null default 'https://edgedesksports.com/',
  business_name               text not null default 'EdgeDesk Sports',
  postal_address              text,
  unsubscribe_url_base        text,
  discovery_config            jsonb not null default '{}'::jsonb,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'outbound_settings_singleton') then
    alter table growth_outbound.settings add constraint outbound_settings_singleton check (id = 1);
  end if;
  alter table growth_outbound.settings drop constraint if exists outbound_settings_ranges;
  alter table growth_outbound.settings add constraint outbound_settings_ranges check (
        daily_prospect_target between 1 and 100
    -- THE HARD CEILING. The owner can raise the cap up to here (deliberately,
    -- with confirmation); beyond it takes a change to this file.
    and max_sends_per_day between 1 and 200
    and max_test_sends_per_day between 1 and 100
    and min_fit_score between 0 and 100
    and min_identity_confidence between 0 and 1 and min_role_confidence between 0 and 1
    and min_research_confidence between 0 and 1 and min_email_confidence between 0 and 1
    and followup_delay_days between 2 and 30 and final_followup_delay_days between 3 and 60
    and length(btrim(sender_name)) between 1 and 60
    and length(btrim(business_name)) between 1 and 120
    and (postal_address is null or length(btrim(postal_address)) between 10 and 300));
  alter table growth_outbound.settings drop constraint if exists outbound_settings_addresses;
  alter table growth_outbound.settings add constraint outbound_settings_addresses check (
    -- the sender is always on EdgeDesk's own domain, and the call to action
    -- always points at EdgeDesk: a hijacked session cannot turn the engine
    -- into a mailer for somebody else's domain or link
        sender_email ~ '^[a-z0-9._%+-]+@edgedesksports\.com$'
    and (reply_to_email is null or reply_to_email ~ '^[a-z0-9._%+-]+@edgedesksports\.com$')
    and (test_inbox is null or growth_outbound.valid_email(test_inbox))
    and cta_url ~ '^https://(www\.)?edgedesksports\.com(/|$)'
    and (unsubscribe_url_base is null or unsubscribe_url_base ~ '^https://[a-z0-9.-]+\.(supabase\.co|edgedesksports\.com)/')
    and jsonb_typeof(discovery_config) = 'object');
end $c$;
insert into growth_outbound.settings (id) values (1) on conflict (id) do nothing;

-- What stops a real send right now, in words. Empty means nothing does.
create or replace function growth_outbound.send_blockers()
returns text[] language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select array_remove(array[
    case when s.postal_address is null or btrim(s.postal_address) = '' then 'postal_address_missing' end,
    case when s.unsubscribe_url_base is null then 'unsubscribe_endpoint_missing' end,
    case when s.test_mode and s.test_inbox is null then 'test_inbox_missing' end,
    case when not exists (select 1 from growth_outbound.owners) then 'no_outbound_owner' end
  ], null)
  from growth_outbound.settings s where s.id = 1;
$$;

-- =============================================================================
-- 4. PROSPECTS, EVIDENCE, DRAFTS, SENDS, SUPPRESSIONS, ACTIVITY
-- =============================================================================
create table if not exists growth_outbound.prospects (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  is_test                 boolean not null default false,
  full_name               text,
  first_name              text,
  last_name               text,
  organization            text,
  job_title               text,
  website_url             text,
  x_url                   text,
  youtube_url             text,
  newsletter_url          text,
  other_profile_url       text,
  avatar_url              text,
  email                   text,
  email_status            text not null default 'none',
  email_source_url        text,
  email_source_kind       text,
  prospect_type           text not null default 'other',
  campaign_type           text not null default 'customer',
  sports_focus            text[] not null default '{}',
  audience_size_estimate  int,
  audience_source_url     text,
  fit_score               int,
  fit_reason              text,
  fit_factors             jsonb not null default '[]'::jsonb,
  identity_confidence     numeric,
  role_confidence         numeric,
  email_confidence        numeric,
  research_confidence     numeric,
  fit_confidence          numeric,
  research_summary        text,
  personalization_angle   text,
  warnings                jsonb not null default '[]'::jsonb,
  status                  text not null default 'discovered',
  status_reason           text,
  attribution_token       text not null default replace(gen_random_uuid()::text, '-', ''),
  discovered_via          text,
  discovered_at           timestamptz not null default now(),
  last_researched_at      timestamptz
);
do $c$ begin
  alter table growth_outbound.prospects drop constraint if exists prospects_shape_ck;
  alter table growth_outbound.prospects add constraint prospects_shape_ck check (
        email_status in ('none', 'unverified', 'verified', 'risky', 'invalid')
    and campaign_type in ('customer', 'partnership')
    and status in ('discovered', 'needs_research', 'qualified', 'ready_for_review', 'contacted',
                   'replied', 'converted', 'rejected', 'suppressed')
    and prospect_type in ('analytics_creator', 'football_analyst', 'cfb_analyst', 'nfl_analyst', 'quant_researcher',
                          'modeling_creator', 'newsletter_writer', 'analytics_newsletter', 'fantasy_analyst',
                          'props_analyst', 'podcast', 'media_founder', 'youtube_creator', 'community_operator',
                          'betting_educator', 'handicapper_modeler', 'other')
    and (fit_score is null or fit_score between 0 and 100)
    and (identity_confidence is null or identity_confidence between 0 and 1)
    and (role_confidence is null or role_confidence between 0 and 1)
    and (email_confidence is null or email_confidence between 0 and 1)
    and (research_confidence is null or research_confidence between 0 and 1)
    and (fit_confidence is null or fit_confidence between 0 and 1)
    and (email is null or growth_outbound.valid_email(email))
    and jsonb_typeof(fit_factors) = 'array' and jsonb_typeof(warnings) = 'array');
end $c$;
create unique index if not exists prospects_attribution_token_uk on growth_outbound.prospects (attribution_token);
create index if not exists prospects_status_idx on growth_outbound.prospects (status, updated_at desc);
create index if not exists prospects_email_idx on growth_outbound.prospects (email) where email is not null;

create table if not exists growth_outbound.evidence (
  id                    bigint generated always as identity primary key,
  prospect_id           uuid not null references growth_outbound.prospects (id) on delete restrict,
  field_name            text not null,
  claim                 text,
  source_url            text not null,
  source_title          text,
  source_excerpt        text,
  source_published_at   timestamptz,
  observed_at           timestamptz not null default now(),
  confidence            numeric,
  collected_by          text,
  superseded_at         timestamptz
);
do $c$ begin
  alter table growth_outbound.evidence drop constraint if exists evidence_shape_ck;
  alter table growth_outbound.evidence add constraint evidence_shape_ck check (
        source_url ~ '^https?://'
    and (confidence is null or confidence between 0 and 1)
    and length(field_name) between 1 and 60);
end $c$;
create index if not exists evidence_prospect_idx on growth_outbound.evidence (prospect_id, observed_at desc);

create table if not exists growth_outbound.drafts (
  id                   uuid primary key default gen_random_uuid(),
  prospect_id          uuid not null references growth_outbound.prospects (id) on delete restrict,
  sequence_number      int not null default 1,
  campaign_type        text not null default 'customer',
  is_test              boolean not null default false,
  subject              text not null,
  body_text            text not null,
  body_html            text,
  greeting_name        text,
  claims               jsonb not null default '[]'::jsonb,
  content_hash         text not null default '',
  generated_at         timestamptz not null default now(),
  generator_version    text,
  status               text not null default 'pending_review',
  edited_by_owner      boolean not null default false,
  approved_at          timestamptz,
  approved_by          uuid,
  approved_hash        text,
  approved_recipient   text,
  rejected_at          timestamptz,
  rejected_by          uuid,
  rejection_reason     text,
  updated_at           timestamptz not null default now()
);
do $c$ begin
  alter table growth_outbound.drafts drop constraint if exists drafts_shape_ck;
  alter table growth_outbound.drafts add constraint drafts_shape_ck check (
        sequence_number between 1 and 3
    and campaign_type in ('customer', 'partnership')
    and status in ('pending_review', 'approved', 'rejected', 'superseded', 'cancelled', 'sent')
    and length(btrim(subject)) between 1 and 150
    and length(btrim(body_text)) between 1 and 5000
    and jsonb_typeof(claims) = 'array'
    -- an approval is all four facts or none of them
    and ((status in ('approved', 'sent')) = (approved_at is not null and approved_by is not null
                                              and approved_hash is not null and approved_recipient is not null)));
end $c$;
create index if not exists drafts_prospect_idx on growth_outbound.drafts (prospect_id, sequence_number);
-- one live draft per prospect per step
create unique index if not exists drafts_one_live_uk on growth_outbound.drafts (prospect_id, sequence_number)
  where status in ('pending_review', 'approved');

create table if not exists growth_outbound.sends (
  id                    uuid primary key default gen_random_uuid(),
  prospect_id           uuid not null references growth_outbound.prospects (id) on delete restrict,
  draft_id              uuid not null references growth_outbound.drafts (id) on delete restrict,
  sequence_number       int not null,
  is_test               boolean not null default false,
  idempotency_key       text not null,
  sender                text not null,
  intended_recipient    text not null,
  recipient             text not null,
  subject               text not null,
  content_hash          text not null,
  claimed_at            timestamptz not null default now(),
  claimed_by            uuid not null,
  resend_message_id     text,
  sent_at               timestamptz,
  delivery_status       text not null default 'claimed',
  delivered_at          timestamptz,
  bounced_at            timestamptz,
  complained_at         timestamptz,
  failed_at             timestamptz,
  failure_reason        text
);
do $c$ begin
  alter table growth_outbound.sends drop constraint if exists sends_shape_ck;
  alter table growth_outbound.sends add constraint sends_shape_ck check (
    delivery_status in ('claimed', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed'));
end $c$;
create unique index if not exists sends_draft_uk on growth_outbound.sends (draft_id);
create unique index if not exists sends_idempotency_uk on growth_outbound.sends (idempotency_key);
create unique index if not exists sends_message_uk on growth_outbound.sends (resend_message_id) where resend_message_id is not null;
-- a real prospect never receives the same step twice
create unique index if not exists sends_step_once_uk on growth_outbound.sends (prospect_id, sequence_number) where not is_test;
create index if not exists sends_day_idx on growth_outbound.sends (claimed_at) where not is_test;

create table if not exists growth_outbound.suppressions (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  scope        text not null default 'address',
  target       text not null,
  kind         text not null,
  reason       text,
  source       text not null default 'owner',
  prospect_id  uuid references growth_outbound.prospects (id) on delete set null,
  created_by   uuid
);
do $c$ begin
  alter table growth_outbound.suppressions drop constraint if exists suppressions_shape_ck;
  alter table growth_outbound.suppressions add constraint suppressions_shape_ck check (
        scope in ('address', 'domain')
    and kind in ('unsubscribe', 'bounce', 'complaint', 'manual', 'replied', 'do_not_contact')
    and source in ('owner', 'webhook', 'unsubscribe_link', 'reply', 'system')
    and target = lower(btrim(target))
    and ((scope = 'address' and growth_outbound.valid_email(target))
      or (scope = 'domain' and target ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')));
end $c$;
create index if not exists suppressions_target_idx on growth_outbound.suppressions (target);

create table if not exists growth_outbound.activity (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  actor_user_id  uuid,
  actor_kind     text not null default 'owner',
  action         text not null,
  prospect_id    uuid references growth_outbound.prospects (id) on delete set null,
  entity         text,
  entity_id      text,
  detail         jsonb not null default '{}'::jsonb
);
do $c$ begin
  alter table growth_outbound.activity drop constraint if exists activity_shape_ck;
  alter table growth_outbound.activity add constraint activity_shape_ck check (
    actor_kind in ('owner', 'system', 'webhook', 'provider') and jsonb_typeof(detail) = 'object');
end $c$;
create index if not exists activity_at_idx on growth_outbound.activity (at desc);
create index if not exists activity_prospect_idx on growth_outbound.activity (prospect_id, at desc) where prospect_id is not null;

-- Is an address (or its whole domain) suppressed? Kept forever, whatever
-- happens to any prospect row.
create or replace function growth_outbound.is_suppressed(p_email text)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select growth_outbound.norm_email(p_email) is not null and exists (
    select 1 from growth_outbound.suppressions s
     where (s.scope = 'address' and s.target = growth_outbound.norm_email(p_email))
        or (s.scope = 'domain' and s.target = growth_outbound.email_domain(growth_outbound.norm_email(p_email))));
$$;

-- =============================================================================
-- 4b. RESEARCH: who a prospect is, what is known about them, and how sure
--
--   * A FACT ABOUT A PERSON IS STORED ONLY AS EVIDENCE: a claim, the page it
--     came from, what kind of source that page is, and the words on it.
--   * EVERY NUMBER THE GATES READ (identity, role, email, research, fit) and
--     every displayed fact (name, organization, title, email status, status)
--     is COMPUTED from current evidence by growth_outbound.evaluate(). A
--     trigger refuses any other writer — the superuser's included — and under
--     the evaluate door it recomputes instead of trusting what it was handed.
--   * REPETITION IS NOT CORROBORATION. A source's weight is the server's,
--     never the collector's; one site counts once however many pages say it;
--     two sources that disagree halve the confidence; old facts weigh less.
--   * A PERSON IS ONE ROW. Email addresses and profile handles are STRONG
--     identifiers, unique across prospects, so rediscovering someone through
--     a URL with tracking parameters, another casing or a mobile host finds
--     the same row. Websites and name+organization are WEAK: they flag a
--     possible duplicate for the owner, and block a second live send.
-- =============================================================================

-- A URL reduced to the form two discoveries of the same page share: https,
-- lower-case host without userinfo, default port, www./m./mobile.; twitter.com
-- is x.com; youtu.be/<id> is youtube.com/watch?v=<id>; no fragment, no
-- trailing slash, no tracking parameters, the rest sorted. Path case is kept.
-- NULL for anything that is not an http(s) web address.
create or replace function growth_outbound.canonical_url(p text)
returns text language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v text := btrim(coalesce(p, ''));
  m text[];
  v_host text;
  v_port text := '';
  v_path text;
  v_query text;
  v_keep text[] := '{}';
  kv text;
  k text;
begin
  if v = '' or length(v) > 2000 or v ~ '\s' then return null; end if;
  if v !~* '^https?://' then
    -- another scheme (javascript:, mailto:, ftp:) is not a web source
    if v ~* '^[a-z][a-z0-9+.-]*:' and v !~* '^[a-z0-9.-]+:[0-9]+(/|$)' then return null; end if;
    v := 'https://' || ltrim(v, '/');
  end if;
  m := regexp_match(v, '^https?://([^/?#]*)([^?#]*)(\?[^#]*)?', 'i');
  if m is null then return null; end if;
  v_host := lower(regexp_replace(m[1], '^.*@', ''));
  if v_host ~ ':' then
    v_port := split_part(v_host, ':', 2);
    v_host := split_part(v_host, ':', 1);
    if v_port !~ '^[0-9]{0,5}$' then return null; end if;
  end if;
  v_host := rtrim(v_host, '.');
  v_host := regexp_replace(v_host, '^(www|m|mobile)\.(?=[^.]+\.[^.]+)', '');
  if v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$' then return null; end if;
  if v_host = 'twitter.com' then v_host := 'x.com'; end if;
  v_path := regexp_replace(coalesce(m[2], ''), '/{2,}', '/', 'g');
  v_path := regexp_replace(v_path, '/+$', '');
  v_query := substr(coalesce(m[3], ''), 2);
  if v_host = 'youtu.be' and v_path ~ '^/[A-Za-z0-9_-]{6,}$' then
    v_query := 'v=' || substr(v_path, 2) || case when v_query <> '' then '&' || v_query else '' end;
    v_host := 'youtube.com';
    v_path := '/watch';
  end if;
  if v_query <> '' then
    foreach kv in array string_to_array(v_query, '&') loop
      continue when kv = '';
      k := lower(split_part(kv, '=', 1));
      continue when k ~ '^(utm_|mc_|_hs|pk_|mtm_)'
        or k in ('fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'igshid', 'igsh', 'si', 's', 't',
                 'ref', 'ref_src', 'ref_url', 'referrer', 'source', 'src', 'feature', 'app', 'mkt_tok', 'trk', 'cmpid',
                 'share', 'r', 'hl');
      v_keep := array_append(v_keep, kv);
    end loop;
  end if;
  return 'https://' || v_host || case when v_port not in ('', '80', '443') then ':' || v_port else '' end
      || v_path
      || case when cardinality(v_keep) > 0
              then '?' || (select string_agg(x, '&' order by x collate "C") from unnest(v_keep) x) else '' end;
end $$;

create or replace function growth_outbound.url_host(p text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select split_part(substring(growth_outbound.canonical_url(p) from '^https://([^/?]+)'), ':', 1);
$$;

-- Hosts where every account lives under one domain: a page there names its
-- account by path or subdomain, never by the host alone.
create or replace function growth_outbound.is_platform_host(p_host text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_host, '') ~ ('(^|\.)(x\.com|youtube\.com|youtu\.be|substack\.com|beehiiv\.com|medium\.com|linkedin\.com|'
    || 'instagram\.com|tiktok\.com|threads\.net|threads\.com|bsky\.app|github\.com|twitch\.tv|patreon\.com|apple\.com|'
    || 'spotify\.com|linktr\.ee|reddit\.com|facebook\.com|discord\.com|discord\.gg|t\.me|google\.com|rumble\.com|kick\.com)$');
$$;

-- One publisher, for counting independent sources: the registrable domain
-- (blog.example.com and example.com are one), except on multi-tenant hosts
-- where each subdomain is somebody else (pat.substack.com, sam.github.io).
create or replace function growth_outbound.site_key(p_host text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when p_host is null or p_host = '' then null
    when p_host ~ ('\.(substack\.com|beehiiv\.com|medium\.com|wordpress\.com|blogspot\.com|github\.io|netlify\.app|vercel\.app|'
                   || 'wixsite\.com|carrd\.co|notion\.site|ghost\.io|tumblr\.com|squarespace\.com|webflow\.io|pages\.dev|buttondown\.email)$')
      then p_host
    when p_host ~ '\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$' then substring(p_host from '([^.]+\.[^.]+\.[^.]+)$')
    else coalesce(substring(p_host from '([^.]+\.[^.]+)$'), p_host) end;
$$;

-- Letters and digits only, single-spaced, lower-case: how two spellings of
-- one claim ("Pat  Analyst", "pat analyst.") are recognised as the same.
create or replace function growth_outbound.norm_text(p text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]+', ' ', 'g')), '');
$$;

-- What a URL says about WHO it belongs to. A profile on a known platform is a
-- STRONG handle (x:pat, youtube:@pat, substack:pat, linkedin:in:pat, …); any
-- other site is a WEAK site key (colleagues share a company site), and any
-- page that is not a profile is also a WEAK page key.
create or replace function growth_outbound.url_identity(p_url text)
returns table (kind text, value text, strength text) language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  c text := growth_outbound.canonical_url(p_url);
  h text;
  v_path text;
  seg text[];
  s1 text;
  s2 text;
  v_handle text;
begin
  if c is null then return; end if;
  h := growth_outbound.url_host(c);
  v_path := coalesce(substring(c from '^https://[^/?]+(/[^?]*)'), '');
  seg := array_remove(string_to_array(v_path, '/'), '');
  s1 := lower(seg[1]);
  s2 := seg[2];
  v_handle := case
    when h = 'x.com' and s1 ~ '^[a-z0-9_]{1,15}$' and s1 not in ('home', 'explore', 'search', 'i', 'intent', 'share', 'hashtag',
         'settings', 'messages', 'notifications', 'login', 'signup', 'tos', 'privacy', 'compose', 'about', 'jobs') then 'x:' || s1
    when h = 'youtube.com' and s1 ~ '^@[a-z0-9._-]{3,30}$' then 'youtube:' || s1
    when h = 'youtube.com' and s1 = 'channel' and s2 ~ '^UC[A-Za-z0-9_-]{22}$' then 'youtube:channel:' || s2
    when h = 'youtube.com' and s1 in ('c', 'user') and s2 ~ '^[A-Za-z0-9._-]{1,100}$' then 'youtube:' || s1 || ':' || lower(s2)
    when h ~ '^[a-z0-9-]+\.substack\.com$' and h !~ '^(www|open|on|support|blog)\.' then 'substack:' || split_part(h, '.', 1)
    when h = 'substack.com' and s1 ~ '^@[a-z0-9_-]{1,60}$' then 'substack:' || s1
    when h ~ '^[a-z0-9-]+\.beehiiv\.com$' and h !~ '^(www|app|blog|support)\.' then 'beehiiv:' || split_part(h, '.', 1)
    when h = 'medium.com' and s1 ~ '^@[a-z0-9._-]{1,60}$' then 'medium:' || s1
    when h ~ '^[a-z0-9-]+\.medium\.com$' and h !~ '^(www|help|policy|blog)\.' then 'medium:@' || split_part(h, '.', 1)
    when h = 'linkedin.com' and s1 in ('in', 'company') and s2 ~ '^[A-Za-z0-9_%-]{2,100}$' then 'linkedin:' || s1 || ':' || lower(s2)
    when h = 'instagram.com' and s1 ~ '^[a-z0-9._]{1,30}$' and s1 not in ('p', 'reel', 'reels', 'explore', 'stories', 'accounts',
         'direct', 'about', 'developer', 'legal', 'tv') then 'instagram:' || s1
    when h = 'tiktok.com' and s1 ~ '^@[a-z0-9._]{2,24}$' then 'tiktok:' || s1
    when h in ('threads.net', 'threads.com') and s1 ~ '^@[a-z0-9._]{1,30}$' then 'threads:' || s1
    when h = 'bsky.app' and s1 = 'profile' and s2 ~ '^[A-Za-z0-9.:-]{3,253}$' then 'bluesky:' || lower(s2)
    when h = 'github.com' and s1 ~ '^[a-z0-9-]{1,39}$' and s1 not in ('orgs', 'features', 'about', 'topics', 'marketplace', 'sponsors',
         'settings', 'login', 'explore', 'pricing', 'enterprise', 'collections', 'trending', 'events', 'site', 'security', 'team',
         'customer-stories', 'readme', 'join', 'new', 'notifications', 'pulls', 'issues', 'search') then 'github:' || s1
    when h = 'twitch.tv' and s1 ~ '^[a-z0-9_]{3,25}$' and s1 not in ('directory', 'videos', 'p', 'search', 'settings', 'downloads',
         'jobs', 'turbo') then 'twitch:' || s1
    when h = 'patreon.com' and s1 = 'c' and lower(s2) ~ '^[a-z0-9_-]{1,64}$' then 'patreon:' || lower(s2)
    when h = 'patreon.com' and s1 ~ '^[a-z0-9_-]{1,64}$' and s1 not in ('posts', 'login', 'signup', 'search', 'home', 'about',
         'pricing', 'explore', 'messages', 'settings', 'c', 'join', 'checkout') then 'patreon:' || s1
    when h = 'podcasts.apple.com' and v_path ~ '/id[0-9]{5,15}$' then 'apple_podcast:' || substring(v_path from '/id([0-9]{5,15})$')
    when h = 'open.spotify.com' and s1 = 'show' and s2 ~ '^[A-Za-z0-9]{22}$' then 'spotify_show:' || s2
    when h = 'linktr.ee' and s1 ~ '^[a-z0-9._]{1,60}$' and s1 not in ('s', 'login', 'register', 'admin', 'marketplace', 'blog', 'help')
      then 'linktree:' || s1
    when h = 'reddit.com' and s1 in ('user', 'u') and lower(s2) ~ '^[a-z0-9_-]{3,20}$' then 'reddit:' || lower(s2)
    else null end;
  if v_handle is not null then
    kind := 'handle'; value := v_handle; strength := 'strong'; return next;
    return;
  end if;
  if not growth_outbound.is_platform_host(h) then
    kind := 'site'; value := growth_outbound.site_key(h); strength := 'weak'; return next;
  end if;
  kind := 'url'; value := c; strength := 'weak'; return next;
end $$;

-- ── who a prospect is: the identifiers (one person, one row) ─────────────────
create table if not exists growth_outbound.identifiers (
  id           bigint generated always as identity primary key,
  prospect_id  uuid not null references growth_outbound.prospects (id) on delete restrict,
  kind         text not null,
  value        text not null,
  strength     text not null,
  source       text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  released_at  timestamptz,
  released_reason text
);
do $c$ begin
  alter table growth_outbound.identifiers drop constraint if exists identifiers_shape_ck;
  alter table growth_outbound.identifiers add constraint identifiers_shape_ck check (
        kind in ('email', 'handle', 'site', 'url', 'name_org')
    and strength = case when kind in ('email', 'handle') then 'strong' else 'weak' end
    and length(value) between 1 and 2000);
end $c$;
-- a strong identifier names ONE prospect, ever (until the owner releases it)
create unique index if not exists identifiers_strong_uk on growth_outbound.identifiers (kind, value)
  where strength = 'strong' and released_at is null;
create unique index if not exists identifiers_prospect_uk on growth_outbound.identifiers (prospect_id, kind, value);
create index if not exists identifiers_lookup_idx on growth_outbound.identifiers (kind, value);

-- ── what is known: evidence, sharpened ────────────────────────────────────────
alter table growth_outbound.evidence add column if not exists source_kind text not null default 'directory';
alter table growth_outbound.evidence add column if not exists source_domain text;
alter table growth_outbound.evidence add column if not exists source_key text;
alter table growth_outbound.evidence add column if not exists claim_norm text;
alter table growth_outbound.evidence add column if not exists superseded_reason text;
do $c$ begin
  alter table growth_outbound.evidence drop constraint if exists evidence_kind_ck;
  alter table growth_outbound.evidence add constraint evidence_kind_ck check (
    source_kind in ('owner_verified', 'own_site', 'own_profile', 'publication', 'interview', 'directory',
                    'provider_verified', 'provider_found', 'pattern_guess'));
end $c$;
create index if not exists evidence_field_idx on growth_outbound.evidence (prospect_id, field_name) where superseded_at is null;

alter table growth_outbound.prospects add column if not exists research_requested_at timestamptz;
alter table growth_outbound.prospects add column if not exists email_invalid_at timestamptz;
alter table growth_outbound.prospects add column if not exists assessment jsonb not null default '{}'::jsonb;
alter table growth_outbound.prospects add column if not exists duplicate_of uuid references growth_outbound.prospects (id) on delete restrict;
do $c$ begin
  alter table growth_outbound.prospects drop constraint if exists prospects_assessment_ck;
  alter table growth_outbound.prospects add constraint prospects_assessment_ck check (
    jsonb_typeof(assessment) = 'object' and duplicate_of is distinct from id);
end $c$;

-- The fields evidence may speak to, and how each behaves:
--   identity, role, audience  ONE true value: two different claims conflict
--   email, content, signal    many values
create or replace function growth_outbound.evidence_field_class(p_field text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_field
    when 'full_name' then 'identity'
    when 'job_title' then 'role'
    when 'organization' then 'role'
    when 'email' then 'email'
    when 'audience_size' then 'audience'
    when 'project' then 'content'
    when 'article' then 'content'
    when 'podcast' then 'content'
    when 'newsletter' then 'content'
    when 'model' then 'content'
    when 'topic' then 'content'
    when 'sports_focus' then 'content'
    when 'fit_signal' then 'signal'
    else null end;
$$;

-- THE SERVER'S WEIGHT for one source of one claim. The collector never sets
-- it. Email-only kinds (a verification provider, a provider's guess, a
-- pattern guess) carry no weight for anything but an email address.
create or replace function growth_outbound.source_weight(p_kind text, p_field text)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select (case when p_field = 'email' then
    case p_kind when 'owner_verified' then 0.90 when 'own_site' then 0.90 when 'own_profile' then 0.85
                when 'provider_verified' then 0.85 when 'publication' then 0.70 when 'interview' then 0.50
                when 'provider_found' then 0.50 when 'directory' then 0.40 when 'pattern_guess' then 0.10 else 0 end
  else
    case p_kind when 'owner_verified' then 0.80 when 'own_site' then 0.70 when 'own_profile' then 0.70
                when 'publication' then 0.55 when 'interview' then 0.40 when 'directory' then 0.25 else 0 end
  end)::numeric;
$$;

-- Old facts weigh less: a role more than a year old, content more than
-- eighteen months old, an audience figure more than a year old.
create or replace function growth_outbound.freshness(p_field text, p_at timestamptz)
returns numeric language sql stable
set search_path = pg_catalog, pg_temp as $$
  select (case growth_outbound.evidence_field_class(p_field)
    when 'role' then case when p_at < now() - interval '730 days' then 0.5 when p_at < now() - interval '365 days' then 0.75 else 1 end
    when 'content' then case when p_at < now() - interval '540 days' then 0.7 else 1 end
    when 'signal' then case when p_at < now() - interval '540 days' then 0.7 else 1 end
    when 'audience' then case when p_at < now() - interval '365 days' then 0.6 else 1 end
    else 1 end)::numeric;
$$;

-- What the current evidence says about one field of one prospect, claim by
-- claim. Confidence is a noisy-OR over INDEPENDENT sources: the best weight
-- per publisher (or per verifier), so the same site repeating itself counts
-- once. Evidence recorded before these rules (no claim_norm) counts for
-- nothing.
create or replace function growth_outbound.claim_stats(p_prospect uuid, p_field text)
returns table (claim_norm text, claim text, confidence numeric, sources int, stale boolean, kinds text[],
               evidence_ids bigint[], best_url text, best_kind text, latest_at timestamptz)
language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  with e as (
    select x.*, growth_outbound.source_weight(x.source_kind, x.field_name) as w0,
           growth_outbound.freshness(x.field_name, coalesce(x.source_published_at, x.observed_at)) as f
      from growth_outbound.evidence x
     where x.prospect_id = p_prospect and x.field_name = p_field
       and x.superseded_at is null and x.claim_norm is not null
  ), per_source as (
    select e.claim_norm, e.source_key, max(e.w0 * e.f) as w
      from e group by e.claim_norm, e.source_key
  ), agg as (
    select k.claim_norm, 1 - exp(sum(ln(greatest(1 - k.w, 1e-9)))) as conf, count(*)::int as n
      from per_source k group by k.claim_norm
  )
  select a.claim_norm,
         (select e.claim from e where e.claim_norm = a.claim_norm order by e.observed_at desc, e.id desc limit 1),
         round(a.conf::numeric, 4),
         a.n,
         (select bool_and(e.f < 1) from e where e.claim_norm = a.claim_norm),
         (select array_agg(distinct e.source_kind order by e.source_kind) from e where e.claim_norm = a.claim_norm),
         (select array_agg(e.id order by e.id) from e where e.claim_norm = a.claim_norm),
         (select e.source_url from e where e.claim_norm = a.claim_norm order by e.w0 * e.f desc, e.observed_at desc limit 1),
         (select e.source_kind from e where e.claim_norm = a.claim_norm order by e.w0 * e.f desc, e.observed_at desc limit 1),
         (select max(e.observed_at) from e where e.claim_norm = a.claim_norm)
    from agg a;
$$;

-- The field's answer: the best-supported claim, its confidence (HALVED when a
-- one-value field has a rival claim), and why it is not higher.
create or replace function growth_outbound.field_assessment(p_prospect uuid, p_field text)
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  r record;
  v_best record;
  v_n int := 0;
  v_class text := growth_outbound.evidence_field_class(p_field);
  v_single boolean := growth_outbound.evidence_field_class(p_field) in ('identity', 'role', 'audience');
  v_alts jsonb := '[]'::jsonb;
  v_conf numeric;
  v_reasons text[] := '{}';
begin
  for r in select * from growth_outbound.claim_stats(p_prospect, p_field) s order by s.confidence desc, s.latest_at desc loop
    v_n := v_n + 1;
    if v_n = 1 then
      v_best := r;
    else
      v_alts := v_alts || jsonb_build_array(jsonb_build_object('claim', r.claim, 'confidence', r.confidence, 'sources', r.sources));
    end if;
  end loop;
  if v_n = 0 then return null; end if;
  v_conf := v_best.confidence;
  if v_single and v_n > 1 then
    v_conf := round(v_conf * 0.5, 4);
    v_reasons := array_append(v_reasons, 'conflicting_sources'::text);
  end if;
  if v_best.stale then
    v_reasons := array_append(v_reasons, (case v_class when 'role' then 'stale_role' when 'audience' then 'stale_audience' else 'old_content' end)::text);
  end if;
  if v_best.sources = 1 then v_reasons := array_append(v_reasons, 'single_source'::text); end if;
  return jsonb_build_object('field', p_field, 'claim', v_best.claim, 'claim_norm', v_best.claim_norm, 'confidence', v_conf,
    'sources', v_best.sources, 'kinds', to_jsonb(v_best.kinds), 'conflict', v_single and v_n > 1, 'stale', v_best.stale,
    'reasons', to_jsonb(v_reasons), 'evidence_ids', to_jsonb(v_best.evidence_ids), 'source_url', v_best.best_url,
    'source_kind', v_best.best_kind, 'alternatives', v_alts);
end $$;

-- How sure we are of the claim ONE piece of evidence makes, for this prospect
-- (zero if it is superseded, unknown, or somebody else's).
create or replace function growth_outbound.evidence_confidence(p_evidence_id bigint, p_prospect uuid)
returns numeric language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  e growth_outbound.evidence;
  v numeric;
  v_n int;
begin
  select * into e from growth_outbound.evidence where id = p_evidence_id;
  if not found or e.prospect_id is distinct from p_prospect or e.superseded_at is not null or e.claim_norm is null then
    return 0;
  end if;
  select s.confidence into v from growth_outbound.claim_stats(e.prospect_id, e.field_name) s where s.claim_norm = e.claim_norm;
  if growth_outbound.evidence_field_class(e.field_name) in ('identity', 'role', 'audience') then
    select count(*) into v_n from growth_outbound.claim_stats(e.prospect_id, e.field_name);
    if v_n > 1 then v := v * 0.5; end if;
  end if;
  return round(coalesce(v, 0), 4);
end $$;

-- ── fit: a catalogue of reasons, each worth fixed points ─────────────────────
-- A positive reason counts only while it cites current evidence; a negative
-- one counts on the owner's (or the engine's) word alone — lowering a score
-- needs no proof. The catalogue is edited here, in this file, not by any page.
create table if not exists growth_outbound.fit_factor_catalog (
  code            text primary key,
  label           text not null,
  points          int not null,
  needs_evidence  boolean not null
);
do $c$ begin
  alter table growth_outbound.fit_factor_catalog drop constraint if exists fit_factor_catalog_ck;
  alter table growth_outbound.fit_factor_catalog add constraint fit_factor_catalog_ck check (
    code ~ '^[a-z_]{2,40}$' and points between -100 and 50 and points <> 0 and needs_evidence = (points > 0));
end $c$;
insert into growth_outbound.fit_factor_catalog (code, label, points, needs_evidence) values
  ('quant_analysis',             'publishes quantitative sports analysis',          18, true),
  ('publishes_models',           'builds or publishes predictive models',           15, true),
  ('odds_markets_probability',   'writes about odds, markets or probability',       14, true),
  ('ev_fair_pricing',            'discusses expected value or fair pricing',        14, true),
  ('discusses_clv',              'tracks closing-line value',                       12, true),
  ('clear_workflow_fit',         'a research workflow EdgeDesk clearly serves',     12, true),
  ('covers_cfb',                 'covers college football',                          8, true),
  ('covers_nfl',                 'covers the NFL',                                   8, true),
  ('runs_newsletter_or_channel', 'runs a newsletter, podcast or channel',            8, true),
  ('props_research',             'researches player props',                          6, true),
  ('uses_analytics_tools',       'uses analytics tools or data',                     6, true),
  ('engaged_audience',           'has an engaged audience',                          6, true),
  ('consistent_publishing',      'publishes consistently',                           5, true),
  ('generic_content',            'generic content',                                -15, false),
  ('entertainment_only',         'entertainment only',                             -20, false),
  ('inactive',                   'inactive',                                       -25, false),
  ('no_analytics_interest',      'no interest in analytics',                       -30, false),
  ('poor_fit',                   'poor fit',                                       -30, false),
  ('anonymous_no_contact',       'anonymous, no public business contact',         -40, false),
  ('touting',                    'sells picks or promises winnings',               -40, false),
  ('spam',                       'spam',                                          -100, false)
on conflict (code) do update set label = excluded.label, points = excluded.points, needs_evidence = excluded.needs_evidence;

-- The keys a prospect row claims, from its own columns: its email, its profile
-- URLs, and (weak) its computed name with its organization.
create or replace function growth_outbound.prospect_keys(p growth_outbound.prospects)
returns table (kind text, value text, strength text) language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select 'email'::text, growth_outbound.norm_email(p.email), 'strong'::text
   where growth_outbound.valid_email(growth_outbound.norm_email(p.email))
  union
  select k.kind, k.value, k.strength
    from unnest(array[p.website_url, p.x_url, p.youtube_url, p.newsletter_url, p.other_profile_url]) u(url),
         lateral growth_outbound.url_identity(u.url) k
   where u.url is not null
  union
  select 'name_org'::text, growth_outbound.norm_text(p.full_name) || '|' || growth_outbound.norm_text(p.organization), 'weak'::text
   where growth_outbound.norm_text(p.full_name) is not null and growth_outbound.norm_text(p.organization) is not null;
$$;

-- THE ASSESSMENT. Everything the gates read, computed from current evidence,
-- the drafts' cited claims, the identifiers and the settings — never from
-- what a row already says. Called only by the prospects trigger.
create or replace function growth_outbound.compute(r growth_outbound.prospects)
returns growth_outbound.prospects language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  a_name jsonb;
  a_org jsonb;
  a_title jsonb;
  a_aud jsonb;
  a jsonb;
  e_email record;
  v_email text := growth_outbound.norm_email(r.email);
  v_warn text[] := '{}';
  v_gates text[] := '{}';
  v_tokens text[];
  v_has_evidence boolean;
  f jsonb;
  c growth_outbound.fit_factor_catalog;
  v_seen text[] := '{}';
  v_ids bigint[];
  v_valid bigint[];
  v_fc numeric;
  v_factors jsonb := '[]'::jsonb;
  v_reason text[] := '{}';
  v_score int := 0;
  v_any_factor boolean := false;
  v_fitconf numeric;
  v_live int;
  d record;
  cl jsonb;
  v_cc numeric;
  v_research numeric;
  v_dup uuid;
  v_maybe jsonb;
  v_email_a jsonb;
begin
  select * into s from growth_outbound.settings where id = 1;
  select exists (select 1 from growth_outbound.evidence e where e.prospect_id = r.id and e.superseded_at is null and e.claim_norm is not null)
    into v_has_evidence;

  -- WHO: the name, and a first name only when the identity is certain and the
  -- name plainly has one (never guessed from a handle, an initial or a title)
  a_name := growth_outbound.field_assessment(r.id, 'full_name');
  r.full_name := a_name->>'claim';
  r.identity_confidence := (a_name->>'confidence')::numeric;
  r.first_name := null;
  r.last_name := null;
  if r.full_name is not null then
    v_tokens := regexp_split_to_array(r.full_name, '\s+');
    if r.identity_confidence >= s.min_identity_confidence and cardinality(v_tokens) >= 2
       and v_tokens[1] ~ '^[[:alpha:]][[:alpha:]''’-]+$' then
      r.first_name := v_tokens[1];
      r.last_name := array_to_string(v_tokens[2:], ' ');
    else
      v_warn := array_append(v_warn, 'first_name_withheld'::text);
    end if;
  end if;

  -- ROLE: organization and title, each from sources that SAY so (an email
  -- domain is never evidence of an employer: see evidence_prepare)
  a_org := growth_outbound.field_assessment(r.id, 'organization');
  a_title := growth_outbound.field_assessment(r.id, 'job_title');
  r.organization := a_org->>'claim';
  r.job_title := a_title->>'claim';
  r.role_confidence := case when a_org is null and a_title is null then null
    else least(coalesce((a_org->>'confidence')::numeric, 1), coalesce((a_title->>'confidence')::numeric, 1)) end;
  if r.role_confidence < s.min_role_confidence then v_warn := array_append(v_warn, 'role_unconfirmed'::text); end if;

  a_aud := growth_outbound.field_assessment(r.id, 'audience_size');
  r.audience_size_estimate := least((a_aud->>'claim_norm')::bigint, 2000000000)::int;
  r.audience_source_url := a_aud->>'source_url';

  foreach a in array array[a_name, a_org, a_title, a_aud] loop
    continue when a is null;
    if (a->>'conflict')::boolean then v_warn := array_append(v_warn, ('conflict:' || (a->>'field'))::text); end if;
    if (a->>'stale')::boolean then v_warn := array_append(v_warn, ('stale:' || (a->>'field'))::text); end if;
  end loop;

  -- THE EMAIL: verified only by the owner's own check or a verification
  -- provider; published-but-unchecked is 'unverified'; a guess is 'risky'
  if v_email is null then
    r.email_status := 'none';
    r.email_confidence := null;
    r.email_source_url := null;
    r.email_source_kind := null;
  else
    select x.* into e_email from growth_outbound.claim_stats(r.id, 'email') x where x.claim_norm = v_email;
    if not found then
      r.email_status := 'unverified';
      r.email_confidence := 0;
      r.email_source_url := null;
      r.email_source_kind := null;
      v_warn := array_append(v_warn, 'email_unsourced'::text);
    else
      r.email_confidence := e_email.confidence;
      r.email_source_url := e_email.best_url;
      r.email_source_kind := e_email.best_kind;
      r.email_status := case
        when e_email.kinds && array['owner_verified', 'provider_verified'] then 'verified'
        when e_email.kinds && array['own_site', 'own_profile', 'publication', 'interview', 'directory'] then 'unverified'
        else 'risky' end;
    end if;
    if r.email_invalid_at is not null then
      r.email_status := 'invalid';
      r.email_confidence := 0;
    end if;
    v_email_a := jsonb_build_object('address', v_email, 'status', r.email_status, 'confidence', r.email_confidence,
      'source_url', r.email_source_url, 'source_kind', r.email_source_kind,
      'kinds', coalesce((select to_jsonb(x.kinds) from growth_outbound.claim_stats(r.id, 'email') x where x.claim_norm = v_email), '[]'::jsonb));
  end if;

  -- FIT: catalogue points; a positive reason only with current, cited evidence
  for f in select x from jsonb_array_elements(case when jsonb_typeof(r.fit_factors) = 'array' then r.fit_factors else '[]'::jsonb end) x loop
    continue when jsonb_typeof(f) <> 'object' or (f->>'code') = any (v_seen);
    select * into c from growth_outbound.fit_factor_catalog where code = f->>'code';
    if not found then
      v_warn := array_append(v_warn, ('unknown_fit_factor:' || left(coalesce(f->>'code', '?'), 40))::text);
      continue;
    end if;
    v_seen := array_append(v_seen, c.code);
    v_valid := null;
    v_fc := null;
    if c.needs_evidence then
      v_ids := array(select x::bigint from jsonb_array_elements_text(case when jsonb_typeof(f->'evidence') = 'array' then f->'evidence' else '[]'::jsonb end) x
                      where x ~ '^[0-9]{1,18}$');
      select array_agg(e.id order by e.id), max(growth_outbound.evidence_confidence(e.id, r.id))
        into v_valid, v_fc
        from growth_outbound.evidence e
       where e.id = any (v_ids) and e.prospect_id = r.id and e.superseded_at is null
         and e.claim_norm is not null and e.field_name <> 'email';
      if v_valid is null then
        v_warn := array_append(v_warn, ('unsupported_fit_factor:' || c.code)::text);
        continue;
      end if;
      v_fitconf := least(coalesce(v_fitconf, 1), v_fc);
    end if;
    v_any_factor := true;
    v_score := v_score + c.points;
    v_factors := v_factors || jsonb_build_array(jsonb_build_object('code', c.code, 'label', c.label, 'points', c.points,
      'evidence', coalesce(to_jsonb(v_valid), '[]'::jsonb), 'confidence', v_fc));
    v_reason := array_append(v_reason, (c.label || ' (' || case when c.points > 0 then '+' else '' end || c.points || ')')::text);
  end loop;
  r.fit_score := case when v_any_factor then greatest(0, least(100, v_score)) end;
  r.fit_reason := nullif(array_to_string(v_reason, '; '), '');
  r.fit_confidence := v_fitconf;

  -- RESEARCH: with a draft waiting, as sure as its LEAST-supported cited
  -- claim (a claim citing nothing, or someone else's evidence, is zero);
  -- before any draft, the best-supported fact there is to write from
  select count(*) into v_live from growth_outbound.drafts dd where dd.prospect_id = r.id and dd.status in ('pending_review', 'approved');
  if v_live > 0 then
    for d in select dd.id, dd.claims from growth_outbound.drafts dd where dd.prospect_id = r.id and dd.status in ('pending_review', 'approved') loop
      if jsonb_typeof(d.claims) <> 'array' or jsonb_array_length(d.claims) = 0 then
        v_research := 0;
        v_warn := array_append(v_warn, 'draft_cites_no_evidence'::text);
        continue;
      end if;
      for cl in select x from jsonb_array_elements(d.claims) x loop
        v_cc := case when jsonb_typeof(cl) = 'object' and coalesce(cl->>'evidence_id', '') ~ '^[0-9]{1,18}$'
                     then growth_outbound.evidence_confidence((cl->>'evidence_id')::bigint, r.id) else 0 end;
        if v_cc = 0 then v_warn := array_append(v_warn, 'unsupported_claim'::text); end if;
        v_research := least(coalesce(v_research, 1), v_cc);
      end loop;
    end loop;
  else
    select max(growth_outbound.evidence_confidence(e.id, r.id)) into v_research
      from growth_outbound.evidence e
     where e.prospect_id = r.id and e.superseded_at is null and e.claim_norm is not null
       and growth_outbound.evidence_field_class(e.field_name) = 'content';
  end if;
  r.research_confidence := v_research;

  -- ONE PERSON, ONE ROW: a strong key another row already holds makes this a
  -- duplicate (which blocks it); shared weak keys are flagged for the owner
  select i.prospect_id into v_dup
    from growth_outbound.prospect_keys(r) k
    join growth_outbound.identifiers i on i.kind = k.kind and i.value = k.value and i.strength = 'strong'
                                     and i.released_at is null and i.prospect_id <> r.id
    join growth_outbound.prospects o on o.id = i.prospect_id
   order by o.created_at, o.id
   limit 1;
  r.duplicate_of := v_dup;
  if v_dup is not null then v_warn := array_append(v_warn, 'duplicate'::text); end if;
  select coalesce(jsonb_agg(distinct i.prospect_id), '[]'::jsonb) into v_maybe
    from growth_outbound.prospect_keys(r) k
    join growth_outbound.identifiers i on i.kind = k.kind and i.value = k.value and i.kind in ('site', 'name_org')
                                     and i.released_at is null and i.prospect_id <> r.id;
  if jsonb_array_length(v_maybe) > 0 then v_warn := array_append(v_warn, 'possible_duplicate'::text); end if;

  -- STATUS. The owner's and the pipeline's decisions stand; the rest follows
  -- from the gates, recomputed every time.
  if r.status in ('rejected', 'contacted', 'replied', 'converted', 'suppressed') then
    null;
  elsif growth_outbound.is_suppressed(r.email) then
    r.status := 'suppressed';
    r.status_reason := 'this address is suppressed';
  elsif not v_has_evidence then
    r.status := 'discovered';
    r.status_reason := null;
  elsif r.research_requested_at is not null
        and not exists (select 1 from growth_outbound.evidence e where e.prospect_id = r.id and e.observed_at > r.research_requested_at) then
    r.status := 'needs_research';
    r.status_reason := coalesce(r.status_reason, 'more research requested');
  else
    if not r.is_test then
      if r.duplicate_of is not null then v_gates := array_append(v_gates, 'duplicate of another prospect'::text); end if;
      if coalesce(r.fit_score, -1) < s.min_fit_score then
        v_gates := array_append(v_gates, ('fit ' || coalesce(r.fit_score::text, 'unscored') || ' < ' || s.min_fit_score)::text);
      end if;
      if coalesce(r.identity_confidence, 0) < s.min_identity_confidence then
        v_gates := array_append(v_gates, ('identity ' || coalesce(r.identity_confidence, 0) || ' < ' || s.min_identity_confidence)::text);
      end if;
      if v_email is null then
        v_gates := array_append(v_gates, 'no email address'::text);
      else
        if r.email_status <> 'verified' then v_gates := array_append(v_gates, ('email ' || r.email_status)::text); end if;
        if coalesce(r.email_confidence, 0) < s.min_email_confidence then
          v_gates := array_append(v_gates, ('email confidence ' || coalesce(r.email_confidence, 0) || ' < ' || s.min_email_confidence)::text);
        end if;
      end if;
      if coalesce(r.research_confidence, 0) < s.min_research_confidence then
        v_gates := array_append(v_gates, ('research ' || coalesce(r.research_confidence, 0) || ' < ' || s.min_research_confidence)::text);
      end if;
    end if;
    if cardinality(v_gates) = 0 then
      r.status := case when exists (select 1 from growth_outbound.drafts dd where dd.prospect_id = r.id and dd.sequence_number = 1
                                      and dd.status in ('pending_review', 'approved'))
                       then 'ready_for_review' else 'qualified' end;
      r.status_reason := null;
    else
      r.status := 'needs_research';
      r.status_reason := left(array_to_string(v_gates, '; '), 500);
    end if;
  end if;

  r.warnings := coalesce((select jsonb_agg(distinct x) from unnest(v_warn) x), '[]'::jsonb);
  r.last_researched_at := (select max(e.observed_at) from growth_outbound.evidence e where e.prospect_id = r.id);
  r.assessment := jsonb_build_object(
    'evaluated_at', now(),
    'fields', jsonb_strip_nulls(jsonb_build_object('full_name', a_name, 'organization', a_org, 'job_title', a_title, 'audience_size', a_aud)),
    'email', v_email_a,
    'fit', jsonb_build_object('score', r.fit_score, 'confidence', v_fitconf, 'factors', v_factors),
    'research', jsonb_build_object('confidence', v_research, 'from', case when v_live > 0 then 'draft_claims' else 'best_content_claim' end),
    'gates', to_jsonb(v_gates),
    'duplicate_of', v_dup,
    'possible_duplicates', v_maybe,
    'thresholds', jsonb_build_object('fit', s.min_fit_score, 'identity', s.min_identity_confidence,
                                     'role', s.min_role_confidence, 'email', s.min_email_confidence, 'research', s.min_research_confidence));
  return r;
end $$;

-- =============================================================================
-- 5. THE INVARIANTS (triggers)
-- =============================================================================

-- append-only history: suppressions, activity, owner audit
create or replace function growth_outbound.append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% is append-only: history is never rewritten or deleted', tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
drop trigger if exists suppressions_append_only_t on growth_outbound.suppressions;
create trigger suppressions_append_only_t before update or delete on growth_outbound.suppressions
  for each row execute function growth_outbound.append_only();
drop trigger if exists activity_append_only_t on growth_outbound.activity;
create trigger activity_append_only_t before update or delete on growth_outbound.activity
  for each row execute function growth_outbound.append_only();
drop trigger if exists owner_audit_append_only_t on growth_outbound.owner_audit;
create trigger owner_audit_append_only_t before update or delete on growth_outbound.owner_audit
  for each row execute function growth_outbound.append_only();

-- never deleted: prospects, evidence, drafts, sends (status, not removal)
create or replace function growth_outbound.never_delete()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  raise exception '% rows are never deleted: change their status instead', tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
drop trigger if exists prospects_never_delete_t on growth_outbound.prospects;
create trigger prospects_never_delete_t before delete on growth_outbound.prospects
  for each row execute function growth_outbound.never_delete();
drop trigger if exists evidence_never_delete_t on growth_outbound.evidence;
create trigger evidence_never_delete_t before delete on growth_outbound.evidence
  for each row execute function growth_outbound.never_delete();
drop trigger if exists drafts_never_delete_t on growth_outbound.drafts;
create trigger drafts_never_delete_t before delete on growth_outbound.drafts
  for each row execute function growth_outbound.never_delete();
drop trigger if exists sends_never_delete_t on growth_outbound.sends;
create trigger sends_never_delete_t before delete on growth_outbound.sends
  for each row execute function growth_outbound.never_delete();

-- EVIDENCE COMES IN ONLY IN A FORM THAT CAN BE CHECKED. Whoever writes the
-- row — the owner's form, the research engine, a provider — it must name a
-- known field, a web page, the kind of source that page is and (for a page)
-- the words on it. The weight is the server's; what the collector thought of
-- its own find is discarded.
create or replace function growth_outbound.evidence_prepare()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_class text := growth_outbound.evidence_field_class(new.field_name);
  v_c text := growth_outbound.canonical_url(new.source_url);
  v_raw text;
  v_n numeric;
begin
  if v_class is null then
    raise exception 'unknown evidence field "%"', left(coalesce(new.field_name, ''), 60) using errcode = 'check_violation';
  end if;
  if new.source_kind is null or new.source_kind not in ('owner_verified', 'own_site', 'own_profile', 'publication', 'interview',
                                                         'directory', 'provider_verified', 'provider_found', 'pattern_guess') then
    raise exception 'unknown source kind "%"', left(coalesce(new.source_kind, ''), 60) using errcode = 'check_violation';
  end if;
  if new.source_kind in ('provider_verified', 'provider_found', 'pattern_guess') and new.field_name <> 'email' then
    raise exception 'a % source can only support an email address', new.source_kind using errcode = 'check_violation';
  end if;
  if new.source_kind in ('provider_verified', 'provider_found') and coalesce(new.collected_by, '') !~ '^provider:[a-z0-9_-]{1,40}$' then
    raise exception 'only a verification provider records % evidence', new.source_kind using errcode = 'check_violation';
  end if;
  if new.source_kind = 'owner_verified' and coalesce(new.collected_by, '') <> 'owner' then
    raise exception 'only the owner records owner-verified evidence' using errcode = 'check_violation';
  end if;
  if new.collected_by is not null and new.collected_by !~ '^(owner|research_engine|provider:[a-z0-9_-]{1,40})$' then
    raise exception 'unknown collector "%"', left(new.collected_by, 60) using errcode = 'check_violation';
  end if;
  if v_c is null then
    raise exception 'the source must be a web page (https://…)' using errcode = 'check_violation';
  end if;

  new.claim := nullif(btrim(regexp_replace(coalesce(new.claim, ''), '\s+', ' ', 'g')), '');
  if new.claim is null or length(new.claim) > 500 then
    raise exception 'a claim of 1–500 characters is required' using errcode = 'check_violation';
  end if;
  new.source_excerpt := nullif(btrim(coalesce(new.source_excerpt, '')), '');
  if new.source_excerpt is null and new.source_kind not in ('owner_verified', 'provider_verified', 'provider_found', 'pattern_guess') then
    raise exception 'quote the words on the page that say this (source_excerpt)' using errcode = 'check_violation';
  end if;
  if length(new.source_excerpt) > 2000 then
    raise exception 'the excerpt is longer than 2000 characters' using errcode = 'check_violation';
  end if;
  new.source_title := left(nullif(btrim(coalesce(new.source_title, '')), ''), 300);
  if new.source_published_at > now() + interval '1 day' then
    raise exception 'a source cannot be published in the future' using errcode = 'check_violation';
  end if;
  new.observed_at := coalesce(new.observed_at, now());
  if new.observed_at > now() + interval '5 minutes' then
    raise exception 'evidence cannot be observed in the future' using errcode = 'check_violation';
  end if;

  if new.field_name = 'email' then
    new.claim_norm := growth_outbound.norm_email(new.claim);
    if not growth_outbound.valid_email(new.claim_norm) then
      raise exception '"%" is not an email address', left(new.claim, 80) using errcode = 'check_violation';
    end if;
  elsif new.field_name = 'audience_size' then
    v_raw := lower(regexp_replace(new.claim, '[,\s_]', '', 'g'));
    if v_raw !~ '^[0-9]{1,10}(\.[0-9]{1,3})?[km]?$' then
      raise exception 'an audience size is a number such as 12500, 12.5k or 1.2m' using errcode = 'check_violation';
    end if;
    v_n := regexp_replace(v_raw, '[km]$', '')::numeric * case when v_raw ~ 'k$' then 1000 when v_raw ~ 'm$' then 1000000 else 1 end;
    if v_n > 2000000000 then
      raise exception 'that audience size is not plausible' using errcode = 'check_violation';
    end if;
    new.claim_norm := round(v_n)::bigint::text;
  else
    new.claim_norm := growth_outbound.norm_text(new.claim);
    if new.claim_norm is null then
      raise exception 'the claim has no letters or digits' using errcode = 'check_violation';
    end if;
  end if;
  -- NEVER AN EMPLOYER FROM AN EMAIL DOMAIN: an organization is the name a
  -- source gives, not a domain; and a name is a name, not an address or handle
  if new.field_name = 'organization' and lower(new.claim) ~ '^@?[a-z0-9-]+(\.[a-z0-9-]+)+$' then
    raise exception 'an organization is the name a source gives, never an email or web domain (employer_from_email_domain)'
      using errcode = 'check_violation';
  end if;
  if new.field_name = 'full_name' and (new.claim ~ '[@/:]' or new.claim ~ '^\S+\.\S+$') then
    raise exception 'a name is a person''s name, not an address or a handle' using errcode = 'check_violation';
  end if;

  new.source_url := v_c;
  new.source_domain := growth_outbound.url_host(v_c);
  -- independent sources: the owner's own check, each provider, each publisher
  new.source_key := case
    when new.source_kind = 'owner_verified' then 'owner'
    when new.source_kind in ('provider_verified', 'provider_found') then new.collected_by
    when new.source_kind = 'pattern_guess' then 'guess'
    else growth_outbound.site_key(new.source_domain) end;
  new.confidence := growth_outbound.source_weight(new.source_kind, new.field_name);
  new.superseded_at := null;
  new.superseded_reason := null;
  return new;
end $$;
drop trigger if exists evidence_prepare_t on growth_outbound.evidence;
create trigger evidence_prepare_t before insert on growth_outbound.evidence
  for each row execute function growth_outbound.evidence_prepare();

-- evidence is an observation: it can be marked superseded (once, with a
-- reason), never rewritten
create or replace function growth_outbound.evidence_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if (new.prospect_id, new.field_name, new.claim, new.claim_norm, new.source_url, new.source_kind, new.source_domain,
      new.source_key, new.source_title, new.source_excerpt, new.source_published_at, new.observed_at, new.confidence,
      new.collected_by)
     is distinct from
     (old.prospect_id, old.field_name, old.claim, old.claim_norm, old.source_url, old.source_kind, old.source_domain,
      old.source_key, old.source_title, old.source_excerpt, old.source_published_at, old.observed_at, old.confidence,
      old.collected_by)
     or (old.superseded_at is not null
         and (new.superseded_at, new.superseded_reason) is distinct from (old.superseded_at, old.superseded_reason))
     or (old.superseded_at is null and new.superseded_at is null and new.superseded_reason is not null) then
    raise exception 'evidence is an observation and is never rewritten; record a new one and supersede this'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists evidence_guard_t on growth_outbound.evidence;
create trigger evidence_guard_t before update on growth_outbound.evidence
  for each row execute function growth_outbound.evidence_guard();

-- an identifier is a fact about who someone is: it is seen again, or released
-- by the owner, never moved to another prospect or reworded
create or replace function growth_outbound.identifiers_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if (new.prospect_id, new.kind, new.value, new.strength, new.first_seen)
     is distinct from (old.prospect_id, old.kind, old.value, old.strength, old.first_seen) then
    raise exception 'an identifier is never moved or reworded; release it instead' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists identifiers_guard_t on growth_outbound.identifiers;
create trigger identifiers_guard_t before update on growth_outbound.identifiers
  for each row execute function growth_outbound.identifiers_guard();
drop trigger if exists identifiers_never_delete_t on growth_outbound.identifiers;
create trigger identifiers_never_delete_t before delete on growth_outbound.identifiers
  for each row execute function growth_outbound.never_delete();

-- THE ASSESSMENT INVARIANT. Names, confidences, scores, email status and the
-- research statuses are what growth_outbound.compute() says they are. No
-- statement may write them — not a door, not the research engine, not the
-- superuser in the SQL editor. Under the evaluate door the row is recomputed
-- from evidence here, so even a faked door yields only the true values.
create or replace function growth_outbound.prospects_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if (new.full_name, new.first_name, new.last_name, new.organization, new.job_title, new.email_source_url,
        new.email_source_kind, new.audience_size_estimate, new.audience_source_url, new.fit_score, new.fit_reason,
        new.identity_confidence, new.role_confidence, new.email_confidence, new.research_confidence, new.fit_confidence,
        new.last_researched_at, new.duplicate_of) is distinct from
       (null::text, null::text, null::text, null::text, null::text, null::text, null::text, null::int, null::text,
        null::int, null::text, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
        null::timestamptz, null::uuid)
       or new.email_status <> 'none' or new.warnings <> '[]'::jsonb or new.assessment <> '{}'::jsonb
       or new.status <> 'discovered' then
      raise exception 'a prospect starts as discovered with nothing computed: names, confidences, scores and status come from evidence, through evaluate()'
        using errcode = 'insufficient_privilege';
    end if;
    return growth_outbound.compute(new);
  end if;

  if new.id <> old.id or new.attribution_token <> old.attribution_token or new.is_test <> old.is_test
     or new.created_at <> old.created_at or new.discovered_at <> old.discovered_at then
    raise exception 'a prospect''s id, test flag, discovery time and attribution token never change'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(current_setting('growth_outbound.door', true), '') = 'evaluate' then
    return growth_outbound.compute(new);
  end if;

  if (new.full_name, new.first_name, new.last_name, new.organization, new.job_title, new.email_status, new.email_source_url,
      new.email_source_kind, new.audience_size_estimate, new.audience_source_url, new.fit_score, new.fit_reason,
      new.identity_confidence, new.role_confidence, new.email_confidence, new.research_confidence, new.fit_confidence,
      new.warnings, new.assessment, new.last_researched_at, new.duplicate_of)
     is distinct from
     (old.full_name, old.first_name, old.last_name, old.organization, old.job_title, old.email_status, old.email_source_url,
      old.email_source_kind, old.audience_size_estimate, old.audience_source_url, old.fit_score, old.fit_reason,
      old.identity_confidence, old.role_confidence, old.email_confidence, old.research_confidence, old.fit_confidence,
      old.warnings, old.assessment, old.last_researched_at, old.duplicate_of) then
    raise exception 'names, confidences, scores and email status are computed from evidence by evaluate() only'
      using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status and new.status in ('discovered', 'qualified', 'ready_for_review') then
    raise exception 'only evaluate() decides that a prospect is %', new.status using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists prospects_guard_t on growth_outbound.prospects;
create trigger prospects_guard_t before insert or update on growth_outbound.prospects
  for each row execute function growth_outbound.prospects_guard();

create or replace function growth_outbound.touch()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists prospects_touch_t on growth_outbound.prospects;
create trigger prospects_touch_t before update on growth_outbound.prospects
  for each row execute function growth_outbound.touch();

-- THE APPROVAL INVARIANT. Software may draft; only an owner, through the
-- approve door, approves — and only the content they reviewed.
create or replace function growth_outbound.drafts_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_door text := coalesce(current_setting('growth_outbound.door', true), '');
begin
  new.content_hash := growth_outbound.content_hash(new.subject, new.body_text, new.body_html);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.status <> 'pending_review' or new.approved_at is not null or new.approved_by is not null
       or new.approved_hash is not null or new.approved_recipient is not null then
      raise exception 'a draft is created pending review; only an owner approves it'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if old.status = 'sent' then
    raise exception 'a sent draft is final' using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'sent' then
    if v_door <> 'claim_send' or old.status <> 'approved' or new.content_hash <> old.content_hash then
      raise exception 'only the send path marks an approved, unchanged draft sent'
        using errcode = 'insufficient_privilege';
    end if;
    new.approved_at := old.approved_at; new.approved_by := old.approved_by;
    new.approved_hash := old.approved_hash; new.approved_recipient := old.approved_recipient;
    return new;
  end if;

  if new.status = 'approved' then
    if old.status = 'approved' then
      if new.content_hash <> old.content_hash then
        raise exception 'an approved draft cannot change: edit it back to review first'
          using errcode = 'insufficient_privilege';
      end if;
      new.approved_at := old.approved_at; new.approved_by := old.approved_by;
      new.approved_hash := old.approved_hash; new.approved_recipient := old.approved_recipient;
      return new;
    end if;
    if v_door <> 'approve' then
      raise exception 'only the approve door approves a draft' using errcode = 'insufficient_privilege';
    end if;
    if new.approved_by is null or not growth_outbound.owner_active(new.approved_by)
       or new.approved_by is distinct from auth.uid()
       or new.approved_hash is distinct from new.content_hash
       or new.approved_at is null or new.approved_recipient is null then
      raise exception 'an approval must be the signed-in owner''s, for this exact content and recipient'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- any other status: no approval survives
  new.approved_at := null; new.approved_by := null; new.approved_hash := null; new.approved_recipient := null;
  return new;
end $$;
drop trigger if exists drafts_guard_t on growth_outbound.drafts;
create trigger drafts_guard_t before insert or update on growth_outbound.drafts
  for each row execute function growth_outbound.drafts_guard();

-- THE SEND INVARIANT. Whatever code creates a send row, the row must be for
-- an approved, unchanged draft by a current owner, to the approved recipient
-- (or only the owner's test inbox), unsuppressed, once, under the cap, and
-- only while the compliance configuration is complete.
create or replace function growth_outbound.sends_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  d growth_outbound.drafts;
  p growth_outbound.prospects;
  s growth_outbound.settings;
  v_blockers text[];
  v_n int;
begin
  if tg_op = 'UPDATE' then
    if (new.prospect_id, new.draft_id, new.sequence_number, new.is_test, new.idempotency_key, new.sender,
        new.intended_recipient, new.recipient, new.subject, new.content_hash, new.claimed_at, new.claimed_by)
       is distinct from
       (old.prospect_id, old.draft_id, old.sequence_number, old.is_test, old.idempotency_key, old.sender,
        old.intended_recipient, old.recipient, old.subject, old.content_hash, old.claimed_at, old.claimed_by)
       or (old.resend_message_id is not null and new.resend_message_id is distinct from old.resend_message_id) then
      raise exception 'a send records what was sent; only its delivery state may change'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if coalesce(current_setting('growth_outbound.door', true), '') <> 'claim_send' then
    raise exception 'a send is created only by the claim door' using errcode = 'insufficient_privilege';
  end if;
  select * into d from growth_outbound.drafts where id = new.draft_id for update;
  if not found or d.status <> 'approved' then
    raise exception 'only an approved draft can be sent' using errcode = 'insufficient_privilege';
  end if;
  if d.approved_hash is distinct from d.content_hash or new.content_hash is distinct from d.content_hash
     or new.subject is distinct from d.subject then
    raise exception 'the draft changed after it was approved' using errcode = 'insufficient_privilege';
  end if;
  if not growth_outbound.owner_active(d.approved_by) then
    raise exception 'the owner who approved this draft is no longer an owner' using errcode = 'insufficient_privilege';
  end if;
  -- only an owner triggers outreach: the send is claimed by a current owner
  if not growth_outbound.owner_active(new.claimed_by) then
    raise exception 'a send is triggered by an outbound owner only' using errcode = 'insufficient_privilege';
  end if;
  if new.prospect_id <> d.prospect_id or new.sequence_number <> d.sequence_number or new.is_test is distinct from (d.is_test or new.is_test) then
    raise exception 'a send must match its draft' using errcode = 'insufficient_privilege';
  end if;
  select * into p from growth_outbound.prospects where id = new.prospect_id for update;
  if p.status in ('rejected', 'suppressed') then
    raise exception 'this prospect is %', p.status using errcode = 'insufficient_privilege';
  end if;
  if new.intended_recipient is distinct from d.approved_recipient
     or new.intended_recipient is distinct from growth_outbound.norm_email(p.email) then
    raise exception 'the recipient is not the one that was approved' using errcode = 'insufficient_privilege';
  end if;
  if growth_outbound.is_suppressed(new.intended_recipient) or growth_outbound.is_suppressed(new.recipient) then
    raise exception 'this address is suppressed' using errcode = 'insufficient_privilege';
  end if;
  select * into s from growth_outbound.settings where id = 1;
  v_blockers := growth_outbound.send_blockers();
  if coalesce(array_length(v_blockers, 1), 0) > 0 then
    raise exception 'sending is blocked: %', array_to_string(v_blockers, ', ') using errcode = 'insufficient_privilege';
  end if;
  -- one cap at a time: concurrent claims queue here rather than both passing
  perform pg_advisory_xact_lock(hashtext('growth_outbound.sends'));
  if s.test_mode or p.is_test or d.is_test then
    if not new.is_test or new.recipient is distinct from growth_outbound.norm_email(s.test_inbox) then
      raise exception 'in test mode, and for a test prospect, a send goes to the owner''s test inbox only'
        using errcode = 'insufficient_privilege';
    end if;
    select count(*) into v_n from growth_outbound.sends where is_test and claimed_at >= date_trunc('day', now());
    if v_n >= s.max_test_sends_per_day then
      raise exception 'the daily test-send cap (%) is reached', s.max_test_sends_per_day using errcode = 'insufficient_privilege';
    end if;
  else
    if new.is_test or new.recipient is distinct from new.intended_recipient then
      raise exception 'a live send goes to the approved recipient only' using errcode = 'insufficient_privilege';
    end if;
    -- this address has never had this step, from any prospect row
    if exists (select 1 from growth_outbound.sends x where not x.is_test
                and x.intended_recipient = new.intended_recipient and x.sequence_number = new.sequence_number) then
      raise exception 'this address already received step %', new.sequence_number using errcode = 'unique_violation';
    end if;
    -- nor has the person behind it, under another row or another address
    if p.duplicate_of is not null then
      raise exception 'this prospect duplicates another; resolve that first' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from growth_outbound.identifiers a
                 join growth_outbound.identifiers b on b.kind = a.kind and b.value = a.value and b.prospect_id <> a.prospect_id
                                                  and b.released_at is null
                 join growth_outbound.sends x on x.prospect_id = b.prospect_id and not x.is_test and x.sequence_number = new.sequence_number
                where a.prospect_id = new.prospect_id and a.kind = 'name_org' and a.released_at is null) then
      raise exception 'someone with the same name and organization already received step %', new.sequence_number
        using errcode = 'unique_violation';
    end if;
    -- and the prospect still qualifies, as of its latest evaluation
    if (new.sequence_number = 1 and p.status <> 'ready_for_review') or (new.sequence_number > 1 and p.status <> 'contacted') then
      raise exception 'this prospect is %, not ready for step %', p.status, new.sequence_number using errcode = 'insufficient_privilege';
    end if;
    select count(*) into v_n from growth_outbound.sends where not is_test and claimed_at >= date_trunc('day', now());
    if v_n >= s.max_sends_per_day then
      raise exception 'the daily send cap (%) is reached', s.max_sends_per_day using errcode = 'insufficient_privilege';
    end if;
  end if;
  new.claimed_at := now();
  new.delivery_status := 'claimed';
  new.sender := s.sender_name || ' <' || s.sender_email || '>';
  return new;
end $$;
drop trigger if exists sends_guard_t on growth_outbound.sends;
create trigger sends_guard_t before insert or update on growth_outbound.sends
  for each row execute function growth_outbound.sends_guard();

-- =============================================================================
-- 6. LOCK THE SCHEMA DOWN (layers 1–3)
-- =============================================================================
revoke all on schema growth_outbound from public, anon, authenticated, service_role;
revoke all on all tables in schema growth_outbound from public, anon, authenticated, service_role;
revoke all on all sequences in schema growth_outbound from public, anon, authenticated, service_role;
revoke all on all functions in schema growth_outbound from public, anon, authenticated, service_role;
alter default privileges in schema growth_outbound revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema growth_outbound revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema growth_outbound revoke all on functions from public, anon, authenticated, service_role;

do $rls$
declare t text;
begin
  foreach t in array array['owners', 'owner_audit', 'settings', 'prospects', 'evidence', 'drafts',
                           'sends', 'suppressions', 'activity', 'identifiers', 'fit_factor_catalog'] loop
    execute format('alter table growth_outbound.%I enable row level security', t);
    execute format('drop policy if exists deny_clients on growth_outbound.%I', t);
    -- RESTRICTIVE: ANDed with every permissive policy, so a permissive policy
    -- added by mistake later still lets nothing through for these roles
    execute format('create policy deny_clients on growth_outbound.%I as restrictive for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end
$rls$;

-- =============================================================================
-- 7. THE OWNER DOORS (layer 4). Every one: security definer, pinned
--    search_path, FIRST statement growth_outbound.require_owner().
-- =============================================================================
create or replace function growth_outbound.log(p_action text, p_prospect uuid, p_entity text, p_entity_id text, p_detail jsonb)
returns void language sql
set search_path = pg_catalog, public, pg_temp as $$
  insert into growth_outbound.activity (actor_user_id, actor_kind, action, prospect_id, entity, entity_id, detail)
  values (auth.uid(), case when auth.uid() is null then 'system' else 'owner' end,
          p_action, p_prospect, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function growth_outbound.settings_json()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select to_jsonb(s) - 'id' || jsonb_build_object(
    'send_blockers', to_jsonb(growth_outbound.send_blockers()),
    'today', jsonb_build_object(
      'live_sends', (select count(*) from growth_outbound.sends where not is_test and claimed_at >= date_trunc('day', now())),
      'test_sends', (select count(*) from growth_outbound.sends where is_test and claimed_at >= date_trunc('day', now())),
      'cap', s.max_sends_per_day, 'test_cap', s.max_test_sends_per_day))
  from growth_outbound.settings s where s.id = 1;
$$;

create or replace function public.growth_outbound_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return jsonb_build_object(
    'settings', growth_outbound.settings_json(),
    'prospects_by_status', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) n from growth_outbound.prospects group by status) x), '{}'::jsonb),
    'drafts_pending_review', (select count(*) from growth_outbound.drafts where status = 'pending_review'),
    'drafts_approved_unsent', (select count(*) from growth_outbound.drafts where status = 'approved'),
    'sends_7d_by_status', coalesce((select jsonb_object_agg(delivery_status, n) from (
        select delivery_status, count(*) n from growth_outbound.sends
         where not is_test and claimed_at >= now() - interval '7 days' group by delivery_status) x), '{}'::jsonb),
    'suppressions', (select count(*) from growth_outbound.suppressions),
    'discovered_today', (select count(*) from growth_outbound.prospects where discovered_at >= date_trunc('day', now())));
end $$;

create or replace function public.growth_outbound_settings()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return growth_outbound.settings_json();
end $$;

-- Owner edits to the settings. Only known keys; every change audited with its
-- before and after. RAISING THE DAILY CAP and LEAVING TEST MODE each need an
-- explicit confirmation flag in the same call — never a silent increase.
create or replace function public.growth_outbound_settings_update(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_old growth_outbound.settings;
  v_new growth_outbound.settings;
  v_keys text[] := array['automation_enabled', 'test_mode', 'test_inbox', 'daily_prospect_target', 'max_sends_per_day',
    'max_test_sends_per_day', 'min_fit_score', 'min_identity_confidence', 'min_role_confidence', 'min_research_confidence',
    'min_email_confidence', 'followup_enabled', 'followup_delay_days', 'final_followup_enabled', 'final_followup_delay_days',
    'sender_name', 'sender_email', 'reply_to_email', 'cta_url', 'business_name', 'postal_address', 'unsubscribe_url_base',
    'discovery_config'];
  v_bad text;
  v_diff jsonb := '{}'::jsonb;
  k text;
begin
  v_owner := growth_outbound.require_owner();
  if p is null or jsonb_typeof(p) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'not_an_object');
  end if;
  select string_agg(x, ', ') into v_bad from jsonb_object_keys(p) x
   where x <> all (v_keys) and x not in ('confirm_cap_increase', 'confirm_live');
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_setting', 'detail', v_bad);
  end if;
  select * into v_old from growth_outbound.settings where id = 1 for update;
  begin
    if p ? 'max_sends_per_day' and (p->>'max_sends_per_day')::int > v_old.max_sends_per_day
       and coalesce((p->>'confirm_cap_increase')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'reason', 'cap_increase_needs_confirmation',
        'detail', format('raising the daily cap from %s to %s needs confirm_cap_increase', v_old.max_sends_per_day, p->>'max_sends_per_day'));
    end if;
    if p ? 'test_mode' and (p->>'test_mode')::boolean is false and v_old.test_mode
       and coalesce((p->>'confirm_live')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'reason', 'going_live_needs_confirmation',
        'detail', 'leaving test mode lets approved drafts reach real prospects; it needs confirm_live');
    end if;
    update growth_outbound.settings set
      automation_enabled        = coalesce((p->>'automation_enabled')::boolean, automation_enabled),
      test_mode                 = coalesce((p->>'test_mode')::boolean, test_mode),
      test_inbox                = case when p ? 'test_inbox' then growth_outbound.norm_email(p->>'test_inbox') else test_inbox end,
      daily_prospect_target     = coalesce((p->>'daily_prospect_target')::int, daily_prospect_target),
      max_sends_per_day         = coalesce((p->>'max_sends_per_day')::int, max_sends_per_day),
      max_test_sends_per_day    = coalesce((p->>'max_test_sends_per_day')::int, max_test_sends_per_day),
      min_fit_score             = coalesce((p->>'min_fit_score')::int, min_fit_score),
      min_identity_confidence   = coalesce((p->>'min_identity_confidence')::numeric, min_identity_confidence),
      min_role_confidence       = coalesce((p->>'min_role_confidence')::numeric, min_role_confidence),
      min_research_confidence   = coalesce((p->>'min_research_confidence')::numeric, min_research_confidence),
      min_email_confidence      = coalesce((p->>'min_email_confidence')::numeric, min_email_confidence),
      followup_enabled          = coalesce((p->>'followup_enabled')::boolean, followup_enabled),
      followup_delay_days       = coalesce((p->>'followup_delay_days')::int, followup_delay_days),
      final_followup_enabled    = coalesce((p->>'final_followup_enabled')::boolean, final_followup_enabled),
      final_followup_delay_days = coalesce((p->>'final_followup_delay_days')::int, final_followup_delay_days),
      sender_name               = coalesce(nullif(btrim(p->>'sender_name'), ''), sender_name),
      sender_email              = coalesce(growth_outbound.norm_email(p->>'sender_email'), sender_email),
      reply_to_email            = case when p ? 'reply_to_email' then growth_outbound.norm_email(p->>'reply_to_email') else reply_to_email end,
      cta_url                   = coalesce(nullif(btrim(p->>'cta_url'), ''), cta_url),
      business_name             = coalesce(nullif(btrim(p->>'business_name'), ''), business_name),
      postal_address            = case when p ? 'postal_address' then nullif(btrim(p->>'postal_address'), '') else postal_address end,
      unsubscribe_url_base      = case when p ? 'unsubscribe_url_base' then nullif(btrim(p->>'unsubscribe_url_base'), '') else unsubscribe_url_base end,
      discovery_config          = coalesce(p->'discovery_config', discovery_config),
      updated_at = now(), updated_by = v_owner
    where id = 1
    returning * into v_new;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', sqlerrm);
  end;
  foreach k in array v_keys loop
    if (to_jsonb(v_old) -> k) is distinct from (to_jsonb(v_new) -> k) then
      v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(v_old) -> k, 'to', to_jsonb(v_new) -> k));
    end if;
  end loop;
  if v_diff <> '{}'::jsonb then
    perform growth_outbound.log('settings_changed', null, 'settings', '1', v_diff);
  end if;
  return jsonb_build_object('ok', true, 'changed', v_diff, 'settings', growth_outbound.settings_json());
end $$;

create or replace function growth_outbound.prospect_card(p growth_outbound.prospects)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select (to_jsonb(p) - 'assessment') || jsonb_build_object('suppressed', growth_outbound.is_suppressed(p.email),
                                                             'gates', coalesce(p.assessment->'gates', '[]'::jsonb));
$$;

create or replace function public.growth_outbound_prospects(
  p_status text default null, p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform growth_outbound.require_owner();
  return jsonb_build_object(
    'total', (select count(*) from growth_outbound.prospects x
               where (p_status is null or x.status = p_status)
                 and (v_q is null or x.full_name ilike '%' || v_q || '%' or x.organization ilike '%' || v_q || '%' or x.email ilike '%' || v_q || '%')),
    'rows', coalesce((select jsonb_agg(growth_outbound.prospect_card(x) order by x.updated_at desc)
      from (select * from growth_outbound.prospects x
             where (p_status is null or x.status = p_status)
               and (v_q is null or x.full_name ilike '%' || v_q || '%' or x.organization ilike '%' || v_q || '%' or x.email ilike '%' || v_q || '%')
             order by x.updated_at desc
             limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb));
end $$;

create or replace function public.growth_outbound_prospect(p_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare p growth_outbound.prospects;
begin
  perform growth_outbound.require_owner();
  select * into p from growth_outbound.prospects where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true,
    'prospect', growth_outbound.prospect_card(p) || jsonb_build_object('assessment', p.assessment),
    -- every observation, current and superseded: "previously … currently …"
    'evidence', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('current', e.superseded_at is null,
                            'claim_confidence', case when e.superseded_at is null then growth_outbound.evidence_confidence(e.id, p.id) end)
                          order by e.field_name, e.observed_at desc, e.id desc)
                           from growth_outbound.evidence e where e.prospect_id = p.id), '[]'::jsonb),
    'identifiers', coalesce((select jsonb_agg(to_jsonb(i) order by i.strength, i.kind, i.value)
                              from growth_outbound.identifiers i where i.prospect_id = p.id), '[]'::jsonb),
    'related', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'full_name', o.full_name, 'organization', o.organization,
                            'email', o.email, 'status', o.status, 'relation', case when o.id = p.duplicate_of then 'duplicate_of' else 'possible_duplicate' end))
                           from growth_outbound.prospects o
                          where o.id = p.duplicate_of
                             or o.id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p.assessment->'possible_duplicates', '[]'::jsonb)) x)),
                         '[]'::jsonb),
    'drafts', coalesce((select jsonb_agg(to_jsonb(d) order by d.sequence_number, d.generated_at desc) from growth_outbound.drafts d where d.prospect_id = p.id), '[]'::jsonb),
    'sends', coalesce((select jsonb_agg(to_jsonb(s) order by s.claimed_at desc) from growth_outbound.sends s where s.prospect_id = p.id), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from (
        select * from growth_outbound.activity a where a.prospect_id = p.id order by a.at desc limit 100) a), '[]'::jsonb));
end $$;

-- cancel every unsent draft of a prospect (used by reject, needs-research, suppress)
create or replace function growth_outbound.cancel_live_drafts(p_prospect uuid, p_why text)
returns int language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  update growth_outbound.drafts set status = 'cancelled', rejection_reason = coalesce(rejection_reason, p_why)
   where prospect_id = p_prospect and status in ('pending_review', 'approved');
  get diagnostics n = row_count;
  return n;
end $$;

-- The owner's manual moves: MORE RESEARCH, or REJECT. Either cancels any
-- draft still waiting, approved ones included.
create or replace function public.growth_outbound_prospect_set_status(p_id uuid, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  p growth_outbound.prospects;
  n int;
begin
  perform growth_outbound.require_owner();
  if p_status not in ('needs_research', 'rejected') then
    return jsonb_build_object('ok', false, 'reason', 'not_a_manual_status');
  end if;
  select * into p from growth_outbound.prospects where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p.status in ('suppressed', 'contacted', 'replied', 'converted') and p_status = 'needs_research' then
    return jsonb_build_object('ok', false, 'reason', 'prospect_' || p.status);
  end if;
  update growth_outbound.prospects set status = p_status, status_reason = left(nullif(btrim(p_reason), ''), 500),
         research_requested_at = case when p_status = 'needs_research' then now() else research_requested_at end
   where id = p_id;
  n := growth_outbound.cancel_live_drafts(p_id, 'prospect ' || p_status);
  perform growth_outbound.log('prospect_' || p_status, p_id, 'prospect', p_id::text,
    jsonb_build_object('from', p.status, 'reason', p_reason, 'drafts_cancelled', n));
  return jsonb_build_object('ok', true, 'status', p_status, 'drafts_cancelled', n);
end $$;

create or replace function public.growth_outbound_suppressions(p_limit int default 200)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc) from (
    select * from growth_outbound.suppressions order by created_at desc
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)) s), '[]'::jsonb);
end $$;

-- SUPPRESS an address or a whole domain. Recorded forever; every matching
-- prospect is marked suppressed and every unsent draft of theirs cancelled.
create or replace function public.growth_outbound_suppress(
  p_target text, p_kind text default 'manual', p_reason text default null, p_scope text default 'address')
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_target text := growth_outbound.norm_email(p_target);
  v_scope text := coalesce(p_scope, 'address');
  v_id bigint;
  v_p uuid;
  v_np int := 0;
  v_nd int := 0;
begin
  v_owner := growth_outbound.require_owner();
  if v_scope = 'domain' and v_target like '%@%' then v_target := growth_outbound.email_domain(v_target); end if;
  begin
    insert into growth_outbound.suppressions (scope, target, kind, reason, source, created_by)
    values (v_scope, v_target, coalesce(p_kind, 'manual'), left(nullif(btrim(p_reason), ''), 500), 'owner', v_owner)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'reason', 'invalid_target_or_kind');
  end;
  for v_p in
    select id from growth_outbound.prospects x
     where (v_scope = 'address' and growth_outbound.norm_email(x.email) = v_target)
        or (v_scope = 'domain' and growth_outbound.email_domain(growth_outbound.norm_email(x.email)) = v_target)
  loop
    update growth_outbound.prospects set status = 'suppressed', status_reason = 'suppressed: ' || coalesce(p_kind, 'manual')
     where id = v_p and status <> 'suppressed';
    v_np := v_np + 1;
    v_nd := v_nd + growth_outbound.cancel_live_drafts(v_p, 'suppressed');
  end loop;
  perform growth_outbound.log('suppression_created', null, 'suppression', v_id::text,
    jsonb_build_object('scope', v_scope, 'kind', coalesce(p_kind, 'manual'), 'prospects', v_np, 'drafts_cancelled', v_nd));
  return jsonb_build_object('ok', true, 'id', v_id, 'prospects_suppressed', v_np, 'drafts_cancelled', v_nd);
end $$;

-- APPROVE: the owner's explicit act, for the exact content they reviewed.
-- It sends nothing. Every gate is re-checked here, server-side.
create or replace function public.growth_outbound_draft_approve(p_draft_id uuid, p_content_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  d growth_outbound.drafts;
  p growth_outbound.prospects;
  s growth_outbound.settings;
  v_gates text[] := '{}';
begin
  v_owner := growth_outbound.require_owner();
  select * into d from growth_outbound.drafts where id = p_draft_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if d.status <> 'pending_review' then return jsonb_build_object('ok', false, 'reason', 'not_pending_review', 'status', d.status); end if;
  if p_content_hash is distinct from d.content_hash then
    return jsonb_build_object('ok', false, 'reason', 'content_changed',
      'detail', 'the draft changed after you loaded it; review the current version');
  end if;
  -- the gates read a fresh assessment, never a stored one
  perform growth_outbound.evaluate(d.prospect_id);
  select * into p from growth_outbound.prospects where id = d.prospect_id for update;
  select * into s from growth_outbound.settings where id = 1;
  if p.status in ('rejected', 'suppressed') then return jsonb_build_object('ok', false, 'reason', 'prospect_' || p.status); end if;
  if p.email is null or not growth_outbound.valid_email(growth_outbound.norm_email(p.email)) or p.email_status = 'invalid' then
    return jsonb_build_object('ok', false, 'reason', 'no_valid_email');
  end if;
  if growth_outbound.is_suppressed(p.email) then return jsonb_build_object('ok', false, 'reason', 'suppressed'); end if;
  if d.is_test is distinct from p.is_test then return jsonb_build_object('ok', false, 'reason', 'test_flag_mismatch'); end if;
  if not p.is_test then
    if d.sequence_number = 1 and p.status <> 'ready_for_review' then v_gates := array_append(v_gates, ('status is ' || p.status)::text); end if;
    if p.duplicate_of is not null then v_gates := array_append(v_gates, 'duplicate of another prospect'::text); end if;
    if coalesce(p.fit_score, -1) < s.min_fit_score then v_gates := array_append(v_gates, 'fit score below minimum'::text); end if;
    if coalesce(p.identity_confidence, 0) < s.min_identity_confidence then v_gates := array_append(v_gates, 'identity confidence below minimum'::text); end if;
    if coalesce(p.research_confidence, 0) < s.min_research_confidence then v_gates := array_append(v_gates, 'research confidence below minimum'::text); end if;
    if coalesce(p.email_confidence, 0) < s.min_email_confidence then v_gates := array_append(v_gates, 'email confidence below minimum'::text); end if;
    if p.email_status <> 'verified' then v_gates := array_append(v_gates, ('email is ' || p.email_status)::text); end if;
  end if;
  if array_length(v_gates, 1) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'below_gate', 'gates', to_jsonb(v_gates));
  end if;
  perform set_config('growth_outbound.door', 'approve', true);
  update growth_outbound.drafts
     set status = 'approved', approved_at = now(), approved_by = v_owner,
         approved_hash = content_hash, approved_recipient = growth_outbound.norm_email(p.email)
   where id = d.id;
  perform set_config('growth_outbound.door', '', true);
  perform growth_outbound.log('draft_approved', d.prospect_id, 'draft', d.id::text,
    jsonb_build_object('sequence', d.sequence_number, 'content_hash', d.content_hash, 'test', d.is_test));
  return jsonb_build_object('ok', true, 'draft_id', d.id, 'approved_hash', d.content_hash);
end $$;

create or replace function public.growth_outbound_draft_reject(p_draft_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  d growth_outbound.drafts;
begin
  v_owner := growth_outbound.require_owner();
  select * into d from growth_outbound.drafts where id = p_draft_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if d.status not in ('pending_review', 'approved') then return jsonb_build_object('ok', false, 'reason', 'not_open', 'status', d.status); end if;
  update growth_outbound.drafts
     set status = 'rejected', rejected_at = now(), rejected_by = v_owner, rejection_reason = left(nullif(btrim(p_reason), ''), 500)
   where id = d.id;
  perform growth_outbound.evaluate(d.prospect_id);
  perform growth_outbound.log('draft_rejected', d.prospect_id, 'draft', d.id::text,
    jsonb_build_object('from', d.status, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- EDIT: the owner's own words. Puts the draft back in review (an approval
-- never survives an edit) and must be made against the version on screen.
create or replace function public.growth_outbound_draft_edit(
  p_draft_id uuid, p_subject text, p_body_text text, p_expected_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  d growth_outbound.drafts;
  v_new growth_outbound.drafts;
begin
  v_owner := growth_outbound.require_owner();
  select * into d from growth_outbound.drafts where id = p_draft_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if d.status not in ('pending_review', 'approved') then return jsonb_build_object('ok', false, 'reason', 'not_open', 'status', d.status); end if;
  if p_expected_hash is distinct from d.content_hash then
    return jsonb_build_object('ok', false, 'reason', 'content_changed', 'detail', 'the draft changed after you loaded it');
  end if;
  begin
    update growth_outbound.drafts
       set subject = btrim(p_subject), body_text = btrim(p_body_text), body_html = null,
           status = 'pending_review', edited_by_owner = true
     where id = d.id
    returning * into v_new;
  exception when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'reason', 'invalid_content',
      'detail', 'a subject of 1–150 characters and a body of 1–5000 are required');
  end;
  perform growth_outbound.evaluate(d.prospect_id);
  perform growth_outbound.log('draft_edited', d.prospect_id, 'draft', d.id::text,
    jsonb_build_object('from_hash', d.content_hash, 'to_hash', v_new.content_hash, 'was', d.status));
  return jsonb_build_object('ok', true, 'content_hash', v_new.content_hash, 'status', v_new.status);
end $$;

create or replace function public.growth_outbound_activity(p_limit int default 100, p_prospect uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from (
    select * from growth_outbound.activity a
     where p_prospect is null or a.prospect_id = p_prospect
     order by a.at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) a), '[]'::jsonb);
end $$;

-- ── research: identity, evidence, the assessment ─────────────────────────────

-- Which prospect column a URL fills, and the profile link stored there.
create or replace function growth_outbound.url_column(p_url text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when k.kind = 'handle' and k.value like 'x:%' then 'x_url'
    when k.kind = 'handle' and k.value like 'youtube:%' then 'youtube_url'
    when k.kind = 'handle' and (k.value like 'substack:%' or k.value like 'beehiiv:%') then 'newsletter_url'
    when k.kind = 'handle' then 'other_profile_url'
    else 'website_url' end
  from growth_outbound.url_identity(p_url) k where k.kind in ('handle', 'site') limit 1;
$$;

create or replace function growth_outbound.profile_url(p_url text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when k.kind = 'handle' and k.value like 'x:%' then 'https://x.com/' || substr(k.value, 3)
    when k.kind = 'site' then 'https://' || growth_outbound.url_host(p_url)
    else growth_outbound.canonical_url(p_url) end
  from growth_outbound.url_identity(p_url) k where k.kind in ('handle', 'site') limit 1;
$$;

-- Record the keys a prospect claims (its columns, plus any other URLs it was
-- found under). A strong key another prospect already holds stays with them:
-- compute() then marks this row a duplicate.
create or replace function growth_outbound.claim_keys(p_id uuid, p_extra_urls text[], p_source text)
returns int language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  p growth_outbound.prospects;
  k record;
  n int := 0;
begin
  select * into p from growth_outbound.prospects where id = p_id;
  if not found then return 0; end if;
  -- one identity decision at a time, so two discoveries of one person race to
  -- a single row instead of two
  perform pg_advisory_xact_lock(hashtext('growth_outbound.identity'));
  for k in
    select x.kind, x.value, x.strength from growth_outbound.prospect_keys(p) x
    union
    select y.kind, y.value, y.strength
      from unnest(coalesce(p_extra_urls, '{}'::text[])) u(url), lateral growth_outbound.url_identity(u.url) y
  loop
    continue when k.value is null;
    if k.strength = 'strong' and exists (select 1 from growth_outbound.identifiers i where i.kind = k.kind and i.value = k.value
          and i.strength = 'strong' and i.released_at is null and i.prospect_id <> p_id) then
      continue;
    end if;
    insert into growth_outbound.identifiers (prospect_id, kind, value, strength, source)
    values (p_id, k.kind, k.value, k.strength, left(p_source, 60))
    on conflict (prospect_id, kind, value) do update set last_seen = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- EVALUATE: the one writer of everything computed. Recomputes the row from
-- evidence (inside the prospects trigger), records its keys, and takes back
-- any approval the prospect no longer earns. Returns the assessment.
create or replace function growth_outbound.evaluate(p_id uuid)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prev text := coalesce(current_setting('growth_outbound.door', true), '');
  p0 growth_outbound.prospects;
  p1 growth_outbound.prospects;
  n int := 0;
begin
  select * into p0 from growth_outbound.prospects where id = p_id for update;
  if not found then return null; end if;
  perform growth_outbound.claim_keys(p_id, null, 'evaluate');
  perform set_config('growth_outbound.door', 'evaluate', true);
  update growth_outbound.prospects set updated_at = now() where id = p_id returning * into p1;
  perform set_config('growth_outbound.door', v_prev, true);
  -- the computed name and organization may now give it a weak key
  perform growth_outbound.claim_keys(p_id, null, 'evaluate');
  -- an approval stands only while the prospect still passes every gate
  if not p1.is_test and p1.status not in ('qualified', 'ready_for_review', 'contacted', 'replied', 'converted') then
    update growth_outbound.drafts set status = 'pending_review' where prospect_id = p_id and status = 'approved';
    get diagnostics n = row_count;
  end if;
  if p1.status is distinct from p0.status or n > 0 then
    perform growth_outbound.log('prospect_evaluated', p_id, 'prospect', p_id::text,
      jsonb_build_object('from', p0.status, 'to', p1.status, 'reason', p1.status_reason, 'approvals_revoked', n));
  end if;
  return jsonb_build_object('status', p1.status, 'status_reason', p1.status_reason, 'approvals_revoked', n,
    'warnings', p1.warnings, 'assessment', p1.assessment);
end $$;

-- INGEST: a prospect found (or found again), with what was found about them.
-- All or nothing. Shared by the owner's form and, later, the research engine
-- (which calls the same doors, as the owner, with collected_by set).
--   { email, set_primary_email, urls[], prospect_type, campaign_type,
--     sports_focus[], is_test, discovered_via, collected_by,
--     evidence[{field_name, claim, source_url, source_kind, source_title,
--               source_excerpt, source_published_at, supersedes}],
--     fit_factors[{code, evidence[ids], evidence_index[positions], remove}] }
create or replace function growth_outbound.ingest(p_prospect uuid, p jsonb)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_keys text[] := array['email', 'set_primary_email', 'urls', 'prospect_type', 'campaign_type', 'sports_focus', 'is_test',
                         'discovered_via', 'evidence', 'fit_factors', 'collected_by'];
  v_ev_keys text[] := array['field_name', 'claim', 'source_url', 'source_kind', 'source_title', 'source_excerpt',
                            'source_published_at', 'supersedes'];
  v_bad text;
  v_collector text := coalesce(nullif(btrim(coalesce(p->>'collected_by', '')), ''), 'owner');
  v_email text;
  v_urls text[] := '{}';
  v_raw text;
  v_u text;
  v_col text;
  v_sports text[];
  v_id uuid := p_prospect;
  v_p growth_outbound.prospects;
  v_matches uuid[];
  v_created boolean := false;
  v_eids bigint[] := '{}';
  v_eid bigint;
  v_item jsonb;
  v_i int := 0;
  v_ff jsonb;
  v_f jsonb;
  v_refs bigint[];
  v_where text := 'input';
  v_res jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'not_an_object'); end if;
  select string_agg(x, ', ') into v_bad from jsonb_object_keys(p) x where x <> all (v_keys);
  if v_bad is not null then return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', v_bad); end if;
  if v_collector !~ '^(owner|research_engine|provider:[a-z0-9_-]{1,40})$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_collector');
  end if;
  if p ? 'email' and jsonb_typeof(p->'email') not in ('string', 'null') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email');
  end if;
  if nullif(btrim(coalesce(p->>'email', '')), '') is not null then
    v_email := growth_outbound.norm_email(p->>'email');
    if not growth_outbound.valid_email(v_email) then return jsonb_build_object('ok', false, 'reason', 'invalid_email'); end if;
  end if;
  if p ? 'urls' then
    if jsonb_typeof(p->'urls') <> 'array' or jsonb_array_length(p->'urls') > 20 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_urls', 'detail', 'a list of at most 20 URLs');
    end if;
    for v_raw in select x from jsonb_array_elements_text(p->'urls') x loop
      v_u := growth_outbound.canonical_url(v_raw);
      if v_u is null then return jsonb_build_object('ok', false, 'reason', 'invalid_url', 'detail', left(v_raw, 200)); end if;
      v_urls := array_append(v_urls, v_u);
    end loop;
  end if;
  if p ? 'sports_focus' then
    if jsonb_typeof(p->'sports_focus') <> 'array' or jsonb_array_length(p->'sports_focus') > 10 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_sports_focus');
    end if;
    v_sports := array(select upper(btrim(x)) from jsonb_array_elements_text(p->'sports_focus') x);
    if exists (select 1 from unnest(v_sports) x where x !~ '^[A-Z0-9 _-]{2,20}$') then
      return jsonb_build_object('ok', false, 'reason', 'invalid_sports_focus');
    end if;
  end if;
  if p ? 'is_test' and jsonb_typeof(p->'is_test') <> 'boolean' then return jsonb_build_object('ok', false, 'reason', 'invalid_is_test'); end if;
  if p ? 'set_primary_email' and jsonb_typeof(p->'set_primary_email') <> 'boolean' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_set_primary_email');
  end if;
  if p ? 'evidence' and (jsonb_typeof(p->'evidence') <> 'array' or jsonb_array_length(p->'evidence') > 100) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_evidence', 'detail', 'a list of at most 100 items');
  end if;
  if p ? 'fit_factors' and (jsonb_typeof(p->'fit_factors') <> 'array' or jsonb_array_length(p->'fit_factors') > 30) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_fit_factors');
  end if;
  if v_id is null and v_email is null and cardinality(v_urls) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_identifier',
      'detail', 'give an email address or a profile or website URL: a prospect must be someone we can recognise again');
  end if;

  -- WHO IS THIS? Every strong key given, against every prospect.
  perform pg_advisory_xact_lock(hashtext('growth_outbound.identity'));
  select coalesce(array_agg(distinct i.prospect_id), '{}'::uuid[]) into v_matches
    from growth_outbound.identifiers i
   where i.strength = 'strong' and i.released_at is null
     and ((i.kind = 'email' and i.value = v_email)
       or (i.kind, i.value) in (select k.kind, k.value from unnest(v_urls) u(url), lateral growth_outbound.url_identity(u.url) k
                                 where k.strength = 'strong'));
  if v_id is not null then
    select * into v_p from growth_outbound.prospects where id = v_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    v_matches := array_remove(v_matches, v_id);
    if cardinality(v_matches) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'identity_conflict', 'prospects', to_jsonb(v_matches),
        'detail', 'an email address or profile given here belongs to another prospect');
    end if;
  else
    if cardinality(v_matches) > 1 then
      return jsonb_build_object('ok', false, 'reason', 'identity_conflict', 'prospects', to_jsonb(v_matches),
        'detail', 'these identifiers belong to different prospects; release the wrong one before adding more');
    end if;
    v_id := v_matches[1];
    if v_id is not null then select * into v_p from growth_outbound.prospects where id = v_id for update; end if;
  end if;
  -- an address or a domain that opted out stays out: no new row, no new research
  if (v_email is not null and growth_outbound.is_suppressed(v_email)) or (v_id is not null and v_p.status = 'suppressed') then
    return jsonb_build_object('ok', false, 'reason', 'suppressed', 'prospect_id', v_id);
  end if;
  if v_id is not null and p ? 'is_test' and (p->>'is_test')::boolean is distinct from v_p.is_test then
    return jsonb_build_object('ok', false, 'reason', 'test_flag_is_fixed');
  end if;

  begin
    v_where := 'prospect';
    if v_id is null then
      insert into growth_outbound.prospects (is_test, email, prospect_type, campaign_type, sports_focus, discovered_via)
      values (coalesce((p->>'is_test')::boolean, false), v_email, coalesce(p->>'prospect_type', 'other'),
              coalesce(p->>'campaign_type', 'customer'), coalesce(v_sports, '{}'::text[]),
              left(coalesce(nullif(btrim(coalesce(p->>'discovered_via', '')), ''), v_collector), 200))
      returning * into v_p;
      v_id := v_p.id;
      v_created := true;
    else
      update growth_outbound.prospects set
        email = case when v_email is not null and (email is null or coalesce((p->>'set_primary_email')::boolean, false))
                     then v_email else email end,
        prospect_type = coalesce(p->>'prospect_type', prospect_type),
        campaign_type = coalesce(p->>'campaign_type', campaign_type),
        sports_focus = coalesce(v_sports, sports_focus)
      where id = v_id;
    end if;

    v_where := 'urls';
    foreach v_u in array v_urls loop
      v_col := growth_outbound.url_column(v_u);
      continue when v_col is null;
      execute format('update growth_outbound.prospects set %I = coalesce(%I, $1) where id = $2', v_col, v_col)
        using growth_outbound.profile_url(v_u), v_id;
    end loop;
    perform growth_outbound.claim_keys(v_id, v_urls, v_collector);

    -- evidence, in order; "supersedes" retires the older observation it replaces
    for v_item in select x from jsonb_array_elements(coalesce(p->'evidence', '[]'::jsonb)) x loop
      v_i := v_i + 1;
      v_where := 'evidence ' || v_i;
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'each evidence item is an object' using errcode = 'check_violation';
      end if;
      select string_agg(x, ', ') into v_bad from jsonb_object_keys(v_item) x where x <> all (v_ev_keys);
      if v_bad is not null then
        raise exception 'unknown evidence key %', v_bad using errcode = 'check_violation';
      end if;
      insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_title,
                                            source_excerpt, source_published_at, collected_by)
      values (v_id, v_item->>'field_name', v_item->>'claim', v_item->>'source_url', coalesce(v_item->>'source_kind', 'directory'),
              v_item->>'source_title', v_item->>'source_excerpt', (v_item->>'source_published_at')::timestamptz, v_collector)
      returning id into v_eid;
      v_eids := array_append(v_eids, v_eid);
      if v_item ? 'supersedes' then
        update growth_outbound.evidence set superseded_at = now(), superseded_reason = 'replaced by evidence ' || v_eid
         where id = (v_item->>'supersedes')::bigint and prospect_id = v_id and field_name = v_item->>'field_name'
           and superseded_at is null and id <> v_eid;
        if not found then
          raise exception 'evidence % is not current % evidence of this prospect', v_item->>'supersedes', v_item->>'field_name'
            using errcode = 'check_violation';
        end if;
      end if;
    end loop;

    if p ? 'fit_factors' then
      v_where := 'fit_factors';
      select fit_factors into v_ff from growth_outbound.prospects where id = v_id;
      for v_f in select x from jsonb_array_elements(p->'fit_factors') x loop
        if jsonb_typeof(v_f) <> 'object' or not exists (select 1 from growth_outbound.fit_factor_catalog c where c.code = v_f->>'code') then
          raise exception 'unknown fit factor %', left(coalesce(v_f->>'code', '?'), 40) using errcode = 'check_violation';
        end if;
        v_ff := coalesce((select jsonb_agg(x) from jsonb_array_elements(v_ff) x where x->>'code' is distinct from v_f->>'code'), '[]'::jsonb);
        continue when coalesce((v_f->>'remove')::boolean, false);
        v_refs := array(select x::bigint from jsonb_array_elements_text(case when jsonb_typeof(v_f->'evidence') = 'array'
                                                                           then v_f->'evidence' else '[]'::jsonb end) x)
               || array(select v_eids[x::int + 1] from jsonb_array_elements_text(case when jsonb_typeof(v_f->'evidence_index') = 'array'
                                                                                    then v_f->'evidence_index' else '[]'::jsonb end) x);
        if array_position(v_refs, null) is not null then
          raise exception 'fit factor % cites an evidence position that is not in this request', v_f->>'code' using errcode = 'check_violation';
        end if;
        if exists (select 1 from unnest(v_refs) ref where not exists (
                     select 1 from growth_outbound.evidence e where e.id = ref and e.prospect_id = v_id)) then
          raise exception 'fit factor % cites evidence that is not this prospect''s', v_f->>'code' using errcode = 'check_violation';
        end if;
        v_ff := v_ff || jsonb_build_array(jsonb_build_object('code', v_f->>'code', 'evidence', to_jsonb(v_refs)));
      end loop;
      update growth_outbound.prospects set fit_factors = v_ff where id = v_id;
    end if;
  exception
    when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
         or datetime_field_overflow or numeric_value_out_of_range or foreign_key_violation
         or string_data_right_truncation or invalid_parameter_value or array_subscript_error then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'at', v_where, 'detail', sqlerrm);
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'identity_conflict', 'at', v_where, 'detail', sqlerrm);
  end;

  v_res := growth_outbound.evaluate(v_id);
  perform growth_outbound.log(case when v_created then 'prospect_created' else 'prospect_researched' end, v_id, 'prospect', v_id::text,
    jsonb_build_object('evidence', cardinality(v_eids), 'urls', cardinality(v_urls), 'collected_by', v_collector,
                       'status', v_res->>'status'));
  return jsonb_build_object('ok', true, 'prospect_id', v_id, 'created', v_created, 'evidence_ids', to_jsonb(v_eids),
    'status', v_res->>'status', 'status_reason', v_res->>'status_reason', 'warnings', v_res->'warnings',
    'possible_duplicates', coalesce(v_res->'assessment'->'possible_duplicates', '[]'::jsonb));
end $$;

-- ADD OR FIND A PROSPECT, with what was found about them. Rediscovering
-- someone (any casing, a tracking-tagged or mobile URL) adds to their row.
create or replace function public.growth_outbound_prospect_upsert(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return growth_outbound.ingest(null, p);
end $$;

-- MORE EVIDENCE about a known prospect (the same shape, minus who they are)
create or replace function public.growth_outbound_evidence_add(p_prospect uuid, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  if p_prospect is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return growth_outbound.ingest(p_prospect, p);
end $$;

-- RETIRE an observation that is wrong or out of date. It stays on the record
-- ("previously"), and stops counting.
create or replace function public.growth_outbound_evidence_supersede(p_evidence_id bigint, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  e growth_outbound.evidence;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_res jsonb;
begin
  perform growth_outbound.require_owner();
  select * into e from growth_outbound.evidence where id = p_evidence_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if e.superseded_at is not null then return jsonb_build_object('ok', false, 'reason', 'already_superseded'); end if;
  if v_reason is null then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  update growth_outbound.evidence set superseded_at = now(), superseded_reason = v_reason where id = e.id;
  v_res := growth_outbound.evaluate(e.prospect_id);
  perform growth_outbound.log('evidence_superseded', e.prospect_id, 'evidence', e.id::text,
    jsonb_build_object('field', e.field_name, 'claim', left(e.claim, 200), 'reason', v_reason, 'status', v_res->>'status'));
  return jsonb_build_object('ok', true, 'status', v_res->>'status', 'warnings', v_res->'warnings');
end $$;

-- RE-EVALUATE now (after a settings change, say). Nothing is trusted from before.
create or replace function public.growth_outbound_prospect_evaluate(p_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  if p_id is null or not exists (select 1 from growth_outbound.prospects where id = p_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true) || growth_outbound.evaluate(p_id);
end $$;

-- HAVE WE SEEN THIS PERSON? An email or URL in, its identity keys and any
-- prospect holding them out — before anyone researches them again.
create or replace function public.growth_outbound_identity_lookup(p_text text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_email text := growth_outbound.norm_email(p_text);
  v_url text := growth_outbound.canonical_url(p_text);
  v_keys jsonb;
begin
  perform growth_outbound.require_owner();
  if growth_outbound.valid_email(v_email) then
    v_keys := jsonb_build_array(jsonb_build_object('kind', 'email', 'value', v_email, 'strength', 'strong'));
  elsif v_url is not null then
    select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'value', k.value, 'strength', k.strength)), '[]'::jsonb)
      into v_keys from growth_outbound.url_identity(v_url) k;
  else
    return jsonb_build_object('ok', false, 'reason', 'not_an_email_or_url');
  end if;
  return jsonb_build_object('ok', true,
    'canonical', case when growth_outbound.valid_email(v_email) then v_email else v_url end,
    'suppressed', growth_outbound.valid_email(v_email) and growth_outbound.is_suppressed(v_email),
    'keys', (select jsonb_agg(k || jsonb_build_object('matches', coalesce((
        select jsonb_agg(jsonb_build_object('prospect_id', i.prospect_id, 'full_name', p.full_name, 'status', p.status,
                                            'released', i.released_at is not null) order by i.first_seen)
          from growth_outbound.identifiers i join growth_outbound.prospects p on p.id = i.prospect_id
         where i.kind = k->>'kind' and i.value = k->>'value'), '[]'::jsonb)))
      from jsonb_array_elements(v_keys) k));
end $$;

create or replace function public.growth_outbound_fit_catalog()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.points desc, c.code) from growth_outbound.fit_factor_catalog c), '[]'::jsonb);
end $$;

-- RELEASE an identifier that was attached to the wrong person. It stays on
-- the record, stops identifying them, and its column is cleared; another
-- prospect may then hold it.
create or replace function public.growth_outbound_identifier_release(p_identifier_id bigint, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  i growth_outbound.identifiers;
  p growth_outbound.prospects;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_cols text[] := '{}';
  c text;
  v_res jsonb;
begin
  perform growth_outbound.require_owner();
  select * into i from growth_outbound.identifiers where id = p_identifier_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if i.released_at is not null then return jsonb_build_object('ok', false, 'reason', 'already_released'); end if;
  if v_reason is null then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  select * into p from growth_outbound.prospects where id = i.prospect_id for update;
  update growth_outbound.identifiers set released_at = now(), released_reason = v_reason where id = i.id;
  if i.kind = 'email' and growth_outbound.norm_email(p.email) = i.value then
    update growth_outbound.prospects set email = null where id = p.id;
    v_cols := array_append(v_cols, 'email'::text);
  end if;
  foreach c in array array['website_url', 'x_url', 'youtube_url', 'newsletter_url', 'other_profile_url'] loop
    if exists (select 1 from growth_outbound.url_identity(to_jsonb(p) ->> c) k where k.kind = i.kind and k.value = i.value) then
      execute format('update growth_outbound.prospects set %I = null where id = $1', c) using p.id;
      v_cols := array_append(v_cols, c);
    end if;
  end loop;
  v_res := growth_outbound.evaluate(p.id);
  perform growth_outbound.log('identifier_released', p.id, 'identifier', i.id::text,
    jsonb_build_object('kind', i.kind, 'value', i.value, 'reason', v_reason, 'cleared', to_jsonb(v_cols), 'status', v_res->>'status'));
  return jsonb_build_object('ok', true, 'cleared', to_jsonb(v_cols), 'status', v_res->>'status');
end $$;

-- Every prospect re-evaluated under the rules in this file (a re-run is how a
-- rule change reaches existing rows). Oldest first, so the first row to claim
-- an address keeps it.
do $reevaluate$
declare r record;
begin
  for r in select id from growth_outbound.prospects order by created_at, id loop
    perform growth_outbound.evaluate(r.id);
  end loop;
end
$reevaluate$;

-- ── who may call the doors ───────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new public function to anon, authenticated
-- and service_role; revoking from PUBLIC alone would leave those in place.
do $grants$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'growth\_outbound\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$grants$;
revoke all on all functions in schema growth_outbound from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- =============================================================================
-- REPORT: every row should say ok.
-- =============================================================================
select 1 as step, 'the outbound tables exist' as item,
  case when (select count(*) from pg_tables where schemaname = 'growth_outbound' and tablename in
    ('owners', 'owner_audit', 'settings', 'prospects', 'evidence', 'drafts', 'sends', 'suppressions', 'activity',
     'identifiers', 'fit_factor_catalog')) = 11
       then 'ok' else 'CHECK THIS — a table is missing' end as outcome
union all
select 2, 'the schema is private: no client role may even look inside it',
  case when not has_schema_privilege('anon', 'growth_outbound', 'usage')
        and not has_schema_privilege('authenticated', 'growth_outbound', 'usage')
        and not has_schema_privilege('service_role', 'growth_outbound', 'usage') then 'ok' else 'CHECK THIS' end
union all
select 3, 'PostgREST does not serve the schema',
  case when not exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
                         where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%' and c like '%growth_outbound%')
       then 'ok' else 'CHECK THIS — remove growth_outbound from the exposed schemas' end
union all
select 4, 'row level security is on, with the restrictive deny policy, on every table',
  case when (select count(*) from pg_class c where c.relnamespace = 'growth_outbound'::regnamespace and c.relkind = 'r'
               and c.relrowsecurity
               and exists (select 1 from pg_policies p where p.schemaname = 'growth_outbound' and p.tablename = c.relname
                             and p.policyname = 'deny_clients' and p.permissive = 'RESTRICTIVE'))
          = (select count(*) from pg_class c where c.relnamespace = 'growth_outbound'::regnamespace and c.relkind = 'r')
        and not exists (select 1 from pg_policies p where p.schemaname = 'growth_outbound' and p.permissive = 'PERMISSIVE')
       then 'ok' else 'CHECK THIS' end
union all
select 5, 'no client role holds any privilege on any outbound table',
  case when not exists (
    select 1 from pg_class c cross join unnest(array['anon', 'authenticated', 'service_role']) r
     where c.relnamespace = 'growth_outbound'::regnamespace and c.relkind = 'r'
       and (has_table_privilege(r, c.oid, 'select') or has_table_privilege(r, c.oid, 'insert')
         or has_table_privilege(r, c.oid, 'update') or has_table_privilege(r, c.oid, 'delete')))
       then 'ok' else 'CHECK THIS' end
union all
select 6, 'every outbound door is security definer with a pinned search_path, and only a signed-in caller may try it',
  case when not exists (
    select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'growth\_outbound\_%'
       and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
            or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute')))
       then 'ok' else 'CHECK THIS' end
union all
select 7, 'no helper inside the private schema is callable by a client role',
  case when not exists (
    select 1 from pg_proc p cross join unnest(array['anon', 'authenticated', 'service_role']) r
     where p.pronamespace = 'growth_outbound'::regnamespace and has_function_privilege(r, p.oid, 'execute'))
       then 'ok' else 'CHECK THIS' end
union all
select 8, 'an owner grant cannot arrive through the API, and every grant and revoke is audited',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('owners_guard_t', 'owners_audit_t')) = 2
       then 'ok' else 'CHECK THIS' end
union all
select 9, 'every owner is also an affiliate admin (and loses outbound when removed there)',
  case when exists (select 1 from pg_constraint where conrelid = 'growth_outbound.owners'::regclass and contype = 'f'
                     and confrelid = 'public.affiliate_admins'::regclass and confdeltype = 'c')
       then 'ok' else 'CHECK THIS' end
union all
select 10, 'outbound owners: ' || coalesce((select string_agg(coalesce(u.email, o.user_id::text), ', ')
                                            from growth_outbound.owners o left join auth.users u on u.id = o.user_id), 'none yet'),
  case when exists (select 1 from growth_outbound.owners) then 'ok'
       else 'ok — none yet: in the SQL editor run  select growth_outbound.grant_owner(''you@example.com'');' end
union all
select 11, 'approval and send invariants are enforced on the tables',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('drafts_guard_t', 'sends_guard_t')) = 2
       then 'ok' else 'CHECK THIS' end
union all
select 12, 'history is append-only and nothing is deleted',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in
    ('suppressions_append_only_t', 'activity_append_only_t', 'owner_audit_append_only_t', 'prospects_never_delete_t',
     'evidence_never_delete_t', 'drafts_never_delete_t', 'sends_never_delete_t', 'evidence_guard_t',
     'identifiers_never_delete_t', 'identifiers_guard_t')) = 10
       then 'ok' else 'CHECK THIS' end
union all
select 13, 'settings: test mode ' || (select case when test_mode then 'ON' else 'off' end from growth_outbound.settings where id = 1)
  || ', automation ' || (select case when automation_enabled then 'on' else 'OFF' end from growth_outbound.settings where id = 1)
  || ', daily cap ' || (select max_sends_per_day::text from growth_outbound.settings where id = 1),
  'ok'
union all
select 14, 'sending blocked until configured: ' || coalesce(nullif(array_to_string(growth_outbound.send_blockers(), ', '), ''), 'nothing'),
  'ok'
union all
select 15, 'names, confidences, scores and research status are computed from evidence only, and evidence is checked on the way in',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in ('prospects_guard_t', 'evidence_prepare_t')) = 2
       then 'ok' else 'CHECK THIS' end
union all
select 16, 'an email address or a profile names one prospect (rediscovery finds the same row)',
  case when exists (select 1 from pg_indexes where schemaname = 'growth_outbound' and indexname = 'identifiers_strong_uk')
        and growth_outbound.canonical_url('HTTP://WWW.Example.COM:443/a//b/?utm_source=x&b=2&a=1#top') = 'https://example.com/a/b?a=1&b=2'
        and (select value from growth_outbound.url_identity('https://mobile.twitter.com/PatAnalyst/status/1?s=20') where kind = 'handle') = 'x:patanalyst'
       then 'ok' else 'CHECK THIS' end
union all
select 17, 'fit reasons in the catalogue: ' || (select count(*) from growth_outbound.fit_factor_catalog)::text
  || ' (a positive one counts only with current evidence)',
  case when (select count(*) from growth_outbound.fit_factor_catalog) >= 21
        and not exists (select 1 from growth_outbound.fit_factor_catalog where needs_evidence <> (points > 0))
       then 'ok' else 'CHECK THIS' end
union all
select 18, 'prospects by status: ' || coalesce((select string_agg(status || ' ' || n, ', ' order by status)
                                                from (select status, count(*) n from growth_outbound.prospects group by status) x), 'none yet'),
  'ok'
order by 1;

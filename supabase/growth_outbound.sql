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
--          prospects, evidence and drafts are never deleted.
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
    'growth_outbound.sends', 'growth_outbound.suppressions', 'growth_outbound.activity']) t
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

-- evidence is an observation: it can be marked superseded, never rewritten
create or replace function growth_outbound.evidence_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if (new.prospect_id, new.field_name, new.claim, new.source_url, new.source_title, new.source_excerpt,
      new.source_published_at, new.observed_at, new.confidence, new.collected_by)
     is distinct from
     (old.prospect_id, old.field_name, old.claim, old.source_url, old.source_title, old.source_excerpt,
      old.source_published_at, old.observed_at, old.confidence, old.collected_by)
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'evidence is an observation and is never rewritten; record a new one and supersede this'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists evidence_guard_t on growth_outbound.evidence;
create trigger evidence_guard_t before update on growth_outbound.evidence
  for each row execute function growth_outbound.evidence_guard();

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
                           'sends', 'suppressions', 'activity'] loop
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
  select to_jsonb(p) || jsonb_build_object('suppressed', growth_outbound.is_suppressed(p.email));
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
    'prospect', growth_outbound.prospect_card(p),
    'evidence', coalesce((select jsonb_agg(to_jsonb(e) order by e.observed_at desc) from growth_outbound.evidence e where e.prospect_id = p.id), '[]'::jsonb),
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
  update growth_outbound.prospects set status = p_status, status_reason = left(nullif(btrim(p_reason), ''), 500) where id = p_id;
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
    ('owners', 'owner_audit', 'settings', 'prospects', 'evidence', 'drafts', 'sends', 'suppressions', 'activity')) = 9
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
     'evidence_never_delete_t', 'drafts_never_delete_t', 'sends_never_delete_t', 'evidence_guard_t')) = 8
       then 'ok' else 'CHECK THIS' end
union all
select 13, 'settings: test mode ' || (select case when test_mode then 'ON' else 'off' end from growth_outbound.settings where id = 1)
  || ', automation ' || (select case when automation_enabled then 'on' else 'OFF' end from growth_outbound.settings where id = 1)
  || ', daily cap ' || (select max_sends_per_day::text from growth_outbound.settings where id = 1),
  'ok'
union all
select 14, 'sending blocked until configured: ' || coalesce(nullif(array_to_string(growth_outbound.send_blockers(), ', '), ''), 'nothing'),
  'ok'
order by 1;

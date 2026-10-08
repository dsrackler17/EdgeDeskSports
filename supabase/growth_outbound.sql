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
--      THREE EXCEPTIONS, callable by anon only and by nobody signed in: the
--      webhook door, whose first statement checks Resend's signature; the
--      opt-out door, whose first statement checks a send's 64-hex token; and
--      the scheduled engine's door, whose first statement checks a single-use
--      ticket the database minted for one scheduled run. Without its proof
--      each refuses and reads, writes and reveals nothing. A ticket opens
--      only the engine's own doors (find, read, record, draft), for its run.
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
--          superseded; an email address or profile names one prospect;
--        a draft is approved only within the content rules (no promised
--          winnings, locks or guarantees; $49.99/month; a 7-day free trial;
--          EdgeDesk links only) and only while every claim it cites is in
--          its words and backed by current evidence; a batch is approved
--          only for the exact count the owner confirms, all or nothing;
--        a send is claimed (written) before the provider is called, with one
--          idempotency key per draft, so a retry can never send twice, and
--          an outcome unknown after 23 hours is marked failed, not retried;
--        a provider event is believed only with Resend's signature, checked
--          in SQL; an opt-out only with the send's own token; a hard bounce
--          or a spam complaint suppresses the address for good;
--        a fact from the research engine is a QUOTE: it cites a page stored
--          here (never rewritten), the quote is on that page and the claim is
--          in the quote; whether a page is the prospect's own site or profile
--          is decided here, never by the engine; every provider call is
--          counted against a daily budget before it is made;
--        a draft from the drafting engine enters the queue only through its
--          door: each claim is this person's current, confident evidence in
--          its own words; no name, figure or sentence about them comes from
--          nowhere; the greeting uses an established first name or none; the
--          step is due; and a follow-up is SENT only on the configured
--          cadence, after the step before it went out;
--        the morning run (pg_cron) finds, researches and drafts on single-use
--          tickets kept only as hashes; no ticket reaches a door that
--          approves, edits, sends, suppresses or changes a setting.
--        a result is matched, never guessed: a visit or an account counts
--          for a prospect only by their email's link (its campaign code) or
--          the address written to, and only after the first email went out;
--          the account itself is not stored here; an account ends that
--          prospect's sequence, and an address that already has an EdgeDesk
--          account is never cold-emailed.
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
    'growth_outbound.identifiers', 'growth_outbound.fit_factor_catalog', 'growth_outbound.secrets',
    'growth_outbound.provider_events', 'growth_outbound.research_runs', 'growth_outbound.pages',
    'growth_outbound.candidates', 'growth_outbound.provider_usage', 'growth_outbound.scheduler',
    'growth_outbound.conversions', 'growth_outbound.provider_health', 'growth_outbound.provider_cache',
    'growth_outbound.provider_ledger', 'growth_outbound.revenue']) t
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

-- Is this a time zone PostgreSQL knows ('America/New_York', 'UTC')?
-- Does this address already belong to an EdgeDesk account? Such a person is a
-- customer (or was one): never a cold prospect. Read here, server-side only;
-- nothing about the account leaves this schema.
create or replace function growth_outbound.has_account(p_email text)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select growth_outbound.norm_email(p_email) is not null
     and exists (select 1 from auth.users u where lower(btrim(u.email)) = growth_outbound.norm_email(p_email));
$$;

create or replace function growth_outbound.valid_timezone(p text)
returns boolean language plpgsql stable
set search_path = pg_catalog, pg_temp as $$
begin
  if p is null or length(p) > 64 or p !~ '^[A-Za-z][A-Za-z0-9_+/-]*$' then return false; end if;
  return exists (select 1 from pg_catalog.pg_timezone_names where name = p);
end $$;

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

-- A LIVE SCHEDULED RUN for a ticket (NULL: none). The ticket is checked
-- against its stored hash; the run must be the scheduler's, still running,
-- the ticket unexpired, and automation still on (turning it off ends every
-- ticket at once). (plpgsql: resolved when called; the table comes later.)
create or replace function growth_outbound.ticket_run(p_ticket text)
returns bigint language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(p_ticket, '') !~ '^[0-9a-f]{64}$' then return null; end if;
  return (select r.id from growth_outbound.research_runs r, growth_outbound.settings s
           where s.id = 1 and s.automation_enabled
             and r.ticket_sha256 = encode(sha256(convert_to(p_ticket, 'UTF8')), 'hex')
             and r.started_by = 'schedule' and r.status = 'running' and r.ticket_expires_at > now());
end $$;

-- THE ENGINE'S CHECK, the first statement of every door the research and
-- drafting engine uses (find, read, record, draft): the signed-in owner, as
-- everywhere — or, inside the scheduled door only, a live ticket. That door
-- puts the ticket in a transaction-local setting and this checks it AGAIN
-- against its hash, so a forged setting is worth nothing without the ticket.
-- The doors that approve, edit, reject, send, suppress or change settings
-- keep require_owner(): no ticket reaches them.
create or replace function growth_outbound.require_engine()
returns uuid language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare v_ticket text := nullif(current_setting('growth_outbound.ticket', true), '');
begin
  if v_ticket is not null and auth.uid() is null and growth_outbound.ticket_run(v_ticket) is not null then
    return null;
  end if;
  return growth_outbound.require_owner();
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
-- THE MORNING RUN (Phase 9): when the scheduler may work, in the owner's own
-- time zone. It finds, researches and drafts; it never approves or sends.
-- (Phase 13) the owner's own time zone is America/Chicago; an install that
-- still carries the old default is moved once, on the record (section 13)
alter table growth_outbound.settings add column if not exists automation_timezone text not null default 'America/Chicago';
alter table growth_outbound.settings alter column automation_timezone set default 'America/Chicago';
alter table growth_outbound.settings add column if not exists automation_start_hour int not null default 6;
alter table growth_outbound.settings add column if not exists automation_hours int not null default 4;
-- RESULTS (Phase 10): EdgeDesk links in a live email carry this prospect's
-- campaign code, so a visit or a signup that came from it can be matched back.
alter table growth_outbound.settings add column if not exists attribution_links boolean not null default true;
-- LANDING BY INTEREST (2026-10, the growth engine): the link in a drafted
-- email points at the page most relevant to what the prospect's verified
-- record says they do (growth_outbound.landing_for), instead of everyone at
-- cta_url. Off means every draft uses cta_url, as before.
alter table growth_outbound.settings add column if not exists landing_by_interest boolean not null default true;
do $c$ begin
  alter table growth_outbound.settings drop constraint if exists outbound_settings_automation;
  alter table growth_outbound.settings add constraint outbound_settings_automation check (
        automation_start_hour between 0 and 23 and automation_hours between 1 and 12
    and growth_outbound.valid_timezone(automation_timezone));
end $c$;
-- QUALIFICATION AND VOLUME (Phase 12):
--   min_qualification_score  the 0–100 qualification score a prospect needs
--                            (see compute(): relevance 35, analytics 25,
--                            purchase signals 15, contact 15, personalization 10);
--   daily_qualified_target   the morning run researches until this many new
--                            subscriber prospects qualified today (or a budget,
--                            or daily_prospect_target reads, runs out);
--   warmup_*                 the live daily cap grows from warmup_start_per_day
--                            by warmup_step_per_week each week after the first
--                            live email, never past max_sends_per_day;
--   domain_auth              the last SPF/DKIM/DMARC check of the sending domain
--                            (written by the send function's domain check).
alter table growth_outbound.settings add column if not exists min_qualification_score int not null default 75;
alter table growth_outbound.settings add column if not exists daily_qualified_target int not null default 12;
alter table growth_outbound.settings add column if not exists warmup_enabled boolean not null default true;
alter table growth_outbound.settings add column if not exists warmup_start_per_day int not null default 10;
alter table growth_outbound.settings add column if not exists warmup_step_per_week int not null default 5;
alter table growth_outbound.settings add column if not exists domain_auth jsonb;
alter table growth_outbound.settings add column if not exists domain_auth_checked_at timestamptz;
do $c$ begin
  alter table growth_outbound.settings drop constraint if exists outbound_settings_qualification;
  alter table growth_outbound.settings add constraint outbound_settings_qualification check (
        min_qualification_score between 0 and 100 and daily_qualified_target between 1 and 50
    and warmup_start_per_day between 1 and 200 and warmup_step_per_week between 0 and 100
    and (domain_auth is null or jsonb_typeof(domain_auth) = 'object')
    and (domain_auth is null) = (domain_auth_checked_at is null));
end $c$;
-- THE DAILY EMAIL (2026-10): a short note to the OWNER when the morning run
-- leaves drafts for review. digest_owner is the owner who turned it on, and
-- the note goes to that account's own confirmed address, looked up when it
-- is written — never an address typed in, never a prospect's. An owner who
-- loses outbound stops receiving it (set null with their grant).
alter table growth_outbound.settings add column if not exists digest_enabled boolean not null default false;
alter table growth_outbound.settings add column if not exists digest_owner uuid references growth_outbound.owners (user_id) on delete set null;
-- REPLIES (2026-10): a reply Resend receives (email.received, signed) ends
-- that person's sequence, as "They replied" does. Off: replies are recorded
-- and shown, and only an unsubscribe request still acts.
alter table growth_outbound.settings add column if not exists reply_detection boolean not null default true;
-- READINESS AND PARTNERS (Phase 13):
--   optout_check       the last check of the opt-out endpoint, made by the send
--                      function on the owner's request: the endpoint answered a
--                      GET with the redirect to the stop page and a POST with
--                      "not valid" for a token no send carries, so the link in
--                      every email works. Written only by its door.
--   partner_outreach_enabled   the drafting engine also writes to partner
--                      leads (media, affiliate, business), with the partnership
--                      rules and never the subscription pitch. Off by default.
alter table growth_outbound.settings add column if not exists optout_check jsonb;
alter table growth_outbound.settings add column if not exists optout_checked_at timestamptz;
alter table growth_outbound.settings add column if not exists partner_outreach_enabled boolean not null default false;
do $c$ begin
  alter table growth_outbound.settings drop constraint if exists outbound_settings_readiness;
  alter table growth_outbound.settings add constraint outbound_settings_readiness check (
        (optout_check is null or jsonb_typeof(optout_check) = 'object')
    and (optout_check is null) = (optout_checked_at is null));
end $c$;

-- What stops a real send right now, in words. Empty means nothing does.
-- What stops a send, in words. Empty means nothing does. A TEST send (only
-- ever to the owner's own test inbox) needs the postal address and the test
-- inbox; a LIVE send also needs the opt-out endpoint, because a real person
-- must be able to stop with one click.
-- (plpgsql, resolved when called: it reads tables created further down)
-- A LIVE send also needs the Resend webhook, so that a bounce or a spam
-- complaint suppresses the address before any follow-up could go.
create or replace function growth_outbound.send_blockers_for(p_test boolean)
returns text[] language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
begin
  return (select array_remove(array[
    case when s.postal_address is null or btrim(s.postal_address) = '' then 'postal_address_missing' end,
    case when not coalesce(p_test, false) and s.unsubscribe_url_base is null then 'unsubscribe_endpoint_missing' end,
    case when not coalesce(p_test, false) and not exists (select 1 from growth_outbound.secrets where name = 'resend_webhook')
         then 'webhook_secret_missing' end,
    case when coalesce(p_test, true) and s.test_inbox is null then 'test_inbox_missing' end,
    case when not exists (select 1 from growth_outbound.owners) then 'no_outbound_owner' end,
    -- a sending domain CHECKED and found missing SPF, DKIM or DMARC (Phase 12);
    -- a domain never checked is a System check item, not a blocker
    case when not coalesce(p_test, false) and s.domain_auth->>'ok' = 'false' then 'domain_auth_failed' end,
    -- (Phase 13) configured is not working. The opt-out link must have been
    -- CHECKED at this very address (the endpoint answered as it should), and
    -- Resend's webhook must have delivered at least one signed event since
    -- the current secret was set (a test send proves it): a bounce or a
    -- complaint that cannot arrive cannot stop the next email.
    case when not coalesce(p_test, false) and s.unsubscribe_url_base is not null
              and not (coalesce(s.optout_check->>'ok', '') = 'true' and s.optout_check->>'base' = s.unsubscribe_url_base)
         then 'unsubscribe_endpoint_unverified' end,
    case when not coalesce(p_test, false)
              and exists (select 1 from growth_outbound.secrets k where k.name = 'resend_webhook')
              and not exists (select 1 from growth_outbound.provider_events e, growth_outbound.secrets k
                               where k.name = 'resend_webhook' and e.received_at >= k.set_at)
         then 'webhook_unproven' end
  ], null)
  from growth_outbound.settings s where s.id = 1);
end $$;

-- What stops the next send in the CURRENT mode.
create or replace function growth_outbound.send_blockers()
returns text[] language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select growth_outbound.send_blockers_for(s.test_mode) from growth_outbound.settings s where s.id = 1;
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
    -- who they are to EdgeDesk (Phase 12): a potential subscriber ('customer'),
    -- or a partner lead the engine never pitches a subscription to
    and campaign_type in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner')
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
    -- who they are to EdgeDesk (Phase 12): a potential subscriber ('customer'),
    -- or a partner lead the engine never pitches a subscription to
    and campaign_type in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner')
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
-- each send carries its own opt-out token (made by the send trigger), and the
-- record of every attempt to hand it to the provider
alter table growth_outbound.sends add column if not exists optout_token text;
alter table growth_outbound.sends add column if not exists attempts int not null default 1;
alter table growth_outbound.sends add column if not exists last_attempt_at timestamptz;
alter table growth_outbound.sends add column if not exists last_error text;
create unique index if not exists sends_optout_token_uk on growth_outbound.sends (optout_token) where optout_token is not null;
-- whether this send's EdgeDesk links carried a campaign code (fixed when it
-- is claimed, from the setting; what was sent is what the row says)
alter table growth_outbound.sends add column if not exists links_tagged boolean not null default false;

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
-- THE QUALIFICATION SCORE (Phase 12), computed by compute() like every other
-- number here: 0–100 with its parts and what each rests on, and when the
-- prospect first cleared every gate (the morning run's daily target counts it)
alter table growth_outbound.prospects add column if not exists qualification_score int;
alter table growth_outbound.prospects add column if not exists qualification jsonb not null default '{}'::jsonb;
alter table growth_outbound.prospects add column if not exists first_qualified_at timestamptz;
do $c$ begin
  alter table growth_outbound.prospects drop constraint if exists prospects_qualification_ck;
  alter table growth_outbound.prospects add constraint prospects_qualification_ck check (
    (qualification_score is null or qualification_score between 0 and 100) and jsonb_typeof(qualification) = 'object');
end $c$;
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
-- Each reason belongs to one part of the QUALIFICATION SCORE (Phase 12):
--   relevance  what they do is what EdgeDesk does (NFL/CFB, markets, pricing)   ≤ 35
--   analytics  they demonstrably do analytics (models, numbers, data, charts)   ≤ 25
--   purchase   evidence they would pay for research (they bet, track, buy tools) ≤ 15
--   penalty    a reason against (subtracted, unproven)
alter table growth_outbound.fit_factor_catalog add column if not exists category text;
insert into growth_outbound.fit_factor_catalog (code, label, points, needs_evidence, category) values
  ('quant_analysis',             'publishes quantitative sports analysis',          18, true, 'analytics'),
  ('publishes_models',           'builds or publishes predictive models',           15, true, 'analytics'),
  ('odds_markets_probability',   'writes about odds, markets or probability',       14, true, 'relevance'),
  ('ev_fair_pricing',            'discusses expected value or fair pricing',        14, true, 'relevance'),
  ('discusses_clv',              'tracks closing-line value',                       12, true, 'purchase'),
  ('clear_workflow_fit',         'a research workflow EdgeDesk clearly serves',     12, true, 'relevance'),
  ('covers_cfb',                 'covers college football',                          8, true, 'relevance'),
  ('covers_nfl',                 'covers the NFL',                                   8, true, 'relevance'),
  ('runs_newsletter_or_channel', 'runs a newsletter, podcast or channel',            8, true, 'analytics'),
  ('props_research',             'researches player props',                          6, true, 'relevance'),
  ('uses_analytics_tools',       'uses analytics tools or data',                     6, true, 'analytics'),
  ('engaged_audience',           'has an engaged audience',                          6, true, 'analytics'),
  ('consistent_publishing',      'publishes consistently',                           5, true, 'analytics'),
  ('data_visualization',         'makes sports data visualizations',                 8, true, 'analytics'),
  ('tracks_own_bets',            'tracks their own bets or results',                10, true, 'purchase'),
  ('pays_for_tools',             'pays for data, tools or research subscriptions',  10, true, 'purchase'),
  ('sells_paid_research',        'runs a paid newsletter or subscription',           6, true, 'purchase'),
  ('independent_researcher',     'independent researcher, not a media company',      6, true, 'purchase'),
  ('generic_content',            'generic content',                                -15, false, 'penalty'),
  ('entertainment_only',         'entertainment only',                             -20, false, 'penalty'),
  ('inactive',                   'inactive',                                       -25, false, 'penalty'),
  ('large_media_outlet',         'a large media outlet, not a person or small team', -25, false, 'penalty'),
  ('no_analytics_interest',      'no interest in analytics',                       -30, false, 'penalty'),
  ('poor_fit',                   'poor fit',                                       -30, false, 'penalty'),
  ('industry_role_no_analytics', 'a sports-industry job without analytics work',   -30, false, 'penalty'),
  ('anonymous_no_contact',       'anonymous, no public business contact',         -40, false, 'penalty'),
  ('touting',                    'sells picks or promises winnings',               -40, false, 'penalty'),
  ('sportsbook_or_operator',     'works for a sportsbook, odds provider or operator', -50, false, 'penalty'),
  ('spam',                       'spam',                                          -100, false, 'penalty')
on conflict (code) do update set label = excluded.label, points = excluded.points, needs_evidence = excluded.needs_evidence,
                                 category = excluded.category;
do $c$ begin
  alter table growth_outbound.fit_factor_catalog drop constraint if exists fit_factor_catalog_category_ck;
  alter table growth_outbound.fit_factor_catalog add constraint fit_factor_catalog_category_ck check (
    category in ('relevance', 'analytics', 'purchase', 'penalty') and (category = 'penalty') = (points < 0));
end $c$;

-- The qualification rubric: each part's ceiling. Edited here, not by a page.
create or replace function growth_outbound.qualification_max(p_part text)
returns int language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_part when 'relevance' then 35 when 'analytics' then 25 when 'purchase' then 15
                     when 'contact' then 15 when 'personalization' then 10 else 0 end;
$$;

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
  -- the qualification score's parts (Phase 12)
  v_part jsonb := '{}'::jsonb;
  v_q_rel int;
  v_q_ana int;
  v_q_pur int;
  v_q_pen int;
  v_q_email int;
  v_q_ident int;
  v_q_own int;
  v_q_facts int;
  v_q_pers int;
  v_q_total int;
  v_email_found boolean := false;
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
      v_email_found := e_email.kinds && array['provider_found'];
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
    v_part := jsonb_set(v_part, array[coalesce(c.category, 'penalty')],
      coalesce(v_part->coalesce(c.category, 'penalty'), '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('code', c.code, 'label', c.label, 'points', c.points,
                                              'evidence', coalesce(to_jsonb(v_valid), '[]'::jsonb))));
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

  -- THE QUALIFICATION SCORE (Phase 12), 0–100, every part from evidence:
  --   relevance 35, analytics 25, purchase signals 15: the evidenced catalogue
  --     reasons of that part, summed and capped at the part's ceiling;
  --   contact quality 15: the address (verified 9; published on their own
  --     site or profile 5; published elsewhere, or a provider's unverified
  --     find, 3; none, guessed or bounced 0), the
  --     identity (at its gate 4, at 0.70 2) and a site or profile of their own (2);
  --   personalization 10: facts an email may cite, each sure enough by itself
  --     (one 5, two 8, three or more 10);
  --   penalties: every reason against, subtracted.
  -- A prospect with no evidence has no score.
  select coalesce(sum((x->>'points')::int), 0) into v_q_rel from jsonb_array_elements(coalesce(v_part->'relevance', '[]'::jsonb)) x;
  select coalesce(sum((x->>'points')::int), 0) into v_q_ana from jsonb_array_elements(coalesce(v_part->'analytics', '[]'::jsonb)) x;
  select coalesce(sum((x->>'points')::int), 0) into v_q_pur from jsonb_array_elements(coalesce(v_part->'purchase', '[]'::jsonb)) x;
  select coalesce(sum((x->>'points')::int), 0) into v_q_pen from jsonb_array_elements(coalesce(v_part->'penalty', '[]'::jsonb)) x;
  v_q_rel := least(v_q_rel, growth_outbound.qualification_max('relevance'));
  v_q_ana := least(v_q_ana, growth_outbound.qualification_max('analytics'));
  v_q_pur := least(v_q_pur, growth_outbound.qualification_max('purchase'));
  v_q_email := case when v_email is null or r.email_status in ('none', 'invalid') then 0
                    when r.email_status = 'verified' then 9
                    when r.email_status = 'unverified' and r.email_source_kind in ('own_site', 'own_profile') then 5
                    when r.email_status = 'unverified' or v_email_found then 3
                    else 0 end;   -- a guessed address is worth nothing
  v_q_ident := case when coalesce(r.identity_confidence, 0) >= s.min_identity_confidence then 4
                    when coalesce(r.identity_confidence, 0) >= 0.70 then 2 else 0 end;
  v_q_own := case when exists (select 1 from growth_outbound.evidence e where e.prospect_id = r.id and e.superseded_at is null
                                  and e.claim_norm is not null and e.source_kind in ('own_site', 'own_profile')) then 2 else 0 end;
  v_q_facts := jsonb_array_length(growth_outbound.citeable_facts(r.id));
  v_q_pers := case when v_q_facts >= 3 then 10 when v_q_facts = 2 then 8 when v_q_facts = 1 then 5 else 0 end;
  -- (Phase 13) A PARTNER LEAD is not judged on whether they would pay for a
  -- subscription themselves: the purchase part is left out and the other
  -- 85 points are scaled to 100. The penalties still count in full, and the
  -- bar (min_qualification_score) is the same.
  if r.campaign_type = 'customer' or r.is_test then
    v_q_total := greatest(0, least(100, v_q_rel + v_q_ana + v_q_pur + v_q_email + v_q_ident + v_q_own + v_q_pers + v_q_pen));
  else
    v_q_total := greatest(0, least(100, round((v_q_rel + v_q_ana + v_q_email + v_q_ident + v_q_own + v_q_pers) * 100.0
                                                / (100 - growth_outbound.qualification_max('purchase')))::int + v_q_pen));
  end if;
  r.qualification_score := case when v_has_evidence then v_q_total end;
  r.qualification := case when not v_has_evidence then '{}'::jsonb else jsonb_build_object(
    'score', v_q_total, 'segment', r.campaign_type,
    'basis', case when r.campaign_type = 'customer' or r.is_test then 'subscriber' else 'partner' end,
    'parts', jsonb_build_object(
      'relevance', jsonb_build_object('points', v_q_rel, 'max', growth_outbound.qualification_max('relevance'),
                                      'reasons', coalesce(v_part->'relevance', '[]'::jsonb)),
      'analytics', jsonb_build_object('points', v_q_ana, 'max', growth_outbound.qualification_max('analytics'),
                                      'reasons', coalesce(v_part->'analytics', '[]'::jsonb)),
      'purchase', jsonb_build_object('points', v_q_pur, 'max', growth_outbound.qualification_max('purchase'),
                                     'reasons', coalesce(v_part->'purchase', '[]'::jsonb),
                                     'counted', r.campaign_type = 'customer' or r.is_test),
      'contact', jsonb_build_object('points', v_q_email + v_q_ident + v_q_own, 'max', growth_outbound.qualification_max('contact'),
                                    'email', v_q_email, 'email_status', r.email_status, 'identity', v_q_ident, 'own_site_or_profile', v_q_own),
      'personalization', jsonb_build_object('points', v_q_pers, 'max', growth_outbound.qualification_max('personalization'),
                                            'citeable_facts', v_q_facts),
      'penalties', jsonb_build_object('points', v_q_pen, 'reasons', coalesce(v_part->'penalty', '[]'::jsonb))),
    'why', (select string_agg(x->>'label', '; ' order by (x->>'points')::int desc)
              from jsonb_array_elements(coalesce(v_part->'relevance', '[]'::jsonb) || coalesce(v_part->'analytics', '[]'::jsonb)
                                        || coalesce(v_part->'purchase', '[]'::jsonb)) x),
    'against', (select string_agg(x->>'label', '; ' order by (x->>'points')::int)
                  from jsonb_array_elements(coalesce(v_part->'penalty', '[]'::jsonb)) x)) end;

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
      if coalesce(r.qualification_score, -1) < s.min_qualification_score then
        v_gates := array_append(v_gates, ('qualification ' || coalesce(r.qualification_score::text, 'unscored') || ' < '
                                          || s.min_qualification_score)::text);
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

  -- the first time every gate cleared (kept from then on): what the morning
  -- run's daily target counts
  if r.status in ('qualified', 'ready_for_review') and r.first_qualified_at is null then
    r.first_qualified_at := now();
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
    'qualification', r.qualification,
    'thresholds', jsonb_build_object('fit', s.min_fit_score, 'identity', s.min_identity_confidence,
                                     'role', s.min_role_confidence, 'email', s.min_email_confidence, 'research', s.min_research_confidence,
                                     'qualification', s.min_qualification_score));
  return r;
end $$;

-- =============================================================================
-- 4c. WHAT ARRIVES FROM OUTSIDE: the provider's events, and the one secret
--     needed to believe them
--
--   Resend reports what happened to each email (delivered, bounced, marked
--   as spam, opened) to a webhook, signed with a secret only Resend and this
--   database hold. The SIGNATURE IS CHECKED HERE, in SQL, before anything is
--   read: the Edge Function that relays the delivery holds no secret at all,
--   so it cannot be the weak link. An event about an email this engine did
--   not send (the newsletter shares the Resend account) is acknowledged and
--   nothing about it is kept.
-- =============================================================================
create table if not exists growth_outbound.secrets (
  name    text primary key,
  value   text not null,
  set_at  timestamptz not null default now(),
  set_by  text not null default session_user
);
comment on table growth_outbound.secrets is
  'Verification secrets (the Resend webhook signing secret). Written only from the SQL editor '
  '(growth_outbound.set_webhook_secret); no door ever returns a value.';
do $c$ begin
  alter table growth_outbound.secrets drop constraint if exists secrets_name_ck;
  alter table growth_outbound.secrets add constraint secrets_name_ck check (name in ('resend_webhook'));
end $c$;

create table if not exists growth_outbound.provider_events (
  id           bigint generated always as identity primary key,
  received_at  timestamptz not null default now(),
  provider     text not null default 'resend',
  event_id     text not null,
  event_type   text not null,
  message_id   text,
  send_id      uuid references growth_outbound.sends (id) on delete set null,
  outcome      text not null,
  detail       jsonb not null default '{}'::jsonb
);
do $c$ begin
  alter table growth_outbound.provider_events drop constraint if exists provider_events_shape_ck;
  alter table growth_outbound.provider_events add constraint provider_events_shape_ck check (
        provider = 'resend' and length(event_id) between 1 and 200 and length(event_type) between 0 and 100
    and jsonb_typeof(detail) = 'object');
end $c$;
-- every provider retries: the second delivery of one event is a no-op
create unique index if not exists provider_events_uk on growth_outbound.provider_events (provider, event_id);
create index if not exists provider_events_at_idx on growth_outbound.provider_events (received_at desc);

-- REPLIES (2026-10): every email Resend received for us (its signed
-- email.received event), what it was taken to be, and whether it changed
-- anything. Only what the event carries: never the body.
--   reply       from an address a live email went to, after it: their
--               sequence ends (when reply detection is on)
--   auto_reply  an out-of-office or automatic answer: noted, nothing changes
--   opt_out     "unsubscribe", "remove me", "stop emailing" in the subject:
--               the address is suppressed, always
--   test        an answer to a test email (from the test inbox): noted
--   unmatched   from nobody we wrote to: the sender kept masked, no subject
create table if not exists growth_outbound.replies (
  id               bigint generated always as identity primary key,
  received_at      timestamptz not null default now(),
  resend_email_id  text not null,
  event_id         text not null,
  kind             text not null,
  prospect_id      uuid references growth_outbound.prospects (id) on delete set null,
  send_id          uuid references growth_outbound.sends (id) on delete set null,
  sequence_number  int,
  from_masked      text,
  subject          text,
  applied          boolean not null default false,
  detail           jsonb not null default '{}'::jsonb
);
do $c$ begin
  alter table growth_outbound.replies drop constraint if exists replies_shape_ck;
  alter table growth_outbound.replies add constraint replies_shape_ck check (
        kind in ('reply', 'auto_reply', 'opt_out', 'test', 'unmatched')
    and length(resend_email_id) between 1 and 200 and length(event_id) between 1 and 200
    and (subject is null or length(subject) <= 200)
    and (kind = 'unmatched') = (send_id is null)
    and (kind <> 'unmatched' or subject is null)
    and (sequence_number is null or sequence_number between 1 and 3)
    and jsonb_typeof(detail) = 'object');
end $c$;
create unique index if not exists replies_email_uk on growth_outbound.replies (resend_email_id);
create index if not exists replies_at_idx on growth_outbound.replies (received_at desc);
create index if not exists replies_prospect_idx on growth_outbound.replies (prospect_id, received_at desc) where prospect_id is not null;

-- what the recipient did, first time only (opens are unreliable; kept as a hint)
alter table growth_outbound.sends add column if not exists opened_at timestamptz;
alter table growth_outbound.sends add column if not exists clicked_at timestamptz;

-- =============================================================================
-- 4d. THE RESEARCH ENGINE'S RECORD: what it read, what it found, what it cost
--
--   The engine (supabase/functions/growth_outbound_research) may find,
--   research, score and verify. It may not approve or send, and it may not
--   make anything up:
--     * every fact it records is a QUOTE from a page whose text is stored
--       here, and THIS DATABASE checks that the quote is on that page and
--       that the claim is in the quote (evidence_prepare);
--     * whether a page is the prospect's OWN site or profile (the sources
--       that weigh most) is decided here, from the prospect's identifiers,
--       never by the engine; a site many people write for (a publisher) is
--       nobody's own site;
--     * every provider call is counted against a daily budget the database
--       enforces.
-- =============================================================================
create table if not exists growth_outbound.research_runs (
  id            bigint generated always as identity primary key,
  kind          text not null,
  started_by    text not null default 'owner',
  requested_by  uuid,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',
  input         jsonb not null default '{}'::jsonb,
  counts        jsonb not null default '{}'::jsonb,
  error         text
);
do $c$ begin
  alter table growth_outbound.research_runs drop constraint if exists research_runs_shape_ck;
  alter table growth_outbound.research_runs add constraint research_runs_shape_ck check (
        kind in ('discover', 'research', 'draft', 'enrich') and started_by in ('owner', 'schedule')
    and status in ('running', 'done', 'failed')
    and jsonb_typeof(input) = 'object' and jsonb_typeof(counts) = 'object'
    and (error is null or length(error) <= 1000)
    and (finished_at is null) = (status = 'running'));
end $c$;
create index if not exists research_runs_started_idx on growth_outbound.research_runs (started_at desc);
-- A SCHEDULED run carries a single-use ticket, kept here only as its sha256:
-- the ticket itself exists only in the one request pg_net makes to the
-- engine. An owner's run has none.
alter table growth_outbound.research_runs add column if not exists ticket_sha256 text;
alter table growth_outbound.research_runs add column if not exists ticket_expires_at timestamptz;
do $c$ begin
  alter table growth_outbound.research_runs drop constraint if exists research_runs_ticket_ck;
  alter table growth_outbound.research_runs add constraint research_runs_ticket_ck check (
        (started_by = 'schedule') = (ticket_sha256 is not null)
    and (ticket_sha256 is null or ticket_sha256 ~ '^[0-9a-f]{64}$')
    and (ticket_sha256 is null) = (ticket_expires_at is null));
end $c$;
create unique index if not exists research_runs_ticket_uk on growth_outbound.research_runs (ticket_sha256) where ticket_sha256 is not null;

-- THE SCHEDULER'S RECORD: one row, what the last tick decided and why.
create table if not exists growth_outbound.scheduler (
  id            int primary key default 1,
  last_tick_at  timestamptz,
  last_action   text,
  last_reason   text,
  last_run_id   bigint references growth_outbound.research_runs (id) on delete restrict,
  ticks         bigint not null default 0
);
do $c$ begin
  alter table growth_outbound.scheduler drop constraint if exists scheduler_shape_ck;
  alter table growth_outbound.scheduler add constraint scheduler_shape_ck check (
    id = 1 and (last_action is null or last_action in ('started', 'idle', 'blocked'))
    and (last_reason is null or length(last_reason) <= 500));
end $c$;
insert into growth_outbound.scheduler (id) values (1) on conflict (id) do nothing;
-- when the results were last matched (Phase 10), and what went wrong if they
-- could not be
alter table growth_outbound.scheduler add column if not exists conversions_synced_at timestamptz;
alter table growth_outbound.scheduler add column if not exists conversions_error text;
do $c$ begin
  alter table growth_outbound.scheduler drop constraint if exists scheduler_results_ck;
  alter table growth_outbound.scheduler add constraint scheduler_results_ck check (
    conversions_error is null or length(conversions_error) <= 500);
end $c$;

-- THE DAILY EMAIL'S RECORD (2026-10): one row per morning (the owner-local
-- day the window opened), saying what was decided and what became of it.
-- Counts only: no address, no name, no draft. A note being written carries a
-- single-use ticket, kept here only as its sha256, like a scheduled run's.
--   skipped  nothing waited for review, so nothing was sent
--   sending  the ticket is out: the digest function writes and sends it
--   sent     Resend accepted it (its id)
--   failed   it did not go (reason); retryable only when it surely did not
create table if not exists growth_outbound.digests (
  id                 bigint generated always as identity primary key,
  day                date not null,
  status             text not null,
  reason             text,
  waiting            int not null default 0,
  recipient_owner    uuid,
  attempts           int not null default 0,
  retryable          boolean not null default false,
  ticket_sha256      text,
  ticket_expires_at  timestamptz,
  composed_at        timestamptz,
  sent_at            timestamptz,
  resend_message_id  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
do $c$ begin
  alter table growth_outbound.digests drop constraint if exists digests_shape_ck;
  alter table growth_outbound.digests add constraint digests_shape_ck check (
        status in ('skipped', 'sending', 'sent', 'failed')
    and (reason is null or length(reason) <= 300)
    and waiting >= 0 and attempts between 0 and 3
    and (ticket_sha256 is null or ticket_sha256 ~ '^[0-9a-f]{64}$')
    and (ticket_sha256 is null) = (ticket_expires_at is null)
    and (status <> 'sending' or ticket_sha256 is not null)
    and (status = 'sent') = (resend_message_id is not null)
    and (status = 'sent') = (sent_at is not null)
    and (resend_message_id is null or resend_message_id ~ '^[A-Za-z0-9_-]{1,100}$')
    and (status <> 'sent' or composed_at is not null));
end $c$;
create unique index if not exists digests_day_uk on growth_outbound.digests (day);
create unique index if not exists digests_ticket_uk on growth_outbound.digests (ticket_sha256) where ticket_sha256 is not null;

-- WHO RECEIVES THE DAILY EMAIL right now: the confirmed address of the owner
-- who turned it on, while they are still an owner. NULL: nobody (and then
-- nothing is sent).
create or replace function growth_outbound.digest_recipient()
returns text language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select growth_outbound.norm_email(u.email)
    from growth_outbound.settings s join auth.users u on u.id = s.digest_owner
   where s.id = 1 and u.email_confirmed_at is not null and growth_outbound.owner_active(u.id)
     and growth_outbound.valid_email(growth_outbound.norm_email(u.email));
$$;

-- =============================================================================
-- 4e. RESULTS: who came to EdgeDesk after an email (Phase 10)
--
-- A conversion is a fact about a prospect we WROTE TO (a live send that went
-- out): their link was visited, an account was made, a trial started, a
-- payment made. Matched two ways only:
--   link     the campaign code in their email's EdgeDesk links
--            (utm_campaign=ob_<their attribution token>) is the campaign
--            supabase/growth.sql recorded for the visit or the account
--   address  an account was made with the address we wrote to
-- and only for what happened AFTER the first email went out. Never a guess
-- from a name, a domain or a time alone.
--
-- The account itself is not recorded here: no user id, no account email.
-- account_key is a one-way hash of it, enough to count each person once.
-- Written only by sync_conversions(); never rewritten or deleted.
-- =============================================================================
create table if not exists growth_outbound.conversions (
  id            bigint generated always as identity primary key,
  prospect_id   uuid not null references growth_outbound.prospects (id) on delete restrict,
  stage         text not null,
  matched_by    text not null,
  account_key   text not null,
  occurred_at   timestamptz not null,
  recorded_at   timestamptz not null default now()
);
do $c$ begin
  alter table growth_outbound.conversions drop constraint if exists conversions_shape_ck;
  alter table growth_outbound.conversions add constraint conversions_shape_ck check (
        stage in ('visited', 'signed_up', 'trial', 'paid')
    and matched_by in ('link', 'address')
    and (stage <> 'visited' or matched_by = 'link')
    and account_key ~ '^[0-9a-f]{64}$');
end $c$;
create unique index if not exists conversions_once_uk on growth_outbound.conversions (prospect_id, stage, account_key);
create index if not exists conversions_at_idx on growth_outbound.conversions (occurred_at desc);

-- A page as the engine read it: its visible text, its links and its
-- structured data, exactly what a quote is checked against. Never rewritten.
create table if not exists growth_outbound.pages (
  id            bigint generated always as identity primary key,
  run_id        bigint references growth_outbound.research_runs (id) on delete restrict,
  url           text not null,
  site_key      text not null,
  fetched_at    timestamptz not null default now(),
  http_status   int not null,
  content_type  text,
  title         text,
  text          text not null,
  text_sha256   text not null
);
do $c$ begin
  alter table growth_outbound.pages drop constraint if exists pages_shape_ck;
  alter table growth_outbound.pages add constraint pages_shape_ck check (
        length(text) between 1 and 200000 and http_status between 100 and 599
    and text_sha256 ~ '^[0-9a-f]{64}$' and (title is null or length(title) <= 300)
    and (content_type is null or length(content_type) <= 100));
end $c$;
create index if not exists pages_url_idx on growth_outbound.pages (url, fetched_at desc);

-- What discovery turned up: a page that may lead to a person worth
-- researching. Not a prospect until research finds who it is.
create table if not exists growth_outbound.candidates (
  id             bigint generated always as identity primary key,
  url            text not null,
  site_key       text,
  title          text,
  snippet        text,
  query          text,
  provider       text not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  times_seen     int not null default 1,
  status         text not null default 'new',
  status_reason  text,
  prospect_id    uuid references growth_outbound.prospects (id) on delete restrict,
  first_run_id   bigint references growth_outbound.research_runs (id) on delete restrict,
  last_run_id    bigint references growth_outbound.research_runs (id) on delete restrict,
  updated_at     timestamptz not null default now()
);
do $c$ begin
  alter table growth_outbound.candidates drop constraint if exists candidates_shape_ck;
  alter table growth_outbound.candidates add constraint candidates_shape_ck check (
        status in ('new', 'researched', 'not_a_fit', 'duplicate', 'suppressed', 'failed', 'dismissed')
    and provider ~ '^[a-z0-9_-]{1,40}$' and times_seen >= 1
    and (title is null or length(title) <= 300) and (snippet is null or length(snippet) <= 1000)
    and (query is null or length(query) <= 200) and (status_reason is null or length(status_reason) <= 500));
end $c$;
create unique index if not exists candidates_url_uk on growth_outbound.candidates (url);
create index if not exists candidates_status_idx on growth_outbound.candidates (status, last_seen_at desc);
-- (Phase 13) who the owner means a candidate to be: a potential subscriber or
-- a partner lead. Given with an import or a directory; research makes it the
-- new prospect's campaign, over the model's own reading.
alter table growth_outbound.candidates add column if not exists segment_hint text;
do $c$ begin
  alter table growth_outbound.candidates drop constraint if exists candidates_segment_ck;
  alter table growth_outbound.candidates add constraint candidates_segment_ck check (
    segment_hint is null or segment_hint in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner'));
end $c$;
create index if not exists candidates_provider_idx on growth_outbound.candidates (provider, first_seen_at desc);

-- Every provider call, by day: the budget is enforced on these counts.
create table if not exists growth_outbound.provider_usage (
  day       date not null,
  provider  text not null,
  calls     int not null default 0,
  primary key (day, provider)
);
do $c$ begin
  alter table growth_outbound.provider_usage drop constraint if exists provider_usage_shape_ck;
  alter table growth_outbound.provider_usage add constraint provider_usage_shape_ck check (
    provider in ('search', 'fetch', 'llm', 'email_finder', 'email_verifier', 'enrichment') and calls >= 0);
end $c$;

-- an engine fact cites the stored page it was read from
alter table growth_outbound.evidence add column if not exists page_id bigint references growth_outbound.pages (id) on delete restrict;
-- an engine draft names the run that wrote it
alter table growth_outbound.drafts add column if not exists run_id bigint references growth_outbound.research_runs (id) on delete restrict;

-- THE BUDGET. The owner sets each daily figure (discovery_config.budget) up to
-- the ceiling written here; past the ceiling takes a change to this file.
create or replace function growth_outbound.budget_ceiling(p_provider text)
returns int language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_provider when 'search' then 200 when 'fetch' then 2000 when 'llm' then 400
                         when 'email_finder' then 200 when 'email_verifier' then 400 when 'enrichment' then 200 else 0 end;
$$;
create or replace function growth_outbound.budget_default(p_provider text)
returns int language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_provider when 'search' then 20 when 'fetch' then 150 when 'llm' then 30
                         when 'email_finder' then 15 when 'email_verifier' then 30 when 'enrichment' then 15 else 0 end;
$$;

-- Sites many people write for: a page there is a publication, never anyone's
-- own site, whoever it is about. The owner adds more (discovery_config.shared_sites).
create or replace function growth_outbound.builtin_shared_sites()
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select array['espn.com', 'theathletic.com', 'nytimes.com', 'actionnetwork.com', 'covers.com', 'si.com', 'cbssports.com',
    'foxsports.com', 'yahoo.com', 'bleacherreport.com', 'sbnation.com', 'theringer.com', '247sports.com', 'on3.com',
    'rivals.com', 'apnews.com', 'usatoday.com', 'nbcsports.com', 'fantasypros.com', 'draftkings.com', 'fanduel.com',
    'vsin.com', 'oddsshark.com', 'pff.com', 'wikipedia.org', 'forbes.com', 'washingtonpost.com', 'wsj.com', 'theguardian.com',
    'bbc.co.uk', 'cnn.com', 'nfl.com', 'ncaa.com', 'sportingnews.com', 'thespun.com', 'sportsline.com', 'oddschecker.com',
    'vegasinsider.com', 'pickswise.com', 'sportsbookreview.com', 'bettingpros.com', 'rotowire.com', 'numberfire.com',
    'barstoolsports.com', 'outkick.com', 'deadspin.com', 'footballoutsiders.com', 'kenpom.com', 'collegefootballnews.com',
    'podcasts.apple.com', 'open.spotify.com', 'apple.com', 'spotify.com', 'google.com', 'reddit.com', 'news.ycombinator.com'];
$$;

create or replace function growth_outbound.is_shared_site(p_site text)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p_site is not null and (p_site = any (growth_outbound.builtin_shared_sites())
    or exists (select 1 from growth_outbound.settings s, jsonb_array_elements_text(
                 case when jsonb_typeof(s.discovery_config->'shared_sites') = 'array' then s.discovery_config->'shared_sites' else '[]'::jsonb end) x
                where s.id = 1 and lower(btrim(x)) = p_site));
$$;

-- What is wrong with a discovery configuration, in words (NULL: nothing).
--   { queries: [text], budget: {provider: int}, shared_sites: [domain],
--     providers: {brave|apollo_search|apollo_org|podcastindex|hunter|apollo|clay: boolean},   (Phase 12, 13)
--     directories: [{ url, segment?, note?, permitted: true }] }                               (Phase 13)
-- A provider is used when its key is set AND it is not switched off here;
-- Apollo and Clay cost money per call, so they are used only when switched on.
-- A DIRECTORY is a public page the owner chose (a list of newsletters, a
-- podcast network's roster) whose outbound links become candidates; the owner
-- says they checked its terms permit that (permitted: true), and robots.txt
-- still decides whether it is read at all.
create or replace function growth_outbound.discovery_config_problems(p jsonb)
returns text language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  k text;
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'discovery_config must be an object'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('queries', 'budget', 'shared_sites', 'providers', 'directories') then return 'unknown discovery setting "' || left(k, 40) || '"'; end if;
  end loop;
  if p ? 'queries' then
    if jsonb_typeof(p->'queries') <> 'array' or jsonb_array_length(p->'queries') > 25 then
      return 'queries: a list of at most 25 searches';
    end if;
    for v in select x from jsonb_array_elements(p->'queries') x loop
      if jsonb_typeof(v) <> 'string' or length(btrim(v #>> '{}')) not between 3 and 200 or (v #>> '{}') ~ '[\r\n]' then
        return 'queries: each search is one line of 3 to 200 characters';
      end if;
    end loop;
  end if;
  if p ? 'budget' then
    if jsonb_typeof(p->'budget') <> 'object' then return 'budget: an object of daily call counts'; end if;
    for k, v in select * from jsonb_each(p->'budget') loop
      if k not in ('search', 'fetch', 'llm', 'email_finder', 'email_verifier', 'enrichment') then
        return 'budget: unknown provider "' || left(k, 40) || '"';
      end if;
      if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,5}$' then return 'budget: ' || k || ' must be a whole number'; end if;
      if (v #>> '{}')::int > growth_outbound.budget_ceiling(k) then
        return 'budget: ' || k || ' may be at most ' || growth_outbound.budget_ceiling(k) || ' a day';
      end if;
    end loop;
  end if;
  if p ? 'providers' then
    if jsonb_typeof(p->'providers') <> 'object' then return 'providers: an object of on/off switches'; end if;
    for k, v in select * from jsonb_each(p->'providers') loop
      if k not in ('brave', 'apollo_search', 'apollo_org', 'podcastindex', 'hunter', 'apollo', 'clay') then
        return 'providers: unknown provider "' || left(k, 40) || '"';
      end if;
      if jsonb_typeof(v) <> 'boolean' then return 'providers: ' || k || ' is true or false'; end if;
    end loop;
  end if;
  if p ? 'shared_sites' then
    if jsonb_typeof(p->'shared_sites') <> 'array' or jsonb_array_length(p->'shared_sites') > 300 then
      return 'shared_sites: a list of at most 300 domains';
    end if;
    for v in select x from jsonb_array_elements(p->'shared_sites') x loop
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then
        return 'shared_sites: each entry is a bare domain such as example.com';
      end if;
    end loop;
  end if;
  if p ? 'directories' then
    if jsonb_typeof(p->'directories') <> 'array' or jsonb_array_length(p->'directories') > 30 then
      return 'directories: a list of at most 30 pages';
    end if;
    for v in select x from jsonb_array_elements(p->'directories') x loop
      if jsonb_typeof(v) <> 'object' then return 'directories: each entry is { url, segment?, note?, permitted }'; end if;
      for k in select jsonb_object_keys(v) loop
        if k not in ('url', 'segment', 'note', 'permitted') then return 'directories: unknown field "' || left(k, 40) || '"'; end if;
      end loop;
      if jsonb_typeof(v->'url') is distinct from 'string' or (v->>'url') !~ '^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s]*)?$'
         or length(v->>'url') > 500 then
        return 'directories: each url is one https:// page address';
      end if;
      if (v->'permitted') is distinct from 'true'::jsonb then
        return 'directories: ' || left(v->>'url', 80) || ' needs permitted: true (you checked that its terms allow reusing its links)';
      end if;
      if v ? 'segment' and coalesce(v->>'segment', '') not in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner') then
        return 'directories: segment is customer, partnership, media_partner, affiliate or business_partner';
      end if;
      if v ? 'note' and (jsonb_typeof(v->'note') <> 'string' or length(v->>'note') > 200) then
        return 'directories: a note is at most 200 characters';
      end if;
    end loop;
  end if;
  return null;
end $$;
do $c$ begin
  alter table growth_outbound.settings drop constraint if exists outbound_settings_discovery;
  alter table growth_outbound.settings add constraint outbound_settings_discovery check (
    growth_outbound.discovery_config_problems(discovery_config) is null);
end $c$;

-- Today's budget, provider by provider: the cap, what is used, what is left.
create or replace function growth_outbound.research_budget()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_object_agg(p.provider, jsonb_build_object('cap', p.cap, 'used', coalesce(u.calls, 0), 'left', greatest(p.cap - coalesce(u.calls, 0), 0)))
    from (select x.provider, coalesce((s.discovery_config->'budget'->>x.provider)::int, growth_outbound.budget_default(x.provider)) cap
            from unnest(array['search', 'fetch', 'llm', 'email_finder', 'email_verifier', 'enrichment']) x(provider), growth_outbound.settings s
           where s.id = 1) p
    left join growth_outbound.provider_usage u on u.provider = p.provider and u.day = (now() at time zone 'utc')::date;
$$;

-- Is a quote in a text? Whole words, ignoring case, spacing and punctuation:
-- "Pat runs CFB Numbers." contains "runs cfb numbers" but not "run".
create or replace function growth_outbound.quote_in(p_needle text, p_haystack text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select growth_outbound.norm_text(p_needle) is not null and growth_outbound.norm_text(p_haystack) is not null
     and position(' ' || growth_outbound.norm_text(p_needle) || ' ' in ' ' || growth_outbound.norm_text(p_haystack) || ' ') > 0;
$$;

-- OWN OR NOT, decided here. A page is the prospect's own profile when its
-- handle is one of the prospect's; their own site when it is the prospect's
-- website, nobody else's site, and not a publisher's. Anything else is what
-- the engine said it was among the third-party kinds (a publication by
-- default) — never "own".
create or replace function growth_outbound.engine_source_kind(p_prospect uuid, p_url text, p_proposed text)
returns text language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare k record;
begin
  for k in select * from growth_outbound.url_identity(p_url) loop
    if k.kind = 'handle' and exists (select 1 from growth_outbound.identifiers i where i.prospect_id = p_prospect
         and i.kind = 'handle' and i.value = k.value and i.released_at is null) then
      return 'own_profile';
    end if;
    if k.kind = 'site' and not growth_outbound.is_shared_site(k.value)
       and exists (select 1 from growth_outbound.prospects p where p.id = p_prospect
                     and growth_outbound.site_key(growth_outbound.url_host(p.website_url)) = k.value)
       and not exists (select 1 from growth_outbound.identifiers i where i.kind = 'site' and i.value = k.value
                         and i.prospect_id <> p_prospect and i.released_at is null) then
      return 'own_site';
    end if;
  end loop;
  return case when p_proposed in ('interview', 'directory') then p_proposed else 'publication' end;
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
drop trigger if exists provider_events_append_only_t on growth_outbound.provider_events;
create trigger provider_events_append_only_t before update or delete on growth_outbound.provider_events
  for each row execute function growth_outbound.append_only();
drop trigger if exists replies_append_only_t on growth_outbound.replies;
create trigger replies_append_only_t before update or delete on growth_outbound.replies
  for each row execute function growth_outbound.append_only();

-- A page as read: stored in canonical form, its hash computed here; never
-- rewritten, so a quote checked against it stays checked.
create or replace function growth_outbound.pages_prepare()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare v_c text := growth_outbound.canonical_url(new.url);
begin
  if v_c is null then
    raise exception 'a page is a web address (https://…)' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(new.text, '')), '') is null then
    raise exception 'a page with no text has nothing to quote' using errcode = 'check_violation';
  end if;
  new.url := v_c;
  new.site_key := growth_outbound.site_key(growth_outbound.url_host(v_c));
  new.title := left(nullif(btrim(regexp_replace(coalesce(new.title, ''), '\s+', ' ', 'g')), ''), 300);
  new.content_type := left(nullif(btrim(coalesce(new.content_type, '')), ''), 100);
  new.text_sha256 := encode(sha256(convert_to(new.text, 'UTF8')), 'hex');
  new.fetched_at := now();
  return new;
end $$;
drop trigger if exists pages_prepare_t on growth_outbound.pages;
create trigger pages_prepare_t before insert on growth_outbound.pages
  for each row execute function growth_outbound.pages_prepare();
drop trigger if exists pages_append_only_t on growth_outbound.pages;
create trigger pages_append_only_t before update or delete on growth_outbound.pages
  for each row execute function growth_outbound.append_only();

-- A secret is written from the SQL editor only — never through the API, not
-- even by a security-definer function added later by mistake.
create or replace function growth_outbound.secrets_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  if growth_outbound.api_origin() then
    raise exception 'secrets are set in the Supabase SQL editor only' using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists secrets_guard_t on growth_outbound.secrets;
create trigger secrets_guard_t before insert or update or delete on growth_outbound.secrets
  for each row execute function growth_outbound.secrets_guard();

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
drop trigger if exists candidates_never_delete_t on growth_outbound.candidates;
create trigger candidates_never_delete_t before delete on growth_outbound.candidates
  for each row execute function growth_outbound.never_delete();
drop trigger if exists research_runs_never_delete_t on growth_outbound.research_runs;
create trigger research_runs_never_delete_t before delete on growth_outbound.research_runs
  for each row execute function growth_outbound.never_delete();
drop trigger if exists digests_never_delete_t on growth_outbound.digests;
create trigger digests_never_delete_t before delete on growth_outbound.digests
  for each row execute function growth_outbound.never_delete();

-- A conversion is written by the matcher only, and never rewritten: what
-- the owner reads as results is what was matched, when it was matched.
create or replace function growth_outbound.conversions_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if coalesce(current_setting('growth_outbound.door', true), '') <> 'sync_conversions' then
    raise exception 'a conversion is recorded only by the matcher (growth_outbound.sync_conversions)'
      using errcode = 'insufficient_privilege';
  end if;
  new.recorded_at := now();
  return new;
end $$;
drop trigger if exists conversions_guard_t on growth_outbound.conversions;
create trigger conversions_guard_t before insert on growth_outbound.conversions
  for each row execute function growth_outbound.conversions_guard();
drop trigger if exists conversions_append_only_t on growth_outbound.conversions;
create trigger conversions_append_only_t before update or delete on growth_outbound.conversions
  for each row execute function growth_outbound.append_only();

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
  v_page_url text;
  v_page_text text;
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

  -- THE ENGINE QUOTES, AND THE QUOTE IS CHECKED HERE: the page it cites is
  -- stored, the quote is on that page, the claim is in the quote (only a fit
  -- signal may be put in other words), and whether the page is the
  -- prospect's own is this database's call, not the engine's.
  if new.page_id is not null and coalesce(new.collected_by, '') <> 'research_engine' then
    raise exception 'only the research engine cites a stored page' using errcode = 'check_violation';
  end if;
  if new.collected_by = 'research_engine' then
    if new.source_kind not in ('own_site', 'own_profile', 'publication', 'interview', 'directory') then
      raise exception 'the research engine records only what a page says, never a % source', new.source_kind
        using errcode = 'check_violation';
    end if;
    if new.page_id is null then
      raise exception 'the research engine cites the stored page it read (page_id)' using errcode = 'check_violation';
    end if;
    select url, text into v_page_url, v_page_text from growth_outbound.pages where id = new.page_id;
    if v_page_url is null then
      raise exception 'page % is not stored', new.page_id using errcode = 'check_violation';
    end if;
    if v_page_url <> new.source_url then
      raise exception 'the source is not the page cited (engine_source_mismatch)' using errcode = 'check_violation';
    end if;
    if not growth_outbound.quote_in(new.source_excerpt, v_page_text) then
      raise exception 'that quote is not on the page (engine_quote_not_on_page)' using errcode = 'check_violation';
    end if;
    if (new.field_name = 'email' and position(new.claim_norm in lower(new.source_excerpt)) = 0)
       or (new.field_name = 'audience_size'
           and position(regexp_replace(lower(new.claim), '[,\s_]', '', 'g') in regexp_replace(lower(new.source_excerpt), '[,\s_]', '', 'g')) = 0)
       or (new.field_name not in ('email', 'audience_size', 'fit_signal') and not growth_outbound.quote_in(new.claim, new.source_excerpt)) then
      raise exception 'the claim is not in the quote, word for word (engine_claim_not_in_quote)' using errcode = 'check_violation';
    end if;
    new.source_kind := growth_outbound.engine_source_kind(new.prospect_id, new.source_url, new.source_kind);
    new.confidence := growth_outbound.source_weight(new.source_kind, new.field_name);
  end if;
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
      new.collected_by, new.page_id)
     is distinct from
     (old.prospect_id, old.field_name, old.claim, old.claim_norm, old.source_url, old.source_kind, old.source_domain,
      old.source_key, old.source_title, old.source_excerpt, old.source_published_at, old.observed_at, old.confidence,
      old.collected_by, old.page_id)
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
        new.last_researched_at, new.duplicate_of, new.qualification_score, new.first_qualified_at) is distinct from
       (null::text, null::text, null::text, null::text, null::text, null::text, null::text, null::int, null::text,
        null::int, null::text, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
        null::timestamptz, null::uuid, null::int, null::timestamptz)
       or new.email_status <> 'none' or new.warnings <> '[]'::jsonb or new.assessment <> '{}'::jsonb
       or new.qualification <> '{}'::jsonb
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
      new.warnings, new.assessment, new.last_researched_at, new.duplicate_of,
      new.qualification_score, new.qualification, new.first_qualified_at)
     is distinct from
     (old.full_name, old.first_name, old.last_name, old.organization, old.job_title, old.email_status, old.email_source_url,
      old.email_source_kind, old.audience_size_estimate, old.audience_source_url, old.fit_score, old.fit_reason,
      old.identity_confidence, old.role_confidence, old.email_confidence, old.research_confidence, old.fit_confidence,
      old.warnings, old.assessment, old.last_researched_at, old.duplicate_of,
      old.qualification_score, old.qualification, old.first_qualified_at) then
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
  v_prev timestamptz;
  v_days int;
  v_cap int;
begin
  if tg_op = 'UPDATE' then
    if (new.prospect_id, new.draft_id, new.sequence_number, new.is_test, new.idempotency_key, new.sender,
        new.intended_recipient, new.recipient, new.subject, new.content_hash, new.claimed_at, new.claimed_by, new.optout_token,
        new.links_tagged)
       is distinct from
       (old.prospect_id, old.draft_id, old.sequence_number, old.is_test, old.idempotency_key, old.sender,
        old.intended_recipient, old.recipient, old.subject, old.content_hash, old.claimed_at, old.claimed_by, old.optout_token,
        old.links_tagged)
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
  v_blockers := growth_outbound.send_blockers_for(s.test_mode or p.is_test or d.is_test);
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
    -- a customer is never cold-emailed: this address already has an account
    -- (or made one after an earlier step, and the sequence is over)
    if growth_outbound.has_account(new.intended_recipient) then
      raise exception 'this address already has an EdgeDesk account' using errcode = 'insufficient_privilege';
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
    -- a follow-up only on the cadence in the settings: while it is turned on,
    -- after the step before it went out (and did not bounce), and once its
    -- delay has passed
    if new.sequence_number > 1 then
      if (new.sequence_number = 2 and not s.followup_enabled) or (new.sequence_number = 3 and not s.final_followup_enabled) then
        raise exception '%', case when new.sequence_number = 2 then 'follow-ups are turned off in the settings'
                                  else 'the final follow-up is turned off in the settings' end
          using errcode = 'insufficient_privilege';
      end if;
      v_prev := growth_outbound.step_sent_at(new.prospect_id, new.sequence_number - 1);
      if v_prev is null then
        raise exception 'step % goes out only after step % did', new.sequence_number, new.sequence_number - 1
          using errcode = 'insufficient_privilege';
      end if;
      v_days := case when new.sequence_number = 2 then s.followup_delay_days else s.final_followup_delay_days end;
      if v_prev > now() - make_interval(days => v_days) then
        raise exception 'step % is not due until % UTC', new.sequence_number,
          to_char((v_prev + make_interval(days => v_days)) at time zone 'utc', 'YYYY-MM-DD HH24:MI')
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    select count(*) into v_n from growth_outbound.sends where not is_test and claimed_at >= date_trunc('day', now());
    if v_n >= s.max_sends_per_day then
      raise exception 'the daily send cap (%) is reached', s.max_sends_per_day using errcode = 'insufficient_privilege';
    end if;
    -- a new sending domain warms up (Phase 12): today's cap grows week by week
    v_cap := (growth_outbound.live_send_cap()->>'cap')::int;
    if v_n >= v_cap then
      raise exception 'today''s warm-up cap (%) is reached; it grows by % a week up to the daily cap of %',
        v_cap, s.warmup_step_per_week, s.max_sends_per_day using errcode = 'insufficient_privilege';
    end if;
  end if;
  new.claimed_at := now();
  new.delivery_status := 'claimed';
  new.sender := s.sender_name || ' <' || s.sender_email || '>';
  -- this send's own opt-out token: 128 random bits, hex
  new.optout_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  new.attempts := 1;
  new.last_attempt_at := now();
  new.links_tagged := s.attribution_links;
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
                           'sends', 'suppressions', 'activity', 'identifiers', 'fit_factor_catalog', 'secrets',
                           'provider_events', 'research_runs', 'pages', 'candidates', 'provider_usage', 'scheduler',
                           'conversions', 'digests', 'replies'] loop
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

-- TODAY'S LIVE CAP (Phase 12): the daily cap, or less while the domain warms
-- up. Week 0 starts the day of the first live email that went out; each week
-- after adds warmup_step_per_week, never past max_sends_per_day.
create or replace function growth_outbound.live_send_cap()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('cap', case when s.warmup_enabled
                                       then least(s.max_sends_per_day, s.warmup_start_per_day + s.warmup_step_per_week * w.week)
                                       else s.max_sends_per_day end,
                            'max', s.max_sends_per_day, 'warmup', s.warmup_enabled, 'week', w.week, 'first_live_at', w.first_at,
                            'start', s.warmup_start_per_day, 'step', s.warmup_step_per_week,
                            'warming', s.warmup_enabled and s.warmup_start_per_day + s.warmup_step_per_week * w.week < s.max_sends_per_day)
    from growth_outbound.settings s
   cross join lateral (select min(x.sent_at) as first_at,
                              coalesce(floor(extract(epoch from now() - min(x.sent_at)) / 604800)::int, 0) as week
                         from growth_outbound.sends x where not x.is_test and x.sent_at is not null) w
   where s.id = 1;
$$;

create or replace function growth_outbound.settings_json()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select to_jsonb(s) - 'id' - 'digest_owner' || jsonb_build_object(
    -- the daily email's address is the owner's own, shown, never typed in
    'digest_to', case when s.digest_enabled then growth_outbound.digest_recipient() end,
    'send_blockers', to_jsonb(growth_outbound.send_blockers()),
    'test_send_blockers', to_jsonb(growth_outbound.send_blockers_for(true)),
    'live_send_blockers', to_jsonb(growth_outbound.send_blockers_for(false)),
    'webhook', jsonb_build_object(
      'secret_set', exists (select 1 from growth_outbound.secrets where name = 'resend_webhook'),
      'last_event_at', (select max(received_at) from growth_outbound.provider_events where outcome <> 'not_outbound'),
      'events_24h', (select count(*) from growth_outbound.provider_events where outcome <> 'not_outbound' and received_at >= now() - interval '24 hours'),
      -- (Phase 13) a signed event has arrived since the current secret was set
      'proven', exists (select 1 from growth_outbound.provider_events e, growth_outbound.secrets k
                         where k.name = 'resend_webhook' and e.received_at >= k.set_at)),
    'today', jsonb_build_object(
      'live_sends', (select count(*) from growth_outbound.sends where not is_test and claimed_at >= date_trunc('day', now())),
      'test_sends', (select count(*) from growth_outbound.sends where is_test and claimed_at >= date_trunc('day', now())),
      'cap', s.max_sends_per_day, 'test_cap', s.max_test_sends_per_day,
      'live_cap', growth_outbound.live_send_cap(),
      'qualified', (select count(*) from growth_outbound.prospects p where not p.is_test and p.campaign_type = 'customer'
                     and p.first_qualified_at >= date_trunc('day', now()))))
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
    'discovery_config', 'automation_timezone', 'automation_start_hour', 'automation_hours', 'attribution_links',
    'min_qualification_score', 'daily_qualified_target', 'warmup_enabled', 'warmup_start_per_day', 'warmup_step_per_week',
    'landing_by_interest', 'digest_enabled', 'reply_detection', 'partner_outreach_enabled'];
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
  if p ? 'discovery_config' and growth_outbound.discovery_config_problems(p->'discovery_config') is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_value',
      'detail', growth_outbound.discovery_config_problems(p->'discovery_config'));
  end if;
  select * into v_old from growth_outbound.settings where id = 1 for update;
  -- (Phase 13) the test inbox is the owner's own: never an address the engine
  -- is writing to (every test send would reach that person), never one that
  -- asked to stop
  if p ? 'test_inbox' and growth_outbound.norm_email(p->>'test_inbox') is not null then
    if exists (select 1 from growth_outbound.prospects x where not x.is_test
                and growth_outbound.norm_email(x.email) = growth_outbound.norm_email(p->>'test_inbox')) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_value',
        'detail', 'the test inbox must be your own address: this one belongs to a prospect');
    end if;
    if growth_outbound.is_suppressed(p->>'test_inbox') then
      return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', 'the test inbox is a suppressed address');
    end if;
  end if;
  begin
    if p ? 'max_sends_per_day' and (p->>'max_sends_per_day')::int > v_old.max_sends_per_day
       and coalesce((p->>'confirm_cap_increase')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'reason', 'cap_increase_needs_confirmation',
        'detail', format('raising the daily cap from %s to %s needs confirm_cap_increase', v_old.max_sends_per_day, p->>'max_sends_per_day'));
    end if;
    -- loosening the warm-up raises what can go out today, like raising the cap
    if ((p ? 'warmup_enabled' and (p->>'warmup_enabled')::boolean is false and v_old.warmup_enabled)
        or (p ? 'warmup_start_per_day' and (p->>'warmup_start_per_day')::int > v_old.warmup_start_per_day)
        or (p ? 'warmup_step_per_week' and (p->>'warmup_step_per_week')::int > v_old.warmup_step_per_week))
       and coalesce((p->>'confirm_cap_increase')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'reason', 'cap_increase_needs_confirmation',
        'detail', 'turning the warm-up off or speeding it up raises today''s cap; it needs confirm_cap_increase');
    end if;
    -- THE DAILY EMAIL goes to the owner who turns it on, at their account's
    -- own confirmed address: there is no address to type, so none to misuse
    if (p->>'digest_enabled')::boolean is true and not exists (
         select 1 from auth.users u where u.id = v_owner and u.email_confirmed_at is not null
            and growth_outbound.valid_email(growth_outbound.norm_email(u.email))) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_value',
        'detail', 'the daily email goes to your account''s own address, and yours is not confirmed');
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
      automation_timezone       = coalesce(nullif(btrim(p->>'automation_timezone'), ''), automation_timezone),
      automation_start_hour     = coalesce((p->>'automation_start_hour')::int, automation_start_hour),
      automation_hours          = coalesce((p->>'automation_hours')::int, automation_hours),
      attribution_links         = coalesce((p->>'attribution_links')::boolean, attribution_links),
      min_qualification_score   = coalesce((p->>'min_qualification_score')::int, min_qualification_score),
      daily_qualified_target    = coalesce((p->>'daily_qualified_target')::int, daily_qualified_target),
      warmup_enabled            = coalesce((p->>'warmup_enabled')::boolean, warmup_enabled),
      warmup_start_per_day      = coalesce((p->>'warmup_start_per_day')::int, warmup_start_per_day),
      warmup_step_per_week      = coalesce((p->>'warmup_step_per_week')::int, warmup_step_per_week),
      landing_by_interest       = coalesce((p->>'landing_by_interest')::boolean, landing_by_interest),
      digest_enabled            = coalesce((p->>'digest_enabled')::boolean, digest_enabled),
      reply_detection           = coalesce((p->>'reply_detection')::boolean, reply_detection),
      digest_owner              = case (p->>'digest_enabled')::boolean when true then v_owner when false then null else digest_owner end,
      partner_outreach_enabled  = coalesce((p->>'partner_outreach_enabled')::boolean, partner_outreach_enabled),
      updated_at = now(), updated_by = v_owner
    where id = 1
    returning * into v_new;
  exception when check_violation or data_exception then
    return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', sqlerrm);
  end;
  foreach k in array v_keys || array['digest_owner'] loop
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
    -- what they wrote back, as Resend received it (2026-10): subject and kind, never the body
    'replies', coalesce((select jsonb_agg(jsonb_build_object('received_at', r.received_at, 'kind', r.kind, 'subject', r.subject,
                           'sequence_number', r.sequence_number, 'applied', r.applied) order by r.received_at desc)
                          from growth_outbound.replies r where r.prospect_id = p.id), '[]'::jsonb),
    -- what came of it: visits, an account, a trial, a payment (never whose account)
    'conversions', coalesce((select jsonb_agg(jsonb_build_object('stage', c.stage, 'matched_by', c.matched_by, 'occurred_at', c.occurred_at,
                              'recorded_at', c.recorded_at) order by c.occurred_at, c.id)
                               from growth_outbound.conversions c where c.prospect_id = p.id), '[]'::jsonb),
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
-- prospect is marked suppressed and every unsent draft of theirs cancelled
-- (growth_outbound.apply_suppression: the same for a bounce, a complaint, an
-- opt-out and a reply).
create or replace function public.growth_outbound_suppress(
  p_target text, p_kind text default 'manual', p_reason text default null, p_scope text default 'address')
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  r jsonb;
begin
  v_owner := growth_outbound.require_owner();
  r := growth_outbound.apply_suppression(coalesce(p_scope, 'address'), p_target, coalesce(p_kind, 'manual'), p_reason, 'owner', v_owner, null);
  if coalesce((r->>'ok')::boolean, false) then
    perform growth_outbound.log('suppression_created', null, 'suppression', r->>'id',
      jsonb_build_object('scope', coalesce(p_scope, 'address'), 'kind', coalesce(p_kind, 'manual'),
                         'prospects', r->'prospects_suppressed', 'drafts_cancelled', r->'drafts_cancelled'));
  end if;
  return r;
end $$;

-- APPROVE: the owner's explicit act, for the exact content they reviewed.
-- It sends nothing. Every gate — the assessment, re-evaluated now, and the
-- content rules — is re-checked server-side, in growth_outbound.approve_one().
create or replace function public.growth_outbound_draft_approve(p_draft_id uuid, p_content_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
begin
  v_owner := growth_outbound.require_owner();
  return growth_outbound.approve_one(v_owner, p_draft_id, p_content_hash);
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
                            'source_published_at', 'supersedes', 'page_id'];
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
                                            source_excerpt, source_published_at, collected_by, page_id)
      values (v_id, v_item->>'field_name', v_item->>'claim', v_item->>'source_url', coalesce(v_item->>'source_kind', 'directory'),
              v_item->>'source_title', v_item->>'source_excerpt', (v_item->>'source_published_at')::timestamptz, v_collector,
              (v_item->>'page_id')::bigint)
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
    -- data_exception is every SQLSTATE 22xxx (a bad date, number, time zone,
    -- text …): a malformed field is refused in words, whatever form it takes
    when check_violation or not_null_violation or foreign_key_violation or data_exception then
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
  perform growth_outbound.require_engine();
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

-- ── review: the queue, the content rules, the preview, approving ─────────────

create index if not exists drafts_status_idx on growth_outbound.drafts (status, generated_at desc);

-- THE CONTENT RULES every draft is approved within, test or not. EdgeDesk is
-- a research platform, not picks: no promised winnings, locks or guarantees;
-- one price ($49.99 a month); one trial (7 days, free); links to EdgeDesk
-- only; nothing left unfilled; no subject that pretends to be a reply.
-- Erring strict on purpose: "we never promise winnings" is refused too —
-- say what EdgeDesk does instead.
create or replace function growth_outbound.draft_lint(p_subject text, p_body text)
returns text[] language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  t text := lower(coalesce(p_subject, '') || E'\n' || coalesce(p_body, ''));
  v text[] := '{}';
  m text[];
begin
  if t ~ ('\m(locks?|guarantee[sd]?|can''?t lose|cannot lose|sure thing|free money|easy money|risk[- ]free|no[- ]risk|'
          || 'winnings|get rich|guaranteed profits?|beat the (books|sportsbooks) every)\M') then
    v := array_append(v, 'promises winnings, a lock or a guarantee'::text);
  end if;
  for m in select regexp_matches(t, '\$\s?([0-9][0-9,]*(\.[0-9]{1,2})?)', 'g') loop
    if replace(m[1], ',', '') <> '49.99' then
      v := array_append(v, ('the price is $49.99/month, not $' || m[1])::text);
      exit;
    end if;
  end loop;
  for m in select regexp_matches(t, '\m([0-9]+|a|an|one|two|three|five|seven|ten|fourteen|thirty)[- ]?(day|week|month)s?[- ](free[- ])?trial', 'g') loop
    if not ((m[1] in ('7', 'seven') and m[2] = 'day') or (m[1] in ('1', 'a', 'one') and m[2] = 'week')) then
      v := array_append(v, 'the free trial is 7 days'::text);
      exit;
    end if;
  end loop;
  for m in select regexp_matches(t, '(https?://|www\.)([a-z0-9.-]+)', 'g') loop
    if m[2] !~ '(^|\.)edgedesksports\.com$' then
      v := array_append(v, ('links go to edgedesksports.com only, not ' || m[2])::text);
      exit;
    end if;
  end loop;
  if t ~ '\{\{|\}\}|\[(first ?name|last ?name|name|company|organization|org|todo|tbd|insert[^]]*)\]|lorem ipsum' then
    v := array_append(v, 'something is left unfilled'::text);
  end if;
  if coalesce(p_subject, '') ~* '^\s*(re|fw|fwd)\s*:' then
    v := array_append(v, 'the subject pretends to be a reply or a forward'::text);
  end if;
  -- (Phase 12) the offer is the 7-day free trial, then $49.99/month: nothing
  -- free beyond it, no discount, no special access
  if t ~ ('\m(complimentary|comped|on the house|gratis|coupons?|(discount|promo|promotional|referral) codes?|comp (you|them|your))\M'
          || '|\mfree (subscriptions?|accounts?|access|memberships?|months?|years?|seats?|licen[cs]es?|upgrades?)\M'
          || '|\mdiscounted (price|rate|subscriptions?|access|plan)\M|\m[0-9]{1,3} ?% (off|discount)'
          || '|\m(special|exclusive|early|vip|lifetime|priority|insider|founding[- ]member) access\M') then
    v := array_append(v, 'offers something beyond the 7-day free trial (free or discounted access, special access)'::text);
  end if;
  -- research, not picks: nothing that reads like a picks or tips service
  if t ~ ('\m(best bets?|(bets?|picks?|plays?|locks?) of the (day|week)|(our|my|today''?s|weekly|daily|winning|premium|expert|free|vip|top|hot) picks'
          || '|betting tips|tipsters?|touts?|touting|sure bets?)\M') then
    v := array_append(v, 'reads like a picks service (EdgeDesk is research, not picks)'::text);
  end if;
  -- (Phase 13) how a founder writes to a stranger: no pressure, no pretended
  -- history, no flattery
  if t ~ ('\m(act now|act fast|limited[- ]time|today only|last chance|final chance|hurry|don''?t miss (out|this)|before it''?s too late'
          || '|expires? (today|tonight|soon|at midnight)|offer ends|only [0-9]+ (spots?|seats?|places?) (left|remaining)|spots? (are )?filling'
          || '|urgent(ly)?|time[- ]sensitive|respond (now|immediately|asap))\M') then
    v := array_append(v, 'pushes with urgency (no deadlines or scarcity; let them decide in their own time)'::text);
  end if;
  if t ~ ('\m(as (we|i) (discussed|promised|mentioned on our call)|per our (conversation|call|chat)'
          || '|following up on our (call|conversation|chat|meeting)|great (chatting|talking|speaking|connecting) with you'
          || '|you (may|might) remember me|long time no (see|talk)|good to reconnect|as you (know|requested|asked))\M') then
    v := array_append(v, 'pretends to a familiarity or a conversation that never happened'::text);
  end if;
  if t ~ ('\m(huge fan|big fan|biggest fan|love (your|all your) (work|content|stuff)|amazing|incredible|brilliant|genius'
          || '|world[- ]class|legendary|best in the (business|industry|game)|the best (analyst|newsletter|podcast|model)'
          || '|blown away|obsessed with)\M') then
    v := array_append(v, 'flatters (say plainly what you noticed, with no superlatives)'::text);
  end if;
  return array(select distinct x from unnest(v) x order by 1);
end $$;

-- WHAT EVERY ENGINE EMAIL SAYS (Phase 12): the 7-day free trial, $49.99/month,
-- the link to EdgeDesk, and under 150 words. The engine is refused without
-- them; an email the owner wrote or edited is shown what it lacks, as advice.
create or replace function growth_outbound.offer_problems(p_body text, p_cta text)
returns text[] language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v text[] := '{}';
  v_words int := coalesce(array_length(regexp_split_to_array(nullif(btrim(coalesce(p_body, '')), ''), '\s+'), 1), 0);
begin
  if coalesce(p_body, '') !~* '\$49\.99 ?(/ ?|per |a )(month|mo)\M' then
    v := array_append(v, 'offer: say the price, $49.99/month'::text);
  end if;
  if coalesce(p_body, '') !~* '\m(7|seven)[- ]day free trial\M|\mfree for (7|seven) days\M|\mfree (7|seven)[- ]day trial\M' then
    v := array_append(v, 'offer: say the 7-day free trial'::text);
  end if;
  if coalesce(p_body, '') !~* 'https://(www\.)?edgedesksports\.com(/|\M)' then
    v := array_append(v, ('offer: include the link to EdgeDesk (' || coalesce(p_cta, 'https://edgedesksports.com/') || ')')::text);
  end if;
  if v_words > 150 then
    v := array_append(v, ('length: ' || v_words || ' words; keep it under 150')::text);
  end if;
  return v;
end $$;

-- WHAT A PARTNERSHIP NOTE MAY OFFER (Phase 13): only what the public partners
-- page offers (https://edgedesksports.com/partners/): cite and link the free
-- research, a conversation about evaluating the terminal, and any content,
-- data or referral arrangement agreed individually and in writing first.
-- No commission, revenue share, payment, sponsorship or affiliate terms:
-- none is approved, and EdgeDesk pays nothing without a written agreement.
-- A link to EdgeDesk, under 150 words. The engine is held to it; an owner's
-- own note is shown it as advice.
create or replace function growth_outbound.partner_offer_problems(p_body text)
returns text[] language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  t text := lower(coalesce(p_body, ''));
  v text[] := '{}';
  v_words int := coalesce(array_length(regexp_split_to_array(nullif(btrim(coalesce(p_body, '')), ''), '\s+'), 1), 0);
begin
  if t ~ ('\m(commissions?|revenue[- ]share|rev[- ]share|profit[- ]share|affiliate (fees?|payouts?|commissions?|rates?|program terms)'
          || '|per (sign[- ]?up|signup|sale|referral|conversion|subscriber)|cpa|bount(y|ies)|payouts?|sponsor(ship|ed|s)?'
          || '|paid (partnership|placement|post|promotion|spot)|we(''ll| will) pay|pay(ing)? you|compensat(e|ion)|stipend|retainer'
          || '|percent of)\M|\m[0-9]{1,3} ?%') then
    v := array_append(v, 'partnership: offers money or terms nobody has approved (commission, revenue share, sponsorship, payment); the partners page promises only what is agreed in writing'::text);
  end if;
  if coalesce(p_body, '') !~* 'https://(www\.)?edgedesksports\.com(/|\M)' then
    v := array_append(v, 'partnership: include the link to EdgeDesk (the partners page or the free research)'::text);
  end if;
  if v_words > 150 then
    v := array_append(v, ('length: ' || v_words || ' words; keep it under 150')::text);
  end if;
  return v;
end $$;

-- A cited claim must be IN the email, in its words: the claims list is what
-- the message actually says about the person, each statement backed.
create or replace function growth_outbound.claims_missing(d growth_outbound.drafts)
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(c->>'text' order by n), '{}')
    from jsonb_array_elements(case when jsonb_typeof(d.claims) = 'array' then d.claims else '[]'::jsonb end) with ordinality x(c, n)
   where growth_outbound.norm_text(c->>'text') is null
      or position(growth_outbound.norm_text(c->>'text') in
                  coalesce(growth_outbound.norm_text(coalesce(d.subject, '') || ' ' || coalesce(d.body_text, '')), '')) = 0;
$$;

-- ── what an ENGINE-written email must get right (Phase 8) ───────────────────
-- The drafting engine proposes; growth_outbound_draft_propose decides, with
-- these. An owner writing or editing a draft is not held to them: those are
-- the owner's own words.

-- What an email may cite about a person: what they make, write, run or do.
-- Never their address, never a name (the greeting's business), never an
-- audience figure, never a fit signal (the research engine's own reading).
create or replace function growth_outbound.engine_citeable(p_field text)
returns boolean language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_field in ('organization', 'job_title', 'project', 'article', 'podcast', 'newsletter', 'model', 'topic',
                              'sports_focus'), false);
$$;

-- The name an email's greeting uses: 'there', the name, or NULL when the
-- first line is not "Hi …," (or "Hello …,", "Hey …,") on a line of its own.
create or replace function growth_outbound.greeting_of(p_body text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when x.m is null then null when lower(x.m[2]) = 'there' then 'there' else x.m[2] end
    from (select regexp_match(coalesce(p_body, ''), '^(Hi|Hello|Hey) ([^,\n]{1,60}),[ \t]*\n') as m) x;
$$;

-- NEVER A GUESSED NAME. "Hi there," always passes; "Hi <name>," only when
-- the name IS the first name the evidence establishes (identity at the gate
-- and a plain first-and-last name), letter for letter. NULL: nothing wrong.
create or replace function growth_outbound.greeting_problem(p_body text, p_first text)
returns text language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare g text := growth_outbound.greeting_of(p_body);
begin
  if g is null then return 'the email opens with "Hi there," or "Hi <their first name>," on a line of its own'; end if;
  if g = 'there' then return null; end if;
  if p_first is null then
    return format('the greeting names "%s", but no first name is established for this person: it is "Hi there,"', left(g, 60));
  end if;
  if g is distinct from p_first then
    return format('the greeting names "%s", but their established first name is "%s"', left(g, 60), p_first);
  end if;
  return null;
end $$;

-- The words of a text as the detail check reads them: split at spaces,
-- slashes and dashes; outer punctuation and a possessive 's dropped;
-- lower-cased. ("EdgeDesk's $49.99/month" is edgedesk, 49.99, month.)
create or replace function growth_outbound.detail_words(p text)
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(distinct x.w), '{}') from (
    select lower(regexp_replace(regexp_replace(t, '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g'), '''s$', '')) as w
      from regexp_split_to_table(replace(coalesce(p, ''), '’', ''''), '[[:space:]/–—-]+') t) x
   where x.w <> '';
$$;

-- NOTHING SPECIFIC FROM NOWHERE. In an engine email a figure, a word in
-- capitals, or a capitalised word inside a sentence (a name, a title, a
-- brand, a place) must come from a cited claim, the first name, or
-- EdgeDesk's own words (p_allowed and the short list here). Returns the
-- words that came from nowhere: what a model made up looks exactly like this.
create or replace function growth_outbound.uncited_details(p_text text, p_allowed text)
returns text[] language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_ok text[] := growth_outbound.detail_words(p_allowed)
    || array['i', 'i''m', 'i''ve', 'i''d', 'i''ll', 'hi', 'hello', 'hey', 'ok', 'edgedesk', 'edgedesksports.com',
             'www.edgedesksports.com', 'nfl', 'cfb', '7', '49.99'];
  v_bad text[] := '{}';
  v_line text;
  t text;
  w text;
  v_start boolean;
begin
  for v_line in select x from regexp_split_to_table(replace(coalesce(p_text, ''), '’', ''''), '\n') x loop
    v_start := true;
    for t in select x from regexp_split_to_table(v_line, '[[:space:]/–—-]+') x loop
      continue when t = '';
      w := regexp_replace(regexp_replace(t, '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g'), '''s$', '');
      if w <> '' and (w ~ '[0-9]' or w ~ '^[[:upper:]]{2}' or w ~ '[[:lower:]][[:upper:]]' or (not v_start and w ~ '^[[:upper:]]'))
         and not (lower(w) = any (v_ok)) then
        v_bad := array_append(v_bad, left(w, 60));
      end if;
      -- the next word starts a sentence after . ! ? or :
      v_start := t ~ '[.!?:][]"'')]*$';
    end loop;
  end loop;
  return array(select distinct x from unnest(v_bad) x order by 1);
end $$;

-- A SENTENCE ABOUT THEM CARRIES A CLAIM. "your <something>" says something
-- about the person, and the only things an engine email may say about them
-- are cited. Generic possessives ("your work", "your research", "your
-- bets" …) need no citation. Returns the sentences that cite nothing.
-- (A heuristic, and the owner reads every draft: it stops the common ways a
-- model invents a personal detail, not every way.)
create or replace function growth_outbound.uncited_sentences(p_text text, p_claims text[])
returns text[] language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_s text;
  v_bad text[] := '{}';
begin
  for v_s in select btrim(x) from regexp_split_to_table(
               regexp_replace(replace(coalesce(p_text, ''), '’', ''''), '([.!?])[[:space:]]+', E'\\1\n', 'g'), '\n') x loop
    continue when v_s = '';
    if exists (select 1 from regexp_matches(lower(v_s), '\myours?\M([[:space:]]+own\M)?[[:space:]]*([[:alpha:]]*)', 'g') m
                where m[2] not in ('work', 'research', 'process', 'bets', 'betting', 'results', 'analysis', 'time', 'inbox',
                                   'notes', 'readers', 'audience', 'subscribers'))
       and not exists (select 1 from unnest(coalesce(p_claims, '{}')) c where growth_outbound.quote_in(c, v_s)) then
      v_bad := array_append(v_bad, left(v_s, 160));
    end if;
  end loop;
  return v_bad;
end $$;

-- When a real step went out to a prospect and stayed out: NULL if it never
-- did, or it bounced, drew a complaint or failed.
create or replace function growth_outbound.step_sent_at(p_prospect uuid, p_seq int)
returns timestamptz language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select max(x.sent_at) from growth_outbound.sends x
   where x.prospect_id = p_prospect and x.sequence_number = p_seq and not x.is_test
     and x.sent_at is not null and x.delivery_status not in ('bounced', 'complained', 'failed');
$$;

-- The footer every message carries: who sent it, the postal address, and how
-- to stop. The personal opt-out link is made at send time (Phase 5/6).
-- (Phase 13) It also says plainly what the email is: a commercial message
-- (CAN-SPAM wants an advertisement identified as one when the reader never
-- asked for it), and that EdgeDesk is research for adults 21+, not betting
-- advice.
create or replace function growth_outbound.footer_text(p_link text)
returns text language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select '--' || E'\n' || s.sender_name || ', ' || s.business_name || E'\n'
      || coalesce(nullif(btrim(s.postal_address), ''), '[no postal address is set: sending is blocked until there is one]') || E'\n'
      || 'This is a commercial email from ' || s.business_name || '. For adults 21+; research, not betting advice.' || E'\n'
      || 'Not for you? Reply "stop", or opt out in one click: ' || coalesce(p_link, '')
    from growth_outbound.settings s where s.id = 1;
$$;

-- THE CAMPAIGN CODE a message's EdgeDesk links carry (Phase 10): the
-- prospect's own for a live message; 'ob_test' for one that goes to the
-- owner's inbox, so the owner's own clicks are never counted as anybody's
-- result. The code is a random token: it says nothing about the person.
create or replace function growth_outbound.link_campaign(p_token text, p_test boolean)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_test, true) then 'ob_test'
              when p_token ~ '^[0-9a-f]{32}$' then 'ob_' || p_token end;
$$;

-- EdgeDesk links in an email's words, tagged with the campaign code
-- (utm_source=outbound, utm_medium=email, utm_campaign=<code>), which the
-- site records for each visit and each new account (supabase/growth.sql).
-- Only links written in full to the main site (https://edgedesksports.com or
-- www.) are tagged; trailing punctuation stays outside the link; a fragment
-- stays last; a link that already carries a utm_ parameter is left exactly
-- as written. Nothing else in the text changes.
create or replace function growth_outbound.tag_links(p_text text, p_campaign text)
returns text language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_rest text := p_text;
  v_out text := '';
  m text[];
  v_url text;
  v_at int;
  v_base text;
  v_frag text;
  v_tags text;
begin
  if p_text is null or p_campaign is null or p_campaign !~ '^ob_[a-z0-9]{1,40}$' then return p_text; end if;
  v_tags := 'utm_source=outbound&utm_medium=email&utm_campaign=' || p_campaign;
  loop
    m := regexp_match(v_rest,
      '(https?://(www\.)?edgedesksports\.com(?![a-z0-9:@_-]|\.[a-z0-9])(/[^][\s<>"''`(){}|\\^]*[^][\s<>"''`(){}|\\^.,;:!?*])?/?)', 'i');
    exit when m is null;
    v_url := m[1];
    v_at := strpos(v_rest, v_url);
    v_base := split_part(v_url, '#', 1);
    v_frag := substr(v_url, length(v_base) + 1);
    if v_base !~* '[?&]utm_[a-z]*=' then
      v_base := case when v_base ~ '\?' then v_base || case when v_base ~ '[?&]$' then '' else '&' end
                     when v_base ~* '^https?://(www\.)?edgedesksports\.com$' then v_base || '/?'
                     else v_base || '?' end || v_tags;
    end if;
    v_out := v_out || substr(v_rest, 1, v_at - 1) || v_base || v_frag;
    v_rest := substr(v_rest, v_at + length(v_url));
  end loop;
  return v_out || v_rest;
end $$;

-- EXACTLY what would go out for a draft, as the owner reviews it: sender,
-- recipient (the test inbox in test mode or for a test prospect), subject,
-- the words (their EdgeDesk links tagged, unless tagging is off), the footer.
create or replace function growth_outbound.compose(p_draft uuid)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'test', s.test_mode or d.is_test,
    'from', s.sender_name || ' <' || s.sender_email || '>',
    'reply_to', coalesce(s.reply_to_email, s.sender_email),
    'to', case when s.test_mode or d.is_test then s.test_inbox else growth_outbound.norm_email(p.email) end,
    'intended_recipient', growth_outbound.norm_email(p.email),
    'subject', d.subject,
    'links_tagged', s.attribution_links,
    'body', b.body,
    'footer', growth_outbound.footer_text('[your personal opt-out link is added when this is sent]'),
    'text', b.body || E'\n\n' || growth_outbound.footer_text('[your personal opt-out link is added when this is sent]'))
  from growth_outbound.drafts d
  join growth_outbound.prospects p on p.id = d.prospect_id
  cross join growth_outbound.settings s
  cross join lateral (select case when s.attribution_links
                                  then growth_outbound.tag_links(d.body_text, growth_outbound.link_campaign(p.attribution_token, s.test_mode or d.is_test))
                                  else d.body_text end as body) b
  where d.id = p_draft and s.id = 1;
$$;

-- One card in the review queue: the draft, who it is for and how sure we
-- are, every claim with the evidence it rests on, the content rules, and
-- the message exactly as it would be sent.
create or replace function growth_outbound.review_card(d growth_outbound.drafts)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'draft', to_jsonb(d),
    'prospect', growth_outbound.prospect_card(p)
                || jsonb_build_object('thresholds', p.assessment->'thresholds', 'fields', p.assessment->'fields'),
    'lint', to_jsonb(growth_outbound.draft_lint(d.subject, d.body_text)),
    'claims_missing', to_jsonb(growth_outbound.claims_missing(d)),
    'greeting_problem', case when d.generator_version like 'engine:%' and not d.edited_by_owner and not d.is_test
                             then growth_outbound.greeting_problem(d.body_text, p.first_name) end,
    'existing_account', not d.is_test and growth_outbound.has_account(p.email),
    -- (Phase 12) what an email should say that this one does not (blocking for
    -- the engine; advice for the owner's own words), its length, and where the
    -- owner can read up on the person
    -- (Phase 13) a partnership note is held to the partnership rules instead
    'advice', to_jsonb(case when d.campaign_type <> 'customer' and not d.is_test
                            then growth_outbound.partner_offer_problems(d.body_text)
                            else growth_outbound.offer_problems(d.body_text, (select x.cta_url from growth_outbound.settings x where x.id = 1)) end),
    'words', coalesce(array_length(regexp_split_to_array(nullif(btrim(d.body_text), ''), '\s+'), 1), 0),
    'links', (select coalesce(jsonb_agg(u order by n), '[]'::jsonb) from unnest(array[p.website_url, p.newsletter_url, p.x_url, p.youtube_url,
                                                                                    p.other_profile_url, p.email_source_url]) with ordinality t(u, n)
               where u is not null),
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object(
               'text', x.c->>'text',
               'evidence_id', x.c->'evidence_id',
               'confidence', case when coalesce(x.c->>'evidence_id', '') ~ '^[0-9]{1,18}$'
                                  then growth_outbound.evidence_confidence((x.c->>'evidence_id')::bigint, d.prospect_id) else 0 end,
               'evidence', (select jsonb_build_object('id', e.id, 'field_name', e.field_name, 'claim', e.claim, 'source_url', e.source_url,
                                     'source_kind', e.source_kind, 'source_excerpt', e.source_excerpt,
                                     'source_published_at', e.source_published_at, 'observed_at', e.observed_at,
                                     'current', e.superseded_at is null, 'own', e.prospect_id = d.prospect_id)
                              from growth_outbound.evidence e
                             where coalesce(x.c->>'evidence_id', '') ~ '^[0-9]{1,18}$' and e.id = (x.c->>'evidence_id')::bigint))
             order by x.n)
        from jsonb_array_elements(case when jsonb_typeof(d.claims) = 'array' then d.claims else '[]'::jsonb end) with ordinality x(c, n)),
      '[]'::jsonb),
    'preview', growth_outbound.compose(d.id))
  from growth_outbound.prospects p where p.id = d.prospect_id;
$$;

-- APPROVE ONE DRAFT — the single implementation behind both approve doors.
-- Private; called only by a door that has just run require_owner().
create or replace function growth_outbound.approve_one(p_owner uuid, p_draft_id uuid, p_content_hash text)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  d growth_outbound.drafts;
  p growth_outbound.prospects;
  s growth_outbound.settings;
  v_gates text[] := '{}';
  x text;
begin
  if p_owner is null or p_owner is distinct from auth.uid() or not growth_outbound.owner_active(p_owner) then
    raise exception 'outbound owner only' using errcode = 'insufficient_privilege';
  end if;
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
    if coalesce(p.qualification_score, -1) < s.min_qualification_score then
      v_gates := array_append(v_gates, ('qualification score ' || coalesce(p.qualification_score::text, 'unscored') || ' below '
                                        || s.min_qualification_score)::text);
    end if;
    if coalesce(p.identity_confidence, 0) < s.min_identity_confidence then v_gates := array_append(v_gates, 'identity confidence below minimum'::text); end if;
    if coalesce(p.research_confidence, 0) < s.min_research_confidence then v_gates := array_append(v_gates, 'research confidence below minimum'::text); end if;
    if coalesce(p.email_confidence, 0) < s.min_email_confidence then v_gates := array_append(v_gates, 'email confidence below minimum'::text); end if;
    if p.email_status <> 'verified' then v_gates := array_append(v_gates, ('email is ' || p.email_status)::text); end if;
    if growth_outbound.has_account(p.email) then v_gates := array_append(v_gates, 'this address already has an EdgeDesk account'::text); end if;
    foreach x in array growth_outbound.claims_missing(d) loop
      v_gates := array_append(v_gates, ('a cited claim is not in the email: "' || left(coalesce(x, ''), 80) || '"')::text);
    end loop;
    -- the engine greets by a first name only while it is established; your
    -- own words (an edit) are yours
    if d.generator_version like 'engine:%' and not d.edited_by_owner then
      x := growth_outbound.greeting_problem(d.body_text, p.first_name);
      if x is not null then v_gates := array_append(v_gates, ('greeting: ' || x)::text); end if;
    end if;
  end if;
  -- the content rules hold for every draft, test or not
  foreach x in array growth_outbound.draft_lint(d.subject, d.body_text) loop
    v_gates := array_append(v_gates, ('content: ' || x)::text);
  end loop;
  if array_length(v_gates, 1) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'below_gate', 'gates', to_jsonb(v_gates));
  end if;
  perform set_config('growth_outbound.door', 'approve', true);
  update growth_outbound.drafts
     set status = 'approved', approved_at = now(), approved_by = p_owner,
         approved_hash = content_hash, approved_recipient = growth_outbound.norm_email(p.email)
   where id = d.id;
  perform set_config('growth_outbound.door', '', true);
  perform growth_outbound.log('draft_approved', d.prospect_id, 'draft', d.id::text,
    jsonb_build_object('sequence', d.sequence_number, 'content_hash', d.content_hash, 'test', d.is_test));
  return jsonb_build_object('ok', true, 'draft_id', d.id, 'approved_hash', d.content_hash);
end $$;

-- APPROVE SEVERAL — the owner names the drafts AND says how many. The count
-- must match exactly, and it is all or nothing: if any one of them cannot be
-- approved, none is, and the reasons come back. It sends nothing.
create or replace function public.growth_outbound_drafts_approve_batch(p_items jsonb, p_confirm_count int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_n int;
  it jsonb;
  r jsonb;
  v_ok jsonb := '[]'::jsonb;
  v_bad jsonb := '[]'::jsonb;
begin
  v_owner := growth_outbound.require_owner();
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('ok', false, 'reason', 'not_a_list'); end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 25 then
    return jsonb_build_object('ok', false, 'reason', 'batch_size', 'detail', 'approve 1 to 25 drafts at a time');
  end if;
  if p_confirm_count is distinct from v_n then
    return jsonb_build_object('ok', false, 'reason', 'count_mismatch',
      'detail', format('you confirmed %s but %s draft(s) were selected; nothing was approved', coalesce(p_confirm_count::text, 'no number'), v_n));
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x) <> 'object'
              or coalesce(x->>'draft_id', '') !~ '^[0-9a-fA-F-]{36}$')
     or (select count(distinct lower(x->>'draft_id')) from jsonb_array_elements(p_items) x) <> v_n then
    return jsonb_build_object('ok', false, 'reason', 'invalid_items', 'detail', 'each item is {draft_id, content_hash}, each draft once');
  end if;
  -- every draft of the batch locked up front, in one order (Phase 11): two
  -- batches over the same drafts queue behind each other instead of each
  -- holding one draft and waiting for the other's
  perform 1 from growth_outbound.drafts d
   where d.id in (select (x->>'draft_id')::uuid from jsonb_array_elements(p_items) x)
   order by d.id for update;
  begin
    for it in select x from jsonb_array_elements(p_items) x loop
      r := growth_outbound.approve_one(v_owner, (it->>'draft_id')::uuid, it->>'content_hash');
      if coalesce((r->>'ok')::boolean, false) then
        v_ok := v_ok || jsonb_build_array(it->'draft_id');
      else
        v_bad := v_bad || jsonb_build_array(r || jsonb_build_object('draft_id', it->'draft_id'));
      end if;
    end loop;
    if jsonb_array_length(v_bad) > 0 then
      raise exception 'not every draft in the batch can be approved' using errcode = 'OB001';
    end if;
  exception when sqlstate 'OB001' then
    return jsonb_build_object('ok', false, 'reason', 'not_all_approvable', 'refused', v_bad,
      'detail', format('%s of %s cannot be approved, so none was', jsonb_array_length(v_bad), v_n));
  end;
  perform growth_outbound.log('drafts_batch_approved', null, 'draft', null,
    jsonb_build_object('count', v_n, 'drafts', v_ok));
  return jsonb_build_object('ok', true, 'approved', v_n, 'drafts', v_ok);
end $$;

-- WITHDRAW an approval before it is sent: back to review, approval cleared.
create or replace function public.growth_outbound_draft_unapprove(p_draft_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  d growth_outbound.drafts;
begin
  v_owner := growth_outbound.require_owner();
  select * into d from growth_outbound.drafts where id = p_draft_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if d.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'not_approved', 'status', d.status); end if;
  update growth_outbound.drafts set status = 'pending_review' where id = d.id;
  perform growth_outbound.evaluate(d.prospect_id);
  perform growth_outbound.log('draft_unapproved', d.prospect_id, 'draft', d.id::text,
    jsonb_build_object('reason', left(nullif(btrim(coalesce(p_reason, '')), ''), 300), 'content_hash', d.content_hash));
  return jsonb_build_object('ok', true, 'status', 'pending_review');
end $$;

-- WRITE A DRAFT yourself. Every personal statement is a claim that cites
-- current evidence of this prospect and appears in the email in its words;
-- a real prospect's draft makes at least one. The content rules apply now,
-- not only at approval. It goes into the queue for review like any other.
create or replace function public.growth_outbound_draft_create(p_prospect uuid, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_p growth_outbound.prospects;
  v_seq int;
  v_subject text := btrim(coalesce(p->>'subject', ''));
  v_body text := btrim(coalesce(p->>'body_text', ''));
  v_claims jsonb := '[]'::jsonb;
  c jsonb;
  v_text text;
  v_lint text[];
  v_existing uuid;
  d growth_outbound.drafts;
begin
  v_owner := growth_outbound.require_owner();
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'not_an_object'); end if;
  if exists (select 1 from jsonb_object_keys(p) k where k not in ('subject', 'body_text', 'claims', 'sequence_number')) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_field');
  end if;
  select * into v_p from growth_outbound.prospects where id = p_prospect for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_p.status in ('suppressed', 'rejected') or growth_outbound.is_suppressed(v_p.email) then
    return jsonb_build_object('ok', false, 'reason', 'prospect_' || case when v_p.status = 'rejected' then 'rejected' else 'suppressed' end);
  end if;
  v_seq := case when coalesce(p->>'sequence_number', '1') ~ '^[1-3]$' then (coalesce(p->>'sequence_number', '1'))::int end;
  if v_seq is null then return jsonb_build_object('ok', false, 'reason', 'invalid_sequence'); end if;
  if length(v_subject) not between 1 and 150 or length(v_body) not between 1 and 5000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_content', 'detail', 'a subject of 1–150 characters and a body of 1–5000 are required');
  end if;
  select id into v_existing from growth_outbound.drafts
   where prospect_id = v_p.id and sequence_number = v_seq and status in ('pending_review', 'approved');
  if v_existing is not null then
    return jsonb_build_object('ok', false, 'reason', 'draft_exists', 'draft_id', v_existing,
      'detail', 'this step already has a draft waiting; edit or reject that one');
  end if;
  if p ? 'claims' and (jsonb_typeof(p->'claims') <> 'array' or jsonb_array_length(p->'claims') > 10) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_claims', 'detail', 'at most 10 claims');
  end if;
  for c in select x from jsonb_array_elements(coalesce(p->'claims', '[]'::jsonb)) x loop
    v_text := nullif(btrim(coalesce(c->>'text', '')), '');
    if jsonb_typeof(c) <> 'object' or v_text is null or length(v_text) > 300 or coalesce(c->>'evidence_id', '') !~ '^[0-9]{1,18}$' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_claims', 'detail', 'each claim is {text, evidence_id}');
    end if;
    if not exists (select 1 from growth_outbound.evidence e where e.id = (c->>'evidence_id')::bigint and e.prospect_id = v_p.id
                     and e.superseded_at is null and e.claim_norm is not null and e.field_name <> 'email') then
      return jsonb_build_object('ok', false, 'reason', 'claim_without_evidence',
        'detail', format('"%s" cites evidence that is not current evidence about this prospect', left(v_text, 80)));
    end if;
    if position(coalesce(growth_outbound.norm_text(v_text), '') in coalesce(growth_outbound.norm_text(v_subject || ' ' || v_body), '')) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'claim_not_in_email',
        'detail', format('"%s" is cited but the email does not say it', left(v_text, 80)));
    end if;
    v_claims := v_claims || jsonb_build_array(jsonb_build_object('text', v_text, 'evidence_id', (c->>'evidence_id')::bigint));
  end loop;
  if not v_p.is_test and jsonb_array_length(v_claims) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_claims',
      'detail', 'an individual email says at least one thing about them, backed by evidence');
  end if;
  v_lint := growth_outbound.draft_lint(v_subject, v_body);
  if cardinality(v_lint) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'content', 'problems', to_jsonb(v_lint));
  end if;
  insert into growth_outbound.drafts (prospect_id, sequence_number, campaign_type, is_test, subject, body_text, claims, generator_version, edited_by_owner)
  values (v_p.id, v_seq, v_p.campaign_type, v_p.is_test, v_subject, v_body, v_claims, 'owner', true)
  returning * into d;
  perform growth_outbound.evaluate(v_p.id);
  perform growth_outbound.log('draft_created', v_p.id, 'draft', d.id::text,
    jsonb_build_object('sequence', v_seq, 'claims', jsonb_array_length(v_claims), 'by', 'owner'));
  return jsonb_build_object('ok', true, 'draft_id', d.id, 'content_hash', d.content_hash,
    'status', (select status from growth_outbound.prospects where id = v_p.id));
end $$;

-- THE REVIEW QUEUE: drafts waiting for the owner (or approved and not yet
-- sent), each prospect re-evaluated first so the gates shown are current.
create or replace function public.growth_outbound_review_queue(p_status text default 'pending_review', p_limit int default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_status text := coalesce(p_status, 'pending_review');
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_pid uuid;
begin
  perform growth_outbound.require_owner();
  if v_status not in ('pending_review', 'approved') then return jsonb_build_object('ok', false, 'reason', 'not_a_queue'); end if;
  for v_pid in
    select distinct x.prospect_id from (
      select d.prospect_id from growth_outbound.drafts d join growth_outbound.prospects p on p.id = d.prospect_id
       where d.status = v_status
       order by p.is_test desc, p.qualification_score desc nulls last, p.fit_score desc nulls last, d.generated_at limit v_limit) x
  loop
    perform growth_outbound.evaluate(v_pid);
  end loop;
  return jsonb_build_object('ok', true, 'status', v_status,
    'total', (select count(*) from growth_outbound.drafts where status = v_status),
    'rows', coalesce((
      select jsonb_agg(growth_outbound.review_card(x.d) order by x.ord)
        from (select d, row_number() over (order by p.is_test desc, p.qualification_score desc nulls last, p.fit_score desc nulls last,
                                                    d.generated_at) as ord
                from growth_outbound.drafts d join growth_outbound.prospects p on p.id = d.prospect_id
               where d.status = v_status
               order by 2 limit v_limit) x), '[]'::jsonb));
end $$;

-- A TEST PROSPECT AT THE OWNER'S OWN TEST INBOX, with a draft to review, so
-- the whole path can be tried without touching a real person. Idempotent.
create or replace function public.growth_outbound_test_fixture()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  v_res jsonb;
  v_pid uuid;
  v_eid bigint;
  v_did uuid;
  v_created boolean := false;
begin
  perform growth_outbound.require_owner();
  select * into s from growth_outbound.settings where id = 1;
  if s.test_inbox is null then
    return jsonb_build_object('ok', false, 'reason', 'test_inbox_missing', 'detail', 'set a test inbox in the outbound settings first');
  end if;
  select id into v_pid from growth_outbound.prospects
   where is_test and growth_outbound.norm_email(email) = growth_outbound.norm_email(s.test_inbox)
   order by created_at limit 1;
  if v_pid is null then
    v_res := growth_outbound.ingest(null, jsonb_build_object('email', s.test_inbox, 'is_test', true, 'discovered_via', 'test_fixture',
      'evidence', jsonb_build_array(
        jsonb_build_object('field_name', 'full_name', 'claim', 'EdgeDesk Test Prospect', 'source_url', s.cta_url, 'source_kind', 'owner_verified'),
        jsonb_build_object('field_name', 'email', 'claim', s.test_inbox, 'source_url', s.cta_url, 'source_kind', 'owner_verified'),
        jsonb_build_object('field_name', 'project', 'claim', 'the EdgeDesk outbound pipeline check', 'source_url', s.cta_url,
                           'source_kind', 'owner_verified'))));
    if not coalesce((v_res->>'ok')::boolean, false) then return v_res; end if;
    v_pid := (v_res->>'prospect_id')::uuid;
  end if;
  select id into v_did from growth_outbound.drafts
   where prospect_id = v_pid and sequence_number = 1 and status in ('pending_review', 'approved');
  if v_did is null then
    select id into v_eid from growth_outbound.evidence
     where prospect_id = v_pid and field_name = 'project' and superseded_at is null order by id desc limit 1;
    insert into growth_outbound.drafts (prospect_id, sequence_number, is_test, subject, body_text, claims, generator_version)
    values (v_pid, 1, true, '[TEST] EdgeDesk outbound check',
      'Hi,' || E'\n\n'
      || 'This message is the EdgeDesk outbound pipeline check. It goes only to your own test inbox, and shows exactly how an approved '
      || 'message is put together: these words, then the footer every message carries.' || E'\n\n'
      || 'EdgeDesk is a research platform for football bettors and analysts, not a picks service: fair lines, market gaps and the '
      || 'reasons behind them. A 7-day free trial, then $49.99/month.' || E'\n\n'
      || s.sender_name,
      case when v_eid is null then '[]'::jsonb
           else jsonb_build_array(jsonb_build_object('text', 'the EdgeDesk outbound pipeline check', 'evidence_id', v_eid)) end,
      'test_fixture')
    returning id into v_did;
    v_created := true;
    perform growth_outbound.evaluate(v_pid);
    perform growth_outbound.log('test_fixture_created', v_pid, 'draft', v_did::text, jsonb_build_object('to', s.test_inbox));
  end if;
  return jsonb_build_object('ok', true, 'prospect_id', v_pid, 'draft_id', v_did, 'created', v_created);
end $$;

-- ── sending: claim, compose, record ──────────────────────────────────────────
--
-- THE SEND PATH (Phase 5). The owner presses Send; the growth_outbound_send
-- Edge Function, running AS THE OWNER (requireOutboundOwner), calls:
--   1  growth_outbound_send_claim(draft)   — writes the send row FIRST (the
--      table trigger re-checks every rule: approved, unchanged, current owner,
--      approved recipient or only the test inbox, unsuppressed, once per
--      draft, once per address per step, the daily cap, the compliance
--      configuration) and returns the message exactly as it must go out,
--      with a deterministic Idempotency-Key;
--   2  Resend, with that Idempotency-Key;
--   3  growth_outbound_send_result(send)   — records Resend's answer.
-- A crash between 1 and 3 leaves a claimed row; claiming the same draft again
-- returns the SAME key, so Resend's idempotency makes the retry harmless.
-- After 23 hours that guarantee lapses (Resend keeps keys 24 hours), so an
-- unresolved claim is then marked failed and never retried: an email is never
-- sent twice to find out whether it was sent once.

-- The personal opt-out link of one send (Phase 6 serves it).
create or replace function growth_outbound.optout_url(p_token text)
returns text language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select case when s.unsubscribe_url_base is null or p_token is null then null
              else rtrim(s.unsubscribe_url_base, '/') || '/growth_outbound_optout?t=' || p_token end
    from growth_outbound.settings s where s.id = 1;
$$;

-- The message for one claimed send, exactly as Resend receives it: the
-- recipient and sender recorded on the send row, the approved words (their
-- EdgeDesk links tagged if the send says so), the footer with the postal
-- address and this send's own opt-out link, and the RFC 8058 one-click
-- List-Unsubscribe headers.
create or replace function growth_outbound.compose_for_send(p_send uuid)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'from', x.sender,
    'to', x.recipient,
    'reply_to', coalesce(s.reply_to_email, s.sender_email),
    'subject', x.subject,
    'text', case when x.links_tagged then growth_outbound.tag_links(d.body_text, growth_outbound.link_campaign(p.attribution_token, x.is_test))
                 else d.body_text end || E'\n\n' || growth_outbound.footer_text(coalesce(growth_outbound.optout_url(x.optout_token),
              '[test send: your personal opt-out link appears here once the opt-out endpoint is configured]')),
    'headers', jsonb_strip_nulls(jsonb_build_object(
      'List-Unsubscribe', concat_ws(', ',
          case when growth_outbound.optout_url(x.optout_token) is not null then '<' || growth_outbound.optout_url(x.optout_token) || '>' end,
          '<mailto:' || coalesce(s.reply_to_email, s.sender_email) || '?subject=stop>'),
      'List-Unsubscribe-Post', case when growth_outbound.optout_url(x.optout_token) is not null then 'List-Unsubscribe=One-Click' end)))
  from growth_outbound.sends x
  join growth_outbound.drafts d on d.id = x.draft_id
  join growth_outbound.prospects p on p.id = x.prospect_id
  cross join growth_outbound.settings s
  where x.id = p_send and s.id = 1;
$$;

-- CLAIM a send for an approved draft. Called by the Edge Function as the
-- owner. Nothing leaves here but the message to send and its key.
create or replace function public.growth_outbound_send_claim(p_draft_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  d growth_outbound.drafts;
  x growth_outbound.sends;
  s growth_outbound.settings;
  v_test boolean;
begin
  v_owner := growth_outbound.require_owner();
  select * into d from growth_outbound.drafts where id = p_draft_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  -- this draft was claimed before: never a second send, at most a safe retry
  select * into x from growth_outbound.sends where draft_id = d.id for update;
  if found then
    if x.resend_message_id is not null or x.delivery_status <> 'claimed' then
      return jsonb_build_object('ok', true, 'already', true, 'send_id', x.id, 'state', x.delivery_status,
        'resend_message_id', x.resend_message_id);
    end if;
    if x.claimed_at < now() - interval '23 hours' then
      update growth_outbound.sends
         set delivery_status = 'failed', failed_at = now(),
             failure_reason = 'the first attempt''s outcome is unknown and too old to retry safely: never sent twice'
       where id = x.id;
      perform growth_outbound.log('send_abandoned', x.prospect_id, 'send', x.id::text, jsonb_build_object('claimed_at', x.claimed_at));
      return jsonb_build_object('ok', false, 'reason', 'stale_claim', 'send_id', x.id,
        'detail', 'an earlier attempt did not report back within 23 hours; it is marked failed and will not be retried');
    end if;
    update growth_outbound.sends set attempts = attempts + 1, last_attempt_at = now() where id = x.id;
    perform growth_outbound.log('send_retried', x.prospect_id, 'send', x.id::text, jsonb_build_object('attempt', x.attempts + 1));
    return jsonb_build_object('ok', true, 'retry', true, 'send_id', x.id, 'idempotency_key', x.idempotency_key,
      'test', x.is_test, 'message', growth_outbound.compose_for_send(x.id));
  end if;

  if d.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'not_approved', 'status', d.status); end if;
  -- a follow-up never reaches someone who has signed up since: their results
  -- are matched now, and a conversion ends the sequence (cancelling this draft)
  if d.sequence_number > 1 and not d.is_test then
    perform growth_outbound.sync_conversions(d.prospect_id);
    if (select status from growth_outbound.prospects where id = d.prospect_id) = 'converted' then
      return jsonb_build_object('ok', false, 'reason', 'prospect_converted',
        'detail', 'they made an EdgeDesk account after an earlier email, so the sequence is over and this follow-up is cancelled');
    end if;
  end if;
  -- the approval must still be earned, now: a prospect that no longer passes
  -- loses it (evaluate() puts the draft back in review)
  perform growth_outbound.evaluate(d.prospect_id);
  select * into d from growth_outbound.drafts where id = p_draft_id for update;
  if d.status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'approval_withdrawn',
      'detail', 'the prospect no longer passes every gate, so the draft is back in review');
  end if;
  if cardinality(growth_outbound.draft_lint(d.subject, d.body_text)) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'content', 'problems', to_jsonb(growth_outbound.draft_lint(d.subject, d.body_text)));
  end if;
  select * into s from growth_outbound.settings where id = 1;
  v_test := s.test_mode or d.is_test;
  begin
    perform set_config('growth_outbound.door', 'claim_send', true);
    insert into growth_outbound.sends (prospect_id, draft_id, sequence_number, is_test, idempotency_key, sender,
                                       intended_recipient, recipient, subject, content_hash, claimed_by)
    values (d.prospect_id, d.id, d.sequence_number, v_test, 'edgedesk-outbound-' || d.id, 'set by the send trigger',
            d.approved_recipient, case when v_test then growth_outbound.norm_email(s.test_inbox) else d.approved_recipient end,
            d.subject, d.content_hash, v_owner)
    returning * into x;
    update growth_outbound.drafts set status = 'sent' where id = d.id;
    perform set_config('growth_outbound.door', '', true);
  exception when insufficient_privilege or unique_violation or not_null_violation then
    -- the send trigger said no: the cap, a suppression, the configuration…
    return jsonb_build_object('ok', false, 'reason', 'refused', 'detail', sqlerrm);
  end;
  -- their status follows: no draft is waiting any more (after a test send
  -- that means qualified again, ready for their real first email — Phase 11)
  perform growth_outbound.evaluate(d.prospect_id);
  perform growth_outbound.log('send_claimed', d.prospect_id, 'send', x.id::text,
    jsonb_build_object('draft', d.id, 'test', x.is_test, 'to', x.recipient, 'sequence', x.sequence_number));
  return jsonb_build_object('ok', true, 'send_id', x.id, 'idempotency_key', x.idempotency_key, 'test', x.is_test,
    'message', growth_outbound.compose_for_send(x.id));
end $$;

-- RECORD what Resend answered for a claimed send. Called by the Edge Function
-- as the owner. A message id makes it 'sent' (and a real step-1 prospect
-- 'contacted'); a permanent refusal makes it 'failed'; anything else is
-- noted, and the claim stays open for a retry with the same key.
create or replace function public.growth_outbound_send_result(
  p_send_id uuid, p_resend_id text, p_error text default null, p_permanent boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  x growth_outbound.sends;
  v_err text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
begin
  perform growth_outbound.require_owner();
  select * into x from growth_outbound.sends where id = p_send_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_resend_id is not null then
    if p_resend_id !~ '^[A-Za-z0-9_-]{6,100}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_message_id'); end if;
    if x.resend_message_id is not null then
      if x.resend_message_id = p_resend_id then return jsonb_build_object('ok', true, 'already', true); end if;
      return jsonb_build_object('ok', false, 'reason', 'different_message_id');
    end if;
    update growth_outbound.sends
       set resend_message_id = p_resend_id, sent_at = now(), last_error = null,
           delivery_status = case when delivery_status in ('claimed', 'failed') then 'sent' else delivery_status end,
           failed_at = null, failure_reason = null
     where id = x.id;
    if not x.is_test and x.sequence_number = 1 then
      update growth_outbound.prospects set status = 'contacted', status_reason = null
       where id = x.prospect_id and status in ('discovered', 'needs_research', 'qualified', 'ready_for_review');
    end if;
    perform growth_outbound.log('sent', x.prospect_id, 'send', x.id::text,
      jsonb_build_object('test', x.is_test, 'to', x.recipient, 'resend_id', p_resend_id, 'sequence', x.sequence_number));
    return jsonb_build_object('ok', true, 'state', 'sent');
  end if;
  if x.resend_message_id is not null then return jsonb_build_object('ok', false, 'reason', 'already_sent'); end if;
  if coalesce(p_permanent, false) then
    update growth_outbound.sends
       set delivery_status = 'failed', failed_at = now(), failure_reason = coalesce(v_err, 'refused by the provider'), last_error = v_err
     where id = x.id;
    perform growth_outbound.log('send_failed', x.prospect_id, 'send', x.id::text, jsonb_build_object('error', v_err));
    return jsonb_build_object('ok', true, 'state', 'failed');
  end if;
  update growth_outbound.sends set last_error = coalesce(v_err, 'no answer'), last_attempt_at = now() where id = x.id;
  perform growth_outbound.log('send_attempt_failed', x.prospect_id, 'send', x.id::text, jsonb_build_object('error', v_err));
  return jsonb_build_object('ok', true, 'state', 'claimed', 'retry', true);
end $$;

-- What was sent: newest first, with who it went to and how it went.
create or replace function public.growth_outbound_sends(p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id, 'draft_id', x.draft_id, 'prospect_id', x.prospect_id, 'full_name', p.full_name, 'organization', p.organization,
      'is_test', x.is_test, 'sequence_number', x.sequence_number, 'recipient', x.recipient, 'intended_recipient', x.intended_recipient,
      'subject', x.subject, 'delivery_status', x.delivery_status, 'claimed_at', x.claimed_at, 'sent_at', x.sent_at,
      'delivered_at', x.delivered_at, 'bounced_at', x.bounced_at, 'failed_at', x.failed_at, 'failure_reason', x.failure_reason,
      'last_error', x.last_error, 'attempts', x.attempts, 'resend_message_id', x.resend_message_id,
      'complained_at', x.complained_at, 'opened_at', x.opened_at, 'clicked_at', x.clicked_at) order by x.claimed_at desc)
    from (select * from growth_outbound.sends order by claimed_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x
    join growth_outbound.prospects p on p.id = x.prospect_id), '[]'::jsonb);
end $$;

-- ── what happened next: the provider's events, opt-outs, replies ────────────

-- HMAC-SHA256 (RFC 2104) on core sha256(), so the signature check needs no
-- extension under a pinned search_path. Report row 25 checks it against
-- RFC 4231's published vectors on every run.
create or replace function growth_outbound.hmac_sha256(p_key bytea, p_msg bytea)
returns bytea language plpgsql immutable
set search_path = pg_catalog, pg_temp as $$
declare
  k bytea := p_key;
  ipad bytea;
  opad bytea;
  i int;
begin
  if length(k) > 64 then k := sha256(k); end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k;
  opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  end loop;
  return sha256(opad || sha256(ipad || p_msg));
end $$;

-- THE WEBHOOK SECRET, set once, in the Supabase SQL editor:
--   select growth_outbound.set_webhook_secret('whsec_...');
-- (Resend → Webhooks → your endpoint → Signing secret.) It is never echoed.
create or replace function growth_outbound.set_webhook_secret(p_secret text)
returns text language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare v text := btrim(coalesce(p_secret, ''));
begin
  if growth_outbound.api_origin() then
    raise exception 'secrets are set in the Supabase SQL editor only' using errcode = 'insufficient_privilege';
  end if;
  if v ~ '[<>]' then raise exception 'remove the < > around the secret'; end if;
  if v !~ '^whsec_[A-Za-z0-9+/]{16,}={0,2}$' then
    raise exception 'that is not a Resend webhook signing secret (it starts whsec_, followed by base64)';
  end if;
  begin
    perform decode(substr(v, 7), 'base64');
  exception when others then
    raise exception 'the part after whsec_ is not valid base64';
  end;
  insert into growth_outbound.secrets (name, value) values ('resend_webhook', v)
  on conflict (name) do update set value = excluded.value, set_at = now(), set_by = session_user;
  return 'ok — the Resend webhook signing secret is set';
end $$;

-- Is this delivery Resend's? Svix's scheme: HMAC-SHA256 over
-- "<id>.<timestamp>.<raw body>" with the secret, base64, under "v1,"; a
-- timestamp more than five minutes off is refused (a captured delivery
-- replayed later must not re-apply a bounce). NULL means it is Resend's.
create or replace function growth_outbound.svix_check(p_id text, p_ts text, p_sig text, p_body text)
returns text language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_secret text;
  v_expected text;
  g text;
begin
  select value into v_secret from growth_outbound.secrets where name = 'resend_webhook';
  if v_secret is null then return 'no_secret_configured'; end if;
  if nullif(btrim(coalesce(p_id, '')), '') is null or nullif(btrim(coalesce(p_ts, '')), '') is null
     or nullif(btrim(coalesce(p_sig, '')), '') is null or p_body is null then
    return 'missing_signature_headers';
  end if;
  if p_ts !~ '^[0-9]{1,12}$' then return 'unreadable_timestamp'; end if;
  if abs(floor(extract(epoch from now()))::bigint - p_ts::bigint) > 300 then return 'timestamp_outside_tolerance'; end if;
  v_expected := encode(growth_outbound.hmac_sha256(decode(substr(v_secret, 7), 'base64'),
                                                   convert_to(p_id || '.' || p_ts || '.' || p_body, 'UTF8')), 'base64');
  foreach g in array string_to_array(btrim(p_sig), ' ') loop
    if split_part(g, ',', 1) = 'v1' and split_part(g, ',', 2) = v_expected then return null; end if;
  end loop;
  return 'signature_mismatch';
end $$;

-- the order of a send's states: an event that arrives late never moves it back
create or replace function growth_outbound.delivery_rank(p text)
returns int language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case p when 'claimed' then 0 when 'sent' then 1 when 'delayed' then 2 when 'delivered' then 3
                when 'failed' then 4 when 'bounced' then 5 when 'complained' then 6 else -1 end;
$$;

create or replace function growth_outbound.mask_email(p text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when p is null or position('@' in p) < 2 then null
              else left(p, 1) || '•••@' || split_part(p, '@', 2) end;
$$;

create or replace function growth_outbound.log_as(p_kind text, p_action text, p_prospect uuid, p_entity text, p_entity_id text, p_detail jsonb)
returns void language sql
set search_path = pg_catalog, public, pg_temp as $$
  insert into growth_outbound.activity (actor_user_id, actor_kind, action, prospect_id, entity, entity_id, detail)
  values (null, p_kind, p_action, p_prospect, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- SUPPRESS: the one implementation, for the owner's door, a bounce, a
-- complaint, an opt-out and a reply alike. Recorded forever; every prospect
-- at the address (or domain) is marked suppressed, every unsent draft of
-- theirs cancelled. Already suppressed exactly so: nothing new is written.
create or replace function growth_outbound.apply_suppression(
  p_scope text, p_target text, p_kind text, p_reason text, p_source text, p_by uuid, p_prospect uuid default null)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_target text := growth_outbound.norm_email(p_target);
  v_scope text := coalesce(p_scope, 'address');
  v_id bigint;
  v_p uuid;
  v_np int := 0;
  v_nd int := 0;
begin
  if v_scope = 'domain' and v_target like '%@%' then v_target := growth_outbound.email_domain(v_target); end if;
  begin
    insert into growth_outbound.suppressions (scope, target, kind, reason, source, prospect_id, created_by)
    values (v_scope, v_target, coalesce(p_kind, 'manual'), left(nullif(btrim(coalesce(p_reason, '')), ''), 500),
            coalesce(p_source, 'owner'), p_prospect, p_by)
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
  return jsonb_build_object('ok', true, 'id', v_id, 'prospects_suppressed', v_np, 'drafts_cancelled', v_nd);
end $$;

-- WHAT A RECEIVED EMAIL IS, from its subject alone (the event carries no
-- body). An unsubscribe request first: honouring it is never wrong.
create or replace function growth_outbound.classify_reply(p_subject text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when coalesce(p_subject, '') ~* '\m(unsubscribe|opt[ -]?out|remove me|take me off|stop (emailing|contacting|sending)|do not (email|contact))\M'
      then 'opt_out'
    when coalesce(p_subject, '') ~* '(\mauto(matic)?[ -]?(reply|response|antwort)\M|\mautoreply\M|out of (the )?office|^\s*ooo\M|\mabwesenheit|réponse automatique|respuesta automática|\mon (vacation|holiday|leave)\M|away from (the office|my desk))'
      then 'auto_reply'
    else 'reply' end;
$$;

-- A RECEIVED EMAIL (Resend's email.received, its signature already checked
-- by the webhook door). Matched by the sender's address ALONE, to the last
-- email that went to that address in 180 days and before it arrived; never
-- by a name or a domain. A reply ends that person's sequence exactly as
-- "They replied" does; an unsubscribe request suppresses the address. Nothing
-- here sends, drafts or approves anything.
create or replace function growth_outbound.reply_received(p_event_id text, d jsonb)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  v_email_id text := nullif(left(btrim(coalesce(d->>'email_id', '')), 200), '');
  v_raw text := left(coalesce(d->>'from', ''), 320);
  v_from text;
  v_subject text := nullif(btrim(left(regexp_replace(coalesce(d->>'subject', ''), '[[:cntrl:]]+', ' ', 'g'), 200)), '');
  x growth_outbound.sends;
  p growth_outbound.prospects;
  v_kind text;
  v_applied boolean := false;
  v_n int := 0;
begin
  select * into s from growth_outbound.settings where id = 1;
  v_from := growth_outbound.norm_email(coalesce(substring(v_raw from '<([^<>[:space:]]+)>'), v_raw));
  if v_email_id is null or not growth_outbound.valid_email(v_from) then
    insert into growth_outbound.provider_events (event_id, event_type, outcome) values (p_event_id, 'email.received', 'reply_unreadable');
    return jsonb_build_object('ok', true, 'outcome', 'reply_unreadable');
  end if;
  -- the same email under another event id: once (two at the same instant
  -- queue here rather than both passing the check)
  perform pg_advisory_xact_lock(hashtext('growth_outbound.reply:' || v_email_id));
  if exists (select 1 from growth_outbound.replies where resend_email_id = v_email_id) then
    insert into growth_outbound.provider_events (event_id, event_type, outcome) values (p_event_id, 'email.received', 'reply_duplicate');
    return jsonb_build_object('ok', true, 'outcome', 'reply_duplicate');
  end if;
  select * into x from growth_outbound.sends
   where recipient = v_from and sent_at is not null and sent_at < now() and sent_at > now() - interval '180 days'
   order by sent_at desc limit 1;
  if x.id is null then
    v_kind := 'unmatched';
  elsif x.is_test then
    v_kind := 'test';
  else
    v_kind := growth_outbound.classify_reply(v_subject);
    select * into p from growth_outbound.prospects where id = x.prospect_id for update;
  end if;
  if v_kind = 'opt_out' and not growth_outbound.is_suppressed(v_from) then
    -- always honoured, whatever the setting: they asked. Every prospect at
    -- the address is suppressed and every unsent draft cancelled.
    perform growth_outbound.apply_suppression('address', v_from, 'unsubscribe',
      'asked to stop in a reply' || coalesce(': ' || left(v_subject, 120), ''), 'reply', null, p.id);
    v_applied := true;
  end if;
  if v_kind = 'reply' and s.reply_detection and p.status in ('contacted', 'replied') then
    if p.status = 'contacted' then
      update growth_outbound.prospects set status = 'replied', status_reason = left('replied by email' || coalesce(': ' || v_subject, ''), 500)
       where id = p.id;
      v_applied := true;
    end if;
    v_n := growth_outbound.cancel_live_drafts(p.id, 'they replied');
    v_applied := v_applied or v_n > 0;
  end if;
  -- the record "They replied" leaves, once a person: the results count it
  if p.id is not null and (v_kind = 'opt_out' or (v_kind = 'reply' and s.reply_detection))
     and not exists (select 1 from growth_outbound.activity a where a.prospect_id = p.id and a.action = 'prospect_replied') then
    perform growth_outbound.log_as('webhook', 'prospect_replied', p.id, 'reply', v_email_id,
      jsonb_build_object('detected', true, 'sequence', x.sequence_number, 'kind', v_kind, 'drafts_cancelled', v_n));
  end if;
  if v_kind <> 'unmatched' then
    perform growth_outbound.log_as('webhook', 'reply_received', x.prospect_id, 'reply', v_email_id,
      jsonb_build_object('kind', v_kind, 'sequence', x.sequence_number, 'applied', v_applied, 'test', x.is_test));
  end if;
  insert into growth_outbound.replies (resend_email_id, event_id, kind, prospect_id, send_id, sequence_number, from_masked, subject, applied, detail)
  values (v_email_id, p_event_id, v_kind, x.prospect_id, x.id, x.sequence_number, growth_outbound.mask_email(v_from),
          case when v_kind <> 'unmatched' then v_subject end, v_applied,
          case when v_kind in ('reply', 'opt_out') and not s.reply_detection then jsonb_build_object('detection', 'off') else '{}'::jsonb end);
  insert into growth_outbound.provider_events (event_id, event_type, send_id, outcome)
  values (p_event_id, 'email.received', x.id, 'reply_' || v_kind);
  return jsonb_build_object('ok', true, 'outcome', 'reply_' || v_kind, 'applied', v_applied);
end $$;

-- THE WEBHOOK DOOR — one of the two doors a caller with no account may knock
-- on. Its proof is Resend's signature, checked FIRST; without it nothing is
-- read, stored or changed. With it:
--   delivered / delayed       the send's state (never moved backwards)
--   bounced, permanent        bounced; the address suppressed and marked
--                             invalid; follow-ups cancelled (not for a test)
--   bounced, transient        noted only: a full mailbox is not a dead address
--   complained (spam)         complained; the address suppressed (not a test)
--   suppressed (by Resend)    failed, never sent; the address suppressed
--                             (not for a test)
--   opened / clicked          first time noted
--   received (2026-10)        an email Resend received for us: a reply ends
--                             that person's sequence (reply_received)
--   about any other email     acknowledged; nothing about it kept
create or replace function public.growth_outbound_webhook(p_id text, p_timestamp text, p_signature text, p_body text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_bad text;
  v jsonb;
  d jsonb;
  v_type text;
  v_msg text;
  x growth_outbound.sends;
  v_outcome text := 'noted';
  v_detail jsonb := '{}'::jsonb;
  v_perm boolean;
begin
  v_bad := growth_outbound.svix_check(p_id, p_timestamp, p_signature, p_body);
  if v_bad is not null then return jsonb_build_object('ok', false, 'verified', false, 'reason', v_bad); end if;
  if length(p_body) > 262144 then return jsonb_build_object('ok', false, 'verified', true, 'reason', 'too_large'); end if;
  begin
    v := p_body::jsonb;
  exception when others then
    return jsonb_build_object('ok', false, 'verified', true, 'reason', 'unparseable');
  end;
  if jsonb_typeof(v) <> 'object' then return jsonb_build_object('ok', false, 'verified', true, 'reason', 'unparseable'); end if;
  v_type := left(coalesce(v->>'type', ''), 100);
  d := case when jsonb_typeof(v->'data') = 'object' then v->'data' else '{}'::jsonb end;
  v_msg := nullif(left(coalesce(d->>'email_id', ''), 200), '');

  perform pg_advisory_xact_lock(hashtext('growth_outbound.provider_event:' || p_id));
  if exists (select 1 from growth_outbound.provider_events where provider = 'resend' and event_id = left(p_id, 200)) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if v_type = 'email.received' then
    return growth_outbound.reply_received(left(p_id, 200), d);
  end if;
  if v_msg is not null then
    select * into x from growth_outbound.sends where resend_message_id = v_msg for update;
  end if;
  if x.id is null then
    insert into growth_outbound.provider_events (event_id, event_type, outcome) values (left(p_id, 200), v_type, 'not_outbound');
    return jsonb_build_object('ok', true, 'outcome', 'not_outbound');
  end if;

  if v_type = 'email.delivered' then
    update growth_outbound.sends set delivered_at = coalesce(delivered_at, now()),
           delivery_status = case when growth_outbound.delivery_rank('delivered') > growth_outbound.delivery_rank(delivery_status) then 'delivered' else delivery_status end
     where id = x.id;
    v_outcome := 'delivered';
  elsif v_type = 'email.delivery_delayed' then
    update growth_outbound.sends
       set delivery_status = case when growth_outbound.delivery_rank('delayed') > growth_outbound.delivery_rank(delivery_status) then 'delayed' else delivery_status end
     where id = x.id;
    v_outcome := 'delayed';
  elsif v_type = 'email.bounced' then
    v_perm := coalesce(d#>>'{bounce,type}', d->>'bounce_type', 'permanent') !~* '(transient|soft)';
    v_detail := jsonb_build_object('bounce', jsonb_strip_nulls(jsonb_build_object(
      'type', left(d#>>'{bounce,type}', 40), 'subType', left(d#>>'{bounce,subType}', 60))));
    if v_perm then
      update growth_outbound.sends set bounced_at = coalesce(bounced_at, now()),
             delivery_status = case when growth_outbound.delivery_rank('bounced') > growth_outbound.delivery_rank(delivery_status) then 'bounced' else delivery_status end,
             failure_reason = coalesce(failure_reason, 'hard bounce' || coalesce(': ' || left(d#>>'{bounce,subType}', 60), ''))
       where id = x.id;
      if x.is_test then
        v_outcome := 'bounced_test';
      else
        update growth_outbound.prospects set email_invalid_at = coalesce(email_invalid_at, now())
         where growth_outbound.norm_email(email) = x.recipient;
        if not growth_outbound.is_suppressed(x.recipient) then
          perform growth_outbound.apply_suppression('address', x.recipient, 'bounce',
            'hard bounce' || coalesce(': ' || left(d#>>'{bounce,subType}', 60), ''), 'webhook', null, x.prospect_id);
        end if;
        v_outcome := 'bounced_suppressed';
      end if;
    else
      update growth_outbound.sends
         set delivery_status = case when growth_outbound.delivery_rank('delayed') > growth_outbound.delivery_rank(delivery_status) then 'delayed' else delivery_status end,
             last_error = 'soft bounce' || coalesce(': ' || left(d#>>'{bounce,subType}', 60), '')
       where id = x.id;
      v_outcome := 'soft_bounce';
    end if;
  elsif v_type = 'email.complained' then
    update growth_outbound.sends set complained_at = coalesce(complained_at, now()),
           delivery_status = case when growth_outbound.delivery_rank('complained') > growth_outbound.delivery_rank(delivery_status) then 'complained' else delivery_status end
     where id = x.id;
    if x.is_test then
      v_outcome := 'complained_test';
    else
      if not growth_outbound.is_suppressed(x.recipient) then
        perform growth_outbound.apply_suppression('address', x.recipient, 'complaint', 'marked as spam', 'webhook', null, x.prospect_id);
      end if;
      v_outcome := 'complained_suppressed';
    end if;
  elsif v_type = 'email.opened' then
    update growth_outbound.sends set opened_at = coalesce(opened_at, now()) where id = x.id;
    v_outcome := 'opened';
  elsif v_type = 'email.clicked' then
    update growth_outbound.sends set clicked_at = coalesce(clicked_at, now()) where id = x.id;
    v_outcome := 'clicked';
  elsif v_type = 'email.failed' then
    update growth_outbound.sends set failed_at = coalesce(failed_at, now()),
           delivery_status = case when growth_outbound.delivery_rank('failed') > growth_outbound.delivery_rank(delivery_status) then 'failed' else delivery_status end,
           failure_reason = coalesce(failure_reason, 'failed at the provider')
     where id = x.id;
    v_outcome := 'failed';
  elsif v_type = 'email.suppressed' then
    -- Resend did not send it: the address is on Resend's own suppression list
    -- (an earlier hard bounce or complaint, perhaps from another EdgeDesk
    -- email). Fail closed: that address is never tried again.
    v_detail := jsonb_build_object('suppressed', jsonb_strip_nulls(jsonb_build_object('type', left(d#>>'{suppressed,type}', 60))));
    update growth_outbound.sends set failed_at = coalesce(failed_at, now()),
           delivery_status = case when growth_outbound.delivery_rank('failed') > growth_outbound.delivery_rank(delivery_status) then 'failed' else delivery_status end,
           failure_reason = coalesce(failure_reason, 'not sent: the address is on Resend''s suppression list'
                                     || coalesce(' (' || left(d#>>'{suppressed,type}', 60) || ')', ''))
     where id = x.id;
    if x.is_test then
      v_outcome := 'suppressed_test';
    else
      if not growth_outbound.is_suppressed(x.recipient) then
        perform growth_outbound.apply_suppression('address', x.recipient, 'bounce', 'on Resend''s suppression list', 'webhook', null, x.prospect_id);
      end if;
      v_outcome := 'provider_suppressed';
    end if;
  elsif v_type = 'email.sent' then
    v_outcome := 'accepted';
  else
    v_outcome := 'ignored';
  end if;

  insert into growth_outbound.provider_events (event_id, event_type, message_id, send_id, outcome, detail)
  values (left(p_id, 200), v_type, v_msg, x.id, v_outcome, v_detail);
  if v_outcome not in ('opened', 'clicked', 'accepted', 'noted', 'ignored') then
    perform growth_outbound.log_as('webhook', 'provider_' || v_outcome, x.prospect_id, 'send', x.id::text,
      jsonb_build_object('event', v_type, 'test', x.is_test));
  end if;
  return jsonb_build_object('ok', true, 'outcome', v_outcome);
end $$;

-- THE OPT-OUT DOOR — the other door a caller with no account may knock on.
-- Its proof is a send's own 256-bit token (in the link of that one email);
-- its only power is to stop all email to the address that send was for.
-- p_confirm false (the page a link opens) changes nothing and shows only a
-- masked address; p_confirm true (the button, or a mail client's RFC 8058
-- one-click POST) suppresses. A test send's link changes nothing.
create or replace function public.growth_outbound_optout(p_token text, p_confirm boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  x growth_outbound.sends;
  v_already boolean;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into x from growth_outbound.sends where optout_token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if x.is_test then
    return jsonb_build_object('ok', true, 'test', true, 'masked', growth_outbound.mask_email(x.recipient), 'done', false);
  end if;
  v_already := growth_outbound.is_suppressed(x.intended_recipient);
  if not coalesce(p_confirm, false) or v_already then
    return jsonb_build_object('ok', true, 'masked', growth_outbound.mask_email(x.intended_recipient),
      'already', v_already, 'done', v_already);
  end if;
  perform growth_outbound.apply_suppression('address', x.intended_recipient, 'unsubscribe', 'opt-out link',
    'unsubscribe_link', null, x.prospect_id);
  perform growth_outbound.log_as('system', 'opted_out', x.prospect_id, 'send', x.id::text, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'masked', growth_outbound.mask_email(x.intended_recipient), 'already', false, 'done', true);
end $$;

-- THEY REPLIED (the reply reaches davis@ — a person reads it). Follow-ups
-- stop at once; "and asked to stop" suppresses the address for good.
create or replace function public.growth_outbound_prospect_replied(p_id uuid, p_note text default null, p_stop boolean default false)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  p growth_outbound.prospects;
  n int;
  r jsonb;
begin
  v_owner := growth_outbound.require_owner();
  select * into p from growth_outbound.prospects where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p.status not in ('contacted', 'replied') then
    return jsonb_build_object('ok', false, 'reason', 'not_contacted', 'status', p.status);
  end if;
  update growth_outbound.prospects set status = 'replied', status_reason = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
   where id = p.id;
  n := growth_outbound.cancel_live_drafts(p.id, 'they replied');
  if coalesce(p_stop, false) and growth_outbound.norm_email(p.email) is not null and not growth_outbound.is_suppressed(p.email) then
    r := growth_outbound.apply_suppression('address', p.email, 'replied', coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'asked to stop'),
                                           'reply', v_owner, p.id);
  end if;
  perform growth_outbound.log('prospect_replied', p.id, 'prospect', p.id::text,
    jsonb_build_object('stop', coalesce(p_stop, false), 'drafts_cancelled', n));
  return jsonb_build_object('ok', true, 'status', 'replied', 'drafts_cancelled', n,
    'suppressed', coalesce((r->>'ok')::boolean, false) or (coalesce(p_stop, false) and growth_outbound.is_suppressed(p.email)));
end $$;

-- REPLIES, for the console (2026-10): what Resend received for us, newest
-- first, who it was from when it matched someone we wrote to, and what it
-- changed. Owner only; reads.
create or replace function public.growth_outbound_replies(p_limit int default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return jsonb_build_object('ok', true,
    'detection', (select x.reply_detection from growth_outbound.settings x where x.id = 1),
    'last_at', (select max(received_at) from growth_outbound.replies),
    'counts_30d', (select jsonb_build_object('reply', count(*) filter (where kind = 'reply'), 'auto_reply', count(*) filter (where kind = 'auto_reply'),
                     'opt_out', count(*) filter (where kind = 'opt_out'), 'test', count(*) filter (where kind = 'test'),
                     'unmatched', count(*) filter (where kind = 'unmatched'))
                     from growth_outbound.replies where received_at >= now() - interval '30 days'),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'received_at', r.received_at, 'kind', r.kind, 'applied', r.applied,
                        'sequence_number', r.sequence_number, 'subject', r.subject, 'from_masked', r.from_masked, 'detail', r.detail,
                        'prospect_id', r.prospect_id, 'full_name', p.full_name, 'organization', p.organization, 'status', p.status)
                        order by r.received_at desc, r.id desc)
                       from (select * from growth_outbound.replies order by received_at desc, id desc
                              limit least(greatest(coalesce(p_limit, 50), 1), 200)) r
                       left join growth_outbound.prospects p on p.id = r.prospect_id), '[]'::jsonb));
end $$;

-- The last provider events, for the console: what Resend has told us.
create or replace function public.growth_outbound_provider_events(p_limit int default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('recipient', x.recipient, 'is_test', x.is_test) order by e.received_at desc)
    from (select * from growth_outbound.provider_events where outcome <> 'not_outbound'
           order by received_at desc limit least(greatest(coalesce(p_limit, 50), 1), 500)) e
    left join growth_outbound.sends x on x.id = e.send_id), '[]'::jsonb);
end $$;

-- ── the research engine's doors (Phase 7) ─────────────────────────────────────
-- supabase/functions/growth_outbound_research calls these AS THE OWNER who
-- pressed the button, so the owner check runs at every step. They record what
-- the engine read and found, and what it cost. None of them approves, drafts
-- or sends.

-- What the console shows about research: today's budget, the saved searches,
-- the candidates by status and the last runs.
create or replace function public.growth_outbound_research_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return jsonb_build_object(
    'budget', growth_outbound.research_budget(),
    'queries', coalesce((select s.discovery_config->'queries' from growth_outbound.settings s where s.id = 1), '[]'::jsonb),
    'shared_sites', coalesce((select s.discovery_config->'shared_sites' from growth_outbound.settings s where s.id = 1), '[]'::jsonb),
    'providers', coalesce((select s.discovery_config->'providers' from growth_outbound.settings s where s.id = 1), '{}'::jsonb),
    'daily_prospect_target', (select s.daily_prospect_target from growth_outbound.settings s where s.id = 1),
    'daily_qualified_target', (select s.daily_qualified_target from growth_outbound.settings s where s.id = 1),
    'enrichment_waiting', (select count(*) from growth_outbound.enrichment_queue(200)),
    'verification_waiting', (select count(*) from growth_outbound.verify_queue(200)),
    'candidates', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) n from growth_outbound.candidates group by status) x), '{}'::jsonb),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) - 'requested_by' - 'ticket_sha256' order by r.started_at desc) from (
        select * from growth_outbound.research_runs order by started_at desc limit 20) r), '[]'::jsonb),
    -- (Phase 13) what each provider last said, what they cost, where the
    -- candidates came from and what became of them, the directories, and the
    -- leads turned away with the reason
    'health', growth_outbound.provider_health_json(),
    'spend', growth_outbound.spend_json(),
    'sources', growth_outbound.source_stats(),
    'directories', coalesce((select s.discovery_config->'directories' from growth_outbound.settings s where s.id = 1), '[]'::jsonb),
    'directories_due', growth_outbound.directories_due(),
    'rejected', growth_outbound.recent_rejections(25));
end $$;

-- A RUN BEGINS: one row, so everything it reads and finds is accounted for.
-- A run nobody finished within 30 minutes died with its function and is
-- marked so; at most three run at once.
create or replace function public.growth_outbound_research_begin(p_kind text, p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_id bigint;
begin
  v_owner := growth_outbound.require_owner();
  if coalesce(p_kind, '') not in ('discover', 'research', 'draft', 'enrich') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;
  if p_input is not null and (jsonb_typeof(p_input) <> 'object' or length(p_input::text) > 4000) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_input');
  end if;
  update growth_outbound.research_runs set status = 'failed', finished_at = now(), error = 'never finished (the function stopped)'
   where status = 'running' and started_at < now() - interval '30 minutes';
  if (select count(*) from growth_outbound.research_runs where status = 'running') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_running', 'detail', 'three research runs are already going; wait for one to finish');
  end if;
  insert into growth_outbound.research_runs (kind, started_by, requested_by, input)
  values (p_kind, 'owner', v_owner, coalesce(p_input, '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'run_id', v_id, 'budget', growth_outbound.research_budget(),
    'queries', coalesce((select s.discovery_config->'queries' from growth_outbound.settings s where s.id = 1), '[]'::jsonb),
    -- (Phase 13) the directories due a read, and whether partner leads are written to
    'directories', growth_outbound.directories_due(),
    'partner_outreach', (select s.partner_outreach_enabled from growth_outbound.settings s where s.id = 1),
    'daily_prospect_target', (select s.daily_prospect_target from growth_outbound.settings s where s.id = 1),
    'providers', coalesce((select s.discovery_config->'providers' from growth_outbound.settings s where s.id = 1), '{}'::jsonb),
    'shared_sites', to_jsonb(growth_outbound.builtin_shared_sites())
                    || coalesce((select s.discovery_config->'shared_sites' from growth_outbound.settings s where s.id = 1), '[]'::jsonb));
end $$;

-- SPEND: before every provider call (or batch of calls) the engine asks; the
-- database counts it against today's cap, or refuses. Nothing is spent once
-- the cap is reached.
create or replace function public.growth_outbound_research_spend(p_run bigint, p_provider text, p_n int default 1)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v_day date := (now() at time zone 'utc')::date;
  v_cap int;
  v_used int;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run for update;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if coalesce(p_provider, '') not in ('search', 'fetch', 'llm', 'email_finder', 'email_verifier', 'enrichment') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_provider');
  end if;
  -- a drafting run writes; it does not search, read pages or look up addresses
  if r.kind = 'draft' and p_provider <> 'llm' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  -- an enrichment run (Phase 12) hands prospects to an enrichment provider, and nothing else
  if r.kind = 'enrich' and p_provider <> 'enrichment' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if coalesce(p_n, 0) not between 1 and 50 then return jsonb_build_object('ok', false, 'reason', 'invalid_count'); end if;
  v_cap := coalesce((select (s.discovery_config->'budget'->>p_provider)::int from growth_outbound.settings s where s.id = 1),
                    growth_outbound.budget_default(p_provider));
  insert into growth_outbound.provider_usage (day, provider, calls) values (v_day, p_provider, 0) on conflict (day, provider) do nothing;
  select calls into v_used from growth_outbound.provider_usage where day = v_day and provider = p_provider for update;
  if v_used + p_n > v_cap then
    return jsonb_build_object('ok', false, 'reason', 'budget_exhausted', 'provider', p_provider, 'cap', v_cap, 'used', v_used);
  end if;
  update growth_outbound.provider_usage set calls = calls + p_n where day = v_day and provider = p_provider;
  update growth_outbound.research_runs
     set counts = jsonb_set(counts, '{spent}', coalesce(counts->'spent', '{}'::jsonb)
                   || jsonb_build_object(p_provider, coalesce((counts->'spent'->>p_provider)::int, 0) + p_n))
   where id = p_run;
  return jsonb_build_object('ok', true, 'provider', p_provider, 'cap', v_cap, 'used', v_used + p_n, 'left', v_cap - v_used - p_n);
end $$;

-- A PAGE AS READ: stored so every quote from it can be checked.
--   { url, http_status, content_type, title, text }
create or replace function public.growth_outbound_page_record(p_run bigint, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v_bad text;
  pg growth_outbound.pages;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind = 'draft' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'not_an_object'); end if;
  select string_agg(x, ', ') into v_bad from jsonb_object_keys(p) x
   where x not in ('url', 'http_status', 'content_type', 'title', 'text');
  if v_bad is not null then return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', v_bad); end if;
  if length(coalesce(p->>'text', '')) > 200000 then
    return jsonb_build_object('ok', false, 'reason', 'too_large', 'detail', 'at most 200,000 characters of text');
  end if;
  begin
    insert into growth_outbound.pages (run_id, url, site_key, http_status, content_type, title, text, text_sha256)
    values (p_run, p->>'url', '', (p->>'http_status')::int, p->>'content_type', p->>'title', p->>'text', '')
    returning * into pg;
  exception when check_violation or not_null_violation or data_exception then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'page_id', pg.id, 'url', pg.url, 'site_key', pg.site_key,
    'sha256', pg.text_sha256, 'chars', length(pg.text));
end $$;

-- WHAT DISCOVERY TURNED UP. A page seen before is counted, not added again;
-- one that leads to a known prospect is marked a duplicate (with whose); one
-- on a domain that asked to stop is marked suppressed and never researched.
--   [{ url, title, snippet, query, provider, segment? }]
-- (Phase 13) segment: who the owner means them to be (an import or a
-- directory says so); a later word from the owner replaces an earlier one.
create or replace function public.growth_outbound_candidates_record(p_run bigint, p_items jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v jsonb;
  v_url text;
  v_site text;
  v_match uuid;
  v_status text;
  v_cid bigint;
  n_new int := 0;
  n_again int := 0;
  n_dup int := 0;
  n_supp int := 0;
  n_bad int := 0;
  v_ids bigint[] := '{}';
  v_seg text;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind = 'draft' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_items', 'detail', 'a list of at most 50 results');
  end if;
  -- one recording at a time (Phase 11): two runs that find the same new
  -- address make one candidate, seen twice, instead of a deadlock
  perform pg_advisory_xact_lock(hashtext('growth_outbound.candidates'));
  for v in select x from jsonb_array_elements(p_items) x loop
    v_url := case when jsonb_typeof(v) = 'object' then growth_outbound.canonical_url(v->>'url') end;
    if v_url is null or coalesce(v->>'provider', '') !~ '^[a-z0-9_-]{1,40}$' then n_bad := n_bad + 1; continue; end if;
    v_seg := case when jsonb_typeof(v->'segment') = 'string'
                   and v->>'segment' in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner') then v->>'segment' end;
    select id into v_cid from growth_outbound.candidates where url = v_url for update;
    if found then
      update growth_outbound.candidates set last_seen_at = now(), times_seen = times_seen + 1, last_run_id = p_run, updated_at = now(),
             segment_hint = coalesce(v_seg, segment_hint)
       where id = v_cid;
      n_again := n_again + 1;
      continue;
    end if;
    v_site := growth_outbound.site_key(growth_outbound.url_host(v_url));
    v_match := null;
    select i.prospect_id into v_match
      from growth_outbound.url_identity(v_url) k
      join growth_outbound.identifiers i on i.kind = k.kind and i.value = k.value and i.released_at is null
     where k.kind = 'handle' or (k.kind = 'site' and not growth_outbound.is_shared_site(k.value))
     limit 1;
    v_status := case
      when exists (select 1 from growth_outbound.suppressions s where s.scope = 'domain' and s.target = v_site) then 'suppressed'
      when v_match is not null then 'duplicate'
      else 'new' end;
    insert into growth_outbound.candidates (url, site_key, title, snippet, query, provider, status, status_reason, prospect_id,
                                            first_run_id, last_run_id, segment_hint)
    values (v_url, v_site,
            left(nullif(btrim(regexp_replace(coalesce(v->>'title', ''), '\s+', ' ', 'g')), ''), 300),
            left(nullif(btrim(regexp_replace(coalesce(v->>'snippet', ''), '\s+', ' ', 'g')), ''), 1000),
            left(nullif(btrim(coalesce(v->>'query', '')), ''), 200), v->>'provider', v_status,
            case v_status when 'suppressed' then 'the domain asked not to be contacted' when 'duplicate' then 'already a prospect' end,
            v_match, p_run, p_run, v_seg)
    returning id into v_cid;
    v_ids := array_append(v_ids, v_cid);
    if v_status = 'new' then n_new := n_new + 1; elsif v_status = 'duplicate' then n_dup := n_dup + 1; else n_supp := n_supp + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'new', n_new, 'seen_again', n_again, 'duplicates', n_dup, 'suppressed', n_supp,
    'invalid', n_bad, 'candidate_ids', to_jsonb(v_ids));
end $$;

-- The candidates, newest first within each status.
create or replace function public.growth_outbound_candidates(p_status text default 'new', p_limit int default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_engine();
  return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('full_name', p.full_name, 'prospect_status', p.status)
                                    order by c.last_seen_at desc, c.id desc)
    from (select * from growth_outbound.candidates
           where p_status is null or status = p_status
           order by last_seen_at desc, id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) c
    left join growth_outbound.prospects p on p.id = c.prospect_id), '[]'::jsonb);
end $$;

-- One candidate, by id.
create or replace function public.growth_outbound_candidate(p_id bigint)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_engine();
  return coalesce((select to_jsonb(c) || jsonb_build_object('ok', true) from growth_outbound.candidates c where c.id = p_id),
                  jsonb_build_object('ok', false, 'reason', 'not_found'));
end $$;

-- A candidate's status by hand (dismiss it, or put it back in the queue), or
-- by the engine (not a fit, failed), with the reason.
create or replace function public.growth_outbound_candidate_set(p_id bigint, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare c growth_outbound.candidates;
begin
  perform growth_outbound.require_engine();
  select * into c from growth_outbound.candidates where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(p_status, '') not in ('new', 'dismissed', 'not_a_fit', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;
  if c.status = 'suppressed' then return jsonb_build_object('ok', false, 'reason', 'suppressed'); end if;
  update growth_outbound.candidates set status = p_status, status_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500),
         updated_at = now()
   where id = p_id;
  perform growth_outbound.log('candidate_' || p_status, c.prospect_id, 'candidate', p_id::text,
    jsonb_build_object('from', c.status, 'reason', left(p_reason, 200)));
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;

-- WHAT RESEARCH FOUND, recorded through the same ingest the owner's form
-- uses, as the research engine (or a named provider). The engine never
-- writes owner-verified evidence and never chooses which page is "own".
-- A URL or address that already names somebody else is left out, and said
-- so, rather than merging two people. An address a verifier calls invalid
-- or disposable is marked unusable.
--   p: the ingest payload (no collected_by), plus
--      email_verdicts: [{ email, status }]   (a verifier's word on an address)
create or replace function public.growth_outbound_research_ingest(p_run bigint, p_candidate bigint, p_prospect uuid,
                                                                  p_collector text, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  c growth_outbound.candidates;
  v_target uuid := p_prospect;
  v_primary uuid;
  v_matches uuid[];
  v_urls jsonb := '[]'::jsonb;
  v_dropped jsonb := '[]'::jsonb;
  v_raw text;
  v_held uuid;
  v_email text;
  v_verdicts jsonb;
  v jsonb;
  v_res jsonb;
  v_pid uuid;
  v_ok boolean;
  v_marked int := 0;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind = 'draft' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if coalesce(p_collector, '') !~ '^(research_engine|provider:[a-z0-9_-]{1,40})$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_collector');
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'not_an_object'); end if;
  if p ? 'collected_by' then return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', 'collected_by'); end if;
  if p ? 'urls' and jsonb_typeof(p->'urls') <> 'array' then return jsonb_build_object('ok', false, 'reason', 'invalid_urls'); end if;
  if p ? 'email_verdicts' and (jsonb_typeof(p->'email_verdicts') <> 'array' or jsonb_array_length(p->'email_verdicts') > 20) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email_verdicts');
  end if;
  if p_prospect is not null and not exists (select 1 from growth_outbound.prospects where id = p_prospect) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_candidate is not null then
    select * into c from growth_outbound.candidates where id = p_candidate for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'detail', 'candidate'); end if;
    if c.status = 'suppressed' then return jsonb_build_object('ok', false, 'reason', 'suppressed'); end if;
  end if;

  -- WHO IS THIS? The prospect named; else whoever the candidate's own page
  -- names; else the one prospect every strong key given points to.
  perform pg_advisory_xact_lock(hashtext('growth_outbound.identity'));
  v_email := growth_outbound.norm_email(p->>'email');
  if v_target is null and c.id is not null then
    v_target := c.prospect_id;
    if v_target is null then
      select i.prospect_id into v_primary from growth_outbound.url_identity(c.url) k
        join growth_outbound.identifiers i on i.kind = k.kind and i.value = k.value and i.released_at is null
       where k.strength = 'strong' limit 1;
      v_target := v_primary;
    end if;
  end if;
  if v_target is null then
    select coalesce(array_agg(distinct i.prospect_id), '{}'::uuid[]) into v_matches
      from growth_outbound.identifiers i
     where i.strength = 'strong' and i.released_at is null
       and ((i.kind = 'email' and i.value = v_email)
         or (i.kind, i.value) in (select k.kind, k.value
                                    from jsonb_array_elements_text(coalesce(p->'urls', '[]'::jsonb)) u(url),
                                         lateral growth_outbound.url_identity(u.url) k where k.strength = 'strong'));
    if cardinality(v_matches) = 1 then v_target := v_matches[1]; end if;
  end if;

  -- a URL or an address that names somebody else is left out, and said so
  for v_raw in select x from jsonb_array_elements_text(coalesce(p->'urls', '[]'::jsonb)) x loop
    v_held := null;
    select i.prospect_id into v_held from growth_outbound.url_identity(v_raw) k
      join growth_outbound.identifiers i on i.kind = k.kind and i.value = k.value and i.released_at is null
     where k.strength = 'strong' limit 1;
    if v_held is not null and v_held is distinct from v_target then
      v_dropped := v_dropped || to_jsonb(v_raw);
    else
      v_urls := v_urls || to_jsonb(v_raw);
    end if;
  end loop;
  if v_email is not null and exists (select 1 from growth_outbound.identifiers i where i.kind = 'email' and i.value = v_email
                                       and i.released_at is null and i.prospect_id is distinct from v_target) then
    v_dropped := v_dropped || to_jsonb(v_email);
    p := p - 'email';
  end if;

  v_verdicts := p->'email_verdicts';
  -- who a known prospect is to EdgeDesk (subscriber or partner) is not the
  -- engine's to change once set: the owner may have decided it (Phase 12)
  if v_target is not null then p := p - 'campaign_type'; end if;
  p := (p - 'email_verdicts' - 'urls') || jsonb_build_object('collected_by', p_collector)
       || case when p ? 'urls' then jsonb_build_object('urls', v_urls) else '{}'::jsonb end;
  v_res := growth_outbound.ingest(v_target, p);
  v_ok := coalesce((v_res->>'ok')::boolean, false);
  v_pid := coalesce((v_res->>'prospect_id')::uuid, v_target);

  -- every verifier's word is on the record (Phase 12), so an address is not
  -- asked about again every morning
  if v_ok and v_verdicts is not null then
    for v in select x from jsonb_array_elements(v_verdicts) x loop
      continue when jsonb_typeof(v) <> 'object' or growth_outbound.norm_email(v->>'email') is null;
      perform growth_outbound.log('email_verdict', v_pid, 'prospect', v_pid::text,
        jsonb_build_object('email', growth_outbound.norm_email(v->>'email'), 'status', left(coalesce(v->>'status', 'unknown'), 40),
                           'by', p_collector));
    end loop;
  end if;
  -- an address a verifier calls invalid or disposable is not used
  if v_ok and v_verdicts is not null then
    for v in select x from jsonb_array_elements(v_verdicts) x loop
      continue when jsonb_typeof(v) <> 'object' or coalesce(v->>'status', '') not in ('invalid', 'disposable');
      update growth_outbound.prospects set email_invalid_at = coalesce(email_invalid_at, now())
       where id = v_pid and growth_outbound.norm_email(email) = growth_outbound.norm_email(v->>'email') and email_invalid_at is null;
      if found then v_marked := v_marked + 1; end if;
    end loop;
    if v_marked > 0 then v_res := v_res || jsonb_build_object('status', growth_outbound.evaluate(v_pid)->>'status'); end if;
  end if;

  if c.id is not null then
    update growth_outbound.candidates set
      status = case when v_ok then 'researched' when v_res->>'reason' = 'suppressed' then 'suppressed' else 'failed' end,
      status_reason = case when v_ok then null
                           else left(coalesce(v_res->>'reason', 'refused') || coalesce(': ' || (v_res->>'detail'), ''), 500) end,
      prospect_id = coalesce(case when v_ok then v_pid end, prospect_id),
      last_run_id = p_run, updated_at = now()
     where id = c.id;
  end if;
  update growth_outbound.research_runs
     set counts = counts || jsonb_build_object(
           'ingested', coalesce((counts->>'ingested')::int, 0) + case when v_ok then 1 else 0 end,
           'refused', coalesce((counts->>'refused')::int, 0) + case when v_ok then 0 else 1 end,
           'evidence', coalesce((counts->>'evidence')::int, 0) + coalesce(jsonb_array_length(v_res->'evidence_ids'), 0))
   where id = p_run;
  return v_res || jsonb_build_object('dropped', v_dropped, 'emails_marked_invalid', v_marked);
end $$;

-- A RUN ENDS: done or failed, with what it did and, if it failed, why.
create or replace function public.growth_outbound_research_finish(p_run bigint, p_status text, p_counts jsonb default '{}'::jsonb,
                                                                  p_error text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare r growth_outbound.research_runs;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run for update;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if coalesce(p_status, '') not in ('done', 'failed') then return jsonb_build_object('ok', false, 'reason', 'invalid_status'); end if;
  if p_counts is not null and (jsonb_typeof(p_counts) <> 'object' or length(p_counts::text) > 4000) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_counts');
  end if;
  update growth_outbound.research_runs
     set status = p_status, finished_at = now(), counts = counts || coalesce(p_counts - 'spent', '{}'::jsonb),
         error = left(nullif(btrim(coalesce(p_error, '')), ''), 1000)
   where id = p_run returning * into r;
  perform growth_outbound.log('research_' || r.kind || '_' || p_status, null, 'research_run', p_run::text,
    r.counts || jsonb_build_object('error', r.error));
  return jsonb_build_object('ok', true, 'run', to_jsonb(r) - 'requested_by' - 'ticket_sha256');
end $$;

-- ── the drafting engine (Phase 8): software may DRAFT, never approve or send ─
--
--   The engine (supabase/functions/growth_outbound_draft) writes a first
--   email or a follow-up for a prospect who is due one and PROPOSES it here.
--   It enters the review queue only if, checked here:
--     * every claim it makes about the person cites current evidence about
--       them that an email may cite, sure enough BY ITSELF to clear the
--       research gate, and the claim's words are that evidence's own words
--       (its claim or its quote) — the email says each claim in those words;
--     * it names nothing and gives no figure it cannot cite, and every
--       sentence about them ("your …") carries a claim;
--     * the greeting is "Hi <first name>," only for an established first
--       name, "Hi there," otherwise — never a guess;
--     * the step is due (step_due_problem), and the content rules hold.
--   It goes in pending review, unedited, marked as the engine's. Approving
--   and sending stay the owner's; the send trigger checks the follow-up
--   cadence again.

-- Is a step due for a prospect now? NULL: yes. Otherwise why not, in words.
--   step 1  a first email: the prospect is qualified (every gate clear, no
--           draft waiting) and was never sent step 1;
--   step 2  follow-up 1: contacted and not answered, opted out or bounced;
--           step 1 went out followup_delay_days ago; follow-ups are on;
--   step 3  the final follow-up: the same, final_followup_delay_days after
--           follow-up 1, while the final follow-up is on.
create or replace function growth_outbound.step_due_problem(p_prospect uuid, p_seq int)
returns text language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  p growth_outbound.prospects;
  s growth_outbound.settings;
  v_prev timestamptz;
  v_days int;
begin
  select * into p from growth_outbound.prospects where id = p_prospect;
  if not found then return 'no such prospect'; end if;
  select * into s from growth_outbound.settings where id = 1;
  if p_seq is null or p_seq not between 1 and 3 then return 'the steps are 1, 2 and 3'; end if;
  if p.status = 'suppressed' or growth_outbound.is_suppressed(p.email) then return 'this address is suppressed'; end if;
  if p.status in ('rejected', 'replied', 'converted') then return 'this prospect is ' || p.status; end if;
  if p.duplicate_of is not null then return 'this prospect duplicates another'; end if;
  if exists (select 1 from growth_outbound.drafts d where d.prospect_id = p.id and d.sequence_number = p_seq
               and d.status in ('pending_review', 'approved')) then
    return 'a draft for this step is already waiting';
  end if;
  -- sent means sent to THEM: a test send (to the owner's own inbox, in test
  -- mode) is a dry run, and the real first email is still to come (Phase 11)
  if exists (select 1 from growth_outbound.sends x where x.prospect_id = p.id and x.sequence_number = p_seq and not x.is_test) then
    return 'this step has already been sent';
  end if;
  if p_seq = 1 then
    if p.status <> 'qualified' then
      return left('not qualified (' || p.status || coalesce(': ' || p.status_reason, '') || ')', 300);
    end if;
    return null;
  end if;
  if p.is_test then return 'a test prospect gets a first email only'; end if;
  if p.status <> 'contacted' then
    return 'a follow-up goes only to a prospect who was contacted and has not answered (this one is ' || p.status || ')';
  end if;
  if (p_seq = 2 and not s.followup_enabled) or (p_seq = 3 and not s.final_followup_enabled) then
    return case when p_seq = 2 then 'follow-ups are turned off in the settings' else 'the final follow-up is turned off in the settings' end;
  end if;
  v_prev := growth_outbound.step_sent_at(p.id, p_seq - 1);
  if v_prev is null then return 'step ' || (p_seq - 1) || ' has not gone out (or it bounced)'; end if;
  v_days := case when p_seq = 2 then s.followup_delay_days else s.final_followup_delay_days end;
  if v_prev > now() - make_interval(days => v_days) then
    return 'not due until ' || to_char((v_prev + make_interval(days => v_days)) at time zone 'utc', 'YYYY-MM-DD HH24:MI') || ' UTC';
  end if;
  return null;
end $$;

-- WHO IS DUE A DRAFT NOW: real prospects only; follow-ups first (they are
-- the ones with a date), then the best fit. Not a step whose draft the owner
-- rejected in the last 14 days: the engine does not argue (the owner can
-- still ask for one by hand). Not a step the engine gave up on in the last 7
-- days, unless new evidence has arrived since (so one prospect nothing can be
-- written for does not take the first place, and the budget, every time).
create or replace function growth_outbound.drafting_due()
returns table (prospect_id uuid, sequence_number int)
language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p.id, k.seq
    from growth_outbound.prospects p
   cross join lateral (select 1 as seq where p.status = 'qualified'
                       union all select 2 where p.status = 'contacted'
                       union all select 3 where p.status = 'contacted') k
   where not p.is_test
     -- the engine pitches a subscription to potential subscribers only; a
     -- partner lead is the owner's to write to (Phase 12), or the engine's
     -- partnership note's while partner outreach is on (Phase 13)
     and (p.campaign_type = 'customer'
          or (select x.partner_outreach_enabled from growth_outbound.settings x where x.id = 1))
     and growth_outbound.step_due_problem(p.id, k.seq) is null
     and not growth_outbound.has_account(p.email)
     and not exists (select 1 from growth_outbound.drafts d where d.prospect_id = p.id and d.sequence_number = k.seq
                       and d.status = 'rejected' and d.rejected_at > now() - interval '14 days')
     and not exists (select 1 from growth_outbound.activity a where a.prospect_id = p.id and a.action = 'draft_gave_up'
                       and a.detail->>'sequence' = k.seq::text and a.at > now() - interval '7 days'
                       and not exists (select 1 from growth_outbound.evidence e where e.prospect_id = p.id and e.observed_at > a.at))
   order by k.seq desc, p.qualification_score desc nulls last, p.fit_score desc nulls last, p.created_at, p.id;
$$;

-- The facts an email to this prospect may cite, best first: current,
-- citeable, and each sure enough by itself to clear the research gate. One
-- line per claim (its first source), however many sources say it.
create or replace function growth_outbound.citeable_facts(p_prospect uuid)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('evidence_id', y.id, 'field', y.field_name, 'claim', y.claim,
           'quote', y.source_excerpt, 'source_url', y.source_url, 'source_kind', y.source_kind, 'source_title', y.source_title,
           'published_at', y.source_published_at, 'confidence', y.c) order by y.c desc, y.id), '[]'::jsonb)
    from (select x.* from (
            select distinct on (e.field_name, e.claim_norm) e.*, growth_outbound.evidence_confidence(e.id, p_prospect) as c
              from growth_outbound.evidence e
             where e.prospect_id = p_prospect and e.superseded_at is null and e.claim_norm is not null
               and growth_outbound.engine_citeable(e.field_name)
             order by e.field_name, e.claim_norm, e.id) x
           where x.c >= (select s.min_research_confidence from growth_outbound.settings s where s.id = 1)
           order by x.c desc, x.id limit 12) y;
$$;

-- What the owner said when rejecting the engine's recent drafts: the engine
-- reads it before writing the next one.
create or replace function growth_outbound.engine_lessons()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(x.r order by x.at desc), '[]'::jsonb) from (
    select d.rejection_reason as r, d.rejected_at as at from growth_outbound.drafts d
     where d.generator_version like 'engine:%' and d.status = 'rejected' and d.rejection_reason is not null
       and d.rejected_at > now() - interval '60 days'
     order by d.rejected_at desc limit 5) x;
$$;

-- How each writer's drafts fare (90 days, real prospects): the engine's,
-- its template's, the owner's. Approved as written vs after an edit vs
-- rejected is what the engine is judged on.
create or replace function growth_outbound.drafting_stats()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_object_agg(x.k, x.v), '{}'::jsonb) from (
    select case when d.generator_version like 'engine:template:%' then 'template'
                when d.generator_version like 'engine:%' then 'engine' else 'owner' end as k,
           jsonb_build_object(
             'drafts', count(*),
             'waiting', count(*) filter (where d.status = 'pending_review'),
             'approved_as_written', count(*) filter (where d.status in ('approved', 'sent') and not d.edited_by_owner),
             'approved_after_edit', count(*) filter (where d.status in ('approved', 'sent') and d.edited_by_owner),
             'rejected', count(*) filter (where d.status = 'rejected'),
             'sent', count(*) filter (where d.status = 'sent'),
             'replied', count(distinct d.prospect_id) filter (where d.status = 'sent' and exists (
                          select 1 from growth_outbound.activity a where a.prospect_id = d.prospect_id and a.action = 'prospect_replied'))) as v
      from growth_outbound.drafts d join growth_outbound.prospects p on p.id = d.prospect_id
     where not d.is_test and d.generated_at > now() - interval '90 days'
     group by 1) x;
$$;

-- THE PAGE A DRAFT LINKS TO (2026-10). Chosen from what the prospect's
-- record already says — their type, the campaign, their sports — never from
-- anything new, and stated with its reason so the owner sees why in review.
-- The URL is written into the draft's words, so it is part of the content
-- hash the owner approves: nothing here can change an approved email.
--   partnership campaign, or a newsletter / media / podcast / community /
--     video operator                          → /partners/
--   a modeller, quant, analytics creator, educator or handicapper-modeller
--                                             → /tools/fair-odds-calculator/
--   a player-props analyst                    → /tools/no-vig-calculator/
--   college football (type, or sports focus)  → /articles/college-football/
--   the NFL or fantasy (type, or sports focus) → /articles/nfl/
--   a football analyst covering both          → /articles/
--   anything else, or landing_by_interest off → cta_url (the owner's default)
-- tag_links() adds the campaign code to whichever page it is, at send time.
create or replace function growth_outbound.landing_for(p_prospect uuid)
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  p growth_outbound.prospects; s growth_outbound.settings;
  v_focus text; v_cfb boolean; v_nfl boolean;
  site constant text := 'https://edgedesksports.com';
  pick text; why text; k text;
begin
  select * into s from growth_outbound.settings where id = 1;
  select * into p from growth_outbound.prospects where id = p_prospect;
  if not found or not coalesce(s.landing_by_interest, true) then
    return jsonb_build_object('url', s.cta_url, 'key', 'default', 'reason', 'the default call to action (landing by interest is off)');
  end if;
  v_focus := upper(coalesce(array_to_string(p.sports_focus, ' '), ''));
  v_cfb := p.prospect_type = 'cfb_analyst' or v_focus ~ '(CFB|NCAAF|COLLEGE)';
  v_nfl := p.prospect_type in ('nfl_analyst', 'fantasy_analyst') or v_focus ~ '(NFL|FANTASY)';
  if p.campaign_type <> 'customer'
     or p.prospect_type in ('newsletter_writer', 'analytics_newsletter', 'media_founder', 'podcast', 'community_operator', 'youtube_creator') then
    pick := '/partners/'; k := 'partnership'; why := 'a ' || replace(p.prospect_type, '_', ' ') || ' (' || p.campaign_type || ' campaign): the research partnership page';
  elsif p.prospect_type in ('quant_researcher', 'modeling_creator', 'analytics_creator', 'handicapper_modeler', 'betting_educator') then
    pick := '/tools/fair-odds-calculator/'; k := 'fair_odds_tool'; why := 'a ' || replace(p.prospect_type, '_', ' ') || ': the free fair odds calculator';
  elsif p.prospect_type = 'props_analyst' then
    pick := '/tools/no-vig-calculator/'; k := 'no_vig_tool'; why := 'a player-props analyst: the free no-vig calculator';
  elsif v_cfb and not v_nfl then
    pick := '/articles/college-football/'; k := 'cfb_research'; why := 'covers college football: the public CFB research';
  elsif v_nfl and not v_cfb then
    pick := '/articles/nfl/'; k := 'nfl_research'; why := 'covers the NFL: the public NFL research';
  elsif (v_cfb and v_nfl) or p.prospect_type = 'football_analyst' then
    pick := '/articles/'; k := 'football_research'; why := 'covers football: the public research hub';
  else
    return jsonb_build_object('url', s.cta_url, 'key', 'default', 'reason', 'no specific interest on the record: the default call to action');
  end if;
  return jsonb_build_object('url', site || pick, 'key', k, 'reason', why);
end $$;
revoke all on function growth_outbound.landing_for(uuid) from public;

-- WHAT THE ENGINE MAY WRITE FROM, for one prospect and one step: whether it
-- is due; their first name (only if established); the facts it may cite;
-- what was already sent to them; the owner's recent reasons for rejecting
-- engine drafts; who signs. Nothing else about the person.
create or replace function public.growth_outbound_draft_context(p_prospect uuid, p_sequence int default 1)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  p growth_outbound.prospects;
  s growth_outbound.settings;
  v_problem text;
begin
  perform growth_outbound.require_engine();
  if not exists (select 1 from growth_outbound.prospects where id = p_prospect) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform growth_outbound.evaluate(p_prospect);
  select * into p from growth_outbound.prospects where id = p_prospect;
  select * into s from growth_outbound.settings where id = 1;
  v_problem := growth_outbound.step_due_problem(p.id, p_sequence);
  return jsonb_build_object('ok', true, 'prospect_id', p.id, 'sequence_number', p_sequence,
    'due', v_problem is null, 'problem', v_problem, 'is_test', p.is_test,
    'first_name', p.first_name, 'prospect_type', p.prospect_type, 'campaign_type', p.campaign_type,
    'facts', growth_outbound.citeable_facts(p.id),
    'previous', coalesce((
      select jsonb_agg(jsonb_build_object('sequence_number', d.sequence_number, 'subject', d.subject, 'body_text', d.body_text,
               'sent_at', (select x.sent_at from growth_outbound.sends x where x.draft_id = d.id)) order by d.sequence_number)
        from growth_outbound.drafts d
       where d.prospect_id = p.id and d.status = 'sent' and d.sequence_number < coalesce(p_sequence, 1)
         -- what reached THEM, not a dry run to the owner's inbox
         and exists (select 1 from growth_outbound.sends x where x.draft_id = d.id and not x.is_test)), '[]'::jsonb),
    'lessons', growth_outbound.engine_lessons(),
    'sender', jsonb_build_object('name', s.sender_name, 'business_name', s.business_name, 'cta_url', s.cta_url),
    -- the page this prospect's email should link to, and why (landing_for)
    'landing', growth_outbound.landing_for(p.id),
    'min_research_confidence', s.min_research_confidence);
end $$;

-- THE ENGINE'S RULES FOR AN EMAIL, in one place: what draft_propose refuses
-- and what the owner's draft check reports. Reads only; writes nothing.
--   { reason, detail }            the proposal is malformed (no problems list)
--   { problems[], claims[], subject, body, words }   otherwise; no problems
--                                  means the engine may queue it
-- Every claim: this person's current, citeable, confident evidence, in its own
-- words, said in the email. The greeting, nothing specific from nowhere, no
-- uncited sentence about them, and the content rules. And (Phase 12) what
-- every engine email must say: the 7-day free trial and $49.99/month, the
-- link to EdgeDesk, under 150 words, and only to a potential subscriber.
create or replace function growth_outbound.engine_draft_problems(p_prospect uuid, p_seq int, p_subject text, p_body text,
                                                                 p_claims jsonb)
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_p growth_outbound.prospects;
  s growth_outbound.settings;
  e growth_outbound.evidence;
  v_subject text;
  v_body text;
  v_problems text[] := '{}';
  v_claims jsonb := '[]'::jsonb;
  v_texts text[] := '{}';
  v_text text;
  v_conf numeric;
  v_words int;
  c jsonb;
  x text;
begin
  select * into v_p from growth_outbound.prospects where id = p_prospect;
  if not found then return jsonb_build_object('reason', 'not_found'); end if;
  select * into s from growth_outbound.settings where id = 1;
  v_subject := btrim(regexp_replace(coalesce(p_subject, ''), '\s+', ' ', 'g'));
  v_body := btrim(regexp_replace(replace(coalesce(p_body, ''), E'\r\n', E'\n'), '[ \t]+\n', E'\n', 'g'));
  if length(v_subject) not between 3 and 80 then v_problems := array_append(v_problems, 'the subject is 3 to 80 characters'::text); end if;
  if length(v_body) not between 40 and 1500 then v_problems := array_append(v_problems, 'the body is 40 to 1,500 characters'::text); end if;

  for c in select y from jsonb_array_elements(case when jsonb_typeof(p_claims) = 'array' then p_claims else '[]'::jsonb end) y loop
    v_text := case when jsonb_typeof(c) = 'object' and jsonb_typeof(c->'text') = 'string'
                   then btrim(regexp_replace(c->>'text', '\s+', ' ', 'g')) end;
    if v_text is null or length(v_text) not between 3 and 200 or jsonb_typeof(c->'evidence_id') is distinct from 'number'
       or (c->>'evidence_id') !~ '^[0-9]{1,18}$' then
      return jsonb_build_object('reason', 'invalid_claims', 'detail', 'each claim is {text: 3 to 200 characters, evidence_id}');
    end if;
    select * into e from growth_outbound.evidence where id = (c->>'evidence_id')::bigint;
    if not found or e.prospect_id <> v_p.id or e.superseded_at is not null or e.claim_norm is null then
      v_problems := array_append(v_problems, format('"%s" cites evidence %s, which is not current evidence about this person',
                                                    left(v_text, 80), c->>'evidence_id'));
      continue;
    end if;
    if not growth_outbound.engine_citeable(e.field_name) then
      v_problems := array_append(v_problems, format('"%s" cites their %s, which an email does not cite', left(v_text, 80),
                                                    replace(e.field_name, '_', ' ')));
      continue;
    end if;
    v_conf := growth_outbound.evidence_confidence(e.id, v_p.id);
    if v_conf < s.min_research_confidence then
      v_problems := array_append(v_problems, format('"%s" rests on evidence only %s sure (the research gate is %s)',
                                                    left(v_text, 80), round(v_conf, 2), s.min_research_confidence));
    end if;
    if not (growth_outbound.quote_in(v_text, e.claim) or growth_outbound.quote_in(v_text, e.source_excerpt)) then
      v_problems := array_append(v_problems, format('"%s" is not in the words of evidence %s', left(v_text, 80), e.id));
    end if;
    if not growth_outbound.quote_in(v_text, v_subject || E'\n' || v_body) then
      v_problems := array_append(v_problems, format('"%s" is cited, but the email does not say it in those words', left(v_text, 80)));
    end if;
    v_texts := array_append(v_texts, v_text);
    v_claims := v_claims || jsonb_build_array(jsonb_build_object('text', v_text, 'evidence_id', e.id));
  end loop;
  if jsonb_array_length(v_claims) = 0 and coalesce(jsonb_array_length(case when jsonb_typeof(p_claims) = 'array' then p_claims end), 0) = 0
     and not v_p.is_test then
    v_problems := array_append(v_problems, 'an individual email says at least one thing about them, cited'::text);
  end if;

  x := growth_outbound.greeting_problem(v_body, v_p.first_name);
  if x is not null then v_problems := array_append(v_problems, x); end if;
  foreach x in array growth_outbound.uncited_details(v_subject || E'\n' || v_body,
      array_to_string(v_texts, ' ') || ' ' || coalesce(v_p.first_name, '') || ' ' || s.sender_name || ' ' || s.business_name) loop
    v_problems := array_append(v_problems, format('"%s" comes from no cited claim', x));
  end loop;
  foreach x in array growth_outbound.uncited_sentences(v_subject || E'\n' || v_body, v_texts) loop
    v_problems := array_append(v_problems, format('this says something about them without a cited claim: "%s"', x));
  end loop;
  foreach x in array growth_outbound.draft_lint(v_subject, v_body) loop
    v_problems := array_append(v_problems, ('content: ' || x)::text);
  end loop;

  -- (Phase 12) what every engine email says, and to whom. (Phase 13) A
  -- partner lead gets a partnership note, never the subscription pitch, and
  -- only while the owner has partner outreach on.
  if v_p.campaign_type <> 'customer' and not v_p.is_test then
    if not s.partner_outreach_enabled then
      v_problems := array_append(v_problems, ('this is a ' || replace(v_p.campaign_type, '_', ' ')
        || ' lead: the engine writes to partner leads only while partner outreach is on (Outbound settings), or write a partnership note yourself')::text);
    end if;
    v_problems := v_problems || growth_outbound.partner_offer_problems(v_body);
  else
    v_problems := v_problems || growth_outbound.offer_problems(v_body, s.cta_url);
  end if;
  v_words := coalesce(array_length(regexp_split_to_array(nullif(v_body, ''), '\s+'), 1), 0);
  return jsonb_build_object('problems', to_jsonb(v_problems), 'claims', v_claims, 'subject', v_subject, 'body', v_body,
                            'words', v_words);
end $$;

-- PROPOSE A DRAFT — the engine's only way into the review queue.
--   { sequence_number, subject, body_text, claims: [{text, evidence_id}],
--     generator: 'engine:<writer>:<version>' }
-- A refusal lists every problem found, in words, so the engine can try once
-- more or fall back to its template. Nothing is written unless all is well.
create or replace function public.growth_outbound_draft_propose(p_run bigint, p_prospect uuid, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v_p growth_outbound.prospects;
  d growth_outbound.drafts;
  v_gen text;
  v_seq int;
  v_subject text;
  v_body text;
  v_due text;
  v_chk jsonb;
  v_claims jsonb;
  x text;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run for update;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind <> 'draft' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'not_an_object'); end if;
  select string_agg(k, ', ') into x from jsonb_object_keys(p) k
   where k not in ('sequence_number', 'subject', 'body_text', 'claims', 'generator');
  if x is not null then return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', x); end if;
  v_gen := case when jsonb_typeof(p->'generator') = 'string' then p->>'generator' end;
  if coalesce(v_gen, '') !~ '^engine:[a-z0-9._-]{1,40}:[a-z0-9._-]{1,20}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_generator', 'detail', 'engine:<writer>:<version>');
  end if;
  v_seq := case when jsonb_typeof(p->'sequence_number') = 'number' and (p->>'sequence_number') ~ '^[1-3]$'
                then (p->>'sequence_number')::int end;
  if v_seq is null then return jsonb_build_object('ok', false, 'reason', 'invalid_sequence'); end if;
  if jsonb_typeof(p->'subject') is distinct from 'string' or jsonb_typeof(p->'body_text') is distinct from 'string' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_content', 'detail', 'a subject and a body, as text');
  end if;
  if jsonb_typeof(p->'claims') is distinct from 'array' or jsonb_array_length(p->'claims') > 5 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_claims', 'detail', 'claims: a list of at most 5');
  end if;
  if not exists (select 1 from growth_outbound.prospects where id = p_prospect) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- the prospect as the evidence stands NOW, and the step due NOW
  perform growth_outbound.evaluate(p_prospect);
  select * into v_p from growth_outbound.prospects where id = p_prospect for update;
  v_due := growth_outbound.step_due_problem(v_p.id, v_seq);
  if v_due is not null then return jsonb_build_object('ok', false, 'reason', 'not_due', 'detail', v_due); end if;

  v_chk := growth_outbound.engine_draft_problems(v_p.id, v_seq, p->>'subject', p->>'body_text', p->'claims');
  if v_chk ? 'reason' then
    return jsonb_build_object('ok', false, 'reason', v_chk->>'reason', 'detail', v_chk->>'detail');
  end if;
  if jsonb_array_length(v_chk->'problems') > 0 then
    return jsonb_build_object('ok', false, 'reason', 'refused',
      'problems', (select jsonb_agg(x.v order by x.n) from jsonb_array_elements(v_chk->'problems') with ordinality x(v, n) where x.n <= 20));
  end if;
  v_subject := v_chk->>'subject';
  v_body := v_chk->>'body';
  v_claims := v_chk->'claims';

  insert into growth_outbound.drafts (prospect_id, sequence_number, campaign_type, is_test, subject, body_text, greeting_name,
                                      claims, generator_version, edited_by_owner, run_id)
  values (v_p.id, v_seq, v_p.campaign_type, v_p.is_test, v_subject, v_body, nullif(growth_outbound.greeting_of(v_body), 'there'),
          v_claims, v_gen, false, p_run)
  returning * into d;
  perform growth_outbound.evaluate(v_p.id);
  perform growth_outbound.log('draft_proposed', v_p.id, 'draft', d.id::text,
    jsonb_build_object('sequence', v_seq, 'claims', jsonb_array_length(v_claims), 'generator', v_gen, 'run', p_run));
  return jsonb_build_object('ok', true, 'draft_id', d.id, 'content_hash', d.content_hash,
    'status', (select status from growth_outbound.prospects where id = v_p.id));
end $$;

-- CHECK A DRAFT WITHOUT QUEUEING IT (Phase 12): the owner's dry run. The
-- same rules draft_propose applies, the step's due-ness reported rather than
-- required, and nothing written: no draft, no log, no evaluation.
--   p: { sequence_number, subject, body_text, claims: [{text, evidence_id}] }
create or replace function public.growth_outbound_draft_check(p_prospect uuid, p jsonb)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_seq int;
  v_chk jsonb;
  v_due text;
begin
  perform growth_outbound.require_owner();
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'not_an_object'); end if;
  if exists (select 1 from jsonb_object_keys(p) k where k not in ('sequence_number', 'subject', 'body_text', 'claims')) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_field');
  end if;
  v_seq := case when coalesce(p->>'sequence_number', '1') ~ '^[1-3]$' then coalesce(p->>'sequence_number', '1')::int end;
  if v_seq is null then return jsonb_build_object('ok', false, 'reason', 'invalid_sequence'); end if;
  if jsonb_typeof(p->'subject') is distinct from 'string' or jsonb_typeof(p->'body_text') is distinct from 'string' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_content', 'detail', 'a subject and a body, as text');
  end if;
  if p ? 'claims' and (jsonb_typeof(p->'claims') <> 'array' or jsonb_array_length(p->'claims') > 5) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_claims', 'detail', 'claims: a list of at most 5');
  end if;
  if not exists (select 1 from growth_outbound.prospects where id = p_prospect) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_chk := growth_outbound.engine_draft_problems(p_prospect, v_seq, p->>'subject', p->>'body_text', coalesce(p->'claims', '[]'::jsonb));
  if v_chk ? 'reason' then
    return jsonb_build_object('ok', false, 'reason', v_chk->>'reason', 'detail', v_chk->>'detail');
  end if;
  v_due := growth_outbound.step_due_problem(p_prospect, v_seq);
  return jsonb_build_object('ok', true, 'passes', jsonb_array_length(v_chk->'problems') = 0,
    'problems', v_chk->'problems', 'words', v_chk->'words', 'due', v_due is null, 'due_problem', v_due,
    'lint', to_jsonb(growth_outbound.draft_lint(v_chk->>'subject', v_chk->>'body')));
end $$;

-- GAVE UP: for this step the engine wrote nothing the database accepts (both
-- of Claude's tries and the template were refused). On the record, with the
-- reasons, so the owner sees it and the due list leaves the step alone for a
-- week (new evidence, or the owner asking, brings it back).
create or replace function public.growth_outbound_draft_gave_up(p_run bigint, p_prospect uuid, p_sequence int, p_reasons jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare r growth_outbound.research_runs;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind <> 'draft' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if not exists (select 1 from growth_outbound.prospects where id = p_prospect) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_sequence is null or p_sequence not between 1 and 3 then return jsonb_build_object('ok', false, 'reason', 'invalid_sequence'); end if;
  perform growth_outbound.log('draft_gave_up', p_prospect, 'prospect', p_prospect::text,
    jsonb_build_object('sequence', p_sequence, 'run', p_run, 'reasons', coalesce((
      select jsonb_agg(left(y.x, 300)) from (
        select x from jsonb_array_elements_text(case when jsonb_typeof(p_reasons) = 'array' then p_reasons else '[]'::jsonb end) x limit 10) y),
      '[]'::jsonb)));
  return jsonb_build_object('ok', true);
end $$;

-- THE DRAFTING DESK: who is due a draft, today's writing budget, how each
-- writer's drafts fare, the recent drafting runs and the cadence.
create or replace function public.growth_outbound_drafting_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_engine();
  return (
    with due as (select x.prospect_id, x.sequence_number, x.n from growth_outbound.drafting_due() with ordinality x(prospect_id, sequence_number, n))
    select jsonb_build_object(
      'llm_budget', growth_outbound.research_budget()->'llm',
      'due_counts', jsonb_build_object('first', (select count(*) from due where sequence_number = 1),
                                       'followup', (select count(*) from due where sequence_number = 2),
                                       'final', (select count(*) from due where sequence_number = 3)),
      'due', coalesce((select jsonb_agg(jsonb_build_object('prospect_id', d.prospect_id, 'sequence_number', d.sequence_number,
                         'full_name', p.full_name, 'organization', p.organization, 'fit_score', p.fit_score) order by d.n)
                         from (select * from due order by n limit 50) d join growth_outbound.prospects p on p.id = d.prospect_id), '[]'::jsonb),
      'stats', growth_outbound.drafting_stats(),
      'lessons', growth_outbound.engine_lessons(),
      'cadence', (select jsonb_build_object('followup_enabled', s.followup_enabled, 'followup_delay_days', s.followup_delay_days,
                    'final_followup_enabled', s.final_followup_enabled, 'final_followup_delay_days', s.final_followup_delay_days)
                    from growth_outbound.settings s where s.id = 1),
      'runs', coalesce((select jsonb_agg(to_jsonb(r) - 'requested_by' - 'ticket_sha256' order by r.started_at desc) from (
          select * from growth_outbound.research_runs where kind = 'draft' order by started_at desc limit 10) r), '[]'::jsonb)));
end $$;

-- ── the morning run (Phase 9): software may find, research and draft on a
--    schedule; it never approves or sends ────────────────────────────────────
--
--   pg_cron calls growth_outbound.schedule_tick() every few minutes
--   (supabase/growth_outbound_cron.sql). Each tick asks schedule_plan() for
--   the ONE next step of today's morning run, and, if there is one, starts a
--   run for it with a single-use ticket and asks the engine (the research or
--   drafting Edge Function) to do it, through pg_net. The engine presents the
--   ticket to growth_outbound_scheduled, the only door a ticket opens, and
--   that door lets it reach only the engine doors that run's kind needs.
--   No credential is stored anywhere: the ticket exists only in that one
--   request, its hash here, for 15 minutes, while the run is running and
--   automation is on.

-- WHAT THE MORNING RUN DOES NEXT, in the owner's time zone (one step a tick):
--   1  search the saved searches, once a day;
--   2  ask the verifier about addresses found but not yet verified (Phase 12:
--      from Clay, Apollo, or a day the verifier budget ran out), five a step;
--   3  research the next new candidate, until daily_qualified_target new
--      subscriber prospects qualified today (Phase 12), at most
--      daily_prospect_target reads a day;
--   4  draft for whoever is due, a few at a time, up to today's live cap a
--      day (more drafts than can be sent would only wait).
-- It stops for the day after three scheduled runs in a row fail, or after 60
-- runs, and never starts while a scheduled run is still going.
create or replace function growth_outbound.schedule_plan(p_now timestamptz default now())
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  v_local timestamp;
  v_day_start timestamptz;
  v_hour int;
  v_in boolean;
  v_runs int;
  v_disc int;
  v_res int;
  v_drafted int;
  v_new int;
  v_due int;
  v_step jsonb;
  v_reason text;
  v_today jsonb;
  v_qualified int;
  v_verify int;
  v_cap int;
begin
  select * into s from growth_outbound.settings where id = 1;
  v_local := p_now at time zone s.automation_timezone;
  v_hour := extract(hour from v_local)::int;
  v_in := ((v_hour - s.automation_start_hour + 24) % 24) < s.automation_hours;
  v_day_start := date_trunc('day', v_local) at time zone s.automation_timezone;
  select count(*), count(*) filter (where kind = 'discover'), count(*) filter (where kind = 'research' and not (input ? 'verify'))
    into v_runs, v_disc, v_res
    from growth_outbound.research_runs where started_by = 'schedule' and started_at >= v_day_start;
  -- new potential subscribers who cleared every gate today (Phase 12)
  select count(*) into v_qualified from growth_outbound.prospects p
   where not p.is_test and p.campaign_type = 'customer' and p.first_qualified_at >= v_day_start;
  select count(*) into v_verify from growth_outbound.verify_queue(50);
  if coalesce((growth_outbound.research_budget()->'email_verifier'->>'left')::int, 0) = 0 then v_verify := 0; end if;
  v_cap := (growth_outbound.live_send_cap()->>'cap')::int;
  select count(*) into v_drafted from growth_outbound.drafts d join growth_outbound.research_runs r on r.id = d.run_id
   where r.started_by = 'schedule' and r.started_at >= v_day_start;
  select count(*) into v_new from growth_outbound.candidates where status = 'new';
  select count(*) into v_due from growth_outbound.drafting_due();
  v_today := jsonb_build_object('day', v_local::date, 'runs', v_runs, 'searched', v_disc > 0, 'researched', v_res,
    'research_target', s.daily_prospect_target, 'drafted', v_drafted, 'draft_cap', v_cap,
    'qualified', v_qualified, 'qualified_target', s.daily_qualified_target, 'verify_waiting', v_verify,
    'new_candidates', v_new, 'due', v_due);

  if not s.automation_enabled then
    v_reason := 'automation is off';
  elsif not v_in then
    v_reason := format('outside the morning window (%s:00, %s hours, %s)', s.automation_start_hour, s.automation_hours, s.automation_timezone);
  elsif exists (select 1 from growth_outbound.research_runs where started_by = 'schedule' and status = 'running') then
    v_reason := 'a scheduled run is still going';
  elsif (select count(*) from growth_outbound.research_runs where status = 'running') >= 3 then
    v_reason := 'three runs are already going';
  elsif v_runs >= 60 then
    v_reason := 'the day''s limit of 60 scheduled runs is reached';
  elsif (select count(*) = 3 and bool_and(x.status = 'failed') from (
           select status from growth_outbound.research_runs
            where started_by = 'schedule' and started_at >= v_day_start and status <> 'running'
            order by id desc limit 3) x) then
    v_reason := 'the last three scheduled runs failed, so nothing more today (see Activity)';
  -- (Phase 13) discovery has more than one source: the saved searches (Brave,
  -- Podcast Index, Apollo), and the directories the owner chose (re-read
  -- weekly). Either is reason enough for the day's one discovery step.
  elsif v_disc = 0
        and ((jsonb_typeof(s.discovery_config->'queries') = 'array' and jsonb_array_length(s.discovery_config->'queries') > 0)
          or (jsonb_typeof(s.discovery_config->'directories') = 'array' and jsonb_array_length(s.discovery_config->'directories') > 0)) then
    v_step := jsonb_build_object('kind', 'discover', 'fn', 'growth_outbound_research', 'input', jsonb_build_object('saved', true));
  elsif v_verify > 0
        and not exists (select 1 from growth_outbound.research_runs r
                         where r.started_by = 'schedule' and r.kind = 'research' and r.input ? 'verify'
                           and r.started_at > p_now - interval '20 minutes') then
    v_step := jsonb_build_object('kind', 'research', 'fn', 'growth_outbound_research', 'input', jsonb_build_object('verify', 5));
  elsif v_res < s.daily_prospect_target and v_new > 0 and v_qualified < s.daily_qualified_target then
    v_step := jsonb_build_object('kind', 'research', 'fn', 'growth_outbound_research', 'input', jsonb_build_object('next', true));
  elsif v_drafted < v_cap and v_due > 0
        and not exists (select 1 from growth_outbound.research_runs r
                         where r.started_by = 'schedule' and r.kind = 'draft' and r.started_at > p_now - interval '30 minutes'
                           and coalesce((r.counts->>'drafted')::int, 0) = 0) then
    v_step := jsonb_build_object('kind', 'draft', 'fn', 'growth_outbound_draft',
      'input', jsonb_build_object('next', least(3, v_cap - v_drafted)));
  else
    v_reason := 'nothing left to do this morning';
  end if;
  return jsonb_build_object('step', v_step, 'reason', v_reason, 'local_time', to_char(v_local, 'YYYY-MM-DD HH24:MI'),
    'timezone', s.automation_timezone, 'in_window', v_in, 'today', v_today);
end $$;

-- WHY pg_net CANNOT POST FROM HERE (NULL: it can): the functions address
-- must be a Supabase project's, and pg_net must be installed.
create or replace function growth_outbound.post_blocker(p_base text)
returns text language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select case
    when coalesce(p_base, '') !~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1$'
      then 'the functions address is not a Supabase project''s (https://<project>.supabase.co/functions/v1/)'
    when to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
      then 'pg_net is not installed (Database → Extensions)'
  end;
$$;

-- ONE TICK (pg_cron, every few minutes; never through the API). Marks runs
-- that never finished as failed, asks the plan, and for a step: starts the
-- run with a fresh single-use ticket and posts it to the engine through
-- pg_net (sent once this transaction commits). Says what it decided in the
-- scheduler's record either way.
create or replace function growth_outbound.schedule_tick(p_functions_base text, p_now timestamptz default now())
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_plan jsonb;
  v_step jsonb;
  v_ticket text;
  v_run bigint;
  v_base text := rtrim(btrim(coalesce(p_functions_base, '')), '/');
  v_why text;
  v_gone record;
  v_digest jsonb;
begin
  if growth_outbound.api_origin() then
    raise exception 'the scheduler runs inside the database (pg_cron) only' using errcode = 'insufficient_privilege';
  end if;
  -- one tick at a time (Phase 11): two ticks that overlap must not both see
  -- "nothing running" and start a step each
  perform pg_advisory_xact_lock(hashtext('growth_outbound.tick'));
  update growth_outbound.research_runs set status = 'failed', finished_at = now(), error = 'never finished (the function stopped)'
   where status = 'running' and started_at < now() - interval '30 minutes';
  -- a send handed over and never confirmed for 23 hours is marked failed, as
  -- the send door would on a retry: never sent twice to find out (Phase 11)
  for v_gone in
    update growth_outbound.sends
       set delivery_status = 'failed', failed_at = now(),
           failure_reason = 'the first attempt''s outcome is unknown and too old to retry safely: never sent twice'
     where delivery_status = 'claimed' and resend_message_id is null and claimed_at < now() - interval '23 hours'
    returning id, prospect_id, claimed_at
  loop
    perform growth_outbound.log_as('system', 'send_abandoned', v_gone.prospect_id, 'send', v_gone.id::text,
      jsonb_build_object('claimed_at', v_gone.claimed_at, 'by', 'the scheduler'));
  end loop;
  -- a daily email whose ticket went out half an hour ago and never came back
  -- (growth_outbound.digest_sweep): failed, and tried again only if it was
  -- surely never written
  perform growth_outbound.digest_sweep();
  -- RESULTS (Phase 10), hourly, whether or not the morning run is on: who
  -- visited, signed up, started a trial or paid; a signup ends its sequence.
  -- A failure here is recorded and never stops the tick.
  if coalesce((select conversions_synced_at from growth_outbound.scheduler where id = 1), '-infinity'::timestamptz)
     < now() - interval '1 hour' then
    begin
      perform growth_outbound.sync_conversions();
    exception when others then
      update growth_outbound.scheduler set conversions_synced_at = now(), conversions_error = left(sqlerrm, 500) where id = 1;
    end;
  end if;
  v_plan := growth_outbound.schedule_plan(p_now);
  v_step := v_plan->'step';
  if v_step is null or jsonb_typeof(v_step) <> 'object' then
    -- nothing for the morning run to do: the moment for the owner's daily
    -- email (section 13). Its trouble is recorded, and never stops the tick.
    begin
      v_digest := growth_outbound.digest_tick(v_base, p_now);
    exception when others then
      v_digest := jsonb_build_object('action', 'error', 'reason', left(sqlerrm, 300));
    end;
    update growth_outbound.scheduler set last_tick_at = now(), last_action = 'idle', last_reason = left(v_plan->>'reason', 500), ticks = ticks + 1 where id = 1;
    return jsonb_build_object('action', 'idle', 'reason', v_plan->>'reason')
      || case when v_digest is null then '{}'::jsonb else jsonb_build_object('digest', v_digest) end;
  end if;
  v_why := growth_outbound.post_blocker(v_base);
  if v_why is not null then
    update growth_outbound.scheduler set last_tick_at = now(), last_action = 'blocked', last_reason = v_why, ticks = ticks + 1 where id = 1;
    return jsonb_build_object('action', 'blocked', 'reason', v_why);
  end if;
  -- 256 random bits; only its hash is kept
  v_ticket := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into growth_outbound.research_runs (kind, started_by, requested_by, input, ticket_sha256, ticket_expires_at)
  values (v_step->>'kind', 'schedule', null, (v_step->'input') || jsonb_build_object('scheduled', true),
          encode(sha256(convert_to(v_ticket, 'UTF8')), 'hex'), now() + interval '15 minutes')
  returning id into v_run;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    using v_base || '/' || (v_step->>'fn'), jsonb_build_object('action', 'scheduled', 'ticket', v_ticket),
          jsonb_build_object('content-type', 'application/json'), 150000;
  update growth_outbound.scheduler set last_tick_at = now(), last_action = 'started', last_run_id = v_run,
         last_reason = left((v_step->>'kind') || ' (run ' || v_run || ')', 500), ticks = ticks + 1 where id = 1;
  perform growth_outbound.log('schedule_started', null, 'research_run', v_run::text,
    jsonb_build_object('kind', v_step->>'kind', 'input', v_step->'input', 'today', v_plan->'today'));
  return jsonb_build_object('action', 'started', 'run_id', v_run, 'kind', v_step->>'kind');
end $$;

-- THE THIRD PUBLIC DOOR: the scheduled engine's. Its FIRST statement checks
-- a ticket the database itself minted for one scheduled run. Without a live
-- one: refused, nothing read or written. With one: only the doors that
-- run's kind needs, and only for that run — never one that approves, edits,
-- rejects, sends, suppresses or changes settings (those check the signed-in
-- owner, and a ticket is nobody). A ticket that is not a run's may be the
-- daily email's (section 13): its own door checks it first and opens its own
-- two doors, and no others.
create or replace function public.growth_outbound_scheduled(p_ticket text, p_door text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run bigint;
  r growth_outbound.research_runs;
  a jsonb := coalesce(p_args, '{}'::jsonb);
  v_allowed text[];
  v jsonb;
begin
  v_run := growth_outbound.ticket_run(p_ticket);
  if v_run is null then return growth_outbound.digest_door(p_ticket, p_door, p_args); end if;
  select * into r from growth_outbound.research_runs where id = v_run;
  -- (Phase 13) every kind may record what its providers said and cost
  v_allowed := array['plan', 'growth_outbound_research_spend', 'growth_outbound_research_finish',
                     'growth_outbound_provider_health_record', 'growth_outbound_provider_record']
    || case r.kind
         when 'discover' then array['growth_outbound_candidates_record', 'growth_outbound_page_record',
                                    'growth_outbound_cache_get', 'growth_outbound_cache_put']
         when 'research' then array['growth_outbound_candidates', 'growth_outbound_candidate', 'growth_outbound_candidate_set',
                                    'growth_outbound_page_record', 'growth_outbound_research_ingest', 'growth_outbound_fit_catalog',
                                    'growth_outbound_verify_queue', 'growth_outbound_enrichment_queue', 'growth_outbound_enrichment_mark',
                                    'growth_outbound_cache_get', 'growth_outbound_cache_put']
         when 'draft' then array['growth_outbound_drafting_overview', 'growth_outbound_draft_context',
                                 'growth_outbound_draft_propose', 'growth_outbound_draft_gave_up']
         else '{}'::text[] end;
  if coalesce(p_door, '') <> all (v_allowed) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'detail', 'a scheduled ' || r.kind || ' run may not call that');
  end if;
  if jsonb_typeof(a) <> 'object' or (a ? 'p_run' and (a->>'p_run') is distinct from v_run::text) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'detail', 'a ticket acts for its own run only');
  end if;
  if p_door = 'plan' then
    return jsonb_build_object('ok', true, 'run_id', r.id, 'kind', r.kind, 'input', r.input, 'budget', growth_outbound.research_budget(),
      'queries', coalesce((select x.discovery_config->'queries' from growth_outbound.settings x where x.id = 1), '[]'::jsonb),
      'directories', growth_outbound.directories_due(),
      'health', growth_outbound.provider_health_json(),
      'partner_outreach', (select x.partner_outreach_enabled from growth_outbound.settings x where x.id = 1),
      'providers', coalesce((select x.discovery_config->'providers' from growth_outbound.settings x where x.id = 1), '{}'::jsonb),
      'shared_sites', to_jsonb(growth_outbound.builtin_shared_sites())
                      || coalesce((select x.discovery_config->'shared_sites' from growth_outbound.settings x where x.id = 1), '[]'::jsonb));
  end if;
  perform set_config('growth_outbound.ticket', p_ticket, true);
  v := case p_door
    when 'growth_outbound_research_spend' then
      public.growth_outbound_research_spend(v_run, a->>'p_provider', coalesce((a->>'p_n')::int, 1))
    when 'growth_outbound_research_finish' then
      public.growth_outbound_research_finish(v_run, a->>'p_status', coalesce(a->'p_counts', '{}'::jsonb), a->>'p_error')
    when 'growth_outbound_candidates_record' then
      public.growth_outbound_candidates_record(v_run, a->'p_items')
    when 'growth_outbound_candidates' then
      public.growth_outbound_candidates(coalesce(a->>'p_status', 'new'), coalesce((a->>'p_limit')::int, 50))
    when 'growth_outbound_candidate' then
      public.growth_outbound_candidate((a->>'p_id')::bigint)
    when 'growth_outbound_candidate_set' then
      public.growth_outbound_candidate_set((a->>'p_id')::bigint, a->>'p_status', a->>'p_reason')
    when 'growth_outbound_page_record' then
      public.growth_outbound_page_record(v_run, a->'p')
    when 'growth_outbound_research_ingest' then
      public.growth_outbound_research_ingest(v_run, (a->>'p_candidate')::bigint, (a->>'p_prospect')::uuid, a->>'p_collector', a->'p')
    when 'growth_outbound_fit_catalog' then
      public.growth_outbound_fit_catalog()
    when 'growth_outbound_verify_queue' then
      public.growth_outbound_verify_queue(coalesce((a->>'p_limit')::int, 5))
    when 'growth_outbound_enrichment_queue' then
      public.growth_outbound_enrichment_queue(coalesce((a->>'p_limit')::int, 25))
    when 'growth_outbound_enrichment_mark' then
      public.growth_outbound_enrichment_mark(v_run, a->>'p_provider', a->'p_prospects')
    when 'growth_outbound_drafting_overview' then
      public.growth_outbound_drafting_overview()
    when 'growth_outbound_draft_context' then
      public.growth_outbound_draft_context((a->>'p_prospect')::uuid, coalesce((a->>'p_sequence')::int, 1))
    when 'growth_outbound_draft_propose' then
      public.growth_outbound_draft_propose(v_run, (a->>'p_prospect')::uuid, a->'p')
    when 'growth_outbound_draft_gave_up' then
      public.growth_outbound_draft_gave_up(v_run, (a->>'p_prospect')::uuid, (a->>'p_sequence')::int, coalesce(a->'p_reasons', '[]'::jsonb))
    when 'growth_outbound_provider_health_record' then
      public.growth_outbound_provider_health_record(v_run, a->'p')
    when 'growth_outbound_provider_record' then
      public.growth_outbound_provider_record(v_run, a->'p_items')
    when 'growth_outbound_cache_get' then
      public.growth_outbound_cache_get(a->>'p_provider', a->>'p_key')
    when 'growth_outbound_cache_put' then
      public.growth_outbound_cache_put(v_run, a->>'p_provider', a->>'p_key', a->'p_value', coalesce((a->>'p_ttl_hours')::int, 24))
  end;
  perform set_config('growth_outbound.ticket', '', true);
  return v;
end $$;

-- THE MORNING RUN, for the console: on or off, the window in the owner's
-- time zone, what it will do next and why, today's progress, whether the
-- scheduler is ticking (and what it needs if not), and the scheduled runs.
create or replace function public.growth_outbound_automation_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  sc growth_outbound.scheduler;
  v_job boolean := null;
begin
  perform growth_outbound.require_owner();
  select * into s from growth_outbound.settings where id = 1;
  select * into sc from growth_outbound.scheduler where id = 1;
  if to_regclass('cron.job') is not null then
    begin
      execute 'select exists (select 1 from cron.job where jobname = ''growth_outbound_tick'' and active)' into v_job;
    exception when others then v_job := null;
    end;
  end if;
  return jsonb_build_object(
    'enabled', s.automation_enabled, 'timezone', s.automation_timezone, 'start_hour', s.automation_start_hour, 'hours', s.automation_hours,
    'plan', growth_outbound.schedule_plan(),
    'scheduler', jsonb_build_object('last_tick_at', sc.last_tick_at, 'last_action', sc.last_action, 'last_reason', sc.last_reason,
                   'last_run_id', sc.last_run_id, 'ticks', sc.ticks,
                   'ticking', sc.last_tick_at is not null and sc.last_tick_at > now() - interval '15 minutes',
                   'results_synced_at', sc.conversions_synced_at, 'results_error', sc.conversions_error),
    'pg_net', to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null,
    'cron_job', v_job,
    'digest', jsonb_build_object('enabled', s.digest_enabled, 'to', case when s.digest_enabled then growth_outbound.digest_recipient() end,
                'plan', growth_outbound.digest_plan(),
                'recent', coalesce((select jsonb_agg(to_jsonb(d) - 'ticket_sha256' - 'ticket_expires_at' - 'recipient_owner' order by d.day desc)
                                      from (select * from growth_outbound.digests order by day desc limit 7) d), '[]'::jsonb)),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) - 'requested_by' - 'ticket_sha256' - 'ticket_expires_at' order by r.started_at desc) from (
        select * from growth_outbound.research_runs where started_by = 'schedule' order by started_at desc limit 15) r), '[]'::jsonb));
end $$;

-- =============================================================================
-- 10. RESULTS (Phase 10): what came of the emails
--
-- The owner reads, for any window: the pipeline (found, drafted, approved,
-- sent), what Resend reported (delivered, bounced, complained; opens and
-- clicks as hints), what people did (replied, opted out, visited, made an
-- account, started a trial, paid), the same broken down by step, writer,
-- prospect type, discovery search and fit, by day, and what each provider
-- was asked for. A difference is called out only when the sample is big
-- enough for it to be more than noise.
-- =============================================================================

-- A one-way key for a visitor or an account: enough to count each once,
-- never the id itself.
create or replace function growth_outbound.account_key(p_kind text, p_id text)
returns text language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to('edgedesk-outbound:' || p_kind || ':' || p_id, 'UTF8')), 'hex');
$$;

-- Whom we wrote to: every real prospect with a live email that went out (and
-- did not bounce or fail), from when, at which addresses, under which
-- campaign code.
create or replace function growth_outbound.contacted(p_prospect uuid default null)
returns table (prospect_id uuid, campaign text, emails text[], first_sent_at timestamptz)
language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p.id, 'ob_' || p.attribution_token, array_agg(distinct x.intended_recipient), min(x.sent_at)
    from growth_outbound.prospects p
    join growth_outbound.sends x on x.prospect_id = p.id
   where not p.is_test and not x.is_test and x.sent_at is not null and x.delivery_status not in ('bounced', 'failed')
     and (p_prospect is null or p.id = p_prospect)
   group by p.id, p.attribution_token;
$$;

-- Trial and first payment of some accounts, from Stripe's own record
-- (supabase/growth.sql). Nothing when that is not installed.
create or replace function growth_outbound.account_stages(p_users uuid[])
returns table (user_id uuid, trial_started_at timestamptz, paid_at timestamptz)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
begin
  if to_regprocedure('public.growth_customer_facts()') is null or coalesce(cardinality(p_users), 0) = 0 then return; end if;
  return query select f.user_id, f.trial_started_at, f.paid_at from public.growth_customer_facts() f where f.user_id = any (p_users);
end $$;

-- THE MATCHER. Records what happened after an email, by its link or its
-- address only (section 4e), each fact once. Someone who made an account
-- ends their sequence: a contacted (or replied) prospect becomes converted,
-- and every unsent follow-up is cancelled. Owners' own accounts and visits
-- never count. Run hourly by the scheduler's tick, whenever the owner opens
-- the results, and for one prospect before any follow-up is sent.
create or replace function growth_outbound.sync_conversions(p_prospect uuid default null)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_matched jsonb := '[]'::jsonb;
  v_users uuid[];
  v_new jsonb := '{}'::jsonb;
  v_add jsonb;
  v_moved int := 0;
  v_cancelled int := 0;
  n int;
  r record;
begin
  perform set_config('growth_outbound.door', 'sync_conversions', true);

  -- VISITS: a visitor whose first or latest touch carried this campaign
  -- code, at or after the first email
  if to_regclass('public.acquisition_visitors') is not null then
    with ins as (
      insert into growth_outbound.conversions (prospect_id, stage, matched_by, account_key, occurred_at)
      select c.prospect_id, 'visited', 'link', growth_outbound.account_key('visitor', v.visitor_hash), t.at
        from growth_outbound.contacted(p_prospect) c
        join public.acquisition_visitors v on v.first_utm_campaign = c.campaign or v.last_utm_campaign = c.campaign
        cross join lateral (select least(
                  case when v.first_utm_campaign = c.campaign and v.first_seen_at >= c.first_sent_at then v.first_seen_at end,
                  case when v.last_utm_campaign = c.campaign and v.last_seen_at >= c.first_sent_at then v.last_seen_at end) as at) t
       where t.at is not null
         and (v.user_id is null or not exists (select 1 from growth_outbound.owners o where o.user_id = v.user_id))
      on conflict (prospect_id, stage, account_key) do nothing
      returning stage)
    select coalesce(jsonb_object_agg(stage, k), '{}'::jsonb) into v_add from (select stage, count(*) k from ins group by stage) z;
    v_new := v_new || v_add;
  end if;

  -- ACCOUNTS made at or after the first email: by the link's campaign code
  -- (the touch that brought the account), else by the address we wrote to
  if to_regclass('public.user_acquisition') is not null then
    select v_matched || coalesce(jsonb_agg(jsonb_build_object('prospect_id', c.prospect_id, 'user_id', u.id, 'matched_by', 'link',
             'created_at', u.created_at, 'first_sent_at', c.first_sent_at, 'pref', 1)), '[]'::jsonb)
      into v_matched
      from growth_outbound.contacted(p_prospect) c
      join public.user_acquisition a on a.first_utm_campaign = c.campaign or a.last_utm_campaign = c.campaign
      join auth.users u on u.id = a.user_id;
  end if;
  select v_matched || coalesce(jsonb_agg(jsonb_build_object('prospect_id', c.prospect_id, 'user_id', u.id, 'matched_by', 'address',
           'created_at', u.created_at, 'first_sent_at', c.first_sent_at, 'pref', 2)), '[]'::jsonb)
    into v_matched
    from growth_outbound.contacted(p_prospect) c
    join auth.users u on lower(btrim(u.email)) = any (c.emails);
  select coalesce(array_agg(distinct m.user_id), '{}') into v_users
    from jsonb_to_recordset(v_matched) m(user_id uuid, created_at timestamptz, first_sent_at timestamptz)
   where m.created_at >= m.first_sent_at;

  if cardinality(v_users) > 0 then
    with m as (
      select distinct on (x.prospect_id, x.user_id) x.*
        from jsonb_to_recordset(v_matched) x(prospect_id uuid, user_id uuid, matched_by text, created_at timestamptz,
                                             first_sent_at timestamptz, pref int)
       where x.created_at >= x.first_sent_at
         and not exists (select 1 from growth_outbound.owners o where o.user_id = x.user_id)
       order by x.prospect_id, x.user_id, x.pref
    ), ins as (
      insert into growth_outbound.conversions (prospect_id, stage, matched_by, account_key, occurred_at)
      -- the account was made after the email (m), so its trial and its payment
      -- are the email's results too; never dated before the account itself
      -- (Stripe keeps whole seconds; the account and the email do not)
      select m.prospect_id, st.stage, m.matched_by, growth_outbound.account_key('account', m.user_id::text), greatest(st.at, m.created_at)
        from m
        left join growth_outbound.account_stages(v_users) f on f.user_id = m.user_id
        cross join lateral (values ('signed_up', m.created_at), ('trial', f.trial_started_at), ('paid', f.paid_at)) st(stage, at)
       where st.at is not null
      on conflict (prospect_id, stage, account_key) do nothing
      returning stage)
    select coalesce(jsonb_object_agg(stage, k), '{}'::jsonb) into v_add from (select stage, count(*) k from ins group by stage) z;
    v_new := v_new || v_add;

    -- (Phase 13) what those accounts have paid, from Stripe's own record:
    -- each paid invoice once, refreshed every time results are matched
    insert into growth_outbound.revenue as rv (prospect_id, account_key, paid_cents, invoices, first_paid_at, last_paid_at)
    select m.prospect_id, growth_outbound.account_key('account', m.user_id::text), a.paid_cents, a.invoices, a.first_paid_at, a.last_paid_at
      from (select distinct x.prospect_id, x.user_id
              from jsonb_to_recordset(v_matched) x(prospect_id uuid, user_id uuid, created_at timestamptz, first_sent_at timestamptz)
             where x.created_at >= x.first_sent_at
               and not exists (select 1 from growth_outbound.owners o where o.user_id = x.user_id)) m
      join growth_outbound.account_paid(v_users, null) a on a.user_id = m.user_id
    on conflict (prospect_id, account_key) do update set paid_cents = excluded.paid_cents, invoices = excluded.invoices,
           first_paid_at = excluded.first_paid_at, last_paid_at = excluded.last_paid_at
     where rv.paid_cents is distinct from excluded.paid_cents or rv.invoices is distinct from excluded.invoices;
  end if;

  -- an account ends the sequence
  for r in
    select p.id, p.status,
           (select c.matched_by from growth_outbound.conversions c
             where c.prospect_id = p.id and c.stage in ('signed_up', 'trial', 'paid') order by c.occurred_at, c.id limit 1) as matched_by
      from growth_outbound.prospects p
     where p.status in ('contacted', 'replied') and not p.is_test
       and (p_prospect is null or p.id = p_prospect)
       and exists (select 1 from growth_outbound.conversions c where c.prospect_id = p.id and c.stage in ('signed_up', 'trial', 'paid'))
  loop
    update growth_outbound.prospects
       set status = 'converted', status_reason = 'made an EdgeDesk account (matched by ' || case when r.matched_by = 'link' then 'their email''s link' else 'the address we wrote to' end || ')'
     where id = r.id and status in ('contacted', 'replied');
    get diagnostics n = row_count;
    if n = 0 then continue; end if;
    v_moved := v_moved + 1;
    n := growth_outbound.cancel_live_drafts(r.id, 'they made an EdgeDesk account');
    v_cancelled := v_cancelled + n;
    perform growth_outbound.log_as('system', 'prospect_converted', r.id, 'prospect', r.id::text,
      jsonb_build_object('from', r.status, 'matched_by', r.matched_by, 'drafts_cancelled', n));
  end loop;

  perform set_config('growth_outbound.door', '', true);
  if p_prospect is null then
    update growth_outbound.scheduler set conversions_synced_at = now(), conversions_error = null where id = 1;
  end if;
  return jsonb_build_object('new', v_new, 'converted', v_moved, 'drafts_cancelled', v_cancelled);
end $$;

-- The results door's cohort, carried as a value (no temporary table inside
-- a security-definer door): one row per prospect first written to in the
-- window, with what they did.
create or replace function growth_outbound.cohort_rows(p jsonb)
returns table (prospect_id uuid, first_sent_at timestamptz, prospect_type text, fit_band text, writer text, query text,
               replied boolean, reply_step int, opted_out boolean, bounced boolean, complained boolean,
               visited boolean, signed_up boolean, signup_step int, trial boolean, paid boolean)
language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select * from jsonb_to_recordset(coalesce(p, '[]'::jsonb)) as x(
    prospect_id uuid, first_sent_at timestamptz, prospect_type text, fit_band text, writer text, query text,
    replied boolean, reply_step int, opted_out boolean, bounced boolean, complained boolean,
    visited boolean, signed_up boolean, signup_step int, trial boolean, paid boolean);
$$;

-- A 95% Wilson interval for k of n: how sure a rate is, from its sample.
create or replace function growth_outbound.wilson(k bigint, n bigint)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(n, 0) <= 0 then null else (
    select jsonb_build_array(round(greatest(0, (c - h) / d)::numeric, 3), round(least(1, (c + h) / d)::numeric, 3))
      from (select (p + z * z / (2 * n)) as c, z * sqrt(p * (1 - p) / n + z * z / (4.0 * n * n)) as h, 1 + z * z / n as d
              from (select k::float8 / n as p, 1.96::float8 as z) a) b) end;
$$;

-- k of n as a rate, 4 places; null when there is nothing to divide
create or replace function growth_outbound.rate(k bigint, n bigint)
returns numeric language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(n, 0) > 0 then round(k::numeric / n, 4) end;
$$;

-- THE RESULTS DOOR. Owner only. Matches first (so what it shows is current),
-- then counts. Every number is an aggregate: no account, no account email,
-- no user id; the only people named are prospects, in the latest results.
create or replace function public.growth_outbound_analytics(p_days int default 90)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_days int := least(greatest(coalesce(p_days, 90), 1), 365);
  v_since timestamptz;
  v_sync jsonb;
  v_err text;
  v_zone text;
  v_min int := 10;
  v_cohort jsonb;
  v_people jsonb;
  v_groups jsonb := '{}'::jsonb;
  v_group jsonb;
  v_signals jsonb := '[]'::jsonb;
  v_dim text;
begin
  perform growth_outbound.require_owner();
  begin
    v_sync := growth_outbound.sync_conversions();
  exception when others then
    v_err := left(sqlerrm, 500);
  end;
  if v_err is not null then
    update growth_outbound.scheduler set conversions_error = v_err where id = 1;
  end if;
  select automation_timezone into v_zone from growth_outbound.settings where id = 1;
  v_since := now() - make_interval(days => v_days);

  -- every prospect first written to in the window, with what they did
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into v_cohort from (
  select p.id as prospect_id, f.first_sent_at, p.prospect_type,
         case when p.fit_score is null then 'no score' when p.fit_score >= 95 then '95–100' when p.fit_score >= 90 then '90–94'
              when p.fit_score >= 85 then '85–89' when p.fit_score >= 80 then '80–84' else 'under 80' end as fit_band,
         coalesce((select case when d.generator_version like 'engine:template:%' then 'template'
                               when d.generator_version like 'engine:%' and d.edited_by_owner then 'engine, edited'
                               when d.generator_version like 'engine:%' then 'engine' else 'owner' end
                     from growth_outbound.sends x join growth_outbound.drafts d on d.id = x.draft_id
                    where x.prospect_id = p.id and not x.is_test and x.sequence_number = 1 limit 1), 'owner') as writer,
         coalesce((select coalesce(c.query, 'found without a search') from growth_outbound.candidates c
                    where c.prospect_id = p.id order by c.first_seen_at, c.id limit 1), 'added by hand') as query,
         rp.at is not null as replied,
         (select max(x.sequence_number) from growth_outbound.sends x
           where x.prospect_id = p.id and not x.is_test and x.sent_at is not null and x.sent_at <= rp.at) as reply_step,
         exists (select 1 from growth_outbound.suppressions s
                  where s.kind in ('unsubscribe', 'replied') and s.created_at >= f.first_sent_at
                    and (s.prospect_id = p.id or (s.scope = 'address' and s.target = any (f.emails)))) as opted_out,
         exists (select 1 from growth_outbound.sends x where x.prospect_id = p.id and not x.is_test and x.bounced_at is not null) as bounced,
         exists (select 1 from growth_outbound.sends x where x.prospect_id = p.id and not x.is_test and x.complained_at is not null) as complained,
         exists (select 1 from growth_outbound.conversions c where c.prospect_id = p.id and c.stage = 'visited') as visited,
         su.at is not null as signed_up,
         (select max(x.sequence_number) from growth_outbound.sends x
           where x.prospect_id = p.id and not x.is_test and x.sent_at is not null and x.sent_at <= su.at) as signup_step,
         exists (select 1 from growth_outbound.conversions c where c.prospect_id = p.id and c.stage = 'trial') as trial,
         exists (select 1 from growth_outbound.conversions c where c.prospect_id = p.id and c.stage = 'paid') as paid
    from (select x.prospect_id, min(x.sent_at) as first_sent_at, array_agg(distinct x.intended_recipient) as emails
            from growth_outbound.sends x
           where not x.is_test and x.sent_at is not null
           group by x.prospect_id) f
    join growth_outbound.prospects p on p.id = f.prospect_id and not p.is_test
    left join lateral (select min(a.at) as at from growth_outbound.activity a
                        where a.prospect_id = p.id and a.action = 'prospect_replied') rp on true
    left join lateral (select min(c.occurred_at) as at from growth_outbound.conversions c
                        where c.prospect_id = p.id and c.stage = 'signed_up') su on true
   where f.first_sent_at >= v_since) z;

  select jsonb_build_object(
    'contacted', count(*), 'replied', count(*) filter (where replied), 'opted_out', count(*) filter (where opted_out),
    'bounced', count(*) filter (where bounced), 'complained', count(*) filter (where complained),
    'visited', count(*) filter (where visited), 'signed_up', count(*) filter (where signed_up),
    'trial', count(*) filter (where trial), 'paid', count(*) filter (where paid))
    into v_people from growth_outbound.cohort_rows(v_cohort);

  -- the same, by each dimension; a group's rates carry their 95% interval
  foreach v_dim in array array['writer', 'prospect_type', 'query', 'fit_band'] loop
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'group', g, 'contacted', n, 'replied', r, 'opted_out', o, 'visited', v, 'signed_up', s, 'trial', t, 'paid', pd,
               'reply_rate', growth_outbound.rate(r, n), 'reply_interval', growth_outbound.wilson(r, n),
               'signup_rate', growth_outbound.rate(s, n), 'signup_interval', growth_outbound.wilson(s, n),
               'enough', n >= $1) order by n desc, g), '[]'::jsonb)
        from (select %I as g, count(*) n, count(*) filter (where replied) r, count(*) filter (where opted_out) o,
                     count(*) filter (where visited) v, count(*) filter (where signed_up) s, count(*) filter (where trial) t,
                     count(*) filter (where paid) pd
                from growth_outbound.cohort_rows($2) group by 1) z$q$, v_dim)
      into v_group using v_min, v_cohort;
    v_groups := v_groups || jsonb_build_object(v_dim, v_group);
  end loop;

  -- a signal: a big-enough group whose whole interval sits above or below
  -- everyone's rate
  select coalesce(jsonb_agg(x order by x->>'dimension', x->>'group', x->>'metric'), '[]'::jsonb) into v_signals
    from (select jsonb_build_object('dimension', d.key, 'group', g->>'group', 'metric', m.metric,
                   'direction', case when (g->m.iv->>0)::numeric > m.overall then 'higher' else 'lower' end,
                   'k', (g->>m.k)::int, 'n', (g->>'contacted')::int, 'rate', (g->>m.rt)::numeric, 'overall', m.overall) as x
            from jsonb_each(v_groups) d
            cross join lateral jsonb_array_elements(d.value) g
            cross join lateral (values
              ('reply', 'replied', 'reply_rate', 'reply_interval',
               growth_outbound.rate((v_people->>'replied')::bigint, (v_people->>'contacted')::bigint)),
              ('signup', 'signed_up', 'signup_rate', 'signup_interval',
               growth_outbound.rate((v_people->>'signed_up')::bigint, (v_people->>'contacted')::bigint))) m(metric, k, rt, iv, overall)
           where (g->>'enough')::boolean and m.overall is not null
             and (select count(*) from jsonb_array_elements(d.value)) > 1
             and ((g->m.iv->>0)::numeric > m.overall or (g->m.iv->>1)::numeric < m.overall)) s;

  return jsonb_build_object('ok', true, 'days', v_days, 'since', v_since, 'min_sample', v_min,
    'attribution_links', (select attribution_links from growth_outbound.settings where id = 1),
    'synced', v_sync, 'sync_error', coalesce(v_err, (select conversions_error from growth_outbound.scheduler where id = 1)),
    'synced_at', (select conversions_synced_at from growth_outbound.scheduler where id = 1),
    'pipeline', jsonb_build_object(
      'found', (select count(*) from growth_outbound.candidates where first_seen_at >= v_since),
      'prospects', (select count(*) from growth_outbound.prospects where not is_test and created_at >= v_since),
      'drafted', (select count(*) from growth_outbound.drafts where not is_test and generated_at >= v_since),
      'approved', (select count(*) from growth_outbound.drafts where not is_test and approved_at >= v_since),
      'rejected', (select count(*) from growth_outbound.drafts where not is_test and rejected_at >= v_since)),
    'sends', (select jsonb_build_object(
      'sent', count(*), 'delivered', count(*) filter (where delivered_at is not null),
      'bounced', count(*) filter (where bounced_at is not null), 'complained', count(*) filter (where complained_at is not null),
      'opened', count(*) filter (where opened_at is not null), 'clicked', count(*) filter (where clicked_at is not null),
      'links_tagged', count(*) filter (where links_tagged),
      'delivery_rate', growth_outbound.rate(count(*) filter (where delivered_at is not null), count(*)),
      'bounce_rate', growth_outbound.rate(count(*) filter (where bounced_at is not null), count(*)),
      'complaint_rate', growth_outbound.rate(count(*) filter (where complained_at is not null), count(*)))
      from growth_outbound.sends where not is_test and sent_at >= v_since),
    'people', v_people || jsonb_build_object(
      'reply_rate', growth_outbound.rate((v_people->>'replied')::bigint, (v_people->>'contacted')::bigint),
      'opt_out_rate', growth_outbound.rate((v_people->>'opted_out')::bigint, (v_people->>'contacted')::bigint),
      'visit_rate', growth_outbound.rate((v_people->>'visited')::bigint, (v_people->>'contacted')::bigint),
      'signup_rate', growth_outbound.rate((v_people->>'signed_up')::bigint, (v_people->>'contacted')::bigint),
      'trial_rate', growth_outbound.rate((v_people->>'trial')::bigint, (v_people->>'contacted')::bigint),
      'paid_rate', growth_outbound.rate((v_people->>'paid')::bigint, (v_people->>'contacted')::bigint)),
    'by_step', coalesce((select jsonb_agg(jsonb_build_object('step', x.seq, 'sent', x.sent, 'delivered', x.delivered, 'bounced', x.bounced,
                 'opened', x.opened, 'clicked', x.clicked,
                 'replies_after', (select count(*) from growth_outbound.cohort_rows(v_cohort) c where c.reply_step = x.seq),
                 'signups_after', (select count(*) from growth_outbound.cohort_rows(v_cohort) c where c.signup_step = x.seq)) order by x.seq)
        from (select sequence_number as seq, count(*) as sent, count(*) filter (where delivered_at is not null) as delivered,
                     count(*) filter (where bounced_at is not null) as bounced, count(*) filter (where opened_at is not null) as opened,
                     count(*) filter (where clicked_at is not null) as clicked
                from growth_outbound.sends where not is_test and sent_at >= v_since group by sequence_number) x), '[]'::jsonb),
    'groups', v_groups,
    'signals', v_signals,
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day,
                'sent', (select count(*) from growth_outbound.sends x where not x.is_test and (x.sent_at at time zone v_zone)::date = d.day),
                'replied', (select count(*) from growth_outbound.activity a join growth_outbound.prospects p on p.id = a.prospect_id and not p.is_test
                             where a.action = 'prospect_replied' and (a.at at time zone v_zone)::date = d.day),
                'visited', (select count(*) from growth_outbound.conversions c where c.stage = 'visited' and (c.occurred_at at time zone v_zone)::date = d.day),
                'signed_up', (select count(*) from growth_outbound.conversions c where c.stage = 'signed_up' and (c.occurred_at at time zone v_zone)::date = d.day))
              order by d.day), '[]'::jsonb)
                from (select generate_series((v_since at time zone v_zone)::date, (now() at time zone v_zone)::date, interval '1 day')::date as day) d),
    'providers', coalesce((select jsonb_object_agg(u.provider, u.calls) from (
        select provider, sum(calls)::bigint as calls from growth_outbound.provider_usage
         where day >= (v_since at time zone 'utc')::date group by provider) u), '{}'::jsonb),
    'latest', coalesce((select jsonb_agg(jsonb_build_object('prospect_id', p.id, 'full_name', p.full_name, 'organization', p.organization,
                 'stage', c.stage, 'matched_by', c.matched_by, 'occurred_at', c.occurred_at) order by c.occurred_at desc, c.id desc)
        from (select * from growth_outbound.conversions order by occurred_at desc, id desc limit 20) c
        join growth_outbound.prospects p on p.id = c.prospect_id), '[]'::jsonb),
    -- (Phase 13) what the people written to have paid (Stripe's paid
    -- invoices, gross: refunds are not in the stored events), for those first
    -- written to in the window, by campaign; and the providers' cost
    'revenue', (select jsonb_build_object(
        'paid_cents', coalesce(sum(r.paid_cents), 0), 'invoices', coalesce(sum(r.invoices), 0),
        'paying_accounts', count(distinct r.account_key),
        'by_campaign', coalesce((select jsonb_object_agg(k, v) from (
            select p2.campaign_type as k, sum(r2.paid_cents) as v from growth_outbound.revenue r2
              join growth_outbound.prospects p2 on p2.id = r2.prospect_id
             where r2.prospect_id in (select (z->>'prospect_id')::uuid from jsonb_array_elements(v_cohort) z)
             group by p2.campaign_type) y), '{}'::jsonb),
        'basis', 'gross paid invoices from Stripe''s record, for accounts matched to an email by its link or the address written to; refunds are not subtracted')
        from growth_outbound.revenue r
       where r.prospect_id in (select (z->>'prospect_id')::uuid from jsonb_array_elements(v_cohort) z)),
    'spend', growth_outbound.spend_json());
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

-- =============================================================================
-- 12. PROVIDERS, QUALIFICATION AND VOLUME (Phase 12)
--
--   Discovery and enrichment providers plug in behind the research engine
--   (Brave and Apollo search; Hunter and Apollo email lookup; Hunter
--   verification; Clay enrichment), each switched on or off in
--   discovery_config.providers. Whatever a provider says arrives as evidence
--   like any other, weighed the same way: an address a provider found is
--   'unverified' until a verifier or the owner confirms it; a title or an
--   employer a provider reports is a directory's word (the lowest weight),
--   never something an email may cite. Clay is enrichment only: it adds to a
--   prospect the engine already found, never creates one.
--
--   (Placed before the System check, which checks it.)
-- =============================================================================

-- WHO IS WAITING FOR A VERIFIER: an address on record that nobody has
-- confirmed — published on a page, or a provider's find ('risky' until
-- checked), never a guessed one — and no verifier has answered about in 30 days.
create or replace function growth_outbound.verify_queue(p_limit int)
returns table (prospect_id uuid, email text) language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p.id, growth_outbound.norm_email(p.email)
    from growth_outbound.prospects p
   where not p.is_test and p.status = 'needs_research' and p.duplicate_of is null
     and p.email is not null and p.email_status in ('unverified', 'risky') and p.email_invalid_at is null
     and exists (select 1 from growth_outbound.evidence e where e.prospect_id = p.id and e.field_name = 'email' and e.superseded_at is null
                   and e.claim_norm = growth_outbound.norm_email(p.email) and e.source_kind <> 'pattern_guess')
     and not growth_outbound.is_suppressed(p.email)
     and not exists (select 1 from growth_outbound.activity a
                      where a.prospect_id = p.id and a.action = 'email_verdict'
                        and a.detail->>'email' = growth_outbound.norm_email(p.email) and a.at > now() - interval '30 days')
   order by p.qualification_score desc nulls last, p.updated_at desc, p.id
   limit least(greatest(coalesce(p_limit, 5), 1), 200);
$$;

-- WHO IS WORTH ENRICHING: a potential subscriber whose only missing piece is
-- a usable address (with a verified one, worth 9 points, they would clear the
-- qualification bar), not handed to an enrichment provider in 14 days.
create or replace function growth_outbound.enrichment_queue(p_limit int)
returns table (prospect_id uuid) language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select p.id
    from growth_outbound.prospects p
    cross join growth_outbound.settings s
   where s.id = 1 and not p.is_test and p.campaign_type = 'customer' and p.status = 'needs_research'
     and p.duplicate_of is null and p.full_name is not null
     and not growth_outbound.is_suppressed(p.email)
     and (p.email is null or p.email_status = 'none'
          -- a guessed address: something better is wanted
          or (p.email_status = 'risky'
              and not exists (select 1 from growth_outbound.evidence e where e.prospect_id = p.id and e.field_name = 'email' and e.superseded_at is null
                                and e.claim_norm = growth_outbound.norm_email(p.email) and e.source_kind <> 'pattern_guess'))
          -- one a verifier answered about and could not confirm
          or (p.email_status in ('unverified', 'risky')
              and exists (select 1 from growth_outbound.activity a where a.prospect_id = p.id and a.action = 'email_verdict'
                            and a.detail->>'email' = growth_outbound.norm_email(p.email))))
     and coalesce(p.qualification_score, 0) + 9 - coalesce((p.qualification->'parts'->'contact'->>'email')::int, 0)
         >= s.min_qualification_score
     and not exists (select 1 from jsonb_array_elements_text(coalesce(p.assessment->'gates', '[]'::jsonb)) g(x)
                      where g.x !~ '^(no email address|email |qualification )')
     and not exists (select 1 from growth_outbound.activity a where a.prospect_id = p.id and a.action = 'enrichment_pushed'
                       and a.at > now() - interval '14 days')
   order by p.qualification_score desc nulls last, p.updated_at desc, p.id
   limit least(greatest(coalesce(p_limit, 25), 1), 200);
$$;

-- What an enrichment provider is given about a prospect: who they are and
-- where they are, nothing else (no score, no evidence, no address of ours).
create or replace function growth_outbound.enrichment_row(p growth_outbound.prospects)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'edgedesk_ref', p.id, 'full_name', p.full_name, 'first_name', p.first_name, 'last_name', p.last_name,
    'organization', p.organization, 'job_title', p.job_title, 'website_url', p.website_url,
    'domain', case when p.website_url is not null then growth_outbound.site_key(growth_outbound.url_host(p.website_url)) end,
    'x_url', p.x_url, 'newsletter_url', p.newsletter_url,
    'linkedin_url', (select 'https://www.linkedin.com/in/' || substr(i.value, 13) from growth_outbound.identifiers i
                      where i.prospect_id = p.id and i.released_at is null and i.kind = 'handle' and i.value like 'linkedin:in:%'
                      order by i.id limit 1)));
$$;

create or replace function public.growth_outbound_verify_queue(p_limit int default 5)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_engine();
  return coalesce((select jsonb_agg(jsonb_build_object('prospect_id', q.prospect_id, 'email', q.email))
                     from growth_outbound.verify_queue(least(greatest(coalesce(p_limit, 5), 1), 25)) q), '[]'::jsonb);
end $$;

create or replace function public.growth_outbound_enrichment_queue(p_limit int default 25)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_engine();
  return coalesce((select jsonb_agg(growth_outbound.enrichment_row(p))
                     from growth_outbound.enrichment_queue(least(greatest(coalesce(p_limit, 25), 1), 100)) q
                     join growth_outbound.prospects p on p.id = q.prospect_id), '[]'::jsonb);
end $$;

-- HANDED TO A PROVIDER: on the record, so nobody is pushed twice in 14 days.
create or replace function public.growth_outbound_enrichment_mark(p_run bigint, p_provider text, p_prospects jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v_id uuid;
  n int := 0;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind not in ('research', 'enrich') then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if coalesce(p_provider, '') not in ('clay') then return jsonb_build_object('ok', false, 'reason', 'invalid_provider'); end if;
  if p_prospects is null or jsonb_typeof(p_prospects) <> 'array' or jsonb_array_length(p_prospects) > 100 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_prospects');
  end if;
  for v_id in select distinct (x #>> '{}')::uuid from jsonb_array_elements(p_prospects) x
               where jsonb_typeof(x) = 'string' and (x #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' loop
    continue when not exists (select 1 from growth_outbound.prospects where id = v_id);
    perform growth_outbound.log('enrichment_pushed', v_id, 'prospect', v_id::text, jsonb_build_object('provider', p_provider, 'run', p_run));
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'marked', n);
end $$;

-- FOR CLAY BY HAND: the enrichment queue as rows for a CSV the owner uploads
-- to a Clay table, marked as handed over. Clay's results come back through
-- growth_outbound_provider_import.
create or replace function public.growth_outbound_enrichment_export(p_limit int default 25)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_run bigint;
  v_rows jsonb;
begin
  v_owner := growth_outbound.require_owner();
  select coalesce(jsonb_agg(growth_outbound.enrichment_row(p)), '[]'::jsonb) into v_rows
    from growth_outbound.enrichment_queue(least(greatest(coalesce(p_limit, 25), 1), 200)) q
    join growth_outbound.prospects p on p.id = q.prospect_id;
  if jsonb_array_length(v_rows) = 0 then return jsonb_build_object('ok', true, 'rows', v_rows); end if;
  insert into growth_outbound.research_runs (kind, started_by, requested_by, input)
  values ('enrich', 'owner', v_owner, jsonb_build_object('provider', 'clay', 'export', jsonb_array_length(v_rows)))
  returning id into v_run;
  perform public.growth_outbound_enrichment_mark(v_run, 'clay',
    (select jsonb_agg(x->'edgedesk_ref') from jsonb_array_elements(v_rows) x));
  update growth_outbound.research_runs set status = 'done', finished_at = now(),
         counts = jsonb_build_object('exported', jsonb_array_length(v_rows))
   where id = v_run;
  return jsonb_build_object('ok', true, 'run_id', v_run, 'rows', v_rows);
end $$;

-- WHAT CLAY FOUND, BROUGHT BACK (a CSV exported from the Clay table). Each
-- row names a prospect we sent (edgedesk_ref) or one its address or profile
-- already identifies; a row that names nobody we know is left out, never made
-- into a prospect. What it adds, as Clay's word:
--   an email address: found by Clay, 'unverified' until a verifier (the
--     morning run asks) or the owner confirms it; never a role address;
--   their profile and site addresses: who they are (never someone else's);
--   a title and an employer: a directory's word, from the profile page Clay
--     read (the lowest weight; an email never cites it).
--   p_rows: [{ ref, full_name, job_title, organization, email, linkedin_url,
--              x_url, website_url, newsletter_url, source_url }]  (1 to 200)
create or replace function public.growth_outbound_provider_import(p_provider text, p_rows jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_run bigint;
  v jsonb;
  i bigint;
  v_keys text[] := array['ref', 'full_name', 'job_title', 'organization', 'email', 'linkedin_url', 'x_url', 'website_url',
                         'newsletter_url', 'source_url'];
  v_bad text;
  v_target uuid;
  v_matches uuid[];
  v_email text;
  v_urls jsonb;
  v_page text;
  v_ev jsonb;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
  n_ok int := 0;
  n_unmatched int := 0;
  n_refused int := 0;
  k text;
begin
  v_owner := growth_outbound.require_owner();
  if coalesce(p_provider, '') not in ('clay') then return jsonb_build_object('ok', false, 'reason', 'invalid_provider'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_rows', 'detail', '1 to 200 rows');
  end if;
  for v, i in select x, n from jsonb_array_elements(p_rows) with ordinality t(x, n) loop
    if jsonb_typeof(v) <> 'object' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_rows', 'detail', 'row ' || i || ' is not an object');
    end if;
    select string_agg(x, ', ') into v_bad from jsonb_object_keys(v) x where x <> all (v_keys);
    if v_bad is not null then
      return jsonb_build_object('ok', false, 'reason', 'unknown_column', 'detail', 'row ' || i || ': ' || left(v_bad, 120));
    end if;
    select string_agg(k2, ', ') into v_bad from jsonb_each(v) e(k2, x) where jsonb_typeof(x) not in ('string', 'null')
       or length(x #>> '{}') > 500;
    if v_bad is not null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', 'row ' || i || ': ' || left(v_bad, 120));
    end if;
  end loop;

  insert into growth_outbound.research_runs (kind, started_by, requested_by, input)
  values ('enrich', 'owner', v_owner, jsonb_build_object('provider', p_provider, 'import', jsonb_array_length(p_rows)))
  returning id into v_run;

  for v, i in select x, n from jsonb_array_elements(p_rows) with ordinality t(x, n) loop
    -- the address, unless it is a role address, a provider's placeholder, or not one
    v_email := growth_outbound.norm_email(nullif(btrim(coalesce(v->>'email', '')), ''));
    if v_email is not null and (not growth_outbound.valid_email(v_email)
        or v_email ~ '^(no-?reply|do-?not-?reply|abuse|postmaster|hostmaster|webmaster|privacy|legal|dmca|security|unsubscribe|bounces?|mailer-daemon|root|admin|billing|invoices?|careers|jobs|info|hello|contact|support|team|sales|press|media)@'
        or v_email ~ '(not_unlocked|unavailable|placeholder|example\.(com|org)$)') then
      v_email := null;
    end if;
    select coalesce(jsonb_agg(u), '[]'::jsonb) into v_urls
      from (select growth_outbound.canonical_url(v->>c) u from unnest(array['linkedin_url', 'x_url', 'website_url', 'newsletter_url']) c) z
     where u is not null;

    -- who is this? the prospect we sent, or the one their address or profile names
    v_target := null;
    if coalesce(v->>'ref', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from growth_outbound.prospects where id = (v->>'ref')::uuid) then
      v_target := (v->>'ref')::uuid;
    else
      select coalesce(array_agg(distinct i2.prospect_id), '{}'::uuid[]) into v_matches
        from growth_outbound.identifiers i2
       where i2.strength = 'strong' and i2.released_at is null
         and ((i2.kind = 'email' and i2.value = v_email)
           or (i2.kind, i2.value) in (select kk.kind, kk.value from jsonb_array_elements_text(v_urls) u(url),
                                        lateral growth_outbound.url_identity(u.url) kk where kk.strength = 'strong'));
      if cardinality(v_matches) = 1 then v_target := v_matches[1]; end if;
      if cardinality(v_matches) <> 1 then
        n_unmatched := n_unmatched + 1;
        v_out := v_out || jsonb_build_array(jsonb_build_object('row', i, 'ok', false,
          'reason', case when cardinality(v_matches) = 0 then 'unmatched' else 'ambiguous' end,
          'detail', case when cardinality(v_matches) = 0 then 'names no prospect we know (Clay adds to prospects; it does not create them)'
                         else 'its address and profiles name different prospects' end));
        continue;
      end if;
    end if;

    -- what it says, as Clay's word
    v_page := coalesce(growth_outbound.canonical_url(v->>'linkedin_url'), growth_outbound.canonical_url(v->>'source_url'));
    v_ev := '[]'::jsonb;
    if v_email is not null then
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('field_name', 'email', 'claim', v_email, 'source_kind', 'provider_found',
        'source_url', coalesce(growth_outbound.canonical_url(v->>'source_url'), v_page, 'https://www.clay.com/'), 'source_title', 'Clay enrichment'));
    end if;
    if v_page is not null then
      foreach k in array array['full_name', 'job_title', 'organization'] loop
        continue when nullif(btrim(coalesce(v->>k, '')), '') is null;
        continue when k = 'organization' and lower(btrim(v->>k)) ~ '^@?[a-z0-9-]+(\.[a-z0-9-]+)+$';
        v_ev := v_ev || jsonb_build_array(jsonb_build_object('field_name', k, 'claim', btrim(v->>k), 'source_kind', 'directory',
          'source_url', v_page, 'source_title', 'Clay enrichment',
          'source_excerpt', case k when 'full_name' then 'Name' when 'job_title' then 'Title' else 'Company' end || ': ' || btrim(v->>k)));
      end loop;
    end if;
    if jsonb_array_length(v_ev) = 0 and jsonb_array_length(v_urls) = 0 then
      n_refused := n_refused + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object('row', i, 'ok', false, 'reason', 'nothing_usable', 'prospect_id', v_target,
        'detail', 'no usable address, profile or fact'));
      continue;
    end if;
    begin
      v_res := public.growth_outbound_research_ingest(v_run, null, v_target, 'provider:' || p_provider,
        jsonb_strip_nulls(jsonb_build_object('email', v_email, 'urls', v_urls, 'evidence', v_ev)));
    exception when others then
      v_res := jsonb_build_object('ok', false, 'reason', 'refused', 'detail', left(sqlerrm, 200));
    end;
    if coalesce((v_res->>'ok')::boolean, false) then
      n_ok := n_ok + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object('row', i, 'ok', true, 'prospect_id', v_target,
        'status', v_res->>'status', 'evidence', coalesce(jsonb_array_length(v_res->'evidence_ids'), 0), 'left_out', v_res->'dropped'));
    else
      n_refused := n_refused + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object('row', i, 'ok', false, 'prospect_id', v_target,
        'reason', v_res->>'reason', 'detail', left(coalesce(v_res->>'detail', ''), 200)));
    end if;
  end loop;
  update growth_outbound.research_runs set status = 'done', finished_at = now(),
         counts = counts || jsonb_build_object('imported', n_ok, 'unmatched', n_unmatched, 'refused', n_refused)
   where id = v_run;
  perform growth_outbound.log('enrichment_imported', null, 'research_run', v_run::text,
    jsonb_build_object('provider', p_provider, 'imported', n_ok, 'unmatched', n_unmatched, 'refused', n_refused));
  return jsonb_build_object('ok', true, 'run_id', v_run, 'imported', n_ok, 'unmatched', n_unmatched, 'refused', n_refused, 'rows', v_out);
end $$;

-- THE SENDING DOMAIN'S CHECK (SPF, DKIM, DMARC), as the send function found
-- it in DNS. ok: true (all in place), false (one is missing: live sending is
-- blocked until it is fixed and checked again), null (could not tell).
--   p: { domain, ok, spf: {ok, detail}, dkim: {ok, detail}, dmarc: {ok, policy, detail},
--        provider: {ok, detail}, via }
create or replace function public.growth_outbound_domain_auth_record(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  k text;
begin
  perform growth_outbound.require_owner();
  select * into s from growth_outbound.settings where id = 1 for update;
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'not_an_object');
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('domain', 'ok', 'spf', 'dkim', 'dmarc', 'provider', 'via') then
      return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', left(k, 40));
    end if;
  end loop;
  if lower(coalesce(p->>'domain', '')) <> split_part(s.sender_email, '@', 2) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_domain', 'detail', 'the check is of the sending domain, ' || split_part(s.sender_email, '@', 2));
  end if;
  if jsonb_typeof(p->'ok') not in ('boolean', 'null') then return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', 'ok'); end if;
  foreach k in array array['spf', 'dkim', 'dmarc'] loop
    if jsonb_typeof(p->k) is distinct from 'object' or jsonb_typeof(p->k->'ok') not in ('boolean', 'null') then
      return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', k);
    end if;
  end loop;
  -- the verdict cannot claim more than its parts: ok only when all three are
  if (p->>'ok')::boolean is true and not ((p->'spf'->>'ok')::boolean and (p->'dkim'->>'ok')::boolean and (p->'dmarc'->>'ok')::boolean) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', 'ok while a record is missing');
  end if;
  update growth_outbound.settings set domain_auth = p, domain_auth_checked_at = now() where id = 1;
  perform growth_outbound.log('domain_auth_checked', null, 'settings', '1',
    jsonb_build_object('domain', p->>'domain', 'ok', p->'ok', 'spf', p->'spf'->'ok', 'dkim', p->'dkim'->'ok', 'dmarc', p->'dmarc'->'ok'));
  return jsonb_build_object('ok', true, 'domain_auth', p, 'live_send_blockers', to_jsonb(growth_outbound.send_blockers_for(false)));
end $$;

-- WHO SOMEONE IS TO EDGEDESK, by the owner: a potential subscriber, or a
-- partner lead (media, affiliate, business). Moving someone away from
-- 'customer' cancels any subscriber email waiting for them.
create or replace function public.growth_outbound_prospect_set_segment(p_id uuid, p_segment text, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  p growth_outbound.prospects;
  n int := 0;
begin
  perform growth_outbound.require_owner();
  select * into p from growth_outbound.prospects where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(p_segment, '') not in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_segment');
  end if;
  if p.campaign_type = p_segment then return jsonb_build_object('ok', true, 'segment', p_segment, 'unchanged', true); end if;
  update growth_outbound.prospects set campaign_type = p_segment where id = p_id;
  if p_segment <> 'customer' then
    update growth_outbound.drafts set status = 'cancelled'
     where prospect_id = p_id and status in ('pending_review', 'approved') and campaign_type = 'customer';
    get diagnostics n = row_count;
  end if;
  perform growth_outbound.evaluate(p_id);
  perform growth_outbound.log('segment_changed', p_id, 'prospect', p_id::text,
    jsonb_build_object('from', p.campaign_type, 'to', p_segment, 'reason', left(p_reason, 200), 'drafts_cancelled', n));
  return jsonb_build_object('ok', true, 'segment', p_segment, 'drafts_cancelled', n);
end $$;

-- THE QUALIFICATION RULES, as the console shows them.
create or replace function public.growth_outbound_qualification_rules()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return jsonb_build_object(
    'threshold', (select min_qualification_score from growth_outbound.settings where id = 1),
    'parts', jsonb_build_array(
      jsonb_build_object('part', 'relevance', 'max', growth_outbound.qualification_max('relevance'),
        'rule', 'Evidenced reasons that what they do is what EdgeDesk does: NFL or college football, odds and markets, fair pricing, props.'),
      jsonb_build_object('part', 'analytics', 'max', growth_outbound.qualification_max('analytics'),
        'rule', 'Evidenced reasons they do analytics: quantitative work, models, data tools, visualizations, an analytical newsletter.'),
      jsonb_build_object('part', 'purchase', 'max', growth_outbound.qualification_max('purchase'),
        'rule', 'Evidence they would pay for research: they track CLV or their own bets, pay for tools, sell paid research, work independently.'),
      jsonb_build_object('part', 'contact', 'max', growth_outbound.qualification_max('contact'),
        'rule', 'A verified address 9 (published on their own site 5, elsewhere 3); identity at its gate 4 (at 0.70, 2); a site or profile of their own 2.'),
      jsonb_build_object('part', 'personalization', 'max', growth_outbound.qualification_max('personalization'),
        'rule', 'Facts an email may cite, each sure enough by itself: one 5, two 8, three or more 10.'),
      jsonb_build_object('part', 'penalties', 'max', 0,
        'rule', 'Every reason against is subtracted: touting, sportsbook staff, a big media outlet, a sports-industry job without analytics work, inactive, generic.')),
    'catalogue', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label, 'points', c.points, 'category', c.category)
                                            order by c.category, c.points desc, c.code)
                             from growth_outbound.fit_factor_catalog c), '[]'::jsonb));
end $$;

-- PARTNER LEADS: media, affiliate and business prospects, kept apart from the
-- subscriber queue (the engine never pitches them a subscription).
create or replace function public.growth_outbound_partner_leads(p_limit int default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform growth_outbound.require_owner();
  return coalesce((select jsonb_agg(growth_outbound.prospect_card(x) order by x.updated_at desc)
    from (select * from growth_outbound.prospects p
           where not p.is_test and p.campaign_type <> 'customer' and p.status not in ('rejected', 'suppressed')
           order by p.updated_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) x), '[]'::jsonb);
end $$;

-- THE MORNING, at a glance: what was found and qualified since the day began
-- (in the owner's time zone), what waits for review, what may go out today.
create or replace function public.growth_outbound_morning()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  v_day_start timestamptz;
begin
  perform growth_outbound.require_owner();
  select * into s from growth_outbound.settings where id = 1;
  v_day_start := date_trunc('day', now() at time zone s.automation_timezone) at time zone s.automation_timezone;
  return jsonb_build_object(
    'day', (now() at time zone s.automation_timezone)::date, 'timezone', s.automation_timezone,
    'test_mode', s.test_mode, 'automation', s.automation_enabled,
    'qualified_today', (select count(*) from growth_outbound.prospects p where not p.is_test and p.campaign_type = 'customer'
                          and p.first_qualified_at >= v_day_start),
    'qualified_target', s.daily_qualified_target, 'min_qualification_score', s.min_qualification_score,
    'researched_today', (select count(*) from growth_outbound.research_runs r where r.kind = 'research' and not (r.input ? 'verify')
                           and r.started_at >= v_day_start),
    'review', (select count(*) from growth_outbound.drafts d where d.status = 'pending_review' and not d.is_test),
    'approved_unsent', (select count(*) from growth_outbound.drafts d where d.status = 'approved' and not d.is_test),
    'sent_today', (select count(*) from growth_outbound.sends x where not x.is_test and x.claimed_at >= date_trunc('day', now())),
    'live_cap', growth_outbound.live_send_cap(),
    'partner_leads_7d', (select count(*) from growth_outbound.prospects p where not p.is_test and p.campaign_type <> 'customer'
                           and p.status not in ('rejected', 'suppressed') and p.discovered_at >= now() - interval '7 days'),
    'verification_waiting', (select count(*) from growth_outbound.verify_queue(200)),
    'enrichment_waiting', (select count(*) from growth_outbound.enrichment_queue(200)),
    'domain_auth', s.domain_auth, 'domain_auth_checked_at', s.domain_auth_checked_at,
    'providers', coalesce(s.discovery_config->'providers', '{}'::jsonb),
    -- (Phase 13) found today by source, turned away today, provider health and
    -- spend, the opt-out endpoint's last check, and partner outreach
    'found_today', coalesce((select jsonb_object_agg(provider, n) from (
        select c.provider, count(*) n from growth_outbound.candidates c where c.first_seen_at >= v_day_start group by c.provider) x), '{}'::jsonb),
    'candidates_waiting', (select count(*) from growth_outbound.candidates c where c.status = 'new'),
    'rejected_today', (select count(*) from growth_outbound.candidates c
                        where c.status in ('not_a_fit', 'failed') and c.updated_at >= v_day_start),
    'health', growth_outbound.provider_health_json(),
    'spend', growth_outbound.spend_json(),
    'optout_check', s.optout_check, 'optout_checked_at', s.optout_checked_at,
    'partner_outreach', s.partner_outreach_enabled,
    'discovery_sources', jsonb_build_object(
      'saved_searches', coalesce(jsonb_array_length(case when jsonb_typeof(s.discovery_config->'queries') = 'array' then s.discovery_config->'queries' end), 0),
      'directories', coalesce(jsonb_array_length(case when jsonb_typeof(s.discovery_config->'directories') = 'array' then s.discovery_config->'directories' end), 0)));
end $$;

-- =============================================================================
-- 13. THE DAILY EMAIL (2026-10): "N drafts are waiting for your review"
--
-- Once a morning, when the morning run has nothing left to do (or its window
-- has closed), the tick writes the OWNER a short note if drafts wait for
-- review. It is the owner's notice, not outreach:
--   * it goes to one address only: the confirmed address of the owner who
--     turned it on (digest_recipient), looked up when it is written, and
--     never one that is also a prospect's;
--   * it says counts and nothing else: no name, no address, no draft;
--   * it is sent by its own function (growth_outbound_digest) on a single-use
--     ticket that opens two doors (write it; say what became of it) and no
--     others: it cannot reach a draft, a prospect or a send, and it never
--     touches the sends table, the daily cap or the results;
--   * once a morning at most (one row per day), tried again only when it
--     surely did not go, three tries at most, and never after the evening.
-- =============================================================================

-- WHAT TO DO ABOUT THIS MORNING'S EMAIL, now: 'send', 'skip' (the run is
-- done and nothing waits for review) or 'wait', with the reason in words.
create or replace function growth_outbound.digest_plan(p_now timestamptz default now())
returns jsonb language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  v_local timestamp;
  v_open timestamp;
  v_day date;
  v_in boolean;
  v_plan jsonb;
  v_t jsonb;
  d growth_outbound.digests;
  v_waiting int;
  v_reason text;
  v_action text := 'wait';
begin
  select * into s from growth_outbound.settings where id = 1;
  v_local := p_now at time zone s.automation_timezone;
  -- the morning this is about: the window that opened most recently (one that
  -- crosses midnight belongs to the day it opened)
  v_open := date_trunc('day', v_local) + make_interval(hours => s.automation_start_hour);
  if v_open > v_local then v_open := v_open - interval '1 day'; end if;
  v_day := v_open::date;
  v_in := v_local < v_open + make_interval(hours => s.automation_hours);
  select * into d from growth_outbound.digests where day = v_day;
  select count(*) into v_waiting from growth_outbound.drafts where status = 'pending_review' and not is_test;
  if not s.digest_enabled then
    v_reason := 'the daily email is off';
  elsif growth_outbound.digest_recipient() is null then
    v_reason := 'nobody to send it to: the owner who turned it on is no longer an owner or has no confirmed address (turn it off and on again)';
  elsif d.id is not null and not (d.status = 'failed' and d.retryable and d.attempts < 3) then
    v_reason := case d.status when 'sent' then 'this morning''s email went out'
                              when 'skipped' then 'nothing waited for review this morning, so no email'
                              when 'sending' then 'this morning''s email is on its way'
                              else 'this morning''s email could not be sent: ' || coalesce(d.reason, 'no reason recorded') end;
  elsif d.id is not null and d.updated_at > p_now - interval '20 minutes' then
    v_reason := 'this morning''s email failed; it is tried again shortly';
  elsif v_local >= v_open + make_interval(hours => s.automation_hours + 12) then
    v_reason := 'too late for this morning''s email; the next comes after tomorrow''s morning run';
  else
    if v_in then
      -- inside the window: only once the morning run has nothing left to do,
      -- and is not merely pausing before it tries a step again
      v_plan := growth_outbound.schedule_plan(p_now);
      v_t := v_plan->'today';
      if jsonb_typeof(v_plan->'step') = 'object'
         or v_plan->>'reason' in ('a scheduled run is still going', 'three runs are already going') then
        v_reason := 'the morning run is still working';
      elsif v_plan->>'reason' = 'nothing left to do this morning'
            and (coalesce((v_t->>'verify_waiting')::int, 0) > 0
                 or (coalesce((v_t->>'due')::int, 0) > 0 and coalesce((v_t->>'drafted')::int, 0) < coalesce((v_t->>'draft_cap')::int, 0))) then
        v_reason := 'the morning run is pausing before it tries again';
      end if;
    end if;
    if v_reason is null then
      v_action := case when v_waiting > 0 then 'send' else 'skip' end;
      v_reason := case when v_waiting > 0 then 'the morning run is done: ' || v_waiting || ' draft(s) wait for review'
                       else 'the morning run is done and nothing waits for review' end;
    end if;
  end if;
  return jsonb_build_object('action', v_action, 'reason', v_reason, 'day', v_day, 'waiting', v_waiting, 'in_window', v_in,
    'window_opened', to_char(v_open, 'YYYY-MM-DD HH24:MI'), 'timezone', s.automation_timezone);
end $$;

-- A LIVE DAILY-EMAIL TICKET (NULL: none): its hash, its note still being
-- sent, unexpired.
create or replace function growth_outbound.digest_for_ticket(p_ticket text)
returns bigint language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(p_ticket, '') !~ '^[0-9a-f]{64}$' then return null; end if;
  return (select d.id from growth_outbound.digests d
           where d.ticket_sha256 = encode(sha256(convert_to(p_ticket, 'UTF8')), 'hex')
             and d.status = 'sending' and d.ticket_expires_at > now());
end $$;

-- THE DAILY EMAIL'S DOOR, reached only through the ticket door
-- (growth_outbound_scheduled) when a ticket is not a run's. FIRST: its own
-- live ticket, or refused. Then two doors and no others: what today's note
-- to the owner says, and what became of it.
create or replace function growth_outbound.digest_door(p_ticket text, p_door text, p_args jsonb)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_id bigint;
  a jsonb := coalesce(p_args, '{}'::jsonb);
begin
  v_id := growth_outbound.digest_for_ticket(p_ticket);
  if v_id is null then return jsonb_build_object('ok', false, 'reason', 'invalid_ticket'); end if;
  if coalesce(p_door, '') not in ('digest_compose', 'digest_result') then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'detail', 'a daily-email ticket may not call that');
  end if;
  if jsonb_typeof(a) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'detail', 'arguments are an object');
  end if;
  if p_door = 'digest_compose' then return growth_outbound.digest_compose(v_id); end if;
  return growth_outbound.digest_result(v_id, a->>'p_message_id', a->>'p_error', a->'p_retryable' = 'true'::jsonb);
end $$;

-- How a note ended: recorded once, with its reason, in the activity too.
create or replace function growth_outbound.digest_end(p_id bigint, p_status text, p_reason text, p_retryable boolean, p_message_id text default null)
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare d growth_outbound.digests;
begin
  update growth_outbound.digests
     set status = p_status, reason = left(p_reason, 300), retryable = p_status = 'failed' and coalesce(p_retryable, false),
         resend_message_id = p_message_id, sent_at = case when p_status = 'sent' then now() end, updated_at = now()
   where id = p_id
  returning * into d;
  perform growth_outbound.log_as('system', 'digest_' || p_status, null, 'digest', p_id::text,
    jsonb_build_object('day', d.day, 'waiting', d.waiting, 'attempt', d.attempts)
    || case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason', left(p_reason, 300)) end);
end $$;

-- Every tick: a note whose ticket went out half an hour ago and never came
-- back has failed. Tried again only if it was never even written (the
-- function never ran); written and unanswered, it may have gone, so never.
create or replace function growth_outbound.digest_sweep()
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare v record;
begin
  for v in select id, composed_at from growth_outbound.digests
            where status = 'sending' and ticket_expires_at < now() - interval '15 minutes' for update loop
    perform growth_outbound.digest_end(v.id, 'failed',
      case when v.composed_at is null then 'the daily-email function never answered (is growth_outbound_digest deployed?)'
           else 'the daily-email function stopped after writing it: it may have gone out, so it is not sent again' end,
      v.composed_at is null);
  end loop;
end $$;

-- THE TICK'S PART (schedule_tick calls it when the morning run is idle):
-- decide this morning's email once; to send it, mint a single-use ticket
-- and post it to the digest function through pg_net.
create or replace function growth_outbound.digest_tick(p_base text, p_now timestamptz default now())
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  dp jsonb;
  v_day date;
  v_id bigint;
  v_ticket text;
  v_why text;
  v_owner uuid := (select digest_owner from growth_outbound.settings where id = 1);
begin
  if growth_outbound.api_origin() then
    raise exception 'the daily email is started by the scheduler only' using errcode = 'insufficient_privilege';
  end if;
  dp := growth_outbound.digest_plan(p_now);
  v_day := (dp->>'day')::date;
  if dp->>'action' = 'skip' then
    insert into growth_outbound.digests (day, status, reason, waiting, recipient_owner)
    values (v_day, 'skipped', 'nothing waited for review', 0, v_owner)
    on conflict (day) do update set status = 'skipped', reason = excluded.reason, waiting = 0, retryable = false, updated_at = now()
     where growth_outbound.digests.status = 'failed'
    returning id into v_id;
    if v_id is null then return null; end if;
    perform growth_outbound.log_as('system', 'digest_skipped', null, 'digest', v_id::text, jsonb_build_object('day', v_day));
    return jsonb_build_object('action', 'skipped', 'day', v_day);
  end if;
  if dp->>'action' is distinct from 'send' then return null; end if;
  v_why := growth_outbound.post_blocker(p_base);
  if v_why is not null then return jsonb_build_object('action', 'blocked', 'reason', v_why); end if;
  -- 256 random bits; only its hash is kept
  v_ticket := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into growth_outbound.digests (day, status, waiting, recipient_owner, attempts, ticket_sha256, ticket_expires_at)
  values (v_day, 'sending', (dp->>'waiting')::int, v_owner, 1, encode(sha256(convert_to(v_ticket, 'UTF8')), 'hex'), now() + interval '15 minutes')
  on conflict (day) do update set status = 'sending', reason = null, retryable = false, waiting = excluded.waiting,
         recipient_owner = excluded.recipient_owner, attempts = growth_outbound.digests.attempts + 1,
         ticket_sha256 = excluded.ticket_sha256, ticket_expires_at = excluded.ticket_expires_at, composed_at = null, updated_at = now()
   where growth_outbound.digests.status = 'failed' and growth_outbound.digests.retryable and growth_outbound.digests.attempts < 3
  returning id into v_id;
  if v_id is null then return null; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    using p_base || '/growth_outbound_digest', jsonb_build_object('action', 'scheduled', 'ticket', v_ticket),
          jsonb_build_object('content-type', 'application/json'), 30000;
  perform growth_outbound.log_as('system', 'digest_started', null, 'digest', v_id::text,
    jsonb_build_object('day', v_day, 'waiting', (dp->>'waiting')::int));
  return jsonb_build_object('action', 'started', 'digest_id', v_id, 'day', v_day, 'waiting', (dp->>'waiting')::int);
end $$;

-- WRITE THE NOTE (the ticket door's 'digest_compose'; once per ticket). The
-- address is decided here, from the owner's own account, and the content is
-- counts: how many drafts wait (first emails, follow-ups), how many the
-- morning run wrote, approved and unsent, what may still go out today, and
-- what the System check says needs attention — in its own fixed words.
create or replace function growth_outbound.digest_compose(p_id bigint)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare
  d growth_outbound.digests;
  s growth_outbound.settings;
  v_to text;
  v_n int;
  v_first int;
  v_follow int;
  v_new int;
  v_approved int;
  v_cap int;
  v_out int;
  v_replied int;
  v_att text[];
  v_subject text;
  v_text text;
begin
  select * into d from growth_outbound.digests where id = p_id for update;
  if d.id is null or d.status <> 'sending' then return jsonb_build_object('ok', false, 'reason', 'invalid_ticket'); end if;
  if d.composed_at is not null then return jsonb_build_object('ok', false, 'reason', 'already_composed'); end if;
  select * into s from growth_outbound.settings where id = 1;
  if not s.digest_enabled then
    perform growth_outbound.digest_end(p_id, 'failed', 'the daily email was turned off', false);
    return jsonb_build_object('ok', false, 'reason', 'digest_off');
  end if;
  v_to := growth_outbound.digest_recipient();
  if v_to is null then
    perform growth_outbound.digest_end(p_id, 'failed', 'nobody to send it to: the owner who turned it on is no longer an owner or has no confirmed address', false);
    return jsonb_build_object('ok', false, 'reason', 'no_recipient');
  end if;
  -- never to anybody the engine writes to: refused, not guessed about
  if exists (select 1 from growth_outbound.prospects p where not p.is_test and growth_outbound.norm_email(p.email) = v_to) then
    perform growth_outbound.digest_end(p_id, 'failed', 'the owner''s address is also a prospect''s, so the daily email is not sent to it', false);
    return jsonb_build_object('ok', false, 'reason', 'recipient_is_a_prospect');
  end if;
  select count(*), count(*) filter (where sequence_number = 1), count(*) filter (where sequence_number > 1)
    into v_n, v_first, v_follow from growth_outbound.drafts where status = 'pending_review' and not is_test;
  if v_n = 0 then
    perform growth_outbound.digest_end(p_id, 'skipped', 'nothing waited for review by the time it was written', false);
    return jsonb_build_object('ok', false, 'reason', 'nothing_waiting');
  end if;
  select count(*) into v_new from growth_outbound.drafts x join growth_outbound.research_runs r on r.id = x.run_id
   where x.status = 'pending_review' and not x.is_test and r.started_by = 'schedule'
     and r.started_at >= (d.day::timestamp at time zone s.automation_timezone);
  select count(*) into v_approved from growth_outbound.drafts where status = 'approved' and not is_test;
  v_cap := (growth_outbound.live_send_cap()->>'cap')::int;
  select count(*) into v_out from growth_outbound.sends where not is_test and claimed_at >= date_trunc('day', now());
  -- replies Resend received in the last day (2026-10): how many, never who
  select count(distinct prospect_id) into v_replied from growth_outbound.replies
   where kind in ('reply', 'opt_out') and received_at >= now() - interval '24 hours';
  select coalesce(array_agg('- ' || case x->>'code'
           when 'check_failed' then 'A system check fails.'
           when 'complaints' then 'Spam complaints are above 1 in 1,000 live emails.'
           when 'bounces' then 'Bounces are above 4% of live emails.'
           when 'webhook_silent' then 'No events from Resend in two days: bounces are not being recorded.'
           when 'domain_auth_failed' then 'The sending domain''s SPF, DKIM or DMARC check fails.'
           when 'stale_claims' then 'A send was handed over and never confirmed.'
           when 'runs_failing' then 'The last three morning-run steps failed.'
           when 'results_error' then 'Matching results failed.'
           when 'approved_waiting' then 'Approved drafts have waited over three days.'
           when 'blocked' then 'Sending is blocked until the settings are complete.'
           when 'domain_auth_unchecked' then 'The sending domain has not been checked in 30 days.'
           else 'Something else: see System check.' end
           order by (x->>'severity')::int, x->>'code'), '{}')
    into v_att from jsonb_array_elements(growth_outbound.attention()) x
   where (x->>'severity')::int <= 3 and x->>'code' not in ('digest_failed', 'digest_no_recipient', 'clock_stopped');
  v_subject := v_n || case when v_n = 1 then ' outbound draft is' else ' outbound drafts are' end || ' ready for your review';
  v_text := concat_ws(E'\n',
    v_n || case when v_n = 1 then ' draft is' else ' drafts are' end || ' waiting for your review: '
      || v_first || case when v_first = 1 then ' first email' else ' first emails' end || ', '
      || v_follow || case when v_follow = 1 then ' follow-up.' else ' follow-ups.' end,
    case when v_new > 0 then 'The morning run wrote ' || v_new || ' of them on ' || to_char(d.day, 'FMDay, FMMonth FMDD') || '.' end,
    '',
    case when v_approved > 0 then v_approved || ' approved ' || case when v_approved = 1 then 'draft has' else 'drafts have' end || ' not been sent yet.' end,
    case when v_replied > 0 then v_replied || case when v_replied = 1 then ' person' else ' people' end || ' replied in the last day (Outbound, Replies).' end,
    case when s.test_mode then 'Test mode is on: an approved email goes only to your test inbox.'
         else 'Live emails you may still send today: ' || greatest(v_cap - v_out, 0) || ' of ' || v_cap || '.' end,
    case when cardinality(v_att) > 0 then E'\nNeeds your attention (Outbound, System check):\n' || array_to_string(v_att, E'\n') end,
    '',
    'Review them: https://edgedesksports.com/admin/growth/',
    '',
    'Nothing goes to a prospect until you approve it and press Send.',
    'This note goes only to you. Turn it off in Outbound settings, under Morning run.');
  update growth_outbound.digests set composed_at = now(), waiting = v_n, recipient_owner = s.digest_owner, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'kind', 'owner_digest', 'digest_id', p_id, 'day', d.day,
    'idempotency_key', 'edgedesk-outbound-digest-' || p_id || '-' || d.attempts,
    'message', jsonb_build_object('from', 'EdgeDesk outbound <' || s.sender_email || '>', 'to', v_to,
                                  'subject', v_subject, 'text', v_text));
end $$;

-- WHAT BECAME OF IT (the ticket door's 'digest_result'): Resend's id, or why
-- not and whether trying again is safe. The ticket dies with the answer.
create or replace function growth_outbound.digest_result(p_id bigint, p_message_id text, p_error text, p_retryable boolean)
returns jsonb language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
declare d growth_outbound.digests;
begin
  select * into d from growth_outbound.digests where id = p_id for update;
  if d.id is null or d.status <> 'sending' then return jsonb_build_object('ok', false, 'reason', 'invalid_ticket'); end if;
  if d.composed_at is null then return jsonb_build_object('ok', false, 'reason', 'not_composed'); end if;
  if p_message_id is not null then
    if p_message_id !~ '^[A-Za-z0-9_-]{1,100}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_message_id'); end if;
    perform growth_outbound.digest_end(p_id, 'sent', null, false, p_message_id);
    return jsonb_build_object('ok', true, 'status', 'sent');
  end if;
  perform growth_outbound.digest_end(p_id, 'failed',
    coalesce(nullif(btrim(regexp_replace(left(coalesce(p_error, ''), 300), '[[:cntrl:]]+', ' ', 'g')), ''), 'not sent (no reason given)'),
    coalesce(p_retryable, false));
  return jsonb_build_object('ok', true, 'status', 'failed', 'retry', coalesce(p_retryable, false));
end $$;

-- =============================================================================
-- 14. FREE-FIRST DISCOVERY AND OPERATIONAL READINESS (Phase 13)
--
--   Discovery no longer depends on a paid search API. Candidates come from:
--     * the owner's own lists: pasted addresses, a CSV, company domains, or
--       the result addresses of a search the owner ran themselves
--       (growth_outbound_candidates_import; no provider, no key, no cost);
--     * directories the owner chose, re-read weekly (discovery_config.directories);
--     * the free Podcast Index API, for the saved searches (its key is free);
--     * Brave and Apollo, still, when their keys are set and they are on.
--   Every source feeds the one candidate queue: a page seen before is counted
--   once, a known prospect's page is a duplicate, a suppressed domain is never
--   read.
--
--   A provider is CONNECTED only after it answered a live check (or a real
--   call) — a key that is merely set is "not checked yet". What each provider
--   said is kept (provider_health), with its remaining free credit where it
--   reports one; what each call cost is kept by day (provider_ledger).
--
--   Live sending also needs the opt-out endpoint CHECKED at its address and
--   Resend's webhook PROVEN by a signed event (send_blockers_for).
-- =============================================================================

-- 14a. The owner's time zone. An install that still carries the old default
-- (America/New_York), never changed by the owner, moves to America/Chicago
-- once, on the record. A zone the owner chose is never touched.
do $tz$
begin
  if exists (select 1 from growth_outbound.settings where id = 1 and automation_timezone = 'America/New_York')
     and not exists (select 1 from growth_outbound.activity a where a.action = 'settings_changed' and a.detail ? 'automation_timezone')
     and not exists (select 1 from growth_outbound.activity a where a.action = 'timezone_default_moved') then
    update growth_outbound.settings set automation_timezone = 'America/Chicago' where id = 1;
    perform growth_outbound.log_as('system', 'timezone_default_moved', null, 'settings', '1',
      jsonb_build_object('from', 'America/New_York', 'to', 'America/Chicago',
                         'why', 'the owner''s time zone; change it under Outbound settings → Morning run'));
  end if;
end $tz$;

-- 14b. WHAT EACH PROVIDER LAST SAID. One row per provider: the key's state,
-- each endpoint's (an Apollo key can be valid while its people search is not
-- on the plan), the free credit it reports, when it last worked and failed.
create table if not exists growth_outbound.provider_health (
  provider       text primary key,
  state          text not null,
  detail         text,
  endpoints      jsonb not null default '{}'::jsonb,
  quota          jsonb,
  checked_at     timestamptz not null default now(),
  last_ok_at     timestamptz,
  last_error_at  timestamptz
);
do $c$ begin
  alter table growth_outbound.provider_health drop constraint if exists provider_health_shape_ck;
  alter table growth_outbound.provider_health add constraint provider_health_shape_ck check (
        provider in ('anthropic', 'hunter', 'apollo', 'podcastindex', 'brave', 'clay', 'resend')
    and state in ('connected', 'credential_missing', 'unauthorized', 'insufficient_plan', 'quota_exhausted', 'unavailable',
                  'not_checked', 'switched_off')
    and (detail is null or length(detail) <= 500)
    and jsonb_typeof(endpoints) = 'object' and (quota is null or jsonb_typeof(quota) = 'object'));
end $c$;

create or replace function growth_outbound.provider_states()
returns text[] language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select array['connected', 'credential_missing', 'unauthorized', 'insufficient_plan', 'quota_exhausted', 'unavailable',
               'not_checked', 'switched_off'];
$$;

-- What the console and the morning run read: each provider's last word.
-- "fresh" means it was checked in the last 24 hours.
create or replace function growth_outbound.provider_health_json()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_object_agg(h.provider, jsonb_build_object(
           'state', h.state, 'detail', h.detail, 'endpoints', h.endpoints, 'quota', h.quota,
           'checked_at', h.checked_at, 'last_ok_at', h.last_ok_at, 'last_error_at', h.last_error_at,
           'fresh', h.checked_at > now() - interval '24 hours')), '{}'::jsonb)
    from growth_outbound.provider_health h;
$$;

-- RECORD WHAT A PROVIDER SAID (the engine, during a run; or the owner's
-- check). { provider, state, detail?, endpoint?, quota? }. With an endpoint,
-- only that endpoint's state changes (and the key's, if the key was refused).
create or replace function public.growth_outbound_provider_health_record(p_run bigint, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v_provider text;
  v_state text;
  v_endpoint text;
  k text;
begin
  perform growth_outbound.require_engine();
  if p_run is not null then
    select * into r from growth_outbound.research_runs where id = p_run;
    if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  elsif growth_outbound.ticket_run(nullif(current_setting('growth_outbound.ticket', true), '')) is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'detail', 'a ticket acts for its own run only');
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'not_an_object');
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('provider', 'state', 'detail', 'endpoint', 'quota') then
      return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', left(k, 40));
    end if;
  end loop;
  v_provider := p->>'provider';
  v_state := p->>'state';
  v_endpoint := nullif(btrim(coalesce(p->>'endpoint', '')), '');
  if coalesce(v_provider, '') not in ('anthropic', 'hunter', 'apollo', 'podcastindex', 'brave', 'clay', 'resend') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_provider');
  end if;
  if coalesce(v_state, '') <> all (growth_outbound.provider_states()) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_state');
  end if;
  if v_endpoint is not null and v_endpoint !~ '^[a-z0-9_./-]{1,60}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_endpoint');
  end if;
  if p ? 'quota' and jsonb_typeof(p->'quota') not in ('object', 'null') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_quota');
  end if;
  insert into growth_outbound.provider_health as h (provider, state, detail, endpoints, quota, checked_at, last_ok_at, last_error_at)
  values (v_provider,
          case when v_endpoint is null or v_state = 'unauthorized' then v_state
               when v_state in ('connected', 'insufficient_plan', 'quota_exhausted') then 'connected' else 'not_checked' end,
          left(p->>'detail', 500),
          case when v_endpoint is null then '{}'::jsonb else jsonb_build_object(v_endpoint, v_state) end,
          case when jsonb_typeof(p->'quota') = 'object' then p->'quota' end,
          now(),
          case when v_state = 'connected' then now() end,
          case when v_state in ('unauthorized', 'insufficient_plan', 'quota_exhausted', 'unavailable') then now() end)
  on conflict (provider) do update set
    state = case when v_endpoint is null or v_state = 'unauthorized' then v_state
                 -- an endpoint that answered proves the key works (a plan or
                 -- allowance refusal is an answer to a key the provider knows)
                 when v_state = 'connected' then 'connected'
                 when v_state in ('insufficient_plan', 'quota_exhausted') and h.state in ('not_checked', 'credential_missing', 'unavailable', 'unauthorized')
                   then 'connected'
                 else h.state end,
    detail = coalesce(left(p->>'detail', 500), h.detail),
    endpoints = case when v_endpoint is null then h.endpoints else h.endpoints || jsonb_build_object(v_endpoint, v_state) end,
    quota = case when jsonb_typeof(p->'quota') = 'object' then p->'quota' else h.quota end,
    checked_at = now(),
    last_ok_at = case when v_state = 'connected' then now() else h.last_ok_at end,
    last_error_at = case when v_state in ('unauthorized', 'insufficient_plan', 'quota_exhausted', 'unavailable') then now() else h.last_error_at end;
  return jsonb_build_object('ok', true, 'health', growth_outbound.provider_health_json()->v_provider);
end $$;

-- 14c. A SHORT MEMORY OF PROVIDER ANSWERS, so the same question is never paid
-- for twice: a Hunter domain search is kept 30 days, a podcast search a day.
-- Only what the engine needs is kept (an address with its owner's name, a
-- feed's site), and it expires; it is not history and may be cleared.
create table if not exists growth_outbound.provider_cache (
  provider    text not null,
  cache_key   text not null,
  value       jsonb not null,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (provider, cache_key)
);
do $c$ begin
  alter table growth_outbound.provider_cache drop constraint if exists provider_cache_shape_ck;
  alter table growth_outbound.provider_cache add constraint provider_cache_shape_ck check (
        provider in ('hunter_domain_search', 'podcastindex_search', 'apollo_org')
    and length(cache_key) between 1 and 300 and length(value::text) <= 50000 and expires_at > fetched_at);
end $c$;

create or replace function public.growth_outbound_cache_get(p_provider text, p_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare c growth_outbound.provider_cache;
begin
  perform growth_outbound.require_engine();
  select * into c from growth_outbound.provider_cache where provider = p_provider and cache_key = lower(btrim(coalesce(p_key, '')))
     and expires_at > now();
  if not found then return jsonb_build_object('hit', false); end if;
  return jsonb_build_object('hit', true, 'value', c.value, 'fetched_at', c.fetched_at);
end $$;

create or replace function public.growth_outbound_cache_put(p_run bigint, p_provider text, p_key text, p_value jsonb, p_ttl_hours int default 24)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare r growth_outbound.research_runs;
begin
  perform growth_outbound.require_engine();
  select * into r from growth_outbound.research_runs where id = p_run;
  if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  if r.kind = 'draft' then return jsonb_build_object('ok', false, 'reason', 'wrong_run_kind'); end if;
  if coalesce(p_ttl_hours, 0) not between 1 and 720 then return jsonb_build_object('ok', false, 'reason', 'invalid_ttl'); end if;
  if p_value is null then return jsonb_build_object('ok', false, 'reason', 'no_value'); end if;
  delete from growth_outbound.provider_cache where expires_at <= now();
  begin
    insert into growth_outbound.provider_cache (provider, cache_key, value, fetched_at, expires_at)
    values (p_provider, lower(btrim(coalesce(p_key, ''))), p_value, now(), now() + make_interval(hours => p_ttl_hours))
    on conflict (provider, cache_key) do update set value = excluded.value, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at;
  exception when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
  end;
  return jsonb_build_object('ok', true);
end $$;

-- 14d. WHAT EACH PROVIDER CALL COST, by day. Claude's tokens are priced from
-- the model's published rate (model_price); a free-tier provider's calls are
-- counted in its own credits, with no dollar figure invented for them.
create table if not exists growth_outbound.provider_ledger (
  day            date not null,
  provider       text not null,
  operation      text not null,
  calls          int not null default 0,
  units          numeric not null default 0,
  input_tokens   bigint not null default 0,
  output_tokens  bigint not null default 0,
  cost_usd       numeric(14, 6),
  primary key (day, provider, operation)
);
do $c$ begin
  alter table growth_outbound.provider_ledger drop constraint if exists provider_ledger_shape_ck;
  alter table growth_outbound.provider_ledger add constraint provider_ledger_shape_ck check (
        provider in ('anthropic', 'hunter', 'apollo', 'podcastindex', 'brave', 'clay', 'resend', 'web')
    and operation ~ '^[a-z0-9_./-]{1,60}$' and calls >= 0 and units >= 0 and input_tokens >= 0 and output_tokens >= 0
    and (cost_usd is null or cost_usd >= 0));
end $c$;

-- Published list prices, US dollars per million tokens (Claude API,
-- 2026-10): input, output, cache read. Edited here when they change.
create or replace function growth_outbound.model_price(p_model text)
returns jsonb language sql immutable
set search_path = pg_catalog, pg_temp as $$
  select case lower(coalesce(p_model, ''))
    when 'claude-opus-5-5'   then '{"in": 4, "out": 20, "cache_read": 0.2}'::jsonb
    when 'claude-sonnet-5-5' then '{"in": 2, "out": 10, "cache_read": 0.2}'::jsonb
    when 'claude-haiku-5-5'  then '{"in": 0.1, "out": 0.5}'::jsonb
    when 'claude-opus-5'     then '{"in": 5, "out": 25}'::jsonb
    when 'claude-sonnet-5'   then '{"in": 2, "out": 10}'::jsonb
    when 'claude-fable-5-1'  then '{"in": 10, "out": 50, "cache_read": 0.25}'::jsonb
  end;
$$;

-- RECORD CALLS. [{ provider, operation, calls?, units?, input_tokens?,
-- output_tokens?, cache_read_tokens?, cache_write_tokens?, model? }]
create or replace function public.growth_outbound_provider_record(p_run bigint, p_items jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  r growth_outbound.research_runs;
  v jsonb;
  k text;
  v_price jsonb;
  v_in bigint; v_out bigint; v_cr bigint; v_cw bigint;
  v_cost numeric;
  v_calls int;
  v_units numeric;
  n int := 0;
  v_day date := (now() at time zone 'utc')::date;
begin
  perform growth_outbound.require_engine();
  if p_run is not null then
    select * into r from growth_outbound.research_runs where id = p_run;
    if not found or r.status <> 'running' then return jsonb_build_object('ok', false, 'reason', 'run_not_running'); end if;
  elsif growth_outbound.ticket_run(nullif(current_setting('growth_outbound.ticket', true), '')) is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed', 'detail', 'a ticket acts for its own run only');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_items', 'detail', 'a list of at most 20 entries');
  end if;
  for v in select x from jsonb_array_elements(p_items) x loop
    if jsonb_typeof(v) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'invalid_items'); end if;
    for k in select jsonb_object_keys(v) loop
      if k not in ('provider', 'operation', 'calls', 'units', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'model') then
        return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', left(k, 40));
      end if;
    end loop;
    foreach k in array array['calls', 'units', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] loop
      if v ? k and (jsonb_typeof(v->k) <> 'number' or (v->>k) !~ '^[0-9]{1,10}(\.[0-9]{1,4})?$') then
        return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', k);
      end if;
    end loop;
    v_calls := least(coalesce((v->>'calls')::numeric, 1), 1000)::int;
    v_units := least(coalesce((v->>'units')::numeric, v_calls), 1000000);
    v_in := coalesce((v->>'input_tokens')::bigint, 0);
    v_out := coalesce((v->>'output_tokens')::bigint, 0);
    v_cr := coalesce((v->>'cache_read_tokens')::bigint, 0);
    v_cw := coalesce((v->>'cache_write_tokens')::bigint, 0);
    v_cost := null;
    if v->>'provider' = 'anthropic' then
      v_price := growth_outbound.model_price(v->>'model');
      if v_price is not null then
        v_cost := (v_in * (v_price->>'in')::numeric + v_out * (v_price->>'out')::numeric
                   + v_cr * coalesce((v_price->>'cache_read')::numeric, (v_price->>'in')::numeric)
                   + v_cw * (v_price->>'in')::numeric * 1.25) / 1000000;
      end if;
    end if;
    begin
      insert into growth_outbound.provider_ledger as l (day, provider, operation, calls, units, input_tokens, output_tokens, cost_usd)
      values (v_day, v->>'provider', coalesce(v->>'operation', ''), v_calls, v_units, v_in + v_cr + v_cw, v_out, v_cost)
      on conflict (day, provider, operation) do update set
        calls = l.calls + excluded.calls, units = l.units + excluded.units,
        input_tokens = l.input_tokens + excluded.input_tokens, output_tokens = l.output_tokens + excluded.output_tokens,
        cost_usd = case when l.cost_usd is null and excluded.cost_usd is null then null
                        else coalesce(l.cost_usd, 0) + coalesce(excluded.cost_usd, 0) end;
    exception when check_violation or not_null_violation or data_exception then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'detail', sqlerrm);
    end;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'recorded', n);
end $$;

-- What the providers cost: today, the last 7 and 30 days, by provider, and a
-- month at the last 7 days' pace. Dollars only where a price is known.
create or replace function growth_outbound.spend_json()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  with d as (select (now() at time zone 'utc')::date as today),
  p as (
    select l.provider,
           sum(l.calls) filter (where l.day = d.today) as calls_today,
           sum(l.units) filter (where l.day = d.today) as units_today,
           sum(l.cost_usd) filter (where l.day = d.today) as usd_today,
           sum(l.calls) filter (where l.day > d.today - 7) as calls_7d,
           sum(l.units) filter (where l.day > d.today - 7) as units_7d,
           sum(l.cost_usd) filter (where l.day > d.today - 7) as usd_7d,
           sum(l.calls) filter (where l.day > d.today - 30) as calls_30d,
           sum(l.units) filter (where l.day > d.today - 30) as units_30d,
           sum(l.input_tokens) filter (where l.day > d.today - 30) as input_tokens_30d,
           sum(l.output_tokens) filter (where l.day > d.today - 30) as output_tokens_30d,
           sum(l.cost_usd) filter (where l.day > d.today - 30) as usd_30d
      from growth_outbound.provider_ledger l, d
     where l.day > d.today - 30
     group by l.provider)
  select jsonb_build_object(
    'providers', coalesce((select jsonb_object_agg(provider, jsonb_build_object(
        'calls_today', coalesce(calls_today, 0), 'units_today', coalesce(units_today, 0), 'usd_today', round(usd_today, 4),
        'calls_7d', coalesce(calls_7d, 0), 'units_7d', coalesce(units_7d, 0), 'usd_7d', round(usd_7d, 4),
        'calls_30d', coalesce(calls_30d, 0), 'units_30d', coalesce(units_30d, 0), 'usd_30d', round(usd_30d, 4),
        'input_tokens_30d', coalesce(input_tokens_30d, 0), 'output_tokens_30d', coalesce(output_tokens_30d, 0))) from p), '{}'::jsonb),
    'usd_today', (select round(coalesce(sum(usd_today), 0), 4) from p),
    'usd_30d', (select round(coalesce(sum(usd_30d), 0), 4) from p),
    'usd_month_at_7d_pace', (select round(coalesce(sum(usd_7d), 0) * 30 / 7, 2) from p));
$$;

-- 14e. REVENUE FROM AN EMAIL'S CONVERSIONS, where Stripe's own record shows
-- it: the paid invoices of the accounts the matcher traced to an email (by
-- link or address, after the first email). Gross: refunds are not in the
-- stored Stripe events, so none is subtracted, and the console says so.
-- Written only by the matcher; refreshed, never deleted.
create table if not exists growth_outbound.revenue (
  prospect_id    uuid not null references growth_outbound.prospects (id) on delete restrict,
  account_key    text not null,
  paid_cents     bigint not null default 0,
  invoices       int not null default 0,
  first_paid_at  timestamptz,
  last_paid_at   timestamptz,
  refreshed_at   timestamptz not null default now(),
  primary key (prospect_id, account_key)
);
do $c$ begin
  alter table growth_outbound.revenue drop constraint if exists revenue_shape_ck;
  alter table growth_outbound.revenue add constraint revenue_shape_ck check (
    account_key ~ '^[0-9a-f]{64}$' and paid_cents >= 0 and invoices >= 0);
end $c$;
create or replace function growth_outbound.revenue_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp as $$
begin
  if coalesce(current_setting('growth_outbound.door', true), '') <> 'sync_conversions' then
    raise exception 'revenue is recorded only by the matcher (growth_outbound.sync_conversions)'
      using errcode = 'insufficient_privilege';
  end if;
  new.refreshed_at := now();
  return new;
end $$;
drop trigger if exists revenue_guard_t on growth_outbound.revenue;
create trigger revenue_guard_t before insert or update on growth_outbound.revenue
  for each row execute function growth_outbound.revenue_guard();
drop trigger if exists revenue_never_delete_t on growth_outbound.revenue;
create trigger revenue_never_delete_t before delete on growth_outbound.revenue
  for each row execute function growth_outbound.never_delete();

-- Each account's paid invoices, from the Stripe webhook's own ledger (each
-- invoice once, whichever of its two events arrived), after a given moment.
create or replace function growth_outbound.account_paid(p_users uuid[], p_after timestamptz)
returns table (user_id uuid, paid_cents bigint, invoices int, first_paid_at timestamptz, last_paid_at timestamptz)
language plpgsql stable
set search_path = pg_catalog, public, pg_temp as $$
begin
  if to_regclass('public.stripe_events') is null or to_regclass('public.subscriptions') is null
     or to_regprocedure('public.affiliate_stripe_object(jsonb)') is null or coalesce(cardinality(p_users), 0) = 0 then
    return;
  end if;
  return query
    with ev as (
      select coalesce(e.stripe_created, e.created_at) as at, public.affiliate_stripe_object(e.payload) as o,
             e.user_id as uid0, e.customer_id, e.subscription_id
        from public.stripe_events e
       where e.type in ('invoice.payment_succeeded', 'invoice.paid')
    ), ev2 as (
      select ev.at, ev.o, coalesce(ev.uid0,
               (select s.user_id from public.subscriptions s
                 where s.stripe_subscription_id = coalesce(ev.subscription_id, public.affiliate_stripe_id(ev.o -> 'subscription'),
                         public.affiliate_stripe_id(ev.o -> 'parent' -> 'subscription_details' -> 'subscription')) limit 1),
               (select s.user_id from public.subscriptions s
                 where s.stripe_customer_id = coalesce(ev.customer_id, public.affiliate_stripe_id(ev.o -> 'customer')) limit 1)) as uid
        from ev
    ), inv as (
      select distinct on (ev2.uid, ev2.o ->> 'id') ev2.uid, ev2.at, (ev2.o ->> 'amount_paid')::bigint as cents
        from ev2
       where ev2.uid = any (p_users) and coalesce(ev2.o ->> 'id', '') <> ''
         and (ev2.o ->> 'amount_paid') ~ '^[0-9]{1,12}$' and (ev2.o ->> 'amount_paid')::bigint > 0
         and ev2.at >= coalesce(p_after, '-infinity'::timestamptz)
       order by ev2.uid, ev2.o ->> 'id', ev2.at
    )
    select inv.uid, sum(inv.cents)::bigint, count(*)::int, min(inv.at), max(inv.at) from inv group by inv.uid;
end $$;

-- 14f. THE OWNER'S OWN LISTS. Addresses pasted or typed, a CSV's rows,
-- company domains, or the result addresses of a search the owner ran by hand
-- in their own browser (no search API, nothing scraped). Each becomes a
-- candidate through the same recording as any search: canonical, counted
-- once, a known prospect's page a duplicate, a suppressed domain never read.
--   p_source  manual | csv | domains | search_results
--   p_items   [ "https://…" | "example.com" | { url | website | domain, title?, name?, note?, segment? } ]  (≤ 500)
-- X, LinkedIn, Instagram, Facebook, TikTok and Threads are refused (the
-- engine may not read them: add such a person as a prospect, with a fact you
-- checked); so is a search engine's own page.
create or replace function public.growth_outbound_candidates_import(p_source text, p_items jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner uuid;
  v_provider text;
  v jsonb;
  i int;
  v_raw text;
  v_url text;
  v_host text;
  v_seg text;
  v_title text;
  v_note text;
  v_items jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_run bigint;
  v_res jsonb;
  v_tot jsonb := jsonb_build_object('new', 0, 'seen_again', 0, 'duplicates', 0, 'suppressed', 0, 'invalid', 0);
  k text;
  n int;
begin
  v_owner := growth_outbound.require_owner();
  v_provider := case p_source when 'manual' then 'manual' when 'csv' then 'csv_import' when 'domains' then 'domain_list'
                              when 'search_results' then 'pasted_results' end;
  if v_provider is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_source', 'detail', 'manual, csv, domains or search_results');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_items', 'detail', 'a list of 1 to 500 addresses');
  end if;
  for v, i in select x, o::int from jsonb_array_elements(p_items) with ordinality t(x, o) loop
    v_raw := btrim(case jsonb_typeof(v) when 'string' then v #>> '{}'
                                        when 'object' then coalesce(v->>'url', v->>'website', v->>'domain') end);
    v_seg := case when jsonb_typeof(v) = 'object' and coalesce(v->>'segment', '') in ('customer', 'partnership', 'media_partner', 'affiliate', 'business_partner')
                  then v->>'segment' end;
    v_title := case when jsonb_typeof(v) = 'object' then left(nullif(btrim(coalesce(v->>'title', v->>'name', '')), ''), 300) end;
    v_note := case when jsonb_typeof(v) = 'object' then left(nullif(btrim(regexp_replace(coalesce(v->>'note', ''), '\s+', ' ', 'g')), ''), 400) end;
    if jsonb_typeof(v) = 'object' and v ? 'segment' and v_seg is null and coalesce(v->>'segment', '') <> '' then
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('item', i, 'why', 'segment is customer, partnership, media_partner, affiliate or business_partner'));
      continue;
    end if;
    if v_raw is null or v_raw = '' or length(v_raw) > 2000 then
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('item', i, 'why', 'no web address'));
      continue;
    end if;
    -- a bare domain, or a domain and path, is a site
    if v_raw !~* '^https?://' then
      if v_raw ~* '^(www\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,63}(/\S*)?$' then
        v_raw := 'https://' || v_raw;
      else
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('item', i, 'value', left(v_raw, 120), 'why', 'not a web address'));
        continue;
      end if;
    end if;
    v_url := growth_outbound.canonical_url(v_raw);
    v_host := growth_outbound.url_host(v_url);
    if v_url is null or v_host is null then
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('item', i, 'value', left(v_raw, 120), 'why', 'not a web address'));
      continue;
    end if;
    if v_host ~ '(^|\.)(x\.com|twitter\.com|linkedin\.com|instagram\.com|facebook\.com|tiktok\.com|threads\.net|threads\.com)$' then
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('item', i, 'value', left(v_url, 120),
        'why', 'the engine may not read X, LinkedIn, Instagram, Facebook, TikTok or Threads: add this person under Add a prospect, with a fact you checked'));
      continue;
    end if;
    if v_host ~ '(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|search\.brave\.com|yandex\.[a-z]+|baidu\.com)$' then
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('item', i, 'value', left(v_url, 120),
        'why', 'a search engine''s own page: paste the addresses of the results instead'));
      continue;
    end if;
    -- a company domain is its site's home page
    if p_source = 'domains' then v_url := growth_outbound.canonical_url('https://' || v_host || '/'); end if;
    if v_url = any (v_seen) then continue; end if;
    v_seen := array_append(v_seen, v_url);
    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'url', v_url, 'title', v_title,
      'snippet', case when v_note is not null then 'Your note: ' || v_note end,
      'query', left('your list: ' || case p_source when 'manual' then 'added by hand' when 'csv' then 'CSV import'
                                                  when 'domains' then 'company domains' else 'search results you pasted' end, 200),
      'provider', v_provider, 'segment', v_seg)));
  end loop;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_import', 'refused', v_refused);
  end if;

  -- one run, done at once: the import is on the record like any search
  insert into growth_outbound.research_runs (kind, started_by, requested_by, input)
  values ('discover', 'owner', v_owner, jsonb_build_object('source', p_source, 'import', true, 'items', jsonb_array_length(v_items)))
  returning id into v_run;
  n := 0;
  while n < jsonb_array_length(v_items) loop
    v_res := public.growth_outbound_candidates_record(v_run,
      (select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from jsonb_array_elements(v_items) with ordinality t(x, o) where o > n and o <= n + 50));
    if coalesce((v_res->>'ok')::boolean, false) is not true then
      raise exception 'recording the import failed: %', coalesce(v_res->>'reason', '?');
    end if;
    foreach k in array array['new', 'seen_again', 'duplicates', 'suppressed', 'invalid'] loop
      v_tot := v_tot || jsonb_build_object(k, (v_tot->>k)::int + coalesce((v_res->>k)::int, 0));
    end loop;
    n := n + 50;
  end loop;
  perform public.growth_outbound_research_finish(v_run, 'done',
    v_tot || jsonb_build_object('results', jsonb_array_length(v_items), 'refused', jsonb_array_length(v_refused), 'outcome', 'imported'), null);
  return jsonb_build_object('ok', true, 'run_id', v_run, 'source', p_source, 'submitted', jsonb_array_length(p_items),
    'recorded', jsonb_array_length(v_items), 'refused', v_refused) || v_tot;
end $$;

-- 14g. THE DIRECTORIES DUE A READ: the owner's chosen pages not read in the
-- last 7 days (a page is stored each time it is read).
create or replace function growth_outbound.directories_due()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(d order by o), '[]'::jsonb)
    from growth_outbound.settings s
   cross join lateral jsonb_array_elements(case when jsonb_typeof(s.discovery_config->'directories') = 'array'
                                                then s.discovery_config->'directories' else '[]'::jsonb end) with ordinality t(d, o)
   where s.id = 1 and coalesce(d->>'permitted', '') = 'true'
     and not exists (select 1 from growth_outbound.pages pg
                      where pg.url = growth_outbound.canonical_url(d->>'url') and pg.fetched_at > now() - interval '7 days');
$$;

-- 14h. THE OPT-OUT ENDPOINT, CHECKED. The send function asks the endpoint
-- itself (a GET must redirect to the stop page without changing anything; a
-- POST with a token no send carries must answer "not valid", which proves it
-- reaches this database) and records what it found here. When it works and
-- no base is set yet, that address becomes the opt-out base. A failure is
-- recorded too; live sending stays blocked until a check at the current base
-- succeeds.
--   { base, ok, get_status?, redirect_ok?, post_status?, post_ok?, detail? }
create or replace function public.growth_outbound_optout_check_record(p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  s growth_outbound.settings;
  k text;
  v_base text;
  v_ok boolean;
  v_rec jsonb;
begin
  perform growth_outbound.require_owner();
  select * into s from growth_outbound.settings where id = 1 for update;
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'not_an_object');
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('base', 'ok', 'get_status', 'redirect_ok', 'post_status', 'post_ok', 'detail') then
      return jsonb_build_object('ok', false, 'reason', 'unknown_field', 'detail', left(k, 40));
    end if;
  end loop;
  v_base := btrim(coalesce(p->>'base', ''));
  if v_base !~ '^https://[a-z0-9.-]+\.(supabase\.co|edgedesksports\.com)/([a-z0-9_/-]*/)?$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_base', 'detail', 'the functions address, https://<project>.supabase.co/functions/v1/');
  end if;
  if jsonb_typeof(p->'ok') is distinct from 'boolean' then return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', 'ok'); end if;
  v_ok := (p->>'ok')::boolean;
  -- the verdict cannot claim more than its parts
  if v_ok and not (coalesce(p->>'redirect_ok', '') = 'true' and coalesce(p->>'post_ok', '') = 'true') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_value', 'detail', 'ok while a part failed');
  end if;
  v_rec := jsonb_strip_nulls(jsonb_build_object('base', v_base, 'ok', v_ok, 'get_status', p->'get_status', 'redirect_ok', p->'redirect_ok',
             'post_status', p->'post_status', 'post_ok', p->'post_ok', 'detail', left(p->>'detail', 300)));
  update growth_outbound.settings
     set optout_check = v_rec, optout_checked_at = now(),
         unsubscribe_url_base = case when v_ok and unsubscribe_url_base is null then v_base else unsubscribe_url_base end
   where id = 1;
  perform growth_outbound.log('optout_endpoint_checked', null, 'settings', '1', v_rec);
  return jsonb_build_object('ok', true, 'optout_check', v_rec,
    'unsubscribe_url_base', (select unsubscribe_url_base from growth_outbound.settings where id = 1),
    'live_send_blockers', to_jsonb(growth_outbound.send_blockers_for(false)));
end $$;

-- 14i. WHERE CANDIDATES CAME FROM AND WHAT BECAME OF THEM, by source, over
-- the last 30 days: found, waiting, researched, not a fit, failed, made into
-- prospects, and how many of those cleared every gate.
create or replace function growth_outbound.source_stats()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_object_agg(provider, jsonb_build_object(
           'found', found, 'waiting', waiting, 'researched', researched, 'not_a_fit', not_a_fit, 'failed', failed,
           'duplicates', dups, 'prospects', prospects, 'qualified', qualified, 'last_found_at', last_at)), '{}'::jsonb)
    from (select c.provider, count(*) as found,
                 count(*) filter (where c.status = 'new') as waiting,
                 count(*) filter (where c.status = 'researched') as researched,
                 count(*) filter (where c.status = 'not_a_fit') as not_a_fit,
                 count(*) filter (where c.status = 'failed') as failed,
                 count(*) filter (where c.status = 'duplicate') as dups,
                 count(distinct c.prospect_id) filter (where c.status = 'researched') as prospects,
                 count(distinct c.prospect_id) filter (where c.status = 'researched' and p.first_qualified_at is not null) as qualified,
                 max(c.first_seen_at) as last_at
            from growth_outbound.candidates c
            left join growth_outbound.prospects p on p.id = c.prospect_id
           where c.first_seen_at >= now() - interval '30 days'
           group by c.provider) x;
$$;

-- The leads turned away recently, with the reason in words (candidates that
-- were not a fit or could not be read, and prospects the owner rejected).
create or replace function growth_outbound.recent_rejections(p_limit int)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x.at desc), '[]'::jsonb) from (
    select * from (
      select c.updated_at as at, 'candidate' as kind, c.id::text as id, c.url, c.title, c.provider as source, c.status,
             c.status_reason as reason
        from growth_outbound.candidates c where c.status in ('not_a_fit', 'failed', 'dismissed')
      union all
      select p.updated_at, 'prospect', p.id::text, coalesce(p.website_url, p.newsletter_url), p.full_name, p.discovered_via, p.status,
             p.status_reason
        from growth_outbound.prospects p where p.status = 'rejected' and not p.is_test) y
     order by y.at desc limit least(greatest(coalesce(p_limit, 25), 1), 100)) x;
$$;

-- 14j. Row level security and no client privilege on the new tables (the
-- same layers 2 and 3 as every other table).
do $rls14$
declare t text;
begin
  foreach t in array array['provider_health', 'provider_cache', 'provider_ledger', 'revenue'] loop
    execute format('revoke all on table growth_outbound.%I from public, anon, authenticated, service_role', t);
    execute format('alter table growth_outbound.%I enable row level security', t);
    execute format('drop policy if exists deny_clients on growth_outbound.%I', t);
    execute format('create policy deny_clients on growth_outbound.%I as restrictive for all to anon, authenticated using (false) with check (false)', t);
  end loop;
end
$rls14$;
revoke all on all sequences in schema growth_outbound from public, anon, authenticated, service_role;

-- =============================================================================
-- 11. THE SYSTEM CHECK (Phase 11): the report below, as a function, so the
--     owner's console runs the very same checks the SQL editor shows — any
--     time, not only when this file is run — plus what needs attention now.
-- =============================================================================
create or replace function growth_outbound.self_check()
returns table (step int, item text, outcome text)
language sql stable
set search_path = pg_catalog, public, pg_temp as $$
select 1 as step, 'the outbound tables exist' as item,
  case when (select count(*) from pg_tables where schemaname = 'growth_outbound' and tablename in
    ('owners', 'owner_audit', 'settings', 'prospects', 'evidence', 'drafts', 'sends', 'suppressions', 'activity',
     'identifiers', 'fit_factor_catalog', 'secrets', 'provider_events', 'research_runs', 'pages', 'candidates',
     'provider_usage', 'scheduler', 'conversions', 'digests', 'replies', 'provider_health', 'provider_cache', 'provider_ledger', 'revenue')) = 25
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
            or (has_function_privilege('anon', p.oid, 'execute') and p.proname not in ('growth_outbound_webhook', 'growth_outbound_optout', 'growth_outbound_scheduled'))
            or has_function_privilege('service_role', p.oid, 'execute')))
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
     'identifiers_never_delete_t', 'identifiers_guard_t', 'conversions_append_only_t', 'digests_never_delete_t',
     'replies_append_only_t')) = 13
       then 'ok' else 'CHECK THIS' end
union all
select 13, 'settings: test mode ' || (select case when test_mode then 'ON' else 'off' end from growth_outbound.settings where id = 1)
  || ', automation ' || (select case when automation_enabled then 'on' else 'OFF' end from growth_outbound.settings where id = 1)
  || ', daily cap ' || (select max_sends_per_day::text from growth_outbound.settings where id = 1),
  'ok'
union all
select 21, 'live sending also needs: ' || coalesce(nullif(array_to_string(growth_outbound.send_blockers_for(false), ', '), ''), 'nothing'),
  'ok'
union all
select 22, 'sends: ' || (select count(*) from growth_outbound.sends where not is_test)::text || ' live, '
  || (select count(*) from growth_outbound.sends where is_test)::text || ' test; '
  || (select count(*) from growth_outbound.sends where delivery_status = 'claimed' and claimed_at < now() - interval '1 hour')::text
  || ' claimed over an hour ago without an answer',
  case when exists (select 1 from pg_trigger where not tgisinternal and tgname = 'sends_guard_t')
        and exists (select 1 from pg_indexes where schemaname = 'growth_outbound' and indexname in ('sends_draft_uk'))
        and exists (select 1 from pg_indexes where schemaname = 'growth_outbound' and indexname in ('sends_idempotency_uk'))
       then 'ok' else 'CHECK THIS' end
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
select 19, 'drafts are approved only within the content rules (no promised winnings or locks, $49.99/month, a 7-day free trial, EdgeDesk links only)',
  case when cardinality(growth_outbound.draft_lint('Guaranteed lock', 'Win big for $19 with a 14-day free trial: https://evil.test/x')) = 4
        and cardinality(growth_outbound.draft_lint('Your CFB ratings', 'A 7-day free trial, then $49.99/month: https://edgedesksports.com/')) = 0
       then 'ok' else 'CHECK THIS' end
union all
select 20, 'review queue: ' || (select count(*) from growth_outbound.drafts where status = 'pending_review')::text || ' waiting, '
  || (select count(*) from growth_outbound.drafts where status = 'approved')::text || ' approved and not sent',
  'ok'
union all
select 23, 'three public doors and only three: the webhook (needs Resend''s signature), the opt-out (needs a send''s token) and the scheduled engine''s (needs a run''s ticket)',
  case when (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname like 'growth\_outbound\_%'
                and has_function_privilege('anon', p.oid, 'execute')) = 'growth_outbound_optout,growth_outbound_scheduled,growth_outbound_webhook'
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                          and p.proname in ('growth_outbound_webhook', 'growth_outbound_optout', 'growth_outbound_scheduled')
                          and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute')))
       then 'ok' else 'CHECK THIS' end
union all
select 24, 'Resend webhook signing secret: ' || coalesce((select 'set ' || to_char(set_at, 'YYYY-MM-DD HH24:MI') || ' UTC'
                                                         from growth_outbound.secrets where name = 'resend_webhook'), 'not set'),
  case when exists (select 1 from growth_outbound.secrets where name = 'resend_webhook') then 'ok'
       else 'ok — not yet: in the SQL editor run  select growth_outbound.set_webhook_secret(''whsec_...'');' end
union all
select 25, 'the signature check is HMAC-SHA256 to the letter (RFC 4231 test vectors)',
  case when encode(growth_outbound.hmac_sha256('Jefe'::bytea, 'what do ya want for nothing?'::bytea), 'hex')
            = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
        and encode(growth_outbound.hmac_sha256(decode(repeat('aa', 131), 'hex'), 'Test Using Larger Than Block-Size Key - Hash Key First'::bytea), 'hex')
            = '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'
       then 'ok' else 'CHECK THIS' end
union all
select 26, 'provider events: ' || (select count(*) from growth_outbound.provider_events where received_at >= now() - interval '24 hours')::text
  || ' in 24 hours; last ' || coalesce((select to_char(max(received_at), 'YYYY-MM-DD HH24:MI') || ' UTC' from growth_outbound.provider_events), 'never'),
  'ok'
union all
select 27, 'research engine: every quote is checked against the stored page, the claim against the quote, and "own site" is decided here',
  case when (select count(*) from pg_trigger where not tgisinternal and tgname in
              ('pages_prepare_t', 'pages_append_only_t', 'candidates_never_delete_t', 'research_runs_never_delete_t')) = 4
        and growth_outbound.quote_in('runs CFB Numbers', 'Pat  runs CFB numbers, since 2019.')
        and not growth_outbound.quote_in('Pat Analys', 'Pat Analyst runs CFB numbers')
        and growth_outbound.is_shared_site('espn.com')
        and growth_outbound.discovery_config_problems('{"budget": {"llm": 100000}}'::jsonb) is not null
       then 'ok' else 'CHECK THIS' end
union all
select 28, 'research budget today: ' || coalesce((select string_agg(k || ' ' || (v->>'used') || '/' || (v->>'cap'), ', ' order by k)
                                                 from jsonb_each(growth_outbound.research_budget()) x(k, v)), 'none'),
  'ok'
union all
select 29, 'candidates: ' || coalesce((select string_agg(status || ' ' || n, ', ' order by status)
                                       from (select status, count(*) n from growth_outbound.candidates group by status) x), 'none yet')
  || '; last research run ' || coalesce((select to_char(max(started_at), 'YYYY-MM-DD HH24:MI') || ' UTC' from growth_outbound.research_runs), 'never'),
  'ok'
union all
select 30, 'drafting engine: an engine draft cites only current, confident evidence in its own words, invents no name or figure, and greets only by an established first name',
  case when growth_outbound.greeting_problem(E'Hi Pat,\nThanks.', 'Pat') is null
        and growth_outbound.greeting_problem(E'Hi there,\nThanks.', null) is null
        and growth_outbound.greeting_problem(E'Hi Patrick,\nThanks.', 'Pat') is not null
        and growth_outbound.greeting_problem(E'Hi Pat,\nThanks.', null) is not null
        and growth_outbound.uncited_details('I loved your 2024 Heisman model', 'model') = array['2024', 'Heisman']
        and cardinality(growth_outbound.uncited_sentences('I loved your model.', '{}')) = 1
        and cardinality(growth_outbound.uncited_sentences('I loved your CFB model.', array['CFB model'])) = 0
        and not growth_outbound.engine_citeable('email') and not growth_outbound.engine_citeable('fit_signal')
        and to_regprocedure('public.growth_outbound_draft_propose(bigint, uuid, jsonb)') is not null
        and pg_get_constraintdef((select oid from pg_constraint where conname = 'research_runs_shape_ck')) like '%draft%'
       then 'ok' else 'CHECK THIS' end
union all
select 31, 'drafting: ' || (select count(*) from growth_outbound.drafting_due() x where x.sequence_number = 1)::text || ' first emails and '
  || (select count(*) from growth_outbound.drafting_due() x where x.sequence_number > 1)::text || ' follow-ups due; engine drafts in 90 days: '
  || coalesce((select (v->>'drafts') || ' written, ' || (v->>'approved_as_written') || ' approved as written, '
                      || (v->>'approved_after_edit') || ' after an edit, ' || (v->>'rejected') || ' rejected'
                 from jsonb_each(growth_outbound.drafting_stats()) x(k, v) where k = 'engine'), 'none'),
  'ok'
union all
select 32, 'the morning run finds, researches and drafts on a ticket that opens only the engine''s doors; it cannot approve, edit, send, suppress or change settings',
  case when to_regprocedure('public.growth_outbound_scheduled(text,text,jsonb)') is not null
        and pg_get_functiondef('public.growth_outbound_scheduled(text,text,jsonb)'::regprocedure)
            !~ '(approve|send_claim|send_result|draft_edit|draft_reject|draft_create|settings_update|suppress|prospect_set_status|research_begin)'
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                          and p.proname in ('growth_outbound_draft_approve', 'growth_outbound_drafts_approve_batch', 'growth_outbound_draft_unapprove',
                                            'growth_outbound_draft_edit', 'growth_outbound_draft_reject', 'growth_outbound_draft_create',
                                            'growth_outbound_send_claim', 'growth_outbound_send_result', 'growth_outbound_settings_update',
                                            'growth_outbound_suppress', 'growth_outbound_prospect_set_status', 'growth_outbound_research_begin')
                          and pg_get_functiondef(p.oid) like '%require_engine%')
        and growth_outbound.ticket_run(repeat('0', 64)) is null and growth_outbound.ticket_run('not a ticket') is null
        and exists (select 1 from pg_constraint where conname = 'research_runs_ticket_ck')
       then 'ok' else 'CHECK THIS' end
union all
select 33, 'morning run: ' || (select case when automation_enabled then 'ON' else 'off' end || ', ' || automation_start_hour || ':00 for '
                                        || automation_hours || ' h, ' || automation_timezone from growth_outbound.settings where id = 1)
  || '; last tick ' || coalesce((select to_char(last_tick_at, 'YYYY-MM-DD HH24:MI') || ' UTC (' || last_action || ': ' || coalesce(last_reason, '') || ')'
                                   from growth_outbound.scheduler where id = 1 and last_tick_at is not null),
                                'never (run supabase/growth_outbound_cron.sql to schedule it)'),
  'ok'
union all
select 34, 'results: a live email''s EdgeDesk links carry its campaign code; a visit or an account is matched by that code or the address written to, after the first email only; a customer is never cold-emailed',
  case when growth_outbound.tag_links('Try it at https://edgedesksports.com/.', 'ob_0123456789abcdef0123456789abcdef')
            = 'Try it at https://edgedesksports.com/?utm_source=outbound&utm_medium=email&utm_campaign=ob_0123456789abcdef0123456789abcdef.'
        and growth_outbound.tag_links('See https://edgedesksports.com.evil.test/x', 'ob_test') = 'See https://edgedesksports.com.evil.test/x'
        and growth_outbound.link_campaign('0123456789abcdef0123456789abcdef', true) = 'ob_test'
        and (select count(*) from pg_trigger where not tgisinternal and tgname in ('conversions_guard_t', 'conversions_append_only_t')) = 2
        and pg_get_functiondef('growth_outbound.sends_guard()'::regprocedure) like '%has_account%'
        and to_regprocedure('public.growth_outbound_analytics(integer)') is not null
       then 'ok' else 'CHECK THIS' end
union all
select 35, 'results: ' || (select count(distinct prospect_id) from growth_outbound.conversions where stage = 'signed_up')::text || ' prospects made an account, '
  || (select count(distinct prospect_id) from growth_outbound.conversions where stage = 'paid')::text || ' paid; links '
  || (select case when attribution_links then 'tagged' else 'NOT tagged (turned off)' end from growth_outbound.settings where id = 1)
  || '; last matched ' || coalesce((select to_char(conversions_synced_at, 'YYYY-MM-DD HH24:MI') || ' UTC' || coalesce(' — ' || conversions_error, '')
                                     from growth_outbound.scheduler where id = 1 and conversions_synced_at is not null), 'never (the tick does it hourly)'),
  case when (select conversions_error from growth_outbound.scheduler where id = 1) is null then 'ok' else 'CHECK THIS' end
union all
select 36, 'hardening: two batches, two ticks and two discovery runs queue instead of deadlocking; a test send is a dry run; the console runs these same checks (System check)',
  case when pg_get_functiondef('public.growth_outbound_drafts_approve_batch(jsonb,integer)'::regprocedure) like '%order by d.id for update%'
        and pg_get_functiondef('growth_outbound.schedule_tick(text,timestamp with time zone)'::regprocedure) like '%growth_outbound.tick%'
        and pg_get_functiondef('public.growth_outbound_candidates_record(bigint,jsonb)'::regprocedure) like '%growth_outbound.candidates%'
        and to_regprocedure('public.growth_outbound_health()') is not null
       then 'ok' else 'CHECK THIS' end
union all
select 37, 'qualification and providers (Phase 12): every fit reason belongs to a part of the 0–100 score (35/25/15, contact 15, personalization 10); the content rules refuse free or special access and picks talk; engine emails carry the offer; the live cap warms up',
  case when not exists (select 1 from growth_outbound.fit_factor_catalog where category is null)
        and growth_outbound.qualification_max('relevance') + growth_outbound.qualification_max('analytics')
            + growth_outbound.qualification_max('purchase') + growth_outbound.qualification_max('contact')
            + growth_outbound.qualification_max('personalization') = 100
        and cardinality(growth_outbound.draft_lint('Hello', 'You get complimentary access to our premium picks.')) = 2
        and cardinality(growth_outbound.draft_lint('Hello', 'Research, not picks: try it free for 7 days, then $49.99/month.')) = 0
        and to_regprocedure('growth_outbound.engine_draft_problems(uuid,integer,text,text,jsonb)') is not null
        and pg_get_functiondef('growth_outbound.sends_guard()'::regprocedure) like '%live_send_cap()%'
        and (select growth_outbound.discovery_config_problems(discovery_config) is null from growth_outbound.settings where id = 1)
       then 'ok — threshold ' || (select min_qualification_score from growth_outbound.settings where id = 1)
            || ', today''s live cap ' || (growth_outbound.live_send_cap()->>'cap')
            || ', sending domain ' || coalesce((select case when domain_auth->>'ok' = 'true' then 'checked: SPF, DKIM and DMARC in place'
                                                            when domain_auth->>'ok' = 'false' then 'CHECKED AND FAILING'
                                                            else 'checked: could not tell' end
                                                  from growth_outbound.settings where id = 1 and domain_auth is not null), 'not checked yet')
       else 'CHECK THIS' end
union all
select 38, 'the daily email goes only to an outbound owner''s own confirmed address, says counts only, and its ticket opens its own two doors and no others (never a draft, a prospect or a send): '
  || (select case when not s.digest_enabled then 'off'
                  else 'on, to ' || coalesce(growth_outbound.digest_recipient(), 'NOBODY (turn it off and on again)') end
        from growth_outbound.settings s where s.id = 1)
  || coalesce('; last ' || (select d.day || ' ' || d.status from growth_outbound.digests d order by d.day desc limit 1), ''),
  case when pg_get_functiondef('public.growth_outbound_scheduled(text,text,jsonb)'::regprocedure) like '%growth_outbound.digest_door(p_ticket%'
        and pg_get_functiondef('growth_outbound.digest_door(text,text,jsonb)'::regprocedure)
            ~ 'begin\s+v_id := growth_outbound\.digest_for_ticket\(p_ticket\);\s+if v_id is null then return'
        and pg_get_functiondef('growth_outbound.digest_compose(bigint)'::regprocedure) like '%digest_recipient()%'
        and pg_get_functiondef('growth_outbound.digest_compose(bigint)'::regprocedure)
            !~ '(insert into growth_outbound\.sends|update growth_outbound\.sends|send_claim|send_result|approve_one|drafts_approve)'
        and growth_outbound.digest_for_ticket(repeat('0', 64)) is null and growth_outbound.digest_for_ticket('not a ticket') is null
        and exists (select 1 from pg_constraint where conname = 'digests_shape_ck')
        and exists (select 1 from pg_constraint where conrelid = 'growth_outbound.settings'::regclass and contype = 'f'
                      and confrelid = 'growth_outbound.owners'::regclass and confdeltype = 'n')
       then 'ok' else 'CHECK THIS' end
union all
select 39, 'replies: an email Resend receives for us is matched by its sender''s address alone to the last email that went there; a reply ends that sequence, an out-of-office changes nothing, "unsubscribe" suppresses: '
  || (select case when reply_detection then 'detection on' else 'detection OFF (replies recorded; unsubscribe requests still honoured)' end
        from growth_outbound.settings where id = 1)
  || '; ' || coalesce((select count(*) filter (where kind = 'reply') || ' replied, ' || count(*) filter (where kind = 'auto_reply') || ' automatic, '
                              || count(*) filter (where kind = 'opt_out') || ' asked to stop, ' || count(*) filter (where kind = 'unmatched')
                              || ' from nobody we wrote to (30 days); last ' || to_char(max(received_at), 'YYYY-MM-DD HH24:MI') || ' UTC'
                         from growth_outbound.replies where received_at >= now() - interval '30 days' having count(*) > 0),
                      'nothing received in 30 days (set up receiving in Resend: docs/growth-outbound.md, Replies)'),
  case when growth_outbound.classify_reply('Re: your CFB ratings') = 'reply'
        and growth_outbound.classify_reply('Automatic reply: Pat is away') = 'auto_reply'
        and growth_outbound.classify_reply('Out of Office: back Monday') = 'auto_reply'
        and growth_outbound.classify_reply('Re: please unsubscribe me') = 'opt_out'
        and growth_outbound.classify_reply(null) = 'reply'
        and pg_get_functiondef('public.growth_outbound_webhook(text,text,text,text)'::regprocedure) like '%growth_outbound.reply_received(%'
        and exists (select 1 from pg_trigger where not tgisinternal and tgname = 'replies_append_only_t')
       then 'ok' else 'CHECK THIS' end
union all
select 40, 'free-first discovery and readiness (Phase 13): your own lists, directories and Podcast Index feed the candidate queue with no paid search; a provider is "connected" only after a live answer; live sending needs a checked opt-out endpoint and a webhook proven by a signed event; partner leads get partnership notes, never the subscription pitch',
  case when to_regprocedure('public.growth_outbound_candidates_import(text,jsonb)') is not null
        and to_regprocedure('public.growth_outbound_provider_health_record(bigint,jsonb)') is not null
        and to_regprocedure('public.growth_outbound_optout_check_record(jsonb)') is not null
        and pg_get_functiondef('growth_outbound.send_blockers_for(boolean)'::regprocedure) like '%unsubscribe_endpoint_unverified%'
        and pg_get_functiondef('growth_outbound.send_blockers_for(boolean)'::regprocedure) like '%webhook_unproven%'
        and growth_outbound.discovery_config_problems('{"directories": [{"url": "https://example.org/list"}]}'::jsonb) is not null
        and growth_outbound.discovery_config_problems('{"directories": [{"url": "https://example.org/list", "permitted": true}], "providers": {"podcastindex": true}}'::jsonb) is null
        and cardinality(growth_outbound.draft_lint('Act now', 'Huge fan of your work. As we discussed, this offer ends tonight.')) = 3
        and cardinality(growth_outbound.partner_offer_problems('We pay a 30% commission per signup: https://edgedesksports.com/partners/')) = 1
        and pg_get_functiondef('growth_outbound.footer_text(text)'::regprocedure) like '%commercial email%'
        and pg_get_functiondef('public.growth_outbound_settings_update(jsonb)'::regprocedure) like '%belongs to a prospect%'
       then 'ok — ' || coalesce((select string_agg(provider || ' ' || state, ', ' order by provider) from growth_outbound.provider_health), 'no provider checked yet')
            || '; opt-out endpoint ' || coalesce((select case when optout_check->>'ok' = 'true' then 'checked' else 'CHECK FAILED' end
                                                   from growth_outbound.settings where id = 1 and optout_check is not null), 'not checked yet')
            || '; webhook ' || case when exists (select 1 from growth_outbound.provider_events e, growth_outbound.secrets k
                                                  where k.name = 'resend_webhook' and e.received_at >= k.set_at) then 'proven'
                                    when exists (select 1 from growth_outbound.secrets where name = 'resend_webhook') then 'not proven yet (send a test email)'
                                    else 'secret not set' end
       else 'CHECK THIS' end
union all
select 18, 'prospects by status: ' || coalesce((select string_agg(status || ' ' || n, ', ' order by status)
                                                from (select status, count(*) n from growth_outbound.prospects group by status) x), 'none yet'),
  'ok'
$$;

-- What needs the owner's attention now, in words, most serious first. None
-- of it changes anything; each says what to do.
create or replace function growth_outbound.attention()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  with s as (select * from growth_outbound.settings where id = 1),
  sc as (select * from growth_outbound.scheduler where id = 1),
  live30 as (select count(*) filter (where sent_at is not null) as sent, count(*) filter (where bounced_at is not null) as bounced,
                    count(*) filter (where complained_at is not null) as complained
               from growth_outbound.sends where not is_test and claimed_at >= now() - interval '30 days'),
  items(sev, code, text) as (
    select 1, 'check_failed', 'A system check fails: ' || string_agg(c.item, '; ') || '. Run supabase/growth_outbound.sql again and read its report.'
      from growth_outbound.self_check() c where c.outcome not like 'ok%' having count(*) > 0
    union all
    select 1, 'complaints', 'Spam complaints: ' || l.complained || ' of the last ' || l.sent || ' live emails (30 days). Above 1 in 1,000 mailbox providers start filtering; slow down and review who is being written to.'
      from live30 l where l.complained > 0 and l.sent > 0 and l.complained::numeric / l.sent > 0.001
    union all
    select 1, 'bounces', 'Bounces: ' || l.bounced || ' of the last ' || l.sent || ' live emails (30 days, ' || round(100.0 * l.bounced / l.sent, 1) || '%). Above 4% hurts delivery for every email from the domain; check how addresses are being found and verified.'
      from live30 l where l.sent >= 20 and l.bounced::numeric / l.sent > 0.04
    union all
    select 1, 'webhook_silent', 'Live emails went out in the last two days but no event from Resend arrived: bounces and complaints are not being recorded. Check the webhook in Resend (its address and signing secret).'
      where exists (select 1 from growth_outbound.sends where not is_test and sent_at >= now() - interval '48 hours' and sent_at < now() - interval '1 hour')
        and not exists (select 1 from growth_outbound.provider_events where outcome <> 'not_outbound' and received_at >= now() - interval '48 hours')
    union all
    select 2, 'stale_claims', count(*) || ' send(s) were handed over over an hour ago and never confirmed. Press Try again on them in Sends (it can never send twice); after 23 hours they are marked failed.'
      from growth_outbound.sends where delivery_status = 'claimed' and resend_message_id is null and claimed_at < now() - interval '1 hour' having count(*) > 0
    union all
    select 2, 'clock_stopped', 'The morning run is on but the clock has not ticked for ' || coalesce(to_char(now() - sc.last_tick_at, 'HH24" h "MI" min"'), 'ever') || '. Run supabase/growth_outbound_cron.sql in the SQL editor (pg_cron and pg_net on).'
      from s, sc where s.automation_enabled and (sc.last_tick_at is null or sc.last_tick_at < now() - interval '15 minutes')
    union all
    select 2, 'runs_failing', 'The last three morning-run steps failed (' || (select string_agg(left(coalesce(r.error, r.status), 80), '; ') from (
             select error, status from growth_outbound.research_runs where started_by = 'schedule' order by id desc limit 3) r) || '). See Discover and research.'
      where (select count(*) = 3 and bool_and(status = 'failed') from (
               select status from growth_outbound.research_runs where started_by = 'schedule' order by id desc limit 3) x)
    union all
    select 2, 'results_error', 'Matching results failed: ' || sc.conversions_error || '. It is tried again every hour.'
      from sc where sc.conversions_error is not null
    union all
    select 3, 'approved_waiting', count(*) || ' approved draft(s) have waited over three days without being sent. Send them or withdraw the approval (the facts behind them age).'
      from growth_outbound.drafts where status = 'approved' and approved_at < now() - interval '3 days' having count(*) > 0
    union all
    select 3, 'blocked', 'Sending is blocked: ' || array_to_string(growth_outbound.send_blockers(), ', ') || '.'
      where cardinality(growth_outbound.send_blockers()) > 0
    union all
    select 1, 'domain_auth_failed', 'The sending domain check found ' || coalesce((select string_agg(upper(k), ', ' order by k) from jsonb_each(s.domain_auth) x(k, v)
             where k in ('spf', 'dkim', 'dmarc') and v->>'ok' = 'false'), 'a record') || ' missing on ' || coalesce(s.domain_auth->>'domain', 'the domain')
             || '. Live sending is blocked until it is fixed in DNS and checked again (System check → Check the sending domain).'
      from s where s.domain_auth->>'ok' = 'false'
    union all
    select 3, 'domain_auth_unchecked', 'The sending domain''s SPF, DKIM and DMARC have not been checked '
             || case when s.domain_auth_checked_at is null then 'yet' else 'in 30 days' end || '. Run the check (System check → Check the sending domain).'
      from s where not s.test_mode and (s.domain_auth_checked_at is null or s.domain_auth_checked_at < now() - interval '30 days')
    union all
    -- (Phase 13) a provider that refused, ran out of free credit or is not on
    -- the plan, in the last week; a morning run with nothing to discover from
    select 2, 'provider_' || h.state,
           initcap(h.provider) || ': ' || case h.state when 'unauthorized' then 'the key was refused'
                                                   when 'quota_exhausted' then 'the free credit is used up'
                                                   when 'insufficient_plan' then 'an endpoint is not on the current plan' end
           || coalesce(' (' || left(h.detail, 160) || ')', '') || '. Discover and research → Providers says what to do.'
      from growth_outbound.provider_health h
     where h.checked_at > now() - interval '7 days'
       and (h.state in ('unauthorized', 'quota_exhausted')
            or exists (select 1 from jsonb_each_text(h.endpoints) e where e.value in ('unauthorized', 'quota_exhausted')))
    union all
    select 2, 'no_discovery_source', 'The morning run is on but has nothing to discover from: save a search (Podcast Index answers it for free once its key is set) or a directory page, or import a list of addresses under Discover and research.'
      from s where s.automation_enabled
       and coalesce(jsonb_array_length(case when jsonb_typeof(s.discovery_config->'queries') = 'array' then s.discovery_config->'queries' end), 0) = 0
       and coalesce(jsonb_array_length(case when jsonb_typeof(s.discovery_config->'directories') = 'array' then s.discovery_config->'directories' end), 0) = 0
       and not exists (select 1 from growth_outbound.candidates c where c.status = 'new')
    union all
    select 2, 'digest_failed', 'This morning''s email to you could not be sent: ' || coalesce(d.reason, 'no reason recorded') || '. Outbound, Morning run shows each try.'
      from s, growth_outbound.digests d
     where s.digest_enabled and d.status = 'failed' and not (d.retryable and d.attempts < 3) and d.updated_at >= now() - interval '24 hours'
    union all
    select 3, 'digest_no_recipient', 'The daily email is on but has nobody to go to: the owner who turned it on is no longer an owner, or has no confirmed address. Turn it off and on again.'
      from s where s.digest_enabled and growth_outbound.digest_recipient() is null
    union all
    select 4, 'cap_raised', 'The daily send cap is ' || s.max_sends_per_day || ' (the default is 20).' from s where s.max_sends_per_day > 20
    union all
    select 4, 'warming_up', 'The sending domain is warming up: today''s live cap is ' || (growth_outbound.live_send_cap()->>'cap')
             || ' of ' || s.max_sends_per_day || ', rising by ' || s.warmup_step_per_week || ' a week.'
      from s where not s.test_mode and (growth_outbound.live_send_cap()->>'warming')::boolean
  )
  select coalesce(jsonb_agg(jsonb_build_object('severity', sev, 'code', code, 'text', text) order by sev, code), '[]'::jsonb) from items;
$$;

-- THE SYSTEM CHECK DOOR. Owner only. Reads; changes nothing.
create or replace function public.growth_outbound_health()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_checks jsonb;
begin
  perform growth_outbound.require_owner();
  select coalesce(jsonb_agg(jsonb_build_object('step', c.step, 'item', c.item, 'ok', c.outcome like 'ok%', 'outcome', c.outcome) order by c.step), '[]'::jsonb)
    into v_checks from growth_outbound.self_check() c;
  return jsonb_build_object('ok', true, 'checked_at', now(), 'checks', v_checks,
    'passing', (select count(*) from jsonb_array_elements(v_checks) x where (x->>'ok')::boolean),
    'total', jsonb_array_length(v_checks),
    'attention', growth_outbound.attention());
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
    -- THREE PUBLIC DOORS, each refusing anything without its own proof (Resend's
    -- signature; a send's opt-out token; a scheduled run's ticket). Every other
    -- door: signed-in callers, and then only an owner gets past its first
    -- statement.
    if f::text like 'growth_outbound_webhook(%' or f::text like 'growth_outbound_optout(%' or f::text like 'growth_outbound_scheduled(%' then
      execute format('grant execute on function %s to anon', f);
    else
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
end
$grants$;
revoke all on all functions in schema growth_outbound from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- =============================================================================
-- REPORT: every row should say ok.
-- =============================================================================
select * from growth_outbound.self_check() order by 1;

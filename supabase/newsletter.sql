-- ============================================================================
-- THE EDGEDESK RESEARCH NEWSLETTER — the server-side half.
--
-- WHAT IT HOLDS: who asked for the email and for which sport, who must never
-- receive one again, what each week's edition actually said, what happened to
-- every individual send, and the switches an operator uses to stop all of it.
--
-- FOUR RULES THE DATABASE ENFORCES ITSELF, because a rule a client can forget
-- is not a rule:
--
--   1  SENDING IS OFF UNTIL SOMEBODY TURNS IT ON. `sending_enabled` defaults
--      to FALSE. This is the launch gate the brief asks for: a freshly applied
--      migration cannot email anyone, whatever the pipeline believes, and the
--      switch is one row an operator flips once.
--
--   2  ONE EDITION PER SPORT, SEASON, SLATE WEEK AND SCHEDULED DATE. A unique
--      constraint, not a convention. Two schedulers that both fire at 10:00
--      race for the same row and exactly one of them wins.
--
--   3  ONE DELIVERY ROW PER (EDITION, ADDRESS). A retry that has already been
--      accepted for a recipient cannot become a second email to them, because
--      the second insert cannot exist.
--
--   4  A PROVIDER EVENT IS PROCESSED ONCE. Webhook endpoints are called more
--      than once by every provider worth using; the event id is unique, so a
--      duplicate delivery of the same event is a no-op rather than a second
--      bounce.
--
-- AND ONE RULE ABOUT PRIVACY, enforced by the absence of a grant: NO CLIENT
-- ROLE CAN READ A SUBSCRIBER ADDRESS. Not anonymous, not a signed-in reader,
-- not an operator. The subscriber table has row level security on and no
-- select policy for anybody; every legitimate read goes through a
-- security-definer function that returns either the caller's own row or an
-- aggregate. An operator console shows counts and redacted addresses, which is
-- everything an operator needs and nothing a breach would want.
--
-- PREREQUISITE: supabase/site_articles.sql, for site_article_is_admin(). This
-- file reuses the operator allowlist that already exists rather than building
-- a second notion of who an operator is.
--
-- CONVENTION (supabase/README.md): idempotent, additive, ends in a report,
-- and not one psql meta-command anywhere in it.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.site_article_is_admin()') is null then
    raise exception
      'newsletter.sql needs public.site_article_is_admin(); run supabase/site_articles.sql first';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- settings --
-- ONE ROW. A second settings row would immediately become a second source of
-- truth about whether the product is allowed to email people.
create table if not exists public.newsletter_settings (
  id integer primary key default 1,

  -- THE GLOBAL KILL SWITCH, and the launch gate. False means no edition is
  -- ever handed to the provider — not held, not queued, not "sent in test
  -- mode". It does not stop an edition being BUILT, previewed or validated,
  -- because an operator reviewing next Monday's newsletter is exactly what
  -- this switch is meant to make safe.
  sending_enabled boolean not null default false,

  -- and a switch per sport, so a bad college week can be paused without
  -- taking the NFL edition down with it
  cfb_enabled boolean not null default true,
  nfl_enabled boolean not null default true,

  -- the dispatcher may be stopped separately from sending, which is what you
  -- want while debugging a scheduler
  dispatcher_enabled boolean not null default true,

  -- sender identity. Every one of these must match a verified sending domain
  -- before sending_enabled is turned on; see tools/newsletter/README.md.
  from_name       text not null default 'EdgeDesk Research',
  from_email      text not null default 'research@edgedesksports.com',
  reply_to_email  text not null default 'support@edgedesksports.com',
  -- CAN-SPAM requires a physical postal address in every commercial email.
  -- It is configuration rather than a literal in the renderer so it can be
  -- corrected without a deploy.
  mailing_address text not null default 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423',
  site_url        text not null default 'https://edgedesksports.com',

  -- the schedule. The hour is LOCAL to send_zone and the pipeline converts it
  -- with the zone database; see tools/newsletter/schedule.js.
  send_hour_local      smallint not null default 10,
  send_minute_local    smallint not null default 0,
  send_zone            text     not null default 'America/Chicago',
  -- how long after the scheduled minute an edition may still go out. Past it
  -- the edition is stale and is held rather than sent.
  retry_window_minutes integer  not null default 240,

  -- the selection policy, mirrored from tools/newsletter/select.js DEFAULTS so
  -- an operator can move a threshold without a deploy
  target_games smallint not null default 5,
  max_games    smallint not null default 10,
  cfb_threshold numeric not null default 14,
  nfl_threshold numeric not null default 30,
  cfb_expansion_threshold numeric not null default 19,
  nfl_expansion_threshold numeric not null default 38,
  quote_stale_hours  integer not null default 72,
  record_stale_hours integer not null default 30,
  gap_confidence_floor numeric not null default 0.55,

  -- ABUSE CONTROL ON THE ONE PUBLIC DOOR. /subscribe is unauthenticated by
  -- necessity — a stranger signing up has no session — which means anybody
  -- who can reach it can make a VERIFIED EDGEDESK DOMAIN send mail to any
  -- address they name. Unthrottled that is an email-bombing service with our
  -- reputation attached, and the damage lands on deliverability for every
  -- real subscriber. Both caps are enforced in the function below, not in
  -- the edge runtime, so no client and no redeploy can go around them.
  signup_cooldown_seconds integer not null default 900,
  signup_per_ip_hour integer not null default 12,

  -- where a test send goes. Never used by a scheduled edition.
  test_recipients text[] not null default '{}',

  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint newsletter_settings_singleton check (id = 1)
);

-- Columns added after the first release land here, so a project that already
-- ran an earlier version is completed rather than left half-shaped by a no-op
-- `create table if not exists`.
alter table public.newsletter_settings add column if not exists sending_enabled boolean not null default false;
alter table public.newsletter_settings add column if not exists cfb_enabled boolean not null default true;
alter table public.newsletter_settings add column if not exists nfl_enabled boolean not null default true;
alter table public.newsletter_settings add column if not exists dispatcher_enabled boolean not null default true;
alter table public.newsletter_settings add column if not exists from_name text not null default 'EdgeDesk Research';
alter table public.newsletter_settings add column if not exists from_email text not null default 'research@edgedesksports.com';
alter table public.newsletter_settings add column if not exists reply_to_email text not null default 'support@edgedesksports.com';
alter table public.newsletter_settings add column if not exists mailing_address text not null default 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423';
alter table public.newsletter_settings add column if not exists site_url text not null default 'https://edgedesksports.com';
alter table public.newsletter_settings add column if not exists send_hour_local smallint not null default 10;
alter table public.newsletter_settings add column if not exists send_minute_local smallint not null default 0;
alter table public.newsletter_settings add column if not exists send_zone text not null default 'America/Chicago';
alter table public.newsletter_settings add column if not exists retry_window_minutes integer not null default 240;
alter table public.newsletter_settings add column if not exists target_games smallint not null default 5;
alter table public.newsletter_settings add column if not exists max_games smallint not null default 10;
alter table public.newsletter_settings add column if not exists cfb_threshold numeric not null default 14;
alter table public.newsletter_settings add column if not exists nfl_threshold numeric not null default 30;
alter table public.newsletter_settings add column if not exists cfb_expansion_threshold numeric not null default 19;
alter table public.newsletter_settings add column if not exists nfl_expansion_threshold numeric not null default 38;
alter table public.newsletter_settings add column if not exists quote_stale_hours integer not null default 72;
alter table public.newsletter_settings add column if not exists record_stale_hours integer not null default 30;
alter table public.newsletter_settings add column if not exists gap_confidence_floor numeric not null default 0.55;
alter table public.newsletter_settings add column if not exists signup_cooldown_seconds integer not null default 900;
alter table public.newsletter_settings add column if not exists signup_per_ip_hour integer not null default 12;
alter table public.newsletter_settings add column if not exists test_recipients text[] not null default '{}';
alter table public.newsletter_settings add column if not exists updated_by uuid;

insert into public.newsletter_settings (id) values (1) on conflict (id) do nothing;

-- VALIDATED IN THE DATABASE, not only in the form. A retry window of zero
-- makes every edition stale the moment it is due, which is a silent outage.
alter table public.newsletter_settings drop constraint if exists newsletter_settings_shape_ck;
alter table public.newsletter_settings add constraint newsletter_settings_shape_ck check (
  send_hour_local between 0 and 23
  and send_minute_local between 0 and 59
  and retry_window_minutes between 15 and 1440
  and target_games between 1 and 20
  and max_games >= target_games and max_games <= 20
  and quote_stale_hours between 1 and 720
  and record_stale_hours between 1 and 720
  and gap_confidence_floor between 0 and 1
  and signup_cooldown_seconds between 0 and 86400
  and signup_per_ip_hour between 1 and 1000
  and position('@' in from_email) > 1
  and position('@' in reply_to_email) > 1
  and length(mailing_address) >= 10
);

-- ------------------------------------------------------------- the audit ---
-- THIS TABLE DECIDES WHETHER STRANGERS GET EMAIL, so a change to it is
-- traceable: what moved, from what, to what, when and by whom.
create table if not exists public.newsletter_settings_audit (
  id bigserial primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  field text not null,
  old_value text,
  new_value text
);
create index if not exists newsletter_settings_audit_at_idx
  on public.newsletter_settings_audit (changed_at desc);

create or replace function public.newsletter_settings_audit_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text; o text; n text;
begin
  for k in select key from jsonb_each(to_jsonb(new)) loop
    if k in ('updated_at', 'updated_by') then continue; end if;
    o := to_jsonb(old) ->> k;
    n := to_jsonb(new) ->> k;
    if o is distinct from n then
      insert into public.newsletter_settings_audit (changed_by, field, old_value, new_value)
      values (coalesce(new.updated_by, auth.uid()), k, o, n);
    end if;
  end loop;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists newsletter_settings_audit_t on public.newsletter_settings;
create trigger newsletter_settings_audit_t before update on public.newsletter_settings
  for each row execute function public.newsletter_settings_audit_fn();

-- ----------------------------------------------------------- subscribers ---
-- CONSENT IS A RECORD, NOT A FLAG. Where it came from, when, and what the
-- person was looking at when they gave it, because "did this person ask for
-- this?" has to be answerable years later from the row itself.
create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- an account, when the signup came from one. Nullable on purpose: the
  -- public signup form does not require an account and must not create one.
  user_id uuid references auth.users (id) on delete set null,

  status text not null default 'pending',

  -- SEPARATE PREFERENCES, which is the brief's "college football, NFL, or
  -- both". Two booleans rather than one enum, so "both" is not a third state
  -- that has to be kept in step with the other two.
  wants_cfb boolean not null default false,
  wants_nfl boolean not null default false,

  consent_source text,
  consent_at timestamptz,
  consent_user_agent text,
  -- the address is hashed rather than stored: enough to show two signups came
  -- from one place, useless to anybody who steals the table
  consent_ip_hash text,
  consent_version text not null default 'newsletter-2026-09',

  -- DOUBLE OPT-IN. The raw token is emailed and never stored; only its digest
  -- is here, so the table cannot be used to confirm anybody.
  confirm_token_hash text,
  confirm_sent_at timestamptz,
  confirm_expires_at timestamptz,
  confirmed_at timestamptz,
  confirm_attempts integer not null default 0,

  -- THE MANAGE TOKEN is what makes unsubscribe work without a login, and it
  -- is stored RAW rather than digested. That is a deliberate asymmetry with
  -- the confirmation token above, and the reasoning matters:
  --
  --   the CONFIRM token proves control of a mailbox. It must be impossible to
  --   reconstruct from the database, or somebody with a copy of this table
  --   could confirm subscriptions nobody asked for. So only its digest is
  --   here and the raw value exists for seven days inside one email.
  --
  --   the MANAGE token only lets its holder unsubscribe an address or change
  --   which sport it receives, and the preferences page it opens shows a
  --   MASKED address and nothing else. It confers no access to anything. But
  --   every email has to CARRY it, so the sender must be able to read it —
  --   a digest here would make the unsubscribe link unbuildable, which is the
  --   one thing this column exists for. Hashing it would cost the feature and
  --   buy an attacker who already has the table the ability to do something
  --   they could do more easily by editing the row directly.
  manage_token text not null,

  unsubscribed_at timestamptz,
  unsubscribe_source text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.newsletter_subscribers add column if not exists user_id uuid references auth.users (id) on delete set null;
alter table public.newsletter_subscribers add column if not exists consent_version text not null default 'newsletter-2026-09';
alter table public.newsletter_subscribers add column if not exists confirm_attempts integer not null default 0;
alter table public.newsletter_subscribers add column if not exists unsubscribe_source text;
alter table public.newsletter_subscribers add column if not exists manage_token text;
-- A project that ran an earlier draft of this file carries the digest column;
-- it is left in place (additive convention) and simply no longer read.
update public.newsletter_subscribers
   set manage_token = encode(gen_random_bytes(32), 'hex')
 where manage_token is null;
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'newsletter_subscribers'
                and column_name = 'manage_token' and is_nullable = 'YES') then
    execute 'alter table public.newsletter_subscribers alter column manage_token set not null';
  end if;
end $$;

alter table public.newsletter_subscribers drop constraint if exists newsletter_subscribers_status_ck;
alter table public.newsletter_subscribers add constraint newsletter_subscribers_status_ck
  check (status in ('pending', 'confirmed', 'unsubscribed'));

-- ONE ROW PER ADDRESS, case-insensitively. The address is lowercased by the
-- trigger below so this index is the whole rule rather than half of it.
create unique index if not exists newsletter_subscribers_email_uk
  on public.newsletter_subscribers (email);
create index if not exists newsletter_subscribers_status_idx
  on public.newsletter_subscribers (status, wants_cfb, wants_nfl);
create index if not exists newsletter_subscribers_user_idx
  on public.newsletter_subscribers (user_id) where user_id is not null;
create index if not exists newsletter_subscribers_confirm_idx
  on public.newsletter_subscribers (confirm_token_hash) where confirm_token_hash is not null;
create unique index if not exists newsletter_subscribers_manage_uk
  on public.newsletter_subscribers (manage_token);

create or replace function public.newsletter_subscribers_touch()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  new.updated_at := now();
  if new.status = 'confirmed' and new.confirmed_at is null then new.confirmed_at := now(); end if;
  if new.status = 'unsubscribed' and new.unsubscribed_at is null then new.unsubscribed_at := now(); end if;
  -- an unsubscribe is not a preference change: both sports go off with it, so
  -- nothing downstream can read a stale `wants_` and send anyway
  if new.status = 'unsubscribed' then new.wants_cfb := false; new.wants_nfl := false; end if;
  return new;
end;
$$;
drop trigger if exists newsletter_subscribers_touch_t on public.newsletter_subscribers;
create trigger newsletter_subscribers_touch_t before insert or update on public.newsletter_subscribers
  for each row execute function public.newsletter_subscribers_touch();

-- ---------------------------------------------------------- suppressions ---
-- A HARD BOUNCE OR A COMPLAINT OUTRANKS EVERY PREFERENCE. Kept in its own
-- table rather than as a subscriber column because an address can be
-- suppressed before it is ever a subscriber, and must stay suppressed after
-- the subscriber row is deleted.
create table if not exists public.newsletter_suppressions (
  email text primary key,
  reason text not null,
  detail text,
  provider_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.newsletter_suppressions drop constraint if exists newsletter_suppressions_reason_ck;
alter table public.newsletter_suppressions add constraint newsletter_suppressions_reason_ck
  check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual', 'invalid'));
create index if not exists newsletter_suppressions_reason_idx on public.newsletter_suppressions (reason, created_at desc);

-- -------------------------------------------------------------- editions ---
create table if not exists public.newsletter_editions (
  id bigserial primary key,
  -- the human-readable identity, e.g. NFL:2026:W02:2026-09-15
  edition_key text not null,
  sport text not null,
  season integer not null,
  slate_week integer not null,
  edition_date date not null,

  status text not null default 'planned',
  hold_reason text,
  hold_detail text,

  scheduled_at timestamptz,
  deadline_at timestamptz,
  data_cutoff_at timestamptz,

  subject text,
  preview_text text,
  html_free text,
  text_free text,
  html_member text,
  text_member text,

  -- THE EXACT RESEARCH AND MARKET STATE THE EDITION WAS BUILT FROM, so the
  -- sent content is reproducible from the row alone. Content-addressed by
  -- content_hash, which is what makes a re-run idempotent.
  selection jsonb,
  research_snapshot jsonb,
  validation jsonb,
  content_hash text,

  game_count integer,
  eligible_recipients integer,
  counts jsonb not null default '{}'::jsonb,

  -- CONCURRENCY. One worker at a time owns an edition; the lease expires so a
  -- crashed runner does not wedge next week's send.
  lease_owner text,
  lease_expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_send_started_at timestamptz,
  sent_at timestamptz
);
alter table public.newsletter_editions add column if not exists content_hash text;
alter table public.newsletter_editions add column if not exists html_member text;
alter table public.newsletter_editions add column if not exists text_member text;
alter table public.newsletter_editions add column if not exists first_send_started_at timestamptz;
alter table public.newsletter_editions add column if not exists hold_detail text;

alter table public.newsletter_editions drop constraint if exists newsletter_editions_sport_ck;
alter table public.newsletter_editions add constraint newsletter_editions_sport_ck check (sport in ('CFB', 'NFL'));
alter table public.newsletter_editions drop constraint if exists newsletter_editions_status_ck;
alter table public.newsletter_editions add constraint newsletter_editions_status_ck
  check (status in ('planned', 'held', 'ready', 'sending', 'sent', 'failed', 'skipped', 'cancelled'));
-- A SENT EDITION HAS TO HAVE SAID SOMETHING. Without this a bug that stored an
-- empty body could still mark itself sent and nothing would notice.
alter table public.newsletter_editions drop constraint if exists newsletter_editions_sent_shape_ck;
alter table public.newsletter_editions add constraint newsletter_editions_sent_shape_ck check (
  status <> 'sent'
  or (subject is not null and html_free is not null and text_free is not null
      and coalesce(game_count, 0) > 0)
);
-- A HELD OR SKIPPED EDITION HAS TO SAY WHY. "It did not go out" with no reason
-- is the single most useless row this table could contain.
alter table public.newsletter_editions drop constraint if exists newsletter_editions_hold_shape_ck;
alter table public.newsletter_editions add constraint newsletter_editions_hold_shape_ck check (
  status not in ('held', 'skipped', 'failed') or hold_reason is not null
);

-- RULE 2: ONE EDITION PER SPORT, SEASON, SLATE WEEK AND SCHEDULED DATE.
create unique index if not exists newsletter_editions_identity_uk
  on public.newsletter_editions (sport, season, slate_week, edition_date);
create unique index if not exists newsletter_editions_key_uk
  on public.newsletter_editions (edition_key);

-- RULE 2b: ONE SEND PER SPORT PER BODY OF WORK, ENFORCED RATHER THAN CHECKED.
--
-- Rule 2 stops one edition being STORED twice. It does not stop two editions,
-- on two dates, carrying the SAME GAMES — which is what happens when the
-- upcoming slate has not advanced between them, and their content hashes say
-- so. The pipeline asks before it sends, but a question asked in application
-- code is a read-then-act: two workers on two different edition keys can both
-- read "no twin" and both dispatch.
--
-- So the database decides it. An edition is stamped `sending` BEFORE a single
-- message is handed to the provider, so a partial unique index over the
-- sending and sent states makes the second edition fail at that transition —
-- before any email leaves, not after. The same row moving sending -> sent is
-- still one row, so a retry is unaffected, and a test send never enters these
-- states at all.
--
-- CREATED DEFENSIVELY: if a deployment already holds two such rows the index
-- cannot be built, and that is a row in this file's report to act on rather
-- than a migration that refuses to finish.
do $$
begin
  begin
    create unique index if not exists newsletter_editions_sent_body_uk
      on public.newsletter_editions (sport, content_hash)
      where status in ('sending', 'sent') and content_hash is not null;
  exception when unique_violation then
    raise notice 'newsletter_editions_sent_body_uk NOT created: two editions of one sport already share a content hash in sending/sent. Resolve them, then re-run this file.';
  end;
end $$;
create index if not exists newsletter_editions_status_idx
  on public.newsletter_editions (status, scheduled_at desc);
create index if not exists newsletter_editions_sport_idx
  on public.newsletter_editions (sport, edition_date desc);

create or replace function public.newsletter_editions_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.status = 'sent' and new.sent_at is null then new.sent_at := now(); end if;
  if new.status = 'sending' and new.first_send_started_at is null then new.first_send_started_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists newsletter_editions_touch_t on public.newsletter_editions;
create trigger newsletter_editions_touch_t before insert or update on public.newsletter_editions
  for each row execute function public.newsletter_editions_touch();

-- ------------------------------------------------------------ deliveries ---
-- PER RECIPIENT, because "we sent the newsletter" is not a fact about anybody.
-- Provider acceptance, delivery, bounce, complaint and unsubscribe are five
-- different states and they are tracked as five different states.
create table if not exists public.newsletter_deliveries (
  id bigserial primary key,
  edition_id bigint not null references public.newsletter_editions (id) on delete cascade,
  subscriber_id uuid references public.newsletter_subscribers (id) on delete set null,
  email text not null,
  variant text not null default 'free',
  status text not null default 'queued',

  -- THE PROVIDER'S IDEMPOTENCY KEY, deterministic from the edition and the
  -- address. A retried batch presents the same key and the provider returns
  -- the original message instead of sending a second copy.
  idempotency_key text not null,
  provider_message_id text,

  attempts integer not null default 0,
  last_error text,
  -- an ambiguous provider response (a timeout, a 5xx with no body) is its own
  -- state: we do not know whether it sent, so it is never retried blind
  ambiguous boolean not null default false,

  queued_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  unsubscribed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.newsletter_deliveries add column if not exists ambiguous boolean not null default false;
alter table public.newsletter_deliveries add column if not exists variant text not null default 'free';

alter table public.newsletter_deliveries drop constraint if exists newsletter_deliveries_status_ck;
alter table public.newsletter_deliveries add constraint newsletter_deliveries_status_ck
  check (status in ('queued', 'accepted', 'delivered', 'bounced', 'complained', 'unsubscribed', 'failed', 'skipped'));

-- RULE 3: ONE DELIVERY ROW PER (EDITION, ADDRESS).
create unique index if not exists newsletter_deliveries_once_uk
  on public.newsletter_deliveries (edition_id, email);
create index if not exists newsletter_deliveries_edition_idx
  on public.newsletter_deliveries (edition_id, status);
create index if not exists newsletter_deliveries_message_idx
  on public.newsletter_deliveries (provider_message_id) where provider_message_id is not null;
create index if not exists newsletter_deliveries_email_idx
  on public.newsletter_deliveries (email);

create or replace function public.newsletter_deliveries_touch()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  new.updated_at := now();
  if new.status = 'accepted'   and new.accepted_at   is null then new.accepted_at   := now(); end if;
  if new.status = 'delivered'  and new.delivered_at  is null then new.delivered_at  := now(); end if;
  if new.status = 'bounced'    and new.bounced_at    is null then new.bounced_at    := now(); end if;
  if new.status = 'complained' and new.complained_at is null then new.complained_at := now(); end if;
  if new.status = 'failed'     and new.failed_at     is null then new.failed_at     := now(); end if;
  -- DELIVERY IS NOT ACCEPTANCE, and a later state never erases the earlier
  -- one: a delivered row keeps the moment the provider accepted it.
  if new.status in ('delivered', 'bounced', 'complained') and new.accepted_at is null then
    new.accepted_at := coalesce(old.accepted_at, now());
  end if;
  return new;
end;
$$;
drop trigger if exists newsletter_deliveries_touch_t on public.newsletter_deliveries;
create trigger newsletter_deliveries_touch_t before insert or update on public.newsletter_deliveries
  for each row execute function public.newsletter_deliveries_touch();

-- --------------------------------------------------------- provider events --
create table if not exists public.newsletter_events (
  id bigserial primary key,
  provider text not null default 'resend',
  event_id text,
  event_type text not null,
  email text,
  message_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_note text
);
-- RULE 4: A PROVIDER EVENT IS PROCESSED ONCE.
create unique index if not exists newsletter_events_once_uk
  on public.newsletter_events (provider, event_id) where event_id is not null;
create index if not exists newsletter_events_type_idx on public.newsletter_events (event_type, received_at desc);
create index if not exists newsletter_events_message_idx on public.newsletter_events (message_id) where message_id is not null;

-- --------------------------------------------------------------- run log ---
create table if not exists public.newsletter_runs (
  id bigserial primary key,
  run_id text,
  at timestamptz not null default now(),
  sport text,
  phase text not null,
  edition_key text,
  ok boolean not null default true,
  reason text,
  detail jsonb
);
create index if not exists newsletter_runs_at_idx on public.newsletter_runs (at desc);
create index if not exists newsletter_runs_sport_idx on public.newsletter_runs (sport, at desc);

-- ============================================================================
-- FUNCTIONS. Every public door is here; no client role touches a table.
-- ============================================================================

create or replace function public.newsletter_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.site_article_is_admin();
$$;
revoke all on function public.newsletter_is_admin() from public;
grant execute on function public.newsletter_is_admin() to authenticated;

-- A token digest. The raw token never reaches a column.
create or replace function public.newsletter_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

-- --------------------------------------------------------------- signup ----
-- SERVICE ROLE ONLY, and that is the security property rather than an
-- oversight: this returns the confirmation token, and a door that hands an
-- anonymous caller a confirmation token for any address they name is a door
-- that defeats double opt-in. The public path is the edge function, which
-- calls this and then EMAILS the token to the address it is for.
create or replace function public.newsletter_signup(
  p_email text,
  p_wants_cfb boolean,
  p_wants_nfl boolean,
  p_source text default 'public_form',
  p_user_agent text default null,
  p_ip_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_confirm text;
  v_manage text;
  v_row public.newsletter_subscribers;
  v_suppressed public.newsletter_suppressions;
  v_cooldown integer;
  v_per_ip integer;
  v_recent integer;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email');
  end if;
  if not (coalesce(p_wants_cfb, false) or coalesce(p_wants_nfl, false)) then
    return jsonb_build_object('ok', false, 'reason', 'no_sport_selected');
  end if;

  select * into v_suppressed from public.newsletter_suppressions where email = v_email;
  if found and v_suppressed.reason in ('bounce', 'complaint') then
    -- A COMPLAINT IS FOREVER UNTIL A PERSON CLEARS IT. Re-subscribing an
    -- address that reported us as spam is how a sending domain dies.
    return jsonb_build_object('ok', true, 'state', 'suppressed', 'reason', v_suppressed.reason);
  end if;

  select coalesce(signup_cooldown_seconds, 900), coalesce(signup_per_ip_hour, 12)
    into v_cooldown, v_per_ip from public.newsletter_settings where id = 1;

  -- PER SOURCE. Counted on the hashed address rather than the address itself,
  -- so the guard works without the table ever holding one. A caller over the
  -- cap gets the SAME answer everyone gets and no email is sent.
  if p_ip_hash is not null and v_per_ip is not null then
    select count(*) into v_recent from public.newsletter_subscribers
     where consent_ip_hash = p_ip_hash and consent_at > now() - interval '1 hour';
    if v_recent >= v_per_ip then
      return jsonb_build_object('ok', true, 'state', 'pending', 'throttled', 'source');
    end if;
  end if;

  v_confirm := encode(gen_random_bytes(32), 'hex');
  v_manage  := encode(gen_random_bytes(32), 'hex');

  select * into v_row from public.newsletter_subscribers where email = v_email;

  -- PER ADDRESS. A pending signup that was mailed a moment ago does not get a
  -- second message however many times the form is submitted; the preferences
  -- are still updated, because a person correcting their choice and pressing
  -- send again should not have to wait out a cooldown to be recorded.
  if found and v_row.status = 'pending' and v_row.confirm_sent_at is not null
     and v_row.confirm_sent_at > now() - make_interval(secs => v_cooldown) then
    update public.newsletter_subscribers
       set wants_cfb = coalesce(p_wants_cfb, false),
           wants_nfl = coalesce(p_wants_nfl, false),
           confirm_attempts = v_row.confirm_attempts + 1
     where id = v_row.id;
    return jsonb_build_object('ok', true, 'state', 'pending', 'throttled', 'cooldown',
      'subscriber_id', v_row.id);
  end if;
  if not found then
    insert into public.newsletter_subscribers
      (email, status, wants_cfb, wants_nfl, consent_source, consent_at, consent_user_agent,
       consent_ip_hash, confirm_token_hash, confirm_sent_at, confirm_expires_at, manage_token)
    values
      (v_email, 'pending', coalesce(p_wants_cfb, false), coalesce(p_wants_nfl, false),
       p_source, now(), p_user_agent, p_ip_hash,
       public.newsletter_token_hash(v_confirm), now(), now() + interval '7 days',
       v_manage)
    returning * into v_row;
    return jsonb_build_object('ok', true, 'state', 'pending', 'confirm_token', v_confirm,
      'manage_token', v_manage, 'subscriber_id', v_row.id);
  end if;

  -- ALREADY CONFIRMED: the preferences are updated and NO new confirmation is
  -- sent, because the address is already proven. The caller is told the state
  -- so it can send the right email; it is never told whether the address
  -- existed before this call, because that is an enumeration oracle.
  if v_row.status = 'confirmed' then
    update public.newsletter_subscribers
       set wants_cfb = wants_cfb or coalesce(p_wants_cfb, false),
           wants_nfl = wants_nfl or coalesce(p_wants_nfl, false)
     where id = v_row.id;
    return jsonb_build_object('ok', true, 'state', 'already_confirmed', 'subscriber_id', v_row.id);
  end if;

  -- PENDING OR PREVIOUSLY UNSUBSCRIBED: a fresh token, a fresh consent stamp.
  -- An unsubscribe followed by a new signup is a new consent and is recorded
  -- as one rather than quietly reviving the old one.
  update public.newsletter_subscribers
     set status = 'pending',
         wants_cfb = coalesce(p_wants_cfb, false),
         wants_nfl = coalesce(p_wants_nfl, false),
         consent_source = p_source,
         consent_at = now(),
         consent_user_agent = p_user_agent,
         consent_ip_hash = p_ip_hash,
         confirm_token_hash = public.newsletter_token_hash(v_confirm),
         confirm_sent_at = now(),
         confirm_expires_at = now() + interval '7 days',
         confirm_attempts = v_row.confirm_attempts + 1,
         manage_token = v_manage,
         unsubscribed_at = null,
         unsubscribe_source = null
   where id = v_row.id;
  return jsonb_build_object('ok', true, 'state', 'pending', 'confirm_token', v_confirm,
    'manage_token', v_manage, 'subscriber_id', v_row.id);
end;
$$;
revoke all on function public.newsletter_signup(text, boolean, boolean, text, text, text) from public, anon, authenticated;

-- -------------------------------------------------------------- confirm ----
create or replace function public.newsletter_confirm(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.newsletter_subscribers;
  v_manage text;
begin
  select * into v from public.newsletter_subscribers
   where confirm_token_hash = public.newsletter_token_hash(p_token);
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_token'); end if;
  if v.confirm_expires_at is not null and v.confirm_expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'token_expired');
  end if;
  v_manage := encode(gen_random_bytes(32), 'hex');
  update public.newsletter_subscribers
     set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()),
         confirm_token_hash = null, confirm_expires_at = null,
         manage_token = v_manage
   where id = v.id;
  -- confirming clears an unsubscribe-reason suppression; a bounce or a
  -- complaint is NOT cleared by anything a click can do
  delete from public.newsletter_suppressions where email = v.email and reason = 'unsubscribe';
  return jsonb_build_object('ok', true, 'email_masked', public.newsletter_mask_email(v.email),
    'wants_cfb', v.wants_cfb, 'wants_nfl', v.wants_nfl, 'manage_token', v_manage);
end;
$$;

-- ------------------------------------------------------- manage by token ---
create or replace function public.newsletter_mask_email(p_email text)
returns text
language sql
immutable
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else left(split_part(p_email, '@', 1), 1) || '***@' || split_part(p_email, '@', 2)
  end;
$$;

create or replace function public.newsletter_preferences_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v public.newsletter_subscribers;
begin
  select * into v from public.newsletter_subscribers
   where manage_token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_token'); end if;
  return jsonb_build_object('ok', true, 'status', v.status,
    'email_masked', public.newsletter_mask_email(v.email),
    'wants_cfb', v.wants_cfb, 'wants_nfl', v.wants_nfl,
    'confirmed_at', v.confirmed_at, 'consent_source', v.consent_source, 'consent_at', v.consent_at);
end;
$$;

create or replace function public.newsletter_preferences_set(
  p_token text, p_wants_cfb boolean, p_wants_nfl boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v public.newsletter_subscribers;
begin
  select * into v from public.newsletter_subscribers
   where manage_token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_token'); end if;
  -- TURNING BOTH OFF IS AN UNSUBSCRIBE, said in the one place that can be
  -- sure of it, rather than leaving a confirmed row nothing will ever send to.
  if not (coalesce(p_wants_cfb, false) or coalesce(p_wants_nfl, false)) then
    return public.newsletter_unsubscribe(p_token, 'all', 'preferences_page');
  end if;
  update public.newsletter_subscribers
     set wants_cfb = coalesce(p_wants_cfb, false),
         wants_nfl = coalesce(p_wants_nfl, false),
         status = case when status = 'unsubscribed' then 'confirmed' else status end
   where id = v.id;
  delete from public.newsletter_suppressions where email = v.email and reason = 'unsubscribe';
  return jsonb_build_object('ok', true, 'wants_cfb', coalesce(p_wants_cfb, false),
    'wants_nfl', coalesce(p_wants_nfl, false), 'email_masked', public.newsletter_mask_email(v.email));
end;
$$;

-- UNSUBSCRIBE WITHOUT A LOGIN, which is what the one-click header needs.
-- Scope 'all' suppresses the address; a single sport turns one preference off
-- and leaves the other alone.
create or replace function public.newsletter_unsubscribe(
  p_token text, p_scope text default 'all', p_source text default 'link'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.newsletter_subscribers;
  v_scope text := upper(coalesce(p_scope, 'all'));
begin
  select * into v from public.newsletter_subscribers
   where manage_token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_token'); end if;

  if v_scope = 'CFB' or v_scope = 'NFL' then
    update public.newsletter_subscribers
       set wants_cfb = case when v_scope = 'CFB' then false else wants_cfb end,
           wants_nfl = case when v_scope = 'NFL' then false else wants_nfl end
     where id = v.id
    returning * into v;
    if not (v.wants_cfb or v.wants_nfl) then
      v_scope := 'ALL';
    else
      return jsonb_build_object('ok', true, 'scope', v_scope, 'state', 'partial',
        'wants_cfb', v.wants_cfb, 'wants_nfl', v.wants_nfl,
        'email_masked', public.newsletter_mask_email(v.email));
    end if;
  end if;

  update public.newsletter_subscribers
     set status = 'unsubscribed', unsubscribed_at = now(), unsubscribe_source = p_source
   where id = v.id;
  insert into public.newsletter_suppressions (email, reason, detail)
  values (v.email, 'unsubscribe', p_source)
  on conflict (email) do update set reason = 'unsubscribe', detail = excluded.detail, updated_at = now()
    where public.newsletter_suppressions.reason not in ('bounce', 'complaint');
  return jsonb_build_object('ok', true, 'scope', 'ALL', 'state', 'unsubscribed',
    'email_masked', public.newsletter_mask_email(v.email));
end;
$$;

-- ------------------------------------------------------ the signed-in door --
-- An account holder managing their own preference, without ever exposing the
-- table. NOTE WHAT IT DOES NOT DO: it does not read a marketing consent off
-- the existence of an account. A subscriber row is created only when this is
-- called, which only happens when somebody ticks the box.
create or replace function public.newsletter_my_preferences()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v public.newsletter_subscribers; v_email text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select lower(btrim(email)) into v_email from auth.users where id = auth.uid();
  select * into v from public.newsletter_subscribers
   where user_id = auth.uid() or (v_email is not null and email = v_email)
   order by (user_id = auth.uid()) desc limit 1;
  if not found then
    return jsonb_build_object('ok', true, 'subscribed', false,
      'wants_cfb', false, 'wants_nfl', false, 'email_masked', public.newsletter_mask_email(v_email));
  end if;
  return jsonb_build_object('ok', true, 'subscribed', v.status = 'confirmed',
    'status', v.status, 'wants_cfb', v.wants_cfb, 'wants_nfl', v.wants_nfl,
    'consent_source', v.consent_source, 'consent_at', v.consent_at,
    'email_masked', public.newsletter_mask_email(v.email));
end;
$$;
revoke all on function public.newsletter_my_preferences() from public, anon;
grant execute on function public.newsletter_my_preferences() to authenticated;

create or replace function public.newsletter_set_my_preferences(
  p_wants_cfb boolean, p_wants_nfl boolean, p_source text default 'account_settings'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.newsletter_subscribers;
  v_email text;
  v_confirmed timestamptz;
  v_manage text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select lower(btrim(email)), email_confirmed_at into v_email, v_confirmed
    from auth.users where id = auth.uid();
  if v_email is null then return jsonb_build_object('ok', false, 'reason', 'no_account_email'); end if;
  -- AN UNVERIFIED ACCOUNT ADDRESS IS NOT A PROVEN ADDRESS, so it goes through
  -- the same double opt-in a stranger does — the edge function will see the
  -- pending state and send the confirmation.
  if v_confirmed is null then
    return jsonb_build_object('ok', false, 'reason', 'account_email_unverified');
  end if;
  if exists (select 1 from public.newsletter_suppressions
              where email = v_email and reason in ('bounce', 'complaint')) then
    return jsonb_build_object('ok', false, 'reason', 'address_suppressed');
  end if;

  select * into v from public.newsletter_subscribers where email = v_email;
  if not found then
    if not (coalesce(p_wants_cfb, false) or coalesce(p_wants_nfl, false)) then
      return jsonb_build_object('ok', true, 'subscribed', false, 'wants_cfb', false, 'wants_nfl', false);
    end if;
    v_manage := encode(gen_random_bytes(32), 'hex');
    insert into public.newsletter_subscribers
      (email, user_id, status, wants_cfb, wants_nfl, consent_source, consent_at, manage_token)
    values (v_email, auth.uid(), 'confirmed', coalesce(p_wants_cfb, false), coalesce(p_wants_nfl, false),
            p_source, now(), v_manage);
    return jsonb_build_object('ok', true, 'subscribed', true,
      'wants_cfb', coalesce(p_wants_cfb, false), 'wants_nfl', coalesce(p_wants_nfl, false));
  end if;

  if not (coalesce(p_wants_cfb, false) or coalesce(p_wants_nfl, false)) then
    update public.newsletter_subscribers
       set status = 'unsubscribed', user_id = coalesce(user_id, auth.uid()),
           unsubscribed_at = now(), unsubscribe_source = p_source
     where id = v.id;
    insert into public.newsletter_suppressions (email, reason, detail)
    values (v_email, 'unsubscribe', p_source)
    on conflict (email) do update set reason = 'unsubscribe', detail = excluded.detail, updated_at = now()
      where public.newsletter_suppressions.reason not in ('bounce', 'complaint');
    return jsonb_build_object('ok', true, 'subscribed', false, 'wants_cfb', false, 'wants_nfl', false);
  end if;

  update public.newsletter_subscribers
     set status = 'confirmed', user_id = coalesce(user_id, auth.uid()),
         wants_cfb = coalesce(p_wants_cfb, false), wants_nfl = coalesce(p_wants_nfl, false),
         consent_source = coalesce(v.consent_source, p_source),
         consent_at = coalesce(v.consent_at, now()),
         unsubscribed_at = null, unsubscribe_source = null
   where id = v.id;
  delete from public.newsletter_suppressions where email = v_email and reason = 'unsubscribe';
  return jsonb_build_object('ok', true, 'subscribed', true,
    'wants_cfb', coalesce(p_wants_cfb, false), 'wants_nfl', coalesce(p_wants_nfl, false));
end;
$$;
revoke all on function public.newsletter_set_my_preferences(boolean, boolean, text) from public, anon;
grant execute on function public.newsletter_set_my_preferences(boolean, boolean, text) to authenticated;

-- ------------------------------------------------------------ suppression --
create or replace function public.newsletter_suppress(
  p_email text, p_reason text, p_detail text default null, p_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email = '' then return jsonb_build_object('ok', false, 'reason', 'no_email'); end if;
  insert into public.newsletter_suppressions (email, reason, detail, provider_event_id)
  values (v_email, p_reason, p_detail, p_event_id)
  on conflict (email) do update
    set reason = case
          -- a complaint outranks a bounce outranks an unsubscribe: a stronger
          -- reason is never downgraded by a later, weaker one
          when public.newsletter_suppressions.reason = 'complaint' then 'complaint'
          when excluded.reason = 'complaint' then 'complaint'
          when public.newsletter_suppressions.reason = 'bounce' and excluded.reason = 'unsubscribe' then 'bounce'
          else excluded.reason end,
        detail = coalesce(excluded.detail, public.newsletter_suppressions.detail),
        provider_event_id = coalesce(excluded.provider_event_id, public.newsletter_suppressions.provider_event_id),
        updated_at = now();
  update public.newsletter_subscribers
     set status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now()),
         unsubscribe_source = coalesce(unsubscribe_source, p_reason)
   where email = v_email and status <> 'unsubscribed';
  return jsonb_build_object('ok', true, 'email_masked', public.newsletter_mask_email(v_email), 'reason', p_reason);
end;
$$;

-- ------------------------------------------------------------ eligibility --
-- THE ONLY PLACE AN ADDRESS LEAVES THE DATABASE, and it is service-role only.
-- Eligibility is recomputed here every time it is asked for — confirmed,
-- wants this sport, and not suppressed — so a bounce recorded thirty seconds
-- ago removes the address from a send already in progress.
-- IS THIS ADDRESS A PAYING MEMBER? Read from the billing table the paywall
-- already reads, matched by account id first and by a CONFIRMED account email
-- second. Written with dynamic SQL and a to_regclass guard so this whole file
-- still installs on a project that has not applied supabase/billing.sql — on
-- such a project everybody is a free reader, which is the safe default.
create or replace function public.newsletter_is_member(p_email text, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v boolean := false;
begin
  if to_regclass('public.subscriptions') is null then return false; end if;
  execute $q$
    select exists (
      select 1 from public.subscriptions x
       join auth.users u on u.id = x.user_id
       where (u.id = $2 or (lower(u.email) = $1 and u.email_confirmed_at is not null))
         and x.status in ('active', 'trialing')
         and (x.price_id = 'owner_comp' or x.current_period_end is null or x.current_period_end > now()))
  $q$ into v using lower(btrim(coalesce(p_email, ''))), p_user_id;
  return coalesce(v, false);
end;
$$;
revoke all on function public.newsletter_is_member(text, uuid) from public, anon, authenticated;

create or replace function public.newsletter_eligible(p_sport text)
returns table (subscriber_id uuid, email text, wants_cfb boolean, wants_nfl boolean,
               user_id uuid, manage_token text, is_member boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.email, s.wants_cfb, s.wants_nfl, s.user_id, s.manage_token,
         public.newsletter_is_member(s.email, s.user_id)
    from public.newsletter_subscribers s
   where s.status = 'confirmed'
     and ((upper(p_sport) = 'CFB' and s.wants_cfb) or (upper(p_sport) = 'NFL' and s.wants_nfl))
     and not exists (select 1 from public.newsletter_suppressions x where x.email = s.email)
   order by s.created_at asc, s.id asc;
$$;
revoke all on function public.newsletter_eligible(text) from public, anon, authenticated;

create or replace function public.newsletter_eligible_count(p_sport text)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.newsletter_eligible(p_sport);
$$;
revoke all on function public.newsletter_eligible_count(text) from public, anon;
grant execute on function public.newsletter_eligible_count(text) to authenticated;

-- ------------------------------------------------------------ the lease ----
-- CONCURRENCY PROTECTION, in one statement. Two dispatchers that both decide
-- Monday's edition is due call this; exactly one gets true. The lease expires
-- so a runner that dies mid-send does not wedge the sport forever.
create or replace function public.newsletter_claim_edition(
  p_edition_key text, p_owner text, p_ttl_seconds integer default 1800
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ok boolean;
begin
  update public.newsletter_editions
     set lease_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => greatest(60, coalesce(p_ttl_seconds, 1800)))
   where edition_key = p_edition_key
     and (lease_owner is null or lease_owner = p_owner
          or lease_expires_at is null or lease_expires_at < now())
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;
revoke all on function public.newsletter_claim_edition(text, text, integer) from public, anon, authenticated;

create or replace function public.newsletter_release_edition(p_edition_key text, p_owner text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_ok boolean;
begin
  update public.newsletter_editions
     set lease_owner = null, lease_expires_at = null
   where edition_key = p_edition_key and lease_owner = p_owner
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;
revoke all on function public.newsletter_release_edition(text, text) from public, anon, authenticated;

-- ------------------------------------------------------ the operator view --
-- COUNTS AND REDACTED ADDRESSES. Everything an operator needs to run the
-- system; nothing a stolen operator session could turn into a mailing list.
create or replace function public.newsletter_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.newsletter_is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.newsletter_settings s where s.id = 1),
    'subscribers', jsonb_build_object(
      'confirmed', (select count(*) from public.newsletter_subscribers where status = 'confirmed'),
      'pending',   (select count(*) from public.newsletter_subscribers where status = 'pending'),
      'unsubscribed', (select count(*) from public.newsletter_subscribers where status = 'unsubscribed'),
      'cfb', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_cfb),
      'nfl', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_nfl),
      'both', (select count(*) from public.newsletter_subscribers where status = 'confirmed' and wants_cfb and wants_nfl)),
    'eligible', jsonb_build_object(
      'CFB', public.newsletter_eligible_count('CFB'),
      'NFL', public.newsletter_eligible_count('NFL')),
    'suppressions', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb)
                       from (select reason, count(*) as n from public.newsletter_suppressions group by reason) t),
    'editions', (select coalesce(jsonb_agg(e order by e.scheduled_at desc), '[]'::jsonb) from (
        select id, edition_key, sport, season, slate_week, edition_date, status, hold_reason, hold_detail,
               scheduled_at, deadline_at, data_cutoff_at, subject, preview_text, game_count,
               eligible_recipients, counts, content_hash, sent_at, updated_at,
               lease_owner, lease_expires_at
          from public.newsletter_editions order by scheduled_at desc nulls last limit 12) e),
    'runs', (select coalesce(jsonb_agg(r order by r.at desc), '[]'::jsonb) from (
        select run_id, at, sport, phase, edition_key, ok, reason, detail
          from public.newsletter_runs order by at desc limit 40) r)
  );
end;
$$;
revoke all on function public.newsletter_admin_overview() from public, anon;
grant execute on function public.newsletter_admin_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- WHAT IS ACTUALLY INSTALLED, ANSWERED BY THE DATABASE ITSELF.
--
-- A launch checklist that a person ticks off from memory is a launch checklist
-- that is wrong. This answers the configuration questions from catalogue
-- state, so `node tools/newsletter/run.js doctor` reports what IS rather than
-- what somebody believes: which extensions are enabled, whether the pg_cron
-- job exists and on what schedule, whether the two database settings the cron
-- job body reads are set, and how much of the contract's own surface is here.
--
-- IT NEVER RETURNS A SECRET. The service key and the project URL are reported
-- as set / not set. `edgedesk.service_key` is a credential and the boolean is
-- the entire answer anybody needs from here.
--
-- Service role only: this is a deployment question, not a reader's.
-- ---------------------------------------------------------------------------
create or replace function public.newsletter_install_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_url  text := current_setting('edgedesk.project_url', true);
  v_key  text := current_setting('edgedesk.service_key', true);
  v_cron jsonb := '{}'::jsonb;
begin
  if to_regclass('cron.job') is not null then
    execute $q$
      select coalesce(jsonb_build_object(
               'present', true,
               'schedule', (select schedule from cron.job where jobname = 'newsletter_dispatch'),
               'active',   (select active   from cron.job where jobname = 'newsletter_dispatch')), '{}'::jsonb)
    $q$ into v_cron;
    if v_cron->>'schedule' is null then
      v_cron := jsonb_build_object('present', false, 'why', 'pg_cron is installed but newsletter_dispatch is not scheduled — run supabase/newsletter_cron.sql');
    end if;
  else
    v_cron := jsonb_build_object('present', false, 'why', 'pg_cron is not installed — enable it in Database -> Extensions, then run supabase/newsletter_cron.sql');
  end if;

  return jsonb_build_object(
    'schema_version', 'newsletter.sql',
    'extensions', jsonb_build_object(
      'pg_cron',  exists (select 1 from pg_extension where extname = 'pg_cron'),
      'pg_net',   exists (select 1 from pg_extension where extname = 'pg_net'),
      'pgcrypto', exists (select 1 from pg_extension where extname = 'pgcrypto')),
    'cron', v_cron,
    'db_settings', jsonb_build_object(
      'edgedesk.project_url', case when coalesce(v_url, '') = '' then 'not set' else 'set' end,
      'edgedesk.service_key', case when coalesce(v_key, '') = '' then 'not set' else 'set' end),
    'tables', (select coalesce(jsonb_object_agg(t, to_regclass('public.' || t) is not null), '{}'::jsonb)
                 from unnest(array['newsletter_settings','newsletter_settings_audit','newsletter_subscribers',
                                   'newsletter_suppressions','newsletter_editions','newsletter_deliveries',
                                   'newsletter_events','newsletter_runs']) t),
    'functions', (select coalesce(jsonb_object_agg(f, to_regproc('public.' || f) is not null), '{}'::jsonb)
                    from unnest(array['newsletter_signup','newsletter_confirm','newsletter_unsubscribe',
                                      'newsletter_preferences_get','newsletter_preferences_set','newsletter_suppress',
                                      'newsletter_eligible','newsletter_eligible_count','newsletter_is_member',
                                      'newsletter_is_admin','newsletter_claim_edition','newsletter_release_edition',
                                      'newsletter_admin_overview','newsletter_admin_edition','newsletter_admin_set',
                                      'newsletter_my_preferences','newsletter_set_my_preferences']) f),
    'gate', (select jsonb_build_object(
      'sending_enabled',    s.sending_enabled,
      'cfb_enabled',        s.cfb_enabled,
      'nfl_enabled',        s.nfl_enabled,
      'dispatcher_enabled', s.dispatcher_enabled,
      'from_name',          s.from_name,
      'from_email',         s.from_email,
      'reply_to_email',     s.reply_to_email,
      'mailing_address',    s.mailing_address,
      'site_url',           s.site_url,
      -- a count, not the addresses: an operator needs to know whether a test
      -- recipient is configured, not to have one printed into a run log
      'test_recipients',    coalesce(array_length(s.test_recipients, 1), 0)
    ) from public.newsletter_settings s where s.id = 1),
    'counts', jsonb_build_object(
      'subscribers_confirmed',   (select count(*) from public.newsletter_subscribers where status = 'confirmed'),
      'subscribers_pending',     (select count(*) from public.newsletter_subscribers where status = 'pending'),
      'subscribers_unsubscribed',(select count(*) from public.newsletter_subscribers where status = 'unsubscribed'),
      'suppressions',            (select count(*) from public.newsletter_suppressions),
      'editions',                (select count(*) from public.newsletter_editions),
      'editions_sent',           (select count(*) from public.newsletter_editions where status = 'sent'),
      'deliveries',              (select count(*) from public.newsletter_deliveries),
      'provider_events',         (select count(*) from public.newsletter_events))
  );
end;
$$;
revoke all on function public.newsletter_install_status() from public, anon, authenticated;

create or replace function public.newsletter_admin_edition(p_edition_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_id bigint;
begin
  if not public.newsletter_is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select id into v_id from public.newsletter_editions where edition_key = p_edition_key;
  if v_id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_edition'); end if;
  return jsonb_build_object(
    'ok', true,
    'edition', (select to_jsonb(e) from public.newsletter_editions e where e.id = v_id),
    'delivery_counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
        from (select status, count(*) as n from public.newsletter_deliveries
               where edition_id = v_id group by status) t),
    -- ERRORS WITH THE ADDRESS REDACTED. An operator needs to know that six
    -- sends failed with "domain not found"; they do not need the six domains.
    'errors', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select public.newsletter_mask_email(email) as email_masked, status, attempts,
               ambiguous, last_error, updated_at
          from public.newsletter_deliveries
         where edition_id = v_id and (last_error is not null or status in ('failed', 'bounced', 'complained'))
         order by updated_at desc limit 50) x)
  );
end;
$$;
revoke all on function public.newsletter_admin_edition(text) from public, anon;
grant execute on function public.newsletter_admin_edition(text) to authenticated;

-- An operator moving a switch. A direct update policy would work too; this is
-- a function so the audit trigger sees an updated_by that is not guessable
-- from the session alone, and so the allowed field list is stated once.
create or replace function public.newsletter_admin_set(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text;
  allowed text[] := array['sending_enabled', 'cfb_enabled', 'nfl_enabled', 'dispatcher_enabled',
    'from_name', 'from_email', 'reply_to_email', 'mailing_address', 'site_url',
    'send_hour_local', 'send_minute_local', 'send_zone', 'retry_window_minutes',
    'target_games', 'max_games', 'cfb_threshold', 'nfl_threshold',
    'cfb_expansion_threshold', 'nfl_expansion_threshold',
    'quote_stale_hours', 'record_stale_hours', 'gap_confidence_floor', 'test_recipients',
    'signup_cooldown_seconds', 'signup_per_ip_hour'];
begin
  if not public.newsletter_is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  for k in select jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) loop
    if not (k = any(allowed)) then
      raise exception 'newsletter_admin_set: % is not a settable field', k using errcode = '22023';
    end if;
  end loop;
  update public.newsletter_settings s
     set sending_enabled = coalesce((p_patch->>'sending_enabled')::boolean, s.sending_enabled),
         cfb_enabled = coalesce((p_patch->>'cfb_enabled')::boolean, s.cfb_enabled),
         nfl_enabled = coalesce((p_patch->>'nfl_enabled')::boolean, s.nfl_enabled),
         dispatcher_enabled = coalesce((p_patch->>'dispatcher_enabled')::boolean, s.dispatcher_enabled),
         from_name = coalesce(p_patch->>'from_name', s.from_name),
         from_email = coalesce(p_patch->>'from_email', s.from_email),
         reply_to_email = coalesce(p_patch->>'reply_to_email', s.reply_to_email),
         mailing_address = coalesce(p_patch->>'mailing_address', s.mailing_address),
         site_url = coalesce(p_patch->>'site_url', s.site_url),
         send_hour_local = coalesce((p_patch->>'send_hour_local')::smallint, s.send_hour_local),
         send_minute_local = coalesce((p_patch->>'send_minute_local')::smallint, s.send_minute_local),
         send_zone = coalesce(p_patch->>'send_zone', s.send_zone),
         retry_window_minutes = coalesce((p_patch->>'retry_window_minutes')::integer, s.retry_window_minutes),
         target_games = coalesce((p_patch->>'target_games')::smallint, s.target_games),
         max_games = coalesce((p_patch->>'max_games')::smallint, s.max_games),
         cfb_threshold = coalesce((p_patch->>'cfb_threshold')::numeric, s.cfb_threshold),
         nfl_threshold = coalesce((p_patch->>'nfl_threshold')::numeric, s.nfl_threshold),
         cfb_expansion_threshold = coalesce((p_patch->>'cfb_expansion_threshold')::numeric, s.cfb_expansion_threshold),
         nfl_expansion_threshold = coalesce((p_patch->>'nfl_expansion_threshold')::numeric, s.nfl_expansion_threshold),
         quote_stale_hours = coalesce((p_patch->>'quote_stale_hours')::integer, s.quote_stale_hours),
         record_stale_hours = coalesce((p_patch->>'record_stale_hours')::integer, s.record_stale_hours),
         gap_confidence_floor = coalesce((p_patch->>'gap_confidence_floor')::numeric, s.gap_confidence_floor),
         signup_cooldown_seconds = coalesce((p_patch->>'signup_cooldown_seconds')::integer, s.signup_cooldown_seconds),
         signup_per_ip_hour = coalesce((p_patch->>'signup_per_ip_hour')::integer, s.signup_per_ip_hour),
         test_recipients = coalesce(
           (select array_agg(value::text) from jsonb_array_elements_text(p_patch->'test_recipients')),
           s.test_recipients),
         updated_by = auth.uid()
   where s.id = 1;
  return (select to_jsonb(s) from public.newsletter_settings s where s.id = 1);
end;
$$;
revoke all on function public.newsletter_admin_set(jsonb) from public, anon;
grant execute on function public.newsletter_admin_set(jsonb) to authenticated;

-- ============================================================================
-- ROW LEVEL SECURITY. Every table on, and the subscriber table has no select
-- policy for any client role at all.
-- ============================================================================
alter table public.newsletter_settings          enable row level security;
alter table public.newsletter_settings_audit    enable row level security;
alter table public.newsletter_subscribers       enable row level security;
alter table public.newsletter_suppressions      enable row level security;
alter table public.newsletter_editions          enable row level security;
alter table public.newsletter_deliveries        enable row level security;
alter table public.newsletter_events            enable row level security;
alter table public.newsletter_runs              enable row level security;

-- NOTHING a browser sends reaches these tables. Supabase grants the client
-- roles table DML on the public schema by default and relies on RLS to decide
-- what they may touch, so the defence is the empty policy set, plus an
-- explicit revoke on the two tables where an accidental default would be
-- worst.
revoke all on public.newsletter_subscribers from anon, authenticated;
revoke all on public.newsletter_suppressions from anon, authenticated;
revoke all on public.newsletter_deliveries from anon, authenticated;
revoke all on public.newsletter_events from anon, authenticated;
revoke all on public.newsletter_settings from anon;
revoke all on public.newsletter_settings_audit from anon, authenticated;

-- An operator may READ the edition list and the run log directly, because
-- neither carries an address.
drop policy if exists newsletter_editions_admin_read on public.newsletter_editions;
create policy newsletter_editions_admin_read on public.newsletter_editions
  for select to authenticated using (public.newsletter_is_admin());
drop policy if exists newsletter_runs_admin_read on public.newsletter_runs;
create policy newsletter_runs_admin_read on public.newsletter_runs
  for select to authenticated using (public.newsletter_is_admin());
drop policy if exists newsletter_settings_admin_read on public.newsletter_settings;
create policy newsletter_settings_admin_read on public.newsletter_settings
  for select to authenticated using (public.newsletter_is_admin());

grant select on public.newsletter_editions to authenticated;
grant select on public.newsletter_runs to authenticated;
grant select on public.newsletter_settings to authenticated;

comment on table public.newsletter_subscribers is
  'Newsletter consent, one row per address. NO CLIENT ROLE MAY READ THIS TABLE: '
  'row level security is on and there is no select policy for anon, authenticated '
  'or an operator. Every legitimate read goes through a security-definer '
  'function that returns the caller''s own row or an aggregate.';
comment on column public.newsletter_subscribers.manage_token is
  'The token in this subscriber''s unsubscribe and preference links. Stored raw '
  'because every sent email has to carry it; it confers nothing but the ability '
  'to unsubscribe or change sport preferences for this address, and the page it '
  'opens shows a masked address. The CONFIRMATION token, which proves mailbox '
  'control, is stored as a digest instead.';
comment on table public.newsletter_editions is
  'One row per sport, season, slate week and scheduled edition date — the unique '
  'index is the identity. Carries the exact research and market snapshot the '
  'edition was built from, so a sent newsletter is reproducible from the row.';
comment on table public.newsletter_deliveries is
  'Per-recipient delivery state. Accepted, delivered, bounced, complained and '
  'unsubscribed are five separate states and provider acceptance is never read '
  'as delivery. One row per (edition, address), which is what makes a retry '
  'incapable of sending a second copy.';
comment on column public.newsletter_settings.sending_enabled is
  'THE GLOBAL KILL SWITCH and the launch gate. Defaults to false: a freshly '
  'applied migration cannot email anybody. Editions still build, validate and '
  'preview while it is off.';

-- ============================================================================
-- Report: every row should say ok.
-- ============================================================================
select 1 as step, 'every table exists' as check,
  case when to_regclass('public.newsletter_settings') is not null
        and to_regclass('public.newsletter_subscribers') is not null
        and to_regclass('public.newsletter_suppressions') is not null
        and to_regclass('public.newsletter_editions') is not null
        and to_regclass('public.newsletter_deliveries') is not null
        and to_regclass('public.newsletter_events') is not null
        and to_regclass('public.newsletter_runs') is not null
       then 'ok' else 'CHECK THIS' end as outcome
union all select 2, 'sending is OFF until an operator turns it on',
  case when (select not sending_enabled from public.newsletter_settings where id = 1)
       then 'ok' else 'CHECK THIS — sending_enabled is already true' end
union all select 3, 'one edition per sport/season/week/date',
  case when exists (select 1 from pg_indexes where tablename = 'newsletter_editions'
      and indexname = 'newsletter_editions_identity_uk') then 'ok' else 'CHECK THIS' end
union all select 3.5, 'one send per sport per body of work',
  case when exists (select 1 from pg_indexes where tablename = 'newsletter_editions'
      and indexname = 'newsletter_editions_sent_body_uk') then 'ok'
      else 'CHECK THIS — two editions of one sport share a content hash in sending/sent' end
union all select 4, 'one delivery row per (edition, address)',
  case when exists (select 1 from pg_indexes where tablename = 'newsletter_deliveries'
      and indexname = 'newsletter_deliveries_once_uk') then 'ok' else 'CHECK THIS' end
union all select 5, 'a provider event is unique',
  case when exists (select 1 from pg_indexes where tablename = 'newsletter_events'
      and indexname = 'newsletter_events_once_uk') then 'ok' else 'CHECK THIS' end
union all select 6, 'RLS is on for every newsletter table',
  case when (select bool_and(relrowsecurity) from pg_class
              where relname in ('newsletter_settings','newsletter_subscribers','newsletter_suppressions',
                                'newsletter_editions','newsletter_deliveries','newsletter_events',
                                'newsletter_runs','newsletter_settings_audit')
                and relnamespace = 'public'::regnamespace) then 'ok' else 'CHECK THIS' end
union all select 7, 'no client role can read a subscriber address',
  case when not exists (select 1 from pg_policies where tablename = 'newsletter_subscribers')
        and not exists (select 1 from information_schema.role_table_grants
                         where table_schema = 'public' and table_name = 'newsletter_subscribers'
                           and grantee in ('anon','authenticated'))
       then 'ok' else 'CHECK THIS' end
union all select 8, 'signup is not callable by a browser',
  case when not exists (select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'newsletter_signup'
        and grantee in ('anon','authenticated')) then 'ok' else 'CHECK THIS' end
union all select 9, 'the eligibility door is not callable by a browser',
  case when not exists (select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'newsletter_eligible'
        and grantee in ('anon','authenticated')) then 'ok' else 'CHECK THIS' end
union all select 10, 'the edition lease is not callable by a browser',
  case when not exists (select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'newsletter_claim_edition'
        and grantee in ('anon','authenticated')) then 'ok' else 'CHECK THIS' end
union all select 11, 'an account holder can manage their own preference',
  case when exists (select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'newsletter_set_my_preferences'
        and grantee = 'authenticated') then 'ok' else 'CHECK THIS' end
union all select 12, 'the settings audit trigger is installed',
  case when exists (select 1 from pg_trigger where tgname = 'newsletter_settings_audit_t')
       then 'ok' else 'CHECK THIS' end
union all select 13, 'a sent edition must carry a body and at least one game',
  case when exists (select 1 from pg_constraint where conname = 'newsletter_editions_sent_shape_ck')
       then 'ok' else 'CHECK THIS' end
union all select 14, 'a held edition must state a reason',
  case when exists (select 1 from pg_constraint where conname = 'newsletter_editions_hold_shape_ck')
       then 'ok' else 'CHECK THIS' end
union all select 15, 'the public signup door is rate limited',
  case when exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='newsletter_settings'
        and column_name in ('signup_cooldown_seconds','signup_per_ip_hour')
      having count(*) = 2) then 'ok' else 'CHECK THIS' end
union all select 16, 'the membership test degrades to free on a bare project',
  case when to_regprocedure('public.newsletter_is_member(text,uuid)') is not null
       then 'ok' else 'CHECK THIS' end
union all select 17, 'the operator allowlist is the article system''s',
  case when to_regprocedure('public.newsletter_is_admin()') is not null then 'ok' else 'CHECK THIS' end
union all select 18, 'the install report is callable by the service role only',
  case when to_regprocedure('public.newsletter_install_status()') is not null
    and not exists (select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'newsletter_install_status'
        and grantee in ('anon','authenticated')) then 'ok' else 'CHECK THIS' end
order by 1;

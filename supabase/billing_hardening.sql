-- ===========================================================================
-- EdgeDesk — billing hardening: ONE access rule, ONE atomic writer, and the
-- records that let Stripe and Supabase be reconciled instead of hoped at.
--
-- WHY THIS EXISTS. A customer signed up, entered a card, and the site never
-- opened. The account existed; public.subscriptions had no row for it. Nothing
-- in the system could ever have repaired that on its own:
--
--   * the webhook could only name a customer from the ONE delivery that carried
--     the account id (checkout.session.completed). Miss that delivery, or have
--     it arrive without the id, and every later event for that customer stayed
--     unresolved forever, because a Payment Link cannot put the account id on
--     the subscription;
--   * nothing ever asked Stripe again — not the success page, not the paywall,
--     not a schedule. The only repair was a human typing a row in by hand;
--   * the access rule existed in six copies (app.html, index.html,
--     community_is_entitled, tennis_record, the referral report, comp_trial.sql)
--     and two of them disagreed: index.html treated an EXPIRED trial as paid, so
--     an expired comp_trial account was bounced between "you already have
--     access" and the paywall and could not buy at all.
--
-- WHAT THIS FILE ADDS (additive, idempotent; nothing is dropped or rewritten):
--
--   billing_row_grants_access()     THE rule. Every gate calls this.
--   billing_access_for(uuid)        the decision for one account, as jsonb
--   my_billing_access()             the same, for the caller only (browser)
--   billing_apply_subscription_state()   the ONLY writer of Stripe state into
--                                   subscriptions: one row lock, the ordering
--                                   guard, the comp guard, the duplicate guard
--   billing_resolve_user()          who an event belongs to, every way we know
--   billing_customers               Stripe customer -> account, known BEFORE
--                                   payment when checkout is server-created
--   billing_checkout_sessions       every Checkout Session we created
--   billing_sync_log                every reconciliation, with a support ref
--   billing_alerts                  deduplicated things a human should see
--   billing_admin_*()               diagnostics, operator-only
--
-- DESIGN RULES IT ENFORCES
--   * Stripe can GRANT access to anybody, and can only REVOKE access that
--     Stripe granted. A row entitled without a Stripe subscription behind it
--     (owner_comp, comp_trial, a hand-made row) is never downgraded by a Stripe
--     state; the disagreement is raised as an alert for a human instead.
--   * An older state never overwrites a newer one. "Newer" is Stripe's event
--     time for a state read off an event, and the moment we asked Stripe for a
--     state read live — a live read is the truth at that moment, so it beats
--     every event created before it.
--   * A cancelled DUPLICATE subscription never locks out the subscription the
--     customer is actually using.
--
-- Run AFTER billing.sql and stripe_webhook.sql. referral_codes.sql,
-- subscription_price.sql, community_posts.sql and affiliates.sql are optional
-- and may run before or after. Ends in a report: every row should say ok.
-- ===========================================================================

do $guard$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'public.subscriptions does not exist. Run supabase/billing.sql first.';
  end if;
  if to_regclass('public.stripe_events') is null then
    raise exception 'public.stripe_events does not exist. Run supabase/stripe_webhook.sql first.';
  end if;
  if to_regprocedure('public.stripe_user_by_email(text)') is null then
    raise exception 'public.stripe_user_by_email(text) does not exist. Run supabase/stripe_webhook.sql first.';
  end if;
end
$guard$;

-- ── 1. THE RULE ─────────────────────────────────────────────────────────────
-- The business rule, exactly as every existing copy states it, now in one place:
--
--   ACCESS      active, trialing — while current_period_end is in the future
--               (or unknown). A comp_trial is `trialing` with its deadline in
--               current_period_end, so it closes on that date with no job.
--               owner_comp + active — always; a comp does not lapse.
--               past_due — for 21 days past current_period_end: Stripe is still
--               retrying the card, and cutting off on the first failure locks
--               out somebody Stripe is still collecting from.
--   NO ACCESS   canceled, unpaid, incomplete, incomplete_expired, paused, a
--               null status, and any status Stripe adds that this rule has not
--               been told about.
--
-- Pure and immutable: given the same row and the same instant it always answers
-- the same, so it can be tested as a table of cases.
create or replace function public.billing_row_grants_access(
  p_status text, p_price_id text, p_current_period_end timestamptz, p_at timestamptz default now())
returns boolean
language sql
immutable
as $$
  select coalesce(
       (p_status = 'active' and coalesce(p_price_id, '') = 'owner_comp')
    or (p_status in ('active', 'trialing')
        and (p_current_period_end is null or p_current_period_end >= p_at))
    or (p_status = 'past_due'
        and (p_current_period_end is null or p_at - p_current_period_end < interval '21 days'))
  , false);
$$;
comment on function public.billing_row_grants_access(text, text, timestamptz, timestamptz) is
  'THE access rule. active/trialing until current_period_end; owner_comp+active always; '
  'past_due for 21 days past current_period_end; everything else no access. Every gate in '
  'the product calls this (or mirrors it, tested equal).';

-- ── 2. RECORDS ──────────────────────────────────────────────────────────────

-- Stripe customer -> account. A customer belongs to exactly one account; an
-- account may have several customers (a Payment Link makes a new customer per
-- checkout). Written when a checkout is created server-side — BEFORE payment —
-- so the identities have already met by the time any event arrives.
create table if not exists public.billing_customers (
  stripe_customer_id text        primary key,
  user_id            uuid        not null references auth.users(id) on delete cascade,
  source             text        not null default 'unknown',
  livemode           boolean,
  email              text,
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now()
);
alter table public.billing_customers add column if not exists source       text not null default 'unknown';
alter table public.billing_customers add column if not exists livemode     boolean;
alter table public.billing_customers add column if not exists email        text;
alter table public.billing_customers add column if not exists created_at   timestamptz not null default now();
alter table public.billing_customers add column if not exists last_seen_at timestamptz not null default now();
create index if not exists billing_customers_by_user on public.billing_customers (user_id);

-- Every Checkout Session create_checkout_session made. The session id comes back
-- on checkout.session.completed, and on the success URL, so either names the
-- account without trusting anything the browser says.
create table if not exists public.billing_checkout_sessions (
  id                 text        primary key,
  user_id            uuid        not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  kind               text,
  price_id           text,
  trial_days         integer,
  status             text        not null default 'open',
  url                text,
  livemode           boolean,
  ref                text,
  subscription_id    text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz,
  completed_at       timestamptz
);
alter table public.billing_checkout_sessions add column if not exists stripe_customer_id text;
alter table public.billing_checkout_sessions add column if not exists kind            text;
alter table public.billing_checkout_sessions add column if not exists price_id        text;
alter table public.billing_checkout_sessions add column if not exists trial_days      integer;
alter table public.billing_checkout_sessions add column if not exists status          text not null default 'open';
alter table public.billing_checkout_sessions add column if not exists url             text;
alter table public.billing_checkout_sessions add column if not exists livemode        boolean;
alter table public.billing_checkout_sessions add column if not exists ref             text;
alter table public.billing_checkout_sessions add column if not exists subscription_id text;
alter table public.billing_checkout_sessions add column if not exists expires_at      timestamptz;
alter table public.billing_checkout_sessions add column if not exists completed_at    timestamptz;
create index if not exists billing_checkout_sessions_by_user
  on public.billing_checkout_sessions (user_id, created_at desc);

-- Every reconciliation attempt, and every rate-limit admission. `ref` is the
-- reference a customer is shown when access could not be confirmed, so the
-- support email that follows lands on the exact attempt.
create table if not exists public.billing_sync_log (
  id                     bigint      generated always as identity primary key,
  at                     timestamptz not null default now(),
  user_id                uuid        references auth.users(id) on delete cascade,
  source                 text        not null,
  outcome                text        not null,
  ok                     boolean     not null default true,
  ref                    text,
  stripe_customer_ids    text[],
  stripe_subscription_id text,
  stripe_status          text,
  db_status_before       text,
  db_status_after        text,
  access_before          boolean,
  access_after           boolean,
  duration_ms            integer,
  note                   text
);
create index if not exists billing_sync_log_by_user on public.billing_sync_log (user_id, at desc);
create index if not exists billing_sync_log_by_ref  on public.billing_sync_log (ref) where ref is not null;
create index if not exists billing_sync_log_recent  on public.billing_sync_log (at desc);

-- Things a human should see, deduplicated: the same open problem raised a
-- hundred times is one row with occurrences = 100, not a hundred rows.
create table if not exists public.billing_alerts (
  id                     bigint      generated always as identity primary key,
  kind                   text        not null,
  dedupe_key             text        not null,
  user_id                uuid        references auth.users(id) on delete set null,
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_event_id        text,
  detail                 jsonb       not null default '{}'::jsonb,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  occurrences            integer     not null default 1,
  resolved_at            timestamptz,
  resolved_note          text
);
create unique index if not exists billing_alerts_open_uk
  on public.billing_alerts (dedupe_key) where resolved_at is null;
create index if not exists billing_alerts_recent on public.billing_alerts (last_seen_at desc);

-- One row: when the scheduled reconciliation last ran. Lets an unauthenticated
-- cron poke be debounced in the database rather than trusted.
create table if not exists public.billing_sweep_state (
  id          smallint    primary key default 1 check (id = 1),
  last_run_at timestamptz,
  last_result jsonb
);
insert into public.billing_sweep_state (id) values (1) on conflict (id) do nothing;

-- The webhook ledger learns how often a delivery was attempted and why it failed.
alter table public.stripe_events add column if not exists attempts         integer not null default 1;
alter table public.stripe_events add column if not exists last_delivery_at timestamptz;
alter table public.stripe_events add column if not exists processed_at     timestamptz;
alter table public.stripe_events add column if not exists last_error       text;
alter table public.stripe_events add column if not exists resolved_how     text;
alter table public.stripe_events add column if not exists livemode         boolean;

-- The subscription row learns WHEN it last agreed with Stripe, and how.
alter table public.subscriptions add column if not exists stripe_synced_at timestamptz;
alter table public.subscriptions add column if not exists sync_source      text;
alter table public.subscriptions add column if not exists livemode         boolean;
-- Repeated from stripe_webhook.sql so this file stands on its own.
alter table public.subscriptions add column if not exists last_event_at    timestamptz;
alter table public.subscriptions add column if not exists last_event_id    text;

-- ONE ROW PER STRIPE SUBSCRIPTION — but only if the data already allows it. A
-- unique index that fails to build would roll this whole file back; one that is
-- skipped is reported below as CHECK THIS, with the offending ids, for a human.
do $uk$
declare n int;
begin
  select count(*) into n from (
    select stripe_subscription_id from public.subscriptions
     where stripe_subscription_id is not null
     group by 1 having count(*) > 1) d;
  if n = 0 then
    execute 'create unique index if not exists subscriptions_stripe_subscription_uk '
         || 'on public.subscriptions (stripe_subscription_id) where stripe_subscription_id is not null';
  else
    raise notice 'subscriptions_stripe_subscription_uk NOT created: % Stripe subscription ids sit on more than one account', n;
  end if;
end
$uk$;

-- Nothing here is client-readable. The edge functions use the service role.
alter table public.billing_customers         enable row level security;
alter table public.billing_checkout_sessions enable row level security;
alter table public.billing_sync_log          enable row level security;
alter table public.billing_alerts            enable row level security;
alter table public.billing_sweep_state       enable row level security;
revoke all on public.billing_customers, public.billing_checkout_sessions, public.billing_sync_log,
              public.billing_alerts, public.billing_sweep_state from anon, authenticated;
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.billing_customers, public.billing_checkout_sessions, '
         || 'public.billing_sync_log, public.billing_alerts, public.billing_sweep_state to service_role';
  end if;
end
$g$;

-- ── 3. ALERTS ───────────────────────────────────────────────────────────────
-- kinds: unresolved_event, identity_conflict, duplicate_active_subscriptions,
-- stripe_active_db_missing, db_active_stripe_inactive, webhook_failing,
-- sync_failed, dispute. p_resolved records something that was ALREADY repaired
-- automatically (a lockout the reconciler fixed): history, not a to-do.
create or replace function public.billing_raise_alert(
  p_kind text, p_dedupe text, p_user uuid, p_customer text, p_subscription text,
  p_event text, p_detail jsonb, p_resolved boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id bigint; v_user uuid;
begin
  -- an alert must never fail the write it is reporting on
  v_user := case when p_user is not null and exists (select 1 from auth.users where id = p_user) then p_user end;
  if p_resolved then
    insert into public.billing_alerts (kind, dedupe_key, user_id, stripe_customer_id, stripe_subscription_id,
                                       stripe_event_id, detail, resolved_at, resolved_note)
    values (p_kind, p_kind || ':' || coalesce(p_dedupe, '-') || ':' || gen_random_uuid()::text, v_user, p_customer,
            p_subscription, p_event, coalesce(p_detail, '{}'::jsonb), now(), 'repaired automatically')
    returning id into v_id;
    return v_id;
  end if;
  insert into public.billing_alerts (kind, dedupe_key, user_id, stripe_customer_id, stripe_subscription_id,
                                     stripe_event_id, detail)
  values (p_kind, p_kind || ':' || coalesce(p_dedupe, '-'), v_user, p_customer, p_subscription, p_event,
          coalesce(p_detail, '{}'::jsonb))
  on conflict (dedupe_key) where resolved_at is null do update
     set last_seen_at = now(),
         occurrences  = public.billing_alerts.occurrences + 1,
         detail       = excluded.detail,
         user_id      = coalesce(excluded.user_id, public.billing_alerts.user_id),
         stripe_event_id = coalesce(excluded.stripe_event_id, public.billing_alerts.stripe_event_id)
  returning id into v_id;
  return v_id;
exception when others then
  raise warning 'billing_raise_alert(%): %', p_kind, sqlerrm;
  return null;
end;
$$;

-- Close open alerts a successful reconciliation has made moot.
create or replace function public.billing_clear_alerts(p_user uuid, p_kinds text[], p_note text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  update public.billing_alerts set resolved_at = now(), resolved_note = p_note
   where resolved_at is null and user_id = p_user and kind = any(p_kinds);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── 4. NAMING A CUSTOMER ────────────────────────────────────────────────────
-- Link a Stripe customer to an account. Never REMAPS: a customer already linked
-- to a different account is an identity conflict for a human, not something to
-- overwrite. On a new link, every delivery that arrived for this customer
-- before anybody could name it is resolved retroactively — which is the repair
-- the old webhook promised ("reconciled by the next event") and never made.
create or replace function public.billing_link_customer(
  p_customer_id text, p_user uuid, p_source text, p_livemode boolean default null, p_email text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_owner uuid; n int := 0;
begin
  if p_customer_id is null or p_user is null then return 'skipped'; end if;
  if p_customer_id !~ '^cus_[A-Za-z0-9]+$' then return 'invalid'; end if;
  if not exists (select 1 from auth.users where id = p_user) then return 'no_such_user'; end if;

  insert into public.billing_customers (stripe_customer_id, user_id, source, livemode, email)
  values (p_customer_id, p_user, coalesce(p_source, 'unknown'), p_livemode, lower(nullif(btrim(p_email), '')))
  on conflict (stripe_customer_id) do nothing;

  select user_id into v_owner from public.billing_customers where stripe_customer_id = p_customer_id;
  if v_owner is distinct from p_user then
    perform public.billing_raise_alert('identity_conflict', 'cus:' || p_customer_id, p_user, p_customer_id, null, null,
      jsonb_build_object('customer_already_linked_to', v_owner, 'attempted_by', p_source));
    return 'conflict';
  end if;

  update public.billing_customers
     set last_seen_at = now(),
         email = coalesce(lower(nullif(btrim(p_email), '')), email),
         livemode = coalesce(p_livemode, livemode)
   where stripe_customer_id = p_customer_id;

  update public.stripe_events
     set user_id = p_user, resolved = true,
         resolved_how = 'retroactive: ' || coalesce(p_source, 'link'),
         note = coalesce(note || ' · ', '') || 'resolved later, when the customer was linked (' || coalesce(p_source, 'link') || ')'
   where customer_id = p_customer_id and not resolved;
  get diagnostics n = row_count;

  update public.billing_alerts set resolved_at = now(), resolved_note = 'customer linked via ' || coalesce(p_source, 'link')
   where resolved_at is null and kind = 'unresolved_event' and stripe_customer_id = p_customer_id;

  return case when n > 0 then 'linked; resolved ' || n || ' earlier deliveries' else 'linked' end;
end;
$$;

-- Who does this event belong to? Every way we know, in descending order of
-- certainty, and no guessing:
--   1 metadata.supabase_user_id   set server-side by create_checkout_session
--   2 client_reference_id         set server-side too (or by a Payment Link URL)
--   3 checkout session            a session create_checkout_session recorded
--   4 known customer              billing_customers
--   5 known subscription          subscriptions.stripe_subscription_id
--   6 known customer (legacy)     subscriptions.stripe_customer_id
--   7 confirmed email             stripe_user_by_email: CONFIRMED accounts only
-- An id that names no account is rejected rather than written — a foreign-key
-- failure would answer 500 and Stripe would retry a doomed write for three days.
-- When two strong sources disagree the stronger wins and the disagreement is
-- returned, so the caller raises it.
create or replace function public.billing_resolve_user(
  p_metadata_user text default null, p_client_reference text default null,
  p_customer_id text default null, p_subscription_id text default null,
  p_session_id text default null, p_email text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_cands jsonb := '[]'::jsonb; v_rejected jsonb := '[]'::jsonb;
  v_id uuid; v_user uuid; v_how text; v_conflict text;
  r record;
begin
  -- 1, 2: the ids we put on the Stripe objects ourselves
  for r in select * from (values (1, 'metadata', p_metadata_user), (2, 'client_reference_id', p_client_reference)) t(pri, how, val) loop
    if r.val is null or btrim(r.val) = '' then continue; end if;
    if r.val !~ c_uuid then
      v_rejected := v_rejected || jsonb_build_object('how', r.how, 'why', 'not a uuid'); continue;
    end if;
    v_id := r.val::uuid;
    if not exists (select 1 from auth.users where id = v_id) then
      v_rejected := v_rejected || jsonb_build_object('how', r.how, 'why', 'names no account', 'id', v_id); continue;
    end if;
    v_cands := v_cands || jsonb_build_object('how', r.how, 'user_id', v_id);
  end loop;
  -- 3: a session we created
  if p_session_id is not null then
    select s.user_id into v_id from public.billing_checkout_sessions s where s.id = p_session_id;
    if v_id is not null then v_cands := v_cands || jsonb_build_object('how', 'checkout_session', 'user_id', v_id); end if;
  end if;
  -- 4: a customer we have linked
  if p_customer_id is not null then
    select b.user_id into v_id from public.billing_customers b where b.stripe_customer_id = p_customer_id;
    if v_id is not null then v_cands := v_cands || jsonb_build_object('how', 'known customer', 'user_id', v_id); end if;
  end if;
  -- 5, 6: what an existing row already says
  if p_subscription_id is not null then
    select s.user_id into v_id from public.subscriptions s where s.stripe_subscription_id = p_subscription_id limit 1;
    if v_id is not null then v_cands := v_cands || jsonb_build_object('how', 'known subscription', 'user_id', v_id); end if;
  end if;
  if p_customer_id is not null then
    select s.user_id into v_id from public.subscriptions s where s.stripe_customer_id = p_customer_id limit 1;
    if v_id is not null then v_cands := v_cands || jsonb_build_object('how', 'known customer', 'user_id', v_id); end if;
  end if;

  if jsonb_array_length(v_cands) > 0 then
    v_user := (v_cands -> 0 ->> 'user_id')::uuid;
    v_how  := v_cands -> 0 ->> 'how';
    select string_agg(distinct (c ->> 'how') || ' says ' || (c ->> 'user_id'), '; ') into v_conflict
      from jsonb_array_elements(v_cands) c where (c ->> 'user_id')::uuid <> v_user;
  elsif p_email is not null and btrim(p_email) <> '' then
    -- 7: last resort, confirmed accounts only (the rule lives in that function)
    v_user := public.stripe_user_by_email(p_email);
    if v_user is not null then v_how := 'confirmed email match'; end if;
  end if;

  return jsonb_build_object('user_id', v_user, 'how', coalesce(v_how, 'unresolved'),
                            'conflict', v_conflict, 'rejected', v_rejected);
end;
$$;

-- ── 5. THE ONLY WRITER OF STRIPE STATE ──────────────────────────────────────
-- One statement's worth of decisions under one row lock, so two deliveries (or
-- a delivery and a browser-triggered sync) racing for the same account cannot
-- interleave a read and a write.
--
--   p_as_of          when this state was TRUE: the event's `created` for a state
--                    read off an event, the moment of the request for a state
--                    read live from Stripe
--   p_live           the state came from asking Stripe, not from an event body
--   p_authoritative  the state is the BEST of every subscription the account has
--                    (the reconciler's pick), not just the one an event is about
--
-- Refusals are answers, not errors: 'stale', 'comp', 'protected_entitlement',
-- 'other_subscription_entitled', 'duplicate_entitled_subscription',
-- 'subscription_belongs_to_other_user', 'no_such_user'.
create or replace function public.billing_apply_subscription_state(
  p_user uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_price_id text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_as_of timestamptz,
  p_source text,
  p_live boolean default false,
  p_authoritative boolean default false,
  p_event_id text default null,
  p_event_at timestamptz default null,
  p_livemode boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e        public.subscriptions%rowtype;
  v_now    timestamptz := now();
  v_asof   timestamptz := coalesce(p_as_of, p_event_at, now());
  v_other  uuid;
  v_ex_ent boolean := false;
  v_in_ent boolean;
  v_ex_asof timestamptz;
  v_status text;
  v_price  text;
  v_pe     timestamptz;
  v_link   text;
  v_created boolean := false;
  v_changed boolean;
begin
  if p_user is null then return jsonb_build_object('applied', false, 'reason', 'no_user'); end if;
  if not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('applied', false, 'reason', 'no_such_user');
  end if;

  -- A subscription is one account's. If another row already holds this id, the
  -- event has been resolved to the wrong person somewhere; say so, write nothing.
  if p_subscription_id is not null then
    select s.user_id into v_other from public.subscriptions s
     where s.stripe_subscription_id = p_subscription_id and s.user_id <> p_user limit 1;
    if v_other is not null then
      perform public.billing_raise_alert('identity_conflict', 'sub:' || p_subscription_id, p_user, p_customer_id,
        p_subscription_id, p_event_id, jsonb_build_object('subscription_already_on', v_other, 'source', p_source));
      return jsonb_build_object('applied', false, 'reason', 'subscription_belongs_to_other_user');
    end if;
  end if;

  if p_customer_id is not null then
    v_link := public.billing_link_customer(p_customer_id, p_user, p_source, p_livemode, null);
  end if;

  select * into e from public.subscriptions where user_id = p_user for update;

  if not found then
    begin
      insert into public.subscriptions
        (user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id,
         stripe_subscription_id, last_event_at, last_event_id, stripe_synced_at, sync_source, livemode,
         created_at, updated_at)
      values
        (p_user, p_status, case when p_status is not null then p_price_id end, p_current_period_end,
         coalesce(p_cancel_at_period_end, false), p_customer_id, p_subscription_id,
         p_event_at, case when p_event_at is not null then p_event_id end,
         case when p_live then v_asof end, p_source, p_livemode, v_now, v_now);
      v_created := true;
    exception when unique_violation then
      -- somebody else created the row a moment ago: take the update path
      select * into e from public.subscriptions where user_id = p_user for update;
      if not found then
        return jsonb_build_object('applied', false, 'reason', 'subscription_belongs_to_other_user');
      end if;
    end;
    if v_created then
      return jsonb_build_object('applied', true, 'reason', 'created', 'created', true, 'changed', true,
        'status_before', null, 'status_after', p_status, 'access_before', false,
        'access_after', public.billing_row_grants_access(p_status, p_price_id, p_current_period_end, v_now),
        'customer_link', v_link);
    end if;
  end if;

  -- A COMP IS NOT STRIPE'S TO WRITE. Never sold, so no Stripe event describes it.
  if e.status = 'active' and coalesce(e.price_id, '') = 'owner_comp' then
    return jsonb_build_object('applied', false, 'reason', 'comp', 'status_before', e.status, 'status_after', e.status,
                              'access_before', true, 'access_after', true);
  end if;

  -- AN OLDER STATE NEVER OVERWRITES A NEWER ONE. Two clocks are involved and
  -- they are never compared exactly: a LIVE read is stamped with OUR clock and
  -- ordered against other live reads (same clock); against Stripe's event
  -- timestamps it only loses to one more than five minutes newer, so a few
  -- seconds of clock skew can never make a fresh read of Stripe look stale.
  -- A state read off an EVENT BODY (Stripe unreachable) is the degraded path
  -- and is held to the strict rule: older than anything the row reflects, no.
  v_ex_asof := greatest(e.last_event_at, e.stripe_synced_at);
  if (p_live and ((e.stripe_synced_at is not null and v_asof < e.stripe_synced_at)
                  or (e.last_event_at is not null and v_asof < e.last_event_at - interval '5 minutes')))
     or (not p_live and v_ex_asof is not null and v_asof < v_ex_asof) then
    return jsonb_build_object('applied', false, 'reason', 'stale', 'status_before', e.status, 'status_after', e.status,
      'access_before', public.billing_row_grants_access(e.status, e.price_id, e.current_period_end, v_now),
      'access_after', public.billing_row_grants_access(e.status, e.price_id, e.current_period_end, v_now));
  end if;

  v_ex_ent := public.billing_row_grants_access(e.status, e.price_id, e.current_period_end, v_now);
  v_status := coalesce(p_status, e.status);
  v_pe     := coalesce(p_current_period_end, e.current_period_end);
  -- A Stripe state carries a Stripe price. A comp sentinel is never left on a
  -- row Stripe now describes — that is how a comp_trial customer who went on to
  -- pay used to be skipped by every report that excludes comps.
  v_price := case
    when p_status is null then e.price_id
    else coalesce(p_price_id, case when coalesce(e.price_id, '') in ('owner_comp', 'comp_trial') then null else e.price_id end)
  end;
  v_in_ent := public.billing_row_grants_access(v_status, v_price, v_pe, v_now);

  if p_status is not null and v_ex_ent and not v_in_ent then
    -- STRIPE ONLY REVOKES WHAT STRIPE GRANTED. A row entitled with no Stripe
    -- subscription behind it was granted here; a human decides whether Stripe's
    -- view should end it.
    if e.stripe_subscription_id is null then
      if coalesce(e.price_id, '') <> 'comp_trial' then
        perform public.billing_raise_alert('db_active_stripe_inactive', 'user:' || p_user, p_user, p_customer_id,
          p_subscription_id, p_event_id,
          jsonb_build_object('row', 'entitled without a Stripe subscription', 'stripe_status', p_status, 'source', p_source));
      end if;
      return jsonb_build_object('applied', false, 'reason', 'protected_entitlement', 'status_before', e.status,
                                'status_after', e.status, 'access_before', true, 'access_after', true);
    end if;
    -- A CANCELLED DUPLICATE MUST NOT LOCK OUT THE SUBSCRIPTION IN USE.
    if not p_authoritative and p_subscription_id is distinct from e.stripe_subscription_id then
      return jsonb_build_object('applied', false, 'reason', 'other_subscription_entitled', 'status_before', e.status,
                                'status_after', e.status, 'access_before', true, 'access_after', true);
    end if;
  end if;

  -- TWO LIVE SUBSCRIPTIONS. Keep the one already on the row and flag it; the
  -- reconciler (which sees all of them) decides which is shown.
  if p_status is not null and not p_authoritative and v_ex_ent and v_in_ent
     and e.stripe_subscription_id is not null and p_subscription_id is not null
     and p_subscription_id <> e.stripe_subscription_id then
    perform public.billing_raise_alert('duplicate_active_subscriptions', 'user:' || p_user, p_user, p_customer_id,
      p_subscription_id, p_event_id,
      jsonb_build_object('on_row', e.stripe_subscription_id, 'also_live', p_subscription_id, 'source', p_source));
    return jsonb_build_object('applied', false, 'reason', 'duplicate_entitled_subscription', 'status_before', e.status,
                              'status_after', e.status, 'access_before', true, 'access_after', true);
  end if;

  v_changed := v_status is distinct from e.status
            or v_price is distinct from e.price_id
            or v_pe is distinct from e.current_period_end
            or coalesce(p_cancel_at_period_end, e.cancel_at_period_end) is distinct from e.cancel_at_period_end
            or coalesce(p_customer_id, e.stripe_customer_id) is distinct from e.stripe_customer_id
            or coalesce(p_subscription_id, e.stripe_subscription_id) is distinct from e.stripe_subscription_id;

  update public.subscriptions set
    status                 = v_status,
    price_id               = v_price,
    current_period_end     = v_pe,
    cancel_at_period_end   = coalesce(p_cancel_at_period_end, cancel_at_period_end),
    stripe_customer_id     = coalesce(p_customer_id, stripe_customer_id),
    stripe_subscription_id = coalesce(p_subscription_id, stripe_subscription_id),
    last_event_id          = case when p_event_at is not null and (last_event_at is null or p_event_at >= last_event_at)
                                  then p_event_id else last_event_id end,
    last_event_at          = case when p_event_at is not null then greatest(last_event_at, p_event_at) else last_event_at end,
    stripe_synced_at       = case when p_live then greatest(stripe_synced_at, v_asof) else stripe_synced_at end,
    sync_source            = p_source,
    livemode               = coalesce(p_livemode, livemode),
    updated_at             = v_now
  where user_id = p_user;

  return jsonb_build_object('applied', true, 'reason', 'updated', 'created', false, 'changed', v_changed,
    'status_before', e.status, 'status_after', v_status, 'access_before', v_ex_ent, 'access_after', v_in_ent,
    'customer_link', v_link);
end;
$$;

-- ── 6. THE LEDGER WRITE ─────────────────────────────────────────────────────
-- Every delivery, keyed on Stripe's id, counting attempts — so "this event has
-- failed four times" is a query, not a guess.
create or replace function public.billing_record_event(
  p_id text, p_type text, p_created timestamptz, p_customer text, p_subscription text,
  p_payload jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r record;
begin
  insert into public.stripe_events
    (id, type, stripe_created, customer_id, subscription_id, payload, resolved, applied, note, attempts,
     last_delivery_at, livemode)
  values
    (p_id, p_type, p_created, p_customer, p_subscription, p_payload, false, false, p_note, 1, now(),
     case p_payload ->> 'livemode' when 'true' then true when 'false' then false end)
  on conflict (id) do update set
     attempts         = public.stripe_events.attempts + 1,
     last_delivery_at = now(),
     type             = excluded.type,
     stripe_created   = coalesce(excluded.stripe_created, public.stripe_events.stripe_created),
     customer_id      = coalesce(excluded.customer_id, public.stripe_events.customer_id),
     subscription_id  = coalesce(excluded.subscription_id, public.stripe_events.subscription_id),
     payload          = excluded.payload,
     livemode         = coalesce(excluded.livemode, public.stripe_events.livemode),
     note             = coalesce(excluded.note, public.stripe_events.note)
  returning attempts, resolved, applied, user_id into r;
  return jsonb_build_object('attempts', r.attempts, 'resolved', r.resolved, 'applied', r.applied, 'user_id', r.user_id);
end;
$$;

-- ── 7. THE DECISION, FOR ONE ACCOUNT ────────────────────────────────────────
-- What every page asks. `should_sync` says the row may simply be behind Stripe
-- (missing, no status, a Stripe-backed period that ended with no renewal
-- recorded, a payment problem) AND there is some sign this account has been to
-- checkout, AND nobody asked Stripe about it in the last five minutes — so a
-- page only spends a Stripe call when one could change the answer.
--
-- `offer` is what a locked account should be shown:
--   trial         never had a Stripe subscription (including an ended comp_trial)
--   resubscribe   had one, and it ended
--   fix_payment   has one, and the card is failing
--   none          has access
create or replace function public.billing_access_for(p_user uuid, p_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s record; v_found boolean;
  v_has boolean := false; v_reason text; v_comp boolean := false; v_ctrial boolean := false;
  v_backed boolean := false; v_until timestamptz; v_offer text := 'trial'; v_sync boolean := false;
  v_last_sync timestamptz; v_evidence boolean := false;
begin
  if p_user is null then
    return jsonb_build_object('signed_in', false, 'has_access', false, 'reason', 'signed_out',
                              'offer', 'trial', 'should_sync', false);
  end if;

  select su.status, su.price_id, su.current_period_end, su.cancel_at_period_end, su.stripe_customer_id,
         su.stripe_subscription_id, su.stripe_synced_at, su.last_event_at
    into s from public.subscriptions su where su.user_id = p_user;
  v_found := found;
  select max(l.at) into v_last_sync from public.billing_sync_log l where l.user_id = p_user;

  v_evidence := exists (select 1 from public.billing_consents c where c.user_id = p_user)
             or exists (select 1 from public.billing_checkout_sessions cs where cs.user_id = p_user)
             or exists (select 1 from public.billing_customers bc where bc.user_id = p_user);

  if not v_found then
    v_sync := v_evidence and (v_last_sync is null or v_last_sync < p_at - interval '5 minutes');
    return jsonb_build_object('signed_in', true, 'user_id', p_user, 'has_access', false, 'reason', 'no_subscription',
      'row_exists', false, 'offer', 'trial', 'should_sync', v_sync, 'last_sync_at', v_last_sync,
      'subscription', null);
  end if;

  v_comp   := s.status = 'active' and coalesce(s.price_id, '') = 'owner_comp';
  v_ctrial := coalesce(s.price_id, '') = 'comp_trial';
  v_backed := s.stripe_subscription_id is not null;
  v_has    := public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, p_at);
  v_reason := case
    when v_comp                                   then 'comp'
    when v_has and s.status = 'past_due'          then 'past_due_grace'
    when v_has and v_ctrial                       then 'comp_trial'
    when v_has                                    then s.status
    when s.status is null                         then 'no_status'
    when s.status in ('active', 'trialing') and v_ctrial then 'comp_trial_ended'
    when s.status in ('active', 'trialing')       then 'period_ended'
    when s.status = 'past_due'                    then 'past_due_expired'
    when s.status in ('canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused') then s.status
    else 'unknown_status' end;
  v_until := case
    when v_comp then null
    when s.status = 'past_due' and s.current_period_end is not null then s.current_period_end + interval '21 days'
    else s.current_period_end end;
  v_offer := case
    when v_has then 'none'
    when v_backed and s.status in ('past_due', 'unpaid') then 'fix_payment'
    when not v_backed and s.stripe_customer_id is null then 'trial'
    else 'resubscribe' end;
  if not v_has then
    v_sync := (v_backed or s.stripe_customer_id is not null or s.status is null or v_evidence)
              and (v_last_sync is null or v_last_sync < p_at - interval '5 minutes');
  end if;

  return jsonb_build_object(
    'signed_in', true, 'user_id', p_user, 'has_access', v_has, 'reason', v_reason, 'row_exists', true,
    'is_comp', v_comp, 'is_comp_trial', v_ctrial, 'stripe_backed', v_backed,
    'access_until', v_until, 'offer', v_offer, 'should_sync', v_sync,
    'last_sync_at', v_last_sync, 'stripe_synced_at', s.stripe_synced_at, 'last_event_at', s.last_event_at,
    'subscription', jsonb_build_object(
      'status', s.status, 'price_id', s.price_id, 'current_period_end', s.current_period_end,
      'cancel_at_period_end', s.cancel_at_period_end, 'stripe_customer_id', s.stripe_customer_id));
end;
$$;

-- What the browser calls. No argument: it can only ever describe the caller.
create or replace function public.my_billing_access()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.billing_access_for(auth.uid(), now());
$$;

-- ── 8. RATE LIMITS AND THE SCHEDULE ─────────────────────────────────────────
-- A reader-triggered reconciliation costs Stripe calls, so it is admitted at
-- most p_max times per window per account and source. Serialised per account
-- with an advisory lock so two tabs cannot both slip under the limit.
create or replace function public.billing_sync_admit(
  p_user uuid, p_source text, p_max integer default 12, p_window_s integer default 600, p_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int; v_oldest timestamptz;
begin
  if p_user is null then return jsonb_build_object('admitted', false, 'retry_after_s', 60); end if;
  perform pg_advisory_xact_lock(hashtextextended('billing_sync:' || p_user::text || ':' || coalesce(p_source, ''), 0));
  select count(*), min(at) into n, v_oldest from public.billing_sync_log
   where user_id = p_user and source = p_source and outcome = 'admitted'
     and at > now() - make_interval(secs => p_window_s);
  if n >= p_max then
    return jsonb_build_object('admitted', false,
      'retry_after_s', greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_s) - now())))::int));
  end if;
  insert into public.billing_sync_log (user_id, source, outcome, ok, ref) values (p_user, p_source, 'admitted', true, p_ref);
  return jsonb_build_object('admitted', true);
end;
$$;

-- The scheduled sweep may be poked by anybody (pg_cron sends no key, the same
-- shape as research_cron), so the database debounces it: once per interval.
create or replace function public.billing_sweep_admit(p_min_interval_s integer default 540)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.billing_sweep_state set last_run_at = now()
   where id = 1 and (last_run_at is null or last_run_at < now() - make_interval(secs => p_min_interval_s));
  return found;
end;
$$;

-- Accounts the sweep should ask Stripe about, most urgent first.
create or replace function public.billing_sweep_candidates(p_limit integer default 25)
returns table (user_id uuid, why text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- `cooldown`: how long after the sweep last looked at an account it may look
  -- again for this reason. Soon after a checkout is when a missed webhook shows
  -- up, so that is checked every 20 minutes for the first hour, then every six
  -- hours — an abandoned checkout must not cost a Stripe search every sweep.
  with c as (
    -- went to checkout recently and has nothing Stripe-backed that grants access:
    -- exactly the customer who paid while nothing was listening
    select bc.user_id, 'recent_checkout_without_access'::text as why, 1 as pri,
           case when max(bc.created_at) > now() - interval '1 hour' then interval '20 minutes' else interval '6 hours' end as cooldown
      from public.billing_consents bc
     where bc.created_at > now() - interval '3 days'
       and not exists (select 1 from public.subscriptions s where s.user_id = bc.user_id
                         and s.stripe_subscription_id is not null
                         and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()))
     group by bc.user_id
    union all
    select cs.user_id, 'open_checkout_session', 2, interval '2 hours'
      from public.billing_checkout_sessions cs
     where cs.status = 'open' and cs.created_at < now() - interval '20 minutes' and cs.created_at > now() - interval '2 days'
    union all
    select s.user_id, 'stale_period_end', 3, interval '30 minutes' from public.subscriptions s
     where s.stripe_subscription_id is not null and s.status in ('active', 'trialing')
       and s.current_period_end < now() - interval '10 minutes'
    union all
    select s.user_id, 'no_status', 3, interval '30 minutes' from public.subscriptions s where s.status is null
    union all
    select s.user_id, 'payment_trouble', 4, interval '1 hour' from public.subscriptions s
     where s.stripe_subscription_id is not null and s.status in ('past_due', 'incomplete', 'unpaid', 'paused')
       and coalesce(s.stripe_synced_at, s.last_event_at, 'epoch'::timestamptz) < now() - interval '1 hour'
    union all
    -- periodic proof that an entitled row is still entitled in Stripe
    select s.user_id, 'periodic_verify', 5, interval '1 day' from public.subscriptions s
     where s.stripe_subscription_id is not null
       and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())
       and coalesce(s.stripe_synced_at, s.last_event_at, 'epoch'::timestamptz) < now() - interval '3 days'
  ), d as (
    select distinct on (c.user_id) c.user_id, c.why, c.pri from c
     where c.user_id is not null
       and not exists (select 1 from public.subscriptions s where s.user_id = c.user_id
                         and s.status = 'active' and coalesce(s.price_id, '') = 'owner_comp')
       and not exists (select 1 from public.billing_sync_log l where l.user_id = c.user_id
                         and l.source = 'cron' and l.at > now() - c.cooldown)
     order by c.user_id, c.pri
  )
  select d.user_id, d.why from d order by d.pri, d.user_id limit greatest(1, least(p_limit, 100));
$$;

-- Deliveries nobody could name, with the email they carried, for the sweep to
-- ask Stripe about.
create or replace function public.billing_unresolved_events(p_limit integer default 25)
returns table (id text, type text, customer_id text, email text, stripe_created timestamptz, attempts integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id, e.type, e.customer_id,
         lower(nullif(btrim(coalesce(o -> 'customer_details' ->> 'email', o ->> 'customer_email', o ->> 'email')), '')),
         e.stripe_created, e.attempts
    from public.stripe_events e
    cross join lateral (select e.payload -> 'data' -> 'object' as o) x
   where not e.resolved
     and e.created_at > now() - interval '14 days'
     and e.customer_id is not null
     and e.type in ('checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
                    'customer.subscription.deleted', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.paid')
   order by e.created_at desc
   limit greatest(1, least(p_limit, 100));
$$;

-- ── 9. DIAGNOSTICS, FOR THE OPERATOR ────────────────────────────────────────
-- One operator list for the business consoles (growth.sql's precedent): the
-- partner program's admins when installed, else the problem-report admins,
-- else the founding operator. Checked against the CALLER's own token.
create or replace function public.billing_is_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v boolean := false;
begin
  if auth.uid() is null then return false; end if;
  if to_regprocedure('public.affiliate_is_admin()') is not null then
    execute 'select public.affiliate_is_admin()' into v;
    if v then return true; end if;
  end if;
  if to_regclass('public.issue_report_admins') is not null then
    execute 'select exists (select 1 from public.issue_report_admins where user_id = $1)' into v using auth.uid();
    if v then return true; end if;
  end if;
  return auth.uid() = 'e7e46801-80c4-4f47-b718-4aff211c8d3a'::uuid;
end;
$$;

-- Everything about one account's billing, from this database. (What Stripe
-- says live is added by sync_subscription's admin_inspect, which can ask.)
create or replace function public.billing_user_report(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  u record; s record; v_access jsonb; v_custs text[]; v_mis text[] := '{}';
  v_email text; v_consents int; v_last_ok timestamptz;
begin
  select id, email, email_confirmed_at, created_at into u from auth.users where id = p_user;
  if not found then return null; end if;
  v_email := lower(u.email);
  select * into s from public.subscriptions where user_id = p_user;
  v_access := public.billing_access_for(p_user, now());
  select coalesce(array_agg(stripe_customer_id order by created_at), '{}') into v_custs
    from public.billing_customers where user_id = p_user;
  select count(*) into v_consents from public.billing_consents where user_id = p_user;
  select max(at) into v_last_ok from public.billing_sync_log
   where user_id = p_user and ok and outcome not in ('admitted', 'rate_limited');

  -- what looks wrong, from here
  if s.user_id is null and v_consents > 0 then v_mis := array_append(v_mis, 'consent recorded but no subscription row'); end if;
  if s.user_id is not null and s.status is null then v_mis := array_append(v_mis, 'row has no status'); end if;
  if s.stripe_subscription_id is not null and s.status in ('active', 'trialing') and s.current_period_end < now() then
    v_mis := array_append(v_mis, 'Stripe-backed period ended with no renewal recorded (stale)'); end if;
  if s.status in ('active', 'trialing') and s.current_period_end is null and coalesce(s.price_id, '') <> 'owner_comp' then
    v_mis := array_append(v_mis, 'entitled with no period end: access never expires'); end if;
  if coalesce(s.price_id, '') in ('comp_trial', 'owner_comp') and s.stripe_subscription_id is not null then
    v_mis := array_append(v_mis, 'comp sentinel on a row that also carries a Stripe subscription'); end if;
  if s.user_id is not null and s.stripe_customer_id is null and array_length(v_custs, 1) > 0 then
    v_mis := array_append(v_mis, 'customer linked but not on the row'); end if;
  if exists (select 1 from public.stripe_events e where not e.resolved and e.customer_id = any(v_custs)) then
    v_mis := array_append(v_mis, 'unresolved deliveries for a linked customer'); end if;
  if exists (select 1 from public.billing_alerts a where a.user_id = p_user and a.resolved_at is null) then
    v_mis := array_append(v_mis, 'open alerts'); end if;

  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'email_confirmed', u.email_confirmed_at is not null,
                               'created_at', u.created_at),
    'access', v_access,
    'row', case when s.user_id is null then null else jsonb_build_object(
      'status', s.status, 'price_id', s.price_id, 'current_period_end', s.current_period_end,
      'cancel_at_period_end', s.cancel_at_period_end, 'stripe_customer_id', s.stripe_customer_id,
      'stripe_subscription_id', s.stripe_subscription_id, 'last_event_at', s.last_event_at,
      'last_event_id', s.last_event_id, 'stripe_synced_at', s.stripe_synced_at, 'sync_source', s.sync_source,
      'created_at', s.created_at, 'updated_at', s.updated_at) end,
    'customers', coalesce((select jsonb_agg(jsonb_build_object('id', b.stripe_customer_id, 'source', b.source,
                             'livemode', b.livemode, 'linked_at', b.created_at) order by b.created_at)
                             from public.billing_customers b where b.user_id = p_user), '[]'::jsonb),
    'last_event', (select jsonb_build_object('id', e.id, 'type', e.type, 'stripe_created', e.stripe_created,
                     'applied', e.applied, 'note', e.note, 'how', e.resolved_how)
                     from public.stripe_events e where e.user_id = p_user
                    order by e.stripe_created desc nulls last limit 1),
    'events', coalesce((select jsonb_agg(x order by x ->> 'stripe_created' desc) from (
                 select jsonb_build_object('id', e.id, 'type', e.type, 'stripe_created', e.stripe_created,
                          'resolved', e.resolved, 'applied', e.applied, 'attempts', e.attempts,
                          'note', e.note, 'last_error', e.last_error) as x
                   from public.stripe_events e
                  where e.user_id = p_user or e.customer_id = any(v_custs)
                  order by e.stripe_created desc nulls last limit 15) q), '[]'::jsonb),
    'unresolved_maybe_theirs', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type,
                 'customer_id', e.customer_id, 'stripe_created', e.stripe_created))
                   from public.stripe_events e
                  where not e.resolved and e.created_at > now() - interval '60 days'
                    and (e.customer_id = any(v_custs)
                         or lower(coalesce(e.payload -> 'data' -> 'object' -> 'customer_details' ->> 'email',
                                           e.payload -> 'data' -> 'object' ->> 'customer_email')) = v_email)), '[]'::jsonb),
    'checkout_sessions', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('id', c.id, 'status', c.status, 'kind', c.kind, 'created_at', c.created_at,
                          'completed_at', c.completed_at, 'subscription_id', c.subscription_id, 'ref', c.ref) as x
                   from public.billing_checkout_sessions c where c.user_id = p_user
                  order by c.created_at desc limit 5) q), '[]'::jsonb),
    'last_successful_sync', v_last_ok,
    'syncs', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('at', l.at, 'source', l.source, 'outcome', l.outcome, 'ok', l.ok, 'ref', l.ref,
                          'stripe_status', l.stripe_status, 'access_after', l.access_after, 'note', l.note) as x
                   from public.billing_sync_log l where l.user_id = p_user and l.outcome <> 'admitted'
                  order by l.at desc limit 10) q), '[]'::jsonb),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'occurrences', a.occurrences,
                 'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at, 'detail', a.detail))
                   from public.billing_alerts a where a.user_id = p_user and a.resolved_at is null), '[]'::jsonb),
    'consents', v_consents,
    'mismatches', to_jsonb(v_mis));
end;
$$;

-- Find accounts by anything a customer or Stripe might quote at you: an email,
-- an account id, a cus_/sub_/cs_/evt_ id, or the reference the success page showed.
create or replace function public.billing_admin_lookup(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare q text := btrim(coalesce(p_query, '')); ids uuid[] := '{}';
begin
  if not public.billing_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if q = '' then return '[]'::jsonb; end if;
  if q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    ids := array[q::uuid];
  elsif q like 'cus\_%' then
    select array_agg(distinct x) into ids from (
      select user_id x from public.billing_customers where stripe_customer_id = q
      union select user_id from public.subscriptions where stripe_customer_id = q
      union select user_id from public.stripe_events where customer_id = q and user_id is not null) t;
  elsif q like 'sub\_%' then
    select array_agg(distinct x) into ids from (
      select user_id x from public.subscriptions where stripe_subscription_id = q
      union select user_id from public.stripe_events where subscription_id = q and user_id is not null) t;
  elsif q like 'cs\_%' then
    select array_agg(distinct x) into ids from (
      select user_id x from public.billing_checkout_sessions where id = q
      union select user_id from public.stripe_events where payload -> 'data' -> 'object' ->> 'id' = q and user_id is not null) t;
  elsif q like 'evt\_%' then
    select array_agg(distinct x) into ids from (
      select user_id x from public.stripe_events where id = q and user_id is not null
      union select b.user_id from public.stripe_events e join public.billing_customers b on b.stripe_customer_id = e.customer_id where e.id = q) t;
  elsif q ~* '^EDS-' then
    select array_agg(distinct user_id) into ids from public.billing_sync_log where ref = upper(q) and user_id is not null;
  else
    select array_agg(id) into ids from (
      select id from auth.users where lower(email) = lower(q)
      union select id from (select id from auth.users where email ilike '%' || q || '%' order by created_at desc limit 10) p) t;
  end if;
  return coalesce((select jsonb_agg(public.billing_user_report(i)) from unnest(coalesce(ids, '{}')) i where i is not null), '[]'::jsonb);
end;
$$;

-- The state of the whole system in one call: what needs a human, and whether
-- the webhook is alive.
create or replace function public.billing_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.billing_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'generated_at', now(),
    'last_webhook_delivery', (select max(coalesce(last_delivery_at, created_at)) from public.stripe_events),
    'last_sweep', (select jsonb_build_object('at', last_run_at, 'result', last_result) from public.billing_sweep_state where id = 1),
    'open_alerts_by_kind', coalesce((select jsonb_object_agg(kind, n) from (
        select kind, count(*) n from public.billing_alerts where resolved_at is null group by kind) t), '{}'::jsonb),
    'unresolved_events_14d', (select count(*) from public.stripe_events where not resolved and created_at > now() - interval '14 days'),
    'failing_events', (select count(*) from public.stripe_events where attempts >= 3 and not applied
                          and last_error is not null and created_at > now() - interval '7 days'),
    'repairs_7d', (select count(*) from public.billing_sync_log where outcome = 'repaired' and at > now() - interval '7 days'),
    'sync_errors_24h', (select count(*) from public.billing_sync_log where not ok and at > now() - interval '24 hours'),
    'rows_no_status', (select count(*) from public.subscriptions where status is null),
    'rows_stale_period', (select count(*) from public.subscriptions where stripe_subscription_id is not null
                            and status in ('active', 'trialing') and current_period_end < now()),
    'rows_entitled', (select count(*) from public.subscriptions
                        where public.billing_row_grants_access(status, price_id, current_period_end, now())),
    'consent_without_row_7d', (select count(distinct c.user_id) from public.billing_consents c
                                 where c.created_at > now() - interval '7 days'
                                   and not exists (select 1 from public.subscriptions s where s.user_id = c.user_id)),
    'alerts', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', a.id, 'kind', a.kind, 'user_id', a.user_id,
                 'email', (select email from auth.users where id = a.user_id),
                 'customer', a.stripe_customer_id, 'subscription', a.stripe_subscription_id, 'event', a.stripe_event_id,
                 'occurrences', a.occurrences, 'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at,
                 'detail', a.detail) as x
          from public.billing_alerts a where a.resolved_at is null order by a.last_seen_at desc limit 100) q), '[]'::jsonb),
    'unresolved', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', e.id, 'type', e.type, 'customer_id', e.customer_id, 'stripe_created', e.stripe_created,
                 'attempts', e.attempts, 'note', e.note,
                 'email', coalesce(e.payload -> 'data' -> 'object' -> 'customer_details' ->> 'email',
                                   e.payload -> 'data' -> 'object' ->> 'customer_email')) as x
          from public.stripe_events e where not e.resolved and e.created_at > now() - interval '30 days'
         order by e.created_at desc limit 100) q), '[]'::jsonb));
end;
$$;

-- Support's one manual lever: "this Stripe customer is this account". Never
-- remaps a customer already linked elsewhere. The caller then asks
-- sync_subscription to reconcile, which reads Stripe and writes the row.
create or replace function public.billing_admin_link_customer(p_user uuid, p_customer_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.billing_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.billing_link_customer(p_customer_id, p_user, 'admin:' || auth.uid()::text, null, null);
end;
$$;

create or replace function public.billing_admin_resolve_alert(p_id bigint, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.billing_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.billing_alerts set resolved_at = now(),
         resolved_note = coalesce(nullif(btrim(p_note), ''), 'acknowledged') || ' (by ' || auth.uid()::text || ')'
   where id = p_id and resolved_at is null;
  return found;
end;
$$;

-- The same picture for the SQL editor, every account with any billing footprint.
create or replace view public.billing_diagnostics as
  select u.id as user_id, u.email, u.email_confirmed_at is not null as email_confirmed,
         s.status, s.price_id, s.current_period_end, s.cancel_at_period_end,
         s.stripe_customer_id, s.stripe_subscription_id, s.last_event_at, s.last_event_id,
         s.stripe_synced_at, s.sync_source,
         public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now()) as has_access,
         (select count(*) from public.billing_customers b where b.user_id = u.id) as linked_customers,
         (select count(*) from public.billing_consents c where c.user_id = u.id) as consents,
         (select max(l.at) from public.billing_sync_log l where l.user_id = u.id and l.ok and l.outcome <> 'admitted') as last_successful_sync,
         (select count(*) from public.billing_alerts a where a.user_id = u.id and a.resolved_at is null) as open_alerts,
         case
           when s.user_id is null then 'consent recorded, no subscription row'
           when s.status is null then 'row has no status'
           when s.stripe_subscription_id is not null and s.status in ('active', 'trialing') and s.current_period_end < now()
             then 'stale: Stripe-backed period ended'
           when s.status in ('active', 'trialing') and s.current_period_end is null and coalesce(s.price_id, '') <> 'owner_comp'
             then 'entitled with no period end'
         end as mismatch
    from auth.users u
    left join public.subscriptions s on s.user_id = u.id
   where s.user_id is not null
      or exists (select 1 from public.billing_consents c where c.user_id = u.id)
      or exists (select 1 from public.billing_customers b where b.user_id = u.id);
revoke all on public.billing_diagnostics from anon, authenticated;

create or replace view public.billing_open_alerts as
  select a.id, a.kind, a.user_id, u.email, a.stripe_customer_id, a.stripe_subscription_id, a.stripe_event_id,
         a.occurrences, a.first_seen_at, a.last_seen_at, a.detail
    from public.billing_alerts a left join auth.users u on u.id = a.user_id
   where a.resolved_at is null
   order by a.last_seen_at desc;
revoke all on public.billing_open_alerts from anon, authenticated;

-- ── 10. GRANTS ──────────────────────────────────────────────────────────────
-- A Supabase project grants EXECUTE on every new public function to anon and
-- authenticated by default, so revoking from PUBLIC alone is not enough.
revoke all on function public.billing_raise_alert(text, text, uuid, text, text, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.billing_clear_alerts(uuid, text[], text) from public, anon, authenticated;
revoke all on function public.billing_link_customer(text, uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.billing_resolve_user(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.billing_apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, timestamptz, text, boolean, boolean, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.billing_record_event(text, text, timestamptz, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.billing_access_for(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.billing_sync_admit(uuid, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.billing_sweep_admit(integer) from public, anon, authenticated;
revoke all on function public.billing_sweep_candidates(integer) from public, anon, authenticated;
revoke all on function public.billing_unresolved_events(integer) from public, anon, authenticated;
revoke all on function public.billing_user_report(uuid) from public, anon, authenticated;
-- the browser's two doors: its own decision, and (for operators) diagnostics
revoke all on function public.my_billing_access() from public, anon;
grant execute on function public.my_billing_access() to authenticated;
revoke all on function public.billing_is_admin() from public, anon;
grant execute on function public.billing_is_admin() to authenticated;
revoke all on function public.billing_admin_lookup(text) from public, anon;
grant execute on function public.billing_admin_lookup(text) to authenticated;
revoke all on function public.billing_admin_overview() from public, anon;
grant execute on function public.billing_admin_overview() to authenticated;
revoke all on function public.billing_admin_link_customer(uuid, text) from public, anon;
grant execute on function public.billing_admin_link_customer(uuid, text) to authenticated;
revoke all on function public.billing_admin_resolve_alert(bigint, text) from public, anon;
grant execute on function public.billing_admin_resolve_alert(bigint, text) to authenticated;
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.billing_raise_alert(text, text, uuid, text, text, text, jsonb, boolean), '
         || 'public.billing_clear_alerts(uuid, text[], text), '
         || 'public.billing_link_customer(text, uuid, text, boolean, text), '
         || 'public.billing_resolve_user(text, text, text, text, text, text), '
         || 'public.billing_apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, timestamptz, text, boolean, boolean, text, timestamptz, boolean), '
         || 'public.billing_record_event(text, text, timestamptz, text, text, jsonb, text), '
         || 'public.billing_access_for(uuid, timestamptz), '
         || 'public.billing_sync_admit(uuid, text, integer, integer, text), '
         || 'public.billing_sweep_admit(integer), public.billing_sweep_candidates(integer), '
         || 'public.billing_unresolved_events(integer), public.billing_user_report(uuid) to service_role';
    execute 'grant select on public.billing_diagnostics, public.billing_open_alerts to service_role';
  end if;
end
$g$;

-- ── 11. THE OTHER COPIES OF THE RULE, POINTED AT THIS ONE ───────────────────
-- community_is_entitled() is what tennis_record.sql and personal_research.sql
-- defer to, so pointing it here makes every database-side gate this one rule.
-- Replaced ONLY where it is already installed: creating it on a project that
-- never ran community_posts.sql would switch personal_research's gate on.
do $ce$
begin
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    execute $f$
      create or replace function public.community_is_entitled(p_user uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public, pg_temp
      as $b$
        select exists (
          select 1 from public.subscriptions s
           where s.user_id = p_user
             and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())
        );
      $b$;
    $f$;
  end if;
end
$ce$;

-- ── 12. BACKFILL: what the existing data already proves ─────────────────────
-- A customer id on a subscription row, or on a resolved delivery, already names
-- its account. Only unambiguous mappings are taken; a customer that two
-- accounts claim is left for the report below.
insert into public.billing_customers (stripe_customer_id, user_id, source)
select s.stripe_customer_id, (array_agg(s.user_id))[1], 'backfill:subscriptions'
  from public.subscriptions s
 where s.stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'
 group by s.stripe_customer_id
having count(distinct s.user_id) = 1
on conflict (stripe_customer_id) do nothing;

insert into public.billing_customers (stripe_customer_id, user_id, source)
select e.customer_id, (array_agg(distinct e.user_id))[1], 'backfill:stripe_events'
  from public.stripe_events e
  join auth.users u on u.id = e.user_id
 where e.customer_id ~ '^cus_[A-Za-z0-9]+$' and e.resolved
 group by e.customer_id
having count(distinct e.user_id) = 1
on conflict (stripe_customer_id) do nothing;

-- A completed checkout that names a real account in client_reference_id but was
-- never resolved is a delivery that FAILED, not one that was ambiguous. Link it
-- now; the reconciler then reads the subscription from Stripe.
do $bf$
declare r record;
begin
  for r in
    select distinct on (e.customer_id) e.customer_id, (o ->> 'client_reference_id')::uuid as uid
      from public.stripe_events e
      cross join lateral (select e.payload -> 'data' -> 'object' as o) x
     where not e.resolved and e.type = 'checkout.session.completed'
       and e.customer_id ~ '^cus_[A-Za-z0-9]+$'
       and (o ->> 'client_reference_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from auth.users u where u.id = (o ->> 'client_reference_id')::uuid)
     order by e.customer_id, e.created_at
  loop
    perform public.billing_link_customer(r.customer_id, r.uid, 'backfill:client_reference_id', null, null);
  end loop;
end
$bf$;

notify pgrst, 'reload schema';

-- ── report ──────────────────────────────────────────────────────────────────
select 1 as row, 'the access rule exists and is immutable' as check,
       case when (select provolatile from pg_proc where oid = 'public.billing_row_grants_access(text,text,timestamptz,timestamptz)'::regprocedure) = 'i'
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'the rule matches the business rule on its edge cases',
       case when public.billing_row_grants_access('active', 'owner_comp', '2000-01-01', now())
             and public.billing_row_grants_access('trialing', 'comp_trial', now() + interval '1 day', now())
             and not public.billing_row_grants_access('trialing', 'comp_trial', now() - interval '1 second', now())
             and public.billing_row_grants_access('past_due', 'price_x', now() - interval '20 days', now())
             and not public.billing_row_grants_access('past_due', 'price_x', now() - interval '22 days', now())
             and not public.billing_row_grants_access('canceled', 'price_x', now() + interval '9 days', now())
             and not public.billing_row_grants_access('paused', 'price_x', now() + interval '9 days', now())
             and not public.billing_row_grants_access(null, null, null, now())
             and not public.billing_row_grants_access('canceled', 'owner_comp', null, now())
            then 'ok' else 'CHECK THIS' end
union all select 3, 'new billing tables exist with RLS on and no client grants',
       case when (select count(*) from pg_class where oid in ('public.billing_customers'::regclass, 'public.billing_checkout_sessions'::regclass,
                    'public.billing_sync_log'::regclass, 'public.billing_alerts'::regclass, 'public.billing_sweep_state'::regclass)
                    and relrowsecurity) = 5
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'public' and grantee in ('anon', 'authenticated')
                                and table_name in ('billing_customers', 'billing_checkout_sessions', 'billing_sync_log',
                                                   'billing_alerts', 'billing_sweep_state', 'billing_diagnostics', 'billing_open_alerts'))
            then 'ok' else 'CHECK THIS' end
union all select 4, 'subscriptions is still unwritable by any client role',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'public' and table_name = 'subscriptions'
                                and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
            then 'ok' else 'CHECK THIS — run supabase/billing.sql' end
union all select 5, 'only my_billing_access and the operator functions are callable by a signed-in reader',
       case when has_function_privilege('authenticated', 'public.my_billing_access()', 'execute')
             and not has_function_privilege('anon', 'public.my_billing_access()', 'execute')
             and not has_function_privilege('authenticated', 'public.billing_access_for(uuid,timestamptz)', 'execute')
             and not has_function_privilege('authenticated', 'public.billing_apply_subscription_state(uuid,text,text,text,text,timestamptz,boolean,timestamptz,text,boolean,boolean,text,timestamptz,boolean)', 'execute')
             and not has_function_privilege('authenticated', 'public.billing_link_customer(text,uuid,text,boolean,text)', 'execute')
             and not has_function_privilege('authenticated', 'public.billing_resolve_user(text,text,text,text,text,text)', 'execute')
             and not has_function_privilege('anon', 'public.billing_admin_lookup(text)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 6, 'one row per Stripe subscription is enforced',
       case when to_regclass('public.subscriptions_stripe_subscription_uk') is not null then 'ok'
            else 'CHECK THIS — not enforced: ' || coalesce((select string_agg(stripe_subscription_id, ', ') from (
                   select stripe_subscription_id from public.subscriptions where stripe_subscription_id is not null
                    group by 1 having count(*) > 1) d), '?') || ' sit on more than one account. Decide which account owns each, then re-run.' end
union all select 7, 'Stripe customers linked to accounts',
       'ok (' || (select count(*) from public.billing_customers)::text || ' customers, '
              || (select count(distinct user_id) from public.billing_customers)::text || ' accounts)'
union all select 8, 'customers two accounts both claim (left unlinked for a human)',
       case when (select count(*) from (select stripe_customer_id from public.subscriptions where stripe_customer_id is not null
                    group by 1 having count(distinct user_id) > 1) d) = 0 then 'ok (none)'
            else 'CHECK THIS — ' || (select string_agg(stripe_customer_id, ', ') from (select stripe_customer_id from public.subscriptions
                    where stripe_customer_id is not null group by 1 having count(distinct user_id) > 1) d) end
union all select 9, 'deliveries still unresolved (14 days) — sync_subscription sweeps these',
       'ok (' || (select count(*) from public.stripe_events where not resolved and created_at > now() - interval '14 days')::text || ')'
union all select 10, 'accounts that went to checkout and have no subscription row — sweep or Refresh access repairs these',
       'ok (' || (select count(distinct c.user_id) from public.billing_consents c
                   where not exists (select 1 from public.subscriptions s where s.user_id = c.user_id))::text || ')'
union all select 11, 'community_is_entitled defers to the one rule (where installed)',
       case when to_regprocedure('public.community_is_entitled(uuid)') is null then 'ok (not installed here)'
            when pg_get_functiondef(to_regprocedure('public.community_is_entitled(uuid)')) like '%billing_row_grants_access%' then 'ok'
            else 'CHECK THIS' end
order by row;

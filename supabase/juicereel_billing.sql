-- ===========================================================================
-- EdgeDesk — selling EdgeDesk through Juice Reel's hosted checkout.
--
-- WHAT THIS IS. A reader buys EdgeDesk on Juice Reel (Juice Reel takes the
-- payment and is the merchant), and the account they are signed in to on
-- EdgeDesk opens. Juice Reel names its buyer by a Juice Reel user id; EdgeDesk
-- names a reader by an auth.users id. This file keeps the bridge between the
-- two, what Juice Reel last said about each buyer, and writes that into
-- public.subscriptions — the one row every gate in the product already reads
-- (billing_row_grants_access, my_billing_access, every RLS gate, the paywall).
--
--   billing_juicereel_sessions     one per checkout or account link started
--                                  from EdgeDesk: SHA-256 of its OAuth state,
--                                  bound to the reader who started it, single
--                                  use. No verifier, code or token is stored:
--                                  the PKCE verifier is derived on the server
--                                  from the state and the client secret.
--   billing_juicereel_links        EdgeDesk account <-> Juice Reel account, one
--                                  to one
--   billing_juicereel_subscribers  what Juice Reel last said about each buyer,
--                                  keyed by JUICE REEL user — so a purchase
--                                  reported before the buyer links (bought on
--                                  Juice Reel's marketplace) is waiting for them
--   billing_juicereel_events       every webhook delivery, recorded once by id
--
-- THE RULES IT ENFORCES (billing_jr_project, the only writer):
--   * A Juice Reel row is price_id = 'juicereel', with no Stripe ids. It grants
--     the Research Terminal under THE access rule unchanged: 'active' until
--     current_period_end (Juice Reel's expiry). An unknown price is the
--     terminal (billing_tier_of_price), so nothing in billing_hardening.sql
--     changes. Juice Reel sells only the terminal: never Bet Checker (red) or
--     Fairline (black), which the terminal includes.
--   * A LIVE STRIPE PLAN THE TERMINAL REPLACES IS RAISED. The tiers that are not
--     the terminal — Bet Checker (red) and Fairline (black) — do not pass the
--     access rule, so a Juice Reel buyer whose row holds one in good standing
--     is given the terminal over it (it includes both). Stripe would go on
--     billing that plan with nothing pointing at it, so it is raised for a
--     human (juicereel_and_stripe_both_paid) to cancel in Stripe.
--   * JUICE REEL ONLY REVOKES WHAT JUICE REEL GRANTED. A row entitled by Stripe,
--     by owner_comp or by hand is never overwritten; a Stripe-backed row in good
--     standing while Juice Reel also says paid raises an alert (billed twice).
--   * Stripe already only revokes what Stripe granted (billing_apply_subscription_state):
--     a Juice Reel row has no stripe_subscription_id, so a Stripe state can
--     never end it. When Juice Reel takes over a row whose Stripe subscription
--     already ended, that ended subscription's id is cleared from the row, or
--     the Stripe sweep would re-check it and apply "canceled" over a paid
--     Juice Reel buyer.
--   * One Juice Reel account opens one EdgeDesk account. A second EdgeDesk
--     account linking the same Juice Reel account is refused and alerted.
--   * An older Juice Reel state never overwrites a newer one.
--
-- Run AFTER billing.sql, stripe_webhook.sql and billing_hardening.sql.
-- Additive and idempotent: nothing existing is dropped or rewritten. Ends in a
-- report: every row should say ok.
-- ===========================================================================

do $guard$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'public.subscriptions does not exist. Run supabase/billing.sql first.';
  end if;
  if to_regprocedure('public.billing_row_grants_access(text,text,timestamptz,timestamptz)') is null
     or to_regprocedure('public.billing_raise_alert(text,text,uuid,text,text,text,jsonb,boolean)') is null
     or to_regprocedure('public.billing_access_for(uuid,timestamptz)') is null then
    raise exception 'The billing rule is not installed. Run supabase/billing_hardening.sql first.';
  end if;
end
$guard$;

-- ── 1. RECORDS ──────────────────────────────────────────────────────────────

create table if not exists public.billing_juicereel_sessions (
  state_hash          text        primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  kind                text        not null check (kind in ('checkout', 'link')),
  redirect_uri        text        not null,
  checkout_session_id text,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  consumed_at         timestamptz,
  outcome             text
);
create index if not exists billing_juicereel_sessions_by_user
  on public.billing_juicereel_sessions (user_id, created_at desc);

create table if not exists public.billing_juicereel_links (
  user_id           uuid        primary key references auth.users(id) on delete cascade,
  jr_user_id        text        not null check (length(jr_user_id) between 1 and 200),
  jr_display_name   text,
  linked_at         timestamptz not null default now(),
  last_confirmed_at timestamptz
);
create unique index if not exists billing_juicereel_links_jr_uk on public.billing_juicereel_links (jr_user_id);

create table if not exists public.billing_juicereel_subscribers (
  jr_user_id    text        primary key check (length(jr_user_id) between 1 and 200),
  active        boolean     not null,
  expires_at    timestamptz,
  cancelled     boolean     not null default false,
  provisional   boolean     not null default false,
  product_id    text,
  as_of         timestamptz not null,
  source        text        not null,
  last_event_id text,
  updated_at    timestamptz not null default now()
);

create table if not exists public.billing_juicereel_events (
  id          text        primary key check (length(id) between 1 and 200),
  type        text,
  jr_user_id  text,
  event_at    timestamptz,
  received_at timestamptz not null default now(),
  payload     jsonb       not null default '{}'::jsonb,
  outcome     text
);
create index if not exists billing_juicereel_events_recent on public.billing_juicereel_events (received_at desc);

-- When the scheduled reconciliation last ran: debounces an unauthenticated poke.
create table if not exists public.billing_juicereel_reconcile_state (
  id          smallint    primary key default 1 check (id = 1),
  last_run_at timestamptz,
  last_result jsonb
);
insert into public.billing_juicereel_reconcile_state (id) values (1) on conflict (id) do nothing;

-- Nothing here is client-readable. The edge function uses the service role.
alter table public.billing_juicereel_sessions        enable row level security;
alter table public.billing_juicereel_links           enable row level security;
alter table public.billing_juicereel_subscribers     enable row level security;
alter table public.billing_juicereel_events          enable row level security;
alter table public.billing_juicereel_reconcile_state enable row level security;
revoke all on public.billing_juicereel_sessions        from public, anon, authenticated;
revoke all on public.billing_juicereel_links           from public, anon, authenticated;
revoke all on public.billing_juicereel_subscribers     from public, anon, authenticated;
revoke all on public.billing_juicereel_events          from public, anon, authenticated;
revoke all on public.billing_juicereel_reconcile_state from public, anon, authenticated;

comment on table public.billing_juicereel_sessions is
  'Juice Reel checkouts and account links started from EdgeDesk: SHA-256 of the OAuth state, the reader who started it, '
  'single use. No verifier, code or token is stored. Service role only.';
comment on table public.billing_juicereel_links is
  'EdgeDesk account <-> Juice Reel account, one to one. Written only after Juice Reel exchanged a code for that reader.';
comment on table public.billing_juicereel_subscribers is
  'What Juice Reel last said about each buyer of EdgeDesk, keyed by Juice Reel user id. Projected into subscriptions '
  'for a linked reader by billing_jr_project().';
comment on table public.billing_juicereel_events is
  'Juice Reel SUBSCRIPTION_EVENTS webhook deliveries, recorded once by id after the signature was verified.';

-- ── 2. SESSIONS ─────────────────────────────────────────────────────────────
-- A checkout can take a while (the buyer pays, then answers Juice Reel's
-- consent screen), so its state lives 48 hours; a plain account link, one hour.
-- At most ten starts per reader in ten minutes.
create or replace function public.billing_jr_session_open(
  p_user uuid, p_state_hash text, p_kind text, p_redirect_uri text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_exp timestamptz; n int;
begin
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('ok', false, 'reason', 'no_such_user');
  end if;
  if p_kind not in ('checkout', 'link') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  -- serialise one reader's starts so two tabs cannot both slip under the limit
  perform pg_advisory_xact_lock(hashtext('billing_jr_session_open:' || p_user::text));
  select count(*) into n from public.billing_juicereel_sessions
   where user_id = p_user and created_at > now() - interval '10 minutes';
  if n >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  delete from public.billing_juicereel_sessions
   where user_id = p_user and created_at < now() - interval '30 days';
  v_exp := now() + case p_kind when 'checkout' then interval '48 hours' else interval '1 hour' end;
  insert into public.billing_juicereel_sessions (state_hash, user_id, kind, redirect_uri, expires_at)
  values (p_state_hash, p_user, p_kind, p_redirect_uri, v_exp);
  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end;
$$;

create or replace function public.billing_jr_session_attach(p_state_hash text, p_checkout_session_id text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with u as (
    update public.billing_juicereel_sessions set checkout_session_id = left(p_checkout_session_id, 200)
     where state_hash = p_state_hash and consumed_at is null
    returning 1)
  select exists (select 1 from u);
$$;

-- Released ONLY to the reader who started it, once, before it expires. A state
-- presented by anybody else is refused WITHOUT being used up, so an attacker's
-- state completed in a victim's browser can neither link the attacker's Juice
-- Reel account to the victim nor spend the victim's own session.
create or replace function public.billing_jr_session_consume(p_user uuid, p_state_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare s public.billing_juicereel_sessions%rowtype;
begin
  select * into s from public.billing_juicereel_sessions where state_hash = p_state_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if s.user_id is distinct from p_user then return jsonb_build_object('ok', false, 'reason', 'other_user'); end if;
  if s.consumed_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if s.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  update public.billing_juicereel_sessions set consumed_at = now() where state_hash = p_state_hash;
  return jsonb_build_object('ok', true, 'kind', s.kind, 'redirect_uri', s.redirect_uri,
                            'checkout_session_id', s.checkout_session_id);
end;
$$;

-- A code exchange that never reached Juice Reel (a timeout, a 5xx) leaves the
-- code unused there, so the same reader may try again with the same state.
create or replace function public.billing_jr_session_release(p_user uuid, p_state_hash text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with u as (
    update public.billing_juicereel_sessions set consumed_at = null, outcome = 'retry'
     where state_hash = p_state_hash and user_id = p_user and expires_at > now()
    returning 1)
  select exists (select 1 from u);
$$;

create or replace function public.billing_jr_session_finish(p_state_hash text, p_outcome text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with u as (
    update public.billing_juicereel_sessions set outcome = left(p_outcome, 60) where state_hash = p_state_hash
    returning 1)
  select exists (select 1 from u);
$$;

-- ── 3. THE LINK ─────────────────────────────────────────────────────────────
create or replace function public.billing_jr_link(p_user uuid, p_jr_user text, p_display text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_other uuid; v_prev text;
begin
  if p_user is null or p_jr_user is null or length(p_jr_user) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'bad_input');
  end if;
  perform pg_advisory_xact_lock(hashtext('billing_jr_link:' || p_jr_user));
  select user_id into v_other from public.billing_juicereel_links where jr_user_id = p_jr_user;
  if v_other is not null and v_other <> p_user then
    perform public.billing_raise_alert('juicereel_account_in_use', 'jr:' || p_jr_user, p_user, null, null, null,
      jsonb_build_object('linked_to', v_other, 'tried_by', p_user, 'jr_user_id', p_jr_user));
    return jsonb_build_object('ok', false, 'reason', 'in_use');
  end if;
  select jr_user_id into v_prev from public.billing_juicereel_links where user_id = p_user for update;
  if v_prev is null then
    insert into public.billing_juicereel_links (user_id, jr_user_id, jr_display_name, last_confirmed_at)
    values (p_user, p_jr_user, left(p_display, 120), now());
    return jsonb_build_object('ok', true, 'linked', 'new');
  end if;
  update public.billing_juicereel_links
     set jr_user_id = p_jr_user, jr_display_name = coalesce(left(p_display, 120), jr_display_name),
         last_confirmed_at = now(), linked_at = case when v_prev = p_jr_user then linked_at else now() end
   where user_id = p_user;
  return jsonb_build_object('ok', true, 'linked', case when v_prev = p_jr_user then 'same' else 'replaced' end,
                            'previous_jr_user_id', case when v_prev = p_jr_user then null else v_prev end);
end;
$$;

-- ── 4. THE ONLY WRITER OF JUICE REEL STATE INTO subscriptions ───────────────
-- Under the subscriptions row lock. Refusals are answers, not errors:
-- 'not_linked', 'no_state', 'comp', 'other_entitlement', 'nothing_to_grant',
-- 'not_ours'.
create or replace function public.billing_jr_project(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l public.billing_juicereel_links%rowtype;
  j public.billing_juicereel_subscribers%rowtype;
  e public.subscriptions%rowtype;
  v_now    timestamptz := now();
  v_grants boolean;
  v_status text;
  v_ex_ent boolean;
  v_takeover_stripe text;
begin
  select * into l from public.billing_juicereel_links where user_id = p_user;
  if not found then return jsonb_build_object('applied', false, 'reason', 'not_linked'); end if;
  select * into j from public.billing_juicereel_subscribers where jr_user_id = l.jr_user_id;
  if not found then return jsonb_build_object('applied', false, 'reason', 'no_state'); end if;

  -- Paid on Juice Reel: active, with an expiry still ahead. Never open-ended:
  -- a Juice Reel row without an expiry would grant forever under the rule.
  v_grants := j.active and j.expires_at is not null and j.expires_at > v_now;
  v_status := case when v_grants then 'active' else 'canceled' end;

  select * into e from public.subscriptions where user_id = p_user for update;
  if not found then
    if not v_grants then return jsonb_build_object('applied', false, 'reason', 'nothing_to_grant'); end if;
    begin
      insert into public.subscriptions
        (user_id, status, price_id, current_period_end, cancel_at_period_end, sync_source, created_at, updated_at)
      values (p_user, 'active', 'juicereel', j.expires_at, j.cancelled, 'juicereel', v_now, v_now);
      return jsonb_build_object('applied', true, 'reason', 'created', 'access_before', false,
        'access_after', public.billing_row_grants_access('active', 'juicereel', j.expires_at, v_now));
    exception when unique_violation then
      select * into e from public.subscriptions where user_id = p_user for update;
    end;
  end if;

  -- A COMP IS NOBODY'S TO WRITE.
  if e.status = 'active' and coalesce(e.price_id, '') = 'owner_comp' then
    return jsonb_build_object('applied', false, 'reason', 'comp', 'access_before', true, 'access_after', true);
  end if;

  v_ex_ent := public.billing_row_grants_access(e.status, e.price_id, e.current_period_end, v_now);

  if coalesce(e.price_id, '') <> 'juicereel' then
    -- JUICE REEL ONLY REVOKES WHAT JUICE REEL GRANTED, and never overwrites an
    -- entitlement it did not grant. A hand-granted trial (comp_trial) gives way
    -- to a purchase, as it does to a Stripe one.
    if v_ex_ent and coalesce(e.price_id, '') <> 'comp_trial' then
      if v_grants and e.stripe_subscription_id is not null then
        perform public.billing_raise_alert('juicereel_and_stripe_both_paid', 'user:' || p_user, p_user,
          e.stripe_customer_id, e.stripe_subscription_id, null,
          jsonb_build_object('juicereel_expires_at', j.expires_at, 'stripe_status', e.status,
                             'note', 'paying through Stripe AND Juice Reel; the Stripe row is kept'));
      end if;
      return jsonb_build_object('applied', false, 'reason', 'other_entitlement',
                                'access_before', true, 'access_after', true);
    end if;
    if not v_grants then
      return jsonb_build_object('applied', false, 'reason', 'not_ours', 'access_before', v_ex_ent, 'access_after', v_ex_ent);
    end if;
    -- taking over a row: an ended Stripe subscription's id must not stay on it
    -- (the Stripe sweep re-checks rows that carry one, and would end this one)
    v_takeover_stripe := e.stripe_subscription_id;
    -- ...and a Stripe plan that has NOT ended, sold under a tier that is not
    -- the terminal (red: Bet Checker, black: Fairline), is still being billed:
    -- the terminal from Juice Reel replaces it here, and a human cancels it there
    if e.stripe_subscription_id is not null
       and public.billing_row_in_good_standing(e.status, e.price_id, e.current_period_end, v_now)
       and public.billing_tier_of_price(e.price_id) in ('red', 'black') then
      perform public.billing_raise_alert('juicereel_and_stripe_both_paid', 'user:' || p_user, p_user,
        e.stripe_customer_id, e.stripe_subscription_id, null,
        jsonb_build_object('juicereel_expires_at', j.expires_at, 'stripe_status', e.status,
                           'stripe_tier', public.billing_tier_of_price(e.price_id),
                           'note', 'the terminal from Juice Reel replaced a live Stripe Bet Checker / Fairline plan on this row: cancel that Stripe subscription'));
    end if;
  end if;

  update public.subscriptions set
    status                 = v_status,
    price_id               = 'juicereel',
    current_period_end     = j.expires_at,
    cancel_at_period_end   = j.cancelled,
    stripe_subscription_id = case when v_takeover_stripe is not null then null else stripe_subscription_id end,
    sync_source            = 'juicereel',
    updated_at             = v_now
  where user_id = p_user;

  return jsonb_build_object('applied', true, 'reason', 'updated',
    'changed', v_status is distinct from e.status or e.price_id is distinct from 'juicereel'
               or j.expires_at is distinct from e.current_period_end or j.cancelled is distinct from e.cancel_at_period_end,
    'took_over_from', case when coalesce(e.price_id, '') <> 'juicereel' then coalesce(e.price_id, 'none') end,
    'cleared_stripe_subscription', v_takeover_stripe,
    'access_before', v_ex_ent,
    'access_after', public.billing_row_grants_access(v_status, 'juicereel', j.expires_at, v_now));
end;
$$;

-- ── 5. WHAT JUICE REEL SAID ABOUT A BUYER ───────────────────────────────────
--   p_active       Juice Reel says this buyer has paid (a cancelled subscription
--                  is still paid until it expires: active, cancelled)
--   p_expires_at   when what they paid for ends; NULL keeps the expiry already
--                  known (a cancellation that does not restate it)
--   p_as_of        when this was TRUE: the event's own time, or now() for a
--                  state read live from Juice Reel
--   p_provisional  Juice Reel said "subscribed" without saying until when; the
--                  caller supplies a short horizon, which never shortens an
--                  expiry Juice Reel actually stated
-- Then, for a linked reader, billing_jr_project().
create or replace function public.billing_jr_record_state(
  p_jr_user text, p_active boolean, p_expires_at timestamptz, p_cancelled boolean, p_product text,
  p_as_of timestamptz, p_source text, p_event_id text default null, p_provisional boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  x public.billing_juicereel_subscribers%rowtype;
  v_asof timestamptz := coalesce(p_as_of, now());
  v_exp timestamptz; v_prod text; v_active boolean := coalesce(p_active, false);
  v_canc boolean := coalesce(p_cancelled, false); v_prov boolean := coalesce(p_provisional, false);
  v_user uuid; v_proj jsonb;
begin
  if p_jr_user is null or length(p_jr_user) not between 1 and 200 then
    return jsonb_build_object('recorded', false, 'reason', 'bad_input');
  end if;
  perform pg_advisory_xact_lock(hashtext('billing_jr_state:' || p_jr_user));
  select * into x from public.billing_juicereel_subscribers where jr_user_id = p_jr_user for update;
  v_exp := p_expires_at; v_prod := p_product;

  if found then
    -- AN OLDER STATE NEVER OVERWRITES A NEWER ONE
    if v_asof < x.as_of then
      return jsonb_build_object('recorded', false, 'reason', 'stale');
    end if;
    if v_exp is null then v_exp := x.expires_at; end if;
    -- a provisional horizon never shortens an expiry Juice Reel stated
    if v_prov and x.active and not x.provisional and x.expires_at is not null
       and (v_exp is null or x.expires_at > v_exp) then
      v_exp := x.expires_at; v_prov := false; v_prod := coalesce(v_prod, x.product_id);
    end if;
    -- ONE PRODUCT ENDING DOES NOT END ANOTHER STILL PAID FOR
    if x.active and x.expires_at > now() and x.product_id is not null and p_product is not null
       and p_product <> x.product_id and (not v_active or v_canc or v_exp <= x.expires_at) then
      update public.billing_juicereel_subscribers set as_of = v_asof, last_event_id = coalesce(p_event_id, last_event_id),
             updated_at = now() where jr_user_id = p_jr_user;
      return jsonb_build_object('recorded', false, 'reason', 'other_product_still_paid');
    end if;
    update public.billing_juicereel_subscribers set
      active = v_active, expires_at = v_exp, cancelled = v_canc, provisional = v_prov,
      product_id = coalesce(v_prod, product_id), as_of = v_asof, source = p_source,
      last_event_id = coalesce(p_event_id, last_event_id), updated_at = now()
    where jr_user_id = p_jr_user;
  else
    insert into public.billing_juicereel_subscribers
      (jr_user_id, active, expires_at, cancelled, provisional, product_id, as_of, source, last_event_id)
    values (p_jr_user, v_active, v_exp, v_canc, v_prov, v_prod, v_asof, p_source, p_event_id);
  end if;

  select user_id into v_user from public.billing_juicereel_links where jr_user_id = p_jr_user;
  if v_user is not null then
    v_proj := public.billing_jr_project(v_user);
  end if;
  return jsonb_build_object('recorded', true, 'linked', v_user is not null, 'user_id', v_user,
                            'active', v_active, 'expires_at', v_exp, 'projection', v_proj);
end;
$$;

-- ── 6. THE WEBHOOK LEDGER ───────────────────────────────────────────────────
-- Juice Reel does not retry a delivery, so every one that arrives with a good
-- signature is kept; a second delivery of the same id changes nothing.
create or replace function public.billing_jr_record_event(
  p_id text, p_type text, p_jr_user text, p_event_at timestamptz, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  insert into public.billing_juicereel_events (id, type, jr_user_id, event_at, payload)
  values (p_id, left(p_type, 80), left(p_jr_user, 200), p_event_at, coalesce(p_payload, '{}'::jsonb))
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('first', n = 1);
end;
$$;

create or replace function public.billing_jr_event_outcome(p_id text, p_outcome text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with u as (
    update public.billing_juicereel_events set outcome = left(p_outcome, 80) where id = p_id
    returning 1)
  select exists (select 1 from u);
$$;

-- ── 7. ONE READER, FOR THE PAGE ─────────────────────────────────────────────
create or replace function public.billing_jr_status(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare l public.billing_juicereel_links%rowtype; j public.billing_juicereel_subscribers%rowtype; v_j boolean := false;
begin
  select * into l from public.billing_juicereel_links where user_id = p_user;
  if found then
    select * into j from public.billing_juicereel_subscribers where jr_user_id = l.jr_user_id;
    v_j := found;
  end if;
  return jsonb_build_object(
    'linked', l.user_id is not null,
    'display_name', l.jr_display_name,
    'juicereel', case when v_j then jsonb_build_object('active', j.active, 'expires_at', j.expires_at,
                   'cancelled', j.cancelled, 'provisional', j.provisional, 'as_of', j.as_of) end,
    'access', public.billing_access_for(p_user, now()));
end;
$$;

-- ── 8. RECONCILIATION ───────────────────────────────────────────────────────
-- An unauthenticated poke (the cron job carries no key) is admitted at most
-- once per p_min_interval_s; the edge function lets an operator force it.
create or replace function public.billing_jr_reconcile_admit(p_min_interval_s integer default 3000)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r public.billing_juicereel_reconcile_state%rowtype;
begin
  select * into r from public.billing_juicereel_reconcile_state where id = 1 for update;
  if r.last_run_at is not null and r.last_run_at > now() - make_interval(secs => greatest(p_min_interval_s, 0)) then
    return false;
  end if;
  update public.billing_juicereel_reconcile_state set last_run_at = now() where id = 1;
  return true;
end;
$$;

create or replace function public.billing_jr_reconcile_done(p_result jsonb)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with u as (
    update public.billing_juicereel_reconcile_state set last_result = p_result where id = 1
    returning 1)
  select exists (select 1 from u);
$$;

-- After Juice Reel's current-subscriber list was read TO ITS END: a linked
-- buyer EdgeDesk holds as paid (and not provisionally) who is not on it is
-- raised for a human, never ended on a guess. Access still ends on its own at
-- the expiry Juice Reel stated.
create or replace function public.billing_jr_reconcile_absent(p_seen text[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r record; n int := 0;
begin
  for r in
    select s.jr_user_id, l.user_id, s.expires_at from public.billing_juicereel_subscribers s
      join public.billing_juicereel_links l on l.jr_user_id = s.jr_user_id
     where s.active and not s.provisional and s.expires_at > now()
       and not (s.jr_user_id = any(coalesce(p_seen, array[]::text[])))
  loop
    perform public.billing_raise_alert('juicereel_absent_from_current', 'jr:' || r.jr_user_id, r.user_id, null, null, null,
      jsonb_build_object('jr_user_id', r.jr_user_id, 'expires_at', r.expires_at,
                         'note', 'EdgeDesk holds this buyer as paid; Juice Reel''s current-subscriber list does not include them'));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ── 9. FOR OPERATORS ────────────────────────────────────────────────────────
-- Counts, and the buyers who paid on Juice Reel but have not linked an EdgeDesk
-- account yet (the people to reach out to).
create or replace function public.billing_admin_juicereel_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.billing_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'links', (select count(*) from public.billing_juicereel_links),
    'paid_now', (select count(*) from public.billing_juicereel_subscribers where active and expires_at > now()),
    'paid_now_linked', (select count(*) from public.billing_juicereel_subscribers s
                         join public.billing_juicereel_links l on l.jr_user_id = s.jr_user_id
                        where s.active and s.expires_at > now()),
    'paid_not_linked', coalesce((select jsonb_agg(jsonb_build_object('jr_user_id', s.jr_user_id, 'expires_at', s.expires_at,
                                   'since', s.as_of) order by s.as_of desc)
                          from (select * from public.billing_juicereel_subscribers s0
                                 where s0.active and s0.expires_at > now()
                                   and not exists (select 1 from public.billing_juicereel_links l where l.jr_user_id = s0.jr_user_id)
                                 order by s0.as_of desc limit 50) s), '[]'::jsonb),
    'webhooks_24h', (select count(*) from public.billing_juicereel_events where received_at > now() - interval '24 hours'),
    'last_webhook_at', (select max(received_at) from public.billing_juicereel_events),
    'reconcile', (select jsonb_build_object('last_run_at', last_run_at, 'last_result', last_result)
                    from public.billing_juicereel_reconcile_state where id = 1));
end;
$$;

-- Move a Juice Reel account off an EdgeDesk account (the buyer linked the wrong
-- one). The access Juice Reel granted there ends now; the buyer then links the
-- right account and it opens.
create or replace function public.billing_admin_juicereel_unlink(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_jr text; n int;
begin
  if not public.billing_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  delete from public.billing_juicereel_links where user_id = p_user returning jr_user_id into v_jr;
  if v_jr is null then return jsonb_build_object('ok', false, 'reason', 'not_linked'); end if;
  update public.subscriptions set status = 'canceled', current_period_end = least(current_period_end, now()),
         sync_source = 'juicereel_unlink', updated_at = now()
   where user_id = p_user and price_id = 'juicereel';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'jr_user_id', v_jr, 'access_ended', n = 1);
end;
$$;

-- ── 10. GRANTS ──────────────────────────────────────────────────────────────
-- A Supabase project grants EXECUTE on every new public function to anon and
-- authenticated by default, so revoking from PUBLIC alone is not enough.
revoke all on function public.billing_jr_session_open(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.billing_jr_session_attach(text, text) from public, anon, authenticated;
revoke all on function public.billing_jr_session_consume(uuid, text) from public, anon, authenticated;
revoke all on function public.billing_jr_session_release(uuid, text) from public, anon, authenticated;
revoke all on function public.billing_jr_session_finish(text, text) from public, anon, authenticated;
revoke all on function public.billing_jr_link(uuid, text, text) from public, anon, authenticated;
revoke all on function public.billing_jr_project(uuid) from public, anon, authenticated;
revoke all on function public.billing_jr_record_state(text, boolean, timestamptz, boolean, text, timestamptz, text, text, boolean) from public, anon, authenticated;
revoke all on function public.billing_jr_record_event(text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.billing_jr_event_outcome(text, text) from public, anon, authenticated;
revoke all on function public.billing_jr_status(uuid) from public, anon, authenticated;
revoke all on function public.billing_jr_reconcile_admit(integer) from public, anon, authenticated;
revoke all on function public.billing_jr_reconcile_done(jsonb) from public, anon, authenticated;
revoke all on function public.billing_jr_reconcile_absent(text[]) from public, anon, authenticated;
-- the operator doors: callable signed in, refused unless billing_is_admin()
revoke all on function public.billing_admin_juicereel_overview() from public, anon;
grant execute on function public.billing_admin_juicereel_overview() to authenticated;
revoke all on function public.billing_admin_juicereel_unlink(uuid) from public, anon;
grant execute on function public.billing_admin_juicereel_unlink(uuid) to authenticated;
do $g$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.billing_jr_session_open(uuid, text, text, text), '
         || 'public.billing_jr_session_attach(text, text), public.billing_jr_session_consume(uuid, text), '
         || 'public.billing_jr_session_release(uuid, text), public.billing_jr_session_finish(text, text), '
         || 'public.billing_jr_link(uuid, text, text), public.billing_jr_project(uuid), '
         || 'public.billing_jr_record_state(text, boolean, timestamptz, boolean, text, timestamptz, text, text, boolean), '
         || 'public.billing_jr_record_event(text, text, text, timestamptz, jsonb), public.billing_jr_event_outcome(text, text), '
         || 'public.billing_jr_status(uuid), public.billing_jr_reconcile_admit(integer), '
         || 'public.billing_jr_reconcile_done(jsonb), public.billing_jr_reconcile_absent(text[]) to service_role';
    execute 'grant select, insert, update, delete on public.billing_juicereel_sessions, public.billing_juicereel_links, '
         || 'public.billing_juicereel_subscribers, public.billing_juicereel_events, public.billing_juicereel_reconcile_state to service_role';
  end if;
end
$g$;

-- ── report ──────────────────────────────────────────────────────────────────
select 1 as row, 'the Juice Reel billing tables exist with RLS on' as check,
       case when (select count(*) from pg_class where oid in ('public.billing_juicereel_sessions'::regclass,
                    'public.billing_juicereel_links'::regclass, 'public.billing_juicereel_subscribers'::regclass,
                    'public.billing_juicereel_events'::regclass, 'public.billing_juicereel_reconcile_state'::regclass)
                    and relrowsecurity) = 5
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'no client role can read or write them, and no policy opens them',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'public' and grantee in ('anon', 'authenticated')
                                and table_name like 'billing\_juicereel\_%')
             and not exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'billing\_juicereel\_%')
            then 'ok' else 'CHECK THIS' end
union all select 3, 'no client role can call a billing_jr_* function (they write access)',
       case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.proname like 'billing\_jr\_%'
                                and (has_function_privilege('anon', p.oid, 'execute')
                                     or has_function_privilege('authenticated', p.oid, 'execute')))
             and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname like 'billing\_jr\_%') = 14
            then 'ok' else 'CHECK THIS' end
union all select 4, 'the operator functions are signed-in only and check billing_is_admin()',
       case when has_function_privilege('authenticated', 'public.billing_admin_juicereel_overview()', 'execute')
             and not has_function_privilege('anon', 'public.billing_admin_juicereel_overview()', 'execute')
             and not has_function_privilege('anon', 'public.billing_admin_juicereel_unlink(uuid)', 'execute')
             and pg_get_functiondef('public.billing_admin_juicereel_overview()'::regprocedure) like '%billing_is_admin()%'
             and pg_get_functiondef('public.billing_admin_juicereel_unlink(uuid)'::regprocedure) like '%billing_is_admin()%'
            then 'ok' else 'CHECK THIS' end
union all select 5, 'the access rule grants a paid Juice Reel row the terminal until its expiry, and nothing after',
       case when public.billing_row_grants_access('active', 'juicereel', now() + interval '1 day', now())
             and not public.billing_row_grants_access('active', 'juicereel', now() - interval '1 second', now())
             and not public.billing_row_grants_access('canceled', 'juicereel', now() + interval '1 day', now())
             and coalesce(public.billing_tier_of_price('juicereel'), 'blue') = 'blue'
            then 'ok' else 'CHECK THIS' end
union all select 6, 'subscriptions is still unwritable by any client role',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'public' and table_name = 'subscriptions'
                                and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
            then 'ok' else 'CHECK THIS — run supabase/billing.sql' end
union all select 7, 'existing rows preserved',
       'ok (' || (select count(*) from public.subscriptions)::text || ' subscriptions, '
              || (select count(*) from public.billing_juicereel_links)::text || ' Juice Reel links, '
              || (select count(*) from public.billing_juicereel_subscribers)::text || ' Juice Reel buyers)'
order by row;

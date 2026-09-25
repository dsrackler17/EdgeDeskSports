-- =============================================================================
-- affiliates — a partner program that tracks what actually happened and pays
-- nothing automatically.
--
-- WHAT IT IS
--   A creator gets a code and a link (edgedesksports.com/?ref=CODE). A visit
--   through the link is a CLICK; an account created afterwards is an
--   ATTRIBUTION; what that account then does in Stripe is a CONVERSION (trial
--   started, paid, renewed, cancelled, refunded); and a paid invoice under an
--   attribution earns a COMMISSION at the program's configured rate. Every one
--   of those is a row, so the partner dashboard and the admin console are
--   counts of rows and never estimates.
--
-- WHAT IT BUILDS ON (nothing here replaces it)
--   public.referrals         first-touch ?ref= capture the landing page already
--                            writes at signup (billing.sql). Kept as the
--                            marketing record; it is reader-writable, so it is
--                            NOT trusted for money.
--   public.referral_codes    Stripe promotion codes and who they belong to
--                            (referral_codes.sql). An affiliate may be linked
--                            to one, so a sale made with the partner's promo
--                            code but no link click is still theirs.
--   public.stripe_events     the webhook's delivery ledger, every event with its
--                            full payload (stripe_webhook.sql). Conversions are
--                            read from HERE, by a trigger, so the deployed
--                            webhook needs no change and an attribution failure
--                            can never cost a customer their access.
--   public.subscriptions     the webhook-maintained subscription state.
--
-- MONEY RULES
--   * Commission percentage, duration, hold period and attribution window live
--     in ONE settings row the admin edits. Nothing in the application hard-codes
--     the economics.
--   * A commission is PENDING until its hold (the refund window) has passed,
--     APPROVED by an admin (or automatically when the admin turns that on),
--     and PAID only when an admin records the payout reference. There is no
--     payout provider here and nothing moves money.
--   * A refund voids an unpaid commission and books a negative CLAWBACK row
--     against a paid one. Rows are never edited into different amounts.
--   * Self-referral is refused at attribution and again at conversion.
--   * The first valid attribution wins and is never overwritten.
--   * An existing customer cannot be claimed by a link clicked afterwards.
--
-- RUN ORDER. billing.sql, stripe_webhook.sql and referral_codes.sql first
-- (the guard below says so). Then this file.
--
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'public.subscriptions does not exist. Run supabase/billing.sql first.';
  end if;
  if to_regclass('public.stripe_events') is null then
    raise exception 'public.stripe_events does not exist. Run supabase/stripe_webhook.sql first.';
  end if;
end
$guard$;

-- ── settings: the economics, in one row ─────────────────────────────────────
create table if not exists public.affiliate_settings (
  id                          int primary key default 1,
  default_commission_rate     numeric not null default 0.25,
  commission_duration_months  int default 12,
  hold_days                   int not null default 30,
  attribution_window_days     int not null default 60,
  auto_approve                boolean not null default false,
  program_open                boolean not null default false,
  min_payout_cents            int not null default 5000,
  terms_version               text not null default 'affiliate-2026-09-v1',
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_settings_singleton') then
    alter table public.affiliate_settings add constraint affiliate_settings_singleton check (id = 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_settings_ranges') then
    alter table public.affiliate_settings add constraint affiliate_settings_ranges check (
          default_commission_rate >= 0 and default_commission_rate <= 0.9
      and (commission_duration_months is null or commission_duration_months between 1 and 120)
      and hold_days between 0 and 180
      and attribution_window_days between 1 and 365
      and min_payout_cents between 0 and 10000000);
  end if;
end $c$;
insert into public.affiliate_settings (id) values (1) on conflict (id) do nothing;
alter table public.affiliate_settings enable row level security;
drop policy if exists affiliate_settings_read on public.affiliate_settings;
create policy affiliate_settings_read on public.affiliate_settings for select to authenticated using (true);
revoke all on public.affiliate_settings from anon;
revoke insert, update, delete on public.affiliate_settings from authenticated;
grant select on public.affiliate_settings to authenticated;

-- ── who administers the program ─────────────────────────────────────────────
create table if not exists public.affiliate_admins (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  added_at  timestamptz not null default now()
);
alter table public.affiliate_admins enable row level security;
revoke all on public.affiliate_admins from anon, authenticated;
-- the owner account (app.html PG_OWNER_ID), where it exists on this project
insert into public.affiliate_admins (user_id)
select u.id from auth.users u where u.id = 'e7e46801-80c4-4f47-b718-4aff211c8d3a'::uuid
on conflict (user_id) do nothing;

create or replace function public.affiliate_is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (select 1 from public.affiliate_admins where user_id = auth.uid());
$$;
revoke all on function public.affiliate_is_admin() from public;
grant execute on function public.affiliate_is_admin() to authenticated;

-- ── affiliate accounts ──────────────────────────────────────────────────────
create table if not exists public.affiliate_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid unique references auth.users(id) on delete set null,
  code              text not null,
  display_name      text,
  status            text not null default 'pending',
  commission_rate   numeric,
  stripe_promo_code text,
  payout_email      text,
  admin_note        text,
  created_at        timestamptz not null default now(),
  approved_at       timestamptz,
  approved_by       uuid
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_accounts_shape') then
    alter table public.affiliate_accounts add constraint affiliate_accounts_shape check (
          code ~ '^[A-Z0-9_-]{3,32}$'
      and status in ('pending','active','paused','closed')
      and (commission_rate is null or (commission_rate >= 0 and commission_rate <= 0.9))
      and (display_name is null or length(display_name) <= 80)
      and (stripe_promo_code is null or stripe_promo_code ~ '^[A-Z0-9_.-]{1,64}$')
      and (payout_email is null or (length(payout_email) <= 200 and payout_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
      and (admin_note is null or length(admin_note) <= 1000));
  end if;
end $c$;
create unique index if not exists affiliate_accounts_code_ci on public.affiliate_accounts (upper(code));
create unique index if not exists affiliate_accounts_promo_ci on public.affiliate_accounts (upper(stripe_promo_code)) where stripe_promo_code is not null;
alter table public.affiliate_accounts enable row level security;
drop policy if exists affiliate_accounts_select_own on public.affiliate_accounts;
create policy affiliate_accounts_select_own on public.affiliate_accounts for select to authenticated using (user_id = auth.uid());
revoke all on public.affiliate_accounts from anon;
revoke insert, update, delete on public.affiliate_accounts from authenticated;
grant select on public.affiliate_accounts to authenticated;

-- ── clicks ───────────────────────────────────────────────────────────────────
-- One row per (affiliate, visitor, UTC day). The visitor id is a random value
-- the page generates and keeps in first-party storage; only its hash is kept.
create table if not exists public.affiliate_clicks (
  id            bigint generated always as identity primary key,
  affiliate_id  uuid not null references public.affiliate_accounts(id) on delete cascade,
  visitor_hash  text not null,
  click_day     date not null default ((now() at time zone 'utc')::date),
  landing_path  text,
  referrer_host text,
  created_at    timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_clicks_once_a_day') then
    alter table public.affiliate_clicks add constraint affiliate_clicks_once_a_day unique (affiliate_id, visitor_hash, click_day);
  end if;
end $c$;
create index if not exists affiliate_clicks_visitor_idx on public.affiliate_clicks (visitor_hash, created_at);
alter table public.affiliate_clicks enable row level security;
revoke all on public.affiliate_clicks from anon, authenticated;

-- ── attributions: one per referred account, first valid wins ────────────────
create table if not exists public.affiliate_attributions (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  affiliate_id   uuid not null references public.affiliate_accounts(id),
  code           text not null,
  source         text not null,
  visitor_hash   text,
  first_click_at timestamptz,
  attributed_at  timestamptz not null default now(),
  status         text not null default 'active',
  void_reason    text
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_attributions_shape') then
    alter table public.affiliate_attributions add constraint affiliate_attributions_shape check (
      source in ('link','promo_code','admin') and status in ('active','void'));
  end if;
end $c$;
create index if not exists affiliate_attributions_affiliate_idx on public.affiliate_attributions (affiliate_id);
alter table public.affiliate_attributions enable row level security;
revoke all on public.affiliate_attributions from anon, authenticated;

-- ── conversions: what an attributed account did, idempotent by key ──────────
create table if not exists public.affiliate_conversions (
  id                      bigint generated always as identity primary key,
  affiliate_id            uuid not null references public.affiliate_accounts(id),
  user_id                 uuid references auth.users(id) on delete set null,
  kind                    text not null,
  dedupe_key              text not null,
  stripe_event_id         text,
  stripe_invoice_id       text,
  stripe_subscription_id  text,
  amount_cents            bigint,
  currency                text,
  occurred_at             timestamptz not null,
  note                    text,
  created_at              timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_conversions_once') then
    alter table public.affiliate_conversions add constraint affiliate_conversions_once unique (dedupe_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_conversions_kind') then
    alter table public.affiliate_conversions add constraint affiliate_conversions_kind check (
      kind in ('trial_started','paid','renewal','canceled','refunded'));
  end if;
end $c$;
create index if not exists affiliate_conversions_affiliate_idx on public.affiliate_conversions (affiliate_id, occurred_at desc);
alter table public.affiliate_conversions enable row level security;
revoke all on public.affiliate_conversions from anon, authenticated;

-- ── commissions ──────────────────────────────────────────────────────────────
create table if not exists public.affiliate_commissions (
  id                 bigint generated always as identity primary key,
  affiliate_id       uuid not null references public.affiliate_accounts(id),
  user_id            uuid references auth.users(id) on delete set null,
  conversion_id      bigint not null references public.affiliate_conversions(id),
  stripe_invoice_id  text,
  kind               text not null default 'accrual',
  basis_cents        bigint not null,
  rate               numeric not null,
  amount_cents       bigint not null,
  currency           text not null default 'USD',
  status             text not null default 'pending',
  eligible_at        timestamptz not null,
  approved_at        timestamptz,
  approved_by        uuid,
  paid_at            timestamptz,
  paid_by            uuid,
  payout_reference   text,
  void_reason        text,
  created_at         timestamptz not null default now()
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_commissions_once') then
    alter table public.affiliate_commissions add constraint affiliate_commissions_once unique (conversion_id, kind);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_commissions_shape') then
    alter table public.affiliate_commissions add constraint affiliate_commissions_shape check (
          kind in ('accrual','clawback')
      and status in ('pending','approved','paid','void')
      and rate >= 0 and rate <= 0.9
      and ((kind = 'accrual' and amount_cents >= 0 and basis_cents >= 0) or (kind = 'clawback' and amount_cents <= 0))
      and (status <> 'paid' or (paid_at is not null and payout_reference is not null))
      and (payout_reference is null or length(payout_reference) <= 200));
  end if;
end $c$;
create index if not exists affiliate_commissions_affiliate_idx on public.affiliate_commissions (affiliate_id, status);
create index if not exists affiliate_commissions_invoice_idx on public.affiliate_commissions (stripe_invoice_id);
-- the money columns are never rewritten; only the status walks forward
create or replace function public.affiliate_commissions_guard()
returns trigger language plpgsql as $$
begin
  if (new.affiliate_id, new.user_id, new.conversion_id, new.stripe_invoice_id, new.kind, new.basis_cents,
      new.rate, new.amount_cents, new.currency, new.eligible_at, new.created_at)
     is distinct from
     (old.affiliate_id, old.user_id, old.conversion_id, old.stripe_invoice_id, old.kind, old.basis_cents,
      old.rate, old.amount_cents, old.currency, old.eligible_at, old.created_at) then
    raise exception 'affiliate_commissions: amounts are never edited; void the row and book a new one' using errcode = 'restrict_violation';
  end if;
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'affiliate_commissions: a paid commission stays paid; a refund books a clawback' using errcode = 'restrict_violation';
  end if;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'affiliate_commissions: a void commission stays void' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists affiliate_commissions_guard_trg on public.affiliate_commissions;
create trigger affiliate_commissions_guard_trg before update on public.affiliate_commissions
  for each row execute function public.affiliate_commissions_guard();
create or replace function public.affiliate_commissions_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'affiliate_commissions rows are never deleted (row %)', old.id using errcode = 'restrict_violation';
end $$;
drop trigger if exists affiliate_commissions_no_delete_trg on public.affiliate_commissions;
create trigger affiliate_commissions_no_delete_trg before delete on public.affiliate_commissions
  for each row execute function public.affiliate_commissions_no_delete();
alter table public.affiliate_commissions enable row level security;
revoke all on public.affiliate_commissions from anon, authenticated;

do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.affiliate_settings, public.affiliate_accounts, public.affiliate_clicks,
             public.affiliate_attributions, public.affiliate_conversions, public.affiliate_commissions to service_role';
  end if;
end $g$;

-- ── reading a Stripe payload, whichever shape it was stored in ──────────────
-- The webhook stores the WHOLE event (payload = {id, type, data:{object}}).
-- Fixtures and hand-pasted rows sometimes hold the bare object. Both are read.
create or replace function public.affiliate_stripe_object(p jsonb)
returns jsonb language sql immutable as $$
  select case when p ? 'data' and jsonb_typeof(p -> 'data' -> 'object') = 'object' then p -> 'data' -> 'object' else p end;
$$;
create or replace function public.affiliate_stripe_id(p jsonb)
returns text language sql immutable as $$
  select case when p is null or jsonb_typeof(p) = 'null' then null
              when jsonb_typeof(p) = 'string' then nullif(p #>> '{}', '')
              when jsonb_typeof(p) = 'object' then nullif(p ->> 'id', '')
              else null end;
$$;

-- ── attribution: the door the signed-in page knocks on ──────────────────────
-- No user argument: the claim is always for the caller. Returns why, when it
-- refuses, so the page can stay quiet about it without guessing.
create or replace function public.affiliate_claim(p_code text, p_visitor text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_aff public.affiliate_accounts%rowtype;
  v_set public.affiliate_settings%rowtype;
  v_hash text; v_click timestamptz; v_created timestamptz; v_sub record;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if p_code is null or upper(btrim(p_code)) !~ '^[A-Z0-9_-]{3,32}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;
  if exists (select 1 from public.affiliate_attributions where user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_attributed');
  end if;
  select * into v_aff from public.affiliate_accounts where upper(code) = upper(btrim(p_code));
  if not found or v_aff.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'unknown_or_inactive_code'); end if;
  if v_aff.user_id = v_uid then return jsonb_build_object('ok', false, 'reason', 'self_referral'); end if;
  select * into v_set from public.affiliate_settings where id = 1;
  if p_visitor is not null and p_visitor ~ '^[A-Za-z0-9_-]{16,64}$' then
    v_hash := md5('edgedesk-affiliate:' || p_visitor);
    select min(created_at) into v_click from public.affiliate_clicks where affiliate_id = v_aff.id and visitor_hash = v_hash;
  end if;
  select created_at into v_created from auth.users where id = v_uid;
  -- the click, when known, must precede the account and fall inside the window
  if v_click is not null and v_created is not null
     and v_created > v_click + make_interval(days => v_set.attribution_window_days) then
    return jsonb_build_object('ok', false, 'reason', 'outside_attribution_window');
  end if;
  -- an existing customer is not claimable by a link clicked afterwards
  select status, created_at into v_sub from public.subscriptions where user_id = v_uid;
  if found and (v_click is null or v_sub.created_at < v_click) then
    return jsonb_build_object('ok', false, 'reason', 'existing_customer');
  end if;
  insert into public.affiliate_attributions (user_id, affiliate_id, code, source, visitor_hash, first_click_at)
  values (v_uid, v_aff.id, v_aff.code, 'link', v_hash, v_click)
  on conflict (user_id) do nothing;
  if not found then return jsonb_build_object('ok', false, 'reason', 'already_attributed'); end if;
  return jsonb_build_object('ok', true, 'code', v_aff.code);
end $$;
revoke all on function public.affiliate_claim(text, text) from public;
grant execute on function public.affiliate_claim(text, text) to authenticated;

-- ── clicks: callable without an account (it is a landing page) ──────────────
create or replace function public.affiliate_track_click(p_code text, p_visitor text, p_landing text default null, p_referrer text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_aff public.affiliate_accounts%rowtype; v_hash text; v_today int;
begin
  if p_code is null or upper(btrim(p_code)) !~ '^[A-Z0-9_-]{3,32}$' then return jsonb_build_object('ok', false); end if;
  if p_visitor is null or p_visitor !~ '^[A-Za-z0-9_-]{16,64}$' then return jsonb_build_object('ok', false); end if;
  select * into v_aff from public.affiliate_accounts where upper(code) = upper(btrim(p_code)) and status = 'active';
  if not found then return jsonb_build_object('ok', false); end if;
  -- a flood from one partner's link is capped rather than stored without limit
  select count(*) into v_today from public.affiliate_clicks
   where affiliate_id = v_aff.id and click_day = (now() at time zone 'utc')::date;
  if v_today >= 20000 then return jsonb_build_object('ok', true, 'capped', true); end if;
  v_hash := md5('edgedesk-affiliate:' || p_visitor);
  insert into public.affiliate_clicks (affiliate_id, visitor_hash, landing_path, referrer_host)
  values (v_aff.id, v_hash, left(regexp_replace(coalesce(p_landing, ''), '[^A-Za-z0-9/_.-]', '', 'g'), 120),
          left(regexp_replace(coalesce(p_referrer, ''), '[^A-Za-z0-9._-]', '', 'g'), 120))
  on conflict on constraint affiliate_clicks_once_a_day do nothing;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.affiliate_track_click(text, text, text, text) from public;
grant execute on function public.affiliate_track_click(text, text, text, text) to anon, authenticated;

-- ── a partner applies (only while the program is open) ──────────────────────
create or replace function public.affiliate_apply(p_code text, p_display_name text default null, p_payout_email text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_open boolean; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select program_open into v_open from public.affiliate_settings where id = 1;
  if not coalesce(v_open, false) then return jsonb_build_object('ok', false, 'reason', 'program_by_invitation'); end if;
  if v_code !~ '^[A-Z0-9_-]{3,32}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  if exists (select 1 from public.affiliate_accounts where user_id = v_uid) then return jsonb_build_object('ok', false, 'reason', 'already_applied'); end if;
  if exists (select 1 from public.affiliate_accounts where upper(code) = v_code) then return jsonb_build_object('ok', false, 'reason', 'code_taken'); end if;
  insert into public.affiliate_accounts (user_id, code, display_name, payout_email, status)
  values (v_uid, v_code, nullif(left(btrim(coalesce(p_display_name, '')), 80), ''), nullif(btrim(coalesce(p_payout_email, '')), ''), 'pending');
  return jsonb_build_object('ok', true, 'code', v_code, 'status', 'pending');
end $$;
revoke all on function public.affiliate_apply(text, text, text) from public;
grant execute on function public.affiliate_apply(text, text, text) to authenticated;

-- ── processing one Stripe event into conversions and commissions ────────────
create or replace function public.affiliate_process_event(p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; o jsonb; v_user uuid; v_attr record; v_aff public.affiliate_accounts%rowtype;
  v_set public.affiliate_settings%rowtype; v_sub_id text; v_cust text; v_inv text; v_status text;
  v_amt bigint; v_tax bigint; v_basis bigint; v_rate numeric; v_conv bigint; v_first timestamptz;
  v_at timestamptz; v_kind text; v_charge_amt bigint; v_refunded bigint; v_com record; v_promo text; v_has boolean;
begin
  select * into e from public.stripe_events where id = p_event_id;
  if not found then return 'no_event'; end if;
  o := public.affiliate_stripe_object(e.payload);
  if o is null then return 'no_payload'; end if;
  v_at := coalesce(e.stripe_created, e.created_at);
  v_cust := coalesce(e.customer_id, public.affiliate_stripe_id(o -> 'customer'));
  v_sub_id := coalesce(e.subscription_id,
                       public.affiliate_stripe_id(o -> 'subscription'),
                       public.affiliate_stripe_id(o -> 'parent' -> 'subscription_details' -> 'subscription'),
                       case when e.type like 'customer.subscription.%' then o ->> 'id' end);
  -- who, in descending order of certainty; nothing is guessed
  v_user := e.user_id;
  if v_user is null and v_sub_id is not null then
    select user_id into v_user from public.subscriptions where stripe_subscription_id = v_sub_id limit 1;
  end if;
  if v_user is null and v_cust is not null then
    select user_id into v_user from public.subscriptions where stripe_customer_id = v_cust limit 1;
  end if;
  if v_user is null then return 'unresolved'; end if;

  select * into v_attr from public.affiliate_attributions where user_id = v_user and status = 'active';
  v_has := found;
  if not v_has then
    -- a sale made with a partner's promotion code, and no link, is still theirs
    select upper(nullif(btrim(referral_code), '')) into v_promo from public.subscriptions where user_id = v_user;
    if v_promo is not null then
      select * into v_aff from public.affiliate_accounts
       where status in ('active','paused') and (upper(code) = v_promo or upper(stripe_promo_code) = v_promo) limit 1;
      if found and v_aff.user_id is distinct from v_user then
        insert into public.affiliate_attributions (user_id, affiliate_id, code, source)
        values (v_user, v_aff.id, v_aff.code, 'promo_code') on conflict (user_id) do nothing;
        select * into v_attr from public.affiliate_attributions where user_id = v_user and status = 'active';
        v_has := found;
      end if;
    end if;
    if not v_has then return 'unattributed'; end if;
  end if;
  select * into v_aff from public.affiliate_accounts where id = v_attr.affiliate_id;
  if v_aff.user_id = v_user then return 'self_referral'; end if;
  select * into v_set from public.affiliate_settings where id = 1;

  if e.type in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') then
    v_status := case when e.type = 'customer.subscription.deleted' then 'canceled' else o ->> 'status' end;
    if v_status = 'trialing' then
      insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_subscription_id, occurred_at)
      values (v_aff.id, v_user, 'trial_started', 'trial:' || v_user, e.id, v_sub_id, v_at)
      on conflict (dedupe_key) do nothing;
    elsif v_status = 'canceled' or coalesce((o ->> 'cancel_at_period_end')::boolean, false) then
      insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_subscription_id, occurred_at, note)
      values (v_aff.id, v_user, 'canceled', 'cancel:' || coalesce(v_sub_id, v_user::text), e.id, v_sub_id, v_at,
              case when v_status = 'canceled' then 'subscription ended' else 'set to cancel at period end' end)
      on conflict (dedupe_key) do nothing;
    end if;
    return 'subscription:' || coalesce(v_status, 'unknown');
  end if;

  if e.type in ('invoice.payment_succeeded', 'invoice.paid') then
    v_inv := o ->> 'id';
    v_amt := case when (o ->> 'amount_paid') ~ '^[0-9]+$' then (o ->> 'amount_paid')::bigint else 0 end;
    if v_inv is null or v_amt <= 0 then return 'invoice:no_money'; end if;
    v_tax := case when (o ->> 'tax') ~ '^[0-9]+$' then (o ->> 'tax')::bigint
                  else coalesce((select sum((t ->> 'amount')::bigint) from jsonb_array_elements(coalesce(o -> 'total_taxes', '[]'::jsonb)) t
                                  where (t ->> 'amount') ~ '^[0-9]+$'), 0) end;
    v_basis := greatest(v_amt - coalesce(v_tax, 0), 0);
    select min(occurred_at) into v_first from public.affiliate_conversions where user_id = v_user and kind = 'paid';
    v_kind := case when v_first is null then 'paid' else 'renewal' end;
    insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_invoice_id,
                                              stripe_subscription_id, amount_cents, currency, occurred_at)
    values (v_aff.id, v_user, v_kind, 'invoice:' || v_inv, e.id, v_inv, v_sub_id, v_amt, upper(coalesce(o ->> 'currency', 'usd')), v_at)
    on conflict (dedupe_key) do nothing
    returning id into v_conv;
    if v_conv is null then return 'invoice:already_recorded'; end if;
    -- inside the commission duration, for an active partner only
    if v_aff.status <> 'active' then return 'invoice:partner_not_active'; end if;
    if v_first is not null and v_set.commission_duration_months is not null
       and v_at > v_first + make_interval(months => v_set.commission_duration_months) then
      return 'invoice:past_commission_duration';
    end if;
    v_rate := coalesce(v_aff.commission_rate, v_set.default_commission_rate);
    insert into public.affiliate_commissions (affiliate_id, user_id, conversion_id, stripe_invoice_id, kind, basis_cents, rate,
                                              amount_cents, currency, status, eligible_at)
    values (v_aff.id, v_user, v_conv, v_inv, 'accrual', v_basis, v_rate, round(v_basis * v_rate)::bigint,
            upper(coalesce(o ->> 'currency', 'usd')), 'pending', v_at + make_interval(days => v_set.hold_days))
    on conflict on constraint affiliate_commissions_once do nothing;
    return 'invoice:' || v_kind;
  end if;

  if e.type = 'charge.refunded' then
    v_inv := public.affiliate_stripe_id(o -> 'invoice');
    v_charge_amt := case when (o ->> 'amount') ~ '^[0-9]+$' then (o ->> 'amount')::bigint else null end;
    v_refunded := case when (o ->> 'amount_refunded') ~ '^[0-9]+$' then (o ->> 'amount_refunded')::bigint else null end;
    if v_inv is null or v_charge_amt is null or v_refunded is null or v_refunded <= 0 then return 'refund:unreadable'; end if;
    insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_invoice_id,
                                              amount_cents, currency, occurred_at)
    values (v_aff.id, v_user, 'refunded', 'refund:' || coalesce(o ->> 'id', e.id) || ':' || v_refunded, e.id, v_inv,
            v_refunded, upper(coalesce(o ->> 'currency', 'usd')), v_at)
    on conflict (dedupe_key) do nothing
    returning id into v_conv;
    if v_conv is null then return 'refund:already_recorded'; end if;
    select * into v_com from public.affiliate_commissions where stripe_invoice_id = v_inv and kind = 'accrual' order by id limit 1;
    if not found then return 'refund:no_commission'; end if;
    if v_refunded >= v_charge_amt and v_com.status in ('pending', 'approved') then
      update public.affiliate_commissions set status = 'void', void_reason = 'invoice refunded in full' where id = v_com.id;
      return 'refund:voided';
    end if;
    -- a paid commission, or a partial refund: a negative row, proportional
    insert into public.affiliate_commissions (affiliate_id, user_id, conversion_id, stripe_invoice_id, kind, basis_cents, rate,
                                              amount_cents, currency, status, eligible_at)
    values (v_com.affiliate_id, v_com.user_id, v_conv, v_inv, 'clawback', 0, v_com.rate,
            -least(v_com.amount_cents, round(v_com.amount_cents::numeric * v_refunded / v_charge_amt)::bigint),
            v_com.currency, 'pending', v_at)
    on conflict on constraint affiliate_commissions_once do nothing;
    return 'refund:clawback';
  end if;
  return 'ignored:' || e.type;
end $$;
revoke all on function public.affiliate_process_event(text) from public, anon, authenticated;

-- The ledger trigger. It can NEVER fail the webhook's write: a customer's
-- access is worth more than an attribution, so any error is a warning.
create or replace function public.affiliate_on_stripe_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.affiliate_process_event(new.id);
  exception when others then
    raise warning 'affiliate: stripe event % not processed: %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists affiliate_on_stripe_event_trg on public.stripe_events;
create trigger affiliate_on_stripe_event_trg after insert or update of user_id, resolved, payload on public.stripe_events
  for each row execute function public.affiliate_on_stripe_event();

-- Delivery is out of order: an event can land before the checkout that names
-- its customer. Reconcile replays the window, idempotently, and also records
-- a trial for an attributed account whose subscription row says trialing.
create or replace function public.affiliate_reconcile(p_days int default 45)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; t int := 0; a int := 0;
begin
  for r in select id from public.stripe_events
            where type in ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
                           'invoice.payment_succeeded','invoice.paid','charge.refunded')
              and created_at > now() - make_interval(days => greatest(1, least(p_days, 400)))
            order by coalesce(stripe_created, created_at), id loop
    perform public.affiliate_process_event(r.id); n := n + 1;
  end loop;
  insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_subscription_id, occurred_at, note)
  select at.affiliate_id, at.user_id, 'trial_started', 'trial:' || at.user_id, s.stripe_subscription_id, coalesce(s.created_at, now()),
         'from the subscription state'
    from public.affiliate_attributions at
    join public.subscriptions s on s.user_id = at.user_id
    join public.affiliate_accounts ac on ac.id = at.affiliate_id
   where at.status = 'active' and s.status = 'trialing' and ac.user_id is distinct from at.user_id
  on conflict (dedupe_key) do nothing;
  get diagnostics t = row_count;
  -- auto-approval, only when the admin has turned it on, only past the hold
  if (select auto_approve from public.affiliate_settings where id = 1) then
    update public.affiliate_commissions set status = 'approved', approved_at = now()
     where status = 'pending' and kind = 'accrual' and eligible_at <= now();
    get diagnostics a = row_count;
  end if;
  return jsonb_build_object('events_replayed', n, 'trials_from_state', t, 'auto_approved', a, 'at', now());
end $$;
revoke all on function public.affiliate_reconcile(int) from public, anon, authenticated;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.affiliate_reconcile(int) to service_role';
  end if;
end $g$;

-- ── the partner's own dashboard ─────────────────────────────────────────────
-- Counts only. No referred customer is named, emailed or identifiable here.
create or replace function public.affiliate_stats(p_affiliate uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with a as (select * from public.affiliate_accounts where id = p_affiliate),
  attr as (select at.* from public.affiliate_attributions at where at.affiliate_id = p_affiliate and at.status = 'active'),
  conv as (select * from public.affiliate_conversions where affiliate_id = p_affiliate),
  com as (select * from public.affiliate_commissions where affiliate_id = p_affiliate)
  select jsonb_build_object(
    'clicks', (select count(*) from public.affiliate_clicks where affiliate_id = p_affiliate),
    'clicks_30d', (select count(*) from public.affiliate_clicks where affiliate_id = p_affiliate and created_at > now() - interval '30 days'),
    'signups', (select count(*) from attr),
    'trials', (select count(distinct user_id) from conv where kind = 'trial_started'),
    'paid_customers', (select count(distinct user_id) from conv where kind = 'paid'),
    'active_paid', (select count(*) from attr join public.subscriptions s on s.user_id = attr.user_id
                     where s.status in ('active', 'past_due') and exists (select 1 from conv c where c.user_id = attr.user_id and c.kind = 'paid')),
    'canceled', (select count(distinct user_id) from conv where kind = 'canceled'),
    'refunds', (select count(*) from conv where kind = 'refunded'),
    'pending_cents', (select coalesce(sum(amount_cents), 0) from com where status = 'pending'),
    'approved_cents', (select coalesce(sum(amount_cents), 0) from com where status = 'approved'),
    'paid_cents', (select coalesce(sum(amount_cents), 0) from com where status = 'paid'),
    'void_cents', (select coalesce(sum(amount_cents), 0) from com where status = 'void'),
    'eligible_now_cents', (select coalesce(sum(amount_cents), 0) from com where status = 'pending' and eligible_at <= now()),
    'recent', (select coalesce(jsonb_agg(x order by x.occurred_at desc), '[]'::jsonb) from (
                 select c.kind, c.occurred_at, c.amount_cents, c.currency,
                        (select cm.status from com cm where cm.conversion_id = c.id limit 1) as commission_status,
                        (select cm.amount_cents from com cm where cm.conversion_id = c.id limit 1) as commission_cents
                   from conv c order by c.occurred_at desc limit 25) x)
  );
$$;
revoke all on function public.affiliate_stats(uuid) from public, anon, authenticated;

create or replace function public.affiliate_my_dashboard()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_aff public.affiliate_accounts%rowtype; v_set public.affiliate_settings%rowtype;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select * into v_set from public.affiliate_settings where id = 1;
  select * into v_aff from public.affiliate_accounts where user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', true, 'account', null, 'program_open', v_set.program_open,
      'default_commission_rate', v_set.default_commission_rate, 'hold_days', v_set.hold_days,
      'commission_duration_months', v_set.commission_duration_months);
  end if;
  return jsonb_build_object('ok', true,
    'account', jsonb_build_object('code', v_aff.code, 'status', v_aff.status, 'display_name', v_aff.display_name,
      'commission_rate', coalesce(v_aff.commission_rate, v_set.default_commission_rate),
      'stripe_promo_code', v_aff.stripe_promo_code, 'created_at', v_aff.created_at),
    'settings', jsonb_build_object('hold_days', v_set.hold_days, 'commission_duration_months', v_set.commission_duration_months,
      'attribution_window_days', v_set.attribution_window_days, 'min_payout_cents', v_set.min_payout_cents,
      'terms_version', v_set.terms_version, 'auto_approve', v_set.auto_approve),
    'stats', public.affiliate_stats(v_aff.id));
end $$;
revoke all on function public.affiliate_my_dashboard() from public;
grant execute on function public.affiliate_my_dashboard() to authenticated;

-- ── admin doors. Every one checks affiliate_is_admin() first. ───────────────
create or replace function public.affiliate_admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.affiliate_settings s where id = 1),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'code', a.code, 'status', a.status,
                    'display_name', a.display_name, 'email', u.email, 'payout_email', a.payout_email,
                    'commission_rate', a.commission_rate, 'stripe_promo_code', a.stripe_promo_code, 'created_at', a.created_at,
                    'stats', public.affiliate_stats(a.id)) order by a.created_at), '[]'::jsonb)
                   from public.affiliate_accounts a left join auth.users u on u.id = a.user_id),
    'commissions', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'code', a.code, 'kind', c.kind, 'status', c.status,
                    'amount_cents', c.amount_cents, 'basis_cents', c.basis_cents, 'rate', c.rate, 'currency', c.currency,
                    'eligible_at', c.eligible_at, 'created_at', c.created_at, 'paid_at', c.paid_at,
                    'payout_reference', c.payout_reference, 'void_reason', c.void_reason, 'invoice', c.stripe_invoice_id)
                    order by c.created_at desc), '[]'::jsonb)
                   from (select * from public.affiliate_commissions order by created_at desc limit 500) c
                   join public.affiliate_accounts a on a.id = c.affiliate_id),
    'unprocessed_events', (select count(*) from public.stripe_events e
                            where e.type in ('invoice.payment_succeeded','invoice.paid','charge.refunded')
                              and e.created_at > now() - interval '45 days'
                              and not exists (select 1 from public.affiliate_conversions c where c.stripe_event_id = e.id)),
    'as_of', now());
end $$;
revoke all on function public.affiliate_admin_overview() from public;
grant execute on function public.affiliate_admin_overview() to authenticated;

create or replace function public.affiliate_admin_upsert_account(p_email text, p_code text, p_status text default 'active',
  p_rate numeric default null, p_promo text default null, p_display_name text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid; v_code text := upper(btrim(coalesce(p_code, ''))); v_id uuid;
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email)) order by created_at limit 1;
  if v_user is null then return jsonb_build_object('ok', false, 'reason', 'no_account_with_that_email'); end if;
  if p_status not in ('pending','active','paused','closed') then return jsonb_build_object('ok', false, 'reason', 'bad_status'); end if;
  insert into public.affiliate_accounts (user_id, code, status, commission_rate, stripe_promo_code, display_name, approved_at, approved_by)
  values (v_user, v_code, p_status, p_rate, nullif(upper(btrim(coalesce(p_promo, ''))), ''), p_display_name,
          case when p_status = 'active' then now() end, case when p_status = 'active' then auth.uid() end)
  on conflict (user_id) do update set code = excluded.code, status = excluded.status, commission_rate = excluded.commission_rate,
     stripe_promo_code = excluded.stripe_promo_code, display_name = coalesce(excluded.display_name, affiliate_accounts.display_name),
     approved_at = coalesce(affiliate_accounts.approved_at, excluded.approved_at),
     approved_by = coalesce(affiliate_accounts.approved_by, excluded.approved_by)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
end $$;
revoke all on function public.affiliate_admin_upsert_account(text, text, text, numeric, text, text) from public;
grant execute on function public.affiliate_admin_upsert_account(text, text, text, numeric, text, text) to authenticated;

create or replace function public.affiliate_admin_update_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  update public.affiliate_settings set
    default_commission_rate = coalesce((p ->> 'default_commission_rate')::numeric, default_commission_rate),
    commission_duration_months = case when p ? 'commission_duration_months'
                                      then nullif(p ->> 'commission_duration_months', '')::int else commission_duration_months end,
    hold_days = coalesce((p ->> 'hold_days')::int, hold_days),
    attribution_window_days = coalesce((p ->> 'attribution_window_days')::int, attribution_window_days),
    auto_approve = coalesce((p ->> 'auto_approve')::boolean, auto_approve),
    program_open = coalesce((p ->> 'program_open')::boolean, program_open),
    min_payout_cents = coalesce((p ->> 'min_payout_cents')::int, min_payout_cents),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  return (select to_jsonb(s) from public.affiliate_settings s where id = 1);
end $$;
revoke all on function public.affiliate_admin_update_settings(jsonb) from public;
grant execute on function public.affiliate_admin_update_settings(jsonb) to authenticated;

create or replace function public.affiliate_admin_commissions(p_ids bigint[], p_action text, p_reference text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0;
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  if p_action = 'approve' then
    update public.affiliate_commissions set status = 'approved', approved_at = now(), approved_by = auth.uid()
     where id = any(p_ids) and status = 'pending' and eligible_at <= now();
  elsif p_action = 'pay' then
    if p_reference is null or length(btrim(p_reference)) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'a payout reference is required');
    end if;
    update public.affiliate_commissions set status = 'paid', paid_at = now(), paid_by = auth.uid(), payout_reference = left(btrim(p_reference), 200)
     where id = any(p_ids) and status = 'approved';
  elsif p_action = 'void' then
    update public.affiliate_commissions set status = 'void', void_reason = left(coalesce(p_reason, 'voided by admin'), 200)
     where id = any(p_ids) and status in ('pending', 'approved');
  else
    return jsonb_build_object('ok', false, 'reason', 'unknown action');
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'changed', n);
end $$;
revoke all on function public.affiliate_admin_commissions(bigint[], text, text, text) from public;
grant execute on function public.affiliate_admin_commissions(bigint[], text, text, text) to authenticated;

create or replace function public.affiliate_admin_reconcile()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  return public.affiliate_reconcile(45);
end $$;
revoke all on function public.affiliate_admin_reconcile() from public;
grant execute on function public.affiliate_admin_reconcile() to authenticated;

notify pgrst, 'reload schema';

-- ── REPORT ───────────────────────────────────────────────────────────────────
select 1 as step, 'the affiliate tables exist' as item,
  case when (select count(*) from pg_tables where schemaname = 'public' and tablename in
    ('affiliate_settings','affiliate_admins','affiliate_accounts','affiliate_clicks','affiliate_attributions',
     'affiliate_conversions','affiliate_commissions')) = 7 then 'ok' else 'CHECK THIS — a table is missing' end as outcome
union all
select 2, 'row level security is on everywhere',
  case when (select count(*) from pg_tables where schemaname = 'public' and rowsecurity and tablename in
    ('affiliate_settings','affiliate_admins','affiliate_accounts','affiliate_clicks','affiliate_attributions',
     'affiliate_conversions','affiliate_commissions')) = 7 then 'ok' else 'CHECK THIS' end
union all
select 3, 'the settings row exists (commission '
  || (select round(default_commission_rate * 100, 1)::text from public.affiliate_settings where id = 1) || '%, hold '
  || (select hold_days::text from public.affiliate_settings where id = 1) || ' days)',
  case when exists (select 1 from public.affiliate_settings where id = 1) then 'ok' else 'CHECK THIS' end
union all
select 4, 'no client role can read money, clicks or attributions directly',
  case when not has_table_privilege('authenticated', 'public.affiliate_commissions', 'select')
        and not has_table_privilege('authenticated', 'public.affiliate_attributions', 'select')
        and not has_table_privilege('anon', 'public.affiliate_clicks', 'select') then 'ok' else 'CHECK THIS' end
union all
select 5, 'the Stripe ledger feeds conversions by trigger',
  case when exists (select 1 from pg_trigger where tgname = 'affiliate_on_stripe_event_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 6, 'commission amounts are never edited or deleted',
  case when exists (select 1 from pg_trigger where tgname = 'affiliate_commissions_guard_trg' and not tgisinternal)
        and exists (select 1 from pg_trigger where tgname = 'affiliate_commissions_no_delete_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 7, 'an admin exists to run the program',
  case when exists (select 1 from public.affiliate_admins) then 'ok'
       else 'ok — none yet: insert your auth.users id into public.affiliate_admins' end
union all
select 8, 'click tracking is callable from the landing page, attribution only when signed in',
  case when has_function_privilege('anon', 'public.affiliate_track_click(text, text, text, text)', 'execute')
        and not has_function_privilege('anon', 'public.affiliate_claim(text, text)', 'execute') then 'ok' else 'CHECK THIS' end
union all
select 9, 'the processing function is not callable by a client',
  case when not has_function_privilege('authenticated', 'public.affiliate_process_event(text)', 'execute')
        and not has_function_privilege('authenticated', 'public.affiliate_reconcile(int)', 'execute') then 'ok' else 'CHECK THIS' end
order by 1;

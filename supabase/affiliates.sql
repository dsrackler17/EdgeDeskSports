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
-- CAMPAIGNS (per creator, per code)
--   A creator can run any number of CAMPAIGNS, each its own code with its own
--   terms: the customer's discount (type, amount, duration — a DESCRIPTION of
--   the Stripe coupon behind the Stripe promotion code, which is what actually
--   applies it), the creator's commission (rate, recurring or one-time, how
--   many months), a start, an end and an on/off switch. The admin creates and
--   disables campaigns from /admin/affiliates/; nothing is deployed.
--   * The creator's terms are SNAPSHOTTED onto the attribution the moment an
--     account is attributed. Editing or disabling a campaign later changes
--     who it can attribute next, never what an attributed customer already
--     earns — and never who they are attributed to.
--   * STRIPE IS THE SOURCE OF TRUTH FOR THE DISCOUNT. Promotion-code and coupon
--     events that reach the webhook's ledger are copied onto the campaign
--     (stripe_snapshot). A discount is shown to a visitor only when Stripe's
--     own record of it exists, is active, and matches what the admin entered;
--     otherwise the checkout still receives the code and Stripe decides.
--   * A campaign that is not in force (inactive, not started, ended, or its
--     creator not active) attributes nobody new through its code — except
--     that a visitor who clicked it while it WAS in force keeps it. A code
--     that is also the creator's own base code falls back to the creator's
--     default terms.
--
-- MONEY RULES
--   * Commission percentage, duration, hold period and attribution window live
--     in ONE settings row the admin edits, and per-campaign terms live in
--     affiliate_campaigns. Nothing in the application hard-codes the economics.
--   * A commission is PENDING until its hold (the refund window) has passed,
--     APPROVED by an admin (or automatically when the admin turns that on),
--     and PAID only when an admin records the payout reference. There is no
--     payout provider here and nothing moves money.
--   * A refund or a dispute books a negative CLAWBACK row against the same
--     invoice: the commission's share of what was refunded or disputed, and
--     never more, across every refund and dispute on that invoice, than the
--     commission originally booked for it. Nothing is voided to do this, and
--     rows are never edited into different amounts.
--   * A commission's dates are the INVOICE's own (status_transitions.paid_at),
--     not the moment the webhook heard about it, and the earning window is
--     counted in billing periods: commission_duration_months = 12 earns on the
--     invoices whose period starts within 12 months of the first paid one's —
--     invoices 1 to 12 of a monthly plan, never a 13th by a minute's jitter.
--   * Every row says whether Stripe was in test mode. Test-mode deliveries are
--     processed like live ones, so a dry run can be read off the tables, and
--     the payout statement leaves them out.
--   * Self-referral is refused at attribution and again at conversion.
--   * The first valid attribution wins and is never overwritten.
--   * An existing customer cannot be claimed by a link clicked afterwards, and
--     an account that has already paid an invoice is never attributed.
--
-- CHECKOUT ATTRIBUTION (2026-10). The checkout (create_checkout_session) puts
-- a creator's Stripe promotion code on the subscription itself, and the
-- creator's slug in its metadata (affiliate = 'connor'). The account is then
-- attributed from what Stripe reports, strongest evidence first: the
-- promotion-code id on the session, subscription or invoice, matched against
-- the campaign's stripe_promotion_code_id (or its test-mode twin); then the
-- metadata; then the human code the webhook wrote to subscriptions. A creator
-- whose attribution_mode is 'checkout_only' is credited this way and no
-- other: a link click is counted, never claimed.
--
-- RUN ORDER. billing.sql, stripe_webhook.sql and referral_codes.sql first
-- (the guard below says so). Then this file. affiliate_connor.sql seeds the
-- first creator on top of it.
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
  -- the promo-code attribution reads the code the webhook writes here
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions'
                    and column_name = 'stripe_promotion_code_id') then
    raise exception 'public.subscriptions has no referral columns. Run supabase/referral_codes.sql first.';
  end if;
end
$guard$;

-- ── re-running this file on a live site ─────────────────────────────────────
-- The SQL editor runs the file as one transaction, and each statement below
-- would take its lock as it reached it and hold it to the end. A Stripe webhook
-- (and the hourly reconcile) holds stripe_events and then reads the affiliate
-- tables; this file used to lock the affiliate tables first and stripe_events
-- last, and the two deadlocked (40P01) when the file was re-run.
-- So every lock the file needs is taken here, first, all at once or not at
-- all (NOWAIT, retried for up to 30 seconds): the file never waits while it
-- holds a lock, and what it would have deadlocked with waits a moment instead.
do $locks$
declare
  v_list text;
  v_try int := 0;
begin
  select string_agg(t, ', ') into v_list from unnest(array[
    'public.stripe_events',
    'public.affiliate_settings',
    'public.affiliate_admins',
    'public.affiliate_accounts',
    'public.affiliate_clicks',
    'public.affiliate_attributions',
    'public.affiliate_conversions',
    'public.affiliate_commissions',
    'public.affiliate_campaigns']) t
  where to_regclass(t) is not null;
  if v_list is null then return; end if;
  loop
    begin
      execute 'lock table ' || v_list || ' in access exclusive mode nowait';
      return;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 150 then
        raise exception 'could not lock % within 30 seconds; something kept one of them busy. Nothing was changed: run this file again in a minute.', v_list;
      end if;
      perform pg_sleep(0.2);
    end;
  end loop;
end
$locks$;

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
revoke all on function public.affiliate_is_admin() from public, anon;
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

-- slug: the creator's stable lower-case handle ('connor'). The checkout reads
-- the creator's Stripe promotion code id from the env var <SLUG>_PROMO_CODE_ID
-- (CONNOR_PROMO_CODE_ID), so live and test mode each use their own, and stamps
-- the subscription's metadata with affiliate = slug.
-- attribution_mode: 'link_or_checkout' credits a link claim at signup or a
-- checkout; 'checkout_only' credits only what Stripe reports on the sale.
alter table public.affiliate_accounts add column if not exists slug text;
alter table public.affiliate_accounts add column if not exists attribution_mode text not null default 'link_or_checkout';
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_accounts_slug_mode') then
    alter table public.affiliate_accounts add constraint affiliate_accounts_slug_mode check (
          (slug is null or slug ~ '^[a-z0-9][a-z0-9_-]{1,31}$')
      and attribution_mode in ('link_or_checkout', 'checkout_only'));
  end if;
end $c$;
create unique index if not exists affiliate_accounts_slug on public.affiliate_accounts (slug) where slug is not null;

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
  -- widened in place for 'metadata' (the checkout's affiliate stamp)
  if exists (select 1 from pg_constraint where conname = 'affiliate_attributions_shape'
              and pg_get_constraintdef(oid) not like '%metadata%') then
    alter table public.affiliate_attributions drop constraint affiliate_attributions_shape;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_attributions_shape') then
    alter table public.affiliate_attributions add constraint affiliate_attributions_shape check (
      source in ('link','promo_code','metadata','admin') and status in ('active','void'));
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
  -- widened in place for 'disputed'
  if exists (select 1 from pg_constraint where conname = 'affiliate_conversions_kind'
              and pg_get_constraintdef(oid) not like '%disputed%') then
    alter table public.affiliate_conversions drop constraint affiliate_conversions_kind;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'affiliate_conversions_kind') then
    alter table public.affiliate_conversions add constraint affiliate_conversions_kind check (
      kind in ('trial_started','paid','renewal','canceled','refunded','disputed'));
  end if;
end $c$;
create index if not exists affiliate_conversions_affiliate_idx on public.affiliate_conversions (affiliate_id, occurred_at desc);
-- what a refund or a dispute is matched back to its invoice by (a charge
-- names its invoice only on older Stripe API versions; a dispute never does),
-- the billing period an invoice paid for, and whether Stripe was in test mode
alter table public.affiliate_conversions add column if not exists stripe_customer_id       text;
alter table public.affiliate_conversions add column if not exists stripe_charge_id         text;
alter table public.affiliate_conversions add column if not exists stripe_payment_intent_id text;
alter table public.affiliate_conversions add column if not exists period_start             timestamptz;
alter table public.affiliate_conversions add column if not exists livemode                 boolean;
create index if not exists affiliate_conversions_charge_idx on public.affiliate_conversions (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists affiliate_conversions_pi_idx on public.affiliate_conversions (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists affiliate_conversions_invoice_idx on public.affiliate_conversions (stripe_invoice_id) where stripe_invoice_id is not null;
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
-- the payout statement's columns: whose money (Stripe's customer id, shown
-- masked), when the invoice was paid, when this row's money moved (the
-- payment for an accrual, the refund or dispute for a clawback), and whether
-- Stripe was in test mode. `paid_at` above is the PAYOUT, not the invoice.
alter table public.affiliate_commissions add column if not exists stripe_customer_id text;
alter table public.affiliate_commissions add column if not exists invoice_paid_at    timestamptz;
alter table public.affiliate_commissions add column if not exists occurred_at        timestamptz;
alter table public.affiliate_commissions add column if not exists livemode           boolean;
-- ONE accrual per Stripe invoice, whatever path or retry tries to book another
create unique index if not exists affiliate_commissions_one_accrual_per_invoice
  on public.affiliate_commissions (stripe_invoice_id) where kind = 'accrual';
create index if not exists affiliate_commissions_occurred_idx on public.affiliate_commissions (affiliate_id, occurred_at);
-- the money columns are never rewritten; only the status walks forward
create or replace function public.affiliate_commissions_guard()
returns trigger language plpgsql as $$
begin
  if (new.affiliate_id, new.user_id, new.conversion_id, new.stripe_invoice_id, new.kind, new.basis_cents,
      new.rate, new.amount_cents, new.currency, new.eligible_at, new.created_at,
      new.stripe_customer_id, new.invoice_paid_at, new.occurred_at, new.livemode)
     is distinct from
     (old.affiliate_id, old.user_id, old.conversion_id, old.stripe_invoice_id, old.kind, old.basis_cents,
      old.rate, old.amount_cents, old.currency, old.eligible_at, old.created_at,
      old.stripe_customer_id, old.invoice_paid_at, old.occurred_at, old.livemode) then
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

-- ── campaigns: per creator, per code, configurable terms ────────────────────
create table if not exists public.affiliate_campaigns (
  id                        uuid primary key default gen_random_uuid(),
  affiliate_id              uuid not null references public.affiliate_accounts(id),
  code                      text not null,
  name                      text,
  -- THE CUSTOMER'S DISCOUNT, as the admin describes it. Stripe applies it
  -- (the promotion code behind stripe_promo_code); this is checked against
  -- Stripe's own record (stripe_snapshot) before a visitor is ever shown it.
  -- discount_amount is PERCENT for 'percent' (e.g. 20 = 20% off) and US
  -- DOLLARS for 'amount' (e.g. 10 = $10.00 off). discount_duration uses
  -- Stripe's own words: once | repeating (for discount_duration_months) | forever.
  discount_type             text not null default 'none',
  discount_amount           numeric,
  discount_duration         text,
  discount_duration_months  int,
  stripe_promo_code         text,
  stripe_promotion_code_id  text,
  stripe_coupon_id          text,
  stripe_snapshot           jsonb,
  stripe_verified_at        timestamptz,
  -- THE CREATOR'S TERMS. rate is a fraction of what Stripe collected, less
  -- tax. recurring earns on every paid invoice for commission_duration_months
  -- after the first (null = the program setting); one_time earns on the first
  -- paid invoice only.
  commission_rate           numeric not null,
  commission_type           text not null default 'recurring',
  commission_duration_months int,
  starts_at                 timestamptz not null default now(),
  expires_at                timestamptz,
  active                    boolean not null default true,
  admin_note                text,
  created_at                timestamptz not null default now(),
  created_by                uuid,
  updated_at                timestamptz not null default now(),
  updated_by                uuid,
  disabled_at               timestamptz,
  disabled_by               uuid
);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_campaigns_shape') then
    alter table public.affiliate_campaigns add constraint affiliate_campaigns_shape check (
          code ~ '^[A-Z0-9_-]{3,32}$'
      and (name is null or length(name) <= 80)
      and discount_type in ('none', 'percent', 'amount')
      and ((discount_type = 'none' and discount_amount is null and discount_duration is null and discount_duration_months is null)
        or (discount_type = 'percent' and discount_amount > 0 and discount_amount <= 100)
        or (discount_type = 'amount' and discount_amount > 0 and discount_amount <= 10000))
      and (discount_type = 'none' or discount_duration in ('once', 'repeating', 'forever'))
      and ((discount_duration = 'repeating') = (discount_duration_months is not null))
      and (discount_duration_months is null or discount_duration_months between 1 and 36)
      and (stripe_promo_code is null or stripe_promo_code ~ '^[A-Z0-9_.-]{1,64}$')
      and (stripe_promotion_code_id is null or stripe_promotion_code_id ~ '^promo_[A-Za-z0-9]{1,64}$')
      and (stripe_coupon_id is null or length(stripe_coupon_id) <= 80)
      and commission_rate >= 0 and commission_rate <= 0.9
      and commission_type in ('recurring', 'one_time')
      and (commission_duration_months is null or commission_duration_months between 1 and 120)
      and (commission_type = 'recurring' or commission_duration_months is null)
      and (expires_at is null or expires_at > starts_at)
      and (admin_note is null or length(admin_note) <= 1000)
      and (stripe_snapshot is null or pg_column_size(stripe_snapshot) <= 8000));
  end if;
end $c$;
create unique index if not exists affiliate_campaigns_code_ci on public.affiliate_campaigns (upper(code));
create unique index if not exists affiliate_campaigns_promo_id on public.affiliate_campaigns (stripe_promotion_code_id) where stripe_promotion_code_id is not null;
create index if not exists affiliate_campaigns_affiliate_idx on public.affiliate_campaigns (affiliate_id);
-- Stripe's test mode has its own promotion code with its own id, delivered to
-- this same project on the test-mode endpoint. It is kept beside the live id,
-- never in it: a dry run must not be able to occupy the live column. Both are
-- written by the checkout from its env (affiliate_register_promotion_code),
-- never by hand and never from a file.
alter table public.affiliate_campaigns add column if not exists stripe_test_promotion_code_id text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_campaigns_test_promo') then
    alter table public.affiliate_campaigns add constraint affiliate_campaigns_test_promo check (
      stripe_test_promotion_code_id is null or stripe_test_promotion_code_id ~ '^promo_[A-Za-z0-9]{1,64}$');
  end if;
end $c$;
create unique index if not exists affiliate_campaigns_test_promo_id on public.affiliate_campaigns (stripe_test_promotion_code_id)
  where stripe_test_promotion_code_id is not null;

-- One code, one creator: a campaign code may be its own creator's base code,
-- never another creator's.
create or replace function public.affiliate_campaigns_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.code := upper(btrim(new.code));
  new.stripe_promo_code := nullif(upper(btrim(coalesce(new.stripe_promo_code, ''))), '');
  if exists (select 1 from public.affiliate_accounts a where upper(a.code) = new.code and a.id <> new.affiliate_id) then
    raise exception 'affiliate_campaigns: % is another creator''s code', new.code using errcode = 'unique_violation';
  end if;
  if new.discount_type = 'none' then
    new.discount_amount := null; new.discount_duration := null; new.discount_duration_months := null;
  elsif new.discount_duration is distinct from 'repeating' then
    new.discount_duration_months := null;
  end if;
  if new.commission_type = 'one_time' then new.commission_duration_months := null; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists affiliate_campaigns_guard_trg on public.affiliate_campaigns;
create trigger affiliate_campaigns_guard_trg before insert or update on public.affiliate_campaigns
  for each row execute function public.affiliate_campaigns_guard();
-- a campaign is disabled, never deleted: every attribution it made names it
create or replace function public.affiliate_campaigns_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'affiliate_campaigns rows are never deleted; set active = false (campaign %)', old.code using errcode = 'restrict_violation';
end $$;
drop trigger if exists affiliate_campaigns_no_delete_trg on public.affiliate_campaigns;
create trigger affiliate_campaigns_no_delete_trg before delete on public.affiliate_campaigns
  for each row execute function public.affiliate_campaigns_no_delete();
alter table public.affiliate_campaigns enable row level security;
revoke all on public.affiliate_campaigns from anon, authenticated;

-- which campaign a click came through, and the terms an attribution was made on
alter table public.affiliate_clicks add column if not exists campaign_id uuid references public.affiliate_campaigns(id);
alter table public.affiliate_attributions add column if not exists campaign_id uuid references public.affiliate_campaigns(id);
alter table public.affiliate_attributions add column if not exists term_rate numeric;
alter table public.affiliate_attributions add column if not exists term_type text;
alter table public.affiliate_attributions add column if not exists term_months int;
alter table public.affiliate_attributions add column if not exists terms_at timestamptz;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliate_attributions_terms') then
    alter table public.affiliate_attributions add constraint affiliate_attributions_terms check (
          (term_type is null or term_type in ('recurring', 'one_time'))
      and (term_rate is null or (term_rate >= 0 and term_rate <= 0.9))
      and ((term_type is null) = (term_rate is null)));
  end if;
end $c$;
create index if not exists affiliate_attributions_campaign_idx on public.affiliate_attributions (campaign_id) where campaign_id is not null;
create index if not exists affiliate_clicks_campaign_idx on public.affiliate_clicks (campaign_id) where campaign_id is not null;

-- The snapshot never changes once written: the terms a customer was
-- attributed on are the terms they earn on.
create or replace function public.affiliate_attributions_guard()
returns trigger language plpgsql as $$
begin
  if (new.user_id, new.affiliate_id, new.code, new.campaign_id, new.term_rate, new.term_type, new.term_months, new.terms_at, new.attributed_at)
     is distinct from
     (old.user_id, old.affiliate_id, old.code, old.campaign_id, old.term_rate, old.term_type, old.term_months, old.terms_at, old.attributed_at) then
    raise exception 'affiliate_attributions: who a customer is attributed to, and on what terms, is never rewritten; void the row instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists affiliate_attributions_guard_trg on public.affiliate_attributions;
create trigger affiliate_attributions_guard_trg before update on public.affiliate_attributions
  for each row execute function public.affiliate_attributions_guard();

do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on public.affiliate_campaigns to service_role';
  end if;
end $g$;

-- IN FORCE: active, started, not ended, and its creator active.
create or replace function public.affiliate_campaign_in_force(p_campaign uuid, p_at timestamptz default now())
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select c.active and c.starts_at <= p_at and (c.expires_at is null or p_at < c.expires_at) and a.status = 'active'
                     from public.affiliate_campaigns c join public.affiliate_accounts a on a.id = c.affiliate_id
                    where c.id = p_campaign), false);
$$;
revoke all on function public.affiliate_campaign_in_force(uuid, timestamptz) from public, anon, authenticated;

-- A code, resolved: a campaign code first, then a creator's base code.
--   {ok, affiliate_id, campaign_id|null, campaign_code|null, in_force, reason}
-- campaign_id is returned even when the campaign is not in force, so a claim
-- can honour a click made while it was.
create or replace function public.affiliate_resolve_code(p_code text, p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text := upper(btrim(coalesce(p_code, ''))); c public.affiliate_campaigns%rowtype; a public.affiliate_accounts%rowtype;
begin
  if v !~ '^[A-Z0-9_-]{3,32}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  select * into c from public.affiliate_campaigns where upper(code) = v;
  if found then
    if public.affiliate_campaign_in_force(c.id, p_at) then
      return jsonb_build_object('ok', true, 'affiliate_id', c.affiliate_id, 'campaign_id', c.id, 'campaign_code', c.code, 'in_force', true);
    end if;
    select * into a from public.affiliate_accounts where id = c.affiliate_id;
    if upper(a.code) = v and a.status = 'active' then
      return jsonb_build_object('ok', true, 'affiliate_id', a.id, 'campaign_id', null, 'campaign_code', c.code, 'in_force', false,
        'stale_campaign_id', c.id, 'reason', 'campaign_not_in_force_base_code');
    end if;
    return jsonb_build_object('ok', false, 'affiliate_id', c.affiliate_id, 'stale_campaign_id', c.id, 'reason', 'campaign_not_active');
  end if;
  select * into a from public.affiliate_accounts where upper(code) = v;
  if found and a.status = 'active' then
    return jsonb_build_object('ok', true, 'affiliate_id', a.id, 'campaign_id', null, 'campaign_code', null, 'in_force', false);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'unknown_or_inactive_code');
end $$;
revoke all on function public.affiliate_resolve_code(text, timestamptz) from public, anon, authenticated;

-- The terms to snapshot onto a new attribution through a campaign.
create or replace function public.affiliate_campaign_terms(p_campaign uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('rate', c.commission_rate, 'type', c.commission_type,
           'months', case when c.commission_type = 'one_time' then null
                          else coalesce(c.commission_duration_months, s.commission_duration_months) end)
    from public.affiliate_campaigns c cross join public.affiliate_settings s
   where c.id = p_campaign and s.id = 1;
$$;
revoke all on function public.affiliate_campaign_terms(uuid) from public, anon, authenticated;

-- Stripe's record of the discount against what the admin entered:
--   no_discount | unverified | partial | verified | mismatch | inactive_in_stripe
create or replace function public.affiliate_campaign_stripe_state(c public.affiliate_campaigns)
returns text language plpgsql stable set search_path = public, pg_temp as $$
declare sn jsonb := c.stripe_snapshot; pct numeric; amt numeric; dur text; mo int;
begin
  if c.discount_type = 'none' and c.stripe_promo_code is null and c.stripe_promotion_code_id is null then return 'no_discount'; end if;
  if sn is null then return 'unverified'; end if;
  if (sn ->> 'active') = 'false' or (sn ->> 'coupon_valid') = 'false'
     or ((sn ->> 'expires_at') is not null and (sn ->> 'expires_at')::timestamptz <= now()) then
    return 'inactive_in_stripe';
  end if;
  pct := nullif(sn ->> 'percent_off', '')::numeric; amt := nullif(sn ->> 'amount_off_cents', '')::numeric;
  dur := sn ->> 'duration'; mo := nullif(sn ->> 'duration_in_months', '')::int;
  if pct is null and amt is null then return 'partial'; end if;
  if pct is not null and not (c.discount_type = 'percent' and c.discount_amount = pct) then return 'mismatch'; end if;
  if amt is not null and not (c.discount_type = 'amount' and round(c.discount_amount * 100) = amt
                              and upper(coalesce(sn ->> 'currency', 'USD')) = 'USD') then return 'mismatch'; end if;
  if dur is distinct from c.discount_duration then return 'mismatch'; end if;
  if dur = 'repeating' and mo is distinct from c.discount_duration_months then return 'mismatch'; end if;
  return 'verified';
end $$;
revoke all on function public.affiliate_campaign_stripe_state(public.affiliate_campaigns) from public, anon, authenticated;

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
-- a Stripe timestamp (unix seconds), or null
create or replace function public.affiliate_stripe_ts(p jsonb)
returns timestamptz language sql immutable as $$
  select case when p is not null and (p #>> '{}') ~ '^[0-9]{1,12}$' then to_timestamp((p #>> '{}')::bigint) end;
$$;
-- Stripe's own test-mode flag, from the event or the object (live unless it says otherwise)
create or replace function public.affiliate_stripe_livemode(p jsonb)
returns boolean language sql immutable as $$
  select coalesce(case when (p ->> 'livemode') in ('true', 'false') then (p ->> 'livemode')::boolean end,
                  case when (public.affiliate_stripe_object(p) ->> 'livemode') in ('true', 'false')
                       then (public.affiliate_stripe_object(p) ->> 'livemode')::boolean end,
                  true);
$$;
-- The promotion-code id a checkout session, subscription or invoice carries,
-- in every shape Stripe's API versions use: discounts[] as objects or ids,
-- the older single `discount`, and the session's total_details breakdown. A
-- bare di_… or coupon id names no creator and is never returned.
create or replace function public.affiliate_event_promotion_code(o jsonb)
returns text language sql immutable as $$
  select x.id from (
    select case when jsonb_typeof(d) = 'string' then d #>> '{}' end as id, 1 as pri, n
      from jsonb_array_elements(case when jsonb_typeof(o -> 'discounts') = 'array' then o -> 'discounts' else '[]'::jsonb end)
           with ordinality as t(d, n)
    union all
    select public.affiliate_stripe_id(d -> 'promotion_code'), 1, n
      from jsonb_array_elements(case when jsonb_typeof(o -> 'discounts') = 'array' then o -> 'discounts' else '[]'::jsonb end)
           with ordinality as t(d, n) where jsonb_typeof(d) = 'object'
    union all
    select public.affiliate_stripe_id(o -> 'discount' -> 'promotion_code'), 2, 1
    union all
    select public.affiliate_stripe_id(d -> 'discount' -> 'promotion_code'), 3, n
      from jsonb_array_elements(case when jsonb_typeof(o -> 'total_details' -> 'breakdown' -> 'discounts') = 'array'
                                     then o -> 'total_details' -> 'breakdown' -> 'discounts' else '[]'::jsonb end)
           with ordinality as t(d, n) where jsonb_typeof(d) = 'object'
  ) x
  where x.id ~ '^promo_[A-Za-z0-9]{1,64}$'
  order by x.pri, x.n limit 1;
$$;
-- The metadata that carries the checkout's affiliate stamp: the session's or
-- the subscription's own, or (on an invoice) the subscription's as copied
-- into subscription_details. Empty when none of them names an affiliate.
create or replace function public.affiliate_event_metadata(o jsonb)
returns jsonb language sql immutable as $$
  select coalesce((
    select m from (values (1, o -> 'metadata'), (2, o -> 'subscription_details' -> 'metadata'),
                          (3, o -> 'parent' -> 'subscription_details' -> 'metadata')) v(pri, m)
     where jsonb_typeof(m) = 'object' and nullif(btrim(m ->> 'affiliate'), '') is not null
     order by pri limit 1), '{}'::jsonb);
$$;
-- The start of the billing period an invoice paid for (its latest line's
-- period start): exact under Stripe's own month arithmetic, so the earning
-- window can never be decided by when a payment happened to settle.
create or replace function public.affiliate_invoice_period_start(o jsonb)
returns timestamptz language sql immutable as $$
  select max(public.affiliate_stripe_ts(l -> 'period' -> 'start'))
    from jsonb_array_elements(case when jsonb_typeof(o -> 'lines' -> 'data') = 'array' then o -> 'lines' -> 'data' else '[]'::jsonb end) l;
$$;
-- The charge and payment intent that paid an invoice, in both API shapes
-- (invoice.charge / invoice.payment_intent, or invoice.payments[] since 2025-03).
create or replace function public.affiliate_invoice_payment_ref(o jsonb, p_what text)
returns text language sql immutable as $$
  select coalesce(public.affiliate_stripe_id(o -> p_what),
                  (select public.affiliate_stripe_id(p -> 'payment' -> p_what)
                     from jsonb_array_elements(case when jsonb_typeof(o -> 'payments' -> 'data') = 'array'
                                                    then o -> 'payments' -> 'data' else '[]'::jsonb end) p
                    where public.affiliate_stripe_id(p -> 'payment' -> p_what) is not null limit 1));
$$;

-- HAS THIS ACCOUNT ALREADY PAID US? Any invoice that moved money (amount_paid
-- > 0) on the webhook's ledger, for this account or its Stripe customer, other
-- than the subscription being attributed (whose own first invoice is not
-- "prior"). A $0 trial invoice is not a payment. Used to refuse attribution
-- to a returning customer, and by the checkout before it applies a code.
create index if not exists stripe_events_user on public.stripe_events (user_id) where user_id is not null;
create or replace function public.affiliate_has_prior_paid_invoice(p_user uuid, p_customer text, p_subscription text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  with custs as (
    select p_customer as c where p_customer is not null
    union select stripe_customer_id from public.subscriptions where user_id = p_user and stripe_customer_id is not null
  )
  select exists (
    select 1 from public.stripe_events e
     cross join lateral (select public.affiliate_stripe_object(e.payload) as inv) x
     where e.type in ('invoice.paid', 'invoice.payment_succeeded')
       and ((p_user is not null and e.user_id = p_user) or e.customer_id in (select c from custs))
       and (x.inv ->> 'amount_paid') ~ '^[0-9]+$' and (x.inv ->> 'amount_paid')::bigint > 0
       and (p_subscription is null
            or coalesce(public.affiliate_stripe_id(x.inv -> 'subscription'),
                        public.affiliate_stripe_id(x.inv -> 'parent' -> 'subscription_details' -> 'subscription'))
               is distinct from p_subscription));
$$;
revoke all on function public.affiliate_has_prior_paid_invoice(uuid, text, text) from public, anon, authenticated;

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
  r jsonb; v_campaign uuid; v_terms jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if p_code is null or upper(btrim(p_code)) !~ '^[A-Z0-9_-]{3,32}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;
  if exists (select 1 from public.affiliate_attributions where user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_attributed');
  end if;
  if p_visitor is not null and p_visitor ~ '^[A-Za-z0-9_-]{16,64}$' then
    v_hash := md5('edgedesk-affiliate:' || p_visitor);
  end if;
  r := public.affiliate_resolve_code(p_code);
  v_campaign := nullif(r ->> 'campaign_id', '')::uuid;
  -- a campaign that has since ended or been switched off still credits a
  -- visitor who clicked it while it was in force
  if v_campaign is null and r ? 'stale_campaign_id' and v_hash is not null then
    select c.campaign_id into v_campaign from public.affiliate_clicks c
     where c.campaign_id = (r ->> 'stale_campaign_id')::uuid and c.visitor_hash = v_hash
       and public.affiliate_campaign_in_force(c.campaign_id, c.created_at)
     order by c.created_at limit 1;
    if v_campaign is not null then r := jsonb_set(r, '{ok}', 'true'::jsonb); end if;
  end if;
  if not coalesce((r ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', case when r ->> 'reason' = 'invalid_code' then 'invalid_code'
                                                          when r ->> 'reason' = 'campaign_not_active' then 'campaign_not_active'
                                                          else 'unknown_or_inactive_code' end);
  end if;
  select * into v_aff from public.affiliate_accounts where id = (r ->> 'affiliate_id')::uuid;
  if not found or v_aff.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'unknown_or_inactive_code'); end if;
  if v_aff.user_id = v_uid then return jsonb_build_object('ok', false, 'reason', 'self_referral'); end if;
  -- a checkout-only creator is credited from the Stripe sale, never from a click
  if v_aff.attribution_mode = 'checkout_only' then
    return jsonb_build_object('ok', false, 'reason', 'attributed_at_checkout');
  end if;
  if public.affiliate_has_prior_paid_invoice(v_uid, null, null) then
    return jsonb_build_object('ok', false, 'reason', 'existing_customer');
  end if;
  select * into v_set from public.affiliate_settings where id = 1;
  if v_hash is not null then
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
  if v_campaign is not null then v_terms := public.affiliate_campaign_terms(v_campaign); end if;
  insert into public.affiliate_attributions (user_id, affiliate_id, code, source, visitor_hash, first_click_at,
                                             campaign_id, term_rate, term_type, term_months, terms_at)
  values (v_uid, v_aff.id, coalesce(r ->> 'campaign_code', v_aff.code), 'link', v_hash, v_click,
          v_campaign, (v_terms ->> 'rate')::numeric, v_terms ->> 'type', (v_terms ->> 'months')::int,
          case when v_campaign is not null then now() end)
  on conflict (user_id) do nothing;
  if not found then return jsonb_build_object('ok', false, 'reason', 'already_attributed'); end if;
  return jsonb_build_object('ok', true, 'code', coalesce(r ->> 'campaign_code', v_aff.code));
end $$;
revoke all on function public.affiliate_claim(text, text) from public, anon;
grant execute on function public.affiliate_claim(text, text) to authenticated;

-- ── clicks: callable without an account (it is a landing page) ──────────────
create or replace function public.affiliate_track_click(p_code text, p_visitor text, p_landing text default null, p_referrer text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; v_aff uuid; v_hash text; v_today int;
begin
  if p_code is null or upper(btrim(p_code)) !~ '^[A-Z0-9_-]{3,32}$' then return jsonb_build_object('ok', false); end if;
  if p_visitor is null or p_visitor !~ '^[A-Za-z0-9_-]{16,64}$' then return jsonb_build_object('ok', false); end if;
  r := public.affiliate_resolve_code(p_code);
  if not coalesce((r ->> 'ok')::boolean, false) then return jsonb_build_object('ok', false); end if;
  v_aff := (r ->> 'affiliate_id')::uuid;
  -- a flood from one partner's link is capped rather than stored without limit
  select count(*) into v_today from public.affiliate_clicks
   where affiliate_id = v_aff and click_day = (now() at time zone 'utc')::date;
  if v_today >= 20000 then return jsonb_build_object('ok', true, 'capped', true); end if;
  v_hash := md5('edgedesk-affiliate:' || p_visitor);
  insert into public.affiliate_clicks (affiliate_id, visitor_hash, landing_path, referrer_host, campaign_id)
  values (v_aff, v_hash, left(regexp_replace(coalesce(p_landing, ''), '[^A-Za-z0-9/_.-]', '', 'g'), 120),
          left(regexp_replace(coalesce(p_referrer, ''), '[^A-Za-z0-9._-]', '', 'g'), 120),
          nullif(r ->> 'campaign_id', '')::uuid)
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
  if exists (select 1 from public.affiliate_accounts where upper(code) = v_code)
     or exists (select 1 from public.affiliate_campaigns where upper(code) = v_code) then return jsonb_build_object('ok', false, 'reason', 'code_taken'); end if;
  insert into public.affiliate_accounts (user_id, code, display_name, payout_email, status)
  values (v_uid, v_code, nullif(left(btrim(coalesce(p_display_name, '')), 80), ''), nullif(btrim(coalesce(p_payout_email, '')), ''), 'pending');
  return jsonb_build_object('ok', true, 'code', v_code, 'status', 'pending');
end $$;
revoke all on function public.affiliate_apply(text, text, text) from public, anon;
grant execute on function public.affiliate_apply(text, text, text) to authenticated;

-- ── Stripe's own record of a campaign's discount ────────────────────────────
-- promotion_code.* and coupon.* events that reach the webhook's ledger (add
-- them to the endpoint's events in the Stripe dashboard) are copied onto the
-- campaign they describe: by promotion-code id, else by the code itself. Out-
-- of-order delivery keeps the newest. Nothing here writes to Stripe.
create or replace function public.affiliate_campaign_apply_stripe(p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare e record; o jsonb; cp jsonb; v_at timestamptz; snap jsonb; v_code text; v_promo text; v_coupon text; n int := 0;
  v_live boolean;
begin
  select * into e from public.stripe_events where id = p_event_id;
  if not found then return 'no_event'; end if;
  o := public.affiliate_stripe_object(e.payload);
  v_at := coalesce(e.stripe_created, e.created_at);
  -- a test-mode promotion code fills the test column and never the live one;
  -- the visitor-facing snapshot follows live Stripe wherever a live id exists
  v_live := public.affiliate_stripe_livemode(e.payload);
  if o ->> 'object' = 'promotion_code' or e.type like 'promotion_code.%' then
    v_promo := o ->> 'id'; v_code := upper(nullif(btrim(coalesce(o ->> 'code', '')), ''));
    cp := case when jsonb_typeof(o -> 'coupon') = 'object' then o -> 'coupon'
               when jsonb_typeof(o -> 'promotion' -> 'coupon') = 'object' then o -> 'promotion' -> 'coupon' end;
    v_coupon := coalesce(public.affiliate_stripe_id(o -> 'coupon'), public.affiliate_stripe_id(o -> 'promotion' -> 'coupon'));
    snap := jsonb_strip_nulls(jsonb_build_object(
      'promotion_code_id', v_promo, 'code', v_code, 'active', o -> 'active',
      'expires_at', case when (o ->> 'expires_at') ~ '^[0-9]+$' then to_jsonb(to_timestamp((o ->> 'expires_at')::bigint)) end,
      'coupon_id', v_coupon, 'percent_off', cp -> 'percent_off', 'amount_off_cents', cp -> 'amount_off',
      'currency', upper(cp ->> 'currency'), 'duration', cp -> 'duration', 'duration_in_months', cp -> 'duration_in_months',
      'coupon_valid', cp -> 'valid', 'event_id', e.id, 'event_type', e.type, 'event_at', v_at));
    update public.affiliate_campaigns c
       set stripe_snapshot = case when v_live or c.stripe_promotion_code_id is null
                                  then coalesce(c.stripe_snapshot, '{}'::jsonb) || snap else c.stripe_snapshot end,
           stripe_promotion_code_id = case when v_live then coalesce(c.stripe_promotion_code_id, v_promo) else c.stripe_promotion_code_id end,
           stripe_test_promotion_code_id = case when v_live then c.stripe_test_promotion_code_id
                                                else coalesce(c.stripe_test_promotion_code_id, v_promo) end,
           stripe_coupon_id = case when v_live or c.stripe_promotion_code_id is null
                                   then coalesce(c.stripe_coupon_id, v_coupon) else c.stripe_coupon_id end,
           stripe_verified_at = case when v_live or c.stripe_promotion_code_id is null then v_at else c.stripe_verified_at end
     where (c.stripe_promotion_code_id = v_promo or c.stripe_test_promotion_code_id = v_promo
            or (v_code is not null and upper(coalesce(c.stripe_promo_code, c.code)) = v_code
                and (case when v_live then c.stripe_promotion_code_id else c.stripe_test_promotion_code_id end) is null))
       and (c.stripe_verified_at is null or c.stripe_verified_at <= v_at);
    get diagnostics n = row_count;
    return 'promotion_code:' || n;
  end if;
  if o ->> 'object' = 'coupon' or e.type like 'coupon.%' then
    v_coupon := o ->> 'id';
    snap := jsonb_strip_nulls(jsonb_build_object(
      'coupon_id', v_coupon, 'percent_off', o -> 'percent_off', 'amount_off_cents', o -> 'amount_off',
      'currency', upper(o ->> 'currency'), 'duration', o -> 'duration', 'duration_in_months', o -> 'duration_in_months',
      'coupon_valid', case when e.type = 'coupon.deleted' then 'false'::jsonb else o -> 'valid' end,
      'event_id', e.id, 'event_type', e.type, 'event_at', v_at));
    update public.affiliate_campaigns c
       set stripe_snapshot = coalesce(c.stripe_snapshot, '{}'::jsonb) || snap, stripe_verified_at = v_at
     where c.stripe_coupon_id = v_coupon and (c.stripe_verified_at is null or c.stripe_verified_at <= v_at);
    get diagnostics n = row_count;
    return 'coupon:' || n;
  end if;
  return 'ignored:' || e.type;
end $$;
revoke all on function public.affiliate_campaign_apply_stripe(text) from public, anon, authenticated;

-- replay every promotion-code and coupon event, oldest first (a campaign
-- created after its promotion code reached the ledger picks it up here)
create or replace function public.affiliate_campaign_stripe_sync()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id from public.stripe_events
            where type like 'promotion_code.%' or type like 'coupon.%'
            order by coalesce(stripe_created, created_at), id loop
    perform public.affiliate_campaign_apply_stripe(r.id); n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.affiliate_campaign_stripe_sync() from public, anon, authenticated;

-- ── attribution from the checkout: what Stripe says about the sale ─────────
-- Asked for an account that has no attribution yet, on any event that can
-- describe its sale (so a checkout whose own deliveries arrived unresolved is
-- still credited when they are). Strongest evidence first, and no fourth:
--   1. the promotion-code id on the event's session, subscription or invoice,
--      or the one the webhook recorded on subscriptions, matched against a
--      campaign's live or test-mode stripe_promotion_code_id;
--   2. the checkout's stamp: metadata.affiliate (the creator's slug) and
--      metadata.affiliate_code (which of their campaigns);
--   3. the human code the webhook wrote to subscriptions.referral_code.
-- The campaign must have been in force when the subscription was bought. Never
-- the creator's own account, and never an account that has already paid an
-- invoice on another subscription. The first attribution wins: nothing here
-- can replace one (the primary key and the guard trigger refuse it too).
create or replace function public.affiliate_attribute_from_checkout(p_user uuid, p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; o jsonb; v_at timestamptz; v_sale timestamptz; v_sub record; v_sub_id text; v_cust text;
  v_promo text; v_meta jsonb; v_slug text; v_mcode text; v_code text; v_source text; v_terms jsonb;
  v_camp public.affiliate_campaigns%rowtype; v_aff public.affiliate_accounts%rowtype;
  v_has_camp boolean := false; v_has_aff boolean := false;
begin
  if exists (select 1 from public.affiliate_attributions where user_id = p_user) then return 'already_attributed'; end if;
  select * into e from public.stripe_events where id = p_event_id;
  if not found then return 'no_event'; end if;
  o := public.affiliate_stripe_object(e.payload);
  if o is null then return 'no_payload'; end if;
  v_at := coalesce(e.stripe_created, e.created_at);
  select s.referral_code, s.stripe_promotion_code_id, s.created_at into v_sub
    from public.subscriptions s where s.user_id = p_user;
  v_sub_id := case when o ->> 'object' = 'subscription' or e.type like 'customer.subscription.%' then o ->> 'id'
                   else coalesce(public.affiliate_stripe_id(o -> 'subscription'),
                                 public.affiliate_stripe_id(o -> 'parent' -> 'subscription_details' -> 'subscription'),
                                 e.subscription_id) end;
  v_cust := coalesce(e.customer_id, public.affiliate_stripe_id(o -> 'customer'));
  -- when the subscription was bought: its own start, the checkout's, else the row's
  v_sale := coalesce(case when o ->> 'object' = 'subscription' then public.affiliate_stripe_ts(o -> 'start_date') end,
                     case when o ->> 'object' in ('subscription', 'checkout.session') then public.affiliate_stripe_ts(o -> 'created') end,
                     v_sub.created_at, v_at);

  -- 1. the promotion-code id Stripe applied
  v_promo := coalesce(public.affiliate_event_promotion_code(o), v_sub.stripe_promotion_code_id);
  if v_promo is not null then
    select * into v_camp from public.affiliate_campaigns
     where (stripe_promotion_code_id = v_promo or stripe_test_promotion_code_id = v_promo)
       and public.affiliate_campaign_in_force(id, v_sale) limit 1;
    if found then v_has_camp := true; v_source := 'promo_code'; end if;
  end if;
  -- 2. the checkout's metadata stamp
  if not v_has_camp then
    v_meta := public.affiliate_event_metadata(o);
    v_slug := lower(nullif(btrim(v_meta ->> 'affiliate'), ''));
    v_mcode := upper(nullif(btrim(v_meta ->> 'affiliate_code'), ''));
    if v_slug is not null then
      select * into v_aff from public.affiliate_accounts where slug = v_slug and status = 'active';
      if found then
        v_has_aff := true; v_source := 'metadata';
        select * into v_camp from public.affiliate_campaigns
         where affiliate_id = v_aff.id and (v_mcode is null or upper(code) = v_mcode)
           and public.affiliate_campaign_in_force(id, v_sale)
         order by created_at limit 1;
        v_has_camp := found;
      end if;
    end if;
  end if;
  -- 3. the code the customer typed, as the webhook named it
  if not v_has_camp and not v_has_aff then
    v_code := upper(nullif(btrim(v_sub.referral_code), ''));
    if v_code is not null then
      select * into v_camp from public.affiliate_campaigns
       where (upper(code) = v_code or upper(stripe_promo_code) = v_code)
         and public.affiliate_campaign_in_force(id, v_sale) limit 1;
      if found then
        v_has_camp := true; v_source := 'promo_code';
      else
        select * into v_aff from public.affiliate_accounts
         where status in ('active', 'paused') and (upper(code) = v_code or upper(stripe_promo_code) = v_code) limit 1;
        if found then v_has_aff := true; v_source := 'promo_code'; end if;
      end if;
    end if;
  end if;
  if not v_has_camp and not v_has_aff then return 'no_evidence'; end if;
  if v_has_camp then select * into v_aff from public.affiliate_accounts where id = v_camp.affiliate_id; end if;
  if v_aff.user_id = p_user then return 'self_referral'; end if;
  if public.affiliate_has_prior_paid_invoice(p_user, v_cust, v_sub_id) then return 'prior_paid_invoice'; end if;
  if v_has_camp then v_terms := public.affiliate_campaign_terms(v_camp.id); end if;
  insert into public.affiliate_attributions (user_id, affiliate_id, code, source, campaign_id, term_rate, term_type, term_months, terms_at)
  values (p_user, v_aff.id, case when v_has_camp then v_camp.code else v_aff.code end, v_source,
          case when v_has_camp then v_camp.id end, (v_terms ->> 'rate')::numeric, v_terms ->> 'type', (v_terms ->> 'months')::int,
          case when v_has_camp then now() end)
  on conflict (user_id) do nothing;
  if not found then return 'already_attributed'; end if;
  return 'attributed:' || v_source;
end $$;
revoke all on function public.affiliate_attribute_from_checkout(uuid, text) from public, anon, authenticated;

-- ── refunds and disputes: a negative row against the same invoice ───────────
-- The adjustment is the commission's share of the money taken back:
--   commission × refunded ÷ charged   for charge.refunded (amount_refunded is
--                                     the charge's running total, so each
--                                     delivery books only what is new)
--   commission × disputed ÷ paid      for charge.dispute.created
-- and across every refund and dispute on the invoice it never takes back more
-- than the commission booked for it. The accrual is never voided or edited: it
-- keeps its row and its status, and the clawback nets it. A charge names its
-- invoice only on API versions before 2025-03-31 and a dispute never does, so
-- both are also matched by the charge or payment intent that paid it.
create or replace function public.affiliate_book_adjustment(p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; o jsonb; v_at timestamptz; v_kind text; v_charge text; v_pi text; v_inv text; v_base bigint; v_part bigint;
  v_dedupe text; v_paid record; v_com public.affiliate_commissions%rowtype; v_has_com boolean; v_conv bigint;
  v_target bigint; v_same bigint; v_all bigint; v_book bigint;
begin
  select * into e from public.stripe_events where id = p_event_id;
  if not found then return 'no_event'; end if;
  o := public.affiliate_stripe_object(e.payload);
  if o is null then return 'no_payload'; end if;
  v_at := coalesce(e.stripe_created, e.created_at);
  if e.type = 'charge.refunded' then
    v_kind := 'refunded';
    v_charge := nullif(o ->> 'id', '');
    v_inv := public.affiliate_stripe_id(o -> 'invoice');
    v_base := case when (o ->> 'amount') ~ '^[0-9]+$' then (o ->> 'amount')::bigint end;
    v_part := case when (o ->> 'amount_refunded') ~ '^[0-9]+$' then (o ->> 'amount_refunded')::bigint end;
    v_dedupe := 'refund:' || coalesce(v_charge, e.id) || ':' || coalesce(v_part::text, '?');
  else
    v_kind := 'disputed';
    v_charge := public.affiliate_stripe_id(o -> 'charge');
    v_part := case when (o ->> 'amount') ~ '^[0-9]+$' then (o ->> 'amount')::bigint end;
    v_dedupe := 'dispute:' || coalesce(nullif(o ->> 'id', ''), e.id);
  end if;
  v_pi := public.affiliate_stripe_id(o -> 'payment_intent');
  if v_part is null or v_part <= 0 then return v_kind || ':unreadable'; end if;
  -- the attributed payment this money came back from
  select * into v_paid from public.affiliate_conversions
   where kind in ('paid', 'renewal')
     and ((v_inv is not null and stripe_invoice_id = v_inv)
          or (v_inv is null and ((v_charge is not null and stripe_charge_id = v_charge)
                                 or (v_pi is not null and stripe_payment_intent_id = v_pi))))
   order by id limit 1;
  if not found then return v_kind || ':not_an_attributed_payment'; end if;
  v_inv := v_paid.stripe_invoice_id;
  if v_kind = 'disputed' then v_base := v_paid.amount_cents; end if;
  if v_base is null or v_base <= 0 then return v_kind || ':unreadable'; end if;
  -- one adjustment at a time per invoice: the accrual row is the lock
  select * into v_com from public.affiliate_commissions
   where stripe_invoice_id = v_inv and kind = 'accrual' and status <> 'void' for update;
  v_has_com := found;
  insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_invoice_id,
       stripe_subscription_id, stripe_customer_id, stripe_charge_id, stripe_payment_intent_id, amount_cents, currency,
       occurred_at, livemode)
  values (v_paid.affiliate_id, v_paid.user_id, v_kind, v_dedupe, e.id, v_inv, v_paid.stripe_subscription_id,
          v_paid.stripe_customer_id, coalesce(v_charge, v_paid.stripe_charge_id), coalesce(v_pi, v_paid.stripe_payment_intent_id),
          v_part, upper(coalesce(o ->> 'currency', v_paid.currency, 'usd')), v_at,
          coalesce(v_paid.livemode, public.affiliate_stripe_livemode(e.payload)))
  on conflict (dedupe_key) do nothing
  returning id into v_conv;
  if v_conv is null then return v_kind || ':already_recorded'; end if;
  if not v_has_com or v_com.amount_cents <= 0 then return v_kind || ':no_commission'; end if;
  v_target := least(v_com.amount_cents, round(v_com.amount_cents::numeric * least(v_part, v_base) / v_base)::bigint);
  -- already taken back from this invoice: by every adjustment, and by earlier
  -- refunds of this same charge (which amount_refunded already includes)
  select coalesce(-sum(c.amount_cents), 0),
         coalesce(-sum(c.amount_cents) filter (where cv.kind = 'refunded' and cv.stripe_charge_id is not distinct from v_charge), 0)
    into v_all, v_same
    from public.affiliate_commissions c join public.affiliate_conversions cv on cv.id = c.conversion_id
   where c.stripe_invoice_id = v_inv and c.kind = 'clawback' and c.status <> 'void';
  v_book := case when v_kind = 'refunded' then v_target - v_same else v_target end;
  v_book := least(v_book, v_com.amount_cents - v_all);
  if v_book <= 0 then return v_kind || ':nothing_left_to_take_back'; end if;
  insert into public.affiliate_commissions (affiliate_id, user_id, conversion_id, stripe_invoice_id, kind, basis_cents, rate,
       amount_cents, currency, status, eligible_at, stripe_customer_id, invoice_paid_at, occurred_at, livemode)
  values (v_com.affiliate_id, v_com.user_id, v_conv, v_inv, 'clawback', 0, v_com.rate, -v_book, v_com.currency, 'pending', v_at,
          v_com.stripe_customer_id, v_com.invoice_paid_at, v_at, v_com.livemode)
  on conflict do nothing;
  return v_kind || ':clawback';
end $$;
revoke all on function public.affiliate_book_adjustment(text) from public, anon, authenticated;

-- ── processing one Stripe event into conversions and commissions ────────────
create or replace function public.affiliate_process_event(p_event_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record; o jsonb; v_user uuid; v_attr record; v_aff public.affiliate_accounts%rowtype;
  v_set public.affiliate_settings%rowtype; v_sub_id text; v_cust text; v_inv text; v_status text;
  v_amt bigint; v_tax bigint; v_basis bigint; v_rate numeric; v_conv bigint; v_first timestamptz;
  v_at timestamptz; v_kind text; v_months int; v_live boolean; v_paid_at timestamptz; v_period timestamptz;
  v_why text;
begin
  select * into e from public.stripe_events where id = p_event_id;
  if not found then return 'no_event'; end if;
  if e.type like 'promotion_code.%' or e.type like 'coupon.%' then
    return public.affiliate_campaign_apply_stripe(e.id);
  end if;
  -- a refund or a dispute is matched to the payment it takes money back from,
  -- not to an account: a dispute does not even name its customer
  if e.type in ('charge.refunded', 'charge.dispute.created') then
    return public.affiliate_book_adjustment(e.id);
  end if;
  o := public.affiliate_stripe_object(e.payload);
  if o is null then return 'no_payload'; end if;
  v_at := coalesce(e.stripe_created, e.created_at);
  v_live := public.affiliate_stripe_livemode(e.payload);
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
  if not found then
    -- a sale made through a creator's checkout (or their typed code) is theirs
    v_why := public.affiliate_attribute_from_checkout(v_user, e.id);
    select * into v_attr from public.affiliate_attributions where user_id = v_user and status = 'active';
    if not found then return 'unattributed:' || coalesce(v_why, '?'); end if;
  end if;
  select * into v_aff from public.affiliate_accounts where id = v_attr.affiliate_id;
  if v_aff.user_id = v_user then return 'self_referral'; end if;
  select * into v_set from public.affiliate_settings where id = 1;

  if e.type in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') then
    v_status := case when e.type = 'customer.subscription.deleted' then 'canceled' else o ->> 'status' end;
    if v_status = 'trialing' then
      insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_subscription_id,
                                                stripe_customer_id, occurred_at, livemode)
      values (v_aff.id, v_user, 'trial_started', 'trial:' || v_user, e.id, v_sub_id, v_cust, v_at, v_live)
      on conflict (dedupe_key) do nothing;
    elsif v_status = 'canceled' or coalesce((o ->> 'cancel_at_period_end')::boolean, false) then
      insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_subscription_id,
                                                stripe_customer_id, occurred_at, note, livemode)
      values (v_aff.id, v_user, 'canceled', 'cancel:' || coalesce(v_sub_id, v_user::text), e.id, v_sub_id, v_cust, v_at,
              case when v_status = 'canceled' then 'subscription ended' else 'set to cancel at period end' end, v_live)
      on conflict (dedupe_key) do nothing;
    end if;
    return 'subscription:' || coalesce(v_status, 'unknown');
  end if;

  if e.type in ('invoice.payment_succeeded', 'invoice.paid') then
    v_inv := o ->> 'id';
    v_amt := case when (o ->> 'amount_paid') ~ '^[0-9]+$' then (o ->> 'amount_paid')::bigint else 0 end;
    -- a $0 invoice (the one a free trial opens with) earns nothing
    if v_inv is null or v_amt <= 0 then return 'invoice:no_money'; end if;
    v_tax := case when (o ->> 'tax') ~ '^[0-9]+$' then (o ->> 'tax')::bigint
                  else coalesce((select sum((t ->> 'amount')::bigint) from jsonb_array_elements(coalesce(o -> 'total_taxes', '[]'::jsonb)) t
                                  where (t ->> 'amount') ~ '^[0-9]+$'), 0) end;
    v_basis := greatest(v_amt - coalesce(v_tax, 0), 0);
    -- the invoice's own dates: when Stripe marked it paid, and the billing
    -- period it paid for (both on Stripe's clock, a test clock's included)
    v_paid_at := coalesce(public.affiliate_stripe_ts(o -> 'status_transitions' -> 'paid_at'), v_at);
    v_period := coalesce(public.affiliate_invoice_period_start(o), v_paid_at);
    select min(coalesce(period_start, occurred_at)) into v_first from public.affiliate_conversions
     where user_id = v_user and kind in ('paid', 'renewal');
    v_kind := case when v_first is null then 'paid' else 'renewal' end;
    insert into public.affiliate_conversions (affiliate_id, user_id, kind, dedupe_key, stripe_event_id, stripe_invoice_id,
                                              stripe_subscription_id, amount_cents, currency, occurred_at, stripe_customer_id,
                                              stripe_charge_id, stripe_payment_intent_id, period_start, livemode)
    values (v_aff.id, v_user, v_kind, 'invoice:' || v_inv, e.id, v_inv, v_sub_id, v_amt, upper(coalesce(o ->> 'currency', 'usd')),
            v_paid_at, v_cust, public.affiliate_invoice_payment_ref(o, 'charge'), public.affiliate_invoice_payment_ref(o, 'payment_intent'),
            v_period, v_live)
    on conflict (dedupe_key) do nothing
    returning id into v_conv;
    if v_conv is null then return 'invoice:already_recorded'; end if;
    -- inside the commission duration, for an active partner only. An
    -- attribution made through a campaign carries its own terms, snapshotted
    -- when it was made; any other uses the partner's rate and the program's.
    if v_aff.status <> 'active' then return 'invoice:partner_not_active'; end if;
    if v_attr.term_type is not null then
      if v_attr.term_type = 'one_time' and v_kind <> 'paid' then return 'invoice:one_time_commission_already_earned'; end if;
      v_rate := v_attr.term_rate; v_months := v_attr.term_months;
    else
      v_rate := coalesce(v_aff.commission_rate, v_set.default_commission_rate); v_months := v_set.commission_duration_months;
    end if;
    -- the window is counted in billing periods from the first paid one's
    -- start, exclusive: 12 months earns on invoices 1 to 12, never a 13th
    if v_months is not null
       and v_period >= least(coalesce(v_first, v_period), v_period) + make_interval(months => v_months) then
      return 'invoice:past_commission_duration';
    end if;
    insert into public.affiliate_commissions (affiliate_id, user_id, conversion_id, stripe_invoice_id, kind, basis_cents, rate,
                                              amount_cents, currency, status, eligible_at, stripe_customer_id, invoice_paid_at,
                                              occurred_at, livemode)
    values (v_aff.id, v_user, v_conv, v_inv, 'accrual', v_basis, v_rate, round(v_basis * v_rate)::bigint,
            upper(coalesce(o ->> 'currency', 'usd')), 'pending', v_paid_at + make_interval(days => v_set.hold_days),
            v_cust, v_paid_at, v_paid_at, v_live)
    on conflict do nothing;
    return 'invoice:' || v_kind;
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
            where type in ('checkout.session.completed',
                           'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
                           'invoice.payment_succeeded','invoice.paid','charge.refunded','charge.dispute.created')
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
  perform public.affiliate_campaign_stripe_sync();
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

-- ── the checkout's two doors (service role only) ────────────────────────────
-- create_checkout_session asks, for a code a visitor arrived with: is it a
-- campaign in force right now, whose creator has a slug, for an account that
-- is not the creator and has never paid us? The answer names the creator (the
-- checkout then reads <SLUG>_PROMO_CODE_ID from its env) and the promotion
-- code already registered for this Stripe mode, if any.
create or replace function public.affiliate_checkout_code(p_code text, p_user uuid, p_livemode boolean default true)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb; c public.affiliate_campaigns%rowtype; a public.affiliate_accounts%rowtype;
begin
  r := public.affiliate_resolve_code(p_code);
  if not coalesce((r ->> 'ok')::boolean, false) or r ->> 'campaign_id' is null
     or not coalesce((r ->> 'in_force')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', coalesce(r ->> 'reason', 'no_campaign_in_force'));
  end if;
  select * into c from public.affiliate_campaigns where id = (r ->> 'campaign_id')::uuid;
  select * into a from public.affiliate_accounts where id = c.affiliate_id;
  if a.slug is null then return jsonb_build_object('ok', false, 'reason', 'creator_has_no_slug'); end if;
  if a.user_id = p_user then return jsonb_build_object('ok', false, 'reason', 'self_referral'); end if;
  if public.affiliate_has_prior_paid_invoice(p_user, null, null) then
    return jsonb_build_object('ok', false, 'reason', 'returning_customer');
  end if;
  return jsonb_build_object('ok', true, 'slug', a.slug, 'affiliate_id', a.id, 'campaign_id', c.id, 'code', c.code,
    'promotion_code_id', case when coalesce(p_livemode, true) then c.stripe_promotion_code_id else c.stripe_test_promotion_code_id end);
end $$;
revoke all on function public.affiliate_checkout_code(text, uuid, boolean) from public, anon, authenticated;

-- The promotion code the checkout is about to apply, written onto the
-- campaign for that Stripe mode the first time and never overwritten — so the
-- id lives in the checkout's env, not in any file, and the attribution above
-- can match it by id. 'registered' | 'same' | 'conflict' (a different id is
-- already on the campaign, or this id is another campaign's) | 'invalid'.
create or replace function public.affiliate_register_promotion_code(p_campaign uuid, p_promo text, p_livemode boolean default true)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cur text;
begin
  if p_promo is null or p_promo !~ '^promo_[A-Za-z0-9]{1,64}$' then return 'invalid'; end if;
  if coalesce(p_livemode, true) then
    update public.affiliate_campaigns set stripe_promotion_code_id = p_promo where id = p_campaign and stripe_promotion_code_id is null;
  else
    update public.affiliate_campaigns set stripe_test_promotion_code_id = p_promo where id = p_campaign and stripe_test_promotion_code_id is null;
  end if;
  if found then return 'registered'; end if;
  select case when coalesce(p_livemode, true) then stripe_promotion_code_id else stripe_test_promotion_code_id end into v_cur
    from public.affiliate_campaigns where id = p_campaign;
  if not found then return 'unknown_campaign'; end if;
  return case when v_cur = p_promo then 'same' else 'conflict' end;
exception when unique_violation then
  return 'conflict';
end $$;
revoke all on function public.affiliate_register_promotion_code(uuid, text, boolean) from public, anon, authenticated;

-- ── the monthly payout statement (service role only) ────────────────────────
--   select * from public.affiliate_statement('connor', date '2026-11-01');
-- One row per commission booked in that calendar month (UTC): a PAYMENT per
-- paid invoice (the date Stripe marked it paid, what was eligible — the amount
-- paid less tax — the rate and the commission) and an ADJUSTMENT per refund
-- or dispute booked that month (negative, with the date of the payment it
-- comes back from), then one TOTAL row. A customer appears only as the last 4
-- characters of their Stripe customer id. PAYOUT RULE: a month's collections
-- are paid by the 15th of the second month after it (October's by December
-- 15) — payout_due, on every row. Test-mode rows are left out; pass
-- p_livemode => false to read only those (a dry run). Voided rows never show.
create or replace function public.affiliate_statement(affiliate_slug text, month date, p_livemode boolean default true)
returns table (line int, row_type text, customer_last4 text, payment_date date, invoice_paid_date date,
               eligible_amount_cents bigint, adjustment_cents bigint, rate numeric, commission_cents bigint,
               status text, payout_due date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_aff uuid; v_month date; v_from timestamptz; v_to timestamptz; v_due date;
begin
  if affiliate_statement.month is null then raise exception 'affiliate_statement: month is required'; end if;
  v_month := make_date(extract(year from affiliate_statement.month)::int, extract(month from affiliate_statement.month)::int, 1);
  select a.id into v_aff from public.affiliate_accounts a where a.slug = lower(btrim(affiliate_statement.affiliate_slug));
  if v_aff is null then
    raise exception 'affiliate_statement: no creator with slug %', affiliate_statement.affiliate_slug using errcode = 'no_data_found';
  end if;
  v_from := v_month::timestamp at time zone 'UTC';
  v_to := (v_month + interval '1 month')::timestamp at time zone 'UTC';
  v_due := (v_month + interval '2 months' + interval '14 days')::date;
  return query
  with r as (
    select c.id, c.kind, c.stripe_customer_id, coalesce(c.occurred_at, c.invoice_paid_at, c.created_at) as at,
           c.invoice_paid_at, c.basis_cents, c.amount_cents, c.rate, c.status
      from public.affiliate_commissions c
     where c.affiliate_id = v_aff and c.status <> 'void'
       and coalesce(c.livemode, true) = coalesce(p_livemode, true)
       and coalesce(c.occurred_at, c.invoice_paid_at, c.created_at) >= v_from
       and coalesce(c.occurred_at, c.invoice_paid_at, c.created_at) < v_to
  ), l as (
    select (row_number() over (order by r.at, r.id))::int as line,
           case when r.kind = 'accrual' then 'payment' else 'adjustment' end as row_type,
           nullif(right(coalesce(r.stripe_customer_id, ''), 4), '') as customer_last4,
           (r.at at time zone 'UTC')::date as payment_date,
           (r.invoice_paid_at at time zone 'UTC')::date as invoice_paid_date,
           case when r.kind = 'accrual' then r.basis_cents end as eligible_amount_cents,
           case when r.kind = 'clawback' then r.amount_cents end as adjustment_cents,
           r.rate, r.amount_cents as commission_cents, r.status
      from r
  )
  select l.line, l.row_type, l.customer_last4, l.payment_date, l.invoice_paid_date, l.eligible_amount_cents,
         l.adjustment_cents, l.rate, l.commission_cents, l.status, v_due
    from l
  union all
  select coalesce(max(l.line), 0) + 1, 'total', null, null, null,
         coalesce(sum(l.eligible_amount_cents), 0)::bigint, coalesce(sum(l.adjustment_cents), 0)::bigint, null,
         coalesce(sum(l.commission_cents), 0)::bigint, null, v_due
    from l
  order by 1;
end $$;
revoke all on function public.affiliate_statement(text, date, boolean) from public, anon, authenticated;

-- ── public.affiliates: one row per creator code, in the spec's own words ────
-- (id, slug, display_name, stripe_promotion_code_id, promo_code,
-- commission_rate, earning_months, active, created_at — plus the test-mode
-- promotion code and the campaign behind the row). A VIEW over
-- affiliate_accounts and affiliate_campaigns, not a second table: each fact
-- has one home. earning_months is null for a one-time commission. Service
-- role only; no client role can read it.
create or replace view public.affiliates with (security_invoker = true) as
  select a.id, a.slug, a.display_name, c.stripe_promotion_code_id, c.code as promo_code, c.commission_rate,
         case when c.commission_type = 'recurring' then coalesce(c.commission_duration_months, s.commission_duration_months) end
           as earning_months,
         (c.active and c.starts_at <= now() and (c.expires_at is null or now() < c.expires_at) and a.status = 'active') as active,
         a.created_at, c.stripe_test_promotion_code_id, c.id as campaign_id, c.commission_type, a.attribution_mode
    from public.affiliate_accounts a
    join public.affiliate_campaigns c on c.affiliate_id = a.id
    cross join public.affiliate_settings s
   where s.id = 1 and a.slug is not null;
revoke all on public.affiliates from public, anon, authenticated;

do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.affiliates to service_role';
    execute 'grant execute on function public.affiliate_checkout_code(text, uuid, boolean),
             public.affiliate_register_promotion_code(uuid, text, boolean),
             public.affiliate_statement(text, date, boolean) to service_role';
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

-- One campaign's counts, and its terms as the creator and the admin see them.
create or replace function public.affiliate_campaign_stats(p_campaign uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with attr as (select user_id from public.affiliate_attributions where campaign_id = p_campaign and status = 'active'),
  c as (select * from public.affiliate_campaigns where id = p_campaign)
  select jsonb_build_object(
    'clicks', (select count(*) from public.affiliate_clicks where campaign_id = p_campaign),
    'signups', (select count(*) from attr),
    'trials', (select count(distinct v.user_id) from public.affiliate_conversions v where v.kind = 'trial_started' and v.user_id in (select user_id from attr)),
    'paid_customers', (select count(distinct v.user_id) from public.affiliate_conversions v where v.kind = 'paid' and v.user_id in (select user_id from attr)),
    'pending_cents', (select coalesce(sum(m.amount_cents), 0) from public.affiliate_commissions m, c where m.affiliate_id = c.affiliate_id and m.user_id in (select user_id from attr) and m.status = 'pending'),
    'approved_cents', (select coalesce(sum(m.amount_cents), 0) from public.affiliate_commissions m, c where m.affiliate_id = c.affiliate_id and m.user_id in (select user_id from attr) and m.status = 'approved'),
    'paid_cents', (select coalesce(sum(m.amount_cents), 0) from public.affiliate_commissions m, c where m.affiliate_id = c.affiliate_id and m.user_id in (select user_id from attr) and m.status = 'paid'));
$$;
revoke all on function public.affiliate_campaign_stats(uuid) from public, anon, authenticated;

-- The customer's discount AS STRIPE RECORDS IT — only when Stripe's record
-- exists, is live, and matches what the admin entered. Otherwise null, and
-- nothing about a discount is shown.
create or replace function public.affiliate_campaign_discount(c public.affiliate_campaigns)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when public.affiliate_campaign_stripe_state(c) = 'verified' then jsonb_strip_nulls(jsonb_build_object(
           'type', case when c.stripe_snapshot ? 'percent_off' then 'percent' else 'amount' end,
           'percent_off', c.stripe_snapshot -> 'percent_off', 'amount_off_cents', c.stripe_snapshot -> 'amount_off_cents',
           'currency', c.stripe_snapshot ->> 'currency', 'duration', c.stripe_snapshot ->> 'duration',
           'duration_in_months', c.stripe_snapshot -> 'duration_in_months', 'source', 'stripe'))
         end;
$$;
revoke all on function public.affiliate_campaign_discount(public.affiliate_campaigns) from public, anon, authenticated;

create or replace function public.affiliate_campaign_json(c public.affiliate_campaigns, p_admin boolean)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', case when p_admin then c.id end, 'code', c.code, 'name', c.name, 'active', c.active,
      'in_force', public.affiliate_campaign_in_force(c.id), 'starts_at', c.starts_at, 'expires_at', c.expires_at,
      'commission_rate', c.commission_rate, 'commission_type', c.commission_type,
      'commission_duration_months', c.commission_duration_months,
      'discount', public.affiliate_campaign_discount(c), 'stripe_state', public.affiliate_campaign_stripe_state(c),
      'stripe_promo_code', c.stripe_promo_code, 'stats', public.affiliate_campaign_stats(c.id))
    || case when p_admin then jsonb_build_object('affiliate_id', c.affiliate_id,
         'discount_type', c.discount_type, 'discount_amount', c.discount_amount, 'discount_duration', c.discount_duration,
         'discount_duration_months', c.discount_duration_months, 'stripe_promotion_code_id', c.stripe_promotion_code_id,
         'stripe_coupon_id', c.stripe_coupon_id, 'stripe_snapshot', c.stripe_snapshot, 'stripe_verified_at', c.stripe_verified_at,
         'admin_note', c.admin_note, 'created_at', c.created_at, 'updated_at', c.updated_at, 'disabled_at', c.disabled_at)
       else '{}'::jsonb end;
$$;
revoke all on function public.affiliate_campaign_json(public.affiliate_campaigns, boolean) from public, anon, authenticated;

-- THE OFFER A VISITOR SEES for a code, callable without an account. No
-- creator, no commission, no counts: whether the code is live, the code to
-- carry to checkout, and the discount only as Stripe records it.
create or replace function public.affiliate_offer(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb; c public.affiliate_campaigns%rowtype;
begin
  r := public.affiliate_resolve_code(p_code);
  if not coalesce((r ->> 'ok')::boolean, false) then return jsonb_build_object('ok', false); end if;
  if r ->> 'campaign_id' is null then return jsonb_build_object('ok', true, 'code', upper(btrim(p_code)), 'campaign', false); end if;
  select * into c from public.affiliate_campaigns where id = (r ->> 'campaign_id')::uuid;
  return jsonb_build_object('ok', true, 'code', c.code, 'campaign', true, 'ends_at', c.expires_at,
    -- the code goes to checkout only once Stripe's own record of it exists and
    -- is live; Stripe then applies whatever it holds
    'checkout_code', case when public.affiliate_campaign_stripe_state(c) in ('verified', 'partial', 'mismatch')
                          then coalesce(c.stripe_snapshot ->> 'code', c.stripe_promo_code, c.code) end,
    'discount', public.affiliate_campaign_discount(c));
end $$;
revoke all on function public.affiliate_offer(text) from public;
grant execute on function public.affiliate_offer(text) to anon, authenticated;

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
    'stats', public.affiliate_stats(v_aff.id),
    'campaigns', (select coalesce(jsonb_agg(public.affiliate_campaign_json(c, false) order by c.created_at desc), '[]'::jsonb)
                    from public.affiliate_campaigns c where c.affiliate_id = v_aff.id));
end $$;
revoke all on function public.affiliate_my_dashboard() from public, anon;
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
    'campaigns', (select coalesce(jsonb_agg(public.affiliate_campaign_json(c, true) || jsonb_build_object('partner_code', a.code)
                    order by c.created_at desc), '[]'::jsonb)
                   from public.affiliate_campaigns c join public.affiliate_accounts a on a.id = c.affiliate_id),
    'unprocessed_events', (select count(*) from public.stripe_events e
                            where e.type in ('invoice.payment_succeeded','invoice.paid','charge.refunded')
                              and e.created_at > now() - interval '45 days'
                              and not exists (select 1 from public.affiliate_conversions c where c.stripe_event_id = e.id)),
    'as_of', now());
end $$;
revoke all on function public.affiliate_admin_overview() from public, anon;
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
  if exists (select 1 from public.affiliate_campaigns c join public.affiliate_accounts a on a.id = c.affiliate_id
              where upper(c.code) = v_code and a.user_id is distinct from v_user) then
    return jsonb_build_object('ok', false, 'reason', 'code_is_another_creators_campaign');
  end if;
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
revoke all on function public.affiliate_admin_upsert_account(text, text, text, numeric, text, text) from public, anon;
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
revoke all on function public.affiliate_admin_update_settings(jsonb) from public, anon;
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
revoke all on function public.affiliate_admin_commissions(bigint[], text, text, text) from public, anon;
grant execute on function public.affiliate_admin_commissions(bigint[], text, text, text) to authenticated;

-- create or edit a campaign. p: {id?, partner_code, code, name, discount_type,
-- discount_amount, discount_duration, discount_duration_months, stripe_promo_code,
-- stripe_promotion_code_id, stripe_coupon_id, commission_rate (fraction),
-- commission_type, commission_duration_months, starts_at, expires_at, active,
-- admin_note}. Editing a campaign never touches an attribution already made.
create or replace function public.affiliate_admin_upsert_campaign(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_aff uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; v_code text := upper(btrim(coalesce(p ->> 'code', '')));
  v_rate numeric; v_msg text;
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  select id into v_aff from public.affiliate_accounts where upper(code) = upper(btrim(coalesce(p ->> 'partner_code', '')));
  if v_aff is null and v_id is not null then select affiliate_id into v_aff from public.affiliate_campaigns where id = v_id; end if;
  if v_aff is null then return jsonb_build_object('ok', false, 'reason', 'unknown_partner_code'); end if;
  if v_code !~ '^[A-Z0-9_-]{3,32}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  if exists (select 1 from public.affiliate_campaigns where upper(code) = v_code and id is distinct from v_id) then
    return jsonb_build_object('ok', false, 'reason', 'code_taken');
  end if;
  v_rate := nullif(p ->> 'commission_rate', '')::numeric;
  if v_rate is null then return jsonb_build_object('ok', false, 'reason', 'commission_rate_required'); end if;
  begin
    if v_id is null then
      insert into public.affiliate_campaigns (affiliate_id, code, name, discount_type, discount_amount, discount_duration, discount_duration_months,
        stripe_promo_code, stripe_promotion_code_id, stripe_coupon_id, commission_rate, commission_type, commission_duration_months,
        starts_at, expires_at, active, admin_note, created_by, updated_by)
      values (v_aff, v_code, nullif(p ->> 'name', ''), coalesce(nullif(p ->> 'discount_type', ''), 'none'),
        nullif(p ->> 'discount_amount', '')::numeric, nullif(p ->> 'discount_duration', ''), nullif(p ->> 'discount_duration_months', '')::int,
        nullif(p ->> 'stripe_promo_code', ''), nullif(p ->> 'stripe_promotion_code_id', ''), nullif(p ->> 'stripe_coupon_id', ''),
        v_rate, coalesce(nullif(p ->> 'commission_type', ''), 'recurring'), nullif(p ->> 'commission_duration_months', '')::int,
        coalesce(nullif(p ->> 'starts_at', '')::timestamptz, now()), nullif(p ->> 'expires_at', '')::timestamptz,
        coalesce((p ->> 'active')::boolean, true), nullif(p ->> 'admin_note', ''), auth.uid(), auth.uid())
      returning id into v_id;
    else
      update public.affiliate_campaigns set affiliate_id = v_aff, code = v_code, name = nullif(p ->> 'name', ''),
        discount_type = coalesce(nullif(p ->> 'discount_type', ''), 'none'), discount_amount = nullif(p ->> 'discount_amount', '')::numeric,
        discount_duration = nullif(p ->> 'discount_duration', ''), discount_duration_months = nullif(p ->> 'discount_duration_months', '')::int,
        stripe_promo_code = nullif(p ->> 'stripe_promo_code', ''), stripe_promotion_code_id = nullif(p ->> 'stripe_promotion_code_id', ''),
        stripe_coupon_id = nullif(p ->> 'stripe_coupon_id', ''), commission_rate = v_rate,
        commission_type = coalesce(nullif(p ->> 'commission_type', ''), 'recurring'),
        commission_duration_months = nullif(p ->> 'commission_duration_months', '')::int,
        starts_at = coalesce(nullif(p ->> 'starts_at', '')::timestamptz, starts_at), expires_at = nullif(p ->> 'expires_at', '')::timestamptz,
        active = coalesce((p ->> 'active')::boolean, active), admin_note = nullif(p ->> 'admin_note', ''), updated_by = auth.uid(),
        disabled_at = case when coalesce((p ->> 'active')::boolean, active) then null else coalesce(disabled_at, now()) end,
        disabled_by = case when coalesce((p ->> 'active')::boolean, active) then null else coalesce(disabled_by, auth.uid()) end
       where id = v_id;
      if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_campaign'); end if;
    end if;
  exception when check_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    get stacked diagnostics v_msg = message_text;
    return jsonb_build_object('ok', false, 'reason', 'invalid_campaign', 'detail', left(v_msg, 300));
  end;
  perform public.affiliate_campaign_stripe_sync();
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code,
    'campaign', (select public.affiliate_campaign_json(c, true) from public.affiliate_campaigns c where c.id = v_id));
end $$;
revoke all on function public.affiliate_admin_upsert_campaign(jsonb) from public, anon;
grant execute on function public.affiliate_admin_upsert_campaign(jsonb) to authenticated;

-- switch a campaign off (or back on) without touching anything it attributed
create or replace function public.affiliate_admin_set_campaign_active(p_id uuid, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  update public.affiliate_campaigns set active = p_active, updated_by = auth.uid(),
         disabled_at = case when p_active then null else now() end, disabled_by = case when p_active then null else auth.uid() end
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_campaign'); end if;
  return jsonb_build_object('ok', true, 'active', p_active);
end $$;
revoke all on function public.affiliate_admin_set_campaign_active(uuid, boolean) from public, anon;
grant execute on function public.affiliate_admin_set_campaign_active(uuid, boolean) to authenticated;

create or replace function public.affiliate_admin_reconcile()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.affiliate_is_admin() then raise exception 'not an affiliate admin' using errcode = 'insufficient_privilege'; end if;
  return public.affiliate_reconcile(45);
end $$;
revoke all on function public.affiliate_admin_reconcile() from public, anon;
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
union all
-- Supabase grants EXECUTE on every new public function to anon directly, so
-- revoking from PUBLIC alone would leave these open to a signed-out visitor.
select 10, 'no signed-in-only function is callable by a signed-out visitor',
  case when not exists (
    select 1 from unnest(array[
      'public.affiliate_is_admin()', 'public.affiliate_claim(text, text)', 'public.affiliate_apply(text, text, text)',
      'public.affiliate_my_dashboard()', 'public.affiliate_admin_overview()',
      'public.affiliate_admin_upsert_account(text, text, text, numeric, text, text)',
      'public.affiliate_admin_update_settings(jsonb)', 'public.affiliate_admin_commissions(bigint[], text, text, text)',
      'public.affiliate_admin_reconcile()', 'public.affiliate_stats(uuid)',
      'public.affiliate_admin_upsert_campaign(jsonb)', 'public.affiliate_admin_set_campaign_active(uuid, boolean)',
      'public.affiliate_campaign_stats(uuid)', 'public.affiliate_resolve_code(text, timestamp with time zone)',
      'public.affiliate_checkout_code(text, uuid, boolean)', 'public.affiliate_register_promotion_code(uuid, text, boolean)',
      'public.affiliate_statement(text, date, boolean)', 'public.affiliate_book_adjustment(text)',
      'public.affiliate_attribute_from_checkout(uuid, text)', 'public.affiliate_has_prior_paid_invoice(uuid, text, text)']) f
    where has_function_privilege('anon', f, 'execute')) then 'ok' else 'CHECK THIS' end
union all
select 11, 'campaigns: per-code terms, never deleted, no client reads them directly',
  case when exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'affiliate_campaigns' and rowsecurity)
        and not has_table_privilege('authenticated', 'public.affiliate_campaigns', 'select')
        and exists (select 1 from pg_trigger where tgname = 'affiliate_campaigns_no_delete_trg' and not tgisinternal) then 'ok' else 'CHECK THIS' end
union all
select 12, 'an attribution''s creator and terms are snapshotted and never rewritten',
  case when exists (select 1 from pg_trigger where tgname = 'affiliate_attributions_guard_trg' and not tgisinternal)
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'affiliate_attributions' and column_name = 'term_type')
       then 'ok' else 'CHECK THIS' end
union all
select 13, 'a visitor can read a code''s offer (discount as Stripe records it), never its commission',
  case when has_function_privilege('anon', 'public.affiliate_offer(text)', 'execute')
        and position('commission' in pg_get_functiondef('public.affiliate_offer(text)'::regprocedure)) = 0 then 'ok' else 'CHECK THIS' end
union all
select 14, 'public.affiliates (one row per creator code) is a view the service role reads and no client can',
  case when to_regclass('public.affiliates') is not null
        and not has_table_privilege('anon', 'public.affiliates', 'select')
        and not has_table_privilege('authenticated', 'public.affiliates', 'select')
        and (not exists (select 1 from pg_roles where rolname = 'service_role')
             or has_table_privilege('service_role', 'public.affiliates', 'select')) then 'ok' else 'CHECK THIS' end
union all
select 15, 'one commission accrual per Stripe invoice, whatever retries',
  case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'affiliate_commissions_one_accrual_per_invoice')
       then 'ok' else 'CHECK THIS' end
union all
select 16, 'refunds and disputes book a capped negative row against the invoice (never a void)',
  case when position('charge.dispute.created' in pg_get_functiondef('public.affiliate_process_event(text)'::regprocedure)) > 0
        and position('update public.affiliate_commissions' in pg_get_functiondef('public.affiliate_book_adjustment(text)'::regprocedure)) = 0
       then 'ok' else 'CHECK THIS' end
union all
select 17, 'the checkout doors and the payout statement are service-role only',
  case when not has_function_privilege('authenticated', 'public.affiliate_statement(text, date, boolean)', 'execute')
        and not has_function_privilege('authenticated', 'public.affiliate_checkout_code(text, uuid, boolean)', 'execute')
        and not has_function_privilege('authenticated', 'public.affiliate_register_promotion_code(uuid, text, boolean)', 'execute')
        and (not exists (select 1 from pg_roles where rolname = 'service_role')
             or (has_function_privilege('service_role', 'public.affiliate_statement(text, date, boolean)', 'execute')
                 and has_function_privilege('service_role', 'public.affiliate_checkout_code(text, uuid, boolean)', 'execute')))
       then 'ok' else 'CHECK THIS' end
union all
select 18, 'a checkout-only creator is never credited by a link claim',
  case when position('checkout_only' in pg_get_functiondef('public.affiliate_claim(text, text)'::regprocedure)) > 0
       then 'ok' else 'CHECK THIS' end
union all
select 19, 'creators with a slug (each can be paid through the checkout)',
  'ok (' || (select count(*) from public.affiliate_accounts where slug is not null)::text || ')'
order by 1;

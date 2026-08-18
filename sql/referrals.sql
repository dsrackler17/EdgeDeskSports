-- ============================================================================
-- EdgeDesk — referral attribution
--
-- Run this BEFORE sending partner traffic. The landing page writes to these
-- tables on account creation and again at billing consent; if they do not
-- exist, attribution degrades silently (by design — a missing analytics table
-- must never stop a customer paying) and the partner credit is lost forever.
-- There is no way to backfill "which link did this person click in March".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- referrals: one row per account, written at signup, updated at consent.
-- This is the table a 25%-of-revenue partner invoice gets reconciled against.
-- ----------------------------------------------------------------------------
create table if not exists public.referrals (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  user_email            text,
  ref                   text,        -- CREDITED partner code (first code-bearing touch)
  ref_last              text,        -- last code seen, diagnostics only, never paid on
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text,
  landing_page          text,
  referrer_host         text,
  first_seen_at         timestamptz,
  -- set only when the visitor had been here organically BEFORE the referral
  -- arrived. Kept so a partner dispute is settled on the whole history.
  organic_first_seen_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists referrals_ref_idx        on public.referrals(ref) where ref is not null;
create index if not exists referrals_created_at_idx on public.referrals(created_at);

alter table public.referrals enable row level security;

-- A user may write and read their own row, and nothing else. The partner report
-- is generated with the service role; no anon client can enumerate customers.
drop policy if exists referrals_insert_self on public.referrals;
create policy referrals_insert_self on public.referrals
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists referrals_update_self on public.referrals;
create policy referrals_update_self on public.referrals
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists referrals_select_self on public.referrals;
create policy referrals_select_self on public.referrals
  for select to authenticated using (auth.uid() = user_id);

-- The page upserts with on_conflict=user_id. Freeze the credited code on the
-- first write that carries one: a later upsert from the same browser must not
-- be able to move the credit to a different partner.
create or replace function public.referrals_freeze_credit()
returns trigger language plpgsql as $$
begin
  new.user_id := old.user_id;
  if old.ref is not null and old.ref <> '' then
    new.ref := old.ref;                    -- credit is immutable once set
    new.first_seen_at := old.first_seen_at;
    new.organic_first_seen_at := old.organic_first_seen_at;
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists referrals_freeze_credit_t on public.referrals;
create trigger referrals_freeze_credit_t before update on public.referrals
  for each row execute function public.referrals_freeze_credit();

-- ----------------------------------------------------------------------------
-- billing_consents: new columns for attribution + trial length.
-- The consent row is the compliance record; stamping attribution on it means
-- the partner credit and the exact offer the customer agreed to are one row.
-- ----------------------------------------------------------------------------
alter table if exists public.billing_consents
  add column if not exists ref                   text,
  add column if not exists ref_last              text,
  add column if not exists utm_source            text,
  add column if not exists utm_medium            text,
  add column if not exists utm_campaign          text,
  add column if not exists utm_content           text,
  add column if not exists landing_page          text,
  add column if not exists referrer_host         text,
  add column if not exists first_seen_at         timestamptz,
  add column if not exists organic_first_seen_at timestamptz,
  add column if not exists trial_days            int;

-- ----------------------------------------------------------------------------
-- Partner reporting. Service-role only; run it to produce an invoice.
-- Commission should be computed on NET revenue — after refunds, chargebacks and
-- failed renewals, not on gross signups. Trials in particular are not revenue:
-- in_trial is reported separately from active_paid so nobody invoices for a
-- customer who has not paid yet. Agreeing that in writing before launch is what
-- stops the conversation six months from now where both parties are certain and
-- neither can prove it.
-- ----------------------------------------------------------------------------
create or replace view public.partner_rollup as
  select r.ref,
         count(*)                                                    as signups,
         count(*) filter (where s.status = 'trialing')               as in_trial,
         count(*) filter (where s.status = 'active')                 as active_paid,
         count(*) filter (where s.status in ('canceled','unpaid'))   as churned,
         -- signups that never started a trial at all: the gap between clicking
         -- the partner link and reaching checkout. Worth watching separately,
         -- because it is the only number that says the funnel is broken rather
         -- than the audience being wrong.
         count(*) filter (where s.user_id is null)                   as never_started,
         min(r.created_at)                                           as first_signup,
         max(r.created_at)                                           as latest_signup
  from public.referrals r
  left join public.subscriptions s on s.user_id = r.user_id
  where r.ref is not null
  group by r.ref
  order by active_paid desc;

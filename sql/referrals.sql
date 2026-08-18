-- ============================================================================
-- EdgeDesk — referral attribution + guarantee accounting
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
-- guarantee_windows: the refund ledger.
--
-- Written when a subscription takes its FIRST PAYMENT (trial conversion), not
-- when the trial starts — the guarantee refunds a charge, so it cannot begin
-- before one exists. Evaluated by a scheduled job. The point of storing the
-- decision rather than recomputing it on demand is that a refund must be
-- reproducible months later, against the numbers as they stood at the time.
-- ----------------------------------------------------------------------------
create table if not exists public.guarantee_windows (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  first_charge_at  timestamptz not null,
  window_start     timestamptz not null,
  window_end       timestamptz not null,         -- first_charge_at + 30 days
  hard_deadline    timestamptz not null,         -- first_charge_at + 90 days
  graded_n         int,
  mean_clv         numeric,
  status           text not null default 'open'
    check (status in ('open','extended','passed','failed','refunded','void')),
  decided_at       timestamptz,
  refunded_at      timestamptz,
  stripe_refund_id text,
  notes            text
);
create index if not exists guarantee_windows_status_idx on public.guarantee_windows(status);
create index if not exists guarantee_windows_end_idx    on public.guarantee_windows(window_end);

alter table public.guarantee_windows enable row level security;

-- A subscriber can read their own window. That is the whole trust argument:
-- the customer can see the same row the refund job acts on.
drop policy if exists guarantee_windows_select_self on public.guarantee_windows;
create policy guarantee_windows_select_self on public.guarantee_windows
  for select to authenticated using (auth.uid() = user_id);
-- No insert/update policy: only the service role writes this table.

-- ----------------------------------------------------------------------------
-- The guarantee test, in SQL, so the refund job and the landing page cannot
-- drift apart. Selection rule is copied verbatim from record.html's EDGEQ:
--   flagged_at is not null AND flagged_edge between 0.005 and 0.1
-- Change it here and in BOTH index.html and record.html, or not at all.
-- ----------------------------------------------------------------------------
create or replace function public.guarantee_eval(p_from timestamptz, p_to timestamptz)
returns table (graded_n bigint, mean_clv numeric)
language sql stable as $$
  select count(*)::bigint, avg(clv)::numeric
  from public.public_record
  where clv is not null
    and flagged_at is not null
    and flagged_edge >= 0.005
    and flagged_edge <= 0.1
    and graded_at >= p_from
    and graded_at <  p_to
$$;

-- Decide every window that is due. Run daily.
--   * >= 30 graded edges and mean CLV  > 0  -> passed
--   * >= 30 graded edges and mean CLV <= 0  -> failed  (refund owed)
--   * <  30 graded edges, before the 90-day deadline -> extended (keep waiting)
--   * <  30 graded edges, past the deadline -> failed (we never produced enough
--     work to be measured; that is our failure, so the month is refunded)
-- Marking 'failed' does not move money. A separate worker issues the Stripe
-- refund and sets status='refunded' — keeping the decision and the payout in
-- two steps means a bug in one cannot silently double-refund through the other.
create or replace function public.guarantee_sweep()
returns int language plpgsql security definer set search_path = public as $$
declare r record; g record; n int := 0;
begin
  for r in
    select * from public.guarantee_windows
    where status in ('open','extended') and now() >= window_end
  loop
    select * into g from public.guarantee_eval(r.window_start, least(now(), r.hard_deadline));
    update public.guarantee_windows
       set graded_n = g.graded_n,
           mean_clv = g.mean_clv,
           status = case
             when g.graded_n >= 30 and coalesce(g.mean_clv,0) >  0 then 'passed'
             when g.graded_n >= 30                                 then 'failed'
             when now() >= r.hard_deadline                         then 'failed'
             else 'extended' end,
           decided_at = case when g.graded_n >= 30 or now() >= r.hard_deadline
                             then now() else null end
     where user_id = r.user_id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Refunds owed but not yet paid. This is the query to look at every morning.
create or replace view public.guarantee_refunds_due as
  select user_id, first_charge_at, window_start, window_end,
         graded_n, mean_clv, decided_at
  from public.guarantee_windows
  where status = 'failed' and refunded_at is null
  order by decided_at asc;

-- ----------------------------------------------------------------------------
-- Partner reporting. Service-role only; run it to produce an invoice.
-- Commission is deliberately computed on NET revenue: a refunded month pays no
-- commission. Agreeing that in writing before launch is what stops the
-- conversation six months from now where both parties are certain and neither
-- can prove it.
-- ----------------------------------------------------------------------------
create or replace view public.partner_rollup as
  select r.ref,
         count(*)                                              as signups,
         count(*) filter (where s.status in ('trialing'))       as in_trial,
         count(*) filter (where s.status = 'active')            as active_paid,
         count(*) filter (where g.status = 'refunded')          as guarantee_refunded,
         min(r.created_at)                                      as first_signup,
         max(r.created_at)                                      as latest_signup
  from public.referrals r
  left join public.subscriptions s      on s.user_id = r.user_id
  left join public.guarantee_windows g  on g.user_id = r.user_id
  where r.ref is not null
  group by r.ref
  order by active_paid desc;

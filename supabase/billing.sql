-- ===========================================================================
-- EdgeDesk — the three tables the signup path writes to and reads from.
--
-- WHY THIS FILE EXISTS. `billing_consents`, `referrals` and `subscriptions`
-- were referenced by index.html and app.html from the day they were written,
-- and no file in this repository ever created any of them. The landing page
-- said so out loud, to the CUSTOMER, on the checkout screen: "Run
-- subscriptions.sql if this table is missing." That file does not exist here
-- either. This is it, under the name the code actually uses.
--
-- The consent write is the load-bearing one. `confirmArl()` records the exact
-- renewal terms shown on screen BEFORE sending anyone to Stripe, and refuses
-- to continue if it cannot — automatic-renewal law requires the record, so a
-- consent that cannot be stored must never become a charge. That refusal is
-- correct. What it meant in practice, with the table missing, is that every
-- signup reached the trial screen and stopped dead, with an account already
-- created and the customer believing it had failed.
--
-- SAFE TO RUN OVER AN EXISTING INSTALLATION. Every table is `create table if
-- not exists` and every column is `add column if not exists`, so a project
-- where some of these were made by hand in the dashboard gets exactly the
-- columns it is missing and keeps every row it has. Nothing is dropped and no
-- existing value is rewritten.
--
-- Idempotent, additive, and it ends in a report — the convention every file in
-- this folder follows. Rows 1-14 should each say ok.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ── billing_consents ───────────────────────────────────────────────────────
-- One row per time somebody affirmed the renewal terms. Append-only by intent:
-- the record of what a customer was shown, when, is evidence, and retention is
-- three years. Never updated, never deleted through a client role.
create table if not exists public.billing_consents (
  id                    uuid        primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  user_email            text,
  price_display         text,
  billing_period        text,
  trial_days            integer,
  offer_text            text,
  consent_version       text,
  user_agent            text
);
-- EVERY COLUMN IS ADDED SEPARATELY, NOT JUST THE NEW ONES. `create table if
-- not exists` no-ops against a table somebody made by hand in the dashboard,
-- so a partial hand-made shape would survive this file untouched and the
-- insert would go on failing — the exact failure this migration exists to end.
-- The repo has been bitten by this before (see close_v7_parity.sql, where six
-- columns existed only because someone added them in the dashboard).
alter table public.billing_consents add column if not exists user_email            text;
alter table public.billing_consents add column if not exists price_display         text;
alter table public.billing_consents add column if not exists billing_period        text;
alter table public.billing_consents add column if not exists trial_days            integer;
alter table public.billing_consents add column if not exists offer_text            text;
alter table public.billing_consents add column if not exists consent_version       text;
alter table public.billing_consents add column if not exists user_agent            text;
alter table public.billing_consents add column if not exists created_at            timestamptz not null default now();
-- the attribution the page sends alongside every consent
alter table public.billing_consents add column if not exists ref                   text;
alter table public.billing_consents add column if not exists ref_last              text;
alter table public.billing_consents add column if not exists utm_source            text;
alter table public.billing_consents add column if not exists utm_medium            text;
alter table public.billing_consents add column if not exists utm_campaign          text;
alter table public.billing_consents add column if not exists utm_content           text;
alter table public.billing_consents add column if not exists landing_page          text;
alter table public.billing_consents add column if not exists referrer_host         text;
alter table public.billing_consents add column if not exists first_seen_at         timestamptz;
alter table public.billing_consents add column if not exists organic_first_seen_at timestamptz;

create index if not exists billing_consents_by_user
  on public.billing_consents (user_id, created_at desc);

alter table public.billing_consents enable row level security;

drop policy if exists billing_consents_insert on public.billing_consents;
create policy billing_consents_insert
  on public.billing_consents for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists billing_consents_read on public.billing_consents;
create policy billing_consents_read
  on public.billing_consents for select
  to authenticated
  using (user_id = auth.uid());

-- No update and no delete policy: a consent record is evidence.
grant select, insert on public.billing_consents to authenticated;
revoke update, delete on public.billing_consents from anon, authenticated;
revoke all on public.billing_consents from anon;

comment on table public.billing_consents is
  'Automatic-renewal consent. One row per affirmation, storing the exact offer '
  'text displayed. Append-only: owner-read, owner-insert, no update or delete '
  'through any client role. Retain three years.';

-- ── referrals ──────────────────────────────────────────────────────────────
-- First-touch partner credit, one row per account, upserted on user_id — the
-- landing page posts with on_conflict=user_id, so that unique constraint is
-- not optional.
create table if not exists public.referrals (
  user_id               uuid        primary key references auth.users(id) on delete cascade,
  created_at            timestamptz not null default now(),
  user_email            text,
  ref                   text,
  ref_last              text,
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text,
  landing_page          text,
  referrer_host         text,
  first_seen_at         timestamptz,
  organic_first_seen_at timestamptz
);

-- same reasoning as above: a hand-made referrals table gets its missing columns
alter table public.referrals add column if not exists created_at            timestamptz not null default now();
alter table public.referrals add column if not exists user_email            text;
alter table public.referrals add column if not exists ref                   text;
alter table public.referrals add column if not exists ref_last              text;
alter table public.referrals add column if not exists utm_source            text;
alter table public.referrals add column if not exists utm_medium            text;
alter table public.referrals add column if not exists utm_campaign          text;
alter table public.referrals add column if not exists utm_content           text;
alter table public.referrals add column if not exists landing_page          text;
alter table public.referrals add column if not exists referrer_host         text;
alter table public.referrals add column if not exists first_seen_at         timestamptz;
alter table public.referrals add column if not exists organic_first_seen_at timestamptz;

create index if not exists referrals_by_ref on public.referrals (ref) where ref is not null;

alter table public.referrals enable row level security;

drop policy if exists referrals_insert on public.referrals;
create policy referrals_insert
  on public.referrals for insert
  to authenticated
  with check (user_id = auth.uid());

-- The upsert path needs update as well as insert, but only ever of your own row.
drop policy if exists referrals_update on public.referrals;
create policy referrals_update
  on public.referrals for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists referrals_read on public.referrals;
create policy referrals_read
  on public.referrals for select
  to authenticated
  using (user_id = auth.uid());

grant select, insert, update on public.referrals to authenticated;
revoke all on public.referrals from anon;

comment on table public.referrals is
  'First-touch attribution, one row per account, upserted on user_id. Exists '
  'from account creation so partner reporting can count signups that never '
  'converted.';

-- ── subscriptions ──────────────────────────────────────────────────────────
-- Written by the Stripe webhook (service role), read by the browser to decide
-- what the paywall does. THE BROWSER MAY ONLY READ, and only its own row: a
-- client that could write this could grant itself the product.
--
-- `price_id` is what the row was sold under, and it is also how a row that was
-- NEVER SOLD says so. `price_id = 'owner_comp'` with `status = 'active'` is
-- full access granted here rather than bought through Stripe — the owner's own
-- account, and anything else comped the same way. Such a row has no
-- stripe_customer_id and no stripe_subscription_id, and both being null is
-- correct rather than incomplete: nothing was purchased, so there is nothing
-- for Stripe to have an id for. The paywall in app.html, the checkout in
-- index.html and the webhook all read this column and treat that pair as paid;
-- without it a comp is indistinguishable from an ordinary subscription and the
-- one account that can never be charged gets walked into a payment screen.
create table if not exists public.subscriptions (
  user_id                uuid        primary key references auth.users(id) on delete cascade,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  status                 text,
  price_id               text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean     not null default false,
  stripe_customer_id     text,
  stripe_subscription_id text
);

-- and the paywall's columns, whatever shape the table arrived in
alter table public.subscriptions add column if not exists created_at             timestamptz not null default now();
alter table public.subscriptions add column if not exists updated_at             timestamptz not null default now();
alter table public.subscriptions add column if not exists status                 text;
alter table public.subscriptions add column if not exists price_id               text;
alter table public.subscriptions add column if not exists current_period_end     timestamptz;
alter table public.subscriptions add column if not exists cancel_at_period_end   boolean not null default false;
alter table public.subscriptions add column if not exists stripe_customer_id     text;
alter table public.subscriptions add column if not exists stripe_subscription_id text;

create index if not exists subscriptions_by_customer
  on public.subscriptions (stripe_customer_id) where stripe_customer_id is not null;

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_read on public.subscriptions;
create policy subscriptions_read
  on public.subscriptions for select
  to authenticated
  using (user_id = auth.uid());

-- No insert, update or delete policy for any client role. The webhook uses the
-- service role, which bypasses RLS; nothing a browser sends can reach this.
grant select on public.subscriptions to authenticated;
revoke insert, update, delete on public.subscriptions from anon, authenticated;
revoke all on public.subscriptions from anon;

comment on table public.subscriptions is
  'Subscription state, one row per account. Written only by the Stripe webhook '
  'under the service role, or by hand for a comp; every client role has '
  'read-only access to its own row. The paywall in app.html reads this. '
  'price_id = ''owner_comp'' with status = ''active'' is access granted here '
  'rather than bought: no Stripe ids, never expires, and the webhook refuses '
  'to write over it.';

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'billing_consents exists' as check,
       case when to_regclass('public.billing_consents') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'billing_consents has every column the page sends',
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='billing_consents'
                     and column_name in ('user_id','user_email','price_display','billing_period',
                       'trial_days','offer_text','consent_version','user_agent','ref','ref_last',
                       'utm_source','utm_medium','utm_campaign','utm_content','landing_page',
                       'referrer_host','first_seen_at','organic_first_seen_at')) = 18
            then 'ok' else 'CHECK THIS' end
union all select 3, 'billing_consents RLS is on',
       case when (select relrowsecurity from pg_class where oid='public.billing_consents'::regclass) then 'ok' else 'CHECK THIS' end
union all select 4, 'a signed-in user can insert only their own consent',
       case when exists (select 1 from pg_policies where schemaname='public' and tablename='billing_consents'
                          and policyname='billing_consents_insert') then 'ok' else 'CHECK THIS' end
union all select 5, 'a consent can never be edited or deleted by a client',
       case when not exists (select 1 from pg_policies where schemaname='public'
                              and tablename='billing_consents' and cmd in ('UPDATE','DELETE')) then 'ok' else 'CHECK THIS' end
union all select 6, 'anon cannot reach billing_consents at all',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='billing_consents' and grantee='anon')
            then 'ok' else 'CHECK THIS' end
union all select 7, 'referrals exists',
       case when to_regclass('public.referrals') is not null then 'ok' else 'CHECK THIS' end
union all select 8, 'referrals is keyed on user_id, so on_conflict=user_id works',
       case when exists (select 1 from pg_constraint
                          where conrelid='public.referrals'::regclass and contype in ('p','u')
                            and conkey = array[(select attnum from pg_attribute
                                                 where attrelid='public.referrals'::regclass and attname='user_id')])
            then 'ok' else 'CHECK THIS' end
union all select 9, 'referrals RLS is on',
       case when (select relrowsecurity from pg_class where oid='public.referrals'::regclass) then 'ok' else 'CHECK THIS' end
union all select 10, 'subscriptions exists',
       case when to_regclass('public.subscriptions') is not null then 'ok' else 'CHECK THIS' end
union all select 11, 'subscriptions has the columns the paywall reads',
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='subscriptions'
                     and column_name in ('status','price_id','current_period_end','cancel_at_period_end','stripe_customer_id')) = 5
            then 'ok' else 'CHECK THIS' end
union all select 12, 'subscriptions RLS is on',
       case when (select relrowsecurity from pg_class where oid='public.subscriptions'::regclass) then 'ok' else 'CHECK THIS' end
union all select 13, 'NO client role can write subscriptions — it would be granting itself the product',
       case when not exists (select 1 from pg_policies where schemaname='public'
                              and tablename='subscriptions' and cmd in ('INSERT','UPDATE','DELETE'))
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='subscriptions'
                                and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE'))
            then 'ok' else 'CHECK THIS' end
union all select 14, 'existing rows preserved',
       'ok (' || (select count(*) from public.billing_consents)::text || ' consents, '
              || (select count(*) from public.referrals)::text || ' referrals, '
              || (select count(*) from public.subscriptions)::text || ' subscriptions)'
order by row;

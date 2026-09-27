-- ===========================================================================
-- EdgeDesk — the Stripe webhook's ledger.
--
-- WHY THIS EXISTS. Until now `public.subscriptions` was filled in BY HAND. Nine
-- rows were inserted from the SQL editor because the webhook that was meant to
-- write them was never connected, and it shows in the data: six rows created
-- inside ninety seconds, and `current_period_end` values of 2036 and 2108 that
-- no monthly billing period ever produced. Five of those rows have since gone
-- stale and are locking real customers out of a product they are marked active
-- for, because `pgEntitled()` in app.html reads a past period end as lapsed —
-- correctly.
--
-- A webhook that writes money state has three failure modes worth designing
-- against, and this table exists for all three:
--
--   1. STRIPE RETRIES. Delivery is at-least-once. Every event is recorded by
--      its own `id` with a unique constraint, so the second delivery of an
--      event is a no-op rather than a second write.
--   2. STRIPE REORDERS. `customer.subscription.updated` can arrive before the
--      `checkout.session.completed` that identifies whose subscription it is,
--      and an old event can arrive after a newer one. Events are stamped with
--      Stripe's own `created` time and the writer refuses to apply one older
--      than what the row already reflects.
--   3. AN EVENT ARRIVES FOR A CUSTOMER WE CANNOT YET NAME. That is not an
--      error and must not be a retry storm: it is stored `unresolved`, the
--      webhook answers 200, and the next event that does identify the customer
--      reconciles it. Anything still unresolved is a real question for a human,
--      and `stripe_events_unresolved` is where they look.
--
-- Nothing here is reachable from a browser. RLS is on and no client role has
-- any grant: the webhook writes with the service role, which bypasses RLS.
--
-- Idempotent, additive, ends in a report. Rows 1-11 should each say ok.
-- Run it BEFORE deploying supabase/functions/stripe_webhook.
-- ===========================================================================

create extension if not exists pgcrypto;

create table if not exists public.stripe_events (
  id             text        primary key,          -- Stripe's own event id (evt_...)
  type           text        not null,
  created_at     timestamptz not null default now(),
  stripe_created timestamptz,                      -- Stripe's `created`, the ordering key
  customer_id    text,
  subscription_id text,
  user_id        uuid        references auth.users(id) on delete set null,
  resolved       boolean     not null default false,
  applied        boolean     not null default false,
  note           text,
  payload        jsonb
);

-- EVERY COLUMN IS ADDED INDEPENDENTLY, INCLUDING THE ONES IN THE CREATE ABOVE.
-- `create table if not exists` no-ops against a table that already exists, so a
-- stripe_events made by hand during an earlier attempt at this keeps whatever
-- shape it had — and the index below then dies on a column that was never
-- added, rolling the whole file back. That is not hypothetical: it is exactly
-- what happened on the first real run of this migration, and it is the same
-- trap billing.sql already guards against.
--
-- `type` is added WITHOUT its NOT NULL here on purpose: an existing table may
-- hold rows, and a NOT NULL with no default cannot be added to them. Fresh
-- installs still get the constraint from the create above.
alter table public.stripe_events add column if not exists type            text;
alter table public.stripe_events add column if not exists created_at      timestamptz not null default now();
alter table public.stripe_events add column if not exists stripe_created  timestamptz;
alter table public.stripe_events add column if not exists customer_id     text;
alter table public.stripe_events add column if not exists subscription_id text;
alter table public.stripe_events add column if not exists user_id         uuid;
alter table public.stripe_events add column if not exists resolved        boolean not null default false;
alter table public.stripe_events add column if not exists applied         boolean not null default false;
alter table public.stripe_events add column if not exists note            text;
alter table public.stripe_events add column if not exists payload         jsonb;

create index if not exists stripe_events_recent    on public.stripe_events (created_at desc);
create index if not exists stripe_events_customer  on public.stripe_events (customer_id) where customer_id is not null;
create index if not exists stripe_events_unresolved_ix
  on public.stripe_events (created_at desc) where not resolved;

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;

comment on table public.stripe_events is
  'Every Stripe webhook delivery, keyed on Stripe''s event id so a retry is a '
  'no-op. Written only by the stripe_webhook edge function under the service '
  'role; no client role has any grant. Payloads are kept for audit.';

-- ── ordering guard ─────────────────────────────────────────────────────────
-- The last Stripe event time actually applied to each subscription row, so an
-- out-of-order delivery cannot resurrect a cancelled subscription.
alter table public.subscriptions add column if not exists last_event_at  timestamptz;
alter table public.subscriptions add column if not exists last_event_id  text;
-- Also added by billing.sql, which is meant to run first. Repeated here so this
-- file stands on its own: the report below reads price_id, and the webhook
-- refuses to write over a row carrying 'owner_comp'.
alter table public.subscriptions add column if not exists price_id       text;

-- ── naming a customer we only know by email ────────────────────────────────
-- The webhook's last-resort identification. Deliberately a database function
-- rather than a call to the auth admin API: it is one round trip, it is
-- testable, and the rule it enforces lives next to the data it protects.
--
-- CONFIRMED ACCOUNTS ONLY. An unconfirmed address proves nothing — anybody can
-- sign up as somebody else's email — and matching one here would hand that
-- person's subscription to a stranger. Oldest confirmed account wins, so a
-- later duplicate cannot capture an existing customer's billing.
create or replace function public.stripe_user_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth, pg_catalog
as $$
  select u.id
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
     and u.email_confirmed_at is not null
   order by u.created_at asc
   limit 1;
$$;
-- The service role reaches it by bypassing RLS; no client role may call it,
-- because it answers "does this email have an account", which is not a
-- question a browser gets to ask.
revoke all on function public.stripe_user_by_email(text) from public, anon, authenticated;

-- ── what a human looks at ──────────────────────────────────────────────────
-- Deliveries that could not be attached to an account. Empty is the healthy
-- state; anything in here is money the product cannot see.
create or replace view public.stripe_events_unresolved as
  select id, type, created_at, stripe_created, customer_id, subscription_id, note
    from public.stripe_events
   where not resolved
   order by created_at desc;
revoke all on public.stripe_events_unresolved from anon, authenticated;

-- ===========================================================================
-- THE FIVE LOCKED-OUT ROWS ARE NOT TOUCHED HERE, ON PURPOSE.
--
-- leroylim99, justin65535, joelopez014, hman0819 and dickygabriel007 are marked
-- `active` with a `current_period_end` of 2026-08-23, so the paywall refuses
-- them. Whether each is a real paying customer, a lapsed one, or a hand-made
-- test row is a question about MONEY, and this file will not guess at it. Once
-- the webhook is live, the honest repair is to let Stripe answer: resend the
-- current `customer.subscription.updated` for each from the Stripe dashboard
-- and the real status and period end will land here.
--
-- If Stripe has no subscription for one of them, they were never a customer and
-- the row should go. Either way a human decides, not a migration.
-- ===========================================================================

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'stripe_events exists' as check,
       case when to_regclass('public.stripe_events') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'its primary key is Stripe''s event id, so a retry cannot write twice',
       case when exists (select 1 from pg_constraint
                          where conrelid='public.stripe_events'::regclass and contype='p'
                            and conkey = array[(select attnum from pg_attribute
                                                 where attrelid='public.stripe_events'::regclass and attname='id')])
            then 'ok' else 'CHECK THIS' end
union all select 3, 'RLS is on and no client role can read the ledger',
       case when (select relrowsecurity from pg_class where oid='public.stripe_events'::regclass)
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='stripe_events'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 4, 'subscriptions carries the ordering guard',
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='subscriptions'
                     and column_name in ('last_event_at','last_event_id')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 5, 'subscriptions is still unwritable by any client role',
       case when not exists (select 1 from pg_policies where schemaname='public'
                              and tablename='subscriptions' and cmd in ('INSERT','UPDATE','DELETE'))
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='subscriptions'
                                and grantee in ('anon','authenticated')
                                and privilege_type in ('INSERT','UPDATE','DELETE'))
            then 'ok' else 'CHECK THIS — run supabase/billing.sql first' end
union all select 6, 'the unresolved view exists and is not client-readable',
       case when to_regclass('public.stripe_events_unresolved') is not null
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='stripe_events_unresolved'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 7, 'stripe_events.id is text, so a Stripe evt_... id fits',
       case when (select data_type from information_schema.columns
                   where table_schema='public' and table_name='stripe_events' and column_name='id')
            in ('text','character varying') then 'ok'
            else 'CHECK THIS — an earlier stripe_events has a non-text id; Stripe event ids are strings '
                 'like evt_1A2b3C. Rename that table out of the way and re-run this file.' end
union all select 8, 'stripe_user_by_email is security definer and closed to clients',
       case when (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' and p.proname='stripe_user_by_email')
             and not exists (select 1 from information_schema.role_routine_grants
                              where routine_schema='public' and routine_name='stripe_user_by_email'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 9, 'hand-made subscription rows, for the record',
       'ok (' || (select count(*) from public.subscriptions where last_event_id is null)::text
              || ' rows never written by a webhook)'
-- A COMPED ROW IS NEVER REFUSED, whatever its period end says, so it must not
-- be counted here: pgEntitled() returns true on price_id = 'owner_comp' before
-- it looks at a date at all. Counting one would report a lockout that is not
-- happening, and send somebody looking for a bug in the paywall.
--
-- AN EXPIRED COMP TRIAL IS NOT A LOCKOUT EITHER, for a different reason.
-- `price_id = 'comp_trial'` (supabase/comp_trial.sql) is access granted in this
-- database with a deadline written into `current_period_end`, and that date
-- being in the past is the deadline ARRIVING — the outcome the row was created
-- to produce. This check exists to find a stale Stripe row stranding somebody
-- who is paying; counting trials that simply ran their course turns every one
-- of them into a red row nobody should act on, and a report that cries wolf
-- gets ignored on the day it is right. Row 11 counts them on their own, where
-- the number means what it says.
union all select 10, 'rows currently locking out an active subscriber',
       case when (select count(*) from public.subscriptions
                   where status in ('active','trialing') and current_period_end < now()
                     and coalesce(price_id,'') not in ('owner_comp','comp_trial')) = 0
            then 'ok (none)'
            else 'CHECK THIS — ' || (select count(*) from public.subscriptions
                   where status in ('active','trialing') and current_period_end < now()
                     and coalesce(price_id,'') not in ('owner_comp','comp_trial'))::text
              || ' active rows have a past period end and are being refused by the paywall' end
union all select 11, 'comped trials, for the record',
       'ok (' || (select count(*) from public.subscriptions
                   where coalesce(price_id,'') = 'comp_trial'
                     and current_period_end is not null and current_period_end < now())::text
              || ' run out, ' || (select count(*) from public.subscriptions
                   where coalesce(price_id,'') = 'comp_trial'
                     and (current_period_end is null or current_period_end >= now()))::text
              || ' still open)'
order by row;

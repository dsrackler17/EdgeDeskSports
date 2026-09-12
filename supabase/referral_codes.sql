-- ===========================================================================
-- EdgeDesk — which subscriptions came in through which discount code.
--
-- WHAT THIS ANSWERS, and nothing else: "who signed up through this code, are
-- they still active, and how much money has actually arrived from them." It is
-- a discount code and an attribution log. There is no partner login, no payout
-- run and no dashboard, because none of those are needed to answer that.
--
-- WHY IT IS NOT `public.referrals`. That table already exists and is a
-- different measurement: FIRST-TOUCH LINK attribution, captured in the browser
-- from `?ref=` and frozen at account creation, written by the page. This is
-- CHECKOUT attribution, captured from Stripe's own `promotion_code` on the
-- session that took the money, written by the webhook under the service role.
-- One is "which link brought them here"; the other is "which code they typed
-- when they paid". They disagree often and legitimately — somebody can arrive
-- on a partner link and redeem a different code — so they are kept apart and
-- neither is allowed to stand in for the other.
--
-- THE DISCRIMINATOR IS THE PROMOTION CODE, NOT THE COUPON. Two promotion codes
-- can share one coupon, so "a 25% discount was applied" does not say who sent
-- the customer. `stripe_promotion_code_id` is what Stripe actually reported and
-- is the id everything here joins on; the human code is the label on it.
--
-- NOTHING HERE INVENTS A NUMBER. A subscription with no promotion code reports
-- as `(unattributed)`. One that carried a discount the webhook could not name
-- reports as `(discount, code not resolved)` — a bucket of its own, so it can
-- never be quietly folded into either the code's total or the unattributed
-- pile. Revenue is summed from `invoice.payment_succeeded` payloads the webhook
-- actually received; invoices that match no subscription row are reported on
-- their own line rather than dropped, so the report's total is the ledger's
-- total.
--
-- RUN ORDER. `billing.sql`, then `stripe_webhook.sql`, then this. The two
-- guards below say so out loud rather than failing on a missing relation.
--
-- CONVENTION (supabase/README.md): idempotent, additive, ends in a report.
-- Rows 1-13 should each say ok. No psql meta-commands — this is pasted into
-- the SQL editor.
-- ===========================================================================

-- ── the two files this one stands on ───────────────────────────────────────
-- A `create view` resolves its table names at PARSE time, so a runtime `if
-- exists` guard around one does not work (see the note in site_articles.sql).
-- Failing here, before anything is created, is the honest alternative: the
-- paste does nothing and the message says which file to run.
do $guard$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'public.subscriptions does not exist. Run supabase/billing.sql first.';
  end if;
  if to_regclass('public.stripe_events') is null then
    raise exception 'public.stripe_events does not exist. Run supabase/stripe_webhook.sql first — '
                    'the revenue half of this report reads the delivery ledger.';
  end if;
end
$guard$;

-- ── referral_codes ─────────────────────────────────────────────────────────
-- The codes we have handed out, and who each one belongs to. Configuration,
-- not measurement: no count is ever stored here, so this table cannot go stale
-- against the subscriptions it describes.
--
-- A row is NEVER deleted when a code stops being offered — `retired_at` says it
-- is closed and every subscription already attributed to it keeps its label.
-- Deleting the row would leave the sales it made reporting as an unknown code.
create table if not exists public.referral_codes (
  code                     text        primary key,
  partner_name             text,
  created_at               timestamptz not null default now(),
  -- Stripe's own ids, pasted in after the coupon and promotion code exist.
  -- `stripe_promotion_code_id` is the webhook's OFFLINE mapping: with it, a
  -- promo id on a checkout can be named without calling Stripe at all.
  stripe_promotion_code_id text,
  stripe_coupon_id         text,
  note                     text,
  retired_at               timestamptz
);

-- Every column added independently, for the reason billing.sql states: `create
-- table if not exists` no-ops against a table somebody made by hand in the
-- dashboard, and a partial shape would survive this file untouched.
alter table public.referral_codes add column if not exists partner_name             text;
alter table public.referral_codes add column if not exists created_at               timestamptz not null default now();
alter table public.referral_codes add column if not exists stripe_promotion_code_id text;
alter table public.referral_codes add column if not exists stripe_coupon_id         text;
alter table public.referral_codes add column if not exists note                     text;
alter table public.referral_codes add column if not exists retired_at               timestamptz;

-- Stripe matches a promotion code case-insensitively at redemption, so BETDESK
-- and betdesk are one code and must never become two rows here.
create unique index if not exists referral_codes_code_ci
  on public.referral_codes (upper(code));
create unique index if not exists referral_codes_promo_id
  on public.referral_codes (stripe_promotion_code_id)
  where stripe_promotion_code_id is not null;

alter table public.referral_codes enable row level security;
revoke all on public.referral_codes from anon, authenticated;

comment on table public.referral_codes is
  'Discount codes handed out, and who each belongs to. Configuration only — no '
  'counts are stored, so it cannot go stale. Read by the stripe_webhook edge '
  'function under the service role to name a promotion code and snapshot the '
  'partner; no client role has any grant. A retired code keeps its row, because '
  'deleting it would orphan every sale it made.';

-- ── the attribution, on the row that already holds the sale ────────────────
-- On `subscriptions` rather than in a second table, because the question is
-- always asked of a subscription ("is this one still active?") and a join that
-- can miss is a join that under-reports.
alter table public.subscriptions add column if not exists referral_code            text;
alter table public.subscriptions add column if not exists referred_partner         text;
alter table public.subscriptions add column if not exists stripe_promotion_code_id text;
alter table public.subscriptions add column if not exists stripe_coupon_id         text;
-- HOW WE LEARNED IT, kept because it is the difference between a number that is
-- measured and one that was inferred:
--   checkout_session          the promotion code was on the checkout session
--   checkout_session_code     …and the session carried the human code itself
--   stripe_promotion_code     the id was resolved by asking Stripe for it
--   referral_codes            the id was named from the table below, offline
--   subscription_object       read off the subscription Stripe returned
--   manual                    written by hand in the SQL editor
alter table public.subscriptions add column if not exists referral_source          text;

create index if not exists subscriptions_by_referral_code
  on public.subscriptions (referral_code) where referral_code is not null;

comment on column public.subscriptions.referral_code is
  'The promotion code this subscription was bought under, normalised to upper '
  'case, as reported by Stripe on the checkout session. Null means no code was '
  'used — it never means "unknown but probably one of them". Written once: the '
  'first attribution wins and the webhook will not overwrite it.';
comment on column public.subscriptions.referred_partner is
  'partner_name from referral_codes AS IT STOOD WHEN THE SALE HAPPENED. A '
  'snapshot, like billing_consents.offer_text: renaming a partner later must '
  'not silently rewrite what an old sale says. The report joins referral_codes '
  'for the current name and falls back to this.';

-- ── the codes themselves ───────────────────────────────────────────────────
-- Edit this block, paste, read the report. Re-running never renames a code:
-- the insert is `do nothing`, and the Stripe ids are filled in ONLY where they
-- are still null, which is the additive rule this folder runs on.
do $codes$
declare
  -- ==== THE VALUES THIS FILE IS ABOUT ==================================== --
  -- The code as it is typed at Stripe checkout. Stored upper case.
  p_code    text := 'BETDESK';
  p_partner text := 'BETDESK launch promo';
  -- Paste these in after creating the coupon and promotion code in Stripe
  -- (Products > Coupons). Leave null until then: with them set, the webhook can
  -- name this code without a single call to Stripe, which is what keeps
  -- attribution working on a day the Stripe API is slow or the key is unset.
  p_promo   text := null;   -- 'promo_1ABC…'
  p_coupon  text := null;   -- the coupon id behind it
  -- ====================================================================== --
begin
  insert into public.referral_codes (code, partner_name, stripe_promotion_code_id, stripe_coupon_id)
  values (upper(btrim(p_code)), p_partner, p_promo, p_coupon)
  on conflict (code) do nothing;

  update public.referral_codes
     set stripe_promotion_code_id = coalesce(stripe_promotion_code_id, p_promo),
         stripe_coupon_id         = coalesce(stripe_coupon_id, p_coupon),
         partner_name             = coalesce(partner_name, p_partner)
   where code = upper(btrim(p_code));
end
$codes$;

-- ── reading a Stripe id out of a payload ───────────────────────────────────
-- Stripe sends a related object either as an id string or, when something
-- expanded it, as the object. Both shapes mean the same thing and neither is
-- rare, so the report reads both rather than silently counting one of them as
-- absent.
create or replace function public.referral_stripe_id(p jsonb)
returns text
language sql
immutable
as $$
  select case
           when p is null or jsonb_typeof(p) = 'null' then null
           when jsonb_typeof(p) = 'string' then nullif(p #>> '{}', '')
           when jsonb_typeof(p) = 'object' then nullif(p ->> 'id', '')
           else null
         end;
$$;
revoke all on function public.referral_stripe_id(jsonb) from public, anon, authenticated;

-- ── money that actually arrived ────────────────────────────────────────────
-- Every `invoice.payment_succeeded` the webhook has received, one row per
-- INVOICE. The ledger is keyed on Stripe's event id, so a retry is already a
-- no-op; this additionally collapses the case of two events describing one
-- invoice, keeping the latest, so an invoice can never be counted twice.
--
-- THE WINDOW IS THE LEDGER'S WINDOW. Nothing here reconstructs revenue from
-- before the webhook was listening, and nothing estimates. Row 12 of the report
-- says what the window actually is.
--
-- REFUNDS AND DISPUTES ARE NOT SUBTRACTED. `charge.refunded` is deliberately
-- not a handled event type (see HANDLED in the webhook), so the ledger has no
-- refunds in it and this is GROSS received, not net. Saying that here is the
-- alternative to a net figure that quietly is not one.
create or replace view public.referral_invoice_payments as
  select distinct on (e.payload ->> 'id')
         e.payload ->> 'id'                                          as invoice_id,
         coalesce(
           public.referral_stripe_id(e.payload -> 'subscription'),
           -- newer API versions moved it under the invoice's parent
           public.referral_stripe_id(e.payload -> 'parent' -> 'subscription_details' -> 'subscription')
         )                                                           as stripe_subscription_id,
         public.referral_stripe_id(e.payload -> 'customer')           as stripe_customer_id,
         (e.payload ->> 'amount_paid')::bigint                        as amount_paid_cents,
         upper(nullif(e.payload ->> 'currency', ''))                  as currency,
         coalesce(e.stripe_created, e.created_at)                     as paid_at
    from public.stripe_events e
   where e.type = 'invoice.payment_succeeded'
     and e.payload ->> 'id' is not null
     and e.payload ->> 'amount_paid' ~ '^[0-9]+$'
   order by e.payload ->> 'id', coalesce(e.stripe_created, e.created_at) desc;
revoke all on public.referral_invoice_payments from anon, authenticated;

-- Which subscription row each paid invoice belongs to. An invoice names its
-- subscription and its customer; the subscription id is the stronger claim, so
-- it wins, and `distinct on` makes sure one invoice is credited exactly once
-- even if both columns match.
create or replace view public.referral_invoice_owners as
  select distinct on (p.invoice_id)
         p.invoice_id, p.amount_paid_cents, p.currency, p.paid_at,
         s.user_id,
         case when p.stripe_subscription_id is not null
               and p.stripe_subscription_id = s.stripe_subscription_id
              then 'subscription' else 'customer' end as matched_on
    from public.referral_invoice_payments p
    join public.subscriptions s
      on (p.stripe_subscription_id is not null and p.stripe_subscription_id = s.stripe_subscription_id)
      or (p.stripe_customer_id     is not null and p.stripe_customer_id     = s.stripe_customer_id)
   order by p.invoice_id,
            case when p.stripe_subscription_id is not null
                  and p.stripe_subscription_id = s.stripe_subscription_id then 0 else 1 end,
            s.user_id;
revoke all on public.referral_invoice_owners from anon, authenticated;

-- ── who signed up under which code ─────────────────────────────────────────
-- One row per subscription, always. A subscription that carried no code is not
-- missing from here; it is labelled `(unattributed)`, which is the whole point.
create or replace view public.referral_signups as
  select
    case
      when nullif(btrim(s.referral_code), '') is not null then upper(btrim(s.referral_code))
      when s.stripe_promotion_code_id is not null or s.stripe_coupon_id is not null
        then '(discount, code not resolved)'
      else '(unattributed)'
    end                                                        as code,
    coalesce(rc.partner_name, s.referred_partner)               as partner_name,
    s.user_id,
    u.email                                                     as user_email,
    s.status,
    s.price_id,
    -- pgEntitled() from app.html and community_is_entitled() from
    -- community_posts.sql, stated once more and deliberately NOT a fourth
    -- definition: report row 11 compares this against that function wherever it
    -- is installed and says CHECK THIS if the two ever disagree.
    (
         (s.status = 'active' and coalesce(s.price_id, '') in ('owner_comp'))
      or (s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end >= now()))
      or (s.status = 'past_due'
          and (s.current_period_end is null or now() - s.current_period_end < interval '21 days'))
    )                                                           as still_active,
    s.current_period_end,
    s.cancel_at_period_end,
    s.referral_source,
    s.stripe_promotion_code_id,
    s.stripe_coupon_id,
    s.stripe_customer_id,
    s.stripe_subscription_id,
    s.created_at                                                as subscription_created_at,
    coalesce(m.paid_invoices, 0)                                as paid_invoices,
    coalesce(m.revenue_cents, 0)                                as revenue_cents,
    m.currencies,
    m.last_payment_at
  from public.subscriptions s
  left join public.referral_codes rc
    on nullif(btrim(s.referral_code), '') is not null
   and upper(rc.code) = upper(btrim(s.referral_code))
  left join auth.users u on u.id = s.user_id
  -- ONLY INVOICES THAT MOVED MONEY. A $0 invoice is a real Stripe event and a
  -- real row in referral_invoice_payments — it is what a free trial period
  -- produces — but counting one as a payment would put a date in
  -- `last_payment_at` for a customer who has never paid anything, and a
  -- currency next to a revenue of zero.
  left join lateral (
    select count(*)                                                   as paid_invoices,
           coalesce(sum(o.amount_paid_cents), 0)                      as revenue_cents,
           string_agg(distinct o.currency, ',' order by o.currency)   as currencies,
           max(o.paid_at)                                             as last_payment_at
      from public.referral_invoice_owners o
     where o.user_id = s.user_id
       and o.amount_paid_cents > 0
  ) m on true;
revoke all on public.referral_signups from anon, authenticated;

comment on view public.referral_signups is
  'One row per subscription, with the code it came in under. Never omits a '
  'subscription: no code reports as (unattributed) and an unnamed discount as '
  '(discount, code not resolved). Owner-run — no client role has any grant.';

-- ── the report ─────────────────────────────────────────────────────────────
-- THE THING TO OPEN PERIODICALLY:
--   select * from public.referral_code_report;
create or replace view public.referral_code_report as
  select
    g.code,
    g.partner_name,
    g.signups,
    g.still_active,
    g.paid_invoices,
    g.revenue_cents,
    -- Only when every invoice under this code is in one currency, and only for
    -- a currency whose minor unit really is 1/100. Otherwise null, because a
    -- number that might be a hundred times wrong is worse than no number.
    case when g.currencies in ('USD') then round(g.revenue_cents / 100.0, 2) end as revenue_usd,
    g.currencies,
    g.first_signup_at,
    g.last_signup_at,
    g.last_payment_at
  from (
    select
      v.code,
      max(v.partner_name)                                        as partner_name,
      count(*)                                                   as signups,
      count(*) filter (where v.still_active)                     as still_active,
      coalesce(sum(v.paid_invoices), 0)                          as paid_invoices,
      coalesce(sum(v.revenue_cents), 0)                          as revenue_cents,
      string_agg(distinct v.currencies, ',' order by v.currencies) as currencies,
      min(v.subscription_created_at)                             as first_signup_at,
      max(v.subscription_created_at)                             as last_signup_at,
      max(v.last_payment_at)                                     as last_payment_at
      from public.referral_signups v
     group by v.code

    union all

    -- MONEY THE REPORT CANNOT ATTACH TO ANY SUBSCRIPTION ROW. Usually a
    -- customer the webhook never resolved to an account (they are in
    -- public.stripe_events_unresolved). It is on its own line so that the sum
    -- of this report is the sum of the ledger — a total that silently drops
    -- invoices is the kind of number this file exists to refuse.
    select
      '(revenue not matched to any subscription)',
      null, 0, 0,
      count(*) filter (where p.amount_paid_cents > 0),
      coalesce(sum(p.amount_paid_cents), 0),
      string_agg(distinct p.currency, ',' order by p.currency),
      null, null, max(p.paid_at)
      from public.referral_invoice_payments p
     where not exists (select 1 from public.referral_invoice_owners o where o.invoice_id = p.invoice_id)
    having count(*) > 0
  ) g
  order by (g.code like '(%') , g.revenue_cents desc, g.signups desc, g.code;
revoke all on public.referral_code_report from anon, authenticated;

comment on view public.referral_code_report is
  'Signups, still-active count and received revenue per discount code. Revenue '
  'is GROSS, summed from the invoice.payment_succeeded payloads this project '
  'has actually received — refunds are not in the ledger and are not '
  'subtracted. Every subscription appears exactly once, and invoices matching '
  'no subscription are reported on their own line rather than dropped. '
  'Owner-run: no client role has any grant.';

-- ── does this report agree with the paywall? ───────────────────────────────
-- `still_active` above restates pgEntitled() from app.html, which
-- community_posts.sql already restated as community_is_entitled(). Three copies
-- of a rule is three chances for it to drift, so this compares two of them on
-- real rows and is re-runnable any time:  select public.referral_entitlement_agrees();
--
-- It is a FUNCTION rather than an expression in the report because a call is
-- resolved by the PARSER: `case when to_regprocedure(...) is null then ... else
-- community_is_entitled(...) end` fails to parse on a project where that file
-- was never run, taking the whole paste down with it. The same trap
-- site_articles.sql documents. Inside a function the call is dynamic, so the
-- guard actually guards.
create or replace function public.referral_entitlement_agrees()
returns text
language plpgsql
stable
as $agree$
declare n integer;
begin
  if to_regprocedure('public.community_is_entitled(uuid)') is null then
    return 'ok (community_is_entitled() is not installed here — nothing to compare)';
  end if;
  execute 'select count(*) from public.referral_signups v '
          'where v.still_active is distinct from public.community_is_entitled(v.user_id)' into n;
  if n = 0 then return 'ok'; end if;
  return 'CHECK THIS — ' || n::text ||
         ' rows where this report and the paywall disagree about who has access';
end;
$agree$;
revoke all on function public.referral_entitlement_agrees() from public, anon, authenticated;

-- ===========================================================================
-- NOTHING BACKFILLS OLD ROWS.
--
-- Subscriptions sold before this file existed have no promotion code on them
-- and none can be recovered from here: the code lived on a Stripe checkout
-- session the ledger may never have seen. They report as `(unattributed)`,
-- which is what they are. If a specific one is known to have used a code, that
-- is a human writing one row by hand and saying so:
--
--   update public.subscriptions
--      set referral_code = 'BETDESK', referred_partner = 'BETDESK launch promo',
--          referral_source = 'manual'
--    where user_id = '…' and referral_code is null;
--
-- `referral_source = 'manual'` is what keeps that row distinguishable from one
-- Stripe reported, forever.
-- ===========================================================================

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'referral_codes exists' as check,
       case when to_regclass('public.referral_codes') is not null then 'ok' else 'CHECK THIS' end as result
union all select 2, 'a code cannot be entered twice in two cases',
       case when exists (select 1 from pg_indexes where schemaname='public'
                          and indexname='referral_codes_code_ci') then 'ok' else 'CHECK THIS' end
union all select 3, 'referral_codes RLS is on and no client role can read it',
       case when (select relrowsecurity from pg_class where oid='public.referral_codes'::regclass)
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='referral_codes'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 4, 'subscriptions carries the attribution the webhook writes',
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='subscriptions'
                     and column_name in ('referral_code','referred_partner',
                       'stripe_promotion_code_id','stripe_coupon_id','referral_source')) = 5
            then 'ok' else 'CHECK THIS' end
union all select 5, 'subscriptions is STILL unwritable by any client role',
       case when not exists (select 1 from pg_policies where schemaname='public'
                              and tablename='subscriptions' and cmd in ('INSERT','UPDATE','DELETE'))
             and not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public' and table_name='subscriptions'
                                and grantee in ('anon','authenticated')
                                and privilege_type in ('INSERT','UPDATE','DELETE'))
            then 'ok' else 'CHECK THIS — run supabase/billing.sql first' end
union all select 6, 'the three report views exist',
       case when to_regclass('public.referral_invoice_payments') is not null
             and to_regclass('public.referral_signups') is not null
             and to_regclass('public.referral_code_report') is not null
            then 'ok' else 'CHECK THIS' end
union all select 7, 'and none of them is readable by a browser',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema='public'
                                and table_name in ('referral_invoice_payments','referral_invoice_owners',
                                                   'referral_signups','referral_code_report')
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 8, 'every subscription is on the report exactly once',
       case when (select count(*) from public.referral_signups)
               = (select count(*) from public.subscriptions)
            then 'ok (' || (select count(*) from public.subscriptions)::text || ' subscriptions)'
            else 'CHECK THIS — the report and the table disagree on how many subscriptions exist' end
union all select 9, 'codes on file',
       'ok (' || (select count(*) from public.referral_codes where retired_at is null)::text
              || ' live, ' || (select count(*) from public.referral_codes where retired_at is not null)::text
              || ' retired)'
union all select 10, 'codes still missing their Stripe promotion code id',
       case when (select count(*) from public.referral_codes
                   where retired_at is null and stripe_promotion_code_id is null) = 0
            then 'ok (none)'
            else 'ok (' || (select count(*) from public.referral_codes
                             where retired_at is null and stripe_promotion_code_id is null)::text
                 || ' — attribution still works through the Stripe API lookup; paste the promo_… ids '
                    'in to make it work without one)' end
union all select 11, 'still_active here agrees with community_is_entitled()',
       public.referral_entitlement_agrees()
union all select 12, 'the revenue window this report can actually see',
       case when (select count(*) from public.referral_invoice_payments) = 0
            then 'ok (no invoice.payment_succeeded in the ledger yet — revenue reads 0 because '
                 'none has arrived, not because none was earned)'
            else 'ok (' || (select count(*) from public.referral_invoice_payments)::text
                 || ' invoices, ' || (select to_char(min(paid_at),'YYYY-MM-DD') from public.referral_invoice_payments)
                 || ' to ' || (select to_char(max(paid_at),'YYYY-MM-DD') from public.referral_invoice_payments)
                 || ' — GROSS, refunds are not in the ledger)' end
union all select 13, 'invoices the report cannot attach to a subscription',
       case when (select count(*) from public.referral_invoice_payments p
                   where not exists (select 1 from public.referral_invoice_owners o
                                      where o.invoice_id = p.invoice_id)) = 0
            then 'ok (none)'
            else 'ok (' || (select count(*) from public.referral_invoice_payments p
                   where not exists (select 1 from public.referral_invoice_owners o
                                      where o.invoice_id = p.invoice_id))::text
                 || ' on their own line in the report — usually customers in '
                    'public.stripe_events_unresolved)' end
order by row;

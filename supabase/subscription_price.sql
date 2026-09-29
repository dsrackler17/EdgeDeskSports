-- ===========================================================================
-- EdgeDesk — what a reader's OWN subscription costs, as Stripe last said.
--
-- WHY THIS EXISTS. The standard price lives in lib/edgedesk_pricing.js, and it
-- is what a NEW subscriber is sold: $49.99 a month. A subscription that began
-- on an earlier price keeps that price until it is moved in Stripe, so the
-- Settings > Subscription card cannot tell such a reader "you will be charged
-- $49.99 on this date" from the standard price alone — the figure has to come
-- from Stripe's own description of THEIR subscription.
--
-- That description is already here. Every customer.subscription.created and
-- .updated delivery is kept whole in public.stripe_events (stripe_webhook.sql),
-- keyed to its subscription id whether or not the webhook could name the
-- customer when it arrived. This file reads the latest one for the caller's own
-- subscription; nothing new is stored, the webhook does not change, and a
-- subscription moved to a new price in Stripe corrects itself on the
-- customer.subscription.updated that the move sends.
--
-- WHAT IT IS NOT. It is not an entitlement. Access is decided by status and
-- period end alone (pgEntitled() in app.html, community_is_entitled() in the
-- database) and a price never grants or removes it — a subscriber on any price
-- is a subscriber. It is display only, and app.html falls back to the standard
-- price when this function is absent, errors, or has nothing on file.
--
-- Run AFTER billing.sql and stripe_webhook.sql. Idempotent, additive, ends in a
-- report: rows 1-4 should say ok.
-- ===========================================================================

do $guard$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'public.subscriptions does not exist. Run supabase/billing.sql first.';
  end if;
  if to_regclass('public.stripe_events') is null then
    raise exception 'public.stripe_events does not exist. Run supabase/stripe_webhook.sql first — '
                    'the price is read from the deliveries it records.';
  end if;
end
$guard$;

-- The lookup is "latest subscription event for this subscription id".
create index if not exists stripe_events_subscription_recent
  on public.stripe_events (subscription_id, stripe_created desc)
  where subscription_id is not null;

-- ── the caller's own price ─────────────────────────────────────────────────
-- SECURITY DEFINER because no client role may read stripe_events at all (it
-- holds every customer's payloads). The function answers exactly one question,
-- about exactly one subscription — the one on the caller's own row, found by
-- auth.uid() — and returns the price and nothing else from the payload.
--
-- ONE ITEM OR NOTHING. A subscription with several items has no single monthly
-- figure to show, so it returns no row and the card keeps the standard price
-- rather than showing one item's amount as the whole bill.
create or replace function public.my_subscription_price()
returns table (
  price_id         text,
  product_id       text,
  unit_amount      integer,
  currency         text,
  billing_interval text,
  interval_count   integer,
  livemode         boolean,
  observed_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select x.p ->> 'id',
         coalesce(x.p -> 'product' ->> 'id', x.p ->> 'product'),
         case when (x.p ->> 'unit_amount') ~ '^[0-9]{1,9}$' then (x.p ->> 'unit_amount')::integer end,
         lower(x.p ->> 'currency'),
         x.p -> 'recurring' ->> 'interval',
         case when (x.p -> 'recurring' ->> 'interval_count') ~ '^[0-9]{1,4}$'
              then (x.p -> 'recurring' ->> 'interval_count')::integer end,
         case when ev.payload ->> 'livemode' in ('true', 'false') then (ev.payload ->> 'livemode')::boolean end,
         ev.stripe_created
    from public.subscriptions s
    cross join lateral (
      select e.payload, e.stripe_created
        from public.stripe_events e
       where e.subscription_id = s.stripe_subscription_id
         and e.type in ('customer.subscription.created', 'customer.subscription.updated')
       order by e.stripe_created desc nulls last, e.created_at desc
       limit 1
    ) ev
    cross join lateral (
      -- nested CASE, because only CASE promises not to evaluate the length of
      -- something that is not an array
      select case when jsonb_typeof(ev.payload -> 'data' -> 'object' -> 'items' -> 'data') = 'array'
                  then case when jsonb_array_length(ev.payload -> 'data' -> 'object' -> 'items' -> 'data') = 1
                            then ev.payload -> 'data' -> 'object' -> 'items' -> 'data' -> 0 -> 'price' end
             end as p
    ) x
   where s.user_id = auth.uid()
     and s.stripe_subscription_id is not null
     and jsonb_typeof(x.p) = 'object'
   limit 1;
$$;

revoke all on function public.my_subscription_price() from public, anon;
grant execute on function public.my_subscription_price() to authenticated;

comment on function public.my_subscription_price() is
  'The caller''s own subscription price, from the latest customer.subscription.* '
  'event Stripe delivered for it. Display only — never an entitlement. Empty when '
  'nothing is on file; app.html then shows the standard price from '
  'lib/edgedesk_pricing.js.';

notify pgrst, 'reload schema';

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'my_subscription_price() exists and is security definer' as check,
       case when (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'my_subscription_price')
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'a signed-in reader may call it; an anonymous visitor may not',
       case when has_function_privilege('authenticated', 'public.my_subscription_price()', 'execute')
             and not has_function_privilege('anon', 'public.my_subscription_price()', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the ledger is still closed to every client role',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'public' and table_name = 'stripe_events'
                                and grantee in ('anon', 'authenticated'))
            then 'ok' else 'CHECK THIS' end
-- THE PRICE MOVE, FOR THE RECORD. Every Stripe-backed subscription that still
-- has access, by the monthly amount Stripe last reported for it. After a price
-- change this is where to see who is still on the old figure; it moves on its
-- own as each subscription is updated in Stripe.
union all select 4, 'live subscriptions by the price Stripe last reported',
       'ok (' || coalesce((
         select string_agg(label || ' ×' || n::text, ', ' order by n desc, label)
           from (
             select coalesce(
                      case when x.p ->> 'unit_amount' ~ '^[0-9]{1,9}$'
                           then '$' || to_char((x.p ->> 'unit_amount')::numeric / 100, 'FM999990.00')
                                || ' ' || upper(coalesce(x.p ->> 'currency', '?'))
                                || '/' || coalesce(x.p -> 'recurring' ->> 'interval', '?') end,
                      'no single price on file') as label,
                    count(*) as n
               from public.subscriptions s
               left join lateral (
                 select e.payload
                   from public.stripe_events e
                  where e.subscription_id = s.stripe_subscription_id
                    and e.type in ('customer.subscription.created', 'customer.subscription.updated')
                  order by e.stripe_created desc nulls last, e.created_at desc
                  limit 1
               ) ev on true
               left join lateral (
                 select case when jsonb_typeof(ev.payload -> 'data' -> 'object' -> 'items' -> 'data') = 'array'
                             then case when jsonb_array_length(ev.payload -> 'data' -> 'object' -> 'items' -> 'data') = 1
                                       then ev.payload -> 'data' -> 'object' -> 'items' -> 'data' -> 0 -> 'price' end
                        end as p
               ) x on true
              where s.stripe_subscription_id is not null
                and s.status in ('active', 'trialing', 'past_due')
              group by 1
           ) t), 'none') || ')'
order by row;

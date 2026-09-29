-- ===========================================================================
-- EdgeDesk — supabase/subscription_price.sql, attacked on a real PostgreSQL.
--
-- The price change this exists for: the standard price is now $49.99, and a
-- subscription begun on an earlier price keeps that price until it is moved in
-- Stripe. The Settings card must say what THIS reader will actually be charged,
-- which only Stripe's own description of their subscription can tell it.
--
-- What must hold:
--   * the reader sees their own subscription's price, and nobody else's;
--   * the latest event by STRIPE'S time wins, not the latest to arrive;
--   * an event the webhook could not yet attach to an account still counts,
--     because it is keyed to the subscription, not to a guess about the user;
--   * a subscription with several items shows nothing rather than one item;
--   * an anonymous visitor cannot call it at all;
--   * and none of it is an entitlement: the ledger stays closed to clients.
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, '');
  end if;
end; $$;

-- a customer.subscription.* payload with the given items, the way Stripe sends it
create or replace function pg_temp.sub_evt(p_sub text, p_items jsonb, p_livemode boolean default true)
returns jsonb language sql as $$
  select jsonb_build_object('object', 'event', 'livemode', p_livemode,
    'data', jsonb_build_object('object', jsonb_build_object(
      'id', p_sub, 'object', 'subscription', 'status', 'active',
      'items', jsonb_build_object('object', 'list', 'data', p_items))));
$$;
create or replace function pg_temp.item(p_price text, p_cents integer, p_interval text default 'month')
returns jsonb language sql as $$
  select jsonb_build_object('object', 'subscription_item', 'price', jsonb_build_object(
    'id', p_price, 'object', 'price', 'product', 'prod_edgedesk', 'currency', 'usd',
    'unit_amount', p_cents, 'type', 'recurring',
    'recurring', jsonb_build_object('interval', p_interval, 'interval_count', 1)));
$$;

do $test$
declare
  OLD_SUB  constant uuid := '51000000-0000-0000-0000-000000000001';  -- began on the retired price
  NEW_SUB  constant uuid := '51000000-0000-0000-0000-000000000002';  -- bought at $49.99
  MULTI    constant uuid := '51000000-0000-0000-0000-000000000003';  -- two items
  NOTHING  constant uuid := '51000000-0000-0000-0000-000000000004';  -- no event on file
  STRANGER constant uuid := '51000000-0000-0000-0000-000000000005';  -- no subscription at all
  r record; n integer; failed boolean;
begin
  insert into auth.users(id, email) values
    (OLD_SUB, 'old@x.co'), (NEW_SUB, 'new@x.co'), (MULTI, 'multi@x.co'),
    (NOTHING, 'nothing@x.co'), (STRANGER, 'stranger@x.co')
  on conflict do nothing;
  insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, current_period_end)
  values (OLD_SUB, 'active',   'cus_old',   'sub_old',   now() + interval '20 days'),
         (NEW_SUB, 'trialing', 'cus_new',   'sub_new',   now() + interval '7 days'),
         (MULTI,   'active',   'cus_multi', 'sub_multi', now() + interval '20 days'),
         (NOTHING, 'active',   'cus_none',  'sub_none',  now() + interval '20 days')
  on conflict (user_id) do nothing;

  -- the old subscriber, on $79.99 since before the change
  insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, resolved, applied, payload)
  values ('evt_sp_old_1', 'customer.subscription.created', now() - interval '60 days', 'cus_old', 'sub_old',
          OLD_SUB, true, true, pg_temp.sub_evt('sub_old', jsonb_build_array(pg_temp.item('price_old', 7999))));

  -- the new subscriber's created event arrived BEFORE their checkout, so the
  -- webhook could not name them: user_id null, unresolved. It is still theirs.
  insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, resolved, applied, payload)
  values ('evt_sp_new_1', 'customer.subscription.created', now() - interval '1 hour', 'cus_new', 'sub_new',
          null, false, false, pg_temp.sub_evt('sub_new', jsonb_build_array(pg_temp.item('price_new', 4999))));

  insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, resolved, applied, payload)
  values ('evt_sp_multi_1', 'customer.subscription.created', now() - interval '3 days', 'cus_multi', 'sub_multi',
          MULTI, true, true, pg_temp.sub_evt('sub_multi',
            jsonb_build_array(pg_temp.item('price_new', 4999), pg_temp.item('price_addon', 1000))));

  -- ── 1. EACH READER SEES THEIR OWN PRICE ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', OLD_SUB::text, false);
  set local role authenticated;
  select * into r from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('a subscriber who began on the retired price is shown THAT price, not the standard one',
    r.unit_amount = 7999 and r.currency = 'usd' and r.billing_interval = 'month' and r.interval_count = 1,
    row_to_json(r)::text);
  perform pg_temp.ok('and the product and price ids come with it',
    r.price_id = 'price_old' and r.product_id = 'prod_edgedesk' and r.livemode, row_to_json(r)::text);

  perform set_config('request.jwt.claim.sub', NEW_SUB::text, false);
  set local role authenticated;
  select * into r from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('a new subscriber is shown $49.99, from an event the webhook could not yet attach to them',
    r.unit_amount = 4999 and r.price_id = 'price_new', row_to_json(r)::text);

  -- ── 2. MOVED IN STRIPE, CORRECTED HERE ──────────────────────────────────
  insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, resolved, applied, payload)
  values ('evt_sp_old_2', 'customer.subscription.updated', now() - interval '1 day', 'cus_old', 'sub_old',
          OLD_SUB, true, true, pg_temp.sub_evt('sub_old', jsonb_build_array(pg_temp.item('price_new', 4999))));
  perform set_config('request.jwt.claim.sub', OLD_SUB::text, false);
  set local role authenticated;
  select * into r from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('once Stripe moves them to $49.99, the update that move sends is what they see',
    r.unit_amount = 4999 and r.price_id = 'price_new', row_to_json(r)::text);

  -- a STALE event delivered late (arrives now, but Stripe made it 30 days ago)
  insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, resolved, applied, payload)
  values ('evt_sp_old_late', 'customer.subscription.updated', now() - interval '30 days', 'cus_old', 'sub_old',
          OLD_SUB, true, false, pg_temp.sub_evt('sub_old', jsonb_build_array(pg_temp.item('price_old', 7999))));
  perform set_config('request.jwt.claim.sub', OLD_SUB::text, false);
  set local role authenticated;
  select * into r from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('a late-delivered older event does not put the old price back — Stripe''s time decides',
    r.unit_amount = 4999, row_to_json(r)::text);

  -- ── 3. NOTHING RATHER THAN SOMETHING WRONG ──────────────────────────────
  perform set_config('request.jwt.claim.sub', MULTI::text, false);
  set local role authenticated;
  select count(*) into n from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('a subscription with two items shows no single figure', n = 0, n::text);

  perform set_config('request.jwt.claim.sub', NOTHING::text, false);
  set local role authenticated;
  select count(*) into n from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('no event on file, no row — the card keeps the standard price', n = 0, n::text);

  perform set_config('request.jwt.claim.sub', STRANGER::text, false);
  set local role authenticated;
  select count(*) into n from public.my_subscription_price();
  reset role;
  perform pg_temp.ok('an account with no subscription learns nothing about anybody', n = 0, n::text);

  -- ── 4. THE DOORS ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', '', false);
  failed := false;
  begin
    set local role anon;
    perform * from public.my_subscription_price();
    reset role;
  exception when insufficient_privilege then failed := true; reset role;
  end;
  perform pg_temp.ok('an anonymous visitor cannot call it', failed);

  failed := false;
  perform set_config('request.jwt.claim.sub', NEW_SUB::text, false);
  begin
    set local role authenticated;
    perform count(*) from public.stripe_events;
    reset role;
  exception when insufficient_privilege then failed := true; reset role;
  end;
  perform pg_temp.ok('and the ledger it reads is still closed to a signed-in reader', failed);

  -- ── 5. IT IS NOT AN ENTITLEMENT ─────────────────────────────────────────
  -- A price never grants or removes access. The subscriber still on the old
  -- figure is exactly as entitled as the one on the new, by the shipped rule.
  if to_regprocedure('public.community_is_entitled(uuid)') is not null then
    perform pg_temp.ok('a subscriber on either price is entitled by the database''s own rule',
      public.community_is_entitled(OLD_SUB) and public.community_is_entitled(NEW_SUB));
  else
    raise notice 'ok   (community_is_entitled not installed; entitlement cross-check skipped)';
  end if;
end
$test$;

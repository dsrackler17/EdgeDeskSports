-- ===========================================================================
-- EdgeDesk — supabase/referral_codes.sql, attacked on a real PostgreSQL.
--
-- This report is read periodically and believed. Everything below is a way it
-- could report a number that is not true — a subscription dropped off it, a
-- sale credited to the wrong code, an invoice counted twice, revenue that
-- arrived and is not on any line — plus the usual question this repository
-- asks of every table: can a browser see it.
--
-- THE INVARIANT WORTH MORE THAN ANY SINGLE ASSERTION: the report's total is the
-- ledger's total, and every subscription is on it exactly once. A report that
-- silently drops a row is worse than no report, because it is believed.
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

do $test$
declare
  A uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  B uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  C uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  D uuid := 'aaaaaaaa-0000-0000-0000-000000000004';
  E uuid := 'aaaaaaaa-0000-0000-0000-000000000005';
  F uuid := 'aaaaaaaa-0000-0000-0000-000000000006';
  n integer; m integer; failed boolean; t text;
begin
  insert into auth.users(id,email) values
    (A,'a@x.co'),(B,'b@x.co'),(C,'c@x.co'),(D,'d@x.co'),(E,'e@x.co'),(F,'f@x.co')
    on conflict do nothing;

  insert into public.referral_codes(code, partner_name, stripe_promotion_code_id, stripe_coupon_id)
  values ('PARTNERA','Partner A','promo_a','cpn_shared'),
         ('PARTNERB','Partner B','promo_b','cpn_shared')
    on conflict (code) do nothing;

  -- ── 1. NOTHING HERE IS REACHABLE FROM A BROWSER ──────────────────────────
  -- The report names customers, their email addresses and what they paid.
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', A::text, false);
    set local role authenticated;
    perform 1 from public.referral_codes;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('a signed-in browser cannot read the code table', failed);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', A::text, false);
    set local role authenticated;
    perform 1 from public.referral_code_report;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('nor the report', failed);

  failed := false;
  begin
    set local role authenticated;
    perform 1 from public.referral_signups;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('nor the per-customer detail behind it', failed);

  failed := false;
  begin
    set local role anon;
    perform 1 from public.referral_code_report;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('and neither can a logged-out one', failed);

  -- A code is a commercial term. A customer inventing one would be inventing
  -- a partner to pay.
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', A::text, false);
    set local role authenticated;
    insert into public.referral_codes(code, partner_name) values ('MINE','me');
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('and nobody can add themselves a code from a browser', failed);

  -- THE ONE THAT MATTERS MOST, restated after this file added columns to the
  -- table that IS the product.
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', A::text, false);
    set local role authenticated;
    update public.subscriptions set referral_code = 'PARTNERA' where user_id = A;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('a browser still cannot write subscriptions, attribution columns included', failed);

  -- ── 2. ONE CODE IS ONE LINE, WHATEVER CASE IT ARRIVES IN ─────────────────
  -- Stripe redeems a promotion code case-insensitively, so the same code
  -- reaches the webhook as BETDESK, betdesk and BetDesk. Three lines in a
  -- partner report is three arguments.
  insert into public.subscriptions
    (user_id,status,current_period_end,stripe_customer_id,stripe_subscription_id,
     referral_code,referred_partner,stripe_promotion_code_id,stripe_coupon_id,referral_source)
  values
    (A,'active',   now()+interval '20 days','cus_a','sub_a','PARTNERA','Partner A','promo_a','cpn_shared','checkout_session:inline'),
    (B,'canceled', now()-interval '2 days', 'cus_b','sub_b','partnera','Partner A','promo_a','cpn_shared','checkout_session:stripe_lookup'),
    -- the SECOND code on the SAME coupon: the discriminator has to be the
    -- promotion code, or these two partners share one line and one invoice
    (C,'active',   now()+interval '9 days', 'cus_c','sub_c','PARTNERB','Partner B','promo_b','cpn_shared','checkout_session:inline'),
    -- no code at all
    (D,'active',   now()+interval '5 days', 'cus_d','sub_d', null,null,null,null,null),
    -- a discount the webhook saw but could not name
    (E,'trialing', now()+interval '3 days', 'cus_e','sub_e', null,null,'promo_unknown',null,'checkout_session:unnamed_discount'),
    -- lapsed: status still says active, the period end says otherwise
    (F,'active',   now()-interval '1 day',  'cus_f','sub_f','PARTNERA','Partner A','promo_a','cpn_shared','checkout_session:inline');

  select count(*) into n from public.referral_code_report where code = 'PARTNERA';
  perform pg_temp.ok('PARTNERA and partnera are one line, not two', n = 1);

  select signups, still_active into n, m from public.referral_code_report where code = 'PARTNERA';
  perform pg_temp.ok('and it counts all three of its signups', n = 3, 'got ' || n::text);
  -- A is live; B cancelled; F is marked active with a period end in the past,
  -- which pgEntitled() reads as lapsed and so must this.
  perform pg_temp.ok('but only the one that still has access is still_active', m = 1, 'got ' || m::text);

  select count(*) into n from public.referral_code_report where code = 'PARTNERB';
  perform pg_temp.ok('two codes sharing one coupon stay two lines', n = 1);
  select signups into n from public.referral_code_report where code = 'PARTNERB';
  perform pg_temp.ok('each with its own signups', n = 1);

  -- ── 3. NOTHING IS DROPPED AND NOTHING IS GUESSED ─────────────────────────
  select count(*) into n from public.referral_signups;
  select count(*) into m from public.subscriptions;
  perform pg_temp.ok('every subscription is on the report exactly once', n = m,
    n::text || ' rows for ' || m::text || ' subscriptions');

  -- Scoped to this suite's own fixtures on purpose: the billing suite that ran
  -- before it leaves rows of its own on the table, and an assertion that only
  -- holds on an empty database is an assertion that will stop holding.
  select code into t from public.referral_signups where user_id = D;
  perform pg_temp.ok('a sale with no code reports as unattributed rather than vanishing',
    t = '(unattributed)', 'got ' || coalesce(t,'null'));

  select code into t from public.referral_signups where user_id = E;
  perform pg_temp.ok('and a discount that could not be named gets its OWN line, never the unattributed pile',
    t = '(discount, code not resolved)', 'got ' || coalesce(t,'null'));
  perform pg_temp.ok('so no code is ever credited with a sale it cannot be shown to have made',
    (select count(*) from public.referral_code_report where code not like '(%')
    = (select count(distinct upper(referral_code)) from public.subscriptions where referral_code is not null));

  -- ── 4. MONEY ─────────────────────────────────────────────────────────────
  insert into public.stripe_events(id,type,stripe_created,payload) values
    -- one invoice, delivered twice: Stripe retries, and a retry is not revenue
    ('evt_p1','invoice.payment_succeeded', now()-interval '5 days',
      '{"id":"in_1","subscription":"sub_a","customer":"cus_a","amount_paid":7999,"currency":"usd"}'),
    ('evt_p1_retry','invoice.payment_succeeded', now()-interval '5 days',
      '{"id":"in_1","subscription":"sub_a","customer":"cus_a","amount_paid":7999,"currency":"usd"}'),
    -- the newer API shape, where the subscription moved under parent
    ('evt_p2','invoice.payment_succeeded', now()-interval '4 days',
      '{"id":"in_2","parent":{"subscription_details":{"subscription":"sub_b"}},"customer":"cus_b","amount_paid":5999,"currency":"usd"}'),
    -- expanded objects rather than ids
    ('evt_p3','invoice.payment_succeeded', now()-interval '3 days',
      '{"id":"in_3","subscription":{"id":"sub_c"},"customer":{"id":"cus_c"},"amount_paid":7999,"currency":"usd"}'),
    -- a customer nobody could resolve to an account: real money, no row
    ('evt_p4','invoice.payment_succeeded', now()-interval '2 days',
      '{"id":"in_4","subscription":"sub_ghost","customer":"cus_ghost","amount_paid":4200,"currency":"usd"}'),
    -- the $0 invoice a free trial produces
    ('evt_p5','invoice.payment_succeeded', now()-interval '1 day',
      '{"id":"in_5","subscription":"sub_e","customer":"cus_e","amount_paid":0,"currency":"usd"}'),
    -- a refund, which this webhook deliberately does not handle
    ('evt_r1','charge.refunded', now(),
      '{"id":"ch_1","amount_refunded":7999,"currency":"usd"}');

  select revenue_cents into n from public.referral_code_report where code = 'PARTNERA';
  perform pg_temp.ok('a redelivered invoice is counted once, not twice', n = 13998,
    'got ' || n::text || ' cents (7999 + 5999 expected)');

  select paid_invoices into n from public.referral_code_report where code = 'PARTNERA';
  perform pg_temp.ok('and that is two invoices, not three', n = 2, 'got ' || n::text);

  select revenue_cents into n from public.referral_code_report where code = 'PARTNERB';
  perform pg_temp.ok('an invoice sent as expanded objects still finds its subscription', n = 7999);

  perform pg_temp.ok('a $0 trial invoice is not a payment',
    (select paid_invoices from public.referral_signups where user_id = E) = 0);
  perform pg_temp.ok('and leaves no payment date on a customer who has never paid',
    (select last_payment_at from public.referral_signups where user_id = E) is null);

  -- MONEY THAT ARRIVED AND BELONGS TO NOBODY. Dropping it would make the
  -- report's total quietly smaller than the bank's.
  select revenue_cents into n from public.referral_code_report
   where code = '(revenue not matched to any subscription)';
  perform pg_temp.ok('revenue matching no subscription is reported, not dropped', n = 4200);

  select coalesce(sum(revenue_cents),0) into n from public.referral_code_report;
  select coalesce(sum(amount_paid_cents),0) into m from public.referral_invoice_payments;
  perform pg_temp.ok('THE INVARIANT: the report totals exactly what the ledger holds', n = m,
    'report ' || n::text || ' vs ledger ' || m::text);

  perform pg_temp.ok('a refund is not in the revenue view at all, so the figure is GROSS and says so',
    (select count(*) from public.referral_invoice_payments where invoice_id = 'ch_1') = 0);

  -- Only where every invoice is in one currency whose minor unit is 1/100.
  update public.stripe_events set payload = jsonb_set(payload,'{currency}','"jpy"')
   where id = 'evt_p3';
  perform pg_temp.ok('a mixed or non-decimal currency refuses to show a dollar figure rather than being 100x wrong',
    (select revenue_usd from public.referral_code_report where code = 'PARTNERB') is null);
  perform pg_temp.ok('though the cents and the currency are both still reported',
    (select currencies from public.referral_code_report where code = 'PARTNERB') = 'JPY');
  update public.stripe_events set payload = jsonb_set(payload,'{currency}','"usd"')
   where id = 'evt_p3';

  -- ── 5. THE CODE TABLE IS CONFIGURATION, AND OUTLIVES THE CODE ────────────
  update public.referral_codes set retired_at = now() where code = 'PARTNERB';
  select signups into n from public.referral_code_report where code = 'PARTNERB';
  perform pg_temp.ok('retiring a code keeps every sale it made on the report', n = 1);

  -- Renaming a partner must not rewrite what an old sale says it was sold
  -- under; the snapshot on the row is what protects that.
  update public.referral_codes set partner_name = 'Partner A, renamed' where code = 'PARTNERA';
  select referred_partner into t from public.subscriptions where user_id = A;
  perform pg_temp.ok('renaming a partner does not rewrite the snapshot on an old sale',
    t = 'Partner A', 'got ' || coalesce(t,'null'));
  select partner_name into t from public.referral_code_report where code = 'PARTNERA';
  perform pg_temp.ok('while the report shows the current name', t = 'Partner A, renamed',
    'got ' || coalesce(t,'null'));

  failed := false;
  begin
    insert into public.referral_codes(code, partner_name) values ('partnera','somebody else');
  exception when unique_violation then failed := true; end;
  perform pg_temp.ok('the same code cannot be entered twice in two cases', failed);

  -- ── 6. THE WEBHOOK'S OWN WRITE, AS IT MAKES IT ───────────────────────────
  -- PATCH subscriptions?user_id=eq.X&referral_code=is.null — first attribution
  -- wins, enforced by the filter so two deliveries racing cannot both land.
  update public.subscriptions
     set referral_code='PARTNERB', referred_partner='Partner B', referral_source='checkout_session:inline'
   where user_id = A and referral_code is null;
  select referral_code into t from public.subscriptions where user_id = A;
  perform pg_temp.ok('a second event cannot move a sale to another code', t = 'PARTNERA');

  -- but a row carrying an UNNAMED discount is still open to being named
  update public.subscriptions
     set referral_code='PARTNERA', referred_partner='Partner A', referral_source='checkout_session:referral_codes'
   where user_id = E and referral_code is null;
  select referral_code into t from public.subscriptions where user_id = E;
  perform pg_temp.ok('while an unnamed discount can still be upgraded once the code is known',
    t = 'PARTNERA');
  select count(*) into n from public.referral_signups
   where user_id = E and code = '(discount, code not resolved)';
  perform pg_temp.ok('and it leaves that bucket when it is', n = 0);

  raise notice 'ok   suite complete';
end
$test$;

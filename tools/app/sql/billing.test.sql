-- ===========================================================================
-- EdgeDesk — supabase/billing.sql, attacked on a real PostgreSQL.
--
-- These three tables are the signup path's floor. `billing_consents` is the
-- load-bearing one: confirmArl() refuses to send anyone to Stripe if the
-- consent cannot be stored, so a table that will not accept the write does not
-- degrade the funnel, it ENDS it — with the account already created and the
-- customer believing signup failed. That is not hypothetical; it is what
-- happened.
--
-- The security property worth more than any of it: a browser must never be
-- able to write `subscriptions`, because that row IS the product.
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
  ME     constant uuid := '22222222-2222-2222-2222-222222222222';
  OTHER  constant uuid := '33333333-3333-3333-3333-333333333333';
  n integer; failed boolean;
begin
  insert into auth.users(id,email) values (ME,'me@x.co'),(OTHER,'other@x.co') on conflict do nothing;

  -- ── 1. THE WRITE THE CHECKOUT SCREEN ACTUALLY MAKES ──────────────────────
  -- Every column index.html sends, in one insert. If this fails, every signup
  -- stops at the trial screen.
  perform set_config('request.jwt.claim.sub', ME::text, false);
  set local role authenticated;
  insert into public.billing_consents
    (user_id,user_email,price_display,billing_period,trial_days,offer_text,consent_version,
     user_agent,ref,ref_last,utm_source,utm_medium,utm_campaign,utm_content,landing_page,
     referrer_host,first_seen_at,organic_first_seen_at)
    values (ME,'me@x.co','$79.99','month',7,'the exact terms shown','arl-2026-08-v6-trial7',
     'Mozilla/5.0','partnera',null,'x','y','z','w','/','google.com',now(),now());
  reset role;
  select count(*) into n from public.billing_consents where user_id = ME;
  perform pg_temp.ok('the exact consent write the checkout screen makes succeeds', n = 1);

  -- the referrals upsert, posted with on_conflict=user_id
  perform set_config('request.jwt.claim.sub', ME::text, false);
  set local role authenticated;
  insert into public.referrals(user_id,user_email,ref,utm_source)
    values (ME,'me@x.co','partnera','x')
    on conflict (user_id) do update set ref = excluded.ref;
  insert into public.referrals(user_id,user_email,ref) values (ME,'me@x.co','partnerb')
    on conflict (user_id) do update set ref = excluded.ref;
  reset role;
  select count(*) into n from public.referrals where user_id = ME;
  perform pg_temp.ok('the referrals upsert works twice and stays one row', n = 1);

  -- ── 2. NOBODY WRITES A CONSENT UNDER SOMEBODY ELSE'S NAME ────────────────
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', ME::text, false);
    set local role authenticated;
    insert into public.billing_consents(user_id) values (OTHER);
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('a consent cannot be filed under another account', failed);

  -- ── 3. A CONSENT IS EVIDENCE ─────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', ME::text, false);
  set local role authenticated;
  begin
    update public.billing_consents set offer_text = 'rewritten' where user_id = ME;
  exception when insufficient_privilege then null; end;
  reset role;
  select count(*) into n from public.billing_consents where user_id = ME and offer_text = 'rewritten';
  perform pg_temp.ok('and cannot be rewritten after the fact, even by its own author', n = 0);

  perform set_config('request.jwt.claim.sub', ME::text, false);
  set local role authenticated;
  begin
    delete from public.billing_consents where user_id = ME;
  exception when insufficient_privilege then null; end;
  reset role;
  select count(*) into n from public.billing_consents where user_id = ME;
  perform pg_temp.ok('nor deleted', n = 1);

  -- ── 4. READS ARE YOUR OWN ────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', OTHER::text, false);
  set local role authenticated;
  select count(*) into n from public.billing_consents;
  reset role;
  perform pg_temp.ok('another account sees none of your consents', n = 0);

  -- ── 5. THE ONE THAT MATTERS MOST ─────────────────────────────────────────
  -- The subscriptions row IS the product. A browser that could write it could
  -- grant itself the terminal.
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', ME::text, false);
    set local role authenticated;
    insert into public.subscriptions(user_id,status) values (ME,'active');
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('a signed-in browser CANNOT grant itself a subscription', failed);

  -- and cannot upgrade one the webhook wrote
  insert into public.subscriptions(user_id,status) values (ME,'canceled')
    on conflict (user_id) do update set status = 'canceled';
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', ME::text, false);
    set local role authenticated;
    update public.subscriptions set status = 'active' where user_id = ME;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  select count(*) into n from public.subscriptions where user_id = ME and status = 'canceled';
  perform pg_temp.ok('nor upgrade the one the webhook wrote', failed and n = 1);

  -- but it can read its own, which is what the paywall needs
  perform set_config('request.jwt.claim.sub', ME::text, false);
  set local role authenticated;
  select count(*) into n from public.subscriptions where user_id = ME;
  reset role;
  perform pg_temp.ok('while still reading its own row, which is what the paywall needs', n = 1);

  perform set_config('request.jwt.claim.sub', OTHER::text, false);
  set local role authenticated;
  select count(*) into n from public.subscriptions;
  reset role;
  perform pg_temp.ok('and never anybody else''s', n = 0);

  -- ── 6. ANON IS NOWHERE NEAR ANY OF IT ────────────────────────────────────
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', '', false);
    set local role anon;
    perform 1 from public.billing_consents;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('anon cannot read billing_consents at all', failed);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', '', false);
    set local role anon;
    perform 1 from public.subscriptions;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('nor subscriptions', failed);

  -- ── 7. THE WEBHOOK'S LEDGER ──────────────────────────────────────────────
  -- Nothing here may be reachable from a browser: it holds raw Stripe payloads
  -- and it is the thing that decides who has paid.
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', ME::text, false);
    set local role authenticated;
    perform 1 from public.stripe_events;
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('a signed-in browser cannot read the Stripe event ledger', failed);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', ME::text, false);
    set local role authenticated;
    insert into public.stripe_events(id,type) values ('evt_forged','customer.subscription.updated');
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('nor forge a delivery into it', failed);

  -- A retry lands on the same primary key rather than writing twice.
  insert into public.stripe_events(id,type,stripe_created)
    values ('evt_a','customer.subscription.updated', now())
    on conflict (id) do nothing;
  insert into public.stripe_events(id,type,stripe_created)
    values ('evt_a','customer.subscription.updated', now())
    on conflict (id) do nothing;
  select count(*) into n from public.stripe_events where id = 'evt_a';
  perform pg_temp.ok('a redelivered event is one row, not two', n = 1);

  -- ── 8. NAMING A CUSTOMER BY EMAIL ────────────────────────────────────────
  -- The webhook's last resort. It must never match an UNCONFIRMED account:
  -- anybody can sign up as somebody else's address, and matching one would
  -- hand that person's subscription to a stranger.
  update auth.users set email_confirmed_at = now() where id = ME;
  perform pg_temp.ok('a confirmed account is found by email',
    public.stripe_user_by_email('me@x.co') = ME);
  perform pg_temp.ok('and the match is case- and whitespace-insensitive',
    public.stripe_user_by_email('  ME@X.CO ') = ME);

  update auth.users set email_confirmed_at = null where id = OTHER;
  perform pg_temp.ok('an UNCONFIRMED account is never matched — it is not proof of anything',
    public.stripe_user_by_email('other@x.co') is null);
  perform pg_temp.ok('an unknown address returns null rather than a guess',
    public.stripe_user_by_email('nobody@nowhere.co') is null);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', ME::text, false);
    set local role authenticated;
    perform public.stripe_user_by_email('me@x.co');
  exception when insufficient_privilege then failed := true; end;
  reset role;
  perform pg_temp.ok('and a browser cannot ask it whether an email has an account', failed);

  -- ── 9. THE ORDERING GUARD EXISTS ON THE ROW ──────────────────────────────
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='subscriptions'
     and column_name in ('last_event_at','last_event_id');
  perform pg_temp.ok('subscriptions carries the guard that stops an old event overwriting a new one', n = 2);

  raise notice 'ok   suite complete';
end
$test$;

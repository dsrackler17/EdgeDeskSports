-- =============================================================================
-- affiliate_connor — the first creator on the partner program: Connor.
--
-- THE DEAL
--   Customer: 10% off the first 3 paid months of the $49.99 monthly plan
--             (Stripe coupon "Connor 10% x 3", repeating, 3 months, applied
--             through Stripe promotion code CONNOR10 — first-time customers
--             only). The 7-day free trial is unchanged.
--   Connor:   20% of every payment those customers make (amount paid, less
--             tax) for 12 months from their first paid invoice, refunds and
--             disputes netted. A month's collections are paid by the 15th of
--             the second following month:
--               select * from public.affiliate_statement('connor', date '2026-11-01');
--
-- NO STRIPE ID IS IN THIS FILE, ON PURPOSE. The live promotion code id and the
-- test-mode one differ, and both modes deliver to this one project. The
-- checkout reads Connor's id from its env (CONNOR_PROMO_CODE_ID, next to
-- MONTHLY_PRICE_ID) and registers it on the campaign the first time it applies
-- it — the live id in stripe_promotion_code_id, the test id in
-- stripe_test_promotion_code_id, write-once — so attribution can match the
-- promotion code Stripe reports by id. Until then it matches the code
-- CONNOR10 itself, and the subscription's metadata.affiliate = 'connor'.
--
-- CHECKOUT ONLY. Connor is credited from the Stripe sale (the promotion code
-- on the subscription, or the checkout's metadata), never from a link click
-- alone: a ?ref=CONNOR10 click is counted, and the 30-day code the page keeps
-- is what carries the discount to checkout.
--
-- Connor has no EdgeDesk login (user_id is null), so no client role can read
-- a row of this: the service role and the affiliate admins' console only.
--
-- RUN ORDER. billing.sql, stripe_webhook.sql, referral_codes.sql, affiliates.sql,
-- then this file. Idempotent and additive: it creates Connor once, fills in
-- only what is still empty, and never changes a rate, a code or a switch an
-- admin has set since. Ends in a report; every row should say ok.
-- =============================================================================

do $guard$
begin
  if to_regclass('public.affiliate_campaigns') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'affiliate_accounts' and column_name = 'slug')
     or to_regprocedure('public.affiliate_statement(text, date, boolean)') is null then
    raise exception 'the partner program is missing or out of date. Run supabase/affiliates.sql first.';
  end if;
end
$guard$;

do $connor$
declare
  -- ==== THE VALUES THIS FILE IS ABOUT ====================================== --
  p_slug      text    := 'connor';
  p_name      text    := 'Connor';
  p_code      text    := 'CONNOR10';      -- the code people click (?ref=) and type at Stripe
  p_rate      numeric := 0.20;            -- of amount paid, less tax
  p_months    int     := 12;              -- from the customer's first paid invoice
  -- the customer's discount, described as Stripe holds it (coupon "Connor 10% x 3")
  p_pct       numeric := 10;
  p_disc_mo   int     := 3;
  -- ======================================================================== --
  v_aff uuid;
begin
  -- the creator. The account code is the campaign code, so CONNOR10 can never
  -- belong to anybody else; if the campaign is ever switched off, a typed
  -- CONNOR10 still credits Connor at the same 20% (affiliates.sql base code).
  insert into public.affiliate_accounts (code, slug, display_name, status, commission_rate, attribution_mode, approved_at, admin_note)
  values (p_code, p_slug, p_name, 'active', p_rate, 'checkout_only', now(),
          'Seeded by supabase/affiliate_connor.sql: ' || (p_pct)::text || '% x ' || p_disc_mo || ' months for the customer, '
          || round(p_rate * 100)::text || '% for ' || p_months || ' months for the creator.')
  on conflict do nothing;
  select id into v_aff from public.affiliate_accounts where upper(code) = p_code;
  if v_aff is null then raise exception 'could not create or find the % account', p_code; end if;
  -- fill only what is still empty (a re-run never overrides an admin's edit)
  update public.affiliate_accounts
     set slug = coalesce(slug, p_slug),
         display_name = coalesce(display_name, p_name),
         commission_rate = coalesce(commission_rate, p_rate)
   where id = v_aff;

  -- the campaign: Connor's code, the customer's discount and Connor's terms
  if not exists (select 1 from public.affiliate_campaigns where upper(code) = p_code) then
    insert into public.affiliate_campaigns (affiliate_id, code, name, discount_type, discount_amount, discount_duration,
      discount_duration_months, stripe_promo_code, commission_rate, commission_type, commission_duration_months,
      starts_at, active, admin_note)
    values (v_aff, p_code, p_name || ' ' || (p_pct)::text || '% x ' || p_disc_mo, 'percent', p_pct, 'repeating', p_disc_mo,
      p_code, p_rate, 'recurring', p_months, now() - interval '1 minute', true,
      'Stripe promotion code ids come from the checkout''s env (CONNOR_PROMO_CODE_ID), never from a file.');
  end if;
end
$connor$;

-- ── report ───────────────────────────────────────────────────────────────────
select 1 as step, 'Connor is a creator with the slug connor and the code CONNOR10' as item,
  case when exists (select 1 from public.affiliate_accounts where slug = 'connor' and upper(code) = 'CONNOR10')
       then 'ok' else 'CHECK THIS' end as outcome
union all
select 2, 'the campaign: 20% recurring for 12 months, 10% x 3 for the customer, in force',
  case when exists (select 1 from public.affiliates where slug = 'connor' and promo_code = 'CONNOR10'
                      and commission_rate = 0.20 and earning_months = 12 and active)
        and exists (select 1 from public.affiliate_campaigns where upper(code) = 'CONNOR10' and discount_type = 'percent'
                      and discount_amount = 10 and discount_duration = 'repeating' and discount_duration_months = 3)
       then 'ok' else 'CHECK THIS — the campaign was edited or switched off since; read public.affiliates' end
union all
select 3, 'credited only from the Stripe sale, never from a link click alone',
  case when exists (select 1 from public.affiliate_accounts where slug = 'connor' and attribution_mode = 'checkout_only')
       then 'ok' else 'CHECK THIS' end
union all
select 4, 'no client role can read Connor''s rows (no login on the account; the view is service-role only)',
  case when exists (select 1 from public.affiliate_accounts where slug = 'connor' and user_id is null)
        and not has_table_privilege('authenticated', 'public.affiliates', 'select')
        and not has_table_privilege('anon', 'public.affiliates', 'select') then 'ok'
       when exists (select 1 from public.affiliate_accounts where slug = 'connor' and user_id is not null)
       then 'ok — linked to a login, which can read its own account row and nothing else' else 'CHECK THIS' end
union all
select 5, 'Stripe promotion code ids registered by the checkout (live / test)',
  'ok (' || coalesce((select case when stripe_promotion_code_id is null then 'live: not yet' else 'live: set' end || ', '
                            || case when stripe_test_promotion_code_id is null then 'test: not yet' else 'test: set' end
                       from public.affiliate_campaigns where upper(code) = 'CONNOR10'), 'none') || ')'
union all
select 6, 'the code report (referral_codes.sql) names CONNOR10 as Connor''s',
  case when exists (select 1 from public.referral_codes where code = 'CONNOR10' and retired_at is null) then 'ok'
       else 'CHECK THIS — run supabase/referral_codes.sql (its codes block holds CONNOR10)' end
order by 1;

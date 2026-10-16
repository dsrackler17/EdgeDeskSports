#!/usr/bin/env node
/* ===========================================================================
   CONNOR'S CODE, END TO END, THROUGH THE SHIPPED FUNCTIONS AND THE REAL SQL.

   The same world as billing_flow.test.js — the SHIPPED create_checkout_session
   and stripe_webhook, loaded whole under a Deno shim, over a PostgREST / Auth
   stand-in on a REAL PostgreSQL with the shipped migrations plus
   affiliates.sql and affiliate_connor.sql — and a fake Stripe that turns the
   session's promotion code into the subscription's Discount and bills it on a
   clock of its own, period by period, the way a Stripe test clock does:

     a visitor with ?ref=CONNOR10 subscribes: the session carries discounts:
     [{promotion_code}] (never with allow_promotion_codes), metadata.affiliate
     = connor and the 7-day trial; the webhook's ledger attributes the account
     to Connor; the $0 trial invoice earns nothing; invoices 1-3 are $44.99
     and earn $9.00; invoice 4 is $49.99 and earns $10.00; a redelivered
     webhook books nothing twice; a refund and a dispute book negative rows
     capped at the commission; a returning customer gets neither the discount
     nor the attribution (asked of our ledger first, and of Stripe if the
     ledger never heard); the code is ignored on any price but MONTHLY_PRICE_ID,
     with MONTHLY_PRICE_ID unset, or when the env's promotion code is wrong.

   What this cannot prove is Stripe's own arithmetic for a repeating coupon
   that starts in a trial; tools/billing/affiliate_test_clock.js asks real
   Stripe (test mode) that question.

   Needs PostgreSQL (skips loudly without it). Run: node tools/billing/affiliate_flow.test.js
   =========================================================================== */
'use strict';
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');

const T = PG.kit('affiliate flow');
const chk = T.chk;

const OFFER = { kind: 'trial', price_cents: 4999, trial_days: 7, consent_version: 'arl-2026-09-v7-trial7' };
const PROMO = 'promo_1ConnorLiveFake';

(async () => {
  const w = H.world('affflow', {
    extraFiles: ['affiliates.sql', 'affiliate_connor.sql'],
    env: { MONTHLY_PRICE_ID: 'price_4999', CONNOR_PROMO_CODE_ID: PROMO },
  });
  if (w.skip) { console.log('SKIP | affiliate flow | ' + w.skip); process.exit(0); }
  const S = w.stripe;
  // Connor's promotion code, as created in the dashboard: CONNOR10 on the
  // coupon "Connor 10% x 3", first-time customers only, metadata affiliate=connor
  S.S.promos[PROMO] = { id: PROMO, object: 'promotion_code', code: 'CONNOR10', active: true, livemode: true,
    coupon: { id: 'coupon_connor', object: 'coupon', name: 'Connor 10% x 3', percent_off: 10, duration: 'repeating', duration_in_months: 3, valid: true },
    restrictions: { first_time_transaction: true }, metadata: { affiliate: 'connor' }, times_redeemed: 0 };
  S.S.prices.price_4999_alt = Object.assign({}, S.S.prices.price_4999, { id: 'price_4999_alt' });

  const deliverAll = async (events) => { const out = []; for (const e of events) out.push(await w.deliver(e)); return out; };
  const consent = (u) => w.db.sql("insert into public.billing_consents (user_id, user_email, price_display, billing_period, trial_days, consent_version) values (" +
    PG.lit(u.id) + ', ' + PG.lit(u.email) + ", '$49.99', 'month', 7, 'arl-2026-09-v7-trial7');");
  const svc = (sql) => w.db.service(sql);
  const commissions = (uid) => svc(`select coalesce(string_agg(kind || ':' || amount_cents, ',' order by id), '') from public.affiliate_commissions where user_id = ${PG.lit(uid)};`);
  const forInvoice = (inv) => svc(`select coalesce(string_agg(kind || ':' || amount_cents, ',' order by id), '') from public.affiliate_commissions where stripe_invoice_id = ${PG.lit(inv)};`);
  const attribution = (uid) => svc(`select coalesce((select a.source || '|' || ac.slug || '|' || a.term_rate || '|' || a.term_months
    from public.affiliate_attributions a join public.affiliate_accounts ac on ac.id = a.affiliate_id where a.user_id = ${PG.lit(uid)}), '');`);
  // the checkout as another deployment (other env) would answer it
  async function checkoutWith(envOverrides, body, token) {
    const fn = w.load('create_checkout_session', envOverrides);
    const req = new Request('https://fn.test/functions/v1/create_checkout_session', { method: 'POST',
      headers: { 'content-type': 'application/json', apikey: 'anon-key', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    const res = await fn(req);
    return { status: res.status, body: await res.json() };
  }
  const logged = (event, reason) => w.logs.some((l) => l.fn === 'create_checkout_session' && l.line.indexOf('"event":"' + event + '"') >= 0
    && (!reason || l.line.indexOf('"reason":"' + reason + '"') >= 0));

  try {
    /* ===================================================================== */
    /* 1. ?ref=CONNOR10 -> checkout -> trial -> four paid months              */
    /* ===================================================================== */
    const A = w.user('ana@example.com');
    consent(A);
    let r = await w.call('create_checkout_session', 'POST', Object.assign({ affiliate_code: 'connor10' }, OFFER), A.token);
    chk('checkout: the code is applied and the response says whose', r.status === 200 && r.body.ok && r.body.affiliate === 'connor', r.body);
    const csA = S.S.sessions[r.body.session_id];
    chk('the session carries Connor\'s promotion code as a discount', csA.discounts && csA.discounts[0].promotion_code === PROMO, csA.discounts);
    chk('and NOT allow_promotion_codes (Stripe refuses both)', !csA.allow_promotion_codes);
    chk('metadata.affiliate = connor on the session and the subscription',
      csA.metadata.affiliate === 'connor' && csA.subscription_data.metadata.affiliate === 'connor'
      && csA.subscription_data.metadata.affiliate_code === 'CONNOR10' && csA.subscription_data.metadata.supabase_user_id === A.id);
    chk('the 7-day trial is unchanged', csA.subscription_data.trial_period_days === '7' && csA.payment_method_collection === 'always');
    chk('the promotion code from the env was registered on Connor\'s campaign (live column)',
      svc(`select stripe_promotion_code_id || '|' || coalesce(stripe_test_promotion_code_id, '-') from public.affiliate_campaigns where code = 'CONNOR10';`) === PROMO + '|-');
    chk('nothing is attributed before Stripe reports a sale', attribution(A.id) === '');

    const done = S.complete(csA.id, { email: A.email });
    const subA = done.subscription;
    chk('Stripe put the discount on the subscription: 10% for 3 months from its start',
      subA.discount && subA.discount.promotion_code === PROMO && subA.discount.end === S.addMonths(subA.created, 3));
    let res = await deliverAll(done.events);
    chk('the webhook accepts the subscription and the checkout', res.every((x) => x.status === 200), res);
    chk('the account is attributed to Connor by the promotion code, on 20% for 12 months', attribution(A.id) === 'promo_code|connor|0.20|12', attribution(A.id));
    chk('the webhook named the code on the subscription row too', w.row(A.id).referral_code === 'CONNOR10' && w.row(A.id).referred_partner === 'Connor', w.row(A.id));

    const trial = S.trialInvoice(subA.id);
    await deliverAll(trial.events);
    chk('the $0 trial invoice earns nothing', trial.invoice.amount_paid === 0 && forInvoice(trial.invoice.id) === '');

    const paid = [];
    for (let k = 1; k <= 4; k++) {
      const c = S.cycle(subA.id);
      paid.push(c.invoice);
      res = await deliverAll(c.events);
      chk('invoice ' + k + ' is delivered and processed', res.every((x) => x.status === 200), res);
    }
    chk('paid invoices 1-3 are $44.99 and invoice 4 is $49.99 (the 7-day trial leaves 3 discounted months)',
      paid.map((i) => i.amount_paid).join() === '4499,4499,4499,4999', paid.map((i) => i.amount_paid));
    chk('they earn $9.00, $9.00, $9.00 and $10.00', paid.map((i) => forInvoice(i.id)).join() === 'accrual:900,accrual:900,accrual:900,accrual:1000',
      paid.map((i) => forInvoice(i.id)));
    chk('every commission is dated by the invoice\'s paid_at',
      svc(`select count(*) from public.affiliate_commissions where user_id = ${PG.lit(A.id)} and invoice_paid_at = occurred_at and invoice_paid_at is not null;`) === '4');

    /* a webhook retry, and the twin event type for the same invoice */
    const again = S.ev('invoice.paid', S.snap(paid[0]));
    again.id = w.q(`select id from public.stripe_events where type = 'invoice.paid' and payload -> 'data' -> 'object' ->> 'id' = ${PG.lit(paid[0].id)} limit 1`)[0].id;
    res = await deliverAll([again, S.ev('invoice.payment_succeeded', S.snap(paid[0]))]);
    chk('a redelivered invoice.paid and an invoice.payment_succeeded for the same invoice book nothing twice',
      res.every((x) => x.status === 200) && commissions(A.id) === 'accrual:900,accrual:900,accrual:900,accrual:1000', commissions(A.id));

    /* refunds and a dispute */
    await w.deliver(S.refund(paid[0].id, 2000));
    chk('a partial refund books the commission\'s share: -$4.00 of $9.00 (2000/4499)', forInvoice(paid[0].id) === 'accrual:900,clawback:-400', forInvoice(paid[0].id));
    await w.deliver(S.refund(paid[0].id, 4499));
    chk('refunding the rest books the remainder, capped at the commission', forInvoice(paid[0].id) === 'accrual:900,clawback:-400,clawback:-500', forInvoice(paid[0].id));
    await w.deliver(S.dispute(paid[0].id));
    chk('a dispute on a fully refunded invoice takes back nothing more', forInvoice(paid[0].id) === 'accrual:900,clawback:-400,clawback:-500');
    res = await w.deliver(S.dispute(paid[3].id));
    chk('a dispute (alert-only in the webhook) books -$10.00 against invoice 4', res.status === 200 && forInvoice(paid[3].id) === 'accrual:1000,clawback:-1000', forInvoice(paid[3].id));
    chk('and the webhook still raised it for a human', w.q("select count(*)::int as n from public.billing_alerts where kind = 'dispute'")[0].n >= 1);

    /* the statement for the month invoice 1 was paid in */
    const m1 = new Date(paid[0].status_transitions.paid_at * 1000);
    const month = m1.toISOString().slice(0, 7) + '-01';
    const st = JSON.parse(svc(`select json_agg(s order by s.line) from public.affiliate_statement('connor', date '${month}') s;`));
    const pay1 = st.find((x) => x.row_type === 'payment');
    chk('the statement lists the payment with its eligible amount, rate and commission, customer masked to 4 characters',
      pay1 && pay1.eligible_amount_cents === 4499 && +pay1.rate === 0.2 && pay1.commission_cents === 900
        && pay1.customer_last4 === csA.customer.slice(-4) && !JSON.stringify(st).includes(csA.customer), st);
    const due = new Date(Date.UTC(m1.getUTCFullYear(), m1.getUTCMonth() + 2, 15)).toISOString().slice(0, 10);
    chk('and pays it by the 15th of the second following month', st.every((x) => x.payout_due === due), { due, st });

    /* ===================================================================== */
    /* 2. A RETURNING CUSTOMER                                               */
    /* ===================================================================== */
    const B = w.user('ben@example.com');
    consent(B);
    r = await w.call('create_checkout_session', 'POST', OFFER, B.token);
    const csB1 = S.S.sessions[r.body.session_id];
    const doneB = S.complete(csB1.id, { email: B.email });
    await deliverAll(doneB.events);
    await deliverAll(S.trialInvoice(doneB.subscription.id).events);
    await deliverAll(S.cycle(doneB.subscription.id).events);   // paid $49.99 once, no code
    await w.deliver(S.update(doneB.subscription.id, { status: 'canceled' }, 'customer.subscription.deleted'));
    r = await w.call('create_checkout_session', 'POST', Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), B.token);
    const csB2 = S.S.sessions[r.body.session_id];
    chk('returning customer: no discount, no stamp, promotion codes left to Stripe\'s page',
      r.body.ok && r.body.affiliate === null && !csB2.discounts && csB2.allow_promotion_codes === 'true' && !csB2.metadata.affiliate, r.body);
    chk('and the log says why', logged('checkout.affiliate_skipped', 'returning_customer'));
    // even if a returning customer gets Connor's code on the subscription somehow, no attribution
    csB2.discounts = [{ promotion_code: PROMO }];
    const doneB2 = S.complete(csB2.id, { email: B.email });
    await deliverAll(doneB2.events);
    await deliverAll(S.cycle(doneB2.subscription.id).events);
    chk('a returning customer is never attributed, so earns Connor nothing', attribution(B.id) === '' && commissions(B.id) === '');

    /* our ledger never heard of the earlier payment, but Stripe has: Stripe refuses
       the first-time-only code, and the checkout goes ahead without it */
    const C = w.user('cara@example.com');
    consent(C);
    const custC = S.customer(C.email, { supabase_user_id: C.id });
    S.S.paid[custC.id] = true;
    r = await w.call('create_checkout_session', 'POST', Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), C.token);
    const csC = S.S.sessions[r.body.session_id];
    chk('Stripe refusing the code does not cost the customer the checkout: a plain session instead',
      r.status === 200 && r.body.ok && r.body.affiliate === null && csC && !csC.discounts && csC.allow_promotion_codes === 'true' && !csC.metadata.affiliate, r.body);
    chk('and the refusal is logged', logged('checkout.affiliate_refused_by_stripe'));

    /* ===================================================================== */
    /* 3. THE CODE IS IGNORED WHERE IT DOES NOT BELONG                       */
    /* ===================================================================== */
    const D = w.user('dev@example.com');
    consent(D);
    r = await checkoutWith({ STRIPE_PRICE_ID: 'price_4999_alt' }, Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), D.token);
    let cs = S.S.sessions[r.body.session_id];
    chk('another price (not MONTHLY_PRICE_ID): code ignored, no stamp, promotion codes on Stripe\'s page',
      r.body.ok && r.body.affiliate === null && cs.line_items[0].price === 'price_4999_alt' && !cs.discounts && cs.allow_promotion_codes === 'true'
        && !cs.metadata.affiliate && !cs.subscription_data.metadata.affiliate, r.body);
    chk('and the log says it was not the monthly price', logged('checkout.affiliate_skipped', 'not_the_monthly_price'));

    const E = w.user('eve@example.com');
    consent(E);
    r = await checkoutWith({ MONTHLY_PRICE_ID: '' }, Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), E.token);
    cs = S.S.sessions[r.body.session_id];
    chk('MONTHLY_PRICE_ID unset: no code is ever applied', r.body.ok && r.body.affiliate === null && !cs.discounts && cs.allow_promotion_codes === 'true');

    const F = w.user('fay@example.com');
    consent(F);
    r = await checkoutWith({ CONNOR_PROMO_CODE_ID: '' }, Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), F.token);
    cs = S.S.sessions[r.body.session_id];
    chk('CONNOR_PROMO_CODE_ID unset: no code, and an error in the log', r.body.ok && r.body.affiliate === null && !cs.discounts
      && logged('checkout.affiliate_skipped', 'promotion_code_env_missing'));

    const G = w.user('gil@example.com');
    consent(G);
    S.S.promos.promo_SomebodyElse = { id: 'promo_SomebodyElse', object: 'promotion_code', code: 'OTHER20', active: true,
      coupon: { id: 'coupon_other', percent_off: 20, duration: 'once', valid: true }, metadata: {} };
    r = await checkoutWith({ CONNOR_PROMO_CODE_ID: 'promo_SomebodyElse' }, Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), G.token);
    cs = S.S.sessions[r.body.session_id];
    chk('an env id that is some other code in Stripe is refused, never applied', r.body.ok && r.body.affiliate === null && !cs.discounts
      && logged('checkout.affiliate_skipped', 'promotion_code_mismatch')
      && svc(`select stripe_promotion_code_id from public.affiliate_campaigns where code = 'CONNOR10';`) === PROMO);

    const Hh = w.user('hal@example.com');
    consent(Hh);
    r = await w.call('create_checkout_session', 'POST', Object.assign({ affiliate_code: 'NOTACODE' }, OFFER), Hh.token);
    cs = S.S.sessions[r.body.session_id];
    chk('an unknown code: a plain session', r.body.ok && r.body.affiliate === null && !cs.discounts && cs.allow_promotion_codes === 'true');

    /* ===================================================================== */
    /* 4. REUSE MATCHES THE DISCOUNT; THE OLD FIELD STILL WORKS              */
    /* ===================================================================== */
    const I = w.user('ida@example.com');
    consent(I);
    const plainI = await w.call('create_checkout_session', 'POST', OFFER, I.token);
    const withI = await w.call('create_checkout_session', 'POST', Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), I.token);
    chk('an open session WITHOUT the code is not handed back to someone who now has it',
      withI.body.ok && withI.body.session_id !== plainI.body.session_id && withI.body.reused === false && withI.body.affiliate === 'connor', withI.body);
    const againI = await w.call('create_checkout_session', 'POST', Object.assign({ affiliate_code: 'CONNOR10' }, OFFER), I.token);
    chk('the same offer with the same code is reused (a double click)', againI.body.reused === true && againI.body.session_id === withI.body.session_id, againI.body);

    const J = w.user('jo@example.com');
    consent(J);
    r = await w.call('create_checkout_session', 'POST', Object.assign({ promo_code: 'CONNOR10' }, OFFER), J.token);
    cs = S.S.sessions[r.body.session_id];
    chk('a page built before this change (promo_code) gets the same treatment', r.body.affiliate === 'connor' && cs.discounts[0].promotion_code === PROMO);

    /* nothing about the code ever reaches a log as a secret, and no test-mode noise */
    chk('no log line carries the service key or a token', !w.logs.some((l) => /service-key|tok_\d/.test(l.line)));
  } catch (e) {
    chk('the suite ran without an unexpected error', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    w.stop();
  }
  process.exit(T.done());
})();

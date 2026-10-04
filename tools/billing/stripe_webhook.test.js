#!/usr/bin/env node
/* ===========================================================================
   THE STRIPE WEBHOOK, ATTACKED.

   This endpoint is public and it grants access to a paid product. Everything
   below is a way somebody could take the product without paying, or a way a
   real payment could be lost — the two failure directions that matter when
   nothing was listening to Stripe at all and nine subscriptions were typed in
   by hand.

   It also covers the half added later: WHICH DISCOUNT CODE A SALE CAME IN
   UNDER. That is a different kind of failure — nobody is let in for free by
   getting it wrong — but it is the same kind of loss. A promotion code exists
   for about a second, on one delivery, and a partner deal that cannot be
   reconstructed six months later is not a deal.

   The pure functions are loaded FROM THE DEPLOYED FILE, with everything from
   `Deno.serve` cut off. There is no second copy to drift: if the function
   changes, this tests the change.

   Run: node tools/billing/stripe_webhook.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
const eq = (name, got, want) =>
  chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'stripe_webhook', 'index.ts');
const SRC = fs.readFileSync(FN, 'utf8');

/* Load the pure half of the deployed function. Everything from Deno.serve down
   needs a Deno runtime; everything above it is plain JavaScript on purpose. */
const cut = SRC.indexOf('async function handle(');
chk('the function file exposes a pure half that can be tested', cut > 0);
const pure = SRC.slice(0, cut);
const api = {};
new Function('module', 'exports', 'crypto', 'TextEncoder',
  pure + '\n;module.exports={parseSigHeader,timingSafeEqual,hmacHex,verifySignature,' +
  'periodEnd,readEvent,idOf,HANDLED,ALERT_ONLY,normCode,readDiscount,hasDiscount,BUILD,' +
  'metadataUserId,priceIdOf,CORE_VERSION};'
)(api, api, crypto.webcrypto, TextEncoder);
const W = api.exports || api;

/* ======================================================================== */
/* 1. NOBODY GETS A SUBSCRIPTION BY POSTING TO THE URL                      */
/* ======================================================================== */
const SECRET = 'whsec_test_secret_value';
const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
const now = Math.floor(Date.now() / 1000);

function sign(body, secret, t) {
  return crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex');
}
const goodSig = (t, body) => 't=' + t + ',v1=' + sign(body || BODY, SECRET, t);

(async () => {
  let r = await W.verifySignature(BODY, goodSig(now), SECRET, now);
  chk('a correctly signed delivery is accepted', r.ok === true, JSON.stringify(r));

  r = await W.verifySignature(BODY, 't=' + now + ',v1=' + 'f'.repeat(64), SECRET, now);
  chk('a forged signature is refused', r.ok === false);

  r = await W.verifySignature(BODY, goodSig(now), 'whsec_the_wrong_secret', now);
  chk('a signature made with the wrong secret is refused', r.ok === false);

  /* THE BODY IS SIGNED, SO THE BODY CANNOT BE EDITED. Someone replaying a real
     delivery with the customer id swapped for their own must fail. */
  const tampered = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', mine: true });
  r = await W.verifySignature(tampered, goodSig(now), SECRET, now);
  chk('a real signature over a DIFFERENT body is refused', r.ok === false);

  /* REPLAY. A delivery captured today must not work tomorrow. */
  r = await W.verifySignature(BODY, goodSig(now - 3600), SECRET, now);
  chk('an hour-old delivery is outside the replay window', r.ok === false);
  r = await W.verifySignature(BODY, goodSig(now + 3600), SECRET, now);
  chk('and so is one dated an hour in the future', r.ok === false);
  r = await W.verifySignature(BODY, goodSig(now - 120), SECRET, now);
  chk('a two-minute-old delivery is still fine, because clocks drift', r.ok === true);

  r = await W.verifySignature(BODY, goodSig(now), '', now);
  chk('an unset webhook secret refuses everything rather than accepting anything',
    r.ok === false && /not set/i.test(r.reason));

  r = await W.verifySignature(BODY, 'garbage', SECRET, now);
  chk('a malformed signature header is refused', r.ok === false);
  r = await W.verifySignature(BODY, '', SECRET, now);
  chk('a missing signature header is refused', r.ok === false);
  r = await W.verifySignature(BODY, 't=notanumber,v1=abc', SECRET, now);
  chk('a non-numeric timestamp is refused', r.ok === false);

  /* Stripe sends more than one v1 during a secret roll. Any valid one counts. */
  r = await W.verifySignature(BODY,
    't=' + now + ',v1=' + 'a'.repeat(64) + ',v1=' + sign(BODY, SECRET, now), SECRET, now);
  chk('during a secret roll, a second valid v1 is accepted', r.ok === true);

  chk('the comparison is length-checked before content',
    W.timingSafeEqual('abc', 'abcd') === false);
  chk('and matches only an exact string', W.timingSafeEqual('abc', 'abc') === true);

  /* ====================================================================== */
  /* 2. WHAT AN EVENT SAYS — AND WHAT IT MUST NOT CLAIM                     */
  /* ====================================================================== */
  const checkout = W.readEvent({
    type: 'checkout.session.completed',
    data: { object: {
      client_reference_id: 'user-uuid-1', customer: 'cus_1', subscription: 'sub_1',
      customer_details: { email: 'a@b.co' }, payment_status: 'no_payment_required' } },
  });
  eq('a completed checkout carries our own user id', checkout.user_id, 'user-uuid-1');
  eq('and the customer', checkout.customer_id, 'cus_1');
  eq('and the subscription', checkout.subscription_id, 'sub_1');
  /* THE IMPORTANT ONE. A completed checkout is not a paid subscription — an
     incomplete or failed one also completes the session. Claiming 'active'
     here would hand out the product on a payment that never cleared. */
  eq('but it does NOT claim a status, because a checkout is not a payment',
    checkout.status, null);

  const created = W.readEvent({
    type: 'customer.subscription.created',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'trialing',
      current_period_end: 1789000000, cancel_at_period_end: false } },
  });
  eq('a subscription event carries the authoritative status', created.status, 'trialing');
  eq('and a real period end', created.current_period_end, new Date(1789000000000).toISOString());

  const deleted = W.readEvent({
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } },
  });
  eq('a deleted subscription is canceled whatever the object still says',
    deleted.status, 'canceled');

  /* Stripe moved current_period_end onto the items in newer API versions. */
  const newShape = W.readEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active',
      items: { data: [{ current_period_end: 1789000000 },
                      { current_period_end: 1789500000 }] } } },
  });
  eq('the period end is read from items when the API version moved it there',
    newShape.current_period_end, new Date(1789500000000).toISOString());
  chk('a subscription with no period end anywhere yields null, not a bad date',
    W.readEvent({ type: 'customer.subscription.updated',
      data: { object: { id: 's', customer: 'c', status: 'active' } } }).current_period_end === null);

  eq('an unhandled event type is read as nothing at all',
    W.readEvent({ type: 'charge.refunded', data: { object: { id: 'ch_1' } } }), null);
  eq('and an event with no object does not throw',
    W.readEvent({ type: 'customer.subscription.updated', data: {} }), null);

  chk('a customer sent as an object is read the same as one sent as an id',
    W.idOf({ id: 'cus_9' }) === 'cus_9' && W.idOf('cus_9') === 'cus_9' && W.idOf(null) === null);

  /* ====================================================================== */
  /* 3. OUT-OF-ORDER DELIVERY CANNOT RESURRECT A CANCELLED SUBSCRIPTION     */
  /* ====================================================================== */
  /* The ordering guard used to be a read in this function followed by a write
     — two deliveries racing could interleave between them. It now lives in
     ONE place, public.billing_apply_subscription_state, under a row lock, and
     tools/billing/billing_flow.test.js drives it with real out-of-order
     deliveries against the real SQL. What is asserted here is that this
     function has no other way to write the row. */
  chk('the function never writes subscriptions directly — only through the one SQL writer',
    !/D\.upsert\('subscriptions'/.test(SRC) && !/D\.(?:insert|post)\('subscriptions'/.test(SRC));
  chk('the payload path is stamped with Stripe\'s own event time and marked not-live',
    /p_as_of: stripeCreated, p_source: 'webhook_payload', p_live: false, p_authoritative: false/.test(SRC));
  chk('the live path goes through reconcileUser, stamped with the event it answers',
    /reconcileUser\(\{ db: D, stripe, svc: 'stripe_webhook' \}/.test(SRC) && /eventId: event\.id, eventAt: stripeCreated/.test(SRC));
  chk('and the core stamps a live write with the moment it asked Stripe, as authoritative',
    /p_as_of: asOf, p_source: o\.source \|\| 'sync', p_live: true, p_authoritative: true/.test(SRC));

  /* ====================================================================== */
  /* 4. THE HANDLED SET IS DELIBERATE                                       */
  /* ====================================================================== */
  ['checkout.session.completed', 'customer.subscription.created',
   'customer.subscription.updated', 'customer.subscription.deleted',
   'invoice.payment_failed'].forEach((t) =>
    chk('the webhook handles ' + t, W.HANDLED.indexOf(t) >= 0));
  chk('and does not act on refunds or disputes it has no logic for',
    W.HANDLED.indexOf('charge.refunded') < 0 && W.HANDLED.indexOf('charge.dispute.created') < 0);
  chk('a dispute is only ever raised for a human, never acted on',
    W.ALERT_ONLY.indexOf('charge.dispute.created') >= 0 && W.ALERT_ONLY.every((t) => W.HANDLED.indexOf(t) < 0));
  ['invoice.paid', 'checkout.session.expired', 'checkout.session.async_payment_succeeded',
   'customer.subscription.paused', 'customer.subscription.resumed'].forEach((t) =>
    chk('the optional extra ' + t + ' is understood when the endpoint sends it', W.HANDLED.indexOf(t) >= 0 && W.readEvent({ type: t, data: { object: { id: 'x', customer: 'cus_1' } } }) !== null));

  /* WHO AN EVENT BELONGS TO, every way there is */
  const md = W.readEvent({ type: 'customer.subscription.created', data: { object: {
    id: 'sub_9', customer: 'cus_9', status: 'trialing', metadata: { supabase_user_id: '0000AAAA-0000-4000-8000-000000000001' } } } });
  eq('a subscription created by our own checkout names the account by metadata', md.metadata_user_id, '0000aaaa-0000-4000-8000-000000000001');
  eq('a metadata value that is not a uuid names nobody',
    W.readEvent({ type: 'customer.subscription.created', data: { object: { id: 's', metadata: { supabase_user_id: 'x; drop' } } } }).metadata_user_id, null);
  const inv = W.readEvent({ type: 'invoice.payment_succeeded', data: { object: { id: 'in_1', customer: 'cus_1',
    parent: { subscription_details: { subscription: 'sub_new_api', metadata: { supabase_user_id: '00000000-0000-4000-8000-000000000002' } } } } } });
  eq('an invoice in the newer API shape still names its subscription', inv.subscription_id, 'sub_new_api');
  eq('and its account', inv.metadata_user_id, '00000000-0000-4000-8000-000000000002');
  eq('a checkout carries its session id, for our own session record', W.readEvent({ type: 'checkout.session.completed',
    data: { object: { id: 'cs_live_1', mode: 'subscription' } } }).session_id, 'cs_live_1');
  eq('a subscription event carries its single price', W.readEvent({ type: 'customer.subscription.updated',
    data: { object: { id: 's', items: { data: [{ price: { id: 'price_4999' } }] } } } }).price_id, 'price_4999');
  chk('resolution is one database call that tries every source in order',
    /D\.rpc\('billing_resolve_user', \{\s*p_metadata_user: read\.metadata_user_id, p_client_reference: read\.client_reference_id,/.test(SRC));
  chk('and, still unresolved, asks Stripe who the customer is before giving up',
    /stripe\.get\('\/customers\/' \+ encodeURIComponent\(read\.customer_id\)\)/.test(SRC));
  chk('an unresolved delivery is raised as an alert, never silently parked',
    /p_kind: 'unresolved_event'/.test(SRC));

  /* MODE VALIDATION */
  chk('a delivery\'s livemode must match the secret that signed it',
    /if \(\(signedMode === 'test'\) === livemode\)/.test(SRC) && /json\(\{ error: 'mode mismatch' \}, 400\)/.test(SRC));
  chk('a one-off payment checkout grants nothing', /read\.mode && read\.mode !== 'subscription'/.test(SRC));

  /* ====================================================================== */
  /* 5. A PAYING CUSTOMER IS NEVER WRITTEN IN WITH NO STATUS                */
  /* ====================================================================== */
  /* The first real checkout this webhook ever received created a row with
     status null — and pgEntitled() reads a null status as "not entitled", so
     the person who had just paid was locked out by the row recording their
     payment. Refusing to INFER a status from a checkout is still right; the
     answer is to go and ask Stripe for it. */
  chk('a checkout still refuses to invent a status',
    W.readEvent({ type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'u1', subscription: 'sub_1' } } }).status === null);
  chk('but the handler reads the real one back from Stripe rather than leaving null',
    /result = await reconcileUser\(/.test(SRC) && /extraSubscriptionIds: read\.subscription_id \? \[read\.subscription_id\] : \[\]/.test(SRC));
  chk('using the subscriptions endpoint, every subscription the customer has',
    /var STRIPE_API = 'https:\/\/api\.stripe\.com\/v1';/.test(SRC) && /stripe\.get\('\/subscriptions', \{ customer: customerId, status: 'all'/.test(SRC));
  chk('authenticated as ourselves, with the key from the environment',
    /var h = \{ authorization: 'Bearer ' \+ secretKey \};/.test(SRC) &&
    /makeStripe\(stripeKeyFor\(livemode\), fetch,/.test(SRC) &&
    /Deno\.env\.get\('STRIPE_SECRET_KEY'\)/.test(SRC));
  /* A TEST-MODE ID LOOKED UP WITH A LIVE KEY IS A 404, which reads exactly
     like an object that does not exist — so a dry run would report a clean
     "no promotion code" and prove nothing. */
  chk('and a test-mode event is looked up with a test-mode key, never the live one',
    /function stripeKeyFor\(livemode\)[\s\S]{0,200}STRIPE_SECRET_KEY_TEST/.test(SRC) &&
    !/makeStripe\(Deno\.env\.get\('STRIPE_SECRET_KEY'\)/.test(SRC));
  /* The dry-run secret lengthens nothing on the live path and changes nothing
     when it is unset — it is only ever tried after the live secret has already
     refused the delivery. */
  chk('the test-mode webhook secret is tried only AFTER the live one fails',
    /let v = await verifySignature\(raw[\s\S]{0,800}if \(!v\.ok && SECRET_TEST\)/.test(SRC));
  chk('and a test delivery says so, in the log and in the response, rather than passing as a sale',
    /TEST MODE delivery/.test(SRC) && /how: who\.how, livemode/.test(SRC));
  chk('and the period end from a live read goes through the same reader',
    /current_period_end: periodEnd\(sub\)/.test(SRC));
  chk('without the key it warns that the customer stays locked out, rather than guessing a status',
    /locked out'\)/.test(SRC) && !/row\.status = 'active'/.test(SRC));
  chk('the lookup never throws into the delivery — a Stripe outage falls back to the event body',
    /var unreachable = function \(e\) \{ return !e \|\| !e\.status \|\| e\.status >= 500 \|\| e\.status === 429; \};/.test(SRC) &&
    /if \(unreachable\(e\)\) stripeErr = e;/.test(SRC) && /if \(stripeErr\) return finish\('stripe_error', false/.test(SRC) &&
    /if \(!result\) \{\s*\/\/ Stripe could not be asked/.test(SRC));
  chk('and a checkout that cannot be read with a key configured is a 500, so Stripe redelivers it',
    /json\(\{ error: 'subscription state unavailable, retry' \}, 500\)/.test(SRC));

  /* ====================================================================== */
  /* 6. THE DEPLOYED FILE KEEPS ITS DEPLOYMENT CONTRACT                     */
  /* ====================================================================== */
  chk('it is one file with no relative imports, so the dashboard can bundle it',
    !/^\s*import\s.*from\s+['"]\.\./m.test(SRC));
  chk('it reads its secret from the environment, never a literal',
    /Deno\.env\.get\('STRIPE_WEBHOOK_SECRET'\)/.test(SRC) && !/whsec_[A-Za-z0-9]{8}/.test(SRC));
  chk('no service-role key is hardcoded', !/eyJ[A-Za-z0-9_-]{20,}\./.test(SRC));
  chk('the raw body is signed before it is parsed, not after',
    SRC.indexOf('await req.text()') < SRC.indexOf('JSON.parse(raw)'));
  chk('an unresolved customer is answered 200, so Stripe does not retry it away',
    /json\(\{ ok: true, unresolved: true \}, 200\)/.test(SRC));
  chk('but a failed subscription write is a 500, so Stripe DOES retry it',
    /json\(\{ error: 'processing failed' \}, 500\)/.test(SRC) && /catch \(e\) \{\s*\/\/ 500 so Stripe retries/.test(SRC));
  chk('and a delivery failing repeatedly is raised for a human', /p_kind: 'webhook_failing'/.test(SRC) && /ledger\.attempts >= 3/.test(SRC));
  chk('the ledger write happens first, and falls back to the plain upsert before the migration',
    SRC.indexOf("D.rpc('billing_record_event'") > 0 && SRC.indexOf("D.rpc('billing_record_event'") < SRC.indexOf("D.rpc('billing_resolve_user'") &&
    /await D\.upsert\('stripe_events'/.test(SRC));
  chk('and a missing service role is a 500 rather than a silent 200',
    /json\(\{ error: 'not configured' \}, 500\)/.test(SRC));
  chk('the rejection body never tells a forger why they failed',
    /return json\(\{ error: 'invalid signature' \}, 400\)/.test(SRC) && !/json\(\{[^}]*reason: v\.reason/.test(SRC));
  chk('and every log line goes through the redacting logger, which drops anything credential-shaped',
    /var LOG_DROP = \/token\|secret\|authorization\|password\|card\|payment_method/.test(SRC) && /if \(\/email\/i\.test\(k\)\) v = maskEmail\(v\)/.test(SRC));

  /* ====================================================================== */
  /* 7. WHICH CODE THE SALE CAME IN UNDER                                   */
  /* ====================================================================== */
  /* A promotion code redeemed at checkout is the only thing that says a
     partner sent this customer, and it is delivered once. Everything below is
     a way that fact gets lost, or a way it gets attributed to the wrong code. */

  eq('a code is upper-cased, because Stripe redeems it case-insensitively',
    W.normCode('betdesk'), 'BETDESK');
  eq('and trimmed', W.normCode('  BetDesk  '), 'BETDESK');
  eq('a string that is not a promotion code is refused, not scrubbed into one',
    W.normCode('BET DESK!'), null);
  eq('nothing is not a code', W.normCode(null), null);
  eq('and neither is an empty one', W.normCode('   '), null);
  chk('a 200-character string is not silently truncated into a code that exists',
    W.normCode('A'.repeat(200)) === null);

  /* THE SHAPE DEPENDS ON THE ACCOUNT'S API VERSION, which is exactly how
     current_period_end was lost once already. Every shape Stripe sends. */
  const ids = W.readDiscount({ discounts: [{ coupon: 'cpn_1', promotion_code: 'promo_1' }] });
  eq('the id shape: the promotion code is read', ids.promotion_code_id, 'promo_1');
  eq('and the coupon behind it', ids.coupon_id, 'cpn_1');
  eq('but the human code is not invented from either', ids.code, null);

  const expanded = W.readDiscount({ discounts: [{ id: 'di_1',
    coupon: { id: 'cpn_1', name: '25% off' },
    promotion_code: { id: 'promo_1', code: 'betdesk' } }] });
  eq('the expanded shape carries the code itself', expanded.code, 'BETDESK');
  eq('and still the id', expanded.promotion_code_id, 'promo_1');
  chk('a coupon NAME is never read as a code — it is a label, not something typed',
    expanded.code !== '25% OFF');

  const breakdown = W.readDiscount({ total_details: { breakdown: { discounts: [
    { amount: 2000, discount: { coupon: { id: 'cpn_1' }, promotion_code: 'promo_1' } }] } } });
  eq('a total_details breakdown entry is unwrapped', breakdown.promotion_code_id, 'promo_1');

  const onSub = W.readDiscount({ id: 'sub_1',
    discount: { coupon: { id: 'cpn_1' }, promotion_code: 'promo_1' } });
  eq('the subscription shape is read too, which is the fallback when the session has none',
    onSub.promotion_code_id, 'promo_1');

  eq('a bare promo_ id is understood', W.readDiscount({ discounts: ['promo_1'] }).promotion_code_id, 'promo_1');
  chk('a bare discount id names nothing, and is not guessed at',
    W.readDiscount({ discounts: ['di_1'] }).promotion_code_id === null);

  /* THE ONE THAT MATTERS MOST. Two promotion codes can share a coupon, so
     "a discount was applied" is not attribution. A coupon with no promotion
     code must not be credited to any code at all. */
  const couponOnly = W.readDiscount({ discounts: [{ coupon: 'cpn_shared' }] });
  eq('a discount with no promotion code names no code', couponOnly.code, null);
  eq('and no promotion code', couponOnly.promotion_code_id, null);
  eq('though the coupon is still recorded, so the sale is not reported as undiscounted',
    couponOnly.coupon_id, 'cpn_shared');
  chk('and that counts as a discount, so it lands in its own bucket rather than as "no code"',
    W.hasDiscount(couponOnly) === true);

  const twoCodesOneCoupon = [
    W.readDiscount({ discounts: [{ coupon: 'cpn_shared', promotion_code: 'promo_a' }] }),
    W.readDiscount({ discounts: [{ coupon: 'cpn_shared', promotion_code: 'promo_b' }] }),
  ];
  chk('two codes sharing one coupon stay distinguishable — the promotion code is the discriminator',
    twoCodesOneCoupon[0].promotion_code_id !== twoCodesOneCoupon[1].promotion_code_id &&
    twoCodesOneCoupon[0].coupon_id === twoCodesOneCoupon[1].coupon_id);

  chk('an undiscounted sale reads as no discount at all, not as an empty code',
    W.hasDiscount(W.readDiscount({ id: 'cs_1', customer: 'cus_1' })) === false);
  chk('and a malformed payload does not throw into the delivery',
    W.hasDiscount(W.readDiscount(null)) === false &&
    W.hasDiscount(W.readDiscount({ discounts: 'nonsense' })) === false &&
    W.hasDiscount(W.readDiscount({ discounts: [null, 7] })) === false);

  const ckDisc = W.readEvent({ type: 'checkout.session.completed', data: { object: {
    client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1',
    discounts: [{ coupon: 'cpn_1', promotion_code: 'promo_1' }] } } });
  eq('a completed checkout carries the discount through to the handler',
    ckDisc.discount.promotion_code_id, 'promo_1');
  const subDisc = W.readEvent({ type: 'customer.subscription.created', data: { object: {
    id: 'sub_1', customer: 'cus_1', status: 'active',
    discount: { promotion_code: 'promo_1' } } } });
  eq('and so does a subscription event', subDisc.discount.promotion_code_id, 'promo_1');

  /* ====================================================================== */
  /* 8. AND WHAT THE HANDLER DOES WITH IT                                   */
  /* ====================================================================== */
  /* ATTRIBUTION MUST NEVER COST SOMEBODY THEIR ACCESS. These columns do not
     exist on a project where referral_codes.sql has not been run. Folding them
     into the subscription upsert would make every delivery a 500 and Stripe
     would retry a paying customer forever while their status never landed. */
  chk('the attribution is a separate write from the subscription row',
    /D\.patch\('subscriptions',\s*\n?\s*'user_id=eq\.' \+ encodeURIComponent\(who\.user_id\) \+ '&referral_code=is\.null'/.test(SRC));
  chk('and a failure to record it is caught, logged, and never answered 500',
    /catch \(e\) \{[\s\S]{0,240}referral attribution not recorded/.test(SRC));
  chk('the subscription upsert itself carries no referral column',
    !/row\.referral_code/.test(SRC) && !/row\.referred_partner/.test(SRC));

  /* FIRST ATTRIBUTION WINS, and it is the FILTER that makes that true — an
     `if` read before the write loses a race between two deliveries. The
     short-circuit above it is an optimisation on top, never the guarantee. */
  chk('a code already on the row is never overwritten by a later event',
    /&referral_code=is\.null/.test(SRC));
  chk('and an already-credited row costs no lookup at all',
    /existing && existing\.referral_code/.test(SRC) &&
    /subscriptions\?select=\*&user_id=eq\./.test(SRC));

  /* An out-of-order delivery must not overwrite a newer STATUS. It can still
     tell us a code the row has never been told. */
  chk('the attribution runs whether or not the event was fresh (after the state write, not gated by it)',
    SRC.indexOf("let referral = null;") > SRC.indexOf("p_source: 'webhook_payload'") &&
    SRC.indexOf("let referral = null;") > SRC.indexOf('result = await reconcileUser('));

  /* Order INSIDE resolveReferral, not order of definition in the file: which
     lookup runs first is what keeps attribution working on a day the Stripe
     API is slow or STRIPE_SECRET_KEY is unset. */
  const resolver = SRC.slice(SRC.indexOf('async function resolveReferral('),
                             SRC.indexOf('async function handle('));
  chk('resolveReferral exists to be read at all', resolver.length > 100);
  chk('our own table is asked before Stripe, so a slow API does not lose the code',
    resolver.indexOf('referral_codes?select=code,partner_name') > 0 &&
    resolver.indexOf('referral_codes?select=code,partner_name') <
    resolver.indexOf('fetchPromotionCode('));
  chk('and neither lookup is allowed to overwrite a code the event carried itself',
    /if \(!out\.code && out\.promotion_code_id\) \{/.test(resolver));
  chk('and the Stripe lookup cannot throw into the delivery either',
    /catch \(e\) \{[\s\S]{0,160}promotion code lookup failed[\s\S]{0,60}return null/.test(SRC));
  chk('a discount that cannot be named is recorded AS unnamed, never as no discount',
    /unnamed_discount/.test(SRC));
  chk('the partner name is a snapshot taken at the sale, not a live join',
    /referred_partner = referral\.partner|patch\.referred_partner = referral\.partner/.test(SRC));

  /* NOTHING IN HERE KNOWS A CODE BY NAME. A function carrying a literal code
     would attribute sales to it on the day the lookups fail — which is the one
     day the number would be believed and wrong. Comments are stripped first:
     naming a code while EXPLAINING the rule is not the same as shipping one. */
  const code_only = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  chk('the function hardcodes no promotion code of its own',
    !/BETDESK/i.test(code_only));
  chk('and every code it writes came from normCode() of something it was told',
    /out\.code = normCode\(/.test(code_only) && !/out\.code = '/.test(code_only));

  /* ====================================================================== */
  /* 9. WHICH BUILD IS SERVING                                              */
  /* ====================================================================== */
  /* The deploy path is delete, recreate, clear, paste. A bundle that fails
     leaves the PREVIOUS version serving, which looks exactly like a deploy
     that worked and changed nothing. */
  chk('the file names its own build', typeof W.BUILD === 'string' && W.BUILD.length > 0);
  chk('and the name says which function it is',
    /^stripe_webhook-/.test(String(W.BUILD)));
  chk('every response is built in one place, so none can forget the marker',
    (SRC.match(/new Response\(/g) || []).length === 1);
  chk('that place puts the build in the body and in a header',
    /Object\.assign\(\{ build: BUILD \}/.test(SRC) && /'x-edgedesk-build': BUILD/.test(SRC));
  chk('a plain GET is refused but still answers with the marker, so a deploy can be confirmed',
    /req\.method !== 'POST'[\s\S]{0,200}json\(\{ error: 'POST only' \}, 405\)/.test(SRC));
  chk('the build marker is a literal, not read from an environment variable that could be unset',
    /^const BUILD = '[^']+';$/m.test(SRC));

  console.log('');
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('\nstripe webhook: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

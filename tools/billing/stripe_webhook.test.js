#!/usr/bin/env node
/* ===========================================================================
   THE STRIPE WEBHOOK, ATTACKED.

   This endpoint is public and it grants access to a paid product. Everything
   below is a way somebody could take the product without paying, or a way a
   real payment could be lost — the two failure directions that matter when
   nothing was listening to Stripe at all and nine subscriptions were typed in
   by hand.

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
  'periodEnd,readEvent,shouldApply,idOf,HANDLED};'
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
  const older = '2026-09-01T00:00:00.000Z', newer = '2026-09-02T00:00:00.000Z';
  chk('a first event for a row applies', W.shouldApply(null, newer) === true);
  chk('a newer event applies over an older one', W.shouldApply(older, newer) === true);
  chk('an OLDER event does not overwrite a newer one', W.shouldApply(newer, older) === false);
  chk('a redelivery of the same instant still applies, so a retry is not lost',
    W.shouldApply(newer, newer) === true);
  chk('an event with no timestamp is never applied', W.shouldApply(older, null) === false);

  /* ====================================================================== */
  /* 4. THE HANDLED SET IS DELIBERATE                                       */
  /* ====================================================================== */
  ['checkout.session.completed', 'customer.subscription.created',
   'customer.subscription.updated', 'customer.subscription.deleted',
   'invoice.payment_failed'].forEach((t) =>
    chk('the webhook handles ' + t, W.HANDLED.indexOf(t) >= 0));
  chk('and does not act on refunds or disputes it has no logic for',
    W.HANDLED.indexOf('charge.refunded') < 0 && W.HANDLED.indexOf('charge.dispute.created') < 0);

  /* ====================================================================== */
  /* 5. THE DEPLOYED FILE KEEPS ITS DEPLOYMENT CONTRACT                     */
  /* ====================================================================== */
  chk('it is one file with no relative imports, so the dashboard can bundle it',
    !/^\s*import\s.*from\s+['"]\.\./m.test(SRC));
  chk('it reads its secret from the environment, never a literal',
    /Deno\.env\.get\('STRIPE_WEBHOOK_SECRET'\)/.test(SRC) && !/whsec_[A-Za-z0-9]{8}/.test(SRC));
  chk('no service-role key is hardcoded', !/eyJ[A-Za-z0-9_-]{20,}\./.test(SRC));
  chk('the raw body is signed before it is parsed, not after',
    SRC.indexOf('await req.text()') < SRC.indexOf('JSON.parse(raw)'));
  chk('an unresolved customer is answered 200, so Stripe does not retry it away',
    /unresolved: true[\s\S]{0,120}status: 200/.test(SRC));
  chk('but a failed subscription write is a 500, so Stripe DOES retry it',
    /subscription write failed'[\s\S]{0,200}status: 500/.test(SRC));
  chk('and a missing service role is a 500 rather than a silent 200',
    /not configured[\s\S]{0,120}status: 500/.test(SRC));
  chk('the rejection body never tells a forger why they failed',
    /error: 'invalid signature'/.test(SRC) && !/reason: v\.reason/.test(SRC));

  console.log('');
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('\nstripe webhook: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
/* ===========================================================================
   A SUBSCRIBER'S LIFE, THROUGH THE REAL WEBHOOK AND THE REAL PAYWALL.

   The price moved from $79.99 to $49.99. Nothing that decides ACCESS may care:
   a subscriber on the new price and one still on the old are both just
   `active` or `trialing`, and the only thing a price may change is what the
   Settings card says they will be charged. This walks both through every event
   the Stripe endpoint receives, in Stripe's real (out-of-)order, and reads the
   result the way the product does:

     the webhook   the DEPLOYED supabase/functions/stripe_webhook/index.ts,
                   whole — signature check, ledger, live reconciliation with
                   Stripe — under a Deno shim (tools/billing/_harness.js),
                   against the REAL billing SQL on a throwaway PostgreSQL and a
                   fake Stripe whose state moves first, as Stripe's does
     the paywall   pgEntitled() and the Settings card, lifted out of app.html
     the offer     lib/edgedesk_pricing.js

   The new-user path: subscription.created arrives before the checkout and is
   kept unresolved → checkout.session.completed names the account, the
   function asks Stripe for its subscriptions (7-day trial, $49.99/month) →
   trialing, entitled, "Trial ends <the trial's own end>" → day 8,
   invoice.payment_succeeded and subscription.updated → active, "Next billing
   date" → a failed renewal → past_due, still entitled while Stripe retries →
   cancel at period end → "Access ends" → subscription.deleted → locked.

   And the existing subscriber, still on $79.99 until they are moved in Stripe:
   exactly as entitled, and moved without a moment's loss of access.

   Needs PostgreSQL (skips loudly without it). No network, no key.
   Run: node tools/billing/subscriber_lifecycle.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); } }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));

/* ── the deployed webhook, against the real SQL and a fake Stripe ────────── */
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');
const W = H.world('lifecycle');
if (W.skip) { console.log('SKIP | subscriber lifecycle | ' + W.skip); process.exit(0); }
const S = W.stripe;
chk('the deployed webhook loads and serves a handler', typeof W.fns.stripe_webhook === 'function');

let delivered = 0;
async function deliver(type, object, opts) {
  const e = S.ev(type, JSON.parse(JSON.stringify(object)));
  if (opts && opts.createdDelta) e.created += opts.createdDelta;
  delivered++;
  const r = await W.deliver(e);
  return { status: r.status, body: r.body };
}
const clock = () => S.now();
/* Stripe's own state moves FIRST; the event describes it */
const set = (id, fields) => Object.assign(S.S.subscriptions[id], fields || {});
const withPrice = (id, cents, priceId) => {
  S.S.prices[priceId] = S.S.prices[priceId] || { id: priceId, object: 'price', active: true, type: 'recurring', currency: 'usd',
    unit_amount: cents, recurring: { interval: 'month', interval_count: 1 } };
  S.S.subscriptions[id].items = { object: 'list', data: [{ id: 'si_' + priceId, price: S.S.prices[priceId] }] };
  return S.S.subscriptions[id];
};
const row = (uid) => W.row(uid);

/* ── the paywall and the Settings card, lifted out of app.html ──────────── */
function region(src, from, to) { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); return a >= 0 && b > a ? src.slice(a, b) : ''; }
const COMP = region(APP, '/* ---- A COMPED SUBSCRIPTION', 'async function loadSubStatus(){');
const SET = region(APP, 'function subStatusLabel(s){', 'function renderSetEdge(){');
const PAY = region(APP, 'function pgEntitled(sub){', 'function pgPastDue(sub){');
chk('the paywall and Settings regions are found in app.html', COMP.length > 100 && SET.length > 100 && PAY.length > 100);
const ctx = { window: {}, EDPricing: X, SUB_PRICE_DISPLAY: X.PRICE_DISPLAY, SUB_PLAN_NAME: X.PLAN_NAME, PG_GRACE_DAYS: 21,
  stEsc: (s) => String(s == null ? '' : s), setCard: (t, s, b) => '[' + t + ']' + (s || '') + (b || ''),
  setRow: (k, v, n) => '<' + k + '=' + v + (n ? ' (' + n + ')' : '') + '>', stripePortalHref: () => 'https://billing.stripe.com/p/login/x',
  Date, Array, String, Number, isFinite, Math, JSON };
ctx.window = ctx; ctx.window.EDPricing = X;
vm.createContext(ctx);
vm.runInContext(COMP + '\n' + PAY + '\n' + SET, ctx);
const entitled = (r) => ctx.pgEntitled(r);
const card = (r, price) => { ctx.window.SUB = r; ctx.window.SUB_PRICE = price || null; return ctx.renderSetSub().replace(/<span[^>]*>|<\/span>/g, ''); };
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

(async () => {
  /* ====================================================================== */
  /* A NEW SUBSCRIBER, AT $49.99                                            */
  /* ====================================================================== */
  /* A Payment Link checkout: the URL carried the account id, Stripe made a
     fresh customer and put nothing on the subscription. This is the path that
     used to depend on the checkout delivery arriving. */
  const U = W.user('new@x.co').id;
  const pl = S.paymentLinkSession({ client_reference_id: U });
  /* paid with Apple Pay's relay address, so nothing but the checkout names them */
  const done = S.complete(pl.id, { wallet: 'apple_pay', email: 'q8x@privaterelay.appleid.com' });
  const subNew = done.subscription.id, cusNew = done.customer.id;
  const trialEnd = done.subscription.trial_end;

  /* Stripe routinely sends the subscription before the checkout that names it */
  let r = await deliver('customer.subscription.created', S.S.subscriptions[subNew]);
  chk('subscription.created before the checkout: answered 200 and kept, unresolved', r.status === 200 && r.body.unresolved === true, JSON.stringify(r.body));
  chk('and no access is granted to anybody on the strength of it', row(U) === null);
  chk('the ledger kept it against its subscription id', W.q("select 1 from public.stripe_events where subscription_id = " + PG.lit(subNew) + " and type = 'customer.subscription.created'").length === 1);

  r = await deliver('checkout.session.completed', S.S.sessions[pl.id]);
  chk('the checkout lands: 200, applied, by client_reference_id', r.status === 200 && r.body.applied === true && r.body.how === 'client_reference_id', JSON.stringify(r.body));
  let s = row(U);
  chk('the function asked Stripe and wrote the real status: trialing', s && s.status === 'trialing', JSON.stringify(s));
  chk('with the trial\'s own end as the period end — nothing invented', s && Date.parse(s.current_period_end) === trialEnd * 1000);
  chk('the earlier subscription.created is resolved retroactively', W.q("select resolved from public.stripe_events where subscription_id = " + PG.lit(subNew) + " and type = 'customer.subscription.created'")[0].resolved === true);
  chk('the new trial is entitled: the terminal opens', entitled(s));
  chk('and the database\'s one rule agrees with the paywall', W.access(U).has_access === entitled(s));
  let h = card(s);
  chk('Settings: EdgeDesk Full Access, a 7-day free trial, then $49.99/month',
    /Plan=EdgeDesk Full Access/.test(h) && /7-day free trial/.test(h) && /Then \$49\.99\/month/.test(h), h);
  chk('and the first charge of $49.99 on the day the trial really ends',
    h.indexOf('Trial ends=' + day(s.current_period_end)) >= 0 && /Your first charge of \$49\.99/.test(h), h);

  /* day 8: Stripe charges and moves the subscription to active */
  const period2 = clock() + 37 * 86400;
  set(subNew, { status: 'active', trial_end: null, current_period_end: period2 });
  r = await deliver('invoice.payment_succeeded', { id: 'in_1', object: 'invoice', customer: cusNew, subscription: subNew, amount_paid: 4999, currency: 'usd', customer_email: 'new@x.co' });
  chk('the first invoice is recorded and handled', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await deliver('customer.subscription.updated', S.S.subscriptions[subNew]);
  s = row(U);
  chk('day 8: active, entitled', s.status === 'active' && entitled(s), JSON.stringify(s));
  h = card(s);
  chk('Settings: $49.99 / month, with the next billing date Stripe set',
    /Price=\$49\.99 \/ month/.test(h) && h.indexOf('Next billing date=' + day(new Date(period2 * 1000).toISOString())) >= 0, h);

  /* a failed renewal: Stripe retries, access holds, the card says so */
  set(subNew, { status: 'past_due' });
  await deliver('invoice.payment_failed', { id: 'in_2', object: 'invoice', customer: cusNew, subscription: subNew, amount_due: 4999, currency: 'usd' });
  await deliver('customer.subscription.updated', S.S.subscriptions[subNew]);
  s = row(U);
  chk('a failed payment: past_due, still entitled while Stripe retries', s.status === 'past_due' && entitled(s));
  chk('and Settings says the payment failed', /Payment failed/.test(card(s)));
  set(subNew, { status: 'active' });
  await deliver('customer.subscription.updated', S.S.subscriptions[subNew]);
  chk('the retry clears: active again', row(U).status === 'active');

  /* cancellation */
  set(subNew, { cancel_at_period_end: true });
  await deliver('customer.subscription.updated', S.S.subscriptions[subNew]);
  s = row(U);
  h = card(s);
  chk('cancelled at period end: still entitled to the end of what was paid for', entitled(s));
  chk('and Settings says when access ends, with no further charge', /Access ends=/.test(h) && /no further charges/.test(h) && !/You will be charged/.test(h), h);
  const stale = JSON.parse(JSON.stringify(S.S.subscriptions[subNew]));
  set(subNew, { status: 'canceled' });
  await deliver('customer.subscription.deleted', S.S.subscriptions[subNew]);
  s = row(U);
  chk('subscription.deleted: canceled, and the terminal locks', s.status === 'canceled' && !entitled(s));

  /* a stale event delivered late cannot reopen it */
  r = await deliver('customer.subscription.updated', Object.assign(stale, { status: 'active' }), { createdDelta: -10 * 86400 });
  chk('a late, older "active" cannot resurrect the cancelled subscription', row(U).status === 'canceled' && r.body.changed === false, JSON.stringify(r.body));

  /* ====================================================================== */
  /* THE EXISTING SUBSCRIBER, STILL ON $79.99 UNTIL MOVED IN STRIPE         */
  /* ====================================================================== */
  const E = W.user('old@x.co').id;
  const endE = clock() + 20 * 86400;
  const cusOld = S.customer('old@x.co', {});
  const subOld = S.subscription(cusOld.id, 'price_4999', { status: 'active', current_period_end: endE });
  withPrice(subOld.id, 7999, 'price_7999');
  /* a row from before the webhook could name anybody: typed in, ids and all */
  W.db.sql('insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values (' +
    PG.lit(E) + ", 'active', " + PG.lit(cusOld.id) + ', ' + PG.lit(subOld.id) + ');');
  r = await deliver('customer.subscription.updated', S.S.subscriptions[subOld.id]);
  s = row(E);
  chk('an event carrying the old $79.99 price is applied like any other', r.body.applied === true && s.status === 'active', JSON.stringify(r.body));
  chk('and the subscriber on the old price is entitled', entitled(s));
  chk('the row records the Stripe price it is billed at — a Stripe id, never a comp sentinel, so no price can gate it',
    s.price_id === 'price_7999' && ['owner_comp', 'comp_trial'].indexOf(s.price_id) < 0 && W.access(E).has_access);
  chk('Settings shows them what Stripe will actually charge until they are moved',
    /You will be charged \$79\.99 on this date/.test(card(s, { unit_amount: 7999, currency: 'usd', billing_interval: 'month', interval_count: 1 })));

  /* moved in Stripe to the $49.99 price */
  withPrice(subOld.id, 4999, 'price_4999');
  r = await deliver('customer.subscription.updated', S.S.subscriptions[subOld.id]);
  s = row(E);
  chk('moved to $49.99: still active, still entitled, not a moment\'s gap', r.body.applied === true && s.status === 'active' && entitled(s) && s.price_id === 'price_4999');
  chk('and Settings follows Stripe to $49.99',
    /You will be charged \$49\.99 on this date/.test(card(s, { unit_amount: 4999, currency: 'usd', billing_interval: 'month', interval_count: 1 })));

  /* and a price nobody sells any more (a historical one) is still just a subscription */
  const Hh = W.user('hist@x.co').id;
  const cusH = S.customer('hist@x.co', {});
  const subH = S.subscription(cusH.id, 'price_4999', { status: 'active', current_period_end: endE });
  withPrice(subH.id, 1499, 'price_1499');
  W.db.sql('insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id) values (' +
    PG.lit(Hh) + ", 'active', " + PG.lit(cusH.id) + ', ' + PG.lit(subH.id) + ');');
  await deliver('customer.subscription.updated', S.S.subscriptions[subH.id]);
  chk('a subscriber on a long-retired price keeps access too', entitled(row(Hh)));

  /* an expired trial: Stripe ends it, the terminal locks, the paywall offers $49.99 */
  const T2 = W.user('t2@x.co').id;
  const pl2 = S.paymentLinkSession({ client_reference_id: T2 });
  const done2 = S.complete(pl2.id, {});
  await deliver('checkout.session.completed', S.S.sessions[pl2.id]);
  chk('a second trial starts entitled', entitled(row(T2)));
  set(done2.subscription.id, { status: 'canceled' });
  await deliver('customer.subscription.deleted', S.S.subscriptions[done2.subscription.id]);
  chk('an ended trial locks', !entitled(row(T2)));
  chk('and its Settings card claims no coming charge', !/You will be charged|first charge/.test(card(row(T2))));

  /* every delivery above was acknowledged; none was dropped */
  chk('every delivery is on the ledger, once', W.q('select count(*)::int n from public.stripe_events')[0].n === delivered,
    W.q('select count(*)::int n from public.stripe_events')[0].n + ' of ' + delivered);
  chk('none failed', W.q('select count(*)::int n from public.stripe_events where last_error is not null')[0].n === 0);
  W.stop();

  failures.forEach((f) => console.log('FAIL  ' + f));
  console.log((fail ? '' : 'ALL GREEN ') + 'subscriber lifecycle: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { W.stop(); } catch (_) { /* already down */ } process.exit(1); });

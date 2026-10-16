#!/usr/bin/env node
/* ===========================================================================
   CONNOR'S DEAL ON A REAL STRIPE TEST CLOCK (TEST MODE ONLY).

   The one question no local test can answer is Stripe's own arithmetic: a
   repeating coupon ("10% off for 3 months") applied when a subscription
   starts its 7-day free trial — does the trial use up coupon time, so that
   only 2 paid invoices are discounted? This asks Stripe:

     1. reads MONTHLY_PRICE_ID and CONNOR_PROMO_CODE_ID (the TEST-mode ids) and
        checks they are $49.99/month and CONNOR10 on 10% x 3 months;
     2. makes a test clock, a customer on it with a test card, and the
        subscription the checkout makes: the monthly price, trial_period_days
        7, discounts [{promotion_code}], metadata affiliate=connor;
     3. advances the clock through the trial and 4 billing cycles;
     4. prints every invoice and checks: the trial invoice is $0, paid
        invoices 1-3 are $44.99, invoice 4 is $49.99 — and the commission
        each earns at 20% ($0, $9.00 x3, $10.00);
     5. checks Stripe itself refuses CONNOR10 to the same customer for a
        second subscription (first-time customers only);
     6. refunds $20.00 of paid invoice 1 (shows the capped adjustment the
        ledger should book: -$4.00);
     7. optionally, with SB_URL, SB_SERVICE_ROLE and --user <uuid of a
        throwaway EdgeDesk account>, waits for the test-mode webhook endpoint
        and reads what public.affiliate_commissions booked for that account;
     8. deletes the test clock (and with it the customer) unless --keep.

   Usage:
     STRIPE_SECRET_KEY_TEST=sk_test_… MONTHLY_PRICE_ID=price_… \
     CONNOR_PROMO_CODE_ID=promo_… node tools/billing/affiliate_test_clock.js
       [--user <uuid>] [--keep]

   It refuses a live key. It writes nothing to EdgeDesk's database; anything
   it books there arrives through the webhook like any test delivery (see
   supabase/functions/stripe_webhook/README.md §c for the test-mode endpoint),
   and is flagged livemode = false, which the payout statement leaves out.
   =========================================================================== */
'use strict';

const KEY = process.env.STRIPE_SECRET_KEY_TEST || '';
const PRICE = process.env.MONTHLY_PRICE_ID || '';
const PROMO = process.env.CONNOR_PROMO_CODE_ID || '';
const SB_URL = (process.env.SB_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SB_SERVICE_ROLE || '';
const args = process.argv.slice(2);
const USER = (args.indexOf('--user') >= 0 ? args[args.indexOf('--user') + 1] : '') || '';
const KEEP = args.indexOf('--keep') >= 0;
const RATE = 0.20;

function die(msg) { console.error('STOP | ' + msg); process.exit(2); }
if (!/^(sk|rk)_test_/.test(KEY)) die('STRIPE_SECRET_KEY_TEST must be a TEST-mode key (sk_test_… or rk_test_…). This never runs against live mode.');
if (!/^price_/.test(PRICE)) die('MONTHLY_PRICE_ID must be the test-mode monthly price (price_…).');
if (!/^promo_/.test(PROMO)) die('CONNOR_PROMO_CODE_ID must be the test-mode promotion code id (promo_…).');
if (USER && !/^[0-9a-f-]{36}$/i.test(USER)) die('--user must be an EdgeDesk account uuid.');

function form(obj, prefix, out) {
  out = out || [];
  if (obj == null) return out;
  if (Array.isArray(obj)) { obj.forEach((v, i) => form(v, prefix + '[' + i + ']', out)); return out; }
  if (typeof obj === 'object') { Object.keys(obj).forEach((k) => form(obj[k], prefix ? prefix + '[' + k + ']' : k, out)); return out; }
  out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(obj)));
  return out;
}
async function stripe(method, path, params) {
  const qs = method === 'GET' && params ? '?' + form(params).join('&') : '';
  const r = await fetch('https://api.stripe.com/v1' + path + qs, {
    method, headers: Object.assign({ authorization: 'Bearer ' + KEY },
      method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    body: method === 'POST' ? form(params || {}).join('&') : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(method + ' ' + path + ' ' + r.status + ': ' + ((j.error && j.error.message) || '')); e.status = r.status; e.body = j; throw e; }
  return j;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const usd = (c) => (c == null ? '—' : (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2));
const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'ok   | ' : 'FAIL | ') + label + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function advance(clock, to) {
  await stripe('POST', '/test_helpers/test_clocks/' + clock + '/advance', { frozen_time: to });
  for (let i = 0; i < 120; i++) {
    const c = await stripe('GET', '/test_helpers/test_clocks/' + clock);
    if (c.status === 'ready') return c;
    if (c.status === 'internal_failure') throw new Error('test clock failed to advance');
    await sleep(2000);
  }
  throw new Error('test clock still advancing after 4 minutes');
}
function addMonths(sec, n) {
  const d = new Date(sec * 1000), dd = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  t.setUTCDate(Math.min(dd, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()));
  return Math.floor(t.getTime() / 1000);
}
function taxOf(inv) {
  if (typeof inv.tax === 'number') return inv.tax;
  return (inv.total_taxes || []).reduce((s, t) => s + (Number(t.amount) || 0), 0);
}
async function paymentIntentOf(inv) {
  if (inv.payment_intent) return typeof inv.payment_intent === 'string' ? inv.payment_intent : inv.payment_intent.id;
  // API versions from 2025-03-31 list payments separately
  const p = await stripe('GET', '/invoice_payments', { invoice: inv.id, limit: 3 }).catch(() => null);
  const pay = p && p.data && p.data.find((x) => x.payment && x.payment.payment_intent);
  return pay ? (typeof pay.payment.payment_intent === 'string' ? pay.payment.payment_intent : pay.payment.payment_intent.id) : null;
}

(async () => {
  let clock = null;
  try {
    /* 1. the configuration */
    const price = await stripe('GET', '/prices/' + PRICE);
    check('MONTHLY_PRICE_ID is $49.99 USD per month', price.unit_amount === 4999 && price.currency === 'usd'
      && price.recurring && price.recurring.interval === 'month' && (price.recurring.interval_count || 1) === 1,
      { unit_amount: price.unit_amount, currency: price.currency, recurring: price.recurring });
    const promo = await stripe('GET', '/promotion_codes/' + PROMO, { 'expand[]': 'coupon' }).catch(() => stripe('GET', '/promotion_codes/' + PROMO));
    const cp = promo.coupon || (promo.promotion && promo.promotion.coupon) || {};
    check('CONNOR_PROMO_CODE_ID is CONNOR10, active, first-time customers only, metadata affiliate=connor',
      String(promo.code).toUpperCase() === 'CONNOR10' && promo.active && promo.restrictions && promo.restrictions.first_time_transaction
        && (promo.metadata || {}).affiliate === 'connor',
      { code: promo.code, active: promo.active, restrictions: promo.restrictions, metadata: promo.metadata });
    check('its coupon is 10% off, repeating, 3 months', cp.percent_off === 10 && cp.duration === 'repeating' && cp.duration_in_months === 3,
      { percent_off: cp.percent_off, duration: cp.duration, duration_in_months: cp.duration_in_months });
    if (cp.applies_to && cp.applies_to.products) {
      check('the coupon applies to the monthly price\'s product', cp.applies_to.products.indexOf(price.product) >= 0,
        { applies_to: cp.applies_to.products, product: price.product });
    }

    /* 2. a customer on a test clock, subscribed the way the checkout subscribes */
    const start = Math.floor(Date.now() / 1000);
    clock = (await stripe('POST', '/test_helpers/test_clocks', { frozen_time: start, name: 'Connor 10% x 3 — ' + new Date().toISOString() })).id;
    console.log('     test clock ' + clock);
    const cust = await stripe('POST', '/customers', { test_clock: clock, email: 'connor-clock-' + start + '@example.com',
      description: 'tools/billing/affiliate_test_clock.js', metadata: USER ? { supabase_user_id: USER } : {} });
    const pm = await stripe('POST', '/payment_methods/pm_card_visa/attach', { customer: cust.id });
    await stripe('POST', '/customers/' + cust.id, { invoice_settings: { default_payment_method: pm.id } });
    const sub = await stripe('POST', '/subscriptions', {
      customer: cust.id, items: [{ price: PRICE, quantity: 1 }], trial_period_days: 7,
      discounts: [{ promotion_code: PROMO }],
      metadata: Object.assign({ affiliate: 'connor', affiliate_code: 'CONNOR10' }, USER ? { supabase_user_id: USER } : {}),
    });
    check('the subscription starts trialing for 7 days', sub.status === 'trialing' && sub.trial_end - sub.trial_start === 7 * 86400,
      { status: sub.status, trial_start: sub.trial_start, trial_end: sub.trial_end });
    const disc = sub.discount || null;
    if (disc) console.log('     discount: ' + day(disc.start) + ' → ' + (disc.end ? day(disc.end) : 'forever'));

    /* 3. through the trial and four billing cycles */
    const trialEnd = sub.trial_end;
    for (let k = 0; k < 4; k++) {
      const to = addMonths(trialEnd, k) + 2 * 3600;
      process.stdout.write('     advancing to ' + new Date(to * 1000).toISOString() + ' … ');
      await advance(clock, to);
      console.log('ready');
    }

    /* 4. what Stripe billed */
    const list = (await stripe('GET', '/invoices', { customer: cust.id, limit: 20 })).data.sort((a, b) => a.created - b.created);
    console.log('\n     #  reason               period start  paid       discount   tax       eligible  commission (20%)');
    const rows = list.map((inv, i) => {
      const per = inv.lines && inv.lines.data && inv.lines.data[0] && inv.lines.data[0].period;
      const off = (inv.total_discount_amounts || []).reduce((s, d) => s + d.amount, 0);
      const tax = taxOf(inv), eligible = Math.max(inv.amount_paid - tax, 0);
      const com = inv.amount_paid > 0 ? Math.round(eligible * RATE) : 0;
      console.log('     ' + String(i).padEnd(3) + String(inv.billing_reason).padEnd(21) + (per ? day(per.start) : '—').padEnd(14)
        + usd(inv.amount_paid).padEnd(11) + usd(off).padEnd(11) + usd(tax).padEnd(10) + usd(eligible).padEnd(10) + usd(com));
      return { inv, off, com, tax };
    });
    console.log('');
    const trialInv = rows[0], paid = rows.filter((r) => r.inv.amount_paid > 0);
    check('the trial invoice is $0 and earns no commission', trialInv && trialInv.inv.amount_paid === 0 && trialInv.com === 0);
    const discounted = paid.filter((r) => r.off > 0).length;
    check('paid invoices 1-3 are $44.99 before tax and earn $9.00 each',
      paid.length >= 3 && paid.slice(0, 3).every((r) => r.inv.amount_paid - r.tax === 4499 && r.com === 900),
      paid.slice(0, 3).map((r) => r.inv.amount_paid - r.tax));
    check('paid invoice 4 is $49.99 before tax and earns $10.00', paid[3] && paid[3].inv.amount_paid - paid[3].tax === 4999 && paid[3].com === 1000,
      paid[3] && paid[3].inv.amount_paid);
    console.log('     DISCOUNTED PAID INVOICES: ' + discounted + ' of ' + paid.length);
    if (discounted < 3) {
      console.log('     >>> The trial used up coupon time: only ' + discounted + ' paid invoice(s) got 10% off.');
      console.log('     >>> Change the coupon to repeating for 4 months so the customer gets 3 discounted paid months.');
    } else if (discounted === 3) {
      console.log('     >>> 3 paid months discounted, as promised. The 3-month coupon is right.');
    }

    /* 5. Stripe's own first-time-customer rule */
    let refused = null;
    try {
      const s2 = await stripe('POST', '/subscriptions', { customer: cust.id, items: [{ price: PRICE, quantity: 1 }], discounts: [{ promotion_code: PROMO }] });
      await stripe('DELETE', '/subscriptions/' + s2.id).catch(() => null);
    } catch (e) { refused = e; }
    check('Stripe refuses CONNOR10 to a customer who has already paid (first-time only)', !!refused && refused.status === 400,
      refused ? refused.message : 'a second subscription with CONNOR10 was accepted');

    /* 6. a partial refund of paid invoice 1 */
    if (paid[0]) {
      const pi = await paymentIntentOf(paid[0].inv);
      if (pi) {
        await stripe('POST', '/refunds', { payment_intent: pi, amount: 2000 });
        const expect = Math.min(paid[0].com, Math.round(paid[0].com * 2000 / paid[0].inv.amount_paid));
        console.log('     refunded $20.00 of invoice 1: the ledger should book a ' + usd(-expect) + ' adjustment (capped at ' + usd(paid[0].com) + ')');
      } else {
        console.log('     (no payment intent found on invoice 1; refund step skipped)');
      }
    }

    /* 7. what EdgeDesk booked, through the test-mode webhook */
    if (SB_URL && SB_KEY && USER) {
      console.log('     waiting 20s for the test-mode webhook …');
      await sleep(20000);
      const r = await fetch(SB_URL + '/rest/v1/affiliate_commissions?select=kind,amount_cents,basis_cents,stripe_invoice_id,livemode&user_id=eq.' + USER + '&order=id',
        { headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY } });
      const got = r.ok ? await r.json() : null;
      console.log('     public.affiliate_commissions for ' + USER + ': ' + JSON.stringify(got));
      const acc = (got || []).filter((x) => x.kind === 'accrual').map((x) => x.amount_cents);
      check('EdgeDesk booked $9.00 x3 and $10.00, flagged test mode', acc.join() === '900,900,900,1000' && (got || []).every((x) => x.livemode === false), acc);
      check('and a negative adjustment for the refund', (got || []).some((x) => x.kind === 'clawback' && x.amount_cents < 0));
    } else {
      console.log('     (set SB_URL, SB_SERVICE_ROLE and --user <uuid> to also check what the webhook booked)');
    }
  } catch (e) {
    check('the run completed without a Stripe error', false, String(e.message || e));
  } finally {
    if (clock && !KEEP) {
      await stripe('DELETE', '/test_helpers/test_clocks/' + clock).then(() => console.log('     deleted test clock ' + clock), () => null);
    } else if (clock) {
      console.log('     kept test clock ' + clock + ' (--keep)');
    }
  }
  console.log(failures ? '\nFAILED — ' + failures + ' check(s)' : '\nALL GREEN — Stripe agrees with the deal');
  process.exit(failures ? 1 : 0);
})();

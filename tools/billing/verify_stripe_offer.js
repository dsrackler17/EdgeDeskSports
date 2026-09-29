#!/usr/bin/env node
/* ===========================================================================
   DOES STRIPE SELL WHAT THE PAGE SAYS?

   lib/edgedesk_pricing.js states the offer — EdgeDesk Full Access, a 7-day
   free trial, then $49.99 a month — and names the two Stripe Payment Links
   that sell it. The page cannot see Stripe. A link can point at the wrong
   price, a one-time price, a yearly one, an archived one, a test-mode one, or
   carry no trial at all, and every one of those looks identical from here: a
   customer consents to one set of terms and is billed on another.

   So this asks Stripe, read-only, about each link:

     the link       exists in this account, is active, is live (not test mode)
     what it sells  exactly one line item, quantity 1: an ACTIVE, RECURRING,
                    LICENSED price of exactly PRICE_CENTS, in USD, every 1 month
     the trial      the trial link carries TRIAL_DAYS days; the resubscribe
                    link carries none (the paywall promises a lapsed reader no
                    trial)
     the rest       a warning, not a failure: the product's name (what Checkout
                    shows), promotion codes allowed (creator codes need it), the
                    redirect back to ?checkout=success, and whether the retired
                    $79.99 links are still switched on in Stripe

   Nothing is written. A restricted key with READ access to Payment Links,
   Prices and Products is enough, and is what to use.

   Run:
     STRIPE_SECRET_KEY=rk_live_… node tools/billing/verify_stripe_offer.js
         checks CHECKOUT_LINK and RESUBSCRIBE_LINK as configured in
         lib/edgedesk_pricing.js
     STRIPE_SECRET_KEY=rk_live_… node tools/billing/verify_stripe_offer.js \
         https://buy.stripe.com/<trial> https://buy.stripe.com/<resubscribe>
         checks two links BEFORE they are pasted into the pricing file
     --allow-test   accept a test-mode key and test-mode objects (a dry run;
                    production must pass without it)

   Exit 0: every check passed (warnings are printed). Exit 1: something the
   page promises is not what Stripe sells. Exit 2: could not ask (no key, no
   network).

   Held offline by tools/billing/verify_stripe_offer.test.js.
   =========================================================================== */
'use strict';
const path = require('path');

const PRICING = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_pricing.js'));
const API = 'https://api.stripe.com/v1/';
const RETURN_URL = 'https://edgedesksports.com/?checkout=success';

/* ── asking Stripe ──────────────────────────────────────────────────────── */
function stripeGetter(key, fetchImpl) {
  const f = fetchImpl || fetch;
  return async function get(p, params) {
    const q = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      (Array.isArray(v) ? v : [v]).forEach((x) => q.append(k, String(x)));
    });
    const r = await f(API + p + (q.toString() ? '?' + q : ''), { headers: { authorization: 'Bearer ' + key } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error('stripe ' + r.status + ' ' + ((body.error && body.error.message) || ''));
      e.status = r.status;
      throw e;
    }
    return body;
  };
}

/* Every payment link in the account, so a URL can be matched to its object.
   Stripe has no "find by URL", and a link's id is not in its URL. */
async function allPaymentLinks(get) {
  const out = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const params = { limit: 100 };
    if (after) params.starting_after = after;
    const res = await get('payment_links', params);
    const data = (res && res.data) || [];
    out.push(...data);
    if (!res.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

/* ── the checks ─────────────────────────────────────────────────────────── */
/* links: [{ kind: 'trial'|'resubscribe', url }]
   mode:  'live' (the default, and what production must pass) or 'test' */
async function verifyOffer(opts) {
  const X = opts.pricing || PRICING;
  const get = opts.get;
  const mode = opts.mode === 'test' ? 'test' : 'live';
  const results = [];
  const say = (level, link, check, detail) => results.push({ level, link, check, detail: detail || '' });

  const links = await allPaymentLinks(get);
  const byUrl = new Map(links.map((l) => [String(l.url || '').trim(), l]));

  for (const want of opts.links) {
    const name = want.kind === 'resubscribe' ? 'RESUBSCRIBE_LINK' : 'CHECKOUT_LINK';
    const url = String(want.url || '').trim();
    const label = name + (url ? ' ' + url : '');

    if (!url) { say('FAIL', label, 'is configured', name + ' is empty in lib/edgedesk_pricing.js — the page refuses to open checkout'); continue; }
    if (X.RETIRED_LINKS.indexOf(url) >= 0) { say('FAIL', label, 'is not a retired link', 'this is one of the retired links, which sold the old price'); continue; }
    if (!X.validLink(url)) { say('FAIL', label, 'is a Stripe checkout link', 'expected https://buy.stripe.com/<code>'); continue; }
    say('PASS', label, 'is a Stripe checkout link');

    const pl = byUrl.get(url);
    if (!pl) { say('FAIL', label, 'exists in this Stripe account', 'no payment link with this URL (a ' + mode + '-mode key sees only ' + mode + '-mode links)'); continue; }
    say(pl.active ? 'PASS' : 'FAIL', label, 'is active', pl.active ? '' : 'the link is deactivated in Stripe');
    const liveOk = mode === 'test' ? true : pl.livemode === true;
    say(liveOk ? 'PASS' : 'FAIL', label, 'is live, not test mode', liveOk ? (mode === 'test' ? 'test mode accepted (--allow-test)' : '') : 'livemode is false');

    const li = await get('payment_links/' + encodeURIComponent(pl.id) + '/line_items', { limit: 10, 'expand[]': 'data.price.product' });
    const items = (li && li.data) || [];
    if (items.length !== 1) { say('FAIL', label, 'sells exactly one item', items.length + ' line items'); continue; }
    const item = items[0], price = item.price || {};
    const product = price.product && typeof price.product === 'object' ? price.product : null;
    say(+item.quantity === 1 ? 'PASS' : 'FAIL', label, 'quantity is 1', 'quantity ' + item.quantity);
    say(price.active ? 'PASS' : 'FAIL', label, 'the price is active, not archived', price.id || '');
    say(price.type === 'recurring' ? 'PASS' : 'FAIL', label, 'the price is recurring, not one-time', price.type || 'no type');
    const cents = price.unit_amount;
    say(cents === X.PRICE_CENTS ? 'PASS' : 'FAIL', label, 'the amount is ' + X.PRICE_DISPLAY,
      cents == null ? 'no fixed unit_amount (tiered or custom pricing)' : 'Stripe charges ' + (X.formatCents(cents, price.currency) || cents + ' ' + price.currency));
    say(String(price.currency || '').toLowerCase() === X.CURRENCY.toLowerCase() ? 'PASS' : 'FAIL', label,
      'the currency is ' + X.CURRENCY, String(price.currency || 'none').toUpperCase());
    const rec = price.recurring || {};
    const monthly = rec.interval === X.BILLING_PERIOD && (+rec.interval_count || 1) === 1;
    say(monthly ? 'PASS' : 'FAIL', label, 'it renews every 1 ' + X.BILLING_PERIOD,
      'every ' + (rec.interval_count || 1) + ' ' + (rec.interval || '?'));
    say(!rec.usage_type || rec.usage_type === 'licensed' ? 'PASS' : 'FAIL', label, 'it is a flat subscription, not metered', rec.usage_type || '');
    if (mode === 'live') say(price.livemode === true ? 'PASS' : 'FAIL', label, 'the price is a live price', price.livemode ? '' : 'test-mode price');

    /* The trial lives on the link (subscription_data) on current Stripe, and on
       the price on older setups. Either counts; the link wins when both exist. */
    const sd = pl.subscription_data || {};
    const trial = sd.trial_period_days != null ? +sd.trial_period_days : (rec.trial_period_days != null ? +rec.trial_period_days : 0);
    if (want.kind === 'resubscribe') {
      say(trial === 0 ? 'PASS' : 'WARN', label, 'no trial (the paywall promises a lapsed reader none)',
        trial ? trial + '-day trial on this link: a lapsed reader would get another free trial' : '');
    } else {
      say(trial === X.TRIAL_DAYS ? 'PASS' : 'FAIL', label, 'a ' + X.TRIAL_DAYS + '-day free trial',
        trial ? trial + '-day trial' : 'no trial: the first charge would land at checkout');
      /* "Stripe holds a card" is on the page and in the consent. */
      if (pl.payment_method_collection && pl.payment_method_collection !== 'always')
        say('WARN', label, 'a card is collected for the trial', 'payment_method_collection is ' + pl.payment_method_collection + '; the page says Stripe holds a card');
      say(pl.allow_promotion_codes ? 'PASS' : 'WARN', label, 'promotion codes are allowed',
        pl.allow_promotion_codes ? '' : 'creator codes (affiliate campaigns) cannot be redeemed on this link');
    }

    if (product) {
      say(product.active === false ? 'FAIL' : 'PASS', label, 'the product is active', product.name || product.id);
      say(product.name === X.PLAN_NAME ? 'PASS' : 'WARN', label, 'Checkout shows "' + X.PLAN_NAME + '"',
        product.name === X.PLAN_NAME ? '' : 'the product is named "' + (product.name || '') + '"');
    }
    const ac = pl.after_completion || {};
    const back = ac.type === 'redirect' && ac.redirect && String(ac.redirect.url || '').indexOf(RETURN_URL) === 0;
    say(back ? 'PASS' : 'WARN', label, 'after payment it returns to ' + RETURN_URL,
      back ? '' : 'a paying customer lands on a Stripe page and never comes back to the product');
  }

  /* The old links still exist in Stripe until somebody switches them off, and
     a bookmarked one still sells the old price. The site refuses them already;
     Stripe should too. */
  for (const old of X.RETIRED_LINKS) {
    const pl = byUrl.get(old);
    if (pl && pl.active) say('WARN', 'retired ' + old, 'is deactivated in Stripe', 'still active: anyone holding this URL can still buy the old price');
    else if (pl) say('PASS', 'retired ' + old, 'is deactivated in Stripe');
  }

  return { ok: !results.some((r) => r.level === 'FAIL'), results };
}

/* ── the command line ───────────────────────────────────────────────────── */
async function main(argv) {
  const args = argv.filter((a) => !/^--/.test(a));
  const allowTest = argv.indexOf('--allow-test') >= 0;
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set. Use a restricted key with read access to Payment Links, Prices and Products.');
    return 2;
  }
  const test = /^(sk|rk)_test_/.test(key);
  if (test && !allowTest) {
    console.error('That is a TEST-mode key. Production must be verified with a live key (rk_live_…); pass --allow-test for a dry run.');
    return 2;
  }
  if (!test && !/^(sk|rk)_live_/.test(key)) {
    console.error('STRIPE_SECRET_KEY does not look like a Stripe key (sk_live_… / rk_live_…).');
    return 2;
  }
  const links = [
    { kind: 'trial', url: args[0] != null ? args[0] : PRICING.CHECKOUT_LINK },
    { kind: 'resubscribe', url: args[1] != null ? args[1] : PRICING.RESUBSCRIBE_LINK },
  ];
  let out;
  try {
    out = await verifyOffer({ get: stripeGetter(key), links, mode: test ? 'test' : 'live' });
  } catch (e) {
    console.error('Could not ask Stripe: ' + ((e && e.message) || e));
    return 2;
  }
  console.log('EdgeDesk offer: ' + PRICING.PLAN_NAME + ' · ' + PRICING.TRIAL_DAYS + ' days free · then ' +
    PRICING.PRICE_DISPLAY + '/' + PRICING.BILLING_PERIOD + ' (' + PRICING.PRICE_CENTS + ' ' + PRICING.CURRENCY + ')');
  out.results.forEach((r) => console.log(r.level.padEnd(4) + ' | ' + r.link + ' | ' + r.check + (r.detail ? ' — ' + r.detail : '')));
  const n = (l) => out.results.filter((r) => r.level === l).length;
  console.log((out.ok ? 'OK' : 'NOT READY') + ' — ' + n('PASS') + ' passed, ' + n('WARN') + ' warnings, ' + n('FAIL') + ' failed');
  return out.ok ? 0 : 1;
}

module.exports = { verifyOffer, stripeGetter, allPaymentLinks };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));

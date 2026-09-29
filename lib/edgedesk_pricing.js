/* ===========================================================================
   EdgeDesk pricing — the ONE place the offer is written down.

   Every page, email and test that states a price, a trial length, a plan
   name or a checkout link reads it from PLAN below:

     index.html              the landing page, the renewal-terms consent (the
                             consent record stores PRICE_DISPLAY, TRIAL_DAYS,
                             BILLING_PERIOD and CONSENT_VERSION verbatim), the
                             trial checkout link, the JSON-LD offer
     app.html                Settings › Subscription and the in-app paywall
                             (SUB_PRICE_DISPLAY, PG_STRIPE_LINK are read here)
     research/sample/        the public sample page's CTA
     methodology/            the methodology page's CTA
     tools/lifecycle/*       trial and renewal emails (the reminder states
                             the amount and the charge date)
     tools/personal/personal_wiring.test.js and
     tools/presentation/landing_positioning.test.js fail when any page drifts
     from it.

   THIS FILE CANNOT CREATE A TRIAL OR CHANGE A PRICE. The amount a customer is
   charged lives on the Stripe price behind PAYMENT_LINK. A page that shows
   one figure while Stripe charges another is an automatic-renewal-law
   problem, not a display bug. So the order of a price change is fixed:

     1. In Stripe: create the Price (and a Payment Link on it with the trial
        and "allow promotion codes"), success URL
        https://edgedesksports.com/?checkout=success
     2. Here: set price_cents, stripe_price_id, payment_link (and the
        no-trial resubscribe link), and bump consent_version.
     3. Run the tests. Nothing else in the repository types a price.

   FOUNDING MEMBERS. The plan is sold as the founding rate: a member keeps the
   rate they subscribed at for as long as they stay continuously subscribed
   (Stripe keeps an existing subscription on its original Price when a new
   Price is created, so this is true by construction, not by promise).
   There is no availability limit unless one is configured below — and
   availability_limit stays null until the operator deliberately sets a real
   one. No countdowns, no scarcity, no "limited time": the offer is the same
   for everybody, every day.

   Browser: window.EDPricing. Node: require('./edgedesk_pricing.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDPricing = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /* ---------------------------------------------------------------- PLAN
     The only block to edit when the offer changes (see the order above). */
  var PLAN = {
    key: 'founding',
    name: 'EdgeDesk Founding Member',
    short_name: 'Founding Member',
    /* what Stripe charges today, in cents. MUST equal the Price behind
       payment_link. (To move to e.g. $39.99: create that Stripe Price and its
       Payment Link first, then set 3999 here with the new link.) */
    price_cents: 7999,
    currency: 'USD',
    billing_period: 'month',
    trial_days: 7,
    founding: true,
    founding_note: 'Founding members keep their rate while continuously subscribed.',
    /* a real cap on founding memberships, or null. null means the page never
       says or implies the offer is limited. */
    availability_limit: null,
    /* Stripe's id for the Price behind payment_link ("price_…"). Optional:
       recorded with checkout_started for reconciliation; null until set. */
    stripe_price_id: null,
    /* the trial checkout (new accounts, through the consent screen) */
    payment_link: 'https://buy.stripe.com/fZufZggqeev36iOf9o8IU0b',
    /* the no-trial checkout for a lapsed subscriber (app.html paywall) */
    resubscribe_link: 'https://buy.stripe.com/cNi00ifmaaeNePk2mC8IU09',
    /* bump whenever any word of the renewal terms changes: billing_consents
       stores it beside the exact text the customer agreed to */
    consent_version: 'arl-2026-08-v6-trial7',
    includes: [
      'NFL + FBS, one terminal',
      'Game markets: spreads, moneylines and totals',
      'Player props, priced at the exact odds',
      'Fair lines, projected scores and win probabilities',
      'EdgeDesk EV at the exact price you’re offered',
      'Matchup, roster and player research',
      'Simulations and outcome ranges',
      'Uncertainty and data quality on every game',
      'The public record and copyable research briefs',
      'Everything included — no tiers'
    ]
  };

  function money(cents) {
    var c = Math.round(+cents);
    if (!isFinite(c) || c < 0) return null;
    return '$' + (c / 100).toFixed(2);
  }

  var X = {
    PLAN: PLAN,
    PLAN_NAME: PLAN.name,
    PRICE_CENTS: PLAN.price_cents,
    PRICE_DISPLAY: money(PLAN.price_cents),
    TRIAL_DAYS: PLAN.trial_days,
    BILLING_PERIOD: PLAN.billing_period,
    CURRENCY: PLAN.currency,
    FOUNDING: !!PLAN.founding,
    FOUNDING_NOTE: PLAN.founding ? PLAN.founding_note : null,
    AVAILABILITY_LIMIT: PLAN.availability_limit == null ? null : +PLAN.availability_limit,
    STRIPE_PRICE_ID: PLAN.stripe_price_id || null,
    PAYMENT_LINK: PLAN.payment_link,
    RESUBSCRIBE_LINK: PLAN.resubscribe_link,
    CONSENT_VERSION: PLAN.consent_version,
    INCLUDES: PLAN.includes.slice(),
    money: money
  };
  /* the line every meaningful trial CTA carries, verbatim */
  X.CTA_LINE = X.TRIAL_DAYS + '-day free trial. ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + ' after trial. Cancel anytime.';
  X.AFTER_TRIAL_LINE = 'After the ' + X.TRIAL_DAYS + '-day free trial, ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '.';
  /* for a reader whose subscription lapsed: no trial is promised */
  X.RESUBSCRIBE_LINE = X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '. Cancel anytime.';
  X.TRIAL_LABEL = X.TRIAL_DAYS + ' days free';
  /* the first day a card can be charged: the day after the trial */
  X.FIRST_CHARGE_DAY = X.TRIAL_DAYS + 1;

  /* A payment link is only ever a Stripe checkout URL. Anything else stops
     checkout before a customer is sent into it. */
  X.validLink = function (u) { return /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/.test(String(u || '')); };

  /* THE RENEWAL REMINDER, worded once for the lifecycle email and the app.
     `at` is the charge date as Stripe states it (trial_end or
     current_period_end); `cents` is what Stripe says it will charge when the
     subscription carries it, else the plan price. Never a countdown. */
  X.renewalLine = function (at, cents) {
    var d = at instanceof Date ? at : new Date(at);
    if (!isFinite(d.getTime())) return null;
    var amt = money(cents == null ? PLAN.price_cents : cents);
    if (!amt) return null;
    var day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return 'Your card will be charged ' + amt + ' on ' + day + ' (UTC) unless you cancel before then.';
  };

  /* A CREATOR CODE'S DISCOUNT, only as Stripe records it: d is the
     `discount` object supabase/affiliates.sql (affiliate_offer) returns once
     Stripe's promotion code exists, is active and matches the campaign. With
     no such record nothing about a discount is said — the checkout still
     carries the code and Stripe decides. The trial and the price above are
     unchanged by it. */
  X.discountLine = function (d, code) {
    if (!d) return null;
    var amt = d.percent_off != null ? (+d.percent_off) + '% off'
      : (d.amount_off_cents != null && String(d.currency || 'USD').toUpperCase() === 'USD' ? '$' + (d.amount_off_cents / 100).toFixed(2) + ' off' : null);
    var n = +d.duration_in_months;
    var dur = d.duration === 'once' ? 'your first payment'
      : (d.duration === 'repeating' && n > 0 ? 'your first ' + n + ' month' + (n === 1 ? '' : 's') : (d.duration === 'forever' ? 'every payment' : null));
    if (!amt || !dur) return null;
    return (code ? 'Code ' + code + ': ' : '') + amt + ' ' + dur + ' after the free trial, applied by Stripe at checkout.';
  };

  /* fill every element that asks for the offer, so no page types it twice:
       data-ed-price="cta"      the trial line
       data-ed-price="after"    what follows the trial
       data-ed-price="resub"    the no-trial line
       data-ed-price="price"    $X.XX
       data-ed-price="trial"    "7 days free"
       data-ed-price="days"     7
       data-ed-price="day8"     8 (the first chargeable day)
       data-ed-price="plan"     the plan's name
       data-ed-price="founding" the founding-member note (hidden when none) */
  X.apply = function (doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.querySelectorAll) return 0;
    var n = 0, els = doc.querySelectorAll('[data-ed-price]');
    var T = { cta: X.CTA_LINE, after: X.AFTER_TRIAL_LINE, resub: X.RESUBSCRIBE_LINE, price: X.PRICE_DISPLAY,
      trial: X.TRIAL_LABEL, days: String(X.TRIAL_DAYS), day8: String(X.FIRST_CHARGE_DAY), plan: X.PLAN_NAME,
      founding: X.FOUNDING_NOTE };
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-ed-price');
      if (!Object.prototype.hasOwnProperty.call(T, k)) continue;
      if (T[k] == null) { els[i].hidden = true; continue; }
      els[i].textContent = T[k]; n++;
    }
    return n;
  };
  return X;
});

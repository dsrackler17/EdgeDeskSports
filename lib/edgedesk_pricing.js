/* ===========================================================================
   EdgeDesk pricing — the ONE place the offer is written down.

   EdgeDesk Full Access: a 7-day free trial, then $49.99 per month. That is the
   standard price, the same for everybody, every day. It is not a founding
   rate, a sale or an introductory figure, and nothing here counts down.

   Two kinds of fact live in this file, and nowhere else:

     THE WORDS   what every page SAYS the offer is. PRICE_CENTS is the one
                 number; PRICE_DISPLAY and every sentence below are derived
                 from it, so a price change is one edit.
     THE LINKS   where every page SENDS a reader to pay: the Stripe Payment
                 Links. A payment link is bound to one Stripe price for life —
                 Stripe does not let a link's price be edited — so a new price
                 means new links, pasted here and in no other file. index.html
                 and app.html read them from here.

   Both are PUBLIC values: a payment link is a URL anybody can open. No Stripe
   secret belongs in this file, or in any file a browser loads.

   The page cannot create a trial or change a price; it can only describe them
   and point at them. So the order of a change is: Stripe first (a new price,
   new links), then `node tools/billing/verify_stripe_offer.js` — which asks
   Stripe whether each link below really sells PRICE_CENTS USD per
   BILLING_PERIOD with the trial it promises — then this file, then the consent
   version in index.html. tools/personal/personal_wiring.test.js fails when a
   page's static copy drifts from what is written here.

   No countdowns, no scarcity, no "limited time": the offer is the same for
   everybody, every day.

   Browser: window.EDPricing. Node: require('./edgedesk_pricing.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDPricing = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = {
    PLAN_NAME: 'EdgeDesk Full Access',
    TRIAL_DAYS: 7,
    PRICE_CENTS: 4999,
    BILLING_PERIOD: 'month',
    CURRENCY: 'USD',

    /* ── THE STRIPE PAYMENT LINKS ──────────────────────────────────────────
       CHECKOUT_LINK     the landing page's trial checkout, reached only after
                         the auto-renewal consent is recorded (index.html
                         confirmArl). Its Stripe price must be PRICE_CENTS USD
                         per month, with a TRIAL_DAYS-day free trial.
       RESUBSCRIBE_LINK  the terminal paywall's link for a reader whose
                         subscription lapsed (app.html). Same price, no trial
                         promised.

       EMPTY UNTIL THE $49.99 LINKS EXIST IN STRIPE. An empty or retired link
       is refused by checkoutLink() below, and both pages stop BEFORE anything
       is recorded or charged and say so — which is the point: a page that
       shows $49.99 and sends the customer to a link that charges $79.99 is a
       customer consenting to one figure and being billed another. */
    CHECKOUT_LINK: '',
    RESUBSCRIBE_LINK: '',

    /* The links that sold the retired $79.99 price. Never sent to again, even
       if one is pasted back above by mistake; deactivate them in Stripe too
       (verify_stripe_offer.js reports any that are still active). */
    RETIRED_LINKS: [
      'https://buy.stripe.com/fZufZggqeev36iOf9o8IU0b',
      'https://buy.stripe.com/cNi00ifmaaeNePk2mC8IU09'
    ],

    /* What the one plan includes, in the order every page lists it. Player
       props are part of Full Access, never an add-on. */
    FEATURES: [
      'NFL + FBS',
      'Game markets',
      'Player props',
      'Fair spreads and projections',
      'EdgeDesk EV',
      'Live market comparison',
      'Matchup research',
      'Player and roster research',
      'Simulation and uncertainty',
      'Power ratings',
      'Public record',
      'Research briefs'
    ]
  };

  /* $49.99 from 4999: whole dollars never lose their cents, so the figure a
     customer consents to is always the figure Stripe charges, to the penny. */
  X.formatCents = function (cents, currency) {
    var c = Number(cents);
    if (!isFinite(c) || c < 0 || Math.round(c) !== c) return null;
    if (String(currency || X.CURRENCY).toUpperCase() !== 'USD') return null;
    return '$' + (c / 100).toFixed(2);
  };
  X.PRICE_DISPLAY = X.formatCents(X.PRICE_CENTS);

  /* the line every meaningful trial CTA carries, verbatim */
  X.CTA_LINE = X.TRIAL_DAYS + '-day free trial. ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + ' after trial. Cancel anytime.';
  X.AFTER_TRIAL_LINE = 'After the ' + X.TRIAL_DAYS + '-day free trial, ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '.';
  X.THEN_LINE = 'Then ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '.';
  /* for a reader whose subscription lapsed: no trial is promised */
  X.RESUBSCRIBE_LINE = X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '. Cancel anytime.';

  /* ── FOR THE FUNNEL (lib/edgedesk_home.js pages, tools/lifecycle/) ──────
     Derived from the facts above, never a second copy of them. */
  X.money = function (cents) { return X.formatCents(Math.round(Number(cents)), X.CURRENCY); };
  /* "7 days free", and the first day a card can be charged: the day after */
  X.TRIAL_LABEL = X.TRIAL_DAYS + ' days free';
  X.FIRST_CHARGE_DAY = X.TRIAL_DAYS + 1;
  /* THE RENEWAL REMINDER, worded once (the trial emails). `at` is the charge
     date as Stripe states it (the subscription's current_period_end); `cents`
     is what Stripe says it will charge that subscription when the ledger
     carries it — a reader who started on an earlier price is reminded of THAT
     price — else PRICE_CENTS. A date, never a timer. */
  X.renewalLine = function (at, cents) {
    var d = at instanceof Date ? at : new Date(at);
    if (!isFinite(d.getTime())) return null;
    var amt = X.money(cents == null ? X.PRICE_CENTS : cents);
    if (!amt) return null;
    var day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return 'Your card will be charged ' + amt + ' on ' + day + ' (UTC) unless you cancel before then.';
  };

  /* A link is sendable only if it is a Stripe checkout link and not one of the
     retired ones. Anything else — empty, mistyped, a billing-portal URL, the
     old $79.99 link — returns '' and the caller stops before any money moves. */
  X.validLink = function (u) {
    u = String(u || '').trim();
    if (!/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/.test(u)) return '';
    for (var i = 0; i < X.RETIRED_LINKS.length; i++) if (X.RETIRED_LINKS[i] === u) return '';
    return u;
  };
  /* kind: 'trial' (the landing page, after consent) or 'resubscribe' */
  X.checkoutLink = function (kind) {
    return X.validLink(kind === 'resubscribe' ? X.RESUBSCRIBE_LINK : X.CHECKOUT_LINK);
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
  /* fill every element that asks for the offer, so no page types it twice */
  X.apply = function (doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.querySelectorAll) return 0;
    var words = { cta: X.CTA_LINE, after: X.AFTER_TRIAL_LINE, resub: X.RESUBSCRIBE_LINE, then: X.THEN_LINE,
                  price: X.PRICE_DISPLAY, monthly: X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD,
                  plan: X.PLAN_NAME, days: String(X.TRIAL_DAYS),
                  trial: X.TRIAL_LABEL, day8: String(X.FIRST_CHARGE_DAY) };
    var n = 0, els = doc.querySelectorAll('[data-ed-price]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-ed-price');
      if (Object.prototype.hasOwnProperty.call(words, k)) { els[i].textContent = words[k]; n++; }
    }
    return n;
  };
  return X;
});

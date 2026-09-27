/* ===========================================================================
   EdgeDesk pricing — the ONE place the displayed offer is written down.

   The offer itself lives on the Stripe price behind the payment link
   (index.html STRIPE_LINK): 7-day free trial, then $79.99 per month. This page
   cannot create a trial or change a price; it can only describe them, so the
   description has one source and tools/personal/pricing_copy.test.js fails
   when index.html's consent constants (PRICE_DISPLAY, TRIAL_DAYS,
   BILLING_PERIOD), app.html's SUB_PRICE_DISPLAY or any trial CTA drift from
   it. Change Stripe first, then this file, then the consent version.

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
    TRIAL_DAYS: 7,
    PRICE_DISPLAY: '$79.99',
    BILLING_PERIOD: 'month',
    CURRENCY: 'USD'
  };
  /* the line every meaningful trial CTA carries, verbatim */
  X.CTA_LINE = X.TRIAL_DAYS + '-day free trial. ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + ' after trial. Cancel anytime.';
  X.AFTER_TRIAL_LINE = 'After the ' + X.TRIAL_DAYS + '-day free trial, ' + X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '.';
  /* for a reader whose subscription lapsed: no trial is promised */
  X.RESUBSCRIBE_LINE = X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD + '. Cancel anytime.';
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
    var n = 0, els = doc.querySelectorAll('[data-ed-price]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-ed-price');
      var t = k === 'cta' ? X.CTA_LINE : (k === 'after' ? X.AFTER_TRIAL_LINE : (k === 'resub' ? X.RESUBSCRIBE_LINE : (k === 'price' ? X.PRICE_DISPLAY : null)));
      if (t) { els[i].textContent = t; n++; }
    }
    return n;
  };
  return X;
});

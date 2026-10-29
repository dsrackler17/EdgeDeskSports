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

       An empty or retired link is refused by checkoutLink() below, and the
       page stops BEFORE anything is recorded or charged and says so — which
       is the point: a page that shows $49.99 and sends the customer to a link
       that charges $79.99 is a customer consenting to one figure and being
       billed another. RESUBSCRIBE_LINK is empty until its no-trial $49.99
       link exists; until then a lapsed reader is asked to email support. */
    CHECKOUT_LINK: 'https://buy.stripe.com/28E9AS7TI3Qp9v0bXc8IU0c',
    RESUBSCRIBE_LINK: '',

    /* THE BILLING PORTAL: where a subscriber manages, switches or cancels —
       never a checkout. California ARL requires that a subscription bought
       online can be cancelled online, so every page that sells one links
       here (app.html Settings, the Bet Checker page). portalLink() refuses
       anything that is not a billing.stripe.com portal link: a checkout link
       here would sell a second subscription to somebody trying to cancel. */
    PORTAL_LINK: 'https://billing.stripe.com/p/login/9B64gy5LA3QpcHc8L08IU00',

    /* ── BET CHECKER: the second product ────────────────────────────────────
       Grades the bets a reader already placed (bet-checker/). Free: logging,
       ten instant grades a calendar month, CLV after the close. Bet Checker
       ($7.99/month or $59/year, product metadata tier = red): a grade on
       every bet, stats, splits and the full history. The Research Terminal
       (tier = blue) includes all of it. No trial. Sold through
       create_checkout_session {kind:'bet_checker', plan}, which finds the
       price by its Stripe lookup key and refuses one that does not charge
       PRICE_CENTS per BILLING_PERIOD — so this is the only place the figure
       is written, exactly as for the terminal. */
    BET_CHECKER: {
      PLAN_NAME: 'EdgeDesk Bet Checker',
      CONSENT_VERSION: 'bet-checker-2026-10',
      FREE_MONTHLY_GRADES: 10,
      PLANS: {
        monthly: { PRICE_CENTS: 799, BILLING_PERIOD: 'month', LOOKUP_KEY: 'bet_checker_monthly' },
        annual: { PRICE_CENTS: 5900, BILLING_PERIOD: 'year', LOOKUP_KEY: 'bet_checker_annual' }
      },
      FEATURES: [
        'Every bet graded instantly against EdgeDesk\'s fair price',
        'Running stats: CLV rate, average entry edge, average CLV',
        'Splits by market, sport and book',
        'Your full history'
      ]
    },

    /* ── FAIRLINE: the third product ─────────────────────────────────────────
       Prices, not picks (fairline/): The Board (is this a good number right
       now?), The Leaks (where am I losing money, bad bets or bad luck?) and
       The Tape (the weekly recap), with Bet Checker included. Free: the top of
       The Board and the name of the biggest leak. Fairline ($19.99/month or
       $159/year, product metadata tier = black). The Research Terminal (tier =
       blue) includes all of it; Bet Checker (tier = red) does not. No trial.
       Sold through create_checkout_session {kind:'fairline', plan}, which
       finds the price by its Stripe lookup key and refuses one that does not
       charge PRICE_CENTS per BILLING_PERIOD — so this is the only place the
       figure is written. */
    FAIRLINE: {
      PLAN_NAME: 'EdgeDesk Fairline',
      CONSENT_VERSION: 'fairline-2026-10',
      PLANS: {
        monthly: { PRICE_CENTS: 1999, BILLING_PERIOD: 'month', LOOKUP_KEY: 'fairline_monthly' },
        annual: { PRICE_CENTS: 15900, BILLING_PERIOD: 'year', LOOKUP_KEY: 'fairline_annual' }
      },
      FEATURES: [
        'The Board: every price against EdgeDesk\'s fair, sorted by edge',
        'The Leaks: where you lose money, and whether it is bad bets or bad luck',
        'The Tape: your weekly recap (coming soon)',
        'Bet Checker included: every bet graded, with stats and full history'
      ]
    },

    /* The links that sold the retired $79.99 price. Never sent to again, even
       if one is pasted back above by mistake; deactivate them in Stripe too
       (verify_stripe_offer.js reports any that are still active). */
    RETIRED_LINKS: [
      'https://buy.stripe.com/fZufZggqeev36iOf9o8IU0b',
      'https://buy.stripe.com/cNi00ifmaaeNePk2mC8IU09'
    ],

    /* What the one plan includes TODAY, in the order every page lists it —
       eight lines a reader can take in at a glance. Only what a subscriber
       can open right now belongs here: a feature still in development
       (sportsbook and exchange account connections) is never listed until it
       ships. The Process Coach, the Weekly Film Room, the calendar and the
       CSV and bet slip imports shipped in October 2026 (Portfolio schema
       deployed 2026-10-14). Signal Center and the Simulator joined on
       2026-10-23, both live in production; to stay at eight, the football
       research lines and the journal lines each became one. Player props
       are part of Full Access, never an add-on. Plain text only: no "&",
       because the landing page's plan card and the terminal's paywall both
       print it. */
    FEATURES: [
      'Signal Center: what changed, why, and the evidence',
      'The Simulator: playoff, title and tournament odds',
      'Fair lines and win probabilities on every NFL and FBS game',
      'Live market comparison and EdgeDesk EV',
      'Player props',
      'Compare your number with the model',
      'Bet journal, profit, ROI and closing-line value',
      'Process Coach and the weekly Film Room'
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
  /* the billing portal, or '' — never a checkout link */
  X.portalLink = function () {
    var u = String(X.PORTAL_LINK || '').trim();
    return /^https:\/\/billing\.stripe\.com\/[A-Za-z0-9/_-]+$/.test(u) ? u : '';
  };

  /* ── BET CHECKER'S WORDS, derived from BET_CHECKER above ─────────────── */
  X.betCheckerOffer = function (plan) {
    var p = X.BET_CHECKER.PLANS[plan === 'annual' ? 'annual' : 'monthly'];
    var price = X.formatCents(p.PRICE_CENTS);
    return { plan: plan === 'annual' ? 'annual' : 'monthly', price_cents: p.PRICE_CENTS, price_display: price,
             billing_period: p.BILLING_PERIOD, trial_days: 0, consent_version: X.BET_CHECKER.CONSENT_VERSION,
             short: price + '/' + p.BILLING_PERIOD };
  };
  /* THE AUTOMATIC-RENEWAL TERMS for Bet Checker, worded once. The page shows
     exactly this, records exactly this in billing_consents, and the server
     refuses a Stripe price that does not charge this figure. */
  X.betCheckerTerms = function (plan) {
    var o = X.betCheckerOffer(plan);
    var every = o.billing_period === 'year' ? 'every year' : 'every month';
    return X.BET_CHECKER.PLAN_NAME + ' \u2014 ' + o.price_display + ' per ' + o.billing_period + ', renews automatically. ' +
      'You are charged ' + o.price_display + ' today, and ' + o.price_display + ' again ' + every + ' on that same date, until you cancel. ' +
      'There is no free trial. Cancel anytime in Settings \u203a Subscription on the Bet Checker page (Manage billing), ' +
      'or by emailing support@edgedesksports.com. Cancelling stops every future charge, and access continues to the end ' +
      'of the period you have already paid for. Fees already charged are non-refundable.';
  };

  /* ── FAIRLINE'S WORDS, derived from FAIRLINE above ───────────────────── */
  X.fairlineOffer = function (plan) {
    var p = X.FAIRLINE.PLANS[plan === 'annual' ? 'annual' : 'monthly'];
    var price = X.formatCents(p.PRICE_CENTS);
    return { plan: plan === 'annual' ? 'annual' : 'monthly', price_cents: p.PRICE_CENTS, price_display: price,
             billing_period: p.BILLING_PERIOD, trial_days: 0, consent_version: X.FAIRLINE.CONSENT_VERSION,
             short: price + '/' + p.BILLING_PERIOD };
  };
  /* THE AUTOMATIC-RENEWAL TERMS for Fairline, worded once: shown, recorded in
     billing_consents exactly as shown, and the server refuses a Stripe price
     that does not charge this figure. */
  X.fairlineTerms = function (plan) {
    var o = X.fairlineOffer(plan);
    var every = o.billing_period === 'year' ? 'every year' : 'every month';
    return X.FAIRLINE.PLAN_NAME + ' \u2014 ' + o.price_display + ' per ' + o.billing_period + ', renews automatically. ' +
      'You are charged ' + o.price_display + ' today, and ' + o.price_display + ' again ' + every + ' on that same date, until you cancel. ' +
      'There is no free trial. Cancel anytime in Settings \u203a Subscription on the Fairline page (Manage billing), ' +
      'or by emailing support@edgedesksports.com. Cancelling stops every future charge, and access continues to the end ' +
      'of the period you have already paid for. Fees already charged are non-refundable.';
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
  /* THE WORDS a page asks for by name (data-ed-price="<key>"), every one
     derived from the facts above, never typed. The bc_ words are Bet
     Checker's, from BET_CHECKER through betCheckerOffer(): its plan, its
     monthly price, both plans as "$7.99/month" and "$59.00/year" (cents kept,
     as everywhere here: the figure the consent sheet shows), and the free
     grades a calendar month. */
  X.priceWords = function () {
    var bm = X.betCheckerOffer('monthly'), ba = X.betCheckerOffer('annual');
    return { cta: X.CTA_LINE, after: X.AFTER_TRIAL_LINE, resub: X.RESUBSCRIBE_LINE, then: X.THEN_LINE,
             price: X.PRICE_DISPLAY, monthly: X.PRICE_DISPLAY + '/' + X.BILLING_PERIOD,
             plan: X.PLAN_NAME, days: String(X.TRIAL_DAYS),
             trial: X.TRIAL_LABEL, day8: String(X.FIRST_CHARGE_DAY),
             bc_plan: X.BET_CHECKER.PLAN_NAME, bc_price: bm.price_display, bc_monthly: bm.short,
             bc_annual: ba.short, bc_free: String(X.BET_CHECKER.FREE_MONTHLY_GRADES) };
  };
  /* fill every element that asks for the offer, so no page types it twice */
  X.apply = function (doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.querySelectorAll) return 0;
    var words = X.priceWords();
    var n = 0, els = doc.querySelectorAll('[data-ed-price]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-ed-price');
      if (Object.prototype.hasOwnProperty.call(words, k)) { els[i].textContent = words[k]; n++; }
    }
    return n;
  };
  return X;
});

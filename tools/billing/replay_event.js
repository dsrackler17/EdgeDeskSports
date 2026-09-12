#!/usr/bin/env node
/* ===========================================================================
   THE DRY RUN, WITH NOTHING AT RISK.

   Before a discount code is pointed at live money there is exactly one thing
   that cannot be known from this repository: WHERE THIS STRIPE ACCOUNT PUTS
   THE PROMOTION CODE. Stripe has moved it — `session.discounts` arrived in API
   version 2025-01-27.acacia, older versions carry it elsewhere or not at all —
   and which shape is delivered depends on the account's own API version. Read
   the wrong field and the webhook records "no code used" for a sale that used
   one, silently, forever.

   So: take a REAL delivery from your own account, in test mode, and run it
   through the REAL reader from the deployed file. No network, no database, no
   deploy, no Stripe key, nothing written anywhere.

     Stripe Dashboard (test mode) → Developers → Events → the
     checkout.session.completed from your test checkout → copy the JSON

     node tools/billing/replay_event.js /tmp/evt.json
     pbpaste | node tools/billing/replay_event.js -

   It prints the row the webhook would write. If the promotion code is not
   found, the payload itself is printed so you can see where Stripe actually
   put it — which is the answer, not a bug report.

   Run: node tools/billing/replay_event.js <file.json | ->
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'stripe_webhook', 'index.ts');

/* The SAME pure half the deployed function serves. There is no second copy to
   drift: if the reader changes, this replays the change. */
const SRC = fs.readFileSync(FN, 'utf8');
const api = {};
new Function('module', 'exports', 'crypto', 'TextEncoder',
  SRC.slice(0, SRC.indexOf('async function handle(')) +
  '\n;module.exports={readEvent,readDiscount,hasDiscount,normCode,periodEnd,idOf,BUILD};'
)(api, api, require('crypto').webcrypto, TextEncoder);
const W = api.exports || api;

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node tools/billing/replay_event.js <event.json | ->');
  process.exit(2);
}
let raw;
try {
  raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
} catch (e) {
  console.error('could not read ' + arg + ': ' + (e && e.message));
  process.exit(2);
}

/* A pasted payload should never contain a key, but people paste in a hurry and
   this prints to a terminal that gets screenshotted. Say so and stop. */
if (/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/.test(raw) || /\bwhsec_[A-Za-z0-9]{10,}/.test(raw)) {
  console.error('REFUSING: that file contains something shaped like a Stripe secret key.');
  console.error('An event payload has no key in it — check you copied the event and not a request log.');
  process.exit(2);
}

let event;
try { event = JSON.parse(raw); } catch (e) {
  console.error('that is not JSON: ' + (e && e.message));
  process.exit(2);
}

/* The dashboard lets you copy either the whole event or just the object, and
   both are useful here, so both are accepted. */
if (!event.type && event.object === 'checkout.session') {
  event = { id: 'evt_pasted', type: 'checkout.session.completed', livemode: event.livemode,
            created: Math.floor(Date.now() / 1000), data: { object: event } };
}
if (!event.type && event.object === 'subscription') {
  event = { id: 'evt_pasted', type: 'customer.subscription.updated', livemode: event.livemode,
            created: Math.floor(Date.now() / 1000), data: { object: event } };
}

const read = W.readEvent(event);
const obj = (event.data && event.data.object) || {};

console.log('');
console.log('  build under test   ' + W.BUILD);
console.log('  event              ' + (event.id || '(none)') + '   ' + (event.type || '(no type)'));
console.log('  livemode           ' + (event.livemode === false ? 'false — TEST MODE (correct for a dry run)'
                                                                : String(event.livemode)));
console.log('');

if (!read) {
  console.log('  This is not an event the webhook acts on. It would be recorded in');
  console.log('  public.stripe_events and answered 200, and nothing else.');
  console.log('');
  process.exit(0);
}

console.log('  READ FROM THE EVENT');
console.log('    user_id (client_reference_id)  ' + (read.user_id || '— none; the customer would be'
  + ' resolved by customer id or confirmed email instead'));
console.log('    stripe_customer_id            ' + (read.customer_id || '—'));
console.log('    stripe_subscription_id        ' + (read.subscription_id || '—'));
console.log('    status                        ' + (read.status || '— (a checkout carries none; the'
  + ' webhook asks Stripe for it)'));
console.log('');

const d = read.discount;
console.log('  THE DISCOUNT');
if (!W.hasDiscount(d)) {
  console.log('    NO DISCOUNT FOUND on this payload.');
  console.log('');
  if (/promotion_code|discount/i.test(raw)) {
    console.log('    …but the payload does mention a discount. That is the case this script');
    console.log('    exists for: this account puts it somewhere the reader does not look.');
    console.log('    The fields it searches are session.discounts[], ');
    console.log('    session.total_details.breakdown.discounts[] and .discount. Here is what');
    console.log('    the payload actually holds:');
    console.log('');
    ['discounts', 'discount', 'total_details'].forEach((k) => {
      if (obj[k] !== undefined) console.log('      ' + k + ': ' + JSON.stringify(obj[k]));
    });
    console.log('');
    console.log('    Send that to readDiscount() in the deployed file and add the shape.');
  } else {
    console.log('    The payload mentions no discount at all, so this checkout used no code.');
    console.log('    The subscription would report as (unattributed), which is correct.');
  }
  console.log('');
  process.exit(0);
}

console.log('    stripe_promotion_code_id      ' + (d.promotion_code_id || '—'));
console.log('    stripe_coupon_id              ' + (d.coupon_id || '—'));
console.log('    code, read straight off it    ' + (d.code || '— not on the payload'));
console.log('');
console.log('  WHAT WOULD BE WRITTEN to public.subscriptions');
if (d.code) {
  console.log('    referral_code     ' + d.code);
  console.log('    referral_source   <where it was seen>:inline');
  console.log('    …no lookup needed: the code is on the payload itself.');
} else if (d.promotion_code_id) {
  console.log('    referral_code     resolved from ' + d.promotion_code_id + ', by');
  console.log('                      (1) public.referral_codes, matched on stripe_promotion_code_id');
  console.log('                          — paste that id into supabase/referral_codes.sql and this');
  console.log('                          works with no Stripe call at all; then');
  console.log('                      (2) GET /v1/promotion_codes/' + d.promotion_code_id);
  console.log('                          — which needs STRIPE_SECRET_KEY_TEST set for a test event.');
  console.log('    Neither can be checked from here, on purpose: this script makes no network call.');
} else {
  console.log('    referral_code     null — a coupon was applied with NO promotion code behind it.');
  console.log('    referral_source   <where it was seen>:unnamed_discount');
  console.log('    Two promotion codes can share one coupon, so this names no partner and the');
  console.log('    report shows it on its own line rather than crediting a guess.');
}
console.log('');

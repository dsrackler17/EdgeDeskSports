#!/usr/bin/env node
/* ===========================================================================
   /admin/billing/ — the verdict an operator reads first.

   Every account is put in exactly ONE of five classes, and the class is only
   ever "systems agree" when Stripe was actually asked. These cases are lifted
   out of the shipped page (admin/billing/index.html) and run as written.

   Run: node tools/billing/admin_console.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin', 'billing', 'index.html'), 'utf8');
const ACCESS = require(path.join(ROOT, 'lib', 'edgedesk_access.js'));

let pass = 0, fail = 0;
const chk = (label, ok, detail) => { if (ok) pass++; else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } };

function lift(name) {
  const i = HTML.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no function ' + name);
  let depth = 0, j = HTML.indexOf('{', i);
  for (; j < HTML.length; j++) { if (HTML[j] === '{') depth++; else if (HTML[j] === '}' && --depth === 0) break; }
  return HTML.slice(i, j + 1);
}
const src = ['esc', 'when', 'kv', 'stripeGrants', 'classify', 'renderReport'].map(lift).join('\n');
const page = new Function('window', src + '\nreturn { classify, renderReport };')({ EDAccess: ACCESS });

chk('the page loads the one JS copy of the rule', /<script src="\/lib\/edgedesk_access\.js\?v=/.test(HTML));
chk('the five verdicts are all the page can say',
  ['ACCESS GRANTED — systems agree', 'ACCESS GRANTED — Stripe/DB mismatch', 'ACCESS DENIED — systems agree',
   'ACCESS DENIED — billing unresolved', 'COMP ACCESS — not Stripe-managed'].every((l) => HTML.indexOf("'" + l + "'") >= 0) &&
  !/'NO ACCESS'/.test(HTML));

const future = new Date(Date.now() + 9 * 864e5).toISOString();
const past = new Date(Date.now() - 9 * 864e5).toISOString();
const live = (best, extra) => Object.assign({ ok: true, outcome: 'inspect', best, subscriptions: best ? [best] : [], customers: [] }, extra || {});
const sub = (status, pe) => ({ id: 'sub_1', customer_id: 'cus_1', status, current_period_end: pe === undefined ? future : pe, price_id: 'price_4999' });
const L = (rep) => page.classify(rep).label;

// COMP
chk('owner_comp → COMP ACCESS', L({ access: { has_access: true, is_comp: true, reason: 'comp' }, row: { status: 'active', price_id: 'owner_comp' }, stripe_live: live(null) }) === 'COMP ACCESS — not Stripe-managed');
const ct = { access: { has_access: true, is_comp_trial: true, reason: 'comp_trial', access_until: future }, row: { status: 'trialing', price_id: 'comp_trial' } };
chk('a hand-made comp_trial (the reported customer\'s repair) → COMP ACCESS, even with Stripe unreachable',
  L(Object.assign({}, ct, { stripe_live: live(null) })) === 'COMP ACCESS — not Stripe-managed' &&
  L(Object.assign({}, ct, { stripe_live: null })) === 'COMP ACCESS — not Stripe-managed');
chk('… and says so when Stripe ALSO has a live subscription for it (Repair converts it)',
  /Repair from Stripe makes it Stripe-managed/.test(page.classify(Object.assign({}, ct, { stripe_live: live(sub('trialing')) })).why));

// GRANTED
const paying = { access: { has_access: true, reason: 'active' }, row: { status: 'active', stripe_subscription_id: 'sub_1' } };
chk('paying, Stripe active → GRANTED, systems agree', L(Object.assign({}, paying, { stripe_live: live(sub('active')) })) === 'ACCESS GRANTED — systems agree');
chk('trialing in both → agree', L(Object.assign({}, paying, { stripe_live: live(sub('trialing')) })) === 'ACCESS GRANTED — systems agree');
chk('Stripe NOT asked is never "agree"', L(Object.assign({}, paying, { stripe_live: null })) === 'ACCESS GRANTED — Stripe/DB mismatch' &&
  /unproven/.test(page.classify(Object.assign({}, paying, { stripe_live: null })).why));
chk('Stripe unreachable is never "agree"', L(Object.assign({}, paying, { stripe_live: { ok: false, outcome: 'stripe_error' } })) === 'ACCESS GRANTED — Stripe/DB mismatch');
chk('EdgeDesk grants, Stripe canceled → mismatch', L(Object.assign({}, paying, { stripe_live: live(sub('canceled')) })) === 'ACCESS GRANTED — Stripe/DB mismatch');
chk('EdgeDesk grants, Stripe\'s period ended → mismatch (the rule, not just the status)', L(Object.assign({}, paying, { stripe_live: live(sub('active', past)) })) === 'ACCESS GRANTED — Stripe/DB mismatch');
chk('a duplicate purchase → mismatch, with the reason', L(Object.assign({}, paying, { stripe_live: live(sub('active')), stripe_mismatches: ['2 live subscriptions (duplicate purchase)'] })) === 'ACCESS GRANTED — Stripe/DB mismatch');
chk('a hand-made row with nothing in Stripe → mismatch', L({ access: { has_access: true, reason: 'active' }, row: { status: 'active' }, stripe_live: live(null) }) === 'ACCESS GRANTED — Stripe/DB mismatch');
chk('open alerts keep it out of "agree"', L(Object.assign({}, paying, { stripe_live: live(sub('active')), alerts: [{ kind: 'identity_conflict' }] })) === 'ACCESS GRANTED — Stripe/DB mismatch');

// DENIED
const none = { access: { has_access: false, reason: 'no_subscription', offer: 'trial' }, row: null };
chk('no row, Stripe has nothing → DENIED, systems agree', L(Object.assign({}, none, { stripe_live: live(null) })) === 'ACCESS DENIED — systems agree');
chk('canceled in both → DENIED, agree', L({ access: { has_access: false, reason: 'canceled', offer: 'resubscribe' }, row: { status: 'canceled', stripe_subscription_id: 'sub_1' }, stripe_live: live(sub('canceled')) }) === 'ACCESS DENIED — systems agree');
chk('Stripe says trialing, EdgeDesk denies → DENIED, billing unresolved (press Repair)',
  L(Object.assign({}, none, { stripe_live: live(sub('trialing')) })) === 'ACCESS DENIED — billing unresolved' &&
  /Repair from Stripe/.test(page.classify(Object.assign({}, none, { stripe_live: live(sub('trialing')) })).why));
chk('unresolved deliveries that may be theirs → unresolved (Link customer)',
  /Link customer/.test(page.classify(Object.assign({}, none, { stripe_live: live(null), unresolved_maybe_theirs: [{ id: 'evt_1' }] })).why) &&
  L(Object.assign({}, none, { stripe_live: live(null), unresolved_maybe_theirs: [{ id: 'evt_1' }] })) === 'ACCESS DENIED — billing unresolved');
chk('Stripe not asked → unresolved, never "agree"', L(Object.assign({}, none, { stripe_live: null })) === 'ACCESS DENIED — billing unresolved');
chk('an expired comp_trial is denied, not comp', L({ access: { has_access: false, is_comp_trial: true, reason: 'comp_trial_ended', offer: 'trial' }, row: { status: 'trialing', price_id: 'comp_trial' }, stripe_live: live(null) }) === 'ACCESS DENIED — systems agree');

// the card
const html = page.renderReport(Object.assign({ user: { id: 'u-1', email: 'a<b>@x.co' } }, paying, { stripe_live: live(sub('active')) }));
chk('the card leads with the verdict, machine-readable too', /data-verdict="ACCESS GRANTED — systems agree"/.test(html));
chk('and escapes what it prints', html.indexOf('a<b>@x.co') < 0 && html.indexOf('a&lt;b&gt;@x.co') >= 0);
chk('after a repair the card is re-read from Stripe, never assumed (no fabricated ok:true)',
  /action: 'admin_inspect', query: uid/.test(HTML) && !/stripe_live: \{ ok: true, customers: \[\], subscriptions: o\.stripe/.test(HTML));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'admin console — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

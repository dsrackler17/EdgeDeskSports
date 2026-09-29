#!/usr/bin/env node
/* ===========================================================================
   tools/billing/verify_stripe_offer.js, against a fake Stripe.

   The verifier is the only thing standing between "the page says $49.99 with
   a 7-day trial" and "the link charges something else", so every way a link
   can be wrong is built here and each must FAIL: the retired $79.99 price, the
   historical $14.99 and $24.99 prices, a one-time price, a yearly one, an
   archived one, a test-mode one under a live key, a link with no trial, a
   retired or empty link. And the right configuration must pass.

   No network, no key. Run: node tools/billing/verify_stripe_offer.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const V = require(path.join(__dirname, 'verify_stripe_offer.js'));
const X = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_pricing.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) pass++; else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); }
}

const TRIAL = 'https://buy.stripe.com/newTrial4999';
const RESUB = 'https://buy.stripe.com/newResub4999';
const pricing = Object.assign({}, X, { CHECKOUT_LINK: TRIAL, RESUBSCRIBE_LINK: RESUB });

function price(o) {
  return Object.assign({ id: 'price_4999', object: 'price', active: true, type: 'recurring', unit_amount: 4999,
    currency: 'usd', livemode: true, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: 'prod_ed', object: 'product', name: 'EdgeDesk Full Access', active: true } }, o || {});
}
function link(o) {
  return Object.assign({ id: 'plink_trial', object: 'payment_link', url: TRIAL, active: true, livemode: true,
    allow_promotion_codes: true, payment_method_collection: 'always',
    subscription_data: { trial_period_days: 7 },
    after_completion: { type: 'redirect', redirect: { url: 'https://edgedesksports.com/?checkout=success' } } }, o || {});
}
/* a fake of the two endpoints the verifier reads */
function fakeStripe(state) {
  return async function get(p, params) {
    if (p === 'payment_links') {
      const all = state.links;
      const start = params && params.starting_after ? all.findIndex((l) => l.id === params.starting_after) + 1 : 0;
      const page = all.slice(start, start + (state.pageSize || 100));
      return { object: 'list', data: page, has_more: start + page.length < all.length };
    }
    const m = /^payment_links\/([^/]+)\/line_items$/.exec(p);
    if (m) return { object: 'list', data: (state.items[decodeURIComponent(m[1])] || []), has_more: false };
    throw new Error('unexpected path ' + p);
  };
}
function good() {
  return {
    links: [link(), link({ id: 'plink_resub', url: RESUB, subscription_data: { trial_period_days: null } })],
    items: { plink_trial: [{ quantity: 1, price: price() }], plink_resub: [{ quantity: 1, price: price() }] },
  };
}
async function run(state, o) {
  return V.verifyOffer(Object.assign({ pricing, get: fakeStripe(state),
    links: [{ kind: 'trial', url: TRIAL }, { kind: 'resubscribe', url: RESUB }] }, o || {}));
}
const fails = (out) => out.results.filter((r) => r.level === 'FAIL').map((r) => r.link + ': ' + r.check + ' ' + r.detail);
const failsOn = (out, re) => out.results.some((r) => r.level === 'FAIL' && re.test(r.check));

(async () => {
  /* ── the right configuration ─────────────────────────────────────────── */
  {
    const out = await run(good());
    chk('the $49.99 monthly price with a 7-day trial passes', out.ok, fails(out).join(' | '));
    chk('and it checked the amount on both links',
      out.results.filter((r) => r.level === 'PASS' && /the amount is \$49\.99/.test(r.check)).length === 2);
    chk('and the trial on the trial link',
      out.results.some((r) => r.level === 'PASS' && /7-day free trial/.test(r.check)));
  }
  /* a trial set on the PRICE (older Stripe setups) counts as well */
  {
    const s = good();
    s.links[0].subscription_data = {};
    s.items.plink_trial[0].price = price({ recurring: { interval: 'month', interval_count: 1, trial_period_days: 7 } });
    chk('a 7-day trial carried on the price instead of the link still passes', (await run(s)).ok);
  }
  /* pagination: the link is on page two */
  {
    const s = good();
    s.pageSize = 1;
    s.links = [link({ id: 'plink_other', url: 'https://buy.stripe.com/someOtherProduct' })].concat(s.links);
    chk('a link on a later page of payment links is still found', (await run(s)).ok);
  }

  /* ── every way it can be wrong ───────────────────────────────────────── */
  const wrongPrice = async (name, p, re) => {
    const s = good(); s.items.plink_trial[0].price = price(p);
    const out = await run(s);
    chk(name, !out.ok && failsOn(out, re), fails(out).join(' | ') || 'passed');
  };
  await wrongPrice('the retired $79.99 price fails', { unit_amount: 7999 }, /the amount is/);
  await wrongPrice('the historical $14.99 price fails', { unit_amount: 1499 }, /the amount is/);
  await wrongPrice('the historical $24.99 price fails', { unit_amount: 2499 }, /the amount is/);
  await wrongPrice('a one-time price fails', { type: 'one_time', recurring: null }, /recurring, not one-time/);
  await wrongPrice('a yearly price fails', { recurring: { interval: 'year', interval_count: 1 } }, /renews every 1 month/);
  await wrongPrice('every three months fails', { recurring: { interval: 'month', interval_count: 3 } }, /renews every 1 month/);
  await wrongPrice('an archived price fails', { active: false }, /active, not archived/);
  await wrongPrice('a test-mode price under a live key fails', { livemode: false }, /live price/);
  await wrongPrice('a price in another currency fails', { currency: 'eur' }, /currency is USD/);
  await wrongPrice('tiered pricing with no fixed amount fails', { unit_amount: null }, /the amount is/);
  await wrongPrice('a metered price fails', { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }, /not metered/);
  {
    const s = good(); s.links[0].subscription_data = { trial_period_days: null };
    const out = await run(s);
    chk('a trial link with no trial fails — the first charge would land at checkout', !out.ok && failsOn(out, /7-day free trial/), fails(out).join(' | '));
  }
  {
    const s = good(); s.links[0].subscription_data = { trial_period_days: 14 };
    chk('a 14-day trial fails — the consent says 7', !(await run(s)).ok);
  }
  {
    const s = good(); s.links[0].active = false;
    const out = await run(s);
    chk('a deactivated link fails', !out.ok && failsOn(out, /is active/));
  }
  {
    const s = good(); s.links[0].livemode = false;
    const out = await run(s);
    chk('a test-mode link fails under a live key', !out.ok && failsOn(out, /live, not test mode/));
    s.items.plink_trial[0].price = price({ livemode: false });
    s.items.plink_resub[0].price = price({ livemode: false });
    s.links[1].livemode = false;
    chk('but passes a dry run with --allow-test', (await run(s, { mode: 'test' })).ok);
  }
  {
    const s = good(); s.items.plink_trial.push({ quantity: 1, price: price({ id: 'price_addon', unit_amount: 1000 }) });
    chk('two line items fail', !(await run(s)).ok);
  }
  {
    const s = good(); s.items.plink_trial[0].quantity = 2;
    chk('a quantity of two fails', !(await run(s)).ok);
  }
  {
    const s = good();
    const out = await run(s, { links: [{ kind: 'trial', url: 'https://buy.stripe.com/notInThisAccount' }] });
    chk('a link this account does not have fails', !out.ok && failsOn(out, /exists in this Stripe account/));
  }
  {
    const out = await run(good(), { links: [{ kind: 'trial', url: '' }] });
    chk('an empty link fails and says the page will refuse checkout', !out.ok && /refuses to open checkout/.test(fails(out).join(' ')));
  }
  {
    const out = await run(good(), { links: [{ kind: 'trial', url: X.RETIRED_LINKS[0] }] });
    chk('a retired $79.99 link fails by name', !out.ok && failsOn(out, /not a retired link/));
  }
  {
    const out = await run(good(), { links: [{ kind: 'trial', url: 'https://billing.stripe.com/p/login/abc' }] });
    chk('a billing-portal URL is not a checkout link', !out.ok && failsOn(out, /Stripe checkout link/));
  }

  /* ── warnings, not failures ──────────────────────────────────────────── */
  {
    const s = good();
    s.items.plink_trial[0].price = price({ product: { id: 'prod_ed', name: 'EdgeDesk Research Terminal', active: true } });
    s.links[0].allow_promotion_codes = false;
    s.links[0].after_completion = { type: 'hosted_confirmation' };
    s.links[1].subscription_data = { trial_period_days: 7 };
    s.links.push(link({ id: 'plink_old', url: X.RETIRED_LINKS[0] }));
    const out = await run(s);
    const warns = out.results.filter((r) => r.level === 'WARN').map((r) => r.check).join(' | ');
    chk('an old product name, no promo codes, no redirect, a resubscribe trial and a live retired link only warn', out.ok, fails(out).join(' | '));
    chk('the product name is flagged', /Checkout shows "EdgeDesk Full Access"/.test(warns), warns);
    chk('promotion codes are flagged', /promotion codes are allowed/.test(warns), warns);
    chk('the missing return redirect is flagged', /returns to https:\/\/edgedesksports\.com\/\?checkout=success/.test(warns), warns);
    chk('a trial on the resubscribe link is flagged', /no trial \(the paywall/.test(warns), warns);
    chk('a retired link still active in Stripe is flagged', /is deactivated in Stripe/.test(warns), warns);
  }

  /* ── the file as shipped ─────────────────────────────────────────────── */
  chk('the offer the verifier checks is $49.99 USD a month with 7 days free',
    X.PRICE_CENTS === 4999 && X.PRICE_DISPLAY === '$49.99' && X.CURRENCY === 'USD' && X.BILLING_PERIOD === 'month' && X.TRIAL_DAYS === 7);
  chk('the verifier reads the one pricing file, not a copy', /require\(path\.join\(__dirname, '\.\.', '\.\.', 'lib', 'edgedesk_pricing\.js'\)\)/
    .test(require('fs').readFileSync(path.join(__dirname, 'verify_stripe_offer.js'), 'utf8')));

  if (failures.length) failures.forEach((f) => console.log('FAIL  ' + f));
  console.log((fail ? '' : 'ALL GREEN ') + 'verify stripe offer: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

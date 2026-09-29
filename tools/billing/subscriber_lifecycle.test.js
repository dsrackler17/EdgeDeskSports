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
                   whole — signature check, ledger, ordering guard, the Stripe
                   read-back on checkout — under a tiny Deno shim, against an
                   in-memory PostgREST and a fake Stripe API
     the paywall   pgEntitled() and the Settings card, lifted out of app.html
     the offer     lib/edgedesk_pricing.js

   The new-user path: subscription.created arrives before the checkout and is
   kept unresolved → checkout.session.completed names the account, the
   function asks Stripe for the subscription (7-day trial, $49.99/month) →
   trialing, entitled, "Trial ends <the trial's own end>" → day 8,
   invoice.payment_succeeded and subscription.updated → active, "Next billing
   date" → a failed renewal → past_due, still entitled while Stripe retries →
   cancel at period end → "Access ends" → subscription.deleted → locked.

   And the existing subscriber, still on $79.99 until they are moved in Stripe:
   exactly as entitled, and moved without a moment's loss of access.

   No network, no database, no key. Run: node tools/billing/subscriber_lifecycle.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); } }

const ROOT = path.join(__dirname, '..', '..');
const HOOK = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'stripe_webhook', 'index.ts'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));

/* ── an in-memory PostgREST, just the calls the webhook makes ───────────── */
function makeDb() {
  const T = { stripe_events: [], subscriptions: [], referral_codes: [] };
  const KEY = { stripe_events: 'id', subscriptions: 'user_id' };
  const filt = (rows, qs) => {
    let out = rows;
    for (const [k, v] of qs) {
      if (['select', 'limit', 'on_conflict'].indexOf(k) >= 0) continue;
      if (v.indexOf('eq.') === 0) out = out.filter((r) => String(r[k]) === decodeURIComponent(v.slice(3)));
      else if (v === 'is.null') out = out.filter((r) => r[k] == null);
    }
    return out;
  };
  async function handle(url, init) {
    const u = new URL(url);
    const table = u.pathname.replace(/^\/rest\/v1\//, '');
    const qs = [...u.searchParams.entries()];
    const method = (init && init.method) || 'GET';
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (table === 'rpc/stripe_user_by_email') return ok(null);
    if (!T[table]) return { ok: false, status: 404, text: async () => 'no table ' + table, json: async () => ({}) };
    if (method === 'GET') {
      const rows = filt(T[table], qs);
      const lim = +(u.searchParams.get('limit') || rows.length);
      return ok(rows.slice(0, lim).map((r) => Object.assign({}, r)));
    }
    if (method === 'POST') {
      const k = KEY[table];
      for (const row of JSON.parse(init.body)) {
        const cur = T[table].find((r) => r[k] === row[k]);
        if (cur) Object.assign(cur, row); else T[table].push(Object.assign({}, row));
      }
      return ok(null);
    }
    if (method === 'PATCH') {
      filt(T[table], qs).forEach((r) => Object.assign(r, JSON.parse(init.body)));
      return ok(null);
    }
    return { ok: false, status: 405, text: async () => '', json: async () => ({}) };
  }
  return { T, handle };
}

/* ── a fake Stripe API: the one read the webhook makes after a checkout ── */
const STRIPE_SUBS = {};
async function stripeApi(url) {
  const m = /\/v1\/subscriptions\/([^/?]+)/.exec(url);
  if (m && STRIPE_SUBS[m[1]]) return { ok: true, status: 200, json: async () => STRIPE_SUBS[m[1]] };
  return { ok: false, status: 404, json: async () => ({}) };
}

/* ── the deployed webhook, whole, under a Deno shim ─────────────────────── */
const SECRET = 'whsec_lifecycle_test';
const ENV = { STRIPE_WEBHOOK_SECRET: SECRET, SB_URL: 'https://db.test', SB_SERVICE_ROLE: 'service', STRIPE_SECRET_KEY: 'rk_live_test' };
const DB = makeDb();
let handler = null;
const quiet = { log() {}, warn() {}, error() {} };
new Function('Deno', 'crypto', 'TextEncoder', 'fetch', 'console', HOOK)(
  { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } },
  crypto.webcrypto, TextEncoder,
  (url, init) => (String(url).indexOf('https://api.stripe.com/') === 0 ? stripeApi(url) : DB.handle(url, init)),
  quiet);
chk('the deployed webhook loads and serves a handler', typeof handler === 'function');

let clock = Math.floor(Date.now() / 1000) - 3600;
let delivered = 0;
async function deliver(type, object) {
  clock += 60; delivered++;
  const body = JSON.stringify({ id: 'evt_' + crypto.randomBytes(6).toString('hex'), object: 'event', type,
    created: clock, livemode: true, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(t + '.' + body).digest('hex');
  const res = await handler({ method: 'POST', text: async () => body,
    headers: { get: (h) => (h.toLowerCase() === 'stripe-signature' ? 't=' + t + ',v1=' + sig : null) } });
  return { status: res.status, body: await res.json() };
}
const sub = (id, o) => Object.assign({ id, object: 'subscription', customer: 'cus_' + id, status: 'active',
  cancel_at_period_end: false, current_period_end: clock + 30 * 86400,
  items: { object: 'list', data: [{ price: { id: 'price_4999', unit_amount: 4999, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } }, o || {});
const withPrice = (s, cents, id) => Object.assign(s, { items: { object: 'list', data: [{ price: { id, unit_amount: cents, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } });
const row = (uid) => DB.T.subscriptions.find((r) => r.user_id === uid) || null;

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
  const U = 'aaaaaaaa-0000-4000-8000-000000000001';
  const trialEnd = clock + 7 * 86400 + 600;
  STRIPE_SUBS.sub_new = sub('sub_new', { customer: 'cus_new', status: 'trialing', current_period_end: trialEnd, trial_end: trialEnd });

  /* Stripe routinely sends the subscription before the checkout that names it */
  let r = await deliver('customer.subscription.created', STRIPE_SUBS.sub_new);
  chk('subscription.created before the checkout: answered 200 and kept, unresolved', r.status === 200 && r.body.unresolved === true, JSON.stringify(r.body));
  chk('and no access is granted to anybody on the strength of it', row(U) === null);
  chk('the ledger kept it against its subscription id', DB.T.stripe_events.some((e) => e.subscription_id === 'sub_new' && e.type === 'customer.subscription.created'));

  r = await deliver('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', client_reference_id: U,
    customer: 'cus_new', subscription: 'sub_new', mode: 'subscription', customer_details: { email: 'new@x.co' } });
  chk('the checkout lands: 200, applied, by client_reference_id', r.status === 200 && r.body.applied === true && r.body.how === 'client_reference_id', JSON.stringify(r.body));
  let s = row(U);
  chk('the function asked Stripe and wrote the real status: trialing', s && s.status === 'trialing', JSON.stringify(s));
  chk('with the trial\'s own end as the period end — nothing invented', s && s.current_period_end === new Date(trialEnd * 1000).toISOString());
  chk('the new trial is entitled: the terminal opens', entitled(s));
  let h = card(s);
  chk('Settings: EdgeDesk Full Access, a 7-day free trial, then $49.99/month',
    /Plan=EdgeDesk Full Access/.test(h) && /7-day free trial/.test(h) && /Then \$49\.99\/month/.test(h), h);
  chk('and the first charge of $49.99 on the day the trial really ends',
    h.indexOf('Trial ends=' + day(s.current_period_end)) >= 0 && /Your first charge of \$49\.99/.test(h), h);

  /* day 8: Stripe charges and moves the subscription to active */
  const period2 = clock + 37 * 86400;
  r = await deliver('invoice.payment_succeeded', { id: 'in_1', object: 'invoice', customer: 'cus_new', subscription: 'sub_new', amount_paid: 4999, currency: 'usd', customer_email: 'new@x.co' });
  chk('the first invoice is recorded and handled', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await deliver('customer.subscription.updated', sub('sub_new', { customer: 'cus_new', status: 'active', current_period_end: period2 }));
  s = row(U);
  chk('day 8: active, entitled', s.status === 'active' && entitled(s), JSON.stringify(s));
  h = card(s);
  chk('Settings: $49.99 / month, with the next billing date Stripe set',
    /Price=\$49\.99 \/ month/.test(h) && h.indexOf('Next billing date=' + day(new Date(period2 * 1000).toISOString())) >= 0, h);

  /* a failed renewal: Stripe retries, access holds, the card says so */
  await deliver('invoice.payment_failed', { id: 'in_2', object: 'invoice', customer: 'cus_new', subscription: 'sub_new', amount_due: 4999, currency: 'usd' });
  await deliver('customer.subscription.updated', sub('sub_new', { customer: 'cus_new', status: 'past_due', current_period_end: period2 }));
  s = row(U);
  chk('a failed payment: past_due, still entitled while Stripe retries', s.status === 'past_due' && entitled(s));
  chk('and Settings says the payment failed', /Payment failed/.test(card(s)));
  await deliver('customer.subscription.updated', sub('sub_new', { customer: 'cus_new', status: 'active', current_period_end: period2 }));
  chk('the retry clears: active again', row(U).status === 'active');

  /* cancellation */
  await deliver('customer.subscription.updated', sub('sub_new', { customer: 'cus_new', status: 'active', current_period_end: period2, cancel_at_period_end: true }));
  s = row(U);
  h = card(s);
  chk('cancelled at period end: still entitled to the end of what was paid for', entitled(s));
  chk('and Settings says when access ends, with no further charge', /Access ends=/.test(h) && /no further charges/.test(h) && !/You will be charged/.test(h), h);
  await deliver('customer.subscription.deleted', sub('sub_new', { customer: 'cus_new', status: 'canceled', current_period_end: period2 }));
  s = row(U);
  chk('subscription.deleted: canceled, and the terminal locks', s.status === 'canceled' && !entitled(s));

  /* a stale event delivered late cannot reopen it */
  clock -= 10 * 86400;
  r = await deliver('customer.subscription.updated', sub('sub_new', { customer: 'cus_new', status: 'active', current_period_end: period2 }));
  clock += 10 * 86400 + 600;
  chk('a late, older "active" cannot resurrect the cancelled subscription', row(U).status === 'canceled' && r.body.applied === false, JSON.stringify(r.body));

  /* ====================================================================== */
  /* THE EXISTING SUBSCRIBER, STILL ON $79.99 UNTIL MOVED IN STRIPE         */
  /* ====================================================================== */
  const E = 'bbbbbbbb-0000-4000-8000-000000000002';
  const endE = clock + 20 * 86400;
  DB.T.subscriptions.push({ user_id: E, status: 'active', stripe_customer_id: 'cus_old', stripe_subscription_id: 'sub_old' });
  r = await deliver('customer.subscription.updated', withPrice(sub('sub_old', { customer: 'cus_old', status: 'active', current_period_end: endE }), 7999, 'price_7999'));
  s = row(E);
  chk('an event carrying the old $79.99 price is applied like any other', r.body.applied === true && s.status === 'active', JSON.stringify(r.body));
  chk('and the subscriber on the old price is entitled', entitled(s));
  chk('the webhook writes no price onto the row, so no price can ever gate it', s.price_id === undefined);
  chk('Settings shows them what Stripe will actually charge until they are moved',
    /You will be charged \$79\.99 on this date/.test(card(s, { unit_amount: 7999, currency: 'usd', billing_interval: 'month', interval_count: 1 })));

  /* moved in Stripe to the $49.99 price */
  r = await deliver('customer.subscription.updated', withPrice(sub('sub_old', { customer: 'cus_old', status: 'active', current_period_end: endE }), 4999, 'price_4999'));
  s = row(E);
  chk('moved to $49.99: still active, still entitled, not a moment\'s gap', r.body.applied === true && s.status === 'active' && entitled(s));
  chk('and Settings follows Stripe to $49.99',
    /You will be charged \$49\.99 on this date/.test(card(s, { unit_amount: 4999, currency: 'usd', billing_interval: 'month', interval_count: 1 })));

  /* and a price nobody sells any more (a historical one) is still just a subscription */
  const H = 'cccccccc-0000-4000-8000-000000000003';
  DB.T.subscriptions.push({ user_id: H, status: 'active', stripe_customer_id: 'cus_hist', stripe_subscription_id: 'sub_hist' });
  await deliver('customer.subscription.updated', withPrice(sub('sub_hist', { customer: 'cus_hist', status: 'active', current_period_end: endE }), 1499, 'price_1499'));
  chk('a subscriber on a long-retired price keeps access too', entitled(row(H)));

  /* an expired trial: Stripe ends it, the terminal locks, the paywall offers $49.99 */
  const T2 = 'dddddddd-0000-4000-8000-000000000004';
  STRIPE_SUBS.sub_t2 = sub('sub_t2', { customer: 'cus_t2', status: 'trialing', current_period_end: clock + 86400 });
  await deliver('checkout.session.completed', { id: 'cs_2', object: 'checkout.session', client_reference_id: T2, customer: 'cus_t2', subscription: 'sub_t2' });
  chk('a second trial starts entitled', entitled(row(T2)));
  await deliver('customer.subscription.deleted', sub('sub_t2', { customer: 'cus_t2', status: 'canceled', current_period_end: clock + 86400 }));
  chk('an ended trial locks', !entitled(row(T2)));
  chk('and its Settings card claims no coming charge', !/You will be charged|first charge/.test(card(row(T2))));

  /* every delivery above was acknowledged; none was dropped */
  chk('every delivery is on the ledger, once', DB.T.stripe_events.length === delivered, DB.T.stripe_events.length + ' of ' + delivered);
  chk('none failed', DB.T.stripe_events.every((e) => e.note !== 'not a handled event type'));

  failures.forEach((f) => console.log('FAIL  ' + f));
  console.log((fail ? '' : 'ALL GREEN ') + 'subscriber lifecycle: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

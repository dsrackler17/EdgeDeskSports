#!/usr/bin/env node
/* ===========================================================================
   THE SHARED BILLING CORE (tools/billing/billing_core.js), OFFLINE.

   1. ONE CORE, THREE COPIES, NO DRIFT. The dashboard deploy bundles one folder,
      so the core is copied into each billing Edge Function. A copy edited in
      place and not here would mean two functions disagreeing about who has
      access. Every copy must be byte-identical to the canonical file.

   2. THE PIECES THAT DECIDE: which of an account's Stripe subscriptions its
      row should describe (a duplicate purchase must never hide the live one),
      how Stripe's API-version differences are read, how parameters are encoded
      for Stripe, how a slow or failing Stripe is handled, and what a log line
      is allowed to contain.

   Run: node tools/billing/billing_core.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); } }
const eq = (n, got, want) => chk(n, JSON.stringify(got) === JSON.stringify(want), { got, want });

const ROOT = path.join(__dirname, '..', '..');
const CORE = fs.readFileSync(path.join(__dirname, 'billing_core.js'), 'utf8').trimEnd() + '\n';
const NAMES = ['grantsAccess', 'idOf', 'periodEnd', 'priceIdOf', 'metadataUserId', 'normalizeSubscription', 'pickBest',
  'maskEmail', 'logLine', 'makeRef', 'formEncode', 'makeStripe', 'makeDb', 'discoverCustomers', 'reconcileUser',
  'COMP_PRICE_IDS', 'CORE_VERSION'];
function load(consoleImpl) {
  return new Function('console', 'crypto', CORE + '\nreturn {' + NAMES.join(',') + '};')(consoleImpl || console, require('crypto').webcrypto);
}
const C = load();

(async () => {
  /* ===================================================================== */
  /* 1. NO DRIFT                                                           */
  /* ===================================================================== */
  for (const fn of ['stripe_webhook', 'create_checkout_session', 'sync_subscription']) {
    const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', fn, 'index.ts'), 'utf8');
    const a = src.indexOf('// ── BEGIN BILLING CORE'), b = src.indexOf('// ── END BILLING CORE');
    const copy = a >= 0 && b > a ? src.slice(a, src.indexOf('\n', b) + 1) : '';
    chk(fn + ' carries the core, byte for byte (run node tools/billing/inline_core.js)', copy === CORE);
    chk(fn + ' has no import that could fail the dashboard bundle', !/^\s*import\s/m.test(src));
    chk(fn + ' hardcodes no secret', !/sk_live_[A-Za-z0-9]{8}|rk_live_[A-Za-z0-9]{8}|whsec_[A-Za-z0-9]{8}|eyJ[A-Za-z0-9_-]{20,}\./.test(src));
    chk(fn + ' names its own build', new RegExp("const BUILD = '" + fn + "-[^']+';").test(src));
  }
  const chkRun = cp.spawnSync(process.execPath, [path.join(__dirname, 'inline_core.js'), '--check'], { encoding: 'utf8' });
  chk('inline_core.js --check agrees', chkRun.status === 0, chkRun.stdout);

  /* ===================================================================== */
  /* 2. READING STRIPE                                                     */
  /* ===================================================================== */
  eq('period end on the subscription (older API versions)', C.periodEnd({ current_period_end: 1789000000 }), new Date(1789000000000).toISOString());
  eq('period end on the items (newer API versions), the latest one',
    C.periodEnd({ items: { data: [{ current_period_end: 1789000000 }, { current_period_end: 1789500000 }] } }), new Date(1789500000000).toISOString());
  eq('no period end anywhere is null, never a bad date', C.periodEnd({ id: 's' }), null);
  eq('one item: its price', C.priceIdOf({ items: { data: [{ price: { id: 'price_4999' } }] } }), 'price_4999');
  eq('legacy plan objects too', C.priceIdOf({ items: { data: [{ plan: { id: 'plan_1' } }] } }), 'plan_1');
  eq('several items: no single price is invented', C.priceIdOf({ items: { data: [{ price: 'a' }, { price: 'b' }] } }), null);
  eq('metadata uuid, lower-cased', C.metadataUserId({ metadata: { supabase_user_id: 'ABCDEF01-0000-4000-8000-000000000001' } }), 'abcdef01-0000-4000-8000-000000000001');
  eq('metadata that is not a uuid is nobody', C.metadataUserId({ metadata: { supabase_user_id: "1' or 1=1" } }), null);
  const n = C.normalizeSubscription({ id: 'sub_1', customer: { id: 'cus_1' }, status: 'trialing', created: 1000,
    cancel_at_period_end: 1, items: { data: [{ price: { id: 'price_4999' }, current_period_end: 2000 }] }, livemode: true });
  eq('a subscription normalised', [n.id, n.customer_id, n.status, n.price_id, n.cancel_at_period_end, n.created_ms, n.livemode],
    ['sub_1', 'cus_1', 'trialing', 'price_4999', true, 1000000, true]);

  /* ===================================================================== */
  /* 3. WHICH SUBSCRIPTION THE ROW DESCRIBES                               */
  /* ===================================================================== */
  const NOW = Date.UTC(2026, 9, 4);
  const sub = (id, status, peDays, createdDays) => ({ id, customer: 'cus_1', status, created: (NOW / 1000) + (createdDays || 0) * 86400,
    current_period_end: peDays == null ? null : (NOW / 1000) + peDays * 86400 });
  let p = C.pickBest([sub('old', 'canceled', -30, -60), sub('new', 'trialing', 7, 0)], NOW);
  eq('a live trial beats an old cancellation', p.best.id, 'new');
  p = C.pickBest([sub('live', 'active', 20, -60), sub('dup_cancelled', 'canceled', 20, 0)], NOW);
  eq('a NEWER cancelled duplicate never hides the live subscription', p.best.id, 'live');
  p = C.pickBest([sub('t', 'trialing', 5, 0), sub('a', 'active', 20, -10)], NOW);
  eq('two live subscriptions: the paid one is shown', p.best.id, 'a');
  eq('and both are reported, so the duplicate is flagged', p.entitled.length, 2);
  p = C.pickBest([sub('pd', 'past_due', -2, -40), sub('inc', 'incomplete_expired', null, 0)], NOW);
  eq('a card being retried (still entitled) beats a checkout that never paid', p.best.id, 'pd');
  p = C.pickBest([sub('pd_old', 'past_due', -30, -40), sub('c', 'canceled', -1, -5)], NOW);
  chk('nothing entitled: something is still shown, and nothing is entitled', p.best && p.entitled.length === 0);
  p = C.pickBest([], NOW);
  chk('no subscriptions: nothing', p.best === null && p.entitled.length === 0);
  p = C.pickBest([sub('x', 'active', 9, 0), sub('x', 'active', 9, 0)], NOW);
  eq('the same subscription twice is one subscription', p.all.length, 1);
  chk('the rule: comp before dates; comp only while active',
    C.grantsAccess({ status: 'active', price_id: 'owner_comp', current_period_end: '2000-01-01' }, NOW) &&
    !C.grantsAccess({ status: 'canceled', price_id: 'owner_comp' }, NOW));

  /* ===================================================================== */
  /* 4. TALKING TO STRIPE                                                  */
  /* ===================================================================== */
  eq('nested parameters are encoded the way Stripe reads them',
    C.formEncode({ mode: 'subscription', metadata: { supabase_user_id: 'u1' }, subscription_data: { metadata: { supabase_user_id: 'u1' }, trial_period_days: 7 },
      line_items: [{ price: 'price_4999', quantity: 1 }], skip: undefined, nothing: null }).join('&'),
    'mode=subscription&metadata%5Bsupabase_user_id%5D=u1&subscription_data%5Bmetadata%5D%5Bsupabase_user_id%5D=u1&subscription_data%5Btrial_period_days%5D=7&line_items%5B0%5D%5Bprice%5D=price_4999&line_items%5B0%5D%5Bquantity%5D=1');
  chk('no key, no client', C.makeStripe('', null) === null);

  let calls = 0;
  let s = C.makeStripe('sk_test_x', async (u, init) => { calls++; return calls === 1
    ? { ok: false, status: 500, json: async () => ({ error: { type: 'api_error' } }) }
    : { ok: true, status: 200, json: async () => ({ id: 'cus_1' }) }; }, { retries: 1, timeoutMs: 1000 });
  eq('a 500 is retried once and then succeeds', (await s.get('/customers/cus_1')).id, 'cus_1');
  calls = 0;
  s = C.makeStripe('sk_test_x', async () => { calls++; return { ok: false, status: 404, json: async () => ({ error: { code: 'resource_missing' } }) }; }, { retries: 3 });
  let err = null; try { await s.get('/customers/nope'); } catch (e) { err = e; }
  chk('a 404 is not retried — it will not get better', err && err.status === 404 && err.code === 'resource_missing' && calls === 1, { calls });
  s = C.makeStripe('sk_test_x', (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), { retries: 0, timeoutMs: 50 });
  err = null; const t0 = Date.now(); try { await s.get('/subscriptions'); } catch (e) { err = e; }
  chk('a Stripe that never answers is abandoned at the deadline', err && err.status === 0 && Date.now() - t0 < 1000, err && err.message);
  let seen = null;
  s = C.makeStripe('sk_test_x', async (u, init) => { seen = { u, init }; return { ok: true, status: 200, json: async () => ({}) }; });
  await s.post('/checkout/sessions', { mode: 'subscription' }, 'idem-1');
  chk('writes carry an idempotency key and are form-encoded',
    seen.init.headers['idempotency-key'] === 'idem-1' && seen.init.headers['content-type'] === 'application/x-www-form-urlencoded' && seen.init.body === 'mode=subscription');
  chk('and are authenticated with the key, which never appears in the URL', seen.init.headers.authorization === 'Bearer sk_test_x' && seen.u.indexOf('sk_test') < 0);

  /* ===================================================================== */
  /* 5. FINDING AN ACCOUNT'S CUSTOMERS — strong evidence, or none          */
  /* ===================================================================== */
  const U = { id: '00000000-0000-4000-8000-000000000001', email: 'Kate@Example.com', email_confirmed: true };
  const stripeData = {
    '/customers/search': { data: [{ id: 'cus_meta', metadata: { supabase_user_id: U.id } }] },
    '/checkout/sessions': { data: [
      { status: 'complete', customer: 'cus_ref', client_reference_id: U.id },
      { status: 'complete', customer: 'cus_someone_else', client_reference_id: '00000000-0000-4000-8000-0000000000ff' },
      { status: 'open', customer: 'cus_open' },
      { status: 'complete', customer: 'cus_noref' }] },
    '/customers': { data: [{ id: 'cus_email', metadata: {} }, { id: 'cus_claimed', metadata: { supabase_user_id: '00000000-0000-4000-8000-0000000000ff' } }] },
  };
  const ctx = (confirmed) => ({
    db: { get: async () => [{ stripe_customer_id: 'cus_known' }] },
    stripe: { get: async (path) => stripeData[path] || { data: [] } },
  });
  let found = await C.discoverCustomers(ctx(), U, { discover: true });
  let ids = found.map((x) => x.id + ':' + x.source);
  chk('known, metadata, our own checkout session, and a confirmed email are all found',
    ['cus_known:known', 'cus_meta:stripe_metadata', 'cus_ref:checkout_session_lookup', 'cus_noref:email_match', 'cus_email:email_match'].every((x) => ids.indexOf(x) >= 0), ids);
  chk('a session somebody else started is never taken', ids.join().indexOf('cus_someone_else') < 0);
  chk('an unfinished checkout is never taken', ids.join().indexOf('cus_open') < 0);
  chk('a customer stamped with another account is never taken', ids.join().indexOf('cus_claimed') < 0);
  found = await C.discoverCustomers(ctx(), Object.assign({}, U, { email_confirmed: false }), { discover: true });
  ids = found.map((x) => x.id + ':' + x.source);
  chk('an UNCONFIRMED email proves nothing: only metadata and our own session reference count',
    ids.indexOf('cus_noref:email_match') < 0 && ids.indexOf('cus_email:email_match') < 0 && ids.indexOf('cus_ref:checkout_session_lookup') >= 0, ids);
  found = await C.discoverCustomers(ctx(), U, { discover: false, extraCustomers: ['cus_event'] });
  eq('without discovery (the webhook), only what is already known plus the event\'s own customer', found.map((x) => x.id), ['cus_known', 'cus_event']);

  /* ===================================================================== */
  /* 6. WHAT A LOG LINE MAY CARRY                                          */
  /* ===================================================================== */
  const lines = [];
  const L = load({ log: (x) => lines.push(x), warn: (x) => lines.push(x), error: (x) => lines.push(x) });
  L.logLine('t', 'info', 'x', { user_id: 'u', customer_id: 'cus_1', email: 'kate@example.com', authorization: 'Bearer abc',
    access_token: 'eyJabc', stripe_secret: 'sk_live_1', card_number: '4242', payment_method: 'pm_1', note: 'y'.repeat(500) });
  const o = JSON.parse(lines[0]);
  chk('ids are kept, for tracing', o.user_id === 'u' && o.customer_id === 'cus_1');
  eq('emails are masked', o.email, 'k***@example.com');
  chk('credentials, cards and payment methods are dropped by name',
    !('authorization' in o) && !('access_token' in o) && !('stripe_secret' in o) && !('card_number' in o) && !('payment_method' in o));
  chk('long values are cut', o.note.length <= 301);
  chk('every line is one JSON object with a timestamp, a service and an event', o.ts && o.svc === 't' && o.event === 'x');
  chk('the reference shape', /^EDS-[A-Z2-9]{6}$/.test(C.makeRef()));

  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'billing core — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

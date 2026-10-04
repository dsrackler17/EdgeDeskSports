#!/usr/bin/env node
/* ===========================================================================
   THE BROWSER'S HALF OF BILLING, OFFLINE.

   lib/edgedesk_access.js is the one client-side door to the access decision,
   and the pages hand it every billing question they used to answer
   themselves. What has to be true of it:

     * it grants NOTHING on its own — a redirect back from Stripe is not proof
     * a read that fails is 'unknown', never a lockout
     * after checkout it retries a BOUNDED number of times and then stops and
       says so — no infinite loop, and never "go and pay again"
     * the Payment Link fallback is taken ONLY when the server function is not
       there; a refusal (already paid, wrong price) is never routed around

   And the two pages, driven from their shipped source:
     app.html    pgCheck asks the decision, and asks the server to reconcile
                 with Stripe ONCE before it shows a paywall
     index.html  the success page reads the session id, finalizes, and tells a
                 stuck customer not to make another account or pay again

   Run: node tools/billing/access_client.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); } }
const eq = (n, got, want) => chk(n, got === want, { got, want });

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'lib', 'edgedesk_access.js'));
const CORE_SRC = fs.readFileSync(path.join(__dirname, 'billing_core.js'), 'utf8');
const core = new Function(CORE_SRC + '\nreturn { grantsAccess };')();
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const day = 864e5;
const iso = (ms) => new Date(ms).toISOString();

/* fake fetch: routes -> handler(url, init) */
function fakeFetch(routes, log) {
  return async (url, init) => {
    url = String(url); if (log) log.push((init && init.method || 'GET') + ' ' + url.replace(/^https:\/\/x\.test/, ''));
    for (const [re, h] of routes) if (re.test(url)) return h(url, init);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

(async () => {
  /* ===================================================================== */
  /* 1. THE RULE, MIRRORED — the browser's copy agrees with the server's     */
  /* ===================================================================== */
  const statuses = [null, 'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'mystery'];
  const prices = [null, 'price_4999', 'owner_comp', 'comp_trial'];
  const ends = [null, NOW + 5 * day, NOW - 1000, NOW - 20 * day, NOW - 22 * day];
  let agree = 0, total = 0;
  for (const st of statuses) for (const p of prices) for (const e of ends) {
    const row = { status: st, price_id: p, current_period_end: e == null ? null : iso(e) };
    total++; if (A.grants(row, NOW) === core.grantsAccess(row, NOW)) agree++;
  }
  eq('lib/edgedesk_access.js and the server core agree on every case (' + total + ')', agree, total);
  chk('trialing until the period end', A.grants({ status: 'trialing', current_period_end: iso(NOW + day) }, NOW) && !A.grants({ status: 'trialing', current_period_end: iso(NOW - 1) }, NOW));
  chk('past_due for 21 days, not 22', A.grants({ status: 'past_due', current_period_end: iso(NOW - 20 * day) }, NOW) && !A.grants({ status: 'past_due', current_period_end: iso(NOW - 22 * day) }, NOW));
  chk('owner_comp regardless of date, comp_trial only until its date',
    A.grants({ status: 'active', price_id: 'owner_comp', current_period_end: iso(NOW - 99 * day) }, NOW) &&
    !A.grants({ status: 'trialing', price_id: 'comp_trial', current_period_end: iso(NOW - 1) }, NOW));
  eq('an ended comp_trial is offered the trial', A.offerFor({ status: 'trialing', price_id: 'comp_trial', current_period_end: iso(NOW - day) }), 'trial');
  eq('a cancelled Stripe customer is offered a restart', A.offerFor({ status: 'canceled', stripe_customer_id: 'cus_1' }), 'resubscribe');
  eq('a failing card is told to fix it', A.offerFor({ status: 'unpaid', stripe_customer_id: 'cus_1' }), 'fix_payment');
  chk('a support reference reads EDS-XXXXXX', /^EDS-[A-Z2-9]{6}$/.test(A.makeRef()));

  /* ===================================================================== */
  /* 2. READ                                                               */
  /* ===================================================================== */
  const decision = { signed_in: true, has_access: true, reason: 'trialing', offer: 'none', subscription: { status: 'trialing' } };
  let log = [];
  let r = await A.read({ url: 'https://x.test', key: 'anon', token: 't', fetch: fakeFetch([[/rpc\/my_billing_access$/, () => res(200, decision)]], log) });
  chk('read asks the database decision', r.ok && r.source === 'database' && r.access.has_access === true && /POST \/rest\/v1\/rpc\/my_billing_access/.test(log[0]), { r, log });
  r = await A.read({ url: 'https://x.test', key: 'anon', token: 't', fetch: fakeFetch([
    [/rpc\/my_billing_access$/, () => res(404, { code: 'PGRST202' })],
    [/subscriptions\?select=/, () => res(200, [{ status: 'trialing', price_id: 'comp_trial', current_period_end: iso(Date.now() - day) }])]]) });
  chk('before the migration, it reads the row and applies the same rule', r.ok && r.source === 'row' && r.access.has_access === false && r.access.offer === 'trial', r);
  r = await A.read({ url: 'https://x.test', key: 'anon', token: 't', fetch: fakeFetch([[/rpc/, () => res(401, {})]]) });
  eq('a refused token is signed_out — never a lockout', r.reason, 'signed_out');
  r = await A.read({ url: 'https://x.test', key: 'anon', token: 't', fetch: async () => { throw new Error('offline'); } });
  eq('a network failure is unavailable', r.reason, 'unavailable');
  r = await A.read({ url: 'https://x.test', key: 'anon', token: null, fetch: async () => res(200, decision) });
  eq('no token at all is signed_out, and nothing is asked', r.reason, 'signed_out');
  r = await A.read({ url: 'https://x.test', key: 'anon', token: 't', fetch: fakeFetch([[/rpc/, () => res(200, { signed_in: false, has_access: false })]]) });
  eq('the database saying "nobody" is signed_out', r.reason, 'signed_out');

  /* ===================================================================== */
  /* 3. CHECKOUT                                                           */
  /* ===================================================================== */
  const co = (status, body) => A.startCheckout({ url: 'https://x.test', key: 'anon', token: 't',
    fetch: fakeFetch([[/functions\/v1\/create_checkout_session$/, () => res(status, body)]]) }, { kind: 'trial' });
  r = await co(200, { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_live_1', session_id: 'cs_live_1' });
  chk('a created session is followed', r.ok && r.url === 'https://checkout.stripe.com/c/pay/cs_live_1');
  r = await co(409, { ok: false, reason: 'already_entitled' });
  chk('already paid is a stop, not a fallback', !r.ok && r.reason === 'already_entitled' && r.fallbackOk === false);
  r = await co(409, { ok: false, reason: 'offer_mismatch', message: 'Checkout is being updated' });
  chk('a price that is not the consented one is a stop, never routed to the Payment Link', !r.ok && r.fallbackOk === false && /being updated/.test(r.message));
  r = await co(502, { ok: false, reason: 'stripe_unavailable' });
  chk('Stripe being down is a stop (try again), not a fallback', !r.ok && r.fallbackOk === false);
  r = await co(429, { ok: false, reason: 'rate_limited' });
  chk('a rate limit is a stop', !r.ok && r.fallbackOk === false);
  r = await co(503, { ok: false, reason: 'not_configured', fallback_ok: true });
  chk('a function that is not configured permits the Payment Link', !r.ok && r.fallbackOk === true);
  r = await co(404, {});
  chk('and so does one that is not deployed', !r.ok && r.fallbackOk === true);
  r = await A.startCheckout({ url: 'https://x.test', key: 'anon', token: null, fetch: async () => res(200, {}) }, {});
  chk('no token: nothing is created', !r.ok && r.status === 401 && r.fallbackOk === false);

  /* ===================================================================== */
  /* 4. AFTER CHECKOUT: BOUNDED, AND ONLY EVER ASKS THE SERVER             */
  /* ===================================================================== */
  function finalizeWorld(opts) {
    const o = opts || {};
    const calls = { read: 0, sync: 0, slept: 0, sessions: [] };
    let readsUntilActive = o.readsUntilActive == null ? Infinity : o.readsUntilActive;
    const fetch = fakeFetch([
      [/rpc\/my_billing_access$/, () => {
        calls.read++;
        if (o.readStatus) return res(o.readStatus, {});
        const has = calls.read > readsUntilActive;
        return res(200, { signed_in: true, has_access: has, offer: has ? 'none' : 'trial', subscription: has ? { status: 'trialing' } : null });
      }],
      [/functions\/v1\/sync_subscription$/, (u, init) => {
        calls.sync++;
        const b = JSON.parse(init.body);
        calls.sessions.push(b.session_id || null); calls.source = b.source; calls.ref = b.ref;
        if (o.syncStatus) return res(o.syncStatus, { ok: false });
        const has = o.syncGrantsOn != null && calls.sync >= o.syncGrantsOn;
        return res(200, { ok: true, has_access: has, ref: b.ref, access: { has_access: has } });
      }],
    ]);
    const sleep = async (ms) => { calls.slept += ms; };
    return { calls, cfg: { url: 'https://x.test', key: 'anon', token: () => Promise.resolve('t'), fetch }, sleep };
  }
  let fw = finalizeWorld({ readsUntilActive: 0 });
  r = await A.finalize(fw.cfg, { sleep: fw.sleep, sessionId: 'cs_live_1' });
  chk('already active: opens on the first read, without asking Stripe', r.state === 'active' && fw.calls.read === 1 && fw.calls.sync === 0, fw.calls);

  fw = finalizeWorld({ syncGrantsOn: 1 });
  r = await A.finalize(fw.cfg, { sleep: fw.sleep, sessionId: 'cs_live_1', ref: 'EDS-ABCDEF' });
  chk('webhook not landed yet: the first reconciliation with Stripe opens it', r.state === 'active' && fw.calls.sync === 1, fw.calls);
  chk('and that reconciliation carries the session id and the reference', fw.calls.sessions[0] === 'cs_live_1' && fw.calls.ref === 'EDS-ABCDEF' && fw.calls.source === 'checkout_return');

  fw = finalizeWorld({ readsUntilActive: 3 });
  r = await A.finalize(fw.cfg, { sleep: fw.sleep });
  chk('a webhook that lands a few seconds later is picked up by a later read', r.state === 'active' && fw.calls.read === 4, fw.calls);

  fw = finalizeWorld({});
  r = await A.finalize(fw.cfg, { sleep: fw.sleep, sessionId: 'cs_live_1' });
  const n = A.FINALIZE_DELAYS.length;
  chk('never confirmed: it STOPS, and says pending', r.state === 'pending', r);
  eq('after exactly ' + n + ' reads', fw.calls.read, n);
  chk('asking Stripe a bounded number of times (well inside the server\'s rate limit)', fw.calls.sync >= 2 && fw.calls.sync <= 4, fw.calls.sync);
  const total_ms = A.FINALIZE_DELAYS.reduce((x, y) => x + y, 0);
  chk('within about half a minute', fw.calls.slept === total_ms && total_ms <= 40000, total_ms);
  chk('with growing gaps', A.FINALIZE_DELAYS.every((d, i, arr) => i === 0 || d >= arr[i - 1]));
  chk('and a reference to quote', /^EDS-[A-Z2-9]{6}$/.test(r.ref));

  fw = finalizeWorld({ readStatus: 401 });
  r = await A.finalize(fw.cfg, { sleep: fw.sleep });
  chk('signed out on this browser: stops at once and says so', r.state === 'signed_out' && fw.calls.read === 1 && fw.calls.sync === 0, fw.calls);
  fw = finalizeWorld({ syncStatus: 401 });
  r = await A.finalize(fw.cfg, { sleep: fw.sleep });
  eq('a refused token at the server is signed_out too', r.state, 'signed_out');
  const finSrc = A.finalize.toString();
  chk('finalize grants nothing itself: "active" only ever comes from a server answer',
    !/has_access\s*=\s*true/.test(finSrc) && /if \(a\.ok\) \{ last = a\.access; if \(a\.access\.has_access\)/.test(finSrc));

  /* ===================================================================== */
  /* 5. app.html — ASK STRIPE BEFORE SHOWING A PAYWALL                     */
  /* ===================================================================== */
  function region(src, from, to) { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); return a >= 0 && b > a ? src.slice(a, b) : ''; }
  const COMP = region(APP, '/* ---- A COMPED SUBSCRIPTION', 'async function loadSubStatus(){');
  const PAY = region(APP, "var PG_OWNER_ID='", '/* boot */');
  chk('the paywall regions are found', COMP.length > 100 && PAY.length > 100);
  function appCtx(answers) {
    const st = { reads: 0, syncs: 0 };
    const c = { console, JSON, String, Number, Array, Date, Math, Promise, isFinite, encodeURIComponent,
      setTimeout: (f) => { f(); return 0; }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { body: { style: {} } }, $: () => null, edUser: () => ({ id: 'reader' }), stEsc: (x) => String(x == null ? '' : x),
      sbGet: async () => { throw new Error('the paywall must not read the row itself when the library is there'); },
      SB_URL: 'https://x.test', SB_KEY: 'anon', edToken: async () => 't', EDPricing: require(path.join(ROOT, 'lib', 'edgedesk_pricing.js')),
      SUB_PRICE_DISPLAY: '$49.99', SUB_PLAN_NAME: 'EdgeDesk Full Access', ST: st };
    c.window = c;
    c.EDAccess = { FINALIZE_DELAYS: A.FINALIZE_DELAYS,
      read: async () => { const a = answers.reads[Math.min(st.reads, answers.reads.length - 1)]; st.reads++; return a; },
      sync: async () => { st.syncs++; return answers.sync || { ok: true, status: 200, body: { has_access: false } }; } };
    vm.createContext(c);
    vm.runInContext(COMP + '\n' + PAY, c);
    return c;
  }
  const locked = { ok: true, access: { has_access: false, should_sync: true, offer: 'trial', subscription: null } };
  const open = { ok: true, access: { has_access: true, should_sync: false, offer: 'none', subscription: { status: 'trialing' } } };
  let c = appCtx({ reads: [locked, open], sync: { ok: true, status: 200, body: { has_access: true, ref: 'EDS-AAAAAA' } } });
  eq('a row behind Stripe: pgCheck asks the server to reconcile and opens', await c.pgCheck(), 'ok');
  eq('exactly once', c.ST.syncs, 1);
  c = appCtx({ reads: [locked], sync: { ok: true, status: 200, body: { has_access: false, ref: 'EDS-BBBBBB' } } });
  eq('Stripe agrees there is nothing: locked', await c.pgCheck(), 'locked');
  await c.pgCheck();
  eq('and a second check on the same page does not ask Stripe again', c.ST.syncs, 1);
  c = appCtx({ reads: [{ ok: true, access: { has_access: false, should_sync: false, offer: 'trial', subscription: null } }] });
  eq('nothing suggests a purchase: locked without spending a Stripe call', await c.pgCheck(), 'locked');
  eq('(no call)', c.ST.syncs, 0);
  c = appCtx({ reads: [{ ok: false, reason: 'signed_out' }] });
  eq('a session that cannot be read is unknown — the paywall fails open, RLS still governs', await c.pgCheck(), 'unknown');
  c = appCtx({ reads: [{ ok: false, reason: 'unavailable' }] });
  eq('so is an outage', await c.pgCheck(), 'unknown');
  c = appCtx({ reads: [{ ok: true, access: { has_access: false, should_sync: false, offer: 'trial',
    subscription: { status: 'trialing', price_id: 'comp_trial', current_period_end: '2020-01-01T00:00:00Z' } } }] });
  await c.pgCheck();
  const h = c.pgLockedHTML('');
  chk('an ENDED comp_trial is offered the trial flow, not "email us"', /href="\.\/index\.html#subscribe"/.test(h) && !/Restart your subscription/.test(h), h.slice(0, 300));
  chk('"I already paid" asks the server to reconcile, not just re-read', /async function pgRecheck\(\)\{[\s\S]{0,400}EDAccess\.sync\(pgAccessCfg\(\),\{source:'self'\}\)/.test(APP));
  chk('and a stuck reader is told not to pay again, with a reference', /Please do not pay again or create another account/.test(APP));
  chk('returning from Stripe in the app runs the same bounded finalize', /async function pgPollForSub\(\)\{[\s\S]{0,900}EDAccess\.finalize\(pgAccessCfg\(\)/.test(APP));
  chk('Settings carries a Refresh access control that reconciles with Stripe',
    /function setRefreshAccessCard\(\)/.test(APP) && /window\.__refreshAccess=async function\(\)\{[\s\S]{0,400}EDAccess\.sync\(/.test(APP));

  /* ===================================================================== */
  /* 6. index.html — THE SUCCESS PAGE AND THE STALE SESSION                */
  /* ===================================================================== */
  const RET = region(IDX, 'async function handleCheckoutReturn(){', '/* Self-serve billing re-check');
  const SUCC = RET.slice(RET.indexOf('if(!isCheckoutReturn()) return false;'));
  chk('the session id is read from the success URL BEFORE the URL is cleaned',
    SUCC.indexOf('var sid=checkoutSessionId();') > 0 && SUCC.indexOf('var sid=checkoutSessionId();') < SUCC.indexOf('scrubCheckoutParams();'));
  const FIN = region(IDX, 'async function edFinalizeCheckout(sid,ref){', 'async function handleCheckoutReturn(){');
  chk('the success page says "Payment received. Finalizing your EdgeDesk access…"', /Payment received\. Finalizing your EdgeDesk access/.test(FIN));
  chk('it finalizes through the server, never by trusting the redirect', /EDAccess\.finalize\(/.test(FIN) && !/window\.location\.href=APP_URL;\s*\},700\);\s*return true;\s*\}\s*await new Promise/.test(FIN));
  chk('it cannot run twice at once', /if\(RETN_RUNNING\) return;/.test(FIN));
  chk('a stuck customer is told NOT to make another account or start another checkout, with a reference',
    /Do not create a new account or start another checkout/.test(IDX) && /Reference <b class="mono">/.test(IDX));
  chk('a customer back from Stripe on a signed-out browser is sent to LOG IN, not to sign up again',
    /function retnSignedOut\(ref\)\{[\s\S]{0,700}Do not create a new account or pay again[\s\S]{0,300}openAuth\(\\'login\\'\)/.test(IDX));
  chk('and after that login the app finishes the payment', /edgedesk_finalize/.test(IDX) && /checkout=success/.test(IDX));
  chk('no unbounded loop anywhere on the success path', !/while\s*\(\s*true\s*\)/.test(FIN + RET));
  chk('a cancelled checkout says nothing was charged', /Checkout cancelled','Nothing was charged/.test(IDX));
  chk('a signup that waits on email confirmation clears another account\'s session',
    /setPendingSub\(true\);[\s\S]{0,700}localStorage\.removeItem\('edgedesk_session'\)/.test(IDX));
  chk('both pages load the access library', /<script src="\/lib\/edgedesk_access\.js\?v=/.test(IDX) && /<script src="\/lib\/edgedesk_access\.js\?v=/.test(APP));

  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'access client — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

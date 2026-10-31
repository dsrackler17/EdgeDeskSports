#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK SOLD THROUGH JUICE REEL, END TO END, THROUGH THE SHIPPED CODE.

     the SHIPPED juicereel_billing Edge Function, loaded whole under a Deno shim
       -> a PostgREST / Auth stand-in over a REAL PostgreSQL carrying the SHIPPED
          migrations (billing.sql … billing_hardening.sql, then
          juicereel_billing.sql), with their real grants, RLS and row locks
       -> a fake Juice Reel that enforces the documented checkout and OAuth
          contract (tools/billing/_fake_juicereel_billing.js)
     and, beside it, the SHIPPED stripe_webhook and sync_subscription with the
     fake Stripe, for the ways the two billing systems meet.

   The success criterion, asserted throughout: a reader who paid on Juice Reel
   ends up with access on the EdgeDesk account they were signed in to — through
   a checkout, through a later account link, or through a webhook — and nobody
   else's account, nobody who did not pay, and no Stripe entitlement is touched.

   THE FAKE IS NOT JUICE REEL. By default it answers in the subscriber-status,
   subscriber-list and webhook shapes Juice Reel documents and confirmed on
   2026-10-29 (docs/juicereel-billing.md § 9); the shapes guessed before that
   stay available, so the reader keeps handling them.

   Needs PostgreSQL (skips loudly without it, like every SQL suite here).
   Run: node tools/billing/juicereel_billing.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');
const FJ = require('./_fake_juicereel_billing.js');

const T = PG.kit('juicereel billing');
const chk = T.chk;
const ROOT = path.join(__dirname, '..', '..');
const REDIRECT = 'https://edgedesksports.com/oauth/juicereel-subscribe.html';

(async () => {
  const w = H.world('jrbill');
  // SKIPPED is not passed: CI sets JUICEREEL_BILLING_SQL_REQUIRED so a missing PostgreSQL fails
  if (w.skip) { console.log('SKIP | juicereel billing | ' + w.skip); process.exit(process.env.JUICEREEL_BILLING_SQL_REQUIRED === '1' ? 1 : 0); }
  const report = w.db.applyFile(path.join(ROOT, 'supabase', 'juicereel_billing.sql'));
  chk('juicereel_billing.sql applies over the billing schema and its report says ok on every row',
    !/CHECK THIS/.test(String(report)) && (String(report).match(/\|ok/g) || []).length >= 7, String(report).slice(0, 300));
  const again = w.db.applyFile(path.join(ROOT, 'supabase', 'juicereel_billing.sql'));
  chk('…and applies again unchanged (idempotent)', !/CHECK THIS/.test(String(again)));
  // an operator, by billing_is_admin()'s own table
  w.db.sql('create table if not exists public.issue_report_admins (user_id uuid primary key);');
  // what the fake seller's EdgeDesk product opens (§ 13 tests the mapping
  // itself): the terminal. A product nobody mapped opens nothing.
  w.db.sql("select public.billing_jr_set_product('prod_edgedesk_monthly', 'terminal', 'the test seller''s EdgeDesk product');");

  const J = FJ.make();
  const route = (url, init) => (String(url).indexOf(FJ.API) === 0 ? J.api(url, init) : w.route(url, init));
  const ENV = { JUICE_REEL_CLIENT_ID: J.o.clientId, JUICE_REEL_CLIENT_SECRET: J.o.clientSecret,
    JUICE_REEL_WEBHOOK_SECRET: J.o.webhookSecret, JUICE_REEL_CHECKOUT: 'on' };
  const load = (over) => H.loadFunction('juicereel_billing', Object.assign({}, w.env, ENV, over || {}), route, w.logs);
  let fn = load();
  const call = async (body, token, handler, pathSuffix) => {
    const headers = { 'content-type': 'application/json', apikey: 'anon-key' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await (handler || fn)(new Request('https://fn.test/functions/v1/juicereel_billing' + (pathSuffix || ''),
      { method: 'POST', headers, body: JSON.stringify(body || {}) }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const hook = async (d, sig, handler) => {
    const res = await (handler || fn)(new Request('https://fn.test/functions/v1/juicereel_billing/webhook',
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-juice-reel-signature': sig == null ? d.sig : sig }, body: d.raw }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // what oauth/juicereel-subscribe.html hands the app: the return's query
  const ret = (url) => { const q = new URL(url).searchParams; return { state: q.get('state'), code: q.get('code'), error: q.get('status') === 'cancelled' ? 'cancelled' : q.get('error') }; };
  const complete = (u, url) => call(Object.assign({ action: 'complete' }, ret(url)), u.token);
  const row = (u) => w.row(u.id);
  const access = (u) => w.access(u.id);
  const alerts = (kind) => w.q("select * from public.billing_alerts where kind = " + PG.lit(kind));
  const dayMs = 86400000;

  /* ── 1. health, the switch, and who may start ─────────────────────────── */
  {
    const res = await fn(new Request('https://fn.test/functions/v1/juicereel_billing'));
    const h = await res.json();
    chk('health answers names and booleans only: configured, the redirect URI, the scopes, the mode — never a secret',
      h.ok && h.mode === 'on' && h.configured.client_id === true && h.configured.client_secret === true && h.configured.webhook_secret === true
        && h.configured.redirect_uri === REDIRECT && JSON.stringify(h.configured.scopes) === '["subscribers.read"]' && h.ready === true
        && JSON.stringify(h).indexOf(J.o.clientSecret) < 0 && JSON.stringify(h).indexOf(J.o.webhookSecret) < 0, JSON.stringify(h));
    const off = load({ JUICE_REEL_CHECKOUT: '' });
    const U = w.user('off@example.com');
    let r = await call({ action: 'status' }, U.token, off);
    chk('switch OFF (the default): the page is told it is not available', r.status === 200 && r.body.mode === 'off' && r.body.available === false, JSON.stringify(r.body));
    r = await call({ action: 'start', kind: 'checkout' }, U.token, off);
    chk('switch OFF: a checkout cannot be started, and Juice Reel is never asked', r.status === 403 && r.body.reason === 'off' && !J.S.calls.length);
    const ops = load({ JUICE_REEL_CHECKOUT: 'operators' });
    r = await call({ action: 'start', kind: 'checkout' }, U.token, ops);
    chk('switch OPERATORS: a reader is refused', r.status === 403 && r.body.reason === 'operators_only');
    const OP = w.user('operator@example.com');
    w.db.sql('insert into public.issue_report_admins values (' + PG.lit(OP.id) + ');');
    r = await call({ action: 'status' }, OP.token, ops);
    const r2 = await call({ action: 'start', kind: 'checkout' }, OP.token, ops);
    chk('switch OPERATORS: an operator sees it and can start the live test', r.body.available === true && r2.status === 200 && /^https:\/\/www\.juicereel\.com\//.test(r2.body.url), JSON.stringify(r2.body));
    r = await call({ action: 'status' });
    const r3 = await call({ action: 'start', kind: 'checkout' });
    const r4 = await call({ action: 'complete', state: 'x'.repeat(43), code: 'c' });
    chk('signed out: status, start and complete are each 401', r.status === 401 && r3.status === 401 && r4.status === 401);
    r = await fn(new Request('https://fn.test/functions/v1/juicereel_billing', { method: 'OPTIONS' }));
    chk('CORS preflight answers', r.status === 204);
  }

  /* ── 2. the checkout, start to access ─────────────────────────────────── */
  const A = w.user('alice@example.com');
  let aliceExp;
  {
    J.S.calls.length = 0;
    let r = await call({ action: 'status' }, A.token);
    chk('a reader sees Juice Reel checkout available, not linked, no access', r.body.available === true && r.body.linked === false && r.body.access.has_access === false);
    r = await call({ action: 'start', kind: 'checkout' }, A.token);
    chk('start: the function answers Juice Reel\'s checkout URL, on www.juicereel.com', r.status === 200 && r.body.ok && /^https:\/\/www\.juicereel\.com\/checkout\/sessions\//.test(r.body.url), JSON.stringify(r.body));
    const co = J.S.calls.find((c) => c.path === '/checkout/sessions');
    const sent = JSON.parse(co.body);
    chk('POST /checkout/sessions carried HTTP Basic and X-OAuth-Client-Id, the registered URI as successUrl AND cancelUrl, scopes [subscribers.read], a state and an S256 challenge',
      co.auth === 'basic' && co.clientHeader && sent.successUrl === REDIRECT && sent.cancelUrl === REDIRECT
        && JSON.stringify(sent.scopes) === '["subscribers.read"]' && /^[A-Za-z0-9_-]{43}$/.test(sent.state) && /^[A-Za-z0-9_-]{43}$/.test(sent.codeChallenge) && !('productId' in sent));
    const sess = w.q('select * from public.billing_juicereel_sessions where user_id = ' + PG.lit(A.id));
    chk('the database keeps only the SHA-256 of the state, bound to this reader, with the checkout session id; no verifier column exists',
      sess.length === 1 && /^[0-9a-f]{64}$/.test(sess[0].state_hash) && JSON.stringify(sess).indexOf(sent.state) < 0
        && sess[0].kind === 'checkout' && sess[0].checkout_session_id && !('verifier' in sess[0]) && !('code_verifier' in sess[0]));
    const paid = J.pay(r.body.url, '5001', { name: 'Alice JR' });
    aliceExp = paid.expiresDate;
    r = await complete(A, paid.url);
    chk('the return completes: outcome active, access granted, the Juice Reel name shown', r.status === 200 && r.body.outcome === 'active'
      && r.body.access.has_access === true && r.body.display_name === 'Alice JR', JSON.stringify(r.body));
    const tok = J.S.calls.find((c) => c.path === '/oauth2/token');
    const form = new URLSearchParams(tok.body);
    chk('the code was exchanged with Basic, the SUCCESS URL as redirect_uri and a verifier (Juice Reel checked it against the challenge)',
      tok.auth === 'basic' && tok.clientHeader && form.get('redirect_uri') === REDIRECT && form.get('grant_type') === 'authorization_code' && /^[A-Za-z0-9_-]{43}$/.test(form.get('code_verifier')));
    chk('the buyer\'s token went only to /oauth2/me and /oauth2/subscribers/status (Bearer); the secret only to checkout and token (Basic)',
      J.S.calls.filter((c) => c.auth === 'bearer').every((c) => ['/oauth2/me', '/oauth2/subscribers/status'].indexOf(c.path) >= 0)
        && J.S.calls.filter((c) => c.auth === 'basic').every((c) => ['/checkout/sessions', '/oauth2/token'].indexOf(c.path) >= 0)
        && J.S.calls.every((c) => c.clientHeader));
    const s = row(A);
    chk('subscriptions: price_id juicereel, active until Juice Reel\'s expiry, no Stripe ids, tier = the terminal by the existing rule',
      s.status === 'active' && s.price_id === 'juicereel' && Math.abs(Date.parse(s.current_period_end) - Date.parse(aliceExp)) < 1000
        && s.stripe_customer_id == null && s.stripe_subscription_id == null && s.sync_source === 'juicereel' && s.tier == null, JSON.stringify(s));
    const mine = w.myAccess(A);
    chk('the browser\'s own door (my_billing_access) says has_access, reason active — the paywall opens', mine.has_access === true && mine.reason === 'active');
    chk('the same rule in JavaScript (lib/edgedesk_access.js grants) agrees', require(path.join(ROOT, 'lib', 'edgedesk_access.js')).grants(s));
    r = await complete(A, paid.url);
    chk('the same return twice is refused as used, and still reports this reader\'s access (a reload is harmless)',
      r.status === 400 && r.body.reason === 'JR_STATE_INVALID' && r.body.why === 'used' && r.body.access.has_access === true);
    r = await call({ action: 'start', kind: 'checkout' }, A.token);
    chk('a reader with access is not sold a second checkout', r.status === 409 && r.body.reason === 'already_entitled');
    const link = w.q('select * from public.billing_juicereel_links where user_id = ' + PG.lit(A.id))[0];
    chk('the link is one row: this reader <-> Juice Reel user 5001', link && link.jr_user_id === '5001' && link.jr_display_name === 'Alice JR');
  }

  /* ── 3. a state that is not this reader's ─────────────────────────────── */
  {
    const B = w.user('bob@example.com'), M = w.user('mallory@example.com');
    let r = await call({ action: 'start', kind: 'checkout' }, B.token);
    const paid = J.pay(r.body.url, '5002', { name: 'Bob JR' });
    r = await complete(M, paid.url);
    chk('another reader presenting Bob\'s return is refused (login CSRF)', r.status === 400 && r.body.why === 'other_user');
    chk('…links nothing and grants nothing to that reader', !w.q('select 1 from public.billing_juicereel_links where user_id = ' + PG.lit(M.id)).length && !access(M).has_access);
    r = await complete(B, paid.url);
    chk('…and did not use up Bob\'s session: Bob completes and has access', r.body.outcome === 'active' && access(B).has_access === true, JSON.stringify(r.body));
    r = await call({ action: 'complete', state: 'Z'.repeat(43), code: 'jrc_x' }, B.token);
    chk('a state never issued is refused', r.status === 400 && r.body.why === 'unknown');
    const C = w.user('carol@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, C.token);
    const p2 = J.pay(r.body.url, '5003');
    w.db.sql("update public.billing_juicereel_sessions set expires_at = now() - interval '1 second' where user_id = " + PG.lit(C.id) + ';');
    r = await complete(C, p2.url);
    chk('an expired session is refused, and the message tells a payer to link rather than pay again', r.body.why === 'expired' && /Do not pay again/.test(r.body.message));
    // carol paid: the link path still opens it (Juice Reel still lists her)
    r = await call({ action: 'start', kind: 'link' }, C.token);
    r = await complete(C, J.authorize(r.body.url, '5003').url);
    chk('…and the payer gets in through "I bought EdgeDesk on Juice Reel" (an account link)', r.body.outcome === 'active' && access(C).has_access, JSON.stringify(r.body));
  }

  /* ── 4. one Juice Reel account opens one EdgeDesk account ─────────────── */
  {
    const D = w.user('dave-second-account@example.com');
    let r = await call({ action: 'start', kind: 'link' }, D.token);
    r = await complete(D, J.authorize(r.body.url, '5001').url);   // Alice's Juice Reel account
    chk('linking a Juice Reel account that already opens another EdgeDesk account is refused (409)', r.status === 409 && r.body.reason === 'JR_ACCOUNT_IN_USE');
    chk('…grants nothing, and raises juicereel_account_in_use for a human', !access(D).has_access && alerts('juicereel_account_in_use').length === 1);
    chk('…and Alice keeps her access', access(A).has_access === true);
  }

  /* ── 5. cancelled checkout, and consent declined after paying ─────────── */
  {
    const E = w.user('erin@example.com');
    let r = await call({ action: 'start', kind: 'checkout' }, E.token);
    r = await complete(E, J.cancel(r.body.url).url);
    chk('a cancelled checkout: outcome cancelled, nothing linked, no row written', r.body.outcome === 'cancelled' && !row(E)
      && !w.q('select 1 from public.billing_juicereel_links where user_id = ' + PG.lit(E.id)).length);
    const F = w.user('frank@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, F.token);
    const paid = J.pay(r.body.url, '5006', { consent: false });
    r = await complete(F, paid.url);
    chk('paid, then declined Juice Reel\'s consent: the return reads cancelled (Juice Reel gives one form for both)', r.body.outcome === 'cancelled' && !access(F).has_access);
    r = await hook(J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 5006, subscriptionProductId: 'prod_edgedesk_monthly', expiresDate: paid.expiresDate, revenueCentsUsd: 4999 }));
    chk('the purchase webhook for that buyer is kept, waiting for a link', r.status === 200 && r.body.outcome === 'waiting_for_link', JSON.stringify(r.body));
    J.S.statusShape = 'not_subscribed'; J.S.ownerAccess = false;   // only the webhook knows
    r = await call({ action: 'start', kind: 'link' }, F.token);
    r = await complete(F, J.authorize(r.body.url, '5006').url);
    chk('…and the moment the buyer links, the webhook\'s purchase opens their account', r.body.outcome === 'active' && access(F).has_access, JSON.stringify(r.body));
    J.S.statusShape = 'documented'; J.S.ownerAccess = true;
  }

  /* ── 6. what Juice Reel's status answer may look like ─────────────────── */
  for (const [shape, jrId] of [['flag', '5120'], ['list', '5104'], ['array', '5105']]) {
    const U = w.user('shape-' + shape + '@example.com');
    J.S.statusShape = shape;
    let r = await call({ action: 'start', kind: 'checkout' }, U.token);
    r = await complete(U, J.pay(r.body.url, jrId).url);
    chk('subscriber status as ' + shape + ' → access', r.body.outcome === 'active' && access(U).has_access, JSON.stringify(r.body));
  }
  {
    // a bare "subscribed" that names no product: what was bought is unknown, so
    // alone it opens nothing (it used to open the terminal: an unknown product
    // was the terminal); the owner's list, which names the product, opens it
    const U = w.user('shape-flag_bare@example.com');
    J.S.statusShape = 'flag_bare'; J.S.ownerAccess = false;   // the status answer alone
    let r = await call({ action: 'start', kind: 'checkout' }, U.token);
    r = await complete(U, J.pay(r.body.url, '5109').url);
    chk('subscriber status as flag_bare (no product named), alone → nothing opens, said plainly', r.body.outcome === 'product_not_mapped' && !access(U).has_access, JSON.stringify(r.body));
    J.S.ownerAccess = true;
    const U2 = w.user('shape-flag_bare-list@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, U2.token);
    r = await complete(U2, J.pay(r.body.url, '5110').url);
    chk('subscriber status as flag_bare, with the owner\'s list naming the product → access', r.body.outcome === 'active' && access(U2).has_access, JSON.stringify(r.body));
  }
  {
    // Juice Reel's own "no" wins over an entry that looks active; the owner list is not consulted to overrule it here
    const U = w.user('shape-contradiction@example.com');
    J.S.statusShape = 'contradiction'; J.S.ownerAccess = false;
    let r = await call({ action: 'start', kind: 'checkout' }, U.token);
    r = await complete(U, J.pay(r.body.url, '5150').url);
    chk('a top-level "not subscribed" over an active-looking entry grants nothing (fail closed)', r.body.outcome === 'pending' && !access(U).has_access, JSON.stringify(r.body));
    J.S.ownerAccess = true;
  }
  {
    const U = w.user('shape-absent@example.com');
    J.S.statusShape = 'absent';
    let r = await call({ action: 'start', kind: 'checkout' }, U.token);
    r = await complete(U, J.pay(r.body.url, '5200').url);
    chk('no subscriber-status endpoint: the owner\'s current-subscriber list (owner access) confirms it → access',
      r.body.outcome === 'active' && access(U).has_access && J.S.calls.some((c) => c.path === '/oauth2/subscribers/current' && c.auth === 'basic'), JSON.stringify(r.body));
    const P = w.user('pending@example.com');
    J.S.ownerAccess = false;
    r = await call({ action: 'start', kind: 'checkout' }, P.token);
    const paid = J.pay(r.body.url, '5201');
    r = await complete(P, paid.url);
    chk('neither answers yet: outcome pending — linked, no access, and NOTHING negative recorded', r.body.outcome === 'pending' && !access(P).has_access
      && !w.q("select 1 from public.billing_juicereel_subscribers where jr_user_id = '5201'").length);
    r = await hook(J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 5201, subscriptionProductId: 'prod_edgedesk_monthly', expiresDate: paid.expiresDate }));
    chk('…then the purchase webhook lands and the pending reader is in', r.body.outcome === 'applied:updated' || r.body.outcome === 'applied:created', JSON.stringify(r.body));
    chk('…access granted', access(P).has_access === true);
    J.S.statusShape = 'documented'; J.S.ownerAccess = true;
  }

  /* ── 6b. Juice Reel's documented answers (confirmed 2026-10-29) ───────── */
  {
    // the owner's own Juice Reel account: status says true with no subscription; that is not a purchase
    const O = w.user('jr-owner-account@example.com');
    let r = await call({ action: 'start', kind: 'link' }, O.token);
    r = await complete(O, J.authorize(r.body.url, String(J.o.ownerId)).url);
    chk('the application owner\'s own account ({isCurrentlySubscribed: true}, no subscription) is not a buyer: no access',
      r.body.outcome === 'not_subscribed' && !access(O).has_access, JSON.stringify(r.body));

    // a refund before the paid-through date: still listed, with a future expiresDate and isCurrentlySubscribed false
    const V = w.user('refunded@example.com');
    J.subscribe('5701', 'prod_edgedesk_monthly', 30);
    J.refund('5701', 'prod_edgedesk_monthly');
    r = await call({ action: 'start', kind: 'link' }, V.token);
    r = await complete(V, J.authorize(r.body.url, '5701').url);
    chk('a list entry with isCurrentlySubscribed false grants nothing, whatever its expiresDate', r.body.outcome === 'not_subscribed' && !access(V).has_access, JSON.stringify(r.body));

    // the list holds everyone who EVER subscribed: an older, ended entry comes first
    const H = w.user('returning-buyer@example.com');
    J.subscribe('5702', 'prod_edgedesk_monthly', 30);
    J.history('5702', 'prod_edgedesk_monthly', 40);
    J.S.statusShape = 'absent';   // so the owner list alone decides
    r = await call({ action: 'start', kind: 'link' }, H.token);
    r = await complete(H, J.authorize(r.body.url, '5702').url);
    chk('a returning buyer whose ended subscription is listed before the current one is let in (the whole entry list is read)',
      r.body.outcome === 'active' && access(H).has_access, JSON.stringify(r.body));
    J.S.statusShape = 'documented';

    // the documented webhook body (its example product, mapped as the owner maps theirs)
    w.db.sql("select public.billing_jr_set_product('juice_plus_monthly', 'terminal', 'the documented example product');");
    const W = w.user('documented-webhook@example.com');
    r = await call({ action: 'start', kind: 'link' }, W.token);
    await complete(W, J.authorize(r.body.url, '5703').url);
    const until = new Date(Date.now() + 30 * dayMs).toISOString();
    r = await hook(J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 5703, subscriptionProductId: 'juice_plus_monthly', subscriptionDuration: 'MONTHLY',
      isFreeTrial: false, revenueCentsUsd: 999, expiresDate: until, isCurrentlySubscribed: true }));
    chk('the documented SUBSCRIPTION_PURCHASED body opens the account to its expiresDate', /^applied/.test(r.body.outcome) && access(W).has_access
      && Math.abs(Date.parse(row(W).current_period_end) - Date.parse(until)) < 1000, JSON.stringify(r.body));
    r = await hook(J.webhook('SUBSCRIPTION_RENEWED', { subscriberUserId: 5703, subscriptionProductId: 'juice_plus_monthly', subscriptionDuration: 'MONTHLY',
      isFreeTrial: false, revenueCentsUsd: 999, expiresDate: until, isCurrentlySubscribed: false }, { createdAt: new Date(Date.now() + 1000).toISOString() }));
    chk('an event that says isCurrentlySubscribed false ends access, whatever its type and expiresDate', !access(W).has_access, JSON.stringify(r.body) + ' ' + JSON.stringify(row(W)));

    // the reconcile: a linked buyer EdgeDesk holds as paid whom Juice Reel lists as no longer subscribed
    const R = w.user('refunded-later@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, R.token);
    await complete(R, J.pay(r.body.url, '5704').url);
    chk('(a paid buyer, in)', access(R).has_access);
    J.refund('5704', 'prod_edgedesk_monthly');
    r = await call({ action: 'reconcile' }, 'service-key');
    chk('the reconcile raises a buyer Juice Reel lists as no longer subscribed for a human, and does NOT cut them off',
      alerts('juicereel_absent_from_current').some((a) => a.user_id === R.id) && access(R).has_access, JSON.stringify(r.body));
  }

  /* ── 7. the webhook ───────────────────────────────────────────────────── */
  {
    const before = w.q('select count(*)::int as n from public.billing_juicereel_events')[0].n;
    const d = J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 9999, expiresDate: new Date(Date.now() + 30 * dayMs).toISOString() });
    let r = await hook(d, 'sha256=' + '0'.repeat(64));
    const r2 = await hook(d, '');
    const forged = JSON.parse(d.raw); forged.data.subscriberUserId = 5002;
    const r3 = await hook({ raw: JSON.stringify(forged), sig: d.sig });
    chk('a bad, missing or replayed-onto-another-body signature is 401 and records nothing', r.status === 401 && r2.status === 401 && r3.status === 401
      && w.q('select count(*)::int as n from public.billing_juicereel_events')[0].n === before);
    const nosecret = load({ JUICE_REEL_WEBHOOK_SECRET: '' });
    r = await hook(d, null, nosecret);
    chk('no webhook secret set: 503, never accepted unsigned', r.status === 503);

    // renew / cancel / expire on Alice
    const renewTo = new Date(Date.parse(aliceExp) + 30 * dayMs).toISOString();
    const ren = J.webhook('SUBSCRIPTION_RENEWED', { subscriberUserId: 5001, subscriptionProductId: 'prod_edgedesk_monthly', expiresDate: renewTo });
    r = await hook(ren);
    chk('RENEWED moves current_period_end to the new expiry', r.status === 200 && Math.abs(Date.parse(row(A).current_period_end) - Date.parse(renewTo)) < 1000);
    r = await hook(ren);
    chk('the same delivery again is a duplicate and changes nothing', r.body.duplicate === true);
    const can = J.webhook('SUBSCRIPTION_CANCELLED', { subscriberUserId: 5001, subscriptionProductId: 'prod_edgedesk_monthly' });
    r = await hook(can);
    chk('CANCELLED keeps access to the paid-through date, marked as ending', access(A).has_access && row(A).cancel_at_period_end === true
      && Math.abs(Date.parse(row(A).current_period_end) - Date.parse(renewTo)) < 1000, JSON.stringify(row(A)));
    const stale = J.webhook('SUBSCRIPTION_EXPIRED', { subscriberUserId: 5001, subscriptionProductId: 'prod_edgedesk_monthly' },
      { createdAt: new Date(Date.now() - 3600000).toISOString() });
    r = await hook(stale);
    chk('an event older than what is recorded is not applied (stale)', /stale/.test(r.body.outcome) && access(A).has_access, JSON.stringify(r.body));
    const exp = J.webhook('SUBSCRIPTION_EXPIRED', { subscriberUserId: 5001, subscriptionProductId: 'prod_edgedesk_monthly' },
      { createdAt: new Date(Date.now() + 1000).toISOString() });
    r = await hook(exp);
    chk('EXPIRED ends access: the row reads canceled, and the paywall closes', !access(A).has_access && row(A).status === 'canceled' && row(A).price_id === 'juicereel', JSON.stringify(row(A)));
    // products are mapped in the database now (§ 13); the old allow-list is not read, and is named so it gets removed
    const legacy = load({ JUICE_REEL_PRODUCT_IDS: 'prod_edgedesk_monthly' });
    const hl = await (await legacy(new Request('https://fn.test/functions/v1/juicereel_billing'))).json();
    chk('JUICE_REEL_PRODUCT_IDS is no longer read: health names it as a setting to remove, so the switch cannot go on with it set',
      (hl.missing || []).some((m) => /JUICE_REEL_PRODUCT_IDS/.test(m)) && hl.ready === false, JSON.stringify(hl.missing));
    r = await hook(J.webhook('SOMETHING_ELSE', { subscriberUserId: 5001 }));
    chk('an event type this does not know is recorded and ignored', r.body.outcome === 'ignored_type');
  }

  /* ── 8. Juice Reel and Stripe on one account ──────────────────────────── */
  {
    // owner_comp: nobody's to write
    const O = w.user('comp@example.com');
    w.db.sql("insert into public.subscriptions (user_id, status, price_id) values (" + PG.lit(O.id) + ", 'active', 'owner_comp');");
    let r = await call({ action: 'start', kind: 'link' }, O.token);
    J.subscribe('5300', 'prod_edgedesk_monthly', 30);
    r = await complete(O, J.authorize(r.body.url, '5300').url);
    chk('an owner_comp row is never written by Juice Reel', row(O).price_id === 'owner_comp' && row(O).status === 'active' && r.body.projection === 'comp', JSON.stringify(r.body));

    // a live Stripe subscription + a Juice Reel purchase: Stripe's row stays, and a human is told
    const S = w.stripe, P = w.user('both@example.com');
    const cus = S.customer('both@example.com', { supabase_user_id: P.id });
    const sub = S.subscription(cus.id, 'price_4999', { metadata: { supabase_user_id: P.id } });
    w.db.sql('insert into public.subscriptions (user_id, status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id) values ('
      + PG.lit(P.id) + ", 'active', 'price_4999', now() + interval '20 days', " + PG.lit(cus.id) + ', ' + PG.lit(sub.id) + ');');
    r = await call({ action: 'start', kind: 'link' }, P.token);
    J.subscribe('5301', 'prod_edgedesk_monthly', 30);
    r = await complete(P, J.authorize(r.body.url, '5301').url);
    chk('a reader paying by Stripe who also bought on Juice Reel keeps the Stripe row untouched', row(P).price_id === 'price_4999' && row(P).stripe_subscription_id === sub.id && r.body.projection === 'other_entitlement');
    chk('…and juicereel_and_stripe_both_paid is raised (billed twice)', alerts('juicereel_and_stripe_both_paid').some((a) => a.user_id === P.id));

    // a hand-granted trial gives way to a purchase
    const Q = w.user('comptrial@example.com');
    w.db.sql("insert into public.subscriptions (user_id, status, price_id, current_period_end) values (" + PG.lit(Q.id) + ", 'trialing', 'comp_trial', now() + interval '5 days');");
    r = await call({ action: 'start', kind: 'link' }, Q.token);
    J.subscribe('5302', 'prod_edgedesk_monthly', 30);
    r = await complete(Q, J.authorize(r.body.url, '5302').url);
    chk('a comp_trial gives way to a Juice Reel purchase (as it does to Stripe)', row(Q).price_id === 'juicereel' && row(Q).status === 'active' && access(Q).has_access);

    // THE REGRESSION: an ended Stripe subscription must not end a Juice Reel purchase
    const R = w.user('lapsed-stripe@example.com');
    const cusR = S.customer('lapsed-stripe@example.com', { supabase_user_id: R.id });
    const subR = S.subscription(cusR.id, 'price_4999', { status: 'canceled', current_period_end: S.now() - 86400, metadata: { supabase_user_id: R.id } });
    w.db.sql('insert into public.subscriptions (user_id, status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id) values ('
      + PG.lit(R.id) + ", 'canceled', 'price_4999', now() - interval '1 day', " + PG.lit(cusR.id) + ', ' + PG.lit(subR.id) + ');');
    w.db.sql('select public.billing_link_customer(' + PG.lit(cusR.id) + ', ' + PG.lit(R.id) + ", 'test', true, null);");
    r = await call({ action: 'start', kind: 'checkout' }, R.token);
    r = await complete(R, J.pay(r.body.url, '5303').url);
    chk('a reader whose Stripe subscription ended buys on Juice Reel: access, and the ENDED Stripe subscription id is cleared from the row',
      access(R).has_access && row(R).price_id === 'juicereel' && row(R).stripe_subscription_id == null && row(R).stripe_customer_id === cusR.id, JSON.stringify(row(R)));
    let s = await w.call('sync_subscription', 'POST', {}, R.token);
    chk('…and Stripe\'s own reconciliation (sync_subscription) does not end it: Stripe only revokes what Stripe granted',
      access(R).has_access && row(R).price_id === 'juicereel' && row(R).status === 'active', JSON.stringify(s.body) + ' ' + JSON.stringify(row(R)));
    s = await w.deliver(S.ev('customer.subscription.deleted', subR));
    chk('…nor does a late Stripe event about the ended subscription', access(R).has_access && row(R).price_id === 'juicereel', JSON.stringify(s.body));
    // the control: leave the ended id on the row and Stripe's reconciliation DOES end the Juice Reel buyer
    w.db.sql('update public.subscriptions set stripe_subscription_id = ' + PG.lit(subR.id) + ' where user_id = ' + PG.lit(R.id) + ';');
    w.db.sql('delete from public.billing_sync_log where user_id = ' + PG.lit(R.id) + ';');
    s = await w.call('sync_subscription', 'POST', {}, R.token);
    chk('CONTROL: with the ended Stripe id left on the row, Stripe\'s reconciliation ends a paid Juice Reel buyer — so clearing it is load-bearing',
      !access(R).has_access, JSON.stringify(row(R)));
    // and the next Juice Reel confirmation puts it right
    r = await call({ action: 'reconcile' }, 'service-key');
    chk('…which the next Juice Reel reconcile repairs (the row is unentitled again, so Juice Reel may take it over)', access(R).has_access && row(R).stripe_subscription_id == null, JSON.stringify(r.body));
  }

  /* ── 9. the reconcile ─────────────────────────────────────────────────── */
  {
    w.db.sql('update public.billing_juicereel_reconcile_state set last_run_at = null where id = 1;');
    J.S.listShape = 'paged';   // Juice Reel returns one page; a cursor, if it ever sends one, is still followed
    let r = await call({ action: 'reconcile' });
    const r2 = await call({ action: 'reconcile' });
    chk('an unauthenticated poke (the cron job) runs once, then is debounced in the database', r.body.read_to_end === true && r2.body.skipped === 'ran_recently', JSON.stringify(r.body));
    chk('it read every page of the owner\'s list (paged two at a time here)', r.body.listed >= 5 && J.S.calls.filter((c) => c.path === '/oauth2/subscribers/current').length >= 3);
    J.S.listShape = 'documented';
    // a renewal whose webhook was lost
    const G = w.user('lost-webhook@example.com');
    let x = await call({ action: 'start', kind: 'checkout' }, G.token);
    await complete(G, J.pay(x.body.url, '5400', { days: 2 }).url);
    const was = Date.parse(row(G).current_period_end);
    J.subscribe('5400', 'prod_edgedesk_monthly', 32);
    r = await call({ action: 'reconcile' }, 'service-key');
    chk('a renewal whose webhook never arrived is picked up by the reconcile', Date.parse(row(G).current_period_end) > was + 20 * dayMs, JSON.stringify(r.body));
    // a buyer EdgeDesk holds as paid who is not on Juice Reel's list: alerted, never ended on a guess
    J.S.subs['5400'] = [];
    r = await call({ action: 'reconcile' }, 'service-key');
    chk('a linked buyer absent from Juice Reel\'s current list is raised for a human and NOT cut off', r.body.absent_alerts >= 1
      && alerts('juicereel_absent_from_current').some((a) => a.user_id === G.id) && access(G).has_access);
    J.S.ownerAccess = false;
    r = await call({ action: 'reconcile' }, 'service-key');
    chk('owner access refused: the reconcile says so and changes nothing', r.body.ok === false && r.body.code === 'OWNER_ACCESS_REFUSED' && access(G).has_access);
    J.S.ownerAccess = true;
  }

  /* ── 10. failures said plainly ────────────────────────────────────────── */
  {
    const K = w.user('kim@example.com');
    const bad = load({ JUICE_REEL_CLIENT_SECRET: 'jrs_wrong' });
    let r = await call({ action: 'start', kind: 'checkout' }, K.token, bad);
    chk('Juice Reel refusing EdgeDesk\'s credentials: JR_CLIENT_REFUSED, no URL, "nothing was charged"', r.body.reason === 'JR_CLIENT_REFUSED' && !r.body.url && /Nothing was charged/.test(r.body.message));
    J.S.checkoutUrlHost = 'https://evil.example';
    r = await call({ action: 'start', kind: 'checkout' }, K.token);
    chk('a checkout URL that is not on juicereel.com is never handed to the browser', r.body.reason === 'JR_CONTRACT' && !r.body.url);
    J.S.checkoutUrlHost = 'https://www.juicereel.com';
    r = await call({ action: 'start', kind: 'checkout' }, K.token);
    const paid = J.pay(r.body.url, '5500');
    J.S.down['/oauth2/token'] = true;
    r = await complete(K, paid.url);
    chk('the token endpoint down: PLATFORM_DOWN, retryable', r.status === 503 && r.body.retryable === true);
    delete J.S.down['/oauth2/token'];
    r = await complete(K, paid.url);
    chk('…and the same return succeeds once it answers (the session was released, the code still unused)', r.body.outcome === 'active' && access(K).has_access, JSON.stringify(r.body));
    const L = w.user('limit@example.com');
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await call({ action: 'start', kind: 'link' }, L.token)).status);
    chk('at most ten starts per reader in ten minutes', codes.slice(0, 10).every((c) => c === 200) && codes[10] === 429, codes.join(','));
    const N = w.user('nolink@example.com');
    r = await call({ action: 'start', kind: 'link' }, N.token);
    r = await complete(N, J.authorize(r.body.url, '5600').url);
    chk('linking a Juice Reel account with no subscription: not_subscribed, no access', r.body.outcome === 'not_subscribed' && !access(N).has_access);
    const au = new URL((await call({ action: 'start', kind: 'link' }, w.user('authz@example.com').token)).body.url);
    chk('the link\'s authorize URL is Juice Reel\'s, with the exact redirect URI, response_mode=query, the scope and S256',
      au.origin + au.pathname === 'https://www.juicereel.com/oauth2/authorize' && au.searchParams.get('redirect_uri') === REDIRECT
        && au.searchParams.get('response_mode') === 'query' && au.searchParams.get('scope') === 'subscribers.read'
        && au.searchParams.get('code_challenge_method') === 'S256' && au.searchParams.get('client_id') === J.o.clientId);
  }

  /* ── 11. operators ────────────────────────────────────────────────────── */
  {
    const OP = w.q('select user_id from public.issue_report_admins')[0].user_id;
    const U = w.user('reader-ops@example.com');
    let threw = false;
    try { w.db.as(U.id, 'select public.billing_admin_juicereel_overview();'); } catch (_) { threw = true; }
    chk('a reader cannot read the Juice Reel operator overview', threw);
    // bought on Juice Reel's marketplace, never came to EdgeDesk
    await hook(J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 7777, subscriptionProductId: 'prod_edgedesk_monthly',
      expiresDate: new Date(Date.now() + 30 * dayMs).toISOString() }));
    const ov = JSON.parse(w.db.as(OP, 'select public.billing_admin_juicereel_overview();'));
    chk('an operator sees counts, and who paid on Juice Reel without linking an EdgeDesk account', ov.links >= 5 && ov.paid_now >= 5
      && ov.paid_not_linked.length === 1 && ov.paid_not_linked[0].jr_user_id === '7777', JSON.stringify(ov.paid_not_linked));
    const C = w.q("select user_id from public.billing_juicereel_links where jr_user_id = '5003'")[0].user_id;
    const un = JSON.parse(w.db.as(OP, 'select public.billing_admin_juicereel_unlink(' + PG.lit(C) + ');'));
    chk('an operator moving a Juice Reel account off an account ends the access it granted there', un.ok && un.access_ended && !w.access(C).has_access);
    let r = await call({ action: 'check' }, 'service-key');
    chk('check (service role): Juice Reel accepts the credentials, and owner access reaches the subscriber list', r.body.accepted === true && r.body.owner_list === 'yes', JSON.stringify(r.body));
    r = await call({ action: 'check' }, 'service-key', load({ JUICE_REEL_CLIENT_SECRET: 'jrs_wrong' }));
    chk('check with a wrong secret: not accepted, JR_CLIENT_REFUSED', r.body.accepted === false && r.body.code === 'JR_CLIENT_REFUSED');
    r = await call({ action: 'check' }, U.token);
    chk('check is refused to a reader', r.status === 403);
    // which Juice Reel application JUICE_REEL_CLIENT_ID is, by its first 10 characters (2026-10-30)
    r = await call({ action: 'check' }, 'service-key');
    chk('check names the application: the test id is neither known app — unknown, not ok, the Integration app named as the one to use',
      r.body.app && r.body.app.verdict === 'unknown' && r.body.app.ok === false && r.body.app.client_id_prefix === J.o.clientId.slice(0, 10)
        && /neither known Juice Reel application/.test(r.body.app.message) && /jr_UcOwwS/.test(r.body.app.message), JSON.stringify(r.body.app));
    const INTEGRATION_ID = 'jr_UcOwwS-Ep-nxQu7WeaStFHXfelzzjVrK', OWNER_ONLY_ID = 'jr_AFk36va1' + 'Zq9xLw2Rt7Kp0Nb4Vc8Hd';
    const callsBefore = J.S.calls.length;
    // no secret set, so Juice Reel is not asked: the application verdict needs no request
    r = await call({ action: 'check' }, 'service-key', load({ JUICE_REEL_CLIENT_ID: INTEGRATION_ID, JUICE_REEL_CLIENT_SECRET: '' }));
    chk('check with the EdgeDesk Sports Integration id (jr_UcOwwS…): correct, named, ok — only its first 10 characters returned',
      r.status === 200 && r.body.app.verdict === 'correct' && r.body.app.ok === true && r.body.app.name === 'EdgeDesk Sports Integration'
        && r.body.app.client_id_prefix === 'jr_UcOwwS-' && JSON.stringify(r.body).indexOf(INTEGRATION_ID) < 0, JSON.stringify(r.body.app));
    r = await call({ action: 'check' }, 'service-key', load({ JUICE_REEL_CLIENT_ID: OWNER_ONLY_ID, JUICE_REEL_CLIENT_SECRET: '' }));
    chk('check with the EdgeDeskSports id (jr_AFk36va1…, sign-in off): WRONG, not ok, said plainly with the id to use; the full id not echoed',
      r.status === 200 && r.body.app.verdict === 'wrong' && r.body.app.ok === false && r.body.app.name === 'EdgeDeskSports' && r.body.app.client_id_prefix === 'jr_AFk36va'
        && /^WRONG APPLICATION: JUICE_REEL_CLIENT_ID \(jr_AFk36va…\) is the EdgeDeskSports app/.test(r.body.app.message) && /jr_UcOwwS…/.test(r.body.app.message)
        && JSON.stringify(r.body).indexOf(OWNER_ONLY_ID) < 0 && J.S.calls.length === callsBefore, JSON.stringify(r.body.app));
    r = await call({ action: 'check' }, 'service-key', load({ JUICE_REEL_CLIENT_ID: '', JUICE_REEL_CLIENT_SECRET: '' }));
    chk('check with no client id: not_set, no prefix', r.body.app.verdict === 'not_set' && r.body.app.client_id_prefix === null, JSON.stringify(r.body.app));
    r = await call({ action: 'check' }, 'service-key', load({ JUICE_REEL_CLIENT_ID: '', JUICE_REEL_CLIENT_SECRET: 'jrs_never_printed_0001' }));
    chk('the secret is never in the check\'s answer', JSON.stringify(r.body).indexOf('jrs_never_printed_0001') < 0 && JSON.stringify(r.body).indexOf(J.o.clientSecret) < 0);
  }

  /* ── 13. what each Juice Reel product opens ───────────────────────────── */
  // 2026-10-29: every product the seller had on Juice Reel opened the whole
  // terminal (JUICE_REEL_PRODUCT_IDS empty: "every product"). A cheaper Bet
  // Checker product there would have sold the terminal for its price. A
  // product now opens what billing_juicereel_products maps it to: the terminal,
  // Bet Checker, or (not mapped) nothing.
  {
    const BC = 'prod_bet_checker_monthly', PICKS = 'prod_some_picks_package', TERM = 'prod_edgedesk_monthly';
    const soon = (s) => new Date(Date.now() + s * 1000).toISOString();
    const betChecker = (u) => w.q('select public.has_bet_checker_paid(' + PG.lit(u.id) + ') as p')[0].p === true;
    const setProduct = (p, t) => JSON.parse(w.db.sql('select public.billing_jr_set_product(' + PG.lit(p) + ', ' + PG.lit(t) + ", 'test');"));
    const detail = (a) => (typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail) || {};

    // a product nobody mapped: nothing, said plainly, and a human is told
    const N = w.user('cheap-product@example.com');
    let r = await call({ action: 'start', kind: 'checkout' }, N.token);
    r = await complete(N, J.pay(r.body.url, '5900', { productId: BC }).url);
    chk('a purchase of a product nobody mapped opens NOTHING: not the terminal, not Bet Checker (it used to open the terminal)',
      !access(N).has_access && !betChecker(N) && r.body.outcome === 'product_not_mapped', JSON.stringify(r.body));
    chk('…the buyer is told the payment is safe and not to pay again, and operators are alerted with the product id',
      /do not pay again/i.test(r.body.message || '') && alerts('juicereel_product_not_mapped').some((a) => a.user_id === N.id && detail(a).product_id === BC),
      JSON.stringify(r.body));
    const K = w.user('picks-buyer@example.com');
    r = await call({ action: 'start', kind: 'link' }, K.token);
    J.subscribe('5901', PICKS, 30);
    r = await complete(K, J.authorize(r.body.url, '5901').url);
    chk('a buyer of something else the seller sells on Juice Reel (a picks package) who links an account gets nothing',
      !access(K).has_access && !betChecker(K) && r.body.outcome === 'product_not_mapped', JSON.stringify(r.body));

    // Bet Checker waits for the access rule to know its price (production before Deploy billing → apply_sql)
    const rule = fs.readFileSync(path.join(ROOT, 'supabase', 'billing_hardening.sql'), 'utf8')
      .match(/create or replace function public\.billing_tier_of_price[\s\S]*?\n\$\$;/)[0];
    const ruleBefore = rule.split('\n').filter((l) => l.indexOf("'juicereel_bet_checker'") < 0).join('\n');
    w.db.sql(ruleBefore);
    let refused = null;
    try { setProduct(BC, 'bet_checker'); } catch (e) { refused = String(e.message || e); }
    chk('mapping a product to Bet Checker is REFUSED while the access rule does not know juicereel_bet_checker (it would read it as the terminal)',
      ruleBefore !== rule && !!refused && /billing_hardening\.sql/.test(refused) && !betChecker(N) && !access(N).has_access, refused);
    w.db.sql(rule);

    // mapped to Bet Checker: its buyers get Bet Checker at once, never the terminal
    const m = setProduct(BC, 'bet_checker');
    chk('mapping the product to Bet Checker re-projects its buyers at once: Bet Checker paid, the terminal still closed',
      m.ok && m.reprojected >= 1 && betChecker(N) && !access(N).has_access && row(N).price_id === 'juicereel_bet_checker' && row(N).status === 'active',
      JSON.stringify(m) + ' ' + JSON.stringify(row(N)));
    chk('the access rule reads juicereel_bet_checker as Bet Checker (red): it never opens the terminal',
      w.db.sql("select public.billing_tier_of_price('juicereel_bet_checker');") === 'red'
        && w.db.sql("select public.billing_row_grants_access('active', 'juicereel_bet_checker', now() + interval '1 day', now());") === 'f');
    const B = w.user('bc-buyer@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, B.token);
    r = await complete(B, J.pay(r.body.url, '5902', { productId: BC }).url);
    chk('a Bet Checker buyer through the checkout: outcome bet_checker, told it opens Bet Checker, and the terminal stays closed',
      r.body.outcome === 'bet_checker' && /bet-checker/.test(r.body.message || '') && betChecker(B) && !access(B).has_access, JSON.stringify(r.body));

    // a Bet Checker buyer who buys the terminal gets it, though Juice Reel's
    // status answer carries ONE subscription (here the Bet Checker one)
    r = await call({ action: 'start', kind: 'checkout' }, B.token);
    r = await complete(B, J.pay(r.body.url, '5902').url);
    chk('a Bet Checker buyer who then buys the terminal on Juice Reel gets the terminal (a higher tier replaces a lower one)',
      r.body.outcome === 'active' && access(B).has_access && row(B).price_id === 'juicereel', JSON.stringify(r.body));

    // both products: the terminal is kept, and Bet Checker outlives it
    const T2 = w.user('both-products@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, T2.token);
    await complete(T2, J.pay(r.body.url, '5903').url);
    const bcEnd = J.subscribe('5903', BC, 60);
    r = await hook(J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 5903, subscriptionProductId: BC, expiresDate: bcEnd, isCurrentlySubscribed: true }));
    chk('a terminal buyer who also buys Bet Checker keeps the terminal: a lower tier never replaces a higher one still paid for, even with a later expiry',
      access(T2).has_access && row(T2).price_id === 'juicereel', JSON.stringify(r.body) + ' ' + JSON.stringify(row(T2)));
    r = await hook(J.webhook('SUBSCRIPTION_PURCHASED', { subscriberUserId: 5903, subscriptionProductId: PICKS, expiresDate: soon(90 * 86400), isCurrentlySubscribed: true }));
    chk('…nor does a product nobody mapped', access(T2).has_access && row(T2).price_id === 'juicereel', JSON.stringify(r.body));
    J.refund('5903', TERM);
    r = await hook(J.webhook('SUBSCRIPTION_EXPIRED', { subscriberUserId: 5903, subscriptionProductId: TERM, isCurrentlySubscribed: false }));
    chk('the terminal ending ends the terminal', !access(T2).has_access, JSON.stringify(row(T2)));
    r = await call({ action: 'reconcile' }, 'service-key');
    chk('…and the reconcile then opens the Bet Checker still paid for', betChecker(T2) && !access(T2).has_access && row(T2).price_id === 'juicereel_bet_checker', JSON.stringify(r.body) + ' ' + JSON.stringify(row(T2)));

    // Bet Checker never takes a better plan away
    const Q2 = w.user('trial-then-bc@example.com');
    w.db.sql("insert into public.subscriptions (user_id, status, price_id, current_period_end) values (" + PG.lit(Q2.id) + ", 'trialing', 'comp_trial', now() + interval '5 days');");
    r = await call({ action: 'start', kind: 'link' }, Q2.token);
    J.subscribe('5904', BC, 30);
    r = await complete(Q2, J.authorize(r.body.url, '5904').url);
    chk('a Bet Checker purchase never replaces a plan in good standing that already includes it (a running terminal trial)',
      row(Q2).price_id === 'comp_trial' && access(Q2).has_access, JSON.stringify(r.body) + ' ' + JSON.stringify(row(Q2)));

    // what check shows the owner
    r = await call({ action: 'check' }, 'service-key');
    const pr = r.body.products || {};
    chk('check lists what each product opens, and the products bought on Juice Reel that are not mapped',
      (pr.terminal || []).indexOf(TERM) >= 0 && (pr.bet_checker || []).indexOf(BC) >= 0 && (pr.not_mapped || []).some((x) => x.product_id === PICKS),
      JSON.stringify(pr));

    // off the map: what it granted ends
    const off = setProduct(BC, 'none');
    chk('taking a product off the map ends the access it granted, at once', off.ok && !betChecker(N) && !access(N).has_access, JSON.stringify(off));
    let bad = null;
    try { setProduct(BC, 'fairline'); } catch (e) { bad = String(e.message || e); }
    chk('a product can be mapped only to terminal, bet_checker or none', !!bad, bad);

    // '*': every product of this seller. 2026-10-29: Juice Reel sells one
    // subscription per seller (EdgeDeskSports, $49.99/mo) and shows its id
    // nowhere until someone has bought it, so the owner maps it without the id.
    const S2 = w.user('star-buyer@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, S2.token);
    r = await complete(S2, J.pay(r.body.url, '5905', { productId: 'prod_id_nobody_knew' }).url);
    chk("(before '*': a product nobody named opens nothing)", !access(S2).has_access && r.body.outcome === 'product_not_mapped', JSON.stringify(r.body));
    const star = setProduct('*', 'terminal');
    chk("'*' maps every product of the seller to the terminal, and re-checks every linked buyer at once",
      star.ok && star.opens === 'terminal' && access(S2).has_access && row(S2).price_id === 'juicereel' && access(K).has_access, JSON.stringify(star) + ' ' + JSON.stringify(row(S2)));
    const B2 = w.user('star-later@example.com');
    r = await call({ action: 'start', kind: 'checkout' }, B2.token);
    r = await complete(B2, J.pay(r.body.url, '5906', { productId: 'prod_id_nobody_knew' }).url);
    chk("…and a later buyer is opened on the return", r.body.outcome === 'active' && access(B2).has_access, JSON.stringify(r.body));
    setProduct(BC, 'bet_checker');
    chk("a product's own mapping wins over '*': a Bet Checker product still never opens the terminal", betChecker(N) && !access(N).has_access && row(N).price_id === 'juicereel_bet_checker', JSON.stringify(row(N)));
    r = await call({ action: 'check' }, 'service-key');
    chk("check lists '*' with the terminal, and nothing it covers as not mapped",
      (r.body.products.terminal || []).indexOf('*') >= 0 && !(r.body.products.not_mapped || []).length, JSON.stringify(r.body.products));
    const unstar = setProduct('*', 'none');
    chk("'*' off the map: what it alone granted ends", unstar.ok && !access(S2).has_access && !access(K).has_access && betChecker(N), JSON.stringify(unstar));
  }

  /* ── 12. nothing secret anywhere ──────────────────────────────────────── */
  {
    const issued = Object.keys(J.S.tokens).concat(Object.keys(J.S.codes));
    const logText = w.logs.map((l) => l.line).join('\n');
    const dump = w.db.sql("select string_agg(t::text, '\n') from (select * from public.billing_juicereel_sessions) t") + '\n'
      + w.db.sql("select string_agg(t::text, '\n') from (select * from public.billing_juicereel_links) t") + '\n'
      + w.db.sql("select string_agg(t::text, '\n') from (select * from public.billing_juicereel_subscribers) t");
    const leaks = issued.filter((t) => logText.indexOf(t) >= 0 || dump.indexOf(t) >= 0);
    chk('no access token, refresh token or code Juice Reel issued appears in any log line or Juice Reel table', issued.length > 20 && !leaks.length, leaks.slice(0, 3).join(','));
    chk('neither secret appears in any log line', logText.indexOf(J.o.clientSecret) < 0 && logText.indexOf(J.o.webhookSecret) < 0);
    const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'juicereel_billing', 'index.ts'), 'utf8');
    chk('the function imports nothing (one folder deploys whole)', !/^\s*import\s/m.test(src) && !/require\(/.test(src));
  }

  w.stop();
  process.exit(T.done());
})().catch((e) => { console.error(e); process.exit(1); });

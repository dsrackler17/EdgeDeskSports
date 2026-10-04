#!/usr/bin/env node
/* ===========================================================================
   EVERY WAY A CHECKOUT CAN GO, THROUGH THE SHIPPED FUNCTIONS AND THE REAL SQL.

   A customer signed up, entered a card, and the site never opened: the account
   existed and public.subscriptions had no row. This suite is the list of ways
   that can happen — and the ways the opposite can (somebody keeping access
   Stripe has ended) — each driven end to end:

     the three SHIPPED Edge Functions (stripe_webhook, create_checkout_session,
     sync_subscription), loaded whole under a Deno shim
       -> a PostgREST / Auth stand-in over a REAL PostgreSQL carrying the SHIPPED
          migrations (billing, stripe_webhook, referral_codes, subscription_price,
          billing_hardening), with their real grants, RLS and row locks
       -> a fake Stripe that makes subscriptions, sends events in Stripe's own
          (out-of-)order, pays with wallets, and fails on demand

   The success criterion, asserted throughout: if Stripe says an account has a
   valid trial or subscription, EdgeDesk ends up granting access — whatever the
   browser, the redirect or the webhook did — and if Stripe says it does not,
   EdgeDesk does not keep granting it.

   Needs PostgreSQL (skips loudly without it, like every SQL suite here).
   Run: node tools/billing/billing_flow.test.js
   =========================================================================== */
'use strict';
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');

const T = PG.kit('billing flow');
const chk = T.chk;

const OWNER = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';
const OFFER = { kind: 'trial', price_cents: 4999, trial_days: 7, consent_version: 'arl-2026-09-v7-trial7' };

(async () => {
  const w = H.world('billflow');
  if (w.skip) { console.log('SKIP | billing flow | ' + w.skip); process.exit(0); }
  const S = w.stripe;
  const deliverAll = async (events) => { const out = []; for (const e of events) out.push(await w.deliver(e)); return out; };
  const consent = (u) => w.db.sql("insert into public.billing_consents (user_id, user_email, price_display, billing_period, trial_days, consent_version) values (" +
    PG.lit(u.id) + ', ' + PG.lit(u.email) + ", '$49.99', 'month', 7, 'arl-2026-09-v7-trial7');");
  const ev = (id) => w.q('select * from public.stripe_events where id = ' + PG.lit(id))[0] || null;
  const alerts = (uid, kind) => w.q('select * from public.billing_alerts where user_id = ' + PG.lit(uid) +
    (kind ? ' and kind = ' + PG.lit(kind) : '') + ' order by id');

  try {
    /* ===================================================================== */
    /* 1. NORMAL CARD CHECKOUT, SERVER-CREATED                               */
    /* ===================================================================== */
    const A = w.user('alice@example.com');
    const B = w.user('bob@example.com');
    consent(A);
    let r = await w.call('create_checkout_session', 'POST', Object.assign({ user_id: B.id }, OFFER), A.token);
    chk('checkout: an authenticated reader gets a Stripe Checkout URL', r.status === 200 && r.body.ok && /^https:\/\/checkout\.stripe\.com\//.test(r.body.url), r.body);
    const csA = S.S.sessions[r.body.session_id];
    chk('the account is the TOKEN\'s, never the body\'s: client_reference_id is the caller', csA && csA.client_reference_id === A.id);
    chk('the uuid is on the session metadata', csA.metadata.supabase_user_id === A.id);
    chk('and on the subscription it will create', csA.subscription_data.metadata.supabase_user_id === A.id);
    chk('with the 7-day trial and a card held for it', csA.subscription_data.trial_period_days === '7' && csA.payment_method_collection === 'always');
    chk('the success URL carries the session id back', /checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/.test(csA.success_url));
    chk('promotion codes stay redeemable on Stripe\'s page', csA.allow_promotion_codes === 'true');
    chk('no payment_method_types: wallets come from the dashboard, through this same session', !('payment_method_types' in csA));
    const custA = S.S.customers[csA.customer];
    chk('a Stripe customer exists BEFORE payment, stamped with the account', custA && custA.metadata.supabase_user_id === A.id);
    chk('and is linked to the account before any event arrives',
      w.q("select * from public.billing_customers where stripe_customer_id = " + PG.lit(custA.id))[0].user_id === A.id);
    chk('the session is on record', w.q('select status from public.billing_checkout_sessions where id = ' + PG.lit(csA.id))[0].status === 'open');
    chk('nothing grants access yet', !w.access(A.id).has_access);

    const doneA = S.complete(csA.id, { email: 'alice@example.com' });
    chk('Stripe sends subscription.created BEFORE the checkout that names the account', doneA.events[0].type === 'customer.subscription.created');
    const outA = await deliverAll(doneA.events);
    chk('the FIRST delivery (subscription.created) already resolves, by metadata', outA[0].status === 200 && outA[0].body.how === 'metadata' && outA[0].body.has_access, outA[0].body);
    chk('and grants a live, Stripe-read trial', outA[0].body.via === 'live' && outA[0].body.outcome === 'granted', outA[0].body);
    chk('the checkout delivery after it changes nothing', outA[1].status === 200 && outA[1].body.changed === false, outA[1].body);
    let rowA = w.row(A.id);
    chk('row: trialing, Stripe ids, the real price id, period end = trial end', rowA.status === 'trialing' &&
      rowA.stripe_subscription_id === doneA.subscription.id && rowA.stripe_customer_id === custA.id &&
      rowA.price_id === 'price_4999' && Date.parse(rowA.current_period_end) === doneA.subscription.trial_end * 1000, rowA);
    chk('access granted, reason trialing, nothing to offer', w.myAccess(A).has_access && w.myAccess(A).reason === 'trialing' && w.myAccess(A).offer === 'none');
    chk('our session record says complete', w.q('select status from public.billing_checkout_sessions where id = ' + PG.lit(csA.id))[0].status === 'complete');
    chk('every delivery is on the ledger, resolved', doneA.events.every((e) => ev(e.id) && ev(e.id).resolved));

    /* ===================================================================== */
    /* 2. APPLE PAY (AND ANY WALLET) — SAME SESSION, DIFFERENT EMAIL         */
    /* ===================================================================== */
    const C = w.user('carol@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, C.token);
    const doneC = S.complete(r.body.session_id, { wallet: 'apple_pay', email: 'x7k2@privaterelay.appleid.com' });
    await deliverAll(doneC.events);
    chk('Apple Pay with a hidden-relay email still lands on the right account', w.access(C.id).has_access && w.row(C.id).stripe_subscription_id === doneC.subscription.id);
    const D_ = w.user('dan@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, D_.token);
    const doneD = S.complete(r.body.session_id, { wallet: 'google_pay', email: 'dan.other@gmail.com' });
    await deliverAll(doneD.events);
    chk('Google Pay / Link: the same', w.access(D_.id).has_access);

    /* ===================================================================== */
    /* 3. PAID SIGNUP WITH NO TRIAL                                          */
    /* ===================================================================== */
    const E = w.user('erin@example.com');
    const plE = S.paymentLinkSession({ client_reference_id: E.id, subscription_data: {} });
    const doneE = S.complete(plE.id, { email: 'erin@example.com' });
    const outE = await deliverAll(doneE.events);
    chk('a no-trial checkout is active and paid, invoice.paid handled', w.row(E.id).status === 'active' &&
      outE.every((x) => x.status === 200) && w.access(E.id).has_access, outE.map((x) => x.body));

    /* ===================================================================== */
    /* 4. BROWSER CLOSED BEFORE THE REDIRECT / ANOTHER DEVICE                */
    /* ===================================================================== */
    const F = w.user('fay@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, F.token);
    await deliverAll(S.complete(r.body.session_id, {}).events);
    chk('nobody came back from Stripe, and the account is open anyway', w.access(F.id).has_access);
    const F2 = Object.assign({}, F, { token: 'tok_second_device' });
    w.rest.tokens[F2.token] = { id: F.id, email: F.email };
    r = await w.call('sync_subscription', 'POST', {}, F2.token);
    chk('a second device, signed in a moment later, reads the same access', r.status === 200 && r.body.has_access === true, r.body);

    /* ===================================================================== */
    /* 5. SUCCESS PAGE BEFORE THE WEBHOOK (A DELAYED WEBHOOK)                */
    /* ===================================================================== */
    const G = w.user('gus@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, G.token);
    const csG = r.body.session_id;
    const doneG = S.complete(csG, {});
    chk('before any webhook, the account has no access', !w.access(G.id).has_access);
    r = await w.call('sync_subscription', 'POST', { source: 'checkout_return', session_id: csG }, G.token);
    chk('the success page\'s reconciliation grants it, from Stripe, without the webhook', r.status === 200 && r.body.has_access === true &&
      r.body.outcome === 'repaired' && /^EDS-[A-Z0-9]{6}$/.test(r.body.ref), r.body);
    const statusG = w.row(G.id).status;
    const lateG = await deliverAll(doneG.events);
    chk('the late webhook lands on top without changing anything', lateG.every((x) => x.status === 200 && x.body.has_access) && w.row(G.id).status === statusG);
    chk('and the late deliveries are resolved on the ledger', doneG.events.every((e) => ev(e.id).resolved));

    /* ===================================================================== */
    /* 6. THE SAME DELIVERY TWICE                                            */
    /* ===================================================================== */
    const before6 = JSON.stringify(w.row(A.id));
    const dup = doneA.events[0];
    const d1 = await w.deliver(dup), d2 = await w.deliver(dup);
    const after6 = w.row(A.id);
    chk('a duplicate delivery is a 200 both times', d1.status === 200 && d2.status === 200);
    chk('and leaves the same state', after6.status === JSON.parse(before6).status && after6.stripe_subscription_id === JSON.parse(before6).stripe_subscription_id);
    chk('one ledger row, attempts counted', w.q('select attempts from public.stripe_events where id = ' + PG.lit(dup.id))[0].attempts === 3);
    chk('one subscription row', w.q('select count(*)::int n from public.subscriptions where user_id = ' + PG.lit(A.id))[0].n === 1);

    /* ===================================================================== */
    /* 7. OUT OF ORDER                                                       */
    /* ===================================================================== */
    // Stripe ends A's subscription; then an OLD "active" arrives late.
    const oldActive = S.ev('customer.subscription.updated', S.snap(S.S.subscriptions[doneA.subscription.id]));
    oldActive.created -= 3600;
    const cancelA = S.update(doneA.subscription.id, { status: 'canceled' }, 'customer.subscription.deleted');
    await w.deliver(cancelA);
    chk('deleted: canceled, locked', w.row(A.id).status === 'canceled' && !w.access(A.id).has_access);
    r = await w.deliver(oldActive);
    chk('an older "active" delivered late cannot resurrect it (live read)', r.status === 200 && w.row(A.id).status === 'canceled' && !w.access(A.id).has_access, r.body);
    chk('canceled offers a restart, not a trial', w.access(A.id).offer === 'resubscribe');

    // And with no Stripe key at all, the event bodies themselves are ordered.
    const noKey = w.load('stripe_webhook', { STRIPE_SECRET_KEY: '' });
    const P = w.user('pat@example.com');
    const custP = S.customer('pat@example.com', { supabase_user_id: P.id });
    const subP = S.subscription(custP.id, 'price_4999', { status: 'trialing', metadata: { supabase_user_id: P.id }, current_period_end: S.now() + 7 * 86400 });
    const pCreated = S.ev('customer.subscription.created', S.snap(subP));
    const pDeleted = S.update(subP.id, { status: 'canceled' }, 'customer.subscription.deleted');
    r = await w.deliver(pDeleted, null, noKey);
    chk('payload path: the newer cancellation applies first', r.status === 200 && r.body.via === 'payload' && w.row(P.id).status === 'canceled', r.body);
    r = await w.deliver(pCreated, null, noKey);
    chk('payload path: the OLDER trialing is refused as stale', w.row(P.id).status === 'canceled' && r.body.applied === false, r.body);

    /* ===================================================================== */
    /* 8. A PAYMENT LINK: SUBSCRIPTION EVENT BEFORE THE CHECKOUT THAT NAMES IT */
    /* ===================================================================== */
    const I = w.user('ivy@example.com');
    const plI = S.paymentLinkSession({ client_reference_id: I.id });
    const doneI = S.complete(plI.id, { email: 'ivy.pay@example.org' });
    r = await w.deliver(doneI.events[0]);
    chk('a Payment Link subscription event names nobody yet: 200, unresolved', r.status === 200 && r.body.unresolved === true, r.body);
    chk('and is raised as an alert, not lost', w.q("select count(*)::int n from public.billing_alerts where kind = 'unresolved_event' and resolved_at is null and stripe_customer_id = " + PG.lit(doneI.customer.id))[0].n === 1);
    r = await w.deliver(doneI.events[1]);
    chk('the checkout names the account by client_reference_id and grants access', r.body.how === 'client_reference_id' && w.access(I.id).has_access, r.body);
    chk('the EARLIER delivery is resolved retroactively', ev(doneI.events[0].id).resolved === true && ev(doneI.events[0].id).user_id === I.id);
    chk('and its alert is closed', w.q("select count(*)::int n from public.billing_alerts where kind = 'unresolved_event' and resolved_at is null and stripe_customer_id = " + PG.lit(doneI.customer.id))[0].n === 0);

    // Checkout first, subscription event second
    const J = w.user('jo@example.com');
    const plJ = S.paymentLinkSession({ client_reference_id: J.id });
    const doneJ = S.complete(plJ.id, {});
    await w.deliver(doneJ.events[1]);
    chk('checkout first: access already', w.access(J.id).has_access);
    r = await w.deliver(doneJ.events[0]);
    chk('subscription.created second resolves by the customer now known', r.body.how === 'known customer' && w.access(J.id).has_access, r.body);

    /* ===================================================================== */
    /* 9. THE REPORTED FAILURE: PAID, AND NO ROW                             */
    /* ===================================================================== */
    // A Payment Link reached with NO client_reference_id, and the webhook never
    // delivered. The account exists and is confirmed; it went through consent.
    const K = w.user('kate@example.com');
    consent(K);
    const plK = S.paymentLinkSession({});
    const doneK = S.complete(plK.id, { email: 'kate@example.com' });
    doneK.subscription.created -= 3600;     // an hour ago: the webhook really did miss it
    chk('the account has no row and no access — the reported state', w.row(K.id) === null && !w.access(K.id).has_access);
    chk('and the access decision says to ask Stripe', w.access(K.id).should_sync === true && w.access(K.id).reason === 'no_subscription');
    r = await w.call('sync_subscription', 'POST', {}, K.token);
    chk('"Refresh access" asks Stripe and REPAIRS it', r.status === 200 && r.body.has_access === true && r.body.outcome === 'repaired', r.body);
    chk('with the real subscription on the row', w.row(K.id).stripe_subscription_id === doneK.subscription.id && w.row(K.id).status === 'trialing');
    chk('and the missed webhook is recorded as a repaired lockout, for the operator',
      w.q("select count(*)::int n from public.billing_alerts where kind = 'stripe_active_db_missing' and user_id = " + PG.lit(K.id) + ' and resolved_at is not null')[0].n === 1);
    chk('the attempt is in the sync log under its reference',
      w.q('select count(*)::int n from public.billing_sync_log where ref = ' + PG.lit(r.body.ref) + " and outcome = 'repaired'")[0].n === 1);
    // ...and the webhook, when it finally comes, changes nothing
    const lateK = await deliverAll(doneK.events);
    chk('the webhook arriving days later is harmless', lateK.every((x) => x.status === 200) && w.access(K.id).has_access);

    // The same, repaired by the SCHEDULE with nobody clicking anything
    const L = w.user('lee@example.com');
    consent(L);
    const doneL = S.complete(S.paymentLinkSession({}).id, { email: 'lee@example.com' });
    r = await w.call('sync_subscription', 'POST', { action: 'sweep' });
    chk('the sweep needs no identity, and answers counts only', r.status === 200 && r.body.ok && typeof r.body.repaired === 'number' && !('reports' in r.body), r.body);
    chk('and repairs the account that paid while nothing was listening', w.access(L.id).has_access && w.row(L.id).stripe_subscription_id === doneL.subscription.id, r.body);
    r = await w.call('sync_subscription', 'POST', { action: 'sweep' });
    chk('a second poke inside nine minutes is debounced', r.status === 200 && r.body.skipped === 'ran recently', r.body);

    // Apple Pay with a different email AND no client_reference_id: Stripe has
    // nothing that names the account. Not guessed — support links it once.
    const M = w.user('mo@example.com');
    consent(M);
    const doneM = S.complete(S.paymentLinkSession({}).id, { wallet: 'apple_pay', email: 'zz9@privaterelay.appleid.com' });
    await deliverAll(doneM.events);
    r = await w.call('sync_subscription', 'POST', {}, M.token);
    chk('a payment nothing ties to the account is NOT guessed onto it', r.body.has_access === false && w.row(M.id) === null, r.body);
    const ADMIN = w.user('owner@edgedesksports.com');
    w.db.sql("update auth.users set id = '" + OWNER + "' where id = " + PG.lit(ADMIN.id) + ';');
    w.rest.tokens[ADMIN.token].id = OWNER;
    r = await w.call('sync_subscription', 'POST', { action: 'admin_inspect', query: 'mo@example.com' }, ADMIN.token);
    chk('the operator finds the account by email', r.status === 200 && r.body.reports.length === 1 && r.body.reports[0].user.id === M.id, r.body);
    chk('and sees the consent-without-row mismatch', r.body.reports[0].mismatches.some((m) => /consent recorded but no subscription row/.test(m)), r.body.reports[0].mismatches);
    r = await w.call('sync_subscription', 'POST', { action: 'admin_link', user_id: M.id, customer_id: doneM.customer.id }, ADMIN.token);
    chk('one manual link, and the account is repaired from Stripe', r.status === 200 && r.body.outcome === 'repaired' && w.access(M.id).has_access, r.body);
    chk('the deliveries that could not be named are resolved by that link', doneM.events.every((e) => ev(e.id).resolved && ev(e.id).user_id === M.id));

    // A hand-made row carrying a customer id Stripe has never heard of must not
    // stop the account's REAL customer from being read.
    const HM = w.user('hand@example.com');
    consent(HM);
    w.db.sql("insert into public.subscriptions (user_id, status, stripe_customer_id) values (" + PG.lit(HM.id) + ", 'canceled', 'cus_typedbyhand');");
    const doneHM = S.complete(S.paymentLinkSession({ client_reference_id: HM.id }).id, { email: 'hand@example.com' });
    r = await w.call('sync_subscription', 'POST', {}, HM.token);
    chk('a bogus customer id on a hand-made row does not poison reconciliation', r.status === 200 && r.body.has_access === true &&
      w.row(HM.id).stripe_subscription_id === doneHM.subscription.id, r.body);

    // A staging project whose PRIMARY endpoint is test mode reads Stripe with its one key.
    const testHook = w.load('stripe_webhook', { STRIPE_MODE: 'test' });
    const TM = w.user('tm@example.com');
    const custTM = S.customer('tm@example.com', { supabase_user_id: TM.id });
    const subTM = S.subscription(custTM.id, 'price_4999', { status: 'trialing', metadata: { supabase_user_id: TM.id }, current_period_end: S.now() + 7 * 86400 });
    const tmEv = S.ev('customer.subscription.created', S.snap(subTM)); tmEv.livemode = false;
    r = await w.deliver(tmEv, null, testHook);
    chk('STRIPE_MODE=test: a test delivery on the primary secret is read live with STRIPE_SECRET_KEY', r.status === 200 && r.body.via === 'live' && w.access(TM.id).has_access, r.body);
    const liveOnTest = S.ev('customer.subscription.updated', S.snap(subTM));
    r = await w.deliver(liveOnTest, null, testHook);
    chk('and a LIVE delivery on a test-mode secret is refused', r.status === 400 && r.body.error === 'mode mismatch', r.body);

    /* ===================================================================== */
    /* 10. PAYMENT TROUBLE AND CANCELLATION                                  */
    /* ===================================================================== */
    const subC = doneC.subscription.id;
    await w.deliver(S.update(subC, { status: 'active', trial_end: null, current_period_end: S.now() + 30 * 86400 }));
    chk('the trial converts: active', w.row(C.id).status === 'active' && w.access(C.id).has_access);
    await w.deliver(S.update(subC, { status: 'past_due', current_period_end: S.now() - 2 * 86400 }));
    chk('a failed renewal: past_due, still entitled while Stripe retries', w.row(C.id).status === 'past_due' && w.access(C.id).has_access && w.access(C.id).reason === 'past_due_grace');
    await w.deliver(S.update(subC, { current_period_end: S.now() - 22 * 86400 }));
    chk('past the 21-day grace: locked, and told to fix the card', !w.access(C.id).has_access && w.access(C.id).offer === 'fix_payment');
    await w.deliver(S.update(subC, { status: 'active', current_period_end: S.now() + 30 * 86400 }));
    chk('the retry clears: active again', w.access(C.id).has_access);
    await w.deliver(S.update(subC, { cancel_at_period_end: true }));
    chk('cancel at period end: access to the end of what was paid for', w.access(C.id).has_access && w.row(C.id).cancel_at_period_end === true);
    await w.deliver(S.update(subC, { status: 'canceled' }, 'customer.subscription.deleted'));
    chk('deleted: locked', !w.access(C.id).has_access && w.row(C.id).status === 'canceled');

    // A card that declines (or needs 3-D Secure the customer never finishes)
    const N = w.user('nia@example.com');
    const plN = S.paymentLinkSession({ client_reference_id: N.id, subscription_data: {} });
    const doneN = S.complete(plN.id, { requires_action: true });
    await deliverAll(doneN.events);
    chk('an incomplete payment grants nothing', w.row(N.id).status === 'incomplete' && !w.access(N.id).has_access);
    await w.deliver(S.update(doneN.subscription.id, { status: 'active' }));
    chk('and opens the moment Stripe says it paid', w.access(N.id).has_access);

    /* ===================================================================== */
    /* 11. COMPS                                                             */
    /* ===================================================================== */
    const O = w.user('olu@example.com');
    w.db.sql("insert into public.subscriptions (user_id, status, price_id, current_period_end, cancel_at_period_end) values (" +
      PG.lit(O.id) + ", 'trialing', 'comp_trial', now() + interval '7 days', true);");
    chk('a hand-granted comp_trial is access', w.access(O.id).has_access && w.access(O.id).reason === 'comp_trial');
    // a stray Stripe subscription that never paid must not end the comp
    const custO = S.customer('olu@example.com', { supabase_user_id: O.id });
    const deadO = S.subscription(custO.id, 'price_4999', { status: 'incomplete_expired', metadata: { supabase_user_id: O.id } });
    r = await w.deliver(S.ev('customer.subscription.updated', S.snap(deadO)));
    chk('Stripe cannot revoke access Stripe did not grant', w.access(O.id).has_access && w.row(O.id).price_id === 'comp_trial', r.body);
    // a real purchase replaces it, and the comp sentinel goes with it
    const realO = S.subscription(custO.id, 'price_4999', { status: 'trialing', metadata: { supabase_user_id: O.id }, current_period_end: S.now() + 7 * 86400 });
    r = await w.deliver(S.ev('customer.subscription.created', S.snap(realO)));
    let rowO = w.row(O.id);
    chk('a real trial replaces the comp_trial', rowO.stripe_subscription_id === realO.id && rowO.status === 'trialing', rowO);
    chk('and the row now carries the Stripe price, so no report mistakes a payer for a comp', rowO.price_id === 'price_4999' && rowO.cancel_at_period_end === false, rowO);

    // an EXPIRED comp_trial can buy (it used to bounce between "you already have access" and the paywall)
    const Q = w.user('quinn@example.com');
    w.db.sql("insert into public.subscriptions (user_id, status, price_id, current_period_end, cancel_at_period_end) values (" +
      PG.lit(Q.id) + ", 'trialing', 'comp_trial', now() - interval '1 day', true);");
    chk('an expired comp_trial is locked and offered the trial', !w.access(Q.id).has_access && w.access(Q.id).offer === 'trial' && w.access(Q.id).reason === 'comp_trial_ended');
    r = await w.call('create_checkout_session', 'POST', OFFER, Q.token);
    chk('and checkout opens for it', r.status === 200 && r.body.ok, r.body);

    // owner_comp is never Stripe's to write
    const R_ = w.user('ruth@example.com');
    w.db.sql("insert into public.subscriptions (user_id, status, price_id) values (" + PG.lit(R_.id) + ", 'active', 'owner_comp');");
    const custR = S.customer('ruth@example.com', { supabase_user_id: R_.id });
    const subR = S.subscription(custR.id, 'price_4999', { status: 'canceled', metadata: { supabase_user_id: R_.id } });
    r = await w.deliver(S.ev('customer.subscription.deleted', S.snap(subR)));
    chk('an event naming an owner_comp account is acknowledged and ignored', r.status === 200 && r.body.ignored === 'comped_subscription' && w.row(R_.id).status === 'active');
    r = await w.call('create_checkout_session', 'POST', OFFER, R_.token);
    chk('a comp is never sent to checkout', r.status === 409 && r.body.reason === 'already_entitled', r.body);
    r = await w.call('sync_subscription', 'POST', {}, R_.token);
    chk('and reconciling a comp asks Stripe nothing and changes nothing', r.body.outcome === 'comp' && w.row(R_.id).price_id === 'owner_comp', r.body);

    /* ===================================================================== */
    /* 12. NOT BUYING TWICE                                                  */
    /* ===================================================================== */
    const U = w.user('uma@example.com');
    const c1 = await w.call('create_checkout_session', 'POST', OFFER, U.token);
    const c2 = await w.call('create_checkout_session', 'POST', OFFER, U.token);
    chk('a second click (or a second tab) reuses the open session', c2.body.ok && c2.body.session_id === c1.body.session_id && c2.body.reused === true, c2.body);
    const doneU = S.complete(c1.body.session_id, {});
    r = await w.call('create_checkout_session', 'POST', OFFER, U.token);
    chk('after paying — BEFORE any webhook — a new checkout is refused by asking Stripe', r.status === 409 && r.body.reason === 'already_entitled', r.body);
    chk('and that check repaired the row on the way', w.access(U.id).has_access);
    await deliverAll(doneU.events);

    // a duplicate purchase through a second Payment Link customer
    const dupU = S.complete(S.paymentLinkSession({ client_reference_id: U.id }).id, {});
    await deliverAll(dupU.events);
    chk('two live subscriptions raise a duplicate alert for a human', alerts(U.id, 'duplicate_active_subscriptions').filter((a) => !a.resolved_at).length === 1);
    chk('and the account keeps access', w.access(U.id).has_access);
    const shown = w.row(U.id).stripe_subscription_id;
    const other = shown === doneU.subscription.id ? dupU.subscription.id : doneU.subscription.id;
    await w.deliver(S.update(other, { status: 'canceled' }, 'customer.subscription.deleted'));
    chk('cancelling the duplicate does NOT lock out the subscription in use', w.access(U.id).has_access && w.row(U.id).stripe_subscription_id === shown);
    chk('and closes the duplicate alert', alerts(U.id, 'duplicate_active_subscriptions').filter((a) => !a.resolved_at).length === 0);
    await w.deliver(S.update(shown, { status: 'canceled' }, 'customer.subscription.deleted'));
    chk('cancelling the last one does', !w.access(U.id).has_access);

    // the same, when the duplicate is the one Stripe ends FIRST and the row shows it
    const V = w.user('vic@example.com');
    const v1 = S.complete(S.paymentLinkSession({ client_reference_id: V.id }).id, {});
    await deliverAll(v1.events);
    const v2 = S.complete(S.paymentLinkSession({ client_reference_id: V.id }).id, {});
    await deliverAll(v2.events);
    const vShown = w.row(V.id).stripe_subscription_id;
    await w.deliver(S.update(vShown, { status: 'canceled' }, 'customer.subscription.deleted'));
    chk('ending the subscription the row shows moves the row to the one still live', w.access(V.id).has_access && w.row(V.id).stripe_subscription_id !== vShown);

    /* ===================================================================== */
    /* 13. FAILURES ON OUR SIDE                                              */
    /* ===================================================================== */
    const W1 = w.user('wes@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, W1.token);
    const doneW = S.complete(r.body.session_id, {});
    S.fail('GET /v1/subscriptions', 1, 'stall');
    const t0 = Date.now();
    r = await w.deliver(doneW.events[0]);
    chk('Stripe timing out mid-webhook: the subscription event\'s own body is applied instead', r.status === 200 && r.body.via === 'payload' && w.access(W1.id).has_access, r.body);
    chk('inside the deadline, not hung', Date.now() - t0 < 30000);
    const X1 = w.user('xan@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, X1.token);
    const doneX = S.complete(r.body.session_id, {});
    S.fail('GET /v1/subscriptions', 1, 'stall');
    r = await w.deliver(doneX.events[1]);
    chk('a checkout that cannot be read from Stripe answers 500, so Stripe redelivers it', r.status === 500, r.body);
    S.S.idem = {};
    r = await w.deliver(doneX.events[1]);
    chk('and the redelivery lands', r.status === 200 && w.access(X1.id).has_access, r.body);
    chk('both attempts are counted', ev(doneX.events[1].id).attempts === 2);

    const Y = w.user('yara@example.com');
    r = await w.call('create_checkout_session', 'POST', OFFER, Y.token);
    const doneY = S.complete(r.body.session_id, {});
    w.rest.fail('rpc/billing_apply_subscription_state', 2);
    r = await w.deliver(doneY.events[0]);
    chk('a database write that fails after payment is a 500 — Stripe retries', r.status === 500, r.body);
    chk('with the error kept on the ledger', /apply|503|injected|db/i.test(String(ev(doneY.events[0].id).last_error)), ev(doneY.events[0].id));
    r = await w.deliver(doneY.events[0]);
    chk('and the retry grants access', r.status === 200 && w.access(Y.id).has_access);

    /* ===================================================================== */
    /* 14. IDENTITY                                                          */
    /* ===================================================================== */
    const ghost = '00000000-0000-4000-8000-00000000dead';
    const plGhost = S.paymentLinkSession({ client_reference_id: ghost });
    const doneGhost = S.complete(plGhost.id, { email: 'nobody-here@example.com' });
    r = await w.deliver(doneGhost.events[1]);
    chk('a client_reference_id that names no account is 200 + unresolved, never a 500 retry loop', r.status === 200 && r.body.unresolved === true, r.body);

    // the account's email changes, the Stripe customer's email changes: neither matters
    w.db.sql("update auth.users set email = 'gus.new@example.com' where id = " + PG.lit(G.id) + ';');
    S.S.customers[doneG.customer.id].email = 'gus.billing@example.net';
    r = await w.deliver(S.update(doneG.subscription.id, { cancel_at_period_end: true }));
    chk('emails changing on either side do not lose the account', r.body.how === 'metadata' && w.row(G.id).cancel_at_period_end === true, r.body);

    // an invoice in the newer API shape (subscription under parent.subscription_details)
    r = await w.deliver(S.ev('invoice.payment_succeeded', { id: 'in_new', object: 'invoice', customer: doneG.customer.id,
      parent: { subscription_details: { subscription: doneG.subscription.id, metadata: { supabase_user_id: G.id } } }, amount_paid: 4999 }));
    chk('an invoice in the newer API shape names its account too', r.status === 200 && r.body.how === 'metadata', r.body);

    // a test-mode event signed with the LIVE secret is a misconfiguration, refused
    const testEv = S.ev('customer.subscription.updated', S.snap(S.S.subscriptions[doneG.subscription.id]));
    testEv.livemode = false;
    r = await w.deliver(testEv);
    chk('mode validation: a test event on the live secret is refused', r.status === 400 && r.body.error === 'mode mismatch', r.body);
    r = await w.deliver(Object.assign({}, doneG.events[0], { id: 'evt_forged' }), 'whsec_wrong');
    chk('a forged signature is still refused', r.status === 400 && r.body.error === 'invalid signature');

    /* ===================================================================== */
    /* 15. NOBODY SEES OR CHANGES ANYBODY ELSE'S BILLING                     */
    /* ===================================================================== */
    r = await w.call('sync_subscription', 'POST', {});
    chk('reconciling needs a signed-in account', r.status === 401);
    r = await w.call('sync_subscription', 'POST', { user_id: K.id }, B.token);
    chk('a body naming another account reconciles the CALLER, not them', r.status === 200 && r.body.has_access === false &&
      w.q('select count(*)::int n from public.billing_sync_log where user_id = ' + PG.lit(B.id) + " and source = 'self'")[0].n >= 1, r.body);
    r = await w.call('sync_subscription', 'POST', { source: 'checkout_return', session_id: csA.id }, B.token);
    chk('somebody else\'s checkout session id links nothing to the caller',
      w.q('select count(*)::int n from public.billing_customers where user_id = ' + PG.lit(B.id))[0].n === 0, r.body);
    r = await w.call('sync_subscription', 'POST', { action: 'admin_inspect', query: 'kate@example.com' }, B.token);
    chk('the operator actions refuse a reader', r.status === 403);
    r = await w.call('create_checkout_session', 'POST', OFFER);
    chk('checkout refuses an anonymous caller', r.status === 401);
    chk('a reader\'s own decision describes only them', w.myAccess(B).user_id === B.id && w.myAccess(B).has_access === false);
    const leak = w.db.mustFail(() => w.db.as(B.id, 'select * from public.billing_customers;'));
    chk('a reader cannot read the customer map', /permission denied/.test(String(leak)));
    const leak2 = w.db.mustFail(() => w.db.as(B.id, "select public.billing_access_for('" + K.id + "');"));
    chk('or ask for another account\'s decision', /permission denied/.test(String(leak2)));

    // rate limit
    const Z = w.user('zed@example.com');
    let last = null;
    for (let i = 0; i < 13; i++) last = await w.call('sync_subscription', 'POST', {}, Z.token);
    chk('"Refresh access" is rate-limited per account', last.status === 429 && last.body.reason === 'rate_limited', last.body);

    // checkout refuses a price that is not the one consented to
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, OFFER, { price_cents: 7999 }), Z.token);
    chk('checkout refuses when the Stripe price is not the consented figure', r.status === 409 && r.body.reason === 'offer_mismatch', r.body);
    const noFn = w.load('create_checkout_session', { STRIPE_PRICE_ID: '' });
    const res = await noFn(new Request('https://fn.test/x', { method: 'POST', headers: { authorization: 'Bearer ' + Z.token, 'content-type': 'application/json' }, body: JSON.stringify(OFFER) }));
    const resBody = await res.json();
    chk('an unconfigured checkout says so, and only that answer permits the Payment Link fallback', res.status === 503 && resBody.fallback_ok === true, resBody);

    /* ===================================================================== */
    /* 16. THE LOGS CARRY THE TRACE AND NOTHING SECRET                       */
    /* ===================================================================== */
    const all = w.logs.map((l) => l.line).join('\n');
    chk('no Stripe key is ever logged', !/sk_live_placeholder|rk_live|whsec_/.test(all));
    chk('no session token is ever logged', !/tok_\d+_[0-9a-f]{8}/.test(all) && !/service-key/.test(all));
    chk('no full email is ever logged', !/alice@example\.com|kate@example\.com|zz9@privaterelay|x7k2@privaterelay/.test(all),
      w.logs.filter((l) => /alice@example\.com|kate@example\.com|zz9@privaterelay|x7k2@privaterelay/.test(l.line)).map((l) => l.line.slice(0, 400)));
    const traced = w.logs.map((l) => { try { return JSON.parse(l.line); } catch (_) { return null; } }).filter(Boolean);
    chk('a processed delivery traces account, customer, subscription and event',
      traced.some((x) => x.event === 'webhook.processed' && x.user_id && x.customer_id && x.subscription_id && x.stripe_event_id));
    chk('a created checkout traces account, session and customer',
      traced.some((x) => x.event === 'checkout.created' && x.user_id && x.session_id && x.customer_id));
    chk('an unresolved delivery is logged as such', traced.some((x) => x.event === 'webhook.unresolved'));

    /* ===================================================================== */
    /* 17. THE OPERATOR'S PICTURE                                            */
    /* ===================================================================== */
    const ov = JSON.parse(w.db.as(OWNER, 'select public.billing_admin_overview();'));
    chk('the overview counts open alerts by kind', ov.open_alerts_by_kind && typeof ov.unresolved_events_14d === 'number' && Array.isArray(ov.alerts));
    chk('and knows when the webhook last delivered', !!ov.last_webhook_delivery);
    r = await w.call('sync_subscription', 'POST', { action: 'admin_inspect', query: G.id }, ADMIN.token);
    const repG = r.body.reports[0];
    chk('inspect shows the row, Stripe live, the last event, the last sync, and whether access is granted',
      repG.row && repG.stripe_live && repG.stripe_live.best && repG.last_event && repG.last_successful_sync && repG.access.has_access === true, repG);
    chk('and no mismatch when they agree', repG.stripe_mismatches.length === 0, repG.stripe_mismatches);
    // make them disagree: Stripe cancels, and the event is lost
    S.S.subscriptions[doneG.subscription.id].status = 'canceled';
    r = await w.call('sync_subscription', 'POST', { action: 'admin_inspect', query: G.id }, ADMIN.token);
    chk('inspect names the disagreement when the DB grants what Stripe has ended',
      r.body.reports[0].stripe_mismatches.some((m) => /grants access but Stripe says canceled/.test(m)), r.body.reports[0].stripe_mismatches);
    r = await w.call('sync_subscription', 'POST', { action: 'admin_sync', user_id: G.id }, ADMIN.token);
    chk('and one click makes them agree', r.body.outcome === 'revoked' && !w.access(G.id).has_access, r.body);
    r = await w.call('sync_subscription', 'POST', { action: 'admin_inspect', query: 'EDS-' + 'NOPE00' }, ADMIN.token);
    chk('lookup by an unknown reference finds nothing, quietly', r.status === 200 && r.body.reports.length === 0);
  } catch (e) {
    chk('the suite ran to the end without throwing', false, String(e && e.stack || e).slice(0, 1200));
  } finally {
    w.stop();
  }
  process.exit(T.done());
})();

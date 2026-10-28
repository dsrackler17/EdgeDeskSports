#!/usr/bin/env node
/* ===========================================================================
   TWO PRODUCTS, ONE ACCOUNT ROW: Bet Checker (red) and the Research Terminal
   (blue), through the SHIPPED functions and the REAL SQL.

   Bet Checker is $7.99 and grades a reader's own bets. The Research Terminal is
   $49.99 and is the whole product. Both are Stripe subscriptions on the same
   public.subscriptions row, and the one access rule must never let the cheap
   one open the expensive one. What Stripe's product metadata says (tier = red
   | blue) is the only thing that decides which is which — no price id is
   written anywhere.

     buy Bet Checker (lookup key, ARL figure checked)  -> tier red, Bet Checker
                                                          paid, NO terminal
     buy it again / buy the terminal's trial beside it -> refused, nothing made
     switch red -> blue in Stripe (subscription.updated)-> tier blue, terminal,
                                                          Bet Checker never lost
     switch back, cancel                                -> red, then nothing
     a price whose product says the wrong tier          -> refused before Stripe
     Products unreadable by the webhook's key           -> the tier learned at
                                                          checkout still decides
     a price nobody ever named                          -> raised for a human

   Needs PostgreSQL (skips loudly without it, like every SQL suite here).
   Run: node tools/billing/tier_flow.test.js
   =========================================================================== */
'use strict';
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');

const T = PG.kit('billing tier flow');
const chk = T.chk;

const RED = { kind: 'bet_checker', plan: 'monthly', price_cents: 799, trial_days: 0, consent_version: 'bet-checker-2026-10' };
const RED_ANNUAL = { kind: 'bet_checker', plan: 'annual', price_cents: 5900, trial_days: 0, consent_version: 'bet-checker-2026-10' };
const BLUE = { kind: 'trial', price_cents: 4999, trial_days: 7, consent_version: 'arl-2026-09-v7-trial7' };

(async () => {
  const w = H.world('billtier');
  if (w.skip) { console.log('SKIP | billing tier flow | ' + w.skip); process.exit(0); }
  const S = w.stripe;
  const deliverAll = async (events) => { const out = []; for (const e of events) out.push(await w.deliver(e)); return out; };
  const tierOf = (price) => (w.q('select tier from public.billing_price_tiers where price_id = ' + PG.lit(price))[0] || {}).tier || null;
  const sql1 = (q) => w.db.sql(q);
  const paid = (uid) => sql1('select public.has_bet_checker_paid(' + PG.lit(uid) + ')') === 't';
  const alerts = (kind) => w.q('select * from public.billing_alerts where kind = ' + PG.lit(kind) + ' order by id');
  const sessions = () => Object.keys(S.S.sessions).length;
  const priceItem = (pid) => ({ object: 'list', data: [{ id: 'si_' + pid, price: JSON.parse(JSON.stringify(S.S.prices[pid])) }] });

  try {
    /* ===================================================================== */
    /* 1. BET CHECKER, BOUGHT                                                */
    /* ===================================================================== */
    const R = w.user('red@example.com');
    let r = await w.call('create_checkout_session', 'POST', RED, R.token);
    chk('Bet Checker checkout: a Stripe Checkout URL', r.status === 200 && r.body.ok && /^https:\/\/checkout\.stripe\.com\//.test(r.body.url), r.body);
    const csR = S.S.sessions[r.body.session_id];
    chk('the price is the one holding the lookup key bet_checker_monthly (no price id in any file)', csR && csR.line_items[0].price === 'price_799', csR && csR.line_items);
    chk('no trial on Bet Checker', !csR.subscription_data.trial_period_days);
    chk('it comes back to the Bet Checker page, not the terminal', /\/bet-checker\/\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/.test(csR.success_url) &&
      /\/bet-checker\/\?checkout=cancel$/.test(csR.cancel_url), [csR.success_url, csR.cancel_url]);
    chk('the account is on the session, the subscription and the customer, as for the terminal',
      csR.client_reference_id === R.id && csR.subscription_data.metadata.supabase_user_id === R.id &&
      S.S.customers[csR.customer].metadata.supabase_user_id === R.id);
    chk('what the price sells is recorded BEFORE anybody pays: red, from the product\'s metadata', tierOf('price_799') === 'red');
    chk('the session is on record as a Bet Checker checkout',
      (w.q('select kind, price_id, trial_days from public.billing_checkout_sessions where id = ' + PG.lit(csR.id))[0] || {}).kind === 'bet_checker');
    chk('nothing is paid for yet', !paid(R.id) && !w.access(R.id).has_access);

    const doneR = S.complete(csR.id, { email: 'red@example.com' });
    const outR = await deliverAll(doneR.events);
    chk('the webhook answers every delivery 200', outR.every((x) => x.status === 200), outR.map((x) => x.status));
    let row = w.row(R.id);
    chk('row: active, the Bet Checker price, tier RED', row.status === 'active' && row.price_id === 'price_799' && row.tier === 'red', row);
    let acc = w.access(R.id);
    chk('Bet Checker is paid', acc.bet_checker_paid === true && paid(R.id), acc);
    chk('THE TERMINAL IS NOT: a $7.99 purchase never opens the $49.99 product', acc.has_access === false, acc);
    chk('and the decision says why, and what to offer', acc.reason === 'bet_checker_only' && acc.offer === 'upgrade' && acc.tier === 'red', acc);
    chk('a Bet Checker row is not "behind Stripe": no reconcile on every page', acc.should_sync === false, acc);
    chk('the rule itself says no to the row, and the standing rule says it is paid up',
      sql1("select public.billing_row_grants_access(status, price_id, current_period_end, now())::text || '|' || " +
           "public.billing_row_in_good_standing(status, price_id, current_period_end, now())::text from public.subscriptions where user_id = " + PG.lit(R.id)) === 'false|true');
    const mine = w.myAccess(R);
    chk('the reader\'s own door says the same', mine && mine.has_access === false && mine.bet_checker_paid === true && mine.tier === 'red', mine);
    chk('a purchase landing is a GRANT in the log, whatever was bought',
      outR.some((x) => x.body && x.body.outcome === 'granted'), outR.map((x) => x.body && x.body.outcome));

    r = await w.call('sync_subscription', 'POST', { source: 'checkout_return', session_id: csR.id }, R.token);
    chk('the return from Stripe confirms Bet Checker (has_access stays the terminal\'s answer)',
      r.status === 200 && r.body.has_access === false && r.body.access.bet_checker_paid === true && r.body.access.tier === 'red' &&
      r.body.message === 'Access confirmed.', r.body);

    /* ===================================================================== */
    /* 2. WHAT IT REFUSES                                                    */
    /* ===================================================================== */
    let n0 = sessions();
    r = await w.call('create_checkout_session', 'POST', RED, R.token);
    chk('Bet Checker again: 409 already_entitled, nothing created', r.status === 409 && r.body.reason === 'already_entitled' && sessions() === n0, r.body);
    r = await w.call('create_checkout_session', 'POST', BLUE, R.token);
    chk('the terminal\'s trial beside Bet Checker: 409 switch_plan — never a second subscription',
      r.status === 409 && r.body.reason === 'switch_plan' && /Settings/.test(r.body.message) && sessions() === n0, r.body);

    const M = w.user('mismatch@example.com');
    n0 = sessions();
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, RED, { price_cents: 899 }), M.token);
    chk('a figure the consent did not show: 409 offer_mismatch before anything is made', r.status === 409 && r.body.reason === 'offer_mismatch' && sessions() === n0, r.body);
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, RED, { trial_days: 7 }), M.token);
    chk('a trial Bet Checker does not have: refused', r.status === 409 && r.body.reason === 'offer_mismatch', r.body);
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, RED, { plan: 'weekly' }), M.token);
    chk('a plan that does not exist: 400', r.status === 400 && r.body.reason === 'bad_plan', r.body);

    /* the annual price, by its own lookup key and interval */
    r = await w.call('create_checkout_session', 'POST', RED_ANNUAL, M.token);
    chk('the annual plan sells the price holding bet_checker_annual', r.status === 200 && S.S.sessions[r.body.session_id].line_items[0].price === 'price_5900', r.body);
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, RED_ANNUAL, { price_cents: 799 }), M.token);
    chk('the monthly figure on the annual plan is refused', r.status === 409 && r.body.reason === 'offer_mismatch', r.body);

    /* a product whose metadata does not say red is never sold as Bet Checker */
    S.S.products.prod_bet_checker.metadata = {};
    const freshCheckout = w.load('create_checkout_session');      // a cold instance: no cached price
    const N = w.user('notier@example.com');
    n0 = sessions();
    let req = new Request('https://fn.test/functions/v1/create_checkout_session', { method: 'POST',
      headers: { 'content-type': 'application/json', apikey: 'anon-key', authorization: 'Bearer ' + N.token }, body: JSON.stringify(RED) });
    let res = await freshCheckout(req);
    let j = await res.json();
    chk('a Bet Checker product without metadata tier = red: 409 offer_mismatch, nothing made', res.status === 409 && j.reason === 'offer_mismatch' && sessions() === n0, j);
    S.S.products.prod_bet_checker.metadata = { tier: 'red' };
    /* and the terminal's price on a red product is refused the other way */
    S.S.products.prod_edgedesk.metadata = { tier: 'red' };
    req = new Request('https://fn.test/functions/v1/create_checkout_session', { method: 'POST',
      headers: { 'content-type': 'application/json', apikey: 'anon-key', authorization: 'Bearer ' + N.token }, body: JSON.stringify(BLUE) });
    res = await w.load('create_checkout_session')(req);
    j = await res.json();
    chk('STRIPE_PRICE_ID on a red product: the terminal checkout is refused', res.status === 409 && j.reason === 'offer_mismatch', j);
    S.S.products.prod_edgedesk.metadata = { tier: 'blue' };

    /* ===================================================================== */
    /* 3. UPGRADE, IN STRIPE: THE SAME SUBSCRIPTION CHANGES PRICE            */
    /* ===================================================================== */
    const subR = doneR.subscription.id;
    let e = S.update(subR, { items: priceItem('price_4999') });
    r = await w.deliver(e);
    row = w.row(R.id); acc = w.access(R.id);
    chk('customer.subscription.updated to the terminal\'s price: 200', r.status === 200, r.body);
    chk('tier flips to BLUE on the same row and the same subscription', row.tier === 'blue' && row.price_id === 'price_4999' && row.stripe_subscription_id === subR, row);
    chk('the terminal opens', acc.has_access === true && acc.offer === 'none', acc);
    chk('and Bet Checker was never lost: blue includes it', acc.bet_checker_paid === true && paid(R.id), acc);
    chk('the terminal\'s price was learned from its product: blue', tierOf('price_4999') === 'blue');
    n0 = sessions();
    r = await w.call('create_checkout_session', 'POST', RED, R.token);
    chk('a terminal customer asking for Bet Checker is told it is included', r.status === 409 && r.body.reason === 'already_entitled' && /includes Bet Checker/.test(r.body.message) && sessions() === n0, r.body);

    /* and back again */
    e = S.update(subR, { items: priceItem('price_799') });
    await w.deliver(e);
    row = w.row(R.id); acc = w.access(R.id);
    chk('a switch back to Bet Checker: red again, terminal closed, Bet Checker kept',
      row.tier === 'red' && acc.has_access === false && acc.bet_checker_paid === true, [row.tier, acc]);

    /* cancelled */
    e = S.update(subR, { status: 'canceled' }, 'customer.subscription.deleted');
    await w.deliver(e);
    acc = w.access(R.id);
    chk('customer.subscription.deleted: nothing paid any more', acc.has_access === false && acc.bet_checker_paid === false && !paid(R.id), acc);

    /* ===================================================================== */
    /* 4. A KEY THAT CANNOT READ PRODUCTS                                    */
    /* ===================================================================== */
    const P = w.user('nokey@example.com');
    r = await w.call('create_checkout_session', 'POST', RED, P.token);
    const csP = S.S.sessions[r.body.session_id];
    const doneP = S.complete(csP.id, { email: 'nokey@example.com' });
    const webhookNoProducts = w.load('stripe_webhook');           // a cold instance: nothing cached
    const products = S.S.products;
    S.S.products = {};                                            // every product read now fails
    const before = S.calls.length;
    for (const ev of doneP.events) await w.deliver(ev, null, webhookNoProducts);
    const askedProducts = S.calls.slice(before).filter((c) => /^GET \/v1\/products\//.test(c)).length;
    S.S.products = products;
    chk('the webhook did ask Stripe for the product (and was refused)', askedProducts > 0, S.calls.slice(before));
    acc = w.access(P.id);
    chk('Stripe would not say (403/500 on Products): the tier learned at checkout still decides — red, no terminal',
      w.row(P.id).tier === 'red' && acc.has_access === false && acc.bet_checker_paid === true, [w.row(P.id), acc]);

    /* ===================================================================== */
    /* 5. A PRICE NOBODY EVER NAMED                                          */
    /* ===================================================================== */
    S.S.products.prod_mystery = { id: 'prod_mystery', object: 'product', active: true, name: 'Something new', metadata: {} };
    S.S.prices.price_mystery = { id: 'price_mystery', object: 'price', active: true, type: 'recurring', currency: 'usd',
      unit_amount: 1999, recurring: { interval: 'month', interval_count: 1 }, product: 'prod_mystery', lookup_key: null };
    const U = w.user('mystery@example.com');
    const custU = S.customer('mystery@example.com', { supabase_user_id: U.id });
    const subU = S.subscription(custU.id, 'price_mystery', { metadata: { supabase_user_id: U.id } });
    await w.deliver(S.ev('customer.subscription.created', S.snap(subU)));
    chk('a price whose product names no tier is never guessed: it stays unknown', tierOf('price_mystery') === null && w.row(U.id).tier === null, w.row(U.id));
    chk('and is raised for a human', alerts('unknown_price_tier').some((a) => a.detail && a.detail.price_id === 'price_mystery'), alerts('unknown_price_tier'));

    /* ===================================================================== */
    /* 6. BOTH AT ONCE: THE TERMINAL WINS, AND IT IS A DUPLICATE             */
    /* ===================================================================== */
    const D = w.user('both@example.com');
    r = await w.call('create_checkout_session', 'POST', RED, D.token);
    const doneD = S.complete(r.body.session_id, { email: 'both@example.com' });
    await deliverAll(doneD.events);
    /* a terminal subscription bought around the server (the old Payment Link) */
    const subBlue = S.subscription(doneD.customer.id, 'price_4999', { metadata: { supabase_user_id: D.id } });
    await w.deliver(S.ev('customer.subscription.created', S.snap(subBlue)));
    row = w.row(D.id); acc = w.access(D.id);
    chk('two live subscriptions, red and blue: the row describes the terminal', row.stripe_subscription_id === subBlue.id && row.tier === 'blue' && acc.has_access, row);
    chk('and the pair is a duplicate purchase a human must see', alerts('duplicate_active_subscriptions').some((a) => a.user_id === D.id), alerts('duplicate_active_subscriptions'));

    /* ===================================================================== */
    /* 7. THE TERMINAL'S OWN PURCHASE IS UNCHANGED                           */
    /* ===================================================================== */
    const B = w.user('blue@example.com');
    r = await w.call('create_checkout_session', 'POST', BLUE, B.token);
    chk('the terminal trial still sells STRIPE_PRICE_ID with its 7 days', r.status === 200 &&
      S.S.sessions[r.body.session_id].line_items[0].price === 'price_4999' && S.S.sessions[r.body.session_id].subscription_data.trial_period_days === '7', r.body);
    const doneB = S.complete(r.body.session_id, { email: 'blue@example.com' });
    await deliverAll(doneB.events);
    acc = w.access(B.id);
    chk('a terminal trial: tier blue, terminal open, Bet Checker included', w.row(B.id).tier === 'blue' && acc.has_access && acc.bet_checker_paid, acc);

    /* ===================================================================== */
    /* 8. NOTHING SECRET IN ANY LOG LINE                                     */
    /* ===================================================================== */
    const leaks = w.logs.filter((l) => /sk_live_|whsec_|tok_\d+_|Bearer /.test(l.line));
    chk('no key, signing secret or token reached a log line', leaks.length === 0, leaks.slice(0, 3));
  } catch (err) {
    chk('the scenario ran to the end', false, String(err && err.stack || err));
  } finally {
    w.stop();
  }
  process.exit(T.done());
})();

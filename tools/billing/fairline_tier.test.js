#!/usr/bin/env node
/* ===========================================================================
   THE THIRD PRODUCT: Fairline (tier black), through the SHIPPED functions and
   the REAL SQL — and why it can never open the Research Terminal.

   Fairline is $19.99 and includes Bet Checker; the Research Terminal (blue) is
   $49.99 and includes both. All three are Stripe subscriptions on the same
   public.subscriptions row, and the one access rule reads a price it has never
   learned as the terminal (every price sold before Bet Checker was). So a
   Fairline price the database does not know would unlock the whole terminal
   for $19.99. This proves it cannot:

     buy Fairline (lookup key, ARL figure checked)   -> tier black, learned
                                                        BEFORE the session; Fairline
                                                        and Bet Checker paid, NO
                                                        terminal (billing_row_grants_access,
                                                        community_is_entitled, a
                                                        has_active_sub that defers to the
                                                        rule, signals RLS)
     a Fairline price the database could not record -> refused at checkout (an
                                                        error, or 'refused:tier' from a
                                                        database that does not know black)
     a plan switch in the portal to a Fairline price
     nobody bought through checkout yet              -> black, whether Stripe names the
                                                        product, refuses Products (403),
                                                        or cannot be asked at all
     buy again / Bet Checker beside it / the trial   -> already_entitled / switch_plan
     a Bet Checker customer buying Fairline          -> switch_plan, never a second
                                                        subscription
     the terminal (blue)                             -> still everything
     the rule, mirrored in the server core and the
     browser                                         -> equal to the SQL on a grid
     Juice Reel's terminal over a live Fairline plan -> taken over, and raised

   Needs PostgreSQL (skips loudly without it, like every SQL suite here;
   FAIRLINE_TIER_REQUIRED=1 makes a missing one a failure).
   Run: node tools/billing/fairline_tier.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');
const ACCESS = require('../../lib/edgedesk_access.js');
const PRICING = require('../../lib/edgedesk_pricing.js');
const CORE = new Function(fs.readFileSync(path.join(__dirname, 'billing_core.js'), 'utf8') +
  '\nreturn { grantsAccess, grantsBetChecker, grantsFairline, tierOfLookupKey, TIERS };')();

const T = PG.kit('billing fairline tier');
const chk = T.chk;
const lit = PG.lit;

const BLACK = { kind: 'fairline', plan: 'monthly', price_cents: 1999, trial_days: 0, consent_version: 'fairline-2026-10' };
const BLACK_ANNUAL = { kind: 'fairline', plan: 'annual', price_cents: 15900, trial_days: 0, consent_version: 'fairline-2026-10' };
const RED = { kind: 'bet_checker', plan: 'monthly', price_cents: 799, trial_days: 0, consent_version: 'bet-checker-2026-10' };
const BLUE = { kind: 'trial', price_cents: 4999, trial_days: 7, consent_version: 'arl-2026-09-v7-trial7' };

/* ── STATIC: the figures are written once, and match the checkout ──────── */
const CO = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'create_checkout_session', 'index.ts'), 'utf8');
chk('the page sells $19.99 a month and $159.00 a year, by the lookup keys the checkout reads',
  PRICING.fairlineOffer('monthly').price_cents === 1999 && PRICING.fairlineOffer('annual').price_cents === 15900 &&
  PRICING.FAIRLINE.PLANS.monthly.LOOKUP_KEY === 'fairline_monthly' && PRICING.FAIRLINE.PLANS.annual.LOOKUP_KEY === 'fairline_annual' &&
  /monthly: \{ lookup_key: 'fairline_monthly', interval: 'month' \}/.test(CO) && /annual: \{ lookup_key: 'fairline_annual', interval: 'year' \}/.test(CO));
chk('the renewal terms: $19.99 per month, renews automatically, no trial, cancel in Settings on the Fairline page',
  /\$19\.99 per month, renews automatically/.test(PRICING.fairlineTerms('monthly')) && /no free trial/i.test(PRICING.fairlineTerms('monthly')) &&
  /Settings › Subscription on the Fairline page/.test(PRICING.fairlineTerms('monthly')) && /\$159\.00 per year/.test(PRICING.fairlineTerms('annual')));
chk('the checkout sells Fairline only from a product that says black', /const TIER_BY_KIND = \{ bet_checker: 'red', fairline: 'black' \};/.test(CO));
chk('the server core knows three tiers, and a Fairline lookup key is black, a Bet Checker one red, anything else nothing',
  CORE.TIERS.join() === 'red,black,blue' && CORE.tierOfLookupKey('fairline_monthly') === 'black' && CORE.tierOfLookupKey('fairline_annual_2027') === 'black' &&
  CORE.tierOfLookupKey('bet_checker_annual') === 'red' && CORE.tierOfLookupKey('edgedesk_monthly') === null && CORE.tierOfLookupKey(null) === null);

(async () => {
  const w = H.world('billblack');
  if (w.skip) {
    if (process.env.FAIRLINE_TIER_REQUIRED === '1') chk('environment: ' + w.skip, false);
    console.log('SKIP | billing fairline tier | ' + w.skip + ' (not verified)');
    process.exit(T.done());
  }
  const S = w.stripe;
  const sql1 = (q) => w.db.sql(q);
  const tierOf = (price) => (w.q('select tier from public.billing_price_tiers where price_id = ' + lit(price))[0] || {}).tier || null;
  const fl = (uid) => sql1('select public.has_fairline_paid(' + lit(uid) + ')') === 't';
  const bc = (uid) => sql1('select public.has_bet_checker_paid(' + lit(uid) + ')') === 't';
  const terminal = (uid) => sql1("select coalesce((select public.billing_row_grants_access(status, price_id, current_period_end, now()) from public.subscriptions where user_id = " + lit(uid) + '), false)') === 't';
  const sessions = () => Object.keys(S.S.sessions).length;
  const priceItem = (pid) => ({ object: 'list', data: [{ id: 'si_' + pid, price: JSON.parse(JSON.stringify(S.S.prices[pid])) }] });
  const deliverAll = async (events, handler) => { const out = []; for (const e of events) out.push(await w.deliver(e, null, handler)); return out; };
  const alerts = (kind) => w.q('select * from public.billing_alerts where kind = ' + lit(kind) + ' order by id');

  /* the Fairline product and its two prices, as Stripe will hold them */
  S.S.products.prod_fairline = { id: 'prod_fairline', object: 'product', active: true, name: 'Fairline', metadata: { tier: 'black' } };
  S.S.prices.price_1999 = { id: 'price_1999', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 1999,
    recurring: { interval: 'month', interval_count: 1 }, product: 'prod_fairline', lookup_key: 'fairline_monthly' };
  S.S.prices.price_15900 = { id: 'price_15900', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 15900,
    recurring: { interval: 'year', interval_count: 1 }, product: 'prod_fairline', lookup_key: 'fairline_annual' };

  /* has_active_sub() lives only in production (docs/market-intelligence/AUDIT.md);
     docs/billing-hardening.md §11 query 10 requires it to defer to the one rule.
     This is that stand-in, and an RLS policy on a signals table that calls it,
     as production's paywall does. */
  w.db.sql(`create or replace function public.has_active_sub() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
              select exists (select 1 from public.subscriptions s where s.user_id = auth.uid()
                              and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())) $$;
            grant execute on function public.has_active_sub() to authenticated;
            create table public.signals (sig_key text primary key, sharp_fair numeric);
            insert into public.signals values ('k1', 0.52), ('k2', 0.48);
            alter table public.signals enable row level security;
            create policy signals_sub on public.signals for select to authenticated using (public.has_active_sub());
            grant select on public.signals to authenticated;`);
  /* community_is_entitled(): what tennis_record.sql and personal_research.sql
     defer to; billing_hardening.sql points it at the one rule where installed */
  ['site_articles.sql', 'community_posts.sql'].forEach((f) => w.db.applyFile(path.join(PG.ROOT, 'supabase', f)));
  w.db.applyFile(path.join(PG.ROOT, 'supabase', 'billing_hardening.sql'));
  const entitled = (uid) => sql1('select public.community_is_entitled(' + lit(uid) + ')') === 't';
  const activeSub = (u) => w.db.as(u.id, 'select public.has_active_sub();') === 't';
  const signalsSeen = (u) => Number(w.db.as(u.id, 'select count(*) from public.signals;'));

  try {
    /* ===================================================================== */
    /* 1. FAIRLINE, BOUGHT                                                   */
    /* ===================================================================== */
    const F = w.user('fairline@example.com');
    let r = await w.call('create_checkout_session', 'POST', BLACK, F.token);
    chk('Fairline checkout: a Stripe Checkout URL', r.status === 200 && r.body.ok && /^https:\/\/checkout\.stripe\.com\//.test(r.body.url), r.body);
    const csF = S.S.sessions[r.body.session_id];
    chk('the price is the one holding the lookup key fairline_monthly (no price id in any file)', csF && csF.line_items[0].price === 'price_1999', csF && csF.line_items);
    chk('no trial on Fairline', !csF.subscription_data.trial_period_days);
    chk('it comes back to the Fairline page', /\/fairline\/\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/.test(csF.success_url) &&
      /\/fairline\/\?checkout=cancel$/.test(csF.cancel_url), [csF.success_url, csF.cancel_url]);
    chk('what the price sells is recorded BEFORE anybody pays: black, from the product\'s metadata', tierOf('price_1999') === 'black');
    chk('the session is on record as a Fairline checkout', (w.q('select kind from public.billing_checkout_sessions where id = ' + lit(csF.id))[0] || {}).kind === 'fairline');
    chk('nothing is paid for yet', !fl(F.id) && !bc(F.id) && !terminal(F.id));

    const doneF = S.complete(csF.id, { email: 'fairline@example.com' });
    const outF = await deliverAll(doneF.events);
    chk('the webhook answers every delivery 200', outF.every((x) => x.status === 200), outF.map((x) => x.status));
    const rowF = w.row(F.id);
    chk('row: active, the Fairline price, tier BLACK', rowF.status === 'active' && rowF.price_id === 'price_1999' && rowF.tier === 'black', rowF);
    let acc = w.access(F.id);
    chk('Fairline is paid, and Bet Checker with it', acc.fairline_paid === true && acc.bet_checker_paid === true && fl(F.id) && bc(F.id), acc);
    chk('A BLACK SUBSCRIPTION NEVER PASSES billing_row_grants_access(): no terminal for $19.99', acc.has_access === false && !terminal(F.id), acc);
    chk('and the decision says why, and offers the plan switch', acc.reason === 'fairline_only' && acc.offer === 'upgrade' && acc.tier === 'black' && acc.should_sync === false, acc);
    chk('A BLACK SUBSCRIPTION NEVER PASSES has_active_sub() (the stand-in that defers to the rule)', activeSub(F) === false);
    chk('…nor community_is_entitled() (pointed at the rule by billing_hardening.sql)', entitled(F.id) === false &&
      /billing_row_grants_access/.test(sql1("select pg_get_functiondef('public.community_is_entitled(uuid)'::regprocedure)")));
    chk('…so the terminal\'s RLS shows a Fairline customer no signal', signalsSeen(F) === 0);
    const mine = w.myAccess(F);
    chk('the reader\'s own door says the same', mine && mine.has_access === false && mine.fairline_paid === true && mine.tier === 'black', mine);
    chk('a Fairline purchase landing is a GRANT in the log', outF.some((x) => x.body && x.body.outcome === 'granted'), outF.map((x) => x.body && x.body.outcome));
    r = await w.call('sync_subscription', 'POST', { source: 'checkout_return', session_id: csF.id }, F.token);
    chk('the return from Stripe confirms Fairline, and still no terminal', r.status === 200 && r.body.has_access === false && r.body.access.fairline_paid === true, r.body);

    /* ===================================================================== */
    /* 2. WHAT IT REFUSES                                                    */
    /* ===================================================================== */
    let n0 = sessions();
    r = await w.call('create_checkout_session', 'POST', BLACK, F.token);
    chk('Fairline again: 409 already_entitled, nothing created', r.status === 409 && r.body.reason === 'already_entitled' && sessions() === n0, r.body);
    r = await w.call('create_checkout_session', 'POST', RED, F.token);
    chk('Bet Checker beside Fairline: already included', r.status === 409 && r.body.reason === 'already_entitled' && /Fairline plan already includes Bet Checker/.test(r.body.message), r.body);
    r = await w.call('create_checkout_session', 'POST', BLUE, F.token);
    chk('the terminal\'s trial beside Fairline: 409 switch_plan, never a second subscription', r.status === 409 && r.body.reason === 'switch_plan' &&
      /has Fairline/.test(r.body.message) && sessions() === n0, r.body);
    const M = w.user('mismatch@example.com');
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, BLACK, { price_cents: 1499 }), M.token);
    chk('a figure the consent did not show: 409 offer_mismatch before anything is made', r.status === 409 && r.body.reason === 'offer_mismatch' && sessions() === n0, r.body);
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, BLACK, { trial_days: 7 }), M.token);
    chk('a trial Fairline does not have: refused', r.status === 409 && r.body.reason === 'offer_mismatch', r.body);
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, BLACK, { plan: 'weekly' }), M.token);
    chk('a plan that does not exist: 400', r.status === 400 && r.body.reason === 'bad_plan' && /Fairline/.test(r.body.message), r.body);
    r = await w.call('create_checkout_session', 'POST', Object.assign({}, BLACK, { kind: 'black' }), M.token);
    chk('a kind that does not exist: 400', r.status === 400 && r.body.reason === 'bad_kind', r.body);
    r = await w.call('create_checkout_session', 'POST', BLACK_ANNUAL, M.token);
    chk('the annual plan sells the price holding fairline_annual', r.status === 200 && S.S.sessions[r.body.session_id].line_items[0].price === 'price_15900', r.body);

    const cold = async (body, token, env) => {
      const res = await w.load('create_checkout_session', env)(new Request('https://fn.test/functions/v1/create_checkout_session', { method: 'POST',
        headers: { 'content-type': 'application/json', apikey: 'anon-key', authorization: 'Bearer ' + token }, body: JSON.stringify(body) }));
      return { status: res.status, body: await res.json() };
    };
    const N = w.user('notier@example.com');
    for (const meta of [{}, { tier: 'red' }, { tier: 'blue' }]) {
      S.S.products.prod_fairline.metadata = meta;
      n0 = sessions();
      r = await cold(BLACK, N.token);
      chk('a Fairline product whose metadata says ' + JSON.stringify(meta) + ': 409 offer_mismatch, nothing made', r.status === 409 && r.body.reason === 'offer_mismatch' && sessions() === n0, r.body);
    }
    S.S.products.prod_fairline.metadata = { tier: 'black' };
    S.S.products.prod_edgedesk.metadata = { tier: 'black' };
    r = await cold(BLUE, N.token);
    chk('STRIPE_PRICE_ID on a black product: the terminal checkout is refused', r.status === 409 && r.body.reason === 'offer_mismatch', r.body);
    S.S.products.prod_edgedesk.metadata = { tier: 'blue' };

    /* ===================================================================== */
    /* 3. AN UNLEARNED PRICE IS REFUSED AT CHECKOUT, NEVER DEFAULTED TO BLUE */
    /* ===================================================================== */
    S.S.prices.price_1999_new = Object.assign({}, S.S.prices.price_1999, { id: 'price_1999_new' });
    S.S.prices.price_1999.lookup_key = 'fairline_monthly_retired';
    chk('(evidence) an unlearned price IS read as the terminal by the rule — so the refusal below is load-bearing',
      sql1("select public.billing_row_grants_access('active', 'price_1999_new', now() + interval '1 day', now())") === 't' && tierOf('price_1999_new') === null);
    /* (a) a database that does not know black yet: billing_hardening.sql not re-applied */
    const learnSrc = sql1("select pg_get_functiondef('public.billing_learn_price_tier(text,text,text,text,boolean,text)'::regprocedure)");
    sql1(learnSrc.replace("if v_tier not in ('red', 'black', 'blue') then return 'refused:tier'; end if;", "if v_tier not in ('red', 'blue') then return 'refused:tier'; end if;"));
    chk('(the stand-in database refuses black, as the two-tier file did)', sql1("select public.billing_learn_price_tier('price_probe', null, 'black', null, true, 'probe')") === 'refused:tier');
    const U = w.user('unlearned@example.com');
    n0 = sessions();
    r = await cold(BLACK, U.token);
    chk('the database answered refused:tier: 503, nothing created, nothing charged', r.status === 503 && r.body.reason === 'not_configured' && sessions() === n0 &&
      /Nothing has been charged/.test(r.body.message), r.body);
    chk('…and the price is still unknown: nothing was sold under it', tierOf('price_1999_new') === null && !fl(U.id) && !terminal(U.id));
    chk('the refusal is in the log, with the tier', w.logs.some((l) => /checkout\.tier_unrecorded/.test(l.line) && /refused:tier/.test(l.line) && /"tier":"black"/.test(l.line)));
    sql1(learnSrc);   /* the real function back */
    /* (b) the database call itself fails */
    sql1('revoke execute on function public.billing_learn_price_tier(text, text, text, text, boolean, text) from service_role;');
    n0 = sessions();
    r = await cold(BLACK, U.token);
    chk('the database could not be asked: 503, nothing created', r.status === 503 && r.body.reason === 'not_configured' && sessions() === n0 && tierOf('price_1999_new') === null, r.body);
    sql1('grant execute on function public.billing_learn_price_tier(text, text, text, text, boolean, text) to service_role;');
    r = await cold(BLACK, U.token);
    chk('with the database answering again, the same checkout sells, and the price is learned black first', r.status === 200 && tierOf('price_1999_new') === 'black', r.body);
    S.S.prices.price_1999.lookup_key = 'fairline_monthly';
    delete S.S.prices.price_1999_new;

    /* ===================================================================== */
    /* 4. A PLAN SWITCH IN THE PORTAL TO A FAIRLINE PRICE NEVER LEARNED      */
    /* ===================================================================== */
    /* Bet Checker customers, switched in Stripe's billing portal to Fairline
       prices nobody has bought through checkout yet */
    const redBuyer = async (email) => {
      const u = w.user(email);
      const c = await w.call('create_checkout_session', 'POST', RED, u.token);
      const d = S.complete(S.S.sessions[c.body.session_id].id, { email });
      await deliverAll(d.events);
      return { u, sub: d.subscription.id };
    };
    const freshPrice = (id, product, meta) => {
      S.S.prices[id] = { id, object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 1999,
        recurring: { interval: 'month', interval_count: 1 }, product, lookup_key: 'fairline_' + id, metadata: meta || {} };
    };
    /* (a) Stripe names the product */
    let A1 = await redBuyer('switch.a@example.com');
    chk('(a red customer, Bet Checker only)', w.row(A1.u.id).tier === 'red' && !fl(A1.u.id));
    freshPrice('price_sw_a', 'prod_fairline');
    let ev = S.update(A1.sub, { items: priceItem('price_sw_a') });
    r = await w.deliver(ev);
    chk('switched, product readable: learned BLACK, Fairline paid, no terminal', r.status === 200 && tierOf('price_sw_a') === 'black' && w.row(A1.u.id).tier === 'black' &&
      fl(A1.u.id) && !terminal(A1.u.id) && activeSub(A1.u) === false, [tierOf('price_sw_a'), w.row(A1.u.id)]);
    /* (b) a key Stripe refuses Products (403), and the price carries no tier: its lookup key names it */
    A1 = await redBuyer('switch.b@example.com');
    freshPrice('price_sw_b', 'prod_fairline');
    S.S.productsForbidden = true;
    ev = S.update(A1.sub, { items: priceItem('price_sw_b') });
    r = await w.deliver(ev, null, w.load('stripe_webhook'));
    S.S.productsForbidden = false;
    chk('switched, Products refused: the Fairline lookup key names it BLACK — never the terminal', r.status === 200 && tierOf('price_sw_b') === 'black' &&
      w.row(A1.u.id).tier === 'black' && !terminal(A1.u.id) && fl(A1.u.id), [tierOf('price_sw_b'), w.row(A1.u.id)]);
    chk('…learned from the lookup key, and said so', (w.q("select source from public.billing_price_tiers where price_id = 'price_sw_b'")[0] || {}).source === 'webhook:lookup_key' &&
      w.logs.some((l) => /reconcile\.tier_from_price/.test(l.line) && /price_sw_b/.test(l.line)));
    /* (c) the product was read and names no tier (a misconfigured product): the lookup key still keeps it off the terminal */
    A1 = await redBuyer('switch.c@example.com');
    S.S.products.prod_untagged = { id: 'prod_untagged', object: 'product', active: true, name: 'Fairline (untagged)', metadata: {} };
    freshPrice('price_sw_c', 'prod_untagged', { tier: 'blue' });
    ev = S.update(A1.sub, { items: priceItem('price_sw_c') });
    r = await w.deliver(ev, null, w.load('stripe_webhook'));
    chk('switched to an untagged product: never overruled by the price\'s metadata (blue), named black by its Fairline lookup key',
      tierOf('price_sw_c') === 'black' && !terminal(A1.u.id), [tierOf('price_sw_c'), w.row(A1.u.id)]);
    /* (d) Stripe cannot be asked at all: the event's own body, before it is written */
    A1 = await redBuyer('switch.d@example.com');
    freshPrice('price_sw_d', 'prod_fairline');
    ev = S.update(A1.sub, { items: priceItem('price_sw_d') });
    r = await w.deliver(ev, null, w.load('stripe_webhook', { STRIPE_SECRET_KEY: '' }));
    chk('switched while Stripe cannot be asked: written from the event, named BLACK first, no terminal', r.status === 200 && r.body.via !== 'live' &&
      tierOf('price_sw_d') === 'black' && w.row(A1.u.id).price_id === 'price_sw_d' && w.row(A1.u.id).tier === 'black' && !terminal(A1.u.id), [r.body, w.row(A1.u.id)]);
    /* and a price NOTHING names (no product, no tier, no EdgeDesk lookup key) is still raised for a human */
    A1 = await redBuyer('switch.e@example.com');
    S.S.prices.price_mystery = { id: 'price_mystery', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 2500,
      recurring: { interval: 'month', interval_count: 1 }, product: 'prod_untagged', lookup_key: null, metadata: {} };
    ev = S.update(A1.sub, { items: priceItem('price_mystery') });
    await w.deliver(ev, null, w.load('stripe_webhook'));
    chk('a price nothing names is raised for a human (unknown_price_tier), as before', alerts('unknown_price_tier').some((a) => (a.detail || {}).price_id === 'price_mystery'));

    /* ===================================================================== */
    /* 5. BET CHECKER BUYING FAIRLINE, AND THE TERMINAL                      */
    /* ===================================================================== */
    const R2 = await redBuyer('red.wants.fairline@example.com');
    n0 = sessions();
    r = await w.call('create_checkout_session', 'POST', BLACK, R2.u.token);
    chk('a Bet Checker customer buying Fairline: 409 switch_plan, nothing created', r.status === 409 && r.body.reason === 'switch_plan' &&
      /Switch it to Fairline/.test(r.body.message) && sessions() === n0, r.body);
    chk('…and Bet Checker alone is NOT Fairline', bc(R2.u.id) && !fl(R2.u.id) && w.access(R2.u.id).fairline_paid === false);
    const B = w.user('blue@example.com');
    r = await w.call('create_checkout_session', 'POST', BLUE, B.token);
    const doneB = S.complete(S.S.sessions[r.body.session_id].id, { email: 'blue@example.com' });
    await deliverAll(doneB.events);
    acc = w.access(B.id);
    chk('THE TERMINAL (blue) STILL GETS EVERYTHING: terminal, Fairline, Bet Checker', acc.has_access === true && acc.fairline_paid === true && acc.bet_checker_paid === true &&
      terminal(B.id) && fl(B.id) && bc(B.id), acc);
    chk('…and passes has_active_sub() and community_is_entitled(), and reads the signals', activeSub(B) === true && entitled(B.id) === true && signalsSeen(B) === 2);
    n0 = sessions();
    r = await w.call('create_checkout_session', 'POST', BLACK, B.token);
    chk('a terminal customer asking for Fairline is told it is included', r.status === 409 && r.body.reason === 'already_entitled' && /includes Fairline/.test(r.body.message) && sessions() === n0, r.body);
    /* Fairline -> terminal in the portal, and back */
    ev = S.update(doneF.subscription.id, { items: priceItem('price_4999') });
    await w.deliver(ev);
    chk('a switch from Fairline to the terminal: blue, the terminal opens, Fairline kept', w.row(F.id).tier === 'blue' && terminal(F.id) && fl(F.id) && activeSub(F) === true);
    ev = S.update(doneF.subscription.id, { items: priceItem('price_1999') });
    await w.deliver(ev);
    chk('and back to Fairline: black, the terminal closed again, Fairline kept', w.row(F.id).tier === 'black' && !terminal(F.id) && fl(F.id) && activeSub(F) === false && signalsSeen(F) === 0);
    ev = S.update(doneF.subscription.id, { status: 'canceled' }, 'customer.subscription.deleted');
    await w.deliver(ev);
    chk('cancelled: nothing paid any more', !fl(F.id) && !bc(F.id) && !terminal(F.id));

    /* ===================================================================== */
    /* 6. THE RULE, MIRRORED: SQL, SERVER CORE AND BROWSER AGREE             */
    /* ===================================================================== */
    const prices = [null, 'price_799', 'price_1999', 'price_4999', 'price_never_seen', 'owner_comp', 'comp_trial'];
    const stats = ['active', 'trialing', 'past_due', 'canceled', null];
    const offs = [null, '5 days', '-1 second', '-20 days', '-22 days'];
    const cases = [];
    stats.forEach((s) => prices.forEach((p) => offs.forEach((o) => cases.push({ s, p, o }))));
    sql1('create table public.black_grid (i int primary key, status text, price_id text, pe timestamptz);');
    sql1('insert into public.black_grid values ' + cases.map((c, i) => '(' + i + ', ' + lit(c.s) + '::text, ' + lit(c.p) + '::text, ' +
      (c.o == null ? 'null::timestamptz' : '(now() + interval ' + lit(c.o) + ')') + ')').join(',\n') + ';');
    sql1("insert into auth.users (id, email, email_confirmed_at) select ('30000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'g' || i || '@x.co', now() from public.black_grid;");
    sql1("insert into public.subscriptions (user_id, status, price_id, current_period_end) select ('30000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, status, price_id, pe from public.black_grid;");
    const g = w.q("select gr.i, gr.status, gr.price_id, gr.pe, public.billing_tier_of_price(gr.price_id) as tier, " +
      "public.billing_row_grants_access(gr.status, gr.price_id, gr.pe, now()) as terminal, public.has_bet_checker_paid(s.user_id, now()) as bc, " +
      "public.has_fairline_paid(s.user_id, now()) as fl, public.billing_access_for(s.user_id, now()) as acc " +
      "from public.black_grid gr join public.subscriptions s on s.user_id = ('30000000-0000-4000-8000-' || lpad(gr.i::text, 12, '0'))::uuid order by gr.i");
    const nowMs = Date.now();
    const jrow = (x) => ({ status: x.status, price_id: x.price_id, current_period_end: x.pe, tier: x.tier });
    chk('the grid is the whole grid (175 cases)', g.length === cases.length && cases.length === 175, g.length);
    chk('Fairline: server core, browser and has_fairline_paid agree on all 175',
      g.every((x) => CORE.grantsFairline(jrow(x), nowMs) === x.fl && ACCESS.fairline(jrow(x), nowMs) === x.fl), g.filter((x) => CORE.grantsFairline(jrow(x), nowMs) !== x.fl).slice(0, 3));
    chk('Bet Checker: server core, browser and has_bet_checker_paid agree on all 175',
      g.every((x) => CORE.grantsBetChecker(jrow(x), nowMs) === x.bc && ACCESS.betChecker(jrow(x), nowMs) === x.bc));
    chk('the terminal: server core, browser and the rule agree on all 175',
      g.every((x) => CORE.grantsAccess(jrow(x), nowMs) === x.terminal && ACCESS.grants(jrow(x), nowMs) === x.terminal));
    chk('the decision\'s fairline_paid IS has_fairline_paid, its bet_checker_paid IS has_bet_checker_paid',
      g.every((x) => x.acc.fairline_paid === x.fl && x.acc.bet_checker_paid === x.bc && x.acc.has_access === x.terminal));
    chk('A BLACK PRICE NEVER OPENS THE TERMINAL, in any status or period', g.filter((x) => x.price_id === 'price_1999').every((x) => x.terminal === false));
    chk('a black row in good standing has Fairline and Bet Checker, is offered the switch, and is not "behind Stripe"',
      g.filter((x) => x.price_id === 'price_1999' && x.fl).length > 0 &&
      g.filter((x) => x.price_id === 'price_1999' && x.fl).every((x) => x.bc && x.acc.offer === 'upgrade' && x.acc.reason === 'fairline_only' && x.acc.should_sync === false));
    chk('a red row never has Fairline', g.filter((x) => x.price_id === 'price_799').every((x) => x.fl === false));
    chk('the terminal always includes Fairline and Bet Checker (blue, comps, and every price sold before Bet Checker)', g.filter((x) => x.terminal).every((x) => x.fl && x.bc));
    chk('the browser offers what the database offers, for every black and red row', g.filter((x) => x.price_id === 'price_1999' || x.price_id === 'price_799')
      .every((x) => ACCESS.offerFor({ status: x.status, price_id: x.price_id, current_period_end: x.pe, tier: x.tier }) === (x.acc.offer === 'fix_payment' || x.acc.offer === 'resubscribe' ? ACCESS.offerFor({ status: x.status, price_id: x.price_id, current_period_end: x.pe, tier: x.tier }) : x.acc.offer)));

    /* the report says so too */
    const rep = w.db.applyFile(path.join(PG.ROOT, 'supabase', 'billing_hardening.sql'));
    chk('billing_hardening.sql re-applied: row 15 checks every learned red and black price against the rule, and says ok',
      /15\|no Bet Checker \(red\) or Fairline \(black\) price opens the terminal[^|]*\|ok \(\d+ red or black prices checked\)/.test(rep) && !/15\|[^\n]*CHECK THIS/.test(rep), rep.split('\n').filter((l) => /^1[2-5]\|/.test(l)));
    chk('and both tier checks know black, after a second run', sql1("select count(*) from pg_constraint where conname in ('billing_price_tiers_tier_check', 'subscriptions_tier_check') and pg_get_constraintdef(oid) like '%black%'") === '2');
    chk('a tier that is not one is still refused', sql1("select public.billing_learn_price_tier('price_green', null, 'green', null, true, 'x')") === 'refused:tier');

    /* ===================================================================== */
    /* 7. JUICE REEL'S TERMINAL OVER A LIVE FAIRLINE PLAN                    */
    /* ===================================================================== */
    w.db.applyFile(path.join(PG.ROOT, 'supabase', 'juicereel_billing.sql'));
    const J = await (async () => {
      const u = w.user('jr.over.fairline@example.com');
      const c = await w.call('create_checkout_session', 'POST', BLACK, u.token);
      const d = S.complete(S.S.sessions[c.body.session_id].id, { email: 'jr.over.fairline@example.com' });
      await deliverAll(d.events);
      return { u, sub: d.subscription.id };
    })();
    chk('(a live Fairline plan on the row)', w.row(J.u.id).tier === 'black' && fl(J.u.id) && !terminal(J.u.id));
    sql1("insert into public.billing_juicereel_links (user_id, jr_user_id) values (" + lit(J.u.id) + ", 'jr_42');" +
      " insert into public.billing_juicereel_subscribers (jr_user_id, active, expires_at, as_of, source) values ('jr_42', true, now() + interval '30 days', now(), 'test');");
    const jr = JSON.parse(w.db.service('select public.billing_jr_project(' + lit(J.u.id) + ');'));
    chk('the terminal bought on Juice Reel is given (it includes Fairline)', jr.applied === true && terminal(J.u.id) && fl(J.u.id), jr);
    const both = alerts('juicereel_and_stripe_both_paid').filter((a) => a.user_id === J.u.id);
    chk('…and the live Stripe Fairline plan it replaced is raised for a human to cancel', both.length === 1 && (both[0].detail || {}).stripe_tier === 'black' &&
      both[0].stripe_subscription_id === J.sub, both);
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    w.stop();
  }
  process.exit(T.done());
})();

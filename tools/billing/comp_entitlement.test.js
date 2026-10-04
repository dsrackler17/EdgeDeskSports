#!/usr/bin/env node
/* ===========================================================================
   A COMPED SUBSCRIPTION IS PAID.

   `price_id = 'owner_comp'` with `status = 'active'` is full access granted
   in the database rather than bought through Stripe. Such a row has no
   stripe_customer_id and no stripe_subscription_id — nothing was purchased,
   so there is nothing for Stripe to have an id for — and every gate that
   reasons from a Stripe id, a renewal date or a checkout link has to be told
   that, or it reads a complete entitlement as an unfinished purchase.

   The failure this exists to stop is specific and it is worse than a locked
   screen: the one account that can never be charged being walked into a
   payment page, told a renewal date, and offered a cancel button for a
   subscription Stripe has never heard of.

   Three files have to agree, and they are checked against each other rather
   than each against a copy of the rule:

     app.html      the paywall — pgEntitled / pgCheck / pgShow, and the
                   Settings > Subscription card the owner actually reads
     index.html    the only page that sends anyone to Stripe — edSubState,
                   openArl, confirmArl
     stripe_webhook  the only writer of the row — it must never write over one

   The real functions are loaded out of the shipped files. There is no second
   copy to drift.

   Run: node tools/billing/comp_entitlement.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 300); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
const eq = (name, got, want) =>
  chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const LANDING = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const HOOK = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'stripe_webhook', 'index.ts'), 'utf8');
const BILLING = fs.readFileSync(path.join(ROOT, 'supabase', 'billing.sql'), 'utf8');
/* The offer the pages read. The sandbox gets the real file, not a copy. */
const PRICING = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
/* A context built while the pricing file carries the given links. The pages
   read their links once, when their script runs, so the file is set for the
   build and put back straight after — it is never left changed. */
function withLinks(links, build) {
  const was = { CHECKOUT_LINK: PRICING.CHECKOUT_LINK, RESUBSCRIBE_LINK: PRICING.RESUBSCRIBE_LINK };
  Object.assign(PRICING, links);
  try { return build(); } finally { Object.assign(PRICING, was); }
}

/* A named region of a source file, start marker to end marker. A suite that
   silently slices nothing would pass having run no code, so every slice is
   asserted to be non-empty before anything is driven. */
function region(src, from, to, what) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  chk('the ' + what + ' region is found', a >= 0 && b > a,
    'from=' + a + ' to=' + b);
  return (a >= 0 && b > a) ? src.slice(a, b) : '';
}

const COMP_BLOCK = region(APP, '/* ---- A COMPED SUBSCRIPTION',
  'async function loadSubStatus(){', 'app.html comp predicate');
const SET_BLOCK = region(APP, 'function subStatusLabel(s){',
  'function renderSetEdge(){', 'app.html settings card');
const PAY_BLOCK = region(APP, "var PG_OWNER_ID='", '/* boot */', 'app.html paywall');
/* This one is cut back to its last closing brace: the marker after it sits
   INSIDE a block comment, so slicing to it would hand the vm an unterminated
   /* and fail as a syntax error rather than as a test. */
const LAND_BLOCK = (function () {
  const raw = region(LANDING, '/* ---- A COMPED SUBSCRIPTION',
    'THE LINK FROM THE EMAIL', 'index.html comp predicate');
  return raw.slice(0, raw.lastIndexOf('}') + 1);
})();

/* ======================================================================== */
/* 1. THE THREE FILES AGREE ON WHAT A COMP IS                               */
/* ======================================================================== */
function compIds(src, what) {
  const m = /COMP_PRICE_IDS\s*=\s*\[([^\]]*)\]/.exec(src);
  chk(what + ' declares COMP_PRICE_IDS', !!m);
  return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
}
const IDS_APP = compIds(COMP_BLOCK, 'app.html');
const IDS_LAND = compIds(LAND_BLOCK, 'index.html');
const IDS_HOOK = compIds(HOOK, 'the webhook');

chk('owner_comp is the comped price id', IDS_APP.indexOf('owner_comp') >= 0, JSON.stringify(IDS_APP));
chk('the paywall and the checkout page agree on the list',
  IDS_APP.join('|') === IDS_LAND.join('|'), JSON.stringify([IDS_APP, IDS_LAND]));
chk('and so does the only thing that writes the row',
  IDS_APP.join('|') === IDS_HOOK.join('|'), JSON.stringify([IDS_APP, IDS_HOOK]));

/* ======================================================================== */
/* 2. THE PAYWALL (app.html)                                                */
/* ======================================================================== */
const COMP = { user_id: 'u', status: 'active', price_id: 'owner_comp',
               current_period_end: '2099-12-31T23:59:59Z',
               stripe_customer_id: null, stripe_subscription_id: null };
const PAID = { status: 'active', price_id: 'price_live_1',
               current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
               stripe_customer_id: 'cus_1' };
const LAPSED = { status: 'active', price_id: 'price_live_1',
                 current_period_end: '2020-01-01T00:00:00Z', stripe_customer_id: 'cus_1' };
const CANCELED = { status: 'canceled', price_id: 'price_live_1', stripe_customer_id: 'cus_1' };

function appCtx(opts) {
  opts = opts || {};
  const el = () => ({ innerHTML: '', textContent: '', className: '', style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => ({ innerHTML: '' }) });
  /* The overlay itself, watched rather than wrapped: pgShow's refusal is a
     real early return, so the only honest question is whether the gate
     element ever got the class that makes it visible. */
  const gate = { innerHTML: '', style: {}, card: { innerHTML: '' }, on: false,
    classList: { add(n) { if (n === 'on') gate.on = true; },
                 remove(n) { if (n === 'on') gate.on = false; },
                 contains: () => false },
    querySelector: () => gate.card };
  const c = {
    GATE: gate,
    console, JSON, String, Number, Array, Date, Math, Error, Promise, isFinite,
    setTimeout: (f) => { if (opts.runTimers) f(); return 0; },
    encodeURIComponent,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { body: { style: {} }, getElementById: el, querySelector: el },
    $: (id) => (id === 'payGate' ? gate : el()),
    edUser: () => (opts.user === undefined ? { id: 'not-the-owner' } : opts.user),
    sbGet: async (q) => {
      c.ASKED.push(q);
      if (opts.readThrows) throw new Error('network');
      return opts.row ? [opts.row] : [];
    },
    stEsc: (s) => String(s == null ? '' : s),
    setCard: (t, s, b) => '[card:' + t + ']' + (s || '') + (b || ''),
    setRow: (k, v, n) => '<row>' + k + '=' + v + (n ? '(' + n + ')' : '') + '</row>',
    stripePortalHref: () => 'https://billing.stripe.com/p/login/x',
    EDPricing: PRICING,
    SUB_PRICE_DISPLAY: PRICING.PRICE_DISPLAY,
    SUB_PLAN_NAME: PRICING.PLAN_NAME,
    SET_ACTIVE: 'other',
    renderSettings() {},
    loadEdges() {},
    ASKED: [],
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(COMP_BLOCK + '\n' + PAY_BLOCK + '\n' + SET_BLOCK,
    c, { filename: 'app.html:comp' });
  return c;
}

/* pgEntitled, on the row alone */
{
  const c = appCtx();
  eq('a comp is entitled', c.pgEntitled(COMP), true);
  eq('an ordinary paid subscription still is', c.pgEntitled(PAID), true);
  eq('a lapsed row still is not', c.pgEntitled(LAPSED), false);
  eq('a cancelled subscription still is not', c.pgEntitled(CANCELED), false);
  eq('no row at all is not', c.pgEntitled(null), false);

  /* The comp must not inherit the expiry rule. A comp does not lapse, and the
     date on the row is a formality — if the check ever moves after the date
     arithmetic this flips and the owner is locked out on a stale timestamp. */
  eq('a comp whose period end is in the past is STILL entitled',
    c.pgEntitled({ status: 'active', price_id: 'owner_comp',
                   current_period_end: '2020-01-01T00:00:00Z' }), true);
  eq('a comp with no period end at all is entitled',
    c.pgEntitled({ status: 'active', price_id: 'owner_comp' }), true);

  /* and it is the PAIR that grants it, not the price id on its own */
  eq('owner_comp on a cancelled row is not entitled',
    c.pgEntitled({ status: 'canceled', price_id: 'owner_comp' }), false);
  eq('owner_comp with no status is not entitled',
    c.pgEntitled({ price_id: 'owner_comp' }), false);
  eq('a lookalike price id is not a comp',
    c.subIsComp({ status: 'active', price_id: 'owner_comp_x' }), false);
  eq('nor is a price id that merely contains it',
    c.subIsComp({ status: 'active', price_id: 'price_owner_comp' }), false);
}

/* pgCheck: the row is read, and it is the row that decides */
(async () => {
  {
    const c = appCtx({ row: COMP, user: { id: 'somebody-else' } });
    eq('a comp opens the app', await c.pgCheck(), 'ok');
    chk('and the row is actually read, not assumed',
      c.ASKED.length === 1 && /subscriptions\?select=/.test(c.ASKED[0]), JSON.stringify(c.ASKED));
    /* Without price_id in the select the row comes back looking ordinary and
       nothing downstream can tell it is a comp. */
    chk('the read asks for price_id', /(^|[=,])price_id(,|&)/.test(c.ASKED[0]), c.ASKED[0]);
    chk('and the row is left where the UI can read it', c.window.SUB === COMP);
  }
  {
    const c = appCtx({ row: null, user: { id: 'somebody-else' } });
    eq('an account with no subscription is locked', await c.pgCheck(), 'locked');
  }
  {
    const c = appCtx({ row: PAID, user: { id: 'somebody-else' } });
    eq('an ordinary subscriber is unaffected', await c.pgCheck(), 'ok');
  }
  {
    const c = appCtx({ readThrows: true, user: { id: 'somebody-else' } });
    eq('a failed read never locks anybody out', await c.pgCheck(), 'unknown');
  }
  /* The hardcoded owner id stays a BACKSTOP for the day the row is missing —
     but it is no longer what grants access, and it no longer returns before
     the row has been read, which is what left Settings saying "checking…"
     forever. */
  const OWNER = (/var PG_OWNER_ID='([^']+)'/.exec(APP) || [])[1];
  chk('the owner backstop id is still configured', !!OWNER);
  {
    const c = appCtx({ row: null, user: { id: OWNER } });
    eq('the owner is still let in if the row has gone missing', await c.pgCheck(), 'ok');
  }
  {
    const c = appCtx({ row: COMP, user: { id: OWNER } });
    await c.pgCheck();
    chk('and when the row IS there the owner gets it, so the UI can say why',
      c.window.SUB === COMP);
  }

  /* ====================================================================== */
  /* 3. A COMP IS NEVER SENT TO CHECKOUT                                    */
  /* ====================================================================== */
  {
    const c = appCtx({ row: COMP });
    await c.pgCheck();
    c.pgShow(c.pgLockedHTML(''));
    eq('pgShow refuses to open the paywall over a comped account', c.GATE.on, false);
    eq('and nothing is painted into it', c.GATE.card.innerHTML, '');
  }
  {
    const c = appCtx({ row: null });
    await c.pgCheck();
    c.pgShow(c.pgLockedHTML(''));
    eq('and it still opens for an account that really has not paid', c.GATE.on, true);
    /* A NEVER-SUBSCRIBED account is sent through the landing page's trial
       flow, which records the auto-renewal consent and then opens the same
       Stripe payment link — so the offer it is shown (7 days free, then the
       monthly price) is the offer it consents to. A LAPSED account keeps the
       direct Stripe link and is promised no trial. Either way the unpaid
       screen is a way to pay, and a comp is never sent to either. */
    chk('which is the screen that carries the way to pay: the consented trial flow for a new account',
      /href="\.\/index\.html#subscribe"/.test(c.GATE.card.innerHTML) && /7-day free trial/.test(c.GATE.card.innerHTML), c.GATE.card.innerHTML.slice(0, 200));
  }
  {
    /* with the resubscribe link configured in lib/edgedesk_pricing.js */
    const c = withLinks({ RESUBSCRIBE_LINK: 'https://buy.stripe.com/resub4999test' },
      () => appCtx({ row: Object.assign({}, COMP, { status: 'canceled', price_id: 'price_live' }) }));
    await c.pgCheck();
    c.pgShow(c.pgLockedHTML(''));
    chk('and a lapsed account still gets the Stripe link, with no trial promised',
      c.GATE.on === true && /href="https:\/\/buy\.stripe\.com\/resub4999test\?client_reference_id=/.test(c.GATE.card.innerHTML)
      && !/free trial/.test(c.GATE.card.innerHTML), c.GATE.card.innerHTML.slice(0, 300));
    chk('at the standard price', /Subscribe \u2014 \$49\.99\/mo/.test(c.GATE.card.innerHTML), c.GATE.card.innerHTML.slice(0, 300));
  }
  {
    /* THE RETIRED LINK, PASTED BACK BY MISTAKE: refused by name, never sent to */
    const c = withLinks({ RESUBSCRIBE_LINK: PRICING.RETIRED_LINKS[1] },
      () => appCtx({ row: Object.assign({}, COMP, { status: 'canceled', price_id: 'price_live' }) }));
    await c.pgCheck();
    c.pgShow(c.pgLockedHTML(''));
    chk('a retired $79.99 link is never offered, even if configured',
      !/buy\.stripe\.com/.test(c.GATE.card.innerHTML) && /mailto:/.test(c.GATE.card.innerHTML), c.GATE.card.innerHTML.slice(0, 400));
  }
  {
    /* NOT CONFIGURED YET: the button says how to restart rather than guessing a link */
    const c = withLinks({ RESUBSCRIBE_LINK: '' },
      () => appCtx({ row: Object.assign({}, COMP, { status: 'canceled', price_id: 'price_live' }) }));
    await c.pgCheck();
    c.pgShow(c.pgLockedHTML(''));
    chk('with no resubscribe link configured, a lapsed reader is sent to a person, not to a guess',
      !/buy\.stripe\.com/.test(c.GATE.card.innerHTML) && /Restart your subscription/.test(c.GATE.card.innerHTML), c.GATE.card.innerHTML.slice(0, 400));
  }
  {
    /* THE OFFER A NEW ACCOUNT SEES: Full Access, 7 days free, then $49.99 */
    const c = appCtx({ row: null });
    await c.pgCheck();
    c.pgShow(c.pgLockedHTML(''));
    const h = c.GATE.card.innerHTML;
    chk('a new account is asked to unlock EdgeDesk Full Access', /Unlock EdgeDesk Full Access/.test(h), h.slice(0, 200));
    chk('seven days free, then $49.99 a month', /7 days free/.test(h) && /then \$49\.99\/month/.test(h), h.slice(0, 400));
    chk('the whole trial line before any click', h.indexOf(PRICING.CTA_LINE) >= 0);
    chk('everything Full Access includes is listed, player props among it',
      PRICING.FEATURES.every((f) => h.indexOf('<li>' + f + '</li>') >= 0) && /<li>Player props<\/li>/.test(h));
    chk('the stale sport list is gone', !/MLB, WNBA, UFC/.test(h));
    chk('no retired price anywhere on it', !/79\.99/.test(h));
  }

  /* ====================================================================== */
  /* 4. WHAT THE OWNER READS IN SETTINGS                                    */
  /* ====================================================================== */
  {
    const c = appCtx({ row: COMP });
    c.window.SUB = COMP;
    const html = c.renderSetSub();
    chk('the card says PAID and names it as owner access',
      /PAID/.test(html) && /Owner Access/i.test(html), html.slice(0, 400));
    chk('it prices it at nothing, not at $79.99',
      /\$0/.test(html) && html.indexOf('$79.99') < 0, html.slice(0, 400));
    /* The old card would have said "Renews on 31 December 2099 — you will be
       charged $79.99 on this date". That is a charge that is never coming. */
    chk('it never states a renewal charge', html.indexOf('You will be charged') < 0);
    chk('it does not offer a cancel button for a subscription Stripe never had',
      html.indexOf('billing.stripe.com') < 0, html.slice(0, 600));
    chk('and it says plainly that nothing here can charge you',
      /nothing here that can charge you/i.test(html));
  }
  {
    const c = appCtx({ row: PAID });
    c.window.SUB = PAID;
    const html = c.renderSetSub();
    const when = new Date(PAID.current_period_end).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    chk('an ordinary subscriber sees EdgeDesk Full Access at $49.99 a month',
      /EdgeDesk Full Access/.test(html) && html.indexOf('$49.99 / month') >= 0, html.slice(0, 400));
    chk('and the next billing date, which is the row\'s own period end',
      /Next billing date=/.test(html) && html.indexOf(when) >= 0 && /You will be charged \$49\.99 on this date/.test(html), html.slice(0, 600));
    chk('and still gets the portal to cancel in',
      html.indexOf('billing.stripe.com') >= 0);
    chk('and never the retired price', html.indexOf('79.99') < 0);
  }
  {
    /* A SUBSCRIBER STILL ON THE OLD PRICE, until it is moved in Stripe: they are
       shown what Stripe will actually charge them, not the standard figure, and
       their access is exactly the same. */
    const c = appCtx({ row: PAID });
    c.window.SUB = PAID;
    c.window.SUB_PRICE = { unit_amount: 7999, currency: 'usd', billing_interval: 'month', interval_count: 1 };
    const html = c.renderSetSub();
    chk('a subscriber Stripe still bills at another figure is told that figure',
      /You will be charged \$79\.99 on this date/.test(html), html.slice(0, 600));
    eq('and is entitled exactly the same', c.pgEntitled(PAID), true);
    c.window.SUB_PRICE = { unit_amount: 4999, currency: 'usd', billing_interval: 'month', interval_count: 1 };
    chk('once Stripe moves them, the card follows', /You will be charged \$49\.99 on this date/.test(c.renderSetSub()));
    c.window.SUB_PRICE = { unit_amount: 49900, currency: 'usd', billing_interval: 'year', interval_count: 1 };
    chk('a figure that is not monthly is never shown as a monthly price', /\$49\.99 \/ month/.test(c.renderSetSub()));
  }
  {
    /* A STRIPE TRIAL */
    const TRIAL = { status: 'trialing', price_id: null, cancel_at_period_end: false, stripe_customer_id: 'cus_2',
                    current_period_end: new Date(Date.now() + 5 * 864e5).toISOString() };
    const c = appCtx({ row: TRIAL });
    c.window.SUB = TRIAL;
    const html = c.renderSetSub();
    const when = new Date(TRIAL.current_period_end).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    chk('a trial says 7-day free trial, then $49.99/month',
      /7-day free trial/.test(html) && /Then \$49\.99\/month/.test(html), html.slice(0, 500));
    chk('and the day it converts is the row\'s own date, with the first charge on it',
      /Trial ends=/.test(html) && html.indexOf(when) >= 0 && /Your first charge of \$49\.99 is on this date/.test(html), html.slice(0, 600));
    const ENDING = Object.assign({}, TRIAL, { cancel_at_period_end: true });
    c.window.SUB = ENDING;
    const h2 = c.renderSetSub();
    chk('a trial cancelled before it converts promises no charge',
      /Access ends=/.test(h2) && /You will not be charged/.test(h2) && !/first charge/.test(h2), h2.slice(0, 600));
  }
  {
    /* A TRIAL GRANTED BY HAND (comp_trial.sql) renews into nothing */
    const HAND = { status: 'trialing', price_id: 'comp_trial', cancel_at_period_end: true, stripe_customer_id: null,
                   current_period_end: new Date(Date.now() + 10 * 864e5).toISOString() };
    const c = appCtx({ row: HAND });
    c.window.SUB = HAND;
    const html = c.renderSetSub();
    chk('a hand-granted trial is not given the checkout\'s 7 days or a charge',
      /Free trial/.test(html) && !/7-day/.test(html) && !/charged \$|first charge/.test(html) && /Access ends=/.test(html), html.slice(0, 600));
  }
  {
    const GONE = { status: 'canceled', price_id: 'price_live', cancel_at_period_end: false, stripe_customer_id: 'cus_3',
                   current_period_end: new Date(Date.now() - 3 * 864e5).toISOString() };
    const c = appCtx({ row: GONE });
    c.window.SUB = GONE;
    const html = c.renderSetSub();
    chk('an ended subscription never claims a coming charge',
      !/You will be charged/.test(html) && /Ended/.test(html), html.slice(0, 600));
  }
  {
    const c = appCtx({ row: null });
    c.window.SUB = null;
    const html = c.renderSetSub();
    chk('an account with no subscription is still offered one',
      /href="\.\/index\.html#subscribe"/.test(html) && /Start 7 days free/.test(html), html.slice(0, 300));
    chk('as EdgeDesk Full Access: 7 days free, then $49.99/month',
      /EdgeDesk Full Access/.test(html) && /7 days free/.test(html) && /Then \$49\.99\/month/.test(html), html.slice(0, 400));
  }

  /* ====================================================================== */
  /* 5. THE LANDING PAGE — the only page that sends anyone to Stripe        */
  /* ====================================================================== */
  /* The landing page no longer decides access itself: edSubState() asks
     lib/edgedesk_access.js, which asks public.my_billing_access(). Driven here
     two ways — the database answering (mode 'rpc'), and the deploy window
     before billing_hardening.sql, when the RPC is a 404 and the library reads
     the row and applies the same rule itself (mode 'legacy'). */
  const ACCESS_LIB = require(path.join(ROOT, 'lib', 'edgedesk_access.js'));
  const ACCESS_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_access.js'), 'utf8');
  function landCtx(row, ok, mode, withLib) {
    const c = {
      console, JSON, String, Array, Promise, Error, Date, isFinite,
      SB_URL: 'https://x.supabase.co', SB_KEY: 'anon',
      edSession: () => ({ access_token: 't' }),
      ASKED: [],
      fetch: async (u) => {
        u = String(u); c.ASKED.push(u);
        if (ok === false) return { ok: false, status: 503, json: async () => ({}) };
        if (/\/rpc\/my_billing_access$/.test(u)) {
          if (mode !== 'rpc') return { ok: false, status: 404, json: async () => ({ code: 'PGRST202' }) };
          const has = ACCESS_LIB.grants(row);
          return { ok: true, status: 200, json: async () => ({ signed_in: true, has_access: has, subscription: row,
            offer: ACCESS_LIB.offerFor(row), reason: row ? row.status : 'no_subscription' }) };
        }
        return { ok: true, status: 200, json: async () => (row ? [row] : []) };
      },
    };
    c.window = c;
    vm.createContext(c);
    /* loaded the way the page loads it, so its fetch is the page's */
    if (withLib !== false) vm.runInContext(ACCESS_SRC, c, { filename: 'lib/edgedesk_access.js' });
    vm.runInContext(LAND_BLOCK, c, { filename: 'index.html:comp' });
    return c;
  }
  for (const mode of ['rpc', 'legacy']) {
    const c = landCtx(COMP, true, mode);
    eq('[' + mode + '] the landing page reads a comp as paid', await c.edSubState(), 'yes');
    if (mode === 'legacy') {
      chk('[legacy] because the fallback read asks for price_id, not status alone',
        c.ASKED.some((u) => /subscriptions\?select=status,price_id/.test(u)), c.ASKED);
    } else {
      chk('[rpc] and it asks the database decision, not the row', /\/rpc\/my_billing_access$/.test(c.ASKED[0]), c.ASKED);
    }
    eq('[' + mode + '] an ordinary subscriber is still paid', await landCtx(PAID, true, mode).edSubState(), 'yes');
    eq('[' + mode + '] a cancelled account still is not', await landCtx(CANCELED, true, mode).edSubState(), 'no');
    eq('[' + mode + '] no row is not', await landCtx(null, true, mode).edSubState(), 'no');
    eq('[' + mode + '] a failed read is unknown, never "no"', await landCtx(COMP, false, mode).edSubState(), 'unknown');
    /* THE PURCHASE LOOP. This page used to read ANY trialing row as paid, so an
       expired comp_trial was told "you already have access" here and locked
       out by the paywall — and could never buy. */
    const EXPIRED_COMP_TRIAL = { status: 'trialing', price_id: 'comp_trial', cancel_at_period_end: true,
      current_period_end: '2020-01-01T00:00:00Z', stripe_customer_id: null };
    eq('[' + mode + '] an EXPIRED comp_trial is not paid, so it can buy', await landCtx(EXPIRED_COMP_TRIAL, true, mode).edSubState(), 'no');
    eq('[' + mode + '] and a lapsed Stripe row is not paid either', await landCtx(LAPSED, true, mode).edSubState(), 'no');
  }
  eq('without the access library the page never claims paid OR unpaid — the server decides at checkout',
    await landCtx(PAID, true, 'rpc', false).edSubState(), 'unknown');

  /* The two gates in front of Stripe, asserted on the shipped source: driving
     them needs the whole landing DOM, but their ORDER is the whole point. */
  const ARL = region(LANDING, 'async function confirmArl(){',
    "\n/* #arlSubmit ships disabled", 'index.html confirmArl');
  const iGuard = ARL.indexOf("already==='yes'");
  const iConsent = ARL.indexOf('billing_consents');
  const iStripe = ARL.indexOf('window.location.href=url');
  chk('confirmArl asks whether this account already has access', iGuard > 0);
  /* A consent record is a legal statement that this person agreed to be
     billed. One must never be written for a charge that cannot happen. */
  chk('and it asks BEFORE writing a renewal-consent record',
    iGuard > 0 && iConsent > 0 && iGuard < iConsent, 'guard=' + iGuard + ' consent=' + iConsent);
  chk('and long before it navigates to Stripe',
    iGuard > 0 && iStripe > 0 && iGuard < iStripe, 'guard=' + iGuard + ' stripe=' + iStripe);
  chk('an unreadable subscription must not block a real customer from paying',
    /only a definite/i.test(ARL) || /'unknown'/.test(ARL));

  const OPENARL = region(LANDING, 'function openArl(){', '\nasync function confirmArl(', 'index.html openArl');
  chk('the renewal-terms screen closes itself for an account that already has access',
    /edSubState\(\)/.test(OPENARL) && /APP_URL/.test(OPENARL), OPENARL.slice(0, 300));

  /* ====================================================================== */
  /* 6. THE WEBHOOK MUST NOT WRITE OVER A COMP                              */
  /* ====================================================================== */
  const iRead = HOOK.indexOf("subscriptions?select=*&user_id=eq.");
  const iComp = HOOK.indexOf('COMP_PRICE_IDS.indexOf(String(existing.price_id');
  /* the first thing processEvent could write with: the live reconciliation,
     or (when Stripe cannot be asked) the event body through the same writer */
  const iWrite = Math.min.apply(null, [HOOK.indexOf('result = await reconcileUser('),
    HOOK.indexOf("D.rpc('billing_apply_subscription_state'")].filter((i) => i > 0));
  chk('the webhook reads price_id off the existing row (the whole row)',
    iRead > 0 && iRead < iComp, HOOK.slice(iRead, iRead + 90));
  chk('it refuses to apply an event to a comped row', iComp > 0);
  chk('and it refuses BEFORE the write, not after it',
    iComp > 0 && iWrite > 0 && iComp < iWrite, 'guard=' + iComp + ' write=' + iWrite);
  /* 200, or Stripe redelivers the same event forever: refusing this write is
     the right answer, not a failure to retry. */
  const REFUSAL = HOOK.slice(iComp, iComp + 700);
  chk('the refusal is acknowledged with 200 so Stripe stops retrying',
    /json\(\{ ok: true, ignored: 'comped_subscription' \}, 200\)/.test(REFUSAL),
    REFUSAL.slice(0, 300));
  chk('and it says which account and why, in the log',
    /console\.log\(/.test(REFUSAL) && /comped/.test(REFUSAL));
  /* A COMP WAS NEVER SOLD, so no discount code can have brought it in. The
     referral write added later must sit BEHIND this guard — otherwise an event
     carrying a promo code would stamp a partner on an account that was granted
     access here and never bought anything, and the partner report would show a
     sale that does not exist. */
  chk('and the referral attribution is behind the comp guard, so a comp is never credited to a code',
    iComp > 0 && HOOK.indexOf('let referral = null;') > iComp);
  /* and the one SQL writer refuses it too, whoever calls it (the reconciler,
     the success page, the schedule) — tools/billing/billing_flow.test.js
     drives that against the real function */
  const HARD = fs.readFileSync(path.join(ROOT, 'supabase', 'billing_hardening.sql'), 'utf8');
  chk('billing_apply_subscription_state refuses to write over an owner_comp row',
    /if e\.status = 'active' and coalesce\(e\.price_id, ''\) = 'owner_comp' then\s*return jsonb_build_object\('applied', false, 'reason', 'comp'/.test(HARD));

  /* ====================================================================== */
  /* 7. THE COLUMN HAS TO EXIST                                             */
  /* ====================================================================== */
  chk('billing.sql creates price_id on subscriptions',
    /create table if not exists public\.subscriptions[\s\S]*?price_id\s+text/.test(BILLING));
  chk('and adds it to a table that arrived without one',
    /alter table public\.subscriptions add column if not exists price_id/.test(BILLING));
  chk('its report counts price_id among the columns the paywall reads',
    /'status','price_id','current_period_end','cancel_at_period_end','stripe_customer_id'\)\) = 5/.test(BILLING));
  chk('the table comment explains what owner_comp means',
    /owner_comp/.test(BILLING) && /never expires|refuses to write over it/.test(BILLING));
  /* A comp has no Stripe ids by definition, so nothing may require them. */
  chk('no client role can write the row, comp or not',
    /revoke insert, update, delete on public\.subscriptions from anon, authenticated/.test(BILLING));

  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log('\ncomp entitlement: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();

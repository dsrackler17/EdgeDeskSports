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
    SUB_PRICE_DISPLAY: '$79.99',
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
    chk('which is the screen that carries the Stripe link',
      /buy\.stripe\.com/.test(c.GATE.card.innerHTML), c.GATE.card.innerHTML.slice(0, 200));
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
    chk('an ordinary subscriber still sees their price and renewal',
      html.indexOf('$79.99') >= 0 && /Renews on/.test(html), html.slice(0, 400));
    chk('and still gets the portal to cancel in',
      html.indexOf('billing.stripe.com') >= 0);
  }
  {
    const c = appCtx({ row: null });
    c.window.SUB = null;
    const html = c.renderSetSub();
    chk('an account with no subscription is still offered one',
      /Subscribe/.test(html), html.slice(0, 300));
  }

  /* ====================================================================== */
  /* 5. THE LANDING PAGE — the only page that sends anyone to Stripe        */
  /* ====================================================================== */
  function landCtx(row, ok) {
    const c = {
      console, JSON, String, Array, Promise, Error,
      SB_URL: 'https://x.supabase.co', SB_KEY: 'anon',
      edSession: () => ({ access_token: 't' }),
      ASKED: [],
      fetch: async (u) => { c.ASKED.push(String(u));
        return { ok: ok !== false, json: async () => (row ? [row] : []) }; },
    };
    c.window = c;
    vm.createContext(c);
    vm.runInContext(LAND_BLOCK, c, { filename: 'index.html:comp' });
    return c;
  }
  {
    const c = landCtx(COMP);
    eq('the landing page reads a comp as paid', await c.edSubState(), 'yes');
    chk('because it asks for price_id, not status alone',
      /select=status,price_id/.test(c.ASKED[0]), c.ASKED[0]);
  }
  eq('an ordinary subscriber is still paid', await landCtx(PAID).edSubState(), 'yes');
  eq('a cancelled account still is not', await landCtx(CANCELED).edSubState(), 'no');
  eq('no row is not', await landCtx(null).edSubState(), 'no');
  eq('a failed read is unknown, never "no"', await landCtx(COMP, false).edSubState(), 'unknown');

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
  const iRead = HOOK.indexOf("subscriptions?select=last_event_at");
  const iComp = HOOK.indexOf('COMP_PRICE_IDS.indexOf(String(existing.price_id');
  const iWrite = HOOK.indexOf("D.upsert('subscriptions'");
  chk('the webhook reads price_id off the existing row',
    iRead > 0 && /select=last_event_at,status,price_id/.test(HOOK), HOOK.slice(iRead, iRead + 90));
  chk('it refuses to apply an event to a comped row', iComp > 0);
  chk('and it refuses BEFORE the write, not after it',
    iComp > 0 && iWrite > 0 && iComp < iWrite, 'guard=' + iComp + ' write=' + iWrite);
  /* 200, or Stripe redelivers the same event forever: refusing this write is
     the right answer, not a failure to retry. */
  const REFUSAL = HOOK.slice(iComp, iComp + 700);
  chk('the refusal is acknowledged with 200 so Stripe stops retrying',
    /status:\s*200/.test(REFUSAL), REFUSAL.slice(0, 300));
  chk('and it says which account and why, in the log',
    /console\.log\(/.test(REFUSAL) && /comped/.test(REFUSAL));

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

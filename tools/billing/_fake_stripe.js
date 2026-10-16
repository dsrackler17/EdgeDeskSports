'use strict';
/* ===========================================================================
   A FAKE STRIPE, just the API surface the billing functions touch, with the
   behaviour that matters to them modelled rather than stubbed:

     * Checkout Sessions: created by create_checkout_session, or by a Payment
       Link (which makes a NEW customer per checkout and carries only what the
       URL gave it — client_reference_id, and nothing on the subscription).
     * completing a session creates the subscription (trialing, or active when
       there is no trial) and returns the events Stripe would send — in the
       order Stripe often sends them: subscription.created BEFORE the
       checkout.session.completed that names the account.
     * a wallet payment (Apple Pay / Google Pay / Link) is the same session with
       a different payment method and, often, a different email.
     * failures: fail('GET /v1/subscriptions', n) makes the next n matching
       calls answer 500; stall(...) makes them never answer (a timeout).
     * promotion codes and the billing clock (affiliate_flow.test.js): a
       session's promotion code becomes the subscription's Discount, with a
       repeating coupon's end counted from the subscription's start, as Stripe
       counts it; trialInvoice() and cycle() bill it period by period on a
       clock of their own (a test clock), applying the discount to every
       period that starts before the Discount ends; refund() and dispute()
       produce the charge.refunded / charge.dispute.created Stripe sends. A
       first-time-only promotion code is refused for a customer who has paid.

   Events are signed by the test, not here — this only produces their bodies.
   =========================================================================== */

function parseForm(body) {
  const out = {};
  for (const part of String(body || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(part.slice(0, eq));
    const v = decodeURIComponent(part.slice(eq + 1));
    const path = k.replace(/\]/g, '').split('[');
    let o = out;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i], nextIsIndex = /^\d+$/.test(path[i + 1]);
      if (o[key] == null) o[key] = nextIsIndex ? [] : {};
      o = o[key];
    }
    o[path[path.length - 1]] = v;
  }
  return out;
}

function make(opts) {
  const o = opts || {};
  let clock = o.startSec || Math.floor(Date.now() / 1000);
  let seq = 0;
  const id = (p) => p + '_' + (++seq).toString(36).padStart(6, '0') + Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
  const S = { customers: {}, subscriptions: {}, sessions: {}, prices: {}, promos: {}, idem: {}, invoices: {}, charges: {}, paid: {} };
  const calls = [];
  const failing = [];   // {pattern, n, mode}
  const livemode = o.live !== false;

  S.prices.price_4999 = { id: 'price_4999', object: 'price', active: true, type: 'recurring', currency: 'usd',
    unit_amount: 4999, recurring: { interval: 'month', interval_count: 1 }, product: 'prod_edgedesk' };

  // Stripe's month arithmetic: the same day next month, clamped to its last day
  function addMonths(sec, n) {
    const d = new Date(sec * 1000), day = d.getUTCDate();
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last));
    return Math.floor(t.getTime() / 1000);
  }
  function now() { return clock; }
  function tick(sec) { clock += sec == null ? 60 : sec; return clock; }

  function customer(email, metadata) {
    const c = { id: id('cus'), object: 'customer', email: email || null, metadata: metadata || {}, created: now(), livemode };
    S.customers[c.id] = c;
    return c;
  }
  function subscription(custId, priceId, fields) {
    const p = S.prices[priceId] || S.prices.price_4999;
    const s = Object.assign({
      id: id('sub'), object: 'subscription', customer: custId, status: 'active', cancel_at_period_end: false,
      created: now(), current_period_end: now() + 30 * 86400, metadata: {}, livemode,
      items: { object: 'list', data: [{ id: id('si'), price: p }] },
    }, fields || {});
    S.subscriptions[s.id] = s;
    return s;
  }
  // Stripe's own view after a change: what an event's data.object would carry.
  const snap = (x) => JSON.parse(JSON.stringify(x));

  function createSession(params, viaPaymentLink) {
    const s = {
      id: id('cs_' + (livemode ? 'live' : 'test')),
      object: 'checkout.session', mode: params.mode || 'subscription', status: 'open',
      customer: params.customer || null, client_reference_id: params.client_reference_id || null,
      metadata: params.metadata || {}, subscription_data: params.subscription_data || {},
      line_items: params.line_items || [], url: null, livemode, created: now(), expires_at: now() + 86400,
      success_url: params.success_url, cancel_url: params.cancel_url, payment_link: viaPaymentLink ? 'plink_1' : null,
      customer_email: params.customer_email || null, discounts: params.discounts || null,
      allow_promotion_codes: params.allow_promotion_codes || null,
      payment_method_collection: params.payment_method_collection || null,
    };
    s.url = 'https://checkout.stripe.com/c/pay/' + s.id;
    S.sessions[s.id] = s;
    return s;
  }

  /* A Payment Link checkout, the way the old flow made one: the browser's URL
     carried client_reference_id (or not), Stripe makes a fresh customer. */
  function paymentLinkSession(fields) {
    return createSession(Object.assign({ mode: 'subscription', line_items: [{ price: 'price_4999', quantity: 1 }],
      subscription_data: { trial_period_days: '7' } }, fields || {}), true);
  }

  /* The customer pays. Returns the events Stripe sends, in Stripe's order. */
  function complete(sessionId, pay) {
    const p = pay || {};
    const s = S.sessions[sessionId];
    if (!s) throw new Error('no session ' + sessionId);
    let cust = s.customer ? S.customers[s.customer] : null;
    if (!cust) cust = customer(p.email || s.customer_email || null, {});
    else if (p.email && !cust.email) cust.email = p.email;
    s.customer = cust.id;
    const trialDays = Number((s.subscription_data && s.subscription_data.trial_period_days) || 0);
    const priceId = (s.line_items[0] && s.line_items[0].price) || 'price_4999';
    const sub = subscription(cust.id, priceId, {
      status: trialDays ? 'trialing' : (p.requires_action ? 'incomplete' : 'active'),
      trial_end: trialDays ? now() + trialDays * 86400 : null,
      current_period_end: trialDays ? now() + trialDays * 86400 : now() + 30 * 86400,
      metadata: Object.assign({}, (s.subscription_data && s.subscription_data.metadata) || {}),
      default_payment_method: { type: 'card', card: { wallet: p.wallet ? { type: p.wallet } : null } },
    });
    const promo = Array.isArray(s.discounts) && s.discounts[0] && s.discounts[0].promotion_code
      ? S.promos[s.discounts[0].promotion_code] : null;
    if (promo) {
      const cp = promo.coupon;
      sub.discount = { id: id('di'), object: 'discount', coupon: snap(cp), promotion_code: promo.id, start: sub.created,
        end: cp.duration === 'repeating' ? addMonths(sub.created, Number(cp.duration_in_months)) : null, subscription: sub.id };
      sub.discounts = [sub.discount.id];
      s.discounts = [{ coupon: cp.id, promotion_code: promo.id }];
      promo.times_redeemed = (promo.times_redeemed || 0) + 1;
    }
    s.status = 'complete';
    s.subscription = sub.id;
    s.customer_details = { email: p.email || cust.email || null };
    s.payment_status = trialDays ? 'no_payment_required' : 'paid';
    const events = [
      ev('customer.subscription.created', snap(sub)),
      ev('checkout.session.completed', snap(s)),
    ];
    if (!trialDays) events.push(ev('invoice.paid', { id: id('in'), object: 'invoice', customer: cust.id,
      subscription: sub.id, amount_paid: 4999, currency: 'usd', customer_email: s.customer_details.email }));
    return { session: s, subscription: sub, customer: cust, events };
  }

  /* Change a subscription in Stripe and return the event that change sends. */
  function update(subId, fields, type) {
    const s = S.subscriptions[subId];
    Object.assign(s, fields || {});
    return ev(type || 'customer.subscription.updated', snap(s));
  }
  function ev(type, object) {
    // Stripe's clock is the real clock: events are stamped now, one second
    // apart at most, never drifting ahead of the functions' own clock
    clock = Math.max(clock + 1, Math.floor(Date.now() / 1000));
    return { id: id('evt'), object: 'event', type, created: now(), livemode, data: { object } };
  }

  /* ── the billing clock ──────────────────────────────────────────────────
     An invoice for one period of a subscription, paid an hour after the
     period opens (on the subscription's own clock), with the Discount applied
     when the period starts before the Discount ends — Stripe's rule for a
     repeating coupon. Returns the events Stripe sends for it. */
  function invoice(sub, periodStart, amount, reason) {
    const inv = { id: id('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, livemode,
      amount_paid: amount, amount_due: amount, currency: 'usd', status: 'paid', billing_reason: reason,
      status_transitions: { finalized_at: periodStart + 3600, paid_at: periodStart + 3600 },
      lines: { object: 'list', data: [{ id: id('il'), object: 'line_item', amount,
        period: { start: periodStart, end: addMonths(periodStart, 1) } }] },
      total_discount_amounts: [], charge: null, payment_intent: null };
    if (amount > 0) {
      const ch = { id: id('ch'), object: 'charge', amount, amount_refunded: 0, customer: sub.customer, invoice: inv.id,
        payment_intent: id('pi'), currency: 'usd', livemode, refunded: false };
      inv.charge = ch.id; inv.payment_intent = ch.payment_intent;
      S.charges[ch.id] = ch;
      S.paid[sub.customer] = true;
    }
    S.invoices[inv.id] = inv;
    return inv;
  }
  function discountOn(sub, periodStart, unit) {
    const d = sub.discount;
    if (!d || (d.end != null && periodStart >= d.end)) return 0;
    if (d.coupon.percent_off) return Math.round(unit * Number(d.coupon.percent_off) / 100);
    return Math.min(unit, Number(d.coupon.amount_off || 0));
  }
  function trialInvoice(subId) {
    const sub = S.subscriptions[subId];
    const inv = invoice(sub, sub.created, 0, 'subscription_create');
    return { invoice: inv, events: [ev('invoice.paid', snap(inv))] };
  }
  function cycle(subId) {
    const sub = S.subscriptions[subId];
    const start = sub.current_period_end;
    const unit = Number(sub.items.data[0].price.unit_amount);
    const off = discountOn(sub, start, unit);
    const inv = invoice(sub, start, unit - off, 'subscription_cycle');
    if (off) inv.total_discount_amounts = [{ amount: off, discount: sub.discount.id }];
    sub.status = 'active';
    sub.current_period_end = addMonths(start, 1);
    return { invoice: inv, events: [ev('invoice.paid', snap(inv)), ev('customer.subscription.updated', snap(sub))] };
  }
  function refund(invoiceId, amount) {
    const ch = S.charges[S.invoices[invoiceId].charge];
    ch.amount_refunded = Math.min(ch.amount, ch.amount_refunded + amount);
    ch.refunded = ch.amount_refunded === ch.amount;
    return ev('charge.refunded', snap(ch));
  }
  function dispute(invoiceId, amount) {
    const ch = S.charges[S.invoices[invoiceId].charge];
    return ev('charge.dispute.created', { id: id('dp'), object: 'dispute', charge: ch.id, payment_intent: ch.payment_intent,
      amount: amount == null ? ch.amount : amount, currency: 'usd', reason: 'fraudulent', status: 'needs_response', livemode });
  }

  function fail(pattern, n, mode) { failing.push({ pattern, n: n == null ? 1 : n, mode: mode || 'error' }); }

  const R = (status, body) => ({ ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body) });
  const notFound = (what) => R(/^customer: /.test(what) ? 400 : 404,
    { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such ' + what } });

  async function api(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    const path = u.pathname;
    const key = method + ' ' + path;
    calls.push(key + (u.search ? u.search : ''));
    const h = (init && init.headers) || {};
    if (!/^Bearer (sk|rk)_/.test(String(h.authorization || ''))) return R(401, { error: { message: 'no key' } });
    for (const f of failing) {
      if (f.n > 0 && key.indexOf(f.pattern) === 0) {
        f.n--;
        if (f.mode === 'stall') {
          // never answers until the caller's deadline aborts it
          return new Promise((_, rej) => {
            const sig = init && init.signal;
            if (sig) sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        }
        return R(500, { error: { type: 'api_error', message: 'injected' } });
      }
    }
    const q = u.searchParams;
    const idem = h['idempotency-key'];
    if (method === 'POST' && idem && S.idem[idem]) return R(200, S.idem[idem]);
    const body = method === 'POST' ? parseForm(init.body) : {};
    let out = null;

    let m;
    if (method === 'GET' && path === '/v1/subscriptions') {
      if (q.get('customer') && !S.customers[q.get('customer')]) return notFound('customer: ' + q.get('customer'));
      const data = Object.values(S.subscriptions).filter((s) => s.customer === q.get('customer'));
      return R(200, { object: 'list', data: data.map(snap) });
    }
    if ((m = /^\/v1\/subscriptions\/([^/]+)$/.exec(path)) && method === 'GET') {
      return S.subscriptions[m[1]] ? R(200, snap(S.subscriptions[m[1]])) : notFound('subscription');
    }
    if (method === 'GET' && path === '/v1/customers/search') {
      const mm = /metadata\['supabase_user_id'\]:'([^']+)'/.exec(q.get('query') || '');
      const data = Object.values(S.customers).filter((c) => mm && c.metadata && c.metadata.supabase_user_id === mm[1]);
      return R(200, { object: 'search_result', data: data.map(snap) });
    }
    if (method === 'GET' && path === '/v1/customers') {
      const data = Object.values(S.customers).filter((c) => c.email === q.get('email'));
      return R(200, { object: 'list', data: data.map(snap) });
    }
    if ((m = /^\/v1\/customers\/([^/]+)$/.exec(path))) {
      const c = S.customers[m[1]];
      if (!c) return notFound('customer');
      if (method === 'POST') { if (body.metadata) c.metadata = Object.assign({}, c.metadata, body.metadata); }
      return R(200, snap(c));
    }
    if (method === 'POST' && path === '/v1/customers') {
      out = customer(body.email, body.metadata || {});
    }
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      const email = q.get('customer_details[email]');
      const data = Object.values(S.sessions).filter((s) => s.customer_details && s.customer_details.email === email);
      return R(200, { object: 'list', data: data.map(snap) });
    }
    if ((m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path)) && method === 'GET') {
      return S.sessions[m[1]] ? R(200, snap(S.sessions[m[1]])) : notFound('checkout session');
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      if (!body.customer || !S.customers[body.customer]) return R(400, { error: { message: 'customer required' } });
      if (body.discounts && body.allow_promotion_codes) {
        return R(400, { error: { type: 'invalid_request_error', message: 'You may only specify one of these parameters: allow_promotion_codes, discounts.' } });
      }
      const pid = body.discounts && body.discounts[0] && body.discounts[0].promotion_code;
      if (pid) {
        const pc = S.promos[pid];
        if (!pc || !pc.active) return R(400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such promotion code' } });
        if (pc.restrictions && pc.restrictions.first_time_transaction && S.paid[body.customer]) {
          return R(400, { error: { type: 'invalid_request_error', message: 'This promotion code cannot be redeemed because the associated customer has prior transactions.' } });
        }
      }
      out = createSession(body, false);
    }
    if ((m = /^\/v1\/prices\/([^/]+)$/.exec(path))) {
      return S.prices[m[1]] ? R(200, snap(S.prices[m[1]])) : notFound('price');
    }
    if ((m = /^\/v1\/promotion_codes\/([^/]+)$/.exec(path)) && method === 'GET') {
      return S.promos[m[1]] ? R(200, snap(S.promos[m[1]])) : notFound('promotion code');
    }
    if (method === 'GET' && path === '/v1/promotion_codes') {
      const data = Object.values(S.promos).filter((p) => p.code === q.get('code') && p.active);
      return R(200, { object: 'list', data });
    }
    if (out) {
      if (idem) S.idem[idem] = snap(out);
      return R(200, snap(out));
    }
    return R(404, { error: { message: 'fake stripe has no route ' + key } });
  }

  return { S, calls, api, fail, now, tick, customer, subscription, createSession, paymentLinkSession, complete, update, ev, snap, livemode,
           addMonths, trialInvoice, cycle, refund, dispute };
}

module.exports = { make, parseForm };

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
  const S = { customers: {}, subscriptions: {}, sessions: {}, prices: {}, promos: {}, idem: {} };
  const calls = [];
  const failing = [];   // {pattern, n, mode}
  const livemode = o.live !== false;

  S.prices.price_4999 = { id: 'price_4999', object: 'price', active: true, type: 'recurring', currency: 'usd',
    unit_amount: 4999, recurring: { interval: 'month', interval_count: 1 }, product: 'prod_edgedesk' };

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
      out = createSession(body, false);
    }
    if ((m = /^\/v1\/prices\/([^/]+)$/.exec(path))) {
      return S.prices[m[1]] ? R(200, snap(S.prices[m[1]])) : notFound('price');
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

  return { S, calls, api, fail, now, tick, customer, subscription, createSession, paymentLinkSession, complete, update, ev, snap, livemode };
}

module.exports = { make, parseForm };

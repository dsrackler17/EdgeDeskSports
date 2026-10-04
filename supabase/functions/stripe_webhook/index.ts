// ============================================================
//  FILE:    supabase/functions/stripe_webhook/index.ts
//  TYPE:    Edge Function (deployed) - Stripe webhook receiver
//  DEPLOY:  supabase functions deploy stripe_webhook --no-verify-jwt
//           "Enforce JWT verification" MUST be OFF. Stripe does not send a
//           Supabase JWT; it signs with its own secret, which is what this
//           function actually verifies. Leaving JWT on makes every delivery
//           401 and the whole thing silently does nothing.
//  IMPORTS: NONE. One file. The dashboard bundles only this folder and an
//           import that cannot resolve fails the bundle, leaving the previous
//           version serving — indistinguishable from a deploy that worked.
//           The shared billing core is COPIED in below between its markers
//           (tools/billing/inline_core.js); edit tools/billing/billing_core.js.
//
//  SECRETS (Project Settings > Edge Functions > Secrets):
//    STRIPE_WEBHOOK_SECRET   whsec_...  from the endpoint you create in Stripe
//    SB_URL                  https://<ref>.supabase.co   (falls back to the
//                            SUPABASE_URL every function is given)
//    SB_SERVICE_ROLE         the service_role key (falls back to
//                            SUPABASE_SERVICE_ROLE_KEY)
//    STRIPE_SECRET_KEY       sk_live_... or a restricted rk_live_... with READ
//                            access to Customers, Subscriptions, Checkout
//                            Sessions and Promotion Codes. Every delivery is
//                            answered by ASKING STRIPE for the account's
//                            subscriptions, so the state written is Stripe's
//                            truth as of now — whatever order, delay or
//                            duplication the events arrived in.
//    STRIPE_MODE             optional, 'live' (default) or 'test': which mode
//                            the PRIMARY secret's endpoint is. A staging project
//                            wired to a test-mode endpoint sets 'test'.
//
//  FOR A DRY RUN, AND ONLY FOR AS LONG AS ONE IS RUNNING:
//    STRIPE_WEBHOOK_SECRET_TEST  whsec_... from a TEST-MODE endpoint pointed at
//                            this same URL. Both secrets are accepted, so a
//                            test delivery can be proved end to end without
//                            disturbing the live secret for a second — which
//                            is the alternative, and it is an outage.
//    STRIPE_SECRET_KEY_TEST  sk_test_... A test-mode id looked up with a live
//                            key answers 404, which is indistinguishable from
//                            a promotion code that does not exist. Every
//                            lookup for a livemode:false event uses this.
//  Both are optional and unset is the normal state. A delivery accepted on the
//  test secret says `livemode: false` in its response and warns in the log, so
//  a test event can never be mistaken for a sale.
//
//  Run supabase/billing.sql, supabase/stripe_webhook.sql AND
//  supabase/billing_hardening.sql BEFORE deploying this build.
// ============================================================
//
// WHAT THIS BUILD FIXES. The previous build could only name a customer from the
// one delivery that carried the account id. A checkout that arrived without it
// (or never arrived) left every later event for that customer unresolved
// forever, and nothing ever asked Stripe again: a real customer entered a card
// and the site never opened, until a row was typed in by hand. Now:
//
//   1. IT MUST NOT TRUST THE CALLER. Unchanged: HMAC-SHA256 over Stripe's exact
//      signed payload, constant-time, inside a five-minute window. And the
//      event's livemode must match the secret that signed it.
//
//   2. EVERY WAY WE KNOW TO NAME THE ACCOUNT. metadata.supabase_user_id (put on
//      the session, the subscription AND the customer by create_checkout_session),
//      client_reference_id, our own checkout-session record, every customer
//      already linked, and — last — a CONFIRMED email. Still unresolved, it asks
//      Stripe for the customer and tries its metadata and email. Never a guess.
//
//   3. THE STATE IS STRIPE'S, AS OF NOW. A named account is reconciled LIVE:
//      every subscription on every one of its customers is read from Stripe and
//      the best one is written through billing_apply_subscription_state — the
//      one writer, under a row lock, which refuses anything older than what the
//      row already reflects. Delivery order stops mattering, a duplicate
//      delivery writes the same thing twice, and a cancelled DUPLICATE
//      subscription cannot lock out the one in use. Only when Stripe cannot be
//      reached is an event's own body applied, under the same ordering guard.
//
//   4. AN UNKNOWN CUSTOMER IS NOT AN ERROR — BUT IT IS AN ALERT. 200, so Stripe
//      stops retrying; kept on the ledger; raised in billing_alerts; and
//      resolved retroactively the moment the customer is linked to an account
//      (by a later checkout, by the reader's own "Refresh access", by the
//      scheduled sweep, or by support in /admin/billing/).
//
// WHAT IT REFUSES TO DO. It never invents a user, never writes over a comp, and
// never lets Stripe revoke access that Stripe did not grant (a comp_trial or a
// hand-made row): that disagreement goes to a human as an alert.
//
// AND IT RECORDS WHICH DISCOUNT CODE THE SALE CAME IN UNDER. Unchanged: a
// promotion code redeemed at checkout is read from the session (or from the
// subscription Stripe returns), named, and written to public.subscriptions in
// its own write, so a project without those columns loses the attribution and
// NOT the customer's access.
//
// THE BUILD MARKER. Every response carries `build` and an `x-edgedesk-build`
// header, including the 405 a plain GET gets, so the deployed version can be
// confirmed from a browser or one curl without sending a signed event:
//
//   curl -s https://<ref>.supabase.co/functions/v1/stripe_webhook
//   {"build":"stripe_webhook-2026-10-04-hardening-1","error":"POST only"}

const ENC = new TextEncoder();

// ── which build is actually serving ───────────────────────────────────────
// The dashboard deploy path is delete-the-function, create-it-again, clear the
// template, paste, deploy — and a bundle that fails leaves the PREVIOUS version
// serving, which is indistinguishable from a deploy that worked and changed
// nothing. This string is how that is told apart. Bump it with every paste.
const BUILD = 'stripe_webhook-2026-10-04-hardening-1';

// One place responses are made, so a reply cannot exist that forgot to say
// which build produced it.
function json(body, status) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'x-edgedesk-build': BUILD },
  });
}

// ── the events that mean something to us ──────────────────────────────────
// Everything else is acknowledged and recorded, never acted on. A webhook that
// quietly does something with an event nobody designed for is how a billing
// system starts lying. The first six are the ones the endpoint has always been
// sent; the rest are optional extras that make convergence faster when the
// endpoint is subscribed to them (supabase/functions/stripe_webhook/README.md).
const HANDLED = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'invoice.paid',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.paused',
  'customer.subscription.resumed',
];

// Recorded and raised for a human, never acted on: a refund or a dispute does
// not change a subscription's status, and deciding to end access over one is a
// decision about money that a person makes in Stripe (which then sends a
// customer.subscription.deleted this function does act on).
const ALERT_ONLY = ['charge.dispute.created'];

// ── signature ─────────────────────────────────────────────────────────────
// Stripe sends: Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]
// signed payload is `${t}.${rawBody}` and the digest is HMAC-SHA256 hex.
function parseSigHeader(header) {
  const out = { t: null, v1: [] };
  String(header || '').split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') out.t = v;
    else if (k === 'v1') out.v1.push(v);
  });
  return out;
}

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// Constant time. A comparison that returns early on the first wrong character
// leaks the expected digest one byte at a time to anyone willing to measure.
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, ENC.encode(payload)));
}

// Resolves to { ok:true } or { ok:false, reason } — the reason is for our logs,
// never for the response body. Telling an unauthenticated caller WHY their
// forgery failed is free help for the next attempt.
async function verifySignature(rawBody, header, secret, nowSeconds, toleranceSeconds) {
  const tol = toleranceSeconds == null ? 300 : toleranceSeconds;
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set' };
  const sig = parseSigHeader(header);
  if (!sig.t || !sig.v1.length) return { ok: false, reason: 'malformed Stripe-Signature' };
  const t = Number(sig.t);
  if (!isFinite(t)) return { ok: false, reason: 'non-numeric timestamp' };
  // Replay window, both directions: a captured delivery must not be usable
  // later, and a wildly future timestamp is not something Stripe sends.
  if (Math.abs(nowSeconds - t) > tol) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = await hmacHex(secret, sig.t + '.' + rawBody);
  for (const candidate of sig.v1) if (timingSafeEqual(candidate, expected)) return { ok: true };
  return { ok: false, reason: 'no matching v1 signature' };
}

// ── BEGIN BILLING CORE ────────────────────────────────────────────────────
// Canonical source: tools/billing/billing_core.js. This block is copied
// VERBATIM into supabase/functions/{stripe_webhook,create_checkout_session,
// sync_subscription}/index.ts, because the dashboard deploy bundles one folder
// and an import that cannot resolve fails the bundle silently, leaving the old
// version serving. Edit the canonical file, then run
//   node tools/billing/inline_core.js
// tools/billing/billing_core.test.js fails if any copy drifts from it.
//
// Plain JavaScript on purpose: Deno runs it as-is, and Node tests load it
// without a build step.

var CORE_VERSION = 'billing-core-2026-10-04-1';

// ── THE RULE, mirrored ──────────────────────────────────────────────────────
// The authority is public.billing_row_grants_access() in
// supabase/billing_hardening.sql; this copy exists so a function can rank
// Stripe's subscriptions without a database round trip per candidate.
// tools/billing/billing_hardening_sql.test.js holds the two equal over a grid.
var COMP_PRICE_IDS = ['owner_comp'];
var COMP_TRIAL_PRICE_ID = 'comp_trial';
var PAST_DUE_GRACE_DAYS = 21;
var STRIPE_API = 'https://api.stripe.com/v1';
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function grantsAccess(row, nowMs) {
  if (!row) return false;
  var now = nowMs == null ? Date.now() : nowMs;
  var st = row.status;
  if (st === 'active' && COMP_PRICE_IDS.indexOf(String(row.price_id || '')) >= 0) return true;
  var pe = row.current_period_end == null ? null : new Date(row.current_period_end).getTime();
  if (pe != null && !isFinite(pe)) pe = null;
  if (st === 'active' || st === 'trialing') return pe == null || pe >= now;
  if (st === 'past_due') return pe == null || (now - pe) < PAST_DUE_GRACE_DAYS * 864e5;
  return false;
}

// ── reading Stripe objects ──────────────────────────────────────────────────
function idOf(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : (v.id || null);
}

// Newer API versions moved current_period_end onto the items; older ones keep
// it on the subscription. Read both, so an API-version bump never quietly
// starts writing nulls.
function periodEnd(sub) {
  if (!sub) return null;
  var secs = sub.current_period_end;
  if (secs == null && sub.items && Array.isArray(sub.items.data)) {
    for (var i = 0; i < sub.items.data.length; i++) {
      var item = sub.items.data[i];
      if (item && item.current_period_end != null) {
        if (secs == null || item.current_period_end > secs) secs = item.current_period_end;
      }
    }
  }
  if (secs == null || !isFinite(Number(secs))) return null;
  return new Date(Number(secs) * 1000).toISOString();
}

// The one price a single-item subscription is sold under. A subscription with
// several items has no single price, and none is invented.
function priceIdOf(sub) {
  if (!sub || !sub.items || !Array.isArray(sub.items.data) || sub.items.data.length !== 1) return null;
  var it = sub.items.data[0];
  return (it && (idOf(it.price) || idOf(it.plan))) || null;
}

function metadataUserId(obj) {
  var v = obj && obj.metadata && obj.metadata.supabase_user_id;
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

function normalizeSubscription(sub) {
  if (!sub || typeof sub !== 'object' || !sub.id) return null;
  return {
    id: sub.id,
    customer_id: idOf(sub.customer),
    status: sub.status || null,
    current_period_end: periodEnd(sub),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    price_id: priceIdOf(sub),
    created_ms: sub.created ? Number(sub.created) * 1000 : 0,
    metadata_user_id: metadataUserId(sub),
    livemode: sub.livemode === false ? false : (sub.livemode === true ? true : null),
  };
}

var STATUS_RANK = { active: 60, trialing: 50, past_due: 40, unpaid: 30, paused: 20, incomplete: 10,
                    canceled: 0, incomplete_expired: -10 };

// The subscription an account's row should describe, out of every one Stripe
// has for it: one that grants access beats one that does not; paid beats
// trial; then the later period end, then the newest. Two that both grant
// access are a DUPLICATE purchase, returned so the caller can flag it.
function pickBest(subs, nowMs) {
  var seen = {}, list = [];
  (subs || []).forEach(function (s) {
    var n = s && s.id && s.current_period_end !== undefined && s.created_ms !== undefined ? s : normalizeSubscription(s);
    if (n && n.id && !seen[n.id]) { seen[n.id] = true; list.push(n); }
  });
  var ent = function (n) { return grantsAccess(n, nowMs); };
  list.sort(function (a, b) {
    var ea = ent(a) ? 1 : 0, eb = ent(b) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    var ra = STATUS_RANK[a.status] == null ? -20 : STATUS_RANK[a.status];
    var rb = STATUS_RANK[b.status] == null ? -20 : STATUS_RANK[b.status];
    if (ra !== rb) return rb - ra;
    var pa = a.current_period_end ? Date.parse(a.current_period_end) : 0;
    var pb = b.current_period_end ? Date.parse(b.current_period_end) : 0;
    if (pa !== pb) return pb - pa;
    return (b.created_ms || 0) - (a.created_ms || 0);
  });
  return { best: list[0] || null, entitled: list.filter(ent), all: list };
}

// ── logs that can be read, and that never carry a secret ────────────────────
// One JSON line per operation, carrying the ids that trace a customer from
// account to checkout session to Stripe customer to subscription to event to
// row. Emails are masked; anything that looks like a credential, a card or a
// payment method is dropped by name before it can be printed.
function maskEmail(e) {
  var s = String(e || '');
  var at = s.indexOf('@');
  if (at < 1) return s ? '***' : null;
  return s.charAt(0) + '***' + s.slice(at);
}
var LOG_DROP = /token|secret|authorization|password|card|payment_method|apikey|cvc|iban|account_number/i;
function logLine(svc, level, event, fields) {
  var out = { ts: new Date().toISOString(), svc: svc, level: level, event: event };
  var f = fields || {};
  for (var k in f) {
    if (!Object.prototype.hasOwnProperty.call(f, k) || LOG_DROP.test(k)) continue;
    var v = f[k];
    if (/email/i.test(k)) v = maskEmail(v);
    if (v != null && typeof v === 'object') {
      try { v = JSON.parse(JSON.stringify(v)); } catch (_) { v = String(v); }
    }
    if (typeof v === 'string' && v.length > 300) v = v.slice(0, 300) + '…';
    out[k] = v;
  }
  var line = JSON.stringify(out);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return out;
}

// A short reference a customer can read out to support: EDS-7K2M9Q.
function makeRef() {
  var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = new Uint8Array(6), s = 'EDS-';
  crypto.getRandomValues(b);
  for (var i = 0; i < b.length; i++) s += A.charAt(b[i] % A.length);
  return s;
}

// ── fetch with a deadline ───────────────────────────────────────────────────
async function fetchWithTimeout(fetchImpl, url, init, ms) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 8000) : null;
  try {
    return await fetchImpl(url, Object.assign({}, init || {}, ctrl ? { signal: ctrl.signal } : {}));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── the database, over PostgREST with the service role ──────────────────────
function makeDb(url, key, fetchImpl, timeoutMs) {
  var base = String(url || '').replace(/\/+$/, '') + '/rest/v1/';
  var f = fetchImpl || fetch;
  var H = { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  async function call(method, path, body, prefer) {
    var h = Object.assign({}, H);
    if (prefer) h.prefer = prefer;
    var r = await fetchWithTimeout(f, base + path, { method: method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs || 8000);
    var text = await r.text();
    if (!r.ok) {
      var err = new Error('db ' + method + ' ' + path.split('?')[0] + ' ' + r.status + ' ' + text.slice(0, 240));
      err.status = r.status; err.body = text;
      throw err;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return text; }
  }
  return {
    get: function (path) { return call('GET', path); },
    insert: function (table, rows) { return call('POST', table, rows, 'return=minimal'); },
    upsert: function (table, rows, onConflict) {
      return call('POST', table + (onConflict ? '?on_conflict=' + onConflict : ''), rows,
        'return=minimal,resolution=merge-duplicates');
    },
    patch: function (table, query, row) { return call('PATCH', table + '?' + query, row, 'return=minimal'); },
    rpc: function (fn, args) { return call('POST', 'rpc/' + fn, args || {}); },
  };
}

// ── Stripe, read and written with our own key ───────────────────────────────
// Form-encoded the way Stripe expects nested parameters:
//   {subscription_data:{metadata:{supabase_user_id:'u'}}} ->
//   subscription_data[metadata][supabase_user_id]=u
function formEncode(obj, prefix, out) {
  out = out || [];
  if (obj == null) return out;
  if (Array.isArray(obj)) {
    obj.forEach(function (v, i) { formEncode(v, prefix + '[' + i + ']', out); });
    return out;
  }
  if (typeof obj === 'object') {
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null) return;
      formEncode(v, prefix ? prefix + '[' + k + ']' : k, out);
    });
    return out;
  }
  out.push(encodeURIComponent(prefix) + '=' + encodeURIComponent(String(obj)));
  return out;
}

function makeStripe(secretKey, fetchImpl, opts) {
  if (!secretKey) return null;
  var o = opts || {};
  var f = fetchImpl || fetch;
  var timeout = o.timeoutMs || 8000, retries = o.retries == null ? 1 : o.retries;
  async function call(method, path, params, idem) {
    var qs = method === 'GET' && params ? '?' + formEncode(params).join('&') : '';
    var body = method === 'POST' ? formEncode(params || {}).join('&') : undefined;
    var h = { authorization: 'Bearer ' + secretKey };
    if (method === 'POST') h['content-type'] = 'application/x-www-form-urlencoded';
    if (idem) h['idempotency-key'] = idem;
    if (o.apiVersion) h['stripe-version'] = o.apiVersion;
    var attempt = 0, last = null;
    while (attempt <= retries) {
      attempt++;
      try {
        var r = await fetchWithTimeout(f, STRIPE_API + path + qs, { method: method, headers: h, body: body }, timeout);
        var j = null;
        try { j = await r.json(); } catch (_) { j = null; }
        if (r.ok) return j;
        var e = (j && j.error) || {};
        last = new Error('stripe ' + method + ' ' + path.split('?')[0] + ' ' + r.status + (e.code ? ' ' + e.code : ''));
        last.status = r.status; last.code = e.code || null; last.type = e.type || null;
        last.stripeMessage = e.message ? String(e.message).slice(0, 200) : null;
        // a 4xx other than a rate limit will not get better by asking again
        if (r.status < 500 && r.status !== 429) throw last;
      } catch (err) {
        if (err && err.status && err.status < 500 && err.status !== 429) throw err;
        last = err && err.status ? err : Object.assign(new Error('stripe ' + method + ' ' + path.split('?')[0] +
          ' unreachable: ' + String((err && err.name) || err)), { status: 0, code: 'network' });
      }
      if (attempt <= retries) await new Promise(function (res) { setTimeout(res, 250 * attempt); });
    }
    throw last;
  }
  return {
    get: function (path, params) { return call('GET', path, params); },
    post: function (path, params, idem) { return call('POST', path, params, idem); },
  };
}

async function listCustomerSubscriptions(stripe, customerId) {
  var r = await stripe.get('/subscriptions', { customer: customerId, status: 'all', limit: 20 });
  return (r && Array.isArray(r.data)) ? r.data : [];
}

// Every Stripe customer that could be this account's, strongest evidence first.
// Only customers nobody else has claimed are returned; anything already linked
// to a different account is left alone (billing_link_customer raises it).
async function discoverCustomers(ctx, user, opts) {
  var o = opts || {}, found = [], seen = {};
  function add(id, source, email) {
    if (!id || seen[id] || !/^cus_[A-Za-z0-9]+$/.test(id)) return;
    seen[id] = true; found.push({ id: id, source: source, email: email || null });
  }
  try {
    var mapped = await ctx.db.get('billing_customers?select=stripe_customer_id&user_id=eq.' + encodeURIComponent(user.id));
    (mapped || []).forEach(function (m) { add(m.stripe_customer_id, 'known'); });
  } catch (e) { if (o.requireDb) throw e; }
  (o.extraCustomers || []).forEach(function (c) { add(c, 'event'); });
  if (o.rowCustomer) add(o.rowCustomer, 'row');
  if (!o.discover || !ctx.stripe) return found;

  // 1. our own metadata, set by create_checkout_session
  try {
    var q = "metadata['supabase_user_id']:'" + user.id + "'";
    var s = await ctx.stripe.get('/customers/search', { query: q, limit: 10 });
    ((s && s.data) || []).forEach(function (c) { if (!c.deleted) add(c.id, 'stripe_metadata', c.email); });
  } catch (e) { /* search is not on every account; the other routes still run */ }

  var emails = [];
  if (user.email) {
    emails.push(String(user.email));
    if (String(user.email).toLowerCase() !== String(user.email)) emails.push(String(user.email).toLowerCase());
  }
  // 2. a completed checkout that this account started (client_reference_id)
  for (var i = 0; i < emails.length; i++) {
    try {
      var cs = await ctx.stripe.get('/checkout/sessions', { 'customer_details[email]': emails[i], limit: 10 });
      ((cs && cs.data) || []).forEach(function (x) {
        var cust = idOf(x.customer);
        if (!cust || x.status !== 'complete') return;
        var ref = x.client_reference_id || (x.metadata && x.metadata.supabase_user_id) || null;
        if (ref && String(ref).toLowerCase() === user.id) add(cust, 'checkout_session_lookup', emails[i]);
        else if (!ref && user.email_confirmed) add(cust, 'email_match', emails[i]);
      });
    } catch (e) { /* keep going */ }
  }
  // 3. a customer with this CONFIRMED email and nobody else's id on it
  if (user.email_confirmed) {
    for (var j = 0; j < emails.length; j++) {
      try {
        var cl = await ctx.stripe.get('/customers', { email: emails[j], limit: 10 });
        ((cl && cl.data) || []).forEach(function (c) {
          if (c.deleted) return;
          var m = metadataUserId(c);
          if (!m || m === user.id) add(c.id, m ? 'stripe_metadata' : 'email_match', c.email);
        });
      } catch (e) { /* keep going */ }
    }
  }
  return found;
}

// ── RECONCILE ONE ACCOUNT AGAINST STRIPE ────────────────────────────────────
// The heart of every repair: find every Stripe customer that is this account's,
// read every subscription they have, pick the one the row should describe, and
// write it through billing_apply_subscription_state as the live, authoritative
// truth as of the moment we asked. Nothing here trusts a browser.
//
//   ctx   { db, stripe (null without a key), svc, nowMs() }
//   user  { id, email, email_confirmed }
//   opts  { source, discover, extraCustomers, extraSubscriptions,
//           extraSubscriptionIds, eventId, eventAt, ref, dryRun, livemode }
async function reconcileUser(ctx, user, opts) {
  var o = opts || {};
  var t0 = ctx.nowMs ? ctx.nowMs() : Date.now();
  var asOf = new Date(t0).toISOString();
  var ref = o.ref || makeRef();
  var res = { ok: false, outcome: null, ref: ref, user_id: user.id, customers: [], best: null,
              duplicates: 0, access: null, applied: null };
  var before = null, row = null;
  try {
    before = await ctx.db.rpc('billing_access_for', { p_user: user.id });
    var rows = await ctx.db.get('subscriptions?select=status,price_id,current_period_end,stripe_customer_id,' +
      'stripe_subscription_id&user_id=eq.' + encodeURIComponent(user.id) + '&limit=1');
    row = (rows && rows[0]) || null;
  } catch (e) {
    res.outcome = 'db_error'; res.error = String(e.message || e).slice(0, 200);
    logLine(ctx.svc, 'error', 'reconcile.db_error', { user_id: user.id, source: o.source, ref: ref, error: res.error });
    return res;
  }
  res.access = before;

  async function finish(outcome, ok, extra) {
    res.outcome = outcome; res.ok = ok;
    Object.assign(res, extra || {});
    var b = res.best;
    if (!o.dryRun) {
      try {
        await ctx.db.insert('billing_sync_log', [{
          user_id: user.id, source: o.source || 'unknown', outcome: outcome, ok: ok, ref: ref,
          stripe_customer_ids: res.customers.map(function (c) { return c.id; }),
          stripe_subscription_id: b ? b.id : null, stripe_status: b ? b.status : null,
          db_status_before: row ? row.status : null,
          db_status_after: res.access && res.access.subscription ? res.access.subscription.status : (row ? row.status : null),
          access_before: !!(before && before.has_access), access_after: !!(res.access && res.access.has_access),
          duration_ms: (ctx.nowMs ? ctx.nowMs() : Date.now()) - t0,
          note: res.note ? String(res.note).slice(0, 300) : null,
        }]);
      } catch (e) {
        logLine(ctx.svc, 'error', 'reconcile.log_failed', { user_id: user.id, ref: ref, error: String(e.message || e).slice(0, 200) });
      }
    }
    logLine(ctx.svc, ok ? 'info' : 'warn', 'reconcile.' + outcome, {
      user_id: user.id, source: o.source, ref: ref, event_id: o.eventId || null,
      customer_ids: res.customers.map(function (c) { return c.id; }),
      subscription_id: b ? b.id : null, stripe_status: b ? b.status : null,
      access_before: !!(before && before.has_access), access_after: !!(res.access && res.access.has_access),
      duplicates: res.duplicates, note: res.note || null,
    });
    return res;
  }

  // A comp was never sold: there is nothing in Stripe to agree with.
  if (row && row.status === 'active' && COMP_PRICE_IDS.indexOf(String(row.price_id || '')) >= 0) {
    return finish('comp', true);
  }
  if (!ctx.stripe) return finish('not_configured', false, { note: 'STRIPE_SECRET_KEY is not set' });

  var customers;
  try {
    customers = await discoverCustomers(ctx, user, { discover: !!o.discover, extraCustomers: o.extraCustomers,
      rowCustomer: row && row.stripe_customer_id, requireDb: true });
  } catch (e) {
    return finish('db_error', false, { note: String(e.message || e).slice(0, 200) });
  }
  res.customers = customers;

  // Link what was discovered, so the next event for these customers resolves
  // on its own. A customer someone else already owns is dropped here.
  var usable = [];
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    if (c.source === 'known' || o.dryRun) { usable.push(c); continue; }
    try {
      var link = await ctx.db.rpc('billing_link_customer', { p_customer_id: c.id, p_user: user.id,
        p_source: c.source, p_livemode: o.livemode == null ? null : o.livemode, p_email: c.email });
      if (link === 'conflict') continue;
    } catch (e) {
      logLine(ctx.svc, 'warn', 'reconcile.link_failed', { user_id: user.id, customer_id: c.id, error: String(e.message || e).slice(0, 200) });
    }
    usable.push(c);
  }
  res.customers = usable;

  // Only an UNREACHABLE Stripe (5xx, 429, network, deadline) makes the answer
  // unknown. A 4xx about one customer — deleted, or an id typed onto a
  // hand-made row that never existed — means that customer has nothing, and
  // must not stop every other customer of the account being read.
  var unreachable = function (e) { return !e || !e.status || e.status >= 500 || e.status === 429; };
  var subs = [], stripeErr = null;
  for (var k = 0; k < usable.length && k < 5; k++) {
    try { subs = subs.concat(await listCustomerSubscriptions(ctx.stripe, usable[k].id)); }
    catch (e) {
      if (unreachable(e)) stripeErr = e;
      else res.note = 'Stripe has no usable customer ' + usable[k].id + ' (' + e.status + ')';
    }
  }
  var have = {};
  subs.forEach(function (s) { if (s && s.id) have[s.id] = true; });
  // A listing that failed is not an answer. Do not dress an event's own (older)
  // body up as live truth: say Stripe could not be asked, and let the caller
  // take its degraded path, where the ordering rules for event bodies apply.
  if (stripeErr) return finish('stripe_error', false, { note: String(stripeErr.message || stripeErr).slice(0, 200) });
  // An event's own subscription that a SUCCESSFUL listing has not caught up
  // with yet (Stripe's list endpoints can lag a write by a moment).
  (o.extraSubscriptions || []).forEach(function (s) { if (s && s.id && !have[s.id]) { subs.push(s); have[s.id] = true; } });
  var wanted = (o.extraSubscriptionIds || []).slice();
  if (row && row.stripe_subscription_id) wanted.push(row.stripe_subscription_id);
  for (var w = 0; w < wanted.length; w++) {
    var sid = wanted[w];
    if (!sid || have[sid]) continue;
    try {
      var got = await ctx.stripe.get('/subscriptions/' + encodeURIComponent(sid));
      if (got && got.id) {
        // a subscription is only this account's if its customer is one of ours
        var gc = idOf(got.customer);
        var ours = usable.some(function (u) { return u.id === gc; }) || metadataUserId(got) === user.id ||
                   (row && row.stripe_subscription_id === sid);
        if (ours) { subs.push(got); have[sid] = true; }
      }
    } catch (e) {
      if (unreachable(e)) stripeErr = e;
      else if (row && row.stripe_subscription_id === sid) res.note = 'the row\'s subscription ' + sid + ' does not exist in Stripe';
    }
  }

  var pick = pickBest(subs, t0);
  res.best = pick.best;
  // the Stripe object itself, for a caller that reads more than the state (the
  // webhook reads the discount off it); never returned to a browser
  res.best_raw = pick.best ? subs.filter(function (s) { return s && s.id === pick.best.id; })[0] || null : null;
  res.duplicates = pick.entitled.length;
  res.stripe = pick.all.map(function (s) {
    return { id: s.id, customer_id: s.customer_id, status: s.status, current_period_end: s.current_period_end,
             cancel_at_period_end: s.cancel_at_period_end, price_id: s.price_id };
  });

  if (!pick.best) {
    if (stripeErr) {
      if (o.source === 'cron' || o.source === 'webhook') {
        try {
          await ctx.db.rpc('billing_raise_alert', { p_kind: 'sync_failed', p_dedupe: 'user:' + user.id, p_user: user.id,
            p_customer: usable[0] ? usable[0].id : null, p_subscription: null, p_event: o.eventId || null,
            p_detail: { error: String(stripeErr.message || stripeErr).slice(0, 200), source: o.source }, p_resolved: false });
        } catch (_) { /* the log line below still says it */ }
      }
      return finish('stripe_error', false, { note: String(stripeErr.message || stripeErr).slice(0, 200) });
    }
    if (row && row.stripe_subscription_id && before && before.has_access && !o.dryRun) {
      try {
        await ctx.db.rpc('billing_raise_alert', { p_kind: 'db_active_stripe_inactive', p_dedupe: 'user:' + user.id,
          p_user: user.id, p_customer: row.stripe_customer_id, p_subscription: row.stripe_subscription_id,
          p_event: o.eventId || null, p_detail: { why: 'row grants access; Stripe has no subscription for this account' },
          p_resolved: false });
      } catch (_) { /* logged below */ }
    }
    return finish('no_stripe_subscription', true);
  }

  if (pick.entitled.length > 1 && !o.dryRun) {
    try {
      await ctx.db.rpc('billing_raise_alert', { p_kind: 'duplicate_active_subscriptions', p_dedupe: 'user:' + user.id,
        p_user: user.id, p_customer: pick.best.customer_id, p_subscription: pick.best.id, p_event: o.eventId || null,
        p_detail: { live: pick.entitled.map(function (s) { return { id: s.id, status: s.status, customer: s.customer_id }; }) },
        p_resolved: false });
    } catch (_) { /* logged below */ }
  }

  if (o.dryRun) return finish('inspect', true);

  var b = pick.best, applied;
  try {
    applied = await ctx.db.rpc('billing_apply_subscription_state', {
      p_user: user.id, p_customer_id: b.customer_id, p_subscription_id: b.id, p_status: b.status,
      p_price_id: b.price_id, p_current_period_end: b.current_period_end, p_cancel_at_period_end: b.cancel_at_period_end,
      p_as_of: asOf, p_source: o.source || 'sync', p_live: true, p_authoritative: true,
      p_event_id: o.eventId || null, p_event_at: o.eventAt || null,
      p_livemode: b.livemode == null ? (o.livemode == null ? null : o.livemode) : b.livemode,
    });
  } catch (e) {
    return finish('db_error', false, { note: String(e.message || e).slice(0, 200) });
  }
  res.applied = applied;
  try { res.access = await ctx.db.rpc('billing_access_for', { p_user: user.id }); } catch (_) { /* keep before */ }

  var had = !!(before && before.has_access), has = !!(res.access && res.access.has_access);
  // 'granted' is the webhook doing its job; 'repaired' is anything else having
  // to do it for the webhook — the number worth watching.
  var outcome = !(applied && applied.applied) || applied.changed === false ? 'unchanged'
    : (!had && has ? (o.source === 'webhook' ? 'granted' : 'repaired') : (had && !has ? 'revoked' : 'updated'));
  if (applied && !applied.applied) res.note = 'not applied: ' + applied.reason;

  // A repair the webhook should have made is a webhook problem worth seeing,
  // once it is old enough that the webhook really did miss it.
  if (outcome === 'repaired' && o.source !== 'webhook' && b.created_ms && t0 - b.created_ms > 10 * 60 * 1000) {
    try {
      await ctx.db.rpc('billing_raise_alert', { p_kind: 'stripe_active_db_missing', p_dedupe: 'user:' + user.id,
        p_user: user.id, p_customer: b.customer_id, p_subscription: b.id, p_event: null,
        p_detail: { repaired_by: o.source, stripe_status: b.status, db_status_before: row ? row.status : null },
        p_resolved: true });
    } catch (_) { /* logged below */ }
  }
  if (outcome === 'revoked' && o.source !== 'webhook') {
    try {
      await ctx.db.rpc('billing_raise_alert', { p_kind: 'db_active_stripe_inactive', p_dedupe: 'user:' + user.id,
        p_user: user.id, p_customer: b.customer_id, p_subscription: b.id, p_event: null,
        p_detail: { corrected_by: o.source, stripe_status: b.status, db_status_before: row ? row.status : null },
        p_resolved: true });
    } catch (_) { /* logged below */ }
  }
  if (has) {
    try {
      await ctx.db.rpc('billing_clear_alerts', { p_user: user.id,
        p_kinds: ['sync_failed', 'stripe_active_db_missing'], p_note: 'access confirmed by ' + (o.source || 'sync') });
      if (pick.entitled.length <= 1) {
        await ctx.db.rpc('billing_clear_alerts', { p_user: user.id, p_kinds: ['duplicate_active_subscriptions'],
          p_note: 'one live subscription remains' });
      }
    } catch (_) { /* cosmetic */ }
  }
  return finish(outcome, true);
}
// ── END BILLING CORE ──────────────────────────────────────────────────────

// ── the promotion code, normalised ────────────────────────────────────────
// Stripe matches a promotion code case-insensitively when it is redeemed, so
// one code arrives as BETDESK, betdesk and BetDesk. Upper-casing is what stops
// a single code becoming three lines in the report. Anything outside the
// character set a Stripe promotion code can hold is refused rather than
// scrubbed into something that merely looks like one — a sanitised string would
// be attributed to a code nobody ever created.
function normCode(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return /^[A-Z0-9_.-]{1,64}$/.test(s) ? s : null;
}

// ── what discount, if any, a session or a subscription carried ────────────
// Stripe reports this in several shapes and WHICH ONE ARRIVES DEPENDS ON THE
// ACCOUNT'S API VERSION — the same trap periodEnd() above exists for:
//
//   session.discounts[]                      [{coupon, promotion_code}] as ids
//                                            on older versions; Discount
//                                            objects from 2025-01-27.acacia
//   session.total_details.breakdown.discounts[]   [{amount, discount:{…}}],
//                                            present only when expanded
//   subscription.discount / .discounts[]     the same Discount, on the
//                                            subscription the checkout created
//
// so every one of them is read and the first that names a promotion code wins.
//
// A COUPON ID IS NOT AN ANSWER. Two promotion codes can share one coupon, so a
// coupon alone says a discount happened, not who sent the customer. It is
// recorded as exactly that much and never promoted into a code.
function readDiscount(obj) {
  const out = { promotion_code_id: null, coupon_id: null, code: null };
  if (!obj || typeof obj !== 'object') return out;

  const take = (d) => {
    if (!d) return;
    if (typeof d === 'string') {
      // A bare id. Only a promo_… is unambiguous; a di_… is a discount id,
      // which names nothing without another round trip, and is not guessed at.
      if (d.indexOf('promo_') === 0 && !out.promotion_code_id) out.promotion_code_id = d;
      return;
    }
    if (typeof d !== 'object') return;
    // a breakdown entry, {amount, discount:{…}}, wraps the real thing
    if (d.discount) take(d.discount);
    const pc = d.promotion_code;
    if (typeof pc === 'string') {
      if (!out.promotion_code_id) out.promotion_code_id = pc;
    } else if (pc && typeof pc === 'object') {
      if (pc.id && !out.promotion_code_id) out.promotion_code_id = pc.id;
      if (pc.code && !out.code) out.code = normCode(pc.code);
    }
    if (d.coupon && !out.coupon_id) out.coupon_id = idOf(d.coupon);
  };

  const lists = [
    obj.discounts,
    obj.total_details && obj.total_details.breakdown && obj.total_details.breakdown.discounts,
  ];
  for (const list of lists) if (Array.isArray(list)) list.forEach(take);
  if (obj.discount) take(obj.discount);
  return out;
}

function hasDiscount(d) {
  return !!(d && (d.promotion_code_id || d.coupon_id || d.code));
}

// What a single event says, or null if it says nothing we act on. Pure, so it is
// testable without a network or a database.
//
// `user_id` is the raw account id the event carries, as it always was;
// `metadata_user_id` is the same thing validated as a uuid. A completed
// checkout carries no status of its own: the subscription is read live, and
// claiming 'active' here would mark a failed or incomplete one as paid.
function readEvent(event) {
  const type = event && event.type;
  const obj = event && event.data && event.data.object;
  if (!obj) return null;

  if (type === 'checkout.session.completed' ||
      type === 'checkout.session.async_payment_succeeded' ||
      type === 'checkout.session.async_payment_failed') {
    return {
      kind: 'checkout',
      session_id: obj.id || null,
      mode: obj.mode || null,
      user_id: obj.client_reference_id || null,
      client_reference_id: obj.client_reference_id || null,
      metadata_user_id: metadataUserId(obj),
      email: (obj.customer_details && obj.customer_details.email) || obj.customer_email || null,
      customer_id: idOf(obj.customer),
      subscription_id: idOf(obj.subscription),
      status: null,
      current_period_end: null,
      cancel_at_period_end: null,
      price_id: null,
      // The one event that can carry the promotion code the customer typed.
      discount: readDiscount(obj),
      object: null,
    };
  }

  if (type === 'checkout.session.expired') {
    return {
      kind: 'checkout_expired', session_id: obj.id || null, mode: obj.mode || null,
      user_id: obj.client_reference_id || null, client_reference_id: obj.client_reference_id || null,
      metadata_user_id: metadataUserId(obj), email: null, customer_id: idOf(obj.customer),
      subscription_id: null, status: null, current_period_end: null, cancel_at_period_end: null,
      price_id: null, discount: null, object: null,
    };
  }

  if (type === 'customer.subscription.created' ||
      type === 'customer.subscription.updated' ||
      type === 'customer.subscription.deleted' ||
      type === 'customer.subscription.paused' ||
      type === 'customer.subscription.resumed') {
    return {
      kind: 'subscription',
      session_id: null,
      mode: null,
      user_id: (obj.metadata && obj.metadata.supabase_user_id) || null,
      client_reference_id: null,
      metadata_user_id: metadataUserId(obj),
      email: null,
      customer_id: idOf(obj.customer),
      subscription_id: obj.id || null,
      // A deleted subscription is canceled whatever the object still says.
      status: type === 'customer.subscription.deleted' ? 'canceled' : (obj.status || null),
      current_period_end: periodEnd(obj),
      cancel_at_period_end: !!obj.cancel_at_period_end,
      price_id: priceIdOf(obj),
      // The discount the checkout put on the subscription. Corroboration, and
      // the fallback for an account whose API version leaves `discounts` off
      // the checkout session entirely.
      discount: readDiscount(obj),
      object: type === 'customer.subscription.deleted' ? Object.assign({}, obj, { status: 'canceled' }) : obj,
    };
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
    // Stripe moves the subscription to past_due itself and sends a
    // subscription.updated for it; an invoice is a reason to look, not the
    // answer. Newer API versions moved the subscription under
    // parent.subscription_details — both shapes are read.
    const sd = (obj.parent && obj.parent.subscription_details) || obj.subscription_details || null;
    return {
      kind: 'invoice',
      session_id: null,
      mode: null,
      user_id: null,
      client_reference_id: null,
      metadata_user_id: metadataUserId(sd),
      email: obj.customer_email || null,
      customer_id: idOf(obj.customer),
      subscription_id: idOf(obj.subscription) || idOf(sd && sd.subscription),
      status: null,
      current_period_end: null,
      cancel_at_period_end: null,
      price_id: null,
      discount: null,
      object: null,
    };
  }

  return null;
}

// Which Stripe key may answer a question about this event. Asking a live key
// about a test object gets a 404 — which reads exactly like an object that does
// not exist, and would quietly turn a dry run into a false negative.
function stripeKeyFor(livemode) {
  return livemode === false
    ? (Deno.env.get('STRIPE_SECRET_KEY_TEST') ||
       ((Deno.env.get('STRIPE_MODE') || '').toLowerCase() === 'test' ? Deno.env.get('STRIPE_SECRET_KEY') : null) || null)
    : (Deno.env.get('STRIPE_SECRET_KEY') || null);
}

// A promotion code id (promo_…) is not a code. This is the one call that turns
// it into the string the customer typed. It is the LAST resort on purpose:
// referral_codes is asked first, so attribution keeps working on a day the
// Stripe API is slow or STRIPE_SECRET_KEY is unset.
async function fetchPromotionCode(promoId, secretKey) {
  if (!promoId || !secretKey) return null;
  try {
    const r = await fetch('https://api.stripe.com/v1/promotion_codes/' + encodeURIComponent(promoId), {
      headers: { authorization: 'Bearer ' + secretKey },
    });
    if (!r.ok) {
      console.error('stripe_webhook: promotion code lookup ' + r.status);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('stripe_webhook: promotion code lookup failed', String(e));
    return null;
  }
}

// Turn whatever the event carried into the row's attribution, or null when the
// sale used no discount at all. Three ways to name a code, in descending order
// of certainty, and no fourth — in particular, nothing here ever picks a code
// because it happens to be the only one on file. A discount we cannot name is
// recorded as an unnamed discount, which the report shows on its own line.
async function resolveReferral(D, d, secretKey, seenOn) {
  if (!hasDiscount(d)) return null;

  const out = {
    code: d.code || null,
    promotion_code_id: d.promotion_code_id || null,
    coupon_id: d.coupon_id || null,
    partner: null,
    source: seenOn + ':inline',
  };

  // 1. Our own table, keyed on the promotion code id. No network at all.
  if (!out.code && out.promotion_code_id) {
    const rows = await D.get('referral_codes?select=code,partner_name,stripe_coupon_id' +
      '&stripe_promotion_code_id=eq.' + encodeURIComponent(out.promotion_code_id) + '&limit=1')
      .catch(() => null);
    if (rows && rows[0] && rows[0].code) {
      out.code = normCode(rows[0].code);
      out.partner = rows[0].partner_name || null;
      out.source = seenOn + ':referral_codes';
      if (!out.coupon_id) out.coupon_id = rows[0].stripe_coupon_id || null;
    }
  }

  // 2. Ask Stripe what that id is called.
  if (!out.code && out.promotion_code_id) {
    const pc = await fetchPromotionCode(out.promotion_code_id, secretKey);
    if (pc && pc.code) {
      out.code = normCode(pc.code);
      out.source = seenOn + ':stripe_lookup';
      if (!out.coupon_id) out.coupon_id = idOf(pc.coupon);
    }
  }

  // 3. A discount that could not be named is still recorded, as that.
  if (!out.code) out.source = seenOn + ':unnamed_discount';

  // The partner name is a SNAPSHOT taken at the sale, like the offer text on a
  // billing consent: renaming a partner next year must not quietly rewrite what
  // last year's sales say they were sold under.
  if (out.code && !out.partner) {
    const rows = await D.get('referral_codes?select=partner_name&code=eq.' +
      encodeURIComponent(out.code) + '&limit=1').catch(() => null);
    if (rows && rows[0]) out.partner = rows[0].partner_name || null;
  }

  return out;
}

async function handle(req) {
  const t0 = Date.now();
  // A plain GET is not an error worth hiding: it is how the deployed build is
  // confirmed from the dashboard or a curl. It still refuses to do anything.
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  const SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  // Present only while a dry run is being done. See the header.
  const SECRET_TEST = Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST');
  const SB_URL = Deno.env.get('SB_URL') || Deno.env.get('SUPABASE_URL');
  const SB_KEY = Deno.env.get('SB_SERVICE_ROLE') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const PRIMARY_MODE = (Deno.env.get('STRIPE_MODE') || 'live').toLowerCase() === 'test' ? 'test' : 'live';

  // The raw body, byte for byte. Parsing and re-serialising changes the bytes
  // and every signature check would fail for a reason nobody could see.
  const raw = await req.text();

  const nowSec = Math.floor(Date.now() / 1000);
  let v = await verifySignature(raw, req.headers.get('stripe-signature'), SECRET, nowSec);
  let signedMode = PRIMARY_MODE;
  // A TEST-MODE ENDPOINT SIGNS WITH ITS OWN SECRET, so proving this function
  // before pointing live money at it otherwise means swapping the live secret
  // out and back — an outage, during which real payments are refused. The
  // second secret is tried only after the live one has already failed, so the
  // live path is not lengthened and nothing about it changes when it is unset.
  if (!v.ok && SECRET_TEST) {
    const t = await verifySignature(raw, req.headers.get('stripe-signature'), SECRET_TEST, nowSec);
    if (t.ok) { v = t; signedMode = 'test'; }
  }
  if (!v.ok) {
    logLine('stripe_webhook', 'warn', 'webhook.rejected', { reason: v.reason });
    return json({ error: 'invalid signature' }, 400);
  }

  if (!SB_URL || !SB_KEY) {
    // 500 on purpose: Stripe retries a 500, and a misconfigured function that
    // answered 200 would drop real payments on the floor for good.
    logLine('stripe_webhook', 'error', 'webhook.not_configured', { missing: !SB_URL ? 'SB_URL' : 'SB_SERVICE_ROLE' });
    return json({ error: 'not configured' }, 500);
  }

  let event = null;
  try { event = JSON.parse(raw); } catch (_) { event = null; }
  if (!event || !event.id || !event.type) {
    return json({ error: 'unparseable event' }, 400);
  }

  // Stripe stamps every event with this. A test delivery is recorded and
  // answered exactly like a real one — the ledger keeps the whole payload, so
  // `payload->>'livemode' = 'false'` finds them all again — but it says so in
  // the log and in the response, because a dry run that is indistinguishable
  // from a sale is not a dry run.
  const livemode = event.livemode !== false;
  // MODE VALIDATION. The secret that signed the delivery says which Stripe mode
  // sent it; an event claiming the other mode is a misconfigured endpoint, and
  // acting on it would let test data write live rows (or the reverse). 400, so
  // Stripe keeps it until the configuration is fixed — nothing is lost.
  if ((signedMode === 'test') === livemode) {
    logLine('stripe_webhook', 'error', 'webhook.mode_mismatch', { stripe_event_id: event.id, type: event.type,
      livemode, signed_with: signedMode });
    return json({ error: 'mode mismatch' }, 400);
  }
  if (!livemode) console.warn('stripe_webhook: TEST MODE delivery ' + event.id + ' (' + event.type + ')');

  const D = makeDb(SB_URL, SB_KEY);
  const stripeCreated = event.created ? new Date(event.created * 1000).toISOString() : null;
  const read = readEvent(event);
  const handled = HANDLED.indexOf(event.type) >= 0;
  const trace = { stripe_event_id: event.id, type: event.type, livemode,
                  customer_id: read ? read.customer_id : null, subscription_id: read ? read.subscription_id : null,
                  session_id: read ? read.session_id : null };

  // Record the delivery FIRST, keyed on Stripe's id. A retry lands on the same
  // primary key, counts as another attempt, and cannot double-count.
  let ledger = null;
  try {
    ledger = await D.rpc('billing_record_event', {
      p_id: event.id, p_type: event.type, p_created: stripeCreated,
      p_customer: read ? read.customer_id : null, p_subscription: read ? read.subscription_id : null,
      p_payload: event, p_note: handled ? null : 'not a handled event type' });
  } catch (e) {
    // billing_hardening.sql not applied yet: the plain upsert the ledger has
    // always taken, so the delivery is at least on record.
    try {
      await D.upsert('stripe_events', [{
        id: event.id, type: event.type, stripe_created: stripeCreated,
        customer_id: read ? read.customer_id : null, subscription_id: read ? read.subscription_id : null,
        payload: event, resolved: false, applied: false,
        note: handled ? null : 'not a handled event type',
      }], 'id');
      ledger = { attempts: null };
    } catch (e2) {
      logLine('stripe_webhook', 'error', 'webhook.ledger_failed', Object.assign({ error: String(e2.message || e2) }, trace));
      return json({ error: 'ledger write failed' }, 500);
    }
  }

  if (ALERT_ONLY.indexOf(event.type) >= 0) {
    const o = event.data && event.data.object;
    await D.rpc('billing_raise_alert', { p_kind: 'dispute', p_dedupe: 'evt:' + event.id, p_user: null,
      p_customer: o ? idOf(o.customer) : null, p_subscription: null, p_event: event.id,
      p_detail: { type: event.type, amount: o ? o.amount : null, reason: o ? o.reason : null }, p_resolved: false })
      .catch(() => {});
    logLine('stripe_webhook', 'warn', 'webhook.dispute', trace);
    return json({ ok: true, ignored: event.type, alerted: true }, 200);
  }

  if (!read || !handled) {
    // Acknowledged and stored, deliberately not acted on.
    return json({ ok: true, ignored: event.type }, 200);
  }

  const markEvent = (fields) => D.patch('stripe_events', 'id=eq.' + encodeURIComponent(event.id),
    Object.assign({ processed_at: new Date().toISOString() }, fields)).catch(() => {});

  // A one-off payment checkout is not a subscription and grants nothing here.
  if ((read.kind === 'checkout' || read.kind === 'checkout_expired') && read.mode && read.mode !== 'subscription') {
    await markEvent({ resolved: true, applied: false, note: 'checkout mode ' + read.mode + ': not a subscription' });
    return json({ ok: true, ignored: 'checkout mode ' + read.mode }, 200);
  }

  try {
    return await processEvent(D, event, read, livemode, stripeCreated, trace, markEvent, t0);
  } catch (e) {
    // 500 so Stripe retries. Losing this is losing a payment. Recorded, and
    // after the third failed attempt raised for a human.
    const msg = String((e && e.message) || e).slice(0, 300);
    await markEvent({ last_error: msg });
    if (ledger && ledger.attempts >= 3) {
      await D.rpc('billing_raise_alert', { p_kind: 'webhook_failing', p_dedupe: 'evt:' + event.id, p_user: null,
        p_customer: read.customer_id, p_subscription: read.subscription_id, p_event: event.id,
        p_detail: { type: event.type, attempts: ledger.attempts, error: msg }, p_resolved: false }).catch(() => {});
    }
    logLine('stripe_webhook', 'error', 'webhook.failed', Object.assign({ error: msg, attempts: ledger && ledger.attempts }, trace));
    return json({ error: 'processing failed' }, 500);
  }
}

async function processEvent(D, event, read, livemode, stripeCreated, trace, markEvent, t0) {
  // Short, and no retry of our own: Stripe redelivers anything we answer 500,
  // and a webhook that sits on a slow API call risks Stripe's own timeout.
  const stripe = makeStripe(stripeKeyFor(livemode), fetch, { timeoutMs: 4000, retries: 0 });

  // ── WHO ─────────────────────────────────────────────────────────────────
  let who = await D.rpc('billing_resolve_user', {
    p_metadata_user: read.metadata_user_id, p_client_reference: read.client_reference_id,
    p_customer_id: read.customer_id, p_subscription_id: read.subscription_id,
    p_session_id: read.session_id, p_email: read.email });
  // Still nobody: the customer itself may say. create_checkout_session puts the
  // account id on the customer, and the customer has the email Stripe kept.
  if (!who.user_id && stripe && read.customer_id) {
    try {
      const cust = await stripe.get('/customers/' + encodeURIComponent(read.customer_id));
      if (cust && !cust.deleted) {
        const again = await D.rpc('billing_resolve_user', {
          p_metadata_user: metadataUserId(cust), p_client_reference: null, p_customer_id: null,
          p_subscription_id: null, p_session_id: null, p_email: cust.email || read.email });
        if (again && again.user_id) who = Object.assign({}, again, { how: 'customer ' + again.how });
      }
    } catch (_) { /* stays unresolved, and says so below */ }
  }
  if (who.conflict) {
    await D.rpc('billing_raise_alert', { p_kind: 'identity_conflict', p_dedupe: 'evt:' + event.id, p_user: who.user_id,
      p_customer: read.customer_id, p_subscription: read.subscription_id, p_event: event.id,
      p_detail: { chosen: who.how, disagrees: who.conflict }, p_resolved: false }).catch(() => {});
  }

  if (!who.user_id) {
    // NOT an error. 200 so Stripe stops retrying; the delivery stays on the
    // ledger, unresolved, and is raised for a human. It is resolved later, on
    // its own, the moment its customer is linked to an account.
    await markEvent({ resolved: false, note: 'no account matched this customer yet' });
    await D.rpc('billing_raise_alert', { p_kind: 'unresolved_event',
      p_dedupe: read.customer_id ? 'cus:' + read.customer_id : 'evt:' + event.id, p_user: null,
      p_customer: read.customer_id, p_subscription: read.subscription_id, p_event: event.id,
      p_detail: { type: event.type, email: maskEmail(read.email), rejected: who.rejected || [] }, p_resolved: false })
      .catch(() => {});
    logLine('stripe_webhook', 'warn', 'webhook.unresolved', Object.assign({ email: read.email, rejected: who.rejected }, trace));
    return json({ ok: true, unresolved: true }, 200);
  }
  trace.user_id = who.user_id;

  // What does the row already say? Needed for the comp guard and for the
  // referral write's "already credited" short-cut.
  let existing = null;
  try {
    const rows = await D.get('subscriptions?select=*&user_id=eq.' + encodeURIComponent(who.user_id) + '&limit=1');
    existing = (rows && rows[0]) || null;
  } catch (e) { logLine('stripe_webhook', 'warn', 'webhook.read_existing_failed', Object.assign({ error: String(e.message || e) }, trace)); }

  // A COMPED ROW IS NOT STRIPE'S TO WRITE. `price_id = 'owner_comp'` is access
  // granted in this database, never bought — there is no Stripe subscription
  // behind it, so no Stripe event describes it. If one ever arrives carrying
  // this user_id (a customer id reused across products, a test event, a
  // payment link fired at the wrong account), applying it would set the row's
  // status from something Stripe knows about and revoke access that Stripe
  // never granted. Acknowledged with 200 so Stripe stops retrying: refusing
  // this write is the correct outcome, not a failure to be redelivered.
  // (billing_apply_subscription_state refuses it too; this is the early exit.)
  if (existing && COMP_PRICE_IDS.indexOf(String(existing.price_id || '')) >= 0) {
    console.log('stripe_webhook: ignoring ' + event.type + ' for comped user ' + who.user_id +
      ' (price_id ' + existing.price_id + ')');
    await markEvent({ user_id: who.user_id, resolved: true, applied: false, resolved_how: who.how, note: 'comped account' });
    return json({ ok: true, ignored: 'comped_subscription' }, 200);
  }

  // Our own record of the session, when we created it.
  if (read.session_id && (read.kind === 'checkout' || read.kind === 'checkout_expired')) {
    const patch = read.kind === 'checkout_expired'
      ? { status: 'expired' }
      : { status: 'complete', completed_at: new Date().toISOString(), subscription_id: read.subscription_id };
    await D.patch('billing_checkout_sessions', 'id=eq.' + encodeURIComponent(read.session_id), patch).catch(() => {});
  }
  if (read.kind === 'checkout_expired') {
    await markEvent({ user_id: who.user_id, resolved: true, applied: false, resolved_how: who.how, note: 'checkout expired' });
    logLine('stripe_webhook', 'info', 'webhook.checkout_expired', trace);
    return json({ ok: true, how: who.how, ignored: 'checkout expired' }, 200);
  }

  // ── WHAT STRIPE SAYS NOW ────────────────────────────────────────────────
  // The account is named, so ask Stripe for every subscription it has and write
  // the best one, live, as of this moment. The event's own body is only the
  // fallback for when Stripe cannot be asked.
  let result = null, outcome = null, applied = false, changed = false, access = null, liveSub = null, via = 'live';
  if (stripe) {
    result = await reconcileUser({ db: D, stripe, svc: 'stripe_webhook' },
      { id: who.user_id, email: null, email_confirmed: false },
      { source: 'webhook', discover: false,
        extraCustomers: read.customer_id ? [read.customer_id] : [],
        extraSubscriptions: read.object ? [read.object] : [],
        extraSubscriptionIds: read.subscription_id ? [read.subscription_id] : [],
        eventId: event.id, eventAt: stripeCreated, livemode });
    if (result.ok && result.outcome !== 'no_stripe_subscription') {
      outcome = result.outcome;
      applied = !!(result.applied && result.applied.applied);
      changed = !!(result.applied && result.applied.changed);
      access = result.access;
      liveSub = result.best_raw && result.best_raw.id === read.subscription_id ? result.best_raw : null;
    } else {
      result = null;
    }
  }

  if (!result) {
    // Stripe could not be asked (no key, an outage, or it has nothing yet).
    via = 'payload';
    const r = await D.rpc('billing_apply_subscription_state', {
      p_user: who.user_id, p_customer_id: read.customer_id, p_subscription_id: read.subscription_id,
      p_status: read.status, p_price_id: read.price_id, p_current_period_end: read.current_period_end,
      p_cancel_at_period_end: read.status ? read.cancel_at_period_end : null,
      p_as_of: stripeCreated, p_source: 'webhook_payload', p_live: false, p_authoritative: false,
      p_event_id: event.id, p_event_at: stripeCreated, p_livemode: livemode });
    applied = !!(r && r.applied);
    changed = !!(r && r.changed);
    outcome = applied ? (changed ? 'updated' : 'unchanged') : ('not applied: ' + (r && r.reason));
    try { access = await D.rpc('billing_access_for', { p_user: who.user_id }); } catch (_) { access = null; }
    // A CHECKOUT LEAVES NO STATUS, AND A ROW WITH NO STATUS IS A LOCKED-OUT
    // CUSTOMER. With a key configured this was an outage: answer 500 so Stripe
    // delivers it again when Stripe can be asked. Without one there is nothing
    // a retry can change, so it is said loudly instead.
    if (read.kind === 'checkout' && !(access && access.has_access)) {
      if (stripe) {
        await markEvent({ user_id: who.user_id, resolved: true, applied, resolved_how: who.how,
          last_error: 'subscription state could not be read from Stripe; retrying' });
        logLine('stripe_webhook', 'error', 'webhook.checkout_state_unavailable', trace);
        return json({ error: 'subscription state unavailable, retry' }, 500);
      }
      console.warn('stripe_webhook: checkout for ' + read.subscription_id +
        ' left no status — set STRIPE_SECRET_KEY, or the customer stays locked out');
    }
  }

  // ── WHICH CODE THIS SALE CAME IN UNDER ───────────────────────────────────
  // Its own write, after the status one, for three reasons.
  //
  // IT MUST NOT BE ABLE TO COST SOMEBODY THEIR ACCESS. On a project where
  // supabase/referral_codes.sql has not been run these columns do not exist,
  // and folding them into the row above would make every delivery a 500 —
  // Stripe retrying a paying customer forever while their status never lands.
  // Attribution is worth having. It is not worth that, so it fails on its own
  // and says so in the log.
  //
  // AN OLD EVENT STILL KNOWS SOMETHING NEW. The ordering guard refuses a late
  // delivery because it must not overwrite a newer STATUS. A promotion code is
  // not a status; it is a fact about the sale that the row may never have been
  // told. So this runs whether or not the event was fresh.
  //
  // AND THE FIRST ATTRIBUTION WINS. `referral_code=is.null` is in the FILTER,
  // not in an if — so two deliveries racing produce one credited code rather
  // than whichever landed last, and a code already on the row is never
  // rewritten by a later event. A row that carries an unnamed discount still
  // matches, so it can be upgraded the moment the code can be named.
  // Already credited? The filter below would refuse the write anyway, but every
  // subsequent event for an attributed customer would first cost a table read
  // and, when the code still needs naming, a call to Stripe — all for a write
  // that can only ever match zero rows. The guarantee is the filter; this is
  // only the saving.
  let referral = null;
  if (!(existing && existing.referral_code)) {
    try {
      let disc = read.discount;
      let seenOn = read.kind === 'checkout' ? 'checkout_session' : 'subscription_object';
      // An older API version can leave `discounts` off the checkout session
      // altogether. When Stripe has already handed us the subscription the
      // checkout created, the discount is on that — look there rather than
      // recording "no code" for a sale that used one.
      if (!hasDiscount(disc) && liveSub) {
        const alt = readDiscount(liveSub);
        if (hasDiscount(alt)) { disc = alt; seenOn = 'subscription_object'; }
      }
      referral = await resolveReferral(D, disc, stripeKeyFor(livemode), seenOn);
      if (referral) {
        const patch = { referral_source: referral.source };
        if (referral.code) patch.referral_code = referral.code;
        if (referral.partner) patch.referred_partner = referral.partner;
        if (referral.promotion_code_id) patch.stripe_promotion_code_id = referral.promotion_code_id;
        if (referral.coupon_id) patch.stripe_coupon_id = referral.coupon_id;
        await D.patch('subscriptions',
          'user_id=eq.' + encodeURIComponent(who.user_id) + '&referral_code=is.null', patch);
      }
    } catch (e) {
      // Loud, and only in the log. A customer is not told about this and Stripe
      // is not asked to retry it: the money side of the delivery already landed.
      console.error('stripe_webhook: referral attribution not recorded —', String(e),
        '(run supabase/referral_codes.sql if these columns do not exist yet)');
    }
  }

  await markEvent({
    user_id: who.user_id, resolved: true, applied, resolved_how: who.how, last_error: null,
    note: (applied ? 'applied via ' + who.how : 'not applied') + ' (' + via + ': ' + outcome + ')',
  });

  logLine('stripe_webhook', 'info', 'webhook.processed', Object.assign({
    how: who.how, via, outcome, applied, changed,
    access: !!(access && access.has_access), status: access && access.subscription ? access.subscription.status : null,
    ms: Date.now() - t0 }, trace));

  return json({
    ok: true, applied, changed, how: who.how, livemode, via, outcome,
    has_access: !!(access && access.has_access),
    // What was actually recorded, so a test-mode dry run can be read off the
    // response instead of guessed at from the database afterwards.
    referral_code: referral ? referral.code : null,
    referral_source: referral ? referral.source : null,
  }, 200);
}

Deno.serve(handle);

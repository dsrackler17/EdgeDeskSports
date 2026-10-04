// ============================================================
//  FILE:    supabase/functions/create_checkout_session/index.ts
//  TYPE:    Edge Function (deployed) - authenticated Stripe Checkout
//  DEPLOY:  supabase functions deploy create_checkout_session --no-verify-jwt
//           JWT verification is done HERE, against Supabase Auth, on every
//           request (the props_cron pattern) — so the gateway setting cannot
//           be the thing that decides who is buying. An unauthenticated call is
//           a 401 before anything else runs.
//  IMPORTS: NONE. One file; the billing core is copied in between its markers
//           by tools/billing/inline_core.js (edit tools/billing/billing_core.js).
//
//  SECRETS:
//    STRIPE_SECRET_KEY       sk_live_... or a restricted key with WRITE on
//                            Customers and Checkout Sessions, READ on Prices,
//                            Promotion Codes and Subscriptions
//    STRIPE_PRICE_ID         price_... the EdgeDesk Full Access monthly price
//                            (lib/edgedesk_pricing.js PRICE_CENTS, USD, month)
//    STRIPE_TRIAL_DAYS       optional, default 7 (lib/edgedesk_pricing.js TRIAL_DAYS)
//    SITE_URL                optional, default https://edgedesksports.com
//    STRIPE_AUTOMATIC_TAX    optional, 'true' when Stripe Tax is on
//    BILLING_ONE_TRIAL_PER_ACCOUNT  optional, 'true' refuses a second free
//                            trial to an account that already had a Stripe
//                            subscription. Off by default, which is what the
//                            Payment Link has always done.
//    SB_URL / SB_SERVICE_ROLE (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
//    SUPABASE_ANON_KEY       provided by Supabase; used only to ask Auth who the
//                            caller's token belongs to
// ============================================================
//
// WHY THIS EXISTS. Checkout used to be a Stripe Payment Link the BROWSER built:
// `buy.stripe.com/...?client_reference_id=<uuid from localStorage>`. That put the
// one fact that ties a payment to an account in the hands of the page — a stale
// session from a previous account on the same device sent that account's uuid —
// and a Payment Link cannot put the account on the SUBSCRIPTION, so every
// subscription event after the checkout could only be named if the one checkout
// delivery had landed. When it did not, the customer paid and stayed locked out.
//
// Now the account is derived from the caller's verified token and nothing the
// browser sends can change it. Before any payment the account has a Stripe
// customer linked to it in billing_customers, and the uuid is on the Checkout
// Session (client_reference_id + metadata), on the subscription
// (subscription_data.metadata) and on the customer (metadata) — so every event
// Stripe sends afterwards names the account by itself, in any order.
//
// WALLETS. No payment_method_types are passed, so Checkout offers whatever the
// Stripe dashboard enables — card, Apple Pay, Google Pay, Link — through this
// SAME session. There is no separate wallet path to get wrong.
//
// WHAT IT REFUSES
//   * an account Stripe already has a live subscription for (asked LIVE, not
//     just the row, so a webhook that has not landed yet cannot sell a second
//     subscription) — 409 already_entitled
//   * a Stripe price that is not the figure the customer just consented to —
//     409 offer_mismatch, before anything is created (the automatic-renewal
//     consent must describe the charge exactly)
//   * more than 10 checkouts in 10 minutes from one account — 429
//
// IT REUSES rather than duplicates: an open session from the last 30 minutes for
// the same offer is returned again (a double click, a second tab), and an
// account's existing Stripe customer is used instead of making another.

const BUILD = 'create_checkout_session-2026-10-04-1';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
function json(body, status) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json', 'x-edgedesk-build': BUILD }, CORS),
  });
}

function config() {
  const env = (k) => Deno.env.get(k) || '';
  return {
    url: env('SB_URL') || env('SUPABASE_URL'),
    serviceKey: env('SB_SERVICE_ROLE') || env('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: env('SUPABASE_ANON_KEY') || env('SB_ANON_KEY'),
    stripeKey: env('STRIPE_SECRET_KEY'),
    priceId: env('STRIPE_PRICE_ID'),
    trialDays: Number(env('STRIPE_TRIAL_DAYS') || '7'),
    siteUrl: (env('SITE_URL') || 'https://edgedesksports.com').replace(/\/+$/, ''),
    automaticTax: env('STRIPE_AUTOMATIC_TAX') === 'true',
    oneTrial: env('BILLING_ONE_TRIAL_PER_ACCOUNT') === 'true',
  };
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

// The caller, verified by Supabase Auth; never decoded here.
async function getUser(c, req) {
  const authz = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  try {
    const r = await fetchWithTimeout(fetch, c.url.replace(/\/+$/, '') + '/auth/v1/user',
      { headers: { apikey: c.anonKey, authorization: authz } }, 6000);
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id)) return null;
    return { id: u.id.toLowerCase(), email: u.email || null, email_confirmed: !!(u.email_confirmed_at || u.confirmed_at) };
  } catch (_) { return null; }
}

// The price is checked against Stripe once per warm instance.
const PRICE_CACHE = {};
async function readPrice(stripe, id) {
  const hit = PRICE_CACHE[id];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.price;
  const p = await stripe.get('/prices/' + encodeURIComponent(id));
  PRICE_CACHE[id] = { at: Date.now(), price: p };
  return p;
}

// Does the Stripe price sell exactly what the consent screen showed?
function offerProblem(price, wantCents, wantTrialDays, trialDays) {
  if (!price || price.object !== 'price') return 'STRIPE_PRICE_ID is not a price';
  if (!price.active) return 'the configured Stripe price is archived';
  if (price.type !== 'recurring' || !price.recurring) return 'the configured Stripe price is not recurring';
  if (price.recurring.interval !== 'month' || (price.recurring.interval_count || 1) !== 1) return 'the configured Stripe price is not monthly';
  if (String(price.currency || '').toLowerCase() !== 'usd') return 'the configured Stripe price is not USD';
  if (Number(price.unit_amount) !== Number(wantCents)) {
    return 'the configured Stripe price charges ' + price.unit_amount + ' cents, the consent showed ' + wantCents;
  }
  if (Number(wantTrialDays) !== Number(trialDays)) {
    return 'the consent promised a ' + wantTrialDays + '-day trial; checkout is configured for ' + trialDays;
  }
  return null;
}

async function pickCustomer(c, ctx, user, candidates) {
  for (const cand of candidates) {
    try {
      const cust = await ctx.stripe.get('/customers/' + encodeURIComponent(cand.id));
      if (!cust || cust.deleted) continue;
      const m = metadataUserId(cust);
      if (m && m !== user.id) continue;            // somebody else's, whatever our table says
      if (!m) {
        // stamp it, so every future event about this customer names the account
        await ctx.stripe.post('/customers/' + encodeURIComponent(cust.id),
          { metadata: { supabase_user_id: user.id } }).catch(() => null);
      }
      return { id: cust.id, created: false };
    } catch (_) { /* try the next one */ }
  }
  const made = await ctx.stripe.post('/customers', {
    email: user.email || undefined,
    metadata: { supabase_user_id: user.id },
  }, 'edgedesk-customer-' + user.id);
  return { id: made.id, created: true };
}

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const c = config();
  if (req.method === 'GET') {
    return json({ ok: true, service: 'create_checkout_session', core: CORE_VERSION,
      configured: { stripe_key: !!c.stripeKey, price: !!c.priceId, database: !!(c.url && c.serviceKey), auth: !!c.anonKey } });
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);

  // Not configured is the ONE answer that lets the page fall back to the
  // Payment Link: nothing was created, nothing was charged.
  if (!c.url || !c.serviceKey || !c.anonKey || !c.stripeKey || !c.priceId) {
    logLine('create_checkout_session', 'error', 'checkout.not_configured',
      { has_stripe_key: !!c.stripeKey, has_price: !!c.priceId, has_db: !!(c.url && c.serviceKey), has_anon: !!c.anonKey });
    return json({ ok: false, reason: 'not_configured', fallback_ok: true,
      message: 'Checkout is not configured on the server.' }, 503);
  }

  const user = await getUser(c, req);
  if (!user) return json({ ok: false, reason: 'sign_in_required', message: 'Sign in to start checkout.' }, 401);

  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const kind = String(body.kind || 'trial');
  if (kind !== 'trial') return json({ ok: false, reason: 'bad_kind', message: 'Only the trial checkout is offered here.' }, 400);
  const wantCents = Number(body.price_cents), wantTrial = Number(body.trial_days);
  if (!Number.isInteger(wantCents) || wantCents <= 0 || !Number.isInteger(wantTrial) || wantTrial < 0) {
    return json({ ok: false, reason: 'bad_offer', message: 'The offer the page showed was not sent.' }, 400);
  }
  const promo = /^[A-Z0-9_.-]{1,64}$/.test(String(body.promo_code || '')) ? String(body.promo_code) : null;
  const ref = /^EDS-[A-Z0-9]{6}$/.test(String(body.ref || '')) ? String(body.ref) : makeRef();

  const db = makeDb(c.url, c.serviceKey);
  const stripe = makeStripe(c.stripeKey, fetch, { timeoutMs: 8000, retries: 1 });
  const ctx = { db, stripe, svc: 'create_checkout_session' };
  const trace = { user_id: user.id, ref, kind, promo: !!promo };

  try {
    const adm = await db.rpc('billing_sync_admit', { p_user: user.id, p_source: 'checkout', p_max: 10, p_window_s: 600, p_ref: ref });
    if (!adm || !adm.admitted) {
      return json({ ok: false, reason: 'rate_limited', retry_after_s: adm && adm.retry_after_s,
        message: 'Too many checkout attempts. Wait a minute and try again.' }, 429);
    }
  } catch (e) {
    logLine('create_checkout_session', 'error', 'checkout.schema_missing', Object.assign({ error: String(e.message || e) }, trace));
    return json({ ok: false, reason: 'not_configured', fallback_ok: true, message: 'Billing is being updated.' }, 503);
  }

  // ── 1. NOT A SECOND SUBSCRIPTION ──────────────────────────────────────────
  // Ask Stripe, not just the row: a checkout finished a minute ago whose webhook
  // has not landed yet must not be sold again. This also repairs the row.
  const rec = await reconcileUser(ctx, user, { source: 'checkout', discover: true, ref });
  if (rec.access && rec.access.has_access) {
    logLine('create_checkout_session', 'info', 'checkout.already_entitled', Object.assign({ outcome: rec.outcome }, trace));
    return json({ ok: false, reason: 'already_entitled', ref, access: rec.access,
      message: 'This account already has EdgeDesk access — there is nothing to pay for.' }, 409);
  }
  if (c.oneTrial && ((rec.stripe && rec.stripe.length) || (rec.access && rec.access.stripe_backed))) {
    return json({ ok: false, reason: 'trial_used', ref,
      message: 'This account has already had a free trial. Email support@edgedesksports.com to restart your subscription.' }, 409);
  }

  // ── 2. THE PRICE IS THE ONE THE CUSTOMER CONSENTED TO ─────────────────────
  let price;
  try { price = await readPrice(stripe, c.priceId); }
  catch (e) {
    logLine('create_checkout_session', 'error', 'checkout.price_unreadable', Object.assign({ error: String(e.message || e) }, trace));
    return json({ ok: false, reason: 'stripe_unavailable', ref, message: 'Stripe could not be reached. Nothing was charged; try again.' }, 502);
  }
  const problem = offerProblem(price, wantCents, wantTrial, c.trialDays);
  if (problem) {
    logLine('create_checkout_session', 'error', 'checkout.offer_mismatch', Object.assign({ problem, price_id: c.priceId }, trace));
    return json({ ok: false, reason: 'offer_mismatch', ref,
      message: 'Checkout is being updated, so we stopped before taking any payment. Nothing has been charged.' }, 409);
  }

  // ── 3. AN OPEN SESSION FOR THE SAME OFFER IS REUSED ───────────────────────
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const open = await db.get('billing_checkout_sessions?select=id,url,price_id,trial_days,kind&user_id=eq.' + user.id +
      '&status=eq.open&created_at=gt.' + encodeURIComponent(since) + '&order=created_at.desc&limit=3');
    for (const s of open || []) {
      if (s.price_id !== c.priceId || Number(s.trial_days) !== c.trialDays || s.kind !== kind) continue;
      const live = await stripe.get('/checkout/sessions/' + encodeURIComponent(s.id)).catch(() => null);
      if (live && live.status === 'open' && live.url) {
        logLine('create_checkout_session', 'info', 'checkout.reused', Object.assign({ session_id: s.id }, trace));
        return json({ ok: true, url: live.url, session_id: s.id, reused: true, ref });
      }
      if (live && (live.status === 'complete' || live.status === 'expired')) {
        await db.patch('billing_checkout_sessions', 'id=eq.' + encodeURIComponent(s.id),
          { status: live.status, completed_at: live.status === 'complete' ? new Date().toISOString() : null }).catch(() => null);
      }
    }
  } catch (_) { /* reuse is a nicety; a new session is still correct */ }

  // ── 4. THE CUSTOMER, BEFORE THE PAYMENT ───────────────────────────────────
  let customer;
  try {
    customer = await pickCustomer(c, ctx, user, rec.customers || []);
    await db.rpc('billing_link_customer', { p_customer_id: customer.id, p_user: user.id,
      p_source: 'checkout_session', p_livemode: c.stripeKey.indexOf('_live_') > 0, p_email: user.email });
  } catch (e) {
    logLine('create_checkout_session', 'error', 'checkout.customer_failed', Object.assign({ error: String(e.message || e) }, trace));
    return json({ ok: false, reason: 'stripe_unavailable', ref, message: 'Stripe could not be reached. Nothing was charged; try again.' }, 502);
  }
  trace.customer_id = customer.id;

  // ── 5. THE SESSION ────────────────────────────────────────────────────────
  let discounts = null;
  if (promo) {
    try {
      const pc = await stripe.get('/promotion_codes', { code: promo, active: 'true', limit: 1 });
      const hit = pc && pc.data && pc.data[0];
      if (hit && hit.id) discounts = [{ promotion_code: hit.id }];
    } catch (_) { /* the customer can still type it on Stripe's page */ }
  }
  const params = {
    mode: 'subscription',
    customer: customer.id,
    client_reference_id: user.id,
    line_items: [{ price: c.priceId, quantity: 1 }],
    metadata: { supabase_user_id: user.id, kind },
    subscription_data: {
      metadata: { supabase_user_id: user.id },
      trial_period_days: kind === 'trial' && c.trialDays > 0 ? c.trialDays : undefined,
    },
    // a card is held for the trial — the consent text says so
    payment_method_collection: 'always',
    success_url: c.siteUrl + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: c.siteUrl + '/?checkout=cancel',
  };
  if (discounts) params.discounts = discounts; else params.allow_promotion_codes = 'true';
  if (c.automaticTax) { params.automatic_tax = { enabled: 'true' }; params.customer_update = { address: 'auto' }; }

  let session;
  try {
    // Identical requests inside ten seconds are one session (a double click
    // that beat the reuse check above).
    const idem = ['edgedesk-cs', user.id, c.priceId, c.trialDays, promo || '-', Math.floor(Date.now() / 10000)].join('-');
    session = await stripe.post('/checkout/sessions', params, idem);
  } catch (e) {
    logLine('create_checkout_session', 'error', 'checkout.create_failed',
      Object.assign({ error: String(e.message || e), stripe_code: e && e.code }, trace));
    return json({ ok: false, reason: 'stripe_unavailable', ref, message: 'Stripe could not start checkout. Nothing was charged; try again.' }, 502);
  }

  try {
    await db.upsert('billing_checkout_sessions', [{
      id: session.id, user_id: user.id, stripe_customer_id: customer.id, kind, price_id: c.priceId,
      trial_days: c.trialDays, status: 'open', url: session.url, livemode: session.livemode !== false, ref,
      expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    }], 'id');
  } catch (e) {
    // The session carries the account id three ways; a missing record of it
    // here costs reuse and diagnostics, never the customer's access.
    logLine('create_checkout_session', 'warn', 'checkout.record_failed', Object.assign({ error: String(e.message || e), session_id: session.id }, trace));
  }

  logLine('create_checkout_session', 'info', 'checkout.created', Object.assign({
    session_id: session.id, price_id: c.priceId, trial_days: c.trialDays, customer_created: customer.created,
    livemode: session.livemode !== false }, trace));
  return json({ ok: true, url: session.url, session_id: session.id, reused: false, ref });
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(handle);

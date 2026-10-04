// ============================================================
//  FILE:    supabase/functions/sync_subscription/index.ts
//  TYPE:    Edge Function (deployed) - reconcile billing with Stripe
//  DEPLOY:  supabase functions deploy sync_subscription --no-verify-jwt
//           Every reader action verifies the caller's token against Supabase
//           Auth here; the scheduled sweep is a debounced poke that takes no
//           identity at all (pg_cron sends no JWT — research_cron's shape).
//  IMPORTS: NONE. One file; the billing core is copied in between its markers
//           by tools/billing/inline_core.js (edit tools/billing/billing_core.js).
//
//  SECRETS:
//    STRIPE_SECRET_KEY       READ on Customers, Subscriptions, Checkout Sessions
//    SB_URL / SB_SERVICE_ROLE (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
//    SUPABASE_ANON_KEY       provided by Supabase; used to ask Auth who a token
//                            belongs to, and to run operator checks AS the caller
// ============================================================
//
// WEBHOOKS ALONE ARE NOT ENOUGH. A delivery can fail, arrive without the one id
// that names the account, or arrive while the database is down — and before
// this existed nothing ever asked Stripe again: the only repair was a row typed
// in by hand. This function asks Stripe directly and writes what it says.
//
//   POST {}                         (signed in) reconcile MY account. The account
//   POST {source:'checkout_return',  is taken from the token and nothing else;
//         session_id:'cs_...'}      a body naming another account is ignored.
//                                   Rate-limited per account. Returns the
//                                   normalised access decision and a support
//                                   reference (EDS-XXXXXX) for the attempt.
//   POST {action:'sweep'}           (anyone; pg_cron) at most once per nine
//                                   minutes: resolve recent unresolved
//                                   deliveries and re-check accounts whose row
//                                   may be behind Stripe. Answers counts only.
//   POST {action:'admin_inspect', query}            operator only: the database
//   POST {action:'admin_sync', user_id}             report, plus what Stripe says
//   POST {action:'admin_link', user_id, customer_id} live, the mismatch, a repair,
//                                                   and the one manual link.
//   GET                             health: build and what is configured.

const BUILD = 'sync_subscription-2026-10-04-1';

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
    url: (env('SB_URL') || env('SUPABASE_URL')).replace(/\/+$/, ''),
    serviceKey: env('SB_SERVICE_ROLE') || env('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: env('SUPABASE_ANON_KEY') || env('SB_ANON_KEY'),
    stripeKey: env('STRIPE_SECRET_KEY'),
    selfMax: Number(env('BILLING_SYNC_SELF_MAX') || '12'),
    returnMax: Number(env('BILLING_SYNC_RETURN_MAX') || '20'),
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

async function getUser(c, req) {
  const authz = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  try {
    const r = await fetchWithTimeout(fetch, c.url + '/auth/v1/user',
      { headers: { apikey: c.anonKey, authorization: authz } }, 6000);
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id)) return null;
    return { id: u.id.toLowerCase(), email: u.email || null, email_confirmed: !!(u.email_confirmed_at || u.confirmed_at), authz };
  } catch (_) { return null; }
}

// An RPC run AS THE CALLER, so the database's own operator check decides.
async function rpcAsCaller(c, authz, fn, args) {
  const r = await fetchWithTimeout(fetch, c.url + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: { apikey: c.anonKey, authorization: authz, 'content-type': 'application/json' },
    body: JSON.stringify(args || {}) }, 8000);
  const text = await r.text();
  if (!r.ok) { const e = new Error('rpc ' + fn + ' ' + r.status); e.status = r.status; e.body = text.slice(0, 200); throw e; }
  return text ? JSON.parse(text) : null;
}

// An account by id, with its email, from the Auth admin API (service role).
async function adminUser(c, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const r = await fetchWithTimeout(fetch, c.url + '/auth/v1/admin/users/' + encodeURIComponent(id), {
    headers: { apikey: c.serviceKey, authorization: 'Bearer ' + c.serviceKey } }, 6000);
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  const v = u && (u.user || u);
  if (!v || !v.id) return null;
  return { id: String(v.id).toLowerCase(), email: v.email || null, email_confirmed: !!(v.email_confirmed_at || v.confirmed_at) };
}

// The access decision a reader is shown: what they need, nothing about anybody else.
function publicAccess(a) {
  if (!a) return null;
  const s = a.subscription || {};
  return { has_access: !!a.has_access, reason: a.reason || null, offer: a.offer || null,
           status: s.status || null, current_period_end: s.current_period_end || null,
           cancel_at_period_end: !!s.cancel_at_period_end, is_comp: !!a.is_comp, is_comp_trial: !!a.is_comp_trial };
}

// ── a reader's own account ──────────────────────────────────────────────────
async function syncSelf(c, req, body) {
  const user = await getUser(c, req);
  if (!user) return json({ ok: false, reason: 'sign_in_required', message: 'Sign in to refresh your access.' }, 401);
  const source = body.source === 'checkout_return' ? 'checkout_return' : 'self';
  const ref = /^EDS-[A-Z0-9]{6}$/.test(String(body.ref || '')) ? String(body.ref) : makeRef();
  const db = makeDb(c.url, c.serviceKey);
  const stripe = makeStripe(c.stripeKey, fetch, { timeoutMs: 8000, retries: 1 });
  const ctx = { db, stripe, svc: 'sync_subscription' };

  let adm;
  try {
    adm = await db.rpc('billing_sync_admit', { p_user: user.id, p_source: source,
      p_max: source === 'checkout_return' ? c.returnMax : c.selfMax, p_window_s: 600, p_ref: ref });
  } catch (e) {
    logLine('sync_subscription', 'error', 'sync.schema_missing', { user_id: user.id, error: String(e.message || e) });
    return json({ ok: false, reason: 'unavailable', ref, message: 'Billing is being updated. Try again in a minute.' }, 503);
  }
  if (!adm || !adm.admitted) {
    let access = null;
    try { access = await db.rpc('billing_access_for', { p_user: user.id }); } catch (_) { /* fine */ }
    return json({ ok: false, reason: 'rate_limited', ref, retry_after_s: adm && adm.retry_after_s,
      access: publicAccess(access), message: 'Checked recently. Try again in a minute.' }, 429);
  }

  // The success URL's session id is a strong lead — but only if that session
  // is THIS account's. Somebody else's session id names nothing here.
  const extra = [];
  const sid = String(body.session_id || '');
  if (stripe && /^cs_(live|test)_[A-Za-z0-9]+$/.test(sid)) {
    try {
      const s = await stripe.get('/checkout/sessions/' + encodeURIComponent(sid));
      const owner = String((s && (s.client_reference_id || (s.metadata && s.metadata.supabase_user_id))) || '').toLowerCase();
      const cust = s && idOf(s.customer);
      if (owner === user.id && cust) {
        const linked = await db.rpc('billing_link_customer', { p_customer_id: cust, p_user: user.id,
          p_source: 'checkout_return_session', p_livemode: s.livemode !== false, p_email: null });
        if (linked !== 'conflict') extra.push(cust);
        await db.patch('billing_checkout_sessions', 'id=eq.' + encodeURIComponent(sid),
          { status: s.status || 'complete', completed_at: s.status === 'complete' ? new Date().toISOString() : null,
            subscription_id: idOf(s.subscription) }).catch(() => null);
      }
    } catch (_) { /* the ordinary discovery below still runs */ }
  }

  const r = await reconcileUser(ctx, user, { source, discover: true, extraCustomers: extra, ref });
  const access = publicAccess(r.access);
  const status = r.ok ? 200 : (r.outcome === 'not_configured' ? 503 : 502);
  return json({ ok: r.ok, ref: r.ref, outcome: r.outcome, has_access: !!(access && access.has_access), access,
    message: access && access.has_access ? 'Access confirmed.'
      : (r.ok ? 'Stripe has no active subscription or trial for this account yet.'
              : 'Stripe could not be reached to confirm your access. Nothing is lost; try again shortly.') }, status);
}

// ── the schedule ────────────────────────────────────────────────────────────
async function sweep(c) {
  const db = makeDb(c.url, c.serviceKey);
  const stripe = makeStripe(c.stripeKey, fetch, { timeoutMs: 7000, retries: 1 });
  if (!stripe) return json({ ok: false, reason: 'not_configured' }, 503);
  let admitted = false;
  try { admitted = await db.rpc('billing_sweep_admit', { p_min_interval_s: 540 }); }
  catch (e) { return json({ ok: false, reason: 'unavailable' }, 503); }
  if (!admitted) return json({ ok: true, skipped: 'ran recently' });

  const ctx = { db, stripe, svc: 'sync_subscription' };
  const deadline = Date.now() + 40000;
  const out = { events_seen: 0, events_resolved: 0, accounts_checked: 0, repaired: 0, revoked: 0, errors: 0 };
  const done = {};

  // 1. deliveries nobody could name: ask Stripe who the customer is
  let evs = [];
  try { evs = await db.rpc('billing_unresolved_events', { p_limit: 15 }) || []; } catch (_) { out.errors++; }
  for (const e of evs) {
    if (Date.now() > deadline) break;
    out.events_seen++;
    try {
      const cust = await stripe.get('/customers/' + encodeURIComponent(e.customer_id));
      if (!cust || cust.deleted) continue;
      const who = await db.rpc('billing_resolve_user', { p_metadata_user: metadataUserId(cust), p_client_reference: null,
        p_customer_id: e.customer_id, p_subscription_id: null, p_session_id: null, p_email: cust.email || e.email });
      if (!who || !who.user_id) continue;
      const link = await db.rpc('billing_link_customer', { p_customer_id: e.customer_id, p_user: who.user_id,
        p_source: 'sweep: ' + who.how, p_livemode: cust.livemode !== false, p_email: cust.email || null });
      if (link === 'conflict') continue;
      out.events_resolved++;
      if (!done[who.user_id]) {
        done[who.user_id] = true;
        const u = (await adminUser(c, who.user_id)) || { id: who.user_id, email: null, email_confirmed: false };
        const r = await reconcileUser(ctx, u, { source: 'cron', discover: false, extraCustomers: [e.customer_id] });
        out.accounts_checked++;
        if (r.outcome === 'repaired') out.repaired++;
        if (r.outcome === 'revoked') out.revoked++;
        if (!r.ok) out.errors++;
      }
    } catch (_) { out.errors++; }
  }

  // 2. accounts whose row may be behind Stripe
  let cands = [];
  try { cands = await db.rpc('billing_sweep_candidates', { p_limit: 25 }) || []; } catch (_) { out.errors++; }
  for (const cand of cands) {
    if (Date.now() > deadline) break;
    if (done[cand.user_id]) continue;
    done[cand.user_id] = true;
    try {
      const u = (await adminUser(c, cand.user_id)) || { id: cand.user_id, email: null, email_confirmed: false };
      const r = await reconcileUser(ctx, u, { source: 'cron', discover: cand.why === 'recent_checkout_without_access' ||
        cand.why === 'open_checkout_session' || cand.why === 'no_status' });
      out.accounts_checked++;
      if (r.outcome === 'repaired') out.repaired++;
      if (r.outcome === 'revoked') out.revoked++;
      if (!r.ok) out.errors++;
    } catch (_) { out.errors++; }
  }

  await db.patch('billing_sweep_state', 'id=eq.1', { last_result: Object.assign({ at: new Date().toISOString() }, out) }).catch(() => null);
  logLine('sync_subscription', out.errors ? 'warn' : 'info', 'sweep.done', out);
  return json(Object.assign({ ok: true }, out));
}

// ── the operator ────────────────────────────────────────────────────────────
async function admin(c, req, body) {
  const caller = await getUser(c, req);
  if (!caller) return json({ ok: false, reason: 'sign_in_required' }, 401);
  let isAdmin = false;
  try { isAdmin = await rpcAsCaller(c, caller.authz, 'billing_is_admin', {}); } catch (_) { isAdmin = false; }
  if (isAdmin !== true) {
    logLine('sync_subscription', 'warn', 'admin.refused', { user_id: caller.id, action: body.action });
    return json({ ok: false, reason: 'forbidden' }, 403);
  }
  const db = makeDb(c.url, c.serviceKey);
  const stripe = makeStripe(c.stripeKey, fetch, { timeoutMs: 8000, retries: 1 });
  const ctx = { db, stripe, svc: 'sync_subscription' };

  if (body.action === 'admin_link') {
    const uid = String(body.user_id || '').toLowerCase(), cus = String(body.customer_id || '');
    if (!UUID_RE.test(uid) || !/^cus_[A-Za-z0-9]+$/.test(cus)) return json({ ok: false, reason: 'bad_input' }, 400);
    let link;
    try { link = await rpcAsCaller(c, caller.authz, 'billing_admin_link_customer', { p_user: uid, p_customer_id: cus }); }
    catch (e) { return json({ ok: false, reason: 'link_failed', detail: e.body || String(e.message || e) }, 400); }
    if (link === 'conflict') return json({ ok: false, reason: 'conflict', message: 'That customer is already linked to another account.' }, 409);
    body = { action: 'admin_sync', user_id: uid, link };
  }

  if (body.action === 'admin_sync') {
    const u = await adminUser(c, body.user_id);
    if (!u) return json({ ok: false, reason: 'no_such_user' }, 404);
    const r = await reconcileUser(ctx, u, { source: 'admin', discover: true });
    logLine('sync_subscription', 'info', 'admin.sync', { admin_id: caller.id, user_id: u.id, outcome: r.outcome });
    let report = null;
    try { report = await rpcAsCaller(c, caller.authz, 'billing_admin_lookup', { p_query: u.id }); } catch (_) { /* fine */ }
    return json({ ok: r.ok, outcome: r.outcome, ref: r.ref, note: r.note || null, link: body.link || null,
      stripe: r.stripe || [], report: report && report[0] || null });
  }

  if (body.action === 'admin_inspect') {
    let reports = [];
    try { reports = await rpcAsCaller(c, caller.authz, 'billing_admin_lookup', { p_query: String(body.query || '') }) || []; }
    catch (e) { return json({ ok: false, reason: 'lookup_failed', detail: e.body || String(e.message || e) }, 400); }
    const outReports = [];
    for (const rep of reports.slice(0, 5)) {
      const u = rep && rep.user;
      if (!u) continue;
      const live = await reconcileUser(ctx, { id: u.id, email: u.email, email_confirmed: !!u.email_confirmed },
        { source: 'admin', discover: true, dryRun: true });
      const row = rep.row || {};
      const best = live.best;
      const mismatch = [];
      if (live.ok && best) {
        const stripeEnt = grantsAccess(best, Date.now());
        const dbEnt = !!(rep.access && rep.access.has_access);
        if (stripeEnt && !dbEnt) mismatch.push('Stripe says ' + best.status + ' but EdgeDesk denies access');
        if (!stripeEnt && dbEnt && row.stripe_subscription_id) mismatch.push('EdgeDesk grants access but Stripe says ' + best.status);
        if (row.status && row.status !== best.status && row.stripe_subscription_id === best.id) mismatch.push('status differs: db ' + row.status + ', Stripe ' + best.status);
        if (row.stripe_subscription_id && row.stripe_subscription_id !== best.id) mismatch.push('row describes ' + row.stripe_subscription_id + ', best live subscription is ' + best.id);
        if (live.duplicates > 1) mismatch.push(live.duplicates + ' live subscriptions (duplicate purchase)');
      } else if (live.ok && !best && rep.access && rep.access.has_access && row.stripe_subscription_id) {
        mismatch.push('EdgeDesk grants access but Stripe has no subscription for this account');
      } else if (!live.ok) {
        mismatch.push('Stripe could not be asked: ' + (live.note || live.outcome));
      }
      outReports.push(Object.assign({}, rep, { stripe_live: { ok: live.ok, outcome: live.outcome, best,
        subscriptions: live.stripe || [], customers: live.customers || [], duplicates: live.duplicates },
        stripe_mismatches: mismatch }));
    }
    logLine('sync_subscription', 'info', 'admin.inspect', { admin_id: caller.id, matches: outReports.length });
    return json({ ok: true, reports: outReports });
  }

  return json({ ok: false, reason: 'unknown_action' }, 400);
}

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const c = config();
  if (req.method === 'GET') {
    return json({ ok: true, service: 'sync_subscription', core: CORE_VERSION,
      configured: { stripe_key: !!c.stripeKey, database: !!(c.url && c.serviceKey), auth: !!c.anonKey } });
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);
  if (!c.url || !c.serviceKey || !c.anonKey) return json({ ok: false, reason: 'not_configured' }, 503);
  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  try {
    if (body.action === 'sweep') return await sweep(c);
    if (typeof body.action === 'string' && body.action.indexOf('admin_') === 0) return await admin(c, req, body);
    return await syncSelf(c, req, body);
  } catch (e) {
    logLine('sync_subscription', 'error', 'sync.failed', { action: body.action || 'self', error: String((e && e.message) || e) });
    return json({ ok: false, reason: 'failed', message: 'Something went wrong confirming access. Nothing is lost; try again.' }, 500);
  }
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(handle);

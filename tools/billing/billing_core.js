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

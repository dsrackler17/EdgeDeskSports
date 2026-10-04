/* ===========================================================================
   EdgeDesk access — the ONE client-side door to "may this account use the
   terminal?", and to the two server functions that change the answer.

   THE DECISION IS THE DATABASE'S. read() asks public.my_billing_access()
   (supabase/billing_hardening.sql), which applies public.billing_row_grants_access()
   — the same rule every database gate applies. Neither page interprets a Stripe
   status itself any more; index.html used to treat an EXPIRED trial as paid while
   app.html locked it, and an expired comp_trial account bounced between the two
   and could not buy at all.

   grants() is the same rule in JavaScript, used ONLY when the database function
   is not installed yet (the deploy window), and held equal to the SQL by
   tools/billing/billing_hardening_sql.test.js.

   NOTHING HERE GRANTS ACCESS FROM THE BROWSER. A redirect back from Stripe is not
   proof of payment; finalize() only ever asks the server, which asks Stripe.

     read(cfg)                 -> {ok, access} | {ok:false, reason}
     sync(cfg, opts)           -> POST functions/v1/sync_subscription
     startCheckout(cfg, offer) -> POST functions/v1/create_checkout_session
     finalize(cfg, opts)       -> bounded retry after checkout; never loops forever

   cfg = { url, key, token }   token: a string, or a function returning one
                               (or a promise of one), so a refreshed session is
                               picked up between attempts.

   Browser: window.EDAccess. Node: require('./edgedesk_access.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDAccess = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = {};
  X.COMP_PRICE_IDS = ['owner_comp'];
  X.PAST_DUE_GRACE_DAYS = 21;
  X.SUB_COLS = 'status,price_id,current_period_end,cancel_at_period_end,stripe_customer_id';

  /* the rule, mirrored (see the header) */
  X.grants = function (row, nowMs) {
    if (!row) return false;
    var now = nowMs == null ? Date.now() : nowMs;
    if (row.status === 'active' && X.COMP_PRICE_IDS.indexOf(String(row.price_id || '')) >= 0) return true;
    var pe = row.current_period_end == null ? null : new Date(row.current_period_end).getTime();
    if (pe != null && !isFinite(pe)) pe = null;
    if (row.status === 'active' || row.status === 'trialing') return pe == null || pe >= now;
    if (row.status === 'past_due') return pe == null || (now - pe) < X.PAST_DUE_GRACE_DAYS * 864e5;
    return false;
  };
  /* what a locked row should be offered, mirroring billing_access_for() */
  X.offerFor = function (row) {
    if (!row) return 'trial';
    if (X.grants(row)) return 'none';
    if (row.stripe_customer_id && (row.status === 'past_due' || row.status === 'unpaid')) return 'fix_payment';
    if (!row.stripe_customer_id) return 'trial';
    return 'resubscribe';
  };

  X.makeRef = function () {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = 'EDS-', b = null;
    try { if (typeof crypto !== 'undefined' && crypto.getRandomValues) { b = new Uint8Array(6); crypto.getRandomValues(b); } } catch (_) { b = null; }
    for (var i = 0; i < 6; i++) s += A.charAt((b ? b[i] : Math.floor(Math.random() * 256)) % A.length);
    return s;
  };

  function f(cfg) { return cfg.fetch || (typeof fetch !== 'undefined' ? fetch : null); }
  function base(cfg) { return String(cfg.url || '').replace(/\/+$/, ''); }
  async function tokenOf(cfg) {
    var t = typeof cfg.token === 'function' ? cfg.token() : cfg.token;
    t = await t;
    return t || null;
  }
  async function jsonOf(r) { try { return await r.json(); } catch (_) { return null; } }

  /* The access decision for the signed-in account.
     reason on failure: 'signed_out' (no token / token refused — never a lockout
     on its own), 'unavailable' (network or server), never a guess. */
  X.read = async function (cfg) {
    var t = await tokenOf(cfg);
    if (!t) return { ok: false, reason: 'signed_out' };
    var H = { apikey: cfg.key, authorization: 'Bearer ' + t, 'content-type': 'application/json' };
    var r;
    try { r = await f(cfg)(base(cfg) + '/rest/v1/rpc/my_billing_access', { method: 'POST', headers: H, body: '{}' }); }
    catch (_) { return { ok: false, reason: 'unavailable' }; }
    if (r.ok) {
      var a = await jsonOf(r);
      if (a && typeof a === 'object' && 'has_access' in a) {
        if (a.signed_in === false) return { ok: false, reason: 'signed_out' };
        return { ok: true, access: a, source: 'database' };
      }
      return { ok: false, reason: 'unavailable' };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'signed_out', status: r.status };
    if (r.status !== 404) return { ok: false, reason: 'unavailable', status: r.status };
    /* 404: billing_hardening.sql is not installed yet. Read the row the old way
       and apply the same rule here, so the deploy window behaves exactly like
       the finished system. */
    try {
      var r2 = await f(cfg)(base(cfg) + '/rest/v1/subscriptions?select=' + X.SUB_COLS + '&limit=1', { headers: H });
      if (r2.status === 401 || r2.status === 403) return { ok: false, reason: 'signed_out', status: r2.status };
      if (!r2.ok) return { ok: false, reason: 'unavailable', status: r2.status };
      var rows = await jsonOf(r2);
      var row = (rows && rows[0]) || null;
      var has = X.grants(row);
      return { ok: true, source: 'row', access: {
        signed_in: true, has_access: has, row_exists: !!row, offer: X.offerFor(row),
        reason: !row ? 'no_subscription' : (has ? row.status : (row.status || 'no_status')),
        is_comp: !!(row && row.status === 'active' && X.COMP_PRICE_IDS.indexOf(String(row.price_id || '')) >= 0),
        is_comp_trial: !!(row && row.price_id === 'comp_trial'),
        should_sync: false, subscription: row } };
    } catch (_) { return { ok: false, reason: 'unavailable' }; }
  };

  async function callFn(cfg, name, body) {
    var t = await tokenOf(cfg);
    if (!t) return { ok: false, status: 401, reason: 'signed_out', body: null };
    var r;
    try {
      r = await f(cfg)(base(cfg) + '/functions/v1/' + name, { method: 'POST',
        headers: { apikey: cfg.key, authorization: 'Bearer ' + t, 'content-type': 'application/json' },
        body: JSON.stringify(body || {}) });
    } catch (_) { return { ok: false, status: 0, reason: 'unavailable', body: null }; }
    var j = await jsonOf(r);
    return { ok: r.ok && !!(j && j.ok), status: r.status, reason: (j && j.reason) || (r.ok ? null : 'http_' + r.status), body: j };
  }

  /* Ask the server to reconcile THIS account with Stripe. The account is taken
     from the token; nothing in the body can name another one. */
  X.sync = function (cfg, opts) {
    var o = opts || {};
    return callFn(cfg, 'sync_subscription', { source: o.source || 'self', session_id: o.sessionId || undefined, ref: o.ref || undefined });
  };

  /* Start a server-created Stripe Checkout. Returns
       {ok:true, url}                      go there
       {ok:false, reason:'already_entitled'} nothing to buy
       {ok:false, fallbackOk:true}         the function is not deployed or not
                                           configured: nothing was created, and the
                                           Payment Link may be used instead
       {ok:false, message}                 stop; nothing was charged */
  X.startCheckout = async function (cfg, offer) {
    var r = await callFn(cfg, 'create_checkout_session', offer || {});
    var b = r.body || {};
    if (r.ok && b.url) return { ok: true, url: b.url, sessionId: b.session_id, reused: !!b.reused, ref: b.ref || null };
    var notThere = r.status === 404 || r.status === 0 || (r.status >= 500 && b.fallback_ok === true) ||
                   (r.status === 503 && b.reason === 'not_configured');
    return { ok: false, reason: b.reason || r.reason, status: r.status, fallbackOk: notThere,
             message: b.message || null, ref: b.ref || null };
  };

  /* AFTER CHECKOUT. Stripe has redirected back; that proves nothing. Read the
     decision, and ask the server to reconcile with Stripe, with growing gaps —
     a bounded number of times, then stop and say so. Never an infinite loop,
     and never a reason to send the customer to buy again.
       opts: { sessionId, ref, delays:[ms…], onProgress(i, n), sleep(ms) }
       -> { state: 'active'|'pending'|'signed_out', access, ref } */
  X.FINALIZE_DELAYS = [0, 1500, 2500, 4000, 6000, 9000, 12000];
  X.finalize = async function (cfg, opts) {
    var o = opts || {};
    var ref = o.ref || X.makeRef();
    var delays = o.delays || X.FINALIZE_DELAYS;
    var sleep = o.sleep || function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };
    var last = null;
    for (var i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      if (o.onProgress) { try { o.onProgress(i + 1, delays.length); } catch (_) { /* cosmetic */ } }
      var a = await X.read(cfg);
      if (a.ok) { last = a.access; if (a.access.has_access) return { state: 'active', access: a.access, ref: ref }; }
      else if (a.reason === 'signed_out') return { state: 'signed_out', ref: ref };
      /* the first attempt, then every other one: ask Stripe through the server */
      if (i === 0 || i % 2 === 1) {
        var s = await X.sync(cfg, { source: 'checkout_return', sessionId: o.sessionId, ref: ref });
        if (s.body && s.body.access) last = s.body.access;
        if (s.body && s.body.has_access) return { state: 'active', access: s.body.access, ref: ref };
        if (s.status === 401) return { state: 'signed_out', ref: ref };
      }
    }
    return { state: 'pending', access: last, ref: ref };
  };

  return X;
});

/* ===========================================================================
   EdgeDesk through Juice Reel — the browser's one door to the juicereel_billing
   function (supabase/functions/juicereel_billing, docs/juicereel-billing.md).

   NOTHING HERE GRANTS ACCESS. A return from Juice Reel is not proof of payment:
   complete() hands the return's code and state to the server, which exchanges
   the code itself and asks Juice Reel. The page then reads the same answer
   every other gate reads (public.my_billing_access).

     health(url)              -> GET, no sign-in: {mode, ready} (is it live?)
     status(cfg)              -> {ok, mode, available, linked, display_name,
                                  juicereel, access}
     start(cfg, kind)         -> {ok, url} | {ok:false, reason, message, ref}
                                 kind: 'checkout' (buy) | 'link' (bought on Juice
                                 Reel already)
     go(url)                  -> navigates ONLY to https://(www.)juicereel.com/…
     takeReturn()             -> the return oauth/juicereel-subscribe.html left in
                                 this tab ({state, code, error}), removed as it is
                                 read; null when there is none or it is stale
     complete(cfg, ret)       -> the server's answer: outcome active | pending |
                                 cancelled | not_subscribed, or a refusal
     isJuiceReelRow(sub)      -> the subscriptions row was written from Juice Reel

   cfg = { url, key, token }  token: a string, or a function returning one (or a
                              promise of one), as lib/edgedesk_access.js takes.

   Browser: window.EDJuiceReel. Node: require('./edgedesk_juicereel_billing.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDJuiceReel = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = {};
  X.HANDOFF_KEY = 'edgedesk.jr.subscribe';
  X.HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;
  X.PRICE_ID = 'juicereel';
  X.HOST_RE = /^https:\/\/(www\.)?juicereel\.com\//;

  function fnUrl(base) { return String(base || '').replace(/\/+$/, '') + '/functions/v1/juicereel_billing'; }
  function tokenOf(cfg) {
    var t = cfg && cfg.token;
    return Promise.resolve(typeof t === 'function' ? t() : t).catch(function () { return null; });
  }
  function post(cfg, body) {
    return tokenOf(cfg).then(function (tok) {
      if (!tok) return { status: 401, body: { ok: false, reason: 'signed_out', message: 'Sign in to EdgeDesk first.' } };
      return fetch(fnUrl(cfg.url), { method: 'POST', headers: { apikey: cfg.key, authorization: 'Bearer ' + tok,
        'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, body: b }; }); });
    }).catch(function () {
      return { status: 0, body: { ok: false, reason: 'network', message: 'Could not reach EdgeDesk. Check your connection and try again.' } };
    });
  }

  X.health = function (url) {
    return fetch(fnUrl(url), { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) { return b && typeof b === 'object' ? { mode: b.mode, ready: !!b.ready } : null; })
      .catch(function () { return null; });
  };
  X.live = function (h) { return !!(h && h.mode === 'on' && h.ready); };

  X.status = function (cfg) {
    return post(cfg, { action: 'status' }).then(function (r) {
      var b = r.body || {};
      return r.status === 200 && b.ok ? b : { ok: false, available: false, reason: b.reason || 'unavailable' };
    });
  };

  X.start = function (cfg, kind) {
    return post(cfg, { action: 'start', kind: kind === 'link' ? 'link' : 'checkout' }).then(function (r) {
      var b = r.body || {};
      if (r.status === 200 && b.ok && typeof b.url === 'string' && (X.HOST_RE.test(b.url))) return { ok: true, url: b.url, kind: b.kind };
      return { ok: false, status: r.status, reason: b.reason || 'error', ref: b.ref || null,
        message: b.message || 'Juice Reel checkout could not be started. Nothing was charged.' };
    });
  };

  /* never a navigation anywhere but Juice Reel */
  X.go = function (url, loc) {
    if (typeof url !== 'string' || !X.HOST_RE.test(url)) return false;
    (loc || (typeof window !== 'undefined' ? window.location : null)).assign(url);
    return true;
  };

  X.takeReturn = function (store) {
    var s = store || (typeof window !== 'undefined' ? window.sessionStorage : null);
    var raw = null;
    try { raw = s && s.getItem(X.HANDOFF_KEY); if (raw) s.removeItem(X.HANDOFF_KEY); } catch (_) { raw = null; }
    if (!raw) return null;
    var v = null;
    try { v = JSON.parse(raw); } catch (_) { return null; }
    if (!v || typeof v.state !== 'string' || !(Date.now() - Number(v.at) < X.HANDOFF_MAX_AGE_MS)) return null;
    return { state: v.state, code: typeof v.code === 'string' ? v.code : null, error: typeof v.error === 'string' ? v.error : null };
  };
  X.peekReturn = function (store) {
    var s = store || (typeof window !== 'undefined' ? window.sessionStorage : null);
    try { return !!(s && s.getItem(X.HANDOFF_KEY)); } catch (_) { return false; }
  };

  /* One retry, only when the server says the code never reached Juice Reel. */
  X.complete = function (cfg, ret, opts) {
    var wait = (opts && opts.retryMs) != null ? opts.retryMs : 2500;
    var body = { action: 'complete', state: ret && ret.state, code: ret && ret.code };
    if (ret && ret.error) body.error = ret.error;
    return post(cfg, body).then(function (r) {
      if (r.body && r.body.retryable) {
        return new Promise(function (ok) { setTimeout(ok, wait); }).then(function () { return post(cfg, body); });
      }
      return r;
    }).then(function (r) {
      var b = r.body || {};
      b.status = r.status;
      if (b.ok === undefined) b.ok = false;
      return b;
    });
  };

  X.isJuiceReelRow = function (sub) { return !!(sub && String(sub.price_id || '') === X.PRICE_ID); };

  return X;
});

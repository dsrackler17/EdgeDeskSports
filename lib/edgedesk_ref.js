/* ===========================================================================
   EdgeDesk — the creator's code a visitor will check out with.

   ONE RULE, kept in this file only, used by the landing page (index.html loads
   it) and by every other public page (lib/edgedesk_public.js loads it when the
   URL carries ?ref=):

     A page that loads with ?ref=CODE keeps CODE, with the time it was
     clicked, in localStorage — once the server confirms CODE is a live
     creator code (public.affiliate_offer, callable without an account). The
     LAST valid code clicked wins; a code the server does not know never
     replaces one it does. A kept code expires 30 days after its click. The
     checkout sends it as `affiliate_code` and the SERVER decides, again,
     whether it applies (create_checkout_session: the monthly price only, a
     first-time customer only, Connor's own promotion code only).

   This is not the marketing first touch (edgedesk_attribution: 365 days, the
   first code wins), which is unchanged: that answers "who brought this
   visitor first"; this answers "whose discount is the visitor carrying".

   Storage can be missing, full or forbidden (private windows, blocked site
   data). Every access is wrapped; without storage the visitor simply checks
   out without a code.

   Browser: window.EDRef (captures on load). Node: require('./edgedesk_ref.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.EDRef = api;
    if (!root.EDREF_MANUAL) api.capture();
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var KEY = 'edgedesk_checkout_ref';
  var TTL_DAYS = 30, DAY_MS = 864e5;
  var SB_URL = 'https://iattxbkbufslbauoumga.supabase.co';
  /* the public anon key every page already ships (index.html, lib/edgedesk_public.js) */
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';

  /* a creator code, upper-cased, or null (the server's own shape) */
  function code(v) {
    var s = String(v == null ? '' : v).trim().toUpperCase();
    return /^[A-Z0-9_-]{3,32}$/.test(s) ? s : null;
  }
  function store(r) { try { return r && r.localStorage ? r.localStorage : null; } catch (e) { return null; } }
  function nowOf(o) { return o && typeof o.now === 'number' ? o.now : Date.now(); }

  /* The code to check out with, or null. An expired, unreadable or
     impossible one (dated in the future) is removed on the way. */
  function read(opts) {
    var o = opts || {}, s = store(o.root || root), raw = null, v = null;
    try { raw = s ? s.getItem(KEY) : null; } catch (e) { return null; }
    if (!raw) return null;
    try { v = JSON.parse(raw); } catch (e) { v = null; }
    var c = v && code(v.code), at = v ? Number(v.at) : NaN, t = nowOf(o);
    if (!c || !isFinite(at) || at > t + DAY_MS || t - at > TTL_DAYS * DAY_MS) {
      try { s.removeItem(KEY); } catch (e) { /* nothing to clean */ }
      return null;
    }
    return c;
  }

  function write(c, opts) {
    var o = opts || {}, s = store(o.root || root);
    c = code(c);
    if (!c || !s) return false;
    try { s.setItem(KEY, JSON.stringify({ code: c, at: nowOf(o) })); return true; } catch (e) { return false; }
  }

  /* ?ref=CODE on this page's URL (via= and partner= are the same link's
     older spellings), or null */
  function fromUrl(r) {
    try {
      var q = new URLSearchParams(((r || root).location || {}).search || '');
      return code(q.get('ref') || q.get('via') || q.get('partner'));
    } catch (e) { return null; }
  }

  /* On load: ask the server whether the URL's code is live; keep it if so.
     Resolves to the code kept, or null. Never throws, never blocks the page. */
  function capture(opts) {
    var o = opts || {}, r = o.root || root, c = fromUrl(r), clicked = nowOf(o);
    if (!c || typeof r.fetch !== 'function') return Promise.resolve(null);
    var key = o.key || SB_KEY, p;
    try {
      p = r.fetch((o.url || SB_URL) + '/rest/v1/rpc/affiliate_offer', {
        method: 'POST', credentials: 'omit',
        headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ p_code: c })
      });
    } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(p).then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (offer) {
        if (!offer || offer.ok !== true) return null;
        var kept = code(offer.code) || c;
        return write(kept, { root: r, now: clicked }) ? kept : null;
      }, function () { return null; });
  }

  return { KEY: KEY, TTL_DAYS: TTL_DAYS, code: code, read: read, write: write, fromUrl: fromUrl, capture: capture };
}));

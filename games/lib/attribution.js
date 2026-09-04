/* ===========================================================================
   EdgeDesk Games — attribution, into the EXISTING ledger.

   The landing page already runs a first-touch attribution system (`attrCapture`
   in index.html): it writes `edgedesk_attribution` and
   `edgedesk_attribution_last` to localStorage, mirrors a referral code into an
   `ed_ref` cookie at `path=/`, and hands `attrPayload()` to the database when a
   subscription is created. That record is what a partner invoice is reconciled
   against.

   Games therefore does NOT run its own attribution. It writes the SAME keys, in
   the SAME shape, under the SAME credit rule — so a visitor who arrives at
   /games?utm_source=x, plays for three weeks and then subscribes is credited to
   that campaign by the machinery that already exists, with no second ledger to
   reconcile. localStorage is per-origin and the cookie is path=/, so both
   surfaces genuinely share one record.

   THE CREDIT RULE (restated from index.html, not reinvented):
     * credit belongs to the first touch that actually CARRIED a code;
     * an organic visit is recorded as an UPGRADEABLE placeholder and never
       claims the customer;
     * once a code is credited it is FROZEN — a later, different code does not
       take the customer away from whoever created them.

   tools/games/attribution_parity.test.js lifts `attrCapture` out of index.html
   and asserts that this module leaves the ledger in the same state for the same
   sequence of visits. If either side changes, it goes red.
   =========================================================================== */
(function (root) {
  'use strict';

  var ATTR_KEY = 'edgedesk_attribution';
  var ATTR_LAST = 'edgedesk_attribution_last';
  var ATTR_TTL_DAYS = 365;

  function clean(v, max) {
    if (v == null) return null;
    v = String(v).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, max || 64);
    return v || null;
  }
  function read(k) {
    try { return JSON.parse(root.localStorage.getItem(k) || 'null'); } catch (_) { return null; }
  }
  function write(k, v) {
    try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (_) {}
  }
  function cookie(v) {
    try {
      if (v == null) {
        var m = root.document.cookie.match(/(?:^|;\s*)ed_ref=([^;]*)/);
        return m ? clean(decodeURIComponent(m[1])) : null;
      }
      root.document.cookie = 'ed_ref=' + encodeURIComponent(v) + ';path=/;max-age='
        + (ATTR_TTL_DAYS * 86400) + ';samesite=lax';
    } catch (_) {}
    return null;
  }

  /* One visit. `search` and `referrer` are passed in so this is testable and so
     a caller can replay a visit; `nowIso` likewise. */
  function capture(search, referrer, pathname, nowIso) {
    var q = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('='), k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? '' : kv.slice(i + 1);
      try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (_) {}
    });
    var g = function (n) { return clean(q[n]); };

    var ref = g('ref') || g('via') || g('partner');
    var cur = {
      ref: ref,
      aud: g('aud'),
      utm_source: g('utm_source'), utm_medium: g('utm_medium'),
      utm_campaign: g('utm_campaign'), utm_content: g('utm_content'),
      landing: String(pathname || '/').slice(0, 120),
      referrer: (function () {
        try {
          if (!referrer) return null;
          return String(referrer).split('/')[2].slice(0, 120) || null;
        } catch (_) { return null; }
      })(),
      seen_at: nowIso || new Date().toISOString()
    };
    var hasSignal = !!(cur.ref || cur.utm_source || cur.utm_campaign);

    var first = read(ATTR_KEY);
    if (!first) {
      var ck = cookie(null);
      if (ck) first = { ref: ck, landing: null, referrer: null, seen_at: null,
        recovered_from: 'cookie' };
    }

    if (hasSignal && (!first || first.organic)) {
      if (first && first.organic) {
        cur.organic_first_seen_at = first.seen_at || null;
        cur.organic_landing = first.landing || null;
      }
      first = cur;
      write(ATTR_KEY, cur);
    } else if (!first) {
      first = { ref: null, utm_source: null, landing: cur.landing, referrer: cur.referrer,
        seen_at: cur.seen_at, organic: true };
      write(ATTR_KEY, first);
    }
    if (hasSignal) write(ATTR_LAST, cur);
    if (first && first.ref) cookie(first.ref);
    return { first: first, current: cur };
  }

  /* The credited first touch, for reading. */
  function first() { return read(ATTR_KEY) || null; }

  /* The subset that belongs on an analytics event. Never the whole envelope:
     `landing`, `referrer` and the organic history are ledger fields, not
     event properties. */
  function eventProps() {
    var f = first();
    if (!f) return {};
    var out = {}, keys = ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
    keys.forEach(function (k) { if (f[k]) out['first_' + k] = f[k]; });
    return out;
  }

  /* Query fragment to carry the campaign onto an internal link, so the terminal
     and the checkout see what Games saw. */
  function linkParams() {
    var f = first(), out = [], keys = ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
    if (f) keys.forEach(function (k) {
      if (f[k]) out.push(encodeURIComponent(k) + '=' + encodeURIComponent(f[k]));
    });
    return out;
  }

  var API = {
    ATTR_KEY: ATTR_KEY, ATTR_LAST: ATTR_LAST, ATTR_TTL_DAYS: ATTR_TTL_DAYS,
    clean: clean, capture: capture, first: first,
    eventProps: eventProps, linkParams: linkParams
  };
  root.EDGamesAttribution = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

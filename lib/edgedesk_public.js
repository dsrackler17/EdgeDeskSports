/* ===========================================================================
   EdgeDesk public pages — attribution and measurement for every page a
   visitor can land on that is NOT the landing page: the research articles and
   their hubs, the free tools, the newsletter page, the methodology, the
   public record, the partners page.

   WHY THIS EXISTS. Until 2026-10 only index.html (and /research/sample/)
   recorded a visit. A reader who arrived from Google on a research article
   and then pressed "Start free trial" reached the landing page with
   edgedesksports.com as the referrer, so supabase/growth.sql classified them
   as DIRECT and the search engine that found them got no credit. The pages
   Google indexes are exactly the ones that were blind.

   WHAT IT DOES, on load:
     1. FIRST TOUCH, in the landing page's own storage and shape
        (localStorage edgedesk_attribution / edgedesk_attribution_last, cookie
        ed_ref) and by the landing page's own rule: an organic visit is an
        upgradeable placeholder, the first visit that carries a ref or a utm
        replaces it once, then it is frozen. index.html reads the same keys,
        so the touch this page records is the one its signup claims
        (acq_claim) — no link decoration needed: same origin, same storage.
     2. THE VISIT, to public.acq_track_visit (anon, only a hash of the
        random visitor id is stored) — when it can matter: the first visit
        from this browser, or any visit that arrived from outside or with a
        ref/utm. An internal click from one article to the next is not sent.
     3. A PARTNER CLICK, to public.affiliate_track_click, when the URL
        carries ?ref= — a creator's link may point at an article.
     4. A PAGE VIEW, through lib/edgedesk_track.js (public_page_view, once
        per session per page) — and, on demand, tool_used,
        public_cta_clicked, newsletter_signup.
     5. GOOGLE ANALYTICS (the site's existing GA4 property) — unless the
        browser sends Global Privacy Control or Do Not Track. The first-party
        funnel above stores no personal data and still runs.

   WHAT IT NEVER SENDS: an email address, a name, a query string, a full
   referrer URL, anything typed into a form.

   Every page includes, in this order:
     <script src="/lib/edgedesk_track.js" defer></script>
     <script src="/lib/edgedesk_public.js" defer></script>
   and may name itself with <body data-ed-page="tool:no-vig-calculator">.
   A link or button with data-ed-cta="name" is counted when pressed.

   Browser: window.EDPublic. Node: require('./edgedesk_public.js') (tests,
   which drive it with a fake window).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDPublic = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var SB_URL = 'https://iattxbkbufslbauoumga.supabase.co';
  /* the public anon key every page already ships (index.html, app.html) */
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
  var GA_ID = 'G-1PXVBV53FZ';
  var ATTR_KEY = 'edgedesk_attribution', ATTR_LAST = 'edgedesk_attribution_last', SEEN_KEY = 'edgedesk_acq_seen';
  var VISITOR_KEY = 'edgedesk_visitor', ATTR_TTL_DAYS = 365;
  var SITE_HOSTS = /(^|\.)edgedesksports\.com$/;
  var started = false, pageKind = null;

  function ls() { try { return root && root.localStorage ? root.localStorage : null; } catch (e) { return null; } }
  function read(k) { var s = ls(); try { return s ? JSON.parse(s.getItem(k) || 'null') : null; } catch (e) { return null; } }
  function write(k, v) { var s = ls(); try { if (s) s.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  /* the landing page's own cleaner (index.html attrClean) */
  function clean(v, max) {
    if (v == null) return null;
    v = String(v).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, max || 64);
    return v || null;
  }
  function affCode(r) { r = String(r || '').trim().toUpperCase(); return /^[A-Z0-9_-]{3,32}$/.test(r) ? r : null; }

  function visitor() {
    if (root.EDTrack && typeof root.EDTrack.visitor === 'function') { var v0 = root.EDTrack.visitor(); if (v0) return v0; }
    var s = ls(); if (!s) return null;
    try {
      var v = s.getItem(VISITOR_KEY);
      if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) return v;
      var a = new Uint8Array(18); (root.crypto || root.msCrypto).getRandomValues(a);
      v = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      s.setItem(VISITOR_KEY, v); return v;
    } catch (e) { return null; }
  }

  function cookie(v) {
    try {
      var d = root.document; if (!d) return null;
      if (v == null) { var m = String(d.cookie || '').match(/(?:^|;\s*)ed_ref=([^;]*)/); return m ? clean(decodeURIComponent(m[1])) : null; }
      d.cookie = 'ed_ref=' + encodeURIComponent(v) + ';path=/;max-age=' + (ATTR_TTL_DAYS * 86400) + ';samesite=lax';
    } catch (e) { /* no cookies */ }
    return null;
  }

  /* THIS VISIT, as index.html attrCapture builds it */
  function currentTouch() {
    var loc = root.location || {}, q;
    try { q = new URLSearchParams(loc.search || ''); } catch (e) { q = null; }
    var g = function (n) { return q ? clean(q.get(n)) : null; };
    var refHost = null;
    try {
      var d = root.document;
      if (d && d.referrer) { var h = new URL(d.referrer).hostname.toLowerCase(); refHost = h.slice(0, 120); }
    } catch (e) { refHost = null; }
    return {
      ref: g('ref') || g('via') || g('partner'), aud: g('aud'),
      utm_source: g('utm_source'), utm_medium: g('utm_medium'), utm_campaign: g('utm_campaign'), utm_content: g('utm_content'),
      landing: String(loc.pathname || '/').slice(0, 120),
      referrer: refHost,
      seen_at: new Date().toISOString()
    };
  }
  function external(t) { return !!(t && t.referrer && !SITE_HOSTS.test(t.referrer)); }

  /* THE CREDIT RULE, identical to index.html: the first touch that carried a
     code (ref or utm) wins and is frozen; an organic visit is an upgradeable
     placeholder that still remembers where it came from (the referrer and
     the landing page), which is what makes a search visit a SEARCH visit. */
  function capture(cur) {
    cur = cur || currentTouch();
    var hasSignal = !!(cur.ref || cur.utm_source || cur.utm_campaign);
    var first = read(ATTR_KEY);
    if (!first) { var ck = cookie(null); if (ck) first = { ref: ck, landing: null, referrer: null, seen_at: null, recovered_from: 'cookie' }; }
    if (hasSignal && (!first || first.organic)) {
      if (first && first.organic) { cur.organic_first_seen_at = first.seen_at || null; cur.organic_landing = first.landing || null; }
      first = cur; write(ATTR_KEY, cur);
    } else if (!first) {
      first = { ref: null, utm_source: null, landing: cur.landing, referrer: cur.referrer, seen_at: cur.seen_at, organic: true };
      write(ATTR_KEY, first);
    } else if (first.organic && !first.referrer && external(cur)) {
      /* an organic placeholder written by a direct visit learns the first
         OUTSIDE referrer that follows it — once — so a reader who typed the
         address, then came back from Google, is not left as direct */
      first.referrer = cur.referrer; first.landing = cur.landing; first.seen_at = cur.seen_at;
      write(ATTR_KEY, first);
    }
    if (hasSignal || external(cur)) write(ATTR_LAST, cur);
    if (first && first.ref) cookie(first.ref);
    return { first: first, current: cur };
  }

  function post(rpc, body, keepalive) {
    if (typeof root.fetch !== 'function') return Promise.resolve(false);
    try {
      return root.fetch(SB_URL + '/rest/v1/rpc/' + rpc, {
        method: 'POST', keepalive: !!keepalive, credentials: 'omit',
        headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) { return !!(r && r.ok); }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  /* the server keeps a visit only when it can change what is known */
  function trackVisit(cur) {
    var v = visitor(); if (!v) return false;
    var s = ls(), seen = false;
    try { seen = !!(s && s.getItem(SEEN_KEY)); } catch (e) { seen = false; }
    var worth = !seen || external(cur) || !!(cur.ref || cur.utm_source || cur.utm_campaign);
    if (!worth) return false;
    try { if (s) s.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
    post('acq_track_visit', { p_visitor: v, p_touch: { ref: cur.ref, utm_source: cur.utm_source, utm_medium: cur.utm_medium,
      utm_campaign: cur.utm_campaign, referrer_host: cur.referrer, landing: cur.landing, seen_at: cur.seen_at } });
    var code = affCode(cur.ref);
    if (code) post('affiliate_track_click', { p_code: code, p_visitor: v, p_landing: cur.landing, p_referrer: cur.referrer || null });
    return true;
  }

  function privacySignal() {
    try {
      var n = root.navigator || {};
      return n.globalPrivacyControl === true || n.doNotTrack === '1' || root.doNotTrack === '1';
    } catch (e) { return false; }
  }
  function loadGa() {
    var d = root.document;
    if (!d || privacySignal()) return false;
    if (typeof root.gtag === 'function') return true;
    root.dataLayer = root.dataLayer || [];
    root.gtag = function () { root.dataLayer.push(arguments); };
    root.gtag('js', new Date());
    root.gtag('config', GA_ID);
    try {
      var sc = d.createElement('script'); sc.async = true; sc.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
      (d.head || d.documentElement).appendChild(sc);
    } catch (e) { /* no GA */ }
    return true;
  }

  /* which page this is: <body data-ed-page="kind:slug">, else the path */
  function kindOf(path, body) {
    var named = body && body.getAttribute ? body.getAttribute('data-ed-page') : null;
    if (named && /^[a-z0-9_:-]{2,80}$/.test(named)) return named;
    path = String(path || '/');
    var m;
    if ((m = /^\/articles\/(college-football|nfl)\/?$/.exec(path))) return 'research_hub:' + m[1];
    if (/^\/articles\/?$/.test(path)) return 'research_hub:all';
    if ((m = /^\/articles\/([a-z0-9-]+)\/?$/.exec(path))) return 'article:' + m[1].slice(0, 70);
    if ((m = /^\/tools\/([a-z0-9-]+)\/?$/.exec(path))) return 'tool:' + m[1];
    if (/^\/tools\/?$/.test(path)) return 'tools_hub';
    if (/^\/newsletter\/?$/.test(path)) return 'newsletter';
    if (/^\/methodology\/?$/.test(path)) return 'methodology';
    if (/^\/record(\.html)?$/.test(path)) return 'record';
    if (/^\/partners\/?$/.test(path)) return 'partners';
    return 'page:' + path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60);
  }

  function track(name, props, opts) {
    try { return !!(root.EDTrack && root.EDTrack.event(name, props || {}, opts || {})); } catch (e) { return false; }
  }

  function wireCtas() {
    var d = root.document; if (!d || !d.addEventListener) return;
    d.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-ed-cta]') : null;
      if (!el) return;
      var cta = clean(el.getAttribute('data-ed-cta'), 40); if (!cta) return;
      track('public_cta_clicked', { cta: cta, page: (pageKind || '').slice(0, 80) }, { now: true, keepalive: true });
    }, true);
  }

  function start() {
    if (started) return null;
    started = true;
    var d = root.document;
    pageKind = kindOf((root.location || {}).pathname, d && d.body);
    /* a page that configured the tracker itself (methodology, which sends
       its own GA events) keeps its configuration */
    try {
      if (root.EDTrack) {
        var cfg = root.EDTrack.configure({});
        if (!cfg || !cfg.url) root.EDTrack.configure({ url: SB_URL, key: SB_KEY, ga: true });
      }
    } catch (e) { /* no tracker */ }
    loadGa();
    var cap = capture();
    trackVisit(cap.current);
    track('public_page_view', { entity: pageKind, kind: pageKind.split(':')[0] });
    wireCtas();
    return { kind: pageKind, first: cap.first };
  }

  if (root && root.document && !root.EDPUBLIC_MANUAL) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return {
    start: start, track: track, capture: capture, currentTouch: currentTouch, kindOf: kindOf, clean: clean,
    privacySignal: privacySignal, ATTR_KEY: ATTR_KEY, ATTR_LAST: ATTR_LAST, GA_ID: GA_ID,
    /* tests */
    _reset: function () { started = false; pageKind = null; }
  };
}));

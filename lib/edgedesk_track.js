/* ===========================================================================
   EdgeDesk funnel tracking — the ONE client for supabase/funnel.sql ed_track().

   Every page that measures the funnel (the landing page, the terminal, the
   methodology page, the public sample) calls EDTrack.event(name, props). This
   file only QUEUES and SENDS; what counts is decided in the database:
   supabase/funnel.sql refuses an unknown name, deduplicates by each event's
   rule (once per session, per game per day, …) and takes the reader from the
   access token — never from anything this file sends.

   What it adds on top, each for a reason:
     * a per-page-load guard: the same event for the same entity is queued
       once per page load, so a re-render, a second click or a component
       mounting twice cannot even reach the network twice;
     * batching: events wait ~1.2 s and go in one request (at most 25), and
       whatever is queued is sent with keepalive when the page is hidden, so
       the landing page never makes a request per click;
     * a visitor id and a session id: the visitor id is the page's existing
       random id (localStorage edgedesk_visitor, the one growth.sql's
       acquisition tracking uses — only its hash is stored); the session id is
       random per browser tab and renews after 30 minutes idle;
     * first-touch context: the page path (never the query string), the
       referring HOST (never the full URL) and utm_source / utm_medium /
       utm_campaign.

   What it NEVER sends: an email address, a name, a token in the body, a full
   URL, anything typed into a form. event_properties are short scalars
   (entity, cta, league, surface…), and the database strips anything else.

   Failure is silent by design: a blocked request, a missing table or an
   offline phone costs the reader nothing.

   Browser: window.EDTrack. Node: require('./edgedesk_track.js') (tests).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDTrack = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_track_v1';
  var VISITOR_KEY = 'edgedesk_visitor', SESSION_KEY = 'edgedesk_sid', IDLE_MS = 30 * 60 * 1000;
  var CFG = { url: null, key: null, token: null, flush_ms: 1200, max: 25, ga: true, enabled: true };
  var Q = [], SEEN = {}, timer = null, ctx = null, wired = false;
  /* the names supabase/funnel.sql accepts from a page (user_event_kinds with
     source = 'client'); anything else is dropped here before it costs a byte */
  var CLIENT = [
    /* the public site before the landing page: articles, free tools, the
       newsletter page (lib/edgedesk_public.js) */
    'public_page_view', 'tool_used', 'public_cta_clicked', 'newsletter_signup',
    /* an engaged reader on EdgeDesk's own features (never under GPC / DNT) */
    'article_engaged',
    'landing_view', 'landing_live_board_view', 'pricing_view', 'cta_clicked', 'signup_started', 'checkout_started',
    'terminal_opened', 'first_run_viewed', 'preferences_saved', 'onboarding_skipped', 'board_viewed', 'game_opened',
    'prop_board_opened', 'prop_opened', 'ev_viewed', 'custom_price_checked', 'research_saved', 'brief_copied',
    /* navigation evidence (app.html edNavTrack): the five seats, and where a
       reader went from inside one */
    'primary_nav_research', 'primary_nav_card', 'primary_nav_portfolio', 'primary_nav_process', 'primary_nav_more',
    'secondary_nav_opened',
    /* Portfolio time to value (lib/edgedesk_portfolio_ui.js) */
    'portfolio_onboarding_started', 'platform_selected', 'connection_started', 'connection_completed', 'import_started',
    'import_detected', 'import_reviewed', 'import_completed', 'first_position_created', 'portfolio_ready', 'first_process_insight_ready'];

  function ls() { try { return root && root.localStorage ? root.localStorage : null; } catch (e) { return null; } }
  function ss() { try { return root && root.sessionStorage ? root.sessionStorage : null; } catch (e) { return null; } }
  function rand(n) {
    try {
      var a = new Uint8Array(n); (root.crypto || root.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) {
      var s = ''; for (var i = 0; i < n * 2; i++) s += Math.floor(Math.random() * 16).toString(16); return s;
    }
  }

  /* the same visitor id index.html's partner and acquisition tracking use */
  function visitor() {
    var st = ls(); if (!st) return null;
    try {
      var v = st.getItem(VISITOR_KEY);
      if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) return v;
      v = rand(18); st.setItem(VISITOR_KEY, v); return v;
    } catch (e) { return null; }
  }
  /* one browser tab's session: renewed after 30 minutes without an event */
  function session(now) {
    now = now || Date.now();
    var st = ss(), o = null;
    try { o = st ? JSON.parse(st.getItem(SESSION_KEY) || 'null') : null; } catch (e) { o = null; }
    if (!o || !/^[A-Za-z0-9_-]{8,64}$/.test(o.id || '') || !(now - (+o.t || 0) < IDLE_MS)) o = { id: rand(12), t: now, n: 0 };
    o.t = now;
    try { if (st) st.setItem(SESSION_KEY, JSON.stringify(o)); } catch (e) { /* private mode */ }
    return o.id;
  }

  function clean(v, max) { return v == null ? null : (String(v).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, max || 64) || null); }
  /* first-touch context for this page load: path, referring host, utm */
  function context() {
    if (ctx) return ctx;
    ctx = { page_path: null, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null };
    try {
      var loc = root.location || {};
      ctx.page_path = String(loc.pathname || '/').slice(0, 160);
      var q = new URLSearchParams(loc.search || '');
      ctx.utm_source = clean(q.get('utm_source')); ctx.utm_medium = clean(q.get('utm_medium')); ctx.utm_campaign = clean(q.get('utm_campaign'));
      var ref = root.document && root.document.referrer ? new URL(root.document.referrer) : null;
      if (ref && ref.hostname && ref.hostname !== loc.hostname) ctx.referrer = ref.hostname.toLowerCase().slice(0, 120);
    } catch (e) { /* keep what we have */ }
    return ctx;
  }

  /* short scalars only; nothing that looks like contact details */
  function props(p) {
    var out = {}, n = 0;
    if (!p || typeof p !== 'object') return out;
    Object.keys(p).sort().forEach(function (k) {
      if (n >= 16 || !/^[a-z][a-z0-9_]{0,31}$/.test(k)) return;
      var v = p[k];
      if (typeof v === 'string') { if (/@/.test(v)) return; v = v.slice(0, 120); }
      else if (typeof v === 'number') { if (!isFinite(v)) return; }
      else if (typeof v !== 'boolean') return;
      out[k] = v; n++;
    });
    return out;
  }

  function sessionToken() {
    var st = ls(); if (!st) return null;
    try {
      var s = JSON.parse(st.getItem('edgedesk_session') || 'null');
      if (!s || !s.access_token) return null;
      if (s.expires_at && (+s.expires_at * 1000) <= Date.now() + 5000) return null;
      return s.access_token;
    } catch (e) { return null; }
  }
  function bearer() {
    try {
      if (typeof CFG.token === 'function') return Promise.resolve(CFG.token()).then(function (t) { return t || sessionToken() || CFG.key; }, function () { return sessionToken() || CFG.key; });
    } catch (e) { /* fall through */ }
    return Promise.resolve(sessionToken() || CFG.key);
  }

  function send(batch, keepalive) {
    if (!batch.length || !CFG.url || !CFG.key || typeof root.fetch !== 'function') return Promise.resolve(false);
    var body = JSON.stringify({ p_events: batch, p_visitor: visitor(), p_session: session() });
    return bearer().then(function (tok) {
      return root.fetch(CFG.url + '/rest/v1/rpc/ed_track', {
        method: 'POST', keepalive: !!keepalive, credentials: 'omit',
        headers: { apikey: CFG.key, authorization: 'Bearer ' + (tok || CFG.key), 'content-type': 'application/json' },
        body: body
      }).then(function (r) { return !!(r && r.ok); }, function () { return false; });
    }).catch(function () { return false; });
  }

  function flush(keepalive) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!Q.length) return Promise.resolve(false);
    var out = [];
    while (Q.length) out.push(send(Q.splice(0, CFG.max), keepalive));
    return Promise.all(out).then(function (r) { return r.every(Boolean); });
  }
  function schedule() {
    if (timer || !CFG.flush_ms) return;
    timer = setTimeout(function () { timer = null; flush(false); }, CFG.flush_ms);
  }
  function wire() {
    if (wired || !root || !root.addEventListener) return;
    wired = true;
    try {
      root.addEventListener('pagehide', function () { flush(true); });
      if (root.document) root.document.addEventListener('visibilitychange', function () { if (root.document.visibilityState === 'hidden') flush(true); });
    } catch (e) { /* not a browser */ }
  }

  /* THE CALL. once: false lets the same name+entity queue again on this page
     load (the server still deduplicates by its own rule). */
  function event(name, p, opts) {
    opts = opts || {};
    if (!CFG.enabled || CLIENT.indexOf(name) < 0) return false;
    var pp = props(p), key = name + '|' + (pp.entity || pp.cta || '');
    if (opts.once !== false && SEEN[key]) return false;
    SEEN[key] = true;
    var c = context();
    Q.push({ event: name, props: pp, page_path: c.page_path, referrer: c.referrer,
      utm_source: c.utm_source, utm_medium: c.utm_medium, utm_campaign: c.utm_campaign });
    if (CFG.ga) { try { if (typeof root.gtag === 'function') root.gtag('event', name, pp); } catch (e) { /* no GA */ } }
    wire();
    if (opts.now) flush(!!opts.keepalive); else schedule();
    return true;
  }

  /* an element scrolled into view (once), e.g. the live board or pricing.
     "In view" is `threshold` of the element OR half the screen filled by it:
     a section taller than the phone showing it can never be 30% visible */
  function seen(el, name, p, threshold) {
    if (!el || !root || !('IntersectionObserver' in root)) return false;
    var t = threshold == null ? 0.3 : threshold;
    var io = new root.IntersectionObserver(function (es) {
      for (var i = 0; i < es.length; i++) {
        var en = es[i]; if (!en.isIntersecting) continue;
        var vh = en.rootBounds && en.rootBounds.height ? en.rootBounds.height : (root.innerHeight || 0);
        if (en.intersectionRatio >= t || (vh > 0 && en.intersectionRect && en.intersectionRect.height >= vh * 0.5)) {
          io.disconnect(); event(name, typeof p === 'function' ? p() : p); return;
        }
      }
    }, { threshold: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1] });
    io.observe(el);
    return true;
  }

  function configure(o) {
    o = o || {};
    ['url', 'key', 'token', 'flush_ms', 'max', 'ga', 'enabled'].forEach(function (k) { if (o[k] !== undefined) CFG[k] = o[k]; });
    return CFG;
  }

  return {
    VERSION: VERSION, CLIENT: CLIENT.slice(), configure: configure, event: event, flush: flush, seen: seen,
    visitor: visitor, session: session,
    /* tests */
    _queue: function () { return Q.slice(); }, _reset: function () { Q = []; SEEN = {}; ctx = null; if (timer) { clearTimeout(timer); timer = null; } },
    _props: props
  };
}));

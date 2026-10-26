/* ===========================================================================
   EdgeDesk APP SHELL — the navigation every screen shares, the quiet reads
   the shell's own views make, and the door other layers plug into.
   docs/research-os/DESIGN.md §1

   ONE NAVIGATION, TWO SHAPES (app.html <nav class="bottomnav" id="edNav">)
     desktop (≥ 1024 px)  a persistent sidebar: Research · Workspace · More
     phone / tablet       a bottom bar with the five places a reader goes most,
                          and Menu, which opens the same list as a sheet
   It is ONE element with one set of buttons, so every `data-v` seat keeps its
   name, its click handler (app.html binds .bottomnav button) and its
   aria-current state, whichever shape is drawn. show(v) stays the one router.

   WHAT THIS FILE DOES NOT DO
     It routes nothing itself (show(), navHashRoute() and researchGo() in
     app.html do), grants nothing (every read here goes through a door that
     decides access on the server, under the reader's own token), and paints
     no database fault: a door that is not deployed answers "not deployed",
     never an outage on the header's System status.

   SERVICES. A layer that must not be named from here (Market Foresight is
   kept isolated by its own isolation test, docs/market-foresight) registers itself with
   EDShell.provide(name, impl); the Overview and the game page ask
   EDShell.service(name) and draw nothing when it is absent.

   Browser: window.EDShell. Node: require('./edgedesk_shell.js') for NAV and
   the pure helpers (tools/research_os/research_os.test.js).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && root.document) root.EDShell = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var X = { VERSION: 'edgedesk_shell/1' };

  /* ================================================================ THE MAP
     Every destination, in the order the navigation draws them. `bar: true`
     seats are on the phone's bottom bar; the rest are one tap away in Menu.
     `q` is what the reader asks when they go there (the IA's one question).
     `hash` is the deep link. Admin-only places are never listed here. */
  X.GROUPS = [
    { id: 'research', label: 'Research' },
    { id: 'workspace', label: 'Your workspace' },
    { id: 'more', label: 'More' }
  ];
  X.NAV = [
    { v: 'overview', label: 'Overview', short: 'Overview', group: 'research', bar: true, hash: '#overview', q: 'What deserves my attention today?' },
    { v: 'research', label: 'Research', short: 'Research', group: 'research', bar: true, hash: '#research/football', q: 'Why — the full research on a game, by sport.' },
    { v: 'signals', label: 'Signals', short: 'Signals', group: 'research', bar: true, hash: '#signals', aria: 'Signal Center', q: 'What changed, why, and is the evidence still valid?' },
    { v: 'foresight', label: 'Market Foresight', short: 'Foresight', group: 'research', bar: false, hash: '#foresight', q: 'Which forecasts preceded later market movement (NFL and college football)?' },
    { v: 'simulator', label: 'Simulator', short: 'Simulator', group: 'research', bar: false, hash: '#simulator', q: 'Season, playoff and title probabilities where a sport is supported.' },
    { v: 'card', label: 'My Card', short: 'Card', group: 'workspace', bar: true, hash: '#card', q: 'What am I researching or considering right now?' },
    { v: 'portfolio', label: 'Portfolio', short: 'Portfolio', group: 'workspace', bar: true, hash: '#portfolio', q: 'What did I actually do, and am I up or down?' },
    { v: 'performance', label: 'Performance', short: 'Performance', group: 'workspace', bar: false, hash: '#performance', q: 'How EdgeDesk’s models have done, and how you have — kept apart.' },
    { v: 'process', label: 'Process', short: 'Process', group: 'workspace', bar: false, sub: true, hash: '#process', q: 'What does my history say about how I decide?' },
    { v: 'more', label: 'More', short: 'More', group: 'more', bar: false, hash: '#more', q: 'Model Collective, methodology, data, account, help.' }
  ];
  X.BAR = {}; X.NAV.forEach(function (n) { if (n.bar) X.BAR[n.v] = 1; });
  X.byView = function (v) { for (var i = 0; i < X.NAV.length; i++) if (X.NAV[i].v === v) return X.NAV[i]; return null; };

  /* ============================================================ QUIET READS
     An optional layer's door, read under the reader's token, with a time
     limit. 404 / "function does not exist" is { deployed: false }; any other
     failure is thrown with its status. Nothing here writes the header's
     database state. */
  X.notDeployed = function (e) { return !!e && (e.status === 404 || /PGRST20[25]|Could not find the function|does not exist|schema cache/i.test(String(e.body || ''))); };
  function timeout(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { var e = new Error('timeout'); e.status = 0; rej(e); }, ms); })]); }
  function token() { try { return typeof root.edToken === 'function' ? Promise.resolve(root.edToken()) : Promise.resolve(root.SB_KEY); } catch (_) { return Promise.resolve(root.SB_KEY); } }
  function call(path, init, ms) {
    var url = root.SB_URL, key = root.SB_KEY;
    if (!url || !key || typeof root.fetch !== 'function') { var e0 = new Error('the database client is not loaded'); e0.status = 0; return Promise.reject(e0); }
    return token().then(function (t) {
      var h = { apikey: key, authorization: 'Bearer ' + (t || key) };
      if (init && init.body !== undefined) h['content-type'] = 'application/json';
      return timeout(root.fetch(url + '/rest/v1/' + path, { method: (init && init.method) || 'GET', headers: h, body: init && init.body !== undefined ? JSON.stringify(init.body) : undefined }), ms || 12000);
    }).then(function (r) {
      return r.text().then(function (txt) {
        if (!r.ok) { var e = new Error('db ' + r.status); e.status = r.status; e.body = txt; throw e; }
        return txt ? JSON.parse(txt) : null;
      });
    });
  }
  X.rpc = function (name, args, ms) { return call('rpc/' + name, { method: 'POST', body: args || {} }, ms); };
  X.get = function (path, ms) { return call(path, null, ms); };
  /* one read per key per `ttl`, deduplicated while in flight */
  var MEMO = {};
  X.memo = function (key, ttl, fn) {
    var m = MEMO[key], now = Date.now();
    if (m && (m.p || now - m.at < ttl)) return m.p || Promise.resolve(m.v);
    var p = Promise.resolve().then(fn).then(function (v) { MEMO[key] = { at: Date.now(), v: v, p: null }; return v; }, function (e) { delete MEMO[key]; throw e; });
    MEMO[key] = { at: now, v: m ? m.v : undefined, p: p };
    return p;
  };
  X.forget = function (key) { if (key == null) MEMO = {}; else delete MEMO[key]; };

  /* ============================================================== SERVICES */
  var SVC = {};
  X.provide = function (name, impl) { if (name && impl) SVC[name] = impl; };
  X.service = function (name) { return SVC[name] || null; };

  /* ========================================================= THE NAVIGATION */
  function doc() { return root.document || null; }
  function navEl() { var d = doc(); return d ? d.getElementById('edNav') : null; }
  /* the Menu seat lights when the place on screen has no seat on the bar */
  X.paint = function (on) {
    var d = doc(); if (!d) return;
    var m = d.getElementById('navMenuBtn'); if (!m) return;
    var owner = on && !X.BAR[on];
    m.classList.toggle('on', !!owner);
    var n = X.byView(on);
    m.setAttribute('aria-label', 'Menu: every destination' + (owner && n ? ' (now on ' + n.label + ')' : ''));
  };
  var LAST_FOCUS = null;
  function focusables(el) { return Array.prototype.filter.call(el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'), function (x) { return !x.disabled && x.offsetParent !== null; }); }
  X.menuOpen = function () {
    var n = navEl(), d = doc(); if (!n || !d) return;
    if (n.classList.contains('open')) return;
    LAST_FOCUS = d.activeElement;
    n.classList.add('open');
    n.setAttribute('aria-modal', 'true'); n.setAttribute('role', 'dialog'); n.setAttribute('aria-label', 'All destinations');
    var s = d.getElementById('navScrim'); if (s) s.hidden = false;
    var b = d.getElementById('navMenuBtn'); if (b) b.setAttribute('aria-expanded', 'true');
    d.body.classList.add('nav-sheet-open');
    var on = n.querySelector('button.on[data-v]') || n.querySelector('button[data-v]');
    try { (on || n).focus(); } catch (_) { /* focus is best effort */ }
  };
  X.menuClose = function (restore) {
    var n = navEl(), d = doc(); if (!n || !d || !n.classList.contains('open')) return;
    n.classList.remove('open');
    n.removeAttribute('aria-modal'); n.setAttribute('role', 'navigation'); n.setAttribute('aria-label', 'Primary');
    var s = d.getElementById('navScrim'); if (s) s.hidden = true;
    var b = d.getElementById('navMenuBtn'); if (b) b.setAttribute('aria-expanded', 'false');
    d.body.classList.remove('nav-sheet-open');
    if (restore !== false) { try { (LAST_FOCUS && LAST_FOCUS.focus ? LAST_FOCUS : b).focus(); } catch (_) { /* gone */ } }
    LAST_FOCUS = null;
  };
  X.menuToggle = function () { var n = navEl(); if (n && n.classList.contains('open')) X.menuClose(); else X.menuOpen(); };

  /* the global keys: Ctrl/⌘ K or "/" opens search (never while typing),
     Escape closes the menu sheet; Tab stays inside the open sheet */
  function typing(t) { return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')); }
  /* drawn on screen: not display:none, not hidden, and inside the viewport (the AI drawer and
     other panels stay in the DOM, translated off screen, when closed) */
  X.drawn = function (x) {
    if (!x || !x.getClientRects || !x.getClientRects().length) return false;
    try { if (root.getComputedStyle(x).visibility === 'hidden') return false; } catch (_) { /* assume drawn */ }
    var b = x.getBoundingClientRect(), W = root.innerWidth || 0, Hh = root.innerHeight || 0;
    return b.width > 0 && b.height > 0 && b.right > 1 && b.left < W - 1 && b.bottom > 1 && b.top < Hh - 1;
  };
  X.install = function () {
    var d = doc(); if (!d || X._installed) return; X._installed = true;
    d.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null; if (!t) return;
      if (t.closest('[data-nav-menu]')) { e.preventDefault(); X.menuToggle(); return; }
      if (t.closest('[data-nav-close]') || t.id === 'navScrim') { X.menuClose(); return; }
      var seat = t.closest('#edNav button[data-v]');
      if (seat && navEl() && navEl().classList.contains('open')) X.menuClose(false);
      var s = t.closest('[data-ed-search]'); if (s) { e.preventDefault(); if (root.EDSearch) root.EDSearch.open(s); }
      var go = t.closest('[data-ed-go]');
      if (go) { e.preventDefault(); X.go(go.getAttribute('data-ed-go'), go.getAttribute('data-ed-from') || null); }
    });
    d.addEventListener('keydown', function (e) {
      var n = navEl();
      if (n && n.classList.contains('open')) {
        if (e.key === 'Escape') { e.preventDefault(); X.menuClose(); return; }
        if (e.key === 'Tab') {
          var f = focusables(n); if (!f.length) return;
          var i = f.indexOf(d.activeElement);
          if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
        return;
      }
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); if (root.EDSearch) root.EDSearch.open(); return; }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
        /* not over another open dialog (the paywall, a modal, the AI drawer): those stay in the DOM
           when closed, so "open" means drawn */
        var open = Array.prototype.some.call(d.querySelectorAll('[role="dialog"],[aria-modal="true"]'), X.drawn);
        if (!open && root.EDSearch) { e.preventDefault(); root.EDSearch.open(); }
      }
    });
    /* a wide window closes the sheet: the sidebar is the menu there */
    if (root.matchMedia) { try { var mq = root.matchMedia('(min-width: 1024px)'); var on = function () { if (mq.matches) X.menuClose(false); }; if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on); } catch (_) { /* no media queries */ } }
  };

  /* A link inside a view: a hash goes through the app's own routers (so Back
     works and the URL is shareable); "track" names it as navigation evidence. */
  X.go = function (href, from) {
    if (!href) return;
    try { if (from && typeof root.edNavTrack === 'function') root.edNavTrack('secondary', from); } catch (_) { /* evidence is optional */ }
    if (href.charAt(0) === '#') {
      if (root.location.hash === href) { try { if (typeof root.navHashRoute === 'function') root.navHashRoute(href); } catch (_) { /* the router owns errors */ } }
      else root.location.hash = href;
      return;
    }
    if (/^\/[^/]/.test(href)) root.location.href = href;
  };

  /* ================================================================ HELPERS */
  X.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  /* a reader-facing "x ago", never a clock the data does not carry */
  X.ago = function (t, now) {
    var ms = typeof t === 'number' ? t : Date.parse(t); if (!isFinite(ms)) return null;
    var m = Math.max(0, Math.round(((now == null ? Date.now() : now) - ms) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 48 * 60 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  };
  /* WHERE A READER WITH NO REMEMBERED TAB STARTS (docs/research-os/DESIGN.md §1). A new account, in its
     first FIRST_RUN_DAYS days and before it puts the first-run panel away, starts on Research: that is where
     the panel ("Here's what EdgeDesk found today", lib/edgedesk_first_run.js) sits, above the board. Every
     other reader starts on the Overview. The window and the "put away" mark (done_at in the device's
     edgedesk_first_run_v1) are lib/edgedesk_first_run.js's own; tools/research_os/research_os.test.js holds
     this rule to that module's. A deep link and a remembered tab are decided before this is asked. */
  X.FIRST_RUN_DAYS = 14;
  X.landing = function (user, firstRun, now) {
    var c = user && user.created_at != null ? Date.parse(user.created_at) : NaN;
    var isNew = isFinite(c) && (now - c) < X.FIRST_RUN_DAYS * 864e5;
    return isNew && !(firstRun && firstRun.done_at) ? 'research' : 'overview';
  };
  X.signedIn = function () { try { var u = typeof root.edUser === 'function' ? root.edUser() : null; return !!(u && u.id); } catch (_) { return false; } };

  return X;
});

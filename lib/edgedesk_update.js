/* ===========================================================================
   EdgeDesk UPDATE CHECK — an open tab picks up a new deploy by itself.

   app.html is a single page: moving between games, sports and tabs never
   reloads it, so a tab opened before a deploy kept running the old code until
   the reader reloaded by hand (2026-10-20: the NHL graphic and the Grade
   Breakdown fix were live, and a phone kept showing the old page).

   /app-version.json names the app's code as deployed: a hash of app.html and
   lib/ (tools/app/app_version.js), restamped by .github/workflows/
   app-version.yml whenever either changes on main. This file reads it once
   when the page loads (the version this tab runs) and again when the tab
   comes back into view and every ten minutes while it is open. When the
   deployed version differs:
     * the reader just came back to the tab (within REVISIT_MS): reload now,
       nothing on screen is lost;
     * otherwise: a bar says EdgeDesk was updated, with a Reload button, and
       the next move to another screen (a hash change) or the next return to
       the tab reloads.
   The hash route survives the reload, so the reader lands where they were.
   A failed read changes nothing. It never reloads twice for one version.

   Browser: window.EDUpdate (starts itself). Node: require() for the tests,
   with every dependency injectable through start(env).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDUpdate = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var U = { URL: '/app-version.json', EVERY_MS: 10 * 60e3, MIN_GAP_MS: 60e3, REVISIT_MS: 4000, KEY: 'edgedesk_update_reloaded' };

  /** A new deploy is one whose version differs from the version this tab loaded with. */
  U.isNewer = function (loaded, latest) { return typeof loaded === 'string' && typeof latest === 'string' && loaded !== '' && latest !== '' && loaded !== latest; };

  U.start = function (env) {
    env = env || {};
    var W = env.win || (typeof window !== 'undefined' ? window : null), D = env.doc || (typeof document !== 'undefined' ? document : null);
    if (!W || !D) return null;
    var now = env.now || function () { return Date.now(); };
    var fetchJson = env.fetchJson || function (url) {
      return W.fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; });
    };
    var reloadPage = env.reload || function () { W.location.reload(); };
    var S = { loaded: null, latest: null, pending: false, last: 0, shownAt: now(), busy: null, banner: null };

    function read() {
      return fetchJson(U.URL + '?t=' + now()).then(function (j) { return j && typeof j.version === 'string' ? j.version : null; }).catch(function () { return null; });
    }
    function reload() {
      /* one reload per version: a CDN still serving the old page must not loop */
      try { if (W.sessionStorage.getItem(U.KEY) === S.latest) return false; W.sessionStorage.setItem(U.KEY, S.latest); } catch (_) { /* private mode: still reload once here */ }
      S.pending = false;
      reloadPage();
      return true;
    }
    function bar() {
      if (S.banner || !D.body) return;
      var b = D.createElement('div');
      b.className = 'edu-bar';
      b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:9999;display:flex;align-items:center;gap:10px;justify-content:space-between;padding:10px 12px;border-radius:12px;border:1px solid var(--accent,#2fa79a);background:var(--surface,#191510);color:var(--text,#f1ebdf);font:600 14px Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45)';
      b.innerHTML = '<span>EdgeDesk was updated.</span><button type="button" class="edu-reload" style="min-height:36px;padding:0 14px;border-radius:9px;border:0;background:var(--accent,#2fa79a);color:var(--on-accent,#042320);font:700 14px Inter,system-ui,sans-serif;cursor:pointer">Reload</button>';
      b.querySelector('.edu-reload').addEventListener('click', function () { reload(); });
      D.body.appendChild(b);
      S.banner = b;
    }
    function check(force) {
      if (S.busy) return S.busy;
      if (!force && now() - S.last < U.MIN_GAP_MS) return Promise.resolve(S.pending);
      S.last = now();
      S.busy = read().then(function (v) {
        S.busy = null;
        if (!v) return S.pending;
        if (!S.loaded) { S.loaded = v; return false; }
        S.latest = v;
        if (!U.isNewer(S.loaded, v)) return false;
        S.pending = true;
        /* the reader has only just come back to this tab: nothing to lose */
        if (D.visibilityState !== 'hidden' && now() - S.shownAt <= U.REVISIT_MS && reload()) return true;
        bar();
        return true;
      });
      return S.busy;
    }
    D.addEventListener('visibilitychange', function () {
      if (D.visibilityState === 'hidden') return;
      S.shownAt = now();
      if (S.pending) { reload(); return; }
      check(false);
    });
    W.addEventListener('hashchange', function () { if (S.pending) reload(); });
    var timer = W.setInterval(function () { if (D.visibilityState !== 'hidden') check(true); }, U.EVERY_MS);
    var first = check(true);
    return { state: S, check: check, stop: function () { W.clearInterval(timer); }, ready: first };
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && !(typeof module === 'object' && module.exports)) {
    var go = function () { U.instance = U.start(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
  return U;
});

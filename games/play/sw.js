/* ===========================================================================
   GAME DAY — the offline shell.

   A cache-first shell for the page, the stylesheets and the football engine,
   and network-first for everything else. There is nothing here about game
   state: a game in progress lives in localStorage as a seed and a call list,
   so the football survives being offline whether or not this file does.

   Bump VERSION whenever the shell changes; the old cache is dropped on
   activate, so a stale engine can never outlive a deploy.
   =========================================================================== */
var V = (function () {
  try { return new URL(self.location.href).searchParams.get('v') || 'dev'; } catch (_) { return 'dev'; }
})();
var VERSION = 'gridiron-v1-' + V;
var Q = '?v=' + V;
var SHELL = [
  '/games/play/',
  '/games/play/play.js' + Q,
  '/games/games.css' + Q,
  '/games/gridiron.css' + Q,
  '/games/lib/gridiron/football.js' + Q,
  '/games/lib/gridiron/roster.js' + Q,
  '/games/lib/gridiron/engine.js' + Q,
  '/games/lib/gridiron/ai.js' + Q,
  '/games/lib/gridiron/autoplay.js' + Q,
  '/games/lib/gridiron/render.js' + Q,
  '/games/lib/gridiron/session.js' + Q,
  '/games/lib/week.js' + Q,
  '/games/lib/store.js' + Q,
  '/games/lib/social.js' + Q,
  '/games/lib/auth.js' + Q,
  '/games/lib/franchise.js' + Q,
  '/games/games.js' + Q,
  '/games/play/icon.svg',
  '/games/play/icon-192.png',
  '/games/play/manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    /* one failed asset must not fail the whole install */
    return Promise.all(SHELL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === VERSION ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          /* fonts and analytics: not ours */
  /* the page itself: network first, so a deploy is picked up, cache as backup */
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (r) {
      var copy = r.clone();
      caches.open(VERSION).then(function (c) { c.put('/games/play/', copy); });
      return r;
    }).catch(function () {
      return caches.match('/games/play/').then(function (r) { return r || Response.error(); });
    }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (r) {
      if (r && r.ok && (url.pathname.indexOf('/games/') === 0)) {
        var copy = r.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return r;
    });
  }));
});

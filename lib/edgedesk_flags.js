/* ===========================================================================
   EdgeDesk UI feature flags — switches for what a PAGE SHOWS, never for what
   an account MAY OPEN.

   THE ONE RULE. A flag turns a piece of interface on or off. It never grants
   access to anything. Whether an account may use the terminal is the
   database's decision (public.my_billing_access, lib/edgedesk_access.js), and
   every paid door checks it on the server. tools/site/free_access.test.js
   fails if the access client or the terminal's paywall reads this file, so a
   flag cannot become a way round a subscription.

   Two kinds of flag:
     live      a shipped feature, on by default, that can be switched off
               without a revert (a data-driven section that misbehaves)
     planned   a feature in development, OFF. A planned flag being on shows
               nothing by itself: the feature has to ship first, and
               lib/edgedesk_plans.js lists it as planned until it does.

   OVERRIDES are for checking a page, not for configuration: ?ff=name:0 or
   ?ff=name:1 (comma-separated) on the URL, for this page view only, and only
   for a name listed below. Nothing is stored.

   Browser: window.EDFlags. Node: require('./edgedesk_flags.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDFlags = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var X = {};

  X.FLAGS = {
    /* the landing page's #free section: today's games and the latest research */
    home_free_section: { on: true, kind: 'live' },
    /* /today/ reads public_home_board() for EdgeDesk's public read per game */
    today_live_data: { on: true, kind: 'live' },
    /* Phase 4 (docs/product-led-growth/PLAN.md): a signed-in reader without a
       subscription gets a free dashboard instead of the locked terminal */
    free_accounts: { on: false, kind: 'planned' },
    /* Phase 4: free accounts save a limited number of games (database quota) */
    free_saved_research: { on: false, kind: 'planned' }
  };

  function overrides(search) {
    var out = {};
    var m = /[?&]ff=([^&#]*)/.exec(String(search || ''));
    if (!m) return out;
    var raw = '';
    try { raw = decodeURIComponent(m[1]); } catch (e) { return out; }
    raw.split(',').forEach(function (pair) {
      var p = pair.split(':'), name = p[0], val = p[1];
      if (!Object.prototype.hasOwnProperty.call(X.FLAGS, name)) return;
      if (val === '1') out[name] = true;
      else if (val === '0') out[name] = false;
    });
    return out;
  }

  /* on(name[, search]) — the flag's default, or this page view's override.
     An unknown name is off. */
  X.on = function (name, search) {
    if (!Object.prototype.hasOwnProperty.call(X.FLAGS, name)) return false;
    var s = search;
    if (s == null) { try { s = root && root.location ? root.location.search : ''; } catch (e) { s = ''; } }
    var o = overrides(s);
    return Object.prototype.hasOwnProperty.call(o, name) ? o[name] : !!X.FLAGS[name].on;
  };
  X._overrides = overrides;

  return X;
});

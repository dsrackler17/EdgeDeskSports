/* ===========================================================================
   EdgeDesk CFB — THE GOVERNANCE CHAMPION'S NUMBERS, for the one engine call
   every CFB surface shares (football/cfb_p4/engine.js projectGame).

   The CFB champion is whatever football/cfb_lab/governance says it is, and
   only a person changes it (governance.js promote, behind the promotion
   guard). Until now that changed nothing a reader saw: the board, the slate,
   the record, the AI and the articles all priced V1 (cfb_p4) whatever the
   governance said. This file closes that gap without re-running any other
   model in a browser:

     football/cfb_production/champion.js builds, every lab hour, a TABLE of
     the champion's stored pregame numbers per game (football/cfb_production/
     reports/champion.json). When V1 is champion the table is empty and
     nothing anywhere changes.

     load(table) holds it; entryFor(gameId, nowMs) returns a game's entry only
     when the number was computed before its kickoff and is fresh (a pregame
     number stays the game's number once it kicks off, as a published line
     does). Every other game falls back to V1, game by game (the production
     manifest's FALLBACK_MODEL level), and says so.

   It never computes a model number. It carries the champion's own: margin,
   total, win probability, its interval, and the distribution it publishes,
   so a cover probability is read off THAT distribution:

     key_number   the model loop's (model_loop/core/distribution.py
                  KeyNumberMargin): P(M = k) proportional to
                  exp(-((k - mu') / sigma)^2 / 2) x mult[|k|] on -kmax..kmax,
                  mu' solved so the mean is the margin

   A distribution kind it does not know returns null, and the engine keeps
   its own shape centred on the champion's margin and width, as the
   promoted live calibration does.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCfbChampion = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var SCHEMA = 'edgedesk_cfb_champion_v1';
  /* a stored number older than this is not offered (the lab builds hourly,
     the model loop at least daily) */
  var MAX_AGE_H = 30;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(t) { var v = t == null ? NaN : Date.parse(t); return isFinite(v) ? v : null; }

  /* ------------------------------------------------ the key-number family */
  function keyNumberDist(D) {
    var kmax = D.kmax, sigma = D.sigma, n = 2 * kmax + 1, mult = new Array(kmax + 1), i;
    for (i = 0; i <= kmax; i++) mult[i] = i < D.mult.length ? D.mult[i] : 1;
    function raw(shift) {
      var p = new Array(n), s = 0, j, k, z;
      for (j = 0; j < n; j++) { k = j - kmax; z = (k - shift) / sigma; p[j] = Math.exp(-0.5 * z * z) * mult[Math.abs(k)]; s += p[j]; }
      for (j = 0; j < n; j++) p[j] /= s;
      return p;
    }
    function moments(p) {
      var m = 0, v = 0, j;
      for (j = 0; j < n; j++) m += p[j] * (j - kmax);
      for (j = 0; j < n; j++) v += p[j] * (j - kmax - m) * (j - kmax - m);
      return { mean: m, sd: Math.sqrt(v) };
    }
    function pmf(mu) {
      var s2 = sigma * sigma, shift = mu, it, mo, err;
      for (it = 0; it < 50; it++) {
        mo = moments(raw(shift)); err = mu - mo.mean;
        shift += err * s2 / Math.max(mo.sd * mo.sd, 1e-6 * s2);
        if (Math.abs(err) < 1e-10) break;
      }
      return raw(shift);
    }
    /* smallest h with P(|M - mu| <= h) >= mass, whole margins spread evenly over [k - 1/2, k + 1/2) */
    function centralHalfwidth(mu, mass, p) {
      p = p || pmf(mu);
      var lo = 0, hi = kmax, it, h, a, b, cov, j, k, w;
      for (it = 0; it < 50; it++) {
        h = 0.5 * (lo + hi); a = mu - h; b = mu + h; cov = 0;
        for (j = 0; j < n; j++) { k = j - kmax; w = Math.min(k + 0.5, b) - Math.max(k - 0.5, a); if (w > 0) cov += p[j] * Math.min(w, 1); }
        if (cov >= mass) hi = h; else lo = h;
      }
      return hi;
    }
    /* the home side against a BOOK line (negative = home favoured): it covers
       when margin + line > 0. win / push / lose are unconditional and sum to 1
       (the engine's cover convention) */
    function coverHome(mu, homeLine, p) {
      p = p || pmf(mu);
      var win = 0, push = 0, j, x;
      for (j = 0; j < n; j++) { x = j - kmax + homeLine; if (x > 1e-9) win += p[j]; else if (Math.abs(x) <= 1e-9) push += p[j]; }
      return { win: win, push: push, lose: Math.max(0, 1 - win - push) };
    }
    return { pmf: pmf, moments: moments, centralHalfwidth: centralHalfwidth, coverHome: coverHome, kmax: kmax };
  }

  /* ------------------------------------------------------------ the table */
  var TABLE = null, DISTS = {};
  function load(table) {
    TABLE = table && table.schema === SCHEMA && table.games && typeof table.games === 'object' ? table : null;
    DISTS = {};
    return !!TABLE;
  }
  function table() { return TABLE; }
  /* the champion's entry for one game, or null (V1 prices it): only a number
     computed before kickoff, while it is fresh */
  function entryFor(gameId, nowMs) {
    if (!TABLE || gameId == null) return null;
    var e = TABLE.games[String(gameId)];
    if (!e || !isNum(e.margin) || !isNum(e.p_home) || !e.model_version) return null;
    var now = isNum(nowMs) ? nowMs : Date.now(), asOf = ms(e.as_of), kick = ms(e.kickoff);
    if (asOf === null || now - asOf > MAX_AGE_H * 3600000 || asOf > now) return null;
    if (kick !== null && !(asOf < kick)) return null;
    return e;
  }
  function distOf(e) {
    var D = e && e.distribution;
    if (!D || D.kind !== 'key_number' || !isNum(D.sigma) || !isNum(D.kmax) || !Array.isArray(D.mult)) return null;
    var key = D.sigma + '|' + D.kmax + '|' + D.mult.join(',');
    return DISTS[key] || (DISTS[key] = keyNumberDist(D));
  }
  /* the champion's own cover against a MARGIN line (the engine's
     convention: req.market.spread_line is a home margin, + = home favoured):
     P(M > L), P(M = L), P(M < L); null when the entry publishes no
     distribution this file knows */
  function coverMargin(e, marginLine) {
    var K = distOf(e);
    if (!K || !isNum(marginLine)) return null;
    var c = K.coverHome(e.margin, -marginLine);
    return { win: c.win, push: c.push, lose: c.lose, basis: 'champion:' + e.distribution.kind };
  }

  return { SCHEMA: SCHEMA, MAX_AGE_H: MAX_AGE_H, keyNumberDist: keyNumberDist, load: load, table: table, entryFor: entryFor, coverMargin: coverMargin };
});

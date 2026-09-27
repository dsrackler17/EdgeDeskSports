/* ============================================================================
   EdgeDesk CFB — market intelligence, price discovery and bet timing
   (browser + node, ES5, no dependencies beyond the decision engine).
   docs/cfb-market/METHODS.md · docs/cfb-market/DELIVERABLE.md

   The football model says what a game is worth (engine.js pure()). This layer
   says what the market is offering, how it got there and how good each price
   is. The decision engine (football/cfb_decision/decision.js) decides whether
   to act; this layer never changes a football number and never sets a status.

     canonicalQuote(q)                   a Lab quote -> canonical side quotes (HOME MARGIN convention)
     keyPmf / outcomeProbs / keyNumbers  the frozen key-number distribution (pure t + key masses)
     halfPointValue, altLinePrices       the value of each half point; alternate-line fair prices
     comparePricePoint, bestEvQuote      better number at worse juice vs worse number at better juice
     impliedMargin                       a quote's price-adjusted implied home margin
     consensusSnapshot, snapshotSeries   point-in-time consensus (median, weighted, trimmed, best, stale)
     trueOpener, closingLine             first individual / first robust opener; the close
     movement, lineVelocity              from open, from previous, velocity, books moving, key crossings
     coordinatedMoves                    books moving together (never called "steam" or "sharp")
     reverseLineMovement                 INERT: EdgeDesk has no ticket or money percentages
     lineResistance, marketDisagreement  measurable repeated behaviour; dispersion -> uncertainty
     providerConflicts, staleQuotes      preserve both feeds; deterministic stale status
     staleDataFailsafe                   MARKET_DATA_STALE: nothing actionable from an old quote
     modelMarketGap, modelEdgeVsPriceEdge, keyNumberCrossingAlert, priceDeterioration, doNotChase
     marketEvents, contradictionAlert, largeGapChecks, informationEvent, marketMaturity
     challengerMargin                    the Lab's market-informed CHALLENGER (never the fair line)
     clvScorecard, clvBySignal, timingScorecard, waitComparison, decisionLatency
     marketCard, auditMarketLanguage     clean public output; no internet mythology

   SIGNS (engine.js, lab_core.js): a MARGIN is home minus away; a book home line
   of -7 is home laying 7 and home_market_margin = +7. Conversion happens once.
   A price is never assumed in a live output: without a captured price, EV is null.
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDCfbMarket = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var ENGINE_ID = 'edgedesk_cfb_market_intel';
  var ENGINE_VERSION = 'cfb_market_intel_v1';
  var KMAX = 120;
  var KEYS = [3, 7, 10, 14];
  var CURRENT_MAX_AGE_H = 36;          /* lab_core.marketAt: a quote older than this is not in the market */
  var CLOSE_WINDOW_MIN = 180;          /* lab_core.closeFrom */
  var FAILSAFE_MINUTES = 180;          /* the decision policy's stale_minutes */

  /* ------------------------------------------------------ dependencies */
  var DEC = root.EDCfbDecision || null;
  var INTEG = root.EDCfbIntegrity || null;            /* football/cfb_lab/integrity.js: validity, outliers, true age, freshness */
  var ART = { key: null, books: null, challenger: null };
  if (typeof require === 'function') {
    try { DEC = DEC || require('../cfb_decision/decision.js'); } catch (e) { /* browser: load decision.js first */ }
    try { INTEG = INTEG || require('../cfb_lab/integrity.js'); } catch (e) { /* browser: load integrity.js first */ }
    try { ART.key = require('./artifacts/key_numbers_v1.json'); } catch (e) { /* set with setArtifacts */ }
    try { ART.books = require('./artifacts/book_quality_v1.json'); } catch (e) { /* optional */ }
    try { ART.challenger = require('./artifacts/challenger_v1.json'); } catch (e) { /* optional */ }
  }
  function setArtifacts(a) { a = a || {}; if (a.key) ART.key = a.key; if (a.books) ART.books = a.books; if (a.challenger) ART.challenger = a.challenger; }
  function need() { if (!DEC) throw new Error('EDCfbDecision (football/cfb_decision/decision.js) must be loaded first'); return DEC; }
  function integ() { if (!INTEG) throw new Error('EDCfbIntegrity (football/cfb_lab/integrity.js) must be loaded first'); return INTEG; }
  /* the odds freshness limit (hours) at a given time to kickoff: integrity.FRESHNESS.odds (METRICS §14) */
  function oddsLimitH(hoursToKickoff) { return integ().FRESHNESS.odds.max_age_h(hoursToKickoff); }
  /* a quote's TRUE age in minutes: the older of our observation and the provider's own update (integrity.quoteAgeH) */
  function trueAgeMin(q, asOf) { var h = integ().quoteAgeH(q, asOf); return isNum(h) ? h * 60 : null; }
  /* unrounded American price from a payout (analysis values; display rounding is the caller's) */
  function toAmerican(b) { return isNum(b) && b > 0 ? (b >= 1 ? 100 * b : -100 / b) : null; }

  /* ----------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); return Math.round(x * m) / m; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function sortNum(xs) { return xs.filter(isNum).slice().sort(function (a, b) { return a - b; }); }
  function median(xs) { xs = sortNum(xs); if (!xs.length) return null; var m = Math.floor(xs.length / 2); return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; }
  function quantile(xs, q) { xs = sortNum(xs); if (!xs.length) return null; var pos = (xs.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo); }
  function iqr(xs) { xs = sortNum(xs); return xs.length ? quantile(xs, 0.75) - quantile(xs, 0.25) : null; }
  function mean(xs) { xs = xs.filter(isNum); if (!xs.length) return null; var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; }
  function sd(xs) { xs = xs.filter(isNum); if (xs.length < 2) return null; var m = mean(xs), s = 0; for (var i = 0; i < xs.length; i++) s += (xs[i] - m) * (xs[i] - m); return Math.sqrt(s / (xs.length - 1)); }
  function trimmedMean(xs, frac) {
    xs = sortNum(xs); if (!xs.length) return null;
    var k = Math.floor((frac == null ? 0.2 : frac) * xs.length);
    return xs.length - 2 * k > 0 ? mean(xs.slice(k, xs.length - k)) : median(xs);
  }
  function weightedMedian(xs, ws) {
    var pairs = [], i, tot = 0, c = 0;
    for (i = 0; i < xs.length; i++) if (isNum(xs[i]) && isNum(ws[i]) && ws[i] > 0) pairs.push([xs[i], ws[i]]);
    if (!pairs.length) return null;
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    for (i = 0; i < pairs.length; i++) tot += pairs[i][1];
    for (i = 0; i < pairs.length; i++) { c += pairs[i][1]; if (c >= 0.5 * tot - 1e-12) return pairs[i][0]; }
    return pairs[pairs.length - 1][0];
  }
  function isInt(x) { return isNum(x) && Math.abs(x - Math.round(x)) < 1e-9; }
  function bookToMargin(homeLine) { return isNum(homeLine) ? (homeLine === 0 ? 0 : -homeLine) : null; }
  function sideLine(side, homeLine) { if (!isNum(homeLine)) return null; return side === 'AWAY' ? (homeLine === 0 ? 0 : -homeLine) : homeLine; }
  function homeLineFromSide(side, line) { if (!isNum(line)) return null; return side === 'AWAY' ? (line === 0 ? 0 : -line) : line; }
  function payout(a) { return need().americanToPayout(num(a)); }
  function decimalOf(a) { var b = payout(a); return b == null ? null : 1 + b; }
  function betterPrice(a, b) { var pa = payout(a), pb = payout(b); if (pa == null) return false; if (pb == null) return true; return pa > pb; }
  function medianPrice(prices) {
    var ds = prices.map(decimalOf).filter(isNum);
    if (!ds.length) return null;
    var d = median(ds), a = d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
    return a < 0 ? -Math.round(-a) : Math.round(a);
  }
  function freeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); } return o; }

  /* =================================================== canonical format */
  /* One Lab quote (lab_core / cfb_lab_market_quotes row) -> canonical side
     quotes. Spread: HOME and AWAY, each with the SAME home_market_margin
     (= -home_line). Total: OVER and UNDER at the total. Moneyline: HOME/AWAY. */
  function canonicalQuote(q) {
    if (!q) return [];
    var base = { game_id: q.game_id == null ? null : String(q.game_id), sportsbook: q.book || null, source: q.source || null,
      market_type: q.market_type || null, quote_id: q.quote_id || null,
      quote_timestamp: iso(q.observed_at), provider_timestamp: iso(q.provider_updated_at), received_timestamp: iso(q.retrieved_at || q.observed_at),
      is_provider_open: !!q.is_provider_open, is_provider_close: !!q.is_provider_close };
    function row(side, line, price, hm) {
      var a = num(price), d = a == null ? null : decimalOf(a);
      return Object.assign({}, base, { side: side, line: line, home_market_margin: hm, american_odds: a,
        decimal_odds: r(d, 6), implied_probability_raw: d ? r(1 / d, 6) : null });
    }
    var hl = num(q.home_line), t = num(q.total_points);
    if (q.market_type === 'spread' && isNum(hl)) {
      var hm = bookToMargin(hl);
      return [row('HOME', hl, q.price_home, hm), row('AWAY', sideLine('AWAY', hl), q.price_away, hm)];
    }
    if (q.market_type === 'total' && isNum(t)) return [row('OVER', t, q.price_over, null), row('UNDER', t, q.price_under, null)];
    if (q.market_type === 'moneyline') return [row('HOME', null, q.price_home, null), row('AWAY', null, q.price_away, null)];
    return [];
  }
  /* a displayed side number -> the home margin the market prices: 'HOME -4.5' and 'AWAY +4.5' are both +4.5 */
  function sideToHomeMargin(side, line) { return bookToMargin(homeLineFromSide(side, line)); }

  /* ================================================ the key distribution */
  function table(t) {
    t = t || ART.key;
    if (!t || !t.multipliers) throw new Error('no key-number artifact: football/cfb_market/artifacts/key_numbers_v1.json');
    if (t._mult) return t;
    var m = [], ot = [], i, s = 0;
    for (i = 0; i <= KMAX; i++) m.push(i < t.multipliers.length ? t.multipliers[i] : (isNum(t.tail_multiplier) ? t.tail_multiplier : 1));
    for (i = 0; i <= KMAX; i++) { ot.push(i < (t.overtime_distribution || []).length ? t.overtime_distribution[i] : 0); s += ot[i]; }
    for (i = 0; i <= KMAX; i++) ot[i] = s > 0 ? ot[i] / s : 0;
    Object.defineProperty(t, '_mult', { value: m, enumerable: false });
    Object.defineProperty(t, '_ot', { value: ot, enumerable: false });
    return t;
  }
  function pmfT(mu, sigma, df) {
    var n = 2 * KMAX + 1, P = new Array(n), tc = need().tCdf, first = tc((-KMAX - 0.5 - mu) / sigma, df), prev = first, cur, i;
    for (i = 0; i < n; i++) { cur = tc((-KMAX + i + 0.5 - mu) / sigma, df); P[i] = cur - prev; prev = cur; }
    P[0] += first; P[n - 1] += 1 - prev;
    return P;
  }
  function untie(P, ot) {
    var c = KMAX, m0 = P[c], k;
    P[c] = 0;
    for (k = 1; k <= KMAX; k++) { P[c + k] += m0 * ot[k] / 2; P[c - k] += m0 * ot[k] / 2; }
    return P;
  }
  function payers(k, kernel) {
    var out = [], d, w, lo, hi;
    for (d = 1; d <= kernel.length; d++) {
      w = kernel[d - 1]; lo = k - d; hi = k + d;
      if (lo >= 1) { out.push([lo, w / 2]); if (hi <= KMAX) out.push([hi, w / 2]); }
      else if (hi <= KMAX) out.push([hi, w]);
    }
    return out;
  }
  function localAdjust(P, mult, kernel) {
    var c = KMAX, out = P.slice(), sgn, j, Q, dl, R, pb, b, s = 0, i;
    for (var si = 0; si < 2; si++) {
      sgn = si === 0 ? 1 : -1;
      Q = []; dl = []; R = [];
      for (j = 0; j < KMAX; j++) { Q.push(P[c + sgn * (j + 1)]); dl.push((mult[j + 1] - 1) * Q[j]); R.push(Q[j] + dl[j]); }
      for (j = 0; j < KMAX; j++) {
        if (dl[j] === 0) continue;
        pb = payers(j + 1, kernel);
        for (b = 0; b < pb.length; b++) R[pb[b][0] - 1] -= pb[b][1] * dl[j];
      }
      for (j = 0; j < KMAX; j++) out[c + sgn * (j + 1)] = R[j];
    }
    for (i = 0; i < out.length; i++) { if (out[i] < 0) out[i] = 0; s += out[i]; }
    for (i = 0; i < out.length; i++) out[i] /= s;
    return out;
  }
  /* P(final home margin == k), k = -120..120: the pure t (mean mu, sigma, df)
     discretised, tie mass to overtime margins, local key-number masses. */
  function keyPmf(mu, sigma, df, t) {
    if (!isNum(mu) || !isNum(sigma) || sigma <= 0) return null;
    t = table(t);
    var P = pmfT(mu, sigma, isNum(df) ? df : 100);
    if (t.method === 't') return P;
    if (t.method === 'global') {
      var s = 0, i, ks;
      for (i = 0; i < P.length; i++) { ks = Math.abs(i - KMAX); P[i] *= t._mult[ks]; s += P[i]; }
      for (i = 0; i < P.length; i++) P[i] /= s;
      return P;
    }
    P = untie(P, t._ot);
    if (t.method === 't_untied') return P;
    return localAdjust(P, t._mult, t.kernel || [3 / 6, 2 / 6, 1 / 6]);
  }
  /* win / push / loss of a side at a book HOME line (home covers when margin + home_line > 0) */
  function outcomeProbs(P, homeLine, side) {
    if (!P || !isNum(homeLine)) return null;
    var L = bookToMargin(homeLine), above = 0, below = 0, push = 0, i, k;
    for (i = 0; i < P.length; i++) { k = i - KMAX; if (k > L + 1e-9) above += P[i]; else if (k < L - 1e-9) below += P[i]; else push += P[i]; }
    var win = side === 'AWAY' ? below : above, loss = side === 'AWAY' ? above : below;
    return { win: win, push: push, loss: loss, cover_no_push: win + loss > 0 ? win / (win + loss) : null };
  }
  function evAt(o, american) {
    var b = payout(american);
    return (!o || b == null) ? null : o.win * b - o.loss;
  }
  function priceForEv(o, target) {
    if (!o || !(o.win > 0)) return null;
    return toAmerican((target + o.loss) / o.win);
  }
  function fairPrice(o) { return o && o.win > 0 ? toAmerican(o.loss / o.win) : null; }
  function cents(american, ref) { if (!isNum(american)) return null; ref = isNum(ref) ? ref : -110; var f = function (a) { return a < 0 ? a + 100 : a - 100; }; return f(american) - f(ref); }
  function pureDist(pure, t) { return keyPmf(num(pure && pure.projected_margin), num(pure && pure.sigma), num(pure && pure.t_df), t); }

  /* the frozen DEV key-number table: landing shares and the half-point value in cents at -110 */
  function keyNumbers(t) {
    t = table(t);
    return { method: t.method, keys: KEYS.slice(), landing_dev_abs_margin: t.landing_dev_abs_margin || [],
      half_point_cents_at_minus_110: t.half_point_cents_at_minus_110 || t['half_point_cents_at_-110'] || [],
      source: 'football/cfb_market/artifacts/key_numbers_v1.json (DEV 2016-2023, FBS vs FBS)' };
  }

  /* the value of half a point either way from a side's number, at a price */
  function halfPointValue(pure, homeLine, side, price, t) {
    var P = pureDist(pure, t);
    if (!P || !isNum(homeLine)) return null;
    var sl = sideLine(side, homeLine), ref = isNum(num(price)) ? num(price) : null;
    function at(slx) { return outcomeProbs(P, homeLineFromSide(side, slx), side); }
    var cur = at(sl), better = at(sl + 0.5), worse = at(sl - 0.5);
    function step(o, dir) {
      var crossed = dir > 0 ? (isInt(sl) ? sl : sl + 0.5) : (isInt(sl) ? sl : sl - 0.5);
      var evRef = ref == null ? null : evAt(cur, ref);
      return { line: dir > 0 ? sl + 0.5 : sl - 0.5, integer_in_step: Math.abs(crossed), key_number: KEYS.indexOf(Math.abs(crossed)) >= 0,
        cover_no_push: r(o.cover_no_push), push: r(o.push),
        ev_at_price: ref == null ? null : r(evAt(o, ref)), ev_change: ref == null ? null : r(evAt(o, ref) - evRef),
        equivalent_price: ref == null ? null : r(priceForEv(o, evRef), 1),
        cents: ref == null ? null : r(Math.abs(cents(priceForEv(o, evRef), ref)), 1) };
    }
    return { side: side, line: sl, price: ref, price_captured: ref != null, cover_no_push: r(cur.cover_no_push), push: r(cur.push),
      ev_at_price: ref == null ? null : r(evAt(cur, ref)), half_point_better: step(better, 1), half_point_worse: step(worse, -1) };
  }

  /* EdgeDesk's fair price for every alternate line from ONE distribution; an
     offered price is judged by EV only (never by how "safe" a line looks). */
  function altLinePrices(pure, homeLines, offered, t) {
    var P = pureDist(pure, t);
    if (!P) return [];
    offered = offered || {};
    return (homeLines || []).map(function (hl) {
      var h = outcomeProbs(P, hl, 'HOME'), a = outcomeProbs(P, hl, 'AWAY');
      var oh = offered[String(hl)] || {};
      return { home_line: hl, home: { p_win: r(h.win), p_push: r(h.push), p_loss: r(h.loss), fair_price: r(fairPrice(h), 1),
                                      offered_price: num(oh.price_home), ev: isNum(num(oh.price_home)) ? r(evAt(h, num(oh.price_home))) : null },
               away: { p_win: r(a.win), p_push: r(a.push), p_loss: r(a.loss), fair_price: r(fairPrice(a), 1),
                       offered_price: num(oh.price_away), ev: isNum(num(oh.price_away)) ? r(evAt(a, num(oh.price_away))) : null } };
    });
  }

  /* +3 -125 vs +3.5 -110: exact EV of each under EdgeDesk's distribution */
  function comparePricePoint(pure, quoteA, quoteB, side, t) {
    var P = pureDist(pure, t);
    if (!P) return null;
    function one(q) {
      var price = side === 'AWAY' ? num(q.price_away) : num(q.price_home), o = outcomeProbs(P, num(q.home_line), side);
      return { book: q.book || null, line: sideLine(side, num(q.home_line)), price: price, cover_no_push: r(o && o.cover_no_push), push: r(o && o.push),
               ev: isNum(price) ? r(evAt(o, price)) : null };
    }
    var a = one(quoteA), b = one(quoteB);
    var better = (!isNum(a.ev) || !isNum(b.ev)) ? 'UNKNOWN_PRICE' : (Math.abs(a.ev - b.ev) < 1e-9 ? 'EQUAL' : (a.ev > b.ev ? 'A' : 'B'));
    return { side: side, a: a, b: b, better: better, ev_difference: isNum(a.ev) && isNum(b.ev) ? r(a.ev - b.ev) : null,
      note: 'exact EV under the pure key-number distribution; the number alone never decides' };
  }
  /* the best EXPECTED-VALUE quote for a side among enabled, fresh, priced books */
  function bestEvQuote(pure, quotes, side, t, opts) {
    opts = opts || {};
    var P = pureDist(pure, t), now = ms(opts.now), en = opts.enabled_books ? opts.enabled_books.map(String) : null;
    if (!P) return null;
    var cands = (quotes || []).filter(function (q) {
      if (!q || q.market_type !== 'spread' || !isNum(num(q.home_line))) return false;
      if (en && en.indexOf(String(q.book)) < 0) return false;
      if (isNum(now) && (now - ms(q.observed_at)) / 60000 > (opts.stale_minutes || FAILSAFE_MINUTES)) return false;
      return true;
    }).map(function (q) {
      var price = side === 'AWAY' ? num(q.price_away) : num(q.price_home), o = outcomeProbs(P, num(q.home_line), side);
      return { book: q.book, quote_id: q.quote_id || null, line: sideLine(side, num(q.home_line)), price: price,
               cover_no_push: r(o.cover_no_push), push: r(o.push), ev: isNum(price) ? r(evAt(o, price)) : null };
    });
    var priced = cands.filter(function (c) { return isNum(c.ev); }).sort(function (x, y) { return (y.ev - x.ev) || (y.line - x.line); });
    var bestLine = cands.slice().sort(function (x, y) { return (y.line - x.line) || (betterPrice(y.price, x.price) ? 1 : -1); })[0] || null;
    return { side: side, best_expected_value_quote: priced[0] || null, best_number: bestLine, considered: cands.length,
      unpriced: cands.length - priced.length, note: priced.length ? null : 'no captured price: EV is not computed and no quote is ranked by EV' };
  }

  /* the home margin at which a quote's no-vig probability would be fair,
     under the key distribution centred there with the market's width */
  function impliedMargin(homeLine, priceHome, priceAway, t, sigmaMarket) {
    var hl = num(homeLine);
    if (!isNum(hl)) return null;
    var tb = table(t), sg = isNum(sigmaMarket) ? sigmaMarket : (ART.books && ART.books.sigma_market) || 15.7;
    var dv = need().devig(num(priceHome), num(priceAway)), p = dv ? dv.p_a : 0.5, L = bookToMargin(hl);
    function pc(mu) { var o = outcomeProbs(keyPmf(mu, sg, 100, tb), hl, 'HOME'); return o.cover_no_push; }
    var lo = L - 8, hi = L + 8, i, mid;
    if (p <= pc(lo)) return lo;
    if (p >= pc(hi)) return hi;
    for (i = 0; i < 40; i++) { mid = (lo + hi) / 2; if (pc(mid) < p) lo = mid; else hi = mid; }
    return r((lo + hi) / 2, 4);
  }

  /* ================================================ consensus snapshots */
  function isRealBook(b) { return !!b && String(b).toLowerCase() !== 'consensus'; }
  function ordinarySpread(q) {
    return q && q.market_type === 'spread' && q.is_pregame !== false && !q.is_provider_open && !q.is_provider_close
      && isNum(num(q.home_line)) && ms(q.observed_at) !== null;
  }
  function latestPerBook(qs) {
    var by = {};
    qs.forEach(function (q) {
      var k = q.source + ':' + q.book, cur = by[k];
      if (!cur || ms(q.observed_at) > ms(cur.observed_at) || (ms(q.observed_at) === ms(cur.observed_at) && String(q.quote_id) < String(cur.quote_id))) by[k] = q;
    });
    return Object.keys(by).sort().map(function (k) { return by[k]; });
  }
  function bookWeight(book, opts) {
    var w = opts && opts.weights, a = ART.books;
    if (w && isNum(w[book])) return w[book];
    if (opts && opts.use_artifact_weights && a && a.weights_active && a.books && a.books[book]) return a.books[book].consensus_weight;
    return 1;
  }
  /* The market as a snapshot at `asOf` sees it: each (source, book)'s latest
     ordinary pregame spread quote observed by then and within 36 h (the Lab's
     marketAt selection); provider averages drop out when a real book is
     present. The integrity rules are integrity.js's, never re-implemented here:
       * a quote that fails integrity.validateQuote, is quarantined
         (opts.quarantined_ids) or is a MAD outlier integrity.assessMarket
         isolates is listed but never enters the consensus;
       * a book is STALE when its TRUE age (integrity.quoteAgeH) exceeds the
         odds freshness limit (integrity.FRESHNESS.odds: 6 h inside 48 h of
         kickoff, else 36 h); it is counted but never moves the consensus;
       * `integrity` carries assessMarket's verdict (status, actionable_status,
         reasons) unchanged. */
  function consensusSnapshot(quotes, asOf, kickoff, opts) {
    opts = opts || {};
    var I = integ(), t = ms(asOf), k = ms(kickoff);
    var sp = (quotes || []).filter(function (q) {
      var o = ms(q.observed_at);
      return ordinarySpread(q) && o <= t && (k === null || o < k) && (t - o) <= CURRENT_MAX_AGE_H * 3600000;
    });
    var per = latestPerBook(sp), real = per.filter(function (q) { return isRealBook(q.book); });
    var used = real.length ? real : per;
    var hours = k === null ? null : (k - t) / 3600000;
    var staleH = isNum(opts.stale_hours) ? opts.stale_hours : oddsLimitH(hours);
    var verdict = I.assessMarket(sp, iso(t), { kickoff: iso(k), quarantinedIds: opts.quarantined_ids || {} });
    var excluded = {};
    (verdict.outlier_quote_ids || []).concat(verdict.invalid_quote_ids || [], verdict.quarantined_used || []).forEach(function (id) { excluded[id] = 1; });
    var books = used.map(function (q) {
      var age = trueAgeMin(q, t), bad = !!excluded[q.quote_id];
      return { book: q.book, source: q.source, quote_id: q.quote_id || null, home_line: num(q.home_line),
        price_home: num(q.price_home), price_away: num(q.price_away), observed_at: iso(q.observed_at),
        provider_updated_at: iso(q.provider_updated_at), age_minutes: r(age, 1), stale: !isNum(age) || age > staleH * 60,
        integrity_excluded: bad, weight: bookWeight(q.book, opts) };
    });
    var fresh = books.filter(function (b) { return !b.stale && !b.integrity_excluded; });
    var out = { engine: ENGINE_ID, engine_version: ENGINE_VERSION, as_of: iso(t), kickoff_ts: iso(k),
      hours_to_kickoff: r(hours, 3), n_books_seen: books.length, n_active_books: fresh.length,
      stale_book_count: books.filter(function (b) { return b.stale && !b.integrity_excluded; }).length,
      integrity_excluded_count: books.filter(function (b) { return b.integrity_excluded; }).length,
      freshness_limit_hours: staleH, books: books,
      integrity: { rule: verdict.rule, status: verdict.status, actionable_status: verdict.actionable_status, reasons: verdict.reasons.slice(),
        outlier_quote_ids: (verdict.outlier_quote_ids || []).slice(), newest_true_age_h: verdict.newest_true_age_h },
      status: fresh.length ? 'OK' : (books.length ? 'ALL_STALE_OR_EXCLUDED' : 'NO_QUOTES') };
    if (!fresh.length) return freeze(out);
    var lines = fresh.map(function (b) { return b.home_line; }), ws = fresh.map(function (b) { return b.weight; });
    var med = median(lines), disp = iqr(lines), sdl = sd(lines);
    out.median_home_line = med;
    out.weighted_median_home_line = weightedMedian(lines, ws);
    out.mean_home_line = r(mean(lines), 4);
    out.trimmed_mean_home_line = r(trimmedMean(lines, 0.2), 4);
    out.consensus_margin = bookToMargin(med);
    out.dispersion_iqr = r(disp, 3);
    out.dispersion_sd = r(sdl, 3);
    /* uncertainty of the consensus number itself: one book = 0.5 pt (the archive's typical single-book deviation
       is 0.2-0.4 pt); several books = the larger of IQR/1.349 and SD/sqrt(n); +0.25 pt per stale book */
    var base = fresh.length < 2 ? 0.5 : Math.max(disp / 1.349, (sdl || 0) / Math.sqrt(fresh.length));
    out.consensus_uncertainty = r(base + 0.25 * out.stale_book_count, 3);
    var bh = null, ba = null;
    fresh.forEach(function (b) {
      if (!bh || b.home_line > bh.home_line || (b.home_line === bh.home_line && betterPrice(b.price_home, bh.price_home))) bh = b;
      if (!ba || b.home_line < ba.home_line || (b.home_line === ba.home_line && betterPrice(b.price_away, ba.price_away))) ba = b;
    });
    out.best_home = { book: bh.book, line: bh.home_line, price: bh.price_home };
    out.best_away = { book: ba.book, line: sideLine('AWAY', ba.home_line), price: ba.price_away };
    out.median_price_home = medianPrice(fresh.map(function (b) { return b.price_home; }));
    out.median_price_away = medianPrice(fresh.map(function (b) { return b.price_away; }));
    out.newest_quote_at = iso(Math.max.apply(null, fresh.map(function (b) { return ms(b.observed_at); })));
    out.sources = fresh.map(function (b) { return b.source; }).filter(function (s, i, a) { return a.indexOf(s) === i; }).sort();
    if (opts.implied && ART.key) {
      var im = fresh.map(function (b) { return isNum(b.price_home) && isNum(b.price_away) ? impliedMargin(b.home_line, b.price_home, b.price_away) : bookToMargin(b.home_line); });
      out.median_implied_margin = r(median(im), 4);
    }
    return freeze(out);
  }
  /* a snapshot at every meaningful timestamp (each ordinary quote arrival), reconstructible from the ledger */
  function snapshotSeries(quotes, kickoff, opts) {
    var k = ms(kickoff), seen = {}, ts = [];
    (quotes || []).forEach(function (q) { var o = ms(q.observed_at); if (ordinarySpread(q) && (k === null || o < k) && !seen[o]) { seen[o] = 1; ts.push(o); } });
    ts.sort(function (a, b) { return a - b; });
    return ts.map(function (t) { return consensusSnapshot(quotes, t, kickoff, opts); }).filter(function (s) { return s.status === 'OK'; });
  }

  /* first individual opener (each book's earliest ordinary quote, never replaced)
     and the first ROBUST consensus opener: the earliest snapshot with at least
     min_books fresh books from reliable sources that agree within max_iqr. */
  function trueOpener(quotes, kickoff, opts) {
    opts = opts || {};
    var minBooks = isNum(opts.min_books) ? opts.min_books : 2, maxIqr = isNum(opts.max_iqr) ? opts.max_iqr : 1.5;
    var unreliable = opts.unreliable_books || [];
    var k = ms(kickoff), by = {};
    (quotes || []).filter(function (q) { return ordinarySpread(q) && (k === null || ms(q.observed_at) < k); }).forEach(function (q) {
      var key = q.source + ':' + q.book, cur = by[key];
      if (!cur || ms(q.observed_at) < ms(cur.observed_at) || (ms(q.observed_at) === ms(cur.observed_at) && String(q.quote_id) < String(cur.quote_id))) by[key] = q;
    });
    var first = Object.keys(by).sort().map(function (key) { var q = by[key]; return { book: q.book, source: q.source, home_line: num(q.home_line), price_home: num(q.price_home), price_away: num(q.price_away), observed_at: iso(q.observed_at), quote_id: q.quote_id || null }; });
    var ser = snapshotSeries((quotes || []).filter(function (q) { return unreliable.indexOf(q.book) < 0; }), kickoff, opts), robust = null, i;
    for (i = 0; i < ser.length; i++) {
      if (ser[i].n_active_books >= minBooks && (ser[i].dispersion_iqr || 0) <= maxIqr) { robust = ser[i]; break; }
    }
    return freeze({ rule: 'cfb_market_opener_v1', first_individual_openers: first,
      first_robust_consensus_opener: robust ? { as_of: robust.as_of, home_line: robust.median_home_line, consensus_margin: robust.consensus_margin,
        n_books: robust.n_active_books, dispersion_iqr: robust.dispersion_iqr } : null,
      criteria: { min_books: minBooks, max_iqr: maxIqr, freshness: 'the snapshot rule (6 h inside 48 h of kickoff, 36 h before)', unreliable_books_excluded: unreliable },
      note: robust ? null : 'no snapshot has met the robust-opener criteria yet (a one-book market never does)' });
  }
  /* the close: the last valid consensus snapshot in [kickoff - 180 min, kickoff) */
  function closingLine(quotes, kickoff, opts) {
    var k = ms(kickoff);
    var ser = snapshotSeries(quotes, kickoff, opts).filter(function (s) { return ms(s.newest_quote_at) >= k - CLOSE_WINDOW_MIN * 60000; });
    if (!ser.length) {
      var decl = (quotes || []).filter(function (q) { return q.market_type === 'spread' && q.is_provider_close && isNum(num(q.home_line)); });
      var med = median(decl.map(function (q) { return num(q.home_line); }));
      return freeze({ rule: 'cfb_market_close_v1', quality: decl.length ? 'PROVIDER_DECLARED' : 'MISSING', closing_home_line: med,
        closing_consensus_margin: bookToMargin(med), quote_count: decl.length, timestamp: null });
    }
    var c = ser[ser.length - 1];
    return freeze({ rule: 'cfb_market_close_v1', quality: 'OBSERVED', closing_home_line: c.median_home_line, closing_consensus_margin: c.consensus_margin,
      closing_price_home: c.median_price_home, closing_price_away: c.median_price_away, best_closing_home: c.best_home, best_closing_away: c.best_away,
      quote_count: c.n_active_books, timestamp: c.newest_quote_at, window_minutes: CLOSE_WINDOW_MIN });
  }

  /* ========================================================= movement */
  function keyCrossings(prevHomeLine, curHomeLine) {
    if (!isNum(prevHomeLine) || !isNum(curHomeLine) || prevHomeLine === curHomeLine) return [];
    var a = bookToMargin(prevHomeLine), b = bookToMargin(curHomeLine), lo = Math.min(a, b), hi = Math.max(a, b), out = [];
    KEYS.forEach(function (key) {
      [key, -key].forEach(function (kk) {
        /* a key is crossed or reached when it lies in (lo, hi] or [lo, hi) of the move */
        if ((kk > lo && kk <= hi) || (kk >= lo && kk < hi)) out.push({ key: key, side: kk > 0 ? 'HOME_FAVOURED' : 'AWAY_FAVOURED',
          event: (kk === a) ? 'LEFT_KEY' : (kk === b ? 'ONTO_KEY' : 'THROUGH_KEY') });
      });
    });
    return out;
  }
  function movement(series, opts) {
    opts = opts || {};
    var tau = isNum(opts.smoothing_hours) ? opts.smoothing_hours : 3, out = [], vs = 0, first = null;
    (series || []).forEach(function (s, i) {
      var p = i ? series[i - 1] : null, row = { as_of: s.as_of, consensus_margin: s.consensus_margin, home_line: s.median_home_line };
      row.from_open = r(s.consensus_margin - series[0].consensus_margin, 3);
      row.from_previous = p ? r(s.consensus_margin - p.consensus_margin, 3) : 0;
      var dt = p ? (ms(s.as_of) - ms(p.as_of)) / 3600000 : 0;
      var raw = p && dt > 0 ? row.from_previous / dt : 0;
      var a = p && dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
      vs = p ? vs * (1 - a) + a * raw : 0;
      row.velocity_raw_pts_per_hour = r(raw, 4);
      row.line_velocity = r(vs, 4);
      /* one book vs the market: books that changed their number inside the lookback window
         (default 60 min, else since the previous snapshot), against the consensus move over it */
      var win = (isNum(opts.window_minutes) ? opts.window_minutes : 60) * 60000, ref = p, j;
      for (j = i - 1; j >= 0; j--) { if (ms(series[j].as_of) <= ms(s.as_of) - win) { ref = series[j]; break; } }
      var wMove = ref ? s.consensus_margin - ref.consensus_margin : 0;
      var moving = 0, same = 0, dir = Math.sign(wMove);
      if (ref) {
        var pb = {}; ref.books.forEach(function (b) { pb[b.source + ':' + b.book] = b.home_line; });
        s.books.forEach(function (b) {
          var k = b.source + ':' + b.book;
          if (k in pb && pb[k] !== b.home_line) { moving++; if (Math.sign(bookToMargin(b.home_line) - bookToMargin(pb[k])) === dir && dir !== 0) same++; }
        });
      }
      row.window_move = r(wMove, 3);
      row.books_moving = moving;
      row.books_moving_with_consensus = same;
      row.key_crossings = p ? keyCrossings(p.median_home_line, s.median_home_line) : [];
      row.consensus_direction = row.from_previous > 0 ? 'TOWARD_HOME' : (row.from_previous < 0 ? 'TOWARD_AWAY' : 'NONE');
      row.dispersion_change = p && isNum(s.dispersion_iqr) && isNum(p.dispersion_iqr) ? r(s.dispersion_iqr - p.dispersion_iqr, 3) : null;
      row.classification = !p ? 'OPEN' : (row.window_move === 0 ? (moving ? 'ONE_BOOK_MOVED' : 'NO_MOVE')
        : (s.n_active_books < 2 ? 'SINGLE_BOOK_MARKET_MOVED' : (same >= 2 && same >= s.n_active_books / 2 ? 'MARKET_MOVED' : 'ONE_BOOK_MOVED')));
      if (first === null && row.from_open !== 0) first = s.as_of;
      row.time_since_first_move_hours = first === null ? null : r((ms(s.as_of) - ms(first)) / 3600000, 3);
      out.push(row);
    });
    return out;
  }
  function lineVelocity(series, opts) {
    var m = movement(series, opts), last = m[m.length - 1] || null;
    if (!last) return null;
    return { as_of: last.as_of, line_velocity: last.line_velocity, move_from_open: last.from_open,
      books_moving_same_direction: last.books_moving_with_consensus, time_since_first_move_hours: last.time_since_first_move_hours,
      classification: last.classification, note: 'measured movement only; the identity of bettors is not knowable from prices' };
  }
  /* books changing their number in the same direction within a short window */
  function coordinatedMoves(quotes, opts) {
    opts = opts || {};
    var win = (isNum(opts.window_minutes) ? opts.window_minutes : 30) * 60000, minBooks = isNum(opts.min_books) ? opts.min_books : 3;
    var by = {}, changes = [];
    (quotes || []).filter(ordinarySpread).slice().sort(function (a, b) { return ms(a.observed_at) - ms(b.observed_at); }).forEach(function (q) {
      var k = q.source + ':' + q.book, prev = by[k];
      if (prev && num(prev.home_line) !== num(q.home_line)) changes.push({ book: k, t: ms(q.observed_at), delta: bookToMargin(num(q.home_line)) - bookToMargin(num(prev.home_line)) });
      by[k] = q;
    });
    var active = Object.keys(by).length, out = [], used = {};
    changes.forEach(function (c, i) {
      if (used[i]) return;
      var grp = [c]; used[i] = 1;
      for (var j = i + 1; j < changes.length && changes[j].t - c.t <= win; j++) if (!used[j] && changes[j].book !== c.book && Math.sign(changes[j].delta) === Math.sign(c.delta)) { grp.push(changes[j]); used[j] = 1; }
      var booksIn = grp.map(function (g) { return g.book; }).filter(function (b, x, a) { return a.indexOf(b) === x; });
      var frac = active ? booksIn.length / active : 0, mag = median(grp.map(function (g) { return Math.abs(g.delta); }));
      var score = r(frac * Math.min(1, mag / 0.5), 3);
      out.push({ start: iso(c.t), end: iso(grp[grp.length - 1].t), direction: c.delta > 0 ? 'TOWARD_HOME' : 'TOWARD_AWAY', books: booksIn.length,
        active_books: active, median_move_pts: mag, coordinated_move_score: score,
        label: booksIn.length >= minBooks && frac >= 0.5 ? 'COORDINATED_MOVE' : (booksIn.length === 1 ? 'ONE_BOOK_MOVED' : 'PARTIAL_MOVE') });
    });
    return out;
  }
  /* RLM needs ticket or money percentages. EdgeDesk has none, so this is inert;
     with data it is descriptive only and never enters a decision. */
  function reverseLineMovement(split, move) {
    if (!split || (!isNum(num(split.ticket_pct_home)) && !isNum(num(split.money_pct_home)))) {
      return freeze({ status: 'INERT', rlm: null, decision_use: false, reason: 'no public betting data: EdgeDesk has no ticket or money percentages' });
    }
    var tp = num(split.ticket_pct_home), mp = num(split.money_pct_home), mv = num(move && move.from_open);
    var majority = isNum(tp) ? (tp >= 60 ? 'HOME' : (tp <= 40 ? 'AWAY' : null)) : null;
    var against = majority && isNum(mv) && ((majority === 'HOME' && mv <= -0.5) || (majority === 'AWAY' && mv >= 0.5));
    return freeze({ status: 'EXPERIMENTAL', rlm: !!against, ticket_pct_home: tp, money_pct_home: mp, source: split.source || null,
      observed_at: iso(split.observed_at), decision_use: false,
      note: 'descriptive: movement against the ticket majority; it does not identify who bet, and it is not used until a walk-forward test shows incremental value' });
  }
  /* a number the line keeps reaching and leaving without crossing (needs repeated quotes) */
  function lineResistance(series, level, opts) {
    opts = opts || {};
    var minTouches = isNum(opts.min_touches) ? opts.min_touches : 3, lv = Math.abs(level), touches = 0, retreats = 0, crossed = false, prevSide = null, onLevel = false;
    (series || []).forEach(function (s) {
      var x = Math.abs(s.median_home_line), sideNow = x === lv ? 0 : (x < lv ? -1 : 1);
      if (sideNow === 0 && !onLevel) { touches++; onLevel = true; }
      else if (sideNow !== 0) {
        if (onLevel && prevSide !== null && sideNow === prevSide) retreats++;
        if (prevSide !== null && sideNow !== prevSide) crossed = true;
        prevSide = sideNow; onLevel = false;
      }
    });
    var resist = touches >= minTouches && retreats >= minTouches - 1 && !crossed;
    return { level: lv, key_number: KEYS.indexOf(lv) >= 0, touches: touches, retreats: retreats, crossed: crossed,
      status: resist ? 'RESISTANCE' : (touches ? 'INSUFFICIENT_EVIDENCE' : 'NOT_REACHED'),
      note: 'requires ' + minTouches + ' repeated approaches that retreat without crossing; no chart patterns' };
  }
  function marketDisagreement(snap, opts) {
    opts = opts || {};
    var d = snap && snap.dispersion_iqr, n = snap ? snap.n_active_books : 0;
    var cls = !isNum(d) || n < 2 ? 'UNKNOWN_SINGLE_BOOK' : (d <= (opts.agree_iqr || 0.5) ? 'AGREE' : (d <= (opts.max_iqr || 1.5) ? 'MINOR' : 'HIGH'));
    var why = [];
    if (cls === 'HIGH') {
      if (snap.stale_book_count) why.push('stale quotes');
      if (opts.velocity && Math.abs(opts.velocity) > 0.25) why.push('a rapidly moving market');
      if (opts.provider_conflicts) why.push('a provider conflict (data issue)');
      if (!why.length) why.push('books pricing the game differently');
    }
    return { dispersion_iqr: d, n_books: n, class: cls, uncertainty_inflation_pts: cls === 'HIGH' ? r(d / 1.349, 3) : 0,
      possible_causes: why, note: 'high dispersion raises market uncertainty until it resolves; it is never an edge by itself' };
  }
  /* the same book reported by two feeds: keep both, flag, name the likely fresher one */
  function providerConflicts(quotes, opts) {
    opts = opts || {};
    var win = (isNum(opts.window_minutes) ? opts.window_minutes : 60) * 60000, byBook = {}, out = [];
    (quotes || []).filter(ordinarySpread).forEach(function (q) { (byBook[q.game_id + '|' + q.book] = byBook[q.game_id + '|' + q.book] || []).push(q); });
    Object.keys(byBook).sort().forEach(function (k) {
      var qs = byBook[k].slice().sort(function (a, b) { return ms(a.observed_at) - ms(b.observed_at); });
      for (var i = 0; i < qs.length; i++) for (var j = i + 1; j < qs.length; j++) {
        var a = qs[i], b = qs[j];
        if (a.source === b.source || ms(b.observed_at) - ms(a.observed_at) > win) continue;
        var d = Math.abs(num(a.home_line) - num(b.home_line));
        if (d === 0 && num(a.price_home) === num(b.price_home)) continue;
        var ta = ms(a.provider_updated_at) || ms(a.observed_at), tb = ms(b.provider_updated_at) || ms(b.observed_at);
        out.push({ game_id: a.game_id, book: a.book, sources: [a.source, b.source], lines: [num(a.home_line), num(b.home_line)],
          quote_ids: [a.quote_id || null, b.quote_id || null], difference_pts: d, major: d >= (opts.major_pts || 1),
          likely_fresher: tb > ta ? b.source : (ta > tb ? a.source : 'UNKNOWN'), action: 'PRESERVE_BOTH' });
      }
    });
    return out;
  }
  /* deterministic stale status of each book at `asOf` (never "every divergent line is stale") */
  function staleQuotes(quotes, asOf, kickoff, opts) {
    opts = opts || {};
    var t = ms(asOf), snap = consensusSnapshot(quotes, t, kickoff, { stale_hours: 1e9 }), out = [];
    var hours = (ms(kickoff) - t) / 3600000, ageLimit = (isNum(opts.age_hours) ? opts.age_hours : oddsLimitH(hours)) * 60;
    (snap.books || []).forEach(function (b) {
      var others = (snap.books || []).filter(function (x) { return x !== b; });
      var since = ms(b.observed_at);
      /* the others' consensus now vs at the time this book last changed */
      var then = consensusSnapshot(quotes.filter(function (q) { return !(q.book === b.book && q.source === b.source); }), since, kickoff, { stale_hours: 1e9 });
      var now = consensusSnapshot(quotes.filter(function (q) { return !(q.book === b.book && q.source === b.source); }), t, kickoff, { stale_hours: 1e9 });
      var consMoved = then.status === 'OK' && now.status === 'OK' ? Math.abs(now.median_home_line - then.median_home_line) : 0;
      var movedOthers = others.filter(function (x) { return ms(x.observed_at) > since; }).length;
      var aged = b.age_minutes > ageLimit, diverges = now.status === 'OK' ? Math.abs(b.home_line - now.median_home_line) : 0;
      var reasons = [];
      if (aged) reasons.push('quote age ' + b.age_minutes + ' min');
      if (consMoved >= 0.5) reasons.push('consensus of the other books moved ' + consMoved + ' pts since this quote');
      if (others.length && movedOthers >= Math.ceil(2 * others.length / 3)) reasons.push(movedOthers + ' of ' + others.length + ' other books updated since');
      var score = r((aged ? 1 : 0) / 3 + (consMoved >= 0.5 ? 1 : 0) / 3 + (others.length && movedOthers >= Math.ceil(2 * others.length / 3) ? 1 : 0) / 3, 3);
      out.push({ book: b.book, source: b.source, home_line: b.home_line, age_minutes: b.age_minutes, diverges_pts: r(diverges, 3),
        stale_probability: score, status: b.integrity_excluded ? 'INTEGRITY_EXCLUDED' : (score >= 2 / 3 - 1e-9 ? 'STALE' : (diverges >= 1 ? 'DIVERGENT_NOT_STALE' : 'CURRENT')), reasons: reasons,
        note: 'a deterministic score, not a validated probability' });
    });
    return out;
  }
  /* never recommend a wager from a quote that may no longer exist. The limit
     is integrity.FRESHNESS.odds_bet (3 h: the decision policy's stale_minutes)
     on the TRUE age; the codes are integrity.js's actionable codes
     (ACTIONABLE / MARKET_STALE / MARKET_DEGRADED / MARKET_INVALID / MARKET_MISSING).
     A snapshot that carries an integrity verdict keeps its non-actionable code. */
  function staleDataFailsafe(snapOrQuote, now, opts) {
    opts = opts || {};
    var I = integ();
    var lim = isNum(opts.stale_minutes) ? opts.stale_minutes : I.FRESHNESS.odds_bet.max_age_h() * 60;
    var isSnap = !!(snapOrQuote && snapOrQuote.books);
    var age = null;
    if (isSnap) {
      var ages = snapOrQuote.books.filter(function (b) { return !b.integrity_excluded; }).map(function (b) { return trueAgeMin(b, now); }).filter(isNum);
      age = ages.length ? Math.min.apply(null, ages) : null;
    } else if (snapOrQuote && snapOrQuote.observed_at) age = trueAgeMin(snapOrQuote, now);
    var code = !isNum(age) ? 'MARKET_MISSING' : (age > lim || age < -I.BOUNDS.FUTURE_TOLERANCE_MIN ? 'MARKET_STALE' : 'ACTIONABLE');
    var iv = isSnap && snapOrQuote.integrity ? snapOrQuote.integrity.actionable_status : null;
    if (code === 'ACTIONABLE' && iv && iv !== 'ACTIONABLE') code = iv;
    return { actionable: code === 'ACTIONABLE', status: code, display: code === 'MARKET_STALE' ? 'MARKET DATA STALE' : code.replace(/_/g, ' '),
      age_minutes: r(age, 1), limit_minutes: lim, rule: I.RULES.freshness,
      reason: code === 'ACTIONABLE' ? null : (code === 'MARKET_STALE' ? 'the newest usable quote is ' + Math.round(age) + ' min old (true age): never recommend a wager from a quote that may no longer exist'
        : (code === 'MARKET_MISSING' ? 'no timestamped quote' : 'market integrity: ' + (snapOrQuote.integrity.reasons || []).join('; '))) };
  }

  /* ================================================ model vs market */
  function modelMarketGap(pureMargin, consensusMargin) {
    if (!isNum(pureMargin) || !isNum(consensusMargin)) return null;
    var g = pureMargin - consensusMargin, dir = g > 0 ? 'HOME' : (g < 0 ? 'AWAY' : 'NONE');
    var favSide = consensusMargin > 0 ? 'HOME' : (consensusMargin < 0 ? 'AWAY' : null);
    return { raw_signed_gap: r(g, 3), absolute_gap: r(Math.abs(g), 3), toward: dir,
      model_side_is: dir === 'NONE' || !favSide ? 'PICK' : (dir === favSide ? 'FAVORITE' : 'UNDERDOG') };
  }
  /* MODEL EDGE: EdgeDesk vs the consensus. PRICE EDGE: this book vs the consensus. */
  function modelEdgeVsPriceEdge(pureMargin, consensusMargin, quote, side, opts) {
    var s = side === 'AWAY' ? -1 : 1, hl = num(quote && quote.home_line);
    var model = isNum(pureMargin) && isNum(consensusMargin) ? (pureMargin - consensusMargin) * s : null;
    var price = isNum(hl) && isNum(consensusMargin) ? (consensusMargin - bookToMargin(hl)) * s : null;
    var out = { side: side, model_edge: r(model, 3), book_price_edge: r(price, 3), book: quote && quote.book };
    if (opts && opts.price_adjusted && isNum(num(quote.price_home)) && isNum(num(quote.price_away))) {
      out.book_price_edge_price_adjusted = r((consensusMargin - impliedMargin(hl, quote.price_home, quote.price_away)) * s, 3);
    }
    return out;
  }
  function keyNumberCrossingAlert(prevHomeLine, curHomeLine, pure, side, price, t) {
    var cr = keyCrossings(prevHomeLine, curHomeLine);
    if (!cr.length) return null;
    var P = pureDist(pure, t), a = outcomeProbs(P, prevHomeLine, side), b = outcomeProbs(P, curHomeLine, side), p = num(price);
    return { crossings: cr, side: side, cover_no_push_before: r(a.cover_no_push), cover_no_push_after: r(b.cover_no_push),
      push_before: r(a.push), push_after: r(b.push), p_win_before: r(a.win), p_win_after: r(b.win),
      ev_before: isNum(p) ? r(evAt(a, p)) : null, ev_after: isNum(p) ? r(evAt(b, p)) : null,
      ev_change: isNum(p) ? r(evAt(b, p) - evAt(a, p)) : null, price_captured: isNum(p),
      note: 'recomputed on the key-number distribution: half a point on a key is not half a point elsewhere' };
  }
  function priceDeterioration(firstSignal, current) {
    if (!firstSignal || !current) return null;
    var e0 = num(firstSignal.ev), e1 = num(current.ev);
    return { first_signal_at: iso(firstSignal.at), now: iso(current.at), line_at_first_signal: firstSignal.line, line_now: current.line,
      points_moved_against: isNum(firstSignal.line) && isNum(current.line) ? r(firstSignal.line - current.line, 3) : null,
      ev_at_first_signal: e0, ev_now: e1, edge_decay_since_first_signal: isNum(e0) && isNum(e1) ? r(e0 - e1, 4) : null,
      note: 'the model can stay right about the side while the price that made it a bet disappears' };
  }
  /* current price determines current EV: a past BET is never retained */
  function doNotChase(original, currentDecision) {
    var was = original && original.status, now = currentDecision && currentDecision.status;
    return { status: now || 'NO_BET', original_status: was || null, thesis_retained: false,
      flag: was === 'BET' && now !== 'BET' ? 'EDGE_GONE_AT_CURRENT_PRICE' : null,
      note: 'recomputed from scratch at the current price; the original signal does not hold a status' };
  }
  /* internal events, only on meaningful changes and never twice inside a cooldown */
  function marketEvents(prev, cur, opts) {
    opts = opts || {};
    var ev = [], minEv = isNum(opts.min_ev) ? opts.min_ev : 0.03, minGap = isNum(opts.min_gap) ? opts.min_gap : 3, cool = (isNum(opts.cooldown_minutes) ? opts.cooldown_minutes : 60) * 60000;
    var last = opts.last || {}, t = ms(cur && cur.at);
    function emit(type, detail) { if (last[type] && t - ms(last[type]) < cool) return; ev.push({ type: type, at: iso(t), game_id: cur.game_id, detail: detail }); }
    if (!cur) return ev;
    var edge = function (s) { return s && (isNum(s.ev) ? s.ev >= minEv : (isNum(s.gap) && Math.abs(s.gap) >= minGap)); };
    if (prev && !edge(prev) && edge(cur)) emit('MODEL_EDGE_APPEARS', { ev: cur.ev, gap: cur.gap, basis: isNum(cur.ev) ? 'EV' : 'GAP (no captured price)' });
    if (prev && edge(prev) && !edge(cur)) emit('MODEL_EDGE_DISAPPEARS', { ev: cur.ev, gap: cur.gap });
    if (cur.stale_better_price) emit('STALE_PRICE', cur.stale_better_price);
    if (prev && isNum(prev.consensus_margin) && isNum(cur.consensus_margin) && isNum(cur.pure_margin)) {
      var mv = cur.consensus_margin - prev.consensus_margin, toward = Math.sign(cur.pure_margin - prev.consensus_margin);
      if (Math.abs(mv) >= (opts.min_move || 0.5)) emit(Math.sign(mv) === toward ? 'MARKET_MOVES_TOWARD_MODEL' : 'MARKET_MOVES_AWAY_FROM_MODEL', { from: prev.consensus_margin, to: cur.consensus_margin });
      var kc = keyCrossings(bookToMargin(prev.consensus_margin), bookToMargin(cur.consensus_margin));
      if (kc.length) emit('KEY_NUMBER_CROSSED', { crossings: kc });
      if (cur.qb_event && Math.abs(mv) >= (opts.min_move || 0.5) && ms(cur.qb_event.at) <= t && ms(cur.qb_event.at) >= ms(prev.at)) {
        emit('QB_NEWS_REPRICES_MARKET', { event: cur.qb_event, move: r(mv, 2), attribution: 'TIMING_CONSISTENT (not proof of cause)' });
      }
    }
    return ev;
  }
  function contradictionAlert(pure, gap, mov, opts) {
    opts = opts || {};
    var conf = num(pure && pure.football_prediction_confidence), g = num(gap && gap.raw_signed_gap), fromOpen = num(mov && mov.from_open);
    if (!isNum(conf) || !isNum(g) || !isNum(fromOpen)) return null;
    var away = Math.sign(fromOpen) === -Math.sign(g) && Math.abs(fromOpen) >= (opts.min_move || 1.5);
    var hi = conf >= (opts.min_confidence || 70) && Math.abs(g) >= (opts.min_gap || 3);
    var broad = mov.classification === 'MARKET_MOVED' || (mov.books_moving_with_consensus || 0) >= 2;
    if (!(away && hi)) return null;
    return { alert: 'MARKET_CONTRADICTION', severity: broad ? 'INVESTIGATE' : 'WATCH', known_information_event: !!opts.info_event,
      questions: ['Did new football information arrive?', 'Did EdgeDesk data miss something?', 'Or is this market disagreement?'],
      action: 'review only: the football model is never changed by this alert' };
  }
  /* A huge edge may be real, or a bug dressed as free money. The checks are
     integrity.js's (extremeReview: sign, mapping, QB, injuries, feature and
     quote freshness, artifact; validateQuote: wrong game by teams, orientation
     and kickoff) - never re-implemented here. This adds only the venue check
     and lets the caller require the checks below integrity's 10-point trigger
     (opts.threshold); ctx.sameTeam should be the identity master's resolver. */
  function largeGapChecks(pure, quote, ctx, opts) {
    opts = opts || {}; ctx = ctx || {};
    var I = integ(), hl = num(quote && quote.home_line), mu = num(pure && pure.projected_margin);
    var gap = isNum(mu) && isNum(hl) ? mu - bookToMargin(hl) : null;
    var thr = isNum(opts.threshold) ? opts.threshold : I.EXTREME.GAP_PTS;
    var review = I.extremeReview({ pure_home_margin: mu, fair_spread_home_line: num(pure && pure.fair_spread_home_line), market_home_line: hl,
      side: ctx.side || (isNum(gap) && gap !== 0 ? (gap > 0 ? 'HOME' : 'AWAY') : null), cover_probability: ctx.cover_probability,
      game_id: pure && pure.game_id, quote_game_id: quote && quote.game_id, quote_home_team: quote && quote.home_team, home_team: pure && pure.home,
      sameTeam: ctx.sameTeam, qb_certainty: ctx.qb_certainty, injury_certainty: ctx.injury_certainty,
      feature_ts: pure && (pure.feature_ts || pure.prediction_ts), market_age_min: trueAgeMin(quote || {}, ctx.now), now: iso(ctx.now),
      model_version: pure && pure.model_version, expected_model_version: ctx.expected_model_version, market_integrity: ctx.market_integrity });
    var validation = I.validateQuote(quote || {}, { now: iso(ctx.now), game: pure ? { home: pure.home, away: pure.away, kickoff: pure.kickoff } : null, sameTeam: ctx.sameTeam });
    var required = review.required || (isNum(gap) && Math.abs(gap) >= thr);
    if (!required) return { required: false, gap: r(gap, 3), threshold: thr };
    var venue = ctx.neutral_site === undefined ? 'UNKNOWN' : (!!ctx.neutral_site === !!pure.neutral_site ? 'PASS' : 'FAIL');
    var failures = (review.failures || []).concat(validation.reasons || []).concat(venue === 'FAIL' ? ['VENUE: neutral-site flag disagrees'] : []);
    return { required: true, gap: r(gap, 3), threshold: thr, extreme_review: review, quote_validation: validation, venue: venue,
      ok: failures.length === 0 && venue !== 'UNKNOWN' && (review.required ? review.ok : true), failures: failures,
      status: failures.length ? 'REVIEW_BEFORE_BELIEVING' : (review.required ? 'CHECKS_PASSED' : 'BELOW_INTEGRITY_TRIGGER_CHECKED'),
      note: 'passing the checks makes a huge edge believable, not a bet; the BET gate is integrity.betGate' };
  }
  function informationEvent(event, series, opts) {
    opts = opts || {};
    var win = (isNum(opts.window_minutes) ? opts.window_minutes : 120) * 60000, t = ms(event && event.at);
    if (!isNum(t) || !series || !series.length) return { event: event, attribution: 'INSUFFICIENT_DATA' };
    var before = null, after = null, pre = null;
    series.forEach(function (s) {
      var st = ms(s.as_of);
      if (st <= t) before = s;
      if (st > t && st <= t + win) after = s;
      if (st <= t - win) pre = s;
    });
    var mv = before && after ? after.consensus_margin - before.consensus_margin : null;
    var preMove = pre && before ? before.consensus_margin - pre.consensus_margin : null;
    var attr = !before || !after ? 'INSUFFICIENT_DATA' : (mv === 0 ? 'NO_MOVE' : (isNum(preMove) && Math.abs(preMove) >= Math.abs(mv) ? 'MOVED_BEFORE_EVENT' : 'TIMING_CONSISTENT'));
    return { event_type: event.type, event_at: iso(t), market_before: before ? { as_of: before.as_of, consensus_margin: before.consensus_margin } : null,
      market_after: after ? { as_of: after.as_of, consensus_margin: after.consensus_margin } : null, move_pts: r(mv, 3), attribution: attr,
      note: 'timing is recorded; a cause is never claimed' };
  }
  /* how mature the market looks (descriptive; unvalidated until timestamped history exists) */
  function marketMaturity(snap, opener, now, ctx) {
    ctx = ctx || {};
    if (!snap || snap.status !== 'OK') return null;
    var tOpen = opener && opener.first_individual_openers && opener.first_individual_openers.length ? Math.min.apply(null, opener.first_individual_openers.map(function (o) { return ms(o.observed_at); })) : null;
    var h = isNum(tOpen) ? (ms(now) - tOpen) / 3600000 : null;
    var parts = { time_since_open: isNum(h) ? clamp(h / 72, 0, 1) : 0, books: clamp(snap.n_active_books / 5, 0, 1),
      agreement: isNum(snap.dispersion_iqr) ? clamp(1 - snap.dispersion_iqr / 2, 0, 1) : 0,
      qb_certainty: isNum(ctx.qb_certainty) ? ctx.qb_certainty / 100 : 0.5, injury_certainty: isNum(ctx.injury_certainty) ? ctx.injury_certainty / 100 : 0.5 };
    var w = { time_since_open: 0.25, books: 0.3, agreement: 0.2, qb_certainty: 0.15, injury_certainty: 0.1 }, s = 0;
    Object.keys(w).forEach(function (k) { s += w[k] * parts[k]; });
    return { market_maturity_score: Math.round(100 * s), components: parts, validated: false,
      note: 'descriptive until the Lab has the timestamped multi-book history to test it' };
  }
  /* the Lab's market-informed CHALLENGER: never the fair line, never a pure input */
  function challengerMargin(pureMargin, marketMargin, art) {
    art = art || ART.challenger;
    if (!art || !isNum(art.w_pure) || !isNum(pureMargin) || !isNum(marketMargin)) return null;
    return freeze({ model: 'market_adjusted_projection', artifact: art.artifact, role: 'challenger',
      market_adjusted_projection: r(marketMargin + art.w_pure * (pureMargin - marketMargin), 3), w_pure: art.w_pure,
      label: 'CHALLENGER (Model Lab only): not the EdgeDesk fair line' });
  }
  function decisionLatency(observedAt, decidedAt, storedAt) {
    var o = ms(observedAt), d = ms(decidedAt), s = ms(storedAt);
    return { decision_latency_ms: isNum(o) && isNum(d) ? d - o : null, storage_latency_ms: isNum(d) && isNum(s) ? s - d : null };
  }

  /* ========================================================= scorecards */
  /* each record: {side, bet_line, bet_price, close_line, close_price} in the SIDE's own convention */
  function clvOf(rec) {
    var bl = num(rec.bet_line), cl = num(rec.close_line);
    if (!isNum(bl) || !isNum(cl)) return null;
    return bl - cl;
  }
  function clvScorecard(records) {
    var xs = (records || []).map(clvOf).filter(isNum);
    var n = xs.length, buckets = { 'le_-1.5': 0, '-1_to_-0.5': 0, '0': 0, '0.5_to_1': 0, 'ge_1.5': 0 };
    xs.forEach(function (x) { if (x <= -1.5) buckets['le_-1.5']++; else if (x < 0) buckets['-1_to_-0.5']++; else if (x === 0) buckets['0']++; else if (x < 1.5) buckets['0.5_to_1']++; else buckets['ge_1.5']++; });
    var priceClv = (records || []).filter(function (x) { return isNum(num(x.bet_line)) && num(x.bet_line) === num(x.close_line) && isNum(num(x.bet_price)) && isNum(num(x.close_price)); })
      .map(function (x) { return 100 * (need().breakEven(num(x.close_price)) - need().breakEven(num(x.bet_price))); });
    return { n: n, positive_clv_rate: n ? r(xs.filter(function (x) { return x > 0; }).length / n, 4) : null, mean_clv_pts: r(mean(xs), 3),
      median_clv_pts: r(median(xs), 3), distribution: buckets, price_clv_pp_same_number: priceClv.length ? r(mean(priceClv), 3) : null };
  }
  function clvBySignal(records, key) {
    key = key || 'signal';
    var g = {};
    (records || []).forEach(function (x) { var k = x[key] == null ? 'UNSPECIFIED' : String(x[key]); (g[k] = g[k] || []).push(x); });
    return Object.keys(g).sort().map(function (k) { return Object.assign({ signal: k }, clvScorecard(g[k])); });
  }
  function horizonOf(h, isFirst) {
    if (isFirst) return 'OPEN';
    if (!isNum(h)) return 'UNKNOWN';
    return h > 72 ? 'OVER_72H' : h > 48 ? '72H' : h > 24 ? '48H' : h > 12 ? '24H' : h > 6 ? '12H' : h > 2 ? '6H' : '2H';
  }
  /* entries by horizon: EV at entry, CLV, ATS, ROI (ROI only at captured prices) */
  function timingScorecard(records) {
    var order = ['OPEN', 'OVER_72H', '72H', '48H', '24H', '12H', '6H', '2H', 'UNKNOWN'], g = {};
    (records || []).forEach(function (x) { var k = horizonOf(num(x.hours_to_kickoff), !!x.is_first_quote); (g[k] = g[k] || []).push(x); });
    return order.filter(function (k) { return g[k]; }).map(function (k) {
      var rs = g[k], res = rs.filter(function (x) { return x.result === 'W' || x.result === 'L'; });
      var priced = rs.filter(function (x) { return isNum(num(x.bet_price)) && (x.result === 'W' || x.result === 'L' || x.result === 'P'); });
      var units = priced.map(function (x) { return x.result === 'W' ? payout(num(x.bet_price)) : (x.result === 'L' ? -1 : 0); });
      return { horizon: k, n: rs.length, mean_ev_at_entry: r(mean(rs.map(function (x) { return num(x.ev_at_entry); })), 4),
        mean_clv_pts: r(mean(rs.map(clvOf)), 3), positive_clv_rate: (function () { var c = rs.map(clvOf).filter(isNum); return c.length ? r(c.filter(function (v) { return v > 0; }).length / c.length, 4) : null; }()),
        ats: res.length ? r(res.filter(function (x) { return x.result === 'W'; }).length / res.length, 4) : null,
        roi: priced.length ? r(mean(units), 4) : null, priced_entries: priced.length };
    });
  }
  /* BET IMMEDIATELY vs WAIT 6 / 12 / 24 h vs FINAL PRE-KICK on one game's
     snapshot series, point in time: the consensus number, its median price and
     the best number available at each execution time; CLV against the close. */
  function waitComparison(series, signalAt, side, kickoff, pure, t) {
    var t0 = ms(signalAt), k = ms(kickoff), close = series && series.length ? series[series.length - 1] : null;
    var P = pure ? pureDist(pure, t) : null;
    function at(tt) { var s = null; (series || []).forEach(function (x) { if (ms(x.as_of) <= tt) s = x; }); return s; }
    var plan = [['BET_IMMEDIATELY', t0], ['WAIT_6H', t0 + 6 * 3600000], ['WAIT_12H', t0 + 12 * 3600000], ['WAIT_24H', t0 + 24 * 3600000], ['FINAL_PREKICK', k - 1]];
    return plan.map(function (p) {
      if (!isNum(p[1]) || p[1] >= k) return { execution: p[0], available: false, reason: 'at or after kickoff' };
      var s = at(p[1]);
      if (!s) return { execution: p[0], available: false, reason: 'no quote yet' };
      var line = sideLine(side, s.median_home_line), price = side === 'AWAY' ? s.median_price_away : s.median_price_home;
      var best = side === 'AWAY' ? s.best_away : s.best_home, o = P ? outcomeProbs(P, s.median_home_line, side) : null;
      return { execution: p[0], at: s.as_of, available: true, consensus_line: line, consensus_price: price,
        best_line: best ? best.line : null, best_price: best ? best.price : null,
        cover_no_push: o ? r(o.cover_no_push) : null, ev_at_execution: o && isNum(price) ? r(evAt(o, price)) : null,
        clv_vs_final_pts: close ? r(line - sideLine(side, close.median_home_line), 3) : null };
    });
  }

  /* ====================================================== public words */
  var MYTH = [/sharps?\s+(are|were|is|on|money|action|bettors?|side|play|hit|loaded)/i, /sharp money/i, /smart money/i, /\bsyndicates?\b/i,
    /wise ?guys?/i, /\bsteam(ed|ing)?\s+(move|on|play)/i, /the public is (on|hammering|all over)/i, /reverse line movement (shows|proves|means|confirms)/i,
    /pros? (are|were) (on|betting)/i, /\block\b/i, /free money/i, /guarantee/i, /sure thing/i];
  function auditMarketLanguage(text, d) {
    var t = String(text || ''), problems = [];
    MYTH.forEach(function (re) { if (re.test(t)) problems.push('not measurable / not allowed: ' + re); });
    /* the decision engine's audit reads /edge/i as a value claim, so the brand name "EdgeDesk" alone would
       trip it: the brand is neutralised before delegating (the claims it looks for are unchanged) */
    if (DEC && DEC.auditLanguage) { var a = DEC.auditLanguage(t.replace(/EdgeDesk/g, 'the model'), d || null); problems = problems.concat(a.problems || []); }
    return { ok: problems.length === 0, problems: problems.filter(function (p, i, a) { return a.indexOf(p) === i; }) };
  }
  /* the clean public card (brief section 79): numbers from the engines, words from reason codes */
  function marketCard(pure, snap, decision, mov, names) {
    names = names || {};
    var home = names.home || (pure && pure.home), away = names.away || (pure && pure.away);
    var fmt = function (l) { return !isNum(l) ? null : (l > 0 ? '+' + l : String(l)); };
    var d = decision || {};
    var team = function (side) { return side === 'AWAY' ? away : home; };
    var gap = snap && pure ? modelMarketGap(pure.projected_margin, snap.consensus_margin) : null;
    var best = d.side && snap ? (d.side === 'AWAY' ? snap.best_away : snap.best_home) : null;
    var moveWords = null;
    if (mov && isNum(mov.from_open) && gap) moveWords = mov.from_open === 0 ? 'unchanged since open' : (Math.sign(mov.from_open) === Math.sign(gap.raw_signed_gap) ? 'moving toward EdgeDesk' : 'moving away from EdgeDesk');
    var conf = d.bet_confidence && d.bet_confidence.label ? d.bet_confidence.label : null;
    var card = {
      edgedesk_fair: pure ? pure.fair_spread_display : null,
      market: snap && snap.status === 'OK' ? (snap.consensus_margin >= 0 ? home + ' ' + fmt(snap.median_home_line) : away + ' ' + fmt(sideLine('AWAY', snap.median_home_line))) : 'no current market',
      model_gap: gap ? r(gap.absolute_gap, 1) : null,
      best_available: best ? team(d.side) + ' ' + fmt(best.line) + (isNum(best.price) ? ' ' + best.price : ' (price not captured)') : null,
      cover_probability: isNum(d.decision_cover_probability) ? Math.round(100 * d.decision_cover_probability) + '%' : null,
      edge_quality: conf ? conf.charAt(0) + conf.slice(1).toLowerCase() : null,
      timing: d.status === 'BET' ? (d.timing === 'WAIT' ? 'WAIT' : 'BET NOW') : (d.status || 'NO BET'),
      bettable_to: d.price_targets && isNum(d.price_targets.bettable_to_line) ? fmt(d.price_targets.bettable_to_line) : null,
      market_direction: moveWords,
      why: d.status === 'BET' ? 'EdgeDesk independently prices the game differently and the price clears the validated thresholds.' : (d.reasons && d.reasons[0]) || 'no qualifying price',
      note: 'Probabilities, not promises: an edge is an expected value, and any single game can lose.'
    };
    card.language = auditMarketLanguage([card.why, card.market_direction].join(' '), d);
    return card;
  }

  return {
    ENGINE_ID: ENGINE_ID, ENGINE_VERSION: ENGINE_VERSION, KEYS: KEYS, KMAX: KMAX, setArtifacts: setArtifacts, artifacts: ART,
    util: { median: median, quantile: quantile, iqr: iqr, mean: mean, sd: sd, trimmedMean: trimmedMean, weightedMedian: weightedMedian,
            bookToMargin: bookToMargin, sideLine: sideLine, homeLineFromSide: homeLineFromSide, cents: cents, medianPrice: medianPrice },
    canonicalQuote: canonicalQuote, sideToHomeMargin: sideToHomeMargin,
    keyPmf: keyPmf, pmfT: pmfT, outcomeProbs: outcomeProbs, evAt: evAt, fairPrice: fairPrice, priceForEv: priceForEv, keyNumbers: keyNumbers,
    halfPointValue: halfPointValue, altLinePrices: altLinePrices, comparePricePoint: comparePricePoint, bestEvQuote: bestEvQuote, impliedMargin: impliedMargin,
    consensusSnapshot: consensusSnapshot, snapshotSeries: snapshotSeries, trueOpener: trueOpener, closingLine: closingLine,
    keyCrossings: keyCrossings, movement: movement, lineVelocity: lineVelocity, coordinatedMoves: coordinatedMoves, reverseLineMovement: reverseLineMovement,
    lineResistance: lineResistance, marketDisagreement: marketDisagreement, providerConflicts: providerConflicts, staleQuotes: staleQuotes,
    staleDataFailsafe: staleDataFailsafe, modelMarketGap: modelMarketGap, modelEdgeVsPriceEdge: modelEdgeVsPriceEdge,
    keyNumberCrossingAlert: keyNumberCrossingAlert, priceDeterioration: priceDeterioration, doNotChase: doNotChase, marketEvents: marketEvents,
    contradictionAlert: contradictionAlert, largeGapChecks: largeGapChecks, informationEvent: informationEvent, marketMaturity: marketMaturity,
    challengerMargin: challengerMargin, decisionLatency: decisionLatency,
    clvScorecard: clvScorecard, clvBySignal: clvBySignal, timingScorecard: timingScorecard, waitComparison: waitComparison,
    auditMarketLanguage: auditMarketLanguage, marketCard: marketCard
  };
}));

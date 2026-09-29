/* ===========================================================================
   EDGEDESK PLAYER PROPS — the one kernel for CFB and NFL player-prop research.
   docs/player-props/ARCHITECTURE.md

   One question per quote: at THIS book's line AND price, what is the
   probability this player goes over / under, and is the PRICE worth it?

       stored outcome distribution  (model_prediction.dist — one per player,
         │                           market and scoring time; NEVER one per line)
         → P(over), P(under), P(push) at any line, from the same distribution
         → the quote's own price (same book, same snapshot)
         → implied probability, the book's no-vig pair, the cross-book consensus
         → fair price, probability edge, EV, conservative EV
         → alternate-line ladder, line shopping, movement, confidence, quality

   WHAT THIS FILE NEVER DOES
     - compute a football number. Distributions arrive already fitted (the
       model jobs in football/props/ write them); this file only reads them.
     - let a price move a probability. Odds enter break-even and payout only.
     - price one book's line with another book's price.
     - invent a sportsbook line, or treat a RECONSTRUCTED quote as observed:
       evaluateQuote refuses any quote whose lineage is not 'observed'.
     - declare the most extreme modelled edge the best option. The ladder's
       "best value" is the highest expected log-growth at a quarter-Kelly
       stake on the CONSERVATIVE probability (docs §7), reported beside the
       raw max-EV quote so a reader sees both.

   ODDS MATH is research_core's and edgedesk_quote_ev's (americanToDecimal,
   impliedProb, noVigTwoWay, expectedValue, fairAmerican, priceOf, clvPrice):
   the tested implementations the rest of the terminal already uses. Nothing
   here re-derives them.

   THE STORED DISTRIBUTION (model_prediction.dist, board JSON, AI context)
     {t:'pmf', v:[P(0),P(1),…,P(K)], tail:P(>K)}          counts
     {t:'cdf', x:[…], p:[…], int:true|false}               continuous (knots of
                                                           a monotone CDF; int:
                                                           the stat is integer-
                                                           valued → continuity
                                                           correction at lines)
     {t:'bern', p:P(yes)}                                  yes/no markets
   The server, the browser and the AI desk all evaluate THIS object with the
   functions below, so the same line gets the same probability everywhere.

   Browser: window.EDProps (load lib/research_core.js and
   lib/edgedesk_quote_ev.js first). Node: require('./player_props.js').
   ES5, no other dependencies.
   =========================================================================== */
/*__EDPROPSLIB_START__*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDProps = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_player_props_v1';
  var EPS = 1e-9;

  /* ------------------------------------------------------------- deps */
  var Rc = null, Qe = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    try { Rc = require('./research_core.js'); } catch (e) { Rc = null; }
    try { Qe = require('./edgedesk_quote_ev.js'); } catch (e) { Qe = null; }
  }
  function R() {
    var c = Rc || (root && root.EDResearchCore) || (root && root.EDResearch && typeof root.EDResearch.americanToDecimal === 'function' ? root.EDResearch : null);
    if (!c) throw new Error('EDProps needs lib/research_core.js (EDResearchCore) loaded first');
    return c;
  }
  function Q() {
    var q = Qe || (root && root.EDQuoteEV);
    if (!q) throw new Error('EDProps needs lib/edgedesk_quote_ev.js (EDQuoteEV) loaded first');
    return q;
  }

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function r(x, d) { if (!isNum(x)) return null; var m = Math.pow(10, d == null ? 4 : d); return Math.round(x * m) / m; }
  function median(a) { var s = a.filter(isNum).slice().sort(function (x, y) { return x - y; }); if (!s.length) return null; var h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
  function mean(a) { var s = a.filter(isNum); if (!s.length) return null; var t = 0; for (var i = 0; i < s.length; i++) t += s[i]; return t / s.length; }
  function sd(a) { var s = a.filter(isNum); if (s.length < 2) return null; var m = mean(s), t = 0; for (var i = 0; i < s.length; i++) t += (s[i] - m) * (s[i] - m); return Math.sqrt(t / (s.length - 1)); }
  function isHalf(line) { return isNum(line) && Math.abs(line * 2 - Math.round(line * 2)) < 1e-9 && Math.abs(line - Math.round(line)) > 1e-9; }
  function isWhole(line) { return isNum(line) && Math.abs(line - Math.round(line)) < 1e-9; }

  /* =============================================================== MARKETS
     The display half of football/props/config/markets.json (the full catalog,
     with provider maps, lives there; football/props/props.test.js pins the
     two together). */
  var MARKETS = {
    pass_yards:              { label: 'Passing yards', short: 'Pass yds', family: 'continuous', unit: 'yds', group: 'passing', pos: ['QB'] },
    pass_tds:                { label: 'Passing TDs', short: 'Pass TD', family: 'count', unit: 'TD', group: 'passing', pos: ['QB'] },
    pass_completions:        { label: 'Completions', short: 'Cmp', family: 'count', unit: 'cmp', group: 'passing', pos: ['QB'] },
    pass_attempts:           { label: 'Pass attempts', short: 'Att', family: 'count', unit: 'att', group: 'passing', pos: ['QB'] },
    pass_interceptions:      { label: 'Interceptions thrown', short: 'INT', family: 'count', unit: 'INT', group: 'passing', pos: ['QB'] },
    pass_longest_completion: { label: 'Longest completion', short: 'Long cmp', family: 'continuous', unit: 'yds', group: 'passing', pos: ['QB'] },
    rush_yards:              { label: 'Rushing yards', short: 'Rush yds', family: 'continuous', unit: 'yds', group: 'rushing', pos: ['QB', 'RB', 'WR'] },
    rush_attempts:           { label: 'Rush attempts', short: 'Carries', family: 'count', unit: 'car', group: 'rushing', pos: ['QB', 'RB', 'WR'] },
    rush_tds:                { label: 'Rushing TDs', short: 'Rush TD', family: 'count', unit: 'TD', group: 'rushing', pos: ['QB', 'RB', 'WR'] },
    longest_rush:            { label: 'Longest rush', short: 'Long rush', family: 'continuous', unit: 'yds', group: 'rushing', pos: ['QB', 'RB', 'WR'] },
    receiving_yards:         { label: 'Receiving yards', short: 'Rec yds', family: 'continuous', unit: 'yds', group: 'receiving', pos: ['RB', 'WR', 'TE'] },
    receptions:              { label: 'Receptions', short: 'Rec', family: 'count', unit: 'rec', group: 'receiving', pos: ['RB', 'WR', 'TE'] },
    targets:                 { label: 'Targets', short: 'Tgt', family: 'count', unit: 'tgt', group: 'receiving', pos: ['RB', 'WR', 'TE'] },
    receiving_tds:           { label: 'Receiving TDs', short: 'Rec TD', family: 'count', unit: 'TD', group: 'receiving', pos: ['RB', 'WR', 'TE'] },
    longest_reception:       { label: 'Longest reception', short: 'Long rec', family: 'continuous', unit: 'yds', group: 'receiving', pos: ['RB', 'WR', 'TE'] },
    anytime_td:              { label: 'Anytime TD', short: 'ATTD', family: 'binary', unit: '', group: 'scoring', pos: ['QB', 'RB', 'WR', 'TE'] },
    first_td:                { label: 'First TD', short: '1st TD', family: 'binary', unit: '', group: 'scoring', pos: ['QB', 'RB', 'WR', 'TE'] },
    pass_rush_yards:         { label: 'Pass + rush yards', short: 'Pass+rush', family: 'continuous', unit: 'yds', group: 'combo', pos: ['QB'] },
    rush_rec_yards:          { label: 'Rush + rec yards', short: 'Rush+rec', family: 'continuous', unit: 'yds', group: 'combo', pos: ['RB', 'WR', 'TE'] },
    pass_rush_rec_yards:     { label: 'Pass + rush + rec yards', short: 'Total yds', family: 'continuous', unit: 'yds', group: 'combo', pos: ['QB', 'RB', 'WR', 'TE'] },
    receptions_rush_attempts:{ label: 'Receptions + carries', short: 'Rec+car', family: 'count', unit: '', group: 'combo', pos: ['RB', 'WR', 'TE'] },
    kicking_points:          { label: 'Kicking points', short: 'K pts', family: 'count', unit: 'pts', group: 'kicking', pos: ['K'] },
    field_goals_made:        { label: 'Field goals made', short: 'FG', family: 'count', unit: 'FG', group: 'kicking', pos: ['K'] },
    extra_points_made:       { label: 'Extra points made', short: 'XP', family: 'count', unit: 'XP', group: 'kicking', pos: ['K'] },
    def_interceptions:       { label: 'Defensive interceptions', short: 'Def INT', family: 'count', unit: 'INT', group: 'defense', pos: ['DB', 'LB'] },
    sacks:                   { label: 'Sacks', short: 'Sacks', family: 'count', unit: 'sk', group: 'defense', pos: ['DL', 'LB'] },
    tackles_assists:         { label: 'Tackles + assists', short: 'Tkl+ast', family: 'count', unit: '', group: 'defense', pos: ['LB', 'DB', 'DL'] }
  };
  function marketLabel(k) { return MARKETS[k] ? MARKETS[k].label : String(k || ''); }

  /* ========================================================= DISTRIBUTIONS */
  function logGamma(z) {
    /* Lanczos, g = 7 */
    var g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1; var x = c[0]; for (var i = 1; i < g + 2; i++) x += c[i] / (z + i);
    var t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  /* A count pmf, truncated where the remaining tail is < tol; the tail mass is
     kept (never dropped), so the stored object always sums to 1. */
  function finishPmf(v, tol) {
    var s = 0; for (var i = 0; i < v.length; i++) s += v[i];
    var tail = Math.max(0, 1 - s);
    return { t: 'pmf', v: v.map(function (x) { return r(x, 7); }), tail: r(tail < tol ? 0 : tail, 7) };
  }
  function poissonPmf(mu, opts) {
    opts = opts || {}; var tol = opts.tol || 1e-5, kmax = opts.kmax || 400;
    mu = Math.max(1e-9, mu);
    var v = [], p = Math.exp(-mu), cum = 0;
    if (p === 0) { /* very large mu: start from the log form */ p = Math.exp(-mu); }
    for (var k = 0; k <= kmax; k++) {
      if (k > 0) p = p * mu / k;
      v.push(p); cum += p;
      if (k > mu && 1 - cum < tol) break;
    }
    return finishPmf(v, tol);
  }
  /* NB with mean mu and size r: Var = mu + mu^2 / r. */
  function negBinomPmf(mu, size, opts) {
    opts = opts || {}; var tol = opts.tol || 1e-5, kmax = opts.kmax || 600;
    if (!isNum(size) || size <= 0 || size > 1e6) return poissonPmf(mu, opts);
    mu = Math.max(1e-9, mu);
    var q = size / (size + mu);
    var lp0 = size * Math.log(q), p = Math.exp(lp0), v = [], cum = 0;
    for (var k = 0; k <= kmax; k++) {
      if (k > 0) p = p * (k - 1 + size) / k * (mu / (size + mu));
      v.push(p); cum += p;
      if (k > mu && 1 - cum < tol) break;
    }
    return finishPmf(v, tol);
  }
  function binomPmf(n, p, opts) {
    opts = opts || {}; var tol = opts.tol || 1e-5;
    n = Math.max(1, Math.round(n)); p = clamp(p, 1e-9, 1 - 1e-9);
    var v = [], lq = Math.log(1 - p), lpp = Math.log(p);
    for (var k = 0; k <= n; k++) v.push(Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * lpp + (n - k) * lq));
    return finishPmf(v, tol);
  }
  /* The count family from a mean and a variance: NB when overdispersed,
     Poisson at variance == mean, binomial when underdispersed. */
  function countFromMoments(mu, variance, opts) {
    if (!isNum(mu) || mu < 0) return null;
    if (!isNum(variance) || variance <= 0) return poissonPmf(mu, opts);
    var phi = variance / Math.max(mu, 1e-9);
    if (phi > 1.02) return negBinomPmf(mu, mu * mu / (variance - mu), opts);
    if (phi < 0.98 && mu > 0.5) { var n = mu / (1 - phi); return binomPmf(n, mu / Math.round(Math.max(1, n)), opts); }
    return poissonPmf(mu, opts);
  }
  /* A mixture of stored pmfs with weights (role/mean uncertainty). */
  function mixPmf(list) {
    var K = 0; list.forEach(function (e) { K = Math.max(K, e.d.v.length); });
    var v = []; for (var k = 0; k < K; k++) v.push(0);
    var tail = 0;
    list.forEach(function (e) { for (var k = 0; k < e.d.v.length; k++) v[k] += e.w * e.d.v[k]; tail += e.w * (e.d.tail || 0); });
    return { t: 'pmf', v: v.map(function (x) { return r(x, 7); }), tail: r(tail, 7) };
  }
  /* Gauss–Hermite nodes for a lognormal mean multiplier exp(sigma * z). */
  var GH = [[-2.0201828704560856, 0.019953242059045913], [-0.9585724646138185, 0.3936193231522412], [0, 0.9453087204829419],
    [0.9585724646138185, 0.3936193231522412], [2.0201828704560856, 0.019953242059045913]];
  function meanNodes(sigma) {
    if (!isNum(sigma) || sigma <= 1e-6) return [{ m: 1, w: 1 }];
    var s = Math.SQRT2 * sigma, tot = 0, out = GH.map(function (g) { var w = g[1] / Math.sqrt(Math.PI); tot += w; return { m: Math.exp(s * g[0] - sigma * sigma / 2), w: w }; });
    out.forEach(function (o) { o.w /= tot; });
    return out;
  }
  function countWithUncertainty(mu, variance, sigmaMu, opts) {
    var nodes = meanNodes(sigmaMu);
    if (nodes.length === 1) return countFromMoments(mu, variance, opts);
    var phi = isNum(variance) && mu > 0 ? variance / mu : 1;
    return mixPmf(nodes.map(function (n) { var m = mu * n.m; return { w: n.w, d: countFromMoments(m, phi * m, opts) }; }));
  }

  /* THE EMPIRICAL RATIO FAMILY (continuous yardage).
     table = { probs:[…], bins:[{mu_lo, mu_hi, mu_mid, n, q:[ratio quantiles at probs]}] }
     built by football/props/model.js from OUT-OF-FOLD predictions: the
     distribution of actual / predicted mean, conditioned on the predicted
     mean's size. A prediction at mean mu reads the two nearest bins and
     interpolates their CDFs, so the shape moves smoothly with mu. */
  function interpCdf(xs, ps, x) {
    var n = xs.length; if (!n) return null;
    if (x < xs[0]) return 0;
    if (x >= xs[n - 1]) return 1;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    var dx = xs[hi] - xs[lo];
    return dx <= 0 ? ps[hi] : ps[lo] + (ps[hi] - ps[lo]) * (x - xs[lo]) / dx;
  }
  function binCdf(bin, probs, ratio) {
    /* quantiles q (non-decreasing) at probs → CDF at ratio, with flat steps
       resolved to the upper probability (right-continuous) */
    var q = bin.q, n = q.length;
    if (ratio < q[0]) return 0;
    if (ratio >= q[n - 1]) return 1;
    var j = 0; while (j < n - 1 && q[j + 1] <= ratio) j++;
    var dq = q[j + 1] - q[j];
    return dq <= 0 ? probs[j + 1] : probs[j] + (probs[j + 1] - probs[j]) * (ratio - q[j]) / dq;
  }
  function ratioWeights(table, mu) {
    var bins = table.bins;
    if (bins.length === 1 || mu <= bins[0].mu_mid) return [{ b: bins[0], w: 1 }];
    if (mu >= bins[bins.length - 1].mu_mid) return [{ b: bins[bins.length - 1], w: 1 }];
    for (var i = 0; i < bins.length - 1; i++) {
      var a = bins[i], b = bins[i + 1];
      if (mu >= a.mu_mid && mu <= b.mu_mid) { var t = (mu - a.mu_mid) / Math.max(1e-9, b.mu_mid - a.mu_mid); return [{ b: a, w: 1 - t }, { b: b, w: t }]; }
    }
    return [{ b: bins[bins.length - 1], w: 1 }];
  }
  function ratioCdfAt(table, mu, x) {
    if (!(mu > 0)) return x >= 0 ? 1 : 0;
    var ws = ratioWeights(table, mu), p = 0;
    for (var i = 0; i < ws.length; i++) p += ws[i].w * binCdf(ws[i].b, table.probs, x / mu);
    return p;
  }
  /* Build the stored CDF knots for a continuous prediction (mean mu, the
     empirical ratio table, an optional extra mean uncertainty sigmaMu). */
  function continuousFromRatio(mu, table, sigmaMu, opts) {
    opts = opts || {};
    var nodes = meanNodes(sigmaMu);
    var lo = null, hi = null;
    nodes.forEach(function (n) {
      var m = mu * n.m, bins = ratioWeights(table, m);
      bins.forEach(function (bw) { var a = bw.b.q[0] * m, b = bw.b.q[bw.b.q.length - 1] * m; lo = lo == null ? a : Math.min(lo, a); hi = hi == null ? b : Math.max(hi, b); });
    });
    if (lo == null) return null;
    var F = function (x) { var p = 0; nodes.forEach(function (n) { p += n.w * ratioCdfAt(table, mu * n.m, x); }); return p; };
    /* knots: dense in the body, then compressed to at most opts.knots points */
    var N = opts.grid || 240, xs = [], ps = [];
    for (var i = 0; i <= N; i++) { var x = lo + (hi - lo) * i / N; xs.push(x); ps.push(F(x)); }
    for (var k = 1; k < ps.length; k++) if (ps[k] < ps[k - 1]) ps[k] = ps[k - 1];
    return compressCdf(xs, ps, opts.knots || 48, !!opts.integer);
  }
  /* keep the knots that matter: equally spaced in probability, plus both ends */
  function compressCdf(xs, ps, maxKnots, integer) {
    var keepX = [xs[0]], keepP = [ps[0]];
    var targets = []; for (var i = 1; i < maxKnots - 1; i++) targets.push(i / (maxKnots - 1));
    var j = 0;
    for (var t = 0; t < targets.length; t++) {
      while (j < ps.length - 1 && ps[j] < targets[t]) j++;
      if (xs[j] > keepX[keepX.length - 1] + 1e-9) { keepX.push(xs[j]); keepP.push(ps[j]); }
    }
    if (xs[xs.length - 1] > keepX[keepX.length - 1]) { keepX.push(xs[xs.length - 1]); keepP.push(1); }
    else keepP[keepP.length - 1] = 1;
    return { t: 'cdf', x: keepX.map(function (v) { return r(v, 3); }), p: keepP.map(function (v) { return r(v, 5); }), int: !!integer };
  }
  function bernoulli(p) { return isNum(p) ? { t: 'bern', p: r(clamp(p, 0, 1), 6) } : null; }
  /* QUANTILE RECALIBRATION. map = {u:[…], g:[…]} is a monotone map of CDF
     values fitted on a season the model did not see (the PIT of held-out
     outcomes): F_cal(x) = G(F(x)). Applied once, at scoring, so every
     consumer reads the calibrated distribution. */
  function gOf(map, u) { return map && map.u && map.u.length > 1 ? clamp(interpCdf(map.u, map.g, u), 0, 1) : u; }
  function recalibrate(d, map) {
    if (!d || !map || !map.u) return d;
    if (d.t === 'cdf') return { t: 'cdf', x: d.x.slice(), p: d.p.map(function (v, i) { return i === d.p.length - 1 ? 1 : r(gOf(map, v), 5); }), int: d.int };
    if (d.t === 'pmf') {
      var cum = 0, prev = 0, v = [];
      for (var k = 0; k < d.v.length; k++) { cum += d.v[k]; var c = k === d.v.length - 1 && !(d.tail > 0) ? 1 : gOf(map, cum); v.push(r(Math.max(0, c - prev), 7)); prev = Math.max(prev, c); }
      return { t: 'pmf', v: v, tail: r(Math.max(0, 1 - prev), 7) };
    }
    if (d.t === 'bern') return { t: 'bern', p: r(1 - gOf(map, 1 - d.p), 6) };
    return d;
  }

  /* The one evaluator. P(Y <= x) for every stored form. */
  function cdf(d, x) {
    if (!d || !isNum(x)) return null;
    if (d.t === 'pmf') {
      if (x < 0) return 0;
      var k = Math.floor(x + 1e-9), s = 0;
      for (var i = 0; i <= k && i < d.v.length; i++) s += d.v[i];
      return k >= d.v.length ? 1 : clamp(s, 0, 1);
    }
    if (d.t === 'cdf') return clamp(interpCdf(d.x, d.p, x), 0, 1);
    if (d.t === 'bern') return x < 0 ? 0 : (x < 1 ? 1 - d.p : 1);
    return null;
  }
  /* {over, under, push} at a line. Integer-valued stats (pmf, or cdf with
     int:true): a half-point line splits cleanly; a whole-number line carries a
     push mass P(Y = line). For the smoothed continuous CDF of an integer stat,
     P(Y <= k) is read at k + 0.5 (continuity correction). */
  function probs(d, line) {
    if (!d || !isNum(line)) return null;
    if (d.t === 'bern') return { over: d.p, under: 1 - d.p, push: 0, yes: d.p, no: 1 - d.p };
    var integer = d.t === 'pmf' || !!d.int, under, push;
    if (integer) {
      if (isWhole(line)) {
        var k = Math.round(line);
        var below = d.t === 'pmf' ? cdf(d, k - 1) : cdf(d, k - 0.5);
        var atOrBelow = d.t === 'pmf' ? cdf(d, k) : cdf(d, k + 0.5);
        under = below; push = Math.max(0, atOrBelow - below);
      } else {
        under = d.t === 'pmf' ? cdf(d, Math.floor(line)) : cdf(d, line);
        push = 0;
      }
    } else { under = cdf(d, line); push = 0; }
    var over = Math.max(0, 1 - under - push);
    return { over: over, under: under, push: push };
  }
  function quantile(d, q) {
    if (!d || !isNum(q)) return null;
    if (d.t === 'pmf') { var s = 0; for (var k = 0; k < d.v.length; k++) { s += d.v[k]; if (s >= q - 1e-12) return k; } return d.v.length; }
    if (d.t === 'cdf') {
      var xs = d.x, ps = d.p;
      if (q <= ps[0]) return xs[0];
      for (var i = 1; i < xs.length; i++) if (ps[i] >= q) { var dp = ps[i] - ps[i - 1]; return dp <= 0 ? xs[i] : xs[i - 1] + (xs[i] - xs[i - 1]) * (q - ps[i - 1]) / dp; }
      return xs[xs.length - 1];
    }
    if (d.t === 'bern') return q <= 1 - d.p ? 0 : 1;
    return null;
  }
  function moments(d) {
    if (!d) return null;
    if (d.t === 'pmf') {
      var m = 0, m2 = 0; for (var k = 0; k < d.v.length; k++) { m += k * d.v[k]; m2 += k * k * d.v[k]; }
      var K = d.v.length; m += (d.tail || 0) * K; m2 += (d.tail || 0) * K * K;
      return { mean: m, sd: Math.sqrt(Math.max(0, m2 - m * m)) };
    }
    if (d.t === 'cdf') {
      var mm = 0, mm2 = 0;
      for (var i = 1; i < d.x.length; i++) { var dp = d.p[i] - d.p[i - 1], mid = (d.x[i] + d.x[i - 1]) / 2; mm += dp * mid; mm2 += dp * mid * mid; }
      mm += d.p[0] * d.x[0]; mm2 += d.p[0] * d.x[0] * d.x[0];
      return { mean: mm, sd: Math.sqrt(Math.max(0, mm2 - mm * mm)) };
    }
    if (d.t === 'bern') return { mean: d.p, sd: Math.sqrt(d.p * (1 - d.p)) };
    return null;
  }
  function summary(d) {
    var m = moments(d); if (!m) return null;
    return { mean: r(m.mean, 3), sd: r(m.sd, 3), median: r(quantile(d, 0.5), 2), p10: r(quantile(d, 0.1), 2), p25: r(quantile(d, 0.25), 2),
      p75: r(quantile(d, 0.75), 2), p90: r(quantile(d, 0.9), 2) };
  }
  function validDist(d) {
    if (!d || typeof d !== 'object') return false;
    if (d.t === 'bern') return isNum(d.p) && d.p >= 0 && d.p <= 1;
    if (d.t === 'pmf') { if (!Array.isArray(d.v) || !d.v.length) return false; var s = d.tail || 0; for (var i = 0; i < d.v.length; i++) { if (!(d.v[i] >= 0)) return false; s += d.v[i]; } return Math.abs(s - 1) < 1e-3; }
    if (d.t === 'cdf') { if (!Array.isArray(d.x) || d.x.length < 2 || d.x.length !== d.p.length) return false; for (var j = 1; j < d.x.length; j++) if (d.x[j] < d.x[j - 1] || d.p[j] < d.p[j - 1] - 1e-9) return false; return Math.abs(d.p[d.p.length - 1] - 1) < 1e-6; }
    return false;
  }

  /* ============================================================= QUOTES */
  var SIDES = { over: 1, under: 1, yes: 1, no: 1 };
  /* model win / push / loss for one side at one line */
  function sideProbs(d, side, line) {
    if (!SIDES[side]) return null;
    if (d && d.t === 'bern') {
      if (side !== 'yes' && side !== 'no') return null;
      return side === 'yes' ? { win: d.p, push: 0, loss: 1 - d.p } : { win: 1 - d.p, push: 0, loss: d.p };
    }
    if (side === 'yes' || side === 'no') return null;
    var p = probs(d, line); if (!p) return null;
    return side === 'over' ? { win: p.over, push: p.push, loss: p.under } : { win: p.under, push: p.push, loss: p.over };
  }
  /* no-vig for one book's pair (same book, snapshot, player, market, line) */
  function noVig(sideAmerican, otherAmerican) {
    var nv = R().noVigTwoWay(sideAmerican, otherAmerican);
    return nv ? { p: nv.a, other: nv.b, overround: nv.overround } : null;
  }
  /* Pair every quote with its opposite side at the same book, snapshot, line.
     Returns a map quoteKey -> no-vig probability of that quote's side. */
  function pairKey(q) { return [q.game_id, q.player_id, q.market_key, q.sportsbook, q.snapshot_at || '', isNum(num(q.line)) ? num(q.line) : ''].join('|'); }
  var OPP = { over: 'under', under: 'over', yes: 'no', no: 'yes' };
  function pairQuotes(quotes) {
    var groups = {};
    (quotes || []).forEach(function (q) { var k = pairKey(q); (groups[k] = groups[k] || {})[q.side] = q; });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      Object.keys(g).forEach(function (s) {
        var q = g[s], o = g[OPP[s]];
        var nv = o ? noVig(q.american_price, o.american_price) : null;
        out.push({ quote: q, opposite: o || null, no_vig_prob: nv ? nv.p : null, overround: nv ? nv.overround : null });
      });
    });
    return out;
  }

  /* THE QUOTE EVALUATION. dist = the stored distribution; quote = one
     observed quote {side, line, american_price, sportsbook, lineage, …};
     ctx = {no_vig_prob (this book's pair), consensus_prob (cross-book
     no-vig for this side at this line), reliability (0-1, how much of the
     model-market gap to trust), push_policy}. */
  function evaluateQuote(d, quote, ctx) {
    ctx = ctx || {};
    var out = { ok: false, reason: null, side: quote && quote.side, line: quote ? num(quote.line) : null, sportsbook: quote && quote.sportsbook,
      american: null, decimal: null, implied_prob: null, no_vig_prob: null, consensus_prob: null,
      model_win: null, model_push: null, model_loss: null, model_prob: null, fair_american: null,
      edge_vs_implied: null, edge_vs_market: null, ev: null, conservative_prob: null, conservative_ev: null, kelly_growth: null };
    if (!quote) { out.reason = 'no quote'; return out; }
    if (quote.lineage !== 'observed') { out.reason = 'lineage is ' + (quote.lineage || 'missing') + ': only observed sportsbook quotes are evaluated'; return out; }
    if (!validDist(d)) { out.reason = 'no valid model distribution for this player and market'; return out; }
    var pr = Q().priceOf(quote.american_price, quote.decimal_price);
    if (!pr.valid) { out.reason = pr.problem || 'no valid price'; return out; }
    out.american = pr.american; out.decimal = pr.decimal; out.implied_prob = 1 / pr.decimal;
    var sp = sideProbs(d, quote.side, out.line);
    if (!sp) { out.reason = 'side ' + quote.side + ' does not fit this market'; return out; }
    out.model_win = sp.win; out.model_push = sp.push; out.model_loss = sp.loss;
    out.model_prob = sp.win + sp.loss > 0 ? sp.win / (sp.win + sp.loss) : null;          /* the no-push basis */
    out.fair_american = Q().fairAmerican(sp.win, sp.push);
    out.ev = Q().expectedValue(sp.win, sp.push, sp.loss, pr.decimal);
    out.edge_vs_implied = out.model_prob == null ? null : out.model_prob - out.implied_prob;
    out.no_vig_prob = isNum(ctx.no_vig_prob) ? ctx.no_vig_prob : null;
    out.consensus_prob = isNum(ctx.consensus_prob) ? ctx.consensus_prob : null;
    var marketP = out.consensus_prob != null ? out.consensus_prob : out.no_vig_prob;
    out.market_prob = marketP;
    out.edge_vs_market = marketP != null && out.model_prob != null ? out.model_prob - marketP : null;
    /* CONSERVATIVE probability: shrink the model toward the market by how
       little is known (reliability 0 → the market; 1 → the model), plus a
       tail penalty that grows with the line's distance from the model median
       in model-sd units (tails are where calibration is thinnest). */
    var rel = isNum(ctx.reliability) ? clamp(ctx.reliability, 0, 1) : 0.5;
    var tailPen = isNum(ctx.tail_z) ? clamp(1 - 0.12 * Math.max(0, Math.abs(ctx.tail_z) - 1), 0.4, 1) : 1;
    var w = rel * tailPen, anchor = marketP != null ? marketP : out.implied_prob;
    if (out.model_prob != null) {
      out.conservative_prob = anchor + w * (out.model_prob - anchor);
      var cw = out.conservative_prob * (1 - sp.push), cl = (1 - out.conservative_prob) * (1 - sp.push);
      out.conservative_ev = Q().expectedValue(cw, sp.push, cl, pr.decimal);
      out.kelly_growth = kellyGrowth(out.conservative_prob, pr.decimal, 0.25);
    }
    out.ok = out.ev != null;
    if (!out.ok) out.reason = 'EV could not be computed';
    return out;
  }
  /* expected log growth of a fractional-Kelly stake (no-push basis) */
  function kellyGrowth(p, decimal, frac) {
    if (!isNum(p) || !isNum(decimal) || decimal <= 1) return null;
    var b = decimal - 1, f = (p * b - (1 - p)) / b;
    if (!(f > 0)) return 0;
    f *= (isNum(frac) ? frac : 0.25);
    return p * Math.log(1 + f * b) + (1 - p) * Math.log(1 - f);
  }

  /* ======================================================= MARKET VIEW
     Everything the market says about ONE player-market at one moment, from
     the latest observed quote per (book, side, line). */
  /* THE CURRENT LISTING. Prices are stored change-only, so "the latest row per
     key" would keep a line a book has since withdrawn. Each poll therefore also
     records a LISTING: the keys each book offered at that snapshot
     (listings = [{sportsbook, snapshot_at, keys:[…]}], key = side|line|alt).
     The market at time t = for every book, its latest listing at or before t,
     each listed key at its latest price at or before t. Without listings (full
     snapshots, as the historical backfill stores), a book's latest snapshot IS
     its listing. */
  function qkey(q) { return q.side + '|' + (isNum(num(q.line)) ? num(q.line) : '') + '|' + (q.is_alt_line ? 1 : 0); }
  function latestByBook(quotes, opts) {
    opts = opts || {};
    var at = opts.at != null ? opts.at : Infinity;
    var obs = (quotes || []).filter(function (q) { return q.lineage === 'observed' && Date.parse(q.snapshot_at) <= at; });
    var byBook = {};
    obs.forEach(function (q) { (byBook[q.sportsbook] = byBook[q.sportsbook] || []).push(q); });
    var out = [];
    var lst = {};
    (opts.listings || []).forEach(function (l) { if (Date.parse(l.snapshot_at) <= at && (!lst[l.sportsbook] || Date.parse(l.snapshot_at) > Date.parse(lst[l.sportsbook].snapshot_at))) lst[l.sportsbook] = l; });
    Object.keys(byBook).forEach(function (b) {
      var qs = byBook[b], latest = {};
      qs.forEach(function (q) { var k = qkey(q); if (!latest[k] || Date.parse(q.snapshot_at) > Date.parse(latest[k].snapshot_at)) latest[k] = q; });
      if (lst[b]) {
        var keys = {}; (lst[b].keys || []).forEach(function (k) { keys[k] = 1; });
        Object.keys(latest).forEach(function (k) { if (keys[k]) out.push(latest[k]); });
      } else {
        var maxT = -Infinity; qs.forEach(function (q) { maxT = Math.max(maxT, Date.parse(q.snapshot_at)); });
        Object.keys(latest).forEach(function (k) { if (Date.parse(latest[k].snapshot_at) === maxT) out.push(latest[k]); });
      }
    });
    return out;
  }
  /* A book's main line: the line it quotes on its main (non-alternate) market;
     when every quote is alternate, the line whose two sides are closest to
     even money. */
  function bookMainLine(qs) {
    var main = qs.filter(function (q) { return q.is_main_line; });
    var pool = main.length ? main : qs;
    var byLine = {};
    pool.forEach(function (q) { var k = String(num(q.line)); (byLine[k] = byLine[k] || {})[q.side] = q; });
    var best = null, bestGap = Infinity;
    Object.keys(byLine).forEach(function (k) {
      var g = byLine[k], o = g.over || g.yes, u = g.under || g.no;
      var gap = o && u ? Math.abs(R().impliedProb(o.american_price) - R().impliedProb(u.american_price)) : 1;
      if (gap < bestGap) { bestGap = gap; best = Number(k); }
    });
    return best;
  }
  function marketView(quotes, opts) {
    opts = opts || {};
    var latest = latestByBook(quotes, opts);
    var books = {}; latest.forEach(function (q) { (books[q.sportsbook] = books[q.sportsbook] || []).push(q); });
    var bookNames = Object.keys(books).sort();
    var binary = latest.some(function (q) { return q.side === 'yes' || q.side === 'no'; });
    var mains = [], nvOver = [], perBook = [];
    bookNames.forEach(function (b) {
      var qs = books[b], ml = binary ? null : bookMainLine(qs);
      var o = qs.filter(function (q) { return (binary ? q.side === 'yes' : q.side === 'over') && (binary || num(q.line) === ml); })[0] || null;
      var u = qs.filter(function (q) { return (binary ? q.side === 'no' : q.side === 'under') && (binary || num(q.line) === ml); })[0] || null;
      var nv = o && u ? noVig(o.american_price, u.american_price) : null;
      if (!binary && ml != null) mains.push(ml);
      if (nv) nvOver.push(nv.p);
      perBook.push({ sportsbook: b, main_line: ml, over_price: o ? o.american_price : null, under_price: u ? u.american_price : null,
        no_vig_over: nv ? r(nv.p, 4) : null, overround: nv ? r(nv.overround, 4) : null, n_quotes: qs.length,
        snapshot_at: qs.reduce(function (a, q) { return !a || Date.parse(q.snapshot_at) > Date.parse(a) ? q.snapshot_at : a; }, null) });
    });
    var consensusLine = binary ? null : median(mains);
    /* consensus probability = median no-vig over-probability of the books AT
       the consensus line (a book at another number is not comparable) */
    var atCons = perBook.filter(function (b) { return binary || b.main_line === consensusLine; }).map(function (b) { return b.no_vig_over; }).filter(isNum);
    var consP = atCons.length ? median(atCons) : null;
    function best(side, lineFilter) {
      var c = latest.filter(function (q) { return q.side === side && (lineFilter == null || num(q.line) === lineFilter); });
      c.sort(function (a, b) { return (R().americanToDecimal(b.american_price) - R().americanToDecimal(a.american_price)) || String(a.sportsbook).localeCompare(String(b.sportsbook)); });
      return c[0] || null;
    }
    var overSide = binary ? 'yes' : 'over', underSide = binary ? 'no' : 'under';
    var bestOverPrice = best(overSide, binary ? null : consensusLine), bestUnderPrice = best(underSide, binary ? null : consensusLine);
    /* best NUMBER: the lowest over line / highest under line any book offers on a main market */
    var mainQs = latest.filter(function (q) { return q.is_main_line || !latest.some(function (x) { return x.is_main_line && x.sportsbook === q.sportsbook; }); });
    var overs = mainQs.filter(function (q) { return q.side === 'over'; }).sort(function (a, b) { return num(a.line) - num(b.line) || R().americanToDecimal(b.american_price) - R().americanToDecimal(a.american_price); });
    var unders = mainQs.filter(function (q) { return q.side === 'under'; }).sort(function (a, b) { return num(b.line) - num(a.line) || R().americanToDecimal(b.american_price) - R().americanToDecimal(a.american_price); });
    var lastAt = latest.reduce(function (a, q) { return !a || Date.parse(q.snapshot_at) > Date.parse(a) ? q.snapshot_at : a; }, null);
    return {
      binary: binary, book_count: bookNames.length, books: perBook,
      consensus_line: consensusLine, consensus_over_prob: consP != null ? r(consP, 4) : null,
      consensus_under_prob: consP != null ? r(1 - consP, 4) : null,
      line_dispersion: mains.length > 1 ? r(Math.max.apply(null, mains) - Math.min.apply(null, mains), 2) : (mains.length ? 0 : null),
      line_sd: r(sd(mains), 3),
      price_dispersion: nvOver.length > 1 ? r(sd(nvOver), 4) : (nvOver.length ? 0 : null),
      best_over_price: bestOverPrice, best_under_price: bestUnderPrice,
      best_over_line: binary ? null : (overs[0] || null), best_under_line: binary ? null : (unders[0] || null),
      updated_at: lastAt, n_quotes: latest.length
    };
  }

  /* ============================================================ MOVEMENT
     history = every observed quote for one player-market (all books,
     all snapshots). Opener = the earliest snapshot's consensus; current =
     the latest; close = the last snapshot at or before kickoff. A move is
     "meaningful" when the consensus line changes or the consensus no-vig
     over-probability moves by at least 2 percentage points. */
  function snapshotsOf(history) {
    var by = {};
    (history || []).forEach(function (q) { if (q.lineage === 'observed' && q.snapshot_at) (by[q.snapshot_at] = by[q.snapshot_at] || []).push(q); });
    return Object.keys(by).sort(function (a, b) { return Date.parse(a) - Date.parse(b); });
  }
  function movement(history, opts) {
    opts = opts || {};
    var kick = opts.kickoff ? Date.parse(opts.kickoff) : null, now = opts.now != null ? opts.now : Date.now();
    var times = snapshotsOf(history);
    (opts.listings || []).forEach(function (l) { if (times.indexOf(l.snapshot_at) < 0) times.push(l.snapshot_at); });
    times.sort(function (a, b) { return Date.parse(a) - Date.parse(b); });
    if (!times.length) return { available: false, reason: 'no observed quotes' };
    /* the market as of each snapshot: every book's listing at that time */
    var states = times.map(function (t) {
      var v = marketView(history, { at: Date.parse(t), listings: opts.listings });
      return { at: t, line: v.consensus_line, over_prob: v.consensus_over_prob,
        over_price: v.best_over_price ? v.best_over_price.american_price : null, under_price: v.best_under_price ? v.best_under_price.american_price : null, books: v.book_count };
    });
    var open = states[0], cur = states[states.length - 1];
    var pre = kick ? states.filter(function (s) { return Date.parse(s.at) <= kick; }) : [];
    var close = kick && now >= kick && pre.length ? pre[pre.length - 1] : null;
    var lastMove = null;
    for (var i = 1; i < states.length; i++) {
      var a = states[i - 1], b = states[i];
      if ((isNum(a.line) && isNum(b.line) && a.line !== b.line) || (isNum(a.over_prob) && isNum(b.over_prob) && Math.abs(a.over_prob - b.over_prob) >= 0.02)) lastMove = b.at;
    }
    return {
      available: true, n_snapshots: states.length,
      open: open, current: cur, close: close,
      line_move: isNum(open.line) && isNum(cur.line) ? r(cur.line - open.line, 2) : null,
      over_prob_move: isNum(open.over_prob) && isNum(cur.over_prob) ? r(cur.over_prob - open.over_prob, 4) : null,
      over_price_move_cents: isNum(open.over_price) && isNum(cur.over_price) ? Q().centsBetter(open.over_price, cur.over_price) : null,
      last_meaningful_move_at: lastMove,
      minutes_since_move: lastMove ? Math.round((now - Date.parse(lastMove)) / 60000) : null,
      note: 'Movement is a market diagnostic. EdgeDesk has not validated it as predictive and does not treat it as such.'
    };
  }

  /* ============================================================ LADDER
     Every observed quote on one side of one player-market (main and
     alternate lines, every book), each evaluated against the SAME stored
     distribution. Rows by line, safest first (over: lowest line; under:
     highest line), the best price per line, the (P, EV) frontier, the raw
     max-EV quote and the best VALUE quote:

       best value = the highest expected log-growth of a quarter-Kelly stake
                    on the CONSERVATIVE probability (market-anchored, tail-
                    penalised), among quotes with positive conservative EV.

     Log-growth rewards EV but charges for variance, so a long-shot alternate
     with the largest raw edge does not win by default. Both are reported. */
  function ladder(evals, opts) {
    opts = opts || {};
    var side = opts.side || (evals[0] && evals[0].side) || 'over';
    var ok = evals.filter(function (e) { return e && e.ok && e.side === side; });
    var byLine = {};
    ok.forEach(function (e) { var k = String(e.line); (byLine[k] = byLine[k] || []).push(e); });
    var rows = Object.keys(byLine).map(function (k) {
      var qs = byLine[k].slice().sort(function (a, b) { return (b.decimal - a.decimal) || String(a.sportsbook).localeCompare(String(b.sportsbook)); });
      return { line: Number(k), best: qs[0], quotes: qs, n_books: qs.length, is_main_line: isNum(opts.main_line) && Math.abs(Number(k) - opts.main_line) < EPS };
    }).sort(function (a, b) { return side === 'under' ? b.line - a.line : a.line - b.line; });
    var flags = [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].best.model_prob > rows[i - 1].best.model_prob + 1e-9) flags.push({ code: 'PROB_NON_MONOTONE', severity: 'HIGH', text: 'model probability rises from ' + rows[i - 1].line + ' to ' + rows[i].line + ' although the line got harder' });
      if (rows[i].best.decimal < rows[i - 1].best.decimal - 1e-9) flags.push({ code: 'PRICE_NON_MONOTONE', severity: 'LOW', text: 'the harder line ' + rows[i].line + ' pays less than ' + rows[i - 1].line + ': compare books' });
    }
    var bests = rows.map(function (x) { return x.best; });
    bests.forEach(function (o) { o.dominated = bests.some(function (b) { return b !== o && b.model_prob >= o.model_prob - EPS && b.ev > o.ev + 1e-9; }); });
    var frontier = bests.filter(function (o) { return !o.dominated; });
    var maxEv = bests.slice().sort(function (a, b) { return b.ev - a.ev; })[0] || null;
    /* positive at the published precision (a +0.00% "best value" is not one) */
    var value = bests.filter(function (o) { return o.conservative_ev >= 5e-5 && isNum(o.kelly_growth) && o.kelly_growth >= 5e-7; })
      .sort(function (a, b) { return (b.kelly_growth - a.kelly_growth) || (b.model_prob - a.model_prob); })[0] || null;
    var highestProb = bests.slice().sort(function (a, b) { return b.model_prob - a.model_prob; })[0] || null;
    return {
      side: side, rows: rows.map(function (x) {
        return { line: x.line, is_main_line: x.is_main_line, n_books: x.n_books, sportsbook: x.best.sportsbook, american: x.best.american,
          model_prob: r(x.best.model_prob, 4), model_push: r(x.best.model_push, 4), fair_american: x.best.fair_american,
          implied_prob: r(x.best.implied_prob, 4), no_vig_prob: r(x.best.no_vig_prob, 4), ev: r(x.best.ev, 4),
          conservative_ev: r(x.best.conservative_ev, 4), kelly_growth: r(x.best.kelly_growth, 6), dominated: !!x.best.dominated,
          books: x.quotes.map(function (q) { return { sportsbook: q.sportsbook, american: q.american, ev: r(q.ev, 4) }; }) };
      }),
      frontier_lines: frontier.map(function (o) { return o.line; }),
      max_ev: maxEv ? { line: maxEv.line, sportsbook: maxEv.sportsbook, american: maxEv.american, ev: r(maxEv.ev, 4), model_prob: r(maxEv.model_prob, 4) } : null,
      best_value: value ? { line: value.line, sportsbook: value.sportsbook, american: value.american, ev: r(value.ev, 4), conservative_ev: r(value.conservative_ev, 4),
        model_prob: r(value.model_prob, 4), kelly_growth: r(value.kelly_growth, 6) } : null,
      highest_probability: highestProb ? { line: highestProb.line, sportsbook: highestProb.sportsbook, american: highestProb.american, model_prob: r(highestProb.model_prob, 4), ev: r(highestProb.ev, 4) } : null,
      rule: 'Best value = highest expected log-growth of a quarter-Kelly stake on the conservative (market-anchored, tail-penalised) probability, among positive conservative-EV quotes. Highest win probability and largest raw EV are shown beside it, never substituted for it.',
      flags: flags
    };
  }

  /* The line at which this price stops being positive EV ("playable to"):
     scans half points from the quoted line in the side's losing direction. */
  function playableTo(d, side, american, fromLine, step) {
    step = step || 0.5;
    var dir = side === 'over' ? 1 : -1, last = null;
    for (var i = 0; i <= 200; i++) {
      var L = fromLine + dir * i * step;
      var sp = sideProbs(d, side, L); if (!sp) break;
      var ev = Q().expectedValue(sp.win, sp.push, sp.loss, R().americanToDecimal(american));
      if (ev == null || ev <= 0) break;
      last = L;
    }
    return last;
  }
  /* The price at which this line stops being positive EV (the break-even American) */
  function playablePrice(d, side, line) {
    var sp = sideProbs(d, side, line); if (!sp) return null;
    return Q().fairAmerican(sp.win, sp.push);
  }

  /* ========================================================== CONFIDENCE
     EDGE, CONFIDENCE and DATA QUALITY are three different numbers. A 10%
     modelled edge with a guessed role is not a 5% edge with a known one. Each
     component is 0-1 (1 = no concern) or null (unknown, weighted out and
     named). The score is the weighted mean of the known components, capped by
     the weakest hard gate (injury, identity). */
  var CONF_WEIGHTS = {
    sample_size: 0.14, model_calibration: 0.14, role_certainty: 0.14, injury_certainty: 0.12, qb_certainty: 0.08,
    model_agreement: 0.10, market_depth: 0.08, book_dispersion: 0.08, source_quality: 0.12
  };
  var CONF_LABELS = {
    sample_size: 'Sample size', model_calibration: 'Model calibration', role_certainty: 'Role certainty', injury_certainty: 'Injury certainty',
    qb_certainty: 'QB certainty', model_agreement: 'Model agreement', market_depth: 'Market depth', book_dispersion: 'Cross-book agreement', source_quality: 'Source quality'
  };
  function confidence(c) {
    c = c || {};
    var comps = [], wsum = 0, tot = 0, unknown = [];
    Object.keys(CONF_WEIGHTS).forEach(function (k) {
      var v = isNum(c[k]) ? clamp(c[k], 0, 1) : null;
      comps.push({ key: k, label: CONF_LABELS[k], value: v == null ? null : r(v, 3), weight: CONF_WEIGHTS[k], note: (c.notes && c.notes[k]) || null });
      if (v == null) { unknown.push(k); return; }
      wsum += CONF_WEIGHTS[k]; tot += CONF_WEIGHTS[k] * v;
    });
    var base = wsum > 0 ? tot / wsum : null;
    /* hard caps: an uncertain injury or a guessed identity bounds everything */
    var cap = 1;
    if (isNum(c.injury_certainty)) cap = Math.min(cap, 0.35 + 0.65 * c.injury_certainty);
    if (isNum(c.source_quality)) cap = Math.min(cap, 0.3 + 0.7 * c.source_quality);
    /* unknown components are not assumed fine: each costs 3 points */
    var score = base == null ? null : Math.max(0, Math.min(base, cap) * 100 - 3 * unknown.length);
    return { score: score == null ? null : Math.round(score), grade: score == null ? 'UNKNOWN' : (score >= 70 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW'),
      components: comps, unknown: unknown };
  }
  /* sample size → 0-1 (games of evidence for THIS stat at THIS role) */
  function sampleCertainty(games) { return isNum(games) ? clamp(1 - Math.exp(-games / 6), 0, 1) : null; }
  /* market depth → 0-1 */
  function depthCertainty(books) { return isNum(books) ? clamp(books / 6, 0, 1) : null; }
  /* cross-book dispersion (sd of no-vig over-probabilities) → 0-1 */
  function dispersionCertainty(priceSd, lineRange, scale) {
    if (!isNum(priceSd) && !isNum(lineRange)) return null;
    var a = isNum(priceSd) ? clamp(1 - priceSd / 0.06, 0, 1) : 1;
    var b = isNum(lineRange) && isNum(scale) && scale > 0 ? clamp(1 - lineRange / scale, 0, 1) : 1;
    return Math.min(a, b);
  }

  /* DATA QUALITY (0-1): how complete and trustworthy the INPUTS are, not how
     good the bet is. feature_completeness = share of model features present
     (not imputed), weighted by importance. */
  function dataQuality(inp) {
    inp = inp || {};
    var parts = [], w = 0, t = 0;
    function add(k, v, wt, label) { if (!isNum(v)) { parts.push({ key: k, label: label, value: null }); return; } v = clamp(v, 0, 1); parts.push({ key: k, label: label, value: r(v, 3) }); w += wt; t += wt * v; }
    add('feature_completeness', inp.feature_completeness, 0.35, 'Feature completeness');
    add('identity_confidence', inp.identity_confidence, 0.2, 'Player identity');
    add('source_quality', inp.source_quality, 0.2, 'Historical source quality');
    add('quote_freshness', inp.quote_freshness, 0.15, 'Quote freshness');
    add('availability_freshness', inp.availability_freshness, 0.1, 'Availability freshness');
    var s = w > 0 ? t / w : null;
    return { score: s == null ? null : r(s, 3), parts: parts };
  }
  /* quote age → 0-1 freshness (fresh inside 30 min, stale after 6 h) */
  function freshness(ageMinutes) { return isNum(ageMinutes) ? clamp(1 - Math.max(0, ageMinutes - 30) / 330, 0, 1) : null; }

  /* ============================================================ DECISION
     Research, not picks. The label says whether a quote deserves a look.
     BET is reachable only when the market-calibration tier for this model is
     VALIDATED (walk-forward on observed quotes passed); until then the
     strongest label is LEAN, and the reason says so. */
  var EDGE_BUCKETS = [[0, 0.02, '0-2%'], [0.02, 0.04, '2-4%'], [0.04, 0.06, '4-6%'], [0.06, 0.08, '6-8%'], [0.08, 0.10, '8-10%'], [0.10, Infinity, '10%+']];
  function edgeBucket(edge) {
    if (!isNum(edge)) return null;
    if (edge < 0) return 'negative';
    for (var i = 0; i < EDGE_BUCKETS.length; i++) if (edge >= EDGE_BUCKETS[i][0] && edge < EDGE_BUCKETS[i][1]) return EDGE_BUCKETS[i][2];
    return '10%+';
  }
  function confidenceBucket(score) { return !isNum(score) ? 'unknown' : score >= 70 ? '70+' : score >= 60 ? '60-69' : score >= 50 ? '50-59' : '<50'; }
  function priceBucket(american) { if (!isNum(american)) return null; return american <= -200 ? '<=-200' : american <= -130 ? '-199..-130' : american < 100 ? '-129..-101' : american <= 130 ? '+100..+130' : american <= 200 ? '+131..+200' : '>+200'; }
  var GATES = { min_confidence_bet: 60, min_quality_bet: 0.7, min_cons_ev_bet: 0.02, min_cons_ev_lean: 0.01, min_confidence_lean: 45, min_quality_lean: 0.55, min_ev_watch: 0 };
  function decide(ev, conf, quality, tier, gates) {
    var G = gates || GATES, reasons = [];
    if (!ev || !ev.ok) return { decision: 'PASS', reasons: [ev && ev.reason ? ev.reason : 'not evaluated'], units: null };
    var c = conf && isNum(conf.score) ? conf.score : null, dq = quality && isNum(quality.score) ? quality.score : null;
    var validated = tier === 'VALIDATED';
    if (ev.conservative_ev != null && ev.conservative_ev >= G.min_cons_ev_bet && c != null && c >= G.min_confidence_bet && dq != null && dq >= G.min_quality_bet) {
      if (validated) return { decision: 'BET', reasons: ['conservative EV ' + (100 * ev.conservative_ev).toFixed(1) + '% at confidence ' + c + ' and data quality ' + dq.toFixed(2)], units: null };
      reasons.push('would qualify as BET, but this model\'s market calibration is ' + (tier || 'RESEARCH') + ', not VALIDATED: capped at LEAN');
      return { decision: 'LEAN', reasons: reasons, units: null };
    }
    if (ev.conservative_ev != null && ev.conservative_ev >= G.min_cons_ev_lean && c != null && c >= G.min_confidence_lean && dq != null && dq >= G.min_quality_lean)
      return { decision: 'LEAN', reasons: ['conservative EV ' + (100 * ev.conservative_ev).toFixed(1) + '% clears the lean bar; confidence ' + c], units: null };
    if (ev.ev != null && ev.ev > G.min_ev_watch) {
      if (c == null || c < G.min_confidence_lean) reasons.push('positive raw EV but confidence ' + (c == null ? 'unknown' : c) + ' is too low to trust it');
      else if (dq == null || dq < G.min_quality_lean) reasons.push('positive raw EV but data quality ' + (dq == null ? 'unknown' : dq.toFixed(2)) + ' is too thin');
      else reasons.push('positive raw EV, but the market-anchored conservative EV does not clear the bar');
      return { decision: 'WATCH', reasons: reasons, units: null };
    }
    return { decision: 'PASS', reasons: ['no positive EV at this price'], units: null };
  }

  /* ========================================================== SETTLEMENT */
  function settle(side, line, actual, opts) {
    opts = opts || {};
    if (opts.void_reason) return 'VOID';
    if (!isNum(actual)) return null;
    if (side === 'yes') return actual >= 1 ? 'WIN' : 'LOSS';
    if (side === 'no') return actual >= 1 ? 'LOSS' : 'WIN';
    if (!isNum(line)) return null;
    if (Math.abs(actual - line) < 1e-9) return 'PUSH';
    if (side === 'over') return actual > line ? 'WIN' : 'LOSS';
    if (side === 'under') return actual < line ? 'WIN' : 'LOSS';
    return null;
  }
  function unitsFor(result, american, stake) {
    var s = isNum(stake) ? stake : 1, d = R().americanToDecimal(american);
    if (!d || !result) return null;
    if (result === 'WIN') return r(s * (d - 1), 4);
    if (result === 'LOSS') return -s;
    return 0;
  }
  /* CLV at the same line: the closing no-vig probability of the side minus
     the break-even of the price taken (research_core.clvPrice); plus the line
     CLV in points, signed so + = the number taken was better. */
  function clv(entry, close) {
    if (!entry || !close) return { price: null, line: null };
    var same = isNum(num(entry.line)) && isNum(num(close.line)) && num(entry.line) === num(close.line);
    var price = same && isNum(close.side_price) && isNum(close.other_price) ? R().clvPrice(entry.american, close.side_price, close.other_price, true) : null;
    var line = null;
    if (isNum(num(entry.line)) && isNum(num(close.line))) line = entry.side === 'over' ? num(close.line) - num(entry.line) : num(entry.line) - num(close.line);
    return { price: price, line: line == null ? null : r(line, 2) };
  }

  /* ============================================================= METRICS */
  function pinball(y, qv, tau) { return isNum(y) && isNum(qv) ? (y >= qv ? tau * (y - qv) : (1 - tau) * (qv - y)) : null; }
  /* PIT (randomised for integer stats) — should be ~uniform when calibrated */
  function pit(d, y, u) {
    if (!validDist(d) || !isNum(y)) return null;
    var integer = d.t === 'pmf' || d.int;
    if (!integer) return cdf(d, y);
    var hi = d.t === 'pmf' ? cdf(d, y) : cdf(d, y + 0.5), lo = d.t === 'pmf' ? cdf(d, y - 1) : cdf(d, y - 0.5);
    return lo + (isNum(u) ? u : 0.5) * (hi - lo);
  }
  function calibrationBins(pairs, nBins) {
    nBins = nBins || 10; var bins = [];
    for (var i = 0; i < nBins; i++) bins.push({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, p: 0, y: 0 });
    pairs.forEach(function (x) { if (!isNum(x.p) || (x.y !== 0 && x.y !== 1)) return; var b = bins[Math.min(nBins - 1, Math.floor(x.p * nBins))]; b.n++; b.p += x.p; b.y += x.y; });
    return bins.filter(function (b) { return b.n > 0; }).map(function (b) { return { lo: b.lo, hi: b.hi, n: b.n, mean_p: r(b.p / b.n, 4), hit_rate: r(b.y / b.n, 4) }; });
  }

  /* ========================================================= EXPLANATION
     Plain-English, deterministic, and built ONLY from fields that are
     present: a missing input is named as missing, never described. */
  function fmt(x, d) { return isNum(x) ? x.toFixed(d == null ? 1 : d) : '—'; }
  function pct(x, d) { return isNum(x) ? (100 * x).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function amStr(a) { return isNum(a) ? (a > 0 ? '+' : '') + Math.round(a) : '—'; }
  function explain(p) {
    var out = { model: [], market: [], disagreement: [], support: [], risks: [], invalidators: [], tagline: 'Research, not picks.' };
    var m = p.model || {}, mk = p.market || {}, e = p.focus || {}, lab = marketLabel(p.market_key);
    var bern = m.dist && m.dist.t === 'bern';
    if (bern && isNum(m.dist.p)) out.model.push('EdgeDesk gives this player a ' + pct(m.dist.p) + ' chance to score a touchdown' + (isNum(m.fair_over) ? ' (a fair price of ' + amStr(m.fair_over) + ' on yes)' : '') + '.');
    else if (isNum(m.mean)) out.model.push('EdgeDesk projects ' + fmt(m.mean) + ' ' + lab.toLowerCase() + ' (median ' + fmt(m.median) + ', 80% range ' + fmt(m.p10) + '–' + fmt(m.p90) + ').');
    else out.model.push('No model projection is available for this player and market.');
    if (isNum(e.line) && isNum(e.model_prob)) out.model.push('That distribution puts ' + e.side + ' ' + e.line + ' at ' + pct(e.model_prob) + ', a fair price of ' + amStr(e.fair_american) + '.');
    if (isNum(mk.consensus_line)) out.market.push(mk.book_count + ' book' + (mk.book_count === 1 ? '' : 's') + ' center the line at ' + mk.consensus_line + (isNum(mk.consensus_over_prob) ? ' with a no-vig over probability of ' + pct(mk.consensus_over_prob) : '') + '.');
    else out.market.push('No observed sportsbook line has been captured for this prop.');
    if (isNum(e.edge_vs_market)) {
      out.disagreement.push('Model ' + pct(e.model_prob) + ' vs market ' + pct(e.market_prob) + ': a probability edge of ' + (e.edge_vs_market >= 0 ? '+' : '') + pct(e.edge_vs_market) + ' on the ' + e.side + '.');
      if (isNum(e.ev)) out.disagreement.push('At ' + amStr(e.american) + ' (' + (e.sportsbook || 'book') + ') the expected return is ' + (e.ev >= 0 ? '+' : '') + pct(e.ev) + ' per unit; the market-anchored conservative figure is ' + (isNum(e.conservative_ev) ? (e.conservative_ev >= 0 ? '+' : '') + pct(e.conservative_ev) : '—') + '.');
    }
    (p.drivers || []).slice(0, 4).forEach(function (d) { (d.effect >= 0 ? out.support : out.risks).push(d.text); });
    var conf = p.confidence || {};
    (conf.components || []).filter(function (c) { return isNum(c.value) && c.value < 0.5; }).forEach(function (c) { out.risks.push(c.label + ' is weak' + (c.note ? ': ' + c.note : '') + '.'); });
    (conf.unknown || []).forEach(function (k) { out.risks.push((CONF_LABELS[k] || k) + ' is unknown, so it cannot support the number.'); });
    if (isNum(p.playable_to)) out.invalidators.push('The ' + e.side + ' stops being positive EV at ' + amStr(e.american) + ' beyond ' + p.playable_to + '.');
    (p.availability_invalidators || []).forEach(function (t) { out.invalidators.push(t); });
    if (!out.invalidators.length) out.invalidators.push('A role change, an inactive designation or a line move past the fair price would remove the edge.');
    return out;
  }

  /* ============================================================ REPRICE
     THE MARKET HALF OF A PROP, re-runnable on its own: every observed quote
     priced against the prop's stored distribution, the market view, the
     movement, the alternate-line ladders, the market-dependent confidence
     components, data quality, the decision, the reference probabilities and
     the explanation. The scorer runs it once per prop; the page and the AI
     desk run the SAME function on the published card and quotes, so a
     research card is re-derived, never re-typed.
       opts.listings  the per-poll listings (withdrawn lines drop out)
       opts.now       the as-of clock (quote freshness)
       opts.movement  a movement summary computed upstream from the full quote
                      history (the published quotes are the current set only) */
  function fairFromProb(win, push) { if (!isNum(win) || win <= 0 || win >= 1) return null; var d = (1 - (push || 0)) / win; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function slimQuote(q) { return q ? { sportsbook: q.sportsbook, side: q.side, line: q.line, american: q.american_price, snapshot_at: q.snapshot_at } : null; }
  function confInputs(c) {
    var o = { notes: {} };
    ((c && c.components) || []).forEach(function (x) { o[x.key] = x.value; if (x.note) o.notes[x.key] = x.note; });
    return o;
  }
  function reprice(prop, quotes, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var m = prop.model, d = m.dist;
    var qs = (quotes || []).filter(function (q) { return q.lineage === 'observed'; });
    var lopt = opts.listings && opts.listings.length ? { listings: opts.listings } : {};
    var mv = qs.length ? marketView(qs, lopt) : null;
    var moveInfo = opts.movement !== undefined ? opts.movement : (qs.length ? movement(qs, { kickoff: prop.kickoff_utc, now: now, listings: lopt.listings }) : null);
    var comps = confInputs(prop.confidence || confidence({}));
    comps.market_depth = mv ? depthCertainty(mv.book_count) : null;
    comps.book_dispersion = mv ? dispersionCertainty(mv.price_dispersion, mv.line_dispersion, Math.max(1, m.sd || 1)) : null;
    var conf = confidence(comps);
    var quoteAge = mv && mv.updated_at ? (now - Date.parse(mv.updated_at)) / 60000 : null;
    var dqIn = {}; Object.keys(prop._dq_inputs || {}).forEach(function (k) { dqIn[k] = prop._dq_inputs[k]; });
    dqIn.quote_freshness = quoteAge == null ? null : freshness(quoteAge);
    var dq = dataQuality(dqIn);
    var reliability = conf.score == null ? 0.3 : Math.max(0.1, Math.min(0.9, conf.score / 100));
    var current = qs.length ? latestByBook(qs, lopt) : [];
    var paired = pairQuotes(current);
    function consensusFor(side, line) {
      if (!mv) return null;
      if (mv.binary) return side === 'yes' ? mv.consensus_over_prob : mv.consensus_under_prob;
      if (line !== mv.consensus_line) return null;
      return side === 'over' ? mv.consensus_over_prob : mv.consensus_under_prob;
    }
    var evals = paired.map(function (x) {
      var q = x.quote;
      var tz = isNum(q.line) && m.sd > 0 ? (q.line - m.median) / m.sd : null;
      var ev = evaluateQuote(d, q, { no_vig_prob: x.no_vig_prob, consensus_prob: consensusFor(q.side, q.line), reliability: reliability, tail_z: tz });
      ev.is_main_line = !!q.is_main_line; ev.snapshot_at = q.snapshot_at; ev.quote_id = q.quote_id || null;
      return ev;
    }).filter(function (e) { return e.ok; });
    var binary = d.t === 'bern';
    var mainLine = mv ? mv.consensus_line : null;
    var ladders = binary || !evals.length ? null : { over: ladder(evals, { side: 'over', main_line: mainLine }), under: ladder(evals, { side: 'under', main_line: mainLine }) };
    var focus = null;
    if (evals.length) {
      var bestOf = function (side) { var l = ladders ? ladders[side] : null, bv = l && l.best_value; return bv ? evals.filter(function (e) { return e.side === side && e.line === bv.line && e.sportsbook === bv.sportsbook; })[0] || null : null; };
      var cands = binary ? evals.filter(function (e) { return e.side === 'yes' || e.side === 'no'; }) : [bestOf('over'), bestOf('under')].filter(Boolean);
      focus = cands.sort(function (x, y) { return (y.kelly_growth || 0) - (x.kelly_growth || 0); })[0] || evals.slice().sort(function (x, y) { return y.ev - x.ev; })[0];
    }
    var decision = focus ? decide(focus, conf, dq, m.market_tier) : { decision: 'PASS', reasons: [mv ? 'no quote priced' : 'no observed sportsbook line captured'], units: null };
    var refLine = mv && isNum(mv.consensus_line) ? mv.consensus_line : (binary ? null : Math.floor(m.median) + 0.5);
    var rp = refLine != null ? probs(d, refLine) : (binary ? { over: d.p, under: 1 - d.p, push: 0 } : null);
    m.ref_line = refLine;
    m.over_prob = rp ? r(rp.over, 4) : null; m.under_prob = rp ? r(rp.under, 4) : null;
    m.fair_over = rp ? fairFromProb(rp.over, rp.push) : null; m.fair_under = rp ? fairFromProb(rp.under, rp.push) : null;
    prop.market = mv ? { consensus_line: mv.consensus_line, consensus_over_prob: mv.consensus_over_prob, consensus_under_prob: mv.consensus_under_prob, book_count: mv.book_count, binary: mv.binary,
      line_dispersion: mv.line_dispersion, price_dispersion: mv.price_dispersion, best_over_price: slimQuote(mv.best_over_price), best_under_price: slimQuote(mv.best_under_price),
      best_over_line: slimQuote(mv.best_over_line), best_under_line: slimQuote(mv.best_under_line), books: mv.books, updated_at: mv.updated_at } : null;
    prop.movement = moveInfo || null;
    prop.focus = focus ? { side: focus.side, line: focus.line, sportsbook: focus.sportsbook, american: focus.american, implied_prob: r(focus.implied_prob, 4), no_vig_prob: r(focus.no_vig_prob, 4),
      market_prob: r(focus.market_prob, 4), model_prob: r(focus.model_prob, 4), model_push: r(focus.model_push, 4), edge_vs_market: r(focus.edge_vs_market, 4), edge_vs_implied: r(focus.edge_vs_implied, 4),
      fair_american: focus.fair_american, ev: r(focus.ev, 4), conservative_ev: r(focus.conservative_ev, 4), kelly_growth: r(focus.kelly_growth, 6), snapshot_at: focus.snapshot_at } : null;
    prop.ladders = ladders; prop.n_quotes = current.length;     /* quotes each book currently lists */
    prop.confidence = conf; prop.data_quality = dq; prop.decision = decision;
    prop.playable_to = focus && !binary ? playableTo(d, focus.side, focus.american, focus.line) : null;
    prop.explain = explain({ market_key: prop.market_key, model: m, market: prop.market, focus: prop.focus, drivers: prop.drivers, confidence: conf, playable_to: prop.playable_to,
      availability_invalidators: prop._invalidators || [] });
    /* the current quote set, for the publisher (never itself published on the card) */
    Object.defineProperty(prop, '_current_quotes', { value: current, enumerable: false, configurable: true, writable: true });
    return prop;
  }

  /* ============================================================ WIRE
     The published artifacts are PACKED so a slate never becomes a giant
     payload, and the page and the AI desk UNPACK them with these functions
     (never with a copy of them):
       board_<lg>.json           one short array per player-market, with the
                                 games, players, markets and model versions as
                                 lookup tables
       <lg>/<game_id>.json       the research CARD: the model half of every
                                 prop (distribution, drivers, confidence and
                                 data-quality inputs) with each player's
                                 context stored once. It changes only when the
                                 model's inputs change.
       <lg>/<game_id>.market.json the observed quotes currently listed for the
                                 game (book, side, line, price, capture time)
                                 and each prop's movement summary; written only
                                 when a quote exists.
     expandCard(card, market) re-runs reprice() on the card with those quotes,
     so every price, ladder, EV, decision and explanation a reader sees is
     computed by the kernel from the observed quotes, not stored twice. */
  var CONF_KEYS = Object.keys(CONF_WEIGHTS);
  var DQ_KEYS = ['feature_completeness', 'identity_confidence', 'source_quality', 'availability_freshness'];
  var SIDE_CODE = { over: 'o', under: 'u', yes: 'y', no: 'n' }, CODE_SIDE = { o: 'over', u: 'under', y: 'yes', n: 'no' };
  function driverText(x) { return x.label + ' ' + (isNum(x.value) ? r(x.value, 2) : '') + ' moves the projection ' + (x.pct >= 0 ? '+' : '') + (isNum(x.pct) ? x.pct.toFixed(1) : '?') + '%'; }
  function toMs(iso) { var t = Date.parse(iso); return isFinite(t) ? t : null; }
  function fromMs(t) { return isNum(t) ? new Date(t).toISOString() : null; }
  function roundDist(d) {
    if (!d) return d;
    if (d.t === 'pmf') { var v = d.v.map(function (x) { return r(x, 6); }); while (v.length > 1 && v[v.length - 1] === 0) v.pop(); return { t: 'pmf', v: v, tail: r(d.tail || 0, 6) }; }
    if (d.t === 'cdf') return { t: 'cdf', x: d.x.map(function (x) { return r(x, 2); }), p: d.p.map(function (x) { return r(x, 5); }), int: !!d.int };
    if (d.t === 'bern') return { t: 'bern', p: r(d.p, 6) };
    return d;
  }

  function packCard(props, game, meta) {
    meta = meta || {};
    var players = {}, out = [], feats = [], labels = [], fi = {}, models = [], mi = {};
    function fIdx(name, label) { if (fi[name] == null) { fi[name] = feats.length; feats.push(name); labels.push(label == null ? null : label); } else if (label != null && labels[fi[name]] == null) labels[fi[name]] = label; return fi[name]; }
    (props || []).forEach(function (p) {
      /* player-level: context, availability invalidators and the source watermark are the same for every market */
      if (!players[p.player_id]) {
        players[p.player_id] = { n: p.player, t: p.team, pos: p.position, hs: p.headshot || null, src: p.source_max_timestamp || null, ctx: p.context || null };
        if (p._invalidators && p._invalidators.length) players[p.player_id].inv = p._invalidators;
      }
      var m = p.model, c = {}, notes = null;
      ((p.confidence && p.confidence.components) || []).forEach(function (x) { c[x.key] = x.value; if (x.note && x.key !== 'market_depth' && x.key !== 'book_dispersion') (notes = notes || {})[x.key] = x.note; });
      var mk = m.model_version + '|' + m.market_tier + '|' + m.outcome_tier;
      if (mi[mk] == null) { mi[mk] = models.length; models.push({ v: m.model_version, fv: m.feature_version, tc: m.training_cutoff, ot: m.outcome_tier, mt: m.market_tier, rc: m.recalibrated ? 1 : 0 }); }
      var row = { k: p.market_key, pid: p.player_id, mv: mi[mk],
        m: { id: m.prediction_id, at: m.scored_at, mean: m.mean, median: m.median, p10: m.p10, p25: m.p25, p75: m.p75, p90: m.p90, sd: m.sd, u: m.uncertainty, dist: m.dist },
        c: CONF_KEYS.map(function (k) { return k === 'market_depth' || k === 'book_dispersion' ? null : (c[k] == null ? null : c[k]); }),
        dq: DQ_KEYS.map(function (k) { var v = p._dq_inputs ? p._dq_inputs[k] : null; return v == null ? null : v; }),
        d: (p.drivers || []).map(function (x) { return [fIdx(x.feature, x.label), x.value, x.effect, x.pct]; }) };
      if (notes) row.cn = notes;
      if (p.imputed && p.imputed.length) row.im = p.imputed.slice(0, 8).map(function (n) { return fIdx(n, null); });
      if (p.source_max_timestamp && p.source_max_timestamp !== players[p.player_id].src) row.src = p.source_max_timestamp;
      if (p._invalidators && JSON.stringify(p._invalidators) !== JSON.stringify(players[p.player_id].inv || [])) row.inv = p._invalidators;
      out.push(row);
    });
    return { schema: 'edgedesk_props_game_v1', league: meta.league || (props[0] && props[0].league) || null, generated_at: meta.generated_at || null, game: game,
      wire: 'Packed card: lib/player_props.js › EDProps.wire.expandCard(card, market) returns the research card of every prop.',
      models: models, features: feats, labels: labels, players: players, props: out };
  }

  function packMarket(props, meta) {
    meta = meta || {};
    var books = [], bi = {}, out = {}, n = 0;
    (props || []).forEach(function (p) {
      var cur = p._current_quotes || [];
      if (!cur.length && !p.movement) return;
      out[p.player_id + '|' + p.market_key] = { q: cur.map(function (q) {
        if (bi[q.sportsbook] == null) { bi[q.sportsbook] = books.length; books.push(q.sportsbook); }
        n++;
        return [bi[q.sportsbook], SIDE_CODE[q.side] || q.side, q.line == null ? null : q.line, q.american_price, toMs(q.snapshot_at), (q.is_main_line ? 1 : 0) + (q.is_alt_line ? 2 : 0)];
      }), mv: p.movement || null };
    });
    if (!n) return null;
    return { schema: 'edgedesk_props_market_v1', league: meta.league || null, game_id: meta.game_id || null, as_of: meta.as_of || null, lineage: 'observed',
      rule: 'Observed sportsbook quotes currently listed (each book\'s latest poll), with the capture time of each price. Nothing reconstructed.', books: books, n_quotes: n, props: out };
  }

  function expandCard(card, market) {
    if (!card || !card.game) return [];
    var g = card.game, mk = market && market.props ? market : null;
    var now = mk && mk.as_of ? Date.parse(mk.as_of) : Date.parse(card.generated_at || '') || Date.now();
    return (card.props || []).map(function (x) {
      var pl = (card.players || {})[x.pid] || {}, team = pl.t, home = team === g.home, M = x.m, V = (card.models || [])[x.mv] || {};
      var F = card.features || [], LB = card.labels || [];
      var comps = { notes: x.cn || {} }; CONF_KEYS.forEach(function (k, i) { comps[k] = x.c ? x.c[i] : null; });
      var dqIn = {}; DQ_KEYS.forEach(function (k, i) { dqIn[k] = x.dq ? x.dq[i] : null; });
      var prop = { id: g.game_id + '|' + x.pid + '|' + x.k, league: card.league, game_id: g.game_id, kickoff_utc: g.kickoff_utc,
        matchup: (g.away_name || g.away) + ' @ ' + (g.home_name || g.home), team: team, opponent: home ? g.away : g.home, is_home: home,
        player_id: x.pid, player: pl.n, position: pl.pos, headshot: pl.hs || null, market_key: x.k, market_label: marketLabel(x.k), family: M.dist ? M.dist.t : null,
        model: { prediction_id: M.id, model_version: V.v, feature_version: V.fv, training_cutoff: V.tc, scored_at: M.at, mean: M.mean, median: M.median, p10: M.p10, p25: M.p25, p75: M.p75, p90: M.p90,
          sd: M.sd, uncertainty: M.u, ref_line: null, over_prob: null, under_prob: null, fair_over: null, fair_under: null, outcome_tier: V.ot, market_tier: V.mt, recalibrated: !!V.rc, dist: M.dist },
        market: null, movement: null, focus: null, ladders: null, n_quotes: 0, confidence: confidence(comps), data_quality: null, decision: null, playable_to: null,
        context: pl.ctx || null,
        drivers: (x.d || []).map(function (a) { var o = { feature: F[a[0]], label: LB[a[0]], value: a[1], effect: a[2], pct: a[3] }; o.text = driverText(o); return o; }),
        imputed: (x.im || []).map(function (i) { return F[i]; }), as_of: M.at, source_max_timestamp: x.src || pl.src || null, _dq_inputs: dqIn, _invalidators: x.inv || pl.inv || [] };
      var e = mk ? mk.props[x.pid + '|' + x.k] : null, quotes = [], listings = [];
      if (e) {
        var perBook = {};
        quotes = (e.q || []).map(function (a) {
          var q = { game_id: g.game_id, player_id: x.pid, market_key: x.k, sportsbook: mk.books[a[0]], side: CODE_SIDE[a[1]] || a[1], line: a[2], american_price: a[3],
            snapshot_at: fromMs(a[4]), is_main_line: !!(a[5] & 1), is_alt_line: !!(a[5] & 2), lineage: 'observed' };
          var L = perBook[q.sportsbook] || (perBook[q.sportsbook] = { sportsbook: q.sportsbook, snapshot_at: q.snapshot_at, keys: [] });
          if (Date.parse(q.snapshot_at) > Date.parse(L.snapshot_at)) L.snapshot_at = q.snapshot_at;
          L.keys.push(qkey(q));
          return q;
        });
        /* the published set IS each book's current listing */
        listings = Object.keys(perBook).map(function (b) { return perBook[b]; });
      }
      return reprice(prop, quotes, { now: now, listings: listings, movement: e ? (e.mv || null) : null });
    });
  }

  var BOARD_COLS = ['g', 'p', 'h', 'mk', 'mv', 'mean', 'median', 'p10', 'p90', 'ref_line', 'over', 'under', 'fair_over', 'fair_under', 'conf', 'dq', 'decision', 'mkt', 'focus', 'move'];
  function packBoard(meta, props) {
    var games = meta.games || [], gi = {}, players = [], pi = {}, markets = [], mi = {}, versions = [], vi = {};
    games.forEach(function (g, i) { gi[g.game_id] = i; });
    var rows = (props || []).map(function (p) {
      if (pi[p.player_id] == null) { pi[p.player_id] = players.length; players.push([p.player_id, p.player, p.position, p.team]); }
      if (mi[p.market_key] == null) { mi[p.market_key] = markets.length; markets.push(p.market_key); }
      var m = p.model, mk = p.market, f = p.focus, mv = p.movement;
      var vk = m.model_version + '|' + m.market_tier + '|' + m.outcome_tier;
      if (vi[vk] == null) { vi[vk] = versions.length; versions.push({ v: m.model_version, tier: m.market_tier, outcome_tier: m.outcome_tier }); }
      return [gi[p.game_id], pi[p.player_id], p.is_home ? 1 : 0, mi[p.market_key], vi[vk], m.mean, m.median, m.p10, m.p90, m.ref_line, m.over_prob, m.under_prob, m.fair_over, m.fair_under,
        p.confidence ? p.confidence.score : null, p.data_quality ? p.data_quality.score : null, p.decision ? p.decision.decision : null,
        mk ? { line: mk.consensus_line, over: mk.consensus_over_prob, books: mk.book_count, best_over: mk.best_over_price, best_under: mk.best_under_price, updated_at: mk.updated_at } : null,
        f ? { side: f.side, line: f.line, book: f.sportsbook, am: f.american, model: f.model_prob, market: f.market_prob, edge: f.edge_vs_market != null ? f.edge_vs_market : f.edge_vs_implied,
          fair: f.fair_american, ev: f.ev, cev: f.conservative_ev } : null,
        mv && mv.available ? { line: mv.line_move, prob: mv.over_prob_move, since_min: mv.minutes_since_move } : null];
    });
    var out = {}; Object.keys(meta).forEach(function (k) { out[k] = meta[k]; });
    out.players = players; out.markets = markets; out.models = versions; out.cols = BOARD_COLS; out.n_props = rows.length; out.rows = rows;
    return out;
  }
  function expandBoard(b) {
    if (!b || !b.cols || !b.rows || !b.rows.length || !Array.isArray(b.rows[0])) return b;
    var c = {}; b.cols.forEach(function (k, i) { c[k] = i; });
    var out = {}; Object.keys(b).forEach(function (k) { if (k !== 'rows') out[k] = b[k]; });
    out.rows = b.rows.map(function (a) {
      var g = b.games[a[c.g]] || {}, pl = b.players[a[c.p]] || [], home = a[c.h] === 1, mver = b.models[a[c.mv]] || {}, conf = a[c.conf], mkt = a[c.mkt];
      var market = b.markets[a[c.mk]];
      return { id: g.game_id + '|' + pl[0] + '|' + market, game_id: g.game_id, kickoff: g.kickoff, matchup: (g.away || g.away_id) + ' @ ' + (g.home || g.home_id),
        team: home ? g.home_id : g.away_id, opp: home ? g.away_id : g.home_id, home: home, player_id: pl[0], player: pl[1], pos: pl[2], market: market, label: marketLabel(market),
        mean: a[c.mean], median: a[c.median], p10: a[c.p10], p90: a[c.p90], ref_line: a[c.ref_line], over: a[c.over], under: a[c.under], fair_over: a[c.fair_over], fair_under: a[c.fair_under],
        model_version: mver.v, tier: mver.tier, outcome_tier: mver.outcome_tier, mkt: mkt, focus: a[c.focus], move: a[c.move],
        conf: conf, conf_grade: conf == null ? 'UNKNOWN' : (conf >= 70 ? 'HIGH' : conf >= 50 ? 'MEDIUM' : 'LOW'), dq: a[c.dq], decision: a[c.decision],
        updated_at: (mkt && mkt.updated_at) || b.as_of || b.generated_at };
    });
    return out;
  }

  return {
    VERSION: VERSION, MARKETS: MARKETS, marketLabel: marketLabel, EDGE_BUCKETS: EDGE_BUCKETS, GATES: GATES,
    dist: { poissonPmf: poissonPmf, negBinomPmf: negBinomPmf, binomPmf: binomPmf, countFromMoments: countFromMoments, countWithUncertainty: countWithUncertainty,
      continuousFromRatio: continuousFromRatio, ratioCdfAt: ratioCdfAt, compressCdf: compressCdf, bernoulli: bernoulli, recalibrate: recalibrate, mixPmf: mixPmf, meanNodes: meanNodes,
      cdf: cdf, probs: probs, quantile: quantile, moments: moments, summary: summary, valid: validDist, logGamma: logGamma },
    sideProbs: sideProbs, noVig: noVig, pairQuotes: pairQuotes, evaluateQuote: evaluateQuote, kellyGrowth: kellyGrowth,
    marketView: marketView, bookMainLine: bookMainLine, latestByBook: latestByBook, quoteKey: qkey, movement: movement, ladder: ladder, playableTo: playableTo, playablePrice: playablePrice,
    confidence: confidence, sampleCertainty: sampleCertainty, depthCertainty: depthCertainty, dispersionCertainty: dispersionCertainty,
    dataQuality: dataQuality, freshness: freshness, decide: decide, edgeBucket: edgeBucket, confidenceBucket: confidenceBucket, priceBucket: priceBucket,
    settle: settle, unitsFor: unitsFor, clv: clv, metrics: { pinball: pinball, pit: pit, calibrationBins: calibrationBins },
    explain: explain, reprice: reprice, fairFromProb: fairFromProb,
    wire: { packCard: packCard, expandCard: expandCard, packMarket: packMarket, packBoard: packBoard, expandBoard: expandBoard, roundDist: roundDist, driverText: driverText, BOARD_COLS: BOARD_COLS, CONF_KEYS: CONF_KEYS, DQ_KEYS: DQ_KEYS },
    util: { num: num, median: median, mean: mean, sd: sd, isHalf: isHalf, isWhole: isWhole, r: r }
  };
}));
/*__EDPROPSLIB_END__*/

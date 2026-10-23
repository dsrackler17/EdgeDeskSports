/* ===========================================================================
   EDGEDESK VALIDATION LAB — does a forecast carry information the market did
   not already have? docs/market-intelligence/VALIDATION.md

   lib/research_core.js scores one forecast (Brier, log loss, Wilson);
   lib/edgedesk_validation.js labels a sample (sample states, modes). This
   file adds the comparisons those two leave out, each with an interval that
   respects how the rows were generated:

     clusterBootstrap   a percentile interval that resamples whole CLUSTERS
                        (a week of a football season, a calendar day of an
                        NHL slate), never single games: games in one week
                        share a slate, a data refresh and a market regime,
                        so an iid interval is too narrow
     pairedDifference   model minus benchmark on the SAME games (absolute
                        error, Brier, log loss), never two unpaired means
     informationTest    regresses (actual - market) on (model - market).
                        Slope 0: the model's disagreement told us nothing
                        the market did not. Slope 1: follow the model fully.
                        Cluster-robust standard error and a cluster bootstrap
     calibrationFit     logistic recalibration y ~ a + b·logit(p): slope b
                        (1 = calibrated, < 1 = overconfident), intercept and
                        calibration-in-the-large, same parametrisation as
                        lib/edgedesk_ev.js logisticSlope (pinned by a test)
     reliability        probability buckets with Wilson intervals
     adjust             Benjamini–Hochberg and Holm, for a family of tests
     marketAt           the point-in-time benchmark: the latest quote seen at
                        or before a time, never after it, never after the
                        start, with its age; the rule is fixed before any
                        outcome is read (no "best book" chosen afterwards)
     folds              chronological walk-forward folds with an embargo,
                        and a check that no training outcome was known
                        before its test window opened
     judge              a pre-registered hypothesis against its own
                        acceptance rule. REJECTED stays in the log.

   WHAT THIS FILE NEVER DOES
     - it never returns a default for a missing input (null, with why);
     - it never states a verdict below its own minimum sample;
     - it never turns an interval that includes zero into a finding;
     - it never selects a benchmark after seeing an outcome.

   Browser: window.EDValidationLab (load lib/research_core.js first).
   Node: require('./edgedesk_validation_lab.js'). ES5, deterministic: every
   bootstrap is seeded and the seed is returned with the result.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDValidationLab = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_validation_lab_v1';
  var Rc = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) { try { Rc = require('./research_core.js'); } catch (e) { Rc = null; } }
  function R() {
    var c = Rc || (root && root.EDResearchCore) || (root && root.EDResearch && typeof root.EDResearch.wilson === 'function' ? root.EDResearch : null);
    if (!c || typeof c.wilson !== 'function') throw new Error('EDValidationLab needs lib/research_core.js loaded first');
    return c;
  }

  /* The minimums below which a test reports INSUFFICIENT_EVIDENCE instead of
     a verdict. Fixed here, before any data is read. */
  var MIN = { n: 30, clusters: 4, few_clusters: 10, calibration_n: 50, bucket_n: 10 };
  var DEFAULTS = { draws: 2000, seed: 20261023, alpha: 0.05 };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function opt(o, k) { return o && o[k] != null ? o[k] : DEFAULTS[k]; }

  /* mulberry32: a small seeded generator, so an interval is reproducible */
  function prng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
  function normalCdf(x) {
    if (!isNum(x)) return null;
    var z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + (x < 0 ? -y : y));
  }
  function pTwoSided(z) { return isNum(z) ? 2 * (1 - normalCdf(Math.abs(z))) : null; }

  /* --------------------------------------------------------- clustering */
  function clusterOf(o) {
    var f = o && o.cluster;
    if (typeof f === 'function') return f;
    if (typeof f === 'string') return function (row) { return row[f]; };
    return function (row) { return row.cluster; };
  }
  function groupBy(rows, key) {
    var map = {}, order = [];
    rows.forEach(function (row) {
      var k = key(row);
      k = k == null ? '__none__' : String(k);
      if (!map[k]) { map[k] = []; order.push(k); }
      map[k].push(row);
    });
    return { map: map, keys: order };
  }

  /* ---------------------------------------------------- CLUSTER BOOTSTRAP
     stat(rows) -> number|null. Resamples whole clusters with replacement,
     draws times, and returns the percentile interval. Below MIN.clusters the
     estimate is returned with no interval and the reason. */
  function clusterBootstrap(rows, stat, o) {
    o = o || {};
    rows = rows || [];
    var est = rows.length ? stat(rows) : null;
    var g = groupBy(rows, clusterOf(o)), K = g.keys.length;
    var out = { est: isNum(est) ? est : null, ci: [null, null], n: rows.length, clusters: K,
      draws: 0, seed: opt(o, 'seed'), alpha: opt(o, 'alpha'), method: 'cluster_bootstrap_percentile' };
    var minK = o.min_clusters != null ? o.min_clusters : MIN.clusters;
    if (!isNum(est)) { out.why = 'the statistic is undefined on these rows'; return out; }
    if (K < minK) { out.why = 'fewer than ' + minK + ' clusters (' + K + '): no interval'; return out; }
    var rnd = prng(out.seed), D = opt(o, 'draws'), vals = [], i, j;
    for (i = 0; i < D; i++) {
      var sample = [];
      for (j = 0; j < K; j++) {
        var pick = g.map[g.keys[Math.floor(rnd() * K)]];
        for (var k = 0; k < pick.length; k++) sample.push(pick[k]);
      }
      var v = stat(sample);
      if (isNum(v)) vals.push(v);
    }
    out.draws = vals.length;
    if (vals.length < D * 0.9) { out.why = 'the statistic was undefined on more than 10% of resamples'; return out; }
    var a = out.alpha;
    out.ci = [R().quantile(vals, a / 2), R().quantile(vals, 1 - a / 2)];
    out.se = R().sd(vals);
    /* With few clusters a percentile interval is approximate, so the
       estimate with each cluster left out is returned beside it: a sign that
       flips when one week is dropped is not a finding, whatever the interval. */
    out.few_clusters = K < MIN.few_clusters;
    var jk = [];
    g.keys.forEach(function (drop) {
      var rest = [];
      g.keys.forEach(function (kk) { if (kk !== drop) Array.prototype.push.apply(rest, g.map[kk]); });
      var v = rest.length ? stat(rest) : null;
      if (isNum(v)) jk.push(v);
    });
    out.leave_one_out = jk.length ? { min: Math.min.apply(null, jk), max: Math.max.apply(null, jk),
      sign_stable: jk.every(function (v) { return v > 0; }) || jk.every(function (v) { return v < 0; }) } : null;
    return out;
  }
  function excludesZero(b) { return !!(b && isNum(b.ci[0]) && isNum(b.ci[1]) && (b.ci[0] > 0 || b.ci[1] < 0)); }
  function rounded(b, k) {
    if (!b) return b;
    var o = {}, key;
    for (key in b) if (Object.prototype.hasOwnProperty.call(b, key)) o[key] = b[key];
    o.est = r(b.est, k); o.ci = [r(b.ci[0], k), r(b.ci[1], k)];
    if (b.se != null) o.se = r(b.se, k);
    if (b.leave_one_out) o.leave_one_out = { min: r(b.leave_one_out.min, k), max: r(b.leave_one_out.max, k), sign_stable: b.leave_one_out.sign_stable };
    return o;
  }

  /* --------------------------------------------------- PAIRED DIFFERENCE
     a(row) - b(row) over the rows where both are numbers. Negative = a is
     lower (for a loss: a is better). */
  function pairedDifference(rows, a, b, o) {
    o = o || {};
    var cl = clusterOf(o);
    var pairs = [];
    (rows || []).forEach(function (row) {
      var x = num(a(row)), y = num(b(row));
      if (x != null && y != null) pairs.push({ d: x - y, a: x, b: y, cluster: cl(row) });
    });
    var boot = clusterBootstrap(pairs, function (s) { return mean(s.map(function (p) { return p.d; })); },
      { cluster: 'cluster', draws: o.draws, seed: o.seed, alpha: o.alpha, min_clusters: o.min_clusters });
    var aBetter = pairs.filter(function (p) { return p.d < 0; }).length, bBetter = pairs.filter(function (p) { return p.d > 0; }).length;
    var enough = pairs.length >= (o.min_n != null ? o.min_n : MIN.n) && boot.clusters >= (o.min_clusters != null ? o.min_clusters : MIN.clusters);
    var verdict = !enough ? 'INSUFFICIENT_EVIDENCE' : !excludesZero(boot) ? 'NO_DIFFERENCE_DEMONSTRATED' : (boot.ci[1] < 0 ? 'A_LOWER' : 'B_LOWER');
    return { n: pairs.length, clusters: boot.clusters, a_mean: mean(pairs.map(function (p) { return p.a; })), b_mean: mean(pairs.map(function (p) { return p.b; })),
      diff: boot, a_lower: aBetter, b_lower: bBetter, ties: pairs.length - aBetter - bBetter, verdict: verdict };
  }

  /* ---------------------------------------------------- INFORMATION TEST
     rows carry {model, market, actual} on ONE scale (a home margin, a total,
     a probability). x = model - market, y = actual - market, y = a + b·x.
     b > 0 with an interval clear of zero: the model's disagreement pointed
     at where the market was wrong. Cluster-robust (CR1) standard error and
     a cluster bootstrap interval; the verdict reads the bootstrap. */
  function ols(pts) {
    var n = pts.length;
    if (n < 3) return null;
    var mx = mean(pts.map(function (p) { return p.x; })), my = mean(pts.map(function (p) { return p.y; }));
    var sxx = 0, sxy = 0;
    pts.forEach(function (p) { sxx += (p.x - mx) * (p.x - mx); sxy += (p.x - mx) * (p.y - my); });
    if (!(sxx > 1e-12)) return null;
    var b = sxy / sxx;
    return { a: my - b * mx, b: b, mx: mx, sxx: sxx, n: n };
  }
  function clusterRobustSlopeSe(pts, fit) {
    /* V = (X'X)^-1 [sum_g (X_g'u_g)(X_g'u_g)'] (X'X)^-1, CR1 small-sample factor */
    var g = groupBy(pts, function (p) { return p.cluster; }), G = g.keys.length, n = pts.length;
    if (G < 2) return null;
    var s0 = 0, s1 = 0, s11 = 0;
    pts.forEach(function (p) { s0 += 1; s1 += p.x; s11 += p.x * p.x; });
    var det = s0 * s11 - s1 * s1;
    if (!(Math.abs(det) > 1e-12)) return null;
    var i00 = s11 / det, i01 = -s1 / det, i11 = s0 / det;
    var m00 = 0, m01 = 0, m11 = 0;
    g.keys.forEach(function (k) {
      var e0 = 0, e1 = 0;
      g.map[k].forEach(function (p) { var u = p.y - fit.a - fit.b * p.x; e0 += u; e1 += u * p.x; });
      m00 += e0 * e0; m01 += e0 * e1; m11 += e1 * e1;
    });
    /* row 2 of A·M·A with A = (X'X)^-1 */
    var a10 = i01, a11 = i11;
    var v11 = a10 * (m00 * a10 + m01 * a11) + a11 * (m01 * a10 + m11 * a11);
    var c = (G / (G - 1)) * ((n - 1) / (n - 2));
    return v11 > 0 ? Math.sqrt(v11 * c) : null;
  }
  function informationTest(rows, o) {
    o = o || {};
    var cl = clusterOf(o);
    var pts = [];
    (rows || []).forEach(function (row) {
      var m = num(row.model), k = num(row.market), y = num(row.actual);
      if (m != null && k != null && y != null) pts.push({ x: m - k, y: y - k, cluster: cl(row) });
    });
    var fit = ols(pts);
    var g = groupBy(pts, function (p) { return p.cluster; });
    var out = { n: pts.length, clusters: g.keys.length, slope: null, intercept: null, se_cluster: null, t: null, p_normal: null,
      slope_boot: null, mean_abs_disagreement: r(mean(pts.map(function (p) { return Math.abs(p.x); })), 3), verdict: 'INSUFFICIENT_EVIDENCE',
      reads: 'slope 0 = the disagreement carried no information beyond the market; 1 = the model was right in full; < 0 = it pointed the wrong way' };
    if (!fit) { out.why = 'no variation in the disagreement'; return out; }
    out.slope = fit.b; out.intercept = fit.a;
    out.se_cluster = clusterRobustSlopeSe(pts, fit);
    if (out.se_cluster) { out.t = fit.b / out.se_cluster; out.p_normal = pTwoSided(out.t); }
    out.slope_boot = clusterBootstrap(pts, function (s) { var f = ols(s); return f ? f.b : null; },
      { cluster: 'cluster', draws: o.draws, seed: o.seed, alpha: o.alpha, min_clusters: o.min_clusters });
    var enough = pts.length >= (o.min_n != null ? o.min_n : MIN.n) && out.clusters >= (o.min_clusters != null ? o.min_clusters : MIN.clusters);
    if (!enough) { out.why = 'below the minimum sample (' + MIN.n + ' games in ' + MIN.clusters + ' clusters)'; return out; }
    var ci = out.slope_boot.ci;
    if (!isNum(ci[0]) || !isNum(ci[1])) { out.verdict = 'INSUFFICIENT_EVIDENCE'; out.why = out.slope_boot.why; }
    else if (ci[0] > 0) out.verdict = 'INFORMATIVE';
    else if (ci[1] < 0) out.verdict = 'CONTRARY';
    else out.verdict = 'NOT_DEMONSTRATED';
    return out;
  }

  /* ---------------------------------------------------- CALIBRATION FIT
     pairs: [{p, y}] with y in {0,1}. Newton–Raphson on y ~ a + b·logit(p)
     (the joint fit), and calibration-in-the-large (citl: the intercept with
     b fixed at 1). Probabilities are clipped to [1e-6, 1-1e-6]. */
  function logit(p) { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(p / (1 - p)); }
  function sigm(z) { return 1 / (1 + Math.exp(-z)); }
  function logisticFit(xs) {
    var a = 0, b = 1, it, citl = 0, ok = false;
    for (it = 0; it < 50; it++) {
      var g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
      xs.forEach(function (x) { var z = logit(x.p), p = sigm(a + b * z), w = p * (1 - p); g0 += x.y - p; g1 += (x.y - p) * z; h00 += w; h01 += w * z; h11 += w * z * z; });
      var det = h00 * h11 - h01 * h01;
      if (Math.abs(det) < 1e-12) return null;
      var da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
      a += da; b += db;
      if (!isFinite(a) || !isFinite(b)) return null;
      if (Math.abs(da) + Math.abs(db) < 1e-9) { ok = true; break; }
    }
    for (it = 0; it < 50; it++) {
      var gg = 0, hh = 0;
      xs.forEach(function (x) { var p = sigm(citl + logit(x.p)); gg += x.y - p; hh += p * (1 - p); });
      if (hh < 1e-12) break;
      var d = gg / hh; citl += d;
      if (Math.abs(d) < 1e-10) break;
    }
    return ok ? { a: a, b: b, citl: citl } : null;
  }
  function calibrationFit(pairs, o) {
    o = o || {};
    var cl = clusterOf(o);
    var xs = [];
    (pairs || []).forEach(function (x) {
      var p = num(x.p);
      if (p != null && p >= 0 && p <= 1 && (x.y === 0 || x.y === 1)) xs.push({ p: p, y: x.y, cluster: cl(x) });
    });
    var out = { n: xs.length, mean_p: r(mean(xs.map(function (x) { return x.p; })), 4), observed: r(mean(xs.map(function (x) { return x.y; })), 4),
      brier: r(mean(xs.map(function (x) { return R().brier(x.p, x.y); })), 5), log_loss: r(mean(xs.map(function (x) { return R().logLoss(x.p, x.y); })), 5),
      slope: null, intercept: null, citl: null, slope_boot: null, verdict: 'INSUFFICIENT_EVIDENCE',
      reads: 'slope 1 = calibrated spread of probabilities; < 1 = overconfident (too far from 50%); > 1 = underconfident. citl > 0 = outcomes happened more often than forecast' };
    if (xs.length < (o.min_n != null ? o.min_n : MIN.calibration_n)) { out.why = 'below ' + MIN.calibration_n + ' graded forecasts'; return out; }
    var fit = logisticFit(xs);
    if (!fit) { out.why = 'the logistic fit did not converge (separable or degenerate sample)'; return out; }
    out.slope = r(fit.b, 4); out.intercept = r(fit.a, 4); out.citl = r(fit.citl, 4);
    out.slope_boot = rounded(clusterBootstrap(xs, function (s) { var f = logisticFit(s); return f ? f.b : null; },
      { cluster: 'cluster', draws: o.draws || 1000, seed: o.seed, alpha: o.alpha, min_clusters: o.min_clusters }), 4);
    var ci = out.slope_boot.ci;
    if (!isNum(ci[0])) { out.why = out.slope_boot.why || 'no interval'; return out; }
    out.verdict = ci[1] < 1 ? 'OVERCONFIDENT' : ci[0] > 1 ? 'UNDERCONFIDENT' : 'CONSISTENT_WITH_CALIBRATED';
    return out;
  }

  /* ----------------------------------------------------------- reliability */
  var PROB_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];
  function reliability(pairs, edges) {
    edges = edges || PROB_EDGES;
    var out = [];
    for (var i = 0; i + 1 < edges.length; i++) {
      var lo = edges[i], hi = edges[i + 1];
      var inB = (pairs || []).filter(function (x) { var p = num(x.p); return p != null && p >= lo && p < hi && (x.y === 0 || x.y === 1); });
      var k = inB.filter(function (x) { return x.y === 1; }).length;
      var w = inB.length ? R().wilson(k, inB.length) : null;
      out.push({ lo: r(lo, 2), hi: r(Math.min(hi, 1), 2), n: inB.length, mean_p: r(mean(inB.map(function (x) { return x.p; })), 4),
        observed: inB.length ? r(k / inB.length, 4) : null, ci: w ? [r(w.lo, 4), r(w.hi, 4)] : [null, null],
        thin: inB.length < MIN.bucket_n });
    }
    return out;
  }

  /* ------------------------------------------------- multiple comparisons
     p-values in, adjusted p-values out, in the same order. null stays null
     and is not counted in the family. */
  function adjust(pvalues, method) {
    var idx = [];
    (pvalues || []).forEach(function (p, i) { if (isNum(p) && p >= 0 && p <= 1) idx.push({ i: i, p: p }); });
    var m = idx.length, out = (pvalues || []).map(function () { return null; });
    if (!m) return out;
    idx.sort(function (x, y) { return x.p - y.p; });
    var k;
    if ((method || 'bh') === 'holm') {
      var run = 0;
      for (k = 0; k < m; k++) { run = Math.max(run, Math.min(1, (m - k) * idx[k].p)); out[idx[k].i] = run; }
    } else {
      var prev = 1;
      for (k = m - 1; k >= 0; k--) { prev = Math.min(prev, Math.min(1, idx[k].p * m / (k + 1))); out[idx[k].i] = prev; }
    }
    return out;
  }

  /* ---------------------------------------------- POINT-IN-TIME BENCHMARK
     The latest quote observed at or before `at`, and before `start` when it
     is given. A quote after either is never chosen, whatever it says.
     o.time: the field holding the observation time (default observed_at).
     o.max_age_minutes: older than this and the benchmark is STALE (null). */
  function marketAt(quotes, at, o) {
    o = o || {};
    var t = ms(at), st = ms(o.start), field = o.time || 'observed_at';
    if (t == null) return { quote: null, why: 'NO_TIME', rule: 'latest quote at or before the time' };
    var cut = st != null ? Math.min(t, st - 1) : t;
    var best = null, bt = null, after = 0;
    (quotes || []).forEach(function (q) {
      var qt = ms(q && q[field]);
      if (qt == null) return;
      if (qt > cut) { after++; return; }
      if (bt == null || qt > bt) { best = q; bt = qt; }
    });
    var rule = 'latest ' + field + ' at or before ' + iso(cut) + (st != null ? ' (and before the start)' : '');
    if (!best) return { quote: null, why: 'NONE_BEFORE', ignored_later: after, rule: rule };
    var age = (t - bt) / 60000;
    if (o.max_age_minutes != null && age > o.max_age_minutes) return { quote: null, why: 'STALE', age_minutes: r(age, 1), ignored_later: after, rule: rule };
    return { quote: best, observed_at: iso(bt), age_minutes: r(age, 1), ignored_later: after, rule: rule };
  }

  /* -------------------------------------------------- WALK-FORWARD FOLDS
     rows ordered by o.group (a season, a week index: comparable numbers).
     A fold tests one group, trained on every earlier group whose outcome was
     known (o.known_at) before the test group's first prediction (o.time),
     less o.embargo_hours. o.min_train_groups earlier groups are required. */
  function folds(rows, o) {
    o = o || {};
    var gk = typeof o.group === 'function' ? o.group : function (x) { return x[o.group || 'season']; };
    var tk = typeof o.time === 'function' ? o.time : function (x) { return ms(x[o.time || 'predicted_at']); };
    var kk = typeof o.known_at === 'function' ? o.known_at : function (x) { return ms(x[o.known_at || 'final_at']); };
    var emb = (num(o.embargo_hours) || 0) * 3600000, minG = o.min_train_groups == null ? 1 : o.min_train_groups;
    var groups = [];
    (rows || []).forEach(function (x) { var g = gk(x); if (g != null && groups.indexOf(g) < 0) groups.push(g); });
    groups.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    var out = [];
    groups.forEach(function (g, i) {
      if (i < minG) return;
      var test = rows.filter(function (x) { return gk(x) === g; });
      var opens = Math.min.apply(null, test.map(tk).filter(isNum));
      if (!isFinite(opens)) { out.push({ group: g, train: [], test: test, test_opens: null, skipped: 'no prediction time in the test group' }); return; }
      var train = rows.filter(function (x) { var k = kk(x); return groups.indexOf(gk(x)) < i && k != null && k <= opens - emb; });
      var excluded = rows.filter(function (x) { var k = kk(x); return groups.indexOf(gk(x)) < i && !(k != null && k <= opens - emb); }).length;
      out.push({ group: g, train: train, test: test, test_opens: iso(opens), train_known_by: train.length ? iso(Math.max.apply(null, train.map(kk))) : null,
        excluded_unknown_outcome: excluded });
    });
    return out;
  }
  function checkSeparation(fs, o) {
    o = o || {};
    var kk = typeof o.known_at === 'function' ? o.known_at : function (x) { return ms(x[o.known_at || 'final_at']); };
    var problems = [];
    (fs || []).forEach(function (f) {
      if (f.skipped) return;
      var opens = ms(f.test_opens);
      f.train.forEach(function (x) { var k = kk(x); if (k == null || opens == null || k > opens) problems.push({ group: f.group, row: x, why: 'a training outcome was not known before the test window opened' }); });
      f.test.forEach(function (x) { if (f.train.indexOf(x) >= 0) problems.push({ group: f.group, row: x, why: 'a row is in both train and test' }); });
    });
    return { ok: problems.length === 0, problems: problems };
  }

  /* ---------------------------------------------------------- HYPOTHESES
     A hypothesis is written before its test: statement, mechanism, metric,
     data, and an acceptance rule. judge() applies the rule to a result and
     never edits the hypothesis. A rejection is a result, kept in the log. */
  var STATUSES = ['PREREGISTERED', 'ACCEPTED', 'REJECTED', 'INSUFFICIENT_EVIDENCE', 'RETIRED'];
  var REQUIRED = ['id', 'statement', 'mechanism', 'metric', 'data', 'acceptance', 'registered_at'];
  function checkHypothesis(h) {
    var missing = REQUIRED.filter(function (k) { return !h || h[k] == null || h[k] === ''; });
    var problems = missing.map(function (k) { return 'missing ' + k; });
    if (h && h.acceptance && ['verdict_in', 'ci_lower_above', 'ci_upper_below'].indexOf(h.acceptance.rule) < 0) problems.push('unknown acceptance rule ' + h.acceptance.rule);
    if (h && h.status && STATUSES.indexOf(h.status) < 0) problems.push('unknown status ' + h.status);
    return { ok: problems.length === 0, problems: problems };
  }
  /* result: {verdict, ci:[lo,hi], n, clusters}. acceptance:
       {rule:'verdict_in', values:[...]}  accept when result.verdict is listed
       {rule:'ci_lower_above', value:x}   accept when ci[0] > x
       {rule:'ci_upper_below', value:x}   accept when ci[1] < x
     A result below its own minimum is INSUFFICIENT_EVIDENCE, never REJECTED,
     and so is one that meets its rule only with every cluster in. */
  function judge(h, result) {
    var c = checkHypothesis(h);
    if (!c.ok) return { status: null, why: c.problems.join('; ') };
    if (!result || result.verdict === 'INSUFFICIENT_EVIDENCE') return { status: 'INSUFFICIENT_EVIDENCE', why: (result && result.why) || 'below the minimum sample' };
    var A = h.acceptance, ci = result.ci || [null, null], pass;
    if (A.rule === 'verdict_in') pass = (A.values || []).indexOf(result.verdict) >= 0;
    else if (A.rule === 'ci_lower_above') { if (!isNum(ci[0])) return { status: 'INSUFFICIENT_EVIDENCE', why: 'no interval' }; pass = ci[0] > A.value; }
    else { if (!isNum(ci[1])) return { status: 'INSUFFICIENT_EVIDENCE', why: 'no interval' }; pass = ci[1] < A.value; }
    if (pass && !robust(A, result)) return { status: 'INSUFFICIENT_EVIDENCE', why: 'acceptance rule ' + A.rule + ' met, but not with any one cluster left out (leave-one-out ' + r(result.leave_one_out.min, 3) + ' to ' + r(result.leave_one_out.max, 3) + ')' };
    return { status: pass ? 'ACCEPTED' : 'REJECTED', why: 'acceptance rule ' + A.rule + ' ' + (pass ? 'met' : 'not met') };
  }
  /* An acceptance must survive dropping any one cluster: every leave-one-out
     estimate stays on the accepted side of the rule's threshold. Verdicts with
     no direction (calibration) are not re-checked here. */
  function robust(A, result) {
    var lo = result && result.leave_one_out;
    if (!lo || !isNum(lo.min) || !isNum(lo.max)) return true;
    if (A.rule === 'ci_upper_below') return lo.max < A.value;
    if (A.rule === 'ci_lower_above') return lo.min > A.value;
    if (['INFORMATIVE', 'ABOVE_ZERO', 'B_LOWER'].indexOf(result.verdict) >= 0) return lo.min > 0;
    if (['CONTRARY', 'BELOW_ZERO', 'A_LOWER'].indexOf(result.verdict) >= 0) return lo.max < 0;
    return true;
  }

  return {
    VERSION: VERSION, MIN: MIN, DEFAULTS: DEFAULTS, PROB_EDGES: PROB_EDGES, STATUSES: STATUSES,
    prng: prng, normalCdf: normalCdf, pTwoSided: pTwoSided, round: r,
    clusterBootstrap: clusterBootstrap, excludesZero: excludesZero, rounded: rounded,
    pairedDifference: pairedDifference, informationTest: informationTest,
    logisticFit: logisticFit, calibrationFit: calibrationFit, reliability: reliability,
    adjust: adjust, marketAt: marketAt, folds: folds, checkSeparation: checkSeparation,
    checkHypothesis: checkHypothesis, judge: judge
  };
}));

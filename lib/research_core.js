/* ===========================================================================
   EdgeDesk research core — the canonical arithmetic of the research terminal.

   One file, no dependencies, loaded by the browser (window.EDResearch) and by
   Node (require('lib/research_core.js')). Every surface that states a spread
   gap, a CLV, a no-vig probability, a break-even, an edge bucket, an interval
   or a model-agreement figure should get it from here, so the same number is
   never computed two different ways on two pages.

   THE LINE CONVENTION (canonical, never flipped silently)
   -------------------------------------------------------
   * A spread is stated for the HOME team. Negative = home favoured.
     HOME -7 means the home side must win by more than 7.
   * A margin is HOME score minus AWAY score.
   * A model's projected home margin is the negative of its home spread:
     fair spread HOME -9.4 == projected home margin +9.4.
   * The AWAY side's line is the negative of the home line: home -3 is away +3.
   * Comparing a model spread with a market spread is only meaningful because
     both are home-stated. A LOWER number is further onto the home team.

   WHAT THIS FILE NEVER DOES
   -------------------------
   * It never returns a default in place of a missing input. Every function
     returns null when an input it needs is missing or non-finite.
   * It never turns a spread difference into a probability. A cover
     probability has to be supplied by a model that states one.
   * It never uses a closing line to decide anything that was frozen before
     the close (the side a model was on at submission, its edge bucket).
   =========================================================================== */
/*__EDRCORE_START__*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDResearch = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var R = { version: 'research_core/1' };
  var EPS = 1e-9;

  /* ------------------------------------------------------------- numbers */
  function num(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function round(v, d) {
    if (v == null || !isFinite(v)) return null;
    var f = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * f) / f;
  }
  R.num = num;
  R.round = round;

  /* ========================================================= CONVENTIONS */
  R.SIDES = ['home', 'away'];

  function normSide(side) {
    var s = String(side == null ? '' : side).toLowerCase();
    return (s === 'home' || s === 'away') ? s : null;
  }
  R.normSide = normSide;

  /* The line for one side, from the home-stated line. */
  R.sideLine = function (homeLine, side) {
    var l = num(homeLine), s = normSide(side);
    if (l == null || !s) return null;
    return s === 'home' ? l : (l === 0 ? 0 : -l);
  };
  /* The home-stated line, from one side's line. Symmetric by construction. */
  R.homeLineFromSide = function (sideLine, side) {
    return R.sideLine(sideLine, side);
  };
  /* A home spread as a projected home margin, and back. */
  R.marginFromSpread = function (homeSpread) {
    var s = num(homeSpread);
    return s == null ? null : (s === 0 ? 0 : -s);
  };
  R.spreadFromMargin = function (homeMargin) {
    var m = num(homeMargin);
    return m == null ? null : (m === 0 ? 0 : -m);
  };
  /* THE ENGINE CONVENTION IS THE OPPOSITE SIGN. football/cfb_p4/engine.js
     and football/engine.js publish `fair_spread` as a projected HOME MARGIN
     (+ = home favoured; cfb_p4/engine.js: "home perspective, + = home
     favoured by"). Every engine number enters the research layer through
     this one named function, so no caller negates it by hand. */
  R.homeLineFromEngineFairSpread = function (engineFairSpread) {
    return R.spreadFromMargin(engineFairSpread);
  };

  /* Which side a model's number is on relative to a market line, both home
     stated. null when they are equal (the model leans neither way) or when
     either is missing. This is the ONLY way a side is ever derived from two
     numbers here; the sign of a spread alone never names a side. */
  R.sideVsLine = function (modelSpread, line) {
    var m = num(modelSpread), l = num(line);
    if (m == null || l == null) return null;
    if (Math.abs(m - l) < EPS) return null;
    return m < l ? 'home' : 'away';
  };

  /* The model-vs-market gap in points: absolute, and signed toward home
     (positive = the model is further onto HOME than the market). */
  R.spreadGap = function (modelSpread, line) {
    var m = num(modelSpread), l = num(line);
    if (m == null || l == null) return null;
    var toward = l - m;
    return {
      points: round(Math.abs(toward), 4),
      toward_home: round(toward, 4),
      side: Math.abs(toward) < EPS ? null : (toward > 0 ? 'home' : 'away')
    };
  };

  /* ============================================================== CLV
     Closing-line value in points, turned onto the side taken.
       HOME: posted -3, close -5  -> +2   (home now costs 5, you had 3)
       AWAY: home posted -3, home close -1 -> away +3 vs +1 -> +2
     Positive always means the number taken was better than the reference. */
  R.clvPoints = function (side, postedHomeLine, referenceHomeLine) {
    var s = normSide(side), p = num(postedHomeLine), r = num(referenceHomeLine);
    if (!s || p == null || r == null) return null;
    var v = s === 'home' ? (p - r) : (r - p);
    return round(v, 4) === 0 ? 0 : round(v, 4);
  };

  /* CLV in price terms at the SAME line: the no-vig probability the close
     gives the side, minus the break-even of the price taken. Only defined
     when the line did not change, because two prices at two different
     numbers are not comparable without a push/margin distribution. */
  R.clvPrice = function (takenAmerican, closeSideAmerican, closeOtherAmerican, sameLine) {
    if (!sameLine) return null;
    var be = R.impliedProb(takenAmerican);
    var nv = R.noVigTwoWay(closeSideAmerican, closeOtherAmerican);
    if (be == null || !nv) return null;
    return round(nv.a - be, 6);
  };

  /* Market movement relative to a model, from the line at submission to a
     later line (current, or the close). Side is fixed AT SUBMISSION: the side
     the model's number was on against the line it was posted against. */
  R.movementVsModel = function (modelSpread, postedLine, laterLine) {
    var side = R.sideVsLine(modelSpread, postedLine);
    var m = num(modelSpread), p = num(postedLine), l = num(laterLine);
    if (m == null || p == null || l == null) return null;
    var moved = round(l - p, 4);
    var toward = side ? R.clvPoints(side, p, l) : null;
    var gapThen = Math.abs(m - p), gapNow = Math.abs(m - l);
    var status = 'flat';
    if (Math.abs(moved) >= EPS) {
      if (!side) status = 'model_on_line';
      else status = toward > 0 ? 'toward_model' : 'away_from_model';
    }
    return {
      side_at_submission: side,
      moved_points: moved === 0 ? 0 : moved,
      toward_model_points: toward,
      gap_at_submission: round(gapThen, 4),
      gap_now: round(gapNow, 4),
      passed_model: !!(side && ((p - m) * (l - m) < -EPS)),
      status: status
    };
  };

  /* ======================================================== KEY NUMBERS
     Final-margin values that occur far more often than their neighbours in
     football. The lists are conventional labels, not value estimates: this
     file states that a move crossed 3, never what crossing 3 is worth. */
  R.KEY_NUMBERS = {
    NFL: { primary: [3, 7], secondary: [10, 6, 4, 14] },
    CFB: { primary: [3, 7], secondary: [10, 14, 17] }
  };
  function sportKey(sport) {
    var s = String(sport || '').toUpperCase();
    if (s === 'NCAAF' || s === 'CFP' || s === 'CFB_P4' || s === 'FBS') return 'CFB';
    return R.KEY_NUMBERS[s] ? s : null;
  }
  /* Every key number a move from line a to line b touched. Home-stated
     lines; a key number k is checked on both sides (+k and -k).
       crossed: the move went through it (-2.5 -> -3.5 crosses 3)
       onto:    the move landed on it       (-2.5 -> -3)
       off:     the move left it            (-3 -> -3.5) */
  R.keyNumberCrossings = function (fromLine, toLine, sport) {
    var a = num(fromLine), b = num(toLine), sk = sportKey(sport);
    if (a == null || b == null || !sk) return null;
    var set = R.KEY_NUMBERS[sk], out = [];
    function tier(k) { return set.primary.indexOf(k) >= 0 ? 'primary' : 'secondary'; }
    set.primary.concat(set.secondary).forEach(function (k) {
      [k, -k].forEach(function (s) {
        var kind = null;
        if ((a - s) * (b - s) < -EPS) kind = 'crossed';
        else if (Math.abs(b - s) < EPS && Math.abs(a - s) >= EPS) kind = 'onto';
        else if (Math.abs(a - s) < EPS && Math.abs(b - s) >= EPS) kind = 'off';
        if (kind) out.push({ key: k, at: s, kind: kind, tier: tier(k) });
      });
    });
    out.sort(function (x, y) { return Math.abs(x.at) - Math.abs(y.at); });
    return out;
  };

  /* =========================================================== ODDS MATH */
  R.americanToDecimal = function (american) {
    var a = num(american);
    if (a == null || Math.abs(a) < 100) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / (-a);
  };
  /* The implied probability of a price is also its break-even win rate. */
  R.impliedProb = function (american) {
    var d = R.americanToDecimal(american);
    return d == null ? null : 1 / d;
  };
  R.breakEven = R.impliedProb;
  R.decimalToAmerican = function (dec) {
    var d = num(dec);
    if (d == null || d <= 1) return null;
    return d >= 2 ? 100 * (d - 1) : -100 / (d - 1);
  };
  R.probToAmerican = function (p) {
    p = num(p);
    if (p == null || p <= 0 || p >= 1) return null;
    return p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
  };
  /* Two-way no-vig by proportional (multiplicative) normalisation. Returns
     both fair probabilities and the overround; null unless both prices are
     real. */
  R.noVigTwoWay = function (americanA, americanB) {
    var pa = R.impliedProb(americanA), pb = R.impliedProb(americanB);
    if (pa == null || pb == null) return null;
    var s = pa + pb;
    return { a: pa / s, b: pb / s, overround: s - 1 };
  };
  /* Expected return per unit staked at an American price, given an explicit
     win probability and (for spreads on whole numbers) an explicit push
     probability. Never called with a probability derived from a spread gap. */
  R.expectedRoi = function (winProb, american, pushProb) {
    var p = num(winProb), d = R.americanToDecimal(american);
    var q = pushProb == null ? 0 : num(pushProb);
    if (p == null || d == null || q == null) return null;
    if (p < 0 || p > 1 || q < 0 || p + q > 1 + EPS) return null;
    var lose = Math.max(0, 1 - p - q);
    return p * (d - 1) - lose;
  };
  /* Everything a price-aware panel shows, in one object. `prob` must be an
     explicit model probability for THIS wager at THIS line; when it is not
     available, every model-dependent field is null and `reason` says why. */
  R.priceAssessment = function (american, prob, pushProb) {
    var be = R.breakEven(american);
    var out = {
      american: num(american), decimal: R.americanToDecimal(american),
      implied_prob: be, break_even: be,
      model_prob: null, prob_edge: null, expected_roi: null, reason: null
    };
    if (be == null) { out.reason = 'no valid price'; return out; }
    var p = num(prob);
    if (p == null || p < 0 || p > 1) { out.reason = 'no explicit model probability for this wager'; return out; }
    out.model_prob = p;
    out.prob_edge = p - be;
    out.expected_roi = R.expectedRoi(p, american, pushProb);
    return out;
  };

  /* ============================================================ STATISTICS */
  function finite(arr) {
    var out = [];
    (arr || []).forEach(function (v) { var n = num(v); if (n != null) out.push(n); });
    return out;
  }
  R.finite = finite;
  R.mean = function (arr) {
    var a = finite(arr);
    if (!a.length) return null;
    return a.reduce(function (s, v) { return s + v; }, 0) / a.length;
  };
  R.quantile = function (arr, q) {
    var a = finite(arr).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  };
  R.median = function (arr) { return R.quantile(arr, 0.5); };
  /* Sample standard deviation (n-1). null below two values. */
  R.sd = function (arr) {
    var a = finite(arr);
    if (a.length < 2) return null;
    var m = R.mean(a);
    var ss = a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0);
    return Math.sqrt(ss / (a.length - 1));
  };
  R.rmse = function (arr) {
    var a = finite(arr);
    if (!a.length) return null;
    return Math.sqrt(a.reduce(function (s, v) { return s + v * v; }, 0) / a.length);
  };
  /* Median absolute deviation about the median, scaled by 1.4826 so it
     estimates a normal standard deviation. Robust to a few blowouts. */
  R.madScale = function (arr) {
    var a = finite(arr);
    if (a.length < 2) return null;
    var med = R.median(a);
    return 1.4826 * R.median(a.map(function (v) { return Math.abs(v - med); }));
  };

  /* Wilson score interval for a proportion k/n. The honest interval for small
     samples: 10-8 is 55.6% with a 95% interval of roughly 34%-75%. */
  R.wilson = function (k, n, z) {
    k = num(k); n = num(n); z = z == null ? 1.96 : z;
    if (k == null || n == null || n <= 0 || k < 0 || k > n) return null;
    var p = k / n, z2 = z * z;
    var den = 1 + z2 / n;
    var centre = (p + z2 / (2 * n)) / den;
    var half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
    return { p: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n: n, z: z };
  };

  /* Two-sided 95% Student-t critical values; beyond 30 df the normal. */
  var T95 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  R.tCritical95 = function (df) {
    if (!(df >= 1)) return null;
    return df <= 30 ? T95[Math.floor(df)] : 1.96;
  };
  /* A 95% interval on a mean. null below two observations: one number has no
     spread to report and pretending otherwise is false precision. */
  R.meanInterval = function (arr) {
    var a = finite(arr);
    if (a.length < 2) return null;
    var m = R.mean(a), s = R.sd(a), t = R.tCritical95(a.length - 1);
    var half = t * s / Math.sqrt(a.length);
    return { mean: m, lo: m - half, hi: m + half, n: a.length, sd: s };
  };

  /* Pearson correlation on paired finite values. */
  R.correlation = function (xs, ys) {
    if (!xs || !ys || xs.length !== ys.length) return null;
    var px = [], py = [];
    for (var i = 0; i < xs.length; i++) {
      var x = num(xs[i]), y = num(ys[i]);
      if (x != null && y != null) { px.push(x); py.push(y); }
    }
    if (px.length < 3) return null;
    var mx = R.mean(px), my = R.mean(py), sxy = 0, sxx = 0, syy = 0;
    for (var j = 0; j < px.length; j++) {
      sxy += (px[j] - mx) * (py[j] - my);
      sxx += (px[j] - mx) * (px[j] - mx);
      syy += (py[j] - my) * (py[j] - my);
    }
    if (sxx < EPS || syy < EPS) return null;
    return sxy / Math.sqrt(sxx * syy);
  };

  /* ============================================================ SCORING */
  R.brier = function (prob, outcome) {
    var p = num(prob);
    if (p == null || p < 0 || p > 1 || (outcome !== 0 && outcome !== 1)) return null;
    return (p - outcome) * (p - outcome);
  };
  R.logLoss = function (prob, outcome) {
    var p = num(prob);
    if (p == null || p < 0 || p > 1 || (outcome !== 0 && outcome !== 1)) return null;
    var e = 1e-6;
    p = Math.min(1 - e, Math.max(e, p));
    return -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
  };
  /* Brier skill against a benchmark, computed ONLY on games where both have a
     probability. pairs: [{model, market, outcome}]. A skill score quoted
     against a benchmark measured on different games is not a skill score. */
  R.brierSkill = function (pairs) {
    var ms = 0, bs = 0, n = 0;
    (pairs || []).forEach(function (r) {
      var a = R.brier(r && r.model, r && r.outcome), b = R.brier(r && r.market, r && r.outcome);
      if (a == null || b == null) return;
      ms += a; bs += b; n++;
    });
    if (!n) return { n: 0, model_brier: null, market_brier: null, skill: null };
    var mb = ms / n, kb = bs / n;
    return { n: n, model_brier: mb, market_brier: kb, skill: kb > EPS ? 1 - mb / kb : null };
  };

  /* ============================================================ BUCKETS */
  R.EDGE_BUCKETS = [
    { key: '0-2', label: '0-2 pts', lo: 0, hi: 2 },
    { key: '2-4', label: '2-4 pts', lo: 2, hi: 4 },
    { key: '4-6', label: '4-6 pts', lo: 4, hi: 6 },
    { key: '6+', label: '6+ pts', lo: 6, hi: Infinity }
  ];
  R.EDGE_THRESHOLDS = [2, 3, 4, 5, 6];
  /* Lower bound inclusive, upper exclusive: exactly 2.0 is in 2-4. */
  R.edgeBucketKey = function (points) {
    var p = num(points);
    if (p == null || p < 0) return null;
    for (var i = 0; i < R.EDGE_BUCKETS.length; i++) {
      var b = R.EDGE_BUCKETS[i];
      if (p >= b.lo - EPS && p < b.hi - EPS) return b.key;
    }
    return null;
  };
  R.NORMALIZED_BUCKETS = [
    { key: '<0.25', label: 'under 0.25σ', lo: 0, hi: 0.25 },
    { key: '0.25-0.5', label: '0.25-0.5σ', lo: 0.25, hi: 0.5 },
    { key: '0.5-0.75', label: '0.5-0.75σ', lo: 0.5, hi: 0.75 },
    { key: '0.75+', label: '0.75σ+', lo: 0.75, hi: Infinity }
  ];
  R.normalizedBucketKey = function (z) {
    var p = num(z);
    if (p == null || p < 0) return null;
    for (var i = 0; i < R.NORMALIZED_BUCKETS.length; i++) {
      var b = R.NORMALIZED_BUCKETS[i];
      if (p >= b.lo - EPS && p < b.hi - EPS) return b.key;
    }
    return null;
  };
  R.LEAD_BUCKETS = [
    { key: '72h+', label: '72h+', lo: 72, hi: Infinity },
    { key: '24-72h', label: '24-72h', lo: 24, hi: 72 },
    { key: '6-24h', label: '6-24h', lo: 6, hi: 24 },
    { key: '1-6h', label: '1-6h', lo: 1, hi: 6 },
    { key: '<1h', label: 'under 1h', lo: 0, hi: 1 }
  ];
  R.leadHours = function (submittedAt, kickoffAt) {
    var s = new Date(submittedAt).getTime(), k = new Date(kickoffAt).getTime();
    if (!submittedAt || !kickoffAt || !isFinite(s) || !isFinite(k)) return null;
    return (k - s) / 3600000;
  };
  /* A submission at or after kickoff has no lead-time bucket: it is not a
     pregame forecast and is reported separately, never folded into <1h. */
  R.leadBucketKey = function (submittedAt, kickoffAt) {
    var h = R.leadHours(submittedAt, kickoffAt);
    if (h == null) return null;
    if (h <= 0) return 'after_kickoff';
    for (var i = 0; i < R.LEAD_BUCKETS.length; i++) {
      var b = R.LEAD_BUCKETS[i];
      if (h >= b.lo && h < b.hi) return b.key;
    }
    return null;
  };

  /* ============================================== UNCERTAINTY / NORMALISED
     Expected model error from the model's OWN finished forecasts, walk
     forward: only residuals from games that were final BEFORE `asOf` count.
     residual = projected home margin - actual home margin.
     Methods, all reported so none is presented as the one truth:
       rmse — root mean square residual (includes any bias; the default,
              because a biased model's error about the line is larger)
       sd   — residual standard deviation (bias removed)
       mad  — 1.4826 x median absolute deviation (robust to blowouts)
     Below `minN` residuals the answer is null with a reason. */
  R.SCALE_METHODS = ['rmse', 'sd', 'mad'];
  R.DEFAULT_SCALE_MIN_N = 12;
  R.errorScale = function (history, asOf, opts) {
    opts = opts || {};
    var method = opts.method || 'rmse';
    var minN = opts.minN == null ? R.DEFAULT_SCALE_MIN_N : opts.minN;
    var cutoff = asOf == null ? null : new Date(asOf).getTime();
    if (asOf != null && !isFinite(cutoff)) return { scale: null, n: 0, method: method, reason: 'no prediction time' };
    var res = [];
    (history || []).forEach(function (h) {
      if (!h) return;
      var r = num(h.residual);
      if (r == null) return;
      if (cutoff != null) {
        var t = new Date(h.final_at).getTime();
        /* unknown finish time = cannot prove it was known: excluded */
        if (!h.final_at || !isFinite(t) || t >= cutoff) return;
      }
      res.push(r);
    });
    var out = { scale: null, n: res.length, method: method, min_n: minN, reason: null };
    if (res.length < minN) { out.reason = 'fewer than ' + minN + ' finished forecasts before this one'; return out; }
    var s = method === 'sd' ? R.sd(res) : method === 'mad' ? R.madScale(res) : R.rmse(res);
    if (s == null || s < EPS) { out.reason = 'residual scale not estimable'; return out; }
    out.scale = s;
    return out;
  };
  R.normalizedEdge = function (modelSpread, line, scale) {
    var g = R.spreadGap(modelSpread, line), s = num(scale);
    if (!g || s == null || s <= 0) return null;
    return g.points / s;
  };

  /* ================================================== AGREEMENT / OUTLIERS
     rows: [{id, spread}] home-stated model spreads for ONE game.
     line: the market line they are compared with (optional). */
  R.agreement = function (rows, line) {
    var list = (rows || []).filter(function (r) { return r && num(r.spread) != null; });
    var sp = list.map(function (r) { return num(r.spread); });
    var out = {
      n: sp.length, mean: R.mean(sp), median: R.median(sp),
      min: sp.length ? Math.min.apply(null, sp) : null,
      max: sp.length ? Math.max.apply(null, sp) : null,
      sd: R.sd(sp), range: null,
      lean: { home: 0, away: 0, on_line: 0 }, median_gap: null, market_line: num(line)
    };
    if (sp.length) out.range = out.max - out.min;
    if (out.market_line != null) {
      list.forEach(function (r) {
        var s = R.sideVsLine(r.spread, out.market_line);
        if (s === 'home') out.lean.home++;
        else if (s === 'away') out.lean.away++;
        else out.lean.on_line++;
      });
      if (out.median != null) out.median_gap = R.spreadGap(out.median, out.market_line);
    }
    return out;
  };

  /* Effective number of independent models from a correlation matrix:
       n_eff = n^2 / sum_ij rho_ij
     Negative correlations are floored at zero so n_eff never exceeds n.
     Any missing pair makes the answer null: an unmeasured pair is not an
     independent pair. */
  R.effectiveIndependentCount = function (matrix) {
    if (!matrix || !matrix.length) return null;
    var n = matrix.length, s = 0;
    for (var i = 0; i < n; i++) {
      if (!matrix[i] || matrix[i].length !== n) return null;
      for (var j = 0; j < n; j++) {
        var r = i === j ? 1 : num(matrix[i][j]);
        if (r == null) return null;
        s += Math.max(0, Math.min(1, r));
      }
    }
    return s > EPS ? (n * n) / s : null;
  };

  /* Outlier status of one model's number against the OTHER models' numbers.
     Descriptive only: an outlier is not wrong.
       aligned  |dev from others' median| < 1.5
       mild     1.5 - 3
       strong   >= 3
     lone: with at least two others, the model is the only one on its side of
     the market line. */
  R.OUTLIER_MILD = 1.5;
  R.OUTLIER_STRONG = 3;
  R.outlierStatus = function (modelSpread, otherSpreads, line) {
    var m = num(modelSpread), others = finite(otherSpreads);
    if (m == null || others.length < 2) return null;
    var med = R.median(others), dev = m - med, a = Math.abs(dev);
    var status = a < R.OUTLIER_MILD ? 'aligned' : a < R.OUTLIER_STRONG ? 'mild' : 'strong';
    var lone = false, l = num(line);
    if (l != null) {
      var mine = R.sideVsLine(m, l);
      if (mine) lone = others.every(function (o) { return R.sideVsLine(o, l) !== mine; });
    }
    return { status: status, lone: lone, deviation: round(dev, 4), others_median: med, others_n: others.length,
      label: lone ? 'LONE OUTLIER' : status.toUpperCase() };
  };

  return R;
});
/*__EDRCORE_END__*/

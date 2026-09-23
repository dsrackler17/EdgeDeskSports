/* ===========================================================================
   EdgeDesk research evaluator — walk-forward model diagnostics.

   Depends on lib/research_core.js (window.EDResearch / require). Loaded by
   the browser as window.EDResearchEval and by Node with require().

   ONE RECORD SHAPE for every model, EdgeDesk's own and every Collective model:

     {
       model_id,            'creator/model' or 'edgedesk/cfb_p4@<version>'
       model_version,       optional; kept on every derived row
       sport, game_id,
       kickoff_at,          ISO
       predicted_at,        ISO — when the model's number was received
       spread,              the model's HOME line (negative = home favoured)
       home_win_prob,       explicit model probability, or null
       pick_side,           side the model NAMED, or null
       line_at_prediction,  market HOME line the model was posted against
       line_at_prediction_at, optional capture time of that line
       close_line,          captured closing HOME line, or null
       close_home_prob,     no-vig closing HOME win probability, or null
       home_score, away_score, final_at,
       ats_result,          optional: 'win'|'loss'|'push' from the grader of
                            record; when absent it is computed by the
                            Collective's published contract (named side, else
                            the side the model's number takes against the
                            captured close)
       inputs: [{name, captured_at}]   optional input manifest
     }

   TIME RULES (enforced, not assumed)
     * A record whose line, inputs or result were captured after its
       prediction time is REJECTED with a named violation, never evaluated.
     * The error scale that normalises an edge uses only residuals from the
       same model's games that were final BEFORE this prediction.
     * The side used for CLV and edge buckets is fixed at submission:
       the named side, else the model's number against the line it was
       posted against. The closing line never chooses it.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./research_core.js'));
  else root.EDResearchEval = factory(root.EDResearch);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';
  if (!R) throw new Error('research_eval needs research_core loaded first');

  var E = { version: 'research_eval/1' };
  var num = R.num;

  function ms(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    return isFinite(t) ? t : null;
  }

  /* When a result became KNOWN, for walk-forward purposes, when the feed
     carries no finish time: a fixed rule, not an estimate. Football games end
     inside four hours of kickoff; six leaves margin. A later real finish only
     makes the rule stricter for the caller, never looser. */
  E.FINAL_KNOWN_AFTER_KICKOFF_H = 6;
  E.finalKnownAt = function (kickoffIso, hours) {
    var k = ms(kickoffIso);
    if (k == null) return null;
    var h = hours == null ? E.FINAL_KNOWN_AFTER_KICKOFF_H : hours;
    return new Date(k + h * 3600000).toISOString();
  };

  /* ---------------------------------------------------------- leakage guard */
  E.validateRecord = function (rec) {
    var v = [];
    if (!rec) return { ok: false, violations: ['no record'] };
    var p = ms(rec.predicted_at), k = ms(rec.kickoff_at);
    if (p == null) v.push('no prediction time');
    if (p != null && k != null && p >= k) v.push('prediction at or after kickoff');
    var la = ms(rec.line_at_prediction_at);
    if (p != null && la != null && la > p) v.push('market line captured after the prediction');
    var f = ms(rec.final_at);
    if (p != null && f != null && f <= p) v.push('result known before the prediction');
    (rec.inputs || []).forEach(function (i) {
      var t = ms(i && i.captured_at);
      if (p != null && t != null && t > p) v.push('input from the future: ' + (i.name || 'unnamed'));
    });
    return { ok: v.length === 0, violations: v };
  };

  /* The grading contract, restated from collective/index.html atsResult. */
  E.atsResult = function (margin, closeLine, side) {
    side = R.normSide(side);
    var m = num(margin), c = num(closeLine);
    if (!side || m == null || c == null) return null;
    var covers = m + c;
    if (Math.abs(covers) < 1e-9) return 'push';
    return ((side === 'home') === (covers > 0)) ? 'win' : 'loss';
  };

  /* ------------------------------------------------------------ one record */
  E.deriveRow = function (rec, scale) {
    var hs = num(rec.home_score), as = num(rec.away_score);
    var final = hs != null && as != null;
    var margin = final ? hs - as : null;
    var spread = num(rec.spread), posted = num(rec.line_at_prediction), close = num(rec.close_line);
    var sideAtSub = R.normSide(rec.pick_side) || R.sideVsLine(spread, posted);
    var atsSide = R.normSide(rec.pick_side) || R.sideVsLine(spread, close);
    /* A key that is PRESENT carries the grader of record's answer, null
       included: a grader that declined to grade is not overruled here. */
    var has = function (k) { return Object.prototype.hasOwnProperty.call(rec, k); };
    var ats = has('ats_result') ? (rec.ats_result == null ? null : rec.ats_result)
      : (final ? E.atsResult(margin, close, atsSide) : null);
    var gap = R.spreadGap(spread, posted);
    var pm = R.marginFromSpread(spread);
    var residual = (pm != null && margin != null) ? pm - margin : null;
    var hwp = num(rec.home_win_prob);
    var outcome = (margin == null || margin === 0) ? null : (margin > 0 ? 1 : 0);
    var mkt = num(rec.close_home_prob);
    var sLine = R.sideLine(posted, sideAtSub);
    var z = (gap && scale && scale.scale) ? gap.points / scale.scale : null;
    return {
      model_id: rec.model_id, model_version: rec.model_version || null,
      sport: rec.sport || null, game_id: rec.game_id,
      kickoff_at: rec.kickoff_at, predicted_at: rec.predicted_at, final_at: rec.final_at || null,
      final: final, margin: margin,
      spread: spread, line_at_prediction: posted, close_line: close,
      side_at_submission: sideAtSub,
      ats_side: atsSide, ats_side_implied: !R.normSide(rec.pick_side) && !!atsSide,
      ats: ats,
      gap: gap ? gap.points : null,
      edge_bucket: gap ? R.edgeBucketKey(gap.points) : null,
      /* a replay whose posted line IS the close has no CLV to measure */
      clv: rec.clv_not_applicable ? null : R.clvPoints(sideAtSub, posted, close),
      residual: residual,
      abs_error: has('abs_error_of_record') ? num(rec.abs_error_of_record) : (residual == null ? null : Math.abs(residual)),
      home_win_prob: hwp, outcome: outcome,
      brier: has('brier_of_record') ? num(rec.brier_of_record) : ((hwp != null && outcome != null) ? R.brier(hwp, outcome) : null),
      log_loss: (hwp != null && outcome != null) ? R.logLoss(hwp, outcome) : null,
      market_home_prob: mkt,
      market_brier: (mkt != null && outcome != null) ? R.brier(mkt, outcome) : null,
      scale: scale ? scale.scale : null, scale_n: scale ? scale.n : 0, scale_method: scale ? scale.method : null,
      normalized_edge: z,
      normalized_bucket: z == null ? null : R.normalizedBucketKey(z),
      lead_hours: R.leadHours(rec.predicted_at, rec.kickoff_at),
      lead_bucket: R.leadBucketKey(rec.predicted_at, rec.kickoff_at),
      role: sLine == null ? null : (sLine < 0 ? 'favorite' : sLine > 0 ? 'underdog' : 'pickem'),
      room: rec.room || null,
      season: rec.season == null ? null : rec.season,
      components: rec.components || null
    };
  };

  /* -------------------------------------------------------- the evaluator
     Returns {rows, rejected}. rows are in prediction-time order per model and
     each carries the walk-forward error scale that was knowable when it was
     posted. */
  E.evaluate = function (records, opts) {
    opts = opts || {};
    var rows = [], rejected = [];
    var byModel = {};
    (records || []).forEach(function (rec) {
      var chk = E.validateRecord(rec);
      if (!chk.ok) { rejected.push({ record: rec, violations: chk.violations }); return; }
      (byModel[rec.model_id] = byModel[rec.model_id] || []).push(rec);
    });
    Object.keys(byModel).forEach(function (id) {
      var list = byModel[id].slice().sort(function (a, b) { return ms(a.predicted_at) - ms(b.predicted_at); });
      var history = [];
      list.forEach(function (rec) {
        var scale = R.errorScale(history, rec.predicted_at, { method: opts.scaleMethod, minN: opts.scaleMinN });
        var row = E.deriveRow(rec, scale);
        rows.push(row);
        if (row.residual != null) history.push({ residual: row.residual, final_at: rec.final_at });
      });
    });
    return { rows: rows, rejected: rejected };
  };

  /* ----------------------------------------------------------- aggregation
     Every metric carries its own denominator and an interval where one is
     defensible. Nothing here is averaged across metrics. */
  E.summarize = function (rows) {
    var w = 0, l = 0, p = 0, clv = [], err = [], res = [], br = [], ll = [], pairs = [];
    (rows || []).forEach(function (r) {
      if (r.ats === 'win') w++; else if (r.ats === 'loss') l++; else if (r.ats === 'push') p++;
      if (r.clv != null) clv.push(r.clv);
      if (r.abs_error != null) { err.push(r.abs_error); res.push(r.residual); }
      if (r.brier != null) br.push(r.brier);
      if (r.log_loss != null) ll.push(r.log_loss);
      if (r.home_win_prob != null && r.market_home_prob != null && r.outcome != null)
        pairs.push({ model: r.home_win_prob, market: r.market_home_prob, outcome: r.outcome });
    });
    var pos = clv.filter(function (v) { return v > 0.005; }).length;
    var neg = clv.filter(function (v) { return v < -0.005; }).length;
    return {
      n_rows: (rows || []).length,
      ats: { wins: w, losses: l, pushes: p, n: w + l + p, decided: w + l,
        pct: (w + l) ? w / (w + l) : null, interval: R.wilson(w, w + l) },
      clv: { n: clv.length, mean: R.mean(clv), median: R.median(clv),
        positive: pos, negative: neg, zero: clv.length - pos - neg,
        positive_pct: clv.length ? pos / clv.length : null,
        positive_interval: R.wilson(pos, clv.length), mean_interval: R.meanInterval(clv) },
      mae: { n: err.length, value: R.mean(err), interval: R.meanInterval(err) },
      rmse: { n: res.length, value: R.rmse(res) },
      bias: { n: res.length, value: R.mean(res) },
      brier: { n: br.length, value: R.mean(br), interval: R.meanInterval(br) },
      log_loss: { n: ll.length, value: R.mean(ll) },
      market_benchmark: R.brierSkill(pairs)
    };
  };

  function groupBy(rows, keyFn, order) {
    var g = {};
    (rows || []).forEach(function (r) {
      var k = keyFn(r);
      if (k == null) return;
      (g[k] = g[k] || []).push(r);
    });
    var keys = order || Object.keys(g).sort();
    return keys.map(function (k) { return { key: k, summary: E.summarize(g[k] || []) }; });
  }
  E.groupBy = groupBy;

  /* The full diagnostic for one model's rows. */
  E.modelDiagnostics = function (rows) {
    rows = rows || [];
    return {
      overall: E.summarize(rows),
      edge_buckets: groupBy(rows, function (r) { return r.edge_bucket; },
        R.EDGE_BUCKETS.map(function (b) { return b.key; })),
      /* Thresholds fixed before any data (2..6 points), not tuned on this
         sample. A caller asking for others must label them exploratory. */
      edge_thresholds: R.EDGE_THRESHOLDS.map(function (t) {
        return { threshold: t, prespecified: true,
          summary: E.summarize(rows.filter(function (r) { return r.gap != null && r.gap >= t - 1e-9; })) };
      }),
      normalized_buckets: groupBy(rows, function (r) { return r.normalized_bucket; },
        R.NORMALIZED_BUCKETS.map(function (b) { return b.key; })),
      normalized_unavailable: rows.filter(function (r) { return r.gap != null && r.normalized_edge == null; }).length,
      lead_buckets: groupBy(rows, function (r) { return r.lead_bucket; },
        R.LEAD_BUCKETS.map(function (b) { return b.key; })),
      roles: groupBy(rows, function (r) { return r.role; }, ['favorite', 'underdog', 'pickem']),
      sides: groupBy(rows, function (r) { return r.side_at_submission; }, ['home', 'away']),
      room: groupBy(rows, function (r) { return r.room; }, ['aligned', 'mild', 'strong', 'lone'])
    };
  };

  /* Calibration of the home-win probability: predicted mean vs observed rate
     per bin, each with its own n and interval. */
  E.calibration = function (rows, edges) {
    edges = edges || [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0000001];
    var bins = [];
    for (var i = 0; i < edges.length - 1; i++) bins.push({ lo: edges[i], hi: edges[i + 1], p: [], o: [] });
    (rows || []).forEach(function (r) {
      if (r.home_win_prob == null || r.outcome == null) return;
      for (var j = 0; j < bins.length; j++) {
        if (r.home_win_prob >= bins[j].lo && r.home_win_prob < bins[j].hi) {
          bins[j].p.push(r.home_win_prob); bins[j].o.push(r.outcome); break;
        }
      }
    });
    return bins.map(function (b) {
      var k = b.o.filter(function (x) { return x === 1; }).length;
      return { lo: b.lo, hi: Math.min(1, b.hi), n: b.o.length, predicted: R.mean(b.p),
        observed: b.o.length ? k / b.o.length : null, interval: R.wilson(k, b.o.length) };
    });
  };

  /* Which walk-forward error scale is honest? For every row with a scale,
     the share of |residual| within 1 and 2 scales. A well-calibrated normal
     scale lands near 68% and 95%. Reported per method so the choice of
     method is evidence, not assertion. */
  E.compareScaleMethods = function (records, opts) {
    var out = {};
    R.SCALE_METHODS.forEach(function (m) {
      var ev = E.evaluate(records, { scaleMethod: m, scaleMinN: opts && opts.scaleMinN });
      var n = 0, in1 = 0, in2 = 0;
      ev.rows.forEach(function (r) {
        if (r.scale == null || r.residual == null) return;
        n++;
        var a = Math.abs(r.residual) / r.scale;
        if (a <= 1) in1++;
        if (a <= 2) in2++;
      });
      out[m] = { n: n, within_1: n ? in1 / n : null, within_2: n ? in2 / n : null, target_1: 0.6827, target_2: 0.9545 };
    });
    return out;
  };

  /* ------------------------------------------------- similar situations
     Deterministic and auditable. Candidates are the SAME model's graded rows
     that were final before the target's prediction time. Criteria are
     applied in a fixed order and relaxed from the END of the list only until
     the sample reaches minN; the criteria actually used are returned. */
  E.SIMILARITY_CRITERIA = [
    { key: 'edge_bucket', label: 'same model-market gap bucket' },
    { key: 'lead_bucket', label: 'same lead-time bucket' },
    { key: 'role', label: 'same favourite/underdog side' },
    { key: 'normalized_bucket', label: 'same normalized-edge bucket' }
  ];
  E.similarSituations = function (target, rows, opts) {
    opts = opts || {};
    var minN = opts.minN == null ? 10 : opts.minN;
    var cutoff = ms(target && target.predicted_at);
    var pool = (rows || []).filter(function (r) {
      if (!r || r.model_id !== target.model_id) return false;
      if (target.sport && r.sport && r.sport !== target.sport) return false;
      var f = ms(r.final_at);
      return cutoff != null && f != null && f < cutoff;
    });
    var crit = E.SIMILARITY_CRITERIA.filter(function (c) { return target[c.key] != null; });
    for (var used = crit.length; used >= 0; used--) {
      var active = crit.slice(0, used);
      var match = pool.filter(function (r) {
        return active.every(function (c) { return r[c.key] === target[c.key]; });
      });
      if (match.length >= minN || used === 0) {
        return {
          criteria: active.map(function (c) { return { key: c.key, label: c.label, value: target[c.key] }; }),
          relaxed: crit.slice(used).map(function (c) { return c.key; }),
          n: match.length, min_n: minN, sufficient: match.length >= minN,
          pool_n: pool.length, summary: E.summarize(match)
        };
      }
    }
    return null;
  };

  /* ------------------------------------------- correlation between models
     Pairwise correlation of residuals on the games both models forecast.
     A pair with fewer than minOverlap shared games is null, and the
     effective independent count is then null too. */
  E.modelCorrelation = function (rows, opts) {
    opts = opts || {};
    var minOverlap = opts.minOverlap == null ? 15 : opts.minOverlap;
    var field = opts.field || 'residual';
    var by = {}, ids = [];
    (rows || []).forEach(function (r) {
      if (r[field] == null) return;
      if (!by[r.model_id]) { by[r.model_id] = {}; ids.push(r.model_id); }
      by[r.model_id][r.game_id] = r[field];
    });
    ids.sort();
    var matrix = [], overlap = [];
    for (var i = 0; i < ids.length; i++) {
      matrix.push([]); overlap.push([]);
      for (var j = 0; j < ids.length; j++) {
        if (i === j) { matrix[i].push(1); overlap[i].push(Object.keys(by[ids[i]]).length); continue; }
        var xs = [], ys = [];
        Object.keys(by[ids[i]]).forEach(function (g) {
          if (by[ids[j]][g] != null) { xs.push(by[ids[i]][g]); ys.push(by[ids[j]][g]); }
        });
        overlap[i].push(xs.length);
        matrix[i].push(xs.length >= minOverlap ? R.correlation(xs, ys) : null);
      }
    }
    return { models: ids, matrix: matrix, overlap: overlap, min_overlap: minOverlap,
      effective_n: R.effectiveIndependentCount(matrix) };
  };

  /* --------------------------------------------- component diagnostics
     OPERATOR RESEARCH, never an automatic weight change. For each named
     component of an additive fair line (home-line points on each row's
     `components`), on the rows where it was non-zero:
       delta_mae  MAE of the line WITHOUT the component minus MAE with it.
                  Positive = the component improved the forecast.
       slope      OLS of the actual home-line residual left once the
                  component is removed, on the component: 1 = correctly
                  sized, below 1 = overshoots, above 1 = undershoots. With a
                  95% interval; below minN rows it is not estimated.
       by_season  the same, per season, to see drift.                    */
  function componentStats(list, key) {
    var withErr = [], withoutErr = [], xs = [], ys = [];
    list.forEach(function (r) {
      var c = r.components[key];
      var v = c == null ? null : (typeof c === 'object' ? num(c.value) : num(c));
      if (v == null || Math.abs(v) < 1e-9 || r.spread == null || r.margin == null) return;
      var actualLine = -r.margin;                  /* the home line the result implies */
      var without = r.spread - v;
      withErr.push(Math.abs(r.spread - actualLine));
      withoutErr.push(Math.abs(without - actualLine));
      xs.push(v); ys.push(actualLine - without);
    });
    var n = xs.length, out = { n: n, delta_mae: null, slope: null, slope_interval: null, mean_value: R.mean(xs) };
    if (!n) return out;
    out.delta_mae = R.mean(withoutErr) - R.mean(withErr);
    if (n >= 3) {
      var mx = R.mean(xs), my = R.mean(ys), sxx = 0, sxy = 0, i;
      for (i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
      if (sxx > 1e-9) {
        var b = sxy / sxx, a = my - b * mx, sse = 0;
        for (i = 0; i < n; i++) { var e = ys[i] - a - b * xs[i]; sse += e * e; }
        var se = Math.sqrt(sse / Math.max(1, n - 2) / sxx), t = R.tCritical95(Math.max(1, n - 2));
        out.slope = b; out.slope_interval = { lo: b - t * se, hi: b + t * se };
      }
    }
    return out;
  }
  E.componentDiagnostics = function (rows, opts) {
    opts = opts || {};
    var minN = opts.minN == null ? 30 : opts.minN;
    var list = (rows || []).filter(function (r) { return r && r.components && r.spread != null && r.margin != null; });
    var keys = {};
    list.forEach(function (r) { Object.keys(r.components).forEach(function (k) { keys[k] = 1; }); });
    var seasons = {};
    list.forEach(function (r) { if (r.season != null) (seasons[r.season] = seasons[r.season] || []).push(r); });
    return Object.keys(keys).sort().map(function (k) {
      var all = componentStats(list, k);
      var reading = all.n < minN ? 'insufficient sample (n=' + all.n + ', minimum ' + minN + ')'
        : (all.slope_interval && all.slope_interval.lo > 1) ? 'undershoots: the interval sits above 1'
        : (all.slope_interval && all.slope_interval.hi < 1) ? 'overshoots: the interval sits below 1'
        : 'consistent with correctly sized';
      return { key: k, all: all, reading: reading, min_n: minN,
        by_season: Object.keys(seasons).sort().map(function (sn) { return { season: sn, stats: componentStats(seasons[sn], k) }; }) };
    });
  };

  /* --------------------------------------------------- ensemble research
     For every game at least two models forecast, combine their spreads by
     each method using ONLY information available before the earliest of
     their predictions (inverse-error weights come from each model's own
     games final before then). Every method and every individual model is
     scored on the SAME games. Games are split in time order into a
     development half and a holdout half, and both are reported: a method
     that only wins on the development half has not won. */
  E.ENSEMBLE_METHODS = ['mean', 'median', 'trimmed_mean', 'inverse_mae', 'best_prior_model'];
  E.ensembleResearch = function (rows, opts) {
    opts = opts || {};
    var minN = opts.minN == null ? 10 : opts.minN;
    var byGame = {}, order = [];
    (rows || []).forEach(function (r) {
      if (!r || r.spread == null || r.margin == null || !r.predicted_at) return;
      if (!byGame[r.game_id]) { byGame[r.game_id] = []; order.push(r.game_id); }
      byGame[r.game_id].push(r);
    });
    var hist = (rows || []).filter(function (r) { return r && r.abs_error != null && r.final_at; });
    function priorMae(model, cutoff) {
      var e = hist.filter(function (h) { return h.model_id === model && ms(h.final_at) < cutoff; }).map(function (h) { return h.abs_error; });
      return e.length >= minN ? R.mean(e) : null;
    }
    var games = order.filter(function (g) { return byGame[g].length >= 2; }).map(function (g) {
      var list = byGame[g];
      var cutoff = Math.min.apply(null, list.map(function (r) { return ms(r.predicted_at); }));
      var sp = list.map(function (r) { return r.spread; }), actual = -list[0].margin;
      var sorted = sp.slice().sort(function (a, b) { return a - b; });
      var est = { mean: R.mean(sp), median: R.median(sp),
        trimmed_mean: sorted.length >= 4 ? R.mean(sorted.slice(1, -1)) : null, inverse_mae: null, best_prior_model: null };
      var w = 0, ws = 0, best = null;
      list.forEach(function (r) {
        var m = priorMae(r.model_id, cutoff);
        if (m == null) return;
        w += 1 / (m * m); ws += r.spread / (m * m);
        if (!best || m < best.m) best = { m: m, spread: r.spread };
      });
      /* inverse-error weighting only when EVERY model in the game has a prior */
      if (w > 0 && list.every(function (r) { return priorMae(r.model_id, cutoff) != null; })) est.inverse_mae = ws / w;
      if (best) est.best_prior_model = best.spread;
      var err = {};
      Object.keys(est).forEach(function (k) { err[k] = est[k] == null ? null : Math.abs(est[k] - actual); });
      var indiv = {};
      list.forEach(function (r) { indiv[r.model_id] = Math.abs(r.spread - actual); });
      return { game_id: g, at: cutoff, err: err, indiv: indiv };
    }).sort(function (a, b) { return a.at - b.at; });
    function score(set) {
      var out = { n_games: set.length, methods: {}, individual: {} };
      E.ENSEMBLE_METHODS.forEach(function (k) {
        var common = set.filter(function (g) { return g.err[k] != null; });
        var e = common.map(function (g) { return g.err[k]; });
        var base = common.map(function (g) { return g.err.mean; });
        out.methods[k] = { n: e.length, mae: R.mean(e), interval: R.meanInterval(e),
          vs_mean_same_games: e.length ? R.mean(e) - R.mean(base) : null };
      });
      var ids = {};
      set.forEach(function (g) { Object.keys(g.indiv).forEach(function (id) { ids[id] = 1; }); });
      Object.keys(ids).forEach(function (id) {
        var gs = set.filter(function (g) { return g.indiv[id] != null; });
        out.individual[id] = { n: gs.length, mae: R.mean(gs.map(function (g) { return g.indiv[id]; })),
          mean_ensemble_same_games: R.mean(gs.map(function (g) { return g.err.mean; })) };
      });
      return out;
    }
    var half = Math.floor(games.length / 2);
    return { n_games: games.length, min_n_prior: minN,
      development: score(games.slice(0, half)), holdout: score(games.slice(half)), all: score(games),
      rule: 'walk-forward; weights from games final before each game; scored on identical games; holdout = later half in time' };
  };

  return E;
});

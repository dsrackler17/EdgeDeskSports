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
      clv: R.clvPoints(sideAtSub, posted, close),
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
      room: rec.room || null
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

  return E;
});

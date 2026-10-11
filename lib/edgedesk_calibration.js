/* ===========================================================================
   EdgeDesk CALIBRATION — is a probability source any good, measured on rows
   it could not have seen, against the market's own closing price?

   ONE FILE, Node and browser (UMD, root.EDCALIB). Pure arithmetic; it reads
   no network and decides no bet.

   WHAT IT MEASURES, per group (all, sport, market, model version, odds range)
     - Brier score and log loss of the source, and of the BASELINE on the same
       rows: the no-vig closing probability of the same side. A source that
       does not beat the close is not adding information the market lacked.
     - calibration by probability bucket, each with a Wilson interval
     - closing-line value: EV of the entry price at the closing fair
     - ROI after fees at a flat stake, its normal-approximation interval, and
       the maximum drawdown of the chronological cumulative profit
     - the sample state (<50 TOO_EARLY, 50-199 EARLY_SIGNAL, 200-499
       DEVELOPING, 500+ MEANINGFUL — lib/edgedesk_validation.js's bands)

   WHAT IT REFUSES
     - LOOK-AHEAD. A row whose inputs were observed after its prediction time,
       or whose prediction time is not before the event, is rejected and
       counted. A row with no prediction time is rejected. Nothing rejected
       reaches a metric.
     - A CLAIM IT CANNOT SUPPORT. `calibration_status` is CALIBRATED only with
       a MEANINGFUL sample, a Brier score no worse than the closing baseline,
       and every well-filled bucket inside its interval. `profit_claim` is
       ALLOWED only with 500+ bets and an ROI interval wholly above zero after
       fees. Otherwise each says why not.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDCALIB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'edgedesk_calibration_v1';
  var EPS = 1e-6;
  var Z95 = 1.959964;
  var BANDS = [[500, 'MEANINGFUL'], [200, 'DEVELOPING'], [50, 'EARLY_SIGNAL'], [0, 'TOO_EARLY']];
  var DEFAULT_BUCKETS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];
  var ODDS_RANGES = [
    { id: 'heavy_fav', label: '-200 or shorter', test: function (a) { return a <= -200; } },
    { id: 'fav', label: '-199 to -111', test: function (a) { return a > -200 && a <= -111; } },
    { id: 'pickem', label: '-110 to +110', test: function (a) { return a > -111 && a <= 110; } },
    { id: 'dog', label: '+111 to +199', test: function (a) { return a > 110 && a < 200; } },
    { id: 'long', label: '+200 or longer', test: function (a) { return a >= 200; } }
  ];

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function r(v, k) { if (v == null || !isFinite(v)) return null; var f = Math.pow(10, k == null ? 4 : k); return Math.round(v * f) / f; }
  function sampleState(n) { for (var i = 0; i < BANDS.length; i++) if (n >= BANDS[i][0]) return BANDS[i][1]; return 'TOO_EARLY'; }
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function wilson(k, n) {
    if (!n) return { low: null, high: null };
    var p = k / n, z2 = Z95 * Z95, den = 1 + z2 / n, c = (p + z2 / (2 * n)) / den, h = Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return { low: r(Math.max(0, c - h)), high: r(Math.min(1, c + h)) };
  }

  /**
   * Validate rows and split out the ones that may not be scored.
   * row: { id, predicted_at, event_start, settled_at, inputs_observed_at, prob, outcome
   *        (1 | 0 | 'push' | null for unsettled or void), close_prob, american | decimal,
   *        fee (per $1 staked), bet (bool, default true), stake (default 1),
   *        sport, market, model_version }
   */
  function screen(rows) {
    var ok = [], rejected = [], excluded = 0, pushes = [];
    (rows || []).forEach(function (x, i) {
      var id = x && x.id != null ? x.id : '#' + i;
      var pt = toMs(x && x.predicted_at), es = toMs(x && x.event_start), io = toMs(x && x.inputs_observed_at);
      var p = num(x && x.prob);
      if (pt == null) return rejected.push({ id: id, why: 'NO_PREDICTION_TIME' });
      if (es != null && pt >= es) return rejected.push({ id: id, why: 'PREDICTED_AFTER_START', detail: new Date(pt).toISOString() + ' >= ' + new Date(es).toISOString() });
      if (io != null && io > pt) return rejected.push({ id: id, why: 'INPUT_AFTER_PREDICTION', detail: 'an input observed at ' + new Date(io).toISOString() + ' is after the prediction at ' + new Date(pt).toISOString() });
      if (p == null || p < 0 || p > 1) return rejected.push({ id: id, why: 'BAD_PROBABILITY', detail: String(x && x.prob) });
      /* a push returns the stake: it is not scored for calibration, but it was money at risk, so ROI counts it */
      if (x.outcome === 'push' || x.push === true) {
        var dp = num(x.decimal) != null ? num(x.decimal) : amToDec(x.american);
        if (x.bet !== false && dp != null && dp > 1) pushes.push({ id: id, t: pt, push: true, dec: dp, am: num(x.american), bet: true, stake: num(x.stake) || 1, fee: num(x.fee) || 0, sport: x.sport || null, market: x.market || null, model_version: x.model_version || null, group: x.group && typeof x.group === 'object' ? x.group : null });
        return;
      }
      var o = x.outcome === true ? 1 : x.outcome === false ? 0 : num(x.outcome);
      if (o == null) { excluded++; return; }
      if (o !== 0 && o !== 1) return rejected.push({ id: id, why: 'BAD_OUTCOME', detail: String(x.outcome) });
      var cp = num(x.close_prob);
      var dec = num(x.decimal) != null ? num(x.decimal) : amToDec(x.american);
      ok.push({ id: id, t: pt, p: p, o: o, cp: cp != null && cp > 0 && cp < 1 ? cp : null, dec: dec != null && dec > 1 ? dec : null, am: num(x.american),
        fee: num(x.fee) || 0, bet: x.bet !== false, stake: num(x.stake) || 1, sport: x.sport || null, market: x.market || null, model_version: x.model_version || null, group: x.group && typeof x.group === 'object' ? x.group : null });
    });
    ok.sort(function (a, b) { return a.t - b.t; });
    pushes.sort(function (a, b) { return a.t - b.t; });
    return { rows: ok, rejected: rejected, excluded_unsettled: excluded, pushes: pushes };
  }

  function clip(p) { return Math.min(1 - EPS, Math.max(EPS, p)); }
  function brierOf(list, key) { var s = 0, n = 0; list.forEach(function (x) { var p = x[key]; if (p == null) return; s += (p - x.o) * (p - x.o); n++; }); return n ? s / n : null; }
  function loglossOf(list, key) { var s = 0, n = 0; list.forEach(function (x) { var p = x[key]; if (p == null) return; p = clip(p); s += -(x.o * Math.log(p) + (1 - x.o) * Math.log(1 - p)); n++; }); return n ? s / n : null; }

  function buckets(list, edges) {
    edges = edges || DEFAULT_BUCKETS;
    var out = [];
    for (var i = 0; i < edges.length - 1; i++) {
      var lo = edges[i], hi = edges[i + 1];
      var b = list.filter(function (x) { return x.p >= lo && x.p < hi; });
      if (!b.length) continue;
      var k = b.reduce(function (s, x) { return s + x.o; }, 0), mp = b.reduce(function (s, x) { return s + x.p; }, 0) / b.length;
      var w = wilson(k, b.length);
      out.push({ from: r(lo, 2), to: r(Math.min(1, hi), 2), n: b.length, mean_predicted: r(mp), observed: r(k / b.length), wilson_low: w.low, wilson_high: w.high,
        inside_interval: w.low != null && mp >= w.low - 1e-9 && mp <= w.high + 1e-9 });
    }
    return out;
  }

  /** ROI after fees at a flat stake on the rows flagged as bets, chronologically. */
  function staking(list, pushes) {
    var bets = list.filter(function (x) { return x.bet && x.dec != null; }).concat(pushes || []);
    bets.sort(function (a, b) { return a.t - b.t; });
    var profits = bets.map(function (x) { return x.push ? -x.fee * x.stake : x.o === 1 ? x.stake * (x.dec - 1) - x.fee * x.stake : -x.stake - x.fee * x.stake; });
    var staked = bets.reduce(function (s, x) { return s + x.stake; }, 0);
    var total = profits.reduce(function (s, v) { return s + v; }, 0);
    var peak = 0, cum = 0, dd = 0;
    profits.forEach(function (v) { cum += v; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; });
    var n = profits.length, mean = n ? total / n : null;
    var sd = n > 1 ? Math.sqrt(profits.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / (n - 1)) : null;
    var meanStake = n ? staked / n : 1;
    var ci = sd != null ? { low: r((mean - Z95 * sd / Math.sqrt(n)) / meanStake), high: r((mean + Z95 * sd / Math.sqrt(n)) / meanStake) } : { low: null, high: null };
    return { bets: n, pushes: (pushes || []).length, staked: r(staked, 2), profit: r(total, 3), roi_after_fees: staked ? r(total / staked) : null, roi_ci95: ci, max_drawdown: r(dd, 3) };
  }
  function clvOf(list) {
    var v = list.filter(function (x) { return x.cp != null && x.dec != null; }).map(function (x) { return x.dec * x.cp - 1; });
    if (!v.length) return { n: 0, mean: null, share_positive: null, note: 'no closing probability on these rows' };
    return { n: v.length, mean: r(v.reduce(function (s, x) { return s + x; }, 0) / v.length), share_positive: r(v.filter(function (x) { return x > 0; }).length / v.length), note: 'EV of the entry price at the no-vig closing probability' };
  }

  function summary(list, opts, pushes) {
    opts = opts || {};
    var n = list.length;
    var withClose = list.filter(function (x) { return x.cp != null; });
    var b = brierOf(list, 'p'), ll = loglossOf(list, 'p');
    var bClose = brierOf(withClose, 'p'), bBase = brierOf(withClose, 'cp');
    var llClose = loglossOf(withClose, 'p'), llBase = loglossOf(withClose, 'cp');
    var bk = buckets(list, opts.buckets);
    var st = staking(list, pushes);
    var state = sampleState(n);
    var filled = bk.filter(function (x) { return x.n >= 30; });
    var outside = filled.filter(function (x) { return !x.inside_interval; });
    var cal, calWhy;
    if (state !== 'MEANINGFUL') { cal = 'INSUFFICIENT_SAMPLE'; calWhy = n + ' settled predictions (' + state + '); calibration needs 500+'; }
    else if (bClose == null) { cal = 'NOT_CALIBRATED'; calWhy = 'no closing baseline on these rows, so the source cannot be compared with the market'; }
    /* the comparison is only as large as the rows that carry a close */
    else if (withClose.length < 500) { cal = 'INSUFFICIENT_SAMPLE'; calWhy = 'only ' + withClose.length + ' of ' + n + ' settled predictions carry a closing probability; the comparison with the market needs 500+'; }
    else if (bClose > bBase + 1e-9) { cal = 'NOT_CALIBRATED'; calWhy = 'Brier ' + r(bClose) + ' is worse than the no-vig close at ' + r(bBase) + ' on the same rows'; }
    else if (outside.length) { cal = 'NOT_CALIBRATED'; calWhy = outside.length + ' of ' + filled.length + ' well-filled buckets sit outside their 95% interval'; }
    else { cal = 'CALIBRATED'; calWhy = 'beats or matches the no-vig close (' + r(bClose) + ' vs ' + r(bBase) + ') and every well-filled bucket is inside its interval'; }
    var profit = st.bets >= 500 && st.roi_ci95.low != null && st.roi_ci95.low > 0 ? 'ALLOWED' : 'NOT_SUPPORTED';
    var profitWhy = profit === 'ALLOWED' ? 'ROI after fees ' + st.roi_after_fees + ' with a 95% interval above zero over ' + st.bets + ' bets'
      : st.bets < 500 ? st.bets + ' bets: a profit claim needs 500+ and an interval above zero'
        : 'the 95% ROI interval after fees (' + st.roi_ci95.low + ' to ' + st.roi_ci95.high + ') includes zero or is negative';
    return {
      n: n, sample_state: state,
      brier: r(b), log_loss: r(ll),
      versus_close: { n: withClose.length, brier: r(bClose), baseline_brier: r(bBase), brier_skill: bBase ? r(1 - bClose / bBase) : null, log_loss: r(llClose), baseline_log_loss: r(llBase), baseline: 'no-vig closing probability of the same side' },
      buckets: bk, clv: clvOf(list), staking: st,
      calibration_status: cal, calibration_why: calWhy, profit_claim: profit, profit_why: profitWhy
    };
  }
  function groupBy(list, keyFn) { var g = {}; list.forEach(function (x) { var k = keyFn(x); if (k == null) return; (g[k] = g[k] || []).push(x); }); return g; }

  /** The full report. opts.buckets, opts.groups (default sport, market, model_version, odds_range). */
  function evaluate(rows, opts) {
    opts = opts || {};
    var s = screen(rows);
    var out = { schema: VERSION, rows_in: (rows || []).length, scored: s.rows.length, rejected: s.rejected.length, rejected_reasons: {}, rejected_sample: s.rejected.slice(0, 10), excluded_unsettled: s.excluded_unsettled,
      lookahead_violations: s.rejected.filter(function (x) { return x.why === 'PREDICTED_AFTER_START' || x.why === 'INPUT_AFTER_PREDICTION'; }).length,
      first: s.rows.length ? new Date(s.rows[0].t).toISOString() : null, last: s.rows.length ? new Date(s.rows[s.rows.length - 1].t).toISOString() : null,
      overall: summary(s.rows, opts, s.pushes), by: {} };
    s.rejected.forEach(function (x) { out.rejected_reasons[x.why] = (out.rejected_reasons[x.why] || 0) + 1; });
    var groups = opts.groups || ['sport', 'market', 'model_version', 'odds_range'];
    groups.forEach(function (gk) {
      var keyFn = gk === 'odds_range' ? function (x) { if (x.am == null) return null; for (var i = 0; i < ODDS_RANGES.length; i++) if (ODDS_RANGES[i].test(x.am)) return ODDS_RANGES[i].label; return null; }
        : gk.indexOf('group.') === 0 ? function (x) { return x.group ? x.group[gk.slice(6)] : null; }
        : function (x) { return x[gk]; };
      var g = groupBy(s.rows, keyFn), gp = groupBy(s.pushes, keyFn);
      out.by[gk] = Object.keys(g).sort().map(function (k) { var sm = summary(g[k], opts, gp[k] || []); sm.key = k; return sm; });
    });
    return out;
  }

  /**
   * Chronological folds: train on everything strictly before each cutoff, test
   * on [cutoff, next cutoff). `fit(trainRows)` returns a predictor
   * `predict(row) → probability`; the fold refuses a test row that predates
   * its cutoff and a training row that does not.
   * A training row must also be SETTLED by the cutoff — its outcome known —
   * not merely started: settled_at, else event_start + o.settle_lag_h (default
   * 6 hours). A row with neither is never trained on.
   */
  function walkForward(rows, o) {
    o = o || {};
    var lagMs = (num(o.settle_lag_h) != null ? num(o.settle_lag_h) : 6) * 3600000;
    var settledBy = function (x) { var s0 = toMs(x.settled_at); if (s0 != null) return s0; var es = toMs(x.event_start); return es != null ? es + lagMs : null; };
    var cut = (o.cutoffs || []).map(toMs).filter(function (t) { return t != null; }).sort(function (a, b) { return a - b; });
    var all = (rows || []).slice().sort(function (a, b) { return toMs(a.predicted_at) - toMs(b.predicted_at); });
    var folds = [];
    for (var i = 0; i < cut.length; i++) {
      var from = cut[i], to = i + 1 < cut.length ? cut[i + 1] : Infinity;
      var train = all.filter(function (x) { var st0 = settledBy(x); return toMs(x.predicted_at) < from && st0 != null && st0 <= from; });
      var test = all.filter(function (x) { var t = toMs(x.predicted_at); return t >= from && t < to; });
      if (!train.length || !test.length) { folds.push({ fold: i + 1, test_from: new Date(from).toISOString(), skipped: !train.length ? 'no training rows before the cutoff' : 'no test rows' }); continue; }
      var predict = typeof o.fit === 'function' ? o.fit(train) : null;
      var scored = test.map(function (x) { return Object.assign({}, x, { prob: predict ? predict(x) : x.prob }); });
      var trainTo = Math.max.apply(null, train.map(function (x) { return toMs(x.predicted_at); }));
      folds.push({ fold: i + 1, train_n: train.length, train_to: new Date(trainTo).toISOString(), test_from: new Date(from).toISOString(), test_to: isFinite(to) ? new Date(to).toISOString() : null,
        separated: trainTo < from, report: evaluate(scored, o).overall });
    }
    return { schema: VERSION + ':walk_forward', folds: folds, all_separated: folds.every(function (f) { return f.skipped || f.separated; }) };
  }

  /** The report as a model_backtests row (supabase/quant_desk.sql). */
  function backtestRow(rep, o) {
    o = o || {};
    var ov = rep.overall;
    return {
      backtest_id: o.backtest_id, sport: o.sport, market: o.market, model_version: o.model_version, method: o.method || 'ledger replay',
      train_from: o.train_from || null, train_to: o.train_to, test_from: o.test_from || (rep.first ? rep.first.slice(0, 10) : null), test_to: o.test_to || (rep.last ? rep.last.slice(0, 10) : null),
      n: ov.n, brier: ov.versus_close.brier != null ? ov.versus_close.brier : ov.brier, log_loss: ov.versus_close.log_loss != null ? ov.versus_close.log_loss : ov.log_loss,
      baseline_brier: ov.versus_close.baseline_brier, baseline_log_loss: ov.versus_close.baseline_log_loss, baseline: ov.versus_close.baseline,
      clv_mean: ov.clv.mean, roi_after_fees: ov.staking.roi_after_fees, max_drawdown: ov.staking.max_drawdown, ci_low: ov.staking.roi_ci95.low, ci_high: ov.staking.roi_ci95.high,
      buckets: ov.buckets, by_odds_range: (rep.by && rep.by.odds_range) || null, sample_state: ov.sample_state, calibration_status: ov.calibration_status,
      lookahead_violations: rep.lookahead_violations, artifact_path: o.artifact_path || null, notes: ov.calibration_why + ' · ' + ov.profit_why
    };
  }

  return { VERSION: VERSION, BANDS: BANDS, ODDS_RANGES: ODDS_RANGES, sampleState: sampleState, wilson: wilson, screen: screen, buckets: buckets, staking: staking, summary: summary, evaluate: evaluate, walkForward: walkForward, backtestRow: backtestRow };
});

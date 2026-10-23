/* ===========================================================================
   EDGEDESK MODEL DNA — "can I trust this model in this kind of situation?",
   answered from the audits EdgeDesk already publishes, never from new claims.
   docs/signal-center/METHODOLOGY.md §5

   It reads, and only reads:
     engine/registry.json            the out-of-sample (walk-forward / holdout)
                                     evidence per sport and market: outcome
                                     VALIDATED / PROVISIONAL, the market test
                                     (TESTED_BEHIND / NOT_TESTED …), n, file
     performance/data/summary.json   the live record: every pregame forecast
                                     locked before the game and graded, by
                                     sport, by tier and by model version, with
                                     Brier, log loss, calibration bands and
                                     their Wilson intervals, and the market
                                     comparison on the same games

   It never computes a new metric from raw games, never fills a missing
   statistic, and never compares two models across different samples: a
   model-vs-market Brier pair is shown only as the summary computed it, on
   the same games. A statistic on fewer than the summary's own minimum (20)
   is shown as its count with "too early", never as a rate.

   Spread and total forecasts are not binary: they are described by their
   own measures (margin MAE / bias / RMSE, CRPS in the backtest), never by a
   win rate. Raw win rate is shown last and is never the headline.

   Browser: window.EDModelDNA. Node: require('./edgedesk_model_dna.js'). ES5.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDModelDNA = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var D = { VERSION: 'edgedesk_model_dna/1', SCHEMA: 'edgedesk_model_dna_v1' };

  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function r4(x) { return num(x) === null ? null : Math.round(x * 10000) / 10000; }

  /* the registry's sport ids, the performance summary's, and the label */
  D.SPORTS = {
    nfl: { registry: 'nfl', perf: 'nfl', label: 'EdgeDesk NFL model' },
    cfb: { registry: 'cfb', perf: 'cfb', label: 'EdgeDesk college football model' },
    nba: { registry: 'nba', perf: 'nba', label: 'EdgeDesk NBA model' },
    nhl: { registry: 'nhl', perf: 'nhl', label: 'EdgeDesk NHL model' },
    wnba: { registry: 'wnba', perf: 'wnba', label: 'EdgeDesk WNBA model' },
    mlb: { registry: 'mlb', perf: null, label: 'EdgeDesk MLB model' },
    ncaam: { registry: 'ncaab_m', perf: null, label: 'EdgeDesk men’s college basketball model' },
    mma: { registry: 'mma', perf: null, label: 'EdgeDesk UFC model' },
    college_baseball: { registry: 'college_baseball', perf: null, label: 'EdgeDesk college baseball model' }
  };

  /* The grade, from the evidence only (METHODOLOGY.md §5):
       VALIDATED     the winner/moneyline backtest is VALIDATED, at least 100
                     verified live games, and no live calibration band misses
                     its interval
       PARTIAL       backtest VALIDATED; 20–99 verified live games, or a band
                     that misses its interval
       EARLY         backtest VALIDATED; fewer than 20 verified live games
       EXPERIMENTAL  the backtest is PROVISIONAL / EXPERIMENTAL
       UNVALIDATED   no backtest evidence on file */
  D.GRADES = {
    VALIDATED: 'Calibrated out of sample, and the live record agrees so far.',
    PARTIAL: 'Calibrated out of sample; the live record is still short or shows a band to watch.',
    EARLY: 'Calibrated out of sample; too few live games to judge it live.',
    EXPERIMENTAL: 'Its out-of-sample evidence is provisional: treat its probabilities as research.',
    UNVALIDATED: 'No out-of-sample evidence is on file.'
  };

  function backtestFor(reg, sportCfg) {
    var s = null;
    ((reg && reg.sports) || []).forEach(function (x) { if (x.id === sportCfg.registry) s = x; });
    if (!s) return null;
    var mk = (s.readiness && s.readiness.markets) || {};
    var types = { moneyline: 'binary (winner)', spread: 'margin distribution', total: 'total distribution', team_total: 'team total', regulation_3way: 'three-way' };
    return {
      product: s.product || null,
      brain: s.brain ? { id: s.brain.id || null, status: s.brain.status || null } : null,
      evidence_generated_at: s.evidence_generated_at || null,
      markets: Object.keys(mk).map(function (k) {
        var m = mk[k];
        return { market: k, forecast_type: types[k] || k, state: m.state || null, outcome: m.outcome || null, market_test: m.market || null, value_claims: m.value_claims === true, n: num(m.n), headline: m.headline || null, reason: m.reason || null, file: m.file || null };
      })
    };
  }
  function liveFor(perf, sportCfg) {
    if (!perf || !sportCfg.perf || !perf.by_sport || !perf.by_sport[sportCfg.perf]) return null;
    var V = perf.by_sport[sportCfg.perf].verified || {};
    var w = V.winner || {};
    var mk = V.market || {};
    var versions = (perf.by_model || []).filter(function (m) { return m.sport === sportCfg.perf && m.tier === 'VERIFIED'; }).map(function (m) {
      return { version: m.model_version, graded: m.graded, brier: m.winner ? num(m.winner.brier) : null, log_loss: m.winner ? num(m.winner.log_loss) : null, sample_state: m.winner ? m.winner.sample_state : null };
    });
    return {
      tier: 'VERIFIED', tier_means: perf.tiers && perf.tiers.VERIFIED ? perf.tiers.VERIFIED.means : null,
      window: { from: perf.ledger ? perf.ledger.epoch : null, to: perf.generated_at || null },
      min_n: num(perf.min_n),
      winner: { n: num(w.n), brier: num(w.brier), log_loss: num(w.log_loss), sample_state: w.sample_state || null, correct: num(w.correct), called: num(w.called) },
      calibration: (w.calibration || []).map(function (b) { return { from: b.from, to: b.to, n: b.n, mean_predicted: b.mean_predicted, observed: b.observed, wilson_low: b.wilson_low, wilson_high: b.wilson_high, inside_interval: b.inside_interval }; }),
      margin: V.margin ? { n: num(V.margin.n), mae: num(V.margin.mae), bias: num(V.margin.bias), rmse: num(V.margin.rmse), sample_state: V.margin.sample_state || null } : null,
      total: V.total ? { n: num(V.total.n), mae: num(V.total.mae), bias: num(V.total.bias), rmse: num(V.total.rmse), sample_state: V.total.sample_state || null } : null,
      market: {
        moneyline: mk.moneyline ? { n: num(mk.moneyline.n), model_brier: num(mk.moneyline.model_brier), market_brier: num(mk.moneyline.market_brier), sample_state: mk.moneyline.sample_state || null } : null,
        spread: mk.spread ? { n: num(mk.spread.n), model_mae: num(mk.spread.model_mae), market_mae: num(mk.spread.market_mae), model_nearer: num(mk.spread.model_nearer), market_nearer: num(mk.spread.market_nearer), sample_state: mk.spread.sample_state || null } : null
      },
      clv: V.clv || null,
      versions: versions,
      degradation: degradation(V.trend || [], num(perf.min_n) || 20)
    };
  }
  /* recent window vs everything before it, from the summary's own
     cumulative figures (the weekly Brier is derived, and labelled so). Both
     windows need the summary's minimum sample. */
  function degradation(trend, minN) {
    if (!trend || trend.length < 2) return { available: false, reason: 'fewer than two weeks graded' };
    var last = trend[trend.length - 1], prev = trend[trend.length - 2];
    var nLast = num(last.called), nPrev = num(prev.cum_called);
    if (!(nLast >= minN) || !(nPrev >= minN) || num(last.cum_brier) === null || num(prev.cum_brier) === null) {
      return { available: false, reason: 'the latest week (' + (nLast || 0) + ' games) or the weeks before it (' + (nPrev || 0) + ') have fewer than ' + minN + ' graded games' };
    }
    var recent = (last.cum_brier * num(last.cum_called) - prev.cum_brier * nPrev) / nLast;
    return { available: true, recent_period: last.period, recent_n: nLast, recent_brier: r4(recent), earlier_n: nPrev, earlier_brier: r4(prev.cum_brier), worse_by: r4(recent - prev.cum_brier), derived: 'weekly Brier derived from the cumulative Brier of performance/data/summary.json' };
  }
  function gradeOf(bt, live, servingGraded) {
    var ml = bt && bt.markets.filter(function (m) { return m.market === 'moneyline'; })[0];
    if (!ml) return 'UNVALIDATED';
    if (ml.outcome !== 'VALIDATED') return 'EXPERIMENTAL';
    var n = live && live.winner ? live.winner.n || 0 : 0;
    var flagged = live ? live.calibration.some(function (b) { return b.n >= 20 && b.inside_interval === false; }) : false;
    if (n < 20) return 'EARLY';
    if (n < 100 || flagged) return 'PARTIAL';
    return 'VALIDATED';
  }
  function trustAnswer(grade, bt, live, serving) {
    var ml = bt && bt.markets.filter(function (m) { return m.market === 'moneyline'; })[0];
    var parts = [D.GRADES[grade]];
    if (ml && ml.market_test === 'TESTED_BEHIND') parts.push('Against the closing market its backtest was behind: a disagreement with the market is a question to research, not a betting opportunity.');
    else if (ml && ml.market_test === 'NOT_TESTED') parts.push('It has never been tested against the closing market, so EdgeDesk makes no value claim on it.');
    var M = live && live.market && live.market.moneyline;
    if (M && M.n >= 20 && M.model_brier !== null && M.market_brier !== null) parts.push('On ' + M.n + ' verified live games its Brier score was ' + M.model_brier + ' against the market’s ' + M.market_brier + ' (lower is better).');
    if (serving && serving.version && serving.live_graded === 0) parts.push('The version now serving (' + serving.version + ') has no graded live games yet.');
    return parts.join(' ');
  }

  /* build(registry, perf, serving) -> one record per sport in D.SPORTS that
     has any evidence. serving: { <sport>: { id, version } } — the model the
     signals read today (from the forecast sources), so the record can say
     whether the live statistics describe that version or an earlier one. */
  D.build = function (registry, perf, serving, now) {
    var out = [];
    Object.keys(D.SPORTS).forEach(function (sport) {
      var cfg = D.SPORTS[sport];
      var bt = backtestFor(registry, cfg);
      var live = liveFor(perf, cfg);
      if (!bt && !live) return;
      var sv = serving && serving[sport] ? serving[sport] : null;
      var servingGraded = null;
      if (sv && live) {
        servingGraded = 0;
        live.versions.forEach(function (v) { if (v.version === sv.version || v.version === sv.id) servingGraded += v.graded || 0; });
      }
      var serv = sv ? { id: sv.id || null, version: sv.version || null, live_graded: servingGraded } : null;
      var grade = gradeOf(bt, live, servingGraded);
      var limitations = [];
      if (bt) bt.markets.forEach(function (m) { if (m.outcome && m.outcome !== 'VALIDATED') limitations.push(m.market + ': ' + (m.headline || m.state)); });
      if (live && live.winner && live.winner.sample_state === 'TOO_EARLY') limitations.push('Live record: ' + (live.winner.n || 0) + ' verified games, too early for a rate.');
      if (!live) limitations.push('No live graded record is published for this sport yet.');
      if (serv && serv.live_graded === 0) limitations.push('No graded live games for the serving version ' + serv.version + '.');
      out.push({
        schema: D.SCHEMA, dna_version: D.VERSION,
        model_key: sport + ':' + (bt && bt.brain && bt.brain.id ? String(bt.brain.id).split(' ')[0] : sport),
        sport: sport, label: cfg.label,
        serving: serv,
        backtest: bt,
        live: live,
        grade: grade, grade_means: D.GRADES[grade],
        trust_answer: trustAnswer(grade, bt, live, serv),
        limitations: limitations,
        comparisons: 'Compare two models only on the same games, outcome and window. The live statistics here are one model’s record; the backtest is a different sample and is never mixed into it.',
        evaluated_at: (perf && perf.generated_at) || (bt && bt.evidence_generated_at) || now || null,
        source: [bt ? 'engine/registry.json' : null, live ? 'performance/data/summary.json' : null].filter(Boolean).join(' + ')
      });
    });
    return out;
  };

  /* the reliability grade per model version, for the signal engine */
  D.gradeMap = function (records, versionsBySport) {
    var m = {};
    (records || []).forEach(function (r) {
      (versionsBySport && versionsBySport[r.sport] || []).forEach(function (v) { m[v] = r.grade; });
      if (r.serving && r.serving.version) m[r.serving.version] = r.grade;
    });
    return m;
  };

  return D;
});

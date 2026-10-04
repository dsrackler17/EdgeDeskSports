/* ===========================================================================
   EDGEDESK VALIDATION — does EdgeDesk's own record say its decisions are
   worth anything? docs/bettor-decision/QUALITY_UPGRADE.md §5

   The data layer first, the dashboard second. Every graded decision becomes
   one ROW with every dimension it can be judged by; every summary carries its
   sample size and a sample state; nothing is ever averaged across evaluation
   modes.

     row(...) / fromDecision / fromLabEvaluation
                          one flat, versioned record per graded decision
     DIMENSIONS           the extensible registry: sport, decision, unit tier,
                          market, confidence, calibration source, reliability,
                          price edge, calibrated EV, model–market gap,
                          favourite/underdog, home/away, conference/NFL, key
                          number exposure, market quality, book depth, quote
                          freshness, model version, … (add one by adding a key)
     summarize / segment  observed vs expected cover (Wilson interval), CLV
                          (mean, median, % beat / tie / lose, interval), ROI —
                          with n and a sample state on every figure
     calibration          predicted vs observed by bucket, Brier, log loss,
                          expected calibration error, the curve
     clv                  points, price-equivalent (the entry's EV at the
                          closing market's own distribution), implied
                          probability for moneylines, points for totals
     expectations         BET should beat LEAN, LEAN should beat PASS, a larger
                          stake tier should separate from a smaller one —
                          checked only on meaningful samples, and a failure is
                          a RESEARCH ALERT, never an automatic change
     leakageAudit         every row was decided before kickoff on inputs
                          captured before the evaluation
     autopsy              a large miss, told from the frozen pregame record;
                          the final score never rewrites the pregame reasoning

   EVALUATION MODES — never blended
     BACKTEST             a model run over past games (REPLAY)
     WALK_FORWARD         trained only on earlier data, evaluated forward
     LIVE_RECONSTRUCTED   a pregame number recovered after the fact (git)
     LIVE                 published before kickoff and captured then
   Maturity: BACKTEST → WALK_FORWARD → LIVE DECISIONS → LIVE CLV → LIVE
   PROFITABILITY. Profitability alone is never treated as proof.

   SAMPLE STATES (product maturity labels, not scientific verdicts)
     n < 50      DESCRIPTIVE ONLY    "Too early to evaluate"
     50–199      EARLY SIGNAL        "Early signal"
     200–499     MODERATE EVIDENCE   "Developing evidence"
     500+        STRONGER EVIDENCE   "Meaningful sample"
   Nothing here recalibrates anything. At 200+ a change may be PROPOSED for a
   person to review; below that it may not even be proposed.

   Browser: window.EDValidation (load lib/research_core.js first).
   Node: require('./edgedesk_validation.js'). ES5.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDValidation = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_validation_v1';
  var Rc = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) { try { Rc = require('./research_core.js'); } catch (e) { Rc = null; } }
  function R() {
    var c = Rc || (root && root.EDResearchCore) || (root && root.EDResearch && typeof root.EDResearch.wilson === 'function' ? root.EDResearch : null);
    if (!c || typeof c.wilson !== 'function') throw new Error('EDValidation needs lib/research_core.js loaded first');
    return c;
  }

  /* ------------------------------------------------------------- helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function upper(s) { return s == null ? null : String(s).toUpperCase(); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function a2d(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function pctText(x, dp) { return isNum(x) ? (100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }

  /* ================================================================ MODES */
  var MODES = {
    BACKTEST: { key: 'BACKTEST', label: 'Backtest', rank: 0, text: 'A model run over past games. It shows how a rule would have behaved; it is not a record.' },
    WALK_FORWARD: { key: 'WALK_FORWARD', label: 'Walk-forward', rank: 1, text: 'Trained only on earlier seasons and evaluated forward, one season at a time.' },
    LIVE_RECONSTRUCTED: { key: 'LIVE_RECONSTRUCTED', label: 'Live (reconstructed)', rank: 2, text: 'A number EdgeDesk published before kickoff, recovered afterwards from the repository history. Pregame, but not captured live.' },
    LIVE: { key: 'LIVE', label: 'Live', rank: 3, text: 'Published before kickoff and captured at the time.' }
  };
  var MATURITY = [
    { key: 'BACKTEST', label: 'Backtest' }, { key: 'WALK_FORWARD', label: 'Walk-forward' }, { key: 'LIVE_DECISIONS', label: 'Live decisions' },
    { key: 'LIVE_CLV', label: 'Live CLV' }, { key: 'LIVE_PROFITABILITY', label: 'Live profitability' }
  ];
  function modeOf(x) {
    var m = upper(x);
    if (m === 'REPLAY' || m === 'BACKTEST' || m === 'SIMULATION') return 'BACKTEST';
    if (m === 'WALK_FORWARD' || m === 'HOLDOUT' || m === 'TIME_SEPARATED') return 'WALK_FORWARD';
    if (m === 'GIT_RECONSTRUCTED' || m === 'LIVE_RECONSTRUCTED' || m === 'RECONSTRUCTED') return 'LIVE_RECONSTRUCTED';
    if (m === 'LIVE') return 'LIVE';
    return null;
  }

  /* ======================================================== SAMPLE STATES */
  var SAMPLE_STATES = [
    { key: 'DESCRIPTIVE_ONLY', min: 0, label: 'Too early to evaluate', short: 'descriptive only', recalibration: 'NOT_ALLOWED' },
    { key: 'EARLY_SIGNAL', min: 50, label: 'Early signal', short: 'early signal', recalibration: 'NOT_ALLOWED' },
    { key: 'MODERATE_EVIDENCE', min: 200, label: 'Developing evidence', short: 'developing evidence', recalibration: 'PROPOSAL_ONLY' },
    { key: 'STRONGER_EVIDENCE', min: 500, label: 'Meaningful sample', short: 'meaningful sample', recalibration: 'PROPOSAL_ONLY' }
  ];
  function sampleState(n) {
    n = num(n) || 0;
    var s = SAMPLE_STATES[0];
    SAMPLE_STATES.forEach(function (x) { if (n >= x.min) s = x; });
    return { key: s.key, label: s.label, n: n, text: 'n=' + n + ' · ' + s.label, recalibration: s.recalibration,
      note: 'A product maturity label, not a scientific verdict.' };
  }
  /* HOW MANY INDEPENDENT OUTCOMES A SET OF ROWS IS (audit 2026-10-03). A
     sample state is a statement about evidence, and evidence is games, not
     rows: the CFB Lab grades every model version at every checkpoint of a
     game (OPEN, T72 … T2, FINAL), so its first two live days were 600 rows
     over 19 games and read "n=550 · Meaningful sample", licensing a
     recalibration PROPOSAL on what is 19 results. Rows of the same game and
     market share one outcome, so they count once; a row with no game id
     counts as its own. Every figure still prints its row n beside it. */
  function independentN(rows) {
    var seen = {}, n = 0;
    (rows || []).forEach(function (x, i) {
      var k = x && x.game_id != null && x.game_id !== '' ? 'g:' + x.game_id + '|' + (x.market_type || '') : 'r:' + i;
      if (!seen[k]) { seen[k] = true; n++; }
    });
    return n;
  }
  /* a percentage is never printed without its n */
  function withN(p, n, dp) { return isNum(p) ? pctText(p, dp) + ' (n=' + (n || 0) + ')' : '— (n=' + (n || 0) + ')'; }

  /* ================================================================== ROW
     One flat record per graded decision. Missing is null, never zero. */
  var ROW_SCHEMA = 'edgedesk_validation_row_v1';
  function resultOf(x) { var s = String(x == null ? '' : x).toLowerCase(); if (s === 'win' || s === 'w' || s === 'cover' || s === 'covered') return 'win'; if (s === 'loss' || s === 'l' || s === 'lose') return 'loss'; if (s === 'push' || s === 'p') return 'push'; return null; }
  function decisionKey(x) { var d = upper(x); if (d === 'WAIT') return 'WATCH'; if (d === 'NO DECISION') return 'NO_DECISION'; return d || null; }
  function row(o) {
    o = o || {};
    var odds = num(o.odds), dec = a2d(odds);
    var out = { schema: ROW_SCHEMA, id: o.id != null ? String(o.id) : null, mode: modeOf(o.mode) || null, source: o.source || null,
      game_id: o.game_id != null ? String(o.game_id) : null, sport: upper(o.sport) || null, market_type: o.market_type || null,
      decision: decisionKey(o.decision), units: num(o.units) || 0, side: o.side || null, line: num(o.line), odds: odds,
      break_even: dec ? 1 / dec : null, predicted: num(o.predicted), predicted_raw: num(o.predicted_raw),
      confidence: num(o.confidence), probability_source: o.probability_source || null, reliability: num(o.reliability),
      edge_pp: num(o.edge_pp), calibrated_ev: num(o.calibrated_ev), decision_ev: num(o.decision_ev), gap_pts: num(o.gap_pts),
      home_away: o.side === 'home' ? 'HOME' : (o.side === 'away' ? 'AWAY' : null), neutral: o.neutral === true,
      conference_game: o.conference_game === true ? true : (o.conference_game === false ? false : null),
      market_quality: o.market_quality || null, book_count: num(o.book_count), quote_age_minutes: num(o.quote_age_minutes),
      key_exposure: o.key_exposure || null,
      result: resultOf(o.result), units_won: num(o.units_won), close_line: num(o.close_line), open_line: num(o.open_line),
      clv_points: num(o.clv_points), clv_price_pp: num(o.clv_price_pp), clv_ev: num(o.clv_ev),
      model_version: o.model_version || null, calibration_version: o.calibration_version || null, rules_version: o.rules_version || null,
      evaluated_at: iso(o.evaluated_at), kickoff: iso(o.kickoff), quote_captured_at: iso(o.quote_captured_at), data_snapshot_at: iso(o.data_snapshot_at),
      close_captured_at: iso(o.close_captured_at), trained_through: o.trained_through != null ? o.trained_through : null, season: num(o.season) };
    out.favorite = favOf(out);
    return out;
  }
  function favOf(x) {
    if (x.market_type === 'moneyline') return isNum(x.odds) ? (x.odds < 0 ? 'FAVORITE' : (x.odds > 0 ? 'UNDERDOG' : 'PICK')) : null;
    if (x.market_type === 'total') return null;
    if (!isNum(x.line)) return null;
    return x.line < -EPS ? 'FAVORITE' : (x.line > EPS ? 'UNDERDOG' : 'PICK');
  }
  /* the decision ledger: a frozen snapshot and its grade */
  function fromDecision(s, g, extra) {
    s = s || {}; g = g || {}; extra = extra || {};
    var q = s.bet_price || s.reference_quote || {};
    var v = s.versions || {};
    var mk = s.market || {};
    return row({ id: s.snapshot_id || s.decision_id, mode: extra.mode || s.evaluation_mode || 'LIVE', source: extra.source || 'decision ledger',
      game_id: s.game_id, sport: s.sport, market_type: s.market_type, decision: s.decision, units: s.recommended_units, side: q.side || s.side_key,
      line: num(q.line) != null ? q.line : s.selected_line, odds: num(q.odds) != null ? q.odds : s.selected_odds,
      predicted: num(s.probability) != null ? s.probability : q.decision_cover, predicted_raw: s.cover_probability,
      confidence: s.decision_confidence, probability_source: s.probability_source, reliability: s.reliability_score,
      edge_pp: s.edge_pp, calibrated_ev: isNum(num(s.calibrated_ev_pct)) ? s.calibrated_ev_pct / 100 : null, decision_ev: isNum(num(s.decision_ev_pct)) ? s.decision_ev_pct / 100 : null,
      gap_pts: s.model_market_gap, market_quality: s.market_quality, book_count: num(mk.book_count) != null ? mk.book_count : extra.book_count,
      quote_age_minutes: num(q.quote_age_minutes), conference_game: extra.conference_game, neutral: extra.neutral, key_exposure: extra.key_exposure,
      result: g.result, units_won: g.units_won, close_line: g.close_line, open_line: g.open_line, clv_points: g.clv_points, clv_price_pp: g.clv_price_pp, clv_ev: g.clv_ev,
      model_version: s.model_version, calibration_version: s.calibration_version, rules_version: v.decision_rules || s.config_version,
      evaluated_at: s.evaluated_at, kickoff: s.kickoff, quote_captured_at: s.quote_captured_at, data_snapshot_at: s.data_snapshot_at || v.data_snapshot_at,
      close_captured_at: g.close_captured_at, season: extra.season });
  }
  /* the decision ledger's graded rows (football/cfb_terminal/decisions/<season>/evaluations.jsonl,
     lib/edgedesk_decision_track.js gradeEvaluation): every class, first snapshot per class */
  function fromDecisionEvaluation(e, extra) {
    e = e || {}; extra = extra || {};
    return row({ id: e.snapshot_id, mode: e.evaluation_mode || 'LIVE', source: 'decision ledger (' + (e.unit_of_analysis || 'first_per_class') + ')', game_id: e.game_id, sport: e.sport,
      market_type: e.market_type, decision: e.decision, units: e.units, side: e.side, line: e.evaluated_line, odds: e.evaluated_odds, predicted: e.predicted, predicted_raw: e.predicted_raw,
      confidence: e.decision_confidence, probability_source: e.probability_source, reliability: e.reliability, edge_pp: e.edge_pp, calibrated_ev: e.calibrated_ev, decision_ev: e.decision_ev,
      gap_pts: e.gap_pts, market_quality: e.market_quality, book_count: e.book_count, quote_age_minutes: e.quote_age_minutes, conference_game: extra.conference_game, neutral: extra.neutral,
      key_exposure: extra.key_exposure, result: e.result, units_won: e.units_won, close_line: e.close_line, open_line: e.open_line, clv_points: e.clv_points, clv_price_pp: e.clv_price_pp, clv_ev: e.clv_ev,
      model_version: e.model_version, calibration_version: e.calibration_version, rules_version: e.rules_version, evaluated_at: e.evaluated_at, kickoff: e.kickoff,
      quote_captured_at: e.quote_captured_at, data_snapshot_at: e.data_snapshot_at, close_captured_at: e.close_captured_at, season: extra.season });
  }
  /* the CFB Lab's evaluation ledger (football/cfb_lab/ledger/<season>/evaluations.jsonl) */
  function fromLabEvaluation(e) {
    e = e || {};
    var side = e.side ? String(e.side).toLowerCase() : null;
    /* graded_line is side-stated (lab_core conv.sideLine); evaluated_at is
       when the lab GRADED the row, so the decision time is the checkpoint's
       own: kickoff − hours_to_kickoff */
    var line = num(e.graded_line), ko = ms(e.kickoff_ts), h = num(e.hours_to_kickoff);
    var decidedAt = ko != null && h != null ? ko - h * 3600e3 : null;
    return row({ id: e.evaluation_id, mode: e.origin, source: 'cfb lab ' + (e.checkpoint_type || ''), game_id: e.game_id, sport: 'CFB', market_type: 'spread',
      decision: e.decision_class, units: num(e.stake_units) || 0, side: side, line: line, odds: num(e.graded_price) != null ? e.graded_price : null,
      predicted: e.cover_probability, confidence: e.football_confidence, gap_pts: isNum(num(e.model_market_gap)) ? Math.abs(e.model_market_gap) : null,
      result: e.ats_result, units_won: e.units, close_line: e.close_home_line, open_line: e.open_home_line, clv_points: e.clv_points,
      clv_price_pp: isNum(num(e.clv_price)) ? 100 * e.clv_price : null, model_version: e.model_version,
      evaluated_at: decidedAt, kickoff: e.kickoff_ts, season: e.season, checkpoint: e.checkpoint_type });
  }

  /* ============================================================ DIMENSIONS
     key → { label, of(row) → bucket | null, order } — null means "not
     measured for this row" and the row is left out of that dimension (and
     counted as missing), never put in a zero bucket. Add a dimension by
     adding a key. */
  function band(v, edges, fmt) {
    if (!isNum(v)) return null;
    for (var i = 0; i < edges.length; i++) if (v < edges[i][0]) return edges[i][1];
    return fmt;
  }
  var DIMENSIONS = {
    mode: { label: 'Evaluation mode', of: function (x) { return x.mode; }, order: ['BACKTEST', 'WALK_FORWARD', 'LIVE_RECONSTRUCTED', 'LIVE'] },
    sport: { label: 'Sport', of: function (x) { return x.sport; }, order: ['NFL', 'CFB'] },
    decision: { label: 'Decision', of: function (x) { return x.decision; }, order: ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'] },
    unit_tier: { label: 'Unit tier', of: function (x) { return x.decision === 'BET' && x.units > 0 ? (Math.round(x.units * 100) / 100).toFixed(2) + 'U' : null; }, order: ['0.25U', '0.50U', '0.75U', '1.00U'] },
    market: { label: 'Market', of: function (x) { return x.market_type; }, order: ['spread', 'total', 'moneyline'] },
    confidence_band: { label: 'Decision confidence', of: function (x) { return band(x.confidence, [[60, '<60'], [70, '60–69'], [80, '70–79'], [90, '80–89']], '90+'); }, order: ['<60', '60–69', '70–79', '80–89', '90+'] },
    calibration_source: { label: 'Calibration source', of: function (x) { return { model_estimated: 'model-estimated', partially_calibrated: 'partially calibrated', calibrated: 'live-validated' }[x.probability_source] || null; }, order: ['model-estimated', 'partially calibrated', 'live-validated'] },
    reliability_band: { label: 'Reliability', of: function (x) { return band(x.reliability, [[60, 'low'], [80, 'adequate']], 'strong'); }, order: ['low', 'adequate', 'strong'] },
    price_edge_band: { label: 'Price edge', of: function (x) { return band(x.edge_pp, [[0, '<0 pp'], [2, '0–2 pp'], [4, '2–4 pp'], [6, '4–6 pp'], [8, '6–8 pp']], '8+ pp'); }, order: ['<0 pp', '0–2 pp', '2–4 pp', '4–6 pp', '6–8 pp', '8+ pp'] },
    calibrated_ev_band: { label: 'Calibrated EV', of: function (x) { var v = isNum(x.calibrated_ev) ? x.calibrated_ev : null; return band(isNum(v) ? 100 * v : null, [[0, '<0%'], [2, '0–2%'], [5, '2–5%'], [8, '5–8%'], [12, '8–12%']], '12%+'); }, order: ['<0%', '0–2%', '2–5%', '5–8%', '8–12%', '12%+'] },
    gap_band: { label: 'Model–market gap', of: function (x) { return band(isNum(x.gap_pts) ? Math.abs(x.gap_pts) : null, [[1, '<1 pt'], [2, '1–2 pts'], [4, '2–4 pts'], [7, '4–7 pts']], '7+ pts'); }, order: ['<1 pt', '1–2 pts', '2–4 pts', '4–7 pts', '7+ pts'] },
    favorite: { label: 'Favourite / underdog', of: function (x) { return x.favorite; }, order: ['FAVORITE', 'PICK', 'UNDERDOG'] },
    home_away: { label: 'Home / away', of: function (x) { return x.neutral ? 'NEUTRAL' : x.home_away; }, order: ['HOME', 'AWAY', 'NEUTRAL'] },
    division: { label: 'Conference / NFL', of: function (x) { return x.sport === 'NFL' ? 'NFL' : (x.conference_game === true ? 'CONFERENCE' : (x.conference_game === false ? 'NON-CONFERENCE' : null)); }, order: ['NFL', 'CONFERENCE', 'NON-CONFERENCE'] },
    key_exposure: { label: 'Key-number exposure', of: function (x) { return x.key_exposure; }, order: ['ON_KEY', 'HOOK', 'OFF_KEY'] },
    market_quality: { label: 'Market quality', of: function (x) { return x.market_quality; }, order: ['VERIFIED', 'STRONG', 'ACCEPTABLE', 'THIN'] },
    book_depth: { label: 'Book depth', of: function (x) { return band(x.book_count, [[2, '1 book'], [4, '2–3 books'], [6, '4–5 books']], '6+ books'); }, order: ['1 book', '2–3 books', '4–5 books', '6+ books'] },
    quote_freshness: { label: 'Quote freshness', of: function (x) { return band(x.quote_age_minutes, [[15, '<15 min'], [45, '15–45 min'], [90, '45–90 min']], '90+ min'); }, order: ['<15 min', '15–45 min', '45–90 min', '90+ min'] },
    model_version: { label: 'Model version', of: function (x) { return x.model_version; }, order: null },
    calibration_version: { label: 'Calibration version', of: function (x) { return x.calibration_version; }, order: null },
    rules_version: { label: 'Decision-rule version', of: function (x) { return x.rules_version; }, order: null }
  };
  /* key-number exposure of a spread line against a league key set */
  function keyExposure(line, keys) {
    if (!isNum(line) || !keys || !keys.length) return null;
    var a = Math.abs(line), best = null;
    keys.forEach(function (k) { var d = Math.abs(a - k); if (best == null || d < best) best = d; });
    return best < EPS ? 'ON_KEY' : (best <= 0.5 + EPS ? 'HOOK' : 'OFF_KEY');
  }

  /* ============================================================ SUMMARIZE
     One group of rows, ONE mode. Every figure carries n. */
  function clvSummary(values, opts) {
    opts = opts || {};
    var a = (values || []).filter(isNum), tieTol = opts.tie == null ? 1e-9 : opts.tie;
    var n = a.length;
    if (!n) return { n: 0, mean: null, median: null, beat: 0, tie: 0, lose: 0, beat_rate: null, tie_rate: null, lose_rate: null, interval: null, sample: sampleState(0) };
    var beat = a.filter(function (v) { return v > tieTol; }).length, lose = a.filter(function (v) { return v < -tieTol; }).length, tie = n - beat - lose;
    var mi = R().meanInterval(a);
    var w = R().wilson(beat, n);
    return { n: n, mean: r(mean(a), 3), median: r(median(a), 3), beat: beat, tie: tie, lose: lose, beat_rate: r(beat / n, 4), tie_rate: r(tie / n, 4), lose_rate: r(lose / n, 4),
      beat_rate_interval: w ? { lo: r(w.lo, 4), hi: r(w.hi, 4) } : null, interval: mi ? { lo: r(mi.lo, 3), hi: r(mi.hi, 3) } : null, sample: sampleState(n) };
  }
  function modesIn(rows) { var m = {}; (rows || []).forEach(function (x) { m[x.mode || 'UNLABELLED'] = true; }); return Object.keys(m); }
  function summarize(rows, opts) {
    opts = opts || {};
    rows = rows || [];
    var modes = modesIn(rows);
    if (modes.length > 1 && !opts.allow_mixed_modes) return { error: 'MIXED_MODES', modes: modes, text: 'Backtest, walk-forward and live results are never blended into one record: summarize each mode separately.' };
    var settled = rows.filter(function (x) { return x.result === 'win' || x.result === 'loss' || x.result === 'push'; });
    var decided = settled.filter(function (x) { return x.result !== 'push'; });
    var wins = decided.filter(function (x) { return x.result === 'win'; }).length;
    var exp = decided.map(function (x) { return x.predicted; }).filter(isNum);
    var be = decided.map(function (x) { return x.break_even; }).filter(isNum);
    var w = decided.length ? R().wilson(wins, decided.length) : null;
    /* ROI: a staked row at its own units; every other row as a HYPOTHETICAL
       flat 1U at the price it was evaluated at (never mixed with the real one) */
    var staked = settled.filter(function (x) { return x.units > 0 && isNum(x.odds); });
    var risked = 0, won = 0;
    staked.forEach(function (x) { var d = a2d(x.odds); risked += x.units; won += x.result === 'win' ? x.units * (d - 1) : (x.result === 'loss' ? -x.units : 0); });
    var flat = settled.filter(function (x) { return isNum(x.odds); }), fr = 0, fw = 0;
    flat.forEach(function (x) { var d = a2d(x.odds); fr += 1; fw += x.result === 'win' ? d - 1 : (x.result === 'loss' ? -1 : 0); });
    var obs = decided.length ? wins / decided.length : null, ex = exp.length ? mean(exp) : null;
    var ind = independentN(decided), st = sampleState(ind);
    return { mode: modes[0] || null, n: rows.length, settled: settled.length, decided: decided.length, wins: wins, losses: decided.length - wins, pushes: settled.length - decided.length,
      observed_cover: r(obs, 4), observed_cover_interval: w ? { lo: r(w.lo, 4), hi: r(w.hi, 4) } : null, expected_cover: r(ex, 4), expected_n: exp.length,
      calibration_error_pp: isNum(obs) && isNum(ex) && exp.length === decided.length ? r(100 * (obs - ex), 2) : null,
      mean_break_even: r(be.length ? mean(be) : null, 4), realized_edge_pp: isNum(obs) && be.length ? r(100 * (obs - mean(be)), 2) : null,
      clv: clvSummary(rows.map(function (x) { return x.clv_points; })), clv_price_pp: clvSummary(rows.map(function (x) { return x.clv_price_pp; })),
      clv_ev: clvSummary(rows.map(function (x) { return x.clv_ev; })),
      units_risked: r(risked, 2), units_won: r(won, 2), roi: risked > 0 ? r(won / risked, 4) : null, roi_n: staked.length,
      flat_roi_hypothetical: fr > 0 ? r(fw / fr, 4) : null, flat_n: flat.length,
      independent_n: ind, sample: st,
      text: 'Observed cover ' + withN(obs, decided.length) + (ind < decided.length ? ' over ' + ind + ' game' + (ind === 1 ? '' : 's') : '')
        + (isNum(ex) ? ' vs expected ' + pctText(ex) : '') + ' · ' + st.label };
  }
  /* rows grouped by one dimension — per mode, never across modes */
  function segment(rows, dim, opts) {
    opts = opts || {};
    var D = typeof dim === 'string' ? DIMENSIONS[dim] : dim;
    if (!D) return { error: 'UNKNOWN_DIMENSION', dimension: dim };
    var out = { dimension: typeof dim === 'string' ? dim : (D.key || null), label: D.label, modes: {} };
    var byMode = {};
    (rows || []).forEach(function (x) { (byMode[x.mode || 'UNLABELLED'] = byMode[x.mode || 'UNLABELLED'] || []).push(x); });
    Object.keys(byMode).forEach(function (m) {
      var groups = {}, missing = 0;
      byMode[m].forEach(function (x) { var k = D.of(x); if (k == null) { missing++; return; } k = String(k); (groups[k] = groups[k] || []).push(x); });
      var keys = Object.keys(groups);
      if (D.order) keys.sort(function (a, b) { var ia = D.order.indexOf(a), ib = D.order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1); });
      else keys.sort();
      out.modes[m] = { buckets: keys.map(function (k) { var s = summarize(groups[k], opts); s.bucket = k; return s; }), not_measured: missing };
    });
    return out;
  }

  /* ========================================================== CALIBRATION
     Measurement only. Predicted probability of the side covering (pushes
     excluded) against what happened, by bucket. Nothing is recalibrated. */
  var CAL_EDGES = [0, 0.40, 0.45, 0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.65, 0.70, 0.80, 1.0000001];
  function calibration(rows, opts) {
    opts = opts || {};
    var modes = modesIn(rows);
    if (modes.length > 1 && !opts.allow_mixed_modes) return { error: 'MIXED_MODES', modes: modes };
    var edges = opts.edges || CAL_EDGES;
    var used = (rows || []).filter(function (x) { return isNum(x.predicted) && (x.result === 'win' || x.result === 'loss'); });
    var pts = used.map(function (x) { return { p: x.predicted, y: x.result === 'win' ? 1 : 0, x: x }; });
    var n = pts.length, ind = independentN(used);
    var bins = [];
    for (var i = 0; i < edges.length - 1; i++) {
      var lo = edges[i], hi = edges[i + 1];
      var inb = pts.filter(function (q) { return q.p >= lo - EPS && q.p < hi - EPS; });
      if (!inb.length) continue;
      var k = inb.filter(function (q) { return q.y === 1; }).length, e = mean(inb.map(function (q) { return q.p; }));
      var w = R().wilson(k, inb.length);
      bins.push({ lo: lo, hi: Math.min(1, hi), label: pctText(lo, 0) + '–' + pctText(Math.min(1, hi), 0), n: inb.length, expected: r(e, 4), observed: r(k / inb.length, 4),
        error_pp: r(100 * (k / inb.length - e), 2), interval: w ? { lo: r(w.lo, 4), hi: r(w.hi, 4) } : null,
        inside_interval: w ? e >= w.lo - EPS && e <= w.hi + EPS : null, sample: sampleState(independentN(inb.map(function (q) { return q.x; }))) });
    }
    var brier = n ? mean(pts.map(function (q) { return R().brier(q.p, q.y); })) : null;
    var ll = n ? mean(pts.map(function (q) { return R().logLoss(q.p, q.y); })) : null;
    var ece = n ? bins.reduce(function (s, b) { return s + (b.n / n) * Math.abs(b.observed - b.expected); }, 0) : null;
    var mce = bins.length ? Math.max.apply(null, bins.map(function (b) { return Math.abs(b.observed - b.expected); })) : null;
    var base = n ? mean(pts.map(function (q) { return q.y; })) : null;
    var baseBrier = n ? mean(pts.map(function (q) { return R().brier(base, q.y); })) : null;
    return { mode: modes[0] || null, n: n, bins: bins, brier: r(brier, 5), log_loss: r(ll, 5), ece: r(ece, 5), mce: r(mce, 5),
      base_rate: r(base, 4), base_rate_brier: r(baseBrier, 5), brier_skill_vs_base_rate: isNum(brier) && isNum(baseBrier) && baseBrier > EPS ? r(1 - brier / baseBrier, 4) : null,
      curve: bins.map(function (b) { return { expected: b.expected, observed: b.observed, n: b.n }; }),
      independent_n: ind, sample: sampleState(ind), recalibration: sampleState(ind).recalibration,
      note: 'Measurement only: this compares EdgeDesk’s probabilities with what happened. It never moves a probability toward 50%, and no calibration is changed from it below ' + SAMPLE_STATES[2].min + ' observations.' };
  }

  /* ================================================================== CLV
     entry: {market_type, side, line, odds}; close: {line (side-stated) |
     home_line, odds, other_odds (the other side at the close)}.
     opts.coverAt(centerHomeMargin, side, line) → {win, push, loss}: the
     closing market's own distribution, for a price-equivalent CLV. */
  function clv(entry, close, opts) {
    entry = entry || {}; close = close || {}; opts = opts || {};
    var mt = entry.market_type || 'spread', side = entry.side, out = { points: null, price_pp: null, ev_at_close: null, basis: null };
    var dE = a2d(entry.odds);
    if (mt === 'moneyline') {
      var nv = isNum(num(close.odds)) && isNum(num(close.other_odds)) ? R().noVigTwoWay(close.odds, close.other_odds) : null;
      if (nv && dE) { out.price_pp = r(100 * (nv.a - 1 / dE), 3); out.ev_at_close = r(nv.a * dE - 1, 4); out.basis = 'no-vig closing probability vs the entry break-even'; }
      return out;
    }
    if (mt === 'total') {
      var ce = num(close.line), le = num(entry.line);
      if (isNum(ce) && isNum(le)) { out.points = r(side === 'under' ? le - ce : ce - le, 2); out.basis = 'points against the closing total'; }
      return out;
    }
    /* spread */
    var closeSide = num(close.line) != null ? num(close.line) : (num(close.home_line) != null ? (side === 'home' ? num(close.home_line) : -num(close.home_line)) : null);
    var le2 = num(entry.line);
    if (isNum(closeSide) && isNum(le2) && (side === 'home' || side === 'away')) {
      out.points = r(R().clvPoints(side, side === 'home' ? le2 : -le2, side === 'home' ? closeSide : -closeSide), 2);
      out.basis = 'points against the closing line';
      /* price-equivalent: what the entry was worth if the close is the truth */
      if (typeof opts.coverAt === 'function' && dE) {
        /* both numbers read off ONE distribution centred on the close, so a
           centring error cancels; the close is taken as a fair coin flip */
        var closeHome = side === 'home' ? closeSide : -closeSide, pE = null, pC = null;
        try { pE = opts.coverAt(-closeHome, side, le2); pC = opts.coverAt(-closeHome, side, closeSide); } catch (e) { pE = null; }
        var cv = function (p) { return p && isNum(p.win) && isNum(p.loss) && p.win + p.loss > 0 ? p.win / (p.win + p.loss) : null; };
        if (isNum(cv(pE)) && isNum(cv(pC))) {
          var gain = cv(pE) - cv(pC);
          out.price_pp = r(100 * gain, 3);
          out.ev_at_close = r(((0.5 + gain) * dE - 1) * (1 - (isNum(pE.push) ? pE.push : 0)), 4);
          out.basis = 'points; the number’s worth against the close in cover probability; the entry’s EV if the close was a fair coin flip';
        }
      } else if (Math.abs(closeSide - le2) < EPS && isNum(num(close.odds)) && isNum(num(close.other_odds))) {
        var cp = R().clvPrice(entry.odds, close.odds, close.other_odds, true);
        if (isNum(cp)) { out.price_pp = r(100 * cp, 3); out.basis = 'points, and the same-line no-vig closing price'; }
      }
    }
    return out;
  }

  /* ========================================================= EXPECTATIONS
     The decision classes and stake tiers should order themselves. They are
     judged only where the sample can say anything; a failure is a research
     alert for a person, never an automatic threshold change. */
  var EXPECT = { min_each: 50, tier_min_total: 50 };
  function expectations(rows, opts) {
    opts = opts || {};
    var modes = modesIn(rows);
    if (modes.length > 1) return { error: 'MIXED_MODES', modes: modes };
    var minEach = opts.min_each || EXPECT.min_each;
    var by = {};
    ['BET', 'LEAN', 'WATCH', 'PASS'].forEach(function (k) { by[k] = summarize((rows || []).filter(function (x) { return x.decision === k; })); });
    var alerts = [], checks = [];
    function metric(s) { return s.clv.n ? s.clv.mean : null; }
    function compare(hi, lo, what) {
      var a = by[hi], b = by[lo];
      var enough = a.independent_n >= minEach && b.independent_n >= minEach && a.clv.n >= minEach && b.clv.n >= minEach;
      var c = { check: hi + ' > ' + lo, metric: 'mean CLV (pts) and realized edge', n: [a.decided, b.decided], evaluated: enough, ok: null, text: null };
      if (!enough) { c.text = 'Not evaluated: ' + hi + ' n=' + a.decided + (a.independent_n < a.decided ? ' (' + a.independent_n + ' games)' : '') + ', ' + lo + ' n=' + b.decided
        + (b.independent_n < b.decided ? ' (' + b.independent_n + ' games)' : '') + ' (each needs ' + minEach + ' independent results).'; checks.push(c); return; }
      var clvOk = metric(a) > metric(b), edgeOk = !(isNum(a.realized_edge_pp) && isNum(b.realized_edge_pp)) || a.realized_edge_pp >= b.realized_edge_pp;
      c.ok = clvOk && edgeOk;
      c.text = hi + ' mean CLV ' + metric(a) + ' vs ' + lo + ' ' + metric(b) + '; realized edge ' + a.realized_edge_pp + ' vs ' + b.realized_edge_pp + ' pp';
      if (!c.ok) alerts.push({ code: 'CLASS_NOT_SEPARATING', severity: 'RESEARCH_ALERT', text: 'WARNING: ' + hi + ' is not ' + what + ' ' + lo + ' after ' + (a.decided + b.decided) + ' settled decisions.', note: 'This is a research alert, not an automatic change.' });
      checks.push(c);
    }
    compare('BET', 'LEAN', 'performing better than');
    compare('LEAN', 'PASS', 'looking stronger than');
    /* stake tiers */
    var tiers = ['0.25U', '0.50U', '0.75U', '1.00U'], T = {};
    tiers.forEach(function (t) { T[t] = summarize((rows || []).filter(function (x) { return x.decision === 'BET' && DIMENSIONS.unit_tier.of(x) === t; })); });
    for (var i = 1; i < tiers.length; i++) {
      var lo = T[tiers[i - 1]], hi = T[tiers[i]], tot = lo.decided + hi.decided;
      var c2 = { check: tiers[i] + ' > ' + tiers[i - 1], n: [hi.decided, lo.decided], evaluated: lo.independent_n + hi.independent_n >= EXPECT.tier_min_total && hi.independent_n >= 20 && lo.independent_n >= 20, ok: null };
      if (c2.evaluated) {
        c2.ok = metric(hi) > metric(lo);
        if (!c2.ok) alerts.push({ code: 'TIER_NOT_SEPARATING', severity: 'RESEARCH_ALERT', text: 'WARNING: ' + tiers[i] + ' BET tier is not separating from ' + tiers[i - 1] + ' tier after ' + tot + ' settled decisions.', note: 'This is a research alert, not an automatic change.' });
      } else c2.text = 'Not evaluated: ' + tiers[i] + ' n=' + hi.decided + ', ' + tiers[i - 1] + ' n=' + lo.decided + '.';
      checks.push(c2);
    }
    /* a class whose probabilities miss what happened beyond their interval */
    ['BET', 'LEAN', 'WATCH', 'PASS'].forEach(function (k) {
      var s = by[k];
      if (s.independent_n >= minEach && isNum(s.expected_cover) && s.observed_cover_interval && (s.expected_cover < s.observed_cover_interval.lo || s.expected_cover > s.observed_cover_interval.hi))
        alerts.push({ code: 'CALIBRATION_MISS', severity: 'RESEARCH_ALERT', text: 'WARNING: ' + k + ' expected cover ' + pctText(s.expected_cover) + ' lies outside the observed interval ' + pctText(s.observed_cover_interval.lo) + '–' + pctText(s.observed_cover_interval.hi) + ' (n=' + s.decided + ').', note: 'This is a research alert, not an automatic change.' });
    });
    return { mode: modes[0] || null, by_decision: by, by_tier: T, checks: checks, alerts: alerts,
      rule: 'Classes are compared only when each has ' + minEach + '+ settled decisions; tiers when the pair has ' + EXPECT.tier_min_total + '+ (20+ each). A failure is a research alert: thresholds are never rewritten from it.' };
  }

  /* ========================================================= LEAKAGE AUDIT */
  function leakageAudit(rows) {
    var v = [];
    (rows || []).forEach(function (x) {
      var ev = ms(x.evaluated_at), ko = ms(x.kickoff), qc = ms(x.quote_captured_at), ds = ms(x.data_snapshot_at), cc = ms(x.close_captured_at);
      function bad(code, text) { v.push({ id: x.id, game_id: x.game_id, mode: x.mode, code: code, text: text }); }
      if (x.mode === 'LIVE' || x.mode === 'LIVE_RECONSTRUCTED') {
        if (ev == null) bad('NO_EVALUATION_TIME', 'a live row with no evaluation time cannot prove it was pregame');
        else if (ko != null && ev >= ko) bad('POST_KICKOFF', 'evaluated at or after kickoff');
      }
      if (ev != null && qc != null && qc > ev + 5 * 60e3) bad('QUOTE_AFTER_EVALUATION', 'the evaluated quote was captured after the evaluation');
      if (ev != null && ds != null && ds > ev + 5 * 60e3) bad('INPUT_AFTER_EVALUATION', 'an input is newer than the evaluation');
      if (ev != null && cc != null && cc <= ev) bad('CLOSE_BEFORE_EVALUATION', 'the "closing" line was captured before the evaluation — it cannot be the close');
      if (x.mode === 'WALK_FORWARD' && x.trained_through != null && isNum(x.season) && Number(x.trained_through) >= x.season) bad('TRAINED_ON_TEST_SEASON', 'a walk-forward row was trained through its own season');
    });
    return { n: (rows || []).length, violations: v, ok: v.length === 0,
      rule: 'Every live row is decided before kickoff, on quotes and inputs captured no later than the evaluation; a close is captured after it; a walk-forward row never trains on its own season.' };
  }

  /* =============================================================== AUTOPSY
     For a large miss: the pregame record verbatim, the market around it, the
     result, and which of the pregame warnings were about exactly this. The
     final score is reported beside the reasoning, never folded into it. */
  var AUTOPSY = { NFL: 14, CFB: 21 };
  function autopsy(snap, grade, final, opts) {
    snap = snap || {}; grade = grade || {}; final = final || {}; opts = opts || {};
    var sport = upper(snap.sport) === 'NFL' ? 'NFL' : 'CFB';
    var fairHome = snap.distribution && isNum(num(snap.distribution.fair_home_margin)) ? num(snap.distribution.fair_home_margin) : (isNum(num(snap.model_fair_line)) && snap.side_key ? (snap.side_key === 'home' ? -snap.model_fair_line : snap.model_fair_line) : null);
    var fm = num(final.home_margin);
    var miss = isNum(fairHome) && isNum(fm) ? r(fm - fairHome, 2) : null;
    var large = isNum(miss) && Math.abs(miss) >= (opts.threshold || AUTOPSY[sport]);
    var q = snap.bet_price || snap.reference_quote || {};
    var clvPts = num(grade.clv_points);
    var p10 = snap.distribution ? num(snap.distribution.p10) : null, p90 = snap.distribution ? num(snap.distribution.p90) : null;
    var outside = isNum(p10) && isNum(p90) && isNum(fm) ? (fm < p10 || fm > p90) : null;
    var warned = (snap.warnings || []).filter(function (w) { return ['QB_UNCONFIRMED', 'QB_CONTESTED', 'AVAILABILITY_UNCERTAIN', 'PERSONNEL_LOW_CONFIDENCE', 'MODEL_MARKET_OUTLIER', 'LARGE_RATING_DIVERGENCE', 'SINGLE_BOOK', 'FCS_GAME', 'STABILITY_UNMEASURED'].indexOf(typeof w === 'string' ? w : w.code) >= 0; });
    return { schema: 'edgedesk_model_autopsy_v1', game_id: snap.game_id, sport: sport, large_miss: large, threshold_pts: opts.threshold || AUTOPSY[sport],
      pregame: { frozen_at: snap.frozen_at || snap.evaluated_at, decision: snap.decision, reason: snap.action_reason_text, selection: q.label || null, line: q.line, odds: q.odds,
        model_fair_home_margin: fairHome, model_interval_80: isNum(p10) && isNum(p90) ? [p10, p90] : null, probability: snap.probability, versions: { model: snap.model_version, calibration: snap.calibration_version, rules: snap.config_version } },
      market: { evaluated_line: q.line, consensus_line: snap.consensus_market_line, closing_line: num(grade.close_line), clv_points: clvPts,
        moved_against_edgedesk: isNum(clvPts) ? clvPts < 0 : null },
      result: { final_home_margin: fm, miss_pts: miss, outside_model_80pct_interval: outside },
      warnings_at_decision: warned.map(function (w) { return typeof w === 'string' ? w : w.code; }),
      uncertainty_flagged: warned.length > 0,
      findings: [
        isNum(miss) ? 'The final margin missed EdgeDesk’s number by ' + Math.abs(miss).toFixed(1) + ' pts' + (outside ? ', outside the model’s own 80% interval.' : (outside === false ? ', inside the model’s own 80% interval.' : '.')) : 'No final margin or model number to compare.',
        isNum(clvPts) ? (clvPts < 0 ? 'The market moved against EdgeDesk before kickoff (CLV ' + clvPts + ' pts).' : 'The market did not move against EdgeDesk before kickoff (CLV ' + clvPts + ' pts).') : 'No closing line recorded.',
        warned.length ? 'Pregame uncertainty flags that bore on this: ' + warned.map(function (w) { return typeof w === 'string' ? w : w.code; }).join(', ') + '.' : 'No pregame uncertainty flag anticipated a miss of this size.'
      ],
      rule: 'The pregame record is quoted as frozen. The result is reported beside it, never used to rewrite it.' };
  }

  /* ============================================================== REPORT
     Everything above for one set of rows, mode by mode. */
  function report(rows, opts) {
    opts = opts || {};
    var dims = opts.dimensions || Object.keys(DIMENSIONS).filter(function (k) { return k !== 'mode'; });
    var by = {};
    (rows || []).forEach(function (x) { (by[x.mode || 'UNLABELLED'] = by[x.mode || 'UNLABELLED'] || []).push(x); });
    var modes = {};
    Object.keys(by).sort(function (a, b) { return ((MODES[a] || {}).rank || 0) - ((MODES[b] || {}).rank || 0); }).forEach(function (m) {
      var R0 = by[m];
      var segs = {};
      dims.forEach(function (d) { var s = segment(R0, d, opts); segs[d] = s.modes[m] ? s.modes[m] : { buckets: [], not_measured: 0 }; });
      modes[m] = { mode: m, label: MODES[m] ? MODES[m].label : m, text: MODES[m] ? MODES[m].text : null, all: summarize(R0), calibration: calibration(R0),
        expectations: expectations(R0), segments: segs, leakage: leakageAudit(R0) };
    });
    return { schema: 'edgedesk_validation_report_v1', engine: VERSION, n: (rows || []).length, modes: modes, maturity: MATURITY,
      sample_states: SAMPLE_STATES.map(function (s) { return { key: s.key, min: s.min, label: s.label }; }),
      rule: 'Every figure carries its n and sample state; modes are never blended; nothing here changes a threshold or a calibration.' };
  }

  return { VERSION: VERSION, MODES: MODES, MATURITY: MATURITY, SAMPLE_STATES: SAMPLE_STATES, DIMENSIONS: DIMENSIONS, CAL_EDGES: CAL_EDGES, EXPECT: EXPECT, AUTOPSY: AUTOPSY,
    modeOf: modeOf, sampleState: sampleState, independentN: independentN, withN: withN, row: row, fromDecision: fromDecision, fromDecisionEvaluation: fromDecisionEvaluation, fromLabEvaluation: fromLabEvaluation, keyExposure: keyExposure,
    summarize: summarize, segment: segment, calibration: calibration, clv: clv, clvSummary: clvSummary, expectations: expectations, leakageAudit: leakageAudit,
    autopsy: autopsy, report: report };
}));

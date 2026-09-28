/* ===========================================================================
   EDGEDESK EXPLAIN — the decision, said plainly, from the decision itself.
   docs/bettor-decision/QUALITY_UPGRADE.md §4

   Every function here reads ONE canonical decision object
   (lib/edgedesk_decision.js) and returns words and small structures. Nothing
   here decides anything, prices anything or reads a result: a surface that
   needs a sentence asks this file, so the board, the card, the share card and
   the exports can never say different things about one game.

     oneLine(d)            the one-sentence answer, deterministic per state
     mainRisk(d)           the single most important warning
     gates(d)              the decision's gates, explicitly: evaluable, market
                           verified, quote fresh, price, probability source,
                           reliability, QB, availability, market quality,
                           confidence, sizing — PASS / CAP / FAIL / BLOCK
     whyNot(d)             WHY ISN'T THIS A BET? (and, for a BET, what caps it)
     whatChanges(d)        WHAT CHANGES MY MIND? price, QB, availability,
                           model, market
     reliabilityBreakdown  the reliability score's own measured components
     sensitivity(d)        break-the-number: how far EdgeDesk's number can
                           move before the edge disappears, against the
                           measured uncertainty of its inputs
     scenarios(d)          base / conservative / aggressive (sensitivity,
                           never a forecast)
     provenance(d)         source, last updated, pricing impact
     watchRow(d, track)    a watchlist row that behaves like a research queue
     alerts(prev, next)    meaningful state changes only — never spam

   RULES
     - A sentence reflects the actual state and names the actual numbers.
     - Missing is said: "not measured for this game", never a made-up value.
     - Confidence and reliability are never presented as win probabilities.

   Browser: window.EDExplain. Node: require('./edgedesk_explain.js'). ES5.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDExplain = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_explain_v1';
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 2 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pct(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function pp(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + ' pp' : '—'; }
  function pts(x) { return isNum(x) ? (Math.round(Math.abs(x) * 10) / 10).toString() + (Math.abs(Math.abs(x) - 1) < EPS ? ' pt' : ' pts') : '—'; }
  function units(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }
  function cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function has(list, code) { return (list || []).some(function (x) { return (x && x.code ? x.code : x) === code; }); }
  function ago(t, now) { var a = ms(t), n = ms(now) || Date.now(); if (a == null) return null; var m = Math.max(0, Math.round((n - a) / 60000)); return m < 60 ? m + 'm ago' : (m < 48 * 60 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'); }

  /* the quote the decision reads, and how a bettor names it */
  function sel(d) { if (!d) return null; return d.decision === 'BET' ? d.bet_price : (d.reference_quote || d.bet_price || null); }
  function pickOf(d, line) {
    var q = sel(d); if (!q) return null;
    var mt = q.market_type || d.market_type, side = String(q.side || '');
    var L = line != null ? line : q.line;
    if (mt === 'total') return side.charAt(0).toUpperCase() + side.slice(1) + ' ' + (isNum(L) ? String(Math.round(L * 10) / 10) : '—');
    if (mt === 'moneyline') return (q.team || d.side || side) + ' ML';
    return (q.team || d.side || side) + ' ' + lineText(L);
  }
  function evName(d) { return d.probability_source === 'model_estimated' ? 'EV (model-estimated)' : 'calibrated EV'; }
  function evValue(d) { return d.probability_source === 'model_estimated' || !isNum(d.calibrated_ev_pct) ? d.decision_ev_pct : d.calibrated_ev_pct; }
  function trigShort(d) {
    var t = d.bet_trigger;
    if (!t) return null;
    if (isNum(t.line_needed)) return lineText(t.line_needed) + (isNum(t.price_needed_at_current_line) ? '' : '');
    if (isNum(t.price_needed_at_current_line)) return priceText(t.price_needed_at_current_line) + ' at ' + lineText(sel(d) ? sel(d).line : null);
    return null;
  }
  function teamOfGap(d) { var C = d.canonical || {}; return C.gap_toward_team || null; }

  /* ============================================================ ONE LINE */
  var NO_PRICE = ['STALE_QUOTE', 'NO_MARKET', 'FRESHNESS_UNKNOWN', 'MARKET_SUSPENDED', 'NO_VALID_QUOTE'];
  var BAD_DATA = ['ORIENTATION_FAULT', 'CORRUPTED_ODDS', 'DATA_FAULT', 'IMPOSSIBLE_PROBABILITY', 'MALFORMED_PROJECTION', 'SELF_CHECK_FAILED', 'MAPPING_FAILED', 'DUPLICATE_GAME', 'INVALID_GAME'];
  function oneLine(d) {
    if (!d) return '';
    var q = sel(d), pick = pickOf(d), price = q ? priceText(q.odds) : null, code = d.action_reason_code;
    if (d.decision === 'NO_DECISION') {
      if (NO_PRICE.indexOf(code) >= 0) return 'No current market quote is reliable enough to price.';
      if (code === 'GAME_STARTED') return 'The game has started: pregame decisions are closed.';
      if (code === 'MODEL_UNAVAILABLE' || code === 'DISTRIBUTION_MISSING' || code === 'MODEL_VERSION_UNKNOWN') return 'EdgeDesk has no projection it can price for this market.';
      if (BAD_DATA.indexOf(code) >= 0) return 'The market or game data failed an integrity check, so EdgeDesk will not price it until it is explained.';
      if (code === 'QB_PROJECTION_INVALID') return 'The projection assumes a quarterback who will not start; it is re-run before EdgeDesk prices anything.';
      if (code === 'GAME_CANCELLED' || code === 'GAME_POSTPONED' || code === 'GAME_SUSPENDED') return d.action_reason_text;
      return d.action_reason_text || 'EdgeDesk cannot evaluate this wager.';
    }
    if (d.decision === 'BET') return pick + ' at ' + price + ' clears EdgeDesk’s current threshold with ' + pct(evValue(d)) + ' ' + evName(d) + '.';
    if (d.decision === 'LEAN') {
      if (code === 'LEAN_EDGE') return pick + ' at ' + price + ' shows a positive edge (' + pp(d.edge_pp) + ') but sits below EdgeDesk’s betting threshold.';
      var cp = (d.caps || []).filter(function (c) { return c.code === code; })[0];
      return pick + ' at ' + price + ' clears the price thresholds, but ' + String(cp && cp.text ? cp.text : d.action_reason_text).replace(/^The price clears the thresholds, but /, '').replace(/^[A-Z]/, function (c) { return c.toLowerCase(); }).replace(/\.$/, '') + '.';
    }
    if (d.decision === 'WATCH') {
      if (code === 'NEAR_THRESHOLD') { var ts = trigShort(d); return pick + ' is close, but EdgeDesk wants ' + (ts || 'a better number') + ' or a better price.'; }
      if (code === 'MODEL_MARKET_DISAGREEMENT') return 'EdgeDesk disagrees with the market by ' + pts(d.canonical && d.canonical.gap_pts) + ', but ' + pick + ' at ' + price + ' does not pay for it yet.';
      if (code === 'PRICE_ANOMALY') return pick + ' at ' + price + (q && q.book ? ' (' + q.book + ')' : '') + ' looks off the market; EdgeDesk will not bet it until the price is verified.';
      if (code === 'QB_UNRESOLVED' || code === 'QB_UNKNOWN') return pick + ' ' + (d.bet_trigger && d.bet_trigger.already_clears ? 'qualifies on price' : 'is interesting') + ', but EdgeDesk is waiting on the starting quarterback.';
      if (code === 'AVAILABILITY_PENDING') return pick + ' ' + (d.bet_trigger && d.bet_trigger.already_clears ? 'qualifies on price' : 'is interesting') + ', but a material availability update is pending.';
      return pick + ' is on EdgeDesk’s watch list: ' + String(d.action_reason_text || '').replace(/^[A-Z]/, function (c) { return c.toLowerCase(); });
    }
    /* PASS */
    if (code === 'CALIBRATED_EV_NEGATIVE') return 'The model likes ' + (q && q.team ? q.team : 'this side') + ' more than the market, but calibration removes the apparent edge.';
    if (code === 'MARKET_ALIGNED') return 'EdgeDesk’s number and the market agree' + (d.model_fair_text && d.consensus_text ? ' (' + d.model_fair_text + ' vs ' + d.consensus_text + ')' : '') + ': there is nothing to bet.';
    if (code === 'JUICE_CONSUMES_EDGE') return pick + ' has value on the number, but at ' + price + ' the juice consumes it.';
    if (code === 'NO_MODEL_EDGE') return 'EdgeDesk does not favour either side at the current prices.';
    if (code === 'EDGE_TOO_SMALL') return pick + ' at ' + price + ' shows a small edge (' + pp(d.edge_pp) + '), too small to act on or to watch.';
    if (code === 'PRICE_MOVED') return 'The price moved past EdgeDesk’s playable threshold: ' + pick + ' is now ' + price + '.';
    if (code === 'PROJECTION_CHANGED') return 'New information moved EdgeDesk’s number, and ' + pick + ' at ' + price + ' no longer qualifies.';
    return d.action_reason_text || '';
  }

  /* ============================================================ MAIN RISK */
  function warn(d, code) { return has(d.warnings, code) ? (d.warnings.filter(function (w) { return w.code === code; })[0] || {}).text : null; }
  function mainRisk(d) {
    if (!d) return null;
    if (d.decision === 'NO_DECISION') return { code: (d.blocker_codes || [])[0] || 'NOT_EVALUABLE', text: d.action_reason_text };
    var M = d.market || {}, caps = d.caps || [];
    var list = [
      [d.anomaly && d.anomaly.open, 'PRICE_UNVERIFIED', function () { return M.anomaly ? M.anomaly.text : 'The price has not passed verification.'; }],
      [has(caps, 'QB_UNRESOLVED') || has(caps, 'QB_UNKNOWN'), 'QB', function () { var c = caps.filter(function (x) { return x.code === 'QB_UNRESOLVED' || x.code === 'QB_UNKNOWN'; })[0]; return c.text; }],
      [has(caps, 'AVAILABILITY_PENDING'), 'AVAILABILITY', function () { return caps.filter(function (x) { return x.code === 'AVAILABILITY_PENDING'; })[0].text; }],
      [has(d.warnings, 'QB_CONTESTED'), 'QB_CONTESTED', function () { return warn(d, 'QB_CONTESTED'); }],
      [has(d.warnings, 'QB_UNCONFIRMED'), 'QB_UNCONFIRMED', function () { return warn(d, 'QB_UNCONFIRMED'); }],
      [M.verification_status === 'OUTLIER' || M.verification_status === 'UNRESOLVED', 'MARKET_DISAGREEMENT', function () { return M.verification_text; }],
      [has(d.warnings, 'MODEL_MARKET_OUTLIER'), 'MODEL_MARKET_OUTLIER', function () { return warn(d, 'MODEL_MARKET_OUTLIER'); }],
      [has(d.warnings, 'LARGE_RATING_DIVERGENCE'), 'RATING_DIVERGENCE', function () { return warn(d, 'LARGE_RATING_DIVERGENCE'); }],
      [has(d.warnings, 'AVAILABILITY_UNCERTAIN') || has(d.warnings, 'PERSONNEL_LOW_CONFIDENCE'), 'AVAILABILITY_DATA', function () { return warn(d, 'AVAILABILITY_UNCERTAIN') || warn(d, 'PERSONNEL_LOW_CONFIDENCE'); }],
      [M.verification_status === 'SINGLE_SOURCE' || d.market_quality === 'THIN' || d.market_quality === 'ACCEPTABLE', 'THIN_MARKET', function () { return M.verification_text ? cap1(M.verification_text) + '.' : 'Only one fresh book prices both sides of this number.'; }],
      [isNum(d.reliability_score) && d.reliability_score < 60, 'LOW_RELIABILITY', function () { return 'Data reliability is ' + Math.round(d.reliability_score) + ' (a data-quality measure, not a win probability).'; }],
      [has(d.warnings, 'ALT_LINE_TAIL'), 'ALT_TAIL', function () { return 'The selected quote is an alternate line outside the validated tail.'; }],
      [d.probability_source === 'model_estimated', 'MODEL_ESTIMATED', function () { return 'The probability is model-estimated: no calibration exists for this market yet, so the stake is capped.'; }],
      [d.probability_source === 'partially_calibrated', 'CALIBRATION_PARTIAL', function () { return 'The calibration is validated out of sample, not yet on live results.'; }],
      [M.freshness === 'AGING', 'QUOTE_AGING', function () { return 'The quote is ' + (M.freshness_text || 'aging') + ': confirm it before acting.'; }]
    ];
    for (var i = 0; i < list.length; i++) if (list[i][0]) return { code: list[i][1], text: list[i][2]() };
    return { code: 'RULES_UNVALIDATED', text: 'EdgeDesk’s thresholds are conservative defaults, not yet validated on live results.' };
  }

  /* ================================================================ GATES
     The gates the engine applied, made explicit. PASS · CAP (limits the class
     or the stake) · FAIL (the price does not clear) · BLOCK (not evaluable) ·
     UNKNOWN (not measured: lowers confidence, never blocks). */
  function gates(d) {
    if (!d) return [];
    var M = d.market || {}, caps = d.caps || [], out = [];
    function g(key, label, status, effect, text) { out.push({ key: key, label: label, status: status, effect: effect || null, text: text || null, binding: false }); }
    var ev = d.evaluation_status === 'EVALUABLE';
    g('EVALUABLE', 'Can it be evaluated?', ev ? 'PASS' : 'BLOCK', ev ? null : 'NO DECISION', ev ? 'Game, model, orientation and a priced current quote are all valid.' : d.action_reason_text);
    if (!ev) { out[0].binding = true; return out; }
    var vs = M.verification_status;
    g('MARKET_VERIFIED', 'Market verified', !vs ? 'UNKNOWN' : (vs === 'VERIFIED' || vs === 'CORROBORATED' ? 'PASS' : (vs === 'STALE' ? 'BLOCK' : 'CAP')),
      vs === 'OUTLIER' || vs === 'UNRESOLVED' ? 'WATCH until verified' : (vs === 'SINGLE_SOURCE' ? 'stake ≤ 0.50U' : null), M.verification_text || 'not measured');
    g('QUOTE_FRESH', 'Quote fresh', M.freshness === 'FRESH' ? 'PASS' : (M.freshness === 'AGING' ? 'PASS' : (M.freshness === 'STALE' ? 'BLOCK' : 'UNKNOWN')), null, M.freshness_text || null);
    var bet = { edge: 4, ev: 5 };
    var priceOk = isNum(d.edge_pp) && isNum(d.decision_ev_pct) && d.edge_pp >= bet.edge - 1e-7 && d.decision_ev_pct >= bet.ev - 1e-6;
    g('PRICE', 'Price clears the BET threshold', priceOk ? 'PASS' : 'FAIL', priceOk ? null : 'not a BET at this price',
      'edge ' + pp(d.edge_pp) + ' (needs +4.0 pp) · ' + evName(d) + ' ' + pct(evValue(d)) + ' (needs +5.0%)');
    var src = d.probability_source;
    g('PROBABILITY_SOURCE', 'Probability source', src === 'calibrated' ? 'PASS' : 'CAP', src === 'calibrated' ? null : 'stake ≤ ' + (src === 'partially_calibrated' ? '0.50U' : '0.25U'), d.probability_source_label || null);
    var rel = d.reliability_score;
    g('RELIABILITY', 'Data reliability', !isNum(rel) ? 'UNKNOWN' : (rel >= 60 ? 'PASS' : 'CAP'), isNum(rel) && rel < 60 ? 'LEAN at most' : null,
      isNum(rel) ? Math.round(rel) + '/100 (data quality, not a win probability)' : 'not measured for this game');
    var qbCap = caps.filter(function (c) { return c.code === 'QB_UNRESOLVED' || c.code === 'QB_UNKNOWN'; })[0];
    g('QB', 'Quarterback certainty', qbCap ? 'CAP' : 'PASS', qbCap ? 'WATCH at most' : null, qbCap ? qbCap.text : (has(d.warnings, 'QB_UNCONFIRMED') ? warn(d, 'QB_UNCONFIRMED') : 'resolved'));
    var avCap = caps.filter(function (c) { return c.code === 'AVAILABILITY_PENDING'; })[0];
    g('AVAILABILITY', 'Availability certainty', avCap ? 'CAP' : (has(d.warnings, 'PERSONNEL_LOW_CONFIDENCE') ? 'UNKNOWN' : 'PASS'), avCap ? 'WATCH at most' : null,
      avCap ? avCap.text : (warn(d, 'PERSONNEL_LOW_CONFIDENCE') || warn(d, 'AVAILABILITY_UNCERTAIN') || 'no material update pending'));
    var mq = d.market_quality;
    g('MARKET_QUALITY', 'Market depth', mq === 'THIN' ? 'CAP' : (mq === 'ACCEPTABLE' ? 'CAP' : (mq ? 'PASS' : 'UNKNOWN')), mq === 'THIN' ? 'LEAN at most' : (mq === 'ACCEPTABLE' ? 'stake ≤ 0.50U' : null), mq || null);
    var dc = d.decision_confidence;
    g('DECISION_CONFIDENCE', 'Decision confidence', !isNum(dc) ? 'UNKNOWN' : (dc >= 40 ? 'PASS' : 'CAP'), isNum(dc) && dc < 40 ? 'LEAN at most' : null, isNum(dc) ? dc + '/100 · ' + (d.decision_confidence_label || '') + ' (not a win probability)' : null);
    if (d.anomaly && d.anomaly.open) g('PRICE_VERIFICATION', 'Price verification', 'CAP', 'WATCH until verified', (d.anomaly.triggers || []).map(function (t) { return t.text; }).join(' · '));
    if (d.decision === 'BET' && d.sizing) g('SIZING', 'Stake', 'PASS', units(d.recommended_units), (d.sizing.caps || []).length ? 'capped by ' + d.sizing.caps.join('; ') : 'no cap below the signal tier');
    /* the gate that actually bound the decision */
    var code = d.action_reason_code, bindKey = { PRICE_ANOMALY: 'PRICE_VERIFICATION', QB_UNRESOLVED: 'QB', QB_UNKNOWN: 'QB', AVAILABILITY_PENDING: 'AVAILABILITY', THIN_MARKET: 'MARKET_QUALITY',
      LOW_DECISION_CONFIDENCE: 'DECISION_CONFIDENCE', LOW_RELIABILITY: 'RELIABILITY' }[code] || (d.decision !== 'BET' ? 'PRICE' : null);
    out.forEach(function (x) { if (x.key === bindKey) x.binding = true; });
    return out;
  }

  /* ============================================================= WHY NOT */
  function whyNot(d) {
    if (!d) return null;
    var code = d.action_reason_code, q = sel(d), out = { decision: d.decision, headline: null, reasons: [], gates: gates(d) };
    function add(c, t) { out.reasons.push({ code: c, text: t }); }
    if (d.decision === 'BET') {
      out.headline = 'BET: the current price clears every gate';
      var cs = d.sizing && d.sizing.caps || [];
      if (cs.length) add('SIZE_CAPPED', 'The stake is ' + units(d.recommended_units) + ' because of: ' + cs.join('; ') + '.');
      return out;
    }
    if (d.decision === 'NO_DECISION') {
      var nd = NO_PRICE.indexOf(code) >= 0 ? 'no fresh market' : (BAD_DATA.indexOf(code) >= 0 ? 'the data failed an integrity check' : String(d.action_reason_text || '').replace(/\.$/, '').toLowerCase());
      out.headline = 'NO DECISION because ' + nd;
      (d.blockers || []).forEach(function (b) { add(b.code, b.text); });
      return out;
    }
    var marketFault = d.anomaly && d.anomaly.open && (d.anomaly.triggers || []).some(function (t) { return t.code === 'QUOTE_OUTLIER' || t.code === 'MARKET_FAULT' || t.code === 'BOOK_DISPERSION' || t.code === 'INCONSISTENT_QUOTES'; });
    if (marketFault) {
      /* one meaning per state: MARKET FAULT is the market state (EDVocab); one
         off-market book inside a live market is a price anomaly on the quote,
         so the headline leads with the decision instead */
      var faultState = d.market_state ? d.market_state.key === 'MARKET_FAULT' : true;
      out.headline = (faultState ? 'MARKET FAULT' : (d.decision === 'WAIT' ? 'WATCH' : String(d.decision || 'WATCH').replace(/_/g, ' '))) + ' because the quote is inconsistent with the consensus';
      (d.anomaly.triggers || []).forEach(function (t) { add(t.code, t.text); });
      return out;
    }
    var t = d.bet_trigger;
    var short = t && isNum(t.line_move_pts) ? 'the price is ' + pts(t.line_move_pts) + ' short' : (t && isNum(t.price_move_cents) ? 'the price is ' + Math.round(t.price_move_cents) + ' cents short' : null);
    if (d.decision === 'WATCH') {
      if (code === 'NEAR_THRESHOLD') out.headline = 'WATCH because ' + (short || 'the price is near, not at, the threshold');
      else if (code === 'MODEL_MARKET_DISAGREEMENT') out.headline = 'WATCH because the model–market disagreement is real but the price does not pay for it yet';
      else if (code === 'QB_UNRESOLVED' || code === 'QB_UNKNOWN') out.headline = 'WATCH because the starting quarterback is unresolved';
      else if (code === 'AVAILABILITY_PENDING') out.headline = 'WATCH because a material availability update is pending';
      else if (code === 'PRICE_ANOMALY') out.headline = 'WATCH because the price has not passed verification';
      else out.headline = 'WATCH because ' + String(d.action_reason_text || '').replace(/\.$/, '').replace(/^[A-Z]/, function (c) { return c.toLowerCase(); });
    } else if (d.decision === 'LEAN') {
      out.headline = code === 'LEAN_EDGE' ? 'LEAN because the edge is positive but under the betting threshold' : 'LEAN because ' + String(d.action_reason_text || '').replace(/\.$/, '').replace(/^[A-Z]/, function (c) { return c.toLowerCase(); });
    } else {
      var P = { CALIBRATED_EV_NEGATIVE: 'calibration removes the raw edge (calibrated EV too low)', MARKET_ALIGNED: 'EdgeDesk and the market agree', JUICE_CONSUMES_EDGE: 'the juice consumes the value in the number',
        NO_MODEL_EDGE: 'there is no model edge at any available price', EDGE_TOO_SMALL: 'the edge is too small to act on or to watch', PRICE_MOVED: 'the price moved past the playable threshold',
        PROJECTION_CHANGED: 'new information changed the projection' };
      out.headline = 'PASS because ' + (P[code] || String(d.action_reason_text || '').replace(/\.$/, '').toLowerCase());
    }
    out.gates.forEach(function (x) { if (x.status === 'FAIL' || x.status === 'CAP' || x.status === 'BLOCK') add(x.key, x.label + ': ' + (x.effect ? x.effect + ' — ' : '') + (x.text || '')); });
    if (t && t.text && !t.already_clears) add('BET_TRIGGER', t.text);
    return out;
  }

  /* ================================================== WHAT CHANGES MY MIND */
  function whatChanges(d) {
    if (!d) return null;
    var caps = d.caps || [], q = sel(d), out = {};
    /* PRICE */
    if (d.decision === 'BET') out.price = { would_change: true, text: d.playable && d.playable.mode === 'RANGE' ? 'Stops being a BET worse than ' + d.playable.short + ' (' + d.playable.text + ').' : 'Stops being a BET at any worse line or price than ' + pickOf(d) + ' (' + priceText(q && q.odds) + ').' };
    else if (d.decision === 'NO_DECISION') out.price = { would_change: null, text: 'A fresh, verified quote would let EdgeDesk evaluate it.' };
    else if (d.ladder && d.ladder.first_bet) out.price = { would_change: true, text: 'Becomes BET at ' + d.ladder.first_bet.label + ' (' + d.ladder.first_bet.state + '), if the rest of the market stays where it is.' };
    else if (d.bet_trigger && d.bet_trigger.already_clears) out.price = { would_change: false, text: 'The price already clears; it is not what holds this back.' };
    else if (d.bet_trigger && d.bet_trigger.short) out.price = { would_change: true, text: 'Becomes BET at ' + d.bet_trigger.short + '.' };
    else out.price = { would_change: false, text: 'No nearby price makes this a BET.' };
    /* QB */
    var qbCap = caps.filter(function (c) { return c.code === 'QB_UNRESOLVED' || c.code === 'QB_UNKNOWN'; })[0];
    out.qb = qbCap ? { would_change: true, text: 'Yes: confirming the starting quarterback lifts the WATCH cap' + (d.bet_trigger && d.bet_trigger.already_clears ? ', and the price already qualifies.' : '.') }
      : { would_change: null, text: has(d.warnings, 'QB_UNCONFIRMED') ? 'A starter is expected but not confirmed; a different starter would re-run the projection.' : 'The quarterbacks are resolved; a late change would re-run the projection.' };
    /* AVAILABILITY */
    var avCap = caps.filter(function (c) { return c.code === 'AVAILABILITY_PENDING'; })[0];
    out.availability = avCap ? { would_change: true, text: 'Yes: the pending availability update lifts or confirms the WATCH cap.' }
      : { would_change: null, text: has(d.warnings, 'PERSONNEL_LOW_CONFIDENCE') ? 'Availability is not loaded for this game: a material report could move the number (research context unless it reaches the priced terms).' : 'No material availability update is pending.' };
    /* MODEL */
    var S = sensitivity(d);
    out.model = S && S.available ? { would_change: true, text: S.text } : { would_change: null, text: S && S.reason ? S.reason : 'Not measured for this market.' };
    /* MARKET */
    var M = d.market || {};
    if (M.verification_status === 'OUTLIER' || M.verification_status === 'UNRESOLVED') out.market = { would_change: true, text: 'Yes: the rest of the market confirming this number would clear the price anomaly.' };
    else if (M.verification_status === 'SINGLE_SOURCE') out.market = { would_change: true, text: 'Broader consensus confirmation would lift the single-book stake cap.' };
    else out.market = { would_change: null, text: 'If the consensus itself moves, EdgeDesk re-prices every number' + (d.decision === 'BET' ? '; the playable range assumes it holds.' : '.') };
    return out;
  }

  /* ============================================== RELIABILITY BREAKDOWN
     The score and its OWN measured components — never invented ones. */
  function reliabilityBreakdown(d) {
    var R = d && d.context && d.context.reliability;
    var score = d ? d.reliability_score : null;
    if (!R || !(R.components || []).length) return { available: false, score: score, label: d ? d.reliability_label : null,
      text: isNum(score) ? 'RELIABILITY ' + Math.round(score) + (d.reliability_label ? ' · ' + d.reliability_label : '') + ' — its components are not published for this game.' : 'Reliability is not measured for this game.' };
    return { available: true, score: num(R.score) != null ? num(R.score) : score, label: R.grade || (d && d.reliability_label) || null,
      headline: 'RELIABILITY ' + (isNum(num(R.score)) ? Math.round(num(R.score)) : '—') + (R.grade ? ' · ' + R.grade : ''),
      components: R.components.map(function (c) { return { key: c.key, label: c.label, value: c.value, unit: c.unit, detail: c.detail, text: c.label + ' ' + (c.value == null ? '—' : c.value + (c.unit === '%' ? '%' : (c.unit ? ' ' + c.unit : ''))) }; }),
      main_deduction: R.main_deduction || null, next_actions: R.next_actions || [],
      note: 'Reliability measures data quality and freshness. It is not a win probability.' };
  }

  /* ========================================================= SENSITIVITY
     BREAK THE NUMBER. From the decision's own price curve (the current price,
     every nearby line): how far can EdgeDesk's number move against the side
     before the edge — and before the BET — disappears? A move in EdgeDesk's
     number is read as the same move in the line (the outcome distribution
     translates). Set against the MEASURED uncertainty of the inputs when the
     terminal published it; said to be unmeasured when it did not. */
  function lineAxis(d) {
    var C = d && d.price_curve;
    if (!C || !(C.points || []).length || C.market_type !== 'spread' || !isNum(C.odds)) return null;
    return C.points.filter(function (p) { return p.odds === C.odds && isNum(p.line) && isNum(p.ev); }).sort(function (a, b) { return a.line - b.line; });
  }
  function crossing(rows, L0, pred) {
    /* the worst line (fewest points) at or below L0 from which pred holds all the way up to L0 */
    var at = rows.filter(function (p) { return p.line <= L0 + EPS; });
    var last = null;
    for (var i = at.length - 1; i >= 0; i--) { if (pred(at[i])) last = at[i]; else return { edge: last, first_fail: at[i] }; }
    return { edge: last, first_fail: null };
  }
  function sensitivity(d) {
    if (!d || d.decision === 'NO_DECISION') return { available: false, reason: 'Nothing to perturb: EdgeDesk could not evaluate this wager.' };
    var rows = lineAxis(d), q = sel(d);
    if (!rows || !q) return { available: false, reason: 'Break-the-number is measured for spreads with a priced curve.' };
    var L0 = q.line, team = q.team || d.side || q.side;
    var cur = rows.filter(function (p) { return Math.abs(p.line - L0) < EPS; })[0];
    if (!cur) return { available: false, reason: 'The current line is not on the priced curve.' };
    var out = { available: true, side: q.side, team: team, current_line: L0, price: q.odds, fair_line: d.model_fair_line, market_line: d.consensus_market_line,
      gap_toward_side: d.canonical && isNum(d.canonical.gap_toward_home_pts) ? (q.side === 'home' ? d.canonical.gap_toward_home_pts : -d.canonical.gap_toward_home_pts) : null,
      edge_cushion_pts: null, bet_cushion_pts: null, drivers: [], joint_sd: null, verdict: null, text: null,
      assumption: 'A move in EdgeDesk’s number is read as the same move in the line: the outcome distribution translates.' };
    if (cur.ev > EPS) {
      var ce = crossing(rows, L0, function (p) { return p.ev > EPS; });
      if (ce.first_fail) {
        var a = ce.first_fail, b = ce.edge;
        var zero = a.line + (b.line - a.line) * (0 - a.ev) / ((b.ev - a.ev) || 1e-9);
        out.edge_cushion_pts = r(L0 - zero, 2);
      } else { out.edge_cushion_pts = r(L0 - rows[0].line, 2); out.edge_cushion_floor = true; }
      if (cur.cls === 'BET') {
        /* on the half-point grid: the BET holds down to cb.edge and is lost at cb.first_fail */
        var cb = crossing(rows, L0, function (p) { return p.cls === 'BET'; });
        out.bet_cushion_pts = cb.first_fail ? r(L0 - cb.first_fail.line, 2) : r(L0 - rows[0].line, 2);
        out.bet_holds_to = cb.edge ? cb.edge.line : L0;
      }
    } else {
      var up = rows.filter(function (p) { return p.line > L0 + EPS && p.ev > EPS; })[0];
      out.edge_needs_pts = up ? r(up.line - L0, 2) : null;
    }
    var C = d.context || {};
    out.drivers = (C.sensitivity_drivers || []).map(function (x) { return { key: x.key, label: x.label, sd: r(x.sd, 2), basis: x.basis || null, sds_to_break: isNum(out.edge_cushion_pts) && x.sd > 0 ? r(out.edge_cushion_pts / x.sd, 2) : null }; })
      .sort(function (a, b) { return b.sd - a.sd; });
    if (isNum(num(C.joint_sd))) { out.joint_sd = r(num(C.joint_sd), 2); out.joint_basis = C.joint_basis || 'all measured dimensions jointly'; }
    else if (out.drivers.length) { out.joint_sd = r(Math.sqrt(out.drivers.reduce(function (s, x) { return s + x.sd * x.sd; }, 0)), 2); out.joint_basis = 'root-sum-square of the measured dimensions, assuming they are independent'; }
    var cushion = out.edge_cushion_pts;
    if (!isNum(cushion)) { out.verdict = 'NO_EDGE'; out.text = isNum(out.edge_needs_pts) ? 'There is no edge at this price; EdgeDesk’s number would have to be ' + pts(out.edge_needs_pts) + ' more favourable to ' + team + ' for one to appear.' : 'There is no edge at this price within the curve.'; return out; }
    var atLeast = out.edge_cushion_floor ? 'at least ' : '';
    if (isNum(out.joint_sd)) {
      var cons = 1.28 * out.joint_sd;
      out.verdict = cushion >= cons - EPS ? 'SURVIVES_CONSERVATIVE' : (cushion < out.joint_sd ? 'FRAGILE' : 'MODERATE');
      out.text = out.verdict === 'SURVIVES_CONSERVATIVE' ? 'Even under conservative perturbations (1.28 SD of the measured inputs, ' + pts(cons) + '), the edge survives: EdgeDesk’s number can move ' + atLeast + pts(cushion) + ' against ' + team + ' before it disappears.'
        : (out.verdict === 'FRAGILE' ? 'The disagreement disappears under plausible assumptions: a 1-SD error in the measured inputs (' + pts(out.joint_sd) + ') is larger than the ' + pts(cushion) + ' cushion.'
          : 'The edge survives a 1-SD error in the measured inputs (' + pts(out.joint_sd) + ') but not a conservative one: the cushion is ' + pts(cushion) + '.');
      if (out.drivers.length) out.largest_driver = out.drivers[0];
    } else {
      out.verdict = 'UNMEASURED_INPUTS';
      out.text = 'EdgeDesk’s number can move ' + atLeast + pts(cushion) + ' against ' + team + ' before the edge disappears. No measured input uncertainty is published for this game, so EdgeDesk does not say how plausible that is.';
    }
    if (isNum(out.bet_cushion_pts) && d.decision === 'BET') out.text += ' The BET itself is lost once the number moves ' + pts(out.bet_cushion_pts) + ' (it holds to ' + lineText(out.bet_holds_to) + ').';
    return out;
  }

  /* ============================================================ SCENARIOS
     Base / conservative / aggressive: EdgeDesk's number moved one measured
     SD against and toward its position. Sensitivity analysis, not a forecast. */
  function scenarios(d) {
    var S = sensitivity(d);
    if (!S || !S.available || !isNum(S.joint_sd) || !isNum(S.fair_line)) return { available: false, reason: S && !S.available ? S.reason : 'No measured input uncertainty is published for this game: EdgeDesk shows no scenarios it cannot ground.' };
    var rows = lineAxis(d), L0 = S.current_line, sd = S.joint_sd;
    function stateAt(shift) {
      /* EdgeDesk's number moved against the side by `shift` reads as the line moved by −shift; floor onto the grid (the conservative reading) */
      var target = L0 - shift, best = null;
      rows.forEach(function (p) { if (p.line <= target + EPS && (!best || p.line > best.line)) best = p; });
      if (!best && rows.length && target > rows[rows.length - 1].line) best = rows[rows.length - 1];
      return best ? (best.cls === 'BET' ? 'BET ' + units(best.units) : best.cls) : 'outside the curve';
    }
    var team = S.team;
    var mk = function (key, label, shift, text) { var f = r(S.fair_line + shift, 1); return { key: key, label: label, fair_line: f, fair_text: team + ' ' + lineText(f), shift_pts: r(shift, 2), state_at_current_price: stateAt(shift), text: text }; };
    return { available: true, market_line: S.market_line, market_text: isNum(S.market_line) ? team + ' ' + lineText(S.market_line) : null, sd: sd, basis: S.joint_basis,
      rows: [mk('base', 'MODEL BASE', 0, 'The current projection.'),
        mk('conservative', 'CONSERVATIVE', sd, 'Inputs moved 1 SD against EdgeDesk’s position.'),
        mk('aggressive', 'AGGRESSIVE', -sd, 'Inputs moved 1 SD toward EdgeDesk’s position.')],
      note: 'Sensitivity analysis within measured uncertainty, not a forecast and not a probability.' };
  }

  /* =========================================================== PROVENANCE */
  function provenance(d, now) {
    var out = [], C = (d && d.context) || {}, M = (d && d.market) || {}, V = (d && d.versions) || {};
    (C.provenance || []).forEach(function (p) { out.push({ key: p.key, what: p.what, source: p.source, updated_at: p.updated_at, updated: p.updated_at ? ago(p.updated_at, now) : 'time not published', pricing_impact: p.pricing_impact, confidence: p.confidence || null }); });
    if (d && d.selected_book && !out.some(function (x) { return x.key === 'quote'; })) out.push({ key: 'quote', what: 'The evaluated quote', source: d.selected_book + (M.book_count ? ' · ' + M.book_count + ' book' + (M.book_count === 1 ? '' : 's') + ' in the consensus' : ''), updated_at: d.quote_captured_at, updated: d.quote_captured_at ? ago(d.quote_captured_at, now) : 'time not published', pricing_impact: 'yes', confidence: M.verification_status || null });
    if (V.calibration || (d && d.calibration_version)) out.push({ key: 'calibration', what: 'Calibration', source: V.calibration || d.calibration_version, updated_at: null, updated: 'versioned', pricing_impact: 'yes (the decision probability)', confidence: d.probability_source_label || null });
    return out;
  }

  /* ============================================================ WATCHLIST */
  function concern(d) {
    if (!d) return null;
    if (d.decision === 'NO_DECISION') return d.action_reason_text;
    var w = (d.waiting_on || [])[0];
    if (w) return cap1(w.text);
    var m = mainRisk(d);
    return m ? m.text : null;
  }
  function watchRow(d, track) {
    if (!d) return null;
    var tr = track && track.transitions ? track.transitions.filter(function (x) { return x.from; }).slice(-1)[0] : null;
    var be = d.best_execution && d.best_execution.best;
    return { game_id: d.game_id, sport: d.sport, matchup: (d.away || '') + ' @ ' + (d.home || ''), kickoff: d.kickoff,
      decision: d.decision, display: d.decision_display || d.decision_label, one_line: oneLine(d),
      last_change: tr ? { label: tr.label, at: tr.at, text: tr.text } : null,
      best_price: be ? be.label + ' · ' + be.book : (sel(d) ? pickOf(d) + ' (' + priceText(sel(d).odds) + ')' + (sel(d).book ? ' · ' + sel(d).book : '') : null),
      bet_trigger: d.decision === 'BET' ? (d.playable ? 'playable to ' + d.playable.short : null) : (d.ladder && d.ladder.first_bet ? d.ladder.first_bet.label : (d.bet_trigger && d.bet_trigger.short) || null),
      unresolved: concern(d) };
  }

  /* =============================================================== ALERTS
     Meaningful state changes only. Each alert has a key, so the same change
     is never sent twice; a price wiggle inside the same state is silence. */
  var ALERT_KINDS = {
    BET_TRIGGERED: 'price reaches the BET trigger', BET_INVALID: 'a BET is no longer valid', QB_CONFIRMED: 'quarterback confirmed', QB_OUT: 'quarterback ruled out or changed',
    AVAILABILITY: 'availability materially changed', FAIR_MOVED: 'EdgeDesk’s number moved materially', KEY_NUMBER: 'the market moved through a key number',
    ANOMALY_RESOLVED: 'a price anomaly resolved', RELIABILITY: 'reliability changed significantly'
  };
  var ALERT_CFG = { fair_move_pts: { NFL: 1.0, CFB: 2.0 }, reliability_pts: 10, keys: { NFL: [3, 7], CFB: [3, 7] } };
  function alerts(prev, next, opts) {
    opts = opts || {};
    if (!next) return [];
    var out = [], lg = next.sport === 'NFL' ? 'NFL' : 'CFB';
    function add(kind, text) { out.push({ kind: kind, label: ALERT_KINDS[kind], game_id: next.game_id, text: text, at: next.evaluated_at, key: next.game_id + '|' + kind + '|' + (next.decision_id || next.evaluated_at) }); }
    if (!prev) return out;
    if (next.decision === 'BET' && prev.decision !== 'BET') add('BET_TRIGGERED', oneLine(next));
    if (prev.decision === 'BET' && next.decision !== 'BET') add('BET_INVALID', 'The BET on ' + (prev.bet_price ? prev.bet_price.label || pickOf(prev) : 'this game') + ' is no longer valid: ' + oneLine(next));
    var pq = prev.caps || [], nq = next.caps || [];
    if ((has(pq, 'QB_UNRESOLVED') || has(pq, 'QB_UNKNOWN')) && !has(nq, 'QB_UNRESOLVED') && !has(nq, 'QB_UNKNOWN') && next.evaluation_status === 'EVALUABLE') add('QB_CONFIRMED', 'The quarterback situation resolved; ' + oneLine(next));
    if (has(next.blocker_codes, 'QB_PROJECTION_INVALID') && !has(prev.blocker_codes, 'QB_PROJECTION_INVALID')) add('QB_OUT', next.action_reason_text);
    if (has(pq, 'AVAILABILITY_PENDING') !== has(nq, 'AVAILABILITY_PENDING')) add('AVAILABILITY', has(nq, 'AVAILABILITY_PENDING') ? 'A material availability update is now pending.' : 'The pending availability update resolved.');
    var fp = prev.canonical ? prev.canonical.fair_home_spread : null, fn = next.canonical ? next.canonical.fair_home_spread : null;
    if (isNum(fp) && isNum(fn) && Math.abs(fn - fp) >= ALERT_CFG.fair_move_pts[lg] - EPS) add('FAIR_MOVED', 'EdgeDesk’s number moved ' + pts(fn - fp) + ' (home ' + lineText(fp) + ' → ' + lineText(fn) + ').');
    var mp = prev.canonical ? prev.canonical.market_home_spread : null, mn = next.canonical ? next.canonical.market_home_spread : null;
    var keys = opts.keys || ALERT_CFG.keys[lg];
    if (isNum(mp) && isNum(mn) && Math.abs(mn - mp) > EPS) {
      var lo = Math.min(mp, mn), hi = Math.max(mp, mn), crossed = [];
      keys.forEach(function (k) { [k, -k].forEach(function (s) { if (s > lo + EPS && s < hi - EPS) crossed.push(s); }); });
      if (crossed.length) add('KEY_NUMBER', 'The market moved through ' + crossed.map(lineText).join(', ') + ' (home ' + lineText(mp) + ' → ' + lineText(mn) + ').');
    }
    if (prev.anomaly && prev.anomaly.open && !(next.anomaly && next.anomaly.open)) add('ANOMALY_RESOLVED', 'The price anomaly resolved: ' + oneLine(next));
    if (isNum(prev.reliability_score) && isNum(next.reliability_score) && Math.abs(next.reliability_score - prev.reliability_score) >= ALERT_CFG.reliability_pts) add('RELIABILITY', 'Data reliability moved from ' + Math.round(prev.reliability_score) + ' to ' + Math.round(next.reliability_score) + '.');
    return out;
  }

  return { VERSION: VERSION, oneLine: oneLine, mainRisk: mainRisk, gates: gates, whyNot: whyNot, whatChanges: whatChanges, reliabilityBreakdown: reliabilityBreakdown,
    sensitivity: sensitivity, scenarios: scenarios, provenance: provenance, watchRow: watchRow, alerts: alerts, ALERT_KINDS: ALERT_KINDS, ALERT_CFG: ALERT_CFG, pickOf: pickOf };
}));

/* ===========================================================================
   EDGEDESK DECISION TRACK — what a recommendation was, how it changed, and
   how it graded. docs/bettor-decision/DESIGN.md §6-§8

   Four jobs, all pure functions over the canonical decision object
   (lib/edgedesk_decision.js):

     transition(prev, next)   BET → PASS / PRICE MOVED, WAIT → BET, …
     track(prevTrack, d)      first qualified, best observed, current,
                              last evaluated, closing — append-only history
     snapshot(d)              the frozen audit record (reconstructs the call)
     grade / compareEntry / performance
                              CLV (EDResearch.clvPoints — the one points-CLV
                              implementation), the reader's entry against the
                              recommendation AS IT WAS, and per-tier results

   RULES
     - History is append-only. A later evaluation never edits an earlier
       transition, the first-qualified price, or a frozen snapshot.
     - The reader's placed bet is stored separately from the recommendation
       and is compared against the recommendation snapshot taken when it was
       placed, never against a later one.
     - Short samples are labelled as such (min_n), never as evidence.

   Browser: window.EDDecisionTrack. Node: require('./edgedesk_decision_track.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDDecisionTrack = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_decision_track_v1';
  var Rc = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) { try { Rc = require('./research_core.js'); } catch (e) { Rc = null; } }
  function R() {
    var c = Rc || (root && root.EDResearchCore) || (root && root.EDResearch && typeof root.EDResearch.clvPoints === 'function' ? root.EDResearch : null);
    if (!c || typeof c.clvPoints !== 'function') throw new Error('EDDecisionTrack needs lib/research_core.js loaded first');
    return c;
  }

  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function hash(parts) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts), h = 0x811c9dc5, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function americanToDecimal(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function quoteLabel(q) { return q ? lineText(q.line) + ' (' + priceText(q.odds) + ')' : '—'; }
  /* a quote is better for the taker with more points, then a better payout */
  function betterQuote(a, b) {
    if (!a) return false; if (!b) return true;
    if (Math.abs(a.line - b.line) > EPS) return a.line > b.line;
    return (americanToDecimal(a.odds) || 0) > (americanToDecimal(b.odds) || 0) + EPS;
  }
  function qOf(d) {
    if (!d) return null;
    var q = d.bet_price || d.reference_quote;
    if (!q) return null;
    return { line: q.line, odds: q.odds, book: q.book, side: q.side, captured_at: q.captured_at, calibrated_ev: q.calibrated_ev,
      decision_ev: isNum(q.decision_ev) ? q.decision_ev : (isNum(d.decision_ev_pct) ? d.decision_ev_pct / 100 : null), source: d.probability_source || null };
  }
  function evPct(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + '%' : null; }
  function evName(q) { return q && q.source && q.source !== 'model_estimated' ? 'calibrated EV' : 'EV'; }
  /* "DraftKings moved from +10 (−110) to +10.5 (−105)" — the book, the two
     quotes, and what it did to the decision EV */
  function moveText(pq, nq) {
    if (!pq || !nq) return null;
    if (pq.book && nq.book && String(pq.book).toLowerCase() === String(nq.book).toLowerCase()) return pq.book + ' moved from ' + quoteLabel(pq) + ' to ' + quoteLabel(nq);
    return 'The price moved from ' + quoteLabel(pq) + (pq.book ? ' at ' + pq.book : '') + ' to ' + quoteLabel(nq) + (nq.book ? ' at ' + nq.book : '');
  }

  /* ========================================================== TRANSITIONS */
  var PRICE_CODES = ['PRICE_MOVED', 'CALIBRATED_EV_NEGATIVE', 'CALIBRATED_EV_BELOW_THRESHOLD', 'NO_MODEL_EDGE', 'ALT_TAIL_ONLY', 'EDGE_TOO_SMALL', 'JUICE_CONSUMES_EDGE',
    'MARKET_ALIGNED', 'NEAR_THRESHOLD', 'MODEL_MARKET_DISAGREEMENT', 'LEAN_EDGE'];
  /* the v1 WAIT is today's WATCH */
  function cls(k) { return k === 'WAIT' ? 'WATCH' : k; }
  var RANK = { NO_DECISION: -1, PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };
  var KINDS = {
    PRICE_IMPROVED: 'PRICE IMPROVED', STILL_PLAYABLE: 'STILL PLAYABLE', PRICE_MOVED: 'PRICE MOVED', NEW_INFORMATION: 'NEW INFORMATION',
    INFORMATION_RESOLVED: 'INFORMATION RESOLVED', MARKET_AVAILABLE: 'MARKET AVAILABLE', MARKET_UNAVAILABLE: 'MARKET UNAVAILABLE', UNCHANGED: 'UNCHANGED'
  };
  function transition(prev, next, opts) {
    opts = opts || {};
    if (!next) return null;
    var from = prev ? prev.decision : null, to = next.decision, f = cls(from), t = cls(to);
    var pq = qOf(prev), nq = qOf(next), at = iso(next.evaluated_at || opts.now);
    var kind, text, priceCode = PRICE_CODES.indexOf(next.action_reason_code) >= 0;
    if (!prev) return { from: null, to: to, kind: 'INITIAL', label: 'FIRST EVALUATION', at: at, reason_code: next.action_reason_code, text: next.action_reason_text, previous_quote: null, current_quote: nq };
    if (f === 'BET' && t === 'BET') {
      var improved = pq && nq && pq.side === nq.side && (betterQuote(nq, pq) || (isNum(nq.calibrated_ev) && isNum(pq.calibrated_ev) && nq.calibrated_ev > pq.calibrated_ev + 1e-6 && Math.abs(nq.line - pq.line) < EPS && nq.odds === pq.odds));
      if (improved) { kind = 'PRICE_IMPROVED'; text = 'Price improved from ' + quoteLabel(pq) + ' to ' + quoteLabel(nq) + '.'; }
      else if (pq && nq && (Math.abs(nq.line - pq.line) > EPS || nq.odds !== pq.odds || nq.side !== pq.side)) { kind = 'STILL_PLAYABLE'; text = 'Price changed from ' + quoteLabel(pq) + ' to ' + quoteLabel(nq) + ' and remains inside the playable range.'; }
      else if (prev.recommended_units !== next.recommended_units) { kind = 'STILL_PLAYABLE'; text = 'Still playable; stake changed from ' + prev.recommended_units + 'U to ' + next.recommended_units + 'U.'; }
      else return null;
    } else if (f === t) {
      return null;
    } else if (t === 'NO_DECISION') { kind = 'MARKET_UNAVAILABLE'; text = next.action_reason_text; }
    else if (f === 'NO_DECISION') { kind = 'MARKET_AVAILABLE'; text = 'Required information became available. ' + next.action_reason_text; }
    else if (RANK[t] < RANK[f]) {
      if (priceCode) { kind = 'PRICE_MOVED'; text = pq && nq && f === 'BET' ? moveText(pq, nq) + ' and crossed EdgeDesk’s playable threshold' + (evPct(nq.decision_ev) ? ' (' + evName(nq) + ' now ' + evPct(nq.decision_ev) + ')' : '') + '.' : next.action_reason_text; }
      else { kind = 'NEW_INFORMATION'; text = (f === 'BET' ? 'New information: ' : '') + next.action_reason_text; }
    } else {
      /* upward: a resolved cap is new information, a better price is a better price */
      if ((f === 'WATCH' || f === 'LEAN') && prev.action_reason_code && PRICE_CODES.indexOf(prev.action_reason_code) < 0) { kind = 'INFORMATION_RESOLVED'; text = t === 'BET' ? 'The pending information resolved and the price qualifies.' : 'The pending information resolved. ' + next.action_reason_text; }
      else { kind = 'PRICE_IMPROVED'; text = t === 'BET' ? (pq && nq && (Math.abs(pq.line - nq.line) > EPS || pq.odds !== nq.odds) ? moveText(pq, nq) + ', pushing ' + evName(nq) + ' above the betting threshold' + (evPct(nq.decision_ev) ? ' (' + evPct(nq.decision_ev) + ')' : '') + '.' : 'The price improved enough to clear EdgeDesk’s betting thresholds' + (nq ? ' at ' + quoteLabel(nq) : '') + '.') : 'The price improved: ' + next.action_reason_text; }
    }
    return { from: from, to: to, kind: kind, label: (from || '—') + ' → ' + to + ' / ' + KINDS[kind], at: at, reason_code: next.action_reason_code, text: text, previous_quote: pq, current_quote: nq };
  }

  /* ============================================================== TRACK
     One record per game + market. first_qualified is set once, at the first
     BET, and never moves. best_observed only improves. transitions only grow. */
  function track(prev, d, opts) {
    opts = opts || {};
    if (!d) return prev || null;
    var t = prev ? copy(prev) : { schema: VERSION, game_id: d.game_id, sport: d.sport, market_key: d.market_key, home: d.home, away: d.away, kickoff: d.kickoff,
      first_qualified: null, best_observed: null, current: null, current_decision: null, previous_decision: null, last_evaluated: null, last_changed: null, closing: null, transitions: [], n_evaluations: 0 };
    var prevDecision = prev ? { decision: prev.current_decision, bet_price: prev.current && prev.current.decision === 'BET' ? prev.current : null, reference_quote: prev.current && prev.current.decision !== 'BET' ? prev.current : null, recommended_units: prev.current ? prev.current.units : 0, evaluated_at: prev.last_evaluated,
      action_reason_code: prev.current ? prev.current.reason_code : null } : null;
    var nq = qOf(d);
    var tr = transition(prevDecision, d, opts);
    if (tr) { t.transitions.push(tr); t.previous_decision = t.current_decision; t.last_changed = tr.at; }
    t.current_decision = d.decision;
    t.current = nq ? { decision: d.decision, line: nq.line, odds: nq.odds, book: nq.book, side: nq.side, units: d.recommended_units || 0, reason_code: d.action_reason_code, at: iso(d.evaluated_at),
      playable: d.playable ? { min_line: d.playable.min_line, max_odds: d.playable.max_odds, text: d.playable.text } : null } : { decision: d.decision, reason_code: d.action_reason_code, at: iso(d.evaluated_at), units: 0 };
    t.last_evaluated = iso(d.evaluated_at);
    t.n_evaluations = (t.n_evaluations || 0) + 1;
    if (d.decision === 'BET' && nq) {
      if (!t.first_qualified) t.first_qualified = { at: iso(d.evaluated_at), line: nq.line, odds: nq.odds, book: nq.book, side: nq.side, units: d.recommended_units, calibrated_ev: nq.calibrated_ev, decision_id: d.decision_id,
        playable: d.playable ? { min_line: d.playable.min_line, max_odds: d.playable.max_odds } : null };
      if (!t.best_observed || (t.best_observed.side === nq.side && betterQuote(nq, t.best_observed))) t.best_observed = { at: iso(d.evaluated_at), line: nq.line, odds: nq.odds, book: nq.book, side: nq.side };
    }
    return t;
  }
  /* the close, recorded once at kickoff (never re-written) */
  function close(t, closing) {
    if (!t) return t;
    if (t.closing) return t;
    var o = copy(t);
    o.closing = closing ? { line: num(closing.line), odds: num(closing.odds), at: iso(closing.at), source: closing.source || null } : null;
    if (o.closing && o.first_qualified && isNum(o.closing.line)) o.first_qualified_clv_points = clvPoints(o.first_qualified.side, o.first_qualified.line, o.closing.line);
    return o;
  }

  /* ================================================================ CLV
     Points, in the side's own terms: entry +6.5, close +4.5 → +2.0.
     Computed through EDResearch.clvPoints on home lines (the canonical
     implementation), so every surface agrees. */
  function clvPoints(side, entrySideLine, closeSideLine) {
    var e = num(entrySideLine), c = num(closeSideLine);
    if (e == null || c == null || (side !== 'home' && side !== 'away')) return null;
    var eh = side === 'home' ? e : -e, ch = side === 'home' ? c : -c;
    var v = R().clvPoints(side, eh, ch);
    return v == null ? null : r(v, 2);
  }
  /* the result of a spread wager at its exact line (home margin = home − away) */
  function spreadResult(side, sideLine, finalHomeMargin) {
    var m = num(finalHomeMargin), L = num(sideLine);
    if (m == null || L == null || (side !== 'home' && side !== 'away')) return null;
    var x = (side === 'home' ? m : -m) + L;
    return x > EPS ? 'win' : (x < -EPS ? 'loss' : 'push');
  }
  function unitsWon(result, odds, units) {
    var d = americanToDecimal(odds), u = num(units);
    if (d == null || u == null) return null;
    if (result === 'win') return r(u * (d - 1), 4);
    if (result === 'loss') return -u;
    if (result === 'push' || result === 'void') return 0;
    return null;
  }
  function grade(entry, closing, final) {
    entry = entry || {};
    var out = { clv_points: null, result: null, units_won: null };
    if (closing && isNum(num(closing.line))) out.clv_points = clvPoints(entry.side, entry.line, closing.line);
    if (final && isNum(num(final.home_margin))) { out.result = spreadResult(entry.side, entry.line, final.home_margin); out.units_won = unitsWon(out.result, entry.odds, entry.units); }
    return out;
  }

  /* ======================================== EVERY DECISION CLASS, GRADED
     BET is graded above (units at the recorded price). For the question
     "does BET beat LEAN beat PASS?" every EVALUABLE snapshot is graded the
     same way: CLV at the evaluated number, the result at that number, and a
     HYPOTHETICAL flat 1U at the evaluated price (never mixed with the real
     BET units). Lines: opening, evaluated, bet (BET only), closing consensus,
     closing sharp (when one was captured — never invented).
       lines.open / lines.close / lines.close_sharp: home-stated numbers
       lines.close_captured_at, lines.close_odds_home / close_odds_away
       final: { home_margin }
       opts.coverAt(centerHomeMargin, side, line) → {win, push, loss} (the
         closing market's own distribution, for price-equivalent CLV) */
  var GRADEABLE = ['BET', 'LEAN', 'WATCH', 'WAIT', 'PASS'];
  function gradeEvaluation(s, lines, final, opts) {
    s = s || {}; lines = lines || {}; opts = opts || {};
    if (GRADEABLE.indexOf(s.decision) < 0) return null;
    var q = s.bet_price || s.reference_quote;
    if (!q || (q.side !== 'home' && q.side !== 'away') || !isNum(num(q.line)) || !isNum(num(q.odds))) return null;
    var side = q.side, line = num(q.line), odds = num(q.odds);
    var toSide = function (hl) { var v = num(hl); return v == null ? null : (side === 'home' ? v : -v); };
    var closeSide = toSide(lines.close), sharpSide = toSide(lines.close_sharp), openSide = toSide(lines.open);
    var out = { schema: 'edgedesk_bettor_decision_evaluation_v1', snapshot_id: s.snapshot_id, game_id: s.game_id, sport: s.sport, market_key: s.market_key, market_type: s.market_type || 'spread',
      decision: s.decision === 'WAIT' ? 'WATCH' : s.decision, reason_code: s.action_reason_code, units: s.decision === 'BET' ? (num(s.recommended_units) || 0) : 0, tier: s.tier || null,
      side: side, evaluated_line: line, evaluated_odds: odds, evaluated_book: q.book || null, bet_line: s.decision === 'BET' ? line : null, bet_odds: s.decision === 'BET' ? odds : null,
      open_line: openSide, close_line: closeSide, close_sharp_line: sharpSide, close_captured_at: iso(lines.close_captured_at),
      clv_points: null, clv_sharp_points: null, clv_price_pp: null, clv_ev: null, clv_basis: null,
      result: null, units_won: null, flat_units_won_hypothetical: null,
      predicted: num(s.probability), predicted_raw: num(s.cover_probability), break_even: num(s.break_even != null ? s.break_even : s.break_even_probability), edge_pp: num(s.edge_pp),
      calibrated_ev: isNum(num(s.calibrated_ev_pct)) ? r(s.calibrated_ev_pct / 100, 6) : null, decision_ev: isNum(num(s.decision_ev_pct)) ? r(s.decision_ev_pct / 100, 6) : null,
      decision_confidence: num(s.decision_confidence), probability_source: s.probability_source || null, reliability: num(s.reliability_score), market_quality: s.market_quality || null,
      book_count: s.market ? num(s.market.book_count) : null, gap_pts: num(s.model_market_gap), quote_age_minutes: num(q.quote_age_minutes),
      model_version: s.model_version || null, calibration_version: s.calibration_version || null, pricing_version: s.pricing_model_version || null,
      rules_version: s.config_version || null, engine_version: s.decision_engine_version || null, version_key: s.versions ? s.versions.version_key || null : null,
      evaluation_mode: s.evaluation_mode || 'LIVE', evaluated_at: s.evaluated_at, kickoff: s.kickoff, quote_captured_at: s.quote_captured_at || q.captured_at || null,
      data_snapshot_at: s.data_snapshot_at || (s.versions ? s.versions.data_snapshot_at : null), unit_of_analysis: opts.unit || 'first_per_class', graded_at: iso(opts.now) };
    if (isNum(closeSide)) {
      out.clv_points = clvPoints(side, line, closeSide);
      out.clv_basis = 'points against the consensus close';
      var dE = americanToDecimal(odds);
      if (typeof opts.coverAt === 'function' && dE) {
        /* the NUMBER's worth against the close, in cover probability: both
           lines read off ONE distribution centred on the close, so any
           centring error cancels. The close is taken as a coin flip (no
           closing prices on file), which is what a consensus close means. */
        var centre = side === 'home' ? -closeSide : closeSide, pE = null, pC = null;
        try { pE = opts.coverAt(centre, side, line); pC = opts.coverAt(centre, side, closeSide); } catch (e) { pE = null; }
        var cov = function (p) { return p && isNum(p.win) && isNum(p.loss) && p.win + p.loss > 0 ? p.win / (p.win + p.loss) : null; };
        if (isNum(cov(pE)) && isNum(cov(pC))) {
          var gain = cov(pE) - cov(pC);
          out.clv_price_pp = r(100 * gain, 3);
          out.clv_ev = r(((0.5 + gain) * dE - 1) * (1 - (isNum(pE.push) ? pE.push : 0)), 4);
          out.clv_basis = 'points; the number’s worth against the close in cover probability; and the entry’s EV if the close was a fair coin flip';
        }
      }
    }
    if (isNum(sharpSide)) out.clv_sharp_points = clvPoints(side, line, sharpSide);
    if (final && isNum(num(final.home_margin))) {
      out.result = spreadResult(side, line, final.home_margin);
      out.flat_units_won_hypothetical = unitsWon(out.result, odds, 1);
      if (out.units > 0) out.units_won = unitsWon(out.result, odds, out.units);
    }
    return out;
  }
  /* the unit of analysis: the FIRST snapshot of each decision class per game
     and market — "when EdgeDesk first said X, what happened?" A game that
     went WATCH → BET counts once as WATCH and once as BET; a game that
     flickered BET → BET → BET counts once. */
  function firstPerClass(snaps) {
    var seen = {}, out = [];
    (snaps || []).slice().sort(function (a, b) { return (ms(a.evaluated_at) || 0) - (ms(b.evaluated_at) || 0); }).forEach(function (x) {
      var cls0 = x.decision === 'WAIT' ? 'WATCH' : x.decision;
      if (GRADEABLE.indexOf(x.decision) < 0) return;
      var k = x.game_id + '|' + (x.market_key || '') + '|' + cls0;
      if (seen[k]) return;
      seen[k] = true; out.push(x);
    });
    return out;
  }

  /* ============================================== THE READER'S OWN ENTRY
     Compared against the recommendation snapshot stored with the bet — the
     recommendation as it was, never as it is now. */
  function compareEntry(bet, rec) {
    bet = bet || {};
    var out = { your_line: num(bet.line), your_odds: num(bet.odds), edgedesk_line: null, edgedesk_odds: null, playable_line: null, playable_odds: null, status: 'NO_RECOMMENDATION', text: null };
    if (!rec || rec.decision !== 'BET' || !rec.bet_price) { out.text = 'No EdgeDesk BET was active for this game when the bet was recorded.'; return out; }
    out.edgedesk_line = rec.bet_price.line; out.edgedesk_odds = rec.bet_price.odds;
    out.playable_line = rec.playable ? rec.playable.min_line : rec.bet_price.line; out.playable_odds = rec.playable ? rec.playable.max_odds : rec.bet_price.odds;
    if (bet.side && rec.bet_price.side && bet.side !== rec.bet_price.side) { out.status = 'OTHER_SIDE'; out.text = 'Your entry is on the other side of EdgeDesk’s recommendation.'; return out; }
    var d = americanToDecimal(bet.odds);
    if (out.your_line == null || d == null) { out.status = 'UNKNOWN'; out.text = 'Your line or price was not recorded.'; return out; }
    if (Math.abs(out.your_line - out.edgedesk_line) < EPS && Math.round(out.your_odds) === Math.round(out.edgedesk_odds)) { out.status = 'AT_EDGEDESK_PRICE'; out.text = 'You matched EdgeDesk’s price.'; return out; }
    var frontier = (rec.playable && rec.playable.frontier) || [{ line: out.playable_line, max_odds: out.playable_odds }];
    var inside = frontier.some(function (f) { var fd = americanToDecimal(f.max_odds); return out.your_line >= f.line - EPS && fd != null && d >= fd - 1e-9; })
      || (out.your_line >= out.edgedesk_line - EPS && d >= (americanToDecimal(out.edgedesk_odds) || Infinity) - 1e-9);
    out.status = inside ? 'INSIDE_RANGE' : 'OUTSIDE_RANGE';
    out.text = inside ? 'Your entry was inside EdgeDesk’s playable range.' : 'Outside EdgeDesk range: your entry was worse than the playable boundary.';
    return out;
  }

  /* ============================================================ SNAPSHOT
     Everything needed to reconstruct the recommendation later. Frozen; the
     id is a hash of its own content, so a changed row is a different row. */
  var SNAP_FIELDS = ['game_id', 'sport', 'market_key', 'home', 'away', 'kickoff', 'decision', 'action_reason_code', 'action_reason_text', 'side', 'side_key', 'market_type',
    'selected_line', 'selected_odds', 'selected_book', 'selected_is_alternate', 'recommended_units', 'shadow_units', 'strength', 'max_playable_line', 'max_acceptable_odds',
    'model_fair_line', 'consensus_market_line', 'model_market_gap', 'cover_probability', 'push_probability', 'break_even_probability', 'calibrated_cover_probability',
    'raw_ev_pct', 'calibrated_ev_pct', 'risk_adjusted_score', 'reliability_score', 'reliability_label', 'confidence_score', 'confidence_label', 'projection_stability',
    'market_quality', 'independent_support_count', 'research_status', 'evaluated_at', 'quote_captured_at', 'model_version', 'pricing_model_version',
    'calibration_version', 'decision_engine_version', 'config_version', 'validation_state', 'first_qualified_at',
    'evaluation_status', 'blocker_codes', 'decision_qualifier', 'tier', 'probability_source', 'probability', 'break_even', 'edge_pp', 'decision_ev_pct',
    'decision_confidence', 'reasons', 'warning_codes', 'evaluation_mode', 'data_snapshot_at'];
  /* the canonical market, the execution and the ladder, as frozen at the call */
  function compactMarket(m) {
    if (!m || m.error) return m ? { error: m.error } : null;
    return { consensus_line: m.consensus_line, consensus_home_line: m.consensus_home_line, sharp_reference_line: m.sharp_reference_line, weighted_mean: m.weighted_mean,
      book_count: m.book_count, fresh_books: m.market_depth ? m.market_depth.fresh_books : null, verification_status: m.verification_status, freshness: m.freshness, age_seconds: m.age_seconds,
      dispersion: m.dispersion ? m.dispersion.level : null, agreement: m.agreement, outliers: (m.outliers || []).map(function (o) { return o.book; }),
      quality: m.quality ? { score: m.quality.score, label: m.quality.label } : null, movement: m.movement && m.movement.available ? { opening: m.movement.opening, current: m.movement.current, high: m.movement.high, low: m.movement.low, indicators: (m.movement.indicators || []).map(function (i) { return i.code; }) } : null };
  }
  function compactExecution(b) {
    if (!b || b.error) return b ? { error: b.error } : null;
    var q = function (x) { return x ? { label: x.label, line: x.line, odds: x.odds, book: x.book, decision_ev: x.decision_ev, calibrated_ev: x.calibrated_ev } : null; };
    return { best: q(b.best), alternative: q(b.alternative), reason: b.reason, n_executable: b.n_executable };
  }
  function compactLadder(l) {
    if (!l || l.error) return l ? { error: l.error } : null;
    var row = function (x) { return { line: x.line, odds: x.odds, state: x.state, current: !!x.current }; };
    return { summary: l.summary, by_line: (l.by_line || []).map(row), by_price: (l.by_price || []).map(row), first_bet: l.first_bet ? { line: l.first_bet.line, odds: l.first_bet.odds, state: l.first_bet.state } : null };
  }
  function snapshot(d, extra) {
    if (!d) return null;
    extra = extra || {};
    var s = { schema: 'edgedesk_bettor_decision_snapshot_v1', track_engine: VERSION };
    SNAP_FIELDS.forEach(function (k) { s[k] = d[k] === undefined ? null : copy(d[k]); });
    s.bet_price = copy(d.bet_price || null);
    s.reference_quote = copy(d.reference_quote || null);
    s.best_available = copy(d.best_available || null);
    s.playable = d.playable ? { mode: d.playable.mode, min_line: d.playable.min_line, max_odds: d.playable.max_odds, at_current_line_max_odds: d.playable.at_current_line_max_odds, frontier: copy(d.playable.frontier), threshold_calibrated_ev: d.playable.threshold_calibrated_ev } : null;
    s.blockers = copy(d.blockers || []);
    s.warnings = (d.warnings || []).map(function (w) { return w.code; });
    s.invalidation_conditions = (d.invalidation_conditions || []).map(function (w) { return w.code; });
    s.anomaly = d.anomaly ? { triggered: d.anomaly.triggered, cleared: d.anomaly.cleared, severe: d.anomaly.severe, triggers: (d.anomaly.triggers || []).map(function (t) { return t.code; }),
      checks: (d.anomaly.checks || []).map(function (c) { return { code: c.code, status: c.status }; }) } : null;
    s.sizing = d.sizing ? { units: d.sizing.units, shadow_units: d.sizing.shadow_units, composite: d.sizing.composite ? d.sizing.composite.score : null, caps: copy(d.sizing.caps), tiers: copy(d.sizing.tiers), validation: d.sizing.validation } : null;
    s.governance = copy(d.governance || null);
    s.qb_state = copy(extra.qb_state || null);
    s.availability_state = copy(extra.availability_state || null);
    s.integrity_gates = copy(extra.integrity_gates || null);
    s.distribution = copy(extra.distribution || null);
    s.versions = copy(d.versions || null);
    s.market = compactMarket(d.market);
    s.best_execution = compactExecution(d.best_execution);
    s.ladder = compactLadder(d.ladder);
    s.frozen_at = iso(extra.now || d.evaluated_at || Date.now());
    var idParts = [s.game_id, s.market_key, s.decision, s.action_reason_code, s.side_key, s.selected_line, s.selected_odds, s.selected_book, s.recommended_units, s.evaluated_at, s.model_version, s.calibration_version, s.config_version];
    /* a row made by a different engine version is a different row */
    if (s.versions && s.versions.version_key) idParts.push(s.versions.version_key);
    s.snapshot_id = 'bds_' + hash(idParts);
    return deepFreeze(s);
  }
  /* write-once guard for a snapshot ledger: never replace, never rewrite
     a pregame state with information captured after it */
  function appendSnapshot(ledger, s) {
    var list = (ledger || []).slice();
    if (!s) return list;
    if (list.some(function (x) { return x.snapshot_id === s.snapshot_id; })) return list;
    var last = list.filter(function (x) { return x.game_id === s.game_id && x.market_key === s.market_key; }).slice(-1)[0];
    if (last && ms(s.evaluated_at) != null && ms(last.evaluated_at) != null && ms(s.evaluated_at) < ms(last.evaluated_at)) return list;    /* out-of-order: refused */
    if (s.kickoff && ms(s.evaluated_at) != null && ms(s.evaluated_at) >= ms(s.kickoff)) return list;                                        /* post-kickoff: refused */
    list.push(s);
    return list;
  }

  /* ========================================================= PERFORMANCE
     rows: graded BET recommendations {units, odds, result, clv_points,
     calibrated_cover, model_version, sport, market_type, strength}.
     Per unit tier and every requested grouping. Below min_n a row says so. */
  function performance(rows, opts) {
    opts = opts || {};
    var minN = opts.min_n == null ? 50 : opts.min_n;
    var list = (rows || []).filter(function (x) { return x && isNum(num(x.units)) && num(x.units) > 0; });
    function summarize(sub, label) {
      var settled = sub.filter(function (x) { return x.result === 'win' || x.result === 'loss' || x.result === 'push'; });
      var decided = settled.filter(function (x) { return x.result !== 'push'; });
      var risked = settled.reduce(function (s, x) { return s + num(x.units); }, 0);
      var won = settled.reduce(function (s, x) { var u = unitsWon(x.result, x.odds, x.units); return s + (u || 0); }, 0);
      var clv = sub.map(function (x) { return num(x.clv_points); }).filter(isNum);
      var exp = decided.map(function (x) { return num(x.calibrated_cover); }).filter(isNum);
      var wins = decided.filter(function (x) { return x.result === 'win'; }).length;
      var mean = function (a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; };
      return { group: label, bets: sub.length, settled: settled.length, units_risked: r(risked, 2), units_won: r(won, 2), roi: risked > 0 ? r(won / risked, 4) : null,
        average_clv: r(mean(clv), 2), positive_clv_rate: clv.length ? r(clv.filter(function (v) { return v > 0; }).length / clv.length, 3) : null,
        observed_cover_rate: decided.length ? r(wins / decided.length, 4) : null, expected_cover_rate: r(mean(exp), 4),
        sufficient: settled.length >= minN, note: settled.length >= minN ? null : 'n = ' + settled.length + ' settled (< ' + minN + '): shown for completeness, not evidence' };
    }
    function by(key, keys) {
      var groups = {};
      list.forEach(function (x) { var k = typeof key === 'function' ? key(x) : x[key]; k = k == null ? '—' : String(k); (groups[k] = groups[k] || []).push(x); });
      var ks = keys || Object.keys(groups).sort();
      return ks.map(function (k) { return summarize(groups[k] || [], k); });
    }
    return {
      schema: 'edgedesk_bettor_decision_performance_v1', min_n: minN,
      all: summarize(list, 'all'),
      by_tier: by(function (x) { return (Math.round(num(x.units) * 100) / 100).toFixed(2) + 'U'; }, ['0.25U', '0.50U', '0.75U', '1.00U']),
      by_sport: by('sport'), by_model_version: by('model_version'), by_market_type: by('market_type'), by_strength: by('strength'),
      note: 'Unit tiers are recalibrated from this table only once each tier has at least ' + minN + ' settled bets; until then every figure is descriptive.'
    };
  }

  return {
    VERSION: VERSION, KINDS: KINDS, PRICE_CODES: PRICE_CODES,
    transition: transition, track: track, close: close,
    clvPoints: clvPoints, spreadResult: spreadResult, unitsWon: unitsWon, grade: grade,
    compareEntry: compareEntry, snapshot: snapshot, appendSnapshot: appendSnapshot, performance: performance,
    gradeEvaluation: gradeEvaluation, firstPerClass: firstPerClass, GRADEABLE: GRADEABLE,
    americanToDecimal: americanToDecimal, lineText: lineText, priceText: priceText
  };
}));

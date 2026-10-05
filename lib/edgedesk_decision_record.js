/* ===========================================================================
   EDGEDESK DECISION RECORD — the rules of supabase/portfolio_decision.sql,
   for the page. docs/decision-record.md

   1. MIRRORS (value for value; tools/portfolio/decision_sql.test.js holds the
      SQL and this file in parity): price freshness, context quality, the
      outcome class, and edge capture.
   2. EVIDENCE TESTS over the moments the server stores: process memory
      (FIRST DETECTED · THEN · NOW · STATUS) and change against the frozen
      personal baseline — Welch's test from lib/edgedesk_portfolio_process.js,
      never a comparison of two letters.
   3. CONTINUITY: a Card entry → the Record Position form, prefilled, and the
      decision snapshot that goes with it. Nothing is invented: a value the
      Card did not hold stays empty.
   4. WORDS: what each quality, class and limitation means, analysis depth
      at 10 / 30 / 100 (what becomes possible, never a target), and questions
      from the reader's own evidence.

   Nothing here recommends placing, sizing up or repeating anything. The
   reader decides.

   Browser: window.EDDecisionRecord.   Node: require('./edgedesk_decision_record.js').
   =========================================================================== */
(function (root, factory) {
  var E = root.EDPortfolio || (typeof require === 'function' ? require('./edgedesk_portfolio.js') : null);
  var X = root.EDPortfolioProcess || (typeof require === 'function' ? require('./edgedesk_portfolio_process.js') : null);
  var api = factory(E, X);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDDecisionRecord = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (E, X) {
  'use strict';
  var D = E.dec;
  function has(x) { return x !== null && x !== undefined && x !== '' && D.valid(x); }
  function gt(a, b) { return D.cmp(a, b) > 0; }
  /* a line has moved only when both lines are known and differ (the journal's convention) */
  function sameLine(a, b) { return !has(a) || !has(b) || D.cmp(a, b) === 0; }
  function ms(t) { var v = t == null ? NaN : typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }

  var METHODOLOGY = { process: 'process_v1', snapshot: 'snapshot_v1', context_quality: 'context_quality_v1', edge_capture: 'edge_capture_v1',
    outcome_class: 'outcome_class_v1', baseline: 'baseline_v1', insight: 'insight_v1', experiment: 'experiment_v1' };

  /* ═══ 1. MIRRORS ══════════════════════════════════════════════════════ */
  /* portfolio_freshness: lib/edgedesk_market.js thresholds */
  function freshness(captured, at) {
    var c = ms(captured), a = ms(at);
    if (c == null || a == null) return 'UNKNOWN';
    if (c > a + 5 * 60000) return 'FUTURE';
    if (c >= a - 30 * 60000) return 'FRESH';
    if (c >= a - 90 * 60000) return 'AGING';
    return 'STALE';
  }
  /* portfolio_context_quality */
  function contextQuality(f) {
    f = f || {};
    var sp = !!f.snapshot_pre, sm = !!f.snapshot_model, sk = !!f.snapshot_market, dp = !!f.decision_pre, pr = !!f.price_ref_pre, mc = !!f.market_ctx;
    if (sp && sm && sk) return 'FULL';
    if ((sp && (sm || sk)) || (dp && pr)) return 'STRONG';
    if (dp || sp || mc) return 'PARTIAL';
    return 'RESULT_ONLY';
  }
  /* portfolio_outcome_class: process and result together, never result alone */
  function outcomeClass(status, result, score, quality) {
    if (status == null || status === 'OPEN') return 'OPEN';
    if (result !== 'WIN' && result !== 'LOSS') return 'NOT_APPLICABLE';
    if (!has(score) || (quality || 'RESULT_ONLY') === 'RESULT_ONLY') return 'NOT_CLASSIFIED';
    if (D.cmp(score, '66') >= 0) return result === 'WIN' ? 'GOOD_WIN' : 'GOOD_LOSS';
    if (D.cmp(score, '45') < 0) return result === 'WIN' ? 'BAD_WIN' : 'BAD_LOSS';
    return 'AVERAGE_PROCESS';
  }
  /* portfolio_edge_capture. o: platform_type, position_type, dir, lead,
     entry, entry_line, ref, ref_line, close, close_line, prob */
  function edgeCapture(o) {
    o = o || {};
    var pm = o.platform_type === 'PREDICTION_MARKET';
    function none(code) { return { methodology: METHODOLOGY.edge_capture, basis: 'NONE', limitations: [code] }; }
    if (o.position_type === 'PARLAY' || o.position_type === 'SAME_GAME_PARLAY') return none('PARLAY_NOT_DECOMPOSED');
    if (!has(o.entry)) return none('NO_ENTRY_PRICE');
    if (o.lead != null && o.lead <= 0) return none('LIVE_ENTRY');
    var refSame = has(o.ref) && sameLine(o.ref_line, o.entry_line), closeSame = has(o.close) && sameLine(o.close_line, o.entry_line);
    var out = { methodology: METHODOLOGY.edge_capture,
      basis: pm ? 'CONTRACT' : ((has(o.ref) && !refSame) || (has(o.close) && !closeSame)) ? 'POINTS' : 'PRICE' };
    var eDec = refSame ? X.modelEv(o.platform_type, o.prob, o.ref) : null, eEnt = X.modelEv(o.platform_type, o.prob, o.entry);
    if (eDec != null) out.edge_at_decision = eDec;
    if (eEnt != null) out.edge_at_entry = eEnt;
    if (eDec != null && gt(eDec, '0') && eEnt != null) out.capture_ratio = D.divRound(eEnt, eDec, 4);
    if (refSame) { var s = X.priceSlip(o.platform_type, o.entry, o.ref); if (s != null) out.slip_pct = s; }
    else if (has(o.ref)) { var sp = X.lineGain(o.dir, o.entry_line, o.ref_line); if (sp != null) out.slip_points = sp; }
    if (closeSame) { var c = X.clvPct(o.platform_type, o.entry, o.close); if (c != null) out.clv_pct = c; }
    else if (has(o.close)) { var cp = X.lineGain(o.dir, o.entry_line, o.close_line); if (cp != null) out.clv_points = cp; }
    var lim = [];
    if (!has(o.prob)) lim.push('NO_MODEL_PROBABILITY');
    if (!has(o.ref)) lim.push('NO_DECISION_PRICE');
    if (!has(o.close)) lim.push('NO_CLOSE');
    lim.push(pm ? 'CONTRACT_PRICE_IS_PROBABILITY' : 'IMPLIED_PROBABILITY_INCLUDES_MARGIN');
    if (out.basis === 'POINTS') lim.push('POINTS_NOT_CONVERTED_TO_PROBABILITY');
    if (o.position_type === 'PLAYER_PROP') lim.push('PROP_MARKET_THIN');
    out.limitations = lim;
    return out;
  }

  /* ═══ 2. WORDS ════════════════════════════════════════════════════════ */
  var QUALITY_LABEL = { FULL: 'Full context', STRONG: 'Strong context', PARTIAL: 'Partial context', RESULT_ONLY: 'Result only' };
  var QUALITY_TEXT = {
    FULL: 'Recorded before the event with EdgeDesk\'s model state and a market price, and your own state at the time.',
    STRONG: 'Recorded before the event with a price to compare against, but not the full EdgeDesk and market state.',
    PARTIAL: 'Some of the decision is known — your reasoning before the event, or the market around it — but not both.',
    RESULT_ONLY: 'The wager and its result only. EdgeDesk did not observe the decision, so nothing about it is assumed.'
  };
  var CLASS_LABEL = { GOOD_WIN: 'Good win', GOOD_LOSS: 'Good loss', BAD_WIN: 'Bad win', BAD_LOSS: 'Bad loss', AVERAGE_PROCESS: 'Average process',
    NOT_CLASSIFIED: 'Not classified', NOT_APPLICABLE: 'Push, void or cash-out', OPEN: 'Open' };
  var CLASS_TEXT = {
    GOOD_WIN: 'A strong process (score 66 or more) and a win.',
    GOOD_LOSS: 'A strong process (score 66 or more) and a loss. The result went against a sound decision.',
    BAD_WIN: 'A weak process (score under 45) and a win. The result came despite the decision, not because of it.',
    BAD_LOSS: 'A weak process (score under 45) and a loss.',
    AVERAGE_PROCESS: 'A process score between 45 and 66: neither clearly strong nor weak.',
    NOT_CLASSIFIED: 'Not enough decision data to grade the process, so the result alone is not used to classify it.',
    NOT_APPLICABLE: 'No win or loss to set against the process.',
    OPEN: 'Not settled yet.'
  };
  var LIMITATION_TEXT = {
    PARLAY_NOT_DECOMPOSED: 'A parlay\'s legs are priced together; edge capture is not computed for it.',
    NO_ENTRY_PRICE: 'No entry price was recorded.',
    LIVE_ENTRY: 'Entered after the start: pre-event prices are not comparable.',
    NO_MODEL_PROBABILITY: 'No model probability was recorded before the event, so edge at entry is unavailable.',
    NO_DECISION_PRICE: 'No price was recorded at the decision, so slippage is unavailable.',
    NO_CLOSE: 'No closing price was recorded, so closing line value is unavailable — it is never estimated.',
    IMPLIED_PROBABILITY_INCLUDES_MARGIN: 'Prices are compared as decimal odds; the implied probabilities include the book\'s margin.',
    CONTRACT_PRICE_IS_PROBABILITY: 'A contract price is read as a probability; platform fees are not in it.',
    POINTS_NOT_CONVERTED_TO_PROBABILITY: 'The line moved, so the change is shown in points; points are not converted into probability.',
    PROP_MARKET_THIN: 'Player-prop markets are thinner; their closing prices are a weaker reference than a main market\'s.'
  };
  var FRESHNESS_TEXT = { FRESH: 'captured within 30 minutes of the decision', AGING: 'captured 30–90 minutes before the decision',
    STALE: 'captured more than 90 minutes before the decision — not current at the time', FUTURE: 'capture time ahead of the clock (a clock fault)',
    UNKNOWN: 'capture time unknown — not presented as current' };
  var ORIGIN_LABEL = { CARD: 'Saved to your Card, then recorded', RESEARCH: 'Recorded from EdgeDesk research', MANUAL: 'Recorded by you' };
  var STATUS_LABEL = { IMPROVING: 'Improving', DECLINED: 'Declined', UNCHANGED: 'Unchanged', INSUFFICIENT_NEW_EVIDENCE: 'Insufficient new evidence' };

  /* ═══ 3. EVIDENCE TESTS ═══════════════════════════════════════════════ */
  function mom(a) { return a ? X.moments(a[0], a[1], a[2]) : X.moments(0, 0, 0); }
  /* positions after a point against positions before it, on a metric where
     higher is better: the interval must exclude zero to say anything moved */
  function changeStatus(before, after) {
    var b = before && before.n != null ? before : mom(before), a = after && after.n != null ? after : mom(after);
    if (!(a.n >= X.MIN.observation) || !(b.n >= X.MIN.observation)) {
      return { status: 'INSUFFICIENT_NEW_EVIDENCE', test: null, before: b, after: a, needed: Math.max(0, X.MIN.observation - (a.n || 0)) };
    }
    var w = X.welch(a, b);
    var st = !w ? 'INSUFFICIENT_NEW_EVIDENCE' : w.ci95[0] > 0 ? 'IMPROVING' : w.ci95[1] < 0 ? 'DECLINED' : 'UNCHANGED';
    return { status: st, test: w, before: b, after: a, needed: 0 };
  }
  /* one pattern from portfolio_insight_memory(): FIRST DETECTED · THEN · NOW · STATUS */
  function memoryItem(row) {
    var i = row.insight || {}, f = row.first || {}, l = row.latest || {};
    var then = mom(f.grp), now = mom(l.since_first), ch = changeStatus(mom(l.before_first), now);
    return { id: i.id, label: i.label, kind: i.kind, metric: i.metric, dim: i.dim, key: i.key, first_detected_at: i.first_detected_at,
      then: then, then_comparison: mom(f.comparison), now: now, now_all: mom(l.grp), status: ch.status, test: ch.test, needed: ch.needed,
      observations: row.observations || 1, latest_at: l.observed_at, position_count: l.position_count, excluded: l.excluded || {},
      methodology: l.methodology_version || i.methodology_version, confidence: l.confidence };
  }
  /* change against the frozen baseline, on process score and CLV */
  function baselineChange(b) {
    if (!b) return null;
    if (b.status !== 'FROZEN') return { status: 'BUILDING', n: b.n || 0, needed: b.needed || 0 };
    var r = b.recent || {}, out = { status: 'FROZEN', n: b.n, frozen_at: b.frozen_at, first_placed: b.first_placed, last_placed: b.last_placed,
      recent_n: r.n || 0, recent_from: r.from, recent_to: r.to };
    ['ps', 'clv'].forEach(function (k) { out[k] = changeStatus(mom(b.moments && b.moments[k]), mom(r.moments && r.moments[k])); });
    return out;
  }
  /* what the number of graded decisions makes possible — never a target */
  function depth(graded) {
    var n = +graded || 0, M = X.MIN;
    var level = n < M.observation ? 'BUILDING' : n < M.developing ? 'OBSERVATION' : n < M.strong ? 'DEVELOPING' : 'STRONG';
    var next = n < M.observation ? M.observation : n < M.developing ? M.developing : n < M.strong ? M.strong : null;
    var text = {
      BUILDING: 'Patterns are reported once ' + M.observation + ' decisions are graded.',
      OBSERVATION: 'Patterns can be noted, not yet tested. Tests reach developing confidence at ' + M.developing + ' graded decisions.',
      DEVELOPING: 'Patterns are tested and corrected for the number of tests run. The strongest evidence level needs ' + M.strong + '.',
      STRONG: 'Every test, including the most-recent holdout check, has the sample it needs.'
    }[level];
    return { level: level, graded: n, next: next, thresholds: [M.observation, M.developing, M.strong], text: text,
      note: 'Depth comes from recording the decisions you already make and from importing past history — not from placing more.' };
  }

  /* ═══ 4. CONTINUITY: CARD → RECORD POSITION ═══════════════════════════ */
  var MARKET_TYPE = { spread: 'SPREAD', total: 'TOTAL', moneyline: 'MONEYLINE' };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localInput(t) {
    var v = ms(t); if (v == null) return '';
    var d = new Date(v);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function american(x) { var n = Number(x); return isFinite(n) && (n >= 100 || n <= -100) ? Math.round(n) : null; }
  /* the Record Position form's values from a Card entry: what the Card holds,
     nothing more. The stake is the entry's units at the reader's unit, only
     when both are known; the reader confirms or changes every field. */
  function prefillFromCard(e, opts) {
    opts = opts || {};
    if (!e) return null;
    var cur = opts.current || null;
    var am = cur && american(cur.american) != null ? american(cur.american) : american(e.american);
    var line = cur && cur.line != null ? cur.line : e.line;
    var book = (cur && cur.book) || e.book || '';
    var platform = E.resolvePlatform(book) || '';
    var type = e.type === 'PLAYER_PROP' ? 'PLAYER_PROP' : (MARKET_TYPE[e.market] || 'OTHER');
    var event = e.away && e.home ? e.away + ' @ ' + e.home : (e.home || e.away || '');
    var sel = e.type === 'PLAYER_PROP' ? (e.player_name ? e.player_name + ' ' : '') + (e.selection || '') : (e.selection || '');
    var units = Number(e.units), unit = Number(opts.unit);
    var stake = e.decision === 'BET' && units > 0 && unit > 0 ? (Math.round(units * unit * 100) / 100).toFixed(2) : '';
    return {
      platform: platform, platform_other: platform ? '' : String(book).slice(0, 60), position_type: type,
      sport: e.sport || '', league: e.league ? String(e.league).toUpperCase() : '',
      event_name: event.slice(0, 200), market_name: (e.market_label || e.market || '').slice(0, 200), selection: String(sel).trim().slice(0, 200),
      line: line == null || type === 'MONEYLINE' ? '' : String(line), odds: am == null ? '' : (am > 0 ? '+' + am : String(am)), odds_format: 'american',
      stake: stake, stake_type: 'CASH', status: 'OPEN', placed_at: localInput(opts.now || new Date().toISOString()),
      event_start_at: localInput(e.kickoff), edge_source: 'EDGEDESK', notes: '',
      _card: { entry_id: e.entry_id, saved_at: e.saved_at, decision: e.decision, units: e.units }
    };
  }
  /* the decision snapshot that is stored with the position: EdgeDesk's state
     as the Card froze it, and the market as last observed (the current read
     when the page has one, else the price the Card saved, with its own
     capture time — the server says how old it was) */
  function snapshotFromCard(e, cur) {
    if (!e) return null;
    var s = e.snapshot || {}, m = s.model || {}, mv = s.market_view || {}, pr = s.price || {};
    var fairAm = american(m.fair_american);
    var useCur = cur && american(cur.american) != null && cur.captured_at;
    var market = useCur
      ? { captured_at: cur.captured_at, book: cur.book || null, odds_american: american(cur.american), line: cur.line == null ? null : cur.line,
          source: 'card_current' }
      : { captured_at: e.captured_at || pr.captured_at || null, book: e.book || null, odds_american: american(e.american),
          line: e.line == null ? null : e.line, source: 'card_saved' };
    if (mv.consensus_line != null) market.consensus_line = mv.consensus_line;
    if (mv.novig_side != null) market.consensus_probability = mv.novig_side;
    if (mv.n_books != null) market.n_books = mv.n_books;
    if (s.sig_key) market.sig_key = s.sig_key;
    var ed = { model_version: m.model_version || s.model_version || null, calibration_version: m.calibration_version || null,
      pricing_version: m.pricing_version || null, engine: s.engine || null,
      research_id: s.decision_id || s.prop_id || e.opportunity_id || null, probability: e.probability, probability_source: e.probability_source || null,
      fair_odds_decimal: fairAm != null ? E.americanToDecimal(fairAm) : null, fair_line: m.fair_line == null ? null : m.fair_line,
      ev: e.ev, edge_pp: e.edge_pp, confidence: e.confidence, decision: e.decision, stage: e.stage || null, evaluated_at: e.evaluated_at || null };
    Object.keys(ed).forEach(function (k) { if (ed[k] == null) delete ed[k]; });
    Object.keys(market).forEach(function (k) { if (market[k] == null) delete market[k]; });
    return { origin: 'CARD', origin_ref: e.entry_id, saved_at: e.saved_at || null, edgedesk: ed, market: market };
  }

  /* questions worth asking, from the reader's own evidence only: a supported
     pattern, or a remembered one whose new evidence moved. Each names its
     numbers and its WHY. Never an instruction. fmt(metric, value) formats. */
  function questions(headlines, memory, fmt) {
    var out = [], f0 = fmt || function (m, v) { return v == null ? '—' : String(Math.round(v * 1000) / 1000); };
    ((headlines && headlines.not_working) || []).slice(0, 2).forEach(function (f) {
      out.push({ why: 'f:' + f.id, text: 'Your ' + X.keyLabel(f.dim, f.key) + ' positions averaged ' + f0(f.metric, f.cell.mean) + ' ' + (f.metric_label || '') + ' against '
        + f0(f.metric, f.comparison.mean) + ' for your other ' + f.comparison.n + ' (' + f.cell.n + ' positions). What is different about how these are decided?' });
    });
    (memory || []).forEach(function (m) {
      if (out.length >= 3 || m.kind !== 'LEAK' || m.status === 'INSUFFICIENT_NEW_EVIDENCE') return;
      out.push({ why: 'mem:' + m.id, text: '"' + m.label + '" was first detected ' + String(m.first_detected_at || '').slice(0, 10) + '. Since then ' + m.now.n
        + ' positions averaged ' + f0(m.metric, m.now.mean) + ' — ' + (STATUS_LABEL[m.status] || m.status).toLowerCase() + '. What, if anything, changed in how they were decided?' });
    });
    return out.slice(0, 3);
  }
  /* an experiment's pre-registered test over the evidence the server froze
     (portfolio_experiment_evidence): the same rule as evaluateExperiment */
  function experimentTest(ev) {
    var wm = ev && ev.window && ev.window.moments, bm = ev && ev.baseline && ev.baseline.moments, min = (ev && ev.min_sample) || 20;
    var a = mom(wm), b = mom(bm), w = X.welch(a, b);
    var status = !w || a.n < min || b.n < min ? 'INCONCLUSIVE' : w.ci95[0] > 0 ? 'SUPPORTED' : (w.ci95[1] < 0 || w.diff <= 0) ? 'NOT_SUPPORTED' : 'INCONCLUSIVE';
    return { status: status, window: a, baseline: b, test: w,
      payload: { status: status, ci_lo: w ? w.ci95[0] : null, ci_hi: w ? w.ci95[1] : null, p: w ? w.p : null, df: w ? w.df : null } };
  }

  /* ═══ 5. ASK ABOUT THIS DECISION ═════════════════════════════════════
     A plain account of one Decision Record, every sentence from the record
     itself (portfolio_decision_record): what was known before, the entry,
     what the market did, the result and the grade, and what none of it says.
     Nothing is estimated, and nothing missing is filled in. */
  function pctS(x, d) { if (!has(x)) return null; var v = 100 * +x; return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d) + '%'; }
  function priceS(dec, price, type) {
    if (type === 'PREDICTION_MARKET' || (!has(dec) && has(price))) return has(price) ? E.priceText(String(price)) : null;
    if (!has(dec)) return null;
    var a = E.decimalToAmerican(String(dec)); return a == null ? String(dec) : E.americanText(a);
  }
  function lineS(l) { return has(l) ? ' (' + (+l > 0 ? '+' : '') + (+l) + ')' : ''; }
  function whenS(t) { var v = ms(t); if (v == null) return null; try { return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return String(t).slice(0, 16); } }
  function explain(rec) {
    if (!rec || !rec.position) return [];
    var p = rec.position, type = p.platform_type, b = rec.before || {}, sn = b.snapshot, en = rec.entry || {}, rs = rec.result || {}, g = rec.grade || {}, ec = g.edge_capture || {};
    var out = [];
    if (sn) {
      var ed = sn.edgedesk || {}, mk = sn.market || {};
      var said = ed.decision ? 'EdgeDesk\'s decision was ' + ed.decision + (has(ed.probability) ? ' with a ' + (100 * +ed.probability).toFixed(1) + '% probability' : '')
        + (has(ed.fair_odds_decimal) ? ', fair price ' + priceS(ed.fair_odds_decimal, null, type) : '') + (has(ed.ev) ? ', expected value ' + pctS(ed.ev) : '')
        + (ed.model_version ? ' (model ' + ed.model_version + ')' : '') + '.' : 'EdgeDesk\'s model state was not part of this record.';
      var mkt = has(mk.odds_decimal) || has(mk.price) ? ' The market showed ' + (mk.book ? mk.book + ' ' : '') + priceS(mk.odds_decimal, mk.price, type) + lineS(mk.line)
        + ', captured ' + (whenS(mk.captured_at) || 'at an unknown time') + ' — ' + (FRESHNESS_TEXT[sn.market_freshness] || sn.market_freshness) + '.' : ' No market price was captured at the decision.';
      out.push({ h: 'Before', t: 'When you recorded it (' + whenS(sn.recorded_at) + '), ' + said.charAt(0).toLowerCase() + said.slice(1) + mkt });
    } else {
      out.push({ h: 'Before', t: 'EdgeDesk did not observe this decision when it was made, so nothing about what you knew then is assumed.'
        + (b.journal && b.journal.thesis ? ' Your journal says: "' + b.journal.thesis + '".' : '') });
    }
    var entry = 'You entered at ' + (priceS(en.odds_decimal, en.average_entry_price, type) || 'a price not recorded') + lineS(en.line) + ' on ' + (whenS(en.placed_at) || '—') + '.';
    if (has(ec.slip_pct)) entry += ' That was ' + pctS(Math.abs(+ec.slip_pct), 2).replace('+', '') + (+ec.slip_pct >= 0 ? ' better' : ' worse') + ' than the price at your decision.';
    else if (has(ec.slip_points)) entry += ' The line was ' + Math.abs(+ec.slip_points) + ' point' + (Math.abs(+ec.slip_points) === 1 ? '' : 's') + (+ec.slip_points >= 0 ? ' better' : ' worse') + ' than at your decision.';
    out.push({ h: 'Entry', t: entry });
    var path = (rec.market_path || []).filter(function (m) { return m.kind === 'QUOTE' || m.kind === 'CLOSE'; });
    out.push({ h: 'Market path', t: path.length ? path.length + ' later price' + (path.length === 1 ? ' was' : 's were') + ' recorded; the last was ' + (priceS(path[path.length - 1].odds_decimal, path[path.length - 1].price, type) || '—')
      + lineS(path[path.length - 1].line) + (path[path.length - 1].time_basis === 'RECORDED' ? ', at the time it was recorded.' : ', observed ' + whenS(path[path.length - 1].observed_at) + '.')
      : 'No later prices were observed, so nothing is said about how the market moved.' });
    var res = rs.result ? 'It settled: ' + rs.result.toLowerCase() + (has(rs.profit_loss) ? ' (' + E.money(String(rs.profit_loss), { sign: true }) + ')' : '') + '.' : 'It has not settled.';
    var close = has(rs.closing_odds_decimal) || has(rs.closing_price) ? ' The close was ' + priceS(rs.closing_odds_decimal, rs.closing_price, type) + lineS(rs.closing_line)
      + ' (from ' + ({ USER: 'you', PLATFORM: 'the platform', EDGEDESK_CAPTURE: 'EdgeDesk\'s capture' }[rs.closing_source] || 'an unnamed source') + ')'
      + (has(g.clv_pct) ? ', so your entry ' + (+g.clv_pct >= 0 ? 'beat' : 'trailed') + ' the close by ' + pctS(Math.abs(+g.clv_pct), 2).replace('+', '') + ' of price.' : has(g.clv_points) ? ', ' + g.clv_points + ' points from your line.' : '.')
      : ' No closing price was recorded, so closing line value is unknown — it is never estimated.';
    out.push({ h: 'Result', t: res + close });
    var oc = g.outcome || {};
    out.push({ h: 'Grade', t: (has(g.process_score) ? 'Process score ' + g.process_score + ' (' + g.grade + '), from the prices recorded before the decision; the result is not an input. '
      : 'Not graded: there was no price to judge the decision by. ') + (CLASS_LABEL[oc.class] ? CLASS_LABEL[oc.class] + ': ' + (CLASS_TEXT[oc.class] || '') : '') });
    var lim = (ec.limitations || []).map(function (k) { return LIMITATION_TEXT[k]; }).filter(Boolean);
    out.push({ h: 'What this does not say', t: 'One decision is not a pattern: patterns are only tested across ' + X.MIN.observation + ' or more. '
      + (lim.length ? lim.join(' ') + ' ' : '') + 'Whether to make a decision like it again is yours.' });
    return out;
  }

  return {
    METHODOLOGY: METHODOLOGY, freshness: freshness, contextQuality: contextQuality, outcomeClass: outcomeClass, edgeCapture: edgeCapture,
    QUALITY_LABEL: QUALITY_LABEL, QUALITY_TEXT: QUALITY_TEXT, CLASS_LABEL: CLASS_LABEL, CLASS_TEXT: CLASS_TEXT, LIMITATION_TEXT: LIMITATION_TEXT,
    FRESHNESS_TEXT: FRESHNESS_TEXT, ORIGIN_LABEL: ORIGIN_LABEL, STATUS_LABEL: STATUS_LABEL,
    moments: mom, changeStatus: changeStatus, memoryItem: memoryItem, baselineChange: baselineChange, depth: depth,
    prefillFromCard: prefillFromCard, snapshotFromCard: snapshotFromCard, questions: questions, experimentTest: experimentTest, explain: explain
  };
}));

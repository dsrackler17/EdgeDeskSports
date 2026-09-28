/* ===========================================================================
   EDGEDESK EXECUTION — which exact price is bettable, and what nearby prices
   would change the decision. docs/bettor-decision/QUALITY_UPGRADE.md §3

     curve(classify, sel)     the PRICE-VALUE CURVE: line × odds → cover,
                              break-even, edge, calibrated EV, decision, units,
                              every point priced by the decision engine's own
                              rules (classify is handed in by EDDecision)
     ladder(classify, sel)    only the MEANINGFUL TRANSITION POINTS of that
                              curve: "+13 PASS · +13.5 WATCH · +14 BET 0.25U ·
                              +14.5 BET 0.50U" — never thirty alternate lines
     bestExecution(cands)     the quote to execute on the recommended side,
                              with the runner-up and WHY in plain words
     halfPointValue / keyNumbers
                              the value of a half point from THIS game's own
                              outcome distribution, and a league's key numbers
                              derived from its learned margin distribution
                              (football/validation/key_numbers.json)

   WHAT THIS FILE NEVER DOES
     - invent a probability. Every point on the curve comes from `classify`,
       which prices a hypothetical quote through EDQuoteEV on the same model
       and applies the same thresholds, caps and sizing as the decision.
     - invent a composite "best balance" score. Best execution uses the
       decision engine's own documented objective (decision class, then
       decision EV per unit of return volatility) after execution gates
       (verified price, fresh quote, validated tail, book on the market).
       Line value, juice and key-number protection are all already inside
       the decision EV, because the distribution carries the key-number mass.
     - treat an NFL half point like a college one, or +2.5 → +3 like
       +8.5 → +9: the value of each move is read off the distribution.

   Browser: window.EDExecution. Node: require('./edgedesk_execution.js').
   ES5, no dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDExecution = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_execution_v1';
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }
  function a2d(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  /* American odds `cents` better for the bettor (−110 → −105 is 5 cents; −105 → +100 crosses even money) */
  function stepPrice(a, cents) {
    a = num(a); if (a == null) return null;
    var x = a < 0 ? a + cents : a + cents;
    if (a < 0 && x > -100) x = 100 + (x + 100);
    else if (a > 0 && x < 100) x = -100 - (100 - x);
    x = Math.round(x);
    return x === -100 ? 100 : x;
  }
  var RANK = { NO_DECISION: -1, PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };

  var CONFIG = {
    version: 'edgedesk_execution_config_v1',
    line_step: 0.5,
    /* how far the line ladder looks on each side of the current number */
    lines_below: 4, lines_above: 3,
    /* the price ladder at the current line, in cents */
    price_steps: [-20, -15, -10, -5, 5, 10, 15, 20, 30],
    max_rows: 7,
    /* key numbers: a margin is PRIMARY at ≥ 2× the league's average mass of
       margins 1-21 (and ≥ 6%), SECONDARY at ≥ 1.25× */
    key_rule: { primary_ratio: 2.0, primary_min: 0.06, secondary_ratio: 1.25, range: [1, 21] }
  };

  /* ============================================================ STATE
     One label per curve point: BET 0.50U / LEAN / WATCH / PASS. */
  function stateOf(p) { if (!p) return 'N/A'; return p.cls === 'BET' ? 'BET ' + unitsText(p.units) : p.cls; }
  function better(mt, side, a, b) {
    /* is line a better for the bettor than line b? */
    if (mt === 'total') return side === 'under' ? a > b + EPS : a < b - EPS;
    return a > b + EPS;
  }
  function lineGrid(mt, side, L0) {
    var out = [], k, step = CONFIG.line_step, dir = mt === 'total' && side === 'over' ? -1 : 1;
    for (k = -Math.round(CONFIG.lines_below / step); k <= Math.round(CONFIG.lines_above / step); k++) out.push(r(L0 + dir * k * step, 2));
    return out;
  }

  /* ============================================================ CURVE
     classify(line, american) → {cls, units, cover, break_even, edge_pp, ev,
     raw_ev, calibrated_ev, source, capped_by} | null (unpriceable). */
  function curve(classify, sel, opts) {
    opts = opts || {};
    if (typeof classify !== 'function' || !sel) return null;
    var mt = sel.market_type === 'alternate_spread' ? 'spread' : (sel.market_type || 'spread');
    var L0 = num(sel.line), P0 = num(sel.american_odds != null ? sel.american_odds : sel.odds);
    if (P0 == null) return null;
    var lines = mt === 'moneyline' || L0 == null ? [null] : lineGrid(mt, sel.side, L0);
    var prices = [P0].concat(CONFIG.price_steps.map(function (c) { return stepPrice(P0, c); })).filter(function (p, i, a) { return p != null && a.indexOf(p) === i; });
    prices.sort(function (a, b) { return a2d(a) - a2d(b); });
    var points = [];
    lines.forEach(function (ln) {
      prices.forEach(function (px) {
        var c = null;
        try { c = classify(ln, px); } catch (e) { c = null; }
        if (!c) return;
        var d = a2d(px);
        points.push({ line: ln, odds: px, decimal: r(d, 4), cover: r(c.cover, 4), break_even: r(c.break_even, 4), edge_pp: r(c.edge_pp, 2), ev: r(c.ev, 4),
          raw_ev: r(c.raw_ev, 4), calibrated_ev: r(c.calibrated_ev, 4), cls: c.cls, units: c.cls === 'BET' ? (c.units || 0) : 0, capped_by: c.capped_by || null,
          current: ln === L0 && px === P0 || (ln == null && L0 == null && px === P0) });
      });
    });
    return { market_type: mt, side: sel.side, team: sel.team || null, line: L0, odds: P0, points: points, n: points.length,
      basis: 'Each point is a hypothetical quote priced on the same model and decided by the same thresholds, caps and sizing as the live decision, holding the rest of the market where it is.' };
  }

  /* ============================================================ LADDER
     The transition points only: where the decision or the stake changes as
     the line improves at the current price, and as the price improves at the
     current line. The current row is always kept. */
  function transitions(rows, keyOf) {
    var out = [], last = null, states = {};
    rows.forEach(function (p) { states[stateOf(p)] = true; });
    var flat = Object.keys(states).length <= 1;
    rows.forEach(function (p, i) {
      var s = stateOf(p);
      /* a row is kept where the decision or the stake changes (the first
         number at which the new state holds), and the current row always */
      if (p.current || (!flat && i > 0 && s !== last)) out.push({ line: p.line, odds: p.odds, state: s, cls: p.cls, units: p.units, edge_pp: p.edge_pp, ev: p.ev, calibrated_ev: p.calibrated_ev, cover: p.cover, current: !!p.current, capped_by: p.capped_by, key: keyOf ? keyOf(p) : null });
      last = s;
    });
    /* the state before the first change, so the list reads from where it starts */
    if (!flat && rows.length && out.length && out[0] !== undefined) {
      var first = rows[0], fs = stateOf(first);
      if (!(out[0].line === first.line && out[0].odds === first.odds) && fs !== out[0].state) out.unshift({ line: first.line, odds: first.odds, state: fs, cls: first.cls, units: first.units, edge_pp: first.edge_pp, ev: first.ev, calibrated_ev: first.calibrated_ev, cover: first.cover, current: !!first.current, capped_by: first.capped_by, key: keyOf ? keyOf(first) : null, from_edge: true });
    }
    /* keep the rows on each side of the current one; cap the list */
    if (out.length > CONFIG.max_rows) {
      var ci = 0; out.forEach(function (x, i) { if (x.current) ci = i; });
      var lo = Math.max(0, Math.min(ci - 2, out.length - CONFIG.max_rows));
      out = out.slice(lo, lo + CONFIG.max_rows);
    }
    return out;
  }
  function ladder(classify, sel, opts) {
    opts = opts || {};
    var C = opts.curve || curve(classify, sel, opts);
    if (!C || !C.points.length) return null;
    var mt = C.market_type, P0 = C.odds, L0 = C.line, team = sel.team || sel.side;
    var lineRows = C.points.filter(function (p) { return p.odds === P0 && p.line != null; })
      .sort(function (a, b) { return better(mt, sel.side, b.line, a.line) ? -1 : (better(mt, sel.side, a.line, b.line) ? 1 : 0); });
    var priceRows = C.points.filter(function (p) { return (L0 == null ? p.line == null : p.line === L0); }).sort(function (a, b) { return a.decimal - b.decimal; });
    var keyOf = opts.pushMass ? function (p) { if (!isNum(p.line) || Math.abs(p.line - Math.round(p.line)) > EPS) return null; var m = opts.pushMass(sel.side, p.line); return isNum(m) && m >= 0.03 ? { margin: Math.abs(p.line), push_mass: r(m, 4) } : null; } : null;
    var byLine = mt === 'moneyline' ? [] : transitions(lineRows, keyOf);
    var byPrice = transitions(priceRows, null);
    var cur = C.points.filter(function (p) { return p.current; })[0] || null;
    function label(p) { return (mt === 'total' ? String(sel.side || '').charAt(0).toUpperCase() + String(sel.side || '').slice(1) + ' ' + p.line : (mt === 'moneyline' ? team + ' ML' : team + ' ' + lineText(p.line))) + ' (' + priceText(p.odds) + ')'; }
    byLine.forEach(function (x) { x.label = label(x); });
    byPrice.forEach(function (x) { x.label = label(x); });
    /* the first line / price that reaches BET, and the first that reaches each larger stake */
    var nextBet = null;
    lineRows.concat(priceRows).forEach(function (p) { if (!nextBet && p.cls === 'BET' && (!cur || cur.cls !== 'BET')) nextBet = p; });
    var span = lineRows.length ? ' (checked ' + (mt === 'total' ? lineRows[0].line + ' to ' + lineRows[lineRows.length - 1].line : lineText(lineRows[0].line) + ' to ' + lineText(lineRows[lineRows.length - 1].line)) + ' at ' + priceText(P0) + (priceRows.length ? ', ' + priceText(priceRows[0].odds) + ' to ' + priceText(priceRows[priceRows.length - 1].odds) + (L0 == null ? '' : ' at ' + lineText(L0)) : '') + ')' : '';
    var tline = function (x) { return (mt === 'total' ? String(x.line) : lineText(x.line)) + ' ' + x.state + (x.current ? ' (now)' : ''); };
    var tprice = function (x) { return priceText(x.odds) + ' ' + x.state + (x.current ? ' (now)' : ''); };
    var sLine = byLine.length > 1 ? 'At ' + priceText(P0) + ': ' + byLine.map(tline).join(' · ') : null;
    var sPrice = byPrice.length > 1 ? 'At ' + (L0 == null ? 'this market' : (mt === 'total' ? String(L0) : lineText(L0))) + ': ' + byPrice.map(tprice).join(' · ') : null;
    var summary = sLine || sPrice ? [sLine, sPrice].filter(Boolean).join(' | ') : (cur ? label(cur) + ' ' + stateOf(cur) + ' — no nearby price changes the decision' + span : null);
    return { market_type: mt, side: sel.side, team: team, current: cur ? { line: cur.line, odds: cur.odds, state: stateOf(cur) } : null,
      by_line: byLine, by_price: byPrice, summary: summary, summary_line: sLine, summary_price: sPrice, flat: byLine.length <= 1 && byPrice.length <= 1,
      first_bet: nextBet ? { line: nextBet.line, odds: nextBet.odds, state: stateOf(nextBet), label: label(nextBet) } : null,
      at_price: priceText(P0), at_line: L0 == null ? null : (mt === 'total' ? String(L0) : lineText(L0)),
      caveat: 'Computed from EdgeDesk’s decision rules at each nearby number, holding the rest of the market where it is. If the whole market moves, EdgeDesk re-prices every number.' };
  }

  /* ===================================================== BEST EXECUTION
     cands: the decision engine's candidate summaries for this game (side,
     team, line, odds, book, captured_at, quote_age_minutes, decision_ev,
     calibrated_ev, raw_ev, risk_adjusted, classification, price_unverified,
     tail, is_main_line, label). opts.side: the recommended side.
     opts.market: the canonical market (outlier books). opts.pushMass(side, k):
     this game's probability that the side's margin lands exactly on k. */
  function excludedWhy(c, opts) {
    var M = opts.market || {};
    if (c.price_unverified) return 'failed price verification';
    if ((M.outliers || []).some(function (o) { return String(o.book).toLowerCase() === String(c.book || '').toLowerCase(); })) return 'this book’s main number is off the market';
    if (isNum(c.quote_age_minutes) && isNum(opts.max_age_minutes) && c.quote_age_minutes > opts.max_age_minutes) return 'stale quote';
    if (c.tail === 'NOT_VALIDATED' || (c.tail === 'UNKNOWN' && !c.is_main_line)) return 'alternate outside the validated tail';
    if (!isNum(c.decision_ev)) return 'not priceable';
    return null;
  }
  function execRank(a, b) {
    var ra = RANK[a.classification] == null ? -1 : RANK[a.classification], rb = RANK[b.classification] == null ? -1 : RANK[b.classification];
    if (ra !== rb) return rb - ra;
    if (isNum(a.risk_adjusted) && isNum(b.risk_adjusted) && Math.abs(a.risk_adjusted - b.risk_adjusted) > 1e-6) return b.risk_adjusted - a.risk_adjusted;
    if (!!a.is_main_line !== !!b.is_main_line) return a.is_main_line ? -1 : 1;
    if (Math.abs((a.decision_ev || 0) - (b.decision_ev || 0)) > EPS) return (b.decision_ev || 0) - (a.decision_ev || 0);
    return (b.line || 0) - (a.line || 0);
  }
  function keysCrossed(side, from, to, pushMass) {
    if (!isNum(from) || !isNum(to) || typeof pushMass !== 'function') return [];
    var lo = Math.min(from, to), hi = Math.max(from, to), out = [];
    for (var k = Math.ceil(lo - EPS); k <= Math.floor(hi + EPS); k++) {
      if (k === 0) continue;
      var m = pushMass(side, k);
      if (isNum(m) && m >= 0.03) out.push({ line: k, margin: Math.abs(k), push_mass: r(m, 4) });
    }
    return out;
  }
  function explain(best, alt, opts) {
    if (!best) return null;
    var evTxt = function (c) { return pctText(isNum(c.calibrated_ev) ? c.calibrated_ev : c.decision_ev) + (isNum(c.calibrated_ev) ? ' calibrated EV' : ' EV'); };
    if (!alt) return best.label + ' at ' + best.book + ' is the only verified quote on this side worth executing.';
    var sameLine = isNum(best.line) && isNum(alt.line) && Math.abs(best.line - alt.line) < EPS;
    if (sameLine) return 'Same number, better price: ' + priceText(best.odds) + ' at ' + best.book + ' against ' + priceText(alt.odds) + ' at ' + alt.book + ' (' + evTxt(best) + ' vs ' + evTxt(alt) + ').';
    var mt = best.market_type, side = best.side;
    var morePts = mt === 'moneyline' ? false : better(mt, side, best.line, alt.line);
    var dB = a2d(best.odds), dA = a2d(alt.odds);
    var keys = mt === 'spread' ? keysCrossed(side, alt.line, best.line, opts.pushMass) : [];
    var keyTxt = keys.length ? ' crosses ' + (keys.length === 1 ? 'a key number (' + keys[0].margin + ': ' + (100 * keys[0].push_mass).toFixed(1) + '% of this game’s outcomes land there)' : 'key numbers ' + keys.map(function (k) { return k.margin; }).join(' and ')) : '';
    if (morePts && dB < dA - EPS) return lineText(best.line) + keyTxt + (keyTxt ? ' and' : '') + ' produces higher ' + (isNum(best.calibrated_ev) ? 'calibrated ' : '') + 'EV (' + evTxt(best) + ' vs ' + evTxt(alt) + ') despite the additional juice (' + priceText(best.odds) + ' vs ' + priceText(alt.odds) + ').';
    if (morePts) return lineText(best.line) + ' is more points at no worse a price' + (keyTxt ? ' and' + keyTxt : '') + ' (' + evTxt(best) + ' vs ' + evTxt(alt) + ').';
    var ksold = mt === 'spread' ? keysCrossed(side, best.line, alt.line, opts.pushMass) : [];
    return 'Giving up ' + (mt === 'spread' ? 'the ' + (Math.abs(alt.line - best.line) <= 0.5 + EPS ? 'hook' : Math.abs(alt.line - best.line) + ' points') : 'the better number') + (ksold.length ? ' (through ' + ksold.map(function (k) { return k.margin; }).join(', ') + ')' : '') + ' for ' + priceText(best.odds) + ' is worth more than the extra points at ' + priceText(alt.odds) + ' (' + evTxt(best) + ' vs ' + evTxt(alt) + ').';
  }
  function bestExecution(cands, opts) {
    opts = opts || {};
    var side = opts.side, mt = opts.market_type || null;
    var mine = (cands || []).filter(function (c) { return c && (!side || c.side === side) && (!mt || (c.market_type === 'alternate_spread' ? 'spread' : c.market_type) === mt); });
    var excluded = [], ok = [];
    mine.forEach(function (c) { var w = excludedWhy(c, opts); if (w) excluded.push({ label: c.label, book: c.book, why: w }); else ok.push(c); });
    ok.sort(execRank);
    var best = ok[0] || null;
    if (opts.selected && best && !(best.book === opts.selected.book && best.line === opts.selected.line && best.odds === opts.selected.odds)) {
      /* the decision's own quote is the execution when it is executable: one answer, never two */
      var own = ok.filter(function (c) { return c.book === opts.selected.book && c.line === opts.selected.line && c.odds === opts.selected.odds; })[0];
      if (own) best = own;
    }
    /* the runner-up worth naming: the best executable quote at a DIFFERENT line (the
       points-vs-juice trade-off), else the same line at another book */
    var alt = null;
    ok.forEach(function (c) { if (!best || c === best) return; if (!alt && isNum(c.line) && isNum(best.line) && Math.abs(c.line - best.line) > EPS) alt = c; });
    if (!alt) ok.forEach(function (c) { if (!alt && c !== best) alt = c; });
    function pick(c) { return c ? { label: c.label, side: c.side, team: c.team, line: c.line, odds: c.odds, book: c.book, captured_at: c.captured_at, is_main_line: !!c.is_main_line,
      decision_ev: c.decision_ev, calibrated_ev: c.calibrated_ev, raw_ev: c.raw_ev, edge_pp: c.edge_pp, cover: c.decision_cover, classification: c.classification, risk_adjusted: c.risk_adjusted } : null; }
    return { best: pick(best), alternative: pick(alt), reason: explain(best, alt, opts), n_considered: mine.length, n_executable: ok.length, excluded: excluded.slice(0, 8),
      ranked: ok.slice(0, 5).map(pick),
      rule: 'Executable = verified price, fresh quote, validated tail, book on the market. Ranked by the decision engine’s own objective: decision class, then EV per unit of return volatility (line value, juice and key-number protection are already inside the EV).' };
  }

  /* ======================================================= KEY NUMBERS */
  function halfPointValue(pushWin, side, from, to) {
    /* pushWin(side, line) → {win, push, loss}; the value of moving from → to
       on the no-push cover basis and on the win+½push basis */
    if (typeof pushWin !== 'function') return null;
    var a = pushWin(side, from), b = pushWin(side, to);
    if (!a || !b) return null;
    var cov = function (p) { var d = p.win + p.loss; return d > 0 ? p.win / d : null; };
    return { from: from, to: to, win_gain: r(b.win - a.win, 5), push_mass_to: r(b.push, 5), push_mass_from: r(a.push, 5),
      cover_gain: isNum(cov(a)) && isNum(cov(b)) ? r(cov(b) - cov(a), 5) : null, half_push_gain: r((b.win + 0.5 * b.push) - (a.win + 0.5 * a.push), 5) };
  }
  /* a league's key numbers from its own absolute-margin mass (a map
     margin → share of games), never from a hardcoded list */
  function keyNumbers(absMass, over) {
    var R0 = (over && over.range) || CONFIG.key_rule.range, K = CONFIG.key_rule;
    var ms = [], k;
    for (k = R0[0]; k <= R0[1]; k++) { var v = num(absMass && absMass[k]); if (isNum(v)) ms.push([k, v]); }
    if (!ms.length) return null;
    var avg = ms.reduce(function (s, x) { return s + x[1]; }, 0) / ms.length;
    var primary = ms.filter(function (x) { return x[1] >= K.primary_ratio * avg - EPS && x[1] >= K.primary_min - EPS; }).map(function (x) { return x[0]; });
    var secondary = ms.filter(function (x) { return primary.indexOf(x[0]) < 0 && x[1] >= K.secondary_ratio * avg - EPS; }).map(function (x) { return x[0]; });
    var rank = ms.slice().sort(function (a, b) { return b[1] - a[1]; });
    return { primary: primary, secondary: secondary, average_mass: r(avg, 5), ranked: rank.slice(0, 10).map(function (x) { return { margin: x[0], mass: r(x[1], 5) }; }),
      rule: 'primary: mass ≥ ' + K.primary_ratio + '× the league average over margins ' + R0[0] + '–' + R0[1] + ' and ≥ ' + (100 * K.primary_min) + '%; secondary: ≥ ' + K.secondary_ratio + '×' };
  }

  return { VERSION: VERSION, CONFIG: CONFIG, curve: curve, ladder: ladder, bestExecution: bestExecution, explain: explain,
    halfPointValue: halfPointValue, keyNumbers: keyNumbers, keysCrossed: keysCrossed, stepPrice: stepPrice, stateOf: stateOf };
}));

/* ===========================================================================
   EDGEDESK NHL MARKET — EdgeDesk's NHL probability against one sportsbook
   price, and whether the comparison may be called value.

   Browser and Node (window.EDNHLMarket / module.exports). Pure: it reads a
   probability EdgeDesk already published and a quote, and returns numbers
   and a label. It never computes a hockey probability, and a price never
   moves a probability (no market input reaches the model: docs/engine/NHL.md).

   DEFINITIONS (per 1 unit risked; the same as lib/edgedesk_quote_ev.js,
   and tools/hockey/nhl_market.test.js checks parity)
     decimal       +A → 1 + A/100 ; −A → 1 + 100/A
     implied       1 / decimal (the book's price, vig included)
     break-even    1 / decimal on the DECIDED outcomes; with a push possible the
                   unconditional win probability needed is (1 − P(push)) / decimal
     cover         P(win) / (P(win) + P(lose))   (= P(win) on a half-goal line)
     EV            P(win)·(decimal − 1) − P(lose)   (a push returns the stake)
     fair decimal  1 / cover = (1 − P(push)) / P(win)   (EV = 0 there)
     no-vig        multiplicative, when both sides of the same book are quoted

   THE LABEL. Exactly one of
     VERIFIED_VALUE  every gate passes (below). Never shown today for the NHL:
                     no NHL market has been tested against closing prices.
     PROVISIONAL     positive EV and a validated model market, but at least one
                     other gate fails — each failure is listed
     RESEARCH_ONLY   positive EV, but the model's own market is not validated
                     against outcomes (totals, team totals, period markets...)
     PASS            EV ≤ 0 at the model's probability, no usable price, or a
                     settlement mismatch — nothing to consider
   GATES (all must pass for VERIFIED_VALUE)
     model_validated   the model market is OUTCOME_VALIDATED (held-out record)
     market_tested     the model market beat closing prices out of sample
                       (TESTED_AHEAD, n ≥ 500) — the only proof of value
     price_verified    captured from a named book through the gateway (a price
                       typed by hand is a scenario, not a verified quote)
     price_fresh       captured within `stale_minutes` (default 30)
     settlement        the quote settles as the model's market does
     edge_robust       EV still ≥ min_ev at the model probability minus one
                       uncertainty sd (the variant spread), and under every
                       goalie scenario when the starters are not confirmed
     data_fresh        the model's inputs are fresh
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDNHLMarket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_nhl_market_v1';
  var DEFAULTS = { stale_minutes: 30, min_ev: 0.02, market_min_n: 500 };

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function r(v, k) { if (v == null || !isFinite(v)) return null; var f = Math.pow(10, k == null ? 4 : k); return Math.round(v * f) / f; }
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decToAm(d) { if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function ev(win, push, decimal) { if (win == null || decimal == null) return null; var lose = Math.max(0, 1 - win - (push || 0)); return win * (decimal - 1) - lose; }
  function fairDecimal(win, push) { var pu = push || 0; return win > 0 && pu < 1 ? (1 - pu) / win : null; }
  function noVig(a, b) { var da = amToDec(a), db = amToDec(b); if (!da || !db) return null; var ia = 1 / da, ib = 1 / db; return { p: ia / (ia + ib), overround: ia + ib - 1 }; }

  /**
   * o = {
   *   market:  { kind, label, settles }               what is being bet
   *   model:   { p_win, p_push, sd_pp, status, market_status, market_n, scenario_p_win: [..] }
   *   quote:   { american, book, captured_at, source: 'captured'|'user_supplied', settles, other_american }
   *   context: { now, data_state, goalie_certainty }
   *   opts:    { stale_minutes, min_ev }
   * }
   */
  function evaluate(o) {
    o = o || {}; var m = o.model || {}, q = o.quote || null, mk = o.market || {}, cx = o.context || {};
    var opt = {}; for (var k in DEFAULTS) opt[k] = DEFAULTS[k]; for (var k2 in (o.opts || {})) opt[k2] = o.opts[k2];
    var win = num(m.p_win), push = num(m.p_push) || 0, lose = win == null ? null : Math.max(0, 1 - win - push);
    var out = { version: VERSION, market: mk, label: 'PASS', reasons: [], gates: [], numbers: {} };
    var fd = win == null ? null : fairDecimal(win, push);
    out.numbers.model_p_win = r(win); out.numbers.model_p_push = r(push); out.numbers.fair_decimal = r(fd, 4); out.numbers.fair_american = fd == null ? null : decToAm(fd);
    out.numbers.cover = win == null || lose == null || win + lose <= 0 ? null : r(win / (win + lose));
    if (win == null) { out.reasons.push('EdgeDesk has no probability for this market.'); return out; }
    var d = q ? amToDec(q.american) : null;
    if (!q || d == null) { out.reasons.push(q ? 'The price ' + q.american + ' is not a valid American price.' : 'No price to compare: the fair price is ' + (out.numbers.fair_american > 0 ? '+' : '') + out.numbers.fair_american + '.'); return out; }
    var now = num(cx.now) != null ? num(cx.now) : Date.now();
    var age = q.captured_at ? (now - Date.parse(q.captured_at)) / 60000 : null;
    var e = ev(win, push, d);
    var sd = (num(m.sd_pp) || 0) / 100;
    var eLow = ev(Math.max(0, win - sd), push, d);
    var scen = (m.scenario_p_win || []).filter(function (x) { return num(x) != null; });
    var eScenMin = scen.length ? Math.min.apply(null, scen.map(function (p) { return ev(p, push, d); })) : null;
    var nv = q.other_american != null ? noVig(q.american, q.other_american) : null;
    out.numbers.decimal = r(d, 4); out.numbers.implied = r(1 / d); out.numbers.break_even = r(1 / d); out.numbers.break_even_unconditional = r((1 - push) / d);
    out.numbers.ev = r(e); out.numbers.ev_at_minus_1sd = r(eLow); out.numbers.ev_worst_goalie_scenario = r(eScenMin);
    out.numbers.market_novig = nv ? r(nv.p) : null; out.numbers.overround = nv ? r(nv.overround) : null;
    out.numbers.disagreement_pp = nv ? r((out.numbers.cover - nv.p) * 100, 2) : r((out.numbers.cover - 1 / d) * 100, 2);
    out.numbers.disagreement_basis = nv ? 'cover minus the book\'s no-vig probability' : 'cover minus the book\'s implied probability (one side quoted; vig included)';
    out.numbers.quote_age_minutes = age == null ? null : r(age, 1);
    out.numbers.min_acceptable_american = decToAm(fd * (1 + opt.min_ev));

    var settleOk = !q.settles || !mk.settles || q.settles === mk.settles;
    var gate = function (name, ok, reason) { out.gates.push({ gate: name, ok: !!ok, reason: reason }); return !!ok; };
    var gModel = gate('model_validated', m.status === 'OUTCOME_VALIDATED', m.status === 'OUTCOME_VALIDATED' ? 'the model\'s ' + (mk.label || mk.kind) + ' is validated on held-out games' : 'the model\'s ' + (mk.label || mk.kind) + ' is ' + String(m.status || 'not validated').replace(/_/g, ' ').toLowerCase() + ' on held-out games');
    var gMarket = gate('market_tested', m.market_status === 'TESTED_AHEAD' && (num(m.market_n) || 0) >= opt.market_min_n, m.market_status === 'TESTED_AHEAD' ? 'beat closing prices out of sample (n ' + m.market_n + ')' : 'never tested against closing prices (' + String(m.market_status || 'NOT_TESTED').replace(/_/g, ' ').toLowerCase() + '): no licensed closing archive');
    var gPrice = gate('price_verified', q.source === 'captured', q.source === 'captured' ? 'captured from ' + (q.book || 'a named book') + ' through the gateway' : 'a price entered by hand is a scenario, not a verified quote');
    var gFresh = gate('price_fresh', age != null && age >= 0 && age <= opt.stale_minutes, age == null ? 'no capture time' : 'captured ' + Math.round(age) + ' min ago (limit ' + opt.stale_minutes + ')');
    var gSettle = gate('settlement', settleOk, settleOk ? 'settles as the model prices it (' + (mk.settles || 'standard rules') + ')' : 'the book settles "' + q.settles + '", the model prices "' + mk.settles + '"');
    var robust = eLow != null && eLow >= opt.min_ev && (cx.goalie_certainty === 'CONFIRMED' || eScenMin == null || eScenMin >= opt.min_ev);
    var gRobust = gate('edge_robust', robust, 'EV ' + pct(e) + ' at the model probability; ' + pct(eLow) + ' one sd lower' + (eScenMin != null && cx.goalie_certainty !== 'CONFIRMED' ? '; ' + pct(eScenMin) + ' under the least favourable goalie pairing' : '') + ' (needs ≥ ' + pct(opt.min_ev) + ')');
    var gData = gate('data_fresh', !cx.data_state || cx.data_state === 'FRESH', 'model inputs ' + String(cx.data_state || 'fresh').toLowerCase());

    if (!gSettle) { out.label = 'PASS'; out.reasons.push('Settlement mismatch: the comparison is not like for like.'); return out; }
    if (!(e > 0)) { out.label = 'PASS'; out.reasons.push('At ' + fmtAm(q.american) + ' the price is ' + (e === 0 ? 'exactly' : 'below') + ' fair (' + fmtAm(out.numbers.fair_american) + '): EV ' + pct(e) + '.'); return out; }
    if (!gModel) { out.label = 'RESEARCH_ONLY'; out.reasons.push('EV ' + pct(e) + ' on paper, but this model market is not validated on held-out games; it is research, not a value signal.'); return out; }
    if (gMarket && gPrice && gFresh && gRobust && gData) { out.label = 'VERIFIED_VALUE'; out.reasons.push('Every gate passes.'); return out; }
    out.label = 'PROVISIONAL';
    out.gates.forEach(function (g) { if (!g.ok) out.reasons.push(g.gate.replace(/_/g, ' ') + ': ' + g.reason); });
    return out;
  }
  function pct(v) { return v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%'; }
  function fmtAm(a) { a = num(a); return a == null ? '—' : (a > 0 ? '+' : '') + Math.round(a); }

  return { VERSION: VERSION, DEFAULTS: DEFAULTS, evaluate: evaluate, amToDec: amToDec, decToAm: decToAm, ev: ev, fairDecimal: fairDecimal, noVig: noVig };
});

/* ===========================================================================
   EDGEDESK EDGE P&L — profit and loss of every flagged edge (signals).
   docs/pnl/EDGE_PNL.md · supabase/signal_pnl*.sql

   One question: if you had put 1 unit on every edge EdgeDesk flagged, at the
   price on the screen when it was flagged, how many units would you be up or
   down? The database answers it (pnl_grades, pnl_summary); this file is the
   same arithmetic in the browser and in Node, so the page can fold the rows it
   reads and the tests can prove the two agree. It never fetches, never
   stores, never looks at a clock.

   THE RULES (the same as pnl_grade_compute, calc_version pnl-v1)
     price     the price frozen when the edge was flagged (flagged_best_dec).
               Never the close, never a later price. None, or not a real
               price → ungraded_missing_price. Nothing is estimated.
     win       +odds pays odds/100, -odds pays 100/|odds|. From the decimal
               capture stored that is d - 1: the same number, no rounding.
     loss      -1.   push  0.   void / cancelled  not a bet, counted apart.
     ROI       units won / units risked × 100. A push returns its stake, so
               it is not risked (the convention of every P&L on the site).
     record    only flags with an edge between 0.5% and 10% when flagged —
               the same rows as the CLV record beside it.

   Browser: window.EDEdgePnl.   Node: require('./edgedesk_edge_pnl.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDEdgePnl = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var CALC_VERSION = 'pnl-v1';
  var EDGE_BAND = [0.005, 0.1];
  var MAX_DEC = 1001;           // +100000: past it the number is a broken feed
  var VOID_WORDS = ['void', 'voided', 'cancelled', 'canceled', 'cancel', 'no_action', 'no action', 'noaction',
    'postponed', 'abandoned', 'refund', 'refunded', 'no_bet', 'no bet'];

  /* What a person needs to know about each tier, in plain words. The tier is
     frozen on the signal when it is flagged (signals.flagged_tier); nothing
     here re-classifies a flag. */
  var TIERS = {
    A: { key: 'A', label: 'Tier A', name: 'Checked against the sharpest book',
      blurb: 'Pinnacle — the book professional bettors treat as the true price — was quoting this exact bet, and the price we found beat its fair number.' },
    B: { key: 'B', label: 'Tier B', name: 'Checked against the other books',
      blurb: 'Pinnacle was not quoting it, so the price had to beat what the rest of the market agreed on, and show up on two separate scans before it counted.' },
    legacy: { key: 'legacy', label: 'Older flags', name: 'Before tiers existed',
      blurb: 'Flagged by an earlier version of the scanner, before every flag was labelled A or B. Kept, graded the same way, shown on their own.' }
  };
  var TIER_ORDER = ['A', 'B', 'legacy'];
  var MARKET_LABEL = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total', player_prop: 'Player prop', team_total: 'Team total', other: 'Other' };
  var STATUS_TEXT = {
    graded: 'Graded',
    void: 'Void — the game or bet was cancelled, so it is not a bet',
    ungraded_missing_price: 'Not graded — no price was saved when it was flagged',
    ungraded_unsettled: 'Not graded yet — waiting on the result'
  };
  var REASON_TEXT = {
    awaiting_result: 'waiting on the result',
    unrecognized_result: 'the result could not be read',
    no_flag_price: 'no price was saved when it was flagged',
    invalid_flag_price: 'the saved price is not a real price'
  };
  var METHOD_NOTE = '1 unit flat stake at the price when flagged. Pushes = 0. Missing prices are not estimated.';

  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    return isFinite(n) ? n : null;
  }
  function priceOk(dec) { dec = num(dec); return dec !== null && dec > 1 && dec <= MAX_DEC; }
  function american(dec) {
    dec = num(dec);
    if (!priceOk(dec)) return null;
    return dec >= 2 ? (dec - 1) * 100 : -100 / (dec - 1);
  }
  function decimalOf(am) {
    am = num(am);
    if (am === null || Math.abs(am) < 100 || Math.abs(am) > 100000) return null;
    return am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
  }
  function resultOf(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().toLowerCase();
    if (s === 'win' || s === 'won') return 'win';
    if (s === 'loss' || s === 'lost' || s === 'lose') return 'loss';
    if (s === 'push') return 'push';
    if (VOID_WORDS.indexOf(s) >= 0) return 'void';
    return null;
  }
  /* THE BRIEF'S FORMULAS, word for word: 1 unit risked. */
  function unitsAmerican(am, result) {
    am = num(am);
    if (am === null || Math.abs(am) < 100 || Math.abs(am) > 100000) return null;
    var r = resultOf(result);
    if (r === 'win') return am > 0 ? am / 100 : 100 / Math.abs(am);
    if (r === 'loss') return -1;
    if (r === 'push') return 0;
    return null;
  }
  /* The same number from the stored decimal (what the database does). */
  function unitsDecimal(dec, result) {
    dec = num(dec);
    if (!priceOk(dec)) return null;
    var r = resultOf(result);
    if (r === 'win') return dec - 1;
    if (r === 'loss') return -1;
    if (r === 'push') return 0;
    return null;
  }
  function tierOf(raw) { return raw === 'A' || raw === 'B' ? raw : 'legacy'; }
  function marketTypeOf(market, isProp) {
    var m = String(market || '').toLowerCase();
    if (m === 'h2h' || m === 'moneyline') return 'moneyline';
    if (m === 'spreads' || m === 'spread' || m === 'alternate_spreads') return 'spread';
    if (m === 'totals' || m === 'total' || m === 'alternate_totals') return 'total';
    if (m.indexOf('player_') === 0 || String(isProp).toLowerCase() === 'true') return 'player_prop';
    if (m.indexOf('team_total') >= 0) return 'team_total';
    return 'other';
  }
  function recordScope(edge) {
    edge = num(edge);
    return edge !== null && edge >= EDGE_BAND[0] && edge <= EDGE_BAND[1] ? 'record' : 'outside_edge_band';
  }

  /* One signal → its P&L grade (the fields the database stores that are
     arithmetic). null: not flagged, or not closed and not settled yet. */
  function grade(s) {
    if (!s || s.sig_key == null || s.flagged_at == null || (s.result == null && s.closed_at == null)) return null;
    var dec = num(s.flagged_best_dec), cdec = num(s.closing_dec), res = resultOf(s.result);
    var g = {
      sig_key: s.sig_key, calc_version: CALC_VERSION,
      tier: tierOf(s.flagged_tier), market_type: marketTypeOf(s.market, s.is_player_prop), record_scope: recordScope(s.flagged_edge),
      price_at_flag_dec: dec, price_at_flag: american(dec),
      price_at_close_dec: priceOk(cdec) ? cdec : null, price_at_close: priceOk(cdec) ? american(cdec) : null,
      result_raw: s.result == null ? null : String(s.result), result: res,
      stake_units: 0, pnl_units: null, pnl_units_at_close: null, pnl_status: null, ungraded_reason: null
    };
    if (s.result == null) { g.pnl_status = 'ungraded_unsettled'; g.ungraded_reason = 'awaiting_result'; }
    else if (res === null) { g.pnl_status = 'ungraded_unsettled'; g.ungraded_reason = 'unrecognized_result'; }
    else if (res === 'void') g.pnl_status = 'void';
    else if (dec === null) { g.pnl_status = 'ungraded_missing_price'; g.ungraded_reason = 'no_flag_price'; }
    else if (!priceOk(dec)) { g.pnl_status = 'ungraded_missing_price'; g.ungraded_reason = 'invalid_flag_price'; }
    else {
      g.pnl_status = 'graded'; g.stake_units = 1;
      g.pnl_units = unitsDecimal(dec, res);
      g.pnl_units_at_close = g.price_at_close_dec === null ? null : unitsDecimal(g.price_at_close_dec, res);
    }
    return g;
  }

  /* ============================================================ FOLDING
     pnl_summary rows are additive (counts and sums), so any set of them can be
     folded into one total and the rates derived again — which is how the page
     drops a retired sport or picks one sport without another query. */
  var SUMS = ['flags', 'graded', 'wins', 'losses', 'pushes', 'voids', 'ungraded_missing_price', 'ungraded_unsettled', 'outside_edge_band',
    'units_won', 'units_risked', 'close_compared', 'units_won_at_close', 'units_won_flag_compared', 'units_risked_compared'];
  function fold(rows) {
    var t = {};
    SUMS.forEach(function (k) { t[k] = 0; });
    t.first_game_date = null; t.last_game_date = null;
    (rows || []).forEach(function (r) {
      SUMS.forEach(function (k) { var v = num(r[k]); if (v !== null) t[k] += v; });
      if (r.first_game_date && (!t.first_game_date || r.first_game_date < t.first_game_date)) t.first_game_date = r.first_game_date;
      if (r.last_game_date && (!t.last_game_date || r.last_game_date > t.last_game_date)) t.last_game_date = r.last_game_date;
    });
    t.roi_pct = t.units_risked > 0 ? t.units_won / t.units_risked * 100 : null;
    t.win_pct = t.wins + t.losses > 0 ? t.wins / (t.wins + t.losses) * 100 : null;
    t.roi_at_close_pct = t.units_risked_compared > 0 ? t.units_won_at_close / t.units_risked_compared * 100 : null;
    t.roi_flag_compared_pct = t.units_risked_compared > 0 ? t.units_won_flag_compared / t.units_risked_compared * 100 : null;
    t.not_counted = t.voids + t.ungraded_missing_price + t.ungraded_unsettled;
    return t;
  }

  /* Cumulative units by game day, for the line chart: one point per day with
     the running total for all tiers and for each tier. dayRows are pnl_summary
     rows with grain 'day' and breakdown 'sport+tier'. */
  function cumulative(dayRows, keep) {
    var byDay = {};
    (dayRows || []).forEach(function (r) {
      if (keep && !keep(r)) return;
      var d = r.period_start; if (!d) return;
      var u = num(r.units_won) || 0, n = num(r.graded) || 0;
      if (!n) return;
      var o = byDay[d] || (byDay[d] = { date: d, all: 0, n: 0, A: 0, B: 0, legacy: 0 });
      o.all += u; o.n += n;
      var t = tierOf(r.tier); o[t] += u;
    });
    var days = Object.keys(byDay).sort(), run = { all: 0, A: 0, B: 0, legacy: 0 }, bets = 0;
    return days.map(function (d) {
      var o = byDay[d];
      run.all += o.all; run.A += o.A; run.B += o.B; run.legacy += o.legacy; bets += o.n;
      return { date: d, all: run.all, A: run.A, B: run.B, legacy: run.legacy, bets: bets, day: o.all };
    });
  }

  /* Everything the section draws, for one sport (or all of them). allRows are
     pnl_summary rows with grain 'all'; keep(sportKey) drops what the page does
     not cover (a retired sport). */
  function view(allRows, dayRows, opts) {
    opts = opts || {};
    var keep = opts.keep || function () { return true; };
    var sport = opts.sport || null;
    var rows = (allRows || []).filter(function (r) { return r.sport_key && keep(r.sport_key); });
    var sports = {};
    rows.forEach(function (r) {
      if (r.breakdown !== 'sport') return;
      sports[r.sport_key] = { key: r.sport_key, title: r.sport_title || r.sport_key, flags: num(r.flags) || 0, graded: num(r.graded) || 0 };
    });
    var inScope = function (r) { return !sport || r.sport_key === sport; };
    var total = fold(rows.filter(function (r) { return r.breakdown === 'sport' && inScope(r); }));
    var tiers = TIER_ORDER.map(function (k) {
      var t = fold(rows.filter(function (r) { return r.breakdown === 'sport+tier' && r.tier === k && inScope(r); }));
      t.tier = TIERS[k]; return t;
    }).filter(function (t) { return t.flags > 0 || t.tier.key !== 'legacy'; });
    var mk = {};
    rows.forEach(function (r) { if (r.breakdown === 'sport+market' && inScope(r)) (mk[r.market_type] = mk[r.market_type] || []).push(r); });
    var markets = Object.keys(mk).map(function (k) { var t = fold(mk[k]); t.market_type = k; t.label = MARKET_LABEL[k] || k; return t; })
      .filter(function (t) { return t.flags > 0; }).sort(function (a, b) { return b.graded - a.graded || (a.label < b.label ? -1 : 1); });
    var series = cumulative(dayRows, function (r) { return r.sport_key && keep(r.sport_key) && inScope(r); });
    return {
      sport: sport, sports: Object.keys(sports).sort(function (a, b) { return sports[b].flags - sports[a].flags || (a < b ? -1 : 1); }).map(function (k) { return sports[k]; }),
      total: total, tiers: tiers, markets: markets, series: series, sample: sampleLabel(total.graded)
    };
  }

  /* the same thresholds as lib/edgedesk_pnl.js, so the two P&L sections speak alike */
  function sampleLabel(n) {
    n = num(n) || 0;
    if (n < 20) return { key: 'VERY_SMALL', label: 'Very small sample', warn: true, n: n };
    if (n < 50) return { key: 'SMALL', label: 'Small sample', warn: true, n: n };
    if (n < 100) return { key: 'DEVELOPING', label: 'Developing sample', warn: false, n: n };
    return { key: 'MEANINGFUL', label: 'More meaningful sample', warn: false, n: n };
  }

  /* ============================================================ FORMAT
     Two decimals for display; the database keeps full precision. */
  function round2(v) { return Math.round((v + (v >= 0 ? 1e-12 : -1e-12)) * 100) / 100; }
  function fmtUnits(v) {
    v = num(v); if (v === null) return '—';
    var r = round2(v); if (r === 0) r = 0;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(2) + 'u';
  }
  function fmtPct(v, dp) {
    v = num(v); if (v === null) return '—';
    var f = Math.pow(10, dp == null ? 1 : dp), r = Math.round(v * f) / f; if (r === 0) r = 0;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(dp == null ? 1 : dp) + '%';
  }
  function fmtAmerican(am) {
    am = num(am); if (am === null) return '—';
    var r = Math.round(am);
    return r > 0 ? '+' + r : '−' + Math.abs(r);
  }
  function fmtPriceDec(dec) { return priceOk(dec) ? fmtAmerican(american(dec)) : '—'; }
  function fmtRecord(t) { return (t.wins || 0) + '–' + (t.losses || 0) + '–' + (t.pushes || 0); }
  function tone(v) { v = num(v); return v === null || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'pos' : 'neg'; }

  return {
    CALC_VERSION: CALC_VERSION, EDGE_BAND: EDGE_BAND, MAX_DEC: MAX_DEC, TIERS: TIERS, TIER_ORDER: TIER_ORDER,
    MARKET_LABEL: MARKET_LABEL, STATUS_TEXT: STATUS_TEXT, REASON_TEXT: REASON_TEXT, METHOD_NOTE: METHOD_NOTE,
    num: num, priceOk: priceOk, american: american, decimalOf: decimalOf, resultOf: resultOf,
    unitsAmerican: unitsAmerican, unitsDecimal: unitsDecimal, tierOf: tierOf, marketTypeOf: marketTypeOf, recordScope: recordScope,
    grade: grade, fold: fold, cumulative: cumulative, view: view, sampleLabel: sampleLabel,
    fmtUnits: fmtUnits, fmtPct: fmtPct, fmtAmerican: fmtAmerican, fmtPriceDec: fmtPriceDec, fmtRecord: fmtRecord, tone: tone
  };
}));

/* ===========================================================================
   EDGEDESK P&L — profit and loss of the model's own recommendations.
   docs/pnl/DESIGN.md

   One question: if a reader had followed every EdgeDesk recommendation, at
   the price EdgeDesk recorded when it made it, how many units would they be
   up or down? This file is the arithmetic, and only the arithmetic. It reads
   P&L rows (tools/record/pnl_ledger.js builds them from the ledgers the
   pipelines already keep) and never fetches, never stores, never looks at a
   clock.

   TWO STRATEGIES, NEVER MIXED
     flat     every qualifying recommendation risks exactly 1.00u
     staked   every qualifying recommendation risks the units EdgeDesk
              recommended at the time (0.25 / 0.50 / 0.75 / 1.00u); a row
              with no recommended stake is not a staked bet

   WHAT THIS FILE NEVER DOES
     - assume -110, or any price it was not given. No valid entry price →
       no profit figure (null), whatever the result was. The win/loss still
       counts in the record; it never enters a P&L metric.
     - accept 0, null, undefined, NaN, a string that is not a number, or a
       number between -100 and +100 as American odds;
     - accept a negative stake;
     - compute ROI as anything but net profit / total risked × 100;
     - let a small sample read as a verdict: every figure carries n and a
       sample label.

   CONVENTIONS (the same as the player-prop record, lib/edgedesk_props.js
   summarize, so the two never disagree about the same bet)
     win rate     wins / (wins + losses); pushes are not in the denominator
     risked       the stake of every WIN and LOSS; a push or a void returns
                  the stake, so it adds nothing to risked and nothing to P&L
     avg odds     the stake-weighted mean DECIMAL price of the graded bets,
                  printed as American (averaging American numbers directly
                  is wrong: -110 and +110 would average to 0)
     break-even   1 / that mean decimal price — the win rate the actual
                  prices needed
     drawdown     from the running peak of cumulative units, which starts at
                  0 before the first bet

   Browser: window.EDPnl.   Node: require('./edgedesk_pnl.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPnl = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_pnl_v1';
  var ROW_SCHEMA = 'edgedesk_pnl_row_v1';
  var EPS = 1e-9;
  /* the largest American price a feed could plausibly carry; past it the
     number is a broken feed, not a longshot */
  var MAX_AMERICAN = 100000;
  var MAX_STAKE = 100;

  var RESULTS = ['win', 'loss', 'push', 'void', 'pending'];

  /* P&L status of one row, in the order the data-quality panel prints them */
  var STATUS = {
    VERIFIED: 'VERIFIED',                 /* settled W/L/P at a captured entry price */
    PENDING: 'PENDING',                   /* not settled yet */
    VOID: 'VOID',                         /* cancelled / did not play: stake returned */
    NO_ENTRY_PRICE: 'NO_ENTRY_PRICE',     /* settled, but no price was captured at entry */
    SIMULATED_PRICE: 'SIMULATED_PRICE',   /* the source graded at an ASSUMED price: never verified P&L */
    INVALID_PRICE: 'INVALID_PRICE',       /* a price was stored but it is not a real American price */
    INVALID_STAKE: 'INVALID_STAKE'        /* a negative or impossible stake */
  };
  var STATUS_TEXT = {
    VERIFIED: 'Verified P&L',
    PENDING: 'Pending',
    VOID: 'Void — stake returned',
    NO_ENTRY_PRICE: 'P&L unavailable — entry price not captured',
    SIMULATED_PRICE: 'P&L unavailable — the source assumed a price; simulated figures are never mixed with verified P&L',
    INVALID_PRICE: 'P&L unavailable — the stored entry price is not a valid American price',
    INVALID_STAKE: 'P&L unavailable — the recorded stake is not valid'
  };

  /* THE ONE STATE every recommendation resolves to (record_state). Nothing is
     left ambiguous: a row is waiting, settled with verified P&L, settled as a
     record only (a result, no usable entry price), void, or invalid. */
  var STATE = { PENDING: 'PENDING', VERIFIED: 'VERIFIED', RECORD_ONLY: 'RECORD_ONLY', VOID: 'VOID', INVALID: 'INVALID' };
  var STATE_ORDER = ['PENDING', 'VERIFIED', 'RECORD_ONLY', 'VOID', 'INVALID'];
  var STATE_TEXT = {
    PENDING: 'Pending',
    VERIFIED: 'Settled · verified P&L',
    RECORD_ONLY: 'Settled · record only',
    VOID: 'Void',
    INVALID: 'Invalid / incomplete'
  };
  /* why a pending row is still pending (pending_reason, set by the ledger
     build from the settlement jobs' own diagnostics and the game clock) */
  var PENDING_REASON = {
    UPCOMING: 'Upcoming game',
    IN_PROGRESS: 'Game in progress',
    AWAITING_SETTLEMENT: 'Game finished, awaiting the settlement run',
    AWAITING_STAT_FEED: 'Game finished, awaiting the stat feed',
    MISSING_FINAL: 'Missing final',
    MISSING_PLAYER_STAT: 'Missing player stat',
    SETTLEMENT_FAILED: 'Settlement job failed',
    MISSING_MAPPING: 'Missing mapping',
    UNKNOWN: 'No reason recorded'
  };
  var PENDING_REASON_ORDER = ['UPCOMING', 'IN_PROGRESS', 'AWAITING_SETTLEMENT', 'AWAITING_STAT_FEED', 'MISSING_FINAL', 'MISSING_PLAYER_STAT', 'SETTLEMENT_FAILED', 'MISSING_MAPPING', 'UNKNOWN'];

  /* buckets — [lo, hi) with a label; the model edge is in percentage points */
  var EDGE_BUCKETS = [[0, 1, '0–1%'], [1, 2, '1–2%'], [2, 3, '2–3%'], [3, 5, '3–5%'], [5, 7, '5–7%'], [7, Infinity, '7%+']];
  var CALIBRATION_BUCKETS = [[0, 1, '0–1%'], [1, 2, '1–2%'], [2, 3, '2–3%'], [3, 4, '3–4%'], [4, 5, '4–5%'], [5, 7, '5–7%'], [7, 10, '7–10%'], [10, Infinity, '10%+']];
  var CLV_BUCKETS = [[-Infinity, -2, '< −2'], [-2, -1, '−2 to −1'], [-1, 0, '−1 to 0'], [0, 1, '0 to +1'], [1, 2, '+1 to +2'], [2, Infinity, '> +2']];
  var ODDS_BUCKETS = [[-100000, -200, '−200 or shorter'], [-200, -140, '−199 to −140'], [-140, -115, '−139 to −115'], [-115, -105, '−114 to −105'], [-105, 101, '−104 to +100'], [101, 150, '+101 to +149'], [150, 250, '+150 to +249'], [250, 100001, '+250 or longer']];
  var UNIT_TIERS = [0.25, 0.5, 0.75, 1];

  /* ================================================================ BASICS */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r(x, d) { if (!isNum(x)) return null; var m = Math.pow(10, d == null ? 4 : d); return Math.round(x * m) / m; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /** A real American price, or null. Strict: 0, null, undefined, NaN, '',
      booleans, objects, anything with |price| < 100 or past MAX_AMERICAN is
      refused. A numeric string ('+150', '-110') is accepted. */
  function validAmerican(x) {
    var n;
    if (typeof x === 'number') n = x;
    else if (typeof x === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(x)) n = Number(x);
    else return null;
    if (!isNum(n)) return null;
    if (Math.abs(n) < 100 || Math.abs(n) > MAX_AMERICAN) return null;
    return n;
  }
  /** A stake in units: a finite number ≥ 0 (0 = no stake), or null. */
  function validStake(x) {
    if (typeof x !== 'number' || !isNum(x)) return null;
    if (x < 0 || x > MAX_STAKE) return null;
    return x;
  }
  function decimal(american) {
    var a = validAmerican(american);
    if (a == null) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  }
  function toAmerican(dec) {
    if (!isNum(dec) || dec <= 1) return null;
    return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  }
  /** implied probability of an American price (with the book's margin in it) */
  function impliedProb(american) { var d = decimal(american); return d == null ? null : 1 / d; }

  /** WIN / won / W → 'win', … ; anything unknown → null */
  function normResult(x) {
    if (x == null) return null;
    var s = String(x).trim().toLowerCase();
    if (s === 'win' || s === 'won' || s === 'w') return 'win';
    if (s === 'loss' || s === 'lost' || s === 'lose' || s === 'l') return 'loss';
    if (s === 'push' || s === 'p' || s === 'tie') return 'push';
    if (s === 'void' || s === 'cancelled' || s === 'canceled' || s === 'no action' || s === 'dnp') return 'void';
    if (s === 'pending' || s === 'open' || s === 'ungraded') return 'pending';
    return null;
  }

  /**
   * Profit in units of one wager.
   *   win   positive odds: stake × odds / 100;  negative odds: stake × 100 / |odds|
   *   loss  −stake
   *   push  0          void  0          pending  null
   * No valid price, or no valid stake → null (never a guess).
   */
  function profit(american, stake, result) {
    var a = validAmerican(american), s = validStake(stake), res = normResult(result);
    if (a == null || s == null || res == null || res === 'pending') return null;
    if (res === 'push' || res === 'void') return 0;
    if (res === 'loss') return s === 0 ? 0 : -s;
    return a > 0 ? s * (a / 100) : s * (100 / Math.abs(a));
  }

  /* =========================================================== ONE ROW
     A P&L row carries the facts of the recommendation (frozen) and its
     settlement. settle() derives the P&L fields from them and nothing else.
     Missing is null, never zero. */
  function settle(row) {
    var o = {}, k;
    for (k in row) if (has(row, k)) o[k] = row[k];
    /* a settlement that is not a result is never quietly read as pending:
       the row stays unsettled and its state says INVALID, with the value */
    var raw = o.result, norm = normResult(raw);
    var unreadable = raw != null && raw !== '' && norm == null;
    var res = norm || 'pending';
    o.result = res;
    var a = o.entry_odds == null ? null : validAmerican(o.entry_odds);
    var stake = o.stake_units == null ? 0 : validStake(o.stake_units);
    o.flat_stake_units = 1;
    o.missing_entry_odds = o.entry_odds == null && !o.price_assumed;
    o.implied_prob = a != null ? r(impliedProb(a), 4) : null;
    o.profit_units = null;
    o.flat_profit_units = null;
    if (o.price_assumed) o.pnl_status = STATUS.SIMULATED_PRICE;
    else if (o.entry_odds == null) o.pnl_status = res === 'pending' ? STATUS.PENDING : STATUS.NO_ENTRY_PRICE;
    else if (a == null) o.pnl_status = STATUS.INVALID_PRICE;
    else if (stake == null) o.pnl_status = STATUS.INVALID_STAKE;
    else if (res === 'pending') o.pnl_status = STATUS.PENDING;
    else if (res === 'void') o.pnl_status = STATUS.VOID;
    else o.pnl_status = STATUS.VERIFIED;
    if (o.pnl_status === STATUS.VERIFIED || o.pnl_status === STATUS.VOID) {
      o.flat_profit_units = r(profit(a, 1, res), 4);
      o.profit_units = stake > 0 ? r(profit(a, stake, res), 4) : null;
    }
    o.pnl_eligible = o.pnl_status === STATUS.VERIFIED;
    o.pnl_note = STATUS_TEXT[o.pnl_status];
    var st = stateOf(o, unreadable ? raw : null);
    o.record_state = st.state;
    o.state_reason = st.reason;
    /* an invalid row is graded nowhere: no P&L, whatever its price */
    if (st.state === STATE.INVALID) { o.flat_profit_units = null; o.profit_units = null; o.pnl_eligible = false; }
    return o;
  }
  /** The one state of a settled-or-not row: { state, reason }. `bad` is a
      settlement value that could not be read as a result. */
  function stateOf(o, bad) {
    if (bad != null) return { state: STATE.INVALID, reason: 'the settlement reads "' + String(bad) + '", which is not a result' };
    if (!o.event_id && !o.game_date) return { state: STATE.INVALID, reason: 'no game on the row' };
    if (!o.side && !o.selection) return { state: STATE.INVALID, reason: 'no side recorded' };
    var ko = Date.parse(o.game_date || ''), at = Date.parse(o.recommended_at || '');
    /* a recommendation is a pregame call; one stamped after kickoff is not one
       (the model record's own pregame rule guards its rows) */
    if (o.rec_class !== 'MODEL' && isFinite(ko) && isFinite(at) && at > ko) return { state: STATE.INVALID, reason: 'recommended after the game started' };
    var res = normResult(o.result) || 'pending';
    if (res === 'pending') return { state: STATE.PENDING, reason: null };
    if (res === 'void') return { state: STATE.VOID, reason: STATUS_TEXT.VOID };
    if (o.pnl_status === STATUS.VERIFIED) return { state: STATE.VERIFIED, reason: null };
    return { state: STATE.RECORD_ONLY, reason: STATUS_TEXT[o.pnl_status] || STATUS_TEXT.NO_ENTRY_PRICE };
  }
  /** a row's state, also for a row written before record_state existed */
  function rowState(x) {
    if (!x) return STATE.INVALID;
    if (x.record_state && STATE[x.record_state]) return x.record_state;
    return stateOf(x).state;
  }

  /* ========================================================== SAMPLES */
  /** The sample label every figure is printed with. */
  function sampleLabel(n) {
    n = isNum(n) ? n : 0;
    if (n < 20) return { key: 'VERY_SMALL', label: 'Very small sample', warn: true, n: n, text: 'n=' + n + ' · Very small sample — results may be unstable' };
    if (n < 50) return { key: 'SMALL', label: 'Small sample', warn: true, n: n, text: 'n=' + n + ' · Small sample — results may be unstable' };
    if (n < 100) return { key: 'DEVELOPING', label: 'Developing sample', warn: false, n: n, text: 'n=' + n + ' · Developing sample' };
    return { key: 'MEANINGFUL', label: 'More meaningful sample', warn: false, n: n, text: 'n=' + n + ' · More meaningful sample' };
  }

  /* ========================================================= STRATEGY
     Which rows a strategy bets, and at what stake. */
  function stakeOf(row, mode) {
    if (mode === 'staked') { var s = validStake(row.stake_units); return s != null && s > 0 ? s : null; }
    return 1;
  }
  function profitOf(row, mode) {
    return mode === 'staked' ? row.profit_units : row.flat_profit_units;
  }
  /** rows of a strategy: P&L-verified, and (staked) with a recommended stake */
  function betsOf(rows, mode) {
    return (rows || []).filter(function (x) {
      if (!x || x.pnl_status !== STATUS.VERIFIED || rowState(x) !== STATE.VERIFIED) return false;
      if (stakeOf(x, mode) == null) return false;
      return isNum(profitOf(x, mode));
    });
  }
  function timeOf(x) {
    var t = Date.parse(x.game_date || x.kickoff || x.recommended_at || '');
    return isFinite(t) ? t : 0;
  }
  /** chronological: game date, then when the recommendation was made, then id */
  function chrono(rows) {
    return rows.slice().sort(function (a, b) {
      var d = timeOf(a) - timeOf(b); if (d) return d;
      var ra = Date.parse(a.recommended_at || '') || 0, rb = Date.parse(b.recommended_at || '') || 0; if (ra !== rb) return ra - rb;
      return String(a.recommendation_id) < String(b.recommendation_id) ? -1 : String(a.recommendation_id) > String(b.recommendation_id) ? 1 : 0;
    });
  }
  function dayOf(x) { var t = timeOf(x); return t ? new Date(t).toISOString().slice(0, 10) : null; }

  /* ====================================================== CUMULATIVE */
  /** The cumulative P&L path of a strategy: one point per bet, in order. */
  function series(rows, mode) {
    var bets = chrono(betsOf(rows, mode)), cum = 0, peak = 0, out = [];
    bets.forEach(function (x) {
      var p = profitOf(x, mode);
      cum += p;
      if (cum > peak + EPS) peak = cum;
      out.push({ id: x.recommendation_id, date: dayOf(x), t: timeOf(x), profit: r(p, 4), stake: stakeOf(x, mode), cum: r(cum, 4), peak: r(peak, 4), dd: r(cum - peak, 4) });
    });
    return out;
  }

  /** Drawdown from the running peak (which starts at 0, before the first bet). */
  function drawdown(path) {
    var out = { max: 0, current: 0, peak: 0, max_began: null, max_trough: null, max_recovered: null, longest_recovery_days: null, longest_recovery_ongoing: false, underwater: false };
    if (!path || !path.length) return out;
    var peak = 0, peakDate = path[0].date, peakT = path[0].t, worst = 0, wb = null, wt = null, wPeak = 0, longest = 0, longestOngoing = false;
    var i, pt;
    for (i = 0; i < path.length; i++) {
      pt = path[i];
      if (pt.cum >= peak - EPS && i > 0 && peak - path[i - 1].cum > EPS) {
        /* recovered to the previous peak: how long did it take? */
        var days = Math.round((pt.t - peakT) / 86400000);
        if (days > longest) { longest = days; longestOngoing = false; }
      }
      if (pt.cum > peak + EPS) { peak = pt.cum; peakDate = pt.date; peakT = pt.t; }
      var dd = pt.cum - peak;
      if (dd < worst - EPS) { worst = dd; wb = peakDate; wt = pt.date; wPeak = peak; }
    }
    var last = path[path.length - 1];
    if (peak - last.cum > EPS) {
      var open = Math.round((last.t - peakT) / 86400000);
      if (open > longest) { longest = open; longestOngoing = true; }
    }
    /* when did the worst drawdown end? the first point after its trough back at its peak */
    var rec = null, seenTrough = false;
    for (i = 0; i < path.length && wt; i++) {
      if (path[i].date === wt && Math.abs(path[i].cum - (wPeak + worst)) < 1e-6) seenTrough = true;
      else if (seenTrough && path[i].cum >= wPeak - EPS) { rec = path[i].date; break; }
    }
    out.max = r(worst, 4);
    out.current = r(last.cum - peak, 4);
    out.peak = r(peak, 4);
    out.max_began = wb;
    out.max_trough = wt;
    out.max_recovered = worst < -EPS ? rec : null;
    out.longest_recovery_days = longest || (worst < -EPS ? 0 : null);
    out.longest_recovery_ongoing = longestOngoing;
    out.underwater = last.cum < peak - EPS;
    return out;
  }

  /** streaks over graded wins and losses, in order; pushes neither extend nor break a streak */
  function streaks(bets) {
    var cur = null, n = 0, bestW = 0, bestL = 0;
    chrono(bets).forEach(function (x) {
      if (x.result !== 'win' && x.result !== 'loss') return;
      if (x.result === cur) n++; else { cur = x.result; n = 1; }
      if (cur === 'win' && n > bestW) bestW = n;
      if (cur === 'loss' && n > bestL) bestL = n;
    });
    return { current: cur ? (cur === 'win' ? 'W' : 'L') + n : null, current_kind: cur, current_n: n, longest_win: bestW, longest_loss: bestL };
  }

  /* ========================================================= SUMMARY */
  /**
   * Every headline figure of one strategy over a set of P&L rows.
   * `mode`: 'flat' | 'staked'.
   */
  function summarize(rows, mode) {
    mode = mode === 'staked' ? 'staked' : 'flat';
    var bets = betsOf(rows, mode);
    var w = 0, l = 0, p = 0, net = 0, risked = 0, grossW = 0, grossL = 0, decW = 0, decS = 0;
    var clvN = 0, clvS = 0, beatN = 0, beat = 0, prN = 0, prS = 0, edgeN = 0, edgeS = 0;
    bets.forEach(function (x) {
      var st = stakeOf(x, mode), pr = profitOf(x, mode), d = decimal(x.entry_odds);
      if (x.result === 'win') { w++; grossW += pr; } else if (x.result === 'loss') { l++; grossL += -pr; } else p++;
      net += pr;
      if (x.result === 'win' || x.result === 'loss') { risked += st; if (d != null) { decW += st * d; decS += st; } }
      if (isNum(x.clv_points)) { clvN++; clvS += x.clv_points; }
      if (isNum(x.clv_prob_pp)) { prN++; prS += x.clv_prob_pp; }
      if (x.beat_close === true || x.beat_close === false) { beatN++; if (x.beat_close) beat++; }
      if (isNum(x.model_edge_pct)) { edgeN++; edgeS += x.model_edge_pct; }
    });
    var path = series(rows, mode);
    var dd = drawdown(path);
    var avgDec = decS > 0 ? decW / decS : null;
    var peakProfit = 0;
    path.forEach(function (q) { if (q.cum > peakProfit) peakProfit = q.cum; });
    /* no settled bet: nothing was risked and nothing was won or lost, so
       every money figure is UNKNOWN (null → '—'), never a 0.00u that reads
       like a result */
    var none = !bets.length;
    return {
      mode: mode,
      n: bets.length, wins: w, losses: l, pushes: p,
      record: w + '-' + l + (p ? '-' + p : ''),
      net_units: none ? null : r(net, 2),
      risked_units: none ? null : r(risked, 2),
      roi_pct: risked > 0 ? r(100 * net / risked, 2) : null,
      win_rate_pct: w + l > 0 ? r(100 * w / (w + l), 2) : null,
      avg_decimal: r(avgDec, 4),
      avg_odds: toAmerican(avgDec),
      break_even_pct: avgDec ? r(100 / avgDec, 2) : null,
      gross_win_units: none ? null : r(grossW, 2),
      gross_loss_units: none ? null : r(grossL, 2),
      profit_factor: grossL > EPS ? r(grossW / grossL, 2) : null,
      profit_factor_note: grossL > EPS ? null : (grossW > EPS ? 'no losing units yet' : null),
      max_drawdown_units: none ? null : dd.max,
      current_drawdown_units: none ? null : dd.current,
      peak_profit_units: none ? null : r(peakProfit, 2),
      drawdown: none ? null : dd,
      streaks: streaks(bets),
      avg_clv_points: clvN ? r(clvS / clvN, 2) : null,
      clv_n: clvN,
      avg_clv_prob_pp: prN ? r(prS / prN, 2) : null,
      clv_prob_n: prN,
      clv_hit_rate_pct: beatN ? r(100 * beat / beatN, 1) : null,
      clv_hit_n: beatN,
      avg_edge_pct: edgeN ? r(edgeS / edgeN, 2) : null,
      sample: sampleLabel(bets.length)
    };
  }

  /* ======================================================= BREAKDOWNS */
  function bucketOf(x, B) {
    var i; if (!isNum(x)) return null;
    for (i = 0; i < B.length; i++) if (x >= B[i][0] && x < B[i][1]) return B[i][2];
    return null;
  }
  function edgeBucket(x) { return isNum(x) && x < 0 ? '< 0%' : bucketOf(x, EDGE_BUCKETS); }
  function unitTier(u) {
    if (!isNum(u) || u <= 0) return null;
    var i; for (i = 0; i < UNIT_TIERS.length; i++) if (Math.abs(u - UNIT_TIERS[i]) < 1e-6) return UNIT_TIERS[i].toFixed(2) + 'u';
    return u.toFixed(2) + 'u';
  }
  function oddsBucket(a) { var v = validAmerican(a); return v == null ? null : bucketOf(v, ODDS_BUCKETS); }
  /* a line range per market type — whole lines grouped by width that suits the stat */
  function lineBucket(row) {
    var ln = row.entry_line;
    if (!isNum(ln)) return null;
    var m = row.prop_market || row.market_type, w;
    if (row.market_type === 'spread') { var a = Math.abs(ln); return a <= 3 ? '0–3' : a <= 7 ? '3.5–7' : a <= 14 ? '7.5–14' : '14.5+'; }
    if (row.market_type === 'total') w = 7;
    else if (/_yds$|rush_rec_yds|pass_rush_yds/.test(m || '')) w = 25;
    else if (/_long$/.test(m || '')) w = 10;
    else w = 2;
    var lo = Math.floor(ln / w) * w;
    return lo + '–' + (lo + w);
  }

  /** summarize() per group. keyFn(row) → a label (null = left out). */
  function breakdown(rows, keyFn, mode, order) {
    var groups = {}, keys = [];
    (rows || []).forEach(function (x) {
      var k = keyFn(x); if (k == null || k === '') return;
      if (!groups[k]) { groups[k] = []; keys.push(k); }
      groups[k].push(x);
    });
    if (order) keys.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || (a < b ? -1 : 1); });
    else keys.sort();
    return keys.map(function (k) {
      var s = summarize(groups[k], mode);
      var g = groups[k];
      return {
        key: k, n: s.n, rows: g.length, wins: s.wins, losses: s.losses, pushes: s.pushes, record: s.record,
        win_rate_pct: s.win_rate_pct, net_units: s.net_units, risked_units: s.risked_units, roi_pct: s.roi_pct,
        avg_clv_points: s.avg_clv_points, avg_clv_prob_pp: s.avg_clv_prob_pp, clv_hit_rate_pct: s.clv_hit_rate_pct,
        avg_odds: s.avg_odds, avg_edge_pct: s.avg_edge_pct, max_drawdown_units: s.max_drawdown_units,
        record_only: recordOnly(g), sample: s.sample
      };
    });
  }
  /** W-L-P of rows that settled but carry no verified P&L (no entry price) */
  function recordOnly(rows) {
    var w = 0, l = 0, p = 0;
    (rows || []).forEach(function (x) {
      if (x.pnl_status !== STATUS.NO_ENTRY_PRICE && x.pnl_status !== STATUS.SIMULATED_PRICE && x.pnl_status !== STATUS.INVALID_PRICE) return;
      if (x.result === 'win') w++; else if (x.result === 'loss') l++; else if (x.result === 'push') p++;
    });
    return { n: w + l + p, wins: w, losses: l, pushes: p, record: w + '-' + l + (p ? '-' + p : ''), win_rate_pct: w + l ? r(100 * w / (w + l), 2) : null };
  }

  /* ====================================================== CALIBRATION
     Does the edge the model claimed go with the result it got? Per claimed-
     edge bucket: expected win % (the mean model probability of the side),
     actual win %, units, ROI, CLV. The verdict is made only against the
     binomial noise of the bucket's own sample, and only past 50 bets. */
  function calibration(rows, mode) {
    mode = mode === 'staked' ? 'staked' : 'flat';
    var bets = betsOf(rows, mode);
    return CALIBRATION_BUCKETS.map(function (B) {
      var g = bets.filter(function (x) { return isNum(x.model_edge_pct) && x.model_edge_pct >= B[0] && x.model_edge_pct < B[1]; });
      var s = summarize(g, mode);
      var wl = g.filter(function (x) { return x.result === 'win' || x.result === 'loss'; });
      var withP = wl.filter(function (x) { return isNum(x.model_prob); });
      var exp = withP.length ? withP.reduce(function (a, x) { return a + x.model_prob; }, 0) / withP.length : null;
      var actW = withP.filter(function (x) { return x.result === 'win'; }).length;
      var act = withP.length ? actW / withP.length : null;
      var verdict = null, gap = null;
      if (exp != null && act != null) {
        gap = act - exp;
        var se = Math.sqrt(Math.max(exp * (1 - exp), 1e-6) / withP.length);
        if (withP.length < 50) verdict = { key: 'INSUFFICIENT', label: 'Too few bets to judge' };
        else if (gap < -1.96 * se) verdict = { key: 'OVERCONFIDENT', label: 'Overconfident' };
        else if (gap > 1.96 * se) verdict = { key: 'UNDERCONFIDENT', label: 'Underconfident' };
        else verdict = { key: 'CALIBRATED', label: 'Consistent with the claimed edge' };
      }
      return {
        bucket: B[2], n: s.n, record: s.record,
        expected_win_pct: exp != null ? r(100 * exp, 2) : null,
        actual_win_pct: act != null ? r(100 * act, 2) : null,
        win_rate_pct: s.win_rate_pct, gap_pp: gap != null ? r(100 * gap, 2) : null, n_with_prob: withP.length,
        net_units: s.net_units, roi_pct: s.roi_pct, avg_clv_points: s.avg_clv_points, avg_clv_prob_pp: s.avg_clv_prob_pp,
        verdict: verdict, sample: s.sample
      };
    });
  }

  /* ========================================================= CLV vs P&L */
  function clvAnalysis(rows, mode) {
    mode = mode === 'staked' ? 'staked' : 'flat';
    var bets = betsOf(rows, mode);
    function part(pred) { var s = summarize(bets.filter(pred), mode); return { n: s.n, record: s.record, net_units: s.net_units, roi_pct: s.roi_pct, win_rate_pct: s.win_rate_pct, avg_clv_points: s.avg_clv_points, sample: s.sample }; }
    return {
      positive: part(function (x) { return x.beat_close === true; }),
      negative: part(function (x) { return x.beat_close === false; }),
      unmeasured: part(function (x) { return x.beat_close !== true && x.beat_close !== false; }),
      buckets: CLV_BUCKETS.map(function (B) {
        var s = summarize(bets.filter(function (x) { return isNum(x.clv_points) && x.clv_points >= B[0] && x.clv_points < B[1]; }), mode);
        return { bucket: B[2], n: s.n, record: s.record, net_units: s.net_units, roi_pct: s.roi_pct, win_rate_pct: s.win_rate_pct, sample: s.sample };
      })
    };
  }

  /* ====================================================== DATA QUALITY */
  function dataQuality(rows) {
    var q = { total: 0, verified: 0, pending: 0, voids: 0, missing_entry_odds: 0, simulated_price: 0, invalid_price: 0, invalid_stake: 0, not_pnl_eligible: 0, corrected: 0 };
    (rows || []).forEach(function (x) {
      q.total++;
      if (x.pnl_status === STATUS.VERIFIED) q.verified++;
      else if (x.pnl_status === STATUS.PENDING) q.pending++;
      else if (x.pnl_status === STATUS.VOID) q.voids++;
      else if (x.pnl_status === STATUS.NO_ENTRY_PRICE) q.missing_entry_odds++;
      else if (x.pnl_status === STATUS.SIMULATED_PRICE) q.simulated_price++;
      else if (x.pnl_status === STATUS.INVALID_PRICE) q.invalid_price++;
      else if (x.pnl_status === STATUS.INVALID_STAKE) q.invalid_stake++;
      if (x.corrected) q.corrected++;
    });
    /* settled historical records that carry a result but can never carry verified P&L */
    q.not_pnl_eligible = q.missing_entry_odds + q.simulated_price + q.invalid_price + q.invalid_stake;
    return q;
  }

  /* ========================================================= THE RECORD
     Every graded recommendation, priced or not, as wins, losses and pushes.
     It is never turned into units: a row adds to P&L only when it is VERIFIED.
     What counts as a pick: the model's published number (MODEL) on every
     game it graded, and every BET; a LEAN only when the reader includes
     leans. WATCH and PASS say "do not bet" — they are never in the record. */
  function inRecord(x, leans) { return !!x && (x.rec_class === 'MODEL' || x.rec_class === 'BET' || (!!leans && x.rec_class === 'LEAN')); }
  /** counts of every state, over every row given (each row exactly once) */
  function states(rows) {
    var o = { total: 0 };
    STATE_ORDER.forEach(function (k) { o[k] = 0; });
    (rows || []).forEach(function (x) { o.total++; o[rowState(x)]++; });
    return o;
  }
  /** W-L-P of the graded rows (VERIFIED and RECORD_ONLY), and what the rest are */
  function gradedRecord(rows) {
    var w = 0, l = 0, p = 0, ver = 0, ro = 0, pend = 0, v = 0, inv = 0, n = 0, first = null, last = null;
    (rows || []).forEach(function (x) {
      n++;
      var s = rowState(x);
      if (s === STATE.PENDING) { pend++; return; }
      if (s === STATE.VOID) { v++; return; }
      if (s === STATE.INVALID) { inv++; return; }
      if (s === STATE.VERIFIED) ver++; else ro++;
      if (x.result === 'win') w++; else if (x.result === 'loss') l++; else if (x.result === 'push') p++;
      var t = timeOf(x);
      if (t && (first == null || t < first)) first = t;
      if (t && (last == null || t > last)) last = t;
    });
    return {
      tracked: n, graded: w + l + p, wins: w, losses: l, pushes: p, record: w + '-' + l + (p ? '-' + p : ''),
      /* kept to 4 places so a printed 1-place figure is rounded once (210-53 is 79.8%, not 79.85 → 79.9) */
      win_rate_pct: w + l ? r(100 * w / (w + l), 4) : null,
      verified: ver, record_only: ro, pending: pend, voids: v, invalid: inv,
      first_game: first ? new Date(first).toISOString().slice(0, 10) : null, last_game: last ? new Date(last).toISOString().slice(0, 10) : null,
      sample: sampleLabel(w + l + p)
    };
  }
  /** gradedRecord() per group. keyFn(row) → a label (null = left out). */
  function recordBreakdown(rows, keyFn, order) {
    var groups = {}, keys = [];
    (rows || []).forEach(function (x) {
      var k = keyFn(x); if (k == null || k === '') return;
      if (!groups[k]) { groups[k] = []; keys.push(k); }
      groups[k].push(x);
    });
    if (order) keys.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || (a < b ? -1 : 1); });
    else keys.sort();
    return keys.map(function (k) { var g = gradedRecord(groups[k]); g.key = k; return g; });
  }
  function weekKey(x) { return x.week != null ? (x.league === 'CFB' ? 'CFB' : 'NFL') + ' · Week ' + pad2(x.week) : null; }
  /** where the record comes from: by sport, market, model version, week and grade */
  function recordBreakdowns(rows) {
    return {
      league: recordBreakdown(rows, function (x) { return LEAGUE_LABEL[x.league] || x.league; }, ['NFL', 'College Football']),
      market: recordBreakdown(rows, function (x) { return MARKET_LABEL[x.market_type] || x.market_type; }, ['Spread', 'Total', 'Moneyline', 'Player Props']),
      model_version: recordBreakdown(rows, function (x) { return x.model_version || 'unversioned'; }),
      week: recordBreakdown(rows, weekKey),
      grade: recordBreakdown(rows, function (x) { return GRADE_LABEL[x.rec_class] || x.rec_class; }, GRADE_ORDER.map(function (k) { return GRADE_LABEL[k]; }))
    };
  }
  /** a pending row's reason: the one the ledger build recorded; for a row
      written before the build kept reasons, only what the caller's clock can
      prove (a game that has not started is UPCOMING) — otherwise UNKNOWN */
  function pendingReasonOf(x, now) {
    if (x.pending_reason && PENDING_REASON[x.pending_reason]) return x.pending_reason;
    var t = Date.parse(x.game_date || '');
    if (isNum(now) && isFinite(t) && t > now) return 'UPCOMING';
    return 'UNKNOWN';
  }
  /** why the pending rows are pending, counted (rows given are any rows; only PENDING count) */
  function pendingReasons(rows, now) {
    var c = {}, total = 0;
    (rows || []).forEach(function (x) {
      if (rowState(x) !== STATE.PENDING) return;
      total++;
      var k = pendingReasonOf(x, now);
      c[k] = (c[k] || 0) + 1;
    });
    return { total: total, reasons: PENDING_REASON_ORDER.filter(function (k) { return c[k]; }).map(function (k) { return { key: k, label: PENDING_REASON[k], n: c[k] }; }) };
  }

  /* ========================================================== INTEGRITY
     The page's figures are computed from one dataset; these checks prove
     they agree, so a disagreement surfaces as an internal error instead of
     two numbers that quietly differ. `base` is every row in the view,
     `mode` the strategy, `leans` whether leans are counted. */
  function integrity(base, mode, leans) {
    mode = mode === 'staked' ? 'staked' : 'flat';
    base = base || [];
    var bets = base.filter(function (x) { return x.rec_class === 'BET' || (leans && x.rec_class === 'LEAN'); })
      .map(function (x) { return x.rec_class === 'LEAN' ? Object.assign({}, x, { rec_class: 'BET' }) : x; });
    var s = summarize(bets, mode), ledger = betsOf(bets, mode), path = series(bets, mode);
    var sum = ledger.reduce(function (a, x) { return a + profitOf(x, mode); }, 0);
    var checks = [];
    function chk(key, label, ok, expected, got) { checks.push({ key: key, label: label, ok: !!ok, expected: expected, got: got }); }
    function near(a, b, tol) { return (a == null && b == null) || (isNum(a) && isNum(b) && Math.abs(a - b) <= (tol == null ? 0.006 : tol)); }
    chk('bets', 'hero verified bet count = qualifying ledger rows', s.n === ledger.length, ledger.length, s.n);
    chk('net', 'hero net units = sum of ledger units', s.n ? near(s.net_units, r(sum, 2)) : s.net_units == null, ledger.length ? r(sum, 2) : null, s.net_units);
    chk('chart', 'chart ends at the hero net', s.n ? near(path[path.length - 1].cum, s.net_units) : !path.length, s.net_units, path.length ? path[path.length - 1].cum : null);
    var bd = breakdowns(bets, mode);
    ['league', 'market'].forEach(function (k) {
      var n = 0, net = 0, g = bd[k] || [];
      g.forEach(function (x) { n += x.n; if (isNum(x.net_units)) net += x.net_units; });
      chk(k, 'by ' + k + ': bets and units add up to the hero', n === s.n && (s.n ? near(net, s.net_units, 0.006 * Math.max(1, g.length)) : true), [s.n, s.net_units], [n, r(net, 2)]);
    });
    var rec = base.filter(function (x) { return inRecord(x, leans); }), all = gradedRecord(rec), rb = recordBreakdowns(rec);
    ['market', 'league'].forEach(function (k) {
      var w = 0, l = 0, p = 0;
      rb[k].forEach(function (x) { w += x.wins; l += x.losses; p += x.pushes; });
      chk('record_' + k, 'historical record = sum by ' + k, w === all.wins && l === all.losses && p === all.pushes, all.record, w + '-' + l + (p ? '-' + p : ''));
    });
    var st = states(base), stSum = STATE_ORDER.reduce(function (a, k) { return a + st[k]; }, 0);
    chk('states', 'every row resolves to exactly one state', stSum === base.length && st.total === base.length, base.length, stSum);
    var badVer = base.filter(function (x) { return rowState(x) === STATE.VERIFIED && (validAmerican(x.entry_odds) == null || ['win', 'loss', 'push'].indexOf(x.result) < 0); }).length;
    chk('verified_priced', 'every verified row is settled at a captured price', badVer === 0, 0, badVer);
    var badRo = base.filter(function (x) { return rowState(x) === STATE.RECORD_ONLY && (isNum(x.profit_units) || isNum(x.flat_profit_units)); }).length;
    chk('record_only_unpriced', 'no record-only row carries units', badRo === 0, 0, badRo);
    var failed = checks.filter(function (c) { return !c.ok; });
    return { ok: !failed.length, n: checks.length, failed: failed, checks: checks };
  }

  /* ========================================================== VIEWS
     The Record's sections, shared by the build (tools/record/pnl_core.js,
     which precomputes them into record/pnl/summary.json) and the page (which
     recomputes them for any filter). One implementation, so the two agree. */
  var SCOPES = {
    all: { label: 'All', test: function () { return true; } },
    nfl: { label: 'NFL', test: function (x) { return x.league === 'NFL'; } },
    cfb: { label: 'College Football', test: function (x) { return x.league === 'CFB'; } },
    props: { label: 'Player Props', test: function (x) { return x.market_group === 'prop'; } },
    game: { label: 'Game Markets', test: function (x) { return x.market_group === 'game'; } }
  };
  var SCOPE_ORDER = ['all', 'nfl', 'cfb', 'props', 'game'];
  var MARKET_LABEL = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline', player_prop: 'Player Props' };
  var GRADE_ORDER = ['BET', 'LEAN', 'WATCH', 'PASS', 'MODEL'];
  var GRADE_LABEL = { BET: 'Bet', LEAN: 'Lean', WATCH: 'Watch', PASS: 'Pass', MODEL: 'Model number (no price)' };
  var LEAGUE_LABEL = { NFL: 'NFL', CFB: 'College Football' };
  /* the strategy: every recommendation EdgeDesk classified BET */
  function isBet(x) { return !!x && x.rec_class === 'BET'; }
  function scopeRows(rows, scope) { var S = SCOPES[scope] || SCOPES.all; return (rows || []).filter(S.test); }
  function sideLabel(x) {
    if (x.side === 'over') return x.market_group === 'prop' ? 'Over' : 'Over (totals)';
    if (x.side === 'under') return x.market_group === 'prop' ? 'Under' : 'Under (totals)';
    if (x.side === 'home') return 'Home';
    if (x.side === 'away') return 'Away';
    return null;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function breakdowns(rows, mode) {
    var bets = (rows || []).filter(isBet);
    function B(fn, order) { return breakdown(bets, fn, mode, order); }
    return {
      league: B(function (x) { return LEAGUE_LABEL[x.league] || x.league; }, ['NFL', 'College Football']),
      market: B(function (x) { return MARKET_LABEL[x.market_type] || x.market_type; }, ['Spread', 'Moneyline', 'Total', 'Player Props']),
      prop_type: B(function (x) { return x.market_group === 'prop' ? (x.prop_label || x.prop_market) : null; }),
      prop_category: B(function (x) { return x.market_group === 'prop' ? x.prop_category_label : null; }),
      side: B(sideLabel, ['Over', 'Under', 'Over (totals)', 'Under (totals)', 'Home', 'Away']),
      book: B(function (x) { return x.entry_book_name || x.entry_book || null; }),
      edge: B(function (x) { return edgeBucket(x.model_edge_pct); }, ['< 0%'].concat(EDGE_BUCKETS.map(function (b) { return b[2]; }))),
      unit_size: breakdown(bets, function (x) { return unitTier(x.stake_units); }, 'staked', ['0.25u', '0.50u', '0.75u', '1.00u']),
      odds_range: B(function (x) { return oddsBucket(x.entry_odds); }, ODDS_BUCKETS.map(function (b) { return b[2]; })),
      week: B(function (x) { return x.week != null ? (x.league === 'CFB' ? 'CFB' : 'NFL') + ' · Week ' + pad2(x.week) : null; }),
      model_version: B(function (x) { return x.model_version || 'unversioned'; }),
      /* does BET beat LEAN beat WATCH beat PASS? every class at a flat 1u, at its own recorded price */
      grade: breakdown((rows || []).filter(function (x) { return x.rec_class !== 'MODEL'; }), function (x) { return GRADE_LABEL[x.rec_class] || x.rec_class; }, 'flat', GRADE_ORDER.map(function (k) { return GRADE_LABEL[k]; })),
      calibration: calibration(bets, mode),
      clv: clvAnalysis(bets, mode)
    };
  }
  function compactSeries(path) { return path.map(function (p) { return [p.date, p.profit, p.cum, p.peak, p.id]; }); }
  /** everything one strategy prints for one set of rows */
  function view(rows, mode, withBreakdowns) {
    var bets = (rows || []).filter(isBet);
    var out = { summary: summarize(bets, mode), series: compactSeries(series(bets, mode)), record_only: recordOnly(rows) };
    out.record_only_by_market = {};
    ['spread', 'total', 'moneyline', 'player_prop'].forEach(function (m) {
      var ro = recordOnly((rows || []).filter(function (x) { return x.market_type === m; }));
      if (ro.n) out.record_only_by_market[MARKET_LABEL[m]] = ro;
    });
    out.compare = {
      game: summarize(bets.filter(function (x) { return x.market_group === 'game'; }), mode),
      props: summarize(bets.filter(function (x) { return x.market_group === 'prop'; }), mode)
    };
    if (withBreakdowns) out.breakdowns = breakdowns(rows, mode);
    return out;
  }
  /** player-level prop performance: every prop recommendation a player carries
      (props tracked), and the strategy's P&L on his BETs */
  function players(rows, mode, pred) {
    var counts = pred || isBet;
    var by = {}, keys = [];
    (rows || []).forEach(function (x) {
      if (x.market_group !== 'prop' || !(x.player_id || x.player_name)) return;
      var k = x.league + '|' + (x.player_id || x.player_name);
      if (!by[k]) { by[k] = []; keys.push(k); }
      by[k].push(x);
    });
    return keys.map(function (k) {
      var g = by[k], s = summarize(g.filter(counts), mode), last = g[g.length - 1];
      var edges = g.filter(function (x) { return isNum(x.model_edge_pct); }), clvs = g.filter(function (x) { return isNum(x.clv_points); });
      return { key: k, player_id: last.player_id, player_name: last.player_name, league: last.league, team: last.team, position: last.position,
        tracked: g.length, settled: g.filter(function (x) { return x.result && x.result !== 'pending'; }).length,
        n: s.n, record: s.record, wins: s.wins, losses: s.losses, pushes: s.pushes, net_units: s.net_units, roi_pct: s.roi_pct, win_rate_pct: s.win_rate_pct,
        avg_edge_pct: edges.length ? r(edges.reduce(function (a, x) { return a + x.model_edge_pct; }, 0) / edges.length, 2) : null,
        avg_clv_points: clvs.length ? r(clvs.reduce(function (a, x) { return a + x.clv_points; }, 0) / clvs.length, 2) : null,
        sample: sampleLabel(s.n) };
    }).sort(function (a, b) { return (b.tracked - a.tracked) || String(a.player_name).localeCompare(String(b.player_name)); });
  }

  /* ============================================================ DOLLARS
     Units are EdgeDesk's; dollars are the reader's. unitValue comes from the
     reader's own bankroll settings (EDBankroll.unitValue); nothing here holds
     a default dollar amount. */
  function dollars(units, unitValue) {
    if (!isNum(units) || !isNum(unitValue) || unitValue <= 0) return null;
    return Math.round(units * unitValue * 100) / 100;
  }

  /* ============================================================ FORMAT */
  function fmtUnits(u, dp) {
    if (!isNum(u)) return '—';
    var d = dp == null ? 2 : dp, v = r(u, d);
    if (Math.abs(v) < Math.pow(10, -d) / 2) v = 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + 'u';
  }
  function fmtPct(p, dp, signed) {
    if (!isNum(p)) return '—';
    var v = r(p, dp == null ? 1 : dp);
    return (signed && v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(dp == null ? 1 : dp) + '%';
  }
  function fmtOdds(a) { var v = validAmerican(a); if (v == null) return '—'; v = Math.round(v); return v > 0 ? '+' + v : '−' + Math.abs(v); }
  function fmtDollars(d) {
    if (!isNum(d)) return '—';
    var a = Math.abs(d).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (d > 0.004 ? '+' : d < -0.004 ? '−' : '') + '$' + a;
  }
  function tone(v) { return !isNum(v) || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'pos' : 'neg'; }

  /* ============================================================ EXPLAIN
     Plain-English help for the page. */
  var HELP = {
    pnl: 'Profit & Loss measures how many units a strategy would have gained or lost after accounting for betting odds. Unlike win percentage, P&L reflects the actual price paid for each wager.',
    units: 'A unit is a fixed amount you decide on — often 1% of a bankroll. Measuring in units lets people with different bankrolls compare the same record: +5u means five times your standard bet.',
    roi: 'Return on investment: net profit divided by the total amount risked, times 100. Risking 100u to make 8u is an 8% ROI. It is not wins divided by losses.',
    clv: 'Closing-line value: whether the price or line EdgeDesk recorded was better than where the market closed. Beating the close consistently is the clearest early evidence that a signal carries information, because it does not depend on who won.',
    drawdown: 'Drawdown is how far the running total has fallen from its highest point. It shows the worst losing stretch someone following along would have had to sit through.',
    flat: 'Flat 1u: every qualifying recommendation risks exactly 1 unit, at the odds EdgeDesk recorded when it made the recommendation.',
    staked: 'EdgeDesk staking: every qualifying recommendation risks the units EdgeDesk recommended at the time (0.25u to 1.00u). The two strategies are never mixed.',
    break_even: 'The win rate the actual prices needed to break even. At −110 on every bet it is 52.38%.',
    profit_factor: 'Gross units won divided by gross units lost. Above 1.00 the winners paid for the losers.',
    missing: 'P&L unavailable — entry price not captured. The result still counts in the win/loss record, but a profit figure needs the real price, and EdgeDesk never assumes −110.'
  };

  return {
    VERSION: VERSION, ROW_SCHEMA: ROW_SCHEMA, STATUS: STATUS, STATUS_TEXT: STATUS_TEXT, RESULTS: RESULTS, HELP: HELP,
    STATE: STATE, STATE_ORDER: STATE_ORDER, STATE_TEXT: STATE_TEXT, PENDING_REASON: PENDING_REASON, PENDING_REASON_ORDER: PENDING_REASON_ORDER,
    stateOf: stateOf, rowState: rowState, inRecord: inRecord, states: states, gradedRecord: gradedRecord, recordBreakdown: recordBreakdown,
    recordBreakdowns: recordBreakdowns, pendingReasons: pendingReasons, pendingReasonOf: pendingReasonOf, integrity: integrity,
    EDGE_BUCKETS: EDGE_BUCKETS, CALIBRATION_BUCKETS: CALIBRATION_BUCKETS, CLV_BUCKETS: CLV_BUCKETS, ODDS_BUCKETS: ODDS_BUCKETS, UNIT_TIERS: UNIT_TIERS,
    validAmerican: validAmerican, validStake: validStake, decimal: decimal, toAmerican: toAmerican, impliedProb: impliedProb,
    normResult: normResult, profit: profit, settle: settle,
    sampleLabel: sampleLabel, betsOf: betsOf, stakeOf: stakeOf, profitOf: profitOf, chrono: chrono,
    series: series, drawdown: drawdown, streaks: streaks, summarize: summarize,
    bucketOf: bucketOf, edgeBucket: edgeBucket, unitTier: unitTier, oddsBucket: oddsBucket, lineBucket: lineBucket,
    breakdown: breakdown, recordOnly: recordOnly, calibration: calibration, clvAnalysis: clvAnalysis, dataQuality: dataQuality,
    SCOPES: SCOPES, SCOPE_ORDER: SCOPE_ORDER, MARKET_LABEL: MARKET_LABEL, GRADE_ORDER: GRADE_ORDER, GRADE_LABEL: GRADE_LABEL, LEAGUE_LABEL: LEAGUE_LABEL,
    isBet: isBet, scopeRows: scopeRows, sideLabel: sideLabel, breakdowns: breakdowns, view: view, players: players,
    dollars: dollars, fmtUnits: fmtUnits, fmtPct: fmtPct, fmtOdds: fmtOdds, fmtDollars: fmtDollars, tone: tone
  };
}));

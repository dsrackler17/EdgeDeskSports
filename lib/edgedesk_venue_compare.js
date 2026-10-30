/* ===========================================================================
   EdgeDesk VENUE COMPARISON — what a line actually costs at each venue.

   A sportsbook quote and an exchange order book are different objects. A
   book's price is one number for any stake it accepts. An exchange's
   displayed best price is only the first level of a ladder: a larger stake
   walks down it, and a stake the ladder cannot hold is not fillable at all.
   This module turns both into the same comparable thing — what a stake of $S
   costs, what it pays on a win, and what that implies — and never pretends
   a price is better than it is.

   ONE FILE, EVERY HOST. The browser (window.EDVENUE), Node (require) and the
   novig_sync edge function (inlined by tools/novig/inline.js, drift-tested)
   run this exact code, so a card, a snapshot and a research report cannot
   disagree about one price.

   NOVIG'S UNITS (docs.novig.com/api/concepts/money.md, fees.md; read
   2026-10-30). Everything money-shaped is exact integer arithmetic here:
     price      a decimal string, three places at most ("0.665", "0.62"),
                carried as an integer in thousandths ("milli", 0..1000)
     contract   pays full value, 1¢, if its outcome wins; quantities are whole
                contracts. 110 contracts at 0.665 cost $0.73150, pay $1.10000
     ledger     $0.00001 ("u" below): 1 contract at m milli costs m u, pays
                1000 u
     ask        every resting order is a bid. A bid at p on one outcome is
                liquidity for the OTHER outcome at 1 − p, with the bid's qty
     fee        taker only: c · P(1 − P) · N · 1¢ per fill, at the fill's
                price, rounded half up to the $0.00001, no minimum. Read c and
                `charged` from the market. WHEN_LIVE charges only while the
                event is OPEN_INGAME (decided by Novig at match time);
                ALWAYS charges in every phase
     grid       0.001–0.050 step 0.001, 0.055–0.945 step 0.005, 0.950–0.999
                step 0.001; a price off it is refused, never snapped
   Probabilities and odds are Numbers only when they are DISPLAYED or fed to
   a probability formula; no money total is ever a binary float.

   WHAT IS NEVER CLAIMED
   - A better price is not positive expected value. EV needs an independent,
     versioned, validated model probability for exactly this market; without
     one the result says the price is better and nothing more.
   - Hold is the margin built into a COMPLETE set of mutually exclusive
     outcomes quoted together. Two sides from different snapshots, different
     lines or different books are not a market and have no hold.
   - A no-vig probability is an estimate (proportional normalisation), never
     the true probability.
   - A stale quote is history. It is shown as history and never compared as
     if it could be bet now.
   - Nothing here places, sizes or recommends an order. It simulates what a
     taker order of a given size would have cost against a recorded book.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDVENUE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'edgedesk_venue_compare_v1';

  /* THE RULES. Mirrored by public.novig_rule() in supabase/novig_market_data.sql;
     tools/novig/venue_compare.test.js fails if the two disagree. A change is a
     reviewed code change in both places. */
  var RULES = {
    novig_live_seconds: 90,        /* a streamed book this fresh may be called Live */
    novig_recent_minutes: 10,      /* a REST snapshot this fresh is Recently updated; older is Stale */
    book_live_minutes: 10,         /* a sportsbook read this fresh may be called Live */
    book_recent_minutes: 90,       /* EDINTEL's quote_ttl_min: a sportsbook quote older than this is Stale */
    pair_max_gap_minutes: 10,      /* two venues' observations further apart are not a simultaneous comparison */
    tie_pp: 0.10,                  /* implied-probability difference below this (percentage points) is a tie */
    model_max_age_hours: 36        /* a model probability older than this is not current */
  };
  var STAKES = [25, 50, 100, 250, 500];

  var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B10 = BigInt(10), B1000 = BigInt(1000);
  function isInt(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
  function pow10(k) { var r = B1; for (var i = 0; i < k; i++) r *= B10; return r; }

  /* ------------------------------------------------------------ prices */
  /** "0.665" -> 665; "0.62" -> 620; "1" -> 1000. More than three places, a
      sign, an exponent or a value outside [0, 1] is refused (null). */
  function milli(price) {
    if (price === null || price === undefined) return null;
    var s = typeof price === 'number' ? (isFinite(price) ? String(price) : '') : String(price).trim();
    var m = /^(\d+)(?:\.(\d{0,3}))?$/.exec(s);
    if (!m) return null;
    var whole = parseInt(m[1], 10), frac = (m[2] || '').padEnd(3, '0');
    var v = whole * 1000 + parseInt(frac || '0', 10);
    return v >= 0 && v <= 1000 ? v : null;
  }
  function milliStr(m) { return m == null ? null : (m / 1000).toFixed(3); }
  /** Novig's submittable grid (money.md): 279 prices in three bands */
  function onGrid(m) {
    if (!isInt(m)) return false;
    if (m >= 1 && m <= 50) return true;
    if (m >= 950 && m <= 999) return true;
    return m >= 55 && m <= 945 && m % 5 === 0;
  }
  /** a decimal coefficient string ("0.06") as an exact fraction {n, d} */
  function fraction(s) {
    var m = /^(\d+)(?:\.(\d+))?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var frac = m[2] || '';
    return { n: BigInt(m[1] + frac), d: pow10(frac.length) };
  }
  /** round a non-negative rational n/d half up to an integer */
  function roundHalfUp(n, d) { return (n * B2 + d) / (d * B2); }

  /* ------------------------------------------------------------ money in u ($0.00001) */
  function uToDollars(u) {
    if (u == null) return null;
    var b = typeof u === 'bigint' ? u : BigInt(u);
    var neg = b < B0; if (neg) b = -b;
    var s = b.toString().padStart(6, '0');
    return (neg ? '-' : '') + s.slice(0, -5) + '.' + s.slice(-5);
  }
  function dollarsToU(d) {
    var m = /^(-)?(\d+)(?:\.(\d{0,5}))?$/.exec(String(d == null ? '' : d).trim());
    if (!m) return null;
    var v = BigInt(m[2]) * BigInt(100000) + BigInt((m[3] || '').padEnd(5, '0') || '0');
    return m[1] ? -v : v;
  }
  function uNum(u) { return u == null ? null : Number(u) / 100000; }

  /** Novig's taker fee for one fill of n contracts at m milli, in u, rounded
      half up: c · P(1−P) · N · 1¢ = c · m · (1000 − m) · n / 1000 u */
  function takerFeeU(m, n, coefficient) {
    var c = fraction(coefficient);
    if (!c || !isInt(m) || !isInt(n) || n < 0) return null;
    var num = c.n * BigInt(m) * BigInt(1000 - m) * BigInt(n);
    return roundHalfUp(num, c.d * B1000);
  }
  /** is the taker fee charged now? (fees.md: WHEN_LIVE only while OPEN_INGAME) */
  function feeCharged(fee, eventStatus) {
    if (!fee || !fee.charged) return { charged: null, why: 'the market carried no fee schedule' };
    if (fee.charged === 'ALWAYS') return { charged: true, why: 'this market charges the taker in every phase (ALWAYS)' };
    if (fee.charged === 'WHEN_LIVE') {
      if (eventStatus === 'OPEN_INGAME') return { charged: true, why: 'the event is in play (OPEN_INGAME): WHEN_LIVE markets charge the taker' };
      return { charged: false, why: 'pregame: a WHEN_LIVE market charges no taker fee until the event goes live (Novig decides liveness at match time)' };
    }
    return { charged: null, why: 'unknown fee schedule ' + String(fee.charged) };
  }

  /* ------------------------------------------------------------ the book
     A Novig book (REST /v3/catalog/markets/{id}/book, or the websocket book
     channel) lists resting BIDS by outcome, best first. The ladder to BUY
     outcome X is the other outcome's bids, each at 1 − bid. Levels may be
     [price, qty] pairs or Novig's own {price, qty} order objects; equal
     prices are aggregated (each order kept, for per-fill fee rounding). */
  function levelsOf(list) {
    var byPrice = {}, out = [];
    (list || []).forEach(function (o) {
      var p = Array.isArray(o) ? o[0] : o && o.price, q = Array.isArray(o) ? o[1] : o && o.qty;
      var m = milli(p), n = Number(q);
      if (m == null || !isInt(n) || n <= 0) return;
      if (!byPrice[m]) { byPrice[m] = { m: m, qty: 0, fills: [] }; out.push(byPrice[m]); }
      byPrice[m].qty += n;
      /* a pre-aggregated level carries its order sizes in [2] */
      if (Array.isArray(o) && Array.isArray(o[2])) byPrice[m].fills.push.apply(byPrice[m].fills, o[2].map(Number));
      else byPrice[m].fills.push(n);
    });
    out.sort(function (a, b) { return b.m - a.m; });   /* best bid = highest first */
    return out;
  }
  /** the ladder to buy `outcomeId` in a two-outcome market: ascending prices */
  function askLadder(book, outcomeId, outcomeIds) {
    var ids = outcomeIds || Object.keys((book && book.orders) || {});
    var others = ids.filter(function (x) { return x !== outcomeId; });
    if (others.length !== 1) return { ok: false, reason: 'not_two_outcomes', ladder: [] };
    var bids = levelsOf(((book && book.orders) || {})[others[0]]);
    return { ok: true, against: others[0], ladder: bids.map(function (l) { return { m: 1000 - l.m, qty: l.qty, fills: l.fills }; }) };
  }
  /** aggregate depth for storage: {outcomeId: [[price, qty, [orderQty...]], ...]} best first */
  function compactDepth(book) {
    var out = {};
    Object.keys((book && book.orders) || {}).forEach(function (k) {
      out[k] = levelsOf(book.orders[k]).map(function (l) { return [milliStr(l.m), l.qty, l.fills]; });
    });
    return out;
  }

  /* ------------------------------------------------------------ odds */
  function americanToDecimal(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decimalToAmerican(d) { d = Number(d); if (!isFinite(d) || d <= 1) return null; return d >= 2 ? 100 * (d - 1) : -100 / (d - 1); }
  /** the prompt's own definitions: +A -> 100/(A+100); −A -> |A|/(|A|+100) */
  function impliedFromAmerican(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  function impliedFromDecimal(d) { d = Number(d); return isFinite(d) && d > 1 ? 1 / d : null; }
  function roundAmerican(a) { if (a == null || !isFinite(a)) return null; var r = Math.round(a); return r === -100 ? 100 : r; }
  function fmtAmerican(a) { var r = roundAmerican(a); return r == null ? '—' : (r > 0 ? '+' : '') + r; }

  /* ------------------------------------------------------------ one taker order against the ladder
     Buy as many whole contracts as the stake affords, all-in (price plus any
     taker fee), walking the ladder cheapest first. FILLED when the remainder
     is smaller than one more contract at the last price used; PARTIAL when
     the ladder ran out first (the stake is not fillable here); NO_LIQUIDITY
     when there is nothing to buy. Rounding: the fee per fill (per resting
     order) half up to $0.00001, as Novig books it. */
  function fill(ladder, stakeDollars, feeInfo) {
    var stakeU = dollarsToU(typeof stakeDollars === 'number' ? stakeDollars.toFixed(5) : stakeDollars);
    if (stakeU == null || stakeU <= B0) return { status: 'INVALID_STAKE', reason: 'the stake must be a positive dollar amount' };
    var charged = !!(feeInfo && feeInfo.charged);
    var coef = charged ? feeInfo.coefficient : null;
    if (charged && !fraction(coef)) return { status: 'FEE_UNKNOWN', reason: 'the market charges a taker fee but its coefficient is unreadable' };
    var left = stakeU, n = 0, costU = B0, feeU = B0, used = [], lastM = null, exhausted = true;
    var levels = ladder || [];
    for (var i = 0; i < levels.length; i++) {
      var L = levels[i];
      if (!isInt(L.m) || L.m <= 0 || L.m >= 1000) continue;
      var takeAtLevel = 0;
      var fills = L.fills && L.fills.length ? L.fills : [L.qty];
      for (var f = 0; f < fills.length; f++) {
        var avail = fills[f];
        /* contracts affordable at this price, fee included: m + c·m(1000−m)/1000 u each */
        var per = charged ? (function () { var c = fraction(coef); return { n: BigInt(L.m) * c.d * B1000 + c.n * BigInt(L.m) * BigInt(1000 - L.m), d: c.d * B1000 }; })() : { n: BigInt(L.m), d: B1 };
        var k = Number((left * per.d) / per.n);
        if (k > avail) k = avail;
        /* the half-up fee rounding can cost one more u: step down until it fits */
        while (k > 0) {
          var c0 = BigInt(L.m) * BigInt(k), f0 = charged ? takerFeeU(L.m, k, coef) : B0;
          if (c0 + f0 <= left) break;
          k--;
        }
        if (k <= 0) { exhausted = false; break; }
        var cost = BigInt(L.m) * BigInt(k), fee = charged ? takerFeeU(L.m, k, coef) : B0;
        costU += cost; feeU += fee; left -= cost + fee; n += k; takeAtLevel += k; lastM = L.m;
        if (k < avail) { exhausted = false; break; }
      }
      if (takeAtLevel) used.push({ price: milliStr(L.m), contracts: takeAtLevel });
      if (!exhausted) break;
    }
    var spent = costU + feeU;
    /* the ladder ran out with money left: is the remainder enough for one more contract at the last price? */
    var nextM = lastM != null ? lastM : (levels[0] && levels[0].m);
    var partial = exhausted && nextM != null && left >= BigInt(nextM);
    if (!n) return { status: 'NO_LIQUIDITY', reason: levels.length ? 'the stake cannot buy one contract at the best price' : 'no resting liquidity on the other side of the book', stake_u: stakeU.toString() };
    var payoutU = BigInt(n) * B1000;
    var out = {
      status: partial ? 'PARTIAL' : 'FILLED',
      contracts: n,
      cost: uToDollars(costU), fee: uToDollars(feeU), total: uToDollars(spent), payout: uToDollars(payoutU),
      profit_if_win: uToDollars(payoutU - spent), unspent: uToDollars(stakeU - spent),
      stake: uToDollars(stakeU), levels: used,
      vwap: (Number(costU) / n / 1000).toFixed(6),
      best_price: milliStr(levels[0].m), worst_price: milliStr(lastM),
      fee_charged: charged, fee_coefficient: charged ? String(coef) : null,
      /* what the stake actually bought, as odds */
      effective_decimal: Number(payoutU) / Number(spent),
      effective_implied: Number(spent) / Number(payoutU)
    };
    out.effective_american = decimalToAmerican(out.effective_decimal);
    out.top_decimal = 1000 / levels[0].m;
    out.top_american = decimalToAmerican(out.top_decimal);
    out.slippage_pp = (out.effective_implied - levels[0].m / 1000) * 100;
    out.top_not_achievable = n > 0 && lastM !== levels[0].m;
    if (partial) {
      out.reason = 'the book held ' + n + ' contracts (' + out.total + ' all-in); the rest of the stake (' + out.unspent + ') has no liquidity';
      out.fillable_dollars = out.total;
    }
    return out;
  }

  /** the executable quote for one outcome at a list of stakes */
  function executableQuote(book, outcomeId, outcomeIds, o) {
    o = o || {};
    var lad = askLadder(book, outcomeId, outcomeIds);
    if (!lad.ok) return { ok: false, reason: lad.reason };
    var fc = feeCharged(o.fee, o.eventStatus);
    var feeInfo = { charged: fc.charged === true, coefficient: o.fee && o.fee.coefficient };
    var top = lad.ladder[0] || null;
    var depthContracts = lad.ladder.reduce(function (s, l) { return s + l.qty; }, 0);
    var depthCostU = lad.ladder.reduce(function (s, l) { return s + BigInt(l.m) * BigInt(l.qty); }, B0);
    var stakes = (o.stakes || STAKES).map(function (s) { return Object.assign({ stake_dollars: Number(s) }, fill(lad.ladder, s, feeInfo)); });
    return {
      ok: true, outcome_id: outcomeId, against_outcome_id: lad.against,
      top: top ? { price: milliStr(top.m), contracts: top.qty, decimal: 1000 / top.m, american: decimalToAmerican(1000 / top.m), implied: top.m / 1000, on_grid: onGrid(top.m) } : null,
      depth: { levels: lad.ladder.length, contracts: depthContracts, cost_to_clear: uToDollars(depthCostU), payout_if_cleared: uToDollars(BigInt(depthContracts) * B1000) },
      fee: { charged: fc.charged, why: fc.why, coefficient: o.fee ? o.fee.coefficient || null : null, schedule: o.fee ? o.fee.charged || null : null, maker_credit: o.fee ? o.fee.makerCredit || null : null },
      stakes: stakes
    };
  }

  /* ------------------------------------------------------------ a sportsbook quote at a stake
     A fixed-odds book pays stake × decimal on a win. The decimal is the
     source's own (The Odds API's price_dec); American odds are derived. */
  function bookQuote(decimal, stakeDollars) {
    var d = Number(decimal), s = Number(stakeDollars);
    if (!(d > 1) || !(s > 0)) return { status: 'NO_PRICE' };
    var payout = s * d;
    return { status: 'FILLED', stake: s.toFixed(2), payout: payout.toFixed(2), profit_if_win: (payout - s).toFixed(2), effective_decimal: d, effective_implied: 1 / d, effective_american: decimalToAmerican(d), fee_charged: false };
  }

  /* ------------------------------------------------------------ hold and no-vig
     `outcomes` must be the COMPLETE mutually exclusive, exhaustive set of one
     market, quoted together: [{implied, label}]. Anything less returns null
     with the reason; nothing is filled in. */
  function hold(outcomes, o) {
    o = o || {};
    if (!Array.isArray(outcomes) || outcomes.length < 2) return { ok: false, reason: 'a hold needs the complete set of outcomes (at least two)' };
    if (o.expected != null && outcomes.length !== o.expected) return { ok: false, reason: 'the market has ' + o.expected + ' outcomes and ' + outcomes.length + ' were quoted' };
    if (o.sameSnapshot === false) return { ok: false, reason: 'the outcomes were not quoted in the same snapshot' };
    var p = outcomes.map(function (x) { return Number(x.implied); });
    if (p.some(function (x) { return !(x > 0 && x < 1); })) return { ok: false, reason: 'an outcome has no usable price' };
    var sum = p.reduce(function (a, b) { return a + b; }, 0);
    return { ok: true, overround: sum, hold: sum - 1, hold_pct: (sum - 1) * 100, n: p.length,
      note: 'the margin built into this complete set of prices (sum of implied probabilities minus one); not what any one bettor is certain to lose' };
  }
  /** proportional (multiplicative) normalisation; an ESTIMATE, labelled as one */
  function noVig(outcomes, o) {
    var h = hold(outcomes, o);
    if (!h.ok) return h;
    var p = outcomes.map(function (x) { return Number(x.implied); });
    return { ok: true, method: 'proportional', probabilities: p.map(function (x) { return x / h.overround; }), hold: h.hold,
      note: 'no-vig estimate by proportional normalisation of one venue\'s complete market: an estimate of the market\'s view, not a true probability' };
  }

  /* ------------------------------------------------------------ expected value
     EV per $1 staked = p · net_win_per_dollar − (1 − p − p_push).
     A push returns the stake (0). The probability must come from a model the
     caller has checked with modelGate(); this function does arithmetic only. */
  function evPerDollar(p, netWinPerDollar, pPush) {
    p = Number(p); var q = pPush == null ? 0 : Number(pPush); var w = Number(netWinPerDollar);
    if (!(p >= 0 && p <= 1) || !(q >= 0 && q <= 1) || p + q > 1 + 1e-12 || !isFinite(w)) return null;
    return p * w - (1 - p - q);
  }
  var EV_STATES = ['POSITIVE_BOTH', 'POSITIVE_NOVIG_ONLY', 'POSITIVE_BOOK_ONLY', 'NEGATIVE_BOTH', 'INSUFFICIENT_DATA'];
  var EV_STATE_LABEL = {
    POSITIVE_BOTH: 'Positive EV at both venues', POSITIVE_NOVIG_ONLY: 'Positive EV only at Novig', POSITIVE_BOOK_ONLY: 'Positive EV only at DraftKings',
    NEGATIVE_BOTH: 'Negative EV at both venues', INSUFFICIENT_DATA: 'Insufficient data: no EV is stated'
  };
  function evState(evBook, evNovig) {
    if (evBook == null || evNovig == null) return 'INSUFFICIENT_DATA';
    if (evBook > 0 && evNovig > 0) return 'POSITIVE_BOTH';
    if (evNovig > 0) return 'POSITIVE_NOVIG_ONLY';
    if (evBook > 0) return 'POSITIVE_BOOK_ONLY';
    return 'NEGATIVE_BOTH';
  }

  /** May this model probability price this exact market at this time?
      model: { p_win, p_push, model_version, tier, frozen_at, market: {kind, period, line, side},
               validated_tiers? }  quote: { kind, period, line, side, observed_at } */
  var MODEL_TIERS = { MARKET_VALIDATED: true, OUTCOME_VALIDATED: true, VALIDATED: true };
  function modelGate(model, quote, now) {
    var reasons = [];
    if (!model || model.p_win == null) return { ok: false, reasons: ['no model probability for this market'] };
    if (!model.model_version) reasons.push('the model is not versioned');
    if (!MODEL_TIERS[model.tier]) reasons.push('the model tier (' + (model.tier || 'unknown') + ') is not validated to price a market');
    var fz = Date.parse(model.frozen_at || ''), ob = Date.parse((quote && quote.observed_at) || ''), nw = now == null ? Date.now() : Number(now);
    if (!isFinite(fz)) reasons.push('the model probability carries no freeze time');
    else {
      if (isFinite(ob) && fz > ob) reasons.push('the model was frozen after the quote was observed (it could have seen the price)');
      if (nw - fz > RULES.model_max_age_hours * 3600e3) reasons.push('the model probability is older than ' + RULES.model_max_age_hours + ' hours');
    }
    var mm = model.market || {}, qm = quote || {};
    if (mm.kind !== qm.kind) reasons.push('the model prices ' + (mm.kind || '?') + ', the quote is ' + (qm.kind || '?'));
    if ((mm.period || 'game') !== (qm.period || 'game')) reasons.push('the model prices a different period');
    if ((mm.line == null ? null : Number(mm.line)) !== (qm.line == null ? null : Number(qm.line))) reasons.push('the model prices a different line (' + mm.line + ' vs ' + qm.line + ')');
    if (String(mm.side || '').toLowerCase() !== String(qm.side || '').toLowerCase()) reasons.push('the model prices the other side');
    return { ok: !reasons.length, reasons: reasons };
  }

  /* ------------------------------------------------------------ freshness (one place) */
  var STATES = ['LIVE', 'RECENT', 'STALE', 'SUSPENDED', 'NO_LIQUIDITY', 'MISMATCH', 'UNSUPPORTED', 'AWAITING'];
  var STATE_LABEL = { LIVE: 'Live', RECENT: 'Recently updated', STALE: 'Stale', SUSPENDED: 'Suspended', NO_LIQUIDITY: 'No liquidity', MISMATCH: 'Market mismatch', UNSUPPORTED: 'Unsupported market', AWAITING: 'Awaiting data' };
  /** venue: 'novig' | 'book'; source: 'ws' | 'rest' (Novig) */
  function freshness(venue, observedAt, now, o) {
    o = o || {};
    var t = typeof observedAt === 'number' ? observedAt : Date.parse(observedAt || '');
    var n = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
    if (!isFinite(t)) return { state: 'AWAITING', age_seconds: null, why: 'no observation yet' };
    var age = (n - t) / 1000;
    if (age < -120) return { state: 'STALE', age_seconds: age, why: 'timestamped in the future: not trusted' };
    if (o.suspended) return { state: 'SUSPENDED', age_seconds: age, why: o.suspended };
    if (venue === 'novig') {
      if (o.source === 'ws' && age <= RULES.novig_live_seconds) return { state: 'LIVE', age_seconds: age, why: 'streamed book, ' + Math.round(age) + ' s old' };
      if (age <= RULES.novig_recent_minutes * 60) return { state: 'RECENT', age_seconds: age, why: 'order-book snapshot ' + Math.round(age / 60) + ' min old' };
      return { state: 'STALE', age_seconds: age, why: 'order-book snapshot ' + Math.round(age / 60) + ' min old (limit ' + RULES.novig_recent_minutes + ')' };
    }
    if (age <= RULES.book_live_minutes * 60) return { state: 'LIVE', age_seconds: age, why: 'read ' + Math.round(age / 60) + ' min ago' };
    if (age <= RULES.book_recent_minutes * 60) return { state: 'RECENT', age_seconds: age, why: 'read ' + Math.round(age / 60) + ' min ago' };
    return { state: 'STALE', age_seconds: age, why: 'last read ' + Math.round(age / 60) + ' min ago (limit ' + RULES.book_recent_minutes + '): historical, not a current price' };
  }
  function actionable(state) { return state === 'LIVE' || state === 'RECENT'; }

  /* ------------------------------------------------------------ one selection at both venues
     book:  { decimal, observed_at, freshness? }
     novig: { quote (executableQuote result), observed_at, source, freshness? }
     model: optional (see modelGate); market: { kind, period, line, side }
     Returns the stake-aware comparison and every reason something is not said. */
  function compareSelection(input) {
    var o = input || {}, now = o.now == null ? Date.now() : o.now;
    var stakes = o.stakes || STAKES;
    var bf = o.book && o.book.decimal ? (o.book.freshness || freshness('book', o.book.observed_at, now)) : { state: 'AWAITING', why: 'no DraftKings price for this selection' };
    var nq = o.novig && o.novig.quote && o.novig.quote.ok ? o.novig.quote : null;
    var nf = o.novig && o.novig.observed_at ? (o.novig.freshness || freshness('novig', o.novig.observed_at, now, { source: o.novig.source, suspended: o.novig.suspended })) : { state: 'AWAITING', why: 'no Novig snapshot for this selection' };
    if (nq && !nq.top && nf.state !== 'AWAITING' && nf.state !== 'SUSPENDED') nf = Object.assign({}, nf, { state: 'NO_LIQUIDITY', why: 'nothing rests on the other side of Novig\'s book' });
    var bookOk = actionable(bf.state), novigOk = actionable(nf.state) && !!(nq && nq.top);
    var tB = Date.parse((o.book && o.book.observed_at) || ''), tN = Date.parse((o.novig && o.novig.observed_at) || '');
    var gapMin = isFinite(tB) && isFinite(tN) ? Math.abs(tB - tN) / 60000 : null;
    var simultaneous = gapMin != null && gapMin <= RULES.pair_max_gap_minutes;
    var notes = [];
    if (!bookOk) notes.push('DraftKings: ' + (bf.why || bf.state));
    if (!novigOk) notes.push('Novig: ' + (nf.why || nf.state));
    var comparable = bookOk && novigOk;
    if (comparable && !simultaneous) notes.push('the two prices were observed ' + Math.round(gapMin) + ' min apart: both are within their freshness windows, but this is not a simultaneous comparison');
    var mg = o.model ? modelGate(o.model, Object.assign({}, o.market || {}, { observed_at: o.novig && o.novig.observed_at }), now) : { ok: false, reasons: ['no model probability supplied'] };
    var rows = stakes.map(function (s) {
      var b = o.book && o.book.decimal ? bookQuote(o.book.decimal, s) : { status: 'NO_PRICE' };
      var n = nq ? (nq.stakes.find(function (x) { return x.stake_dollars === Number(s); }) || null) : null;
      var row = { stake: Number(s), book: b, novig: n, comparable: comparable && b.status === 'FILLED' && !!n && n.status === 'FILLED' };
      if (row.comparable) {
        var pb = Number(b.payout), pn = Number(n.payout) + Number(n.unspent);  /* the unspent remainder is returned, not lost */
        row.payout_diff = pn - pb;  /* positive: Novig pays more on a win for the same stake */
        row.better = Math.abs(n.effective_implied - b.effective_implied) * 100 < RULES.tie_pp ? 'TIE' : (pn > pb ? 'NOVIG' : 'DRAFTKINGS');
        row.implied_gap_pp = (b.effective_implied - n.effective_implied) * 100;
        row.cost_of_worse_price = Math.abs(pn - pb);
        if (mg.ok) {
          var pw = Number(o.model.p_win), pp = o.model.p_push == null ? 0 : Number(o.model.p_push);
          var evB = evPerDollar(pw, b.effective_decimal - 1, pp);
          var evN = evPerDollar(pw, Number(n.payout) / Number(n.total) - 1, pp);
          row.ev = { book_per_dollar: evB, novig_per_dollar: evN, delta_per_dollar: evN - evB,
            book_dollars: evB * Number(s), novig_dollars: evN * Number(n.total), delta_dollars: evN * Number(n.total) - evB * Number(s), state: evState(evB, evN) };
        } else row.ev = { state: 'INSUFFICIENT_DATA', reasons: mg.reasons };
      } else if (n && n.status === 'PARTIAL') row.why = 'Novig\'s book cannot fill $' + s + ' (' + (n.reason || 'partial fill') + ')';
      else if (n && n.status === 'NO_LIQUIDITY') row.why = 'no Novig liquidity at this stake';
      return row;
    });
    return {
      version: VERSION, market: o.market || null, comparable: comparable, simultaneous: simultaneous, gap_minutes: gapMin,
      book_state: bf.state, novig_state: nf.state, book_freshness: bf, novig_freshness: nf,
      top: comparable ? (function () {
        var bi = 1 / Number(o.book.decimal), ni = nq.top.implied, d = (bi - ni) * 100;
        return { book_american: decimalToAmerican(Number(o.book.decimal)), novig_american: nq.top.american, implied_gap_pp: d, better: Math.abs(d) < RULES.tie_pp ? 'TIE' : d > 0 ? 'NOVIG' : 'DRAFTKINGS' };
      })() : null,
      model: mg, rows: rows, notes: notes,
      disclaimer: 'Price comparison only. A better price is not, by itself, a positive-expected-value bet; EV is shown only against a versioned, validated model probability for this exact market.'
    };
  }

  /* ------------------------------------------------------------ small statistics for the research views */
  function median(xs) { var a = xs.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (x, y) { return x - y; }); if (!a.length) return null; var m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function quantile(xs, q) { var a = xs.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (x, y) { return x - y; }); if (!a.length) return null; var i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }
  /** Wilson score interval for k successes in n (z = 1.96) */
  function wilson(k, n, z) {
    if (!n) return { p: null, low: null, high: null, n: 0 };
    z = z || 1.959964;
    var p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return { p: p, low: Math.max(0, c - h), high: Math.min(1, c + h), n: n };
  }

  return {
    VERSION: VERSION, RULES: RULES, STAKES: STAKES, STATES: STATES, STATE_LABEL: STATE_LABEL, EV_STATES: EV_STATES, EV_STATE_LABEL: EV_STATE_LABEL,
    milli: milli, milliStr: milliStr, onGrid: onGrid, takerFeeU: takerFeeU, feeCharged: feeCharged, uToDollars: uToDollars, dollarsToU: dollarsToU, uNum: uNum,
    levelsOf: levelsOf, askLadder: askLadder, compactDepth: compactDepth, fill: fill, executableQuote: executableQuote, bookQuote: bookQuote,
    americanToDecimal: americanToDecimal, decimalToAmerican: decimalToAmerican, impliedFromAmerican: impliedFromAmerican, impliedFromDecimal: impliedFromDecimal,
    roundAmerican: roundAmerican, fmtAmerican: fmtAmerican,
    hold: hold, noVig: noVig, evPerDollar: evPerDollar, evState: evState, modelGate: modelGate,
    freshness: freshness, actionable: actionable, compareSelection: compareSelection,
    median: median, quantile: quantile, wilson: wilson
  };
});

// deno-lint-ignore-file
/*__EDFAIR_START__*/
/* ===========================================================================
   EdgeDesk FAIR-ODDS ENGINE — one deterministic price check for a sportsbook
   wager and a prediction-market contract, in exact decimal arithmetic.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.
   Node requires it directly (tools/intelligence/fairodds.test.js).

   WHAT IT ANSWERS
     "Is Rays at 61¢ positive EV?", "Is Cleveland -150 a good price?", "Find
     me a better price than this Kalshi contract", "What's the most I can pay
     for this?", "Why is this contract negative EV?" — for ONE outcome at ONE
     executable price, against ONE named fair probability.

   THE RULES
     - It computes no probability of its own. The fair probability is handed
       in with its source (a sharp no-vig, a consensus no-vig, a validated
       model, a research model, the reader's own number), and the source
       decides what the result may be called. A research-tier model never
       produces a verdict stronger than WATCH.
     - Money is exact. Prices, fees, payouts and expected values are decimals
       held as a BigInt and a scale (the convention lib/edgedesk_portfolio.js
       uses for the reader's ledger). Probabilities are carried to 12 places.
       Nothing is a binary float until it is printed.
     - Units are typed. A probability is in [0, 1]; a contract price is in
       dollars per $1 of payout; cents, percents and American odds are
       converted at the door and a value that looks like the wrong unit (61
       passed as a probability, 0.61 passed as cents, -50 passed as American
       odds) is refused with a UNIT error, never guessed.
     - Fees belong to a venue. Each venue carries its own fee model, rounding
       rule, source and verification status. No venue's formula is applied to
       another. A schedule that has not been verified caps the verdict below
       VERIFIED EDGE; a schedule that is unknown leaves net EV null and says
       how much fee the price could absorb.
     - The thresholds are EDINTEL's own (ev_floor, candidate_ev), read at run
       time when the decision layer is loaded, so the desk and this engine
       cannot disagree about the same price.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDFAIR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_fairodds_v1';
  var CALC_VERSION = 'fairodds_calc_1.0.0';
  var PSCALE = 12; /* probability and odds-ratio places */

  /* ================================================================ */
  /* 1. EXACT DECIMALS — {n: BigInt, s: scale}, value n / 10^s         */
  /* ================================================================ */
  var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B10 = BigInt(10);
  var NUM_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
  function pow10(k) { var r = B1; for (var i = 0; i < k; i++) r *= B10; return r; }
  function trim(d) { while (d.s > 0 && d.n % B10 === B0) { d.n /= B10; d.s--; } return d; }
  function D(x) {
    if (x == null) return null;
    if (typeof x === 'object' && typeof x.n === 'bigint') return x;
    if (typeof x === 'object' && x.unit && x.d) return x.d;
    if (typeof x === 'number' && !isFinite(x)) return null;
    if (typeof x === 'bigint') return { n: x, s: 0 };
    /* a binary float is read through its shortest round-trip string, so 0.61 is 0.61 */
    var s = String(x).trim();
    if (s === '') return null;
    var m = NUM_RE.exec(s);
    if (!m || ((m[2] || '') === '' && (m[3] || '') === '')) return null;
    var frac = m[3] || '', exp = m[4] ? parseInt(m[4], 10) : 0;
    if (Math.abs(exp) > 60) return null;
    var n = BigInt(((m[2] || '') + frac) || '0'), scale = frac.length - exp;
    if (scale < 0) { n = n * pow10(-scale); scale = 0; }
    if (m[1] === '-') n = -n;
    return trim({ n: n, s: scale });
  }
  function up(d, s) { return d.s === s ? d.n : d.n * pow10(s - d.s); }
  function add(a, b) { var s = Math.max(a.s, b.s); return trim({ n: up(a, s) + up(b, s), s: s }); }
  function sub(a, b) { var s = Math.max(a.s, b.s); return trim({ n: up(a, s) - up(b, s), s: s }); }
  function mul(a, b) { return trim({ n: a.n * b.n, s: a.s + b.s }); }
  function neg(a) { return { n: -a.n, s: a.s }; }
  function cmp(a, b) { var s = Math.max(a.s, b.s), x = up(a, s), y = up(b, s); return x < y ? -1 : x > y ? 1 : 0; }
  function sgn(a) { return a.n > B0 ? 1 : a.n < B0 ? -1 : 0; }
  function isZero(a) { return a.n === B0; }
  function maxD(a, b) { return cmp(a, b) >= 0 ? a : b; }
  function minD(a, b) { return cmp(a, b) <= 0 ? a : b; }
  /* a / b at `scale` places, rounded half away from zero */
  function div(a, b, scale) {
    if (b.n === B0) return null;
    var k = scale == null ? PSCALE : scale;
    var nu = a.n * pow10(b.s + k), de = b.n * pow10(a.s);
    var q = nu / de, r = nu - q * de;
    var ar = r < B0 ? -r : r, ad = de < B0 ? -de : de;
    if (B2 * ar >= ad) q += ((nu < B0) !== (de < B0)) ? -B1 : B1;
    return trim({ n: q, s: k });
  }
  /* round toward +infinity / -infinity at k places (fee rounding is directional) */
  function ceilTo(a, k) {
    if (a.s <= k) return a;
    var f = pow10(a.s - k), q = a.n / f, r = a.n - q * f;
    if (r > B0) q += B1;
    return trim({ n: q, s: k });
  }
  function floorTo(a, k) {
    if (a.s <= k) return a;
    var f = pow10(a.s - k), q = a.n / f, r = a.n - q * f;
    if (r < B0) q -= B1;
    return trim({ n: q, s: k });
  }
  function roundTo(a, k) { return div(a, ONE, k); }
  function S(d) {
    if (d == null) return null;
    var negv = d.n < B0, t = (negv ? -d.n : d.n).toString();
    if (d.s > 0) { while (t.length <= d.s) t = '0' + t; t = t.slice(0, t.length - d.s) + '.' + t.slice(t.length - d.s); }
    return (negv && d.n !== B0 ? '-' : '') + t;
  }
  function N(d) { return d == null ? null : Number(S(d)); }
  function fixed(d, k) {
    if (d == null) return null;
    var t = S(roundTo(d, k)), i = t.indexOf('.');
    if (k === 0) return t;
    if (i < 0) return t + '.' + new Array(k + 1).join('0');
    return t + new Array(k - (t.length - i - 1) + 1).join('0');
  }
  var ZERO = { n: B0, s: 0 }, ONE = { n: B1, s: 0 }, HUNDRED = { n: BigInt(100), s: 0 };

  /* ================================================================ */
  /* 2. TYPED UNITS — converted at the door, refused when ambiguous    */
  /* ================================================================ */
  function unitError(code, message) { var e = new Error(message); e.code = code; e.unit_error = true; return e; }
  function tag(unit, d) { return { unit: unit, d: d, value: S(d) }; }
  function isTag(x, unit) { return !!(x && typeof x === 'object' && x.unit === unit && x.d); }
  var T = {
    /** A probability in [0, 1]. 61 is refused (that is a percent); so is -0.1. */
    probability: function (v, label) {
      if (isTag(v, 'probability')) return v;
      if (isTag(v, 'percent')) return tag('probability', div(v.d, HUNDRED, PSCALE));
      var d = D(v), name = label || 'probability';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      if (sgn(d) < 0 || cmp(d, ONE) > 0) throw unitError('PROBABILITY_RANGE', name + ' must be between 0 and 1; ' + S(d) + (cmp(d, ONE) > 0 && cmp(d, HUNDRED) <= 0 ? ' looks like a percent (pass it as a percent, e.g. T.percent(' + S(d) + '))' : ' is out of range'));
      return tag('probability', d);
    },
    percent: function (v, label) {
      if (isTag(v, 'percent')) return v;
      var d = D(v), name = label || 'percent';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      if (sgn(d) < 0 || cmp(d, HUNDRED) > 0) throw unitError('PERCENT_RANGE', name + ' must be between 0 and 100: ' + S(d));
      return tag('percent', d);
    },
    /** A binary contract price in DOLLARS per $1 of payout, strictly between 0 and 1. */
    contractPrice: function (v, label) {
      if (isTag(v, 'contract_price')) return v;
      if (isTag(v, 'cents')) return tag('contract_price', div(v.d, HUNDRED, 6));
      var d = D(v), name = label || 'contract price';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      if (sgn(d) <= 0 || cmp(d, ONE) >= 0) throw unitError('CONTRACT_PRICE_RANGE', name + ' must be in dollars, strictly between $0 and $1; ' + S(d) + (cmp(d, ONE) >= 0 && cmp(d, HUNDRED) < 0 ? ' looks like cents (pass it as cents, e.g. T.cents(' + S(d) + '))' : ' is out of range'));
      return tag('contract_price', d);
    },
    /** A contract price in cents, strictly between 0 and 100. 0.61 is refused: that is dollars. */
    cents: function (v, label, opts) {
      if (isTag(v, 'cents')) return v;
      if (isTag(v, 'contract_price')) return tag('cents', mul(v.d, HUNDRED));
      var d = D(v), name = label || 'price in cents';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      if (sgn(d) <= 0 || cmp(d, HUNDRED) >= 0) throw unitError('CENTS_RANGE', name + ' must be strictly between 0 and 100 cents: ' + S(d));
      if (cmp(d, ONE) < 0 && !(opts && opts.allow_subcent)) throw unitError('CENTS_LOOKS_LIKE_DOLLARS', name + ' ' + S(d) + ' is under one cent; if it is a dollar price pass it as T.contractPrice(' + S(d) + ')');
      return tag('cents', d);
    },
    /** American odds: |odds| >= 100. -50 and +50 are not American prices. */
    american: function (v, label) {
      if (isTag(v, 'american')) return v;
      var d = D(typeof v === 'string' ? v.replace(/^\+/, '') : v), name = label || 'American odds';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      var a = d.n < B0 ? neg(d) : d;
      if (cmp(a, HUNDRED) < 0) throw unitError('AMERICAN_RANGE', name + ' must be +100 or longer, or -100 or shorter; ' + S(d) + ' is not an American price' + (sgn(d) > 0 && cmp(d, D('1')) > 0 && cmp(d, D('100')) < 0 && d.s > 0 ? ' (it may be decimal odds)' : ''));
      return tag('american', d);
    },
    /** Decimal (European) odds, strictly above 1. */
    decimalOdds: function (v, label) {
      if (isTag(v, 'decimal_odds')) return v;
      var d = D(v), name = label || 'decimal odds';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      if (cmp(d, ONE) <= 0) throw unitError('DECIMAL_RANGE', name + ' must be above 1.0: ' + S(d));
      if (cmp(d, D('100')) >= 0 && d.s === 0) throw unitError('DECIMAL_LOOKS_AMERICAN', name + ' ' + S(d) + ' looks like an American price; pass it as T.american(' + S(d) + ')');
      return tag('decimal_odds', d);
    },
    dollars: function (v, label) {
      if (isTag(v, 'dollars')) return v;
      var d = D(v), name = label || 'dollar amount';
      if (d == null) throw unitError('NOT_A_NUMBER', name + ' is not a number: ' + String(v));
      return tag('dollars', d);
    }
  };

  /* ================================================================ */
  /* 3. ODDS ARITHMETIC — exact where the price is exact               */
  /* ================================================================ */
  /** American → decimal. +150 → 2.5 exactly; -110 → 1.909090909091 (12 places). */
  function americanToDecimal(am) {
    var a = T.american(am).d;
    return sgn(a) > 0 ? add(ONE, div(a, HUNDRED, PSCALE)) : add(ONE, div(HUNDRED, neg(a), PSCALE));
  }
  /** Decimal → American, unrounded (an exact price prints as an exact price). */
  function decimalToAmerican(dec) {
    var d = T.decimalOdds(dec).d;
    var two = D('2');
    return cmp(d, two) >= 0 ? mul(sub(d, ONE), HUNDRED) : neg(div(HUNDRED, sub(d, ONE), PSCALE));
  }
  /** Probability → fair decimal odds (1/p), null at 0. */
  function probToDecimal(p) { var d = T.probability(p).d; return isZero(d) ? null : div(ONE, d, PSCALE); }
  function probToAmerican(p) {
    var d = T.probability(p).d;
    if (isZero(d) || cmp(d, ONE) === 0) return null;
    return decimalToAmerican(div(ONE, d, PSCALE));
  }
  function impliedFromDecimal(dec) { return div(ONE, T.decimalOdds(dec).d, PSCALE); }
  /** Whole-number American price for display, rounded to the nearest point. */
  function wholeAmerican(d) { if (d == null) return null; var r = roundTo(d, 0); return N(r) === -100 ? 100 : N(r); }

  /* ------------------------------------------------- no-vig, n outcomes */
  /**
   * Fair probabilities from n mutually exclusive, exhaustive prices of ONE
   * market at ONE book. Every outcome must be priced: a single side carries an
   * unknown margin and is refused. Methods: multiplicative (the board's
   * default, lib/research_core.js odds.devig2), additive, power.
   * prices: [{american} | {decimal}] → { probabilities:[string], overround, method }
   */
  function noVig(prices, method) {
    if (!Array.isArray(prices) || prices.length < 2) return { ok: false, code: 'ONE_SIDED', why: 'A no-vig probability needs every outcome of the market priced at the same book; a single price carries an unknown margin.' };
    var imp = [];
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i] || {};
      var dec = p.decimal != null ? T.decimalOdds(p.decimal).d : p.american != null ? americanToDecimal(p.american) : p.contract_price != null ? div(ONE, T.contractPrice(p.contract_price).d, PSCALE) : null;
      if (dec == null) return { ok: false, code: 'MISSING_PRICE', why: 'outcome ' + (i + 1) + ' has no price' };
      imp.push(div(ONE, dec, PSCALE));
    }
    var total = imp.reduce(add, ZERO);
    var over = sub(total, ONE);
    var m = method || 'multiplicative', out;
    if (m === 'multiplicative') out = imp.map(function (x) { return div(x, total, PSCALE); });
    else if (m === 'additive') {
      var share = div(over, D(String(imp.length)), PSCALE);
      out = imp.map(function (x) { return sub(x, share); });
      if (out.some(function (x) { return sgn(x) <= 0; })) return { ok: false, code: 'ADDITIVE_NEGATIVE', why: 'the additive method pushes a long shot below zero at this margin; use multiplicative or power' };
    } else if (m === 'power') {
      /* find k with sum(imp_i^k) = 1 by bisection; probabilities, not money, so a float search is acceptable */
      var f = imp.map(N), lo = 0.5, hi = 3, k = 1;
      for (var it = 0; it < 200; it++) { k = (lo + hi) / 2; var s = 0; for (var j = 0; j < f.length; j++) s += Math.pow(f[j], k); if (s > 1) lo = k; else hi = k; }
      out = f.map(function (x) { return D(Math.pow(x, k).toFixed(PSCALE)); });
      var fs = out.reduce(add, ZERO); out = out.map(function (x) { return div(x, fs, PSCALE); });
    } else return { ok: false, code: 'UNKNOWN_METHOD', why: 'no-vig method ' + m + ' is not implemented' };
    return { ok: true, method: m, probabilities: out.map(S), overround: S(roundTo(over, 6)), implied: imp.map(S) };
  }

  /* ================================================================ */
  /* 4. VENUES AND FEES                                                */
  /* ================================================================ */
  /*
   * Every venue is one of three payout models:
   *   SPORTSBOOK   fixed-odds wager; the margin is inside the price; no
   *                explicit fee. Risk S at decimal D returns S·D on a win.
   *   BINARY_CONTRACT  pays $1 per contract on YES (or NO); costs the price
   *                plus the venue's trading fee; an exchange, so fills walk
   *                the order book.
   *   EXCHANGE_COMMISSION  back/lay exchange charging commission on net
   *                winnings (no venue is registered with a rate yet).
   *
   * verification:
   *   VERIFIED     structural (a sportsbook has no explicit fee) or checked
   *                against the venue's own published schedule on `verified_on`
   *   UNVERIFIED   the formula is from secondary sources; it is used, and the
   *                verdict is capped at POTENTIAL EDGE
   *   UNKNOWN      no usable parameters; net EV is not computed
   * An operator-verified row (market_execution_costs) or a per-request
   * override replaces the built-in schedule and says so.
   */
  var VENUES = {
    sportsbook: {
      key: 'sportsbook', label: 'Sportsbook', model: 'SPORTSBOOK',
      fee: { kind: 'NONE', verification: 'VERIFIED', basis: 'A fixed-odds sportsbook charges no explicit fee; its margin is inside the price and is measured by the no-vig comparison.' },
      settlement: 'House rules per book (e.g. MLB "listed pitchers" vs "action"; a postponed game is usually void). Check the book\'s rules for the market.'
    },
    kalshi: {
      key: 'kalshi', label: 'Kalshi', model: 'BINARY_CONTRACT', tick: '0.01',
      fee: {
        kind: 'KALSHI_QUADRATIC',
        taker_coefficient: '0.07', maker_coefficient: '0.0175',
        formula: 'fee = round_up_to_cent(coefficient × contracts × price × (1 − price)) per order',
        rounding: 'CEIL_CENT_PER_ORDER',
        maker_fee_applies: 'only on markets Kalshi flags for maker fees; otherwise makers pay nothing',
        verification: 'UNVERIFIED',
        verified_on: null,
        basis: 'Formula as summarised by secondary sources (2026); kalshi.com and docs.kalshi.com were not reachable from the build environment on 2026-10-11, so the coefficient and the fill-level rounding were not checked against Kalshi\'s own schedule. Some categories may carry a different coefficient.',
        source_url: 'https://kalshi.com/docs/kalshi-fee-schedule.pdf'
      },
      settlement: 'Each contract settles on the market\'s own rules text (source of truth, overtime treatment, postponement window). Read the rules before comparing with a sportsbook market.'
    },
    polymarket: {
      key: 'polymarket', label: 'Polymarket', model: 'BINARY_CONTRACT', tick: '0.01',
      fee: {
        kind: 'POLYMARKET_PARAMETRIC',
        formula: 'fee = contracts × price × rate × (price × (1 − price))^exponent, taker side, rate and exponent set per market category',
        rounding: 'UNSPECIFIED',
        categories: { sports: { rate: null, exponent: null } },
        verification: 'UNKNOWN',
        verified_on: null,
        basis: 'Secondary sources disagree on the formula and on the sports rate in 2026 (and Polymarket US may differ from the global venue); docs.polymarket.com was not reachable from the build environment. No parameters are assumed.',
        source_url: 'https://docs.polymarket.com/trading/fees'
      },
      settlement: 'Settles on the market\'s resolution source as written in its rules.'
    },
    /* A contract price quoted with no venue named: no fee model is assumed. */
    unspecified: {
      key: 'unspecified', label: 'an unnamed exchange', model: 'BINARY_CONTRACT', tick: '0.01',
      fee: { kind: 'UNKNOWN', formula: null, rounding: null, verification: 'UNKNOWN', verified_on: null, basis: 'no venue was named, so no venue\'s fee schedule is applied' },
      settlement: 'Unknown: the venue was not named.'
    }
  };
  var SPORTSBOOK_KEYS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'pinnacle', 'circa', 'betrivers', 'bet365', 'espnbet', 'fanatics', 'bovada', 'pointsbet', 'hardrockbet', 'betonlineag', 'lowvig', 'mybookieag', 'williamhill_us', 'wynnbet', 'superbook', 'unibet_us', 'betus', 'ballybet'];
  function venueOf(key) {
    var k = String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (VENUES[k]) return VENUES[k];
    if (SPORTSBOOK_KEYS.indexOf(k) >= 0 || /book|bet|sports/.test(k)) return Object.assign({}, VENUES.sportsbook, { key: k, label: key });
    return null;
  }
  /**
   * The fee on one order. price: contract price in dollars (Decimal);
   * contracts: integer; role: 'taker'|'maker'; o.market_maker_fees: bool;
   * o.override: { per_contract_dollars | total_dollars | coefficient | rate, exponent, source, verified }
   * → { status, total, per_contract, formula, rounding, basis }
   */
  function contractFee(venue, price, contracts, role, o) {
    o = o || {};
    var C = D(String(contracts));
    var ov = o.override || null;
    if (ov) {
      var st = ov.verified ? 'VERIFIED' : 'OVERRIDE';
      if (ov.per_contract_dollars != null) { var pc = T.dollars(ov.per_contract_dollars).d; return { status: st, total: mul(pc, C), per_contract: pc, formula: 'per-contract fee supplied: $' + S(pc), rounding: 'AS_SUPPLIED', basis: ov.source || 'supplied with the request' }; }
      if (ov.total_dollars != null) { var tt = T.dollars(ov.total_dollars).d; return { status: st, total: tt, per_contract: div(tt, C, 6), formula: 'order fee supplied: $' + S(tt), rounding: 'AS_SUPPLIED', basis: ov.source || 'supplied with the request' }; }
      if (ov.coefficient != null && venue.fee.kind === 'KALSHI_QUADRATIC') {
        var raw0 = mul(mul(mul(D(String(ov.coefficient)), C), price), sub(ONE, price));
        var tot0 = ceilTo(raw0, 2);
        return { status: st, total: tot0, per_contract: div(tot0, C, 6), raw: S(raw0), formula: 'round_up_to_cent(' + ov.coefficient + ' × ' + contracts + ' × ' + S(price) + ' × ' + S(sub(ONE, price)) + ')', rounding: 'CEIL_CENT_PER_ORDER', basis: ov.source || 'operator coefficient' };
      }
      if (ov.rate != null && ov.exponent != null && venue.fee.kind === 'POLYMARKET_PARAMETRIC') {
        var pq = mul(price, sub(ONE, price)), e = Number(ov.exponent);
        var powv = D(Math.pow(N(pq), e).toFixed(PSCALE));
        var raw1 = mul(mul(mul(C, price), D(String(ov.rate))), powv);
        return { status: st, total: roundTo(raw1, 6), per_contract: div(raw1, C, 6), raw: S(raw1), formula: contracts + ' × ' + S(price) + ' × ' + ov.rate + ' × (' + S(pq) + ')^' + ov.exponent, rounding: 'UNROUNDED_6DP', basis: ov.source || 'operator parameters' };
      }
    }
    var f = venue.fee;
    if (f.kind === 'NONE') return { status: 'VERIFIED', total: ZERO, per_contract: ZERO, formula: 'no explicit fee', rounding: 'NONE', basis: f.basis };
    if (f.kind === 'KALSHI_QUADRATIC') {
      if (role === 'maker' && !o.market_maker_fees) return { status: f.verification, total: ZERO, per_contract: ZERO, formula: 'maker order on a market without maker fees', rounding: f.rounding, basis: f.basis };
      var coef = D(role === 'maker' ? f.maker_coefficient : f.taker_coefficient);
      var raw = mul(mul(mul(coef, C), price), sub(ONE, price));
      var tot = ceilTo(raw, 2);
      return { status: f.verification, total: tot, per_contract: div(tot, C, 6), raw: S(raw), formula: 'round_up_to_cent(' + S(coef) + ' × ' + contracts + ' × ' + S(price) + ' × ' + S(sub(ONE, price)) + ') = ' + S(tot), rounding: f.rounding, basis: f.basis };
    }
    if (f.kind === 'POLYMARKET_PARAMETRIC') {
      var cat = f.categories[o.category || 'sports'] || {};
      if (cat.rate == null || cat.exponent == null) return { status: 'UNKNOWN', total: null, per_contract: null, formula: f.formula, rounding: f.rounding, basis: f.basis };
    }
    return { status: 'UNKNOWN', total: null, per_contract: null, formula: f.formula || null, rounding: f.rounding || null, basis: f.basis || 'no fee model' };
  }

  /* ================================================================ */
  /* 5. THRESHOLDS — EDINTEL's, read at run time                       */
  /* ================================================================ */
  var DEFAULTS = {
    ev_floor: '0.005',      /* EDINTEL CONFIG.ev_floor: the playable bound */
    candidate_ev: '0.02',   /* EDINTEL CONFIG.candidate_ev: an edge, not a lean */
    sane_ev: '0.20',        /* past this the price is a data question first (capture's LEARN_EDGE_MAX for h2h) */
    min_books_confirm: 2,   /* independent quotes needed for MARKET confirmation */
    quote_ttl_min: 90       /* EDINTEL quote_ttl_min default, before the kickoff ladder */
  };
  function thresholds(over) {
    var t = Object.assign({}, DEFAULTS);
    var I = root.EDINTEL;
    var cfg = I && (I.CONFIG || (typeof I.config === 'function' ? I.config() : null));
    if (cfg) {
      if (cfg.ev_floor != null) t.ev_floor = String(cfg.ev_floor);
      if (cfg.candidate_ev != null) t.candidate_ev = String(cfg.candidate_ev);
      t.source = 'EDINTEL.CONFIG';
    } else t.source = 'EDFAIR defaults (EDINTEL not loaded)';
    if (over) Object.keys(over).forEach(function (k) { if (over[k] != null) t[k] = String(over[k]); });
    return t;
  }

  /* ================================================================ */
  /* 6. FAIR SOURCES — what a fair probability is allowed to be called */
  /* ================================================================ */
  /*
   * kind:
   *   SHARP_NO_VIG      both sides of one market at a sharp book, de-vigged
   *   CONSENSUS_NO_VIG  the median no-vig across books
   *   MODEL             an EdgeDesk model; its tier decides (VALIDATED / LEAN /
   *                     PROBABILITY may price; RESEARCH may not)
   *   USER              the reader's own number: arithmetic only
   * A market-derived fair is a reference, not an independent model: it can
   * show a book is out of line with the market, not that the market is wrong.
   */
  var FAIR_KINDS = {
    SHARP_NO_VIG: { independent: false, may_price: true, calibration: 'MARKET_DERIVED', note: 'market-derived: shows this price is out of line with the sharp market, not that the market is wrong; its record is the CLV ledger' },
    CONSENSUS_NO_VIG: { independent: false, may_price: true, calibration: 'MARKET_DERIVED', note: 'market-derived consensus of several books; weaker than a sharp reference' },
    MODEL: { independent: true, may_price: null, calibration: null, note: 'an EdgeDesk model; the validation tier decides whether it may price' },
    USER: { independent: false, may_price: false, calibration: 'NOT_CALIBRATED', note: 'the reader\'s own probability: the arithmetic is exact, the input is theirs' }
  };
  var PRICING_TIERS = { VALIDATED: true, LEAN: true, PROBABILITY: true, RESEARCH: false };
  function fairSourceOf(src) {
    src = src || {};
    var kind = FAIR_KINDS[src.kind] ? src.kind : null;
    if (!kind) return { kind: null, may_price: false, calibration_status: 'UNAVAILABLE', note: 'no fair probability source named', independent: false };
    var base = FAIR_KINDS[kind];
    var tier = src.tier || null;
    var may = base.may_price;
    var cal = base.calibration;
    if (kind === 'MODEL') { may = !!PRICING_TIERS[tier]; cal = tier === 'VALIDATED' ? 'CALIBRATED' : tier === 'LEAN' || tier === 'PROBABILITY' ? 'PARTIALLY_CALIBRATED' : 'UNCALIBRATED'; }
    return { kind: kind, label: src.label || null, tier: tier, model_version: src.model_version || null, observed_at: src.observed_at || null, may_price: may, independent: base.independent, calibration_status: cal, calibration_basis: src.calibration_basis || null, note: base.note + (kind === 'MODEL' && !may ? ' (tier ' + (tier || 'unknown') + ': research only, no expected value is quoted as an edge)' : '') };
  }

  /* ================================================================ */
  /* 7. FRESHNESS, LIQUIDITY, UNCERTAINTY                              */
  /* ================================================================ */
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function freshness(observedAt, now, ttlMin, label) {
    var t = toMs(observedAt), n = toMs(now) != null ? toMs(now) : Date.now(), ttl = Number(ttlMin) || DEFAULTS.quote_ttl_min;
    if (t == null) return { status: 'UNKNOWN', age_min: null, ttl_min: ttl, why: (label || 'observation') + ' time not recorded; never actionable' };
    var age = Math.round((n - t) / 60000);
    if (age < -2) return { status: 'UNKNOWN', age_min: age, ttl_min: ttl, why: (label || 'observation') + ' is timestamped in the future' };
    var st = age <= ttl ? 'LIVE' : age <= 2 * ttl ? 'AGING' : 'STALE';
    return { status: st, age_min: age, ttl_min: ttl, why: (label || 'observation') + ' is ' + age + ' min old against a ' + ttl + ' min limit' };
  }
  /** Walk an ask ladder for `contracts`: [[price_dollars, size], ...] best first → { vwap, filled, short } */
  function walkBook(asks, contracts) {
    if (!Array.isArray(asks) || !asks.length) return null;
    var need = D(String(contracts)), got = ZERO, cost = ZERO;
    for (var i = 0; i < asks.length && cmp(got, need) < 0; i++) {
      var px = T.contractPrice(asks[i][0], 'order book price').d, sz = D(String(asks[i][1]));
      if (sz == null || sgn(sz) <= 0) continue;
      var take = minD(sz, sub(need, got));
      cost = add(cost, mul(px, take)); got = add(got, take);
    }
    if (isZero(got)) return { vwap: null, filled: '0', short: S(need) };
    return { vwap: div(cost, got, 6), filled: S(got), short: S(sub(need, got)), best: T.contractPrice(asks[0][0]).d };
  }

  /* ================================================================ */
  /* 8. THE EVALUATIONS                                                */
  /* ================================================================ */
  function errResult(e, kind) {
    return { ok: false, schema: VERSION, kind: kind, error: { code: e && e.code ? e.code : 'ERROR', message: e && e.message ? e.message : String(e), unit_error: !!(e && e.unit_error) }, classification: 'UNVERIFIED_DATA', decision: 'PASS' };
  }
  function pctStr(d, k) { return d == null ? null : fixed(mul(d, HUNDRED), k == null ? 2 : k) + '%'; }

  /**
   * One binary contract at one price.
   * o.venue ('kalshi' | 'polymarket' | a key VENUES carries)
   * o.side 'YES' | 'NO'
   * o.price_cents | o.price (dollars)          the executable ask for that side
   * o.opposite_price_cents | o.opposite_price  the other side's ask, for the market's no-vig
   * o.contracts (default 1) | o.stake_dollars   the size (stake buys whole contracts at the all-in cost)
   * o.role 'taker' (default) | 'maker'; o.market_maker_fees bool; o.category
   * o.fee_override  see contractFee
   * o.orderbook { asks: [[price_dollars, size], ...] } for this side (slippage)
   * o.slippage_cents  an explicit estimate when no book is supplied
   * o.fair_probability   of THIS SIDE winning (probability units)
   * o.fair_probability_yes  of YES (the side's fair is derived)
   * o.fair_source { kind, label, tier, model_version, observed_at }
   * o.fair_interval { low, high }   probability bounds for this side, if the source has them
   * o.quote_observed_at, o.now, o.ttl_min
   * o.settlement { verified: bool, terms, mismatch }   from the sport adapter / comparison
   * o.audit { status }   from EDAUDIT, when it has run
   * o.thresholds   overrides
   */
  function evaluateContract(o) {
    o = o || {};
    try {
      var venue = venueOf(o.venue);
      if (!venue) throw unitError('UNKNOWN_VENUE', 'venue ' + String(o.venue) + ' has no fee model; EdgeDesk will not apply another venue\'s fees to it');
      if (venue.model !== 'BINARY_CONTRACT') throw unitError('WRONG_MODEL', venue.label + ' is a ' + venue.model + ', not a binary contract venue');
      var side = String(o.side || 'YES').toUpperCase();
      if (side !== 'YES' && side !== 'NO') throw unitError('BAD_SIDE', 'side must be YES or NO');
      var price = o.price_cents != null ? T.contractPrice(T.cents(o.price_cents, 'price')).d : T.contractPrice(o.price, 'price').d;
      var tick = D(venue.tick || '0.01');
      var th = thresholds(o.thresholds);
      var now = toMs(o.now) != null ? toMs(o.now) : Date.now();

      /* size */
      var contracts = o.contracts != null ? Number(o.contracts) : null;
      if (contracts != null && (!(contracts >= 1) || Math.floor(contracts) !== contracts)) throw unitError('BAD_CONTRACTS', 'contracts must be a whole number of at least 1');

      /* fair probability for this side */
      var fair = null;
      if (o.fair_probability != null) fair = T.probability(o.fair_probability, 'fair probability').d;
      else if (o.fair_probability_yes != null) { var fy = T.probability(o.fair_probability_yes, 'fair probability (YES)').d; fair = side === 'YES' ? fy : sub(ONE, fy); }
      var src = fairSourceOf(o.fair_source);

      /* slippage: the order book when supplied, else an explicit estimate, else unknown (0, flagged) */
      var slip = ZERO, slipBasis = 'no order book or slippage estimate was supplied; assumed zero and flagged', liquidity = { status: 'UNKNOWN', depth_at_best: null, filled: null, note: 'No order-book depth on file: a large order may fill worse than the quoted price.' };
      var stakeContracts = null;
      if (contracts == null && o.stake_dollars != null) {
        /* the largest whole number of contracts whose all-in cost fits the stake, fees included */
        var stake = T.dollars(o.stake_dollars, 'stake').d;
        var guess = Math.floor(N(div(stake, price, 6)));
        while (guess >= 1) {
          var fg = contractFee(venue, price, guess, o.role || 'taker', { market_maker_fees: o.market_maker_fees, category: o.category, override: o.fee_override });
          var allIn = add(mul(price, D(String(guess))), fg.total || ZERO);
          if (cmp(allIn, stake) <= 0) break;
          guess--;
        }
        stakeContracts = guess;
        contracts = guess >= 1 ? guess : null;
        if (contracts == null) throw unitError('STAKE_TOO_SMALL', 'a stake of $' + S(stake) + ' does not buy one contract at $' + S(price) + ' plus fees');
      }
      if (contracts == null) contracts = 1;
      var book = o.orderbook && Array.isArray(o.orderbook.asks) ? walkBook(o.orderbook.asks, contracts) : null;
      if (book && book.vwap) {
        slip = maxD(ZERO, sub(book.vwap, price));
        slipBasis = 'walked the supplied order book for ' + contracts + ' contract' + (contracts === 1 ? '' : 's') + ': average fill $' + S(book.vwap) + ' against the $' + S(price) + ' quote';
        liquidity = { status: D(book.short) && sgn(D(book.short)) > 0 ? 'INSUFFICIENT' : 'ADEQUATE', depth_at_best: o.orderbook.asks[0] ? String(o.orderbook.asks[0][1]) : null, filled: book.filled, short: book.short, note: sgn(D(book.short)) > 0 ? 'The book on file cannot fill ' + contracts + ' contracts; ' + book.short + ' would rest unfilled.' : 'The book on file fills the order.' };
      } else if (o.slippage_cents != null) {
        slip = T.contractPrice(T.cents(o.slippage_cents, 'slippage', { allow_subcent: true })).d;
        slipBasis = 'explicit slippage estimate supplied: ' + S(mul(slip, HUNDRED)) + '¢ per contract';
        liquidity.status = 'ESTIMATED';
      }
      var execPrice = add(price, slip);

      /* fees on this order */
      var fee = contractFee(venue, execPrice, contracts, o.role || 'taker', { market_maker_fees: o.market_maker_fees, category: o.category, override: o.fee_override });
      var feePer = fee.per_contract;
      var cost = feePer != null ? add(execPrice, feePer) : null; /* all-in cost per contract */

      /* market view */
      var marketP = price;
      var noVigP = null, overround = null;
      var opp = o.opposite_price_cents != null ? T.contractPrice(T.cents(o.opposite_price_cents, 'opposite price')).d : o.opposite_price != null ? T.contractPrice(o.opposite_price, 'opposite price').d : null;
      if (opp) { var tot = add(price, opp); overround = sub(tot, ONE); noVigP = div(price, tot, PSCALE); }

      /* the arithmetic */
      var be = cost; /* a $1-payout contract breaks even at its all-in cost */
      var grossEv = fair != null ? sub(fair, price) : null;
      var netEv = fair != null && cost != null ? sub(fair, cost) : null;
      var netRoi = netEv != null ? div(netEv, cost, 8) : null;
      var edge = fair != null && be != null ? sub(fair, be) : null;
      var feeHeadroom = fair != null ? sub(fair, execPrice) : null; /* the most fee per contract the price could absorb and break even */

      /* the highest tick price still clearing the playable floor and the edge bar, fees and slippage included */
      function bestPriceFor(minRoi) {
        if (fair == null) return null;
        var best = null;
        for (var px = tick; cmp(px, ONE) < 0; px = add(px, tick)) {
          var ep = add(px, slip);
          if (cmp(ep, ONE) >= 0) break;
          var fx = contractFee(venue, ep, contracts, o.role || 'taker', { market_maker_fees: o.market_maker_fees, category: o.category, override: o.fee_override });
          if (fx.per_contract == null) return null;
          var c = add(ep, fx.per_contract);
          var roi = div(sub(fair, c), c, 8);
          if (cmp(roi, D(minRoi)) >= 0) best = px; else if (best != null) break;
        }
        return best;
      }
      var maxEntry = bestPriceFor(th.ev_floor);
      var maxEdgeEntry = bestPriceFor(th.candidate_ev);
      var breakEvenEntry = bestPriceFor('0');

      /* uncertainty */
      var unc = { status: 'NOT_QUANTIFIED', note: src.kind === 'SHARP_NO_VIG' || src.kind === 'CONSENSUS_NO_VIG' ? 'A de-vigged market price carries no confidence interval; its error is largest on heavy favourites and long shots.' : 'The fair source supplied no interval.' };
      if (o.fair_interval && o.fair_interval.low != null && cost != null) {
        var lo = T.probability(o.fair_interval.low, 'fair interval low').d, hi = o.fair_interval.high != null ? T.probability(o.fair_interval.high, 'fair interval high').d : null;
        unc = { status: 'QUANTIFIED', low: S(lo), high: hi ? S(hi) : null, net_ev_at_low: S(roundTo(sub(lo, cost), 6)), net_ev_at_high: hi ? S(roundTo(sub(hi, cost), 6)) : null, positive_at_low: sgn(sub(lo, cost)) > 0 };
      }
      var fresh = freshness(o.quote_observed_at, now, o.ttl_min, 'the contract quote');
      var fairFresh = src.observed_at ? freshness(src.observed_at, now, o.fair_ttl_min || o.ttl_min, 'the fair reference') : { status: 'UNKNOWN', age_min: null, why: 'the fair reference carries no observation time' };

      var res = {
        ok: true, schema: VERSION, calc_version: CALC_VERSION, kind: 'CONTRACT',
        venue: { key: venue.key, label: venue.label, model: venue.model },
        side: side, contracts: contracts, stake_contracts: stakeContracts, role: o.role || 'taker',
        market_probability: S(marketP),
        no_vig_market_probability: noVigP ? S(noVigP) : null,
        market_overround: overround ? S(overround) : null,
        independent_fair_probability: fair != null && src.independent ? S(fair) : null,
        fair_probability: fair != null ? S(fair) : null,
        fair_source: src,
        fair_american_odds: fair != null && sgn(fair) > 0 && cmp(fair, ONE) < 0 ? wholeAmerican(probToAmerican(fair)) : null,
        fair_decimal_odds: fair != null && sgn(fair) > 0 ? fixed(probToDecimal(fair), 4) : null,
        entry_price: S(price),
        entry_price_cents: S(mul(price, HUNDRED)),
        execution_price: S(execPrice),
        break_even_probability: be != null ? S(roundTo(be, 6)) : null,
        gross_expected_value: grossEv != null ? S(grossEv) : null,
        net_expected_value: netEv != null ? S(roundTo(netEv, 6)) : null,
        net_ev_per_dollar: netRoi != null ? S(netRoi) : null,
        net_expected_profit: netEv != null ? S(roundTo(mul(netEv, D(String(contracts))), 4)) : null,
        probability_edge: edge != null ? S(roundTo(edge, 6)) : null,
        expected_fees: { status: fee.status, per_contract: feePer != null ? S(feePer) : null, total: fee.total != null ? S(fee.total) : null, formula: fee.formula, rounding: fee.rounding, basis: fee.basis },
        fee_headroom: feeHeadroom != null ? S(feeHeadroom) : null,
        estimated_slippage: { per_contract: S(slip), basis: slipBasis },
        maximum_entry_price: maxEntry ? S(maxEntry) : null,
        maximum_entry_price_cents: maxEntry ? S(mul(maxEntry, HUNDRED)) : null,
        maximum_edge_entry_price: maxEdgeEntry ? S(maxEdgeEntry) : null,
        break_even_entry_price: breakEvenEntry ? S(breakEvenEntry) : null,
        all_in_cost: cost ? S(cost) : null,
        model_uncertainty: unc,
        data_freshness: { quote: fresh, fair: fairFresh },
        market_liquidity: liquidity,
        calibration_status: src.calibration_status,
        settlement: o.settlement || { verified: false, terms: venue.settlement },
        thresholds: th
      };
      return classify(res, o);
    } catch (e) { return errResult(e, 'CONTRACT'); }
  }

  /**
   * One sportsbook wager at one price.
   * o.book, o.american | o.decimal, o.other_side_american (same market, same book, for the no-vig)
   * o.fair_probability (this side wins), o.push_probability, o.fair_source, o.fair_interval
   * o.stake_dollars, o.quote_observed_at, o.now, o.ttl_min
   * o.confirmation { books, families, pass }   independent quotes agreeing
   */
  function evaluateWager(o) {
    o = o || {};
    try {
      var venue = venueOf(o.book || 'sportsbook') || VENUES.sportsbook;
      if (venue.model !== 'SPORTSBOOK') throw unitError('WRONG_MODEL', venue.label + ' is not a sportsbook');
      var dec = o.decimal != null ? T.decimalOdds(o.decimal).d : americanToDecimal(o.american);
      var am = o.american != null ? T.american(o.american).d : decimalToAmerican(dec);
      var th = thresholds(o.thresholds);
      var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
      var fair = o.fair_probability != null ? T.probability(o.fair_probability, 'fair probability').d : null;
      var push = o.push_probability != null ? T.probability(o.push_probability, 'push probability').d : ZERO;
      if (fair != null && cmp(add(fair, push), ONE) > 0) throw unitError('PROBABILITY_SUM', 'win probability plus push probability exceeds 1');
      var src = fairSourceOf(o.fair_source);
      var lose = fair != null ? sub(sub(ONE, fair), push) : null;
      var marketP = div(ONE, dec, PSCALE);
      var noVigP = null, overround = null;
      if (o.other_side_american != null) { var nv = noVig([{ decimal: S(dec) }, { american: o.other_side_american }]); if (nv.ok) { noVigP = D(nv.probabilities[0]); overround = D(nv.overround); } }
      var be = div(sub(ONE, push), dec, PSCALE); /* pushes refunded */
      /* per $1 risked: p(D − 1) − (1 − p − push) */
      var ev = fair != null ? sub(mul(fair, sub(dec, ONE)), lose) : null;
      var edge = fair != null ? sub(fair, be) : null;
      /* worst price still clearing a floor: D ≥ (1 − push + floor) / p, rounded to the conservative whole American price */
      function minPrice(floor) {
        if (fair == null || isZero(fair)) return null;
        var dmin = div(add(sub(ONE, push), D(floor)), fair, PSCALE);
        if (cmp(dmin, ONE) <= 0) return null;
        var amMin = decimalToAmerican(dmin);
        var r = ceilTo(amMin, 0);
        if (sgn(r) < 0 && cmp(r, D('-100')) > 0) r = D('100');
        if (sgn(r) > 0 && cmp(r, HUNDRED) < 0) r = HUNDRED;
        return N(r);
      }
      var stake = o.stake_dollars != null ? T.dollars(o.stake_dollars, 'stake').d : null;
      var unc = { status: 'NOT_QUANTIFIED', note: src.kind === 'SHARP_NO_VIG' || src.kind === 'CONSENSUS_NO_VIG' ? 'A de-vigged market price carries no confidence interval; its error is largest on heavy favourites and long shots.' : 'The fair source supplied no interval.' };
      if (o.fair_interval && o.fair_interval.low != null) {
        var lo = T.probability(o.fair_interval.low).d, evLo = sub(mul(lo, sub(dec, ONE)), sub(sub(ONE, lo), push));
        unc = { status: 'QUANTIFIED', low: S(lo), high: o.fair_interval.high != null ? S(T.probability(o.fair_interval.high).d) : null, net_ev_at_low: S(roundTo(evLo, 6)), positive_at_low: sgn(evLo) > 0 };
      }
      var conf = o.confirmation || null;
      var res = {
        ok: true, schema: VERSION, calc_version: CALC_VERSION, kind: 'WAGER',
        venue: { key: venue.key, label: venue.label, model: venue.model },
        market_probability: S(marketP),
        no_vig_market_probability: noVigP ? S(noVigP) : null,
        market_overround: overround ? S(overround) : null,
        independent_fair_probability: fair != null && src.independent ? S(fair) : null,
        fair_probability: fair != null ? S(fair) : null,
        push_probability: S(push),
        fair_source: src,
        fair_american_odds: fair != null && sgn(fair) > 0 && cmp(fair, ONE) < 0 ? wholeAmerican(probToAmerican(div(fair, sub(ONE, push), PSCALE))) : null,
        fair_decimal_odds: fair != null && sgn(fair) > 0 ? fixed(div(sub(ONE, push), fair, PSCALE), 4) : null,
        entry_price: wholeAmerican(am), entry_decimal: fixed(dec, 4),
        execution_price: wholeAmerican(am),
        break_even_probability: S(roundTo(be, 6)),
        gross_expected_value: ev != null ? S(roundTo(ev, 6)) : null,
        net_expected_value: ev != null ? S(roundTo(ev, 6)) : null,
        net_ev_per_dollar: ev != null ? S(roundTo(ev, 8)) : null,
        net_expected_profit: ev != null && stake ? S(roundTo(mul(ev, stake), 4)) : null,
        probability_edge: edge != null ? S(roundTo(edge, 6)) : null,
        expected_fees: { status: 'VERIFIED', per_contract: '0', total: '0', formula: 'no explicit fee', rounding: 'NONE', basis: VENUES.sportsbook.fee.basis },
        estimated_slippage: { per_contract: '0', basis: 'a fixed-odds quote fills at the quoted price up to the book\'s limit' },
        maximum_entry_price: minPrice(th.ev_floor),
        maximum_edge_entry_price: minPrice(th.candidate_ev),
        break_even_entry_price: minPrice('0'),
        all_in_cost: S(roundTo(div(ONE, dec, PSCALE), 6)),
        model_uncertainty: unc,
        data_freshness: { quote: freshness(o.quote_observed_at, now, o.ttl_min, 'the sportsbook quote'), fair: src.observed_at ? freshness(src.observed_at, now, o.fair_ttl_min || o.ttl_min, 'the fair reference') : { status: 'UNKNOWN', age_min: null, why: 'the fair reference carries no observation time' } },
        market_liquidity: conf ? { status: conf.pass ? 'CONFIRMED' : 'SINGLE_SOURCE', books: conf.books != null ? conf.books : null, note: conf.why || null } : { status: 'UNKNOWN', books: null, note: 'No count of independent books quoting this price.' },
        calibration_status: src.calibration_status,
        settlement: o.settlement || { verified: true, terms: VENUES.sportsbook.settlement },
        thresholds: th
      };
      return classify(res, o);
    } catch (e) { return errResult(e, 'WAGER'); }
  }

  /* ================================================================ */
  /* 9. CLASSIFICATION — VERIFIED EDGE / POTENTIAL EDGE / WATCH / PASS  */
  /*                     / UNVERIFIED DATA, with every reason          */
  /* ================================================================ */
  var LABELS = { VERIFIED_EDGE: 'VERIFIED EDGE', POTENTIAL_EDGE: 'POTENTIAL EDGE', WATCH: 'WATCH', PASS: 'PASS', UNVERIFIED_DATA: 'UNVERIFIED DATA' };
  var DECISION = { VERIFIED_EDGE: 'BUY', POTENTIAL_EDGE: 'WATCH', WATCH: 'WATCH', PASS: 'PASS', UNVERIFIED_DATA: 'PASS' };
  function classify(r, o) {
    var why = [], caps = [];
    var th = r.thresholds;
    var roi = r.net_ev_per_dollar != null ? D(r.net_ev_per_dollar) : null;
    var cls;
    if (r.fair_probability == null) { cls = 'UNVERIFIED_DATA'; why.push('No fair probability is on file for this outcome, so its value cannot be evaluated; the price alone implies ' + pctStr(D(r.market_probability)) + '.'); }
    else if (r.data_freshness.quote.status === 'STALE' || r.data_freshness.quote.status === 'UNKNOWN') { cls = 'UNVERIFIED_DATA'; why.push('The quote is ' + r.data_freshness.quote.status.toLowerCase() + ' (' + r.data_freshness.quote.why + '); re-check the price before any verdict.'); }
    else if (roi == null && r.gross_expected_value != null && sgn(D(r.gross_expected_value)) <= 0) { cls = 'PASS'; why.push('Before any fee the price is already ' + (sgn(D(r.gross_expected_value)) < 0 ? 'worse than' : 'exactly at') + ' the fair probability (' + fixed(mul(D(r.gross_expected_value), HUNDRED), 2) + '¢ a contract); fees can only make it worse.'); }
    else if (roi == null) {
      cls = 'WATCH';
      why.push('The fee schedule for ' + r.venue.label + ' is ' + r.expected_fees.status.toLowerCase() + ', so net EV is not computed. Before fees the edge is ' + pctStr(D(r.gross_expected_value)) + ' of $1; the price can absorb up to ' + (r.fee_headroom != null ? fixed(mul(D(r.fee_headroom), HUNDRED), 2) + '¢' : 'no') + ' of fees and slippage per contract and still break even.');
    }
    else if (sgn(roi) <= 0) { cls = 'PASS'; why.push('Net expected value is ' + pctStr(roi) + ' per dollar after ' + (r.kind === 'CONTRACT' ? 'fees and slippage' : 'the margin in the price') + ': the price is worse than the fair probability supports.'); }
    else if (cmp(roi, D(th.ev_floor)) < 0) { cls = 'PASS'; why.push('Net expected value ' + pctStr(roi) + ' per dollar is positive but under the ' + pctStr(D(th.ev_floor)) + ' playable floor.'); }
    else if (cmp(roi, D(th.candidate_ev)) < 0) { cls = 'WATCH'; why.push('Net expected value ' + pctStr(roi) + ' per dollar clears the ' + pctStr(D(th.ev_floor)) + ' floor but not the ' + pctStr(D(th.candidate_ev)) + ' edge bar.'); }
    else { cls = 'VERIFIED_EDGE'; why.push('Net expected value ' + pctStr(roi) + ' per dollar clears the ' + pctStr(D(th.candidate_ev)) + ' edge bar.'); }

    /* caps — each one can only lower the class; every one that fires is named,
       `binding` when it is the one that actually lowered the verdict */
    function cap(to, reason) { var order = ['UNVERIFIED_DATA', 'PASS', 'WATCH', 'POTENTIAL_EDGE', 'VERIFIED_EDGE']; var lowers = order.indexOf(cls) > order.indexOf(to); caps.push({ to: to, reason: reason, binding: lowers }); if (lowers) cls = to; }
    if (cls === 'VERIFIED_EDGE' || cls === 'POTENTIAL_EDGE' || cls === 'WATCH') {
      if (!r.fair_source.may_price) cap('WATCH', 'the fair probability comes from ' + (r.fair_source.kind === 'MODEL' ? 'a ' + (r.fair_source.tier || 'unvalidated') + '-tier model' : 'an unpriced source (' + (r.fair_source.kind || 'none') + ')') + ', which may order research but may not be called an edge');
      if (roi != null && cmp(roi, D(th.sane_ev)) > 0) cap('WATCH', 'net EV ' + pctStr(roi) + ' is past the ' + pctStr(D(th.sane_ev)) + ' sanity ceiling: an outlier is a data check (line, side, settlement) before it is a bet');
      if (r.expected_fees.status === 'UNVERIFIED' || r.expected_fees.status === 'OVERRIDE') cap('POTENTIAL_EDGE', 'the ' + r.venue.label + ' fee schedule used is ' + r.expected_fees.status.toLowerCase() + ' (' + r.expected_fees.basis + ')');
      if (r.data_freshness.quote.status === 'AGING') cap('POTENTIAL_EDGE', 'the quote is aging (' + r.data_freshness.quote.why + ')');
      if (r.data_freshness.fair.status === 'STALE' || r.data_freshness.fair.status === 'UNKNOWN') cap('POTENTIAL_EDGE', 'the fair reference is ' + r.data_freshness.fair.status.toLowerCase() + ' (' + r.data_freshness.fair.why + ')');
      if (r.kind === 'CONTRACT' && r.market_liquidity.status === 'INSUFFICIENT') cap('WATCH', r.market_liquidity.note);
      if (r.kind === 'CONTRACT' && r.market_liquidity.status === 'UNKNOWN') cap('POTENTIAL_EDGE', 'no order-book depth on file for the contract');
      if (r.kind === 'WAGER' && r.market_liquidity.status === 'SINGLE_SOURCE') cap('POTENTIAL_EDGE', 'the price stands on one book; no independent quote confirms it');
      if (r.model_uncertainty.status === 'QUANTIFIED' && r.model_uncertainty.positive_at_low === false) cap('POTENTIAL_EDGE', 'at the low end of the fair interval (' + r.model_uncertainty.low + ') the expected value is negative');
      if (!r.settlement || r.settlement.verified !== true) cap('POTENTIAL_EDGE', 'settlement terms are not verified against the fair reference\'s market' + (r.settlement && r.settlement.mismatch ? ': ' + r.settlement.mismatch : ''));
      if (r.settlement && r.settlement.mismatch_severity === 'MATERIAL') cap('WATCH', 'settlement differs materially from the fair reference: ' + r.settlement.mismatch);
      var audit = o && o.audit;
      if (!audit) cap('POTENTIAL_EDGE', 'the adversarial audit has not run on this price');
      else if (audit.status === 'REJECTED') cap('PASS', 'the audit rejected it: ' + (audit.reason || 'see the audit trail'));
      else if (audit.status !== 'CONFIRMED') cap('POTENTIAL_EDGE', 'the audit did not confirm it (' + audit.status + ')');
    }
    r.classification = cls;
    r.label = LABELS[cls];
    r.decision = DECISION[cls];
    r.reasons = why;
    r.caps = caps;
    /* research confidence: a category from named conditions, never a score */
    var fails = caps.length + (r.data_freshness.quote.status === 'LIVE' ? 0 : 1) + (r.fair_source.may_price ? 0 : 1) + (r.expected_fees.status === 'VERIFIED' ? 0 : 1);
    r.research_confidence = { level: cls === 'UNVERIFIED_DATA' ? 'INSUFFICIENT' : fails === 0 ? 'HIGH' : fails <= 2 ? 'MEDIUM' : 'LOW', basis: 'named conditions, not a fitted score: quote ' + r.data_freshness.quote.status + ', fair source ' + (r.fair_source.kind || 'none') + (r.fair_source.tier ? ' (' + r.fair_source.tier + ')' : '') + ', fees ' + r.expected_fees.status + ', ' + caps.length + ' cap' + (caps.length === 1 ? '' : 's') + ' applied' };
    return r;
  }

  /* ================================================================ */
  /* 10. CROSS-VENUE COMPARISON — the same outcome, every price         */
  /* ================================================================ */
  /**
   * The cheapest way to own $1 of one outcome. Each entry is either a
   * contract ({venue, side, price_cents|price, ...}) or a wager ({book,
   * american|decimal}); each is evaluated against the SAME fair probability.
   * Ranked by all-in cost per $1 of payout (lower is better) and, when a fair
   * is on file, by net EV per dollar. An entry whose settlement does not
   * match the reference market is ranked but flagged.
   */
  function compareVenues(entries, common) {
    common = common || {};
    var rows = (entries || []).map(function (e) {
      var o = Object.assign({}, common, e);
      var r = (e.venue && venueOf(e.venue) && venueOf(e.venue).model === 'BINARY_CONTRACT') ? evaluateContract(o) : evaluateWager(o);
      return { input: { venue: e.venue || e.book, side: e.side || null, price_cents: e.price_cents != null ? String(e.price_cents) : null, american: e.american != null ? String(e.american) : null }, result: r };
    });
    var ok = rows.filter(function (x) { return x.result.ok && x.result.all_in_cost != null; });
    ok.sort(function (a, b) { return cmp(D(a.result.all_in_cost), D(b.result.all_in_cost)); });
    var bad = rows.filter(function (x) { return !(x.result.ok && x.result.all_in_cost != null); });
    var best = ok[0] || null;
    return {
      schema: VERSION + ':compare', ranked: ok.map(function (x, i) { return { rank: i + 1, venue: x.result.venue.label, side: x.result.side || null, entry: x.result.kind === 'CONTRACT' ? x.result.entry_price_cents + '¢' : (x.result.entry_price > 0 ? '+' : '') + x.result.entry_price, all_in_cost: x.result.all_in_cost, all_in_cost_cents: fixed(mul(D(x.result.all_in_cost), HUNDRED), 2), net_ev_per_dollar: x.result.net_ev_per_dollar, label: x.result.label, fees: x.result.expected_fees.status, settlement_verified: !!(x.result.settlement && x.result.settlement.verified), result: x.result }; }),
      not_priced: bad.map(function (x) { return { venue: x.input.venue, why: x.result.error ? x.result.error.message : 'fee schedule unknown: all-in cost not computable' }; }),
      best: best ? best.result.venue.label : null,
      note: 'All-in cost is what it takes to receive $1 if the outcome wins: price plus fees and slippage for a contract, 1 ÷ decimal odds for a wager. The same outcome must settle the same way at both venues before the cheaper price is the better trade.'
    };
  }

  /** A sportsbook price as the contract price that costs the same per $1 of payout. -150 → 60¢. */
  function equivalentCents(american) { return fixed(mul(div(ONE, americanToDecimal(american), PSCALE), HUNDRED), 2); }
  /** A contract price as the American odds that pay the same, before fees. 61¢ → -156. */
  function contractToAmerican(priceCents) { var p = T.contractPrice(T.cents(priceCents)).d; return wholeAmerican(probToAmerican(p)); }

  /* ================================================================ */
  /* 11. PARSING A PRICE FROM A QUESTION                               */
  /* ================================================================ */
  /**
   * "Rays at 61¢", "Cleveland +1.5 at 61 cents", "YES at $0.61", "61c",
   * "Guardians -150", "at +135 on DraftKings", "Kalshi". Returns what was
   * said, typed, and never fills in what was not. The team or selection is
   * left to the host's entity resolver.
   */
  var VENUE_WORDS = [['kalshi', /\bkalshi\b/i], ['polymarket', /\bpoly ?market\b/i]];
  function parsePrice(text) {
    var q = String(text || '');
    var out = { venue: null, contract: null, american: null, side: null, said: [] };
    VENUE_WORDS.forEach(function (v) { if (!out.venue && v[1].test(q)) out.venue = v[0]; });
    var m = q.match(/(\d{1,2}(?:\.\d+)?)\s*(?:¢|c\b|cents?\b)/i);
    var m2 = q.match(/\$\s?0?\.(\d{1,2})\b/);
    if (m) { try { out.contract = { price_cents: S(T.cents(m[1]).d), raw: m[0] }; out.said.push('contract price ' + m[1] + '¢'); } catch (e) { out.contract = { error: e.message, raw: m[0] }; } }
    else if (m2) { var c = m2[1].length === 1 ? m2[1] + '0' : m2[1]; try { out.contract = { price_cents: S(T.cents(c).d), raw: m2[0] }; out.said.push('contract price ' + c + '¢'); } catch (e2) { out.contract = { error: e2.message, raw: m2[0] }; } }
    /* American odds: a signed 3-4 digit number not part of a spread like +1.5, and not a year */
    var am = q.match(/(?:^|[\s(@])([+-]\d{3,4})(?![\d.])/);
    if (am) { try { out.american = N(T.american(am[1]).d); out.said.push('American odds ' + am[1]); } catch (e3) { /* not a price */ } }
    var sd = q.match(/\b(yes|no)\b\s*(?:at|@|for|contract)/i) || q.match(/\bbuy(?:ing)?\s+(yes|no)\b/i);
    if (sd) out.side = sd[1].toUpperCase();
    if (out.contract && !out.venue) out.venue_note = 'a contract price was quoted without a venue; Kalshi\'s fee model is used only if the reader names Kalshi';
    return out;
  }

  /* ================================================================ */
  /* 12. PLAIN-LANGUAGE ANSWER                                         */
  /* ================================================================ */
  function fmtProb(s) { return s == null ? '—' : pctStr(D(s), 1); }
  function fmtCents(s) { return s == null ? '—' : fixed(mul(D(s), HUNDRED), 2).replace(/\.00$/, '') + '¢'; }
  function fmtUsd(s) { if (s == null) return '—'; var d = D(s); return (sgn(d) < 0 ? '−$' : '$') + fixed(sgn(d) < 0 ? neg(d) : d, 4).replace(/(\.\d\d)00$/, '$1'); }
  function fmtAm(n) { return n == null ? '—' : (n > 0 ? '+' : '') + n; }
  /** The answer in the shape the brief asks for: the verdict first, then the numbers, then why. */
  function explain(r, ctx) {
    ctx = ctx || {};
    if (!r || !r.ok) return { headline: 'EdgeDesk could not price that: ' + (r && r.error ? r.error.message : 'no result') + '.', lines: [], decision: 'PASS' };
    var isC = r.kind === 'CONTRACT';
    var what = (ctx.selection || (isC ? r.side : 'this side')) + (isC ? ' at ' + fmtCents(r.entry_price) + ' on ' + r.venue.label : ' at ' + fmtAm(r.entry_price) + (r.venue.label && r.venue.label !== 'Sportsbook' ? ' (' + r.venue.label + ')' : ''));
    var lines = [];
    lines.push(['Available price', isC ? fmtCents(r.entry_price) + ' (implies ' + fmtProb(r.market_probability) + ')' : fmtAm(r.entry_price) + ' (implies ' + fmtProb(r.market_probability) + ')']);
    if (r.no_vig_market_probability) lines.push(['Market no-vig', fmtProb(r.no_vig_market_probability) + ' (margin ' + pctStr(D(r.market_overround)) + ')']);
    lines.push(['Fair probability', r.fair_probability ? fmtProb(r.fair_probability) + ' — ' + (r.fair_source.label || r.fair_source.kind) + (r.fair_source.independent ? '' : ' (market-derived, not an independent model)') : 'unavailable']);
    if (r.fair_probability) lines.push(['Fair price', isC ? fmtCents(r.fair_probability) + ' (' + fmtAm(r.fair_american_odds) + ')' : fmtAm(r.fair_american_odds) + ' (' + r.fair_decimal_odds + ')']);
    if (isC) lines.push(['Fees', r.expected_fees.per_contract != null ? fmtCents(r.expected_fees.per_contract) + ' per contract (' + r.expected_fees.status.toLowerCase() + ': ' + r.expected_fees.formula + ')' : 'unknown — ' + r.expected_fees.basis]);
    if (isC && r.estimated_slippage && D(r.estimated_slippage.per_contract) && sgn(D(r.estimated_slippage.per_contract)) > 0) lines.push(['Slippage', fmtCents(r.estimated_slippage.per_contract) + ' per contract']);
    lines.push(['Break-even', r.break_even_probability ? fmtProb(r.break_even_probability) : 'above ' + fmtProb(r.entry_price) + ' (the price) plus a fee EdgeDesk cannot apply']);
    lines.push(['Net EV', r.net_ev_per_dollar != null ? pctStr(D(r.net_ev_per_dollar)) + ' per $1' + (isC ? ' (' + fmtCents(r.net_expected_value) + ' per contract)' : '') : 'not computed (fees unknown); gross ' + (r.gross_expected_value ? fmtCents(r.gross_expected_value) : '—') + ' per contract']);
    lines.push(['Maximum entry', r.maximum_entry_price != null ? (isC ? fmtCents(r.maximum_entry_price) : fmtAm(r.maximum_entry_price)) + ' (still clears the ' + pctStr(D(r.thresholds.ev_floor)) + ' floor' + (isC ? ' after fees' : '') + ')' : 'none — no price clears the floor' + (r.fair_probability ? '' : ' without a fair probability')]);
    lines.push(['Calibration', r.calibration_status]);
    lines.push(['Decision', r.decision === r.label ? r.decision : r.decision + ' · ' + r.label]);
    var binding = r.caps.filter(function (c) { return c.binding; });
    var head = r.label + ': ' + what + '. ' + r.reasons[0] + (binding.length ? ' Capped because ' + binding.map(function (c) { return c.reason; }).join('; ') + '.' : '');
    return { headline: head, lines: lines, decision: r.decision, label: r.label };
  }

  return {
    VERSION: VERSION, CALC_VERSION: CALC_VERSION, VENUES: VENUES, DEFAULTS: DEFAULTS, LABELS: LABELS, FAIR_KINDS: FAIR_KINDS,
    T: T, D: D, S: S, N: N, fixed: fixed, dec: { add: add, sub: sub, mul: mul, div: div, cmp: cmp, ceilTo: ceilTo, floorTo: floorTo, roundTo: roundTo },
    americanToDecimal: function (a) { return S(americanToDecimal(a)); },
    decimalToAmerican: function (d) { return S(decimalToAmerican(d)); },
    probToAmerican: function (p) { var v = probToAmerican(p); return v == null ? null : S(v); },
    probToDecimal: function (p) { var v = probToDecimal(p); return v == null ? null : S(v); },
    impliedFromAmerican: function (a) { return S(div(ONE, americanToDecimal(a), PSCALE)); },
    impliedFromDecimal: function (d) { return S(impliedFromDecimal(d)); },
    wholeAmerican: function (d) { return wholeAmerican(D(d)); },
    noVig: noVig, venueOf: venueOf, contractFee: function (venueKey, priceDollars, contracts, role, o) { var v = venueOf(venueKey); if (!v) return null; var f = contractFee(v, T.contractPrice(priceDollars).d, contracts, role, o); return { status: f.status, total: f.total == null ? null : S(f.total), per_contract: f.per_contract == null ? null : S(f.per_contract), formula: f.formula, rounding: f.rounding, basis: f.basis }; },
    thresholds: thresholds, fairSourceOf: fairSourceOf, freshness: freshness, walkBook: function (asks, c) { var w = walkBook(asks, c); return w && { vwap: S(w.vwap), filled: w.filled, short: w.short }; },
    evaluateContract: evaluateContract, evaluateWager: evaluateWager, classify: classify,
    compareVenues: compareVenues, equivalentCents: equivalentCents, contractToAmerican: contractToAmerican,
    parsePrice: parsePrice, explain: explain
  };
});
/*__EDFAIR_END__*/
